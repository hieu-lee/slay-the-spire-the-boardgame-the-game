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
 * viewer-independent start-turn planning, never redacted player data.
 */
export function snapshotFor(room, seatToken, shared = {}) {
  const seat = findSeat(room, seatToken)
  deferStartTurnTriggersForPostRoll(room)
  // Persist the empty post-roll decision before a broadcast derives the
  // downstream quorum. This also normalizes rooms restored from older saves.
  ensurePostRollChoiceWindowClosed(room)
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
  const viewerPlayer = run?.players.find((player) => player.id === viewerId)
  const pendingOwner = run?.phase === 'combat' ? undefined
    : run?.players.find((player) => player.relics.some((relic) => relic.pending))
  const pendingRelic = pendingOwner?.relics.find((relic) => relic.pending)
  const giveUpVote = activeGiveUpVote(room)
  const postRollPending = run?.combat?.phase === 'start' && roomPostRollChoicePending(room)
  if (run?.combat?.phase === 'start' && !Object.hasOwn(shared, 'startTurnAbilities')) {
    shared.startTurnAbilities = plannedStartTurnAbilities(room)
  }
  const privateStartAbilities = run?.combat?.phase === 'start' ? shared.startTurnAbilities : undefined
  if (run?.combat?.phase === 'start' && !Object.hasOwn(shared, 'savedStartTurnEnemyTargets')) {
    shared.savedStartTurnEnemyTargets = savedStartTurnEnemyTargets(room)
    shared.savedStartTurnChoiceIds = new Set((savedStartTurnChoices(room) ?? []).map((choice) => choice.id))
    shared.pendingNoxiousFumes = pendingNoxiousFumes(room)
  }
  const startAbilityOwners = new Map(privateStartAbilities?.map((ability) => [ability.id, ability.playerId]) ?? [])
  const visibleStartAbilities = postRollPending ? [] : privateStartAbilities?.map((ability) => ({
    ...structuredClone(ability),
    exhaustCards: ability.playerId === viewerId ? structuredClone(ability.exhaustCards) : undefined,
  }))
  const visibleStartChoices = run?.combat?.phase === 'start' && room.startTurnCombatId === run.combat.combatId
    ? (room.startTurnChoices ?? []).map((choice) => ({
      ...structuredClone(choice),
      exhaustUids: startAbilityOwners.get(choice.id) === viewerId ? structuredClone(choice.exhaustUids) : undefined,
      trigger: startAbilityOwners.get(choice.id) === viewerId ? structuredClone(choice.trigger) : undefined,
    }))
    : undefined
  const revisableStartTriggers = run?.combat?.phase === 'start' && !(run.combat.pendingTriggers ?? [])
    .some((trigger) => trigger.playerId === viewerId)
    ? room.startTurnStagedTriggers?.filter((trigger) => trigger.playerId === viewerId) ?? []
    : []
  if (run?.combat?.phase === 'start' && !Object.hasOwn(shared, 'pendingStartOwners')) {
    shared.pendingStartOwners = new Set(!postRollPending
      ? [shared.pendingNoxiousFumes?.playerId, ...((privateStartAbilities ?? [])
        .filter((ability) => startTurnAbilityNeedsChoice(
          ability, shared.savedStartTurnEnemyTargets, shared.savedStartTurnChoiceIds,
        ))
        .map((ability) => ability.playerId)), ...(run.combat.pendingTriggers ?? [])
          .filter((trigger) => trigger.startTurn).map((trigger) => trigger.playerId)].filter(Boolean)
      : [])
  }
  const pendingStartOwners = run?.combat?.phase === 'start' ? shared.pendingStartOwners : new Set()
  if (run?.combat?.phase === 'start' && !Object.hasOwn(shared, 'startTurnOrderOwner')) {
    shared.startTurnOrderOwner = postRollPending
      ? undefined : cachedStartTurnOrderChoicePlayerId(room, privateStartAbilities)
  }
  if (run?.combat?.phase === 'start' && !Object.hasOwn(shared, 'startTurnRequired')) {
    shared.startTurnRequired = room.startTurnRequired ?? roomStartTurnChoicePlayerIds(
      room, privateStartAbilities, false, [], shared.startTurnOrderOwner,
    )
  }
  const startTurnRequired = run?.combat?.phase === 'start' ? shared.startTurnRequired : undefined
  if (run?.combat?.phase === 'start' && !Object.hasOwn(shared, 'startTurnOrderPending')) {
    shared.startTurnOrderPending = startTurnOrderPending(
      room, privateStartAbilities, shared.startTurnOrderOwner,
    )
  }
  if (run?.combat?.phase === 'start' && !Object.hasOwn(shared, 'startTurnCoordinatorId')) {
    shared.startTurnCoordinatorId = startTurnCoordinator(
      room, privateStartAbilities, shared.startTurnOrderOwner, shared.startTurnOrderPending,
      shared.startTurnRequired,
    )
  }

  return {
    code: room.code,
    phase: room.phase,
    selectingCampaign: room.selectingCampaign === true,
    ascension: room.ascension,
    chooseYourRelic: room.chooseYourRelic === true,
    lastStand: room.lastStand === true,
    metaOptions: structuredClone(room.metaOptions ?? { mode: 'standard', modifiers: [], quickStartAct: 1 }),
    // In the lobby, the packs a run started now would use; once it starts, the packs it froze.
    cardPacks: run ? [...(run.meta?.cardPacks ?? [])] : roomCardPacks(room),
    // Only a seat that played a recorded run hears of its coins, and only its own share.
    ...(seat && room.recordedRuns?.some((recorded) => Object.hasOwn(recorded.skips, seat.token)) ? {
      recordedRuns: room.recordedRuns.filter((recorded) => Object.hasOwn(recorded.skips, seat.token)).map((recorded) => ({
        runId: recorded.runId, bossCoins: structuredClone(recorded.bossCoins), skip: recorded.skips[seat.token],
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
    campfireTransformAvailable: run?.phase === 'room' && currentRoom(run.map)?.kind === 'campfire'
      ? viewerPlayer ? campfireTransformAvailable(viewerPlayer) : undefined
      : undefined,
    quickSetupTransformAvailable: run?.phase === 'setup' && run.setup &&
      currentQuickSetupStep(run.setup)?.kind === 'transform' &&
      run.setup.playerIds[run.setup.playerIndex] === viewerId && viewerPlayer
      ? availableTransformRewards(viewerPlayer) > 0 : undefined,
    /** Seats that have chosen at the campfire, so the UI can show who is left. */
    campfireDecided: Object.keys(room.campfireChoices ?? {}),
    endTurnDecided: Object.entries(room.endTurnReady ?? room.endTurnOrders ?? {})
      .filter(([playerId, decision]) => decision !== false && (run?.combat?.phase !== 'discard' || room.seats
        .some((candidate) => candidate.connected && candidate.playerId === playerId))).map(([playerId]) => playerId),
    endTurnRequired: run?.combat?.phase === 'discard'
      ? run.combat.players.filter((player) => discardNeedsChoice(player) && room.seats
        .some((candidate) => candidate.connected && candidate.playerId === player.id)).map((player) => player.id)
      : Object.keys(room.endTurnReady ?? {}),
    endTurnTopPlayerIds: run?.combat?.phase === 'discard'
      ? run.combat.players.filter((player) => player.id === viewerId && discardTopNeedsChoice(player) && room.seats
        .some((candidate) => candidate.connected && candidate.playerId === player.id)).map((player) => player.id)
      : undefined,
    endTurnAbilities: visibleEndTurnAbilities(room, viewerId),
    startTurnAbilities: visibleStartAbilities,
    startTurnRequired: room.startTurnRequired ?? startTurnRequired,
    startTurnDecided: run?.combat?.phase === 'start'
      ? Object.entries(room.startTurnReady ?? {})
        .filter(([playerId, ready]) => ready && !pendingStartOwners.has(playerId)).map(([playerId]) => playerId)
      : undefined,
    startTurnChoiceId: run?.combat?.phase === 'start' && !postRollPending
      ? shared.pendingNoxiousFumes?.id : undefined,
    startTurnEnemyTargets: run?.combat?.phase === 'start' ? shared.savedStartTurnEnemyTargets : undefined,
    startTurnChoices: visibleStartChoices,
    stagedStartTurnTriggers: revisableStartTriggers.flatMap((trigger) => {
      const ability = pendingTriggerAbility({
        ...run.combat, pendingTriggers: [trigger, ...(run.combat.pendingTriggers ?? [])],
      })
      return ability?.playerId === viewerId ? [{ ...structuredClone(ability),
        choiceId: `${trigger.playerId}/${trigger.sourceId}` }] : []
    }),
    startTurnPostRollLocked: run?.combat?.phase === 'start' ? roomPostRollChoiceDone(room) : undefined,
    startTurnOrderPending: run?.combat?.phase === 'start' ? shared.startTurnOrderPending : undefined,
    startTurnOrderLocked: run?.combat?.phase === 'start' &&
      room.startTurnCombatId === run.combat.combatId && Array.isArray(room.startTurnOrder),
    startTurnScryAbilities: run?.combat?.phase === 'start'
      ? startTurnScryAbilities(run.combat)
      : undefined,
    startTurnCoordinatorId: run?.combat?.phase === 'start' ? shared.startTurnCoordinatorId : undefined,
    startTurnScry: run?.combat ? (() => {
      const preview = startTurnScryPreview(run.combat)
      return preview ? {
        ...preview,
        cards: preview.playerId === viewerId ? structuredClone(preview.cards) : null,
      } : undefined
    })() : undefined,
    startTurnDiscard: run?.combat ? (() => {
      const preview = startTurnDiscardPreview(run.combat)
      return preview ? {
        ...preview,
        cards: preview.playerId === viewerId ? structuredClone(preview.cards) : null,
      } : undefined
    })() : undefined,
    discardOrder: viewerId !== null && room.endTurnOrders?.[viewerId]
      ? [...room.endTurnOrders[viewerId]]
      : undefined,
    cardPreview: viewerId !== null && room.cardPreviews?.[viewerId]
      ? visibleCardPreview(room.cardPreviews[viewerId])
      : undefined,
    powerPreview: viewerId !== null && room.powerPreviews?.[viewerId]
      ? structuredClone(room.powerPreviews[viewerId])
      : undefined,
    cardChoicePlayerId: Object.keys(room.cardPreviews ?? {})[0] ??
      Object.keys(room.powerPreviews ?? {})[0] ?? run?.combat?.pendingCardCopy?.playerId,
    merchantPledges: Object.fromEntries(Object.entries(room.merchantPledges ?? {}).map(([key, pledge]) => [key, {
      ...structuredClone(pledge),
      cardUid: pledge.kind === 'removal' && pledge.buyerId !== viewerId ? undefined : pledge.cardUid,
    }])),
    merchantReady: [...(room.merchantReady ?? [])],
    courierPledge: room.courierPledge ? structuredClone(room.courierPledge) : undefined,
    eventPledge: room.eventPledge ? {
      actorId: room.eventPledge.actorId,
      optionId: room.eventPledge.optionId,
      cost: room.eventPledge.cost,
      payments: structuredClone(room.eventPledge.payments),
      decision: room.eventPledge.actorId === viewerId
        ? structuredClone(room.eventPledge.decision)
        : { optionIds: [room.eventPledge.optionId] },
    } : undefined,
    eventCanSkip: viewerId !== null && run ? canSkipEvent(run, viewerId) : false,
    unavailableEventOptionIds: viewerId !== null && run ? unavailableEventOptionIds(run, viewerId) : [],
    giveUpVote: giveUpVote && viewerId && giveUpVote.eligiblePlayerIds.includes(viewerId) ? {
      ...structuredClone(giveUpVote),
      remainingMs: Math.max(0, giveUpVote.deadlineAt - Date.now()),
    } : undefined,
    campaignProgress: {
      version: room.campaignProgress.version,
      characters: structuredClone(room.campaignProgress.characters),
      colorless: room.campaignProgress.colorless,
      actIV: room.campaignProgress.actIV,
      unspentMarks: room.campaignProgress.unspentMarks,
      highestAscension: room.campaignProgress.highestAscension,
      nextRunNumber: room.campaignProgress.nextRunNumber ?? 0,
      finishedRunIds: [...(room.campaignProgress.finishedRunIds ?? [])],
    },
    seats: room.seats.map(seatPublic),
    pendingRelic: viewerId && run ? pendingRelicPreview(run, viewerId) : null,
    pendingRelicStatus: pendingOwner && pendingRelic ? {
      playerId: pendingOwner.id, playerName: pendingOwner.name, relicId: pendingRelic.defId,
    } : null,
    pendingTeammateAcquisitionPlayerId: run?.players.find((player) =>
      player.id !== viewerId && hasPendingRelicAcquisition(run, player.id))?.id ?? null,
    run: visibleRun ? redactRun(visibleRun, viewerId, room) : null,
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

function redactRun(run, viewerId, room) {
  const viewerCharacter = run.players.find((player) => player.id === viewerId)?.character
  const preparedCombat = run.roomState?.kind === 'event' ? run.roomState.preparedCombat : undefined
  const preparedScry = preparedCombat ? startTurnScryPreview(preparedCombat) : undefined
  const roomState = run.roomState?.kind === 'event'
    ? {
        kind: 'event',
        card: structuredClone(run.roomState.card),
        decisions: Object.fromEntries(Object.entries(run.roomState.decisions).map(([playerId, decision]) => [
          playerId,
          playerId === viewerId ? structuredClone(decision) : { optionIds: [...decision.optionIds] },
        ])),
        dieRolls: structuredClone(run.roomState.dieRolls),
        rewardOffers: Object.fromEntries(Object.entries(run.roomState.rewardOffers ?? {}).map(([playerId, offers]) => [
          playerId,
          playerId === viewerId ? structuredClone(offers) : offers.map(() => []),
        ])),
        guardianGemOffers: Object.fromEntries(Object.entries(run.roomState.guardianGemOffers ?? {}).map(([playerId, offers]) => [
          playerId,
          playerId === viewerId ? structuredClone(offers) : offers.map(() => []),
        ])),
        itemOffers: structuredClone(run.roomState.itemOffers ?? {}),
        pendingDecisions: viewerId && run.roomState.pendingDecisions?.[viewerId]
          ? { [viewerId]: structuredClone(run.roomState.pendingDecisions[viewerId]) }
          : {},
        pendingRolls: viewerId && run.roomState.pendingRolls?.[viewerId]
          ? { [viewerId]: structuredClone(run.roomState.pendingRolls[viewerId]) }
          : {},
        revealedCards: structuredClone(run.roomState.revealedCards ?? {}),
        revealedCardDefs: structuredClone(run.roomState.revealedCardDefs ?? {}),
        revealedRelics: structuredClone(run.roomState.revealedRelics ?? {}),
        availableRewardSources: structuredClone(run.roomState.availableRewardSources),
        partyOptionIds: structuredClone(run.roomState.partyOptionIds),
        preparedStartTurnScryAbilities: preparedCombat ? startTurnScryAbilities(preparedCombat) : undefined,
        preparedStartTurnScry: preparedScry ? {
          ...preparedScry,
          cards: preparedScry.playerId === viewerId ? structuredClone(preparedScry.cards) : null,
        } : undefined,
        preparedStartTurnCoordinatorId: preparedCombat
          ? room.seats.find((seat) => seat.connected !== false && preparedCombat.players
              .some((player) => player.id === seat.playerId && !player.dead))?.playerId ?? null
          : undefined,
        preparedCombat: run.roomState.preparedCombat
          ? { players: run.roomState.preparedCombat.players.map((player) => ({
              id: player.id,
              hand: player.id === viewerId ? structuredClone(player.hand) : null,
            })),
            enemies: run.roomState.preparedCombat.enemies.map((enemy) => ({
              uid: enemy.uid,
              defId: enemy.defId,
              row: enemy.row,
              isBoss: enemy.isBoss,
              ascension: enemy.ascension,
              hp: enemy.hp,
              maxHp: enemy.maxHp,
              dead: enemy.dead,
            })),
            ...(run.roomState.preparedCombat.pendingHermitSetupLoads?.length ? {
              pendingHermitSetupLoads: structuredClone(run.roomState.preparedCombat.pendingHermitSetupLoads),
            } : {}),
          }
          : undefined,
        pendingTrade: run.roomState.pendingTrade
          ? viewerId === run.roomState.pendingTrade.actorId || viewerId === run.roomState.pendingTrade.targetId
            ? {
              ...structuredClone(run.roomState.pendingTrade),
              decision: viewerId === run.roomState.pendingTrade.actorId
                ? structuredClone(run.roomState.pendingTrade.decision)
                : { optionIds: [...run.roomState.pendingTrade.decision.optionIds], targetPlayerId: run.roomState.pendingTrade.targetId },
            }
            : {
                actorId: run.roomState.pendingTrade.actorId,
                targetId: run.roomState.pendingTrade.targetId,
                kind: run.roomState.pendingTrade.kind,
                offeredId: '',
                decision: { optionIds: [], targetPlayerId: run.roomState.pendingTrade.targetId },
              }
          : undefined,
        labChoices: Object.fromEntries(Object.keys(run.roomState.labChoices ?? {}).map((playerId) => [playerId, playerId === viewerId ? structuredClone(run.roomState.labChoices[playerId]) : { optionIds: ['resolve'] }])),
      }
    : run.roomState?.kind === 'treasure' || run.roomState?.kind === 'elite'
      ? {
          ...structuredClone(run.roomState),
          decisions: Object.fromEntries(Object.entries(run.roomState.decisions).map(([playerId, decision]) => [
            playerId,
            playerId === viewerId || typeof decision === 'number' ? decision : 'skip',
          ])),
        }
      : run.roomState ? structuredClone(run.roomState) : null
  return {
    ascension: run.ascension,
    chooseYourRelic: run.chooseYourRelic,
    lastStand: run.lastStand,
    meta: structuredClone(run.meta ?? { mode: 'standard', modifierIds: [] }),
    setup: run.setup ? structuredClone(run.setup) : null,
    act: run.act,
    phase: run.phase,
    // Dealt Blessing faces are public; card offers and the remaining shuffled
    // deck stay private to the owner and authoritative table respectively.
    neow: run.neow ? {
      players: Object.fromEntries(Object.keys(run.neow.players).map((playerId) => [
        playerId,
        neowPreview(run, playerId, viewerId),
      ])),
    } : null,
    pendingBossDefId: null,
    pendingGuardianSockets: (run.pendingGuardianSockets ?? [])
      .filter((pending, index) => run.phase === 'reward' ? pending.playerId === viewerId : index === 0)
      .slice(0, 1)
      .map((pending) => pending.playerId === viewerId ? structuredClone(pending) : { playerId: pending.playerId }),
    // Public, unlike `pendingBossDefId`: setup rolls this act's boss in the open
    // before anybody moves, and the map names it so decks can be built for it.
    // The Ascension 13 SECOND Act III boss above stays hidden — that one is not
    // rolled at the table, it is drawn when the first boss falls.
    actBossDefId: run.actBossDefId ?? null,
    canRerollDownfallSelfBoss: canRerollDownfallSelfBoss(run),
    map: visibleMap(run),
    // Public facts only: "Ann played Strike", "Turn 1 begins (die 3)".
    log: run.log,
    players: run.players.map((player) => redactPlayer(player, viewerId)),
    combat: run.combat ? redactCombat(run.combat, viewerId) : null,
    // Card rewards belong to their owner: teammates know a reward exists but
    // never receive the offered cards or the server-side draw bookkeeping.
    rewards: run.rewards.map((offer) => {
      if (offer.playerId === viewerId) return { ...offer, potionQueue: offer.potionQueue?.map(() => null) }
      const {
        choices, cardSource, prismatic, upgraded, rareChoiceIndices, cardsDrawn, raresDrawn,
        drawsReserved, prismaticSources, prismaticDraws, availableSources, guardianGems, potionQueue,
        ...publicOffer
      } = offer
      return { ...publicOffer, choices: null, potionQueue: potionQueue?.map(() => null) }
    }),
    roomState,
    courier: structuredClone(run.courier),
    campaign: {
      runId: run.campaign.runId,
      bossesDefeated: run.campaign.bossesDefeated,
      highestBossActDefeated: run.campaign.highestBossActDefeated,
      ...(run.campaign.bossCoins ? { bossCoins: structuredClone(run.campaign.bossCoins) } : {}),
      // A Catch Up joiner is owed only the bosses beaten after their hero arrived.
      ...(viewerCharacter && run.campaign.joinedAfterBosses?.[viewerCharacter]
        ? { joinedAfterBosses: { [viewerCharacter]: run.campaign.joinedAfterBosses[viewerCharacter] } } : {}),
      keys: structuredClone(run.campaign.keys),
      finalized: run.campaign.finalized,
    },
  }
}

function redactCombat(combat, viewerId) {
  const progress = combat.startTurnProgress
  const progressOwners = new Map(progress ? startTurnAbilities(combat)
    .map((ability) => [ability.id, ability.playerId]) : [])
  const startChoiceOwner = (choice) => progressOwners.get(choice.id) ?? combat.players.find((player) =>
    choice.id.startsWith(`${player.id}/`) || choice.id.startsWith(`${combat.combatId}/${combat.turn}/${player.id}/`) ||
    choice.id.startsWith(`facing:${player.id}`) || choice.id.startsWith(`guardian:${player.id}/`))?.id
  const redactStartChoice = (choice) => ({
    ...structuredClone(choice),
    exhaustUids: startChoiceOwner(choice) === viewerId
      ? structuredClone(choice.exhaustUids) : undefined,
    trigger: startChoiceOwner(choice) === viewerId
      ? structuredClone(choice.trigger) : undefined,
  })
  const visibleProgressChoices = progress?.choices?.map(redactStartChoice)
  const viewerDieChoice = combat.pendingDieRelicChoices?.some((choice) =>
    choice.playerId === viewerId && dieRelicChoiceNeedsInput(combat, choice))
  const triggerCombat = viewerDieChoice
    ? undefined : prioritizePendingTrigger(combat, (trigger) => trigger.playerId === viewerId)
  const triggerPreview = triggerCombat && pendingTriggerAbility(triggerCombat)
  return {
    combatId: combat.combatId,
    initialEnemyCount: initialEnemySlots(combat),
    turn: combat.turn,
    die: combat.die,
    phase: combat.phase,
    lastStand: combat.lastStand === true,
    potionLimit: combat.potionLimit,
    startTurnStage: combat.startTurnStage,
    powerTriggersUsedThisTurn: combat.powerTriggersUsedThisTurn ?? [],
    pendingTriggers: structuredClone(combat.pendingTriggers ?? []),
    pendingTriggerAbility: triggerPreview?.playerId === viewerId ? structuredClone(triggerPreview) : null,
    // Trigger ids are server allocators, not client state. Masking them also
    // prevents private draw reactions from becoming a count side channel.
    nextTriggerId: 0,
    startTurnProgress: progress ? {
      choices: visibleProgressChoices,
      beforeDraw: progress.beforeDraw ? structuredClone(progress.beforeDraw) : undefined,
      rollPending: progress.rollPending ? structuredClone(progress.rollPending) : undefined,
      discard: progress.discard ? {
        playerId: progress.discard.playerId,
        sourceId: progress.discard.sourceId,
        // Draw reactions can reveal the privately drawn card's type. The
        // authoritative queue stays server-side until the owner discards.
        pendingTriggers: [],
      } : undefined,
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
      card: structuredClone(combat.pendingCardCopy.card),
      energySpent: combat.pendingCardCopy.energySpent,
      resumePhase: combat.pendingCardCopy.resumePhase,
      forcedExhaust: combat.pendingCardCopy.forcedExhaust,
      forcedChoices: combat.pendingCardCopy.forcedChoices?.map(redactStartChoice) ?? null,
      deferredHavocs: structuredClone(combat.pendingCardCopy.deferredHavocs),
      deferredTriggers: structuredClone(combat.pendingCardCopy.deferredTriggers ?? []),
      sourceNames: structuredClone(combat.pendingCardCopy.sourceNames),
      virtualOnly: combat.pendingCardCopy.virtualOnly === true,
      queuedWeaves: combat.pendingCardCopy.playerId === viewerId
        ? structuredClone(combat.pendingCardCopy.queuedWeaves ?? [])
        : [],
    } : undefined,
    pendingDistilled: combat.pendingDistilled ? {
      playerId: combat.pendingDistilled.playerId,
      cards: combat.pendingDistilled.playerId === viewerId
        ? structuredClone(combat.pendingDistilled.cards)
        : null,
    } : undefined,
    pendingHermitSetupLoads: structuredClone(combat.pendingHermitSetupLoads ?? []),
    pendingDieRelicChoices: structuredClone(combat.pendingDieRelicChoices ?? []),
    pendingHermitChamberPlays: (combat.pendingHermitChamberPlays ?? []).map((pending) => ({
      playerId: pending.playerId,
      sourceCardId: pending.sourceCardId,
      free: pending.free,
      cardUids: pending.playerId === viewerId ? structuredClone(pending.cardUids) : [],
      cardCount: pending.cardUids.length,
    })),
    pendingHermitStrengthRewards: structuredClone(combat.pendingHermitStrengthRewards ?? []),
    // Slayer Pack: A window offers private hand cards, so only its owner sees it.
    ...(combat.pendingCardPlayWindows?.some((window) => window.playerId === viewerId) ? {
      pendingCardPlayWindows: structuredClone(combat.pendingCardPlayWindows
        .filter((window) => window.playerId === viewerId)),
    } : {}),
    // Slayer Pack: public: who owes which choice, never the cards it reveals.
    pendingPlayerChoices: structuredClone(combat.pendingPlayerChoices ?? []),
    // Slayer Pack: the revealed rare reward is its owner's alone.
    ...(combat.pendingSlayerChoices?.length ? {
      pendingSlayerChoices: combat.pendingSlayerChoices.map((choice) => choice.kind === 'ritualDagger'
        ? { ...choice, revealed: choice.playerId === viewerId ? choice.revealed : null }
        : structuredClone(choice)),
    } : {}),
    pendingPlunderSwitches: structuredClone(combat.pendingPlunderSwitches ?? []),
    pendingRelicScry: combat.pendingRelicScry ? {
      id: combat.pendingRelicScry.playerId === viewerId ? combat.pendingRelicScry.id : 0,
      playerId: combat.pendingRelicScry.playerId,
      relicIndex: combat.pendingRelicScry.relicIndex,
      cards: combat.pendingRelicScry.playerId === viewerId
        ? structuredClone(combat.pendingRelicScry.cards)
        : null,
    } : undefined,
    playedCardsThisTurn: structuredClone(combat.playedCardsThisTurn ?? []),
    viewerStanceChangedThisTurn: combat.stanceChangedThisTurn.includes(viewerId),
    presentationEvents: (combat.presentationEvents ?? []).map((event) => ({
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
    // Pending summons are public telegraphed enemy-card effects; the shuffled
    // Summons deck itself remains server-only.
    pendingSummons: structuredClone(combat.pendingSummons ?? []),
    log: combat.log,
    // Enemies carry nothing secret: hit points, tokens and the cube's position
    // are all printed on the card and face up on the table.
    enemies: combat.enemies.map(({ poisonSources, ...enemy }) => enemy),
    players: combat.players.map((player) => redactPlayer(player, viewerId)),
  }
}

/**
 * What one seat may see of a player.
 *
 * An ALLOWLIST, deliberately. The obvious way to write this is to destructure
 * the secrets out and spread the rest — but then every field added to `Player`
 * later is published by default, and the failure is silent. Listing what goes
 * out means a new field is invisible until someone decides it is public, which
 * is the safe direction to fail in.
 */
function redactPlayer(player, viewerId) {
  const mine = player.id === viewerId
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
    damageStats: structuredClone(player.damageStats),
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
    slimes: structuredClone(player.slimes ?? []),
    lootChests: player.lootChests ?? 0,
    dead: player.dead,
    // Face up on the table.
    discard: player.discard,
    exhaust: player.exhaust,
    powers: player.powers,
    relics: mine ? player.relics : player.relics.map(({
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
    tradableDeckCount: player.deck.filter((card) => card.defId !== 'ascenders_bane').length,
    // Face-down reward stacks, secret even from their owner until drawn.
    cardRewardCount: player.cardRewards.length,
    rareRewardCount: player.rareRewards.length,
    // Yours alone. Hands are ordered; draw piles are sorted only to erase the
    // authoritative top-to-bottom order before they reach the client.
    hand: mine ? player.hand : null,
    draw: mine ? [...player.draw].sort((left, right) =>
      left.defId.localeCompare(right.defId) || left.uid.localeCompare(right.uid)) : null,
    chamber: mine ? player.chamber ?? [] : null,
    deck: mine ? player.deck : null,
  }
}
