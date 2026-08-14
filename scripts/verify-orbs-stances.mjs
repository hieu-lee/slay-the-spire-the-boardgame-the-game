// Defect orbs, Watcher stances, Scry, and the player-side status tokens that
// enemies apply. These were no-ops until now, so Zap and Dual Cast sat in the
// Defect's starter deck doing nothing.
import {
  beginEndPlayerTurn,
  createCombat,
  endPlayerTurn,
  endTurnAbilities,
  enemyTurn,
  playCard,
  startPlayerTurn,
} from '../src/game/combat.ts'
import { gainVulnerable, gainWeak } from '../src/game/damage.ts'
import { STARTING_RELIC } from '../src/game/relics.ts'
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
  strength: 0, vulnerable: 0, weak: 0, poison: 0, actionIndex: 0, abilityUsed: true, dead: false, ...over,
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
  const next = playCard(state, 'p1', zap.uid, {
    enemyUid: 'e1', playerId: 'p1', evokeSlots: [0], evokeEnemyUids: [null],
  })
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
  const next = playCard(state, 'p1', dual.uid, {
    enemyUid: null, playerId: 'p1', evokeSlots: [0], evokeEnemyUids: ['e1', 'e1'],
  })
  assertEqual(next.enemies[0].hp, 16, 'two Lightning evokes deal 2 damage each')
  assertDeepEqual(next.players[0].orbs, [null, 'lightning', null], 'only the chosen Orb is spent')
})

check('each repeated evoke of the chosen Orb can choose its own enemy', () => {
  const dual = instance('dual_cast')
  const state = combat(
    [player({ hand: [dual], orbs: ['lightning', 'frost', 'dark'] })],
    [enemy({ uid: 'e1' }), enemy({ uid: 'e2', row: 1 })],
  )
  const next = playCard(state, 'p1', dual.uid, {
    enemyUid: null,
    playerId: 'p1',
    evokeSlots: [2],
    evokeEnemyUids: ['e2', 'e1'],
  })
  assertDeepEqual(next.players[0].orbs, ['lightning', 'frost', null], 'only the chosen Dark is spent')
  assertDeepEqual(next.enemies.map((target) => target.hp), [17, 17], 'each Dark evoke uses its own enemy')
})

check('a forced full-board channel uses the chosen Orb slot', () => {
  const zap = instance('zap')
  const state = combat(
    [player({ hand: [zap], orbs: ['lightning', 'frost', 'dark'] })],
    [enemy()],
  )
  const next = playCard(state, 'p1', zap.uid, {
    enemyUid: null,
    playerId: 'p1',
    evokeSlots: [1],
    evokeEnemyUids: [null],
  })
  assertDeepEqual(next.players[0].orbs, ['lightning', 'lightning', 'dark'])
  assertEqual(next.players[0].block, 1, 'the chosen Frost evokes before Lightning fills its slot')
})

check('Charge Battery channels Frost only from a full Orb board', () => {
  const quietCard = instance('charge_battery')
  const quiet = playCard(
    combat([player({ hand: [quietCard], orbs: ['lightning', 'dark', null] })], [enemy()]),
    'p1', quietCard.uid, { enemyUid: null, playerId: 'p1' },
  )
  assertEqual(quiet.players[0].block, 2)
  assertDeepEqual(quiet.players[0].orbs, ['lightning', 'dark', null], 'two Orbs do not satisfy the condition')

  const fullCard = instance('charge_battery', true)
  const full = playCard(
    combat([player({ hand: [fullCard], orbs: ['lightning', 'frost', 'dark'] })], [enemy()]),
    'p1', fullCard.uid, {
      enemyUid: null,
      playerId: 'p1',
      evokeSlots: [1],
      evokeEnemyUids: [null],
    },
  )
  assertEqual(full.players[0].block, 4, 'Charge Battery+ gives 3 Block and its evoked Frost gives 1')
  assertDeepEqual(full.players[0].orbs, ['lightning', 'frost', 'dark'], 'Frost refills the chosen slot')
})

check('Chaos channels the Orb printed for the shared die', () => {
  for (const [die, orb] of [[1, 'lightning'], [2, 'lightning'], [3, 'frost'], [4, 'frost'], [5, 'dark'], [6, 'dark']]) {
    const card = instance('chaos')
    const state = { ...combat([player({ hand: [card] })], [enemy()]), die }
    const next = playCard(state, 'p1', card.uid, { enemyUid: null, playerId: 'p1' })
    assertEqual(next.players[0].orbs[0], orb, `die ${die}`)
    assertEqual(next.players[0].energy, 2, `Chaos costs 1 on die ${die}`)
  }

  const card = instance('chaos', true)
  const state = { ...combat([player({ hand: [card], orbs: ['lightning', 'frost', 'dark'] })], [enemy()]), die: 6 }
  const full = playCard(state, 'p1', card.uid, {
    enemyUid: null, playerId: 'p1', evokeSlots: [1], evokeEnemyUids: [null],
  })
  assertDeepEqual(full.players[0].orbs, ['lightning', 'dark', 'dark'])
  assertEqual(full.players[0].block, 1, 'the chosen Frost evokes before the die channels Dark')
  assertEqual(full.players[0].energy, 3, 'Chaos+ costs 0')
})

check('Recursion re-channels the exact Orb it evoked', () => {
  for (const upgraded of [false, true]) {
    const card = instance('recursion', upgraded)
    const state = combat(
      [player({ hand: [card], orbs: ['lightning', 'frost', 'dark'] })],
      [enemy({ uid: 'e1' }), enemy({ uid: 'e2', row: 1 })],
    )
    const next = playCard(state, 'p1', card.uid, {
      enemyUid: null, playerId: 'p1', evokeSlots: [2], evokeEnemyUids: ['e2'],
    })
    assertDeepEqual(next.players[0].orbs, ['lightning', 'frost', 'dark'])
    assertEqual(next.enemies[1].hp, 17, 'the chosen Dark evokes into the chosen enemy')
    assertEqual(next.players[0].energy, upgraded ? 3 : 2, `Recursion${upgraded ? '+' : ''} cost`)
  }
})

check('exact evoke choices reject malformed or stale plans atomically', () => {
  const make = () => {
    const dual = instance('dual_cast')
    return {
      dual,
      state: combat(
        [player({ hand: [dual], orbs: ['lightning', 'lightning', null] })],
        [enemy({ uid: 'e1', hp: 2, maxHp: 2 }), enemy({ uid: 'e2', row: 1 })],
      ),
    }
  }
  for (const context of [
    {},
    { evokeSlots: [0] },
    { evokeEnemyUids: ['e1', 'e2'] },
  ]) {
    const { dual, state } = make()
    assert(playCard(state, 'p1', dual.uid, {
      enemyUid: 'e1', playerId: 'p1', ...context,
    }) === state, `accepted incomplete plan ${JSON.stringify(context)}`)
  }
  for (const context of [
    { evokeSlots: [0, 1], evokeEnemyUids: ['e1', 'e2'] },
    { evokeSlots: [0], evokeEnemyUids: ['e1'] },
    { evokeSlots: [0], evokeEnemyUids: [null, 'e2'] },
  ]) {
    const { dual, state } = make()
    assert(playCard(state, 'p1', dual.uid, {
      enemyUid: null, playerId: 'p1', ...context,
    }) === state, `accepted ${JSON.stringify(context)}`)
  }

  const { dual, state } = make()
  const stale = playCard(state, 'p1', dual.uid, {
    enemyUid: null,
    playerId: 'p1',
    evokeSlots: [0],
    evokeEnemyUids: ['e1', 'e1'],
  })
  assert(stale === state, 'a later evoke silently retargeted after the first defeated its enemy')
  assertDeepEqual(state.enemies.map((target) => target.hp), [2, 20], 'the refused plan leaked damage')
})

check('a winning evoke ends combat before a later damaging evoke resolves', () => {
  const dual = instance('dual_cast')
  const state = combat(
    [player({ hand: [dual], orbs: ['lightning', 'lightning', null] })],
    [enemy({ uid: 'e1', hp: 2, maxHp: 2 })],
  )
  assert(playCard(state, 'p1', dual.uid, {
    enemyUid: null, playerId: 'p1', evokeSlots: [0], evokeEnemyUids: ['e1', 'forged'],
  }) === state, 'a surplus post-lethal target was accepted')
  const next = playCard(state, 'p1', dual.uid, {
    enemyUid: null,
    playerId: 'p1',
    evokeSlots: [0],
    evokeEnemyUids: ['e1'],
  })
  assert(next !== state, 'the winning play was rolled back when no target remained')
  assertEqual(next.phase, 'won')
  assertDeepEqual(next.players[0].orbs, [null, 'lightning', null], 'only the chosen Orb is removed')
})

// p.16: Lightning evokes for 2, Frost for 1 Block, Dark for 3 plus one per Power.
check('each orb type evokes for its printed effect', () => {
  const dual = instance('dual_cast')
  const frost = playCard(
    combat([player({ hand: [dual], orbs: ['frost', null, null] })], [enemy()]),
    'p1', dual.uid, { enemyUid: null, playerId: 'p1', evokeSlots: [0], evokeEnemyUids: [null, null] },
  )
  assertEqual(frost.players[0].block, 2, 'Dual Cast applies Frost Evoke twice')

  const darkState = combat([player({ hand: [dual], orbs: ['dark', null, null] })], [enemy({ hp: 20 })])
  const dark = playCard(darkState, 'p1', dual.uid, {
    enemyUid: null, playerId: 'p1', evokeSlots: [0], evokeEnemyUids: ['e1', 'e1'],
  })
  assertEqual(dark.enemies[0].hp, 14, 'Dual Cast applies Dark Evoke twice')
})

check('a Dark orb evokes for 3 plus one per Power in play', () => {
  const dual = instance('dual_cast')
  const state = combat(
    // Real Powers, not just real card ids: the dispatcher looks these up, and
    // only a Power can actually sit in front of you. Neither of these two
    // triggers on an evoke, so they add to the count without altering it.
    [player({
      hand: [dual],
      orbs: ['dark', null, null],
      powers: [instance('metallicize'), instance('demon_form')],
    })],
    [enemy({ hp: 20 })],
  )
  const next = playCard(state, 'p1', dual.uid, {
    enemyUid: null, playerId: 'p1', evokeSlots: [0], evokeEnemyUids: ['e1', 'e1'],
  })
  assertEqual(next.enemies[0].hp, 10, 'each Evoke is 3 base plus 1 for each of the two Powers')
})

check('an evoke card can be played on an empty board and simply does nothing', () => {
  const dual = instance('dual_cast')
  const next = playCard(combat([player({ hand: [dual] })], [enemy()]), 'p1', dual.uid, {
    enemyUid: 'e1', playerId: 'p1',
  })
  assertEqual(next.players[0].hand.length, 0)
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

check('each Orb can be targeted and interleaved as its own end-turn ability', () => {
  const shame = instance('shame')
  const state = combat([
    player({ orbs: ['lightning', 'frost', 'lightning'], hand: [shame], block: 1 }),
  ], [enemy({ uid: 'e1', hp: 2 }), enemy({ uid: 'e2', hp: 2, row: 1 })])
  const abilities = endTurnAbilities(state)
  assertEqual(abilities.filter((ability) => ability.id.includes('/orb:')).length, 3)
  const next = beginEndPlayerTurn(state, [
    'p1/orb:2@e2', `p1/card:${shame.uid}`, 'p1/orb:1', 'p1/orb:0@e1',
  ])
  assertDeepEqual(next.enemies.map((target) => target.hp), [1, 1], 'each Lightning uses its chosen target')
  assertEqual(next.players[0].block, 1, 'Frost can resolve after Shame instead of in one atomic Orb block')
})

check('a later Lightning never silently retargets after its chosen enemy dies', () => {
  const state = combat([
    player({ orbs: ['lightning', 'lightning', null] }),
  ], [enemy({ uid: 'e1', hp: 1 }), enemy({ uid: 'e2', hp: 2, row: 1 })])
  const rejected = beginEndPlayerTurn(state, ['p1/orb:0@e1', 'p1/orb:1@e1'])
  assert(rejected === state, 'the whole plan is rejected atomically so the player can choose again')
  assertDeepEqual(state.enemies.map((target) => target.hp), [1, 2], 'no partial damage escapes the rejected plan')
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
  assertEqual(next.players[0].hp, 7, 'and still takes the printed 3 damage')
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
  // Through the functions that actually clamp. Building a fixture with the cap
  // already set and asserting it is still the cap tests the fixture, not the
  // engine — createCombat clamps nothing.
  assertEqual(gainVulnerable(2, 5), 3, 'Vulnerable caps at 3')
  assertEqual(gainWeak(1, 9), 3, 'Weak caps at 3')
  assertEqual(gainVulnerable(3, 1), 3, 'and stays there')
})


suite('relics')

const withRelic = (defId, over = {}) =>
  player({ relics: [{ defId, spent: false }], ...over })

// Relics were defined but nothing fired them, so a player "had" a relic that
// did nothing. These pin each trigger point.
check('Akabeko waits for its printed manual once-per-combat activation', () => {
  const deck = Array.from({ length: 10 }, () => instance('strike_ironclad'))
  let state = createCombat(createRng(5), [withRelic('anchor', { draw: deck })], [enemy()])
  state = startPlayerTurn(state)
  assertEqual(state.players[0].strength, 0, 'Akabeko does not grant digital-style permanent Strength')

  // A real round-trip. `startPlayerTurn` on a turn already begun is refused,
  // so the old version never reached turn 2 and asserted nothing.
  state = startPlayerTurn(enemyTurn(endPlayerTurn(state)))
  assertEqual(state.turn, 2, 'precondition: the second round must actually begin')
  assertEqual(state.players[0].strength, 0, 'and it stays inert until its owner activates it')
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

check('a dead player ends combat before any relics fire', () => {
  const deck = Array.from({ length: 10 }, () => instance('strike_ironclad'))
  const state = startPlayerTurn(
    createCombat(
      createRng(5),
      [
        withRelic('anchor', { id: 'p1', dead: true, hp: 0, draw: deck }),
        withRelic('anchor', { id: 'p2', row: 1, draw: [...deck] }),
      ],
      [enemy()],
    ),
  )
  assertEqual(state.players[0].strength, 0, 'the dead gain nothing from their relics')
  assertEqual(state.players[1].strength, 0, 'nothing resolves after the party loses')
  assertEqual(state.phase, 'lost')
})

check('one player\'s relic never fires for another', () => {
  const deck = Array.from({ length: 12 }, () => instance('strike_ironclad'))
  const state = startPlayerTurn(
    createCombat(
      createRng(5),
      [
        withRelic('anchor', { id: 'p1', draw: deck }),
        player({ id: 'p2', row: 1, draw: [...deck] }),
      ],
      [enemy()],
    ),
  )
  assertEqual(state.players[0].strength, 0, 'the owner must activate the once-per-combat effect')
  assertEqual(state.players[1].strength, 0, 'the other player gets nothing')
})

check('a player with no relics is unaffected', () => {
  const deck = Array.from({ length: 10 }, () => instance('strike_ironclad'))
  const state = startPlayerTurn(createCombat(createRng(5), [player({ draw: deck })], [enemy()]))
  assertEqual(state.players[0].strength, 0)
  assertEqual(state.players[0].energy, 3)
  assertEqual(state.players[0].hand.length, 5)
})


check('only leaving Calm pays out Energy', () => {
  // Reachable with the shipped Watcher deck: Eruption enters Wrath, then
  // Vigilance enters Calm. Leaving WRATH must not refund anything.
  const eruption = instance('eruption')
  const vigilance = instance('vigilance')
  let state = combat(
    // Enough Energy for both: Eruption is 2 and Vigilance is 2, so a starting
    // 3 would leave the second play refused for cost rather than stance.
    [player({ character: 'watcher', hand: [eruption, vigilance], energy: 6 })],
    [enemy({ hp: 20 })],
  )
  state = playCard(state, 'p1', eruption.uid, { enemyUid: 'e1', playerId: 'p1' })
  assertEqual(state.players[0].stance, 'wrath', 'precondition: Eruption enters Wrath')
  const afterWrath = state.players[0].energy

  state = playCard(state, 'p1', vigilance.uid, { enemyUid: null, playerId: 'p1' })
  assertEqual(state.players[0].stance, 'calm', 'Vigilance enters Calm')
  assertEqual(
    state.players[0].energy,
    afterWrath - 2,
    'leaving Wrath refunds nothing; only leaving Calm does',
  )
})

check('channelling fills the next free slot rather than forcing an evoke', () => {
  // The all-empty and all-full cases were covered; the partially filled one —
  // the only case that distinguishes "fill a slot" from "always evoke" — was
  // not.
  const first = instance('zap')
  const second = instance('zap')
  let state = combat(
    [player({ character: 'defect', hand: [first, second], orbs: [null, null, null], energy: 3 })],
    [enemy({ hp: 20 })],
  )
  state = playCard(state, 'p1', first.uid, { enemyUid: 'e1', playerId: 'p1' })
  state = playCard(state, 'p1', second.uid, { enemyUid: 'e1', playerId: 'p1' })
  assertDeepEqual(
    state.players[0].orbs,
    ['lightning', 'lightning', null],
    'two channels fill two slots; neither should have forced an evoke',
  )
  assertEqual(state.enemies[0].hp, 20, 'and nothing was evoked at an enemy')
})

check('each character starts with the relic printed on their board', () => {
  const PRINTED = {
    ironclad: 'burning_blood',
    silent: 'ring_of_the_snake',
    defect: 'cracked_core',
    watcher: 'pure_water',
  }
  for (const [character, defId] of Object.entries(PRINTED)) {
    assertEqual(STARTING_RELIC[character], defId, `${character} starting relic`)
  }
})

check('a Daze cannot be played out of hand', () => {
  // `unplayable` was only ever tested through a fixture, never through the one
  // real card that carries it.
  const daze = instance('daze')
  const state = combat([player({ hand: [daze] })], [enemy({ hp: 20 })])
  assert(
    playCard(state, 'p1', daze.uid, { enemyUid: 'e1', playerId: 'p1' }) === state,
    'a Daze is dead weight, not a free discard',
  )
})

check("every character's Defend+ can be given to an ally", () => {
  // Three of the four come from a shared factory and only the hand-written
  // Ironclad copy was tested — two copies of one card is the drift this
  // codebase guards against elsewhere.
  for (const character of ['ironclad', 'silent', 'defect', 'watcher']) {
    const defend = instance(`defend_${character}`, true)
    const next = playCard(
      combat(
        [player({ id: 'p1', character, hand: [defend] }), player({ id: 'p2', row: 1 })],
        [enemy()],
      ),
      'p1',
      defend.uid,
      { enemyUid: null, playerId: 'p2' },
    )
    assertEqual(next.players[1].block, 2, `${character} Defend+ should reach the ally`)
    assertEqual(next.players[0].block, 0, `${character} Defend+ should not stay with the caster`)
  }
})

report('orbs, stances, statuses and relics')
