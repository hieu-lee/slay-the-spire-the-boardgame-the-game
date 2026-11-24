import { createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cardDef } from '../../game/cards.ts'
import { enemyTurn, startPlayerTurnWithChoices } from '../../game/combat.ts'
import type { CombatState } from '../../game/combat.ts'
import { hasStagedAttack, playerVisualId } from '../../game/skins.ts'
import type { Enemy } from '../../game/types.ts'
import type { ActionOutcome } from '../../multiplayer/useRoomSession.ts'
import {
  cardVfxRecipe,
  enemyAttackArrivalMsFor,
  enemyAttackTargetPlayerIds,
  orbVfxRecipe,
  potionVfxRecipe,
  shivVfxRecipe,
  turnEffectVfxRecipe,
} from '../combat-vfx.ts'
import { playSoundEffect } from '../sfx.ts'
import { targetPresentationTiming } from './helpers.ts'
import {
  useCombatSoundEffects,
  useFalling,
  usePersonalCombatSoundEffects,
  usePresentationEvents,
  useStruck,
} from './hooks.ts'
import type { ActiveCombatVfx, CombatScreenProps } from './types.ts'
import { useAttackPosePreload } from './useAttackPosePreload.ts'
import { useStageLayout } from './useStageLayout.ts'
import {
  CombatVfx,
  ORB_END_TURN_STAGGER_MS,
  characterAttackContactMs,
  isCharacterAttack,
  isEndTurnLightning,
} from './vfx.tsx'

export function useCombatPresentation({
  state,
  viewerId,
  onChange,
  onAction,
  autoAdvance,
  voluntaryActionsBlocked,
  authoritativeRefresh,
  authoritativeRestoration,
  authoritativeConnected,
  animateOpeningHand,
  prefersReducedMotion,
}: {
  state: CombatState
  viewerId: string
  onChange?: (next: CombatState) => void
  onAction?: CombatScreenProps['onAction']
  autoAdvance: boolean
  voluntaryActionsBlocked: boolean
  authoritativeRefresh: number | undefined
  authoritativeRestoration: number | undefined
  authoritativeConnected: boolean | undefined
  animateOpeningHand: boolean
  prefersReducedMotion: boolean
}) {
  const [autoAdvanceRetry, setAutoAdvanceRetry] = useState(0)

  const { hits } = useStruck(
    state,
    authoritativeRestoration,
    authoritativeConnected,
    prefersReducedMotion,
  )
  const falling = useFalling(
    state,
    authoritativeRestoration,
    authoritativeConnected,
    prefersReducedMotion,
  )
  const livePresentation = usePresentationEvents(
    state,
    authoritativeRestoration,
    authoritativeConnected,
    prefersReducedMotion,
  )
  const livePresentationEvents = livePresentation.events
  const targetPresentationTimings = new Map(state.enemies.map((enemy) => [
    enemy.uid,
    targetPresentationTiming(state, enemy.uid, livePresentation.contactDeadlines),
  ]))
  const visualResetKey = `${state.combatId}:${authoritativeRestoration ?? ''}:${authoritativeConnected ?? ''}:${prefersReducedMotion}`

  usePersonalCombatSoundEffects(
    state,
    livePresentation.soundEvents,
    authoritativeRestoration,
    authoritativeConnected,
    prefersReducedMotion,
  )

  const activeVfx = useMemo<ActiveCombatVfx[]>(() => {
    const resolved: ActiveCombatVfx[] = []
    for (const event of livePresentationEvents) {
      if (event.kind === 'slime' ||
        event.kind === 'card' && cardDef(event.sourceId).cardKind === 'slime') continue
      if (event.kind === 'potion') {
        resolved.push({ event, recipe: potionVfxRecipe(event.sourceId) })
        continue
      }
      const actor = state.players.find((player) => player.id === event.actorId)
      if (!actor) continue
      resolved.push({
        event,
        recipe: event.kind === 'orb'
          ? orbVfxRecipe(event.orb, event.sourceId)
          : event.kind === 'turn'
            ? turnEffectVfxRecipe(event.effect)
            : event.kind === 'shiv'
              ? shivVfxRecipe()
              : cardVfxRecipe(playerVisualId(actor), event.sourceId, event.mode, event.upgraded, event.resolvedType),
      })
    }
    return resolved
  }, [livePresentationEvents, state.players])

  const {
    characterAttackBlobs,
    characterAttackAssets,
    stagedPosesReadyByAttack,
    stagedPosesReady,
    monogatariPosesReadyByAttack,
    monogatariPosesReady,
    monogatariEvokesReadyByEvent,
    monogatariEvokeReady,
  } = useAttackPosePreload({
    combatId: state.combatId,
    players: state.players,
    prefersReducedMotion,
    activeVfx,
  })

  // A passive orb's end-of-turn effects can all land in the SAME state update
  // (the engine resolves the whole ordered list before the client ever sees
  // it), so without this every orb's burst would reveal on the same frame —
  // one flash standing in for however many orbs actually fired. Staggering by
  // arrival order lets each one read as its own beat: zap, then a pause, then
  // the next. Other VFX kinds keep their own timing (attack contact, card
  // reveal) and are untouched here.
  const orbEndTurnRevealDelayMs = useMemo(() => {
    const delays = new Map<number, number>()
    const ordered = activeVfx
      .filter(({ event }) => event.kind === 'orb' && event.sourceId === 'orb-end-turn')
      .sort((a, b) => a.event.seq - b.event.seq)
    ordered.forEach(({ event }, index) => delays.set(event.seq, index * ORB_END_TURN_STAGGER_MS))
    return delays
  }, [activeVfx])

  const actorVfxFor = (playerId: string) => activeVfx.filter(({ event }) =>
    event.actorId === playerId && (event.kind !== 'turn' || event.actorTargeted))
  const playerVfxFor = (playerId: string) => activeVfx.filter(({ event, recipe }) =>
    event.actorId !== playerId && event.playerIds.includes(playerId) &&
    (event.kind === 'turn' || !['slash', 'blunt', 'projectile', 'poison', 'shiv', 'lightning', 'dark', 'debuff']
      .includes(recipe.family)))
  const enemyVfxFor = (enemy: Enemy) => activeVfx
    .filter((active) => active.event.enemyIds.includes(enemy.uid) && !isEndTurnLightning(active.event) &&
      !(state.players.some(p => p.id === active.event.actorId && hasStagedAttack(playerVisualId(p))) && isCharacterAttack(active)))
    .map((active) => createElement(CombatVfx, {
      key: `${active.event.seq}-${active.recipe.asset}`,
      active,
      role: 'target',
      attackContactMs: prefersReducedMotion ? 0 : characterAttackContactMs(state, enemy.uid, active.event),
      revealDelayMs: orbEndTurnRevealDelayMs.get(active.event.seq),
    }))

  // The enemy phase stays open until the prior player attacks clear, so bosses
  // start after that shared presentation window while player attacks remain concurrent.
  const characterAttacksActive = !prefersReducedMotion && (
    activeVfx.some(isCharacterAttack) || livePresentation.slimeCommandsPending)
  const stageAttacksActive = characterAttacksActive || activeVfx.some(({ event }) =>
    event.kind === 'orb' && event.sourceId === 'orb-evoke' && event.orb !== 'frost')

  const {
    boardRef,
    combatBarRef,
    viewerRowRef,
    stageScale,
    stageEnemySlots,
    stageMotionReady,
    bosses,
    stageEnemies,
    largestSlimeParty,
  } = useStageLayout({
    state,
    viewerId,
    falling,
    prefersReducedMotion,
    stageAttacksActive,
    authoritativeRestoration,
  })

  useCombatSoundEffects(state, viewerId, animateOpeningHand, authoritativeRestoration, authoritativeConnected)

  const weakByActor = [
    ...state.players.map((player) => [`player:${player.id}`, player.weak] as const),
    ...state.enemies.map((enemy) => [`enemy:${enemy.uid}`, enemy.weak] as const),
  ]
  const previousWeakByActor = useRef(new Map(weakByActor))
  const previousWeakPresentationSeq = useRef(state.presentationEvents?.at(-1)?.seq ?? 0)
  const previousWeakRestoration = useRef(authoritativeRestoration)
  const previousWeakConnected = useRef(authoritativeConnected)
  useEffect(() => {
    const restored = (authoritativeRestoration !== undefined &&
      authoritativeRestoration !== previousWeakRestoration.current) ||
      authoritativeConnected === false || previousWeakConnected.current === false
    previousWeakRestoration.current = authoritativeRestoration
    previousWeakConnected.current = authoritativeConnected
    const presentationSeq = state.presentationEvents?.at(-1)?.seq ?? 0
    const actionPresented = presentationSeq > previousWeakPresentationSeq.current
    previousWeakPresentationSeq.current = presentationSeq
    if (!restored && !actionPresented &&
      weakByActor.some(([id, weak]) => weak > (previousWeakByActor.current.get(id) ?? 0))) {
      playSoundEffect('weak')
    }
    previousWeakByActor.current = new Map(weakByActor)
  }, [authoritativeConnected, authoritativeRestoration, state.players, state.enemies])

  const [cultistThrowAt, setCultistThrowAt] = useState<Record<string, number | null>>({})
  const [cultistPreparedUntil, setCultistPreparedUntil] = useState<Record<string, number>>({})
  const [expiredCultistPhase, setExpiredCultistPhase] = useState('')
  // A reconnect can change the presentation clock while the server is still
  // resolving this same enemy phase. Keep a timed-out throw cancelled.
  const activeEnemyPhaseKey = `${state.combatId}:${state.turn}:enemy`
  const logicalAutoAdvanceKey = `${state.combatId}:${state.turn}:${state.phase}`
  const currentAutoAdvance = useRef({ key: logicalAutoAdvanceKey, enabled: autoAdvance })
  currentAutoAdvance.current = { key: logicalAutoAdvanceKey, enabled: autoAdvance }
  const pendingAutoAdvance = useRef<{ key: string; request: Promise<ActionOutcome | void> } | null>(null)
  const onCultistThrowPrepared = useCallback((enemyUid: string, arrivalWithinMs: number) => {
    const key = `${state.combatId}:${authoritativeRestoration ?? ''}:${state.turn}:${enemyUid}`
    const until = performance.now() + arrivalWithinMs
    setCultistPreparedUntil(current => (current[key] ?? 0) >= until ? current : { ...current, [key]: until })
  }, [authoritativeRestoration, state.combatId, state.turn])
  const onCultistThrowStart = useCallback((enemyUid: string) => {
    const key = `${state.combatId}:${authoritativeRestoration ?? ''}:${state.turn}:${enemyUid}`
    const at = performance.now()
    setCultistThrowAt(current => typeof current[key] === 'number' ? current : { ...current, [key]: at })
  }, [authoritativeRestoration, state.combatId, state.turn])
  const onCultistThrowSkipped = useCallback((enemyUid: string) => {
    const key = `${state.combatId}:${authoritativeRestoration ?? ''}:${state.turn}:${enemyUid}`
    setCultistThrowAt(current => key in current ? current : { ...current, [key]: null })
  }, [authoritativeRestoration, state.combatId, state.turn])
  const enemyPhaseClock = useRef({ key: '', at: 0 })
  const lastEnemyResolve = useRef({ key: '', at: 0 })
  useEffect(() => {
    if (!autoAdvance || voluntaryActionsBlocked || state.phase !== 'enemy' && state.phase !== 'roundEnd') return undefined
    if (state.phase === 'enemy' && characterAttacksActive) return undefined
    const phaseKey = `${state.combatId}:${authoritativeRestoration ?? ''}:${state.turn}:${state.phase}`
    if (enemyPhaseClock.current.key !== phaseKey) enemyPhaseClock.current = { key: phaseKey, at: performance.now() }
    const cultists = state.phase === 'enemy' && !prefersReducedMotion
      ? state.enemies.filter(enemy => !enemy.dead && enemyAttackArrivalMsFor(enemy.defId) !== undefined &&
        enemyAttackTargetPlayerIds(state, enemy).length > 0)
      : []
    const launchTimes = cultists.map(enemy => cultistThrowAt[`${state.combatId}:${authoritativeRestoration ?? ''}:${state.turn}:${enemy.uid}`])
    const preparedArrival = Math.max(0, ...cultists.map(enemy => cultistPreparedUntil[`${state.combatId}:${authoritativeRestoration ?? ''}:${state.turn}:${enemy.uid}`] ?? 0))
    // The CSS flight starts after art is ready; failed art gets a bounded fallback.
    const deadline = cultists.length
      ? launchTimes.every(at => at !== undefined)
        // Leave one paint frame after the 500ms flight before resolving damage.
        ? Math.max(enemyPhaseClock.current.at + 730, ...launchTimes.map((at, index) =>
          typeof at === 'number' ? at + (enemyAttackArrivalMsFor(cultists[index]!.defId) ?? 530) : 0))
        : Math.max(enemyPhaseClock.current.at + 5000, preparedArrival)
      : enemyPhaseClock.current.at + 730
    const retryAt = lastEnemyResolve.current.key === phaseKey ? lastEnemyResolve.current.at + 730 : 0
    const resolveDelayMs = Math.max(0, deadline - performance.now(), retryAt - performance.now())
    const timer = window.setTimeout(async () => {
      // A restoration updates the presentation clock but must not send the
      // same turn action twice while its first server response is pending.
      if (onAction && pendingAutoAdvance.current?.key === logicalAutoAdvanceKey) return
      if (cultists.length && launchTimes.some(at => at === undefined)) setExpiredCultistPhase(activeEnemyPhaseKey)
      lastEnemyResolve.current = { key: phaseKey, at: performance.now() }
      const shouldRetry = (outcome: ActionOutcome | void) => outcome && (
        outcome.status === 'refused' || outcome.status === 'unknown' ||
        outcome.status === 'reconciled' &&
          outcome.snapshot?.run?.combat?.phase === state.phase &&
          outcome.snapshot.run.combat.turn === state.turn
      )
      if (onAction) {
        const action = state.phase === 'enemy' ? { kind: 'resolveEnemies' } as const : { kind: 'startTurn' } as const
        const request = Promise.resolve(onAction(action))
        pendingAutoAdvance.current = { key: logicalAutoAdvanceKey, request }
        let outcome: ActionOutcome | void
        try { outcome = await request }
        finally {
          if (pendingAutoAdvance.current?.request === request) pendingAutoAdvance.current = null
        }
        if (currentAutoAdvance.current.key === logicalAutoAdvanceKey && currentAutoAdvance.current.enabled && shouldRetry(outcome)) {
          setAutoAdvanceRetry((attempt) => attempt + 1)
        }
      } else if (state.phase === 'enemy') onChange?.(enemyTurn(state))
      else onChange?.(startPlayerTurnWithChoices(state))
    }, resolveDelayMs)
    return () => window.clearTimeout(timer)
  }, [autoAdvance, autoAdvanceRetry, authoritativeRefresh, authoritativeRestoration, characterAttacksActive, cultistPreparedUntil, cultistThrowAt,
    prefersReducedMotion, state.combatId, state.phase, state.turn, voluntaryActionsBlocked])

  return {
    autoAdvanceRetry,
    hits,
    falling,
    livePresentation,
    livePresentationEvents,
    targetPresentationTimings,
    visualResetKey,
    activeVfx,
    characterAttackBlobs,
    characterAttackAssets,
    stagedPosesReadyByAttack,
    stagedPosesReady,
    monogatariPosesReadyByAttack,
    monogatariPosesReady,
    monogatariEvokesReadyByEvent,
    monogatariEvokeReady,
    orbEndTurnRevealDelayMs,
    actorVfxFor,
    playerVfxFor,
    enemyVfxFor,
    characterAttacksActive,
    stageAttacksActive,
    boardRef,
    combatBarRef,
    viewerRowRef,
    stageScale,
    stageEnemySlots,
    stageMotionReady,
    bosses,
    stageEnemies,
    largestSlimeParty,
    expiredCultistPhase,
    activeEnemyPhaseKey,
    onCultistThrowPrepared,
    onCultistThrowStart,
    onCultistThrowSkipped,
  }
}
