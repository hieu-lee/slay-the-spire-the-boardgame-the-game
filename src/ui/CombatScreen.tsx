import { warmSmokeTrails } from './combat-screen/SmokeTrail.tsx'
import { cardFlightPath } from './combat-screen/card-flight.ts'
import { unknownPowerRefreshDecision } from './combat-screen/unknown-power.ts'
import { CombatBar } from './combat-screen/CombatBar.tsx'
import { CombatChoiceDialogs, CombatPotionDialogs, PlayerChoiceDiscardDialog } from './combat-screen/CombatDialogs.tsx'
import { CombatStage, GroundedCombatVfx } from './combat-screen/CombatStage.tsx'
import { FloatingOverlays } from './combat-screen/FloatingOverlays.tsx'
import { HandArea } from './combat-screen/HandArea.tsx'
import { slimeAssetSlug } from './combat-screen/portraits.tsx'
import {
  beforeDrawPrompt as deriveBeforeDrawPrompt,
  dieRelicPrompt as deriveDieRelicPrompt,
  enemyPrompt as deriveEnemyPrompt,
  forcedPrompt as deriveForcedPrompt,
  playWindowPrompt as derivePlayWindowPrompt,
  playerChoicePrompt as derivePlayerChoicePrompt,
  plunderPrompt as derivePlunderPrompt,
  prompt as derivePrompt,
  startTurnPrompt as deriveStartTurnPrompt,
  triggerPrompt as deriveTriggerPrompt,
} from './combat-screen/prompts.ts'
import { useAttackPosePreload } from './combat-screen/useAttackPosePreload.ts'
import { useCombatDrag } from './combat-screen/useCombatDrag.ts'
import { useModalDialog } from './combat-screen/useModalDialog.ts'
import { useStageLayout } from './combat-screen/useStageLayout.ts'
// The combat screen: orchestrates combat state, actions, and presentation while
// delegating layout, drag interactions, asset preloading, modal lifecycle,
// prompt derivation, and UI regions to cohesive modules under combat-screen/.
import { enemyAbilities, enemyDef } from '../game/enemies.ts'
import { hasStagedAttack, playerVisualId, skinTraits } from '../game/skins.ts'
import {
  canAfford,
  cardShivsOnPlay,
  chargedCardEnergy,
  gainedShivs,
  pendingFor,
  requirementsOf,
  rowsOf,
  stageHermitChamberViewer,
  targetPresentationTiming,
} from './combat-screen/helpers.ts'
import {
  useCardHints,
  useCombatSoundEffects,
  useFalling,
  usePersonalCombatSoundEffects,
  usePresentationEvents,
  useReducedEffects,
  useStruck,
} from './combat-screen/hooks.ts'
import type {
  ActiveCombatVfx,
  CardFlight,
  ChamberReturnFlight,
  CharacterAttackMotion,
  CombatScreenProps,
  MotionKey,
  MotionSnapshot,
  Pending,
  PendingStartChoice,
  SlimeCardZoom,
  UnknownCardAction,
  UnknownPotionAction,
  UnknownPowerAction,
} from './combat-screen/types.ts'
import {
  CombatVfx,
  stagedAttackOf,
  characterAttackContactMs,
  isCharacterAttack,
  ORB_END_TURN_STAGGER_MS,
  isEndTurnLightning,
} from './combat-screen/vfx.tsx'
import { assetPath, relicIconPath } from '../game/assets.ts'
import { cardDef, faceOf } from '../game/cards.ts'
import {
  activeCardPlayWindow,
  activatePotion,
  activatePower,
  activateRelic,
  beginEndTurnResolution,
  scryPlayCardPlayable,
  finishCardPlayWindow,
  canActivatePotion,
  canActivateRelic,
  cardCanBeForced,
  cardEnemyChoiceCount,
  cardHasRetain,
  cardModeIsAvailable,
  cardNeedsChoicePreview,
  cardNeedsEnemy,
  cardPlayConditionMet,
  cardPlayerChoiceCount,
  cardReferencesGuardianMode,
  cardShivChoiceCount,
  chosenEvokeOrbs,
  evokePlan,
  chooseEndTurnTarget,
  parseSelfExhaustEndTurnTarget,
  selfExhaustEndTurnTarget,
  combatRowLabel,
  defaultStartTurnChoices,
  discardNeedsChoice,
  discardTopNeedsChoice,
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
  metamorphosisCost,
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
  powerActivationAllowed,
  previewCardChoice,
  previewCardShivTargets,
  previewCardDamage,
  previewCardCopyChoice,
  previewHermitChamberCardChoice,
  previewPowerChoice,
  reachesEnemy,
  reachedTimeWarpLimit,
  slimeChoiceIsAvailable,
  slimeCommandEnemyChoiceLabels,
  resolvePendingTrigger,
  resolveEndTurnAbility,
  resolvePendingDieRelicChoice,
  resolvePendingPlayerChoice,
  lapseStrandedPlayerChoices,
  owedPlayerChoices,
  resolveDeterministicForcedCard,
  resolveHermitSetupLoad,
  resolveHermitStrengthReward,
  resolvePlunderRowSwitch,
  resolveStartPlayerTurn,
  resolveStartTurnDiscard,
  resolveStartTurnScry,
  spendShiv,
  spendSoulburn,
  startPlayerTurnWithChoices,
  startTurnAbilities,
  startTurnChoicePending,
  startTurnDiscardPreview,
  isPostRollStartTurnPotionChoice,
  isPostRollStartTurnRelicChoice,
  startTurnNeedsChoice,
  startTurnScryAbilities,
  startTurnScryPreview,
  adjacentDamageChoiceCount,
  adjacentEnemies,
  cardDefForTarget,
  resolveSlayerChoice,
} from '../game/combat.ts'
import type {
  CardDamagePreview,
  CombatState,
  DiscardOrders,
  EndTurnAbility,
  PlayerChoiceAnswer,
  PotionContext,
  PowerContext,
  RelicContext,
  StartTurnChoice,
} from '../game/combat.ts'
import { chosenDieRelicAbilities, potionDef, relicDef } from '../game/relics.ts'
import { DieRelicChoiceList, dieRelicChoices } from './DieRelicChoices.tsx'
import { CAPS, DOWNFALL_CHARACTER_IDS } from '../game/types.ts'
import type { CardInstance, Enemy, Player } from '../game/types.ts'
import type { ActionOutcome, VisiblePlayer } from '../multiplayer/useRoomSession.ts'
import { Card } from './Card.tsx'
import { relicTooltipText } from './RelicChip.tsx'
import { PotionTooltipAnchor } from './PotionIcon.tsx'
import {
  registerCardZoomCloser,
  releaseCardZoom,
  tryClaimCardZoom,
} from './PowerRow.tsx'
import {
  STAGE_GAP_REM,
  STAGE_MARGIN_REM,
  cardMotionDestination,
  drawnCardUids,
  livingEnemiesInStageOrder,
  pendingUiSurvivesContext,
  shouldDisarmCardFlight,
} from './board-signals.ts'
import { enemyAttackTargetPlayerIds, enemyAttackArrivalMsFor, cardVfxRecipe, orbVfxRecipe, potionVfxRecipe, shivVfxRecipe, turnEffectVfxRecipe } from './combat-vfx.ts'
import { combatBodyPoint } from './combat-geometry.ts'
import { playSoundEffect } from './sfx.ts'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { courierReady } from './CourierPanel.tsx'

// Weighted alpha PCA of watcher-meteor.webp: tail-to-nose y/x.
const WATCHER_METEOR_FALL_SLOPE = 0.70505085 / 0.70915675
const CHAMBER_RETURN_MS = 460
const CHAMBER_RETURN_STAGGER_MS = 35
const CHAMBER_REFLOW_MS = 420
const START_TURN_STUCK_MS = 15_000

function CombatScreenView({
  state,
  act,
  viewerId,
  onChange,
  onAction,
  autoAdvance = true,
  autoEndTurn = true,
  courierUsedBy,
  onCourierReveal,
  mutationsEnabled = true,
  drawCount,
  viewerStanceChangedThisTurn,
  decidedPlayerIds,
  requiredEndTurnPlayerIds,
  endTurnTopPlayerIds,
  startTurnDecidedPlayerIds,
  requiredStartTurnPlayerIds,
  savedDiscardOrder,
  partyEndTurnAbilities,
  partyStartTurnAbilities,
  partyStartTurnScryAbilities,
  startTurnCoordinatorId,
  startTurnChoiceId,
  savedStartTurnEnemyTargets,
  savedStartTurnChoices: serverStartTurnChoices,
  partyStartTurnPostRollLocked = false,
  partyStartTurnOrderPending = false,
  partyStartTurnOrderLocked = false,
  partyStartTurnScry,
  partyStartTurnDiscard,
  cardPreview,
  powerPreview,
  authoritativePendingTrigger,
  stagedStartTurnTriggers,
  authoritativeVersion,
  onResync,
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
  // Slayer Pack: Creative AI+'s chosen Orbs, and a card-given choice in flight.
  const [powerOrbSlots, setPowerOrbSlots] = useState<number[]>([])
  const [usingPlayerChoice, setUsingPlayerChoice] = useState(false)
  const [usingSlayerChoice, setUsingSlayerChoice] = useState(false)
  const [playerChoiceDiscarding, setPlayerChoiceDiscarding] = useState(false)
  const playerChoiceDialogRef = useRef<HTMLDialogElement | null>(null)
  const [powerGemContext, setPowerGemContext] = useState<PowerContext | null>(null)
  const [powerScryConfirmed, setPowerScryConfirmed] = useState(false)
  const [autoAdvanceRetry, setAutoAdvanceRetry] = useState(0)
  const [potionShivEnemyUids, setPotionShivEnemyUids] = useState<string[]>([])
  const [potionOverflowRequired, setPotionOverflowRequired] = useState(0)
  const [potionCardUids, setPotionCardUids] = useState<string[]>([])
  const [relicCardUids, setRelicCardUids] = useState<string[]>([])
  const [dieRelicCardUids, setDieRelicCardUids] = useState<string[]>([])
  const [dieRelicEnemyUid, setDieRelicEnemyUid] = useState<string | null>(null)
  const [relicShivEnemyUids, setRelicShivEnemyUids] = useState<string[]>([])
  const [usingPotion, setUsingPotion] = useState(false)
  const [usingPower, setUsingPower] = useState(false)
  const [usingTrigger, setUsingTrigger] = useState(false)
  const [editingStagedStartTurnTrigger, setEditingStagedStartTurnTrigger] = useState<number | null>(null)
  const [usingDieRelic, setUsingDieRelic] = useState(false)
  const [usingCard, setUsingCard] = useState(false)
  const [discardTops, setDiscardTops] = useState<Record<string, string>>({})
  const [retainedCards, setRetainedCards] = useState<Record<string, string[]>>({})
  const [discardOrders, setDiscardOrders] = useState<DiscardOrders>({})
  /** Slayer Pack: Companion's owner also Exhausts it with the next chosen enemy. */
  const [endTurnSelfExhaust, setEndTurnSelfExhaust] = useState(false)
  const [slimeCardZoom, setSlimeCardZoom] = useState<SlimeCardZoom | null>(null)
  const closeSlimeCardZoom = useRef(() => setSlimeCardZoom(null))
  const [startTurnOrder, setStartTurnOrder] = useState<string[]>([])
  const [startTurnScryOrder, setStartTurnScryOrder] = useState<string[]>([])
  const [startTurnEnemyTargets, setStartTurnEnemyTargets] = useState<Record<string, string | undefined>>({})
  const [startTurnPlayerTargets, setStartTurnPlayerTargets] = useState<Record<string, string | undefined>>({})
  const [startTurnExhaustUids, setStartTurnExhaustUids] = useState<Record<string, string | undefined>>({})
  const [startTurnModeShifts, setStartTurnModeShifts] = useState<Record<string, boolean | undefined>>({})
  const [resolvingStartTurnMode, setResolvingStartTurnMode] = useState(false)
  const [unknownStartTurnMode, setUnknownStartTurnMode] = useState<{
    abilityId: string
    refreshAttempt: number
  } | null>(null)
  const [startTurnTargets, setStartTurnTargets] = useState<Record<string, (string | null | undefined)[]>>({})
  const [startTurnEvokeSlots, setStartTurnEvokeSlots] = useState<Record<string, number[]>>({})
  const [startTurnEvokeTargets, setStartTurnEvokeTargets] = useState<
    Record<string, (string | null | undefined)[]>
  >({})
  const [startTurnScryPicked, setStartTurnScryPicked] = useState<string[]>([])
  const [resolvingStartTurnScry, setResolvingStartTurnScry] = useState(false)
  // A sent start-of-turn plan: the hand stops offering re-picks until the server answers.
  const [sendingStartTurn, setSendingStartTurn] = useState(false)
  const [resolvingStartTurnDiscard, setResolvingStartTurnDiscard] = useState(false)
  const [triggerHermitLoadUids, setTriggerHermitLoadUids] = useState<string[]>([])
  const [triggerHermitChamberUids, setTriggerHermitChamberUids] = useState<string[]>([])
  // `cards` shows the card-face dialog; `board` hides it so the player can read the
  // board; `target` means the cards are settled and an enemy/row/player click remains.
  const [triggerHermitStep, setTriggerHermitStep] = useState<'cards' | 'board' | 'target'>('cards')
  const triggerHermitReopenRef = useRef<HTMLButtonElement | null>(null)
  // The dialog unmounts rather than closing, so the browser has nowhere to return focus.
  useEffect(() => {
    if (triggerHermitStep !== 'cards') triggerHermitReopenRef.current?.focus({ preventScroll: true })
  }, [triggerHermitStep])
  const [triggerSlimeUids, setTriggerSlimeUids] = useState<string[]>([])
  const [triggerSlimeEnemyUids, setTriggerSlimeEnemyUids] = useState<string[]>([])
  const reducedMotion = useReducedEffects()

  useEffect(() => registerCardZoomCloser(closeSlimeCardZoom.current), [])
  const prefersReducedMotion = reducedMotion
  const choiceDialogRef = useRef<HTMLDialogElement | null>(null)
  const itemDialogRef = useRef<HTMLDialogElement | null>(null)
  const startTurnScryDialogRef = useRef<HTMLDialogElement | null>(null)
  const startTurnDiscardDialogRef = useRef<HTMLDialogElement | null>(null)
  const potionActionPending = useRef(false)
  const powerActionPending = useRef(false)
  const cardActionPending = useRef(false)
  const relicActionPending = useRef(false)
  const unknownPotionAction = useRef<UnknownPotionAction | null>(null)
  const unknownPowerAction = useRef<UnknownPowerAction | null>(null)
  const unknownCardAction = useRef<UnknownCardAction | null>(null)
  const armedCardFlight = useRef<{ card: CardInstance; chamber: boolean } | null>(null)
  const chamberCloseTimer = useRef<number | null>(null)
  const chamberContactTimer = useRef<number | null>(null)
  const chamberReflowFrame = useRef<number | null>(null)
  const handRevealFrame = useRef<number | null>(null)
  const chamberTriggerRef = useRef<HTMLButtonElement | null>(null)
  const handScrollRef = useRef<HTMLDivElement | null>(null)
  const handRef = useRef<HTMLDivElement | null>(null)
  const chamberViewerId = useRef(viewerId)
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
  const stanceChangedThisTurn = onAction ? viewerStanceChangedThisTurn : state.stanceChangedThisTurn.includes(viewerId)
  const viewerVisual = viewer ? playerVisualId(viewer) : undefined
  const skinOrb = viewerVisual !== undefined && skinTraits(viewerVisual)?.energyOrb === true
  // Hand Attacks show what they would deal now: to the enemy being dragged onto or last
  // pointed at, to the only enemy left, otherwise to a plain stand-in enemy.
  const [pointedEnemyUid, setPointedEnemyUid] = useState<string | null>(null)
  const cardHints = useCardHints()
  const courierAvailable = Boolean(onCourierReveal) && courierReady(viewer, courierUsedBy ?? [])
  const canUsePotionNow = (potionId: string) => Boolean(viewer &&
    canActivatePotion(state, viewer, potionId) && !(partyStartTurnPostRollLocked &&
      isPostRollStartTurnPotionChoice(state, viewer, potionId)))
  const canUseRelicNow = (relicIndex: number) => Boolean(viewer &&
    canActivateRelic(state, viewer, relicIndex) && !(partyStartTurnPostRollLocked &&
      isPostRollStartTurnRelicChoice(state, viewer, relicIndex)))
  useEffect(() => {
    if (reducedMotion || !viewer) return
    let cancel = warmSmokeTrails(viewer.character)
    const resize = () => { cancel(); cancel = warmSmokeTrails(viewer.character) }
    window.addEventListener('resize', resize)
    return () => { cancel(); window.removeEventListener('resize', resize) }
  }, [viewer?.character, reducedMotion])
  const hermitSetupPending = state.pendingHermitSetupLoads?.[0]?.playerId === viewerId
  const hermitSetupOwner = state.players.find((player) => player.id === state.pendingHermitSetupLoads?.[0]?.playerId)
  const hermitStrengthPending = state.pendingHermitStrengthRewards?.[0]?.playerId === viewerId
  // Slayer Pack: Heel Hook's draw-or-discard and Magnetism's return, answered from this seat only.
  const owedChoices = owedPlayerChoices(state)
  const viewerPlayerChoice = owedChoices.find((choice) => choice.playerId === viewerId)
  // A dead (Last Stand) owner's choice lapses here as it does on the room server, so a
  // loaded or resumed local state can never stay wedged on it.
  useEffect(() => {
    if (onAction || owedChoices.length === (state.pendingPlayerChoices?.length ?? 0)) return
    const lapsed = lapseStrandedPlayerChoices(state)
    if (lapsed !== state) onChange?.(lapsed)
  }, [onAction, onChange, owedChoices.length, state])
  const dieRelicPending = state.pendingDieRelicChoices?.[0]
  const dieRelicAbility = dieRelicPending
    ? chosenDieRelicAbilities(relicDef(dieRelicPending.relicDefId))[dieRelicPending.abilityIndex]
    : undefined
  const dieRelicNeedsEnemy = Boolean(viewer && dieRelicAbility?.effects.some((effect) => reachesEnemy(effect, viewer)))
  const dieRelicTargetUid = livingEnemies(state).some((enemy) => enemy.uid === dieRelicPending?.enemyUid)
    ? dieRelicPending?.enemyUid ?? null
    : livingEnemies(state).some((enemy) => enemy.uid === dieRelicEnemyUid) ? dieRelicEnemyUid : null
  const hermitTargetedCurses = new Set(['hermit_grudge', 'hermit_malice', 'hermit_horror'])

  function submitHermitSetup(card: CardInstance, enemyUid: string | null = null) {
    if (onAction) void onAction({ kind: 'resolveHermitSetupLoad', cardUid: card.uid, enemyUid })
    else onChange?.(resolveHermitSetupLoad(state, viewerId, card.uid, enemyUid))
  }

  useEffect(() => { setPlayerChoiceDiscarding(false) }, [viewerPlayerChoice?.id])
  useModalDialog(playerChoiceDialogRef, playerChoiceDiscarding, viewerPlayerChoice?.id)

  function submitPlayerChoice(answer: Omit<PlayerChoiceAnswer, 'choiceId'>) {
    if (!viewerPlayerChoice || usingPlayerChoice) return
    const choice = { choiceId: viewerPlayerChoice.id, ...answer }
    if (!onAction) {
      const result = resolvePendingPlayerChoice(state, viewerId, choice)
      if (result !== state) onChange?.(result)
      return
    }
    setUsingPlayerChoice(true)
    void Promise.resolve(onAction({ kind: 'resolvePlayerChoice', ...choice }))
      .finally(() => setUsingPlayerChoice(false))
  }

  function submitHermitStrength(targetPlayerId: string) {
    if (onAction) void onAction({ kind: 'resolveHermitStrengthReward', playerId: targetPlayerId })
    else onChange?.(resolveHermitStrengthReward(state, viewerId, targetPlayerId))
  }

  // Slayer Pack: Nightmare+'s new enemy and Ritual Dagger+'s private reveal.
  const slayerChoice = state.pendingSlayerChoices?.[0]
  const slayerChoiceOwner = state.players.find((player) => player.id === slayerChoice?.playerId)
  function submitSlayerChoice(decision: { enemyUid?: string | null; replace?: boolean }) {
    if (!slayerChoice || usingSlayerChoice) return
    const answer = { choiceId: slayerChoice.id, ...decision }
    if (!onAction) {
      const result = resolveSlayerChoice(state, viewerId, answer)
      if (result !== state) onChange?.(result)
      return
    }
    setUsingSlayerChoice(true)
    void Promise.resolve(onAction({ kind: 'resolveSlayerChoice', ...answer }))
      .finally(() => setUsingSlayerChoice(false))
  }

  function submitDieRelicChoice(discard: boolean) {
    if (usingDieRelic || dieRelicPending?.playerId !== viewerId) return
    const cardUids = dieRelicCardUids
    if (!onAction) {
      const result = resolvePendingDieRelicChoice(state, viewerId, {
        choiceId: dieRelicPending.id,
        enemyUid: dieRelicTargetUid,
        ...(discard ? { discardUids: cardUids } : { exhaustUids: cardUids }),
      })
      if (result === state) return
      setDieRelicCardUids([])
      setDieRelicEnemyUid(null)
      onChange?.(result)
      return
    }
    const choiceId = dieRelicPending.id
    setUsingDieRelic(true)
    void Promise.resolve(onAction({
      kind: 'resolveDieRelicChoice',
      choiceId,
      enemyUid: dieRelicTargetUid,
      ...(discard ? { discardUids: cardUids } : { exhaustUids: cardUids }),
    })).then((outcome) => {
      const pending = outcome?.snapshot?.run?.combat?.pendingDieRelicChoices
      if (!pending || pending.some((choice) => choice.id === choiceId)) return
      setDieRelicCardUids([])
      setDieRelicEnemyUid(null)
    }).finally(() => setUsingDieRelic(false))
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

  function skipUnplayableHermitChamber(cardUid: string) {
    if (onAction) void onAction({ kind: 'playHermitChamberCard', cardUid, enemyUid: null })
    else onChange?.(playHermitChamberCard(state, viewerId, cardUid))
  }
  const viewerHasSozu = viewer?.relics.some((relic) => relic.defId === 'sozu') ?? false
  const extraCrispyPower = viewer?.powers.find((power) => power.defId === 'extra_crispy' &&
    !powerAbilityUsed(state, viewerId, power.uid))
  const pendingTrigger = dieRelicPending ? null
    : authoritativePendingTrigger !== undefined
      ? authoritativePendingTrigger ?? stagedStartTurnTriggers
        ?.find((trigger) => trigger.id === editingStagedStartTurnTrigger) ?? null
      : pendingTriggerAbility(state)
  const stagedStartTurnTriggerPending = state.phase === 'start' &&
    state.pendingTriggers.some((trigger) => trigger.startTurn && trigger.playerId === viewerId)
  const triggerHermitChoicesReady = !pendingTrigger?.hermitChoices || triggerHermitStep === 'target' &&
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
  const triggerHermitCurse = pendingTrigger?.hermitChoices?.loadCards.find((card) =>
    triggerHermitLoadUids.includes(card.uid) && hermitTargetedCurses.has(card.defId))
  const triggerHermitNeedsBoard = Boolean(pendingTrigger?.rows || pendingTrigger?.players ||
    pendingTrigger?.targets && (!pendingTrigger.targetsOnlyForLoadedCurse || triggerHermitCurse))
  const pendingPlunder = state.pendingPlunderSwitches?.[0]
  const voluntaryActionsBlocked = mandatoryChoicePending(state)
  const requiredHermitChamberCard = state.pendingHermitChamberPlays?.[0]
  const resetChamber = (open: boolean) => {
    if (chamberCloseTimer.current !== null) window.clearTimeout(chamberCloseTimer.current)
    if (chamberContactTimer.current !== null) window.clearTimeout(chamberContactTimer.current)
    if (chamberReflowFrame.current !== null) window.cancelAnimationFrame(chamberReflowFrame.current)
    chamberCloseTimer.current = null
    chamberContactTimer.current = null
    chamberReflowFrame.current = null
    setChamberClosing(false)
    setChamberContact(false)
    setChamberReturnFlights([])
    setChamberOpen(open)
  }
  useEffect(() => {
    if (requiredHermitChamberCard?.playerId === viewerId) resetChamber(true)
  }, [requiredHermitChamberCard?.playerId, requiredHermitChamberCard?.cardUids[0], viewerId])
  useEffect(() => () => {
    if (chamberCloseTimer.current !== null) window.clearTimeout(chamberCloseTimer.current)
    if (chamberContactTimer.current !== null) window.clearTimeout(chamberContactTimer.current)
    if (chamberReflowFrame.current !== null) window.cancelAnimationFrame(chamberReflowFrame.current)
    if (handRevealFrame.current !== null) window.cancelAnimationFrame(handRevealFrame.current)
  }, [])
  useEffect(() => {
    if (state.phase === 'player') return
    resetChamber(false)
  }, [state.phase])
  useEffect(() => {
    if (chamberViewerId.current === viewerId) return
    chamberViewerId.current = viewerId
    resetChamber(false)
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
  const editingStagedTrigger = stagedStartTurnTriggers?.find((trigger) => trigger.id === editingStagedStartTurnTrigger)
  const editingStagedChoice = editingStagedTrigger
    ? serverStartTurnChoices?.find((choice) => choice.id === editingStagedTrigger.choiceId)?.trigger
    : undefined
  // A paused start of turn (Magnetism's owed choice) keeps the picks already made for the abilities
  // still to resolve in `startTurnProgress.choices`; the room's staged picks win, so a resumed
  // plan neither asks for them again nor loses them (solo has no staged picks at all).
  const resumedStartChoices = state.phase === 'start' && !state.startTurnProgress?.forcedCard
    ? state.startTurnProgress?.choices : undefined
  const savedStartTurnChoices = resumedStartChoices?.length
    ? [...(serverStartTurnChoices ?? []), ...resumedStartChoices.filter((choice) =>
      !serverStartTurnChoices?.some((saved) => saved.id === choice.id))]
    : serverStartTurnChoices
  // Online snapshots rebuild these arrays on every publish; key on their content so
  // an unrelated room update does not wipe picks the player is still making.
  const editingStagedChoiceKey = JSON.stringify(editingStagedChoice ?? null)
  useEffect(() => {
    const staged = JSON.parse(editingStagedChoiceKey) as typeof editingStagedChoice | null
    setTriggerHermitLoadUids(staged?.loadUids ?? [])
    setTriggerHermitChamberUids(staged?.chamberUids ?? [])
    setTriggerHermitStep('cards')
    setTriggerSlimeUids(staged?.slimeUids ?? [])
    setTriggerSlimeEnemyUids(staged?.slimeEnemyUids ?? [])
  }, [pendingTrigger?.id, editingStagedStartTurnTrigger, editingStagedChoiceKey])
  useEffect(() => {
    setDieRelicCardUids([])
    setDieRelicEnemyUid(null)
  }, [dieRelicPending?.id])
  const forcedCard = state.startTurnProgress?.forcedCard
  const distilled = state.pendingDistilled
  const relicScry = state.pendingRelicScry
  const playWindow = viewerId ? activeCardPlayWindow(state, viewerId) : undefined
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
  const canOrderStartTurnScries = !onAction || startTurnCoordinatorId === viewerId
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
  const facingEnemies = state.enemies.filter((enemy) =>
    enemyAbilities(enemyDef(enemy.defId, enemy.ascension)).some((ability) => ability.kind === 'facing'))
  const liveFacingEnemies = facingEnemies.filter((enemy) => !enemy.dead)
  const savedDiscardKey = savedDiscardOrder?.join('\0')
  const cardPreviewKey = cardPreview
    ? `${cardPreview.cardUid}\0${cardPreview.copy === true}\0${cardPreview.chamber === true}\0${cardPreview.kind}\0${cardPreview.spendMiracle}\0${cardPreview.enemyUid ?? ''}\0${cardPreview.slimeUids?.join('\0') ?? ''}\0${cardPreview.slimeEnemyUids?.join('\0') ?? ''}\0${cardPreview.cards.map((card) => card.uid).join('\0')}`
    : ''
  const endTurnEffect = onAction ? partyEndTurnAbilities?.[0] : endTurnResolutionAbility(state)
  const endTurnResolving = endTurnEffect !== undefined
  const baseStartAbilities = useMemo(() => state.phase === 'start' && !pendingTrigger
    ? (partyStartTurnAbilities ?? startTurnAbilities(state))
    : [], [partyStartTurnAbilities, pendingTrigger?.id, state])
  const startAbilityKey = baseStartAbilities.map((ability) =>
    `${ability.id}:${ability.overflowShivs}:${ability.targets?.map((target) => target.uid).join(',') ?? ''}:` +
    `${ability.players?.map((player) => player.id).join(',') ?? ''}:` +
    `${ability.exhaustCards?.map((card) => card.uid).join(',') ?? ''}:` +
    `${ability.evokeChoice?.options.map((option) => `${option.slot}:${option.orb}`).join(',') ?? ''}:` +
    `${!onAction || ability.playerId === viewerId ? savedStartTurnEnemyTargets?.[ability.id] ?? '' : ''}`).join('\0') +
    `\0${savedStartTurnChoices?.filter((choice) => !onAction || baseStartAbilities.some((ability) =>
      ability.id === choice.id && ability.playerId === viewerId)).map((choice) =>
      `${choice.id}:${choice.enemyUid ?? ''}:${choice.targetPlayerId ?? ''}:${choice.guardianModeShift ?? ''}:` +
      `${choice.exhaustUids?.join(',') ?? ''}:${choice.shivEnemyUids.join(',')}:` +
      `${choice.evokeSlots?.join(',') ?? ''}:${choice.evokeEnemyUids?.join(',') ?? ''}`).join('\0') ?? ''}`

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
    .map((active) => <CombatVfx
      key={`${active.event.seq}-${active.recipe.asset}`}
      active={active}
      role="target"
      attackContactMs={prefersReducedMotion ? 0 : characterAttackContactMs(state, enemy.uid, active.event)}
      revealDelayMs={orbEndTurnRevealDelayMs.get(active.event.seq)}
    />)
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
  const [characterAttacks, setCharacterAttacks] = useState<Record<string, CharacterAttackMotion[]>>({})
  const [slimeCommandMotions, setSlimeCommandMotions] = useState<Record<string, {
    seq: number
    x: number
    y: number
  }>>({})
  const [slimeLayoutVersion, setSlimeLayoutVersion] = useState(0)
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

  function restoreUnknownPower(
    power: UnknownPowerAction,
    current: Player | VisiblePlayer,
    canRestore = activePowerWindow(state) && !state.startTurnProgress?.forcedCard,
    preview = powerPreview,
  ) {
    if (!canRestore || !current.powers.some((held) => held.uid === power.powerUid)) return
    setPendingPowerUid(power.powerUid)
    setPowerChamberUids((power.context.chamberUids ?? []).filter((uid) =>
      current.chamber?.some((card) => card.uid === uid)))
    setPowerLoadUids((power.context.loadUids ?? []).filter((uid) =>
      current.hand?.some((card) => card.uid === uid)))
    if (preview?.powerUid !== power.powerUid || preview.id !== power.powerPreviewId) return
    const revealed = new Set(preview.cards.map((card) => card.uid))
    setPowerChoiceCards(preview.cards)
    setPowerScryDiscardUids((power.context.scryDiscardUids ?? []).filter((uid) => revealed.has(uid)))
    setPowerExhaustUids(power.context.exhaustUids ?? [])
    setPowerGemContext(power.context)
    setPowerScryConfirmed(true)
  }

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
      const decision = unknownPowerRefreshDecision(used, power.refreshAttempt, authoritativeRefresh)
      if (decision === 'committed' || decision === 'restore') {
        unknownPowerAction.current = null
        powerActionPending.current = false
        setUsingPower(false)
        if (decision === 'restore') restoreUnknownPower(power, current)
      }
    }
    const card = unknownCardAction.current
    const cardCommitted = card?.source === 'copy'
      ? state.pendingCardCopy?.card.uid !== card.cardUid ||
        state.pendingCardCopy.id !== card.copyId
      : current && !(card?.source === 'chamber' ? current.chamber : current.hand)
        .some((held) => held.uid === card?.cardUid)
    if (card && ((authoritativeRefresh !== undefined && authoritativeRefresh > card.refreshAttempt) || cardCommitted)) {
      if (shouldDisarmCardFlight(card.source !== 'copy', cardCommitted === true)) armedCardFlight.current = null
      unknownCardAction.current = null
      cardActionPending.current = false
      setUsingCard(false)
      if (cardCommitted) setPending(null)
      else if (current) restoreUnknownCard(card.pending, current, card.usingMiracle, state)
    }
  }, [authoritativeRefresh, powerPreview, state, viewerId])

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
    setEndTurnSelfExhaust(false)
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
      current.slimeUids.join('\0') === (cardPreview.slimeUids ?? []).join('\0') &&
      current.choiceCards?.length === cardPreview.cards.length &&
      current.choiceCards?.every((held, index) => held.uid === cardPreview.cards[index]?.uid)
      ? { ...current, enemyUid: cardPreview.enemyUid,
        slimeEnemyUids: cardPreview.slimeEnemyUids ?? [] }
      : restored)
  }, [cardPreviewKey, viewerId, usingCard, onAction])

  useEffect(() => {
    if (powerPreview) {
      setPendingPowerUid(powerPreview.powerUid)
      setPowerChoiceCards(powerPreview.cards)
      setPowerScryDiscardUids([])
      setPowerGemContext(null)
      setPowerScryConfirmed(false)
    } else if (onAction) {
      setPowerChoiceCards(null)
      setPowerScryDiscardUids([])
      setPowerGemContext(null)
      setPowerScryConfirmed(false)
    }
  }, [powerPreview?.id, powerPreview?.powerUid, powerPreview?.cards.map((card) => card.uid).join('\0'), onAction])

  useEffect(() => { setRelicCardUids([]) }, [relicScry?.id])
  useEffect(() => {
    if (partyStartTurnPostRollLocked) setRelicCardUids([])
  }, [partyStartTurnPostRollLocked])
  useEffect(() => {
    const revealed = new Set(relicScry?.cards.map((card) => card.uid) ?? [])
    setRelicCardUids((current) => current.filter((uid) => revealed.has(uid)))
  }, [relicScry?.cards.map((card) => card.uid).join('\0')])

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
  }, [state.phase, state.pendingCardCopy?.id,
    viewerId, cardPreviewKey, usingCard])

  // Native modal semantics make every control behind a card choice inert and
  // keep keyboard focus inside it without a custom focus trap. Hidden reveals
  // prevent cancellation; Headbutt's already-public discard choice does not.
  // An owed Heel Hook / Magnetism / Nightmare+ / Ritual Dagger+ answer controls sit outside
  // those dialogs and the server refuses every other action until it is answered, so the
  // dialogs step aside (state kept) and reopen once the choice is cleared. Potion pickers are
  // the exception: using a potion is refused while a choice is owed, so they are cancelled
  // (the potion is not spent) and the player reopens them afterwards.
  const owesChoice = Boolean(viewerPlayerChoice) ||
    (slayerChoice?.playerId === viewerId && state.phase !== 'lost')
  useModalDialog(
    choiceDialogRef,
    Boolean(pending?.choiceCards && !pending.choiceConfirmed && !owesChoice),
    pending?.choiceCards,
  )

  // A chosen Distilled Chaos card can still need a board target. Keeping the
  // reveal modal open makes the whole board inert and strands that card.
  const visibleDistilled = forcedCard || state.pendingCardCopy || pendingTrigger ? undefined : distilled
  const gemFinderScryOpen = viewer?.powers.some((power) =>
    power.uid === pendingPowerUid && power.defId === 'guardian_gem_finder') === true &&
    Boolean(powerChoiceCards) && !powerScryConfirmed
  const itemModalOpen = ['liquid_memories', 'liquid_void', 'transforming_brew', 'purity_potion', 'entropic_brew'].includes(pendingPotion ?? '') ||
    gemFinderScryOpen || Boolean(relicScry) || Boolean(visibleDistilled)
  useModalDialog(
    itemDialogRef,
    itemModalOpen && !owesChoice,
    `${pendingPotion ?? ''}:${pendingPowerUid ?? ''}:${relicScry?.playerId ?? ''}:${visibleDistilled?.playerId ?? ''}`,
  )

  useEffect(() => {
    setStartTurnScryPicked([])
    setResolvingStartTurnScry(false)
  }, [startTurnScryKey])

  useModalDialog(
    startTurnScryDialogRef,
    activeStartTurnScry?.playerId === viewerId && activeStartTurnScry.cards !== null,
    startTurnScryKey,
  )

  useEffect(() => {
    setResolvingStartTurnDiscard(false)
  }, [activeStartTurnDiscard?.playerId, activeStartTurnDiscard?.sourceId,
    activeStartTurnDiscard?.cards, viewerId])
  useModalDialog(
    startTurnDiscardDialogRef,
    activeStartTurnDiscard?.playerId === viewerId && activeStartTurnDiscard.cards !== null,
    `${activeStartTurnDiscard?.playerId ?? ''}:${activeStartTurnDiscard?.sourceId ?? ''}:${activeStartTurnDiscard?.cards?.length ?? ''}`,
  )

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
  const previousPotionDie = useRef(state.die)
  useEffect(() => {
    const dieChanged = previousPotionDie.current !== state.die
    previousPotionDie.current = state.die
    if (!pendingPotion) return
    if (!viewer?.potions.includes(pendingPotion) || !canUsePotionNow(pendingPotion)) {
      setPendingPotion(null)
      setPotionShivEnemyUids([])
      setPotionOverflowRequired(0)
      setPotionCardUids([])
      return
    }
    if (pendingPotion === 'mystery_potion' && dieChanged && state.die > 2) {
      setPendingPotion(null)
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
  }, [state, viewer, viewerHasSozu, pendingPotion, potionOverflowRequired,
    partyStartTurnPostRollLocked])

  // Card choices are made against a shared board too. Recompute overflow when
  // teammates take or spend cubes, and discard targets that died meanwhile.
  useEffect(() => {
    if (!viewer) return
    const alive = new Set(state.enemies.filter((enemy) => !enemy.dead).map((enemy) => enemy.uid))
    const livingPlayers = new Set(state.players.filter((player) => !player.dead).map((player) => player.id))
    setPending((current) => {
      if (!current) return current
      if (usingCard) return current
      if (current.chamberPlay
        ? !viewer.chamber.some((card) => card.uid === current.card.uid)
        : current.cardInHand
          ? !viewer.hand.some((card) => card.uid === current.card.uid)
          : state.pendingCardCopy?.playerId !== viewer.id || state.pendingCardCopy.card.uid !== current.card.uid) return null
      const def = effectiveCombatCardDef(
        faceOf(cardDef(current.card.defId), current.card.upgraded), current.corruptedShardMode ?? viewer.guardianMode,
      )
      if (current.cardInHand && !cardPlayConditionMet(def, state, viewer, drawCount)) return null
      const recover = def.effects.find((effect) => effect.kind === 'recoverDiscard')
      const recoverExhaust = def.effects.find((effect) => effect.kind === 'recoverExhaust' ||
        effect.kind === 'recoverExhaustToDraw' || effect.kind === 'recoverExhaustToDiscard')
      const recoveryCards = recover ? viewer.discard : recoverExhaust ? viewer.exhaust : null
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
      const minimumUnpaid = (current.choice?.kind === 'exhaustAny' || current.choice?.kind === 'bottomdeck') &&
        current.choiceConfirmed &&
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
        !nextEvokeChoice(def, viewer, evokeSlots, state.die, current.mode ?? undefined, current.effectEnergy ?? 0) &&
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
            current.choice?.kind === 'bottomdeck' ||
            current.choice?.kind === 'recover' || current.choice?.kind === 'recoverExhaust')
          ? false
          : current.choiceConfirmed,
        evokeSlots,
        evokeEnemyUids,
      }
    })
  }, [state, viewer, drawCount, usingCard])

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
      ability.id, savedChoices.get(ability.id)?.exhaustUids?.[0] ??
        (ability.exhaustCards?.length === 1 ? ability.exhaustCards[0]!.uid : undefined),
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

  // A teammate's staged picks change what this plan simulates (a Shiv or Evoke can
  // kill an enemy a later ability needs), but they arrive without resetting the
  // viewer's own unsent picks, so refresh only the teammates' drafts.
  const teammateChoicesKey = onAction ? JSON.stringify(baseStartAbilities
    .filter((ability) => ability.playerId !== viewerId).map((ability) => {
      const choice = savedStartTurnChoices?.find((candidate) => candidate.id === ability.id)
      return [ability.id, savedStartTurnEnemyTargets?.[ability.id], choice?.enemyUid, choice?.targetPlayerId,
        choice?.guardianModeShift, choice?.shivEnemyUids, choice?.evokeSlots, choice?.evokeEnemyUids]
    })) : ''
  useEffect(() => {
    if (state.phase !== 'start' || !onAction) return
    const teammates = baseStartAbilities.filter((ability) => ability.playerId !== viewerId)
    if (teammates.length === 0) return
    const savedChoices = new Map((savedStartTurnChoices ?? []).map((choice) => [choice.id, choice]))
    const refresh = <S extends Record<string, unknown>>(pick: (ability: (typeof teammates)[number]) => S[string]) =>
      (current: S): S => ({ ...current, ...Object.fromEntries(teammates.map((ability) => [ability.id, pick(ability)])) })
    setStartTurnEnemyTargets(refresh((ability) => savedStartTurnEnemyTargets?.[ability.id] ??
      savedChoices.get(ability.id)?.enemyUid ?? (ability.targets?.length === 1 ? ability.targets[0]!.uid : undefined)))
    setStartTurnPlayerTargets(refresh((ability) => savedChoices.get(ability.id)?.targetPlayerId ??
      (ability.players?.length === 1 ? ability.players[0]!.id : undefined)))
    setStartTurnModeShifts(refresh((ability) => savedChoices.get(ability.id)?.guardianModeShift))
    setStartTurnTargets(refresh((ability) => savedChoices.get(ability.id)?.shivEnemyUids ??
      Array(ability.overflowShivs).fill(undefined)))
    setStartTurnEvokeSlots(refresh((ability) => savedChoices.get(ability.id)?.evokeSlots ?? []))
    setStartTurnEvokeTargets(refresh((ability) => savedChoices.get(ability.id)?.evokeEnemyUids ?? []))
  }, [teammateChoicesKey, state.phase])

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
  const enemyButtonOrder = livingEnemiesInStageOrder(state.enemies)

  if (!viewer) return <p className="muted">No seat for {viewerId}.</p>
  const downfallCharacter = DOWNFALL_CHARACTER_IDS.find((character) => character === viewer.character)

  const over = state.phase === 'won' || state.phase === 'lost'
  const pendingPotionDef = pendingPotion ? potionDef(pendingPotion) : null
  const pendingPotionNeedsEnemy = pendingPotionDef?.target === 'enemy' ||
    pendingPotion === 'mystery_potion' && state.die <= 2
  const pendingPotionNeedsCards = ['liquid_memories', 'liquid_void', 'transforming_brew', 'purity_potion'].includes(pendingPotion ?? '')
  const pendingPower = pendingPowerUid
    ? viewer.powers.find((power) => power.uid === pendingPowerUid)
    : undefined
  const livingPlayers = state.players.filter((player) => !player.dead)
  const pendingPowerDef = pendingPower ? faceOf(cardDef(pendingPower.defId), pendingPower.upgraded) : null
  const pendingHermitPower = pendingPowerDef?.id === 'hermit_shadow_cloak' || pendingPowerDef?.id === 'hermit_black_wind'
  // Slayer Pack: Creative AI is chosen on the Orbs themselves.
  const creativeAiEffect = pendingPowerDef?.effects.find((effect) => effect.kind === 'removeOrbsForDiscardTop')
  const pendingPowerNeedsEnemy = Boolean(pendingPower && pendingPowerDef &&
    cardNeedsEnemy(pendingPowerDef, viewer, true, undefined, true, pendingPower.attachedGemId))
  const pendingPowerNeedsAlly = Boolean(pendingPower && pendingPowerDef &&
    guardianCardNeedsAlly(pendingPowerDef, viewer, pendingPower.attachedGemId) && livingPlayers.length > 1)
  const pendingPowerNeedsGemChoice = Boolean(pendingPower?.attachedGemId && (
    pendingPowerNeedsEnemy || pendingPowerNeedsAlly || pendingPowerDef?.target === 'row' ||
    pendingPower.attachedGemId === 'guardian_jasper' || pendingPower.attachedGemId === 'guardian_amethyst'
  ))
  const pendingPotionOverflow = potionOverflowRequired
  const endTurnParticipants = requiredEndTurnPlayerIds ?? livingPlayers.filter(discardNeedsChoice).map((player) => player.id)
  const confirmedDiscards = decidedPlayerIds
    ? endTurnParticipants.filter((playerId) => decidedPlayerIds.includes(playerId)).length
    : endTurnParticipants.filter((playerId) => discardOrders[playerId]).length
  // Online only: hotseat has no per-seat readiness, so one click ends the turn
  // for the table and a counter there would sit at 0 until it vanished.
  const endTurnCount = decidedPlayerIds && endTurnParticipants.length > 1
    ? `${confirmedDiscards}/${endTurnParticipants.length}`
    : null
  const viewerNeedsEndTurnChoice = endTurnParticipants.includes(viewer.id)
  const viewerNeedsDiscardTop = endTurnTopPlayerIds
    ? endTurnTopPlayerIds.includes(viewer.id)
    : discardTopNeedsChoice(viewer)
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
  const requiredChamberUnplayable = viewer.dead ||
    (requiredChamberStaged
      ? !canAfford(state, requiredChamberStaged.player, requiredChamberStaged.card) ||
        !cardCanBeForced(
          effectiveCombatCardDef(faceOf(cardDef(requiredChamberStaged.card.defId), requiredChamberStaged.card.upgraded),
            requiredChamberStaged.player.guardianMode),
          state, requiredChamberStaged.player,
          guardianGemForCard(requiredChamberStaged.player, requiredChamberStaged.card), requiredChamberStaged.card.uid,
        )
      : false)
  const discardableHand = viewer.hand.filter((card) =>
    !card.endTurnProtected && !card.retainThisTurn && !cardHasRetain(viewer, card))
  const retainAllowance = viewer.retainCardsThisTurn ?? 0
  // Slayer Pack: Master Reality+'s returned card may be kept outside the Retain allowance.
  const optionalRetainUids = new Set(discardableHand.filter((card) => card.mayRetainThisTurn).map((card) => card.uid))
  const selectedRetains = (retainedCards[viewer.id] ?? [])
    .filter((uid) => discardableHand.some((card) => card.uid === uid))
  const allowanceRetains = selectedRetains.filter((uid) => !optionalRetainUids.has(uid)).slice(0, retainAllowance)
  const viewerRetainedCards = [...selectedRetains.filter((uid) => optionalRetainUids.has(uid)), ...allowanceRetains]
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
  const endTurnSelfExhaustOffered = canResolveEndTurn &&
    endTurnEffect?.targets?.some((target) => parseSelfExhaustEndTurnTarget(target.uid).exhaust) === true
  const endTurnEffectPrompt = endTurnChoiceTargets.length > 0
    ? 'Choose one'
    : endTurnEffect?.orbChoice
      ? <>
          <span className="end-turn-effects__desktop-orb-prompt">Drag an Orb onto this card</span>
          <span className="end-turn-effects__phone-orb-prompt">Choose an Orb</span>
        </>
      : 'Drag to an enemy'
  const endTurnEffectVisual = endTurnEffect?.visual
  const endTurnEffectPlayer = endTurnEffect
    ? state.players.find((player) => player.id === endTurnEffect.playerId)
    : undefined
  const endTurnOrbChoices = canResolveEndTurn && endTurnEffect?.orbChoice
    ? [...new Map((endTurnEffect.targets ?? []).flatMap((target) => {
        const slot = Number(target.uid.slice(4))
        const orb = endTurnEffectPlayer?.orbs[slot]
        return target.uid === `orb:${slot}` && orb ? [[orb, { orb, target }] as const] : []
      })).values()]
    : []
  const endTurnEffectCard = endTurnEffectVisual?.kind === 'card' && endTurnEffect
    ? endTurnEffectPlayer?.powers.find((power) => power.uid === endTurnEffectVisual.cardUid)
    : undefined
  const endTurnEffectSlimeAsset = endTurnEffectVisual?.kind === 'slime'
    ? assetPath(`combat/slimes/${slimeAssetSlug(endTurnEffectVisual.cardId)}.webp`)
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
  const fumesOwnerId = startTurnChoiceId
    ? orderedStartAbilities.find((ability) => ability.id === startTurnChoiceId)?.playerId
    : undefined
  const viewerStartTurnDecided = Boolean(onAction && startTurnDecidedPlayerIds?.includes(viewer.id))
  const canResolveStartTurn = !onAction || Boolean(!viewerStartTurnDecided &&
    requiredStartTurnPlayerIds?.includes(viewer.id) &&
    (viewer.id === startTurnCoordinatorId || viewer.id !== fumesOwnerId))
  const canCommitStartTurnOrder = canResolveStartTurn &&
    (!partyStartTurnOrderPending || viewer.id === startTurnCoordinatorId)
  const startTurnCoordinator = state.players.find((player) => player.id === startTurnCoordinatorId &&
    player.id !== viewer.id)
  const startTurnCount = startTurnDecidedPlayerIds && requiredStartTurnPlayerIds?.length
    ? `${startTurnDecidedPlayerIds.filter((id) => requiredStartTurnPlayerIds.includes(id)).length}/${requiredStartTurnPlayerIds.length}`
    : null
  const orderTargetIndex = startTurnChoiceId
    ? orderedStartAbilities.findIndex((ability) => ability.id === startTurnChoiceId)
    : -1
  const ownedStartAbilities = onAction
    ? orderedStartAbilities.filter((ability) => ability.playerId === viewer.id)
    : orderedStartAbilities
  const startChoiceAbilities = partyStartTurnOrderPending && viewer.id === startTurnCoordinatorId
    ? orderedStartAbilities.slice(0, orderTargetIndex < 0 ? orderedStartAbilities.length : orderTargetIndex)
      .filter((ability) => !onAction || ability.playerId === viewer.id)
    : ownedStartAbilities.filter((ability) => !startTurnChoiceId || viewer.id !== fumesOwnerId ||
      ability.id === startTurnChoiceId)
  const pendingStartChoice = canResolveStartTurn
    ? startChoiceAbilities
      .flatMap<PendingStartChoice>((ability) => {
      if (ability.targets?.length &&
        (startTurnEnemyTargets[ability.id] === undefined || ability.enemyTargetStale)) {
        return [{ kind: 'enemy', ability }]
      }
      if (ability.players && startTurnPlayerTargets[ability.id] === undefined) {
        return [{ kind: 'player', ability }]
      }
      // A hot-seat teammate's Exhaust comes from their own hand and seat; it
      // never queues in front of this seat's choices (see teammateStartExhaust).
      if (ability.playerId === viewer.id && ability.exhaustCards && !ability.exhaustCards.some((card) =>
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
  const pendingStartEvoke = pendingStartChoice?.kind === 'evoke' ? pendingStartChoice.ability : undefined
  // A targeted start-of-turn relic or Power floats above the board as its own
  // drag source, so the glowing targets always have a visible cause.
  const startTurnEffectSource = pendingStartPlayer?.visual ? pendingStartPlayer
    : pendingStartEnemy?.visual ? pendingStartEnemy
    : pendingStartEvoke?.visual ? pendingStartEvoke : undefined
  // An Evoke choice is made on the Orbs themselves; its source is shown only as the cause.
  const startTurnEffectDraggable = startTurnEffectSource !== undefined && startTurnEffectSource !== pendingStartEvoke
  const startTurnEffectVisual = startTurnEffectSource?.visual
  const startTurnEffectCard = startTurnEffectVisual?.kind === 'card'
    ? state.players.find((player) => player.id === startTurnEffectSource?.playerId)
      ?.powers.find((power) => power.uid === startTurnEffectVisual.cardUid)
    : undefined
  const startTurnEffectRelicId = startTurnEffectVisual?.kind === 'relic'
    ? startTurnEffectVisual.relicId
    : undefined
  const pendingStartExhaust = pendingStartChoice?.kind === 'exhaust' ? pendingStartChoice.ability : undefined
  // Still owed from a hot-seat teammate's hand; the start of turn waits for
  // them to take their seat, and their hand is never shown here.
  const teammateStartExhaust = canResolveStartTurn ? startChoiceAbilities.find((ability) =>
    ability.playerId !== viewer.id && ability.exhaustCards &&
    !ability.exhaustCards.some((card) => card.uid === startTurnExhaustUids[ability.id])) : undefined
  // Once every choice is made (and not yet sent), the hand keeps offering the
  // latest Exhaust picked from it, so tapping another card changes the pick.
  const handStartExhaust = pendingStartExhaust ?? (canResolveStartTurn && !pendingStartChoice &&
    !sendingStartTurn
    ? [...startChoiceAbilities].reverse().find((ability) => ability.playerId === viewer.id &&
      (ability.exhaustCards?.length ?? 0) > 1 &&
      ability.exhaustCards!.some((card) => card.uid === startTurnExhaustUids[ability.id] &&
        viewer.hand.some((held) => held.uid === card.uid)))
    : undefined)
  const pendingStartModeShift = pendingStartChoice?.kind === 'guardianModeShift'
    ? pendingStartChoice.ability : undefined
  const pendingStartShiv = pendingStartChoice?.kind === 'shiv' ? pendingStartChoice : undefined
  const pendingStartEvokeTarget = pendingStartChoice?.kind === 'evokeTarget' ? pendingStartChoice : undefined
  const pendingStartEvokeRows = pendingStartEvokeTarget?.ability.evokeTargets?.flatMap((target) => {
    const row = lightningRowFromTarget(target.uid)
    return row === null ? [] : [{ row, uid: target.uid }]
  }) ?? []
  const startTurnReady = orderedStartAbilities.length === baseStartAbilities.length &&
    !pendingStartEnemy && !pendingStartPlayer && !pendingStartExhaust && !teammateStartExhaust &&
    !pendingStartModeShift && !pendingStartShiv &&
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
    if (!canCommitStartTurnOrder || partyStartTurnOrderLocked || from < 0 || to < 0 || to >= startIds.length) return
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
    setStartTurnExhaustUids(Object.fromEntries(plan.map((ability) => [
      ability.id, ability.exhaustCards?.length === 1 ? ability.exhaustCards[0]!.uid : undefined,
    ])))
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
    return facingChoicesAreValid(state, startChoiceDrafts.map((choice) => {
      const saved = savedStartTurnChoices?.find((candidate) => candidate.id === choice.id)
      return choice.id === pendingStartEnemy.id ? { ...choice, enemyUid }
        : saved?.enemyUid ? { ...choice, enemyUid: saved.enemyUid } : choice
    }))
  }

  function chooseStartTurnPlayer(playerId: string) {
    if (!pendingStartPlayer?.players?.some((player) => player.id === playerId) || !canResolveStartTurn) return
    setStartTurnPlayerTargets({ ...startTurnPlayerTargets, [pendingStartPlayer.id]: playerId })
  }

  function chooseStartTurnExhaust(cardUid: string) {
    if (!handStartExhaust?.exhaustCards?.some((card) => card.uid === cardUid) || !canResolveStartTurn) return
    setStartTurnExhaustUids({ ...startTurnExhaustUids, [handStartExhaust.id]: cardUid })
  }

  function chooseStartTurnMode(mode: 'attack' | 'defense') {
    const currentMode = state.players.find((player) => player.id === pendingStartModeShift?.playerId)?.guardianMode
    if (!pendingStartModeShift || !canResolveStartTurn || resolvingStartTurnMode ||
      currentMode === null || currentMode === undefined) return
    const shifts = { ...startTurnModeShifts, [pendingStartModeShift.id]: currentMode !== mode }
    const drafts = startChoiceDrafts.map((choice) => choice.id === pendingStartModeShift.id
      ? { ...choice, guardianModeShift: shifts[pendingStartModeShift.id] }
      : choice)
    const plan = startTurnAbilities(state, startIds, drafts)
    const choices = new Map(drafts.map((choice) => [choice.id, choice]))
    const relevant = onAction ? plan.filter((ability) => ability.playerId === pendingStartModeShift.playerId) : plan
    const ready = plan.length === baseStartAbilities.length &&
      relevant.every((ability) => !startTurnChoicePending(ability, choices.get(ability.id))) &&
      !startTurnNeedsChoice(state, [], onAction ? pendingStartModeShift.playerId : undefined)
    if (ready && onAction) {
      setResolvingStartTurnMode(true)
      void Promise.resolve(finishStartTurn(plan, shifts, true)).then((outcome) => {
        if (!outcome || outcome.status === 'accepted') setStartTurnModeShifts(shifts)
        else if (outcome.status === 'unknown') {
          setStartTurnModeShifts(shifts)
          setUnknownStartTurnMode({
            abilityId: pendingStartModeShift.id,
            refreshAttempt: outcome.refreshAttempt ?? refreshRef.current ?? -1,
          })
        } else setResolvingStartTurnMode(false)
      }, () => setResolvingStartTurnMode(false))
      return
    }
    setStartTurnModeShifts(shifts)
    if (ready) finishStartTurn(plan, shifts, true)
  }

  useEffect(() => {
    const decided = startTurnDecidedPlayerIds?.includes(viewerId)
    const missingAfterRefresh = unknownStartTurnMode !== null && authoritativeRefresh !== undefined &&
      authoritativeRefresh > unknownStartTurnMode.refreshAttempt && !decided
    if (resolvingStartTurnMode && (state.phase !== 'start' || decided || missingAfterRefresh)) {
      setResolvingStartTurnMode(false)
      if (missingAfterRefresh) setStartTurnModeShifts((current) => ({
        ...current,
        [unknownStartTurnMode.abilityId]: undefined,
      }))
      setUnknownStartTurnMode(null)
    }
  }, [authoritativeRefresh, resolvingStartTurnMode, startTurnDecidedPlayerIds, state.phase,
    unknownStartTurnMode, viewerId])

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

  // Whoever may reorder is told how; everyone else is told who does.
  function startTurnOrderHint(canMove: boolean, noun: string, count: number, locked = false) {
    const coordinator = state.players.find((player) => player.id === startTurnCoordinatorId)
    return count < 2 ? 'Resolves when the turn starts.'
      : canMove ? `Resolves top to bottom. Move ${noun} earlier or later to change the order.`
      : locked ? 'Resolves top to bottom. The order is locked in.'
      : coordinator && coordinator.id !== viewerId ? `Resolves top to bottom. ${coordinator.name} sets the order.`
      : 'Resolves top to bottom. Waiting for the party.'
  }

  function moveStartTurnScry(id: string, delta: -1 | 1) {
    const from = startTurnScryIds.indexOf(id)
    const to = from + delta
    if (!canOrderStartTurnScries || from < 0 || to < 0 || to >= startTurnScryIds.length) return
    const order = [...startTurnScryIds]
    ;[order[from], order[to]] = [order[to]!, order[from]!]
    setStartTurnScryOrder(order)
  }

  function finishStartTurnScryOrder() {
    if (!canOrderStartTurnScries || orderedStartTurnScries.length !== baseStartTurnScries.length) return
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

  function finishStartTurn(
    abilities = orderedStartAbilities,
    modeShifts = startTurnModeShifts,
    ready = startTurnReady,
  ) {
    if (!ready || !canResolveStartTurn || sendingStartTurn) return
    const choices: StartTurnChoice[] = abilities.map((ability) => ({
      id: ability.id,
      enemyUid: startTurnEnemyTargets[ability.id],
      targetPlayerId: startTurnPlayerTargets[ability.id],
      exhaustUids: startTurnExhaustUids[ability.id] ? [startTurnExhaustUids[ability.id]!] : undefined,
      guardianModeShift: modeShifts[ability.id],
      shivEnemyUids: (startTurnTargets[ability.id] ?? []).map((uid) => uid ?? null),
      evokeSlots: [...(startTurnEvokeSlots[ability.id] ?? [])],
      evokeEnemyUids: (startTurnEvokeTargets[ability.id] ?? []).map((uid) => uid ?? null),
    }))
    if (onAction) {
      setSendingStartTurn(true)
      return Promise.resolve(onAction({ kind: 'resolveStartTurn', choices }))
        .finally(() => setSendingStartTurn(false))
    }
    onChange?.(resolveStartPlayerTurn(state, choices))
  }

  // Resolve the engine's deterministic default plan; keep every meaningful
  // order, target, overflow, or Orb decision manual.
  useEffect(() => {
    if (onAction || !autoAdvance || state.phase !== 'start' || !canResolveStartTurn) return undefined
    const next = forcedCard ? resolveDeterministicForcedCard(state)
      : meaningfulStartTurnChoice || baseStartTurnScries.length > 0 || activeStartTurnScry ||
        activeStartTurnDiscard || pendingTrigger
        ? state
        : resolveStartPlayerTurn(state, defaultStartTurnChoices(state))
    if (next === state) return undefined
    const timer = window.setTimeout(() => {
      onChange?.(next)
    }, 250)
    return () => window.clearTimeout(timer)
  }, [onAction, autoAdvance, autoAdvanceRetry, authoritativeRefresh, state.phase, state.turn, canResolveStartTurn,
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

  // Slayer Pack: Ends an optional card-play window ("play any number").
  function finishPlayWindow() {
    if (!playWindow || !viewer || cardActionPending.current) return
    setPending(null)
    if (onAction) void onAction({ kind: 'finishCardPlayWindow', windowId: playWindow.id })
    else {
      const next = finishCardPlayWindow(state, viewer.id, playWindow.id)
      if (next !== state) onChange?.(next)
    }
  }

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
    // Slayer Pack: a card-given choice still owed (by anyone at this table) is answered first.
    if (state.phase === 'player' && voluntaryActionsBlocked) return
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
    if (endTurnParticipants.every((playerId) => orders[playerId])) {
      setDiscardTops({})
      setDiscardOrders({})
      onChange?.(endPlayerTurn(state, orders))
    } else {
      setDiscardOrders(orders)
    }
  }

  function reconciliation(outcome: ActionOutcome | void) {
    const snapshot = outcome?.snapshot
    if (!snapshot?.run?.combat) return null
    const combat = snapshot.version <= versionRef.current ? stateRef.current : snapshot.run.combat
    const player = combat.players.find((candidate) => candidate.id === viewerId)
    return (activePowerWindow(combat) || combat.phase === 'copy') && player ? { combat, player } : null
  }

  function consumePotion(
    potionId: string,
    context: PotionContext = {},
    overflow?: { expected: number; skip: boolean },
  ) {
    if (potionActionPending.current || !canUsePotionNow(potionId)) return
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
        const needsTarget = Boolean(def.target) || potionId === 'mystery_potion' && authoritative.combat.die <= 2 || (
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
    if (!canUseRelicNow(relicIndex)) return
    const result = activateRelic(state, viewer!.id, relicIndex, context)
    if (result === state) return
    if (onAction) {
      if (relicActionPending.current) return
      relicActionPending.current = true
      const relicScryId = state.pendingRelicScry?.id
      Promise.resolve(onAction({
        kind: 'activateRelic', relicIndex, relicScryId, ...context,
      })).then((outcome) => {
        relicActionPending.current = false
        if (outcome?.status === 'accepted') {
          setRelicCardUids([])
          setRelicShivEnemyUids([])
          return
        }
        if (relicScryId !== undefined && stateRef.current.pendingRelicScry?.id !== relicScryId) return
        const alive = new Set(stateRef.current.enemies.filter((enemy) => !enemy.dead).map((enemy) => enemy.uid))
        setRelicCardUids((context.cardUids ?? context.scryDiscardUids ?? []).filter((uid) =>
          stateRef.current.players.find((player) => player.id === viewerId)?.hand.some((card) => card.uid === uid) ||
          stateRef.current.pendingRelicScry?.cards.some((card) => card.uid === uid)))
        setRelicShivEnemyUids((context.shivEnemyUids ?? []).filter((uid) => alive.has(uid)))
      }, () => { relicActionPending.current = false })
      return
    }
    setRelicCardUids([])
    setRelicShivEnemyUids([])
    onChange?.(result)
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
    setPowerOrbSlots([])
    setPowerGemContext(null)
    setPowerScryConfirmed(false)
    if (!onAction) {
      onChange?.(result!)
      return
    }
    const powerPreviewId = powerPreview?.id
    const unlock = () => {
      unknownPowerAction.current = null
      powerActionPending.current = false
      setUsingPower(false)
    }
    const waitForRefresh = (refreshAttempt = refreshRef.current) => {
      const combat = stateRef.current
      const current = combat.players.find((player) => player.id === viewer!.id)
      const decision = unknownPowerRefreshDecision(
        combat.powerTriggersUsedThisTurn.includes(powerAbilityKey(viewer!.id, powerUid)),
        refreshAttempt,
        refreshRef.current,
      )
      if (decision === 'committed') {
        unlock()
      } else if (decision === 'restore') {
        const unknown = { refreshAttempt: refreshAttempt!, powerUid, powerPreviewId, context }
        unlock()
        if (current) restoreUnknownPower(unknown, current,
          activePowerWindow(combat) && !combat.startTurnProgress?.forcedCard)
      } else if (decision === 'wait') {
        const unknown = { refreshAttempt: refreshAttempt!, powerUid, powerPreviewId, context }
        unknownPowerAction.current = unknown
      } else {
        unlock()
        setPendingPowerUid(powerUid)
      }
    }
    Promise.resolve(onAction({
      kind: 'activatePower', powerUid, powerPreviewId, ...context, preflight: true,
    })).then((outcome) => {
      if (outcome?.status === 'unknown') {
        waitForRefresh(outcome.refreshAttempt)
        return
      }
      if (outcome?.status === 'refused' || outcome?.status === 'reconciled') {
        const authoritative = reconciliation(outcome)
        const held = authoritative?.player.powers.find((power) => power.uid === powerUid)
        if (held && !authoritative!.combat.startTurnProgress?.forcedCard &&
          !authoritative!.combat.powerTriggersUsedThisTurn.includes(powerAbilityKey(viewer!.id, powerUid))) {
          restoreUnknownPower(
            { refreshAttempt: outcome.refreshAttempt ?? -1, powerUid, powerPreviewId, context },
            authoritative!.player,
            true,
            outcome?.snapshot?.powerPreview,
          )
          if (!pendingPowerNeedsGemChoice) setPowerScryConfirmed(false)
        }
      }
      unlock()
    }, () => waitForRefresh())
  }

  function restoreUnknownCard(submitted: Pending, current: Player, usingMiracle: boolean,
    authoritative = stateRef.current) {
    const alive = new Set(authoritative.enemies.filter((enemy) => !enemy.dead).map((enemy) => enemy.uid))
    const enemyUid = submitted.enemyUid && alive.has(submitted.enemyUid) ? submitted.enemyUid : null
    const enemyUids = submitted.enemyUids.filter((uid) => alive.has(uid))
    const slimeEnemyUids = submitted.slimeEnemyUids.filter((uid) => alive.has(uid))
    const hermitEnemyUids = submitted.hermitEnemyUids.filter((uid) => alive.has(uid))
    const soulburnEnemyUids = submitted.soulburnEnemyUids.filter((uid) => alive.has(uid))
    const shivEnemyUids = submitted.shivEnemyUids.filter((uid) => alive.has(uid))
    const choicePool = submitted.choiceCards ?? current.hand
    const picked = submitted.picked.filter((uid) => choicePool.some((card) => card.uid === uid))
    const targetChanged = enemyUid !== submitted.enemyUid || enemyUids.length !== submitted.enemyUids.length ||
      slimeEnemyUids.length !== submitted.slimeEnemyUids.length || hermitEnemyUids.length !== submitted.hermitEnemyUids.length ||
      soulburnEnemyUids.length !== submitted.soulburnEnemyUids.length || shivEnemyUids.length !== submitted.shivEnemyUids.length
    setMiracleOnCard(usingMiracle)
    setPending({
      ...submitted,
      enemyUid,
      enemyUids,
      slimeEnemyUids,
      hermitEnemyUids,
      soulburnEnemyUids,
      shivEnemyUids,
      picked,
      choiceConfirmed: submitted.choiceConfirmed && picked.length === submitted.picked.length && targetChanged,
    })
  }

  function chooseCreativeAiOrb(slot: number) {
    if (!creativeAiEffect || !pendingPowerUid || !viewer?.orbs[slot]) return
    if (!creativeAiEffect.anyNumber) {
      usePower(pendingPowerUid, { orbSlots: [slot] })
      return
    }
    setPowerOrbSlots((current) => current.includes(slot)
      ? current.filter((picked) => picked !== slot)
      : current.length < viewer.discard.length ? [...current, slot] : current)
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
      .then(() => setEditingStagedStartTurnTrigger(null))
      .finally(() => setUsingTrigger(false))
  }

  function confirmTriggerHermitChoices() {
    if (!pendingTrigger?.hermitChoices) return
    if (triggerHermitNeedsBoard) setTriggerHermitStep('target')
    // The engine still wants an enemy whenever a targeted Curse *could* be loaded;
    // when none was, any living enemy is equivalent.
    else resolveTrigger(undefined, pendingTrigger.targets?.[0]?.uid)
  }
  // Ordinary costs choose from the visible hand minus the card being played.
  // Post-draw costs choose from the private preview, which already models the
  // hand at the exact clause where the engine will charge it.
  const choicePoolSize = pending?.choiceCards?.length ??
    Math.max(0, viewer.hand.length - Number(pending?.cardInHand ?? true))
  const variableMinimum = Math.min(pending?.choice?.minimum ?? 0, choicePoolSize)
  const choiceNeeded = pending?.choice && pending.choice.kind !== 'scry' && pending.choice.kind !== 'scryToHand' &&
    pending.choice.kind !== 'discardAny' && pending.choice.kind !== 'exhaustAny' && pending.choice.kind !== 'loadAny' &&
    pending.choice.kind !== 'bottomdeck'
    ? Math.min(pending.choice.amount, choicePoolSize)
    : 0
  const pendingDef = pending ? faceOf(cardDef(pending.card.defId), pending.card.upgraded) : null
  // Slayer Pack: Deceive Reality's Scry must name one playable revealed card to play
  // for 0, judged as the engine will once the card itself counts as played.
  const scryPlay = pendingDef?.effects.some((effect) => effect.kind === 'scryAndPlay') === true
  // The engine judges it after the Scry, with Deceive Reality out of hand and counted as played.
  // Each judgement simulates the Scry on a copy of the board, so it runs once per reveal
  // and per change of the binned cards, not on every render.
  const scryPlayCards = scryPlay ? pending?.choiceCards : undefined
  const scryPlayPicked = scryPlay ? pending?.picked : undefined
  const scryPlaySourceUid = scryPlay ? pending?.card.uid : undefined
  const scryPlayEligibleUids = useMemo(() => {
    if (!scryPlayCards || !scryPlayPicked) return new Set<string>()
    const judged: CombatState = { ...state, players: state.players.map((player) => player.id === viewer.id
      ? { ...player, hand: player.hand.filter((card) => card.uid !== scryPlaySourceUid),
        cardsPlayedThisTurn: (player.cardsPlayedThisTurn ?? 0) + 1 } : player) }
    return new Set(scryPlayCards.filter((card) => scryPlayCardPlayable(judged, viewer.id, scryPlayCards, card.uid,
      scryPlayPicked.filter((uid) => uid !== card.uid))).map((card) => card.uid))
  }, [state, viewer.id, scryPlayCards, scryPlayPicked, scryPlaySourceUid])
  const scryPlayEligible = (card: CardInstance) => scryPlayEligibleUids.has(card.uid)
  const scryPlayRequired = scryPlay && pending?.choice?.kind === 'scryToHand' &&
    (pending.choiceCards ?? []).some(scryPlayEligible)
  const scryPlayChosenValid = Boolean(pending?.scryToHandUid && pending.choiceCards?.some((card) =>
    card.uid === pending.scryToHandUid && scryPlayEligible(card)))
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
  // Slayer Pack: Bowling Bash picks among the enemies adjacent to its
  // target, and a Boss is a Pressure Points target only while its price is affordable.
  const adjacentPickUids = pending?.enemyUid && pendingDef?.effects.some((effect) => effect.kind === 'damageAdjacent')
    ? new Set(adjacentEnemies(state, pending.enemyUid).map((enemy) => enemy.uid))
    : null
  const withAdjacentChoices = (next: Pending): Pending => {
    const effects = faceOf(cardDef(next.card.defId), next.card.upgraded).effects
    if (!effects.some((effect) => effect.kind === 'damageAdjacent')) return next
    const enemyChoices = adjacentDamageChoiceCount(effects, state, next.enemyUid)
    return enemyChoices === next.enemyChoices ? next : { ...next, enemyChoices, enemyUids: [] }
  }
  const slayerTargetAffordable = (next: Pending, enemy: Enemy | undefined): boolean => {
    const def = effectiveCombatCardDef(faceOf(cardDef(next.card.defId), next.card.upgraded), viewer.guardianMode)
    if (def.bossTargetCost === undefined || !enemy?.isBoss || !next.cardInHand || next.card.uid === forcedCardUid) return true
    const cost = playCost(cardDefForTarget(def, state, enemy.uid), viewer, next.card)
    return cost === 'X' || cost <= viewer.energy + (miracleOnCard ? 1 : 0)
  }
  const slayerTargetAllowed = (enemy: Enemy): boolean => {
    if (!pending) return true
    if (adjacentPickUids && pending.enemyUids.length < pending.enemyChoices) {
      return adjacentPickUids.has(enemy.uid) && !pending.enemyUids.includes(enemy.uid)
    }
    return pending.enemyUid !== null || slayerTargetAffordable(pending, enemy)
  }
  const handChoiceSatisfied = pending?.choice?.kind === 'scry' || pending?.choice?.kind === 'scryToHand'
    ? scryPlay ? scryPlayRequired ? scryPlayChosenValid : pending.scryToHandUid === undefined : true
    : pending?.choice?.kind === 'discardAny' || pending?.choice?.kind === 'exhaustAny' || pending?.choice?.kind === 'loadAny' ||
      pending?.choice?.kind === 'bottomdeck'
      ? true
    : pending?.choice?.kind === 'recoverExhaust' && pending.choice.minimum === 0
      ? pending.picked.length <= choiceNeeded
    : pending?.choice ? pending.picked.length === choiceNeeded : true
  const revealedChoiceSatisfied = !pending?.choiceCards || pending.choiceConfirmed
  const variableChoiceSatisfied = pending?.choice?.kind !== 'discardAny' && pending?.choice?.kind !== 'exhaustAny' &&
    pending?.choice?.kind !== 'loadAny' && pending?.choice?.kind !== 'bottomdeck' ||
    pending.choiceConfirmed && pending.picked.length >= variableMinimum
  const modeSatisfied = !pendingDef?.modes || pending?.mode !== null
  const corruptedShardModeNeeded = pendingDef != null && viewer.character !== 'guardian' &&
    viewer.guardianMode === null && cardReferencesGuardianMode(
      pendingDef, pending ? guardianGemForCard(viewer, pending.card) : undefined,
    )
  const corruptedShardModeSatisfied = !corruptedShardModeNeeded || pending?.corruptedShardMode !== null
  const energyChoiceSatisfied = (pendingDef?.cost !== 'X' || pending?.energySpent !== null) &&
    (pendingDef?.id !== 'slayer_metamorphosis' || pending?.metamorphosisPowerUid !== undefined)
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
    const chamber = viewer.chamber.filter((card) => !baseSet.has(card.uid) &&
      (!next.chamberPlay || card.uid !== next.card.uid)).map((card) => card.uid)
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
  const pendingNeedsCardEnemy = pendingEffectiveDef
    ? cardNeedsEnemy(pendingEffectiveDef.modes && pending?.mode != null
      ? { ...pendingEffectiveDef, modes: undefined, effects: pendingEffectiveDef.modes[pending.mode]?.effects ?? [] }
      : pendingEffectiveDef, viewer, false, pending?.effectEnergy ?? undefined,
      false, pending?.card.attachedGemId, pending?.card.uid, undefined, pending?.card.hermitDeadOn === true)
    : false
  const pendingEvokeChoice = pendingDef && pending
    ? nextEvokeChoice(pendingDef, viewer, pending.evokeSlots, state.die, pending.mode ?? undefined, pending.effectEnergy ?? 0)
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
    chosenEvokeOrbs(pendingDef!, viewer, pending.evokeSlots, state.die,
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
  // A Lightning/Dark Evoke that still needs an enemy floats its Orb like an
  // end-turn Orb, so the aim can be dragged and the glowing enemies have a cause.
  const evokeTargetOrb = pendingStartEvokeTarget
    ? pendingStartEvokeTarget.ability.evokeOrbs?.[pendingStartEvokeTarget.index]
    : pending && pendingDef && pendingEvokeTarget >= 0 && choiceSatisfied
      ? chosenEvokeOrbs(pendingDef, viewer, pending.evokeSlots, state.die, pending.mode ?? undefined,
        pending.effectEnergy ?? 0)[pendingEvokeTarget]
      : undefined
  const evokeChoiceOptions = pendingStartEvoke?.evokeChoice?.options ??
    (pendingEvokeChoice && pendingEvokeTarget < 0 && choiceSatisfied ? pendingEvokeChoice.options : undefined)
  // Local parties resolve every seat's start-of-turn choices from one screen.
  const evokeChoicePlayerId = pendingStartEvoke?.playerId ?? pendingStartEvokeTarget?.ability.playerId ?? viewer.id
  // Earlier Evokes and Channels in the same effect are still only planned; while they
  // are chosen and aimed, the owner's Orb row shows the slots that plan leaves.
  const evokePlannedOrbs = pendingStartEvoke?.evokePlanOrbs ?? pendingStartEvokeTarget?.ability.evokePlanOrbs ??
    (pending && pendingDef && choiceSatisfied && (pendingEvokeChoice || pendingEvokeTarget >= 0)
      ? evokePlan(pendingDef, viewer, pending.evokeSlots, state.die, pending.mode ?? undefined, pending.effectEnergy ?? 0).orbs
      : undefined)
  const evokeTargetSource: EndTurnAbility | undefined = evokeTargetOrb ? {
    id: 'evoke-target',
    playerId: pendingStartEvokeTarget?.ability.playerId ?? viewer.id,
    label: `Evoke ${evokeTargetOrb} Orb`,
    targets: pendingStartEvokeTarget ? pendingStartEvokeTarget.ability.evokeTargets ?? [] : pendingEvokeTargetOptions,
  } : undefined
  const evokeTargetStep = evokeTargetSource
    ? `${pendingStartEvokeTarget ? `${pendingStartEvokeTarget.ability.id}:${pendingStartEvokeTarget.index}`
      : `${pending?.card.uid}:${pendingEvokeTarget}`}`
    : null

  function cardContext(next: Pending) {
    return {
      enemyUid: next.enemyUid,
      enemyUids: next.enemyUids,
      playerId: next.playerId ?? viewer!.id,
      energySpent: next.chamberPlay && faceOf(cardDef(next.card.defId), next.card.upgraded).cost !== 'X'
        ? undefined : next.energySpent ?? undefined,
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
      topdeckUids: next.choice?.kind === 'topdeck' || next.choice?.kind === 'bottomdeck' ? next.picked : undefined,
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
      metamorphosisPowerUid: next.metamorphosisPowerUid,
    }
  }

  const pendingShivProgress = useMemo(() => pending && choiceSatisfied && evokeChoicesDone &&
    (!pendingNeedsCardEnemy || pending.enemyUid !== null) &&
    pending.enemyUids.length >= pending.enemyChoices &&
    pending.shivEnemyUids.length < pending.spentShivs + pending.overflowShivs
    ? previewCardShivTargets(state, viewer.id, pending.card.uid, cardContext(pending),
      pending.chamberPlay ? 'chamber' : pending.cardInHand ? 'hand' : 'copy')
    : null, [state, viewer, pending, pendingDef, choiceSatisfied, evokeChoicesDone,
      pendingNeedsCardEnemy, miracleOnCard])
  useEffect(() => {
    if (!pending || !pendingShivProgress) return
    if (pendingShivProgress.complete) {
      stageOrCommit(pending)
      return
    }
    if (pendingShivProgress.index >= pending.shivEnemyUids.length) return
    setPending((current) => current === pending
      ? { ...current, shivEnemyUids: current.shivEnemyUids.slice(0, pendingShivProgress.index) }
      : current)
  }, [pending, pendingShivProgress])

  function commit(next: Pending, skipOverflow = false) {
    if (cardActionPending.current) return
    const context = cardContext(next)
    // The online draw pile is not authoritative for action validation. The room
    // has already bound this action to its private preview, so only the engine
    // can validate it.
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
        setPending({ ...next, enemyUids: [], playerIds: [], slimeUids: [], slimeEnemyUids: [], chamberUids: [],
          chamberChoiceConfirmed: false, hermitEnemyUids: [],
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
      copyId: !next.cardInHand && !next.chamberPlay ? state.pendingCardCopy?.id : undefined,
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
      setPending(next.choiceCards ? next : null)
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
          const copyId = source === 'copy' ? state.pendingCardCopy?.id : undefined
          const refreshAttempt = outcome.refreshAttempt ?? refreshRef.current
          const committed = source === 'copy'
            ? currentCopy?.card.uid !== next.card.uid ||
              currentCopy.id !== copyId
            : current && !(source === 'chamber' ? current.chamber : current.hand)
              .some((card) => card.uid === next.card.uid)
          const refreshed = refreshAttempt !== undefined && refreshRef.current !== undefined &&
            refreshRef.current > refreshAttempt
          if (committed || refreshed) {
            if (refreshed && shouldDisarmCardFlight(next.cardInHand || next.chamberPlay, committed === true)) {
              armedCardFlight.current = null
            }
            if (committed) setPending(null)
            else if (current) restoreUnknownCard(next, current, usingMiracle)
            unlock()
          }
          else if (refreshAttempt !== undefined) {
            unknownCardAction.current = {
              refreshAttempt,
              cardUid: next.card.uid,
              source,
              copyId,
              pending: next,
              usingMiracle,
            }
          } else {
            if ((next.chamberPlay ? current?.chamber : current?.hand)
              ?.some((card) => card.uid === next.card.uid)) armedCardFlight.current = null
            unlock()
          }
          return
        }
        unlock()
        if (outcome?.status !== 'refused' && outcome?.status !== 'reconciled') {
          setPending(null)
          return
        }
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
              : authoritative.combat.pendingCardCopy?.card.uid !== next.card.uid ||
                authoritative.combat.pendingCardCopy.id !== action.copyId) {
            setPending(null)
            return
          }
          if (next.cardInHand || next.chamberPlay) armedCardFlight.current = null
          const authoritativePlayer: Player = {
            ...viewer!,
            ...authoritative.player,
            deck: authoritative.player.deck ?? viewer!.deck,
            draw: authoritative.player.draw ?? viewer!.draw,
            hand: authoritative.player.hand ?? viewer!.hand,
            chamber: authoritative.player.chamber ?? [],
            cardRewards: viewer!.cardRewards,
            rareRewards: viewer!.rareRewards,
          }
          const chamberCard = next.chamberPlay
            ? authoritativePlayer.chamber.find((card) => card.uid === next.card.uid)
            : undefined
          const staged = chamberCard ? stageHermitChamberViewer(authoritativePlayer, chamberCard) : undefined
          const pendingPlayer = staged?.player ?? authoritativePlayer
          const def = effectiveCombatCardDef(
            faceOf(cardDef(next.card.defId), next.card.upgraded), pendingPlayer.guardianMode,
          )
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
          const reconciledCombat = { ...stateRef.current, ...authoritative.combat } as CombatState
          if (next.choiceCards && !cardNeedsChoicePreview(def, reconciledCombat, pendingPlayer)) {
            setMiracleOnCard(usingMiracle)
            setPending({
              ...pendingFor(staged?.card ?? next.card, null, reconciledCombat, pendingPlayer,
                next.cardInHand, next.cardInHand || next.chamberPlay
                  ? undefined : authoritative.combat.pendingCardCopy?.energySpent,
                next.cardInHand || next.chamberPlay),
              chamberPlay: next.chamberPlay,
            })
            return
          }
          if (next.choiceCards) {
            setMiracleOnCard(usingMiracle)
            const preview = outcome?.snapshot?.cardPreview
            const matchingReveal = preview?.cardUid === next.card.uid && preview.kind === next.choice?.kind &&
              (preview.copy === true) === (!next.cardInHand && !next.chamberPlay) &&
              (preview.chamber === true) === next.chamberPlay
            if (matchingReveal) {
              const sameCards = preview.cards.length === next.choiceCards.length &&
                preview.cards.every((card, index) => card.uid === next.choiceCards?.[index]?.uid)
              const needsRetarget = preview.enemyUid !== next.enemyUid ||
                (preview.slimeEnemyUids ?? []).join('\0') !== next.slimeEnemyUids.join('\0')
              setPending({
                ...next,
                choiceCards: preview.cards,
                picked: sameCards ? next.picked : [],
                choiceConfirmed: sameCards && needsRetarget && next.choiceConfirmed,
                chamberUids: [],
                chamberChoiceConfirmed: false,
                hermitEnemyUids: [],
                scryToHandUid: sameCards ? next.scryToHandUid : undefined,
                enemyUid: preview.enemyUid,
                slimeUids: preview.slimeUids ?? [],
                slimeEnemyUids: preview.slimeEnemyUids ?? [],
              })
              return
            }
            if (next.chamberPlay) requestChamberChoicePreview(next.card, next.enemyUid, next)
            else if (next.cardInHand) requestChoicePreview(next.card, next.enemyUid, next)
            else requestCopyChoicePreview(next.enemyUid, next)
            return
          }
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
            nextEvokeChoice(def, pendingPlayer, [], authoritative.combat.die, undefined, effectEnergy ?? 0)) {
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
                (next.choice?.kind === 'discardAny' || next.choice?.kind === 'exhaustAny' || next.choice?.kind === 'bottomdeck')
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

  function withEvokeSlot(next: Pending, slot: number): Pending {
    const def = faceOf(cardDef(next.card.defId), next.card.upgraded)
    const evokeSlots = [...next.evokeSlots, slot]
    const orbs = chosenEvokeOrbs(def, viewer!, evokeSlots, state.die,
      next.mode ?? undefined, next.effectEnergy ?? 0)
    return {
      ...next,
      evokeSlots,
      evokeEnemyUids: [...next.evokeEnemyUids, ...orbs.slice(next.evokeEnemyUids.length)
        .map((orb) => orb === 'frost' ? null : undefined)],
    }
  }

  function stageOrCommit(next: Pending) {
    next = withAdjacentChoices(next)
    if (next.choiceCards?.length === 0 &&
      (next.choice?.kind === 'scry' || next.choice?.kind === 'scryToHand')) {
      next = { ...next, choiceConfirmed: true }
    }
    const def = effectiveCombatCardDef(
      faceOf(cardDef(next.card.defId), next.card.upgraded), next.corruptedShardMode ?? viewer!.guardianMode,
    )
    if (def.id === 'dual_cast') {
      const choice = nextEvokeChoice(def, viewer!, next.evokeSlots, state.die, next.mode ?? undefined, next.effectEnergy ?? 0)
      if (choice?.options.length === 1) next = withEvokeSlot(next, choice.options[0]!.slot)
    }
    const onlySlime = viewer!.slimes.length === 1 ? viewer!.slimes[0] : undefined
    if (onlySlime && !next.slimeChoiceConfirmed && next.slimeChoice?.minimum === 1 &&
      next.slimeChoice.amount === 1 && (def.cost !== 'X' || next.energySpent !== null) &&
      (!def.modes || next.mode !== null) &&
      (!next.cardInHand && !next.chamberPlay || forcedCardUid === next.card.uid ||
        slimeChoiceIsAvailable(def, state, viewer!, onlySlime.card.uid, next.effectEnergy ?? 0))) {
      next = { ...next, slimeUids: [onlySlime.card.uid], slimeChoiceConfirmed: true }
    }
    const enemies = livingEnemies(state)
    if (enemies.length === 1 && (!next.slimeChoice || next.slimeChoiceConfirmed)) {
      next = { ...next, slimeEnemyUids: Array<string>(slimeEnemyChoicesRequired(next)).fill(enemies[0]!.uid) }
    }
    const evokeProgress = evokeTargetProgress(
      def, state, viewer!, next.evokeSlots, next.evokeEnemyUids,
      next.mode ?? undefined, next.effectEnergy ?? 0,
    )
    if (evokeProgress.complete && next.evokeEnemyUids.length > evokeProgress.index) {
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
    if (next.shivEnemyUids.length < next.spentShivs + next.overflowShivs) {
      const progress = previewCardShivTargets(state, viewer!.id, next.card.uid, cardContext(next),
        next.chamberPlay ? 'chamber' : next.cardInHand ? 'hand' : 'copy')
      const unusedTarget = next.shivEnemyUids.at(-1) ?? next.enemyUid ?? livingEnemies(state)[0]?.uid
      if (progress?.complete && unusedTarget) {
        next = { ...next, shivEnemyUids: [...next.shivEnemyUids,
          ...Array<string>(next.spentShivs + next.overflowShivs - next.shivEnemyUids.length).fill(unusedTarget)] }
      }
    }
    const poolSize = next.choiceCards?.length ?? Math.max(0, viewer!.hand.length - Number(next.cardInHand))
    const minimumPaid = next.picked.length >= Math.min(next.choice?.minimum ?? 0, poolSize)
    const owed = next.choice && next.choice.kind !== 'scry' &&
      next.choice.kind !== 'discardAny' && next.choice.kind !== 'exhaustAny' && next.choice.kind !== 'loadAny' &&
      next.choice.kind !== 'bottomdeck'
      ? Math.min(next.choice.amount, poolSize)
      : 0
    const selectionReady = next.choice?.kind === 'scry' || next.choice?.kind === 'scryToHand' || next.choice?.kind === 'discardAny' ||
      next.choice?.kind === 'exhaustAny' || next.choice?.kind === 'loadAny' || next.choice?.kind === 'bottomdeck' ||
      next.choice?.kind === 'recoverExhaust' && next.choice.minimum === 0 ||
      next.picked.length === owed
    const ready = selectionReady && minimumPaid && (!next.choiceCards || next.choiceConfirmed) &&
      (next.choice?.kind !== 'discardAny' && next.choice?.kind !== 'exhaustAny' && next.choice?.kind !== 'loadAny' &&
        next.choice?.kind !== 'bottomdeck' || next.choiceConfirmed) && downfallChoicesReady(next) &&
      (!def.modes || next.mode !== null) &&
      !nextEvokeChoice(def, viewer!, next.evokeSlots, state.die, next.mode ?? undefined, next.effectEnergy ?? 0) &&
      !next.evokeEnemyUids.some((target) => target === undefined) &&
      (def.cost !== 'X' || next.energySpent !== null) &&
      (def.id !== 'slayer_metamorphosis' || next.metamorphosisPowerUid !== undefined) &&
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

  function preserveRevealedSelection(next: Pending, previous?: Pending) {
    const unchanged = previous?.choiceCards && next.choice?.kind === previous.choice?.kind &&
      next.choiceCards?.length === previous.choiceCards.length &&
      next.choiceCards.every((card, index) => card.uid === previous.choiceCards?.[index]?.uid)
    return unchanged ? {
      ...next,
      picked: previous.picked,
      choiceConfirmed: previous.choiceConfirmed,
      scryToHandUid: previous.scryToHandUid,
    } : next
  }

  function requestChoicePreview(card: CardInstance, enemyUid: string | null = null,
    selections?: Pending) {
    if (cardActionPending.current) return
    if (!onAction) {
      const preview = previewCardChoice(state, viewer!.id, card.uid)
      if (!preview) return
      const next = preserveRevealedSelection({ ...pendingFor(card, preview.cards, state, viewer!), enemyUid,
        slimeUids: selections?.slimeUids ?? [], slimeEnemyUids: selections?.slimeEnemyUids ?? [] }, selections)
      if (next.choice?.kind === preview.kind) stageOrCommit(next)
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
      const next = preserveRevealedSelection({ ...pendingFor(held, preview.cards, current, player), enemyUid: preview.enemyUid,
        slimeUids: preview.slimeUids ?? [], slimeEnemyUids: preview.slimeEnemyUids ?? [] }, selections)
      if (next.choice?.kind === preview.kind) stageOrCommit(next)
    }, () => {
      cardActionPending.current = false
      setUsingCard(false)
    })
  }

  function requestCopyChoicePreview(enemyUid: string | null = null,
    selections?: Pending) {
    if (cardActionPending.current || !viewer) return
    const copy = state.pendingCardCopy
    if (!copy || copy.playerId !== viewer.id) return
    if (!onAction) {
      const preview = previewCardCopyChoice(state, viewer.id)
      if (!preview) return
      const next = preserveRevealedSelection({
        ...pendingFor(copy.card, preview.cards, state, viewer, false, copy.energySpent), enemyUid,
        slimeUids: selections?.slimeUids ?? [], slimeEnemyUids: selections?.slimeEnemyUids ?? [] }, selections)
      if (next.choice?.kind === preview.kind) stageOrCommit(next)
      return
    }
    cardActionPending.current = true
    setUsingCard(true)
    Promise.resolve(onAction({ kind: 'previewCardCopy', cardUid: copy.card.uid,
      copyId: copy.id, enemyUid,
      slimeUids: selections?.slimeUids, slimeEnemyUids: selections?.slimeEnemyUids })).then((outcome) => {
      cardActionPending.current = false
      setUsingCard(false)
      const current = stateRef.current
      const currentCopy = current.pendingCardCopy
      const player = current.players.find((candidate) => candidate.id === viewerId)
      const preview = outcome?.snapshot?.cardPreview
      if (outcome?.status !== 'accepted' || !preview?.copy || !currentCopy || !player) return
      const next = preserveRevealedSelection({ ...pendingFor(currentCopy.card, preview.cards, current, player, false,
        currentCopy.energySpent), enemyUid: preview.enemyUid,
        slimeUids: preview.slimeUids ?? [], slimeEnemyUids: preview.slimeEnemyUids ?? [] }, selections)
      if (next.choice?.kind === preview.kind) stageOrCommit(next)
    }, () => {
      cardActionPending.current = false
      setUsingCard(false)
    })
  }

  function requestChamberChoicePreview(card: CardInstance, enemyUid: string | null = null,
    selections?: Pending) {
    if (cardActionPending.current || !viewer) return
    if (!onAction) {
      const preview = previewHermitChamberCardChoice(state, viewer.id, card.uid)
      if (!preview) return
      const required = state.pendingHermitChamberPlays?.[0]
      const staged = stageHermitChamberViewer(viewer, card,
        required?.playerId === viewer.id && required.cardUids[0] === card.uid && required.free)
      const next = preserveRevealedSelection({
        ...pendingFor(staged.card, preview.cards, state, staged.player, false, undefined, true),
        chamberPlay: true, enemyUid,
        ...(selections?.energySpent === null || selections?.energySpent === undefined ? {} : {
          energySpent: selections.energySpent, effectEnergy: selections.energySpent,
          energyCharged: selections.energySpent,
        }),
        slimeUids: selections?.slimeUids ?? [], slimeEnemyUids: selections?.slimeEnemyUids ?? [] }, selections)
      if (next.choice?.kind === preview.kind) stageOrCommit(next)
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
      const next = preserveRevealedSelection({
        ...pendingFor(staged.card, preview.cards, current, staged.player, false, undefined, true), chamberPlay: true,
        enemyUid: preview.enemyUid,
        ...(preview.energySpent === undefined ? {} : { energySpent: preview.energySpent,
          effectEnergy: preview.energySpent, energyCharged: preview.energySpent }),
        slimeUids: preview.slimeUids ?? [], slimeEnemyUids: preview.slimeEnemyUids ?? [] }, selections)
      if (next.choice?.kind === preview.kind) stageOrCommit(next)
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
      const any = pending.choice.kind === 'discardAny' || pending.choice.kind === 'exhaustAny' ||
        pending.choice.kind === 'bottomdeck'
      const handChoices = Math.max(0, viewer!.hand.length - Number(pending.cardInHand))
      const need = pending.choice.kind === 'discardAny'
        ? handChoices
        : Math.min(pending.choice.amount, handChoices)
      const picked = already
        ? pending.picked.filter((uid) => uid !== card.uid)
        : [...pending.picked, card.uid].slice(-need)
      const next = { ...pending, picked, choiceConfirmed: false, chamberChoiceConfirmed: false }
      setPending(next)
      // The card may already have been dragged onto its target. Let the shared
      // readiness check commit as soon as its fixed hand cost is satisfied.
      if (!any && picked.length === need) stageOrCommit(next)
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
        if (slayerTargetAffordable(next, state.enemies.find((enemy) => enemy.uid === draggedEnemyUid))) {
          next = { ...next, enemyUid: draggedEnemyUid }
        }
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

  function resolveTurnEffectTarget(abilityId: string, targetUid: string) {
    if (pendingStartPlayer?.id === abilityId && pendingStartPlayer.players?.some((player) => player.id === targetUid)) {
      chooseStartTurnPlayer(targetUid)
      setArmedEndTurnAbilityId(null)
      return
    }
    if (pendingStartEnemy?.id === abilityId) {
      chooseStartTurnEnemy(targetUid)
      setArmedEndTurnAbilityId(null)
      return
    }
    if (evokeTargetSource?.id === abilityId) {
      setArmedEndTurnAbilityId(null)
      if (pendingStartEvokeTarget) chooseStartTurnEvokeEnemy(targetUid)
      else chooseCardEvokeTarget(targetUid)
      return
    }
    if (!endTurnEffect || !canResolveEndTurn || endTurnEffect.id !== abilityId ||
      !endTurnEffect.targets?.some((target) => target.uid === targetUid)) return
    if (endTurnSelfExhaust && endTurnEffect.targets.some((target) => target.uid === selfExhaustEndTurnTarget(targetUid))) {
      targetUid = selfExhaustEndTurnTarget(targetUid)
    }
    setArmedEndTurnAbilityId(null)
    if (onAction) {
      onAction({ kind: 'resolveEndTurnEffect', abilityId, targetUid })
      return
    }
    const next = resolveEndTurnAbility(state, chooseEndTurnTarget(abilityId, targetUid))
    if (next !== state) onChange?.(next)
  }

  const {
    cardDrag,
    endTurnEffectDrag,
    armedEndTurnAbilityId,
    setArmedEndTurnAbilityId,
    endTurnEffectAimed,
    endTurnEffectDragCard,
    endTurnEffectDragSlimeAsset,
    endTurnEffectDragRelicId,
    cardDragTargetRow,
    suppressCardClick,
    suppressEndTurnOrbClick,
    cardDragOverlay,
    cardDragArrow,
    cardDragArrowShadow,
    endTurnEffectDragOverlay,
    endTurnEffectDragArrow,
    endTurnEffectDragArrowShadow,
    endTurnTargetForEnemy,
    endTurnTargetForRow,
    endTurnTargetForOrb,
    isEndTurnEnemyTarget,
    onEndTurnOrbPointerDown,
    onEndTurnEffectPointerDown,
    onEndTurnEffectPointerMove,
    finishEndTurnEffectDrag,
    cancelEndTurnEffectDrag,
    activateEndTurnEffect,
    chamberCardCanStartDrag,
    onCardPointerDown,
    onCardPointerMove,
    finishCardDrag,
    cancelCardDrag,
    activateCard,
  } = useCombatDrag({
    state,
    viewer,
    viewerId,
    drawCount,
    authoritativeRestoration,
    authoritativeConnected,
    usingCard,
    pending,
    pendingTrigger,
    endTurnResolving,
    forcedCard,
    distilled,
    relicScry,
    miracleOnCard,
    voluntaryActionsBlocked,
    endTurnEffect,
    canResolveEndTurn,
    canResolveStartTurn,
    startTurnEffectDraggable,
    startTurnEffectSource,
    evokeTargetSource,
    evokeTargetOrb,
    evokeTargetStep,
    pendingStartEnemy,
    startEnemyChoiceAvailable,
    onResolveTurnEffectTarget: resolveTurnEffectTarget,
    onCardClick,
    onHermitChamberPlay: submitHermitChamber,
  })

  const previewEnemyUid = (() => {
    const living = livingEnemies(state)
    if (living.length === 1) return living[0]!.uid
    const picked = cardDrag?.targetUid ?? pointedEnemyUid
    return living.some((enemy) => enemy.uid === picked) ? picked : null
  })()
  const cardDamage = useMemo(() => {
    const previews = new Map<string, CardDamagePreview>()
    if (!cardHints || viewer.dead || state.phase !== 'player') return previews
    for (const card of viewer.hand) {
      const preview = previewCardDamage(state, viewer.id, card.uid, previewEnemyUid, Boolean(onAction))
      if (preview) previews.set(card.uid, preview)
    }
    return previews
  }, [cardHints, state, viewer, previewEnemyUid, onAction])

  // In local solo all information is present, so a turn with literally no
  // card, token, potion, Power, or relic action can safely collapse. Online
  // hands are private and shared turn order is meaningful, so clients never
  // guess on behalf of the party.
  const viewerHasLegalAction = !voluntaryActionsBlocked && (viewer.hand.some((card) => canAfford(state, viewer, card, false, drawCount)) ||
    viewer.chamber.some(chamberCardCanStartDrag) ||
    viewer.shivs > 0 || viewer.soulburn > 0 ||
    viewer.guardianMode && viewer.vigor > 0 && !viewer.cardPlayLocked && !reachedTimeWarpLimit(state, viewer) ||
    viewer.miracles > 0 && viewer.energy < CAPS.energy && (
      viewer.relics.some((relic) => relic.defId === 'ice_cream') ||
      viewer.hand.some((card) => canAfford(state, viewer, card, true, drawCount))) ||
    viewer.potions.some((potionId) => canUsePotionNow(potionId)) ||
    viewer.powers.some((power) => {
      const def = faceOf(cardDef(power.defId), power.upgraded)
      return Boolean(def.activeAbility) && (!def.oncePerTurn || !powerAbilityUsed(state, viewer.id, power.uid)) &&
        powerActivationAllowed(def, state, viewer)
    }) ||
    viewer.relics.some((_, relicIndex) => canUseRelicNow(relicIndex)) || courierAvailable)
  useEffect(() => {
    if (onAction || !autoAdvance || !autoEndTurn || state.players.length !== 1 || state.phase !== 'player' ||
      viewer.dead || viewerHasLegalAction || voluntaryActionsBlocked || forcedCard || distilled || pending || pendingTrigger ||
      endTurnResolving || playWindow) return undefined
    const timer = window.setTimeout(finishTurn, 450)
    return () => window.clearTimeout(timer)
    // Slayer Pack: an open card-play window is still being resolved; the engine closes it once nothing is left.
  }, [autoAdvance, autoEndTurn, state.phase, state.turn, state.players.length, viewer.dead, viewerHasLegalAction,
    forcedCard, distilled, pending, pendingTrigger, endTurnResolving, voluntaryActionsBlocked, playWindow])

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
      const deterministic = onAction ? state : resolveDeterministicForcedCard(state)
      if (deterministic !== state) {
        onChange?.(deterministic)
        return
      }
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
  // boss itself anchors a boss-only click; cleared rows can still be chosen
  // on their empty ground instead of showing another button.
  function onEnemyClick(enemy: Enemy) {
    const endTurnTarget = endTurnTargetForEnemy(enemy)
    if (endTurnTarget && armedEndTurnAbilityId === endTurnEffect?.id) {
      resolveTurnEffectTarget(endTurnEffect.id, endTurnTarget)
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
      if (triggerHermitChoicesReady && pendingTrigger.rows?.some((target) => target.row === enemy.row)) {
        resolveTrigger(enemy.row)
        return
      }
    }
    if (pendingStartEnemy) {
      chooseStartTurnEnemy(enemy.uid)
      setArmedEndTurnAbilityId(null)
      return
    }
    if (pendingStartShiv) {
      chooseStartTurnShiv(enemy.uid)
      return
    }
    if (pendingStartEvokeTarget) {
      if (enemy.isBoss) {
        if (pendingStartEvokeTarget.ability.evokeTargets?.some((target) => target.uid === enemy.uid)) {
          chooseStartTurnEvokeEnemy(enemy.uid)
        }
        return
      }
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
        const shivsBefore = viewer!.shivs
        setSpendingShiv(false)
        Promise.resolve(onAction({ kind: 'spendShiv', enemyUid: enemy.uid })).then((outcome) => {
          const current = stateRef.current.players.find((player) => player.id === viewerId)
          if ((outcome?.status === 'refused' || outcome?.status === 'reconciled') &&
            current && current.shivs >= shivsBefore) setSpendingShiv(true)
        })
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
        const soulburnBefore = viewer!.soulburn
        setSpendingSoulburn(false)
        setExtraCrispySoulburn(false)
        Promise.resolve(onAction({ kind: 'spendSoulburn', enemyUid: enemy.uid, extraCrispyPowerUid })).then((outcome) => {
          const current = stateRef.current.players.find((player) => player.id === viewerId)
          if ((outcome?.status === 'refused' || outcome?.status === 'reconciled') &&
            current && current.soulburn >= soulburnBefore) {
            setSpendingSoulburn(true)
            setExtraCrispySoulburn(Boolean(extraCrispyPowerUid))
          }
        })
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
      chooseCardEvokeTarget(pendingEvokeUsesRows && !enemy.isBoss ? lightningRowTarget(enemy.row) : enemy.uid)
      return
    }
    if (!evokeChoicesDone) return
    if (!pending || !pending.needsEnemy || !choiceSatisfied) return
    const normalTargetNeeded = pendingNeedsCardEnemy && !pending.enemyUid
    if (normalTargetNeeded) {
      if (pendingDef && cardNeedsChoicePreview(pendingDef, state, viewer!)) {
        if (pending.chamberPlay) requestChamberChoicePreview(pending.card, enemy.uid, pending)
        else if (pending.cardInHand) requestChoicePreview(pending.card, enemy.uid, pending)
        else requestCopyChoicePreview(enemy.uid, pending)
        return
      }
      if (!slayerTargetAffordable(pending, enemy)) return
      const next = withAdjacentChoices({ ...pending, enemyUid: enemy.uid })
      if (next.spentShivs + next.overflowShivs > 0) stageOrCommit(next)
      else if (next.enemyUids.length < next.enemyChoices ||
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
      if (adjacentPickUids && !slayerTargetAllowed(enemy)) return
      const next = { ...pending, enemyUids: [...pending.enemyUids, enemy.uid] }
      if (next.enemyUids.length < next.enemyChoices || next.spentShivs + next.overflowShivs > 0 ||
        next.needsAlly || next.playerIds.length < next.playerChoices || next.needsSwitch) setPending(next)
      else commit(next)
      return
    }
    if (pending.shivEnemyUids.length < pending.spentShivs + pending.overflowShivs) {
      if (pendingShivProgress && !pendingShivProgress.options.some((option) => option.uid === enemy.uid)) return
      const next = { ...pending, shivEnemyUids: [...pending.shivEnemyUids, enemy.uid] }
      stageOrCommit(next)
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
    if (!usingTrigger && pendingTrigger && pendingTrigger.playerId === viewer?.id && triggerHermitChoicesReady &&
      pendingTrigger.rows?.some((target) => target.row === enemy.row)) {
      return true
    }
    if (pendingStartEvokeTarget && (enemy.isBoss
      ? pendingStartEvokeTarget.ability.evokeTargets?.some((target) => target.uid === enemy.uid)
      : pendingStartEvokeRows.some((target) => target.row === enemy.row))) return true
    if (pendingPotion && pendingPotionDef?.target === 'row') return true
    if (pendingPowerUid && pendingPowerDef?.target === 'row') return true
    if (pending && pendingEvokeTarget >= 0 && pendingEvokeUsesRows && choiceSatisfied &&
      pendingEvokeTargetUids.has(enemy.isBoss ? enemy.uid : lightningRowTarget(enemy.row))) return true
    return false
  }

  // Cleared rows are still legal choices when no enemy anchors them.
  function onRowLaneClick(row: number) {
    const endTurnTarget = endTurnTargetForRow(row)
    if (endTurnTarget && armedEndTurnAbilityId === endTurnEffect?.id) {
      resolveTurnEffectTarget(endTurnEffect.id, endTurnTarget)
      return
    }
    if (pendingTrigger && pendingTrigger.playerId === viewer?.id && triggerHermitChoicesReady &&
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
    if (pendingEvokeUsesRows) chooseCardEvokeTarget(lightningRowTarget(row))
  }

  function isRowLaneClickTargetable(row: number): boolean {
    if (endTurnEffectAimed && endTurnTargetForRow(row)) return true
    if (!usingTrigger && pendingTrigger && pendingTrigger.playerId === viewer?.id && triggerHermitChoicesReady &&
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

  // The ground's accessible name follows the same priority as its click.
  function rowLaneClickLabel(row: number): string {
    const rowLabel = combatRowLabel(state, row)
    if (endTurnEffectAimed && endTurnEffect && endTurnTargetForRow(row)) {
      return `Resolve ${endTurnEffect.label} in ${rowLabel}`
    }
    if (!usingTrigger && pendingTrigger && pendingTrigger.playerId === viewer?.id && triggerHermitChoicesReady &&
      pendingTrigger.rows?.some((target) => target.row === row)) {
      return `Resolve ${pendingTrigger.label} in ${rowLabel}`
    }
    if (pendingStartEvokeTarget && pendingStartEvokeRows.some((target) => target.row === row)) {
      return `Evoke Lightning in ${rowLabel}`
    }
    if (pendingPotion && pendingPotionDef?.target === 'row') {
      return `Target ${rowLabel} with ${pendingPotionDef.name}`
    }
    if (pendingPowerUid && pendingPowerDef?.target === 'row') {
      return `Target ${rowLabel} with ${pendingPowerDef.name}`
    }
    if (pending && pendingEvokeTarget >= 0 && pendingEvokeUsesRows && choiceSatisfied &&
      pendingEvokeTargetUids.has(lightningRowTarget(row))) {
      return `Evoke Lightning in ${rowLabel}`
    }
    return `Target ${rowLabel}`
  }

  function chooseCardEvokeTarget(targetUid: string) {
    if (!pending || pendingEvokeTarget < 0 || !choiceSatisfied || !pendingEvokeTargetUids.has(targetUid)) return
    const targets = [...pending.evokeEnemyUids]
    targets[pendingEvokeTarget] = targetUid
    stageOrCommit({ ...pending, evokeEnemyUids: targets })
  }

  function onEvokeClick(slot: number) {
    if (!pending || !pendingEvokeChoice || pendingEvokeTarget >= 0 || !choiceSatisfied) return
    const option = pendingEvokeChoice.options.find((candidate) => candidate.slot === slot)
    if (!option) return
    stageOrCommit(withEvokeSlot(pending, slot))
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
    if (pendingStartPlayer?.players?.some((player) => player.id === ally.id) &&
      armedEndTurnAbilityId === pendingStartPlayer.id) {
      chooseStartTurnPlayer(ally.id)
      setArmedEndTurnAbilityId(null)
      return
    }
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
  const enemyPrompt = deriveEnemyPrompt({
    state,
    pending,
    pendingDef,
    normalEnemyPending,
    independentEnemyPending,
    independentHitPending,
    adjacentPickUids,
    spentShivPending,
    overflowOnly,
    pendingShivProgress,
    originalTarget,
    copyTarget,
    rowHitSuffix,
  })
  // The Hermit setup Load pauses the Draw step; start-of-turn order comes after it.
  const startTurnOpen = state.phase === 'start' && !forcedCard && !pendingTrigger &&
    (state.pendingHermitSetupLoads?.length ?? 0) === 0 &&
    // Slayer Pack: Magnetism's answer resumes the order by itself.
    owedChoices.length === 0
  const startTurnChoicesOpen = startTurnOpen && !stagedStartTurnTriggerPending && !activeStartTurnScry &&
    orderedStartTurnScries.length === 0
  const visibleStartModeShift = startTurnChoicesOpen ? pendingStartModeShift : undefined
  // A required seat whose Resolve button is disabled or missing, with
  // no private prompt to answer, has no way forward. Another seat may just be
  // slow, so this only offers a manual re-sync after a long pause.
  const startTurnLooksStuck = Boolean(onAction && onResync && startTurnChoicesOpen &&
    requiredStartTurnPlayerIds?.includes(viewer.id) && !activeStartTurnDiscard &&
    !dieRelicPending && !visibleStartModeShift && (resolvingStartTurnMode || !canResolveStartTurn))
  const [startTurnStuck, setStartTurnStuck] = useState(false)
  const [resyncing, setResyncing] = useState(false)
  useEffect(() => {
    setStartTurnStuck(false)
    if (!startTurnLooksStuck) return undefined
    const timer = window.setTimeout(() => setStartTurnStuck(true), START_TURN_STUCK_MS)
    return () => window.clearTimeout(timer)
  }, [startTurnLooksStuck, authoritativeVersion])
  const handExhaustChoiceUids = new Set(startTurnChoicesOpen
    ? handStartExhaust?.exhaustCards?.filter((card) => viewer.hand.some((held) => held.uid === card.uid) &&
      card.uid !== startTurnExhaustUids[handStartExhaust.id]).map((card) => card.uid)
    : [])
  // Only picks the current plan still honours; a reorder can take a chosen card out of a step's reach.
  const chosenStartExhaustUids = new Set(startTurnChoicesOpen
    ? orderedStartAbilities.flatMap((ability) => ability.exhaustCards
      ?.filter((card) => card.uid === startTurnExhaustUids[ability.id]).map((card) => card.uid) ?? [])
    : [])
  const startTurnPrompt = deriveStartTurnPrompt({
    state,
    pendingStartExhaust,
    pendingStartShiv,
    pendingStartEnemy,
    pendingStartPlayer,
    pendingStartEvokeTarget,
    pendingStartEvokeRows,
    pendingStartEvoke,
    teammateStartExhaust,
    rowHitSuffix,
  })
  const forcedPrompt = deriveForcedPrompt(state, viewerId, forcedCard, pending)
  const plunderPrompt = derivePlunderPrompt(state, viewer.id, pendingPlunder)
  // Slayer Pack: another player's card-given choice (the owner answers in their own prompt below).
  const waitingPlayerChoice = viewerPlayerChoice ? undefined : owedChoices[0]
  const playerChoicePrompt = derivePlayerChoicePrompt(state, waitingPlayerChoice)
  const dieRelicPrompt = deriveDieRelicPrompt(state, viewer.id, dieRelicPending)
  const triggerPrompt = deriveTriggerPrompt({
    state,
    viewerId: viewer.id,
    pendingTrigger,
    triggerHermitChoicesReady,
    triggerSlimeChoicesReady,
    triggerSlimeEnemyUids,
    triggerSlimeEnemyAmount,
    triggerSlimeEnemyLabels,
    triggerHermitCurse,
    rowHitSuffix,
  })
  const beforeDrawPrompt = deriveBeforeDrawPrompt(state, viewer.id, activeStartTurnScry)
  // Slayer Pack: The viewer's live card-play window: the cards a resolved
  // Discovery, Violence, ... still lets them play, at the window's exact cost.
  const playWindowName = playWindow ? cardDef(playWindow.sourceCardId).name : ''
  const playWindowPrompt = derivePlayWindowPrompt(state, playWindow)
  const prompt = derivePrompt({
    viewer,
    dieRelic: dieRelicPrompt,
    plunder: plunderPrompt,
    trigger: triggerPrompt,
    forced: forcedPrompt,
    beforeDraw: beforeDrawPrompt,
    startTurn: startTurnPrompt,
    playWindow: playWindowPrompt,
    enemy: enemyPrompt,
    rowHitSuffix,
    pendingPower,
    pendingPowerDef,
    powerScryConfirmed,
    pendingPowerNeedsAlly,
    powerChamberUids,
    powerLoadUids,
    creativeAiEffect,
    pendingPotion,
    pendingPotionDef,
    pendingPotionOverflow,
    pendingPotionNeedsEnemy,
    potionCardUids,
    potionShivEnemyUids,
    viewerHasSozu,
    spendingShiv,
    spendingSoulburn,
    pending,
    pendingDef,
    slimeEnemyChoicesRequired,
    slimeEnemyChoiceLabels,
    chamberChoiceRequired,
    loadedTargetCount,
    modeSatisfied,
    corruptedShardModeNeeded,
    corruptedShardModeSatisfied,
    pendingPowerBeamChoiceNeeded,
    choiceNeeded,
    choicePoolSize,
    pendingSearchKind,
    handChoiceSatisfied,
    pendingEvokeTarget,
    pendingEvokeUsesRows,
    pendingEvokeChoice,
    enemyChoicesDone,
    independentPlayerPending,
    switchChoiceReady,
  })
  const displayedPileCount = (kind: 'draw' | 'discard' | 'exhaust', count: number) =>
    Math.max(0, count - cardFlights.filter((flight) => flight.destination === kind && !flight.landed).length)
  const drawPileCount = drawCount ?? viewer.draw.length

  return (
    <div
      className="combat"
      data-webmcp-solo-turn={!onAction && mutationsEnabled && state.players.length === 1 && state.phase === 'player'
        ? `${state.combatId}:${state.turn}` : undefined}
      onClick={(event) => {
        if (!(event.target instanceof Element) || event.target.closest(
          'button, a, input, select, textarea, [role="button"], dialog, .card-keyword-tips, .die-relic__head, .potion-tip',
        )) return
        if (!pending || usingCard || pending.choiceCards || pending.card.uid === forcedCardUid ||
          (!pending.cardInHand && !pending.chamberPlay)) return
        setPending(null)
        const focused = document.activeElement
        if (focused instanceof HTMLElement && focused.closest('.hand')) focused.blur()
      }}
      inert={chamberClosing}
      aria-busy={chamberClosing || undefined}
      data-act={stageAct}
      data-character={viewer.character}
      data-phase={state.phase}
      data-party-size={state.players.length}
      data-stage-motion={stageMotionReady && !prefersReducedMotion || undefined}
      style={{
        backgroundImage: `linear-gradient(90deg, rgb(2 5 8 / 0.38), transparent 22%, transparent 74%, rgb(2 5 8 / 0.32)), url("${assetPath(`backgrounds/boss-act-${stageAct}.webp`)}")`,
        '--stage-scale': stageScale,
        '--stage-enemy-count': stageEnemySlots,
        '--stage-party-count': state.players.length,
        '--stage-width': `calc(${state.players.length} * var(--stage-player-gap) + var(--stage-enemy-count) * var(--stage-enemy-gap) + ${STAGE_MARGIN_REM}rem * var(--stage-scale) + var(--slime-enemy-clearance, 0rem))`,
        '--slime-count': largestSlimeParty,
        '--stage-gap': `calc(${STAGE_GAP_REM}rem * var(--stage-scale))`,
        '--stage-enemy-gap': 'var(--stage-gap)',
        '--stage-actor-width': `calc(${STAGE_GAP_REM - 1}rem * var(--stage-scale))`,
      } as React.CSSProperties}
    >
      <GroundedCombatVfx
        enemies={state.enemies}
        activeVfx={activeVfx}
        orbEndTurnRevealDelayMs={orbEndTurnRevealDelayMs}
      />
      <CombatBar
        combatBarRef={combatBarRef}
        endTurnRef={endTurnRef}
        state={state}
        viewer={viewer}
        viewerId={viewerId}
        livingPlayers={livingPlayers}
        copyResolutionLabel={copyResolutionLabel}
        hermitSetupPending={hermitSetupPending}
        hermitSetupOwner={hermitSetupOwner}
        onCourierReveal={onCourierReveal}
        courierUsedBy={courierUsedBy}
        playerChoicePrompt={playerChoicePrompt}
        viewerPlayerChoice={viewerPlayerChoice}
        usingPlayerChoice={usingPlayerChoice}
        submitPlayerChoice={submitPlayerChoice}
        setPlayerChoiceDiscarding={setPlayerChoiceDiscarding}
        relicScry={relicScry}
        voluntaryActionsBlocked={voluntaryActionsBlocked}
        forcedCard={forcedCard}
        distilled={distilled}
        endTurnResolving={endTurnResolving}
        pendingTrigger={pendingTrigger}
        pending={pending}
        setPending={setPending}
        pendingPowerUid={pendingPowerUid}
        setPendingPowerUid={setPendingPowerUid}
        usingPower={usingPower}
        setPowerChamberUids={setPowerChamberUids}
        setPowerLoadUids={setPowerLoadUids}
        setPowerExhaustUids={setPowerExhaustUids}
        powerOrbSlots={powerOrbSlots}
        setPowerOrbSlots={setPowerOrbSlots}
        setPowerGemContext={setPowerGemContext}
        setPowerScryConfirmed={setPowerScryConfirmed}
        requestPowerPreview={requestPowerPreview}
        usePower={usePower}
        creativeAiEffect={creativeAiEffect}
        canUsePotionNow={canUsePotionNow}
        pendingPotion={pendingPotion}
        setPendingPotion={setPendingPotion}
        usingPotion={usingPotion}
        viewerHasSozu={viewerHasSozu}
        setPotionShivEnemyUids={setPotionShivEnemyUids}
        setPotionOverflowRequired={setPotionOverflowRequired}
        setPotionCardUids={setPotionCardUids}
        consumePotion={consumePotion}
        spendingShiv={spendingShiv}
        setSpendingShiv={setSpendingShiv}
        spendingSoulburn={spendingSoulburn}
        setSpendingSoulburn={setSpendingSoulburn}
        extraCrispyPower={extraCrispyPower}
        extraCrispySoulburn={extraCrispySoulburn}
        setExtraCrispySoulburn={setExtraCrispySoulburn}
        miracleOnCard={miracleOnCard}
        setMiracleOnCard={setMiracleOnCard}
        onAction={onAction}
        onChange={onChange}
        retainAllowance={retainAllowance}
        discardableHand={discardableHand}
        optionalRetainUids={optionalRetainUids}
        retainedSet={retainedSet}
        allowanceRetains={allowanceRetains}
        viewerRetainedCards={viewerRetainedCards}
        setRetainedCards={setRetainedCards}
        viewerNeedsEndTurnChoice={viewerNeedsEndTurnChoice}
        viewerNeedsDiscardTop={viewerNeedsDiscardTop}
        discardCandidates={discardCandidates}
        viewerDiscardTop={viewerDiscardTop}
        setDiscardTops={setDiscardTops}
        playWindow={playWindow}
        finishTurn={finishTurn}
        chamberClosing={chamberClosing}
        discardOrders={discardOrders}
        confirmedDiscards={confirmedDiscards}
        endTurnParticipants={endTurnParticipants}
        endTurnCount={endTurnCount}
        stagedStartTurnTriggerPending={stagedStartTurnTriggerPending}
        startTurnCount={startTurnCount}
        startTurnOpen={startTurnOpen}
        activeStartTurnScry={activeStartTurnScry}
        orderedStartTurnScries={orderedStartTurnScries}
        canOrderStartTurnScries={canOrderStartTurnScries}
        startTurnOrderHint={startTurnOrderHint}
        moveStartTurnScry={moveStartTurnScry}
        finishStartTurnScryOrder={finishStartTurnScryOrder}
        startTurnChoicesOpen={startTurnChoicesOpen}
        stagedStartTurnTriggers={stagedStartTurnTriggers}
        setEditingStagedStartTurnTrigger={setEditingStagedStartTurnTrigger}
        pendingStartEnemy={pendingStartEnemy}
        startEnemyChoiceAvailable={startEnemyChoiceAvailable}
        chooseStartTurnEnemy={chooseStartTurnEnemy}
        visibleStartModeShift={visibleStartModeShift}
        canCommitStartTurnOrder={canCommitStartTurnOrder}
        partyStartTurnOrderLocked={partyStartTurnOrderLocked}
        orderedStartAbilities={orderedStartAbilities}
        startTurnTargets={startTurnTargets}
        startTurnEvokeSlots={startTurnEvokeSlots}
        startTurnEnemyTargets={startTurnEnemyTargets}
        startTurnPlayerTargets={startTurnPlayerTargets}
        startTurnExhaustUids={startTurnExhaustUids}
        startTurnModeShifts={startTurnModeShifts}
        savedStartTurnEnemyTargets={savedStartTurnEnemyTargets}
        setStartTurnEnemyTargets={setStartTurnEnemyTargets}
        setStartTurnPlayerTargets={setStartTurnPlayerTargets}
        setStartTurnExhaustUids={setStartTurnExhaustUids}
        setStartTurnModeShifts={setStartTurnModeShifts}
        setStartTurnTargets={setStartTurnTargets}
        setStartTurnEvokeSlots={setStartTurnEvokeSlots}
        setStartTurnEvokeTargets={setStartTurnEvokeTargets}
        moveStartTurnAbility={moveStartTurnAbility}
        canResolveStartTurn={canResolveStartTurn}
        resolvingStartTurnMode={resolvingStartTurnMode}
        finishStartTurn={finishStartTurn}
        startTurnReady={startTurnReady}
        sendingStartTurn={sendingStartTurn}
        viewerStartTurnDecided={viewerStartTurnDecided}
        startTurnCoordinator={startTurnCoordinator}
        partyStartTurnOrderPending={partyStartTurnOrderPending}
        startTurnCoordinatorId={startTurnCoordinatorId}
        startTurnChoiceId={startTurnChoiceId}
        fumesOwnerId={fumesOwnerId}
        startTurnStuck={startTurnStuck}
        onResync={onResync}
        resyncing={resyncing}
        setResyncing={setResyncing}
      />

      {over && !(state.phase === 'won' && slayerChoice?.playerId === viewer.id) ? (
        <p className={`combat__result combat__result--${state.phase}`} role="status">
          {state.phase === 'won' ? 'Victory' : 'The party has fallen'}
        </p>
      ) : null}

      {prompt ? (
        // Slayer Pack: A card-play window has no glowing piece to point at, so its
        // instruction stays a readable banner even when there is no button.
        <div className={prompt === playWindowPrompt ? 'prompt prompt--status prompt--play-window'
          : spentShivPending && !normalEnemyPending ? 'prompt prompt--status' : 'prompt'}>
          <span className="prompt__text" role="status">{prompt}</span>
          {prompt === playWindowPrompt && playWindow?.optional ? (
            <button type="button" className="prompt__mode" data-play-window-finish
              aria-label={`Done with ${playWindowName}`}
              disabled={usingCard || endTurnResolving} onClick={finishPlayWindow}>
              Done
            </button>
          ) : null}
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
            <button type="button" className="prompt__cancel" aria-label="Skip this Shiv"
              onClick={() => chooseStartTurnShiv(null)}>
              Skip
            </button>
          ) : null}
          {pendingTrigger?.playerId === viewerId && triggerHermitChoicesReady ? pendingTrigger.players?.map((player) => (
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
          {pendingHermitPower && pendingPowerDef?.id === 'hermit_shadow_cloak' ? [...viewer.hand, ...viewer.chamber]
            .filter((card) => faceOf(cardDef(card.defId), card.upgraded).type === 'curse').map((card) => (
              <button type="button" className="prompt__mode" key={card.uid}
                onClick={() => usePower(pendingPowerUid!, { chamberUids: [card.uid] })}>
                Discard {cardDef(card.defId).name}
              </button>
            )) : null}
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
          {pendingTrigger?.playerId === viewerId && pendingTrigger.hermitChoices && triggerHermitStep !== 'cards' ? (
            <button type="button" className="prompt__mode" ref={triggerHermitReopenRef} disabled={usingTrigger}
              onClick={() => setTriggerHermitStep('cards')}>
              {triggerHermitStep === 'target' ? 'Change cards' : 'Choose cards'}
            </button>
          ) : null}
          {!pendingStartPlayer?.visual ? pendingStartPlayer?.players?.map((player) => (
            <button type="button" className="prompt__mode" key={player.id}
              onClick={() => chooseStartTurnPlayer(player.id)}>{player.label}</button>
          )) : null}
          {pending && overflowOnly && choiceSatisfied ? (
            <button type="button" className="prompt__cancel" onClick={() => commit(pending, true)}>
              Skip remaining overflow attacks
            </button>
          ) : null}
          {pending && pendingDef?.id === 'slayer_metamorphosis' && pending.metamorphosisPowerUid === undefined
            ? viewer.powers.flatMap((power) => {
              // X is fixed by the copied Power. A fixed cost (play window, free or forced play)
              // is the X the card is played for, so only Powers requiring exactly that are offered.
              const required = metamorphosisCost(viewer, power.uid, pending.card.upgraded) ?? 0
              const fixed = pending.energySpent === null ? undefined : pending.energyCharged ?? 0
              if (fixed !== undefined && required !== fixed) return []
              const energy = fixed === undefined ? required : pending.energySpent ?? 0
              const copied = faceOf(cardDef(power.defId), power.upgraded)
              return [(
                <button type="button" className="prompt__mode" key={power.uid}
                  disabled={fixed === undefined && energy > viewer.energy}
                  aria-label={`Attach to ${copied.name}${fixed === undefined ? `, spend ${energy} Energy` : ''}`}
                  onClick={() => stageOrCommit(fixed === undefined ? {
                    ...pending,
                    energySpent: energy,
                    effectEnergy: energy,
                    energyCharged: pending.cardInHand || pending.chamberPlay ? energy : 0,
                    metamorphosisPowerUid: power.uid,
                  } : { ...pending, metamorphosisPowerUid: power.uid })}>
                  {copied.name}{fixed === undefined ? ` (X=${energy})` : ''}
                </button>
              )]
            })
            : pendingDef?.cost === 'X' && pending?.energySpent === null
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
              <DieRelicChoiceList state={state} choices={dieRelicChoices(state, { needsEnemyForAll: true })}
                pressed={(choice) => pending.hermitDieRelics.some((selected) =>
                  selected.playerId === choice.owner.id && selected.relicIndex === choice.relicIndex &&
                  selected.abilityIndex === choice.abilityIndex && selected.enemyUid === choice.enemy?.uid &&
                  selected.targetPlayerId === choice.targetPlayer?.id)}
                onChoose={(picked) => {
                  const choice = {
                    playerId: picked.owner.id,
                    relicIndex: picked.relicIndex,
                    abilityIndex: picked.abilityIndex,
                    enemyUid: picked.enemy?.uid,
                    targetPlayerId: picked.targetPlayer?.id,
                  }
                  const sameRelic = pending.hermitDieRelics.findIndex((selected) =>
                    selected.playerId === choice.playerId && selected.relicIndex === choice.relicIndex)
                  const selected = sameRelic >= 0 &&
                    pending.hermitDieRelics[sameRelic]!.abilityIndex === choice.abilityIndex &&
                    pending.hermitDieRelics[sameRelic]!.enemyUid === choice.enemyUid &&
                    pending.hermitDieRelics[sameRelic]!.targetPlayerId === choice.targetPlayerId
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
                }} />
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
            pending?.choice?.kind === 'loadAny' || pending?.choice?.kind === 'bottomdeck') && !pending.choiceConfirmed &&
            !pending.choiceCards ? (
            <button type="button" className="prompt__mode"
              disabled={pending.picked.length < variableMinimum}
              onClick={() => stageOrCommit({ ...pending, choiceConfirmed: true })}>
              {pending.choice.kind === 'bottomdeck'
                ? pending.picked.length === 0 ? 'Put none back' : `Put ${pending.picked.length} on the bottom`
                : pending.picked.length === 0
                ? `${pending.choice.kind === 'discardAny' ? 'Discard' : pending.choice.kind === 'loadAny' ? 'Load' : 'Exhaust'} none`
                : `${pending.choice.kind === 'discardAny' ? 'Discard' : pending.choice.kind === 'loadAny' ? 'Load' : 'Exhaust'} ${pending.picked.length}`}
            </button>
          ) : null}
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

      <CombatPotionDialogs
        state={state}
        viewer={viewer}
        stanceChangedThisTurn={stanceChangedThisTurn}
        itemDialogRef={itemDialogRef}
        pendingPotion={pendingPotion}
        pendingPotionDef={pendingPotionDef}
        pendingPotionNeedsCards={pendingPotionNeedsCards}
        potionCardUids={potionCardUids}
        setPotionCardUids={setPotionCardUids}
        consumePotion={consumePotion}
        cancelPotionChoice={cancelPotionChoice}
        viewerHasSozu={viewerHasSozu}
      />

      {!forcedCard && !distilled && !relicScry && !voluntaryActionsBlocked &&
        (state.phase === 'player' || state.phase === 'start' || state.phase === 'discard') ? (
        <div className="relic-actions">
          <section aria-label="Relic abilities">
          {viewer.relics.flatMap((held, relicIndex) => {
            const def = relicDef(held.defId)
            const description = relicTooltipText(held.defId, state.die)
            const simpleAction = <PotionTooltipAnchor id={held.defId} key={`${held.defId}-${relicIndex}`}
              name={def.name} text={description} kindLabel="Relic" confirmLabel="use">
              <button type="button" aria-label={`Use ${def.name}${held.cubes !== undefined ? ` (${held.cubes})` : ''}: ${description}`}
                onClick={() => useRelic(relicIndex)}>
                <img className="item-icon-image" src={relicIconPath(held.defId)} alt="" />
              </button>
            </PotionTooltipAnchor>
            const heldId = held.defId.replace(/^downfall_/, '')
            const reroute = ['dollys_mirror', 'nilrys_codex', 'loaded_die'].includes(heldId)
            if (!canUseRelicNow(relicIndex)) return []
            if (held.defId === 'golden_eye') return [simpleAction]
            if (held.defId === 'gambling_chip') return [simpleAction]
            if (held.defId === 'fuel_canister') return [<details key={relicIndex}>
              <summary>{def.name}</summary><p className="room-item-text">{def.text}</p>
              <div className="campfire__deck">{viewer.hand.map((card) => <Card stanceChangedThisTurn={stanceChangedThisTurn} key={card.uid} card={card}
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
              {held.defId === 'runic_pyramid' ? <p className="room-item-text">Choose the cards to keep for your next turn.</p> : null}
              <div className="campfire__deck">{viewer.hand.map((card) => <Card stanceChangedThisTurn={stanceChangedThisTurn} key={card.uid} card={card}
                selected={relicCardUids.includes(card.uid)} onClick={() => setRelicCardUids((current) =>
                  current.includes(card.uid) ? current.filter((uid) => uid !== card.uid) :
                    held.defId === 'blue_candle' && current.length >= 2 ? current : [...current, card.uid])} />)}</div>
              <button type="button" disabled={held.defId === 'runic_pyramid' && relicCardUids.length === 0}
                onClick={() => useRelic(relicIndex, { cardUids: relicCardUids })}>
                {held.defId === 'runic_pyramid' ? `Retain ${relicCardUids.length} card${relicCardUids.length === 1 ? '' : 's'}` : 'Activate'}
              </button>
              <button type="button" onClick={(event) => {
                if (relicActionPending.current) return
                setRelicCardUids([])
                const details = event.currentTarget.closest('details')
                if (details) {
                  details.open = false
                  details.querySelector('summary')?.focus()
                }
              }}>Cancel</button>
            </details>]
            if (held.defId === 'charons_ashes') return [<details key={relicIndex}><summary>{def.name}</summary><p className="room-item-text">{def.text}</p>
              <div className="campfire__deck">{viewer.hand.map((card) => <Card stanceChangedThisTurn={stanceChangedThisTurn} key={card.uid} card={card}
                selected={relicCardUids[0] === card.uid} onClick={() => setRelicCardUids([card.uid])} />)}</div>
              {enemyButtonOrder.map((enemy) => <button type="button" key={enemy.uid}
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
                {enemyButtonOrder.map((enemy) => <button type="button" key={enemy.uid}
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
              const face = heldId === 'nilrys_codex' ? 2 : null
              return [<details key={relicIndex}><summary>{def.name}</summary><p className="room-item-text">{def.text}</p>
                <DieRelicChoiceList state={state}
                  choices={dieRelicChoices(state, { skip: (owner, targetRelicIndex, faces) =>
                    face !== null && !faces.includes(face) ||
                    ['nilrys_codex', 'loaded_die'].includes(heldId) && owner.id === viewerId &&
                    targetRelicIndex === relicIndex })}
                  onChoose={(choice) => useRelic(relicIndex, {
                    targetRelicPlayerId: choice.owner.id, targetRelicIndex: choice.relicIndex,
                    targetAbilityIndex: choice.abilityIndex, enemyUid: choice.enemy?.uid,
                    targetPlayerId: choice.targetPlayer?.id,
                  })} />
              </details>]
            }
            return [simpleAction]
          })}
          </section>
        </div>
      ) : null}

      <CombatChoiceDialogs
        state={state}
        viewer={viewer}
        viewerId={viewerId}
        stanceChangedThisTurn={stanceChangedThisTurn}
        onAction={onAction}
        onChange={onChange}
        itemDialogRef={itemDialogRef}
        startTurnScryDialogRef={startTurnScryDialogRef}
        startTurnDiscardDialogRef={startTurnDiscardDialogRef}
        choiceDialogRef={choiceDialogRef}
        gemFinderScryOpen={gemFinderScryOpen}
        powerChoiceCards={powerChoiceCards}
        pendingPower={pendingPower}
        powerScryDiscardUids={powerScryDiscardUids}
        setPowerScryDiscardUids={setPowerScryDiscardUids}
        confirmPowerScry={confirmPowerScry}
        relicScry={relicScry}
        relicCardUids={relicCardUids}
        setRelicCardUids={setRelicCardUids}
        useRelic={useRelic}
        visibleDistilled={visibleDistilled}
        activeStartTurnScry={activeStartTurnScry}
        startTurnScryPicked={startTurnScryPicked}
        chooseStartTurnScryCard={chooseStartTurnScryCard}
        resolvingStartTurnScry={resolvingStartTurnScry}
        finishStartTurnScry={finishStartTurnScry}
        activeStartTurnDiscard={activeStartTurnDiscard}
        finishStartTurnDiscard={finishStartTurnDiscard}
        pendingTrigger={pendingTrigger}
        pendingPlunder={pendingPlunder}
        triggerHermitStep={triggerHermitStep}
        setTriggerHermitStep={setTriggerHermitStep}
        triggerHermitLoadUids={triggerHermitLoadUids}
        setTriggerHermitLoadUids={setTriggerHermitLoadUids}
        triggerHermitChamberUids={triggerHermitChamberUids}
        setTriggerHermitChamberUids={setTriggerHermitChamberUids}
        triggerHermitNeedsBoard={triggerHermitNeedsBoard}
        usingTrigger={usingTrigger}
        confirmTriggerHermitChoices={confirmTriggerHermitChoices}
        pending={pending}
        setPending={setPending}
        pendingDef={pendingDef}
        choiceNeeded={choiceNeeded}
        pendingSearchKind={pendingSearchKind}
        selectedSearchType={selectedSearchType}
        scryPlay={scryPlay}
        scryPlayRequired={scryPlayRequired}
        scryPlayEligible={scryPlayEligible}
        onChoiceCardClick={onChoiceCardClick}
        handChoiceSatisfied={handChoiceSatisfied}
        confirmChoice={confirmChoice}
      />

      {startTurnEffectSource ? (
        <section className="end-turn-effects start-turn-effects" aria-live="polite"
          aria-label={`Start-turn effect: ${startTurnEffectSource.label}`}>
          <p className="end-turn-effects__prompt">
            <span className="visually-hidden">{startTurnEffectSource.label}: </span>
            {startTurnEffectSource === pendingStartPlayer ? 'Drag to a player'
              : startTurnEffectDraggable ? 'Drag to an enemy' : 'Choose an Orb'}
          </p>
          <div className="start-turn-effects__source" inert={!startTurnEffectDraggable}>
          {startTurnEffectCard ? (
            <Card stanceChangedThisTurn={stanceChangedThisTurn}
              className="end-turn-effect end-turn-effect--card"
              card={startTurnEffectCard}
              playable={canResolveStartTurn}
              selected={armedEndTurnAbilityId === startTurnEffectSource.id}
              onClick={() => activateEndTurnEffect(startTurnEffectSource)}
              onPointerDown={(event) => onEndTurnEffectPointerDown(startTurnEffectSource, event)}
              onPointerMove={onEndTurnEffectPointerMove}
              onPointerUp={finishEndTurnEffectDrag}
              onPointerCancel={cancelEndTurnEffectDrag}
              onLostPointerCapture={cancelEndTurnEffectDrag}
            />
          ) : startTurnEffectRelicId ? (
            <button
              type="button"
              className="end-turn-effect end-turn-effect--relic"
              disabled={!canResolveStartTurn}
              aria-label={`Resolve ${startTurnEffectSource.label}`}
              aria-pressed={armedEndTurnAbilityId === startTurnEffectSource.id}
              onClick={() => activateEndTurnEffect(startTurnEffectSource)}
              onPointerDown={(event) => onEndTurnEffectPointerDown(startTurnEffectSource, event)}
              onPointerMove={onEndTurnEffectPointerMove}
              onPointerUp={finishEndTurnEffectDrag}
              onPointerCancel={cancelEndTurnEffectDrag}
              onLostPointerCapture={cancelEndTurnEffectDrag}
            >
              <img className="item-icon-image" src={relicIconPath(startTurnEffectRelicId)} alt="" />
            </button>
          ) : null}
          </div>
        </section>
      ) : null}

      {evokeTargetSource && evokeTargetOrb ? (
        <section className="end-turn-effects evoke-target-effect" aria-live="polite" aria-label={evokeTargetSource.label}>
          <p className="end-turn-effects__prompt">
            <span className="visually-hidden">
              {evokeTargetSource.label} {(pendingStartEvokeTarget?.index ?? pendingEvokeTarget) + 1}:{' '}
            </span>
            Drag to an enemy
          </p>
          <button
            type="button"
            className="end-turn-effect end-turn-effect--orb"
            aria-label={`Aim ${evokeTargetSource.label}`}
            aria-pressed={armedEndTurnAbilityId === evokeTargetSource.id}
            onClick={() => activateEndTurnEffect(evokeTargetSource)}
            onPointerDown={(event) => onEndTurnEffectPointerDown(evokeTargetSource, event)}
            onPointerMove={onEndTurnEffectPointerMove}
            onPointerUp={finishEndTurnEffectDrag}
            onPointerCancel={cancelEndTurnEffectDrag}
            onLostPointerCapture={cancelEndTurnEffectDrag}
          >
            <span className={`token--orb token--orb-${evokeTargetOrb}`} aria-hidden="true" />
          </button>
        </section>
      ) : null}

      {visibleStartModeShift ? (
        <section className="guardian-mode-choice" role="group" aria-label="Choose Guardian form for this turn">
          {(['attack', 'defense'] as const).map((mode) => (
            <button type="button" className="end-turn-effect guardian-mode-choice__option" key={mode}
              disabled={resolvingStartTurnMode}
              aria-label={`Choose ${mode === 'attack' ? 'Attack' : 'Defense'} Mode`}
              onClick={() => chooseStartTurnMode(mode)}>
              <img src={assetPath(`combat/characters/guardian${mode === 'defense' ? '-defense' : ''}.webp`)} alt="" />
            </button>
          ))}
        </section>
      ) : null}

      {endTurnEffect ? (
        <section className="end-turn-effects" aria-live="polite" aria-label={`End-turn effect: ${endTurnEffect.label}`}>
          <p className="end-turn-effects__prompt">
            {/* The live text must change per effect, or consecutive effects are never announced. */}
            <span className="visually-hidden">{endTurnEffect.label}: </span>
            {canResolveEndTurn
              ? endTurnEffectPrompt
              : `Waiting for ${state.players.find((player) => player.id === endTurnEffect.playerId)?.name ?? 'its owner'}`}
          </p>
          {endTurnEffectCard ? (
            <Card stanceChangedThisTurn={stanceChangedThisTurn}
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
          {endTurnOrbChoices.length > 0 ? (
            <div className="end-turn-effects__orb-choices" role="group" aria-label={`Choose an Orb for ${endTurnEffect.label}`}>
              {endTurnOrbChoices.map(({ orb, target }) => (
                <button className="end-turn-effects__orb-choice" key={orb} type="button"
                  aria-label={`Duplicate ${orb} Orb effect`}
                  onClick={() => resolveTurnEffectTarget(endTurnEffect.id, target.uid)}>
                  <span className={`token--orb token--orb-${orb}`} aria-hidden="true" />
                </button>
              ))}
            </div>
          ) : null}
          {endTurnSelfExhaustOffered ? (
            <div className="end-turn-effects__choices" role="group" aria-label={`Optional cost for ${endTurnEffect.label}`}>
              <button type="button" aria-pressed={endTurnSelfExhaust}
                onClick={() => setEndTurnSelfExhaust((current) => !current)}>
                {endTurnSelfExhaust ? 'Also Exhaust: on' : 'Also Exhaust for Block'}
              </button>
            </div>
          ) : null}
          {endTurnChoiceTargets.length > 0 ? (
            <div className="end-turn-effects__choices" role="group" aria-label={`Resolve ${endTurnEffect.label}`}>
              {endTurnChoiceTargets.map((target) => (
                <button key={target.uid} type="button" onClick={() => resolveTurnEffectTarget(endTurnEffect.id, target.uid)}>
                  {target.label}
                </button>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      <CombatStage
        state={state}
        viewer={viewer}
        viewerId={viewerId}
        rows={rows}
        bosses={bosses}
        stageEnemies={stageEnemies}
        facingEnemies={facingEnemies}
        liveFacingEnemies={liveFacingEnemies}
        boardRef={boardRef}
        viewerRowRef={viewerRowRef}
        setPointedEnemyUid={setPointedEnemyUid}
        prefersReducedMotion={prefersReducedMotion}
        characterAttacksActive={characterAttacksActive}
        falling={falling}
        targetPresentationTimings={targetPresentationTimings}
        visualResetKey={visualResetKey}
        hits={hits}
        enemyVfxFor={enemyVfxFor}
        actorVfxFor={actorVfxFor}
        playerVfxFor={playerVfxFor}
        orbEndTurnRevealDelayMs={orbEndTurnRevealDelayMs}
        livePresentationEvents={livePresentationEvents}
        finishSlimeCommand={livePresentation.finishSlimeCommand}
        expiredCultistPhase={expiredCultistPhase}
        activeEnemyPhaseKey={activeEnemyPhaseKey}
        onCultistThrowPrepared={onCultistThrowPrepared}
        onCultistThrowStart={onCultistThrowStart}
        onCultistThrowSkipped={onCultistThrowSkipped}
        characterAttackAssets={characterAttackAssets}
        characterAttackBlobs={characterAttackBlobs}
        stagedPosesReady={stagedPosesReady}
        monogatariPosesReady={monogatariPosesReady}
        monogatariEvokeReady={monogatariEvokeReady}
        monogatariEvokesReadyByEvent={monogatariEvokesReadyByEvent}
        characterAttacks={characterAttacks}
        slimeCommandMotions={slimeCommandMotions}
        setSlimeLayoutVersion={setSlimeLayoutVersion}
        showSlimeCard={showSlimeCard}
        hideSlimeCard={hideSlimeCard}
        pendingStartEnemy={pendingStartEnemy}
        pendingStartPlayer={pendingStartPlayer}
        pendingStartEvoke={pendingStartEvoke}
        startEnemyChoiceAvailable={startEnemyChoiceAvailable}
        pendingShivProgress={pendingShivProgress}
        isEndTurnEnemyTarget={isEndTurnEnemyTarget}
        cardDrag={cardDrag}
        cardDragTargetRow={cardDragTargetRow}
        endTurnEffectDrag={endTurnEffectDrag}
        armedEndTurnAbilityId={armedEndTurnAbilityId}
        isStartTurnEnemyTarget={isStartTurnEnemyTarget}
        pendingTrigger={pendingTrigger}
        triggerHermitChoicesReady={triggerHermitChoicesReady}
        triggerSlimeEnemyUids={triggerSlimeEnemyUids}
        triggerSlimeEnemyAmount={triggerSlimeEnemyAmount}
        isEnemyRowClickTargetable={isEnemyRowClickTargetable}
        isRowLaneClickTargetable={isRowLaneClickTargetable}
        rowLaneClickLabel={rowLaneClickLabel}
        onRowLaneClick={onRowLaneClick}
        pendingPotion={pendingPotion}
        pendingPotionNeedsEnemy={pendingPotionNeedsEnemy}
        pendingPotionOverflow={pendingPotionOverflow}
        pendingPowerNeedsEnemy={pendingPowerNeedsEnemy}
        pendingPowerNeedsAlly={pendingPowerNeedsAlly}
        pendingPowerDef={pendingPowerDef}
        pendingHermitPower={pendingHermitPower}
        powerLoadUids={powerLoadUids}
        spendingShiv={spendingShiv}
        spendingSoulburn={spendingSoulburn}
        pending={pending}
        slimeEnemyChoicesRequired={slimeEnemyChoicesRequired}
        loadedTargetCount={loadedTargetCount}
        pendingEvokeTarget={pendingEvokeTarget}
        pendingEvokeUsesRows={pendingEvokeUsesRows}
        pendingEvokeTargetUids={pendingEvokeTargetUids}
        enemyChoicesDone={enemyChoicesDone}
        independentEnemyPending={independentEnemyPending}
        independentPlayerPending={independentPlayerPending}
        slayerTargetAllowed={slayerTargetAllowed}
        choiceSatisfied={choiceSatisfied}
        switchChoiceReady={switchChoiceReady}
        onEnemyClick={onEnemyClick}
        onAllyClick={onAllyClick}
        onEndTurnOrbPointerDown={onEndTurnOrbPointerDown}
        onEndTurnEffectPointerMove={onEndTurnEffectPointerMove}
        finishEndTurnEffectDrag={finishEndTurnEffectDrag}
        cancelEndTurnEffectDrag={cancelEndTurnEffectDrag}
        evokePlannedOrbs={evokePlannedOrbs}
        evokeChoiceOptions={evokeChoiceOptions}
        evokeChoicePlayerId={evokeChoicePlayerId}
        creativeAiEffect={creativeAiEffect}
        powerOrbSlots={powerOrbSlots}
        endTurnEffect={endTurnEffect}
        canResolveEndTurn={canResolveEndTurn}
        chooseStartTurnEvoke={chooseStartTurnEvoke}
        onEvokeClick={onEvokeClick}
        chooseCreativeAiOrb={chooseCreativeAiOrb}
        endTurnTargetForOrb={endTurnTargetForOrb}
        suppressEndTurnOrbClick={suppressEndTurnOrbClick}
        resolveTurnEffectTarget={resolveTurnEffectTarget}
      />

      {viewer && dieRelicPending?.playerId === viewer.id ? (() => {
        const effect = dieRelicAbility?.effects.find((candidate) =>
          candidate.kind === 'discard' || candidate.kind === 'exhaustFromHand')
        const required = effect ? Math.min(effect.amount, viewer.hand.length) : 0
        const discard = effect?.kind === 'discard'
        const optional = dieRelicAbility?.optional === true
        const accepting = !optional || dieRelicCardUids.length > 0
        const needsRetarget = accepting && dieRelicNeedsEnemy &&
          !livingEnemies(state).some((enemy) => enemy.uid === dieRelicPending.enemyUid)
        if (!effect && !needsRetarget) return null
        return <section className="hermit-prompt hermit-prompt--cards" aria-label="Die Relic card choice">
          <strong>{relicDef(dieRelicPending.relicDefId).name}{effect ? <>: {optional ? 'you may ' : ''}
            {discard ? 'discard' : 'Exhaust'} {required}</> : null}</strong>
          {effect ? viewer.hand.map((card) => {
            const selected = dieRelicCardUids.includes(card.uid)
            return <Card stanceChangedThisTurn={stanceChangedThisTurn} key={card.uid} card={card} selected={selected} onClick={() => setDieRelicCardUids((current) =>
              selected ? current.filter((uid) => uid !== card.uid) : current.length < required
                ? [...current, card.uid] : current)} />
          }) : null}
          {needsRetarget ? <div>
            <strong>Choose a new enemy target</strong>
            {enemyButtonOrder.map((enemy) => <button key={enemy.uid} type="button"
              className={dieRelicEnemyUid === enemy.uid ? 'selected' : undefined}
              onClick={() => setDieRelicEnemyUid(enemy.uid)}>{enemyLabel(state.enemies, enemy)}</button>)}
          </div> : null}
          <button type="button" disabled={usingDieRelic || Boolean(effect) && (!optional && dieRelicCardUids.length !== required ||
            optional && dieRelicCardUids.length !== 0 && dieRelicCardUids.length !== required) ||
            accepting && dieRelicNeedsEnemy && !dieRelicTargetUid}
            onClick={() => submitDieRelicChoice(discard)}>
            {optional && dieRelicCardUids.length === 0 ? 'Skip' : `Resolve ${relicDef(dieRelicPending.relicDefId).name}`}
          </button>
        </section>
      })() : null}

      {hermitSetupPending ? <p className="visually-hidden" role="status"
        aria-label="Hermit start-of-combat Load">Choose a card in hand to Load</p> : null}
      {hermitSetupOwner && !hermitSetupPending ? <p className="visually-hidden" role="status">
        Waiting for {hermitSetupOwner.name} to Load a card</p> : null}
      {hermitSetupPending && viewer.hand.some((card) => hermitTargetedCurses.has(card.defId)) &&
      livingEnemies(state).length > 1 ? (
        <section className="prompt" aria-label="Hermit start-of-combat Load target">
          <span>Load a card from your hand, or Load a Curse at:</span>
          {viewer.hand.filter((card) => hermitTargetedCurses.has(card.defId)).map((card) =>
            enemyButtonOrder.map((enemy) => (
              <button key={`${card.uid}-${enemy.uid}`} type="button" className="prompt__mode"
                onClick={() => submitHermitSetup(card, enemy.uid)}>
                {cardDef(card.defId).name} → {enemyLabel(state.enemies, enemy)}
              </button>
            )))}
        </section>
      ) : null}
      <PlayerChoiceDiscardDialog
        dialogRef={playerChoiceDialogRef}
        viewer={viewer}
        viewerPlayerChoice={viewerPlayerChoice}
        playerChoiceDiscarding={playerChoiceDiscarding}
        setPlayerChoiceDiscarding={setPlayerChoiceDiscarding}
        stanceChangedThisTurn={stanceChangedThisTurn}
        usingPlayerChoice={usingPlayerChoice}
        submitPlayerChoice={submitPlayerChoice}
      />
      {viewer && hermitStrengthPending ? (
        <section className="prompt" aria-label="Dead or Alive reward">
          <strong>Dead or Alive: choose a player to gain 1 Strength</strong>
          {state.players.filter((player) => !player.dead).map((player) => (
            <button key={player.id} type="button" className="prompt__mode"
              onClick={() => submitHermitStrength(player.id)}>{player.name}</button>
          ))}
        </section>
      ) : null}
      {viewer && slayerChoice && slayerChoice.playerId === viewer.id && state.phase !== 'lost' ? (
        slayerChoice.kind === 'reattach' ? (() => {
          const hosts = enemyButtonOrder.filter((enemy) => enemy.uid !== slayerChoice.fromUid)
          const name = faceOf(cardDef(slayerChoice.card.defId), slayerChoice.card.upgraded).name
          return <section className="prompt" aria-label={`${name} target`} data-slayer-choice="reattach">
            <strong>{name}: its enemy died — attach it to another enemy</strong>
            {hosts.map((enemy) => (
              <button key={enemy.uid} type="button" className="prompt__mode" disabled={usingSlayerChoice}
                onClick={() => submitSlayerChoice({ enemyUid: enemy.uid })}>{enemyLabel(state.enemies, enemy)}</button>
            ))}
            {hosts.length === 0 ? <button type="button" className="prompt__mode" disabled={usingSlayerChoice}
              onClick={() => submitSlayerChoice({ enemyUid: null })}>Discard {name}</button> : null}
          </section>
        })() : slayerChoice.revealed ? (
          // A panel over the board: the revealed card at reading size beside its two answers.
          <section className="distilled-choice slayer-reveal" role="dialog" aria-labelledby="slayer-reveal-title"
            data-slayer-choice="ritualDagger">
            <Card stanceChangedThisTurn={stanceChangedThisTurn} card={{ uid: `slayer-reveal-${slayerChoice.cardUid}`, defId: slayerChoice.revealed, upgraded: false }}
              immediateArt accessibleNote="revealed only to you" />
            <div className="slayer-reveal__text">
              <h2 id="slayer-reveal-title">Ritual Dagger+</h2>
              <p>{state.phase === 'won' ? 'Your killing blow won the fight. ' : ''}You reveal {
                cardDef(slayerChoice.revealed).name} from your rare rewards. Only you can see it.</p>
              <div className="item-actions">
                <button type="button" disabled={usingSlayerChoice} onClick={() => submitSlayerChoice({ replace: false })}>
                  Put it on the bottom of your rare deck</button>
                <button type="button" disabled={usingSlayerChoice} onClick={() => submitSlayerChoice({ replace: true })}>
                  Replace Ritual Dagger with it</button>
              </div>
            </div>
          </section>
        ) : null
      ) : null}
      {slayerChoiceOwner && !slayerChoiceOwner.dead && slayerChoiceOwner.id !== viewer.id && state.phase !== 'lost' ? (
        // Nothing on the board glows for someone else's decision, so the wait stays a readable banner.
        <p className="prompt prompt--status" role="status" data-slayer-waiting="">
          Waiting for {slayerChoiceOwner.name} to resolve {
            slayerChoice?.kind === 'ritualDagger' ? 'Ritual Dagger+' : 'Nightmare+'}{
            state.phase === 'won' ? ' before the party moves on' : ''}
        </p>
      ) : null}
      <HandArea
        state={state}
        viewer={viewer}
        viewerVisual={viewerVisual}
        skinOrb={skinOrb}
        downfallCharacter={downfallCharacter}
        stanceChangedThisTurn={stanceChangedThisTurn}
        drawCount={drawCount}
        drawPileCount={drawPileCount}
        displayedPileCount={displayedPileCount}
        motionActive={motionActive}
        motionBeats={motionBeats}
        chamberTriggerRef={chamberTriggerRef}
        handScrollRef={handScrollRef}
        handRef={handRef}
        chamberOpen={chamberOpen}
        chamberClosing={chamberClosing}
        chamberContact={chamberContact}
        toggleChamber={toggleChamber}
        requiredHermitChamberCard={requiredHermitChamberCard}
        requiredChamberCard={requiredChamberCard}
        requiredChamberUnplayable={requiredChamberUnplayable}
        skipUnplayableHermitChamber={skipUnplayableHermitChamber}
        visibleHand={visibleHand}
        visibleChamberUids={visibleChamberUids}
        hermitSetupPending={hermitSetupPending}
        hermitTargetedCurses={hermitTargetedCurses}
        pending={pending}
        setPending={setPending}
        usingCard={usingCard}
        pendingTrigger={pendingTrigger}
        endTurnResolving={endTurnResolving}
        voluntaryActionsBlocked={voluntaryActionsBlocked}
        forcedCard={forcedCard}
        forcedCardUid={forcedCardUid}
        distilled={distilled}
        relicScry={relicScry}
        miracleOnCard={miracleOnCard}
        drawnCards={drawnCards}
        cardDrag={cardDrag}
        cardDamage={cardDamage}
        handExhaustChoiceUids={handExhaustChoiceUids}
        chosenStartExhaustUids={chosenStartExhaustUids}
        pendingStartExhaust={pendingStartExhaust}
        suppressCardClick={suppressCardClick}
        chamberCardCanStartDrag={chamberCardCanStartDrag}
        submitHermitChamber={submitHermitChamber}
        chooseStartTurnExhaust={chooseStartTurnExhaust}
        submitHermitSetup={submitHermitSetup}
        activateCard={activateCard}
        onCardPointerDown={onCardPointerDown}
        onCardPointerMove={onCardPointerMove}
        finishCardDrag={finishCardDrag}
        cancelCardDrag={cancelCardDrag}
      />
      <FloatingOverlays
        viewerCharacter={viewer.character}
        stanceChangedThisTurn={stanceChangedThisTurn}
        slimeCardZoom={slimeCardZoom}
        chamberReturnFlights={chamberReturnFlights}
        cardDrag={cardDrag}
        cardDragOverlay={cardDragOverlay}
        cardDragArrow={cardDragArrow}
        cardDragArrowShadow={cardDragArrowShadow}
        endTurnEffectDrag={endTurnEffectDrag}
        endTurnEffectDragOverlay={endTurnEffectDragOverlay}
        endTurnEffectDragArrow={endTurnEffectDragArrow}
        endTurnEffectDragArrowShadow={endTurnEffectDragArrowShadow}
        endTurnEffectDragCard={endTurnEffectDragCard}
        endTurnEffectDragRelicId={endTurnEffectDragRelicId}
        endTurnEffectDragSlimeAsset={endTurnEffectDragSlimeAsset}
        cardFlights={cardFlights}
      />
    </div>
  )
}

export const CombatScreen = memo(CombatScreenView)
