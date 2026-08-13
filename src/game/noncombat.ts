import { CARDS } from './cards.ts'
import {
  addCard,
  bottomItems,
  drawCardChoices,
  drawItems,
  gainPotion,
  gainRelic,
  merchantCardCost,
  merchantRelicCost,
  merchantRemovalCost,
  nextCardUid,
  potionLimit,
  removeCard,
} from './acquisition.ts'
import type { ItemDecks, RewardDraw } from './acquisition.ts'
import { potionDef, relicDef } from './relics.ts'
import type { Player } from './types.ts'

export type MerchantState = {
  kind: 'merchant'
  relics: (string | null)[]
  potions: (string | null)[]
  colorless: (string | null)[]
  cards: Record<string, RewardDraw>
  removalUsed: string[]
  purchasedCards: Record<string, string[]>
}

export type TreasureDecision = 'take' | 'skip' | 'sapphire' | number

export type RelicRewardState = {
  kind: 'treasure' | 'elite'
  offers: Record<string, string | null>
  playerIds: string[]
  sharedOffers?: (string | null)[]
  decisions: Record<string, TreasureDecision>
}

export type MerchantPurchase = {
  buyerId: string
  section: 'relic' | 'potion' | 'colorless' | 'card'
  slot: number
  payments: Record<string, number>
  potionRecipientId?: string
  discardPotionId?: string
}

export type CourierOffer = { playerId: string; kind: 'relic' | 'potion'; id: string }

export function courierCost(offer: CourierOffer): number | null {
  return offer.kind === 'relic' ? relicDef(offer.id).cost ?? null : potionDef(offer.id).cost ?? null
}

export function resolveCourierOffer(
  offer: CourierOffer,
  itemDecks: ItemDecks,
  players: readonly Player[],
  ascension: number,
  buy: boolean,
  payments: Readonly<Record<string, number>>,
  discardPotionId?: string,
): Player[] | null {
  const deck = offer.kind === 'relic' ? itemDecks.relics : itemDecks.potions
  if (!buy) {
    bottomItems(deck, [offer.id])
    return [...players]
  }
  const cost = courierCost(offer)
  if (cost === null || !exactPayment(players, payments, cost)) return null
  const ownerIndex = players.findIndex((player) => player.id === offer.playerId)
  if (ownerIndex < 0) return null
  const paid = pay(players, payments)
  let owner = paid[ownerIndex]!
  if (offer.kind === 'relic') owner = gainRelic(owner, offer.id)
  else {
    if (owner.relics.some((relic) => relic.defId === 'sozu')) return null
    if (discardPotionId) {
      const at = owner.potions.indexOf(discardPotionId)
      if (at < 0) return null
      owner = { ...owner, potions: owner.potions.filter((_id, index) => index !== at) }
      bottomItems(itemDecks.potions, [discardPotionId])
    }
    if (owner.potions.length >= potionLimit(ascension)) return null
    owner = gainPotion(owner, offer.id, ascension)
  }
  paid[ownerIndex] = owner
  return paid
}

function exactPayment(players: readonly Player[], payments: Readonly<Record<string, number>>, cost: number): boolean {
  if (Object.values(payments).reduce((sum, amount) => sum + amount, 0) !== cost) return false
  return Object.entries(payments).every(([playerId, amount]) => {
    const player = players.find((candidate) => candidate.id === playerId)
    return Number.isInteger(amount) && amount >= 0 && Boolean(player) && amount <= (player?.gold ?? -1)
  })
}

function pay(players: readonly Player[], payments: Readonly<Record<string, number>>): Player[] {
  return players.map((player) => ({ ...player, gold: player.gold - (payments[player.id] ?? 0) }))
}

export function createMerchant(itemDecks: ItemDecks, players: readonly Player[]): MerchantState {
  return {
    kind: 'merchant',
    relics: drawItems(itemDecks.relics, 3, new Set(['old_coin'])),
    potions: drawItems(itemDecks.potions, 3),
    colorless: drawItems(itemDecks.colorless, 3),
    cards: Object.fromEntries(players.map((player) => [player.id, drawCardChoices(player)])),
    removalUsed: [],
    purchasedCards: {},
  }
}

function itemAt(shop: MerchantState, purchase: MerchantPurchase): string | null {
  if (purchase.section === 'relic') return shop.relics[purchase.slot] ?? null
  if (purchase.section === 'potion') return shop.potions[purchase.slot] ?? null
  if (purchase.section === 'colorless') return shop.colorless[purchase.slot] ?? null
  return shop.cards[purchase.buyerId]?.choices[purchase.slot] ?? null
}

export function merchantPurchaseCost(shop: MerchantState, purchase: MerchantPurchase): number | null {
  const id = itemAt(shop, purchase)
  if (!id) return null
  if (purchase.section === 'relic') return merchantRelicCost(id, purchase.slot)
  if (purchase.section === 'potion') return potionDef(id).cost ?? null
  return merchantCardCost(id)
}

export function buyFromMerchant(
  shop: MerchantState,
  itemDecks: ItemDecks,
  players: readonly Player[],
  ascension: number,
  purchase: MerchantPurchase,
): { shop: MerchantState; players: Player[] } | null {
  const buyer = players.find((player) => player.id === purchase.buyerId)
  const id = itemAt(shop, purchase)
  if (!buyer || !id || !Number.isInteger(purchase.slot) || purchase.slot < 0) return null
  const cost = merchantPurchaseCost(shop, purchase)
  if (cost === null || !exactPayment(players, purchase.payments, cost)) return null

  let paid = pay(players, purchase.payments)
  const ownerIndex = paid.findIndex((player) => player.id === buyer.id)
  let owner = paid[ownerIndex]!
  const nextShop: MerchantState = { ...shop }

  if (purchase.section === 'relic') {
    owner = gainRelic(owner, id)
    nextShop.relics = shop.relics.map((value, index) => index === purchase.slot ? null : value)
  } else if (purchase.section === 'potion') {
    const recipientId = purchase.potionRecipientId ?? buyer.id
    const recipientIndex = paid.findIndex((player) => player.id === recipientId)
    if (recipientIndex < 0) return null
    let recipient = paid[recipientIndex]!
    if (recipient.relics.some((relic) => relic.defId === 'sozu')) return null
    if (purchase.discardPotionId) {
      const discardIndex = recipient.potions.indexOf(purchase.discardPotionId)
      if (discardIndex < 0) return null
      recipient = { ...recipient, potions: recipient.potions.filter((_potion, index) => index !== discardIndex) }
      bottomItems(itemDecks.potions, [purchase.discardPotionId])
    }
    if (recipient.potions.length >= potionLimit(ascension)) return null
    paid[recipientIndex] = gainPotion(recipient, id, ascension)
    nextShop.potions = shop.potions.map((value, index) => index === purchase.slot ? null : value)
  } else {
    const uid = nextCardUid(paid)()
    owner = addCard(owner, id, uid)
    if (purchase.section === 'colorless') {
      nextShop.colorless = shop.colorless.map((value, index) => index === purchase.slot ? null : value)
    } else {
      nextShop.cards = {
        ...shop.cards,
        [buyer.id]: {
          ...shop.cards[buyer.id]!,
          choices: shop.cards[buyer.id]!.choices.map((value, index) => index === purchase.slot ? '' : value),
        },
      }
      nextShop.purchasedCards = {
        ...shop.purchasedCards,
        [buyer.id]: [...(shop.purchasedCards[buyer.id] ?? []), id],
      }
    }
  }

  if (purchase.section !== 'potion') paid[ownerIndex] = owner
  return { shop: nextShop, players: paid }
}

export function removeAtMerchant(
  shop: MerchantState,
  players: readonly Player[],
  ascension: number,
  playerId: string,
  cardUid: string,
  payments: Readonly<Record<string, number>>,
): { shop: MerchantState; players: Player[] } | null {
  const player = players.find((candidate) => candidate.id === playerId)
  if (!player || shop.removalUsed.includes(playerId) || !exactPayment(players, payments, merchantRemovalCost(ascension))) return null
  const removed = removeCard(player, cardUid)
  if (removed === player) return null
  const paid = pay(players, payments).map((candidate) => candidate.id === playerId
    ? { ...removed, gold: candidate.gold }
    : candidate)
  return { shop: { ...shop, removalUsed: [...shop.removalUsed, playerId] }, players: paid }
}

export function closeMerchant(shop: MerchantState, itemDecks: ItemDecks, players: readonly Player[]): Player[] {
  bottomItems(itemDecks.relics, shop.relics.filter((id): id is string => id !== null))
  bottomItems(itemDecks.potions, shop.potions.filter((id): id is string => id !== null))
  bottomItems(itemDecks.colorless, shop.colorless.filter((id): id is string => id !== null))
  return players.map((player) => {
    const draw = shop.cards[player.id]
    if (!draw) return player
    const bought = [...(shop.purchasedCards[player.id] ?? [])]
    const keep = (choice: string) => {
      const index = bought.indexOf(choice)
      if (index < 0) return true
      bought.splice(index, 1)
      return false
    }
    return {
      ...player,
      cardRewards: [
        ...player.cardRewards.slice(draw.cardsDrawn.length),
        ...draw.cardsDrawn.filter((id) => id !== 'golden_ticket' && keep(id)),
        ...draw.cardsDrawn.filter((id) => id === 'golden_ticket'),
      ],
      rareRewards: [...player.rareRewards.slice(draw.raresDrawn.length), ...draw.raresDrawn.filter(keep)],
    }
  })
}

export function createRelicReward(
  kind: RelicRewardState['kind'],
  itemDecks: ItemDecks,
  players: readonly Player[],
  chooseYourRelic = false,
): RelicRewardState {
  const playerIds = players.filter((player) => !player.dead).map((player) => player.id)
  return {
    kind,
    offers: chooseYourRelic ? {} : Object.fromEntries(playerIds.map((playerId) => [playerId, drawItems(itemDecks.relics, 1)[0] ?? null])),
    playerIds,
    sharedOffers: chooseYourRelic ? drawItems(itemDecks.relics, playerIds.length) : undefined,
    decisions: {},
  }
}

export function decideRelicReward(
  reward: RelicRewardState,
  playerId: string,
  decision: TreasureDecision,
): RelicRewardState | null {
  if (!reward.playerIds.includes(playerId) || playerId in reward.decisions) return null
  const fullReward = reward.sharedOffers
    ? reward.sharedOffers.filter(Boolean).length >= reward.playerIds.length
    : reward.playerIds.every((id) => Boolean(reward.offers[id]))
  if (decision === 'sapphire' && !fullReward) return null
  if (reward.sharedOffers) {
    if (typeof decision === 'number') {
      if (!Number.isInteger(decision) || decision < 0 || decision >= reward.sharedOffers.length || Object.values(reward.decisions).includes(decision)) return null
    } else if (decision !== 'skip' && decision !== 'sapphire') return null
  } else if (typeof decision === 'number') return null
  else if (decision !== 'take' && decision !== 'skip' && decision !== 'sapphire') return null
  return { ...reward, decisions: { ...reward.decisions, [playerId]: decision } }
}

export function resolveRelicReward(
  reward: RelicRewardState,
  itemDecks: ItemDecks,
  players: readonly Player[],
  sapphireHeld: boolean,
): { players: Player[]; sapphire: boolean } | null {
  const ids = reward.playerIds
  if (!ids.every((id) => reward.decisions[id] !== undefined)) return null
  const fullReward = reward.sharedOffers
    ? reward.sharedOffers.filter(Boolean).length >= ids.length
    : ids.every((id) => Boolean(reward.offers[id]))
  const sapphire = !sapphireHeld && fullReward && ids.length > 0 && ids.every((id) => reward.decisions[id] === 'sapphire')
  const bottom: string[] = []
  const next = players.map((player) => {
    const relicId = reward.sharedOffers && typeof reward.decisions[player.id] === 'number'
      ? reward.sharedOffers[reward.decisions[player.id] as number]
      : reward.offers[player.id]
    const decision = reward.decisions[player.id]
    const taking = decision === 'take' || typeof decision === 'number'
    if (!relicId || !taking || sapphire) {
      if (relicId) bottom.push(relicId)
      return player
    }
    if (relicId === 'old_coin') {
      bottom.push(relicId)
      return gainRelic(player, relicId)
    }
    return gainRelic(player, relicId)
  })
  if (reward.sharedOffers) for (const [index, relicId] of reward.sharedOffers.entries()) {
    if (relicId && !Object.values(reward.decisions).includes(index)) bottom.push(relicId)
  }
  bottomItems(itemDecks.relics, bottom)
  return { players: next, sapphire }
}

export function shopHasPurchasableCard(shop: MerchantState, playerId: string): boolean {
  return shop.cards[playerId]?.choices.some((id) => Boolean(id && CARDS[id])) ?? false
}
