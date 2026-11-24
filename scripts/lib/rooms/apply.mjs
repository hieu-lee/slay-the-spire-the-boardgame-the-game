// Single-writer room action transaction wrapper and action router.

import {
  CAPS,
  cardDef,
  cardNeedsChoicePreview,
  cardNeedsEnemy,
  defaultStartTurnChoices,
  faceOf,
  finishRewardsIfComplete,
  hasPendingRelicAcquisition,
  mandatoryChoicePending,
  orderStartTurnScries,
  owedPlayerChoices,
  playCost,
  previewCardChoice,
  previewCardCopyChoice,
  previewHermitChamberCardChoice,
  previewPowerChoice,
  resolveEnemyTargets,
  resolveGuardianSocket,
  resolveHermitSetupLoad,
  resolvePendingTrigger,
  resolveStartPlayerTurn,
  resolveStartTurnScry,
  spendMiracle,
  startTurnScryAbilities,
  startTurnScryPreview,
} from '../../../src/game/state.ts'
import { hasPostRollStartTurnChoice } from '../../../src/game/combat.ts'
import {
  activeGiveUpVote,
  assignPendingRelicIds,
  clearEndTurnOrdering,
  dieRelicChoiceNeedsInput,
  fail,
  findSeat,
  forcedCardStillValid,
  prioritizePendingTrigger,
  publishEndTurnEffect,
  refreshChoiceTargets,
  refreshDistilled,
  refreshRelicScry,
  restoreConcurrentChoice,
  restoreConcurrentCopy,
  restoreConcurrentForcedCard,
  restoreRoom,
  UID_LIMIT,
  uidList,
} from './shared.mjs'
import {
  cardPreviewStillValid,
  clearInvalidPreviews,
  previewSlimeChoices,
  previewState,
  reservePreviewRng,
} from './previews.mjs'
import {
  clearStartTurnPlan,
  deferStartTurnTriggersForPostRoll,
  ensureStartTurnReady,
  isPostRollItemAction,
  refreshStartTurnPlan,
  roomPostRollChoiceDone,
  roomPostRollChoicePending,
  roomPostRollNestedChoicePending,
  stageResolvedStartTurnTrigger,
  suspendPostRollNestedChoice,
} from './start-turn-plan.mjs'
import { dispatch } from './combat-dispatch.mjs'
import { snapshotFor } from './snapshot.mjs'
import {
  finishPostRollChoiceWindow,
  settleDiscard,
  settleDisconnectedRewards,
  settleDisconnectedStartTurnChoices,
  settleForcedCards,
  settlePendingRelics,
  settlePostRollNestedChoice,
  settleReward,
} from './settlement.mjs'
import { endTurn, resolveEndTurnEffect, settleDisconnectedEndTurnEffects } from './end-turn.mjs'
import {
  allocateCampaign,
  applyGiveUpVote,
  campfire,
  cancelEventPledge,
  cardReward,
  courierResolve,
  courierReveal,
  eventChoice,
  eventSkip,
  finishCampaignRun,
  merchantFinish,
  merchantPurchase,
  merchantRemove,
  merchantResume,
  merchantWithdraw,
  neowAction,
  quickSetupStep,
  relicReward,
  returnToLobby,
  transformReward,
} from './noncombat.mjs'
import {
  orderBeforeDrawScries,
  resolveBeforeDrawScry,
  resolvePrivateStartTurnDiscard,
  resolveStartTurn,
  submitDiscard,
} from './start-turn.mjs'

export function apply(
  room,
  seatToken,
  action,
  consumedPreviewPlayerId = null,
  suspendedWork = null,
) {
  if (consumedPreviewPlayerId !== null || suspendedWork !== null) {
    return applyRoomAction(room, seatToken, action, consumedPreviewPlayerId, suspendedWork)
  }
  const checkpoint = structuredClone(room)
  // No-op actions must preserve nested identities held by the server loop;
  // only restore when a failed action actually mutated the room.
  const checkpointJson = JSON.stringify(room)
  try {
    const result = applyRoomAction(room, seatToken, action, consumedPreviewPlayerId, suspendedWork)
    if (result.changed) {
      assignPendingRelicIds(room.run)
      // Some action handlers return early (notably interactive triggers and
      // forced-card/copy continuations). Reassess a suspended post-roll item
      // chain at the transaction boundary so none can strand or close it.
      settlePostRollNestedChoice(room, apply)
      // Any accepted action can land the turn in the discard phase owing only a disconnected seat's Retain
      // choice (the last end-of-turn effect or a trigger answer, not just the final vote or discard).
      settleDiscard(room)
      return { ...result, snapshot: snapshotFor(room, seatToken) }
    }
    if (JSON.stringify(room) === checkpointJson) return result
    restoreRoom(room, checkpoint)
    return { ...result, snapshot: snapshotFor(room, seatToken) }
  } catch (error) {
    if (JSON.stringify(room) !== checkpointJson) restoreRoom(room, checkpoint)
    throw error
  }
}

/** Apply one action inside the outer room transaction or an async projection. */
function applyRoomAction(room, seatToken, action, consumedPreviewPlayerId, suspendedWork) {
  const seat = findSeat(room, seatToken) ?? fail('Unknown seat')
  if (room.phase !== 'run' || !room.run) fail('The run has not started')
  deferStartTurnTriggersForPostRoll(room)
  const combat = room.run.combat
  const activeCopy = combat?.phase === 'copy' ? combat.pendingCardCopy : undefined
  const foreignCopy = activeCopy?.resumePhase === 'player' && activeCopy.playerId !== seat.playerId
    ? activeCopy : undefined
  const copyIndex = foreignCopy
    ? room.concurrentCardCopies?.findLastIndex((copy) => copy.playerId === seat.playerId) ?? -1
    : -1
  const ownCopy = copyIndex >= 0 ? room.concurrentCardCopies[copyIndex] : undefined
  const asyncPlayerTurn = combat?.phase === 'player' ||
    combat?.phase === 'copy' && activeCopy?.resumePhase === 'player'
  const choiceFields = [
    'pendingPlunderSwitches', 'pendingDieRelicChoices', 'pendingHermitSetupLoads',
    'pendingHermitChamberPlays', 'pendingHermitStrengthRewards', 'pendingSlayerChoices',
    'pendingPlayerChoices',
  ]
  const choiceBelongsToSeat = (field, choice) => choice.playerId === seat.playerId &&
    (field !== 'pendingDieRelicChoices' || dieRelicChoiceNeedsInput(combat, choice))
  const foreignChoices = Object.fromEntries(choiceFields.map((field) => [
    field, asyncPlayerTurn
      ? (combat?.[field] ?? []).filter((choice) => !choiceBelongsToSeat(field, choice)) : [],
  ]))
  const activeDistilled = asyncPlayerTurn && combat?.pendingDistilled?.playerId !== seat.playerId
    ? combat?.pendingDistilled : undefined
  const activeRelicScry = asyncPlayerTurn && combat?.pendingRelicScry?.playerId !== seat.playerId
    ? combat?.pendingRelicScry : undefined
  const distilledIndex = asyncPlayerTurn && combat?.pendingDistilled?.playerId !== seat.playerId
    ? room.concurrentDistilled?.findLastIndex((pending) => pending.playerId === seat.playerId) ?? -1 : -1
  const relicScryIndex = asyncPlayerTurn && combat?.pendingRelicScry?.playerId !== seat.playerId
    ? room.concurrentRelicScries?.findLastIndex((pending) => pending.playerId === seat.playerId) ?? -1 : -1
  const ownDistilled = distilledIndex >= 0 ? room.concurrentDistilled[distilledIndex] : undefined
  const ownRelicScry = relicScryIndex >= 0 ? room.concurrentRelicScries[relicScryIndex] : undefined
  const playerTurnForcedCard = combat?.startTurnProgress?.forcedCard
  const activeForcedCard = asyncPlayerTurn && playerTurnForcedCard?.playerId !== seat.playerId
    ? playerTurnForcedCard : undefined
  const forcedCardIndex = asyncPlayerTurn && playerTurnForcedCard?.playerId !== seat.playerId
    ? room.concurrentForcedCards?.findLastIndex((pending) => pending.playerId === seat.playerId) ?? -1 : -1
  const ownForcedCard = forcedCardIndex >= 0 ? room.concurrentForcedCards[forcedCardIndex] : undefined
  const foreignTriggers = asyncPlayerTurn
    ? (combat.pendingTriggers ?? []).filter((trigger) => trigger.playerId !== seat.playerId) : []
  const hasForeignWork = foreignCopy || activeDistilled || ownDistilled || activeRelicScry || ownRelicScry ||
    activeForcedCard || ownForcedCard ||
    foreignTriggers.length > 0 ||
    Object.values(foreignChoices).some((choices) => choices.length > 0)
  if (!suspendedWork && hasForeignWork) {
    const checkpoint = structuredClone(room)
    const foreignWork = {
      copies: [foreignCopy, ...(room.concurrentCardCopies ?? [])].filter(Boolean),
      forcedCards: [activeForcedCard, ...(room.concurrentForcedCards ?? [])].filter(Boolean),
      choices: foreignChoices,
    }
    if (copyIndex >= 0) {
      room.concurrentCardCopies = room.concurrentCardCopies.filter((_copy, index) => index !== copyIndex)
    }
    if (distilledIndex >= 0) {
      room.concurrentDistilled = room.concurrentDistilled.filter((_pending, index) => index !== distilledIndex)
    }
    if (relicScryIndex >= 0) {
      room.concurrentRelicScries = room.concurrentRelicScries.filter((_pending, index) => index !== relicScryIndex)
    }
    if (forcedCardIndex >= 0) {
      room.concurrentForcedCards = room.concurrentForcedCards.filter((_pending, index) => index !== forcedCardIndex)
    }
    room.run = {
      ...room.run,
      combat: {
        ...combat,
        ...(foreignCopy ? { phase: ownCopy ? 'copy' : 'player', pendingCardCopy: ownCopy } : {}),
        ...(activeDistilled || ownDistilled ? { pendingDistilled: ownDistilled } : {}),
        ...(activeRelicScry || ownRelicScry ? { pendingRelicScry: ownRelicScry } : {}),
        ...(activeForcedCard || ownForcedCard ? { startTurnProgress: {
          ...combat.startTurnProgress,
          forcedCard: ownForcedCard,
        } } : {}),
        pendingTriggers: (combat.pendingTriggers ?? []).filter((trigger) => trigger.playerId === seat.playerId),
        ...Object.fromEntries(choiceFields.map((field) => [
          field, (combat[field] ?? []).filter((choice) => choiceBelongsToSeat(field, choice)),
        ])),
      },
    }
    try {
      const result = apply(room, seatToken, action, consumedPreviewPlayerId, foreignWork)
      if (!result.changed) {
        restoreRoom(room, checkpoint)
        return { changed: false, snapshot: snapshotFor(room, seatToken) }
      }
      if (room.run?.phase === 'combat' && !['won', 'lost'].includes(room.run.combat?.phase)) {
        let restored = room.run.combat
        const restoredChoices = refreshChoiceTargets(restored, foreignChoices)
        room.concurrentDistilled = room.concurrentDistilled
          ?.map((pending) => refreshDistilled(restored, pending)).filter(Boolean)
        room.concurrentRelicScries = room.concurrentRelicScries
          ?.map((pending) => refreshRelicScry(restored, pending)).filter(Boolean)
        room.concurrentForcedCards = room.concurrentForcedCards
          ?.filter((pending) => forcedCardStillValid(restored, pending))
        if (activeDistilled) {
          const pending = refreshDistilled(restored, activeDistilled)
          if (pending && restored.pendingDistilled) room.concurrentDistilled = [...(room.concurrentDistilled ?? []), pending]
          else if (pending) restored = { ...restored, pendingDistilled: pending }
        }
        const refreshedRelicScry = refreshRelicScry(restored, activeRelicScry)
        if (refreshedRelicScry) {
          if (restored.pendingRelicScry) room.concurrentRelicScries = [...(room.concurrentRelicScries ?? []), refreshedRelicScry]
          else restored = { ...restored, pendingRelicScry: refreshedRelicScry }
        }
        if (activeForcedCard && forcedCardStillValid(restored, activeForcedCard)) {
          if (restored.startTurnProgress?.forcedCard) {
            room.concurrentForcedCards = [...(room.concurrentForcedCards ?? []), activeForcedCard]
          } else {
            restored = { ...restored, startTurnProgress: {
              ...restored.startTurnProgress,
              forcedCard: activeForcedCard,
            } }
          }
        }
        restored = { ...restored, pendingTriggers: [...foreignTriggers, ...(restored.pendingTriggers ?? [])],
          ...Object.fromEntries(choiceFields.map((field) => [
            field, [...restoredChoices[field], ...(restored[field] ?? [])],
          ])) }
        room.run = { ...room.run, combat: restored }
        restoreConcurrentChoice(room, 'pendingDistilled', 'concurrentDistilled')
        restoreConcurrentChoice(room, 'pendingRelicScry', 'concurrentRelicScries')
        restoreConcurrentForcedCard(room)
        settleForcedCards(room, apply, consumedPreviewPlayerId, true, foreignWork)
        if (foreignCopy) {
          const current = room.run.combat
          if (current.pendingCardCopy) room.concurrentCardCopies = [...(room.concurrentCardCopies ?? []), foreignCopy]
          else room.run = { ...room.run, combat: { ...current, phase: 'copy', pendingCardCopy: foreignCopy } }
        }
        restoreConcurrentCopy(room)
        settleForcedCards(room, apply, consumedPreviewPlayerId)
      } else if (room.run?.combat && ['won', 'lost'].includes(room.run.combat.phase)) {
        room.concurrentCardCopies = undefined
        room.concurrentDistilled = undefined
        room.concurrentRelicScries = undefined
        room.concurrentForcedCards = undefined
        // Slayer Pack: set-aside choices end with the combat exactly as
        // `clearTerminalChoices` ends them, except a Ritual Dagger+ reveal: that
        // kill already happened, and its owner still answers after a victory
        // that another seat's blow decided.
        const ritual = room.run.combat.phase === 'won'
          ? foreignChoices.pendingSlayerChoices.filter((choice) => choice.kind === 'ritualDagger') : []
        if (ritual.length > 0) {
          room.run = { ...room.run, combat: { ...room.run.combat,
            pendingSlayerChoices: [...ritual, ...(room.run.combat.pendingSlayerChoices ?? [])] } }
        }
      }
      return { ...result, snapshot: snapshotFor(room, seatToken) }
    } catch (error) {
      restoreRoom(room, checkpoint)
      throw error
    }
  }
  if (action?.kind === 'giveUpVote') return applyGiveUpVote(room, seat, action, seatToken)
  if (activeGiveUpVote(room)) fail('Resolve the give-up vote first')
  const pendingCatchUp = room.seats.filter((candidate) => candidate.pendingCatchUp)
  const cancelsPendingCatchUp = pendingCatchUp.length > 0 && seat === room.seats[0] && action?.kind === 'enterRoom'
  if (pendingCatchUp.length > 0 && room.run.phase !== 'neow') {
    if (!cancelsPendingCatchUp) {
      fail('Wait for the new player to connect and Catch Up')
    }
  }
  const preparedCombat = room.run.roomState?.kind === 'event' ? room.run.roomState.preparedCombat : undefined
  const preparedSetup = preparedCombat?.pendingHermitSetupLoads?.[0]
  if (preparedSetup) {
    if (action?.kind !== 'resolveHermitSetupLoad') {
      fail(preparedSetup.playerId === seat.playerId
        ? 'Finish the Hermit setup choice' : 'Wait for the Hermit setup owner')
    }
    if (preparedSetup.playerId !== seat.playerId || typeof action.cardUid !== 'string') {
      fail('That Hermit setup choice is not yours')
    }
    const next = resolveHermitSetupLoad(preparedCombat, seat.playerId, action.cardUid,
      typeof action.enemyUid === 'string' ? action.enemyUid : null, true)
    if (next === preparedCombat) fail('That Hermit setup Load is no longer legal')
    room.run = { ...room.run, roomState: { ...room.run.roomState, preparedCombat: next } }
    settleForcedCards(room, apply, null, true, suspendedWork)
    room.version += 1
    return { changed: true, snapshot: snapshotFor(room, seatToken) }
  }
  const preparedScryAbilities = preparedCombat ? startTurnScryAbilities(preparedCombat) : []
  const preparedScry = preparedCombat ? startTurnScryPreview(preparedCombat) : undefined
  if (preparedScryAbilities.length > 0) {
    const coordinator = room.seats.find((candidate) => candidate.connected !== false &&
      preparedCombat.players.some((player) => player.id === candidate.playerId && !player.dead))?.playerId
    if (action?.kind !== 'orderStartTurnScries') {
      fail(seat.playerId === coordinator ? 'Order the prepared pre-draw Scries' : 'Wait for the Scry coordinator')
    }
    if (seat.playerId !== coordinator || !Array.isArray(action.order) || action.order.length > UID_LIMIT ||
      action.order.some((id) => typeof id !== 'string')) fail('That prepared Scry order is not legal')
    const next = orderStartTurnScries(preparedCombat, action.order)
    if (next === preparedCombat) fail('The prepared Scry order is stale')
    room.run = { ...room.run, roomState: { ...room.run.roomState, preparedCombat: next } }
    settleForcedCards(room, apply, null, true, suspendedWork)
    room.version += 1
    return { changed: true, snapshot: snapshotFor(room, seatToken) }
  }
  if (preparedScry) {
    if (action?.kind !== 'resolveStartTurnScry') {
      fail(preparedScry.playerId === seat.playerId ? 'Finish the prepared pre-draw Scry' : 'Wait for the Scry owner')
    }
    if (preparedScry.playerId !== seat.playerId || action.sourceId !== preparedScry.id ||
      !Array.isArray(action.discardUids) || action.discardUids.length > preparedScry.amount ||
      action.discardUids.some((uid) => typeof uid !== 'string')) fail('That prepared Scry choice is not legal')
    const next = resolveStartTurnScry(preparedCombat, seat.playerId, action.sourceId, action.discardUids)
    if (next === preparedCombat) fail('The prepared Scry choice is stale')
    room.run = { ...room.run, roomState: { ...room.run.roomState, preparedCombat: next } }
    settleForcedCards(room, apply, null, true, suspendedWork)
    room.version += 1
    return { changed: true, snapshot: snapshotFor(room, seatToken) }
  }
  if (preparedCombat?.startTurnProgress && !preparedCombat.startTurnProgress.pauseAfterDraw) {
    fail('Finish the prepared opening-hand step')
  }
  if (room.run.phase === 'neow') {
    if (action?.kind === 'neow') return neowAction(room, seat, action, seatToken)
    if (action?.kind !== 'resolvePendingRelic' && action?.kind !== 'choosePendingRelicReward' && action?.kind !== 'resolveGuardianSocket') {
      fail('Finish Neow before entering the Spire')
    }
  }
  // War Paint and Whetstone bought from The Courier are kept face up because
  // their text forbids resolving them in combat. Combat must continue until
  // the acquisition becomes legal outside combat.
  const pendingRelic = room.run.players.find((player) => player.id === seat.playerId)?.relics
    .find((relic) => relic.pending)
  const resolvingTinyHousePotion = action?.kind === 'potionReward' && pendingRelic?.defId === 'tiny_house'
  const pendingAcquisition = room.run.phase === 'reward'
    ? pendingRelic !== undefined
    : hasPendingRelicAcquisition(room.run)
  if (room.run.phase !== 'combat' && pendingAcquisition && !resolvingTinyHousePotion &&
    action?.kind !== 'resolvePendingRelic' && action?.kind !== 'choosePendingRelicReward' && action?.kind !== 'resolveGuardianSocket') {
    fail('Finish the pending Relic acquisition first')
  }
  const pendingGuardianSocket = room.run.pendingGuardianSockets?.find((pending) =>
    room.run.phase !== 'reward' || pending.playerId === seat.playerId)
  if (pendingGuardianSocket && (room.run.phase !== 'reward' || action?.kind === 'resolveGuardianSocket')) {
    if (action?.kind !== 'resolveGuardianSocket') {
      fail(pendingGuardianSocket.playerId === seat.playerId
        ? 'Finish choosing a Guardian gem' : 'Wait for the Guardian gem choice')
    }
    if (pendingGuardianSocket.playerId !== seat.playerId || typeof action.gemId !== 'string') {
      fail('That Guardian gem choice is not yours')
    }
    if (typeof action.cardUid !== 'string' || action.cardUid !== pendingGuardianSocket.cardUid) {
      fail('Guardian socket choice needs the current card id')
    }
    const next = resolveGuardianSocket(room.run, seat.playerId, action.cardUid, action.gemId)
    if (next === room.run) fail('That Guardian gem choice is no longer legal')
    room.run = finishRewardsIfComplete(next)
    settleForcedCards(room, apply, null, true, suspendedWork)
    room.version += 1
    return { changed: true, snapshot: snapshotFor(room, seatToken) }
  }
  const staged = room.cardPreviews?.[seat.playerId]
  const stagedPower = room.powerPreviews?.[seat.playerId]
  const player = room.run.combat?.players.find((candidate) => candidate.id === seat.playerId)
  const forcedCard = room.run.combat?.startTurnProgress?.forcedCard
  const pendingCopy = room.run.combat?.pendingCardCopy
  const pendingDistilled = room.run.combat?.pendingDistilled
  const copyForSeat = pendingCopy?.playerId === seat.playerId
  const forcedForSeat = (room.run.combat?.phase === 'start' || room.run.combat?.phase === 'player' ||
    room.run.combat?.phase === 'discard') &&
    forcedCard?.playerId === seat.playerId &&
    typeof forcedCard.cardUid === 'string'
  const stagedCopyStillWaiting = staged?.copy === true && copyForSeat && pendingCopy.card.uid === staged.cardUid
  const stagedChamberStillWaiting = staged?.chamber === true &&
    player?.chamber.some((card) => card.uid === staged.cardUid) && room.run.combat?.phase === 'player'
  const stagedCardStillWaiting = player?.hand.some((card) => card.uid === staged?.cardUid) &&
    (room.run.combat?.phase === 'player' || room.run.combat?.phase === 'copy' ||
      (forcedForSeat && forcedCard.cardUid === staged?.cardUid))
  const stagedTargetStillValid = !staged || cardPreviewStillValid(
    room.run.combat, seat.playerId, staged, suspendedWork,
  )
  if (staged && (!stagedCopyStillWaiting && !stagedChamberStillWaiting && !stagedCardStillWaiting ||
    !stagedTargetStillValid)) {
    room.cardPreviews = { ...room.cardPreviews }
    delete room.cardPreviews[seat.playerId]
  }
  const locked = room.cardPreviews?.[seat.playerId]
  // Slayer Pack: an owed card-given choice (a Nightmare+ move, Ritual Dagger+, Heel Hook, Magnetism)
  // can land while this seat holds a reveal, copy window, Distilled Chaos pick, Golden Eye Scry or
  // forced card. It is answerable through every one of those windows: the mandatory-choice gate below
  // already limits the answer to its owner, and each window stays exactly as it was until it is done.
  const answeringOwedChoice = action?.kind === 'resolvePlayerChoice' || action?.kind === 'resolveSlayerChoice'
  if (stagedPower && !answeringOwedChoice && !((action?.kind === 'previewPowerChoice' || action?.kind === 'activatePower') &&
    action.powerUid === stagedPower.powerUid)) fail('Finish the revealed Power before taking another action')
  if (locked && !answeringOwedChoice && !(
    ((locked.copy === true && (action?.kind === 'previewCardCopy' || action?.kind === 'playCardCopy')) ||
      (locked.chamber === true && (action?.kind === 'previewHermitChamberCard' || action?.kind === 'playHermitChamberCard')) ||
      (locked.copy !== true && locked.chamber !== true && (action?.kind === 'previewCard' || action?.kind === 'playCard'))) &&
      action.cardUid === locked.cardUid
  )) fail('Finish the revealed card before taking another action')
  const queuedTriggerCombat = room.run.combat?.pendingDieRelicChoices?.length
    ? undefined : prioritizePendingTrigger(room.run.combat,
      (trigger) => trigger.playerId === seat.playerId)
  const stagedTrigger = action?.kind !== 'resolveTrigger' || queuedTriggerCombat ||
    room.run.combat?.pendingDieRelicChoices?.length
    ? undefined : room.startTurnStagedTriggers
    ?.find((trigger) => trigger.playerId === seat.playerId)
  const triggerCombat = queuedTriggerCombat ?? (stagedTrigger && room.run.combat?.phase === 'start'
    ? { ...room.run.combat, pendingTriggers: [stagedTrigger, ...(room.run.combat.pendingTriggers ?? [])] }
    : undefined)
  const pendingTrigger = triggerCombat?.pendingTriggers[0]
  if (pendingTrigger || action?.kind === 'resolveTrigger') {
    if (!pendingTrigger) fail('That player has no triggered ability to resolve')
    if (action?.kind !== 'resolveTrigger') fail('Finish the triggered ability first')
    if (!Number.isInteger(action.triggerId)) fail('Triggered ability id must be a whole number')
    if (pendingTrigger.id !== action.triggerId) fail('Resolve your oldest triggered ability first')
    if (action.enemyRow !== undefined && !Number.isInteger(action.enemyRow)) {
      fail('Triggered ability row must be a whole number')
    }
    if (action.enemyUid !== undefined && typeof action.enemyUid !== 'string') {
      fail('Triggered ability enemy must be a valid id')
    }
    if (action.targetPlayerId !== undefined && typeof action.targetPlayerId !== 'string') {
      fail('Triggered ability player must be a valid id')
    }
    const slimeUids = uidList(action.slimeUids)
    const slimeEnemyUids = uidList(action.slimeEnemyUids)
    if (action.slimeUids !== undefined && (!Array.isArray(action.slimeUids) ||
      slimeUids.length !== action.slimeUids.length)) fail('Triggered Slime choices must be a list of ids')
    if (action.slimeEnemyUids !== undefined && (!Array.isArray(action.slimeEnemyUids) ||
      slimeEnemyUids.length !== action.slimeEnemyUids.length)) fail('Triggered Slime targets must be a list of ids')
    const combat = triggerCombat
    const startTurnTrigger = combat.phase === 'start' && pendingTrigger.startTurn === true
    if (startTurnTrigger) ensureStartTurnReady(room)
    const triggerChoices = action.hermitChoices === undefined && action.slimeUids === undefined &&
      action.slimeEnemyUids === undefined ? undefined : {
      ...(action.hermitChoices === undefined ? {} : {
        loadUids: uidList(action.hermitChoices?.loadUids) ?? [],
        chamberUids: uidList(action.hermitChoices?.chamberUids) ?? [],
        hermitEnemyUids: uidList(action.hermitChoices?.hermitEnemyUids) ?? [],
      }),
      ...(action.slimeUids === undefined ? {} : { slimeUids }),
      ...(action.slimeEnemyUids === undefined ? {} : { slimeEnemyUids }),
    }
    if (startTurnTrigger) {
      if (!stageResolvedStartTurnTrigger(room, combat, pendingTrigger, {
        enemyRow: action.enemyRow,
        enemyUid: action.enemyUid,
        targetPlayerId: action.targetPlayerId,
        trigger: {
          ...(action.enemyRow === undefined ? {} : { enemyRow: action.enemyRow }),
          ...(action.enemyUid === undefined ? {} : { enemyUid: action.enemyUid }),
          ...(action.targetPlayerId === undefined ? {} : { targetPlayerId: action.targetPlayerId }),
          ...triggerChoices,
        },
      })) fail('That triggered ability target is no longer legal')
      settleDisconnectedStartTurnChoices(room, apply)
      room.version += 1
      return { changed: true, snapshot: snapshotFor(room, seatToken) }
    }
    const next = resolvePendingTrigger(
      combat,
      seat.playerId,
      action.triggerId,
      action.enemyRow,
      action.enemyUid,
      action.targetPlayerId,
      triggerChoices,
    )
    if (next === combat) fail('That triggered ability target is no longer legal')
    room.run = { ...room.run, combat: next }
    settleForcedCards(room, apply, null, true, suspendedWork)
    clearInvalidPreviews(room, suspendedWork)
    clearEndTurnOrdering(room)
    room.version += 1
    if (publishEndTurnEffect(room)) settleDisconnectedEndTurnEffects(room, apply)
    return { changed: true, snapshot: snapshotFor(room, seatToken) }
  }
  if (mandatoryChoicePending(room.run.combat)) {
    const combat = room.run.combat
    const pending = combat.pendingDieRelicChoices?.[0]
      ? { choice: combat.pendingDieRelicChoices[0], kinds: ['resolveDieRelicChoice'], label: 'die Relic' }
      : combat.pendingPlunderSwitches?.[0]
      ? { choice: combat.pendingPlunderSwitches[0], kinds: ['resolvePlunderRowSwitch'], label: 'Plunder row' }
      : combat.pendingHermitSetupLoads?.[0]
        ? { choice: combat.pendingHermitSetupLoads[0], kinds: ['resolveHermitSetupLoad'], label: 'Hermit setup' }
        : combat.pendingHermitChamberPlays?.[0]
          ? { choice: combat.pendingHermitChamberPlays[0],
            kinds: ['previewHermitChamberCard', 'playHermitChamberCard'], label: 'Hermit Chamber' }
          : owedPlayerChoices(combat).length
            // Slayer Pack: each owner answers their own card-given choice.
            ? { choice: owedPlayerChoices(combat).find(({ playerId }) => playerId === seat.playerId) ??
              owedPlayerChoices(combat)[0], kinds: ['resolvePlayerChoice'],
              label: owedPlayerChoices(combat)[0].sourceLabel }
          : combat.pendingHermitStrengthRewards?.[0]
            ? { choice: combat.pendingHermitStrengthRewards[0],
              kinds: ['resolveHermitStrengthReward'], label: 'Hermit reward' }
            : { choice: combat.pendingSlayerChoices[0],
              kinds: ['resolveSlayerChoice'], label: combat.pendingSlayerChoices[0].kind === 'ritualDagger'
                ? 'Ritual Dagger' : 'Nightmare' }
    if (pending.choice.playerId !== seat.playerId || !pending.kinds.includes(action?.kind)) {
      fail(pending.choice.playerId === seat.playerId
        ? `Finish the ${pending.label} choice` : `Wait for the ${pending.label} choice`)
    }
  }
  if (forcedCard && !answeringOwedChoice && !(
    forcedForSeat && (action?.kind === 'playCard' || action?.kind === 'previewCard') &&
    action.cardUid === forcedCard.cardUid
  )) fail('Finish the forced card before taking another action')
  if (pendingCopy && !answeringOwedChoice && !(copyForSeat &&
    (action?.kind === 'previewCardCopy' || action?.kind === 'playCardCopy'))) {
    fail(copyForSeat ? 'Finish resolving the original card' : 'Wait for the original card')
  }
  if (pendingDistilled && !answeringOwedChoice && !room.run.combat?.startTurnProgress?.forcedCard &&
    !(room.run.combat?.pendingTriggers?.length) && !room.run.combat?.pendingCardCopy &&
    action?.kind !== 'chooseDistilledCard') {
    fail(pendingDistilled.playerId === seat.playerId ? 'Choose the next Distilled Chaos card' : 'Wait for Distilled Chaos')
  }
  const pendingRelicScry = room.run.combat?.pendingRelicScry
  if (pendingRelicScry && !answeringOwedChoice &&
    (action?.kind !== 'activateRelic' || action.relicScryId !== pendingRelicScry.id)) {
    fail(pendingRelicScry.playerId === seat.playerId ? 'Finish Golden Eye Scry' : 'Wait for Golden Eye')
  }

  if (action?.kind === 'previewPowerChoice') {
    if (typeof action.powerUid !== 'string') fail('Power preview needs a Power id')
    const preview = previewPowerChoice(room.run.combat, seat.playerId, action.powerUid)
    if (!preview || preview.kind !== 'scry') fail('That Power cannot reveal a choice now')
    room.powerPreviews = { ...room.powerPreviews,
      [seat.playerId]: { id: room.run.combat.nextTriggerId++, powerUid: action.powerUid, ...preview } }
    room.version += 1
    return { changed: true, snapshot: snapshotFor(room, seatToken) }
  }

  if (action?.kind === 'previewHermitChamberCard') {
    if (room.endTurnAbilities) fail('The party is ordering end-of-turn abilities')
    const held = player?.chamber.find((card) => card.uid === action.cardUid)
    const def = held ? faceOf(cardDef(held.defId), held.upgraded) : null
    const required = room.run.combat?.pendingHermitChamberPlays?.[0]
    const free = required?.playerId === seat.playerId && required.cardUids[0] === held?.uid && required.free
    const stagedCard = held ? { ...held, hermitDeadOn: true, ...(free ? { freeThisTurn: true } : {}) } : null
    const stagedPlayer = player && stagedCard ? {
      ...player,
      chamber: player.chamber.filter((card) => card.uid !== stagedCard.uid),
      hand: [...player.hand, stagedCard],
    } : player
    const cost = def && stagedPlayer && stagedCard ? playCost(def, stagedPlayer, stagedCard) : null
    let effectEnergy = 0
    let charged = typeof cost === 'number' ? cost : 0
    if (cost === 'X') {
      if (!Number.isInteger(action.energySpent) || action.energySpent < (def.minimumX ?? 0) ||
        action.energySpent > stagedPlayer.energy) fail('Choose a valid Chamber X cost before revealing this card')
      effectEnergy = action.energySpent
      charged = action.energySpent
    } else if (action.energySpent !== undefined && action.energySpent !== 0) {
      fail('This Chamber card has no X cost')
    } else if (def?.cost === 'X') effectEnergy = charged
    const needsEnemy = def && stagedPlayer ? cardNeedsEnemy(def, stagedPlayer, false, undefined, false,
      stagedCard?.attachedGemId, stagedCard?.uid, typeof cost === 'number' ? cost : undefined) : false
    const enemyUid = needsEnemy ? action.enemyUid : null
    if (needsEnemy && (typeof enemyUid !== 'string' ||
      resolveEnemyTargets(room.run.combat, def.target ?? 'enemy', enemyUid).length === 0)) {
      fail('Choose a living enemy before revealing this Chamber card')
    }
    const { slimeUids, slimeEnemyUids } = previewSlimeChoices(
      room.run.combat, action, def, stagedPlayer, effectEnergy, charged, stagedCard,
    )
    const lockedEnergy = cost === 'X' ? effectEnergy : undefined
    if (locked && (locked.chamber !== true || !locked.retargetEnemy && enemyUid !== locked.enemyUid ||
      lockedEnergy !== locked.energySpent ||
      slimeUids.join('\0') !== (locked.slimeUids ?? []).join('\0') ||
      !locked.retargetSlime && slimeEnemyUids.join('\0') !== (locked.slimeEnemyUids ?? []).join('\0'))) {
      fail('The revealed Chamber target is already committed')
    }
    const preview = room.run.combat
      ? previewHermitChamberCardChoice(previewState(room.run.combat, locked), seat.playerId, action.cardUid)
      : null
    if (!preview) fail('That Chamber card cannot reveal a choice now')
    room.cardPreviews = {
      ...room.cardPreviews,
      [seat.playerId]: {
        cardUid: action.cardUid, chamber: true, spendMiracle: false, enemyUid,
        energySpent: lockedEnergy, slimeUids, slimeEnemyUids, ...reservePreviewRng(room, preview, locked),
      },
    }
    room.version += 1
    return { changed: true, snapshot: snapshotFor(room, seatToken) }
  }

  if (action?.kind === 'previewCardCopy') {
    if (!copyForSeat || action.cardUid !== pendingCopy.card.uid) fail('No original card is waiting for you')
    if (!Number.isInteger(action.copyId) || action.copyId !== pendingCopy.id) {
      fail('That original card copy changed; choose again')
    }
    const def = faceOf(cardDef(pendingCopy.card.defId), pendingCopy.card.upgraded)
    const needsEnemy = cardNeedsEnemy(def, player, false, pendingCopy.energySpent)
    const enemyUid = needsEnemy ? action.enemyUid : null
    if (needsEnemy && (typeof enemyUid !== 'string' ||
      resolveEnemyTargets(room.run.combat, def.target ?? 'enemy', enemyUid).length === 0)) {
      fail('Choose a living enemy before revealing the original card')
    }
    const { slimeUids, slimeEnemyUids } = previewSlimeChoices(
      room.run.combat, action, def, player, pendingCopy.energySpent, 0, pendingCopy.card,
    )
    if (locked && (locked.copy !== true || !locked.retargetEnemy && enemyUid !== locked.enemyUid ||
      slimeUids.join('\0') !== (locked.slimeUids ?? []).join('\0') ||
      !locked.retargetSlime && slimeEnemyUids.join('\0') !== (locked.slimeEnemyUids ?? []).join('\0'))) {
      fail('The revealed original target is already committed')
    }
    const preview = previewCardCopyChoice(previewState(room.run.combat, locked), seat.playerId)
    if (!preview) fail('That original card cannot reveal a choice now')
    room.cardPreviews = {
      ...room.cardPreviews,
      [seat.playerId]: {
        cardUid: pendingCopy.card.uid, copy: true, spendMiracle: false, enemyUid,
        slimeUids, slimeEnemyUids, ...reservePreviewRng(room, preview, locked),
      },
    }
    room.version += 1
    return { changed: true, snapshot: snapshotFor(room, seatToken) }
  }

  if (action?.kind === 'previewCard') {
    if (room.endTurnAbilities) fail('The party is ordering end-of-turn abilities')
    const held = player?.hand.find((card) => card.uid === action.cardUid)
    const def = held ? faceOf(cardDef(held.defId), held.upgraded) : null
    const spendMiracle = action.spendMiracle === true
    const cost = forcedForSeat && forcedCard.cardUid === action.cardUid ? 0 : def && player ? playCost(def, player, held) : null
    if (spendMiracle && (!def || player.miracles < 1 || player.energy !== CAPS.energy ||
      cost === 'X' || cost === 0)) fail('That Miracle cannot pay for this card')
    if (locked && spendMiracle !== locked.spendMiracle) fail('The revealed card payment is already committed')
    const needsEnemy = def ? cardNeedsEnemy(def, player, false, undefined, false, held?.attachedGemId, held?.uid,
      typeof cost === 'number' ? cost : undefined) : false
    const enemyUid = needsEnemy ? action.enemyUid : null
    if (needsEnemy && (typeof enemyUid !== 'string' ||
      resolveEnemyTargets(room.run.combat, def.target ?? 'enemy', enemyUid).length === 0)) {
      fail('Choose a living enemy before revealing this card')
    }
    if (locked && !locked.retargetEnemy && enemyUid !== locked.enemyUid) fail('The revealed card target is already committed')
    const effectEnergy = def?.cost === 'X' && Number.isInteger(action.energySpent) ? action.energySpent : 0
    const charged = typeof cost === 'number' ? cost : effectEnergy
    const { slimeUids, slimeEnemyUids } = previewSlimeChoices(
      room.run.combat, action, def, player, effectEnergy, charged, held,
    )
    if (locked && (slimeUids.join('\0') !== (locked.slimeUids ?? []).join('\0') ||
      !locked.retargetSlime && slimeEnemyUids.join('\0') !== (locked.slimeEnemyUids ?? []).join('\0'))) {
      fail('The revealed Slime choices are already committed')
    }
    const preview = room.run.combat
      ? previewCardChoice(previewState(room.run.combat, locked), seat.playerId, action.cardUid)
      : null
    if (!preview) {
      if (locked) {
        room.cardPreviews = { ...room.cardPreviews }
        delete room.cardPreviews[seat.playerId]
      }
      fail('That card cannot reveal a choice now')
    }
    room.cardPreviews = {
      ...room.cardPreviews,
      [seat.playerId]: {
        cardUid: action.cardUid, spendMiracle, enemyUid, slimeUids, slimeEnemyUids,
        ...reservePreviewRng(room, preview, locked),
      },
    }
    room.version += 1
    return { changed: true, snapshot: snapshotFor(room, seatToken) }
  }

  if (action?.kind === 'playCard') {
    const held = player?.hand.find((card) => card.uid === action.cardUid)
    if (held && cardNeedsChoicePreview(faceOf(cardDef(held.defId), held.upgraded), room.run.combat, player)) {
      if (!locked || locked.cardUid !== action.cardUid) fail('Reveal this card before resolving its choice')
      if ((action.spendMiracle === true) !== locked.spendMiracle) {
        fail('The final card payment does not match its reveal')
      }
      if ((action.enemyUid ?? null) !== locked.enemyUid) fail('The final target does not match its reveal')
      if ((uidList(action.slimeUids) ?? []).join('\0') !== (locked.slimeUids ?? []).join('\0') ||
        (uidList(action.slimeEnemyUids) ?? []).join('\0') !== (locked.slimeEnemyUids ?? []).join('\0')) {
        fail('The final Slime choices do not match their reveal')
      }
      const preview = previewCardChoice(previewState(room.run.combat, locked), seat.playerId, action.cardUid)
      if (!preview || preview.kind !== locked.kind || preview.cards.length !== locked.cards.length ||
        preview.cards.some((card, index) => card.uid !== locked.cards[index].uid)) {
        fail('The revealed cards changed; reveal them again')
      }
    }
  }
  if (action?.kind === 'playCardCopy') {
    if (!copyForSeat || action.cardUid !== pendingCopy.card.uid) fail('No matching original card is waiting')
    if (!Number.isInteger(action.copyId) || action.copyId !== pendingCopy.id) {
      if (action.preflight === true) fail('That original card copy changed; choose again')
    }
    const def = faceOf(cardDef(pendingCopy.card.defId), pendingCopy.card.upgraded)
    if (cardNeedsChoicePreview(def, room.run.combat, player)) {
      if (!locked || locked.copy !== true || locked.cardUid !== action.cardUid) {
        fail('Reveal this original card before resolving its choice')
      }
      if ((action.enemyUid ?? null) !== locked.enemyUid) fail('The final original target does not match its reveal')
      if ((uidList(action.slimeUids) ?? []).join('\0') !== (locked.slimeUids ?? []).join('\0') ||
        (uidList(action.slimeEnemyUids) ?? []).join('\0') !== (locked.slimeEnemyUids ?? []).join('\0')) {
        fail('The final original Slime choices do not match their reveal')
      }
      const preview = previewCardCopyChoice(previewState(room.run.combat, locked), seat.playerId)
      if (!preview || preview.kind !== locked.kind || preview.cards.length !== locked.cards.length ||
        preview.cards.some((card, index) => card.uid !== locked.cards[index].uid)) {
        fail('The revealed original cards changed; reveal them again')
      }
    }
  }
  if (action?.kind === 'playHermitChamberCard') {
    const held = player?.chamber.find((card) => card.uid === action.cardUid)
    const def = held ? faceOf(cardDef(held.defId), held.upgraded) : null
    if (def && cardNeedsChoicePreview(def, room.run.combat, player)) {
      if (!locked || locked.chamber !== true || locked.cardUid !== action.cardUid) {
        fail('Reveal this Chamber card before resolving its choice')
      }
      if ((action.enemyUid ?? null) !== locked.enemyUid) fail('The final Chamber target does not match its reveal')
      if ((action.energySpent ?? undefined) !== locked.energySpent ||
        (uidList(action.slimeUids) ?? []).join('\0') !== (locked.slimeUids ?? []).join('\0') ||
        (uidList(action.slimeEnemyUids) ?? []).join('\0') !== (locked.slimeEnemyUids ?? []).join('\0')) {
        fail('The final Chamber choices do not match their reveal')
      }
      const preview = previewHermitChamberCardChoice(
        previewState(room.run.combat, locked), seat.playerId, action.cardUid,
      )
      if (!preview || preview.kind !== locked.kind || preview.cards.length !== locked.cards.length ||
        preview.cards.some((card, index) => card.uid !== locked.cards[index].uid)) {
        fail('The revealed Chamber cards changed; reveal them again')
      }
    }
  }
  if (action?.kind === 'activatePower') {
    const held = player?.powers.find((power) => power.uid === action.powerUid)
    if (held?.defId === 'guardian_gem_finder') {
      if (!stagedPower || stagedPower.powerUid !== action.powerUid) fail('Reveal Gem Finder before resolving its Scry')
      if (action.powerPreviewId !== stagedPower.id) fail('That Gem Finder Scry changed; choose again')
      const preview = previewPowerChoice(room.run.combat, seat.playerId, action.powerUid)
      if (!preview || preview.cards.length !== stagedPower.cards.length ||
        preview.cards.some((card, index) => card.uid !== stagedPower.cards[index].uid)) {
        fail('Gem Finder cards changed; reveal them again')
      }
    }
  }

  if (action?.kind === 'campfire') return campfire(room, seat, action, seatToken)
  if (action?.kind === 'setupStep') return quickSetupStep(room, seat, action, seatToken)
  if (action?.kind === 'finishRun') return finishCampaignRun(room, seatToken)
  if (action?.kind === 'allocateCampaign') return allocateCampaign(room, seat, action, seatToken)
  if (action?.kind === 'returnToLobby') return returnToLobby(room, seat, seatToken)
  if (action?.kind === 'merchantPurchase') return merchantPurchase(room, seat, action, seatToken)
  if (action?.kind === 'merchantRemove') return merchantRemove(room, seat, action, seatToken)
  if (action?.kind === 'merchantWithdraw') return merchantWithdraw(room, seat, action, seatToken)
  if (action?.kind === 'merchantResume') return merchantResume(room, seat, seatToken)
  if (action?.kind === 'merchantFinish') return merchantFinish(room, seat, seatToken)
  if (action?.kind === 'courierReveal') return courierReveal(room, seat, action, seatToken)
  if (action?.kind === 'courierResolve') return courierResolve(room, seat, action, seatToken)
  if (room.run?.courier?.offer) fail('Resolve The Courier offer before continuing combat')
  if (action?.kind === 'relicReward') return relicReward(room, seat, action, seatToken, apply)
  if (action?.kind === 'eventCancel') return cancelEventPledge(room, seat, seatToken)
  if (action?.kind === 'eventSkip') return eventSkip(room, seat, action, seatToken)
  if (action?.kind === 'event') return eventChoice(room, seat, action, seatToken)
  if (action?.kind === 'cardReward') return cardReward(room, seat, action, seatToken)
  if (action?.kind === 'transformReward') return transformReward(room, seat, action, seatToken, apply)
  if (action?.kind === 'endTurn') return endTurn(room, seat, action, seatToken, apply)
  if (action?.kind === 'resolveEndTurnEffect') return resolveEndTurnEffect(room, seat, action, seatToken, apply)
  if (action?.kind === 'orderStartTurnScries') return orderBeforeDrawScries(room, seat, action, seatToken, apply)
  if (action?.kind === 'resolveStartTurnScry') return resolveBeforeDrawScry(room, seat, action, seatToken, apply)
  if (action?.kind === 'resolveStartTurnDiscard') return resolvePrivateStartTurnDiscard(room, seat, action, seatToken, apply)
  if (action?.kind === 'resolveStartTurn') return resolveStartTurn(room, seat, action, seatToken, apply)
  if (action?.kind === 'discardHand') return submitDiscard(room, seat, action, seatToken)
  // Slayer Pack: an end-of-turn effect can kill a Nightmare+ host and owe its owner a choice; the
  // mandatory-choice gate above holds that owner's own end-turn effect until it is answered.
  const orderingEndTurn = room.endTurnAbilities !== undefined
  if (orderingEndTurn && action?.kind !== 'resolveSlayerChoice') {
    fail('The party is ordering end-of-turn abilities')
  }
  if (roomPostRollChoiceDone(room) && isPostRollItemAction(room, seat, action)) {
    fail('The post-roll item window is already closed')
  }
  if (room.run.combat?.phase === 'start' && !(
    action?.kind === 'activateRelic' ||
    action?.kind === 'usePotion' ||
    action?.kind === 'resolveDieRelicChoice' ||
    action?.kind === 'activatePower' ||
    action?.kind === 'previewPowerChoice' ||
    // The Hermit setup Load pauses the Draw step; the mandatory-choice gate above already checked its owner.
    action?.kind === 'resolveHermitSetupLoad' ||
    // Slayer Pack: Magnetism's choice pauses the ordered abilities; same owner check. A forced card can
    // also owe its owner a Nightmare+ or Ritual Dagger+ answer mid-Start-of-Turn; refusing it deadlocks.
    action?.kind === 'resolvePlayerChoice' || action?.kind === 'resolveSlayerChoice' ||
    forcedForSeat && (action?.kind === 'playCard' || action?.kind === 'previewCard') &&
    action.cardUid === forcedCard.cardUid
  )) fail('Finish the Start-of-Turn abilities')

  const postRollWindowOpen = roomPostRollChoicePending(room)
  const postRollItemAction = postRollWindowOpen && isPostRollItemAction(room, seat, action)
  const before = room.run
  const next = dispatch(before, seat, action, locked)
  if (next === before) return { changed: false, snapshot: snapshotFor(room, seatToken) }

  if (before.phase === 'neow' && next.phase !== 'neow') {
    room.seats = room.seats.filter((candidate) => !candidate.pendingCatchUp)
  }
  if (cancelsPendingCatchUp) room.seats = room.seats.filter((candidate) => !candidate.pendingCatchUp)
  room.run = next
  // The engine stages private Start-of-Turn triggers as soon as Draw/Roll
  // finish. Multiplayer holds them server-side until every die modifier has
  // been used or declined, preserving the printed phase order.
  deferStartTurnTriggersForPostRoll(room)
  // Record nested work before settlement runs. Settlement itself consults the
  // marker to avoid defaulting the ordinary start-turn queue underneath an
  // owner-private payment opened by a post-roll item.
  if (postRollWindowOpen) suspendPostRollNestedChoice(room)
  if (!suspendedWork) {
    restoreConcurrentChoice(room, 'pendingDistilled', 'concurrentDistilled')
    restoreConcurrentChoice(room, 'pendingRelicScry', 'concurrentRelicScries')
    restoreConcurrentForcedCard(room)
    settleForcedCards(room, apply, consumedPreviewPlayerId)
    restoreConcurrentCopy(room)
  }
  if (before.combat?.phase === 'start') refreshStartTurnPlan(room)
  if (postRollWindowOpen && !roomPostRollChoiceDone(room)) suspendPostRollNestedChoice(room)
  if (postRollItemAction && room.run.combat?.phase === 'start') {
    if (!roomPostRollNestedChoicePending(room) && !hasPostRollStartTurnChoice(room.run.combat)) {
      finishPostRollChoiceWindow(room, apply)
    }
  }
  settlePostRollNestedChoice(room, apply)
  if (room.run.combat?.phase === 'start' && !roomPostRollNestedChoicePending(room)) {
    if (ensureStartTurnReady(room).length === 0) {
      const resolved = resolveStartPlayerTurn(room.run.combat, defaultStartTurnChoices(room.run.combat))
      if (resolved !== room.run.combat) {
        room.run = { ...room.run, combat: resolved }
        clearStartTurnPlan(room)
      }
    } else {
      settleDisconnectedStartTurnChoices(room, apply, true)
    }
  }
  settleForcedCards(room, apply, consumedPreviewPlayerId, true, suspendedWork)
  settlePostRollNestedChoice(room, apply)
  if (before.phase === 'combat' && room.run.phase !== 'combat') settlePendingRelics(room)
  const current = room.run
  if ((action?.kind === 'playCard' || action?.kind === 'playCardCopy' || action?.kind === 'playHermitChamberCard') &&
    locked?.cardUid === action.cardUid) {
    room.cardPreviews = { ...room.cardPreviews }
    delete room.cardPreviews[seat.playerId]
  }
  if (action?.kind === 'activatePower' && stagedPower?.powerUid === action.powerUid) {
    room.powerPreviews = { ...room.powerPreviews }
    delete room.powerPreviews[seat.playerId]
  }
  clearInvalidPreviews(room, suspendedWork)
  // Any accepted combat action can change a hand, including an ally's. Orders
  // collected before that action are stale, so everyone confirms again.
  clearEndTurnOrdering(room)
  room.endTurnReady = undefined
  // Campfire choices belong to the room they were made in. Left behind, a
  // choice from one campfire silently resolves the NEXT one for a player who
  // was never asked.
  if (current.map.position !== before.map.position || current.phase !== before.phase) {
    room.campfireChoices = undefined
    room.rewardChoices = undefined
    room.rewardConfirmed = undefined
    room.merchantPledges = undefined
    room.merchantReady = undefined
    room.eventPledge = undefined
    if (current.phase !== 'combat') {
      room.concurrentCardCopies = undefined
      room.concurrentDistilled = undefined
      room.concurrentRelicScries = undefined
      room.concurrentForcedCards = undefined
    }
  }
  settleDisconnectedRewards(room)
  settleReward(room, apply)
  room.version += 1
  // The answer cleared the published end-turn effect like any combat action; the same effect is next.
  if (orderingEndTurn && publishEndTurnEffect(room)) settleDisconnectedEndTurnEffects(room, apply)
  return { changed: true, snapshot: snapshotFor(room, seatToken) }
}
