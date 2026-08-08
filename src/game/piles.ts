// Draw, discard, exhaust. Pure functions over pile arrays so they can be tested
// without building a whole game state.
import { shuffle } from './rng.ts'
import type { RngState } from './rng.ts'
import type { CardInstance } from './types.ts'

/**
 * A player's three combat piles.
 *
 * Invariant: a card that is currently being played belongs to NONE of these.
 * The rulebook is explicit (p.12) that while a card is being played it is
 * neither in your hand nor in your discard pile, and the caller is expected to
 * hold it aside until cleanup. That is what stops a card that draws cards from
 * shuffling itself back in and drawing itself, with no special case needed here.
 */
export type Piles = {
  draw: CardInstance[]
  hand: CardInstance[]
  discard: CardInstance[]
}

export type DrawResult = Piles & {
  /** How many cards were actually drawn — fewer than asked if the deck runs dry. */
  drawn: number
  /** True when the discard pile had to be reshuffled to satisfy the draw. */
  reshuffled: boolean
  /**
   * How many cards had already been drawn when the reshuffle happened, or -1
   * if it did not. A reshuffle lands in the MIDDLE of a draw, so a caller that
   * fires an effect per card drawn needs to know where to slot it in.
   */
  reshuffledAfter: number
}

/**
 * Draws `count` cards, reshuffling the discard pile when the draw pile empties
 * (p.12). Draws fewer than asked only when both piles run dry.
 */
export function drawCards(rng: RngState, piles: Piles, count: number): DrawResult {
  const draw = [...piles.draw]
  const hand = [...piles.hand]
  let discard = [...piles.discard]
  let drawn = 0
  let reshuffled = false
  let reshuffledAfter = -1

  for (let i = 0; i < count; i++) {
    if (draw.length === 0) {
      if (discard.length === 0) break
      draw.push(...shuffle(rng, discard))
      discard = []
      reshuffled = true
      // How many cards were already in hand when the pile ran out. The shuffle
      // happens PARTWAY through a draw (p.12), so anything that reacts to
      // drawing and to shuffling has to interleave in the right order.
      reshuffledAfter = drawn
    }
    const card = draw.shift()
    if (!card) break
    hand.push(card)
    drawn++
  }

  return { draw, hand, discard, drawn, reshuffled, reshuffledAfter }
}

/** Discards the whole hand, which is what the end of the Player Turn does. */
export function discardHand(piles: Piles, keep: readonly string[] = []): Piles {
  const retained = piles.hand.filter((card) => keep.includes(card.uid))
  const discarded = piles.hand.filter((card) => !keep.includes(card.uid))
  return {
    draw: piles.draw,
    hand: retained,
    discard: [...piles.discard, ...discarded],
  }
}

export function moveToDiscard(piles: Piles, card: CardInstance): Piles {
  return {
    draw: piles.draw,
    hand: piles.hand.filter((held) => held.uid !== card.uid),
    discard: [...piles.discard, card],
  }
}

/**
 * Daze goes on top of the DRAW pile (p.24) — index 0, the very next card drawn.
 * Both piles are stored with index 0 as the card nearest the top of the draw
 * pile, so "top of the discard pile" below is the opposite end of the array.
 */
export function addToDrawTop(piles: Piles, cards: readonly CardInstance[]): Piles {
  return { ...piles, draw: [...cards, ...piles.draw] }
}

/**
 * Status goes on top of the DISCARD pile (p.24) — the most recently discarded
 * card, which is the end of the array.
 */
export function addToDiscardTop(piles: Piles, cards: readonly CardInstance[]): Piles {
  return { ...piles, discard: [...piles.discard, ...cards] }
}

/**
 * Scry: look at the top X, discard any of them, return the rest on top **in the
 * same order** (p.24). Scrying more than the draw pile holds is not possible.
 */
export function scry(piles: Piles, count: number, discardUids: readonly string[]): Piles {
  const looked = piles.draw.slice(0, Math.max(0, count))
  const rest = piles.draw.slice(looked.length)
  const kept = looked.filter((card) => !discardUids.includes(card.uid))
  const tossed = looked.filter((card) => discardUids.includes(card.uid))
  return {
    draw: [...kept, ...rest],
    hand: piles.hand,
    discard: [...piles.discard, ...tossed],
  }
}

/**
 * Returns every pile to the deck at the end of combat. Status and Daze cards
 * leave the deck entirely — they belong to their own shared decks (p.13).
 */
export function collectDeck(
  piles: Piles,
  exhaust: readonly CardInstance[],
  powers: readonly CardInstance[],
  isTransient: (card: CardInstance) => boolean,
): CardInstance[] {
  return [...piles.draw, ...piles.hand, ...piles.discard, ...exhaust, ...powers].filter(
    (card) => !isTransient(card),
  )
}
