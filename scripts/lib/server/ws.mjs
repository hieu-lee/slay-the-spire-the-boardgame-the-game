import { WebSocketServer } from 'ws'
import { findSeat, joinRoom, markDisconnected, snapshotFor } from '../rooms.mjs'
import {
  MAX_BODY,
  SPIRE_REJECTION,
  codeOf,
  consume,
  pruneRateMap,
  requestIdOf,
  sourceOf,
} from './http.mjs'

const HEARTBEAT_MS = 30_000
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024
const MAX_ABUSIVE_MESSAGES_PER_WINDOW = 3_000
const MAX_PENDING_AUTH_PER_IP = 8
const MAX_VOICE_SIGNAL_BYTES = 32 * 1024

export function createWsLayer({
  store,
  allowedOrigin,
  restartRecovery,
  maxConnections,
  maxPendingAuth,
  maxUpgradesPerWindow,
  createWindowMs,
  messageWindowMs,
  mayAct,
  maySignalVoice,
  roomOrThrow,
  isRestrictedName,
  recoveringRestart,
  finishRestartRecovery,
  applyAndRecord,
  reconcileRefusal,
  touch,
  queueSave,
  onSlowOperation,
}) {
  const sockets = new Map()
  const roomSockets = new Map()
  const pendingAuth = new Map()
  const upgradeRates = new Map()
  const invalidUpgradeRates = new Map()
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_BODY,
    perMessageDeflate: { threshold: 1024, serverNoContextTakeover: true },
  })
  let preserveRoomsOnClose = false

  function registerSocket(socket, client) {
    sockets.set(socket, client)
    let group = roomSockets.get(client.code)
    if (!group) {
      group = new Set()
      roomSockets.set(client.code, group)
    }
    group.add(socket)
  }

  function unregisterSocket(socket) {
    const client = sockets.get(socket)
    if (!client) return undefined
    sockets.delete(socket)
    const group = roomSockets.get(client.code)
    if (group) {
      group.delete(socket)
      if (group.size === 0) roomSockets.delete(client.code)
    }
    return client
  }

  function publish(room, skipToken, sharedSnapshot = {}, precomputedToken, precomputedSnapshot) {
    const group = roomSockets.get(room.code)
    if (!group || group.size === 0) return
    const startedAt = Date.now()
    for (const socket of group) {
      if (socket.readyState !== 1) continue
      const client = sockets.get(socket)
      if (!client) continue
      if (skipToken !== undefined && client.token === skipToken) continue
      if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
        socket.terminate()
        continue
      }
      const snapshot = precomputedToken !== undefined && client.token === precomputedToken && precomputedSnapshot !== undefined
        ? precomputedSnapshot
        : snapshotFor(room, client.token, sharedSnapshot)
      socket.send(JSON.stringify({ type: 'snapshot', snapshot }))
    }
    const durationMs = Date.now() - startedAt
    if (durationMs >= 100) {
      try { onSlowOperation({ kind: 'broadcast', roomCode: room.code, durationMs }) } catch {}
    }
  }

  function attachUpgrade(server) {
    server.on('upgrade', (request, socket, head) => {
      try {
        const url = new URL(request.url ?? '/', 'http://localhost')
        if (url.pathname !== '/ws') throw new Error('Not found')
        if (allowedOrigin && request.headers.origin && request.headers.origin !== allowedOrigin) throw new Error('Origin not allowed')
        const source = sourceOf(request)
        const code = codeOf(url.searchParams.get('room') ?? '')
        const room = store.rooms.get(code)
        if (!room) {
          const status = consume(invalidUpgradeRates, source, createWindowMs, maxUpgradesPerWindow) ? 401 : 429
          socket.write(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Too Many Requests'}\r\nConnection: close\r\n\r\n`)
          return socket.destroy()
        }
        const roomScopedSource = restartRecovery
        const sourceKey = roomScopedSource ? `${source}:${code}` : source
        const tooManyPending = pendingAuth.size >= maxPendingAuth
          || [...pendingAuth.values()].filter((pendingSource) => pendingSource === sourceKey).length >= MAX_PENDING_AUTH_PER_IP
        if (tooManyPending || !consume(upgradeRates, sourceKey, createWindowMs, maxUpgradesPerWindow)) {
          socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n')
          return socket.destroy()
        }
        wss.handleUpgrade(request, socket, head, (webSocket) => {
          wss.emit('connection', webSocket, { code: room.code, source: sourceKey })
        })
      } catch {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
        socket.destroy()
      }
    })
  }

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
          const now = Date.now()
          if (!client.messageWindowStartedAt || now - client.messageWindowStartedAt >= messageWindowMs) {
            client.messageWindowStartedAt = now
            client.messageCount = 0
          }
          client.messageCount += 1
          if (client.messageCount > MAX_ABUSIVE_MESSAGES_PER_WINDOW) {
            return socket.close(4008, 'Abusive traffic limit exceeded')
          }
          const allowed = message.type === 'voice'
            ? maySignalVoice(room, client.token)
            : mayAct(room, client.token)
          if (!allowed) {
            if (socket.bufferedAmount > MAX_BUFFERED_BYTES) return socket.terminate()
            if (message.type !== 'action') {
              return socket.send(JSON.stringify({ type: 'error', status: 429, error: 'Rate limit exceeded' }))
            }
            let requestId
            try { requestId = requestIdOf(message.requestId) } catch {}
            return socket.send(JSON.stringify({
              type: 'error', requestId, status: 429, error: 'Rate limit exceeded',
              snapshot: snapshotFor(room, client.token),
            }))
          }
        }
        if (!client) {
          if (message.type !== 'authenticate' || typeof message.token !== 'string') {
            return socket.close(4003, 'Authentication required')
          }
          room = roomOrThrow(context.code)
          let seat = findSeat(room, message.token)
          if (!seat) return socket.close(4003, 'Unknown seat')
          if (isRestrictedName(seat.name)) return socket.close(4003, SPIRE_REJECTION)
          const existingRoomSockets = roomSockets.get(room.code)
          const replacedSockets = existingRoomSockets
            ? [...existingRoomSockets].filter((otherSocket) => sockets.get(otherSocket)?.token === message.token)
            : []
          if (replacedSockets.length === 0 && sockets.size >= maxConnections) {
            return socket.close(4009, 'Server connection capacity reached')
          }
          seat = joinRoom(room, {
            token: message.token, campaignProgress: message.campaignProgress, cardPacks: message.cardPacks,
            settle: !recoveringRestart(room),
          })
          finishRestartRecovery(room, seat)
          client = {
            code: room.code,
            token: message.token,
            playerId: seat.playerId,
          }
          registerSocket(socket, client)
          pendingAuth.delete(socket)
          clearTimeout(authTimer)
          for (const otherSocket of replacedSockets) {
            unregisterSocket(otherSocket)
            otherSocket.close(4001, 'Seat opened elsewhere')
          }
          touch(room)
          queueSave()
          publish(room)
          return
        }
        if (message.type === 'action') {
          const requestId = requestIdOf(message.requestId)
          const versionBefore = room.version
          try {
            if (recoveringRestart(room)) {
              throw Object.assign(new Error('Waiting for every player to reconnect'), { status: 409 })
            }
            const sharedSnapshot = {}
            const result = applyAndRecord(room, client.token, message.action, sharedSnapshot)
            if (result.changed) {
              touch(room)
              queueSave()
              publish(
                room,
                requestId ? client.token : undefined,
                sharedSnapshot,
                requestId ? undefined : client.token,
                requestId ? undefined : result.snapshot,
              )
            }
            if (requestId) {
              if (socket.bufferedAmount > MAX_BUFFERED_BYTES) socket.terminate()
              else socket.send(JSON.stringify({ type: 'snapshot', requestId, snapshot: result.snapshot }))
            }
          } catch (error) {
            reconcileRefusal(room, versionBefore, requestId ? client.token : undefined)
            if (!requestId) throw error
            if (socket.bufferedAmount > MAX_BUFFERED_BYTES) socket.terminate()
            else socket.send(JSON.stringify({
              type: 'error', requestId,
              status: error.status ?? (error.name === 'RoomError' ? 409 : 500),
              error: error instanceof Error ? error.message : 'Bad message',
              snapshot: snapshotFor(room, client.token),
            }))
          }
        } else if (message.type === 'voice') {
          if (!message.signal || typeof message.signal !== 'object' || Array.isArray(message.signal)) {
            throw new Error('Invalid voice signal')
          }
          if (JSON.stringify(message.signal).length > MAX_VOICE_SIGNAL_BYTES) throw new Error('Voice signal is too large')
          const target = room.seats.find((seat) => seat.playerId === message.to)
          if (!target) throw new Error('Unknown voice peer')
          const group = roomSockets.get(room.code)
          if (group) {
            for (const peer of group) {
              const peerClient = sockets.get(peer)
              if (peerClient?.playerId === target.playerId && peer.readyState === 1) {
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
      const client = unregisterSocket(socket)
      if (!client || preserveRoomsOnClose) return
      const group = roomSockets.get(client.code)
      if (group && [...group].some((other) => sockets.get(other)?.token === client.token)) return
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

  return {
    sockets,
    publish,
    attachUpgrade,
    sweepRates(now) {
      pruneRateMap(upgradeRates, createWindowMs, now)
      pruneRateMap(invalidUpgradeRates, createWindowMs, now)
    },
    isSeatConnected(code, token) {
      const group = roomSockets.get(code)
      if (!group) return false
      for (const socket of group) if (sockets.get(socket)?.token === token) return true
      return false
    },
    closeSeatSockets(code, token, closeCode, reason) {
      const group = roomSockets.get(code)
      if (!group) return
      for (const socket of [...group]) {
        if (sockets.get(socket)?.token === token) {
          unregisterSocket(socket)
          socket.close(closeCode, reason)
        }
      }
    },
    closeRoomSockets(code, closeCode, reason) {
      const group = roomSockets.get(code)
      if (!group) return
      for (const socket of [...group]) socket.close(closeCode, reason)
    },
    dropConnection(code, token) {
      const group = roomSockets.get(code)
      if (!group) return
      for (const socket of [...group]) {
        if (sockets.get(socket)?.token === token) socket.terminate()
      }
    },
    close({ preserveRooms = false } = {}) {
      preserveRoomsOnClose = preserveRooms
      clearInterval(heartbeat)
      return Promise.all([...wss.clients].map((socket) => new Promise((resolve) => {
        if (socket.readyState === socket.CLOSED) return resolve()
        socket.once('close', resolve)
        socket.terminate()
      })))
    },
  }
}
