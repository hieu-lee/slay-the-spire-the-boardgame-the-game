import { attachGuardianGem, GUARDIAN_CARDS_BY_ID } from '../downfall/guardian.ts'
import { cardHasGuardianSocket, drawGuardianGemChoices } from '../guardian-gems.ts'
import { resumeNeow } from './neow.ts'
import type { RunState } from './types.ts'

/** Attach one revealed transparent Gem and bottom every unpicked reveal. */
export function resolveGuardianSocket(state: RunState, playerId: string, cardUid: string, gemId: string): RunState {
  const pendingIndex = state.pendingGuardianSockets?.findIndex((choice) =>
    choice.playerId === playerId && choice.cardUid === cardUid) ?? -1
  const pending = state.pendingGuardianSockets?.[pendingIndex]
  const player = state.players.find((candidate) => candidate.id === playerId)
  const card = player?.deck.find((candidate) => candidate.uid === pending?.cardUid)
  const definition = card && GUARDIAN_CARDS_BY_ID[card.defId]
  if (!pending || pending.playerId !== playerId || !pending.gemIds.includes(gemId) || !player || !card ||
    !definition?.socket) return state
  const attached = attachGuardianGem(card, definition ?? { socket: false }, gemId)
  let guardianGemDeck = [...(state.guardianGemDeck ?? []), ...pending.gemIds.filter((id) => id !== gemId)]
  let roomState = state.roomState
  if (pending.source === 'merchant' && roomState?.kind === 'merchant' &&
    (roomState.socketCardsBought?.[playerId] ?? 0) < 2 &&
    roomState.cards[playerId]?.choices.some((id) => cardHasGuardianSocket(id))) {
    const revealed = drawGuardianGemChoices(guardianGemDeck, 2)
    roomState = { ...roomState, guardianGems: { ...roomState.guardianGems, [playerId]: revealed } }
  }
  return resumeNeow({
    ...state,
    players: state.players.map((candidate) => candidate.id !== playerId ? candidate : {
      ...candidate,
      deck: candidate.deck.map((held) => held.uid === card.uid ? attached : held),
    }),
    guardianGemDeck,
    roomState,
    pendingGuardianSockets: state.pendingGuardianSockets.filter((_choice, index) => index !== pendingIndex),
    log: [...state.log, `${player.name} sockets ${gemId.replace(/^guardian_/, '')}.`],
  })
}

/** Disconnect fallback: the top revealed Gem is a deterministic legal choice. */
export function abandonGuardianSocket(state: RunState, playerId: string): RunState {
  const pending = state.pendingGuardianSockets?.find((choice) => choice.playerId === playerId)
  return pending?.gemIds[0]
    ? resolveGuardianSocket(state, playerId, pending.cardUid, pending.gemIds[0])
    : state
}
