// Per-seat room snapshots and hidden-information redaction.

import {
  availableTransformRewards,
  canRerollDownfallSelfBoss,
  canSkipEvent,
  currentQuickSetupStep,
  currentRoom,
  hasPendingRelicAcquisition,
  neowPreview,
  pendingRelicPreview,
  pendingTriggerAbility,
  startTurnAbilities,
  startTurnDiscardPreview,
  startTurnScryAbilities,
  startTurnScryPreview,
  unavailableEventOptionIds,
  visibleMap,
} from '../../../src/game/state.ts'
import { initialEnemySlots } from '../../../src/game/combat.ts'
import { discardNeedsChoice, discardTopNeedsChoice } from '../../../src/game/combat/end-turn.ts'
import { campfireTransformAvailable } from '../../../src/game/run/campfire.ts'
import { isSkinOf } from '../../../src/game/skins.ts'
import {
  activeGiveUpVote,
  dieRelicChoiceNeedsInput,
  fail,
  fastClone,
  findSeat,
  prioritizePendingTrigger,
  roomCardPacks,
  seatPublic,
  SERVER_EPOCH,
} from './shared.mjs'
import { visibleCardPreview } from './previews.mjs'
import {
  cachedStartTurnOrderChoicePlayerId,
  deferStartTurnTriggersForPostRoll,
  ensurePostRollChoiceWindowClosed,
  pendingNoxiousFumes,
  plannedStartTurnAbilities,
  roomPostRollChoiceDone,
  roomPostRollChoicePending,
  roomStartTurnChoicePlayerIds,
  savedStartTurnChoices,
  savedStartTurnEnemyTargets,
  startTurnAbilityNeedsChoice,
  startTurnCoordinator,
  startTurnOrderPending,
} from './start-turn-plan.mjs'

/**
 * What one seat is allowed to see.
 *
 * Three things are hidden, and each would break the game differently:
 *
 *  - `rng`, from everyone. It is the seed of every future die roll and shuffle.
 *    Leaking it turns the game into a solved puzzle, and unlike a peeked hand
 *    nobody at the table could tell it had happened.
 *  - Other players' hands. The rulebook is explicit (p.12): ask "How much
 *    damage do you have?" "rather than look at a player's hand".
 *  - Other players' draw piles. Your own draw pile is inspectable as an
 *    unordered set, but its shuffled order is never sent to the client.
 *  - Other players' deck lists. Least privilege: no screen needs them, since
 *    each client only ever upgrades its own cards. Sending them would also
 *    make the hand redaction above much weaker, because deck minus the face-up
 *    piles narrows down what someone is holding.
 *
 * Discard and exhaust piles stay public — they are face up on the table.
 * `shared` must be fresh for one unchanged-room broadcast; it caches only
 * viewer-independent read-only structures (detached from live room state),
 * never redacted player data.
 */
export function snapshotFor(room, seatToken, shared = {}) {
  const seat = findSeat(room, seatToken)
  if (!shared.normalized) {
    deferStartTurnTriggersForPostRoll(room)
    // Persist the empty post-roll decision before a broadcast derives the
    // downstream quorum. This also normalizes rooms restored from older saves.
    ensurePostRollChoiceWindowClosed(room)
    shared.normalized = true
  }
  const viewerId = seat?.playerId ?? null
  const run = Array.isArray(room.run?.players) ? room.run : null
  const queuedCopy = room.concurrentCardCopies?.findLast((copy) => copy.playerId === viewerId)
  const queuedDistilled = room.concurrentDistilled?.findLast((pending) => pending.playerId === viewerId)
  const queuedRelicScry = room.concurrentRelicScries?.findLast((pending) => pending.playerId === viewerId)
  const queuedForcedCard = room.concurrentForcedCards?.findLast((pending) => pending.playerId === viewerId)
  let visibleCombat = run?.combat
  if (visibleCombat?.phase === 'copy' && visibleCombat.pendingCardCopy?.resumePhase === 'player' &&
    visibleCombat.pendingCardCopy.playerId !== viewerId) {
    visibleCombat = { ...visibleCombat, phase: queuedCopy ? 'copy' : 'player',
      pendingCardCopy: queuedCopy ?? visibleCombat.pendingCardCopy }
  }
  if (visibleCombat?.pendingDistilled?.playerId !== viewerId && queuedDistilled) {
    visibleCombat = { ...visibleCombat, pendingDistilled: queuedDistilled }
  }
  if (visibleCombat?.pendingRelicScry?.playerId !== viewerId && queuedRelicScry) {
    visibleCombat = { ...visibleCombat, pendingRelicScry: queuedRelicScry }
  }
  const visibleForcedCard = visibleCombat?.startTurnProgress?.forcedCard
  const visiblePlayerTurn = visibleCombat?.phase === 'player' ||
    visibleCombat?.phase === 'copy' && visibleCombat.pendingCardCopy?.resumePhase === 'player'
  if (visiblePlayerTurn && (queuedForcedCard || visibleForcedCard && visibleForcedCard.playerId !== viewerId)) {
    visibleCombat = { ...visibleCombat, startTurnProgress: {
      ...visibleCombat.startTurnProgress,
      forcedCard: queuedForcedCard,
    } }
  }
  const visibleRun = run && visibleCombat !== run.combat ? { ...run, combat: visibleCombat } : run
  const viewerPlayer = viewerId !== null ? run?.players.find((player) => player.id === viewerId) : undefined

  if (!Object.hasOwn(shared, 'topLevelReady')) {
    shared.topLevelReady = true
    shared.connectedPlayerIds = new Set(room.seats.filter((candidate) => candidate.connected).map((candidate) => candidate.playerId))
    shared.metaOptions = fastClone(room.metaOptions ?? { mode: 'standard', modifiers: [], quickStartAct: 1 })
    shared.cardPacks = run ? [...(run.meta?.cardPacks ?? [])] : roomCardPacks(room)
    shared.seats = room.seats.map(seatPublic)
    shared.roomIsCampfire = run?.phase === 'room' && currentRoom(run.map)?.kind === 'campfire'
    shared.campfireDecided = Object.keys(room.campfireChoices ?? {})
    shared.endTurnDecided = Object.entries(room.endTurnReady ?? room.endTurnOrders ?? {})
      .filter(([playerId, decision]) => decision !== false &&
        (run?.combat?.phase !== 'discard' || shared.connectedPlayerIds.has(playerId)))
      .map(([playerId]) => playerId)
    shared.endTurnRequired = run?.combat?.phase === 'discard'
      ? run.combat.players
        .filter((player) => discardNeedsChoice(player) && shared.connectedPlayerIds.has(player.id))
        .map((player) => player.id)
      : Object.keys(room.endTurnReady ?? {})
    shared.cardChoicePlayerId = Object.keys(room.cardPreviews ?? {})[0] ??
      Object.keys(room.powerPreviews ?? {})[0] ?? run?.combat?.pendingCardCopy?.playerId
    shared.merchantReady = [...(room.merchantReady ?? [])]
    shared.courierPledge = room.courierPledge ? fastClone(room.courierPledge) : undefined
    shared.eventPledgePayments = room.eventPledge ? fastClone(room.eventPledge.payments) : undefined
    const merchantEntries = Object.entries(room.merchantPledges ?? {})
    shared.hasRemovalPledge = false
    shared.publicMerchantPledges = merchantEntries.length === 0 ? {} : Object.fromEntries(merchantEntries.map(([key, pledge]) => {
      if (pledge.kind === 'removal') shared.hasRemovalPledge = true
      const copy = fastClone(pledge)
      if (pledge.kind === 'removal') copy.cardUid = undefined
      return [key, copy]
    }))
    shared.giveUpVote = activeGiveUpVote(room)
    shared.campaignProgress = {
      version: room.campaignProgress.version,
      characters: fastClone(room.campaignProgress.characters),
      colorless: room.campaignProgress.colorless,
      actIV: room.campaignProgress.actIV,
      unspentMarks: room.campaignProgress.unspentMarks,
      highestAscension: room.campaignProgress.highestAscension,
      nextRunNumber: room.campaignProgress.nextRunNumber ?? 0,
      finishedRunIds: [...(room.campaignProgress.finishedRunIds ?? [])],
    }
    const pendingOwner = run?.phase === 'combat' ? undefined
      : run?.players.find((player) => player.relics.some((relic) => relic.pending))
    const pendingRelic = pendingOwner?.relics.find((relic) => relic.pending)
    shared.pendingRelicStatus = pendingOwner && pendingRelic ? {
      playerId: pendingOwner.id, playerName: pendingOwner.name, relicId: pendingRelic.defId,
    } : null
    shared.pendingAcquisitionPlayerIds = run
      ? run.players.filter((player) => hasPendingRelicAcquisition(run, player.id)).map((player) => player.id)
      : []
    shared.startTurnScryPreview = run?.combat ? startTurnScryPreview(run.combat) : undefined
    shared.startTurnDiscardPreview = run?.combat ? startTurnDiscardPreview(run.combat) : undefined
  }

  const inStartPhase = run?.combat?.phase === 'start'
  if (inStartPhase && !Object.hasOwn(shared, 'startTurnReady')) {
    shared.startTurnReady = true
    const postRollPending = roomPostRollChoicePending(room)
    shared.postRollPending = postRollPending
    const privateStartAbilities = plannedStartTurnAbilities(room, shared)
    shared.startTurnAbilities = privateStartAbilities
    shared.savedStartTurnEnemyTargets = savedStartTurnEnemyTargets(room, privateStartAbilities)
    shared.savedStartTurnChoiceIds = new Set((savedStartTurnChoices(room) ?? []).map((choice) => choice.id))
    shared.pendingNoxiousFumes = pendingNoxiousFumes(room, privateStartAbilities, shared.savedStartTurnEnemyTargets)
    shared.startAbilityOwners = new Map(privateStartAbilities.map((ability) => [ability.id, ability.playerId]))
    shared.publicStartAbilities = postRollPending ? [] : privateStartAbilities.map((ability) => {
      const copy = fastClone(ability)
      copy.exhaustCards = undefined
      return copy
    })
    shared.publicStartChoices = room.startTurnCombatId === run.combat.combatId
      ? (room.startTurnChoices ?? []).map((choice) => {
        const copy = fastClone(choice)
        copy.exhaustUids = undefined
        copy.trigger = undefined
        return copy
      })
      : undefined
    shared.pendingStartOwners = new Set(!postRollPending
      ? [shared.pendingNoxiousFumes?.playerId, ...(privateStartAbilities
        .filter((ability) => startTurnAbilityNeedsChoice(
          ability, shared.savedStartTurnEnemyTargets, shared.savedStartTurnChoiceIds,
        ))
        .map((ability) => ability.playerId)), ...(run.combat.pendingTriggers ?? [])
          .filter((trigger) => trigger.startTurn).map((trigger) => trigger.playerId)].filter(Boolean)
      : [])
    const orderLocked = room.startTurnCombatId === run.combat.combatId && Array.isArray(room.startTurnOrder)
    shared.startTurnOrderLocked = orderLocked
    shared.startTurnOrderOwner = postRollPending || (orderLocked && room.startTurnRequired != null)
      ? undefined : cachedStartTurnOrderChoicePlayerId(room, privateStartAbilities, shared)
    shared.startTurnRequired = room.startTurnRequired ?? roomStartTurnChoicePlayerIds(
      room, privateStartAbilities, false, [], shared.startTurnOrderOwner,
    )
    shared.startTurnOrderPending = orderLocked ? false : startTurnOrderPending(
      room, privateStartAbilities, shared.startTurnOrderOwner,
      shared.savedStartTurnEnemyTargets, shared.pendingNoxiousFumes,
    )
    shared.startTurnCoordinatorId = startTurnCoordinator(
      room, privateStartAbilities, shared.startTurnOrderOwner, shared.startTurnOrderPending,
      shared.startTurnRequired, shared.savedStartTurnEnemyTargets, shared.pendingNoxiousFumes,
    )
    shared.startTurnDecided = Object.entries(room.startTurnReady ?? {})
      .filter(([playerId, ready]) => ready && !shared.pendingStartOwners.has(playerId))
      .map(([playerId]) => playerId)
    shared.startTurnPostRollLocked = roomPostRollChoiceDone(room)
    shared.startTurnScryAbilities = startTurnScryAbilities(run.combat)
  }

  const postRollPending = inStartPhase && shared.postRollPending
  const privateStartAbilities = inStartPhase ? shared.startTurnAbilities : undefined
  const startAbilityOwners = inStartPhase ? shared.startAbilityOwners : undefined
  const visibleStartAbilities = !inStartPhase ? undefined : postRollPending ? []
    : privateStartAbilities.some((ability) => ability.playerId === viewerId && ability.exhaustCards !== undefined)
      ? privateStartAbilities.map((ability, index) => (
        ability.playerId === viewerId && ability.exhaustCards !== undefined
          ? { ...shared.publicStartAbilities[index], exhaustCards: fastClone(ability.exhaustCards) }
          : shared.publicStartAbilities[index]
      ))
      : shared.publicStartAbilities
  const rawStartChoices = inStartPhase && room.startTurnCombatId === run.combat.combatId
    ? (room.startTurnChoices ?? []) : undefined
  const visibleStartChoices = !rawStartChoices ? undefined
    : rawStartChoices.some((choice) => startAbilityOwners.get(choice.id) === viewerId &&
      (choice.exhaustUids !== undefined || choice.trigger !== undefined))
      ? rawStartChoices.map((choice, index) => (
        startAbilityOwners.get(choice.id) === viewerId
          ? {
            ...shared.publicStartChoices[index],
            exhaustUids: fastClone(choice.exhaustUids),
            trigger: fastClone(choice.trigger),
          }
          : shared.publicStartChoices[index]
      ))
      : shared.publicStartChoices
  const revisableStartTriggers = inStartPhase && !(run.combat.pendingTriggers ?? [])
    .some((trigger) => trigger.playerId === viewerId)
    ? room.startTurnStagedTriggers?.filter((trigger) => trigger.playerId === viewerId) ?? []
    : []
  const giveUpVote = shared.giveUpVote
  const scryPreview = shared.startTurnScryPreview
  const discardPreview = shared.startTurnDiscardPreview
  const merchantPledges = !shared.hasRemovalPledge
    ? shared.publicMerchantPledges
    : Object.fromEntries(Object.entries(room.merchantPledges ?? {}).map(([key, pledge]) => [
      key,
      pledge.kind === 'removal' && pledge.buyerId === viewerId
        ? { ...shared.publicMerchantPledges[key], cardUid: pledge.cardUid }
        : shared.publicMerchantPledges[key],
    ]))

  return {
    code: room.code,
    phase: room.phase,
    selectingCampaign: room.selectingCampaign === true,
    ascension: room.ascension,
    chooseYourRelic: room.chooseYourRelic === true,
    lastStand: room.lastStand === true,
    metaOptions: shared.metaOptions,
    // In the lobby, the packs a run started now would use; once it starts, the packs it froze.
    cardPacks: shared.cardPacks,
    // Only a seat that played a recorded run hears of its coins, and only its own share.
    ...(seat && room.recordedRuns?.some((recorded) => Object.hasOwn(recorded.skips, seat.token)) ? {
      recordedRuns: room.recordedRuns.filter((recorded) => Object.hasOwn(recorded.skips, seat.token)).map((recorded) => ({
        runId: recorded.runId, bossCoins: fastClone(recorded.bossCoins), skip: recorded.skips[seat.token],
      })),
    } : {}),
    version: room.version,
    /** Changes whenever the server restarts, because restored rooms may resume at a lower version. */
    epoch: SERVER_EPOCH,
    you: seat ? seatPublic(seat) : null,
    earnedAscension: seat?.earnedAscension ?? 0,
    campfireChoice: viewerId !== null && room.campfireChoices?.[viewerId]
      ? { ...room.campfireChoices[viewerId] }
      : undefined,
    campfireTransformAvailable: shared.roomIsCampfire
      ? viewerPlayer ? campfireTransformAvailable(viewerPlayer) : undefined
      : undefined,
    quickSetupTransformAvailable: run?.phase === 'setup' && run.setup &&
      currentQuickSetupStep(run.setup)?.kind === 'transform' &&
      run.setup.playerIds[run.setup.playerIndex] === viewerId && viewerPlayer
      ? availableTransformRewards(viewerPlayer) > 0 : undefined,
    /** Seats that have chosen at the campfire, so the UI can show who is left. */
    campfireDecided: shared.campfireDecided,
    endTurnDecided: shared.endTurnDecided,
    endTurnRequired: shared.endTurnRequired,
    endTurnTopPlayerIds: run?.combat?.phase === 'discard'
      ? run.combat.players
        .filter((player) => player.id === viewerId && discardTopNeedsChoice(player) && shared.connectedPlayerIds.has(player.id))
        .map((player) => player.id)
      : undefined,
    endTurnAbilities: visibleEndTurnAbilities(room, viewerId),
    startTurnAbilities: visibleStartAbilities,
    startTurnRequired: room.startTurnRequired ?? (inStartPhase ? shared.startTurnRequired : undefined),
    startTurnDecided: inStartPhase ? shared.startTurnDecided : undefined,
    startTurnChoiceId: inStartPhase && !postRollPending
      ? shared.pendingNoxiousFumes?.id : undefined,
    startTurnEnemyTargets: inStartPhase ? shared.savedStartTurnEnemyTargets : undefined,
    startTurnChoices: visibleStartChoices,
    stagedStartTurnTriggers: revisableStartTriggers.flatMap((trigger) => {
      const ability = pendingTriggerAbility({
        ...run.combat, pendingTriggers: [trigger, ...(run.combat.pendingTriggers ?? [])],
      })
      return ability?.playerId === viewerId ? [{ ...fastClone(ability),
        choiceId: `${trigger.playerId}/${trigger.sourceId}` }] : []
    }),
    startTurnPostRollLocked: inStartPhase ? shared.startTurnPostRollLocked : undefined,
    startTurnOrderPending: inStartPhase ? shared.startTurnOrderPending : undefined,
    startTurnOrderLocked: inStartPhase ? shared.startTurnOrderLocked : false,
    startTurnScryAbilities: inStartPhase ? shared.startTurnScryAbilities : undefined,
    startTurnCoordinatorId: inStartPhase ? shared.startTurnCoordinatorId : undefined,
    startTurnScry: scryPreview ? {
      ...scryPreview,
      cards: scryPreview.playerId === viewerId ? fastClone(scryPreview.cards) : null,
    } : undefined,
    startTurnDiscard: discardPreview ? {
      ...discardPreview,
      cards: discardPreview.playerId === viewerId ? fastClone(discardPreview.cards) : null,
    } : undefined,
    discardOrder: viewerId !== null && room.endTurnOrders?.[viewerId]
      ? [...room.endTurnOrders[viewerId]]
      : undefined,
    cardPreview: viewerId !== null && room.cardPreviews?.[viewerId]
      ? visibleCardPreview(room.cardPreviews[viewerId])
      : undefined,
    powerPreview: viewerId !== null && room.powerPreviews?.[viewerId]
      ? fastClone(room.powerPreviews[viewerId])
      : undefined,
    cardChoicePlayerId: shared.cardChoicePlayerId,
    merchantPledges,
    merchantReady: shared.merchantReady,
    courierPledge: shared.courierPledge,
    eventPledge: room.eventPledge ? {
      actorId: room.eventPledge.actorId,
      optionId: room.eventPledge.optionId,
      cost: room.eventPledge.cost,
      payments: shared.eventPledgePayments,
      decision: room.eventPledge.actorId === viewerId
        ? fastClone(room.eventPledge.decision)
        : { optionIds: [room.eventPledge.optionId] },
    } : undefined,
    eventCanSkip: viewerId !== null && run ? canSkipEvent(run, viewerId) : false,
    unavailableEventOptionIds: viewerId !== null && run ? unavailableEventOptionIds(run, viewerId) : [],
    giveUpVote: giveUpVote && viewerId && giveUpVote.eligiblePlayerIds.includes(viewerId) ? {
      ...fastClone(giveUpVote),
      remainingMs: Math.max(0, giveUpVote.deadlineAt - Date.now()),
    } : undefined,
    campaignProgress: shared.campaignProgress,
    seats: shared.seats,
    pendingRelic: viewerId && run ? pendingRelicPreview(run, viewerId) : null,
    pendingRelicStatus: shared.pendingRelicStatus,
    pendingTeammateAcquisitionPlayerId: shared.pendingAcquisitionPlayerIds.find((id) => id !== viewerId) ?? null,
    run: visibleRun ? redactRun(visibleRun, viewerId, room, shared) : null,
  }
}

function visibleEndTurnAbilities(room, viewerId) {
  if (!room.endTurnAbilities) return undefined
  const privateCounts = new Map()
  return room.endTurnAbilities.map((ability) => {
    const visible = {
      ...ability,
      id: publicEndTurnId(room, ability.id),
      targets: ability.targets?.map((target) => ({ ...target })),
    }
    const privateTargets = ability.label.includes('Stasis Engine') && ability.targets?.length
    if (ability.playerId === viewerId || !ability.id.includes('/card:') && !privateTargets) return visible
    const number = (privateCounts.get(ability.playerId) ?? 0) + 1
    privateCounts.set(ability.playerId, number)
    const owner = room.seats.find((seat) => seat.playerId === ability.playerId)?.name ?? 'Teammate'
    return {
      ...visible,
      label: `${owner} — Private hand ability ${number}`,
      targets: privateTargets ? visible.targets?.map((target, index) => ({
        uid: target.uid === 'skip' ? target.uid : `private-card-${index + 1}`,
        label: target.uid === 'skip' ? target.label : `Private card ${index + 1}`,
      })) : visible.targets,
    }
  })
}

function publicEndTurnId(room, id) {
  const publicId = Object.entries(room.endTurnPublicIds ?? {})
    .find(([, realId]) => realId === id)?.[0]
  if (!publicId) fail('End-turn ability mapping is stale')
  return publicId
}

function initSharedRun(baseRun, room, shared) {
  if (shared.run) return shared.run
  const preparedCombat = baseRun.roomState?.kind === 'event' ? baseRun.roomState.preparedCombat : undefined
  const preparedScry = preparedCombat ? startTurnScryPreview(preparedCombat) : undefined
  let roomStateShared = null
  if (baseRun.roomState?.kind === 'event') {
    const rs = baseRun.roomState
    roomStateShared = {
      kind: 'event',
      card: fastClone(rs.card),
      publicDecisions: Object.fromEntries(Object.entries(rs.decisions).map(([playerId, decision]) => [
        playerId,
        { optionIds: [...decision.optionIds] },
      ])),
      dieRolls: fastClone(rs.dieRolls),
      publicRewardOffers: Object.fromEntries(Object.entries(rs.rewardOffers ?? {}).map(([playerId, offers]) => [
        playerId,
        offers.map(() => []),
      ])),
      publicGuardianGemOffers: Object.fromEntries(Object.entries(rs.guardianGemOffers ?? {}).map(([playerId, offers]) => [
        playerId,
        offers.map(() => []),
      ])),
      itemOffers: fastClone(rs.itemOffers ?? {}),
      revealedCards: fastClone(rs.revealedCards ?? {}),
      revealedCardDefs: fastClone(rs.revealedCardDefs ?? {}),
      revealedRelics: fastClone(rs.revealedRelics ?? {}),
      availableRewardSources: fastClone(rs.availableRewardSources),
      partyOptionIds: fastClone(rs.partyOptionIds),
      preparedStartTurnScryAbilities: preparedCombat ? startTurnScryAbilities(preparedCombat) : undefined,
      preparedScry,
      preparedStartTurnCoordinatorId: preparedCombat
        ? room.seats.find((seat) => seat.connected !== false && preparedCombat.players
            .some((player) => player.id === seat.playerId && !player.dead))?.playerId ?? null
        : undefined,
      preparedCombatEnemies: preparedCombat
        ? preparedCombat.enemies.map((enemy) => ({
          uid: enemy.uid,
          defId: enemy.defId,
          row: enemy.row,
          isBoss: enemy.isBoss,
          ascension: enemy.ascension,
          hp: enemy.hp,
          maxHp: enemy.maxHp,
          dead: enemy.dead,
        }))
        : undefined,
      preparedCombatHermitSetupLoads: preparedCombat?.pendingHermitSetupLoads?.length
        ? fastClone(preparedCombat.pendingHermitSetupLoads)
        : undefined,
      publicLabChoices: Object.fromEntries(Object.keys(rs.labChoices ?? {}).map((playerId) => [
        playerId,
        { optionIds: ['resolve'] },
      ])),
    }
  } else if (baseRun.roomState?.kind === 'treasure' || baseRun.roomState?.kind === 'elite') {
    roomStateShared = { kind: 'cloned', base: fastClone(baseRun.roomState) }
  } else if (baseRun.roomState) {
    roomStateShared = { kind: 'plain', value: fastClone(baseRun.roomState) }
  }

  const sharedRun = {
    meta: fastClone(baseRun.meta ?? { mode: 'standard', modifierIds: [] }),
    setup: baseRun.setup ? fastClone(baseRun.setup) : null,
    publicNeow: baseRun.neow ? Object.fromEntries(Object.keys(baseRun.neow.players).map((playerId) => [
      playerId,
      neowPreview(baseRun, playerId, null),
    ])) : null,
    canRerollDownfallSelfBoss: canRerollDownfallSelfBoss(baseRun),
    map: visibleMap(baseRun),
    publicPlayers: baseRun.players.map(redactPlayerPublic),
    publicRewards: baseRun.rewards.map((offer) => {
      const {
        choices: _choices, cardSource: _cardSource, prismatic: _prismatic, upgraded: _upgraded,
        rareChoiceIndices: _rareChoiceIndices, cardsDrawn: _cardsDrawn, raresDrawn: _raresDrawn,
        drawsReserved: _drawsReserved, prismaticSources: _prismaticSources,
        prismaticDraws: _prismaticDraws, availableSources: _availableSources,
        guardianGems: _guardianGems, potionQueue, ...publicOffer
      } = offer
      const maskedPotionQueue = potionQueue?.map(() => null)
      return { publicOffer: { ...publicOffer, choices: null, potionQueue: maskedPotionQueue }, maskedPotionQueue }
    }),
    roomStateShared,
    courier: fastClone(baseRun.courier),
    campaignBase: {
      runId: baseRun.campaign.runId,
      bossesDefeated: baseRun.campaign.bossesDefeated,
      highestBossActDefeated: baseRun.campaign.highestBossActDefeated,
      ...(baseRun.campaign.bossCoins ? { bossCoins: fastClone(baseRun.campaign.bossCoins) } : {}),
      keys: fastClone(baseRun.campaign.keys),
      finalized: baseRun.campaign.finalized,
    },
  }
  shared.run = sharedRun
  return sharedRun
}

function redactRun(run, viewerId, room, shared) {
  const sharedRun = initSharedRun(room.run, room, shared)
  const viewerCharacter = viewerId !== null ? run.players.find((player) => player.id === viewerId)?.character : undefined
  const rsShared = sharedRun.roomStateShared
  let roomState = null
  if (rsShared?.kind === 'event') {
    const rs = run.roomState
    const decisions = viewerId && Object.hasOwn(rs.decisions, viewerId)
      ? { ...rsShared.publicDecisions, [viewerId]: fastClone(rs.decisions[viewerId]) }
      : rsShared.publicDecisions
    const rewardOffers = viewerId && rs.rewardOffers && Object.hasOwn(rs.rewardOffers, viewerId)
      ? { ...rsShared.publicRewardOffers, [viewerId]: fastClone(rs.rewardOffers[viewerId]) }
      : rsShared.publicRewardOffers
    const guardianGemOffers = viewerId && rs.guardianGemOffers && Object.hasOwn(rs.guardianGemOffers, viewerId)
      ? { ...rsShared.publicGuardianGemOffers, [viewerId]: fastClone(rs.guardianGemOffers[viewerId]) }
      : rsShared.publicGuardianGemOffers
    const labChoices = viewerId && rs.labChoices && Object.hasOwn(rs.labChoices, viewerId)
      ? { ...rsShared.publicLabChoices, [viewerId]: fastClone(rs.labChoices[viewerId]) }
      : rsShared.publicLabChoices
    roomState = {
      kind: 'event',
      card: rsShared.card,
      decisions,
      dieRolls: rsShared.dieRolls,
      rewardOffers,
      guardianGemOffers,
      itemOffers: rsShared.itemOffers,
      pendingDecisions: viewerId && rs.pendingDecisions?.[viewerId]
        ? { [viewerId]: fastClone(rs.pendingDecisions[viewerId]) }
        : {},
      pendingRolls: viewerId && rs.pendingRolls?.[viewerId]
        ? { [viewerId]: fastClone(rs.pendingRolls[viewerId]) }
        : {},
      revealedCards: rsShared.revealedCards,
      revealedCardDefs: rsShared.revealedCardDefs,
      revealedRelics: rsShared.revealedRelics,
      availableRewardSources: rsShared.availableRewardSources,
      partyOptionIds: rsShared.partyOptionIds,
      preparedStartTurnScryAbilities: rsShared.preparedStartTurnScryAbilities,
      preparedStartTurnScry: rsShared.preparedScry ? {
        ...rsShared.preparedScry,
        cards: rsShared.preparedScry.playerId === viewerId ? fastClone(rsShared.preparedScry.cards) : null,
      } : undefined,
      preparedStartTurnCoordinatorId: rsShared.preparedStartTurnCoordinatorId,
      preparedCombat: rs.preparedCombat
        ? {
          players: rs.preparedCombat.players.map((player) => ({
            id: player.id,
            hand: player.id === viewerId ? fastClone(player.hand) : null,
          })),
          enemies: rsShared.preparedCombatEnemies,
          ...(rsShared.preparedCombatHermitSetupLoads ? {
            pendingHermitSetupLoads: rsShared.preparedCombatHermitSetupLoads,
          } : {}),
        }
        : undefined,
      pendingTrade: rs.pendingTrade
        ? viewerId === rs.pendingTrade.actorId || viewerId === rs.pendingTrade.targetId
          ? {
            ...fastClone(rs.pendingTrade),
            decision: viewerId === rs.pendingTrade.actorId
              ? fastClone(rs.pendingTrade.decision)
              : { optionIds: [...rs.pendingTrade.decision.optionIds], targetPlayerId: rs.pendingTrade.targetId },
          }
          : {
            actorId: rs.pendingTrade.actorId,
            targetId: rs.pendingTrade.targetId,
            kind: rs.pendingTrade.kind,
            offeredId: '',
            decision: { optionIds: [], targetPlayerId: rs.pendingTrade.targetId },
          }
        : undefined,
      labChoices,
    }
  } else if (rsShared?.kind === 'cloned') {
    roomState = {
      ...rsShared.base,
      decisions: Object.fromEntries(Object.entries(run.roomState.decisions).map(([playerId, decision]) => [
        playerId,
        playerId === viewerId || typeof decision === 'number' ? decision : 'skip',
      ])),
    }
  } else if (rsShared?.kind === 'plain') {
    roomState = rsShared.value
  }

  return {
    ascension: run.ascension,
    chooseYourRelic: run.chooseYourRelic,
    lastStand: run.lastStand,
    meta: sharedRun.meta,
    setup: sharedRun.setup,
    act: run.act,
    phase: run.phase,
    // Dealt Blessing faces are public; card offers and the remaining shuffled
    // deck stay private to the owner and authoritative table respectively.
    neow: run.neow ? {
      players: viewerId && Object.hasOwn(run.neow.players, viewerId)
        ? { ...sharedRun.publicNeow, [viewerId]: neowPreview(run, viewerId, viewerId) }
        : sharedRun.publicNeow,
    } : null,
    pendingBossDefId: null,
    pendingGuardianSockets: (run.pendingGuardianSockets ?? [])
      .filter((pending, index) => run.phase === 'reward' ? pending.playerId === viewerId : index === 0)
      .slice(0, 1)
      .map((pending) => pending.playerId === viewerId ? fastClone(pending) : { playerId: pending.playerId }),
    // Public, unlike `pendingBossDefId`: setup rolls this act's boss in the open
    // before anybody moves, and the map names it so decks can be built for it.
    // The Ascension 13 SECOND Act III boss above stays hidden — that one is not
    // rolled at the table, it is drawn when the first boss falls.
    actBossDefId: run.actBossDefId ?? null,
    canRerollDownfallSelfBoss: sharedRun.canRerollDownfallSelfBoss,
    map: sharedRun.map,
    // Public facts only: "Ann played Strike", "Turn 1 begins (die 3)".
    log: run.log,
    players: run.players.map((player, index) => redactPlayerForViewer(player, sharedRun.publicPlayers[index], viewerId)),
    combat: run.combat ? redactCombat(run.combat, viewerId, room.run.combat, shared) : null,
    // Card rewards belong to their owner: teammates know a reward exists but
    // never receive the offered cards or the server-side draw bookkeeping.
    rewards: run.rewards.map((offer, index) => {
      const entry = sharedRun.publicRewards[index]
      if (offer.playerId === viewerId) return { ...offer, potionQueue: entry.maskedPotionQueue }
      return entry.publicOffer
    }),
    roomState,
    courier: sharedRun.courier,
    campaign: viewerCharacter && run.campaign.joinedAfterBosses?.[viewerCharacter]
      ? {
        ...sharedRun.campaignBase,
        // A Catch Up joiner is owed only the bosses beaten after their hero arrived.
        joinedAfterBosses: { [viewerCharacter]: run.campaign.joinedAfterBosses[viewerCharacter] },
      }
      : sharedRun.campaignBase,
  }
}

function startChoiceOwnerOf(combat, progressOwners, choice) {
  return progressOwners?.get(choice.id) ?? combat.players.find((player) =>
    choice.id.startsWith(`${player.id}/`) || choice.id.startsWith(`${combat.combatId}/${combat.turn}/${player.id}/`) ||
    choice.id.startsWith(`facing:${player.id}`) || choice.id.startsWith(`guardian:${player.id}/`))?.id
}

function initSharedCombat(baseCombat, shared) {
  if (shared.combat) return shared.combat
  const progress = baseCombat.startTurnProgress
  const progressOwners = progress
    ? new Map(startTurnAbilities(baseCombat).map((ability) => [ability.id, ability.playerId]))
    : null
  const progressChoiceOwners = progress?.choices?.map((choice) => startChoiceOwnerOf(baseCombat, progressOwners, choice))
  const progressPublicChoices = progress?.choices?.map((choice) => {
    const copy = fastClone(choice)
    copy.exhaustUids = undefined
    copy.trigger = undefined
    return copy
  })
  const sharedCombat = {
    initialEnemyCount: initialEnemySlots(baseCombat),
    pendingTriggers: fastClone(baseCombat.pendingTriggers ?? []),
    progressOwners,
    progressChoiceOwners,
    progressPublicChoices,
    progressBeforeDraw: progress?.beforeDraw ? fastClone(progress.beforeDraw) : undefined,
    progressRollPending: progress?.rollPending ? fastClone(progress.rollPending) : undefined,
    progressDiscard: progress?.discard ? {
      playerId: progress.discard.playerId,
      sourceId: progress.discard.sourceId,
      // Draw reactions can reveal the privately drawn card's type. The
      // authoritative queue stays server-side until the owner discards.
      pendingTriggers: [],
    } : undefined,
    pendingHermitSetupLoads: fastClone(baseCombat.pendingHermitSetupLoads ?? []),
    pendingDieRelicChoices: fastClone(baseCombat.pendingDieRelicChoices ?? []),
    pendingHermitChamberPlaysPublic: (baseCombat.pendingHermitChamberPlays ?? []).map((pending) => ({
      playerId: pending.playerId,
      sourceCardId: pending.sourceCardId,
      free: pending.free,
      cardUids: [],
      cardCount: pending.cardUids.length,
    })),
    pendingHermitStrengthRewards: fastClone(baseCombat.pendingHermitStrengthRewards ?? []),
    pendingPlayerChoices: fastClone(baseCombat.pendingPlayerChoices ?? []),
    pendingSlayerChoicesPublic: baseCombat.pendingSlayerChoices?.length
      ? baseCombat.pendingSlayerChoices.map((choice) => choice.kind === 'ritualDagger'
        ? { ...choice, revealed: null }
        : fastClone(choice))
      : undefined,
    pendingPlunderSwitches: fastClone(baseCombat.pendingPlunderSwitches ?? []),
    playedCardsThisTurn: fastClone(baseCombat.playedCardsThisTurn ?? []),
    stanceChangedSet: new Set(baseCombat.stanceChangedThisTurn),
    presentationEvents: (baseCombat.presentationEvents ?? []).map((event) => ({
      seq: event.seq,
      kind: event.kind,
      actorId: event.actorId,
      sourceId: event.sourceId,
      enemyIds: [...event.enemyIds],
      playerIds: [...event.playerIds],
      ...(event.enemyRow === undefined ? {} : { enemyRow: event.enemyRow }),
      // Public per-enemy damage of a staged skin's attack (its hits show the hero's share, a Slime Command its own).
      ...(event.enemyHpLoss === undefined ? {} : { enemyHpLoss: { ...event.enemyHpLoss } }),
      ...(event.kind === 'card' ? {
        upgraded: event.upgraded,
        copied: event.copied,
        energy: event.energy,
        ...(event.mode === undefined ? {} : { mode: event.mode }),
        ...(event.resolvedType === undefined ? {} : { resolvedType: event.resolvedType }),
      } : {}),
      ...(event.kind === 'slime' ? {
        slimeUid: event.slimeUid,
        upgraded: event.upgraded,
        animationIndex: event.animationIndex,
      } : {}),
      ...(event.kind === 'orb' ? { orb: event.orb } : {}),
      ...(event.kind === 'turn' ? { effect: event.effect, actorTargeted: event.actorTargeted } : {}),
    })),
    pendingSummons: fastClone(baseCombat.pendingSummons ?? []),
    enemies: baseCombat.enemies.map(({ poisonSources: _poisonSources, ...enemy }) => enemy),
    publicPlayers: baseCombat.players.map(redactPlayerPublic),
  }
  shared.combat = sharedCombat
  return sharedCombat
}

function redactCombat(combat, viewerId, baseCombat, shared) {
  const sc = initSharedCombat(baseCombat, shared)
  const progress = combat.startTurnProgress
  const redactStartChoice = (choice) => {
    const owner = startChoiceOwnerOf(combat, sc.progressOwners, choice)
    const copy = fastClone(choice)
    copy.exhaustUids = owner === viewerId ? fastClone(choice.exhaustUids) : undefined
    copy.trigger = owner === viewerId ? fastClone(choice.trigger) : undefined
    return copy
  }
  const visibleProgressChoices = !progress?.choices ? undefined
    : sc.progressChoiceOwners && progress.choices === baseCombat.startTurnProgress?.choices
      ? progress.choices.some((choice, index) => sc.progressChoiceOwners[index] === viewerId &&
        (choice.exhaustUids !== undefined || choice.trigger !== undefined))
        ? progress.choices.map((choice, index) => (
          sc.progressChoiceOwners[index] === viewerId
            ? {
              ...sc.progressPublicChoices[index],
              exhaustUids: fastClone(choice.exhaustUids),
              trigger: fastClone(choice.trigger),
            }
            : sc.progressPublicChoices[index]
        ))
        : sc.progressPublicChoices
      : progress.choices.map(redactStartChoice)

  let triggerPreview = null
  if ((combat.pendingTriggers?.length ?? 0) > 0) {
    const viewerDieChoice = combat.pendingDieRelicChoices?.some((choice) =>
      choice.playerId === viewerId && dieRelicChoiceNeedsInput(combat, choice))
    const triggerCombat = viewerDieChoice
      ? undefined : prioritizePendingTrigger(combat, (trigger) => trigger.playerId === viewerId)
    const preview = triggerCombat && pendingTriggerAbility(triggerCombat)
    if (preview?.playerId === viewerId) triggerPreview = fastClone(preview)
  }

  const chamberPlays = combat.pendingHermitChamberPlays
  const visibleChamberPlays = !chamberPlays?.length ? sc.pendingHermitChamberPlaysPublic
    : chamberPlays.some((pending) => pending.playerId === viewerId)
      ? chamberPlays.map((pending, index) => (
        pending.playerId === viewerId
          ? { ...sc.pendingHermitChamberPlaysPublic[index], cardUids: fastClone(pending.cardUids) }
          : sc.pendingHermitChamberPlaysPublic[index]
      ))
      : sc.pendingHermitChamberPlaysPublic

  const slayerChoices = combat.pendingSlayerChoices
  const visibleSlayerChoices = !slayerChoices?.length ? undefined
    : slayerChoices.some((choice) => choice.kind === 'ritualDagger' && choice.playerId === viewerId)
      ? slayerChoices.map((choice, index) => (
        choice.kind === 'ritualDagger' && choice.playerId === viewerId
          ? { ...choice, revealed: choice.revealed }
          : sc.pendingSlayerChoicesPublic[index]
      ))
      : sc.pendingSlayerChoicesPublic

  return {
    combatId: combat.combatId,
    initialEnemyCount: sc.initialEnemyCount,
    turn: combat.turn,
    die: combat.die,
    phase: combat.phase,
    lastStand: combat.lastStand === true,
    potionLimit: combat.potionLimit,
    startTurnStage: combat.startTurnStage,
    powerTriggersUsedThisTurn: combat.powerTriggersUsedThisTurn ?? [],
    pendingTriggers: sc.pendingTriggers,
    pendingTriggerAbility: triggerPreview,
    // Trigger ids are server allocators, not client state. Masking them also
    // prevents private draw reactions from becoming a count side channel.
    nextTriggerId: 0,
    startTurnProgress: progress ? {
      choices: visibleProgressChoices,
      beforeDraw: progress.beforeDraw ? sc.progressBeforeDraw : undefined,
      rollPending: progress.rollPending ? sc.progressRollPending : undefined,
      discard: progress.discard ? sc.progressDiscard : undefined,
      forcedCard: progress.forcedCard ? {
        playerId: progress.forcedCard.playerId,
        cardUid: progress.forcedCard.playerId === viewerId ? progress.forcedCard.cardUid : null,
        sourceCardId: progress.forcedCard.sourceCardId ?? 'mayhem',
        sourceLabel: progress.forcedCard.sourceLabel,
        exhaustNonPower: progress.forcedCard.exhaustNonPower === true,
      } : undefined,
    } : undefined,
    pendingCardCopy: combat.pendingCardCopy ? {
      id: combat.pendingCardCopy.playerId === viewerId ? combat.pendingCardCopy.id : 0,
      playerId: combat.pendingCardCopy.playerId,
      card: fastClone(combat.pendingCardCopy.card),
      energySpent: combat.pendingCardCopy.energySpent,
      resumePhase: combat.pendingCardCopy.resumePhase,
      forcedExhaust: combat.pendingCardCopy.forcedExhaust,
      forcedChoices: combat.pendingCardCopy.forcedChoices?.map(redactStartChoice) ?? null,
      deferredHavocs: fastClone(combat.pendingCardCopy.deferredHavocs),
      deferredTriggers: fastClone(combat.pendingCardCopy.deferredTriggers ?? []),
      sourceNames: fastClone(combat.pendingCardCopy.sourceNames),
      virtualOnly: combat.pendingCardCopy.virtualOnly === true,
      queuedWeaves: combat.pendingCardCopy.playerId === viewerId
        ? fastClone(combat.pendingCardCopy.queuedWeaves ?? [])
        : [],
    } : undefined,
    pendingDistilled: combat.pendingDistilled ? {
      playerId: combat.pendingDistilled.playerId,
      cards: combat.pendingDistilled.playerId === viewerId
        ? fastClone(combat.pendingDistilled.cards)
        : null,
    } : undefined,
    pendingHermitSetupLoads: sc.pendingHermitSetupLoads,
    pendingDieRelicChoices: sc.pendingDieRelicChoices,
    pendingHermitChamberPlays: visibleChamberPlays,
    pendingHermitStrengthRewards: sc.pendingHermitStrengthRewards,
    // Slayer Pack: A window offers private hand cards, so only its owner sees it.
    ...(combat.pendingCardPlayWindows?.some((window) => window.playerId === viewerId) ? {
      pendingCardPlayWindows: fastClone(combat.pendingCardPlayWindows
        .filter((window) => window.playerId === viewerId)),
    } : {}),
    // Slayer Pack: public: who owes which choice, never the cards it reveals.
    pendingPlayerChoices: sc.pendingPlayerChoices,
    // Slayer Pack: the revealed rare reward is its owner's alone.
    ...(visibleSlayerChoices ? { pendingSlayerChoices: visibleSlayerChoices } : {}),
    pendingPlunderSwitches: sc.pendingPlunderSwitches,
    pendingRelicScry: combat.pendingRelicScry ? {
      id: combat.pendingRelicScry.playerId === viewerId ? combat.pendingRelicScry.id : 0,
      playerId: combat.pendingRelicScry.playerId,
      relicIndex: combat.pendingRelicScry.relicIndex,
      cards: combat.pendingRelicScry.playerId === viewerId
        ? fastClone(combat.pendingRelicScry.cards)
        : null,
    } : undefined,
    playedCardsThisTurn: sc.playedCardsThisTurn,
    viewerStanceChangedThisTurn: viewerId !== null && sc.stanceChangedSet.has(viewerId),
    presentationEvents: sc.presentationEvents,
    // Pending summons are public telegraphed enemy-card effects; the shuffled
    // Summons deck itself remains server-only.
    pendingSummons: sc.pendingSummons,
    log: combat.log,
    // Enemies carry nothing secret: hit points, tokens and the cube's position
    // are all printed on the card and face up on the table.
    enemies: sc.enemies,
    players: combat.players.map((player, index) => redactPlayerForViewer(player, sc.publicPlayers[index], viewerId)),
  }
}

/**
 * What every observer may see of a player (never includes hand, draw, chamber,
 * deck, or private relic bookkeeping).
 *
 * An ALLOWLIST, deliberately. The obvious way to write this is to destructure
 * the secrets out and spread the rest — but then every field added to `Player`
 * later is published by default, and the failure is silent. Listing what goes
 * out means a new field is invisible until someone decides it is public, which
 * is the safe direction to fail in.
 */
function redactPlayerPublic(player) {
  let tradableDeckCount = 0
  for (let i = 0; i < player.deck.length; i += 1) {
    if (player.deck[i].defId !== 'ascenders_bane') tradableDeckCount += 1
  }
  return {
    id: player.id,
    name: player.name,
    character: player.character,
    ...(isSkinOf(player.character, player.skin) ? { skin: player.skin } : {}),
    row: player.row,
    hp: player.hp,
    maxHp: player.maxHp,
    block: player.block,
    energy: player.energy,
    gold: player.gold,
    strength: player.strength,
    strengthLossAtEndOfTurn: player.strengthLossAtEndOfTurn,
    vulnerable: player.vulnerable,
    weak: player.weak,
    drawLocked: player.drawLocked === true,
    lostHpThisCombat: player.lostHpThisCombat === true,
    hpLostThisRound: player.hpLostThisRound ?? 0,
    ...(player.lostHpLastRound ? { lostHpLastRound: true } : {}),
    hpLossLimitThisRound: player.hpLossLimitThisRound,
    freeCardsThisTurn: player.freeCardsThisTurn ?? 0,
    nextCardCost: player.nextCardCost ?? null,
    enemyNextCardCost: player.enemyNextCardCost ?? null,
    freeAttacksThisTurn: player.freeAttacksThisTurn ?? 0,
    cardPlayLocked: player.cardPlayLocked === true,
    doubledAttacksThisTurn: player.doubledAttacksThisTurn ?? 0,
    tripledAttacksThisTurn: player.tripledAttacksThisTurn ?? 0,
    doubledCardsThisTurn: player.doubledCardsThisTurn ?? 0,
    doubledSkillsThisTurn: player.doubledSkillsThisTurn ?? 0,
    retainCardsThisTurn: player.retainCardsThisTurn ?? 0,
    cardsPlayedThisTurn: player.cardsPlayedThisTurn ?? 0,
    attacksPlayedThisTurn: player.attacksPlayedThisTurn ?? 0,
    powerPlayedThisTurn: player.powerPlayedThisTurn === true,
    shuffledThisCombat: player.shuffledThisCombat === true,
    facingEnemyUid: player.facingEnemyUid ?? null,
    damageDealtZeroThisTurn: player.damageDealtZeroThisTurn === true,
    shivs: player.shivs,
    shivDamageBonus: player.shivDamageBonus ?? 0,
    cardBlockBonus: player.cardBlockBonus ?? 0,
    hitPoison: player.hitPoison ?? 0,
    starterStrikeDamageBonus: player.starterStrikeDamageBonus ?? 0,
    clawCubesGainedThisCombat: player.clawCubesGainedThisCombat ?? 0,
    starterDefendBlockBonus: player.starterDefendBlockBonus ?? 0,
    miracles: player.miracles,
    stance: player.stance,
    wrathAttackDamageBonus: player.wrathAttackDamageBonus ?? 0,
    orbs: player.orbs,
    orbEvokeBonus: player.orbEvokeBonus ?? 0,
    darkOrbEvokeBonus: player.darkOrbEvokeBonus ?? 0,
    orbEndTurnBonus: player.orbEndTurnBonus ?? 0,
    lightningEndTurnBonus: player.lightningEndTurnBonus ?? 0,
    damageStats: fastClone(player.damageStats),
    freeGemCardsThisTurn: player.freeGemCardsThisTurn ?? 0,
    freePowersThisTurn: player.freePowersThisTurn ?? 0,
    nextPowerOrSlimeDiscount: player.nextPowerOrSlimeDiscount,
    nextAttackRapidFire: player.nextAttackRapidFire ?? 0,
    energySpentThisTurn: player.energySpentThisTurn ?? 0,
    spentTwoEnergyOnCardThisTurn: player.spentTwoEnergyOnCardThisTurn === true,
    heat: player.heat ?? 0,
    soulburn: player.soulburn ?? 0,
    soulburnUsedThisTurn: player.soulburnUsedThisTurn === true,
    nextSoulburnDamageBonus: player.nextSoulburnDamageBonus ?? 0,
    exhaustNextCardAfterUid: player.exhaustNextCardAfterUid,
    guardianMode: player.guardianMode ?? null,
    vigor: player.vigor ?? 0,
    vigorSpentThisTurn: player.vigorSpentThisTurn ?? 0,
    guardianModeLocked: player.guardianModeLocked === true,
    slimes: fastClone(player.slimes ?? []),
    lootChests: player.lootChests ?? 0,
    dead: player.dead,
    // Face up on the table.
    discard: player.discard,
    exhaust: player.exhaust,
    powers: player.powers,
    relics: player.relics.map(({
      guardianGemGroups: _gems,
      pendingRewardDraws: _draws,
      pendingRewardIndices: _rewards,
      ...relic
    }) => relic),
    potions: player.potions,
    chamberSlots: player.chamberSlots ?? 0,
    chamberCount: player.chamber?.length ?? 0,
    // Sizes are public — you can see how big a stack is. The owner may inspect
    // their draw pile as a set, so keep it in a stable non-pile order rather
    // than leaking the authoritative shuffled order.
    handCount: player.hand.length,
    drawCount: player.draw.length,
    deckCount: player.deck.length,
    tradableDeckCount,
    // Face-down reward stacks, secret even from their owner until drawn.
    cardRewardCount: player.cardRewards.length,
    rareRewardCount: player.rareRewards.length,
    // Yours alone — always nulled in the shared public projection.
    hand: null,
    draw: null,
    chamber: null,
    deck: null,
  }
}

function redactPlayerForViewer(player, publicPlayer, viewerId) {
  if (player.id !== viewerId) return publicPlayer
  // Hands are ordered; draw piles are sorted only to erase the authoritative
  // top-to-bottom order before they reach the client.
  return {
    ...publicPlayer,
    relics: player.relics,
    hand: player.hand,
    draw: [...player.draw].sort((left, right) =>
      left.defId.localeCompare(right.defId) || left.uid.localeCompare(right.uid)),
    chamber: player.chamber ?? [],
    deck: player.deck,
  }
}
