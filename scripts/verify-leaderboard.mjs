#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addLeaderboardRun, leaderboardSnapshot, MAX_LEADERBOARD_RUNS, normalizeLeaderboardRun, roomLeaderboardRun, winningDecksPage } from './lib/leaderboard.mjs'
import { createRoom, createStore, joinRoom, saveStore, startRun } from './lib/rooms.mjs'
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
  check('duplicate retries enrich a legacy floor count without duplicating the run', () => {
    assertEqual(addLeaderboardRun(store, run({ floorsCleared: null }), 10), true)
    assertEqual(addLeaderboardRun(store, run({ floorsCleared: 27 }), 11), true)
    assertEqual(addLeaderboardRun(store, run({ floorsCleared: 27 }), 12), false)
    assertEqual(store.leaderboardRuns.length, 1)
    assertEqual(store.leaderboardRuns[0].floorsCleared, 27)
  })
  check('a bounded public store cannot threaten room restart persistence', () => {
    const full = { leaderboardRuns: Array(MAX_LEADERBOARD_RUNS).fill(store.leaderboardRuns[0]) }
    assertThrows(() => addLeaderboardRun(full, run({ id: 'browser-1234:over-capacity' }), 12))
  })
  saveStore(store)
  check('the complete leaderboard remains in the persistent room store', () => {
    const serialized = JSON.parse(readFileSync(file, 'utf8'))
    assertEqual(serialized.leaderboardRuns.length, 1)
    const restored = createStore({ file, restartRecovery: true })
    assertDeepEqual(restored.leaderboardRuns, store.leaderboardRuns)
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
    assertDeepEqual(JSON.parse(readFileSync(startupFile, 'utf8')).leaderboardRuns[0], migrated)
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
    const accepted = await submit(run({ id: 'browser-1234:campaign-2', character: 'silent', highestBossActDefeated: 4,
      winningDecks: [{ username: 'forged', character: 'silent', finalDeck: [] }] }))
    const duplicate = await submit(run({ id: 'browser-1234:campaign-2', character: 'silent', highestBossActDefeated: 4 }))
    const acceptedBody = await accepted.json()
    const response = await fetch(`${origin}/api/leaderboard`).then((value) => value.json())
    check('the public endpoint rejects bad rows and accepts one copy of retries', () => {
      assertEqual(invalid.status, 400)
      assertEqual(accepted.status, 201)
      assertEqual(acceptedBody.floorsClearedAccepted, true)
      assertEqual(duplicate.status, 200)
      assertEqual(response.totalRuns, 2)
      assert(response.rows.some((row) => row.character === 'silent' && row.act4Wins === 1))
      assertEqual(service.store.leaderboardRuns.find((run) => run.id === 'browser-1234:campaign-2').winningDecks, undefined)
    })

    const room = createRoom(service.store, { code: 'LOGRUN' })
    const leader = joinRoom(room, { name: 'Ann', character: 'silent' })
    joinRoom(room, { name: 'Bo', character: 'ironclad' })
    startRun(room, leader.token, { seed: 123 })
    room.run = { ...room.run, phase: 'victory', act: 3, floorsCleared: 18, combatsFinished: 7,
      campaign: { ...room.run.campaign, bossesDefeated: 3, highestBossActDefeated: 3 } }
    room.run.players[0].damageStats.attack = 11
    room.run.players[1].damageStats.attack = 22
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
      assertEqual(recorded.floorsCleared, 18)
      assertDeepEqual(new Map(recorded.winningDecks.map((deck) => [deck.username, deck.finalDeck])),
        new Map([['Ann', decks.Ann], ['Bo', decks.Bo]]))
      assertDeepEqual(new Set(winningDecksPage([recorded]).rows.map((deck) => deck.username)), new Set(['Ann', 'Bo']))
    })
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
    service.store.leaderboardRuns = Array(MAX_LEADERBOARD_RUNS).fill(existingRuns[0])
    const full = await fetch(`${origin}/api/rooms/LOGFUL/action`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-room-token': fullLeader.token },
      body: JSON.stringify({ action: { kind: 'finishRun' } }),
    })
    check('leaderboard capacity refusal leaves a multiplayer run retryable', () => {
      assertEqual(full.status, 503)
      assertEqual(fullRoom.run.campaign.finalized, false)
      assertEqual(service.store.leaderboardRuns.length, MAX_LEADERBOARD_RUNS)
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
