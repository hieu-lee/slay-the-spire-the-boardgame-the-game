import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply, chooseLastStandRule, createRoom, createStore, joinRoom, saveStore, startRun } from './lib/rooms.mjs'
import { resolveCardRewards } from '../src/game/state.ts'
import { reservePrismaticDraws } from '../src/game/run/rewards.ts'
import { createRoomServer } from './room-server.mjs'
import { suite, check, assertDeepEqual, assertEqual, report } from './lib/harness.mjs'

suite('campaign persistence')

const directory = mkdtempSync(join(tmpdir(), 'sts-campaign-'))
try {
  const file = join(directory, 'rooms.json')
  const store = createStore({ file })
  const room = createRoom(store, { code: 'ABCDEF' })
  const seat = joinRoom(room, { name: 'Ann', character: 'ironclad' })
  joinRoom(room, { name: 'Bo', character: 'silent' })
  room.chooseYourRelic = true
  chooseLastStandRule(room, seat.token, true)
  startRun(room, seat.token, { seed: 7331 })
  room.campaignProgress = { ...room.campaignProgress, colorless: 3, actIV: 5, highestAscension: 4 }
  room.run.campaignProgress = room.campaignProgress
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
    assertEqual(restored.lastStand, true)
    assertEqual(restored.run.lastStand, true)
  })

  const pending = createRoom(store, { code: 'PENDNG' })
  const pendingOwner = joinRoom(pending, { name: 'Owner', character: 'ironclad' })
  const pendingPeer = joinRoom(pending, { name: 'Peer', character: 'silent' })
  startRun(pending, pendingOwner.token, { seed: 7330 })
  pending.run = {
    ...pending.run,
    phase: 'map',
    neow: null,
    players: pending.run.players.map((player) => player.id === pendingOwner.playerId
      ? { ...player, relics: [...player.relics, { defId: 'war_paint', spent: false, pending: true }] }
      : player),
  }
  const skillUid = pending.run.players.find((player) => player.id === pendingOwner.playerId).deck
    .find((card) => card.defId.startsWith('defend_')).uid
  saveStore(store)
  const pendingRestored = createStore({ file }).rooms.get('PENDNG')
  joinRoom(pendingRestored, { token: pendingPeer.token })
  check('the first peer to reconnect settles another disconnected owner’s pending Relic', () => {
    const owner = pendingRestored.run.players.find((player) => player.id === pendingOwner.playerId)
    assertEqual(owner.deck.find((card) => card.uid === skillUid).upgraded, true)
    assertEqual(owner.relics.some((relic) => relic.pending), false)
  })

  const legacy = createRoom(store, { code: 'LEGACY' })
  legacy.campaignProgress = { ...legacy.campaignProgress, characters: { ...legacy.campaignProgress.characters, ironclad: 4 }, nextRunNumber: 7 }
  const legacySeat = joinRoom(legacy, { name: 'Lee', character: 'ironclad' })
  startRun(legacy, legacySeat.token, { seed: 7332 })
  delete legacy.run.campaignProgress
  legacy.run.combat = { potionLimit: undefined }
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
    assertEqual(migratedLegacy.lastStand, false)
    assertEqual(migratedLegacy.run.lastStand, false)
    assertEqual(migratedLegacy.run.campaignProgress.characters.ironclad, 4)
    assertEqual(migratedLegacy.run.campaignProgress.nextRunNumber, 8)
    assertEqual(migratedLegacy.run.combat.potionLimit, 3)
    migratedLegacy.run.combat = null
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

  const legacyBoss = createRoom(store, { code: 'OLDBOS' })
  const bossSeats = [
    joinRoom(legacyBoss, { name: 'Hidden', character: 'ironclad' }),
    joinRoom(legacyBoss, { name: 'Shown', character: 'silent' }),
    joinRoom(legacyBoss, { name: 'Reserved', character: 'defect' }),
    joinRoom(legacyBoss, { name: 'Transformed', character: 'watcher' }),
  ]
  startRun(legacyBoss, bossSeats[0].token, { seed: 7342 })
  legacyBoss.run.phase = 'reward'
  legacyBoss.run.act = 2
  legacyBoss.run.neow = null
  legacyBoss.run.rewardDestination = 'victory'
  legacyBoss.run.players[0].cardRewards = []
  legacyBoss.run.players[0].relics.push({ defId: 'prismatic_shard', spent: false })
  const originalBossCards = legacyBoss.run.players.map((player) => [...player.cardRewards])
  const originalBossRares = legacyBoss.run.players.map((player) => [...player.rareRewards])
  legacyBoss.run.rewards = legacyBoss.run.players.map((player, index) => ({
    playerId: player.id,
    cardReward: index === 1 || index === 2,
    transformReward: index === 3,
    choices: index === 1 || index === 2 ? originalBossCards[index].slice(0, 3) : null,
    upgraded: false,
    cardsDrawn: index === 1 || index === 2 ? originalBossCards[index].slice(0, 3) : undefined,
    raresDrawn: index === 1 || index === 2 ? [] : undefined,
    drawsReserved: index === 2 || undefined,
    potion: false,
    relic: false,
    bossRelics: index === 2 ? false : ['orrery'],
  }))
  legacyBoss.run.players[2].cardRewards = originalBossCards[2].slice(3)
  legacyBoss.rewardChoices = Object.fromEntries(bossSeats.slice(1).map((seat) => [seat.playerId, 0]))
  legacyBoss.rewardConfirmed = Object.fromEntries(bossSeats.slice(1).map((seat) => [seat.playerId, true]))

  const legacyPrismatic = createRoom(store, { code: 'OLDPRI' })
  const prismaticSeat = joinRoom(legacyPrismatic, { name: 'Prismatic', character: 'ironclad' })
  startRun(legacyPrismatic, prismaticSeat.token, { seed: 7343 })
  legacyPrismatic.run.players[0].relics.push({ defId: 'prismatic_shard', spent: false })
  legacyPrismatic.run.phase = 'reward'
  legacyPrismatic.run.neow = null
  legacyPrismatic.run.rewardDestination = 'victory'
  legacyPrismatic.run.rewards = [{
    playerId: prismaticSeat.playerId,
    cardReward: true,
    choices: null,
    upgraded: false,
    prismatic: true,
    availableSources: ['ironclad', 'silent', 'defect', 'watcher', 'colorless'],
    potion: false,
    relic: false,
    bossRelics: ['orrery'],
  }]
  const prismaticSources = ['ironclad', 'silent', 'defect']
  apply(legacyPrismatic, prismaticSeat.token, { kind: 'cardReward', choice: 'reveal', sources: prismaticSources })
  const sourceDeck = (run, source, rare) => run.players.find((player) => player.character === source)?.[rare ? 'rareRewards' : 'cardRewards'] ??
    run.itemDecks[rare ? 'characterRares' : 'characterCards'][source]
  const expectedPrismaticDecks = Object.fromEntries(legacyPrismatic.run.rewards[0].prismaticDraws.map((draw) => [draw.source, {
    cards: draw.cardId === 'golden_ticket'
      ? [...sourceDeck(legacyPrismatic.run, draw.source, false)]
      : [...sourceDeck(legacyPrismatic.run, draw.source, false), draw.cardId],
    rares: draw.rareId
      ? [...sourceDeck(legacyPrismatic.run, draw.source, true), draw.rareId]
      : [...sourceDeck(legacyPrismatic.run, draw.source, true)],
  }]))

  const legacySettled = createRoom(store, { code: 'OLDSET' })
  const settledSeat = joinRoom(legacySettled, { name: 'Settled', character: 'ironclad' })
  startRun(legacySettled, settledSeat.token, { seed: 7344 })
  legacySettled.run.phase = 'reward'
  legacySettled.run.neow = null
  legacySettled.run.rewardDestination = 'victory'
  const settledPlayer = legacySettled.run.players[0]
  settledPlayer.cardRewards = ['anger', 'cleave', 'shrug_it_off', ...settledPlayer.cardRewards]
  const settledDraws = settledPlayer.cardRewards.slice(0, 3)
  settledPlayer.cardRewards = [...settledPlayer.cardRewards.slice(3), ...settledDraws.slice(1)]
  settledPlayer.deck.push({ uid: 'legacy-selected', defId: settledDraws[0], upgraded: false })
  legacySettled.run.rewards = [{
    playerId: settledSeat.playerId,
    cardReward: false,
    choices: settledDraws,
    upgraded: false,
    cardsDrawn: settledDraws,
    raresDrawn: [],
    drawsReserved: true,
    potion: false,
    relic: false,
    bossRelics: ['orrery'],
  }]
  const expectedSettledPlayer = structuredClone(settledPlayer)

  const legacySettledPrismatic = createRoom(store, { code: 'OLDSPR' })
  const settledPrismaticSeat = joinRoom(legacySettledPrismatic, { name: 'Settled Prism', character: 'ironclad' })
  startRun(legacySettledPrismatic, settledPrismaticSeat.token, { seed: 7345 })
  legacySettledPrismatic.run.players[0].relics.push({ defId: 'prismatic_shard', spent: false })
  legacySettledPrismatic.run.phase = 'reward'
  legacySettledPrismatic.run.neow = null
  legacySettledPrismatic.run.rewardDestination = 'victory'
  legacySettledPrismatic.run.rewards = [{
    playerId: settledPrismaticSeat.playerId,
    cardReward: true,
    choices: null,
    upgraded: false,
    prismatic: true,
    availableSources: ['ironclad', 'silent', 'defect', 'watcher', 'colorless'],
    potion: false,
    relic: false,
    bossRelics: ['orrery'],
  }]
  apply(legacySettledPrismatic, settledPrismaticSeat.token,
    { kind: 'cardReward', choice: 'reveal', sources: prismaticSources })
  const settledPrismaticOffer = structuredClone(legacySettledPrismatic.run.rewards[0])
  apply(legacySettledPrismatic, settledPrismaticSeat.token, { kind: 'bossRelicReward', choice: 'skip' })
  apply(legacySettledPrismatic, settledPrismaticSeat.token, { kind: 'cardReward', choice: 0 })
  apply(legacySettledPrismatic, settledPrismaticSeat.token, { kind: 'cardReward', choice: 'confirm' })
  const expectedSettledPrismaticPlayers = structuredClone(legacySettledPrismatic.run.players)
  const expectedSettledPrismaticItems = structuredClone(legacySettledPrismatic.run.itemDecks)
  legacySettledPrismatic.run.phase = 'reward'
  legacySettledPrismatic.run.rewardDestination = 'victory'
  legacySettledPrismatic.run.rewards = [{ ...settledPrismaticOffer, cardReward: false, bossRelics: ['orrery'] }]

  const reversePrismatic = createRoom(store, { code: 'OLDREV' })
  const reverseSeats = [
    joinRoom(reversePrismatic, { name: 'First seat', character: 'ironclad' }),
    joinRoom(reversePrismatic, { name: 'First reveal', character: 'silent' }),
  ]
  startRun(reversePrismatic, reverseSeats[0].token, { seed: 7346 })
  reversePrismatic.run.phase = 'reward'
  reversePrismatic.run.neow = null
  reversePrismatic.run.rewardDestination = 'victory'
  for (const player of reversePrismatic.run.players) player.relics.push({ defId: 'prismatic_shard', spent: false })
  reversePrismatic.run.rewards = reversePrismatic.run.players.map((player) => ({
    playerId: player.id,
    cardReward: true,
    choices: null,
    upgraded: false,
    prismatic: true,
    availableSources: ['ironclad', 'silent', 'defect', 'watcher', 'colorless'],
    potion: false,
    relic: false,
    bossRelics: false,
  }))
  apply(reversePrismatic, reverseSeats[1].token,
    { kind: 'cardReward', choice: 'reveal', sources: prismaticSources })
  apply(reversePrismatic, reverseSeats[0].token,
    { kind: 'cardReward', choice: 'reveal', sources: prismaticSources })
  const normallySkippedReversePrismatic = resolveCardRewards(structuredClone(reversePrismatic.run),
    Object.fromEntries(reverseSeats.map((seat) => [seat.playerId, null])))

  const mixedRewards = createRoom(store, { code: 'OLDMIX' })
  const mixedSeats = [
    joinRoom(mixedRewards, { name: 'Ordinary', character: 'ironclad' }),
    joinRoom(mixedRewards, { name: 'Prismatic', character: 'silent' }),
  ]
  startRun(mixedRewards, mixedSeats[0].token, { seed: 7347 })
  mixedRewards.run.phase = 'reward'
  mixedRewards.run.neow = null
  mixedRewards.run.rewardDestination = 'victory'
  mixedRewards.run.players[0].cardRewards = ['golden_ticket', 'anger', 'cleave', ...mixedRewards.run.players[0].cardRewards]
  mixedRewards.run.players[1].relics.push({ defId: 'prismatic_shard', spent: false })
  mixedRewards.run.rewards = mixedRewards.run.players.map((player, index) => ({
    playerId: player.id,
    cardReward: true,
    choices: null,
    upgraded: false,
    prismatic: index === 1,
    availableSources: index === 1 ? ['ironclad', 'silent', 'defect', 'watcher', 'colorless'] : undefined,
    potion: false,
    relic: false,
    bossRelics: false,
  }))
  const originalMixedDecks = Object.fromEntries(prismaticSources.map((source) => [source, {
    cards: [...sourceDeck(mixedRewards.run, source, false)].sort(),
    rares: [...sourceDeck(mixedRewards.run, source, true)].sort(),
  }]))
  apply(mixedRewards, mixedSeats[0].token, { kind: 'cardReward', choice: 'reveal' })
  const oldPrismaticReveal = reservePrismaticDraws(mixedRewards.run, prismaticSources, false)
  mixedRewards.run = {
    ...oldPrismaticReveal.state,
    rewards: oldPrismaticReveal.state.rewards.map((offer) => offer.playerId === mixedSeats[1].playerId ? {
      ...offer,
      choices: oldPrismaticReveal.choices,
      prismaticSources,
      prismaticDraws: oldPrismaticReveal.draws,
    } : offer),
  }
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

  const bossMigrated = createStore({ file }).rooms.get('OLDBOS')
  check('restart migrates empty, revealed, reserved, and Transformed legacy boss rewards to Rare Rewards', () => {
    assertEqual(bossMigrated.rewardChoices, undefined)
    assertEqual(bossMigrated.rewardConfirmed, undefined)
    assertEqual(bossMigrated.run.rewards.every((offer) => offer.cardSource === 'rare' && offer.choices === null), true)
    assertEqual(bossMigrated.run.rewards[0].prismatic, true)
    assertDeepEqual(bossMigrated.run.rewards[0].availableSources,
      ['ironclad', 'silent', 'defect', 'watcher'])
    for (const [index, player] of bossMigrated.run.players.entries()) {
      const cards = index === 1 || index === 2
        ? [...originalBossCards[index].slice(3), ...originalBossCards[index].slice(0, 3)]
        : originalBossCards[index]
      assertDeepEqual(player.cardRewards, cards)
      assertDeepEqual(player.rareRewards, originalBossRares[index])
    }
    for (const seat of bossSeats) joinRoom(bossMigrated, { token: seat.token })
    for (const [offset, seat] of bossSeats.slice(1).entries()) {
      const index = offset + 1
      apply(bossMigrated, seat.token, { kind: 'cardReward', choice: 'reveal' })
      assertDeepEqual(bossMigrated.run.rewards[index].choices, originalBossRares[index].slice(0, 3))
    }
    const sources = ['ironclad', 'silent', 'defect']
    const choices = sources.map((source) => {
      const owner = bossMigrated.run.players.find((player) => player.character === source)
      const revealed = bossMigrated.run.rewards.find((offer) => offer.playerId === owner?.id)?.raresDrawn?.length ?? 0
      return sourceDeck(bossMigrated.run, source, true)[revealed]
    })
    apply(bossMigrated, bossSeats[0].token, { kind: 'cardReward', choice: 'reveal', sources })
    assertDeepEqual(bossMigrated.run.rewards[0].choices, choices)
  })

  const prismaticMigrated = createStore({ file }).rooms.get('OLDPRI')
  check('restart bottoms stale Prismatic draws without disturbing the remaining hidden order', () => {
    const offer = prismaticMigrated.run.rewards[0]
    assertEqual(offer.cardSource, 'rare')
    assertEqual(offer.choices, null)
    assertDeepEqual(offer.availableSources,
      ['ironclad', 'silent', 'defect', 'watcher'])
    for (const source of prismaticSources) {
      assertDeepEqual(sourceDeck(prismaticMigrated.run, source, false), expectedPrismaticDecks[source].cards)
      assertDeepEqual(sourceDeck(prismaticMigrated.run, source, true), expectedPrismaticDecks[source].rares)
    }
  })

  check('restart leaves already-settled ordinary and Prismatic boss draws untouched', () => {
    const ordinary = createStore({ file }).rooms.get('OLDSET')
    const prismatic = createStore({ file }).rooms.get('OLDSPR')
    assertDeepEqual(ordinary.run.players[0], expectedSettledPlayer)
    assertEqual(ordinary.run.rewards[0].cardReward, true)
    assertEqual(ordinary.run.rewards[0].cardSource, 'rare')
    assertDeepEqual(prismatic.run.players, expectedSettledPrismaticPlayers)
    assertDeepEqual(prismatic.run.itemDecks, expectedSettledPrismaticItems)
    assertEqual(prismatic.run.rewards[0].cardReward, true)
    assertEqual(prismatic.run.rewards[0].cardSource, 'rare')
  })

  check('reverse overlapping Prismatic reveals migrate exactly like normal simultaneous skips', () => {
    const migrated = createStore({ file }).rooms.get('OLDREV').run
    assertDeepEqual(migrated.players, normallySkippedReversePrismatic.players)
    assertDeepEqual(migrated.itemDecks, normallySkippedReversePrismatic.itemDecks)
  })

  check('genuine legacy mixed ordinary and Prismatic Golden Ticket overlap conserves every card', () => {
    const migrated = createStore({ file }).rooms.get('OLDMIX').run
    for (const source of prismaticSources) {
      assertDeepEqual([...sourceDeck(migrated, source, false)].sort(), originalMixedDecks[source].cards)
      assertDeepEqual([...sourceDeck(migrated, source, true)].sort(), originalMixedDecks[source].rares)
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
