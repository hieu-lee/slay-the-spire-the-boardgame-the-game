import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply, createRoom, createStore, joinRoom, saveStore, startRun } from './lib/rooms.mjs'
import { createRoomServer } from './room-server.mjs'
import { suite, check, assertDeepEqual, assertEqual, report } from './lib/harness.mjs'

suite('campaign persistence')

const directory = mkdtempSync(join(tmpdir(), 'sts-campaign-'))
try {
  const file = join(directory, 'rooms.json')
  const store = createStore({ file })
  const room = createRoom(store, { code: 'ABCDEF' })
  const seat = joinRoom(room, { name: 'Ann', character: 'ironclad' })
  startRun(room, seat.token, { seed: 7331 })
  room.campaignProgress = { ...room.campaignProgress, colorless: 3, actIV: 5, highestAscension: 4 }
  room.run.campaignProgress = room.campaignProgress
  room.chooseYourRelic = true
  saveStore(store)

  const restored = createStore({ file }).rooms.get('ABCDEF')
  check('server restart restores deterministic run, campaign, token, and disconnected seat', () => {
    assertEqual(restored.run.seed, 7331)
    assertEqual(restored.run.rng.state, room.run.rng.state)
    assertEqual(restored.campaignProgress.colorless, 3)
    assertEqual(restored.campaignProgress.actIV, 5)
    assertEqual(restored.campaignProgress.highestAscension, 4)
    assertEqual(restored.seats[0].token, seat.token)
    assertEqual(restored.seats[0].connected, false)
    assertEqual(restored.chooseYourRelic, true)
  })

  const legacy = createRoom(store, { code: 'LEGACY' })
  legacy.campaignProgress = { ...legacy.campaignProgress, characters: { ...legacy.campaignProgress.characters, ironclad: 4 }, nextRunNumber: 7 }
  const legacySeat = joinRoom(legacy, { name: 'Lee', character: 'ironclad' })
  startRun(legacy, legacySeat.token, { seed: 7332 })
  delete legacy.run.campaignProgress
  const corrupt = createRoom(store, { code: 'CORRUP' })
  corrupt.campaignProgress = { ...corrupt.campaignProgress, characters: { ...corrupt.campaignProgress.characters, silent: 4 }, nextRunNumber: 11 }
  const corruptSeat = joinRoom(corrupt, { name: 'Kai', character: 'silent' })
  startRun(corrupt, corruptSeat.token, { seed: 7333 })
  corrupt.run.campaignProgress = { version: 1 }
  saveStore(store)
  const migratedStore = createStore({ file })
  const migratedLegacy = migratedStore.rooms.get('LEGACY')
  const migratedCorrupt = migratedStore.rooms.get('CORRUP')
  check('restart migrates missing or corrupt active-run campaign state without losing its run number', () => {
    assertEqual(migratedLegacy.run.campaignProgress.characters.ironclad, 4)
    assertEqual(migratedLegacy.run.campaignProgress.nextRunNumber, 8)
    assertEqual(migratedCorrupt.run.campaignProgress.characters.silent, 4)
    assertEqual(migratedCorrupt.run.campaignProgress.nextRunNumber, 12)
    migratedLegacy.run.phase = 'defeat'
    apply(migratedLegacy, legacySeat.token, { kind: 'finishRun' })
    assertEqual(migratedLegacy.campaignProgress.characters.ironclad, 5)
  })

  const legacyRed = createRoom(store, { code: 'OLDRED' })
  const redSeat = joinRoom(legacyRed, { name: 'Red', character: 'defect' })
  startRun(legacyRed, redSeat.token, { seed: 7334 })
  apply(legacyRed, redSeat.token, { kind: 'neow', stage: 'redGold', gain: false })
  apply(legacyRed, redSeat.token, { kind: 'neow', stage: 'reveal' })
  const redOrder = [...legacyRed.run.players[0].cardRewards]
  const blessingOrder = [...legacyRed.run.neow.deck]
  delete legacyRed.run.neow.players[redSeat.playerId].redRewardPending
  delete legacyRed.run.neow.players[redSeat.playerId].rewardKind

  const legacyBlue = createRoom(store, { code: 'OLDBLU' })
  const blueSeat = joinRoom(legacyBlue, { name: 'Blue', character: 'watcher' })
  startRun(legacyBlue, blueSeat.token, { seed: 7335 })
  apply(legacyBlue, blueSeat.token, { kind: 'neow', stage: 'redGold', gain: false })
  apply(legacyBlue, blueSeat.token, { kind: 'neow', stage: 'red', choice: null })
  legacyBlue.run.neow.players[blueSeat.playerId].cardId = 'neow_05'
  apply(legacyBlue, blueSeat.token, { kind: 'neow', stage: 'option', optionIndex: 1, cardUids: [] })
  apply(legacyBlue, blueSeat.token, { kind: 'neow', stage: 'reveal' })
  const blueOrder = [...legacyBlue.run.players[0].cardRewards]
  delete legacyBlue.run.neow.players[blueSeat.playerId].redRewardPending
  delete legacyBlue.run.neow.players[blueSeat.playerId].rewardKind
  saveStore(store)

  const neowMigrated = createStore({ file })
  const restoredRed = neowMigrated.rooms.get('OLDRED')
  const restoredBlue = neowMigrated.rooms.get('OLDBLU')
  check('restart migrates legacy pre-red and staged-blue Neow states without changing hidden order', () => {
    assertEqual(restoredRed.run.neow.players[redSeat.playerId].redRewardPending, true)
    assertEqual(restoredRed.run.neow.players[redSeat.playerId].rewardKind, null)
    assertDeepEqual(restoredRed.run.players[0].cardRewards, redOrder)
    assertDeepEqual(restoredRed.run.neow.deck, blessingOrder)
    apply(restoredRed, redSeat.token, { kind: 'neow', stage: 'red', choice: null })
    assertEqual(restoredRed.run.neow.players[redSeat.playerId].redRewardPending, false)

    assertEqual(restoredBlue.run.neow.players[blueSeat.playerId].redRewardPending, false)
    assertEqual(restoredBlue.run.neow.players[blueSeat.playerId].rewardKind, 'card')
    assertDeepEqual(restoredBlue.run.players[0].cardRewards, blueOrder)
    apply(restoredBlue, blueSeat.token, { kind: 'neow', stage: 'reward', choice: null })
    assertEqual(restoredBlue.run.phase, 'map')
  })

  const legacyCurseRooms = ['OLDCSK', 'OLDCTK'].map((code, index) => {
    const legacyCurse = createRoom(store, { code })
    const curseSeat = joinRoom(legacyCurse, { name: index ? 'Take' : 'Skip', character: 'ironclad' })
    startRun(legacyCurse, curseSeat.token, { seed: 7340 + index })
    apply(legacyCurse, curseSeat.token, { kind: 'neow', stage: 'redGold', gain: false })
    apply(legacyCurse, curseSeat.token, { kind: 'neow', stage: 'red', choice: null })
    legacyCurse.run.neow.players[curseSeat.playerId].cardId = 'neow_03'
    legacyCurse.run.relicDeck = ['omamori', ...legacyCurse.run.relicDeck.filter((id) => id !== 'omamori')]
    legacyCurse.run.itemDecks.relics = [...legacyCurse.run.relicDeck]
    apply(legacyCurse, curseSeat.token, { kind: 'neow', stage: 'option', optionIndex: 2, cardUids: [] })
    legacyCurse.run.neow.players[curseSeat.playerId].rewardQueue = ['curse']
    return { legacyCurse, curseSeat }
  })
  saveStore(store)
  const curseMigrated = createStore({ file })
  check('restart migrates legacy Relic-followed-by-Curse queues and preserves Omamori order', () => {
    for (const [index, fixture] of legacyCurseRooms.entries()) {
      const resumed = curseMigrated.rooms.get(fixture.legacyCurse.code)
      const playerId = fixture.curseSeat.playerId
      assertDeepEqual(resumed.run.neow.players[playerId].rewardQueue, [{ kind: 'curse' }])
      const curses = resumed.run.itemDecks.curses.length
      if (index === 0) {
        apply(resumed, fixture.curseSeat.token, { kind: 'neow', stage: 'reward', choice: null })
        assertEqual(resumed.run.itemDecks.curses.length, curses - 1)
        assertEqual(resumed.run.players[0].relics.some((relic) => relic.defId === 'omamori'), false)
      } else {
        apply(resumed, fixture.curseSeat.token, { kind: 'neow', stage: 'reveal' })
        apply(resumed, fixture.curseSeat.token, { kind: 'neow', stage: 'reward', choice: 0 })
        assertEqual(resumed.run.itemDecks.curses.length, curses)
        assertEqual(resumed.run.players[0].relics.some((relic) => relic.defId === 'omamori'), true)
      }
      assertEqual(resumed.run.phase, 'map')
    }
  })

  const aged = createRoom(store, { code: 'AGEDXX' })
  const agedSeat = joinRoom(aged, { name: 'Bo', character: 'silent' })
  startRun(aged, agedSeat.token, { seed: 99 })
  aged.lastActivityAt = Date.now() - 31 * 24 * 60 * 60 * 1000
  saveStore(store)
  const restarted = createRoomServer({ storeFile: file })
  restarted.sweepRooms()
  check('restart preserves activity age instead of extending expired recovery', () => {
    assertEqual(restarted.store.rooms.has(aged.code), false)
  })
  await restarted.close()
} finally {
  rmSync(directory, { recursive: true, force: true })
}

const expiring = createRoomServer()
const empty = createRoom(expiring.store, { code: 'EMPTYA' })
const active = createRoom(expiring.store, { code: 'ACTIVE' })
const activeSeat = joinRoom(active, { name: 'Ann', character: 'ironclad' })
startRun(active, activeSeat.token, { seed: 99 })
const journal = createRoom(expiring.store, { code: 'JOURNL' })
journal.campaignProgress = { ...journal.campaignProgress, finishedRunIds: ['finished-1'] }
for (const room of [empty, active, journal]) expiring.touch(room)
expiring.sweepRooms(Date.now() + 7 * 60 * 60 * 1000)
check('expiry removes abandoned lobbies but preserves resumable runs and campaign journals', () => {
  assertEqual(expiring.store.rooms.has(empty.code), false)
  assertEqual(expiring.store.rooms.has(active.code), true)
  assertEqual(expiring.store.rooms.has(journal.code), true)
})
expiring.sweepRooms(Date.now() + 31 * 24 * 60 * 60 * 1000)
check('resumable rooms expire after the bounded thirty-day recovery window', () => {
  assertEqual(expiring.store.rooms.has(active.code), false)
  assertEqual(expiring.store.rooms.has(journal.code), false)
})
await expiring.close()

report('campaign persistence')
