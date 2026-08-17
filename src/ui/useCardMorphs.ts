// Watching a deck for cards that changed, so the morph overlay fires wherever
// the change came from.
//
// The alternative was calling a "play the morph" function from every site that
// can upgrade or transform — the campfire's Smith, the reward screen's
// Transform, a dozen event options, Neow's blessings, Astrolabe. That is a
// dozen chances to forget one, and the engine is free to add a thirteenth. A
// deck diff cannot be forgotten: if the cardboard changed, the animation plays.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CardInstance } from '../game/types.ts'
import type { CardMorphRequest } from './CardMorph.tsx'

/**
 * Morphs implied by the difference between two decks.
 *
 * Upgrades are exact: same uid, `upgraded` went false to true.
 *
 * Transforms are inferred, because `transformCard` drops one uid and adds
 * another rather than editing in place — there is no field tying the two
 * together. The inference is deliberately narrow: exactly one card gone and
 * exactly one arrived in a single update. Gaining a card reward only adds,
 * removing at a campfire only subtracts, a status purge only subtracts, and
 * Pandora's Box swaps three for three — none of them trip it. A rule that ever
 * fired on a plain add would put a bogus animation over a reward screen, which
 * is worse than missing one, so it errs toward silence.
 *
 * Plain removals surface every departed card. They cannot be confused with a
 * transform because that shape also has an arrival.
 *
 * Gains are the one plain-add shape this DOES surface, and only when the
 * caller explicitly arms it (`gainArmed`): a card that was never shown to the
 * player before it landed in their deck — Neow's random Rare, an event's
 * random card reward. A reward screen's pick was already shown as a `Card`
 * before the player chose it, so those adds stay silent unless armed.
 *
 * ponytail: one shape it cannot tell apart is the Exchange event's `trade-card`
 * (event-room.ts), which also drops one uid and adds one. From the viewer's own
 * deck that IS a card leaving and a card arriving, so the animation is right and
 * only the caption's verb is wrong. Distinguishing them needs the engine to say
 * which it did; not worth a field for one event's wording. Multi-card transforms
 * are missed when they also add replacements; pure removals still queue normally.
 */
export function diffDeckMorphs(
  before: readonly CardInstance[],
  after: readonly CardInstance[],
  gainArmed = false,
): CardMorphRequest[] {
  const previous = new Map(before.map((card) => [card.uid, card]))
  const current = new Map(after.map((card) => [card.uid, card]))

  const upgrades = after
    .filter((card) => card.upgraded && previous.get(card.uid)?.upgraded === false)
    .map((card) => ({
      kind: 'upgrade' as const,
      from: { ...card, upgraded: false },
      to: card,
      key: `upgrade-${card.uid}`,
    }))

  const gone = before.filter((card) => !current.has(card.uid))
  const arrived = after.filter((card) => !previous.has(card.uid))
  const transforms = gone.length === 1 && arrived.length === 1 && upgrades.length === 0
    ? [{
      kind: 'transform' as const,
      from: gone[0]!,
      to: arrived[0]!,
      key: `transform-${gone[0]!.uid}-${arrived[0]!.uid}`,
    }]
    : []
  const removals = arrived.length === 0
    ? gone.map((card) => ({ kind: 'remove' as const, from: card, to: null, key: `remove-${card.uid}` }))
    : []
  const gains = gainArmed && transforms.length === 0
    ? arrived.map((card) => ({ kind: 'gain' as const, from: null, to: card, key: `gain-${card.uid}` }))
    : []

  return [...upgrades, ...transforms, ...removals, ...gains]
}

/**
 * What one deck update should do to the queue.
 *
 * Pulled out of the effect and exported because this decision has now caused
 * three separate regressions — a bogus transform across a run boundary, a veil
 * bleeding into combat, and then a re-baseline so eager it silenced the feature
 * on every path a solo player takes. It is four lines of branching that are
 * very easy to get subtly wrong, so it is testable on its own.
 *
 * - A NEW RUN discards everything. `createRun` resets the uid counter, so run
 *   B's starters reuse run A's ids and a diff across that seam reads the shape
 *   of an entire run as one-card-out/one-card-in.
 * - A NEW PHASE still diffs, then REPLACES. The engine's usual shape is to
 *   apply a deck change and advance the phase in the same state object —
 *   campfire Smith, most upgrade events, the last transform reward, a solo Neow
 *   blessing — so a phase change is where the interesting morphs actually
 *   arrive. Replacing rather than appending is what stops a morph from the
 *   previous screen dimming the next one.
 * - Otherwise APPEND, so several upgrades in one step (Astrolabe takes three)
 *   queue up and play in order.
 */
export type MorphPlan = {
  /** What the next update should diff against. */
  baseline: readonly CardInstance[] | null
  /** `replace` discards what is on screen first; `idle` leaves the queue alone. */
  mode: 'append' | 'replace' | 'idle'
  morphs: CardMorphRequest[]
}

export function planMorphs(
  before: readonly CardInstance[] | null,
  after: readonly CardInstance[] | undefined,
  runChanged: boolean,
  phaseChanged: boolean,
  gainArmed = false,
): MorphPlan {
  if (runChanged) return { baseline: after ?? null, mode: 'replace', morphs: [] }
  if (!after) return { baseline: null, mode: 'idle', morphs: [] }
  // No baseline yet: this deck is the baseline. Without it, mounting mid-run —
  // a reload, or restoring a save — would replay every upgrade already carried.
  if (!before) return { baseline: after, mode: 'idle', morphs: [] }
  const morphs = diffDeckMorphs(before, after, gainArmed)
  if (phaseChanged) return { baseline: after, mode: 'replace', morphs }
  return { baseline: after, mode: morphs.length > 0 ? 'append' : 'idle', morphs }
}

/**
 * The morph queue for one deck.
 *
 * Returns the request currently on screen, or null. Several at once play in
 * order rather than on top of one another.
 */
export function useCardMorphs(
  deck: readonly CardInstance[] | undefined,
  runId?: string,
  phase?: string,
): { current: CardMorphRequest | null; dismiss: () => void; armGain: () => void } {
  const previous = useRef<readonly CardInstance[] | null>(null)
  const previousRun = useRef(runId)
  const previousPhase = useRef(phase)
  const [queue, setQueue] = useState<CardMorphRequest[]>([])
  // Set right before an action that may silently add a random card (Neow's
  // random Rare, an event's random card reward), consumed by the very next
  // deck diff so it cannot leak onto a later, unrelated add. If that action
  // turns out to be rejected by the engine (deck reference unchanged), the
  // flag stays armed for whatever the next real deck change is — the same
  // narrow-inference trade-off the diff above already accepts elsewhere.
  const gainArmed = useRef(false)

  useEffect(() => {
    const runChanged = previousRun.current !== runId
    const phaseChanged = previousPhase.current !== phase
    previousRun.current = runId
    previousPhase.current = phase
    const armed = gainArmed.current
    gainArmed.current = false

    const plan = planMorphs(previous.current, deck, runChanged, phaseChanged, armed)
    previous.current = plan.baseline
    if (plan.mode === 'replace') setQueue(plan.morphs)
    else if (plan.mode === 'append') setQueue((pending) => [...pending, ...plan.morphs])
  }, [deck, runId, phase])

  // Stable across renders, and it has to be: `CardMorph` keys its beat timers on
  // this callback, the overlay deliberately lets clicks through to the run
  // underneath, and every one of those clicks re-renders the shell. A fresh
  // closure each render re-ran the effect, re-scheduled all three beats without
  // resetting `beat`, and made the card visibly run backwards from "new" to
  // "burn" — for as long as the player kept clicking. The functional updater
  // means there is nothing to close over.
  const dismiss = useCallback(() => setQueue((pending) => pending.slice(1)), [])
  const armGain = useCallback(() => { gainArmed.current = true }, [])

  return { current: queue[0] ?? null, dismiss, armGain }
}
