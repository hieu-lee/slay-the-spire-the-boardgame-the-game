// What the run hands out, and how a player takes it.
//
// Card rewards, potions and relics, plus the shared bookkeeping underneath
// them: which character's deck a reward is drawn from, how Prismatic Shard
// reserves a draw from several decks at once, and the potion limit a gain is
// checked against. A fight is the usual source, but not the only one — Neow's
// blessing, the opening heirlooms and an event's offer all come through here,
// which is why this sits below them rather than beside them.
import {
  GOLDEN_TICKET,
  canUpgradeCard,
  hasModifier,
  hasPendingRelicAcquisition,
  hasRelic,
  nextRunUid,
  victoryIsTerminal,
} from './rules.ts'
import { mirrorItemSupplies, mirrorLegacySupplies } from './supplies.ts'
import type { CardRewardOffer, PotionRewardDecision, RewardSource, RunState } from './types.ts'
import {
  addCard,
  acquisitionCardType,
  bottomCardChoices,
  drawCardChoices,
  gainPotion,
  gainRelic,
  healingCapFor,
  potionLimit,
  transformCard,
} from '../acquisition.ts'
import { isActIVUnlocked } from '../campaign.ts'
import { cardIsCurse, isStarterStrikeOrDefend } from '../cards.ts'
import { decideRelicReward, resolveRelicReward as resolveRoomRelicReward } from '../noncombat.ts'
import type { TreasureDecision } from '../noncombat.ts'
import { bottomGuardianGems, cardHasGuardianSocket, drawGuardianGemChoices, queueGuardianSocket, queueNewGuardianSockets, revealGuardianDraftGems } from './guardian-gems.ts'
import { createRelicInstance, relicDef } from '../relics.ts'
import type { CardInstance, Player } from '../types.ts'
import { CHARACTER_IDS } from '../types.ts'

export function grantHeirlooms(state: RunState, playerIds: readonly string[]): RunState {
  let next = state
  for (const playerId of playerIds) {
    const relicId = next.bossRelicDeck[0]
    if (!relicId) break
    next = acquireRelic({ ...next, bossRelicDeck: next.bossRelicDeck.slice(1) }, playerId, relicId)
  }
  return next
}

export function pendingRelicEligibleCards(player: Pick<Player, 'deck'>, relicId: string): CardInstance[] {
  const starter = relicId === 'war_paint'
    ? player.deck.find((card) => isStarterStrikeOrDefend(card.defId, 'Defend') && !card.upgraded)
    : relicId === 'whetstone' ? player.deck.find((card) => isStarterStrikeOrDefend(card.defId, 'Strike') && !card.upgraded) : undefined
  return player.deck.filter((card) => {
    const type = acquisitionCardType(card.defId)
    if (relicId === 'war_paint') return type === 'skill' && !card.upgraded && card.uid !== starter?.uid
    if (relicId === 'whetstone') return type === 'attack' && !card.upgraded && card.uid !== starter?.uid
    if (['astrolabe', 'tiny_house'].includes(relicId)) return canUpgradeCard(card)
    if (relicId === 'empty_cage') return card.defId !== 'ascenders_bane'
    if (relicId === 'pandoras_box') return type !== 'curse'
    return true
  })
}

export function expandCommonReward(raw: readonly string[], rare: readonly string[], replaceDuplicates = false): {
  choices: string[]
  rawIndices: number[]
  rareIndices: Array<number | null>
  rareCount: number
} {
  const choices: string[] = []
  const rawIndices: number[] = []
  const rareIndices: Array<number | null> = []
  const seen = new Set<string>()
  let rareCount = 0
  raw.forEach((defId, rawIndex) => {
    const rareIndex = defId === GOLDEN_TICKET ? rareCount++ : null
    if (rareIndex === null && replaceDuplicates && seen.has(defId)) return
    if (rareIndex === null) seen.add(defId)
    const choice = rareIndex === null ? defId : rare[rareIndex]
    if (!choice) return
    choices.push(choice)
    rawIndices.push(rawIndex)
    rareIndices.push(rareIndex)
  })
  return { choices, rawIndices, rareIndices, rareCount }
}

export function pendingRewardChoices(player: Player, relicId: string, replaceDuplicates = false): string[][] {
  if (relicId === 'enchiridion') return [player.rareRewards.slice(0, 5)]
  if (relicId === 'downfall_enchiridion') {
    const draw = drawCardChoices(player, 5, true)
    return [expandCommonReward(draw.cardsDrawn, draw.raresDrawn, true).choices]
  }
  const holder = { ...player, cardRewards: [...player.cardRewards], rareRewards: [...player.rareRewards] }
  if (relicId === 'forbidden_fruit') {
    const common = drawCardChoices(holder, 3, true)
    const choices = expandCommonReward(common.cardsDrawn, common.raresDrawn, true).choices
    Object.assign(holder, bottomCardChoices(holder, common, null))
    return [choices, holder.rareRewards.slice(0, 5)]
  }
  const count = relicId === 'orrery' ? 4 : relicId === 'tiny_house' ? 1 : 0
  return Array.from({ length: count }, () => {
    const draw = drawCardChoices(holder, 3, replaceDuplicates)
    Object.assign(holder, bottomCardChoices(holder, draw, null))
    return expandCommonReward(draw.cardsDrawn, draw.raresDrawn, replaceDuplicates).choices
  })
}

function rewardSourceDeck(state: RunState, source: RewardSource, rare: boolean): string[] {
  if (source === 'colorless') return rare ? [] : state.itemDecks.colorless
  const owner = state.players.find((player) => player.character === source)
  return owner ? (rare ? owner.rareRewards : owner.cardRewards)
    : (rare ? state.itemDecks.characterRares[source] : state.itemDecks.characterCards[source]) ?? []
}

function withRewardSourceDeck(state: RunState, source: RewardSource, rare: boolean, deck: string[]): RunState {
  if (source === 'colorless') return { ...state, itemDecks: { ...state.itemDecks, colorless: deck } }
  const owner = state.players.find((player) => player.character === source)
  if (owner) return { ...state, players: state.players.map((player) => player.id !== owner.id ? player
    : rare ? { ...player, rareRewards: deck } : { ...player, cardRewards: deck }) }
  return { ...state, itemDecks: {
    ...state.itemDecks,
    ...(rare
      ? { characterRares: { ...state.itemDecks.characterRares, [source]: deck } }
      : { characterCards: { ...state.itemDecks.characterCards, [source]: deck } }),
  } }
}

export function availableRewardSources(state: RunState, rare: boolean): RewardSource[] {
  const sources: RewardSource[] = [...CHARACTER_IDS, ...(rare ? [] : ['colorless' as const])]
  return sources.filter((source) => {
    const deck = rewardSourceDeck(state, source, rare)
    return deck.length > 0 && (rare || deck[0] !== GOLDEN_TICKET || rewardSourceDeck(state, source, true).length > 0)
  })
}

/** Repair open Act I-II boss rewards written before their yellow icon was classified as Rare. */
export function migrateLegacyBossRareRewards(state: RunState): RunState {
  if (state.phase !== 'reward' || state.act > 2 || state.rewardDestination !== 'victory') return state
  const stale = state.rewards.filter((offer) => !offer.cardSource)
  if (stale.length === 0) return state
  const bottomKnownDraws = (deck: string[], drawn: readonly string[]) => {
    const remaining = [...deck]
    const bottom: string[] = []
    for (const defId of drawn) {
      const index = remaining.indexOf(defId)
      if (index >= 0) bottom.push(...remaining.splice(index, 1))
    }
    return [...remaining, ...bottom]
  }

  let next = state
  for (const offer of stale.filter((candidate) => candidate.cardReward && candidate.prismaticDraws)) {
    next = settlePrismaticDraws(next, false, offer.prismaticDraws!, offer.choices ?? [], null).state
  }
  for (const player of state.players) {
    const offer = stale.find((candidate) => candidate.playerId === player.id && candidate.cardReward &&
      !candidate.prismaticDraws && candidate.cardsDrawn && candidate.raresDrawn)
    if (!offer) continue
    next = {
      ...next,
      players: next.players.map((candidate) => candidate.id === offer.playerId ? {
        ...candidate,
        cardRewards: offer.drawsReserved
          ? [...candidate.cardRewards, ...offer.cardsDrawn!]
          : bottomKnownDraws(candidate.cardRewards, offer.cardsDrawn!),
        rareRewards: offer.drawsReserved
          ? [...candidate.rareRewards, ...offer.raresDrawn!]
          : bottomKnownDraws(candidate.rareRewards, offer.raresDrawn!),
      } : candidate),
    }
  }

  return {
    ...next,
    rewards: next.rewards.map((offer) => {
      if (!stale.includes(offer)) return offer
      const player = next.players.find((candidate) => candidate.id === offer.playerId)
      const prismatic = Boolean(player && hasRelic(player, 'prismatic_shard'))
      const availableSources = prismatic ? availableRewardSources(next, true) : undefined
      return {
        ...offer,
        cardReward: Boolean(player && (prismatic ? (availableSources?.length ?? 0) >= 3 : player.rareRewards.length > 0)),
        cardSource: 'rare',
        transformReward: false,
        prismatic,
        choices: null,
        rareChoiceIndices: undefined,
        cardsDrawn: undefined,
        raresDrawn: undefined,
        drawsReserved: undefined,
        prismaticSources: undefined,
        prismaticDraws: undefined,
        availableSources,
      }
    }),
  }
}

export function reservePrismaticDraws(state: RunState, sources: readonly RewardSource[], rare: boolean): {
  state: RunState
  draws: NonNullable<CardRewardOffer['prismaticDraws']>
  choices: string[]
} {
  let reserved = state
  const draws = sources.map((source) => {
    const deck = rewardSourceDeck(reserved, source, rare)
    const cardId = deck[0]!
    reserved = withRewardSourceDeck(reserved, source, rare, deck.slice(1))
    const rareId = !rare && cardId === GOLDEN_TICKET && source !== 'colorless'
      ? rewardSourceDeck(reserved, source, true)[0] : undefined
    if (rareId) reserved = withRewardSourceDeck(reserved, source, true, rewardSourceDeck(reserved, source, true).slice(1))
    if (cardId === GOLDEN_TICKET) reserved = withRewardSourceDeck(reserved, source, false, [...rewardSourceDeck(reserved, source, false), GOLDEN_TICKET])
    return { source, cardId, rareId }
  })
  return {
    state: reserved,
    draws,
    choices: draws.flatMap(({ cardId, rareId }) => cardId === GOLDEN_TICKET ? rareId ? [rareId] : [] : [cardId]),
  }
}

export function settlePrismaticDraws(
  state: RunState,
  rare: boolean,
  draws: NonNullable<CardRewardOffer['prismaticDraws']>,
  choices: readonly string[],
  choice: number | null,
): { state: RunState; selectedId?: string } {
  let choiceIndex = 0
  for (const draw of draws) {
    if (rare) {
      const deck = rewardSourceDeck(state, draw.source, true)
      state = withRewardSourceDeck(state, draw.source, true, [...deck, ...(choice === choiceIndex ? [] : [draw.cardId])])
      choiceIndex++
    } else if (draw.cardId === GOLDEN_TICKET) {
      if (draw.rareId && draw.source !== 'colorless') {
        const rareDeck = rewardSourceDeck(state, draw.source, true)
        state = withRewardSourceDeck(state, draw.source, true, [...rareDeck, ...(choice === choiceIndex ? [] : [draw.rareId])])
        choiceIndex++
      }
    } else {
      const deck = rewardSourceDeck(state, draw.source, false)
      state = withRewardSourceDeck(state, draw.source, false, [...deck, ...(choice === choiceIndex ? [] : [draw.cardId])])
      choiceIndex++
    }
  }
  return { state, selectedId: choice === null ? undefined : choices[choice] }
}

export function neowRewardSources(state: RunState, playerId: string): RewardSource[] {
  const progress = state.phase === 'neow' ? state.neow?.players[playerId] : undefined
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (!progress || !player || !hasRelic(player, 'prismatic_shard') || hasModifier(state, 'transformed')) return []
  const kind = progress.redRewardPending ? 'card' : progress.rewardKind
  return kind === 'card' || kind === 'rare' ? availableRewardSources(state, kind === 'rare') : []
}

export function cardRewardSources(state: RunState, playerId: string): RewardSource[] {
  const offer = state.rewards.find((candidate) => candidate.playerId === playerId && candidate.cardReward)
  if (!offer?.prismatic || offer.choices !== null) return []
  const rare = offer.cardSource === 'rare'
  return availableRewardSources(state, rare)
}

function refreshPrismaticRewardSources(state: RunState): RunState {
  let projected = state
  for (const revealed of state.rewards.filter((offer) => offer.choices !== null && !offer.drawsReserved)) {
    projected = reserveRevealedRewardDraws(projected, revealed.playerId)
  }
  return {
    ...state,
    rewards: state.rewards.map((offer) => offer.prismatic && offer.choices === null ? {
      ...offer,
      availableSources: availableRewardSources(projected, offer.cardSource === 'rare'),
    } : offer),
  }
}

/** Reveal one player's top three; rewards may instead be skipped unseen (p.8). */
export function revealCardReward(state: RunState, playerId: string, sources: readonly RewardSource[] = []): RunState {
  if (state.phase !== 'reward' || hasPendingRelicAcquisition(state)) return state
  const offer = state.rewards.find((candidate) => candidate.playerId === playerId)
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (!offer || !offer.cardReward || offer.choices !== null || !player) return state
  if (offer.prismatic) {
    let reservedState = state
    for (const revealed of state.rewards.filter((candidate) => candidate.choices !== null && !candidate.drawsReserved)) {
      reservedState = reserveRevealedRewardDraws(reservedState, revealed.playerId)
    }
    const currentOffer = reservedState.rewards.find((candidate) => candidate.playerId === playerId)
    if (!currentOffer?.cardReward || currentOffer.choices !== null) return state
    const available = cardRewardSources(reservedState, playerId)
    if (sources.length !== 3 || new Set(sources).size !== 3 || sources.some((source) => !available.includes(source)) ||
      currentOffer.cardSource === 'rare' && sources.includes('colorless')) return state
    const rare = currentOffer.cardSource === 'rare'
    const reserved = reservePrismaticDraws(reservedState, sources, rare)
    const gemReveal = revealGuardianDraftGems(reserved.state, reserved.choices)
    return {
      ...gemReveal.state,
      rewards: gemReveal.state.rewards.map((candidate) => candidate === currentOffer ? {
        ...candidate,
        prismaticSources: [...sources],
        prismaticDraws: reserved.draws,
        choices: reserved.choices,
        guardianGems: gemReveal.gemIds,
      } : candidate.prismatic && candidate.choices === null ? {
        ...candidate,
        availableSources: availableRewardSources(gemReveal.state, candidate.cardSource === 'rare'),
      } : candidate),
    }
  }
  if (offer.cardSource === 'rare') {
    const drawn = player.rareRewards.slice(0, 3)
    const gemReveal = revealGuardianDraftGems(state, drawn)
    return refreshPrismaticRewardSources({
      ...gemReveal.state,
      rewards: gemReveal.state.rewards.map((candidate) => candidate === offer
        ? { ...candidate, choices: [...drawn], cardsDrawn: [], raresDrawn: [...drawn], guardianGems: gemReveal.gemIds }
        : candidate),
    })
  }
  const draw = drawCardChoices(player, 3, state.meta.ruleset === 'downfall')
  const ordinaryChoiceCount = draw.choices.length - draw.raresDrawn.length
  const gemReveal = revealGuardianDraftGems(state, draw.choices)
  return refreshPrismaticRewardSources({
    ...gemReveal.state,
    rewards: gemReveal.state.rewards.map((candidate) => candidate === offer
      ? {
          ...candidate,
          choices: draw.choices,
          rareChoiceIndices: draw.raresDrawn.map((_defId, index) => ordinaryChoiceCount + index),
          cardsDrawn: draw.cardsDrawn,
          raresDrawn: draw.raresDrawn,
          guardianGems: gemReveal.gemIds,
        }
      : candidate),
  })
}

export function reserveRevealedRewardDraws(state: RunState, playerId: string): RunState {
  const offer = state.rewards.find((candidate) => candidate.playerId === playerId && candidate.cardReward &&
    candidate.choices !== null && !candidate.drawsReserved && candidate.cardsDrawn && candidate.raresDrawn)
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (!offer || !player) return state
  const cards = offer.cardsDrawn ?? []
  const rares = offer.raresDrawn ?? []
  if (cards.some((card, index) => player.cardRewards[index] !== card) ||
    rares.some((card, index) => player.rareRewards[index] !== card)) return state
  return {
    ...state,
    players: state.players.map((candidate) => candidate.id === playerId ? {
      ...candidate,
      cardRewards: candidate.cardRewards.slice(cards.length),
      rareRewards: candidate.rareRewards.slice(rares.length),
    } : candidate),
    rewards: state.rewards.map((candidate) => candidate === offer
      ? { ...candidate, drawsReserved: true } : candidate),
  }
}

export const potionLimitFor = potionLimit

function settlePotionOffer(offer: CardRewardOffer): CardRewardOffer {
  const queue = offer.potionQueue ?? []
  return {
    ...offer,
    potion: queue.length > 0 ? queue[0]! : false,
    potionQueue: queue.length > 1 ? queue.slice(1) : undefined,
  }
}

export function canGainPotion(player: Player, limit: number): boolean {
  return !player.relics.some((relic) => relic.defId === 'sozu') && player.potions.length < limit
}

/** Reserve the physical top card and turn it face up for the whole party. */
export function revealPotionReward(state: RunState, playerId: string): RunState {
  if (state.phase !== 'reward' || hasPendingRelicAcquisition(state)) return state
  const offer = state.rewards.find((candidate) => candidate.playerId === playerId)
  const potion = state.potionDeck[0]
  if (!offer || offer.potion !== null || !potion) return state
  return mirrorLegacySupplies({
    ...state,
    potionDeck: state.potionDeck.slice(1),
    rewards: state.rewards.map((candidate) => candidate === offer ? { ...candidate, potion } : candidate),
    log: [...state.log, `${state.players.find((player) => player.id === playerId)?.name ?? 'A player'} reveals a Potion reward.`],
  })
}

/** Settle one potion reward immediately; card rewards remain independently choosable. */
export function resolvePotionReward(
  state: RunState,
  playerId: string,
  decision: PotionRewardDecision,
): RunState {
  if (state.phase !== 'reward' || hasPendingRelicAcquisition(state)) return state
  const offer = state.rewards.find((candidate) => candidate.playerId === playerId)
  const owner = state.players.find((player) => player.id === playerId)
  if (!offer || offer.potion === false || !owner) return state

  // Skipping before reveal draws nothing. A revealed skipped card goes bottom.
  if (decision.kind === 'skip') {
    const bottom = typeof offer.potion === 'string' ? [offer.potion] : []
    const next = mirrorLegacySupplies({
      ...state,
      potionDeck: [...state.potionDeck, ...bottom],
      rewards: state.rewards.map((candidate) => candidate === offer ? settlePotionOffer(candidate) : candidate),
      log: [...state.log, `${owner.name} skips a Potion reward${bottom.length ? '' : ' unseen'}.`],
    })
    return next.rewards.every((candidate) => !candidate.cardReward && !candidate.transformReward && candidate.potion === false)
      ? resolveCardRewards(next, {})
      : next
  }
  if (typeof offer.potion !== 'string') return state
  const limit = potionLimitFor(state.ascension, owner)
  let recipient = owner
  let returned: string[] = []
  if (decision.kind === 'pass') {
    const target = state.players.find((player) => player.id === decision.playerId)
    if (!target || target.dead || target.id === owner.id ||
      !canGainPotion(target, potionLimitFor(state.ascension, target))) return state
    recipient = target
  } else if (decision.kind === 'replace') {
    const held = owner.potions.indexOf(decision.potionId)
    if (held < 0 || owner.relics.some((relic) => relic.defId === 'sozu')) return state
    returned = [decision.potionId]
  } else if (!canGainPotion(owner, limit)) {
    return state
  }

  const players = state.players.map((player) => {
    if (player.id !== recipient.id) return player
    const potions = decision.kind === 'replace'
      ? [...player.potions.filter((_potion, index) => index !== player.potions.indexOf(decision.potionId)), offer.potion as string]
      : [...player.potions, offer.potion as string]
    return { ...player, potions }
  })
  const next = mirrorLegacySupplies({
    ...state,
    players,
    potionDeck: [...state.potionDeck, ...returned],
    rewards: state.rewards.map((candidate) => candidate === offer ? settlePotionOffer(candidate) : candidate),
    log: [...state.log, `${recipient.name} gains ${offer.potion}.`],
  })
  return next.rewards.every((candidate) => !candidate.cardReward && !candidate.transformReward && candidate.potion === false)
    ? resolveCardRewards(next, {})
    : next
}

/** Only face-up potions may be traded, and only outside combat (rulebook p.8). */
export function tradePotion(
  state: RunState,
  fromPlayerId: string,
  toPlayerId: string,
  potionId: string,
): RunState {
  if (state.phase === 'combat' || state.phase === 'defeat' || victoryIsTerminal(state, state.campaignProgress) ||
    hasPendingRelicAcquisition(state) || fromPlayerId === toPlayerId) return state
  const from = state.players.find((player) => player.id === fromPlayerId)
  const to = state.players.find((player) => player.id === toPlayerId)
  if (!from || !to || from.dead || to.dead || !from.potions.includes(potionId) ||
    !canGainPotion(to, potionLimitFor(state.ascension, to))) return state
  let moved = false
  return {
    ...state,
    players: state.players.map((player) => {
      if (player.id === from.id) return {
        ...player,
        potions: player.potions.filter((potion) => {
          if (!moved && potion === potionId) { moved = true; return false }
          return true
        }),
      }
      return player.id === to.id ? { ...player, potions: [...player.potions, potionId] } : player
    }),
    log: [...state.log, `${from.name} gives a Potion to ${to.name}.`],
  }
}

/** The potion effects explicitly permitted outside combat by the physical FAQ. */
export function usePotionOutsideCombat(
  state: RunState,
  playerId: string,
  potionId: string,
  replacePotionId?: string,
): RunState {
  if (state.phase === 'combat' || state.phase === 'defeat' || victoryIsTerminal(state, state.campaignProgress) ||
    hasPendingRelicAcquisition(state)) return state
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (!player || player.dead || !player.potions.includes(potionId)) return state
  if (potionId === 'blood_potion' && player.hp >= healingCapFor(player, state.meta.ruleset)) return state
  const sozuBlocksBrew = potionId === 'entropic_brew' && player.relics.some((relic) => relic.defId === 'sozu')
  if (potionId === 'entropic_brew') {
    if (!sozuBlocksBrew) {
      const overflow = Math.max(0, player.potions.length - 1 + 2 - potionLimitFor(state.ascension, player))
      const replaceable = replacePotionId !== potionId && player.potions.includes(replacePotionId ?? '')
      if (overflow > 1 || (overflow === 1) !== replaceable) return state
    }
  } else if (replacePotionId !== undefined) return state
  if (potionId !== 'blood_potion' && potionId !== 'entropic_brew') return state
  const deck = [...state.potionDeck]
  const gained = potionId === 'entropic_brew' && !sozuBlocksBrew ? deck.splice(0, 2) : []
  deck.push(potionId, ...(!sozuBlocksBrew && replacePotionId ? [replacePotionId] : []))
  let removed = false
  let replaced = false
  return mirrorLegacySupplies({
    ...state,
    potionDeck: deck,
    players: state.players.map((candidate) => candidate.id !== playerId ? candidate : {
      ...candidate,
      hp: potionId === 'blood_potion'
        ? Math.min(healingCapFor(candidate, state.meta.ruleset), candidate.hp + 2)
        : candidate.hp,
      potions: [
        ...candidate.potions.filter((potion) => {
          if (!removed && potion === potionId) { removed = true; return false }
          if (!sozuBlocksBrew && !replaced && potion === replacePotionId) { replaced = true; return false }
          return true
        }),
        ...gained,
      ],
    }),
    log: [...state.log, `${player.name} uses ${potionId}.`],
  })
}

export function revealRelicReward(state: RunState, playerId: string): RunState {
  if (state.phase !== 'reward' || hasPendingRelicAcquisition(state)) return state
  const offer = state.rewards.find((candidate) => candidate.playerId === playerId)
  const relic = state.relicDeck[0]
  if (!offer || offer.relic !== null || !relic) return state
  return mirrorLegacySupplies({
    ...state,
    relicDeck: state.relicDeck.slice(1),
    rewards: state.rewards.map((candidate) => candidate === offer ? { ...candidate, relic } : candidate),
  })
}

/**
 * One authoritative acquisition boundary for rewards, Calling Bell, and future
 * Merchant/Event callers. Immediate physical text resolves here; choice-based
 * one-shot relics remain face up with `pending` until their owner resolves it.
 */
export function acquireRelic(state: RunState, playerId: string, relicId: string): RunState {
  state = reserveRevealedRewardDraws(state, playerId)
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (!player || !relicDef(relicId)) return state
  let guardianGemDeck = [...(state.guardianGemDeck ?? [])]
  const guardianGemGroups = ['enchiridion', 'downfall_enchiridion', 'orrery', 'tiny_house', 'forbidden_fruit']
    .includes(relicId)
    ? pendingRewardChoices(player, relicId, state.meta.ruleset === 'downfall').map((choices) => {
      if (!choices.some(cardHasGuardianSocket)) return []
      return drawGuardianGemChoices(guardianGemDeck, 2)
    })
    : undefined
  const itemDecks = { ...state.itemDecks, curses: [...state.itemDecks.curses] }
  let relicDeck = [...state.relicDeck]
  let uid = nextRunUid(state.players)
  const potionDeckAfterBelt = [...state.potionDeck]
  const bottomOldCoin = () => {
    relicDeck = [...relicDeck.filter((id) => id !== 'old_coin'), 'old_coin']
  }
  const addCurse = (owner: Player): Player => {
    if (hasRelic(owner, 'omamori')) return owner
    const defId = itemDecks.curses.shift()
    if (!defId) return owner
    return { ...owner, deck: [...owner.deck, { uid: `c${uid++}`, defId, upgraded: false }] }
  }
  const players = state.players.map((candidate) => {
    if (candidate.id !== playerId) return candidate
    let owner = candidate
    if (relicId === 'old_coin') {
      bottomOldCoin()
      return hasRelic(owner, 'ectoplasm') ? owner : { ...owner, gold: owner.gold + 10 }
    }
    if (relicId === 'calling_bell') {
      const revealed = relicDeck.splice(0, 3)
      for (const id of revealed) {
        if (id === 'old_coin') bottomOldCoin()
        owner = gainRelic(owner, id, potionDeckAfterBelt, state.ascension)
      }
      return addCurse(owner)
    }
    const relic = createRelicInstance(relicId)
    if (relic.pending && guardianGemGroups) {
      relic.guardianGemGroups = guardianGemGroups
      owner = { ...owner, relics: [...owner.relics, relic] }
    } else owner = gainRelic(owner, relicId, potionDeckAfterBelt, state.ascension)
    if (relicId === 'mark_of_pain' && state.meta.ruleset === 'downfall') {
      const maxHp = Math.max(1, owner.maxHp - 2)
      owner = { ...owner, maxHp, hp: Math.min(owner.hp, maxHp) }
    }
    if (relicId === 'cursed_key') {
      owner = addCurse(owner)
      owner = addCurse(owner)
    }
    if (relicId === 'tiny_house' && !hasRelic(owner, 'ectoplasm')) owner = { ...owner, gold: owner.gold + 3 }
    return owner
  })
  const tinyCanGainDirectly = relicId === 'tiny_house' && state.phase === 'neow' &&
    !hasRelic(player, 'sozu') && player.potions.length < potionLimit(state.ascension, player)
  const tinyHasOffer = state.rewards.some((offer) => offer.playerId === playerId)
  const tinyPotion = relicId === 'tiny_house' && !hasRelic(player, 'sozu') && (tinyCanGainDirectly || tinyHasOffer)
    ? potionDeckAfterBelt[0] : undefined
  const finalPlayers = tinyPotion && tinyCanGainDirectly
    ? players.map((candidate) => candidate.id === playerId ? gainPotion(candidate, tinyPotion, state.ascension) : candidate)
    : players
  return mirrorLegacySupplies({
    ...state,
    guardianGemDeck,
    itemDecks,
    relicDeck,
    potionDeck: tinyPotion ? potionDeckAfterBelt.slice(1) : potionDeckAfterBelt,
    players: finalPlayers,
    rewards: tinyPotion && !tinyCanGainDirectly ? state.rewards.map((offer) => offer.playerId === playerId
      ? offer.potion === false
        ? { ...offer, potion: tinyPotion }
        : { ...offer, potionQueue: [...(offer.potionQueue ?? []), tinyPotion] }
      : offer) : state.rewards,
  })
}

export function resolveRelicReward(state: RunState, playerId: string, gain: boolean): RunState {
  if (state.phase !== 'reward' || hasPendingRelicAcquisition(state)) return state
  const offer = state.rewards.find((candidate) => candidate.playerId === playerId)
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (!offer || offer.relic === false || !player) return state
  if (offer.relic === null && gain) return state
  const relic = typeof offer.relic === 'string' ? offer.relic : null
  const rewards = state.rewards.map((candidate) => candidate === offer ? { ...candidate, relic: false as const } : candidate)
  let next = mirrorLegacySupplies({
    ...state,
    relicDeck: relic && !gain ? [...state.relicDeck, relic] : state.relicDeck,
    players: state.players,
    rewards,
  })
  if (relic && gain) next = acquireRelic(next, playerId, relic)
  return rewards.every((candidate) => !candidate.cardReward && !candidate.transformReward && candidate.relic === false &&
    candidate.potion === false && candidate.bossRelics === false)
    ? { ...next, phase: state.rewardDestination ?? 'map', rewards: [], rewardDestination: null }
    : next
}

export function resolveBossRelicReward(state: RunState, playerId: string, relicId: string | null): RunState {
  if (state.phase !== 'reward' || hasPendingRelicAcquisition(state)) return state
  const offer = state.rewards.find((candidate) => candidate.playerId === playerId)
  if (!offer || offer.bossRelics === false || !offer.bossRelics) return state
  if (relicId !== null && !offer.bossRelics.includes(relicId)) return state
  const remaining = relicId === null ? offer.bossRelics : offer.bossRelics.filter((id) => id !== relicId)
  const rewards = state.rewards.map((candidate) => candidate.bossRelics === false || !candidate.bossRelics
    ? candidate
    : candidate === offer ? { ...candidate, bossRelics: false as const }
      : { ...candidate, bossRelics: [...remaining] })
  const settled = rewards.every((candidate) => candidate.bossRelics === false)
  let next: RunState = {
    ...state,
    bossRelicDeck: settled ? [...state.bossRelicDeck, ...remaining] : state.bossRelicDeck,
    players: state.players,
    rewards,
  }
  if (relicId !== null) next = acquireRelic(next, playerId, relicId)
  return settled && next.rewards.every((candidate) => !candidate.cardReward && !candidate.transformReward && candidate.potion === false)
    ? { ...next, phase: state.rewardDestination ?? 'map', rewards: [], rewardDestination: null }
    : next
}

/** Resolve every living player's revealed choice or unseen skip together (p.8). */
export function resolveCardRewards(
  state: RunState,
  decisions: Readonly<Record<string, number | null>>,
): RunState {
  if (state.phase !== 'reward' || !state.rewardDestination || hasPendingRelicAcquisition(state)) return state
  if (state.rewards.some((offer) => offer.transformReward || offer.potion !== false || (offer.relic ?? false) !== false)) return state
  for (const offer of state.rewards.filter((candidate) => candidate.cardReward)) {
    const player = state.players.find((candidate) => candidate.id === offer.playerId)
    if (!player) return state
    if (offer.prismatic) {
      if (offer.choices !== null && (!offer.prismaticDraws || offer.prismaticDraws.length !== 3)) return state
      if (!(offer.playerId in decisions)) return state
      const choice = decisions[offer.playerId]
      if (choice === undefined || choice !== null && (offer.choices === null || !Number.isInteger(choice) || choice < 0 || choice >= offer.choices.length)) return state
      continue
    }
    const draw = offer.cardSource === 'rare'
      ? { choices: offer.choices ?? [], cardsDrawn: [], raresDrawn: offer.raresDrawn ?? [] }
      : offer.cardsDrawn && offer.raresDrawn
      ? { choices: offer.choices ?? [], cardsDrawn: offer.cardsDrawn, raresDrawn: offer.raresDrawn }
      : drawCardChoices(player, 3, state.meta.ruleset === 'downfall')
    const expected = draw.choices
    if (offer.choices !== null && (
      offer.choices.length !== expected.length ||
      offer.choices.some((defId, index) => defId !== expected[index])
    )) return state
    if (!(offer.playerId in decisions)) return state
    const choice = decisions[offer.playerId]
    if (choice === undefined) return state
    if (choice !== null && (
      offer.choices === null || !Number.isInteger(choice) || choice < 0 || choice >= offer.choices.length
    )) return state
  }

  // Derive the next uid from THIS run. Another room may have called createRun
  // since this one started, so the setup counter is not authoritative here.
  let nextUid = Math.max(0, ...state.players.flatMap((player) =>
    player.deck.map((card) => Number(/^c(\d+)$/.exec(card.uid)?.[1] ?? 0)),
  ))
  const gainedSockets: Array<{ playerId: string; cardUid: string; gemIds: string[] }> = []
  for (const offer of state.rewards.filter((candidate) => candidate.cardReward && candidate.prismatic)) {
    const choice = decisions[offer.playerId] ?? null
    const settled = settlePrismaticDraws(state, offer.cardSource === 'rare', offer.prismaticDraws ?? [], offer.choices ?? [], choice)
    state = settled.state
    const selectedId = settled.selectedId
    if (selectedId) {
      const cardUid = `c${++nextUid}`
      if (cardHasGuardianSocket(selectedId)) gainedSockets.push({ playerId: offer.playerId, cardUid, gemIds: offer.guardianGems ?? [] })
      state = {
      ...state,
      players: state.players.map((player) => player.id === offer.playerId
        ? addCard(player, selectedId, cardUid, offer.upgraded) : player),
      }
    }
  }
  state = { ...state, rewards: state.rewards.map((offer) => offer.prismatic ? { ...offer, cardReward: false } : offer) }
  const players = state.players.map((player) => {
    const offer = state.rewards.find((candidate) => candidate.playerId === player.id)
    if (!offer?.cardReward) return player
    const choice = decisions[player.id] ?? null
    if (offer.choices === null) return player
    const shown = offer.choices
    const selected = choice === null ? null : shown[choice]!
    if (offer.cardSource === 'rare') {
      const shown = offer.raresDrawn ?? []
      const selected = choice === null ? null : shown[choice]
      let owner = {
        ...player,
        rareRewards: [
          ...(offer.drawsReserved ? player.rareRewards : player.rareRewards.slice(shown.length)),
          ...shown.filter((_id, index) => index !== choice),
        ],
      }
      if (selected) {
        const cardUid = `c${++nextUid}`
        owner = addCard(owner, selected, cardUid, offer.upgraded)
        if (cardHasGuardianSocket(selected)) gainedSockets.push({ playerId: player.id, cardUid, gemIds: offer.guardianGems ?? [] })
      }
      return owner
    }
    const draw = offer.cardsDrawn && offer.raresDrawn
      ? { choices: shown, cardsDrawn: offer.cardsDrawn, raresDrawn: offer.raresDrawn }
      : drawCardChoices(player, 3, state.meta.ruleset === 'downfall')
    const bottomed = bottomCardChoices(offer.drawsReserved ? {
      ...player,
      cardRewards: [...draw.cardsDrawn, ...player.cardRewards],
      rareRewards: [...draw.raresDrawn, ...player.rareRewards],
    } : player, draw, choice)
    if (selected === null) return bottomed
    const cardUid = `c${++nextUid}`
    if (cardHasGuardianSocket(selected)) gainedSockets.push({ playerId: player.id, cardUid, gemIds: offer.guardianGems ?? [] })
    return addCard(bottomed, selected, cardUid, offer.upgraded)
  })

  const rewards = state.rewards.map((offer) => offer.cardReward ? { ...offer, cardReward: false } : offer)
  let next: RunState = {
    ...state,
    players,
    rewards,
    log: [...state.log, 'The party collects its rewards.'],
  }
  const queued = new Set(gainedSockets.map((gain) => gain.playerId))
  for (const offer of state.rewards) {
    if ((offer.guardianGems?.length ?? 0) > 0 && !queued.has(offer.playerId)) {
      next = bottomGuardianGems(next, offer.guardianGems!)
    }
  }
  for (const gain of gainedSockets) {
    next = queueGuardianSocket(next, gain.playerId, gain.cardUid, 'draft', gain.gemIds.length ? gain.gemIds : undefined)
  }
  return rewards.some((offer) => offer.transformReward || offer.potion !== false ||
    (offer.relic ?? false) !== false || (offer.bossRelics ?? false) !== false)
    ? next
    : {
        ...next,
        phase: state.roomState ? 'room' : state.rewardDestination ?? 'map',
        rewards: [],
        rewardDestination: state.roomState ? state.rewardDestination : null,
      }
}

/** Resolve or skip one Transformed normal reward without exposing the next deck card. */
export function resolveTransformReward(state: RunState, playerId: string, cardUid: string | null): RunState {
  if (state.phase !== 'reward' || hasPendingRelicAcquisition(state)) return state
  const offer = state.rewards.find((candidate) => candidate.playerId === playerId && candidate.transformReward)
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (!offer || !player) return state
  const eligible = player.deck.filter((card) => !cardIsCurse(card.defId))
  if (cardUid !== null && !eligible.some((card) => card.uid === cardUid)) return state
  const owner = cardUid === null ? player : transformCard(state.rng, player, cardUid, `c${nextRunUid(state.players)}`)
  const rewards = state.rewards.map((candidate) => candidate === offer ? { ...candidate, transformReward: false } : candidate)
  const next = queueNewGuardianSockets(state,
    { ...state, players: state.players.map((candidate) => candidate.id === playerId ? owner : candidate), rewards })
  return rewards.every((candidate) => !candidate.cardReward && !candidate.transformReward && candidate.potion === false &&
    (candidate.relic ?? false) === false && (candidate.bossRelics ?? false) === false)
    ? { ...next, phase: state.rewardDestination ?? 'map', rewards: [], rewardDestination: null }
    : next
}

/** Transform draws blindly; a Ticket returns to the bottom and grants the top rare. */
export function drawTransformReward(player: Player): { player: Player; defId: string | null } {
  const [drawn, ...rest] = player.cardRewards
  if (!drawn) return { player, defId: null }
  if (drawn !== GOLDEN_TICKET) return { player: { ...player, cardRewards: rest }, defId: drawn }
  const [rare, ...rareRest] = player.rareRewards
  return {
    player: {
      ...player,
      cardRewards: [...rest, GOLDEN_TICKET],
      rareRewards: rare ? rareRest : player.rareRewards,
    },
    defId: rare ?? null,
  }
}

export function chooseRelicReward(state: RunState, playerId: string, decision: TreasureDecision): RunState {
  if (state.phase !== 'room' || (state.roomState?.kind !== 'treasure' && state.roomState?.kind !== 'elite')) return state
  if (decision === 'sapphire' && (!isActIVUnlocked(state.campaignProgress) || state.campaign.keys.sapphire)) return state
  const reward = decideRelicReward(state.roomState, playerId, decision)
  if (!reward) return state
  if (!reward.playerIds.every((id) => reward.decisions[id] !== undefined)) return { ...state, roomState: reward }
  const itemDecks = structuredClone(state.itemDecks)
  const resolved = resolveRoomRelicReward(reward, itemDecks, state.players, state.campaign.keys.sapphire,
    state.ascension)
  if (!resolved) return state
  return mirrorItemSupplies({
    ...state,
    phase: state.rewardDestination ?? 'map',
    roomState: null,
    rewardDestination: null,
    players: resolved.players,
    campaign: resolved.sapphire
      ? { ...state.campaign, keys: { ...state.campaign.keys, sapphire: true } }
      : state.campaign,
    log: [...state.log, resolved.sapphire ? 'The party claims the Sapphire Key.' : 'The relics are resolved.'],
  }, itemDecks)
}
