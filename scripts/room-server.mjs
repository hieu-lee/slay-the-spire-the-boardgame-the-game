#!/usr/bin/env node
import { MAX_MAIL_CHARACTERS } from './lib/mail.mjs'
import { createServer as createHttpServer } from 'node:http'
import { existsSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { classifyDeckType, codexReady } from './lib/codex-deck-classifier.mjs'
import { addLeaderboardRun, roomLeaderboardRun } from './lib/leaderboard.mjs'
import { backfillDailyCoins } from './lib/daily-coins.mjs'
import { deckHash, HERO_NAMES, SPECIFIC_ARCHETYPE_FLOOR, otherDeckType, recordDeckClassification, soloDeck, validClassifierThreadId, validDeckType, validSoloDeck } from './lib/stats.mjs'
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
  restoreRoom,
  saveStore,
  snapshotFor,
  startRun,
  selectCampaign,
} from './lib/rooms.mjs'
import {
  applyCors,
  codeOf,
  consume,
  createRestrictionPolicy,
  pruneRateMap,
  readJson,
  requestIdOf,
  send,
  sourceOf,
  tokenOf,
} from './lib/server/http.mjs'
import { createWsLayer } from './lib/server/ws.mjs'
import { createMetaRoutes } from './lib/server/routes-meta.mjs'

const MULTIPLAYER_PROTOCOL_VERSION = 1
const MAX_ROOMS = 100
const ROOM_TTL_MS = 24 * 60 * 60 * 1000
const TURN_CREDENTIAL_TTL_SECONDS = 6 * 60 * 60
const releaseDirectory = basename(process.cwd())
const RELEASE_SHA = /^[0-9a-f]{40}$/.test(releaseDirectory) ? releaseDirectory : null
const MESSAGE_WINDOW_MS = 10_000
const MAX_MESSAGES_PER_WINDOW = 300
const MAX_READS_PER_WINDOW = 600
const MAX_VOICE_MESSAGES_PER_WINDOW = 600
const CREATE_WINDOW_MS = 60_000
const MAX_PROFILE_CLAIMS_PER_WINDOW = 30
const MAX_CREATES_PER_WINDOW = 10
const MAX_JOINS_PER_WINDOW = 30
const CLASSIFICATION_DAY_MS = 24 * 60 * 60 * 1000
const MAX_UPGRADES_PER_WINDOW = 120
const MAX_ROOMS_PER_IP = 10
export const MAX_CONNECTIONS = 50
const MAX_PENDING_AUTH = MAX_CONNECTIONS
const STORE_SAVE_DELAY_MS = 1_000
const CATCH_UP_RESERVATION_MS = 30_000
const DEFAULT_ICE_SERVERS = [{ urls: 'stun:stun.cloudflare.com:3478' }]

export function createRoomServer({
  turnKeyId = process.env.CLOUDFLARE_TURN_KEY_ID,
  turnApiToken = process.env.CLOUDFLARE_TURN_API_TOKEN,
  fetchImpl = fetch,
  storeFile,
  maxConnections = MAX_CONNECTIONS,
  maxUpgradesPerWindow = MAX_UPGRADES_PER_WINDOW,
  saveDelayMs = STORE_SAVE_DELAY_MS,
  saveStoreImpl = saveStore,
  classifierEnabled = process.env.STS_DECK_CLASSIFIER_ENABLED === 'true',
  maxDeckClassificationsPerDay = Number(process.env.STS_DECK_CLASSIFICATIONS_PER_DAY ?? 100),
  deckClassifier = classifyDeckType,
  mailAdminToken = process.env.STS_MAIL_ADMIN_TOKEN,
  mailAdminOwners = process.env.STS_MAIL_ADMIN_OWNERS,
  restrictedUsernames = process.env.STS_RESTRICTED_USERNAMES,
  maxMailCharacters = MAX_MAIL_CHARACTERS,
  onSaveError = (error) => console.error('Room store save failed:', error),
  onSlowOperation = ({ kind, roomCode, durationMs }) =>
    console.warn(`Slow multiplayer ${kind} in room ${roomCode}: ${durationMs}ms`),
  allowedOrigin = process.env.STS_ALLOWED_ORIGIN,
  restartRecovery = process.env.STS_RESTART_RECOVERY === 'true',
  restartReconnectMs = Math.max(5 * 60_000, Number(process.env.STS_RESTART_RECONNECT_MS) || 0),
} = {}) {
  if (!Number.isSafeInteger(maxDeckClassificationsPerDay) || maxDeckClassificationsPerDay < 0) throw new Error('Invalid deck classification daily limit')
  const store = createStore({ file: storeFile, restartRecovery, restartReconnectMs })
  if (classifierEnabled && deckClassifier === classifyDeckType && !codexReady()) {
    console.error('Deck classification disabled: local Codex CLI login or sandbox is unavailable')
    classifierEnabled = false
  }
  if (store.deckClassifierRelease !== releaseDirectory) {
    store.deckClassifierThreadId = undefined
    store.deckClassifierRelease = releaseDirectory
    store.statsStateDirty = true
  }
  const roomActivity = new Map()
  const roomOwners = new Map()
  const createRates = new Map()
  const joinRates = new Map()
  const entryRetryRates = new Map()
  const actionRates = new Map()
  const readRates = new Map()
  const voiceRates = new Map()

  let saveTimer
  let saveError = null
  const applyAndRecord = (room, token, action) => {
    const finalized = room.run?.campaign.finalized === true
    const checkpoint = !finalized && action?.kind === 'finishRun' ? structuredClone(room) : null
    try {
      if (finalized && addLeaderboardRun(store, roomLeaderboardRun(room))) { queueSave(); scheduleClassification() }
      const result = apply(room, token, action)
      if (!finalized && room.run?.campaign.finalized === true) {
        addLeaderboardRun(store, roomLeaderboardRun(room))
        scheduleClassification()
      }
      return result
    } catch (error) {
      if (checkpoint && room.run?.campaign.finalized) restoreRoom(room, checkpoint)
      throw error
    }
  }
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

  let classifierTimer
  let classifierTimerAt = Infinity
  let classifierAbort
  let classificationTask
  let classifying = false
  let classifierClosed = false
  const failedDecks = new Map(store.statsRuns.filter((entry) => entry.deckClassificationRetry)
    .map((entry) => [entry.id, { at: entry.deckClassificationRetry.after, hash: entry.deckClassificationRetry.hash, hero: entry.character }]))
  const scheduleClassification = (delay = 0) => {
    if (classifierClosed) return
    for (const run of store.statsRuns) {
      const other = otherDeckType(run.character)
      if (run.deckType && (run.deckType !== other || run.floorsCleared < SPECIFIC_ARCHETYPE_FLOOR)) continue
      if (!validSoloDeck(run)) continue
      const hasSpecific = store.deckTypes.some((type) => type.startsWith(`${HERO_NAMES[run.character]} `) && type !== other)
      if (run.deckType === other && run.floorsCleared >= SPECIFIC_ARCHETYPE_FLOOR && !hasSpecific) {
        delete run.deckType
        if (!run.sourceRunId) {
          store.leaderboardChanges.set(run.id, run)
          store.leaderboardRevision += 1
        }
        recordDeckClassification(store, run)
        queueSave()
      }
      if (run.deckType || run.floorsCleared >= SPECIFIC_ARCHETYPE_FLOOR || hasSpecific) continue
      if (!store.deckTypes.includes(other)) { store.deckTypes.push(other); store.statsStateDirty = true }
      run.deckType = other
      delete run.deckClassificationRetry
      failedDecks.delete(run.id)
      recordDeckClassification(store, run)
      queueSave()
    }
    if (!classifierEnabled || classifying) return
    const nextAt = Date.now() + delay
    if (classifierTimer && nextAt >= classifierTimerAt) return
    if (classifierTimer) clearTimeout(classifierTimer)
    classifierTimerAt = nextAt
    classifierTimer = setTimeout(() => {
      classifierTimer = undefined
      classifierTimerAt = Infinity
      classificationTask = classifyPending().finally(() => { classificationTask = null })
    }, Math.min(delay, 2_147_483_647))
    classifierTimer.unref()
  }
  const classifyPending = async () => {
    if (classifying || classifierClosed) return
    classifying = true
    let retryAt = Infinity
    try {
      while (!classifierClosed) {
        const now = Date.now()
        const run = store.statsRuns.find((entry) => {
          if (!validSoloDeck(entry) || entry.deckType) return false
          const failed = failedDecks.get(entry.id)
          if (failed && (failed.hero !== entry.character || failed.hash && failed.hash !== deckHash(entry))) {
            if (entry.deckClassificationRetry) { delete entry.deckClassificationRetry; recordDeckClassification(store, entry); queueSave() }
            failedDecks.delete(entry.id)
          }
          return (failedDecks.get(entry.id)?.at ?? 0) <= now
        })
        if (!run) {
          if (failedDecks.size) {
            const retryable = new Set(store.statsRuns.filter((entry) => validSoloDeck(entry) && !entry.deckType).map((entry) => entry.id))
            for (const id of failedDecks.keys()) if (!retryable.has(id)) failedDecks.delete(id)
            if (failedDecks.size) retryAt = Math.min(...[...failedDecks.values()].map((failure) => failure.at))
          }
          break
        }
        const day = Math.floor(now / CLASSIFICATION_DAY_MS)
        if (store.deckClassificationBudget.day !== day) { store.deckClassificationBudget = { day, used: 0 }; store.statsStateDirty = true }
        if (store.deckClassificationBudget.used >= maxDeckClassificationsPerDay) {
          retryAt = (day + 1) * CLASSIFICATION_DAY_MS
          break
        }
        store.deckClassificationBudget.used += 1
        store.statsStateDirty = true
        if (store.file && !attemptSave()) {
          store.deckClassificationBudget.used -= 1
          store.statsStateDirty = true
          queueSave()
          retryAt = Date.now() + 60_000
          break
        }
        const controller = new AbortController()
        classifierAbort = controller
        const deck = JSON.stringify(soloDeck(run))
        const hero = run.character
        const deepRun = run.floorsCleared >= SPECIFIC_ARCHETYPE_FLOOR
        try {
          const result = await deckClassifier(run, store.deckTypes, store.deckClassifierThreadId, undefined,
            AbortSignal.any([controller.signal, AbortSignal.timeout(300_000)]), store.statsRuns)
          if (classifierClosed) break
          const type = typeof result === 'string' ? result : result?.type
          if (result?.threadId !== undefined && !validClassifierThreadId(result.threadId)) throw new Error('Deck classifier returned an invalid thread')
          if (!validDeckType(type) || !type.startsWith(`${HERO_NAMES[run.character]} `)) throw new Error('Deck classifier returned an invalid type')
          const current = store.statsRuns.find((entry) => entry.id === run.id)
          if (!current || current.deckType || current.character !== hero || JSON.stringify(soloDeck(current)) !== deck) continue
          const other = otherDeckType(hero)
          const currentDeep = current.floorsCleared >= SPECIFIC_ARCHETYPE_FLOOR
          if (!currentDeep && type !== other && !store.deckTypes.includes(type) ||
              currentDeep && type === other && !store.deckTypes.some((name) => name.startsWith(`${HERO_NAMES[hero]} `) && name !== other)) {
            if (currentDeep !== deepRun) continue
            throw new Error('Deck classifier returned a type not allowed for this floor')
          }
          if (result?.threadId && result.threadId !== store.deckClassifierThreadId) {
            store.deckClassifierThreadId = result.threadId
            store.statsStateDirty = true
          }
          if (!store.deckTypes.includes(type)) { store.deckTypes.push(type); store.statsStateDirty = true }
          current.deckType = type
          delete current.deckClassificationRetry
          failedDecks.delete(run.id)
          recordDeckClassification(store, current)
          queueSave()
        } catch (error) {
          if (classifierClosed) break
          console.error('Deck classification failed:', error)
          if (error?.code === 'classifier_unavailable') {
            classifierEnabled = false
            store.deckClassificationBudget.used -= 1
            store.statsStateDirty = true
            queueSave()
            break
          }
          if (error?.code === 'stale_thread' && store.deckClassifierThreadId) {
            store.deckClassifierThreadId = undefined
            store.statsStateDirty = true
            queueSave()
          }
          const current = store.statsRuns.find((entry) => entry.id === run.id)
          if (!current || current.character !== hero || JSON.stringify(soloDeck(current)) !== deck ||
              (current.floorsCleared >= SPECIFIC_ARCHETYPE_FLOOR) !== deepRun) continue
          if ((!error?.code || error.code === 'ABORT_ERR' || error.code === 'max_output_tokens') && validClassifierThreadId(error?.threadId) && error.threadId !== store.deckClassifierThreadId) {
            store.deckClassifierThreadId = error.threadId
            store.statsStateDirty = true
            queueSave()
          }
          if (error?.code === 'max_output_tokens' || error?.code === 'context_exhausted') {
            const after = (Math.floor(Date.now() / CLASSIFICATION_DAY_MS) + 1) * CLASSIFICATION_DAY_MS
            const hash = deckHash(current)
            current.deckClassificationRetry = { after, hash }
            failedDecks.set(run.id, { at: after, hash, hero })
            recordDeckClassification(store, current)
            if (store.file && !attemptSave()) queueSave()
          } else failedDecks.set(run.id, { at: Date.now() + 60_000, hash: deckHash(run), hero })
        } finally {
          classifierAbort = undefined
        }
      }
    } finally {
      classifying = false
      if (Number.isFinite(retryAt)) scheduleClassification(Math.max(0, retryAt - Date.now()))
    }
  }

  let restoredLeaderboardRuns = false
  for (const room of store.rooms.values()) {
    if (!room.run?.campaign.finalized) continue
    try { restoredLeaderboardRuns = addLeaderboardRun(store, roomLeaderboardRun(room)) || restoredLeaderboardRuns } catch {}
  }
  const backfilledDailyCoins = backfillDailyCoins(store)
  if (store.file && existsSync(store.file) && (backfilledDailyCoins || store.statsStateDirty || store.statsChanges.size || store.interruptedJournals.size)) flushSave()
  else if (restoredLeaderboardRuns || backfilledDailyCoins) queueSave()
  scheduleClassification()

  for (const [code, room] of store.rooms) roomActivity.set(code, room.lastActivityAt ?? Date.now())

  const restrictions = createRestrictionPolicy({ restrictedUsernames })
  const { isRestrictedName, rejectRestricted, seatRestricted } = restrictions

  const touch = (room) => {
    room.lastActivityAt = Date.now()
    roomActivity.set(room.code, room.lastActivityAt)
  }

  const recoveringRestart = (room) => store.reconnectQuorums.has(room.code)
  // Restricted seats can never reconnect, so a restart does not wait for them. Once the others are
  // back, or time runs out, they are settled like any seat that stayed away.
  const settleRestrictedSeats = (room) => {
    for (const seat of room.seats) if (isRestrictedName(seat.name)) markDisconnected(room, seat.token)
  }
  const finishRestartRecovery = (room, seat) => {
    const quorum = store.reconnectQuorums.get(room.code)
    if (!quorum) return
    quorum.playerIds.delete(seat.playerId)
    if (quorum.playerIds.size === 0) {
      store.reconnectQuorums.delete(room.code)
      settleRestrictedSeats(room)
    }
  }

  for (const [code, quorum] of store.reconnectQuorums) {
    const room = store.rooms.get(code)
    for (const seat of room?.seats ?? []) if (isRestrictedName(seat.name)) quorum.playerIds.delete(seat.playerId)
    if (quorum.playerIds.size === 0) {
      store.reconnectQuorums.delete(code)
      if (room) settleRestrictedSeats(room)
    }
  }

  const mayAct = (room, token) => consume(
    actionRates, `${room.code}:${token}`, MESSAGE_WINDOW_MS, MAX_MESSAGES_PER_WINDOW,
  )
  const mayRead = (room, token) => consume(
    readRates, `${room.code}:${token}`, MESSAGE_WINDOW_MS, MAX_READS_PER_WINDOW,
  )
  const maySignalVoice = (room, token) => consume(
    voiceRates, `${room.code}:${token}`, MESSAGE_WINDOW_MS, MAX_VOICE_MESSAGES_PER_WINDOW,
  )

  function roomOrThrow(code) {
    const room = store.rooms.get(codeOf(code))
    if (!room) throw Object.assign(new Error('Room not found'), { status: 404 })
    return room
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

  const ws = createWsLayer({
    store,
    allowedOrigin,
    restartRecovery,
    maxConnections,
    maxPendingAuth: MAX_PENDING_AUTH,
    maxUpgradesPerWindow,
    createWindowMs: CREATE_WINDOW_MS,
    messageWindowMs: MESSAGE_WINDOW_MS,
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
  })
  const { sockets, publish } = ws

  const metaRoutes = createMetaRoutes({
    store,
    attemptSave,
    queueSave,
    scheduleClassification,
    restrictions,
    mailAdminToken,
    mailAdminOwners,
    maxMailCharacters,
    createWindowMs: CREATE_WINDOW_MS,
    maxProfileClaimsPerWindow: MAX_PROFILE_CLAIMS_PER_WINDOW,
  })

  function sweepRooms(now = Date.now()) {
    metaRoutes.sweepRates(now)
    ws.sweepRates(now)
    pruneRateMap(createRates, CREATE_WINDOW_MS, now)
    pruneRateMap(joinRates, CREATE_WINDOW_MS, now)
    pruneRateMap(entryRetryRates, CREATE_WINDOW_MS, now)
    pruneRateMap(actionRates, MESSAGE_WINDOW_MS, now)
    pruneRateMap(readRates, MESSAGE_WINDOW_MS, now)
    pruneRateMap(voiceRates, MESSAGE_WINDOW_MS, now)
    for (const [code, quorum] of store.reconnectQuorums) {
      if (now < quorum.expiresAt) continue
      const room = store.rooms.get(code)
      store.reconnectQuorums.delete(code)
      if (!room) continue
      for (const playerId of quorum.playerIds) {
        const seat = room.seats.find((candidate) => candidate.playerId === playerId)
        if (seat) markDisconnected(room, seat.token)
      }
      settleRestrictedSeats(room)
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
      if (now - touchedAt > ROOM_TTL_MS) {
        if (room?.run?.campaign.finalized) {
          try { addLeaderboardRun(store, roomLeaderboardRun(room)) } catch {}
        }
        ws.closeRoomSockets(code, 4004, 'Room expired')
        store.rooms.delete(code)
        store.reconnectQuorums.delete(code)
        roomActivity.delete(code)
        roomOwners.delete(code)
        queueSave()
      }
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
          body: JSON.stringify({ ttl: TURN_CREDENTIAL_TTL_SECONDS }),
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

  const server = createHttpServer(async (request, response) => {
    let acted = null
    try {
      if (applyCors(request, response, allowedOrigin)) return
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (request.method === 'GET' && url.pathname === '/api/health') {
        return send(response, 200, {
          ok: true, rooms: store.rooms.size, connections: sockets.size, connectionCapacity: maxConnections,
          protocolVersion: MULTIPLAYER_PROTOCOL_VERSION, profiles: true, passwordAccounts: true,
          entryRequestIds: true, webSocketActionAcks: true, releaseSha: RELEASE_SHA,
          accountWallets: true, accountAscensions: true,
        })
      }
      if (await metaRoutes.handle(request, response, url)) return
      if (request.method === 'POST' && url.pathname === '/api/rooms') {
        sweepRooms()
        const source = sourceOf(request)
        const admitted = consume(createRates, source, CREATE_WINDOW_MS, MAX_CREATES_PER_WINDOW)
        if (!admitted && !consume(entryRetryRates, `${source}:create`, CREATE_WINDOW_MS, MAX_JOINS_PER_WINDOW)) {
          return send(response, 429, { error: 'Too many rooms created' })
        }
        const body = await readJson(request)
        if (isRestrictedName(body.name)) rejectRestricted()
        const requestId = requestIdOf(body.requestId)
        if (requestId) {
          for (const existingRoom of store.rooms.values()) {
            const existingSeat = existingRoom.seats.find((seat) => seat.joinRequestId === requestId)
            if (existingSeat) {
              if (isRestrictedName(existingSeat.name)) rejectRestricted()
              return send(response, 200, { token: existingSeat.token, snapshot: snapshotFor(existingRoom, existingSeat.token) })
            }
          }
        }
        if (!admitted) return send(response, 429, { error: 'Too many rooms created' })
        if (store.rooms.size >= MAX_ROOMS) return send(response, 503, { error: 'Room capacity reached' })
        if ([...roomOwners.values()].filter((owner) => owner === source).length >= MAX_ROOMS_PER_IP) {
          return send(response, 429, { error: 'Too many active rooms' })
        }
        const room = createRoom(store)
        roomOwners.set(room.code, source)
        try {
          const seat = joinRoom(room, { name: body.name, character: body.character, skin: body.skin, campaignProgress: body.campaignProgress, cardPacks: body.cardPacks, connected: false })
          if (requestId) seat.joinRequestId = requestId
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
      const match = url.pathname.match(/^\/api\/rooms\/([^/]+)(?:\/(join|leave|character|ascension|relic-rule|last-stand-rule|run-meta|campaign-select|start|action|voice-ice))?$/)
      if (!match) return send(response, 404, { error: 'Not found' })
      const room = roomOrThrow(match[1])
      const operation = match[2]
      if (request.method === 'GET' && !operation) {
        const token = tokenOf(request)
        const seat = findSeat(room, token)
        if (!seat) return send(response, 401, { error: 'Unknown seat' })
        if (isRestrictedName(seat.name)) rejectRestricted()
        if (!mayRead(room, token)) return send(response, 429, { error: 'Rate limit exceeded' })
        return send(response, 200, snapshotFor(room, token))
      }
      if (request.method === 'GET' && operation === 'voice-ice') {
        const token = tokenOf(request)
        if (!findSeat(room, token)) return send(response, 401, { error: 'Unknown seat' })
        if (seatRestricted(room, token)) rejectRestricted()
        if (!mayRead(room, token)) return send(response, 429, { error: 'Rate limit exceeded' })
        return send(response, 200, { iceServers: await voiceIceServers() })
      }
      if (request.method !== 'POST') return send(response, 405, { error: 'Method not allowed' })
      if (operation === 'join') {
        const source = sourceOf(request)
        const admitted = consume(joinRates, source, CREATE_WINDOW_MS, MAX_JOINS_PER_WINDOW)
        if (!admitted && !consume(entryRetryRates, `${source}:join`, CREATE_WINDOW_MS, MAX_JOINS_PER_WINDOW)) {
          return send(response, 429, { error: 'Too many join attempts' })
        }
        const body = await readJson(request)
        if (store.rooms.get(room.code) !== room) return send(response, 404, { error: 'Room not found' })
        if (isRestrictedName(body.name) || seatRestricted(room, body.token ?? tokenOf(request))) rejectRestricted()
        const requestId = requestIdOf(body.requestId)
        const repeatedSeat = requestId && room.seats.find((seat) => seat.joinRequestId === requestId)
        if (repeatedSeat) {
          if (isRestrictedName(repeatedSeat.name)) rejectRestricted()
          return send(response, 200, { token: repeatedSeat.token, snapshot: snapshotFor(room, repeatedSeat.token) })
        }
        if (!admitted) return send(response, 429, { error: 'Too many join attempts' })
        const token = body.token ?? tokenOf(request)
        if (recoveringRestart(room) && !findSeat(room, token)) {
          return send(response, 409, { error: 'Waiting for every player to reconnect' })
        }
        const live = ws.isSeatConnected(room.code, token)
        const beforeVersion = room.version
        const seat = joinRoom(room, {
          name: body.name, character: body.character, skin: body.skin, campaignProgress: body.campaignProgress, cardPacks: body.cardPacks,
          token, connected: live, settle: !recoveringRestart(room),
        })
        if (requestId) seat.joinRequestId = requestId
        if (live) finishRestartRecovery(room, seat)
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
      if (operation !== 'leave' && seatRestricted(room, token)) rejectRestricted()
      if (!mayAct(room, token)) return send(response, 429, { error: 'Rate limit exceeded' })
      if (recoveringRestart(room)) return send(response, 409, { error: 'Waiting for every player to reconnect' })
      const body = await readJson(request)
      if (store.rooms.get(room.code) !== room) return send(response, 404, { error: 'Room not found' })
      let changed = true
      let snapshot = null
      acted = { room, version: room.version, token }
      if (operation === 'character') snapshot = chooseCharacter(room, token, body.character, body.skin)
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
        ws.closeSeatSockets(room.code, token, 1000, 'Left room')
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
      else if (operation === 'campaign-select') snapshot = selectCampaign(room, token, body.enabled)
      else if (operation === 'start') {
        if (room.seats.some((seat) => !seat.connected)) {
          return send(response, 409, { error: 'Every seat must be connected before starting' })
        }
        snapshot = startRun(room, token, { campaign: body.campaign })
      }
      else if (operation === 'action') {
        const result = applyAndRecord(room, token, body.action)
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

  ws.attachUpgrade(server)

  const sweeper = setInterval(() => sweepRooms(), 60_000)
  sweeper.unref()
  let closePromise

  return {
    store,
    get saveError() { return saveError },
    sweepRooms,
    touch,
    dropConnection(code, token) {
      ws.dropConnection(code, token)
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
      classifierClosed = true
      if (classifierTimer) clearTimeout(classifierTimer)
      classifierAbort?.abort()
      clearInterval(sweeper)
      const disconnected = ws.close({ preserveRooms })
      const stopped = server.listening
        ? new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
        : Promise.resolve()
      closePromise = Promise.all([stopped, disconnected, classificationTask]).then(() => {
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
