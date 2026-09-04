// Relics that ask a question when they arrive.
//
// Most relics are simply added. A few need the player to pick a card or a
// reward before they can be, which makes acquiring one a two-step action that
// parks its own progress on the run and resumes whatever handed it out —
// including Neow, mid-blessing.
import { finishNeowStep, nextNeowReward } from './neow.ts'
import {
  drawTransformReward,
  expandCommonReward,
  pendingRelicEligibleCards,
  pendingRewardChoices,
  reserveRevealedRewardDraws,
  acquireRelic,
} from './rewards.ts'
import { canUpgradeCard, hasRelic, nextRunUid } from './rules.ts'
import type { PendingRelicPreview, RunState } from './types.ts'
import { acquisitionCardType, addCard, bottomCardChoices, drawCardChoices, removeCard } from '../acquisition.ts'
import { CARDS, isStarterStrikeOrDefend } from '../cards.ts'
import type { Player } from '../types.ts'
import { bottomGuardianGems, cardHasGuardianSocket, queueGuardianSocket, queueNewGuardianSockets } from './guardian-gems.ts'

function commonReward(player: Player, count: number, choice: number, replaceDuplicates: boolean) {
  const draw = drawCardChoices(player, count, replaceDuplicates)
  const expanded = expandCommonReward(draw.cardsDrawn, draw.raresDrawn, replaceDuplicates)
  const rareIndex = choice >= 0 ? expanded.rareIndices[choice] ?? null : null
  const selectedIndex = choice < 0 ? null : rareIndex === null
    ? draw.choices.indexOf(draw.cardsDrawn[expanded.rawIndices[choice]!]!)
    : draw.choices.length - draw.raresDrawn.length + rareIndex
  return { draw, selected: choice >= 0 ? expanded.choices[choice] : undefined, selectedIndex }
}

/** Only the owner sees cards exposed by a pending one-shot relic. */
export function pendingRelicPreview(state: RunState, playerId: string): PendingRelicPreview | null {
  if (!Array.isArray(state.players)) return null
  const reserved = reserveRevealedRewardDraws(state, playerId)
  const player = reserved.players.find((candidate) => candidate.id === playerId)
  const pending = player?.relics.find((relic) => relic.pending)
  if (!player || !pending) return null
  if (['enchiridion', 'downfall_enchiridion', 'orrery', 'tiny_house', 'forbidden_fruit'].includes(pending.defId)) {
    return { relicId: pending.defId,
      rewardChoices: pendingRewardChoices(player, pending.defId, state.meta.ruleset === 'downfall'),
      rewardUpgraded: pending.defId === 'forbidden_fruit' ? [true, false] : undefined,
      guardianGemGroups: pending.guardianGemGroups?.map((group) => [...group]),
      rewardIndices: pending.pendingRewardIndices ? { ...pending.pendingRewardIndices } : undefined }
  }
  return { relicId: pending.defId }
}

/** Persist one owner-only Relic card reward without waiting for its siblings. */
export function choosePendingRelicReward(state: RunState, playerId: string, reward: number, choice: number): RunState {
  if (state.phase === 'combat') return state
  const before = state
  const originalPlayer = state.players.find((candidate) => candidate.id === playerId)
  const originalPending = originalPlayer?.relics.find((relic) => relic.pending)
  if (!originalPending || !Number.isInteger(reward) || !Number.isInteger(choice) ||
    reward in (originalPending.pendingRewardIndices ?? {})) return state
  state = reserveRevealedRewardDraws(state, playerId)
  const player = state.players.find((candidate) => candidate.id === playerId)!
  const pending = player.relics.find((relic) => relic.pending)!
  const choices = pendingRewardChoices(player, pending.defId, state.meta.ruleset === 'downfall')
  if (reward < 0 || reward >= choices.length || choice < -1 || choice >= choices[reward]!.length) return before
  return { ...state, players: state.players.map((candidate) => candidate.id !== playerId ? candidate : {
    ...candidate,
    relics: candidate.relics.map((relic) => relic !== pending ? relic : {
      ...relic, pendingRewardIndices: { ...relic.pendingRewardIndices, [reward]: choice },
    }),
  }) }
}

function settleRelicRewardGems(
  before: RunState,
  after: RunState,
  playerId: string,
  groups: readonly (readonly string[])[] | undefined,
  rewardChoices: readonly (readonly string[])[],
  rewardIndices: readonly number[],
): RunState {
  if (!groups) return queueNewGuardianSockets(before, after, 2)
  const oldUids = new Set(before.players.find((player) => player.id === playerId)?.deck.map((card) => card.uid) ?? [])
  const gained = after.players.find((player) => player.id === playerId)?.deck
    .filter((card) => !oldUids.has(card.uid)) ?? []
  const used = new Set<string>()
  let next = after
  for (const [index, gemIds] of groups.entries()) {
    const choice = rewardIndices[index] ?? -1
    const selected = choice >= 0 ? rewardChoices[index]?.[choice] : undefined
    const card = selected && cardHasGuardianSocket(selected)
      ? gained.find((candidate) => !used.has(candidate.uid) && candidate.defId === selected)
      : undefined
    if (card) {
      used.add(card.uid)
      next = queueGuardianSocket(next, playerId, card.uid, 'draft', gemIds)
    } else {
      next = bottomGuardianGems(next, gemIds)
    }
  }
  return next
}

/** Resolve immediate acquisition text atomically from owner-supplied choices. */
export function resolvePendingRelic(
  state: RunState,
  playerId: string,
  cardUids: readonly string[] = [],
  rewardIndices: readonly number[] = [],
): RunState {
  if (state.phase === 'combat') return state
  const before = state
  state = reserveRevealedRewardDraws(state, playerId)
  const player = state.players.find((candidate) => candidate.id === playerId)
  const pending = player?.relics.find((relic) => relic.pending)
  if (!player || !pending || new Set(cardUids).size !== cardUids.length ||
    cardUids.some((uid) => !player.deck.some((card) => card.uid === uid))) return before
  const id = pending.defId
  const printedCards = id === 'empty_cage' ? 2 : ['astrolabe', 'pandoras_box'].includes(id) ? 3
    : ['war_paint', 'whetstone', 'tiny_house'].includes(id) ? 1 : 0
  const expectedCards = Math.min(printedCards, pendingRelicEligibleCards(player, id).length)
  const expectedRewards = id === 'orrery' ? 4 : id === 'forbidden_fruit' ? 2
    : ['enchiridion', 'downfall_enchiridion', 'tiny_house'].includes(id) ? 1 : 0
  const rewardChoices = pendingRewardChoices(player, id, state.meta.ruleset === 'downfall')
  if (cardUids.length !== expectedCards || rewardIndices.length !== expectedRewards ||
    rewardIndices.some((choice, index) => !Number.isInteger(choice) || choice < -1 ||
      choice >= (rewardChoices[index]?.length ?? 0)) ||
    Object.entries(pending.pendingRewardIndices ?? {}).some(([index, choice]) => rewardIndices[Number(index)] !== choice)) return before
  const chosen = cardUids.map((uid) => player.deck.find((card) => card.uid === uid)!)
  if (id === 'war_paint' && expectedCards > 0 && acquisitionCardType(chosen[0]!.defId) !== 'skill') return before
  if (id === 'whetstone' && expectedCards > 0 && acquisitionCardType(chosen[0]!.defId) !== 'attack') return before
  if (['war_paint', 'whetstone', 'astrolabe', 'tiny_house'].includes(id) &&
    chosen.some((card) => !canUpgradeCard(card))) return before
  if (id === 'empty_cage' && chosen.some((card) => card.defId === 'ascenders_bane')) return before
  if (id === 'pandoras_box' && chosen.some((card) => CARDS[card.defId]?.type === 'curse')) return before
  const requiredStarter = id === 'war_paint'
    ? player.deck.find((card) => isStarterStrikeOrDefend(card.defId, 'Defend') && !card.upgraded)
    : id === 'whetstone' ? player.deck.find((card) => isStarterStrikeOrDefend(card.defId, 'Strike') && !card.upgraded) : undefined
  if (requiredStarter && chosen.some((card) => card.uid === requiredStarter.uid)) return before

  let owner: Player = { ...player, relics: player.relics.filter((relic) => relic !== pending) }
  if (['war_paint', 'whetstone', 'astrolabe', 'tiny_house'].includes(id)) {
    const upgrade = new Set(cardUids)
    if (id === 'war_paint') {
      const starter = owner.deck.find((card) => isStarterStrikeOrDefend(card.defId, 'Defend') && !card.upgraded)
      if (starter) upgrade.add(starter.uid)
    }
    if (id === 'whetstone') {
      const starter = owner.deck.find((card) => isStarterStrikeOrDefend(card.defId, 'Strike') && !card.upgraded)
      if (starter) upgrade.add(starter.uid)
    }
    owner = { ...owner, deck: owner.deck.map((card) => upgrade.has(card.uid) ? { ...card, upgraded: true } : card) }
  } else if (id === 'empty_cage') {
    for (const uid of cardUids) owner = removeCard(owner, uid)
  } else if (id === 'pandoras_box') {
    const remove = new Set(cardUids)
    owner = { ...owner, deck: owner.deck.filter((card) => !remove.has(card.uid)) }
    for (let index = 0; index < expectedCards; index++) {
      const draw = drawTransformReward(owner)
      owner = draw.player
      if (draw.defId) {
        owner = addCard(owner, draw.defId, `c${nextRunUid([owner])}`)
      }
    }
  }

  if (id === 'forbidden_fruit') {
    const commonChoice = rewardIndices[0]!
    const rareChoice = rewardIndices[1]!
    const common = commonReward(owner, 3, commonChoice, true)
    owner = bottomCardChoices(owner, common.draw, common.selectedIndex)
    if (common.selected) owner = addCard(owner, common.selected, `c${nextRunUid([owner])}`, true)
    const rareOffer = owner.rareRewards.slice(0, 5)
    if (rareChoice >= 0) owner = addCard(owner, rareOffer[rareChoice]!, `c${nextRunUid([owner])}`)
    owner = {
      ...owner,
      rareRewards: [...owner.rareRewards.slice(rareOffer.length), ...rareOffer.filter((_defId, index) => index !== rareChoice)],
    }
    const itemDecks = { ...state.itemDecks, curses: [...state.itemDecks.curses] }
    if (!hasRelic(owner, 'omamori')) {
      const curse = itemDecks.curses.shift()
      if (curse) owner = addCard(owner, curse, `c${nextRunUid([owner])}`)
    }
    const relicId = state.relicDeck[0]
    const relicDeck = relicId ? state.relicDeck.slice(1) : state.relicDeck
    let next: RunState = { ...state, itemDecks: { ...itemDecks, relics: [...relicDeck] }, relicDeck,
      players: state.players.map((candidate) => candidate.id === playerId ? owner : candidate) }
    next = settleRelicRewardGems(before, next, playerId, pending.guardianGemGroups,
      rewardChoices, rewardIndices)
    if (relicId) next = acquireRelic(next, playerId, relicId)
    return next
  }

  if (id === 'downfall_enchiridion') {
    const choice = rewardIndices[0]!
    const reward = commonReward(owner, 5, choice, true)
    owner = bottomCardChoices(owner, reward.draw, reward.selectedIndex)
    if (reward.selected) owner = addCard(owner, reward.selected, `c${nextRunUid(state.players)}`)
  } else if (expectedRewards > 0) {
    const rare = id === 'enchiridion'
    const gained: string[] = []
    const rareSource = [...owner.rareRewards]
    const rareBottom: string[] = []
    for (let reward = 0; reward < expectedRewards; reward++) {
      if (rare) {
        const shown = rareSource.splice(0, 5)
        const choice = rewardIndices[reward]!
        if (choice >= 0) gained.push(shown[choice]!)
        rareBottom.push(...shown.filter((_card, index) => index !== choice))
        continue
      }
      const choice = rewardIndices[reward]!
      const common = commonReward(owner, 3, choice, state.meta.ruleset === 'downfall')
      if (common.selected) gained.push(common.selected)
      owner = bottomCardChoices(owner, common.draw, common.selectedIndex)
    }
    let uid = nextRunUid(state.players)
    for (const defId of gained) {
      owner = addCard(owner, defId, `c${uid++}`)
    }
    if (rare) owner = { ...owner, rareRewards: [...rareSource, ...rareBottom] }
  }
  const draftReward = ['enchiridion', 'downfall_enchiridion', 'orrery', 'tiny_house', 'forbidden_fruit'].includes(id)
  const mutated = { ...state, players: state.players.map((candidate) => candidate.id === playerId ? owner : candidate) }
  let next = draftReward
    ? settleRelicRewardGems(before, mutated, playerId, pending.guardianGemGroups, rewardChoices, rewardIndices)
    : queueNewGuardianSockets(before, mutated)
  if (state.phase === 'neow' && state.neow?.players[playerId]?.blueOption !== null) {
    next = nextNeowReward(next, playerId)
    return finishNeowStep(next, playerId)
  }
  return next
}
