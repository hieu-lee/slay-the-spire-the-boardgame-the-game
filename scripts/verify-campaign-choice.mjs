import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRun, createCampaignProgress } from '../src/game/state.ts'
import { BOSSES } from '../src/game/run/encounters.ts'
import { DOWNFALL_BOSSES } from '../src/game/downfall/enemies.ts'
import { advanceAct, enterRoom } from '../src/game/run/rooms.ts'
import { finishQuickSetup } from '../src/game/run/quick-setup.ts'
import { createRoom, createStore, joinRoom, saveStore, snapshotFor, startRun, selectCampaign } from './lib/rooms.mjs'

const party = [
  { id: 'p1', name: 'Ironclad', character: 'ironclad' },
  { id: 'p2', name: 'Guardian', character: 'guardian' },
]
for (const campaign of ['base', 'downfall']) {
  const bosses = campaign === 'base' ? BOSSES : DOWNFALL_BOSSES
  for (const members of [party.slice(0, 1), party.slice(1), party]) {
    let run = createRun(840, members, 3, createCampaignProgress(), false, false, { campaign })
    assert.equal(run.meta.campaign, campaign)
    assert(bosses[1].includes(run.actBossDefId))
    assert.equal(run.eventDeck.some((card) => card.id.startsWith('downfall_')), campaign === 'downfall')
    for (const member of members) {
      const blessing = run.neow.players[member.id]
      assert.equal(blessing.cardId.startsWith('heart_boon_'), member.character === 'guardian')
      assert.equal(blessing.redGoldPending, member.character === 'ironclad')
      assert.equal(blessing.redRewardsRemaining, member.character === 'guardian' ? 3 : 1)
    }
    if (members.some((member) => member.character === 'guardian')) assert(run.guardianGemDeck.length > 0)
    for (const act of [1, 2, 3]) {
      assert(bosses[act].includes(run.actBossDefId))
      const bossId = run.map.rows.at(-1)[0]
      const approach = Object.values(run.map.rooms).find((room) => room.exits.includes(bossId))
      const combat = enterRoom({ ...run, phase: 'map', neow: null, map: { ...run.map, position: approach.id } }, bossId)
      assert.equal(combat.phase, 'combat')
      assert(combat.combat.enemies.some((enemy) => enemy.defId === run.actBossDefId))
      if (act < 3) run = advanceAct({ ...run, phase: 'victory', neow: null, map: { ...run.map, position: bossId, rooms: { ...run.map.rooms, [bossId]: { ...run.map.rooms[bossId], visited: true } } } })
    }
    const quick = finishQuickSetup(createRun(840, members, 3, createCampaignProgress(), false, false,
      { campaign, quickStartAct: 3 }))
    assert.equal(quick.act, 3)
    assert(bosses[3].includes(quick.actBossDefId))
    assert.equal(quick.eventDeck.some((card) => card.id.startsWith('downfall_')), campaign === 'downfall')
  }
  const directory = mkdtempSync(join(tmpdir(), 'sts-campaign-'))
  try {
    const file = join(directory, 'rooms.json')
    const store = createStore({ file })
    const room = createRoom(store, { code: 'CAMPXX' })
    const host = joinRoom(room, { character: 'ironclad' })
    const guest = joinRoom(room, { character: 'guardian' })
    assert.throws(() => selectCampaign(room, guest.token, true))
    selectCampaign(room, host.token, true)
    assert.equal(snapshotFor(room, guest.token).selectingCampaign, true)
    saveStore(store)
    assert.equal(snapshotFor(createStore({ file }).rooms.get(room.code), guest.token).selectingCampaign, true)
    assert.throws(() => startRun(room, guest.token, { campaign }))
    assert.throws(() => startRun(room, host.token, { campaign: 'invalid' }))
    assert.equal(room.run, null)
    startRun(room, host.token, { seed: 841, campaign })
    assert.throws(() => startRun(room, host.token, { campaign }))
    saveStore(store)
    const restored = createStore({ file }).rooms.get(room.code)
    const view = snapshotFor(restored, guest.token)
    assert.equal(view.selectingCampaign, false)
    assert.equal(view.run.meta.campaign, campaign)
    assert(bosses[1].includes(view.run.actBossDefId))
    assert.equal('deck' in view.run.neow, false)
    assert.equal('heartDeck' in view.run.neow, false)
  } finally { rmSync(directory, { recursive: true, force: true }) }
}
console.log('Campaign selection: solo, mixed parties, Acts, Quick Start, authority and restore passed')
