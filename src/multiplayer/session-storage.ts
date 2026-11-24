import { resetRoomEndpoint, roomUrl } from './room-endpoint.ts'
import type { Credentials, RoomSnapshot } from './room-types.ts'

export const ACTIVE_KEY = 'sts-room-session'
export const RECOVERY_KEY = 'sts-room-recoveries'
export const REFRESH_TIMEOUT_MS = 5_000

export class RequestError extends Error {
  status: number
  snapshot?: RoomSnapshot

  constructor(message: string, status: number, snapshot?: RoomSnapshot) {
    super(message)
    this.status = status
    this.snapshot = snapshot
  }
}

export function savedCredentials(): Credentials | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(ACTIVE_KEY) ?? 'null')
    return typeof saved?.code === 'string' && typeof saved?.token === 'string' ? saved : null
  } catch {
    return null
  }
}

export function savedRecoveries(): Credentials[] {
  try {
    const saved = JSON.parse(localStorage.getItem(RECOVERY_KEY) ?? '[]')
    return Array.isArray(saved)
      ? saved.filter((entry): entry is Credentials => typeof entry?.code === 'string' && typeof entry?.token === 'string')
      : []
  } catch {
    return []
  }
}

export function remember(next: Credentials) {
  const saved = [...savedRecoveries().filter((entry) => entry.token !== next.token), next]
  localStorage.setItem(RECOVERY_KEY, JSON.stringify(saved))
  return saved
}

export function retire(target: Credentials) {
  const saved = savedRecoveries().filter((entry) => entry.token !== target.token)
  if (saved.length) localStorage.setItem(RECOVERY_KEY, JSON.stringify(saved))
  else localStorage.removeItem(RECOVERY_KEY)
  return saved
}

export function savedRoomSessions(): Credentials[] {
  const saved = savedRecoveries()
  const active = savedCredentials()
  return active && !saved.some((entry) => entry.token === active.token) ? [...saved, active] : saved
}

export function hasRoomSession() {
  return savedRoomSessions().length > 0
}

export async function json(response: Response) {
  let body
  try {
    body = await response.json()
  } catch (cause) {
    if (!response.ok) throw new RequestError(`Request failed (${response.status})`, response.status)
    throw cause
  }
  if (!response.ok) throw new RequestError(body?.error ?? `Request failed (${response.status})`, response.status)
  return body
}

export const resetAfterFailure = () => resetRoomEndpoint()

export async function validRoomSessions() {
  const sessions = savedRoomSessions()
  if (sessions.length === 0) return []
  const endpoint = await roomUrl('/api/rooms/')
  const verified = new Set(await Promise.all(sessions.map(async (saved) => {
    try {
      await json(await fetch(`${endpoint}${encodeURIComponent(saved.code)}`, {
        headers: { 'x-room-token': saved.token },
        signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
      }))
      return saved.token
    } catch (cause) {
      if (cause instanceof RequestError && (cause.status === 401 || cause.status === 404)) {
        retire(saved)
        const active = savedCredentials()
        if (active?.token === saved.token && active.code === saved.code) sessionStorage.removeItem(ACTIVE_KEY)
      } else resetAfterFailure()
      return null
    }
  })))
  return savedRoomSessions().filter((saved) => verified.has(saved.token))
}
