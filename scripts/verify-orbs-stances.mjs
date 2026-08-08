// Defect orbs, Watcher stances, Scry, and the player-side status tokens that
// enemies apply. These were no-ops until now, so Zap and Dual Cast sat in the
// Defect's starter deck doing nothing.
import { createCombat, endPlayerTurn, enemyTurn, playCard, startPlayerTurn } from '../src/game/combat.ts'
import { createRng } from '../src/game/rng.ts'
import { suite, check, assert, assertEqual, assertDeepEqual, report } from './lib/harness.mjs'

let uid = 0
const instance = (defId, upgraded = false) => ({ uid: `c${uid++}`, defId, upgraded })

const player = (over = {}) => ({
  id: 'p1', name: 'Defect', character: 'defect', row: 0,
  hp: 9, maxHp: 9, block: 0, energy: 3,
  deck: [], draw: [], hand: [], discard: [], exhaust: [], powers: [],
  gold: 0, relics: [], potions: [], cardRewards: [], rareRewards: [],
  strength: 0, vulnerable: 0, weak: 0, shivs: 0, miracles: 0,
  stance: 'neutral', orbs: [null, null, null], dead: false, ...over,
})

const enemy = (over = {}) => ({
  // Green Louse attacks for 1 on a 1-2, which is the simplest attacker to
  // reason about when checking status arithmetic.
  uid: 'e1', defId: 'green_louse', row: 0, isBoss: false,
  hp: 20, maxHp: 20, block: 0,
  strength: 0, vulnerable: 0, weak: 0, poison: 0, actionIndex: 0, dead: false, ...over,
})

const combat = (players, enemies) => createCombat(createRng(11), players, enemies)
const inEnemyPhase = (players, enemies) => ({ ...combat(players, enemies), phase: 'enemy' })

suite('orbs and stances')

check('Zap channels a Lightning orb into an open slot', () => {
  const zap = instance('zap')
  const next = playCard(combat([player({ hand: [zap] })], [enemy()]), 'p1', zap.uid, {
    enemyUid: 'e1', playerId: 'p1',
  })
  assertDeepEqual(next.players[0].orbs, ['lightning', null, null], 'the orb takes the first open slot')
})

check('channelling into a full board evokes an orb to make room', () => {
  const zap = instance('zap')
  const state = combat(
    [player({ hand: [zap], orbs: ['frost', 'frost', 'frost'] })],
    [enemy()],
  )
  const next = playCard(state, 'p1', zap.uid, { enemyUid: 'e1', playerId: 'p1' })
  const orbs = next.players[0].orbs
  assertEqual(orbs.filter((orb) => orb === null).length, 0, 'the board stays full')
  assert(orbs.includes('lightning'), 'the new orb is placed')
  assertEqual(orbs.filter((orb) => orb === 'frost').length, 2, 'one Frost was evoked to make room')
  assertEqual(next.players[0].block, 1, 'and the evoked Frost granted its Block')
})

check('Dual Cast evokes twice', () => {
  const dual = instance('dual_cast')
  const state = combat(
    [player({ hand: [dual], orbs: ['lightning', 'lightning', null] })],
    [enemy({ hp: 20 })],
  )
  const next = playCard(state, 'p1', dual.uid, { enemyUid: 'e1', playerId: 'p1' })
  assertEqual(next.enemies[0].hp, 16, 'two Lightning evokes deal 2 damage each')
  assertDeepEqual(next.players[0].orbs, [null, null, null], 'both orbs are spent')
})

// p.16: Lightning evokes for 2, Frost for 1 Block, Dark for 3 plus one per Power.
check('each orb type evokes for its printed effect', () => {
  const dual = instance('dual_cast')
  const frost = playCard(
    combat([player({ hand: [dual], orbs: ['frost', null, null] })], [enemy()]),
    'p1', dual.uid, { enemyUid: 'e1', playerId: 'p1' },
  )
  assertEqual(frost.players[0].block, 1, 'Frost evokes for 1 Block')

  const darkState = combat([player({ hand: [dual], orbs: ['dark', null, null] })], [enemy({ hp: 20 })])
  const dark = playCard(darkState, 'p1', dual.uid, { enemyUid: 'e1', playerId: 'p1' })
  assertEqual(dark.enemies[0].hp, 17, 'Dark evokes for 3 with no Powers in play')
})

check('a Dark orb evokes for 3 plus one per Power in play', () => {
  const dual = instance('dual_cast')
  const state = combat(
    [player({ hand: [dual], orbs: ['dark', null, null], powers: [instance('p1'), instance('p2')] })],
    [enemy({ hp: 20 })],
  )
  const next = playCard(state, 'p1', dual.uid, { enemyUid: 'e1', playerId: 'p1' })
  assertEqual(next.enemies[0].hp, 15, '3 base plus 1 for each of the two Powers')
})

check('evoking an empty board does nothing rather than throwing', () => {
  const dual = instance('dual_cast')
  const next = playCard(combat([player({ hand: [dual] })], [enemy()]), 'p1', dual.uid, {
    enemyUid: 'e1', playerId: 'p1',
  })
  assertEqual(next.enemies[0].hp, 20, 'no orbs, no damage')
  assertDeepEqual(next.players[0].orbs, [null, null, null])
})

// p.16: at end of turn Lightning deals 1 and Frost grants 1 Block; Dark waits.
check('orbs fire their passive at the end of the turn', () => {
  const state = combat([player({ orbs: ['lightning', 'frost', 'dark'] })], [enemy({ hp: 20 })])
  const next = endPlayerTurn(state)
  assertEqual(next.enemies[0].hp, 19, 'the Lightning orb deals 1')
  assertEqual(next.players[0].block, 1, 'the Frost orb grants 1 Block')
  assertDeepEqual(next.players[0].orbs, ['lightning', 'frost', 'dark'], 'passives do not consume orbs')
})

check('a Dark orb does nothing at end of turn', () => {
  const next = endPlayerTurn(combat([player({ orbs: ['dark', null, null] })], [enemy({ hp: 20 })]))
  assertEqual(next.enemies[0].hp, 20, 'Dark only pays out when evoked')
  assertEqual(next.players[0].block, 0)
})

check('Eruption enters Wrath and Vigilance enters Calm', () => {
  const eruption = instance('eruption')
  const wrath = playCard(
    combat([player({ character: 'watcher', hand: [eruption], energy: 3 })], [enemy()]),
    'p1', eruption.uid, { enemyUid: 'e1', playerId: 'p1' },
  )
  assertEqual(wrath.players[0].stance, 'wrath')
  assertEqual(wrath.enemies[0].hp, 18, 'Eruption deals 2 before the stance applies')

  const vigilance = instance('vigilance')
  const calm = playCard(
    combat([player({ character: 'watcher', hand: [vigilance], energy: 3 })], [enemy()]),
    'p1', vigilance.uid, { enemyUid: null, playerId: 'p1' },
  )
  assertEqual(calm.players[0].stance, 'calm')
  assertEqual(calm.players[0].block, 2, 'and grants its Block')
})

// p.17: leaving Calm grants 2 Energy; entering a stance you are in is ignored.
check('leaving Calm pays out two Energy', () => {
  const eruption = instance('eruption')
  const state = combat(
    [player({ character: 'watcher', hand: [eruption], stance: 'calm', energy: 3 })],
    [enemy()],
  )
  const next = playCard(state, 'p1', eruption.uid, { enemyUid: 'e1', playerId: 'p1' })
  assertEqual(next.players[0].stance, 'wrath')
  assertEqual(next.players[0].energy, 3, 'paid 2 for Eruption, then gained 2 for leaving Calm')
})

check('entering the stance you are already in is ignored', () => {
  const vigilance = instance('vigilance')
  const state = combat(
    [player({ character: 'watcher', hand: [vigilance], stance: 'calm', energy: 3 })],
    [enemy()],
  )
  const next = playCard(state, 'p1', vigilance.uid, { enemyUid: null, playerId: 'p1' })
  assertEqual(next.players[0].stance, 'calm')
  assertEqual(next.players[0].energy, 1, 'no Calm-exit bonus, because Calm was never left')
})

check('Wrath adds one damage to every hit', () => {
  const strike = instance('strike_watcher')
  const state = combat(
    [player({ character: 'watcher', hand: [strike], stance: 'wrath' })],
    [enemy({ hp: 20 })],
  )
  const next = playCard(state, 'p1', strike.uid, { enemyUid: 'e1', playerId: 'p1' })
  assertEqual(next.enemies[0].hp, 18, 'a 1-damage Strike hits for 2 in Wrath')
})

suite('player statuses')

// Enemies can Weaken players and make them Vulnerable; both were no-ops before.
check('an enemy action actually applies Weak to the player in its row', () => {
  const state = inEnemyPhase(
    [player({ id: 'p1', row: 0 }), player({ id: 'p2', row: 1 })],
    // Slot 1 of the Blue Slaver's track is the attack that Weakens.
    [enemy({ defId: 'blue_slaver', hp: 7, actionIndex: 1 })],
  )
  const next = enemyTurn(state)
  assertEqual(next.players[0].weak, 1, 'the player sharing the row is Weakened')
  assertEqual(next.players[1].weak, 0, 'a player in another row is not')
  assertEqual(next.players[0].hp, 8, 'and still takes the attack')
})

check('a Weak player deals one less damage per hit', () => {
  const strike = instance('strike_ironclad', true)
  const state = combat([player({ hand: [strike], weak: 1 })], [enemy({ hp: 20 })])
  const next = playCard(state, 'p1', strike.uid, { enemyUid: 'e1', playerId: 'p1' })
  assertEqual(next.enemies[0].hp, 19, 'Strike+ deals 2, reduced to 1 by Weak')
})

// p.24: a Weak attacker spends one token by attacking, player or enemy alike.
check('a Weak player spends a token when they attack', () => {
  const strike = instance('strike_ironclad')
  const state = combat([player({ hand: [strike], weak: 2 })], [enemy({ hp: 20 })])
  const next = playCard(state, 'p1', strike.uid, { enemyUid: 'e1', playerId: 'p1' })
  assertEqual(next.players[0].weak, 1, 'exactly one Weak token comes off')
  assertEqual(next.enemies[0].hp, 20, 'and the 1-damage Strike is reduced to 0 by Weak')
})

check('a multi-hit spends only one Weak token', () => {
  const twin = instance('twin_strike')
  const state = combat([player({ hand: [twin], weak: 2 })], [enemy({ hp: 20 })])
  const next = playCard(state, 'p1', twin.uid, { enemyUid: 'e1', playerId: 'p1' })
  assertEqual(next.players[0].weak, 1, 'a multi-hit is one attack, so one token')
})

check('a card that hits nothing does not spend Weak', () => {
  const strike = instance('strike_ironclad')
  const state = combat([player({ hand: [strike], weak: 1 })], [enemy({ dead: true })])
  const next = playCard(state, 'p1', strike.uid, { enemyUid: 'e1', playerId: 'p1' })
  assertEqual(next.players[0].weak, 1, 'no target, no attack, no token spent')
})

check('a non-attack card does not spend Weak', () => {
  const defend = instance('defend_ironclad')
  const state = combat([player({ hand: [defend], weak: 1 })], [enemy()])
  const next = playCard(state, 'p1', defend.uid, { enemyUid: null, playerId: 'p1' })
  assertEqual(next.players[0].weak, 1, 'Block is not an attack')
})

check('a Vulnerable player takes doubled damage from enemies', () => {
  const exposed = enemyTurn({ ...inEnemyPhase([player({ vulnerable: 1 })], [enemy()]), die: 1 })
  assertEqual(exposed.players[0].hp, 7, 'a 1-damage attack doubles to 2')
  assertEqual(exposed.players[0].vulnerable, 0, 'and one token is spent')

  const safe = enemyTurn({ ...inEnemyPhase([player()], [enemy()]), die: 1 })
  assertEqual(safe.players[0].hp, 8, 'without Vulnerable the same attack deals 1')
})

check('an enemy attacking an empty row does not spend its Weak', () => {
  // The enemy sits in row 0; the only player is in row 1, so its row-targeted
  // attack finds nobody.
  const state = {
    ...inEnemyPhase([player({ id: 'p1', row: 1 })], [enemy({ row: 0, weak: 1 })]),
    die: 1,
  }
  const next = enemyTurn(state)
  assertEqual(next.enemies[0].weak, 1, 'no target, no attack, no token spent')
  assertEqual(next.players[0].hp, 9, 'and the player in another row is untouched')
})

check('a Weak enemy attacking a Vulnerable player cancels both', () => {
  const next = enemyTurn({
    ...inEnemyPhase([player({ vulnerable: 1 })], [enemy({ weak: 1 })]),
    die: 1,
  })
  assertEqual(next.players[0].hp, 8, 'neither applies, so the attack deals its printed 1')
  assertEqual(next.players[0].vulnerable, 0, 'the Vulnerable token is still spent')
  assertEqual(next.enemies[0].weak, 0, 'and so is the Weak token')
})

check('player tokens clamp at their caps', () => {
  const state = combat([player({ vulnerable: 3, weak: 3 })], [enemy()])
  assertEqual(state.players[0].vulnerable, 3)
  assertEqual(state.players[0].weak, 3)
})


suite('relics')

const withRelic = (defId, over = {}) =>
  player({ relics: [{ defId, spent: false }], ...over })

// Relics were defined but nothing fired them, so a player "had" a relic that
// did nothing. These pin each trigger point.
check('a start-of-combat relic fires on turn 1 only', () => {
  const deck = Array.from({ length: 10 }, () => instance('strike_ironclad'))
  let state = createCombat(createRng(5), [withRelic('akabeko', { draw: deck })], [enemy()])
  state = startPlayerTurn(state)
  assertEqual(state.players[0].strength, 1, 'Akabeko grants 1 Strength at the start of combat')

  state = startPlayerTurn({ ...state, phase: 'player' })
  assertEqual(state.players[0].strength, 1, 'and does not fire again on turn 2')
})

check('a start-of-combat draw relic fills the hand further', () => {
  const deck = Array.from({ length: 12 }, () => instance('strike_silent'))
  const state = startPlayerTurn(
    createCombat(createRng(5), [withRelic('ring_of_the_snake', { draw: deck })], [enemy()]),
  )
  assertEqual(state.players[0].hand.length, 7, 'five drawn plus two from Ring of the Snake')
})

check('a die relic fires only on its faces', () => {
  const deck = Array.from({ length: 10 }, () => instance('strike_ironclad'))
  // Happy Flower pays out on a 3 or a 4.
  let hit = 0
  let missed = 0
  for (let seed = 0; seed < 60; seed++) {
    const state = startPlayerTurn(
      createCombat(createRng(seed), [withRelic('happy_flower', { draw: [...deck] })], [enemy()]),
    )
    const energy = state.players[0].energy
    if (state.die === 3 || state.die === 4) {
      assertEqual(energy, 4, `seed ${seed}: rolled ${state.die}, Happy Flower should grant Energy`)
      hit++
    } else {
      assertEqual(energy, 3, `seed ${seed}: rolled ${state.die}, Happy Flower should stay silent`)
      missed++
    }
  }
  assert(hit > 0 && missed > 0, 'the sample should cover both matching and non-matching rolls')
})

check('an end-of-combat relic fires when the last enemy dies', () => {
  const strike = instance('strike_ironclad')
  const state = createCombat(
    createRng(5),
    [withRelic('burning_blood', { hand: [strike], hp: 5 })],
    [enemy({ hp: 1 })],
  )
  const next = playCard(state, 'p1', strike.uid, { enemyUid: 'e1', playerId: 'p1' })
  assertEqual(next.phase, 'won')
  assertEqual(next.players[0].hp, 6, 'Burning Blood heals 1 at the end of combat')
})

check('a dead player\'s relics do not fire', () => {
  const deck = Array.from({ length: 10 }, () => instance('strike_ironclad'))
  const state = startPlayerTurn(
    createCombat(
      createRng(5),
      [
        withRelic('akabeko', { id: 'p1', dead: true, hp: 0, draw: deck }),
        withRelic('akabeko', { id: 'p2', row: 1, draw: [...deck] }),
      ],
      [enemy()],
    ),
  )
  assertEqual(state.players[0].strength, 0, 'the dead gain nothing from their relics')
  assertEqual(state.players[1].strength, 1, 'the living player still benefits from their own')
})

check('one player\'s relic never fires for another', () => {
  const deck = Array.from({ length: 12 }, () => instance('strike_ironclad'))
  const state = startPlayerTurn(
    createCombat(
      createRng(5),
      [
        withRelic('akabeko', { id: 'p1', draw: deck }),
        player({ id: 'p2', row: 1, draw: [...deck] }),
      ],
      [enemy()],
    ),
  )
  assertEqual(state.players[0].strength, 1, 'the owner gets the Strength')
  assertEqual(state.players[1].strength, 0, 'the other player gets nothing')
})

check('a player with no relics is unaffected', () => {
  const deck = Array.from({ length: 10 }, () => instance('strike_ironclad'))
  const state = startPlayerTurn(createCombat(createRng(5), [player({ draw: deck })], [enemy()]))
  assertEqual(state.players[0].strength, 0)
  assertEqual(state.players[0].energy, 3)
  assertEqual(state.players[0].hand.length, 5)
})

report('orbs, stances, statuses and relics')
