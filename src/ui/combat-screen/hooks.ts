// The screen's senses: what just changed on the board, and what that should look
// and sound like.
//
// Each hook watches one thing — a struck enemy, a falling card, a sound cue, the
// presentation feed, the reduced-motion setting — and either hands back the
// derived state the screen renders from or plays the sound the change calls for.
// What they watch arrives as arguments or from the browser; none of them reaches
// into the component that calls it.
import { characterAttackContactMs, ORB_END_TURN_STAGGER_MS,
  SLIME_COMMAND_ANIMATION_MS } from './vfx.tsx'
import { cardDef } from '../../game/cards.ts'
import type { CombatPresentationEvent, CombatState } from '../../game/combat.ts'
import { drawnCardUids } from '../board-signals.ts'
import { cardSfxRecipe, potionSfxRecipe, shivSfxRecipe } from '../combat-sfx.ts'
import { playCombatSound, playSoundEffect } from '../sfx.ts'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export const ACTOR_DEFEAT_MS = 1_800

export type TargetContactDeadline = { at: number; throughSeq: number }

function slimeAnimationDelays(
  events: readonly CombatPresentationEvent[],
  queueEnd: Map<string, number>,
): Map<number, number> {
  const now = performance.now()
  const delays = new Map<number, number>()
  const batchStart = new Map<string, number>()
  for (const event of events) {
    if (event.kind === 'slime') {
      const key = `command:${event.actorId}:${event.slimeUid}`
      if (event.animationIndex === 0 || !batchStart.has(key)) {
        batchStart.set(key, Math.max(now, queueEnd.get(key) ?? now))
      }
      const start = batchStart.get(key)!
      delays.set(event.seq, start - now + event.animationIndex * SLIME_COMMAND_ANIMATION_MS)
      queueEnd.set(key, Math.max(queueEnd.get(key) ?? now,
        start + (event.animationIndex + 1) * SLIME_COMMAND_ANIMATION_MS))
      continue
    }
    const key = event.kind === 'card' && cardDef(event.sourceId).cardKind === 'slime'
      ? `spawn:${event.actorId}`
      : undefined
    if (!key) continue
    const start = Math.max(now, queueEnd.get(key) ?? now)
    delays.set(event.seq, start - now)
    queueEnd.set(key, start + SLIME_COMMAND_ANIMATION_MS)
  }
  return delays
}

function updateTargetContactDeadlines(
  state: CombatState,
  events: readonly CombatPresentationEvent[],
  queueEnd: Map<string, number>,
  deadlines: Map<string, TargetContactDeadline>,
): Map<number, number> {
  const delays = slimeAnimationDelays(events, queueEnd)
  const now = performance.now()
  for (const [target, deadline] of deadlines) {
    if (deadline.at <= now) deadlines.set(target, { ...deadline, at: 0 })
  }
  for (const event of events) {
    for (const target of new Set([...event.enemyIds, ...event.playerIds])) {
      const existing = deadlines.get(target)
      const slimeAnimation = event.kind === 'slime' ||
        event.kind === 'card' && cardDef(event.sourceId).cardKind === 'slime'
      const contact = slimeAnimation
        ? 800 + (delays.get(event.seq) ?? 0)
        : characterAttackContactMs(state, target, event)
      deadlines.set(target, {
        at: contact > 0 ? Math.max(existing?.at ?? now, now + contact) : existing?.at ?? 0,
        throughSeq: Math.max(existing?.throughSeq ?? -1, event.seq),
      })
    }
  }
  return delays
}

const remainingTargetContactMs = (
  deadlines: ReadonlyMap<string, TargetContactDeadline>,
  targetId: string,
): number => Math.max(0, (deadlines.get(targetId)?.at ?? 0) - performance.now())

function shouldReduceMotion(): boolean {
  const root = document.documentElement.dataset
  // Phones expose this choice in-game; do not let an invisible iOS preference
  // erase combat while the visible toggle is off.
  return root.reducedMotion === 'true' ||
    root.mobilePerformance !== 'true' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function useReducedEffects(): boolean {
  const [reduced, setReduced] = useState(shouldReduceMotion)
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const sync = () => setReduced(shouldReduceMotion())
    const observer = new MutationObserver(sync)
    sync()
    query.addEventListener('change', sync)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-reduced-motion', 'data-mobile-performance'],
    })
    return () => {
      query.removeEventListener('change', sync)
      observer.disconnect()
    }
  }, [])
  return reduced
}

export const usePrefersReducedMotion = useReducedEffects

/** Keeps overlapping HP-loss bursts until each impact finishes. */
export function useStruck(
  state: CombatState,
  authoritativeRestoration?: number,
  authoritativeConnected?: boolean,
  reducedEffects = false,
): {
  hits: Map<string, { beat: number; damage: number; delayMs: number }[]>
} {
  const previous = useRef(new Map<string, number>())
  const previousRestoration = useRef(authoritativeRestoration)
  const previousConnected = useRef(authoritativeConnected)
  const previousCombat = useRef(state.combatId)
  const previousPresentationSeq = useRef(state.presentationEvents?.at(-1)?.seq ?? -1)
  const previousReducedEffects = useRef(reducedEffects)
  const slimeQueueEnd = useRef(new Map<string, number>())
  const contactDeadlines = useRef(new Map<string, TargetContactDeadline>())
  const nextBeats = useRef(new Map<string, number>())
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const [hits, setHits] = useState<Map<string, { beat: number; damage: number; delayMs: number }[]>>(new Map())

  useEffect(() => {
    const now = new Map<string, number>()
    const hurt = new Map<string, number>()
    const presentationEvents = state.presentationEvents ?? []
    const latestPresentation = presentationEvents.at(-1)
    const newPresentations = presentationEvents.filter((event) => event.seq > previousPresentationSeq.current)
    const newPresentation = latestPresentation && latestPresentation.seq > previousPresentationSeq.current
      ? latestPresentation
      : undefined
    const combatChanged = state.combatId !== previousCombat.current
    const motionCollapsed = reducedEffects && !previousReducedEffects.current
    previousReducedEffects.current = reducedEffects
    previousCombat.current = state.combatId
    previousPresentationSeq.current = combatChanged
      ? (latestPresentation?.seq ?? -1)
      : Math.max(previousPresentationSeq.current, latestPresentation?.seq ?? -1)
    const refreshed = (authoritativeRestoration !== undefined && authoritativeRestoration !== previousRestoration.current) ||
      authoritativeConnected === false || previousConnected.current === false || combatChanged
    previousRestoration.current = authoritativeRestoration
    previousConnected.current = authoritativeConnected
    if (refreshed || reducedEffects) {
      slimeQueueEnd.current.clear()
      contactDeadlines.current.clear()
    } else {
      updateTargetContactDeadlines(state, newPresentations, slimeQueueEnd.current, contactDeadlines.current)
    }
    for (const entity of [...state.players, ...state.enemies]) {
      const id = 'uid' in entity ? entity.uid : entity.id
      now.set(id, entity.hp)
      const before = previous.current.get(id)
      if (!refreshed && before !== undefined && entity.hp < before) {
        hurt.set(id, before - entity.hp)
      }
    }
    previous.current = now
    if (motionCollapsed) {
      for (const timer of timers.current.values()) clearTimeout(timer)
      timers.current.clear()
      nextBeats.current.clear()
      setHits((current) => current.size === 0 ? current : new Map())
    }
    if (refreshed) {
      for (const timer of timers.current.values()) clearTimeout(timer)
      timers.current.clear()
      nextBeats.current.clear()
      setHits((current) => current.size === 0 ? current : new Map())
      return
    }
    if (hurt.size === 0) return

    if (state.phase !== 'lost' && state.players.some((player) => hurt.has(player.id))) playSoundEffect('hurt')

    // Each actor owns its contact, beat and expiry so concurrent damage numbers
    // do not cancel one another.
    for (const [id, amount] of hurt) {
      const beat = (nextBeats.current.get(id) ?? 0) + 1
      const token = `${id}:${beat}`
      nextBeats.current.set(id, beat)
      const delay = reducedEffects
        ? 0
        : remainingTargetContactMs(contactDeadlines.current, id) || characterAttackContactMs(state, id, newPresentation)
      setHits((current) => {
        const next = new Map(current)
        next.set(id, [...(next.get(id) ?? []), { beat, damage: amount, delayMs: delay }])
        return next
      })
      timers.current.set(`${token}:cleanup`, setTimeout(() => {
        timers.current.delete(`${token}:cleanup`)
        setHits((current) => {
          const remaining = (current.get(id) ?? []).filter((hit) => hit.beat !== beat)
          const next = new Map(current)
          if (remaining.length > 0) next.set(id, remaining)
          else next.delete(id)
          return next
        })
      }, delay + 600))
    }
  }, [authoritativeConnected, authoritativeRestoration, reducedEffects, state])

  useEffect(() => () => {
    for (const timer of timers.current.values()) clearTimeout(timer)
  }, [])

  return { hits }
}

export function useCombatSoundEffects(
  state: CombatState,
  viewerId: string,
  animateOpeningHand: boolean,
  authoritativeRestoration?: number,
  authoritativeConnected?: boolean,
) {
  const previous = useRef<CombatState | null>(null)
  const previousViewer = useRef(viewerId)
  const previousRestoration = useRef(authoritativeRestoration)
  const previousConnected = useRef(authoritativeConnected)

  useEffect(() => {
    const before = previous.current
    const restored = (authoritativeRestoration !== undefined &&
      authoritativeRestoration !== previousRestoration.current) ||
      authoritativeConnected === false || previousConnected.current === false || previousViewer.current !== viewerId
    previous.current = state
    previousViewer.current = viewerId
    previousRestoration.current = authoritativeRestoration
    previousConnected.current = authoritativeConnected

    const viewer = state.players.find((player) => player.id === viewerId)
    if (!before) {
      if (animateOpeningHand && viewer?.hand.length) playSoundEffect('draw')
      return
    }
    if (restored || state.phase === 'won' || state.phase === 'lost') return
    const previousPresentationSeq = before.presentationEvents?.at(-1)?.seq ?? 0
    const actionPresented = (state.presentationEvents?.at(-1)?.seq ?? 0) > previousPresentationSeq
    const priorPlayers = new Map(before.players.map((player) => [player.id, player]))
    if (!actionPresented && state.players.some((player) =>
      player.hp > (priorPlayers.get(player.id)?.hp ?? player.hp))) {
      playSoundEffect('heal')
    }
    const priorViewer = before.players.find((player) => player.id === viewerId)
    if (!actionPresented && viewer && priorViewer && drawnCardUids(priorViewer.hand, viewer.hand).length > 0) {
      playSoundEffect('draw')
    }
    if (!actionPresented && state.players.some((player) =>
      player.block !== (priorPlayers.get(player.id)?.block ?? player.block))) {
      playSoundEffect('block')
    }
  }, [animateOpeningHand, authoritativeConnected, authoritativeRestoration, state, viewerId])
}

/** Actors that crossed from alive to dead during this mounted combat. */
export function useFalling(
  state: CombatState,
  authoritativeRestoration?: number,
  authoritativeConnected?: boolean,
  reducedEffects = false,
): Set<string> {
  const previous = useRef(new Map<string, boolean>())
  const previousRestoration = useRef(authoritativeRestoration)
  const previousConnected = useRef(authoritativeConnected)
  const previousCombat = useRef(state.combatId)
  const previousPresentationSeq = useRef(state.presentationEvents?.at(-1)?.seq ?? -1)
  const slimeQueueEnd = useRef(new Map<string, number>())
  const contactDeadlines = useRef(new Map<string, TargetContactDeadline>())
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const [falling, setFalling] = useState<Set<string>>(new Set())

  // Include a transition in the render that first observes it. Waiting for the
  // effect would let the board remove the dead enemy for one commit, remount it,
  // and lose EnemyCard's contact-timed HP/death snapshot.
  //
  // This only fires on an *observed* alive-to-dead transition, comparing this
  // render against the last one this hook actually rendered. Re-killing an
  // enemy that was already dead the last time this hook saw it (e.g. a test
  // fixture reusing a corpse's uid without reviving it first) never satisfies
  // `previous.current.get(id) === false`, so it skips straight to being
  // filtered out of `displayedEnemies` with no grace period at all — revive it
  // (and let that render) before killing it again if a falling/`.enemy--dead`
  // transition needs to be observable.
  const refreshed = (authoritativeRestoration !== undefined && authoritativeRestoration !== previousRestoration.current) ||
    authoritativeConnected === false || previousConnected.current === false || state.combatId !== previousCombat.current
  const visibleFalling = new Set(falling)
  if (!refreshed && !reducedEffects) for (const entity of [...state.players, ...state.enemies]) {
    const id = 'uid' in entity ? entity.uid : entity.id
    if (previous.current.get(id) === false && entity.dead) visibleFalling.add(id)
  }

  useEffect(() => {
    const now = new Map<string, boolean>()
    const presentationEvents = state.presentationEvents ?? []
    const latestPresentation = presentationEvents.at(-1)
    const newPresentations = presentationEvents.filter((event) => event.seq > previousPresentationSeq.current)
    const combatChanged = state.combatId !== previousCombat.current
    previousCombat.current = state.combatId
    previousPresentationSeq.current = combatChanged
      ? (latestPresentation?.seq ?? -1)
      : Math.max(previousPresentationSeq.current, latestPresentation?.seq ?? -1)
    previousRestoration.current = authoritativeRestoration
    previousConnected.current = authoritativeConnected
    if (refreshed || reducedEffects) {
      slimeQueueEnd.current.clear()
      contactDeadlines.current.clear()
    } else {
      updateTargetContactDeadlines(state, newPresentations, slimeQueueEnd.current, contactDeadlines.current)
    }
    for (const entity of [...state.players, ...state.enemies]) {
      const id = 'uid' in entity ? entity.uid : entity.id
      now.set(id, entity.dead)
      if (refreshed || reducedEffects) continue
      if (previous.current.get(id) !== false || !entity.dead) continue
      const delay = remainingTargetContactMs(contactDeadlines.current, id)
      setFalling((current) => new Set(current).add(id))
      const prior = timers.current.get(id)
      if (prior) clearTimeout(prior)
      timers.current.set(id, setTimeout(() => {
        timers.current.delete(id)
        setFalling((current) => {
          const next = new Set(current)
          next.delete(id)
          return next
        })
      }, ACTOR_DEFEAT_MS + delay))
    }
    previous.current = now
    if (!refreshed && !reducedEffects) return
    for (const timer of timers.current.values()) clearTimeout(timer)
    timers.current.clear()
    setFalling((current) => current.size === 0 ? current : new Set())
  }, [authoritativeConnected, authoritativeRestoration, reducedEffects, state])

  useEffect(() => () => {
    for (const timer of timers.current.values()) clearTimeout(timer)
  }, [])

  return visibleFalling
}

/** Only actions witnessed live animate; mounted and restored history is a baseline. */
export function usePresentationEvents(
  state: CombatState,
  animateOpeningHand: boolean,
  authoritativeRestoration?: number,
  authoritativeConnected?: boolean,
  reducedEffects = false,
): { events: CombatPresentationEvent[]; contactDeadlines: ReadonlyMap<string, TargetContactDeadline> } {
  const baseline = useRef<number | null>(animateOpeningHand ? -1 : null)
  const previousCombat = useRef(state.combatId)
  const previousRestoration = useRef(authoritativeRestoration)
  const previousConnected = useRef(authoritativeConnected)
  const previousReducedEffects = useRef(reducedEffects)
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())
  const slimeQueueEnd = useRef(new Map<string, number>())
  const [active, setActive] = useState<CombatPresentationEvent[]>([])
  const contactDeadlines = useRef(new Map<string, TargetContactDeadline>())
  const [targetContactDeadlines, setTargetContactDeadlines] =
    useState<ReadonlyMap<string, TargetContactDeadline>>(new Map())

  useLayoutEffect(() => {
    const events = state.presentationEvents ?? []
    const latest = events.reduce((seq, event) => Math.max(seq, event.seq), -1)
    const combatChanged = state.combatId !== previousCombat.current
    const restored = (authoritativeRestoration !== undefined &&
      authoritativeRestoration !== previousRestoration.current) ||
      authoritativeConnected === false || previousConnected.current === false
    const motionChanged = reducedEffects !== previousReducedEffects.current
    previousCombat.current = state.combatId
    previousRestoration.current = authoritativeRestoration
    previousConnected.current = authoritativeConnected
    previousReducedEffects.current = reducedEffects

    if (baseline.current === null || combatChanged || restored || reducedEffects || motionChanged) {
      baseline.current = combatChanged ? latest : Math.max(baseline.current ?? -1, latest)
      for (const timer of timers.current.values()) clearTimeout(timer)
      timers.current.clear()
      slimeQueueEnd.current.clear()
      contactDeadlines.current.clear()
      setActive((current) => current.length === 0 ? current : [])
      setTargetContactDeadlines((current) => current.size === 0 ? current : new Map())
      return
    }

    const unseen = events.filter((event) => event.seq > baseline.current!)
    baseline.current = Math.max(baseline.current, latest)
    if (unseen.length === 0) return
    const delays = updateTargetContactDeadlines(state, unseen, slimeQueueEnd.current, contactDeadlines.current)
    setTargetContactDeadlines(new Map(contactDeadlines.current))
    const immediate = unseen.filter((event) => (delays.get(event.seq) ?? 0) === 0)
    setActive((current) => [
      ...current.filter((event) => !unseen.some((next) => next.seq === event.seq)),
      ...immediate,
    ])
    // Multiple end-of-turn orbs can arrive in this same batch (the engine
    // resolves the whole ordered list before the client sees any of it), and
    // CombatScreen staggers their reveal so the later ones do not flash on the
    // same frame as the first — see ORB_END_TURN_STAGGER_MS. That stagger is
    // wasted if THIS timer still unmounts the later event on the ORIGINAL
    // schedule: a third orb reveal starting at +760ms has nothing left to show
    // by the unstaggered ~900ms cutoff. Each orb-end-turn event's lifetime is
    // extended by its own position among its same-batch siblings.
    const orbEndTurnOrder = unseen
      .filter((event) => event.kind === 'orb' && event.sourceId === 'orb-end-turn')
      .sort((a, b) => a.seq - b.seq)
    for (const event of unseen) {
      const prior = timers.current.get(event.seq)
      if (prior) clearTimeout(prior)
      const lastTarget = event.enemyIds.at(-1)
      const staggerIndex = event.kind === 'orb' && event.sourceId === 'orb-end-turn'
        ? orbEndTurnOrder.findIndex((candidate) => candidate.seq === event.seq)
        : 0
      const attackContact = lastTarget
        // Contact is followed by a 500–600ms impact and a 500–600ms recovery.
        // Leave one frame-budget margin so a busy mobile renderer cannot
        // unmount the last pose before it paints.
        ? characterAttackContactMs(state, lastTarget, event)
        : 0
      const slimeAnimation = event.kind === 'slime' ||
        event.kind === 'card' && cardDef(event.sourceId).cardKind === 'slime'
      const delay = delays.get(event.seq) ?? 0
      const localAttackContact = event.kind === 'slime' ? 800 : Math.max(0, attackContact - delay)
      const lifetime = (localAttackContact > 0
        ? Math.max(1_800, localAttackContact + 1_200)
        : slimeAnimation ? 1_650 : 900) +
        staggerIndex * ORB_END_TURN_STAGGER_MS
      const remove = () => timers.current.set(event.seq, setTimeout(() => {
        timers.current.delete(event.seq)
        setActive((current) => current.filter((candidate) => candidate.seq !== event.seq))
      }, lifetime))
      if (delay === 0) remove()
      else timers.current.set(event.seq, setTimeout(() => {
        setActive((current) => [
          ...current.filter((candidate) => candidate.seq !== event.seq),
          event,
        ])
        remove()
      }, delay))
    }
  }, [authoritativeConnected, authoritativeRestoration, reducedEffects, state.combatId, state.presentationEvents])

  useEffect(() => () => {
    for (const timer of timers.current.values()) clearTimeout(timer)
  }, [])

  return { events: active, contactDeadlines: targetContactDeadlines }
}

export function usePersonalCombatSoundEffects(
  state: CombatState,
  events: readonly CombatPresentationEvent[],
  authoritativeRestoration?: number,
  authoritativeConnected?: boolean,
  reducedMotion = false,
) {
  const combatId = useRef(state.combatId)
  const played = useRef(new Set<number>())
  const pending = useRef(new Map<number, () => void>())
  const impactDue = useRef(new Map<number, number>())
  const previousReducedMotion = useRef(reducedMotion)
  const previousRestoration = useRef(authoritativeRestoration)
  const previousConnected = useRef(authoritativeConnected)

  useEffect(() => {
    const motionCollapsed = !previousReducedMotion.current && reducedMotion
    previousReducedMotion.current = reducedMotion
    const reset = combatId.current !== state.combatId ||
      authoritativeRestoration !== undefined && authoritativeRestoration !== previousRestoration.current ||
      authoritativeConnected === false || previousConnected.current === false
    combatId.current = state.combatId
    previousRestoration.current = authoritativeRestoration
    previousConnected.current = authoritativeConnected
    if (reset) {
      for (const cancel of pending.current.values()) cancel()
      pending.current.clear()
      impactDue.current.clear()
      played.current.clear()
      return
    }
    const active = new Set(events.map((event) => event.seq))
    for (const [seq, cancel] of pending.current) {
      if (active.has(seq)) continue
      cancel()
      pending.current.delete(seq)
      impactDue.current.delete(seq)
    }
    if (motionCollapsed) for (const event of events) {
      if (!played.current.has(event.seq) || event.kind === 'potion' || event.kind === 'orb' ||
        event.kind === 'slime') continue
      if ((impactDue.current.get(event.seq) ?? 0) <= performance.now()) continue
      const target = event.enemyIds[0]
      if (!target || characterAttackContactMs(state, target, event) <= 0) continue
      const actor = state.players.find((player) => player.id === event.actorId)
      if (event.kind !== 'shiv' && !actor) continue
      const recipe = event.kind === 'shiv' ? shivSfxRecipe() :
        cardSfxRecipe(actor!.character, event.sourceId, event.mode, event.upgraded, event.resolvedType)
      pending.current.get(event.seq)?.()
      pending.current.set(event.seq, playCombatSound(recipe, 0, true))
      impactDue.current.delete(event.seq)
    }
    for (const event of events) {
      if (played.current.has(event.seq)) continue
      if (event.kind === 'potion') {
        played.current.add(event.seq)
        pending.current.set(event.seq, playCombatSound(potionSfxRecipe(event.sourceId)))
        continue
      }
      if (event.kind === 'shiv') {
        played.current.add(event.seq)
        const target = event.enemyIds[0]
        const contact = !reducedMotion && target ? characterAttackContactMs(state, target, event) : 0
        pending.current.set(event.seq, playCombatSound(shivSfxRecipe(),
          contact))
        if (contact > 0) impactDue.current.set(event.seq, performance.now() + contact)
        continue
      }
      if (event.kind === 'orb') {
        played.current.add(event.seq)
        continue
      }
      if (event.kind === 'slime') {
        played.current.add(event.seq)
        continue
      }
      const actor = state.players.find((player) => player.id === event.actorId)
      if (!actor) continue
      played.current.add(event.seq)
      const target = event.enemyIds[0]
      const contact = !reducedMotion && target ? characterAttackContactMs(state, target, event) : 0
      pending.current.set(event.seq,
        playCombatSound(cardSfxRecipe(
          actor.character, event.sourceId, event.mode, event.upgraded, event.resolvedType,
        ),
          contact))
      if (contact > 0) impactDue.current.set(event.seq, performance.now() + contact)
    }
  }, [authoritativeConnected, authoritativeRestoration, events, reducedMotion, state.combatId, state.players])

  useEffect(() => () => {
    for (const cancel of pending.current.values()) cancel()
    pending.current.clear()
    impactDue.current.clear()
  }, [])
}
