// Regressions derived from the shipped original-hero card scans and rulebook p.14.
import assert from 'node:assert/strict'
import { createRun } from '../src/game/run.ts'
import { createCombat, playCard } from '../src/game/combat.ts'
import { cardDef } from '../src/game/cards.ts'
import { createStore, createRoom, joinRoom, startRun, apply, snapshotFor } from './lib/rooms.mjs'
import { check, report } from './lib/harness.mjs'

function fixture(id, upgraded = false) {
  const run = createRun(912, [
    { id: 'p1', name: 'Hero', character: cardDef(id).owner },
    { id: 'p2', name: 'Ally', character: 'ironclad' },
  ])
  const enemies = [0, 1].map(i => ({ uid: `e${i}`, defId: 'jaw_worm', row: i, isBoss: false,
    hp: 100, maxHp: 100, block: 0, strength: 0, vulnerable: 0, weak: 0, poison: 0,
    goldReward: 0, cardReward: null, actionIndex: 0, abilityUsed: false, dead: false }))
  const state = createCombat({ seed: 912, calls: 0 }, run.players, enemies, 'original-card-audit')
  Object.assign(state.players[0], { hand: [{ uid: 'card', defId: id, upgraded }],
    draw: [], discard: [], energy: 3, strength: 0, block: 0 })
  return state
}
function play(state, extra = {}) {
  const next = playCard(state, 'p1', 'card', { enemyUid: 'e0', playerId: null, ...extra })
  assert.notEqual(next, state, 'card play rejected')
  return next
}
for (const upgraded of [false, true]) {
  check(`Sentinel exhaust Energy (upgrade=${upgraded})`, () => {
    const state = fixture('burning_pact')
    state.players[0].energy = 1
    state.players[0].hand.push({ uid: 'fuel', defId: 'sentinel', upgraded })
    assert.equal(play(state, { exhaustUids: ['fuel'] }).players[0].energy, upgraded ? 3 : 2)
  })
  check(`Choke counts only Weak and Poison (upgrade=${upgraded})`, () => {
    const state = fixture('choke', upgraded)
    Object.assign(state.enemies[0], { strength: 3, vulnerable: 2, weak: 2, poison: 4 })
    const next = play(state)
    assert.equal(next.enemies[0].hp, 100 - 2 * ((upgraded ? 4 : 3) + 2 + 4))
    assert.equal(next.enemies[0].vulnerable, 1)
  })
  for (const id of ['flechettes', 'brilliance']) {
    check(`${id} applies Strength to every hit, including zero-count behavior (upgrade=${upgraded})`, () => {
      for (const count of [0, 2]) {
        const state = fixture(id, upgraded)
        Object.assign(state.players[0], { strength: 1, miracles: count })
        if (id === 'flechettes') state.players[0].hand.push(...Array.from({ length: count }, (_, i) =>
          ({ uid: `skill${i}`, defId: 'defend_silent', upgraded: false })))
        state.enemies[0].vulnerable = 2
        const hits = count + Number(id === 'flechettes' && upgraded)
        const amount = id === 'flechettes' ? 1 : upgraded ? 3 : 2
        const next = play(state)
        assert.equal(next.enemies[0].hp, 100 - hits * (amount + 1) * 2)
        assert.equal(next.enemies[0].vulnerable, hits ? 1 : 2)
      }
    })
  }
  check(`Reinforced Body only blocks its owner (upgrade=${upgraded})`, () => {
    const state = fixture('reinforced_body', upgraded)
    state.players[0].cardBlockBonus = 1
    const next = play(state, { energySpent: 2, playerId: 'p2' })
    assert.deepEqual(next.players.map(p => p.block), upgraded ? [6, 0] : [4, 0])
    assert.equal(next.players[0].energy, 1)
    const zero = fixture('reinforced_body', upgraded)
    zero.players[0].cardBlockBonus = 1
    const playedZero = playCard(zero, 'p1', 'card', { energySpent: 0 })
    if (upgraded) assert.deepEqual(playedZero.players.map(p => p.block), [2, 0])
    else assert.equal(playedZero, zero)
  })
  check(`Distraction triggers on actual enemy tokens, once per turn (upgrade=${upgraded})`, () => {
    for (const [id, token, cap] of [['deadly_poison', 'poison', 30], ['terror', 'vulnerable', 3], ['disarm', 'weak', 3]]) {
      const state = fixture(id)
      state.players[0].powers.push({ uid: 'power', defId: 'distraction', upgraded })
      const next = play(state)
      assert.equal(next.players[0].block, 2, id)
      next.players[0].hand.push({ uid: 'card', defId: 'deadly_poison', upgraded: false })
      assert.equal(play(next).players[0].block, 2)
      const capped = fixture(id)
      capped.players[0].powers.push({ uid: 'power', defId: 'distraction', upgraded })
      capped.enemies[0][token] = cap
      assert.equal(play(capped).players[0].block, 0)
    }
  })
}
check('Tantrum+ keeps both hits on one target and enters Wrath afterward', () => {
  const state = fixture('tantrum', true)
  state.players[0].strength = 1
  state.enemies[0].vulnerable = 2
  const next = play(state)
  assert.deepEqual(next.enemies.map(e => e.hp), [92, 100])
  assert.equal(next.enemies[0].vulnerable, 1)
  assert.equal(next.players[0].stance, 'wrath')
  assert(next.players[0].draw.some(c => c.uid === 'card'))
  assert.equal(playCard(state, 'p1', 'card', { enemyUids: ['e0', 'e1'] }), state)
})
check('Room authority preserves corrected targets and private hands across reconnect', () => {
  for (const id of ['reinforced_body', 'tantrum']) {
    const room = createRoom(createStore(), { code: 'AUDIT' })
    const owner = joinRoom(room, { name: 'Hero', character: cardDef(id).owner })
    const peer = joinRoom(room, { name: 'Ally', character: 'ironclad' })
    startRun(room, owner.token, { seed: 912 })
    const state = fixture(id, true)
    state.players[0].id = owner.playerId
    state.players[1].id = peer.playerId
    room.run = { ...room.run, phase: 'combat', combat: state }
    assert.throws(() => apply(room, peer.token, { kind: 'playCard', cardUid: 'card', playerId: owner.playerId }))
    apply(room, owner.token, { kind: 'playCard', cardUid: 'card', enemyUid: 'e0',
      ...(id === 'reinforced_body' ? { energySpent: 2, playerId: peer.playerId } : {}) })
    joinRoom(room, { token: owner.token, connected: true })
    const seen = snapshotFor(room, peer.token).run.combat
    assert.equal(seen.players[0].hand, null)
    if (id === 'reinforced_body') assert.deepEqual(seen.players.map(p => p.block), [4, 0])
    else assert.deepEqual(seen.enemies.map(e => e.hp), [98, 100])
  }
})
report('Original hero printed-card audit')
