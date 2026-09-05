#!/usr/bin/env node
import { createServer as createHttpServer } from 'node:http'
import { writeFileSync } from 'node:fs'
import { WebSocketServer } from 'ws'
import { addLeaderboardRun, leaderboardSnapshot } from './lib/leaderboard.mjs'
import {
  apply,
  chooseAscension,
  chooseCharacter,
  chooseLastStandRule,
  chooseRunMeta,
  chooseRelicRule,
  createRoom,
  createStore,
  findSeat,
  joinRoom,
  markDisconnected,
  removeSeat,
  saveStore,
  snapshotFor,
  startRun,
} from './lib/rooms.mjs'

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
}
const MAX_BODY = 64 * 1024
const MULTIPLAYER_PROTOCOL_VERSION = 1
const MAX_ROOMS = 100
const ROOM_TTL_MS = 6 * 60 * 60 * 1000
const RESUMABLE_ROOM_TTL_MS = 30 * 24 * 60 * 60 * 1000
const HEARTBEAT_MS = 30_000
const MAX_BUFFERED_BYTES = 256 * 1024
const MESSAGE_WINDOW_MS = 10_000
const MAX_MESSAGES_PER_WINDOW = 60
const MAX_VOICE_MESSAGES_PER_WINDOW = 180
const CREATE_WINDOW_MS = 60_000
const MAX_CREATES_PER_WINDOW = 10
const MAX_JOINS_PER_WINDOW = 30
const MAX_LEADERBOARD_WRITES_PER_WINDOW = 6
const MAX_UPGRADES_PER_WINDOW = 30
const MAX_RATE_KEYS = 1024
const MAX_ROOMS_PER_IP = 10
const MAX_PENDING_AUTH = 32
const MAX_PENDING_AUTH_PER_IP = 4
const STORE_SAVE_DELAY_MS = 1_000
const CATCH_UP_RESERVATION_MS = 30_000
const DEFAULT_ICE_SERVERS = [{ urls: 'stun:stun.cloudflare.com:3478' }]

function send(response, status, body) {
  response.writeHead(status, JSON_HEADERS)
  response.end(JSON.stringify(body))
}

async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY) throw Object.assign(new Error('Request body is too large'), { status: 413 })
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error('JSON body must be an object')
    return body
  } catch {
    throw Object.assign(new Error('JSON body must be an object'), { status: 400 })
  }
}

const tokenOf = (request) => request.headers['x-room-token']?.toString()
const codeOf = (value) => value.trim().toUpperCase()
const sourceOf = (request) => request.headers['cf-connecting-ip']?.toString()
  ?? request.socket.remoteAddress
  ?? 'unknown'

export function createRoomServer({
  turnKeyId = process.env.CLOUDFLARE_TURN_KEY_ID,
  turnApiToken = process.env.CLOUDFLARE_TURN_API_TOKEN,
  fetchImpl = fetch,
  storeFile,
  maxUpgradesPerWindow = MAX_UPGRADES_PER_WINDOW,
  saveDelayMs = STORE_SAVE_DELAY_MS,
  saveStoreImpl = saveStore,
  onSaveError = (error) => console.error('Room store save failed:', error),
  allowedOrigin = process.env.STS_ALLOWED_ORIGIN,
  handoffRestore = process.env.STS_HANDOFF_RESTORE === 'true',
  handoffReconnectMs = Math.max(5 * 60_000, Number(process.env.STS_HANDOFF_RECONNECT_MS) || 0),
} = {}) {
  const store = createStore({ file: storeFile, handoffRestore, handoffReconnectMs })
  const sockets = new Map()
  const roomActivity = new Map()
  const roomOwners = new Map()
  const createRates = new Map()
  const joinRates = new Map()
  const leaderboardRates = new Map()
  const upgradeRates = new Map()
  const seatRates = new Map()
  const voiceRates = new Map()
  const pendingAuth = new Map()
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY })
  let saveTimer
  let preserveRoomsOnClose = false
  let saveError = null
  const minimumRetryMs = Math.max(saveDelayMs, 100)
  let retryDelayMs = minimumRetryMs
  const attemptSave = () => {
    try {
      saveStoreImpl(store)
      saveError = null
      retryDelayMs = minimumRetryMs
      return true
    } catch (error) {
      saveError = error instanceof Error ? error : new Error(String(error))
      try { onSaveError(saveError) } catch {}
      return false
    }
  }
  const queueSave = (delayMs = saveDelayMs) => {
    if (!store.file || saveTimer) return
    saveTimer = setTimeout(() => {
      saveTimer = undefined
      if (!attemptSave()) {
        const delay = retryDelayMs
        retryDelayMs = Math.min(retryDelayMs * 2, 30_000)
        queueSave(delay)
      }
    }, delayMs)
    saveTimer.unref()
  }
  const flushSave = () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = undefined
    if (!attemptSave()) throw saveError
  }

  for (const [code, room] of store.rooms) roomActivity.set(code, room.lastActivityAt ?? Date.now())

  const touch = (room) => {
    room.lastActivityAt = Date.now()
    roomActivity.set(room.code, room.lastActivityAt)
  }

  const reconnectingHandoff = (room) => store.reconnectQuorums.has(room.code)
  const finishHandoffReconnect = (room, seat) => {
    const quorum = store.reconnectQuorums.get(room.code)
    if (!quorum) return
    quorum.playerIds.delete(seat.playerId)
    if (quorum.playerIds.size === 0) store.reconnectQuorums.delete(room.code)
  }

  function consume(map, key, windowMs, maximum, now = Date.now()) {
    const rate = map.get(key)
    if (!rate || now - rate.startedAt >= windowMs) {
      if (!rate && map.size >= MAX_RATE_KEYS) return false
      map.set(key, { startedAt: now, count: 1 })
      return true
    }
    rate.count += 1
    return rate.count <= maximum
  }

  const mayAct = (room, token) => consume(
    seatRates, `${room.code}:${token}`, MESSAGE_WINDOW_MS, MAX_MESSAGES_PER_WINDOW,
  )
  const maySignalVoice = (room, token) => consume(
    voiceRates, `${room.code}:${token}`, MESSAGE_WINDOW_MS, MAX_VOICE_MESSAGES_PER_WINDOW,
  )

  function sweepRooms(now = Date.now()) {
    for (const [key, rate] of createRates) if (now - rate.startedAt >= CREATE_WINDOW_MS) createRates.delete(key)
    for (const [key, rate] of joinRates) if (now - rate.startedAt >= CREATE_WINDOW_MS) joinRates.delete(key)
    for (const [key, rate] of leaderboardRates) if (now - rate.startedAt >= CREATE_WINDOW_MS) leaderboardRates.delete(key)
    for (const [key, rate] of upgradeRates) if (now - rate.startedAt >= CREATE_WINDOW_MS) upgradeRates.delete(key)
    for (const [key, rate] of seatRates) if (now - rate.startedAt >= MESSAGE_WINDOW_MS) seatRates.delete(key)
    for (const [key, rate] of voiceRates) if (now - rate.startedAt >= MESSAGE_WINDOW_MS) voiceRates.delete(key)
    for (const [code, quorum] of store.reconnectQuorums) {
      if (now < quorum.expiresAt) continue
      const room = store.rooms.get(code)
      store.reconnectQuorums.delete(code)
      if (!room) continue
      for (const playerId of quorum.playerIds) {
        const seat = room.seats.find((candidate) => candidate.playerId === playerId)
        if (seat) markDisconnected(room, seat.token)
      }
      touch(room)
      queueSave()
      publish(room)
    }
    for (const [code, touchedAt] of roomActivity) {
      const room = store.rooms.get(code)
      if (room) {
        const seats = room.seats.filter((seat) => !seat.pendingCatchUp || now - (seat.reservedAt ?? now) < CATCH_UP_RESERVATION_MS)
        if (seats.length !== room.seats.length) {
          room.seats = seats
          room.version += 1
          queueSave()
          publish(room)
        }
      }
      const ttl = room?.run || room?.campaignProgress?.finishedRunIds?.length > 0 ? RESUMABLE_ROOM_TTL_MS : ROOM_TTL_MS
      if (now - touchedAt >= ttl) {
        for (const [socket, client] of sockets) if (client.code === code) socket.close(4004, 'Room expired')
        store.rooms.delete(code)
        store.reconnectQuorums.delete(code)
        roomActivity.delete(code)
        roomOwners.delete(code)
        queueSave()
      }
    }
  }

  function roomOrThrow(code) {
    const room = store.rooms.get(codeOf(code))
    if (!room) throw Object.assign(new Error('Room not found'), { status: 404 })
    return room
  }

  function publish(room, skipToken) {
    for (const [socket, client] of sockets) {
      if (client.code !== room.code || socket.readyState !== 1) continue
      if (skipToken !== undefined && client.token === skipToken) continue
      if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
        socket.terminate()
        continue
      }
      socket.send(JSON.stringify({ type: 'snapshot', snapshot: snapshotFor(room, client.token) }))
    }
  }

  async function voiceIceServers() {
    if (!turnKeyId || !turnApiToken) return DEFAULT_ICE_SERVERS
    try {
      const upstream = await fetchImpl(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(turnKeyId)}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${turnApiToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ ttl: ROOM_TTL_MS / 1000 }),
          signal: AbortSignal.timeout(10_000),
        },
      )
      if (!upstream.ok) throw new Error('TURN request failed')
      const body = await upstream.json()
      if (!Array.isArray(body.iceServers)) throw new Error('Invalid TURN response')
      return body.iceServers
    } catch {
      throw Object.assign(new Error('Could not create TURN credentials'), { status: 502 })
    }
  }

  // A refused action can still have changed the room — endTurn resolves an
  // abandoned card preview before failing, resolveEndTurn republishes a stale
  // ability list — so both transports reconcile what the throw left behind.
  // Reporting the refusal matters more, so this never throws on its own.
  // Callers pass the refused seat's token when that client learns of the refusal
  // out of band (the HTTP 4xx): a snapshot frame would clear the error banner
  // holding the recovery copy, and that client refetches for itself anyway.
  const reconcileRefusal = (room, version, actorToken) => {
    if (!room || room.version === version) return
    try {
      touch(room)
      queueSave()
      publish(room, actorToken)
    } catch {}
  }

  const server = createHttpServer(async (request, response) => {
    let acted = null
    try {
      if (allowedOrigin && request.headers.origin === allowedOrigin) {
        response.setHeader('access-control-allow-origin', allowedOrigin)
        response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
        response.setHeader('access-control-allow-headers', 'content-type, x-room-token')
        response.setHeader('access-control-max-age', '600')
        response.setHeader('vary', 'Origin')
      }
      if (request.method === 'OPTIONS') {
        response.writeHead(allowedOrigin && request.headers.origin === allowedOrigin ? 204 : 403)
        return response.end()
      }
      if (allowedOrigin && request.headers.origin && request.headers.origin !== allowedOrigin) {
        return send(response, 403, { error: 'Origin not allowed' })
      }
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (request.method === 'GET' && url.pathname === '/api/health') {
        return send(response, 200, { ok: true, rooms: store.rooms.size, protocolVersion: MULTIPLAYER_PROTOCOL_VERSION })
      }
      if (request.method === 'GET' && url.pathname === '/api/leaderboard') {
        return send(response, 200, leaderboardSnapshot(store.leaderboardRuns))
      }
      if (request.method === 'POST' && url.pathname === '/api/leaderboard') {
        const source = sourceOf(request)
        if (!consume(leaderboardRates, source, CREATE_WINDOW_MS, MAX_LEADERBOARD_WRITES_PER_WINDOW)) {
          return send(response, 429, { error: 'Too many leaderboard submissions' })
        }
        const added = addLeaderboardRun(store, await readJson(request))
        if (added) queueSave()
        return send(response, added ? 201 : 200, { ok: true, added })
      }
      if (request.method === 'POST' && url.pathname === '/api/rooms') {
        sweepRooms()
        const source = sourceOf(request)
        if (!consume(createRates, source, CREATE_WINDOW_MS, MAX_CREATES_PER_WINDOW)) {
          return send(response, 429, { error: 'Too many rooms created' })
        }
        const body = await readJson(request)
        if (store.rooms.size >= MAX_ROOMS) return send(response, 503, { error: 'Room capacity reached' })
        if ([...roomOwners.values()].filter((owner) => owner === source).length >= MAX_ROOMS_PER_IP) {
          return send(response, 429, { error: 'Too many active rooms' })
        }
        const room = createRoom(store)
        roomOwners.set(room.code, source)
        try {
          const seat = joinRoom(room, { name: body.name, character: body.character, connected: false })
          touch(room)
          queueSave()
          return send(response, 201, { token: seat.token, snapshot: snapshotFor(room, seat.token) })
        } catch (error) {
          store.rooms.delete(room.code)
          store.reconnectQuorums.delete(room.code)
          roomActivity.delete(room.code)
          roomOwners.delete(room.code)
          throw error
        }
      }
      const match = url.pathname.match(/^\/api\/rooms\/([^/]+)(?:\/(join|leave|character|ascension|relic-rule|last-stand-rule|run-meta|start|action|voice-ice))?$/)
      if (!match) return send(response, 404, { error: 'Not found' })
      const room = roomOrThrow(match[1])
      const operation = match[2]
      if (request.method === 'GET' && !operation) {
        const token = tokenOf(request)
        const seat = findSeat(room, token)
        if (!seat) return send(response, 401, { error: 'Unknown seat' })
        if (!mayAct(room, token)) return send(response, 429, { error: 'Rate limit exceeded' })
        return send(response, 200, snapshotFor(room, token))
      }
      if (request.method === 'GET' && operation === 'voice-ice') {
        const token = tokenOf(request)
        if (!findSeat(room, token)) return send(response, 401, { error: 'Unknown seat' })
        if (!mayAct(room, token)) return send(response, 429, { error: 'Rate limit exceeded' })
        return send(response, 200, { iceServers: await voiceIceServers() })
      }
      if (request.method !== 'POST') return send(response, 405, { error: 'Method not allowed' })
      if (operation === 'join') {
        if (!consume(joinRates, sourceOf(request), CREATE_WINDOW_MS, MAX_JOINS_PER_WINDOW)) {
          return send(response, 429, { error: 'Too many join attempts' })
        }
        const body = await readJson(request)
        if (store.rooms.get(room.code) !== room) return send(response, 404, { error: 'Room not found' })
        const token = body.token ?? tokenOf(request)
        if (reconnectingHandoff(room) && !findSeat(room, token)) {
          return send(response, 409, { error: 'Waiting for every player to reconnect' })
        }
        const live = [...sockets.values()].some((client) => client.code === room.code && client.token === token)
        if (findSeat(room, token) && !mayAct(room, token)) {
          return send(response, 429, { error: 'Rate limit exceeded' })
        }
        const beforeVersion = room.version
        const seat = joinRoom(room, {
          name: body.name, character: body.character, token, connected: live, settle: !reconnectingHandoff(room),
        })
        if (live) finishHandoffReconnect(room, seat)
        touch(room)
        if (room.version !== beforeVersion) {
          queueSave()
          publish(room)
        }
        return send(response, 200, { token: seat.token, snapshot: snapshotFor(room, seat.token) })
      }
      const token = tokenOf(request)
      if (!findSeat(room, token)) {
        if (operation === 'leave') return send(response, 200, { ok: true })
        return send(response, 401, { error: 'Unknown seat' })
      }
      if (!mayAct(room, token)) return send(response, 429, { error: 'Rate limit exceeded' })
      if (reconnectingHandoff(room)) return send(response, 409, { error: 'Waiting for every player to reconnect' })
      const body = await readJson(request)
      if (store.rooms.get(room.code) !== room) return send(response, 404, { error: 'Room not found' })
      let changed = true
      let snapshot = null
      acted = { room, version: room.version, token }
      if (operation === 'character') snapshot = chooseCharacter(room, token, body.character)
      else if (operation === 'relic-rule') snapshot = chooseRelicRule(room, token, body.enabled)
      else if (operation === 'last-stand-rule') snapshot = chooseLastStandRule(room, token, body.enabled)
      else if (operation === 'run-meta') snapshot = chooseRunMeta(room, token, body)
      else if (operation === 'ascension') {
        if (!Number.isInteger(body.ascension) || body.ascension < 0 || body.ascension > 13) {
          return send(response, 400, { error: 'Ascension must be an integer from 0 to 13' })
        }
        snapshot = chooseAscension(room, token, body.ascension)
      }
      else if (operation === 'leave') {
        removeSeat(room, token)
        for (const [socket, client] of sockets) {
          if (client.code === room.code && client.token === token) {
            sockets.delete(socket)
            socket.close(1000, 'Left room')
          }
        }
        touch(room)
        publish(room)
        if (room.seats.length === 0) {
          store.rooms.delete(room.code)
          store.reconnectQuorums.delete(room.code)
          roomActivity.delete(room.code)
          roomOwners.delete(room.code)
        }
        queueSave()
        return send(response, 200, { ok: true })
      }
      else if (operation === 'start') {
        if (room.seats.some((seat) => !seat.connected)) {
          return send(response, 409, { error: 'Every seat must be connected before starting' })
        }
        snapshot = startRun(room, token)
      }
      else if (operation === 'action') {
        const result = apply(room, token, body.action)
        changed = result.changed
        snapshot = result.snapshot
      }
      if (!snapshot) return send(response, 404, { error: 'Not found' })
      if (changed) {
        touch(room)
        queueSave()
        publish(room)
      }
      // Accepted: whatever happens while answering is not a refusal to reconcile.
      acted = null
      return send(response, 200, snapshot)
    } catch (error) {
      send(response, error.status ?? (error.name === 'RoomError' ? 409 : 500), {
        error: error instanceof Error ? error.message : 'Server error',
      })
      // Answered first: a room this far gone must not also cost the caller its
      // response, and this handler has no outer catch.
      if (acted) reconcileRefusal(acted.room, acted.version, acted.token)
    }
  })

  server.on('upgrade', (request, socket, head) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (url.pathname !== '/ws') throw new Error('Not found')
      if (allowedOrigin && request.headers.origin && request.headers.origin !== allowedOrigin) throw new Error('Origin not allowed')
      const source = sourceOf(request)
      const tooManyPending = pendingAuth.size >= MAX_PENDING_AUTH
        || [...pendingAuth.values()].filter((pendingSource) => pendingSource === source).length >= MAX_PENDING_AUTH_PER_IP
      if (tooManyPending || !consume(upgradeRates, source, CREATE_WINDOW_MS, maxUpgradesPerWindow)) {
        socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n')
        return socket.destroy()
      }
      const room = roomOrThrow(url.searchParams.get('room') ?? '')
      wss.handleUpgrade(request, socket, head, (webSocket) => {
        wss.emit('connection', webSocket, { code: room.code, source })
      })
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
    }
  })

  wss.on('connection', (socket, context) => {
    pendingAuth.set(socket, context.source)
    socket.isAlive = true
    socket.on('pong', () => { socket.isAlive = true })
    const authTimer = setTimeout(() => {
      if (!sockets.has(socket)) socket.close(4003, 'Authentication required')
    }, 5000)
    authTimer.unref?.()
    socket.on('message', (raw) => {
      try {
        let client = sockets.get(socket)
        let room
        let message
        try {
          message = JSON.parse(raw.toString())
          if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid message')
        } catch {
          return socket.close(4002, 'Invalid message')
        }
        if (client) {
          room = roomOrThrow(client.code)
          const allowed = message.type === 'voice'
            ? maySignalVoice(room, client.token)
            : mayAct(room, client.token)
          if (!allowed) return socket.close(4008, 'Rate limit exceeded')
        }
        if (!client) {
          if (message.type !== 'authenticate' || typeof message.token !== 'string') {
            return socket.close(4003, 'Authentication required')
          }
          room = roomOrThrow(context.code)
          let seat = findSeat(room, message.token)
          if (!seat) return socket.close(4003, 'Unknown seat')
          if (!mayAct(room, message.token)) return socket.close(4008, 'Rate limit exceeded')
          if (!seat.connected) seat = joinRoom(room, { token: message.token, settle: !reconnectingHandoff(room) })
          finishHandoffReconnect(room, seat)
          client = {
            code: room.code,
            token: message.token,
            playerId: seat.playerId,
          }
          sockets.set(socket, client)
          pendingAuth.delete(socket)
          clearTimeout(authTimer)
          for (const [otherSocket, other] of sockets) {
            if (otherSocket !== socket && other.code === room.code && other.token === message.token) {
              otherSocket.close(4001, 'Seat opened elsewhere')
            }
          }
          touch(room)
          queueSave()
          publish(room)
          return
        }
        if (message.type === 'action') {
          if (reconnectingHandoff(room)) throw new Error('Waiting for every player to reconnect')
          // The catch below sends the error frame on this same socket, so it
          // lands after the snapshot and the refusal still reads: no seat is
          // skipped here, and a socket client has no other way to catch up.
          const versionBefore = room.version
          try {
            const result = apply(room, client.token, message.action)
            if (result.changed) {
              touch(room)
              queueSave()
              publish(room)
            }
          } catch (error) {
            reconcileRefusal(room, versionBefore)
            throw error
          }
        } else if (message.type === 'voice') {
          if (!message.signal || typeof message.signal !== 'object' || Array.isArray(message.signal)) {
            throw new Error('Invalid voice signal')
          }
          if (JSON.stringify(message.signal).length > 32 * 1024) throw new Error('Voice signal is too large')
          const target = room.seats.find((seat) => seat.playerId === message.to)
          if (!target) throw new Error('Unknown voice peer')
          for (const [peer, peerClient] of sockets) {
            if (peerClient.code === room.code && peerClient.playerId === target.playerId && peer.readyState === 1) {
              if (peer.bufferedAmount > MAX_BUFFERED_BYTES) {
                peer.terminate()
                continue
              }
              peer.send(JSON.stringify({
                type: 'voice',
                from: client.playerId,
                signal: message.signal,
              }))
            }
          }
        } else {
          throw new Error('Unknown message type')
        }
      } catch (error) {
        if (!sockets.has(socket)) socket.close(4003, 'Authentication required')
        else if (socket.readyState === 1) {
          if (socket.bufferedAmount > MAX_BUFFERED_BYTES) socket.terminate()
          else socket.send(JSON.stringify({ type: 'error', error: error instanceof Error ? error.message : 'Bad message' }))
        }
      }
    })
    socket.on('error', () => socket.terminate())
    socket.on('close', () => {
      clearTimeout(authTimer)
      pendingAuth.delete(socket)
      const client = sockets.get(socket)
      sockets.delete(socket)
      if (!client || preserveRoomsOnClose) return
      if ([...sockets.values()].some((other) => other.code === client.code && other.token === client.token)) return
      const room = store.rooms.get(client.code)
      if (room) {
        const quorum = store.reconnectQuorums.get(room.code)
        if (quorum) {
          const seat = findSeat(room, client.token)
          if (seat?.connected) {
            seat.connected = false
            room.version += 1
          }
          if (seat) quorum.playerIds.add(seat.playerId)
        } else markDisconnected(room, client.token)
        touch(room)
        queueSave()
        publish(room)
      }
    })
  })

  wss.on('error', () => {})
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (socket.isAlive === false) socket.terminate()
      else {
        socket.isAlive = false
        socket.ping()
      }
    }
  }, HEARTBEAT_MS)
  heartbeat.unref()
  const sweeper = setInterval(() => sweepRooms(), 60_000)
  sweeper.unref()
  let closePromise

  return {
    store,
    get saveError() { return saveError },
    sweepRooms,
    touch,
    dropConnection(code, token) {
      for (const [socket, client] of sockets) if (client.code === code && client.token === token) socket.terminate()
    },
    publishRoom(code) {
      const room = store.rooms.get(code)
      if (room) publish(room)
    },
    server,
    listen(port = 8787, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => {
          server.off('error', reject)
          resolve(server.address())
        })
      })
    },
    close({ preserveRooms = false, markerFile } = {}) {
      if (closePromise) return closePromise
      preserveRoomsOnClose = preserveRooms
      clearInterval(heartbeat)
      clearInterval(sweeper)
      const stopped = server.listening
        ? new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
        : Promise.resolve()
      const disconnected = Promise.all([...wss.clients].map((socket) => new Promise((resolve) => {
        if (socket.readyState === socket.CLOSED) return resolve()
        socket.once('close', resolve)
        socket.terminate()
      })))
      closePromise = Promise.all([stopped, disconnected]).then(() => {
        flushSave()
        if (markerFile) writeFileSync(markerFile, 'ok\n', { mode: 0o600 })
      })
      return closePromise
    },
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const roomServer = createRoomServer({ storeFile: process.env.STS_ROOM_STORE ?? '.rooms/rooms.json' })
  const port = Number(process.env.PORT ?? 8787)
  await roomServer.listen(port, process.env.HOST ?? '127.0.0.1')
  console.log(`Room server listening on http://127.0.0.1:${port}`)
  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    try {
      await roomServer.close({
        preserveRooms: process.env.STS_PRESERVE_ON_SHUTDOWN === 'true',
        markerFile: process.env.STS_SHUTDOWN_MARKER,
      })
    } catch (error) {
      console.error('Room server shutdown failed:', error)
      process.exitCode = 1
    }
  }
  process.once('SIGINT', () => { void stop() })
  process.once('SIGTERM', () => { void stop() })
}
