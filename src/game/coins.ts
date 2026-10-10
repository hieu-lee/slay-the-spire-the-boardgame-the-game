// Coins: the Shop currency. A defeated boss pays out a uniform integer roll whose
// range depends on the Act of the boss and on the Ascension it was beaten at.
//
// The design rules (all checked by scripts/verify-coins.mjs):
//   * Act 1 < Act 2 < Act 3 < Act 4, on average, at every Ascension.
//   * On average an Act boss at A5 pays twice A0, A8 twice A5, and A10 twice A8.
//   * Every Ascension pays more than the one below it, with two exceptions: A11 and
//     A13 add Elite/Act IV difficulty rather than a bigger Act 1-3 boss, so only the
//     Act 4 boss pays more there. (A13's extra Act III boss pays a second time.)
//
// The roll is deterministic in (run seed, boss number, act, ascension) and never
// touches the run's own RNG stream, so existing seeds, saves and replays are
// unchanged and a run replays to the same coins.
import { createRng, nextInt, seedFromString } from './rng.ts'
import { MAX_ASCENSION } from './campaign.ts'
import type { SkinId } from './skins.ts'

export type BossAct = 1 | 2 | 3 | 4
export const BOSS_ACTS: readonly BossAct[] = [1, 2, 3, 4]
export const MAX_COIN_ASCENSION = MAX_ASCENSION

type CoinRange = { min: number; max: number }
/** One boss victory: the Act it was beaten in and the coins it paid. */
export type BossCoinAward = { act: BossAct; coins: number }

/** The Ascension 0 payout of each Act's boss. Means: 10, 20, 30 and 50. */
const BASE_RANGE: Readonly<Record<BossAct, CoinRange>> = {
  1: { min: 8, max: 12 },
  2: { min: 16, max: 24 },
  3: { min: 24, max: 36 },
  4: { min: 40, max: 60 },
}

/**
 * How much each Ascension scales the base range, for the Act 1-3 bosses. The whole
 * numbers at A5, A8 and A10 make the doubling rule exact rather than approximate.
 */
const ACT_1_TO_3_MULTIPLIER = [1, 1.15, 1.3, 1.5, 1.75, 2, 2.5, 3.25, 4, 6, 8, 8, 10, 10] as const
/** The Act 4 boss keeps climbing at A11 and A13, where the earlier Acts hold steady. */
const ACT_4_MULTIPLIER = [1, 1.15, 1.3, 1.5, 1.75, 2, 2.5, 3.25, 4, 6, 8, 9, 11, 12] as const

function multiplier(act: BossAct, ascension: number): number {
  const table = act === 4 ? ACT_4_MULTIPLIER : ACT_1_TO_3_MULTIPLIER
  // Out-of-range Ascensions clamp; one that is not a number at all pays as A0.
  const level = Number.isFinite(ascension) ? Math.max(0, Math.min(MAX_COIN_ASCENSION, Math.floor(ascension))) : 0
  return table[level]!
}

/** The inclusive integer range a boss of this Act pays at this Ascension. */
export function bossCoinRange(act: BossAct, ascension: number): CoinRange {
  const base = BASE_RANGE[act]
  const scale = multiplier(act, ascension)
  return { min: Math.round(base.min * scale), max: Math.round(base.max * scale) }
}

/** Average payout of the range: the "on average" in the design rules. */
export function bossCoinExpectation(act: BossAct, ascension: number): number {
  const { min, max } = bossCoinRange(act, ascension)
  return (min + max) / 2
}

/** The coins one boss victory pays. `bossNumber` is how many boss awards the run already holds. */
export function rollBossCoins(runSeed: number, bossNumber: number, act: BossAct, ascension: number): number {
  const { min, max } = bossCoinRange(act, ascension)
  const rng = createRng(seedFromString(`boss-coins:${runSeed}:${bossNumber}:${act}:${ascension}`))
  return min + nextInt(rng, max - min + 1)
}

/** Coins from Act 1, 2 and 3 bosses at Ascension 10, on average. */
export const A10_THREE_BOSS_EXPECTATION = bossCoinExpectation(1, 10) + bossCoinExpectation(2, 10) + bossCoinExpectation(3, 10)

/** A Slayer pack costs twice what one run through all three Act bosses at Ascension 10 pays. */
export const CARD_PACK_PRICE = 2 * A10_THREE_BOSS_EXPECTATION

/** Every skin costs the same; `SKIN_PRICES` is the catalogue, so one skin could cost more later. */
export const SKIN_PRICE = 2500
export const SKIN_PRICES: Readonly<Record<SkinId, number>> = { kratos: SKIN_PRICE }

/** No run holds more boss awards than this (Acts I-IV plus A13's second Act III boss, with a Mind Bloom boss). */
export const MAX_BOSS_AWARDS = 6
/** The most one boss can pay: the Act IV boss at the top Ascension. */
export const MAX_BOSS_AWARD_COINS = bossCoinRange(4, MAX_COIN_ASCENSION).max

/** Total coins of the awards a player is owed; `joinedAfter` skips bosses beaten before they joined. */
export function coinsOwed(awards: readonly BossCoinAward[] | undefined, joinedAfter = 0): number {
  return (awards ?? []).slice(Math.max(0, joinedAfter)).reduce((sum, award) => sum + award.coins, 0)
}

/**
 * Where a Catch Up joiner's share starts in `bossCoins`. The run records the
 * joiner's arrival as a count of bosses beaten (`joinedAfterBosses`), but a run
 * restored from before the Shop beat some of those bosses without an award, so
 * the count is shifted by the bosses that hold none.
 */
export const catchUpAwardIndex = (joinedAfterBosses: number, bossesDefeated: number, awardCount: number): number =>
  Math.max(0, joinedAfterBosses - Math.max(0, bossesDefeated - awardCount))
