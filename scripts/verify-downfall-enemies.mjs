import assert from 'node:assert/strict'
import {
  DOWNFALL_BOSSES,
  DOWNFALL_BOSS_ENCOUNTERS,
  DOWNFALL_ENEMIES,
  DOWNFALL_PHYSICAL_ENEMY_CARDS,
  DOWNFALL_SELF_BOSS_REROLLS,
  DOWNFALL_SUMMON_DECKS,
  DOWNFALL_SUMMON_DECK_SIZES,
  downfallEnemyDef,
} from '../src/game/downfall/enemies.ts'
import { createCombat, enemyTurn, playCard, resolvePlunderRowSwitch, startPlayerTurn } from '../src/game/combat.ts'
import { applyEnemyAction } from '../src/game/combat/enemy-turn.ts'
import { beginEndPlayerTurn } from '../src/game/combat/end-turn.ts'
import { applyEffect, damageEnemyLogged, drawInto } from '../src/game/combat/effects.ts'
import { damageEnemy } from '../src/game/combat/pieces.ts'
import { preparePlayerTurn, resolveDueSummons } from '../src/game/combat/start-turn.ts'
import { createSummonSupply, enemyAttackBonus, enemyDef, startingHp } from '../src/game/enemies.ts'
import { buildEncounter, createEnemyDecks, rollActBoss } from '../src/game/run/encounters.ts'
import { canRerollDownfallSelfBoss, rerollDownfallSelfBoss } from '../src/game/run/rooms.ts'
import { createPlayer, createRun } from '../src/game/run/setup.ts'
import { createCampaignProgress } from '../src/game/campaign.ts'
import { createRng } from '../src/game/rng.ts'

const counts = (items) => Object.fromEntries([...new Set(items)].sort().map((item) =>
  [item, items.filter((candidate) => candidate === item).length]))
const names = (act) => counts(DOWNFALL_SUMMON_DECKS[act].map((id) => DOWNFALL_ENEMIES[id].name))
const action = (id, ascension, slot, index = 0) => {
  const pattern = downfallEnemyDef(id, ascension).pattern
  assert.equal(pattern.kind, 'cube', `${id} must use a cube track`)
  return pattern.slots[slot].actions[index]
}

assert.deepEqual(DOWNFALL_BOSSES, {
  1: ['downfall_witch', 'downfall_dark_core', 'downfall_wrathful'],
  2: ['downfall_orb_master', 'downfall_inferno', 'downfall_trickster'],
  3: ['downfall_demon', 'downfall_wraith', 'downfall_blasphemer'],
  4: ['downfall_neow'],
})
assert.deepEqual(DOWNFALL_SELF_BOSS_REROLLS, {
  ironclad: ['downfall_inferno', 'downfall_demon'],
  silent: ['downfall_witch', 'downfall_trickster', 'downfall_wraith'],
  defect: ['downfall_dark_core', 'downfall_orb_master'],
  watcher: ['downfall_wrathful', 'downfall_blasphemer'],
})
for (const [id, encounter] of Object.entries(DOWNFALL_BOSS_ENCOUNTERS)) {
  assert.equal(encounter.defId, id)
  assert(DOWNFALL_ENEMIES[id]?.isBoss, `${id} encounter must point at a boss`)
}
for (const encounter of Object.values(DOWNFALL_BOSS_ENCOUNTERS).filter(({ act }) => act <= 2)) {
  assert.equal(encounter.goldReward, 3)
  assert.equal(encounter.cardReward, 'normal')
  assert.equal(encounter.relicReward, true)
  assert.deepEqual(encounter.ascensionReward, { min: 10, goldReward: 2 })
}
assert.deepEqual(DOWNFALL_BOSS_ENCOUNTERS.downfall_orb_master.randomSummonsPerPlayer,
  { group: 'downfall_orb_master_orb', count: 2 })
assert.deepEqual(DOWNFALL_BOSS_ENCOUNTERS.downfall_neow.randomSummonsPerPlayer,
  { group: 'downfall_slayer', count: 1 })
assert.deepEqual(DOWNFALL_BOSS_ENCOUNTERS.downfall_neow.summonsPerPlayer, ['downfall_loot_chest'])
assert.deepEqual(DOWNFALL_BOSS_ENCOUNTERS.downfall_inferno.summons, ['downfall_flame_barrier'])
assert.deepEqual(DOWNFALL_BOSS_ENCOUNTERS.downfall_trickster.summons, ['downfall_doppelganger'])

const hpCases = {
  downfall_witch: [[35, 72, 111, 152], 10, [38, 80, 118, 160]],
  downfall_dark_core: [[32, 66, 102, 140], 10, [35, 72, 111, 152]],
  downfall_wrathful: [[44, 93, 147, 205], 10, [47, 100, 156, 218]],
  downfall_orb_master: [[45, 93, 144, 198], 10, [48, 100, 156, 216]],
  downfall_inferno: [[43, 88, 140, 190], 10, [45, 92, 143, 200]],
  downfall_trickster: [[35, 72, 111, 152], 10, [38, 80, 118, 160]],
  downfall_demon: [[50, 105, 165, 230], 10, [53, 114, 181, 256]],
  downfall_wraith: [[70, 145, 225, 310], 10, [70, 145, 225, 310]],
  downfall_blasphemer: [[90, 185, 285, 390], 10, [95, 200, 315, 440]],
  downfall_neow: [[75, 150, 225, 300], 11, [85, 170, 255, 340]],
  downfall_flame_barrier: [[16, 32, 48, 64], 10, [20, 40, 60, 80]],
  downfall_doppelganger: [[35, 72, 111, 152], 10, [38, 80, 118, 160]],
  downfall_corrupted: [[100, 210, 330, 460], 10, [107, 228, 363, 512]],
}
for (const [id, [base, threshold, harder]] of Object.entries(hpCases)) {
  assert.deepEqual(downfallEnemyDef(id, 0).hpByPlayers, base, `${id} base HP`)
  assert.deepEqual(downfallEnemyDef(id, threshold).hpByPlayers, harder, `${id} ascension HP`)
}

assert.deepEqual(action('downfall_witch', 0, 1), { kind: 'attack', amount: 3, aoe: true })
assert.deepEqual(action('downfall_witch', 10, 1), { kind: 'attack', amount: 4, aoe: true })
assert.deepEqual(action('downfall_dark_core', 10, 3), { kind: 'attack', amount: 4, aoe: true })
assert.deepEqual(action('downfall_orb_master', 0, 2, 1), { kind: 'addAbilityCube', amount: 1, perPlayer: true })
assert.deepEqual(action('downfall_wrathful', 0, 1), { kind: 'attack', amount: 2, aoe: true })
assert.deepEqual(action('downfall_wrathful', 10, 1), { kind: 'attack', amount: 4, aoe: true })
assert.deepEqual(action('downfall_inferno', 10, 1), { kind: 'attack', amount: 6, aoe: true })
assert.deepEqual(action('downfall_demon', 10, 2), { kind: 'attack', amount: 6, aoe: true })
assert.deepEqual(action('downfall_wraith', 10, 3), { kind: 'attack', amount: 8, aoe: true })
assert.deepEqual(action('downfall_blasphemer', 10, 0), { kind: 'attack', amount: 6, aoe: true })
assert.deepEqual(action('downfall_neow', 11, 0), { kind: 'shuffleCurse', amount: 3, aoe: true })
assert.deepEqual(action('downfall_neow', 11, 0, 1), { kind: 'daze', amount: 2, aoe: true })
assert.deepEqual(action('downfall_corrupted', 10, 2), {
  kind: 'attackSequence', hits: [{ amount: 2, aoe: true }, { amount: 2 }],
})
assert.equal(downfallEnemyDef('downfall_doppelganger', 10).pattern.slots[1].actions[0].amount, 2)

assert.deepEqual(DOWNFALL_SUMMON_DECK_SIZES, { 1: 39, 2: 40, 3: 33, 4: 8 })
for (const [act, expected] of Object.entries(DOWNFALL_SUMMON_DECK_SIZES)) {
  assert.equal(DOWNFALL_SUMMON_DECKS[act].length, expected, `Act ${act} summon count`)
}
assert.deepEqual(names(1), {
  'Acid Slime': 4, 'Dark Orb': 4, 'Fat Gremlin': 2, 'Fungi Beast': 1,
  'Green Louse': 2, 'Gremlin Wizard': 2, 'Large Slime': 4, 'Mad Gremlin': 2,
  'Red Louse': 1, 'Sentry A': 6, 'Sentry B': 5, 'Sneaky Gremlin': 2, 'Spike Slime': 4,
})
assert.deepEqual(names(2), {
  'Blue Slaver': 4, 'Bronze Orb': 4, Byrd: 3, Cultist: 4, 'Dark Orb': 2,
  'Frost Orb': 3, 'Fungi Beast': 1, 'Lightning Orb': 3, Mugger: 2, Mystic: 2,
  'Red Slaver': 4, 'Torch Head': 8,
})
assert.deepEqual(names(3), {
  Cultist: 4, Dagger: 8, Darkling: 2, Exploder: 1, 'Jaw Worm': 2,
  Repulsor: 1, Shiv: 12, 'Spheric Guardian': 1, Spiker: 2,
})
assert.deepEqual(names(4), {
  'Defect Slayer': 1, 'Ironclad Slayer': 1, 'Loot Chest': 4,
  'Silent Slayer': 1, 'Watcher Slayer': 1,
})

const sourceSpecs = {
  e07486: [3, 470000, undefined], '4cc01d': [3, 470100, 10],
  f69a29: [3, 469900, undefined], e58442: [3, 469600, 10],
  '2a2330': [3, 469800, undefined], '20ba8f': [3, 469700, 10],
  dd3174: [1, 468500, undefined], '3076ab': [1, 469500, 11],
  d0c833: [2, 470700, undefined], b7a5e8: [2, 470800, 10],
  '18155b': [2, 470400, undefined], '266706': [2, 470300, 10],
  '66fbad': [39, 467800, undefined], '485ed8': [40, 468000, undefined],
  e49dd1: [33, 468200, undefined], e077d5: [8, 470600, undefined],
}
assert.equal(DOWNFALL_PHYSICAL_ENEMY_CARDS.length, 148)
assert.equal(new Set(DOWNFALL_PHYSICAL_ENEMY_CARDS.map(({ guid, cardId }) => `${guid}:${cardId}`)).size, 148)
for (const [guid, [count, firstCardId, minAscension]] of Object.entries(sourceSpecs)) {
  const cards = DOWNFALL_PHYSICAL_ENEMY_CARDS.filter((card) => card.guid === guid)
  assert.equal(cards.length, count, `${guid} count`)
  assert.deepEqual(cards.map((card) => card.index), Array.from({ length: count }, (_, index) => index), `${guid} indexes`)
  assert.deepEqual(cards.map((card) => card.cardId), Array.from({ length: count }, (_, index) => firstCardId + index), `${guid} CardIDs`)
  assert(cards.every((card) => card.minAscension === minAscension), `${guid} ascension availability`)
}
for (const card of DOWNFALL_PHYSICAL_ENEMY_CARDS) {
  const def = DOWNFALL_ENEMIES[card.defId]
  assert(def, `${card.guid}/${card.index} missing ${card.defId}`)
  assert.equal(def.id, card.defId)
  assert.equal(def.hpByPlayers.length, 4)
  if (def.pattern.kind === 'die') assert.deepEqual(Object.keys(def.pattern.byRoll), ['1', '2', '3', '4', '5', '6'])
}

assert(Object.values(DOWNFALL_ENEMIES).every((def) => !('printedRules' in def)),
  'no Downfall mechanic may remain only as printedRules')

const makePlayer = (seed = 1, id = 'p1', row = 0) => createPlayer(createRng(seed), id, id, 'ironclad', row)
const makeEnemy = (defId, uid = defId, row = 0, ascension = 0, playerCount = 1) => {
  const def = enemyDef(defId, ascension)
  const hp = startingHp(def, playerCount)
  return {
    uid, defId, row, ascension, isBoss: def.isBoss === true, hp, maxHp: hp, block: 0, strength: 0,
    vulnerable: 0, weak: 0, poison: 0, goldReward: 0, cardReward: null,
    actionIndex: 0, phase: 0, abilityUsed: false, dead: false,
  }
}
const makeCombat = (defIds, ascension = 0, players = [makePlayer()]) => {
  const rng = createRng(901)
  return createCombat(rng, players, defIds.map((id, index) =>
    makeEnemy(id, `enemy-${index}`, Math.min(index, players.length - 1), ascension, players.length)),
  'downfall-test', [], 3, createSummonSupply(rng, 'downfall', 1))
}

// Registry, selection, encounter setup, physical summon replacement, and optional own-boss reroll.
assert.equal(enemyDef('downfall_witch').id, 'downfall_witch')
for (const act of [1, 2, 3, 4]) assert(DOWNFALL_BOSSES[act].includes(rollActBoss(createRng(100 + act), act, 'downfall')))
assert(createSummonSupply(createRng(2), 'downfall', 1).acid_slime.every((id) => id.startsWith('downfall_')))
assert(createSummonSupply(createRng(2), 'downfall', 2).blue_slaver.every((id) => id.startsWith('downfall_')))
assert(createSummonSupply(createRng(2), 'downfall', 3).darkling.every((id) => id.startsWith('downfall_')))
{
  const rng = createRng(77)
  const player = makePlayer(77)
  const encounter = buildEncounter(rng, createEnemyDecks(rng, 2, 0), 2, [player], 'boss', false, 0,
    'downfall_orb_master', null, 'downfall')
  assert.equal(encounter.enemies.filter(({ defId }) => defId !== 'downfall_orb_master' && defId.includes('_orb')).length, 2)
  const combat = createCombat(rng, [player], encounter.enemies, 'orb-master', [], 3, encounter.summonSupply)
  const boss = combat.enemies.find(({ defId }) => defId === 'downfall_orb_master')
  assert(boss && boss.abilityCubes >= 1 && boss.abilityCubes <= 5)
}
{
  const rng = createRng(78)
  const encounter = buildEncounter(rng, createEnemyDecks(rng, 2, 0), 2, [makePlayer(78)], 'boss', false, 0,
    'downfall_inferno', null, 'downfall')
  assert.deepEqual(encounter.enemies.map(({ defId }) => defId), ['downfall_flame_barrier', 'downfall_inferno'])
}
{
  const rng = createRng(79)
  const player = makePlayer(79)
  const encounter = buildEncounter(rng, createEnemyDecks(rng, 4, 0), 4, [makePlayer(79)], 'boss', false, 0,
    'downfall_neow', null, 'downfall')
  assert.equal(encounter.enemies.filter(({ defId }) => defId.endsWith('_slayer')).length, 1)
  assert.equal(encounter.enemies.filter(({ defId }) => defId === 'downfall_loot_chest').length, 1)
  const combat = createCombat(rng, [player], encounter.enemies, 'neow', [], 4, encounter.summonSupply)
  damageEnemyLogged(combat, combat.enemies.find(({ defId }) => defId === 'downfall_loot_chest'), 999, 'test')
  assert.deepEqual(combat.pendingPlunderSwitches, [{
    playerId: player.id, sourceUid: 'boss-0-downfall_loot_chest-0',
  }])
}
{
  const created = createRun(31, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }], 0,
    createCampaignProgress(), false, false, { ruleset: 'downfall' })
  assert(DOWNFALL_BOSSES[1].includes(created.actBossDefId))
  const run = {
    ...created,
    act: 2,
    actBossDefId: 'downfall_inferno',
  }
  assert.equal(canRerollDownfallSelfBoss(run), true)
  const rerolled = rerollDownfallSelfBoss(run)
  assert.notEqual(rerolled.actBossDefId, 'downfall_inferno')
  assert.equal(rerolled.selfBossRerolled, true)
  assert.equal(rerollDownfallSelfBoss(rerolled), rerolled)
}

// Start setup and direct end-of-turn HP loss survive ordinary state serialization.
{
  const combat = makeCombat(['downfall_witch'])
  assert.equal(combat.players[0].draw.filter(({ defId }) => defId === 'slimed').length, 2)
  const restored = structuredClone(JSON.parse(JSON.stringify(combat)))
  restored.phase = 'player'
  restored.players[0].hand = [
    { uid: 's1', defId: 'slimed', upgraded: false },
    { uid: 's2', defId: 'slimed', upgraded: false },
  ]
  const hpBefore = restored.players[0].hp
  const ended = beginEndPlayerTurn(restored)
  assert.equal(ended.players[0].hp, hpBefore - 2)
}
{
  const combat = makeCombat(['downfall_witch'], 10)
  assert.equal(combat.players[0].draw.filter(({ defId }) => defId === 'slimed').length, 3)
}

// Channel Dark buffs A10 summons; Wrathful converts all unblocked damage to Block.
{
  const combat = makeCombat(['downfall_dark_core'], 10)
  const core = combat.enemies[0]
  applyEnemyAction(combat, core, { kind: 'summonUntil', defId: 'downfall_dark_orb', perPlayer: 1 })
  combat.turn = 1
  resolveDueSummons(combat, 'startOfTurn')
  const orb = combat.enemies.find(({ defId }) => defId === 'downfall_dark_orb')
  assert.deepEqual({ block: orb.block, strength: orb.strength }, { block: 1, strength: 1 })
}
{
  const combat = makeCombat(['downfall_wrathful'])
  combat.players[0].block = 1
  applyEnemyAction(combat, combat.enemies[0], { kind: 'attack', amount: 3 })
  assert.equal(combat.enemies[0].block, 2)
}
{
  const started = preparePlayerTurn(makeCombat(['downfall_wrathful_wrath']))
  assert.equal(started.enemies[0].vulnerable, 1)
}

// Buffer is per damage instance; Orb actions revive and Focus reads Orb Master Strength.
{
  const combat = makeCombat(['downfall_orb_master'])
  const boss = combat.enemies[0]
  const hpBefore = boss.hp
  assert.equal(boss.abilityCubes, 1)
  damageEnemy(combat, boss, 5)
  assert.equal(boss.hp, hpBefore)
  assert.equal(boss.abilityCubes, 0)
  damageEnemy(combat, boss, 5)
  assert.equal(boss.hp, hpBefore - 5)
}
{
  const combat = makeCombat(['downfall_frost_orb', 'downfall_orb_master'])
  const boss = combat.enemies.find(({ defId }) => defId === 'downfall_orb_master')
  assert.equal(boss.abilityCubes, 1, 'Frost Orb grants no Buffer before it acts')
  const acted = enemyTurn({ ...combat, phase: 'enemy' })
  assert.equal(acted.enemies.find(({ defId }) => defId === 'downfall_orb_master').abilityCubes, 3,
    'Frost Orb grants 2 Buffer when it acts')
}
{
  const combat = makeCombat(['downfall_orb_master', 'downfall_lightning_orb'])
  const boss = combat.enemies[0]
  const orb = combat.enemies[1]
  boss.strength = 2
  assert.equal(enemyAttackBonus(combat.enemies, orb, { kind: 'attack', amount: 1 }, combat.players[0]), 2,
    'Orb intent preview omits Orb Master Strength')
  const hpBefore = combat.players[0].hp
  applyEnemyAction(combat, orb, { kind: 'attack', amount: 1 })
  assert.equal(combat.players[0].hp, hpBefore - 3)
  orb.dead = true
  orb.hp = 0
  applyEnemyAction(combat, boss, { kind: 'reviveMatching', defIds: [orb.defId] })
  assert.equal(orb.dead, false)
}
{
  const players = [makePlayer(12, 'p1', 0), makePlayer(13, 'p2', 1)]
  const combat = makeCombat(['downfall_orb_master'], 0, players)
  combat.enemies[0].abilityCubes = 0
  applyEnemyAction(combat, combat.enemies[0], { kind: 'addAbilityCube', amount: 1, perPlayer: true })
  assert.equal(combat.enemies[0].abilityCubes, 2, 'Orb Master gains one Buffer per player')
}
{
  const combat = makeCombat(['downfall_darkling_bha', 'downfall_darkling_hab'])
  combat.enemies[0].dead = true
  combat.enemies[0].hp = 0
  const started = startPlayerTurn(combat)
  assert.equal(started.enemies[0].dead, false, 'Downfall Darkling Regrow revives its matching group')
  assert.equal(started.enemies[0].hp, Math.ceil(started.enemies[0].maxHp / 2))
}

// Inferno's Barrier, Fire Breathing, and doubled HP are all executable.
{
  const combat = makeCombat(['downfall_flame_barrier'])
  combat.phase = 'player'
  combat.players[0].hand = [{ uid: 'strike', defId: 'strike_ironclad', upgraded: false }]
  const played = playCard(combat, 'p1', 'strike', { enemyUid: combat.enemies[0].uid, playerId: null })
  assert.equal(played.players[0].discard.filter(({ defId }) => defId === 'burn').length, 1)
}
{
  const combat = makeCombat(['downfall_flame_barrier', 'downfall_inferno'], 10)
  const [barrier, inferno] = combat.enemies
  const infernoHp = inferno.hp
  damageEnemy(combat, inferno, 5)
  assert.equal(inferno.hp, infernoHp)
  barrier.dead = true
  damageEnemy(combat, inferno, 5)
  assert.equal(inferno.hp, infernoHp - 5)
  barrier.dead = false
  barrier.hp = 7
  applyEnemyAction(combat, inferno, { kind: 'doubleNamedHp', defId: barrier.defId })
  assert.equal(barrier.hp, 14)
  const player = combat.players[0]
  player.draw = [{ uid: 'burn', defId: 'burn', upgraded: false },
    { uid: 'strike', defId: 'strike_ironclad', upgraded: false }]
  player.hand = []
  drawInto(combat, player, 1)
  assert.equal(player.hand.length, 2)
  combat.phase = 'player'
  player.hand = [{ uid: 'burn-end', defId: 'burn', upgraded: false }]
  const hpBefore = player.hp
  const ended = beginEndPlayerTurn(combat)
  assert.equal(ended.players[0].hp, hpBefore - 2)
  assert(ended.players[0].exhaust.some(({ uid }) => uid === 'burn-end'))
}

// Terror/Malaise retain tokens, their deaths clean one token, and Illusory rejects Weak.
{
  const combat = makeCombat(['downfall_trickster'])
  combat.players[0].vulnerable = 2
  applyEnemyAction(combat, combat.enemies[0], { kind: 'attack', amount: 1 })
  assert.equal(combat.players[0].vulnerable, 2)
  combat.enemies[0].hp = 1
  damageEnemyLogged(combat, combat.enemies[0], 5, 'test')
  assert.equal(combat.players[0].vulnerable, 1)
}
{
  const combat = makeCombat(['downfall_doppelganger'])
  const player = combat.players[0]
  player.weak = 2
  player.hand = [{ uid: 'strike', defId: 'strike_ironclad', upgraded: false }]
  const played = playCard(combat, player.id, 'strike', { enemyUid: combat.enemies[0].uid, playerId: null })
  assert.equal(played.players[0].weak, 2)
  const foe = played.enemies[0]
  foe.weak = 0
  applyEffect(played, played.players[0], { kind: 'applyWeak', amount: 1 }, 'enemy', 'self',
    { enemyUid: foe.uid, playerId: null }, 'test')
  assert.equal(foe.weak, 0)
  foe.hp = 1
  played.players[0].weak = 2
  damageEnemyLogged(played, foe, 5, 'test')
  assert.equal(played.players[0].weak, 1)
}

// Demon Strength transfer, Wraith revive/Slimed scaling, and Blasphemy forms.
{
  const combat = makeCombat(['downfall_demon'])
  combat.enemies[0].strength = 3
  damageEnemyLogged(combat, combat.enemies[0], 999, 'test')
  assert.equal(combat.pendingSummons[0].strength, 3)
  combat.turn = 1
  resolveDueSummons(combat, 'startOfTurn')
  assert.equal(combat.enemies.find(({ defId }) => defId === 'downfall_corrupted').strength, 3)
}
{
  const players = [makePlayer(4, 'p1', 0), makePlayer(5, 'p2', 1)]
  const combat = makeCombat(['downfall_wraith', 'downfall_shiv', 'downfall_shiv'], 10, players)
  combat.enemies[1].row = 0
  combat.enemies[2].row = 1
  combat.enemies[1].dead = combat.enemies[2].dead = true
  combat.enemies[1].hp = combat.enemies[2].hp = 0
  const started = preparePlayerTurn(combat)
  assert.equal(started.enemies.filter(({ defId, dead }) => defId === 'downfall_shiv' && !dead).length, 2)
  started.phase = 'player'
  started.players[0].hand = [{ uid: 's', defId: 'slimed', upgraded: false }]
  const hpBefore = started.players[0].hp
  const ended = beginEndPlayerTurn(started)
  assert.equal(ended.players[0].hp, hpBefore - 2)
}
{
  const combat = makeCombat(['downfall_blasphemer'])
  combat.enemies[0].weak = 2
  damageEnemyLogged(combat, combat.enemies[0], 999, 'test')
  assert.deepEqual({ defId: combat.enemies[0].defId, hp: combat.enemies[0].hp,
    weak: combat.enemies[0].weak, dead: combat.enemies[0].dead },
  { defId: 'downfall_blasphemer_divinity', hp: 1, weak: 0, dead: false })
  damageEnemy(combat, combat.enemies[0], 99)
  assert.equal(combat.enemies[0].hp, 1)
}

// Neow's Curse/Slayer/Font rules and Watcher self-Vulnerable.
{
  const combat = makeCombat(['downfall_neow', 'downfall_ironclad_slayer'])
  const [neow, slayer] = combat.enemies
  const drawBefore = combat.players[0].draw.length
  applyEnemyAction(combat, neow, { kind: 'shuffleCurse', amount: 3, aoe: true })
  assert.equal(combat.players[0].draw.length, drawBefore + 3)
  slayer.hp = 1
  applyEnemyAction(combat, neow, { kind: 'healMatching', defIds: [slayer.defId], amount: 10 })
  assert.equal(slayer.hp, 10)
  const neowHp = neow.hp
  damageEnemy(combat, neow, 10)
  assert.equal(neow.hp, neowHp)
  slayer.dead = true
  damageEnemy(combat, neow, 10)
  assert.equal(neow.hp, neowHp - 10)
  const playerHp = combat.players[0].hp
  const attack = { kind: 'attack', amount: 5, aoe: true,
    bonusIfNoLivingAlly: { defIds: [slayer.defId], amount: 2 } }
  assert.equal(enemyAttackBonus(combat.enemies, neow, attack, combat.players[0]), 2,
    'Neow intent preview omits the no-Slayer bonus')
  applyEnemyAction(combat, neow, attack)
  assert.equal(combat.players[0].hp, playerHp - 7)
}
{
  const combat = makeCombat(['downfall_watcher_slayer'])
  applyEnemyAction(combat, combat.enemies[0], { kind: 'gainSelfVulnerable', amount: 1 })
  assert.equal(combat.enemies[0].vulnerable, 1)
}

// Plunder remains pending across reconnect, then atomically swaps rows.
{
  const players = [makePlayer(10, 'p1', 0), makePlayer(11, 'p2', 1)]
  const combat = makeCombat(['downfall_loot_chest'], 0, players)
  damageEnemyLogged(combat, combat.enemies[0], 999, 'test')
  assert.equal(combat.players[0].lootChests, 1)
  assert.equal(combat.players[0].discard.filter(({ defId }) => defId === 'burn').length, 2)
  const restored = JSON.parse(JSON.stringify(combat))
  assert.deepEqual(restored.pendingPlunderSwitches, [{ playerId: 'p1', sourceUid: 'enemy-0' }])
  const switched = resolvePlunderRowSwitch(restored, 'p1', 1)
  assert.deepEqual(switched.players.map(({ row }) => row), [1, 0])
  assert.deepEqual(switched.pendingPlunderSwitches, [])
}

// Corruption exhausts Skills and Berserk is an ordered enemy end-turn ability.
{
  const combat = makeCombat(['downfall_corrupted'])
  combat.phase = 'player'
  combat.players[0].hand = [{ uid: 'defend', defId: 'defend_ironclad', upgraded: false }]
  const played = playCard(combat, 'p1', 'defend', { enemyUid: null, playerId: 'p1' })
  assert(played.players[0].exhaust.some(({ uid }) => uid === 'defend'))
  const hpBefore = played.enemies[0].hp
  const ended = beginEndPlayerTurn(played)
  assert.equal(ended.enemies[0].hp, hpBefore - 5)
}

console.log('Downfall enemies: 148/148 physical cards and all focused rules verified')
