// Start-of-turn choice resolution, before-draw Scry/Discard actions, and
// hand-size Discard submission.

import {
  CAPS,
  defaultStartTurnChoices,
  discardOrderIsValid,
  orderStartTurnScries,
  resolveStartPlayerTurn,
  resolveStartTurnDiscard,
  resolveStartTurnScry,
  startTurnAbilities,
  startTurnChoicePending,
  startTurnDiscardPreview,
  startTurnScryPreview,
} from '../../../src/game/state.ts'
import { discardNeedsChoice } from '../../../src/game/combat/end-turn.ts'
import { fail, slotList, targetList, UID_LIMIT, uidList } from './shared.mjs'
import {
  choicesBeforeNoxious,
  clearStartTurnPlan,
  dropOutdatedStagedChoices,
  ensureStartTurnReady,
  markStartTurnReady,
  mergedStartTurnChoices,
  noxiousFumesIds,
  pendingNoxiousFumes,
  plannedStartTurnAbilities,
  reopenStagedStartTurnTriggers,
  reopenStartTurnOwners,
  resetStartTurnReady,
  roomPostRollChoicePending,
  roomPostRollNestedChoicePending,
  roomStartTurnChoicePlayerIds,
  savedStartTurnChoices,
  savedStartTurnEnemyTargets,
  saveStartTurnOwnerChoices,
  startTurnAbilityNeedsChoice,
  startTurnAbilityNeedsManualChoice,
  startTurnCoordinator,
  startTurnOrderCoordinator,
  startTurnOrderPending,
  startTurnOwnerChoicesChanged,
  validStartTurnChoice,
} from './start-turn-plan.mjs'
import { snapshotFor } from './snapshot.mjs'
import {
  finishPostRollChoiceWindow,
  settleDiscard,
  settleDisconnectedStartTurnChoices,
  settleForcedCards,
} from './settlement.mjs'

export function resolveStartTurn(room, seat, action, seatToken, applyAction) {
  const result = resolveStartTurnChoices(room, seat, action, seatToken, applyAction)
  // Settling the quorum can advance the combat into a private prompt owned by a
  // disconnected seat; every exit must default it or the room waits forever.
  settleForcedCards(room, applyAction)
  return result
}

function resolveStartTurnChoices(room, seat, action, seatToken, applyAction) {
  const combat = room.run?.combat
  if (!combat || combat.phase !== 'start') fail('The party is not resolving Start-of-Turn abilities')
  if (roomPostRollNestedChoicePending(room)) fail('Finish the die Relic choice first')
  ensureStartTurnReady(room)
  if (!room.startTurnRequired?.includes(seat.playerId)) fail('Only a Start-of-Turn effect owner may resolve it')
  const choices = action.choices
  if (!Array.isArray(choices) || choices.length > UID_LIMIT || choices.some((choice) =>
    !choice || typeof choice.id !== 'string' || !Array.isArray(choice.shivEnemyUids) ||
    (choice.enemyUid !== undefined && typeof choice.enemyUid !== 'string') ||
    (choice.targetPlayerId !== undefined && typeof choice.targetPlayerId !== 'string') ||
    (choice.guardianModeShift !== undefined && typeof choice.guardianModeShift !== 'boolean') ||
    (choice.exhaustUids !== undefined && (!Array.isArray(choice.exhaustUids) ||
      choice.exhaustUids.length > UID_LIMIT || choice.exhaustUids.some((uid) => typeof uid !== 'string'))) ||
    choice.shivEnemyUids.length > CAPS.shivs ||
    choice.shivEnemyUids.some((uid) => uid !== null && typeof uid !== 'string') ||
    (choice.evokeSlots !== undefined && (!Array.isArray(choice.evokeSlots) ||
      choice.evokeSlots.length > UID_LIMIT)) ||
    (choice.evokeEnemyUids !== undefined && (!Array.isArray(choice.evokeEnemyUids) ||
      choice.evokeEnemyUids.length > UID_LIMIT)))) {
    fail('Start-of-Turn choices must contain every ability and valid targets')
  }
  const normalized = choices.map((choice) => ({
    id: choice.id,
    enemyUid: choice.enemyUid,
    targetPlayerId: choice.targetPlayerId,
    exhaustUids: uidList(choice.exhaustUids),
    guardianModeShift: choice.guardianModeShift,
    shivEnemyUids: [...choice.shivEnemyUids],
    evokeSlots: slotList(choice.evokeSlots),
    evokeEnemyUids: targetList(choice.evokeEnemyUids),
  }))
  if (roomPostRollChoicePending(room)) {
    markStartTurnReady(room, seat.playerId)
    if (room.startTurnRequired.every((playerId) => room.startTurnReady[playerId])) {
      finishPostRollChoiceWindow(room, applyAction)
      if (room.run?.combat?.phase === 'start') settleDisconnectedStartTurnChoices(room, applyAction)
    }
    room.version += 1
    return { changed: true, snapshot: snapshotFor(room, seatToken) }
  }
  const abilitiesById = new Map(plannedStartTurnAbilities(room).map((ability) => [ability.id, ability]))
  if (normalized.length !== abilitiesById.size || new Set(normalized.map((choice) => choice.id)).size !== abilitiesById.size ||
    normalized.some((choice) => !abilitiesById.has(choice.id))) {
    fail('Start-of-Turn choices must contain every ability exactly once')
  }
  const defaultsById = new Map(defaultStartTurnChoices(combat).map((choice) => [choice.id, choice]))
  const pendingFumesBefore = pendingNoxiousFumes(room)
  const orderCoordinator = startTurnOrderPending(room) ? startTurnOrderCoordinator(room) : null
  if (orderCoordinator && seat.playerId !== orderCoordinator &&
    (!pendingFumesBefore || seat.playerId !== pendingFumesBefore.playerId)) {
    const merged = mergedStartTurnChoices(room, normalized, savedStartTurnChoices(room) ?? [], seat.playerId)
    const choicesById = new Map(merged.map((choice) => [choice.id, choice]))
    // The unstaged plan hides Shiv and Evoke prompts that this owner's own picks
    // reveal, so validate against the plan recomputed with those picks.
    const planOrder = [...abilitiesById.keys()]
    const replanned = new Map(startTurnAbilities(combat, planOrder,
      planOrder.map((id) => choicesById.get(id)).filter(Boolean)).map((ability) => [ability.id, ability]))
    if ([...abilitiesById.values()].some((ability) => ability.playerId === seat.playerId &&
      startTurnAbilityNeedsManualChoice(ability) &&
      !validStartTurnChoice(replanned.get(ability.id) ?? ability, choicesById.get(ability.id)))) {
      fail('The Start-of-Turn plan changed. Review your choices and confirm again.')
    }
    const revised = startTurnOwnerChoicesChanged(room, seat.playerId, merged)
    saveStartTurnOwnerChoices(room, seat.playerId, merged)
    if (revised) resetStartTurnReady(room)
    else markStartTurnReady(room, seat.playerId)
    settleDisconnectedStartTurnChoices(room, applyAction)
    room.version += 1
    return { changed: true, snapshot: snapshotFor(room, seatToken) }
  }
  if (orderCoordinator && seat.playerId !== orderCoordinator) {
    fail('Only the start-turn order coordinator can commit the shared order')
  }
  const storedById = new Map((savedStartTurnChoices(room) ?? []).map((choice) => [choice.id, choice]))
  for (const [index, choice] of normalized.entries()) {
    const ability = abilitiesById.get(choice.id)
    if (!ability || ability.playerId === seat.playerId) continue
    normalized[index] = startTurnAbilityNeedsManualChoice(ability)
      ? storedById.get(choice.id) ?? { id: choice.id, shivEnemyUids: [], evokeSlots: [], evokeEnemyUids: [] }
      : defaultsById.get(choice.id) ?? normalized[index]
  }
  const previousPlan = {
    combatId: room.startTurnCombatId,
    order: room.startTurnOrder,
    targets: room.startTurnEnemyTargets,
    choices: room.startTurnChoices,
    ready: room.startTurnReady,
  }
  const existingOrder = room.startTurnCombatId === combat.combatId ? room.startTurnOrder : undefined
  if (existingOrder && normalized.some((choice, index) => choice.id !== existingOrder[index])) {
    fail('The Start-of-Turn order is already committed')
  }
  if (startTurnOrderPending(room)) {
    const order = normalized.map((choice) => choice.id)
    if (startTurnAbilities(combat, order).length !== startTurnAbilities(combat).length) {
      fail('Start-of-Turn choices must contain every ability and valid targets')
    }
    room.startTurnCombatId = combat.combatId
    room.startTurnOrder = order
    room.startTurnEnemyTargets = undefined
    const orderedAbilities = startTurnAbilities(combat, order, normalized)
    const orderedById = new Map(orderedAbilities.map((ability) => [ability.id, ability]))
    const committedChoices = normalized.filter((choice) => {
      const ability = orderedById.get(choice.id)
      return ability?.playerId === seat.playerId && startTurnAbilityNeedsManualChoice(ability)
    })
    room.startTurnRequired = [...new Set([
      seat.playerId, ...roomStartTurnChoicePlayerIds(room, orderedAbilities, true, committedChoices),
    ])]
    room.startTurnReady = Object.fromEntries(room.startTurnRequired
      .map((playerId) => [playerId, room.startTurnReady?.[playerId] === true]))
    dropOutdatedStagedChoices(room, combat, order, seat.playerId)
    settleDisconnectedStartTurnChoices(room, applyAction)
    const fumes = pendingNoxiousFumes(room)
    if (fumes) {
      const stagedChoices = choicesBeforeNoxious(combat, order, normalized, fumes.id, seat.playerId)
      saveStartTurnOwnerChoices(room, seat.playerId, stagedChoices)
      // The staged prefix can leave Fumes one forced target; then nothing is left to ask.
      if (room.run?.combat !== combat || pendingNoxiousFumes(room)) {
        if (!plannedStartTurnAbilities(room).some((ability) => ability.playerId === seat.playerId &&
          startTurnAbilityNeedsChoice(ability, savedStartTurnEnemyTargets(room),
            new Set((savedStartTurnChoices(room) ?? []).map((choice) => choice.id))))) {
          markStartTurnReady(room, seat.playerId)
          // This may complete the quorum while the remaining owners are away.
          settleDisconnectedStartTurnChoices(room, applyAction)
        }
        room.version += 1
        return { changed: true, snapshot: snapshotFor(room, seatToken) }
      }
      const forced = startTurnAbilities(combat, order, normalized).find((ability) => ability.id === fumes.id)
      const fumesChoice = normalized.find((choice) => choice.id === fumes.id)
      if (fumesChoice && forced?.targets?.length === 1) fumesChoice.enemyUid = forced.targets[0].uid
    }
  }
  const pendingFumes = pendingNoxiousFumes(room)
  if (pendingFumes?.playerId === seat.playerId) {
    const order = normalized.map((choice) => choice.id)
    const prefixChoices = existingOrder
      ? savedStartTurnChoices(room) ?? []
      : choicesBeforeNoxious(combat, order, normalized, pendingFumes.id, seat.playerId)
    const ownerChoices = normalized.map((choice) => choice.id === pendingFumes.id ? choice : ({
      id: choice.id, shivEnemyUids: [], evokeSlots: [], evokeEnemyUids: [],
    }))
    const stagedChoices = mergedStartTurnChoices(room, ownerChoices, prefixChoices)
    const plannedFumes = startTurnAbilities(combat, order, stagedChoices)
      .find((ability) => ability.id === pendingFumes.id)
    const target = normalized.find((choice) => choice.id === pendingFumes.id)?.enemyUid
    if (!plannedFumes?.targets?.some((candidate) => candidate.uid === target)) {
      fail('Choose a living enemy for Noxious Fumes')
    }
    const savedTargets = savedStartTurnEnemyTargets(room)
    room.startTurnCombatId = combat.combatId
    room.startTurnOrder = order
    saveStartTurnOwnerChoices(room, seat.playerId, prefixChoices)
    room.startTurnEnemyTargets = { ...savedTargets, [pendingFumes.id]: target }
    const staged = mergedStartTurnChoices(room, ownerChoices)
    const stagedById = new Map(staged.map((choice) => [choice.id, choice]))
    const remainingChoice = plannedStartTurnAbilities(room).some((ability) =>
      startTurnChoicePending(ability, stagedById.get(ability.id)))
    if (pendingNoxiousFumes(room) || remainingChoice) {
      // The Fumes target can reveal a prompt (Evoke, Shiv overflow) for a seat that already answered.
      const revealed = new Set(plannedStartTurnAbilities(room).filter((ability) =>
        ability.playerId !== seat.playerId && startTurnChoicePending(ability, stagedById.get(ability.id)))
        .map((ability) => ability.playerId))
      if (revealed.size > 0) reopenStartTurnOwners(room, revealed)
      if (!plannedStartTurnAbilities(room).some((ability) => ability.playerId === seat.playerId &&
        startTurnAbilityNeedsChoice(ability, savedStartTurnEnemyTargets(room),
          new Set((savedStartTurnChoices(room) ?? []).map((choice) => choice.id))))) {
        markStartTurnReady(room, seat.playerId)
        // This may complete the quorum while the remaining owners are away.
        settleDisconnectedStartTurnChoices(room, applyAction)
      }
      room.version += 1
      return { changed: true, snapshot: snapshotFor(room, seatToken) }
    }
  }
  const saved = savedStartTurnEnemyTargets(room)
  const resolvedChoices = mergedStartTurnChoices(room, normalized, undefined, seat.playerId).map((choice) => saved[choice.id] &&
    abilitiesById.get(choice.id)?.playerId !== seat.playerId
    ? { ...choice, enemyUid: saved[choice.id] }
    : choice)
  const resolvedById = new Map(resolvedChoices.map((choice) => [choice.id, choice]))
  const resolvedAbilities = startTurnAbilities(combat, resolvedChoices.map((choice) => choice.id), resolvedChoices)
  if ([...abilitiesById.values()].some((ability) => ability.playerId === seat.playerId &&
    startTurnAbilityNeedsManualChoice(ability) && !validStartTurnChoice(
      resolvedAbilities.find((candidate) => candidate.id === ability.id) ?? ability,
      resolvedById.get(ability.id),
    ))) {
    // An answered seat's staged pick that no longer fits can block the plan this
    // seat sees (its Shiv or Evoke prompt stays hidden); reopen that seat first.
    const stagedIds = new Set((savedStartTurnChoices(room) ?? []).map((choice) => choice.id))
    const outdated = resolvedAbilities.filter((ability, index) => ability.playerId !== seat.playerId &&
      stagedIds.has(ability.id) && !validStartTurnChoice(ability, resolvedChoices[index]))
    if (outdated.length > 0) {
      saveStartTurnOwnerChoices(room, seat.playerId, resolvedChoices)
      const dropped = new Set(outdated.map((ability) => ability.id))
      room.startTurnChoices = (savedStartTurnChoices(room) ?? []).filter((choice) => !dropped.has(choice.id))
      reopenStartTurnOwners(room, new Set(outdated.map((ability) => ability.playerId)))
      settleDisconnectedStartTurnChoices(room, applyAction)
      room.version += 1
      return { changed: true, snapshot: snapshotFor(room, seatToken) }
    }
    room.startTurnCombatId = previousPlan.combatId
    room.startTurnOrder = previousPlan.order
    room.startTurnEnemyTargets = previousPlan.targets
    room.startTurnChoices = previousPlan.choices
    room.startTurnReady = previousPlan.ready
    fail('The Start-of-Turn plan changed. Review your choices and confirm again.')
  }
  room.startTurnCombatId = combat.combatId
  room.startTurnOrder ??= resolvedChoices.map((choice) => choice.id)
  const revisedTarget = resolvedChoices.some((choice) => abilitiesById.get(choice.id)?.playerId === seat.playerId &&
    saved[choice.id] !== undefined && choice.enemyUid !== saved[choice.id])
  const revised = revisedTarget || startTurnOwnerChoicesChanged(room, seat.playerId, resolvedChoices)
  if (revisedTarget) room.startTurnEnemyTargets = {
    ...room.startTurnEnemyTargets,
    ...Object.fromEntries(resolvedChoices.flatMap((choice) =>
      abilitiesById.get(choice.id)?.playerId === seat.playerId && saved[choice.id] !== undefined && choice.enemyUid
        ? [[choice.id, choice.enemyUid]] : [])),
  }
  saveStartTurnOwnerChoices(room, seat.playerId, resolvedChoices)
  if (revised) resetStartTurnReady(room)
  else markStartTurnReady(room, seat.playerId)
  settleDisconnectedStartTurnChoices(room, applyAction)
  if (room.run?.combat !== combat) {
    room.version += 1
    return { changed: true, snapshot: snapshotFor(room, seatToken) }
  }
  if (!room.startTurnRequired.every((playerId) => room.startTurnReady[playerId])) {
    room.version += 1
    return { changed: true, snapshot: snapshotFor(room, seatToken) }
  }
  const stored = new Map((savedStartTurnChoices(room) ?? []).map((choice) => [choice.id, choice]))
  const defaults = new Map(defaultStartTurnChoices(combat).map((choice) => [choice.id, choice]))
  const finalChoices = (room.startTurnOrder ?? resolvedChoices.map((choice) => choice.id))
    .map((id) => stored.get(id) ?? defaults.get(id)).filter(Boolean)
    .map((choice) => room.startTurnEnemyTargets?.[choice.id]
      ? { ...choice, enemyUid: room.startTurnEnemyTargets[choice.id] }
      : choice)
  const next = resolveStartPlayerTurn(combat, finalChoices)
  if (next === combat) {
    const fumesIds = noxiousFumesIds(combat)
    const staleFumes = new Set(startTurnAbilities(combat, finalChoices.map((choice) => choice.id), finalChoices)
      .filter((ability) => fumesIds.has(ability.id) && saved[ability.id] && ability.enemyTargetStale)
      .map((ability) => ability.id))
    if (staleFumes.size > 0) {
      room.startTurnCombatId = combat.combatId
      room.startTurnOrder = finalChoices.map((choice) => choice.id)
      room.startTurnEnemyTargets = Object.fromEntries(Object.entries(room.startTurnEnemyTargets ?? {})
        .filter(([id]) => !staleFumes.has(id)))
      const owners = new Set(startTurnAbilities(combat)
        .filter((ability) => staleFumes.has(ability.id)).map((ability) => ability.playerId))
      room.startTurnReady = Object.fromEntries(Object.entries(room.startTurnReady ?? {})
        .map(([playerId, ready]) => [playerId, owners.has(playerId) ? false : ready]))
      settleDisconnectedStartTurnChoices(room, applyAction)
      room.version += 1
      return { changed: true, snapshot: snapshotFor(room, seatToken) }
    }
    if (reopenStagedStartTurnTriggers(room, finalChoices)) {
      settleForcedCards(room, applyAction)
      room.version += 1
      return { changed: true, snapshot: snapshotFor(room, seatToken) }
    }
    // A staged choice that an earlier ability or a reorder made illegal belongs to
    // another seat; reopen that seat instead of failing the last submitter.
    const planned = startTurnAbilities(combat, finalChoices.map((choice) => choice.id), finalChoices)
    const invalid = planned.filter((ability, index) => !validStartTurnChoice(ability, finalChoices[index]))
    // The submitter's own malformed payload is still refused; only plan drift is repaired.
    const drifted = (ability) => ability.enemyTargetStale || ability.staleShivIndex !== undefined ||
      ability.evokeTargetIndex !== undefined
    if (invalid.length > 0 && invalid.every((ability) => ability.playerId !== seat.playerId || drifted(ability))) {
      const owners = new Set(invalid.map((ability) => ability.playerId))
      const staleTargets = new Set(invalid.filter((ability) => ability.enemyTargetStale).map((ability) => ability.id))
      // Other owners' picks the plan no longer admits are asked again from scratch.
      const outdated = new Set(invalid.filter((ability) => ability.playerId !== seat.playerId &&
        !ability.enemyTargetStale).map((ability) => ability.id))
      room.startTurnChoices = (savedStartTurnChoices(room) ?? []).filter((choice) => !outdated.has(choice.id))
        .map((choice) => staleTargets.has(choice.id) ? { ...choice, enemyUid: undefined } : choice)
      room.startTurnEnemyTargets = Object.fromEntries(Object.entries(room.startTurnEnemyTargets ?? {})
        .filter(([id]) => !staleTargets.has(id)))
      reopenStartTurnOwners(room, owners)
      settleDisconnectedStartTurnChoices(room, applyAction)
      room.version += 1
      return { changed: true, snapshot: snapshotFor(room, seatToken) }
    }
    room.startTurnCombatId = previousPlan.combatId
    room.startTurnOrder = previousPlan.order
    room.startTurnEnemyTargets = previousPlan.targets
    room.startTurnChoices = previousPlan.choices
    room.startTurnReady = previousPlan.ready
    fail('The Start-of-Turn plan changed. Review your choices and confirm again.')
  }
  room.run = { ...room.run, combat: next }
  clearStartTurnPlan(room)
  settleForcedCards(room, applyAction)
  room.version += 1
  return { changed: true, snapshot: snapshotFor(room, seatToken) }
}

export function resolveBeforeDrawScry(room, seat, action, seatToken, applyAction) {
  const combat = room.run?.combat
  const preview = combat && startTurnScryPreview(combat)
  if (!combat || !preview) fail('The party is not resolving a pre-draw Scry')
  if (preview.playerId !== seat.playerId) fail('Only the Scry owner may see or resolve these cards')
  if (action.sourceId !== preview.id || !Array.isArray(action.discardUids) ||
    action.discardUids.length > preview.amount ||
    action.discardUids.some((uid) => typeof uid !== 'string')) {
    fail('Scry discards must name revealed cards')
  }
  const next = resolveStartTurnScry(combat, seat.playerId, action.sourceId, action.discardUids)
  if (next === combat) fail('The Scry choice is stale')
  room.run = { ...room.run, combat: next }
  settleForcedCards(room, applyAction)
  room.version += 1
  return { changed: true, snapshot: snapshotFor(room, seatToken) }
}

export function resolvePrivateStartTurnDiscard(room, seat, action, seatToken, applyAction) {
  const combat = room.run?.combat
  const preview = combat && startTurnDiscardPreview(combat)
  if (!combat || !preview) fail('The party is not resolving a start-turn discard')
  if (preview.playerId !== seat.playerId) fail('Only the discard owner may see or resolve these cards')
  if (action.sourceId !== preview.sourceId || typeof action.discardUid !== 'string') {
    fail('The discard must name one card in hand')
  }
  const next = resolveStartTurnDiscard(combat, seat.playerId, action.sourceId, action.discardUid)
  if (next === combat) fail('The discard choice is stale')
  room.run = { ...room.run, combat: next }
  settleForcedCards(room, applyAction)
  room.version += 1
  return { changed: true, snapshot: snapshotFor(room, seatToken) }
}

export function orderBeforeDrawScries(room, seat, action, seatToken, applyAction) {
  const combat = room.run?.combat
  if (!combat || combat.phase !== 'start') fail('The party is not ordering pre-draw Scries')
  const coordinator = startTurnCoordinator(room)
  if (seat.playerId !== coordinator) fail('Only the start-turn coordinator can resolve the order')
  if (!Array.isArray(action.order) || action.order.length > UID_LIMIT ||
    action.order.some((id) => typeof id !== 'string')) fail('Scry order must name every ability once')
  const next = orderStartTurnScries(combat, action.order)
  if (next === combat) fail('The pre-draw Scry order is stale')
  room.run = { ...room.run, combat: next }
  settleForcedCards(room, applyAction)
  room.version += 1
  return { changed: true, snapshot: snapshotFor(room, seatToken) }
}

export function submitDiscard(room, seat, action, seatToken) {
  const combat = room.run?.combat
  if (!combat || combat.phase !== 'discard') fail('The party is not ordering discards')
  const player = combat.players.find((candidate) => candidate.id === seat.playerId)
  if (!player || player.dead) fail('This seat cannot discard')
  if (!discardNeedsChoice(player)) fail('This player has no end-turn discard choice')
  if (!Array.isArray(action.discardOrder) || action.discardOrder.length > player.hand.length ||
      action.discardOrder.some((uid) => typeof uid !== 'string')) fail('Discard order must match your hand')
  const order = [...action.discardOrder]
  if (!discardOrderIsValid(player, order)) fail('Discard order may omit only cards this player can Retain')
  room.endTurnOrders = { ...room.endTurnOrders, [seat.playerId]: order }
  room.version += 1
  const waiting = settleDiscard(room, true)
  return { changed: true, waitingOn: waiting, snapshot: snapshotFor(room, seatToken) }
}
