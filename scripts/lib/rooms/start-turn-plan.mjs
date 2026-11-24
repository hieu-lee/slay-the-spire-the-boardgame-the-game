// Start-of-turn planning caches, post-roll item window state, choice
// validation, coordinator election, and auto-ready tracking.

import {
  defaultStartTurnChoices,
  mandatoryChoicePending,
  resolvePendingTrigger,
  startTurnAbilities,
  startTurnChoicePending,
  startTurnScryAbilities,
} from '../../../src/game/state.ts'
import {
  hasPostRollStartTurnChoice,
  isPostRollStartTurnPotionChoice,
  isPostRollStartTurnRelicChoice,
} from '../../../src/game/combat.ts'
import {
  continueStartTurn,
  stageStartTurnTriggerChoice,
  startTurnChoicePlayerIds,
  startTurnOrderChoicePlayerId,
} from '../../../src/game/combat/start-turn.ts'
import { fail, prioritizePendingTrigger } from './shared.mjs'

/** Seats the server readied with fallback picks while they were away. */
export function rememberAutoReadyStartTurn(room, playerIds) {
  const unanswered = [...playerIds].filter((playerId) => !room.startTurnReady?.[playerId])
  room.startTurnAutoReady = [...new Set([...(room.startTurnAutoReady ?? []), ...unanswered])]
}

/**
 * A returning seat never answered for itself: hand its Start-of-Turn decision
 * back (its fallback picks stay as drafts) instead of hiding the prompt, which
 * would strand the party when that seat owns the shared order.
 */
export function reopenAutoReadyStartTurn(room, playerId) {
  if (!room.startTurnAutoReady?.includes(playerId)) return
  room.startTurnAutoReady = room.startTurnAutoReady.filter((id) => id !== playerId)
  if (room.run?.combat?.phase === 'start' && room.startTurnReady?.[playerId]) {
    room.startTurnReady = { ...room.startTurnReady, [playerId]: false }
  }
}

export function replayedStartTurnTrigger(room, combat, queued) {
  if (!queued?.startTurn || !Array.isArray(room.startTurnOrder)) return null
  const queuedChoiceId = `${queued.playerId}/${queued.sourceId}`
  const stored = new Map((savedStartTurnChoices(room) ?? []).map((choice) => [choice.id, choice]))
  const defaults = new Map(defaultStartTurnChoices(combat).map((choice) => [choice.id, choice]))
  const choices = room.startTurnOrder.map((id) => stored.get(id) ?? defaults.get(id)).filter(Boolean)
    .map((choice) => ({
      ...choice,
      ...(room.startTurnEnemyTargets?.[choice.id] ? { enemyUid: room.startTurnEnemyTargets[choice.id] } : {}),
      ...(choice.id === queuedChoiceId ? { trigger: undefined } : {}),
    }))
  if (choices.length !== room.startTurnOrder.length) return null
  const replayed = continueStartTurn(
    { ...structuredClone(combat), pendingTriggers: [] }, choices, undefined, queuedChoiceId,
  )
  const pending = prioritizePendingTrigger(replayed, (trigger) =>
    trigger.playerId === queued.playerId && trigger.sourceId === queued.sourceId)
  return { combat: pending ?? replayed, resolved: pending === undefined }
}

export function savedStartTurnChoices(room) {
  const combatId = room.run?.combat?.combatId
  return room.startTurnCombatId === combatId ? room.startTurnChoices : undefined
}

const startTurnAbilitiesCache = new WeakMap()

export function plannedStartTurnAbilities(room) {
  const combat = room.run?.combat
  if (!combat) return []
  // Snapshot reads and authorization inspect the same plan repeatedly. Include
  // its contents so in-place effects and restored rooms invalidate it too.
  const signature = JSON.stringify([
    combat, room.startTurnCombatId, room.startTurnOrder,
    room.startTurnEnemyTargets, room.startTurnChoices,
  ])
  const cached = startTurnAbilitiesCache.get(room)
  if (cached?.signature === signature) return cached.abilities
  const order = room.startTurnCombatId === combat.combatId ? room.startTurnOrder : undefined
  const targets = room.startTurnEnemyTargets ?? {}
  const stored = new Map((savedStartTurnChoices(room) ?? []).map((choice) => [choice.id, choice]))
  const abilities = !Array.isArray(order) ? startTurnAbilities(combat)
    : startTurnAbilities(combat, order, order.map((id) => ({
    id, shivEnemyUids: [], evokeSlots: [], evokeEnemyUids: [],
    ...stored.get(id), enemyUid: targets[id] ?? stored.get(id)?.enemyUid,
  })))
  startTurnAbilitiesCache.set(room, { signature, abilities })
  return abilities
}

// Exact order dependency checks deliberately preserve normal-table semantics,
// but a single room operation can ask the same question through settlement,
// authorization, the actor response, and broadcast snapshots. Cache only an
// identical serialized combat/plan so direct test mutations and every real
// state change invalidate it without relying on object identity.
const startTurnOrderOwnerCache = new WeakMap()

export function cachedStartTurnOrderChoicePlayerId(room, abilities = plannedStartTurnAbilities(room)) {
  const combat = room.run?.combat
  if (!combat || combat.phase !== 'start') return undefined
  const signature = JSON.stringify([
    combat,
    room.startTurnCombatId,
    room.startTurnOrder,
    room.startTurnEnemyTargets,
    room.startTurnChoices,
    abilities,
  ])
  const cached = startTurnOrderOwnerCache.get(room)
  if (cached?.signature === signature) return cached.playerId
  const playerId = startTurnOrderChoicePlayerId(combat, abilities)
  startTurnOrderOwnerCache.set(room, { signature, playerId })
  return playerId
}

export function roomPostRollChoiceDone(room) {
  const combat = room.run?.combat
  const lock = room.startTurnPostRollLock
  return combat?.phase === 'start' && lock?.combatId === combat.combatId &&
    lock.turn === combat.turn
}

function postRollNestedWorkPending(combat) {
  return Boolean(combat && (
    mandatoryChoicePending(combat) ||
    (combat.pendingTriggers?.length ?? 0) > 0 ||
    combat.pendingDistilled ||
    combat.pendingRelicScry ||
    combat.pendingCardCopy ||
    combat.startTurnProgress?.forcedCard
  ))
}

export function roomPostRollNestedChoicePending(room) {
  const combat = room.run?.combat
  const nested = room.startTurnPostRollNested
  return Boolean(combat && nested?.combatId === combat.combatId && nested.turn === combat.turn &&
    postRollNestedWorkPending(combat))
}

export function suspendPostRollNestedChoice(room) {
  const combat = room.run?.combat
  if (!combat || !postRollNestedWorkPending(combat)) return
  room.startTurnPostRollNested = { combatId: combat.combatId, turn: combat.turn }
}

export function isPostRollItemAction(room, seat, action) {
  const combat = room.run?.combat
  const player = combat?.players.find((candidate) => candidate.id === seat.playerId)
  if (!combat || !player) return false
  if (action?.kind === 'activateRelic' && Number.isInteger(action.relicIndex)) {
    return isPostRollStartTurnRelicChoice(combat, player, action.relicIndex)
  }
  return action?.kind === 'usePotion' && typeof action.potionId === 'string' &&
    isPostRollStartTurnPotionChoice(combat, player, action.potionId)
}

export function roomPostRollChoicePending(room) {
  const combat = room.run?.combat
  return combat?.phase === 'start' && !roomPostRollChoiceDone(room) &&
    (roomPostRollNestedChoicePending(room) || hasPostRollStartTurnChoice(combat))
}

function adoptLegacyPostRollNestedChoice(room) {
  const combat = room.run?.combat
  if (combat?.phase !== 'start' || roomPostRollChoiceDone(room) || room.startTurnPostRollNested ||
    postRollDownstreamStarted(room, combat) || (combat.pendingDieRelicChoices?.length ?? 0) === 0) return false
  // Saves written before the room-level marker can contain a copied/manual die
  // Relic payment. Temporarily remove only that blocker to see whether another
  // modifier is waiting behind it; if so, the payment owns the open window.
  if (!hasPostRollStartTurnChoice({ ...combat, pendingDieRelicChoices: [] })) return false
  room.startTurnPostRollNested = { combatId: combat.combatId, turn: combat.turn }
  return true
}

function postRollDownstreamStarted(room, combat = room.run?.combat) {
  return Boolean(combat && (combat.startTurnStage === 'facing' || combat.startTurnProgress ||
    room.startTurnCombatId === combat.combatId && (Array.isArray(room.startTurnOrder) ||
      (room.startTurnChoices?.length ?? 0) > 0 || (room.startTurnStagedTriggers?.length ?? 0) > 0)))
}

export function deferStartTurnTriggersForPostRoll(room) {
  const combat = room.run?.combat
  adoptLegacyPostRollNestedChoice(room)
  const deferred = room.startTurnPostRollDeferredTriggers
  if (deferred && (!combat || combat.phase !== 'start' || deferred.combatId !== combat.combatId ||
    deferred.turn !== combat.turn)) room.startTurnPostRollDeferredTriggers = undefined
  if (combat?.phase !== 'start' || roomPostRollChoiceDone(room) || roomPostRollNestedChoicePending(room) ||
    postRollDownstreamStarted(room, combat)) return false
  const pending = combat.pendingTriggers ?? []
  if (pending.length === 0 || pending.some((trigger) => trigger.startTurn !== true)) return false
  const withoutTriggers = { ...combat, pendingTriggers: [] }
  if (!hasPostRollStartTurnChoice(withoutTriggers)) return false
  room.startTurnPostRollDeferredTriggers = {
    combatId: combat.combatId,
    turn: combat.turn,
  }
  room.run = { ...room.run, combat: withoutTriggers }
  room.startTurnRequired = undefined
  room.startTurnReady = undefined
  return true
}

export function restorePostRollDeferredTriggers(room) {
  const combat = room.run?.combat
  const deferred = room.startTurnPostRollDeferredTriggers
  room.startTurnPostRollDeferredTriggers = undefined
  if (!combat || combat.phase !== 'start' || deferred?.combatId !== combat.combatId || deferred.turn !== combat.turn) {
    return false
  }
  // Rebuild private prompts from the final die/hand/board instead of replaying
  // the pre-modifier queue. A modifier can change which printed sources fire,
  // and a nested trigger may already have consumed one of those sources.
  room.run = { ...room.run, combat: stageStartTurnTriggerChoice(combat) }
  return true
}

function postRollChoiceWindowReady(combat) {
  const progress = combat?.startTurnProgress
  return combat?.phase === 'start' && Number.isInteger(combat.die) && combat.die >= 1 && combat.die <= 6 &&
    !progress?.beforeDraw && !progress?.rollPending && !progress?.pauseAfterDraw && !progress?.discard
}

export function closePostRollChoiceWindow(room) {
  const combat = room.run?.combat
  if (!combat || combat.phase !== 'start') return
  room.startTurnPostRollNested = undefined
  room.startTurnPostRollLock = { combatId: combat.combatId, turn: combat.turn }
  room.startTurnRequired = undefined
  room.startTurnReady = undefined
}

// Closure is a turn-level fact, not a property of the current die face or hand.
// Record an empty window before downstream effects run: Mayhem, Writhing Mass,
// and ordinary item actions can otherwise make a conditional modifier appear
// later in the same turn and incorrectly reopen the decision.
export function ensurePostRollChoiceWindowClosed(room) {
  const combat = room.run?.combat
  if (!postRollChoiceWindowReady(combat) || roomPostRollChoiceDone(room) ||
    roomPostRollNestedChoicePending(room)) return false
  // Restored legacy rooms can already be partway through downstream effects
  // without the lock introduced by this protocol. Those progress markers are
  // authoritative: never reopen a modifier merely because it is legal now.
  const downstreamStarted = postRollDownstreamStarted(room, combat)
  if (!downstreamStarted && hasPostRollStartTurnChoice(combat)) return false
  closePostRollChoiceWindow(room)
  restorePostRollDeferredTriggers(room)
  return true
}

export function clearStartTurnPlan(room) {
  room.startTurnCombatId = undefined
  room.startTurnOrder = undefined
  room.startTurnEnemyTargets = undefined
  room.startTurnChoices = undefined
  room.startTurnRequired = undefined
  room.startTurnReady = undefined
  room.startTurnStagedTriggers = undefined
  room.startTurnAutoReady = undefined
}

export function refreshStartTurnPlan(room) {
  const combat = room.run?.combat
  if (combat?.phase !== 'start' || room.startTurnCombatId !== combat.combatId) {
    clearStartTurnPlan(room)
    return
  }
  const currentIds = new Set(startTurnAbilities(combat).map((ability) => ability.id))
  room.startTurnChoices = room.startTurnChoices?.filter((choice) => currentIds.has(choice.id))
  room.startTurnStagedTriggers = room.startTurnStagedTriggers?.filter((trigger) =>
    currentIds.has(`${trigger.playerId}/${trigger.sourceId}`))
  if (room.startTurnOrder?.length !== currentIds.size ||
    room.startTurnOrder.some((id) => !currentIds.has(id))) {
    room.startTurnOrder = undefined
    room.startTurnEnemyTargets = undefined
  }
  room.startTurnRequired = undefined
  room.startTurnReady = undefined
}

export function startTurnAbilityNeedsManualChoice(ability) {
  return (ability.exhaustCards?.length ?? 0) > 1 || ability.overflowShivs > 0 || ability.guardianModeShift ||
    (ability.targets?.length ?? 0) > 1 || (ability.players?.length ?? 0) > 1 || Boolean(ability.evokeChoice)
}

export function roomStartTurnChoicePlayerIds(
  room,
  abilities = plannedStartTurnAbilities(room),
  orderCommitted = false,
  committedChoices = [],
  knownOrderOwner = UNKNOWN_START_TURN_ORDER_OWNER,
) {
  const combat = room.run?.combat
  if (combat?.phase !== 'start') return []
  // A copied die Relic can be waiting on private card input after every item
  // temporarily becomes ineligible. Do not fall through and publish an empty
  // downstream quorum while that nested payment owns the table.
  if (roomPostRollNestedChoicePending(room)) return []
  const alive = new Set(combat.players.filter((player) => !player.dead).map((player) => player.id))
  // The engine nominates one affected owner for the shared order. If that owner
  // drops, their private choices use fallback while another connected owner
  // receives the independent ordering responsibility. Calculate that owner
  // once: the dependency simulation is intentionally thorough and can be the
  // dominant cost of a large party's start-of-turn snapshot.
  const postRollPending = roomPostRollChoicePending(room)
  const orderOwner = orderCommitted || postRollPending ? undefined
    : knownOrderOwner === UNKNOWN_START_TURN_ORDER_OWNER
      ? cachedStartTurnOrderChoicePlayerId(room, abilities) : knownOrderOwner
  const required = startTurnChoicePlayerIds(
    combat, abilities, false, committedChoices, !roomPostRollChoiceDone(room),
  )
    .filter((playerId) => alive.has(playerId))
  if (postRollPending) return required
  if (orderOwner && alive.has(orderOwner)) {
    const existing = required.indexOf(orderOwner)
    if (existing >= 0) required.splice(existing, 1)
    required.unshift(orderOwner)
  }
  const orderOwnerIndex = orderOwner ? required.indexOf(orderOwner) : -1
  if (orderOwnerIndex >= 0 && !room.seats.some((seat) => seat.connected && seat.playerId === orderOwner)) {
    const replacement = abilities.find((ability) => alive.has(ability.playerId) &&
      room.seats.some((seat) => seat.connected && seat.playerId === ability.playerId))?.playerId
    if (replacement) required[orderOwnerIndex] = replacement
  }

  return [...new Set([
    ...required,
    connectedStartTurnPlayer(room, pendingNoxiousFumes(room)?.playerId),
    ...(room.startTurnStagedTriggers ?? []).map((trigger) => trigger.playerId).filter((playerId) => alive.has(playerId)),
  ].filter(Boolean))]
}

export function ensureStartTurnReady(room) {
  deferStartTurnTriggersForPostRoll(room)
  const combat = room.run?.combat
  if (combat?.phase !== 'start') return []
  ensurePostRollChoiceWindowClosed(room)
  const progress = combat.startTurnProgress
  if (!Array.isArray(room.startTurnRequired) && progress && (
    progress.beforeDraw || progress.rollPending || progress.pauseAfterDraw || progress.discard || progress.forcedCard
  )) return []
  const orderCommitted = room.startTurnCombatId === combat.combatId && Array.isArray(room.startTurnOrder)
  const derived = orderCommitted
    ? roomStartTurnChoicePlayerIds(
      room, plannedStartTurnAbilities(room), true, savedStartTurnChoices(room) ?? [],
    )
    : roomStartTurnChoicePlayerIds(room)
  // Connectivity can transfer shared ordering authority without changing the
  // combat state. Reconcile the persisted quorum in both directions so a
  // returning original owner and the displayed coordinator cannot disagree
  // about which seat is authorized to commit. Once an order is committed, its
  // choice-aware quorum is authoritative and must not be replaced by a fresh
  // default-order derivation.
  if (!Array.isArray(room.startTurnRequired) || !orderCommitted && (
    room.startTurnRequired.length !== derived.length ||
    room.startTurnRequired.some((playerId, index) => playerId !== derived[index]))) {
    room.startTurnRequired = derived
  }
  room.startTurnReady = Object.fromEntries(room.startTurnRequired
    .map((playerId) => [playerId, room.startTurnReady?.[playerId] === true]))
  return room.startTurnRequired
}

export function saveStartTurnOwnerChoices(room, playerId, choices) {
  const abilities = new Map(plannedStartTurnAbilities(room).map((ability) => [ability.id, ability]))
  const stored = new Map((savedStartTurnChoices(room) ?? []).map((choice) => [choice.id, choice]))
  for (const choice of choices) {
    const ability = abilities.get(choice.id)
    if (ability && (ability.playerId === playerId || !room.startTurnRequired?.includes(ability.playerId))) {
      const trigger = choice.trigger ?? stored.get(choice.id)?.trigger
      stored.set(choice.id, { ...choice, ...(trigger ? { trigger } : {}) })
    }
  }
  room.startTurnCombatId = room.run?.combat?.combatId
  room.startTurnChoices = [...stored.values()]
}

export function stageResolvedStartTurnTrigger(room, triggerCombat, pending, values) {
  const validated = resolvePendingTrigger(
    triggerCombat, pending.playerId, pending.id, values.enemyRow, values.enemyUid,
    values.targetPlayerId, values.trigger,
  )
  if (validated === triggerCombat) return false
  const combat = room.run?.combat
  if (!combat) return false
  const id = `${pending.playerId}/${pending.sourceId}`
  const base = defaultStartTurnChoices(combat).find((choice) => choice.id === id)
  if (!base) return false
  const previous = savedStartTurnChoices(room)?.find((choice) => choice.id === id)?.trigger
  const choice = {
    ...base,
    ...(values.enemyUid === undefined ? {} : { enemyUid: values.enemyUid }),
    ...(values.targetPlayerId === undefined ? {} : { targetPlayerId: values.targetPlayerId }),
    trigger: values.trigger,
  }
  saveStartTurnOwnerChoices(room, pending.playerId, [choice])
  room.startTurnStagedTriggers = [
    ...(room.startTurnStagedTriggers ?? []).filter((trigger) => trigger.id !== pending.id),
    pending,
  ]
  room.run = { ...room.run, combat: {
    ...combat,
    pendingTriggers: combat.pendingTriggers.filter((trigger) => trigger.id !== pending.id),
  } }
  if (previous && JSON.stringify(previous) !== JSON.stringify(values.trigger)) resetStartTurnReady(room)
  return true
}

export function reopenStagedStartTurnTriggers(room, choices) {
  const combat = room.run?.combat
  const staged = room.startTurnStagedTriggers ?? []
  if (combat?.phase !== 'start' || staged.length === 0) return false
  const stalledAt = Array.isArray(choices)
    ? continueStartTurn(structuredClone(combat), choices).startTurnProgress?.choices?.[0]?.id
    : undefined
  const stagedIds = new Set(staged.map((trigger) => `${trigger.playerId}/${trigger.sourceId}`))
  const stalledOwner = staged.find((trigger) => `${trigger.playerId}/${trigger.sourceId}` === stalledAt)?.playerId
  const reopenIds = stalledOwner ? new Set(staged.filter((trigger) => trigger.playerId === stalledOwner)
    .map((trigger) => `${trigger.playerId}/${trigger.sourceId}`)) : stagedIds
  const reopening = staged.filter((trigger) => reopenIds.has(`${trigger.playerId}/${trigger.sourceId}`))
  room.startTurnChoices = (savedStartTurnChoices(room) ?? []).map((choice) =>
    reopenIds.has(choice.id) ? { ...choice, trigger: undefined } : choice)
  const queuedIds = new Set(combat.pendingTriggers.map((trigger) => trigger.id))
  room.run = { ...room.run, combat: {
    ...combat,
    // Queue disconnected owners too: settleForcedCards owns their deterministic
    // fallback. Dropping them here leaves a foreign private prompt nobody can
    // answer after the final connected owner confirms.
    pendingTriggers: [...reopening.filter((trigger) => !queuedIds.has(trigger.id)), ...combat.pendingTriggers],
  } }
  room.startTurnStagedTriggers = staged.filter((trigger) =>
    !reopenIds.has(`${trigger.playerId}/${trigger.sourceId}`))
  const owners = new Set(reopening.map((trigger) => trigger.playerId))
  room.startTurnReady = Object.fromEntries(Object.entries(room.startTurnReady ?? {})
    .map(([playerId, ready]) => [playerId, owners.has(playerId) ? false : ready]))
  return true
}

export function markStartTurnReady(room, playerId) {
  ensureStartTurnReady(room)
  if (room.startTurnRequired?.includes(playerId)) {
    room.startTurnReady = { ...room.startTurnReady, [playerId]: true }
  }
}

export function startTurnOwnerChoicesChanged(room, playerId, choices) {
  const owned = new Set(plannedStartTurnAbilities(room)
    .filter((ability) => ability.playerId === playerId).map((ability) => ability.id))
  const before = new Map((savedStartTurnChoices(room) ?? [])
    .filter((choice) => owned.has(choice.id)).map((choice) => [choice.id, choice]))
  if (before.size === 0) return false
  const after = new Map(choices.filter((choice) => owned.has(choice.id)).map((choice) => [choice.id, choice]))
  return [...before].some(([id, choice]) => JSON.stringify(choice) !== JSON.stringify(after.get(id)))
}

export function resetStartTurnReady(room) {
  room.startTurnReady = Object.fromEntries((room.startTurnRequired ?? []).map((playerId) => [playerId, false]))
}

export function savedStartTurnEnemyTargets(room) {
  const abilities = plannedStartTurnAbilities(room)
  const combatId = room.run?.combat?.combatId
  const storedTargets = room.startTurnCombatId === combatId ? room.startTurnEnemyTargets : undefined
  return Object.fromEntries(abilities.flatMap((ability) => {
    const target = storedTargets?.[ability.id]
    return typeof target === 'string' && ability.targets?.some((candidate) => candidate.uid === target)
      ? [[ability.id, target]] : []
  }))
}

export function noxiousFumesIds(combat) {
  return new Set(combat?.players.flatMap((player) => player.powers
    .filter((power) => power.defId === 'noxious_fumes')
    .map((power) => `${player.id}/power:${power.uid}`)) ?? [])
}

export function pendingNoxiousFumes(room) {
  const combat = room.run?.combat
  const saved = savedStartTurnEnemyTargets(room)
  const ids = noxiousFumesIds(combat)
  const abilities = plannedStartTurnAbilities(room)
  const pending = abilities.find((ability) =>
    ids.has(ability.id) && (ability.targets?.length ?? 0) > 1 && !saved[ability.id])
  if (pending || !combat || (room.startTurnCombatId === combat.combatId && Array.isArray(room.startTurnOrder)) ||
    !abilities.some((ability) => ability.id === 'enemy:darkling/regrow')) return pending
  // Regrow can turn the one forced target in the default plan into a real
  // Noxious choice after the coordinator moves it earlier.
  return abilities.find((ability) => ids.has(ability.id) && (ability.targets?.length ?? 0) > 0)
}

export function startTurnAbilityNeedsChoice(ability, saved, stored = new Set()) {
  return !saved[ability.id] && !stored.has(ability.id) && (ability.overflowShivs > 0 || ability.evokeChoice ||
    ability.guardianModeShift ||
    (ability.exhaustCards?.length ?? 0) > 1 || (ability.targets?.length ?? 0) > 1 ||
    (ability.players?.length ?? 0) > 1)
}

export function validStartTurnChoice(ability, choice) {
  return !startTurnChoicePending(ability, choice) &&
    (ability.targets
      ? ability.targets.length === 0 || ability.targets.some((target) => target.uid === choice.enemyUid)
      : choice.enemyUid === undefined) &&
    (ability.players
      ? ability.players.some((player) => player.id === choice.targetPlayerId)
      : choice.targetPlayerId === undefined) &&
    (ability.guardianModeShift
      ? typeof choice.guardianModeShift === 'boolean'
      : choice.guardianModeShift === undefined) &&
    // A forced card ahead of this ability parks its Shiv and Evoke picks until that card resolves.
    (ability.deferredAfterForcedCard || choice.shivEnemyUids.length === ability.overflowShivs &&
    (choice.evokeSlots?.length ?? 0) === (ability.evokeOrbs?.length ?? 0) &&
    (choice.evokeEnemyUids?.length ?? 0) === (ability.evokeOrbs?.length ?? 0) &&
    (ability.evokeOrbs ?? []).every((orb, index) => orb === 'frost'
      ? choice.evokeEnemyUids?.[index] === null
      // With no living enemy left (Summons pending) the target is moot, so a null or stale uid is fine.
      : typeof choice.evokeEnemyUids?.[index] === 'string' ||
        ability.evokeTargetless?.includes(index) && choice.evokeEnemyUids?.[index] === null))
}

export function mergedStartTurnChoices(room, choices, storedChoices = savedStartTurnChoices(room) ?? [], ownerId) {
  const stored = new Map(storedChoices.map((choice) => [choice.id, choice]))
  const abilities = new Map(plannedStartTurnAbilities(room).map((ability) => [ability.id, ability]))
  const targets = savedStartTurnEnemyTargets(room)
  return choices.map((choice) => {
    const owner = abilities.get(choice.id)?.playerId === ownerId
    const saved = stored.get(choice.id)
    return {
      ...choice,
      ...(owner ? undefined : saved),
      ...(saved?.trigger ? { trigger: saved.trigger } : {}),
      enemyUid: owner ? choice.enemyUid : targets[choice.id] ?? saved?.enemyUid ?? choice.enemyUid,
    }
  })
}

/**
 * Seats may stage picks before the shared order exists. Committing an order can
 * make another seat's staged pick illegal (its Evoke slot or Shiv overflow moved),
 * and a pick the client re-sends unchanged would then be refused forever.
 */
export function dropOutdatedStagedChoices(room, combat, order, committerId) {
  const stored = savedStartTurnChoices(room) ?? []
  if (stored.length === 0) return
  const byId = new Map(stored.map((choice) => [choice.id, choice]))
  const defaults = new Map(defaultStartTurnChoices(combat).map((choice) => [choice.id, choice]))
  const planned = startTurnAbilities(combat, order, order.map((id) => byId.get(id) ?? defaults.get(id)).filter(Boolean))
  if (planned.length !== order.length) return
  const outdated = new Set(planned.filter((ability) => ability.playerId !== committerId && byId.has(ability.id) &&
    !validStartTurnChoice(ability, byId.get(ability.id))).map((ability) => ability.id))
  if (outdated.size === 0) return
  const owners = new Set(planned.filter((ability) => outdated.has(ability.id)).map((ability) => ability.playerId))
  room.startTurnChoices = stored.filter((choice) => !outdated.has(choice.id))
  reopenStartTurnOwners(room, owners)
}

/** Asks these owners again, adding them to the quorum when the order left them out. */
export function reopenStartTurnOwners(room, owners) {
  room.startTurnRequired = [...new Set([...(room.startTurnRequired ?? []), ...owners])]
  room.startTurnReady = Object.fromEntries(room.startTurnRequired
    .map((playerId) => [playerId, !owners.has(playerId) && room.startTurnReady?.[playerId] === true]))
}

export function choicesBeforeNoxious(combat, order, choices, fumesId, ownerId) {
  const abilities = startTurnAbilities(combat, order, choices)
  const index = abilities.findIndex((ability) => ability.id === fumesId)
  const prefix = abilities.slice(0, index)
  if (abilities.length !== order.length || index < 0 || prefix.some((ability, abilityIndex) =>
    ability.playerId === ownerId && !validStartTurnChoice(ability, choices[abilityIndex]))) {
    fail('Resolve every Start-of-Turn choice before Noxious Fumes')
  }
  // Another owner's earlier pick may still be missing. Stage the ones that are
  // complete; a Fumes target an earlier effect later invalidates is re-asked.
  return choices.slice(0, index).filter((choice, abilityIndex) =>
    validStartTurnChoice(prefix[abilityIndex], choice))
}

function connectedStartTurnPlayer(room, playerId) {
  return room.seats.find((seat) => seat.connected && seat.playerId === playerId)?.playerId ?? null
}

const UNKNOWN_START_TURN_ORDER_OWNER = Symbol('unknown start-turn order owner')

const UNKNOWN_START_TURN_ORDER_PENDING = Symbol('unknown start-turn order pending')

export function startTurnOrderCoordinator(
  room,
  abilities = plannedStartTurnAbilities(room),
  knownOrderOwner = UNKNOWN_START_TURN_ORDER_OWNER,
) {
  const combat = room.run?.combat
  if (!combat || roomPostRollChoicePending(room)) return null
  const saved = savedStartTurnEnemyTargets(room)
  const fumes = pendingNoxiousFumes(room)
  const fumesIds = noxiousFumesIds(combat)
  const orderOwner = knownOrderOwner === UNKNOWN_START_TURN_ORDER_OWNER
    ? cachedStartTurnOrderChoicePlayerId(room, abilities) : knownOrderOwner
  if (orderOwner) return connectedStartTurnPlayer(room, orderOwner) ??
    abilities.find((ability) => connectedStartTurnPlayer(room, ability.playerId))?.playerId ?? null
  const owner =
    abilities.find((ability) => !fumesIds.has(ability.id) &&
    startTurnAbilityNeedsChoice(ability, saved))?.playerId ?? fumes?.playerId
  return connectedStartTurnPlayer(room, owner)
}

export function startTurnOrderPending(
  room,
  abilities = plannedStartTurnAbilities(room),
  knownOrderOwner = UNKNOWN_START_TURN_ORDER_OWNER,
) {
  const combat = room.run?.combat
  if (!combat || roomPostRollChoicePending(room)) return false
  const fumes = pendingNoxiousFumes(room)
  const orderOwner = knownOrderOwner === UNKNOWN_START_TURN_ORDER_OWNER
    ? cachedStartTurnOrderChoicePlayerId(room, abilities) : knownOrderOwner
  if (!fumes && !orderOwner ||
    room.startTurnCombatId === combat.combatId && Array.isArray(room.startTurnOrder)) {
    return false
  }
  return Boolean(orderOwner) ||
    startTurnOrderCoordinator(room, abilities, orderOwner) !== connectedStartTurnPlayer(room, fumes?.playerId)
}

export function startTurnCoordinator(
  room,
  abilities = plannedStartTurnAbilities(room),
  knownOrderOwner = UNKNOWN_START_TURN_ORDER_OWNER,
  knownOrderPending = UNKNOWN_START_TURN_ORDER_PENDING,
  knownRequired = room.startTurnRequired,
) {
  const combat = room.run?.combat
  if (roomPostRollChoicePending(room)) {
    return connectedStartTurnPlayer(room, knownRequired
      ?.find((playerId) => room.startTurnReady?.[playerId] !== true))
  }
  const firstScryOwner = combat && startTurnScryAbilities(combat)[0]?.playerId
  if (firstScryOwner) return connectedStartTurnPlayer(room, firstScryOwner) ??
    room.seats.find((seat) => seat.connected && combat.players
      .some((player) => player.id === seat.playerId && !player.dead))?.playerId ?? null
  const orderPending = knownOrderPending === UNKNOWN_START_TURN_ORDER_PENDING
    ? startTurnOrderPending(room, abilities, knownOrderOwner) : knownOrderPending
  if (orderPending) return startTurnOrderCoordinator(room, abilities, knownOrderOwner)
  const saved = savedStartTurnEnemyTargets(room)
  const stored = new Set((savedStartTurnChoices(room) ?? []).map((choice) => choice.id))
  const owner = pendingNoxiousFumes(room)?.playerId ??
    abilities.find((ability) => startTurnAbilityNeedsChoice(ability, saved, stored))?.playerId ??
    room.startTurnRequired?.find((playerId) => room.startTurnReady?.[playerId] !== true)
  return connectedStartTurnPlayer(room, owner)
}
