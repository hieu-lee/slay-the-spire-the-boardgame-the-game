import { resetRoomEndpoint, roomUrl } from './multiplayer/room-endpoint.ts'

const KEY = 'sts-profile'
const TOKEN_KEY = 'sts-profile-token'
const REQUEST_TIMEOUT_MS = 5_000
export type Profile = { username: string; token: string }

export function savedProfile(): Profile | null {
  try {
    const profile = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    return typeof profile?.username === 'string' && profile.username.trim().length >= 2 &&
      typeof profile?.token === 'string' && /^[0-9a-f-]{36}$/.test(profile.token) ? profile : null
  } catch { return null }
}

export async function registerProfile(username: string): Promise<Profile> {
  // Persist the claim token first so retrying a lost response cannot strand a name.
  const token = localStorage.getItem(TOKEN_KEY) ?? crypto.randomUUID()
  localStorage.setItem(TOKEN_KEY, token)
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let endpoint: string | undefined
    let status: number | undefined
    try {
      endpoint = await roomUrl('/api/profile')
      const response = await fetch(endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, token }), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      status = response.status
      const body = await response.json()
      if (!response.ok) throw new Error(body.error ?? 'Could not reserve your name. Please try again.')
      const profile = { username: body.username as string, token }
      localStorage.setItem(KEY, JSON.stringify(profile))
      return profile
    } catch (error) {
      const terminal = status !== undefined && status >= 400 && status < 500
      resetRoomEndpoint(terminal ? undefined : endpoint)
      if (terminal) throw error
      lastError = error
    }
  }
  throw lastError
}
