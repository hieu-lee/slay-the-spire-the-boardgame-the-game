#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addLeaderboardRun, dailyLeaderboard, leaderboardSnapshot, mergeLeaderboardRuns, restoreLeaderboardRuns, normalizeLeaderboardRun, roomLeaderboardRun, winningDecksPage } from './lib/leaderboard.mjs'
import { createRoom, createStore, joinRoom, saveStore, startRun } from './lib/rooms.mjs'
import { createRoomServer } from './room-server.mjs'
import { materializeLeaderboardArchive } from '../infra/validate-room-store.mjs'
import { assert, assertDeepEqual, assertEqual, assertThrows, check, report, suite } from './lib/harness.mjs'

suite('leaderboard')

const run = (overrides = {}) => ({
  id: 'browser-1234:campaign-1',
  character: 'ironclad',
  ascension: 3,
  mode: 'standard',
  damageStatsComplete: true,
  startedAtAct: 1,
  highestBossActDefeated: 3,
  combatsFinished: 10,
  damageDealt: 100,
  damageTaken: 30,
  damageBlocked: 70,
  floorsCleared: 20,
  ...overrides,
})

check('legacy runs never mix incomplete damage history into averages', () => {
  const snapshot = leaderboardSnapshot([
    normalizeLeaderboardRun(run(), 1),
    normalizeLeaderboardRun(run({ id: 'browser-1234:legacy', damageStatsComplete: false, combatsFinished: 1, damageDealt: 999_999, floorsCleared: null }), 2),
  ])
  assertEqual(snapshot.totalRuns, 2)
  assertEqual(snapshot.rows[0].averageDamagePerFight, 10)
  assertEqual(snapshot.rows[0].averageFloorsCleared, 20)
})

check('submissions are validated at the public boundary', () => {
  assertThrows(() => normalizeLeaderboardRun(run({ character: 'cheater' })))
  assertThrows(() => normalizeLeaderboardRun(run({ ascension: 14 })))
  assertThrows(() => normalizeLeaderboardRun(run({ damageBlocked: -1 })))
  assertThrows(() => normalizeLeaderboardRun(run({ combatsFinished: 1.5 })))
  assertThrows(() => normalizeLeaderboardRun(run({ floorsCleared: -1 })))
  assertThrows(() => normalizeLeaderboardRun(run({ winningDecks: [{
    username: 'x'.repeat(25), character: 'ironclad', finalDeck: [],
  }] })))
})

const daily = (overrides = {}) => run({ mode: 'daily', ascension: 10, dailyDate: '2026-09-28', highestBossActDefeated: 1, ...overrides })
const dailyTime = Date.parse('2026-09-28T12:00:00Z')

check('Daily Climb submissions must be solo A10 Act I runs on a real, current day', () => {
  assertEqual(normalizeLeaderboardRun(daily(), dailyTime).dailyDate, '2026-09-28')
  assertEqual(normalizeLeaderboardRun(daily({ dailyDate: '2026-09-29' }), dailyTime).dailyDate, '2026-09-29')
  assertThrows(() => normalizeLeaderboardRun(daily({ dailyDate: '2026-09-30' }), dailyTime))
  assertThrows(() => normalizeLeaderboardRun(daily({ dailyDate: '2026-02-30' }), dailyTime))
  assertThrows(() => normalizeLeaderboardRun(daily({ dailyDate: 20260928 }), dailyTime))
  assertThrows(() => normalizeLeaderboardRun(daily({ ascension: 9 }), dailyTime))
  assertThrows(() => normalizeLeaderboardRun(daily({ mode: 'standard' }), dailyTime))
  assertThrows(() => normalizeLeaderboardRun(daily({ startedAtAct: 2 }), dailyTime))
  assertThrows(() => normalizeLeaderboardRun(daily({ characters: ['ironclad', 'silent'] }), dailyTime))
  assertEqual(normalizeLeaderboardRun(daily({ floorsCleared: 50 }), dailyTime).floorsCleared, 50)
  assertThrows(() => normalizeLeaderboardRun(daily({ floorsCleared: 51 }), dailyTime))
  assertThrows(() => normalizeLeaderboardRun(daily({ floorsCleared: null }), dailyTime))
  const card = { defId: 'strike', upgraded: false }
  assertEqual(normalizeLeaderboardRun(daily({ finalDeck: Array(200).fill(card) }), dailyTime).finalDeck.length, 200)
  assertThrows(() => normalizeLeaderboardRun(daily({ finalDeck: Array(201).fill(card) }), dailyTime))
  assertEqual(normalizeLeaderboardRun(run(), dailyTime).dailyDate, undefined)
})

check('the daily ranking orders each named player\'s best climb by floors, damage, then finish time', () => {
  const deck = [{ defId: 'strike', upgraded: true }]
  const runs = [
    normalizeLeaderboardRun(daily({ id: 'install-a:campaign-1', username: 'Ann', floorsCleared: 12 }), dailyTime + 10),
    normalizeLeaderboardRun(daily({ id: 'install-a:campaign-2', username: 'ann', floorsCleared: 40, finalDeck: deck }), dailyTime + 20),
    normalizeLeaderboardRun(daily({ id: 'install-a:campaign-3', username: 'Ann', floorsCleared: 30 }), dailyTime + 30),
    normalizeLeaderboardRun(daily({ id: 'install-b:campaign-1', username: 'Bo', character: 'silent', floorsCleared: 12, damageDealt: 200 }), dailyTime + 30),
    normalizeLeaderboardRun(daily({ id: 'install-c:campaign-1', username: 'Cy', floorsCleared: 20, damageStatsComplete: false }), dailyTime + 40),
    normalizeLeaderboardRun(daily({ id: 'install-d:campaign-1', username: 'Di', floorsCleared: 12 }), dailyTime + 5),
    normalizeLeaderboardRun(daily({ id: 'install-g:campaign-1', floorsCleared: 50 }), dailyTime + 2),
    normalizeLeaderboardRun(daily({ id: 'install-e:campaign-1', username: 'Ed', dailyDate: '2026-09-27', floorsCleared: 50 }), dailyTime + 1),
    normalizeLeaderboardRun(run({ id: 'install-f:campaign-1', username: 'Fa', floorsCleared: 60 }), dailyTime + 1),
  ]
  const board = dailyLeaderboard(runs, '2026-09-28')
  assertEqual(board.total, 4, 'anonymous, other-day, non-daily or extra climbs were ranked')
  assertDeepEqual(board.rows.map((row) => [row.rank, row.username, row.floorsCleared]),
    [[1, 'ann', 40], [2, 'Cy', 20], [3, 'Bo', 12], [4, 'Di', 12]], 'a player\'s best climb is not their entry')
  assertDeepEqual(board.rows[0].cards, deck)
  assertEqual(board.rows[1].averageDamagePerFight, null)
  assertEqual(board.rows[2].character, 'silent')
  assertEqual(board.rows[2].averageDamagePerFight, 20)
  assertEqual(board.rows[2].damageBlockedRate, 0.7)
  assert(!JSON.stringify(board).includes('install-'), 'installation ids leaked into the public ranking')
  const silent = dailyLeaderboard(runs, '2026-09-28', ['silent'])
  assertDeepEqual(silent.rows.map((row) => [row.rank, row.username]), [[3, 'Bo']], 'a hero filter renumbered the ranking')
  assertEqual(silent.total, 1)
  assertThrows(() => dailyLeaderboard([], 'today'))
  assertThrows(() => dailyLeaderboard([], '2026-13-45'))
  assertThrows(() => dailyLeaderboard([], '2026-09-28', ['cheater']))
})

check('a Daily Climb keeps its day through a store restart and archive merge', () => {
  const saved = JSON.parse(JSON.stringify([normalizeLeaderboardRun(daily({ id: 'restore-a:campaign-1', username: 'Ann' }), dailyTime)]))
  const [restored] = restoreLeaderboardRuns(saved)
  assertEqual(restored.dailyDate, '2026-09-28')
  const [merged] = mergeLeaderboardRuns([{ ...restored, dailyDate: undefined }], [restored])
  assertEqual(merged.dailyDate, '2026-09-28')
  assertEqual(dailyLeaderboard([merged], '2026-09-28').rows[0].username, 'Ann')
})

check('a climb stored without its day by an older server gains it on retry', () => {
  const store = { leaderboardRuns: [], leaderboardRevision: 0 }
  const climb = daily({ id: 'skew-a:campaign-1', username: 'Ann' })
  const { dailyDate: _, ...withoutDay } = climb
  addLeaderboardRun(store, withoutDay, dailyTime)
  assertEqual(dailyLeaderboard(store.leaderboardRuns, '2026-09-28').total, 0)
  assertEqual(addLeaderboardRun(store, climb, dailyTime + 60_000), true, 'the retry did not add the day')
  assertEqual(store.leaderboardRuns.length, 1)
  assertEqual(store.leaderboardRuns[0].recordedAt, dailyTime, 'the retry replaced the first finish time')
  assertEqual(dailyLeaderboard(store.leaderboardRuns, '2026-09-28').rows[0]?.username, 'Ann')
})

check('a retry cannot move an old or non-daily run onto a daily board', () => {
  const store = { leaderboardRuns: [], leaderboardRevision: 0 }
  addLeaderboardRun(store, run({ id: 'skew-b:campaign-1', username: 'Bo', ascension: 0, floorsCleared: 900 }), Date.parse('2026-08-01T12:00:00Z'))
  addLeaderboardRun(store, run({ id: 'skew-b:campaign-2', username: 'Bo', mode: 'daily', ascension: 10, floorsCleared: 20 }), Date.parse('2026-08-01T12:00:00Z'))
  for (const id of ['skew-b:campaign-1', 'skew-b:campaign-2']) {
    addLeaderboardRun(store, daily({ id, username: 'Bo', floorsCleared: 1 }), dailyTime)
  }
  assertEqual(dailyLeaderboard(store.leaderboardRuns, '2026-09-28').total, 0, 'an old run was planted on today\'s board')
  assert(store.leaderboardRuns.every((entry) => entry.dailyDate === undefined))
  assertEqual(restoreLeaderboardRuns(JSON.parse(JSON.stringify(store.leaderboardRuns))).length, 2, 'a rejected backfill made a stored row unrestorable')
})

check('a climb that beat the boss outranks one that died at it on the same floor', () => {
  const board = dailyLeaderboard([
    normalizeLeaderboardRun(daily({ id: 'tie-a:campaign-1', username: 'Fell', floorsCleared: 32, highestBossActDefeated: 2, damageDealt: 900 }), dailyTime),
    normalizeLeaderboardRun(daily({ id: 'tie-b:campaign-1', username: 'Won', floorsCleared: 32, highestBossActDefeated: 3 }), dailyTime + 1),
    normalizeLeaderboardRun(daily({ id: 'tie-c:campaign-1', username: 'Deeper', floorsCleared: 33, highestBossActDefeated: 2 }), dailyTime + 2),
  ], '2026-09-28')
  assertDeepEqual(board.rows.map((row) => [row.rank, row.username, row.highestBossActDefeated]),
    [[1, 'Deeper', 2], [2, 'Won', 3], [3, 'Fell', 2]])
})

check('a hero filter reaches climbs beyond the overall top 100', () => {
  const crowd = Array.from({ length: 120 }, (_, index) => normalizeLeaderboardRun(daily({
    id: `crowd-${index}:campaign-1`, username: `Climber${index}`, character: index === 119 ? 'watcher' : 'ironclad', floorsCleared: 50 - Math.floor(index / 3),
  }), dailyTime + index))
  const board = dailyLeaderboard(crowd, '2026-09-28', ['watcher'])
  assertDeepEqual(board.rows.map((row) => [row.rank, row.username]), [[120, 'Climber119']])
  assertEqual(dailyLeaderboard(crowd, '2026-09-28').rows.length, 100)
})

check('losing submissions retain their final deck for future result views', () => {
  const finalDeck = [{ defId: 'strike', upgraded: false }]
  assertDeepEqual(normalizeLeaderboardRun(run({ highestBossActDefeated: 0, finalDeck }), 1).finalDeck, finalDeck)
})

check('rows aggregate the requested per-character and ascension metrics', () => {
  const snapshot = leaderboardSnapshot([
    normalizeLeaderboardRun(run(), 1),
    normalizeLeaderboardRun(run({ id: 'browser-1234:campaign-2', highestBossActDefeated: 2, combatsFinished: 5, damageDealt: 25, damageTaken: 50, damageBlocked: 0, floorsCleared: 10 }), 2),
    normalizeLeaderboardRun(run({ id: 'browser-1234:campaign-3', startedAtAct: 4, highestBossActDefeated: 4, floorsCleared: 4 }), 3),
  ])
  const row = snapshot.rows[0]
  assertEqual(snapshot.totalRuns, 3)
  assertEqual(row.runs, 3)
  assertEqual(row.act3Runs, 2, 'an Act IV Quick Start polluted the Act III denominator')
  assertEqual(row.act3Wins, 1)
  assertEqual(row.act3WinRate, .5)
  assertEqual(row.averageDamagePerFight, 225 / 25)
  assertEqual(row.averageDamageBlocked, 140 / 250)
  assertEqual(row.averageFloorsCleared, 34 / 3)
  assertEqual(row.act4Wins, 1)
})

check('rows aggregate by the complete hero set regardless of seat order', () => {
  const snapshot = leaderboardSnapshot([
    normalizeLeaderboardRun(run({ id: 'party-run-0001', characters: ['silent', 'ironclad'] }), 1),
    normalizeLeaderboardRun(run({ id: 'party-run-0002', characters: ['ironclad', 'silent'] }), 2),
    normalizeLeaderboardRun(run({ id: 'party-run-0003', characters: ['ironclad'] }), 3),
  ])
  assertEqual(snapshot.rows.length, 2)
  assertDeepEqual(snapshot.rows.find((row) => row.characters.length === 2).characters, ['ironclad', 'silent'])
  assertEqual(snapshot.rows.find((row) => row.characters.length === 2).runs, 2)
})

const directory = mkdtempSync(join(tmpdir(), 'sts-leaderboard-'))
const file = join(directory, 'rooms.json')
try {
  const store = createStore({ file })
  const initialFile = join(directory, 'first-save.json')
  const initialStore = createStore({ file: initialFile })
  createRoom(initialStore, { code: 'FIRSTS' })
  addLeaderboardRun(initialStore, run({ id: 'browser-1234:first-save' }))
  mkdirSync(`${initialFile}.leaderboard.json.tmp`)
  assertThrows(() => saveStore(initialStore))
  check('a failed first archive save leaves a loadable room and its recorded run', () => {
    const restored = createStore({ file: initialFile })
    assertEqual(restored.rooms.size, 1)
    assertEqual(restored.leaderboardRuns.length, 1)
    rmSync(`${initialFile}.leaderboard.json.tmp`, { recursive: true })
    saveStore(restored)
    assertEqual(createStore({ file: initialFile }).leaderboardRuns.length, 1)
  })
  check('duplicate retries enrich a legacy floor count without duplicating the run', () => {
    assertEqual(addLeaderboardRun(store, run({ floorsCleared: null }), 10), true)
    assertEqual(addLeaderboardRun(store, run({ floorsCleared: 27 }), 11), true)
    assertEqual(addLeaderboardRun(store, run({ floorsCleared: 27 }), 12), false)
    assertEqual(store.leaderboardRuns.length, 1)
    assertEqual(store.leaderboardRuns[0].floorsCleared, 27)
  })
  check('recorded runs never expire or hit a leaderboard capacity', () => {
    const full = { leaderboardRuns: Array(20_000).fill(store.leaderboardRuns[0]) }
    assertEqual(addLeaderboardRun(full, run({ id: 'browser-1234:over-capacity' }), 12), true)
    assertEqual(full.leaderboardRuns.length, 20_001)
  })
  saveStore(store)
  check('the complete leaderboard remains in the persistent room store', () => {
    const serialized = JSON.parse(readFileSync(file, 'utf8'))
    assertEqual(serialized.leaderboardArchive, true)
    assertEqual(serialized.leaderboardRuns, undefined)
    assertEqual(JSON.parse(readFileSync(`${file}.leaderboard.json`, 'utf8')).length, 1)
    const restored = createStore({ file, restartRecovery: true })
    assertDeepEqual(restored.leaderboardRuns, store.leaderboardRuns)
  })
  const archiveModified = statSync(`${file}.leaderboard.json`, { bigint: true }).mtimeNs
  createRoom(store, { code: 'LOGRUM' })
  saveStore(store)
  check('room-only saves do not rewrite the historical leaderboard archive', () => {
    assertEqual(statSync(`${file}.leaderboard.json`, { bigint: true }).mtimeNs, archiveModified)
    assertEqual(createStore({ file }).leaderboardRuns.length, 1)
  })
  const journalFile = join(directory, 'journal.json')
  const journalStore = createStore({ file: journalFile })
  addLeaderboardRun(journalStore, run({ id: 'browser-1234:journal-first' }))
  saveStore(journalStore)
  const snapshotModified = statSync(`${journalFile}.leaderboard.json`, { bigint: true }).mtimeNs
  addLeaderboardRun(journalStore, run({ id: 'browser-1234:journal-second' }))
  saveStore(journalStore)
  check('new runs append to the archive journal without rewriting unlimited history', () => {
    assertEqual(statSync(`${journalFile}.leaderboard.json`, { bigint: true }).mtimeNs, snapshotModified)
    assertEqual(createStore({ file: journalFile }).leaderboardRuns.length, 2)
    assert(readFileSync(`${journalFile}.leaderboard.log`, 'utf8').includes('journal-second'))
  })
  const intermediate = JSON.parse(readFileSync(journalFile, 'utf8'))
  writeFileSync(journalFile, JSON.stringify({ ...intermediate, leaderboardRuns: createStore({ file: journalFile }).leaderboardRuns }))
  check('main-store materialization protects older releases before archive replacement', () => {
    assertEqual(JSON.parse(readFileSync(journalFile, 'utf8')).leaderboardRuns.length, 2)
    assertEqual(JSON.parse(readFileSync(`${journalFile}.leaderboard.json`, 'utf8')).length, 1)
    assertEqual(createStore({ file: journalFile }).leaderboardRuns.length, 2)
  })
  await materializeLeaderboardArchive(journalFile)
  check('rollback materializes and clears the archive journal for older releases', () => {
    assertEqual(JSON.parse(readFileSync(`${journalFile}.leaderboard.json`, 'utf8')).length, 2)
    assertEqual(JSON.parse(readFileSync(journalFile, 'utf8')).leaderboardRuns.length, 2)
    assertEqual(readFileSync(`${journalFile}.leaderboard.log`, 'utf8'), '')
    assertEqual(createStore({ file: journalFile }).leaderboardRuns.length, 2)
  })
  const cappedRelease = join(directory, 'capped-release.mjs')
  writeFileSync(cappedRelease, 'export const MAX_LEADERBOARD_RUNS = 2\n')
  let capacityError
  try { await materializeLeaderboardArchive(journalFile, cappedRelease) } catch (error) { capacityError = error }
  check('rollback refuses a previous release whose archive is at its capacity', () => {
    assert(capacityError?.message.includes('leaderboard capacity'))
    assertEqual(JSON.parse(readFileSync(journalFile, 'utf8')).leaderboardRuns.length, 2)
    assertEqual(JSON.parse(readFileSync(`${journalFile}.leaderboard.json`, 'utf8')).length, 2)
  })
  const legacyFile = join(directory, 'legacy.json')
  const legacyRun = normalizeLeaderboardRun(run({ id: 'browser-1234:legacy-store' }), 3)
  writeFileSync(legacyFile, JSON.stringify({ version: 1, rooms: [], leaderboardRuns: [legacyRun], profiles: [] }))
  const legacyStore = createStore({ file: legacyFile })
  saveStore(legacyStore)
  check('legacy room stores migrate every recorded run to the archive', () => {
    assertEqual(JSON.parse(readFileSync(`${legacyFile}.leaderboard.json`, 'utf8')).length, 1)
    assertEqual(createStore({ file: legacyFile }).leaderboardRuns[0].id, legacyRun.id)
  })
  const migrationFile = join(directory, 'corrected-migration.json')
  const migrationRun = normalizeLeaderboardRun(run({ id: 'browser-1234:corrected-migration', floorsCleared: null }), 1)
  writeFileSync(migrationFile, JSON.stringify({ version: 1, rooms: [], leaderboardRuns: [migrationRun] }))
  const migrationStore = createStore({ file: migrationFile })
  addLeaderboardRun(migrationStore, run({ id: migrationRun.id, floorsCleared: 27 }), 2)
  mkdirSync(`${migrationFile}.stats.json.tmp`)
  assertThrows(() => saveStore(migrationStore))
  check('a crash after the first archive write preserves corrected legacy main data', () => {
    assertEqual(JSON.parse(readFileSync(`${migrationFile}.leaderboard.json`, 'utf8'))[0].floorsCleared, 27)
    assertEqual(JSON.parse(readFileSync(migrationFile, 'utf8')).leaderboardRuns[0].floorsCleared, 27)
    const restored = createStore({ file: migrationFile })
    assertEqual(restored.leaderboardRuns[0].floorsCleared, 27)
    rmSync(`${migrationFile}.stats.json.tmp`, { recursive: true })
    saveStore(restored)
    assertEqual(createStore({ file: migrationFile }).leaderboardRuns[0].floorsCleared, 27)
  })
  const missingArchiveFile = join(directory, 'missing-archive.json')
  writeFileSync(missingArchiveFile, JSON.stringify({ version: 1, rooms: [], leaderboardArchive: true }))
  check('a missing archive never silently resets the leaderboard', () => {
    assertThrows(() => createStore({ file: missingArchiveFile }))
  })
  const nullArchiveFile = join(directory, 'null-archive.json')
  writeFileSync(nullArchiveFile, JSON.stringify({ version: 1, rooms: [], leaderboardArchive: true }))
  writeFileSync(`${nullArchiveFile}.leaderboard.json`, 'null')
  check('an invalid null archive never silently resets the leaderboard', () => {
    assertThrows(() => createStore({ file: nullArchiveFile }))
    assertEqual(readFileSync(`${nullArchiveFile}.leaderboard.json`, 'utf8'), 'null')
  })
  const orphanFile = join(directory, 'orphan.json')
  writeFileSync(`${orphanFile}.leaderboard.json`, JSON.stringify([legacyRun]))
  check('a surviving archive cannot be overwritten when the room file is missing', () => {
    assertThrows(() => createStore({ file: orphanFile }))
    assertEqual(JSON.parse(readFileSync(`${orphanFile}.leaderboard.json`, 'utf8')).length, 1)
  })
  const orphanLogFile = join(directory, 'orphan-journal.json')
  writeFileSync(`${orphanLogFile}.leaderboard.log`, JSON.stringify(legacyRun) + '\n')
  check('a surviving leaderboard journal cannot be lost when its room store is missing', () => {
    assertThrows(() => createStore({ file: orphanLogFile }))
  })
  const orphanSnapshotFile = join(directory, 'orphan-snapshot.json')
  writeFileSync(orphanSnapshotFile, JSON.stringify({ version: 1, rooms: [], leaderboardRuns: [legacyRun] }))
  writeFileSync(`${orphanSnapshotFile}.leaderboard.log`, JSON.stringify(legacyRun) + '\n')
  let rejectedOrphanSnapshot = false
  try { await materializeLeaderboardArchive(orphanSnapshotFile) } catch { rejectedOrphanSnapshot = true }
  check('rollback refuses a journal without its archive even for legacy store files', () => {
    assert(rejectedOrphanSnapshot)
    assertEqual(JSON.parse(readFileSync(orphanSnapshotFile, 'utf8')).leaderboardRuns.length, 1)
  })
  const damagedLogFile = join(directory, 'damaged-journal.json')
  saveStore(createStore({ file: damagedLogFile }))
  writeFileSync(`${damagedLogFile}.leaderboard.log`, '{\n')
  check('a malformed complete archive record fails closed instead of silently dropping runs', () => {
    assertThrows(() => createStore({ file: damagedLogFile }))
  })
  const retryFile = join(directory, 'same-process-retry.json')
  const retryStore = createStore({ file: retryFile })
  addLeaderboardRun(retryStore, run({ id: 'browser-1234:retry-first' }))
  saveStore(retryStore)
  appendFileSync(`${retryFile}.leaderboard.log`, '{"id":')
  addLeaderboardRun(retryStore, run({ id: 'browser-1234:retry-second' }))
  saveStore(retryStore)
  check('a same-process retry repairs a short archive write before appending', () => {
    assertEqual(createStore({ file: retryFile }).leaderboardRuns.length, 2)
    assert(readdirSync(directory).some((file) => file.startsWith('same-process-retry.json.leaderboard.log.partial-')))
  })
  const crashFile = join(directory, 'older-main-crash.json')
  const crashStore = createStore({ file: crashFile })
  addLeaderboardRun(crashStore, run({ id: 'browser-1234:crash-window', floorsCleared: null }))
  saveStore(crashStore)
  const oldRun = crashStore.leaderboardRuns[0]
  const oldMain = JSON.parse(readFileSync(crashFile, 'utf8'))
  delete oldMain.leaderboardArchive
  oldMain.leaderboardRuns = [oldRun]
  writeFileSync(crashFile, JSON.stringify(oldMain))
  appendFileSync(`${crashFile}.leaderboard.log`, JSON.stringify({ ...oldRun, floorsCleared: 27 }) + '\n')
  check('journaled corrections outrank an older-release main file after a crash', () => {
    const restored = createStore({ file: crashFile })
    assertEqual(restored.leaderboardRuns[0].floorsCleared, 27)
    saveStore(restored)
    assertEqual(createStore({ file: crashFile }).leaderboardRuns[0].floorsCleared, 27)
  })
  const interruptedFile = join(directory, 'interrupted.json')
  const interruptedStore = createStore({ file: interruptedFile })
  addLeaderboardRun(interruptedStore, run({ id: 'browser-1234:interrupted-first' }))
  saveStore(interruptedStore)
  addLeaderboardRun(interruptedStore, run({ id: 'browser-1234:interrupted-second' }))
  saveStore(interruptedStore)
  appendFileSync(`${interruptedFile}.leaderboard.log`, '{"id":')
  const recovered = createStore({ file: interruptedFile })
  check('restart retains complete runs and preserves an interrupted append for inspection', () => {
    assertEqual(recovered.leaderboardRuns.length, 2)
    assertEqual(recovered.interruptedJournals.size, 1)
    saveStore(recovered)
    assertEqual(createStore({ file: interruptedFile }).leaderboardRuns.length, 2)
    assert(readdirSync(directory).some((file) => file.startsWith('interrupted.json.leaderboard.log.partial-')))
  })
  appendFileSync(`${interruptedFile}.leaderboard.log`, JSON.stringify(normalizeLeaderboardRun(run({ id: 'browser-1234:valid-tail' }))))
  const validTail = createStore({ file: interruptedFile })
  check('a complete final record without a newline is retained on restart', () => {
    assertEqual(validTail.leaderboardRuns.length, 3)
    saveStore(validTail)
    assertEqual(createStore({ file: interruptedFile }).leaderboardRuns.length, 3)
  })
  appendFileSync(`${interruptedFile}.leaderboard.log`, '{"id":')
  await materializeLeaderboardArchive(interruptedFile)
  check('rollback repairs an interrupted append before checkpointing the archive', () => {
    assertEqual(JSON.parse(readFileSync(`${interruptedFile}.leaderboard.json`, 'utf8')).length, 3)
    assertEqual(JSON.parse(readFileSync(interruptedFile, 'utf8')).leaderboardRuns.length, 3)
    assertEqual(readFileSync(`${interruptedFile}.leaderboard.log`, 'utf8'), '')
    assertEqual(readdirSync(directory).filter((file) => file.startsWith('interrupted.json.leaderboard.log.partial-')).length, 2)
  })
  const rollbackFile = join(directory, 'rollback.json')
  const emptyRollbackFile = join(directory, 'empty-rollback.json')
  await materializeLeaderboardArchive(emptyRollbackFile)
  check('a rollback before the first room-store save needs no archive materialization', () => {
    assertEqual(existsSync(emptyRollbackFile), false)
    assertEqual(existsSync(`${emptyRollbackFile}.leaderboard.json`), false)
  })
  const rollbackStore = createStore({ file: rollbackFile })
  addLeaderboardRun(rollbackStore, run({ id: 'browser-1234:old-release', floorsCleared: null }), 2)
  saveStore(rollbackStore)
  const rollbackRaw = JSON.parse(readFileSync(rollbackFile, 'utf8'))
  const recoveredDeck = [{ defId: 'strike_ironclad', upgraded: false }]
  rollbackRaw.leaderboardRuns = [legacyRun, normalizeLeaderboardRun(run({ id: 'browser-1234:old-release', floorsCleared: 27,
    finalDeck: recoveredDeck }), 2)]
  writeFileSync(rollbackFile, JSON.stringify(rollbackRaw))
  await materializeLeaderboardArchive(rollbackFile)
  check('rolling back to an older release keeps archived leaderboard history', () => {
    const serialized = JSON.parse(readFileSync(rollbackFile, 'utf8'))
    assertEqual(serialized.leaderboardRuns.length, 2)
    assertEqual(serialized.leaderboardRuns.find((run) => run.id === 'browser-1234:old-release').floorsCleared, 27)
    const loaded = createStore({ file: rollbackFile })
    assertEqual(loaded.leaderboardRuns.length, 2)
    assertDeepEqual(loaded.leaderboardRuns.find((run) => run.id === 'browser-1234:old-release').finalDeck, recoveredDeck)
    saveStore(loaded)
    assertEqual(JSON.parse(readFileSync(`${rollbackFile}.leaderboard.json`, 'utf8'))
      .find((run) => run.id === 'browser-1234:old-release').floorsCleared, 27)
  })

  const expirationFile = join(directory, 'expiration.json')
  const expirationStore = createStore({ file: expirationFile })
  addLeaderboardRun(expirationStore, run(), 1)
  const staleRoom = createRoom(expirationStore, { code: 'LOGOLD' })
  const freshRoom = createRoom(expirationStore, { code: 'LOGFRE' })
  const sweepAt = Date.now()
  staleRoom.lastActivityAt = sweepAt - 24 * 60 * 60_000 - 1
  freshRoom.lastActivityAt = sweepAt - 24 * 60 * 60_000
  saveStore(expirationStore)
  const expirationService = createRoomServer({ storeFile: expirationFile, saveDelayMs: 0 })
  await expirationService.listen(0)
  expirationService.sweepRooms(sweepAt)
  check('only inactive rooms expire after 24 hours, never historical runs', () => {
    assertEqual(expirationService.store.rooms.has('LOGOLD'), false)
    assertEqual(expirationService.store.rooms.has('LOGFRE'), true)
    assertEqual(expirationService.store.leaderboardRuns.length, 1)
  })
  await expirationService.close({ preserveRooms: true })
  check('expired rooms stay deleted while leaderboard history survives restart', () => {
    const restored = createStore({ file: expirationFile })
    assertEqual(restored.rooms.has('LOGOLD'), false)
    assertEqual(restored.rooms.has('LOGFRE'), true)
    assertEqual(restored.leaderboardRuns.length, 1)
  })

  const startupFile = join(directory, 'startup.json')
  const startupStore = createStore({ file: startupFile })
  const startupRoom = createRoom(startupStore, { code: 'LOGNEW' })
  const startupLeader = joinRoom(startupRoom, { name: 'BestDefect2002', character: 'defect' })
  joinRoom(startupRoom, { name: 'phuotthu', character: 'watcher' })
  startRun(startupRoom, startupLeader.token, { seed: 126 })
  startupRoom.run = { ...startupRoom.run, phase: 'victory', act: 3,
    campaign: { ...startupRoom.run.campaign, finalized: true, highestBossActDefeated: 3 } }
  const roomRun = roomLeaderboardRun(startupRoom)
  addLeaderboardRun(startupStore, {
    ...roomRun, winningDecks: undefined,
    finalDeck: roomRun.winningDecks.flatMap((deck) => deck.finalDeck),
  }, 1234)
  saveStore(startupStore)
  const startupService = createRoomServer({ storeFile: startupFile, saveDelayMs: 0 })
  await new Promise((resolve) => setTimeout(resolve, 10))
  check('server startup enriches a retained party result with personal winning decks', () => {
    const migrated = startupService.store.leaderboardRuns[0]
    assertEqual(startupService.store.leaderboardRuns.length, 1)
    assertDeepEqual(migrated.characters, ['defect', 'watcher'])
    assertEqual(migrated.recordedAt, 1234)
    assertDeepEqual(migrated.winningDecks, roomRun.winningDecks)
    assertEqual(migrated.finalDeck, undefined)
    const decks = winningDecksPage([migrated]).rows
    assertDeepEqual(new Set(decks.map((deck) => `${deck.username}:${deck.character}`)),
      new Set(['BestDefect2002:defect', 'phuotthu:watcher']))
    assertDeepEqual(createStore({ file: startupFile }).leaderboardRuns[0], migrated)
    assertDeepEqual(JSON.parse(readFileSync(`${startupFile}.leaderboard.log`, 'utf8').trim()), migrated)
  })
  await startupService.close({ preserveRooms: true })

  const service = createRoomServer({ storeFile: file, saveDelayMs: 10_000 })
  const address = await service.listen(0)
  const origin = `http://127.0.0.1:${address.port}`
  const submit = (body) => fetch(`${origin}/api/leaderboard`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  try {
    const invalid = await submit(run({ id: 'browser-1234:campaign-bad', ascension: 99 }))
    const reserved = await submit(run({ id: 'room:LOGRUN:campaign-999:123' }))
    const accepted = await submit(run({ id: 'browser-1234:campaign-2', character: 'silent', highestBossActDefeated: 4,
      winningDecks: [{ username: 'forged', character: 'silent', finalDeck: [] }] }))
    const duplicate = await submit(run({ id: 'browser-1234:campaign-2', character: 'silent', highestBossActDefeated: 4 }))
    const acceptedBody = await accepted.json()
    const response = await fetch(`${origin}/api/leaderboard`).then((value) => value.json())
    check('the public endpoint rejects bad rows and accepts one copy of retries', () => {
      assertEqual(invalid.status, 400)
      assertEqual(reserved.status, 400)
      assertEqual(accepted.status, 201)
      assertEqual(acceptedBody.floorsClearedAccepted, true)
      assertEqual(duplicate.status, 200)
      assertEqual(response.totalRuns, 2)
      assert(response.rows.some((row) => row.character === 'silent' && row.act4Wins === 1))
      assertEqual(service.store.leaderboardRuns.find((run) => run.id === 'browser-1234:campaign-2').winningDecks, undefined)
    })

    const today = new Date().toISOString().slice(0, 10)
    const climber = crypto.randomUUID()
    await fetch(`${origin}/api/profile`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'DailyEndpoint', token: climber, password: 'daily endpoint password' }) })
    const dailyAccepted = await submit(daily({ id: 'daily-install:campaign-9', dailyDate: today, floorsCleared: 17, profileToken: climber }))
    const dailyAcceptedBody = await dailyAccepted.clone().json()
    const dailyInvalid = await submit(daily({ id: 'daily-install:campaign-10', dailyDate: today, ascension: 3 }))
    const dailyBoard = await fetch(`${origin}/api/leaderboard/daily?date=${today}`).then((value) => value.json())
    const dailyBadDate = await fetch(`${origin}/api/leaderboard/daily?date=nope`)
    const dailyBadQuery = await fetch(`${origin}/api/leaderboard/daily?date=${today}&cursor=1`)
    const dailyFiltered = await fetch(`${origin}/api/leaderboard/daily?date=${today}&character=silent`).then((value) => value.json())
    // The public write limit is spent above; the store path is what the POST handler calls.
    addLeaderboardRun(service.store, daily({ id: 'daily-rival:campaign-1', username: 'DailyRival', character: 'silent', dailyDate: today, floorsCleared: 30 }))
    const dailyRefreshed = await fetch(`${origin}/api/leaderboard/daily?date=${today}&character=silent&character=ironclad`).then((value) => value.json())
    const dailyReordered = await fetch(`${origin}/api/leaderboard/daily?date=${today}&character=ironclad&character=silent&character=silent`).then((value) => value.json())
    const dailyImpossible = await fetch(`${origin}/api/leaderboard/daily?date=2026-13-45`)
    check('the daily ranking endpoint serves the requested day', () => {
      assertEqual(dailyAccepted.status, 201)
      assertEqual(dailyInvalid.status, 400)
      assertEqual(dailyBoard.date, today)
      assertDeepEqual(dailyBoard.rows.map((row) => [row.rank, row.username, row.floorsCleared]), [[1, 'DailyEndpoint', 17]])
      assertEqual(dailyBadDate.status, 400)
      assertEqual(dailyBadQuery.status, 400)
      assertDeepEqual(dailyFiltered.rows, [])
      assertDeepEqual(dailyRefreshed.rows.map((row) => [row.rank, row.username]), [[1, 'DailyRival'], [2, 'DailyEndpoint']], 'a new climb did not refresh the cached day')
      assertDeepEqual(dailyReordered, dailyRefreshed)
      assertEqual(dailyImpossible.status, 400)
      assertEqual(dailyAcceptedBody.dailyDateAccepted, true, 'the client cannot tell this server keeps the day')
    })
    let dailyLimited
    for (let read = 0; read < 30 && dailyLimited?.status !== 429; read += 1) dailyLimited = await fetch(`${origin}/api/leaderboard/daily?date=${today}`)
    const decksAfterDailyLimit = await fetch(`${origin}/api/leaderboard/decks`)
    check('daily ranking reads have their own rate limit', () => {
      assertEqual(dailyLimited.status, 429)
      assertEqual(decksAfterDailyLimit.status, 200, 'spending daily reads locked out Winning decks')
    })
    service.store.leaderboardRuns = service.store.leaderboardRuns.filter((entry) => !entry.dailyDate)
    service.store.leaderboardRevision += 1

    const room = createRoom(service.store, { code: 'LOGRUN' })
    const leader = joinRoom(room, { name: 'Ann', character: 'silent' })
    joinRoom(room, { name: 'Bo', character: 'ironclad' })
    startRun(room, leader.token, { seed: 123 })
    room.run = { ...room.run, phase: 'victory', act: 3, floorsCleared: 18, combatsFinished: 7,
      campaign: { ...room.run.campaign, bossesDefeated: 3, highestBossActDefeated: 3 } }
    room.run.players[0].damageStats.attack = 11
    room.run.players[1].damageStats.attack = 22
    room.run.players[0].damageStats.taken = 3
    room.run.players[0].damageStats.blocked = 7
    room.run.players[1].damageStats.blocked = 5
    const decks = Object.fromEntries(room.run.players.map((player) => [player.name,
      player.deck.map(({ defId, upgraded }) => ({ defId, upgraded }))]))
    const finished = await fetch(`${origin}/api/rooms/LOGRUN/action`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-room-token': leader.token },
      body: JSON.stringify({ action: { kind: 'finishRun' } }),
    })
    const recorded = service.store.leaderboardRuns.at(-1)
    check('the room authority records combined statistics and personal winning decks', () => {
      assertEqual(finished.status, 200)
      assertDeepEqual(recorded.characters, ['ironclad', 'silent'])
      assertEqual(recorded.damageDealt, 33)
      assertEqual(recorded.damageTaken, 3)
      assertEqual(recorded.damageBlocked, 12)
      assertEqual(recorded.floorsCleared, 18)
      assertDeepEqual(new Map(recorded.winningDecks.map((deck) => [deck.username,
        [deck.damageDealt, deck.damageTaken, deck.damageBlocked]])),
      new Map([['Ann', [11, 3, 7]], ['Bo', [22, 0, 5]]]))
      assertDeepEqual(new Map(recorded.winningDecks.map((deck) => [deck.username, deck.finalDeck])),
        new Map([['Ann', decks.Ann], ['Bo', decks.Bo]]))
      assertDeepEqual(new Set(winningDecksPage([recorded]).rows.map((deck) => deck.username)), new Set(['Ann', 'Bo']))
    })
    const refreshedSummary = await fetch(`${origin}/api/leaderboard`).then((value) => value.json())
    check('public leaderboard summary cache refreshes after an accepted room result', () => {
      assertEqual(refreshedSummary.totalRuns, 3)
      assertEqual(refreshedSummary.rows.find((row) => row.characters.length === 2).runs, 1)
    })

    const lostRoom = createRoom(service.store, { code: 'LOGLOS' })
    const lostLeader = joinRoom(lostRoom, { name: 'Cara', character: 'defect' })
    startRun(lostRoom, lostLeader.token, { seed: 127 })
    lostRoom.run = { ...lostRoom.run, phase: 'defeat', floorsCleared: 4, combatsFinished: 2 }
    lostRoom.run.players[0].damageStats.attack = 17
    const lostDeck = lostRoom.run.players[0].deck.map(({ defId, upgraded }) => ({ defId, upgraded }))
    const lost = await fetch(`${origin}/api/rooms/LOGLOS/action`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-room-token': lostLeader.token },
      body: JSON.stringify({ action: { kind: 'finishRun' } }),
    })
    const lostRun = service.store.leaderboardRuns.at(-1)
    check('the room authority records player details and statistics after a loss', () => {
      assertEqual(lost.status, 200)
      assertEqual(lostRun.highestBossActDefeated, 0)
      assertEqual(lostRun.damageDealt, 17)
      assertEqual(lostRun.floorsCleared, 4)
      assertDeepEqual(lostRun.winningDecks, [{ username: 'Cara', character: 'defect', finalDeck: lostDeck,
        damageDealt: 17, damageTaken: 0, damageBlocked: 0 }])
      assertEqual(winningDecksPage([lostRun]).total, 0)
    })
    service.store.leaderboardRuns.pop()
    service.store.leaderboardRuns.pop()
    room.campaignProgress.unspentMarks = 0
    room.run.campaignProgress = room.campaignProgress
    const returned = await fetch(`${origin}/api/rooms/LOGRUN/action`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-room-token': leader.token },
      body: JSON.stringify({ action: { kind: 'returnToLobby' } }),
    })
    check('a restored finalized room is archived before returning to the lobby', () => {
      assertEqual(returned.status, 200)
      assertEqual(room.phase, 'lobby')
      assertEqual(service.store.leaderboardRuns.at(-1).id, recorded.id)
    })

    const fullRoom = createRoom(service.store, { code: 'LOGFUL' })
    const fullLeader = joinRoom(fullRoom, { character: 'ironclad' })
    joinRoom(fullRoom, { character: 'silent' })
    startRun(fullRoom, fullLeader.token, { seed: 124 })
    fullRoom.run = { ...fullRoom.run, phase: 'victory', act: 3,
      campaign: { ...fullRoom.run.campaign, bossesDefeated: 3, highestBossActDefeated: 3 } }
    const existingRuns = service.store.leaderboardRuns
    service.store.leaderboardRuns = Array(20_000).fill(existingRuns[0])
    const full = await fetch(`${origin}/api/rooms/LOGFUL/action`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-room-token': fullLeader.token },
      body: JSON.stringify({ action: { kind: 'finishRun' } }),
    })
    check('finishing a multiplayer run records it beyond 20,000 historical runs', () => {
      assertEqual(full.status, 200)
      assertEqual(fullRoom.run.campaign.finalized, true)
      assertEqual(service.store.leaderboardRuns.length, 20_001)
    })
    service.store.leaderboardRuns = existingRuns

    let saves = 0
    const retryService = createRoomServer({ storeFile: join(directory, 'retry.json'), saveDelayMs: 0, saveStoreImpl: () => { saves += 1 } })
    const retryAddress = await retryService.listen(0)
    const retryRoom = createRoom(retryService.store, { code: 'LOGBAD' })
    const retryLeader = joinRoom(retryRoom, { character: 'ironclad' })
    startRun(retryRoom, retryLeader.token, { seed: 125 })
    retryRoom.run = { ...retryRoom.run, phase: 'defeat', campaign: { ...retryRoom.run.campaign, finalized: true } }
    retryRoom.campaignProgress = { ...retryRoom.campaignProgress, unspentMarks: 1 }
    const rejected = await fetch(`http://127.0.0.1:${retryAddress.port}/api/rooms/LOGBAD/action`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-room-token': retryLeader.token },
      body: JSON.stringify({ action: { kind: 'returnToLobby' } }),
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    check('a finalized-run backfill is saved even when the requested action is rejected', () => {
      assertEqual(rejected.status, 409)
      assertEqual(retryService.store.leaderboardRuns.length, 1)
      assertEqual(saves, 1)
    })
    await retryService.close({ preserveRooms: true })
  } finally { await service.close({ preserveRooms: true }) }
} finally { rmSync(directory, { recursive: true, force: true }) }

report('leaderboard')
