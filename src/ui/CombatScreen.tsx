// The combat screen: the board, the hand, and every prompt a fight puts up.
//
// One component, because the fight is one interaction — a card being dragged
// knows about the enemy under the pointer, the Energy it would spend, and the
// prompt it would open, and splitting that across components would mean passing
// the same twenty things back and forth. What CAN stand outside it does:
// combat-screen/types.ts for the shapes, helpers.ts for the questions it asks
// of the board, hooks.ts for the senses that watch the board change, and
// vfx.tsx for the effect overlay a play puts on it.
import {
  PHASE_LABEL,
  canAfford,
  cardShivsOnPlay,
  describeSeat,
  fanOf,
  gainedShivs,
  pendingFor,
  revealViewerRow,
  rowsOf,
} from './combat-screen/helpers.ts'
import {
  useCombatSoundEffects,
  useFalling,
  usePersonalCombatSoundEffects,
  usePresentationEvents,
  useReducedEffects,
  usePrefersReducedMotion,
  useStruck,
} from './combat-screen/hooks.ts'
import type {
  ActiveCombatVfx,
  CardDrag,
  CardDragStart,
  CardFlight,
  CharacterAttackMotion,
  CombatScreenProps,
  MotionKey,
  MotionSnapshot,
  Pending,
  PendingStartChoice,
  UnknownCardAction,
  UnknownPotionAction,
  UnknownPowerAction,
} from './combat-screen/types.ts'
import {
  CombatVfx,
  characterAttackContactMs,
  isCharacterAttack,
  latestTargetPresentationEvent,
  ORB_END_TURN_STAGGER_MS,
} from './combat-screen/vfx.tsx'
import { assetPath, potionIconPath, relicIconPath } from '../game/assets.ts'
import { cardCost, cardDef, faceOf } from '../game/cards.ts'
import {
  STALE_END_TURN_ORDER,
  activatePotion,
  activatePower,
  activateRelic,
  beginEndPlayerTurn,
  canActivatePotion,
  canActivateRelic,
  cardEnemyChoiceCount,
  cardModeIsAvailable,
  cardNeedsChoicePreview,
  cardNeedsEnemy,
  cardPlayConditionMet,
  cardPlayerChoiceCount,
  cardShivChoiceCount,
  chooseDistilledCard,
  chooseEndTurnTarget,
  chosenEvokeOrbs,
  combatRowLabel,
  defaultEndTurnOrder,
  defaultStartTurnChoices,
  endPlayerTurn,
  endTurnAbilities,
  endTurnChoiceId,
  endTurnChoiceTarget,
  enemyLabel,
  enemyTurn,
  evokeTargetProgress,
  facingChoicesAreValid,
  lightningRowFromTarget,
  lightningRowTarget,
  lightningTargetsRows,
  nextEvokeChoice,
  orderStartTurnScries,
  overflowShivCount,
  pendingTriggerAbility,
  playCard,
  playCardCopy,
  playCost,
  powerAbilityKey,
  powerAbilityUsed,
  previewCardChoice,
  previewCardCopyChoice,
  reachesEnemy,
  reachedTimeWarpLimit,
  remainingRoundHpLoss,
  resolvePendingTrigger,
  resolveStartPlayerTurn,
  resolveStartTurnDiscard,
  resolveStartTurnScry,
  spendMiracle,
  spendShiv,
  startPlayerTurnWithChoices,
  startTurnAbilities,
  startTurnDiscardPreview,
  startTurnNeedsChoice,
  startTurnScryAbilities,
  startTurnScryPreview,
  validEndTurnOrder,
} from '../game/combat.ts'
import type {
  DiscardOrders,
  EndTurnOrder,
  PotionContext,
  PowerContext,
  RelicContext,
  StartTurnChoice,
} from '../game/combat.ts'
import { potionDef, relicAbilities, relicDef } from '../game/relics.ts'
import { CAPS } from '../game/types.ts'
import type { CardInstance, Enemy, Player } from '../game/types.ts'
import type { ActionOutcome } from '../multiplayer/useRoomSession.ts'
import { Card } from './Card.tsx'
import { CardCollectionOverlay } from './CardCollectionOverlay.tsx'
import { EnemyCard } from './EnemyCard.tsx'
import { Icon, IconValue, StatusIcon, dieIcon } from './Icon.tsx'
import { PotionIcon, PotionTooltipAnchor } from './PotionIcon.tsx'
import { PowerGlyph, PowerRow } from './PowerRow.tsx'
import { OrbRow, TokenRow } from './TokenRow.tsx'
import {
  STAGE_GAP_REM,
  STAGE_MARGIN_REM,
  cardMotionDestination,
  displayedEnemies,
  drawnCardUids,
  healthBand,
  pendingUiSurvivesContext,
  shouldDisarmCardFlight,
  stageScaleFor,
} from './board-signals.ts'
import { cardVfxRecipe, orbVfxRecipe, potionVfxRecipe, shivVfxRecipe } from './combat-vfx.ts'
import { playSoundEffect } from './sfx.ts'
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

// Weighted alpha PCA of watcher-meteor.webp: tail-to-nose y/x.
const WATCHER_METEOR_FALL_SLOPE = 0.7113856 / 0.7028019

function CombatScreenView({
  state,
  act,
  viewerId,
  onChange,
  onAction,
  autoAdvance = true,
  courierAvailable = false,
  mutationsEnabled = true,
  drawCount,
  decidedPlayerIds,
  savedDiscardOrder,
  partyEndTurnAbilities,
  savedEndTurnOrder,
  endTurnCoordinatorId,
  partyStartTurnAbilities,
  partyStartTurnScryAbilities,
  startTurnCoordinatorId,
  startTurnChoiceId,
  savedStartTurnEnemyTargets,
  savedStartTurnChoices,
  partyStartTurnOrderPending = false,
  partyStartTurnOrderLocked = false,
  partyStartTurnScry,
  partyStartTurnDiscard,
  cardPreview,
  authoritativeVersion,
  authoritativeRefresh,
  authoritativeRestoration,
  authoritativeConnected,
  animateOpeningHand = authoritativeVersion === undefined,
}: CombatScreenProps) {
  const stageAct = Math.min(4, Math.max(1, act))
  const [pending, setPending] = useState<Pending | null>(null)
  const [miracleOnCard, setMiracleOnCard] = useState(false)
  const [spendingShiv, setSpendingShiv] = useState(false)
  const [pendingPotion, setPendingPotion] = useState<string | null>(null)
  const [pendingPowerUid, setPendingPowerUid] = useState<string | null>(null)
  const [autoAdvanceRetry, setAutoAdvanceRetry] = useState(0)
  const [potionShivEnemyUids, setPotionShivEnemyUids] = useState<string[]>([])
  const [potionOverflowRequired, setPotionOverflowRequired] = useState(0)
  const [potionCardUids, setPotionCardUids] = useState<string[]>([])
  const [relicCardUids, setRelicCardUids] = useState<string[]>([])
  const [relicShivEnemyUids, setRelicShivEnemyUids] = useState<string[]>([])
  const [usingPotion, setUsingPotion] = useState(false)
  const [usingPower, setUsingPower] = useState(false)
  const [usingTrigger, setUsingTrigger] = useState(false)
  const [usingCard, setUsingCard] = useState(false)
  const [discardTops, setDiscardTops] = useState<Record<string, string>>({})
  const [retainedCards, setRetainedCards] = useState<Record<string, string[]>>({})
  const [discardOrders, setDiscardOrders] = useState<DiscardOrders>({})
  const [endTurnOrder, setEndTurnOrder] = useState<string[]>([])
  const [endTurnError, setEndTurnError] = useState('')
  const [endTurnOrderOpen, setEndTurnOrderOpen] = useState(false)
  const [startTurnOrder, setStartTurnOrder] = useState<string[]>([])
  const [startTurnScryOrder, setStartTurnScryOrder] = useState<string[]>([])
  const [startTurnEnemyTargets, setStartTurnEnemyTargets] = useState<Record<string, string | undefined>>({})
  const [startTurnPlayerTargets, setStartTurnPlayerTargets] = useState<Record<string, string | undefined>>({})
  const [startTurnTargets, setStartTurnTargets] = useState<Record<string, (string | null | undefined)[]>>({})
  const [startTurnEvokeSlots, setStartTurnEvokeSlots] = useState<Record<string, number[]>>({})
  const [startTurnEvokeTargets, setStartTurnEvokeTargets] = useState<
    Record<string, (string | null | undefined)[]>
  >({})
  const [startTurnScryPicked, setStartTurnScryPicked] = useState<string[]>([])
  const [resolvingStartTurnScry, setResolvingStartTurnScry] = useState(false)
  const [resolvingStartTurnDiscard, setResolvingStartTurnDiscard] = useState(false)
  const [stageScale, setStageScale] = useState(1)
  const reducedMotion = useReducedEffects()
  // Narrower than `reducedMotion`: true only for an actual motion-sensitivity
  // preference, never for a weak phone. See usePrefersReducedMotion's doc for
  // why the signature attack sequence needs that distinction and nothing else
  // on this screen does.
  const prefersReducedMotion = usePrefersReducedMotion()
  const boardRef = useRef<HTMLDivElement | null>(null)
  const choiceDialogRef = useRef<HTMLDialogElement | null>(null)
  const itemDialogRef = useRef<HTMLDialogElement | null>(null)
  const startTurnScryDialogRef = useRef<HTMLDialogElement | null>(null)
  const startTurnDiscardDialogRef = useRef<HTMLDialogElement | null>(null)
  const viewerRowRef = useRef<HTMLDivElement | null>(null)
  const followViewerRow = useRef(true)
  const programmaticScroll = useRef<{ left: number; top: number } | null>(null)
  const manualBoardScroll = useRef(false)
  const potionActionPending = useRef(false)
  const powerActionPending = useRef(false)
  const cardActionPending = useRef(false)
  const unknownPotionAction = useRef<UnknownPotionAction | null>(null)
  const unknownPowerAction = useRef<UnknownPowerAction | null>(null)
  const unknownCardAction = useRef<UnknownCardAction | null>(null)
  const armedCardFlight = useRef<CardInstance | null>(null)
  const cardDragStart = useRef<CardDragStart | null>(null)
  const cardDragLive = useRef<CardDrag | null>(null)
  const cardDragFrame = useRef<number | null>(null)
  const cardDragMove = useRef<{ x: number; y: number } | null>(null)
  const cardDragOverlay = useRef<HTMLDivElement | null>(null)
  const cardDragArrow = useRef<SVGPathElement | null>(null)
  const cardDragArrowShadow = useRef<SVGPathElement | null>(null)
  const suppressCardClick = useRef<string | null>(null)
  const motionBaseline = useRef<MotionSnapshot | null>(null)
  const motionRestoration = useRef(authoritativeRestoration)
  const motionConnected = useRef(authoritativeConnected)
  const motionViewer = useRef(viewerId)
  const motionTimers = useRef(new Map<MotionKey | `flight:${number}`, ReturnType<typeof setTimeout>>())
  const flightBeat = useRef(0)
  const [drawnCards, setDrawnCards] = useState<Set<string>>(new Set())
  const [cardFlights, setCardFlights] = useState<CardFlight[]>([])
  const [cardDrag, setCardDrag] = useState<CardDrag | null>(null)
  const [motionActive, setMotionActive] = useState<Set<MotionKey>>(new Set())
  const [motionBeats, setMotionBeats] = useState<Record<MotionKey, number>>({
    energy: 0,
    draw: 0,
    discard: 0,
    exhaust: 0,
  })

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
  const forcedAutoAttempt = useRef<string | null>(null)
  const viewer = state.players.find((player) => player.id === viewerId)
  const viewerHasSozu = viewer?.relics.some((relic) => relic.defId === 'sozu') ?? false
  const pendingTrigger = pendingTriggerAbility(state)
  const forcedCard = state.startTurnProgress?.forcedCard
  const distilled = state.pendingDistilled
  const relicScry = state.pendingRelicScry
  const activeStartTurnScry = partyStartTurnScry ?? (!onAction ? startTurnScryPreview(state) : undefined)
  const activeStartTurnDiscard = partyStartTurnDiscard ?? (!onAction ? startTurnDiscardPreview(state) : undefined)
  const startTurnScryKey = activeStartTurnScry
    ? `${activeStartTurnScry.playerId}:${activeStartTurnScry.label}:${activeStartTurnScry.cards?.map((card) => card.uid).join(',') ?? 'hidden'}`
    : ''
  const baseStartTurnScries = state.phase === 'start' && !activeStartTurnScry && !pendingTrigger
    ? (partyStartTurnScryAbilities ?? startTurnScryAbilities(state))
    : []
  const startTurnScryIds = startTurnScryOrder.length === baseStartTurnScries.length &&
    startTurnScryOrder.every((id) => baseStartTurnScries.some((ability) => ability.id === id))
    ? startTurnScryOrder
    : baseStartTurnScries.map((ability) => ability.id)
  const orderedStartTurnScries = startTurnScryIds.map((id) =>
    baseStartTurnScries.find((ability) => ability.id === id)).filter((ability) => ability !== undefined)
  const forcedCardUid = forcedCard?.playerId === viewerId && typeof forcedCard.cardUid === 'string'
    ? forcedCard.cardUid
    : null
  const stateRef = useRef(state)
  const versionRef = useRef(authoritativeVersion ?? -1)
  const refreshRef = useRef(authoritativeRefresh)
  stateRef.current = state
  versionRef.current = authoritativeVersion ?? -1
  refreshRef.current = authoritativeRefresh
  const rows = useMemo(() => rowsOf(state), [state])
  const savedDiscardKey = savedDiscardOrder?.join('\0')
  const savedEndTurnKey = savedEndTurnOrder?.join('\0')
  const cardPreviewKey = cardPreview
    ? `${cardPreview.cardUid}\0${cardPreview.copy === true}\0${cardPreview.kind}\0${cardPreview.spendMiracle}\0${cardPreview.enemyUid ?? ''}\0${cardPreview.cards.map((card) => card.uid).join('\0')}`
    : ''
  const orderingStage = partyEndTurnAbilities !== undefined
  const baseStartAbilities = useMemo(() => state.phase === 'start' && !pendingTrigger
    ? (partyStartTurnAbilities ?? startTurnAbilities(state))
    : [], [partyStartTurnAbilities, pendingTrigger?.id, state])
  const savedStartChoiceKey = savedStartTurnChoices?.map((choice) =>
    `${choice.id}:${choice.enemyUid ?? ''}:${choice.targetPlayerId ?? ''}:` +
    `${choice.shivEnemyUids.join(',')}:${choice.evokeSlots?.join(',') ?? ''}:` +
    `${choice.evokeEnemyUids?.join(',') ?? ''}`).join('\0') ?? ''
  const startAbilityKey = baseStartAbilities.map((ability) =>
    `${ability.id}:${ability.overflowShivs}:${ability.targets?.map((target) => target.uid).join(',') ?? ''}:` +
    `${ability.players?.map((player) => player.id).join(',') ?? ''}:` +
    `${ability.evokeChoice?.options.map((option) => `${option.slot}:${option.orb}`).join(',') ?? ''}:` +
    `${savedStartTurnEnemyTargets?.[ability.id] ?? ''}`).join('\0') + `\0${savedStartChoiceKey}`

  const { hits } = useStruck(
    state,
    authoritativeRestoration,
    authoritativeConnected,
    reducedMotion,
  )
  const falling = useFalling(
    state,
    authoritativeRestoration,
    authoritativeConnected,
  )
  const livePresentationEvents = usePresentationEvents(
    state,
    animateOpeningHand,
    authoritativeRestoration,
    authoritativeConnected,
  )
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
  const visualResetKey = `${state.combatId}:${authoritativeRestoration ?? ''}:${authoritativeConnected ?? ''}`
  usePersonalCombatSoundEffects(
    state,
    livePresentationEvents,
    authoritativeRestoration,
    authoritativeConnected,
  )
  const activeVfx = useMemo<ActiveCombatVfx[]>(() => {
    const resolved: ActiveCombatVfx[] = []
    for (const event of livePresentationEvents) {
      if (event.kind === 'potion') {
        resolved.push({ event, recipe: potionVfxRecipe(event.sourceId) })
        continue
      }
      const actor = state.players.find((player) => player.id === event.actorId)
      if (!actor) continue
      resolved.push({
        event,
        recipe: event.kind === 'orb'
          ? orbVfxRecipe(event.orb)
          : event.kind === 'shiv'
            ? shivVfxRecipe()
            : cardVfxRecipe(actor.character, event.sourceId, event.mode, event.upgraded),
      })
    }
    return resolved
  }, [livePresentationEvents, state.players])
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
  const actorVfxFor = (playerId: string) => activeVfx.filter(({ event }) => event.actorId === playerId)
  const playerVfxFor = (playerId: string) => activeVfx.filter(({ event, recipe }) =>
    event.actorId !== playerId && event.playerIds.includes(playerId) &&
    !['slash', 'blunt', 'projectile', 'poison', 'shiv', 'lightning', 'dark', 'debuff']
      .includes(recipe.family))
  const enemyVfxFor = (enemy: Enemy) => activeVfx.filter(({ event }) => event.enemyIds.includes(enemy.uid))
  const [characterAttacks, setCharacterAttacks] = useState<Record<string, CharacterAttackMotion[]>>({})
  useLayoutEffect(() => {
    const board = boardRef.current
    if (!board) return
    if (prefersReducedMotion || !activeVfx.some(isCharacterAttack)) {
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
        if (event.actorId !== player.id || event.kind === 'orb' || event.sourceId === 'fairy_in_a_bottle') return latest
        const recipe = event.kind === 'potion'
          ? potionVfxRecipe(event.sourceId)
          : event.kind === 'shiv'
            ? shivVfxRecipe()
            : cardVfxRecipe(player.character, event.sourceId, event.mode, event.upgraded)
        return isCharacterAttack({ event, recipe }) ? latest : Math.max(latest, event.seq)
      }, -1)
      const latestAttackSeq = (state.presentationEvents ?? []).reduce((latest, event) => {
        if (event.actorId !== player.id || event.kind === 'potion' || event.kind === 'orb') return latest
        const recipe = event.kind === 'shiv'
          ? shivVfxRecipe()
          : cardVfxRecipe(player.character, event.sourceId, event.mode, event.upgraded)
        return isCharacterAttack({ event, recipe }) ? Math.max(latest, event.seq) : latest
      }, -1)
      const latestAttackIsActive = actorEvents.some((active) =>
        active.event.seq === latestAttackSeq && isCharacterAttack(active))
      const attacks = latestAttackIsActive ? actorEvents.filter((active) =>
        active.event.seq > latestNonAttackSeq && isCharacterAttack(active)) : []
      if (attacks.length === 0) continue
      const actor = board.querySelector<HTMLElement>(`.seat[data-player-id="${player.id}"] .seat__portrait`)
      if (!actor) continue
      const actorRect = actor.getBoundingClientRect()
      const actorCenterX = actorRect.left + actorRect.width / 2
      const actorCenterY = actorRect.top + actorRect.height / 2
      next[player.id] = attacks.flatMap((active) => {
        const targets = active.event.enemyIds.flatMap((id) => {
          const target = enemies.find((enemy) => enemy.dataset.enemyId === id)?.querySelector<HTMLElement>('.enemy__portrait')
          if (!target) return []
          const rect = target.getBoundingClientRect()
          const x = rect.left + rect.width / 2 - actorCenterX -
            (player.character === 'silent' ? actorRect.width * 0.15 :
              player.character === 'defect' ? -actorRect.width * 0.03 : 0)
          const y = (player.character === 'watcher' ? rect.bottom : rect.top + rect.height / 2) -
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
        const targetRect = targetElement.querySelector<HTMLElement>('.enemy__portrait')!.getBoundingClientRect()
        return [{
          active,
          targetId: target.id,
          x: Math.max(0, targetRect.left - actorRect.right + actorRect.width * 0.22),
          y: targetRect.bottom - actorRect.bottom,
          targets,
        }]
      })
    }
    setCharacterAttacks(next)
  }, [activeVfx, prefersReducedMotion, stageScale, state.enemies, state.players])
  useCombatSoundEffects(state, viewerId, animateOpeningHand, authoritativeRestoration, authoritativeConnected)

  // Animate only changes witnessed while this combat is live. A reconnect or
  // restored snapshot is a baseline, never a replay of private cards the
  // viewer did not just draw or actions that happened while away. This runs
  // before paint so a new hand never flashes in its settled position first.
  useLayoutEffect(() => {
    if (!viewer) return
    const next: MotionSnapshot = {
      hand: viewer.hand,
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
    const activeDrag = cardDragStart.current
    if (activeDrag && (restored || !next.hand.some((card) => card.uid === activeDrag.card.uid) ||
      !cardCanStartDrag(activeDrag.card))) clearCardDrag()

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
    if (armed && before.hand.some((card) => card.uid === armed.uid) &&
      !next.hand.some((card) => card.uid === armed.uid)) {
      const destination = cardMotionDestination(
        armed.uid,
        viewer,
        faceOf(cardDef(armed.defId), armed.upgraded).toDrawTop === true,
      )
      landing = !reducedMotion && destination !== 'stage' ? destination : null
      flightBeat.current += 1
      const beat = flightBeat.current
      if (!reducedMotion) setCardFlights((current) => [...current, { beat, card: armed, destination }])
      armedCardFlight.current = null
      if (!reducedMotion) {
        const timerKey = `flight:${beat}` as const
        motionTimers.current.set(timerKey, setTimeout(() => {
          motionTimers.current.delete(timerKey)
          setCardFlights((current) => current.filter((flight) => flight.beat !== beat))
          if (landing) pulseMotion([landing])
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
    orderingStage, pending, pendingTrigger, reducedMotion, state, usingCard, viewer])

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
    if (cardDragFrame.current !== null) cancelAnimationFrame(cardDragFrame.current)
  }, [])

  // Unknown delivery with the item still visible stays locked until a causally
  // later REST refresh. Exact inventory evidence can recognize a commit sooner.
  useEffect(() => {
    const current = state.players.find((player) => player.id === viewerId)
    const potion = unknownPotionAction.current
    if (potion && (
      (authoritativeRefresh !== undefined && authoritativeRefresh > potion.refreshAttempt) ||
      (current && current.potions.filter((held) => held === potion.potionId).length < potion.countBefore)
    )) {
      unknownPotionAction.current = null
      potionActionPending.current = false
      setUsingPotion(false)
    }
    const power = unknownPowerAction.current
    if (power && current) {
      const used = current.powers.some((held) => held.uid === power.powerUid) &&
        state.powerTriggersUsedThisTurn.includes(powerAbilityKey(viewerId, power.powerUid))
      const refreshed = authoritativeRefresh !== undefined && authoritativeRefresh > power.refreshAttempt
      if (used || refreshed) {
        unknownPowerAction.current = null
        powerActionPending.current = false
        setUsingPower(false)
        if (!used && state.phase === 'player' && !state.startTurnProgress?.forcedCard &&
          current.powers.some((held) => held.uid === power.powerUid)) setPendingPowerUid(power.powerUid)
      }
    }
    const card = unknownCardAction.current
    const cardCommitted = card?.copy
      ? state.pendingCardCopy?.card.uid !== card.cardUid ||
        (card.copiesBefore !== undefined && state.pendingCardCopy.sourceNames.length < card.copiesBefore)
      : current && !current.hand.some((held) => held.uid === card?.cardUid)
    if (card && ((authoritativeRefresh !== undefined && authoritativeRefresh > card.refreshAttempt) || cardCommitted)) {
      if (shouldDisarmCardFlight(!card.copy, cardCommitted === true)) armedCardFlight.current = null
      unknownCardAction.current = null
      cardActionPending.current = false
      setUsingCard(false)
    }
  }, [authoritativeRefresh, state, viewerId])

  useEffect(() => {
    if (pendingPowerUid && (state.startTurnProgress?.forcedCard ||
      !viewer?.powers.some((power) => power.uid === pendingPowerUid) ||
      powerAbilityUsed(state, viewerId, pendingPowerUid))) setPendingPowerUid(null)
  }, [pendingPowerUid, state.powerTriggersUsedThisTurn, state.startTurnProgress?.forcedCard, viewer?.powers, viewerId])

  function recenterViewerRow() {
    const board = boardRef.current
    revealViewerRow(board, viewerRowRef.current)
    programmaticScroll.current = board ? { left: board.scrollLeft, top: board.scrollTop } : null
  }

  // Drop stale targeting when the phase, seat, or mandatory trigger changes.
  useEffect(() => {
    // Entering copy has its own effect below that replaces the parent card's
    // pending UI. Do not race that replacement with a second clear.
    if (!pendingUiSurvivesContext(state.phase, state.pendingCardCopy?.playerId, viewerId)) setPending(null)
    setMiracleOnCard(false)
    setSpendingShiv(false)
    setPendingPotion(null)
    setPendingPowerUid(null)
    setPotionShivEnemyUids([])
    setPotionOverflowRequired(0)
  }, [state.phase, state.pendingCardCopy?.playerId, viewerId, pendingTrigger?.id])

  useEffect(() => {
    if (!orderingStage) return
    setPending(null)
    setMiracleOnCard(false)
    setSpendingShiv(false)
    setPendingPotion(null)
    setPendingPowerUid(null)
    setPotionShivEnemyUids([])
    setPotionOverflowRequired(0)
  }, [orderingStage])

  // Only the coordinator can act on the order, and everyone else keeps a panel
  // they opened themselves, so this only ever opens.
  useEffect(() => {
    if (orderingStage && viewerId === endTurnCoordinatorId) setEndTurnOrderOpen(true)
  }, [orderingStage, viewerId, endTurnCoordinatorId])

  // The panel is a per-turn tray: leaving the player phase closes it again so
  // the next turn starts from the collapsed default.
  useEffect(() => {
    if (state.phase !== 'player') setEndTurnOrderOpen(false)
  }, [state.phase])

  // A private reveal is room state, not transient component state: restore it
  // after a reconnect so the player must finish the card they already saw.
  useEffect(() => {
    if (!cardPreview || !viewer) {
      if (onAction) setPending((current) => current?.choiceCards &&
        current.choice?.kind !== 'recover' && current.choice?.kind !== 'recoverExhaust' ? null : current)
      return
    }
    if (usingCard) return
    const copied = cardPreview.copy === true && state.pendingCardCopy?.playerId === viewer.id
    const card = copied
      ? state.pendingCardCopy!.card
      : viewer.hand.find((held) => held.uid === cardPreview.cardUid)
    if (!card) {
      if (onAction) setPending((current) => current?.choiceCards &&
        current.choice?.kind !== 'recover' && current.choice?.kind !== 'recoverExhaust' ? null : current)
      return
    }
    const next = pendingFor(card, cardPreview.cards, state, viewer, !copied,
      copied ? state.pendingCardCopy?.energySpent : undefined)
    if (next.choice?.kind !== cardPreview.kind) return
    setMiracleOnCard(cardPreview.spendMiracle)
    const restored = { ...next, enemyUid: cardPreview.enemyUid }
    setPending((current) => current?.card.uid === card.uid &&
      current.choice?.kind === cardPreview.kind &&
      current.enemyUid === cardPreview.enemyUid &&
      current.choiceCards?.length === cardPreview.cards.length &&
      current.choiceCards?.every((held, index) => held.uid === cardPreview.cards[index]?.uid)
      ? current : restored)
  }, [cardPreviewKey, viewerId, usingCard, onAction])

  useEffect(() => {
    const copy = state.pendingCardCopy
    if (state.phase !== 'copy' || !copy || copy.playerId !== viewerId || !viewer || cardPreview || usingCard) return
    const def = faceOf(cardDef(copy.card.defId), copy.card.upgraded)
    if (cardNeedsChoicePreview(def, state, viewer)) {
      if (cardNeedsEnemy(def, viewer, false, copy.energySpent)) {
        setPending({ ...pendingFor(copy.card, null, state, viewer, false, copy.energySpent), choice: null })
      } else requestCopyChoicePreview()
      return
    }
    const next = pendingFor(copy.card, null, state, viewer, false, copy.energySpent)
    setPending(next)
    stageOrCommit(next)
  }, [state.phase, state.pendingCardCopy?.card.uid, state.pendingCardCopy?.sourceNames.length,
    viewerId, cardPreviewKey, usingCard])

  // Native modal semantics make every control behind a card choice inert and
  // keep keyboard focus inside it without a custom focus trap. Hidden reveals
  // prevent cancellation; Headbutt's already-public discard choice does not.
  useEffect(() => {
    const dialog = choiceDialogRef.current
    if (!dialog) return
    if (pending?.choiceCards && !pending.choiceConfirmed) {
      if (!dialog.open) dialog.showModal()
    } else if (dialog.open) dialog.close()
  }, [pending?.choiceCards, pending?.choiceConfirmed])

  // A chosen Distilled Chaos card can still need a board target. Keeping the
  // reveal modal open makes the whole board inert and strands that card.
  const visibleDistilled = forcedCard || state.pendingCardCopy || pendingTrigger ? undefined : distilled
  const itemModalOpen = ['liquid_memories', 'purity_potion', 'entropic_brew'].includes(pendingPotion ?? '') ||
    Boolean(relicScry) || Boolean(visibleDistilled)
  useEffect(() => {
    const dialog = itemDialogRef.current
    if (itemModalOpen) {
      if (dialog && !dialog.open) dialog.showModal()
    } else if (dialog?.open) dialog.close()
  }, [itemModalOpen, pendingPotion, relicScry?.playerId, visibleDistilled?.playerId])

  useEffect(() => {
    setStartTurnScryPicked([])
    setResolvingStartTurnScry(false)
  }, [startTurnScryKey])

  useEffect(() => {
    const dialog = startTurnScryDialogRef.current
    const owned = activeStartTurnScry?.playerId === viewerId && activeStartTurnScry.cards !== null
    if (owned) {
      if (dialog && !dialog.open) dialog.showModal()
    } else if (dialog?.open) dialog.close()
  }, [startTurnScryKey, activeStartTurnScry?.playerId, activeStartTurnScry?.cards, viewerId])

  useEffect(() => {
    setResolvingStartTurnDiscard(false)
    const dialog = startTurnDiscardDialogRef.current
    const owned = activeStartTurnDiscard?.playerId === viewerId && activeStartTurnDiscard.cards !== null
    if (owned) {
      if (dialog && !dialog.open) dialog.showModal()
    } else if (dialog?.open) dialog.close()
  }, [activeStartTurnDiscard?.playerId, activeStartTurnDiscard?.sourceId,
    activeStartTurnDiscard?.cards, viewerId])

  async function finishStartTurnDiscard(card: CardInstance) {
    if (!activeStartTurnDiscard || activeStartTurnDiscard.playerId !== viewerId || resolvingStartTurnDiscard) return
    setResolvingStartTurnDiscard(true)
    if (onAction) {
      await onAction({
        kind: 'resolveStartTurnDiscard', sourceId: activeStartTurnDiscard.sourceId, discardUid: card.uid,
      })
      setResolvingStartTurnDiscard(false)
      return
    }
    onChange?.(resolveStartTurnDiscard(state, viewerId, activeStartTurnDiscard.sourceId, card.uid))
    setResolvingStartTurnDiscard(false)
  }

  // A teammate can spend Shivs or kill a staged target while this client is
  // choosing Cunning Potion's overflow attacks. Restart a changed count and
  // drop dead targets instead of submitting choices for an older board.
  useEffect(() => {
    if (!pendingPotion) return
    if (!viewer?.potions.includes(pendingPotion)) {
      setPendingPotion(null)
      setPotionShivEnemyUids([])
      setPotionOverflowRequired(0)
      return
    }
    if (pendingPotion === 'entropic_brew' && viewerHasSozu) {
      setPendingPotion(null)
      return
    }
    const gained = gainedShivs(potionDef(pendingPotion).effects)
    if (gained === 0) return
    const liveRequired = overflowShivCount(state, gained)
    if (liveRequired !== potionOverflowRequired) {
      setPotionShivEnemyUids([])
      setPotionOverflowRequired(liveRequired)
      if (liveRequired === 0) setPendingPotion(null)
      return
    }
    const alive = new Set(state.enemies.filter((enemy) => !enemy.dead).map((enemy) => enemy.uid))
    setPotionShivEnemyUids((current) => {
      const valid = current.filter((uid) => alive.has(uid))
      return valid.length === current.length ? current : valid
    })
  }, [state, viewer, viewerHasSozu, pendingPotion, potionOverflowRequired])

  // Card choices are made against a shared board too. Recompute overflow when
  // teammates take or spend cubes, and discard targets that died meanwhile.
  useEffect(() => {
    if (!viewer) return
    const alive = new Set(state.enemies.filter((enemy) => !enemy.dead).map((enemy) => enemy.uid))
    const livingPlayers = new Set(state.players.filter((player) => !player.dead).map((player) => player.id))
    setPending((current) => {
      if (!current) return current
      if (current.cardInHand
        ? !viewer.hand.some((card) => card.uid === current.card.uid)
        : state.pendingCardCopy?.playerId !== viewer.id || state.pendingCardCopy.card.uid !== current.card.uid) return null
      const def = faceOf(cardDef(current.card.defId), current.card.upgraded)
      if (current.cardInHand && !cardPlayConditionMet(def, state, viewer, drawCount)) return null
      const recover = def.effects.find((effect) => effect.kind === 'recoverDiscard')
      const recoverExhaust = def.effects.find((effect) => effect.kind === 'recoverExhaust')
      const recoveryCards = recover ? viewer.discard : recoverExhaust ? viewer.exhaust : null
      if ((recover || recoverExhaust) && recoveryCards?.length === 0) return null
      const choice = recover
        ? viewer.discard.length > 0 ? { kind: 'recover' as const, amount: recover.amount } : null
        : recoverExhaust
          ? viewer.exhaust.length > 0
            ? { kind: 'recoverExhaust' as const, amount: recoverExhaust.amount }
            : null
        : current.choice
      const choiceCards = recoveryCards ? (recoveryCards.length > 0 ? recoveryCards : null) : current.choiceCards
      const choiceCardsChanged = choiceCards?.length !== current.choiceCards?.length ||
        choiceCards?.some((card, index) => card.uid !== current.choiceCards?.[index]?.uid) === true
      const overflowShivs = overflowShivCount(state,
        cardShivsOnPlay(def, current.choice?.kind === 'discardAny' ? current.picked.length : 0))
      const overflowChanged = overflowShivs !== current.overflowShivs
      const spentShivs = cardShivChoiceCount(def, viewer)
      const spentChanged = spentShivs !== current.spentShivs
      const selectedMode = current.mode == null ? undefined : def.modes?.[current.mode]
      const selectedEnemyChoices = cardEnemyChoiceCount(def, current.mode ?? undefined)
      const mode = selectedMode?.effects.some((effect) => effect.kind === 'hitChoices' && effect.distinct) &&
        selectedEnemyChoices > alive.size ? null : current.mode
      const enemyChoices = cardEnemyChoiceCount(def, mode ?? undefined)
      const playerChoices = cardPlayerChoiceCount(def, mode ?? undefined)
      const enemyUid = current.enemyUid && alive.has(current.enemyUid) ? current.enemyUid : null
      const enemyUids = mode === current.mode ? current.enemyUids.filter((uid) => alive.has(uid)) : []
      const playerIds = current.playerIds.filter((id) => livingPlayers.has(id))
      const picked = choiceCards
        ? recover || recoverExhaust
          ? current.picked.filter((uid) => choiceCards.some((card) => card.uid === uid))
          : current.picked
        : current.picked.filter((uid) => viewer.hand.some((card) => card.uid === uid))
      const pickedChanged = picked.length !== current.picked.length
      const minimumUnpaid = current.choice?.kind === 'exhaustAny' && current.choiceConfirmed &&
        picked.length < Math.min(current.choice.minimum ?? 0,
          Math.max(0, viewer.hand.length - Number(current.cardInHand)))
      const shivEnemyUids = overflowChanged || spentChanged
        ? []
        : current.shivEnemyUids.filter((uid) => alive.has(uid))
      const needsEnemy = cardNeedsEnemy(def, viewer, false, current.effectEnergy ?? undefined) || spentShivs > 0 ||
        overflowShivs > 0 || enemyChoices > 0
      const needsSwitch = def.effects.some((effect) => effect.kind === 'switchRows') && livingPlayers.size > 1
      const switchTargetAlive = current.switchPlayerId === null || livingPlayers.has(current.switchPlayerId)
      const switchPlayerId = switchTargetAlive ? current.switchPlayerId : null
      const switchChoiceDone = !needsSwitch || (current.switchChoiceDone && switchTargetAlive)
      const invalidEvokeTarget = current.evokeEnemyUids.some((target) => {
        if (typeof target !== 'string') return false
        const row = lightningRowFromTarget(target)
        return row === null
          ? !alive.has(target)
          : !lightningTargetsRows(viewer, def.id) || !rowsOf(state).includes(row)
      })
      const evokeSlots = invalidEvokeTarget ? [] : current.evokeSlots
      const evokeEnemyUids = invalidEvokeTarget ? [] : current.evokeEnemyUids
      if (overflowChanged && !needsEnemy && !current.needsAlly && !needsSwitch && !current.choice &&
        !nextEvokeChoice(def, viewer, evokeSlots, current.mode ?? undefined, current.effectEnergy ?? 0) &&
        !evokeEnemyUids.some((target) => target === undefined)) return null
      if (
        overflowShivs === current.overflowShivs &&
        spentShivs === current.spentShivs &&
        enemyUid === current.enemyUid &&
        mode === current.mode &&
        enemyUids.length === current.enemyUids.length &&
        playerIds.length === current.playerIds.length &&
        choice?.kind === current.choice?.kind &&
        !choiceCardsChanged &&
        !pickedChanged &&
        !minimumUnpaid &&
        shivEnemyUids.length === current.shivEnemyUids.length &&
        needsSwitch === current.needsSwitch &&
        switchPlayerId === current.switchPlayerId &&
        switchChoiceDone === current.switchChoiceDone &&
        !invalidEvokeTarget
      ) return current
      return {
        ...current,
        overflowShivs,
        spentShivs,
        mode,
        needsEnemy,
        needsSwitch,
        enemyChoices,
        playerChoices,
        enemyUid,
        enemyUids,
        playerIds,
        choice,
        choiceCards,
        picked,
        switchPlayerId,
        switchChoiceDone,
        shivEnemyUids,
        choiceConfirmed: (pickedChanged || choiceCardsChanged || minimumUnpaid ||
          (overflowChanged && overflowShivs === 0)) &&
          (current.choice?.kind === 'discardAny' || current.choice?.kind === 'exhaustAny' ||
            current.choice?.kind === 'recover' || current.choice?.kind === 'recoverExhaust')
          ? false
          : current.choiceConfirmed,
        evokeSlots,
        evokeEnemyUids,
      }
    })
  }, [state, viewer, drawCount])

  useEffect(() => {
    if (onAction) return
    potionActionPending.current = false
    setUsingPotion(false)
  }, [onAction, state])

  useEffect(() => {
    if (state.phase !== 'discard') {
      setDiscardTops({})
      setRetainedCards({})
      setDiscardOrders({})
    }
    if (state.phase !== 'player') setEndTurnOrder([])
    if (state.phase !== 'start') {
      setStartTurnOrder([])
      setStartTurnEnemyTargets({})
      setStartTurnPlayerTargets({})
      setStartTurnTargets({})
      setStartTurnEvokeSlots({})
      setStartTurnEvokeTargets({})
    }
  }, [state.phase])

  useEffect(() => {
    if (state.phase !== 'start') return
    const savedChoices = new Map((savedStartTurnChoices ?? []).map((choice) => [choice.id, choice]))
    setStartTurnOrder(baseStartAbilities.map((ability) => ability.id))
    setStartTurnEnemyTargets(Object.fromEntries(baseStartAbilities.map((ability) => [
      ability.id,
      savedStartTurnEnemyTargets?.[ability.id] ??
        savedChoices.get(ability.id)?.enemyUid ??
        (ability.targets?.length === 1 ? ability.targets[0]!.uid : undefined),
    ])))
    setStartTurnPlayerTargets(Object.fromEntries(baseStartAbilities.map((ability) => [
      ability.id,
      savedChoices.get(ability.id)?.targetPlayerId ??
        (ability.players?.length === 1 ? ability.players[0]!.id : undefined),
    ])))
    setStartTurnTargets(Object.fromEntries(baseStartAbilities.map((ability) => [
      ability.id,
      savedChoices.get(ability.id)?.shivEnemyUids ?? Array(ability.overflowShivs).fill(undefined),
    ])))
    setStartTurnEvokeSlots(Object.fromEntries(baseStartAbilities.map((ability) => [
      ability.id, savedChoices.get(ability.id)?.evokeSlots ?? [],
    ])))
    setStartTurnEvokeTargets(Object.fromEntries(baseStartAbilities.map((ability) => [
      ability.id, savedChoices.get(ability.id)?.evokeEnemyUids ?? [],
    ])))
  }, [startAbilityKey, state.phase])

  useEffect(() => {
    if (state.phase !== 'discard' || !savedDiscardOrder) return
    setDiscardOrders({ [viewerId]: savedDiscardOrder })
    const ordered = new Set(savedDiscardOrder)
    setRetainedCards({
      [viewerId]: viewer?.hand.filter((card) => !ordered.has(card.uid) && !card.endTurnProtected &&
        !card.retainThisTurn && !faceOf(cardDef(card.defId), card.upgraded).retain).map((card) => card.uid) ?? [],
    })
    const top = savedDiscardOrder.at(-1)
    if (top) setDiscardTops({ [viewerId]: top })
  }, [savedDiscardKey, state.phase, viewerId])

  useEffect(() => {
    if (state.phase !== 'player' || !savedEndTurnOrder) return
    setEndTurnOrder(savedEndTurnOrder)
  }, [savedEndTurnKey, state.phase, viewerId])

  const endTurnRef = useRef<HTMLButtonElement | null>(null)
  // Focus is dropped to <body> when the enemy's turn replaces the board, so a
  // keyboard player restarted their Tab walk from the page header every round.
  // Put them back on End turn — only when focus is genuinely nowhere, so this
  // can never steal it from something they deliberately moved to.
  //
  // Gated on where the phase came FROM, not just on arriving at `player`.
  // `start -> player` also lands here: clicking "Resolve start of turn" unmounts
  // that button, focus falls to <body>, and an ungated restore parked it on End
  // turn — the most destructive key on the screen — where the next Space or
  // Enter would end the turn the player had only just started. With a pointer
  // there is no focus ring, so nothing warns them. `copy -> resumePhase` is the
  // same shape.
  const phaseBefore = useRef(state.phase)
  useEffect(() => {
    const cameFromEnemyTurn = phaseBefore.current === 'enemy' || phaseBefore.current === 'roundEnd'
    phaseBefore.current = state.phase
    if (!cameFromEnemyTurn) return
    if (state.phase !== 'player') return
    if (document.activeElement && document.activeElement !== document.body) return
    // `preventScroll`, because this is RESTORING focus the board took away, not
    // navigating to it. Without it the browser scrolls End turn into view and
    // drags the hand scroller with it — which the fanned-card checks catch.
    endTurnRef.current?.focus({ preventScroll: true })
  }, [state.phase])
  const visibleEnemies = displayedEnemies(state.enemies, prefersReducedMotion ? new Set() : falling)
  const bosses = visibleEnemies.filter((enemy) => enemy.isBoss)
  const stageEnemies = visibleEnemies.filter((enemy) => !enemy.isBoss)
  const stageCount = state.players.length + visibleEnemies.length
  const stageGap = STAGE_GAP_REM * stageScale
  const stageLayoutKey = visibleEnemies.map((enemy) => `${enemy.uid}:${enemy.row}:${enemy.isBoss}`).join('|')

  useLayoutEffect(() => {
    const board = boardRef.current
    if (!board) return
    const fit = () => {
      if (board.clientWidth === 0) return
      const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
      setStageScale(stageScaleFor(stageCount, board.clientWidth, rem))
    }
    fit()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(fit)
    observer.observe(board)
    return () => observer.disconnect()
  }, [stageCount])

  // With a full party the board can outgrow the viewport. Rather than shrink
  // everything, keep the row the player actually controls on screen.
  //
  // A layout effect, not a plain one: this must run before paint, or the board
  // is briefly drawn scrolled to the wrong row and then jumps.
  // Also on a phase change, when the board's rows can change height.
  useLayoutEffect(() => {
    followViewerRow.current = true
    recenterViewerRow()
  }, [viewerId, state.turn, state.phase, stageLayoutKey])

  useEffect(() => {
    const board = boardRef.current
    if (!board || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (followViewerRow.current) recenterViewerRow()
    })
    observer.observe(board)
    for (const row of board.querySelectorAll('.row')) observer.observe(row)
    return () => observer.disconnect()
  }, [viewerId])

  useEffect(() => {
    const board = boardRef.current
    if (!board) return
    const inspectElsewhere = () => {
      if (
        programmaticScroll.current !== null &&
        Math.abs(board.scrollLeft - programmaticScroll.current.left) < 1 &&
        Math.abs(board.scrollTop - programmaticScroll.current.top) < 1
      ) {
        programmaticScroll.current = null
        return
      }
      programmaticScroll.current = null
      if (manualBoardScroll.current) {
        manualBoardScroll.current = false
        followViewerRow.current = false
      }
    }
    const armScroll = () => { manualBoardScroll.current = true }
    const armKeyboardScroll = (event: KeyboardEvent) => {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) armScroll()
    }
    const armScrollbar = (event: PointerEvent) => {
      if (event.target === board) armScroll()
    }
    const releasePointer = () => requestAnimationFrame(() => { manualBoardScroll.current = false })
    board.addEventListener('wheel', armScroll, { passive: true })
    board.addEventListener('pointerdown', armScrollbar)
    board.addEventListener('pointerup', releasePointer)
    board.addEventListener('keydown', armKeyboardScroll)
    board.addEventListener('scroll', inspectElsewhere, { passive: true })
    return () => {
      board.removeEventListener('wheel', armScroll)
      board.removeEventListener('pointerdown', armScrollbar)
      board.removeEventListener('pointerup', releasePointer)
      board.removeEventListener('keydown', armKeyboardScroll)
      board.removeEventListener('scroll', inspectElsewhere)
    }
  }, [viewerId])

  // And again whenever the desktop window changes shape. The scroll position
  // is measured in pixels against the old layout.
  useEffect(() => {
    const reveal = () => {
      followViewerRow.current = true
      recenterViewerRow()
    }
    window.addEventListener('resize', reveal)
    return () => window.removeEventListener('resize', reveal)
  }, [])

  if (!viewer) return <p className="muted">No seat for {viewerId}.</p>

  const over = state.phase === 'won' || state.phase === 'lost'
  const pendingPotionDef = pendingPotion ? potionDef(pendingPotion) : null
  const pendingPotionNeedsCards = pendingPotion === 'liquid_memories' || pendingPotion === 'purity_potion'
  const pendingPower = pendingPowerUid
    ? viewer.powers.find((power) => power.uid === pendingPowerUid)
    : undefined
  const pendingPowerDef = pendingPower ? faceOf(cardDef(pendingPower.defId), pendingPower.upgraded) : null
  const pendingPotionOverflow = potionOverflowRequired
  const livingPlayers = state.players.filter((player) => !player.dead)
  const confirmedDiscards = decidedPlayerIds
    ? livingPlayers.filter((player) => decidedPlayerIds.includes(player.id)).length
    : livingPlayers.filter((player) => discardOrders[player.id]).length
  // Online only: hotseat has no per-seat readiness, so one click ends the turn
  // for the table and a counter there would sit at 0 until it vanished.
  const endTurnCount = decidedPlayerIds && livingPlayers.length > 1
    ? `${confirmedDiscards}/${livingPlayers.length}`
    : null
  const discardableHand = viewer.hand.filter((card) =>
    !card.endTurnProtected && !card.retainThisTurn && !faceOf(cardDef(card.defId), card.upgraded).retain)
  const retainAllowance = viewer.retainCardsThisTurn ?? 0
  const viewerRetainedCards = (retainedCards[viewer.id] ?? [])
    .filter((uid) => discardableHand.some((card) => card.uid === uid))
    .slice(0, retainAllowance)
  const retainedSet = new Set(viewerRetainedCards)
  const discardCandidates = discardableHand.filter((card) => !retainedSet.has(card.uid))
  const viewerDiscardTop = discardTops[viewer.id] && discardCandidates.some((card) => card.uid === discardTops[viewer.id])
    ? discardTops[viewer.id]
    : discardCandidates.at(-1)?.uid ?? ''
  const abilities = onAction ? (partyEndTurnAbilities ?? []) : endTurnAbilities(state)
  const endTurnNeedsChoice = abilities.length > 1 || abilities.some((ability) => (ability.targets?.length ?? 0) > 1)
  const defaultOrder = defaultEndTurnOrder(abilities)
  const viewerEndTurnOrder = validEndTurnOrder(abilities, endTurnOrder)
    ? endTurnOrder
    : defaultOrder
  const canOrderEndTurn = !orderingStage || viewer.id === endTurnCoordinatorId
  const startIds = useMemo(() => startTurnOrder.length === baseStartAbilities.length
    ? startTurnOrder
    : baseStartAbilities.map((ability) => ability.id), [baseStartAbilities, startTurnOrder])
  const startChoiceDrafts: StartTurnChoice[] = useMemo(() => startIds.map((id) => ({
    id,
    enemyUid: startTurnEnemyTargets[id],
    targetPlayerId: startTurnPlayerTargets[id],
    shivEnemyUids: (startTurnTargets[id] ?? [])
      .filter((uid): uid is string | null => uid !== undefined),
    evokeSlots: startTurnEvokeSlots[id] ?? [],
    evokeEnemyUids: (startTurnEvokeTargets[id] ?? [])
      .filter((uid): uid is string | null => uid !== undefined),
  })), [startIds, startTurnEnemyTargets, startTurnEvokeSlots, startTurnEvokeTargets,
    startTurnPlayerTargets, startTurnTargets])
  const orderedStartAbilities = useMemo(() => baseStartAbilities.length > 0
    ? startTurnAbilities(state, startIds, startChoiceDrafts)
    : [], [baseStartAbilities, startChoiceDrafts, startIds, state])
  const canResolveStartTurn = !onAction || viewer.id === startTurnCoordinatorId
  const orderTargetIndex = startTurnChoiceId
    ? orderedStartAbilities.findIndex((ability) => ability.id === startTurnChoiceId)
    : -1
  const startChoiceAbilities = partyStartTurnOrderPending
    ? orderedStartAbilities.slice(0, orderTargetIndex < 0 ? orderedStartAbilities.length : orderTargetIndex)
    : orderedStartAbilities.filter((ability) => !startTurnChoiceId || ability.id === startTurnChoiceId)
  const pendingStartChoice = canResolveStartTurn
    ? startChoiceAbilities
      .flatMap<PendingStartChoice>((ability) => {
      if (ability.targets &&
        (startTurnEnemyTargets[ability.id] === undefined || ability.enemyTargetStale)) {
        return [{ kind: 'enemy', ability }]
      }
      if (ability.players && startTurnPlayerTargets[ability.id] === undefined) {
        return [{ kind: 'player', ability }]
      }
      const shivIndex = Array.from({ length: ability.overflowShivs })
        .findIndex((_unused, index) => startTurnTargets[ability.id]?.[index] === undefined ||
          ability.staleShivIndex === index)
      if (shivIndex >= 0) return [{ kind: 'shiv', ability, index: shivIndex }]
      if (ability.evokeTargetIndex !== undefined) {
        return [{ kind: 'evokeTarget', ability, index: ability.evokeTargetIndex }]
      }
      return ability.evokeChoice ? [{ kind: 'evoke', ability }] : []
      })[0]
    : undefined
  const pendingStartEnemy = pendingStartChoice?.kind === 'enemy' ? pendingStartChoice.ability : undefined
  const pendingStartPlayer = pendingStartChoice?.kind === 'player' ? pendingStartChoice.ability : undefined
  const pendingStartShiv = pendingStartChoice?.kind === 'shiv' ? pendingStartChoice : undefined
  const pendingStartEvokeTarget = pendingStartChoice?.kind === 'evokeTarget' ? pendingStartChoice : undefined
  const pendingStartEvoke = pendingStartChoice?.kind === 'evoke' ? pendingStartChoice.ability : undefined
  const pendingStartEvokeRows = pendingStartEvokeTarget?.ability.evokeTargets?.flatMap((target) => {
    const row = lightningRowFromTarget(target.uid)
    return row === null ? [] : [{ row, uid: target.uid }]
  }) ?? []
  const startTurnReady = orderedStartAbilities.length === baseStartAbilities.length &&
    !pendingStartEnemy && !pendingStartPlayer && !pendingStartShiv && !pendingStartEvokeTarget && !pendingStartEvoke
  const meaningfulStartTurnChoice = startTurnNeedsChoice(state, baseStartAbilities)
  const isStartTurnEnemyTarget = (enemyUid: string) =>
    Boolean(pendingStartEnemy?.targets?.some((target) => target.uid === enemyUid) &&
      startEnemyChoiceAvailable(enemyUid)) ||
    Boolean(pendingStartShiv && (!pendingStartShiv.ability.shivTargets ||
      pendingStartShiv.ability.shivTargets.some((target) => target.uid === enemyUid))) ||
    Boolean(pendingStartEvokeTarget?.ability.evokeTargets?.some((target) => target.uid === enemyUid))

  function moveStartTurnAbility(id: string, delta: -1 | 1) {
    const from = startIds.indexOf(id)
    const to = from + delta
    if (!canResolveStartTurn || partyStartTurnOrderLocked || from < 0 || to < 0 || to >= startIds.length) return
    const order = [...startIds]
    ;[order[from], order[to]] = [order[to]!, order[from]!]
    const plan = startTurnAbilities(state, order)
    setStartTurnOrder(order)
    setStartTurnEnemyTargets(Object.fromEntries(plan.map((ability) => [
      ability.id,
      savedStartTurnEnemyTargets?.[ability.id] ??
        (ability.targets?.length === 1 ? ability.targets[0]!.uid : undefined),
    ])))
    setStartTurnPlayerTargets(Object.fromEntries(plan.map((ability) => [
      ability.id,
      ability.players?.length === 1 ? ability.players[0]!.id : undefined,
    ])))
    setStartTurnTargets(Object.fromEntries(plan.map((ability) => [
      ability.id,
      Array(ability.overflowShivs).fill(undefined),
    ])))
    setStartTurnEvokeSlots(Object.fromEntries(plan.map((ability) => [ability.id, []])))
    setStartTurnEvokeTargets(Object.fromEntries(plan.map((ability) => [ability.id, []])))
  }

  function chooseStartTurnEnemy(enemyUid: string) {
    if (!pendingStartEnemy || !canResolveStartTurn) return
    if (!pendingStartEnemy.targets?.some((target) => target.uid === enemyUid)) return
    if (!startEnemyChoiceAvailable(enemyUid)) return
    setStartTurnEnemyTargets({ ...startTurnEnemyTargets, [pendingStartEnemy.id]: enemyUid })
  }

  function startEnemyChoiceAvailable(enemyUid: string) {
    if (!pendingStartEnemy?.targets?.some((target) => target.uid === enemyUid)) return false
    if (!pendingStartEnemy.id.startsWith('facing:')) return true
    return facingChoicesAreValid(state, startChoiceDrafts.map((choice) =>
      choice.id === pendingStartEnemy.id ? { ...choice, enemyUid } : choice))
  }

  function chooseStartTurnPlayer(playerId: string) {
    if (!pendingStartPlayer?.players?.some((player) => player.id === playerId) || !canResolveStartTurn) return
    setStartTurnPlayerTargets({ ...startTurnPlayerTargets, [pendingStartPlayer.id]: playerId })
  }

  function chooseStartTurnShiv(enemyUid: string | null) {
    if (!pendingStartShiv || !canResolveStartTurn) return
    if (enemyUid !== null && pendingStartShiv.ability.shivTargets &&
      !pendingStartShiv.ability.shivTargets.some((target) => target.uid === enemyUid)) return
    const targets = [...(startTurnTargets[pendingStartShiv.ability.id] ?? [])]
    targets[pendingStartShiv.index] = enemyUid
    setStartTurnTargets({ ...startTurnTargets, [pendingStartShiv.ability.id]: targets })
  }

  function chooseStartTurnEvoke(slot: number) {
    if (!pendingStartEvoke?.evokeChoice || !canResolveStartTurn) return
    const picked = pendingStartEvoke.evokeChoice.options.find((option) => option.slot === slot)
    if (!picked) return
    const evokeSlots = [...(startTurnEvokeSlots[pendingStartEvoke.id] ?? []), slot]
    setStartTurnEvokeSlots({
      ...startTurnEvokeSlots,
      [pendingStartEvoke.id]: evokeSlots,
    })
    const existingTargets = startTurnEvokeTargets[pendingStartEvoke.id] ?? []
    const fallbackTarget = [
      ...Object.values(startTurnEvokeTargets).flat(),
      ...Object.values(startTurnTargets).flat(),
      ...Object.values(startTurnEnemyTargets),
    ].reverse().find((uid): uid is string => typeof uid === 'string')
    const nextDrafts = startChoiceDrafts.map((choice) => choice.id === pendingStartEvoke.id
      ? { ...choice, evokeSlots }
      : choice)
    const evokeOrbs = startTurnAbilities(state, startIds, nextDrafts)
      .find((ability) => ability.id === pendingStartEvoke.id)?.evokeOrbs ?? [picked.orb]
    setStartTurnEvokeTargets({
      ...startTurnEvokeTargets,
      [pendingStartEvoke.id]: [
        ...existingTargets,
        ...evokeOrbs.slice(existingTargets.length).map((orb) => orb === 'frost'
          ? null
          : pendingStartEvoke.evokeTargets?.length === 0 ? fallbackTarget : undefined),
      ],
    })
  }

  function chooseStartTurnEvokeEnemy(enemyUid: string) {
    if (!pendingStartEvokeTarget || !canResolveStartTurn) return
    if (!pendingStartEvokeTarget.ability.evokeTargets?.some((target) => target.uid === enemyUid)) return
    const targets = [...(startTurnEvokeTargets[pendingStartEvokeTarget.ability.id] ?? [])]
    targets[pendingStartEvokeTarget.index] = enemyUid
    setStartTurnEvokeTargets({ ...startTurnEvokeTargets, [pendingStartEvokeTarget.ability.id]: targets })
  }

  function moveStartTurnScry(id: string, delta: -1 | 1) {
    const from = startTurnScryIds.indexOf(id)
    const to = from + delta
    if (!canResolveStartTurn || from < 0 || to < 0 || to >= startTurnScryIds.length) return
    const order = [...startTurnScryIds]
    ;[order[from], order[to]] = [order[to]!, order[from]!]
    setStartTurnScryOrder(order)
  }

  function finishStartTurnScryOrder() {
    if (!canResolveStartTurn || orderedStartTurnScries.length !== baseStartTurnScries.length) return
    if (onAction) onAction({ kind: 'orderStartTurnScries', order: startTurnScryIds })
    else onChange?.(orderStartTurnScries(state, startTurnScryIds))
  }

  function chooseStartTurnScryCard(card: CardInstance) {
    if (!activeStartTurnScry?.cards || resolvingStartTurnScry) return
    setStartTurnScryPicked((picked) => picked.includes(card.uid)
      ? picked.filter((uid) => uid !== card.uid)
      : [...picked, card.uid])
  }

  async function finishStartTurnScry() {
    if (!activeStartTurnScry?.cards || activeStartTurnScry.playerId !== viewerId || resolvingStartTurnScry) return
    setResolvingStartTurnScry(true)
    if (onAction) {
      await onAction({
        kind: 'resolveStartTurnScry', sourceId: activeStartTurnScry.id, discardUids: startTurnScryPicked,
      })
      setResolvingStartTurnScry(false)
      return
    }
    onChange?.(resolveStartTurnScry(state, viewerId, activeStartTurnScry.id, startTurnScryPicked))
    setResolvingStartTurnScry(false)
  }

  function finishStartTurn() {
    if (!startTurnReady || !canResolveStartTurn) return
    const choices: StartTurnChoice[] = orderedStartAbilities.map((ability) => ({
      id: ability.id,
      enemyUid: startTurnEnemyTargets[ability.id],
      targetPlayerId: startTurnPlayerTargets[ability.id],
      shivEnemyUids: (startTurnTargets[ability.id] ?? []).map((uid) => uid ?? null),
      evokeSlots: [...(startTurnEvokeSlots[ability.id] ?? [])],
      evokeEnemyUids: (startTurnEvokeTargets[ability.id] ?? []).map((uid) => uid ?? null),
    }))
    if (onAction) onAction({ kind: 'resolveStartTurn', choices })
    else onChange?.(resolveStartPlayerTurn(state, choices))
  }

  // Resolve the engine's deterministic default plan; keep every meaningful
  // order, target, overflow, or Orb decision manual.
  useEffect(() => {
    if (!autoAdvance || state.phase !== 'start' || !canResolveStartTurn || meaningfulStartTurnChoice ||
      baseStartTurnScries.length > 0 || activeStartTurnScry ||
      activeStartTurnDiscard || pendingTrigger || forcedCard) return undefined
    let cancelled = false
    const timer = window.setTimeout(async () => {
      const choices = defaultStartTurnChoices(state)
      if (onAction) {
        const outcome = await onAction({ kind: 'resolveStartTurn', choices })
        if (!cancelled && outcome && (outcome.status === 'refused' || outcome.status === 'unknown' ||
          outcome.status === 'reconciled' && outcome.snapshot?.run?.combat?.phase === 'start' &&
          outcome.snapshot.run.combat.turn === state.turn)) setAutoAdvanceRetry((attempt) => attempt + 1)
      } else onChange?.(resolveStartPlayerTurn(state, choices))
    }, 250)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [autoAdvance, autoAdvanceRetry, authoritativeRefresh, state.phase, state.turn, canResolveStartTurn,
    meaningfulStartTurnChoice, baseStartTurnScries.length, activeStartTurnScry,
    activeStartTurnDiscard, pendingTrigger, forcedCard])

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

  useEffect(() => {
    if (!autoAdvance || state.phase !== 'enemy' && state.phase !== 'roundEnd') return undefined
    let cancelled = false
    const timer = window.setTimeout(async () => {
      const shouldRetry = (outcome: ActionOutcome | void) => outcome && (
        outcome.status === 'refused' || outcome.status === 'unknown' ||
        outcome.status === 'reconciled' &&
          outcome.snapshot?.run?.combat?.phase === state.phase &&
          outcome.snapshot.run.combat.turn === state.turn
      )
      if (state.phase === 'enemy') {
        if (onAction) {
          const outcome = await onAction({ kind: 'resolveEnemies' })
          if (!cancelled && shouldRetry(outcome)) {
            setAutoAdvanceRetry((attempt) => attempt + 1)
          }
        }
        else onChange?.(enemyTurn(state))
      } else if (onAction) {
        const outcome = await onAction({ kind: 'startTurn' })
        if (!cancelled && shouldRetry(outcome)) {
          setAutoAdvanceRetry((attempt) => attempt + 1)
        }
      } else onChange?.(startPlayerTurnWithChoices(state))
    }, 450)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [autoAdvance, autoAdvanceRetry, authoritativeRefresh, state.phase, state.turn])

  function moveEndTurnAbility(id: string, delta: -1 | 1) {
    const from = viewerEndTurnOrder.indexOf(id)
    const to = from + delta
    if (from < 0 || to < 0 || to >= viewerEndTurnOrder.length) return
    const order = [...viewerEndTurnOrder]
    ;[order[from], order[to]] = [order[to]!, order[from]!]
    setEndTurnOrder(order)
    setEndTurnError('')
  }

  function targetEndTurnAbility(choice: string, targetUid: string) {
    setEndTurnOrder(viewerEndTurnOrder.map((candidate) => candidate === choice
      ? chooseEndTurnTarget(candidate, targetUid)
      : candidate))
    setEndTurnError('')
  }

  function finishTurn() {
    if (!viewer) return
    if (pending?.choiceCards) return
    if (state.phase === 'player') {
      const order: EndTurnOrder = viewerEndTurnOrder
      if (orderingStage) {
        if (viewer.id === endTurnCoordinatorId) {
          // A refusal is normally fixed inside the order list, so reopen it even
          // if the coordinator collapsed it while the party was ordering. One
          // that lands after the turn moved on must not pry a later turn's tray
          // open, so this has to still be the same turn.
          const turn = state.turn
          const reopen = (outcome: ActionOutcome | void) => {
            if (outcome?.status === 'refused' &&
              stateRef.current.phase === 'player' && stateRef.current.turn === turn) setEndTurnOrderOpen(true)
          }
          void Promise.resolve(onAction?.({ kind: 'resolveEndTurn', abilityOrder: order }))
            .then(reopen, () => {})
        }
      } else if (onAction) onAction({ kind: 'endTurn' })
      else {
        const next = beginEndPlayerTurn(state, order)
        if (next === state) {
          setEndTurnError(STALE_END_TURN_ORDER)
          setEndTurnOrderOpen(true)
        }
        else {
          setEndTurnError('')
          onChange?.(next)
        }
      }
      return
    }
    const selected = discardTops[viewer.id]
    const top = selected && discardCandidates.some((card) => card.uid === selected)
      ? selected
      : discardCandidates.at(-1)?.uid
    const cardsToDiscard = viewer.hand.filter((card) => !retainedSet.has(card.uid))
    const order = top
      ? [...cardsToDiscard.filter((card) => card.uid !== top), viewer.hand.find((card) => card.uid === top)!]
      : cardsToDiscard
    const orders = { ...discardOrders, [viewer.id]: order.map((card) => card.uid) }
    if (onAction) {
      onAction({ kind: 'discardHand', discardOrder: orders[viewer.id] })
      return
    }
    if (livingPlayers.every((player) => orders[player.id])) {
      setDiscardTops({})
      setDiscardOrders({})
      onChange?.(endPlayerTurn(state, orders))
    } else {
      setDiscardOrders(orders)
    }
  }

  // In local solo all information is present, so a turn with literally no
  // card, token, potion, Power, or relic action can safely collapse. Online
  // hands are private and shared turn order is meaningful, so clients never
  // guess on behalf of the party.
  const viewerHasLegalAction = viewer.hand.some((card) => canAfford(state, viewer, card, false, drawCount)) ||
    viewer.shivs > 0 || viewer.miracles > 0 && viewer.energy < CAPS.energy && (
      viewer.relics.some((relic) => relic.defId === 'ice_cream') ||
      viewer.hand.some((card) => canAfford(state, viewer, card, true, drawCount))) ||
    viewer.potions.some((potionId) => canActivatePotion(state, viewer, potionId)) ||
    viewer.powers.some((power) => Boolean(faceOf(cardDef(power.defId), power.upgraded).activeAbility) &&
      !powerAbilityUsed(state, viewer.id, power.uid)) ||
    viewer.relics.some((_, relicIndex) => canActivateRelic(state, viewer, relicIndex)) || courierAvailable
  useEffect(() => {
    if (onAction || !autoAdvance || state.players.length !== 1 || state.phase !== 'player' ||
      viewer.dead || viewerHasLegalAction || forcedCard || distilled || pending || pendingTrigger || orderingStage ||
      endTurnNeedsChoice) return undefined
    const timer = window.setTimeout(finishTurn, 450)
    return () => window.clearTimeout(timer)
  }, [autoAdvance, state.phase, state.turn, state.players.length, viewer.dead, viewerHasLegalAction,
    forcedCard, distilled, pending, pendingTrigger, orderingStage, endTurnNeedsChoice])

  function reconciliation(outcome: ActionOutcome | void) {
    const snapshot = outcome?.snapshot
    if (!snapshot?.run?.combat || snapshot.version < versionRef.current) return null
    const combat = snapshot.version === versionRef.current ? stateRef.current : snapshot.run.combat
    const player = combat.players.find((candidate) => candidate.id === viewerId)
    return (combat.phase === 'player' || combat.phase === 'copy') && player ? { combat, player } : null
  }

  function consumePotion(
    potionId: string,
    context: PotionContext = {},
    overflow?: { expected: number; skip: boolean },
  ) {
    if (potionActionPending.current) return
    // Preview the atomic action against the visible board. Separate overflow
    // attacks may kill a target selected again later; keep the potion staged
    // and restart its choices instead of clearing the UI for a refused action.
    const result = activatePotion(state, viewer!.id, potionId, context)
    if (result === state) {
      if (context.shivEnemyUids?.length) setPotionShivEnemyUids([])
      return
    }
    potionActionPending.current = true
    setUsingPotion(true)
    setPending(null)
    setSpendingShiv(false)
    setMiracleOnCard(false)
    setPendingPotion(null)
    setPotionShivEnemyUids([])
    setPotionOverflowRequired(0)
    setPotionCardUids([])
    if (onAction) {
      const potionCountBefore = viewer!.potions.filter((held) => held === potionId).length
      const unlock = () => {
        unknownPotionAction.current = null
        potionActionPending.current = false
        setUsingPotion(false)
      }
      const awaitReconciliation = (refreshAttempt = refreshRef.current) => {
        setTimeout(() => {
          const current = stateRef.current.players.find((player) => player.id === viewerId)
          if (
            (current && current.potions.filter((held) => held === potionId).length < potionCountBefore) ||
            (refreshAttempt !== undefined && refreshRef.current !== undefined && refreshRef.current > refreshAttempt)
          ) unlock()
          else if (refreshAttempt !== undefined) {
            unknownPotionAction.current = { refreshAttempt, potionId, countBefore: potionCountBefore }
          } else unlock()
        }, 0)
      }
      const retry = (outcome: ActionOutcome | void) => {
        if (outcome?.status !== 'refused' && outcome?.status !== 'reconciled') return
        const authoritative = reconciliation(outcome)
        if (!authoritative) return
        const count = authoritative.player.potions.filter((held) => held === potionId).length
        if (count === 0 || (outcome.status === 'reconciled' && count < potionCountBefore)) return
        const def = potionDef(potionId)
        const liveOverflow = overflowShivCount(authoritative.combat, gainedShivs(def.effects))
        const needsTarget = Boolean(def.target) || (
          def.supportTarget === 'anyPlayer' && authoritative.combat.players.filter((player) => !player.dead).length > 1
        ) || liveOverflow > 0
        if (!needsTarget) return
        setPendingPotion(potionId)
        setPotionShivEnemyUids([])
        setPotionOverflowRequired(liveOverflow)
      }
      Promise.resolve(onAction({
        kind: 'usePotion',
        potionId,
        ...context,
        preflight: true,
        expectedShivOverflow: overflow?.expected,
        skipOverflow: overflow?.skip,
      })).then((outcome) => {
        if (outcome?.status === 'unknown') {
          awaitReconciliation(outcome.refreshAttempt)
          return
        }
        retry(outcome)
        unlock()
      }, () => {
        awaitReconciliation()
      })
      return
    }
    onChange?.(result)
  }

  function cancelPotionChoice() {
    setPendingPotion(null)
    setPotionCardUids([])
  }

  function useRelic(relicIndex: number, context: RelicContext = {}) {
    const result = activateRelic(state, viewer!.id, relicIndex, context)
    if (result === state) return
    setRelicCardUids([])
    setRelicShivEnemyUids([])
    if (onAction) void onAction({ kind: 'activateRelic', relicIndex, ...context })
    else onChange?.(result)
  }

  function usePower(powerUid: string, context: PowerContext) {
    if (powerActionPending.current) return
    const result = activatePower(state, viewer!.id, powerUid, context)
    if (result === state) return
    powerActionPending.current = true
    setUsingPower(true)
    setPendingPowerUid(null)
    if (!onAction) {
      powerActionPending.current = false
      setUsingPower(false)
      onChange?.(result)
      return
    }
    const unlock = () => {
      unknownPowerAction.current = null
      powerActionPending.current = false
      setUsingPower(false)
    }
    const waitForRefresh = (refreshAttempt = refreshRef.current) => {
      const current = stateRef.current
      if (current.powerTriggersUsedThisTurn.includes(powerAbilityKey(viewer!.id, powerUid))) {
        unlock()
      } else if (refreshAttempt !== undefined) {
        unknownPowerAction.current = { refreshAttempt, powerUid }
      } else {
        unlock()
        setPendingPowerUid(powerUid)
      }
    }
    Promise.resolve(onAction({ kind: 'activatePower', powerUid, ...context, preflight: true })).then((outcome) => {
      if (outcome?.status === 'unknown') {
        waitForRefresh(outcome.refreshAttempt)
        return
      }
      if (outcome?.status === 'refused' || outcome?.status === 'reconciled') {
        const authoritative = reconciliation(outcome)
        const held = authoritative?.player.powers.find((power) => power.uid === powerUid)
        if (held && !authoritative!.combat.startTurnProgress?.forcedCard &&
          !authoritative!.combat.powerTriggersUsedThisTurn.includes(powerAbilityKey(viewer!.id, powerUid))) {
          setPendingPowerUid(powerUid)
        }
      }
      unlock()
    }, () => waitForRefresh())
  }

  function resolveTrigger(enemyRow?: number, enemyUid?: string, targetPlayerId?: string) {
    const trigger = pendingTrigger
    if (usingTrigger || !trigger || trigger.playerId !== viewer?.id) return
    const result = resolvePendingTrigger(state, viewer!.id, trigger.id, enemyRow, enemyUid, targetPlayerId)
    if (result === state) return
    if (!onAction) {
      onChange?.(result)
      return
    }
    setUsingTrigger(true)
    Promise.resolve(onAction({
      kind: 'resolveTrigger', triggerId: trigger.id, enemyRow, enemyUid, targetPlayerId, preflight: true,
    }))
      .finally(() => setUsingTrigger(false))
  }
  // Ordinary costs choose from the visible hand minus the card being played.
  // Post-draw costs choose from the private preview, which already models the
  // hand at the exact clause where the engine will charge it.
  const choicePoolSize = pending?.choiceCards?.length ??
    Math.max(0, viewer.hand.length - Number(pending?.cardInHand ?? true))
  const variableMinimum = Math.min(pending?.choice?.minimum ?? 0, choicePoolSize)
  const choiceNeeded = pending?.choice && pending.choice.kind !== 'scry' &&
    pending.choice.kind !== 'discardAny' && pending.choice.kind !== 'exhaustAny'
    ? Math.min(pending.choice.amount, choicePoolSize)
    : 0
  const pendingDef = pending ? faceOf(cardDef(pending.card.defId), pending.card.upgraded) : null
  const handChoiceSatisfied = pending?.choice?.kind === 'scry'
    ? true
    : pending?.choice?.kind === 'discardAny' || pending?.choice?.kind === 'exhaustAny'
      ? true
    : pending?.choice ? pending.picked.length === choiceNeeded : true
  const revealedChoiceSatisfied = !pending?.choiceCards || pending.choiceConfirmed
  const variableChoiceSatisfied = pending?.choice?.kind !== 'discardAny' && pending?.choice?.kind !== 'exhaustAny' ||
    pending.choiceConfirmed && pending.picked.length >= variableMinimum
  const modeSatisfied = !pendingDef?.modes || pending?.mode !== null
  const energyChoiceSatisfied = pendingDef?.cost !== 'X' || pending?.energySpent !== null
  const choiceSatisfied = handChoiceSatisfied && revealedChoiceSatisfied && variableChoiceSatisfied &&
    modeSatisfied && energyChoiceSatisfied
  const pendingNeedsCardEnemy = pendingDef
    ? cardNeedsEnemy(pendingDef.modes && pending?.mode != null
      ? { ...pendingDef, modes: undefined, effects: pendingDef.modes[pending.mode]?.effects ?? [] }
      : pendingDef, viewer, false, pending?.effectEnergy ?? undefined)
    : false
  const pendingEvokeChoice = pendingDef && pending
    ? nextEvokeChoice(pendingDef, viewer, pending.evokeSlots, pending.mode ?? undefined, pending.effectEnergy ?? 0)
    : null
  const pendingEvokeTarget = pending?.evokeEnemyUids.findIndex((target) => target === undefined) ?? -1
  const pendingEvokeTargetOptions = pendingDef && pending && viewer
    ? evokeTargetProgress(
      pendingDef, state, viewer, pending.evokeSlots, pending.evokeEnemyUids,
      pending.mode ?? undefined, pending.effectEnergy ?? 0,
    ).options
    : []
  const pendingEvokeTargetUids = new Set(pendingEvokeTargetOptions.map((option) => option.uid))
  const pendingEvokeUsesRows = Boolean(pending && pendingEvokeTarget >= 0 &&
    chosenEvokeOrbs(pendingDef!, viewer, pending.evokeSlots,
      pending.mode ?? undefined, pending.effectEnergy ?? 0)[pendingEvokeTarget] === 'lightning' &&
    lightningTargetsRows(viewer, pending.card.defId))
  const evokeChoicesDone = pendingEvokeChoice === null && pendingEvokeTarget < 0
  const enemyChoicesDone = pending ? (
    evokeChoicesDone &&
    (!pendingNeedsCardEnemy || pending.enemyUid !== null) &&
    pending.enemyUids.length >= pending.enemyChoices &&
    pending.shivEnemyUids.length >= pending.spentShivs + pending.overflowShivs
  ) : true
  const allyChoiceDone = (!pending?.needsAlly || pending.playerId !== null) &&
    (!pending || pending.playerIds.length >= pending.playerChoices)
  const switchChoiceReady = Boolean(pending?.needsSwitch && !pending.switchChoiceDone &&
    enemyChoicesDone && choiceSatisfied && allyChoiceDone)

  function commit(next: Pending, skipOverflow = false) {
    if (cardActionPending.current) return
    const context = {
      enemyUid: next.enemyUid,
      enemyUids: next.enemyUids,
      playerId: next.playerId ?? viewer!.id,
      energySpent: next.energySpent ?? undefined,
      playerIds: next.playerIds,
      switchWithPlayerId: next.switchChoiceDone ? next.switchPlayerId : null,
      mode: next.mode ?? undefined,
      discardUids: next.choice?.kind === 'discard' || next.choice?.kind === 'discardAny'
        ? next.picked
        : undefined,
      exhaustUids: next.choice?.kind === 'exhaust' || next.choice?.kind === 'exhaustAny'
        ? next.picked
        : undefined,
      scryDiscardUids: next.choice?.kind === 'scry' ? next.picked : undefined,
      topdeckUids: next.choice?.kind === 'topdeck' ? next.picked : undefined,
      recoverDiscardUids: next.choice?.kind === 'recover' ? next.picked : undefined,
      recoverExhaustUid: next.choice?.kind === 'recoverExhaust' ? next.picked[0] : undefined,
      searchDrawUids: next.choice?.kind === 'search' ? next.picked : undefined,
      spendMiracle: miracleOnCard,
      shivEnemyUids: next.shivEnemyUids,
      evokeSlots: next.evokeSlots,
      evokeEnemyUids: next.evokeEnemyUids as (string | null)[],
    }
    // The online draw pile is redacted. The room has already bound this action
    // to its private preview, so only the authoritative engine can validate it.
    const result = onAction && next.choiceCards
      ? undefined
      : next.cardInHand
        ? playCard(state, viewer!.id, next.card.uid, context)
        : playCardCopy(state, viewer!.id, context)
    if (result === state) {
      if (next.enemyUids.length > 0 || next.playerIds.length > 0 ||
        next.shivEnemyUids.length > 0 || next.evokeSlots.length > 0) {
        setPending({ ...next, enemyUids: [], playerIds: [], shivEnemyUids: [], evokeSlots: [], evokeEnemyUids: [] })
      }
      return
    }
    if (next.cardInHand) armedCardFlight.current = next.card
    const action = {
      kind: next.cardInHand ? 'playCard' : 'playCardCopy',
      cardUid: next.card.uid,
      ...context,
      preflight: true,
      expectedShivOverflow: next.overflowShivs > 0 ? next.overflowShivs : undefined,
      skipOverflow: next.overflowShivs > 0 ? skipOverflow : undefined,
    }
    if (onAction) {
      const usingMiracle = miracleOnCard
      cardActionPending.current = true
      setUsingCard(true)
      setMiracleOnCard(false)
      setPending(null)
      const unlock = () => {
        unknownCardAction.current = null
        cardActionPending.current = false
        setUsingCard(false)
      }
      const finish = (outcome: ActionOutcome | void) => {
        if (outcome?.status === 'unknown') {
          const current = stateRef.current.players.find((player) => player.id === viewerId)
          const currentCopy = stateRef.current.pendingCardCopy
          const copiesBefore = next.cardInHand ? undefined : state.pendingCardCopy?.sourceNames.length
          const refreshAttempt = outcome.refreshAttempt ?? refreshRef.current
          const committed = next.cardInHand
            ? current && !current.hand.some((card) => card.uid === next.card.uid)
            : currentCopy?.card.uid !== next.card.uid ||
              (copiesBefore !== undefined && currentCopy.sourceNames.length < copiesBefore)
          const refreshed = refreshAttempt !== undefined && refreshRef.current !== undefined &&
            refreshRef.current > refreshAttempt
          if (committed || refreshed) {
            if (refreshed && shouldDisarmCardFlight(next.cardInHand, committed === true)) {
              armedCardFlight.current = null
            }
            unlock()
          }
          else if (refreshAttempt !== undefined) {
            unknownCardAction.current = {
              refreshAttempt,
              cardUid: next.card.uid,
              copy: !next.cardInHand,
              copiesBefore,
            }
          } else {
            if (current?.hand.some((card) => card.uid === next.card.uid)) armedCardFlight.current = null
            unlock()
          }
          return
        }
        unlock()
        if (outcome?.status === 'refused' || outcome?.status === 'reconciled') {
          const authoritative = reconciliation(outcome)
          if (!authoritative) {
            if (shouldDisarmCardFlight(next.cardInHand, false)) armedCardFlight.current = null
            return
          }
          if (next.cardInHand
            ? !authoritative.player.hand?.some((card) => card.uid === next.card.uid)
            : authoritative.combat.pendingCardCopy?.card.uid !== next.card.uid) return
          if (next.cardInHand) armedCardFlight.current = null
          if (next.choiceCards &&
            (next.choice?.kind === 'recover' || next.choice?.kind === 'recoverExhaust')) {
            setMiracleOnCard(usingMiracle)
            const cards = next.choice.kind === 'recover'
              ? authoritative.player.discard
              : authoritative.player.exhaust
            if (cards.length === 0) {
              setPending(null)
              return
            }
            setPending({
              ...next,
              choice: cards.length > 0 ? { kind: next.choice.kind, amount: next.choice.amount } : null,
              choiceCards: cards.length > 0 ? cards : null,
              choiceConfirmed: false,
              picked: [],
              enemyUid: null,
            })
            return
          }
          if (next.choiceCards) {
            setMiracleOnCard(usingMiracle)
            if (next.cardInHand) requestChoicePreview(next.card, next.enemyUid)
            else requestCopyChoicePreview(next.enemyUid)
            return
          }
          const def = faceOf(cardDef(next.card.defId), next.card.upgraded)
          const overflowShivs = overflowShivCount(authoritative.combat,
            cardShivsOnPlay(def, next.choice?.kind === 'discardAny' ? next.picked.length : 0))
          const spentShivs = cardShivChoiceCount(def, authoritative.player)
          const enemyChoices = cardEnemyChoiceCount(def)
          const playerChoices = cardPlayerChoiceCount(def)
          const cost = next.cardInHand ? playCost(def, authoritative.player, next.card) : 0
          const energySpent = next.cardInHand ? cost === 'X' ? null : 0
            : authoritative.combat.pendingCardCopy?.energySpent ?? 0
          const effectEnergy = next.cardInHand && def.cost === 'X' && cost !== 'X' ? cost : energySpent
          const needsEnemy = cardNeedsEnemy(def, authoritative.player, false, effectEnergy ?? undefined) || spentShivs > 0 ||
            overflowShivs > 0 || enemyChoices > 0
          const needsAlly = def.supportTarget === 'anyPlayer' &&
            authoritative.combat.players.filter((player) => !player.dead).length > 1
          const needsSwitch = def.effects.some((effect) => effect.kind === 'switchRows') &&
            authoritative.combat.players.filter((player) => !player.dead).length > 1
          setMiracleOnCard(usingMiracle)
          if (needsEnemy || needsAlly || playerChoices > 0 || needsSwitch || def.modes || next.choice ||
            nextEvokeChoice(def, authoritative.player, [], undefined, effectEnergy ?? 0)) {
            setPending({
              ...next,
              energySpent,
              effectEnergy,
              needsEnemy,
              needsAlly,
              needsSwitch,
              overflowShivs,
              spentShivs,
              enemyChoices,
              playerChoices,
              enemyUid: null,
              enemyUids: [],
              playerId: null,
              playerIds: authoritative.combat.players.filter((player) => !player.dead).length === 1
                ? Array(playerChoices).fill(authoritative.player.id)
                : [],
              picked: next.picked.filter((uid) =>
                authoritative.player.hand?.some((card) => card.uid === uid) === true),
              choiceConfirmed: overflowShivs === 0 &&
                (next.choice?.kind === 'discardAny' || next.choice?.kind === 'exhaustAny')
                ? false
                : next.choiceConfirmed,
              switchPlayerId: null,
              switchChoiceDone: false,
              shivEnemyUids: [],
              evokeSlots: [],
              evokeEnemyUids: [],
              mode: null,
            })
          }
        }
      }
      Promise.resolve(onAction(action)).then(finish, () => finish({ status: 'unknown' }))
      return
    }
    setMiracleOnCard(false)
    if (result) onChange?.(result)
    setPending(null)
  }

  function stageOrCommit(next: Pending) {
    const def = faceOf(cardDef(next.card.defId), next.card.upgraded)
    const evokeProgress = evokeTargetProgress(
      def, state, viewer!, next.evokeSlots, next.evokeEnemyUids,
      next.mode ?? undefined, next.effectEnergy ?? 0,
    )
    if (evokeProgress.endedCombat && next.evokeEnemyUids.length > evokeProgress.index) {
      next = { ...next, evokeEnemyUids: next.evokeEnemyUids.slice(0, evokeProgress.index) }
    }
    const overflowShivs = overflowShivCount(state,
      cardShivsOnPlay(def, next.choice?.kind === 'discardAny' ? next.picked.length : 0))
    const spentShivs = cardShivChoiceCount(def, viewer!)
    if (overflowShivs !== next.overflowShivs || spentShivs !== next.spentShivs) {
      next = {
        ...next,
        overflowShivs,
        spentShivs,
        needsEnemy: cardNeedsEnemy(def, viewer!, false) || spentShivs > 0 ||
          overflowShivs > 0 || next.enemyChoices > 0,
        shivEnemyUids: [],
      }
      setPending(next)
    }
    const poolSize = next.choiceCards?.length ?? Math.max(0, viewer!.hand.length - Number(next.cardInHand))
    const minimumPaid = next.picked.length >= Math.min(next.choice?.minimum ?? 0, poolSize)
    const owed = next.choice && next.choice.kind !== 'scry' &&
      next.choice.kind !== 'discardAny' && next.choice.kind !== 'exhaustAny'
      ? Math.min(next.choice.amount, poolSize)
      : 0
    const selectionReady = next.choice?.kind === 'scry' || next.choice?.kind === 'discardAny' ||
      next.choice?.kind === 'exhaustAny' ||
      next.picked.length === owed
    const ready = selectionReady && minimumPaid && (!next.choiceCards || next.choiceConfirmed) &&
      (next.choice?.kind !== 'discardAny' && next.choice?.kind !== 'exhaustAny' || next.choiceConfirmed) &&
      (!def.modes || next.mode !== null) &&
      !nextEvokeChoice(def, viewer!, next.evokeSlots, next.mode ?? undefined, next.effectEnergy ?? 0) &&
      !next.evokeEnemyUids.some((target) => target === undefined) &&
      (def.cost !== 'X' || next.energySpent !== null) &&
      (!cardNeedsEnemy(def.modes ? { ...def, modes: undefined, effects: def.modes[next.mode!]!.effects } : def,
        viewer!, false, next.effectEnergy ?? undefined) || next.enemyUid !== null) &&
      next.enemyUids.length >= next.enemyChoices &&
      next.shivEnemyUids.length >= next.spentShivs + next.overflowShivs &&
      next.playerIds.length >= next.playerChoices &&
      (!next.needsAlly || next.playerId !== null) &&
      (!next.needsSwitch || next.switchChoiceDone)
    if (ready) commit(next)
    else setPending(next)
  }

  function requestChoicePreview(card: CardInstance, enemyUid: string | null = null) {
    if (cardActionPending.current) return
    if (!onAction) {
      const preview = previewCardChoice(state, viewer!.id, card.uid)
      if (!preview) return
      const next = { ...pendingFor(card, preview.cards, state, viewer!), enemyUid }
      if (next.choice?.kind === preview.kind) setPending(next)
      return
    }

    cardActionPending.current = true
    setUsingCard(true)
    Promise.resolve(onAction({
      kind: 'previewCard', cardUid: card.uid, spendMiracle: miracleOnCard, enemyUid,
    })).then((outcome) => {
      cardActionPending.current = false
      setUsingCard(false)
      const preview = outcome?.snapshot?.cardPreview
      const current = stateRef.current
      const player = current.players.find((candidate) => candidate.id === viewerId)
      const held = player?.hand.find((candidate) => candidate.uid === card.uid)
      if (outcome?.status !== 'accepted' || !preview || preview.cardUid !== card.uid || !player || !held) return
      const next = { ...pendingFor(held, preview.cards, current, player), enemyUid: preview.enemyUid }
      if (next.choice?.kind === preview.kind) setPending(next)
    }, () => {
      cardActionPending.current = false
      setUsingCard(false)
    })
  }

  function requestCopyChoicePreview(enemyUid: string | null = null) {
    if (cardActionPending.current || !viewer) return
    const copy = state.pendingCardCopy
    if (!copy || copy.playerId !== viewer.id) return
    if (!onAction) {
      const preview = previewCardCopyChoice(state, viewer.id)
      if (!preview) return
      const next = { ...pendingFor(copy.card, preview.cards, state, viewer, false, copy.energySpent), enemyUid }
      if (next.choice?.kind === preview.kind) setPending(next)
      return
    }
    cardActionPending.current = true
    setUsingCard(true)
    Promise.resolve(onAction({ kind: 'previewCardCopy', cardUid: copy.card.uid, enemyUid })).then((outcome) => {
      cardActionPending.current = false
      setUsingCard(false)
      const current = stateRef.current
      const currentCopy = current.pendingCardCopy
      const player = current.players.find((candidate) => candidate.id === viewerId)
      const preview = outcome?.snapshot?.cardPreview
      if (outcome?.status !== 'accepted' || !preview?.copy || !currentCopy || !player) return
      const next = { ...pendingFor(currentCopy.card, preview.cards, current, player, false,
        currentCopy.energySpent), enemyUid: preview.enemyUid }
      if (next.choice?.kind === preview.kind) setPending(next)
    }, () => {
      cardActionPending.current = false
      setUsingCard(false)
    })
  }

  function onCardClick(
    card: CardInstance,
    draggedEnemyUid: string | null = null,
    draggedPlayerId: string | null = null,
  ) {
    if (cardActionPending.current || orderingStage || pendingTrigger) return
    setPendingPowerUid(null)
    setSpendingShiv(false)
    setPendingPotion(null)
    setPotionShivEnemyUids([])
    setPotionOverflowRequired(0)
    // While a card is waiting on a choice, clicks in hand pick cards for it.
    if (pending?.choice && !pending.choiceCards && card.uid !== pending.card.uid) {
      const already = pending.picked.includes(card.uid)
      const any = pending.choice.kind === 'discardAny' || pending.choice.kind === 'exhaustAny'
      const handChoices = Math.max(0, viewer!.hand.length - Number(pending.cardInHand))
      const need = pending.choice.kind === 'discardAny'
        ? handChoices
        : Math.min(pending.choice.amount, handChoices)
      const picked = already
        ? pending.picked.filter((uid) => uid !== card.uid)
        : [...pending.picked, card.uid].slice(-need)
      const next = { ...pending, picked, choiceConfirmed: false }
      setPending(next)
      // True Grit exhausts a card AND blocks any player, so satisfying the
      // choice must not skip the ally step.
      if (!any && !next.needsEnemy && !next.needsAlly &&
        next.playerIds.length >= next.playerChoices && !next.needsSwitch && picked.length === need) {
        stageOrCommit(next)
      }
      return
    }

    // A normal staged card can be cancelled. A card that already revealed
    // hidden information is committed and must be finished.
    if (pending?.card.uid === card.uid) {
      if (pending.choiceCards && pending.choice?.kind !== 'recover' &&
        pending.choice?.kind !== 'recoverExhaust') return
      setPending(null)
      return
    }

    if (pending?.choiceCards) return

    // Retargeting the hand replaces an unfinished target choice; it never
    // commits the previously selected card.
    if (pending && pending.card.uid !== card.uid) setPending(null)

    const def = faceOf(cardDef(card.defId), card.upgraded)
    if (cardNeedsChoicePreview(def, state, viewer!)) {
      if (cardNeedsEnemy(def, viewer!, false)) {
        if (draggedEnemyUid) {
          requestChoicePreview(card, draggedEnemyUid)
          return
        }
        const next = pendingFor(card, null, state, viewer!)
        setPending({ ...next, choice: null })
        return
      }
      requestChoicePreview(card)
      return
    }
    let next = pendingFor(card, null, state, viewer!)
    if (draggedEnemyUid) {
      if (cardNeedsEnemy(def, viewer!, false)) next = { ...next, enemyUid: draggedEnemyUid }
      else if (next.enemyChoices > 0 || def.modes) next = { ...next, enemyUids: [draggedEnemyUid] }
      else if (next.spentShivs + next.overflowShivs > 0) next = { ...next, shivEnemyUids: [draggedEnemyUid] }
    }
    if (draggedPlayerId) {
      if (next.playerChoices > 0) next = { ...next, playerIds: [draggedPlayerId] }
      else if (next.needsAlly) next = { ...next, playerId: draggedPlayerId }
    }
    stageOrCommit(next)
  }

  function dragTargetAt(x: number, y: number, hitsRow: boolean): string | null {
    const hit = document.elementFromPoint(x, y)
    const enemy = hit?.closest<HTMLElement>('.enemy') ?? (hitsRow
      ? hit?.closest<HTMLElement>('.row')?.querySelector<HTMLElement>('.enemy:not(.enemy--dead)')
      : null)
    const uid = enemy?.dataset.enemyId
    return uid && state.enemies.some((candidate) => candidate.uid === uid && !candidate.dead) ? uid : null
  }

  function dragPlayerAt(x: number, y: number): string | null {
    const id = document.elementFromPoint(x, y)?.closest<HTMLElement>('.seat')?.dataset.playerId
    return id && state.players.some((candidate) => candidate.id === id && !candidate.dead) ? id : null
  }

  function onCardPointerDown(card: CardInstance, event: React.PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || !cardCanStartDrag(card)) return
    const def = faceOf(cardDef(card.defId), card.upgraded)
    const pending = pendingFor(card, null, state, viewer!)
    event.currentTarget.setPointerCapture(event.pointerId)
    cardDragStart.current = {
      card, pointerId: event.pointerId,
      startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY,
      needsEnemy: pending.needsEnemy,
      needsPlayer: !pending.needsEnemy && (pending.needsAlly || pending.playerChoices > 0),
      hitsRow: def.target === 'row',
      element: event.currentTarget,
    }
  }

  function onCardPointerMove(event: React.PointerEvent<HTMLElement>) {
    const start = cardDragStart.current
    if (!start || start.pointerId !== event.pointerId) return
    if (!cardDragLive.current &&
      Math.hypot(event.clientX - start.startX, event.clientY - start.startY) < 10) return
    cardDragMove.current = { x: event.clientX, y: event.clientY }
    if (cardDragFrame.current !== null) return
    cardDragFrame.current = requestAnimationFrame(() => {
      cardDragFrame.current = null
      const active = cardDragStart.current
      const move = cardDragMove.current
      if (!active || !move) return
      const next: CardDrag = {
        card: active.card,
        pointerId: active.pointerId,
        startX: active.startX,
        startY: active.startY,
        x: move.x,
        y: move.y,
        targetUid: active.needsEnemy ? dragTargetAt(move.x, move.y, active.hitsRow) : null,
        targetPlayerId: active.needsPlayer ? dragPlayerAt(move.x, move.y) : null,
        needsEnemy: active.needsEnemy,
        needsPlayer: active.needsPlayer,
        hitsRow: active.hitsRow,
      }
      const previous = cardDragLive.current
      cardDragLive.current = next
      const path = `M ${next.startX} ${next.startY - 45} Q ${next.startX} ${next.y} ${next.x} ${next.y}`
      cardDragArrow.current?.setAttribute('d', path)
      cardDragArrowShadow.current?.setAttribute('d', path)
      if (cardDragOverlay.current) {
        cardDragOverlay.current.style.setProperty(
          '--drag-y',
          `${Math.max(0, next.y - next.startY + 210)}px`,
        )
        cardDragOverlay.current.style.setProperty(
          '--drag-turn',
          `${Math.max(-8, Math.min(8, (next.x - next.startX) / 24))}deg`,
        )
      }
      if (!previous || previous.targetUid !== next.targetUid ||
        previous.targetPlayerId !== next.targetPlayerId) setCardDrag(next)
    })
  }

  function cardCanStartDrag(card: CardInstance) {
    return !usingCard && !pending && !pendingTrigger && !orderingStage && state.phase === 'player' &&
      !forcedCard && !distilled && !relicScry && canAfford(state, viewer!, card, miracleOnCard, drawCount)
  }

  function clearCardDrag() {
    cardDragStart.current = null
    cardDragLive.current = null
    cardDragMove.current = null
    if (cardDragFrame.current !== null) cancelAnimationFrame(cardDragFrame.current)
    cardDragFrame.current = null
    setCardDrag(null)
  }

  function finishCardDrag(event: React.PointerEvent<HTMLElement>) {
    const start = cardDragStart.current
    if (!start || start.pointerId !== event.pointerId) return
    const moved = Math.hypot(event.clientX - start.startX, event.clientY - start.startY) >= 10
    const lifted = event.clientY < start.startY - 10
    const needsEnemy = cardDragLive.current?.needsEnemy ?? start.needsEnemy
    const needsPlayer = cardDragLive.current?.needsPlayer ?? start.needsPlayer
    const targetUid = needsEnemy ? dragTargetAt(event.clientX, event.clientY, start.hitsRow) : null
    const targetPlayerId = needsPlayer ? dragPlayerAt(event.clientX, event.clientY) : null
    clearCardDrag()
    if (start.element.hasPointerCapture(event.pointerId)) start.element.releasePointerCapture(event.pointerId)
    if (!moved) return
    suppressCardClick.current = start.card.uid
    setTimeout(() => {
      if (suppressCardClick.current === start.card.uid) suppressCardClick.current = null
    }, 0)
    if (lifted && (!needsEnemy || targetUid) && (!needsPlayer || targetPlayerId)) {
      onCardClick(start.card, targetUid, targetPlayerId)
    }
  }

  function cancelCardDrag(event: React.PointerEvent<HTMLElement>) {
    if (cardDragStart.current?.pointerId !== event.pointerId) return
    clearCardDrag()
  }

  function activateCard(card: CardInstance) {
    if (suppressCardClick.current === card.uid) {
      suppressCardClick.current = null
      return
    }
    onCardClick(card)
  }

  // Distilled Chaos already asks which card to play. Requiring a second click
  // on the same card in hand added no decision; stage it immediately so the
  // next interaction is its real target/choice (or resolve it if it has none).
  const forcedAttemptKey = forcedCardUid ? `${state.turn}\0${forcedCardUid}` : null
  useEffect(() => {
    if (!forcedAttemptKey || !mutationsEnabled) {
      forcedAutoAttempt.current = null
      return
    }
    if (!forcedCardUid || !viewer || pending || usingCard || forcedAutoAttempt.current === forcedAttemptKey) return
    const card = viewer.hand.find((held) => held.uid === forcedCardUid)
    if (card) {
      forcedAutoAttempt.current = forcedAttemptKey
      onCardClick(card)
    }
    // The forced uid is the authoritative transition. The helpers close over
    // the matching state snapshot; depending on them would re-stage each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forcedAttemptKey, mutationsEnabled, usingCard])

  function onChoiceCardClick(card: CardInstance) {
    if (!pending?.choiceCards || !pending.choice) return
    const already = pending.picked.includes(card.uid)
    const picked = already
      ? pending.picked.filter((uid) => uid !== card.uid)
      : pending.choice.kind === 'scry'
        ? [...pending.picked, card.uid]
        : [...pending.picked, card.uid].slice(-choiceNeeded)
    setPending({ ...pending, picked, choiceConfirmed: false })
  }

  function confirmChoice() {
    if (!pending?.choiceCards || !handChoiceSatisfied) return
    stageOrCommit({ ...pending, choiceConfirmed: true })
  }

  // AoE potions, powers and evokes used to have exactly one way to pick a row:
  // a "Target Row <name>" button in that row's own lane, separate from the
  // board and separate from how every single-target effect is aimed — click
  // the thing you mean to hit. This derives that same click from any enemy in
  // the row, the way a `target: 'row'` CARD already works (see `pending.hitsRow`
  // below): the enemy is just the anchor, its row is the actual target. The
  // buttons stay for a row with nothing living in it to click — a boss-only
  // lane, or one already cleared — where an anchor is not available.
  function onEnemyClick(enemy: Enemy) {
    if (pendingTrigger && pendingTrigger.playerId === viewer?.id) {
      if (pendingTrigger.targets?.some((target) => target.uid === enemy.uid)) {
        resolveTrigger(undefined, enemy.uid)
        return
      }
      if (pendingTrigger.rows?.some((target) => target.row === enemy.row)) {
        resolveTrigger(enemy.row)
        return
      }
    }
    if (pendingStartEnemy) {
      chooseStartTurnEnemy(enemy.uid)
      return
    }
    if (pendingStartShiv) {
      chooseStartTurnShiv(enemy.uid)
      return
    }
    if (pendingStartEvokeTarget) {
      const rowTarget = pendingStartEvokeRows.find((target) => target.row === enemy.row)
      if (rowTarget) {
        chooseStartTurnEvokeEnemy(rowTarget.uid)
        return
      }
      if (pendingStartEvokeRows.length > 0) return
      chooseStartTurnEvokeEnemy(enemy.uid)
      return
    }
    if (pendingPotion) {
      if (pendingPotionDef?.target === 'enemy') {
        consumePotion(pendingPotion, { enemyUid: enemy.uid })
      } else if (pendingPotionDef?.target === 'row') {
        consumePotion(pendingPotion, { enemyRow: enemy.row })
      } else if (!pendingPotionDef?.target && potionShivEnemyUids.length < pendingPotionOverflow) {
        const next = [...potionShivEnemyUids, enemy.uid]
        if (next.length === pendingPotionOverflow) {
          consumePotion(
            pendingPotion,
            { shivEnemyUids: next },
            { expected: pendingPotionOverflow, skip: false },
          )
        } else setPotionShivEnemyUids(next)
      }
      return
    }
    if (pendingPowerUid && pendingPowerDef) {
      if (pendingPowerDef.target === 'row') usePower(pendingPowerUid, { enemyRow: enemy.row })
      else usePower(pendingPowerUid, { enemyUid: enemy.uid })
      return
    }
    if (spendingShiv) {
      if (onAction) {
        setSpendingShiv(false)
        onAction({ kind: 'spendShiv', enemyUid: enemy.uid })
        return
      }
      const result = spendShiv(state, viewer!.id, enemy.uid)
      if (result !== state) {
        setSpendingShiv(false)
        onChange?.(result)
      }
      return
    }
    if (pending && pendingEvokeTarget >= 0 && choiceSatisfied) {
      const targets = [...pending.evokeEnemyUids]
      if (pendingEvokeUsesRows) {
        if (!pendingEvokeTargetUids.has(lightningRowTarget(enemy.row))) return
        targets[pendingEvokeTarget] = lightningRowTarget(enemy.row)
      } else {
        if (!pendingEvokeTargetUids.has(enemy.uid)) return
        targets[pendingEvokeTarget] = enemy.uid
      }
      stageOrCommit({ ...pending, evokeEnemyUids: targets })
      return
    }
    if (!evokeChoicesDone) return
    if (!pending || !pending.needsEnemy || !choiceSatisfied) return
    const normalTargetNeeded = pendingNeedsCardEnemy && !pending.enemyUid
    if (normalTargetNeeded) {
      if (pendingDef && cardNeedsChoicePreview(pendingDef, state, viewer!)) {
        if (pending.cardInHand) requestChoicePreview(pending.card, enemy.uid)
        else requestCopyChoicePreview(enemy.uid)
        return
      }
      const next = { ...pending, enemyUid: enemy.uid }
      if (next.enemyUids.length < next.enemyChoices || next.spentShivs + next.overflowShivs > 0 ||
        next.needsAlly || next.playerIds.length < next.playerChoices || next.needsSwitch) setPending(next)
      else commit(next)
      return
    }
    if (pending.enemyUids.length < pending.enemyChoices) {
      const effects = pendingDef?.modes && pending.mode != null
        ? pendingDef.modes[pending.mode]?.effects ?? []
        : pendingDef?.effects ?? []
      if (effects.some((effect) => effect.kind === 'hitChoices' && effect.distinct) &&
        pending.enemyUids.includes(enemy.uid)) return
      const next = { ...pending, enemyUids: [...pending.enemyUids, enemy.uid] }
      if (next.enemyUids.length < next.enemyChoices || next.spentShivs + next.overflowShivs > 0 ||
        next.needsAlly || next.playerIds.length < next.playerChoices || next.needsSwitch) setPending(next)
      else commit(next)
      return
    }
    if (pending.shivEnemyUids.length < pending.spentShivs + pending.overflowShivs) {
      const next = { ...pending, shivEnemyUids: [...pending.shivEnemyUids, enemy.uid] }
      if (next.shivEnemyUids.length < next.spentShivs + next.overflowShivs || next.needsAlly ||
        next.playerIds.length < next.playerChoices || next.needsSwitch) setPending(next)
      else commit(next)
    }
  }

  // Mirrors `onEnemyClick`'s row branches exactly: whatever this says yes to is
  // exactly what a click on the enemy resolves, and the two are kept next to
  // each other for that reason — a highlight that promised a row click and then
  // fell through to nothing behind it would be worse than no highlight at all.
  function isEnemyRowClickTargetable(enemy: Enemy): boolean {
    if (!usingTrigger && pendingTrigger && pendingTrigger.playerId === viewer?.id &&
      pendingTrigger.rows?.some((target) => target.row === enemy.row)) {
      return true
    }
    if (pendingStartEvokeTarget && pendingStartEvokeRows.some((target) => target.row === enemy.row)) return true
    if (pendingPotion && pendingPotionDef?.target === 'row') return true
    if (pendingPowerUid && pendingPowerDef?.target === 'row') return true
    if (pending && pendingEvokeTarget >= 0 && pendingEvokeUsesRows && choiceSatisfied &&
      pendingEvokeTargetUids.has(lightningRowTarget(enemy.row))) return true
    return false
  }

  function onEvokeClick(slot: number) {
    if (!pending || !pendingEvokeChoice || pendingEvokeTarget >= 0 || !choiceSatisfied) return
    const option = pendingEvokeChoice.options.find((candidate) => candidate.slot === slot)
    if (!option) return
    const evokeSlots = [...pending.evokeSlots, slot]
    const orbs = chosenEvokeOrbs(pendingDef!, viewer!, evokeSlots,
      pending.mode ?? undefined, pending.effectEnergy ?? 0)
    stageOrCommit({
      ...pending,
      evokeSlots,
      evokeEnemyUids: [...pending.evokeEnemyUids, ...orbs.slice(pending.evokeEnemyUids.length)
        .map((orb) => orb === 'frost' ? null : undefined)],
    })
  }

  function onModeClick(mode: number) {
    if (!pending || !pendingDef?.modes?.[mode]) return
    const effects = pendingDef.modes[mode].effects
    const selectedDef = { ...pendingDef, modes: undefined, effects }
    const enemyChoices = cardEnemyChoiceCount(pendingDef, mode)
    if (effects.some((effect) => effect.kind === 'hitChoices' && effect.distinct) &&
      enemyChoices > state.enemies.filter((enemy) => !enemy.dead).length) return
    const playerChoices = cardPlayerChoiceCount(pendingDef, mode)
    stageOrCommit({
      ...pending, mode, enemyChoices, playerChoices, enemyUids: pending.enemyUids.slice(0, enemyChoices),
      needsEnemy: cardNeedsEnemy(selectedDef, viewer!, false, pending.effectEnergy ?? undefined) || enemyChoices > 0,
      playerIds: state.players.filter((player) => !player.dead).length === 1
        ? Array(playerChoices).fill(viewer!.id)
        : [],
    })
  }

  function onAllyClick(ally: Player) {
    if (ally.dead) return
    if (pendingPotion && potionDef(pendingPotion).supportTarget === 'anyPlayer') {
      consumePotion(pendingPotion, { targetPlayerId: ally.id })
      return
    }
    if (!pending || !enemyChoicesDone || !choiceSatisfied) return
    if (pending.playerIds.length < pending.playerChoices) {
      const next = { ...pending, playerIds: [...pending.playerIds, ally.id] }
      if (next.playerIds.length < next.playerChoices || next.needsAlly || next.needsSwitch) setPending(next)
      else commit(next)
      return
    }
    if (pending.needsAlly && pending.playerId === null) {
      stageOrCommit({ ...pending, playerId: ally.id })
      return
    }
    if (switchChoiceReady && ally.id !== viewerId) {
      stageOrCommit({ ...pending, switchPlayerId: ally.id, switchChoiceDone: true })
    }
  }

  // Ordered by what the player must do NEXT: an unsatisfied choice first, then
  // whatever target is still outstanding. Showing the choice text after it is
  // satisfied would leave the player stuck looking at a completed instruction.
  const spentShivPending = Boolean(pending && pending.shivEnemyUids.length < pending.spentShivs)
  const normalEnemyPending = Boolean(pendingNeedsCardEnemy && !pending?.enemyUid)
  const overflowOnly = Boolean(pending && !spentShivPending && pending.overflowShivs > 0 &&
    pending.shivEnemyUids.length < pending.spentShivs + pending.overflowShivs &&
    (!pendingNeedsCardEnemy || pending.enemyUid !== null) &&
    pending.enemyUids.length >= pending.enemyChoices)
  const independentEnemyPending = Boolean(pending && pending.enemyUids.length < pending.enemyChoices)
  const independentHitPending = Boolean(independentEnemyPending && pendingDef &&
    (pendingDef.modes && pending?.mode != null
      ? pendingDef.modes[pending.mode]?.effects ?? []
      : pendingDef.effects).some((effect) => effect.kind === 'hitChoices'))
  const independentPlayerPending = Boolean(pending && pending.playerIds.length < pending.playerChoices)
  const copySource = pending?.cardInHand !== false && pendingDef?.id !== 'burst'
    ? (pendingDef?.type === 'attack' || pendingDef?.type === 'skill') && (viewer.doubledCardsThisTurn ?? 0) > 0
      ? 'Echo Form'
      : pendingDef?.type === 'attack' && (viewer.tripledAttacksThisTurn ?? 0) > 0
        ? 'Blasphemy'
        : pendingDef?.type === 'attack' && (viewer.doubledAttacksThisTurn ?? 0) > 0
          ? 'Double Tap'
          : pendingDef?.type === 'skill' && (viewer.doubledSkillsThisTurn ?? 0) > 0 ? 'Burst' : null
    : null
  const copyTarget = copySource ? ` for ${pendingDef?.name ?? 'card'} copy (${copySource})` : ''
  const activeCopy = state.pendingCardCopy
  const activeCopyName = activeCopy
    ? faceOf(cardDef(activeCopy.card.defId), activeCopy.card.upgraded).name
    : 'card'
  const copyResolutionLabel = activeCopy
    ? activeCopy.sourceNames.length > 1
      ? `${activeCopyName} copy (${activeCopy.sourceNames[0]})`
      : activeCopy.card.scryDamageBonus !== undefined
        ? `Scry-played ${activeCopyName}`
        : activeCopy.virtualOnly
          ? `${activeCopyName} copy (${activeCopy.sourceNames[0]})`
          : `original ${activeCopyName} after ${activeCopy.sourceNames[0]} copy`
    : null
  const originalTarget = pending?.cardInHand === false
    ? ` for ${copyResolutionLabel ?? pendingDef?.name ?? 'card'}`
    : ''
  const normalEnemyPrompt = pending?.hitsRow
    ? state.enemies.some((enemy) => enemy.isBoss && !enemy.dead)
      ? `Choose an enemy${originalTarget || copyTarget} — its whole row is hit, and the boss`
      : `Choose an enemy${originalTarget || copyTarget} — its whole row is hit`
    : `Choose an enemy${originalTarget || copyTarget}`
  const enemyPrompt = normalEnemyPending
    ? normalEnemyPrompt
    : independentEnemyPending
      ? `Choose ${independentHitPending ? 'damage' : 'token'} target ${(pending?.enemyUids.length ?? 0) + 1}/${pending?.enemyChoices}`
    : spentShivPending
      ? `Choose Shiv attack ${(pending?.shivEnemyUids.length ?? 0) + 1}/${pending?.spentShivs}`
    : overflowOnly
    ? `Choose overflow Shiv target ${(pending?.shivEnemyUids.length ?? 0) - (pending?.spentShivs ?? 0) + 1}/${pending?.overflowShivs}, or skip the rest`
    : normalEnemyPrompt
  const startTurnPrompt = pendingStartShiv
    ? `${pendingStartShiv.ability.label} — choose overflow Shiv ${pendingStartShiv.index + 1}/${pendingStartShiv.ability.overflowShivs}, or skip`
    : pendingStartEnemy
      ? `${pendingStartEnemy.label} — choose an enemy`
    : pendingStartPlayer
      ? `${pendingStartPlayer.label} — choose a player`
    : pendingStartEvokeTarget
      ? `${pendingStartEvokeTarget.ability.label} — choose a ${pendingStartEvokeRows.length > 0 ? 'row' : 'target'} for the Evoked Orb`
    : pendingStartEvoke?.evokeChoice
      ? `${pendingStartEvoke.label} — choose an Orb to Evoke`
    : null
  const forcedSource = forcedCard?.sourceLabel ?? (forcedCard
    ? cardDef(forcedCard.sourceCardId ?? 'mayhem').name
    : '')
  const forcedPrompt = forcedCard && !pending
    ? forcedCard.playerId === viewerId
      ? `${forcedSource} — play the drawn card for 0 Energy`
      : `Waiting for ${state.players.find((player) => player.id === forcedCard.playerId)?.name ?? 'another player'} to play ${forcedSource}'s card`
    : null
  const triggerPrompt = pendingTrigger
    ? pendingTrigger.playerId === viewer.id
      ? `${pendingTrigger.label} — choose ${pendingTrigger.targets ? 'an enemy' : pendingTrigger.players ? 'a player' : 'a row'}`
      : `Waiting for ${state.players.find((player) => player.id === pendingTrigger.playerId)?.name ?? 'another player'} to resolve ${pendingTrigger.label}`
    : null
  const beforeDrawPrompt = activeStartTurnScry && activeStartTurnScry.playerId !== viewer.id
    ? `Waiting for ${state.players.find((player) => player.id === activeStartTurnScry.playerId)?.name ?? 'another player'} to Scry before drawing`
    : null
  const prompt = triggerPrompt ?? forcedPrompt ?? beforeDrawPrompt ?? startTurnPrompt ?? (pendingPowerDef
    ? `Choose ${pendingPowerDef.target === 'row' ? 'a row' : 'an enemy'} for ${pendingPowerDef.name}`
    : pendingPotion === 'gamblers_brew'
      ? "Gambler's Brew — choose the shared die face"
    : pendingPotion === 'liquid_memories'
      ? 'Liquid Memories — choose a card from your discard pile'
    : pendingPotion === 'purity_potion'
      ? `Purity — choose up to 3 cards to Exhaust (${potionCardUids.length}/3)`
    : pendingPotion === 'entropic_brew' && !viewerHasSozu
      ? 'Entropic Brew — choose a held Potion to replace'
    : pendingPotionDef
    ? pendingPotionDef.target === 'row'
      ? `Choose a row for ${pendingPotionDef.name}`
      : pendingPotionOverflow > 0
        ? `Choose overflow Shiv target ${potionShivEnemyUids.length + 1}/${pendingPotionOverflow}, or skip the rest`
        : `Choose ${pendingPotionDef.target ? 'an enemy' : 'a player'} for ${pendingPotionDef.name}`
    : spendingShiv
    ? 'Choose an enemy for the Shiv'
    : pendingDef?.cost === 'X' && pending?.energySpent === null
      ? `Choose Energy for ${pendingDef.name}`
    : pendingDef?.modes && !modeSatisfied
      ? `Choose how to play ${pendingDef.name}`
    : pending?.choiceCards && !pending.choiceConfirmed
      ? pending.choice?.kind === 'scry'
        ? `Scry ${pending.choice.amount} — choose any cards to discard`
        : pending.choice?.kind === 'topdeck'
          ? `${pendingDef?.name ?? 'Card'} — choose ${choiceNeeded} card to put on top`
        : pending.choice?.kind === 'recover'
          ? `${pendingDef?.name ?? 'Card'} — choose a card from your discard pile`
        : pending.choice?.kind === 'recoverExhaust'
          ? `${pendingDef?.name ?? 'Card'} — choose a card from your Exhaust pile`
        : pending.choice?.kind === 'search'
          ? `${pendingDef?.name ?? 'Card'} — choose ${choiceNeeded} from your draw pile`
        : `Discard ${choiceNeeded} card${choiceNeeded === 1 ? '' : 's'} after drawing`
    : (pending?.choice?.kind === 'discardAny' || pending?.choice?.kind === 'exhaustAny') && !pending.choiceConfirmed
      ? pending.choice.kind === 'discardAny'
        ? `Discard any number of cards — ${pending.picked.length} chosen`
        : `Exhaust ${pending.choice.minimum ? `${pending.choice.minimum}-${pending.choice.amount}` : `up to ${pending.choice.amount}`} cards — ${pending.picked.length} chosen`
    : pending?.choice && !handChoiceSatisfied
      ? `${pending.choice.kind === 'discard' ? 'Discard' : 'Exhaust'} ${choiceNeeded} card${
          choiceNeeded === 1 ? '' : 's'
        } — ${pending.picked.length}/${choiceNeeded} chosen`
      : pendingEvokeTarget >= 0
        ? `Choose ${pendingEvokeUsesRows ? 'a row' : 'an enemy'} for this evoke`
        : pendingEvokeChoice
          ? `Choose Orb to evoke ${pendingEvokeChoice.index + 1}`
        : pending?.needsEnemy && !enemyChoicesDone
        ? enemyPrompt
        : independentPlayerPending
          ? `Choose Block recipient ${(pending?.playerIds.length ?? 0) + 1}/${pending?.playerChoices}`
        : pending?.needsAlly && !pending.playerId
          ? 'Choose who gets it'
          : switchChoiceReady
            ? 'Choose another player to switch rows with, or keep rows'
          : null)
  const draggedEnemy = cardDrag?.targetUid
    ? state.enemies.find((enemy) => enemy.uid === cardDrag.targetUid)
    : undefined
  const cardDragTargetRow = cardDrag?.hitsRow ? draggedEnemy?.row : undefined
  const displayedPileCount = (kind: 'draw' | 'discard' | 'exhaust', count: number) =>
    Math.max(0, count - cardFlights.filter((flight) => flight.destination === kind).length)
  const drawPileCount = drawCount ?? viewer.draw.length

  return (
    <div
      className="combat"
      data-act={stageAct}
      data-phase={state.phase}
      style={{
        backgroundImage: `linear-gradient(90deg, rgb(2 5 8 / 0.38), transparent 22%, transparent 74%, rgb(2 5 8 / 0.32)), url("${assetPath(`backgrounds/boss-act-${stageAct}.webp`)}")`,
        '--stage-scale': stageScale,
        '--stage-width': `${stageCount * stageGap + STAGE_MARGIN_REM * stageScale}rem`,
        '--stage-gap': `${stageGap}rem`,
        '--stage-actor-width': `${stageGap - 1 * stageScale}rem`,
      } as React.CSSProperties}
    >
      <header className="combat__bar">
        <span className="combat__turn">Turn {state.turn}</span>
        <span className="combat__die" title="The round's shared die">
          <Icon name={dieIcon(state.die)} size={26} decorative={false} />
        </span>
        <span key={`${state.turn}-${state.phase}`} className={`combat__phase combat__phase--${state.phase}`}>{state.phase === 'copy'
          ? `Resolve ${copyResolutionLabel ?? 'card'}`
          : PHASE_LABEL[state.phase]}</span>
        <span className="combat__actions">
          {!viewer.dead && !relicScry && (state.phase === 'player' || state.phase === 'discard' ||
            state.phase === 'start' && viewer.potions.includes('gamblers_brew')) ? (
            <>
              {state.phase === 'player' && !forcedCard && !distilled && !orderingStage && !pendingTrigger ? viewer.powers.flatMap((power) => {
                const def = faceOf(cardDef(power.defId), power.upgraded)
                if (!def.activeAbility) return []
                const staged = pendingPowerUid === power.uid
                const used = powerAbilityUsed(state, viewer.id, power.uid)
                return [<button
                  type="button"
                  key={power.uid}
                  disabled={usingPower || used || Boolean(pending?.choiceCards)}
                  aria-label={used ? `${def.name} used` : `Use ${def.name}`}
                  aria-pressed={staged}
                  onClick={() => {
                    setPending(null)
                    setSpendingShiv(false)
                    setMiracleOnCard(false)
                    setPendingPotion(null)
                    setPotionShivEnemyUids([])
                    setPotionOverflowRequired(0)
                    setPendingPowerUid(staged ? null : power.uid)
                  }}
                ><PowerGlyph def={def} /></button>]
              }) : null}
              {(state.phase === 'player' || state.phase === 'start') && !forcedCard && !distilled && !orderingStage && !pendingTrigger ? [...new Set(viewer.potions)].flatMap((potionId) => {
                if (!canActivatePotion(state, viewer, potionId)) return []
                const potion = potionDef(potionId)
                const staged = pendingPotion === potionId
                const count = viewer.potions.filter((held) => held === potionId).length
                const shivs = gainedShivs(potion.effects)
                const needsTarget = ['gamblers_brew', 'liquid_memories', 'purity_potion'].includes(potionId) ||
                  potionId === 'entropic_brew' && !viewerHasSozu &&
                    viewer.potions.length - 1 + 2 > state.potionLimit || Boolean(potion.target) || (
                  potion.supportTarget === 'anyPlayer' && livingPlayers.length > 1
                ) || overflowShivCount(state, shivs) > 0
                const descriptionId = `potion-action-${viewer.id}-${potionId}-description`
                // A potion that needs a target is not drunk by the committing
                // tap — that tap arms targeting, and the target is chosen next.
                // Already staged, the button only un-stages: free and
                // reversible, so there is nothing to read first and no label.
                return <PotionTooltipAnchor id={potionId} key={potionId}
                  confirmLabel={needsTarget ? (staged ? undefined : 'aim') : 'drink'}>
                  <span id={descriptionId} className="visually-hidden">{potion.text}</span>
                  <button
                    type="button"
                    disabled={usingPotion || Boolean(pending?.choiceCards)}
                    aria-label={`Use ${potion.name}${count > 1 ? ` ×${count}` : ''}`}
                    aria-describedby={descriptionId}
                    aria-pressed={needsTarget ? staged : undefined}
                    onClick={() => {
                      if (needsTarget) {
                        setPending(null)
                        setPendingPowerUid(null)
                        setSpendingShiv(false)
                        setMiracleOnCard(false)
                        setPendingPotion(staged ? null : potionId)
                        setPotionShivEnemyUids([])
                        setPotionOverflowRequired(staged ? 0 : overflowShivCount(state, shivs))
                        setPotionCardUids([])
                      } else consumePotion(potionId)
                    }}
                  >
                    <img className="item-icon-image" src={potionIconPath(potionId)} alt="" />
                  </button>
                </PotionTooltipAnchor>
              }) : null}
              {state.phase === 'player' && !forcedCard && !distilled && !relicScry && !orderingStage &&
              !pendingTrigger && !viewer.cardPlayLocked && !reachedTimeWarpLimit(state, viewer) && viewer.shivs > 0 ? (
                <button
                  type="button"
                  className={spendingShiv ? 'is-chosen' : undefined}
                  disabled={Boolean(pending?.choiceCards)}
                  aria-label="Use Shiv"
                  aria-pressed={spendingShiv}
                  onClick={() => {
                    setPending(null)
                    setPendingPowerUid(null)
                    setMiracleOnCard(false)
                    setPendingPotion(null)
                    setPotionShivEnemyUids([])
                    setPotionOverflowRequired(0)
                    setSpendingShiv((current) => !current)
                  }}
                >
                  <StatusIcon name="shiv" size={22} />
                </button>
              ) : null}
              {state.phase === 'player' && !forcedCard && !distilled && !orderingStage && !pendingTrigger && viewer.miracles > 0 ? (
                <button
                  type="button"
                  disabled={Boolean(pending?.choiceCards)}
                  aria-label={viewer.energy === CAPS.energy ? 'Use Miracle on next card' : 'Use Miracle (+1 Energy)'}
                  aria-pressed={viewer.energy === CAPS.energy ? miracleOnCard : undefined}
                  onClick={() => {
                    if (viewer.energy < CAPS.energy) {
                      if (onAction) onAction({ kind: 'spendMiracle' })
                      else onChange?.(spendMiracle(state, viewer.id))
                    }
                    else {
                      setPending(null)
                      setPendingPowerUid(null)
                      setSpendingShiv(false)
                      setPendingPotion(null)
                      setPotionShivEnemyUids([])
                      setPotionOverflowRequired(0)
                      setMiracleOnCard((current) => !current)
                    }
                  }}
                >
                  <Icon name="miracle" size={22} />
                </button>
              ) : null}
              {state.phase === 'discard' && retainAllowance > 0 && discardableHand.length > 0 ? (
                <span className="retain-options" role="group"
                  aria-label={`Retain up to ${retainAllowance} cards for ${viewer.name}`}>
                  {discardableHand.map((card) => {
                    const retained = retainedSet.has(card.uid)
                    const name = faceOf(cardDef(card.defId), card.upgraded).name
                    return <button key={card.uid} type="button" aria-pressed={retained}
                      disabled={!retained && viewerRetainedCards.length >= retainAllowance}
                      onClick={() => setRetainedCards((current) => ({
                        ...current,
                        [viewer.id]: retained
                          ? viewerRetainedCards.filter((uid) => uid !== card.uid)
                          : [...viewerRetainedCards, card.uid],
                      }))}>
                      {retained ? '✓ ' : ''}Retain {name}
                    </button>
                  })}
                </span>
              ) : null}
              {state.phase === 'discard' && discardCandidates.length > 1 ? (
                <label className="discard-order">
                  Top discard
                  <select
                    aria-label={`Top discard for ${viewer.name}`}
                    value={viewerDiscardTop}
                    onChange={(event) => setDiscardTops((current) => ({
                      ...current,
                      [viewer.id]: event.target.value,
                    }))}
                  >
                    {discardCandidates.map((card) => {
                      const def = faceOf(cardDef(card.defId), card.upgraded)
                      return <option key={card.uid} value={card.uid}>{`${def.unplayable ? '—' : cardCost(def, viewer.powers, viewer.lostHpThisCombat)} · ${def.name}`}</option>
                    })}
                  </select>
                </label>
              ) : null}
              {state.phase === 'player' && !forcedCard && !distilled && endTurnNeedsChoice ? (
                <details className="end-turn-order" open={endTurnOrderOpen}
                  onToggle={(event) => setEndTurnOrderOpen(event.currentTarget.open)}>
                  <summary>End-turn order ({abilities.length})</summary>
                  {/* Every order list scrolls once a party fills it, and their
                      controls are disabled for seats that may not reorder: keep
                      them reachable by keyboard the way the combat log is. */}
                  <ol aria-label="End-turn order" tabIndex={0}>
                    {viewerEndTurnOrder.map((choice, index) => {
                      const ability = abilities.find((candidate) => candidate.id === endTurnChoiceId(choice))!
                      return (
                        <li key={ability.id}>
                          <span>{ability.label}</span>
                          {ability.targets ? (
                            <select aria-label={`Target for ${ability.label}`}
                              disabled={!canOrderEndTurn}
                              value={endTurnChoiceTarget(choice) ?? ability.targets[0]?.uid}
                              onChange={(event) => targetEndTurnAbility(choice, event.target.value)}>
                              {ability.targets.map((target) => (
                                <option key={target.uid} value={target.uid}>{target.label}</option>
                              ))}
                            </select>
                          ) : null}
                          <button type="button" disabled={!canOrderEndTurn || index === 0}
                            aria-label={`Move ${ability.label} earlier`}
                            onClick={() => moveEndTurnAbility(choice, -1)}>↑</button>
                          <button type="button" disabled={!canOrderEndTurn || index === viewerEndTurnOrder.length - 1}
                            aria-label={`Move ${ability.label} later`}
                            onClick={() => moveEndTurnAbility(choice, 1)}>↓</button>
                        </li>
                      )
                    })}
                  </ol>
                </details>
              ) : null}
              {endTurnError ? <span className="combat-error" role="alert">{endTurnError}</span> : null}
              {/* The count lives on the End turn button itself. A co-op turn
                  ends when everyone says so, and being told who the table is
                  waiting on is the whole reason a second screen existed. */}
              {!forcedCard && !distilled ? <button type="button" ref={endTurnRef} className="combat__end-turn" onClick={finishTurn}
                disabled={Boolean(pending?.choiceCards) || Boolean(pendingTrigger) ||
                  (orderingStage && viewer.id !== endTurnCoordinatorId)}>
                {state.phase === 'discard'
                  ? `${discardOrders[viewer.id] ? 'Update' : 'Confirm'} ${viewer.name} (${confirmedDiscards}/${livingPlayers.length})`
                  : orderingStage
                    ? viewer.id === endTurnCoordinatorId ? 'Resolve end turn' : 'Waiting for end-turn order'
                    : endTurnCount ? `End turn ${endTurnCount}` : 'End turn'}
              </button> : null}
            </>
          ) : null}
          {state.phase === 'start' && !forcedCard && !pendingTrigger && !activeStartTurnScry &&
          orderedStartTurnScries.length > 0 ? (
            <>
              <details className="end-turn-order" open>
                <summary>Before-draw Scry order ({orderedStartTurnScries.length})</summary>
                <ol aria-label="Before-draw Scry order" tabIndex={0}>
                  {orderedStartTurnScries.map((ability, index) => (
                    <li key={ability.id}>
                      <span>{ability.label} — Scry {ability.amount}</span>
                      <button type="button" disabled={!canResolveStartTurn || index === 0}
                        aria-label={`Move ${ability.label} earlier`}
                        onClick={() => moveStartTurnScry(ability.id, -1)}>↑</button>
                      <button type="button" disabled={!canResolveStartTurn || index === orderedStartTurnScries.length - 1}
                        aria-label={`Move ${ability.label} later`}
                        onClick={() => moveStartTurnScry(ability.id, 1)}>↓</button>
                    </li>
                  ))}
                </ol>
              </details>
              <button type="button" disabled={!canResolveStartTurn} onClick={finishStartTurnScryOrder}>
                {canResolveStartTurn ? 'Confirm before-draw order' : 'Waiting for before-draw order'}
              </button>
            </>
          ) : null}
          {state.phase === 'start' && !forcedCard && !pendingTrigger && !activeStartTurnScry &&
          orderedStartTurnScries.length === 0 ? (
            <>
              <details className="end-turn-order">
                <summary>Start-of-turn order ({orderedStartAbilities.length})</summary>
                <ol aria-label="Start-of-turn order" tabIndex={0}>
                  {orderedStartAbilities.map((ability, index) => {
                    const targetChosen = ability.targets
                      ? startTurnEnemyTargets[ability.id] !== undefined
                      : false
                    const decided = (startTurnTargets[ability.id] ?? [])
                      .filter((target) => target !== undefined).length
                    const evoked = startTurnEvokeSlots[ability.id]?.length ?? 0
                    return (
                      <li key={ability.id}>
                        <span>{ability.label}{ability.targets
                          ? ` — target ${targetChosen ? 1 : 0}/1`
                          : ''}{ability.overflowShivs > 0
                          ? ` — overflow ${decided}/${ability.overflowShivs}`
                          : ''}{evoked > 0 || ability.evokeChoice
                          ? ` — Evoke ${evoked}${ability.evokeChoice ? '+' : ''}`
                          : ''}</span>
                        <button type="button" disabled={!canResolveStartTurn || partyStartTurnOrderLocked || index === 0}
                          aria-label={`Move ${ability.label} earlier`}
                          onClick={() => moveStartTurnAbility(ability.id, -1)}>↑</button>
                        <button type="button" disabled={!canResolveStartTurn || partyStartTurnOrderLocked || index === orderedStartAbilities.length - 1}
                          aria-label={`Move ${ability.label} later`}
                          onClick={() => moveStartTurnAbility(ability.id, 1)}>↓</button>
                      </li>
                    )
                  })}
                </ol>
              </details>
              {orderedStartAbilities.some((ability) =>
                (ability.targets?.length ?? 0) > 1 && startTurnEnemyTargets[ability.id] !== undefined) ||
                Object.values(startTurnPlayerTargets).some((playerId) => playerId !== undefined) ||
                Object.values(startTurnTargets).some((targets) =>
                  targets.some((target) => target !== undefined)) ||
                Object.values(startTurnEvokeSlots).some((slots) => slots.length > 0) ? (
                <button type="button" disabled={!canResolveStartTurn}
                  onClick={() => {
                    setStartTurnEnemyTargets(Object.fromEntries(orderedStartAbilities.map((ability) => [
                      ability.id,
                      savedStartTurnEnemyTargets?.[ability.id] ??
                        (ability.targets?.length === 1 ? ability.targets[0]!.uid : undefined),
                    ])))
                    setStartTurnPlayerTargets(Object.fromEntries(orderedStartAbilities.map((ability) => [
                      ability.id,
                      ability.players?.length === 1 ? ability.players[0]!.id : undefined,
                    ])))
                    setStartTurnTargets(Object.fromEntries(orderedStartAbilities.map((ability) => [
                      ability.id,
                      Array(ability.overflowShivs).fill(undefined),
                    ])))
                    setStartTurnEvokeSlots(Object.fromEntries(orderedStartAbilities.map((ability) => [ability.id, []])))
                    setStartTurnEvokeTargets(Object.fromEntries(orderedStartAbilities.map((ability) => [ability.id, []])))
                  }}>
                  Reset start choices
                </button>
              ) : null}
              <button type="button" className="combat__end-turn" onClick={finishStartTurn}
                disabled={!startTurnReady || !canResolveStartTurn}>
                {canResolveStartTurn
                  ? partyStartTurnOrderPending ? 'Confirm start-of-turn order'
                    : startTurnChoiceId ? 'Confirm Noxious Fumes target' : 'Resolve start of turn'
                  : 'Waiting for start-turn order'}
              </button>
            </>
          ) : null}
        </span>
      </header>

      {over ? (
        <p className={`combat__result combat__result--${state.phase}`} role="status">
          {state.phase === 'won' ? 'Victory' : 'The party has fallen'}
        </p>
      ) : null}

      {prompt ? (
        <div className="prompt">
          <span className="prompt__text" role="status">{prompt}</span>
          {pendingStartShiv && canResolveStartTurn ? (
            <button type="button" className="prompt__cancel" onClick={() => chooseStartTurnShiv(null)}>
              Skip this Shiv
            </button>
          ) : null}
          {pendingStartEvoke?.evokeChoice && !pendingStartEvokeTarget
            ? pendingStartEvoke.evokeChoice.options.map((option) => (
              <button type="button" className="prompt__orb" key={option.slot}
                onClick={() => chooseStartTurnEvoke(option.slot)}>
                <span className={`token token--orb token--orb-${option.orb}`} />
                {option.orb} slot {option.slot + 1}
              </button>
            ))
            : null}
          {pendingTrigger?.playerId === viewerId ? pendingTrigger.players?.map((player) => (
            <button type="button" className="prompt__mode" key={player.id}
              onClick={() => resolveTrigger(undefined, undefined, player.id)}>{player.label}</button>
          )) : null}
          {pendingStartPlayer?.players?.map((player) => (
            <button type="button" className="prompt__mode" key={player.id}
              onClick={() => chooseStartTurnPlayer(player.id)}>{player.label}</button>
          ))}
          {pending && overflowOnly && choiceSatisfied ? (
            <button type="button" className="prompt__cancel" onClick={() => commit(pending, true)}>
              Skip remaining overflow attacks
            </button>
          ) : null}
          {pendingDef?.cost === 'X' && pending?.energySpent === null
            ? Array.from({ length: viewer.energy - (pendingDef.minimumX ?? 0) + 1 }, (_, at) => {
              const energy = at + (pendingDef.minimumX ?? 0)
              return (
                <button type="button" className="prompt__mode" key={energy}
                  onClick={() => stageOrCommit({ ...pending, energySpent: energy, effectEnergy: energy })}>
                  Spend {energy}
                </button>
              )
            })
            : null}
          {(pending?.choice?.kind === 'discardAny' || pending?.choice?.kind === 'exhaustAny') && !pending.choiceConfirmed ? (
            <button type="button" className="prompt__mode"
              disabled={pending.picked.length < variableMinimum}
              onClick={() => stageOrCommit({ ...pending, choiceConfirmed: true })}>
              {pending.picked.length === 0
                ? `${pending.choice.kind === 'discardAny' ? 'Discard' : 'Exhaust'} none`
                : `${pending.choice.kind === 'discardAny' ? 'Discard' : 'Exhaust'} ${pending.picked.length}`}
            </button>
          ) : null}
          {pendingEvokeChoice && pendingEvokeTarget < 0 ? pendingEvokeChoice.options.map((option) => (
            <button type="button" className="prompt__orb" key={option.slot}
              onClick={() => onEvokeClick(option.slot)}>
              <span className={`token token--orb token--orb-${option.orb}`} />
              {option.orb} slot {option.slot + 1}
            </button>
          )) : null}
          {pendingDef?.modes && !modeSatisfied ? pendingDef.modes.map((mode, index) => (
            <button type="button" className="prompt__mode" key={mode.label}
              disabled={!cardModeIsAvailable(pendingDef, state, viewer!, index, drawCount,
                pending.cardInHand ? pending.card.uid : undefined) ||
                (mode.effects.some((effect) => effect.kind === 'hitChoices' && effect.distinct) &&
                  cardEnemyChoiceCount(pendingDef, index) > state.enemies.filter((enemy) => !enemy.dead).length)}
              onClick={() => onModeClick(index)}>
              {mode.label}
            </button>
          )) : null}
          {pendingPotion && pendingPotionOverflow > 0 ? (
            <button
              type="button"
              className="prompt__cancel"
              onClick={() => consumePotion(
                pendingPotion,
                { shivEnemyUids: potionShivEnemyUids },
                { expected: pendingPotionOverflow, skip: true },
              )}
            >
              Skip remaining overflow attacks
            </button>
          ) : null}
          {pendingPotion === 'gamblers_brew' ? Array.from({ length: 6 }, (_, index) => (
            <button type="button" className="prompt__mode" key={index + 1}
              onClick={() => consumePotion(pendingPotion, { die: index + 1 })}>
              {index + 1}
            </button>
          )) : null}
          {pending && switchChoiceReady ? (
            <button type="button" className="prompt__cancel"
              onClick={() => stageOrCommit({ ...pending, switchPlayerId: null, switchChoiceDone: true })}>
              Keep rows
            </button>
          ) : null}
        </div>
      ) : null}

      {pendingPotionNeedsCards ? (
        <dialog ref={itemDialogRef} className="distilled-choice" aria-labelledby="potion-card-choice-title"
          onCancel={(event) => {
            event.preventDefault()
            cancelPotionChoice()
          }}>
          <h2 id="potion-card-choice-title">{pendingPotionDef!.name}</h2>
          <p>{pendingPotion === 'liquid_memories'
            ? 'Choose one discarded card to return to your hand for 0 Energy this turn.'
            : 'Choose up to three cards in your hand, then confirm.'}</p>
          <div className="distilled-choice__cards">
            {(pendingPotion === 'liquid_memories' ? viewer.discard : viewer.hand).map((card) => (
              <Card key={card.uid} card={card} selected={potionCardUids.includes(card.uid)}
                onClick={() => pendingPotion === 'liquid_memories'
                  ? consumePotion(pendingPotion, { recoverDiscardUid: card.uid })
                  : setPotionCardUids((current) => current.includes(card.uid)
                    ? current.filter((uid) => uid !== card.uid)
                    : current.length < 3 ? [...current, card.uid] : current)} />
            ))}
          </div>
          {pendingPotion === 'purity_potion' ? (
            <button type="button" className="prompt__mode"
              onClick={() => consumePotion(pendingPotion, { exhaustUids: potionCardUids })}>
              Exhaust {potionCardUids.length || 'none'}
            </button>
          ) : null}
          <button type="button" className="prompt__cancel" onClick={cancelPotionChoice}>Cancel</button>
        </dialog>
      ) : null}

      {pendingPotion === 'entropic_brew' && !viewerHasSozu ? (
        <dialog ref={itemDialogRef} className="distilled-choice" aria-labelledby="entropic-choice-title"
          onCancel={(event) => {
            event.preventDefault()
            cancelPotionChoice()
          }}>
          <h2 id="entropic-choice-title">Entropic Brew</h2>
          <p>Choose one held Potion to discard, then gain two.</p>
          <div className="item-actions">
            {viewer.potions.filter((held) => held !== 'entropic_brew').map((held, index) => {
              const descriptionId = `entropic-replace-${held}-${index}-description`
              // Deliberately no `confirmLabel`, which is what keeps the
              // read-first step OFF here: this dialog is opened with
              // `showModal`, and the anchor portals its panel to the body —
              // outside the top layer, so under the backdrop. A gate whose
              // panel cannot be seen is a tap that does nothing. That panel is
              // equally unreachable here for a mouse, which is an older and
              // separate problem; the rules stay available through the
              // description below either way.
              return <PotionTooltipAnchor id={held} key={`${held}:${index}`}>
                <span id={descriptionId} className="visually-hidden">{potionDef(held).text}</span>
                <button type="button" aria-describedby={descriptionId}
                onClick={() => consumePotion('entropic_brew', { replacePotionId: held })}>
                  <img className="item-icon-image" src={potionIconPath(held)} alt="" /> Replace {potionDef(held).name}
                </button>
              </PotionTooltipAnchor>
            })}
          </div>
          <button type="button" className="prompt__cancel" onClick={cancelPotionChoice}>Cancel</button>
        </dialog>
      ) : null}

      {!forcedCard && !distilled && !relicScry && (state.phase === 'player' || state.phase === 'start') ? (
        <div className="relic-actions">
          <section aria-label="Relic abilities">
          {viewer.relics.flatMap((held, relicIndex) => {
            const def = relicDef(held.defId)
            const simpleAction = <PotionTooltipAnchor id={held.defId} key={`${held.defId}-${relicIndex}`}
              name={def.name} text={def.text} kindLabel="Relic" confirmLabel="use">
              <button type="button" aria-label={`Use ${def.name}${held.cubes !== undefined ? ` (${held.cubes})` : ''}: ${def.text}`}
                onClick={() => useRelic(relicIndex)}>
                <img className="item-icon-image" src={relicIconPath(held.defId)} alt="" />
              </button>
            </PotionTooltipAnchor>
            const reroute = ['dollys_mirror', 'nilrys_codex', 'loaded_die'].includes(held.defId)
            if (!canActivateRelic(state, viewer, relicIndex)) return []
            if (held.defId === 'golden_eye') return [simpleAction]
            if (held.defId === 'gambling_chip') return [simpleAction]
            if (held.defId === 'blue_candle' || held.defId === 'runic_pyramid') return [<details key={relicIndex}>
              <summary>{def.name}</summary><p className="room-item-text">{def.text}</p>
              <div className="campfire__deck">{viewer.hand.map((card) => <Card key={card.uid} card={card}
                selected={relicCardUids.includes(card.uid)} onClick={() => setRelicCardUids((current) =>
                  current.includes(card.uid) ? current.filter((uid) => uid !== card.uid) :
                    held.defId === 'blue_candle' && current.length >= 2 ? current : [...current, card.uid])} />)}</div>
              <button type="button" onClick={() => useRelic(relicIndex, { cardUids: relicCardUids })}>
                Activate
              </button>
            </details>]
            if (held.defId === 'charons_ashes') return [<details key={relicIndex}><summary>{def.name}</summary><p className="room-item-text">{def.text}</p>
              <div className="campfire__deck">{viewer.hand.map((card) => <Card key={card.uid} card={card}
                selected={relicCardUids[0] === card.uid} onClick={() => setRelicCardUids([card.uid])} />)}</div>
              {state.enemies.filter((enemy) => !enemy.dead).map((enemy) => <button type="button" key={enemy.uid}
                disabled={relicCardUids.length !== 1}
                onClick={() => useRelic(relicIndex, { cardUids: relicCardUids, enemyUid: enemy.uid })}>
                Hit {enemyLabel(state.enemies, enemy)}
              </button>)}
            </details>]
            if (held.defId === 'ninja_scroll') {
              const overflow = overflowShivCount(state, 2)
              if (overflow === 0) return [simpleAction]
              return [<details key={relicIndex}><summary>{def.name}</summary><p className="room-item-text">{def.text}</p>
                <p>Choose {overflow} immediate Shiv target{overflow === 1 ? '' : 's'}.</p>
                {state.enemies.filter((enemy) => !enemy.dead).map((enemy) => <button type="button" key={enemy.uid}
                  onClick={() => setRelicShivEnemyUids((current) => current.length < overflow
                    ? [...current, enemy.uid] : current)}>
                  {enemyLabel(state.enemies, enemy)}
                </button>)}
                <button type="button" disabled={relicShivEnemyUids.length !== overflow}
                  onClick={() => useRelic(relicIndex, { shivEnemyUids: relicShivEnemyUids })}>
                  Throw {relicShivEnemyUids.length}/{overflow}
                </button>
                {relicShivEnemyUids.length > 0 ? <button type="button"
                  onClick={() => setRelicShivEnemyUids([])}>Clear</button> : null}
              </details>]
            }
            if (reroute) {
              const face = held.defId === 'dollys_mirror' ? 1 : held.defId === 'nilrys_codex' ? 2 : null
              return [<details key={relicIndex}><summary>{def.name}</summary><p className="room-item-text">{def.text}</p>
                {state.players.filter((owner) => !owner.dead).flatMap((owner) => owner.relics.flatMap((target, targetRelicIndex) =>
                  relicAbilities(relicDef(target.defId)).flatMap((ability, targetAbilityIndex) => {
                    if (ability.trigger.kind !== 'dieRelic' || face !== null && !ability.trigger.faces.includes(face) ||
                      ['nilrys_codex', 'loaded_die'].includes(held.defId) && owner.id === viewerId &&
                      targetRelicIndex === relicIndex) return []
                    const enemies = (ability.target ?? 'enemy') !== 'allEnemies' &&
                      ability.effects.some((effect) => reachesEnemy(effect, owner))
                      ? state.enemies.filter((enemy) => !enemy.dead)
                      : [undefined]
                    return enemies.map((enemy) => <button type="button"
                      key={`${owner.id}:${targetRelicIndex}:${targetAbilityIndex}:${enemy?.uid ?? ''}`}
                      onClick={() => useRelic(relicIndex, {
                        targetRelicPlayerId: owner.id, targetRelicIndex, targetAbilityIndex, enemyUid: enemy?.uid,
                      })}>
                      {owner.name}: {relicDef(target.defId).name}{enemy ? ` → ${enemyLabel(state.enemies, enemy)}` : ''}
                    </button>)
                  })))}
              </details>]
            }
            return [simpleAction]
          })}
          </section>
        </div>
      ) : null}

      {relicScry ? (
        <dialog ref={itemDialogRef} className="distilled-choice" aria-labelledby="golden-eye-title"
          onCancel={(event) => event.preventDefault()}>
          <h2 id="golden-eye-title">Golden Eye — Scry 3</h2>
          {relicScry.playerId === viewerId ? <>
            <p>Select any revealed cards to discard.</p>
            <div className="distilled-choice__cards">{relicScry.cards.map((card) => <Card key={card.uid} card={card}
              selected={relicCardUids.includes(card.uid)} onClick={() => setRelicCardUids((current) =>
                current.includes(card.uid) ? current.filter((uid) => uid !== card.uid) : [...current, card.uid])} />)}</div>
            <button type="button" className="prompt__mode"
              onClick={() => useRelic(relicScry.relicIndex, { scryDiscardUids: relicCardUids })}>
              Discard {relicCardUids.length || 'none'}
            </button>
          </> : <p>Waiting for {state.players.find((player) => player.id === relicScry.playerId)?.name}.</p>}
        </dialog>
      ) : null}

      {visibleDistilled ? (
        <dialog ref={itemDialogRef} className="distilled-choice" aria-labelledby="distilled-choice-title"
          onCancel={(event) => event.preventDefault()}>
          <h2 id="distilled-choice-title">Distilled Chaos</h2>
          {visibleDistilled.playerId === viewerId ? (
            <>
              <p>Choose the next revealed card to play for 0 Energy.</p>
              <div className="distilled-choice__cards">
                {visibleDistilled.cards.map((card) => (
                  <Card key={card.uid} card={card} cost={0} playable
                    onClick={() => onAction
                      ? void onAction({ kind: 'chooseDistilledCard', cardUid: card.uid })
                      : onChange?.(chooseDistilledCard(state, viewerId, card.uid))} />
                ))}
              </div>
            </>
          ) : (
            <p>Waiting for {state.players.find((player) => player.id === visibleDistilled.playerId)?.name ?? 'another player'} to choose the next card.</p>
          )}
        </dialog>
      ) : null}

      {activeStartTurnScry?.playerId === viewerId && activeStartTurnScry.cards ? (
        <dialog ref={startTurnScryDialogRef} className="choice-modal" aria-labelledby="start-turn-scry-title"
          onCancel={(event) => event.preventDefault()}>
          <div className="choice-modal__panel">
            <h2 id="start-turn-scry-title">Foresight — Scry {activeStartTurnScry.amount}</h2>
            <p>Select any revealed cards to discard; unselected cards stay on top in order.</p>
            <div className="choice-modal__cards">
              {activeStartTurnScry.cards.map((card) => (
                <Card key={card.uid} card={card} selected={startTurnScryPicked.includes(card.uid)}
                  onClick={chooseStartTurnScryCard} />
              ))}
              {activeStartTurnScry.cards.length === 0 ? <span className="muted">No cards were revealed.</span> : null}
            </div>
            <button type="button" disabled={resolvingStartTurnScry} onClick={() => void finishStartTurnScry()}>
              {startTurnScryPicked.length === 0
                ? 'Keep all and continue'
                : `Discard ${startTurnScryPicked.length} and continue`}
            </button>
          </div>
        </dialog>
      ) : null}

      {activeStartTurnDiscard?.playerId === viewerId && activeStartTurnDiscard.cards ? (
        <dialog ref={startTurnDiscardDialogRef} className="choice-modal" aria-labelledby="start-turn-discard-title"
          onCancel={(event) => event.preventDefault()}>
          <div className="choice-modal__panel">
            <h2 id="start-turn-discard-title">Tools of the Trade — discard 1 card</h2>
            <p>Choose one card from your hand. This choice is private.</p>
            <div className="choice-modal__cards">
              {activeStartTurnDiscard.cards.map((card) => (
                <Card key={card.uid} card={card} onClick={() => void finishStartTurnDiscard(card)} />
              ))}
            </div>
          </div>
        </dialog>
      ) : null}

      {pending?.choiceCards && pending.choice && !pending.choiceConfirmed ? (
        <dialog ref={choiceDialogRef} className="choice-modal" aria-labelledby="choice-modal-title"
          onCancel={(event) => {
            event.preventDefault()
            if (pending.cardInHand &&
              (pending.choice?.kind === 'recover' || pending.choice?.kind === 'recoverExhaust')) setPending(null)
          }}>
          <div className="choice-modal__panel">
            <h2 id="choice-modal-title">
              {pending.choice.kind === 'scry'
                ? `Scry ${pending.choice.amount}`
                : pending.choice.kind === 'topdeck'
                  ? `Choose ${choiceNeeded} for the top of your draw pile`
                : pending.choice.kind === 'recover'
                  ? `Choose ${choiceNeeded} card${choiceNeeded === 1 ? '' : 's'} from your discard pile`
                : pending.choice.kind === 'recoverExhaust'
                  ? 'Choose a card from your Exhaust pile'
                : pending.choice.kind === 'search'
                  ? `Choose ${choiceNeeded} from your draw pile`
                  : `Choose ${choiceNeeded} to discard`}
            </h2>
            <p>
              {pending.choice.kind === 'scry'
                ? 'Select any revealed cards to discard; unselected cards stay on top in order.'
                : pending.choice.kind === 'topdeck'
                  ? `${pending.picked.length}/${choiceNeeded} selected. The card is committed.`
                : pending.choice.kind === 'recover'
                  ? `${pending.picked.length}/${choiceNeeded} selected from discard.`
                : pending.choice.kind === 'recoverExhaust'
                  ? `${pending.picked.length}/${choiceNeeded} selected from Exhaust.`
                : pending.choice.kind === 'search'
                  ? `${pending.picked.length}/${choiceNeeded} selected; the rest will be shuffled.`
                : `${pending.picked.length}/${choiceNeeded} selected.${pending.picked.length > 0
                  ? ` Discard order (later is higher): ${pending.picked.map((uid, index) => {
                    const card = pending.choiceCards!.find((held) => held.uid === uid)!
                    return `${index + 1}. ${faceOf(cardDef(card.defId), card.upgraded).name}`
                  }).join(' → ')}.`
                  : ''} The card is committed.`}
            </p>
            <div className="choice-modal__cards">
              {pending.choiceCards.map((card) => (
                <Card key={card.uid} card={card} selected={pending.picked.includes(card.uid)}
                  onClick={onChoiceCardClick} />
              ))}
              {pending.choiceCards.length === 0 ? <span className="muted">No cards were revealed.</span> : null}
            </div>
            <button type="button" disabled={!handChoiceSatisfied} onClick={confirmChoice}>
              {pending.choice.kind === 'scry'
                ? pending.picked.length === 0 ? 'Keep all' : `Discard ${pending.picked.length} and continue`
                : pending.choice.kind === 'topdeck'
                  ? `Put selected card${choiceNeeded === 1 ? '' : 's'} on top`
                : pending.choice.kind === 'recover'
                  ? pendingDef?.effects.some((effect) => effect.kind === 'recoverDiscard' && effect.toHand)
                    ? `Return selected card${choiceNeeded === 1 ? '' : 's'} to hand`
                    : `Put selected card${choiceNeeded === 1 ? '' : 's'} on top`
                : pending.choice.kind === 'recoverExhaust'
                  ? 'Return selected card to hand'
                : pending.choice.kind === 'search'
                  ? choiceNeeded === 0
                    ? 'Shuffle and continue'
                    : pendingDef?.effects.some((effect) => effect.kind === 'searchDrawAndPlayTwice')
                    ? 'Play selected card twice and shuffle'
                    : `Put selected card${choiceNeeded === 1 ? '' : 's'} in hand and shuffle`
                : choiceNeeded === 0 ? 'Continue' : `Discard selected card${choiceNeeded === 1 ? '' : 's'}`}
            </button>
            {pending.cardInHand &&
            (pending.choice.kind === 'recover' || pending.choice.kind === 'recoverExhaust') ? (
              <button type="button" className="prompt__cancel" onClick={() => setPending(null)}>Cancel</button>
            ) : null}
          </div>
        </dialog>
      ) : null}

      <div
        className="board"
        data-rows={rows.length}
        ref={boardRef}
        tabIndex={0}
        aria-label="Combat board"
      >
        {bosses.length > 0 ? (
          <div className="board__bosses">
            {bosses.map((enemy, index) => (
              <EnemyCard
                key={enemy.uid}
                enemy={enemy}
                label={enemyLabel(state.enemies, enemy)}
                die={state.die}
                acting={state.phase === 'enemy' && !reducedMotion}
                animateBoss={!reducedMotion}
                falling={falling.has(enemy.uid)}
                visualContactMs={prefersReducedMotion ? 0 : characterAttackContactMs(state, enemy.uid,
                  latestTargetPresentationEvent(state.presentationEvents, enemy.uid))}
                visualEventSeq={latestTargetPresentationEvent(state.presentationEvents, enemy.uid)?.seq}
                visualResetKey={visualResetKey}
                stageVisualDamage={!prefersReducedMotion}
                hitBeats={hits.get(enemy.uid)}
                vfx={enemyVfxFor(enemy).map((active) => (
                  <CombatVfx
                    key={`${active.event.seq}-${active.recipe.asset}`}
                    active={active}
                    role="target"
                    attackContactMs={prefersReducedMotion
                      ? 0
                      : characterAttackContactMs(state, enemy.uid, active.event)}
                    revealDelayMs={orbEndTurnRevealDelayMs.get(active.event.seq)}
                  />
                ))}
                stageIndex={stageEnemies.length + index}
                // A boss stands in every row, so the only reading that means
                // anything to the person looking at the screen is their own.
                defender={viewer}
                disabled={Boolean(pendingStartEnemy?.id.startsWith('facing:') && !startEnemyChoiceAvailable(enemy.uid))}
                targeted={(cardDrag?.targetUid === enemy.uid ||
                  cardDragTargetRow !== undefined && (cardDragTargetRow === enemy.row || enemy.isBoss) ||
                  isStartTurnEnemyTarget(enemy.uid) ||
                  (pendingTrigger?.playerId === viewer.id &&
                    pendingTrigger.targets?.some((target) => target.uid === enemy.uid)) ||
                  isEnemyRowClickTargetable(enemy) ||
                  ((pendingPotionDef?.target === 'enemy' || pendingPowerDef || pendingPotionOverflow > 0) || spendingShiv || (
                  ((pendingEvokeTarget < 0 && pending?.needsEnemy === true && !enemyChoicesDone) ||
                    (pendingEvokeTarget >= 0 && !pendingEvokeUsesRows && pendingEvokeTargetUids.has(enemy.uid))) && choiceSatisfied
                ))) && !enemy.dead}
                onClick={onEnemyClick}
              />
            ))}
          </div>
        ) : null}

        {rows.map((row) => {
          const occupant = state.players.find((player) => player.row === row)
          const foes = stageEnemies.filter((enemy) => enemy.row === row)
          const actorEvents = occupant ? actorVfxFor(occupant.id) : []
          const actorVfx = actorEvents.filter(({ event }) => event.enemyIds.length === 0)
          const latestActorVfx = actorEvents[actorEvents.length - 1]
          const characterAttackMotions = occupant ? characterAttacks[occupant.id] ?? [] : []
          const characterAttack = characterAttackMotions.at(-1)
          const latestCharacterAttackSeq = characterAttack?.active.event.seq
          const rowLabel = combatRowLabel(state, row)
          return (
            <div
              className={['row', occupant?.id === viewerId ? 'row--viewer' : ''].filter(Boolean).join(' ')}
              key={row}
              ref={occupant?.id === viewerId ? viewerRowRef : undefined}
              style={{ '--stage-row': rows.indexOf(row) } as React.CSSProperties}
            >
              {pendingPotionDef?.target === 'row' ? (
                <button
                  type="button"
                  className="row__potion-target"
                  onClick={() => consumePotion(pendingPotion!, { enemyRow: row })}
                >
                  Target {rowLabel}
                </button>
              ) : null}
              {pendingPowerDef?.target === 'row' ? (
                <button
                  type="button"
                  className="row__potion-target"
                  onClick={() => usePower(pendingPowerUid!, { enemyRow: row })}
                >
                  Target {rowLabel}
                </button>
              ) : null}
              {pendingTrigger?.playerId === viewer.id && pendingTrigger.rows?.some((target) => target.row === row) ? (
                <button
                  type="button"
                  className="row__potion-target"
                  disabled={usingTrigger}
                  onClick={() => resolveTrigger(row)}
                >
                  Resolve {pendingTrigger.label} in {rowLabel}
                </button>
              ) : null}
              {(pendingEvokeUsesRows && pendingEvokeTargetUids.has(lightningRowTarget(row))) ||
              pendingStartEvokeRows.some((target) => target.row === row) ? (
                <button
                  type="button"
                  className="row__potion-target"
                  onClick={() => {
                    const startTarget = pendingStartEvokeRows.find((target) => target.row === row)
                    if (startTarget) {
                      chooseStartTurnEvokeEnemy(startTarget.uid)
                      return
                    }
                    const targets = [...pending!.evokeEnemyUids]
                    targets[pendingEvokeTarget] = lightningRowTarget(row)
                    stageOrCommit({ ...pending!, evokeEnemyUids: targets })
                  }}
                >
                  Evoke Lightning in {rowLabel}
                </button>
              ) : null}
              <div className="row__seat">
                {occupant ? (
                  <>
                    <button
                      type="button"
                      className={[
                        'seat',
                        occupant.id === viewerId ? 'seat--viewer' : '',
                        occupant.dead ? 'seat--dead' : '',
                        falling.has(occupant.id) ? 'seat--falling' : '',
                        characterAttack
                          ? `seat--attack-${occupant.character}`
                          : latestActorVfx && latestActorVfx.recipe.actorMotion !== 'none'
                          ? `seat--vfx-${latestActorVfx.recipe.actorMotion} seat--vfx-beat-${latestActorVfx.event.seq % 2}`
                          : '',
                        (!occupant.dead && ((pendingPotion !== null && potionDef(pendingPotion).supportTarget === 'anyPlayer') ||
                          cardDrag?.needsPlayer ||
                          (independentPlayerPending && enemyChoicesDone && choiceSatisfied) ||
                          (pending?.needsAlly && pending.playerId === null && enemyChoicesDone && choiceSatisfied) ||
                          (switchChoiceReady && occupant.id !== viewerId))
                        )
                          ? 'seat--targetable'
                          : '',
                        cardDrag?.targetPlayerId === occupant.id ? 'seat--targeted' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      onClick={() => onAllyClick(occupant)}
                      data-player-id={occupant.id}
                      data-stance={occupant.stance}
                      data-attack-target={characterAttack?.targetId}
                      style={characterAttack ? {
                        '--attack-x': `${characterAttack.x}px`,
                        '--attack-y': `${characterAttack.y}px`,
                      } as React.CSSProperties : undefined}
                      aria-label={describeSeat(occupant)}
                    >
                      <span className="seat__portrait" aria-hidden="true">
                        {occupant.character === 'watcher' && occupant.stance !== 'neutral' ? (
                          <span className={`stance-aura stance-aura--${occupant.stance}`} />
                        ) : null}
                        <img
                          key={`${occupant.character}-${characterAttack?.active.event.seq ?? latestActorVfx?.event.seq ?? 'idle'}`}
                          src={assetPath(`combat/characters/${occupant.character}.webp`)}
                          data-vfx-seq={latestActorVfx?.event.seq}
                          alt=""
                          onError={(event) => { event.currentTarget.style.display = 'none' }}
                        />
                        <OrbRow player={occupant} />
                        {characterAttackMotions.map((characterAttack) => (
                          <span
                            className={`character-attack character-attack--${occupant.character}`}
                            data-attack-seq={characterAttack.active.event.seq}
                            data-attack-target-count={characterAttack.targets.length}
                            key={characterAttack.active.event.seq}
                            style={{
                              '--attack-x': `${characterAttack.x}px`,
                              '--attack-y': `${characterAttack.y}px`,
                            } as React.CSSProperties}
                          >
                            {occupant.character === 'ironclad' &&
                            characterAttack.active.event.seq === latestCharacterAttackSeq ? (
                              <>
                                <span className="character-attack__pose character-attack__pose--ironclad-ready">
                                  <img src={assetPath('combat/characters/ironclad-ready.webp')} alt="" />
                                </span>
                                <span className="character-attack__pose character-attack__pose--ironclad-impact">
                                  <img src={assetPath('combat/characters/ironclad-impact.webp')} alt="" />
                                </span>
                              </>
                            ) : null}
                            {occupant.character === 'silent' &&
                            characterAttack.active.event.seq === latestCharacterAttackSeq ? (
                              <span className="character-attack__pose character-attack__pose--silent-throw">
                                <img src={assetPath('combat/characters/silent-throw.webp')} alt="" />
                              </span>
                            ) : null}
                            {occupant.character === 'watcher' ? (
                              <>
                                {characterAttack.active.event.seq === latestCharacterAttackSeq ? (
                                  <>
                                    <span className="character-attack__pose character-attack__pose--watcher-charge">
                                      <img src={assetPath('combat/characters/watcher-ready.webp')} alt="" />
                                    </span>
                                    <span className="character-attack__pose character-attack__pose--watcher-cast">
                                      <img src={assetPath('combat/characters/watcher-thrust.webp')} alt="" />
                                    </span>
                                  </>
                                ) : null}
                                {characterAttack.targets.map((target, index) => (
                                  <span
                                    className="character-attack__meteor"
                                    data-attack-target-id={target.id}
                                    key={target.id}
                                    style={{
                                      '--attack-target-x': `${target.x}px`,
                                      '--attack-target-y': `${target.y}px`,
                                      '--attack-start-x': `${target.startX}px`,
                                      '--attack-start-y': `${target.startY}px`,
                                      '--attack-delay': `${index * 70}ms`,
                                    } as React.CSSProperties}
                                  >
                                    <img
                                      className="character-attack__meteor-art"
                                      src={assetPath('combat/vfx/actions/watcher-meteor.webp')}
                                      alt=""
                                    />
                                    <img
                                      className="character-attack__meteor-impact"
                                      src={assetPath('combat/vfx/actions/watcher-meteor-impact.webp')}
                                      alt=""
                                    />
                                  </span>
                                ))}
                              </>
                            ) : null}
                            {occupant.character === 'ironclad' &&
                            characterAttack.active.event.seq === latestCharacterAttackSeq ? (
                              <span className="character-attack__swing" />
                            ) : null}
                            {occupant.character === 'defect' &&
                            characterAttack.active.event.seq === latestCharacterAttackSeq ? (
                              <>
                                <span className="character-attack__pose character-attack__pose--defect-charge">
                                  <img src={assetPath('combat/characters/defect-charge.webp')} alt="" />
                                </span>
                                <span className="character-attack__pose character-attack__pose--defect-release">
                                  <img src={assetPath('combat/characters/defect-release.webp')} alt="" />
                                </span>
                                <span className="character-attack__core">
                                  <img src={assetPath('combat/vfx/actions/defect-face-orb.webp')} alt="" />
                                </span>
                              </>
                            ) : null}
                            {(occupant.character === 'silent' || occupant.character === 'defect')
                              ? characterAttack.targets.map((target, index) => (
                                <span
                                  className={occupant.character === 'silent'
                                    ? 'character-attack__dagger'
                                    : 'character-attack__bolt'}
                                  data-attack-target-id={target.id}
                                  key={target.id}
                                  style={{
                                    '--attack-target-x': `${target.x}px`,
                                    '--attack-target-y': `${target.y}px`,
                                    '--attack-delay': `${index * 70}ms`,
                                  } as React.CSSProperties}
                                >
                                  {occupant.character === 'silent'
                                    ? <img src={assetPath('combat/vfx/actions/silent-knife.webp')} alt="" />
                                    : <img src={assetPath('combat/vfx/actions/defect-face-orb.webp')} alt="" />}
                                </span>
                              ))
                              : null}
                          </span>
                        ))}
                        {actorVfx.map((active) => (
                          <CombatVfx key={`actor-${active.event.seq}-${active.recipe.asset}`} active={active} role="actor"
                            revealDelayMs={orbEndTurnRevealDelayMs.get(active.event.seq)} />
                        ))}
                        {playerVfxFor(occupant.id).map((active) => (
                          <CombatVfx key={`target-${active.event.seq}-${active.recipe.asset}`} active={active} role="target"
                            revealDelayMs={orbEndTurnRevealDelayMs.get(active.event.seq)} />
                        ))}
                      </span>
                      {(hits.get(occupant.id) ?? []).map((hit) => (
                        <span
                          className="hit-vfx"
                          key={hit.beat}
                          aria-hidden="true"
                          style={{ '--hit-delay': `${hit.delayMs}ms` } as React.CSSProperties}
                        >
                          <strong>{hit.damage}</strong>
                        </span>
                      ))}
                      <span className="seat__name">{occupant.name}</span>
                      <span className="bar">
                        <span
                          className="bar__fill bar__fill--hp"
                          data-health={healthBand(occupant.hp, occupant.maxHp)}
                          style={{ width: `${Math.round((occupant.hp / occupant.maxHp) * 100)}%` }}
                        />
                        <span className="bar__label">
                          {occupant.hp}/{occupant.maxHp}
                        </span>
                      </span>
                      <span className="seat__meta">
                      {occupant.strengthLossAtEndOfTurn > 0 ? (
                        <span className="seat__pending">
                          −{occupant.strengthLossAtEndOfTurn} Strength at end of turn
                        </span>
                      ) : null}
                      {occupant.drawLocked ? (
                        <span className="seat__pending">Cannot draw more cards this turn</span>
                      ) : null}
                      {occupant.cardPlayLocked ? (
                        <span className="seat__pending">No additional cards this turn</span>
                      ) : null}
                      {(occupant.freeAttacksThisTurn ?? 0) > 0 ? (
                        <span className="seat__pending">Swivel · next Attack costs 0 this turn</span>
                      ) : null}
                      {(occupant.doubledAttacksThisTurn ?? 0) > 0 ? (
                        <span className="seat__pending">
                          Double Tap · next {occupant.doubledAttacksThisTurn} Attack{
                            occupant.doubledAttacksThisTurn === 1 ? '' : 's'
                          } played twice
                        </span>
                      ) : null}
                      {(occupant.tripledAttacksThisTurn ?? 0) > 0 ? (
                        <span className="seat__pending">
                          Blasphemy · next {occupant.tripledAttacksThisTurn} Attack{
                            occupant.tripledAttacksThisTurn === 1 ? '' : 's'
                          } played three times
                        </span>
                      ) : null}
                      {(occupant.doubledCardsThisTurn ?? 0) > 0 ? (
                        <span className="seat__pending">
                          Echo Form · next {occupant.doubledCardsThisTurn} Attack or Skill card{
                            occupant.doubledCardsThisTurn === 1 ? '' : 's'
                          } played twice
                        </span>
                      ) : null}
                      {(occupant.doubledSkillsThisTurn ?? 0) > 0 ? (
                        <span className="seat__pending">
                          Burst · next {occupant.doubledSkillsThisTurn} Skill{
                            occupant.doubledSkillsThisTurn === 1 ? '' : 's'
                          } played twice
                        </span>
                      ) : null}
                      {remainingRoundHpLoss(occupant) !== undefined ? (
                        <span className="seat__pending">
                          {occupant.powers.some((power) => power.defId === 'wraith_form') ? 'Wraith Form' : 'Apparition'} · {remainingRoundHpLoss(occupant)} HP loss remaining
                        </span>
                      ) : null}
                      {occupant.potions.length > 0 ? (
                        <span className="seat__potions">
                          {occupant.potions.map((id, index) => <PotionIcon id={id} focusable={false}
                            key={`${id}-${index}`} />)}
                        </span>
                      ) : null}
                      </span>
                    </button>
                    <div className="seat__status-strip" tabIndex={0}
                      aria-label={`${occupant.name} permanent effects`}>
                      <TokenRow
                        block={occupant.block}
                        strength={occupant.strength}
                        vulnerable={occupant.vulnerable}
                        weak={occupant.weak}
                        shivs={occupant.shivs}
                        miracles={occupant.miracles}
                        clawCubes={occupant.clawCubesGainedThisCombat}
                      />
                      <PowerRow powers={occupant.powers} />
                    </div>
                  </>
                ) : (
                  <span className="seat seat--empty">empty row</span>
                )}
              </div>
              <div className="row__enemies" data-enemies={foes.length}>
                {foes.length > 0 ? (
                  foes.map((enemy) => (
                    <EnemyCard
                      key={enemy.uid}
                      enemy={enemy}
                      label={enemyLabel(state.enemies, enemy)}
                      die={state.die}
                      falling={falling.has(enemy.uid)}
                      visualContactMs={prefersReducedMotion ? 0 : characterAttackContactMs(state, enemy.uid,
                        latestTargetPresentationEvent(state.presentationEvents, enemy.uid))}
                      visualEventSeq={latestTargetPresentationEvent(state.presentationEvents, enemy.uid)?.seq}
                      visualResetKey={visualResetKey}
                      stageVisualDamage={!prefersReducedMotion}
                      hitBeats={hits.get(enemy.uid)}
                      vfx={enemyVfxFor(enemy).map((active) => (
                        <CombatVfx
                          key={`${active.event.seq}-${active.recipe.asset}`}
                          active={active}
                          role="target"
                          attackContactMs={prefersReducedMotion
                            ? 0
                            : characterAttackContactMs(state, enemy.uid, active.event)}
                          revealDelayMs={orbEndTurnRevealDelayMs.get(active.event.seq)}
                        />
                      ))}
                      stageIndex={stageEnemies.findIndex((candidate) => candidate.uid === enemy.uid)}
                      rowLabel={occupant?.name ?? `Player ${row + 1}`}
                      defender={occupant}
                      disabled={Boolean(pendingStartEnemy?.id.startsWith('facing:') && !startEnemyChoiceAvailable(enemy.uid))}
                      targeted={(cardDrag?.targetUid === enemy.uid ||
                        cardDragTargetRow !== undefined && (cardDragTargetRow === enemy.row || enemy.isBoss) ||
                        isStartTurnEnemyTarget(enemy.uid) ||
                        (pendingTrigger?.playerId === viewer.id &&
                          pendingTrigger.targets?.some((target) => target.uid === enemy.uid)) ||
                        isEnemyRowClickTargetable(enemy) ||
                        ((pendingPotionDef?.target === 'enemy' || pendingPowerDef || pendingPotionOverflow > 0) || spendingShiv || (
                        ((pendingEvokeTarget < 0 && pending?.needsEnemy === true && !enemyChoicesDone) ||
                          (pendingEvokeTarget >= 0 && !pendingEvokeUsesRows && pendingEvokeTargetUids.has(enemy.uid))) && choiceSatisfied
                      ))) && !enemy.dead}
                      onClick={onEnemyClick}
                    />
                  ))
                ) : null}
              </div>
            </div>
          )
        })}
      </div>

      <footer className="hand-area">
        <div className="hand-area__stats">
          <span className={[
            'pip',
            'pip--energy',
            motionActive.has('energy') ? `motion-pulse-${motionBeats.energy % 2}` : '',
          ].filter(Boolean).join(' ')} data-character={viewer.character} title="Energy">
            <IconValue name="energy" value={viewer.energy} size={26} />
          </span>
          <span className={['pile', motionActive.has('draw')
            ? `motion-pulse-${motionBeats.draw % 2}` : ''].filter(Boolean).join(' ')}
            data-pile="draw" title="Draw pile">
            <img className="pile__stack" src={assetPath('combat/piles/draw.webp')} alt="" />
            <span className="pile__count" aria-hidden="true">{displayedPileCount('draw', drawPileCount)}</span>
            <span className="visually-hidden">Draw pile, {drawCount ?? viewer.draw.length} cards</span>
          </span>
          <span className="pile-group">
            {([
              ['discard', 'Discard pile', viewer.discard],
              ['exhaust', 'Exhaust pile', viewer.exhaust],
            ] as const).map(([kind, label, cards]) => (
              <CardCollectionOverlay key={kind} cards={cards} label={label} dataPile={kind}
                triggerClassName={['pile', motionActive.has(kind)
                  ? `motion-pulse-${motionBeats[kind] % 2}` : ''].filter(Boolean).join(' ')}>
                <img className="pile__stack" src={assetPath(`combat/piles/${kind}.webp`)} alt="" />
                <span className="pile__count" aria-hidden="true">{displayedPileCount(kind, cards.length)}</span>
              </CardCollectionOverlay>
            ))}
          </span>
        </div>
        {/* Fanned, the way a hand is actually held: each card tilted and
            lifted by its distance from the middle. The angle is set here
            because only the component knows how many cards there are. */}
        <div className="hand-scroll" onWheel={(event) => {
          event.currentTarget.scrollLeft += event.deltaX || (event.shiftKey ? event.deltaY : 0)
        }}><div className="hand" data-count={viewer.hand.length}>
          {viewer.hand.map((card, index) => (
            <Card
              key={card.uid}
              className={[drawnCards.has(card.uid) ? 'card--drawn' : '',
                cardDrag?.card.uid === card.uid ? 'card--dragging' : ''].filter(Boolean).join(' ') || undefined}
              style={{ '--deal-index': index } as React.CSSProperties}
              fan={fanOf(index, viewer.hand.length)}
              card={card}
              cost={card.uid === forcedCardUid ? 0 : playCost(faceOf(cardDef(card.defId), card.upgraded), viewer, card)}
              playable={
                !usingCard &&
                !pendingTrigger &&
                !orderingStage &&
                (!pending?.choiceCards || pending.card.uid === card.uid) &&
                ((state.phase === 'player' && !forcedCard && !distilled && !relicScry) || card.uid === forcedCardUid ||
                  (pending?.card.uid === forcedCardUid && pending.choice !== null && !pending.choiceCards) ||
                  (state.phase === 'copy' && pending?.cardInHand === false &&
                    pending.choice !== null && !pending.choiceCards)) &&
                // While a card is staged, other cards stay clickable only as
                // choice targets; an unaffordable card must never be stageable
                // or it strands the player in a pending state it cannot commit.
                (card.uid === forcedCardUid ||
                  (pending?.card.uid === forcedCardUid && pending.choice !== null &&
                    !pending.choiceCards && card.uid !== pending.card.uid) ||
                  canAfford(state, viewer, card, miracleOnCard, drawCount) ||
                  pending?.card.uid === card.uid ||
                  (pending?.choice != null && card.uid !== pending.card.uid))
              }
              selected={pending?.card.uid === card.uid}
              picked={pending?.picked.includes(card.uid) === true}
              onClick={activateCard}
              onPointerDown={(event) => onCardPointerDown(card, event)}
              onPointerMove={onCardPointerMove}
              onPointerUp={finishCardDrag}
              onPointerCancel={cancelCardDrag}
              onLostPointerCapture={cancelCardDrag}
            />
          ))}
        </div></div>
      </footer>
      {cardDrag ? (
        <>
          {cardDrag.needsEnemy || cardDrag.needsPlayer ? (
            <svg className="card-target-arrow" aria-hidden="true">
              <defs>
                <marker id="card-target-arrowhead" markerUnits="userSpaceOnUse"
                  markerWidth="22" markerHeight="22" refX="18" refY="11" orient="auto">
                  <path d="M 0 0 L 22 11 L 0 22 Z" />
                </marker>
              </defs>
              <path ref={cardDragArrowShadow} className="card-target-arrow__shadow" d={`M ${cardDrag.startX} ${cardDrag.startY - 45} Q ${cardDrag.startX} ${cardDrag.y} ${cardDrag.x} ${cardDrag.y}`} />
              <path ref={cardDragArrow} className="card-target-arrow__line" d={`M ${cardDrag.startX} ${cardDrag.startY - 45} Q ${cardDrag.startX} ${cardDrag.y} ${cardDrag.x} ${cardDrag.y}`} />
            </svg>
          ) : null}
          <div ref={cardDragOverlay} className="card-drag" style={{
            left: cardDrag.startX,
            top: cardDrag.startY - 90,
            '--drag-y': `${Math.max(0, cardDrag.y - cardDrag.startY + 210)}px`,
            '--drag-turn': `${Math.max(-8, Math.min(8, (cardDrag.x - cardDrag.startX) / 24))}deg`,
          } as React.CSSProperties} aria-hidden="true" inert>
            <Card card={cardDrag.card} playable={false} />
          </div>
        </>
      ) : null}
      {cardFlights.map((flight) => (
        <div
          className={`card-flight card-flight--${flight.destination} card-flight--${viewer.character}`}
          key={flight.beat}
          aria-hidden="true"
          inert
        >
          <Card card={flight.card} playable={false} />
        </div>
      ))}
    </div>
  )
}

export const CombatScreen = memo(CombatScreenView)
