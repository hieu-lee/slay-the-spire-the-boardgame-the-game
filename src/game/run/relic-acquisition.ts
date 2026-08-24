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
} from './rewards.ts'
import { GOLDEN_TICKET, canUpgradeCard, nextRunUid } from './rules.ts'
import type { PendingRelicPreview, RunState } from './types.ts'
import { addCard, removeCard } from '../acquisition.ts'
import { CARDS } from '../cards.ts'
import type { Player } from '../types.ts'

/** Only the owner sees cards exposed by a pending one-shot relic. */
export function pendingRelicPreview(state: RunState, playerId: string): PendingRelicPreview | null {
  if (!Array.isArray(state.players)) return null
  const reserved = reserveRevealedRewardDraws(state, playerId)
  const player = reserved.players.find((candidate) => candidate.id === playerId)
  const pending = player?.relics.find((relic) => relic.pending)
  if (!player || !pending) return null
  if (['enchiridion', 'orrery', 'tiny_house'].includes(pending.defId)) {
    return { relicId: pending.defId, rewardChoices: pendingRewardChoices(player, pending.defId) }
  }
  return { relicId: pending.defId }
}

/** Resolve immediate acquisition text atomically from owner-supplied choices. */
export function resolvePendingRelic(
  state: RunState,
  playerId: string,
  cardUids: readonly string[] = [],
  rewardIndices: readonly number[] = [],
): RunState {
  if (state.phase === 'combat') return state
  state = reserveRevealedRewardDraws(state, playerId)
  const player = state.players.find((candidate) => candidate.id === playerId)
  const pending = player?.relics.find((relic) => relic.pending)
  if (!player || !pending || new Set(cardUids).size !== cardUids.length ||
    cardUids.some((uid) => !player.deck.some((card) => card.uid === uid))) return state
  const id = pending.defId
  const printedCards = id === 'empty_cage' ? 2 : ['astrolabe', 'pandoras_box'].includes(id) ? 3
    : ['war_paint', 'whetstone', 'tiny_house'].includes(id) ? 1 : 0
  const expectedCards = Math.min(printedCards, pendingRelicEligibleCards(player, id).length)
  const expectedRewards = id === 'orrery' ? 4 : ['enchiridion', 'tiny_house'].includes(id) ? 1 : 0
  const rewardChoices = pendingRewardChoices(player, id)
  if (cardUids.length !== expectedCards || rewardIndices.length !== expectedRewards ||
    rewardIndices.some((choice, index) => !Number.isInteger(choice) || choice < -1 ||
      choice >= (rewardChoices[index]?.length ?? 0))) return state
  const chosen = cardUids.map((uid) => player.deck.find((card) => card.uid === uid)!)
  if (id === 'war_paint' && expectedCards > 0 && CARDS[chosen[0]!.defId]?.type !== 'skill') return state
  if (id === 'whetstone' && expectedCards > 0 && CARDS[chosen[0]!.defId]?.type !== 'attack') return state
  if (['war_paint', 'whetstone', 'astrolabe', 'tiny_house'].includes(id) &&
    chosen.some((card) => !canUpgradeCard(card))) return state
  if (id === 'empty_cage' && chosen.some((card) => card.defId === 'ascenders_bane')) return state
  if (id === 'pandoras_box' && chosen.some((card) => CARDS[card.defId]?.type === 'curse')) return state
  const requiredStarter = id === 'war_paint'
    ? player.deck.find((card) => card.defId.startsWith('defend_') && !card.upgraded)
    : id === 'whetstone' ? player.deck.find((card) => card.defId.startsWith('strike_') && !card.upgraded) : undefined
  if (requiredStarter && chosen.some((card) => card.uid === requiredStarter.uid)) return state

  let owner: Player = { ...player, relics: player.relics.filter((relic) => relic !== pending) }
  if (['war_paint', 'whetstone', 'astrolabe', 'tiny_house'].includes(id)) {
    const upgrade = new Set(cardUids)
    if (id === 'war_paint') {
      const starter = owner.deck.find((card) => card.defId.startsWith('defend_') && !card.upgraded)
      if (starter) upgrade.add(starter.uid)
    }
    if (id === 'whetstone') {
      const starter = owner.deck.find((card) => card.defId.startsWith('strike_') && !card.upgraded)
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

  if (expectedRewards > 0) {
    const rare = id === 'enchiridion'
    const gained: string[] = []
    const commonSource = [...owner.cardRewards]
    const rareSource = [...owner.rareRewards]
    const commonBottom: string[] = []
    const rareBottom: string[] = []
    for (let reward = 0; reward < expectedRewards; reward++) {
      if (rare) {
        const shown = rareSource.splice(0, 5)
        const choice = rewardIndices[reward]!
        if (choice >= 0) gained.push(shown[choice]!)
        rareBottom.push(...shown.filter((_card, index) => index !== choice))
        continue
      }
      const raw = commonSource.splice(0, 3)
      const expanded = expandCommonReward(raw, rareSource)
      const choice = rewardIndices[reward]!
      if (choice >= 0) gained.push(expanded.choices[choice]!)
      const selectedRaw = choice >= 0 ? expanded.rawIndices[choice] : -1
      raw.forEach((defId, index) => {
        if (defId === GOLDEN_TICKET) commonBottom.push(defId)
        else if (index !== selectedRaw) commonBottom.push(defId)
      })
      const selectedRare = choice >= 0 ? expanded.rareIndices[choice] : null
      const revealedRare = rareSource.splice(0, expanded.rareCount)
      rareBottom.push(...revealedRare.filter((_defId, index) => index !== selectedRare))
    }
    let uid = nextRunUid(state.players)
    for (const defId of gained) {
      owner = addCard(owner, defId, `c${uid++}`)
    }
    owner = {
      ...owner,
      cardRewards: rare ? owner.cardRewards : [...commonSource, ...commonBottom],
      rareRewards: [...rareSource, ...rareBottom],
    }
  }
  let next = { ...state, players: state.players.map((candidate) => candidate.id === playerId ? owner : candidate) }
  if (state.phase === 'neow' && state.neow?.players[playerId]?.blueOption !== null) {
    next = nextNeowReward(next, playerId)
    return finishNeowStep(next, playerId)
  }
  return next
}
