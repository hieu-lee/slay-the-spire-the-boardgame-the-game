// The moment a card changes. The board game resolves an upgrade or a transform
// by swapping a piece of cardboard, which is over before anyone looks up; the
// digital game stops the screen, holds the old card up, and burns it into the
// new one. This is that beat.
//
// Deliberately not interactive and not a dialog: it steals no focus and traps
// nothing, because it fires while the player is mid-flow (confirming a campfire,
// picking an event option) and taking focus would lose their place. It is
// announced instead through a `visually-hidden` live region at the call sites —
// `aria-live="polite"` rather than `role="status"`, because the run already has
// status regions and a second one both competes with them and makes
// `getByRole('status')` ambiguous for the suites. A screen reader hears what the
// card became without the visual having to finish.
import { useEffect, useLayoutEffect, useState } from 'react'
import type { CardInstance } from '../game/types.ts'
import { Card } from './Card.tsx'

/** How long each beat of the morph runs. Summed, this is the whole overlay. */
const HOLD_OLD = 620
const BURN = 520
const HOLD_NEW = 900

export type CardMorphRequest = {
  /** Distinguishes the verb in the caption and the burst's colour. */
  kind: 'upgrade' | 'transform' | 'gain' | 'remove'
  /** Null for `gain`: a random reward or blessing card comes from nowhere, not from another card. */
  from: CardInstance | null
  /** Null for `remove`: the old card burns away without a replacement. */
  to: CardInstance | null
  /** Same uid across a run's worth of morphs would collide in the queue. */
  key: string
}

/**
 * One card becoming another, centre screen.
 *
 * `onDone` fires once, after the last beat. The caller drops the request and
 * shows the next one if a multi-card upgrade (Astrolabe takes three) queued
 * several — they play one at a time rather than stacking on top of each other.
 */
export function CardMorph({ request, onDone }: { request: CardMorphRequest; onDone: () => void }) {
  const [beat, setBeat] = useState<'old' | 'burn' | 'new'>('old')

  // `useLayoutEffect`, not `useEffect`. The container no longer remounts between
  // queued morphs, so `beat` survives as `'new'` from the previous card — and a
  // passive effect flushes AFTER paint, so the next morph's freshly keyed stage
  // painted under `--new` for a frame or two: its upgraded face at full opacity,
  // caption lit, then a reverse fade back to the old card before burning forward
  // again. Measured on a 3-upgrade queue: stage 2 and 3 both began `new > old >
  // burn > new`. Running the reset before paint means the stage's first computed
  // style is `--old` and no transition fires from a stale `--new`.
  useLayoutEffect(() => {
    setBeat('old')
    // Honour reduced motion by collapsing to the outcome: the player still gets
    // told what happened, without a flash and a scale-up they asked not to see.
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (still) {
      setBeat('new')
      const done = setTimeout(onDone, HOLD_NEW)
      return () => clearTimeout(done)
    }
    const toBurn = setTimeout(() => setBeat('burn'), HOLD_OLD)
    const toNew = setTimeout(() => setBeat('new'), HOLD_OLD + BURN)
    const done = setTimeout(onDone, HOLD_OLD + BURN + HOLD_NEW)
    return () => {
      clearTimeout(toBurn)
      clearTimeout(toNew)
      clearTimeout(done)
    }
    // Keyed on the REQUEST, not on a remount of the whole overlay. The call
    // sites used to pass `key={request.key}`, which rebuilt this component for
    // every queued morph and restarted `card-morph-veil` from `opacity: 0` — so
    // between two upgrades landing in one step (Whetstone, War Paint, Astrolabe
    // all do) the veil dropped out and the board flashed back to ~87% of its
    // un-veiled brightness before re-darkening. Same failure the `--to` slot
    // comment describes, at the scale of the whole overlay. The container now
    // lives for the length of the queue; only the stage below is keyed.
  }, [request.key, onDone])

  const verb = request.kind === 'upgrade' ? 'Upgraded'
    : request.kind === 'transform' ? 'Transformed'
      : request.kind === 'remove' ? 'Removed' : 'Gained'
  return (
    // `inert` as well as `aria-hidden`: `Card` renders a real <button>, and an
    // aria-hidden subtree containing a focusable control is the classic
    // aria-hidden-focus violation — a Tab during the overlay landed on an
    // invisible key in the middle of the flow the player was already in.
    <div className={`card-morph card-morph--${request.kind} card-morph--${beat}`} aria-hidden="true" inert>
      {/* Keyed so each card's own transitions start from the top even though
          the veil around them persists across the queue. */}
      <div className="card-morph__stage" key={request.key}>
        {/* A `gain` has no source card — the burst still fires, but it flares
            out of nothing rather than out of a card blowing away. */}
        {request.from ? (
          <div className="card-morph__slot card-morph__slot--from">
            <Card card={request.from} playable={false} />
          </div>
        ) : null}
        {request.to ? <div className="card-morph__slot card-morph__slot--to">
          <Card card={request.to} playable={false} />
        </div> : null}
        <span className="card-morph__burst" />
      </div>
      {/* Keyed like the stage, and for the same reason. This sits OUTSIDE the
          stage (it is the grid's second row, not part of the card), so without a
          key it is the same node for the whole queue: its last painted opacity
          was 1 from the previous card's `--new`, and flipping the container back
          to `--old` transitioned it 1 -> 0 over 140ms. The effect was the
          previous card's "Upgraded" sitting lit over the next, un-upgraded card.
          `useLayoutEffect` cannot fix that — the node persists, so only a fresh
          one starts from the `--old` opacity. */}
      <p className="card-morph__caption" key={`${request.key}-caption`}>{verb}</p>
    </div>
  )
}

/**
 * The same event as a sentence, for assistive tech.
 *
 * Split out of the visual so the announcement is not tied to the animation's
 * timing — the overlay is `aria-hidden` precisely because a card face read
 * aloud twice (old then new) is noise, not information.
 */
function cardMorphAnnouncement(request: CardMorphRequest, name: (card: CardInstance) => string) {
  return request.kind === 'upgrade'
    ? `${name(request.from!)} upgraded to ${name(request.to!)}.`
    : request.kind === 'transform'
      ? `${name(request.from!)} transformed into ${name(request.to!)}.`
      : request.kind === 'remove'
        ? `Removed ${name(request.from!)}.`
        : `Gained ${name(request.to!)}.`
}

/**
 * The morph, spoken.
 *
 * Its own component because it needs a render between entries. A live region
 * announces on DOM MUTATION, and `dismiss` slices straight from one queued
 * request to the next with no gap — so two morphs carrying the SAME sentence
 * were an `Object.is` bail: no mutation, nothing spoken the second time. That
 * is the common case rather than an exotic one, because the effects that queue
 * several at once tend to produce identical text — Whetstone upgrades a starter
 * Strike and another Attack (usually another Strike), War Paint the same shape,
 * Astrolabe three cards.
 *
 * Blanking and then speaking is the fix, NOT re-keying the element: a live
 * region has to be in the DOM before its text changes, so replacing the node
 * would leave some screen readers silent for every announcement, not just the
 * repeats.
 */
export function CardMorphAnnouncement({ request, name }: {
  request: CardMorphRequest | null
  name: (card: CardInstance) => string
}) {
  const [spoken, setSpoken] = useState('')
  const key = request?.key

  useEffect(() => {
    if (!request) {
      setSpoken('')
      return undefined
    }
    setSpoken('')
    const speak = setTimeout(() => setSpoken(cardMorphAnnouncement(request, name)), 60)
    return () => clearTimeout(speak)
    // Keyed on the request identity: `name` is an inline closure at both call
    // sites and would re-run this every render if it were a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return <p className="visually-hidden" aria-live="polite">{spoken}</p>
}
