// Event rooms: the deck, the offer a card puts up, and what taking it does.
//
// `chooseEventInternal` is long and stays that way on purpose. Half of it
// is validating a decision that arrives from a client and may be anything at
// all; the rest walks the chosen option's printed effects, with the handful of
// cards whose text does not fit the shared effect vocabulary — the Lab, Knowing
// Skull, the trades — handled by name where they occur. Lifting those out would
// scatter one card's rules across two files without making either shorter.
import { BOSSES, buildEncounter, createEnemyDecks, readyForCombat } from './encounters.ts'
import { availableRewardSources, reservePrismaticDraws, settlePrismaticDraws } from './rewards.ts'
import { enterRoom } from './rooms.ts'
import { applyDeadlyEvent, hasRelic, nextRunUid } from './rules.ts'
import { merchantItemDecks, mirrorItemSupplies } from './supplies.ts'
import type { CardRewardEffect, RunState } from './types.ts'
import {
  addCard,
  bottomCardChoices,
  drawCardChoices,
  drawItems,
  gainPotion,
  potionLimit,
  upgradeCard,
} from '../acquisition.ts'
import type { ItemDecks } from '../acquisition.ts'
import { CARDS } from '../cards.ts'
import { createCombat, resumePlayerTurnAfterDraw, startPlayerTurnWithChoices } from '../combat.ts'
import { applyEventCombatStartEffects, resolveEventBeforeRoll, resolveEventDecision } from '../event-room.ts'
import type { EventDecision } from '../event-room.ts'
import type { EventCard } from '../events.ts'
import { currentRoom } from '../map.ts'
import { createMerchant } from '../noncombat.ts'
import { bottomGuardianGems, cardHasGuardianSocket, queueNewGuardianSockets, resolveGuardianSocket, revealGuardianDraftGems } from './guardian-gems.ts'
import { nextInt } from '../rng.ts'
import type { CharacterId, Player } from '../types.ts'
import { DOWNFALL_BOSSES } from '../downfall/enemies.ts'

function stageEventDecision(decision: EventDecision): EventDecision {
  const staged = { ...decision }
  delete staged.rewardIndexes
  delete staged.rewardItemChoices
  delete staged.rewardItemIds
  delete staged.rewardItemKinds
  delete staged.guardianGemIds
  delete staged.potionRecipientId
  delete staged.potionRecipientIds
  delete staged.potionReplacementIds
  return staged
}

function nextEventCardOffer(
  state: RunState,
  playerId: string,
  targetPlayerId: string | undefined,
  effects: readonly CardRewardEffect[],
  indexes: readonly number[],
  replaceDuplicates: boolean,
): { offer?: string[]; valid: boolean } {
  const players = state.players.map((player) => ({ ...player, cardRewards: [...player.cardRewards], rareRewards: [...player.rareRewards] }))
  const characterCards = structuredClone(state.itemDecks.characterCards)
  const characterRares = structuredClone(state.itemDecks.characterRares)
  let colorless = [...state.itemDecks.colorless]
  let used = 0
  for (const effect of effects) {
    const source = effect.source === 'other-character'
      ? players.find((candidate) => candidate.id === targetPlayerId && candidate.id !== playerId)
      : players.find((candidate) => candidate.id === playerId)
    let inactiveCards = effect.source === 'other-character' ? characterCards[targetPlayerId as CharacterId] : undefined
    let inactiveRares = effect.source === 'other-character' ? characterRares[targetPlayerId as CharacterId] : undefined
    if (!source && !inactiveCards) return { valid: false }
    for (let count = 0; count < (effect.count ?? 1); count++) {
      const reveal = effect.filter === 'reveal 5' ? 5 : 3
      if (effect.tag === 'card-reward' && effect.source !== 'rare' && effect.source !== 'colorless') {
        const holder = inactiveCards
          ? { ...players.find((candidate) => candidate.id === playerId)!, cardRewards: inactiveCards, rareRewards: inactiveRares ?? [] }
          : source!
        const draw = drawCardChoices(holder, reveal, replaceDuplicates)
        if (draw.choices.length === 0) continue
        const choice = indexes[used]
        if (choice === undefined) return { offer: draw.choices, valid: true }
        if (choice !== -1 && !draw.choices[choice]) return { valid: false }
        used++
        const bottomed = bottomCardChoices(holder, draw, choice === -1 ? null : choice)
        if (inactiveCards) {
          inactiveCards = bottomed.cardRewards
          inactiveRares = bottomed.rareRewards
          characterCards[targetPlayerId as CharacterId] = inactiveCards
          characterRares[targetPlayerId as CharacterId] = inactiveRares
        } else Object.assign(source!, { cardRewards: bottomed.cardRewards, rareRewards: bottomed.rareRewards })
        continue
      }
      const deck = effect.source === 'colorless' ? colorless : source!.rareRewards
      const choices = deck.slice(0, reveal)
      if (choices.length === 0) continue
      const choice = indexes[used]
      if (choice === undefined) return { offer: choices, valid: true }
      if (choice !== -1 && !choices[choice]) return { valid: false }
      used++
      deck.splice(0, choices.length)
      deck.push(...(choice === -1 ? choices : choices.filter((_id, index) => index !== choice)))
      if (effect.source === 'colorless') colorless = deck
    }
  }
  return { valid: used === indexes.length }
}

export function chooseEvent(state: RunState, playerId: string, decision: EventDecision): RunState {
  const next = chooseEventInternal(state, playerId, decision, false)
  if (next === state) return state
  const resolved = mirrorItemSupplies(applyDeadlyEvent(state, next), next.itemDecks)
  return resolved.roomState?.kind === 'event' ? {
    ...resolved,
    roomState: { ...resolved.roomState, availableRewardSources: {
      card: availableRewardSources(resolved, false),
      rare: availableRewardSources(resolved, true),
    } },
  } : resolved
}

function chooseEventInternal(state: RunState, playerId: string, decision: EventDecision, acceptedTrade: boolean): RunState {
  if (state.phase !== 'room' || state.roomState?.kind !== 'event') return state
  if (state.roomState.preparedCombat &&
    !state.roomState.preparedCombat.startTurnProgress?.pauseAfterDraw) return state
  const player = state.players.find((candidate) => candidate.id === playerId && !candidate.dead)
  if (!player || !decision || !Array.isArray(decision.optionIds)) return state
  if (!acceptedTrade && (decision.rewardItemIds !== undefined || decision.rewardItemKinds !== undefined)) return state
  if (decision.rewardItemChoices !== undefined && (!Array.isArray(decision.rewardItemChoices) || decision.rewardItemChoices.some((choice) => choice !== 'take' && choice !== 'skip'))) return state
  if (decision.rewardIndexes !== undefined && (!Array.isArray(decision.rewardIndexes) || decision.rewardIndexes.some((choice) => !Number.isInteger(choice) || choice < -1))) return state
  const optionCount = decision.optionIds.length
  if (state.roomState.card.id === 'knowing_skull'
    ? optionCount < 1 || optionCount > 2 || new Set(decision.optionIds).size !== optionCount
    : optionCount !== 1) return state
  const potionRecipients = decision.potionRecipientIds ?? (decision.potionRecipientId ? [decision.potionRecipientId] : [])
  if (potionRecipients.some((id) => id !== '' && !state.players.some((candidate) => candidate.id === id && !candidate.dead && candidate.id !== playerId && !hasRelic(candidate, 'sozu') && candidate.potions.length < potionLimit(state.ascension, candidate)))) return state
  if (Object.entries(Object.fromEntries([...new Set(potionRecipients.filter(Boolean))].map((id) => [id, potionRecipients.filter((candidate) => candidate === id).length]))).some(([id, count]) => {
    const recipient = state.players.find((candidate) => candidate.id === id)
    const limit = potionLimit(state.ascension, recipient)
    return (count as number) > limit - (recipient?.potions.length ?? limit)
  })) return state
  if (state.roomState.card.id === 'lab' && !state.roomState.pendingRolls?.[playerId]) {
    if (decision.optionIds[0] !== 'resolve' || state.roomState.labChoices?.[playerId]) return state
    const revealed = state.roomState.itemOffers?.[playerId]
    const itemDecks = structuredClone(state.itemDecks)
    if (!revealed) {
      const potionId = drawItems(itemDecks.potions, 1)[0]
      if (!potionId) {
        const labChoices = { ...state.roomState.labChoices, [playerId]: decision }
        if (!state.players.filter((candidate) => !candidate.dead).every((candidate) => labChoices[candidate.id])) {
          return { ...state, roomState: { ...state.roomState, labChoices } }
        }
        const rng = { ...state.rng }
        const roll = 1 + nextInt(rng, 6)
        return { ...state, rng, roomState: {
          ...state.roomState,
          labChoices,
          pendingDecisions: { [playerId]: decision },
          pendingRolls: { [playerId]: [roll] },
          dieRolls: { ...state.roomState.dieRolls, [playerId]: [roll] },
        } }
      }
      return {
        ...state,
        itemDecks,
        roomState: {
          ...state.roomState,
          itemOffers: { ...state.roomState.itemOffers, [playerId]: [{ kind: 'potion', id: potionId }] },
          pendingDecisions: { ...state.roomState.pendingDecisions, [playerId]: stageEventDecision(decision) },
        },
      }
    }
    if (revealed.length !== 1 || revealed[0]?.kind !== 'potion' || decision.rewardItemChoices?.length !== 1) return state
    const pending = state.roomState.pendingDecisions?.[playerId]
    if (!pending || pending.optionIds.join(',') !== decision.optionIds.join(',')) return state
    const rng = { ...state.rng }
    const potionId = revealed[0].id
    let changed = player
    let players = state.players
    if (decision.rewardItemChoices[0] === 'skip') itemDecks.potions.push(potionId)
    else {
      const recipientId = decision.potionRecipientIds?.[0] ?? decision.potionRecipientId
      const recipientIndex = state.players.findIndex((candidate) => candidate.id === recipientId && candidate.id !== playerId && !candidate.dead && !hasRelic(candidate, 'sozu') && candidate.potions.length < potionLimit(state.ascension, candidate))
      if (recipientIndex >= 0) {
        const recipient = gainPotion(state.players[recipientIndex]!, potionId, state.ascension)
        if (recipient === state.players[recipientIndex]) itemDecks.potions.push(potionId)
        else players = state.players.map((candidate, index) => index === recipientIndex ? recipient : candidate)
      } else if (hasRelic(changed, 'sozu')) {
        itemDecks.potions.push(potionId)
      } else if (changed.potions.length >= potionLimit(state.ascension, changed)) {
        const discardId = decision.potionReplacementIds?.[0]
        const at = discardId ? changed.potions.indexOf(discardId) : -1
        if (at >= 0) {
          changed = { ...changed, potions: changed.potions.filter((_id, index) => index !== at) }
          itemDecks.potions.push(discardId!)
        } else return state
      }
      if (recipientIndex < 0 && !hasRelic(changed, 'sozu') && changed.potions.length < potionLimit(state.ascension, changed)) {
        const gained = gainPotion(changed, potionId, state.ascension)
        if (gained === changed) itemDecks.potions.push(potionId)
        else changed = gained
      }
    }
    players = players.map((candidate) => candidate.id === playerId ? changed : candidate)
    const labChoices = { ...state.roomState.labChoices, [playerId]: decision }
    const cleanRoom = {
      ...state.roomState,
      itemOffers: Object.fromEntries(Object.entries(state.roomState.itemOffers ?? {}).filter(([id]) => id !== playerId)),
      pendingDecisions: Object.fromEntries(Object.entries(state.roomState.pendingDecisions ?? {}).filter(([id]) => id !== playerId)),
    }
    if (!players.filter((candidate) => !candidate.dead).every((candidate) => labChoices[candidate.id])) {
      return { ...state, rng, itemDecks, players, roomState: { ...cleanRoom, labChoices } }
    }
    const roll = 1 + nextInt(rng, 6)
    return { ...state, rng, itemDecks, players, roomState: {
      ...cleanRoom,
      labChoices,
      pendingDecisions: { [playerId]: decision },
      pendingRolls: { [playerId]: [roll] },
      dieRolls: { ...state.roomState.dieRolls, [playerId]: [roll] },
    } }
  }
  const stagedDecision = state.roomState.pendingDecisions?.[playerId]
  if (stagedDecision && stagedDecision.optionIds.join(',') !== decision.optionIds.join(',') && !(state.roomState.card.id === 'scrap_ooze' && decision.optionIds[0] === 'leave')) return state
  const pendingTrade = state.roomState.pendingTrade
  if (pendingTrade) {
    if (pendingTrade.targetId !== playerId) return state
    if (decision.optionIds[0] === 'reject_trade') return {
      ...state,
      roomState: { ...state.roomState, pendingTrade: undefined },
    }
    if (decision.optionIds[0] !== 'accept_trade') return state
    const completed = pendingTrade.kind === 'card'
      ? { ...pendingTrade.decision, receiveCardUid: decision.cardUids?.[0] }
      : { ...pendingTrade.decision, receiveRelicId: decision.relicIds?.[0] }
    if (pendingTrade.kind === 'card' && !player.deck.some((card) => card.uid === completed.receiveCardUid)) return state
    if (pendingTrade.kind === 'card' && player.deck.find((card) => card.uid === completed.receiveCardUid)?.defId === 'ascenders_bane') return state
    if (pendingTrade.kind === 'relic' && !player.relics.some((relic) => relic.defId === completed.receiveRelicId)) return state
    return chooseEventInternal({ ...state, roomState: { ...state.roomState, pendingTrade: undefined } }, pendingTrade.actorId, completed, true)
  }
  if (!acceptedTrade && (decision.receiveCardUid !== undefined || decision.receiveRelicId !== undefined)) return state
  const options = decision.optionIds.map((id) => state.roomState?.kind === 'event' ? state.roomState.card.options.find((option) => option.id === id) : undefined)
  if (options.some((option) => !option)) return state
  if (!stagedDecision && options.some((option) => !eventOptionAvailable(state, player, option!))) return state
  if (state.roomState.card.id === 'big_fish') {
    const used = new Set([
      ...Object.entries(state.roomState.decisions),
      ...Object.entries(state.roomState.pendingDecisions ?? {}),
    ].filter(([id]) => id !== playerId).map(([, choice]) => choice.optionIds[0]))
    if (decision.optionIds.some((id) => used.has(id))) return state
  }
  const optionEffects = options.flatMap((option) => option!.effects)
  if (optionEffects.some((effect) => effect.source === 'other-character')) {
    const target = decision.targetPlayerId
    const active = state.players.find((candidate) => candidate.id === target && candidate.id !== playerId && !candidate.dead)
    const inactive = typeof target === 'string' && Object.hasOwn(state.itemDecks.characterCards, target) && Array.isArray(state.itemDecks.characterCards[target as CharacterId])
    if (!active && !inactive) return state
    const source = active?.character ?? target as CharacterId
    if (!availableRewardSources(state, false).includes(source)) return state
  }
  const paymentDue = optionEffects.reduce((sum, effect) => sum + (effect.tag === 'pay-gold' && typeof effect.amount === 'number' ? effect.amount : 0), 0)
  const paysWithItem = optionEffects.some((effect) => effect.tag === 'pay-gold' && effect.filter?.includes('or lose one Relic or Potion')) && ((decision.relicIds?.length ?? 0) > 0 || (decision.potionIds?.length ?? 0) > 0)
  if (!stagedDecision && paymentDue > 0 && !paysWithItem && state.players.filter((candidate) => !candidate.dead).reduce((sum, candidate) => sum + candidate.gold, 0) < paymentDue) return state
  if (!stagedDecision && state.roomState.card.id === 'we_meet_again') {
    if (decision.optionIds[0] === 'exchange' && (decision.relicIds?.length !== 1 || !player.relics.some((relic) => relic.defId === decision.relicIds?.[0]))) return state
    if (decision.optionIds[0] === 'give_card') {
      const card = decision.cardUids?.length === 1 ? player.deck.find((candidate) => candidate.uid === decision.cardUids?.[0]) : undefined
      if (!card || card.defId === 'ascenders_bane' || !['rare', 'uncommon'].includes(CARDS[card.defId]?.rarity ?? '')) return state
    }
  }
  if (!stagedDecision && state.roomState.card.id === 'nloth') {
    if (decision.optionIds[0] === 'offer_relic' && player.relics.length === 0) return state
    if (decision.optionIds[0] === 'offer_potion' && (decision.potionIds?.length !== 1 || !player.potions.includes(decision.potionIds[0]!))) return state
  }
  const otherPending = Object.entries(state.roomState.pendingDecisions ?? {}).filter(([id]) => id !== playerId)
  const stagesReward = optionEffects.some((effect) => ['card-reward', 'rare-reward', 'gain-relic', 'gain-potion'].includes(effect.tag))
  if (!stagedDecision && paymentDue > 0 && stagesReward && otherPending.length > 0) return state
  if (state.roomState.card.scope === 'party' && otherPending.length > 0) return state
  if (state.roomState.card.id === 'ancient_temple' && otherPending.length > 0) return state
  const tradeEffect = options.flatMap((option) => option!.effects).find((effect) => effect.tag === 'trade-card' || effect.tag === 'trade-relic')
  if (tradeEffect && !acceptedTrade) {
    const possible = tradeEffect.tag === 'trade-card'
      ? player.deck.some((card) => card.defId !== 'ascenders_bane') && state.players.some((candidate) => candidate.id !== playerId && !candidate.dead && candidate.deck.some((card) => card.defId !== 'ascenders_bane'))
      : player.relics.length > 0 && state.players.some((candidate) => candidate.id !== playerId && !candidate.dead && candidate.relics.length > 0)
    const target = state.players.find((candidate) => candidate.id === decision.targetPlayerId && candidate.id !== playerId && !candidate.dead)
    const offered = tradeEffect.tag === 'trade-card'
      ? decision.cardUids?.length === 1 && player.deck.find((card) => card.uid === decision.cardUids?.[0])?.defId
      : decision.relicIds?.length === 1 && player.relics.find((relic) => relic.defId === decision.relicIds?.[0])?.defId
    if (!possible) {
      // Non-Pay/Give Event effects with no valid target resolve as no-ops.
    } else if (!target || !offered || offered === 'ascenders_bane') return state
    else return {
      ...state,
      roomState: {
        ...state.roomState,
        pendingTrade: {
          kind: tradeEffect.tag === 'trade-card' ? 'card' : 'relic',
          actorId: playerId,
          targetId: target.id,
          offeredId: offered,
          decision,
        },
      },
    }
  }
  if (state.roomState.card.id === 'tomb_red_mask' && decision.optionIds.includes('don_mask') && !state.players.some((candidate) => candidate.relics.some((relic) => relic.defId === 'red_mask'))) return state
  if (state.roomState.card.id === 'falling' && !decision.cardUids?.every((uid) => state.roomState?.kind === 'event' && state.roomState.revealedCards?.[playerId]?.includes(uid))) return state
  if (state.roomState.card.id === 'mind_bloom' && (state.roomState.partyOptionIds?.[0] === 'awake' || decision.optionIds[0] === 'awake')) {
    if (state.roomState.partyOptionIds && state.roomState.partyOptionIds[0] !== decision.optionIds[0]) return state
    const available = player.deck.filter((card) => !card.upgraded && Boolean(CARDS[card.defId]?.upgrade)).slice(0, 2)
    if (state.roomState.decisions[playerId] || (decision.cardUids?.length ?? 0) !== available.length) return state
    let changed = player
    for (const uid of decision.cardUids ?? []) {
      const nextPlayer = upgradeCard(changed, uid)
      if (nextPlayer === changed) return state
      changed = nextPlayer
    }
    const hp = Math.max(0, changed.hp - 3)
    changed = { ...changed, hp, dead: hp === 0 }
    const decisions = { ...state.roomState.decisions, [playerId]: decision }
    const roomState = { ...state.roomState, partyOptionIds: ['awake'], decisions }
    const players = state.players.map((candidate) => candidate.id === playerId ? changed : candidate)
    if (changed.dead) return { ...state, phase: 'defeat', roomState: null, players, log: [...state.log, 'The party falls during Mind Bloom.'] }
    return state.players.filter((candidate) => !candidate.dead).every((candidate) => decisions[candidate.id])
      ? { ...state, phase: 'map', roomState: null, players, log: [...state.log, 'Mind Bloom is resolved.'] }
      : { ...state, roomState, players }
  }
  if (state.roomState.card.id === 'forgotten_altar' && decision.optionIds.includes('offer')) {
    const revealed = state.roomState.revealedRelics?.[playerId]
    if (!revealed) return state
    decision = { ...decision, relicIds: [revealed] }
  }
  const rewardEffects = options.flatMap((option) => option!.effects.some((effect) => effect.tag === 'combat') ? [] : option!.effects).filter((effect): effect is CardRewardEffect =>
    (effect.tag === 'card-reward' || effect.tag === 'rare-reward') && !effect.random,
  )
  const pending = state.roomState.pendingDecisions?.[playerId]
  let resolvedPrismaticReward = false
  let eventGuardianGemGroups = [...(state.roomState.pendingGuardianGemGroups?.[playerId] ?? [])]
  let eventGuardianGemIds = [...(state.roomState.pendingGuardianGemIds?.[playerId] ?? [])]
  if (rewardEffects.length > 0 && !pending && Object.keys(state.roomState.rewardOffers ?? {}).some((id) => id !== playerId)) return state
  if (state.roomState.card.id === 'face_trader' && decision.optionIds[0] === 'take_and_give' && !pending) {
    const rng = { ...state.rng }
    const itemDecks = structuredClone(state.itemDecks)
    const option = state.roomState.card.options.find((candidate) => candidate.id === 'take_and_give')!
    const staged = resolveEventDecision({ ...state.roomState, card: { ...state.roomState.card, options: [{ ...option, effects: option.effects.slice(0, 1) }] } }, rng, itemDecks, state.players, state.ascension, playerId, decision, [], false, state.meta.ruleset)
    if (!staged) return state
    const pending = stageEventDecision(decision)
    delete pending.relicIds
    return { ...state, rng, itemDecks, players: staged.players, roomState: { ...state.roomState, pendingDecisions: { ...state.roomState.pendingDecisions, [playerId]: pending } } }
  }
  if (state.roomState.card.id === 'nloth' && decision.optionIds[0] === 'offer_relic' && !pending) {
    const rng = { ...state.rng }
    const itemDecks = structuredClone(state.itemDecks)
    const option = state.roomState.card.options.find((candidate) => candidate.id === 'offer_relic')!
    const staged = resolveEventDecision({ ...state.roomState, card: { ...state.roomState.card, options: [{ ...option, effects: option.effects.slice(0, 1) }] } }, rng, itemDecks, state.players, state.ascension, playerId, decision, [], false, state.meta.ruleset)
    if (!staged) return state
    const locked = { ...state, rng, itemDecks, players: staged.players, roomState: { ...state.roomState, pendingDecisions: { ...state.roomState.pendingDecisions, [playerId]: stageEventDecision(decision) } } }
    return chooseEventInternal(locked, playerId, decision, false)
  }
  if (rewardEffects.length > 0) {
    const currentOffers = state.roomState.rewardOffers?.[playerId]
    const currentGemGroup = state.roomState.guardianGemOffers?.[playerId]?.[0] ?? []
    if (currentOffers) {
      const choice = decision.rewardIndexes?.[0] ?? -2
      const selected = choice >= 0 ? currentOffers[0]?.[choice] : undefined
      const needsGem = Boolean(selected && cardHasGuardianSocket(selected))
      const submittedGems = decision.guardianGemIds ?? []
      if (needsGem) {
        if (submittedGems.length !== 1 || !currentGemGroup.includes(submittedGems[0]!)) return state
        eventGuardianGemGroups.push(currentGemGroup)
        eventGuardianGemIds.push(submittedGems[0]!)
      } else {
        if (submittedGems.length !== 0) return state
        state = bottomGuardianGems(state, currentGemGroup)
      }
    }
    if (state.roomState?.kind !== 'event') return state
    const rewardRoom = state.roomState
    const prismaticEffect = rewardEffects.length === 1 && rewardEffects[0]!.source !== 'colorless' && hasRelic(player, 'prismatic_shard')
      ? rewardEffects[0] : undefined
    if (prismaticEffect) {
      const rare = prismaticEffect.tag === 'rare-reward' || prismaticEffect.source === 'rare'
      if (!currentOffers) {
        const sources = decision.rewardSources ?? []
        const available = availableRewardSources(state, rare)
        if (sources.length !== 3 || new Set(sources).size !== 3 || sources.some((source) => !available.includes(source)) || rare && sources.includes('colorless')) return state
        const reserved = reservePrismaticDraws(state, sources, rare)
        const gemReveal = revealGuardianDraftGems(reserved.state, reserved.choices)
        return {
          ...gemReveal.state,
          roomState: {
            ...rewardRoom,
            rewardOffers: { ...rewardRoom.rewardOffers, [playerId]: [reserved.choices] },
            rewardDraws: { ...rewardRoom.rewardDraws, [playerId]: reserved.draws },
            guardianGemOffers: { ...rewardRoom.guardianGemOffers, [playerId]: [gemReveal.gemIds] },
            pendingGuardianGemGroups: { ...rewardRoom.pendingGuardianGemGroups, [playerId]: eventGuardianGemGroups },
            pendingGuardianGemIds: { ...rewardRoom.pendingGuardianGemIds, [playerId]: eventGuardianGemIds },
            pendingDecisions: { ...rewardRoom.pendingDecisions, [playerId]: stageEventDecision(decision) },
          },
        }
      }
      if (currentOffers.length !== 1 || decision.rewardIndexes?.length !== 1) return state
      const choice = decision.rewardIndexes[0]!
      if (choice < -1 || choice >= currentOffers[0]!.length) return state
      const draws = rewardRoom.rewardDraws?.[playerId]
      if (!draws) return state
      const beforePrismatic = state
      const settled = settlePrismaticDraws(state, rare, draws, currentOffers[0]!, choice === -1 ? null : choice)
      state = settled.selectedId ? {
        ...settled.state,
        players: settled.state.players.map((candidate) => candidate.id === playerId
          ? addCard(candidate, settled.selectedId!, `c${nextRunUid(settled.state.players)}`) : candidate),
      } : settled.state
      state = queueNewGuardianSockets(beforePrismatic, state, 1, eventGuardianGemGroups)
      for (const gemId of eventGuardianGemIds) state = resolveGuardianSocket(state, playerId, gemId)
      eventGuardianGemGroups = []
      eventGuardianGemIds = []
      decision = { ...decision, rewardIndexes: [] }
      resolvedPrismaticReward = true
    } else {
    const submitted = currentOffers ? decision.rewardIndexes : []
    if (currentOffers && (!submitted || submitted.length !== 1)) return state
    const indexes = [...(pending?.rewardIndexes ?? []), ...(submitted ?? [])]
    const preview = nextEventCardOffer(state, playerId, pending?.targetPlayerId ?? decision.targetPlayerId,
      rewardEffects, indexes, state.meta.ruleset === 'downfall')
    if (!preview.valid) return state
    if (preview.offer) {
      const gemReveal = revealGuardianDraftGems(state, preview.offer)
      return {
        ...gemReveal.state,
        roomState: {
        ...rewardRoom,
        rewardOffers: { ...rewardRoom.rewardOffers, [playerId]: [preview.offer] },
        guardianGemOffers: { ...rewardRoom.guardianGemOffers, [playerId]: [gemReveal.gemIds] },
        pendingGuardianGemGroups: { ...rewardRoom.pendingGuardianGemGroups, [playerId]: eventGuardianGemGroups },
        pendingGuardianGemIds: { ...rewardRoom.pendingGuardianGemIds, [playerId]: eventGuardianGemIds },
        pendingDecisions: { ...rewardRoom.pendingDecisions, [playerId]: { ...stageEventDecision(pending ?? decision), ...(indexes.length > 0 ? { rewardIndexes: indexes } : {}) } },
      },
      }
    }
    if (pending) decision = { ...decision, rewardIndexes: indexes }
    }
  }
  if (state.roomState?.kind !== 'event') return state
  const rollCount = options.flatMap((option) => option!.effects).filter((effect) => effect.tag === 'roll-d6').length
  if (rollCount > 0 && !state.roomState.pendingRolls?.[playerId]) {
    const preRollKinds = options.flatMap((option) => {
      const rollAt = option!.effects.findIndex((effect) => effect.tag === 'roll-d6')
      return option!.effects.slice(0, rollAt < 0 ? undefined : rollAt)
    }).flatMap((effect) => {
      const count = (effect.count ?? 1) * (effect.target === 'each-player' || effect.target === 'party' ? state.players.filter((candidate) => !candidate.dead).length : 1)
      return effect.tag === 'gain-relic' ? Array(count).fill('relic' as const) : effect.tag === 'gain-potion' ? Array(count).fill('potion' as const) : []
    })
    const itemOffer = state.roomState.itemOffers?.[playerId]
    if (preRollKinds.length > 0 && !itemOffer) {
      const itemDecks = structuredClone(state.itemDecks)
      const offers = preRollKinds.map((kind) => ({ kind, id: drawItems(kind === 'relic' ? itemDecks.relics : itemDecks.potions, 1)[0] ?? '' })).filter((offer) => offer.id)
      if (offers.length > 0) return { ...state, itemDecks, roomState: { ...state.roomState, itemOffers: { ...state.roomState.itemOffers, [playerId]: offers }, pendingDecisions: { ...state.roomState.pendingDecisions, [playerId]: stageEventDecision(pending ?? decision) } } }
    }
    if (itemOffer && (!decision.rewardItemChoices || decision.rewardItemChoices.length !== itemOffer.length)) return state
    const rollDecision = pending ? {
      ...pending,
      potionRecipientId: decision.potionRecipientId ?? pending.potionRecipientId,
      potionRecipientIds: decision.potionRecipientIds ?? pending.potionRecipientIds,
      potionReplacementIds: decision.potionReplacementIds ?? pending.potionReplacementIds,
      rewardItemChoices: decision.rewardItemChoices ?? pending.rewardItemChoices,
    } : decision
    if (itemOffer) {
      rollDecision.rewardItemIds = itemOffer.map((offer) => offer.id)
      rollDecision.rewardItemKinds = itemOffer.map((offer) => offer.kind)
    }
    const rng = { ...state.rng }
    const itemDecks = structuredClone(state.itemDecks)
    const staged = resolveEventBeforeRoll(state.roomState, rng, itemDecks, state.players, state.ascension, playerId, rollDecision, state.meta.ruleset)
    if (!staged) return state
    if (staged.players.some((candidate) => candidate.dead)) return { ...state, rng, itemDecks, players: staged.players, phase: 'defeat', roomState: null, log: [...state.log, `${state.roomState.card.name} defeats the party.`] }
    const rolls = Array.from({ length: rollCount }, () => 1 + nextInt(rng, 6))
    return { ...state, rng, itemDecks, players: staged.players, roomState: {
      ...state.roomState,
      itemOffers: Object.fromEntries(Object.entries(state.roomState.itemOffers ?? {}).filter(([id]) => id !== playerId)),
      pendingDecisions: { ...state.roomState.pendingDecisions, [playerId]: rollDecision },
      pendingRolls: { ...state.roomState.pendingRolls, [playerId]: rolls },
      dieRolls: { ...state.roomState.dieRolls, [playerId]: [...(state.roomState.dieRolls[playerId] ?? []), ...rolls] },
    } }
  }
  let rollIndex = 0
  const activeEffects = (effects: readonly import('../events.ts').EventEffect[]): import('../events.ts').EventEffect[] => effects.flatMap((effect) => {
    if (effect.tag !== 'roll-d6') return [effect]
    const roll = state.roomState?.kind === 'event' ? state.roomState.pendingRolls?.[playerId]?.[rollIndex++] : undefined
    return roll ? activeEffects(effect.results?.[roll as 1 | 2 | 3 | 4 | 5 | 6] ?? []) : []
  })
  const itemKinds = options.flatMap((option) => {
    const rollAt = option!.effects.findIndex((effect) => effect.tag === 'roll-d6')
    const effects = activeEffects(rollAt < 0 ? option!.effects : option!.effects.slice(rollAt))
    const combatAt = effects.findIndex((effect) => effect.tag === 'combat')
    return effects.slice(0, combatAt < 0 ? undefined : combatAt)
  }).flatMap((effect) => {
    const count = (effect.count ?? 1) * (effect.target === 'each-player' || effect.target === 'party' ? state.players.filter((candidate) => !candidate.dead).length : 1)
    return effect.tag === 'gain-relic'
      ? Array(count).fill('relic' as const)
      : effect.tag === 'gain-potion'
        ? Array(count).fill('potion' as const)
        : []
  })
  const itemOffer = state.roomState.itemOffers?.[playerId]
  let stagedItemDecks: ItemDecks | undefined
  if (itemKinds.length > 0 && !itemOffer && !(state.roomState.card.id === 'face_trader' && decision.optionIds[0] === 'take_and_give')) {
    const completeDecks = structuredClone(state.itemDecks)
    const completeOffers = itemKinds.map((kind) => ({ kind, id: drawItems(kind === 'relic' ? completeDecks.relics : completeDecks.potions, 1)[0] ?? '' }))
    if (completeOffers.every((offer) => offer.id)) return { ...state, itemDecks: completeDecks, roomState: { ...state.roomState, itemOffers: { ...state.roomState.itemOffers, [playerId]: completeOffers }, pendingDecisions: { ...state.roomState.pendingDecisions, [playerId]: stageEventDecision(pending ?? decision) } } }
    const itemDecks = structuredClone(state.itemDecks)
    const rewardItemIds: string[] = []
    const rewardItemKinds: ('relic' | 'potion')[] = []
    for (const kind of itemKinds) {
      const id = drawItems(kind === 'relic' ? itemDecks.relics : itemDecks.potions, 1)[0]
      if (id) return { ...state, itemDecks, roomState: { ...state.roomState, itemOffers: { ...state.roomState.itemOffers, [playerId]: [{ kind, id }] }, pendingDecisions: { ...state.roomState.pendingDecisions, [playerId]: { ...stageEventDecision(pending ?? decision), rewardItemIds, rewardItemKinds } } } }
      rewardItemIds.push('')
      rewardItemKinds.push(kind)
    }
  }
  if (itemOffer && (!decision.rewardItemChoices || decision.rewardItemChoices.length !== itemOffer.length)) return state
  if (itemOffer) {
    const itemDecks = structuredClone(state.itemDecks)
    const rewardItemIds = [...(pending?.rewardItemIds ?? [])]
    const rewardItemKinds = [...(pending?.rewardItemKinds ?? [])]
    const rewardItemChoices = [...(pending?.rewardItemChoices ?? [])]
    const potionRecipientIds = [...(pending?.potionRecipientIds ?? [])]
    const potionReplacementIds = [...(pending?.potionReplacementIds ?? [])]
    const submittedRecipients = decision.potionRecipientIds ?? (decision.potionRecipientId ? [decision.potionRecipientId] : [])
    let potionIndex = 0
    itemOffer.forEach((offer, index) => {
      const choice = decision.rewardItemChoices?.[index]
      rewardItemKinds.push(offer.kind)
      rewardItemChoices.push(choice!)
      if (offer.kind === 'potion') {
        potionRecipientIds.push(submittedRecipients[potionIndex] ?? '')
        potionReplacementIds.push(decision.potionReplacementIds?.[potionIndex] ?? '')
      }
      if (choice === 'skip') {
        rewardItemIds.push('')
        ;(offer.kind === 'relic' ? itemDecks.relics : itemDecks.potions).push(offer.id)
      } else {
        rewardItemIds.push(offer.id)
        if (offer.id === 'old_coin') itemDecks.relics.push(offer.id)
      }
      if (offer.kind === 'potion') potionIndex++
    })
    for (const kind of itemKinds.slice(rewardItemIds.length)) {
      const id = drawItems(kind === 'relic' ? itemDecks.relics : itemDecks.potions, 1)[0]
      if (id) return {
        ...state,
        itemDecks,
        roomState: {
          ...state.roomState,
          itemOffers: { ...state.roomState.itemOffers, [playerId]: [{ kind, id }] },
          pendingDecisions: { ...state.roomState.pendingDecisions, [playerId]: {
            ...stageEventDecision(pending ?? decision),
            rewardItemIds,
            rewardItemKinds,
            rewardItemChoices,
            potionRecipientIds,
            potionReplacementIds,
          } },
        },
      }
      rewardItemIds.push('')
      rewardItemKinds.push(kind)
    }
    stagedItemDecks = itemDecks
    decision = {
      ...decision,
      rewardItemIds,
      rewardItemKinds,
      rewardItemChoices,
      potionRecipientIds,
      potionReplacementIds,
    }
  }
  const leavesScrap = pending && state.roomState.card.id === 'scrap_ooze' && decision.optionIds[0] === 'leave'
  const finalDecision = pending && !leavesScrap ? {
    ...pending,
    cardUids: pending.cardUids?.length ? pending.cardUids : decision.cardUids,
    relicIds: pending.relicIds?.length ? pending.relicIds : decision.relicIds,
    potionIds: pending.potionIds?.length ? pending.potionIds : decision.potionIds,
    potionRecipientId: decision.potionRecipientId ?? pending.potionRecipientId,
    potionRecipientIds: decision.potionRecipientIds?.length ? decision.potionRecipientIds : pending.potionRecipientIds,
    potionReplacementIds: decision.potionReplacementIds?.length ? decision.potionReplacementIds : pending.potionReplacementIds,
    rewardItemChoices: decision.rewardItemChoices?.length ? decision.rewardItemChoices : pending.rewardItemChoices,
    rewardItemIds: decision.rewardItemIds ?? pending.rewardItemIds,
    rewardItemKinds: decision.rewardItemKinds ?? pending.rewardItemKinds,
    targetPlayerId: pending.targetPlayerId || decision.targetPlayerId,
    rewardIndexes: decision.rewardIndexes?.length ? decision.rewardIndexes : pending.rewardIndexes,
    roomId: pending.roomId ?? decision.roomId,
    payments: decision.payments ?? pending.payments,
  } : decision
  const rng = { ...state.rng }
  const itemDecks = stagedItemDecks ?? structuredClone(state.itemDecks)
  const forcedRolls = leavesScrap ? [] : state.roomState.pendingRolls?.[playerId] ?? []
  const cleanRoom = pending ? {
    ...state.roomState,
    rewardOffers: Object.fromEntries(Object.entries(state.roomState.rewardOffers ?? {}).filter(([id]) => id !== playerId)),
    rewardDraws: Object.fromEntries(Object.entries(state.roomState.rewardDraws ?? {}).filter(([id]) => id !== playerId)),
    guardianGemOffers: Object.fromEntries(Object.entries(state.roomState.guardianGemOffers ?? {}).filter(([id]) => id !== playerId)),
    pendingGuardianGemGroups: Object.fromEntries(Object.entries(state.roomState.pendingGuardianGemGroups ?? {}).filter(([id]) => id !== playerId)),
    pendingGuardianGemIds: Object.fromEntries(Object.entries(state.roomState.pendingGuardianGemIds ?? {}).filter(([id]) => id !== playerId)),
    itemOffers: Object.fromEntries(Object.entries(state.roomState.itemOffers ?? {}).filter(([id]) => id !== playerId)),
    pendingDecisions: Object.fromEntries(Object.entries(state.roomState.pendingDecisions ?? {}).filter(([id]) => id !== playerId)),
    pendingRolls: Object.fromEntries(Object.entries(state.roomState.pendingRolls ?? {}).filter(([id]) => id !== playerId)),
    dieRolls: forcedRolls.length > 0
      ? { ...state.roomState.dieRolls, [playerId]: (state.roomState.dieRolls[playerId] ?? []).slice(0, -forcedRolls.length) }
      : state.roomState.dieRolls,
  } : state.roomState
  if (itemOffer && !finalDecision.rewardItemIds) {
    finalDecision.rewardItemIds = itemOffer.map((offer) => offer.id)
    finalDecision.rewardItemKinds = itemOffer.map((offer) => offer.kind)
  }
  const faceTraderResume = pending && state.roomState.card.id === 'face_trader' && pending.optionIds[0] === 'take_and_give'
  const nlothResume = pending && state.roomState.card.id === 'nloth' && pending.optionIds[0] === 'offer_relic'
  const resumedRoom = faceTraderResume || nlothResume ? {
    ...cleanRoom,
    card: { ...cleanRoom.card, options: cleanRoom.card.options.map((option) => option.id === pending.optionIds[0] ? { ...option, effects: option.effects.slice(1) } : option) },
  } : cleanRoom
  const resolutionRoom = resolvedPrismaticReward ? {
    ...resumedRoom,
    card: { ...resumedRoom.card, options: resumedRoom.card.options.map((option) => finalDecision.optionIds.includes(option.id) ? {
      ...option,
      effects: option.effects.filter((effect) => !((effect.tag === 'card-reward' || effect.tag === 'rare-reward') && !effect.random && effect.source !== 'colorless')),
    } : option) },
  } : resumedRoom
  const result = resolveEventDecision(resolutionRoom, rng, itemDecks, state.players, state.ascension, playerId, finalDecision, forcedRolls, forcedRolls.length > 0, state.meta.ruleset)
  if (!result) return state
  if (faceTraderResume) result.event.card = state.roomState.card
  if (result.players.some((candidate) => candidate.dead)) return { ...state, rng, itemDecks, players: result.players, phase: 'defeat', roomState: null, log: [...state.log, `${result.event.card.name} defeats the party.`] }
  let next: RunState = { ...state, rng, itemDecks, players: result.players, roomState: result.event }
  next = queueNewGuardianSockets(state, next, 1, eventGuardianGemGroups)
  for (const gemId of eventGuardianGemIds) next = resolveGuardianSocket(next, playerId, gemId)
  if (result.merchant) {
    const guardianGemDeck = [...(next.guardianGemDeck ?? [])]
    return { ...next, guardianGemDeck,
      roomState: createMerchant(merchantItemDecks(state, itemDecks), result.players, guardianGemDeck,
        state.meta.ruleset) }
  }
  if (result.moveTo) {
    const target = state.map.rooms[result.moveTo]
    const current = currentRoom(state.map)
    if (!target || !current || target.row <= current.row) return state
    const temporaryMap = { ...state.map, rooms: { ...state.map.rooms, [current.id]: { ...current, exits: [target.id] } } }
    const portalState: RunState = { ...next, phase: 'map', roomState: null, map: temporaryMap }
    const entered = enterRoom(portalState, target.id)
    return entered === portalState ? state : {
      ...entered,
      map: { ...entered.map, rooms: { ...entered.map.rooms, [current.id]: current } },
    }
  }
  if (result.combat) {
    const room = currentRoom(state.map)
    if (!room) return state
    const preparedCombat = result.event.preparedCombat
    const players = preparedCombat ? result.players : result.players.map((player) => readyForCombat(rng, player))
    const mindBloom = result.event.card.id === 'mind_bloom' && finalDecision.optionIds.includes('war')
    // The boss-content integration consumes this seeded physical Boss id. The
    // legacy combat shell falls back only while those enemy faces are absent.
    const actOneBosses = state.meta.ruleset === 'downfall' ? DOWNFALL_BOSSES[1]! : BOSSES[1]!
    const bossDefId = mindBloom ? actOneBosses[nextInt(rng, actOneBosses.length)] : undefined
    let enemyDecks = state.enemyDecks
    let combat = preparedCombat
    if (!combat) {
      enemyDecks = state.enemyDecks.act === (mindBloom ? 1 : state.act)
        ? structuredClone(state.enemyDecks)
        : createEnemyDecks(rng, mindBloom ? 1 : state.act, state.ascension)
      const encounter = buildEncounter(
        rng, enemyDecks, mindBloom ? 1 : state.act, players,
        mindBloom ? 'boss' : result.combat, false, state.ascension,
        bossDefId, undefined, state.meta.ruleset,
      )
      // Mind Bloom prints its own Relic + Card Reward, not the boss card's Gold.
      if (mindBloom) encounter.enemies.find((enemy) => enemy.uid === 'boss-0')!.goldReward = 0
      combat = startPlayerTurnWithChoices(createCombat(
        rng, players, encounter.enemies, room.id, state.potionDeck,
        state.ascension >= 4 ? 2 : 3, encounter.summonSupply, state.lastStand, state.meta.ruleset,
      ))
    }
    combat = resumePlayerTurnAfterDraw({
      ...combat,
      players: applyEventCombatStartEffects(combat.players, result.combatStartEffects ?? []),
    })
    return { ...next, enemyDecks, phase: 'combat', players, combat, roomState: null, eventCombat: { kind: mindBloom ? 'boss' : result.combat, mindBloom, bossDefId, relicReward: result.combatReward === 'relic-each-player' }, courier: { usedBy: [], offer: null } }
  }
  return result.complete
    ? { ...next, phase: 'map', roomState: null, log: [...state.log, `${result.event.card.name} is resolved.`] }
    : next
}

function eventOptionAvailable(state: RunState, player: Player, option: EventCard['options'][number]): boolean {
  const partyGold = state.players.filter((candidate) => !candidate.dead).reduce((sum, candidate) => sum + candidate.gold, 0)
  return option.effects.every((effect, index) => {
    if (effect.source === 'other-character') return availableRewardSources(state, false)
      .some((source) => source !== 'colorless' && source !== player.character)
    if (hasRelic(player, 'prismatic_shard') && !effect.random &&
      (effect.tag === 'rare-reward' || effect.tag === 'card-reward' && effect.source !== 'colorless')) {
      return availableRewardSources(state, effect.tag === 'rare-reward' || effect.source === 'rare').length >= 3
    }
    if (effect.filter === 'party has Red Mask') return state.players.some((candidate) => candidate.relics.some((relic) => relic.defId === 'red_mask'))
    if (effect.tag === 'gain-relic') return option.effects.some((candidate) => candidate.tag === 'roll-d6') || state.itemDecks.relics.length > 0 || option.effects.slice(0, index).some((candidate) => candidate.tag === 'lose-relic' && (player.relics.length > 0 || state.roomState?.kind === 'event' && Boolean(state.roomState.revealedRelics?.[player.id]))) || state.roomState?.kind === 'event' && (state.roomState.itemOffers?.[player.id]?.some((offer) => offer.kind === 'relic') === true || state.roomState.pendingDecisions?.[player.id]?.optionIds.includes(option.id) === true)
    if (effect.tag === 'gain-potion') return option.effects.some((candidate) => candidate.tag === 'roll-d6') || state.itemDecks.potions.length > 0 || state.roomState?.kind === 'event' && (state.roomState.itemOffers?.[player.id]?.some((offer) => offer.kind === 'potion') === true || state.roomState.pendingDecisions?.[player.id]?.optionIds.includes(option.id) === true)
    if (effect.tag === 'pay-gold') return partyGold >= (typeof effect.amount === 'number' ? effect.amount : 0) || Boolean(effect.filter?.includes('or lose one Relic or Potion') && (player.relics.length || player.potions.length))
    if (effect.tag === 'lose-relic') return player.relics.length > 0 || option.effects.slice(0, index).some((candidate) => candidate.tag === 'gain-relic' && state.itemDecks.relics.length > 0)
    if (effect.tag === 'lose-potion') return player.potions.length > 0
    if (effect.tag === 'remove-card' && (option.id === 'give_card' || option.effects.slice(0, index).some((candidate) => candidate.tag === 'pay-gold'))) return player.deck.some((card) => card.defId !== 'ascenders_bane' && (option.id !== 'give_card' || ['rare', 'uncommon'].includes(CARDS[card.defId]?.rarity ?? '')))
    if (effect.tag === 'upgrade-card' && !effect.random && option.effects.slice(0, index).some((candidate) => candidate.tag === 'pay-gold')) return player.deck.some((card) => !card.upgraded && Boolean(CARDS[card.defId]?.upgrade))
    if ((effect.tag === 'rare-reward' || effect.tag === 'card-reward' && effect.source === 'rare') && option.effects.slice(0, index).some((candidate) => ['pay-gold', 'lose-relic', 'lose-potion', 'remove-card'].includes(candidate.tag))) return player.rareRewards.length > 0
    return true
  })
}

export function canSkipEvent(state: RunState, playerId: string): boolean {
  if (state.phase !== 'room' || state.roomState?.kind !== 'event' || state.roomState.decisions[playerId]) return false
  const player = state.players.find((candidate) => candidate.id === playerId && !candidate.dead)
  const used = usedBigFishOptionIds(state, playerId)
  return Boolean(player && !state.roomState.card.options.some((option) => !used.has(option.id) && eventOptionAvailable(state, player, option)))
}

export function unavailableEventOptionIds(state: RunState, playerId: string): string[] {
  if (state.phase !== 'room' || state.roomState?.kind !== 'event' || state.roomState.decisions[playerId] || state.roomState.pendingDecisions?.[playerId]) return []
  const player = state.players.find((candidate) => candidate.id === playerId && !candidate.dead)
  const used = usedBigFishOptionIds(state, playerId)
  return player ? state.roomState.card.options.filter((option) => used.has(option.id) || !eventOptionAvailable(state, player, option)).map((option) => option.id) : []
}

function usedBigFishOptionIds(state: RunState, playerId: string): Set<string> {
  if (state.roomState?.kind !== 'event' || state.roomState.card.id !== 'big_fish') return new Set()
  return new Set([
    ...Object.entries(state.roomState.decisions),
    ...Object.entries(state.roomState.pendingDecisions ?? {}),
  ].filter(([id]) => id !== playerId).flatMap(([, choice]) => choice.optionIds[0] ? [choice.optionIds[0]] : []))
}

export function skipEvent(state: RunState, playerId: string): RunState {
  if (!canSkipEvent(state, playerId) || state.roomState?.kind !== 'event') return state
  const decisions = { ...state.roomState.decisions, [playerId]: { optionIds: ['unavailable'] } }
  const done = state.roomState.card.scope === 'party' || state.players.filter((player) => !player.dead).every((player) => decisions[player.id])
  const next: RunState = done
    ? { ...state, phase: 'map', roomState: null, log: [...state.log, `${state.roomState.card.name} is left unresolved.`] }
    : { ...state, roomState: { ...state.roomState, decisions } }
  return done ? applyDeadlyEvent(state, next) : next
}
