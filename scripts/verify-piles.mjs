import {
  drawCards,
  discardHand,
  moveToDiscard,
  addToDrawTop,
  addToDiscardTop,
  scry,
  collectDeck,
} from '../src/game/piles.ts'
import { createRng } from '../src/game/rng.ts'
import { suite, check, assert, assertEqual, assertDeepEqual, report } from './lib/harness.mjs'

const card = (uid, defId = uid) => ({ uid, defId, upgraded: false })
const cards = (...uids) => uids.map((uid) => card(uid))
const uids = (list) => list.map((c) => c.uid)
const piles = (draw = [], hand = [], discard = []) => ({ draw, hand, discard })

suite('piles')

check('drawing takes from the top of the draw pile in order', () => {
  const result = drawCards(createRng(1), piles(cards('a', 'b', 'c', 'd')), 2)
  assertDeepEqual(uids(result.hand), ['a', 'b'])
  assertDeepEqual(uids(result.draw), ['c', 'd'])
  assertEqual(result.drawn, 2)
  assert(!result.reshuffled, 'a full draw pile should not need a reshuffle')
})

check('drawing does not mutate the input piles', () => {
  const source = piles(cards('a', 'b'), [], cards('x'))
  const before = JSON.stringify(source)
  drawCards(createRng(1), source, 2)
  assertEqual(JSON.stringify(source), before, 'drawCards must not mutate its argument')
})

check('an empty draw pile reshuffles the discard pile', () => {
  const result = drawCards(createRng(7), piles([], [], cards('a', 'b', 'c')), 2)
  assertEqual(result.drawn, 2)
  assert(result.reshuffled, 'should report the reshuffle')
  assertEqual(result.discard.length, 0, 'the discard pile is consumed by the reshuffle')
  assertEqual(result.hand.length + result.draw.length, 3, 'no card may be lost in a reshuffle')
})

check('drawing stops when both piles are empty', () => {
  const result = drawCards(createRng(1), piles(cards('a')), 5)
  assertEqual(result.drawn, 1, 'only one card was available')
  assertEqual(result.hand.length, 1)
  assertEqual(result.draw.length, 0)
})

check('drawing zero or fewer cards is a no-op', () => {
  const result = drawCards(createRng(1), piles(cards('a', 'b')), 0)
  assertEqual(result.drawn, 0)
  assertDeepEqual(uids(result.draw), ['a', 'b'])
})

// Rulebook p.12: while a card is being played it is in neither your hand nor
// your discard pile. The engine holds it outside the piles entirely, so a card
// that draws cards cannot shuffle itself back in and draw itself. This pins that
// property against the piles it is absent from.
check('a card held aside while resolving cannot be drawn by its own effect', () => {
  const engine = card('engine')
  const result = drawCards(createRng(3), piles([], [], cards('a', 'b')), 3)
  assert(result.reshuffled, 'should have reshuffled')
  const everywhere = [...uids(result.hand), ...uids(result.draw), ...uids(result.discard)]
  assert(
    !everywhere.includes(engine.uid),
    'a card outside the piles must never appear in one as a result of drawing',
  )
  assertEqual(result.drawn, 2, 'only the two cards in the discard pile were available')
})

check('discarding the hand moves everything but retained cards', () => {
  const next = discardHand(piles(cards('z'), cards('a', 'b', 'c'), cards('old')))
  assertDeepEqual(uids(next.hand), [])
  assertDeepEqual(uids(next.discard), ['old', 'a', 'b', 'c'])
  assertDeepEqual(uids(next.draw), ['z'], 'the draw pile is untouched')
})

check('Retain keeps named cards in hand', () => {
  const next = discardHand(piles([], cards('a', 'b', 'c')), ['b'])
  assertDeepEqual(uids(next.hand), ['b'])
  assertDeepEqual(uids(next.discard), ['a', 'c'])
})

check('a played card leaves hand for the discard pile', () => {
  const next = moveToDiscard(piles([], cards('a', 'b')), card('a'))
  assertDeepEqual(uids(next.hand), ['b'])
  assertDeepEqual(uids(next.discard), ['a'])
})

// Daze and Status land in opposite places, which is easy to conflate.
check('Daze goes on top of the draw pile', () => {
  const next = addToDrawTop(piles(cards('a', 'b')), cards('daze'))
  assertDeepEqual(uids(next.draw), ['daze', 'a', 'b'])
})

check('Status goes on top of the discard pile', () => {
  const next = addToDiscardTop(piles([], [], cards('a')), cards('burn'))
  assertDeepEqual(uids(next.discard), ['a', 'burn'])
})

check('Scry keeps the order of the cards put back', () => {
  const next = scry(piles(cards('a', 'b', 'c', 'd')), 3, ['b'])
  assertDeepEqual(uids(next.draw), ['a', 'c', 'd'], 'kept cards return on top in the same order')
  assertDeepEqual(uids(next.discard), ['b'])
})

check('Scry can discard everything it looked at', () => {
  const next = scry(piles(cards('a', 'b', 'c')), 2, ['a', 'b'])
  assertDeepEqual(uids(next.draw), ['c'])
  assertDeepEqual(uids(next.discard), ['a', 'b'])
})

check('Scry beyond the draw pile just looks at what is there', () => {
  const next = scry(piles(cards('a')), 5, [])
  assertDeepEqual(uids(next.draw), ['a'])
  assertDeepEqual(uids(next.discard), [])
})

check('Scry on an empty draw pile does nothing', () => {
  const next = scry(piles([], cards('h'), cards('d')), 3, [])
  assertDeepEqual(uids(next.draw), [])
  assertDeepEqual(uids(next.discard), ['d'])
})

// p.13: Status and Daze leave the deck at end of combat; everything else returns.
check('end of combat gathers every pile back into the deck', () => {
  const transient = new Set(['burn', 'daze'])
  const deck = collectDeck(
    piles(cards('a'), cards('b'), [...cards('c'), card('burn')]),
    [card('d'), card('daze')],
    cards('power'),
    (c) => transient.has(c.defId),
  )
  assertDeepEqual(uids(deck).sort(), ['a', 'b', 'c', 'd', 'power'])
})

report('piles')
