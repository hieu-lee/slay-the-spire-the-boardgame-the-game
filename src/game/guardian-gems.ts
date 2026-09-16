import { CARDS } from './cards.ts'
import { GUARDIAN_CARDS_BY_ID } from './downfall/guardian.ts'
import type { RunState } from './run/types.ts'

export function cardHasGuardianSocket(defId: string): boolean {
  return CARDS[defId]?.guardian?.socket === true
}

/** Draw distinct face-up Gems, bottoming duplicate copies as they are revealed. */
export function drawGuardianGemChoices(deck: string[], count: number): string[] {
  const choices: string[] = []
  const duplicates: string[] = []
  const available = deck.length
  for (let seen = 0; seen < available && choices.length < count; seen++) {
    const gem = deck.shift()!
    if (choices.includes(gem)) duplicates.push(gem)
    else choices.push(gem)
  }
  deck.push(...duplicates)
  return choices
}

/** Reveal from the authoritative supply only when this face-up group contains Socket. */
export function revealGuardianDraftGems(
  state: RunState,
  defIds: readonly string[],
): { state: RunState; gemIds: string[] } {
  if (!defIds.some(cardHasGuardianSocket)) return { state, gemIds: [] }
  const guardianGemDeck = [...(state.guardianGemDeck ?? [])]
  const gemIds = drawGuardianGemChoices(guardianGemDeck, 2)
  return { state: { ...state, guardianGemDeck }, gemIds }
}

/** Queue the mandatory Gem attachment after a Socket card enters the master deck. */
export function queueGuardianSocket(
  state: RunState,
  playerId: string,
  cardUid: string,
  source: 'draft' | 'merchant' | 'gain',
  revealed?: readonly string[],
): RunState {
  const player = state.players.find((candidate) => candidate.id === playerId)
  const card = player?.deck.find((candidate) => candidate.uid === cardUid)
  const definition = card && GUARDIAN_CARDS_BY_ID[card.defId]
  if (!player || !card || card.attachedGemId || !definition?.socket) return state
  const guardianGemDeck = [...(state.guardianGemDeck ?? [])]
  const gemIds = revealed ? [...revealed] : drawGuardianGemChoices(guardianGemDeck, 1)
  if (gemIds.length === 0) return state
  return {
    ...state,
    guardianGemDeck: revealed ? state.guardianGemDeck : guardianGemDeck,
    pendingGuardianSockets: [...(state.pendingGuardianSockets ?? []), { playerId, cardUid, gemIds, source }],
  }
}

export function bottomGuardianGems(state: RunState, gemIds: readonly string[]): RunState {
  return gemIds.length === 0 ? state : { ...state, guardianGemDeck: [...(state.guardianGemDeck ?? []), ...gemIds] }
}

/** Reconcile direct/random/Transform gains after an existing player mutation. */
export function queueNewGuardianSockets(
  before: RunState,
  after: RunState,
  revealCount = 1,
  revealedGroups?: readonly (readonly string[])[],
): RunState {
  let next = after
  let revealedIndex = 0
  for (const player of after.players) {
    const oldCards = new Map(before.players.find((candidate) => candidate.id === player.id)?.deck
      .map((card) => [card.uid, card]) ?? [])
    for (const card of player.deck) {
      const old = oldCards.get(card.uid)
      if ((!old || old.defId !== card.defId || old.upgraded !== card.upgraded ||
        old.attachedGemId !== card.attachedGemId) && !card.attachedGemId &&
        cardHasGuardianSocket(card.defId)) {
        const revealed = revealedGroups?.[revealedIndex++]
        if (revealed) next = queueGuardianSocket(next, player.id, card.uid, 'draft', revealed)
        else if (revealCount === 1) next = queueGuardianSocket(next, player.id, card.uid, 'gain')
        else {
          const guardianGemDeck = [...(next.guardianGemDeck ?? [])]
          const gemIds = drawGuardianGemChoices(guardianGemDeck, revealCount)
          next = queueGuardianSocket({ ...next, guardianGemDeck },
            player.id, card.uid, 'draft', gemIds)
        }
      }
    }
  }
  return next
}
