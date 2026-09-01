// The merchant: buying, removing a card, and the Courier's offer.
import { finishQuickSetup } from './quick-setup.ts'
import { mirrorItemSupplies } from './supplies.ts'
import type { RunState } from './types.ts'
import { drawItems } from '../acquisition.ts'
import { currentQuickSetupStep } from '../meta.ts'
import { buyFromMerchant, closeMerchant, removeAtMerchant, resolveCourierOffer } from '../noncombat.ts'
import type { CourierOffer, MerchantPurchase } from '../noncombat.ts'
import { cardHasGuardianSocket, queueGuardianSocket } from './guardian-gems.ts'
import { hasPendingRelicAcquisition } from './rules.ts'

export function purchaseAtMerchant(state: RunState, purchase: MerchantPurchase): RunState {
  if (state.phase !== 'room' || state.roomState?.kind !== 'merchant' || hasPendingRelicAcquisition(state)) return state
  const eligible = state.setup?.kind === 'catch-up'
    ? state.players.filter((player) => state.setup!.playerIds.includes(player.id)) : state.players
  if (!eligible.some((player) => player.id === purchase.buyerId)) return state
  const itemDecks = structuredClone(state.itemDecks)
  itemDecks.potions = [...state.potionDeck]
  const result = buyFromMerchant(state.roomState, itemDecks, eligible, state.ascension, purchase)
  const byId = result && new Map(result.players.map((player) => [player.id, player]))
  if (!result) return state
  let next = mirrorItemSupplies({ ...state, roomState: result.shop,
    players: state.players.map((player) => byId?.get(player.id) ?? player) }, itemDecks)
  const defId = purchase.section === 'card' ? state.roomState.cards[purchase.buyerId]?.choices[purchase.slot] : undefined
  if (defId && cardHasGuardianSocket(defId)) {
    const before = new Set(state.players.find((player) => player.id === purchase.buyerId)?.deck.map((card) => card.uid) ?? [])
    const card = next.players.find((player) => player.id === purchase.buyerId)?.deck.find((held) => !before.has(held.uid))
    if (card) next = queueGuardianSocket(next, purchase.buyerId, card.uid, 'merchant', state.roomState.guardianGems?.[purchase.buyerId] ?? [])
  }
  return next
}

export function removeAtCurrentMerchant(
  state: RunState,
  playerId: string,
  cardUid: string,
  payments: Readonly<Record<string, number>>,
): RunState {
  if (state.phase !== 'room' || state.roomState?.kind !== 'merchant') return state
  const eligible = state.setup?.kind === 'catch-up'
    ? state.players.filter((player) => state.setup!.playerIds.includes(player.id)) : state.players
  if (!eligible.some((player) => player.id === playerId)) return state
  const result = removeAtMerchant(state.roomState, eligible, state.ascension, playerId, cardUid, payments)
  const byId = result && new Map(result.players.map((player) => [player.id, player]))
  return result ? { ...state, roomState: result.shop, players: state.players.map((player) => byId?.get(player.id) ?? player) } : state
}

export function finishMerchant(state: RunState): RunState {
  if (state.phase !== 'room' || state.roomState?.kind !== 'merchant' || hasPendingRelicAcquisition(state)) return state
  const itemDecks = structuredClone(state.itemDecks)
  const eligible = state.setup?.kind === 'catch-up'
    ? state.players.filter((player) => state.setup!.playerIds.includes(player.id)) : state.players
  const closed = closeMerchant(state.roomState, itemDecks, eligible)
  const byId = new Map(closed.map((player) => [player.id, player]))
  const players = state.players.map((player) => byId.get(player.id) ?? player)
  const guardianGemDeck = [...(state.guardianGemDeck ?? []), ...Object.values(state.roomState.guardianGems ?? {}).flat()]
  const next = mirrorItemSupplies({ ...state, phase: state.setup ? 'setup' : 'map', roomState: null, players,
    guardianGemDeck, log: [...state.log, 'The party leaves the Merchant.'] }, itemDecks)
  return state.setup && currentQuickSetupStep(state.setup)?.kind === 'merchant' ? finishQuickSetup(next) : next
}

export function revealCourier(state: RunState, playerId: string, kind: CourierOffer['kind']): RunState {
  if (state.phase !== 'combat' || !state.combat || ['won', 'lost'].includes(state.combat.phase) || state.courier.offer || state.courier.usedBy.includes(playerId)) return state
  const player = state.combat.players.find((candidate) => candidate.id === playerId && !candidate.dead)
  if (!player?.relics.some((relic) => relic.defId === 'the_courier')) return state
  const itemDecks = structuredClone(state.itemDecks)
  if (kind === 'potion') itemDecks.potions = [...state.combat.potionDeck]
  const deck = kind === 'relic' ? itemDecks.relics : itemDecks.potions
  const blocked = kind === 'relic' ? new Set(['old_coin']) : new Set<string>()
  const id = drawItems(deck, 1, blocked)[0]
  if (!id) return state
  return mirrorItemSupplies({
    ...state,
    combat: kind === 'potion' ? { ...state.combat, potionDeck: [...itemDecks.potions] } : state.combat,
    courier: { usedBy: [...state.courier.usedBy, playerId], offer: { playerId, kind, id } },
  }, itemDecks)
}

export function decideCourier(
  state: RunState,
  playerId: string,
  decision: 'buy' | 'discard',
  payments: Readonly<Record<string, number>> = {},
  discardPotionId?: string,
): RunState {
  const offer = state.courier.offer
  if (state.phase !== 'combat' || !state.combat || ['won', 'lost'].includes(state.combat.phase) || !offer || offer.playerId !== playerId) return state
  const itemDecks = structuredClone(state.itemDecks)
  if (offer.kind === 'potion') itemDecks.potions = [...state.combat.potionDeck]
  const combatPlayers = resolveCourierOffer(offer, itemDecks, state.combat.players, state.ascension, decision === 'buy', payments, discardPotionId)
  if (!combatPlayers) return state
  const byId = new Map(combatPlayers.map((player) => [player.id, player]))
  return mirrorItemSupplies({
    ...state,
    players: state.players.map((player) => {
      const current = byId.get(player.id)
      return current ? { ...player, gold: current.gold, relics: current.relics, potions: current.potions } : player
    }),
    combat: {
      ...state.combat,
      potionDeck: offer.kind === 'potion' ? [...itemDecks.potions] : state.combat.potionDeck,
      players: combatPlayers,
    },
    courier: { ...state.courier, offer: null },
    log: [...state.log, decision === 'buy' ? `${byId.get(playerId)?.name ?? 'A player'} buys from The Courier.` : 'The Courier discards the offer.'],
  }, itemDecks)
}
