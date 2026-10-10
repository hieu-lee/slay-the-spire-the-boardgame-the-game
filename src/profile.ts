import { resetRoomEndpoint, roomUrl } from './multiplayer/room-endpoint.ts'
import type { Wallet } from './wallet.ts'
import type { BossCoinAward } from './game/coins.ts'

export type WalletCredit = { runKey: string; awards: BossCoinAward[]; joinedAfter: number }
export type WalletMigration = { id: string; wallet: Wallet }
export type WalletReply = { wallet: Wallet; purchase?: { ok: boolean; reason?: string } }
export const syncProfileWallet = (profile: Profile, migration: WalletMigration | undefined, credits: WalletCredit[], pack?: string) =>
  post<WalletReply | { registered: false }>('/api/profile/wallet', { token: profile.token, migration, credits, pack }, 'Could not sync your coins. Please try again.')
    .then((reply) => {
      if ('registered' in reply) throw new Error('Your account is not registered on this server. Please log in again.')
      return reply
    })

/** Where the signed-in profile is stored; other modules listen for it in `storage` events. */
export const PROFILE_KEY = 'sts-profile'
const KEY = PROFILE_KEY
const TOKEN_KEY = 'sts-profile-token'
const CLAIM_NAME_KEY = 'sts-profile-claim-name'
const CHANGE_EVENT = 'sts-profile-change'
const REQUEST_TIMEOUT_MS = 5_000
// Both lengths match the server's limits in scripts/lib/profiles.mjs.
export const MIN_PASSWORD_LENGTH = 8
export const MAX_PASSWORD_LENGTH = 128
/** `secured` is set once the account has a password; older profiles are asked for one on the next visit. */
export type Profile = { username: string; token: string; secured?: true }

export type ProfileStats = {
  runs: number
  act3Wins: number
  act4Wins: number
  bestFloors: number
  bestAscensionWon: number | null
  dailyClimbs: number
  firstRunAt: number | null
  heroes: { character: string; runs: number; wins: number }[]
}

/** Usernames compare like the server compares them. */
export const normalizeUsername = (username: string): string => username.normalize('NFKC').trim().toLowerCase()

export function savedProfile(): Profile | null {
  try {
    const profile = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    return typeof profile?.username === 'string' && profile.username.trim().length >= 2 &&
      typeof profile?.token === 'string' && /^[0-9a-f-]{36}$/.test(profile.token) ? profile : null
  } catch { return null }
}

// Play in progress belongs to the account that started it: another account must not resume it.
const ACCOUNT_PLAY_KEYS = ['sts-solo-run', 'sts-room-recoveries']
// The seat a tab is in lives in sessionStorage, not localStorage.
const ACCOUNT_SESSION_KEY = 'sts-room-session'
const clearAccountPlay = () => {
  for (const key of ACCOUNT_PLAY_KEYS) localStorage.removeItem(key)
  sessionStorage.removeItem(ACCOUNT_SESSION_KEY)
}

/** True while this browser holds a saved run or room seat that logging out would discard. */
export const hasAccountPlay = () => ACCOUNT_PLAY_KEYS.some((key) => localStorage.getItem(key) !== null) ||
  sessionStorage.getItem(ACCOUNT_SESSION_KEY) !== null

function saveProfile(profile: Profile) {
  if (savedProfile()?.token !== profile.token) clearAccountPlay()
  localStorage.setItem(KEY, JSON.stringify(profile))
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

/** Calls `listener` whenever the signed-in profile changes in this tab. */
export function onProfileChange(listener: () => void) {
  window.addEventListener(CHANGE_EVENT, listener)
  return () => window.removeEventListener(CHANGE_EVENT, listener)
}

// One retry on a network failure; a 4xx answer is final and its message is shown to the player.
async function post<T>(path: string, body: Record<string, unknown>, failure: string): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let status: number | undefined
    try {
      const response = await fetch(await roomUrl(path), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      status = response.status
      const reply = await response.json()
      if (!response.ok) throw new Error(reply.error ?? failure)
      return reply as T
    } catch (error) {
      const terminal = status !== undefined && status >= 400 && status < 500
      resetRoomEndpoint()
      if (terminal) throw error
      lastError = error
    }
  }
  throw lastError
}

const UNREACHABLE = 'The Spire is out of reach. Please try again.'

/** Creates a new account, or gives an existing name-only profile its first password. */
async function claim(username: string, token: string, password: string): Promise<Profile> {
  const reply = await post<{ username: string }>('/api/profile', { username, token, password }, 'Could not save your account. Please try again.')
  const profile: Profile = { username: reply.username, token, secured: true }
  saveProfile(profile)
  return profile
}

export function registerProfile(username: string, password: string): Promise<Profile> {
  // Persist the claim token first so retrying a lost response cannot strand a name. It is only
  // reused for the same name: another name would be refused, and the token of the profile
  // being replaced would claim the old name.
  const stored = localStorage.getItem(TOKEN_KEY)
  const name = normalizeUsername(username)
  const token = stored && stored !== savedProfile()?.token && localStorage.getItem(CLAIM_NAME_KEY) === name ? stored : crypto.randomUUID()
  localStorage.setItem(TOKEN_KEY, token)
  localStorage.setItem(CLAIM_NAME_KEY, name)
  return claim(username, token, password)
}

export const secureProfile = (profile: Profile, password: string) => claim(profile.username, profile.token, password)

export async function logIn(username: string, password: string): Promise<Profile> {
  const reply = await post<{ username: string; token: string }>('/api/login', { username, password }, UNREACHABLE)
  const profile: Profile = { username: reply.username, token: reply.token, secured: true }
  saveProfile(profile)
  return profile
}

export function logOut() {
  localStorage.removeItem(KEY)
  // A new account must not reuse this account's claim token.
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(CLAIM_NAME_KEY)
  clearAccountPlay()
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

export const loadProfileStats = (profile: Profile) =>
  post<ProfileStats>('/api/profile/stats', { token: profile.token }, 'Could not open your record. Please try again.')
