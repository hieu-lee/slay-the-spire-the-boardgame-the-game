import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHARACTER_IDS } from '../src/game/types.ts'
import { rulesetForCharacters } from '../src/game/meta.ts'
import { beginCatchUp, createCampaignProgress, createCombat, createRng, createRun } from '../src/game/state.ts'
import {
  apply,
  CHARACTERS,
  chooseCharacter,
  createRoom,
  createStore,
  joinRoom,
  saveStore,
  snapshotFor,
  startRun,
} from './lib/rooms.mjs'
import { suite, check, assertDeepEqual, assertEqual, assertThrows, report } from './lib/harness.mjs'

suite('Downfall roster integration')

check('browser and room vocabularies expose the same eight characters', () => {
  assertDeepEqual(CHARACTERS, [...CHARACTER_IDS])
})

check('every Downfall character is accepted by lobby validation', () => {
  const room = createRoom(createStore(), { code: 'ROSTER' })
  const seat = joinRoom(room, { name: 'Ann', character: 'ironclad' })
  for (const character of CHARACTER_IDS) {
    chooseCharacter(room, seat.token, character)
    assertEqual(snapshotFor(room, seat.token).you.character, character)
  }
  assertThrows(() => chooseCharacter(room, seat.token, 'not-a-character'))
})

check('mixed parties are legal and authoritatively select Downfall rules', () => {
  const room = createRoom(createStore(), { code: 'MIXEDA' })
  const base = joinRoom(room, { name: 'Ann', character: 'ironclad' })
  const downfall = joinRoom(room, { name: 'Bo', character: 'hexaghost' })
  startRun(room, base.token, { seed: 47 })
  assertEqual(room.run.meta.ruleset, 'downfall')
  const restored = joinRoom(room, { token: downfall.token, connected: true })
  assertEqual(snapshotFor(room, restored.token).run.meta.ruleset, 'downfall')
  assertDeepEqual(room.run.players.map((player) => player.character), ['ironclad', 'hexaghost'])
})

check('base parties retain the base ruleset while explicit Downfall remains compatible', () => {
  assertEqual(rulesetForCharacters(['ironclad', 'silent']), 'base')
  assertEqual(rulesetForCharacters(['ironclad'], 'downfall'), 'downfall')
  assertEqual(rulesetForCharacters(['ironclad', 'hermit']), 'downfall')
})

check('Catch Up cannot mix a Downfall character into an existing base-ruleset run', () => {
  const run = createRun(47, [{ id: 'p1', name: 'Ann', character: 'ironclad' }], 0,
    createCampaignProgress())
  const ready = { ...run, act: 2, phase: 'map', map: { ...run.map, position: null } }
  assertEqual(beginCatchUp(ready, [{ id: 'p2', name: 'Guardian', character: 'guardian' }]), ready)
})

check('Downfall Catch Up deals Heart boons across sequential mixed additions', () => {
  let run = createRun(470, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }], 0,
    createCampaignProgress(), false, false, { ruleset: 'downfall' })
  run = { ...run, act: 2, phase: 'map', neow: null, map: { ...run.map, act: 2, position: null } }
  run = beginCatchUp(run, [{ id: 'p2', name: 'Silent', character: 'silent' }])
  run = beginCatchUp(run, [{ id: 'p3', name: 'Guardian', character: 'guardian' }])
  assertEqual(run.players.length, 3)
  assertEqual(run.neow.players.p2.cardId.startsWith('heart_boon_'), true)
  assertEqual(run.neow.players.p3.cardId.startsWith('heart_boon_'), true)
})

check('server restart migrates legacy runs without ruleset metadata', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sts-downfall-roster-'))
  try {
    const file = join(directory, 'rooms.json')
    const store = createStore({ file })
    const room = createRoom(store, { code: 'LEGACY' })
    const seat = joinRoom(room, { character: 'guardian' })
    startRun(room, seat.token, { seed: 147 })
    delete room.run.meta.ruleset
    saveStore(store)

    const restored = createStore({ file }).rooms.get('LEGACY')
    assertEqual(restored.run.meta.ruleset, 'downfall')
    assertEqual(snapshotFor(restored, seat.token).run.meta.ruleset, 'downfall')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

check('server restart preserves an explicit stored ruleset', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sts-downfall-ruleset-'))
  try {
    const file = join(directory, 'rooms.json')
    const store = createStore({ file })
    const room = createRoom(store, { code: 'STORED' })
    const seat = joinRoom(room, { character: 'guardian' })
    startRun(room, seat.token, { seed: 148 })
    room.run.meta.ruleset = 'base'
    saveStore(store)

    const restored = createStore({ file }).rooms.get('STORED')
    assertEqual(restored.run.meta.ruleset, 'base')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

check('room snapshots and actions preserve public Downfall combat state', () => {
  const room = createRoom(createStore(), { code: 'PUBLIC' })
  const hex = joinRoom(room, { name: 'Hex', character: 'hexaghost' })
  const slime = joinRoom(room, { name: 'Slime', character: 'slime_boss' })
  startRun(room, hex.token, { seed: 149 })
  const combat = createCombat(createRng(149), room.run.players, [{
    uid: 'e1', defId: 'cultist', row: 0, isBoss: false, hp: 30, maxHp: 30,
    block: 0, strength: 0, vulnerable: 0, weak: 0, poison: 0, goldReward: 0,
    cardReward: null, actionIndex: 0, abilityUsed: false, dead: false,
  }])
  const owner = combat.players.find((player) => player.id === hex.playerId)
  owner.heat = 4
  owner.soulburn = 2
  owner.soulburnUsedThisTurn = true
  owner.nextSoulburnDamageBonus = 1
  owner.exhaustNextCardAfterUid = 'spent-source'
  owner.chamber = [{ uid: 'secret', defId: 'strike_hexaghost', upgraded: false }]
  const slimeOwner = combat.players.find((player) => player.id === slime.playerId)
  slimeOwner.slimes = [{
    card: { uid: 'slime-1', defId: 'tackle', upgraded: false }, level: 2, vigor: 1,
    commandsThisTurn: 0, vigorLossAtEndOfTurn: 0,
  }]
  room.run = { ...room.run, phase: 'combat', combat }

  const peer = snapshotFor(room, slime.token).run.combat.players.find((player) => player.id === hex.playerId)
  assertEqual(peer.heat, 4)
  assertEqual(peer.soulburn, 2)
  assertEqual(peer.soulburnUsedThisTurn, true)
  assertEqual(peer.nextSoulburnDamageBonus, 1)
  assertEqual(peer.exhaustNextCardAfterUid, 'spent-source')
  assertEqual(peer.chamber, null)
  assertEqual(snapshotFor(room, hex.token).run.combat.players.find((player) => player.id === slime.playerId).slimes.length, 1)

  apply(room, hex.token, { kind: 'spendSoulburn', enemyUid: 'e1' })
  assertEqual(room.run.combat.enemies[0].hp, 25)
  assertEqual(room.run.combat.players.find((player) => player.id === hex.playerId).soulburn, 1)
})

check('room action rerolls an eligible public Downfall self-boss once', () => {
  const room = createRoom(createStore(), { code: 'REROLL' })
  const host = joinRoom(room, { character: 'ironclad' })
  joinRoom(room, { character: 'guardian' })
  startRun(room, host.token, { seed: 150 })
  room.run = {
    ...room.run,
    act: 2,
    phase: 'map',
    actBossDefId: 'downfall_inferno',
    map: { ...room.run.map, position: null },
    selfBossRerolled: false,
  }
  assertEqual(snapshotFor(room, host.token).run.canRerollDownfallSelfBoss, true)
  apply(room, host.token, { kind: 'rerollDownfallSelfBoss' })
  assertEqual(room.run.selfBossRerolled, true)
  assertEqual(room.run.actBossDefId === 'downfall_inferno', false)
  assertEqual(snapshotFor(room, host.token).run.canRerollDownfallSelfBoss, false)
})

report('Downfall roster integration')
