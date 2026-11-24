import { useEffect, useMemo, useRef } from 'react'
import type { Dispatch, RefObject, SetStateAction } from 'react'
import { cardDef, faceOf } from '../../game/cards.ts'
import {
  adjacentDamageChoiceCount,
  adjacentEnemies,
  cardDefForTarget,
  cardEnemyChoiceCount,
  cardNeedsChoicePreview,
  cardNeedsEnemy,
  cardPlayConditionMet,
  cardPlayerChoiceCount,
  cardReferencesGuardianMode,
  cardShivChoiceCount,
  chosenEvokeOrbs,
  effectiveCombatCardDef,
  evokeTargetProgress,
  finishCardPlayWindow,
  guardianCardNeedsAlly,
  guardianGemForCard,
  guardianPowerBeamCards,
  lightningRowFromTarget,
  lightningTargetsRows,
  livingEnemies,
  nextEvokeChoice,
  overflowShivCount,
  playCard,
  playCardCopy,
  playCost,
  playHermitChamberCard,
  previewCardChoice,
  previewCardCopyChoice,
  previewCardShivTargets,
  previewHermitChamberCardChoice,
  resolveDeterministicForcedCard,
  scryPlayCardPlayable,
  slimeChoiceIsAvailable,
  slimeCommandEnemyChoiceLabels,
} from '../../game/combat.ts'
import type {
  CardPlayWindow,
  CombatState,
  PendingTriggerAbility,
} from '../../game/combat.ts'
import { chosenDieRelicAbilities, relicDef } from '../../game/relics.ts'
import type { CardInstance, Enemy, Player } from '../../game/types.ts'
import type { ActionOutcome } from '../../multiplayer/useRoomSession.ts'
import { pendingUiSurvivesContext, shouldDisarmCardFlight } from '../board-signals.ts'
import {
  cardShivsOnPlay,
  chargedCardEnergy,
  pendingFor,
  rowsOf,
  stageHermitChamberViewer,
} from './helpers.ts'
import type {
  CombatScreenProps,
  Pending,
  ReconciliationResult,
  UnknownCardAction,
} from './types.ts'
import { useModalDialog } from './useModalDialog.ts'

export function useCardPlay({
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
  clearItemTargets,
  pendingTrigger,
  endTurnResolving,
  forcedCardUid,
  playWindow,
  owesChoice,
}: {
  state: CombatState
  viewer: Player | undefined
  viewerId: string
  drawCount: number | undefined
  onAction?: CombatScreenProps['onAction']
  onChange?: (next: CombatState) => void
  mutationsEnabled: boolean
  cardPreview: CombatScreenProps['cardPreview']
  authoritativeRefresh: number | undefined
  stateRef: RefObject<CombatState>
  refreshRef: RefObject<number | undefined>
  reconciliation: (outcome: ActionOutcome | void) => ReconciliationResult
  armedCardFlight: RefObject<{ card: CardInstance; chamber: boolean } | null>
  pending: Pending | null
  setPending: Dispatch<SetStateAction<Pending | null>>
  miracleOnCard: boolean
  setMiracleOnCard: Dispatch<SetStateAction<boolean>>
  usingCard: boolean
  setUsingCard: Dispatch<SetStateAction<boolean>>
  setSpendingShiv: Dispatch<SetStateAction<boolean>>
  setSpendingSoulburn: Dispatch<SetStateAction<boolean>>
  clearItemTargets: () => void
  pendingTrigger: PendingTriggerAbility | null
  endTurnResolving: boolean
  forcedCardUid: string | null
  playWindow: CardPlayWindow | undefined
  owesChoice: boolean
}) {
  const choiceDialogRef = useRef<HTMLDialogElement | null>(null)
  const cardActionPending = useRef(false)
  const unknownCardAction = useRef<UnknownCardAction | null>(null)
  const forcedAutoAttempt = useRef<string | null>(null)

  const cardPreviewKey = cardPreview
    ? `${cardPreview.cardUid}\0${cardPreview.copy === true}\0${cardPreview.chamber === true}\0${cardPreview.kind}\0${cardPreview.spendMiracle}\0${cardPreview.enemyUid ?? ''}\0${cardPreview.slimeUids?.join('\0') ?? ''}\0${cardPreview.slimeEnemyUids?.join('\0') ?? ''}\0${cardPreview.cards.map((card) => card.uid).join('\0')}`
    : ''

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

  // Unknown delivery with the card still visible stays locked until a causally
  // later REST refresh. Exact inventory evidence can recognize a commit sooner.
  useEffect(() => {
    const current = state.players.find((player) => player.id === viewerId)
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
  }, [authoritativeRefresh, state, viewerId])

  // Drop stale targeting when the phase, seat, or mandatory trigger changes.
  useEffect(() => {
    // Entering copy has its own effect below that replaces the parent card's
    // pending UI. Do not race that replacement with a second clear.
    if (!pendingUiSurvivesContext(state.phase, state.pendingCardCopy?.playerId, viewerId)) setPending(null)
    setMiracleOnCard(false)
    setSpendingShiv(false)
    setSpendingSoulburn(false)
  }, [state.phase, state.pendingCardCopy?.playerId, viewerId, pendingTrigger?.id])

  useEffect(() => {
    if (!endTurnResolving) return
    setPending(null)
    setMiracleOnCard(false)
    setSpendingShiv(false)
    setSpendingSoulburn(false)
  }, [endTurnResolving])

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
  useModalDialog(
    choiceDialogRef,
    Boolean(pending?.choiceCards && !pending.choiceConfirmed && !owesChoice),
    pending?.choiceCards,
  )

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

  // Ordinary costs choose from the visible hand minus the card being played.
  // Post-draw costs choose from the private preview, which already models the
  // hand at the exact clause where the engine will charge it.
  const choicePoolSize = pending?.choiceCards?.length ??
    Math.max(0, (viewer?.hand.length ?? 0) - Number(pending?.cardInHand ?? true))
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
    if (!scryPlayCards || !scryPlayPicked || !viewer) return new Set<string>()
    const judged: CombatState = { ...state, players: state.players.map((player) => player.id === viewer.id
      ? { ...player, hand: player.hand.filter((card) => card.uid !== scryPlaySourceUid),
        cardsPlayedThisTurn: (player.cardsPlayedThisTurn ?? 0) + 1 } : player) }
    return new Set(scryPlayCards.filter((card) => scryPlayCardPlayable(judged, viewer.id, scryPlayCards, card.uid,
      scryPlayPicked.filter((uid) => uid !== card.uid))).map((card) => card.uid))
  }, [state, viewer?.id, scryPlayCards, scryPlayPicked, scryPlaySourceUid])
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
  const selectedSearchType = viewer && selectedSearchDef &&
    !(viewer.guardianMode === null && selectedSearchDef.guardian?.printedType === '???')
    ? effectiveCombatCardDef(selectedSearchDef, viewer.guardianMode).type : undefined
  const pendingEffectiveDef = viewer && pendingDef
    ? effectiveCombatCardDef(pendingDef, pending?.corruptedShardMode ?? viewer.guardianMode)
    : null
  const pendingPowerBeamCards = viewer && pending ? guardianPowerBeamCards(viewer, pending.card.uid) : []
  const pendingPowerBeamChoiceNeeded = Boolean(viewer && pendingDef?.id === 'guardian_power_beam' &&
    (viewer.guardianMode ?? pending?.corruptedShardMode) === 'defense' && pendingPowerBeamCards.length > 0)
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
    if (!viewer) return true
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
  const corruptedShardModeNeeded = Boolean(viewer && pendingDef != null && viewer.character !== 'guardian' &&
    viewer.guardianMode === null && cardReferencesGuardianMode(
      pendingDef, pending ? guardianGemForCard(viewer, pending.card) : undefined,
    ))
  const corruptedShardModeSatisfied = !corruptedShardModeNeeded || pending?.corruptedShardMode !== null
  const energyChoiceSatisfied = (pendingDef?.cost !== 'X' || pending?.energySpent !== null) &&
    (pendingDef?.id !== 'slayer_metamorphosis' || pending?.metamorphosisPowerUid !== undefined)
  const loadedTargetCount = (next: Pending) => !viewer ? 0 : next.picked.filter((uid) => {
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
    if (!viewer) return []
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
    if (!viewer) return []
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
    (!viewer || next.card.defId !== 'guardian_power_beam' ||
      (viewer.guardianMode ?? next.corruptedShardMode) !== 'defense' ||
      guardianPowerBeamCards(viewer, next.card.uid).length === 0 || next.guardianPowerCardUid !== null)
  const choiceSatisfied = handChoiceSatisfied && revealedChoiceSatisfied && variableChoiceSatisfied &&
    (!pending || downfallChoicesReady(pending)) &&
    modeSatisfied && corruptedShardModeSatisfied && energyChoiceSatisfied
  const pendingNeedsCardEnemy = viewer && pendingEffectiveDef
    ? cardNeedsEnemy(pendingEffectiveDef.modes && pending?.mode != null
      ? { ...pendingEffectiveDef, modes: undefined, effects: pendingEffectiveDef.modes[pending.mode]?.effects ?? [] }
      : pendingEffectiveDef, viewer, false, pending?.effectEnergy ?? undefined,
      false, pending?.card.attachedGemId, pending?.card.uid, undefined, pending?.card.hermitDeadOn === true)
    : false
  const pendingEvokeChoice = viewer && pendingDef && pending
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
  const pendingEvokeUsesRows = Boolean(viewer && pending && pendingEvokeTarget >= 0 &&
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

  const pendingShivProgress = useMemo(() => viewer && pending && choiceSatisfied && evokeChoicesDone &&
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
      const previewPending = { ...next, choice: null, choiceCards: null }
      if (enemyUid === null) {
        setPending({ ...previewPending, choicePreviewPending: true })
        return
      }
      stageOrCommit(previewPending)
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

  function onCardClick(
    card: CardInstance,
    draggedEnemyUid: string | null = null,
    draggedPlayerId: string | null = null,
  ) {
    if (cardActionPending.current || endTurnResolving || pendingTrigger) return
    clearItemTargets()
    setSpendingShiv(false)
    setSpendingSoulburn(false)
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
  const copySource = viewer && (pending?.cardInHand !== false || pending?.chamberPlay) && pendingDef?.id !== 'burst'
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

  return {
    choiceDialogRef,
    choicePoolSize,
    variableMinimum,
    choiceNeeded,
    pendingDef,
    scryPlay,
    scryPlayEligible,
    scryPlayRequired,
    pendingSearchKind,
    selectedSearchType,
    pendingEffectiveDef,
    pendingPowerBeamCards,
    pendingPowerBeamChoiceNeeded,
    adjacentPickUids,
    withAdjacentChoices,
    slayerTargetAffordable,
    slayerTargetAllowed,
    handChoiceSatisfied,
    revealedChoiceSatisfied,
    modeSatisfied,
    corruptedShardModeNeeded,
    corruptedShardModeSatisfied,
    loadedTargetCount,
    hermitDieRelicSelectionsReady,
    chamberChoiceRequired,
    chamberReplacementOptions,
    slimeEnemyChoiceLabels,
    slimeEnemyChoicesRequired,
    choiceSatisfied,
    pendingNeedsCardEnemy,
    pendingEvokeChoice,
    pendingEvokeTarget,
    pendingEvokeTargetOptions,
    pendingEvokeTargetUids,
    pendingEvokeUsesRows,
    evokeChoicesDone,
    enemyChoicesDone,
    switchChoiceReady,
    pendingShivProgress,
    spentShivPending,
    normalEnemyPending,
    overflowOnly,
    independentEnemyPending,
    independentHitPending,
    independentPlayerPending,
    copyTarget,
    copyResolutionLabel,
    originalTarget,
    commit,
    stageOrCommit,
    requestChoicePreview,
    requestCopyChoicePreview,
    requestChamberChoicePreview,
    submitHermitChamber,
    skipUnplayableHermitChamber,
    onCardClick,
    finishPlayWindow,
    onChoiceCardClick,
    confirmChoice,
    chooseCardEvokeTarget,
    onEvokeClick,
    onModeClick,
    onCorruptedShardModeClick,
  }
}
