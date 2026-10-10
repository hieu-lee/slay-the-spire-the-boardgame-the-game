// The coin economy's design rules, checked over every Act and Ascension.
import { suite, check, assert, assertEqual, report } from './lib/harness.mjs'
import {
  A10_THREE_BOSS_EXPECTATION, BOSS_ACTS, CARD_PACK_PRICE, MAX_BOSS_AWARDS, MAX_BOSS_AWARD_COINS, MAX_COIN_ASCENSION,
  bossCoinExpectation, bossCoinRange, coinsOwed, rollBossCoins,
} from '../src/game/coins.ts'

suite('coins')
const ascensions = Array.from({ length: MAX_COIN_ASCENSION + 1 }, (_, ascension) => ascension)

check('every range is a whole-number interval above zero', () => {
  for (const act of BOSS_ACTS) for (const ascension of ascensions) {
    const { min, max } = bossCoinRange(act, ascension)
    assert(Number.isInteger(min) && Number.isInteger(max) && min >= 1 && max >= min, `act ${act} A${ascension}: ${min}-${max}`)
  }
})

check('Act 1 < Act 2 < Act 3 < Act 4 on average at every Ascension', () => {
  for (const ascension of ascensions) {
    for (const act of [1, 2, 3]) {
      assert(bossCoinExpectation(act, ascension) < bossCoinExpectation(act + 1, ascension), `A${ascension}: act ${act} vs ${act + 1}`)
    }
  }
})

check('A5 pays twice A0, A8 twice A5, A10 twice A8 for every Act', () => {
  for (const act of BOSS_ACTS) {
    assertEqual(bossCoinExpectation(act, 5), 2 * bossCoinExpectation(act, 0), `act ${act} A5`)
    assertEqual(bossCoinExpectation(act, 8), 2 * bossCoinExpectation(act, 5), `act ${act} A8`)
    assertEqual(bossCoinExpectation(act, 10), 2 * bossCoinExpectation(act, 8), `act ${act} A10`)
  }
})

check('every Ascension pays more than the one below, except A11 and A13 for Acts 1-3', () => {
  for (const act of BOSS_ACTS) for (const ascension of ascensions.slice(1)) {
    const now = bossCoinExpectation(act, ascension)
    const before = bossCoinExpectation(act, ascension - 1)
    if ((ascension === 11 || ascension === 13) && act !== 4) assertEqual(now, before, `act ${act} A${ascension} holds steady`)
    else assert(now > before, `act ${act} A${ascension} (${now}) must beat A${ascension - 1} (${before})`)
  }
})

check('rolls stay in range, are deterministic, and cover the whole range', () => {
  for (const act of BOSS_ACTS) for (const ascension of [0, 5, 10, 13]) {
    const { min, max } = bossCoinRange(act, ascension)
    const seen = new Set()
    for (let seed = 0; seed < 4000; seed += 1) {
      const coins = rollBossCoins(seed, seed % 3, act, ascension)
      assert(coins >= min && coins <= max, `act ${act} A${ascension} rolled ${coins} outside ${min}-${max}`)
      assertEqual(rollBossCoins(seed, seed % 3, act, ascension), coins, 'same inputs, same roll')
      seen.add(coins)
    }
    assertEqual(seen.size, max - min + 1, `act ${act} A${ascension} reaches every value`)
  }
})

check('the rolled average converges on the stated expectation', () => {
  for (const act of BOSS_ACTS) {
    let total = 0
    for (let seed = 0; seed < 20000; seed += 1) total += rollBossCoins(seed, 0, act, 10)
    const average = total / 20000
    const expected = bossCoinExpectation(act, 10)
    assert(Math.abs(average - expected) < expected * 0.02, `act ${act}: ${average} vs ${expected}`)
  }
})

check('a pack costs twice the three-boss A10 expectation', () => {
  assertEqual(A10_THREE_BOSS_EXPECTATION, 240 + 160 + 80)
  assertEqual(CARD_PACK_PRICE, 960)
})

check('catch-up players are owed only the bosses beaten after they joined', () => {
  const awards = [{ act: 1, coins: 10 }, { act: 2, coins: 20 }, { act: 3, coins: 30 }]
  assertEqual(coinsOwed(awards), 60)
  assertEqual(coinsOwed(awards, 1), 50)
  assertEqual(coinsOwed(awards, 9), 0)
  assertEqual(coinsOwed(undefined), 0)
})

check('Ascension is clamped to the table: negative, beyond 13, fractional and non-numbers', () => {
  for (const act of BOSS_ACTS) {
    assertEqual(JSON.stringify(bossCoinRange(act, -3)), JSON.stringify(bossCoinRange(act, 0)))
    assertEqual(JSON.stringify(bossCoinRange(act, 99)), JSON.stringify(bossCoinRange(act, MAX_COIN_ASCENSION)))
    assertEqual(JSON.stringify(bossCoinRange(act, 7.9)), JSON.stringify(bossCoinRange(act, 7)))
    for (const bad of [NaN, Infinity, -Infinity]) {
      assertEqual(JSON.stringify(bossCoinRange(act, bad)), JSON.stringify(bossCoinRange(act, 0)), `act ${act} at ${bad}`)
      const coins = rollBossCoins(1, 0, act, bad)
      assert(Number.isInteger(coins) && coins >= bossCoinRange(act, 0).min, `act ${act} at ${bad} rolled ${coins}`)
    }
  }
})

check("the same Act's bosses roll independently, so A13's two Act III bosses can pay differently", () => {
  let differs = 0
  for (let seed = 0; seed < 200; seed += 1) if (rollBossCoins(seed, 2, 3, 13) !== rollBossCoins(seed, 3, 3, 13)) differs += 1
  assert(differs > 150, `only ${differs} of 200 seeds rolled the two Act III bosses differently`)
})

check('the roll seed is pinned: a changed salt or argument order would re-roll every recorded run', () => {
  // [runSeed, bossNumber, act, ascension] -> coins. Saves, replays and past-run grants depend on these staying put.
  const golden = [
    [[12345, 0, 1, 0], 12], [[12345, 1, 2, 5], 37], [[987654321, 2, 3, 10], 205],
    [[42, 3, 3, 13], 247], [[42, 4, 4, 13], 643], [[7, 5, 1, 13], 114],
  ]
  for (const [args, coins] of golden) assertEqual(rollBossCoins(...args), coins, `rollBossCoins(${args.join(', ')})`)
})

check('a maximal run holds exactly MAX_BOSS_AWARDS awards, and no award or total can pass the caps', () => {
  // Acts I-IV, A13's second Act III boss, and a Mind Bloom boss (an Act I boss summoned in Act III).
  const maximalRun = [1, 2, 3, 3, 4, 1]
  assertEqual(MAX_BOSS_AWARDS, maximalRun.length, 'the wallet would refuse or drop a real award')
  assertEqual(MAX_BOSS_AWARD_COINS, 720)
  let total = 0
  for (const [number, act] of maximalRun.entries()) {
    const coins = rollBossCoins(2026, number, act, MAX_COIN_ASCENSION)
    assert(coins <= MAX_BOSS_AWARD_COINS, `award ${number} paid ${coins}`)
    total += coins
  }
  assert(total <= MAX_BOSS_AWARDS * MAX_BOSS_AWARD_COINS)
  assertEqual(bossCoinRange(4, MAX_COIN_ASCENSION).max, MAX_BOSS_AWARD_COINS, 'the cap is the Act IV boss at the top Ascension')
})

report('coins')
