// The coins an account is owed for the runs it recorded before the Shop existed,
// fetched from the room server and paid into this account's wallet once.
//
// Two-phase, so neither a lost response nor a second browser pays it twice: the
// claim id is stored before asking, so a retry after a lost answer reuses the same
// reservation; the wallet is paid under the ledger key `legacy:<username>` (and the
// browser-wide paid-runs record) before the server is told, and only then is the
// grant confirmed spent. A second browser asks with another claim id and is given
// nothing while this one holds the reservation.
import { claimLegacyCoins, confirmLegacyCoins, normalizeUsername, savedProfile } from './profile.ts'
import type { Profile } from './profile.ts'
import { creditRunCoins, storagePersists, walletStoredPaid } from './wallet-storage.ts'

/**
 * Whether this build talks to a room server that hands out the grants: the hosted
 * game, or a local run that opts in (as mail does). Without one there is nothing to
 * ask, and asking would only log a failed request on every visit.
 */
export const COIN_GRANTS = import.meta.env?.VITE_HOSTED_SESSION === 'true' || import.meta.env?.VITE_MAIL === 'true' ||
  import.meta.env?.VITE_COIN_GRANTS === 'true'

const claimKey = (username: string) => `sts-legacy-claim:${normalizeUsername(username)}`
const readClaim = (key: string) => { try { return localStorage.getItem(key) } catch { return null } }

let inFlight: { token: string; result: Promise<{ coins: number; total: number }> } | null = null

/**
 * Pays the signed-in account's past-runs grant, if any. Never throws; returns the
 * coins paid now. Calls made while one is under way share its result, so every
 * caller (a remounted screen too) hears of the payment.
 */
export function settleLegacyCoins(): Promise<{ coins: number; total: number }> {
  const profile = savedProfile()
  if (!profile) return Promise.resolve({ coins: 0, total: 0 })
  if (inFlight?.token === profile.token) return inFlight.result
  const result = settle(profile).finally(() => { if (inFlight?.result === result) inFlight = null })
  inFlight = { token: profile.token, result }
  return result
}

async function settle(profile: Profile): Promise<{ coins: number; total: number }> {
  const key = claimKey(profile.username)
  // A browser that cannot keep the coins (blocked or full storage) must not take the
  // grant: it would vanish with the tab, and the grant can only be claimed once.
  if (!storagePersists()) return { coins: 0, total: 0 }
  try {
    let claimId = readClaim(key)
    if (!claimId) {
      claimId = crypto.randomUUID()
      localStorage.setItem(key, claimId)
    }
    const grant = await claimLegacyCoins(profile, claimId)
    // The account may have changed while the request was out: pay only the one that asked.
    if (savedProfile()?.token !== profile.token) return { coins: 0, total: 0 }
    let paid = { coins: 0, total: 0 }
    if (grant.coins > 0 && grant.grantId) {
      const ledgerKey = `legacy:${normalizeUsername(profile.username)}`
      paid = creditRunCoins(ledgerKey, [{ act: 1, coins: grant.coins }])
      // Confirm only once the coins are really on disk: until then the reservation stays
      // with this browser's claim id, and the next visit pays and confirms it.
      if (!walletStoredPaid(ledgerKey)) return paid
      // The wallet is paid; a failed confirmation only means the next visit confirms it.
      const confirmed = await confirmLegacyCoins(profile, claimId, grant.grantId).catch(() => ({ claimed: false }))
      if (!confirmed.claimed) return paid
    }
    // Spent or nothing owed: a later visit needs no claim id.
    localStorage.removeItem(key)
    return paid
  } catch {
    // Offline, the server is older, or storage is blocked: try again on the next visit.
    return { coins: 0, total: 0 }
  }
}
