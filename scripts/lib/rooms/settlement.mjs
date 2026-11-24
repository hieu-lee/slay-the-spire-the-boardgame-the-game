// Automatic settlement for disconnected seats, forced cards, abandoned card
// previews, pending relics, rewards, start-turn choices, and discard.

import {
  abandonCardCopy,
  abandonForcedCard,
  abandonGuardianSocket,
  abandonHermitChamberPlay,
  abandonHermitSetupLoad,
  activatePower,
  activateRelic,
  cardDef,
  chooseDistilledCard,
  defaultPendingDieRelicChoice,
  defaultPendingPlayerChoice,
  defaultStartTurnChoices,
  endPlayerTurn,
  faceOf,
  finishRewardsIfComplete,
  mandatoryChoicePending,
  orderStartTurnScries,
  pendingRelicEligibleCards,
  pendingRelicPreview,
  pendingTriggerAbility,
  pendingTriggerSlimeEnemyChoiceCount,
  playHermitChamberCard,
  resolveBossRelicReward,
  resolveCardRewards,
  resolveDeterministicForcedCard,
  resolveGoldReward,
  resolveHermitSetupLoad,
  resolveHermitStrengthReward,
  resolvePendingDieRelicChoice,
  resolvePendingRelic,
  resolvePendingTrigger,
  resolvePlunderRowSwitch,
  resolvePotionReward,
  resolveRelicReward,
  resolveSlayerChoice,
  resolveStartPlayerTurn,
  resolveStartTurnDiscard,
  resolveStartTurnScry,
  resolveTransformReward,
  startTurnAbilities,
  startTurnDiscardPreview,
  startTurnScryAbilities,
  startTurnScryPreview,
} from '../../../src/game/state.ts'
import { hasPostRollStartTurnChoice, scryPlayCardPlayable } from '../../../src/game/combat.ts'
import { previewTinyHouseRewardCard } from '../../../src/game/run/relic-acquisition.ts'
import { discardNeedsChoice } from '../../../src/game/combat/end-turn.ts'
import {
  abandonedPowerContext,
  absentSetupLoadCard,
  deterministicDieRelicChoiceContext,
  fail,
  prioritizePendingChoice,
  prioritizePendingTrigger,
  restoreConcurrentChoice,
  restoreConcurrentCopy,
  restoreConcurrentForcedCard,
  restoreRoom,
  UID_LIMIT,
} from './shared.mjs'
import { clearInvalidPreviews } from './previews.mjs'
import {
  cachedStartTurnOrderChoicePlayerId,
  clearStartTurnPlan,
  closePostRollChoiceWindow,
  ensureStartTurnReady,
  markStartTurnReady,
  noxiousFumesIds,
  plannedStartTurnAbilities,
  refreshStartTurnPlan,
  rememberAutoReadyStartTurn,
  reopenStagedStartTurnTriggers,
  replayedStartTurnTrigger,
  restorePostRollDeferredTriggers,
  roomPostRollChoicePending,
  roomPostRollNestedChoicePending,
  savedStartTurnChoices,
  stageResolvedStartTurnTrigger,
  startTurnAbilityNeedsManualChoice,
  startTurnCoordinator,
  startTurnOrderCoordinator,
  startTurnOrderPending,
  validStartTurnChoice,
} from './start-turn-plan.mjs'

/** Skip every disconnected seat's reward stages deterministically. */
export function settleDisconnectedRewards(room) {
  for (const seat of room.seats.filter((candidate) => candidate.connected === false)) {
    for (;;) {
      const run = room.run
      const offer = run?.phase === 'reward'
        ? run.rewards.find((candidate) => candidate.playerId === seat.playerId)
        : undefined
      if (!run || !offer) break
      const pendingTinyHouse = run.players.find((player) => player.id === seat.playerId)?.relics
        .some((relic) => relic.pending && relic.defId === 'tiny_house')
      const next = pendingTinyHouse && offer.potion !== false
        ? resolvePotionReward(run, seat.playerId, { kind: 'skip' })
        : offer.gold
        ? resolveGoldReward(run, seat.playerId, false)
        : offer.transformReward
        ? resolveTransformReward(run, seat.playerId, null)
        : offer.potion !== false
        ? resolvePotionReward(run, seat.playerId, { kind: 'skip' })
        : (offer.relic ?? false) !== false
          ? resolveRelicReward(run, seat.playerId, false)
          : (offer.bossRelics ?? false) !== false
            ? resolveBossRelicReward(run, seat.playerId, null)
            : offer.cardReward && !run.rewards.some((other) => other.playerId !== seat.playerId && other.cardReward &&
              room.seats.find((candidate) => candidate.playerId === other.playerId)?.connected)
              ? resolveCardRewards(run, { [seat.playerId]: null })
            : run
      if (next === run) break
      room.run = next
      room.version += 1
    }
  }
}

/** Pending acquisitions and Loot can block each other; settle both to a fixed point. */
export function settleDisconnectedRunChoices(room) {
  for (;;) {
    const before = room.run
    if (room.run?.phase !== 'neow') settlePendingRelics(room)
    settleDisconnectedRewards(room)
    if (room.run === before) return
  }
}

/** Resolve disconnected owners' private acquisition choices with stable defaults. */
export function settlePendingRelics(room) {
  if (!Array.isArray(room.run?.players)) return
  for (const seat of room.seats) {
    if (seat.connected !== false) continue
    for (;;) {
      const pending = room.run && pendingRelicPreview(room.run, seat.playerId)
      const player = room.run?.players.find((candidate) => candidate.id === seat.playerId)
      if (!pending || !player) break
      const count = {
        war_paint: 1,
        whetstone: 1,
        astrolabe: 3,
        empty_cage: 2,
        pandoras_box: 3,
        tiny_house: 1,
      }[pending.relicId] ?? 0
      const rewardIndices = (pending.rewardChoices ?? []).map((choices, index) =>
        pending.rewardIndices?.[index] ?? (choices.length > 0 ? 0 : -1))
      const tinyHouseRewardDefId = pending.relicId === 'tiny_house' && rewardIndices[0] >= 0
        ? pending.rewardChoices?.[0]?.[rewardIndices[0]]
        : undefined
      const tinyHouseRewardCard = tinyHouseRewardDefId ? previewTinyHouseRewardCard(player, tinyHouseRewardDefId) : undefined
      const eligible = [...pendingRelicEligibleCards(player, pending.relicId),
        ...(tinyHouseRewardCard && pendingRelicEligibleCards({ deck: [tinyHouseRewardCard] }, 'tiny_house').length > 0
          ? [tinyHouseRewardCard] : [])]
      const resolvedCount = Math.min(count, eligible.length)
      const next = resolvePendingRelic(
        room.run,
        seat.playerId,
        eligible.slice(0, resolvedCount).map((card) => card.uid),
        rewardIndices,
      )
      if (next === room.run) break
      room.run = next
    }
  }
}

export function settleForcedCards(room, applyAction, consumedPreviewPlayerId = null, suspendActiveCopy = true, suspendedWork = null) {
  if (typeof applyAction !== 'function') throw new TypeError('settleForcedCards requires applyAction')
  // Keep an unattended Start-of-Turn exactly where its owners left it. The
  // first seat back can still default absent owners, but nobody should return
  // to find that every private choice was made while the whole table was away.
  if (room.run?.combat?.phase === 'start' && !room.seats.some((seat) => seat.connected)) return
  const activeCopy = room.run?.combat?.phase === 'copy' &&
    room.run.combat.pendingCardCopy?.resumePhase === 'player'
    ? room.run.combat.pendingCardCopy : undefined
  if (activeCopy && suspendActiveCopy) {
    const pausedWork = {
      ...suspendedWork,
      copies: [activeCopy, ...(suspendedWork?.copies ?? []), ...(room.concurrentCardCopies ?? [])],
      forcedCards: [...(suspendedWork?.forcedCards ?? []), ...(room.concurrentForcedCards ?? [])],
    }
    const ownerConnected = room.seats.find((seat) => seat.playerId === activeCopy.playerId)?.connected !== false
    room.run = { ...room.run, combat: { ...room.run.combat, phase: 'player', pendingCardCopy: undefined } }
    settleForcedCards(room, applyAction, consumedPreviewPlayerId, false, pausedWork)
    const settled = room.run?.combat
    if (!settled || ['won', 'lost'].includes(settled.phase)) return
    if (settled.pendingCardCopy) room.concurrentCardCopies = [...(room.concurrentCardCopies ?? []), activeCopy]
    else {
      room.run = { ...room.run, combat: { ...settled, phase: 'copy', pendingCardCopy: activeCopy } }
      if (!ownerConnected) settleForcedCards(room, applyAction, consumedPreviewPlayerId, false, pausedWork)
    }
    clearInvalidPreviews(room, pausedWork)
    return
  }
  while (room.run?.pendingGuardianSockets?.length > 0) {
    const pending = room.run.pendingGuardianSockets.find((choice) =>
      room.seats.find((seat) => seat.playerId === choice.playerId)?.connected === false)
    if (!pending) break
    const next = abandonGuardianSocket(room.run, pending.playerId)
    if (next === room.run) break
    room.run = finishRewardsIfComplete(next)
  }
  // Like the Start-of-Turn guard above: a table that is entirely away keeps its prepared choices.
  let prepared = room.run?.roomState?.kind === 'event' && room.seats.some((seat) => seat.connected)
    ? room.run.roomState.preparedCombat : undefined
  for (let preview = prepared ? startTurnScryPreview(prepared) : undefined; preview;) {
    const owner = room.seats.find((seat) => seat.playerId === preview.playerId)
    if (owner?.connected !== false) break
    const next = resolveStartTurnScry(prepared, preview.playerId, preview.id, [])
    if (next === prepared) break
    room.run = { ...room.run, roomState: { ...room.run.roomState, preparedCombat: next } }
    prepared = next
    preview = startTurnScryPreview(prepared)
  }
  // The setup Load follows the opening Draw, which a pre-draw Scry resolved above may just have finished.
  while (prepared?.pendingHermitSetupLoads?.length > 0) {
    const pending = prepared.pendingHermitSetupLoads[0]
    const owner = room.seats.find((seat) => seat.playerId === pending.playerId)
    if (owner?.connected !== false) break
    const card = absentSetupLoadCard(prepared.players.find((candidate) => candidate.id === pending.playerId))
    const next = card
      ? resolveHermitSetupLoad(prepared, pending.playerId, card.uid,
        prepared.enemies.find((enemy) => !enemy.dead)?.uid ?? null, true)
      : prepared
    const resolved = next === prepared ? abandonHermitSetupLoad(prepared, pending.playerId, true) : next
    if (resolved === prepared) break
    room.run = { ...room.run, roomState: { ...room.run.roomState, preparedCombat: resolved } }
    prepared = resolved
  }
  const combatBeforeSettlement = room.run?.combat
  let combat = combatBeforeSettlement
  const unorderedScries = combat ? startTurnScryAbilities(combat) : []
  if (unorderedScries.length > 0 && !startTurnCoordinator(room)) {
    const ordered = orderStartTurnScries(combat, unorderedScries.map((ability) => ability.id))
    if (ordered !== combat) {
      room.run = { ...room.run, combat: ordered }
      combat = ordered
    }
  }
  settleDisconnectedStartTurnChoices(room, applyAction)
  combat = room.run?.combat
  let powerResolved = false
  for (const [playerId, preview] of Object.entries(room.powerPreviews ?? {})) {
    const owner = room.seats.find((seat) => seat.playerId === playerId)
    if (owner?.connected !== false || !combat) continue
    const next = activatePower(combat, playerId, preview.powerUid, abandonedPowerContext(combat, playerId))
    if (next !== combat) {
      combat = next
      room.run = { ...room.run, combat: next }
      room.powerPreviews = { ...room.powerPreviews }
      delete room.powerPreviews[playerId]
      powerResolved = true
    }
  }
  if (powerResolved) {
    clearInvalidPreviews(room, suspendedWork ?? {
      copies: room.concurrentCardCopies ?? [],
      forcedCards: room.concurrentForcedCards ?? [],
    })
    combat = room.run?.combat
  }
  for (;;) {
    let settled = false
    while (combat?.pendingPlunderSwitches?.length > 0) {
      const choiceCombat = prioritizePendingChoice(combat, 'pendingPlunderSwitches', ({ playerId }) =>
        room.seats.find((seat) => seat.playerId === playerId)?.connected === false)
      const pending = choiceCombat?.pendingPlunderSwitches[0]
      if (!pending) break
      const next = resolvePlunderRowSwitch(choiceCombat, pending.playerId, null)
      if (next === choiceCombat) break
      room.run = { ...room.run, combat: next }
      combat = next
      settled = true
    }
    while (combat?.pendingDieRelicChoices?.length > 0) {
      const automatic = combat.pendingDieRelicChoices[0]
      const automaticContext = automatic && deterministicDieRelicChoiceContext(combat, automatic)
      if (automatic && automaticContext) {
        const next = resolvePendingDieRelicChoice(combat, automatic.playerId, automaticContext)
        if (next === combat) break
        room.run = { ...room.run, combat: next }
        combat = next
        settled = true
        continue
      }
      const choiceCombat = prioritizePendingChoice(combat, 'pendingDieRelicChoices', ({ playerId }) =>
        room.seats.find((seat) => seat.playerId === playerId)?.connected === false)
      const pending = choiceCombat?.pendingDieRelicChoices[0]
      if (!pending) break
      const next = defaultPendingDieRelicChoice(choiceCombat, pending.playerId)
      if (next === choiceCombat) break
      room.run = { ...room.run, combat: next }
      combat = next
      settled = true
    }
    while (combat?.pendingTriggers?.length > 0 && !combat.pendingDieRelicChoices?.length) {
      const triggerCombat = prioritizePendingTrigger(combat, (trigger) =>
        room.seats.find((seat) => seat.playerId === trigger.playerId)?.connected === false)
      const queued = triggerCombat?.pendingTriggers[0]
      // A stale staged choice is being selected for the board as it will look
      // after earlier ordered effects, not the untouched pre-quorum board.
      const replayed = queued && replayedStartTurnTrigger(room, triggerCombat, queued)
      if (replayed?.resolved) {
        room.run = { ...room.run, combat: replayed.combat }
        combat = replayed.combat
        settled = true
        if (combat.phase === 'start') refreshStartTurnPlan(room)
        else clearStartTurnPlan(room)
        continue
      }
      const choiceCombat = replayed?.combat || triggerCombat
      const pending = choiceCombat && pendingTriggerAbility(choiceCombat)
      if (!pending) break
      const slimeUids = pending.slimeChoice?.minimum === 0 ? []
        : pending.slimeChoice?.cards.slice(0, pending.slimeChoice.amount).map((card) => card.uid) ?? []
      const slimeEnemyAmount = pendingTriggerSlimeEnemyChoiceCount(choiceCombat, pending.id, slimeUids)
      const fallbackEnemyUid = choiceCombat.enemies.find((enemy) => !enemy.dead)?.uid
      const triggerChoices = pending.hermitChoices ? {
        loadUids: pending.hermitChoices.loadCards.slice(0, pending.hermitChoices.loadAmount).map((card) => card.uid),
        chamberUids: pending.hermitChoices.chamberCards.slice(0, pending.hermitChoices.chamberAmount)
          .map((card) => card.uid),
        hermitEnemyUids: pending.targets?.[0] ? [pending.targets[0].uid] : [],
      } : pending.slimeChoice ? {
        slimeUids,
        slimeEnemyUids: fallbackEnemyUid ? Array(slimeEnemyAmount).fill(fallbackEnemyUid) : [],
      } : slimeEnemyAmount > 0 ? {
        slimeEnemyUids: fallbackEnemyUid ? Array(slimeEnemyAmount).fill(fallbackEnemyUid) : [],
      } : undefined
      if (queued.startTurn === true) {
        if (!stageResolvedStartTurnTrigger(room, triggerCombat, queued, {
          enemyRow: pending.rows?.[0]?.row,
          enemyUid: pending.targets?.[0]?.uid,
          targetPlayerId: pending.players?.[0]?.id,
          trigger: {
            ...(pending.rows?.[0] ? { enemyRow: pending.rows[0].row } : {}),
            ...(pending.targets?.[0] ? { enemyUid: pending.targets[0].uid } : {}),
            ...(pending.players?.[0] ? { targetPlayerId: pending.players[0].id } : {}),
            ...triggerChoices,
          },
        })) break
        combat = room.run.combat
        settled = true
        continue
      }
      const next = resolvePendingTrigger(
        triggerCombat, pending.playerId, pending.id, pending.rows?.[0]?.row, pending.targets?.[0]?.uid,
        pending.players?.[0]?.id,
        triggerChoices,
      )
      if (next === triggerCombat) break
      room.run = { ...room.run, combat: next }
      combat = next
      settled = true
    }
    while (combat?.pendingHermitSetupLoads?.length > 0) {
      const choiceCombat = prioritizePendingChoice(combat, 'pendingHermitSetupLoads', ({ playerId }) =>
        room.seats.find((seat) => seat.playerId === playerId)?.connected === false)
      const pending = choiceCombat?.pendingHermitSetupLoads[0]
      if (!pending) break
      const card = absentSetupLoadCard(choiceCombat.players.find((candidate) => candidate.id === pending.playerId))
      const next = card
        ? resolveHermitSetupLoad(choiceCombat, pending.playerId, card.uid,
          choiceCombat.enemies.find((enemy) => !enemy.dead)?.uid ?? null)
        : choiceCombat
      const resolved = next === choiceCombat ? abandonHermitSetupLoad(choiceCombat, pending.playerId) : next
      if (resolved === choiceCombat) break
      room.run = { ...room.run, combat: resolved }
      combat = resolved
      settled = true
    }
    while (combat?.pendingHermitChamberPlays?.length > 0) {
      const choiceCombat = prioritizePendingChoice(combat, 'pendingHermitChamberPlays', ({ playerId }) =>
        room.seats.find((seat) => seat.playerId === playerId)?.connected === false)
      const pending = choiceCombat?.pendingHermitChamberPlays[0]
      if (!pending) break
      const preview = room.cardPreviews?.[pending.playerId]
      if (pending.playerId !== consumedPreviewPlayerId &&
        preview?.chamber === true && preview.cardUid === pending.cardUids[0]) {
        const checkpoint = structuredClone(room)
        room.run = { ...room.run, combat: choiceCombat }
        if (!resolveAbandonedPreviews(room, applyAction)) {
          restoreRoom(room, checkpoint)
          break
        }
        combat = room.run?.combat
        settled = true
        continue
      }
      const next = playHermitChamberCard(choiceCombat, pending.playerId, pending.cardUids[0], {
        enemyUid: choiceCombat.enemies.find((enemy) => !enemy.dead)?.uid ?? null,
        playerId: pending.playerId,
      })
      const resolved = next === choiceCombat ? abandonHermitChamberPlay(choiceCombat, pending.playerId) : next
      if (resolved === choiceCombat) break
      room.run = { ...room.run, combat: resolved }
      combat = resolved
      settled = true
    }
    // Slayer Pack: an absent player declines a card's draw/discard or return choice; a dead
    // (Last Stand) or departed player's choice lapses, resuming a Start of Turn it paused.
    while (combat?.pendingPlayerChoices?.length > 0) {
      const pending = combat.pendingPlayerChoices.find(({ playerId }) =>
        room.seats.find((seat) => seat.playerId === playerId)?.connected === false ||
        !combat.players.some((player) => player.id === playerId && !player.dead))
      if (!pending) break
      const next = defaultPendingPlayerChoice(combat, pending.playerId)
      if (next === combat) break
      room.run = { ...room.run, combat: next }
      combat = next
      settled = true
    }
    while (combat?.pendingHermitStrengthRewards?.length > 0) {
      const choiceCombat = prioritizePendingChoice(combat, 'pendingHermitStrengthRewards', ({ playerId }) =>
        room.seats.find((seat) => seat.playerId === playerId)?.connected === false)
      const pending = choiceCombat?.pendingHermitStrengthRewards[0]
      if (!pending) break
      const target = choiceCombat.players.find((player) => !player.dead)
      if (!target) break
      const next = resolveHermitStrengthReward(choiceCombat, pending.playerId, target.id)
      if (next === choiceCombat) break
      room.run = { ...room.run, combat: next }
      combat = next
      settled = true
    }
    // Slayer Pack: an absent owner keeps their deck (Ritual Dagger+ bottoms the
    // reveal) and Nightmare+ moves to the first other living enemy.
    while (combat?.pendingSlayerChoices?.length > 0) {
      // A dead owner (Last Stand) can never answer either, connected or not.
      const choiceCombat = prioritizePendingChoice(combat, 'pendingSlayerChoices', ({ playerId }) =>
        room.seats.find((seat) => seat.playerId === playerId)?.connected === false ||
        combat.players.some((player) => player.id === playerId && player.dead))
      const pending = choiceCombat?.pendingSlayerChoices[0]
      if (!pending) break
      const host = choiceCombat.enemies.find((enemy) => !enemy.dead && enemy.uid !== pending.fromUid)
      const next = resolveSlayerChoice(choiceCombat, pending.playerId, pending.kind === 'ritualDagger'
        ? { choiceId: pending.id, replace: false } : { choiceId: pending.id, enemyUid: host?.uid ?? null })
      if (next === choiceCombat) break
      room.run = { ...room.run, combat: next }
      combat = next
      settled = true
    }
    while (combat?.phase === 'start') {
      const discard = startTurnDiscardPreview(combat)
      const owner = room.seats.find((seat) => seat.playerId === discard?.playerId)
      if (!discard || owner?.connected !== false) break
      const next = resolveStartTurnDiscard(combat, discard.playerId, discard.sourceId, discard.cards[0]?.uid)
      if (next === combat) break
      room.run = { ...room.run, combat: next }
      combat = next
      settled = true
    }
    while (combat?.phase === 'start') {
      const preview = startTurnScryPreview(combat)
      const owner = room.seats.find((seat) => seat.playerId === preview?.playerId)
      if (!preview || owner?.connected !== false) break
      const next = resolveStartTurnScry(combat, preview.playerId, preview.id, [])
      if (next === combat) break
      room.run = { ...room.run, combat: next }
      combat = next
      settled = true
    }
    const beforeStartTurnSettlement = combat
    settleDisconnectedStartTurnChoices(room, applyAction)
    combat = room.run?.combat
    if (combat !== beforeStartTurnSettlement) settled = true
    while (combat?.phase === 'copy' && combat.pendingCardCopy) {
      const ownerId = combat.pendingCardCopy.playerId
      const owner = room.seats.find((seat) => seat.playerId === ownerId)
      if (owner?.connected !== false) break
      const preview = room.cardPreviews?.[ownerId]
      if (ownerId !== consumedPreviewPlayerId &&
        preview?.copy === true && preview.cardUid === combat.pendingCardCopy.card.uid) {
        if (!resolveAbandonedPreviews(room, applyAction)) break
        combat = room.run?.combat
        settled = true
        continue
      }
      const next = abandonCardCopy(combat, ownerId)
      if (next === combat) break
      room.run = { ...room.run, combat: next }
      restoreConcurrentCopy(room)
      combat = room.run?.combat
      settled = true
      if (room.cardPreviews?.[ownerId]) {
        room.cardPreviews = { ...room.cardPreviews }
        delete room.cardPreviews[ownerId]
      }
    }
    while (combat?.phase === 'player' && combat.pendingDistilled && !combat.startTurnProgress?.forcedCard) {
      const ownerId = combat.pendingDistilled.playerId
      const owner = room.seats.find((seat) => seat.playerId === ownerId)
      if (owner?.connected !== false) break
      const next = chooseDistilledCard(combat, ownerId, combat.pendingDistilled.cards[0]?.uid)
      if (next === combat) break
      room.run = { ...room.run, combat: next }
      restoreConcurrentChoice(room, 'pendingDistilled', 'concurrentDistilled')
      combat = room.run.combat
      settled = true
    }
    while (combat?.pendingRelicScry) {
      const pending = combat.pendingRelicScry
      const owner = room.seats.find((seat) => seat.playerId === pending.playerId)
      if (owner?.connected !== false) break
      const next = activateRelic(combat, pending.playerId, pending.relicIndex, { scryDiscardUids: [] })
      if (next === combat) break
      room.run = { ...room.run, combat: next }
      restoreConcurrentChoice(room, 'pendingRelicScry', 'concurrentRelicScries')
      combat = room.run.combat
      settled = true
    }
    while (combat?.phase === 'start' && combat.startTurnProgress?.forcedCard) {
      const ownerId = combat.startTurnProgress.forcedCard.playerId
      if (room.cardPreviews?.[ownerId]) break
      const next = resolveDeterministicForcedCard(combat)
      if (next === combat) break
      room.run = { ...room.run, combat: next }
      combat = next
      settled = true
      restoreConcurrentForcedCard(room)
      combat = room.run.combat
    }
    while ((combat?.phase === 'start' || combat?.phase === 'player' || combat?.phase === 'discard') &&
      combat.startTurnProgress?.forcedCard) {
      const ownerId = combat.startTurnProgress.forcedCard.playerId
      const owner = room.seats.find((seat) => seat.playerId === ownerId)
      if (owner?.connected !== false) break
      if (room.cardPreviews?.[ownerId]) {
        if (!resolveAbandonedPreviews(room, applyAction)) break
        combat = room.run?.combat
        settled = true
        continue
      }
      const next = abandonForcedCard(combat, ownerId)
      if (next === combat) break
      room.run = { ...room.run, combat: next }
      restoreConcurrentForcedCard(room)
      combat = room.run.combat
      settled = true
      if (room.cardPreviews?.[ownerId]) {
        room.cardPreviews = { ...room.cardPreviews }
        delete room.cardPreviews[ownerId]
      }
    }
    if (!settled) {
      if (room.run?.combat === combatBeforeSettlement) return
      clearInvalidPreviews(room, suspendedWork ?? {
        copies: room.concurrentCardCopies ?? [],
        forcedCards: room.concurrentForcedCards ?? [],
      })
      return
    }
  }
}

export function settleDisconnectedStartTurnChoices(room, applyAction, readyEnsured = false) {
  if (typeof applyAction !== 'function') throw new TypeError('settleDisconnectedStartTurnChoices requires applyAction')
  const combat = room.run?.combat
  if (combat?.phase !== 'start') return
  if (!room.seats.some((seat) => seat.connected)) return
  // Reopened private triggers must be defaulted first. Replaying the quorum
  // while one is queued can skip its source and clear the saved plan.
  if (combat.pendingTriggers.some((trigger) => trigger.startTurn)) return
  // A legacy copied/manual die-Relic payment can be the final item in the
  // window. Even when no modifier remains to keep the room-level nested marker,
  // its mandatory input must finish before downstream defaults may run.
  if (mandatoryChoicePending(combat)) return
  // A post-roll item can open an owner-private die Relic payment. The ordinary
  // start-turn quorum must not advance while that nested choice is unresolved.
  if (roomPostRollNestedChoicePending(room)) return
  const previousRequired = [...(room.startTurnRequired ?? [])]
  const required = readyEnsured ? room.startTurnRequired ?? [] : ensureStartTurnReady(room)
  if (required.length === 0 && combat.startTurnProgress?.choices?.length) {
    // A paused window whose parked pick went stale has no owner left to ask.
    const next = resolveStartPlayerTurn(combat, defaultStartTurnChoices(combat))
    if (next !== combat) {
      room.run = { ...room.run, combat: next }
      clearStartTurnPlan(room)
    }
    return
  }
  if (required.length === 0 && !combat.startTurnProgress) {
    const next = resolveStartPlayerTurn(combat, defaultStartTurnChoices(combat))
    if (next !== combat) {
      room.run = { ...room.run, combat: next }
      clearStartTurnPlan(room)
    }
    return
  }
  const disconnected = new Set([...previousRequired, ...(room.startTurnRequired ?? [])].filter((playerId) =>
    room.seats.find((seat) => seat.playerId === playerId)?.connected === false))
  if (roomPostRollChoicePending(room)) {
    rememberAutoReadyStartTurn(room, disconnected)
    for (const playerId of disconnected) markStartTurnReady(room, playerId)
    if (room.startTurnRequired?.every((playerId) => room.startTurnReady?.[playerId])) {
      finishPostRollChoiceWindow(room, applyAction)
      if (room.run?.combat?.phase === 'start') settleDisconnectedStartTurnChoices(room, applyAction)
    }
    return
  }
  // A disconnected original order owner may already have been replaced in the
  // public quorum, so `disconnected` alone cannot prove there is no fallback
  // work.  Keep the common all-connected path cheap, then inspect the original
  // owner whenever any seat is away.
  if (room.seats.every((seat) => seat.connected)) return
  const orderOwner = cachedStartTurnOrderChoicePlayerId(room)
  if (orderOwner && room.seats.find((seat) => seat.playerId === orderOwner)?.connected === false &&
    plannedStartTurnAbilities(room).some((ability) => ability.playerId === orderOwner &&
      startTurnAbilityNeedsManualChoice(ability))) {
    disconnected.add(orderOwner)
  }
  if (disconnected.size === 0) return
  room.startTurnCombatId = combat.combatId
  const fallbackOrder = room.startTurnOrder ?? defaultStartTurnChoices(combat).map((choice) => choice.id)
  if (!startTurnOrderPending(room) || !startTurnOrderCoordinator(room)) room.startTurnOrder = fallbackOrder
  const stored = new Map((savedStartTurnChoices(room) ?? []).map((choice) => [choice.id, choice]))
  const defaults = new Map(defaultStartTurnChoices(combat).map((choice) => [choice.id, choice]))
  // An earlier ability with no pick yet resolves with its default, so a later pick must be judged against
  // that plan. Planning without it leaves the earlier single-target ability blocking the later one, and the
  // later (empty) pick is accepted here but refused by `resolveStartPlayerTurn`.
  const planningChoices = (before) => [
    ...stored.values(),
    ...fallbackOrder.slice(0, before).filter((id) => !stored.has(id)).map((id) => defaults.get(id)),
  ].filter(Boolean)
  for (const [position, id] of fallbackOrder.entries()) {
    room.startTurnChoices = planningChoices(position)
    let ability = plannedStartTurnAbilities(room).find((candidate) => candidate.id === id)
    if (!ability || !disconnected.has(ability.playerId)) continue
    if (!stored.has(ability.id) || !validStartTurnChoice(ability, stored.get(ability.id))) {
      const fallback = {
        id: ability.id,
        enemyUid: ability.targets?.[0]?.uid,
        targetPlayerId: ability.players?.[0]?.id,
        exhaustUids: ability.exhaustCards?.slice(0, 1).map((card) => card.uid),
        guardianModeShift: ability.guardianModeShift ? false : undefined,
        shivEnemyUids: Array(ability.overflowShivs).fill(null),
        evokeSlots: [],
        evokeEnemyUids: [],
      }
      for (let step = 0; step < UID_LIMIT; step += 1) {
        stored.set(id, fallback)
        room.startTurnChoices = planningChoices(position)
        ability = plannedStartTurnAbilities(room).find((candidate) => candidate.id === id)
        if (!ability || validStartTurnChoice(ability, fallback)) break
        if (ability.enemyTargetStale && ability.targets?.[0]) fallback.enemyUid = ability.targets[0].uid
        else if (ability.staleShivIndex !== undefined) {
          fallback.shivEnemyUids[ability.staleShivIndex] = ability.shivTargets?.[0]?.uid ?? null
        } else if (ability.evokeTargetIndex !== undefined) {
          fallback.evokeEnemyUids[ability.evokeTargetIndex] = ability.evokeTargets?.[0]?.uid ?? null
        } else if (ability.evokeChoice?.options[0]) {
          const picked = ability.evokeChoice.options[0]
          fallback.evokeSlots.push(picked.slot)
          fallback.evokeEnemyUids.push(picked.orb === 'frost' ? null : ability.evokeTargets?.[0]?.uid ?? null)
        } else break
      }
      if (ability && noxiousFumesIds(combat).has(id) && validStartTurnChoice(ability, fallback)) {
        room.startTurnEnemyTargets = { ...room.startTurnEnemyTargets, [id]: fallback.enemyUid }
      }
    }
  }
  room.startTurnChoices = [...stored.values()].filter(Boolean)
  rememberAutoReadyStartTurn(room, disconnected)
  room.startTurnReady = { ...room.startTurnReady,
    ...Object.fromEntries([...disconnected].map((playerId) => [playerId, true])) }
  if (!room.startTurnRequired.every((playerId) => room.startTurnReady[playerId])) return
  // A connected owner's Noxious Fumes pick lives in the target map, not the stored choices.
  const choices = fallbackOrder.map((id) => stored.get(id) ?? defaults.get(id)).filter(Boolean)
    .map((choice) => room.startTurnEnemyTargets?.[choice.id]
      ? { ...choice, enemyUid: room.startTurnEnemyTargets[choice.id] } : choice)
  const next = resolveStartPlayerTurn(combat, choices)
  if (next === combat) {
    if (reopenStagedStartTurnTriggers(room, choices)) {
      settleForcedCards(room, applyAction)
      return
    }
    const abilities = startTurnAbilities(combat, fallbackOrder, choices)
    const invalidOwners = new Set(abilities.flatMap((ability, index) =>
      validStartTurnChoice(ability, choices[index]) ? [] : [ability.playerId]))
    room.startTurnReady = Object.fromEntries(Object.entries(room.startTurnReady)
      .map(([playerId, ready]) => [playerId, invalidOwners.size === 0 || invalidOwners.has(playerId) ? false : ready]))
    return
  }
  room.run = { ...room.run, combat: next }
  clearStartTurnPlan(room)
}

export function resolveAbandonedPreviews(room, applyAction) {
  if (typeof applyAction !== 'function') throw new TypeError('resolveAbandonedPreviews requires applyAction')
  let combat = room.run?.combat
  let powerResolved = false
  for (const [playerId, preview] of Object.entries(room.powerPreviews ?? {})) {
    const seat = room.seats.find((candidate) => candidate.playerId === playerId)
    if (!seat || seat.connected || !combat) continue
    const next = activatePower(combat, playerId, preview.powerUid, abandonedPowerContext(combat, playerId))
    if (next === combat) return false
    combat = next
    room.run = { ...room.run, combat }
    room.powerPreviews = { ...room.powerPreviews }
    delete room.powerPreviews[playerId]
    powerResolved = true
  }
  if (powerResolved) {
    clearInvalidPreviews(room, {
      copies: room.concurrentCardCopies ?? [],
      forcedCards: room.concurrentForcedCards ?? [],
    })
    combat = room.run?.combat
  }
  for (;;) {
    const entry = Object.entries(room.cardPreviews ?? {}).find(([playerId]) =>
      room.seats.find((candidate) => candidate.playerId === playerId)?.connected === false)
    if (!entry) break
    const [playerId, storedPreview] = entry
    let preview = storedPreview
    const seat = room.seats.find((candidate) => candidate.playerId === playerId)
    if (!seat) return false
    const player = room.run?.combat?.players.find((candidate) => candidate.id === playerId)
    const held = preview.copy === true ? room.run?.combat?.pendingCardCopy?.card
      : preview.chamber === true ? player?.chamber.find((card) => card.uid === preview.cardUid)
      : player?.hand.find((card) => card.uid === preview.cardUid)
    const effects = held ? faceOf(cardDef(held.defId), held.upgraded).effects : []
    const searchEffect = effects.find((effect) =>
      effect.kind === 'searchDraw' || effect.kind === 'searchDrawAndPlayTwice' ||
      effect.kind === 'overexert' || effect.kind === 'replicateSlime')
    const recoverEffect = effects.find((effect) => effect.kind === 'recoverDiscard')
    const loadEffect = effects.find((effect) => effect.kind === 'load')
    const searchAmount = searchEffect?.kind === 'searchDraw' ? searchEffect.amount
      : searchEffect ? 1 : 0
    const loadUids = preview.kind === 'load'
      ? preview.cards.slice(0, Math.min(Number(loadEffect?.amount ?? 0), preview.cards.length)).map((card) => card.uid)
      : []
    const chamber = [...(player?.chamber ?? [])]
    const chamberUids = []
    for (const uid of loadUids) {
      if (player && chamber.length >= player.chamberSlots) {
        const replaced = chamber.shift()
        if (replaced) chamberUids.push(replaced.uid)
      }
      const loaded = preview.cards.find((card) => card.uid === uid)
      if (loaded) chamber.push(loaded)
    }
    // Deceive Reality must play a revealed card when any can be played: take the first one,
    // judged as the engine will (the source out of hand and counted as played). With none
    // playable, naming nothing is the legal plain Scry.
    const scryPlayUid = preview.kind === 'scryToHand' && effects.some((effect) => effect.kind === 'scryAndPlay')
      ? (() => {
        const judged = { ...room.run.combat, players: room.run.combat.players.map((candidate) =>
          candidate.id === playerId ? { ...candidate,
            hand: candidate.hand.filter((card) => card.uid !== preview.cardUid),
            cardsPlayedThisTurn: (candidate.cardsPlayedThisTurn ?? 0) + 1 } : candidate) }
        return preview.cards.find((card) => scryPlayCardPlayable(judged, playerId, preview.cards, card.uid, []))?.uid
      })()
      : undefined
    const fallbackEnemyUid = room.run?.combat?.enemies.find((enemy) => !enemy.dead)?.uid
    const targetedCurses = new Set(['hermit_grudge', 'hermit_malice', 'hermit_horror'])
    const hermitEnemyUids = fallbackEnemyUid ? loadUids
      .filter((uid) => targetedCurses.has(preview.cards.find((card) => card.uid === uid)?.defId))
      .map(() => fallbackEnemyUid) : []
    if (preview.retargetEnemy || preview.retargetSlime) {
      preview = {
        ...preview,
        enemyUid: preview.retargetEnemy ? fallbackEnemyUid ?? null : preview.enemyUid,
        slimeEnemyUids: preview.retargetSlime
          ? Array(preview.slimeEnemyCount ?? 0).fill(fallbackEnemyUid).filter(Boolean)
          : preview.slimeEnemyUids,
        retargetEnemy: false,
        retargetSlime: false,
      }
      room.cardPreviews = { ...room.cardPreviews, [playerId]: preview }
    }
    try {
      applyAction(room, seat.token, {
        kind: preview.copy === true ? 'playCardCopy'
          : preview.chamber === true ? 'playHermitChamberCard' : 'playCard',
        cardUid: preview.cardUid,
        copyId: preview.copy === true ? room.run?.combat?.pendingCardCopy?.id : undefined,
        enemyUid: preview.retargetEnemy ? fallbackEnemyUid : preview.enemyUid,
        energySpent: preview.energySpent,
        slimeUids: preview.slimeUids,
        slimeEnemyUids: preview.retargetSlime
          ? Array(preview.slimeEnemyCount ?? 0).fill(fallbackEnemyUid).filter(Boolean)
          : preview.slimeEnemyUids,
        discardUids: preview.kind === 'discard' ? preview.cards.map((card) => card.uid) : undefined,
        scryDiscardUids: preview.kind === 'scry' || preview.kind === 'scryToHand' ? [] : undefined,
        scryToHandUid: scryPlayUid,
        topdeckUids: preview.kind === 'topdeck' ? preview.cards.slice(0, 1).map((card) => card.uid) : undefined,
        searchDrawUids: preview.kind === 'search'
          ? preview.cards.slice(0, searchAmount).map((card) => card.uid)
          : undefined,
        recoverDiscardUids: recoverEffect
          ? player.discard.slice(0, recoverEffect.amount).map((card) => card.uid)
          : undefined,
        loadUids: preview.kind === 'load' ? loadUids : preview.kind === 'loadAny' ? [] : undefined,
        chamberUids,
        hermitEnemyUids,
        spendMiracle: preview.spendMiracle,
        preflight: true,
      }, playerId)
    } catch {
      return false
    }
    if (['won', 'lost'].includes(room.run?.combat?.phase)) {
      room.cardPreviews = undefined
      room.powerPreviews = undefined
      return true
    }
  }
  return true
}

export function finishPostRollChoiceWindow(room, applyAction) {
  let combat = room.run?.combat
  if (!combat || combat.phase !== 'start') return
  closePostRollChoiceWindow(room)
  restorePostRollDeferredTriggers(room)
  combat = room.run?.combat
  // Rebuilt private prompts may belong to a seat that disconnected while the
  // modifier window was open. Default those choices now; waiting for another
  // socket event would leave the connected party permanently blocked.
  settleForcedCards(room, applyAction)
  combat = room.run?.combat
  if (!combat || combat.phase !== 'start') return
  if (ensureStartTurnReady(room).length > 0) return
  const next = resolveStartPlayerTurn(combat, defaultStartTurnChoices(combat))
  if (next === combat) return
  room.run = { ...room.run, combat: next }
  clearStartTurnPlan(room)
  settleForcedCards(room, applyAction)
}

export function settlePostRollNestedChoice(room, applyAction) {
  const nested = room.startTurnPostRollNested
  if (!nested) return
  const combat = room.run?.combat
  if (!combat || combat.phase !== 'start' || nested.combatId !== combat.combatId || nested.turn !== combat.turn) {
    room.startTurnPostRollNested = undefined
    return
  }
  if (roomPostRollNestedChoicePending(room)) return
  room.startTurnPostRollNested = undefined
  if (!hasPostRollStartTurnChoice(combat)) finishPostRollChoiceWindow(room, applyAction)
}

export function settleDiscard(room, strict = false) {
  const combat = room.run?.combat
  if (!combat || combat.phase !== 'discard') return null
  if (!room.seats.some((seat) => seat.connected)) return null
  // A forced card (Revenge Protocol), a copy window or an owed choice is still to be played or answered;
  // the discard step must not end the turn around it.
  if (combat.startTurnProgress?.forcedCard || combat.pendingCardCopy || mandatoryChoicePending(combat)) return null
  // No orders yet is a real state: the turn just ended and only a disconnected seat (an Armaments or
  // Master Reality+ Retain choice) may owe one, so the party must not wait for them.
  const submitted = room.endTurnOrders ?? {}
  const connected = new Set(room.seats.filter((seat) => seat.connected).map((seat) => seat.playerId))
  const waiting = combat.players
    .filter((player) => discardNeedsChoice(player) && connected.has(player.id) && !submitted[player.id])
    .map((player) => player.id)
  if (waiting.length > 0) return waiting
  const orders = Object.fromEntries(combat.players.map((player) => [
    player.id,
    submitted[player.id] ?? player.hand.map((card) => card.uid),
  ]))
  const next = endPlayerTurn(combat, orders)
  if (next === combat) {
    // A seat's own submission is told; a settle pass has nobody to tell and the turn simply stays open.
    if (strict) fail('Discard order is no longer valid')
    return null
  }
  room.run = { ...room.run, combat: next }
  room.endTurnOrders = undefined
  return null
}

/** Drain reward choices saved by the former party-wide confirmation flow. */
export function settleReward(room, applyAction) {
  const run = room.run
  if (!run || run.phase !== 'reward' || !room.rewardChoices) return null
  const next = resolveCardRewards(run, room.rewardChoices)
  if (next !== run) {
    room.rewardChoices = undefined
    room.rewardConfirmed = undefined
    room.run = next
    settleForcedCards(room, applyAction)
    room.version += 1
  }
  return null
}
