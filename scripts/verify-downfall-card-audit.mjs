import assert from 'node:assert/strict'
import { createRun } from '../src/game/run.ts'
import { createCombat, playCard, activatePower, cardNeedsEnemy, startPlayerTurnWithChoices, startTurnAbilities, resolveStartPlayerTurn } from '../src/game/combat.ts'
import { cardDef, faceOf } from '../src/game/cards.ts'
import { check, report } from './lib/harness.mjs'
function fixture(id, upgraded = false) {
  const character = cardDef(id).owner
  const run = createRun(902, [{ id: 'p1', name: 'Actor', character }, { id: 'p2', name: 'Ally', character: 'ironclad' }])
  const enemies = [0, 1, 2].map(i => ({ uid: `e${i}`, defId: 'jaw_worm', row: i === 2 ? 1 : 0,
    isBoss: false, hp: 100, maxHp: 100, block: 0, strength: 0, vulnerable: 0, weak: 0,
    poison: 0, goldReward: 0, cardReward: null, actionIndex: 0, abilityUsed: false, dead: false }))
  const state = createCombat({ seed: 902, calls: 0 }, run.players, enemies, 'downfall-audit')
  state.pendingHermitSetupLoads = []
  Object.assign(state.players[0], { hand: [{ uid: 'card', defId: id, upgraded }], draw: [], discard: [],
    energy: 3, block: 0, chamber: [], powers: [] })
  return state
}
function play(state, context = {}) {
  const next = playCard(state, 'p1', 'card', { enemyUid: 'e0', playerId: 'p1', ...context })
  assert.notEqual(next, state, 'play rejected')
  return next
}
for (const upgraded of [false, true]) {
  check(`Forked Flame hits one target three times (${upgraded})`, () => {
    const state = fixture('forked_flame', upgraded)
    state.players[0].strength = 1
    const next = play(state, { mode: 0 })
    assert.deepEqual(next.enemies.map(e => e.hp), [100 - 3 * (upgraded ? 3 : 2), 100, 100])
  })
  check(`Growth costs two Energy (${upgraded})`, () => {
    const state = fixture('slime_boss_growth', upgraded)
    const next = play(state, { slimeUids: [state.players[0].slimes[0].card.uid] })
    assert.equal(next.players[0].energy, 1)
    assert.equal(next.players[0].block, upgraded ? 3 : 2)
  })
  check(`Pile On repeats modified hits per Slime (${upgraded})`, () => {
    for (const count of [0, 1, 3]) {
      const state = fixture('slime_boss_pile_on', upgraded)
      const actor = state.players[0]
      actor.slimes = Array.from({ length: count }, (_, i) => ({ ...actor.slimes[0], card: { ...actor.slimes[0].card, uid: `s${i}` } }))
      actor.strength = 1
      assert.equal(cardNeedsEnemy(faceOf(cardDef('slime_boss_pile_on'), upgraded), actor), count > 0)
      const next = play(state)
      assert.equal(next.enemies[0].hp, 100 - count * (upgraded ? 3 : 2))
    }
  })
  check(`Leech Energy applies the printed Block bonus only with Retain (${upgraded})`, () => {
    for (const retain of [false, true]) {
      const state = fixture('slime_boss_leech_energy', upgraded)
      state.players[0].cardBlockBonus = 2
      if (retain) state.players[0].hand.push({ uid: 'retain', defId: 'slime_boss_repurpose', upgraded: false })
      assert.equal(play(state).players[0].block, retain ? 3 : 0)
    }
  })
  check(`Shadow Cloak pays a private Curse before granting Block (${upgraded})`, () => {
    for (const zone of ['hand', 'chamber']) {
      const state = fixture('hermit_shadow_cloak', upgraded)
      const actor = state.players[0]
      actor.powers = actor.hand; actor.hand = []
      actor[zone] = [{ uid: 'curse', defId: 'hermit_scorn', upgraded: false }]
      assert.equal(activatePower(state, 'p1', 'card'), state)
      assert.equal(activatePower(state, 'p1', 'card', { chamberUids: ['foreign'] }), state)
      const next = activatePower(state, 'p1', 'card', { chamberUids: ['curse'] })
      assert.notEqual(next, state)
      assert.equal(next.players[0][zone].length, 0)
      assert.equal(next.players[0].discard[0].uid, 'curse')
      assert.equal(next.players[0].block, upgraded ? 3 : 2)
      assert.equal(activatePower(next, 'p1', 'card'), next)
    }
    const empty = fixture('hermit_shadow_cloak', upgraded)
    empty.players[0].powers = empty.players[0].hand; empty.players[0].hand = []
    assert.equal(activatePower(empty, 'p1', 'card'), empty)
  })
  check(`Prepare Crush deals unmodified damage then discards (${upgraded})`, () => {
    const state = fixture('slime_boss_prepare_crush', upgraded)
    state.players[0].powers = state.players[0].hand; state.players[0].hand = []
    state.players[0].strength = 3
    state.players[0].weak = 1
    state.enemies[0].vulnerable = 1
    const prepared = startPlayerTurnWithChoices(state)
    const ability = startTurnAbilities(prepared).find(a => a.label.includes('Prepare Crush'))
    assert(ability)
    const next = resolveStartPlayerTurn(prepared, [{ id: ability.id, enemyUid: 'e0', shivEnemyUids: [] }])
    assert.equal(next.enemies[0].hp, upgraded ? 80 : 85)
    assert.equal(next.enemies[0].vulnerable, 1)
    assert.equal(next.players[0].weak, 1)
    assert(!next.players[0].powers.some(c => c.uid === 'card'))
    assert(next.players[0].discard.some(c => c.uid === 'card'))
  })
}
check('Ooze Bath continues after a stale target in the middle of its Commands', () => {
  const state = fixture('slime_boss_ooze_bath')
  state.players[0].hand.push(...Array.from({ length: 3 }, (_, i) => ({ uid: `retain${i}`, defId: 'slime_boss_repurpose', upgraded: false })))
  state.enemies[0].hp = 1
  const next = play(state, { slimeUids: [state.players[0].slimes[0].card.uid], slimeEnemyUids: ['e0', 'e0', 'e1'] })
  assert.deepEqual(next.enemies.map(e => e.hp), [0, 99, 100])
  assert.equal(next.players[0].slimes[0].commandsThisTurn, 2)
})
report('Downfall printed card audit')
