// How a face-up Event reward's Potions land, mirrored from the engine
// (src/game/event-room.ts `gainOnePotion` and the recipient checks in
// src/game/run/events.ts) so the resolver can say what fits before submitting.

import type { EventEffect } from '../game/events.ts'

type Seat = { id: string; dead?: boolean; potions: readonly string[]; relics: readonly { defId: string }[] }
type Offer = { kind: 'relic' | 'potion'; id: string }
type Staged = {
  rewardItemKinds?: readonly ('relic' | 'potion')[]
  rewardItemChoices?: readonly ('take' | 'skip' | '')[]
  potionRecipientIds?: readonly string[]
  potionReplacementIds?: readonly (string | null)[]
}

export const hasSozu = (seat: Seat) => seat.relics.some((relic) => relic.defId === 'sozu')

/**
 * Who each revealed item belongs to, in the order the engine reveals them: an
 * "each player" gain deals one to every living seat in turn, a "one player"
 * gain goes to the chosen target, anything else to the player who resolved it.
 * Lab's opening Potion is every player's own reveal. Covers the whole reward,
 * earlier staged reveals first.
 */
export function lootHolders({ cardId, options, optionIds, rolls, actorId, targetId, livingIds }: {
  cardId: string
  options: readonly { id: string; effects: readonly EventEffect[] }[]
  optionIds: readonly string[]
  rolls?: readonly number[]
  actorId: string
  targetId: string
  livingIds: readonly string[]
}): string[] {
  if (cardId === 'lab' && !rolls) return [actorId]
  let rollAt = 0
  const active = (effects: readonly EventEffect[]): EventEffect[] => effects.flatMap((effect) => {
    if (effect.tag !== 'roll-d6') return [effect]
    const roll = rolls?.[rollAt++]
    return roll ? active(effect.results?.[roll as 1 | 2 | 3 | 4 | 5 | 6] ?? []) : []
  })
  const chosen = optionIds.map((id) => options.find((option) => option.id === id)).filter((option) => option !== undefined)
  const rolled = chosen.some((option) => option.effects.some((effect) => effect.tag === 'roll-d6'))
  const effects = chosen.flatMap((option) => {
    const roll = option.effects.findIndex((effect) => effect.tag === 'roll-d6')
    if (rolled && !rolls) return roll < 0 ? option.effects : option.effects.slice(0, roll)
    const resolved = active(roll < 0 ? option.effects : option.effects.slice(roll))
    const combat = resolved.findIndex((effect) => effect.tag === 'combat')
    return resolved.slice(0, combat < 0 ? undefined : combat)
  })
  return effects.flatMap((effect) => {
    if (effect.tag !== 'gain-relic' && effect.tag !== 'gain-potion') return []
    const seats = effect.target === 'each-player' || effect.target === 'party' ? livingIds
      : effect.target === 'one-player' ? [targetId] : [actorId]
    return seats.flatMap((id) => Array(effect.count ?? 1).fill(id) as string[])
  })
}

/**
 * Free Potion slots per living seat, after the Potions an earlier reveal of this
 * same reward already claimed: those only reach a belt when the Event resolves.
 */
export function freePotionSlots<T extends Seat>(players: readonly T[], limitOf: (seat: T) => number, actorId: string,
  holders: readonly string[], staged?: Staged): Map<string, number> {
  const free = new Map(players.filter((seat) => !seat.dead).map((seat) => [seat.id, limitOf(seat) - seat.potions.length]))
  let potionAt = 0
  for (const [index, kind] of (staged?.rewardItemKinds ?? []).entries()) {
    if (kind !== 'potion') continue
    const at = potionAt++
    if (staged?.rewardItemChoices?.[index] !== 'take') continue
    const recipientId = staged.potionRecipientIds?.[at] || holders[index] || ''
    // A replacement only frees the slot when the actor keeps the Potion on a
    // full belt; anywhere else the engine never discards.
    if ((recipientId === actorId && staged.potionReplacementIds?.[at]) || !free.has(recipientId)) continue
    free.set(recipientId, free.get(recipientId)! - 1)
  }
  return free
}

/** Relics are taken; a Potion is taken while the seat that keeps it still has a free slot. */
export function defaultLootChoices(offers: readonly Offer[], holders: readonly (Seat | undefined)[], free: ReadonlyMap<string, number>): ('take' | '')[] {
  const slots = new Map(free)
  return offers.map((offer, index) => {
    if (offer.kind === 'relic') return 'take'
    const holder = holders[index]
    const open = holder && !hasSozu(holder) ? slots.get(holder.id) ?? 0 : 0
    if (open <= 0) return ''
    slots.set(holder!.id, open - 1)
    return 'take'
  })
}

/**
 * `blocked` marks a Potion its recipient could not hold even if taken, given the
 * taken Potions before it: a full belt that cannot be swapped from (anyone
 * else's, or the resolving player's with nothing left to discard), a Sozu, or
 * nobody to receive it.
 */
export type PotionPlan = { legal: boolean; swaps: boolean[]; blocked: boolean[]; recipients: string[] }

/**
 * Walks the taken Potions in order, the way the rules resolve them. A blank
 * recipient means the offer's holder keeps it. Only the acting player may
 * discard to make room, so an overflow anywhere else is simply not legal.
 */
export function planEventPotions({ offers, choices, recipients, replacements, actorId, holders, players, free }: {
  offers: readonly Offer[]
  choices: readonly ('take' | 'skip' | '')[]
  recipients: readonly string[]
  replacements: readonly (string | null)[]
  actorId: string
  /** The seat that keeps each offer when it is not passed on, by offer index. */
  holders: readonly string[]
  players: readonly Seat[]
  free: ReadonlyMap<string, number>
}): PotionPlan {
  const slots = new Map(free)
  const actor = players.find((seat) => seat.id === actorId)
  const discarded = new Map<string, number>()
  const swaps: boolean[] = []
  const blocked: boolean[] = []
  const resolved: string[] = []
  let legal = true
  let potionAt = 0
  for (const [index, offer] of offers.entries()) {
    if (offer.kind !== 'potion') continue
    const at = potionAt++
    swaps[at] = false
    const recipientId = recipients[at] || holders[index] || ''
    resolved[at] = recipientId
    const recipient = players.find((seat) => seat.id === recipientId && !seat.dead)
    const available = slots.get(recipientId) ?? 0
    const discardable = (actor?.potions.length ?? 0) - [...discarded.values()].reduce((sum, count) => sum + count, 0)
    blocked[at] = !recipient || hasSozu(recipient) || available <= 0 && (recipientId !== actorId || discardable <= 0)
    if (choices[index] !== 'take') continue
    if (blocked[at] && recipient && !hasSozu(recipient) && recipientId === actorId) { legal = false; continue }
    if (!recipient || hasSozu(recipient)) { legal = false; continue }
    if (available > 0) {
      slots.set(recipientId, available - 1)
      continue
    }
    if (recipientId !== actorId) { legal = false; continue }
    swaps[at] = true
    const replacementId = replacements[at]
    const used = replacementId ? discarded.get(replacementId) ?? 0 : 0
    if (!replacementId || (actor?.potions.filter((id) => id === replacementId).length ?? 0) <= used) { legal = false; continue }
    discarded.set(replacementId, used + 1)
  }
  return { legal, swaps, blocked, recipients: resolved }
}
