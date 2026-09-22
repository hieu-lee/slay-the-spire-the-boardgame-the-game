#!/usr/bin/env node
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CARDS } from '../src/game/cards.ts'
import { addLeaderboardRun, normalizeLeaderboardRun } from './lib/leaderboard.mjs'
import { createRoom, createStore, joinRoom, saveStore, startRun } from './lib/rooms.mjs'
import { classifyDeckType, deckHash, INITIAL_DECK_TYPES, randomDeck, statsSnapshot } from './lib/stats.mjs'
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

check('seed taxonomy covers every playable hero', () => {
  for (const hero of ['Ironclad', 'Silent', 'Defect', 'Watcher', 'Slime Boss', 'Guardian', 'Hexaghost', 'Hermit'])
    assert(INITIAL_DECK_TYPES.some((name) => name.startsWith(`${hero} `)))
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
  const rollbackServer = createRoomServer({ storeFile: rollbackFile, openAiKey: 'local-test-key', deckClassifier: async () => {
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
  const recoveredStatsServer = createRoomServer({ storeFile: rollbackFile, openAiKey: '' })
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
  const deferredServer = createRoomServer({ storeFile: deferredFile, openAiKey: 'local-test-key',
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

  let payload
  const type = await classifyDeckType(normalizeLeaderboardRun(run(6)), INITIAL_DECK_TYPES, 'private-key', async (url, options) => {
    payload = { url, options }
    return { ok: true, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ name: 'Defect Lightning Orb Focus' }) }] }] }) }
  })
  check('classifier calls GPT-6 Sol with high reasoning only from the server', () => {
    assertEqual(type, 'Defect Lightning Orb Focus')
    assertEqual(payload.url, 'https://api.openai.com/v1/responses')
    assertEqual(JSON.parse(payload.options.body).model, 'gpt-6-sol')
    assertEqual(JSON.parse(payload.options.body).reasoning.effort, 'high')
    assertEqual(JSON.parse(payload.options.body).store, false)
    assertEqual(JSON.parse(payload.options.body).max_output_tokens, 25_000)
    assert(JSON.parse(JSON.parse(payload.options.body).input).cards.some((card) => card.name === 'Dual Cast'))
    assertEqual(payload.options.headers.authorization, 'Bearer private-key')
  })
  let incompleteError
  try {
    await classifyDeckType(archive[0], INITIAL_DECK_TYPES, 'private-key', async () => ({ ok: true, json: async () => ({
      status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [],
    }) }))
  } catch (error) { incompleteError = error }
  check('model output exhaustion is distinguished from transient errors', () => assertEqual(incompleteError?.code, 'max_output_tokens'))
  let abilityCards
  await classifyDeckType(normalizeLeaderboardRun(run(46, { character: 'ironclad', finalDeck: [
    { defId: 'barricade', upgraded: false }, { defId: 'heavy_blade', upgraded: true },
  ] })), INITIAL_DECK_TYPES, 'private-key', async (_url, options) => {
    abilityCards = JSON.parse(JSON.parse(options.body).input).cards
    return { ok: true, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: '{"name":"Ironclad Barricade Body Slam"}' }] }] }) }
  })
  check('classification retains card abilities and effect amounts, not just effect names', () => {
    assert(abilityCards.find((card) => card.name === 'Barricade').rules.includes('"retainBlock":true'))
    const heavy = abilityCards.find((card) => card.name === 'Heavy Blade+')
    assert(heavy.rules.includes('"per":"strength"') && heavy.rules.includes('"scale":4'))
  })
  const guardianPayload = async (gemId) => {
    let cards
    const guardianRun = normalizeLeaderboardRun(run(25, { character: 'guardian', finalDeck: [
      { defId: 'guardian_prismatic_barrier', upgraded: true, attachedGemId: gemId },
    ] }))
    await classifyDeckType(guardianRun, INITIAL_DECK_TYPES, 'private-key', async (_url, options) => {
      cards = JSON.parse(JSON.parse(options.body).input).cards
      return { ok: true, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: '{"name":"Guardian Socket Gems"}' }] }] }) }
    })
    return cards
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
  let upgradedPayload
  await classifyDeckType(normalizeLeaderboardRun(run(28, { finalDeck: [{ defId: 'dual_cast', upgraded: true }] })), INITIAL_DECK_TYPES, 'private-key', async (_url, options) => {
    upgradedPayload = JSON.parse(JSON.parse(options.body).input).cards
    return { ok: true, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: '{"name":"Defect Lightning Orb Focus"}' }] }] }) }
  })
  check('non-Guardian upgraded cards are named without duplicate plus signs', () => assertEqual(upgradedPayload[0].name, 'Dual Cast+'))
  let largeInput
  const largeDeck = normalizeLeaderboardRun(run(36, { finalDeck: Object.keys(CARDS).slice(0, 470).map((defId) => ({ defId, upgraded: false })) }))
  await classifyDeckType(largeDeck, INITIAL_DECK_TYPES, 'private-key', async (_url, options) => {
    largeInput = JSON.parse(options.body).input
    return { ok: true, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: '{"name":"Defect Lightning Orb Focus"}' }] }] }) }
  })
  check('unusually large public decks cannot send unbounded model input', () => {
    assert(largeInput.length <= 20_000)
    assert(JSON.parse(largeInput).cards.length <= 50)
    assert(JSON.parse(largeInput).omittedCards > 0)
    assertEqual(JSON.parse(largeInput).totalCards, 470)
  })

  const classifications = []
  const suppliedSignal = new AbortController()
  let forwardedSignal
  await classifyDeckType(archive[0], INITIAL_DECK_TYPES, 'private-key', async (_url, options) => {
    forwardedSignal = options.signal
    return { ok: true, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: '{"name":"Defect Lightning Orb Focus"}' }] }] }) }
  }, suppliedSignal.signal)
  check('deck classifier passes the supplied shutdown signal to its upstream request', () => assertEqual(forwardedSignal, suppliedSignal.signal))
  server = createRoomServer({ openAiKey: 'local-test-key', deckClassifier: async (entry, types, key) => {
    classifications.push({ id: entry.id, types: [...types], key })
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
    assertEqual(classifications[0].key, 'local-test-key')
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
  ] })), INITIAL_DECK_TYPES, 'private-key', async () => { invoked = true })
  const impossibleType = await classifyDeckType(normalizeLeaderboardRun(run(45, { finalDeck: [
    { defId: 'burn', upgraded: true },
  ] })), INITIAL_DECK_TYPES, 'private-key', async () => { invoked = true })
  check('unknown cards and impossible upgrades never reach the paid model', () => {
    assertEqual(invalidType, null)
    assertEqual(impossibleType, null)
    assertEqual(invoked, false)
  })

  const limitedFile = join(directory, 'budget.json')
  const limited = createRoomServer({ storeFile: limitedFile, openAiKey: 'local-test-key', maxDeckClassificationsPerDay: 1,
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

  let resolveHeld
  let signalHeld
  const held = new Promise((resolve) => { resolveHeld = resolve })
  const started = new Promise((resolve) => { signalHeld = resolve })
  const heldFile = join(directory, 'held.json')
  const heldServer = createRoomServer({ storeFile: heldFile, openAiKey: 'local-test-key', deckClassifier: async () => {
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
  const unwritable = createRoomServer({ storeFile: join(directory, 'unwritable.json'), openAiKey: 'local-test-key',
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
  const updateServer = createRoomServer({ openAiKey: 'local-test-key', deckClassifier: async () => {
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
  const heroServer = createRoomServer({ openAiKey: 'local-test-key', deckClassifier: async (entry) => {
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
  const changedHeroServer = createRoomServer({ openAiKey: 'local-test-key', deckClassifier: async (entry) => {
    changedHeroCalls.push(entry.character)
    if (entry.character === 'defect') throw Object.assign(new Error('Expected output limit'), { code: 'max_output_tokens' })
    return 'Ironclad Barricade Body Slam'
  } })
  try {
    const address = await changedHeroServer.listen(0)
    const endpoint = `http://127.0.0.1:${address.port}/api/leaderboard`
    const submit = (entry) => fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(entry) })
    assertEqual((await submit(run(53))).status, 201)
    for (let attempt = 0; attempt < 40 && !changedHeroServer.store.leaderboardRuns[0]?.deckClassificationRetry; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    assert(changedHeroServer.store.leaderboardRuns[0]?.deckClassificationRetry)
    addLeaderboardRun(changedHeroServer.store, run(53, { character: 'ironclad', finalDeck: undefined, winningDecks: [
      { username: 'Room Owner', character: 'ironclad', finalDeck: run(53).finalDeck },
    ] }))
    assertEqual(changedHeroServer.store.leaderboardRuns[0].deckClassificationRetry, undefined)
    assertEqual((await submit(run(54, { finalDeck: undefined }))).status, 201)
    for (let attempt = 0; attempt < 40 && !changedHeroServer.store.leaderboardRuns[0].deckType; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    check('changing hero invalidates the previous hero next-day retry for the same deck', () => {
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
  const failureServer = createRoomServer({ openAiKey: 'local-test-key', deckClassifier: async (entry) => {
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

  const originalClock = Date.now
  let clock = Math.floor(originalClock() / 86_400_000) * 86_400_000 + 12 * 60 * 60_000
  const exhaustedId = run(48).id
  const exhaustionCalls = []
  const exhaustedFile = join(directory, 'exhausted.json')
  const classifyExhausted = async (entry) => {
    exhaustionCalls.push(entry.id)
    if (entry.id === exhaustedId && entry.finalDeck?.[0]?.defId === 'dual_cast')
      throw Object.assign(new Error('Expected output limit'), { code: 'max_output_tokens' })
    return 'Defect Lightning Orb Focus'
  }
  let exhaustedServer = createRoomServer({ storeFile: exhaustedFile, openAiKey: 'local-test-key', deckClassifier: classifyExhausted })
  try {
    Date.now = () => clock
    const address = await exhaustedServer.listen(0)
    const endpoint = `http://127.0.0.1:${address.port}/api/leaderboard`
    const submit = (id) => fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(run(id)) })
    assertEqual((await submit(48)).status, 201)
    for (let attempt = 0; attempt < 40 && !exhaustionCalls.length; attempt++) await new Promise((resolve) => setTimeout(resolve, 10))
    check('an exhausted model response persists its deck-specific retry time before restart', () => {
      const retry = createStore({ file: exhaustedFile }).leaderboardRuns[0].deckClassificationRetry
      assertEqual(retry?.after, clock - clock % 86_400_000 + 86_400_000)
      assertEqual(retry?.hash.length, 64)
    })
    await exhaustedServer.close()
    clock += 61_000
    exhaustedServer = createRoomServer({ storeFile: exhaustedFile, openAiKey: 'local-test-key', deckClassifier: classifyExhausted })
    const resumed = await exhaustedServer.listen(0)
    const resumeEndpoint = `http://127.0.0.1:${resumed.port}/api/leaderboard`
    assertEqual((await fetch(resumeEndpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(run(49)) })).status, 201)
    for (let attempt = 0; attempt < 40 && !exhaustedServer.store.leaderboardRuns[1]?.deckType; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    check('output exhaustion survives restart without blocking other decks', () => {
      assertDeepEqual(exhaustionCalls, [exhaustedId, run(49).id])
      assertEqual(exhaustedServer.store.leaderboardRuns[1].deckType, 'Defect Lightning Orb Focus')
      assertEqual(exhaustedServer.store.deckClassificationBudget.used, 2)
    })
    addLeaderboardRun(exhaustedServer.store, run(48, { finalDeck: undefined, winningDecks: [
      { username: 'Room Owner', character: 'defect', finalDeck: [{ defId: 'claw', upgraded: false }] },
    ] }))
    assertEqual((await fetch(resumeEndpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(run(50)) })).status, 201)
    for (let attempt = 0; attempt < 40 && !exhaustedServer.store.leaderboardRuns[0]?.deckType; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    check('an authoritative deck replacement clears a deferred classification', () => {
      assertEqual(exhaustedServer.store.leaderboardRuns[0].deckType, 'Defect Lightning Orb Focus')
      assertEqual(exhaustedServer.store.leaderboardRuns[0].deckClassificationRetry, undefined)
    })
  } finally { Date.now = originalClock; await exhaustedServer.close() }

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
    const service = createRoomServer({ storeFile: roomRetryFile, openAiKey: 'local-test-key', deckClassifier: async () => {
      roomRetryCalls += 1
      throw Object.assign(new Error('Expected output limit'), { code: 'max_output_tokens' })
    } })
    await service.listen(0)
    return service
  }
  let replayServer
  try {
    replayServer = await openRoomReplay()
    for (let attempt = 0; attempt < 40 && !replayServer.store.leaderboardRuns[0]?.deckClassificationRetry; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    assert(replayServer.store.leaderboardRuns[0]?.deckClassificationRetry)
    await replayServer.close()
    replayServer = await openRoomReplay()
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert(replayServer.store.leaderboardRuns[0]?.deckClassificationRetry)
    await replayServer.close()
    replayServer = await openRoomReplay()
    await new Promise((resolve) => setTimeout(resolve, 30))
    check('replaying a finalized solo room across two restarts retains its paid retry deferral', () => {
      assertEqual(roomRetryCalls, 1)
      assert(replayServer.store.leaderboardRuns[0]?.deckClassificationRetry)
    })
  } finally { if (replayServer) await replayServer.close() }

  let notifyStarted
  let inFlightSignal
  const modelStarted = new Promise((resolve) => { notifyStarted = resolve })
  const closingServer = createRoomServer({ openAiKey: 'local-test-key', deckClassifier: async (_entry, _types, _key, _fetch, signal) => {
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
