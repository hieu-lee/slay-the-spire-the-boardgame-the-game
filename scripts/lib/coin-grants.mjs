// Coins for the runs players recorded before the Shop existed.
//
// The leaderboard already holds every run an account submitted: its Ascension,
// where it started and the highest Act whose boss fell. From that, the bosses a
// run beat are known, and each is "rolled" with the game's own coin ranges
// (src/game/coins.ts) from a seed made of the account and the run, so the same
// account always computes the same grant, across restarts and on every device.
//
// Only runs recorded before `coinsLaunchedAt` count: that moment is stored once,
// the first time a server with the Shop starts, and every later run pays in game
// when its result is recorded, so nothing is paid twice.
//
// A grant is computed the first time its account asks, then stored and frozen:
// later leaderboard edits or removals never change a grant. Claiming is two-phase
// so neither a lost response nor a second device can pay it twice: `claim` reserves
// the grant for the caller's claim id (a repeat with the same id returns it again),
// the client pays its wallet, and `confirm` marks it claimed for good.
import { randomBytes } from 'node:crypto'
import { rollBossCoins } from '../../src/game/coins.ts'
import { seedFromString } from '../../src/game/rng.ts'

const CLAIM_ID = /^[0-9a-f-]{36}$/
const MAX_COIN_GRANTS = 20_000

/** Names compare like the profile registry and the client compare them. */
export const grantNameKey = (username) => username.normalize('NFKC').trim().toLowerCase()

/**
 * The bosses a recorded run beat, by Act: every Act from its start to the highest
 * Act whose boss fell. At Ascension 13 the Act III boss is two bosses, and a run
 * counts Act III as beaten only once both fell (`resolveCombat` in
 * src/game/run/rooms.ts), so it paid twice. A Mind Bloom boss or the first of the
 * two A13 Act III bosses in a run that then fell is not on the leaderboard and is
 * not paid.
 */
export function bossesOf(run) {
  const acts = []
  for (let act = Math.max(1, run.startedAtAct ?? 1); act <= run.highestBossActDefeated; act += 1) {
    acts.push(act)
    if (act === 3 && run.ascension >= 13) acts.push(3)
  }
  return acts
}

/**
 * The runs an account submitted that count: its own and its co-op seats, all before the
 * cutoff, never a Daily Climb. A Daily Climb is a run with its day (`dailyDate`); an old
 * run marked `daily` from before the shared-seed Daily Climb has none, earned campaign
 * marks like a standard run (the client resumes such saves as standard), and is paid.
 */
export function legacyRuns(runs, username, cutoff) {
  const key = grantNameKey(username)
  return runs.filter((run) => run.recordedAt < cutoff && run.dailyDate === undefined &&
    (typeof run.username === 'string' && grantNameKey(run.username) === key ||
      run.winningDecks?.some((deck) => typeof deck.username === 'string' && grantNameKey(deck.username) === key)))
}

/** The coins an account's past runs would have paid, deterministically. */
export function legacyCoinGrant(runs, username, cutoff) {
  const key = grantNameKey(username)
  let coins = 0
  const counted = legacyRuns(runs, username, cutoff)
  for (const run of counted) {
    const seed = seedFromString(`legacy-coins:${key}:${run.id}`)
    bossesOf(run).forEach((act, bossNumber) => { coins += rollBossCoins(seed, bossNumber, act, run.ascension) })
  }
  return { coins, runs: counted.length }
}

/** Stored grants, validated: anything malformed is dropped rather than paid. */
export function restoreCoinGrants(value) {
  if (!Array.isArray(value)) return []
  return value.filter((grant) => grant && typeof grant.username === 'string' && grant.username.length <= 64 &&
    typeof grant.grantId === 'string' && /^[0-9a-f]{32}$/.test(grant.grantId) &&
    Number.isSafeInteger(grant.coins) && grant.coins >= 0 && grant.coins <= 100_000_000 &&
    (grant.claimId === null || typeof grant.claimId === 'string' && CLAIM_ID.test(grant.claimId)) &&
    (grant.claimedAt === null || Number.isSafeInteger(grant.claimedAt)))
    .slice(-MAX_COIN_GRANTS)
}

/** The account's grant, computed and stored the first time it is asked for. */
export function grantFor(store, username) {
  const key = grantNameKey(username)
  let grant = store.coinGrants.find((entry) => entry.username === key)
  if (!grant) {
    const { coins } = legacyCoinGrant(store.leaderboardRuns, username, store.coinsLaunchedAt)
    grant = { username: key, grantId: randomBytes(16).toString('hex'), coins, claimId: null, claimedAt: null }
    store.coinGrants.push(grant)
    if (store.coinGrants.length > MAX_COIN_GRANTS) store.coinGrants.shift()
    store.coinGrantsChanged = true
  }
  return grant
}

const badClaim = () => { throw Object.assign(new Error('Invalid coin claim'), { status: 400 }) }

/**
 * Phase one: reserves the grant for `claimId` and returns its coins. A grant that is
 * claimed, empty, or reserved by another claim id returns 0 coins.
 */
export function claimCoinGrant(store, username, claimId) {
  if (typeof claimId !== 'string' || !CLAIM_ID.test(claimId)) badClaim()
  const grant = grantFor(store, username)
  if (grant.coins === 0 || grant.claimedAt !== null || grant.claimId !== null && grant.claimId !== claimId) {
    return { coins: 0 }
  }
  if (grant.claimId !== claimId) {
    grant.claimId = claimId
    store.coinGrantsChanged = true
  }
  return { coins: grant.coins, grantId: grant.grantId }
}

/** Phase two: the claimant paid its wallet; the grant is spent. A repeat confirmation is harmless. */
export function confirmCoinGrant(store, username, claimId, grantId, now = Date.now()) {
  if (typeof claimId !== 'string' || !CLAIM_ID.test(claimId) || typeof grantId !== 'string') badClaim()
  const grant = store.coinGrants.find((entry) => entry.username === grantNameKey(username))
  if (!grant || grant.grantId !== grantId || grant.claimId !== claimId) return { claimed: false }
  if (grant.claimedAt === null) {
    grant.claimedAt = now
    store.coinGrantsChanged = true
  }
  return { claimed: true }
}
