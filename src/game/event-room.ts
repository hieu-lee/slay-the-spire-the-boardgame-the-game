import { CARDS } from './cards.ts'
import type { EventCard, EventEffect } from './events.ts'
import { addCard, bottomCardChoices, drawCardChoices, drawItems, gainGold, gainPotion, gainRelic, healingCapFor, nextCardUid, removeCard, transformCard, upgradeCard } from './acquisition.ts'
import type { ItemDecks } from './acquisition.ts'
import { nextInt } from './rng.ts'
import type { RngState } from './rng.ts'
import type { CharacterId, Player } from './types.ts'
import { RELIC_DECK, relicDef } from './relics.ts'

export type EventDecision = {
  optionIds: string[]
  cardUids?: string[]
  relicIds?: string[]
  potionIds?: string[]
  potionRecipientId?: string
  potionRecipientIds?: string[]
  targetPlayerId?: string
  receiveCardUid?: string
  receiveRelicId?: string
  rewardIndexes?: number[]
  roomId?: string
  payments?: Record<string, number>
  rewardItemChoices?: ('take' | 'skip')[]
  rewardItemIds?: string[]
  rewardItemKinds?: ('relic' | 'potion')[]
  potionReplacementIds?: (string | null)[]
}

export type EventRoomState = {
  kind: 'event'
  card: EventCard
  decisions: Record<string, EventDecision>
  dieRolls: Record<string, number[]>
  rewardOffers?: Record<string, string[][]>
  itemOffers?: Record<string, { kind: 'relic' | 'potion'; id: string }[]>
  pendingDecisions?: Record<string, EventDecision>
  pendingRolls?: Record<string, number[]>
  revealedCards?: Record<string, string[]>
  revealedCardDefs?: Record<string, string[]>
  revealedRelics?: Record<string, string>
  partyOptionIds?: string[]
  pendingTrade?: {
    kind: 'card' | 'relic'
    actorId: string
    targetId: string
    offeredId: string
    decision: EventDecision
  }
  labChoices?: Record<string, EventDecision>
}

export type EventOutcome = {
  event: EventRoomState
  players: Player[]
  combat?: 'encounter' | 'elite'
  merchant?: true
  moveTo?: string
  complete: boolean
}

type Context = {
  eventId: string
  rng: RngState
  itemDecks: ItemDecks
  players: Player[]
  actorId: string
  decision: EventDecision
  cards: string[]
  relics: string[]
  potions: string[]
  rewardIndexes: number[]
  rolls: number[]
  combat?: EventOutcome['combat']
  merchant?: true
  moveTo?: string
  ascension: number
  nextUid: () => string
  removedCardDefId?: string
  lostRelicCost?: number
  eventDecisions: Record<string, EventDecision>
  forcedRolls: number[]
  payments: Record<string, number>
  paymentDue: number
  paymentSettled: boolean
  potionRecipientIds: string[]
  potionReplacementIds: (string | null)[]
  rewardItems: { kind: 'relic' | 'potion'; id: string }[]
  rewardItemChoices: ('take' | 'skip')[]
}

const actor = (context: Context) => context.players.find((player) => player.id === context.actorId)
const replace = (context: Context, player: Player) => {
  context.players = context.players.map((candidate) => candidate.id === player.id ? player : candidate)
}

function targets(context: Context, effect: EventEffect): Player[] {
  if (effect.target === 'each-player' || effect.target === 'party') return context.players.filter((player) => !player.dead)
  if (effect.target === 'one-player') {
    const target = context.players.find((player) => player.id === context.decision.targetPlayerId && !player.dead)
    return target ? [target] : []
  }
  const player = actor(context)
  return player ? [player] : []
}

function loseHp(player: Player, amount: number): Player {
  const hp = Math.max(0, player.hp - amount)
  return { ...player, hp, dead: hp === 0 }
}

function gainOneRelic(context: Context, player: Player): Player {
  const staged = context.rewardItems[0]?.kind === 'relic' ? context.rewardItems.shift() : undefined
  const relicId = staged?.id ?? drawItems(context.itemDecks.relics, 1, new Set(player.relics.map((relic) => relic.defId)))[0]
  if (!relicId) {
    if (staged) context.rewardItemChoices.shift()
    return player
  }
  if (staged && context.rewardItemChoices.shift() === 'skip') {
    if (!context.itemDecks.relics.includes(relicId)) context.itemDecks.relics.push(relicId)
    return player
  }
  if (relicId === 'old_coin') {
    if (!context.itemDecks.relics.includes(relicId)) context.itemDecks.relics.push(relicId)
    return gainRelic(player, relicId)
  }
  return gainRelic(player, relicId)
}

function gainOnePotion(context: Context, player: Player): Player | null {
  const staged = context.rewardItems[0]?.kind === 'potion' ? context.rewardItems.shift() : undefined
  const potionId = staged?.id ?? drawItems(context.itemDecks.potions, 1)[0]
  if (!potionId) {
    if (staged) {
      context.rewardItemChoices.shift()
      context.potionRecipientIds.shift()
      context.potionReplacementIds.shift()
    }
    return player
  }
  if (staged && context.rewardItemChoices.shift() === 'skip') {
    context.itemDecks.potions.push(potionId)
    context.potionRecipientIds.shift()
    context.potionReplacementIds.shift()
    return player
  }
  const recipientId = context.potionRecipientIds.shift()
  const replacementId = context.potionReplacementIds.shift()
  const recipient = context.players.find((candidate) => candidate.id === recipientId && !candidate.dead)
  if (recipient && recipient.id !== player.id) {
    const gained = gainPotion(recipient, potionId, context.ascension)
    if (gained === recipient) context.itemDecks.potions.push(potionId)
    else replace(context, gained)
    return player
  }
  if (player.relics.some((relic) => relic.defId === 'sozu')) {
    context.itemDecks.potions.push(potionId)
    return player
  }
  if (player.potions.length >= (context.ascension >= 4 ? 2 : 3)) {
    const discardId = replacementId
    if (discardId && player.id !== context.actorId) return null
    const at = discardId ? player.potions.indexOf(discardId) : -1
    if (at < 0) {
      if (staged) return null
      context.itemDecks.potions.push(potionId)
      return player
    }
    player = { ...player, potions: player.potions.filter((_id, index) => index !== at) }
    context.itemDecks.potions.push(discardId!)
  }
  const gained = gainPotion(player, potionId, context.ascension)
  if (gained === player) context.itemDecks.potions.push(potionId)
  return gained
}

function addCurse(context: Context, player: Player): Player {
  if (player.relics.some((relic) => relic.defId === 'omamori')) return player
  const curse = context.itemDecks.curses.shift()
  return curse ? addCard(player, curse, nextCardUid(context.players)()) : player
}

function takeCard(context: Context): string | undefined {
  const uid = context.cards.shift()
  return uid && uid
}

function cardMatches(defId: string, filter?: string): boolean {
  if (!filter) return true
  const def = CARDS[defId]
  if (!def) return false
  if (filter === 'starter Strike') return def.rarity === 'starter' && def.name === 'Strike'
  if (filter === 'one starter Strike and one starter Defend') return def.rarity === 'starter' && (def.name === 'Strike' || def.name === 'Defend')
  if (filter === 'rare or uncommon') return def.rarity === 'rare' || def.rarity === 'uncommon'
  return true
}

function effectFilterMatches(context: Context, filter?: string): boolean {
  if (!filter) return true
  const def = context.removedCardDefId ? CARDS[context.removedCardDefId] : undefined
  if (filter === 'removed card is uncommon') return def?.rarity === 'uncommon'
  if (filter === 'removed card is rare') return def?.rarity === 'rare'
  if (filter === 'removed card is a Curse') return def?.owner === 'curse'
  if (filter === 'party has Red Mask') return context.players.some((player) => player.relics.some((relic) => relic.defId === 'red_mask'))
  return true
}

function applyEffect(context: Context, effect: EventEffect): boolean {
  if (!effectFilterMatches(context, effect.filter)) return true
  if (effect.tag === 'nothing') return true
  if (effect.tag === 'roll-d6') {
    const die = context.forcedRolls.shift() ?? (1 + nextInt(context.rng, 6))
    context.rolls.push(die)
    for (const nested of effect.results?.[die as 1 | 2 | 3 | 4 | 5 | 6] ?? []) if (!applyEffect(context, nested)) return false
    return true
  }
  if (effect.tag === 'combat') {
    context.combat = effect.room === 'elite' ? 'elite' : 'encounter'
    return true
  }
  if (effect.tag === 'merchant') { context.merchant = true; return true }
  if (effect.tag === 'move') {
    if (!context.decision.roomId) return false
    context.moveTo = context.decision.roomId
    return true
  }

  const selected = targets(context, effect)
  const stagedKind = effect.tag === 'gain-relic' ? 'relic' : effect.tag === 'gain-potion' ? 'potion' : undefined
  if (selected.length === 0 && context.rewardItems[0]?.kind === stagedKind) {
    if (context.rewardItemChoices[0] !== 'skip') return false
    const fallback = actor(context)
    if (!fallback) return false
    if (stagedKind === 'relic') gainOneRelic(context, fallback)
    else gainOnePotion(context, fallback)
    return true
  }
  if (selected.length === 0 && ((effect.tag === 'gain-relic' && context.itemDecks.relics.length === 0) || (effect.tag === 'gain-potion' && context.itemDecks.potions.length === 0))) return true
  if (selected.length === 0) return false
  for (const original of selected) {
    let player = context.players.find((candidate) => candidate.id === original.id) ?? original
    const amount = effect.amount === 'relic-cost'
      ? (context.lostRelicCost ?? 0)
      : typeof effect.amount === 'number'
        ? effect.amount + (effect.perPriorChoice ? Object.values(context.eventDecisions ?? {}).filter((choice) => choice.optionIds.includes(context.decision.optionIds[0] ?? '')).length : 0)
        : (effect.count ?? 1)
    if (effect.tag === 'heal') player = { ...player, hp: Math.min(healingCapFor(player), player.hp + amount) }
    else if (effect.tag === 'full-heal') player = { ...player, hp: healingCapFor(player) }
    else if (effect.tag === 'lose-hp') player = loseHp(player, amount)
    else if (effect.tag === 'gain-gold') player = gainGold(player, amount)
    else if (effect.tag === 'lose-gold') player = { ...player, gold: effect.amount === 'all' ? 0 : Math.max(0, player.gold - amount) }
    else if (effect.tag === 'pay-gold') {
      if (effect.filter?.includes('or lose one Relic or Potion') && (context.relics.length > 0 || context.potions.length > 0)) {
        const relicId = context.relics.shift()
        const potionId = context.potions.shift()
        if (relicId && player.relics.some((relic) => relic.defId === relicId)) {
          player = { ...player, relics: player.relics.filter((relic) => relic.defId !== relicId) }
          if (RELIC_DECK.includes(relicId as never)) context.itemDecks.relics.push(relicId)
        } else if (potionId && player.potions.includes(potionId)) {
          const at = player.potions.indexOf(potionId)
          player = { ...player, potions: player.potions.filter((_id, index) => index !== at) }
          context.itemDecks.potions.push(potionId)
        } else return false
      } else {
        if (context.paymentSettled) continue
        if (Object.keys(context.payments).length === 0) context.payments = { [context.actorId]: context.paymentDue }
        if (Object.values(context.payments).reduce((sum, paid) => sum + paid, 0) !== context.paymentDue) return false
        if (!Object.entries(context.payments).every(([id, paid]) => Number.isInteger(paid) && paid >= 0 && context.players.some((candidate) => candidate.id === id && candidate.gold >= paid))) return false
        context.players = context.players.map((candidate) => ({ ...candidate, gold: candidate.gold - (context.payments[candidate.id] ?? 0) }))
        player = actor(context) ?? player
        context.payments = {}
        context.paymentSettled = true
      }
    } else if (effect.tag === 'gain-relic') player = gainOneRelic(context, player)
    else if (effect.tag === 'gain-potion') for (let index = 0; index < (effect.count ?? 1); index++) {
      if (player.id === context.actorId && context.potionRecipientIds.length === 0 && player.potions.length >= (context.ascension >= 4 ? 2 : 3) && context.potions.length > 0) {
        const discardId = context.potions.shift()!
        const at = player.potions.indexOf(discardId)
        if (at < 0) return false
        player = { ...player, potions: player.potions.filter((_id, potionIndex) => potionIndex !== at) }
        context.itemDecks.potions.push(discardId)
      }
      const gained = gainOnePotion(context, player)
      if (!gained) return false
      player = gained
    }
    else if (effect.tag === 'gain-curse') player = addCurse(context, player)
    else if (effect.tag === 'remove-curses') {
      for (const card of player.deck.filter((candidate) => CARDS[candidate.defId]?.owner === 'curse' && candidate.defId !== 'ascenders_bane')) player = removeCard(player, card.uid)
    }
    else if (effect.tag === 'remove-card') {
      const removable = player.deck.filter((card) => card.defId !== 'ascenders_bane' && cardMatches(card.defId, effect.filter))
      const uid = effect.random && effect.filter !== 'choose from three revealed cards' ? removable[nextInt(context.rng, removable.length)]?.uid : takeCard(context)
      if (!uid && removable.length === 0) continue
      if (!uid) return false
      const selectedCard = player.deck.find((card) => card.uid === uid)
      if (!selectedCard || !cardMatches(selectedCard.defId, effect.filter)) return false
      const next = removeCard(player, uid)
      if (next === player) return false
      context.removedCardDefId = selectedCard.defId
      player = next
    } else if (effect.tag === 'upgrade-card') {
      const count = effect.count ?? 1
      const eligible = player.deck.filter((card) => !card.upgraded && Boolean(CARDS[card.defId]?.upgrade) && cardMatches(card.defId, effect.filter))
      const required = effect.random ? 0 : effect.filter === 'one starter Strike and one starter Defend'
        ? new Set(eligible.map((card) => CARDS[card.defId]?.name)).size
        : Math.min(count, eligible.length)
      if (context.cards.length < required) return false
      for (let index = 0; index < count; index++) {
        const upgradable = player.deck.filter((card) => !card.upgraded && Boolean(CARDS[card.defId]?.upgrade) && cardMatches(card.defId, effect.filter))
        if (upgradable.length === 0) continue
        const uid = effect.random
          ? upgradable[nextInt(context.rng, upgradable.length)]?.uid
          : takeCard(context)
        if (!uid) continue
        const selectedCard = player.deck.find((card) => card.uid === uid)
        if (!selectedCard || !cardMatches(selectedCard.defId, effect.filter)) return false
        const next = upgradeCard(player, uid)
        if (next === player) return false
        player = next
      }
    } else if (effect.tag === 'transform-card') {
      const required = player.cardRewards.length === 0 ? 0 : Math.min(effect.count ?? 1, player.deck.filter((card) => CARDS[card.defId]?.owner !== 'curse').length)
      if (context.cards.length < required) return false
      for (let index = 0; index < (effect.count ?? 1); index++) {
        const transformable = player.deck.filter((card) => CARDS[card.defId]?.owner !== 'curse')
        const uid = takeCard(context)
        if ((!uid || player.cardRewards.length === 0) && (transformable.length === 0 || player.cardRewards.length === 0)) continue
        if (!uid) continue
        const next = transformCard(context.rng, player, uid, context.nextUid())
        if (next === player) return false
        player = next
      }
    } else if (effect.tag === 'lose-relic') {
      const relicId = effect.random && context.eventId !== 'forgotten_altar' ? player.relics[nextInt(context.rng, player.relics.length)]?.defId : context.relics.shift()
      if (!relicId && player.relics.length === 0) continue
      if (!relicId || !player.relics.some((relic) => relic.defId === relicId)) return false
      player = { ...player, relics: player.relics.filter((relic) => relic.defId !== relicId) }
      context.lostRelicCost = relicDef(relicId).cost ?? 0
      if (RELIC_DECK.includes(relicId as never)) context.itemDecks.relics.push(relicId)
    } else if (effect.tag === 'lose-potion') {
      const potionId = context.potions.shift()
      if (!potionId || !player.potions.includes(potionId)) return false
      const potionIndex = player.potions.indexOf(potionId)
      player = { ...player, potions: player.potions.filter((_id, index) => index !== potionIndex) }
      context.itemDecks.potions.push(potionId)
    } else if (effect.tag === 'card-reward' || effect.tag === 'rare-reward') {
      const rare = effect.tag === 'rare-reward' || effect.source === 'rare'
      const sourcePlayer = effect.source === 'other-character'
        ? context.players.find((candidate) => candidate.id === context.decision.targetPlayerId && candidate.id !== player.id)
        : player
      let inactiveCards = effect.source === 'other-character'
        ? context.itemDecks.characterCards[context.decision.targetPlayerId as CharacterId]
        : undefined
      let inactiveRares = effect.source === 'other-character'
        ? context.itemDecks.characterRares[context.decision.targetPlayerId as CharacterId]
        : undefined
      if (!sourcePlayer && !inactiveCards) return false
      for (let index = 0; index < (effect.count ?? 1); index++) {
        const reveal = effect.filter === 'reveal 5' ? 5 : 3
        const liveSource = sourcePlayer?.id === player.id
          ? player
          : context.players.find((candidate) => candidate.id === sourcePlayer?.id) ?? sourcePlayer
        if (!rare && effect.source !== 'colorless' && (sourcePlayer || inactiveCards)) {
          const draw = drawCardChoices(inactiveCards
            ? { cardRewards: inactiveCards, rareRewards: inactiveRares ?? [] }
            : liveSource!, reveal)
          if (draw.choices.length === 0) continue
          const choice = effect.random ? nextInt(context.rng, draw.choices.length) : context.rewardIndexes.shift()
          if (choice === -1) {
            if (inactiveCards) {
              const bottomed = bottomCardChoices({ ...player, cardRewards: inactiveCards, rareRewards: inactiveRares ?? [] }, draw, null)
              inactiveCards = bottomed.cardRewards
              inactiveRares = bottomed.rareRewards
              context.itemDecks.characterCards[context.decision.targetPlayerId as CharacterId] = inactiveCards
              context.itemDecks.characterRares[context.decision.targetPlayerId as CharacterId] = inactiveRares
            } else if (liveSource?.id === player.id) player = bottomCardChoices(player, draw, null)
            else replace(context, bottomCardChoices(liveSource!, draw, null))
            continue
          }
          const defId = choice === undefined ? undefined : draw.choices[choice]
          if (!defId) return false
          if (inactiveCards) {
            const bought = addCard(player, defId, context.nextUid())
            const bottomed = bottomCardChoices({ ...bought, cardRewards: inactiveCards, rareRewards: inactiveRares ?? [] }, draw, choice)
            inactiveCards = bottomed.cardRewards
            inactiveRares = bottomed.rareRewards
            context.itemDecks.characterCards[context.decision.targetPlayerId as CharacterId] = inactiveCards
            context.itemDecks.characterRares[context.decision.targetPlayerId as CharacterId] = inactiveRares
            player = { ...bought }
          } else if (liveSource?.id === player.id) player = bottomCardChoices(addCard(player, defId, context.nextUid()), draw, choice)
          else {
            replace(context, bottomCardChoices(liveSource!, draw, choice))
            player = addCard(player, defId, context.nextUid())
          }
        } else {
          const deck = [...(effect.source === 'colorless' ? context.itemDecks.colorless : liveSource!.rareRewards)]
          const choices = deck!.slice(0, reveal)
          if (choices.length === 0) continue
          const choice = effect.random ? nextInt(context.rng, choices.length) : context.rewardIndexes.shift()
          if (choice === -1) {
            deck!.splice(0, choices.length)
            deck!.push(...choices)
          } else {
            const defId = choice === undefined ? undefined : choices[choice]
            if (!defId) return false
            deck!.splice(0, choices.length)
            deck!.push(...choices.filter((_, choiceIndex) => choiceIndex !== choice))
            player = addCard(player, defId, context.nextUid())
          }
          if (effect.source === 'colorless') context.itemDecks.colorless = deck
          else if (liveSource?.id === player.id) player = { ...player, rareRewards: deck }
          else replace(context, { ...liveSource!, rareRewards: deck })
        }
      }
    } else if (effect.tag === 'trade-card') {
      const other = context.players.find((candidate) => candidate.id === context.decision.targetPlayerId)
      const giveUid = takeCard(context)
      const receiveUid = context.decision.receiveCardUid
      const give = player.deck.find((card) => card.uid === giveUid)
      const receive = other?.deck.find((card) => card.uid === receiveUid)
      const possible = player.deck.some((card) => card.defId !== 'ascenders_bane') && context.players.some((candidate) => candidate.id !== player.id && !candidate.dead && candidate.deck.some((card) => card.defId !== 'ascenders_bane'))
      if (!possible && (!give || !receive)) continue
      if (!other || other.id === player.id || !give || !receive || give.defId === 'ascenders_bane' || receive.defId === 'ascenders_bane') return false
      player = addCard({ ...player, deck: player.deck.filter((card) => card.uid !== give.uid) }, receive.defId, receive.uid, receive.upgraded)
      replace(context, addCard({ ...other, deck: other.deck.filter((card) => card.uid !== receive.uid) }, give.defId, give.uid, give.upgraded))
    } else if (effect.tag === 'trade-relic') {
      const other = context.players.find((candidate) => candidate.id === context.decision.targetPlayerId)
      const giveId = context.relics.shift()
      const receiveId = context.decision.receiveRelicId
      const give = player.relics.find((relic) => relic.defId === giveId)
      const receive = other?.relics.find((relic) => relic.defId === receiveId)
      const possible = player.relics.length > 0 && context.players.some((candidate) => candidate.id !== player.id && !candidate.dead && candidate.relics.length > 0)
      if (!possible && (!giveId || !receiveId)) continue
      if (!other || other.id === player.id || !give || !receive) return false
      player = { ...player, relics: [...player.relics.filter((relic) => relic !== give), receive] }
      replace(context, { ...other, relics: [...other.relics.filter((relic) => relic !== receive), give] })
    }
    replace(context, player)
  }
  return true
}

export function createEventRoom(card: EventCard): EventRoomState {
  return { kind: 'event', card, decisions: {}, dieRolls: {} }
}

export function resolveEventDecision(
  event: EventRoomState,
  rng: RngState,
  itemDecks: ItemDecks,
  players: readonly Player[],
  ascension: number,
  playerId: string,
  decision: EventDecision,
  forcedRolls: number[] = [],
  resumeAtRoll = false,
): EventOutcome | null {
  const player = players.find((candidate) => candidate.id === playerId && !candidate.dead)
  if (!player || event.decisions[playerId] || decision.optionIds.length === 0) return null
  const options = decision.optionIds.map((id) => event.card.options.find((option) => option.id === id))
  if (options.some((option) => !option)) return null
  if (event.card.id === 'knowing_skull' && (options.length < 1 || options.length > 2 || new Set(decision.optionIds).size !== options.length)) return null
  if (event.card.id !== 'knowing_skull' && options.length !== 1) return null
  if (options.some((option) => option!.effects.some((effect) => effect.filter === 'party has Red Mask')) && !players.some((candidate) => candidate.relics.some((relic) => relic.defId === 'red_mask'))) return null
  if (event.card.id === 'big_fish' && Object.values(event.decisions).some((other) => other.optionIds[0] === decision.optionIds[0])) return null
  if (event.card.id === 'scrap_ooze' && decision.optionIds[0] === 'leave' && (event.dieRolls[playerId]?.at(-1) ?? 3) > 2) return null
  if (event.card.scope === 'party' && Object.keys(event.decisions).length > 0) return null

  const context: Context = {
    eventId: event.card.id,
    rng,
    itemDecks,
    players: players.map((candidate) => ({ ...candidate })),
    actorId: playerId,
    decision,
    cards: [...(decision.cardUids ?? [])],
    relics: [...(decision.relicIds ?? [])],
    potions: [...(decision.potionIds ?? [])],
    rewardIndexes: [...(decision.rewardIndexes ?? [])],
    rolls: [],
    ascension,
    nextUid: nextCardUid(players),
    eventDecisions: event.decisions,
    forcedRolls: [...forcedRolls],
    payments: { ...(decision.payments ?? {}) },
    paymentDue: options.flatMap((option) => option?.effects ?? []).reduce((sum, effect) => sum + (effect.tag === 'pay-gold' && typeof effect.amount === 'number' ? effect.amount : 0), 0),
    paymentSettled: false,
    potionRecipientIds: [...(decision.potionRecipientIds ?? (decision.potionRecipientId ? [decision.potionRecipientId] : []))],
    potionReplacementIds: [...(decision.potionReplacementIds ?? [])],
    rewardItems: (decision.rewardItemIds ?? []).map((id, index) => ({ id, kind: decision.rewardItemKinds?.[index] ?? 'relic' })),
    rewardItemChoices: [...(decision.rewardItemChoices ?? [])],
  }
  if (event.card.id === 'ancient_writing' && decision.optionIds[0] === 'simplicity') {
    const chosen = (decision.cardUids ?? []).map((uid) => player.deck.find((card) => card.uid === uid)).filter(Boolean)
    const names = chosen.map((card) => CARDS[card!.defId]?.name).sort()
    const available = ['Defend', 'Strike'].filter((name) => player.deck.some((card) => !card.upgraded && CARDS[card.defId]?.rarity === 'starter' && CARDS[card.defId]?.name === name))
    if (names.join('/') !== available.join('/') || chosen.some((card) => card!.upgraded || CARDS[card!.defId]?.rarity !== 'starter')) return null
  }
  for (const selected of options) {
    let resumed = !resumeAtRoll
    for (const effect of selected!.effects) {
      if (!resumed) {
        if (effect.tag !== 'roll-d6') continue
        resumed = true
      }
      if (!applyEffect(context, effect)) return null
      if (context.combat) break
    }
    if (context.combat) break
  }

  const repeatScrap = event.card.id === 'scrap_ooze' && context.rolls.at(-1) !== undefined && context.rolls.at(-1)! <= 2
  const nextEvent = {
    ...event,
    decisions: repeatScrap ? event.decisions : { ...event.decisions, [playerId]: decision },
    dieRolls: { ...event.dieRolls, [playerId]: [...(event.dieRolls[playerId] ?? []), ...context.rolls] },
  }
  const complete = event.card.scope !== 'player'
    || context.players.filter((candidate) => !candidate.dead).every((candidate) => candidate.id in nextEvent.decisions)
  return { event: nextEvent, players: context.players, combat: context.combat, merchant: context.merchant, moveTo: context.moveTo, complete }
}

/** Applies the locked payment/effects printed before a die is revealed. */
export function resolveEventBeforeRoll(
  event: EventRoomState,
  rng: RngState,
  itemDecks: ItemDecks,
  players: readonly Player[],
  ascension: number,
  playerId: string,
  decision: EventDecision,
): EventOutcome | null {
  const option = event.card.options.find((candidate) => candidate.id === decision.optionIds[0])
  const rollIndex = option?.effects.findIndex((effect) => effect.tag === 'roll-d6') ?? -1
  if (!option || rollIndex < 0) return null
  return resolveEventDecision({
    ...event,
    card: { ...event.card, options: [{ ...option, effects: option.effects.slice(0, rollIndex) }] },
  }, rng, itemDecks, players, ascension, playerId, decision)
}
