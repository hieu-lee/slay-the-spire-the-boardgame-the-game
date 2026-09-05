#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addLeaderboardRun, leaderboardSnapshot, MAX_LEADERBOARD_RUNS, normalizeLeaderboardRun } from './lib/leaderboard.mjs'
import { createStore, saveStore } from './lib/rooms.mjs'
import { createRoomServer } from './room-server.mjs'
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
  ...overrides,
})

check('legacy runs never mix incomplete damage history into averages', () => {
  const snapshot = leaderboardSnapshot([
    normalizeLeaderboardRun(run(), 1),
    normalizeLeaderboardRun(run({ id: 'browser-1234:legacy', damageStatsComplete: false, combatsFinished: 1, damageDealt: 999_999 }), 2),
  ])
  assertEqual(snapshot.totalRuns, 2)
  assertEqual(snapshot.rows[0].averageDamagePerFight, 10)
})

check('submissions are validated at the public boundary', () => {
  assertThrows(() => normalizeLeaderboardRun(run({ character: 'cheater' })))
  assertThrows(() => normalizeLeaderboardRun(run({ ascension: 14 })))
  assertThrows(() => normalizeLeaderboardRun(run({ damageBlocked: -1 })))
  assertThrows(() => normalizeLeaderboardRun(run({ combatsFinished: 1.5 })))
})

check('rows aggregate the requested per-character and ascension metrics', () => {
  const snapshot = leaderboardSnapshot([
    normalizeLeaderboardRun(run(), 1),
    normalizeLeaderboardRun(run({ id: 'browser-1234:campaign-2', highestBossActDefeated: 2, combatsFinished: 5, damageDealt: 25, damageTaken: 50, damageBlocked: 0 }), 2),
    normalizeLeaderboardRun(run({ id: 'browser-1234:campaign-3', startedAtAct: 4, highestBossActDefeated: 4 }), 3),
  ])
  const row = snapshot.rows[0]
  assertEqual(snapshot.totalRuns, 3)
  assertEqual(row.runs, 3)
  assertEqual(row.act3Runs, 2, 'an Act IV Quick Start polluted the Act III denominator')
  assertEqual(row.act3Wins, 1)
  assertEqual(row.act3WinRate, .5)
  assertEqual(row.averageDamagePerFight, 225 / 25)
  assertEqual(row.averageDamageBlocked, 140 / 250)
  assertEqual(row.act4Wins, 1)
})

const directory = mkdtempSync(join(tmpdir(), 'sts-leaderboard-'))
const file = join(directory, 'rooms.json')
try {
  const store = createStore({ file })
  check('duplicate client retries are idempotent', () => {
    assertEqual(addLeaderboardRun(store, run(), 10), true)
    assertEqual(addLeaderboardRun(store, run(), 11), false)
    assertEqual(store.leaderboardRuns.length, 1)
  })
  check('a bounded public store cannot threaten room handoff persistence', () => {
    const full = { leaderboardRuns: Array(MAX_LEADERBOARD_RUNS).fill(store.leaderboardRuns[0]) }
    assertThrows(() => addLeaderboardRun(full, run({ id: 'browser-1234:over-capacity' }), 12))
  })
  saveStore(store)
  check('the complete leaderboard rides inside the encrypted handoff store', () => {
    const serialized = JSON.parse(readFileSync(file, 'utf8'))
    assertEqual(serialized.leaderboardRuns.length, 1)
    const restored = createStore({ file, handoffRestore: true })
    assertDeepEqual(restored.leaderboardRuns, store.leaderboardRuns)
  })

  const service = createRoomServer({ storeFile: file, saveDelayMs: 10_000 })
  const address = await service.listen(0)
  const origin = `http://127.0.0.1:${address.port}`
  const submit = (body) => fetch(`${origin}/api/leaderboard`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  try {
    const invalid = await submit(run({ id: 'browser-1234:campaign-bad', ascension: 99 }))
    const accepted = await submit(run({ id: 'browser-1234:campaign-2', character: 'silent', highestBossActDefeated: 4 }))
    const duplicate = await submit(run({ id: 'browser-1234:campaign-2', character: 'silent', highestBossActDefeated: 4 }))
    const response = await fetch(`${origin}/api/leaderboard`).then((value) => value.json())
    check('the public endpoint rejects bad rows and accepts one copy of retries', () => {
      assertEqual(invalid.status, 400)
      assertEqual(accepted.status, 201)
      assertEqual(duplicate.status, 200)
      assertEqual(response.totalRuns, 2)
      assert(response.rows.some((row) => row.character === 'silent' && row.act4Wins === 1))
    })
  } finally { await service.close({ preserveRooms: true }) }
} finally { rmSync(directory, { recursive: true, force: true }) }

report('leaderboard')
