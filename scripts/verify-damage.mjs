import {
  hitDamage,
  applyDamage,
  applyHpLoss,
  gainBlock,
  gainStrength,
  gainVulnerable,
  gainWeak,
  gainPoison,
  totalPoisonInPlay,
} from '../src/game/damage.ts'
import { CAPS } from '../src/game/types.ts'
import { suite, check, assert, assertEqual, report } from './lib/harness.mjs'

const plain = { strength: 0, weak: 0, wrath: false }
const mods = (over) => ({ ...plain, ...over })
const soft = { vulnerable: 0 }

suite('damage')

check('a plain hit deals its printed damage', () => {
  assertEqual(hitDamage(1, plain, soft), 1)
  assertEqual(hitDamage(6, plain, soft), 6)
  assertEqual(hitDamage(0, plain, soft), 0)
})

check('Strength adds to every hit', () => {
  assertEqual(hitDamage(1, mods({ strength: 3 }), soft), 4)
  assertEqual(hitDamage(2, mods({ strength: 8 }), soft), 10)
})

check('Wrath is worth exactly one Strength', () => {
  assertEqual(hitDamage(2, mods({ wrath: true }), soft), 3)
  assertEqual(hitDamage(2, mods({ strength: 1 }), soft), hitDamage(2, mods({ wrath: true }), soft))
  assertEqual(hitDamage(2, mods({ strength: 2, wrath: true }), soft), 5)
})

check('Weak removes 1 from each hit', () => {
  assertEqual(hitDamage(3, mods({ weak: 1 }), soft), 2)
  assertEqual(hitDamage(1, mods({ weak: 1 }), soft), 0)
})

check('Weak cannot push a hit below zero', () => {
  assertEqual(hitDamage(0, mods({ weak: 1 }), soft), 0)
})

// Rulebook p.24: "Add damage bonuses like Strength before doubling." Doubling
// first would give 1*2+3 = 5 here instead of 8, and that error is invisible
// until someone compares a real game against the app.
check('Vulnerable doubles AFTER Strength is added', () => {
  assertEqual(hitDamage(1, mods({ strength: 3 }), { vulnerable: 1 }), 8)
  assertEqual(hitDamage(2, plain, { vulnerable: 1 }), 4)
})

// The rulebook's own worked example, p.14: Ironclad Twin Strike (1 + 1) into a
// Vulnerable Cultist deals 2 + 2 for 4 total.
check('the rulebook Twin Strike example comes out to 4', () => {
  const perHit = hitDamage(1, plain, { vulnerable: 1 })
  assertEqual(perHit, 2, 'each hit of Twin Strike should double to 2')
  assertEqual(perHit * 2, 4, 'Twin Strike should total 4 into a Vulnerable target')
})

// p.24: "If a Weak target attacks a Vulnerable target, the attack is unaffected
// by both." Applying them in sequence instead would give (2-1)*2 = 2.
check('Weak attacker into Vulnerable target cancels both', () => {
  assertEqual(hitDamage(2, mods({ weak: 1 }), { vulnerable: 1 }), 2)
  assertEqual(hitDamage(3, mods({ strength: 1, weak: 2 }), { vulnerable: 3 }), 4)
})

check('Block absorbs damage and is spent doing so', () => {
  assertEqual(applyDamage(5, 10, 3).block, 2)
  assertEqual(applyDamage(5, 10, 3).hp, 10)
  assertEqual(applyDamage(5, 10, 3).hpLost, 0)
  assert(applyDamage(5, 10, 3).fullyBlocked, 'three damage into five Block should be fully absorbed')
})

check('damage past Block costs HP', () => {
  const outcome = applyDamage(2, 10, 5)
  assertEqual(outcome.block, 0, '2 Block should be fully spent absorbing 5 damage')
  assertEqual(outcome.hp, 7, '3 damage should get through to a 10 HP target')
  assertEqual(outcome.hpLost, 3, 'hpLost should report the 3 that got past Block')
  assert(!outcome.fullyBlocked, 'overflow damage should not report as blocked')
})

check('HP never goes below zero and hpLost reports the truth', () => {
  const outcome = applyDamage(0, 3, 9)
  assertEqual(outcome.hp, 0)
  assertEqual(outcome.hpLost, 3, 'hpLost should be the HP actually removed, not the raw damage')
})

check('exactly lethal damage is reported once', () => {
  const outcome = applyDamage(0, 4, 4)
  assertEqual(outcome.hp, 0)
  assertEqual(outcome.hpLost, 4)
})

// p.18: "Can Block prevent an effect that says 'Lose X HP'? No."
check('HP loss ignores Block entirely', () => {
  assertEqual(applyHpLoss(10, 3).hp, 7)
  assertEqual(applyHpLoss(10, 3).hpLost, 3)
  assertEqual(applyHpLoss(2, 5).hp, 0)
  assertEqual(applyHpLoss(2, 5).hpLost, 2)
})

check('every token clamps at its cap instead of overflowing', () => {
  assertEqual(gainBlock(18, 5), CAPS.block, 'Block caps at 20')
  assertEqual(gainStrength(7, 4), CAPS.strength, 'Strength caps at 8')
  assertEqual(gainVulnerable(2, 3), CAPS.vulnerable, 'Vulnerable caps at 3')
  assertEqual(gainWeak(0, 9), CAPS.weak, 'Weak caps at 3')
})

check('tokens never go negative', () => {
  assertEqual(gainBlock(1, -5), 0)
  assertEqual(gainStrength(0, -3), 0)
})

// p.17: "There can't be more than 30 Poison combined on all enemies."
check('Poison is capped across all enemies together', () => {
  assertEqual(gainPoison(0, 5, 0), 5)
  assertEqual(gainPoison(4, 10, 28), 6, 'only 2 Poison of headroom remains, so 4 + 2 = 6')
  assertEqual(gainPoison(10, 5, 30), 10, 'at the global cap the effect is ignored')
})

// The contract is that the third argument is the whole-table total *including*
// the target's own poison, which is exactly what totalPoisonInPlay returns.
// Wiring the two together here proves the pair cannot push the table over 30.
check('poisoning through totalPoisonInPlay never exceeds the global cap', () => {
  const enemies = [
    { poison: 20, dead: false },
    { poison: 8, dead: false },
  ]
  const table = totalPoisonInPlay(enemies)
  const target = enemies[0]
  const after = gainPoison(target.poison, 9, table)
  assertEqual(after, 22, 'only 2 of the 9 Poison fit under the 30 cap')
  const newTable = after + enemies[1].poison
  assertEqual(newTable, CAPS.poison, 'the table should land exactly on the cap, never above it')
})

check('poison in play ignores the dead', () => {
  const enemies = [
    { poison: 4, dead: false },
    { poison: 7, dead: false },
    { poison: 9, dead: true },
  ]
  assertEqual(totalPoisonInPlay(enemies), 11, 'should sum only the living: 4 + 7, ignoring the dead enemy 9')
  assertEqual(totalPoisonInPlay([]), 0, 'no enemies means no poison in play')
})

report('damage')
