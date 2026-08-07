import {
  createCombat,
  endPlayerTurn,
  enemyActingOrder,
  enemyTurn,
  playCard,
  startPlayerTurn,
} from '../src/game/combat.ts'
import { actionsFor, advanceCube, enemyDef, startingHp } from '../src/game/enemies.ts'
import { STARTER_DECKS } from '../src/game/cards.ts'
import { createRng } from '../src/game/rng.ts'
import { suite, check, assert, assertEqual, assertDeepEqual, report } from './lib/harness.mjs'

let uid = 0
const instance = (defId, upgraded = false) => ({ uid: `c${uid++}`, defId, upgraded })

const player = (over = {}) => ({
  id: 'p1', name: 'Ironclad', character: 'ironclad', row: 0,
  hp: 10, maxHp: 10, block: 0, energy: 3,
  deck: [], draw: [], hand: [], discard: [], exhaust: [], powers: [],
  strength: 0, shivs: 0, miracles: 0, stance: 'neutral', orbs: [null, null, null],
  dead: false, ...over,
})

const enemy = (over = {}) => ({
  uid: 'e1', defId: 'red_louse', row: 0, isBoss: false,
  hp: 6, maxHp: 6, block: 0,
  strength: 0, vulnerable: 0, weak: 0, poison: 0, actionIndex: 0, dead: false, ...over,
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
    [enemy({ row: 0 })],
  )
  const next = enemyTurn(state)
  assertEqual(next.players[0].hp, 9, 'the player sharing the row takes the hit')
  assertEqual(next.players[1].hp, 10, 'a player in another row is untouched')
})

check('player Block absorbs an enemy attack', () => {
  const next = enemyTurn(inEnemyPhase([player({ block: 3 })], [enemy()]))
  assertEqual(next.players[0].hp, 10, 'Block prevents the damage')
  assertEqual(next.players[0].block, 2, 'and one Block is spent doing so')
})

// p.13: enemy Block is cleared at the start of the ENEMY turn, not the player's.
check('enemy Block clears at the start of the Enemy Turn', () => {
  const next = enemyTurn(inEnemyPhase([player()], [enemy({ block: 4 })]))
  assertEqual(next.enemies[0].block, 0, 'leftover enemy Block is removed before it acts')
})

check('player Block is NOT cleared by the Enemy Turn', () => {
  const next = enemyTurn(inEnemyPhase([player({ block: 5 })], [enemy()]))
  assertEqual(next.players[0].block, 4, 'player Block persists into the Enemy Turn, minus what it absorbed')
})

check('an enemy gaining Block keeps it on itself, never on a player', () => {
  const state = inEnemyPhase([player()], [enemy({ defId: 'jaw_worm', hp: 8 })])
  const next = enemyTurn({ ...state, die: 5 })
  assertEqual(next.enemies[0].block, 1, 'Jaw Worm blocks itself on a 5')
  assertEqual(next.players[0].block, 0, 'the player gains nothing')
  assertEqual(next.enemies[0].strength, 1, 'and gains Strength on that roll')
})

check('a die-pattern enemy acts on the shared roll', () => {
  const state = inEnemyPhase([player()], [enemy({ defId: 'jaw_worm', hp: 8 })])
  const rolled1 = enemyTurn({ ...state, die: 1 })
  assertEqual(rolled1.players[0].hp, 8, 'on a 1 the Jaw Worm hits for 2')

  const rolled3 = enemyTurn({ ...state, die: 3 })
  assertEqual(rolled3.players[0].hp, 9, 'on a 3 it hits for 1 and blocks')
  assertEqual(rolled3.enemies[0].block, 1, 'and blocks itself for 1 on that roll')
})

check('enemy Strength adds to its attacks', () => {
  const next = enemyTurn(inEnemyPhase([player()], [enemy({ strength: 2 })]))
  assertEqual(next.players[0].hp, 7, 'a 1-damage attack with 2 Strength deals 3')
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
  // Red Louse attacks its own row; force an AoE action to exercise the branch.
  const aoe = { ...state, enemies: [{ ...state.enemies[0], defId: 'cultist', actionIndex: 1 }] }
  const next = enemyTurn(aoe)
  assertEqual(next.players[0].hp, 9, 'the row occupant is hit')
  assertEqual(next.players[1].hp, 10, 'a non-AoE attack does not reach other rows')
  assertEqual(next.enemies[0].uid, 'e1')
})

// p.13: the cube walks down and loops to the topmost RED slot; grey slots fire once.
check('a cube enemy runs its one-time slot then loops past it', () => {
  const cultist = enemyDef('cultist')
  assertDeepEqual(actionsFor(cultist, 1, 0), [{ kind: 'gainStrength', amount: 1 }], 'slot 0 is the ritual')
  assertEqual(advanceCube(cultist, 0), 1, 'the cube moves down')
  assertEqual(advanceCube(cultist, 1), 1, 'at the bottom it returns to the first repeating slot, skipping the grey one')
})

check('the Cultist buffs once then attacks forever', () => {
  let state = inEnemyPhase([player()], [enemy({ defId: 'cultist', hp: 6 })])
  state = enemyTurn(state)
  assertEqual(state.enemies[0].strength, 1, 'first turn is the ritual')
  assertEqual(state.players[0].hp, 10, 'and deals no damage')

  state = enemyTurn({ ...state, phase: 'enemy' })
  assertEqual(state.players[0].hp, 8, 'second turn attacks for 1 + 1 Strength')
  assertEqual(state.enemies[0].strength, 1, 'the ritual does not repeat')

  state = enemyTurn({ ...state, phase: 'enemy' })
  assertEqual(state.players[0].hp, 6, 'and keeps attacking')
})

check('a single-action enemy repeats the same action every turn', () => {
  let state = inEnemyPhase([player()], [enemy()])
  state = enemyTurn(state)
  state = enemyTurn({ ...state, phase: 'enemy' })
  assertEqual(state.players[0].hp, 8, 'two turns of 1 damage')
})

check('the Enemy Turn hands play back to the players', () => {
  const next = enemyTurn(inEnemyPhase([player()], [enemy()]))
  assertEqual(next.phase, 'player', 'the round returns to the Player Turn')
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

// A player at 0 HP ends the game for the whole party (p.13).
check('a player dying loses the game for everyone', () => {
  const next = enemyTurn(inEnemyPhase([player({ hp: 1 })], [enemy({ strength: 3 })]))
  assert(next.players[0].dead, 'the player should be dead')
  assertEqual(next.phase, 'lost', 'any death ends the run in defeat')
})

check('HP scales with the party size', () => {
  const nob = { id: 'nob', name: 'Gremlin Nob', hpByPlayers: [14, 28, 42, 56], pattern: { kind: 'single', actions: [] } }
  assertEqual(startingHp(nob, 1), 14, 'solo uses the first HP column')
  assertEqual(startingHp(nob, 3), 42, 'three players use the third column')
  assertEqual(startingHp(nob, 4), 56, 'four players use the fourth column')
  assertEqual(startingHp(nob, 9), 56, 'more than four players clamps to the four-player column')
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
  state = enemyTurn(state)
  assertEqual(state.phase, 'player', 'and back around for another round')
  assertEqual(state.turn, 1, 'one Player Turn has been taken so far')
  state = startPlayerTurn(state)
  assertEqual(state.turn, 2, 'the second round increments the turn counter')
  assertEqual(state.players[0].hand.length, 5, 'a fresh hand is drawn each round')
})

report('enemy turn')
