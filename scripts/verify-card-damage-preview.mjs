import { createCombat, playCard, previewCardDamage } from '../src/game/combat.ts'
import { createRng } from '../src/game/rng.ts'
import { suite, check, assert, assertDeepEqual, assertEqual, report } from './lib/harness.mjs'

let uid = 0
const instance = (defId, upgraded = false) => ({ uid: `c${uid++}`, defId, upgraded })

function makePlayer(over = {}) {
  return {
    id: 'p1', name: 'Ironclad', character: 'ironclad', row: 0, hp: 10, maxHp: 10, block: 0, energy: 3,
    deck: [], draw: [], hand: [], discard: [], exhaust: [], powers: [], gold: 0, relics: [], potions: [],
    cardRewards: [], rareRewards: [], strength: 0, vulnerable: 0, weak: 0, shivs: 0, miracles: 0,
    stance: 'neutral', orbs: [null, null, null], dead: false, ...over,
  }
}

function makeEnemy(over = {}) {
  return {
    uid: 'e1', defId: 'cultist', row: 0, isBoss: false, hp: 40, maxHp: 40, block: 0, strength: 0,
    vulnerable: 0, weak: 0, poison: 0, actionIndex: 0, abilityUsed: false, dead: false, ...over,
  }
}

/** A fight with `defId` as the only card in hand. */
function fight(defId, player = {}, enemy = {}, upgraded = false) {
  const card = instance(defId, upgraded)
  const state = createCombat(createRng(42), [makePlayer({ hand: [card], ...player })], [makeEnemy(enemy)])
  return { state, card }
}

const preview = (setup, enemyUid = 'e1') => previewCardDamage(setup.state, 'p1', setup.card.uid, enemyUid)

suite('card damage preview')

check('a plain Strike previews its printed damage', () => {
  assertDeepEqual(preview(fight('strike_ironclad')), { damage: 1, baseline: 1 })
})

check('Strength is added to every hit of a multi-hit', () => {
  assertDeepEqual(preview(fight('twin_strike', { strength: 3 })), { damage: 8, baseline: 2 })
})

check('Vulnerable doubles the hit after Strength', () => {
  assertDeepEqual(preview(fight('strike_ironclad', { strength: 3 }, { vulnerable: 1 })), { damage: 8, baseline: 1 })
})

check('Weak takes 1 off each hit and Weak plus Vulnerable cancel', () => {
  assertDeepEqual(preview(fight('twin_strike', { weak: 1 })), { damage: 0, baseline: 2 })
  assertDeepEqual(preview(fight('strike_ironclad', { strength: 2, weak: 1 }, { vulnerable: 1 })), { damage: 3, baseline: 1 })
})

check('Block-scaled and Strength-scaled amounts are read from the board', () => {
  assertEqual(preview(fight('body_slam', { block: 7 })).damage, 7)
  // Heavy Blade prints 3 and adds the extra two per Strength on top of the normal one.
  assertEqual(preview(fight('heavy_blade', { strength: 2 })).damage, 3 + 2 * 2 + 2)
  assertEqual(preview(fight('heavy_blade', { strength: 2 })).baseline, 3)
})

check('an unaffordable Attack and an X-cost Attack are still previewed', () => {
  assertEqual(preview(fight('heavy_blade', { energy: 0 })).damage, 3)
  assertEqual(preview(fight('whirlwind', { energy: 3, strength: 1 })).damage, 6)
})

check('the preview matches what really playing the card does', () => {
  for (const defId of ['strike_ironclad', 'twin_strike', 'bash', 'heavy_blade', 'body_slam', 'cleave']) {
    const setup = fight(defId, { strength: 2, block: 4 }, { vulnerable: 1, hp: 40, maxHp: 40 })
    const expected = preview(setup).damage
    const played = playCard(setup.state, 'p1', setup.card.uid, { enemyUid: 'e1', enemyRow: 0, playerId: 'p1' })
    assert(played !== setup.state, `${defId} could not be played`)
    assertEqual(40 - played.enemies[0].hp, expected, defId)
  }
})

check('with no target chosen, Vulnerable on the stand-in enemy is ignored', () => {
  const setup = fight('strike_ironclad', { strength: 1 }, { vulnerable: 2 })
  assertEqual(previewCardDamage(setup.state, 'p1', setup.card.uid, null).damage, 2)
  assertEqual(preview(setup).damage, 4)
})

check('the stand-in is the first living enemy', () => {
  const card = instance('strike_ironclad')
  const state = createCombat(createRng(42), [makePlayer({ hand: [card] })],
    [makeEnemy({ uid: 'dead', dead: true }), makeEnemy({ uid: 'live', strength: 5 })])
  assertEqual(previewCardDamage(state, 'p1', card.uid, null).damage, 1)
})

check('rules that read the target\'s health see its real health', () => {
  const full = fight('backstab', { character: 'silent' })
  assertEqual(preview(full).damage, 4, 'full health')
  const hurt = fight('backstab', { character: 'silent' }, { hp: 30 })
  assertEqual(preview(hurt).damage, 2, 'damaged')
  const played = playCard(hurt.state, 'p1', hurt.card.uid, { enemyUid: 'e1', enemyRow: 0, playerId: 'p1' })
  assertEqual(30 - played.enemies[0].hp, 2, 'really playing it')
})

check('the colour baseline ignores every temporary damage bonus', () => {
  const akabeko = fight('strike_ironclad')
  akabeko.state.players[0].akabekoAttacks = 1
  assertDeepEqual(preview(akabeko), { damage: 2, baseline: 1 })
  assertDeepEqual(preview(fight('strike_ironclad', { strength: -1 })), { damage: 0, baseline: 1 })
  assertDeepEqual(preview(fight('strike_watcher', { character: 'watcher', stance: 'wrath' })), { damage: 2, baseline: 1 })
})

check('the stand-in is a plain enemy, whatever rules the first living enemy has', () => {
  const card = instance('strike_ironclad')
  const state = createCombat(createRng(42), [makePlayer({ hand: [card], strength: 5 })],
    [makeEnemy({ uid: 'flyer', defId: 'byrd_encounter' }), makeEnemy({ uid: 'plain' })])
  assertEqual(previewCardDamage(state, 'p1', card.uid, 'flyer').damage, 1, 'Flying caps each hit at 1 on the real target')
  assertEqual(previewCardDamage(state, 'p1', card.uid, 'plain').damage, 6)
  assertEqual(previewCardDamage(state, 'p1', card.uid, null).damage, 6, 'the stand-in is not the flyer')
})

check('a Guardian card that is a Skill in Defense Mode has no damage', () => {
  const attack = fight('guardian_guardian_whirl', { character: 'guardian', guardianMode: 'attack' })
  assert(preview(attack) !== null, 'Attack Mode')
  const defense = fight('guardian_guardian_whirl', { character: 'guardian' })
  defense.state.players[0].guardianMode = 'defense'
  assertEqual(preview(defense), null, 'Defense Mode')
})

check('an engine fault yields no preview instead of throwing', () => {
  const setup = fight('strike_ironclad')
  setup.state.players[0].hand[0].defId = 'not_a_card'
  assertEqual(preview(setup), null)
})

check('an online client skips cards that read ledgers its copy of the state blanks', () => {
  const flurry = fight('flurry_of_blows', { character: 'watcher' })
  assert(preview(flurry) !== null, 'the full state evaluates it')
  assertEqual(previewCardDamage(flurry.state, 'p1', flurry.card.uid, 'e1', true), null, 'stance ledger')
  const strike = fight('strike_ironclad')
  assert(previewCardDamage(strike.state, 'p1', strike.card.uid, 'e1', true) !== null, 'ordinary Attacks still work')
})

check('a drawing Attack is not previewed while a draw-triggered Power could reveal the next card', () => {
  const plain = fight('pommel_strike')
  assert(preview(plain) !== null, 'no draw-triggered Power')
  const burning = fight('pommel_strike', { powers: [instance('fire_breathing')], draw: [instance('defend_ironclad')] })
  assertEqual(preview(burning), null)
})

check('the preview changes nothing and consumes no randomness', () => {
  const setup = fight('twin_strike', { strength: 1, draw: [instance('defend_ironclad')] })
  const before = JSON.stringify(setup.state)
  preview(setup)
  assertEqual(JSON.stringify(setup.state), before)
})

check('only Attacks the player can resolve alone are previewed', () => {
  assertEqual(preview(fight('defend_ironclad')), null, 'a Skill')
  assertEqual(preview(fight('strike_ironclad'), 'nobody'), null, 'an unknown enemy')
  const enemyPhase = fight('strike_ironclad')
  enemyPhase.state.phase = 'enemy'
  assertEqual(preview(enemyPhase), null, 'outside the Player Turn')
  assertEqual(preview({ state: fight('strike_ironclad').state, card: { uid: 'missing' } }), null, 'a card not in hand')
})

report('card damage preview')
