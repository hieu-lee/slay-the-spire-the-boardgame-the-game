// Printed-card regressions from the September 2026 visual audit.
import assert from 'node:assert/strict'
import { createRun } from '../src/game/run.ts'
import { createCombat, playCard, activatePower } from '../src/game/combat.ts'
import { cardDef, faceOf } from '../src/game/cards.ts'
import { cardPlayerChoiceCount, effectiveCombatCardDef, guardianCardNeedsAlly } from '../src/game/combat/queries.ts'
import { check, report } from './lib/harness.mjs'

function fixture(id, upgraded = false, mode = 'attack', gem) {
  const run = createRun(902, [
    { id: 'p1', name: 'Guardian', character: 'guardian' },
    { id: 'p2', name: 'Ally', character: 'ironclad' },
  ])
  const enemies = [0, 1, 2].map((i) => ({
    uid: `e${i}`, defId: 'jaw_worm', row: i === 2 ? 1 : 0, isBoss: false,
    hp: 100, maxHp: 100, block: 0, strength: 0, vulnerable: 0, weak: 0,
    poison: 0, goldReward: 0, cardReward: null, actionIndex: 0, abilityUsed: false, dead: false,
  }))
  const state = createCombat({ seed: 902, calls: 0 }, run.players, enemies, 'guardian-audit')
  Object.assign(state.players[0], {
    hand: [{ uid: 'card', defId: id, upgraded, ...(gem ? { attachedGemId: gem } : {}) }],
    draw: Array.from({ length: 8 }, (_, i) => ({ uid: `draw${i}`, defId: 'guardian_strike', upgraded: false })),
    discard: [], energy: 3, guardianMode: mode, vigor: 0, vigorSpentThisTurn: 0,
  })
  return state
}
function play(state, extra = {}) {
  const next = playCard(state, 'p1', 'card', { enemyUid: 'e0', playerId: 'p2', ...extra })
  assert.notEqual(next, state, 'card play was rejected')
  return next
}

for (const upgraded of [false, true]) {
  for (const mode of ['attack', 'defense']) {
    check(`Vigor and Energy are distinct (${mode}, upgrade=${upgraded})`, () => {
      const core = play(fixture('guardian_charge_core', upgraded, mode)).players[0]
      assert.deepEqual([core.vigor, core.energy], [1, 2])
      assert.equal(core.exhaust.some(c => c.uid === 'card'), !upgraded)
      const beam = play(fixture('guardian_poly_beam', upgraded, mode)).players[0]
      assert.deepEqual([beam.vigor, beam.energy], [0, mode === 'attack' ? 3 : 2])
      const exploit = play(fixture('guardian_exploit_gems', upgraded, mode)).players[0]
      assert.deepEqual([exploit.vigor, exploit.energy], [0, upgraded ? 5 : 4])
    })
    check(`Overload draws then shifts (${mode}, upgrade=${upgraded})`, () => {
      const next = play(fixture('guardian_overload', upgraded, mode))
      assert.equal(next.players[0].hand.length, upgraded ? 5 : 4)
      assert.equal(next.players[0].guardianMode, mode === 'attack' ? 'defense' : 'attack')
      const locked = fixture('guardian_overload', upgraded, mode)
      locked.players[0].guardianModeLocked = true
      assert.equal(play(locked).players[0].guardianMode, mode)
    })
    check(`Refracted Beam has no area effect (${mode}, upgrade=${upgraded})`, () => {
      const state = fixture('guardian_refracted_beam', upgraded, mode)
      state.players[0].vigorSpentThisTurn = 1
      const next = play(state)
      const amount = upgraded ? 4 : 3
      assert.deepEqual(next.enemies.map(e => e.hp), mode === 'attack' ? [100 - amount, 100, 100] : [100, 100, 100])
      assert.deepEqual(next.players.map(p => p.block), mode === 'defense' ? [amount, 0] : [0, 0])
      if (mode === 'attack') assert.equal(playCard(state, 'p1', 'card', { enemyUid: null, playerId: null }), state)
    })
  }
  check(`Stasis Field assigns every printed Block icon (upgrade=${upgraded})`, () => {
    const state = fixture('guardian_stasis_field', upgraded, 'defense')
    state.players[0].vigorSpentThisTurn = 1
    const count = upgraded ? 5 : 4
    assert.equal(cardPlayerChoiceCount(faceOf(cardDef('guardian_stasis_field'), upgraded)), count)
    assert.equal(playCard(state, 'p1', 'card', { enemyUid: null, playerId: null, playerIds: Array(count - 1).fill('p2') }), state)
    const next = play(state, { playerIds: ['p1', ...Array(count - 1).fill('p2')] })
    assert.deepEqual(next.players.map(p => p.block), [2, 2 * (count - 1)])
  })
  check(`Body Crash has two X hits, not X squared (upgrade=${upgraded})`, () => {
    for (const paid of [0, 1, 3]) {
      const state = fixture('guardian_body_crash', upgraded)
      Object.assign(state.players[0], { block: 4, vigorSpentThisTurn: 1 })
      const next = play(state, { guardianBlockSpend: paid })
      assert.equal(next.enemies[0].hp, 100 - 2 * (paid + 1))
      assert.equal(next.players[0].block, 4 - paid)
    }
  })
  check(`Resilient Plate counts both icons; Evade doubles exactly (upgrade=${upgraded})`, () => {
    const plate = fixture('guardian_resilient_plate', upgraded, 'defense')
    plate.players[0].vigorSpentThisTurn = 1
    assert.equal(play(plate).players[0].block, (upgraded ? 4 : 3) + 2)
    const evade = fixture('guardian_evade', upgraded, 'defense')
    Object.assign(evade.players[0], { block: 1, vigorSpentThisTurn: 1 })
    assert.equal(play(evade).players[0].block, 2 * (1 + (upgraded ? 3 : 2) + 1))
  })
  for (const id of ['guardian_prismatic_barrier', 'guardian_prismatic_spray']) {
    check(`${id} spreads damage/debuffs but not Block (upgrade=${upgraded})`, () => {
      for (const gem of ['guardian_sapphire', 'guardian_bismuth', 'guardian_emerald', 'guardian_garnet', 'guardian_ruby']) {
        const state = fixture(id, upgraded, 'attack', gem)
        state.players[0].hand.push({ uid: 'other', defId: 'guardian_crystal_edge', upgraded: false })
        const next = play(state)
        assert.deepEqual(next.players.map(p => p.block), [
          ['guardian_sapphire', 'guardian_bismuth'].includes(gem) ? 1 : 0,
          id === 'guardian_prismatic_barrier' ? (upgraded ? 2 : 1) : 0,
        ])
        if (gem === 'guardian_emerald') assert.deepEqual(next.enemies.map(e => e.weak), [1, 1, 0])
        if (gem === 'guardian_garnet') assert.deepEqual(next.enemies.map(e => e.vulnerable), [1, 1, 0])
        if (gem === 'guardian_ruby') assert.deepEqual(next.enemies.map(e => e.hp),
          id === 'guardian_prismatic_barrier' ? [99, 99, 100] : [98 - Number(upgraded), 98 - Number(upgraded), 100])
      }
      const def = effectiveCombatCardDef(faceOf(cardDef(id), upgraded), 'attack')
      assert.equal(guardianCardNeedsAlly(def, { guardianMode: 'attack' }), id === 'guardian_prismatic_barrier')
    })
  }
}
for (const gem of ['guardian_tourmaline', 'guardian_aquamarine']) {
  check(`${gem} gains its own Vigor and respects the four-token cap`, () => {
    for (const [available, spent] of [[0, 0], [2, 1], [2, 2], [0, 4]]) {
      const state = fixture('guardian_bauble_burst', false, 'attack', gem)
      Object.assign(state.players[0], { vigor: available, vigorSpentThisTurn: spent })
      state.players[0].hand.push({ uid: 'spare', defId: 'guardian_strike', upgraded: false })
      const next = play(state)
      const gained = Math.min(2, 4 - available - spent)
      assert.deepEqual([next.players[0].vigor, next.players[0].vigorSpentThisTurn],
        gem === 'guardian_tourmaline' ? [available, spent + gained] : [available + gained, spent])
      assert.equal(next.players[0].energy, 1)
      if (gem === 'guardian_aquamarine') assert.equal(playCard(next, 'p1', 'spare', { enemyUid: 'e0', playerId: null }), next)
    }
    const state = fixture('guardian_floating_orbs', false, 'defense', gem)
    state.players[0].powers = state.players[0].hand
    state.players[0].hand = []
    const next = activatePower(state, 'p1', 'card', { enemyUid: null, playerId: null })
    assert.notEqual(next, state)
    assert.deepEqual([next.players[0].vigor, next.players[0].vigorSpentThisTurn], gem === 'guardian_tourmaline' ? [0, 1] : [1, 0])
  })
}
report('Guardian printed-card audit')
