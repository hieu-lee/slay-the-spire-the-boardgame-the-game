#!/usr/bin/env node
// Skins: Kratos is a skin of Ironclad, never a character. A skin is presentation only, so these
// checks pin the registry, that a run carries it, that it never touches the rules, and that every
// loader tolerates the Kratos data recorded while he was still a playable character.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHARACTER_IDS } from '../src/game/types.ts'
import { SKINS, SKIN_IDS, VISUAL_IDS, SKIN_TRAITS, hasStagedAttack, isSkinOf, playerVisualId, skinTraits, skinsOf, validSkin, visualId } from '../src/game/skins.ts'
import { createRun } from '../src/game/run.ts'
import { beginCatchUp } from '../src/game/run/setup.ts'
import { createCombat, preparePlayerTurn } from '../src/game/combat.ts'
import { addPresentationEvent } from '../src/game/combat/presentation.ts'
import { createRng } from '../src/game/rng.ts'
import { createCampaignProgress, parseCampaignProgress } from '../src/game/campaign.ts'
import { CARDS } from '../src/game/cards.ts'
import { RELICS } from '../src/game/relics.ts'
import { campfireScenePath } from '../src/game/assets.ts'
import { validateRunLog } from '../src/ui/run-log.ts'
import { addLeaderboardRun } from './lib/leaderboard.mjs'
import { createRoom, createStore, joinRoom, saveStore } from './lib/rooms.mjs'
import { assert, assertDeepEqual, assertEqual, check, report, suite } from './lib/harness.mjs'

suite('skins')
const readText = (path) => readFileSync(path, 'utf8')

check('Kratos is a skin of Ironclad and no character', () => {
  assertDeepEqual(SKINS, { ironclad: ['kratos'] })
  assertDeepEqual(SKIN_IDS, ['kratos'])
  assert(!CHARACTER_IDS.includes('kratos'), 'Kratos is not a playable character')
  assertEqual(Object.values(CARDS).filter((def) => def.owner === 'kratos').length, 0, 'his cards are gone')
  assert(!('ashes_of_sparta' in RELICS), 'his relic is gone')
  assertDeepEqual(VISUAL_IDS, [...CHARACTER_IDS, 'kratos'])
  assertDeepEqual(skinsOf('ironclad'), ['kratos'])
  assertDeepEqual(skinsOf('silent'), [])
})

check('only a skin the character owns is valid, and it picks the art key', () => {
  assert(isSkinOf('ironclad', 'kratos'))
  for (const [character, skin] of [['silent', 'kratos'], ['ironclad', 'ironclad'], ['ironclad', 'Kratos'], ['ironclad', ''],
    ['ironclad', null], ['ironclad', undefined], ['ironclad', 7], ['ironclad', {}], ['ironclad', ['kratos']], ['kratos', 'kratos']]) {
    assert(!isSkinOf(character, skin), `${character}/${String(skin)} is not a skin pair`)
    assertEqual(validSkin(character, skin), undefined)
    assertEqual(visualId(character, skin), character, 'an invalid skin leaves the character\'s own art')
  }
  assertEqual(visualId('ironclad', 'kratos'), 'kratos')
  assertEqual(visualId('ironclad'), 'ironclad')
  assertEqual(playerVisualId({ character: 'ironclad', skin: 'kratos' }), 'kratos')
  assertEqual(playerVisualId({ character: 'silent', skin: 'kratos' }), 'silent')
})

check('a character named like an Object.prototype member has no skins and never throws', () => {
  for (const character of ['toString', 'constructor', 'hasOwnProperty', '__proto__', 'valueOf']) {
    assertDeepEqual(skinsOf(character), [])
    assert(!isSkinOf(character, 'kratos'))
    assertEqual(validSkin(character, 'kratos'), undefined)
    assertEqual(visualId(character, 'kratos'), character)
    assertEqual(playerVisualId({ character, skin: 'kratos' }), character)
  }
})

check('skin traits are read by visual id; characters and prototype names have none', () => {
  assertDeepEqual(Object.keys(SKIN_TRAITS), SKIN_IDS, 'every skin declares its traits')
  assertEqual(skinTraits('kratos')?.energyOrb, true)
  for (const visual of [...CHARACTER_IDS, 'toString', 'constructor', '__proto__']) assertEqual(skinTraits(visual), undefined, visual)
  assert(hasStagedAttack('kratos') && hasStagedAttack('hermit'), 'Kratos and Hermit stage their attacks')
  assert(!hasStagedAttack('ironclad') && !hasStagedAttack('constructor'))
})

check('campfire scenes are keyed by visual id, the skin after every character', () => {
  assert(campfireScenePath([visualId('ironclad', 'kratos')]).endsWith('/noncombat/campfire/kratos_firecamp.webp'))
  assert(campfireScenePath(['kratos', 'silent', 'defect']).endsWith('/noncombat/campfire/silent_defect_kratos_firecamp.webp'))
  assert(campfireScenePath(['ironclad', 'silent']).endsWith('/noncombat/campfire/ironclad_silent_firecamp.webp'))
})

const party = (...members) => members.map(([character, skin], index) => ({ id: `p${index + 1}`, name: character, character, skin }))
const withoutSkins = (value) => JSON.parse(JSON.stringify(value, (key, entry) => key === 'skin' ? undefined : entry))

check('a run carries each hero\'s skin and drops one the hero cannot wear', () => {
  const run = createRun(11, party(['ironclad', 'kratos'], ['silent', 'kratos'], ['defect', 'nonsense'], ['watcher']))
  assertEqual(run.players[0].skin, 'kratos')
  for (const player of run.players.slice(1)) assert(!('skin' in player), `${player.character} has no skin`)
  assertEqual(JSON.parse(JSON.stringify(run)).players[0].skin, 'kratos', 'the skin survives a save')
  assert(!('skin' in createRun(11, party(['ironclad'])).players[0]), 'the default look stores nothing')
})

check('a skin is presentation only: rules, RNG and combat are identical', () => {
  const plain = createRun(12, party(['ironclad'], ['silent']))
  const skinned = createRun(12, party(['ironclad', 'kratos'], ['silent']))
  assertDeepEqual(withoutSkins(skinned), withoutSkins(plain))
  assertEqual(JSON.stringify(skinned.rng), JSON.stringify(plain.rng))
  const fight = (run) => preparePlayerTurn(createCombat(createRng(42), structuredClone(run.players), []))
  const combat = fight(skinned)
  assertEqual(combat.players[0].skin, 'kratos', 'combat creation keeps the skin')
  assertDeepEqual(withoutSkins(combat), withoutSkins(fight(plain)))
})

check('a staged-attack skin records hit-by-hit damage on its attack events; plain Ironclad does not', () => {
  const attack = (skin) => {
    const run = createRun(16, party(['ironclad', skin]))
    const combat = createCombat(createRng(42), structuredClone(run.players), [])
    addPresentationEvent(combat, { kind: 'card', sourceId: 'strike_ironclad', actorId: 'p1', enemyIds: ['e1'], playerIds: [],
      upgraded: false, copied: false, energy: 1 })
    return combat.presentationEvents.at(-1)
  }
  assertDeepEqual(attack('kratos').enemyHpLoss, {})
  assert(!('enemyHpLoss' in attack(undefined)), 'Ironclad\'s attack events stay unstaged')
})

check('Catch Up seats keep the skin they join with', () => {
  const base = createRun(13, party(['silent']))
  const act2 = { ...base, phase: 'map', neow: null, act: 2, map: { ...base.map, act: 2, position: null } }
  const joined = beginCatchUp(act2, party(['ironclad', 'kratos']).map((member) => ({ ...member, id: 'p2' })))
  assert(joined !== act2, 'the newcomer joined')
  assertEqual(joined.players.find((player) => player.id === 'p2').skin, 'kratos')
  const invalid = beginCatchUp(act2, [{ id: 'p2', name: 'Bo', character: 'defect', skin: 'kratos' }])
  assert(!('skin' in invalid.players.find((player) => player.id === 'p2')))
})

const makeLog = (initial) => {
  const final = structuredClone(initial)
  final.phase = 'defeat'; final.neow = null; final.combat = null
  return { version: 2, runId: initial.campaign.runId, initial, events: [{ patch: [{ path: [], value: final }] }] }
}

check('run logs keep a valid skin, drop an invalid one and never reject an old log', () => {
  const skinned = validateRunLog(makeLog(createRun(14, party(['ironclad', 'kratos']))))
  assertEqual(skinned?.initial.players[0].skin, 'kratos')
  const old = validateRunLog(makeLog(createRun(14, party(['ironclad']))))
  assert(old && !('skin' in old.initial.players[0]), 'a log from before skins replays')
  const forged = makeLog(createRun(14, party(['silent'])))
  forged.initial.players[0].skin = 'kratos'
  const dropped = validateRunLog(forged)
  assert(dropped, 'a wrong skin does not reject the log')
  assert(!('skin' in dropped.initial.players[0]), 'the wrong skin is dropped to the default look')
  const garbage = makeLog(createRun(14, party(['ironclad'])))
  garbage.initial.players[0].skin = { kratos: true }
  assert(!('skin' in validateRunLog(garbage).initial.players[0]))
})

check('a run log of a Kratos character is refused cleanly', () => {
  const legacy = makeLog(createRun(15, party(['ironclad'])))
  legacy.initial.players[0].character = 'kratos'
  assertEqual(validateRunLog(legacy), null)
})

check('a campaign saved with Kratos\'s unlock row loads without it', () => {
  const saved = JSON.parse(JSON.stringify(createCampaignProgress()))
  saved.characters.kratos = 8
  const loaded = parseCampaignProgress(saved)
  assert(!('kratos' in loaded.characters))
  assertDeepEqual(loaded, createCampaignProgress())
})

check('stored rooms: seat skins load, bad ones drop, and a room seating Kratos is discarded', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sts-skins-'))
  try {
    const file = join(directory, 'rooms.json')
    const store = createStore({ file })
    const room = createRoom(store, { code: 'SKINNY' })
    const ann = joinRoom(room, { name: 'Ann', character: 'ironclad', skin: 'kratos' })
    joinRoom(room, { name: 'Bo', character: 'silent' })
    const legacy = createRoom(store, { code: 'OLDKRA' })
    joinRoom(legacy, { name: 'Old', character: 'ironclad' })
    saveStore(store)
    const saved = JSON.parse(readText(file))
    saved.rooms.find((entry) => entry.code === 'OLDKRA').seats[0].character = 'kratos'
    saved.rooms.find((entry) => entry.code === 'SKINNY').seats[1].skin = 'kratos'
    writeFileSync(file, JSON.stringify(saved))
    const restored = createStore({ file })
    assertEqual(restored.rooms.has('OLDKRA'), false, 'a room seating the removed hero is discarded')
    const [first, second] = restored.rooms.get('SKINNY').seats
    assertEqual(first.token, ann.token)
    assertEqual(first.skin, 'kratos', 'a valid skin is recovered with the room')
    assert(!('skin' in second), 'a skin the hero cannot wear is dropped on recovery')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

check('leaderboard, stats log and stats state recorded for Kratos load without him', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sts-skins-legacy-'))
  try {
    const file = join(directory, 'rooms.json')
    const row = (id, character, characters = [character]) => ({ id, character, characters, ascension: 1, mode: 'standard',
      damageStatsComplete: true, startedAtAct: 1, highestBossActDefeated: 3, combatsFinished: 3, damageDealt: 3,
      damageTaken: 3, damageBlocked: 3, floorsCleared: 3, recordedAt: 1, finalDeck: [{ defId: 'strike_ironclad', upgraded: false }] })
    const store = createStore({ file })
    addLeaderboardRun(store, row('browser-1234:keep', 'ironclad'))
    saveStore(store)
    const archivePath = `${file}.leaderboard.json`
    writeFileSync(archivePath, JSON.stringify([...JSON.parse(readText(archivePath)), row('browser-1234:kratos', 'kratos'),
      row('browser-1234:mixed', 'ironclad', ['ironclad', 'kratos'])]))
    writeFileSync(`${file}.leaderboard.log`, `${JSON.stringify(row('browser-1234:logged', 'kratos'))}\n`)
    writeFileSync(`${file}.stats.log`, `${JSON.stringify({ id: 'browser-1234:kratos', hero: 'kratos', hash: 'a'.repeat(64), deckType: 'Kratos Rage Unleash' })}\n`)
    writeFileSync(`${file}.stats.json`, JSON.stringify({ deckTypes: ['Ironclad Strength Scaling', 'Kratos Rage Unleash'],
      deckClassificationBudget: { day: 1, used: 0 } }))
    const restored = createStore({ file })
    assertDeepEqual(restored.leaderboardRuns.map((run) => run.id), ['browser-1234:keep'])
    assert(!restored.deckTypes.some((type) => type.startsWith('Kratos')), 'his deck types are forgotten')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

report('skins')
