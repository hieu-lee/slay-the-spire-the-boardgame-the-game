import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRun, createCombat, spendVigor, playCard, endPlayerTurn } from '../src/game/state.ts'
import { createStore, createRoom, joinRoom, startRun, apply, snapshotFor, saveStore } from './lib/rooms.mjs'
import { check, report } from './lib/harness.mjs'
function fixture(mode = 'attack') {
  const run = createRun(910, [{ id: 'p1', name: 'Guardian', character: 'guardian' }])
  const enemy = { uid: 'e1', defId: 'jaw_worm', row: 0, isBoss: false, hp: 100, maxHp: 100,
    block: 0, strength: 0, vulnerable: 0, weak: 0, poison: 0, goldReward: 0, cardReward: null,
    actionIndex: 0, abilityUsed: false, dead: false }
  const state = createCombat({ seed: 910, calls: 0 }, run.players, [enemy], 'vigor')
  Object.assign(state.players[0], { vigor: 3, vigorSpentThisTurn: 0, guardianMode: mode, strength: 0, block: 0,
    hand: [{ uid: 'attack', defId: 'guardian_strike', upgraded: false }, { uid: 'block', defId: 'guardian_defend', upgraded: false }] })
  return state
}
for (const mode of ['attack', 'defense']) check(`Spend incrementally in ${mode} Mode and boost later cards`, () => {
  const original = fixture(mode)
  const once = spendVigor(original, 'p1')
  assert.deepEqual([original.players[0].vigor, original.players[0].vigorSpentThisTurn], [3, 0])
  assert.deepEqual([once.players[0].vigor, once.players[0].vigorSpentThisTurn, once.players[0].strength, once.players[0].block], [2, 1, 0, 0])
  const twice = spendVigor(once, 'p1')
  const played = playCard(twice, 'p1', mode === 'attack' ? 'attack' : 'block', { enemyUid: 'e1', playerId: 'p1' })
  assert.notEqual(played, twice)
  assert.equal(mode === 'attack' ? 100 - played.enemies[0].hp : played.players[0].block, 3)
  const third = spendVigor(played, 'p1')
  assert.deepEqual([third.players[0].vigor, third.players[0].vigorSpentThisTurn], [0, 3])
  assert.equal(spendVigor(third, 'p1'), third)
  const ended = endPlayerTurn(third)
  assert.equal(ended.players[0].vigorSpentThisTurn, 0)
})
check('Corrupted Shard users can spend Vigor in an established Guardian Mode', () => {
  const state = fixture()
  state.players[0].character = 'ironclad'
  const spent = spendVigor(state, 'p1')
  assert.deepEqual([spent.players[0].vigor, spent.players[0].vigorSpentThisTurn], [2, 1])
  const played = playCard(spent, 'p1', 'attack', { enemyUid: 'e1' })
  assert.equal(100 - played.enemies[0].hp, 2)
})
check('Reject off-turn, foreign, empty, locked and forced-choice spending', () => {
  for (const phase of ['start', 'enemy', 'discard', 'roundEnd', 'copy']) {
    const state = fixture(); state.phase = phase
    assert.equal(spendVigor(state, 'p1'), state)
  }
  for (const changes of [{ vigor: 0 }, { dead: true }, { character: 'ironclad', guardianMode: null }, { guardianMode: null }, { cardPlayLocked: true }]) {
    const state = fixture(); Object.assign(state.players[0], changes)
    assert.equal(spendVigor(state, 'p1'), state)
  }
  for (const blocked of [
    { pendingDistilled: {} }, { pendingRelicScry: {} }, { pendingTriggers: [{}] },
    { pendingHermitSetupLoads: ['p1'] },
  ]) {
    const state = fixture(); Object.assign(state, blocked)
    assert.equal(spendVigor(state, 'p1'), state)
  }
  const warped = fixture()
  warped.enemies[0].defId = 'time_eater'
  warped.players[0].cardsPlayedThisTurn = 100
  assert.equal(spendVigor(warped, 'p1'), warped)
  const state = fixture()
  assert.equal(spendVigor(state, 'foreign'), state)
  state.startTurnProgress = { choices: [], forcedCard: { playerId: 'p1', cardUid: 'attack' } }
  assert.equal(spendVigor(state, 'p1'), state)
})
check('Room spending is seat-authoritative, public, and survives reconnect and restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'vigor-'))
  try {
    const file = join(directory, 'rooms.json')
    const store = createStore({ file })
    const room = createRoom(store, { code: 'VIGOR' })
    const owner = joinRoom(room, { name: 'Guardian', character: 'guardian' })
    const peer = joinRoom(room, { name: 'Ally', character: 'ironclad' })
    startRun(room, owner.token, { seed: 910 })
    const combat = fixture()
    combat.players[0].id = owner.playerId
    combat.players.push({ ...room.run.players[1], hand: [], draw: [], discard: [] })
    room.run = { ...room.run, phase: 'combat', combat }
    assert.throws(() => apply(room, peer.token, { kind: 'spendVigor', playerId: owner.playerId }))
    assert.equal(room.run.combat.players[0].vigor, 3)
    apply(room, owner.token, { kind: 'spendVigor' })
    const seen = snapshotFor(room, peer.token).run.combat.players[0]
    assert.deepEqual([seen.vigor, seen.vigorSpentThisTurn, seen.hand], [2, 1, null])
    joinRoom(room, { token: owner.token, connected: true })
    saveStore(store)
    const restored = createStore({ file }).rooms.get('VIGOR')
    assert.deepEqual([restored.run.combat.players[0].vigor, restored.run.combat.players[0].vigorSpentThisTurn], [2, 1])
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
report('Vigor controls')
