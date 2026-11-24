// Non-combat room and run actions: Neow, give-up vote, merchant/courier,
// rewards, events, campfire, quick setup, campaign, and return-to-lobby.

import { ascensionBossQualifies, MAX_ASCENSION } from '../../../src/game/campaign.ts'
import {
  advanceQuickSetup,
  allocateSharedMarks,
  canGiveUpRun,
  canSkipEvent,
  canUpgradeCard,
  chooseEvent,
  chooseNeow,
  chooseRelicReward,
  courierCost,
  currentRoom,
  decideCourier,
  finishCampaign,
  finishMerchant,
  finishRun,
  giveUpRun,
  merchantPurchaseCost,
  merchantRemovalCost,
  neowPreview,
  purchaseAtMerchant,
  removeAtCurrentMerchant,
  resolveCampfire,
  resolveCardRewards,
  resolveNeowEffect,
  resolveNeowReward,
  resolveRelicReward,
  resolveTransformReward,
  revealCardReward,
  revealCourier,
  revealNeowReward,
  skipEvent,
} from '../../../src/game/state.ts'
import { campfireNeedsDecision, campfireTransformAvailable } from '../../../src/game/run/campfire.ts'
import { cardIsCurse } from '../../../src/game/cards.ts'
import {
  activeGiveUpVote,
  clearEndTurnOrdering,
  fail,
  GIVE_UP_TIMEOUT_MS,
  includeSeatUnlocks,
  MAX_RECORDED_RUNS,
  recordedRunOf,
} from './shared.mjs'
import { clearStartTurnPlan } from './start-turn-plan.mjs'
import { snapshotFor } from './snapshot.mjs'
import { settleDisconnectedRewards, settlePendingRelics, settleReward } from './settlement.mjs'

function neowRewardChoice(action) {
  const choice = action.choice
  if (choice === null || Number.isInteger(choice)) return choice
  if (!choice || typeof choice !== 'object' || Array.isArray(choice)) fail('Choose a valid Neow reward')
  if (choice.kind === 'gain' || choice.kind === 'skip') {
    if (Object.keys(choice).some((key) => key !== 'kind')) fail('Choose a valid Neow reward')
    return { kind: choice.kind }
  }
  if (choice.kind === 'pass' && typeof choice.playerId === 'string' &&
    Object.keys(choice).every((key) => key === 'kind' || key === 'playerId')) {
    return { kind: 'pass', playerId: choice.playerId }
  }
  if (choice.kind === 'replace' && typeof choice.potionId === 'string' &&
    Object.keys(choice).every((key) => key === 'kind' || key === 'potionId')) {
    return { kind: 'replace', potionId: choice.potionId }
  }
  fail('Choose a valid Neow reward')
}

function finishGiveUp(room) {
  room.run = giveUpRun(room.run)
  room.giveUpVote = undefined
  room.courierPledge = undefined
  room.cardPreviews = undefined
  room.powerPreviews = undefined
  room.concurrentCardCopies = undefined
  room.concurrentDistilled = undefined
  room.concurrentRelicScries = undefined
  room.concurrentForcedCards = undefined
  room.endTurnReady = undefined
  room.campfireChoices = undefined
  room.rewardChoices = undefined
  room.rewardConfirmed = undefined
  room.merchantPledges = undefined
  room.merchantReady = undefined
  room.eventPledge = undefined
  room.seats = room.seats.filter((seat) => !seat.pendingCatchUp)
  clearEndTurnOrdering(room)
  clearStartTurnPlan(room)
}

export function applyGiveUpVote(room, seat, action, seatToken) {
  const run = room.run
  if (!run || !canGiveUpRun(run, run.campaignProgress)) {
    fail('There is no active run to give up')
  }
  const eligiblePlayerIds = run.players.map((player) => player.id)
  if (!eligiblePlayerIds.includes(seat.playerId)) fail('Only active run players can vote to give up')
  const current = activeGiveUpVote(room)
  if (action.vote === 'start') {
    if (Object.keys(action).some((key) => key !== 'kind' && key !== 'vote')) fail('Invalid give-up vote')
    if (current) return { changed: false, snapshot: snapshotFor(room, seatToken) }
    if (eligiblePlayerIds.length === 1) {
      finishGiveUp(room)
    } else {
      room.giveUpVote = {
        runId: run.campaign.runId,
        deadlineAt: Date.now() + GIVE_UP_TIMEOUT_MS,
        eligiblePlayerIds,
        votes: {},
      }
    }
  } else {
    if ((action.vote !== 'yes' && action.vote !== 'no') ||
      Object.keys(action).some((key) => !['kind', 'vote', 'deadlineAt'].includes(key)) ||
      !Number.isSafeInteger(action.deadlineAt) || current?.deadlineAt !== action.deadlineAt) {
      fail('That give-up vote has expired')
    }
    const votes = { ...current.votes, [seat.playerId]: action.vote === 'yes' }
    if (eligiblePlayerIds.every((playerId) => votes[playerId] === true)) {
      finishGiveUp(room)
    } else room.giveUpVote = { ...current, eligiblePlayerIds, votes }
  }
  room.version += 1
  return { changed: true, snapshot: snapshotFor(room, seatToken) }
}

/** One authenticated action covers Neow's red reward, blue option, and queued rewards. */
export function neowAction(room, seat, action, seatToken) {
  if (action.playerId !== undefined) fail('Neow choices are bound to your seat')
  const preview = neowPreview(room.run, seat.playerId)
  if (!preview || preview.done) fail('This seat has no pending Neow choice')
  let next
  if (action.stage === 'reveal') {
    const sources = action.sources
    if (Object.keys(action).some((key) => !['kind', 'stage', 'sources'].includes(key)) || sources !== undefined && (
      !Array.isArray(sources) || sources.length !== 3 || new Set(sources).size !== sources.length ||
      sources.some((source) => typeof source !== 'string' || !preview.availableSources.includes(source))
    )) fail('Choose a valid Neow reveal')
    if (!preview.redRewardPending && !preview.rewardKind) fail('No Neow reward is waiting to be revealed')
    next = revealNeowReward(room.run, seat.playerId, sources)
  } else if (action.stage === 'red') {
    if (!preview.redRewardPending) fail('The red Neow reward is no longer pending')
    next = resolveNeowReward(room.run, seat.playerId, neowRewardChoice(action))
  } else if (action.stage === 'option') {
    if (preview.redRewardPending || preview.blueOption !== null || preview.pendingEffect || preview.rewardKind) fail('The blue Neow option is not pending')
    if (!Number.isInteger(action.optionIndex) || action.cardUids !== undefined &&
      (!Array.isArray(action.cardUids) || action.cardUids.some((uid) => typeof uid !== 'string'))) {
      fail('Choose a valid Neow option')
    }
    next = chooseNeow(room.run, seat.playerId, action.optionIndex, { cardUids: action.cardUids ?? [] })
  } else if (action.stage === 'effect') {
    if (!preview.pendingEffect || typeof action.gain !== 'boolean' || action.cardUids !== undefined &&
      (!Array.isArray(action.cardUids) || action.cardUids.some((uid) => typeof uid !== 'string')) ||
      Object.keys(action).some((key) => !['kind', 'stage', 'gain', 'cardUids'].includes(key))) fail('Choose a valid Neow immediate reward')
    next = resolveNeowEffect(room.run, seat.playerId, action.gain, { cardUids: action.cardUids ?? [] })
  } else if (action.stage === 'reward') {
    if (!preview.rewardKind) fail('No blue Neow reward is pending')
    next = resolveNeowReward(room.run, seat.playerId, neowRewardChoice(action))
  } else fail('Choose the current Neow stage')
  if (next === room.run) fail('That Neow choice is not legal')
  if (next.phase !== 'neow') room.seats = room.seats.filter((candidate) => !candidate.pendingCatchUp)
  room.run = next
  room.version += 1
  return { changed: true, snapshot: snapshotFor(room, seatToken) }
}

function purchaseKey(purchase) {
  return `${purchase?.buyerId ?? ''}/${purchase?.section ?? ''}/${purchase?.slot ?? ''}`
}

function pledgedGold(room, playerId, exceptKey) {
  return Object.entries(room.merchantPledges ?? {}).reduce((sum, [key, pledge]) =>
    key === exceptKey ? sum : sum + (pledge.payments?.[playerId] ?? 0), 0)
}

function merchantPlayers(run) {
  return run.setup?.kind === 'catch-up'
    ? run.players.filter((player) => run.setup.playerIds.includes(player.id))
    : run.players
}

function resetMerchantReady(room, playerId) {
  if (!room.merchantReady?.includes(playerId)) return false
  room.merchantReady = room.merchantReady.filter((id) => id !== playerId)
  if (room.merchantReady.length === 0) room.merchantReady = undefined
  return true
}

export function cancelImpossibleDisconnectedPledges(room, merchantOnly = false) {
  const connected = new Set(room.seats.filter((seat) => seat.connected !== false).map((seat) => seat.playerId))
  const available = (players, payments, reserved = () => 0) =>
    Object.entries(payments ?? {}).reduce((sum, [id, amount]) => connected.has(id) ? sum : sum + amount, 0) +
    players.filter((player) => connected.has(player.id) && !player.dead).reduce((sum, player) => sum + Math.max(0, player.gold - reserved(player.id)), 0)

  const offer = room.run?.courier?.offer
  if (!merchantOnly && offer && !connected.has(offer.playerId)) {
    const cost = courierCost(offer)
    if (!room.courierPledge || cost === null || available(room.run.combat?.players ?? [], room.courierPledge.payments) < cost) {
      const next = decideCourier(room.run, offer.playerId, 'discard')
      if (next !== room.run) room.run = next
      room.courierPledge = undefined
    }
  }

  for (const [key, pledge] of Object.entries(room.merchantPledges ?? {})) {
    if (connected.has(pledge.buyerId)) continue
    const cost = pledge.kind === 'removal'
      ? merchantRemovalCost(room.run.ascension)
      : merchantPurchaseCost(room.run.roomState, pledge)
    if (cost === null || available(merchantPlayers(room.run), pledge.payments, (id) => pledgedGold(room, id, key)) < cost) {
      delete room.merchantPledges[key]
    }
  }

  if (merchantOnly) return

  const event = room.eventPledge
  if (event && !connected.has(event.actorId) && available(room.run.players, event.payments) < event.cost) {
    room.eventPledge = undefined
  }
}

/** Each token pledges only its own gold; the purchase settles atomically at exact cost. */
export function merchantPurchase(room, seat, action, seatToken) {
  const run = room.run
  if (run.phase !== 'room' || run.roomState?.kind !== 'merchant') fail('The party is not at a Merchant')
  const purchase = action.purchase
  const eligible = merchantPlayers(run)
  if (!eligible.some((player) => player.id === seat.playerId)) fail('Only Catch Up players visit this Merchant')
  if (!purchase || typeof purchase.buyerId !== 'string' || !eligible.some((player) => player.id === purchase.buyerId) ||
    !['relic', 'potion', 'card', 'colorless'].includes(purchase.section) || !Number.isInteger(purchase.slot) || purchase.slot < 0) {
    fail('Choose a valid Merchant offer and seated buyer')
  }
  const amount = purchase.payments?.[seat.playerId]
  if (!Number.isInteger(amount) || amount < 0 || Object.keys(purchase.payments ?? {}).some((id) => id !== seat.playerId)) {
    fail('You may pledge only your own Gold')
  }
  const payer = eligible.find((player) => player.id === seat.playerId)
  const key = purchaseKey(purchase)
  if (!payer || amount + pledgedGold(room, seat.playerId, key) > payer.gold) fail('You do not have that much unpledged Gold')
  const existing = room.merchantPledges?.[key]
  if (!existing && ['relic', 'potion', 'colorless'].includes(purchase.section) && Object.entries(room.merchantPledges ?? {}).some(([otherKey, pledge]) =>
    otherKey !== key && pledge.section === purchase.section && pledge.slot === purchase.slot)) {
    fail('Another buyer is already funding that shared item')
  }
  if (!existing && purchase.buyerId !== seat.playerId) fail('The buyer must authorize the purchase')
  if (purchase.section === 'potion' && purchase.potionRecipientId && purchase.potionRecipientId !== purchase.buyerId) {
    fail('The potion recipient must authorize the purchase as its buyer')
  }
  if (!existing && purchase.discardPotionId && (purchase.potionRecipientId ?? purchase.buyerId) !== seat.playerId) {
    fail('The potion owner must authorize replacing a Potion')
  }
  if (existing && (existing.buyerId !== purchase.buyerId || existing.section !== purchase.section || existing.slot !== purchase.slot)) {
    fail('That purchase changed while it was being funded')
  }
  if (existing && (existing.potionRecipientId !== purchase.potionRecipientId || existing.discardPotionId !== purchase.discardPotionId)) {
    fail('That purchase recipient changed while it was being funded')
  }
  const payments = { ...(existing?.payments ?? {}), [seat.playerId]: amount }
  const total = Object.values(payments).reduce((sum, value) => sum + value, 0)
  const available = merchantPurchaseCost(run.roomState, purchase)
  if (available === null) fail('That item is no longer for sale')
  if (total > available) fail(`That purchase needs only ${available} Gold`)
  if (!existing && eligible.reduce((sum, player) => sum + player.gold - pledgedGold(room, player.id, key), 0) < available) fail('The party cannot afford that purchase')
  const pledge = { buyerId: purchase.buyerId, section: purchase.section, slot: purchase.slot, potionRecipientId: purchase.potionRecipientId, discardPotionId: purchase.discardPotionId, payments }
  if (!existing) {
    const probe = structuredClone(run)
    probe.players.find((player) => player.id === purchase.buyerId).gold = available
    if (purchaseAtMerchant(probe, { ...pledge, payments: { [purchase.buyerId]: available } }) === probe) fail('That purchase cannot be completed')
  }
  if (total < available) room.merchantPledges = { ...room.merchantPledges, [key]: pledge }
  else {
    const next = purchaseAtMerchant(run, pledge)
    if (next === run) fail('That purchase cannot be completed')
    room.run = next
    room.merchantPledges = { ...room.merchantPledges }
    delete room.merchantPledges[key]
    settlePendingRelics(room)
  }
  resetMerchantReady(room, seat.playerId)
  room.version += 1
  return { changed: true, snapshot: snapshotFor(room, seatToken) }
}

export function merchantRemove(room, seat, action, seatToken) {
  const run = room.run
  if (run.phase !== 'room' || run.roomState?.kind !== 'merchant') fail('The party is not at a Merchant')
  const eligible = merchantPlayers(run)
  if (!eligible.some((player) => player.id === seat.playerId)) fail('Only Catch Up players visit this Merchant')
  const targetId = action.playerId
  if (!eligible.some((player) => player.id === targetId)) fail('Choose a Catch Up player')
  const amount = action.payments?.[seat.playerId]
  if (!Number.isInteger(amount) || amount < 0 || Object.keys(action.payments ?? {}).some((id) => id !== seat.playerId)) {
    fail('You may pledge only your own Gold')
  }
  const payer = eligible.find((player) => player.id === seat.playerId)
  const key = `remove/${targetId}`
  if (!payer || amount + pledgedGold(room, seat.playerId, key) > payer.gold) fail('You do not have that much unpledged Gold')
  const existing = room.merchantPledges?.[key]
  if (!existing && (seat.playerId !== targetId || typeof action.cardUid !== 'string')) {
    fail('The card owner must choose the card before teammates contribute')
  }
  if (existing?.cardUid && action.cardUid && existing.cardUid !== action.cardUid) fail('That removal is already being funded')
  const payments = { ...(existing?.payments ?? {}), [seat.playerId]: amount }
  const cost = merchantRemovalCost(run.ascension)
  if (Object.values(payments).reduce((sum, value) => sum + value, 0) > cost) fail(`Card removal needs only ${cost} Gold`)
  if (!existing && eligible.reduce((sum, player) => sum + player.gold - pledgedGold(room, player.id, key), 0) < cost) fail('The party cannot afford card removal')
  const pledge = { kind: 'removal', buyerId: targetId, cardUid: existing?.cardUid ?? action.cardUid, payments }
  if (!existing) {
    const probe = structuredClone(run)
    probe.players.find((player) => player.id === targetId).gold = cost
    if (removeAtCurrentMerchant(probe, targetId, pledge.cardUid, { [targetId]: cost }) === probe) fail('That card cannot be removed')
  }
  if (Object.values(payments).reduce((sum, value) => sum + value, 0) < cost) room.merchantPledges = { ...room.merchantPledges, [key]: pledge }
  else {
    const next = removeAtCurrentMerchant(run, targetId, pledge.cardUid, payments)
    if (next === run) fail('That card cannot be removed')
    room.run = next
    room.merchantPledges = { ...room.merchantPledges }
    delete room.merchantPledges[key]
  }
  resetMerchantReady(room, seat.playerId)
  room.version += 1
  return { changed: true, snapshot: snapshotFor(room, seatToken) }
}

export function merchantWithdraw(room, seat, action, seatToken) {
  const pending = typeof action.key === 'string' && Object.hasOwn(room.merchantPledges ?? {}, action.key) ? room.merchantPledges[action.key] : undefined
  if (!pending || !(seat.playerId in pending.payments)) fail('You have no pledge on that purchase')
  const payments = { ...pending.payments }
  delete payments[seat.playerId]
  room.merchantPledges = { ...room.merchantPledges }
  if (Object.keys(payments).length === 0 || pending.buyerId === seat.playerId) delete room.merchantPledges[action.key]
  else room.merchantPledges[action.key] = { ...pending, payments }
  resetMerchantReady(room, seat.playerId)
  room.version += 1
  return { changed: true, snapshot: snapshotFor(room, seatToken) }
}

export function merchantResume(room, seat, seatToken) {
  const run = room.run
  if (run?.phase !== 'room' || run.roomState?.kind !== 'merchant') fail('The party is not at a Merchant')
  if (!merchantPlayers(run).some((player) => player.id === seat.playerId)) fail('Only active players visit this Merchant')
  const changed = resetMerchantReady(room, seat.playerId)
  if (changed) room.version += 1
  return { changed, snapshot: snapshotFor(room, seatToken) }
}

export function merchantFinish(room, seat, seatToken) {
  const run = room.run
  if (run?.phase !== 'room' || run.roomState?.kind !== 'merchant') fail('The party is not at a Merchant')
  const connected = new Set(room.seats.filter((candidate) => candidate.connected !== false).map((candidate) => candidate.playerId))
  const visitors = merchantPlayers(run).map((player) => player.id)
  const eligible = visitors.filter((id) => connected.has(id))
  if (!eligible.includes(seat.playerId)) fail(run.setup?.kind === 'catch-up' ? 'Only Catch Up players visit this Merchant' : 'Only active players visit this Merchant')
  if (Object.keys(room.merchantPledges ?? {}).length > 0) fail('Resolve or cancel pending Merchant contributions first')
  room.merchantReady = [...new Set([...(room.merchantReady ?? []), seat.playerId])].filter((id) => visitors.includes(id))
  settleMerchantReady(room)
  room.version += 1
  return { changed: true, snapshot: snapshotFor(room, seatToken) }
}

export function settleMerchantReady(room) {
  const run = room.run
  if (run?.phase !== 'room' || run.roomState?.kind !== 'merchant' || Object.keys(room.merchantPledges ?? {}).length > 0) return false
  const connected = new Set(room.seats.filter((seat) => seat.connected !== false).map((seat) => seat.playerId))
  const eligible = merchantPlayers(run).map((player) => player.id).filter((id) => connected.has(id))
  if (eligible.length === 0 || !eligible.every((id) => room.merchantReady?.includes(id))) return false
  const next = finishMerchant(run)
  if (next === run) return false
  room.run = next
  room.merchantPledges = undefined
  room.merchantReady = undefined
  return true
}

export function courierReveal(room, seat, action, seatToken) {
  if (action.kind !== 'courierReveal' || (action.itemKind !== 'relic' && action.itemKind !== 'potion')) fail('Choose a Courier deck')
  const next = revealCourier(room.run, seat.playerId, action.itemKind)
  if (next === room.run) fail('The Courier cannot reveal that deck now')
  room.run = next
  room.courierPledge = undefined
  room.version += 1
  return { changed: true, snapshot: snapshotFor(room, seatToken) }
}

export function courierResolve(room, seat, action, seatToken) {
  const offer = room.run?.courier?.offer
  if (!offer) fail('The Courier has no offer')
  if (action.playerId !== undefined && action.playerId !== offer.playerId) fail('That Courier offer belongs to another player')
  if (action.decision === 'discard') {
    if (seat.playerId !== offer.playerId) fail('Only the Courier owner may discard the offer')
    const next = decideCourier(room.run, offer.playerId, 'discard')
    if (next === room.run) fail('That Courier decision is not legal')
    room.run = next
    room.courierPledge = undefined
    room.version += 1
    return { changed: true, snapshot: snapshotFor(room, seatToken) }
  }
  if (action.decision !== 'buy') fail('Choose whether to buy or discard')
  const amount = action.payments?.[seat.playerId]
  if (!Number.isInteger(amount) || amount < 0 || Object.keys(action.payments ?? {}).some((id) => id !== seat.playerId)) fail('You may pledge only your own Gold')
  const payer = room.run.combat?.players.find((player) => player.id === seat.playerId)
  if (!payer || payer.dead || amount > payer.gold) fail('A fallen player cannot fund The Courier')
  const cost = courierCost(offer)
  if (cost === null) fail('That Courier card cannot be bought')
  const pending = room.courierPledge
  if (!pending && seat.playerId !== offer.playerId) fail('The Courier owner must authorize the purchase')
  if (pending && (pending.playerId !== offer.playerId || pending.id !== offer.id || pending.discardPotionId !== action.discardPotionId)) fail('That Courier purchase changed')
  if (!pending && action.discardPotionId && seat.playerId !== offer.playerId) fail('The Potion owner must authorize replacement')
  const payments = { ...(pending?.payments ?? {}), [seat.playerId]: amount }
  const total = Object.values(payments).reduce((sum, paid) => sum + paid, 0)
  if (total > cost) fail(`That Courier offer needs only ${cost} Gold`)
  if (!pending && room.run.combat.players.filter((player) => !player.dead).reduce((sum, player) => sum + player.gold, 0) < cost) fail('The party cannot afford that Courier offer')
  const pledge = { playerId: offer.playerId, id: offer.id, discardPotionId: action.discardPotionId, payments }
  if (!pending) {
    const probe = structuredClone(room.run)
    probe.combat.players.find((player) => player.id === offer.playerId).gold = cost
    if (decideCourier(probe, offer.playerId, 'buy', { [offer.playerId]: cost }, action.discardPotionId) === probe) fail('That Courier purchase is not legal')
  }
  if (total === cost) {
    const next = decideCourier(room.run, offer.playerId, 'buy', payments, action.discardPotionId)
    if (next === room.run) fail('That Courier purchase is not legal')
    room.run = next
    room.courierPledge = undefined
  } else room.courierPledge = pledge
  room.version += 1
  return { changed: true, snapshot: snapshotFor(room, seatToken) }
}

export function relicReward(room, seat, action, seatToken, applyAction) {
  if (room.run?.phase === 'reward' && action.choice !== undefined) {
    if (!['gain', 'skip'].includes(action.choice)) fail('Choose gain or skip for the Relic reward')
    const next = resolveRelicReward(room.run, seat.playerId, action.choice === 'gain')
    if (next === room.run) fail('That Relic reward choice is not legal')
    room.run = next
    settleDisconnectedRewards(room)
    settleReward(room, applyAction)
    room.version += 1
    return { changed: true, snapshot: snapshotFor(room, seatToken) }
  }
  if (action.playerId !== undefined && action.playerId !== seat.playerId) fail('Choose only your own relic')
  const next = chooseRelicReward(room.run, seat.playerId, action.decision)
  if (next === room.run) fail('That relic choice is not legal')
  room.run = next
  settlePendingRelics(room)
  room.version += 1
  return { changed: true, snapshot: snapshotFor(room, seatToken) }
}

export function eventChoice(room, seat, action, seatToken) {
  const actorId = action.playerId ?? seat.playerId
  if (actorId !== seat.playerId && room.eventPledge?.actorId !== actorId) fail('Choose only your own Event option')
  let decision = action.decision
  const stringArray = (value) => value === undefined || (Array.isArray(value) && value.every((entry) => typeof entry === 'string'))
  if (!decision || typeof decision !== 'object' || !Array.isArray(decision.optionIds) || !decision.optionIds.every((id) => typeof id === 'string') ||
    !stringArray(decision.cardUids) || !stringArray(decision.relicIds) || !stringArray(decision.potionIds) || !stringArray(decision.potionRecipientIds) || !stringArray(decision.rewardSources) || !stringArray(decision.guardianGemIds) ||
    (decision.potionReplacementIds !== undefined && (!Array.isArray(decision.potionReplacementIds) || !decision.potionReplacementIds.every((id) => id === null || typeof id === 'string'))) ||
    (decision.rewardItemChoices !== undefined && (!Array.isArray(decision.rewardItemChoices) || !decision.rewardItemChoices.every((choice) => choice === 'take' || choice === 'skip'))) ||
    decision.rewardItemIds !== undefined || decision.rewardItemKinds !== undefined ||
    (decision.rewardIndexes !== undefined && (!Array.isArray(decision.rewardIndexes) || !decision.rewardIndexes.every((index) => Number.isInteger(index) && index >= -1))) ||
    (decision.payments !== undefined && (!decision.payments || typeof decision.payments !== 'object' || Array.isArray(decision.payments) || Object.entries(decision.payments).some(([id, amount]) => typeof id !== 'string' || !Number.isInteger(amount) || amount < 0))) ||
    decision.receiveCardUid !== undefined || decision.receiveRelicId !== undefined ||
    ['targetPlayerId', 'potionRecipientId', 'roomId'].some((field) => decision[field] !== undefined && typeof decision[field] !== 'string')) {
    fail('That Event choice is malformed')
  }
  if (room.eventPledge && (room.eventPledge.actorId !== actorId || room.eventPledge.optionId !== decision.optionIds.join(','))) {
    fail('That Event payment changed')
  }
  const options = room.run.roomState?.kind === 'event'
    ? decision.optionIds.map((id) => room.run.roomState.card.options.find((candidate) => candidate.id === id))
    : []
  const paymentEffects = options.flatMap((option) => option?.effects.filter((effect) => effect.tag === 'pay-gold') ?? [])
  const paysWithItem = paymentEffects.length === 1 && paymentEffects[0]?.filter?.includes('or lose one Relic or Potion') && ((decision.relicIds?.length ?? 0) > 0 || (decision.potionIds?.length ?? 0) > 0)
  if (paysWithItem && seat.playerId !== actorId) fail('Only the Event chooser can offer an item')
  if (room.eventPledge && paysWithItem) fail('That Event payment method is already Gold')
  const cost = paymentEffects.reduce((sum, payment) => sum + (typeof payment.amount === 'number' ? payment.amount : 0), 0)
  const rewardStages = options.some((option) => option?.effects.some((effect) => ['card-reward', 'rare-reward', 'gain-relic', 'gain-potion'].includes(effect.tag)))
  const enginePending = room.run.roomState?.kind === 'event' && room.run.roomState.pendingDecisions?.[actorId]
  const rollPaymentSettled = cost > 0 && enginePending && (room.run.roomState.pendingRolls?.[actorId]?.length ?? 0) > 0
  if (rollPaymentSettled) {
    if (enginePending.optionIds.join(',') !== decision.optionIds.join(',')) fail('That Event choice changed after its die roll')
    decision = { ...enginePending }
  }
  else if (cost > 0 && rewardStages && !enginePending) decision = { ...decision, payments: undefined }
  else if (cost > 0 && !paysWithItem) {
    const amount = decision.payments?.[seat.playerId]
    if (!Number.isInteger(amount) || Object.keys(decision.payments ?? {}).some((id) => id !== seat.playerId)) fail('You may pledge only your own Gold')
    const payer = room.run.players.find((player) => player.id === seat.playerId)
    if (!payer || amount > payer.gold) fail('You do not have that much Gold')
    const pending = room.eventPledge
    if (!pending && actorId !== seat.playerId) fail('The Event chooser must authorize payment')
    const optionId = decision.optionIds.join(',')
    if (pending && (pending.actorId !== actorId || pending.optionId !== optionId)) fail('That Event payment changed')
    const payments = { ...(pending?.payments ?? {}), [seat.playerId]: amount }
    const total = Object.values(payments).reduce((sum, paid) => sum + paid, 0)
    if (total > cost) fail(`That Event needs only ${cost} Gold`)
    if (!pending && room.run.players.reduce((sum, player) => sum + player.gold, 0) < cost) fail('The party cannot afford that Event choice')
    const pledge = { actorId, optionId, cost, decision: pending?.decision ?? { ...decision, payments: undefined }, payments }
    if (total < cost) {
      if (!pending) {
        const probe = structuredClone(room.run)
        probe.players.find((player) => player.id === actorId).gold = Math.max(probe.players.find((player) => player.id === actorId).gold, cost)
        if (chooseEvent(probe, actorId, { ...pledge.decision, payments: { [actorId]: cost } }) === probe) fail('That Event choice is not legal')
      }
      room.eventPledge = pledge
      room.version += 1
      return { changed: true, snapshot: snapshotFor(room, seatToken) }
    }
    decision = { ...pledge.decision, payments }
  }
  const next = chooseEvent(room.run, actorId, decision)
  if (next === room.run) fail('That Event choice is not legal')
  room.run = next
  settlePendingRelics(room)
  room.eventPledge = undefined
  room.version += 1
  return { changed: true, snapshot: snapshotFor(room, seatToken) }
}

export function cancelEventPledge(room, seat, seatToken) {
  if (!room.eventPledge || room.eventPledge.actorId !== seat.playerId) fail('Only the Event chooser can cancel this payment')
  room.eventPledge = undefined
  room.version += 1
  return { changed: true, snapshot: snapshotFor(room, seatToken) }
}

export function eventSkip(room, seat, action, seatToken) {
  if (action.playerId !== undefined && action.playerId !== seat.playerId) fail('Skip only your own unavailable Event choice')
  if (!canSkipEvent(room.run, seat.playerId)) fail('A printed Event choice is available')
  room.run = skipEvent(room.run, seat.playerId)
  room.version += 1
  return { changed: true, snapshot: snapshotFor(room, seatToken) }
}

export function finishCampaignRun(room, seatToken) {
  const next = finishRun(room.run)
  if (next === room.run) fail('This campaign run is not ready to finish')
  const storedBase = room.campaignBaseProgress ?? room.campaignProgress
  const base = { ...storedBase, nextRunNumber: Math.max(storedBase.nextRunNumber, room.run.campaignProgress.nextRunNumber) }
  const borrowedAscension = room.run.ascension > base.highestAscension
  const teamMaxAscension = room.run.campaignProgress.highestAscension
  const campaignProgress = finishCampaign(
    borrowedAscension ? { ...base, highestAscension: room.run.ascension } : base,
    {
      runId: room.run.campaign.runId,
      characters: room.run.players.map((player) => player.character),
      bossesDefeated: room.run.campaign.bossesDefeated,
      joinedAfterBosses: room.run.campaign.joinedAfterBosses,
      startedAtAct: room.run.campaign.startedAtAct,
      highestBossActDefeated: room.run.campaign.highestBossActDefeated,
      ascensionPlayed: room.run.ascension,
    },
  )
  if (ascensionBossQualifies(room.run.players.length, room.run.campaign.highestBossActDefeated)) {
    const earned = Math.min(MAX_ASCENSION, room.run.ascension + 1)
    for (const seat of room.seats) {
      if (room.run.players.some((player) => player.id === seat.playerId)) {
        seat.earnedAscension = Math.max(seat.earnedAscension ?? 0, earned)
      }
    }
  }
  room.campaignBaseProgress = {
    ...campaignProgress,
    highestAscension: room.run.ascension === teamMaxAscension && campaignProgress.highestAscension > room.run.ascension
      ? campaignProgress.highestAscension
      : storedBase.highestAscension,
  }
  room.campaignProgress = room.campaignBaseProgress
  room.run = { ...next, campaignProgress: room.campaignProgress }
  room.version += 1
  return { changed: true, snapshot: snapshotFor(room, seatToken) }
}

export function allocateCampaign(room, seat, action, seatToken) {
  if (!room.run?.campaign.finalized) fail('Finish the campaign run before assigning marks')
  if (room.seats[0]?.playerId !== seat.playerId) fail('The journal keeper assigns shared campaign marks')
  if (action.expectedRunId !== room.run.campaign.runId || !Number.isInteger(action.expectedUnspentMarks) || action.expectedUnspentMarks !== room.campaignProgress.unspentMarks) fail('That campaign allocation is stale')
  if (action.colorless === 0 && action.actIV === 0) fail('Assign at least one campaign mark')
  try {
    room.campaignBaseProgress = allocateSharedMarks(room.campaignBaseProgress ?? room.campaignProgress, action.colorless, action.actIV)
  } catch (error) {
    fail(error instanceof Error ? error.message : 'That campaign allocation is not legal')
  }
  room.campaignProgress = room.campaignBaseProgress
  room.run = { ...room.run, campaignProgress: room.campaignProgress }
  room.version += 1
  return { changed: true, snapshot: snapshotFor(room, seatToken) }
}

export function returnToLobby(room, seat, seatToken) {
  if (!room.run?.campaign.finalized || room.campaignProgress.unspentMarks > 0) fail('Finish assigning campaign marks first')
  if (room.seats[0]?.playerId !== seat.playerId) fail('The journal keeper begins the next run')
  room.phase = 'lobby'
  // Each recorded run's shares are kept beside the earlier ones, so a seat away for
  // several runs still claims them all; the room keeps the last few runs.
  const recorded = recordedRunOf(room)
  if (recorded) room.recordedRuns = [...(room.recordedRuns ?? []).filter((entry) => entry.runId !== recorded.runId), recorded]
    .slice(-MAX_RECORDED_RUNS)
  room.run = null
  includeSeatUnlocks(room)
  room.version += 1
  return { changed: true, snapshot: snapshotFor(room, seatToken) }
}

/**
 * A campfire: everyone chooses, then the party leaves together (p.9).
 *
 * Each seat submits only its OWN choice — passing the whole record through let
 * one client Smith everybody else's cards. But the choices also have to be
 * COLLECTED rather than applied one at a time, because `resolveCampfire` moves
 * the party back to the map: applied immediately, the first seat to click
 * would heal alone and drag everyone out of the room.
 */
export function campfire(room, seat, action, seatToken) {
  const run = room.run
  if (run.phase !== 'room') fail('The party is not in a room')
  // Not merely "a room": a treasure or event room has no Rest or Smith, and
  // accumulating choices there published a campfire prompt for a room that has
  // none, then threw the choices away.
  if (currentRoom(run.map)?.kind !== 'campfire') fail('This room has no campfire')
  if (seat.playerId in (room.campfireChoices ?? {})) fail('This campfire choice is already locked')

  // Validated, not merely present. `resolveCampfire` treats anything that is
  // not exactly 'rest' as a Smith, and a Smith naming no card silently does
  // nothing — so 'Rest' with a capital R quietly burned a seat's only heal.
  const choice = action.choices?.[seat.playerId]
  if (!choice || !['rest', 'smith', 'leave', 'ruby'].includes(choice.choice)) {
    fail('Choose Rest, Smith, Leave, or the Ruby Key')
  }
  if (choice.choice === 'ruby' && (run.campaignProgress.actIV < 5 || run.campaign.keys.ruby)) {
    fail('The Ruby Key is not available')
  }
  const player = run.players.find((candidate) => candidate.id === seat.playerId)
  if (choice.choice === 'rest' && player?.relics.some((relic) => relic.defId === 'coffee_dripper')) {
    fail('Coffee Dripper prevents Resting')
  }
  if (choice.choice === 'rest' && run.meta?.modifierIds?.includes('night_terrors')) fail('Night Terrors prevents Resting')
  if (choice.choice === 'smith' && player?.relics.some((relic) => relic.defId === 'fusion_hammer')) {
    fail('Fusion Hammer prevents Smithing')
  }
  const restAllowed = !run.meta?.modifierIds?.includes('night_terrors')
  if (choice.choice === 'leave' && (!player || campfireNeedsDecision(
    player, false, restAllowed, run.meta?.ruleset,
  ))) fail('Leave only when this player has no Rest or Smith choice')
  if (choice.removeCardUid !== undefined && (
    choice.choice !== 'rest' || !player?.relics.some((relic) => relic.defId === 'peace_pipe') ||
    !player.deck.some((card) => card.uid === choice.removeCardUid && card.defId !== 'ascenders_bane')
  )) fail('Peace Pipe can remove one of your cards only while Resting')
  if (choice.transformCardUid !== undefined && (
    choice.choice !== 'rest' || !player?.relics.some((relic) => relic.defId === 'straight_razor') ||
    choice.transformCardUid === choice.removeCardUid ||
    !player.deck.some((card) => card.uid === choice.transformCardUid && !cardIsCurse(card.defId)) ||
    !campfireTransformAvailable(player)
  )) fail('Straight Razor can Transform one eligible card only while Resting')
  if (choice.choice === 'smith') {
    const target = player?.deck.find((card) => card.uid === choice.cardUid && canUpgradeCard(card))
    if (!target) fail('Choose one of your own cards that is not already upgraded')
  }

  room.campfireChoices = { ...room.campfireChoices, [seat.playerId]: choice }
  room.version += 1

  const waiting = settleCampfire(room)
  if (waiting) {
    return { changed: true, waitingOn: waiting, snapshot: snapshotFor(room, seatToken) }
  }
  return { changed: true, snapshot: snapshotFor(room, seatToken) }
}

/**
 * Resolves the campfire once everyone still present has chosen.
 *
 * Returns the seats still to answer, or null once the party has left. Called
 * both when a choice arrives and when a player drops, because a drop can be
 * the thing that completes the table.
 */
export function settleCampfire(room) {
  const run = room.run
  if (!run || run.phase !== 'room') return null
  if (currentRoom(run.map)?.kind !== 'campfire') return null
  if (!room.campfireChoices) return null
  // With nobody connected there is no table to un-hold: resolving here would
  // apply whatever partial choices happened to be in, and the players who had
  // not answered would reconnect to find their rest spent.
  if (!room.seats.some((seat) => seat.connected)) return null

  const rubyAvailable = run.campaignProgress.actIV >= 5 && !run.campaign.keys.ruby
  const restAllowed = !run.meta?.modifierIds?.includes('night_terrors')
  const undecided = room.seats.filter((other) => {
    const player = run.players.find((candidate) => candidate.id === other.playerId)
    if (!player || !campfireNeedsDecision(player, rubyAvailable, restAllowed, run.meta?.ruleset)) return false
    // Ruby and ordinary Campfire choices are simultaneous physical decisions.
    // A disconnected seat reconnects to its pending choice; it is never an
    // implicit skip or abstention.
    return !room.campfireChoices[other.playerId]
  })
  if (undecided.length > 0) return undecided.map((other) => other.playerId)

  const next = resolveCampfire(run, room.campfireChoices)
  if (next !== run) {
    room.campfireChoices = undefined
    room.run = next
    room.version += 1
  }
  return null
}

export function cardReward(room, seat, action, seatToken) {
  const run = room.run
  if (run.phase !== 'reward') fail('The party is not choosing rewards')
  const offer = run.rewards.find((candidate) => candidate.playerId === seat.playerId && candidate.cardReward)
  if (!offer) fail('This seat has no card reward')
  const choice = action.choice
  if (choice === 'reveal') {
    const sources = Array.isArray(action.sources) && action.sources.length <= 3
      ? action.sources.filter((source) => typeof source === 'string') : []
    const next = revealCardReward(run, seat.playerId, sources)
    if (next === run) fail('This reward is already revealed')
    room.run = next
    settleDisconnectedRewards(room)
    room.version += 1
    return { changed: true, snapshot: snapshotFor(room, seatToken) }
  }
  if (choice !== null && (
    offer.choices === null || !Number.isInteger(choice) || choice < 0 || choice >= offer.choices.length
  )) {
    fail('Choose one of your revealed cards or skip')
  }
  const next = resolveCardRewards(run, { [seat.playerId]: choice })
  if (next === run) fail('That card reward choice is no longer legal')
  room.run = next
  settleDisconnectedRewards(room)
  room.version += 1
  return { changed: true, snapshot: snapshotFor(room, seatToken) }
}

export function transformReward(room, seat, action, seatToken, applyAction) {
  const run = room.run
  if (run.phase !== 'reward') fail('The party is not choosing rewards')
  if (!run.rewards.some((offer) => offer.playerId === seat.playerId && offer.transformReward)) {
    fail('This seat has no Transform reward')
  }
  if (action.cardUid !== null && typeof action.cardUid !== 'string') fail('Choose one card to Transform or skip')
  const next = resolveTransformReward(run, seat.playerId, action.cardUid)
  if (next === run) fail('That card cannot be Transformed')
  room.run = next
  settlePendingRelics(room)
  settleDisconnectedRewards(room)
  settleReward(room, applyAction)
  room.version += 1
  return { changed: true, snapshot: snapshotFor(room, seatToken) }
}

export function quickSetupStep(room, seat, action, seatToken) {
  const setup = room.run?.setup
  if (room.run?.phase !== 'setup' || !setup) fail('The party is not resolving Quick Start')
  const activePlayerId = setup.playerIds[setup.playerIndex] ?? setup.playerIds[0]
  if (seat.playerId !== activePlayerId) fail('Only the active setup player may resolve this step')
  const cardUids = Array.isArray(action.cardUids) && action.cardUids.length <= 1
    ? action.cardUids.filter((uid) => typeof uid === 'string') : []
  const next = advanceQuickSetup(room.run, cardUids)
  if (next === room.run) fail('That Quick Start choice is not legal')
  room.run = next
  room.version += 1
  return { changed: true, snapshot: snapshotFor(room, seatToken) }
}
