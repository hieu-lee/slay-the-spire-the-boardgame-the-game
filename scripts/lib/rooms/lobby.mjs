// Seat lifecycle, lobby configuration, campaign toggle, run start, and
// disconnect handling.

import { randomBytes } from 'node:crypto'
import {
  beginCatchUp,
  createRun,
  hasPendingRelicAcquisition,
  normalizeModifierIds,
} from '../../../src/game/state.ts'
import { normalizeCardPacks } from '../../../src/game/packs.ts'
import { validSkin } from '../../../src/game/skins.ts'
import {
  activeGiveUpVote,
  campaignUnlocks,
  CHARACTERS,
  fail,
  findSeat,
  includeSeatUnlocks,
  MAX_SEATS,
  roomCardPacks,
  token,
} from './shared.mjs'
import { deferStartTurnTriggersForPostRoll, reopenAutoReadyStartTurn } from './start-turn-plan.mjs'
import { snapshotFor } from './snapshot.mjs'
import {
  settleDiscard,
  settleDisconnectedRunChoices,
  settleForcedCards,
  settlePendingRelics,
  settlePostRollNestedChoice,
  settleReward,
} from './settlement.mjs'
import { settleDisconnectedEndTurnEffects, settleEndTurn } from './end-turn.mjs'
import { cancelImpossibleDisconnectedPledges, settleCampfire, settleMerchantReady } from './noncombat.mjs'
import { apply } from './apply.mjs'

export function joinRoom(room, { name, character, skin, campaignProgress, cardPacks, token: existing, random, connected = true, settle = true } = {}) {
  const returning = findSeat(room, existing)
  if (returning) {
    const nextName = name ? String(name).slice(0, 24) : returning.name
    const nextUnlocks = campaignProgress === undefined ? returning.campaignUnlocks : campaignUnlocks(campaignProgress)
    // A seat that reports no list keeps the packs it reported before.
    const nextPacks = cardPacks === undefined ? returning.cardPacks ?? [] : normalizeCardPacks(cardPacks)
    if (room.phase !== 'lobby' && nextName !== returning.name) fail('Names are locked once the run starts')
    // A lobby seat may change how it looks; `null` clears it. Once the run starts the look is frozen.
    const nextSkin = skin !== undefined && room.phase === 'lobby' ? validSkin(returning.character, skin) : returning.skin
    const skinChanged = nextSkin !== returning.skin
    const connectionChanged = returning.connected !== connected
    const unlocksChanged = JSON.stringify(nextUnlocks) !== JSON.stringify(returning.campaignUnlocks)
    const packsChanged = JSON.stringify(nextPacks) !== JSON.stringify(returning.cardPacks ?? [])
    if (!connectionChanged && nextName === returning.name && !unlocksChanged && !packsChanged && !skinChanged) return returning
    if (returning.pendingCatchUp && connected) {
      const next = beginCatchUp(room.run, [{ id: returning.playerId, name: nextName, character: returning.character, skin: returning.skin }])
      if (next === room.run) fail('That player cannot Catch Up now')
      room.run = next
      delete returning.pendingCatchUp
      delete returning.reservedAt
    }
    returning.connected = connected
    returning.name = nextName
    if (nextSkin) returning.skin = nextSkin
    else delete returning.skin
    if (connectionChanged && connected) reopenAutoReadyStartTurn(room, returning.playerId)
    if (nextUnlocks) returning.campaignUnlocks = nextUnlocks
    if (nextPacks.length) returning.cardPacks = nextPacks
    else delete returning.cardPacks
    if (room.phase === 'lobby') includeSeatUnlocks(room)
    room.version += 1
    // They may be the last answer the table was waiting on, or the first one
    // back to a decision that stalled while nobody was connected.
    if (settle && connectionChanged && !activeGiveUpVote(room)) {
      deferStartTurnTriggersForPostRoll(room)
      settleMerchantReady(room)
      settleCampfire(room)
      if (room.run?.phase !== 'neow') settlePendingRelics(room)
      settleReward(room, apply)
      settleEndTurn(room, apply)
      settleDisconnectedEndTurnEffects(room, apply)
      settleForcedCards(room, apply)
      settleDiscard(room)
    }
    return returning
  }

  const catchingUp = room.phase === 'run' && room.run?.act >= 2 &&
    (room.run.phase === 'map' && room.run.map.position === null ||
      room.run.phase === 'neow' && room.run.setup?.kind === 'catch-up')
  if (room.phase !== 'lobby' && !catchingUp) fail('New players may join only at the start of an Act')
  if (catchingUp && hasPendingRelicAcquisition(room.run)) fail('Finish the pending Relic acquisition first')
  if (catchingUp && room.seats.some((seat) => seat.pendingCatchUp)) fail('Another player is already joining to Catch Up')
  if (room.seats.length >= MAX_SEATS) fail('The room is full')

  const pick = character ?? CHARACTERS.find((id) => !room.seats.some((seat) => seat.character === id))
  if (!CHARACTERS.includes(pick)) fail(`Unknown character: ${pick}`)
  if (room.seats.some((seat) => seat.character === pick)) fail(`${pick} is already taken`)

  const seat = {
    // Seat order is row order, and row order decides which enemies reach whom.
    playerId: ['p1', 'p2', 'p3', 'p4'].find((id) => !room.seats.some((other) => other.playerId === id)),
    name: String(name ?? `Player ${room.seats.length + 1}`).slice(0, 24),
    character: pick,
    ...(validSkin(pick, skin) ? { skin: validSkin(pick, skin) } : {}),
    ...(campaignProgress === undefined ? {} : { campaignUnlocks: campaignUnlocks(campaignProgress) }),
    ...(normalizeCardPacks(cardPacks).length ? { cardPacks: normalizeCardPacks(cardPacks) } : {}),
    token: token(random),
    connected,
    ...(catchingUp && !connected ? { pendingCatchUp: true, reservedAt: Date.now() } : {}),
  }
  room.seats.push(seat)
  if (room.phase === 'lobby') includeSeatUnlocks(room)
  if (catchingUp && connected) {
    const next = beginCatchUp(room.run, [{ id: seat.playerId, name: seat.name, character: seat.character, skin: seat.skin }])
    if (next === room.run) {
      room.seats.pop()
      fail('That player cannot Catch Up now')
    }
    room.run = next
  }
  room.version += 1
  return seat
}

export function chooseCharacter(room, seatToken, character, skin) {
  const seat = findSeat(room, seatToken) ?? fail('Unknown seat')
  if (room.phase !== 'lobby') fail('Characters are locked once the run starts')
  if (!CHARACTERS.includes(character)) fail(`Unknown character: ${character}`)
  if (room.seats.some((other) => other !== seat && other.character === character)) {
    fail(`${character} is already taken`)
  }
  seat.character = character
  // The skin is part of the choice: one that does not belong to the new hero is cleared, not kept.
  const worn = validSkin(character, skin)
  if (worn) seat.skin = worn
  else delete seat.skin
  room.version += 1
  return snapshotFor(room, seatToken)
}

export function chooseAscension(room, seatToken, ascension) {
  findSeat(room, seatToken) ?? fail('Unknown seat')
  if (room.phase !== 'lobby') fail('Ascension is locked once the run starts')
  if (!Number.isInteger(ascension) || ascension < 0 || ascension > room.campaignProgress.highestAscension) {
    fail(`Ascension must be an unlocked integer from 0 to ${room.campaignProgress.highestAscension}`)
  }
  if (room.ascension === ascension) return snapshotFor(room, seatToken)
  room.ascension = ascension
  room.version += 1
  return snapshotFor(room, seatToken)
}

export function chooseRelicRule(room, seatToken, enabled) {
  findSeat(room, seatToken) ?? fail('Unknown seat')
  if (room.phase !== 'lobby') fail('Choose Your Relic is locked once the run starts')
  if (typeof enabled !== 'boolean') fail('Choose Your Relic must be on or off')
  if (enabled && room.seats.length < 2) fail('Choose Your Relic is multiplayer only')
  if (room.chooseYourRelic === enabled) return snapshotFor(room, seatToken)
  room.chooseYourRelic = enabled
  room.version += 1
  return snapshotFor(room, seatToken)
}

export function chooseLastStandRule(room, seatToken, enabled) {
  const seat = findSeat(room, seatToken) ?? fail('Unknown seat')
  if (room.phase !== 'lobby') fail('The Last Stand is locked once the run starts')
  if (seat !== room.seats[0]) fail('Only the party leader may change The Last Stand')
  if (typeof enabled !== 'boolean') fail('The Last Stand must be on or off')
  if (enabled && room.seats.length < 2) fail('The Last Stand is multiplayer only')
  if (room.lastStand === enabled) return snapshotFor(room, seatToken)
  room.lastStand = enabled
  room.version += 1
  return snapshotFor(room, seatToken)
}

export function chooseRunMeta(room, seatToken, options) {
  const seat = findSeat(room, seatToken) ?? fail('Unknown seat')
  if (room.phase !== 'lobby') fail('Run mode is locked once the run starts')
  if (seat !== room.seats[0]) fail('Only the party leader may change the run mode')
  const mode = options?.mode
  const quickStartAct = options?.quickStartAct
  if (!['standard', 'custom'].includes(mode) || ![1, 2, 3, 4].includes(quickStartAct)) fail('Choose a valid run mode and starting Act')
  if (quickStartAct === 4 && room.campaignProgress.actIV < 5) fail('Act IV Quick Start is not unlocked')
  room.metaOptions = { mode, modifiers: mode === 'custom' ? normalizeModifierIds(options.modifiers) : [], quickStartAct }
  room.version += 1
  return snapshotFor(room, seatToken)
}

export function removeSeat(room, seatToken) {
  const seat = findSeat(room, seatToken) ?? fail('Unknown seat')
  if (room.phase !== 'lobby' && !seat.pendingCatchUp) fail('A run seat must be preserved for reconnection')
  room.seats = room.seats.filter((candidate) => candidate !== seat)
  // A seat that leaves takes its unclaimed share of the recorded run with it.
  if (room.recordedRuns) {
    room.recordedRuns = room.recordedRuns.map((recorded) => {
      const { [seat.token]: _left, ...skips } = recorded.skips
      return { ...recorded, skips }
    }).filter((recorded) => Object.keys(recorded.skips).length > 0)
    if (room.recordedRuns.length === 0) delete room.recordedRuns
  }
  if (room.phase === 'lobby') includeSeatUnlocks(room)
  if (room.seats.length < 2) {
    room.chooseYourRelic = false
    room.lastStand = false
  }
  room.version += 1
}

export function markDisconnected(room, seatToken) {
  const seat = findSeat(room, seatToken)
  if (!seat) return snapshotFor(room, seatToken)
  seat.connected = false
  room.version += 1
  const voting = activeGiveUpVote(room)
  cancelImpossibleDisconnectedPledges(room, Boolean(voting))
  if (voting) return snapshotFor(room, seatToken)
  deferStartTurnTriggersForPostRoll(room)
  settleMerchantReady(room)
  // The party may have been waiting on exactly this player. Dropping without
  // re-checking stranded the campfire: `leaveRoom` stays refused, and the room
  // only unstuck if someone re-sent a choice they had already made.
  settleCampfire(room)
  // Neow is pre-game setup, not a shared combat/reward wait. Its private
  // Relic choices must survive a disconnect exactly like its card choices.
  settleDisconnectedRunChoices(room)
  settleReward(room, apply)
  settleEndTurn(room, apply)
  settleDisconnectedEndTurnEffects(room, apply)
  settleForcedCards(room, apply)
  settleDiscard(room)
  settlePostRollNestedChoice(room, apply)
  settleDisconnectedRunChoices(room)
  settleReward(room, apply)
  return snapshotFor(room, seatToken)
}

export function selectCampaign(room, seatToken, enabled) {
  const seat = findSeat(room, seatToken) ?? fail('Claim a seat before starting')
  if (seat !== room.seats[0]) fail('Only the party leader may choose the campaign')
  if (room.phase !== 'lobby') fail('The run has already started')
  if (typeof enabled !== 'boolean') fail('Choose whether to open the campaign picker')
  if (room.selectingCampaign === enabled) return snapshotFor(room, seatToken)
  room.selectingCampaign = enabled
  room.version += 1
  return snapshotFor(room, seatToken)
}

/**
 * Starts the run.
 *
 * `seed` is deliberately NOT taken from the client in normal play: whoever
 * picks it knows every die roll, shuffle and encounter for the entire run,
 * which is the very thing `snapshotFor` withholds the rng state to prevent.
 * Tests and playtests pass one explicitly.
 */
export function startRun(room, seatToken, { seed, campaign } = {}) {
  const seat = findSeat(room, seatToken) ?? fail('Claim a seat before starting')
  if (seat !== room.seats[0]) fail('Only the party leader may start the run')
  if (room.phase !== 'lobby') fail('The run has already started')
  if (room.seats.length === 0) fail('Nobody has claimed a seat')
  if (campaign !== undefined && !['base', 'downfall'].includes(campaign)) fail('Choose a valid campaign')

  const party = room.seats.map((seat) => ({
    id: seat.playerId,
    name: seat.name,
    character: seat.character,
    skin: seat.skin,
  }))
  if (!Number.isInteger(room.ascension) || room.ascension < 0 || room.ascension > room.campaignProgress.highestAscension) {
    fail('That Ascension is not unlocked')
  }
  room.run = createRun(seed ?? Number(BigInt('0x' + randomBytes(4).toString('hex'))), party, room.ascension, room.campaignProgress, room.chooseYourRelic && party.length > 1, room.lastStand && party.length > 1, { ...room.metaOptions, campaign, cardPacks: roomCardPacks(room) })
  room.concurrentCardCopies = undefined
  room.concurrentDistilled = undefined
  room.concurrentRelicScries = undefined
  room.concurrentForcedCards = undefined
  room.selectingCampaign = false
  room.phase = 'run'
  room.version += 1
  return snapshotFor(room, seatToken)
}
