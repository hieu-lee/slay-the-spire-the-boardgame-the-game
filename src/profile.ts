import { resetRoomEndpoint, roomUrl } from './multiplayer/room-endpoint.ts'

const KEY = 'sts-profile'
const TOKEN_KEY = 'sts-profile-token'
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
  try {
    const response = await fetch(await roomUrl('/api/profile'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, token }),
    })
    const body = await response.json()
    if (!response.ok) throw new Error(body.error ?? 'Could not reserve your name. Please try again.')
    const profile = { username: body.username as string, token }
    localStorage.setItem(KEY, JSON.stringify(profile))
    return profile
  } catch (error) {
    resetRoomEndpoint()
    throw error
  }
}
