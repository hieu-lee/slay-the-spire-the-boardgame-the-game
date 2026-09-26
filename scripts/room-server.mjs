#!/usr/bin/env node
import { claimProfile } from './lib/profiles.mjs'
import { MAX_MAIL_CHARACTERS, developerInbox, playerInbox, sendDeveloperReply, sendPlayerLetter } from './lib/mail.mjs'
import { createServer as createHttpServer } from 'node:http'
import { existsSync, writeFileSync } from 'node:fs'
import { timingSafeEqual } from 'node:crypto'
import { basename } from 'node:path'
import { WebSocketServer } from 'ws'
import { classifyDeckType, codexReady } from './lib/codex-deck-classifier.mjs'
import { addLeaderboardRun, leaderboardSnapshot, roomLeaderboardRun, winningDecksPage } from './lib/leaderboard.mjs'
import { deckHash, HERO_NAMES, SPECIFIC_ARCHETYPE_FLOOR, otherDeckType, randomDeck, recordDeckClassification, soloDeck, statsSnapshot, validClassifierThreadId, validDeckType, validSoloDeck } from './lib/stats.mjs'
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

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
}
const MAX_BODY = 64 * 1024
const MULTIPLAYER_PROTOCOL_VERSION = 1
const MAX_ROOMS = 100
const ROOM_TTL_MS = 24 * 60 * 60 * 1000
const TURN_CREDENTIAL_TTL_SECONDS = 6 * 60 * 60
const HEARTBEAT_MS = 30_000
const releaseDirectory = basename(process.cwd())
const RELEASE_SHA = /^[0-9a-f]{40}$/.test(releaseDirectory) ? releaseDirectory : null
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024
const MESSAGE_WINDOW_MS = 10_000
const MAX_MESSAGES_PER_WINDOW = 300
const MAX_READS_PER_WINDOW = 600
const MAX_VOICE_MESSAGES_PER_WINDOW = 600
const MAX_ABUSIVE_MESSAGES_PER_WINDOW = 3_000
const CREATE_WINDOW_MS = 60_000
const MAX_PROFILE_CLAIMS_PER_WINDOW = 30
const MAX_CREATES_PER_WINDOW = 10
const MAX_JOINS_PER_WINDOW = 30
const MAX_LEADERBOARD_WRITES_PER_WINDOW = 6
const MAX_DECK_READS_PER_WINDOW = 30
const MAX_STATS_READS_PER_WINDOW = 120
const MAX_MAIL_READS_PER_WINDOW = 60
const MAIL_SEND_WINDOW_MS = 10 * 60_000
const MAX_MAIL_SENDS_PER_WINDOW = 5
const MAX_MAIL_SENDS_PER_SOURCE = 20
const MAX_MAIL_ADMIN_FAILURES_PER_WINDOW = 10
const DECK_PAGE_CACHE_LIMIT = 64
const DECK_QUERY_KEYS = new Set(['sort', 'direction', 'character', 'ascension', 'cursor'])
const CLASSIFICATION_DAY_MS = 24 * 60 * 60 * 1000
const MAX_UPGRADES_PER_WINDOW = 120
const MAX_RATE_KEYS = 1024
const MAX_ROOMS_PER_IP = 10
export const MAX_CONNECTIONS = 50
const MAX_PENDING_AUTH = MAX_CONNECTIONS
const MAX_PENDING_AUTH_PER_IP = 8
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
const requestIdOf = (value) => {
  if (value === undefined) return undefined
  if (typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) return value
  throw Object.assign(new Error('Invalid request ID'), { status: 400 })
}
const sourceOf = (request) => request.headers['cf-connecting-ip']?.toString()
  ?? request.socket.remoteAddress
  ?? 'unknown'

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
  const sockets = new Map()
  const roomActivity = new Map()
  const roomOwners = new Map()
  const profileRates = new Map()
  const createRates = new Map()
  const joinRates = new Map()
  const entryRetryRates = new Map()
  const leaderboardRates = new Map()
  const deckReadRates = new Map()
  const statsRates = new Map()
  const mailReadRates = new Map()
  const mailSendRates = new Map()
  const mailProfileRates = new Map()
  const mailAdminFailures = new Map()
  const deckPages = new Map()
  let deckPagesRevision = store.leaderboardRevision
  let leaderboardSummary
  let leaderboardSummaryRevision = -1
  const upgradeRates = new Map()
  const invalidUpgradeRates = new Map()
  const actionRates = new Map()
  const readRates = new Map()
  const voiceRates = new Map()
  const pendingAuth = new Map()
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_BODY,
    perMessageDeflate: { threshold: 1024, serverNoContextTakeover: true },
  })
  let saveTimer
  let preserveRoomsOnClose = false
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
  if (store.file && existsSync(store.file) && (store.statsStateDirty || store.statsChanges.size || store.interruptedJournals.size)) flushSave()
  else if (restoredLeaderboardRuns) queueSave()
  scheduleClassification()

  for (const [code, room] of store.rooms) roomActivity.set(code, room.lastActivityAt ?? Date.now())

  const touch = (room) => {
    room.lastActivityAt = Date.now()
    roomActivity.set(room.code, room.lastActivityAt)
  }

  const recoveringRestart = (room) => store.reconnectQuorums.has(room.code)
  const finishRestartRecovery = (room, seat) => {
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

  const mailAdminKey = typeof mailAdminToken === 'string' && mailAdminToken.length >= 24 ? Buffer.from(`Bearer ${mailAdminToken}`) : null
  if (mailAdminToken && !mailAdminKey) console.warn('Mail replies disabled: STS_MAIL_ADMIN_TOKEN must be at least 24 characters')
  // Failures are always counted: when the table is full the oldest source makes
  // room, so a flood of fresh addresses cannot switch the lockout off.
  const mailAdminAuthorized = (request, now = Date.now()) => {
    const source = sourceOf(request)
    const failures = mailAdminFailures.get(source)
    const current = failures && now - failures.startedAt < CREATE_WINDOW_MS ? failures : undefined
    const offered = Buffer.from(request.headers.authorization?.toString() ?? '')
    const matches = offered.length === mailAdminKey.length && timingSafeEqual(offered, mailAdminKey)
    if (matches && (current?.count ?? 0) < MAX_MAIL_ADMIN_FAILURES_PER_WINDOW) return true
    if (!matches) {
      if (!current && mailAdminFailures.size >= MAX_RATE_KEYS) mailAdminFailures.delete(mailAdminFailures.keys().next().value)
      mailAdminFailures.delete(source)
      mailAdminFailures.set(source, { startedAt: current?.startedAt ?? now, count: (current?.count ?? 0) + 1 })
    }
    return false
  }
  const saveMail = (undo) => {
    store.mailDirty = true
    if (attemptSave()) return true
    undo()
    return false
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

  function sweepRooms(now = Date.now()) {
    for (const [key, rate] of profileRates) if (now - rate.startedAt >= CREATE_WINDOW_MS) profileRates.delete(key)
    for (const [key, rate] of createRates) if (now - rate.startedAt >= CREATE_WINDOW_MS) createRates.delete(key)
    for (const [key, rate] of joinRates) if (now - rate.startedAt >= CREATE_WINDOW_MS) joinRates.delete(key)
    for (const [key, rate] of entryRetryRates) if (now - rate.startedAt >= CREATE_WINDOW_MS) entryRetryRates.delete(key)
    for (const [key, rate] of leaderboardRates) if (now - rate.startedAt >= CREATE_WINDOW_MS) leaderboardRates.delete(key)
    for (const [key, rate] of deckReadRates) if (now - rate.startedAt >= CREATE_WINDOW_MS) deckReadRates.delete(key)
    for (const [key, rate] of statsRates) if (now - rate.startedAt >= CREATE_WINDOW_MS) statsRates.delete(key)
    for (const [key, rate] of mailReadRates) if (now - rate.startedAt >= CREATE_WINDOW_MS) mailReadRates.delete(key)
    for (const [key, rate] of mailSendRates) if (now - rate.startedAt >= MAIL_SEND_WINDOW_MS) mailSendRates.delete(key)
    for (const [key, rate] of mailProfileRates) if (now - rate.startedAt >= MAIL_SEND_WINDOW_MS) mailProfileRates.delete(key)
    for (const [key, rate] of mailAdminFailures) if (now - rate.startedAt >= CREATE_WINDOW_MS) mailAdminFailures.delete(key)
    for (const [key, rate] of upgradeRates) if (now - rate.startedAt >= CREATE_WINDOW_MS) upgradeRates.delete(key)
    for (const [key, rate] of invalidUpgradeRates) if (now - rate.startedAt >= CREATE_WINDOW_MS) invalidUpgradeRates.delete(key)
    for (const [key, rate] of actionRates) if (now - rate.startedAt >= MESSAGE_WINDOW_MS) actionRates.delete(key)
    for (const [key, rate] of readRates) if (now - rate.startedAt >= MESSAGE_WINDOW_MS) readRates.delete(key)
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
      if (now - touchedAt > ROOM_TTL_MS) {
        if (room?.run?.campaign.finalized) {
          try { addLeaderboardRun(store, roomLeaderboardRun(room)) } catch {}
        }
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
    const startedAt = Date.now()
    const sharedSnapshot = {}
    for (const [socket, client] of sockets) {
      if (client.code !== room.code || socket.readyState !== 1) continue
      if (skipToken !== undefined && client.token === skipToken) continue
      if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
        socket.terminate()
        continue
      }
      socket.send(JSON.stringify({ type: 'snapshot', snapshot: snapshotFor(room, client.token, sharedSnapshot) }))
    }
    const durationMs = Date.now() - startedAt
    if (durationMs >= 1_000) {
      try { onSlowOperation({ kind: 'broadcast', roomCode: room.code, durationMs }) } catch {}
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
        return send(response, 200, {
          ok: true, rooms: store.rooms.size, connections: sockets.size, connectionCapacity: maxConnections,
          protocolVersion: MULTIPLAYER_PROTOCOL_VERSION, profiles: true,
          entryRequestIds: true, webSocketActionAcks: true, releaseSha: RELEASE_SHA,
        })
      }
      if (request.method === 'POST' && url.pathname === '/api/profile') {
        if (!consume(profileRates, sourceOf(request), CREATE_WINDOW_MS, MAX_PROFILE_CLAIMS_PER_WINDOW)) {
          return send(response, 429, { error: 'Too many name requests. Please try again shortly.' })
        }
        const profile = claimProfile(store.profiles, await readJson(request))
        if (!attemptSave()) {
          queueSave()
          return send(response, 503, { error: 'Could not save your name. Please try again.' })
        }
        return send(response, 200, { username: profile.username })
      }
      if (request.method === 'POST' && (url.pathname === '/api/mail' || url.pathname === '/api/mail/send')) {
        const sending = url.pathname === '/api/mail/send'
        if (!consume(sending ? mailSendRates : mailReadRates, sourceOf(request), sending ? MAIL_SEND_WINDOW_MS : CREATE_WINDOW_MS,
          sending ? MAX_MAIL_SENDS_PER_SOURCE : MAX_MAIL_READS_PER_WINDOW)) {
          return send(response, 429, { error: sending ? 'You have sent a lot of letters. Please wait a little.' : 'Too many mail requests' })
        }
        const body = await readJson(request)
        const profile = typeof body.token === 'string' ? store.profiles.find((entry) => entry.token === body.token) : undefined
        if (!sending) {
          // An unknown profile simply has no letters yet: a first visit reads an
          // empty mailbox rather than an error.
          if (!profile) return send(response, 200, { letters: [], unread: 0 })
          const inbox = playerInbox(store.mail, profile, { markRead: body.markRead === true })
          if (inbox.changed) {
            store.mailDirty = true
            queueSave()
          }
          return send(response, 200, { letters: inbox.letters, unread: inbox.unread })
        }
        if (!profile) return send(response, 409, { error: 'Your name is not registered on this server.', code: 'profile' })
        if (!consume(mailProfileRates, profile.username, MAIL_SEND_WINDOW_MS, MAX_MAIL_SENDS_PER_WINDOW)) {
          return send(response, 429, { error: 'You have sent a lot of letters. Please wait a little.' })
        }
        // A letter that is refused or cannot be saved does not count against the allowance.
        const refund = () => { const rate = mailProfileRates.get(profile.username); if (rate) rate.count -= 1 }
        let sent
        try { sent = sendPlayerLetter(store.mail, profile, body.body, { maxCharacters: maxMailCharacters }) } catch (error) {
          refund()
          throw error
        }
        if (!saveMail(sent.undo)) {
          refund()
          return send(response, 503, { error: 'Could not send your letter. Please try again.' })
        }
        return send(response, 201, { letters: sent.letters, unread: sent.unread })
      }
      if (url.pathname === '/api/mail/admin' || url.pathname === '/api/mail/admin/reply') {
        if (!mailAdminKey) return send(response, 404, { error: 'Not found' })
        if (!mailAdminAuthorized(request)) return send(response, 401, { error: 'Unauthorized' })
        if (request.method === 'GET' && url.pathname === '/api/mail/admin') {
          const inbox = developerInbox(store.mail, store.profiles, {
            username: url.searchParams.get('username') ?? undefined, markRead: url.searchParams.get('markRead') === 'true',
          })
          if (inbox.changed) {
            store.mailDirty = true
            queueSave()
          }
          return send(response, 200, { threads: inbox.threads })
        }
        if (request.method === 'POST' && url.pathname === '/api/mail/admin/reply') {
          const body = await readJson(request)
          const { undo, ...reply } = sendDeveloperReply(store.mail, body.username, body.body, store.profiles, { maxCharacters: maxMailCharacters })
          if (!saveMail(undo)) return send(response, 503, { error: 'Could not save the reply. Please try again.' })
          return send(response, 201, reply)
        }
        return send(response, 405, { error: 'Method not allowed' })
      }
      if (request.method === 'GET' && url.pathname === '/api/leaderboard/decks') {
        if (!consume(deckReadRates, sourceOf(request), CREATE_WINDOW_MS, MAX_DECK_READS_PER_WINDOW)) return send(response, 429, { error: 'Too many deck requests' })
        if ([...url.searchParams.keys()].some((name) => !DECK_QUERY_KEYS.has(name) ||
            name !== 'character' && url.searchParams.getAll(name).length > 1)) return send(response, 400, { error: 'Invalid winning deck query' })
        if (deckPagesRevision !== store.leaderboardRevision) {
          deckPages.clear()
          deckPagesRevision = store.leaderboardRevision
        }
        const key = JSON.stringify([url.searchParams.get('sort') ?? 'recordedAt', url.searchParams.get('direction') ?? 'desc',
          url.searchParams.getAll('character').sort(), url.searchParams.get('ascension') ?? 'all', url.searchParams.get('cursor')])
        let page = deckPages.get(key)
        if (!page) {
          page = winningDecksPage(store.leaderboardRuns, url.searchParams)
          if (deckPages.size >= DECK_PAGE_CACHE_LIMIT) deckPages.clear()
          deckPages.set(key, page)
        }
        return send(response, 200, page)
      }
      if (request.method === 'GET' && url.pathname === '/api/stats') {
        if (!consume(statsRates, sourceOf(request), CREATE_WINDOW_MS, MAX_STATS_READS_PER_WINDOW)) return send(response, 429, { error: 'Too many stats requests' })
        return send(response, 200, statsSnapshot(store.statsRuns, url.searchParams))
      }
      if (request.method === 'GET' && url.pathname === '/api/stats/deck') {
        if (!consume(statsRates, sourceOf(request), CREATE_WINDOW_MS, MAX_STATS_READS_PER_WINDOW)) return send(response, 429, { error: 'Too many stats requests' })
        return send(response, 200, randomDeck(store.statsRuns, url.searchParams))
      }
      if (request.method === 'GET' && url.pathname === '/api/leaderboard') {
        if (leaderboardSummaryRevision !== store.leaderboardRevision) {
          leaderboardSummary = leaderboardSnapshot(store.leaderboardRuns)
          leaderboardSummaryRevision = store.leaderboardRevision
        }
        return send(response, 200, leaderboardSummary)
      }
      if (request.method === 'POST' && url.pathname === '/api/leaderboard') {
        const source = sourceOf(request)
        if (!consume(leaderboardRates, source, CREATE_WINDOW_MS, MAX_LEADERBOARD_WRITES_PER_WINDOW)) {
          return send(response, 429, { error: 'Too many leaderboard submissions' })
        }
        const body = await readJson(request)
        if (typeof body.id === 'string' && body.id.startsWith('room:')) {
          return send(response, 400, { error: 'Run id is reserved for room results' })
        }
        const profile = store.profiles.find((entry) => entry.token === body.profileToken)
        if (body.profileToken && !profile) return send(response, 409, { error: 'Profile unavailable' })
        const { winningDecks: _, ...submission } = body
        const added = addLeaderboardRun(store, { ...submission, username: profile?.username })
        if (added) { queueSave(); scheduleClassification() }
        return send(response, added ? 201 : 200, { ok: true, added, floorsClearedAccepted: true, finalDeckAccepted: true, profileAccepted: true })
      }
      if (request.method === 'POST' && url.pathname === '/api/rooms') {
        sweepRooms()
        const source = sourceOf(request)
        const admitted = consume(createRates, source, CREATE_WINDOW_MS, MAX_CREATES_PER_WINDOW)
        if (!admitted && !consume(entryRetryRates, `${source}:create`, CREATE_WINDOW_MS, MAX_JOINS_PER_WINDOW)) {
          return send(response, 429, { error: 'Too many rooms created' })
        }
        const body = await readJson(request)
        const requestId = requestIdOf(body.requestId)
        if (requestId) {
          for (const existingRoom of store.rooms.values()) {
            const existingSeat = existingRoom.seats.find((seat) => seat.joinRequestId === requestId)
            if (existingSeat) return send(response, 200, {
              token: existingSeat.token, snapshot: snapshotFor(existingRoom, existingSeat.token),
            })
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
          const seat = joinRoom(room, { name: body.name, character: body.character, campaignProgress: body.campaignProgress, connected: false })
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
        if (!mayRead(room, token)) return send(response, 429, { error: 'Rate limit exceeded' })
        return send(response, 200, snapshotFor(room, token))
      }
      if (request.method === 'GET' && operation === 'voice-ice') {
        const token = tokenOf(request)
        if (!findSeat(room, token)) return send(response, 401, { error: 'Unknown seat' })
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
        const requestId = requestIdOf(body.requestId)
        const repeatedSeat = requestId && room.seats.find((seat) => seat.joinRequestId === requestId)
        if (repeatedSeat) return send(response, 200, {
          token: repeatedSeat.token, snapshot: snapshotFor(room, repeatedSeat.token),
        })
        if (!admitted) return send(response, 429, { error: 'Too many join attempts' })
        const token = body.token ?? tokenOf(request)
        if (recoveringRestart(room) && !findSeat(room, token)) {
          return send(response, 409, { error: 'Waiting for every player to reconnect' })
        }
        const live = [...sockets.values()].some((client) => client.code === room.code && client.token === token)
        const beforeVersion = room.version
        const seat = joinRoom(room, {
          name: body.name, character: body.character, campaignProgress: body.campaignProgress,
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
      if (!mayAct(room, token)) return send(response, 429, { error: 'Rate limit exceeded' })
      if (recoveringRestart(room)) return send(response, 409, { error: 'Waiting for every player to reconnect' })
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

  server.on('upgrade', (request, socket, head) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (url.pathname !== '/ws') throw new Error('Not found')
      if (allowedOrigin && request.headers.origin && request.headers.origin !== allowedOrigin) throw new Error('Origin not allowed')
      const source = sourceOf(request)
      const code = codeOf(url.searchParams.get('room') ?? '')
      const room = store.rooms.get(code)
      if (!room) {
        const status = consume(invalidUpgradeRates, source, CREATE_WINDOW_MS, maxUpgradesPerWindow) ? 401 : 429
        socket.write(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Too Many Requests'}\r\nConnection: close\r\n\r\n`)
        return socket.destroy()
      }
      const roomScopedSource = restartRecovery
      const sourceKey = roomScopedSource ? `${source}:${code}` : source
      const tooManyPending = pendingAuth.size >= MAX_PENDING_AUTH
        || [...pendingAuth.values()].filter((pendingSource) => pendingSource === sourceKey).length >= MAX_PENDING_AUTH_PER_IP
      if (tooManyPending || !consume(upgradeRates, sourceKey, CREATE_WINDOW_MS, maxUpgradesPerWindow)) {
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
          if (!client.messageWindowStartedAt || now - client.messageWindowStartedAt >= MESSAGE_WINDOW_MS) {
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
          const replacedSockets = [...sockets].filter(([, other]) =>
            other.code === room.code && other.token === message.token)
          if (replacedSockets.length === 0 && sockets.size >= maxConnections) {
            return socket.close(4009, 'Server connection capacity reached')
          }
          seat = joinRoom(room, {
            token: message.token, campaignProgress: message.campaignProgress,
            settle: !recoveringRestart(room),
          })
          finishRestartRecovery(room, seat)
          client = {
            code: room.code,
            token: message.token,
            playerId: seat.playerId,
          }
          sockets.set(socket, client)
          pendingAuth.delete(socket)
          clearTimeout(authTimer)
          for (const [otherSocket] of replacedSockets) {
            sockets.delete(otherSocket)
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
            const result = applyAndRecord(room, client.token, message.action)
            if (result.changed) {
              touch(room)
              queueSave()
              publish(room, requestId ? client.token : undefined)
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
      classifierClosed = true
      if (classifierTimer) clearTimeout(classifierTimer)
      classifierAbort?.abort()
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
