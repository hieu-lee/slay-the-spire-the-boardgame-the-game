import { useCallback, useEffect, useRef, useState } from 'react'
import type { DailyModifierId, RunMetaOptions } from '../game/meta.ts'
import type { CharacterId } from '../game/types.ts'
import { CAMPAIGN_EVENT, campaignKey, savedCampaign, saveAscensionUnlock } from '../campaign-storage.ts'
import { selectedCardPacks } from '../pack-preference.ts'
import { onSkinPreferenceChange, preferredSkin } from '../skin-preference.ts'
import { claimSeatOwner } from '../wallet-storage.ts'
import {
  resetRoomEndpoint,
  roomUrl,
  roomWebSocketUrl,
  supportsEntryRequestIds,
  supportsWebSocketActionAcks,
} from './room-endpoint.ts'
import type {
  ActionOutcome,
  Connection,
  Credentials,
  JoinOptions,
  RoomSnapshot,
  VoiceSignal,
} from './room-types.ts'
import {
  ACTIVE_KEY,
  RECOVERY_KEY,
  REFRESH_TIMEOUT_MS,
  RequestError,
  json,
  remember,
  resetAfterFailure,
  retire,
  savedCredentials,
  savedRecoveries,
  validRoomSessions,
} from './session-storage.ts'

export type {
  ActionOutcome,
  PublicSeat,
  RoomSnapshot,
  VisibleCombat,
  VisiblePlayer,
  VisibleRun,
  VoiceSignal,
} from './room-types.ts'
export { hasRoomSession, validRoomSessions } from './session-storage.ts'

const ACTION_TIMEOUT_MS = 10_000
const LIVENESS_INTERVAL_MS = 10_000
const RECONNECT_MIN_DELAY_MS = 500
const RECONNECT_MAX_DELAY_MS = 1_500

export function useRoomSession() {
  const [credentials, setCredentials] = useState<Credentials | null>(savedCredentials)
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null)
  const [refreshEpoch, setRefreshEpoch] = useState(0)
  const [restorationEpoch, setRestorationEpoch] = useState(0)
  const [connection, setConnection] = useState<Connection>(credentials ? 'connecting' : 'idle')
  const [error, setError] = useState('')
  const [entering, setEntering] = useState(false)
  const [recoveries, setRecoveries] = useState<Credentials[]>([])
  const enteringRef = useRef(false)
  const refreshSequence = useRef(0)
  const reconciliation = useRef({ generation: -1, target: 0, running: false })
  const connectionRef = useRef(connection)
  const connectionEpoch = useRef(0)
  const mounted = useRef(true)
  const generation = useRef(0)
  const departed = useRef(false)
  const socket = useRef<WebSocket | null>(null)
  const acknowledgedSockets = useRef(new WeakSet<WebSocket>())
  const socketActions = useRef(new Map<string, {
    resolve: (snapshot: RoomSnapshot) => void
    reject: (cause: Error) => void
    timeout: number
  }>())
  const snapshotRef = useRef<RoomSnapshot | null>(null)
  const voiceListeners = useRef(new Set<(message: VoiceSignal) => void>())
  connectionRef.current = connection

  const rejectSocketActions = (cause: Error) => {
    for (const pending of socketActions.current.values()) {
      clearTimeout(pending.timeout)
      pending.reject(cause)
    }
    socketActions.current.clear()
  }

  useEffect(() => {
    mounted.current = true
    let active = true
    let sequence = 0
    const refresh = () => {
      const request = ++sequence
      void validRoomSessions().then((valid) => {
        if (!active || request !== sequence) return
        const tokens = new Set(valid.map((saved) => saved.token))
        setRecoveries(savedRecoveries().filter((saved) => tokens.has(saved.token)))
      }, () => { if (active && request === sequence) setRecoveries([]) })
    }
    const refreshVisible = () => { if (document.visibilityState === 'visible') refresh() }
    const sync = (event: StorageEvent) => {
      if (event.key === RECOVERY_KEY || event.key === null) refresh()
    }
    refresh()
    addEventListener('storage', sync)
    addEventListener('focus', refreshVisible)
    addEventListener('online', refreshVisible)
    document.addEventListener('visibilitychange', refreshVisible)
    const timer = window.setInterval(() => { if (!savedCredentials()) refreshVisible() }, 60_000)
    return () => {
      active = false
      mounted.current = false
      clearInterval(timer)
      removeEventListener('storage', sync)
      removeEventListener('focus', refreshVisible)
      removeEventListener('online', refreshVisible)
      document.removeEventListener('visibilitychange', refreshVisible)
    }
  }, [])

  const accept = useCallback((next: RoomSnapshot) => {
    const current = snapshotRef.current
    if (current && current.code === next.code && next.epoch === current.epoch &&
      next.version < current.version) return false
    const received = next.giveUpVote ? {
      ...next,
      giveUpVote: { ...next.giveUpVote, receivedAt: performance.now() },
    } : next
    snapshotRef.current = received
    setSnapshot(received)
    return !current || current.code !== next.code || next.epoch !== current.epoch || next.version > current.version
  }, [])

  const reconcileUnknown = useCallback((target: number, actionGeneration: number, activeCredentials: Credentials) => {
    if (reconciliation.current.generation !== actionGeneration) {
      reconciliation.current = { generation: actionGeneration, target, running: false }
    } else reconciliation.current.target = Math.max(reconciliation.current.target, target)
    if (reconciliation.current.running) return
    reconciliation.current.running = true
    void (async () => {
      let delay = 1_000
      while (mounted.current && generation.current === actionGeneration && reconciliation.current.target > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay))
        if (!mounted.current || generation.current !== actionGeneration) break
        const refreshId = ++refreshSequence.current
        let endpoint: string | undefined
        try {
          endpoint = await roomUrl(`/api/rooms/${activeCredentials.code}`)
          const latest = await json(await fetch(endpoint, {
            headers: { 'x-room-token': activeCredentials.token },
            signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
          })) as RoomSnapshot
          if (generation.current !== actionGeneration) break
          if (accept(latest)) setRestorationEpoch((current) => current + 1)
          setRefreshEpoch((current) => Math.max(current, refreshId))
          if (refreshId > reconciliation.current.target) reconciliation.current.target = 0
          delay = 1_000
        } catch {
          resetAfterFailure()
          delay = Math.min(delay * 2, 5_000)
        }
      }
      if (reconciliation.current.generation === actionGeneration) reconciliation.current.running = false
    })()
  }, [accept])

  /** Replaces the local snapshot with the server's, even if it looks older. */
  const resync = useCallback(async () => {
    if (!credentials) return
    const resyncGeneration = generation.current
    const before = snapshotRef.current
    try {
      const latest = await json(await fetch(await roomUrl(`/api/rooms/${credentials.code}`), {
        headers: { 'x-room-token': credentials.token },
        signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
      })) as RoomSnapshot
      if (generation.current !== resyncGeneration) return
      // A pushed frame that arrived meanwhile is newer than this GET.
      if (snapshotRef.current === before) {
        snapshotRef.current = null
        accept(latest)
      }
      setRestorationEpoch((current) => current + 1)
    } catch {
      resetAfterFailure()
    }
  }, [accept, credentials])

  const forget = useCallback((retireRecovery = false) => {
    generation.current += 1
    sessionStorage.removeItem(ACTIVE_KEY)
    if (retireRecovery && credentials) setRecoveries(retire(credentials))
    setCredentials(null)
    setSnapshot(null)
    connectionRef.current = 'idle'
    setConnection('idle')
    setError('')
  }, [credentials])

  useEffect(() => {
    if (!credentials) return undefined
    let active = true
    let retry: number | undefined
    let retryDelay = RECONNECT_MIN_DELAY_MS
    let livenessTimer: number | undefined
    const connectedGeneration = generation.current
    const retryConnection = (callback: () => void) => {
      retry = window.setTimeout(callback, retryDelay)
      retryDelay = Math.min(retryDelay * 2, RECONNECT_MAX_DELAY_MS)
    }

    const connect = async () => {
      connectionRef.current = connectionRef.current === 'connected' ? 'reconnecting' : 'connecting'
      setConnection((current) => current === 'connected' ? 'reconnecting' : 'connecting')
      const refreshId = ++refreshSequence.current
      let endpoint: string | undefined
      try {
        endpoint = await roomUrl(`/api/rooms/${credentials.code}`)
        const restored = await json(await fetch(endpoint, {
          headers: { 'x-room-token': credentials.token },
          signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
        })) as RoomSnapshot
        if (!active || generation.current !== connectedGeneration) return
        if (accept(restored)) setRestorationEpoch((current) => current + 1)
        setRefreshEpoch((current) => Math.max(current, refreshId))
        const socketUrl = await roomWebSocketUrl(credentials.code)
        const next = new WebSocket(socketUrl)
        if (supportsWebSocketActionAcks()) acknowledgedSockets.current.add(next)
        socket.current = next
        let connectionTimeout: number | undefined
        const reconnect = () => {
          if (!active || generation.current !== connectedGeneration || socket.current !== next) return
          if (connectionTimeout) clearTimeout(connectionTimeout)
          if (livenessTimer) clearTimeout(livenessTimer)
          livenessTimer = undefined
          rejectSocketActions(new Error('Connection lost'))
          socket.current = null
          connectionRef.current = 'reconnecting'
          setConnection('reconnecting')
          resetRoomEndpoint()
          next.close(4000, 'Connection lost')
          retryConnection(connect)
        }
        const probe = async () => {
          livenessTimer = undefined
          let probeEndpoint: string | undefined
          try {
            probeEndpoint = await roomUrl(`/api/rooms/${credentials.code}`)
            const latest = await json(await fetch(probeEndpoint, {
              headers: { 'x-room-token': credentials.token },
              signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
            })) as RoomSnapshot
            if (!active || socket.current !== next) return
            if (!latest.you.connected) return reconnect()
            if (accept(latest)) setRestorationEpoch((current) => current + 1)
            livenessTimer ??= window.setTimeout(probe, LIVENESS_INTERVAL_MS)
          } catch {
            if (!active || socket.current !== next) return
            livenessTimer ??= window.setTimeout(probe, LIVENESS_INTERVAL_MS)
          }
        }
        connectionTimeout = window.setTimeout(reconnect, ACTION_TIMEOUT_MS)
        next.addEventListener('open', () => {
          if (!active || socket.current !== next) return next.close()
          next.send(JSON.stringify({ type: 'authenticate', token: credentials.token, campaignProgress: savedCampaign(),
            cardPacks: selectedCardPacks() }))
        })
        next.addEventListener('message', (event) => {
          if (!active || generation.current !== connectedGeneration || socket.current !== next) return
          try {
            const message = JSON.parse(String(event.data))
            if (message.type === 'snapshot') {
              clearTimeout(connectionTimeout)
              livenessTimer ??= window.setTimeout(probe, LIVENESS_INTERVAL_MS)
              accept(message.snapshot)
              if (connectionRef.current !== 'connected') connectionEpoch.current += 1
              connectionRef.current = 'connected'
              setConnection('connected')
              setError('')
              retryDelay = RECONNECT_MIN_DELAY_MS
              const pending = socketActions.current.get(message.requestId)
              if (pending) {
                clearTimeout(pending.timeout)
                socketActions.current.delete(message.requestId)
                pending.resolve(message.snapshot)
              }
            } else if (message.type === 'voice' && message.signal && typeof message.signal === 'object' && !Array.isArray(message.signal)) {
              for (const listener of voiceListeners.current) listener(message)
            } else if (message.type === 'error') {
              const pending = socketActions.current.get(message.requestId)
              if (pending) {
                clearTimeout(pending.timeout)
                socketActions.current.delete(message.requestId)
                if (message.snapshot && accept(message.snapshot)) setRestorationEpoch((current) => current + 1)
                pending.reject(new RequestError(message.error, message.status ?? 409, message.snapshot))
              } else setError(message.error)
            }
          } catch {
            next.close(1002, 'Invalid room update')
          }
        })
        next.addEventListener('close', (event) => {
          if (connectionTimeout) clearTimeout(connectionTimeout)
          if (livenessTimer) clearTimeout(livenessTimer)
          livenessTimer = undefined
          if (!active || generation.current !== connectedGeneration || socket.current !== next) return
          rejectSocketActions(new Error('Connection lost'))
          if ([1000, 4001, 4003, 4004].includes(event.code)) {
            if (event.code === 1000) {
              departed.current = true
              setRecoveries(retire(credentials))
              forget()
              return
            }
            connectionRef.current = 'idle'
            setConnection('idle')
            setSnapshot(null)
            setError(event.code === 4001 ? 'This seat is open in another tab.' : 'This room session has ended.')
            generation.current += 1
            sessionStorage.removeItem(ACTIVE_KEY)
            setCredentials(null)
            if (event.code === 4003 || event.code === 4004) setRecoveries(retire(credentials))
            return
          }
          reconnect()
        })
      } catch (cause) {
        if (!active || generation.current !== connectedGeneration) return
        if (cause instanceof RequestError && (cause.status === 401 || cause.status === 404)) {
          generation.current += 1
          sessionStorage.removeItem(ACTIVE_KEY)
          setRecoveries(retire(credentials))
          setCredentials(null)
          setSnapshot(null)
          setConnection('idle')
          setError('This room session has ended.')
          return
        }
        setError(cause instanceof Error ? cause.message : 'Could not connect')
        setConnection('reconnecting')
        resetAfterFailure()
        retryConnection(connect)
      }
    }

    void connect()
    return () => {
      active = false
      if (retry) clearTimeout(retry)
      if (livenessTimer) clearTimeout(livenessTimer)
      socket.current?.close()
      socket.current = null
      rejectSocketActions(new Error('Room session changed'))
    }
  }, [accept, credentials, forget])

  const enter = useCallback(async ({ name, character, code }: JoinOptions) => {
    if (enteringRef.current) return
    const enteringGeneration = ++generation.current
    departed.current = false
    enteringRef.current = true
    setEntering(true)
    setSnapshot(null)
    setError('')
    resetRoomEndpoint()
    const path = code ? `/api/rooms/${code.trim().toUpperCase()}/join` : '/api/rooms'
    const requestId = crypto.randomUUID()
    let body: { token: string; snapshot: RoomSnapshot } | undefined
    let lastError: unknown
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let endpoint: string | undefined
        let retrySafe = false
        try {
          endpoint = await roomUrl(path)
          retrySafe = supportsEntryRequestIds()
          body = await json(await fetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name, character, skin: character ? preferredSkin(character) : undefined, requestId, campaignProgress: savedCampaign(), cardPacks: selectedCardPacks() }),
            signal: AbortSignal.timeout(ACTION_TIMEOUT_MS),
          })) as { token: string; snapshot: RoomSnapshot }
          break
        } catch (cause) {
          resetAfterFailure()
          if (cause instanceof RequestError && cause.status < 500) throw cause
          lastError = cause
          if (!retrySafe) break
        }
      }
      if (!body) throw lastError
      const next = { code: body.snapshot.code, token: body.token }
      if (!mounted.current || generation.current !== enteringGeneration) {
        await fetch(await roomUrl(`/api/rooms/${next.code}/leave`), {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-room-token': next.token },
          body: '{}',
          signal: AbortSignal.timeout(ACTION_TIMEOUT_MS),
        }).catch(() => {})
        return
      }
      sessionStorage.setItem(ACTIVE_KEY, JSON.stringify(next))
      setRecoveries(remember(next))
      accept(body.snapshot)
      setCredentials(next)
    } catch (cause) {
      if (mounted.current && generation.current === enteringGeneration) {
        setError(cause instanceof Error ? cause.message : 'Could not enter room')
      }
    } finally {
      enteringRef.current = false
      if (mounted.current) setEntering(false)
    }
  }, [accept])

  const resume = useCallback((next: Credentials) => {
    if (enteringRef.current) return
    generation.current += 1
    departed.current = false
    sessionStorage.setItem(ACTIVE_KEY, JSON.stringify(next))
    setError('')
    connectionRef.current = 'connecting'
    setConnection('connecting')
    setSnapshot(null)
    setCredentials(next)
  }, [])

  const post = useCallback(async (
    operation: string, body: object, actionGeneration: number,
  ): Promise<ActionOutcome> => {
    if (!credentials || generation.current !== actionGeneration) return { status: 'unknown' } satisfies ActionOutcome
    let endpoint: string | undefined
    try {
      let next: RoomSnapshot
      const activeSocket = socket.current
      if (operation === 'action' && activeSocket?.readyState === WebSocket.OPEN && acknowledgedSockets.current.has(activeSocket)) {
        next = await new Promise<RoomSnapshot>((resolve, reject) => {
          const requestId = crypto.randomUUID()
          const timeout = window.setTimeout(() => {
            socketActions.current.delete(requestId)
            if (socket.current === activeSocket) activeSocket.close(4000, 'Action timed out')
            reject(new Error('Action timed out'))
          }, ACTION_TIMEOUT_MS)
          socketActions.current.set(requestId, { resolve, reject, timeout })
          try {
            activeSocket.send(JSON.stringify({ type: 'action', requestId, ...body }))
          } catch (cause) {
            clearTimeout(timeout)
            socketActions.current.delete(requestId)
            reject(cause)
          }
        })
      } else {
        endpoint = await roomUrl(`/api/rooms/${credentials.code}/${operation}`)
        const reply: RoomSnapshot | { snapshot: RoomSnapshot } = await json(await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-room-token': credentials.token },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(ACTION_TIMEOUT_MS),
        }))
        next = 'snapshot' in reply ? reply.snapshot : reply
      }
      if (generation.current === actionGeneration) {
        accept(next)
        setError('')
      }
      return { status: 'accepted', snapshot: next } satisfies ActionOutcome
    } catch (cause) {
      if (generation.current === actionGeneration) setError(cause instanceof Error ? cause.message : 'Action failed')
      if (cause instanceof RequestError && cause.status >= 400 && cause.status < 500 && cause.snapshot) {
        return { status: 'refused', snapshot: cause.snapshot } satisfies ActionOutcome
      }
      resetAfterFailure()
      let refreshAttempt: number | undefined
      if (generation.current === actionGeneration) {
        for (const delay of [0, 150, 500]) {
          if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
          if (generation.current !== actionGeneration) break
          const refreshId = ++refreshSequence.current
          refreshAttempt ??= refreshId
          let refreshEndpoint: string | undefined
          try {
            refreshEndpoint = await roomUrl(`/api/rooms/${credentials.code}`)
            const latest = await json(await fetch(refreshEndpoint, {
              headers: { 'x-room-token': credentials.token },
              signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
            })) as RoomSnapshot
            if (generation.current === actionGeneration) {
              if (accept(latest)) setRestorationEpoch((current) => current + 1)
              setRefreshEpoch((current) => Math.max(current, refreshId))
            }
            return {
              status: cause instanceof RequestError && cause.status >= 400 && cause.status < 500 ? 'refused' : 'reconciled',
              snapshot: latest,
            } satisfies ActionOutcome
          } catch {
            resetAfterFailure()
            // A 4xx mutation response proves refusal even if its refresh fails —
            // but a refusal can still have changed the room, and the server sends
            // that change to the other seats only, so keep reconciling in the
            // background rather than leaving this client on a stale snapshot.
            if (cause instanceof RequestError && cause.status >= 400 && cause.status < 500) {
              reconcileUnknown(refreshAttempt, actionGeneration, credentials)
              return { status: 'refused' } satisfies ActionOutcome
            }
          }
        }
      }
      if (refreshAttempt !== undefined) reconcileUnknown(refreshAttempt, actionGeneration, credentials)
      return { status: 'unknown', refreshAttempt } satisfies ActionOutcome
    }
  }, [accept, credentials, reconcileUnknown])

  const writes = useRef<{ generation: number; pending: Promise<unknown> }>({
    generation: 0,
    pending: Promise.resolve(),
  })
  const pendingWrites = useRef(0)
  const [mutationPending, setMutationPending] = useState(false)
  const enqueue = useCallback((operation: string, body: object | (() => object)) => {
    if (connectionRef.current !== 'connected') return Promise.resolve({ status: 'refused' } satisfies ActionOutcome)
    const actionGeneration = generation.current
    const actionConnectionEpoch = connectionEpoch.current
    if (writes.current.generation !== actionGeneration) {
      writes.current = { generation: actionGeneration, pending: Promise.resolve() }
    }
    const next = writes.current.pending.then(() => connectionRef.current === 'connected' && connectionEpoch.current === actionConnectionEpoch
      ? post(operation, typeof body === 'function' ? body() : body, actionGeneration)
      : { status: 'refused' } satisfies ActionOutcome)
    pendingWrites.current++
    setMutationPending(true)
    const settled = () => {
      pendingWrites.current--
      if (pendingWrites.current === 0) setMutationPending(false)
    }
    void next.then(settled, settled)
    writes.current = { generation: actionGeneration, pending: next.catch(() => {}) }
    return next
  }, [post])

  const leave = useCallback(async () => {
    if (!credentials) {
      forget()
      return true
    }
    const leaveGeneration = generation.current
    departed.current = false
    let endpoint: string | undefined
    try {
      endpoint = await roomUrl(`/api/rooms/${credentials.code}/leave`)
      await json(await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-room-token': credentials.token },
        body: '{}',
        signal: AbortSignal.timeout(ACTION_TIMEOUT_MS),
      }))
      setRecoveries(retire(credentials))
      if (generation.current !== leaveGeneration) return departed.current
      forget()
      return true
    } catch (cause) {
      resetAfterFailure()
      if (cause instanceof RequestError && (cause.status === 401 || cause.status === 404)) {
        setRecoveries(retire(credentials))
        if (generation.current !== leaveGeneration) return departed.current
        forget()
        return true
      }
      if (generation.current !== leaveGeneration) return departed.current
      setError(cause instanceof Error ? cause.message : 'Could not leave room')
      return false
    }
  }, [credentials, forget])

  const chooseCharacter = useCallback((character: CharacterId) =>
    enqueue('character', { character, skin: preferredSkin(character) ?? null }), [enqueue])
  // The lobby seat wears what the account chose in Profile: pushed once per change, so a server
  // that does not know skins (and never echoes one back) cannot make this resend forever.
  const [skinChoiceTick, setSkinChoiceTick] = useState(0)
  useEffect(() => onSkinPreferenceChange(() => setSkinChoiceTick((tick) => tick + 1)), [])
  const sentSkin = useRef('')
  const lobbySeat = snapshot?.phase === 'lobby' ? snapshot.you : undefined
  const lobbyCode = snapshot?.code
  useEffect(() => {
    if (!lobbySeat || !lobbyCode) return
    const wanted = preferredSkin(lobbySeat.character)
    if (lobbySeat.skin === wanted) return
    const key = `${lobbyCode}:${lobbySeat.character}:${wanted ?? ''}`
    if (sentSkin.current === key) return
    sentSkin.current = key
    void enqueue('character', { character: lobbySeat.character, skin: wanted ?? null })
  }, [lobbySeat?.character, lobbySeat?.skin, lobbyCode, skinChoiceTick, enqueue])
  const chooseAscension = useCallback((ascension: number) => enqueue('ascension', { ascension }), [enqueue])
  // Resolved when the write is sent, so quick repeated steps compose instead of
  // each re-sending the level that was on screen when it was clicked.
  const stepAscension = useCallback((delta: -1 | 1) => enqueue('ascension', () => {
    const current = snapshotRef.current
    const highest = current?.campaignProgress.highestAscension ?? 0
    return { ascension: Math.max(0, Math.min(highest, (current?.ascension ?? 0) + delta)) }
  }), [enqueue])
  const chooseRelicRule = useCallback((enabled: boolean) => enqueue('relic-rule', { enabled }), [enqueue])
  const chooseLastStandRule = useCallback((enabled: boolean) => enqueue('last-stand-rule', { enabled }), [enqueue])
  const chooseRunMeta = useCallback((options: Partial<RunMetaOptions>) => enqueue('run-meta', () => ({
    ...snapshotRef.current?.metaOptions,
    ...options,
  })), [enqueue])
  const chooseRunModifier = useCallback((id: DailyModifierId, enabled: boolean) => enqueue('run-meta', () => {
    const current = snapshotRef.current?.metaOptions ?? { mode: 'custom', modifiers: [], quickStartAct: 1 }
    return { ...current, modifiers: enabled
      ? current.modifiers.includes(id) ? current.modifiers : [...current.modifiers, id]
      : current.modifiers.filter((candidate) => candidate !== id) }
  }), [enqueue])
  const selectCampaign = useCallback((enabled: boolean) => enqueue('campaign-select', { enabled }), [enqueue])
  const start = useCallback((campaign: 'base' | 'downfall') => enqueue('start', { campaign }), [enqueue])
  const act = useCallback((action: object) => enqueue('action', { action }), [enqueue])
  const sendVoiceSignal = useCallback((to: string, signal: VoiceSignal['signal']) => {
    if (socket.current?.readyState !== WebSocket.OPEN) return false
    socket.current.send(JSON.stringify({ type: 'voice', to, signal }))
    return true
  }, [])
  const onVoiceSignal = useCallback((listener: (message: VoiceSignal) => void) => {
    voiceListeners.current.add(listener)
    return () => { voiceListeners.current.delete(listener) }
  }, [])
  const loadVoiceIceServers = useCallback(async () => {
    if (!credentials) throw new Error('Room is not connected')
    const voiceGeneration = generation.current
    let lastError: unknown
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let endpoint: string | undefined
      try {
        endpoint = await roomUrl(`/api/rooms/${credentials.code}/voice-ice`)
        const body = await json(await fetch(endpoint, {
          headers: { 'x-room-token': credentials.token }, signal: AbortSignal.timeout(ACTION_TIMEOUT_MS),
        })) as { iceServers: RTCIceServer[] }
        if (generation.current !== voiceGeneration) throw new Error('Room session changed')
        return body.iceServers
      } catch (cause) {
        if (generation.current !== voiceGeneration) throw cause
        if (cause instanceof RequestError && cause.status < 500) throw cause
        resetAfterFailure()
        lastError = cause
      }
    }
    throw lastError
  }, [credentials])

  // Whether the account that took this seat in this tab is still the one signed in,
  // so the seat's coins go to it alone; the seat token stays inside this hook.
  const seatOwnsCoins = snapshot && credentials?.code === snapshot.code ? claimSeatOwner(credentials.token) : false

  useEffect(() => {
    if (seatOwnsCoins && snapshot?.earnedAscension !== undefined) saveAscensionUnlock(snapshot.earnedAscension)
  }, [seatOwnsCoins, snapshot?.earnedAscension])

  useEffect(() => {
    if (!credentials || connection !== 'connected' || snapshot?.phase !== 'lobby') return
    let reported = -1
    const refresh = () => {
      if (!claimSeatOwner(credentials.token)) return
      const progress = savedCampaign()
      if (progress.highestAscension === reported) return
      reported = progress.highestAscension
      void enqueue('join', { campaignProgress: progress }).then((outcome) => {
        if (outcome.status !== 'accepted') reported = -1
      })
    }
    const storage = (event: StorageEvent) => { if (event.key === campaignKey() || event.key === null) refresh() }
    refresh()
    window.addEventListener(CAMPAIGN_EVENT, refresh)
    window.addEventListener('storage', storage)
    window.addEventListener('focus', refresh)
    window.addEventListener('online', refresh)
    return () => {
      window.removeEventListener(CAMPAIGN_EVENT, refresh)
      window.removeEventListener('storage', storage)
      window.removeEventListener('focus', refresh)
      window.removeEventListener('online', refresh)
    }
  }, [credentials, connection, snapshot?.phase, enqueue])

  return {
    snapshot,
    seatOwnsCoins,
    refreshEpoch,
    restorationEpoch,
    resync,
    connection,
    mutationPending,
    error,
    entering,
    activeCode: credentials?.code,
    recoveries,
    enter,
    resume,
    leave,
    forget,
    chooseCharacter,
    chooseAscension,
    stepAscension,
    chooseRelicRule,
    chooseLastStandRule,
    chooseRunMeta,
    chooseRunModifier,
    start,
    selectCampaign,
    act,
    sendVoiceSignal,
    onVoiceSignal,
    loadVoiceIceServers,
  }
}
