// The campfire: rest, upgrade, or whatever the party's relics turned it into.
import { canUpgradeCard, hasModifier, hasRelic, nextRunUid } from './rules.ts'
import type { CampfireDecision, RunState } from './types.ts'
import type { CardInstance, RelicInstance } from '../types.ts'
import type { RuleSet } from '../meta.ts'
import { cardIsCurse } from '../cards.ts'
import { availableTransformRewards, healingCapFor, removeCard, transformCard } from '../acquisition.ts'
import { isActIVUnlocked } from '../campaign.ts'
import { currentRoom } from '../map.ts'
import { queueNewGuardianSockets } from './guardian-gems.ts'

type CampfirePlayer = {
  dead?: boolean
  hp: number
  maxHp: number
  deck: readonly Pick<CardInstance, 'defId' | 'upgraded'>[] | null
  relics: RelicInstance[]
  cardRewards?: readonly string[]
  rareRewards?: readonly string[]
  campfireTransformAvailable?: boolean
}

export function campfireTransformAvailable(player: CampfirePlayer): boolean {
  if (player.campfireTransformAvailable !== undefined) return player.campfireTransformAvailable
  const replacement = availableTransformRewards({
    cardRewards: player.cardRewards ?? [], rareRewards: player.rareRewards ?? [],
  }) > 0
  return player.relics.some((relic) => relic.defId === 'straight_razor') && replacement &&
    (player.deck ?? []).some((card) => !cardIsCurse(card.defId))
}

export function campfireRestAvailable(player: CampfirePlayer, restAllowed: boolean, ruleset?: RuleSet): boolean {
  if (!restAllowed || player.relics.some((relic) => relic.defId === 'coffee_dripper')) return false
  const deck = player.deck ?? []
  const removable = player.relics.some((relic) => relic.defId === 'peace_pipe') &&
    deck.some((card) => card.defId !== 'ascenders_bane')
  return player.hp < healingCapFor(player, ruleset) || removable || campfireTransformAvailable(player)
}

/** Whether this seat has a real Campfire decision instead of an automatic no-op. */
export function campfireNeedsDecision(
  player: CampfirePlayer,
  rubyAvailable: boolean,
  restAllowed: boolean,
  ruleset?: RuleSet,
): boolean {
  if (player.dead) return false
  const smith = !player.relics.some((relic) => relic.defId === 'fusion_hammer') &&
    player.deck?.some(canUpgradeCard) === true
  return rubyAvailable || campfireRestAvailable(player, restAllowed, ruleset) || smith
}

/**
 * A campfire: each player chooses Rest (heal 3) or Smith (upgrade a card),
 * independently (p.9). Choices arrive per player so one message carries the
 * whole room, the same way a card play carries its choices.
 *
 * Returns the SAME state reference if this is not a campfire.
 */
export function resolveCampfire(
  state: RunState,
  choices: Record<string, CampfireDecision>,
): RunState {
  if (state.phase !== 'room') return state
  if (currentRoom(state.map)?.kind !== 'campfire') return state

  const live = state.players.filter((player) => !player.dead)
  const rubyAvailable = isActIVUnlocked(state.campaignProgress) && !state.campaign.keys.ruby
  if (hasModifier(state, 'night_terrors') && live.some((player) => choices[player.id]?.choice === 'rest')) return state
  const ruby = rubyAvailable && live.length > 0
    && live.every((player) => choices[player.id]?.choice === 'ruby')
  if (live.some((player) => {
    const decision = choices[player.id]
    if (!decision?.transformCardUid) return false
    const target = player.deck.find((card) => card.uid === decision.transformCardUid)
    return decision.choice !== 'rest' || !hasRelic(player, 'straight_razor') || !target ||
      target.uid === decision.removeCardUid || cardIsCurse(target.defId) ||
      !campfireTransformAvailable(player)
  })) return state

  let uid = nextRunUid(state.players)
  const players = state.players.map((player) => {
    const decision = choices[player.id]
    if (!decision || player.dead) return player
    if (decision.choice === 'leave') return player

    if (decision.choice === 'ruby') return player
    if (decision.choice === 'rest') {
      if (hasRelic(player, 'coffee_dripper')) return player
      const removable = hasRelic(player, 'peace_pipe') && decision.removeCardUid
        ? player.deck.find((card) => card.uid === decision.removeCardUid)
        : undefined
      const rested = removable ? removeCard(player, removable.uid) : player
      const transformed = decision.transformCardUid
        ? transformCard(state.rng, rested, decision.transformCardUid, `c${uid++}`) : rested
      const healed = Math.min(transformed.maxHp, transformed.hp + 3 + (hasRelic(transformed, 'regal_pillow') ? 3 : 0))
      return {
        ...transformed,
        hp: Math.min(healingCapFor(transformed, state.meta.ruleset), healed),
      }
    }

    if (hasRelic(player, 'fusion_hammer')) return player

    // Smith upgrades one card in the deck. An already-upgraded card cannot be
    // upgraded again, so naming one is simply ignored.
    const target = player.deck.find(
      (card) => card.uid === decision.cardUid && canUpgradeCard(card),
    )
    if (!target) return player
    return {
      ...player,
      deck: player.deck.map((card) =>
        card.uid === target.uid ? { ...card, upgraded: true } : card,
      ),
    }
  })

  return queueNewGuardianSockets(state, {
    ...state,
    phase: 'map',
    players,
    campaign: ruby ? { ...state.campaign, keys: { ...state.campaign.keys, ruby: true } } : state.campaign,
    log: [...state.log, ruby ? 'The party claims the Ruby Key.' : 'The party rests at a campfire.'],
  })
}
