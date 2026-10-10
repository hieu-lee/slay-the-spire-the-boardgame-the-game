// The Shop wallet: the coins a browser profile has earned from boss victories,
// the card packs and skins it bought with them, and the ledger that makes earning exactly
// once per boss. Pure data and functions — `wallet-storage.ts` owns the
// localStorage side, so everything here is testable straight from Node.
//
// Earning is idempotent per run. The ledger maps a run's key to how many of
// that run's boss awards (`RunState.campaign.bossCoins`) were already paid, so a
// reload, a resumed solo run, an online reconnect or a second look at the same
// snapshot never pays the same boss twice. The ledger keeps only the most recent
// runs: a run that has fallen out of it is long finished, and a finished run's
// awards never grow again.
import { CARD_PACK_PRICE, MAX_BOSS_AWARDS, SKIN_PRICES } from './game/coins.ts'
import type { BossCoinAward } from './game/coins.ts'
import { isCardPackId, normalizeCardPacks } from './game/packs.ts'
import type { CardPackId } from './game/packs.ts'
import { isSkinId, normalizeSkins } from './game/skins.ts'
import type { SkinId } from './game/skins.ts'

export type Wallet = {
  version: 1
  coins: number
  /** Bought packs, in catalogue order. */
  packs: CardPackId[]
  /** Bought skins, in catalogue order. Wearing one is a separate choice (`skin-preference.ts`). */
  skins: SkinId[]
  /**
   * Whether bought packs join new runs. Always true for now: there is no
   * control for it yet, only `setAddPacksToRuns` for a future setting.
   */
  addPacksToRuns: boolean
  /** Run key → how many of that run's boss awards were already paid out. */
  credited: Record<string, number>
}

/** Runs remembered by the ledger; the oldest drop out first. */
export const MAX_CREDITED_RUNS = 64
/** A ledger key longer than this is not one this client wrote. */
export const MAX_RUN_KEY_LENGTH = 160
/** A balance no honest wallet reaches; anything above it in storage is corrupt. */
export const MAX_WALLET_COINS = 100_000_000

export function createWallet(): Wallet {
  return { version: 1, coins: 0, packs: [], skins: [], addPacksToRuns: true, credited: {} }
}

const count = (value: unknown, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max

/**
 * Untrusted storage to a wallet. Anything unreadable becomes the empty wallet,
 * but a readable wallet keeps every field that is valid on its own: one bad
 * ledger entry must not cost the player their coins or their packs.
 */
export function parseWallet(value: unknown): Wallet {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return createWallet()
  const saved = value as Partial<Record<keyof Wallet, unknown>>
  if (saved.version !== 1) return createWallet()
  const ledger = saved.credited && typeof saved.credited === 'object' && !Array.isArray(saved.credited)
    ? Object.entries(saved.credited as Record<string, unknown>)
      .filter((entry): entry is [string, number] => entry[0].length > 0 && entry[0].length <= MAX_RUN_KEY_LENGTH &&
        count(entry[1], MAX_BOSS_AWARDS))
      .slice(-MAX_CREDITED_RUNS)
    : []
  return {
    version: 1,
    coins: count(saved.coins, MAX_WALLET_COINS) ? saved.coins : 0,
    packs: normalizeCardPacks(saved.packs),
    skins: normalizeSkins(saved.skins),
    addPacksToRuns: typeof saved.addPacksToRuns === 'boolean' ? saved.addPacksToRuns : true,
    credited: Object.fromEntries(ledger),
  }
}

/**
 * The browser's own record of what each run already paid, whoever was signed in:
 * run key → awards paid. A run's coins land in one wallet per browser, so
 * switching accounts can never claim the same run again. Bounded like the ledger.
 */
export type PaidRuns = Record<string, number>
export const MAX_PAID_RUNS = 256

export function parsePaidRuns(value: unknown): PaidRuns {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, number] => entry[0].length > 0 && entry[0].length <= MAX_RUN_KEY_LENGTH &&
      count(entry[1], MAX_BOSS_AWARDS))
    .slice(-MAX_PAID_RUNS))
}

/**
 * Credits a run into `wallet` unless this browser already paid those awards to any
 * wallet. Returns the new wallet and browser record, or the same objects when
 * nothing is owed.
 */
export function creditOncePerBrowser(wallet: Wallet, paid: PaidRuns, runKey: string,
  awards: readonly BossCoinAward[] | undefined, joinedAfter = 0): { wallet: Wallet; paid: PaidRuns; coins: number } {
  const already = paid[runKey] ?? 0
  const seeded = already > (wallet.credited[runKey] ?? 0)
    ? { ...wallet, credited: { ...wallet.credited, [runKey]: already } } : wallet
  const credited = creditBossCoins(seeded, runKey, awards, joinedAfter)
  if (credited.wallet === seeded) return { wallet, paid, coins: 0 }
  const { [runKey]: _previous, ...others } = paid
  const record = Object.fromEntries([...Object.entries(others), [runKey, credited.wallet.credited[runKey]!] as const].slice(-MAX_PAID_RUNS))
  return { wallet: credited.wallet, paid: record, coins: credited.coins }
}

/** Coins still missing before something of this price can be bought; 0 when it is affordable. */
export const coinsShort = (wallet: Wallet, price: number = CARD_PACK_PRICE): number => Math.max(0, price - wallet.coins)

export const ownsPack = (wallet: Wallet, id: CardPackId): boolean => wallet.packs.includes(id)
export const ownsSkin = (wallet: Wallet, id: SkinId): boolean => wallet.skins.includes(id)

/** Coins the wallet's purchases cost: what migrating a wallet must not hand back. */
export const spentCoins = (wallet: Wallet): number =>
  wallet.packs.length * CARD_PACK_PRICE + wallet.skins.reduce((sum, id) => sum + SKIN_PRICES[id], 0)

export type PurchaseRefusal = 'unknown' | 'owned' | 'insufficient'
export type PurchaseResult = { ok: true; wallet: Wallet } | { ok: false; reason: PurchaseRefusal; wallet: Wallet }

/** Spends `CARD_PACK_PRICE` on a pack the wallet does not own yet. A refusal returns the wallet unchanged. */
export function buyPack(wallet: Wallet, id: unknown): PurchaseResult {
  if (!isCardPackId(id)) return { ok: false, reason: 'unknown', wallet }
  if (ownsPack(wallet, id)) return { ok: false, reason: 'owned', wallet }
  if (wallet.coins < CARD_PACK_PRICE) return { ok: false, reason: 'insufficient', wallet }
  return {
    ok: true,
    wallet: { ...wallet, coins: wallet.coins - CARD_PACK_PRICE, packs: normalizeCardPacks([...wallet.packs, id]) },
  }
}

/** Spends the skin's catalogue price on a skin the wallet does not own yet. A refusal returns the wallet unchanged. */
export function buySkin(wallet: Wallet, id: unknown): PurchaseResult {
  if (!isSkinId(id)) return { ok: false, reason: 'unknown', wallet }
  if (ownsSkin(wallet, id)) return { ok: false, reason: 'owned', wallet }
  if (wallet.coins < SKIN_PRICES[id]) return { ok: false, reason: 'insufficient', wallet }
  return {
    ok: true,
    wallet: { ...wallet, coins: wallet.coins - SKIN_PRICES[id], skins: normalizeSkins([...wallet.skins, id]) },
  }
}

/**
 * Pays the awards of one run that the ledger has not paid yet. `joinedAfter`
 * skips the bosses beaten before this player's hero joined (an online Catch Up).
 * Returns the same wallet object when nothing is owed, so a caller can skip the
 * storage write.
 */
export function creditBossCoins(wallet: Wallet, runKey: string, awards: readonly BossCoinAward[] | undefined,
  joinedAfter = 0): { wallet: Wallet; coins: number } {
  if (!runKey || runKey.length > MAX_RUN_KEY_LENGTH) return { wallet, coins: 0 }
  const valid = (awards ?? []).slice(0, MAX_BOSS_AWARDS)
  const paid = wallet.credited[runKey] ?? 0
  if (valid.length <= paid) return { wallet, coins: 0 }
  const coins = valid.slice(Math.max(paid, joinedAfter)).reduce((sum, award) =>
    sum + (count(award?.coins, MAX_WALLET_COINS) ? award.coins : 0), 0)
  // Re-inserted last, so the ledger forgets the runs that went quiet longest ago.
  const { [runKey]: _previous, ...others } = wallet.credited
  const ledger = [...Object.entries(others), [runKey, valid.length] as const].slice(-MAX_CREDITED_RUNS)
  return {
    wallet: { ...wallet, coins: Math.min(MAX_WALLET_COINS, wallet.coins + coins), credited: Object.fromEntries(ledger) },
    coins,
  }
}

/** The packs a new run should shuffle in: everything owned, unless the switch is off. */
export const enabledCardPacks = (wallet: Wallet): CardPackId[] =>
  wallet.addPacksToRuns ? normalizeCardPacks(wallet.packs) : []

/** The future "add my packs to runs" setting. Deliberately not exposed in any UI yet. */
export const setAddPacksToRuns = (wallet: Wallet, enabled: boolean): Wallet =>
  wallet.addPacksToRuns === enabled ? wallet : { ...wallet, addPacksToRuns: enabled }

/**
 * The ledger key of a solo run. `start` is a nonce App draws whenever a run is
 * started, so a new attempt on a reused seed is a new run, while a resume or a
 * reload of the same attempt is not. Saves from before the Shop have none.
 */
export const soloRunKey = (runId: string, seed: number, start?: string): string =>
  `solo:${runId}:${seed}${start ? `:${start}` : ''}`.slice(0, MAX_RUN_KEY_LENGTH)

/** The ledger key of an online run: room codes are unique while live, run ids within a room. */
export const onlineRunKey = (code: string, runId: string): string =>
  `online:${code}:${runId}`.slice(0, MAX_RUN_KEY_LENGTH)
