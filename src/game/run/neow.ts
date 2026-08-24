// Neow's blessing, before the first room.
//
// One seat at a time: a card is dealt, its reward revealed, and the choice
// resolved, then the run moves to the next seat. The step is resumable because
// the reward may hand out a relic that asks its own question.
import {
  acquireRelic,
  canGainPotion,
  neowRewardSources,
  potionLimitFor,
  reservePrismaticDraws,
  settlePrismaticDraws,
} from './rewards.ts'
import {
  GOLDEN_TICKET,
  canUpgradeCard,
  hasModifier,
  hasPendingRelicAcquisition,
  hasRelic,
  nextRunUid,
} from './rules.ts'
import { mirrorLegacySupplies } from './supplies.ts'
import type { PotionRewardDecision, RewardSource, RunState } from './types.ts'
import {
  addCard,
  bottomCardChoices,
  drawCardChoices,
  gainGold,
  removeCard,
  transformCard,
  upgradeCard,
} from '../acquisition.ts'
import { CARDS } from '../cards.ts'
import { neowCard } from '../neow.ts'
import type { NeowDecision, NeowImmediateReward, NeowQueuedEffect, NeowRewardKind, NeowRewardOffer } from '../neow.ts'
import { createRelicInstance } from '../relics.ts'
import { pickMany } from '../rng.ts'
import type { CardInstance, Player } from '../types.ts'

function neowCardOffer(player: Player, kind: 'card' | 'rare'): NeowRewardOffer {
  if (kind === 'card') return { kind, ...drawCardChoices(player) }
  const cardsDrawn = player.rareRewards.slice(0, 3)
  return { kind, choices: [...cardsDrawn], cardsDrawn, raresDrawn: [] }
}

export function nextNeowReward(state: RunState, playerId: string): RunState {
  let next = state
  while (true) {
    const progress = next.neow?.players[playerId]
    if (!next.neow || !progress || progress.pendingEffect || progress.rewardKind || progress.reward ||
      hasPendingRelicAcquisition(next) || progress.rewardQueue.length === 0) return next
    const [kind, ...rewardQueue] = progress.rewardQueue
    if (!kind) return next
    if (typeof kind === 'string') return {
      ...next,
      neow: {
        ...next.neow,
        players: { ...next.neow.players, [playerId]: { ...progress, rewardKind: kind, reward: null, rewardQueue } },
      },
    }
    if (['upgrade', 'remove', 'transform', 'gold', 'randomRare'].includes(kind.kind)) return {
      ...next,
      neow: {
        ...next.neow,
        players: { ...next.neow.players, [playerId]: { ...progress, pendingEffect: kind as NeowImmediateReward, rewardQueue } },
      },
    }
    const owner = next.players.find((candidate) => candidate.id === playerId)
    const curse = kind.kind === 'curse' && owner && !owner.relics.some((relic) => relic.defId === 'omamori')
      ? next.itemDecks.curses[0] : undefined
    const hp = owner && kind.kind === 'loseHp' ? Math.max(0, owner.hp - kind.amount) : undefined
    next = {
      ...next,
      players: next.players.map((candidate) => candidate.id !== playerId ? candidate
        : curse ? addCard(candidate, curse, `c${nextRunUid(next.players)}`)
          : kind.kind === 'loseGold' ? { ...candidate, gold: Math.max(0, candidate.gold - kind.amount) }
            : hp === undefined ? candidate : { ...candidate, hp, dead: hp === 0 }),
      itemDecks: curse ? { ...next.itemDecks, curses: next.itemDecks.curses.slice(1) } : next.itemDecks,
      neow: {
        ...next.neow,
        players: { ...next.neow.players, [playerId]: { ...progress, rewardQueue } },
      },
    }
    if (hp === 0) return { ...next, phase: 'defeat', neow: null }
  }
}

function finishNeowIfReady(state: RunState): RunState {
  if (!state.neow || !Object.values(state.neow.players).every((progress) => progress.done) || hasPendingRelicAcquisition(state)) return state
  const solo = state.players.length === 1
  return {
    ...state,
    phase: state.setup ? 'setup' : 'map',
    neow: null,
    players: solo ? state.players.map((player) => ({
      ...player,
      gold: player.gold + 2,
      relics: player.relics.some((relic) => relic.defId === 'loaded_die')
        ? player.relics : [...player.relics, createRelicInstance('loaded_die')],
    })) : state.players,
    log: [...state.log, 'Neow puts the Blessing deck away.'],
  }
}

function completeNeowPlayer(state: RunState, playerId: string): RunState {
  const progress = state.neow?.players[playerId]
  if (!state.neow || !progress) return state
  return finishNeowIfReady({
    ...state,
    neow: { ...state.neow, players: { ...state.neow.players, [playerId]: { ...progress, done: true } } },
  })
}

export function finishNeowStep(state: RunState, playerId: string): RunState {
  const progress = state.neow?.players[playerId]
  return progress?.pendingEffect || progress?.rewardKind || progress?.rewardQueue.length || hasPendingRelicAcquisition(state)
    ? state : completeNeowPlayer(state, playerId)
}

function availableTransformRewards(player: Pick<Player, 'cardRewards' | 'rareRewards'>): number {
  return player.cardRewards.filter((id) => id !== GOLDEN_TICKET).length +
    Math.min(player.cardRewards.filter((id) => id === GOLDEN_TICKET).length, player.rareRewards.length)
}

/** Public, authoritative Neow state. The remaining face-down deck is intentionally omitted. */
export function neowPreview(state: RunState, playerId: string): {
  card: ReturnType<typeof neowCard>
  redGoldPending: boolean
  redRewardPending: boolean
  redReward: NeowRewardOffer | null
  blueOption: number | null
  pendingEffect: NeowImmediateReward | null
  rewardKind: NeowRewardKind | null
  reward: NeowRewardOffer | null
  availableSources: RewardSource[]
  prismatic: boolean
  done: boolean
} | null {
  const progress = state.phase === 'neow' ? state.neow?.players[playerId] : undefined
  if (!progress) return null
  const player = state.players.find((candidate) => candidate.id === playerId)
  const rewardKind = progress.redRewardPending ? 'card' : progress.rewardKind
  return {
    card: neowCard(progress.cardId),
    redGoldPending: progress.redGoldPending,
    redRewardPending: progress.redRewardPending,
    redReward: structuredClone(progress.redReward),
    blueOption: progress.blueOption,
    pendingEffect: structuredClone(progress.pendingEffect),
    rewardKind: progress.rewardKind,
    reward: structuredClone(progress.reward),
    availableSources: neowRewardSources(state, playerId),
    prismatic: Boolean(player && hasRelic(player, 'prismatic_shard') && !hasModifier(state, 'transformed') &&
      (rewardKind === 'card' || rewardKind === 'rare')),
    done: progress.done,
  }
}

/** Gain or skip the independent Gold part of Neow's red reward. */
export function resolveNeowGold(state: RunState, playerId: string, gain: boolean): RunState {
  const progress = state.neow?.players[playerId]
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (state.phase !== 'neow' || !state.neow || !progress?.redGoldPending || !player ||
    progress.redReward || progress.done || hasPendingRelicAcquisition(state)) return state
  return {
    ...state,
    players: gain ? state.players.map((candidate) => candidate.id === playerId ? gainGold(candidate, 3) : candidate) : state.players,
    neow: { ...state.neow, players: { ...state.neow.players, [playerId]: { ...progress, redGoldPending: false } } },
  }
}

/** Reveal the current face-down reward. Merely staging it never advances a physical deck. */
export function revealNeowReward(state: RunState, playerId: string, sources: readonly RewardSource[] = []): RunState {
  const neow = state.neow
  const progress = neow?.players[playerId]
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (state.phase !== 'neow' || !neow || !progress || !player || progress.done ||
    progress.redGoldPending || hasPendingRelicAcquisition(state) || progress.redReward || progress.reward) return state
  const kind = progress.redRewardPending ? 'card' : progress.rewardKind
  if (!kind) return state
  if (kind === 'card' && hasModifier(state, 'transformed')) return {
    ...state,
    neow: { ...neow, players: { ...neow.players, [playerId]: {
      ...progress, pendingEffect: { kind: 'transform', count: 1 }, rewardKind: progress.redRewardPending ? progress.rewardKind : null,
    } } },
  }
  let itemDecks = state.itemDecks
  let potionDeck = state.potionDeck
  let relicDeck = state.relicDeck
  let offer: NeowRewardOffer
  if (kind === 'colorless') {
    const choices = state.itemDecks.colorless.slice(0, 3)
    itemDecks = { ...state.itemDecks, colorless: state.itemDecks.colorless.slice(choices.length) }
    offer = { kind, choices, cardsDrawn: [...choices], raresDrawn: [] }
  } else if (kind === 'potion') {
    const potionId = state.potionDeck[0]
    potionDeck = potionId ? state.potionDeck.slice(1) : state.potionDeck
    itemDecks = { ...state.itemDecks, potions: [...potionDeck] }
    offer = { kind, choices: potionId ? [potionId] : [], cardsDrawn: potionId ? [potionId] : [], raresDrawn: [] }
  } else if (kind === 'relic') {
    const relicId = state.relicDeck[0]
    relicDeck = relicId ? state.relicDeck.slice(1) : state.relicDeck
    itemDecks = { ...state.itemDecks, relics: [...relicDeck] }
    offer = { kind, choices: relicId ? [relicId] : [], cardsDrawn: relicId ? [relicId] : [], raresDrawn: [] }
  } else if (hasRelic(player, 'prismatic_shard')) {
    const available = neowRewardSources(state, playerId)
    if (sources.length !== 3 || new Set(sources).size !== 3 || sources.some((source) => !available.includes(source))) return state
    const reserved = reservePrismaticDraws(state, sources, kind === 'rare')
    state = reserved.state
    itemDecks = state.itemDecks
    offer = { kind, choices: reserved.choices, cardsDrawn: reserved.choices, raresDrawn: [], prismaticDraws: reserved.draws }
  } else offer = neowCardOffer(player, kind)
  return {
    ...state,
    itemDecks,
    potionDeck,
    relicDeck,
    neow: {
      ...neow,
      players: { ...neow.players, [playerId]: progress.redRewardPending
        ? { ...progress, redReward: offer }
        : { ...progress, reward: offer } },
    },
  }
}

/** Resolve the red Card Reward, or the currently staged blue reward. */
export function resolveNeowReward(
  state: RunState,
  playerId: string,
  choice: number | null | PotionRewardDecision,
): RunState {
  const neow = state.neow
  const progress = neow?.players[playerId]
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (state.phase !== 'neow' || !neow || !progress || !player || progress.redGoldPending || progress.done || hasPendingRelicAcquisition(state)) return state
  const red = progress.redRewardPending
  const offer = red ? progress.redReward : progress.reward
  const kind = red ? 'card' : progress.rewardKind
  if (!kind) return state
  if (!offer) {
    if (choice !== null) return state
    let next: RunState = {
      ...state,
      neow: { ...neow, players: { ...neow.players, [playerId]: red
        ? { ...progress, redRewardPending: false }
        : { ...progress, rewardKind: null } } },
    }
    if (red) return next
    next = nextNeowReward(next, playerId)
    return finishNeowStep(next, playerId)
  }
  if (offer.kind === 'potion') {
    if (typeof choice !== 'object' || choice === null) return state
    const potionId = offer.choices[0]
    let players = state.players
    let returned: string[] = []
    if (potionId) {
      const limit = potionLimitFor(state.ascension)
      let recipient = player
      if (choice.kind === 'skip') returned = [potionId]
      else if (choice.kind === 'pass') {
        const target = state.players.find((candidate) => candidate.id === choice.playerId)
        if (!target || target.dead || target.id === playerId || !canGainPotion(target, limit)) return state
        recipient = target
      } else if (choice.kind === 'replace') {
        const held = player.potions.indexOf(choice.potionId)
        if (held < 0 || player.relics.some((relic) => relic.defId === 'sozu')) return state
        returned = [choice.potionId]
      } else if (!canGainPotion(player, limit)) return state
      if (choice.kind !== 'skip') players = state.players.map((candidate) => candidate.id !== recipient.id ? candidate : {
        ...candidate,
        potions: choice.kind === 'replace'
          ? [...candidate.potions.filter((_id, index) => index !== candidate.potions.indexOf(choice.potionId)), potionId]
          : [...candidate.potions, potionId],
      })
    }
    let next: RunState = mirrorLegacySupplies({
      ...state,
      players,
      potionDeck: [...state.potionDeck, ...returned],
      neow: { ...neow, players: { ...neow.players, [playerId]: { ...progress, rewardKind: null, reward: null } } },
    })
    next = nextNeowReward(next, playerId)
    return finishNeowStep(next, playerId)
  }
  if (choice !== null && (typeof choice === 'object' || !Number.isInteger(choice) || choice < 0 || choice >= offer.choices.length)) return state
  let owner = player
  if (offer.prismaticDraws) {
    const settled = settlePrismaticDraws(state, offer.kind === 'rare', offer.prismaticDraws, offer.choices, choice)
    state = settled.state
    owner = state.players.find((candidate) => candidate.id === playerId) ?? owner
    if (settled.selectedId) owner = addCard(owner, settled.selectedId, `c${nextRunUid(state.players)}`)
  } else if (offer.kind === 'card') {
    const draw = { choices: offer.choices, cardsDrawn: offer.cardsDrawn, raresDrawn: offer.raresDrawn }
    owner = bottomCardChoices(owner, draw, choice)
  } else if (offer.kind === 'rare') {
    owner = { ...owner, rareRewards: [...owner.rareRewards.slice(offer.cardsDrawn.length),
      ...offer.cardsDrawn.filter((_id, index) => index !== choice)] }
  } else if (offer.kind === 'colorless') {
    const selected = choice === null ? undefined : offer.choices[choice]
    const unused = offer.choices.filter((_id, index) => index !== choice)
    owner = selected ? addCard(owner, selected, `c${nextRunUid(state.players)}`) : owner
    const itemDecks = { ...state.itemDecks, colorless: [...state.itemDecks.colorless, ...unused] }
    state = { ...state, itemDecks }
  } else {
    const relicId = choice === null ? undefined : offer.choices[choice]
    if (choice === null) {
      state = mirrorLegacySupplies({ ...state, relicDeck: [...state.relicDeck, ...offer.cardsDrawn] })
    } else if (relicId) state = acquireRelic(state, playerId, relicId)
    owner = state.players.find((candidate) => candidate.id === playerId) ?? owner
  }
  const selected = choice === null ? undefined : offer.choices[choice]
  if (!offer.prismaticDraws && selected && (offer.kind === 'card' || offer.kind === 'rare')) owner = addCard(owner, selected, `c${nextRunUid(state.players)}`)
  let next: RunState = {
    ...state,
    players: state.players.map((candidate) => candidate.id === playerId ? owner : candidate),
    neow: {
      ...neow,
      players: { ...neow.players, [playerId]: red
        ? { ...progress, redRewardPending: false, redReward: null }
        : { ...progress, rewardKind: null, reward: null } },
    },
  }
  if (red) return next
  next = nextNeowReward(next, playerId)
  return finishNeowStep(next, playerId)
}

function neowEffectCards(player: Player, effect: NeowImmediateReward): { eligible: CardInstance[]; required: number } {
  if (!['upgrade', 'remove', 'transform'].includes(effect.kind)) return { eligible: [], required: 0 }
  const eligible = effect.kind === 'upgrade' ? player.deck.filter(canUpgradeCard)
    : effect.kind === 'remove' ? player.deck.filter((card) => card.defId !== 'ascenders_bane')
      : player.deck.filter((card) => CARDS[card.defId]?.owner !== 'curse')
  const supply = effect.kind === 'transform' ? availableTransformRewards(player) : Number.POSITIVE_INFINITY
  return { eligible, required: Math.min('count' in effect ? effect.count : 0, eligible.length, supply) }
}

/** Resolve or independently skip the current immediate positive Neow reward. */
export function resolveNeowEffect(
  state: RunState,
  playerId: string,
  gain: boolean,
  decision: NeowDecision = {},
): RunState {
  const progress = state.neow?.players[playerId]
  const player = state.players.find((candidate) => candidate.id === playerId)
  const effect = progress?.pendingEffect
  if (state.phase !== 'neow' || !state.neow || !progress || !player || !effect || progress.done || hasPendingRelicAcquisition(state)) return state
  const cardUids = decision.cardUids ?? []
  const selection = neowEffectCards(player, effect)
  if (!gain) {
    if (cardUids.length > 0) return state
  } else if (effect.kind === 'upgrade' && effect.random) {
    if (cardUids.length > 0) return state
  } else if (new Set(cardUids).size !== cardUids.length || cardUids.length !== selection.required ||
    cardUids.some((uid) => !selection.eligible.some((card) => card.uid === uid))) return state

  const rng = { ...state.rng }
  let owner = player
  let uid = nextRunUid(state.players)
  if (gain) {
    if (effect.kind === 'upgrade') {
      const chosen = effect.random ? pickMany(rng, selection.eligible, selection.required).map((card) => card.uid) : cardUids
      for (const cardUid of chosen) owner = upgradeCard(owner, cardUid)
    } else if (effect.kind === 'remove') {
      for (const cardUid of cardUids) owner = removeCard(owner, cardUid)
    } else if (effect.kind === 'transform') {
      for (const cardUid of cardUids) owner = transformCard(rng, owner, cardUid, `c${uid++}`)
    } else if (effect.kind === 'gold') owner = gainGold(owner, effect.amount)
    else {
      const [rare, ...rareRewards] = owner.rareRewards
      if (rare) owner = addCard({ ...owner, rareRewards }, rare, `c${uid++}`)
    }
  }
  const transformedRed = progress.redRewardPending
  let next: RunState = {
    ...state,
    rng,
    players: state.players.map((candidate) => candidate.id === playerId ? owner : candidate),
    neow: { ...state.neow, players: { ...state.neow.players, [playerId]: {
      ...progress, pendingEffect: null, redRewardPending: transformedRed ? false : progress.redRewardPending,
    } } },
  }
  if (transformedRed) return next
  next = nextNeowReward(next, playerId)
  return finishNeowStep(next, playerId)
}

/** Choose one printed blue option; clients supply selections, never effects. */
export function chooseNeow(
  state: RunState,
  playerId: string,
  optionIndex: number,
  decision: NeowDecision = {},
): RunState {
  const progress = state.neow?.players[playerId]
  const player = state.players.find((candidate) => candidate.id === playerId)
  const card = progress ? neowCard(progress.cardId) : undefined
  const option = card?.options[optionIndex]
  if (state.phase !== 'neow' || !state.neow || !progress || !player || progress.redGoldPending || progress.redRewardPending ||
    progress.pendingEffect || progress.rewardKind || progress.blueOption !== null ||
    progress.done || hasPendingRelicAcquisition(state) || !Number.isInteger(optionIndex) || !option) return state
  const cardUids = decision.cardUids ?? []
  if (cardUids.length > 0) return state
  let next: RunState = state
  let queue: NeowQueuedEffect[] = []
  for (const effect of option.effects) {
    if (effect.kind === 'reward') queue.push(...Array(effect.count).fill(effect.reward))
    else if (effect.kind === 'potions') queue.push(...Array(effect.count).fill('potion' as const))
    else if (effect.kind === 'relic') queue.push('relic')
    else queue.push(effect)
  }
  next = {
    ...next,
    neow: { ...state.neow, players: { ...state.neow.players, [playerId]: { ...progress, blueOption: optionIndex, pendingEffect: null, rewardKind: null, rewardQueue: queue } } },
  }
  next = nextNeowReward(next, playerId)
  return finishNeowStep(next, playerId)
}
