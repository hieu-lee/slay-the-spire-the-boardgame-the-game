// End-turn readiness, end-turn effect ordering, and disconnected end-turn
// settlement.

import {
  beginEndTurnResolution,
  chooseEndTurnTarget,
  resolveEndTurnAbility,
} from '../../../src/game/state.ts'
import { mandatoryCardPlayWindowOwners } from '../../../src/game/combat/queries.ts'
import { abandonCardPlayWindows } from '../../../src/game/combat/play.ts'
import { clearEndTurnOrdering, fail, publishEndTurnEffect, UID_LIMIT } from './shared.mjs'
import { resolveAbandonedPreviews, settleDiscard, settleForcedCards } from './settlement.mjs'

export function endTurn(room, seat, _action, seatToken, applyAction) {
  let combat = room.run?.combat
  if (!combat) fail('No combat in progress')
  const previewOwners = [...new Set([
    ...Object.keys(room.cardPreviews ?? {}), ...Object.keys(room.powerPreviews ?? {}),
  ])]
  if (previewOwners.includes(seat.playerId)) fail('Finish your revealed card before ending the turn')
  if (previewOwners.some((playerId) =>
    room.seats.find((candidate) => candidate.playerId === playerId)?.connected === false)) {
    if (!resolveAbandonedPreviews(room, applyAction)) fail('The disconnected revealed card could not be resolved')
    combat = room.run?.combat
    if (combat && ['won', 'lost'].includes(combat.phase)) {
      room.endTurnReady = undefined
      return { changed: true }
    }
  }
  if (room.endTurnAbilities) fail('The party is already ordering end-of-turn abilities')
  if (combat.phase !== 'player') fail('The party is not taking its turn')
  const player = combat.players.find((candidate) => candidate.id === seat.playerId)
  if (!player || player.dead) fail('This seat cannot end the turn')
  // Slayer Pack: Discovery, Violence and Deceive Reality must play their cards first.
  if (mandatoryCardPlayWindowOwners(combat).includes(seat.playerId)) fail('Play the card you must play before ending the turn')
  room.endTurnReady ??= Object.fromEntries(combat.players
    .filter((candidate) => !candidate.dead && room.seats
      .find((other) => other.playerId === candidate.id)?.connected)
    .map((candidate) => [candidate.id, false]))
  room.endTurnReady = { ...room.endTurnReady, [seat.playerId]: true }
  room.version += 1
  const waiting = settleEndTurn(room, applyAction)
  return { changed: true, waitingOn: waiting }
}

export function settleEndTurn(room, applyAction) {
  let combat = room.run?.combat
  if (!combat || combat.phase !== 'player' || !room.endTurnReady) return null
  const previewOwners = [...new Set([
    ...Object.keys(room.cardPreviews ?? {}), ...Object.keys(room.powerPreviews ?? {}),
  ])]
  const connected = new Set(room.seats.filter((seat) => seat.connected).map((seat) => seat.playerId))
  if (previewOwners.length > 0) {
    if (previewOwners.some((playerId) => connected.has(playerId)) || connected.size === 0 ||
      [...connected].some((playerId) => !room.endTurnReady[playerId])) return previewOwners
    if (!resolveAbandonedPreviews(room, applyAction)) return previewOwners
    combat = room.run?.combat
    if (!combat || !room.endTurnReady) return null
  }
  if (room.endTurnAbilities) return null
  if (!room.seats.some((seat) => seat.connected)) return null
  const waiting = combat.players
    .filter((player) => !player.dead && (room.endTurnReady[player.id] === false ||
      connected.has(player.id) && !room.endTurnReady[player.id]))
    .map((player) => player.id)
  if (waiting.length > 0) return waiting
  // Slayer Pack: A connected owner of a card-play window that must be played
  // cannot be ready (`endTurn` refuses them); a disconnected owner forfeits it
  // so the party is never stranded. The forfeit can set off a trigger (Discovery
  // discards its offer into Eviscerate): the absent owner's trigger resolves in
  // this same pass, so the turn still ends on everyone's existing votes. Any trigger
  // it sets off is the absent owner's (and a seat with its own trigger cannot vote),
  // so nothing is left pending when the turn end begins.
  const forfeits = mandatoryCardPlayWindowOwners(combat).filter((playerId) => !connected.has(playerId))
  for (const ownerId of forfeits) {
    combat = abandonCardPlayWindows(combat, ownerId)
    room.run = { ...room.run, combat }
  }
  if (forfeits.length > 0) {
    settleForcedCards(room, applyAction)
    combat = room.run?.combat
    if (!combat || combat.phase !== 'player') {
      room.endTurnReady = undefined
      return null
    }
  }
  room.run = { ...room.run, combat: beginEndTurnResolution(combat) }
  settleForcedCards(room, applyAction)
  room.endTurnReady = undefined
  publishEndTurnEffect(room)
  settleDisconnectedEndTurnEffects(room, applyAction)
  room.endTurnOrders = undefined
  // The turn end can land in the discard phase owing only a disconnected seat's Retain choice.
  return settleDiscard(room)
}

/** Uses the ordinary first legal target when an effect owner leaves the table. */
export function settleDisconnectedEndTurnEffects(room, applyAction) {
  if (!room.seats.some((seat) => seat.connected)) return
  for (let step = 0; step < UID_LIMIT; step += 1) {
    const ability = room.endTurnAbilities?.[0]
    const owner = ability && room.seats.find((seat) => seat.playerId === ability.playerId)
    const target = ability?.targets?.[0]
    if (!ability || owner?.connected !== false || !target ||
      !advanceEndTurnEffect(room, ability, target.uid, false, applyAction)) return
  }
}

function advanceEndTurnEffect(room, ability, targetUid, incrementVersion = false, applyAction) {
  const combat = room.run?.combat
  if (!combat) return false
  const next = resolveEndTurnAbility(combat, chooseEndTurnTarget(ability.id, targetUid))
  if (next === combat) return false
  room.run = { ...room.run, combat: next }
  settleForcedCards(room, applyAction)
  room.endTurnReady = undefined
  clearEndTurnOrdering(room)
  if (incrementVersion) room.version += 1
  publishEndTurnEffect(room)
  return true
}

export function resolveEndTurnEffect(room, seat, action, seatToken, applyAction) {
  const combat = room.run?.combat
  if (!combat || !room.endTurnAbilities || !room.endTurnPublicIds) {
    fail('There is no end-turn effect waiting for a target')
  }
  const ability = room.endTurnAbilities[0]
  if (!ability || ability.playerId !== seat.playerId) fail('Only the effect owner can choose its target')
  if (typeof action.abilityId !== 'string' || typeof action.targetUid !== 'string' ||
    room.endTurnPublicIds[action.abilityId] !== ability.id ||
    !ability.targets?.some((target) => target.uid === action.targetUid)) {
    fail('That end-turn effect target is no longer legal')
  }
  if (!advanceEndTurnEffect(room, ability, action.targetUid, true, applyAction)) {
    fail('That end-turn effect target is no longer legal')
  }
  settleDisconnectedEndTurnEffects(room, applyAction)
  return { changed: true }
}
