import {
  createCombat,
  endPlayerTurn,
  enemyActingOrder,
  enemyTurn,
  playCard,
  resolveStartPlayerTurn,
  startPlayerTurn,
  startTurnAbilities,
} from '../src/game/combat.ts'
import {
  actionsFor, actionsForEnemy, advanceCube, createSummonSupply, drawSummon, enemyDef, startingHp,
} from '../src/game/enemies.ts'
import { CARDS, STARTER_DECKS, faceOf } from '../src/game/cards.ts'
import { createRng } from '../src/game/rng.ts'
import { suite, check, assert, assertEqual, assertDeepEqual, report } from './lib/harness.mjs'

let uid = 0
const instance = (defId, upgraded = false) => ({ uid: `c${uid++}`, defId, upgraded })

const player = (over = {}) => ({
  id: 'p1', name: 'Ironclad', character: 'ironclad', row: 0,
  hp: 10, maxHp: 10, block: 0, energy: 3,
  deck: [], draw: [], hand: [], discard: [], exhaust: [], powers: [],
  gold: 0, relics: [], potions: [], cardRewards: [], rareRewards: [],
  strength: 0, vulnerable: 0, weak: 0, shivs: 0, miracles: 0, stance: 'neutral', orbs: [null, null, null],
  dead: false, ...over,
})

const enemy = (over = {}) => ({
  uid: 'e1', defId: 'red_louse', row: 0, isBoss: false,
  hp: 6, maxHp: 6, block: 0,
  strength: 0, vulnerable: 0, weak: 0, poison: 0, actionIndex: 0, abilityUsed: true, dead: false, ...over,
})

/** Puts a combat straight into the Enemy Turn without playing a Player Turn. */
const inEnemyPhase = (players, enemies) => ({
  ...createCombat(createRng(42), players, enemies),
  phase: 'enemy',
})

suite('enemy turn')

check('enemies attack the player in their own row', () => {
  const state = inEnemyPhase(
    [player({ id: 'p1', row: 0 }), player({ id: 'p2', row: 1 })],
    [enemy({ defId: 'green_louse', row: 0 })],
  )
  const next = enemyTurn(state)
  assertEqual(next.players[0].hp, 9, 'the player sharing the row takes the hit')
  assertEqual(next.players[1].hp, 10, 'a player in another row is untouched')
})

check('player Block absorbs an enemy attack', () => {
  const next = enemyTurn(inEnemyPhase([player({ block: 3 })], [enemy({ defId: 'green_louse' })]))
  assertEqual(next.players[0].hp, 10, 'Block prevents the damage')
  assertEqual(next.players[0].block, 2, 'and one Block is spent doing so')
})

// p.13: enemy Block is cleared at the start of the ENEMY turn, not the player's.
check('enemy Block clears at the start of the Enemy Turn', () => {
  const next = enemyTurn(inEnemyPhase([player()], [enemy({ defId: 'green_louse', block: 4 })]))
  assertEqual(next.enemies[0].block, 0, 'leftover enemy Block is removed before it acts')
})

check('player Block is NOT cleared by the Enemy Turn', () => {
  const next = enemyTurn(inEnemyPhase([player({ block: 5 })], [enemy({ defId: 'green_louse', block: 4 })]))
  assertEqual(next.players[0].block, 4, 'player Block persists into the Enemy Turn, minus what it absorbed')
})

check('the Jaw Worm gains Strength after its 5-6 attack', () => {
  const state = inEnemyPhase([player()], [enemy({ defId: 'jaw_worm', hp: 10 })])
  const next = enemyTurn({ ...state, die: 5 })
  assertEqual(next.enemies[0].block, 0, 'the 5-6 row has no Block')
  assertEqual(next.players[0].block, 0, 'the player gains nothing')
  assertEqual(next.enemies[0].strength, 1, 'and gains 1 Strength on that roll')
  assertEqual(next.players[0].hp, 8, 'that roll attacks for 2 before gaining Strength')
})

// Transcribed from the Jaw Worm card: 1-2 is 3 damage + 1 Block, 3-4 is 4
// damage, 5-6 is 2 damage + 1 Strength.
check('a die-pattern enemy acts on the shared roll', () => {
  const state = inEnemyPhase([player()], [enemy({ defId: 'jaw_worm', hp: 10 })])
  const rolled1 = enemyTurn({ ...state, die: 1 })
  assertEqual(rolled1.players[0].hp, 7, 'on a 1 the Jaw Worm hits for 3')
  assertEqual(rolled1.enemies[0].block, 1, 'and blocks itself for 1')

  const rolled3 = enemyTurn({ ...state, die: 3 })
  assertEqual(rolled3.players[0].hp, 6, 'on a 3 it hits for 4')
  assertEqual(rolled3.enemies[0].block, 0, 'with no Block on that roll')
})

check('enemy Strength adds to its attacks', () => {
  const next = enemyTurn(inEnemyPhase([player()], [enemy({ defId: 'green_louse', strength: 2 })]))
  assertEqual(next.players[0].hp, 7, 'a 1-damage attack with 2 Strength deals 3')
})

check('Snake Plant spends modifiers once across its two different printed hits', () => {
  const state = inEnemyPhase(
    [player({ hp: 20, maxHp: 20, vulnerable: 2 })],
    [enemy({ defId: 'snake_plant', hp: 17, maxHp: 17, weak: 2 })],
  )
  const next = enemyTurn({ ...state, die: 1 })
  assertEqual(next.players[0].hp, 15, 'the 3 and 2 hits both use the starting modifiers')
  assertEqual(next.players[0].vulnerable, 1, 'the whole sequence spends one Vulnerable')
  assertEqual(next.enemies[0].weak, 1, 'the whole sequence spends one Weak')

  const multiplayer = inEnemyPhase(
    [player({ id: 'p1', row: 0 }), player({ id: 'p2', name: 'Silent', row: 1 })],
    [enemy({ defId: 'snake_plant', ascension: 7, hp: 17, maxHp: 17 })],
  )
  const spread = enemyTurn({ ...multiplayer, die: 1 })
  assertEqual(spread.players[0].hp, 5, 'the row target takes both printed hits')
  assertEqual(spread.players[1].hp, 8, 'the later AoE hit still reaches every other player')
})

check('Act II elite rows preserve single-row and AoE icons from the cards', () => {
  const book = enemyTurn(inEnemyPhase(
    [player({ id: 'p1', row: 0 }), player({ id: 'p2', name: 'Silent', row: 1 })],
    [enemy({ defId: 'book_of_stabbing', row: 0, hp: 60, maxHp: 60, actionIndex: 1 })],
  ))
  assertEqual(book.players[0].hp, 7, 'Book of Stabbing large hit stays in its row')
  assertEqual(book.players[1].hp, 10, 'the large hit is not AoE')

  const taskmaster = enemyTurn(inEnemyPhase(
    [player({ id: 'p1', row: 0 }), player({ id: 'p2', name: 'Silent', row: 1 })],
    [enemy({ defId: 'taskmaster', ascension: 1, hp: 32, maxHp: 32, actionIndex: 1 })],
  ))
  assertEqual(taskmaster.players[0].hp, 8, 'Taskmaster repeating A1 row deals its printed 2 damage to all')
  assertEqual(taskmaster.players[1].hp, 8)
  assertEqual(taskmaster.players[0].draw.filter((card) => card.defId === 'daze').length, 2)
  assertEqual(taskmaster.players[1].draw.filter((card) => card.defId === 'daze').length, 2)
  assertEqual(taskmaster.enemies[0].strength, 1)
})

// p.13: highest row first, left to right, and bosses always act last.
check('enemies act from the highest row down, bosses last', () => {
  const state = inEnemyPhase(
    [player()],
    [
      enemy({ uid: 'low', row: 0 }),
      enemy({ uid: 'boss', row: 3, isBoss: true }),
      enemy({ uid: 'high', row: 2 }),
      enemy({ uid: 'mid', row: 1 }),
    ],
  )
  assertDeepEqual(
    enemyActingOrder(state).map((e) => e.uid),
    ['high', 'mid', 'low', 'boss'],
    'highest row acts first and the boss is always last despite sitting in the highest row',
  )
})

check('acting order skips the dead', () => {
  const state = inEnemyPhase(
    [player()],
    [enemy({ uid: 'a', row: 1 }), enemy({ uid: 'b', row: 0, dead: true })],
  )
  assertDeepEqual(enemyActingOrder(state).map((e) => e.uid), ['a'])
})

check('an area-of-effect enemy action hits every player', () => {
  const state = inEnemyPhase(
    [player({ id: 'p1', row: 0 }), player({ id: 'p2', row: 1 }), player({ id: 'p3', row: 2 })],
    [enemy({ row: 0 })],
  )
  // The Gremlin Nob's attack carries the area-of-effect symbol.
  const aoe = {
    ...state,
    enemies: [{ ...state.enemies[0], defId: 'gremlin_nob', hp: 28, actionIndex: 1 }],
  }
  const next = enemyTurn(aoe)
  assertEqual(next.players[0].hp, 7, 'every player takes the 3 damage')
  assertEqual(next.players[1].hp, 7, 'including those in other rows')
  assertEqual(next.players[2].hp, 7)
})

// p.13: the cube walks down and loops to the topmost RED slot; grey slots fire once.
// The Gremlin Nob sleeps on turn 1 (a grey slot) then attacks forever.
check('a cube enemy runs its one-time slot then loops past it', () => {
  const nob = enemyDef('gremlin_nob')
  assertDeepEqual(actionsFor(nob, 1, 0), [{ kind: 'idle' }], 'the grey slot does nothing')
  assertEqual(advanceCube(nob, 0), 1, 'the cube moves down')
  assertEqual(advanceCube(nob, 1), 1, 'at the bottom it returns to the topmost RED slot, skipping the grey one')
})

check('the Blue Slaver uses the official die rows', () => {
  const state = inEnemyPhase([player()], [enemy({ defId: 'blue_slaver', hp: 10 })])
  const low = enemyTurn({ ...state, die: 1 })
  assertEqual(low.players[0].hp, 8, '1-2 attacks for 2')
  assertEqual(low.players[0].weak, 1, '1-2 also applies Weak')

  const middle = enemyTurn({ ...state, die: 3 })
  assertEqual(middle.players[0].hp, 7, '3-4 attacks for 3')

  const high = enemyTurn({ ...state, die: 5 })
  assertEqual(high.players[0].hp, 8, '5-6 attacks for 2')
  assertEqual(high.players[0].draw[0]?.defId, 'daze', '5-6 puts Daze on top of draw')
})

// The Cultist card shows one action with no dice column: 1 damage and 1
// Strength, every turn. Its damage therefore climbs as it buffs itself.
check('a single-action enemy repeats the same action every turn', () => {
  let state = inEnemyPhase([player()], [enemy({ defId: 'cultist', hp: 9 })])
  state = enemyTurn(state)
  assertEqual(state.players[0].hp, 9, 'the first hit lands before the Strength does')
  assertEqual(state.enemies[0].strength, 1)

  state = enemyTurn({ ...state, phase: 'enemy' })
  assertEqual(state.players[0].hp, 7, 'the second hit carries the Strength it gained')
  assertEqual(state.enemies[0].strength, 2)
})

check('the Enemy Turn ends the round and waits', () => {
  const next = enemyTurn(inEnemyPhase([player()], [enemy()]))
  assertEqual(next.phase, 'roundEnd', 'the round is over, pending the next Start of Turn')
})

check('calling enemyTurn outside the enemy phase is refused', () => {
  const state = createCombat(createRng(1), [player()], [enemy()])
  assert(enemyTurn(state) === state, 'wrong phase must return the identical reference')
})

check('the Enemy Turn does not mutate the state handed in', () => {
  const state = inEnemyPhase([player()], [enemy()])
  const before = JSON.stringify(state)
  enemyTurn(state)
  assertEqual(JSON.stringify(state), before, 'enemyTurn must return a new state')
})

check('Spheric Guardian keeps its Block through the Enemy Turn', () => {
  const state = inEnemyPhase([player()], [enemy({ defId: 'spheric_guardian', hp: 5, maxHp: 5, block: 10 })])
  const next = enemyTurn(state)
  assertEqual(next.enemies[0].block, 15, 'Barricade keeps 10 Block before the printed 5 Block is added')
})

check('Flying caps each Hit rather than the whole Attack', () => {
  const twin = instance('twin_strike')
  const state = createCombat(
    createRng(5),
    [player({ hand: [twin], strength: 5 })],
    [enemy({ defId: 'byrd_s13', hp: 4, maxHp: 4 })],
  )
  const next = playCard(state, 'p1', twin.uid, { enemyUid: 'e1', playerId: 'p1' })
  assertEqual(next.enemies[0].hp, 2, 'two boosted Hits each deal exactly 1')
})

check('Snecko sets and spends the first-card Confused cost', () => {
  uid = 0
  const strike = instance('strike_ironclad')
  let state = createCombat(
    createRng(8),
    [player({ deck: [strike], draw: [strike] })],
    [enemy({ defId: 'snecko', hp: 23, maxHp: 23 })],
  )
  state = startPlayerTurn(state)
  const expected = state.die <= 2 ? 2 : state.die <= 4 ? 1 : 3
  assertEqual(state.players[0].nextCardCost, expected, 'the shared die selects Snecko\'s printed Confused value')
  const before = state.players[0].energy
  state = playCard(state, 'p1', state.players[0].hand[0].uid, { enemyUid: 'e1', playerId: 'p1' })
  assertEqual(state.players[0].energy, before - expected, 'the first card pays the Confused cost')
  assertEqual(state.players[0].nextCardCost, null, 'later cards return to their printed costs')
})

check('Centurion enters Fury immediately when its Mystic dies', () => {
  const strike = instance('strike_ironclad')
  let state = createCombat(
    createRng(5),
    [player({ hand: [strike] })],
    [
      enemy({ uid: 'centurion', defId: 'centurion_b3', hp: 15, maxHp: 15, abilityUsed: false }),
      enemy({ uid: 'mystic', defId: 'mystic_2sh', hp: 1, maxHp: 12 }),
    ],
  )
  state = playCard(state, 'p1', strike.uid, { enemyUid: 'mystic', playerId: 'p1' })
  assert(state.enemies[0].abilityUsed, 'Fury flips on as part of the death')
  assertEqual(state.enemies[0].strength, 1, 'Fury gains 1 Strength')
  state = enemyTurn({ ...state, phase: 'enemy', die: 1 })
  assertEqual(state.players[0].hp, 6, 'the Centurion immediately uses only its 3-damage attack with Strength')
  assertEqual(actionsForEnemy(state.enemies[0], 1)[0].kind, 'attack', 'the public intent follows the Fury action')
})

check('each Centurion blocks only the Mystic in its own row', () => {
  const state = inEnemyPhase(
    [player({ id: 'p1', row: 0 }), player({ id: 'p2', row: 1 })],
    [
      enemy({ uid: 'c0', defId: 'centurion_b3', row: 0, hp: 15, maxHp: 15, abilityUsed: false }),
      enemy({ uid: 'm0', defId: 'mystic', row: 0, hp: 12, maxHp: 12 }),
      enemy({ uid: 'c1', defId: 'centurion_b3', row: 1, hp: 15, maxHp: 15, abilityUsed: false }),
      enemy({ uid: 'm1', defId: 'mystic_2sh', row: 1, hp: 12, maxHp: 12 }),
    ],
  )
  const next = enemyTurn({ ...state, die: 1 })
  assertEqual(next.enemies.find((foe) => foe.uid === 'm0').block, 3, 'row 0 Mystic receives one Block action')
  assertEqual(next.enemies.find((foe) => foe.uid === 'm1').block, 3, 'row 1 Mystic receives one Block action')
})

check('Painful Stabs adds one Daze after any unblocked multi-hit', () => {
  const state = inEnemyPhase(
    [player({ block: 1 })],
    [enemy({ defId: 'book_of_stabbing', hp: 30, maxHp: 30, actionIndex: 0 })],
  )
  const next = enemyTurn(state)
  assertEqual(next.players[0].hp, 9, 'one of the two hits gets through the Block')
  assertEqual(next.players[0].draw.filter((card) => card.defId === 'daze').length, 1, 'Painful Stabs pays once, not per hit')
})

check('Fairy revival does not hide Painful Stabs damage', () => {
  const state = inEnemyPhase(
    [player({ hp: 1, maxHp: 10, potions: ['fairy_in_a_bottle'] })],
    [enemy({ defId: 'book_of_stabbing', hp: 30, maxHp: 30, actionIndex: 0 })],
  )
  const next = enemyTurn(state)
  assertEqual(next.players[0].draw.filter((card) => card.defId === 'daze').length, 1)
  assertEqual(next.log.filter((line) => /hit Ironclad for 1/.test(line)).length, 2,
    `missing separate physical hit logs: ${next.log.join(' | ')}`)
})

check('encounter Red Slavers act last only while applying Vulnerable', () => {
  for (let die = 1; die <= 6; die++) {
    const state = {
      ...inEnemyPhase(
        [player()],
        [enemy({ uid: 'red', defId: 'red_slaver_dv3' }), enemy({ uid: 'blue', defId: 'blue_slaver_wd3' })],
      ),
      die,
    }
    assertDeepEqual(
      enemyActingOrder(state).map((foe) => foe.uid),
      die === 3 || die === 4 ? ['blue', 'red'] : ['red', 'blue'],
      `ordinary die ${die}`,
    )
  }
})

check('summoned Red Slavers use their printed permanent Acts Last rule', () => {
  const taskmaster = inEnemyPhase(
    [player()],
    [enemy({ uid: 'red', defId: 'red_slaver_dv3', actsLast: true }), enemy({ uid: 'blue', defId: 'blue_slaver_wd3' })],
  )
  assertDeepEqual(enemyActingOrder({ ...taskmaster, die: 1 }).map((foe) => foe.uid), ['blue', 'red'])
})

check('Gremlin Leader revives every dead Gremlin on its third action', () => {
  const state = inEnemyPhase(
    [player()],
    [
      enemy({ uid: 'gremlin', defId: 'sneaky_gremlin', hp: 0, maxHp: 2, dead: true }),
      enemy({ uid: 'leader', defId: 'gremlin_leader', hp: 30, maxHp: 30, actionIndex: 2 }),
    ],
  )
  const next = enemyTurn(state)
  assert(!next.enemies[0].dead, 'the physical Gremlin card returns to play')
  assertEqual(next.enemies[0].hp, 2, 'it returns at its printed HP')
  assertEqual(next.players[0].hp, 10, 'a left-side Gremlin does not act again after the Leader revives it')
})

// A player at 0 HP ends the game for the whole party (p.13).
check('a player dying loses the game for everyone', () => {
  const next = enemyTurn(inEnemyPhase([player({ hp: 1 })], [enemy({ defId: 'green_louse', strength: 3 })]))
  assert(next.players[0].dead, 'the player should be dead')
  assertEqual(next.phase, 'lost', 'any death ends the run in defeat')
})

// The Spike Slime's 3-4 action inflicts a Daze. The pile helper was tested, but
// nothing covered the enemy action that uses it, so putting the Daze on the
// wrong pile went unnoticed.
check('an enemy Daze lands on TOP of the draw pile, not the discard pile', () => {
  const existing = instance('strike_ironclad')
  const state = {
    ...inEnemyPhase(
      [player({ draw: [existing], discard: [] })],
      [enemy({ defId: 'spike_slime', hp: 5 })],
    ),
    die: 3,
  }
  const next = enemyTurn(state)
  const target = next.players[0]
  assertEqual(target.draw.length, 2, 'the Daze joins the draw pile')
  assertEqual(target.draw[0].defId, 'daze', 'and sits on top, so it is drawn next (p.24)')
  assertEqual(target.draw[1].uid, existing.uid, 'the card that was there is pushed down')
  assertEqual(target.discard.length, 0, 'nothing goes to the discard pile')
})

check('a Daze-free roll adds no Daze at all', () => {
  const state = {
    ...inEnemyPhase([player({ draw: [] })], [enemy({ defId: 'spike_slime', hp: 5 })]),
    die: 5,
  }
  const next = enemyTurn(state)
  assertEqual(next.players[0].draw.length, 0, 'the 5-6 action is a plain attack')
  assertEqual(next.players[0].hp, 8, 'which deals 2')
})

check('HP scales with the party size', () => {
  const nob = enemyDef('gremlin_nob')
  assertEqual(startingHp(nob, 1), 15, 'solo uses the first HP column')
  assertEqual(startingHp(nob, 3), 45, 'three players use the third column')
  assertEqual(startingHp(nob, 4), 60, 'four players use the fourth column')
  assertEqual(startingHp(nob, 9), 60, 'more than four players clamps to the four-player column')
})

check('a full round runs Player Turn then Enemy Turn and repeats', () => {
  uid = 0
  let state = createCombat(
    createRng(7),
    [player({ draw: STARTER_DECKS.ironclad.map((id) => instance(id)) })],
    [enemy({ hp: 20 })],
  )
  state = startPlayerTurn(state)
  assertEqual(state.phase, 'player')
  const first = state.players[0].hand[0]
  state = playCard(state, 'p1', first.uid, { enemyUid: 'e1', playerId: 'p1' })
  state = endPlayerTurn(state)
  assertEqual(state.phase, 'enemy')
  // A round is a Player Turn followed by an Enemy Turn (p.12). The Enemy Turn
  // ends the round and the board holds there, so everyone can read what the
  // enemies did before the next Start of Turn sweeps up every hand.
  state = enemyTurn(state)
  assertEqual(state.phase, 'roundEnd', 'the round ends and holds')
  assertEqual(state.turn, 1, 'still one Player Turn taken')

  state = startPlayerTurn(state)
  assertEqual(state.phase, 'player', 'and back around for another round')
  assertEqual(state.turn, 2, 'the second round increments the turn counter')
  assertEqual(state.players[0].hand.length, 5, 'a fresh hand is drawn each round')
  assertEqual(state.players[0].energy, 3, 'and Energy is reset')
})

check('a Player Turn cannot be replayed to refill Energy and redraw', () => {
  // startPlayerTurn is reachable from the network through the room layer, so
  // re-running it would hand out a second hand and a second Energy reset while
  // skipping the Enemy Turn altogether.
  uid = 0
  let state = createCombat(
    createRng(7),
    [player({ draw: STARTER_DECKS.ironclad.map((id) => instance(id)) })],
    [enemy({ hp: 20 })],
  )
  state = startPlayerTurn(state)
  const opened = state
  assertEqual(state.turn, 1, 'the first turn opened')

  const again = startPlayerTurn(state)
  assert(again === opened, 'a second call must be refused, returning the same state')

  // And not while the enemies are still owed their turn, which would skip it.
  const duringEnemyPhase = { ...opened, phase: 'enemy' }
  assert(
    startPlayerTurn(duringEnemyPhase) === duringEnemyPhase,
    'the Enemy Turn cannot be skipped by starting the next Player Turn',
  )
})

suite('the combat log')

// The log is the only record of the Enemy Turn. A missing line is not a
// cosmetic gap: the player sees a number change and has to guess why.
check('an enemy attack is reported with who, whom and how much', () => {
  // Every line the log carries was individually deletable with the whole suite
  // green. If the log is the only record of the Enemy Turn, its content is
  // worth asserting at least once.
  const next = enemyTurn(inEnemyPhase([player({ id: 'p1', hp: 10 })], [enemy({ defId: 'green_louse' })]))
  const line = next.log.find((entry) => entry.includes('hit'))
  assert(line, `no attack line in: ${next.log.join(' | ')}`)
  assert(line.includes('Green Louse'), `the attacker should be named: ${line}`)
  assert(line.includes('Ironclad'), `the target should be named: ${line}`)
  assert(/for 1\b/.test(line), `the amount should be stated: ${line}`)
})

check('a player killed by an enemy is reported', () => {
  const next = enemyTurn(inEnemyPhase([player({ id: 'p1', hp: 1 })], [enemy({ defId: 'green_louse' })]))
  assert(next.players[0].dead, 'precondition: the player should have died')
  assert(
    next.log.some((line) => line.includes('has fallen')),
    `a death went unlogged: ${next.log.join(' | ')}`,
  )
})

check('the bite of Wrath is reported, and says which way it went', () => {
  const bitten = endPlayerTurn({
    ...createCombat(createRng(9), [player({ hp: 10, stance: 'wrath' })], [enemy({ hp: 20 })]),
    phase: 'player',
  })
  assertEqual(bitten.players[0].hp, 9, 'precondition: Wrath costs 1 at end of turn')
  assert(
    bitten.log.some((line) => /takes 1 from Wrath/.test(line)),
    `expected the damage line: ${bitten.log.join(' | ')}`,
  )

  const blocked = endPlayerTurn({
    ...createCombat(
      createRng(9),
      [player({ hp: 10, block: 3, stance: 'wrath' })],
      [enemy({ hp: 20 })],
    ),
    phase: 'player',
  })
  assertEqual(blocked.players[0].hp, 10, 'precondition: Block absorbs the bite')
  assert(
    blocked.log.some((line) => /blocks the bite of Wrath/.test(line)),
    `expected the blocked line: ${blocked.log.join(' | ')}`,
  )
})

check('a player killed by the bite of Wrath is named', () => {
  const next = endPlayerTurn({
    ...createCombat(createRng(9), [player({ hp: 1, stance: 'wrath' })], [enemy({ hp: 20 })]),
    phase: 'player',
  })
  assert(next.players[0].dead, 'precondition: the bite was lethal')
  assert(
    next.log.some((line) => /has fallen/.test(line)),
    `the casualty went unnamed: ${next.log.join(' | ')}`,
  )
})

check('the enemies stop the moment a player falls', () => {
  // p.13: the game ends immediately in defeat. Resolving the rest of the turn
  // anyway reported four more attacks that the rules say never happened.
  // Enemies act from the highest row down (p.13), so the doomed player sits in
  // the higher row and the lower-row enemy is the one that must never act.
  const state = inEnemyPhase(
    [player({ id: 'p1', row: 1, hp: 1 }), player({ id: 'p2', row: 0, hp: 10 })],
    [enemy({ uid: 'a', row: 1, defId: 'green_louse' }), enemy({ uid: 'b', row: 0, defId: 'green_louse' })],
  )
  const next = enemyTurn(state)
  assert(next.players[0].dead, 'the player in the top row was killed')
  assertEqual(next.phase, 'lost', 'so the combat is lost')
  assertEqual(next.players[1].hp, 10, 'and the lower enemy never got to swing')
  assertEqual(
    next.log.filter((line) => line.includes('hit')).length,
    1,
    `only the killing blow should be reported: ${next.log.join(' | ')}`,
  )
})

check('the party is not credited with Block it does not have', () => {
  // The enemy side of this was fixed; the player side still said "blocked
  // completely" when the enemy had no Block at all and Weak had simply
  // reduced the hit to nothing.
  const strike = instance('strike_ironclad')
  const state = createCombat(
    createRng(5),
    [player({ hand: [strike], weak: 1 })],
    [enemy({ hp: 20, block: 0 })],
  )
  const next = playCard(state, 'p1', strike.uid, { enemyUid: 'e1', playerId: 'p1' })
  assertEqual(next.enemies[0].hp, 20, 'precondition: Weak should reduce this to nothing')
  assert(
    !next.log.some((line) => line.includes('blocked')),
    `the enemy had no Block to credit: ${next.log.join(' | ')}`,
  )
  assert(
    next.log.some((line) => line.includes('did no damage to')),
    `expected a no-damage line: ${next.log.join(' | ')}`,
  )
})

check('an area attack stops the moment it kills someone', () => {
  // The break was outside the per-target loop, so the log reported blows on
  // the rest of the row that p.13 says never landed.
  const state = inEnemyPhase(
    [
      player({ id: 'p1', row: 0, hp: 1 }),
      player({ id: 'p2', row: 0, hp: 10 }),
      player({ id: 'p3', row: 0, hp: 10 }),
    ],
    [enemy({ defId: 'gremlin_nob', hp: 28, row: 0, actionIndex: 1 })],
  )
  const next = enemyTurn(state)
  assert(next.players[0].dead, 'the first player in the row was killed')
  assertEqual(next.players[1].hp, 10, 'the sweep stopped there')
  assertEqual(next.players[2].hp, 10, 'and never reached the third player')
})

check('the log reports what the party did, not only what was done to it', () => {
  // Enemy attacks carried a number; the player's own damage — the figure that
  // Strength, Weak and Vulnerable all modify — did not.
  const strike = instance('strike_ironclad')
  const state = createCombat(createRng(5), [player({ hand: [strike], strength: 2 })], [enemy({ hp: 20 })])
  const next = playCard(state, 'p1', strike.uid, { enemyUid: 'e1', playerId: 'p1' })
  const line = next.log.find((entry) => entry.includes('hit'))
  assert(line, `no line for the party's own attack: ${next.log.join(' | ')}`)
  assert(line.includes('Ironclad'), `the attacker should be named: ${line}`)
  assert(/for 3\b/.test(line), `1 damage plus 2 Strength is 3: ${line}`)
})

check('a card is logged before what it causes', () => {
  // Newest-first, a kill appended before the card that caused it reads as if
  // the enemy died first.
  const strike = instance('strike_ironclad')
  const state = createCombat(createRng(5), [player({ hand: [strike] })], [enemy({ hp: 1 })])
  const next = playCard(state, 'p1', strike.uid, { enemyUid: 'e1', playerId: 'p1' })
  const played = next.log.findIndex((line) => line.includes('played Strike'))
  const died = next.log.findIndex((line) => line.includes('is dead'))
  assert(played >= 0 && died >= 0, `expected both lines: ${next.log.join(' | ')}`)
  assert(played < died, `the card must be logged before the kill: ${next.log.join(' | ')}`)
})

check('poison reports the hit points lost, not the token count', () => {
  const state = {
    ...createCombat(createRng(3), [player()], [enemy({ hp: 2, poison: 5 })]),
    phase: 'player',
  }
  const next = endPlayerTurn(state)
  const line = next.log.find((entry) => entry.includes('Poison'))
  assert(line, `no poison line: ${next.log.join(' | ')}`)
  assert(/loses 2 /.test(line), `an enemy on 2 hit points loses 2, not 5: ${line}`)
})

check('a Daze pushed into a deck is reported', () => {
  // The Spike Slime dazes on a roll of 3 or 4 (die pattern, not a cube track —
  // an earlier version of this check set actionIndex, which does nothing for a
  // die enemy, and quietly asserted nothing at all).
  const state = inEnemyPhase(
    [player({ draw: [instance('strike_ironclad')] })],
    [enemy({ defId: 'spike_slime', hp: 5 })],
  )
  const next = enemyTurn({ ...state, die: 3 })
  assert(
    next.players[0].draw.some((card) => card.defId === 'daze'),
    'a roll of 3 should put a Daze on top of the draw pile',
  )
  const line = next.log.find((entry) => entry.includes('Daze'))
  assert(line, `a Daze entered the deck with no log line: ${next.log.join(' | ')}`)
  assert(line.includes('Ironclad'), `the victim should be named: ${line}`)
  assert(/slipped a Daze into/.test(line), `one Daze reads as "a Daze", not "1 Dazes": ${line}`)
})

check('Block is only credited when Block did the work', () => {
  // A Weak attack reduced to nothing is not the shield's doing, and saying so
  // tells the player their Block is working when they have none.
  const next = enemyTurn(
    inEnemyPhase([player({ block: 0 })], [enemy({ defId: 'green_louse', weak: 3, strength: -5 })]),
  )
  const claimsBlock = next.log.some((line) => line.includes('blocked'))
  assertEqual(next.players[0].block, 0, 'precondition: the player has no Block')
  assert(!claimsBlock, `credited Block to a player with none: ${next.log.join(' | ')}`)
  // And says what DID happen, rather than leaving the round unexplained.
  assert(
    next.log.some((line) => line.includes('did no damage to')),
    `expected a no-damage line: ${next.log.join(' | ')}`,
  )
})

check('an enemy killed by poison says so', () => {
  const state = {
    ...createCombat(createRng(3), [player()], [enemy({ hp: 1, poison: 2 })]),
    phase: 'player',
  }
  const next = endPlayerTurn(state)
  assert(next.enemies[0].dead, 'the poison killed it')
  assert(
    next.log.some((line) => line.includes('Poison')),
    `poison damage went unlogged: ${next.log.join(' | ')}`,
  )
  assert(
    next.log.some((line) => line.includes('is dead')),
    `the kill went unlogged: ${next.log.join(' | ')}`,
  )
})

suite('what the log says')

// Every line below was individually deletable with the whole suite green. The
// log is the only record of a round, so its CONTENT is the thing to assert,
// not merely that a state change happened.

check('a multi-action enemy stops mid-action when the blow is lethal', () => {
  // The Jaw Worm attacks AND blocks on a roll of 1. If the attack kills, the
  // Block half must never resolve, and must not be reported.
  const state = inEnemyPhase([player({ hp: 1 })], [enemy({ defId: 'jaw_worm', hp: 10 })])
  const next = enemyTurn({ ...state, die: 1 })
  assert(next.players[0].dead, 'precondition: the attack should be lethal')
  assertEqual(next.enemies[0].block, 0, 'the Block half never resolved')
  const fell = next.log.findIndex((line) => /has fallen/.test(line))
  assert(fell >= 0, `expected a death line: ${next.log.join(' | ')}`)
  assertEqual(fell, next.log.length - 1, `nothing may follow the death: ${next.log.join(' | ')}`)
})

check('a partly blocked hit reports both halves', () => {
  const state = inEnemyPhase([player({ block: 1, hp: 10 })], [enemy({ defId: 'jaw_worm', hp: 10 })])
  const next = enemyTurn({ ...state, die: 1 })
  assertEqual(next.players[0].hp, 8, 'precondition: 3 damage against 1 Block')
  const line = next.log.find((entry) => entry.includes('hit'))
  assert(line && /for 2 \(1 blocked\)/.test(line), `expected both halves: ${line}`)
})

check('a fully blocked attack credits the Block, on both sides', () => {
  const enemySide = enemyTurn(
    inEnemyPhase([player({ block: 20 })], [enemy({ defId: 'green_louse' })]),
  )
  assertEqual(enemySide.players[0].hp, 10, 'precondition: nothing gets through')
  assert(
    enemySide.log.some((line) => /blocked .* completely/.test(line)),
    `expected a full-block line: ${enemySide.log.join(' | ')}`,
  )

  const strike = instance('strike_ironclad')
  const playerSide = playCard(
    createCombat(createRng(5), [player({ hand: [strike] })], [enemy({ hp: 20, block: 9 })]),
    'p1',
    strike.uid,
    { enemyUid: 'e1', playerId: 'p1' },
  )
  assert(
    playerSide.log.some((line) => /blocked .* completely/.test(line)),
    `the player side should say so too: ${playerSide.log.join(' | ')}`,
  )
})

check('an enemy that buffs or debuffs says so, and stays quiet at the cap', () => {
  const blockingJaw = enemyTurn({
    ...inEnemyPhase([player()], [enemy({ defId: 'jaw_worm', hp: 10 })]),
    die: 1,
  })
  assert(
    blockingJaw.log.some((line) => /gained 1 Block/.test(line)),
    `expected a Block line: ${blockingJaw.log.join(' | ')}`,
  )
  const jaw = enemyTurn({
    ...inEnemyPhase([player()], [enemy({ defId: 'jaw_worm', hp: 10 })]),
    die: 5,
  })
  assert(
    jaw.log.some((line) => /gained 1 Strength/.test(line)),
    `expected a Strength line: ${jaw.log.join(' | ')}`,
  )

  // At the Strength cap nothing is gained, so nothing should be claimed.
  const capped = enemyTurn({
    ...inEnemyPhase([player()], [enemy({ defId: 'jaw_worm', hp: 10, strength: 8 })]),
    die: 5,
  })
  assert(
    !capped.log.some((line) => /gained \d+ Strength/.test(line)),
    `a capped Strength claimed a gain: ${capped.log.join(' | ')}`,
  )

  const slaver = enemyTurn({
    ...inEnemyPhase([player()], [enemy({ defId: 'blue_slaver', hp: 10 })]),
    die: 1,
  })
  assert(
    slaver.log.some((line) => /weakened/.test(line)),
    `expected a Weak line: ${slaver.log.join(' | ')}`,
  )

  const slime = enemyTurn({
    ...inEnemyPhase([player()], [enemy({ defId: 'spike_slime', hp: 5 })]),
    die: 1,
  })
  assertEqual(slime.players[0].vulnerable, 1, 'precondition: a roll of 1 applies Vulnerable')
  assert(
    slime.log.some((line) => /vulnerable/.test(line)),
    `expected a Vulnerable line: ${slime.log.join(' | ')}`,
  )
})

check('two of the same enemy can be told apart in the log', () => {
  const twins = enemyTurn(
    inEnemyPhase(
      [player({ id: 'p1', row: 0 }), player({ id: 'p2', row: 1 })],
      [
        enemy({ uid: 'a', row: 0, defId: 'green_louse' }),
        enemy({ uid: 'b', row: 1, defId: 'green_louse' }),
      ],
    ),
  )
  assert(
    twins.log.some((line) => /Green Louse \(row \d\)/.test(line)),
    `two identical enemies need distinguishing: ${twins.log.join(' | ')}`,
  )

  const lone = enemyTurn(inEnemyPhase([player()], [enemy({ defId: 'green_louse' })]))
  assert(
    !lone.log.some((line) => /\(row \d\)/.test(line)),
    `a single enemy needs no row: ${lone.log.join(' | ')}`,
  )
})

check('an ongoing effect is credited to itself, not to the player', () => {
  CARDS.fixture_striker = {
    id: 'fixture_striker',
    name: 'Fixture Striker',
    owner: 'ironclad',
    type: 'power',
    rarity: 'rare',
    cost: 0,
    trigger: { kind: 'startOfTurn' },
    effects: [{ kind: 'hit', amount: 1 }],
  }
  const state = startPlayerTurn(
    createCombat(
      createRng(5),
      [player({ powers: [instance('fixture_striker')], draw: STARTER_DECKS.ironclad.map((id) => instance(id)) })],
      [enemy({ hp: 20 })],
    ),
  )
  const line = state.log.find((entry) => entry.includes('hit'))
  assert(line, `the Power dealt damage silently: ${state.log.join(' | ')}`)
  assert(
    line.includes('Fixture Striker'),
    `a Power's damage should name the Power, not just the player: ${line}`,
  )
})

check('loseHp reports what was lost, and the kill', () => {
  CARDS.fixture_bleed = {
    id: 'fixture_bleed',
    name: 'Fixture Bleed',
    owner: 'ironclad',
    type: 'skill',
    rarity: 'common',
    cost: 0,
    effects: [{ kind: 'loseHp', amount: 5 }],
  }
  const card = instance('fixture_bleed')
  const next = playCard(
    createCombat(createRng(5), [player({ hand: [card] })], [enemy({ hp: 2 })]),
    'p1',
    card.uid,
    { enemyUid: 'e1', playerId: 'p1' },
  )
  assert(
    next.log.some((line) => /loses 2\b/.test(line)),
    `an enemy on 2 hit points loses 2, not 5: ${next.log.join(' | ')}`,
  )
  assert(
    next.log.some((line) => /is dead/.test(line)),
    `the kill went unlogged: ${next.log.join(' | ')}`,
  )
})

check('every effect the party can use reports itself', () => {
  // One card per effect kind, so the whole family cannot go silent at once.
  const CASES = [
    { effect: { kind: 'block', amount: 2 }, expect: /gains 2 Block/ },
    { effect: { kind: 'gainStrength', amount: 2 }, expect: /gains 2 Strength/ },
    { effect: { kind: 'draw', amount: 1 }, expect: /draws 1/ },
    { effect: { kind: 'gainEnergy', amount: 1 }, expect: /gains 1 Energy/ },
    { effect: { kind: 'gainShiv', amount: 1 }, expect: /gains 1 Shiv/ },
    { effect: { kind: 'gainMiracle', amount: 1 }, expect: /gains 1 Miracle/ },
    { effect: { kind: 'heal', amount: 2 }, expect: /heals 2/ },
    { effect: { kind: 'channel', orb: 'lightning', amount: 1 }, expect: /channels 1 lightning/ },
    { effect: { kind: 'enterStance', stance: 'calm' }, expect: /enters calm/ },
    { effect: { kind: 'applyWeak', amount: 1 }, expect: /is weakened/, needsTarget: true },
    { effect: { kind: 'applyVulnerable', amount: 1 }, expect: /is vulnerable/, needsTarget: true },
    { effect: { kind: 'poison', amount: 2 }, expect: /takes 2 Poison/, needsTarget: true },
  ]

  for (const { effect, expect, needsTarget } of CASES) {
    CARDS.fixture_reports = {
      id: 'fixture_reports',
      name: 'Fixture Reports',
      owner: 'ironclad',
      type: 'skill',
      rarity: 'common',
      cost: 0,
      effects: [effect],
    }
    const card = instance('fixture_reports')
    const next = playCard(
      createCombat(
        createRng(5),
        [player({ hand: [card], hp: 5, energy: 3, draw: [instance('strike_ironclad')] })],
        [enemy({ hp: 20 })],
      ),
      'p1',
      card.uid,
      { enemyUid: needsTarget ? 'e1' : null, playerId: 'p1' },
    )
    assert(
      next.log.some((line) => expect.test(line)),
      `${effect.kind} went unlogged: ${next.log.join(' | ')}`,
    )
  }
})

check('an evoked orb names itself', () => {
  CARDS.fixture_evoke_log = {
    id: 'fixture_evoke_log',
    name: 'Fixture Evoke Log',
    owner: 'defect',
    type: 'skill',
    rarity: 'common',
    cost: 0,
    effects: [{ kind: 'evoke', times: 1 }],
  }
  const lightning = instance('fixture_evoke_log')
  const zap = playCard(
    createCombat(
      createRng(5),
      [player({ hand: [lightning], orbs: ['lightning', null, null] })],
      [enemy({ hp: 20 })],
    ),
    'p1',
    lightning.uid,
    { enemyUid: null, playerId: 'p1', evokeSlots: [0], evokeEnemyUids: ['e1'] },
  )
  assert(
    zap.log.some((line) => /Lightning orb/.test(line)),
    `the orb should name itself: ${zap.log.join(' | ')}`,
  )

  const frostCard = instance('fixture_evoke_log')
  const frost = playCard(
    createCombat(
      createRng(5),
      [player({ hand: [frostCard], orbs: ['frost', null, null] })],
      [enemy({ hp: 20 })],
    ),
    'p1',
    frostCard.uid,
    { enemyUid: null, playerId: 'p1', evokeSlots: [0], evokeEnemyUids: [null] },
  )
  assert(
    frost.log.some((line) => /Frost orb gives 1 Block/.test(line)),
    `the Frost orb should say what it gave: ${frost.log.join(' | ')}`,
  )
})

suite('silence at the cap')

// Every one of these logs "gained N" only when N actually went on. The
// emitting direction is covered above; this is the other one, which was
// asserted at exactly one site out of nineteen. The caps are all reachable in
// an ordinary fight, so without this the log claims gains that never happened.
check('a capped gain is not claimed', () => {
  const CASES = [
    {
      what: 'Block',
      effect: { kind: 'block', amount: 2 },
      from: { block: 20 },
      pattern: /gains \d+ Block/,
    },
    {
      what: 'Strength',
      effect: { kind: 'gainStrength', amount: 2 },
      from: { strength: 8 },
      pattern: /gains \d+ Strength/,
    },
    {
      what: 'Energy',
      effect: { kind: 'gainEnergy', amount: 2 },
      from: { energy: 6 },
      pattern: /gains \d+ Energy/,
    },
    {
      what: 'Shivs',
      effect: { kind: 'gainShiv', amount: 2 },
      from: { shivs: 5 },
      pattern: /gains \d+ Shiv/,
    },
    {
      what: 'Miracles',
      effect: { kind: 'gainMiracle', amount: 2 },
      from: { miracles: 5 },
      pattern: /gains \d+ Miracle/,
    },
    {
      what: 'healing at full',
      effect: { kind: 'heal', amount: 3 },
      from: { hp: 10, maxHp: 10 },
      pattern: /heals \d+/,
    },
    {
      what: 'Vulnerable',
      effect: { kind: 'applyVulnerable', amount: 2 },
      from: {},
      enemy: { vulnerable: 3 },
      pattern: /is vulnerable/,
      needsTarget: true,
    },
    {
      what: 'Weak',
      effect: { kind: 'applyWeak', amount: 2 },
      from: {},
      enemy: { weak: 3 },
      pattern: /is weakened/,
      needsTarget: true,
    },
  ]

  for (const { what, effect, from, enemy: enemyOver, pattern, needsTarget } of CASES) {
    CARDS.fixture_capped = {
      id: 'fixture_capped',
      name: 'Fixture Capped',
      owner: 'ironclad',
      type: 'skill',
      rarity: 'common',
      cost: 0,
      effects: [effect],
    }
    const card = instance('fixture_capped')
    const next = playCard(
      createCombat(
        createRng(5),
        [player({ hand: [card], ...from })],
        [enemy({ hp: 20, ...(enemyOver ?? {}) })],
      ),
      'p1',
      card.uid,
      { enemyUid: needsTarget ? 'e1' : null, playerId: 'p1' },
    )
    assert(
      !next.log.some((line) => pattern.test(line)),
      `${what} was already at its cap, so nothing should be claimed: ${next.log.join(' | ')}`,
    )
  }
})

check('a capped enemy gain is not claimed either', () => {
  // Strength only. An enemy's Block is cleared at the start of its own turn
  // (p.13), so it can never be at the cap at the moment it blocks — there is
  // no capped-Block case to test on this side.
  const capped = enemyTurn({
    ...inEnemyPhase([player()], [enemy({ defId: 'jaw_worm', hp: 10, strength: 8 })]),
    die: 5,
  })
  assert(
    !capped.log.some((line) => /gained \d+ Strength/.test(line)),
    `a capped Strength claimed a gain: ${capped.log.join(' | ')}`,
  )
})

check('a capped debuff from an enemy is not claimed', () => {
  const slaver = enemyTurn({
    ...inEnemyPhase([player({ weak: 3 })], [enemy({ defId: 'blue_slaver', hp: 10 })]),
    die: 1,
  })
  assert(
    !slaver.log.some((line) => /weakened/.test(line)),
    `Weak was already capped: ${slaver.log.join(' | ')}`,
  )

  // No Vulnerable case here: every enemy action that applies it also attacks,
  // and attacking SPENDS a Vulnerable token first (p.14) — so the token is at
  // 2 by the time it is reapplied and the gain is real. The capped-Vulnerable
  // path is covered on the player side, where nothing spends it first.
})

check('damage dealt by an orb is reported in full, including the kill', () => {
  // damageEnemyLogged writes four different lines and none of them was pinned;
  // an enemy could be killed by an orb with no "is dead" line at all.
  CARDS.fixture_orb_evoke = {
    id: 'fixture_orb_evoke',
    name: 'Fixture Orb Evoke',
    owner: 'defect',
    type: 'skill',
    rarity: 'common',
    cost: 0,
    effects: [{ kind: 'evoke', times: 1 }],
  }
  const killer = instance('fixture_orb_evoke')
  const killed = playCard(
    createCombat(
      createRng(5),
      [player({ hand: [killer], orbs: ['lightning', null, null] })],
      [enemy({ hp: 2 })],
    ),
    'p1',
    killer.uid,
    { enemyUid: null, playerId: 'p1', evokeSlots: [0], evokeEnemyUids: ['e1'] },
  )
  assert(killed.enemies[0].dead, 'precondition: the orb should kill it')
  assert(
    // "damages", not "hit": a hit is specifically what Strength, Weak and
    // Vulnerable modify, and orb damage is none of those.
    killed.log.some((line) => /Lightning orb damages .* for 2/.test(line)),
    `the orb's damage should be reported: ${killed.log.join(' | ')}`,
  )
  assert(
    killed.log.some((line) => /is dead/.test(line)),
    `and so should the kill: ${killed.log.join(' | ')}`,
  )

  const blocked = instance('fixture_orb_evoke')
  const partly = playCard(
    createCombat(
      createRng(5),
      [player({ hand: [blocked], orbs: ['lightning', null, null] })],
      [enemy({ hp: 20, block: 1 })],
    ),
    'p1',
    blocked.uid,
    { enemyUid: null, playerId: 'p1', evokeSlots: [0], evokeEnemyUids: ['e1'] },
  )
  assert(
    partly.log.some((line) => /for 1 \(1 blocked\)/.test(line)),
    `a partly blocked orb should report both halves: ${partly.log.join(' | ')}`,
  )
})

check("a player's own partly blocked attack reports both halves", () => {
  // The enemy side of this was pinned; the player side was not.
  const strike = instance('strike_ironclad')
  const next = playCard(
    createCombat(createRng(5), [player({ hand: [strike], strength: 2 })], [enemy({ hp: 20, block: 1 })]),
    'p1',
    strike.uid,
    { enemyUid: 'e1', playerId: 'p1' },
  )
  const line = next.log.find((entry) => entry.includes('hit'))
  assert(line && /for 2 \(1 blocked\)/.test(line), `expected both halves: ${line}`)
})

check('the cost a card charges is named', () => {
  const survivor = instance('survivor')
  const spare = instance('strike_silent')
  const discarded = playCard(
    createCombat(
      createRng(5),
      [player({ character: 'silent', hand: [survivor, spare] })],
      [enemy({ hp: 20 })],
    ),
    'p1',
    survivor.uid,
    { enemyUid: null, playerId: 'p1', discardUids: [spare.uid] },
  )
  assert(
    discarded.log.some((line) => /discards 1/.test(line)),
    `the discard cost went unmentioned: ${discarded.log.join(' | ')}`,
  )

  const grit = instance('true_grit')
  const fodder = instance('strike_ironclad')
  const exhausted = playCard(
    createCombat(createRng(5), [player({ hand: [grit, fodder] })], [enemy({ hp: 20 })]),
    'p1',
    grit.uid,
    { enemyUid: null, playerId: 'p1', exhaustUids: [fodder.uid] },
  )
  assert(
    exhausted.log.some((line) => /exhausts 1/.test(line)),
    `the exhaust cost went unmentioned: ${exhausted.log.join(' | ')}`,
  )
})

check('two DIFFERENT enemies are not given rows they do not need', () => {
  const mixed = enemyTurn(
    inEnemyPhase(
      [player({ id: 'p1', row: 0 }), player({ id: 'p2', row: 1 })],
      [
        enemy({ uid: 'a', row: 0, defId: 'green_louse' }),
        enemy({ uid: 'b', row: 1, defId: 'jaw_worm', hp: 10 }),
      ],
    ),
  )
  assert(
    !mixed.log.some((line) => /\(row \d\)/.test(line)),
    `only identical names need a row: ${mixed.log.join(' | ')}`,
  )
})

check('the first end-of-turn guard stops a later player acting after the fight', () => {
  // Two players: the poison tick ends the combat before ANY player takes their
  // end-of-turn step, so the second player's Frost orb must not fire. With one
  // player the second guard masks this entirely.
  const state = {
    ...createCombat(
      createRng(5),
      [
        player({ id: 'p1', row: 0 }),
        player({ id: 'p2', row: 1, orbs: ['frost', null, null] }),
      ],
      [enemy({ hp: 1, poison: 3 })],
    ),
    phase: 'player',
  }
  const next = endPlayerTurn(state)
  assertEqual(next.phase, 'won', 'the poison finished the last enemy')
  assertEqual(next.players[1].block, 0, "the second player's Frost orb never fired")
  assert(
    !next.log.some((line) => /Frost orb/.test(line)),
    `and wrote no line: ${next.log.join(' | ')}`,
  )
})

check('an action marked "acts last" changes order only on that die row', () => {
  const state = inEnemyPhase(
      [player()],
      [
        enemy({ uid: 'slime', row: 2, defId: 'spike_slime', hp: 5 }),
        enemy({ uid: 'louse', row: 0, defId: 'green_louse' }),
        enemy({ uid: 'worm', row: 1, defId: 'jaw_worm', hp: 10 }),
      ],
    )
  const order = enemyActingOrder({ ...state, die: 1 }).map((foe) => foe.uid)
  assertEqual(order[order.length - 1], 'slime', `acts-last should be last: ${order.join(', ')}`)
  assertDeepEqual(order, ['worm', 'louse', 'slime'], 'and the rest go highest row first')
  assertDeepEqual(
    enemyActingOrder({ ...state, die: 3 }).map((foe) => foe.uid),
    ['slime', 'worm', 'louse'],
    'the Daze row follows ordinary highest-row ordering',
  )
})

check('a Weak token is not spent on an attack that hits nothing', () => {
  // p.24: Weak is spent by attacking. An attack that found no target has not
  // attacked, so the token stays.
  CARDS.fixture_sweep_all = {
    id: 'fixture_sweep_all',
    name: 'Fixture Sweep All',
    owner: 'ironclad',
    type: 'attack',
    rarity: 'common',
    cost: 0,
    target: 'allEnemies',
    effects: [{ kind: 'hit', amount: 1 }],
  }
  const card = instance('fixture_sweep_all')
  const state = createCombat(
    createRng(5),
    [player({ hand: [card], weak: 2 })],
    [enemy({ hp: 5, dead: true })],
  )
  const next = playCard(state, 'p1', card.uid, { enemyUid: null, playerId: 'p1' })
  assert(next !== state, 'precondition: an all-enemies card is playable with no living target')
  assertEqual(next.players[0].weak, 2, 'nothing was attacked, so no Weak was spent')
})

check('the round divider opens the round even when the draw itself logs', () => {
  // The divider is spliced in ahead of the Start of Turn draw, so an on-draw
  // trigger's lines land under the heading they belong to.
  CARDS.fixture_draw_noisy = {
    id: 'fixture_draw_noisy',
    name: 'Fixture Draw Noisy',
    owner: 'ironclad',
    type: 'power',
    rarity: 'rare',
    cost: 0,
    trigger: { kind: 'onDraw' },
    effects: [{ kind: 'gainStrength', amount: 1 }],
  }
  const state = startPlayerTurn(
    createCombat(
      createRng(5),
      [player({ powers: [instance('fixture_draw_noisy')], draw: STARTER_DECKS.ironclad.map((id) => instance(id)) })],
      [enemy({ hp: 20 })],
    ),
  )
  const divider = state.log.findIndex((line) => /^Turn 1 begins/.test(line))
  const firstDraw = state.log.findIndex((line) => /Fixture Draw Noisy/.test(line))
  assert(divider >= 0, `expected a divider: ${state.log.join(' | ')}`)
  assert(firstDraw >= 0, `expected the on-draw Power to log: ${state.log.join(' | ')}`)
  assert(divider < firstDraw, `the divider must open the round: ${state.log.join(' | ')}`)
})

check('a row-only enemy debuff does not reach another row', () => {
  // The Weak equivalent was pinned; Vulnerable was not, so the branch could
  // be forced to always-AoE with everything green.
  const state = inEnemyPhase(
    [player({ id: 'p1', row: 0 }), player({ id: 'p2', row: 1 })],
    [enemy({ defId: 'spike_slime', row: 0, hp: 5 })],
  )
  const next = enemyTurn({ ...state, die: 1 })
  assertEqual(next.players[0].vulnerable, 1, 'the player sharing the row is marked')
  assertEqual(next.players[1].vulnerable, 0, 'the other row is not')
})

check('a boss reaches every row, even without an area attack', () => {
  // A boss counts as being in every row. The player-facing targeting already
  // honoured that; the enemy side did not, so a single-target boss attack
  // could only ever reach its spawn row.
  const state = inEnemyPhase(
    [player({ id: 'p1', row: 0 }), player({ id: 'p2', row: 1 }), player({ id: 'p3', row: 2 })],
    [enemy({ uid: 'boss', defId: 'cultist', row: 2, hp: 9, isBoss: true })],
  )
  const next = enemyTurn(state)
  for (const seat of next.players) {
    assertEqual(seat.hp, 9, `${seat.id} should have been reached by the boss`)
  }
})

check('Act I alternate rows select the highest reached Ascension card', () => {
  assertDeepEqual(enemyDef('gremlin_nob', 0).hpByPlayers, [15, 30, 45, 60])
  assertDeepEqual(enemyDef('gremlin_nob', 1).hpByPlayers, [17, 35, 53, 70])
  assertDeepEqual(enemyDef('gremlin_nob', 12).hpByPlayers, [19, 39, 61, 85])
  assertEqual(actionsFor(enemyDef('gremlin_nob', 12), 1, 0)[0].kind, 'attack', 'A12 attacks before Enraged')
  assertEqual(startingHp(enemyDef('large_slime', 7), 1), 9, 'A7 Large Slime has 9 HP')
  assertEqual(actionsFor(enemyDef('large_slime', 7), 1, 0)[0].amount, 2, 'A7 Large Slime opens for 2 AOE')
  assertEqual(startingHp(enemyDef('sentries', 0), 4), 7, 'base Sentries has a fixed 7 HP card')
  assertEqual(enemyDef('sentries', 0).pattern.kind, 'die', 'base Sentries uses its die rows')
  assertEqual(startingHp(enemyDef('sentries', 1), 4), 8, 'A1 Sentries replaces the main card')
  assertEqual(enemyDef('sentries', 1).pattern.kind, 'cube', 'A1 Sentries uses a cube track')
  assertEqual(startingHp(enemyDef('sentries', 12), 4), 9, 'A12 Sentries has 9 HP')
  assertDeepEqual(actionsFor(enemyDef('sentries', 12), 1, 0), [{ kind: 'daze', amount: 1, aoe: true }])
  assertDeepEqual(enemyDef('lagavulin', 12).hpByPlayers, [24, 49, 76, 105])
  assertDeepEqual(actionsFor(enemyDef('lagavulin', 0), 1, 3), [
    { kind: 'applyWeak', amount: 2, aoe: true },
    { kind: 'gainStrength', amount: 1 },
  ])
  assertDeepEqual(actionsFor(enemyDef('lagavulin', 1), 1, 1), [
    { kind: 'attack', amount: 4, aoe: true },
    { kind: 'gainStrength', amount: 1 },
  ])
  assertEqual(advanceCube(enemyDef('lagavulin', 1), 2), 0, 'A1 loops to its red Weak opener')
  assertEqual(advanceCube(enemyDef('lagavulin', 12), 2), 0, 'A12 loops to its red Weak opener')
})

check('Sentry summon cards keep their distinct HP and die rows at every Ascension', () => {
  for (const ascension of [0, 1, 12, 13]) {
    assertEqual(startingHp(enemyDef('sentry_a', ascension), 4), 7)
    assertEqual(startingHp(enemyDef('sentry_b', ascension), 4), 8)
    assertDeepEqual(actionsFor(enemyDef('sentry_a', ascension), 1, 0), [{ kind: 'daze', amount: 1 }])
    assertDeepEqual(actionsFor(enemyDef('sentry_a', ascension), 3, 0), [{ kind: 'daze', amount: 1 }])
    assertDeepEqual(actionsFor(enemyDef('sentry_a', ascension), 4, 0), [{ kind: 'attack', amount: 3 }])
    assertDeepEqual(actionsFor(enemyDef('sentry_b', ascension), 1, 0), [{ kind: 'attack', amount: 3 }])
    assertDeepEqual(actionsFor(enemyDef('sentry_b', ascension), 3, 0), [{ kind: 'attack', amount: 3 }])
    assertDeepEqual(actionsFor(enemyDef('sentry_b', ascension), 4, 0), [{ kind: 'daze', amount: 1 }])
  }
})

check('the four 1st Encounter cards keep their distinct printed HP and rows', () => {
  assertEqual(startingHp(enemyDef('small_slime'), 1), 3)
  assertEqual(startingHp(enemyDef('acid_slime'), 1), 5, 'Small Slime searches the physical Summons deck')
  assertEqual(startingHp(enemyDef('jaw_worm_first'), 1), 7)
  assertDeepEqual(actionsFor(enemyDef('jaw_worm_first'), 1, 0), [
    { kind: 'block', amount: 2 }, { kind: 'gainStrength', amount: 1 },
  ])
  assertDeepEqual(actionsFor(enemyDef('jaw_worm_first'), 3, 0), [
    { kind: 'attack', amount: 2 }, { kind: 'block', amount: 1 },
  ])
  assertDeepEqual(actionsFor(enemyDef('jaw_worm_first'), 5, 0), [{ kind: 'attack', amount: 3 }])
  assertEqual(startingHp(enemyDef('red_louse_first'), 1), 4)
  assertDeepEqual(actionsFor(enemyDef('red_louse_first'), 1, 0), [{ kind: 'gainStrength', amount: 1 }])
  assertDeepEqual(actionsFor(enemyDef('red_louse_first'), 3, 0), [{ kind: 'attack', amount: 2 }])
  assertDeepEqual(actionsFor(enemyDef('red_louse_first'), 5, 0), [{ kind: 'attack', amount: 1 }])
})

check('the Act I Summons deck has every physical Slime card and duplicate', () => {
  const supply = createSummonSupply(createRng(81))
  const acid = Array.from({ length: 4 }, () => drawSummon(supply, 'acid_slime'))
  assertEqual(new Set(acid).size, 4, 'all four Acid Slime row permutations are present')
  assertDeepEqual(actionsFor(enemyDef('acid_slime'), 1, 0), [{ kind: 'attack', amount: 2 }])
  assertDeepEqual(actionsFor(enemyDef('acid_slime'), 3, 0), [{ kind: 'applyWeak', amount: 1 }])
  assertDeepEqual(actionsFor(enemyDef('acid_slime'), 5, 0), [{ kind: 'attack', amount: 2 }, { kind: 'daze', amount: 1 }])
  assertDeepEqual(actionsFor(enemyDef('acid_slime_daw'), 1, 0), [{ kind: 'attack', amount: 2 }, { kind: 'daze', amount: 1 }])
  assertDeepEqual(actionsFor(enemyDef('acid_slime_daw'), 3, 0), [{ kind: 'attack', amount: 2 }])
  assertDeepEqual(actionsFor(enemyDef('acid_slime_daw'), 5, 0), [{ kind: 'applyWeak', amount: 1 }])
  assertDeepEqual(actionsFor(enemyDef('acid_slime_wda'), 1, 0), [{ kind: 'applyWeak', amount: 1 }])
  assertDeepEqual(actionsFor(enemyDef('acid_slime_wda'), 3, 0), [{ kind: 'attack', amount: 2 }, { kind: 'daze', amount: 1 }])
  assertDeepEqual(actionsFor(enemyDef('acid_slime_wda'), 5, 0), [{ kind: 'attack', amount: 2 }])
  assertDeepEqual(actionsFor(enemyDef('acid_slime_wad'), 1, 0), [{ kind: 'applyWeak', amount: 1 }])
  assertDeepEqual(actionsFor(enemyDef('acid_slime_wad'), 3, 0), [{ kind: 'attack', amount: 2 }])
  assertDeepEqual(actionsFor(enemyDef('acid_slime_wad'), 5, 0), [{ kind: 'attack', amount: 2 }, { kind: 'daze', amount: 1 }])
  assertEqual(drawSummon(supply, 'acid_slime'), null, 'the fifth Acid Slime cannot be invented')
  const large = Array.from({ length: 4 }, () => drawSummon(supply, 'large_slime'))
  assertEqual(large.filter((id) => id === 'large_slime_summon_w4s').length, 2, 'W4S has two physical copies')
  assertEqual(drawSummon(supply, 'large_slime'), null, 'the fifth Large Slime cannot be invented')
})

check('a Status goes on top of discard and preserves the face-up pile order', () => {
  const existing = instance('strike_ironclad')
  const state = {
    ...inEnemyPhase(
      [player({ discard: [existing] })],
      [enemy({ defId: 'large_slime_summon_w4s', hp: 10, maxHp: 10 })],
    ),
    die: 5,
  }
  const next = enemyTurn(state)
  assertDeepEqual(next.players[0].discard.map((card) => card.defId), ['strike_ironclad', 'slimed', 'slimed'])
})

check('Mad Gremlin gains Strength once per damaging Hit after an Attack', () => {
  const strike = instance('twin_strike')
  const state = createCombat(
    createRng(42),
    [player({ hand: [strike], energy: 3 })],
    [enemy({ defId: 'mad_gremlin', hp: 4, maxHp: 4, abilityUsed: false })],
  )
  const next = playCard(state, 'p1', strike.uid, { enemyUid: 'e1', playerId: null })
  assertEqual(next.enemies[0].hp, 2)
  assertEqual(next.enemies[0].strength, 2, 'both Hits queue Angry before the Attack finishes')
})

check('Looter steals gold, leaves combat, and still counts as defeated', () => {
  const state = {
    ...inEnemyPhase([player({ gold: 1 })], [enemy({ defId: 'looter', hp: 9, maxHp: 9, actionIndex: 2 })]),
    turn: 3,
  }
  const next = enemyTurn(state)
  assertEqual(next.players[0].gold, 0, 'it cannot steal more gold than the player has')
  assert(next.enemies[0].dead, 'leaving removes the Looter from combat without a death hook')
  assertEqual(next.phase, 'won', 'a fleeing last enemy ends combat')
})

check('Large Slime announces a summon and it arrives at the next round start', () => {
  const state = {
    ...inEnemyPhase([player()], [enemy({ defId: 'large_slime', hp: 8, maxHp: 8, actionIndex: 2 })]),
    summonSupply: { acid_slime: ['acid_slime'] },
    turn: 1,
  }
  const announced = enemyTurn(state)
  assertEqual(announced.pendingSummons.length, 1)
  assertEqual(announced.enemies.length, 1, 'the summon does not arrive during the Enemy Turn')
  const next = startPlayerTurn(announced)
  assertEqual(next.enemies.length, 2)
  assertEqual(next.enemies[1].defId, 'acid_slime')
  assertEqual(next.enemies[1].row, next.enemies[0].row)
})

check('Act III die rows, cube tracks, and Ascension replacements match the cards', () => {
  assertDeepEqual(actionsFor(enemyDef('jaw_worm_act3'), 1, 0), [
    { kind: 'block', amount: 3 }, { kind: 'gainStrength', amount: 1 },
  ])
  assertDeepEqual(actionsFor(enemyDef('jaw_worm_summon'), 1, 0), [{ kind: 'attack', amount: 4 }])
  assertDeepEqual(actionsFor(enemyDef('repulsor'), 1, 0), [
    { kind: 'attack', amount: 1 }, { kind: 'daze', amount: 2 },
  ])
  assertDeepEqual(actionsFor(enemyDef('repulsor', 7), 1, 0), [
    { kind: 'attack', amount: 1 }, { kind: 'daze', amount: 2 },
  ])
  assertDeepEqual(actionsFor(enemyDef('orb_walker_3ws'), 1, 0), [
    { kind: 'attack', amount: 3 }, { kind: 'daze', amount: 1 }, { kind: 'gainStrength', amount: 1 },
  ])
  assertDeepEqual(actionsFor(enemyDef('orb_walker_2s'), 1, 0), [
    { kind: 'attack', amount: 2 }, { kind: 'gainStrength', amount: 2 },
  ])
  assertDeepEqual(actionsFor(enemyDef('maw'), 1, 0), [
    { kind: 'applyVulnerable', amount: 1, aoe: true }, { kind: 'actsLast' },
  ])
  assertDeepEqual(actionsFor(enemyDef('maw'), 1, 1), [
    { kind: 'attack', amount: 2, times: 2 },
  ])
  assertDeepEqual(actionsFor(enemyDef('maw', 7), 1, 0), [
    { kind: 'attack', amount: 2, aoe: true },
    { kind: 'applyVulnerable', amount: 1, aoe: true },
    { kind: 'actsLast' },
  ])
  assertDeepEqual(enemyDef('giant_head', 12).hpByPlayers, [90, 185, 280, 380])
  assertDeepEqual(actionsFor(enemyDef('nemesis', 12), 1, 2), [
    { kind: 'attack', amount: 2, times: 3, aoe: true },
    { kind: 'status', card: 'burn', amount: 2, aoe: true },
  ])
  assertDeepEqual(enemyDef('reptomancer', 12).hpByPlayers, [42, 90, 140, 194])
  assertDeepEqual(actionsFor(enemyDef('exploder'), 1, 1), [{ kind: 'idle' }])
  assertDeepEqual(actionsFor(enemyDef('writhing_mass'), 6, 0), [
    { kind: 'attack', amount: 4 }, { kind: 'applyWeak', amount: 1 },
  ])
})

check('Act III one-time tracks idle, explode, and die at the printed slots', () => {
  const growth = enemyTurn(inEnemyPhase(
    [player({ hp: 30, maxHp: 30 })],
    [enemy({ defId: 'spire_growth', hp: 17, maxHp: 17 })],
  ))
  assertEqual(growth.players[0].hp, 30, 'Spire Growth does nothing on turn one')
  assertEqual(growth.enemies[0].actionIndex, 1, 'then switches permanently to its die rows')
  const attacked = enemyTurn({ ...growth, phase: 'enemy', die: 1 })
  assertEqual(attacked.players[0].hp, 25, 'the low die row deals 2 then 3 AOE')

  const exploder = enemyTurn(inEnemyPhase(
    [player({ hp: 20, maxHp: 20 })],
    [enemy({ defId: 'exploder', hp: 8, maxHp: 8, actionIndex: 2 })],
  ))
  assertEqual(exploder.players[0].hp, 10, 'Exploder deals its final 10 AOE')
  assert(exploder.enemies[0].dead, 'Exploder then dies')

  const transient = enemyTurn(inEnemyPhase(
    [player({ hp: 30, maxHp: 30 })],
    [enemy({ defId: 'transient', hp: 99, maxHp: 99, actionIndex: 3 })],
  ))
  assertEqual(transient.players[0].hp, 15, 'Transient deals its final 15')
  assert(transient.enemies[0].dead, 'Transient then dies')
})

check('Darkling Regrow resolves at round start and Spiker starts with its cube', () => {
  const livingOnly = {
    ...createCombat(
      createRng(41),
      [player()],
      [enemy({ defId: 'darkling', hp: 8, maxHp: 8, dead: false })],
    ),
    phase: 'start',
    turn: 1,
  }
  assertEqual(startTurnAbilities(livingOnly).length, 0, 'Regrow does not create a no-op ordering choice')
  const darklings = startPlayerTurn(createCombat(
    createRng(42),
    [player()],
    [
      enemy({ uid: 'living', defId: 'darkling', hp: 8, maxHp: 8, dead: false }),
      enemy({ uid: 'dead', defId: 'darkling_bha', hp: 0, maxHp: 8, dead: true }),
    ],
  ))
  assertEqual(darklings.enemies[1].hp, 4, 'Regrow returns a dead Darkling at 4 HP')
  assertEqual(darklings.enemies[1].dead, false)

  const ordered = {
    ...createCombat(
      createRng(44),
      [player({ relics: [{ defId: 'stone_calendar', spent: false }] })],
      [
        enemy({ uid: 'fragile', defId: 'darkling', hp: 4, maxHp: 8 }),
        enemy({ uid: 'survivor', defId: 'darkling_hab', hp: 8, maxHp: 8 }),
        enemy({ uid: 'fallen', defId: 'darkling_bha', hp: 0, maxHp: 8, dead: true }),
      ],
    ),
    phase: 'start',
    turn: 1,
    die: 4,
  }
  const orderedAbilities = startTurnAbilities(ordered)
  const calendar = orderedAbilities.find((ability) => ability.label.includes('Stone Calendar'))
  const regrow = orderedAbilities.find((ability) => ability.label.includes('Regrow'))
  assert(calendar && regrow)
  const regrown = resolveStartPlayerTurn(ordered, [
    { id: calendar.id, enemyUid: 'fragile', shivEnemyUids: [] },
    { id: regrow.id, shivEnemyUids: [] },
  ])
  assertEqual(regrown.enemies[0].hp, 4, 'a later living Darkling still Regrows one killed earlier in the phase')
  assertEqual(regrown.enemies[2].hp, 4, 'the Darkling that began the phase dead also returns')

  const spikerSetup = createCombat(
    createRng(43),
    [player()],
    [enemy({ defId: 'spiker_add', hp: 10, maxHp: 10, abilityCubes: undefined })],
  )
  assertEqual(spikerSetup.enemies[0].abilityCubes, 1, 'Spiker starts combat with one ability cube')
  const spiker = startPlayerTurn(spikerSetup)
  assertEqual(startTurnAbilities({ ...spikerSetup, phase: 'start', turn: 1 }).length, 0,
    'Spiker setup does not create an ordering choice')
  const capped = enemyTurn({ ...spiker, phase: 'enemy', die: 1, enemies: [
    { ...spiker.enemies[0], abilityCubes: 5 },
  ] })
  assertEqual(capped.enemies[0].abilityCubes, 5, 'the printed five-cube track cannot overflow')
})

check('Act III pink spiral actions add Daze instead of Weak', () => {
  const next = enemyTurn({
    ...inEnemyPhase([player()], [enemy({ defId: 'repulsor', hp: 7, maxHp: 7 })]),
    die: 1,
  })
  assertEqual(next.players[0].weak, 0, 'the card has no Weak icon')
  assertEqual(next.players[0].draw.filter((card) => card.defId === 'daze').length, 2, 'two Daze go on top of draw')
})

check('Reptomancer fills each occupied row and Rally skips only with no Daggers', () => {
  const state = {
    ...inEnemyPhase(
      [player({ id: 'p1', row: 0 }), player({ id: 'p2', name: 'Silent', row: 1 })],
      [enemy({ defId: 'reptomancer', hp: 70, maxHp: 70 })],
    ),
    summonSupply: { dagger: Array(8).fill('dagger') },
    turn: 1,
  }
  const announced = enemyTurn(state)
  assertEqual(announced.pendingSummons.length, 2, 'one summon batch is queued per occupied row')
  const arrived = startPlayerTurn(announced)
  const daggers = arrived.enemies.filter((target) => target.defId === 'dagger')
  assertEqual(new Set(daggers.map((target) => target.uid)).size, 4, 'each row batch gets stable unique enemy ids')
  for (const row of [0, 1]) {
    assertEqual(daggers.filter((target) => target.row === row).length, 2)
  }
  assertDeepEqual(
    enemyActingOrder(arrived).filter((target) => target.row === 0).map((target) => target.defId),
    ['dagger', 'dagger', 'reptomancer'],
    'new Daggers sit to the elite\'s left and act before it',
  )

  const noDaggers = enemyTurn(inEnemyPhase(
    [player({ hp: 20, maxHp: 20 })],
    [enemy({ defId: 'reptomancer', hp: 35, maxHp: 35, actionIndex: 1 })],
  ))
  assertEqual(noDaggers.enemies[0].actionIndex, 0, 'Rally skips the bottom action when no Daggers remain')
  const withDagger = enemyTurn(inEnemyPhase(
    [player({ hp: 20, maxHp: 20 })],
    [
      enemy({ uid: 'repto', defId: 'reptomancer', hp: 35, maxHp: 35, actionIndex: 1 }),
      enemy({ uid: 'dagger', defId: 'dagger', hp: 5, maxHp: 5 }),
    ],
  ))
  assertEqual(withDagger.enemies[0].actionIndex, 2, 'Rally keeps the bottom action while a Dagger lives')
})

check('the finite Act III Summons deck has every physical copy', () => {
  const supply = createSummonSupply(createRng(87))
  assertDeepEqual(Array.from({ length: 2 }, () => drawSummon(supply, 'spiker')).sort(), ['spiker_add', 'spiker_attack'])
  assertEqual(drawSummon(supply, 'spiker'), null)
  assertDeepEqual(Array.from({ length: 2 }, () => drawSummon(supply, 'darkling')).sort(), ['darkling_bha', 'darkling_hab'])
  assertEqual(drawSummon(supply, 'darkling'), null)
  assertEqual(Array.from({ length: 8 }, () => drawSummon(supply, 'dagger')).filter(Boolean).length, 8)
  assertEqual(drawSummon(supply, 'dagger'), null)
})

check('an upgraded card is named as upgraded', () => {
  assertEqual(faceOf(CARDS.bash, true).name, 'Bash+', 'the upgraded face carries the plus')
  assertEqual(faceOf(CARDS.bash, false).name, 'Bash', 'and the base face does not')
})

report('enemy turn')
