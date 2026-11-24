import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { cardDef, faceOf } from '../../game/cards.ts'
import type { CombatPresentationEvent, CombatState, PendingTriggerAbility } from '../../game/combat.ts'
import { hasStagedAttack, playerVisualId, type VisualId } from '../../game/skins.ts'
import type { CardInstance, Player } from '../../game/types.ts'
import { cardMotionDestination, drawnCardUids } from '../board-signals.ts'
import { combatBodyPoint } from '../combat-geometry.ts'
import { cardVfxRecipe, potionVfxRecipe, shivVfxRecipe } from '../combat-vfx.ts'
import { cardFlightPath } from './card-flight.ts'
import type { StagedAttackSpec } from './staged-attacks.ts'
import type {
  ActiveCombatVfx,
  CardFlight,
  CharacterAttackMotion,
  MotionKey,
  MotionSnapshot,
  Pending,
} from './types.ts'
import { isCharacterAttack, stagedAttackOf } from './vfx.tsx'

// Weighted alpha PCA of watcher-meteor.webp: tail-to-nose y/x.
const WATCHER_METEOR_FALL_SLOPE = 0.70505085 / 0.70915675

export function useCombatMotions({
  state,
  viewer,
  viewerId,
  drawCount,
  animateOpeningHand,
  authoritativeConnected,
  authoritativeRestoration,
  reducedMotion,
  prefersReducedMotion,
  boardRef,
  activeVfx,
  livePresentationEvents,
  stageScale,
  stagedPosesReadyByAttack,
  stagedPosesReady,
  monogatariPosesReadyByAttack,
  monogatariPosesReady,
  armedCardFlight,
  miracleOnCard,
  endTurnResolving,
  pending,
  pendingTrigger,
  usingCard,
}: {
  state: CombatState
  viewer: Player | undefined
  viewerId: string
  drawCount: number | undefined
  animateOpeningHand: boolean
  authoritativeConnected: boolean | undefined
  authoritativeRestoration: number | undefined
  reducedMotion: boolean
  prefersReducedMotion: boolean
  boardRef: RefObject<HTMLDivElement | null>
  activeVfx: readonly ActiveCombatVfx[]
  livePresentationEvents: readonly CombatPresentationEvent[]
  stageScale: number
  stagedPosesReadyByAttack: RefObject<Map<string, boolean>>
  stagedPosesReady: (visual: VisualId, spec: StagedAttackSpec, seq: number) => boolean
  monogatariPosesReadyByAttack: RefObject<Map<string, boolean>>
  monogatariPosesReady: (visual: string, seq: number) => boolean
  armedCardFlight: RefObject<{ card: CardInstance; chamber: boolean } | null>
  miracleOnCard: boolean
  endTurnResolving: boolean
  pending: Pending | null
  pendingTrigger: PendingTriggerAbility | null
  usingCard: boolean
}) {
  const motionBaseline = useRef<MotionSnapshot | null>(null)
  const motionRestoration = useRef(authoritativeRestoration)
  const motionConnected = useRef(authoritativeConnected)
  const motionViewer = useRef(viewerId)
  const motionTimers = useRef(new Map<MotionKey | `flight:${number}`, ReturnType<typeof setTimeout>>())
  const flightBeat = useRef(0)
  const [drawnCards, setDrawnCards] = useState<Set<string>>(new Set())
  const [cardFlights, setCardFlights] = useState<CardFlight[]>([])
  const [motionActive, setMotionActive] = useState<Set<MotionKey>>(new Set())
  const [motionBeats, setMotionBeats] = useState<Record<MotionKey, number>>({
    energy: 0,
    draw: 0,
    discard: 0,
    exhaust: 0,
  })
  const [characterAttacks, setCharacterAttacks] = useState<Record<string, CharacterAttackMotion[]>>({})
  const [slimeCommandMotions, setSlimeCommandMotions] = useState<Record<string, {
    seq: number
    x: number
    y: number
  }>>({})
  const [slimeLayoutVersion, setSlimeLayoutVersion] = useState(0)

  function pulseMotion(keys: MotionKey[]) {
    if (reducedMotion || keys.length === 0) return
    setMotionBeats((current) => {
      const updated = { ...current }
      for (const key of keys) updated[key] += 1
      return updated
    })
    setMotionActive((current) => new Set([...current, ...keys]))
    for (const key of keys) {
      const prior = motionTimers.current.get(key)
      if (prior) clearTimeout(prior)
      motionTimers.current.set(key, setTimeout(() => {
        motionTimers.current.delete(key)
        setMotionActive((current) => {
          const updated = new Set(current)
          updated.delete(key)
          return updated
        })
      }, 420))
    }
  }

  useEffect(() => {
    if (!reducedMotion) return
    for (const [key, timer] of motionTimers.current) {
      clearTimeout(timer)
      motionTimers.current.delete(key)
    }
    setCardFlights((current) => current.length === 0 ? current : [])
    setDrawnCards((current) => current.size === 0 ? current : new Set())
    setMotionActive((current) => current.size === 0 ? current : new Set())
  }, [reducedMotion])

  useLayoutEffect(() => {
    const board = boardRef.current
    if (!board) return
    if (prefersReducedMotion || !activeVfx.some(isCharacterAttack)) {
      stagedPosesReadyByAttack.current.clear()
      monogatariPosesReadyByAttack.current.clear()
      setCharacterAttacks((current) => Object.keys(current).length === 0 ? current : {})
      return
    }
    const enemies = [...board.querySelectorAll<HTMLElement>('.enemy')]
    const boardRect = board.getBoundingClientRect()
    const skyClearance = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
    const next: Record<string, CharacterAttackMotion[]> = {}
    for (const player of state.players) {
      const actorEvents = activeVfx.filter(({ event }) => event.actorId === player.id)
      const latestNonAttackSeq = (state.presentationEvents ?? []).reduce((latest, event) => {
        if (event.actorId !== player.id || event.kind === 'orb' || event.kind === 'slime' ||
          event.sourceId === 'fairy_in_a_bottle') return latest
        if (event.kind === 'turn') return Math.max(latest, event.seq)
        const recipe = event.kind === 'potion'
          ? potionVfxRecipe(event.sourceId)
          : event.kind === 'shiv'
            ? shivVfxRecipe()
            : cardVfxRecipe(playerVisualId(player), event.sourceId, event.mode, event.upgraded, event.resolvedType)
        return isCharacterAttack({ event, recipe }) ? latest : Math.max(latest, event.seq)
      }, -1)
      const latestAttackSeq = (state.presentationEvents ?? []).reduce((latest, event) => {
        if (event.actorId !== player.id || event.kind === 'potion' || event.kind === 'orb' ||
          event.kind === 'slime' || event.kind === 'turn') return latest
        const recipe = event.kind === 'shiv'
          ? shivVfxRecipe()
          : cardVfxRecipe(playerVisualId(player), event.sourceId, event.mode, event.upgraded, event.resolvedType)
        return isCharacterAttack({ event, recipe }) ? Math.max(latest, event.seq) : latest
      }, -1)
      const latestAttackIsActive = actorEvents.some((active) =>
        active.event.seq === latestAttackSeq && isCharacterAttack(active))
      // Hermit rounds already in flight survive the render before a new event becomes active.
      const attacks = latestAttackIsActive || hasStagedAttack(playerVisualId(player)) ? actorEvents.filter((active) =>
        (hasStagedAttack(playerVisualId(player)) || active.event.seq > latestNonAttackSeq) && isCharacterAttack(active)) : []
      if (attacks.length === 0) continue
      const actor = board.querySelector<HTMLElement>(`.seat[data-player-id="${player.id}"] .seat__portrait`)
      if (!actor) continue
      const actorRect = actor.getBoundingClientRect()
      const actorCenterX = actorRect.left + actorRect.width / 2
      const actorCenterY = actorRect.top + actorRect.height / 2
      const attackVisual = playerVisualId(player)
      const staged = stagedAttackOf(attackVisual)
      next[player.id] = attacks.flatMap((active) => {
        const targets = active.event.enemyIds.flatMap((id) => {
          const target = enemies.find((enemy) => enemy.dataset.enemyId === id)?.querySelector<HTMLElement>('.enemy__portrait')
          if (!target) return []
          const rect = target.getBoundingClientRect()
          const body = combatBodyPoint(target)
          const monogatariDefect = playerVisualId(player) === 'monogatari_defect'
          const monogatariWarm = monogatariDefect && monogatariPosesReady(playerVisualId(player), active.event.seq)
          const castX = monogatariWarm ? .71 : .497
          const castHeight = monogatariWarm ? .522 : .518
          const x = monogatariDefect ? body.x - actorRect.left - actorRect.width * castX
            : body.x - actorCenterX -
            (player.character === 'silent' ? actorRect.width * 0.15 :
              player.character === 'defect' ? -actorRect.width * 0.03 : 0)
          const y = monogatariDefect ? body.y - actorRect.bottom + actorRect.width * castHeight
            : (player.character === 'watcher' ? rect.bottom : body.y) -
            actorCenterY + (player.character === 'silent' ? actorRect.height * 0.19 :
              player.character === 'defect' ? actorRect.height * 0.35 : 0)
          const startY = player.character === 'watcher'
            ? boardRect.top - actorCenterY - skyClearance
            : y
          return [{
            id,
            x,
            y,
            startX: player.character === 'watcher' ? x - (y - startY) / WATCHER_METEOR_FALL_SLOPE : x,
            startY,
          }]
        })
        if (targets.length === 0) return []
        const rowTarget = active.event.enemyIds.length > 1 && active.event.enemyRow !== undefined
          ? state.enemies.find((enemy) => !enemy.isBoss && enemy.row === active.event.enemyRow &&
            active.event.enemyIds.includes(enemy.uid))
          : undefined
        const target = targets.find(({ id }) => id === rowTarget?.uid) ?? targets[0]!
        const targetElement = enemies.find((enemy) => enemy.dataset.enemyId === target.id)!
        const targetPortrait = targetElement.querySelector<HTMLElement>('.enemy__portrait')!
        const targetRect = targetPortrait.getBoundingClientRect()
        return [{
          active,
          interrupted: !hasStagedAttack(playerVisualId(player)) && active.event.seq <= latestNonAttackSeq,
          targetId: target.id,
          // A staged skin stops where its weapon, not its body, reaches the target.
          x: staged && stagedPosesReady(attackVisual, staged, active.event.seq)
            ? Math.max(0, combatBodyPoint(targetPortrait).x - actorCenterX -
              staged.contactReach * Math.min(actorRect.width, actorRect.height))
            : Math.max(0, targetRect.left - actorRect.right + actorRect.width * 0.22),
          y: targetRect.bottom - actorRect.bottom,
          targets,
        }]
      })
    }
    // A finished attack forgets its latch, so a replayed seq decides afresh.
    const running = new Set(Object.values(next).flat().map((attack) => `${state.combatId}:${attack.active.event.seq}`))
    for (const key of stagedPosesReadyByAttack.current.keys()) {
      if (!running.has(key)) stagedPosesReadyByAttack.current.delete(key)
    }
    for (const key of monogatariPosesReadyByAttack.current.keys()) {
      if (!running.has(key)) monogatariPosesReadyByAttack.current.delete(key)
    }
    setCharacterAttacks(next)
  }, [activeVfx, prefersReducedMotion, stageScale, state.enemies, state.players])

  useLayoutEffect(() => {
    const board = boardRef.current
    const commands = livePresentationEvents.filter((event) => event.kind === 'slime')
    if (!board || prefersReducedMotion || commands.length === 0) {
      setSlimeCommandMotions((current) => Object.keys(current).length === 0 ? current : {})
      return
    }
    const next: typeof slimeCommandMotions = {}
    for (const event of commands) {
      const key = `${event.actorId}:${event.slimeUid}`
      const row = board.querySelector<HTMLElement>(`.seat[data-player-id="${CSS.escape(event.actorId)}"]`)?.closest('.row')
      const actor = row?.querySelector<HTMLElement>(`.slime-party__actor[data-slime-uid="${CSS.escape(event.slimeUid)}"]`)
      const target = event.enemyIds.flatMap((id) => {
        const portrait = board.querySelector<HTMLElement>(`.enemy[data-enemy-id="${CSS.escape(id)}"] .enemy__portrait`)
        return portrait ? [portrait] : []
      })[0] ?? board.querySelector<HTMLElement>('.enemy:not(.enemy--dead) .enemy__portrait')
      if (!actor) continue
      const actorRect = actor.getBoundingClientRect()
      const targetRect = target?.getBoundingClientRect()
      // Measure from the home position, removing this command's translation.
      // Growing a party can move both actors and targets mid-command; using the
      // animated bounds feeds travel back into the path and makes it drift.
      const transform = getComputedStyle(actor).transform
      const travel = new DOMMatrix(transform === 'none' ? undefined : transform)
      const motion = {
        seq: event.seq,
        x: targetRect ? Math.max(0, targetRect.left - actorRect.right + travel.e + actorRect.width * 0.22) : 0,
        y: targetRect ? targetRect.bottom - actorRect.bottom + travel.f : 0,
      }
      const prior = slimeCommandMotions[key]
      next[key] = prior?.seq === event.seq && Math.abs(prior.x - motion.x) < 0.1 && Math.abs(prior.y - motion.y) < 0.1
        ? prior : motion
    }
    setSlimeCommandMotions(next)
  }, [livePresentationEvents, prefersReducedMotion, stageScale, state.players, slimeLayoutVersion])

  // Animate only changes witnessed while this combat is live. A reconnect or
  // restored snapshot is a baseline, never a replay of private cards the
  // viewer did not just draw or actions that happened while away. This runs
  // before paint so a new hand never flashes in its settled position first.
  useLayoutEffect(() => {
    if (!viewer) return
    const next: MotionSnapshot = {
      hand: viewer.hand,
      chamber: viewer.chamber,
      energy: viewer.energy,
      draw: drawCount ?? viewer.draw.length,
      discard: viewer.discard.length,
      exhaust: viewer.exhaust.length,
    }
    const restored = (authoritativeRestoration !== undefined &&
      authoritativeRestoration !== motionRestoration.current) ||
      authoritativeConnected === false || motionConnected.current === false || motionViewer.current !== viewerId
    motionRestoration.current = authoritativeRestoration
    motionConnected.current = authoritativeConnected
    motionViewer.current = viewerId
    const before = motionBaseline.current
    motionBaseline.current = next

    if (!before) {
      if (!reducedMotion && animateOpeningHand && next.hand.length > 0) {
        setDrawnCards(new Set(next.hand.map((card) => card.uid)))
      }
      return
    }

    if (restored) {
      armedCardFlight.current = null
      for (const timer of motionTimers.current.values()) clearTimeout(timer)
      motionTimers.current.clear()
      setDrawnCards((current) => current.size === 0 ? current : new Set())
      setCardFlights([])
      setMotionActive((current) => current.size === 0 ? current : new Set())
      return
    }

    const arrivals = drawnCardUids(before.hand, next.hand)
    if (!reducedMotion && arrivals.length > 0) {
      setDrawnCards((current) => new Set([...current, ...arrivals]))
    }

    const armed = armedCardFlight.current
    let landing: MotionKey | null = null
    const beforeSource = armed?.chamber ? before.chamber : before.hand
    const nextSource = armed?.chamber ? next.chamber : next.hand
    if (armed && beforeSource.some((card) => card.uid === armed.card.uid) &&
      !nextSource.some((card) => card.uid === armed.card.uid)) {
      const destination = cardMotionDestination(
        armed.card.uid,
        viewer,
        faceOf(cardDef(armed.card.defId), armed.card.upgraded).toDrawTop === true,
      )
      landing = !reducedMotion && destination !== 'stage' ? destination : null
      flightBeat.current += 1
      const beat = flightBeat.current
      if (!reducedMotion) setCardFlights((current) => [...current, { beat, card: armed.card, destination, ...cardFlightPath(destination) }])
      armedCardFlight.current = null
      if (!reducedMotion) {
        const timerKey = `flight:${beat}` as const
        motionTimers.current.set(timerKey, setTimeout(() => {
          setCardFlights((current) => current.map((flight) => flight.beat === beat ? { ...flight, landed: true } : flight))
          if (landing) pulseMotion([landing])
          motionTimers.current.set(timerKey, setTimeout(() => {
            motionTimers.current.delete(timerKey)
            setCardFlights((current) => current.filter((flight) => flight.beat !== beat))
          }, 820))
        }, 980))
      }
    } else if (state.phase !== 'player' && state.phase !== 'copy') {
      armedCardFlight.current = null
    }

    const changed: MotionKey[] = []
    if (before.energy !== next.energy) changed.push('energy')
    if (before.draw !== next.draw && landing !== 'draw') changed.push('draw')
    if (before.discard !== next.discard && landing !== 'discard') changed.push('discard')
    if (before.exhaust !== next.exhaust && landing !== 'exhaust') changed.push('exhaust')
    pulseMotion(changed)
  }, [animateOpeningHand, authoritativeConnected, authoritativeRestoration, drawCount, miracleOnCard,
    endTurnResolving, pending, pendingTrigger, reducedMotion, state, usingCard, viewer])

  // Keep this timer in its own effect so React development Strict Mode can
  // clean up and restart it without leaving the animation class stuck on.
  useEffect(() => {
    if (drawnCards.size === 0) return undefined
    const timer = setTimeout(
      () => setDrawnCards(new Set()),
      620 + Math.max(0, (viewer?.hand.length ?? 1) - 1) * 42,
    )
    return () => clearTimeout(timer)
  }, [drawnCards, viewer?.hand.length])

  useEffect(() => () => {
    for (const timer of motionTimers.current.values()) clearTimeout(timer)
  }, [])

  const displayedPileCount = (kind: 'draw' | 'discard' | 'exhaust', count: number) =>
    Math.max(0, count - cardFlights.filter((flight) => flight.destination === kind && !flight.landed).length)

  return {
    drawnCards,
    cardFlights,
    motionActive,
    motionBeats,
    characterAttacks,
    slimeCommandMotions,
    setSlimeLayoutVersion,
    pulseMotion,
    displayedPileCount,
  }
}
