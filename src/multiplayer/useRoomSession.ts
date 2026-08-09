import { useCallback, useEffect, useRef, useState } from 'react'
import type { CombatPhase } from '../game/combat.ts'
import type { SpireMap } from '../game/map.ts'
import type { CampfireChoice, CardRewardOffer, RunPhase } from '../game/run.ts'
import type { CardInstance, CharacterId, Enemy, Player } from '../game/types.ts'

const ACTIVE_KEY = 'sts-room-session'
const RECOVERY_KEY = 'sts-room-recoveries'

export type PublicSeat = {
  playerId: string
  name: string
  character: CharacterId
  connected: boolean
}

export type VisiblePlayer = Omit<
  Player,
  'deck' | 'draw' | 'hand' | 'cardRewards' | 'rareRewards'
> & {
  deck: CardInstance[] | null
  hand: CardInstance[] | null
  deckCount: number
  drawCount: number
  handCount: number
  cardRewardCount: number
  rareRewardCount: number
}

export type VisibleCombat = {
  turn: number
  die: number
  phase: CombatPhase
  players: VisiblePlayer[]
  enemies: Enemy[]
  log: string[]
}

export type VisibleRun = {
  ascension: number
  act: number
  phase: RunPhase
  map: SpireMap
  log: string[]
  players: VisiblePlayer[]
  combat: VisibleCombat | null
  rewards: CardRewardOffer[]
}

export type RoomSnapshot = {
  code: string
  phase: 'lobby' | 'run'
  ascension: number
  version: number
  you: PublicSeat
  seats: PublicSeat[]
  campfireChoice?: { choice: CampfireChoice; cardUid?: string }
  campfireDecided: string[]
  rewardChoice?: number | null
  rewardDecided: string[]
  rewardConfirmed: string[]
  endTurnDecided: string[]
  discardOrder?: string[]
  run: VisibleRun | null
}

type Credentials = { code: string; token: string }
type JoinOptions = { name: string; character: CharacterId; code?: string }
type Connection = 'idle' | 'connecting' | 'connected' | 'reconnecting'

class RequestError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

function savedCredentials(): Credentials | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(ACTIVE_KEY) ?? 'null')
    return typeof saved?.code === 'string' && typeof saved?.token === 'string' ? saved : null
  } catch {
    return null
  }
}

function savedRecoveries(): Credentials[] {
  try {
    const saved = JSON.parse(localStorage.getItem(RECOVERY_KEY) ?? '[]')
    return Array.isArray(saved)
      ? saved.filter((entry): entry is Credentials => typeof entry?.code === 'string' && typeof entry?.token === 'string')
      : []
  } catch {
    return []
  }
}

function remember(next: Credentials) {
  const saved = [...savedRecoveries().filter((entry) => entry.token !== next.token), next]
  localStorage.setItem(RECOVERY_KEY, JSON.stringify(saved))
  return saved
}

function retire(target: Credentials) {
  const saved = savedRecoveries().filter((entry) => entry.token !== target.token)
  if (saved.length) localStorage.setItem(RECOVERY_KEY, JSON.stringify(saved))
  else localStorage.removeItem(RECOVERY_KEY)
  return saved
}

export function hasRoomSession() {
  return savedCredentials() !== null || savedRecoveries().length > 0
}

async function json(response: Response) {
  const body = await response.json()
  if (!response.ok) throw new RequestError(body.error ?? `Request failed (${response.status})`, response.status)
  return body
}

export function useRoomSession() {
  const [credentials, setCredentials] = useState<Credentials | null>(savedCredentials)
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null)
  const [connection, setConnection] = useState<Connection>(credentials ? 'connecting' : 'idle')
  const [error, setError] = useState('')
  const [entering, setEntering] = useState(false)
  const [recoveries, setRecoveries] = useState(savedRecoveries)
  const enteringRef = useRef(false)
  const mounted = useRef(true)
  const generation = useRef(0)
  const departed = useRef(false)
  const socket = useRef<WebSocket | null>(null)

  useEffect(() => {
    mounted.current = true
    const sync = (event: StorageEvent) => {
      if (event.key === RECOVERY_KEY) setRecoveries(savedRecoveries())
    }
    addEventListener('storage', sync)
    return () => {
      mounted.current = false
      removeEventListener('storage', sync)
    }
  }, [])

  const accept = useCallback((next: RoomSnapshot) => {
    setSnapshot((current) => !current || current.code !== next.code || next.version >= current.version ? next : current)
  }, [])

  const forget = useCallback(() => {
    generation.current += 1
    sessionStorage.removeItem(ACTIVE_KEY)
    setCredentials(null)
    setSnapshot(null)
    setConnection('idle')
    setError('')
  }, [])

  useEffect(() => {
    if (!credentials) return undefined
    let active = true
    let retry: number | undefined
    const connectedGeneration = generation.current

    const connect = async () => {
      setConnection((current) => current === 'connected' ? 'reconnecting' : 'connecting')
      try {
        const restored = await json(await fetch(`/api/rooms/${credentials.code}`, {
          headers: { 'x-room-token': credentials.token },
        })) as RoomSnapshot
        if (!active || generation.current !== connectedGeneration) return
        accept(restored)
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
        const next = new WebSocket(`${protocol}//${location.host}/ws?room=${encodeURIComponent(credentials.code)}`)
        socket.current = next
        next.addEventListener('open', () => {
          if (!active) return next.close()
          next.send(JSON.stringify({ type: 'authenticate', token: credentials.token }))
        })
        next.addEventListener('message', (event) => {
          if (!active || generation.current !== connectedGeneration) return
          try {
            const message = JSON.parse(String(event.data))
            if (message.type === 'snapshot') {
              accept(message.snapshot)
              setConnection('connected')
              setError('')
            } else if (message.type === 'error') setError(message.error)
          } catch {
            next.close(1002, 'Invalid room update')
          }
        })
        next.addEventListener('close', (event) => {
          if (!active || generation.current !== connectedGeneration) return
          if ([1000, 4001, 4003, 4004].includes(event.code)) {
            if (event.code === 1000) {
              departed.current = true
              setRecoveries(retire(credentials))
              forget()
              return
            }
            setConnection('idle')
            setSnapshot(null)
            setError(event.code === 4001 ? 'This seat is open in another tab.' : 'This room session has ended.')
            generation.current += 1
            sessionStorage.removeItem(ACTIVE_KEY)
            setCredentials(null)
            if (event.code === 4003 || event.code === 4004) setRecoveries(retire(credentials))
            return
          }
          setConnection('reconnecting')
          retry = window.setTimeout(connect, 1500)
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
        retry = window.setTimeout(connect, 1500)
      }
    }

    void connect()
    return () => {
      active = false
      if (retry) clearTimeout(retry)
      socket.current?.close()
      socket.current = null
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
    const path = code ? `/api/rooms/${code.trim().toUpperCase()}/join` : '/api/rooms'
    try {
      const body = await json(await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, character }),
      })) as { token: string; snapshot: RoomSnapshot }
      const next = { code: body.snapshot.code, token: body.token }
      if (!mounted.current || generation.current !== enteringGeneration) {
        await fetch(`/api/rooms/${next.code}/leave`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-room-token': next.token },
          body: '{}',
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
    setConnection('connecting')
    setSnapshot(null)
    setCredentials(next)
  }, [])

  const post = useCallback(async (operation: string, body: object, actionGeneration: number) => {
    if (!credentials || generation.current !== actionGeneration) return
    try {
      const next = await json(await fetch(`/api/rooms/${credentials.code}/${operation}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-room-token': credentials.token },
        body: JSON.stringify(body),
      })) as RoomSnapshot
      if (generation.current === actionGeneration) {
        accept(next)
        setError('')
      }
    } catch (cause) {
      if (generation.current === actionGeneration) setError(cause instanceof Error ? cause.message : 'Action failed')
    }
  }, [accept, credentials])

  const writes = useRef({ generation: 0, pending: Promise.resolve() })
  const enqueue = useCallback((operation: string, body: object) => {
    const actionGeneration = generation.current
    if (writes.current.generation !== actionGeneration) {
      writes.current = { generation: actionGeneration, pending: Promise.resolve() }
    }
    const next = writes.current.pending.then(() => post(operation, body, actionGeneration))
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
    try {
      await json(await fetch(`/api/rooms/${credentials.code}/leave`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-room-token': credentials.token },
        body: '{}',
      }))
      setRecoveries(retire(credentials))
      if (generation.current !== leaveGeneration) return departed.current
      forget()
      return true
    } catch (cause) {
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

  const chooseCharacter = useCallback((character: CharacterId) => enqueue('character', { character }), [enqueue])
  const chooseAscension = useCallback((ascension: number) => enqueue('ascension', { ascension }), [enqueue])
  const start = useCallback(() => enqueue('start', {}), [enqueue])
  const act = useCallback((action: object) => enqueue('action', { action }), [enqueue])

  return {
    snapshot,
    connection,
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
    start,
    act,
  }
}
