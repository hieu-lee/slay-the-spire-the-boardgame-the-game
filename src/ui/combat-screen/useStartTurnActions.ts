import { useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import {
  defaultStartTurnChoices,
  facingChoicesAreValid,
  lightningRowFromTarget,
  orderStartTurnScries,
  resolveDeterministicForcedCard,
  resolveStartPlayerTurn,
  resolveStartTurnDiscard,
  resolveStartTurnScry,
  startTurnAbilities,
  startTurnChoicePending,
  startTurnDiscardPreview,
  startTurnNeedsChoice,
  startTurnScryAbilities,
  startTurnScryPreview,
} from '../../game/combat.ts'
import type {
  CombatState,
  PendingTriggerAbility,
  StartTurnAbility,
  StartTurnChoice,
  StartTurnScryAbility,
} from '../../game/combat.ts'
import type { CardInstance, Player } from '../../game/types.ts'
import type { CombatScreenProps, PendingStartChoice } from './types.ts'
import { useModalDialog } from './useModalDialog.ts'

const START_TURN_STUCK_MS = 15_000

export function useStartTurnActions({
  state,
  viewer,
  viewerId,
  onAction,
  onChange,
  onResync,
  autoAdvance,
  autoAdvanceRetry,
  authoritativeVersion,
  authoritativeRefresh,
  refreshRef,
  partyStartTurnAbilities,
  partyStartTurnScryAbilities,
  startTurnCoordinatorId,
  startTurnChoiceId,
  startTurnDecidedPlayerIds,
  requiredStartTurnPlayerIds,
  savedStartTurnEnemyTargets,
  serverStartTurnChoices,
  partyStartTurnOrderPending,
  partyStartTurnOrderLocked,
  partyStartTurnScry,
  partyStartTurnDiscard,
  pendingTrigger,
  stagedStartTurnTriggerPending,
  forcedCard,
  dieRelicPending,
  owedChoicesCount,
}: {
  state: CombatState
  viewer: Player | undefined
  viewerId: string
  onAction?: CombatScreenProps['onAction']
  onChange?: (next: CombatState) => void
  onResync?: CombatScreenProps['onResync']
  autoAdvance: boolean
  autoAdvanceRetry: number
  authoritativeVersion: number | undefined
  authoritativeRefresh: number | undefined
  refreshRef: RefObject<number | undefined>
  partyStartTurnAbilities: StartTurnAbility[] | undefined
  partyStartTurnScryAbilities: StartTurnScryAbility[] | undefined
  startTurnCoordinatorId: string | undefined
  startTurnChoiceId: string | undefined
  startTurnDecidedPlayerIds: string[] | undefined
  requiredStartTurnPlayerIds: string[] | undefined
  savedStartTurnEnemyTargets: Record<string, string> | undefined
  serverStartTurnChoices: StartTurnChoice[] | undefined
  partyStartTurnOrderPending: boolean
  partyStartTurnOrderLocked: boolean
  partyStartTurnScry: CombatScreenProps['partyStartTurnScry']
  partyStartTurnDiscard: CombatScreenProps['partyStartTurnDiscard']
  pendingTrigger: PendingTriggerAbility | null
  stagedStartTurnTriggerPending: boolean
  forcedCard: NonNullable<CombatState['startTurnProgress']>['forcedCard']
  dieRelicPending: NonNullable<CombatState['pendingDieRelicChoices']>[number] | undefined
  owedChoicesCount: number
}) {
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
  const [startTurnStuck, setStartTurnStuck] = useState(false)
  const [resyncing, setResyncing] = useState(false)
  const startTurnScryDialogRef = useRef<HTMLDialogElement | null>(null)
  const startTurnDiscardDialogRef = useRef<HTMLDialogElement | null>(null)

  // A paused start of turn (Magnetism's owed choice) keeps the picks already made for the abilities
  // still to resolve in `startTurnProgress.choices`; the room's staged picks win, so a resumed
  // plan neither asks for them again nor loses them (solo has no staged picks at all).
  const resumedStartChoices = state.phase === 'start' && !state.startTurnProgress?.forcedCard
    ? state.startTurnProgress?.choices : undefined
  const savedStartTurnChoices = resumedStartChoices?.length
    ? [...(serverStartTurnChoices ?? []), ...resumedStartChoices.filter((choice) =>
      !serverStartTurnChoices?.some((saved) => saved.id === choice.id))]
    : serverStartTurnChoices

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

  useEffect(() => {
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
  const viewerStartTurnDecided = Boolean(onAction && startTurnDecidedPlayerIds?.includes(viewerId))
  const canResolveStartTurn = !onAction || Boolean(!viewerStartTurnDecided &&
    requiredStartTurnPlayerIds?.includes(viewerId) &&
    (viewerId === startTurnCoordinatorId || viewerId !== fumesOwnerId))
  const canCommitStartTurnOrder = canResolveStartTurn &&
    (!partyStartTurnOrderPending || viewerId === startTurnCoordinatorId)
  const startTurnCoordinator = state.players.find((player) => player.id === startTurnCoordinatorId &&
    player.id !== viewerId)
  const startTurnCount = startTurnDecidedPlayerIds && requiredStartTurnPlayerIds?.length
    ? `${startTurnDecidedPlayerIds.filter((id) => requiredStartTurnPlayerIds.includes(id)).length}/${requiredStartTurnPlayerIds.length}`
    : null
  const orderTargetIndex = startTurnChoiceId
    ? orderedStartAbilities.findIndex((ability) => ability.id === startTurnChoiceId)
    : -1
  const ownedStartAbilities = onAction
    ? orderedStartAbilities.filter((ability) => ability.playerId === viewerId)
    : orderedStartAbilities
  const startChoiceAbilities = partyStartTurnOrderPending && viewerId === startTurnCoordinatorId
    ? orderedStartAbilities.slice(0, orderTargetIndex < 0 ? orderedStartAbilities.length : orderTargetIndex)
      .filter((ability) => !onAction || ability.playerId === viewerId)
    : ownedStartAbilities.filter((ability) => !startTurnChoiceId || viewerId !== fumesOwnerId ||
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
      if (ability.playerId === viewerId && ability.exhaustCards && !ability.exhaustCards.some((card) =>
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
    ability.playerId !== viewerId && ability.exhaustCards &&
    !ability.exhaustCards.some((card) => card.uid === startTurnExhaustUids[ability.id])) : undefined
  // Once every choice is made (and not yet sent), the hand keeps offering the
  // latest Exhaust picked from it, so tapping another card changes the pick.
  const handStartExhaust = pendingStartExhaust ?? (canResolveStartTurn && !pendingStartChoice &&
    !sendingStartTurn
    ? [...startChoiceAbilities].reverse().find((ability) => ability.playerId === viewerId &&
      (ability.exhaustCards?.length ?? 0) > 1 &&
      ability.exhaustCards!.some((card) => card.uid === startTurnExhaustUids[ability.id] &&
        Boolean(viewer?.hand.some((held) => held.uid === card.uid))))
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

  function startEnemyChoiceAvailable(enemyUid: string) {
    if (!pendingStartEnemy?.targets?.some((target) => target.uid === enemyUid)) return false
    if (!pendingStartEnemy.id.startsWith('facing:')) return true
    return facingChoicesAreValid(state, startChoiceDrafts.map((choice) => {
      const saved = savedStartTurnChoices?.find((candidate) => candidate.id === choice.id)
      return choice.id === pendingStartEnemy.id ? { ...choice, enemyUid }
        : saved?.enemyUid ? { ...choice, enemyUid: saved.enemyUid } : choice
    }))
  }

  const isStartTurnEnemyTarget = (enemyUid: string) =>
    Boolean(pendingStartEnemy?.targets?.some((target) => target.uid === enemyUid) &&
      startEnemyChoiceAvailable(enemyUid)) ||
    Boolean(pendingStartShiv && (!pendingStartShiv.ability.shivTargets ||
      pendingStartShiv.ability.shivTargets.some((target) => target.uid === enemyUid))) ||
    Boolean(pendingStartEvokeTarget?.ability.evokeTargets?.some((target) => target.uid === enemyUid))

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

  // The Hermit setup Load pauses the Draw step; start-of-turn order comes after it.
  const startTurnOpen = state.phase === 'start' && !forcedCard && !pendingTrigger &&
    (state.pendingHermitSetupLoads?.length ?? 0) === 0 &&
    // Slayer Pack: Magnetism's answer resumes the order by itself.
    owedChoicesCount === 0
  const startTurnChoicesOpen = startTurnOpen && !stagedStartTurnTriggerPending && !activeStartTurnScry &&
    orderedStartTurnScries.length === 0
  const visibleStartModeShift = startTurnChoicesOpen ? pendingStartModeShift : undefined
  // A required seat whose Resolve button is disabled or missing, with
  // no private prompt to answer, has no way forward. Another seat may just be
  // slow, so this only offers a manual re-sync after a long pause.
  const startTurnLooksStuck = Boolean(onAction && onResync && startTurnChoicesOpen &&
    requiredStartTurnPlayerIds?.includes(viewerId) && !activeStartTurnDiscard &&
    !dieRelicPending && !visibleStartModeShift && (resolvingStartTurnMode || !canResolveStartTurn))

  useEffect(() => {
    setStartTurnStuck(false)
    if (!startTurnLooksStuck) return undefined
    const timer = window.setTimeout(() => setStartTurnStuck(true), START_TURN_STUCK_MS)
    return () => window.clearTimeout(timer)
  }, [startTurnLooksStuck, authoritativeVersion])

  const handExhaustChoiceUids = new Set(startTurnChoicesOpen
    ? handStartExhaust?.exhaustCards?.filter((card) => Boolean(viewer?.hand.some((held) => held.uid === card.uid)) &&
      card.uid !== startTurnExhaustUids[handStartExhaust.id]).map((card) => card.uid)
    : [])
  // Only picks the current plan still honours; a reorder can take a chosen card out of a step's reach.
  const chosenStartExhaustUids = new Set(startTurnChoicesOpen
    ? orderedStartAbilities.flatMap((ability) => ability.exhaustCards
      ?.filter((card) => card.uid === startTurnExhaustUids[ability.id]).map((card) => card.uid) ?? [])
    : [])

  return {
    startTurnScryDialogRef,
    startTurnDiscardDialogRef,
    startTurnEnemyTargets,
    setStartTurnEnemyTargets,
    startTurnPlayerTargets,
    setStartTurnPlayerTargets,
    startTurnExhaustUids,
    setStartTurnExhaustUids,
    startTurnModeShifts,
    setStartTurnModeShifts,
    resolvingStartTurnMode,
    startTurnTargets,
    setStartTurnTargets,
    startTurnEvokeSlots,
    setStartTurnEvokeSlots,
    startTurnEvokeTargets,
    setStartTurnEvokeTargets,
    startTurnScryPicked,
    resolvingStartTurnScry,
    sendingStartTurn,
    startTurnStuck,
    resyncing,
    setResyncing,
    activeStartTurnScry,
    activeStartTurnDiscard,
    orderedStartTurnScries,
    canOrderStartTurnScries,
    orderedStartAbilities,
    fumesOwnerId,
    viewerStartTurnDecided,
    canResolveStartTurn,
    canCommitStartTurnOrder,
    startTurnCoordinator,
    startTurnCount,
    pendingStartEnemy,
    pendingStartPlayer,
    pendingStartEvoke,
    startTurnEffectSource,
    startTurnEffectDraggable,
    startTurnEffectCard,
    startTurnEffectRelicId,
    pendingStartExhaust,
    teammateStartExhaust,
    pendingStartModeShift,
    pendingStartShiv,
    pendingStartEvokeTarget,
    pendingStartEvokeRows,
    startTurnReady,
    isStartTurnEnemyTarget,
    startTurnOpen,
    startTurnChoicesOpen,
    visibleStartModeShift,
    handExhaustChoiceUids,
    chosenStartExhaustUids,
    startEnemyChoiceAvailable,
    finishStartTurnDiscard,
    moveStartTurnAbility,
    chooseStartTurnEnemy,
    chooseStartTurnPlayer,
    chooseStartTurnExhaust,
    chooseStartTurnMode,
    chooseStartTurnShiv,
    chooseStartTurnEvoke,
    chooseStartTurnEvokeEnemy,
    startTurnOrderHint,
    moveStartTurnScry,
    finishStartTurnScryOrder,
    chooseStartTurnScryCard,
    finishStartTurnScry,
    finishStartTurn,
  }
}
