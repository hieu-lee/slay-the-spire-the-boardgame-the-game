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
  requirementsOf,
  revealViewerRow,
  rowsOf,
} from './combat-screen/helpers.ts'
import {
  useCombatSoundEffects,
  useFalling,
  usePersonalCombatSoundEffects,
  usePresentationEvents,
  useReducedEffects,
  useStruck,
} from './combat-screen/hooks.ts'
import type { TargetContactDeadline } from './combat-screen/hooks.ts'
import type {
  ActiveCombatVfx,
  CardDrag,
  CardDragStart,
  CardFlight,
  CharacterAttackMotion,
  CombatScreenProps,
  EndTurnEffectDrag,
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
import { cardCost, cardDef, cardIsCurse, faceOf } from '../game/cards.ts'
import type { CardDef } from '../game/cards.ts'
import {
  activatePotion,
  activatePower,
  activateRelic,
  beginEndTurnResolution,
  canActivatePotion,
  canActivateRelic,
  cardEnemyChoiceCount,
  cardHasRetain,
  cardModeIsAvailable,
  cardNeedsChoicePreview,
  cardNeedsEnemy,
  cardPlayConditionMet,
  cardPlayerChoiceCount,
  cardReferencesGuardianMode,
  cardShivChoiceCount,
  chooseDistilledCard,
  chosenEvokeOrbs,
  chooseEndTurnTarget,
  combatRowLabel,
  defaultStartTurnChoices,
  activePowerWindow,
  endPlayerTurn,
  endTurnResolutionAbility,
  enemyLabel,
  enemyTurn,
  effectiveCombatCardDef,
  evokeTargetProgress,
  facingChoicesAreValid,
  guardianCardNeedsAlly,
  guardianGemForCard,
  guardianPowerBeamCards,
  lightningRowFromTarget,
  lightningRowTarget,
  lightningTargetsRows,
  livingEnemies,
  mandatoryChoicePending,
  maximumXEnergy,
  nextEvokeChoice,
  orderStartTurnScries,
  overflowShivCount,
  pendingTriggerAbility,
  pendingTriggerSlimeEnemyChoiceLabels,
  playCard,
  playCardCopy,
  playHermitChamberCard,
  playCost,
  powerAbilityKey,
  powerAbilityUsed,
  previewCardChoice,
  previewCardCopyChoice,
  previewHermitChamberCardChoice,
  previewPowerChoice,
  reachesEnemy,
  reachedTimeWarpLimit,
  slimeChoiceIsAvailable,
  slimeCommandEnemyChoiceLabels,
  remainingRoundHpLoss,
  resolvePendingTrigger,
  resolveEndTurnAbility,
  resolvePendingDieRelicChoice,
  resolveHermitSetupLoad,
  resolveHermitStrengthReward,
  resolvePlunderRowSwitch,
  resolveStartPlayerTurn,
  resolveStartTurnDiscard,
  resolveStartTurnScry,
  spendMiracle,
  spendShiv,
  spendSoulburn,
  startPlayerTurnWithChoices,
  startTurnAbilities,
  startTurnDiscardPreview,
  startTurnNeedsChoice,
  startTurnScryAbilities,
  startTurnScryPreview,
} from '../game/combat.ts'
import type {
  CombatPresentationEvent,
  CombatState,
  DiscardOrders,
  PotionContext,
  PowerContext,
  RelicContext,
  StartTurnChoice,
} from '../game/combat.ts'
import { chosenDieRelicAbilities, potionDef, relicDef } from '../game/relics.ts'
import { CAPS, DOWNFALL_CHARACTER_IDS } from '../game/types.ts'
import type { CardInstance, DownfallCharacterId, Enemy, Player } from '../game/types.ts'
import type { ActionOutcome } from '../multiplayer/useRoomSession.ts'
import { Card, slimeCommandText } from './Card.tsx'
import { CardCollectionOverlay } from './CardCollectionOverlay.tsx'
import { EnemyCard } from './EnemyCard.tsx'
import { Icon, IconValue, StatusIcon, dieIcon } from './Icon.tsx'
import { PotionIcon, PotionTooltipAnchor } from './PotionIcon.tsx'
import {
  PowerGlyph,
  PowerRow,
  registerCardZoomCloser,
  releaseCardZoom,
  tryClaimCardZoom,
} from './PowerRow.tsx'
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
import { createPortal } from 'react-dom'

function targetPresentationTiming(
  state: CombatState,
  targetId: string,
  contacts: ReadonlyMap<string, TargetContactDeadline>,
): { event?: CombatPresentationEvent; contact: number } {
  const event = latestTargetPresentationEvent(state.presentationEvents, targetId)
  if (!event) return { contact: 0 }
  const scheduled = contacts.get(targetId)
  if (!scheduled || scheduled.throughSeq < event.seq) return { event, contact: -1 }
  const outstanding = Math.max(0, scheduled.at - performance.now())
  if (outstanding > 0) return { event, contact: outstanding }
  const slimeAnimation = event.kind === 'slime' ||
    event.kind === 'card' && cardDef(event.sourceId).cardKind === 'slime'
  return {
    event,
    contact: slimeAnimation ? -1 : characterAttackContactMs(state, targetId, event),
  }
}

// Weighted alpha PCA of watcher-meteor.webp: tail-to-nose y/x.
const WATCHER_METEOR_FALL_SLOPE = 0.7113856 / 0.7028019
const CHAMBER_RETURN_MS = 460
const CHAMBER_RETURN_STAGGER_MS = 35
const CHAMBER_REFLOW_MS = 420

const slimeAssetSlug = (defId: string): string => defId
  .replace(/^slime_boss_/, '')
  .replace(/_slime$/, '')
  .replace(/_/g, '-')

const slimeFallbackAsset = (defId: string): string => {
  if (defId.includes('spike')) return 'combat/enemies/spike_slime.webp'
  if (defId.includes('massive') || defId.includes('armored') || defId.includes('royal')) {
    return 'combat/enemies/large_slime.webp'
  }
  if (defId.includes('leeching') || defId.includes('sticky') || defId.includes('spreading')) {
    return 'combat/enemies/acid_slime.webp'
  }
  return 'combat/enemies/small_slime.webp'
}

type ChamberReturnFlight = {
  card: CardInstance
  left: number
  top: number
  width: number
  height: number
  x: number
  y: number
  index: number
}

type SlimeCardZoom = { card: CardInstance; x: number; y: number }

const dieRelicChoiceLabel = (owner: string, relic: string, faces: readonly number[]): string =>
  `${owner}: ${relic} · die ${faces.join('/')}`

function downfallEnergyOrbLayers(character: DownfallCharacterId, empty: boolean) {
  const layers = character === 'guardian' ? ['6', '1', '2', '3', '4', '5', '7'] : ['1', '2', '3', '4', '5', '6']
  const base = character === 'guardian' ? '7' : '6'
  return layers.map((layer) => ({
    layer,
    src: assetPath(`combat/energy-orbs/${character}/layer${layer}${empty && layer !== base ? 'd' : ''}.png`),
  }))
}

function stageHermitChamberViewer(player: Player, card: CardInstance, free = false) {
  const stagedCard = { ...card, hermitDeadOn: true, ...(free ? { freeThisTurn: true } : {}) }
  return {
    card: stagedCard,
    player: {
      ...player,
      chamber: player.chamber.filter((held) => held.uid !== card.uid),
      hand: [...player.hand, stagedCard],
    },
  }
}

function chargedCardEnergy(def: CardDef, player: Player, card: CardInstance): number | undefined {
  const cost = playCost(def, player, card)
  return typeof cost === 'number' ? cost : undefined
}

function HexaghostAttackPose({ asset, assetPath: sourceAsset, fallbackAsset, attackSeq }: {
  asset?: Blob
  assetPath: string
  fallbackAsset: string
  attackSeq: number
}) {
  const [replayAsset] = useState(asset)
  const [src, setSrc] = useState<string | undefined>(() => replayAsset ? undefined : fallbackAsset)
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    if (!replayAsset) return
    const url = URL.createObjectURL(replayAsset)
    setSrc(url)
    return () => URL.revokeObjectURL(url)
  }, [replayAsset])
  if (!src) return null
  return (
    <span
      className={['character-attack__pose', 'character-attack__pose--hexaghost-state',
        replayAsset ? '' : 'is-fallback', loaded ? 'is-loaded' : ''].filter(Boolean).join(' ')}
      data-attack-asset={sourceAsset}
      data-attack-seq={attackSeq}
    >
      <img src={src} alt="" onLoad={() => setLoaded(true)} />
    </span>
  )
}

function GuardianPortrait({ mode, animate, restartKey }: {
  mode: 'attack' | 'defense'
  animate: boolean
  restartKey: number | string
}) {
  const previousMode = useRef(mode)
  const transitionTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [transition, setTransition] = useState<'to-attack' | 'to-defense' | null>(null)
  useEffect(() => {
    for (const direction of ['attack', 'defense']) {
      const image = new Image()
      image.src = assetPath(`combat/characters/guardian-to-${direction}.webp`)
    }
    return () => {
      if (transitionTimer.current) clearTimeout(transitionTimer.current)
    }
  }, [])
  useLayoutEffect(() => {
    if (transitionTimer.current) clearTimeout(transitionTimer.current)
    const previous = previousMode.current
    previousMode.current = mode
    if (!animate || previous === mode) {
      setTransition(null)
      return
    }
    setTransition(mode === 'defense' ? 'to-defense' : 'to-attack')
  }, [animate, mode])
  const file = transition
    ? `guardian-${transition}.webp`
    : mode === 'defense' ? 'guardian-defense.webp' : 'guardian.webp'
  return <img
    key={`${transition ?? mode}-${restartKey}`}
    src={assetPath(`combat/characters/${file}`)}
    data-guardian-mode={mode}
    data-guardian-transition={transition ?? undefined}
    data-vfx-seq={typeof restartKey === 'number' ? restartKey : undefined}
    alt=""
    onLoad={() => {
      if (!transition) return
      transitionTimer.current = setTimeout(() => setTransition(null), 600)
    }}
    onError={(event) => { event.currentTarget.style.display = 'none' }}
  />
}

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
  powerPreview,
  authoritativePendingTrigger,
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
  const [spendingSoulburn, setSpendingSoulburn] = useState(false)
  const [extraCrispySoulburn, setExtraCrispySoulburn] = useState(false)
  const [chamberOpen, setChamberOpen] = useState(false)
  const [chamberClosing, setChamberClosing] = useState(false)
  const [chamberContact, setChamberContact] = useState(false)
  const [chamberReturnFlights, setChamberReturnFlights] = useState<ChamberReturnFlight[]>([])
  const [pendingPotion, setPendingPotion] = useState<string | null>(null)
  const [pendingPowerUid, setPendingPowerUid] = useState<string | null>(null)
  const [powerChamberUids, setPowerChamberUids] = useState<string[]>([])
  const [powerLoadUids, setPowerLoadUids] = useState<string[]>([])
  const [powerChoiceCards, setPowerChoiceCards] = useState<CardInstance[] | null>(null)
  const [powerScryDiscardUids, setPowerScryDiscardUids] = useState<string[]>([])
  const [powerExhaustUids, setPowerExhaustUids] = useState<string[]>([])
  const [powerGemContext, setPowerGemContext] = useState<PowerContext | null>(null)
  const [powerScryConfirmed, setPowerScryConfirmed] = useState(false)
  const [autoAdvanceRetry, setAutoAdvanceRetry] = useState(0)
  const [potionShivEnemyUids, setPotionShivEnemyUids] = useState<string[]>([])
  const [potionOverflowRequired, setPotionOverflowRequired] = useState(0)
  const [potionCardUids, setPotionCardUids] = useState<string[]>([])
  const [relicCardUids, setRelicCardUids] = useState<string[]>([])
  const [dieRelicCardUids, setDieRelicCardUids] = useState<string[]>([])
  const [relicShivEnemyUids, setRelicShivEnemyUids] = useState<string[]>([])
  const [usingPotion, setUsingPotion] = useState(false)
  const [usingPower, setUsingPower] = useState(false)
  const [usingTrigger, setUsingTrigger] = useState(false)
  const [usingCard, setUsingCard] = useState(false)
  const [discardTops, setDiscardTops] = useState<Record<string, string>>({})
  const [retainedCards, setRetainedCards] = useState<Record<string, string[]>>({})
  const [discardOrders, setDiscardOrders] = useState<DiscardOrders>({})
  const [endTurnEffectDrag, setEndTurnEffectDrag] = useState<EndTurnEffectDrag | null>(null)
  const [armedEndTurnAbilityId, setArmedEndTurnAbilityId] = useState<string | null>(null)
  const [slimeCardZoom, setSlimeCardZoom] = useState<SlimeCardZoom | null>(null)
  const closeSlimeCardZoom = useRef(() => setSlimeCardZoom(null))
  const [startTurnOrder, setStartTurnOrder] = useState<string[]>([])
  const [startTurnScryOrder, setStartTurnScryOrder] = useState<string[]>([])
  const [startTurnEnemyTargets, setStartTurnEnemyTargets] = useState<Record<string, string | undefined>>({})
  const [startTurnPlayerTargets, setStartTurnPlayerTargets] = useState<Record<string, string | undefined>>({})
  const [startTurnExhaustUids, setStartTurnExhaustUids] = useState<Record<string, string | undefined>>({})
  const [startTurnModeShifts, setStartTurnModeShifts] = useState<Record<string, boolean | undefined>>({})
  const [startTurnTargets, setStartTurnTargets] = useState<Record<string, (string | null | undefined)[]>>({})
  const [startTurnEvokeSlots, setStartTurnEvokeSlots] = useState<Record<string, number[]>>({})
  const [startTurnEvokeTargets, setStartTurnEvokeTargets] = useState<
    Record<string, (string | null | undefined)[]>
  >({})
  const [startTurnScryPicked, setStartTurnScryPicked] = useState<string[]>([])
  const [resolvingStartTurnScry, setResolvingStartTurnScry] = useState(false)
  const [resolvingStartTurnDiscard, setResolvingStartTurnDiscard] = useState(false)
  const [triggerHermitLoadUids, setTriggerHermitLoadUids] = useState<string[]>([])
  const [triggerHermitChamberUids, setTriggerHermitChamberUids] = useState<string[]>([])
  const [triggerSlimeUids, setTriggerSlimeUids] = useState<string[]>([])
  const [triggerSlimeEnemyUids, setTriggerSlimeEnemyUids] = useState<string[]>([])
  const [stageScale, setStageScale] = useState(1)
  const reducedMotion = useReducedEffects()

  useEffect(() => registerCardZoomCloser(closeSlimeCardZoom.current), [])
  const prefersReducedMotion = reducedMotion
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
  const armedCardFlight = useRef<{ card: CardInstance; chamber: boolean } | null>(null)
  const cardDragStart = useRef<CardDragStart | null>(null)
  const cardDragLive = useRef<CardDrag | null>(null)
  const cardDragFrame = useRef<number | null>(null)
  const cardDragMove = useRef<{ x: number; y: number } | null>(null)
  const cardDragOverlay = useRef<HTMLDivElement | null>(null)
  const cardDragArrow = useRef<SVGPathElement | null>(null)
  const cardDragArrowShadow = useRef<SVGPathElement | null>(null)
  const suppressCardClick = useRef<string | null>(null)
  const chamberCloseTimer = useRef<number | null>(null)
  const chamberContactTimer = useRef<number | null>(null)
  const chamberReflowFrame = useRef<number | null>(null)
  const handRevealFrame = useRef<number | null>(null)
  const chamberTriggerRef = useRef<HTMLButtonElement | null>(null)
  const handScrollRef = useRef<HTMLDivElement | null>(null)
  const handRef = useRef<HTMLDivElement | null>(null)
  const chamberViewerId = useRef(viewerId)
  const endTurnEffectDragStart = useRef<EndTurnEffectDrag | null>(null)
  const endTurnEffectDragLive = useRef<EndTurnEffectDrag | null>(null)
  const endTurnEffectDragFrame = useRef<number | null>(null)
  const endTurnEffectDragMove = useRef<{ x: number; y: number } | null>(null)
  const endTurnEffectDragOverlay = useRef<HTMLDivElement | null>(null)
  const endTurnEffectDragArrow = useRef<SVGPathElement | null>(null)
  const endTurnEffectDragArrowShadow = useRef<SVGPathElement | null>(null)
  const suppressEndTurnEffectClick = useRef<string | null>(null)
  const suppressEndTurnOrbClick = useRef<string | null>(null)
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
  const [hexaghostAttackBlobs, setHexaghostAttackBlobs] = useState<Map<string, Blob>>(() => new Map())
  const hexaghostAttackAssets = state.players.some((player) => player.character === 'hexaghost' && !player.dead)
    ? Array.from({ length: 7 }, (_, heat) =>
      assetPath(`combat/characters/hexaghost-heat-${heat}-attack.webp`)).join('|')
    : ''
  useEffect(() => {
    const controller = new AbortController()
    const assets = hexaghostAttackAssets.split('|').filter(Boolean)
    setHexaghostAttackBlobs((current) => new Map(assets
      .filter((src) => current.has(src))
      .map((src) => [src, current.get(src)!])))
    assets.forEach((src) => {
      void fetch(src, { signal: controller.signal }).then(async (response) => {
        if (!response.ok) return
        const blob = await response.blob()
        const decodeUrl = URL.createObjectURL(blob)
        try {
          const image = new Image()
          image.src = decodeUrl
          await image.decode?.()
        } finally {
          URL.revokeObjectURL(decodeUrl)
        }
        if (controller.signal.aborted) return
        setHexaghostAttackBlobs((current) => new Map(current).set(src, blob))
      }).catch(() => undefined)
    })
    return () => controller.abort()
  }, [hexaghostAttackAssets])
  const hermitSetupPending = state.pendingHermitSetupLoads?.[0]?.playerId === viewerId
  const hermitStrengthPending = state.pendingHermitStrengthRewards?.[0]?.playerId === viewerId
  const dieRelicPending = state.pendingDieRelicChoices?.[0]
  const hermitTargetedCurses = new Set(['hermit_grudge', 'hermit_malice', 'hermit_horror'])

  function submitHermitSetup(card: CardInstance, enemyUid: string | null = null) {
    if (onAction) void onAction({ kind: 'resolveHermitSetupLoad', cardUid: card.uid, enemyUid })
    else onChange?.(resolveHermitSetupLoad(state, viewerId, card.uid, enemyUid))
  }

  function submitHermitStrength(targetPlayerId: string) {
    if (onAction) void onAction({ kind: 'resolveHermitStrengthReward', playerId: targetPlayerId })
    else onChange?.(resolveHermitStrengthReward(state, viewerId, targetPlayerId))
  }

  function submitDieRelicChoice(discard: boolean) {
    if (dieRelicPending?.playerId !== viewerId) return
    if (onAction) void onAction({
      kind: 'resolveDieRelicChoice',
      ...(discard ? { discardUids: dieRelicCardUids } : { exhaustUids: dieRelicCardUids }),
    })
    else onChange?.(resolvePendingDieRelicChoice(state, viewerId,
      discard ? { discardUids: dieRelicCardUids } : { exhaustUids: dieRelicCardUids }))
  }

  function submitPlunderRow(row: number | null) {
    if (state.pendingPlunderSwitches?.[0]?.playerId !== viewerId) return
    if (onAction) void onAction({ kind: 'resolvePlunderRowSwitch', row })
    else onChange?.(resolvePlunderRowSwitch(state, viewerId, row))
  }

  function submitHermitChamber(
    card: CardInstance,
    enemyUid: string | null = null,
    targetPlayerId: string | null = null,
  ) {
    const def = faceOf(cardDef(card.defId), card.upgraded)
    const required = state.pendingHermitChamberPlays?.[0]
    const staged = stageHermitChamberViewer(viewer!, card,
      required?.playerId === viewerId && required.cardUids[0] === card.uid && required.free)
    const next = {
      ...pendingFor(staged.card, null, state, staged.player, false, undefined, true),
      chamberPlay: true,
      enemyUid,
    }
    if (cardNeedsChoicePreview(def, state, staged.player) && next.needsEnemy) {
      const pending = { ...next, choice: null, choiceCards: null }
      if (enemyUid === null) {
        setPending({ ...pending, choicePreviewPending: true })
        return
      }
      stageOrCommit(pending)
      return
    }
    stageOrCommit(targetPlayerId
      ? next.playerChoices > 0
        ? { ...next, playerIds: [targetPlayerId] }
        : { ...next, playerId: targetPlayerId }
      : next)
  }

  function skipUnplayableHermitChamber(card: CardInstance) {
    if (onAction) void onAction({ kind: 'playHermitChamberCard', cardUid: card.uid, enemyUid: null })
    else onChange?.(playHermitChamberCard(state, viewerId, card.uid))
  }
  const viewerHasSozu = viewer?.relics.some((relic) => relic.defId === 'sozu') ?? false
  const extraCrispyPower = viewer?.powers.find((power) => power.defId === 'extra_crispy' &&
    !powerAbilityUsed(state, viewerId, power.uid))
  const pendingTrigger = dieRelicPending ? null
    : authoritativePendingTrigger !== undefined ? authoritativePendingTrigger : pendingTriggerAbility(state)
  const triggerHermitChoicesReady = !pendingTrigger?.hermitChoices ||
    triggerHermitLoadUids.length >= pendingTrigger.hermitChoices.loadMinimum &&
    triggerHermitLoadUids.length <= pendingTrigger.hermitChoices.loadAmount &&
    triggerHermitChamberUids.length >= pendingTrigger.hermitChoices.chamberMinimum &&
    triggerHermitChamberUids.length <= pendingTrigger.hermitChoices.chamberAmount
  const triggerSlimeChoicesReady = !pendingTrigger?.slimeChoice ||
    triggerSlimeUids.length >= pendingTrigger.slimeChoice.minimum &&
    triggerSlimeUids.length <= pendingTrigger.slimeChoice.amount
  const triggerSlimeEnemyLabels = pendingTrigger
    ? pendingTriggerSlimeEnemyChoiceLabels(state, pendingTrigger.id, triggerSlimeUids) : []
  const triggerSlimeEnemyAmount = triggerSlimeEnemyLabels.length
  const pendingPlunder = state.pendingPlunderSwitches?.[0]
  const voluntaryActionsBlocked = mandatoryChoicePending(state)
  const requiredHermitChamberCard = state.pendingHermitChamberPlays?.[0]
  useEffect(() => {
    if (requiredHermitChamberCard?.playerId === viewerId) {
      if (chamberCloseTimer.current !== null) window.clearTimeout(chamberCloseTimer.current)
      if (chamberContactTimer.current !== null) window.clearTimeout(chamberContactTimer.current)
      if (chamberReflowFrame.current !== null) window.cancelAnimationFrame(chamberReflowFrame.current)
      chamberCloseTimer.current = null
      chamberContactTimer.current = null
      chamberReflowFrame.current = null
      setChamberClosing(false)
      setChamberContact(false)
      setChamberReturnFlights([])
      setChamberOpen(true)
    }
  }, [requiredHermitChamberCard?.playerId, requiredHermitChamberCard?.cardUids[0], viewerId])
  useEffect(() => () => {
    if (chamberCloseTimer.current !== null) window.clearTimeout(chamberCloseTimer.current)
    if (chamberContactTimer.current !== null) window.clearTimeout(chamberContactTimer.current)
    if (chamberReflowFrame.current !== null) window.cancelAnimationFrame(chamberReflowFrame.current)
    if (handRevealFrame.current !== null) window.cancelAnimationFrame(handRevealFrame.current)
  }, [])
  useEffect(() => {
    if (state.phase === 'player') return
    if (chamberCloseTimer.current !== null) window.clearTimeout(chamberCloseTimer.current)
    if (chamberContactTimer.current !== null) window.clearTimeout(chamberContactTimer.current)
    if (chamberReflowFrame.current !== null) window.cancelAnimationFrame(chamberReflowFrame.current)
    chamberCloseTimer.current = null
    chamberContactTimer.current = null
    chamberReflowFrame.current = null
    setChamberClosing(false)
    setChamberContact(false)
    setChamberReturnFlights([])
    setChamberOpen(false)
  }, [state.phase])
  useEffect(() => {
    if (chamberViewerId.current === viewerId) return
    chamberViewerId.current = viewerId
    if (chamberCloseTimer.current !== null) window.clearTimeout(chamberCloseTimer.current)
    if (chamberContactTimer.current !== null) window.clearTimeout(chamberContactTimer.current)
    if (chamberReflowFrame.current !== null) window.cancelAnimationFrame(chamberReflowFrame.current)
    chamberCloseTimer.current = null
    chamberContactTimer.current = null
    chamberReflowFrame.current = null
    setChamberClosing(false)
    setChamberContact(false)
    setChamberReturnFlights([])
    setChamberOpen(false)
  }, [viewerId])
  useEffect(() => {
    if (!viewer?.chamberSlots) return
    for (const file of ['icons/hermit-chamber.png', 'icons/hermit-chamber-loaded.png']) {
      const image = new Image()
      image.src = assetPath(file)
    }
  }, [viewer?.chamberSlots])
  useEffect(() => {
    if (!chamberOpen) return
    const revealChamberCards = () => {
      if (handRevealFrame.current !== null) window.cancelAnimationFrame(handRevealFrame.current)
      handRevealFrame.current = window.requestAnimationFrame(() => {
        handRevealFrame.current = null
        if (handScrollRef.current) handScrollRef.current.scrollLeft = 0
      })
    }
    revealChamberCards()
    window.addEventListener('resize', revealChamberCards)
    return () => {
      window.removeEventListener('resize', revealChamberCards)
      if (handRevealFrame.current !== null) window.cancelAnimationFrame(handRevealFrame.current)
    }
  }, [chamberOpen, viewerId])

  function handCardElements() {
    return Array.from(handRef.current?.children ?? []).filter((element): element is HTMLElement =>
      element instanceof HTMLElement && element.classList.contains('card'))
  }

  function handCardRects(cards: readonly CardInstance[]) {
    const elements = handCardElements()
    return new Map(cards.flatMap((card, index) => {
      const element = elements[index]
      return element instanceof HTMLElement ? [[card.uid, element.getBoundingClientRect()] as const] : []
    }))
  }

  function animateHandReflow(before: Map<string, DOMRect>, cards: readonly CardInstance[]) {
    if (reducedMotion) return
    if (chamberReflowFrame.current !== null) window.cancelAnimationFrame(chamberReflowFrame.current)
    chamberReflowFrame.current = window.requestAnimationFrame(() => {
      chamberReflowFrame.current = null
      const elements = handCardElements()
      cards.forEach((card, index) => {
        const element = elements[index]
        const prior = before.get(card.uid)
        if (!(element instanceof HTMLElement) || !prior) return
        const current = element.getBoundingClientRect()
        element.animate([
          { translate: `${prior.left - current.left}px ${prior.top - current.top}px` },
          { translate: '0 0' },
        ], { duration: CHAMBER_REFLOW_MS, easing: 'cubic-bezier(0.16, 0.8, 0.24, 1)' })
      })
    })
  }

  function closeChamber(after?: () => void) {
    if (chamberCloseTimer.current !== null) window.clearTimeout(chamberCloseTimer.current)
    if (!chamberOpen || reducedMotion || !viewer || viewer.chamber.length === 0) {
      chamberCloseTimer.current = null
      setChamberClosing(false)
      setChamberReturnFlights([])
      setChamberOpen(false)
      after?.()
      return
    }
    const cards = [...viewer.chamber, ...viewer.hand]
    const before = handCardRects(cards)
    const elements = handCardElements()
    const target = chamberTriggerRef.current?.getBoundingClientRect()
    if (!target || elements.length < viewer.chamber.length) {
      setChamberClosing(false)
      setChamberReturnFlights([])
      setChamberOpen(false)
      after?.()
      return
    }
    setChamberContact(false)
    setChamberReturnFlights(viewer.chamber.flatMap((card, index) => {
      const element = elements[index]
      if (!(element instanceof HTMLElement)) return []
      const start = element.getBoundingClientRect()
      return [{
        card,
        left: start.left,
        top: start.top,
        width: start.width,
        height: start.height,
        x: target.left + target.width / 2 - start.left - start.width / 2,
        y: target.top + target.height / 2 - start.top - start.height / 2,
        index,
      }]
    }))
    setChamberClosing(true)
    setChamberOpen(false)
    animateHandReflow(before, viewer.hand)
    const duration = CHAMBER_RETURN_MS + (viewer.chamber.length - 1) * CHAMBER_RETURN_STAGGER_MS
    chamberCloseTimer.current = window.setTimeout(() => {
      chamberCloseTimer.current = null
      setChamberClosing(false)
      setChamberReturnFlights([])
      setChamberContact(true)
      chamberContactTimer.current = window.setTimeout(() => {
        chamberContactTimer.current = null
        setChamberContact(false)
      }, 240)
      after?.()
    }, duration)
  }

  function toggleChamber() {
    if (chamberClosing) return
    if (chamberOpen) closeChamber()
    else if (viewer) {
      const before = handCardRects(viewer.hand)
      setChamberContact(false)
      setChamberOpen(true)
      animateHandReflow(before, [...viewer.chamber, ...viewer.hand])
    }
  }
  useEffect(() => {
    setTriggerHermitLoadUids([])
    setTriggerHermitChamberUids([])
    setTriggerSlimeUids([])
    setTriggerSlimeEnemyUids([])
  }, [pendingTrigger?.id])
  useEffect(() => setDieRelicCardUids([]), [dieRelicPending?.sourceLabel, dieRelicPending?.playerId])
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
  const cardPreviewKey = cardPreview
    ? `${cardPreview.cardUid}\0${cardPreview.copy === true}\0${cardPreview.chamber === true}\0${cardPreview.kind}\0${cardPreview.spendMiracle}\0${cardPreview.enemyUid ?? ''}\0${cardPreview.slimeUids?.join('\0') ?? ''}\0${cardPreview.slimeEnemyUids?.join('\0') ?? ''}\0${cardPreview.cards.map((card) => card.uid).join('\0')}`
    : ''
  const endTurnEffect = onAction ? partyEndTurnAbilities?.[0] : endTurnResolutionAbility(state)
  const endTurnResolving = endTurnEffect !== undefined
  const baseStartAbilities = useMemo(() => state.phase === 'start' && !pendingTrigger
    ? (partyStartTurnAbilities ?? startTurnAbilities(state))
    : [], [partyStartTurnAbilities, pendingTrigger?.id, state])
  const savedStartChoiceKey = savedStartTurnChoices?.map((choice) =>
    `${choice.id}:${choice.enemyUid ?? ''}:${choice.targetPlayerId ?? ''}:` +
    `${choice.guardianModeShift ?? ''}:` +
    `${choice.exhaustUids?.join(',') ?? ''}:` +
    `${choice.shivEnemyUids.join(',')}:${choice.evokeSlots?.join(',') ?? ''}:` +
    `${choice.evokeEnemyUids?.join(',') ?? ''}`).join('\0') ?? ''
  const startAbilityKey = baseStartAbilities.map((ability) =>
    `${ability.id}:${ability.overflowShivs}:${ability.targets?.map((target) => target.uid).join(',') ?? ''}:` +
    `${ability.players?.map((player) => player.id).join(',') ?? ''}:` +
    `${ability.exhaustCards?.map((card) => card.uid).join(',') ?? ''}:` +
    `${ability.evokeChoice?.options.map((option) => `${option.slot}:${option.orb}`).join(',') ?? ''}:` +
    `${savedStartTurnEnemyTargets?.[ability.id] ?? ''}`).join('\0') + `\0${savedStartChoiceKey}`

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
    animateOpeningHand,
    authoritativeRestoration,
    authoritativeConnected,
    prefersReducedMotion,
  )
  const livePresentationEvents = livePresentation.events
  const targetPresentationTimings = new Map(state.enemies.map((enemy) => [
    enemy.uid,
    targetPresentationTiming(state, enemy.uid, livePresentation.contactDeadlines),
  ]))
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
          ? orbVfxRecipe(event.orb)
          : event.kind === 'shiv'
            ? shivVfxRecipe()
            : cardVfxRecipe(actor.character, event.sourceId, event.mode, event.upgraded, event.resolvedType),
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
  useEffect(() => {
    const uid = slimeCardZoom?.card.uid
    if (!uid) return
    const commanding = livePresentationEvents.some((event) => event.kind === 'slime' && event.slimeUid === uid)
    const stillPresent = state.players.some((player) => player.slimes.some((slime) => slime.card.uid === uid))
    if (commanding || !stillPresent) {
      releaseCardZoom(closeSlimeCardZoom.current)
      setSlimeCardZoom(null)
    }
  }, [livePresentationEvents, slimeCardZoom?.card.uid, state.players])
  // The enemy phase stays open until the prior player attacks clear, so bosses
  // start after that shared presentation window while player attacks remain concurrent.
  const characterAttacksActive = !prefersReducedMotion && (
    activeVfx.some(isCharacterAttack) || livePresentationEvents.some((event) => event.kind === 'slime'))
  const [characterAttacks, setCharacterAttacks] = useState<Record<string, CharacterAttackMotion[]>>({})
  const [slimeCommandMotions, setSlimeCommandMotions] = useState<Record<string, {
    seq: number
    x: number
    y: number
  }>>({})
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
        if (event.actorId !== player.id || event.kind === 'orb' || event.kind === 'slime' ||
          event.sourceId === 'fairy_in_a_bottle') return latest
        const recipe = event.kind === 'potion'
          ? potionVfxRecipe(event.sourceId)
          : event.kind === 'shiv'
            ? shivVfxRecipe()
            : cardVfxRecipe(player.character, event.sourceId, event.mode, event.upgraded, event.resolvedType)
        return isCharacterAttack({ event, recipe }) ? latest : Math.max(latest, event.seq)
      }, -1)
      const latestAttackSeq = (state.presentationEvents ?? []).reduce((latest, event) => {
        if (event.actorId !== player.id || event.kind === 'potion' || event.kind === 'orb' ||
          event.kind === 'slime') return latest
        const recipe = event.kind === 'shiv'
          ? shivVfxRecipe()
          : cardVfxRecipe(player.character, event.sourceId, event.mode, event.upgraded, event.resolvedType)
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
  useLayoutEffect(() => {
    const board = boardRef.current
    const commands = livePresentationEvents.filter((event) => event.kind === 'slime')
    if (!board || prefersReducedMotion || commands.length === 0) {
      setSlimeCommandMotions((current) => Object.keys(current).length === 0 ? current : {})
      return
    }
    const next: typeof slimeCommandMotions = {}
    for (const event of commands) {
      const row = board.querySelector<HTMLElement>(`.seat[data-player-id="${CSS.escape(event.actorId)}"]`)?.closest('.row')
      const actor = row?.querySelector<HTMLElement>(`.slime-party__actor[data-slime-uid="${CSS.escape(event.slimeUid)}"]`)
      const target = event.enemyIds.flatMap((id) => {
        const portrait = board.querySelector<HTMLElement>(`.enemy[data-enemy-id="${CSS.escape(id)}"] .enemy__portrait`)
        return portrait ? [portrait] : []
      })[0] ?? board.querySelector<HTMLElement>('.enemy:not(.enemy--dead) .enemy__portrait')
      if (!actor) continue
      const actorRect = actor.getBoundingClientRect()
      const targetRect = target?.getBoundingClientRect()
      next[`${event.actorId}:${event.slimeUid}`] = {
        seq: event.seq,
        x: targetRect ? Math.max(0, targetRect.left - actorRect.right + actorRect.width * 0.22) : 0,
        y: targetRect ? targetRect.bottom - actorRect.bottom : 0,
      }
    }
    setSlimeCommandMotions(next)
  }, [livePresentationEvents, prefersReducedMotion, stageScale])
  useCombatSoundEffects(state, viewerId, animateOpeningHand, authoritativeRestoration, authoritativeConnected)

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
    const activeDrag = cardDragStart.current
    const draggedCards = activeDrag?.chamber ? next.chamber : next.hand
    if (activeDrag && (restored || !draggedCards.some((card) => card.uid === activeDrag.card.uid) ||
      !(activeDrag.chamber ? chamberCardCanStartDrag(activeDrag.card) : cardCanStartDrag(activeDrag.card)))) {
      clearCardDrag()
    }

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
      if (!reducedMotion) setCardFlights((current) => [...current, { beat, card: armed.card, destination }])
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
        if (!used && activePowerWindow(state) && !state.startTurnProgress?.forcedCard &&
          current.powers.some((held) => held.uid === power.powerUid)) setPendingPowerUid(power.powerUid)
      }
    }
    const card = unknownCardAction.current
    const cardCommitted = card?.source === 'copy'
      ? state.pendingCardCopy?.card.uid !== card.cardUid ||
        (card.copiesBefore !== undefined && state.pendingCardCopy.sourceNames.length < card.copiesBefore)
      : current && !(card?.source === 'chamber' ? current.chamber : current.hand)
        .some((held) => held.uid === card?.cardUid)
    if (card && ((authoritativeRefresh !== undefined && authoritativeRefresh > card.refreshAttempt) || cardCommitted)) {
      if (shouldDisarmCardFlight(card.source !== 'copy', cardCommitted === true)) armedCardFlight.current = null
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

  // Local actions receive their authoritative state through onChange too. Keep
  // the lock until that render lands, or a rapid second Power can resolve from
  // the stale board and overwrite the first result.
  useEffect(() => {
    if (onAction || !powerActionPending.current) return
    powerActionPending.current = false
    setUsingPower(false)
  }, [onAction, state])

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
    setSpendingSoulburn(false)
    setPendingPotion(null)
    setPendingPowerUid(null)
    setPotionShivEnemyUids([])
    setPotionOverflowRequired(0)
  }, [state.phase, state.pendingCardCopy?.playerId, viewerId, pendingTrigger?.id])

  useEffect(() => {
    if (!endTurnResolving) return
    setPending(null)
    setMiracleOnCard(false)
    setSpendingShiv(false)
    setSpendingSoulburn(false)
    setPendingPotion(null)
    setPendingPowerUid(null)
    setPotionShivEnemyUids([])
    setPotionOverflowRequired(0)
  }, [endTurnResolving])

  useEffect(() => {
    setArmedEndTurnAbilityId(null)
  }, [endTurnEffect?.id])

  // A private reveal is room state, not transient component state: restore it
  // after a reconnect so the player must finish the card they already saw.
  useEffect(() => {
    if (!cardPreview || !viewer) {
      if (onAction) setPending((current) => current?.choiceCards &&
        current.choice?.kind !== 'recover' && current.choice?.kind !== 'recoverExhaust' &&
        current.choice?.kind !== 'load' && current.choice?.kind !== 'loadAny' ? null : current)
      return
    }
    if (usingCard) return
    const copied = cardPreview.copy === true && state.pendingCardCopy?.playerId === viewer.id
    const chamber = cardPreview.chamber === true
    const card = copied
      ? state.pendingCardCopy!.card
      : (chamber ? viewer.chamber : viewer.hand).find((held) => held.uid === cardPreview.cardUid)
    if (!card) {
      if (onAction) setPending((current) => current?.choiceCards &&
        current.choice?.kind !== 'recover' && current.choice?.kind !== 'recoverExhaust' &&
        current.choice?.kind !== 'load' && current.choice?.kind !== 'loadAny' ? null : current)
      return
    }
    const requiredChamber = state.pendingHermitChamberPlays?.[0]
    const staged = chamber ? stageHermitChamberViewer(viewer, card,
      requiredChamber?.playerId === viewer.id && requiredChamber.cardUids[0] === card.uid &&
      requiredChamber.free === true) : null
    const next = { ...pendingFor(staged?.card ?? card, cardPreview.cards, state, staged?.player ?? viewer,
      staged ? false : !copied, copied ? state.pendingCardCopy?.energySpent : undefined, staged ? true : undefined)
      , chamberPlay: chamber }
    if (next.choice?.kind !== cardPreview.kind) return
    setMiracleOnCard(cardPreview.spendMiracle)
    const restored = { ...next, enemyUid: cardPreview.enemyUid,
      ...(cardPreview.energySpent === undefined ? {} : {
        energySpent: cardPreview.energySpent,
        effectEnergy: cardPreview.energySpent,
        energyCharged: copied ? 0 : cardPreview.energySpent,
      }),
      slimeUids: cardPreview.slimeUids ?? [], slimeEnemyUids: cardPreview.slimeEnemyUids ?? [] }
    setPending((current) => current?.card.uid === card.uid &&
      current.choice?.kind === cardPreview.kind &&
      current.enemyUid === cardPreview.enemyUid &&
      current.slimeUids.join('\0') === (cardPreview.slimeUids ?? []).join('\0') &&
      current.slimeEnemyUids.join('\0') === (cardPreview.slimeEnemyUids ?? []).join('\0') &&
      current.choiceCards?.length === cardPreview.cards.length &&
      current.choiceCards?.every((held, index) => held.uid === cardPreview.cards[index]?.uid)
      ? current : restored)
  }, [cardPreviewKey, viewerId, usingCard, onAction])

  useEffect(() => {
    if (powerPreview) {
      setPendingPowerUid(powerPreview.powerUid)
      setPowerChoiceCards(powerPreview.cards)
    } else if (onAction) {
      setPowerChoiceCards(null)
      setPowerScryDiscardUids([])
      setPowerGemContext(null)
      setPowerScryConfirmed(false)
    }
  }, [powerPreview?.powerUid, powerPreview?.cards.map((card) => card.uid).join('\0'), onAction])

  useEffect(() => {
    const copy = state.pendingCardCopy
    if (state.phase !== 'copy' || !copy || copy.playerId !== viewerId || !viewer || cardPreview || usingCard) return
    const def = faceOf(cardDef(copy.card.defId), copy.card.upgraded)
    if (cardNeedsChoicePreview(def, state, viewer)) {
      if (cardNeedsEnemy(def, viewer, false, copy.energySpent, false, copy.card.attachedGemId, copy.card.uid,
        copy.energySpent, copy.card.hermitDeadOn === true)) {
        setPending({ ...pendingFor(copy.card, null, state, viewer, false, copy.energySpent), choice: null, choiceCards: null })
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
  const itemModalOpen = ['liquid_memories', 'liquid_void', 'transforming_brew', 'purity_potion', 'entropic_brew'].includes(pendingPotion ?? '') ||
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
      if (current.chamberPlay
        ? !viewer.chamber.some((card) => card.uid === current.card.uid)
        : current.cardInHand
          ? !viewer.hand.some((card) => card.uid === current.card.uid)
          : state.pendingCardCopy?.playerId !== viewer.id || state.pendingCardCopy.card.uid !== current.card.uid) return null
      const def = faceOf(cardDef(current.card.defId), current.card.upgraded)
      if (current.cardInHand && !cardPlayConditionMet(def, state, viewer, drawCount)) return null
      const recover = def.effects.find((effect) => effect.kind === 'recoverDiscard')
      const recoverExhaust = def.effects.find((effect) => effect.kind === 'recoverExhaust' ||
        effect.kind === 'recoverExhaustToDraw' || effect.kind === 'recoverExhaustToDiscard')
      const recoveryCards = recover ? viewer.discard : recoverExhaust ? viewer.exhaust : null
      if ((recover || recoverExhaust) && recoveryCards?.length === 0) return null
      const choice = recover
        ? viewer.discard.length > 0 ? { kind: 'recover' as const, amount: recover.amount } : null
        : recoverExhaust
          ? viewer.exhaust.length > 0
            ? { kind: 'recoverExhaust' as const, amount: recoverExhaust.amount,
              minimum: recoverExhaust.kind === 'recoverExhaustToDraw' ? 0 : undefined }
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
      const selectedEnemyChoices = cardEnemyChoiceCount(def, current.mode ?? undefined, state, viewer)
      const mode = selectedMode?.effects.some((effect) => effect.kind === 'hitChoices' && effect.distinct) &&
        selectedEnemyChoices > alive.size ? null : current.mode
      const enemyChoices = cardEnemyChoiceCount(def, mode ?? undefined, state, viewer)
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
      const powerBeamCards = guardianPowerBeamCards(viewer, current.card.uid)
      const guardianPowerCardUid = current.guardianPowerCardUid &&
        powerBeamCards.some((card) => card.uid === current.guardianPowerCardUid)
        ? current.guardianPowerCardUid : null
      const minimumUnpaid = current.choice?.kind === 'exhaustAny' && current.choiceConfirmed &&
        picked.length < Math.min(current.choice.minimum ?? 0,
          Math.max(0, viewer.hand.length - Number(current.cardInHand)))
      const shivEnemyUids = overflowChanged || spentChanged
        ? []
        : current.shivEnemyUids.filter((uid) => alive.has(uid))
      const needsEnemy = cardNeedsEnemy(def, viewer, false, current.effectEnergy ?? undefined,
        false, current.card.attachedGemId, current.card.uid,
        current.energyCharged ?? undefined, current.card.hermitDeadOn === true) || spentShivs > 0 ||
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
        guardianPowerCardUid === current.guardianPowerCardUid &&
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
        guardianPowerCardUid,
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
    if (state.phase !== 'player') setArmedEndTurnAbilityId(null)
    if (state.phase !== 'start') {
      setStartTurnOrder([])
      setStartTurnEnemyTargets({})
      setStartTurnPlayerTargets({})
      setStartTurnExhaustUids({})
      setStartTurnModeShifts({})
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
    setStartTurnExhaustUids(Object.fromEntries(baseStartAbilities.map((ability) => [
      ability.id, savedChoices.get(ability.id)?.exhaustUids?.[0],
    ])))
    setStartTurnModeShifts(Object.fromEntries(baseStartAbilities.map((ability) => [
      ability.id, savedChoices.get(ability.id)?.guardianModeShift,
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
        !card.retainThisTurn && !cardHasRetain(viewer, card)).map((card) => card.uid) ?? [],
    })
    const top = savedDiscardOrder.at(-1)
    if (top) setDiscardTops({ [viewerId]: top })
  }, [savedDiscardKey, state.phase, viewerId])

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
  const downfallCharacter = DOWNFALL_CHARACTER_IDS.find((character) => character === viewer.character)

  const over = state.phase === 'won' || state.phase === 'lost'
  const pendingPotionDef = pendingPotion ? potionDef(pendingPotion) : null
  const pendingPotionNeedsCards = ['liquid_memories', 'liquid_void', 'transforming_brew', 'purity_potion'].includes(pendingPotion ?? '')
  const pendingPower = pendingPowerUid
    ? viewer.powers.find((power) => power.uid === pendingPowerUid)
    : undefined
  const livingPlayers = state.players.filter((player) => !player.dead)
  const pendingPowerDef = pendingPower ? faceOf(cardDef(pendingPower.defId), pendingPower.upgraded) : null
  const pendingHermitPower = pendingPowerDef?.id === 'hermit_shadow_cloak' || pendingPowerDef?.id === 'hermit_black_wind'
  const pendingPowerNeedsEnemy = Boolean(pendingPower && pendingPowerDef &&
    cardNeedsEnemy(pendingPowerDef, viewer, true, undefined, true, pendingPower.attachedGemId))
  const pendingPowerNeedsAlly = Boolean(pendingPower && pendingPowerDef &&
    guardianCardNeedsAlly(pendingPowerDef, viewer, pendingPower.attachedGemId) && livingPlayers.length > 1)
  const pendingPowerNeedsGemChoice = Boolean(pendingPower?.attachedGemId && (
    pendingPowerNeedsEnemy || pendingPowerNeedsAlly || pendingPowerDef?.target === 'row' ||
    pendingPower.attachedGemId === 'guardian_jasper' || pendingPower.attachedGemId === 'guardian_amethyst'
  ))
  const pendingPotionOverflow = potionOverflowRequired
  const confirmedDiscards = decidedPlayerIds
    ? livingPlayers.filter((player) => decidedPlayerIds.includes(player.id)).length
    : livingPlayers.filter((player) => discardOrders[player.id]).length
  // Online only: hotseat has no per-seat readiness, so one click ends the turn
  // for the table and a counter there would sit at 0 until it vanished.
  const endTurnCount = decidedPlayerIds && livingPlayers.length > 1
    ? `${confirmedDiscards}/${livingPlayers.length}`
    : null
  const chamberCardsVisible = chamberOpen
  const visibleHand = chamberCardsVisible ? [...viewer.chamber, ...viewer.hand] : viewer.hand
  const visibleChamberUids = chamberCardsVisible
    ? new Set(viewer.chamber.map((card) => card.uid))
    : new Set<string>()
  const requiredChamberCard = requiredHermitChamberCard?.playerId === viewer.id
    ? viewer.chamber.find((card) => card.uid === requiredHermitChamberCard.cardUids[0])
    : undefined
  const requiredChamberStaged = requiredChamberCard
    ? stageHermitChamberViewer(viewer, requiredChamberCard, requiredHermitChamberCard?.free)
    : undefined
  const requiredChamberUnplayable = requiredChamberStaged
    ? !canAfford(state, requiredChamberStaged.player, requiredChamberStaged.card)
    : false
  const discardableHand = viewer.hand.filter((card) =>
    !card.endTurnProtected && !card.retainThisTurn && !cardHasRetain(viewer, card))
  const retainAllowance = viewer.retainCardsThisTurn ?? 0
  const viewerRetainedCards = (retainedCards[viewer.id] ?? [])
    .filter((uid) => discardableHand.some((card) => card.uid === uid))
    .slice(0, retainAllowance)
  const retainedSet = new Set(viewerRetainedCards)
  const discardCandidates = discardableHand.filter((card) => !retainedSet.has(card.uid))
  const viewerDiscardTop = discardTops[viewer.id] && discardCandidates.some((card) => card.uid === discardTops[viewer.id])
    ? discardTops[viewer.id]
    : discardCandidates.at(-1)?.uid ?? ''
  const canResolveEndTurn = endTurnEffect?.playerId === viewer.id
  const endTurnChoiceTargets = canResolveEndTurn
    ? endTurnEffect?.targets?.filter((target) => target.uid === 'use' || target.uid === 'skip' ||
      viewer.hand.some((card) => card.uid === target.uid)) ?? []
    : []
  const endTurnEffectPrompt = endTurnChoiceTargets.length > 0
    ? `Choose how to resolve ${endTurnEffect?.label}`
    : endTurnEffect?.rowTiebreak
    ? `Drag ${endTurnEffect.label} to a minion to choose its row`
    : endTurnEffect?.orbChoice
      ? `Drag a highlighted Orb to ${endTurnEffect.label}`
      : `Drag ${endTurnEffect?.label} to a highlighted enemy`
  const endTurnEffectVisual = endTurnEffect?.visual
  const endTurnEffectCard = endTurnEffectVisual?.kind === 'card' && endTurnEffect
    ? state.players.find((player) => player.id === endTurnEffect.playerId)
      ?.powers.find((power) => power.uid === endTurnEffectVisual.cardUid)
    : undefined
  const endTurnEffectSlimeAsset = endTurnEffectVisual?.kind === 'slime'
    ? assetPath(`combat/slimes/${slimeAssetSlug(endTurnEffectVisual.cardId)}.webp`)
    : undefined
  const endTurnEffectDragVisual = endTurnEffectDrag?.ability.visual
  const endTurnEffectDragCard = !endTurnEffectDrag?.sourceOrb && endTurnEffectDragVisual?.kind === 'card' && endTurnEffectDrag
    ? state.players.find((player) => player.id === endTurnEffectDrag.ability.playerId)
      ?.powers.find((power) => power.uid === endTurnEffectDragVisual.cardUid)
    : undefined
  const endTurnEffectDragSlimeAsset = !endTurnEffectDrag?.sourceOrb && endTurnEffectDragVisual?.kind === 'slime'
    ? assetPath(`combat/slimes/${slimeAssetSlug(endTurnEffectDragVisual.cardId)}.webp`)
    : undefined

  function showSlimeCard(card: CardInstance, target: HTMLElement) {
    if (!tryClaimCardZoom(closeSlimeCardZoom.current)) return
    const tile = target.getBoundingClientRect()
    const width = 190
    const height = width * 4 / 3
    const margin = 8
    const above = tile.top - height - margin
    setSlimeCardZoom({
      card,
      x: Math.min(Math.max(margin, tile.left), window.innerWidth - width - margin),
      y: above >= margin ? above : Math.min(tile.bottom + margin, window.innerHeight - height - margin),
    })
  }

  function hideSlimeCard() {
    releaseCardZoom(closeSlimeCardZoom.current)
    setSlimeCardZoom(null)
  }
  const startIds = useMemo(() => startTurnOrder.length === baseStartAbilities.length
    ? startTurnOrder
    : baseStartAbilities.map((ability) => ability.id), [baseStartAbilities, startTurnOrder])
  const startChoiceDrafts: StartTurnChoice[] = useMemo(() => startIds.map((id) => ({
    id,
    enemyUid: startTurnEnemyTargets[id],
    targetPlayerId: startTurnPlayerTargets[id],
    exhaustUids: startTurnExhaustUids[id] ? [startTurnExhaustUids[id]!] : undefined,
    guardianModeShift: startTurnModeShifts[id],
    shivEnemyUids: (startTurnTargets[id] ?? [])
      .filter((uid): uid is string | null => uid !== undefined),
    evokeSlots: startTurnEvokeSlots[id] ?? [],
    evokeEnemyUids: (startTurnEvokeTargets[id] ?? [])
      .filter((uid): uid is string | null => uid !== undefined),
  })), [startIds, startTurnEnemyTargets, startTurnEvokeSlots, startTurnEvokeTargets,
    startTurnExhaustUids, startTurnModeShifts, startTurnPlayerTargets, startTurnTargets])
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
      if (ability.exhaustCards && !ability.exhaustCards.some((card) =>
        card.uid === startTurnExhaustUids[ability.id])) return [{ kind: 'exhaust', ability }]
      if (ability.guardianModeShift && startTurnModeShifts[ability.id] === undefined) {
        return [{ kind: 'guardianModeShift', ability }]
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
  const pendingStartExhaust = pendingStartChoice?.kind === 'exhaust' ? pendingStartChoice.ability : undefined
  const pendingStartModeShift = pendingStartChoice?.kind === 'guardianModeShift'
    ? pendingStartChoice.ability : undefined
  const pendingStartShiv = pendingStartChoice?.kind === 'shiv' ? pendingStartChoice : undefined
  const pendingStartEvokeTarget = pendingStartChoice?.kind === 'evokeTarget' ? pendingStartChoice : undefined
  const pendingStartEvoke = pendingStartChoice?.kind === 'evoke' ? pendingStartChoice.ability : undefined
  const pendingStartEvokeRows = pendingStartEvokeTarget?.ability.evokeTargets?.flatMap((target) => {
    const row = lightningRowFromTarget(target.uid)
    return row === null ? [] : [{ row, uid: target.uid }]
  }) ?? []
  const startTurnReady = orderedStartAbilities.length === baseStartAbilities.length &&
    !pendingStartEnemy && !pendingStartPlayer && !pendingStartExhaust && !pendingStartModeShift && !pendingStartShiv &&
    !pendingStartEvokeTarget && !pendingStartEvoke
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
    setStartTurnExhaustUids({})
    setStartTurnModeShifts({})
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

  function chooseStartTurnExhaust(cardUid: string) {
    if (!pendingStartExhaust?.exhaustCards?.some((card) => card.uid === cardUid) || !canResolveStartTurn) return
    setStartTurnExhaustUids({ ...startTurnExhaustUids, [pendingStartExhaust.id]: cardUid })
  }

  function chooseStartTurnModeShift(shift: boolean) {
    if (!pendingStartModeShift || !canResolveStartTurn) return
    setStartTurnModeShifts({ ...startTurnModeShifts, [pendingStartModeShift.id]: shift })
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
      exhaustUids: startTurnExhaustUids[ability.id] ? [startTurnExhaustUids[ability.id]!] : undefined,
      guardianModeShift: startTurnModeShifts[ability.id],
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
    if (!autoAdvance || voluntaryActionsBlocked || state.phase !== 'enemy' && state.phase !== 'roundEnd') return undefined
    if (state.phase === 'enemy' && characterAttacksActive) return undefined
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
    }, 730)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [autoAdvance, autoAdvanceRetry, authoritativeRefresh, characterAttacksActive, state.phase, state.turn,
    voluntaryActionsBlocked])

  function finishTurn() {
    if (chamberClosing) return
    if (chamberOpen) {
      closeChamber(finishTurnNow)
      return
    }
    finishTurnNow()
  }

  function finishTurnNow() {
    if (!viewer) return
    if (pending?.choiceCards) return
    if (state.phase === 'player') {
      if (endTurnResolving) return
      if (onAction) onAction({ kind: 'endTurn' })
      else {
        const next = beginEndTurnResolution(state)
        if (next !== state) onChange?.(next)
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
  const viewerHasLegalAction = !voluntaryActionsBlocked && (viewer.hand.some((card) => canAfford(state, viewer, card, false, drawCount)) ||
    viewer.chamber.some(chamberCardCanStartDrag) ||
    viewer.shivs > 0 || viewer.soulburn > 0 || viewer.miracles > 0 && viewer.energy < CAPS.energy && (
      viewer.relics.some((relic) => relic.defId === 'ice_cream') ||
      viewer.hand.some((card) => canAfford(state, viewer, card, true, drawCount))) ||
    viewer.potions.some((potionId) => canActivatePotion(state, viewer, potionId)) ||
    viewer.powers.some((power) => {
      const def = faceOf(cardDef(power.defId), power.upgraded)
      return Boolean(def.activeAbility) && (!def.oncePerTurn || !powerAbilityUsed(state, viewer.id, power.uid))
    }) ||
    viewer.relics.some((_, relicIndex) => canActivateRelic(state, viewer, relicIndex)) || courierAvailable)
  useEffect(() => {
    if (onAction || !autoAdvance || state.players.length !== 1 || state.phase !== 'player' ||
      viewer.dead || viewerHasLegalAction || voluntaryActionsBlocked || forcedCard || distilled || pending || pendingTrigger ||
      endTurnResolving) return undefined
    const timer = window.setTimeout(finishTurn, 450)
    return () => window.clearTimeout(timer)
  }, [autoAdvance, state.phase, state.turn, state.players.length, viewer.dead, viewerHasLegalAction,
    forcedCard, distilled, pending, pendingTrigger, endTurnResolving, voluntaryActionsBlocked])

  function reconciliation(outcome: ActionOutcome | void) {
    const snapshot = outcome?.snapshot
    if (!snapshot?.run?.combat || snapshot.version < versionRef.current) return null
    const combat = snapshot.version === versionRef.current ? stateRef.current : snapshot.run.combat
    const player = combat.players.find((candidate) => candidate.id === viewerId)
    return (activePowerWindow(combat) || combat.phase === 'copy') && player ? { combat, player } : null
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
    const result = onAction && powerChoiceCards ? undefined : activatePower(state, viewer!.id, powerUid, context)
    if (result === state) return
    powerActionPending.current = true
    setUsingPower(true)
    setPendingPowerUid(null)
    setPowerChamberUids([])
    setPowerLoadUids([])
    setPowerChoiceCards(null)
    setPowerScryDiscardUids([])
    setPowerExhaustUids([])
    setPowerGemContext(null)
    setPowerScryConfirmed(false)
    if (!onAction) {
      onChange?.(result!)
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

  function choosePowerContext(context: PowerContext) {
    if (pendingPowerDef?.id !== 'guardian_gem_finder' || !pendingPower?.attachedGemId) {
      usePower(pendingPowerUid!, context)
      return
    }
    if (!pendingPowerNeedsGemChoice || powerScryConfirmed) {
      usePower(pendingPowerUid!, { ...context, scryDiscardUids: powerScryDiscardUids })
    } else setPowerGemContext(context)
  }

  function confirmPowerScry() {
    const scry = { scryDiscardUids: powerScryDiscardUids }
    if (!pendingPower?.attachedGemId || !pendingPowerNeedsGemChoice) {
      usePower(pendingPowerUid!, scry)
    } else if (powerGemContext) {
      usePower(pendingPowerUid!, { ...powerGemContext, ...scry })
    } else setPowerScryConfirmed(true)
  }

  function requestPowerPreview(powerUid: string) {
    if (!onAction) {
      const preview = previewPowerChoice(state, viewer!.id, powerUid)
      if (!preview) return
      setPendingPowerUid(powerUid)
      setPowerChoiceCards(preview.cards)
      return
    }
    void Promise.resolve(onAction({ kind: 'previewPowerChoice', powerUid })).then((outcome) => {
      const preview = outcome?.snapshot?.powerPreview
      if (!preview || preview.powerUid !== powerUid) return
      setPendingPowerUid(powerUid)
      setPowerChoiceCards(preview.cards)
    })
  }

  function resolveTrigger(enemyRow?: number, enemyUid?: string, targetPlayerId?: string,
    slimeEnemyUids = triggerSlimeEnemyUids) {
    const trigger = pendingTrigger
    if (usingTrigger || !trigger || trigger.playerId !== viewer?.id) return
    const triggerChoices = trigger.hermitChoices || trigger.slimeChoice || triggerSlimeEnemyAmount > 0 ? {
      ...(trigger.hermitChoices ? {
        loadUids: triggerHermitLoadUids,
        chamberUids: triggerHermitChamberUids,
        hermitEnemyUids: enemyUid ? [enemyUid] : [],
      } : {}),
      ...(trigger.slimeChoice ? { slimeUids: triggerSlimeUids } : {}),
      ...(triggerSlimeEnemyAmount > 0 ? { slimeEnemyUids } : {}),
    } : undefined
    if (!onAction) {
      const result = resolvePendingTrigger(state, viewer!.id, trigger.id, enemyRow, enemyUid, targetPlayerId, triggerChoices)
      if (result === state) return
      onChange?.(result)
      return
    }
    setUsingTrigger(true)
    Promise.resolve(onAction({
      kind: 'resolveTrigger', triggerId: trigger.id, enemyRow, enemyUid, targetPlayerId,
      hermitChoices: trigger.hermitChoices ? triggerChoices : undefined,
      slimeUids: trigger.slimeChoice ? triggerSlimeUids : undefined,
      slimeEnemyUids: triggerSlimeEnemyAmount > 0 ? slimeEnemyUids : undefined,
      preflight: true,
    }))
      .finally(() => setUsingTrigger(false))
  }
  // Ordinary costs choose from the visible hand minus the card being played.
  // Post-draw costs choose from the private preview, which already models the
  // hand at the exact clause where the engine will charge it.
  const choicePoolSize = pending?.choiceCards?.length ??
    Math.max(0, viewer.hand.length - Number(pending?.cardInHand ?? true))
  const variableMinimum = Math.min(pending?.choice?.minimum ?? 0, choicePoolSize)
  const choiceNeeded = pending?.choice && pending.choice.kind !== 'scry' && pending.choice.kind !== 'scryToHand' &&
    pending.choice.kind !== 'discardAny' && pending.choice.kind !== 'exhaustAny' && pending.choice.kind !== 'loadAny'
    ? Math.min(pending.choice.amount, choicePoolSize)
    : 0
  const pendingDef = pending ? faceOf(cardDef(pending.card.defId), pending.card.upgraded) : null
  const pendingSearchKind = pendingDef?.effects.find((effect) =>
    ['overexert', 'replicateSlime'].includes((effect as { kind: string }).kind)) as
      ({ kind: 'overexert' | 'replicateSlime' } | undefined)
  const selectedSearchCard = pending?.choiceCards?.find((card) => pending.picked.includes(card.uid))
  const selectedSearchDef = selectedSearchCard
    ? faceOf(cardDef(selectedSearchCard.defId), selectedSearchCard.upgraded) : undefined
  const selectedSearchType = selectedSearchDef &&
    !(viewer.guardianMode === null && selectedSearchDef.guardian?.printedType === '???')
    ? effectiveCombatCardDef(selectedSearchDef, viewer.guardianMode).type : undefined
  const pendingEffectiveDef = pendingDef
    ? effectiveCombatCardDef(pendingDef, pending?.corruptedShardMode ?? viewer.guardianMode)
    : null
  const pendingPowerBeamCards = pending ? guardianPowerBeamCards(viewer, pending.card.uid) : []
  const pendingPowerBeamChoiceNeeded = pendingDef?.id === 'guardian_power_beam' &&
    (viewer.guardianMode ?? pending?.corruptedShardMode) === 'defense' && pendingPowerBeamCards.length > 0
  const handChoiceSatisfied = pending?.choice?.kind === 'scry' || pending?.choice?.kind === 'scryToHand'
    ? true
    : pending?.choice?.kind === 'discardAny' || pending?.choice?.kind === 'exhaustAny' || pending?.choice?.kind === 'loadAny'
      ? true
    : pending?.choice?.kind === 'recoverExhaust' && pending.choice.minimum === 0
      ? pending.picked.length <= choiceNeeded
    : pending?.choice ? pending.picked.length === choiceNeeded : true
  const revealedChoiceSatisfied = !pending?.choiceCards || pending.choiceConfirmed
  const variableChoiceSatisfied = pending?.choice?.kind !== 'discardAny' && pending?.choice?.kind !== 'exhaustAny' &&
    pending?.choice?.kind !== 'loadAny' ||
    pending.choiceConfirmed && pending.picked.length >= variableMinimum
  const modeSatisfied = !pendingDef?.modes || pending?.mode !== null
  const corruptedShardModeNeeded = pendingDef != null && viewer.character !== 'guardian' &&
    viewer.guardianMode === null && cardReferencesGuardianMode(
      pendingDef, pending ? guardianGemForCard(viewer, pending.card) : undefined,
    )
  const corruptedShardModeSatisfied = !corruptedShardModeNeeded || pending?.corruptedShardMode !== null
  const energyChoiceSatisfied = pendingDef?.cost !== 'X' || pending?.energySpent !== null
  const loadedTargetCount = (next: Pending) => next.picked.filter((uid) => {
    const loaded = next.choiceCards?.find((card) => card.uid === uid) ??
      viewer.hand.find((card) => card.uid === uid) ?? viewer.discard.find((card) => card.uid === uid)
    return loaded && ['hermit_grudge', 'hermit_malice', 'hermit_horror'].includes(loaded.defId)
  }).length
  const hermitDieRelicSelectionsReady = (next: Pending) => next.hermitDieRelics.every((choice) => {
    const owner = state.players.find((player) => player.id === choice.playerId && !player.dead)
    const held = owner?.relics[choice.relicIndex]
    const ability = held && chosenDieRelicAbilities(relicDef(held.defId))[choice.abilityIndex]
    if (!owner || !ability || ability.trigger.kind !== 'dieRelic') return false
    if (ability.supportTarget === 'anyPlayer' &&
      !state.players.some((player) => !player.dead && player.id === choice.targetPlayerId)) return false
    return true
  })
  const chamberChoiceRequired = (next: Pending) => {
    const choice = next.chamberChoice
    if (!choice || choice.baseAmount === undefined || choice.openAfterBase === undefined) return choice?.minimum ?? 0
    const loaded = (next.choice?.kind === 'load' || next.choice?.kind === 'loadAny' ? next.picked.length : 0) +
      Number(choice.loadSelf && next.chooseLoadSelf === true)
    return Math.min(choice.amount, choice.baseAmount + Math.max(0, loaded - choice.openAfterBase))
  }
  const chamberReplacementOptions = (next: Pending): string[] => {
    const choice = next.chamberChoice
    if (!choice || choice.baseAmount === undefined || choice.openAfterBase === undefined) return []
    const base = next.chamberUids.slice(0, choice.baseAmount)
    const baseSet = new Set(base)
    let chamber = viewer.chamber.filter((card) => !baseSet.has(card.uid)).map((card) => card.uid)
    const capacity = chamber.length + choice.openAfterBase
    const loads = [
      ...(next.choice?.kind === 'load' || next.choice?.kind === 'loadAny' ? next.picked : []),
      ...(choice.loadSelf && next.chooseLoadSelf === true ? [next.card.uid] : []),
    ]
    let replacementAt = 0
    for (const uid of loads) {
      if (chamber.length < capacity) chamber.push(uid)
      else {
        const selected = next.chamberUids[choice.baseAmount + replacementAt++]
        if (!selected) return chamber
        const at = chamber.indexOf(selected)
        if (at < 0) return []
        chamber[at] = uid
      }
    }
    return []
  }
  const chamberChoicesReady = (next: Pending) => !next.chamberChoice
    ? true
    : next.chamberChoice.baseAmount === undefined
      ? next.chamberChoiceConfirmed && next.chamberUids.length >= next.chamberChoice.minimum &&
        next.chamberUids.length <= next.chamberChoice.amount
      : chamberChoiceRequired(next) === 0 || next.chamberChoiceConfirmed &&
        next.chamberUids.length === chamberChoiceRequired(next)
  const slimeEnemyChoiceLabels = (next: Pending) => {
    const printed = faceOf(cardDef(next.card.defId), next.card.upgraded)
    const effective = effectiveCombatCardDef(printed, next.corruptedShardMode ?? viewer.guardianMode)
    const selected = effective.modes && next.mode !== null
      ? { ...effective, modes: undefined, effects: effective.modes[next.mode]?.effects ?? [] }
      : effective
    return slimeCommandEnemyChoiceLabels(selected, state, viewer, next.slimeUids,
      next.effectEnergy ?? 0, next.energyCharged ?? 0, next.card)
  }
  const slimeEnemyChoicesRequired = (next: Pending) => slimeEnemyChoiceLabels(next).length
  const downfallChoicesReady = (next: Pending) =>
    (!next.slimeChoice || next.slimeChoiceConfirmed && next.slimeUids.length >= next.slimeChoice.minimum &&
      next.slimeUids.length <= next.slimeChoice.amount) &&
    chamberChoicesReady(next) &&
    next.slimeEnemyUids.length === slimeEnemyChoicesRequired(next) &&
    (!next.hermitDieRelicChoice || next.hermitDieRelicChoiceConfirmed &&
      next.hermitDieRelics.length >= next.hermitDieRelicChoice.minimum &&
      next.hermitDieRelics.length <= next.hermitDieRelicChoice.amount && hermitDieRelicSelectionsReady(next)) &&
    next.hermitEnemyUids.length === loadedTargetCount(next) &&
    next.soulburnEnemyUids.length === next.soulburnChoices &&
    next.chooseLoadSelf !== null && next.spendVigor !== null && next.guardianModeShift !== null &&
    next.secondGuardianModeShift !== null && next.guardianBlockSpend !== null &&
    (next.card.defId !== 'guardian_power_beam' ||
      (viewer.guardianMode ?? next.corruptedShardMode) !== 'defense' ||
      guardianPowerBeamCards(viewer, next.card.uid).length === 0 || next.guardianPowerCardUid !== null)
  const choiceSatisfied = handChoiceSatisfied && revealedChoiceSatisfied && variableChoiceSatisfied &&
    (!pending || downfallChoicesReady(pending)) &&
    modeSatisfied && corruptedShardModeSatisfied && energyChoiceSatisfied
  const pendingNeedsCardEnemy = pendingDef
    ? cardNeedsEnemy(pendingDef.modes && pending?.mode != null
      ? { ...pendingDef, modes: undefined, effects: pendingDef.modes[pending.mode]?.effects ?? [] }
      : pendingDef, viewer, false, pending?.effectEnergy ?? undefined,
      false, pending?.card.attachedGemId, pending?.card.uid, undefined, pending?.card.hermitDeadOn === true)
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
      corruptedShardMode: next.corruptedShardMode ?? undefined,
      discardUids: next.choice?.kind === 'discard' || next.choice?.kind === 'discardAny'
        ? next.picked
        : undefined,
      exhaustUids: next.choice?.kind === 'exhaust' || next.choice?.kind === 'exhaustAny'
        ? next.picked
        : undefined,
      scryDiscardUids: next.choice?.kind === 'scry' || next.choice?.kind === 'scryToHand' ? next.picked : undefined,
      scryToHandUid: next.choice?.kind === 'scryToHand' ? next.scryToHandUid : undefined,
      topdeckUids: next.choice?.kind === 'topdeck' ? next.picked : undefined,
      recoverDiscardUids: next.choice?.kind === 'recover' ? next.picked : undefined,
      recoverExhaustUid: next.choice?.kind === 'recoverExhaust' &&
        pendingDef?.effects.some((effect) => effect.kind === 'recoverExhaust') ? next.picked[0] : undefined,
      recoverExhaustUids: next.choice?.kind === 'recoverExhaust' &&
        pendingDef?.effects.some((effect) => effect.kind === 'recoverExhaustToDraw' ||
          effect.kind === 'recoverExhaustToDiscard') ? next.picked : undefined,
      searchDrawUids: next.choice?.kind === 'search' ? next.picked : undefined,
      loadUids: next.choice?.kind === 'load' || next.choice?.kind === 'loadAny' ? next.picked : undefined,
      chamberUids: next.chamberChoice ? next.chamberUids : undefined,
      hermitEnemyUids: next.hermitEnemyUids,
      hermitDieRelics: next.hermitDieRelicChoice ? next.hermitDieRelics : undefined,
      chooseLoadSelf: next.chooseLoadSelf === true,
      slimeUids: next.slimeChoice ? next.slimeUids : undefined,
      slimeEnemyUids: next.slimeEnemyUids,
      soulburnEnemyUids: next.soulburnChoices > 0 ? next.soulburnEnemyUids : undefined,
      spendVigor: next.spendVigor ?? undefined,
      guardianModeShift: next.guardianModeShift === true,
      secondGuardianModeShift: next.secondGuardianModeShift === true,
      guardianBlockSpend: next.guardianBlockSpend ?? undefined,
      guardianPowerCardUid: next.guardianPowerCardUid ?? undefined,
      spendMiracle: miracleOnCard,
      shivEnemyUids: next.shivEnemyUids,
      evokeSlots: next.evokeSlots,
      evokeEnemyUids: next.evokeEnemyUids as (string | null)[],
    }
    // The online draw pile is redacted. The room has already bound this action
    // to its private preview, so only the authoritative engine can validate it.
    const result = onAction && next.choiceCards
      ? undefined
      : next.chamberPlay
        ? playHermitChamberCard(state, viewer!.id, next.card.uid, context)
        : next.cardInHand
        ? playCard(state, viewer!.id, next.card.uid, context)
        : playCardCopy(state, viewer!.id, context)
    if (result === state) {
      if (next.enemyUids.length > 0 || next.playerIds.length > 0 || next.slimeUids.length > 0 ||
        next.slimeEnemyUids.length > 0 ||
        next.chamberUids.length > 0 || next.hermitEnemyUids.length > 0 || next.soulburnEnemyUids.length > 0 ||
        next.hermitDieRelics.length > 0 || next.shivEnemyUids.length > 0 || next.evokeSlots.length > 0) {
        setPending({ ...next, enemyUids: [], playerIds: [], slimeUids: [], slimeEnemyUids: [], chamberUids: [], hermitEnemyUids: [],
          hermitDieRelics: [], hermitDieRelicChoiceConfirmed: false,
          soulburnEnemyUids: [], shivEnemyUids: [], evokeSlots: [], evokeEnemyUids: [] })
      }
      return
    }
    if (next.cardInHand || next.chamberPlay) {
      armedCardFlight.current = { card: next.card, chamber: next.chamberPlay }
    }
    const action = {
      kind: next.chamberPlay ? 'playHermitChamberCard' : next.cardInHand ? 'playCard' : 'playCardCopy',
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
          const source = next.chamberPlay ? 'chamber' : next.cardInHand ? 'hand' : 'copy'
          const copiesBefore = source === 'copy' ? state.pendingCardCopy?.sourceNames.length : undefined
          const refreshAttempt = outcome.refreshAttempt ?? refreshRef.current
          const committed = source === 'copy'
            ? currentCopy?.card.uid !== next.card.uid ||
              (copiesBefore !== undefined && currentCopy.sourceNames.length < copiesBefore)
            : current && !(source === 'chamber' ? current.chamber : current.hand)
              .some((card) => card.uid === next.card.uid)
          const refreshed = refreshAttempt !== undefined && refreshRef.current !== undefined &&
            refreshRef.current > refreshAttempt
          if (committed || refreshed) {
            if (refreshed && shouldDisarmCardFlight(next.cardInHand || next.chamberPlay, committed === true)) {
              armedCardFlight.current = null
            }
            unlock()
          }
          else if (refreshAttempt !== undefined) {
            unknownCardAction.current = {
              refreshAttempt,
              cardUid: next.card.uid,
              source,
              copiesBefore,
            }
          } else {
            if ((next.chamberPlay ? current?.chamber : current?.hand)
              ?.some((card) => card.uid === next.card.uid)) armedCardFlight.current = null
            unlock()
          }
          return
        }
        unlock()
        if (outcome?.status === 'refused' || outcome?.status === 'reconciled') {
          const authoritative = reconciliation(outcome)
          if (!authoritative) {
            if (shouldDisarmCardFlight(next.cardInHand || next.chamberPlay, false)) armedCardFlight.current = null
            return
          }
          if (next.chamberPlay
            ? !authoritative.player.chamber?.some((card) => card.uid === next.card.uid)
            : next.cardInHand
              ? !authoritative.player.hand?.some((card) => card.uid === next.card.uid)
              : authoritative.combat.pendingCardCopy?.card.uid !== next.card.uid) return
          if (next.cardInHand || next.chamberPlay) armedCardFlight.current = null
          const authoritativePlayer: Player = {
            ...viewer!,
            ...authoritative.player,
            deck: authoritative.player.deck ?? viewer!.deck,
            draw: viewer!.draw,
            hand: authoritative.player.hand ?? viewer!.hand,
            chamber: authoritative.player.chamber ?? [],
            cardRewards: viewer!.cardRewards,
            rareRewards: viewer!.rareRewards,
          }
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
              choice: cards.length > 0 ? { kind: next.choice.kind, amount: next.choice.amount,
                minimum: next.choice.minimum } : null,
              choiceCards: cards.length > 0 ? cards : null,
              choiceConfirmed: false,
              picked: [],
              enemyUid: null,
            })
            return
          }
          if (next.choiceCards) {
            setMiracleOnCard(usingMiracle)
            if (next.chamberPlay) requestChamberChoicePreview(next.card, next.enemyUid, next)
            else if (next.cardInHand) requestChoicePreview(next.card, next.enemyUid, next)
            else requestCopyChoicePreview(next.enemyUid)
            return
          }
          const chamberCard = next.chamberPlay
            ? authoritativePlayer.chamber.find((card) => card.uid === next.card.uid)
            : undefined
          const pendingPlayer = chamberCard
            ? stageHermitChamberViewer(authoritativePlayer, chamberCard).player
            : authoritativePlayer
          const def = effectiveCombatCardDef(
            faceOf(cardDef(next.card.defId), next.card.upgraded), pendingPlayer.guardianMode,
          )
          const overflowShivs = overflowShivCount(authoritative.combat,
            cardShivsOnPlay(def, next.choice?.kind === 'discardAny' ? next.picked.length : 0))
          const spentShivs = cardShivChoiceCount(def, pendingPlayer)
          const enemyChoices = cardEnemyChoiceCount(def, undefined, state, viewer!)
          const playerChoices = cardPlayerChoiceCount(def)
          const physicalCard = next.cardInHand || next.chamberPlay
          const cost = physicalCard ? playCost(def, pendingPlayer, next.card) : 0
          const energySpent = physicalCard ? cost === 'X' ? null : 0
            : authoritative.combat.pendingCardCopy?.energySpent ?? 0
          const effectEnergy = physicalCard && def.cost === 'X' && cost !== 'X' ? cost : energySpent
          const needsEnemy = cardNeedsEnemy(def, pendingPlayer, false, effectEnergy ?? undefined,
            false, next.card.attachedGemId, next.card.uid,
            physicalCard && typeof cost === 'number' ? cost : undefined, next.card.hermitDeadOn === true) || spentShivs > 0 ||
            overflowShivs > 0 || enemyChoices > 0
          const needsAlly = (def.supportTarget === 'anyPlayer' ||
            guardianCardNeedsAlly(def, pendingPlayer, next.card.attachedGemId)) &&
            authoritative.combat.players.filter((player) => !player.dead).length > 1
          const needsSwitch = def.effects.some((effect) => effect.kind === 'switchRows') &&
            authoritative.combat.players.filter((player) => !player.dead).length > 1
          setMiracleOnCard(usingMiracle)
          if (needsEnemy || needsAlly || playerChoices > 0 || needsSwitch || def.modes || next.choice ||
            nextEvokeChoice(def, pendingPlayer, [], undefined, effectEnergy ?? 0)) {
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
        needsEnemy: cardNeedsEnemy(def, viewer!, false, next.effectEnergy ?? undefined, false,
          next.card.attachedGemId, next.card.uid,
          next.energyCharged ?? undefined, next.card.hermitDeadOn === true) || spentShivs > 0 ||
          overflowShivs > 0 || next.enemyChoices > 0,
        shivEnemyUids: [],
      }
      setPending(next)
    }
    const poolSize = next.choiceCards?.length ?? Math.max(0, viewer!.hand.length - Number(next.cardInHand))
    const minimumPaid = next.picked.length >= Math.min(next.choice?.minimum ?? 0, poolSize)
    const owed = next.choice && next.choice.kind !== 'scry' &&
      next.choice.kind !== 'discardAny' && next.choice.kind !== 'exhaustAny' && next.choice.kind !== 'loadAny'
      ? Math.min(next.choice.amount, poolSize)
      : 0
    const selectionReady = next.choice?.kind === 'scry' || next.choice?.kind === 'scryToHand' || next.choice?.kind === 'discardAny' ||
      next.choice?.kind === 'exhaustAny' || next.choice?.kind === 'loadAny' ||
      next.choice?.kind === 'recoverExhaust' && next.choice.minimum === 0 ||
      next.picked.length === owed
    const ready = selectionReady && minimumPaid && (!next.choiceCards || next.choiceConfirmed) &&
      (next.choice?.kind !== 'discardAny' && next.choice?.kind !== 'exhaustAny' && next.choice?.kind !== 'loadAny' ||
        next.choiceConfirmed) && downfallChoicesReady(next) &&
      (!def.modes || next.mode !== null) &&
      !nextEvokeChoice(def, viewer!, next.evokeSlots, next.mode ?? undefined, next.effectEnergy ?? 0) &&
      !next.evokeEnemyUids.some((target) => target === undefined) &&
      (def.cost !== 'X' || next.energySpent !== null) &&
      (!cardNeedsEnemy(def.modes ? { ...def, modes: undefined, effects: def.modes[next.mode!]!.effects } : def,
        viewer!, false, next.effectEnergy ?? undefined, false,
        next.card.attachedGemId, next.card.uid,
        next.energyCharged ?? undefined, next.card.hermitDeadOn === true) || next.enemyUid !== null) &&
      next.enemyUids.length >= next.enemyChoices &&
      next.shivEnemyUids.length >= next.spentShivs + next.overflowShivs &&
      next.playerIds.length >= next.playerChoices &&
      (!next.needsAlly || next.playerId !== null) &&
      (!next.needsSwitch || next.switchChoiceDone)
    if (ready && !next.choiceCards && cardNeedsChoicePreview(def, state, viewer!)) {
      if (next.chamberPlay) requestChamberChoicePreview(next.card, next.enemyUid, next)
      else if (next.cardInHand) requestChoicePreview(next.card, next.enemyUid, next)
      else requestCopyChoicePreview(next.enemyUid, next)
    } else if (ready) commit(next)
    else setPending(next)
  }

  function requestChoicePreview(card: CardInstance, enemyUid: string | null = null,
    selections?: Pick<Pending, 'slimeUids' | 'slimeEnemyUids'>) {
    if (cardActionPending.current) return
    if (!onAction) {
      const preview = previewCardChoice(state, viewer!.id, card.uid)
      if (!preview) return
      const next = { ...pendingFor(card, preview.cards, state, viewer!), enemyUid,
        slimeUids: selections?.slimeUids ?? [], slimeEnemyUids: selections?.slimeEnemyUids ?? [] }
      if (next.choice?.kind === preview.kind) setPending(next)
      return
    }

    cardActionPending.current = true
    setUsingCard(true)
    Promise.resolve(onAction({
      kind: 'previewCard', cardUid: card.uid, spendMiracle: miracleOnCard, enemyUid,
      slimeUids: selections?.slimeUids, slimeEnemyUids: selections?.slimeEnemyUids,
    })).then((outcome) => {
      cardActionPending.current = false
      setUsingCard(false)
      const preview = outcome?.snapshot?.cardPreview
      const current = stateRef.current
      const player = current.players.find((candidate) => candidate.id === viewerId)
      const held = player?.hand.find((candidate) => candidate.uid === card.uid)
      if (outcome?.status !== 'accepted' || !preview || preview.cardUid !== card.uid || !player || !held) return
      const next = { ...pendingFor(held, preview.cards, current, player), enemyUid: preview.enemyUid,
        slimeUids: preview.slimeUids ?? [], slimeEnemyUids: preview.slimeEnemyUids ?? [] }
      if (next.choice?.kind === preview.kind) setPending(next)
    }, () => {
      cardActionPending.current = false
      setUsingCard(false)
    })
  }

  function requestCopyChoicePreview(enemyUid: string | null = null,
    selections?: Pick<Pending, 'energySpent' | 'slimeUids' | 'slimeEnemyUids'>) {
    if (cardActionPending.current || !viewer) return
    const copy = state.pendingCardCopy
    if (!copy || copy.playerId !== viewer.id) return
    if (!onAction) {
      const preview = previewCardCopyChoice(state, viewer.id)
      if (!preview) return
      const next = { ...pendingFor(copy.card, preview.cards, state, viewer, false, copy.energySpent), enemyUid,
        slimeUids: selections?.slimeUids ?? [], slimeEnemyUids: selections?.slimeEnemyUids ?? [] }
      if (next.choice?.kind === preview.kind) setPending(next)
      return
    }
    cardActionPending.current = true
    setUsingCard(true)
    Promise.resolve(onAction({ kind: 'previewCardCopy', cardUid: copy.card.uid, enemyUid,
      slimeUids: selections?.slimeUids, slimeEnemyUids: selections?.slimeEnemyUids })).then((outcome) => {
      cardActionPending.current = false
      setUsingCard(false)
      const current = stateRef.current
      const currentCopy = current.pendingCardCopy
      const player = current.players.find((candidate) => candidate.id === viewerId)
      const preview = outcome?.snapshot?.cardPreview
      if (outcome?.status !== 'accepted' || !preview?.copy || !currentCopy || !player) return
      const next = { ...pendingFor(currentCopy.card, preview.cards, current, player, false,
        currentCopy.energySpent), enemyUid: preview.enemyUid,
        slimeUids: preview.slimeUids ?? [], slimeEnemyUids: preview.slimeEnemyUids ?? [] }
      if (next.choice?.kind === preview.kind) setPending(next)
    }, () => {
      cardActionPending.current = false
      setUsingCard(false)
    })
  }

  function requestChamberChoicePreview(card: CardInstance, enemyUid: string | null = null,
    selections?: Pick<Pending, 'energySpent' | 'slimeUids' | 'slimeEnemyUids'>) {
    if (cardActionPending.current || !viewer) return
    if (!onAction) {
      const preview = previewHermitChamberCardChoice(state, viewer.id, card.uid)
      if (!preview) return
      const required = state.pendingHermitChamberPlays?.[0]
      const staged = stageHermitChamberViewer(viewer, card,
        required?.playerId === viewer.id && required.cardUids[0] === card.uid && required.free)
      const next = { ...pendingFor(staged.card, preview.cards, state, staged.player, false, undefined, true),
        chamberPlay: true, enemyUid,
        ...(selections?.energySpent === null || selections?.energySpent === undefined ? {} : {
          energySpent: selections.energySpent, effectEnergy: selections.energySpent,
          energyCharged: selections.energySpent,
        }),
        slimeUids: selections?.slimeUids ?? [], slimeEnemyUids: selections?.slimeEnemyUids ?? [] }
      if (next.choice?.kind === preview.kind) setPending(next)
      return
    }
    cardActionPending.current = true
    setUsingCard(true)
    Promise.resolve(onAction({ kind: 'previewHermitChamberCard', cardUid: card.uid, enemyUid,
      energySpent: selections?.energySpent ?? undefined,
      slimeUids: selections?.slimeUids, slimeEnemyUids: selections?.slimeEnemyUids })).then((outcome) => {
      cardActionPending.current = false
      setUsingCard(false)
      const current = stateRef.current
      const player = current.players.find((candidate) => candidate.id === viewerId)
      const preview = outcome?.snapshot?.cardPreview
      const held = player?.chamber.find((candidate) => candidate.uid === card.uid)
      if (outcome?.status !== 'accepted' || !preview?.chamber || !player || !held) return
      const required = current.pendingHermitChamberPlays?.[0]
      const staged = stageHermitChamberViewer(player, held,
        required?.playerId === player.id && required.cardUids[0] === held.uid && required.free)
      const next = { ...pendingFor(staged.card, preview.cards, current, staged.player, false, undefined, true), chamberPlay: true,
        enemyUid: preview.enemyUid,
        ...(preview.energySpent === undefined ? {} : { energySpent: preview.energySpent,
          effectEnergy: preview.energySpent, energyCharged: preview.energySpent }),
        slimeUids: preview.slimeUids ?? [], slimeEnemyUids: preview.slimeEnemyUids ?? [] }
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
    if (cardActionPending.current || endTurnResolving || pendingTrigger) return
    setPendingPowerUid(null)
    setSpendingShiv(false)
    setSpendingSoulburn(false)
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
      const next = { ...pending, picked, choiceConfirmed: false, chamberChoiceConfirmed: false }
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
    let next = pendingFor(card, null, state, viewer!)
    const directEnemy = cardNeedsEnemy(
      effectiveCombatCardDef(def, viewer!.guardianMode), viewer!, false, next.effectEnergy ?? undefined,
      false, next.card.attachedGemId, card.uid, chargedCardEnergy(def, viewer!, card), card.hermitDeadOn === true,
    )
    if (cardNeedsChoicePreview(def, state, viewer!)) {
      if (directEnemy || next.slimeChoice || slimeEnemyChoicesRequired(next) > 0) {
        if (draggedEnemyUid) {
          if (directEnemy) next = { ...next, enemyUid: draggedEnemyUid }
          else next = { ...next, slimeEnemyUids: [draggedEnemyUid] }
        }
        stageOrCommit({ ...next, choice: null, choiceCards: null })
        return
      }
      requestChoicePreview(card)
      return
    }
    if (draggedEnemyUid) {
      if (directEnemy) {
        next = { ...next, enemyUid: draggedEnemyUid }
      }
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

  function endTurnTargetForEnemy(enemy: Enemy, ability = endTurnEffect): string | null {
    if (ability?.orbChoice) return null
    if (state.endTurnProgress?.rowTiebreakFor && enemy.isBoss) return null
    return ability?.targets?.find((target) => target.uid === enemy.uid || target.uid.endsWith(`:${enemy.uid}`))?.uid ??
      ability?.targets?.find((target) =>
        target.uid === lightningRowTarget(enemy.row) || target.uid.endsWith(`:${lightningRowTarget(enemy.row)}`))?.uid ?? null
  }

  function endTurnTargetForRow(row: number): string | null {
    return endTurnEffect?.targets?.find((target) =>
      target.uid === lightningRowTarget(row) || target.uid.endsWith(`:${lightningRowTarget(row)}`))?.uid ?? null
  }

  function endTurnTargetForOrb(playerId: string, slot: number, ability = endTurnEffect): string | null {
    return ability?.orbChoice && ability.playerId === playerId
      ? ability.targets?.find((target) => target.uid === `orb:${slot}`)?.uid ?? null
      : null
  }

  function endTurnOrbSourceAt(player: Player, event: React.PointerEvent<HTMLDivElement>) {
    const orb = (event.target as HTMLElement).closest<HTMLElement>('[data-orb-slot]')
    const slot = Number(orb?.dataset.orbSlot)
    const sourceOrb = Number.isInteger(slot) ? player.orbs[slot] : undefined
    const sourceTargetUid = Number.isInteger(slot) ? endTurnTargetForOrb(player.id, slot) : null
    return sourceOrb && sourceTargetUid && orb ? { sourceOrb, sourceTargetUid, element: orb } : null
  }

  function endTurnEffectCardTargetAt(x: number, y: number): boolean {
    return document.elementFromPoint(x, y)?.closest('.end-turn-effect--card') !== null
  }

  function endTurnEffectDragTargetAt(active: EndTurnEffectDrag, x: number, y: number): string | null {
    if (active.sourceTargetUid) return endTurnEffectCardTargetAt(x, y) ? active.sourceTargetUid : null
    const enemyUid = dragTargetAt(x, y, false)
    const enemy = enemyUid ? state.enemies.find((candidate) => candidate.uid === enemyUid) : undefined
    return enemy ? endTurnTargetForEnemy(enemy, active.ability) : null
  }

  function onEndTurnOrbPointerDown(player: Player, event: React.PointerEvent<HTMLDivElement>) {
    const ability = endTurnEffect
    const source = endTurnOrbSourceAt(player, event)
    if (event.button !== 0 || !ability?.orbChoice || !source || !endTurnEffectCanStartDrag(ability.id)) return
    source.element.setPointerCapture(event.pointerId)
    endTurnEffectDragStart.current = {
      ability,
      ...source,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      targetUid: null,
      element: source.element,
    }
  }

  function isEndTurnEnemyTarget(enemy: Enemy): boolean {
    const targetUid = endTurnTargetForEnemy(enemy)
    return targetUid !== null && (endTurnEffectDrag?.targetUid === targetUid ||
      armedEndTurnAbilityId === endTurnEffect?.id)
  }

  function resolveEndTurnTarget(abilityId: string, targetUid: string) {
    if (!endTurnEffect || !canResolveEndTurn || endTurnEffect.id !== abilityId ||
      !endTurnEffect.targets?.some((target) => target.uid === targetUid)) return
    setArmedEndTurnAbilityId(null)
    if (onAction) {
      onAction({ kind: 'resolveEndTurnEffect', abilityId, targetUid })
      return
    }
    const next = resolveEndTurnAbility(state, chooseEndTurnTarget(abilityId, targetUid))
    if (next !== state) onChange?.(next)
  }

  function endTurnEffectCanStartDrag(abilityId: string) {
    return canResolveEndTurn && endTurnEffect?.id === abilityId && !pendingTrigger && !endTurnEffectDrag
  }

  function onEndTurnEffectPointerDown(ability: NonNullable<typeof endTurnEffect>, event: React.PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || !endTurnEffectCanStartDrag(ability.id)) return
    event.currentTarget.setPointerCapture(event.pointerId)
    endTurnEffectDragStart.current = {
      ability,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      targetUid: null,
      element: event.currentTarget,
    }
  }

  function onEndTurnEffectPointerMove(event: React.PointerEvent<HTMLElement>) {
    const start = endTurnEffectDragStart.current
    if (!start || start.pointerId !== event.pointerId) return
    if (!endTurnEffectDragLive.current && Math.hypot(event.clientX - start.startX, event.clientY - start.startY) < 10) return
    endTurnEffectDragMove.current = { x: event.clientX, y: event.clientY }
    if (endTurnEffectDragFrame.current !== null) return
    endTurnEffectDragFrame.current = requestAnimationFrame(() => {
      endTurnEffectDragFrame.current = null
      const active = endTurnEffectDragStart.current
      const move = endTurnEffectDragMove.current
      if (!active || !move) return
      const next: EndTurnEffectDrag = {
        ...active,
        x: move.x,
        y: move.y,
        targetUid: endTurnEffectDragTargetAt(active, move.x, move.y),
      }
      const previous = endTurnEffectDragLive.current
      endTurnEffectDragLive.current = next
      const path = `M ${next.startX} ${next.startY + (next.y < next.startY ? -28 : 28)} Q ${next.startX} ${next.y} ${next.x} ${next.y}`
      endTurnEffectDragArrow.current?.setAttribute('d', path)
      endTurnEffectDragArrowShadow.current?.setAttribute('d', path)
      endTurnEffectDragOverlay.current?.style.setProperty('--effect-drag-x', `${next.x - next.startX}px`)
      endTurnEffectDragOverlay.current?.style.setProperty('--effect-drag-y', `${next.y - next.startY}px`)
      if (!previous || previous.targetUid !== next.targetUid) setEndTurnEffectDrag(next)
    })
  }

  function clearEndTurnEffectDrag() {
    endTurnEffectDragStart.current = null
    endTurnEffectDragLive.current = null
    endTurnEffectDragMove.current = null
    if (endTurnEffectDragFrame.current !== null) cancelAnimationFrame(endTurnEffectDragFrame.current)
    endTurnEffectDragFrame.current = null
    setEndTurnEffectDrag(null)
  }

  function finishEndTurnEffectDrag(event: React.PointerEvent<HTMLElement>) {
    const start = endTurnEffectDragStart.current
    if (!start || start.pointerId !== event.pointerId) return
    const moved = Math.hypot(event.clientX - start.startX, event.clientY - start.startY) >= 10
    const targetUid = endTurnEffectDragTargetAt(start, event.clientX, event.clientY)
    clearEndTurnEffectDrag()
    if (start.element.hasPointerCapture(event.pointerId)) start.element.releasePointerCapture(event.pointerId)
    if (!moved) return
    if (start.sourceTargetUid) {
      suppressEndTurnOrbClick.current = start.sourceTargetUid
      setTimeout(() => {
        if (suppressEndTurnOrbClick.current === start.sourceTargetUid) suppressEndTurnOrbClick.current = null
      }, 0)
    } else {
      suppressEndTurnEffectClick.current = start.ability.id
      setTimeout(() => {
        if (suppressEndTurnEffectClick.current === start.ability.id) suppressEndTurnEffectClick.current = null
      }, 0)
    }
    if (targetUid) resolveEndTurnTarget(start.ability.id, targetUid)
  }

  function cancelEndTurnEffectDrag(event: React.PointerEvent<HTMLElement>) {
    if (endTurnEffectDragStart.current?.pointerId === event.pointerId) clearEndTurnEffectDrag()
  }

  function activateEndTurnEffect(ability: NonNullable<typeof endTurnEffect>) {
    if (suppressEndTurnEffectClick.current === ability.id) {
      suppressEndTurnEffectClick.current = null
      return
    }
    if (!endTurnEffectCanStartDrag(ability.id)) return
    setArmedEndTurnAbilityId((current) => current === ability.id ? null : ability.id)
  }

  function onCardPointerDown(card: CardInstance, event: React.PointerEvent<HTMLButtonElement>, chamber = false) {
    if (event.button !== 0) return
    const canDrag = chamber ? chamberCardCanStartDrag(card) : cardCanStartDrag(card)
    const staged = chamber ? stageHermitChamberViewer(viewer!, card,
      state.pendingHermitChamberPlays?.[0]?.playerId === viewerId &&
      state.pendingHermitChamberPlays[0].cardUids[0] === card.uid &&
      state.pendingHermitChamberPlays[0].free) : null
    const pending = canDrag ? pendingFor(staged?.card ?? card, null, state, staged?.player ?? viewer!,
      false, undefined, chamber) : null
    const scrollElement = event.currentTarget.closest('.hand-scroll') as HTMLDivElement | null
    event.currentTarget.setPointerCapture(event.pointerId)
    cardDragStart.current = {
      card, chamber, pointerId: event.pointerId,
      startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY,
      needsEnemy: pending?.needsEnemy ?? false,
      needsPlayer: pending ? !pending.needsEnemy && (pending.needsAlly || pending.playerChoices > 0) : false,
      hitsRow: pending?.hitsRow ?? false,
      element: event.currentTarget,
      scrollElement,
      scrollLeft: scrollElement?.scrollLeft ?? 0,
      scrolling: false,
      canDrag,
      moved: false,
    }
  }

  function onCardPointerMove(event: React.PointerEvent<HTMLElement>) {
    const start = cardDragStart.current
    if (!start || start.pointerId !== event.pointerId) return
    const dx = event.clientX - start.startX
    const dy = event.clientY - start.startY
    if (Math.hypot(dx, dy) >= 10) start.moved = true
    const verticallyDominant = dy < -10 && -dy >= Math.abs(dx)
    const towardRequiredTarget = dy < -10 && -dy >= Math.abs(dx) * 0.25 &&
      ((start.needsEnemy && dx > 0) || (start.needsPlayer && dx < 0))
    const overRequiredTarget = dy < -10 && !verticallyDominant && !towardRequiredTarget && (start.needsEnemy
      ? Boolean(dragTargetAt(event.clientX, event.clientY, start.hitsRow))
      : start.needsPlayer ? Boolean(dragPlayerAt(event.clientX, event.clientY)) : false)
    const upwardIntent = verticallyDominant || towardRequiredTarget || overRequiredTarget
    if (!cardDragLive.current && start.scrolling) {
      if (upwardIntent) {
        if (start.scrollElement) start.scrollElement.scrollLeft = start.scrollLeft
        start.scrolling = false
      } else {
        if (start.scrollElement) start.scrollElement.scrollLeft = start.scrollLeft - dx
        return
      }
    }
    if (!cardDragLive.current && Math.abs(dx) >= 10 && !upwardIntent && Math.abs(dx) > Math.abs(dy)) {
      start.scrolling = true
      if (start.scrollElement) start.scrollElement.scrollLeft = start.scrollLeft - dx
      return
    }
    if (!start.canDrag) return
    if (!cardDragLive.current &&
      Math.hypot(dx, dy) < 10) return
    cardDragMove.current = { x: event.clientX, y: event.clientY }
    if (cardDragFrame.current !== null) return
    cardDragFrame.current = requestAnimationFrame(() => {
      cardDragFrame.current = null
      const active = cardDragStart.current
      const move = cardDragMove.current
      if (!active || !move) return
      const next: CardDrag = {
        card: active.card,
        chamber: active.chamber,
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
    return !usingCard && !pending && !pendingTrigger && !endTurnResolving && state.phase === 'player' &&
      !forcedCard && !distilled && !relicScry && canAfford(state, viewer!, card, miracleOnCard, drawCount)
  }

  function chamberCardCanStartDrag(card: CardInstance) {
    const required = state.pendingHermitChamberPlays?.[0]
    const staged = stageHermitChamberViewer(viewer!, card,
      required?.playerId === viewerId && required.cardUids[0] === card.uid && required.free)
    return !usingCard && !pending && !pendingTrigger && !endTurnResolving && !forcedCard &&
      state.phase === 'player' && (required?.cardUids[0] === card.uid || !voluntaryActionsBlocked) &&
      canAfford(state, staged.player, staged.card)
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
    const dx = event.clientX - start.startX
    const dy = event.clientY - start.startY
    const needsEnemy = cardDragLive.current?.needsEnemy ?? start.needsEnemy
    const needsPlayer = cardDragLive.current?.needsPlayer ?? start.needsPlayer
    const targetUid = needsEnemy ? dragTargetAt(event.clientX, event.clientY, start.hitsRow) : null
    const targetPlayerId = needsPlayer ? dragPlayerAt(event.clientX, event.clientY) : null
    const releaseUpwardIntent = dy < -10 && (-dy >= Math.abs(dx) || Boolean(targetUid || targetPlayerId))
    const releaseHorizontalIntent = Math.abs(dx) >= 10 && !releaseUpwardIntent && Math.abs(dx) > Math.abs(dy)
    const wasScrolling = releaseHorizontalIntent ||
      (!cardDragLive.current && start.scrolling && !releaseUpwardIntent)
    if (start.scrolling && releaseUpwardIntent && start.scrollElement) {
      start.scrollElement.scrollLeft = start.scrollLeft
    } else if (releaseHorizontalIntent && start.scrollElement) {
      start.scrollElement.scrollLeft = start.scrollLeft - dx
    }
    const moved = start.moved || Math.hypot(dx, dy) >= 10
    const lifted = dy < -10
    clearCardDrag()
    if (start.element.hasPointerCapture(event.pointerId)) start.element.releasePointerCapture(event.pointerId)
    if (!moved) return
    suppressCardClick.current = start.card.uid
    setTimeout(() => {
      if (suppressCardClick.current === start.card.uid) suppressCardClick.current = null
    }, 0)
    if (!start.canDrag || wasScrolling) return
    if (lifted && (!needsEnemy || targetUid) && (!needsPlayer || targetPlayerId)) {
      if (start.chamber) submitHermitChamber(start.card, targetUid, targetPlayerId)
      else onCardClick(start.card, targetUid, targetPlayerId)
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
    const limit = pending.choice.kind === 'loadAny' ? pending.choice.amount : choiceNeeded
    const picked = already
      ? pending.picked.filter((uid) => uid !== card.uid)
      : pending.choice.kind === 'scry' || pending.choice.kind === 'scryToHand'
        ? [...pending.picked, card.uid]
        : [...pending.picked, card.uid].slice(-limit)
    setPending({ ...pending, picked,
      scryToHandUid: pending.scryToHandUid === card.uid ? undefined : pending.scryToHandUid,
      choiceConfirmed: false, chamberChoiceConfirmed: false })
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
    const endTurnTarget = endTurnTargetForEnemy(enemy)
    if (endTurnTarget && armedEndTurnAbilityId === endTurnEffect?.id) {
      resolveEndTurnTarget(endTurnEffect.id, endTurnTarget)
      return
    }
    if (pendingTrigger && pendingTrigger.playerId === viewer?.id) {
      if (triggerHermitChoicesReady && triggerSlimeChoicesReady &&
        triggerSlimeEnemyUids.length < triggerSlimeEnemyAmount) {
        const targets = [...triggerSlimeEnemyUids, enemy.uid]
        if (targets.length === triggerSlimeEnemyAmount && !pendingTrigger.targets) {
          resolveTrigger(undefined, undefined, undefined, targets)
        } else setTriggerSlimeEnemyUids(targets)
        return
      }
      if (triggerHermitChoicesReady && triggerSlimeChoicesReady &&
        triggerSlimeEnemyUids.length === triggerSlimeEnemyAmount &&
        pendingTrigger.targets?.some((target) => target.uid === enemy.uid)) {
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
      if (pendingPotionDef?.target === 'enemy' || pendingPotion === 'mystery_potion' && state.die <= 2) {
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
      if (pendingPowerDef.target === 'row') {
        usePower(pendingPowerUid, { enemyRow: enemy.row })
        return
      }
      if (pendingPowerDef.id === 'hermit_black_wind' && powerLoadUids.length === 1) {
        usePower(pendingPowerUid, { chamberUids: powerChamberUids, loadUids: powerLoadUids,
          hermitEnemyUids: [enemy.uid] })
        setPowerChamberUids([])
        setPowerLoadUids([])
        return
      }
      if (pendingHermitPower) return
      if (pendingPower?.attachedGemId === 'guardian_jasper' ||
        pendingPower?.attachedGemId === 'guardian_onyx' ||
        pendingPower?.attachedGemId === 'guardian_amethyst') return
      choosePowerContext({ enemyUid: enemy.uid })
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
    if (spendingSoulburn) {
      const extraCrispyPowerUid = extraCrispySoulburn ? extraCrispyPower?.uid : undefined
      if (onAction) {
        setSpendingSoulburn(false)
        setExtraCrispySoulburn(false)
        onAction({ kind: 'spendSoulburn', enemyUid: enemy.uid, extraCrispyPowerUid })
        return
      }
      const result = spendSoulburn(state, viewer!.id, enemy.uid, extraCrispyPowerUid)
      if (result !== state) {
        setSpendingSoulburn(false)
        setExtraCrispySoulburn(false)
        onChange?.(result)
      }
      return
    }
    if (pending && (!pending.slimeChoice || pending.slimeChoiceConfirmed) &&
      pending.slimeEnemyUids.length < slimeEnemyChoicesRequired(pending) &&
      handChoiceSatisfied && revealedChoiceSatisfied) {
      const next = { ...pending, slimeEnemyUids: [...pending.slimeEnemyUids, enemy.uid] }
      stageOrCommit(next)
      return
    }
    if (pending && pending.hermitEnemyUids.length < loadedTargetCount(pending) &&
      handChoiceSatisfied && revealedChoiceSatisfied) {
      stageOrCommit({ ...pending, hermitEnemyUids: [...pending.hermitEnemyUids, enemy.uid] })
      return
    }
    if (pending && pending.soulburnEnemyUids.length < pending.soulburnChoices &&
      handChoiceSatisfied && revealedChoiceSatisfied) {
      stageOrCommit({ ...pending, soulburnEnemyUids: [...pending.soulburnEnemyUids, enemy.uid] })
      return
    }
    if (pending?.chamberPlay && pending.choicePreviewPending) {
      requestChamberChoicePreview(pending.card, enemy.uid, pending)
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
        if (pending.chamberPlay) requestChamberChoicePreview(pending.card, enemy.uid, pending)
        else if (pending.cardInHand) requestChoicePreview(pending.card, enemy.uid, pending)
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
    if (armedEndTurnAbilityId === endTurnEffect?.id && endTurnTargetForEnemy(enemy) === lightningRowTarget(enemy.row)) {
      return true
    }
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

  // A row can be a legal target (the engine always folds in the boss
  // regardless of which row is chosen — see `resolveEnemyTargets`'s `'row'`
  // scope) even once every enemy actually placed in it has died, so there is
  // nothing left in that lane for `onEnemyClick`/`isEnemyRowClickTargetable`
  // to anchor on. This pair covers exactly that gap: same row-matching logic,
  // triggered by clicking the empty lane itself instead of an enemy in it.
  function onRowLaneClick(row: number) {
    const endTurnTarget = endTurnTargetForRow(row)
    if (endTurnTarget && armedEndTurnAbilityId === endTurnEffect?.id) {
      resolveEndTurnTarget(endTurnEffect.id, endTurnTarget)
      return
    }
    if (pendingTrigger && pendingTrigger.playerId === viewer?.id &&
      pendingTrigger.rows?.some((target) => target.row === row)) {
      resolveTrigger(row)
      return
    }
    if (pendingStartEvokeTarget) {
      const rowTarget = pendingStartEvokeRows.find((target) => target.row === row)
      if (rowTarget) chooseStartTurnEvokeEnemy(rowTarget.uid)
      return
    }
    if (pendingPotion && pendingPotionDef?.target === 'row') {
      consumePotion(pendingPotion, { enemyRow: row })
      return
    }
    if (pendingPowerUid && pendingPowerDef?.target === 'row') {
      usePower(pendingPowerUid, { enemyRow: row })
      return
    }
    if (pending && pendingEvokeTarget >= 0 && pendingEvokeUsesRows && choiceSatisfied &&
      pendingEvokeTargetUids.has(lightningRowTarget(row))) {
      const targets = [...pending.evokeEnemyUids]
      targets[pendingEvokeTarget] = lightningRowTarget(row)
      stageOrCommit({ ...pending, evokeEnemyUids: targets })
    }
  }

  function isRowLaneClickTargetable(row: number): boolean {
    if (armedEndTurnAbilityId === endTurnEffect?.id && endTurnTargetForRow(row)) return true
    if (!usingTrigger && pendingTrigger && pendingTrigger.playerId === viewer?.id &&
      pendingTrigger.rows?.some((target) => target.row === row)) {
      return true
    }
    if (pendingStartEvokeTarget && pendingStartEvokeRows.some((target) => target.row === row)) return true
    if (pendingPotion && pendingPotionDef?.target === 'row') return true
    if (pendingPowerUid && pendingPowerDef?.target === 'row') return true
    if (pending && pendingEvokeTarget >= 0 && pendingEvokeUsesRows && choiceSatisfied &&
      pendingEvokeTargetUids.has(lightningRowTarget(row))) return true
    return false
  }

  // Mirrors `isRowLaneClickTargetable`'s own priority order, branch for
  // branch, so the label always names whichever ability actually resolves
  // the click — the same distinction the removed per-ability buttons used to
  // make ("Resolve X in Row Y", "Evoke Lightning in Row Y", "Target Row Y").
  // The final `return` below is unreachable given the render gate at the call
  // site (`isRowLaneClickTargetable(row)` already true), kept only to satisfy
  // TypeScript's exhaustiveness check — a new 6th targeting mode must add its
  // own explicit branch here, not rely on that fallback.
  function rowLaneClickLabel(row: number): string {
    const rowLabel = combatRowLabel(state, row)
    const noLivingAnchor = `no living enemy there${
      state.enemies.some((enemy) => enemy.isBoss && !enemy.dead) ? ', but the boss is hit' : ''}`
    if (armedEndTurnAbilityId === endTurnEffect?.id && endTurnTargetForRow(row)) {
      return `Resolve ${endTurnEffect.label} in ${combatRowLabel(state, row)} (${noLivingAnchor})`
    }
    if (!usingTrigger && pendingTrigger && pendingTrigger.playerId === viewer?.id &&
      pendingTrigger.rows?.some((target) => target.row === row)) {
      return `Resolve ${pendingTrigger.label} in ${rowLabel} (${noLivingAnchor})`
    }
    if (pendingStartEvokeTarget && pendingStartEvokeRows.some((target) => target.row === row)) {
      return `Evoke Lightning in ${rowLabel} (${noLivingAnchor})`
    }
    if (pendingPotion && pendingPotionDef?.target === 'row') {
      return `Target ${rowLabel} with ${pendingPotionDef.name} (${noLivingAnchor})`
    }
    if (pendingPowerUid && pendingPowerDef?.target === 'row') {
      return `Target ${rowLabel} with ${pendingPowerDef.name} (${noLivingAnchor})`
    }
    if (pending && pendingEvokeTarget >= 0 && pendingEvokeUsesRows && choiceSatisfied &&
      pendingEvokeTargetUids.has(lightningRowTarget(row))) {
      return `Evoke Lightning in ${rowLabel} (${noLivingAnchor})`
    }
    return `Target ${rowLabel} (${noLivingAnchor})`
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
    const enemyChoices = cardEnemyChoiceCount(pendingDef, mode, state, viewer!)
    if (effects.some((effect) => effect.kind === 'hitChoices' && effect.distinct) &&
      enemyChoices > state.enemies.filter((enemy) => !enemy.dead).length) return
    const playerChoices = cardPlayerChoiceCount(pendingDef, mode)
    stageOrCommit({
      ...pending, mode, enemyChoices, playerChoices, enemyUids: pending.enemyUids.slice(0, enemyChoices),
      needsEnemy: cardNeedsEnemy(selectedDef, viewer!, false, pending.effectEnergy ?? undefined,
        false, pending.card.attachedGemId, pending.card.uid,
        pending.energyCharged ?? undefined, pending.card.hermitDeadOn === true) || enemyChoices > 0,
      playerIds: state.players.filter((player) => !player.dead).length === 1
        ? Array(playerChoices).fill(viewer!.id)
        : [],
    })
  }

  function onCorruptedShardModeClick(mode: 'attack' | 'defense') {
    if (!pending || !pendingDef || !viewer) return
    const actor = { ...viewer, guardianMode: mode }
    const def = effectiveCombatCardDef(pendingDef, mode)
    const needsAlly = guardianCardNeedsAlly(def, actor, pending.card.attachedGemId) &&
      state.players.filter((player) => !player.dead).length > 1
    stageOrCommit({
      ...pending,
      corruptedShardMode: mode,
      needsAlly,
      needsEnemy: cardNeedsEnemy(def, actor, false, pending.effectEnergy ?? undefined,
        false, pending.card.attachedGemId, pending.card.uid,
        pending.energyCharged ?? undefined, pending.card.hermitDeadOn === true) || pending.enemyChoices > 0 ||
        pending.spentShivs + pending.overflowShivs > 0,
      playerId: needsAlly ? pending.playerId : null,
    })
  }

  function onAllyClick(ally: Player) {
    if (ally.dead) return
    if (pendingPowerUid && pendingPower &&
      guardianCardNeedsAlly(pendingPowerDef!, viewer!, pendingPower.attachedGemId)) {
      choosePowerContext({ playerId: ally.id })
      return
    }
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
  const copySource = (pending?.cardInHand !== false || pending?.chamberPlay) && pendingDef?.id !== 'burst'
    ? (pendingEffectiveDef?.type === 'attack' || pendingEffectiveDef?.type === 'skill') && (viewer.doubledCardsThisTurn ?? 0) > 0
      ? 'Echo Form'
      : pendingEffectiveDef?.type === 'attack' && (viewer.tripledAttacksThisTurn ?? 0) > 0
        ? 'Blasphemy'
        : pendingEffectiveDef?.type === 'attack' && (viewer.doubledAttacksThisTurn ?? 0) > 0
          ? 'Double Tap'
          : pendingEffectiveDef?.type === 'skill' && (viewer.doubledSkillsThisTurn ?? 0) > 0 ? 'Burst' : null
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
  const originalTarget = pending?.cardInHand === false && !pending.chamberPlay
    ? ` for ${copyResolutionLabel ?? pendingDef?.name ?? 'card'}`
    : ''
  // Shared across every row-target prompt below so "the boss is always
  // folded in regardless of row" reads the same way everywhere, not just for
  // card-based row targets.
  const rowHitSuffix = state.enemies.some((enemy) => enemy.isBoss && !enemy.dead) ? ', and the boss' : ''
  const normalEnemyPrompt = pending?.hitsRow
    ? `Choose an enemy${originalTarget || copyTarget} — its whole row is hit${rowHitSuffix}`
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
  const startTurnPrompt = pendingStartExhaust
    ? `${pendingStartExhaust.label} — choose a card to Exhaust`
    : pendingStartShiv
      ? `${pendingStartShiv.ability.label} — choose overflow Shiv ${pendingStartShiv.index + 1}/${pendingStartShiv.ability.overflowShivs}, or skip`
      : pendingStartEnemy
      ? `${pendingStartEnemy.label} — choose an enemy`
    : pendingStartPlayer
      ? `${pendingStartPlayer.label} — choose a player`
    : pendingStartEvokeTarget
      ? `${pendingStartEvokeTarget.ability.label} — choose ${pendingStartEvokeRows.length > 0
        ? `an enemy for the Evoked Orb — its whole row is hit${rowHitSuffix}` : 'a target for the Evoked Orb'}`
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
  const plunderPrompt = pendingPlunder
    ? pendingPlunder.playerId === viewer.id
      ? 'Plunder — switch rows or stay where you are'
      : `Waiting for ${state.players.find((player) => player.id === pendingPlunder.playerId)?.name ?? 'another player'} to finish Plunder`
    : null
  const dieRelicPrompt = dieRelicPending
    ? dieRelicPending.playerId === viewer.id
      ? `${dieRelicPending.sourceLabel} — finish the chosen die Relic`
      : `Waiting for ${state.players.find((player) => player.id === dieRelicPending.playerId)?.name ?? 'another player'} to finish a die Relic`
    : null
  const triggerPrompt = pendingTrigger
    ? pendingTrigger.playerId === viewer.id
      ? `${pendingTrigger.label} — choose ${pendingTrigger.hermitChoices && !triggerHermitChoicesReady
        ? 'Hermit card choices' : pendingTrigger.slimeChoice && !triggerSlimeChoicesReady ? 'Slime or self' :
        triggerSlimeEnemyUids.length < triggerSlimeEnemyAmount
          ? `${triggerSlimeEnemyLabels[triggerSlimeEnemyUids.length] ?? 'Slime'} Command target ${triggerSlimeEnemyUids.length + 1}/${triggerSlimeEnemyAmount}` :
        pendingTrigger.targets ? 'an enemy' : pendingTrigger.players ? 'a player' :
        pendingTrigger.hermitChoices ? 'Hermit card choices' : pendingTrigger.slimeChoice ? 'Slime or self' : 'a row'}`
      : `Waiting for ${state.players.find((player) => player.id === pendingTrigger.playerId)?.name ?? 'another player'} to resolve ${pendingTrigger.label}`
    : null
  const beforeDrawPrompt = activeStartTurnScry && activeStartTurnScry.playerId !== viewer.id
    ? `Waiting for ${state.players.find((player) => player.id === activeStartTurnScry.playerId)?.name ?? 'another player'} to Scry before drawing`
    : null
  const prompt = dieRelicPrompt ?? plunderPrompt ?? triggerPrompt ?? forcedPrompt ?? beforeDrawPrompt ?? startTurnPrompt ?? (pendingPowerDef
    ? pendingPowerDef.id === 'guardian_gem_finder'
      ? 'Gem Finder — choose cards to discard from the private Scry'
      : pendingPowerDef.id === 'guardian_revenge_protocol'
        ? 'Revenge Protocol — choose an Attack in hand'
      : pendingPowerDef.id === 'hermit_shadow_cloak'
      ? 'Shadow Cloak — choose a Curse to discard from the Chamber'
      : pendingPowerDef.id === 'hermit_black_wind'
        ? powerChamberUids.length === 0 ? 'Black Wind — choose a Chamber card to discard'
          : powerLoadUids.length === 0 ? 'Black Wind — choose a card to Load'
            : 'Black Wind — choose an enemy for the loaded Curse'
      : pendingPower?.attachedGemId === 'guardian_jasper'
        ? 'Jasper — Exhaust up to 3 cards'
      : pendingPower?.attachedGemId === 'guardian_onyx' && pendingPowerNeedsAlly
        ? 'Onyx — choose a player'
      : pendingPower?.attachedGemId === 'guardian_amethyst'
        ? 'Amethyst — choose whether to Mode Shift'
      : pendingPowerDef.target === 'row'
        ? `Choose an enemy for ${pendingPowerDef.name} — its whole row is hit${rowHitSuffix}`
        : `Choose an enemy for ${pendingPowerDef.name}`
    : pendingPotion === 'gamblers_brew'
      ? "Gambler's Brew — choose the shared die face"
    : pendingPotion === 'liquid_memories'
      ? 'Liquid Memories — choose a card from your discard pile'
    : pendingPotion === 'liquid_void'
      ? 'Liquid Void — choose a card from your Exhaust pile'
    : pendingPotion === 'transforming_brew'
      ? 'Transforming Brew — choose a non-Curse card in your hand'
    : pendingPotion === 'destiny_draught'
      ? 'Destiny Draught — choose any die relic ability'
    : pendingPotion === 'purity_potion'
      ? `Purity — choose up to 3 cards to Exhaust (${potionCardUids.length}/3)`
    : pendingPotion === 'entropic_brew' && !viewerHasSozu
      ? 'Entropic Brew — choose a held Potion to replace'
    : pendingPotionDef
    ? pendingPotionDef.target === 'row'
      ? `Choose an enemy for ${pendingPotionDef.name} — its whole row is hit${rowHitSuffix}`
      : pendingPotionOverflow > 0
        ? `Choose overflow Shiv target ${potionShivEnemyUids.length + 1}/${pendingPotionOverflow}, or skip the rest`
        : `Choose ${pendingPotionDef.target ? 'an enemy' : 'a player'} for ${pendingPotionDef.name}`
    : spendingShiv
    ? 'Choose an enemy for the Shiv'
    : spendingSoulburn
    ? 'Choose an enemy for Soulburn'
    : pending?.choice?.kind === 'load' || pending?.choice?.kind === 'loadAny'
      ? `${pendingDef?.name ?? 'Card'} — choose ${pending.choice.kind === 'loadAny' ? 'up to ' : ''}${pending.choice.amount} card${pending.choice.amount === 1 ? '' : 's'} to Load`
    : pending?.slimeChoice && !pending.slimeChoiceConfirmed &&
      (pendingDef?.cost !== 'X' || pending.energySpent !== null)
      ? `Choose ${pending.slimeChoice.minimum === pending.slimeChoice.amount ? '' : 'up to '}${pending.slimeChoice.amount} Slime${pending.slimeChoice.amount === 1 ? '' : 's'}`
    : pending && pending.slimeEnemyUids.length < slimeEnemyChoicesRequired(pending)
      ? `Choose ${slimeEnemyChoiceLabels(pending)[pending.slimeEnemyUids.length] ?? 'Slime'} Command target ${pending.slimeEnemyUids.length + 1}/${slimeEnemyChoicesRequired(pending)}`
    : pending?.hermitDieRelicChoice && !pending.hermitDieRelicChoiceConfirmed
      ? `Cheat — trigger ${pending.hermitDieRelicChoice.minimum === pending.hermitDieRelicChoice.amount ? '' : 'up to '}${pending.hermitDieRelicChoice.amount} different die relic${pending.hermitDieRelicChoice.amount === 1 ? '' : 's'}`
    : pending?.chamberChoice && chamberChoiceRequired(pending) > 0 && !pending.chamberChoiceConfirmed
      ? `Choose ${chamberChoiceRequired(pending)} Chamber card${chamberChoiceRequired(pending) === 1 ? '' : 's'} to ${pending.chamberChoice.kind}`
    : pending?.chooseLoadSelf === null
      ? `Load ${pendingDef?.name ?? 'this card'} after playing it?`
    : pending?.spendVigor === null
      ? `Choose Vigor to spend on ${pendingDef?.name ?? 'this card'}`
    : pending?.guardianModeShift === null
      ? `Shift Guardian Mode with ${pendingDef?.name ?? 'this card'}?`
    : pending?.guardianBlockSpend === null
      ? `Choose Block to spend with ${pendingDef?.name ?? 'Body Crash'}`
    : pending && pending.hermitEnemyUids.length < loadedTargetCount(pending)
      ? `Choose enemy for loaded Curse ${pending.hermitEnemyUids.length + 1}/${loadedTargetCount(pending)}`
    : pending && pending.soulburnEnemyUids.length < pending.soulburnChoices
      ? `Choose Soulburn target ${pending.soulburnEnemyUids.length + 1}/${pending.soulburnChoices}`
    : pendingDef?.cost === 'X' && pending?.energySpent === null
      ? `Choose Energy for ${pendingDef.name}`
    : pendingDef?.modes && !modeSatisfied
      ? `Choose how to play ${pendingDef.name}`
    : corruptedShardModeNeeded && !corruptedShardModeSatisfied
      ? `Corrupted Shard — choose a Guardian Mode for ${pendingDef?.name ?? 'this card'}`
    : pendingPowerBeamChoiceNeeded && pending?.guardianPowerCardUid === null
      ? 'Power Beam — choose a Power from your hand or discard pile to play for 0 Energy'
    : pending?.choiceCards && !pending.choiceConfirmed
      ? pending.choice?.kind === 'scry'
        ? `Scry ${pending.choice.amount} — choose any cards to discard`
        : pending.choice?.kind === 'topdeck'
          ? `${pendingDef?.name ?? 'Card'} — choose ${choiceNeeded} card to put on top`
        : pending.choice?.kind === 'recover'
          ? `${pendingDef?.name ?? 'Card'} — choose a card from your discard pile`
        : pending.choice?.kind === 'recoverExhaust'
          ? `${pendingDef?.name ?? 'Card'} — choose ${pending.choice.minimum === 0 ? `up to ${choiceNeeded}` :
            choiceNeeded === 1 ? 'a card' : choiceNeeded} from your Exhaust pile`
        : pending.choice?.kind === 'search'
          ? pendingSearchKind?.kind === 'overexert'
            ? choiceNeeded === 0 ? 'Overexert — no playable card remains after drawing'
              : 'Overexert — choose a playable card from your hand'
            : pendingSearchKind?.kind === 'replicateSlime'
              ? choiceNeeded === 0 ? 'Replication — no Slime is in your draw pile'
                : 'Replication — choose a Slime from your draw pile to play'
              : `${pendingDef?.name ?? 'Card'} — choose ${choiceNeeded} from your draw pile`
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
        ? pendingEvokeUsesRows
          ? `Choose an enemy for this evoke — its whole row is hit${rowHitSuffix}`
          : 'Choose an enemy for this evoke'
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
      inert={chamberClosing}
      aria-busy={chamberClosing || undefined}
      data-act={stageAct}
      data-character={viewer.character}
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
          {!viewer.dead && !relicScry && !voluntaryActionsBlocked && (state.phase === 'player' || state.phase === 'discard' ||
            state.phase === 'start' && viewer.potions.includes('gamblers_brew')) ? (
            <>
              {activePowerWindow(state) && !forcedCard && !distilled && !endTurnResolving && !pendingTrigger ? viewer.powers.flatMap((power) => {
                const def = faceOf(cardDef(power.defId), power.upgraded)
                if (!def.activeAbility) return []
                const staged = pendingPowerUid === power.uid
                const used = powerAbilityUsed(state, viewer.id, power.uid)
                const attachedGem = power.attachedGemId ? cardDef(power.attachedGemId).name : null
                return [<button
                  type="button"
                  key={power.uid}
                  disabled={usingPower || used || Boolean(pending?.choiceCards) ||
                    def.id === 'hermit_shadow_cloak' && !viewer.chamber.some((card) =>
                      faceOf(cardDef(card.defId), card.upgraded).type === 'curse') ||
                    def.id === 'hermit_black_wind' && (viewer.chamber.length === 0 || viewer.hand.length === 0)}
                  aria-label={used ? `${def.name}${attachedGem ? ` with ${attachedGem}` : ''} used`
                    : `Use ${def.name}${attachedGem ? ` with ${attachedGem}` : ''}`}
                  aria-pressed={staged}
                  onClick={() => {
                    setPending(null)
                    setSpendingShiv(false)
                    setMiracleOnCard(false)
                    setPendingPotion(null)
                    setPotionShivEnemyUids([])
                    setPotionOverflowRequired(0)
                    setPowerChamberUids([])
                    setPowerLoadUids([])
                    setPowerExhaustUids([])
                    setPowerGemContext(null)
                    setPowerScryConfirmed(false)
                    const needsTarget = def.target === 'row' ||
                      cardNeedsEnemy(def, viewer, true, undefined, true, power.attachedGemId)
                    const needsGemChoice = guardianCardNeedsAlly(def, viewer, power.attachedGemId) &&
                      livingPlayers.length > 1 ||
                      power.attachedGemId === 'guardian_jasper' || power.attachedGemId === 'guardian_amethyst'
                    const needsHermitChoice = def.id === 'hermit_shadow_cloak' || def.id === 'hermit_black_wind'
                    if (!staged && def.id === 'guardian_gem_finder') requestPowerPreview(power.uid)
                    else if (!staged && !needsTarget && !needsGemChoice && !needsHermitChoice &&
                      def.id !== 'guardian_revenge_protocol') usePower(power.uid, {})
                    else setPendingPowerUid(staged ? null : power.uid)
                  }}
                ><PowerGlyph def={def} /></button>]
              }) : null}
              {(state.phase === 'player' || state.phase === 'start') && !forcedCard && !distilled && !endTurnResolving && !pendingTrigger ? [...new Set(viewer.potions)].flatMap((potionId) => {
                if (!canActivatePotion(state, viewer, potionId)) return []
                const potion = potionDef(potionId)
                const staged = pendingPotion === potionId
                const count = viewer.potions.filter((held) => held === potionId).length
                const shivs = gainedShivs(potion.effects)
                const capacity = state.potionLimit + (viewer.relics.some((relic) => relic.defId === 'potion_belt') ? 2 : 0)
                const needsTarget = ['gamblers_brew', 'liquid_memories', 'liquid_void', 'transforming_brew', 'purity_potion', 'destiny_draught'].includes(potionId) ||
                  potionId === 'mystery_potion' && state.die <= 2 ||
                  potionId === 'entropic_brew' && !viewerHasSozu &&
                    viewer.potions.length - 1 + 2 > capacity || Boolean(potion.target) || (
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
              {state.phase === 'player' && !forcedCard && !distilled && !relicScry && !endTurnResolving &&
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
                    setSpendingSoulburn(false)
                  }}
                >
                  <StatusIcon name="shiv" size={22} />
                </button>
              ) : null}
              {state.phase === 'player' && !forcedCard && !distilled && !relicScry && !endTurnResolving &&
              !pendingTrigger && !viewer.cardPlayLocked && !reachedTimeWarpLimit(state, viewer) && viewer.soulburn > 0 ? (
                <button
                  type="button"
                  className={spendingSoulburn ? 'is-chosen' : undefined}
                  disabled={Boolean(pending?.choiceCards)}
                  aria-label={`Spend Soulburn, ${viewer.soulburn} available`}
                  aria-pressed={spendingSoulburn}
                  onClick={() => {
                    setPending(null)
                    setPendingPowerUid(null)
                    setMiracleOnCard(false)
                    setPendingPotion(null)
                    setPotionShivEnemyUids([])
                    setPotionOverflowRequired(0)
                    setSpendingShiv(false)
                    setExtraCrispySoulburn(false)
                    setSpendingSoulburn((current) => !current)
                  }}
                >
                  <img className="item-icon-image" src={assetPath('icons/hexaghost-flame.png')} alt="" />
                  <span aria-hidden="true">{viewer.soulburn}</span>
                </button>
              ) : null}
              {spendingSoulburn && extraCrispyPower ? (
                <button type="button" className={extraCrispySoulburn ? 'is-chosen' : undefined}
                  aria-label="Use Extra Crispy with Soulburn" aria-pressed={extraCrispySoulburn}
                  onClick={() => setExtraCrispySoulburn((current) => !current)}>
                  Extra Crispy ×2
                </button>
              ) : null}
              {state.phase === 'player' && !forcedCard && !distilled && !endTurnResolving && !pendingTrigger && viewer.miracles > 0 ? (
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
              {/* The count lives on the End turn button itself. A co-op turn
                  ends when everyone says so, and being told who the table is
                  waiting on is the whole reason a second screen existed. */}
              {!forcedCard && !distilled ? <button type="button" ref={endTurnRef} className="combat__end-turn" onClick={finishTurn}
                disabled={Boolean(pending?.choiceCards) || Boolean(pendingTrigger) || endTurnResolving || chamberClosing}>
                {state.phase === 'discard'
                  ? `${discardOrders[viewer.id] ? 'Update' : 'Confirm'} ${viewer.name} (${confirmedDiscards}/${livingPlayers.length})`
                  : endTurnCount ? `End turn ${endTurnCount}` : 'End turn'}
              </button> : null}
            </>
          ) : null}
          {state.phase === 'start' && !forcedCard && !pendingTrigger && !activeStartTurnScry &&
          orderedStartTurnScries.length > 0 ? (
            <>
              <details className="start-turn-order" open>
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
              <details className="start-turn-order">
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
                          : ability.exhaustCards ? ` — Exhaust ${startTurnExhaustUids[ability.id] ? 1 : 0}/1`
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
              {pendingStartExhaust?.exhaustCards ? (
                <div className="combat__choice-cards" role="group"
                  aria-label={`${pendingStartExhaust.label} — choose a card to Exhaust`}>
                  {pendingStartExhaust.exhaustCards.map((card) => <Card key={card.uid} card={card} playable
                    selected={startTurnExhaustUids[pendingStartExhaust.id] === card.uid}
                    onClick={() => chooseStartTurnExhaust(card.uid)} />)}
                </div>
              ) : null}
              {pendingStartModeShift ? (
                <div className="prompt__modes" role="group" aria-label={`${pendingStartModeShift.label}?`}>
                  <button type="button" onClick={() => chooseStartTurnModeShift(false)}>Stay in current Mode</button>
                  <button type="button" onClick={() => chooseStartTurnModeShift(true)}>Mode Shift</button>
                </div>
              ) : null}
              {orderedStartAbilities.some((ability) =>
                (ability.targets?.length ?? 0) > 1 && startTurnEnemyTargets[ability.id] !== undefined) ||
                Object.values(startTurnPlayerTargets).some((playerId) => playerId !== undefined) ||
                Object.values(startTurnExhaustUids).some((uid) => uid !== undefined) ||
                Object.values(startTurnModeShifts).some((shift) => shift !== undefined) ||
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
                    setStartTurnExhaustUids({})
                    setStartTurnModeShifts({})
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
          {pendingPlunder?.playerId === viewerId ? (
            <>
              <button type="button" className="prompt__mode" onClick={() => submitPlunderRow(null)}>Stay</button>
              {state.players.filter((player) => !player.dead && player.row !== viewer.row).map((player) => (
                <button type="button" className="prompt__mode" key={player.id}
                  onClick={() => submitPlunderRow(player.row)}>Switch with {player.name}</button>
              ))}
            </>
          ) : null}
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
          {pendingTrigger?.playerId === viewerId && pendingTrigger.slimeChoice ? (
            <span className="hermit-prompt__choice">
              {pendingTrigger.slimeChoice.cards.map((slime) => {
                const selected = triggerSlimeUids.includes(slime.uid)
                return <button type="button" className="prompt__mode" key={slime.uid} aria-pressed={selected}
                  onClick={() => {
                    setTriggerSlimeUids((current) => selected
                      ? current.filter((uid) => uid !== slime.uid)
                      : [...current, slime.uid].slice(-pendingTrigger.slimeChoice!.amount))
                    setTriggerSlimeEnemyUids([])
                  }}>{slime.label}</button>
              })}
              {!pendingTrigger.targets && !pendingTrigger.rows && !pendingTrigger.players &&
                triggerSlimeEnemyAmount === 0 ? (
                <button type="button" className="prompt__mode"
                  disabled={triggerSlimeUids.length < pendingTrigger.slimeChoice.minimum}
                  onClick={() => resolveTrigger()}>
                  {triggerSlimeUids.length === 0 ? 'Choose self' : `Confirm ${triggerSlimeUids.length} Slime`}
                </button>
              ) : null}
            </span>
          ) : null}
          {pendingHermitPower && pendingPowerDef?.id === 'hermit_shadow_cloak' ? viewer.chamber
            .filter((card) => faceOf(cardDef(card.defId), card.upgraded).type === 'curse').map((card) => (
              <button type="button" className="prompt__mode" key={card.uid}
                onClick={() => usePower(pendingPowerUid!, { chamberUids: [card.uid] })}>
                Discard {cardDef(card.defId).name}
              </button>
            )) : null}
          {pendingPowerDef?.id === 'guardian_gem_finder' && powerChoiceCards ? (
            <span className="hermit-prompt__choice">
              {powerChoiceCards.map((card) => {
                const selected = powerScryDiscardUids.includes(card.uid)
                return <button type="button" className="prompt__mode" key={card.uid} aria-pressed={selected}
                  disabled={powerScryConfirmed}
                  onClick={() => setPowerScryDiscardUids((current) => selected
                    ? current.filter((uid) => uid !== card.uid) : [...current, card.uid])}>{cardDef(card.defId).name}</button>
              })}
              <button type="button" className="prompt__mode" aria-pressed={powerScryConfirmed}
                onClick={confirmPowerScry}>
                {powerScryConfirmed ? 'Scry confirmed' : 'Confirm Scry'}
              </button>
            </span>
          ) : null}
          {pendingPower?.attachedGemId === 'guardian_jasper' ? (
            <span className="hermit-prompt__choice">
              {viewer.hand.map((card) => {
                const selected = powerExhaustUids.includes(card.uid)
                return <label key={card.uid}>
                  <input type="checkbox" checked={selected} disabled={!selected && powerExhaustUids.length >= 3}
                    onChange={() => setPowerExhaustUids((current) => selected
                      ? current.filter((uid) => uid !== card.uid)
                      : [...current, card.uid].slice(0, 3))} />
                  Exhaust {cardDef(card.defId).name}
                </label>
              })}
              <button type="button" className="prompt__mode"
                onClick={() => choosePowerContext({ exhaustUids: powerExhaustUids })}>
                Confirm {powerExhaustUids.length}
              </button>
            </span>
          ) : null}
          {pendingPower?.attachedGemId === 'guardian_amethyst' ? [false, true].map((shift) => (
            <button type="button" className="prompt__mode" key={String(shift)}
              onClick={() => choosePowerContext({ guardianModeShift: shift })}>
              {shift ? 'Mode Shift' : 'Stay in Mode'}
            </button>
          )) : null}
          {pendingPowerDef?.id === 'guardian_revenge_protocol' ? viewer.hand.filter((card) =>
            effectiveCombatCardDef(faceOf(cardDef(card.defId), card.upgraded), viewer.guardianMode).type === 'attack').map((card) => (
              <button type="button" className="prompt__mode" key={card.uid}
                onClick={() => usePower(pendingPowerUid!, { cardUid: card.uid })}>{cardDef(card.defId).name}</button>
            )) : null}
          {pendingHermitPower && pendingPowerDef?.id === 'hermit_black_wind' && powerChamberUids.length === 0
            ? viewer.chamber.map((card) => (
              <button type="button" className="prompt__mode" key={card.uid}
                onClick={() => setPowerChamberUids([card.uid])}>Discard {cardDef(card.defId).name}</button>
            )) : null}
          {pendingHermitPower && pendingPowerDef?.id === 'hermit_black_wind' && powerChamberUids.length === 1 &&
          powerLoadUids.length === 0 ? viewer.hand.map((card) => (
              <button type="button" className="prompt__mode" key={card.uid} onClick={() => {
                if (['hermit_grudge', 'hermit_malice', 'hermit_horror'].includes(card.defId)) {
                  setPowerLoadUids([card.uid])
                } else {
                  usePower(pendingPowerUid!, { chamberUids: powerChamberUids, loadUids: [card.uid] })
                  setPowerChamberUids([])
                }
              }}>Load {cardDef(card.defId).name}</button>
            )) : null}
          {pendingTrigger?.playerId === viewerId && pendingTrigger.hermitChoices ? (
            <span className="hermit-prompt__choice">
              {pendingTrigger.hermitChoices.loadCards.map((card) => <label key={`load-${card.uid}`}>
                <input type="checkbox" checked={triggerHermitLoadUids.includes(card.uid)} onChange={() =>
                  setTriggerHermitLoadUids((current) => current.includes(card.uid)
                    ? current.filter((uid) => uid !== card.uid)
                    : [...current, card.uid].slice(-pendingTrigger.hermitChoices!.loadAmount))} />
                Load {cardDef(card.defId).name}
              </label>)}
              {pendingTrigger.hermitChoices.chamberCards.map((card) => <label key={`chamber-${card.uid}`}>
                <input type="checkbox" checked={triggerHermitChamberUids.includes(card.uid)} onChange={() =>
                  setTriggerHermitChamberUids((current) => current.includes(card.uid)
                    ? current.filter((uid) => uid !== card.uid)
                    : [...current, card.uid].slice(-pendingTrigger.hermitChoices!.chamberAmount))} />
                Chamber: {cardDef(card.defId).name}
              </label>)}
              {!pendingTrigger.targets && !pendingTrigger.rows && !pendingTrigger.players ? (
                <button type="button" className="prompt__mode" disabled={!triggerHermitChoicesReady}
                  onClick={() => resolveTrigger()}>Resolve</button>
              ) : null}
            </span>
          ) : null}
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
            ? Array.from({ length: Math.max(0,
              maximumXEnergy(pendingDef, viewer) - (pendingDef.minimumX ?? 0) + 1) }, (_, at) => {
              const energy = at + (pendingDef.minimumX ?? 0)
              return (
                <button type="button" className="prompt__mode" key={energy}
                  onClick={() => stageOrCommit({
                    ...pending,
                    ...requirementsOf(
                      pendingEffectiveDef!, state.players.filter((player) => !player.dead).length, viewer, state,
                      energy, pending.cardInHand || pending.chamberPlay, pending.card.hermitDeadOn === true,
                      pending.choiceCards?.length, guardianGemForCard(viewer, pending.card), pending.card.uid,
                      pending.cardInHand || pending.chamberPlay ? energy : 0,
                    ),
                    energySpent: energy,
                    effectEnergy: energy,
                    energyCharged: pending.cardInHand || pending.chamberPlay ? energy : 0,
                    slimeUids: [],
                    slimeChoiceConfirmed: false,
                    slimeEnemyUids: [],
                  })}>
                  Spend {energy}
                </button>
              )
            })
            : null}
          {pending?.spendVigor === null ? Array.from({ length: viewer.vigor + 1 }, (_, amount) => (
            <button type="button" className="prompt__mode" key={`vigor-${amount}`}
              onClick={() => stageOrCommit({ ...pending, spendVigor: amount })}>
              Spend {amount} Vigor
            </button>
          )) : null}
          {pending?.guardianModeShift === null ? [false, true].map((shift) => (
            <button type="button" className="prompt__mode" key={`mode-shift-${shift}`}
              onClick={() => stageOrCommit({ ...pending, guardianModeShift: shift })}>
              {shift ? 'Shift Mode' : 'Keep Mode'}
            </button>
          )) : null}
          {pending?.secondGuardianModeShift === null ? [false, true].map((shift) => (
            <button type="button" className="prompt__mode" key={`second-${shift}`}
              onClick={() => stageOrCommit({ ...pending, secondGuardianModeShift: shift })}>
              Second Gem: {shift ? 'Mode Shift' : 'Stay in Mode'}
            </button>
          )) : null}
          {pending?.guardianBlockSpend === null ? Array.from({ length: viewer.block + 1 }, (_, amount) => (
            <button type="button" className="prompt__mode" key={`block-spend-${amount}`}
              onClick={() => stageOrCommit({ ...pending, guardianBlockSpend: amount })}>
              Spend {amount} Block
            </button>
          )) : null}
          {pending?.chooseLoadSelf === null ? [false, true].map((load) => (
            <button type="button" className="prompt__mode" key={`load-self-${load}`}
              onClick={() => stageOrCommit({ ...pending, chooseLoadSelf: load, chamberChoiceConfirmed: false })}>
              {load ? 'Load this card' : 'Do not Load'}
            </button>
          )) : null}
          {pending?.hermitDieRelicChoice && !pending.hermitDieRelicChoiceConfirmed ? (
            <>
              {state.players.filter((owner) => !owner.dead).flatMap((owner) => owner.relics.flatMap((held, relicIndex) =>
                chosenDieRelicAbilities(relicDef(held.defId)).flatMap((ability, abilityIndex) => {
                  if (ability.trigger.kind !== 'dieRelic') return []
                  const faces = ability.trigger.faces
                  const enemies = ability.effects.some((effect) => reachesEnemy(effect, owner))
                    ? livingEnemies(state) : [undefined]
                  const players = ability.supportTarget === 'anyPlayer'
                    ? state.players.filter((player) => !player.dead) : [undefined]
                  return enemies.flatMap((enemy) => players.map((targetPlayer) => {
                    const choice = {
                      playerId: owner.id,
                      relicIndex,
                      abilityIndex,
                      enemyUid: enemy?.uid,
                      targetPlayerId: targetPlayer?.id,
                    }
                    const sameRelic = pending.hermitDieRelics.findIndex((selected) =>
                      selected.playerId === owner.id && selected.relicIndex === relicIndex)
                    const selected = sameRelic >= 0 &&
                      pending.hermitDieRelics[sameRelic]!.abilityIndex === abilityIndex &&
                      pending.hermitDieRelics[sameRelic]!.enemyUid === enemy?.uid &&
                      pending.hermitDieRelics[sameRelic]!.targetPlayerId === targetPlayer?.id
                    return <button type="button" className="prompt__mode"
                      key={`${owner.id}:${relicIndex}:${abilityIndex}:${enemy?.uid ?? ''}:${targetPlayer?.id ?? ''}`}
                      aria-pressed={selected}
                      onClick={() => {
                        const hermitDieRelics = selected
                          ? pending.hermitDieRelics.filter((_, index) => index !== sameRelic)
                          : sameRelic >= 0
                            ? pending.hermitDieRelics.map((current, index) => index === sameRelic ? choice : current)
                            : pending.hermitDieRelics.length < pending.hermitDieRelicChoice!.amount
                              ? [...pending.hermitDieRelics, choice] : pending.hermitDieRelics
                        const exact = pending.hermitDieRelicChoice!.minimum === pending.hermitDieRelicChoice!.amount &&
                          hermitDieRelics.length === pending.hermitDieRelicChoice!.amount
                        const next = { ...pending, hermitDieRelics, hermitDieRelicChoiceConfirmed: false }
                        if (exact && hermitDieRelicSelectionsReady(next)) {
                          stageOrCommit({ ...next, hermitDieRelicChoiceConfirmed: true })
                        }
                        else setPending(next)
                      }}>
                      {dieRelicChoiceLabel(owner.name, relicDef(held.defId).name, faces)}
                      {enemy ? ` → ${enemyLabel(state.enemies, enemy)}` : ''}
                      {targetPlayer ? ` → ${targetPlayer.name}` : ''}
                    </button>
                  }))
                })))}
              {pending.hermitDieRelicChoice.minimum !== pending.hermitDieRelicChoice.amount ? (
                <button type="button" className="prompt__mode"
                  disabled={pending.hermitDieRelics.length < pending.hermitDieRelicChoice.minimum ||
                    !hermitDieRelicSelectionsReady(pending)}
                  onClick={() => stageOrCommit({ ...pending, hermitDieRelicChoiceConfirmed: true })}>
                  Trigger {pending.hermitDieRelics.length || 'none'}
                </button>
              ) : null}
            </>
          ) : null}
          {pending?.slimeChoice && !pending.slimeChoiceConfirmed &&
          (pendingDef?.cost !== 'X' || pending.energySpent !== null) ? (
            <>
              {(viewer.slimes ?? []).map((slime) => {
                const selected = pending.slimeUids.includes(slime.card.uid)
                const available = !pending.cardInHand && !pending.chamberPlay ||
                  forcedCardUid === pending.card.uid || Boolean(
                  pendingDef && slimeChoiceIsAvailable(
                    pendingDef, state, viewer, slime.card.uid, pending.effectEnergy ?? 0,
                  ),
                )
                return <button type="button" className="prompt__mode" key={slime.card.uid} aria-pressed={selected}
                  disabled={!available}
                  onClick={() => {
                    if (!available) return
                    const slimeUids = selected ? pending.slimeUids.filter((uid) => uid !== slime.card.uid)
                      : pending.slimeUids.length < pending.slimeChoice!.amount
                        ? [...pending.slimeUids, slime.card.uid] : pending.slimeUids
                    const exact = pending.slimeChoice!.minimum === pending.slimeChoice!.amount &&
                      slimeUids.length === pending.slimeChoice!.amount
                    const next = { ...pending, slimeUids, slimeChoiceConfirmed: exact, slimeEnemyUids: [] }
                    if (exact) stageOrCommit(next)
                    else setPending(next)
                  }}>{cardDef(slime.card.defId).name} · level {slime.level}</button>
              })}
              {pending.slimeChoice.minimum !== pending.slimeChoice.amount ? (
                <button type="button" className="prompt__mode"
                  disabled={pending.slimeUids.length < pending.slimeChoice.minimum}
                  onClick={() => stageOrCommit({ ...pending, slimeChoiceConfirmed: true })}>
                  Confirm {pending.slimeUids.length}
                </button>
              ) : null}
            </>
          ) : null}
          {pending?.chamberChoice && chamberChoiceRequired(pending) > 0 && !pending.chamberChoiceConfirmed ? (
            <>
              {(() => {
                const choice = pending.chamberChoice!
                const required = chamberChoiceRequired(pending)
                const baseAmount = Math.min(choice.baseAmount ?? required, required)
                const choosingBase = pending.chamberUids.length < baseAmount
                const candidateUids = choice.baseAmount === undefined || choosingBase
                  ? choice.eligibleUids
                  : chamberReplacementOptions(pending)
                return candidateUids.map((uid) => {
                const card = [...viewer.chamber, ...(pending.choiceCards ?? []), pending.card]
                  .find((candidate) => candidate.uid === uid)
                const selected = choosingBase && pending.chamberUids.includes(uid)
                return <button type="button" className="prompt__mode" key={uid} aria-pressed={selected}
                  onClick={() => {
                    const chamberUids = choice.baseAmount === undefined || choosingBase
                      ? selected ? pending.chamberUids.filter((heldUid) => heldUid !== uid)
                        : pending.chamberUids.length < required ? [...pending.chamberUids, uid] : pending.chamberUids
                      : [...pending.chamberUids, uid]
                    const exact = chamberUids.length === chamberChoiceRequired(pending)
                    const next = { ...pending, chamberUids, chamberChoiceConfirmed: exact }
                    if (exact) stageOrCommit(next)
                    else setPending(next)
                  }}>{card ? cardDef(card.defId).name : 'Loaded card'}</button>
                })
              })()}
              {pending.chamberChoice.baseAmount !== undefined &&
              pending.chamberUids.length > pending.chamberChoice.baseAmount ? (
                <button type="button" className="prompt__cancel" onClick={() => setPending({
                  ...pending,
                  chamberUids: pending.chamberUids.slice(0, -1),
                  chamberChoiceConfirmed: false,
                })}>Undo replacement</button>
              ) : null}
              {pending.chamberChoice.baseAmount === undefined &&
              pending.chamberChoice.minimum !== pending.chamberChoice.amount ? (
                <button type="button" className="prompt__mode"
                  disabled={pending.chamberUids.length < pending.chamberChoice.minimum}
                  onClick={() => stageOrCommit({ ...pending, chamberChoiceConfirmed: true })}>
                  Confirm {pending.chamberUids.length}
                </button>
              ) : null}
            </>
          ) : null}
          {(pending?.choice?.kind === 'discardAny' || pending?.choice?.kind === 'exhaustAny' ||
            pending?.choice?.kind === 'loadAny') && !pending.choiceConfirmed && !pending.choiceCards ? (
            <button type="button" className="prompt__mode"
              disabled={pending.picked.length < variableMinimum}
              onClick={() => stageOrCommit({ ...pending, choiceConfirmed: true })}>
              {pending.picked.length === 0
                ? `${pending.choice.kind === 'discardAny' ? 'Discard' : pending.choice.kind === 'loadAny' ? 'Load' : 'Exhaust'} none`
                : `${pending.choice.kind === 'discardAny' ? 'Discard' : pending.choice.kind === 'loadAny' ? 'Load' : 'Exhaust'} ${pending.picked.length}`}
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
                pending.cardInHand || pending.chamberPlay ? pending.card.uid : undefined) ||
                (mode.effects.some((effect) => effect.kind === 'hitChoices' && effect.distinct) &&
                  cardEnemyChoiceCount(pendingDef, index, state, viewer!) > state.enemies.filter((enemy) => !enemy.dead).length)}
              onClick={() => onModeClick(index)}>
              {mode.label}
            </button>
          )) : null}
          {corruptedShardModeNeeded && !corruptedShardModeSatisfied ? (['attack', 'defense'] as const).map((mode) => (
            <button type="button" className="prompt__mode" key={mode}
              onClick={() => onCorruptedShardModeClick(mode)}>
              Enter {mode === 'attack' ? 'Attack' : 'Defense'} Mode
            </button>
          )) : null}
          {pendingPowerBeamChoiceNeeded && pending?.guardianPowerCardUid === null
            ? pendingPowerBeamCards.map((card) => (
              <button type="button" className="prompt__mode" key={card.uid}
                onClick={() => stageOrCommit({ ...pending, guardianPowerCardUid: card.uid })}>
                Play {cardDef(card.defId).name} for 0
              </button>
            ))
            : null}
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
            : pendingPotion === 'liquid_void'
              ? 'Choose one Exhausted card to return to your hand for 0 Energy this turn.'
              : pendingPotion === 'transforming_brew'
                ? 'Choose one non-Curse card in your hand to Transform.'
                : 'Choose up to three cards in your hand, then confirm.'}</p>
          <div className="distilled-choice__cards">
            {(pendingPotion === 'liquid_memories' ? viewer.discard
              : pendingPotion === 'liquid_void' ? viewer.exhaust : viewer.hand)
              .filter((card) => pendingPotion !== 'transforming_brew' || !cardIsCurse(card.defId)).map((card) => (
              <Card key={card.uid} card={card} selected={potionCardUids.includes(card.uid)}
                onClick={() => pendingPotion === 'liquid_memories'
                  ? consumePotion(pendingPotion, { recoverDiscardUid: card.uid })
                  : pendingPotion === 'liquid_void'
                    ? consumePotion(pendingPotion, { recoverExhaustUid: card.uid })
                  : pendingPotion === 'transforming_brew'
                    ? consumePotion(pendingPotion, { transformHandUid: card.uid })
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

      {pendingPotion === 'destiny_draught' ? (
        <div className="prompt" aria-label="Destiny Draught relic ability">
          {state.players.filter((owner) => !owner.dead).flatMap((owner) => owner.relics.flatMap((target, targetRelicIndex) =>
            chosenDieRelicAbilities(relicDef(target.defId)).flatMap((ability, targetAbilityIndex) => {
              if (ability.trigger.kind !== 'dieRelic') return []
              const faces = ability.trigger.faces
              const enemies = (ability.target ?? 'enemy') !== 'allEnemies' &&
                ability.effects.some((effect) => reachesEnemy(effect, owner))
                ? state.enemies.filter((enemy) => !enemy.dead) : [undefined]
              const players = ability.supportTarget === 'anyPlayer'
                ? state.players.filter((player) => !player.dead) : [undefined]
              return enemies.flatMap((enemy) => players.map((targetPlayer) => <button type="button"
                key={`${owner.id}:${targetRelicIndex}:${targetAbilityIndex}:${enemy?.uid ?? ''}:${targetPlayer?.id ?? ''}`}
                onClick={() => consumePotion(pendingPotion, {
                  targetRelicPlayerId: owner.id, targetRelicIndex, targetAbilityIndex, enemyUid: enemy?.uid,
                  targetPlayerId: targetPlayer?.id,
                })}>
                {dieRelicChoiceLabel(owner.name, relicDef(target.defId).name, faces)}
                {enemy ? ` → ${enemyLabel(state.enemies, enemy)}` : ''}
                {targetPlayer ? ` → ${targetPlayer.name}` : ''}
              </button>))
            })))}
          <button type="button" className="prompt__cancel" onClick={cancelPotionChoice}>Cancel</button>
        </div>
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

      {!forcedCard && !distilled && !relicScry && !voluntaryActionsBlocked &&
        (state.phase === 'player' || state.phase === 'start' || state.phase === 'discard') ? (
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
            const heldId = held.defId.replace(/^downfall_/, '')
            const reroute = ['dollys_mirror', 'nilrys_codex', 'loaded_die'].includes(heldId)
            if (!canActivateRelic(state, viewer, relicIndex)) return []
            if (held.defId === 'golden_eye') return [simpleAction]
            if (held.defId === 'gambling_chip') return [simpleAction]
            if (held.defId === 'fuel_canister') return [<details key={relicIndex}>
              <summary>{def.name}</summary><p className="room-item-text">{def.text}</p>
              <div className="campfire__deck">{viewer.hand.map((card) => <Card key={card.uid} card={card}
                selected={relicCardUids[0] === card.uid} onClick={() => setRelicCardUids([card.uid])} />)}</div>
              <button type="button" disabled={relicCardUids.length !== 1}
                onClick={() => useRelic(relicIndex, { cardUids: relicCardUids })}>Exhaust and gain Energy</button>
            </details>]
            if (held.defId === 'shot_glass') return [<details key={relicIndex}>
              <summary>{def.name}</summary><p className="room-item-text">{def.text}</p>
              {viewer.potions.map((potionId, index) => <button type="button" key={`${potionId}-${index}`}
                onClick={() => useRelic(relicIndex, { discardPotionId: potionId })}>
                Discard {potionDef(potionId).name}
              </button>)}
            </details>]
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
            if (heldId === 'ninja_scroll') {
              const amount = def.effects.find((effect) => effect.kind === 'gainShiv')?.amount ?? 2
              const overflow = overflowShivCount(state, amount)
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
              const face = heldId === 'dollys_mirror' ? 1 : heldId === 'nilrys_codex' ? 2 : null
              return [<details key={relicIndex}><summary>{def.name}</summary><p className="room-item-text">{def.text}</p>
                {state.players.filter((owner) => !owner.dead).flatMap((owner) => owner.relics.flatMap((target, targetRelicIndex) =>
                  chosenDieRelicAbilities(relicDef(target.defId)).flatMap((ability, targetAbilityIndex) => {
                    if (ability.trigger.kind !== 'dieRelic' || face !== null && !ability.trigger.faces.includes(face) ||
                      ['nilrys_codex', 'loaded_die'].includes(heldId) && owner.id === viewerId &&
                      targetRelicIndex === relicIndex) return []
                    const faces = ability.trigger.faces
                    const enemies = (ability.target ?? 'enemy') !== 'allEnemies' &&
                      ability.effects.some((effect) => reachesEnemy(effect, owner))
                      ? state.enemies.filter((enemy) => !enemy.dead)
                      : [undefined]
                    const players = ability.supportTarget === 'anyPlayer'
                      ? state.players.filter((player) => !player.dead) : [undefined]
                    return enemies.flatMap((enemy) => players.map((targetPlayer) => <button type="button"
                      key={`${owner.id}:${targetRelicIndex}:${targetAbilityIndex}:${enemy?.uid ?? ''}:${targetPlayer?.id ?? ''}`}
                      onClick={() => useRelic(relicIndex, {
                        targetRelicPlayerId: owner.id, targetRelicIndex, targetAbilityIndex, enemyUid: enemy?.uid,
                        targetPlayerId: targetPlayer?.id,
                      })}>
                      {dieRelicChoiceLabel(owner.name, relicDef(target.defId).name, faces)}
                      {enemy ? ` → ${enemyLabel(state.enemies, enemy)}` : ''}
                      {targetPlayer ? ` → ${targetPlayer.name}` : ''}
                    </button>))
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
            if ((pending.cardInHand || pending.chamberPlay) &&
              (pending.choice?.kind === 'recover' || pending.choice?.kind === 'recoverExhaust')) setPending(null)
          }}>
          <div className="choice-modal__panel">
            <h2 id="choice-modal-title">
              {pending.choice.kind === 'scry' || pending.choice.kind === 'scryToHand'
                ? `Scry ${pending.choice.amount}`
                : pending.choice.kind === 'topdeck'
                  ? `Choose ${choiceNeeded} for the top of your draw pile`
                : pending.choice.kind === 'recover'
                  ? `Choose ${choiceNeeded} card${choiceNeeded === 1 ? '' : 's'} from your discard pile`
                : pending.choice.kind === 'recoverExhaust'
                  ? `Choose ${pending.choice.minimum === 0 ? `up to ${choiceNeeded}` :
                    choiceNeeded === 1 ? 'a' : choiceNeeded} card${choiceNeeded === 1 ? '' : 's'} from your Exhaust pile`
                : pending.choice.kind === 'search'
                  ? pendingSearchKind?.kind === 'overexert'
                    ? choiceNeeded === 0 ? 'No playable card remains' : 'Choose a playable card from your hand'
                    : pendingSearchKind?.kind === 'replicateSlime'
                      ? choiceNeeded === 0 ? 'No Slime is in your draw pile' : 'Choose a Slime from your draw pile'
                      : `Choose ${choiceNeeded} from your draw pile`
                : pending.choice.kind === 'load' || pending.choice.kind === 'loadAny'
                  ? `Choose ${pending.choice.kind === 'loadAny' ? 'up to ' : ''}${pending.choice.amount} to Load`
                  : `Choose ${choiceNeeded} to discard`}
            </h2>
            <p>
              {pending.choice.kind === 'scry' || pending.choice.kind === 'scryToHand'
                ? pending.choice.kind === 'scryToHand'
                  ? 'Select any cards to discard. You may also put one eligible revealed card into your hand.'
                  : 'Select any revealed cards to discard; unselected cards stay on top in order.'
                : pending.choice.kind === 'topdeck'
                  ? `${pending.picked.length}/${choiceNeeded} selected. The card is committed.`
                : pending.choice.kind === 'recover'
                  ? `${pending.picked.length}/${choiceNeeded} selected from discard.`
                : pending.choice.kind === 'recoverExhaust'
                  ? `${pending.picked.length}/${choiceNeeded} selected from Exhaust.`
                : pending.choice.kind === 'search'
                  ? pendingSearchKind?.kind === 'overexert'
                    ? choiceNeeded === 0 ? 'Continue without playing another card.'
                      : `${pending.picked.length}/${choiceNeeded} selected; the chosen card will be played${
                        selectedSearchType === 'attack' ? ' twice' : ''}.`
                    : pendingSearchKind?.kind === 'replicateSlime'
                      ? choiceNeeded === 0 ? 'Shuffle and continue without playing a Slime.'
                        : `${pending.picked.length}/${choiceNeeded} selected; the chosen Slime will be played and the rest shuffled.`
                      : `${pending.picked.length}/${choiceNeeded} selected; the rest will be shuffled.`
                : pending.choice.kind === 'load' || pending.choice.kind === 'loadAny'
                  ? `${pending.picked.length}/${pending.choice.amount} selected for the Chamber.`
                : `${pending.picked.length}/${choiceNeeded} selected.${pending.picked.length > 0
                  ? ` Discard order (later is higher): ${pending.picked.map((uid, index) => {
                    const card = pending.choiceCards!.find((held) => held.uid === uid)!
                    return `${index + 1}. ${faceOf(cardDef(card.defId), card.upgraded).name}`
                  }).join(' → ')}.`
                  : ''} The card is committed.`}
            </p>
            <div className="choice-modal__cards">
              {pending.choiceCards.map((card) => <div key={card.uid}>
                <Card card={card} selected={pending.picked.includes(card.uid) || pending.scryToHandUid === card.uid}
                  onClick={onChoiceCardClick} />
                {pending.choice?.kind === 'scryToHand' && effectiveCombatCardDef(
                  faceOf(cardDef(card.defId), card.upgraded), viewer.guardianMode,
                ).type ===
                  (pendingDef?.effects.find((effect) => effect.kind === 'scryToHand') as { cardType?: string } | undefined)?.cardType
                  ? <button type="button" aria-pressed={pending.scryToHandUid === card.uid}
                    onClick={() => setPending({ ...pending,
                      picked: pending.picked.filter((uid) => uid !== card.uid),
                      scryToHandUid: pending.scryToHandUid === card.uid ? undefined : card.uid,
                      choiceConfirmed: false,
                    })}>Put in hand</button> : null}
              </div>)}
              {pending.choiceCards.length === 0 ? <span className="muted">No cards were revealed.</span> : null}
            </div>
            <button type="button" disabled={!handChoiceSatisfied} onClick={confirmChoice}>
              {pending.choice.kind === 'scry' || pending.choice.kind === 'scryToHand'
                ? pending.picked.length === 0 ? 'Keep all' : `Discard ${pending.picked.length} and continue`
                : pending.choice.kind === 'topdeck'
                  ? `Put selected card${choiceNeeded === 1 ? '' : 's'} on top`
                : pending.choice.kind === 'recover'
                  ? pendingDef?.effects.some((effect) => effect.kind === 'recoverDiscard' && effect.toHand)
                    ? `Return selected card${choiceNeeded === 1 ? '' : 's'} to hand`
                    : `Put selected card${choiceNeeded === 1 ? '' : 's'} on top`
                : pending.choice.kind === 'recoverExhaust'
                  ? pendingDef?.effects.some((effect) => effect.kind === 'recoverExhaustToDraw')
                    ? pending.picked.length === 0 ? 'Keep all in Exhaust'
                      : `Put selected card${pending.picked.length === 1 ? '' : 's'} on top of your draw pile`
                    : pendingDef?.effects.some((effect) => effect.kind === 'recoverExhaustToDiscard')
                      ? `Put selected card${pending.picked.length === 1 ? '' : 's'} on top of your discard pile`
                      : 'Return selected card to hand'
                : pending.choice.kind === 'search'
                  ? pendingSearchKind?.kind === 'overexert'
                    ? choiceNeeded === 0 ? 'Continue'
                      : selectedSearchType === 'attack'
                        ? 'Play selected Attack twice' : 'Play selected card'
                    : pendingSearchKind?.kind === 'replicateSlime'
                      ? choiceNeeded === 0 ? 'Shuffle and continue' : 'Play selected Slime and shuffle'
                    : choiceNeeded === 0
                      ? 'Shuffle and continue'
                    : pendingDef?.effects.some((effect) => effect.kind === 'searchDrawAndPlayTwice')
                    ? 'Play selected card twice and shuffle'
                    : `Put selected card${choiceNeeded === 1 ? '' : 's'} in hand and shuffle`
                : pending.choice.kind === 'load' || pending.choice.kind === 'loadAny'
                  ? pending.picked.length === 0 ? 'Load none' : `Load ${pending.picked.length} card${pending.picked.length === 1 ? '' : 's'}`
                : choiceNeeded === 0 ? 'Continue' : `Discard selected card${choiceNeeded === 1 ? '' : 's'}`}
            </button>
          {(pending.cardInHand || pending.chamberPlay) &&
            (pending.choice.kind === 'recover' || pending.choice.kind === 'recoverExhaust') ? (
              <button type="button" className="prompt__cancel" onClick={() => setPending(null)}>Cancel</button>
            ) : null}
          </div>
        </dialog>
      ) : null}

      {endTurnEffect ? (
        <section className="end-turn-effects" aria-live="polite" aria-label="End-turn effect">
          <p className="end-turn-effects__prompt">
            {canResolveEndTurn
              ? endTurnEffectPrompt
              : `Waiting for ${state.players.find((player) => player.id === endTurnEffect.playerId)?.name ?? 'its owner'} to target ${endTurnEffect.label}`}
          </p>
          {endTurnEffectCard ? (
            <Card
              className="end-turn-effect end-turn-effect--card"
              card={endTurnEffectCard}
              playable={canResolveEndTurn && endTurnChoiceTargets.length === 0}
              selected={armedEndTurnAbilityId === endTurnEffect.id ||
                (endTurnEffect.orbChoice && endTurnEffectDrag?.targetUid != null)}
              onClick={endTurnChoiceTargets.length === 0 ? () => activateEndTurnEffect(endTurnEffect) : undefined}
              onPointerDown={endTurnChoiceTargets.length === 0 && !endTurnEffect.orbChoice
                ? (event) => onEndTurnEffectPointerDown(endTurnEffect, event) : undefined}
              onPointerMove={endTurnChoiceTargets.length === 0 && !endTurnEffect.orbChoice
                ? onEndTurnEffectPointerMove : undefined}
              onPointerUp={endTurnChoiceTargets.length === 0 && !endTurnEffect.orbChoice
                ? finishEndTurnEffectDrag : undefined}
              onPointerCancel={endTurnChoiceTargets.length === 0 && !endTurnEffect.orbChoice
                ? cancelEndTurnEffectDrag : undefined}
              onLostPointerCapture={endTurnChoiceTargets.length === 0 && !endTurnEffect.orbChoice
                ? cancelEndTurnEffectDrag : undefined}
            />
          ) : (
            <button
              type="button"
              className={`end-turn-effect end-turn-effect--${endTurnEffectSlimeAsset ? 'slime' : 'orb'}`}
              disabled={!canResolveEndTurn}
              aria-label={`Resolve ${endTurnEffect.label}`}
              aria-pressed={armedEndTurnAbilityId === endTurnEffect.id}
              onClick={() => activateEndTurnEffect(endTurnEffect)}
              onPointerDown={(event) => onEndTurnEffectPointerDown(endTurnEffect, event)}
              onPointerMove={onEndTurnEffectPointerMove}
              onPointerUp={finishEndTurnEffectDrag}
              onPointerCancel={cancelEndTurnEffectDrag}
              onLostPointerCapture={cancelEndTurnEffectDrag}
            >
              {endTurnEffectSlimeAsset
                ? <img className="end-turn-effect__slime" src={endTurnEffectSlimeAsset} alt="" />
                : <span className={`token--orb token--orb-${endTurnEffect.visual?.kind === 'orb'
                  ? endTurnEffect.visual.orb
                  : 'lightning'}`} aria-hidden="true" />}
            </button>
          )}
          {endTurnChoiceTargets.length > 0 ? (
            <div className="end-turn-effects__choices" role="group" aria-label={`Resolve ${endTurnEffect.label}`}>
              {endTurnChoiceTargets.map((target) => (
                <button key={target.uid} type="button" onClick={() => resolveEndTurnTarget(endTurnEffect.id, target.uid)}>
                  {target.label}
                </button>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      <div
        className="board"
        data-rows={rows.length}
        data-crowded={livingEnemies(state).length >= 3 || undefined}
        data-hexaghost-attack-assets-ready={hexaghostAttackBlobs.size || undefined}
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
                enemies={state.enemies}
                label={enemyLabel(state.enemies, enemy)}
                die={state.die}
                acting={state.phase === 'enemy' && !prefersReducedMotion}
                animateBoss={!prefersReducedMotion}
                deferBossAttack={characterAttacksActive}
                falling={falling.has(enemy.uid)}
                visualContactMs={prefersReducedMotion ? 0 : targetPresentationTimings.get(enemy.uid)?.contact}
                visualEventSeq={targetPresentationTimings.get(enemy.uid)?.event?.seq}
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
                rangedTargetPlayerIds={livingPlayers.map((player) => player.id)}
                stageIndex={stageEnemies.length + index}
                // A boss stands in every row, so the only reading that means
                // anything to the person looking at the screen is their own.
                defender={viewer}
                disabled={Boolean(pendingStartEnemy?.id.startsWith('facing:') && !startEnemyChoiceAvailable(enemy.uid))}
                targeted={(isEndTurnEnemyTarget(enemy) ||
                  cardDrag?.targetUid === enemy.uid ||
                  cardDragTargetRow !== undefined && (cardDragTargetRow === enemy.row || enemy.isBoss) ||
                  isStartTurnEnemyTarget(enemy.uid) ||
                  (pendingTrigger?.playerId === viewer.id &&
                    (pendingTrigger.targets?.some((target) => target.uid === enemy.uid) ||
                      triggerSlimeEnemyUids.length < triggerSlimeEnemyAmount)) ||
                  isEnemyRowClickTargetable(enemy) ||
                  ((pendingPotionDef?.target === 'enemy' || pendingPowerNeedsEnemy || (pendingPowerDef && pendingPowerDef.target !== 'row' &&
                    (!pendingHermitPower || pendingPowerDef.id === 'hermit_black_wind' && powerLoadUids.length === 1)) || pendingPotionOverflow > 0) || spendingShiv || spendingSoulburn ||
                  Boolean(pending && (pending.slimeEnemyUids.length < slimeEnemyChoicesRequired(pending) ||
                    pending.hermitEnemyUids.length < loadedTargetCount(pending) ||
                    pending.soulburnEnemyUids.length < pending.soulburnChoices)) || (
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
          const slimeSpawnEvent = !prefersReducedMotion && occupant?.character === 'slime_boss'
            ? livePresentationEvents.filter((event) => event.kind === 'card' &&
                event.actorId === occupant.id && occupant.slimes.some((slime) => slime.card.defId === event.sourceId)).at(-1)
            : undefined
          const slimeCommandEvents = new Map(livePresentationEvents.flatMap((event) =>
            event.kind === 'slime' && event.actorId === occupant?.id
              ? [[event.slimeUid, event] as const]
              : []))
          const occupantHeat = occupant?.character === 'hexaghost'
            ? Math.max(0, Math.min(6, occupant.heat))
            : 0
          const hexaghostAttackAsset = assetPath(
            `combat/characters/hexaghost-heat-${occupantHeat}-attack.webp`,
          )
          return (
            <div
              className={['row', occupant?.id === viewerId ? 'row--viewer' : ''].filter(Boolean).join(' ')}
              key={row}
              ref={occupant?.id === viewerId ? viewerRowRef : undefined}
              style={{ '--stage-row': rows.indexOf(row) } as React.CSSProperties}
            >
              <div className="row__seat">
                {occupant ? (
                  <>
                    <div className="seat__interactive" data-player-id={occupant.id}
                      onPointerDown={(event) => onEndTurnOrbPointerDown(occupant, event)}
                      onPointerMove={onEndTurnEffectPointerMove}
                      onPointerUp={finishEndTurnEffectDrag}
                      onPointerCancel={cancelEndTurnEffectDrag}
                      onLostPointerCapture={cancelEndTurnEffectDrag}>
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
                          pendingPowerNeedsAlly ||
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
                        '--silent-attack-duration': `${1900 + Math.max(0,
                          ...characterAttackMotions.map((attack) => attack.targets.length - 1)) * 70}ms`,
                      } as React.CSSProperties : undefined}
                      aria-label={describeSeat(occupant)}
                    >
                      <span className="seat__portrait" aria-hidden="true">
                        {occupant.character === 'watcher' && occupant.stance !== 'neutral' ? (
                          <span className={`stance-aura stance-aura--${occupant.stance}`} />
                        ) : null}
                        {occupant.character === 'guardian' && occupant.guardianMode ? (
                          <GuardianPortrait
                            mode={occupant.guardianMode}
                            animate={!prefersReducedMotion}
                            restartKey={characterAttack?.active.event.seq ?? latestActorVfx?.event.seq ?? 'idle'}
                          />
                        ) : (
                          <img
                            key={`${occupant.character}-${occupantHeat}-${slimeSpawnEvent?.seq ?? characterAttack?.active.event.seq ?? latestActorVfx?.event.seq ?? 'idle'}`}
                            src={assetPath(occupant.character === 'hexaghost'
                              ? `combat/characters/hexaghost-heat-${occupantHeat}.webp`
                              : occupant.character === 'slime_boss' && slimeSpawnEvent
                                ? 'combat/characters/slime_boss-spawn.webp'
                              : `combat/characters/${occupant.character}.webp`)}
                            data-vfx-seq={latestActorVfx?.event.seq}
                            alt=""
                            onError={(event) => {
                              if (occupant.character === 'slime_boss' && slimeSpawnEvent &&
                                event.currentTarget.dataset.fallback !== 'true') {
                                event.currentTarget.dataset.fallback = 'true'
                                event.currentTarget.src = assetPath('combat/characters/slime_boss.webp')
                              } else event.currentTarget.style.display = 'none'
                            }}
                          />
                        )}
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
                            {occupant.character !== 'hexaghost' &&
                            DOWNFALL_CHARACTER_IDS.includes(occupant.character as (typeof DOWNFALL_CHARACTER_IDS)[number]) &&
                            characterAttack.active.event.seq === latestCharacterAttackSeq ? (
                              <>
                                <span className="character-attack__pose character-attack__pose--downfall-ready">
                                  <img src={assetPath(`combat/characters/${occupant.character}-ready.webp`)} alt="" />
                                </span>
                                <span className="character-attack__pose character-attack__pose--downfall-impact">
                                  <img src={assetPath(`combat/characters/${occupant.character}-impact.webp`)} alt="" />
                                </span>
                              </>
                            ) : null}
                            {occupant.character === 'hexaghost' &&
                            characterAttack.active.event.seq === latestCharacterAttackSeq ? (
                              <HexaghostAttackPose
                                key={characterAttack.active.event.seq}
                                attackSeq={characterAttack.active.event.seq}
                                assetPath={hexaghostAttackAsset}
                                fallbackAsset={assetPath(`combat/characters/hexaghost-heat-${occupantHeat}.webp`)}
                                asset={hexaghostAttackBlobs.get(hexaghostAttackAsset)}
                              />
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
                            {occupant.character === 'hexaghost'
                              ? characterAttack.targets.map((target, index) => (
                                <span
                                  className="character-attack__hexaghost-flame"
                                  data-attack-target-id={target.id}
                                  key={target.id}
                                  style={{
                                    '--attack-target-x': `${target.x}px`,
                                    '--attack-target-y': `${target.y}px`,
                                    '--attack-delay': `${index * 70}ms`,
                                  } as React.CSSProperties}
                                >
                                  <img src={assetPath('combat/vfx/actions/hexaghost-flame.webp')} alt="" />
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
                      {occupant.character === 'guardian' && occupant.guardianMode ? (
                        <span className="seat__mechanic">Vigor {occupant.vigor}</span>
                      ) : null}
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
                    {occupant.character === 'slime_boss' && occupant.slimes.length > 0 ? (
                      <span className="slime-party combat__slime-status" role="list"
                        aria-label={`${occupant.name}'s Slimes`}>
                        {occupant.slimes.map((slime) => {
                          const def = faceOf(cardDef(slime.card.defId), slime.card.upgraded)
                          const name = def.name.replace(/ Slime\+?$/, '')
                          const commandReady = def.slimeCommandLimit === undefined ||
                            slime.commandsThisTurn < def.slimeCommandLimit
                          const commandText = slimeCommandText(def, slime.level)
                          const slug = slimeAssetSlug(def.id)
                          const commandEvent = prefersReducedMotion
                            ? undefined
                            : slimeCommandEvents.get(slime.card.uid)
                          const commandMotion = occupant
                            ? slimeCommandMotions[`${occupant.id}:${slime.card.uid}`]
                            : undefined
                          const activeCommandMotion = commandEvent && commandMotion?.seq === commandEvent.seq
                            ? commandMotion
                            : undefined
                          const activeCommandEvent = activeCommandMotion ? commandEvent : undefined
                          return <span
                              key={`${slime.card.uid}:${activeCommandEvent?.seq ?? 'idle'}`}
                              className={[
                                'slime-party__actor combat__slime-chip',
                                commandReady ? '' : 'slime-party__actor--spent',
                                activeCommandEvent ? 'slime-party__actor--commanding' : '',
                              ].filter(Boolean).join(' ')}
                              role="listitem"
                              tabIndex={0}
                              onMouseEnter={(event) => showSlimeCard(slime.card, event.currentTarget)}
                              onMouseLeave={hideSlimeCard}
                              onFocus={(event) => showSlimeCard(slime.card, event.currentTarget)}
                              onBlur={hideSlimeCard}
                              data-slime-uid={slime.card.uid}
                              data-slime-def={def.id}
                              data-slime-level={slime.level}
                              data-slime-vigor={slime.vigor > 0 ? `+${slime.vigor}` : ''}
                              style={activeCommandMotion ? {
                                '--slime-command-x': `${activeCommandMotion.x}px`,
                                '--slime-command-y': `${activeCommandMotion.y}px`,
                              } as React.CSSProperties : undefined}
                              aria-label={`${def.name}, level ${slime.level}, Strength ${slime.vigor}, ` +
                                `${slime.commandsThisTurn} Commands this turn, ` +
                                `${commandReady ? 'ready to Command' : 'Command limit reached'}, ` + commandText}>
                              <img
                                className="slime-party__art"
                                src={assetPath(`combat/slimes/${slug}.webp`)}
                                alt=""
                                onError={(event) => {
                                  if (event.currentTarget.dataset.fallback === 'true') {
                                    event.currentTarget.style.display = 'none'
                                    return
                                  }
                                  event.currentTarget.dataset.fallback = 'true'
                                  event.currentTarget.src = assetPath(slimeFallbackAsset(def.id))
                                }}
                              />
                              {activeCommandEvent ? (
                                <img
                                  className="slime-party__command"
                                  key={activeCommandEvent.seq}
                                  data-command-seq={activeCommandEvent.seq}
                                  src={assetPath(`combat/slimes/${slug}-command.webp`)}
                                  alt=""
                                  onError={(event) => {
                                    event.currentTarget.style.display = 'none'
                                    const idle = event.currentTarget.parentElement?.querySelector<HTMLElement>('.slime-party__art')
                                    if (idle) idle.style.opacity = '1'
                                  }}
                                />
                              ) : null}
                              <span className="slime-party__level" aria-hidden="true">{slime.level}</span>
                              <span className="slime-party__summary" aria-hidden="true">
                                {name} · L{slime.level} · Strength {slime.vigor} · Cmd {slime.commandsThisTurn}
                              </span>
                            </span>
                        })}
                      </span>
                    ) : null}
                    <OrbRow
                      player={occupant}
                      targetableSlots={endTurnEffect?.orbChoice && canResolveEndTurn && occupant.id === endTurnEffect.playerId
                        ? endTurnEffect.targets?.flatMap((target) => {
                          const slot = Number(target.uid.slice(4))
                          return target.uid.startsWith('orb:') && Number.isInteger(slot) ? [slot] : []
                        })
                        : []}
                      onTarget={(slot) => {
                        const targetUid = endTurnTargetForOrb(occupant.id, slot)
                        if (targetUid && suppressEndTurnOrbClick.current === targetUid) {
                          suppressEndTurnOrbClick.current = null
                          return
                        }
                        if (targetUid && armedEndTurnAbilityId === endTurnEffect?.id) {
                          resolveEndTurnTarget(endTurnEffect.id, targetUid)
                        }
                      }}
                    />
                    </div>
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
                      enemies={state.enemies}
                      label={enemyLabel(state.enemies, enemy)}
                      die={state.die}
                      falling={falling.has(enemy.uid)}
                      visualContactMs={prefersReducedMotion ? 0 : targetPresentationTimings.get(enemy.uid)?.contact}
                      visualEventSeq={targetPresentationTimings.get(enemy.uid)?.event?.seq}
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
                      targeted={(isEndTurnEnemyTarget(enemy) ||
                        cardDrag?.targetUid === enemy.uid ||
                        cardDragTargetRow !== undefined && (cardDragTargetRow === enemy.row || enemy.isBoss) ||
                        isStartTurnEnemyTarget(enemy.uid) ||
                        (pendingTrigger?.playerId === viewer.id &&
                          (pendingTrigger.targets?.some((target) => target.uid === enemy.uid) ||
                            triggerSlimeEnemyUids.length < triggerSlimeEnemyAmount)) ||
                        isEnemyRowClickTargetable(enemy) ||
                        ((pendingPotionDef?.target === 'enemy' || pendingPowerNeedsEnemy || (pendingPowerDef && pendingPowerDef.target !== 'row' &&
                          (!pendingHermitPower || pendingPowerDef.id === 'hermit_black_wind' && powerLoadUids.length === 1)) || pendingPotionOverflow > 0) || spendingShiv || spendingSoulburn ||
                        Boolean(pending && (pending.slimeEnemyUids.length < slimeEnemyChoicesRequired(pending) ||
                          pending.hermitEnemyUids.length < loadedTargetCount(pending) ||
                          pending.soulburnEnemyUids.length < pending.soulburnChoices)) || (
                        ((pendingEvokeTarget < 0 && pending?.needsEnemy === true && !enemyChoicesDone) ||
                          (pendingEvokeTarget >= 0 && !pendingEvokeUsesRows && pendingEvokeTargetUids.has(enemy.uid))) && choiceSatisfied
                      ))) && !enemy.dead}
                      onClick={onEnemyClick}
                    />
                  ))
                ) : null}
                {foes.length === 0 && isRowLaneClickTargetable(row) ? (
                  // Every enemy that was ever placed here has died (or none
                  // were), so there is nothing left to click as an anchor —
                  // this is the one case `onEnemyClick` can't cover. The
                  // engine still folds the boss into whichever row is chosen
                  // regardless (`resolveEnemyTargets`'s `'row'` scope), so
                  // this row remains a legal, sometimes-useful choice (e.g.
                  // hitting only the boss without also hitting a still-living
                  // enemy elsewhere).
                  <button
                    type="button"
                    className="row__lane-target"
                    onClick={() => onRowLaneClick(row)}
                  >
                    {rowLaneClickLabel(row)}
                  </button>
                ) : null}
              </div>
            </div>
          )
        })}
      </div>

      {viewer && dieRelicPending?.playerId === viewer.id ? (() => {
        const ability = chosenDieRelicAbilities(relicDef(dieRelicPending.relicDefId))[dieRelicPending.abilityIndex]
        const effect = ability?.effects.find((candidate) =>
          candidate.kind === 'discard' || candidate.kind === 'exhaustFromHand')
        if (!effect || effect.kind !== 'discard' && effect.kind !== 'exhaustFromHand') return null
        const required = Math.min(effect.amount, viewer.hand.length)
        const discard = effect.kind === 'discard'
        const optional = ability?.optional === true
        return <section className="hermit-prompt hermit-prompt--cards" aria-label="Die Relic card choice">
          <strong>{relicDef(dieRelicPending.relicDefId).name}: {optional ? 'you may ' : ''}
            {discard ? 'discard' : 'Exhaust'} {required}</strong>
          {viewer.hand.map((card) => {
            const selected = dieRelicCardUids.includes(card.uid)
            return <Card key={card.uid} card={card} selected={selected} onClick={() => setDieRelicCardUids((current) =>
              selected ? current.filter((uid) => uid !== card.uid) : current.length < required
                ? [...current, card.uid] : current)} />
          })}
          <button type="button" disabled={!optional && dieRelicCardUids.length !== required ||
            optional && dieRelicCardUids.length !== 0 && dieRelicCardUids.length !== required}
            onClick={() => submitDieRelicChoice(discard)}>
            {optional && dieRelicCardUids.length === 0 ? 'Skip' : `Resolve ${relicDef(dieRelicPending.relicDefId).name}`}
          </button>
        </section>
      })() : null}

      {hermitSetupPending ? <p className="visually-hidden" role="status"
        aria-label="Hermit start-of-combat Load">Choose a card in hand to Load</p> : null}
      {hermitSetupPending && viewer.hand.some((card) => hermitTargetedCurses.has(card.defId)) &&
      livingEnemies(state).length > 1 ? (
        <section className="prompt" aria-label="Hermit start-of-combat Load target">
          <span>Choose a target for the Curse to Load</span>
          {viewer.hand.filter((card) => hermitTargetedCurses.has(card.defId)).map((card) =>
            livingEnemies(state).map((enemy) => (
              <button key={`${card.uid}-${enemy.uid}`} type="button" className="prompt__mode"
                onClick={() => submitHermitSetup(card, enemy.uid)}>
                {cardDef(card.defId).name} → {enemyLabel(state.enemies, enemy)}
              </button>
            )))}
        </section>
      ) : null}
      {viewer && hermitStrengthPending ? (
        <section className="prompt" aria-label="Dead or Alive reward">
          <strong>Dead or Alive: choose a player to gain 1 Strength</strong>
          {state.players.filter((player) => !player.dead).map((player) => (
            <button key={player.id} type="button" className="prompt__mode"
              onClick={() => submitHermitStrength(player.id)}>{player.name}</button>
          ))}
        </section>
      ) : null}
      <footer className="hand-area" data-character={viewer.character}
        data-has-chamber={viewer.chamberSlots > 0 || undefined}>
        <div className="hand-area__stats">
          <span className={[
            'pip',
            'pip--energy',
            motionActive.has('energy') ? `motion-pulse-${motionBeats.energy % 2}` : '',
          ].filter(Boolean).join(' ')} data-character={viewer.character}
          data-guardian-mode={viewer.guardianMode ?? undefined} data-empty={viewer.energy === 0 || undefined}
          title="Energy">
            {downfallCharacter ? <span className="energy-orb__layers" aria-hidden="true">
              {downfallEnergyOrbLayers(downfallCharacter, viewer.energy === 0).map(({ layer, src }) =>
                <img key={layer} data-layer={layer} src={src} alt="" />)}
            </span> : null}
            <IconValue name="energy" value={viewer.energy} size={26} />
          </span>
          {viewer.chamberSlots > 0 ? (
            <button ref={chamberTriggerRef} type="button" className={[
              'hermit-chamber-trigger',
              chamberContact ? 'hermit-chamber-trigger--contact' : '',
            ].filter(Boolean).join(' ')}
              aria-expanded={chamberOpen}
              aria-label={`Chamber, ${viewer.chamber.length} of ${viewer.chamberSlots} slots filled`}
              title={chamberClosing ? 'Returning Chamber cards' : chamberOpen
                ? 'Return Chamber cards' : 'Show Chamber cards'}
              disabled={chamberClosing}
              onClick={toggleChamber}>
              <img src={assetPath(chamberOpen || chamberClosing || viewer.chamber.length === 0
                ? 'icons/hermit-chamber.png'
                : 'icons/hermit-chamber-loaded.png')} alt="" />
              <span aria-hidden="true">{viewer.chamber.length}/{viewer.chamberSlots}</span>
            </button>
          ) : null}
          {requiredChamberCard && requiredChamberUnplayable ? (
            <button type="button" className="prompt__mode hermit-chamber-skip"
              onClick={() => skipUnplayableHermitChamber(requiredChamberCard)}>
              Skip unplayable {cardDef(requiredChamberCard.defId).name}
            </button>
          ) : null}
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
        <div ref={handScrollRef} className="hand-scroll" onWheel={(event) => {
          event.currentTarget.scrollLeft += event.deltaX || (event.shiftKey ? event.deltaY : 0)
        }}><div ref={handRef} className="hand" data-count={visibleHand.length}>
          {visibleHand.map((card, index) => {
            const chamberCard = visibleChamberUids.has(card.uid)
            const required = chamberCard && requiredHermitChamberCard?.playerId === viewer.id &&
              requiredHermitChamberCard.cardUids[0] === card.uid
            const staged = chamberCard
              ? stageHermitChamberViewer(viewer, card, required && requiredHermitChamberCard?.free)
              : null
            const cardViewer = staged?.player ?? viewer
            const displayedCard = staged?.card ?? card
            const attachedGemId = guardianGemForCard(viewer, card)
            const shownCard = attachedGemId === card.attachedGemId ? card : { ...card, attachedGemId }
            const def = effectiveCombatCardDef(faceOf(cardDef(card.defId), card.upgraded), cardViewer.guardianMode)
            const setupTarget = !chamberCard && hermitSetupPending && hermitTargetedCurses.has(card.defId)
              ? livingEnemies(state).length === 1 ? livingEnemies(state)[0] : undefined
              : null
            const setupPlayable = !chamberCard && hermitSetupPending &&
              (!hermitTargetedCurses.has(card.defId) || Boolean(setupTarget))
            const chamberCancelable = chamberCard && pending?.chamberPlay && pending.card.uid === card.uid &&
              (pending.choicePreviewPending || !pending.choiceCards || pending.choice?.kind === 'recover' ||
                pending.choice?.kind === 'recoverExhaust')
            const chamberPlayable = chamberCard && !chamberClosing &&
              (chamberCardCanStartDrag(card) || chamberCancelable)
            return <Card
              key={card.uid}
              className={[drawnCards.has(card.uid) ? 'card--drawn' : '',
                cardDrag?.card.uid === card.uid ? 'card--dragging' : '',
                chamberCard ? 'card--chamber-drawn' : '',
                setupPlayable ? 'card--load-choice' : ''].filter(Boolean).join(' ') || undefined}
              style={{ '--deal-index': index } as React.CSSProperties}
              fan={fanOf(index, visibleHand.length)}
              card={chamberCard ? displayedCard : shownCard}
              gemPowerDamage={attachedGemId !== card.attachedGemId || undefined}
              cost={card.uid === forcedCardUid ? 0 : playCost(def, cardViewer, displayedCard)}
              playable={chamberCard ? chamberPlayable : hermitSetupPending ? setupPlayable :
                !usingCard &&
                !pendingTrigger &&
                !endTurnResolving &&
                (!voluntaryActionsBlocked || card.uid === forcedCardUid) &&
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
              onClick={chamberCard
                ? () => {
                  if (suppressCardClick.current === card.uid) {
                    suppressCardClick.current = null
                    return
                  }
                  if (chamberCancelable) {
                    setPending(null)
                    return
                  }
                  submitHermitChamber(card, cardNeedsEnemy(def, cardViewer, true, undefined, false,
                    undefined, displayedCard.uid, chargedCardEnergy(def, cardViewer, displayedCard),
                    displayedCard.hermitDeadOn === true) &&
                    livingEnemies(state).length === 1 ? livingEnemies(state)[0]?.uid ?? null : null)
                }
                : hermitSetupPending
                ? () => setupPlayable && submitHermitSetup(card, setupTarget?.uid ?? null)
                : activateCard}
              onPointerDown={hermitSetupPending && !chamberCard
                ? undefined
                : (event) => onCardPointerDown(card, event, chamberCard)}
              onPointerMove={hermitSetupPending && !chamberCard ? undefined : onCardPointerMove}
              onPointerUp={hermitSetupPending && !chamberCard ? undefined : finishCardDrag}
              onPointerCancel={hermitSetupPending && !chamberCard ? undefined : cancelCardDrag}
              onLostPointerCapture={hermitSetupPending && !chamberCard ? undefined : cancelCardDrag}
            />
          })}
        </div></div>
      </footer>
      {slimeCardZoom ? createPortal(
        <span className="power__zoom slime-party__zoom" role="tooltip"
          style={{ left: slimeCardZoom.x, top: slimeCardZoom.y }}>
          <Card card={slimeCardZoom.card} playable={false} />
        </span>,
        document.body,
      ) : null}
      {chamberReturnFlights.map((flight) => (
        <div key={flight.card.uid} className="chamber-return-flight" style={{
          left: flight.left,
          top: flight.top,
          width: flight.width,
          height: flight.height,
          '--chamber-return-x': `${flight.x}px`,
          '--chamber-return-y': `${flight.y}px`,
          '--chamber-return-index': flight.index,
        } as React.CSSProperties} aria-hidden="true" inert>
          <Card card={flight.card} playable={false} />
        </div>
      ))}
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
      {endTurnEffectDrag ? (
        <>
          <svg className="card-target-arrow end-turn-target-arrow" aria-hidden="true">
            <defs>
              <marker id="end-turn-target-arrowhead" markerUnits="userSpaceOnUse"
                markerWidth="22" markerHeight="22" refX="18" refY="11" orient="auto">
                <path d="M 0 0 L 22 11 L 0 22 Z" />
              </marker>
            </defs>
            <path ref={endTurnEffectDragArrowShadow} className="card-target-arrow__shadow"
              d={`M ${endTurnEffectDrag.startX} ${endTurnEffectDrag.startY + (endTurnEffectDrag.y < endTurnEffectDrag.startY ? -28 : 28)} Q ${endTurnEffectDrag.startX} ${endTurnEffectDrag.y} ${endTurnEffectDrag.x} ${endTurnEffectDrag.y}`} />
            <path ref={endTurnEffectDragArrow} className="card-target-arrow__line end-turn-target-arrow__line"
              d={`M ${endTurnEffectDrag.startX} ${endTurnEffectDrag.startY + (endTurnEffectDrag.y < endTurnEffectDrag.startY ? -28 : 28)} Q ${endTurnEffectDrag.startX} ${endTurnEffectDrag.y} ${endTurnEffectDrag.x} ${endTurnEffectDrag.y}`} />
          </svg>
          <div ref={endTurnEffectDragOverlay}
            className={endTurnEffectDragCard ? 'end-turn-effect-drag end-turn-effect-drag--card' : 'end-turn-effect-drag'}
            style={{ left: endTurnEffectDrag.startX, top: endTurnEffectDrag.startY } as React.CSSProperties}
            aria-hidden="true" inert>
            {endTurnEffectDragCard ? <Card card={endTurnEffectDragCard} playable={false} />
              : endTurnEffectDragSlimeAsset ? (
                <img className="end-turn-effect__slime" src={endTurnEffectDragSlimeAsset} alt="" />
              ) : (
              <span className={`token--orb token--orb-${endTurnEffectDrag.sourceOrb ?? (endTurnEffectDrag.ability.visual?.kind === 'orb'
                ? endTurnEffectDrag.ability.visual.orb
                : 'lightning')}`} />
            )}
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
