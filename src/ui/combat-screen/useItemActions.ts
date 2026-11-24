import { useEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch, RefObject, SetStateAction } from 'react'
import { cardDef, faceOf } from '../../game/cards.ts'
import {
  activatePotion,
  activatePower,
  activateRelic,
  activePowerWindow,
  canActivatePotion,
  canActivateRelic,
  cardNeedsEnemy,
  guardianCardNeedsAlly,
  isPostRollStartTurnPotionChoice,
  isPostRollStartTurnRelicChoice,
  lapseStrandedPlayerChoices,
  livingEnemies,
  overflowShivCount,
  owedPlayerChoices,
  pendingTriggerAbility,
  pendingTriggerSlimeEnemyChoiceLabels,
  powerAbilityKey,
  powerAbilityUsed,
  previewPowerChoice,
  reachesEnemy,
  resolveHermitSetupLoad,
  resolveHermitStrengthReward,
  resolvePendingDieRelicChoice,
  resolvePendingPlayerChoice,
  resolvePendingTrigger,
  resolvePlunderRowSwitch,
  resolveSlayerChoice,
} from '../../game/combat.ts'
import type {
  CombatState,
  PlayerChoiceAnswer,
  PotionContext,
  PowerContext,
  RelicContext,
  StartTurnChoice,
} from '../../game/combat.ts'
import { chosenDieRelicAbilities, potionDef, relicDef } from '../../game/relics.ts'
import type { CardInstance, Player } from '../../game/types.ts'
import type { ActionOutcome, VisiblePlayer } from '../../multiplayer/useRoomSession.ts'
import { gainedShivs } from './helpers.ts'
import type {
  CombatScreenProps,
  Pending,
  ReconciliationResult,
  UnknownPotionAction,
  UnknownPowerAction,
} from './types.ts'
import { unknownPowerRefreshDecision } from './unknown-power.ts'
import { useModalDialog } from './useModalDialog.ts'

export const HERMIT_TARGETED_CURSES = new Set(['hermit_grudge', 'hermit_malice', 'hermit_horror'])

function stringListKey(list: readonly string[] | undefined): string {
  if (list === undefined) return '-'
  return `+${list.join('\x1d')}`
}

export function stagedTriggerChoiceKey(choice: StartTurnChoice['trigger'] | undefined): string {
  if (!choice) return ''
  return `${choice.enemyRow ?? ''}\x1f${choice.enemyUid ?? ''}\x1f${choice.targetPlayerId ?? ''}\x1f${stringListKey(choice.loadUids)}\x1f${stringListKey(choice.chamberUids)}\x1f${stringListKey(choice.hermitEnemyUids)}\x1f${stringListKey(choice.slimeUids)}\x1f${stringListKey(choice.slimeEnemyUids)}`
}

export function useItemActions({
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
}: {
  state: CombatState
  viewer: Player | undefined
  viewerId: string
  onAction?: CombatScreenProps['onAction']
  onChange?: (next: CombatState) => void
  stateRef: RefObject<CombatState>
  refreshRef: RefObject<number | undefined>
  reconciliation: (outcome: ActionOutcome | void) => ReconciliationResult
  authoritativePendingTrigger: CombatScreenProps['authoritativePendingTrigger']
  stagedStartTurnTriggers: CombatScreenProps['stagedStartTurnTriggers']
  serverStartTurnChoices: CombatScreenProps['savedStartTurnChoices']
  powerPreview: CombatScreenProps['powerPreview']
  partyStartTurnPostRollLocked: boolean
  authoritativeRefresh: number | undefined
  endTurnResolving: boolean
  forcedCard: NonNullable<CombatState['startTurnProgress']>['forcedCard']
  distilled: CombatState['pendingDistilled']
  relicScry: CombatState['pendingRelicScry']
  setPending: Dispatch<SetStateAction<Pending | null>>
  setMiracleOnCard: Dispatch<SetStateAction<boolean>>
  setSpendingShiv: Dispatch<SetStateAction<boolean>>
}) {
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
  const [triggerHermitLoadUids, setTriggerHermitLoadUids] = useState<string[]>([])
  const [triggerHermitChamberUids, setTriggerHermitChamberUids] = useState<string[]>([])
  // `cards` shows the card-face dialog; `board` hides it so the player can read the
  // board; `target` means the cards are settled and an enemy/row/player click remains.
  const [triggerHermitStep, setTriggerHermitStep] = useState<'cards' | 'board' | 'target'>('cards')
  const triggerHermitReopenRef = useRef<HTMLButtonElement | null>(null)
  const [triggerSlimeUids, setTriggerSlimeUids] = useState<string[]>([])
  const [triggerSlimeEnemyUids, setTriggerSlimeEnemyUids] = useState<string[]>([])
  const itemDialogRef = useRef<HTMLDialogElement | null>(null)
  const potionActionPending = useRef(false)
  const powerActionPending = useRef(false)
  const relicActionPending = useRef(false)
  const unknownPotionAction = useRef<UnknownPotionAction | null>(null)
  const unknownPowerAction = useRef<UnknownPowerAction | null>(null)

  // The dialog unmounts rather than closing, so the browser has nowhere to return focus.
  useEffect(() => {
    if (triggerHermitStep !== 'cards') triggerHermitReopenRef.current?.focus({ preventScroll: true })
  }, [triggerHermitStep])

  const canUsePotionNow = (potionId: string) => Boolean(viewer &&
    canActivatePotion(state, viewer, potionId) && !(partyStartTurnPostRollLocked &&
      isPostRollStartTurnPotionChoice(state, viewer, potionId)))
  const canUseRelicNow = (relicIndex: number) => Boolean(viewer &&
    canActivateRelic(state, viewer, relicIndex) && !(partyStartTurnPostRollLocked &&
      isPostRollStartTurnRelicChoice(state, viewer, relicIndex)))

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
      const pendingChoices = outcome?.snapshot?.run?.combat?.pendingDieRelicChoices
      if (!pendingChoices || pendingChoices.some((choice) => choice.id === choiceId)) return
      setDieRelicCardUids([])
      setDieRelicEnemyUid(null)
    }).finally(() => setUsingDieRelic(false))
  }

  function submitPlunderRow(row: number | null) {
    if (state.pendingPlunderSwitches?.[0]?.playerId !== viewerId) return
    if (onAction) void onAction({ kind: 'resolvePlunderRowSwitch', row })
    else onChange?.(resolvePlunderRowSwitch(state, viewerId, row))
  }

  const viewerHasSozu = viewer?.relics.some((relic) => relic.defId === 'sozu') ?? false
  const extraCrispyPower = viewer?.powers.find((power) => power.defId === 'extra_crispy' &&
    !powerAbilityUsed(state, viewerId, power.uid))
  const pendingTrigger = dieRelicPending ? null
    : authoritativePendingTrigger !== undefined
      ? authoritativePendingTrigger ?? stagedStartTurnTriggers
        ?.find((trigger) => trigger.id === editingStagedStartTurnTrigger) ?? null
      : pendingTriggerAbility(state) ?? null
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
    triggerHermitLoadUids.includes(card.uid) && HERMIT_TARGETED_CURSES.has(card.defId))
  const triggerHermitNeedsBoard = Boolean(pendingTrigger?.rows || pendingTrigger?.players ||
    pendingTrigger?.targets && (!pendingTrigger.targetsOnlyForLoadedCurse || triggerHermitCurse))
  const pendingPlunder = state.pendingPlunderSwitches?.[0]

  const editingStagedTrigger = stagedStartTurnTriggers?.find((trigger) => trigger.id === editingStagedStartTurnTrigger)
  const editingStagedChoice = editingStagedTrigger
    ? serverStartTurnChoices?.find((choice) => choice.id === editingStagedTrigger.choiceId)?.trigger
    : undefined
  // Online snapshots rebuild these arrays on every publish; key on their content so
  // an unrelated room update does not wipe picks the player is still making.
  const editingStagedChoiceRef = useRef(editingStagedChoice)
  editingStagedChoiceRef.current = editingStagedChoice
  const editingStagedChoiceKey = stagedTriggerChoiceKey(editingStagedChoice)
  useEffect(() => {
    const staged = editingStagedChoiceRef.current
    setTriggerHermitLoadUids(staged?.loadUids ? [...staged.loadUids] : [])
    setTriggerHermitChamberUids(staged?.chamberUids ? [...staged.chamberUids] : [])
    setTriggerHermitStep('cards')
    setTriggerSlimeUids(staged?.slimeUids ? [...staged.slimeUids] : [])
    setTriggerSlimeEnemyUids(staged?.slimeEnemyUids ? [...staged.slimeEnemyUids] : [])
  }, [pendingTrigger?.id, editingStagedStartTurnTrigger, editingStagedChoiceKey])

  useEffect(() => {
    setDieRelicCardUids([])
    setDieRelicEnemyUid(null)
  }, [dieRelicPending?.id])

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
    setPendingPotion(null)
    setPendingPowerUid(null)
    setPotionShivEnemyUids([])
    setPotionOverflowRequired(0)
  }, [state.phase, state.pendingCardCopy?.playerId, viewerId, pendingTrigger?.id])

  useEffect(() => {
    if (!endTurnResolving) return
    setPendingPotion(null)
    setPendingPowerUid(null)
    setPotionShivEnemyUids([])
    setPotionOverflowRequired(0)
  }, [endTurnResolving])

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

  const owesChoice = Boolean(viewerPlayerChoice) ||
    (slayerChoice?.playerId === viewerId && state.phase !== 'lost')

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

  useEffect(() => {
    if (onAction) return
    potionActionPending.current = false
    setUsingPotion(false)
  }, [onAction, state])

  const livingPlayers = useMemo(() => state.players.filter((player) => !player.dead), [state.players])
  const pendingPotionDef = pendingPotion ? potionDef(pendingPotion) : null
  const pendingPotionNeedsEnemy = pendingPotionDef?.target === 'enemy' ||
    pendingPotion === 'mystery_potion' && state.die <= 2
  const pendingPotionNeedsCards = ['liquid_memories', 'liquid_void', 'transforming_brew', 'purity_potion'].includes(pendingPotion ?? '')
  const pendingPower = viewer && pendingPowerUid
    ? viewer.powers.find((power) => power.uid === pendingPowerUid)
    : undefined
  const pendingPowerDef = pendingPower ? faceOf(cardDef(pendingPower.defId), pendingPower.upgraded) : null
  const pendingHermitPower = pendingPowerDef?.id === 'hermit_shadow_cloak' || pendingPowerDef?.id === 'hermit_black_wind'
  // Slayer Pack: Creative AI is chosen on the Orbs themselves.
  const creativeAiEffect = pendingPowerDef?.effects.find((effect) => effect.kind === 'removeOrbsForDiscardTop')
  const pendingPowerNeedsEnemy = Boolean(viewer && pendingPower && pendingPowerDef &&
    cardNeedsEnemy(pendingPowerDef, viewer, true, undefined, true, pendingPower.attachedGemId))
  const pendingPowerNeedsAlly = Boolean(viewer && pendingPower && pendingPowerDef &&
    guardianCardNeedsAlly(pendingPowerDef, viewer, pendingPower.attachedGemId) && livingPlayers.length > 1)
  const pendingPowerNeedsGemChoice = Boolean(pendingPower?.attachedGemId && (
    pendingPowerNeedsEnemy || pendingPowerNeedsAlly || pendingPowerDef?.target === 'row' ||
    pendingPower.attachedGemId === 'guardian_jasper' || pendingPower.attachedGemId === 'guardian_amethyst'
  ))
  const pendingPotionOverflow = potionOverflowRequired

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

  function clearItemTargets() {
    setPendingPowerUid(null)
    setPendingPotion(null)
    setPotionShivEnemyUids([])
    setPotionOverflowRequired(0)
  }

  return {
    pendingPotion,
    setPendingPotion,
    pendingPowerUid,
    setPendingPowerUid,
    powerChamberUids,
    setPowerChamberUids,
    powerLoadUids,
    setPowerLoadUids,
    powerChoiceCards,
    powerScryDiscardUids,
    setPowerScryDiscardUids,
    powerExhaustUids,
    setPowerExhaustUids,
    powerOrbSlots,
    setPowerOrbSlots,
    usingPlayerChoice,
    usingSlayerChoice,
    playerChoiceDiscarding,
    setPlayerChoiceDiscarding,
    playerChoiceDialogRef,
    setPowerGemContext,
    powerScryConfirmed,
    setPowerScryConfirmed,
    potionShivEnemyUids,
    setPotionShivEnemyUids,
    setPotionOverflowRequired,
    potionCardUids,
    setPotionCardUids,
    relicCardUids,
    setRelicCardUids,
    dieRelicCardUids,
    setDieRelicCardUids,
    dieRelicEnemyUid,
    setDieRelicEnemyUid,
    relicShivEnemyUids,
    setRelicShivEnemyUids,
    relicActionPending,
    usingPotion,
    usingPower,
    usingTrigger,
    setEditingStagedStartTurnTrigger,
    usingDieRelic,
    triggerHermitLoadUids,
    setTriggerHermitLoadUids,
    triggerHermitChamberUids,
    setTriggerHermitChamberUids,
    triggerHermitStep,
    setTriggerHermitStep,
    triggerHermitReopenRef,
    triggerSlimeUids,
    setTriggerSlimeUids,
    triggerSlimeEnemyUids,
    setTriggerSlimeEnemyUids,
    itemDialogRef,
    canUsePotionNow,
    canUseRelicNow,
    hermitSetupPending,
    hermitSetupOwner,
    hermitStrengthPending,
    owedChoices,
    viewerPlayerChoice,
    dieRelicPending,
    dieRelicAbility,
    dieRelicNeedsEnemy,
    dieRelicTargetUid,
    slayerChoice,
    slayerChoiceOwner,
    viewerHasSozu,
    extraCrispyPower,
    pendingTrigger,
    stagedStartTurnTriggerPending,
    triggerHermitChoicesReady,
    triggerSlimeChoicesReady,
    triggerSlimeEnemyLabels,
    triggerSlimeEnemyAmount,
    triggerHermitCurse,
    triggerHermitNeedsBoard,
    pendingPlunder,
    owesChoice,
    visibleDistilled,
    gemFinderScryOpen,
    livingPlayers,
    pendingPotionDef,
    pendingPotionNeedsEnemy,
    pendingPotionNeedsCards,
    pendingPower,
    pendingPowerDef,
    pendingHermitPower,
    creativeAiEffect,
    pendingPowerNeedsEnemy,
    pendingPowerNeedsAlly,
    pendingPotionOverflow,
    submitHermitSetup,
    submitPlayerChoice,
    submitHermitStrength,
    submitSlayerChoice,
    submitDieRelicChoice,
    submitPlunderRow,
    consumePotion,
    cancelPotionChoice,
    useRelic,
    usePower,
    chooseCreativeAiOrb,
    choosePowerContext,
    confirmPowerScry,
    requestPowerPreview,
    resolveTrigger,
    confirmTriggerHermitChoices,
    clearItemTargets,
  }
}
