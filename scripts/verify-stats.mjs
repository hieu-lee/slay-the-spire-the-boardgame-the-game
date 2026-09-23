#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CARDS, faceOf } from '../src/game/cards.ts'
import { addLeaderboardRun, normalizeLeaderboardRun } from './lib/leaderboard.mjs'
import { createRoom, createStore, joinRoom, saveStore, startRun } from './lib/rooms.mjs'
import { classifyDeckType } from './lib/codex-deck-classifier.mjs'
import { deckHash, INITIAL_DECK_CLASSIFICATIONS, INITIAL_DECK_TYPES, randomDeck, statsSnapshot, validDeckType } from './lib/stats.mjs'
import { createRoomServer } from './room-server.mjs'
import { materializeLeaderboardArchive } from '../infra/validate-room-store.mjs'
import { joinQueries, parseStatsExpression, validateStatsQuery } from '../src/stats-query.ts'
import { assert, assertDeepEqual, assertEqual, assertThrows, check, report, suite } from './lib/harness.mjs'

suite('stats explorer')
const run = (id, overrides = {}) => ({
  id: `browser-1234:campaign-${id}`, character: 'defect', ascension: 3, mode: 'standard',
  damageStatsComplete: true, startedAtAct: 1, highestBossActDefeated: 0,
  combatsFinished: 10, damageDealt: 100, damageTaken: 30, damageBlocked: 70,
  floorsCleared: 20, finalDeck: [{ defId: 'dual_cast', upgraded: false }], ...overrides,
})
const card = (id, upgraded = false) => ({ op: 'card', id, upgraded })
const query = (value) => new URLSearchParams({ q: JSON.stringify(value) })
const archive = [
  { ...normalizeLeaderboardRun(run(1, { finalDeck: [
    { defId: 'dual_cast', upgraded: false }, { defId: 'strike_defect', upgraded: false },
  ] })), deckType: 'Defect Lightning Orb Focus' },
  { ...normalizeLeaderboardRun(run(2, { finalDeck: [{ defId: 'dual_cast', upgraded: true }],
    floorsCleared: 30, damageDealt: 300, damageTaken: 20, damageBlocked: 80 })), deckType: 'Defect Lightning Orb Focus' },
  { ...normalizeLeaderboardRun(run(3, { finalDeck: [{ defId: 'claw', upgraded: false }],
    floorsCleared: 10, damageTaken: 100, damageBlocked: 0 })), deckType: 'Defect Claw Spam' },
]

check('initial taxonomy is evidence-led, valid and not one label per run', () => {
  assertEqual(INITIAL_DECK_TYPES.length, 10)
  assert(INITIAL_DECK_TYPES.every(validDeckType))
  assertEqual(new Set(INITIAL_DECK_TYPES).size, INITIAL_DECK_TYPES.length)
  assert(!INITIAL_DECK_TYPES.some((name) => name.startsWith('Guardian ')))
  assert(INITIAL_DECK_TYPES.includes('Hermit Curse-Chamber Payoffs'))
})
check('all submitted solo runs determine weighted averages, not averages of averages', () => {
  const result = statsSnapshot(archive)
  assertEqual(result.runs, 3)
  assertEqual(result.averageFloors, 20)
  assertEqual(result.averageDamage, 500 / 30)
  assertEqual(result.averageBlock, 150 / 300)
  assertEqual(result.rows.find((row) => row.deckType === 'Defect Lightning Orb Focus').runs, 2)
  assertEqual(result.nextCards.find((entry) => entry.defId === 'dual_cast').deltaFloors, 15)
})
check('OR upgrades AND NOT starter cards filters exactly the intended deck', () => {
  const expression = { op: 'and', left: { op: 'or', left: card('dual_cast'), right: card('dual_cast', true) },
    right: { op: 'not', value: { op: 'or', left: card('strike_defect'), right: card('strike_defect', true) } } }
  const result = statsSnapshot(archive, query(expression))
  assertEqual(result.runs, 1)
  assertEqual(result.rows[0].deckType, 'Defect Lightning Orb Focus')
  assertEqual(result.averageFloors, 30)
  assertDeepEqual(randomDeck(archive, new URLSearchParams({ ...Object.fromEntries(query(expression)), type: 'Defect Lightning Orb Focus' })).cards,
    [{ defId: 'dual_cast', upgraded: true }])
})
check('Ascension i+ includes only runs at or above the threshold and composes with cards', () => {
  const high = { ...normalizeLeaderboardRun(run(9, { ascension: 10, floorsCleared: 40,
    finalDeck: [{ defId: 'dual_cast', upgraded: true }] })), deckType: 'Defect Lightning Orb Focus' }
  const runs = [...archive, high]
  assertEqual(statsSnapshot(runs, new URLSearchParams({ ascension: '0+' })).runs, 4)
  assertEqual(statsSnapshot(runs, new URLSearchParams({ ascension: '3' })).runs, 3)
  assertEqual(statsSnapshot(runs, new URLSearchParams({ ascension: '3+' })).runs, 4)
  assertEqual(statsSnapshot(runs, new URLSearchParams({ ascension: '10+' })).averageFloors, 40)
  assertEqual(statsSnapshot(runs, new URLSearchParams({ ascension: '10+', q: JSON.stringify(card('claw')) })).runs, 0)
  assertDeepEqual(randomDeck(runs, new URLSearchParams({ ascension: '10+', type: 'Defect Lightning Orb Focus' })).cards,
    [{ defId: 'dual_cast', upgraded: true }])
  assertThrows(() => statsSnapshot(runs, new URLSearchParams({ ascension: '11+' })))
})
check('human card-name expressions handle precedence, aliases and invalid terms', () => {
  const choices = [
    { id: 'dual_cast', label: 'Dual Cast', upgraded: false },
    { id: 'dual_cast', label: 'Dual Cast+', upgraded: true },
    { id: 'strike_defect', label: 'Strike', upgraded: false },
    { id: 'strike_ironclad', label: 'Strike', upgraded: false },
    { id: 'strike_defect', label: 'Strike+', upgraded: true },
    { id: 'corpse_explosion', label: 'Corpse Explosion', upgraded: false },
    { id: 'burn', label: 'Burn', upgraded: false },
  ]
  const parsed = parseStatsExpression('(Dual Cast or "Dual Cast+") and not (Strike or Strike+)', choices)
  assertEqual(statsSnapshot(archive, query(parsed)).averageFloors, 30)
  assertThrows(() => parseStatsExpression('Dual Cast and (', choices))
  assertThrows(() => parseStatsExpression('Invisible Card', choices))
  assertThrows(() => parseStatsExpression('Dual Cast or or Strike', choices))
  assertEqual(parseStatsExpression('Explosive Corps', choices).id, 'corpse_explosion')
  assertDeepEqual(parseStatsExpression('@strike_defect', choices), { op: 'card', id: 'strike_defect', upgraded: null })
  assertDeepEqual(parseStatsExpression('@burn', choices), { op: 'card', id: 'burn', upgraded: null })
  assertThrows(() => parseStatsExpression('@unknown_card', choices))
})
check('balanced visual queries support many cards but reject oversized or deeply nested expressions', () => {
  const many = joinQueries('and', Array.from({ length: 14 }, () => card('claw')))
  validateStatsQuery(many)
  assertEqual(statsSnapshot(archive, query(many)).runs, 1)
  assertThrows(() => validateStatsQuery(joinQueries('and', Array.from({ length: 25 }, () => card('claw')))))
  const deep = Array.from({ length: 14 }).reduce((value) => ({ op: 'not', value }), card('claw'))
  assertThrows(() => validateStatsQuery(deep))
})
check('missing floors and legacy damage do not distort available metrics', () => {
  const legacy = normalizeLeaderboardRun(run(4, { floorsCleared: null, damageStatsComplete: false, damageDealt: 999999 }))
  const result = statsSnapshot([...archive, legacy])
  assertEqual(result.runs, 4)
  assertEqual(result.pending, 1)
  assertEqual(result.averageFloors, 20)
  assertEqual(result.averageDamage, 500 / 30)
})
check('unrecognized card IDs cannot become next-card recommendations', () => {
  const unknown = { ...normalizeLeaderboardRun(run(11, { finalDeck: [{ defId: '__proto__', upgraded: false }] })), deckType: 'Defect Claw Spam' }
  const invalidGem = { ...normalizeLeaderboardRun(run(17, { finalDeck: [{ defId: 'dual_cast', upgraded: false, attachedGemId: 'unknown_gem' }] })), deckType: 'Defect Claw Spam' }
  const wrongGem = { ...normalizeLeaderboardRun(run(26, { character: 'guardian', finalDeck: [{ defId: 'guardian_prismatic_barrier', upgraded: false, attachedGemId: 'dual_cast' }] })), deckType: 'Guardian Socket Gems' }
  const wrongSocket = { ...normalizeLeaderboardRun(run(27, { finalDeck: [{ defId: 'dual_cast', upgraded: false, attachedGemId: 'guardian_ruby' }] })), deckType: 'Defect Claw Spam' }
  const impossibleUpgrade = { ...normalizeLeaderboardRun(run(45, { finalDeck: [{ defId: 'burn', upgraded: true }] })), deckType: 'Defect Claw Spam' }
  const result = statsSnapshot([...archive, unknown, invalidGem, wrongGem, wrongSocket, impossibleUpgrade])
  assertEqual(result.runs, archive.length)
  assert(!result.nextCards.some((entry) => entry.defId === '__proto__'))
  assertThrows(() => randomDeck([unknown, invalidGem, wrongSocket, impossibleUpgrade], new URLSearchParams({ type: 'Defect Claw Spam' })))
  assertThrows(() => randomDeck([wrongGem], new URLSearchParams({ type: 'Guardian Socket Gems' })))
})
check('status cards in finished decks can be filtered and compared', () => {
  const burns = [40, 41].map((id) => ({ ...normalizeLeaderboardRun(run(id, {
    finalDeck: [{ defId: 'burn', upgraded: false }],
  })), deckType: 'Defect Mixed Orb' }))
  const entries = [...burns, archive[0]]
  assertEqual(statsSnapshot(entries).nextCards.find((entry) => entry.defId === 'burn').runs, 2)
  assertEqual(statsSnapshot(entries, query({ op: 'card', id: 'burn', upgraded: null })).runs, 2)
})
check('cross-hero cards can be matched in a Defect deck', () => {
  const prismatic = normalizeLeaderboardRun(run(44, { finalDeck: [{ defId: 'barricade', upgraded: false }] }))
  assertEqual(statsSnapshot([prismatic], new URLSearchParams({ character: 'defect', q: JSON.stringify(card('barricade')) })).runs, 1)
})
check('empty deck submissions do not create permanently pending archetypes', () => {
  const empty = normalizeLeaderboardRun(run(12, { finalDeck: [] }))
  assertEqual(statsSnapshot([...archive, empty]).runs, archive.length)
})
check('a finished one-player room uses its personal deck without exposing its owner', () => {
  const room = { ...normalizeLeaderboardRun(run(8, { finalDeck: undefined, winningDecks: [{
    username: 'Solo Room Player', character: 'defect', finalDeck: [{ defId: 'dual_cast', upgraded: true }],
  }] })), deckType: 'Defect Lightning Orb Focus' }
  const result = statsSnapshot([room], query(card('dual_cast', true)))
  assertEqual(result.runs, 1)
  assertDeepEqual(randomDeck([room], new URLSearchParams({ type: 'Defect Lightning Orb Focus' })).cards,
    [{ defId: 'dual_cast', upgraded: true }])
  assert(!JSON.stringify(result).includes('Solo Room Player'))
})
check('authoritative solo-room deck changes invalidate a previous public archetype', () => {
  const entries = { leaderboardRuns: [] }
  addLeaderboardRun(entries, run(38, { finalDeck: [{ defId: 'claw', upgraded: false }],
    damageDealt: 1_000_000_000, floorsCleared: 50, ascension: 10 }))
  entries.leaderboardRuns[0].deckType = 'Defect Claw Spam'
  const finalized = run(38, { finalDeck: undefined, winningDecks: [
    { username: 'Room Owner', character: 'defect', finalDeck: [{ defId: 'dual_cast', upgraded: false }] },
  ], damageDealt: 20, floorsCleared: 26, ascension: 3 })
  assertEqual(addLeaderboardRun(entries, finalized), true)
  assertEqual(entries.leaderboardRuns[0].deckType, undefined)
  assertEqual(statsSnapshot(entries.leaderboardRuns).pending, 1)
  assertEqual(statsSnapshot(entries.leaderboardRuns, query(card('claw'))).runs, 0)
  assertEqual(statsSnapshot(entries.leaderboardRuns, query(card('dual_cast'))).runs, 1)
  assertEqual(statsSnapshot(entries.leaderboardRuns).averageDamage, 2)
  assertEqual(statsSnapshot(entries.leaderboardRuns).averageFloors, 26)
  assertEqual(statsSnapshot(entries.leaderboardRuns, new URLSearchParams({ ascension: '10+' })).runs, 0)
  assertEqual(addLeaderboardRun(entries, run(38, { damageDealt: 1_000_000_000 })), false)
  assertEqual(addLeaderboardRun(entries, finalized), false)
  assertThrows(() => randomDeck(entries.leaderboardRuns, new URLSearchParams({ type: 'Defect Claw Spam' })))
})
check('a room replay retains classification only for the same hero and deck', () => {
  const entries = { leaderboardRuns: [] }
  const sameCard = [{ defId: 'barricade', upgraded: false }]
  addLeaderboardRun(entries, run(51, { finalDeck: sameCard }))
  entries.leaderboardRuns[0].deckType = 'Defect Mixed Orb'
  entries.leaderboardRuns[0].deckClassificationRetry = { after: 2_000_000_000_000, hash: 'a'.repeat(64) }
  const finalized = run(51, { finalDeck: undefined, winningDecks: [
    { username: 'Room Owner', character: 'defect', finalDeck: sameCard },
  ] })
  assertEqual(addLeaderboardRun(entries, finalized), true)
  assertEqual(entries.leaderboardRuns[0].deckType, 'Defect Mixed Orb')
  assertDeepEqual(entries.leaderboardRuns[0].deckClassificationRetry, { after: 2_000_000_000_000, hash: 'a'.repeat(64) })
  assertEqual(addLeaderboardRun(entries, finalized), false)
  addLeaderboardRun(entries, run(51, { finalDeck: undefined, character: 'ironclad', winningDecks: [
    { username: 'Room Owner', character: 'ironclad', finalDeck: sameCard },
  ] }))
  assertEqual(entries.leaderboardRuns[0].deckType, undefined)
  assertEqual(entries.leaderboardRuns[0].deckClassificationRetry, undefined)
})
check('Guardian Gem filters include attachments in matching, exclusion, and next-card comparisons', () => {
  const socketed = { ...normalizeLeaderboardRun(run(32, { character: 'guardian', finalDeck: [
    { defId: 'guardian_prismatic_barrier', upgraded: false, attachedGemId: 'guardian_ruby' },
  ] })), deckType: 'Guardian Socket Gems' }
  const another = { ...normalizeLeaderboardRun(run(33, { character: 'guardian', finalDeck: [
    { defId: 'guardian_disrupt', upgraded: false, attachedGemId: 'guardian_ruby' },
  ] })), deckType: 'Guardian Socket Gems' }
  const plain = { ...normalizeLeaderboardRun(run(34, { character: 'guardian', finalDeck: [
    { defId: 'guardian_prismatic_barrier', upgraded: false },
  ] })), deckType: 'Guardian Socket Gems' }
  assertEqual(statsSnapshot([socketed, another, plain], query(card('guardian_ruby'))).runs, 2)
  assertEqual(statsSnapshot([socketed, another, plain], query({ op: 'not', value: card('guardian_ruby') })).runs, 1)
  assertEqual(statsSnapshot([socketed, another, plain]).nextCards.find((entry) => entry.defId === 'guardian_ruby').runs, 2)
  assertEqual(randomDeck([socketed], new URLSearchParams({ type: 'Guardian Socket Gems' })).cards[0].attachedGemId, 'guardian_ruby')
})
check('complex card expressions scan each submitted deck once rather than once per term', () => {
  const long = { ...normalizeLeaderboardRun(run(35, { finalDeck: Array.from({ length: 1000 }, () => ({ defId: 'strike_defect', upgraded: false })) })), deckType: 'Defect Claw Spam' }
  let reads = 0
  for (const entry of long.finalDeck) Object.defineProperty(entry, 'defId', { get: () => { reads += 1; return 'strike_defect' } })
  const manyTerms = joinQueries('or', Array.from({ length: 20 }, () => card('dual_cast')))
  assertEqual(statsSnapshot([long], query(manyTerms)).runs, 0)
  assert(reads <= 2500, `expected one deck scan, got ${reads} card ID reads`)
})
check('normalizing decks indexes card membership once for repeated archive queries', () => {
  const entries = Array.from({ length: 30 }, (_, index) => normalizeLeaderboardRun(run(index + 100, {
    finalDeck: Array.from({ length: 1000 }, () => ({ defId: 'strike_defect', upgraded: false })),
  })))
  let reads = 0
  for (const entry of entries) Object.defineProperty(entry.finalDeck[0], 'defId', { get: () => { reads += 1; return 'strike_defect' } })
  assertEqual(statsSnapshot(entries, query(card('strike_defect'))).runs, 30)
  assertEqual(statsSnapshot(entries, query(card('dual_cast'))).runs, 0)
  assertEqual(reads, 0)
})
check('malformed or oversized expressions and queries are rejected without evaluating', () => {
  for (const candidate of [query({ op: 'card', id: 'dual_cast', upgraded: 1 }),
    query({ op: 'card', id: '__proto__', upgraded: false, extra: true }),
    query({ op: 'not', value: { op: 'not', value: null } }),
    new URLSearchParams({ q: 'x'.repeat(2049) }), new URLSearchParams({ character: 'toString' })])
    assertThrows(() => statsSnapshot(archive, candidate))
  assertThrows(() => randomDeck(archive, new URLSearchParams({ type: 'Defect Missing' })))
})

const directory = mkdtempSync(join(tmpdir(), 'stats-test-'))
let server
try {
  const file = join(directory, 'rooms.json')
  const seededFile = join(directory, 'seeded-archetypes.json')
  const seed = createStore({ file: seededFile })
  const exampleCards = ['strike_watcher', 'defend_watcher', 'eruption', 'vigilance', 'empty_body', 'protect',
    'rushdown', 'tantrum', 'pray', 'mental_fortress', 'talk_to_the_hand', 'tranquility']
    .map((defId) => ({ defId, upgraded: ['eruption', 'rushdown', 'tantrum', 'pray', 'mental_fortress'].includes(defId) }))
  const hermitCards = ['hermit_covet', 'hermit_strike+', 'hermit_strike+', 'hermit_strike', 'hermit_snapshot',
    'hermit_defend', 'hermit_defend', 'hermit_defend', 'hermit_defend', 'hermit_desperado', 'hermit_dive+',
    'hermit_misfire', 'hermit_virtue', 'hermit_enervate', 'hermit_fan_the_hammer', 'hermit_maintenance+',
    'master_of_strategy', 'hermit_low_profile', 'regret', 'hermit_purgatory', 'hermit_overwhelming_power',
    'hermit_dead_or_alive', 'hermit_feint', 'flash_of_steel', 'hermit_specter']
    .map((id) => ({ defId: id.replace(/\+$/, ''), upgraded: id.endsWith('+') }))
  addLeaderboardRun(seed, run(800, { character: 'watcher', finalDeck: exampleCards }))
  addLeaderboardRun(seed, run(801, { character: 'defect', finalDeck: exampleCards }))
  addLeaderboardRun(seed, run(802, { character: 'watcher', finalDeck: exampleCards.slice(0, -1) }))
  addLeaderboardRun(seed, run(803, { character: 'hermit', finalDeck: hermitCards }))
  seed.leaderboardRuns[0].deckClassificationRetry = { after: Date.now() + 86_400_000, hash: deckHash(seed.leaderboardRuns[0]) }
  saveStore(seed)
  check('evidence-led initial archetypes classify only the exact hero and deck, clearing stale retries', () => {
    assertEqual(deckHash(seed.leaderboardRuns[0]), '48ef6393e30de702b8b86f9976716889f84f24b1ac3f572bde18db09fc20b84a')
    assertEqual(deckHash(seed.leaderboardRuns[3]), 'ebacbfb88b205e055b01c62aa569ee873470af0c0150cc9203973ea3ae90b775')
    assertEqual(INITIAL_DECK_CLASSIFICATIONS.size, 38)
    assertDeepEqual(new Set(INITIAL_DECK_CLASSIFICATIONS.values()), new Set(INITIAL_DECK_TYPES))
    const seeded = createStore({ file: seededFile })
    assertEqual(seeded.leaderboardRuns[0].deckType, 'Watcher Stance Dance')
    assertEqual(seeded.leaderboardRuns[0].deckClassificationRetry, undefined)
    assertEqual(seeded.leaderboardRuns[1].deckType, undefined)
    assertEqual(seeded.leaderboardRuns[2].deckType, undefined)
    assertEqual(seeded.leaderboardRuns[3].deckType, 'Hermit Curse-Chamber Payoffs')
    assertEqual(seeded.statsChanges.size, 2)
    assertEqual(statsSnapshot(seeded.leaderboardRuns).rows.find((row) => row.deckType === 'Watcher Stance Dance').runs, 1)
    assertEqual(statsSnapshot(seeded.leaderboardRuns).rows.find((row) => row.deckType === 'Hermit Curse-Chamber Payoffs').runs, 1)
    saveStore(seeded)
    const restored = createStore({ file: seededFile })
    assertEqual(restored.statsChanges.size, 0)
    assertEqual(restored.leaderboardRuns[3].deckType, 'Hermit Curse-Chamber Payoffs')
  })
  const outdatedFile = join(directory, 'legacy-catalog.json')
  const outdated = createStore({ file: outdatedFile })
  outdated.deckTypes = ['Ironclad Block Fortress', 'Defect Lightning Orb Focus', 'Defect Newly Discovered Combo']
  addLeaderboardRun(outdated, run(62))
  addLeaderboardRun(outdated, run(66))
  outdated.leaderboardRuns[1].deckType = 'Defect Lightning Orb Focus'
  saveStore(outdated)
  appendFileSync(`${outdatedFile}.stats.log`, `${JSON.stringify({ id: run(62).id, hero: 'defect', hash: deckHash(outdated.leaderboardRuns[0]),
    retry: { after: Date.now() + 60_000, hash: deckHash(outdated.leaderboardRuns[0]) } })}\n`)
  appendFileSync(`${outdatedFile}.stats.log`, `${JSON.stringify({ id: run(9000).id, hero: 'defect',
    hash: 'f'.repeat(64), deckType: 'Defect Frost Orb Focus' })}\n`)
  check('unused speculative seeds are replaced by archetypes derived from submitted decks', () => {
    const migrated = createStore({ file: outdatedFile })
    assertDeepEqual(migrated.deckTypes, [...INITIAL_DECK_TYPES, 'Defect Lightning Orb Focus', 'Defect Newly Discovered Combo'])
    assert(!migrated.deckTypes.includes('Ironclad Block Fortress'))
    assert(!migrated.deckTypes.includes('Defect Frost Orb Focus'))
    assertEqual(migrated.statsStateDirty, true)
    assertEqual(migrated.leaderboardRuns[0].deckType, undefined)
    assertEqual(migrated.leaderboardRuns[1].deckType, 'Defect Lightning Orb Focus')
    assert(migrated.leaderboardRuns[0].deckClassificationRetry)
  })
  const migratedServer = createRoomServer({ storeFile: outdatedFile, classifierEnabled: false })
  await migratedServer.close()
  check('orphaned journal archetypes stay removed after a release marker is saved', () => {
    const restarted = createStore({ file: outdatedFile })
    assert(!restarted.deckTypes.includes('Defect Frost Orb Focus'))
    assert(!restarted.deckTypes.includes('Ironclad Block Fortress'))
  })
  const staleMainFile = JSON.parse(readFileSync(outdatedFile, 'utf8'))
  staleMainFile.deckTypes.push('Ironclad Block Fortress')
  writeFileSync(outdatedFile, JSON.stringify(staleMainFile))
  check('interrupted migration cannot restore legacy seeds from the stale main store', () => {
    const restarted = createStore({ file: outdatedFile })
    assert(!restarted.deckTypes.includes('Ironclad Block Fortress'))
    assert(restarted.deckTypes.includes('Defect Lightning Orb Focus'))
    assertEqual(restarted.statsStateDirty, true)
  })
  const store = createStore({ file })
  addLeaderboardRun(store, run(5))
  store.leaderboardRuns[0].deckType = 'Defect Lightning Orb Focus'
  store.deckTypes.push('Defect Newly Discovered Combo')
  store.deckClassificationBudget = { day: Math.floor(Date.now() / 86_400_000), used: 3 }
  saveStore(store)
  check('taxonomy and private classification survive store restarts', () => {
    const restored = createStore({ file })
    assert(restored.deckTypes.includes('Defect Newly Discovered Combo'))
    assertEqual(restored.leaderboardRuns[0].deckType, 'Defect Lightning Orb Focus')
    assertDeepEqual(restored.deckClassificationBudget, store.deckClassificationBudget)
    assertEqual(JSON.parse(readFileSync(file, 'utf8')).leaderboardRuns, undefined)
    assertEqual(JSON.parse(readFileSync(`${file}.leaderboard.json`, 'utf8'))[0].deckType, 'Defect Lightning Orb Focus')
  })
  const migrationFile = join(directory, 'stats-migration.json')
  const archived = [normalizeLeaderboardRun(run(55)), normalizeLeaderboardRun(run(56, { character: 'ironclad' })),
    { ...normalizeLeaderboardRun(run(57)), deckClassificationRetry: { after: 2_000_000_000_000, hash: 'a'.repeat(64) } },
    { ...normalizeLeaderboardRun(run(58, { finalDeck: [{ defId: 'claw', upgraded: false }] })), deckType: 'Defect Claw Spam' }]
  const legacy = [
    { ...normalizeLeaderboardRun(run(55)), deckType: 'Defect Lightning Orb Focus' },
    { ...normalizeLeaderboardRun(run(56)), deckType: 'Defect Mixed Orb' },
    { ...normalizeLeaderboardRun(run(57)), deckType: 'Defect Lightning Orb Focus' },
    normalizeLeaderboardRun(run(58, { finalDeck: undefined, winningDecks: [
      { username: 'Room Owner', character: 'defect', finalDeck: [{ defId: 'dual_cast', upgraded: false }] },
    ] })),
  ]
  writeFileSync(migrationFile, JSON.stringify({ version: 1, rooms: [], leaderboardArchive: true,
    leaderboardRuns: legacy, deckTypes: ['Defect Newly Discovered Combo'], deckClassificationBudget: { day: 123, used: 4 } }))
  writeFileSync(`${migrationFile}.leaderboard.json`, JSON.stringify(archived))
  const migrated = createStore({ file: migrationFile })
  check('split archive migration retains matching classification without carrying stale hero types', () => {
    assertEqual(migrated.leaderboardRuns[0].deckType, 'Defect Lightning Orb Focus')
    assertEqual(migrated.leaderboardRuns[1].deckType, undefined)
    assertEqual(migrated.leaderboardRuns[2].deckType, 'Defect Lightning Orb Focus')
    assertEqual(migrated.leaderboardRuns[2].deckClassificationRetry, undefined)
    assertEqual(migrated.leaderboardRuns[3].deckType, undefined)
    assertEqual(statsSnapshot([migrated.leaderboardRuns[3]], query(card('dual_cast'))).pending, 1)
    assert(migrated.deckTypes.includes('Defect Newly Discovered Combo'))
    assertDeepEqual(migrated.deckClassificationBudget, { day: 123, used: 4 })
    assertEqual(migrated.leaderboardDirty, false)
    assert(migrated.leaderboardChanges.size > 0)
    saveStore(migrated)
    assertEqual(JSON.parse(readFileSync(`${migrationFile}.leaderboard.json`, 'utf8'))[0].deckType, undefined)
    assertEqual(createStore({ file: migrationFile }).leaderboardRuns[0].deckType, 'Defect Lightning Orb Focus')
    assert(readFileSync(`${migrationFile}.stats.log`, 'utf8').includes('Defect Lightning Orb Focus'))
    assertEqual(createStore({ file: migrationFile }).statsStateDirty, false)
  })

  const rollbackFile = join(directory, 'stats-rollback.json')
  const rollbackStore = createStore({ file: rollbackFile })
  addLeaderboardRun(rollbackStore, run(59))
  saveStore(rollbackStore)
  const archiveFile = `${rollbackFile}.leaderboard.json`
  const archiveModified = statSync(archiveFile, { bigint: true }).mtimeNs
  let rollbackCalls = 0
  const rollbackServer = createRoomServer({ storeFile: rollbackFile, classifierEnabled: true, deckClassifier: async () => {
    rollbackCalls += 1
    return 'Defect Newly Discovered Combo'
  } })
  try {
    await rollbackServer.listen(0)
    for (let attempt = 0; attempt < 40 && !rollbackServer.store.leaderboardRuns[0]?.deckType; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10))
  } finally { await rollbackServer.close() }
  check('classification appends metadata without rewriting the archived run history', () => {
    assertEqual(rollbackCalls, 1)
    assertEqual(statSync(archiveFile, { bigint: true }).mtimeNs, archiveModified)
    assertEqual(JSON.parse(readFileSync(archiveFile, 'utf8'))[0].deckType, undefined)
    assert(readFileSync(`${rollbackFile}.stats.log`, 'utf8').includes('Defect Newly Discovered Combo'))
    assertEqual(createStore({ file: rollbackFile }).leaderboardRuns[0].deckType, 'Defect Newly Discovered Combo')
  })
  const retryStatsStore = createStore({ file: rollbackFile })
  appendFileSync(`${rollbackFile}.stats.log`, '{"id":')
  const classifiedRun = retryStatsStore.leaderboardRuns[0]
  retryStatsStore.statsChanges.set(classifiedRun.id, { id: classifiedRun.id, hero: classifiedRun.character,
    hash: deckHash(classifiedRun), deckType: classifiedRun.deckType })
  saveStore(retryStatsStore)
  check('a same-process retry repairs a short stats write before appending', () => {
    assertEqual(createStore({ file: rollbackFile }).leaderboardRuns[0].deckType, 'Defect Newly Discovered Combo')
    assert(readdirSync(directory).some((file) => file.startsWith('stats-rollback.json.stats.log.partial-')))
  })
  appendFileSync(`${rollbackFile}.stats.log`, '{"id":')
  const recoveredStatsServer = createRoomServer({ storeFile: rollbackFile, classifierEnabled: false })
  try {
    await recoveredStatsServer.listen(0)
    check('server startup repairs an interrupted stats append without losing complete classifications', () => {
      assertEqual(recoveredStatsServer.store.leaderboardRuns[0].deckType, 'Defect Newly Discovered Combo')
      assertEqual(recoveredStatsServer.store.interruptedJournals.size, 0)
      assert(readdirSync(directory).some((file) => file.startsWith('stats-rollback.json.stats.log.partial-')))
      assertEqual(createStore({ file: rollbackFile }).leaderboardRuns[0].deckType, 'Defect Newly Discovered Combo')
    })
  } finally { await recoveredStatsServer.close() }
  const taxonomyStateFile = `${rollbackFile}.stats.json`
  const incompleteTaxonomy = JSON.parse(readFileSync(taxonomyStateFile, 'utf8'))
  incompleteTaxonomy.deckTypes = [...INITIAL_DECK_TYPES]
  writeFileSync(taxonomyStateFile, JSON.stringify(incompleteTaxonomy))
  const incompleteMain = JSON.parse(readFileSync(rollbackFile, 'utf8'))
  incompleteMain.deckTypes = [...INITIAL_DECK_TYPES]
  writeFileSync(rollbackFile, JSON.stringify(incompleteMain))
  check('a crash between archetype log append and taxonomy save recovers the learned name', () => {
    const recovered = createStore({ file: rollbackFile })
    assertEqual(recovered.leaderboardRuns[0].deckType, 'Defect Newly Discovered Combo')
    assert(recovered.deckTypes.includes('Defect Newly Discovered Combo'))
    assertEqual(recovered.statsStateDirty, true)
    saveStore(recovered)
    assert(JSON.parse(readFileSync(taxonomyStateFile, 'utf8')).deckTypes.includes('Defect Newly Discovered Combo'))
  })
  const deferredFile = join(directory, 'deferred-retry.json')
  const deferredRun = normalizeLeaderboardRun(run(60))
  const deferredHash = deckHash(deferredRun)
  const olderRetry = { after: 2_000_000_000_000, hash: deferredHash }
  const newerRetry = { after: olderRetry.after + 86_400_000, hash: deferredHash }
  writeFileSync(deferredFile, JSON.stringify({ version: 1, rooms: [], leaderboardArchive: true }))
  writeFileSync(`${deferredFile}.leaderboard.json`, JSON.stringify([{ ...deferredRun, deckClassificationRetry: olderRetry }]))
  writeFileSync(`${deferredFile}.stats.log`, JSON.stringify({ id: deferredRun.id, hero: deferredRun.character,
    hash: deferredHash, retry: newerRetry }) + '\n')
  let prematureCalls = 0
  const deferredServer = createRoomServer({ storeFile: deferredFile, classifierEnabled: true,
    deckClassifier: async () => { prematureCalls += 1; return 'Defect Lightning Orb Focus' } })
  try {
    await deferredServer.listen(0)
    await new Promise((resolve) => setTimeout(resolve, 30))
    check('a newer retry journal entry supersedes the archived retry across another restart', () => {
      assertDeepEqual(deferredServer.store.leaderboardRuns[0].deckClassificationRetry, newerRetry)
      assertEqual(prematureCalls, 0)
      assertDeepEqual(createStore({ file: deferredFile }).leaderboardRuns[0].deckClassificationRetry, newerRetry)
    })
  } finally { await deferredServer.close() }
  await materializeLeaderboardArchive(rollbackFile)
  check('rollback materializes sidecar labels, taxonomy and paid attempts for older releases', () => {
    const raw = JSON.parse(readFileSync(rollbackFile, 'utf8'))
    assertEqual(raw.leaderboardRuns[0].deckType, 'Defect Newly Discovered Combo')
    assert(raw.deckTypes.includes('Defect Newly Discovered Combo'))
    assertEqual(raw.deckClassificationBudget.used, 1)
  })
  const downgraded = JSON.parse(readFileSync(rollbackFile, 'utf8'))
  downgraded.leaderboardRuns = downgraded.leaderboardRuns.map((entry) => normalizeLeaderboardRun(entry, entry.recordedAt))
  delete downgraded.deckTypes
  delete downgraded.deckClassificationBudget
  writeFileSync(rollbackFile, JSON.stringify(downgraded))
  writeFileSync(archiveFile, JSON.stringify(downgraded.leaderboardRuns))
  check('redeploy restores learned types, classifications and attempts after an older release saves', () => {
    const restored = createStore({ file: rollbackFile })
    assertEqual(restored.leaderboardRuns[0].deckType, 'Defect Newly Discovered Combo')
    assert(restored.deckTypes.includes('Defect Newly Discovered Combo'))
    assertEqual(restored.deckClassificationBudget.used, 1)
  })
  downgraded.deckClassificationBudget = { ...rollbackServer.store.deckClassificationBudget, used: 3 }
  writeFileSync(rollbackFile, JSON.stringify(downgraded))
  check('a newer paid-attempt count from an older stats-aware release wins on redeploy', () => {
    const restored = createStore({ file: rollbackFile })
    assertEqual(restored.deckClassificationBudget.used, 3)
    saveStore(restored)
    assertEqual(JSON.parse(readFileSync(`${rollbackFile}.stats.json`, 'utf8')).deckClassificationBudget.used, 3)
  })
  const changed = JSON.parse(readFileSync(rollbackFile, 'utf8'))
  changed.leaderboardRuns = JSON.parse(readFileSync(archiveFile, 'utf8'))
  delete changed.leaderboardRuns[0].finalDeck
  changed.leaderboardRuns[0].winningDecks = [{ username: 'Tester', character: 'defect',
    finalDeck: [{ defId: 'claw', upgraded: false }] }]
  changed.leaderboardRuns[0].combatsFinished = 12
  changed.leaderboardRuns[0].damageDealt = 200
  delete changed.leaderboardArchive
  writeFileSync(rollbackFile, JSON.stringify(changed))
  check('older-release score and deck replacements retain their metrics without stale classifications', () => {
    const restored = createStore({ file: rollbackFile })
    assertDeepEqual(restored.leaderboardRuns[0].winningDecks, changed.leaderboardRuns[0].winningDecks)
    assertEqual(restored.leaderboardRuns[0].combatsFinished, 12)
    assertEqual(restored.leaderboardRuns[0].damageDealt, 200)
    assertEqual(restored.leaderboardRuns[0].deckType, undefined)
    saveStore(restored)
    const redeployed = createStore({ file: rollbackFile }).leaderboardRuns[0]
    assertDeepEqual(redeployed.winningDecks, restored.leaderboardRuns[0].winningDecks)
    assertEqual(redeployed.damageDealt, 200)
  })

  const threadId = '123e4567-e89b-12d3-a456-426614174000'
  const calls = []
  const simulatedCodex = (name) => (command, args, options) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => {}
    child.stdin = new EventEmitter()
    child.stdin.end = (prompt) => {
      calls.push({ command, args, options, prompt })
      queueMicrotask(() => {
        child.stdout.emit('data', `${JSON.stringify({ type: 'thread.started', thread_id: threadId })}\n`)
        child.stdout.emit('data', `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ name }) } })}\n`)
        child.stdout.emit('data', '{"type":"turn.completed"}\n')
        child.emit('close', 0)
      })
    }
    return child
  }
  const type = await classifyDeckType(normalizeLeaderboardRun(run(6)), INITIAL_DECK_TYPES, undefined,
    simulatedCodex('Defect Mixed Orb'))
  const resumedType = await classifyDeckType(archive[0], INITIAL_DECK_TYPES, threadId,
    simulatedCodex('defect mixed orb'))
  check('server-only Codex CLI creates and resumes a read-only GPT-6 Sol high thread', () => {
    assertDeepEqual(type, { type: 'Defect Mixed Orb', threadId })
    assertDeepEqual(resumedType, type)
    assert(calls[0].args.includes('gpt-6-sol'))
    assert(calls[0].args.includes('model_reasoning_effort="high"'))
    assert(!calls[0].args.some((argument) => argument.startsWith('sandbox_mode=')))
    assert(calls[0].args.includes('default_permissions="deck_classifier"'))
    assert(calls[0].args.includes('permissions.deck_classifier.filesystem={":root"="read","/codex-home"="deny"}'))
    assert(calls[0].args.includes('--ignore-user-config'))
    assert(calls[0].args.includes('--strict-config'))
    assert(calls[0].args.includes('--output-schema'))
    assertEqual(calls[0].command, '/bin/bash')
    assert(calls[0].args[0].endsWith('/codex-deck-worker.sh'))
    assertDeepEqual(calls[1].args.slice(-3), ['resume', threadId, '-'])
    assert(!Object.keys(calls[0].options.env).some((key) => /KEY|TOKEN|SECRET/.test(key)))
    assert(JSON.parse(calls[0].prompt.slice(calls[0].prompt.indexOf('\n') + 1)).cards.some((card) => card.name === 'Dual Cast'))
  })
  const hermitDeck = (id, floorsCleared) => normalizeLeaderboardRun(run(id, { character: 'hermit', floorsCleared,
    finalDeck: [{ defId: 'hermit_snapshot', upgraded: false }] }))
  const hermitLow = hermitDeck(149, 14)
  const hermitHigh = hermitDeck(150, 15)
  const hermitTypes = ['Hermit Other', 'Hermit Chamber Shots']
  const lowExisting = await classifyDeckType(hermitLow, hermitTypes, undefined, simulatedCodex('hermit chamber shots'))
  const lowOther = await classifyDeckType(hermitDeck(151, null), hermitTypes, undefined, simulatedCodex('hermit other'))
  const inventedLow = await classifyDeckType(hermitLow, hermitTypes, undefined,
    simulatedCodex('Hermit New Plan')).then(() => null, (error) => error)
  const firstHighOther = await classifyDeckType(hermitHigh, ['Hermit Other'], undefined,
    simulatedCodex('Hermit Other')).then(() => null, (error) => error)
  const firstHighSpecific = await classifyDeckType(hermitHigh, ['Hermit Other'], undefined,
    simulatedCodex('Hermit Chamber Shots'))
  const laterHighOther = await classifyDeckType(hermitHigh, hermitTypes, undefined,
    simulatedCodex('Hermit Other'))
  check('Codex can reuse types below floor 15 but cannot invent a specific type, including with unknown floors', () => {
    assertEqual(lowExisting.type, 'Hermit Chamber Shots')
    assertEqual(lowOther.type, 'Hermit Other')
    assert(inventedLow?.message.includes('invalid type'))
    assert(calls.at(-5).prompt.includes('never invent a new specific archetype'))
  })
  check('the first floor-15 Hermit deck must create a specific type, not reuse Other', () => {
    assert(firstHighOther?.message.includes('invalid type'))
    assertEqual(firstHighSpecific.type, 'Hermit Chamber Shots')
    assertEqual(laterHighOther.type, 'Hermit Other')
    assert(calls.at(-2).prompt.includes('never choose "Hermit Other"'))
  })
  const sampleRuns = [
    ...archive,
    { ...normalizeLeaderboardRun(run(63, { finalDeck: [{ defId: 'zap', upgraded: false }] })), deckType: 'Defect Lightning Orb Focus' },
    { ...normalizeLeaderboardRun(run(64, { finalDeck: archive[0].finalDeck })), deckType: 'Defect Lightning Orb Focus' },
    { ...normalizeLeaderboardRun(run(65, { character: 'silent', finalDeck: [{ defId: 'neutralize', upgraded: false }] })), deckType: 'Silent Poison' },
  ]
  await classifyDeckType(archive[0], [...INITIAL_DECK_TYPES, 'Defect Lightning Orb Focus'], undefined,
    simulatedCodex('Defect Mixed Orb'), undefined, sampleRuns)
  check('each hero archetype includes up to three distinct matching deck samples and never player IDs', () => {
    const input = JSON.parse(calls.at(-1).prompt.split('\n').at(-1))
    const lightning = input.existingTypes.find((entry) => entry.name === 'Defect Lightning Orb Focus')
    assertEqual(lightning.samples.length, 3)
    assertEqual(input.existingTypes.find((entry) => entry.name === 'Defect Claw Spam').samples.length, 1)
    assert(input.existingTypes.every((entry) => entry.name.startsWith('Defect ')))
    assert(lightning.samples.some((sample) => sample.cards.some(([name]) => name === 'Zap')))
    assert(!JSON.stringify(input).includes('browser-1234'))
    assert(calls.at(-1).prompt.includes('For EVERY existing archetype'))
  })
  const sameNameSamples = ['strike_defect', 'strike_ironclad'].map((defId, index) => ({
    ...normalizeLeaderboardRun(run(75 + index, { finalDeck: [{ defId, upgraded: true }] })), deckType: 'Defect Mixed Orb',
  }))
  await classifyDeckType(archive[0], INITIAL_DECK_TYPES, undefined,
    simulatedCodex('Defect Mixed Orb'), undefined, sameNameSamples)
  check('distinct cross-hero cards keep separate sample identities despite identical display names', () => {
    const group = JSON.parse(calls.at(-1).prompt.split('\n').at(-1)).existingTypes.find((entry) => entry.name === 'Defect Mixed Orb')
    assertEqual(group.samples.length, 2)
    assertDeepEqual(group.samples.map((sample) => sample.cards[0][2]).sort(), ['strike_defect', 'strike_ironclad'])
  })
  const beforeZap = Object.keys(CARDS).filter((defId) => defId !== 'zap' && faceOf(CARDS[defId], false).name.localeCompare('Zap') < 0).slice(0, 40)
  const engineSample = { ...normalizeLeaderboardRun(run(78, { finalDeck: [
    ...beforeZap.map((defId) => ({ defId, upgraded: false })),
    ...Array.from({ length: 30 }, () => ({ defId: 'zap', upgraded: false })),
  ] })), deckType: 'Defect Mixed Orb' }
  await classifyDeckType(archive[0], INITIAL_DECK_TYPES, undefined,
    simulatedCodex('Defect Mixed Orb'), undefined, [engineSample])
  check('sample truncation keeps a deck’s defining repeated cards', () => {
    assertEqual(beforeZap.length, 40)
    const sample = JSON.parse(calls.at(-1).prompt.split('\n').at(-1)).existingTypes.find((entry) => entry.name === 'Defect Mixed Orb').samples[0]
    assertDeepEqual(sample.cards[0].slice(0, 2), ['Zap', 30])
    assertEqual(sample.omittedCards, 1)
  })
  let invalidTypeError
  try {
    await classifyDeckType(archive[0], INITIAL_DECK_TYPES, undefined, simulatedCodex('Silent Shiv Finisher'))
  } catch (error) { invalidTypeError = error }
  check('wrong-hero responses are rejected without losing the started thread', () => {
    assertEqual(invalidTypeError?.message, 'Deck classifier returned an invalid type')
    assertEqual(invalidTypeError?.threadId, threadId)
  })
  const previousBin = process.env.STS_CODEX_BIN
  let missingBinError
  try {
    process.env.STS_CODEX_BIN = join(directory, 'missing-codex')
    await classifyDeckType(archive[0], INITIAL_DECK_TYPES)
  } catch (error) { missingBinError = error }
  finally {
    if (previousBin === undefined) delete process.env.STS_CODEX_BIN
    else process.env.STS_CODEX_BIN = previousBin
  }
  check('missing Codex CLI fails safely without classifying a run', () => {
    assertEqual(missingBinError?.code, 'classifier_unavailable')
    assertEqual(missingBinError?.message, 'Codex CLI is unavailable or not authenticated')
  })
  const isolatedHome = join(directory, 'isolated-auth')
  const isolatedAuth = join(isolatedHome, '.local/share/slay-the-spire-server/codex/auth.json')
  const fakeCodex = join(isolatedHome, 'cli/bin/codex.js')
  const standaloneCodex = join(isolatedHome, 'cli/codex')
  const fakeBwrapDir = join(isolatedHome, 'bin')
  mkdirSync(join(isolatedHome, '.local/share/slay-the-spire-server/codex'), { recursive: true })
  mkdirSync(join(isolatedHome, 'cli/bin'), { recursive: true })
  mkdirSync(fakeBwrapDir)
  writeFileSync(fakeCodex, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  writeFileSync(standaloneCodex, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  writeFileSync(join(fakeBwrapDir, 'bwrap'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$HOME/bwrap-args"\nprintf called > "$HOME/bwrap-invoked"\n', { mode: 0o755 })
  const fakeLogin = (executable = fakeCodex) => spawnSync('/bin/bash', [calls[0].args[0], 'login', 'status'], {
    cwd: process.cwd(), stdio: 'ignore', env: {
      HOME: isolatedHome, USER: process.env.USER, PATH: `${fakeBwrapDir}:${process.env.PATH}`,
      NODE_BINARY: process.execPath, STS_CODEX_BIN: executable,
    },
  }).status
  writeFileSync(isolatedAuth, JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'fake-never-send' }), { mode: 0o600 })
  const keyLoginStatus = fakeLogin()
  const keyReachedWorker = existsSync(join(isolatedHome, 'bwrap-invoked'))
  writeFileSync(isolatedAuth, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'fake-never-send' } }), { mode: 0o600 })
  const unsupportedBinaryStatus = fakeLogin(standaloneCodex)
  const chatgptLoginStatus = fakeLogin()
  check('the isolated worker rejects API-key auth and allows only dedicated ChatGPT credentials', () => {
    assertEqual(keyLoginStatus, 66)
    assertEqual(keyReachedWorker, false)
    assertEqual(unsupportedBinaryStatus, 66)
    assertEqual(chatgptLoginStatus, 0)
    assertEqual(statSync(join(isolatedHome, '.local/share/slay-the-spire-server/codex')).mode & 0o777, 0o700)
    const mounts = readFileSync(join(isolatedHome, 'bwrap-args'), 'utf8').split('\n')
    assert(mounts.includes(join(process.cwd(), 'src/game')))
    assert(mounts.includes('/workspace/src/game'))
    assert(mounts.includes(join('/workspace', 'scripts', 'lib', 'deck-type.schema.json')))
    assert(!mounts.some((source, index) => source === process.cwd() && mounts[index + 1] === '/workspace'))
    assert(!mounts.some((source, index) => source === '/opt' && mounts[index + 1] === '/opt'))
    assert(!mounts.some((source, index) => source === '/etc/ssl' && mounts[index + 1] === '/etc/ssl'))
    assert(mounts.includes('/etc/ssl/certs'))
    if (process.execPath.startsWith('/opt/')) assert(mounts.includes(join(process.execPath, '..', '..')))
  })
  let abilityCards
  await classifyDeckType(normalizeLeaderboardRun(run(46, { character: 'ironclad', finalDeck: [
    { defId: 'barricade', upgraded: false }, { defId: 'heavy_blade', upgraded: true },
  ] })), INITIAL_DECK_TYPES, undefined, simulatedCodex('Ironclad Barricade Body Slam'))
  abilityCards = JSON.parse(calls.at(-1).prompt.split('\n').at(-1)).cards
  check('classification retains card abilities and effect amounts, not just effect names', () => {
    assert(abilityCards.find((card) => card.name === 'Barricade').rules.includes('"retainBlock":true'))
    const heavy = abilityCards.find((card) => card.name === 'Heavy Blade+')
    assert(heavy.rules.includes('"per":"strength"') && heavy.rules.includes('"scale":4'))
  })
  const guardianPayload = async (gemId) => {
    const guardianRun = normalizeLeaderboardRun(run(25, { character: 'guardian', finalDeck: [
      { defId: 'guardian_prismatic_barrier', upgraded: true, attachedGemId: gemId },
    ] }))
    await classifyDeckType(guardianRun, INITIAL_DECK_TYPES, undefined, simulatedCodex('Guardian Socket Gems'))
    return JSON.parse(calls.at(-1).prompt.split('\n').at(-1)).cards
  }
  const rubyCards = await guardianPayload('guardian_ruby')
  const sapphireCards = await guardianPayload('guardian_sapphire')
  check('Guardian classification includes upgraded face text and individual socketed Gem effects', () => {
    assertEqual(rubyCards[0].name, 'Prismatic Barrier+')
    assert(rubyCards[0].text.includes('block'))
    assertEqual(rubyCards[0].socketedGem.name, 'Ruby')
    assert(rubyCards[0].socketedGem.text.includes('damage'))
    assertEqual(sapphireCards[0].socketedGem.name, 'Sapphire')
    assert(!rubyCards[0].name.endsWith('++'))
  })
  await classifyDeckType(normalizeLeaderboardRun(run(28, { finalDeck: [{ defId: 'dual_cast', upgraded: true }] })),
    INITIAL_DECK_TYPES, undefined, simulatedCodex('Defect Lightning Orb Focus'))
  const upgradedPayload = JSON.parse(calls.at(-1).prompt.split('\n').at(-1)).cards
  check('non-Guardian upgraded cards are named without duplicate plus signs', () => assertEqual(upgradedPayload[0].name, 'Dual Cast+'))
  const largeDeck = normalizeLeaderboardRun(run(36, { finalDeck: Object.keys(CARDS).slice(0, 470).map((defId) => ({ defId, upgraded: false })) }))
  await classifyDeckType(largeDeck, INITIAL_DECK_TYPES, undefined, simulatedCodex('Defect Lightning Orb Focus'))
  const largeInput = calls.at(-1).prompt.split('\n').at(-1)
  check('unusually large public decks cannot send unbounded model input', () => {
    assert(largeInput.length <= 20_000)
    assert(JSON.parse(largeInput).cards.length <= 50)
    assert(JSON.parse(largeInput).omittedCards > 0)
    assertEqual(JSON.parse(largeInput).totalCards, 470)
  })
  const incomingRun = normalizeLeaderboardRun(run(71, { finalDeck: Object.keys(CARDS).slice(70, 120)
    .map((defId) => ({ defId, upgraded: false })) }))
  await classifyDeckType(incomingRun, INITIAL_DECK_TYPES, undefined, simulatedCodex('Defect Mixed Orb'))
  const unsampledCards = JSON.parse(calls.at(-1).prompt.split('\n').at(-1)).cards
  const manyTypes = Array.from({ length: 44 }, (_, index) => `Defect Variant ${String(index).padStart(2, '0')}`)
  const manySamples = manyTypes.flatMap((name, typeIndex) => Array.from({ length: 3 }, (_, sampleIndex) => ({
    ...normalizeLeaderboardRun(run(200 + typeIndex * 3 + sampleIndex, {
      finalDeck: Object.keys(CARDS).slice(20 + typeIndex + sampleIndex, 70 + typeIndex + sampleIndex)
        .map((defId) => ({ defId, upgraded: false })),
    })), deckType: name,
  })))
  await classifyDeckType(incomingRun, manyTypes.slice(0, 8), undefined, simulatedCodex('Defect Mixed Orb'), undefined, manySamples)
  const sampledCards = JSON.parse(calls.at(-1).prompt.split('\n').at(-1)).cards
  await classifyDeckType(incomingRun, manyTypes, undefined, simulatedCodex('Defect Mixed Orb'), undefined, manySamples)
  const manyInput = JSON.parse(calls.at(-1).prompt.split('\n').at(-1))
  check('archetype samples never crowd out the submitted deck and large catalogs keep every candidate', () => {
    assertDeepEqual(sampledCards, unsampledCards)
    assertDeepEqual(manyInput.cards, unsampledCards)
    assertEqual(manyInput.existingTypes.length, manyTypes.length)
    assert(manyInput.existingTypes.every((entry) => entry.samples.length >= 1 && entry.samples.length <= 3))
    assert(JSON.stringify(manyInput).length <= 100_000)
  })
  const crowdedTypes = Array.from({ length: 180 }, (_, index) => `Defect Catalog ${String(index).padStart(3, '0')}`)
  const crowdedSamples = crowdedTypes.flatMap((name, typeIndex) => Array.from({ length: 3 }, (_, sampleIndex) => ({
    ...manySamples[(typeIndex * 3 + sampleIndex) % manySamples.length], deckType: name,
  })))
  const crowdedStart = performance.now()
  await classifyDeckType(incomingRun, crowdedTypes, undefined, simulatedCodex('Defect Mixed Orb'), undefined, crowdedSamples)
  const crowdedDuration = performance.now() - crowdedStart
  check('crowded catalogs trim without blocking multiplayer on repeated full serialization', () => {
    const input = JSON.parse(calls.at(-1).prompt.split('\n').at(-1))
    assertEqual(input.existingTypes.length, crowdedTypes.length)
    assert(JSON.stringify(input).length <= 100_000)
    assert(crowdedDuration < 5_000, `catalog trimming blocked for ${crowdedDuration}ms`)
  })
  const failedJsonl = (event, startThread = false) => () => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdin = new EventEmitter()
    child.kill = () => {}
    child.stdin.end = () => queueMicrotask(() => {
      if (startThread) child.stdout.emit('data', `${JSON.stringify({ type: 'thread.started', thread_id: threadId })}\n`)
      child.stdout.emit('data', `${JSON.stringify(event)}\n`)
      child.emit('close', 1)
    })
    return child
  }
  let exhaustedError
  try { await classifyDeckType(archive[0], INITIAL_DECK_TYPES, undefined,
    failedJsonl({ type: 'turn.failed', error: { message: 'max_output_tokens exceeded' } }, true)) }
  catch (error) { exhaustedError = error }
  check('Codex output token exhaustion preserves its resumable first-turn thread', () => {
    assertEqual(exhaustedError?.code, 'max_output_tokens')
    assertEqual(exhaustedError?.threadId, threadId)
  })
  let contextError
  try { await classifyDeckType(archive[0], INITIAL_DECK_TYPES, undefined,
    failedJsonl({ type: 'turn.failed', error: { message: 'context_window_exceeded' } }, true)) }
  catch (error) { contextError = error }
  check('first-turn context exhaustion does not become a resumable output limit', () => {
    assertEqual(contextError?.code, 'context_exhausted')
    assertEqual(contextError?.threadId, threadId)
  })
  let failedFirstTurn
  try { await classifyDeckType(archive[0], INITIAL_DECK_TYPES, undefined,
    failedJsonl({ type: 'turn.failed', error: { message: 'temporary network failure' } }, true)) }
  catch (error) { failedFirstTurn = error }
  check('transient first-turn failures keep the started thread for the next retry', () => {
    assertEqual(failedFirstTurn?.code, undefined)
    assertEqual(failedFirstTurn?.threadId, threadId)
  })
  const abortedCodex = (startBeforeAbort) => () => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdin = new EventEmitter()
    child.kill = () => {}
    child.stdin.end = () => queueMicrotask(() => {
      const started = () => child.stdout.emit('data', `${JSON.stringify({ type: 'thread.started', thread_id: threadId })}\n`)
      if (startBeforeAbort) started()
      child.emit('error', Object.assign(new Error('model turn timed out'), { code: 'ABORT_ERR' }))
      if (!startBeforeAbort) started()
      child.emit('close', null)
    })
    return child
  }
  const timedOutFirstTurns = []
  for (const startBeforeAbort of [true, false]) {
    try { await classifyDeckType(archive[0], INITIAL_DECK_TYPES, undefined, abortedCodex(startBeforeAbort)) }
    catch (error) { timedOutFirstTurns.push({ code: error.code, threadId: error.threadId }) }
  }
  check('Codex startup and timeout preserve a resumable thread in either event order', () => {
    assertDeepEqual(timedOutFirstTurns, [true, false].map(() => ({ code: 'ABORT_ERR', threadId })))
  })
  let jsonlUnauthorized
  try { await classifyDeckType(archive[0], INITIAL_DECK_TYPES, undefined,
    failedJsonl({ type: 'error', message: '401 Unauthorized' })) }
  catch (error) { jsonlUnauthorized = error }
  check('JSONL-only authentication errors disable further classified attempts', () =>
    assertEqual(jsonlUnauthorized?.code, 'classifier_unavailable'))
  const malformedJsonl = () => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdin = new EventEmitter()
    child.kill = () => {}
    child.stdin.end = () => queueMicrotask(() => {
      child.stdout.emit('data', 'null\n')
      child.emit('close', 1)
    })
    return child
  }
  let malformedError
  try { await classifyDeckType(archive[0], INITIAL_DECK_TYPES, undefined, malformedJsonl) }
  catch (error) { malformedError = error }
  check('malformed Codex JSONL cannot crash the multiplayer process', () =>
    assertEqual(malformedError?.message, 'Deck classifier emitted invalid output'))
  let expiredTokenError
  try { await classifyDeckType(archive[0], INITIAL_DECK_TYPES, undefined,
    failedJsonl({ type: 'error', message: 'Failed to refresh token' })) }
  catch (error) { expiredTokenError = error }
  check('expired ChatGPT refresh tokens stop classification without wasting daily attempts', () =>
    assertEqual(expiredTokenError?.code, 'classifier_unavailable'))
  const mixedFailure = (stdoutFirst) => () => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdin = new EventEmitter()
    child.kill = () => {}
    child.stdin.end = () => queueMicrotask(() => {
      const stdout = () => child.stdout.emit('data', '{"type":"turn.failed","error":{"message":"stream disconnected"}}\n')
      if (stdoutFirst) stdout()
      child.stderr.emit('data', '401 Unauthorized')
      if (!stdoutFirst) stdout()
      child.emit('close', 1)
    })
    return child
  }
  const mixedFailureCodes = []
  for (const stdoutFirst of [true, false]) {
    try { await classifyDeckType(archive[0], INITIAL_DECK_TYPES, undefined, mixedFailure(stdoutFirst)) }
    catch (error) { mixedFailureCodes.push(error.code) }
  }
  check('mixed stderr and JSONL auth failures refund attempts regardless of output order', () =>
    assertDeepEqual(mixedFailureCodes, ['classifier_unavailable', 'classifier_unavailable']))
  const failureOnStderr = (reason) => () => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdin = new EventEmitter()
    child.kill = () => {}
    child.stdin.end = () => queueMicrotask(() => {
      child.stderr.emit('data', reason)
      child.emit('close', 1)
    })
    return child
  }
  let missingSessionError
  try { await classifyDeckType(archive[0], INITIAL_DECK_TYPES, threadId,
    failureOnStderr('Error: thread/resume failed: no rollout found for thread id')) }
  catch (error) { missingSessionError = error }
  check('missing Codex rollouts reset stale thread IDs instead of retrying forever', () =>
    assertEqual(missingSessionError?.code, 'stale_thread'))
  let unauthorizedError
  try { await classifyDeckType(archive[0], INITIAL_DECK_TYPES, undefined,
    failureOnStderr('Error: 401 Unauthorized')) }
  catch (error) { unauthorizedError = error }
  check('stderr-only authentication failures disable Codex instead of burning the budget', () =>
    assertEqual(unauthorizedError?.code, 'classifier_unavailable'))
  let fullContextError
  try { await classifyDeckType(archive[0], INITIAL_DECK_TYPES, threadId,
    failureOnStderr('Error: context_window_exceeded')) }
  catch (error) { fullContextError = error }
  check('full Codex contexts reset the thread rather than resuming it next day', () =>
    assertEqual(fullContextError?.code, 'stale_thread'))

  const classifications = []
  const suppliedSignal = new AbortController()
  let forwardedSignal
  await classifyDeckType(archive[0], INITIAL_DECK_TYPES, undefined, (command, args, options) => {
    forwardedSignal = options.signal
    return simulatedCodex('Defect Lightning Orb Focus')(command, args, options)
  }, suppliedSignal.signal)
  check('deck classifier passes the supplied shutdown signal to its child process', () => assertEqual(forwardedSignal, suppliedSignal.signal))
  server = createRoomServer({ classifierEnabled: true, deckClassifier: async (entry, types, currentThreadId) => {
    classifications.push({ id: entry.id, types: [...types], currentThreadId })
    return entry.character === 'defect' ? 'Defect Lightning Orb Focus' : 'Ironclad Exhaust Engine'
  } })
  const { port } = await server.listen(0)
  const base = `http://127.0.0.1:${port}`
  const submitted = await fetch(`${base}/api/leaderboard`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...run(7), deckType: 'Defect Claw Spam', username: 'private user' }) })
  assertEqual(submitted.status, 201)
  for (let attempt = 0; attempt < 40 && !server.store.leaderboardRuns[0]?.deckType; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 10))
  check('submissions cannot forge types; private background classification owns them', () => {
    assertEqual(server.store.leaderboardRuns[0].deckType, 'Defect Lightning Orb Focus')
    assertEqual(classifications[0].currentThreadId, undefined)
  })
  const stats = await fetch(`${base}/api/stats`).then((response) => response.json())
  const sample = await fetch(`${base}/api/stats/deck?type=Defect+Lightning+Orb+Focus`).then((response) => response.json())
  check('public endpoints reveal aggregate metrics and decks but no installation or profile data', () => {
    assertEqual(stats.rows[0].runs, 1)
    assertDeepEqual(Object.keys(sample).sort(), ['cards', 'character', 'deckType'])
    assert(!JSON.stringify({ stats, sample }).includes('private user'))
    assert(!JSON.stringify({ stats, sample }).includes('browser-1234'))
  })
  const sharedPolls = await Promise.all(Array.from({ length: 32 }, () => fetch(`${base}/api/stats`)))
  check('eight visible users sharing an IP can poll pending results every 15 seconds', () => {
    assert(sharedPolls.every((response) => response.status === 200))
  })
  const authoritative = { ...normalizeLeaderboardRun(run(37, { finalDeck: undefined, winningDecks: [
    { username: 'Room Owner', character: 'defect', finalDeck: [{ defId: 'dual_cast', upgraded: false }] },
  ] })), deckType: 'Defect Lightning Orb Focus' }
  server.store.leaderboardRuns.push(authoritative)
  const spoof = await fetch(`${base}/api/leaderboard`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(run(37, { finalDeck: [{ defId: 'claw', upgraded: false }] })) })
  check('public duplicate submissions cannot replace a finished solo-room deck', () => {
    assertEqual(spoof.status, 200)
    assertEqual(server.store.leaderboardRuns[1].finalDeck, undefined)
    assertEqual(randomDeck([server.store.leaderboardRuns[1]], new URLSearchParams({ type: 'Defect Lightning Orb Focus' })).cards[0].defId, 'dual_cast')
    assertEqual(statsSnapshot([server.store.leaderboardRuns[1]], query(card('claw'))).runs, 0)
  })
  const forged = await fetch(`${base}/api/stats`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  check('there is no public route to request model usage', () => assertEqual(forged.status, 404))

  let invoked = false
  const invalidType = await classifyDeckType(normalizeLeaderboardRun(run(18, { finalDeck: [
    { defId: 'unknown_card', upgraded: false },
  ] })), INITIAL_DECK_TYPES, undefined, () => { invoked = true })
  const impossibleType = await classifyDeckType(normalizeLeaderboardRun(run(45, { finalDeck: [
    { defId: 'burn', upgraded: true },
  ] })), INITIAL_DECK_TYPES, undefined, () => { invoked = true })
  check('unknown cards and impossible upgrades never reach the paid model', () => {
    assertEqual(invalidType, null)
    assertEqual(impossibleType, null)
    assertEqual(invoked, false)
  })

  const limitedFile = join(directory, 'budget.json')
  const limited = createRoomServer({ storeFile: limitedFile, classifierEnabled: true, maxDeckClassificationsPerDay: 1,
    deckClassifier: async () => 'Defect Lightning Orb Focus' })
  try {
    const limitedAddress = await limited.listen(0)
    const limitedUrl = `http://127.0.0.1:${limitedAddress.port}/api/leaderboard`
    for (const id of [19, 20]) {
      const response = await fetch(limitedUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': `client-${id}` }, body: JSON.stringify(run(id)) })
      assertEqual(response.status, 201)
    }
    for (let attempt = 0; attempt < 40 && !limited.store.leaderboardRuns[0]?.deckType; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    check('global daily budget caps anonymous submissions independently of IP limits', () => {
      assertEqual(limited.store.leaderboardRuns[0].deckType, 'Defect Lightning Orb Focus')
      assertEqual(limited.store.leaderboardRuns[1].deckType, undefined)
      assertEqual(limited.store.deckClassificationBudget.used, 1)
    })
  } finally { await limited.close() }
  check('daily model budget and newly classified archive rows survive server restarts', () => {
    const restored = createStore({ file: limitedFile })
    assertEqual(restored.deckClassificationBudget.used, 1)
    assertEqual(restored.leaderboardRuns[0].deckType, 'Defect Lightning Orb Focus')
    assertEqual(restored.leaderboardRuns[1].deckType, undefined)
  })
  const longRetryFile = join(directory, 'long-retry.json')
  const longRetryStore = createStore({ file: longRetryFile })
  addLeaderboardRun(longRetryStore, run(74))
  longRetryStore.leaderboardRuns[0].deckClassificationRetry = {
    after: Date.now() + 2_147_483_647 + 100_000, hash: deckHash(longRetryStore.leaderboardRuns[0]),
  }
  saveStore(longRetryStore)
  const nativeSetTimeout = globalThis.setTimeout
  let longTimer = 0
  let longRetryCalls = 0
  let longRetryServer
  try {
    globalThis.setTimeout = (callback, delay, ...args) => {
      if (delay > 1_000_000_000) longTimer = Math.max(longTimer, delay)
      return nativeSetTimeout(callback, delay, ...args)
    }
    longRetryServer = createRoomServer({ storeFile: longRetryFile, classifierEnabled: true,
      deckClassifier: async () => { longRetryCalls += 1; return 'Defect Mixed Orb' } })
    await longRetryServer.listen(0)
    await new Promise((resolve) => nativeSetTimeout(resolve, 40))
    check('distant persisted retries clamp timers rather than spinning every millisecond', () => {
      assertEqual(longTimer, 2_147_483_647)
      assertEqual(longRetryCalls, 0)
    })
  } finally {
    globalThis.setTimeout = nativeSetTimeout
    if (longRetryServer) await longRetryServer.close()
  }
  const exhaustedFile = join(directory, 'exhausted.json')
  const exhaustedThreads = []
  const exhaustedClassifier = async (_entry, _types, currentThreadId) => {
    exhaustedThreads.push(currentThreadId)
    if (exhaustedThreads.length === 1)
      throw Object.assign(new Error('Codex output token limit'), { code: 'max_output_tokens', threadId })
    return { type: 'Defect Mixed Orb', threadId }
  }
  let exhaustedServer = createRoomServer({ storeFile: exhaustedFile, classifierEnabled: true, deckClassifier: exhaustedClassifier })
  try {
    const address = await exhaustedServer.listen(0)
    assertEqual((await fetch(`http://127.0.0.1:${address.port}/api/leaderboard`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(run(70)) })).status, 201)
    for (let attempt = 0; attempt < 40 && !exhaustedServer.store.leaderboardRuns[0]?.deckClassificationRetry; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    await exhaustedServer.close()
    exhaustedServer = createRoomServer({ storeFile: exhaustedFile, classifierEnabled: true, deckClassifier: exhaustedClassifier })
    const resumedAddress = await exhaustedServer.listen(0)
    await new Promise((resolve) => setTimeout(resolve, 30))
    check('token exhaustion defers the deck until next UTC day even after restart', () => {
      assertEqual(exhaustedThreads.length, 1)
      const restored = createStore({ file: exhaustedFile })
      assert(restored.leaderboardRuns[0].deckClassificationRetry.after > Date.now())
      assertEqual(restored.deckClassificationBudget.used, 1)
      assertEqual(restored.deckClassifierThreadId, threadId)
    })
    assertEqual((await fetch(`http://127.0.0.1:${resumedAddress.port}/api/leaderboard`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(run(76)) })).status, 201)
    for (let attempt = 0; attempt < 40 && !exhaustedServer.store.leaderboardRuns[1]?.deckType; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    check('the next submitted deck reuses a first-turn thread even while that deck waits', () => {
      assertDeepEqual(exhaustedThreads, [undefined, threadId])
      assertEqual(exhaustedServer.store.leaderboardRuns[0].deckType, undefined)
      assertEqual(exhaustedServer.store.leaderboardRuns[1].deckType, 'Defect Mixed Orb')
    })
  } finally { await exhaustedServer.close() }
  const contextFile = join(directory, 'context-exhausted.json')
  const contextThreads = []
  const contextServer = createRoomServer({ storeFile: contextFile, classifierEnabled: true,
    deckClassifier: async (_entry, _types, currentThreadId) => {
      contextThreads.push(currentThreadId)
      if (contextThreads.length === 1)
        throw Object.assign(new Error('Codex context is full'), { code: 'context_exhausted', threadId })
      return { type: 'Defect Mixed Orb', threadId }
    } })
  try {
    const address = await contextServer.listen(0)
    const submit = (id) => fetch(`http://127.0.0.1:${address.port}/api/leaderboard`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(run(id)) })
    assertEqual((await submit(77)).status, 201)
    for (let attempt = 0; attempt < 40 && !contextServer.store.leaderboardRuns[0]?.deckClassificationRetry; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    assertEqual((await submit(79)).status, 201)
    for (let attempt = 0; attempt < 40 && !contextServer.store.leaderboardRuns[1]?.deckType; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    check('first-turn context exhaustion defers its deck without retaining a full thread', () => {
      assertDeepEqual(contextThreads, [undefined, undefined])
      assert(contextServer.store.leaderboardRuns[0].deckClassificationRetry.after > Date.now())
      assertEqual(contextServer.store.leaderboardRuns[1].deckType, 'Defect Mixed Orb')
    })
  } finally { await contextServer.close() }
  const unauthenticatedFile = join(directory, 'unauthenticated.json')
  const savedBin = process.env.STS_CODEX_BIN
  process.env.STS_CODEX_BIN = join(directory, 'missing-codex')
  let unauthenticatedServer
  try {
    unauthenticatedServer = createRoomServer({ storeFile: unauthenticatedFile, classifierEnabled: true })
    const address = await unauthenticatedServer.listen(0)
    assertEqual((await fetch(`http://127.0.0.1:${address.port}/api/leaderboard`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(run(67)) })).status, 201)
    check('missing authentication disables classification before spending daily attempts', () => {
      assertEqual(unauthenticatedServer.store.leaderboardRuns[0].deckType, undefined)
      assertEqual(unauthenticatedServer.store.deckClassificationBudget.used, 0)
    })
  } finally {
    if (unauthenticatedServer) await unauthenticatedServer.close()
    if (savedBin === undefined) delete process.env.STS_CODEX_BIN
    else process.env.STS_CODEX_BIN = savedBin
  }
  const thresholdFile = join(directory, 'archetype-floor.json')
  const thresholdServer = createRoomServer({ storeFile: thresholdFile, classifierEnabled: false })
  try {
    const address = await thresholdServer.listen(0)
    const submit = (id, floorsCleared) => fetch(`http://127.0.0.1:${address.port}/api/leaderboard`, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(run(id, { character: 'guardian', floorsCleared,
        finalDeck: [{ defId: 'guardian_prismatic_barrier', upgraded: false }] })) })
    assertEqual((await submit(151, null)).status, 201)
    assertEqual((await submit(152, 14)).status, 201)
    assertEqual((await submit(153, 15)).status, 201)
    check('shallow first decks use Guardian Other without login or model spending, but floor-15 decks remain pending', () => {
      assertDeepEqual(thresholdServer.store.leaderboardRuns.map((entry) => entry.deckType), ['Guardian Other', 'Guardian Other', undefined])
      assertEqual(thresholdServer.store.deckClassificationBudget.used, 0)
      assert(thresholdServer.store.deckTypes.includes('Guardian Other'))
      assertEqual(statsSnapshot(thresholdServer.store.leaderboardRuns).rows.find((row) => row.deckType === 'Guardian Other').runs, 2)
    })
    saveStore(thresholdServer.store)
    assertEqual(createStore({ file: thresholdFile }).leaderboardRuns[0].deckType, 'Guardian Other')
    assertEqual((await submit(151, 15)).status, 201)
    check('a corrected floor count reopens Other for the first specific archetype', () => {
      assertEqual(thresholdServer.store.leaderboardRuns[0].floorsCleared, 15)
      assertEqual(thresholdServer.store.leaderboardRuns[0].deckType, undefined)
      assertEqual(thresholdServer.store.leaderboardRuns[1].deckType, 'Guardian Other')
    })
  } finally { await thresholdServer.close() }
  check('Other survives restart but newly floor-15 runs remain unclassified', () => {
    const persisted = createStore({ file: thresholdFile })
    assertDeepEqual(persisted.leaderboardRuns.map((entry) => entry.deckType), [undefined, 'Guardian Other', undefined])
    assert(persisted.deckTypes.includes('Guardian Other'))
  })
  const thresholdCalls = []
  const firstSpecificServer = createRoomServer({ storeFile: thresholdFile, classifierEnabled: true,
    deckClassifier: async (_entry, types) => {
      thresholdCalls.push([...types])
      return 'Guardian Prismatic Defense'
    } })
  try {
    await firstSpecificServer.listen(0)
    for (let attempt = 0; attempt < 40 && !firstSpecificServer.store.leaderboardRuns[2]?.deckType; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    check('the first floor-15 deck creates a specific type even after shallow Other decks', () => {
      assertDeepEqual(thresholdCalls[0].filter((name) => name.startsWith('Guardian ')), ['Guardian Other'])
      assertEqual(firstSpecificServer.store.leaderboardRuns[0].deckType, 'Guardian Prismatic Defense')
      assertEqual(firstSpecificServer.store.leaderboardRuns[1].deckType, 'Guardian Other')
      assertEqual(firstSpecificServer.store.leaderboardRuns[2].deckType, 'Guardian Prismatic Defense')
    })
  } finally { await firstSpecificServer.close() }
  check('the first specific archetype replaces archived Other across another restart', () => {
    const restored = createStore({ file: thresholdFile })
    assertEqual(restored.leaderboardRuns[0].deckType, 'Guardian Prismatic Defense')
    assertEqual(restored.leaderboardRuns[1].deckType, 'Guardian Other')
    assertEqual(restored.leaderboardRuns[2].deckType, 'Guardian Prismatic Defense')
  })
  const invalidLowServer = createRoomServer({ storeFile: thresholdFile, classifierEnabled: true,
    maxDeckClassificationsPerDay: 3, deckClassifier: async () => 'Guardian Unseeded Combo' })
  try {
    const address = await invalidLowServer.listen(0)
    assertEqual((await fetch(`http://127.0.0.1:${address.port}/api/leaderboard`, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(run(155, { character: 'guardian', floorsCleared: 14,
        finalDeck: [{ defId: 'guardian_prismatic_barrier', upgraded: false }] })) })).status, 201)
    for (let attempt = 0; attempt < 40 && invalidLowServer.store.deckClassificationBudget.used < 3; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    check('server cannot invent a specific archetype for a shallow deck even with a faulty classifier', () => {
      assertEqual(invalidLowServer.store.leaderboardRuns[3].deckType, undefined)
      assert(!invalidLowServer.store.deckTypes.includes('Guardian Unseeded Combo'))
    })
  } finally { await invalidLowServer.close() }
  const invalidFirstServer = createRoomServer({ classifierEnabled: true, maxDeckClassificationsPerDay: 1,
    deckClassifier: async () => 'Guardian Other' })
  try {
    const address = await invalidFirstServer.listen(0)
    assertEqual((await fetch(`http://127.0.0.1:${address.port}/api/leaderboard`, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(run(154, { character: 'guardian', floorsCleared: 15,
        finalDeck: [{ defId: 'guardian_strike', upgraded: false }] })) })).status, 201)
    for (let attempt = 0; attempt < 40 && invalidFirstServer.store.deckClassificationBudget.used < 1; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    await new Promise((resolve) => setTimeout(resolve, 20))
    check('server rejects an Other response for the first floor-15 deck even from a faulty classifier', () => {
      assertEqual(invalidFirstServer.store.leaderboardRuns[0].deckType, undefined)
      assert(!invalidFirstServer.store.deckTypes.includes('Guardian Other'))
      assertEqual(invalidFirstServer.store.deckClassificationBudget.used, 1)
    })
  } finally { await invalidFirstServer.close() }
  const staleOtherFile = join(directory, 'stale-other.json')
  const staleOtherStore = createStore({ file: staleOtherFile })
  addLeaderboardRun(staleOtherStore, run(156, { character: 'guardian', floorsCleared: 15,
    finalDeck: [{ defId: 'guardian_prismatic_barrier', upgraded: false }] }))
  staleOtherStore.leaderboardRuns[0].deckType = 'Guardian Other'
  staleOtherStore.deckTypes.push('Guardian Other')
  staleOtherStore.statsStateDirty = true
  saveStore(staleOtherStore)
  const staleOtherServer = createRoomServer({ storeFile: staleOtherFile, classifierEnabled: false })
  try {
    await staleOtherServer.listen(0)
    check('a first deep deck previously labeled Other is reopened without Codex login', () =>
      assertEqual(staleOtherServer.store.leaderboardRuns[0].deckType, undefined))
  } finally { await staleOtherServer.close() }
  check('clearing stale Other remains durable in the leaderboard archive after restart', () =>
    assertEqual(createStore({ file: staleOtherFile }).leaderboardRuns[0].deckType, undefined))
  const unavailableFile = join(directory, 'unavailable.json')
  const unavailableStore = createStore({ file: unavailableFile })
  addLeaderboardRun(unavailableStore, run(68))
  addLeaderboardRun(unavailableStore, run(69))
  saveStore(unavailableStore)
  let unavailableCalls = 0
  const unavailableServer = createRoomServer({ storeFile: unavailableFile, classifierEnabled: true,
    deckClassifier: async () => { unavailableCalls += 1
      throw Object.assign(new Error('Codex login expired'), { code: 'classifier_unavailable' }) } })
  try {
    await unavailableServer.listen(0)
    for (let attempt = 0; attempt < 40 && !unavailableCalls; attempt++) await new Promise((resolve) => setTimeout(resolve, 10))
    await new Promise((resolve) => setTimeout(resolve, 40))
    check('expired Codex auth stops an active backlog and refunds the attempt', () => {
      assertEqual(unavailableCalls, 1)
      assertEqual(unavailableServer.store.deckClassificationBudget.used, 0)
      assertEqual(unavailableServer.store.leaderboardRuns[1].deckType, undefined)
    })
  } finally { await unavailableServer.close() }

  let resolveHeld
  let signalHeld
  const held = new Promise((resolve) => { resolveHeld = resolve })
  const started = new Promise((resolve) => { signalHeld = resolve })
  const heldFile = join(directory, 'held.json')
  const heldServer = createRoomServer({ storeFile: heldFile, classifierEnabled: true, deckClassifier: async () => {
    signalHeld()
    await held
    return 'Defect Lightning Orb Focus'
  } })
  try {
    const heldAddress = await heldServer.listen(0)
    assertEqual((await fetch(`http://127.0.0.1:${heldAddress.port}/api/leaderboard`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(run(29)) })).status, 201)
    await Promise.race([started, new Promise((_resolve, reject) => setTimeout(() => reject(new Error('Classifier did not start')), 1500))])
    check('the attempt is persisted before the model request can finish', () => {
      assertEqual(createStore({ file: heldFile }).deckClassificationBudget.used, 1)
    })
  } finally { resolveHeld(); await heldServer.close() }

  let writes = 0
  let paidCalls = 0
  let cannotWrite = true
  const unwritable = createRoomServer({ storeFile: join(directory, 'unwritable.json'), classifierEnabled: true,
    saveStoreImpl: (entry) => { writes += 1; if (cannotWrite) throw new Error('simulated full disk'); saveStore(entry) },
    onSaveError: () => {}, deckClassifier: async () => { paidCalls += 1; return 'Defect Lightning Orb Focus' } })
  try {
    const unwritableAddress = await unwritable.listen(0)
    assertEqual((await fetch(`http://127.0.0.1:${unwritableAddress.port}/api/leaderboard`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(run(30)) })).status, 201)
    for (let attempt = 0; attempt < 40 && !writes; attempt++) await new Promise((resolve) => setTimeout(resolve, 10))
    check('a failed budget write blocks the paid call and does not consume the cap', () => {
      assert(writes > 0)
      assertEqual(paidCalls, 0)
      assertEqual(unwritable.store.deckClassificationBudget.used, 0)
    })
  } finally { cannotWrite = false; await unwritable.close() }

  let releaseUpdate
  let signalUpdate
  const waiting = new Promise((resolve) => { releaseUpdate = resolve })
  const updating = new Promise((resolve) => { signalUpdate = resolve })
  let updateCalls = 0
  const updateServer = createRoomServer({ classifierEnabled: true, deckClassifier: async () => {
    updateCalls += 1
    signalUpdate()
    await waiting
    return 'Defect Lightning Orb Focus'
  } })
  try {
    const updateAddress = await updateServer.listen(0)
    const endpoint = `http://127.0.0.1:${updateAddress.port}/api/leaderboard`
    const post = (value) => fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })
    assertEqual((await post(run(31, { floorsCleared: null }))).status, 201)
    await Promise.race([updating, new Promise((_resolve, reject) => setTimeout(() => reject(new Error('Classifier did not start')), 1500))])
    assertEqual((await post(run(31, { floorsCleared: 26 }))).status, 201)
    releaseUpdate()
    for (let attempt = 0; attempt < 40 && !updateServer.store.leaderboardRuns[0].deckType; attempt++) await new Promise((resolve) => setTimeout(resolve, 10))
    check('duplicate run updates retain the result of an in-flight classification', () => {
      assertEqual(updateCalls, 1)
      assertEqual(updateServer.store.leaderboardRuns[0].floorsCleared, 26)
      assertEqual(updateServer.store.leaderboardRuns[0].deckType, 'Defect Lightning Orb Focus')
    })
  } finally { releaseUpdate(); await updateServer.close() }

  let releaseHero
  let signalHero
  const heldHero = new Promise((resolve) => { releaseHero = resolve })
  const heroStarted = new Promise((resolve) => { signalHero = resolve })
  let heroCalls = 0
  const heroServer = createRoomServer({ classifierEnabled: true, deckClassifier: async (entry) => {
    heroCalls += 1
    if (heroCalls === 1) { signalHero(); await heldHero }
    return entry.character === 'ironclad' ? 'Ironclad Barricade Body Slam' : 'Defect Lightning Orb Focus'
  } })
  try {
    const address = await heroServer.listen(0)
    const endpoint = `http://127.0.0.1:${address.port}/api/leaderboard`
    assertEqual((await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(run(52)) })).status, 201)
    await Promise.race([heroStarted, new Promise((_resolve, reject) => setTimeout(() => reject(new Error('Hero classifier did not start')), 1500))])
    addLeaderboardRun(heroServer.store, run(52, { character: 'ironclad', finalDeck: undefined, winningDecks: [
      { username: 'Room Owner', character: 'ironclad', finalDeck: run(52).finalDeck },
    ] }))
    releaseHero()
    for (let attempt = 0; attempt < 40 && !heroServer.store.leaderboardRuns[0].deckType; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    check('an in-flight result cannot assign the previous hero archetype after rearchive', () => {
      assertEqual(heroCalls, 2)
      assertEqual(heroServer.store.leaderboardRuns[0].deckType, 'Ironclad Barricade Body Slam')
    })
  } finally { releaseHero(); await heroServer.close() }

  const changedHeroCalls = []
  const changedHeroServer = createRoomServer({ classifierEnabled: true, deckClassifier: async (entry) => {
    changedHeroCalls.push(entry.character)
    if (entry.character === 'defect') throw new Error('Expected classification failure')
    return 'Ironclad Barricade Body Slam'
  } })
  try {
    const address = await changedHeroServer.listen(0)
    const endpoint = `http://127.0.0.1:${address.port}/api/leaderboard`
    const submit = (entry) => fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(entry) })
    assertEqual((await submit(run(53))).status, 201)
    for (let attempt = 0; attempt < 40 && !changedHeroCalls.length; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    changedHeroServer.store.leaderboardRuns[0].deckClassificationRetry = {
      after: Date.now() + 86_400_000, hash: deckHash(changedHeroServer.store.leaderboardRuns[0]),
    }
    addLeaderboardRun(changedHeroServer.store, run(53, { character: 'ironclad', finalDeck: undefined, winningDecks: [
      { username: 'Room Owner', character: 'ironclad', finalDeck: run(53).finalDeck },
    ] }))
    assertEqual(changedHeroServer.store.leaderboardRuns[0].deckClassificationRetry, undefined)
    assertEqual((await submit(run(54, { finalDeck: undefined }))).status, 201)
    for (let attempt = 0; attempt < 40 && !changedHeroServer.store.leaderboardRuns[0].deckType; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    check('changing hero invalidates a previous hero retry for the same deck', () => {
      assertDeepEqual(changedHeroCalls, ['defect', 'ironclad'])
      assertEqual(changedHeroServer.store.leaderboardRuns[0].deckType, 'Ironclad Barricade Body Slam')
    })
  } finally { await changedHeroServer.close() }

  const failedId = run(21).id
  const attempts = []
  let releaseThird
  let signalThird
  const heldThird = new Promise((resolve) => { releaseThird = resolve })
  const startedThird = new Promise((resolve) => { signalThird = resolve })
  const failureServer = createRoomServer({ classifierEnabled: true, deckClassifier: async (entry) => {
    attempts.push(entry.id)
    if (entry.id === failedId) throw new Error('expected classifier failure')
    if (entry.id === run(23).id) { signalThird(); await heldThird }
    return 'Defect Lightning Orb Focus'
  } })
  try {
    const failureAddress = await failureServer.listen(0)
    const endpoint = `http://127.0.0.1:${failureAddress.port}/api/leaderboard`
    const submit = (id) => fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(run(id)) })
    assertEqual((await submit(21)).status, 201)
    for (let attempt = 0; attempt < 40 && !attempts.length; attempt++) await new Promise((resolve) => setTimeout(resolve, 10))
    assertEqual((await submit(22)).status, 201)
    for (let attempt = 0; attempt < 40 && !failureServer.store.leaderboardRuns[1]?.deckType; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    check('a failed deck waits for retry without blocking a later submission', () => {
      assertDeepEqual(attempts, [failedId, run(22).id])
      assertEqual(failureServer.store.leaderboardRuns[1].deckType, 'Defect Lightning Orb Focus')
      assertEqual(failureServer.store.leaderboardRuns[0].deckType, undefined)
    })
    failureServer.store.leaderboardRuns[0].finalDeck = []
    const originalNow = Date.now
    const originalSetTimeout = globalThis.setTimeout
    let immediateTimers = 0
    try {
      let offset = 30_000
      Date.now = () => originalNow() + offset
      globalThis.setTimeout = (callback, delay, ...args) => {
        if (delay === 0) immediateTimers += 1
        return originalSetTimeout(callback, delay, ...args)
      }
      assertEqual((await submit(23)).status, 201)
      await Promise.race([startedThird, new Promise((_resolve, reject) => originalSetTimeout(() => reject(new Error('Third classifier did not start')), 1500))])
      offset = 61_000
      releaseThird()
      for (let attempt = 0; attempt < 40 && !failureServer.store.leaderboardRuns[2]?.deckType; attempt++)
        await new Promise((resolve) => originalSetTimeout(resolve, 10))
      await new Promise((resolve) => originalSetTimeout(resolve, 100))
      check('failed decks made ineligible are pruned instead of spinning zero-delay retries', () => {
        assertEqual(failureServer.store.leaderboardRuns[2].deckType, 'Defect Lightning Orb Focus')
        assert(immediateTimers < 10, `expected no timer loop, scheduled ${immediateTimers} immediate retries`)
      })
    } finally { releaseThird(); Date.now = originalNow; globalThis.setTimeout = originalSetTimeout }
  } finally { releaseThird(); await failureServer.close() }

  const firstTurnFile = join(directory, 'first-turn.json')
  let failedFirstTurnStarted = false
  const firstTurnServer = createRoomServer({ storeFile: firstTurnFile, classifierEnabled: true,
    deckClassifier: async () => {
      failedFirstTurnStarted = true
      throw Object.assign(new Error('first-turn timeout'), { threadId, code: 'ABORT_ERR' })
    } })
  try {
    const address = await firstTurnServer.listen(0)
    assertEqual((await fetch(`http://127.0.0.1:${address.port}/api/leaderboard`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(run(73)) })).status, 201)
    for (let attempt = 0; attempt < 40 && !failedFirstTurnStarted; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10))
  } finally { await firstTurnServer.close() }
  check('timed-out first turns persist their Codex thread before the next server startup', () => {
    assertEqual(failedFirstTurnStarted, true)
    assertEqual(createStore({ file: firstTurnFile }).deckClassifierThreadId, threadId)
  })
  let resumedFirstTurn
  const firstTurnRetry = createRoomServer({ storeFile: firstTurnFile, classifierEnabled: true,
    deckClassifier: async (_entry, _types, currentThreadId) => {
      resumedFirstTurn = currentThreadId
      return { type: 'Defect Mixed Orb', threadId }
    } })
  try {
    await firstTurnRetry.listen(0)
    for (let attempt = 0; attempt < 40 && !resumedFirstTurn; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    check('a restarted classifier resumes the thread created by a failed first turn', () =>
      assertEqual(resumedFirstTurn, threadId))
  } finally { await firstTurnRetry.close() }

  const sessionsFile = join(directory, 'codex-sessions.json')
  const resumedThreads = []
  const classifySessions = async (_entry, _types, currentThreadId) => {
    resumedThreads.push(currentThreadId)
    return { type: 'Defect Lightning Orb Focus', threadId }
  }
  let sessionsServer = createRoomServer({ storeFile: sessionsFile, classifierEnabled: true, deckClassifier: classifySessions })
  try {
    const address = await sessionsServer.listen(0)
    const endpoint = `http://127.0.0.1:${address.port}/api/leaderboard`
    const submit = (id) => fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(run(id)) })
    assertEqual((await submit(48)).status, 201)
    for (let attempt = 0; attempt < 40 && !sessionsServer.store.leaderboardRuns[0]?.deckType; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    await sessionsServer.close()
    check('Codex thread ID survives server restart in private stats state', () => {
      assertEqual(createStore({ file: sessionsFile }).deckClassifierThreadId, threadId)
      assertEqual(JSON.parse(readFileSync(`${sessionsFile}.stats.json`, 'utf8')).deckClassifierThreadId, threadId)
    })
    sessionsServer = createRoomServer({ storeFile: sessionsFile, classifierEnabled: true, deckClassifier: classifySessions })
    const resumed = await sessionsServer.listen(0)
    const resumeEndpoint = `http://127.0.0.1:${resumed.port}/api/leaderboard`
    assertEqual((await fetch(resumeEndpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(run(49)) })).status, 201)
    for (let attempt = 0; attempt < 40 && !sessionsServer.store.leaderboardRuns[1]?.deckType; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    check('subsequent decks resume the same Codex thread', () => {
      assertDeepEqual(resumedThreads, [undefined, threadId])
      assertEqual(sessionsServer.store.deckClassificationBudget.used, 2)
    })
    await sessionsServer.close()
    let resumedFailure = false
    sessionsServer = createRoomServer({ storeFile: sessionsFile, classifierEnabled: true,
      deckClassifier: async (_entry, _types, currentThreadId) => {
        resumedFailure = true
        assertEqual(currentThreadId, threadId)
        throw new Error('Temporary network failure')
      } })
    const failing = await sessionsServer.listen(0)
    assertEqual((await fetch(`http://127.0.0.1:${failing.port}/api/leaderboard`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(run(50)) })).status, 201)
    for (let attempt = 0; attempt < 40 && !resumedFailure; attempt++) await new Promise((resolve) => setTimeout(resolve, 10))
    await sessionsServer.close()
    check('transient failures preserve a resumable Codex thread', () => {
      assertEqual(resumedFailure, true)
      assertEqual(createStore({ file: sessionsFile }).deckClassifierThreadId, threadId)
    })
    let staleFailure = false
    sessionsServer = createRoomServer({ storeFile: sessionsFile, classifierEnabled: true,
      deckClassifier: async (_entry, _types, currentThreadId) => {
        staleFailure = true
        assertEqual(currentThreadId, threadId)
        throw Object.assign(new Error('Codex session unavailable'), { code: 'stale_thread' })
      } })
    await sessionsServer.listen(0)
    for (let attempt = 0; attempt < 40 && !staleFailure; attempt++) await new Promise((resolve) => setTimeout(resolve, 10))
    await sessionsServer.close()
    check('only genuinely stale resumed sessions clear their ID', () => {
      assertEqual(staleFailure, true)
      assertEqual(createStore({ file: sessionsFile }).deckClassifierThreadId, undefined)
    })
    const legacyStats = JSON.parse(readFileSync(`${sessionsFile}.stats.json`, 'utf8'))
    legacyStats.deckClassifierThreadId = threadId
    legacyStats.deckClassifierRelease = 'previous-release'
    writeFileSync(`${sessionsFile}.stats.json`, JSON.stringify(legacyStats))
    const nextRelease = createRoomServer({ storeFile: sessionsFile, classifierEnabled: false })
    try {
      check('deployment changes start a new thread against the new codebase', () => assertEqual(nextRelease.store.deckClassifierThreadId, undefined))
    } finally { await nextRelease.close() }
  } finally { await sessionsServer.close() }

  const roomRetryFile = join(directory, 'room-retry.json')
  const roomRetryStore = createStore({ file: roomRetryFile })
  const finalizedRoom = createRoom(roomRetryStore, { code: 'RETRY1' })
  const roomOwner = joinRoom(finalizedRoom, { name: 'Saved Player', character: 'defect' })
  startRun(finalizedRoom, roomOwner.token, { seed: 314 })
  finalizedRoom.run = { ...finalizedRoom.run, phase: 'defeat',
    campaign: { ...finalizedRoom.run.campaign, finalized: true } }
  saveStore(roomRetryStore)
  let roomRetryCalls = 0
  const openRoomReplay = async () => {
    const service = createRoomServer({ storeFile: roomRetryFile, classifierEnabled: true, deckClassifier: async () => {
      roomRetryCalls += 1
      if (roomRetryCalls === 1) throw new Error('Temporary Codex failure')
      return 'Defect Mixed Orb'
    } })
    await service.listen(0)
    return service
  }
  let replayServer
  try {
    replayServer = await openRoomReplay()
    for (let attempt = 0; attempt < 40 && !roomRetryCalls; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    assertEqual(replayServer.store.leaderboardRuns[0]?.deckType, undefined)
    await replayServer.close()
    replayServer = await openRoomReplay()
    for (let attempt = 0; attempt < 40 && !replayServer.store.leaderboardRuns[0]?.deckType; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    await replayServer.close()
    replayServer = await openRoomReplay()
    await new Promise((resolve) => setTimeout(resolve, 30))
    check('replaying a finalized solo room retries once across restarts without reclassifying it again', () => {
      assertEqual(roomRetryCalls, 2)
      assertEqual(replayServer.store.leaderboardRuns[0]?.deckType, 'Defect Mixed Orb')
    })
  } finally { if (replayServer) await replayServer.close() }

  let notifyStarted
  let inFlightSignal
  const modelStarted = new Promise((resolve) => { notifyStarted = resolve })
  const closingServer = createRoomServer({ classifierEnabled: true, deckClassifier: async (_entry, _types, _threadId, _spawn, signal) => {
    inFlightSignal = signal
    notifyStarted()
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Model request cancelled')), { once: true }))
  } })
  try {
    const address = await closingServer.listen(0)
    assertEqual((await fetch(`http://127.0.0.1:${address.port}/api/leaderboard`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(run(39)) })).status, 201)
    await Promise.race([modelStarted, new Promise((_resolve, reject) => setTimeout(() => reject(new Error('Model request did not start')), 1500))])
    await Promise.race([closingServer.close(), new Promise((_resolve, reject) => setTimeout(() => reject(new Error('Model request outlived shutdown')), 1500))])
    check('shutdown aborts and settles an in-flight paid model request', () => assert(inFlightSignal.aborted))
  } finally { await closingServer.close() }
} finally {
  if (server) await server.close()
  rmSync(directory, { recursive: true, force: true })
}
report('stats explorer')
