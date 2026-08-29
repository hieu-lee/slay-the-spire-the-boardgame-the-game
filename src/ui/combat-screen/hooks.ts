// The screen's senses: what just changed on the board, and what that should look
// and sound like.
//
// Each hook watches one thing — a struck enemy, a falling card, a sound cue, the
// presentation feed, the reduced-motion setting — and either hands back the
// derived state the screen renders from or plays the sound the change calls for.
// What they watch arrives as arguments or from the browser; none of them reaches
// into the component that calls it.
import { characterAttackContactMs, latestTargetPresentationEvent, ORB_END_TURN_STAGGER_MS } from './vfx.tsx'
import type { CombatPresentationEvent, CombatState } from '../../game/combat.ts'
import { drawnCardUids } from '../board-signals.ts'
import { cardSfxRecipe, potionSfxRecipe, shivSfxRecipe } from '../combat-sfx.ts'
import { playCombatSound, playSoundEffect } from '../sfx.ts'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export const ACTOR_DEFEAT_MS = 1_800

export function useReducedEffects(): boolean {
  const prefersReducedEffects = () =>
    window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
    document.documentElement.dataset.reducedMotion === 'true' ||
    document.documentElement.dataset.mobilePerformance === 'true'
  const [reduced, setReduced] = useState(prefersReducedEffects)
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const sync = () => setReduced(prefersReducedEffects())
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

/**
 * Whether the PLAYER asked for less motion — never whether their hardware is
 * weak. `useReducedEffects` folds `data-mobile-performance` into the same flag
 * on purpose for most of the screen's ambient flourish, where a cheaper
 * animation and no animation cost about the same to build. The signature
 * attack sequence is not that case: on a phone, `useReducedEffects` being true
 * was quietly skipping the whole character-attack computation (CombatScreen's
 * `characterAttacks` effect) and zeroing `characterAttackContactMs`, so an
 * attack that had nowhere to travel from landed as an instant flash with no
 * windup — worse than the plain lunge a phone can render cheaply, and nothing
 * a phone's weaker hardware asked for. Only genuine motion sensitivity should
 * cut the travel and the wait for it; being on a phone should just make both
 * cheaper, which CombatScreen's mobile-only keyframes already do.
 */
export function usePrefersReducedMotion(): boolean {
  const prefersReducedMotion = () =>
    window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
    document.documentElement.dataset.reducedMotion === 'true'
  const [reduced, setReduced] = useState(prefersReducedMotion)
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const sync = () => setReduced(prefersReducedMotion())
    const observer = new MutationObserver(sync)
    sync()
    query.addEventListener('change', sync)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-reduced-motion'],
    })
    return () => {
      query.removeEventListener('change', sync)
      observer.disconnect()
    }
  }, [])
  return reduced
}

/** Keeps overlapping HP-loss bursts and additive portrait flinches until each impact finishes. */
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
  const nextBeats = useRef(new Map<string, number>())
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const flinches = useRef(new Set<Animation>())
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
    previousCombat.current = state.combatId
    previousPresentationSeq.current = combatChanged
      ? (latestPresentation?.seq ?? -1)
      : Math.max(previousPresentationSeq.current, latestPresentation?.seq ?? -1)
    const refreshed = (authoritativeRestoration !== undefined && authoritativeRestoration !== previousRestoration.current) ||
      authoritativeConnected === false || previousConnected.current === false || combatChanged
    previousRestoration.current = authoritativeRestoration
    previousConnected.current = authoritativeConnected
    for (const entity of [...state.players, ...state.enemies]) {
      const id = 'uid' in entity ? entity.uid : entity.id
      now.set(id, entity.hp)
      const before = previous.current.get(id)
      if (!refreshed && before !== undefined && entity.hp < before) {
        hurt.set(id, before - entity.hp)
      }
    }
    previous.current = now
    if (refreshed) {
      for (const timer of timers.current.values()) clearTimeout(timer)
      timers.current.clear()
      for (const animation of flinches.current) animation.cancel()
      flinches.current.clear()
      nextBeats.current.clear()
      setHits((current) => current.size === 0 ? current : new Map())
      return
    }
    if (hurt.size === 0) return

    if (state.phase !== 'lost' && state.players.some((player) => hurt.has(player.id))) playSoundEffect('hurt')

    // Each actor owns its contact, beat and expiry. Concurrent hits must not
    // cancel one another, while a second hit must restart at weapon contact.
    for (const [id, amount] of hurt) {
      const beat = (nextBeats.current.get(id) ?? 0) + 1
      const token = `${id}:${beat}`
      nextBeats.current.set(id, beat)
      const targetPresentation = latestTargetPresentationEvent(newPresentations, id)
      const delay = reducedEffects
        ? 0
        : characterAttackContactMs(state, id, targetPresentation ?? newPresentation)
      setHits((current) => {
        const next = new Map(current)
        next.set(id, [...(next.get(id) ?? []), { beat, damage: amount, delayMs: delay }])
        return next
      })
      const flinch = () => {
        timers.current.delete(`${token}:flinch`)
        if (reducedEffects) return
        const escaped = CSS.escape(id)
        const portrait = document.querySelector<HTMLElement>(
          `.enemy[data-enemy-id="${escaped}"] .enemy__portrait, ` +
          `.seat[data-player-id="${escaped}"] .seat__portrait`,
        )
        const animation = portrait?.animate([
          { transform: 'translateX(0)', composite: 'add' },
          { transform: 'translateX(-7px) scale(0.98)', composite: 'add', offset: 0.18 },
          { transform: 'translateX(5px)', composite: 'add', offset: 0.42 },
          { transform: 'translateX(-2px)', composite: 'add', offset: 0.68 },
          { transform: 'translateX(0)', composite: 'add' },
        ], { duration: 380, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' })
        if (animation) {
          flinches.current.add(animation)
          animation.onfinish = animation.oncancel = () => flinches.current.delete(animation)
        }
      }
      if (delay > 0) timers.current.set(`${token}:flinch`, setTimeout(flinch, delay))
      else flinch()
      timers.current.set(`${token}:cleanup`, setTimeout(() => {
        timers.current.delete(`${token}:cleanup`)
        setHits((current) => {
          const remaining = (current.get(id) ?? []).filter((hit) => hit.beat !== beat)
          const next = new Map(current)
          if (remaining.length > 0) next.set(id, remaining)
          else next.delete(id)
          return next
        })
      }, delay + 520))
    }
  }, [authoritativeConnected, authoritativeRestoration, reducedEffects, state])

  useEffect(() => () => {
    for (const timer of timers.current.values()) clearTimeout(timer)
    for (const animation of flinches.current) animation.cancel()
    flinches.current.clear()
  }, [])

  useEffect(() => {
    if (!reducedEffects) return
    for (const [key, timer] of timers.current) {
      if (!key.endsWith(':flinch')) continue
      clearTimeout(timer)
      timers.current.delete(key)
    }
    for (const animation of flinches.current) animation.cancel()
    flinches.current.clear()
  }, [reducedEffects])

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
): Set<string> {
  const previous = useRef(new Map<string, boolean>())
  const previousRestoration = useRef(authoritativeRestoration)
  const previousConnected = useRef(authoritativeConnected)
  const previousCombat = useRef(state.combatId)
  const previousPresentationSeq = useRef(state.presentationEvents?.at(-1)?.seq ?? -1)
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const [falling, setFalling] = useState<Set<string>>(new Set())

  // Include a transition in the render that first observes it. Waiting for the
  // effect would let the board remove the dead enemy for one commit, remount it,
  // and lose EnemyCard's contact-timed HP/death snapshot.
  const refreshed = (authoritativeRestoration !== undefined && authoritativeRestoration !== previousRestoration.current) ||
    authoritativeConnected === false || previousConnected.current === false || state.combatId !== previousCombat.current
  const visibleFalling = new Set(falling)
  if (!refreshed) for (const entity of [...state.players, ...state.enemies]) {
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
    for (const entity of [...state.players, ...state.enemies]) {
      const id = 'uid' in entity ? entity.uid : entity.id
      now.set(id, entity.dead)
      if (refreshed) continue
      if (previous.current.get(id) !== false || !entity.dead) continue
      const delay = characterAttackContactMs(state, id, latestTargetPresentationEvent(newPresentations, id))
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
    if (!refreshed) return
    for (const timer of timers.current.values()) clearTimeout(timer)
    timers.current.clear()
    setFalling((current) => current.size === 0 ? current : new Set())
  }, [authoritativeConnected, authoritativeRestoration, state])

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
): CombatPresentationEvent[] {
  const baseline = useRef<number | null>(animateOpeningHand ? -1 : null)
  const previousCombat = useRef(state.combatId)
  const previousRestoration = useRef(authoritativeRestoration)
  const previousConnected = useRef(authoritativeConnected)
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())
  const [active, setActive] = useState<CombatPresentationEvent[]>([])

  useLayoutEffect(() => {
    const events = state.presentationEvents ?? []
    const latest = events.reduce((seq, event) => Math.max(seq, event.seq), -1)
    const combatChanged = state.combatId !== previousCombat.current
    const restored = (authoritativeRestoration !== undefined &&
      authoritativeRestoration !== previousRestoration.current) ||
      authoritativeConnected === false || previousConnected.current === false
    previousCombat.current = state.combatId
    previousRestoration.current = authoritativeRestoration
    previousConnected.current = authoritativeConnected

    if (baseline.current === null || combatChanged || restored) {
      baseline.current = combatChanged ? latest : Math.max(baseline.current ?? -1, latest)
      for (const timer of timers.current.values()) clearTimeout(timer)
      timers.current.clear()
      setActive((current) => current.length === 0 ? current : [])
      return
    }

    const unseen = events.filter((event) => event.seq > baseline.current!)
    baseline.current = Math.max(baseline.current, latest)
    if (unseen.length === 0) return
    setActive((current) => [
      ...current.filter((event) => !unseen.some((next) => next.seq === event.seq)),
      ...unseen,
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
      const lifetime = Math.max(900, lastTarget
        // The target burst runs for 300ms after contact. Leave one frame-budget
        // margin for a busy mobile renderer so the event cannot unmount before
        // the delayed final impact paints.
        ? characterAttackContactMs(state, lastTarget, event) + 420
        : 0) + staggerIndex * ORB_END_TURN_STAGGER_MS
      timers.current.set(event.seq, setTimeout(() => {
        timers.current.delete(event.seq)
        setActive((current) => current.filter((candidate) => candidate.seq !== event.seq))
      }, lifetime))
    }
  }, [authoritativeConnected, authoritativeRestoration, state.combatId, state.presentationEvents])

  useEffect(() => () => {
    for (const timer of timers.current.values()) clearTimeout(timer)
  }, [])

  return active
}

export function usePersonalCombatSoundEffects(
  state: CombatState,
  events: readonly CombatPresentationEvent[],
  authoritativeRestoration?: number,
  authoritativeConnected?: boolean,
) {
  const combatId = useRef(state.combatId)
  const played = useRef(new Set<number>())
  const pending = useRef(new Map<number, () => void>())
  const previousRestoration = useRef(authoritativeRestoration)
  const previousConnected = useRef(authoritativeConnected)

  useEffect(() => {
    const reset = combatId.current !== state.combatId ||
      authoritativeRestoration !== undefined && authoritativeRestoration !== previousRestoration.current ||
      authoritativeConnected === false || previousConnected.current === false
    combatId.current = state.combatId
    previousRestoration.current = authoritativeRestoration
    previousConnected.current = authoritativeConnected
    if (reset) {
      for (const cancel of pending.current.values()) cancel()
      pending.current.clear()
      played.current.clear()
      return
    }
    const active = new Set(events.map((event) => event.seq))
    for (const [seq, cancel] of pending.current) {
      if (active.has(seq)) continue
      cancel()
      pending.current.delete(seq)
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
        pending.current.set(event.seq, playCombatSound(shivSfxRecipe()))
        continue
      }
      if (event.kind === 'orb') {
        played.current.add(event.seq)
        continue
      }
      const actor = state.players.find((player) => player.id === event.actorId)
      if (!actor) continue
      played.current.add(event.seq)
      pending.current.set(event.seq,
        playCombatSound(cardSfxRecipe(actor.character, event.sourceId, event.mode, event.upgraded)))
    }
  }, [authoritativeConnected, authoritativeRestoration, events, state.combatId, state.players])

  useEffect(() => () => {
    for (const cancel of pending.current.values()) cancel()
    pending.current.clear()
  }, [])
}
