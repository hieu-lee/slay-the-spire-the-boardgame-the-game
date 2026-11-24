// The combat screen: orchestrates combat state, actions, and presentation while
// delegating chamber animations, item/card/start-turn actions, presentation,
// motion tracking, layout, drag interactions, prompts, and UI panels to
// cohesive modules under combat-screen/.
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { assetPath } from '../game/assets.ts'
import { cardDef, faceOf } from '../game/cards.ts'
import {
  activeCardPlayWindow,
  activePowerWindow,
  beginEndTurnResolution,
  cardHasRetain,
  cardNeedsChoicePreview,
  chooseEndTurnTarget,
  chosenEvokeOrbs,
  combatRowLabel,
  discardNeedsChoice,
  discardTopNeedsChoice,
  endPlayerTurn,
  endTurnResolutionAbility,
  evokePlan,
  guardianCardNeedsAlly,
  lightningRowTarget,
  livingEnemies,
  mandatoryChoicePending,
  parseSelfExhaustEndTurnTarget,
  powerAbilityUsed,
  powerActivationAllowed,
  previewCardDamage,
  reachedTimeWarpLimit,
  resolveEndTurnAbility,
  selfExhaustEndTurnTarget,
  spendShiv,
  spendSoulburn,
} from '../game/combat.ts'
import type {
  CardDamagePreview,
  DiscardOrders,
  EndTurnAbility,
} from '../game/combat.ts'
import { enemyAbilities, enemyDef } from '../game/enemies.ts'
import { potionDef } from '../game/relics.ts'
import { playerVisualId, skinTraits } from '../game/skins.ts'
import { CAPS, DOWNFALL_CHARACTER_IDS } from '../game/types.ts'
import type { CardInstance, Enemy, Player } from '../game/types.ts'
import type { ActionOutcome } from '../multiplayer/useRoomSession.ts'
import {
  STAGE_GAP_REM,
  STAGE_MARGIN_REM,
  livingEnemiesInStageOrder,
} from './board-signals.ts'
import { courierReady } from './CourierPanel.tsx'
import {
  registerCardZoomCloser,
  releaseCardZoom,
  tryClaimCardZoom,
} from './PowerRow.tsx'
import { CombatBar } from './combat-screen/CombatBar.tsx'
import { CombatChoiceDialogs, CombatPotionDialogs } from './combat-screen/CombatDialogs.tsx'
import { CombatPromptBar } from './combat-screen/CombatPromptBar.tsx'
import { CombatStage, GroundedCombatVfx } from './combat-screen/CombatStage.tsx'
import { FloatingOverlays } from './combat-screen/FloatingOverlays.tsx'
import { HandArea } from './combat-screen/HandArea.tsx'
import { RelicActions } from './combat-screen/RelicActions.tsx'
import { warmSmokeTrails } from './combat-screen/SmokeTrail.tsx'
import { CombatInterruptPanels, TurnEffectOverlays } from './combat-screen/TurnEffectOverlays.tsx'
import { canAfford, rowsOf } from './combat-screen/helpers.ts'
import { useCardHints, useReducedEffects } from './combat-screen/hooks.ts'
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
import type {
  CombatScreenProps,
  Pending,
  ReconciliationResult,
  SlimeCardZoom,
} from './combat-screen/types.ts'
import { useCardPlay } from './combat-screen/useCardPlay.ts'
import { useCombatDrag } from './combat-screen/useCombatDrag.ts'
import { useCombatMotions } from './combat-screen/useCombatMotions.ts'
import { useCombatPresentation } from './combat-screen/useCombatPresentation.ts'
import { useHermitChamber } from './combat-screen/useHermitChamber.ts'
import { HERMIT_TARGETED_CURSES, useItemActions } from './combat-screen/useItemActions.ts'
import { useStartTurnActions } from './combat-screen/useStartTurnActions.ts'

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
  const [usingCard, setUsingCard] = useState(false)
  const [discardTops, setDiscardTops] = useState<Record<string, string>>({})
  const [retainedCards, setRetainedCards] = useState<Record<string, string[]>>({})
  const [discardOrders, setDiscardOrders] = useState<DiscardOrders>({})
  /** Slayer Pack: Companion's owner also Exhausts it with the next chosen enemy. */
  const [endTurnSelfExhaust, setEndTurnSelfExhaust] = useState(false)
  const [slimeCardZoom, setSlimeCardZoom] = useState<SlimeCardZoom | null>(null)
  const closeSlimeCardZoom = useRef(() => setSlimeCardZoom(null))
  const [pointedEnemyUid, setPointedEnemyUid] = useState<string | null>(null)
  const armedCardFlight = useRef<{ card: CardInstance; chamber: boolean } | null>(null)
  const endTurnRef = useRef<HTMLButtonElement | null>(null)
  const phaseBefore = useRef(state.phase)
  const stateRef = useRef(state)
  const versionRef = useRef(authoritativeVersion ?? -1)
  const refreshRef = useRef(authoritativeRefresh)
  stateRef.current = state
  versionRef.current = authoritativeVersion ?? -1
  refreshRef.current = authoritativeRefresh

  const reducedMotion = useReducedEffects()
  const prefersReducedMotion = reducedMotion
  useEffect(() => registerCardZoomCloser(closeSlimeCardZoom.current), [])

  const viewer = state.players.find((player) => player.id === viewerId)
  const stanceChangedThisTurn = onAction ? viewerStanceChangedThisTurn : state.stanceChangedThisTurn.includes(viewerId)
  const viewerVisual = viewer ? playerVisualId(viewer) : undefined
  const skinOrb = viewerVisual !== undefined && skinTraits(viewerVisual)?.energyOrb === true
  const cardHints = useCardHints()
  const courierAvailable = Boolean(onCourierReveal) && courierReady(viewer, courierUsedBy ?? [])

  useEffect(() => {
    if (reducedMotion || !viewer) return
    let cancel = warmSmokeTrails(viewer.character)
    const resize = () => { cancel(); cancel = warmSmokeTrails(viewer.character) }
    window.addEventListener('resize', resize)
    return () => { cancel(); window.removeEventListener('resize', resize) }
  }, [viewer?.character, reducedMotion])

  const forcedCard = state.startTurnProgress?.forcedCard
  const forcedCardUid = forcedCard?.playerId === viewerId && typeof forcedCard.cardUid === 'string'
    ? forcedCard.cardUid
    : null
  const distilled = state.pendingDistilled
  const relicScry = state.pendingRelicScry
  const playWindow = viewerId ? activeCardPlayWindow(state, viewerId) : undefined
  const voluntaryActionsBlocked = mandatoryChoicePending(state)
  const endTurnEffect = onAction ? partyEndTurnAbilities?.[0] : endTurnResolutionAbility(state)
  const endTurnResolving = endTurnEffect !== undefined

  function reconciliation(outcome: ActionOutcome | void): ReconciliationResult {
    const snapshot = outcome?.snapshot
    if (!snapshot?.run?.combat) return null
    const combat = snapshot.version <= versionRef.current ? stateRef.current : snapshot.run.combat
    const player = combat.players.find((candidate) => candidate.id === viewerId)
    return (activePowerWindow(combat) || combat.phase === 'copy') && player ? { combat, player } : null
  }

  const chamber = useHermitChamber({
    state,
    viewer,
    viewerId,
    reducedMotion,
  })

  const items = useItemActions({
    state,
    viewer,
    viewerId,
    onAction,
    onChange,
    stateRef,
    refreshRef,
    reconciliation,
    authoritativePendingTrigger,
    stagedStartTurnTriggers,
    serverStartTurnChoices,
    powerPreview,
    partyStartTurnPostRollLocked,
    authoritativeRefresh,
    endTurnResolving,
    forcedCard,
    distilled,
    relicScry,
    setPending,
    setMiracleOnCard,
    setSpendingShiv,
  })

  const presentation = useCombatPresentation({
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
  })

  useEffect(() => {
    const uid = slimeCardZoom?.card.uid
    if (!uid) return
    const commanding = presentation.livePresentationEvents.some((event) => event.kind === 'slime' && event.slimeUid === uid)
    const stillPresent = state.players.some((player) => player.slimes.some((slime) => slime.card.uid === uid))
    if (commanding || !stillPresent) {
      releaseCardZoom(closeSlimeCardZoom.current)
      setSlimeCardZoom(null)
    }
  }, [presentation.livePresentationEvents, slimeCardZoom?.card.uid, state.players])

  const cardPlay = useCardPlay({
    state,
    viewer,
    viewerId,
    drawCount,
    onAction,
    onChange,
    mutationsEnabled,
    cardPreview,
    authoritativeRefresh,
    stateRef,
    refreshRef,
    reconciliation,
    armedCardFlight,
    pending,
    setPending,
    miracleOnCard,
    setMiracleOnCard,
    usingCard,
    setUsingCard,
    setSpendingShiv,
    setSpendingSoulburn,
    clearItemTargets: items.clearItemTargets,
    pendingTrigger: items.pendingTrigger,
    endTurnResolving,
    forcedCardUid,
    playWindow,
    owesChoice: items.owesChoice,
  })

  const motions = useCombatMotions({
    state,
    viewer,
    viewerId,
    drawCount,
    animateOpeningHand,
    authoritativeConnected,
    authoritativeRestoration,
    reducedMotion,
    prefersReducedMotion,
    boardRef: presentation.boardRef,
    activeVfx: presentation.activeVfx,
    livePresentationEvents: presentation.livePresentationEvents,
    stageScale: presentation.stageScale,
    stagedPosesReadyByAttack: presentation.stagedPosesReadyByAttack,
    stagedPosesReady: presentation.stagedPosesReady,
    monogatariPosesReadyByAttack: presentation.monogatariPosesReadyByAttack,
    monogatariPosesReady: presentation.monogatariPosesReady,
    armedCardFlight,
    miracleOnCard,
    endTurnResolving,
    pending,
    pendingTrigger: items.pendingTrigger,
    usingCard,
  })

  const startTurn = useStartTurnActions({
    state,
    viewer,
    viewerId,
    onAction,
    onChange,
    onResync,
    autoAdvance,
    autoAdvanceRetry: presentation.autoAdvanceRetry,
    authoritativeVersion,
    authoritativeRefresh,
    refreshRef,
    partyStartTurnAbilities,
    partyStartTurnScryAbilities,
    startTurnCoordinatorId: startTurnCoordinatorId ?? undefined,
    startTurnChoiceId,
    startTurnDecidedPlayerIds,
    requiredStartTurnPlayerIds,
    savedStartTurnEnemyTargets,
    serverStartTurnChoices,
    partyStartTurnOrderPending,
    partyStartTurnOrderLocked,
    partyStartTurnScry,
    partyStartTurnDiscard,
    pendingTrigger: items.pendingTrigger,
    stagedStartTurnTriggerPending: items.stagedStartTurnTriggerPending,
    forcedCard,
    dieRelicPending: items.dieRelicPending,
    owedChoicesCount: items.owedChoices.length,
  })

  const rows = useMemo(() => rowsOf(state), [state])
  const facingEnemies = state.enemies.filter((enemy) =>
    enemyAbilities(enemyDef(enemy.defId, enemy.ascension)).some((ability) => ability.kind === 'facing'))
  const liveFacingEnemies = facingEnemies.filter((enemy) => !enemy.dead)
  const savedDiscardKey = savedDiscardOrder?.join('\0')

  useEffect(() => {
    setEndTurnSelfExhaust(false)
  }, [endTurnEffect?.id])

  useEffect(() => {
    if (state.phase !== 'discard') {
      setDiscardTops({})
      setRetainedCards({})
      setDiscardOrders({})
    }
  }, [state.phase])

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

  // Focus is dropped to <body> when the enemy's turn replaces the board, so a
  // keyboard player restarted their Tab walk from the page header every round.
  // Put them back on End turn — only when focus is genuinely nowhere, so this
  // can never steal it from something they deliberately moved to.
  //
  // Gated on where the phase came FROM, not just on arriving at `player`.
  // `start -> player` also lands here: clicking "Resolve start of turn" unmounts
  // that button, focus falls to <body>, and an ungated restore parked it on End
  // turn — the most destructive key on the screen — where the next Space or
  // Enter would end the turn the player had only just started.
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

  const endTurnParticipants = requiredEndTurnPlayerIds ??
    items.livingPlayers.filter(discardNeedsChoice).map((player) => player.id)
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

  function finishTurn() {
    if (chamber.chamberClosing) return
    if (chamber.chamberOpen) {
      chamber.closeChamber(finishTurnNow)
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

  // A Lightning/Dark Evoke that still needs an enemy floats its Orb like an
  // end-turn Orb, so the aim can be dragged and the glowing enemies have a cause.
  const evokeTargetOrb = startTurn.pendingStartEvokeTarget
    ? startTurn.pendingStartEvokeTarget.ability.evokeOrbs?.[startTurn.pendingStartEvokeTarget.index]
    : pending && cardPlay.pendingDef && cardPlay.pendingEvokeTarget >= 0 && cardPlay.choiceSatisfied
      ? chosenEvokeOrbs(cardPlay.pendingDef, viewer, pending.evokeSlots, state.die, pending.mode ?? undefined,
        pending.effectEnergy ?? 0)[cardPlay.pendingEvokeTarget]
      : undefined
  const evokeChoiceOptions = startTurn.pendingStartEvoke?.evokeChoice?.options ??
    (cardPlay.pendingEvokeChoice && cardPlay.pendingEvokeTarget < 0 && cardPlay.choiceSatisfied
      ? cardPlay.pendingEvokeChoice.options : undefined)
  // Local parties resolve every seat's start-of-turn choices from one screen.
  const evokeChoicePlayerId = startTurn.pendingStartEvoke?.playerId ??
    startTurn.pendingStartEvokeTarget?.ability.playerId ?? viewer.id
  // Earlier Evokes and Channels in the same effect are still only planned; while they
  // are chosen and aimed, the owner's Orb row shows the slots that plan leaves.
  const evokePlannedOrbs = startTurn.pendingStartEvoke?.evokePlanOrbs ??
    startTurn.pendingStartEvokeTarget?.ability.evokePlanOrbs ??
    (pending && cardPlay.pendingDef && cardPlay.choiceSatisfied &&
      (cardPlay.pendingEvokeChoice || cardPlay.pendingEvokeTarget >= 0)
      ? evokePlan(cardPlay.pendingDef, viewer, pending.evokeSlots, state.die, pending.mode ?? undefined, pending.effectEnergy ?? 0).orbs
      : undefined)
  const evokeTargetSource: EndTurnAbility | undefined = evokeTargetOrb ? {
    id: 'evoke-target',
    playerId: startTurn.pendingStartEvokeTarget?.ability.playerId ?? viewer.id,
    label: `Evoke ${evokeTargetOrb} Orb`,
    targets: startTurn.pendingStartEvokeTarget
      ? startTurn.pendingStartEvokeTarget.ability.evokeTargets ?? []
      : cardPlay.pendingEvokeTargetOptions,
  } : undefined
  const evokeTargetStep = evokeTargetSource
    ? `${startTurn.pendingStartEvokeTarget ? `${startTurn.pendingStartEvokeTarget.ability.id}:${startTurn.pendingStartEvokeTarget.index}`
      : `${pending?.card.uid}:${cardPlay.pendingEvokeTarget}`}`
    : null

  function resolveTurnEffectTarget(abilityId: string, targetUid: string) {
    if (startTurn.pendingStartPlayer?.id === abilityId &&
      startTurn.pendingStartPlayer.players?.some((player) => player.id === targetUid)) {
      startTurn.chooseStartTurnPlayer(targetUid)
      drag.setArmedEndTurnAbilityId(null)
      return
    }
    if (startTurn.pendingStartEnemy?.id === abilityId) {
      startTurn.chooseStartTurnEnemy(targetUid)
      drag.setArmedEndTurnAbilityId(null)
      return
    }
    if (evokeTargetSource?.id === abilityId) {
      drag.setArmedEndTurnAbilityId(null)
      if (startTurn.pendingStartEvokeTarget) startTurn.chooseStartTurnEvokeEnemy(targetUid)
      else cardPlay.chooseCardEvokeTarget(targetUid)
      return
    }
    if (!endTurnEffect || !canResolveEndTurn || endTurnEffect.id !== abilityId ||
      !endTurnEffect.targets?.some((target) => target.uid === targetUid)) return
    if (endTurnSelfExhaust && endTurnEffect.targets.some((target) => target.uid === selfExhaustEndTurnTarget(targetUid))) {
      targetUid = selfExhaustEndTurnTarget(targetUid)
    }
    drag.setArmedEndTurnAbilityId(null)
    if (onAction) {
      onAction({ kind: 'resolveEndTurnEffect', abilityId, targetUid })
      return
    }
    const next = resolveEndTurnAbility(state, chooseEndTurnTarget(abilityId, targetUid))
    if (next !== state) onChange?.(next)
  }

  const drag = useCombatDrag({
    state,
    viewer,
    viewerId,
    drawCount,
    authoritativeRestoration,
    authoritativeConnected,
    usingCard,
    pending,
    pendingTrigger: items.pendingTrigger,
    endTurnResolving,
    forcedCard,
    distilled,
    relicScry,
    miracleOnCard,
    voluntaryActionsBlocked,
    endTurnEffect,
    canResolveEndTurn,
    canResolveStartTurn: startTurn.canResolveStartTurn,
    startTurnEffectDraggable: startTurn.startTurnEffectDraggable,
    startTurnEffectSource: startTurn.startTurnEffectSource,
    evokeTargetSource,
    evokeTargetOrb,
    evokeTargetStep,
    pendingStartEnemy: startTurn.pendingStartEnemy,
    startEnemyChoiceAvailable: startTurn.startEnemyChoiceAvailable,
    onResolveTurnEffectTarget: resolveTurnEffectTarget,
    onCardClick: cardPlay.onCardClick,
    onHermitChamberPlay: cardPlay.submitHermitChamber,
  })

  const previewEnemyUid = (() => {
    const living = livingEnemies(state)
    if (living.length === 1) return living[0]!.uid
    const picked = drag.cardDrag?.targetUid ?? pointedEnemyUid
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
    viewer.chamber.some(drag.chamberCardCanStartDrag) ||
    viewer.shivs > 0 || viewer.soulburn > 0 ||
    viewer.guardianMode && viewer.vigor > 0 && !viewer.cardPlayLocked && !reachedTimeWarpLimit(state, viewer) ||
    viewer.miracles > 0 && viewer.energy < CAPS.energy && (
      viewer.relics.some((relic) => relic.defId === 'ice_cream') ||
      viewer.hand.some((card) => canAfford(state, viewer, card, true, drawCount))) ||
    viewer.potions.some((potionId) => items.canUsePotionNow(potionId)) ||
    viewer.powers.some((power) => {
      const def = faceOf(cardDef(power.defId), power.upgraded)
      return Boolean(def.activeAbility) && (!def.oncePerTurn || !powerAbilityUsed(state, viewer.id, power.uid)) &&
        powerActivationAllowed(def, state, viewer)
    }) ||
    viewer.relics.some((_, relicIndex) => items.canUseRelicNow(relicIndex)) || courierAvailable)
  useEffect(() => {
    if (onAction || !autoAdvance || !autoEndTurn || state.players.length !== 1 || state.phase !== 'player' ||
      viewer.dead || viewerHasLegalAction || voluntaryActionsBlocked || forcedCard || distilled || pending || items.pendingTrigger ||
      endTurnResolving || playWindow) return undefined
    const timer = window.setTimeout(finishTurn, 450)
    return () => window.clearTimeout(timer)
    // Slayer Pack: an open card-play window is still being resolved; the engine closes it once nothing is left.
  }, [autoAdvance, autoEndTurn, state.phase, state.turn, state.players.length, viewer.dead, viewerHasLegalAction,
    forcedCard, distilled, pending, items.pendingTrigger, endTurnResolving, voluntaryActionsBlocked, playWindow])

  // AoE potions, powers and evokes derive their row click from any enemy in
  // the row; cleared rows can still be chosen on their empty ground.
  function onEnemyClick(enemy: Enemy) {
    const endTurnTarget = drag.endTurnTargetForEnemy(enemy)
    if (endTurnTarget && drag.armedEndTurnAbilityId === endTurnEffect?.id) {
      resolveTurnEffectTarget(endTurnEffect.id, endTurnTarget)
      return
    }
    if (items.pendingTrigger && items.pendingTrigger.playerId === viewer?.id) {
      if (items.triggerHermitChoicesReady && items.triggerSlimeChoicesReady &&
        items.triggerSlimeEnemyUids.length < items.triggerSlimeEnemyAmount) {
        const targets = [...items.triggerSlimeEnemyUids, enemy.uid]
        if (targets.length === items.triggerSlimeEnemyAmount && !items.pendingTrigger.targets) {
          items.resolveTrigger(undefined, undefined, undefined, targets)
        } else items.setTriggerSlimeEnemyUids(targets)
        return
      }
      if (items.triggerHermitChoicesReady && items.triggerSlimeChoicesReady &&
        items.triggerSlimeEnemyUids.length === items.triggerSlimeEnemyAmount &&
        items.pendingTrigger.targets?.some((target) => target.uid === enemy.uid)) {
        items.resolveTrigger(undefined, enemy.uid)
        return
      }
      if (items.triggerHermitChoicesReady && items.pendingTrigger.rows?.some((target) => target.row === enemy.row)) {
        items.resolveTrigger(enemy.row)
        return
      }
    }
    if (startTurn.pendingStartEnemy) {
      startTurn.chooseStartTurnEnemy(enemy.uid)
      drag.setArmedEndTurnAbilityId(null)
      return
    }
    if (startTurn.pendingStartShiv) {
      startTurn.chooseStartTurnShiv(enemy.uid)
      return
    }
    if (startTurn.pendingStartEvokeTarget) {
      if (enemy.isBoss) {
        if (startTurn.pendingStartEvokeTarget.ability.evokeTargets?.some((target) => target.uid === enemy.uid)) {
          startTurn.chooseStartTurnEvokeEnemy(enemy.uid)
        }
        return
      }
      const rowTarget = startTurn.pendingStartEvokeRows.find((target) => target.row === enemy.row)
      if (rowTarget) {
        startTurn.chooseStartTurnEvokeEnemy(rowTarget.uid)
        return
      }
      if (startTurn.pendingStartEvokeRows.length > 0) return
      startTurn.chooseStartTurnEvokeEnemy(enemy.uid)
      return
    }
    if (items.pendingPotion) {
      if (items.pendingPotionDef?.target === 'enemy' || items.pendingPotion === 'mystery_potion' && state.die <= 2) {
        items.consumePotion(items.pendingPotion, { enemyUid: enemy.uid })
      } else if (items.pendingPotionDef?.target === 'row') {
        items.consumePotion(items.pendingPotion, { enemyRow: enemy.row })
      } else if (!items.pendingPotionDef?.target && items.potionShivEnemyUids.length < items.pendingPotionOverflow) {
        const next = [...items.potionShivEnemyUids, enemy.uid]
        if (next.length === items.pendingPotionOverflow) {
          items.consumePotion(
            items.pendingPotion,
            { shivEnemyUids: next },
            { expected: items.pendingPotionOverflow, skip: false },
          )
        } else items.setPotionShivEnemyUids(next)
      }
      return
    }
    if (items.pendingPowerUid && items.pendingPowerDef) {
      if (items.pendingPowerDef.target === 'row') {
        items.usePower(items.pendingPowerUid, { enemyRow: enemy.row })
        return
      }
      if (items.pendingPowerDef.id === 'hermit_black_wind' && items.powerLoadUids.length === 1) {
        items.usePower(items.pendingPowerUid, { chamberUids: items.powerChamberUids, loadUids: items.powerLoadUids,
          hermitEnemyUids: [enemy.uid] })
        items.setPowerChamberUids([])
        items.setPowerLoadUids([])
        return
      }
      if (items.pendingHermitPower) return
      if (items.pendingPower?.attachedGemId === 'guardian_jasper' ||
        items.pendingPower?.attachedGemId === 'guardian_onyx' ||
        items.pendingPower?.attachedGemId === 'guardian_amethyst') return
      items.choosePowerContext({ enemyUid: enemy.uid })
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
      const extraCrispyPowerUid = extraCrispySoulburn ? items.extraCrispyPower?.uid : undefined
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
      pending.slimeEnemyUids.length < cardPlay.slimeEnemyChoicesRequired(pending) &&
      cardPlay.handChoiceSatisfied && cardPlay.revealedChoiceSatisfied) {
      cardPlay.stageOrCommit({ ...pending, slimeEnemyUids: [...pending.slimeEnemyUids, enemy.uid] })
      return
    }
    if (pending && pending.hermitEnemyUids.length < cardPlay.loadedTargetCount(pending) &&
      cardPlay.handChoiceSatisfied && cardPlay.revealedChoiceSatisfied) {
      cardPlay.stageOrCommit({ ...pending, hermitEnemyUids: [...pending.hermitEnemyUids, enemy.uid] })
      return
    }
    if (pending && pending.soulburnEnemyUids.length < pending.soulburnChoices &&
      cardPlay.handChoiceSatisfied && cardPlay.revealedChoiceSatisfied) {
      cardPlay.stageOrCommit({ ...pending, soulburnEnemyUids: [...pending.soulburnEnemyUids, enemy.uid] })
      return
    }
    if (pending?.chamberPlay && pending.choicePreviewPending) {
      cardPlay.requestChamberChoicePreview(pending.card, enemy.uid, pending)
      return
    }
    if (pending && cardPlay.pendingEvokeTarget >= 0 && cardPlay.choiceSatisfied) {
      cardPlay.chooseCardEvokeTarget(cardPlay.pendingEvokeUsesRows && !enemy.isBoss
        ? lightningRowTarget(enemy.row) : enemy.uid)
      return
    }
    if (!cardPlay.evokeChoicesDone) return
    if (!pending || !pending.needsEnemy || !cardPlay.choiceSatisfied) return
    const normalTargetNeeded = cardPlay.pendingNeedsCardEnemy && !pending.enemyUid
    if (normalTargetNeeded) {
      if (cardPlay.pendingDef && cardNeedsChoicePreview(cardPlay.pendingDef, state, viewer!)) {
        if (pending.chamberPlay) cardPlay.requestChamberChoicePreview(pending.card, enemy.uid, pending)
        else if (pending.cardInHand) cardPlay.requestChoicePreview(pending.card, enemy.uid, pending)
        else cardPlay.requestCopyChoicePreview(enemy.uid, pending)
        return
      }
      if (!cardPlay.slayerTargetAffordable(pending, enemy)) return
      const next = cardPlay.withAdjacentChoices({ ...pending, enemyUid: enemy.uid })
      if (next.spentShivs + next.overflowShivs > 0) cardPlay.stageOrCommit(next)
      else if (next.enemyUids.length < next.enemyChoices ||
        next.needsAlly || next.playerIds.length < next.playerChoices || next.needsSwitch) setPending(next)
      else cardPlay.commit(next)
      return
    }
    if (pending.enemyUids.length < pending.enemyChoices) {
      const effects = cardPlay.pendingDef?.modes && pending.mode != null
        ? cardPlay.pendingDef.modes[pending.mode]?.effects ?? []
        : cardPlay.pendingDef?.effects ?? []
      if (effects.some((effect) => effect.kind === 'hitChoices' && effect.distinct) &&
        pending.enemyUids.includes(enemy.uid)) return
      if (cardPlay.adjacentPickUids && !cardPlay.slayerTargetAllowed(enemy)) return
      const next = { ...pending, enemyUids: [...pending.enemyUids, enemy.uid] }
      if (next.enemyUids.length < next.enemyChoices || next.spentShivs + next.overflowShivs > 0 ||
        next.needsAlly || next.playerIds.length < next.playerChoices || next.needsSwitch) setPending(next)
      else cardPlay.commit(next)
      return
    }
    if (pending.shivEnemyUids.length < pending.spentShivs + pending.overflowShivs) {
      if (cardPlay.pendingShivProgress && !cardPlay.pendingShivProgress.options.some((option) => option.uid === enemy.uid)) return
      cardPlay.stageOrCommit({ ...pending, shivEnemyUids: [...pending.shivEnemyUids, enemy.uid] })
    }
  }

  // Mirrors `onEnemyClick`'s row branches exactly.
  function isEnemyRowClickTargetable(enemy: Enemy): boolean {
    if (drag.armedEndTurnAbilityId === endTurnEffect?.id &&
      drag.endTurnTargetForEnemy(enemy) === lightningRowTarget(enemy.row)) {
      return true
    }
    if (!items.usingTrigger && items.pendingTrigger && items.pendingTrigger.playerId === viewer?.id &&
      items.triggerHermitChoicesReady && items.pendingTrigger.rows?.some((target) => target.row === enemy.row)) {
      return true
    }
    if (startTurn.pendingStartEvokeTarget && (enemy.isBoss
      ? startTurn.pendingStartEvokeTarget.ability.evokeTargets?.some((target) => target.uid === enemy.uid)
      : startTurn.pendingStartEvokeRows.some((target) => target.row === enemy.row))) return true
    if (items.pendingPotion && items.pendingPotionDef?.target === 'row') return true
    if (items.pendingPowerUid && items.pendingPowerDef?.target === 'row') return true
    if (pending && cardPlay.pendingEvokeTarget >= 0 && cardPlay.pendingEvokeUsesRows && cardPlay.choiceSatisfied &&
      cardPlay.pendingEvokeTargetUids.has(enemy.isBoss ? enemy.uid : lightningRowTarget(enemy.row))) return true
    return false
  }

  // Cleared rows are still legal choices when no enemy anchors them.
  function onRowLaneClick(row: number) {
    const endTurnTarget = drag.endTurnTargetForRow(row)
    if (endTurnTarget && drag.armedEndTurnAbilityId === endTurnEffect?.id) {
      resolveTurnEffectTarget(endTurnEffect.id, endTurnTarget)
      return
    }
    if (items.pendingTrigger && items.pendingTrigger.playerId === viewer?.id && items.triggerHermitChoicesReady &&
      items.pendingTrigger.rows?.some((target) => target.row === row)) {
      items.resolveTrigger(row)
      return
    }
    if (startTurn.pendingStartEvokeTarget) {
      const rowTarget = startTurn.pendingStartEvokeRows.find((target) => target.row === row)
      if (rowTarget) startTurn.chooseStartTurnEvokeEnemy(rowTarget.uid)
      return
    }
    if (items.pendingPotion && items.pendingPotionDef?.target === 'row') {
      items.consumePotion(items.pendingPotion, { enemyRow: row })
      return
    }
    if (items.pendingPowerUid && items.pendingPowerDef?.target === 'row') {
      items.usePower(items.pendingPowerUid, { enemyRow: row })
      return
    }
    if (cardPlay.pendingEvokeUsesRows) cardPlay.chooseCardEvokeTarget(lightningRowTarget(row))
  }

  function isRowLaneClickTargetable(row: number): boolean {
    if (drag.endTurnEffectAimed && drag.endTurnTargetForRow(row)) return true
    if (!items.usingTrigger && items.pendingTrigger && items.pendingTrigger.playerId === viewer?.id &&
      items.triggerHermitChoicesReady && items.pendingTrigger.rows?.some((target) => target.row === row)) {
      return true
    }
    if (startTurn.pendingStartEvokeTarget && startTurn.pendingStartEvokeRows.some((target) => target.row === row)) return true
    if (items.pendingPotion && items.pendingPotionDef?.target === 'row') return true
    if (items.pendingPowerUid && items.pendingPowerDef?.target === 'row') return true
    if (pending && cardPlay.pendingEvokeTarget >= 0 && cardPlay.pendingEvokeUsesRows && cardPlay.choiceSatisfied &&
      cardPlay.pendingEvokeTargetUids.has(lightningRowTarget(row))) return true
    return false
  }

  // The ground's accessible name follows the same priority as its click.
  function rowLaneClickLabel(row: number): string {
    const rowLabel = combatRowLabel(state, row)
    if (drag.endTurnEffectAimed && endTurnEffect && drag.endTurnTargetForRow(row)) {
      return `Resolve ${endTurnEffect.label} in ${rowLabel}`
    }
    if (!items.usingTrigger && items.pendingTrigger && items.pendingTrigger.playerId === viewer?.id &&
      items.triggerHermitChoicesReady && items.pendingTrigger.rows?.some((target) => target.row === row)) {
      return `Resolve ${items.pendingTrigger.label} in ${rowLabel}`
    }
    if (startTurn.pendingStartEvokeTarget && startTurn.pendingStartEvokeRows.some((target) => target.row === row)) {
      return `Evoke Lightning in ${rowLabel}`
    }
    if (items.pendingPotion && items.pendingPotionDef?.target === 'row') {
      return `Target ${rowLabel} with ${items.pendingPotionDef.name}`
    }
    if (items.pendingPowerUid && items.pendingPowerDef?.target === 'row') {
      return `Target ${rowLabel} with ${items.pendingPowerDef.name}`
    }
    if (pending && cardPlay.pendingEvokeTarget >= 0 && cardPlay.pendingEvokeUsesRows && cardPlay.choiceSatisfied &&
      cardPlay.pendingEvokeTargetUids.has(lightningRowTarget(row))) {
      return `Evoke Lightning in ${rowLabel}`
    }
    return `Target ${rowLabel}`
  }

  function onAllyClick(ally: Player) {
    if (ally.dead) return
    if (startTurn.pendingStartPlayer?.players?.some((player) => player.id === ally.id) &&
      drag.armedEndTurnAbilityId === startTurn.pendingStartPlayer.id) {
      startTurn.chooseStartTurnPlayer(ally.id)
      drag.setArmedEndTurnAbilityId(null)
      return
    }
    if (items.pendingPowerUid && items.pendingPower &&
      guardianCardNeedsAlly(items.pendingPowerDef!, viewer!, items.pendingPower.attachedGemId)) {
      items.choosePowerContext({ playerId: ally.id })
      return
    }
    if (items.pendingPotion && potionDef(items.pendingPotion).supportTarget === 'anyPlayer') {
      items.consumePotion(items.pendingPotion, { targetPlayerId: ally.id })
      return
    }
    if (!pending || !cardPlay.enemyChoicesDone || !cardPlay.choiceSatisfied) return
    if (pending.playerIds.length < pending.playerChoices) {
      const next = { ...pending, playerIds: [...pending.playerIds, ally.id] }
      if (next.playerIds.length < next.playerChoices || next.needsAlly || next.needsSwitch) setPending(next)
      else cardPlay.commit(next)
      return
    }
    if (pending.needsAlly && pending.playerId === null) {
      cardPlay.stageOrCommit({ ...pending, playerId: ally.id })
      return
    }
    if (cardPlay.switchChoiceReady && ally.id !== viewerId) {
      cardPlay.stageOrCommit({ ...pending, switchPlayerId: ally.id, switchChoiceDone: true })
    }
  }

  // Shared across every row-target prompt below so "the boss is always
  // folded in regardless of row" reads the same way everywhere.
  const rowHitSuffix = state.enemies.some((enemy) => enemy.isBoss && !enemy.dead) ? ', and the boss' : ''
  const enemyPrompt = deriveEnemyPrompt({
    state,
    pending,
    pendingDef: cardPlay.pendingDef,
    normalEnemyPending: cardPlay.normalEnemyPending,
    independentEnemyPending: cardPlay.independentEnemyPending,
    independentHitPending: cardPlay.independentHitPending,
    adjacentPickUids: cardPlay.adjacentPickUids,
    spentShivPending: cardPlay.spentShivPending,
    overflowOnly: cardPlay.overflowOnly,
    pendingShivProgress: cardPlay.pendingShivProgress,
    originalTarget: cardPlay.originalTarget,
    copyTarget: cardPlay.copyTarget,
    rowHitSuffix,
  })
  const startTurnPrompt = deriveStartTurnPrompt({
    state,
    pendingStartExhaust: startTurn.pendingStartExhaust,
    pendingStartShiv: startTurn.pendingStartShiv,
    pendingStartEnemy: startTurn.pendingStartEnemy,
    pendingStartPlayer: startTurn.pendingStartPlayer,
    pendingStartEvokeTarget: startTurn.pendingStartEvokeTarget,
    pendingStartEvokeRows: startTurn.pendingStartEvokeRows,
    pendingStartEvoke: startTurn.pendingStartEvoke,
    teammateStartExhaust: startTurn.teammateStartExhaust,
    rowHitSuffix,
  })
  const forcedPrompt = deriveForcedPrompt(state, viewerId, forcedCard, pending)
  const plunderPrompt = derivePlunderPrompt(state, viewer.id, items.pendingPlunder)
  // Slayer Pack: another player's card-given choice (the owner answers in their own prompt below).
  const waitingPlayerChoice = items.viewerPlayerChoice ? undefined : items.owedChoices[0]
  const playerChoicePrompt = derivePlayerChoicePrompt(state, waitingPlayerChoice)
  const dieRelicPrompt = deriveDieRelicPrompt(state, viewer.id, items.dieRelicPending)
  const triggerPrompt = deriveTriggerPrompt({
    state,
    viewerId: viewer.id,
    pendingTrigger: items.pendingTrigger,
    triggerHermitChoicesReady: items.triggerHermitChoicesReady,
    triggerSlimeChoicesReady: items.triggerSlimeChoicesReady,
    triggerSlimeEnemyUids: items.triggerSlimeEnemyUids,
    triggerSlimeEnemyAmount: items.triggerSlimeEnemyAmount,
    triggerSlimeEnemyLabels: items.triggerSlimeEnemyLabels,
    triggerHermitCurse: items.triggerHermitCurse,
    rowHitSuffix,
  })
  const beforeDrawPrompt = deriveBeforeDrawPrompt(state, viewer.id, startTurn.activeStartTurnScry)
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
    pendingPower: items.pendingPower,
    pendingPowerDef: items.pendingPowerDef,
    powerScryConfirmed: items.powerScryConfirmed,
    pendingPowerNeedsAlly: items.pendingPowerNeedsAlly,
    powerChamberUids: items.powerChamberUids,
    powerLoadUids: items.powerLoadUids,
    creativeAiEffect: items.creativeAiEffect,
    pendingPotion: items.pendingPotion,
    pendingPotionDef: items.pendingPotionDef,
    pendingPotionOverflow: items.pendingPotionOverflow,
    pendingPotionNeedsEnemy: items.pendingPotionNeedsEnemy,
    potionCardUids: items.potionCardUids,
    potionShivEnemyUids: items.potionShivEnemyUids,
    viewerHasSozu: items.viewerHasSozu,
    spendingShiv,
    spendingSoulburn,
    pending,
    pendingDef: cardPlay.pendingDef,
    slimeEnemyChoicesRequired: cardPlay.slimeEnemyChoicesRequired,
    slimeEnemyChoiceLabels: cardPlay.slimeEnemyChoiceLabels,
    chamberChoiceRequired: cardPlay.chamberChoiceRequired,
    loadedTargetCount: cardPlay.loadedTargetCount,
    modeSatisfied: cardPlay.modeSatisfied,
    corruptedShardModeNeeded: cardPlay.corruptedShardModeNeeded,
    corruptedShardModeSatisfied: cardPlay.corruptedShardModeSatisfied,
    pendingPowerBeamChoiceNeeded: cardPlay.pendingPowerBeamChoiceNeeded,
    choiceNeeded: cardPlay.choiceNeeded,
    choicePoolSize: cardPlay.choicePoolSize,
    pendingSearchKind: cardPlay.pendingSearchKind,
    handChoiceSatisfied: cardPlay.handChoiceSatisfied,
    pendingEvokeTarget: cardPlay.pendingEvokeTarget,
    pendingEvokeUsesRows: cardPlay.pendingEvokeUsesRows,
    pendingEvokeChoice: cardPlay.pendingEvokeChoice,
    enemyChoicesDone: cardPlay.enemyChoicesDone,
    independentPlayerPending: cardPlay.independentPlayerPending,
    switchChoiceReady: cardPlay.switchChoiceReady,
  })
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
      inert={chamber.chamberClosing}
      aria-busy={chamber.chamberClosing || undefined}
      data-act={stageAct}
      data-character={viewer.character}
      data-phase={state.phase}
      data-party-size={state.players.length}
      data-stage-motion={presentation.stageMotionReady && !prefersReducedMotion || undefined}
      style={{
        backgroundImage: `linear-gradient(90deg, rgb(2 5 8 / 0.38), transparent 22%, transparent 74%, rgb(2 5 8 / 0.32)), url("${assetPath(`backgrounds/boss-act-${stageAct}.webp`)}")`,
        '--stage-scale': presentation.stageScale,
        '--stage-enemy-count': presentation.stageEnemySlots,
        '--stage-party-count': state.players.length,
        '--stage-width': `calc(${state.players.length} * var(--stage-player-gap) + var(--stage-enemy-count) * var(--stage-enemy-gap) + ${STAGE_MARGIN_REM}rem * var(--stage-scale) + var(--slime-enemy-clearance, 0rem))`,
        '--slime-count': presentation.largestSlimeParty,
        '--stage-gap': `calc(${STAGE_GAP_REM}rem * var(--stage-scale))`,
        '--stage-enemy-gap': 'var(--stage-gap)',
        '--stage-actor-width': `calc(${STAGE_GAP_REM - 1}rem * var(--stage-scale))`,
      } as React.CSSProperties}
    >
      <GroundedCombatVfx
        enemies={state.enemies}
        activeVfx={presentation.activeVfx}
        orbEndTurnRevealDelayMs={presentation.orbEndTurnRevealDelayMs}
      />
      <CombatBar
        combatBarRef={presentation.combatBarRef}
        endTurnRef={endTurnRef}
        state={state}
        viewer={viewer}
        viewerId={viewerId}
        livingPlayers={items.livingPlayers}
        copyResolutionLabel={cardPlay.copyResolutionLabel}
        hermitSetupPending={items.hermitSetupPending}
        hermitSetupOwner={items.hermitSetupOwner}
        onCourierReveal={onCourierReveal}
        courierUsedBy={courierUsedBy}
        playerChoicePrompt={playerChoicePrompt}
        viewerPlayerChoice={items.viewerPlayerChoice}
        usingPlayerChoice={items.usingPlayerChoice}
        submitPlayerChoice={items.submitPlayerChoice}
        setPlayerChoiceDiscarding={items.setPlayerChoiceDiscarding}
        relicScry={relicScry}
        voluntaryActionsBlocked={voluntaryActionsBlocked}
        forcedCard={forcedCard}
        distilled={distilled}
        endTurnResolving={endTurnResolving}
        pendingTrigger={items.pendingTrigger}
        pending={pending}
        setPending={setPending}
        pendingPowerUid={items.pendingPowerUid}
        setPendingPowerUid={items.setPendingPowerUid}
        usingPower={items.usingPower}
        setPowerChamberUids={items.setPowerChamberUids}
        setPowerLoadUids={items.setPowerLoadUids}
        setPowerExhaustUids={items.setPowerExhaustUids}
        powerOrbSlots={items.powerOrbSlots}
        setPowerOrbSlots={items.setPowerOrbSlots}
        setPowerGemContext={items.setPowerGemContext}
        setPowerScryConfirmed={items.setPowerScryConfirmed}
        requestPowerPreview={items.requestPowerPreview}
        usePower={items.usePower}
        creativeAiEffect={items.creativeAiEffect}
        canUsePotionNow={items.canUsePotionNow}
        pendingPotion={items.pendingPotion}
        setPendingPotion={items.setPendingPotion}
        usingPotion={items.usingPotion}
        viewerHasSozu={items.viewerHasSozu}
        setPotionShivEnemyUids={items.setPotionShivEnemyUids}
        setPotionOverflowRequired={items.setPotionOverflowRequired}
        setPotionCardUids={items.setPotionCardUids}
        consumePotion={items.consumePotion}
        spendingShiv={spendingShiv}
        setSpendingShiv={setSpendingShiv}
        spendingSoulburn={spendingSoulburn}
        setSpendingSoulburn={setSpendingSoulburn}
        extraCrispyPower={items.extraCrispyPower}
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
        chamberClosing={chamber.chamberClosing}
        discardOrders={discardOrders}
        confirmedDiscards={confirmedDiscards}
        endTurnParticipants={endTurnParticipants}
        endTurnCount={endTurnCount}
        stagedStartTurnTriggerPending={items.stagedStartTurnTriggerPending}
        startTurnCount={startTurn.startTurnCount}
        startTurnOpen={startTurn.startTurnOpen}
        activeStartTurnScry={startTurn.activeStartTurnScry}
        orderedStartTurnScries={startTurn.orderedStartTurnScries}
        canOrderStartTurnScries={startTurn.canOrderStartTurnScries}
        startTurnOrderHint={startTurn.startTurnOrderHint}
        moveStartTurnScry={startTurn.moveStartTurnScry}
        finishStartTurnScryOrder={startTurn.finishStartTurnScryOrder}
        startTurnChoicesOpen={startTurn.startTurnChoicesOpen}
        stagedStartTurnTriggers={stagedStartTurnTriggers}
        setEditingStagedStartTurnTrigger={items.setEditingStagedStartTurnTrigger}
        pendingStartEnemy={startTurn.pendingStartEnemy}
        startEnemyChoiceAvailable={startTurn.startEnemyChoiceAvailable}
        chooseStartTurnEnemy={startTurn.chooseStartTurnEnemy}
        visibleStartModeShift={startTurn.visibleStartModeShift}
        canCommitStartTurnOrder={startTurn.canCommitStartTurnOrder}
        partyStartTurnOrderLocked={partyStartTurnOrderLocked}
        orderedStartAbilities={startTurn.orderedStartAbilities}
        startTurnTargets={startTurn.startTurnTargets}
        startTurnEvokeSlots={startTurn.startTurnEvokeSlots}
        startTurnEnemyTargets={startTurn.startTurnEnemyTargets}
        startTurnPlayerTargets={startTurn.startTurnPlayerTargets}
        startTurnExhaustUids={startTurn.startTurnExhaustUids}
        startTurnModeShifts={startTurn.startTurnModeShifts}
        savedStartTurnEnemyTargets={savedStartTurnEnemyTargets}
        setStartTurnEnemyTargets={startTurn.setStartTurnEnemyTargets}
        setStartTurnPlayerTargets={startTurn.setStartTurnPlayerTargets}
        setStartTurnExhaustUids={startTurn.setStartTurnExhaustUids}
        setStartTurnModeShifts={startTurn.setStartTurnModeShifts}
        setStartTurnTargets={startTurn.setStartTurnTargets}
        setStartTurnEvokeSlots={startTurn.setStartTurnEvokeSlots}
        setStartTurnEvokeTargets={startTurn.setStartTurnEvokeTargets}
        moveStartTurnAbility={startTurn.moveStartTurnAbility}
        canResolveStartTurn={startTurn.canResolveStartTurn}
        resolvingStartTurnMode={startTurn.resolvingStartTurnMode}
        finishStartTurn={startTurn.finishStartTurn}
        startTurnReady={startTurn.startTurnReady}
        sendingStartTurn={startTurn.sendingStartTurn}
        viewerStartTurnDecided={startTurn.viewerStartTurnDecided}
        startTurnCoordinator={startTurn.startTurnCoordinator}
        partyStartTurnOrderPending={partyStartTurnOrderPending}
        startTurnCoordinatorId={startTurnCoordinatorId}
        startTurnChoiceId={startTurnChoiceId}
        fumesOwnerId={startTurn.fumesOwnerId}
        startTurnStuck={startTurn.startTurnStuck}
        onResync={onResync}
        resyncing={startTurn.resyncing}
        setResyncing={startTurn.setResyncing}
      />

      {over && !(state.phase === 'won' && items.slayerChoice?.playerId === viewer.id) ? (
        <p className={`combat__result combat__result--${state.phase}`} role="status">
          {state.phase === 'won' ? 'Victory' : 'The party has fallen'}
        </p>
      ) : null}

      <CombatPromptBar
        state={state}
        viewer={viewer}
        viewerId={viewerId}
        drawCount={drawCount}
        prompt={prompt}
        playWindow={playWindow}
        playWindowPrompt={playWindowPrompt}
        playWindowName={playWindowName}
        spentShivPending={cardPlay.spentShivPending}
        normalEnemyPending={cardPlay.normalEnemyPending}
        usingCard={usingCard}
        endTurnResolving={endTurnResolving}
        finishPlayWindow={cardPlay.finishPlayWindow}
        pendingPlunder={items.pendingPlunder}
        submitPlunderRow={items.submitPlunderRow}
        pendingStartShiv={startTurn.pendingStartShiv}
        canResolveStartTurn={startTurn.canResolveStartTurn}
        chooseStartTurnShiv={startTurn.chooseStartTurnShiv}
        pendingTrigger={items.pendingTrigger}
        triggerHermitChoicesReady={items.triggerHermitChoicesReady}
        resolveTrigger={items.resolveTrigger}
        triggerSlimeUids={items.triggerSlimeUids}
        setTriggerSlimeUids={items.setTriggerSlimeUids}
        setTriggerSlimeEnemyUids={items.setTriggerSlimeEnemyUids}
        triggerSlimeEnemyAmount={items.triggerSlimeEnemyAmount}
        pendingHermitPower={items.pendingHermitPower}
        pendingPowerUid={items.pendingPowerUid}
        pendingPower={items.pendingPower}
        pendingPowerDef={items.pendingPowerDef}
        usePower={items.usePower}
        powerExhaustUids={items.powerExhaustUids}
        setPowerExhaustUids={items.setPowerExhaustUids}
        choosePowerContext={items.choosePowerContext}
        powerChamberUids={items.powerChamberUids}
        setPowerChamberUids={items.setPowerChamberUids}
        powerLoadUids={items.powerLoadUids}
        setPowerLoadUids={items.setPowerLoadUids}
        triggerHermitStep={items.triggerHermitStep}
        setTriggerHermitStep={items.setTriggerHermitStep}
        triggerHermitReopenRef={items.triggerHermitReopenRef}
        usingTrigger={items.usingTrigger}
        pendingStartPlayer={startTurn.pendingStartPlayer}
        chooseStartTurnPlayer={startTurn.chooseStartTurnPlayer}
        pending={pending}
        setPending={setPending}
        pendingDef={cardPlay.pendingDef}
        pendingEffectiveDef={cardPlay.pendingEffectiveDef}
        overflowOnly={cardPlay.overflowOnly}
        choiceSatisfied={cardPlay.choiceSatisfied}
        commit={cardPlay.commit}
        stageOrCommit={cardPlay.stageOrCommit}
        hermitDieRelicSelectionsReady={cardPlay.hermitDieRelicSelectionsReady}
        forcedCardUid={forcedCardUid}
        chamberChoiceRequired={cardPlay.chamberChoiceRequired}
        chamberReplacementOptions={cardPlay.chamberReplacementOptions}
        variableMinimum={cardPlay.variableMinimum}
        modeSatisfied={cardPlay.modeSatisfied}
        onModeClick={cardPlay.onModeClick}
        corruptedShardModeNeeded={cardPlay.corruptedShardModeNeeded}
        corruptedShardModeSatisfied={cardPlay.corruptedShardModeSatisfied}
        onCorruptedShardModeClick={cardPlay.onCorruptedShardModeClick}
        pendingPowerBeamChoiceNeeded={cardPlay.pendingPowerBeamChoiceNeeded}
        pendingPowerBeamCards={cardPlay.pendingPowerBeamCards}
        pendingPotion={items.pendingPotion}
        pendingPotionOverflow={items.pendingPotionOverflow}
        potionShivEnemyUids={items.potionShivEnemyUids}
        consumePotion={items.consumePotion}
        switchChoiceReady={cardPlay.switchChoiceReady}
      />

      <CombatPotionDialogs
        state={state}
        viewer={viewer}
        stanceChangedThisTurn={stanceChangedThisTurn}
        itemDialogRef={items.itemDialogRef}
        pendingPotion={items.pendingPotion}
        pendingPotionDef={items.pendingPotionDef}
        pendingPotionNeedsCards={items.pendingPotionNeedsCards}
        potionCardUids={items.potionCardUids}
        setPotionCardUids={items.setPotionCardUids}
        consumePotion={items.consumePotion}
        cancelPotionChoice={items.cancelPotionChoice}
        viewerHasSozu={items.viewerHasSozu}
      />

      {!forcedCard && !distilled && !relicScry && !voluntaryActionsBlocked &&
        (state.phase === 'player' || state.phase === 'start' || state.phase === 'discard') ? (
        <RelicActions
          state={state}
          viewer={viewer}
          viewerId={viewerId}
          stanceChangedThisTurn={stanceChangedThisTurn}
          enemyButtonOrder={enemyButtonOrder}
          canUseRelicNow={items.canUseRelicNow}
          useRelic={items.useRelic}
          relicCardUids={items.relicCardUids}
          setRelicCardUids={items.setRelicCardUids}
          relicShivEnemyUids={items.relicShivEnemyUids}
          setRelicShivEnemyUids={items.setRelicShivEnemyUids}
          relicActionPending={items.relicActionPending}
        />
      ) : null}

      <CombatChoiceDialogs
        state={state}
        viewer={viewer}
        viewerId={viewerId}
        stanceChangedThisTurn={stanceChangedThisTurn}
        onAction={onAction}
        onChange={onChange}
        itemDialogRef={items.itemDialogRef}
        startTurnScryDialogRef={startTurn.startTurnScryDialogRef}
        startTurnDiscardDialogRef={startTurn.startTurnDiscardDialogRef}
        choiceDialogRef={cardPlay.choiceDialogRef}
        gemFinderScryOpen={items.gemFinderScryOpen}
        powerChoiceCards={items.powerChoiceCards}
        pendingPower={items.pendingPower}
        powerScryDiscardUids={items.powerScryDiscardUids}
        setPowerScryDiscardUids={items.setPowerScryDiscardUids}
        confirmPowerScry={items.confirmPowerScry}
        relicScry={relicScry}
        relicCardUids={items.relicCardUids}
        setRelicCardUids={items.setRelicCardUids}
        useRelic={items.useRelic}
        visibleDistilled={items.visibleDistilled}
        activeStartTurnScry={startTurn.activeStartTurnScry}
        startTurnScryPicked={startTurn.startTurnScryPicked}
        chooseStartTurnScryCard={startTurn.chooseStartTurnScryCard}
        resolvingStartTurnScry={startTurn.resolvingStartTurnScry}
        finishStartTurnScry={startTurn.finishStartTurnScry}
        activeStartTurnDiscard={startTurn.activeStartTurnDiscard}
        finishStartTurnDiscard={startTurn.finishStartTurnDiscard}
        pendingTrigger={items.pendingTrigger}
        pendingPlunder={items.pendingPlunder}
        triggerHermitStep={items.triggerHermitStep}
        setTriggerHermitStep={items.setTriggerHermitStep}
        triggerHermitLoadUids={items.triggerHermitLoadUids}
        setTriggerHermitLoadUids={items.setTriggerHermitLoadUids}
        triggerHermitChamberUids={items.triggerHermitChamberUids}
        setTriggerHermitChamberUids={items.setTriggerHermitChamberUids}
        triggerHermitNeedsBoard={items.triggerHermitNeedsBoard}
        usingTrigger={items.usingTrigger}
        confirmTriggerHermitChoices={items.confirmTriggerHermitChoices}
        pending={pending}
        setPending={setPending}
        pendingDef={cardPlay.pendingDef}
        choiceNeeded={cardPlay.choiceNeeded}
        pendingSearchKind={cardPlay.pendingSearchKind}
        selectedSearchType={cardPlay.selectedSearchType}
        scryPlay={cardPlay.scryPlay}
        scryPlayRequired={cardPlay.scryPlayRequired}
        scryPlayEligible={cardPlay.scryPlayEligible}
        onChoiceCardClick={cardPlay.onChoiceCardClick}
        handChoiceSatisfied={cardPlay.handChoiceSatisfied}
        confirmChoice={cardPlay.confirmChoice}
      />

      <TurnEffectOverlays
        state={state}
        stanceChangedThisTurn={stanceChangedThisTurn}
        startTurnEffectSource={startTurn.startTurnEffectSource}
        pendingStartPlayer={startTurn.pendingStartPlayer}
        startTurnEffectDraggable={startTurn.startTurnEffectDraggable}
        startTurnEffectCard={startTurn.startTurnEffectCard}
        startTurnEffectRelicId={startTurn.startTurnEffectRelicId}
        canResolveStartTurn={startTurn.canResolveStartTurn}
        armedEndTurnAbilityId={drag.armedEndTurnAbilityId}
        activateEndTurnEffect={drag.activateEndTurnEffect}
        onEndTurnEffectPointerDown={drag.onEndTurnEffectPointerDown}
        onEndTurnEffectPointerMove={drag.onEndTurnEffectPointerMove}
        finishEndTurnEffectDrag={drag.finishEndTurnEffectDrag}
        cancelEndTurnEffectDrag={drag.cancelEndTurnEffectDrag}
        evokeTargetSource={evokeTargetSource}
        evokeTargetOrb={evokeTargetOrb}
        pendingStartEvokeTarget={startTurn.pendingStartEvokeTarget}
        pendingEvokeTarget={cardPlay.pendingEvokeTarget}
        visibleStartModeShift={startTurn.visibleStartModeShift}
        resolvingStartTurnMode={startTurn.resolvingStartTurnMode}
        chooseStartTurnMode={startTurn.chooseStartTurnMode}
        endTurnEffect={endTurnEffect}
        canResolveEndTurn={canResolveEndTurn}
        endTurnEffectPrompt={endTurnEffectPrompt}
        endTurnEffectCard={endTurnEffectCard}
        endTurnChoiceTargets={endTurnChoiceTargets}
        endTurnEffectDrag={drag.endTurnEffectDrag}
        endTurnEffectSlimeAsset={endTurnEffectSlimeAsset}
        endTurnOrbChoices={endTurnOrbChoices}
        resolveTurnEffectTarget={resolveTurnEffectTarget}
        endTurnSelfExhaustOffered={endTurnSelfExhaustOffered}
        endTurnSelfExhaust={endTurnSelfExhaust}
        setEndTurnSelfExhaust={setEndTurnSelfExhaust}
      />

      <CombatStage
        state={state}
        viewer={viewer}
        viewerId={viewerId}
        rows={rows}
        bosses={presentation.bosses}
        stageEnemies={presentation.stageEnemies}
        facingEnemies={facingEnemies}
        liveFacingEnemies={liveFacingEnemies}
        boardRef={presentation.boardRef}
        viewerRowRef={presentation.viewerRowRef}
        setPointedEnemyUid={setPointedEnemyUid}
        prefersReducedMotion={prefersReducedMotion}
        characterAttacksActive={presentation.characterAttacksActive}
        falling={presentation.falling}
        targetPresentationTimings={presentation.targetPresentationTimings}
        visualResetKey={presentation.visualResetKey}
        hits={presentation.hits}
        enemyVfxFor={presentation.enemyVfxFor}
        actorVfxFor={presentation.actorVfxFor}
        playerVfxFor={presentation.playerVfxFor}
        orbEndTurnRevealDelayMs={presentation.orbEndTurnRevealDelayMs}
        livePresentationEvents={presentation.livePresentationEvents}
        finishSlimeCommand={presentation.livePresentation.finishSlimeCommand}
        expiredCultistPhase={presentation.expiredCultistPhase}
        activeEnemyPhaseKey={presentation.activeEnemyPhaseKey}
        onCultistThrowPrepared={presentation.onCultistThrowPrepared}
        onCultistThrowStart={presentation.onCultistThrowStart}
        onCultistThrowSkipped={presentation.onCultistThrowSkipped}
        characterAttackAssets={presentation.characterAttackAssets}
        characterAttackBlobs={presentation.characterAttackBlobs}
        stagedPosesReady={presentation.stagedPosesReady}
        monogatariPosesReady={presentation.monogatariPosesReady}
        monogatariEvokeReady={presentation.monogatariEvokeReady}
        monogatariEvokesReadyByEvent={presentation.monogatariEvokesReadyByEvent}
        characterAttacks={motions.characterAttacks}
        slimeCommandMotions={motions.slimeCommandMotions}
        setSlimeLayoutVersion={motions.setSlimeLayoutVersion}
        showSlimeCard={showSlimeCard}
        hideSlimeCard={hideSlimeCard}
        pendingStartEnemy={startTurn.pendingStartEnemy}
        pendingStartPlayer={startTurn.pendingStartPlayer}
        pendingStartEvoke={startTurn.pendingStartEvoke}
        startEnemyChoiceAvailable={startTurn.startEnemyChoiceAvailable}
        pendingShivProgress={cardPlay.pendingShivProgress}
        isEndTurnEnemyTarget={drag.isEndTurnEnemyTarget}
        cardDrag={drag.cardDrag}
        cardDragTargetRow={drag.cardDragTargetRow}
        endTurnEffectDrag={drag.endTurnEffectDrag}
        armedEndTurnAbilityId={drag.armedEndTurnAbilityId}
        isStartTurnEnemyTarget={startTurn.isStartTurnEnemyTarget}
        pendingTrigger={items.pendingTrigger}
        triggerHermitChoicesReady={items.triggerHermitChoicesReady}
        triggerSlimeEnemyUids={items.triggerSlimeEnemyUids}
        triggerSlimeEnemyAmount={items.triggerSlimeEnemyAmount}
        isEnemyRowClickTargetable={isEnemyRowClickTargetable}
        isRowLaneClickTargetable={isRowLaneClickTargetable}
        rowLaneClickLabel={rowLaneClickLabel}
        onRowLaneClick={onRowLaneClick}
        pendingPotion={items.pendingPotion}
        pendingPotionNeedsEnemy={items.pendingPotionNeedsEnemy}
        pendingPotionOverflow={items.pendingPotionOverflow}
        pendingPowerNeedsEnemy={items.pendingPowerNeedsEnemy}
        pendingPowerNeedsAlly={items.pendingPowerNeedsAlly}
        pendingPowerDef={items.pendingPowerDef}
        pendingHermitPower={items.pendingHermitPower}
        powerLoadUids={items.powerLoadUids}
        spendingShiv={spendingShiv}
        spendingSoulburn={spendingSoulburn}
        pending={pending}
        slimeEnemyChoicesRequired={cardPlay.slimeEnemyChoicesRequired}
        loadedTargetCount={cardPlay.loadedTargetCount}
        pendingEvokeTarget={cardPlay.pendingEvokeTarget}
        pendingEvokeUsesRows={cardPlay.pendingEvokeUsesRows}
        pendingEvokeTargetUids={cardPlay.pendingEvokeTargetUids}
        enemyChoicesDone={cardPlay.enemyChoicesDone}
        independentEnemyPending={cardPlay.independentEnemyPending}
        independentPlayerPending={cardPlay.independentPlayerPending}
        slayerTargetAllowed={cardPlay.slayerTargetAllowed}
        choiceSatisfied={cardPlay.choiceSatisfied}
        switchChoiceReady={cardPlay.switchChoiceReady}
        onEnemyClick={onEnemyClick}
        onAllyClick={onAllyClick}
        onEndTurnOrbPointerDown={drag.onEndTurnOrbPointerDown}
        onEndTurnEffectPointerMove={drag.onEndTurnEffectPointerMove}
        finishEndTurnEffectDrag={drag.finishEndTurnEffectDrag}
        cancelEndTurnEffectDrag={drag.cancelEndTurnEffectDrag}
        evokePlannedOrbs={evokePlannedOrbs}
        evokeChoiceOptions={evokeChoiceOptions}
        evokeChoicePlayerId={evokeChoicePlayerId}
        creativeAiEffect={items.creativeAiEffect}
        powerOrbSlots={items.powerOrbSlots}
        endTurnEffect={endTurnEffect}
        canResolveEndTurn={canResolveEndTurn}
        chooseStartTurnEvoke={startTurn.chooseStartTurnEvoke}
        onEvokeClick={cardPlay.onEvokeClick}
        chooseCreativeAiOrb={items.chooseCreativeAiOrb}
        endTurnTargetForOrb={drag.endTurnTargetForOrb}
        suppressEndTurnOrbClick={drag.suppressEndTurnOrbClick}
        resolveTurnEffectTarget={resolveTurnEffectTarget}
      />

      <CombatInterruptPanels
        state={state}
        viewer={viewer}
        stanceChangedThisTurn={stanceChangedThisTurn}
        enemyButtonOrder={enemyButtonOrder}
        dieRelicPending={items.dieRelicPending}
        dieRelicAbility={items.dieRelicAbility}
        dieRelicNeedsEnemy={items.dieRelicNeedsEnemy}
        dieRelicCardUids={items.dieRelicCardUids}
        setDieRelicCardUids={items.setDieRelicCardUids}
        dieRelicEnemyUid={items.dieRelicEnemyUid}
        setDieRelicEnemyUid={items.setDieRelicEnemyUid}
        dieRelicTargetUid={items.dieRelicTargetUid}
        usingDieRelic={items.usingDieRelic}
        submitDieRelicChoice={items.submitDieRelicChoice}
        hermitSetupPending={items.hermitSetupPending}
        hermitSetupOwner={items.hermitSetupOwner}
        hermitTargetedCurses={HERMIT_TARGETED_CURSES}
        submitHermitSetup={items.submitHermitSetup}
        playerChoiceDialogRef={items.playerChoiceDialogRef}
        viewerPlayerChoice={items.viewerPlayerChoice}
        playerChoiceDiscarding={items.playerChoiceDiscarding}
        setPlayerChoiceDiscarding={items.setPlayerChoiceDiscarding}
        usingPlayerChoice={items.usingPlayerChoice}
        submitPlayerChoice={items.submitPlayerChoice}
        hermitStrengthPending={items.hermitStrengthPending}
        submitHermitStrength={items.submitHermitStrength}
        slayerChoice={items.slayerChoice}
        slayerChoiceOwner={items.slayerChoiceOwner}
        usingSlayerChoice={items.usingSlayerChoice}
        submitSlayerChoice={items.submitSlayerChoice}
      />

      <HandArea
        state={state}
        viewer={viewer}
        viewerVisual={viewerVisual}
        skinOrb={skinOrb}
        downfallCharacter={downfallCharacter}
        stanceChangedThisTurn={stanceChangedThisTurn}
        drawCount={drawCount}
        drawPileCount={drawPileCount}
        displayedPileCount={motions.displayedPileCount}
        motionActive={motions.motionActive}
        motionBeats={motions.motionBeats}
        chamberTriggerRef={chamber.chamberTriggerRef}
        handScrollRef={chamber.handScrollRef}
        handRef={chamber.handRef}
        chamberOpen={chamber.chamberOpen}
        chamberClosing={chamber.chamberClosing}
        chamberContact={chamber.chamberContact}
        toggleChamber={chamber.toggleChamber}
        requiredHermitChamberCard={chamber.requiredHermitChamberCard}
        requiredChamberCard={chamber.requiredChamberCard}
        requiredChamberUnplayable={chamber.requiredChamberUnplayable}
        skipUnplayableHermitChamber={cardPlay.skipUnplayableHermitChamber}
        visibleHand={chamber.visibleHand}
        visibleChamberUids={chamber.visibleChamberUids}
        hermitSetupPending={items.hermitSetupPending}
        hermitTargetedCurses={HERMIT_TARGETED_CURSES}
        pending={pending}
        setPending={setPending}
        usingCard={usingCard}
        pendingTrigger={items.pendingTrigger}
        endTurnResolving={endTurnResolving}
        voluntaryActionsBlocked={voluntaryActionsBlocked}
        forcedCard={forcedCard}
        forcedCardUid={forcedCardUid}
        distilled={distilled}
        relicScry={relicScry}
        miracleOnCard={miracleOnCard}
        drawnCards={motions.drawnCards}
        cardDrag={drag.cardDrag}
        cardDamage={cardDamage}
        handExhaustChoiceUids={startTurn.handExhaustChoiceUids}
        chosenStartExhaustUids={startTurn.chosenStartExhaustUids}
        pendingStartExhaust={startTurn.pendingStartExhaust}
        suppressCardClick={drag.suppressCardClick}
        chamberCardCanStartDrag={drag.chamberCardCanStartDrag}
        submitHermitChamber={cardPlay.submitHermitChamber}
        chooseStartTurnExhaust={startTurn.chooseStartTurnExhaust}
        submitHermitSetup={items.submitHermitSetup}
        activateCard={drag.activateCard}
        onCardPointerDown={drag.onCardPointerDown}
        onCardPointerMove={drag.onCardPointerMove}
        finishCardDrag={drag.finishCardDrag}
        cancelCardDrag={drag.cancelCardDrag}
      />
      <FloatingOverlays
        viewerCharacter={viewer.character}
        stanceChangedThisTurn={stanceChangedThisTurn}
        slimeCardZoom={slimeCardZoom}
        chamberReturnFlights={chamber.chamberReturnFlights}
        cardDrag={drag.cardDrag}
        cardDragOverlay={drag.cardDragOverlay}
        cardDragArrow={drag.cardDragArrow}
        cardDragArrowShadow={drag.cardDragArrowShadow}
        endTurnEffectDrag={drag.endTurnEffectDrag}
        endTurnEffectDragOverlay={drag.endTurnEffectDragOverlay}
        endTurnEffectDragArrow={drag.endTurnEffectDragArrow}
        endTurnEffectDragArrowShadow={drag.endTurnEffectDragArrowShadow}
        endTurnEffectDragCard={drag.endTurnEffectDragCard}
        endTurnEffectDragRelicId={drag.endTurnEffectDragRelicId}
        endTurnEffectDragSlimeAsset={drag.endTurnEffectDragSlimeAsset}
        cardFlights={motions.cardFlights}
      />
    </div>
  )
}

export const CombatScreen = memo(CombatScreenView)
