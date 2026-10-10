// The wallet's home in this browser profile. Guarded like `campaign-storage.ts`:
// blocked or full storage never throws into React, it only stops persisting.
//
// Every change is a read-modify-write of what storage holds now, never of a copy
// kept in memory, so two tabs cannot overwrite each other's coins: a tab that
// credits a boss and a tab that buys a pack both start from the same, latest
// wallet. When storage refuses a write the newer wallet is kept here, for this
// tab, until a later write succeeds.
//
// The wallet belongs to the signed-in account, like the play in progress that
// profile.ts clears on an account change: each account has its own key, and
// playing without an account uses the anonymous one. The first time an account
// has no wallet, it takes over the anonymous wallet — moved, not copied, so a
// second account on the same browser cannot inherit the same coins and packs.
import { MAX_BOSS_AWARDS } from './game/coins.ts'
import type { BossCoinAward } from './game/coins.ts'
import { normalizeUsername, savedProfile, syncProfileWallet } from './profile.ts'
import type { WalletCredit, WalletMigration, WalletReply } from './profile.ts'
import { buyPack, creditBossCoins, creditOncePerBrowser, parsePaidRuns, parseWallet } from './wallet.ts'
import type { PaidRuns, Wallet } from './wallet.ts'

/** The anonymous wallet's key; an account's is `sts-wallet:<username>`. */
export const WALLET_KEY = 'sts-wallet'
/** Fired on `window` after this tab changes the wallet; other tabs hear the `storage` event. */
export const WALLET_EVENT = 'sts-wallet-change'

/** Every run this browser paid, to any account's wallet (see `PaidRuns`). */
export const PAID_RUNS_KEY = 'sts-paid-runs'

/** Where a player's wallet is stored: per account (names compare like the server's), or anonymous. */
export const walletKey = (username: string | null | undefined): string => {
  const name = username ? normalizeUsername(username) : ''
  return name ? `${WALLET_KEY}:${name}` : WALLET_KEY
}

/** The key of the wallet in effect now: the signed-in account's, or the anonymous one. */
export const currentWalletKey = (): string => walletKey(savedProfile()?.username)

/** Hosted accounts use the server wallet; standalone games keep the local wallet. */
export const ACCOUNT_WALLETS = import.meta.env?.VITE_HOSTED_SESSION === 'true' || import.meta.env?.VITE_MAIL === 'true' ||
  import.meta.env?.VITE_COIN_GRANTS === 'true'
type SyncState = { migration?: WalletMigration; migrated: boolean; credits: WalletCredit[] }
const syncMemory = new Map<string, SyncState>()
const syncKey = (key: string) => `${key}:sync`
function syncState(key: string): SyncState {
  if (syncMemory.has(key)) return syncMemory.get(key)!
  try {
    const value = JSON.parse(localStorage.getItem(syncKey(key)) ?? 'null') as SyncState | null
    if (value && typeof value.migrated === 'boolean' && Array.isArray(value.credits)) return value
  } catch { /* Fall back to this tab's pending work. */ }
  return syncMemory.get(key) ?? { migrated: false, credits: [] }
}
function saveSyncState(key: string, value: SyncState) {
  try {
    localStorage.setItem(syncKey(key), JSON.stringify(value))
    syncMemory.delete(key)
  } catch { syncMemory.set(key, value) }
}
function prepareSync(key: string): SyncState {
  const state = syncState(key)
  if (!state.migrated && !state.migration) {
    state.migration = { id: crypto.randomUUID(), wallet: savedWallet() }
    saveSyncState(key, state)
  }
  return state
}
const syncing = new Map<string, Promise<WalletReply>>()

/** Import once, send pending run credits idempotently, and refresh the account cache. */
export async function syncAccountWallet(pack?: string): Promise<WalletReply> {
  const profile = savedProfile()
  if (!ACCOUNT_WALLETS || !profile) return { wallet: savedWallet() }
  const previous = syncing.get(profile.token)
  if (previous) {
    if (pack === undefined) return previous
    await previous
    if (savedProfile()?.token !== profile.token) throw new Error('Your account changed. Please try again.')
    return syncAccountWallet(pack)
  }
  const key = walletKey(profile.username)
  const state = prepareSync(key)
  const pending = { ...state, credits: state.credits.slice(0, 64) }
  const request = syncProfileWallet(profile, pending.migration, pending.credits, pack).then((reply) => {
    if (savedProfile()?.token !== profile.token) throw new Error('Your account changed. Please try again.')
    const latest = syncState(key)
    const remaining = latest.credits.filter((credit) => !pending.credits.some((sent) =>
      sent.runKey === credit.runKey && sent.awards.length >= credit.awards.length))
    // A run may have been recorded while the request was in flight. Keep its
    // pending payment visible until the next request acknowledges it.
    let wallet = parseWallet(reply.wallet)
    for (const credit of remaining) wallet = creditBossCoins(wallet, credit.runKey, credit.awards, credit.joinedAfter).wallet
    updateWallet(() => wallet)
    saveSyncState(key, { migrated: true, credits: remaining })
    return { ...reply, wallet }
  }).finally(() => syncing.delete(profile.token))
  syncing.set(profile.token, request)
  return request
}

/** Account purchases spend the latest server balance, so two devices cannot overspend. */
export async function purchasePack(id: string): Promise<{ ok: boolean; reason?: string }> {
  if (ACCOUNT_WALLETS && savedProfile()) return (await syncAccountWallet(id)).purchase ?? { ok: false }
  let result: ReturnType<typeof buyPack> | undefined
  updateWallet((wallet) => { result = buyPack(wallet, id); return result.wallet })
  return result ?? { ok: false }
}

let unsaved: { key: string; wallet: Wallet } | null = null

const read = (key: string): string | null => {
  try { return localStorage.getItem(key) } catch { return null }
}

/** An account without a wallet adopts the anonymous one, once, by moving it. */
function adoptAnonymousWallet(key: string): void {
  if (key === WALLET_KEY || read(key) !== null) return
  const anonymous = read(WALLET_KEY)
  if (anonymous === null) return
  try {
    localStorage.setItem(key, anonymous)
    localStorage.removeItem(WALLET_KEY)
  } catch { /* Storage is unavailable; the anonymous wallet stays where it is. */ }
}

export function savedWallet(): Wallet {
  const key = currentWalletKey()
  if (unsaved?.key === key) return unsaved.wallet
  adoptAnonymousWallet(key)
  try { return parseWallet(JSON.parse(read(key) ?? 'null')) }
  catch { return parseWallet(null) }
}

/**
 * Applies `change` to the current wallet and stores the result. A change that
 * returns the wallet it was given writes nothing. Returns the wallet now in effect.
 */
export function updateWallet(change: (wallet: Wallet) => Wallet): Wallet {
  flushUnsaved()
  const key = currentWalletKey()
  const current = savedWallet()
  const next = change(current)
  if (next === current) return current
  try {
    localStorage.setItem(key, JSON.stringify(next))
    unsaved = null
  } catch {
    // Storage is unavailable; this tab keeps the wallet in memory.
    unsaved = { key, wallet: next }
  }
  window.dispatchEvent(new Event(WALLET_EVENT))
  return next
}

let unsavedPaid: PaidRuns | null = null

/** Writes whatever an earlier failed write left in memory, now that storage may work again. */
function flushUnsaved(): void {
  if (unsaved) {
    try {
      localStorage.setItem(unsaved.key, JSON.stringify(unsaved.wallet))
      unsaved = null
    } catch { /* Still unavailable. */ }
  }
  if (unsavedPaid && !unsaved) {
    try {
      localStorage.setItem(PAID_RUNS_KEY, JSON.stringify(unsavedPaid))
      unsavedPaid = null
    } catch { /* Still unavailable. */ }
  }
}

function paidRuns(): PaidRuns {
  if (unsavedPaid) return unsavedPaid
  try { return parsePaidRuns(JSON.parse(read(PAID_RUNS_KEY) ?? 'null')) } catch { return {} }
}

/**
 * Pays a run's not-yet-paid boss awards into the signed-in account's wallet,
 * unless this browser already paid them to any account; returns the coins paid
 * and the new balance.
 */
export function creditRunCoins(runKey: string, awards: readonly BossCoinAward[] | undefined, joinedAfter = 0): { coins: number; total: number } {
  // Freeze the pre-sync browser wallet before this payment, so it is never
  // imported and then paid a second time from the pending credit queue.
  const key = currentWalletKey()
  const accountCredit = ACCOUNT_WALLETS && savedProfile() && /^(solo|online):/.test(runKey) && awards?.length && !browserPaidAll(runKey, awards)
  if (accountCredit) {
    const state = prepareSync(key)
    const existing = state.credits.find((entry) => entry.runKey === runKey)
    const credit = { runKey, awards: [...awards!],
      joinedAfter: existing?.joinedAfter ?? Math.max(joinedAfter, paidRuns()[runKey] ?? 0) }
    if (!existing || existing.awards.length < credit.awards.length) {
      state.credits = [...state.credits.filter((entry) => entry.runKey !== runKey), credit]
      saveSyncState(key, state)
    }
  }
  let coins = 0
  let paid: PaidRuns | null = null
  const wallet = updateWallet((current) => {
    const credited = creditOncePerBrowser(current, paidRuns(), runKey, awards, joinedAfter)
    coins = credited.coins
    if (credited.coins > 0) paid = credited.paid
    return credited.wallet
  })
  // The browser record follows the wallet onto disk, never ahead of it: a record of a
  // payment whose wallet write failed would refuse the retry that saves it.
  if (paid) {
    if (unsaved) unsavedPaid = paid
    else {
      try {
        localStorage.setItem(PAID_RUNS_KEY, JSON.stringify(paid))
        unsavedPaid = null
      } catch { unsavedPaid = paid }
    }
  }
  if (accountCredit) void syncAccountWallet().catch(() => {})
  return { coins, total: wallet.coins }
}

/** Whether this browser already paid every award of `awards` for this run key, to any account. */
export function browserPaidAll(runKey: string, awards: readonly BossCoinAward[] | undefined): boolean {
  return (paidRuns()[runKey] ?? 0) >= Math.min(awards?.length ?? 0, MAX_BOSS_AWARDS)
}

/**
 * Remembers, for this tab, which wallet took an online seat (the first time the
 * seat is seen) and answers whether that wallet is still the one signed in. A seat
 * survives a reload in the same tab, so the record lives in sessionStorage. It is
 * keyed by the seat's token, not its player id: joining a room again reuses ids
 * (p1..p4), and whoever then sits there must not inherit an earlier seat's owner.
 */
const seatOwners = new Map<string, string>()
export function claimSeatOwner(seatToken: string): boolean {
  const key = `sts-seat-owner:${seatToken}`
  const current = currentWalletKey()
  let owner = seatOwners.get(key)
  if (owner === undefined) {
    try { owner = sessionStorage.getItem(key) ?? undefined } catch { /* Storage is unavailable. */ }
  }
  if (owner === undefined) {
    owner = current
    try { sessionStorage.setItem(key, owner) } catch { /* Kept in memory for this tab. */ }
  }
  seatOwners.set(key, owner)
  return owner === current
}
