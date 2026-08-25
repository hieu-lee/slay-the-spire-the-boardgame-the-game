// The campfire: rest, upgrade, or whatever the party's relics turned it into.
import { canUpgradeCard, hasModifier, hasRelic } from './rules.ts'
import type { CampfireDecision, RunState } from './types.ts'
import { healingCapFor, removeCard } from '../acquisition.ts'
import { isActIVUnlocked } from '../campaign.ts'
import { currentRoom } from '../map.ts'

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
  if (hasModifier(state, 'night_terrors') && live.some((player) => choices[player.id]?.choice === 'rest')) return state
  const ruby = isActIVUnlocked(state.campaignProgress) && !state.campaign.keys.ruby && live.length > 0
    && live.every((player) => choices[player.id]?.choice === 'ruby')

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
      const healed = Math.min(rested.maxHp, rested.hp + 3 + (hasRelic(rested, 'regal_pillow') ? 3 : 0))
      return {
        ...rested,
        hp: Math.min(healingCapFor(rested), healed),
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

  return {
    ...state,
    phase: 'map',
    players,
    campaign: ruby ? { ...state.campaign, keys: { ...state.campaign.keys, ruby: true } } : state.campaign,
    log: [...state.log, ruby ? 'The party claims the Ruby Key.' : 'The party rests at a campfire.'],
  }
}
