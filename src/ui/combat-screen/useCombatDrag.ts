import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { assetPath } from '../../game/assets.ts'
import {
  lightningRowFromTarget,
  lightningRowTarget,
  type CombatState,
  type EndTurnAbility,
  type PendingTriggerAbility,
  type StartTurnAbility,
} from '../../game/combat.ts'
import type { CardInstance, Enemy, OrbType, Player } from '../../game/types.ts'
import { canAfford, pendingFor, stageHermitChamberViewer } from './helpers.ts'
import { slimeAssetSlug } from './portraits.tsx'
import type { CardDrag, CardDragStart, EndTurnEffectDrag, Pending } from './types.ts'

export function dragArrowPath(
  startX: number,
  startY: number,
  startYOffset: number,
  x: number,
  y: number,
): string {
  return `M ${startX} ${startY + startYOffset} Q ${startX} ${y} ${x} ${y}`
}

function updateDragArrow(
  arrow: SVGPathElement | null,
  shadow: SVGPathElement | null,
  startX: number,
  startY: number,
  startYOffset: number,
  x: number,
  y: number,
) {
  const path = dragArrowPath(startX, startY, startYOffset, x, y)
  arrow?.setAttribute('d', path)
  shadow?.setAttribute('d', path)
}

function armClickSuppression(ref: { current: string | null }, id: string) {
  ref.current = id
  setTimeout(() => {
    if (ref.current === id) ref.current = null
  }, 0)
}

export type UseCombatDragOptions = {
  state: CombatState
  viewer: Player
  viewerId: string
  drawCount: number | undefined
  authoritativeRestoration: number | undefined
  authoritativeConnected: boolean | undefined
  usingCard: boolean
  pending: Pending | null
  pendingTrigger: PendingTriggerAbility | null | undefined
  endTurnResolving: boolean
  forcedCard: CombatState['startTurnProgress'] extends infer P
    ? P extends { forcedCard?: infer F } ? F : undefined
    : undefined
  distilled: CombatState['pendingDistilled']
  relicScry: CombatState['pendingRelicScry']
  miracleOnCard: boolean
  voluntaryActionsBlocked: boolean
  endTurnEffect: EndTurnAbility | undefined
  canResolveEndTurn: boolean
  canResolveStartTurn: boolean
  startTurnEffectDraggable: boolean
  startTurnEffectSource: StartTurnAbility | undefined
  evokeTargetSource: EndTurnAbility | undefined
  evokeTargetOrb: OrbType | undefined
  evokeTargetStep: string | null
  pendingStartEnemy: StartTurnAbility | undefined
  startEnemyChoiceAvailable: (enemyUid: string) => boolean
  onResolveTurnEffectTarget: (abilityId: string, targetUid: string) => void
  onCardClick: (card: CardInstance, targetUid?: string | null, targetPlayerId?: string | null) => void
  onHermitChamberPlay: (card: CardInstance, targetUid?: string | null, targetPlayerId?: string | null) => void
}

export function useCombatDrag({
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
  onResolveTurnEffectTarget,
  onCardClick,
  onHermitChamberPlay,
}: UseCombatDragOptions) {
  const [cardDrag, setCardDrag] = useState<CardDrag | null>(null)
  const [endTurnEffectDrag, setEndTurnEffectDrag] = useState<EndTurnEffectDrag | null>(null)
  const [armedEndTurnAbilityId, setArmedEndTurnAbilityId] = useState<string | null>(null)

  const cardDragStart = useRef<CardDragStart | null>(null)
  const cardDragLive = useRef<CardDrag | null>(null)
  const cardDragFrame = useRef<number | null>(null)
  const cardDragMove = useRef<{ x: number; y: number } | null>(null)
  const cardDragOverlay = useRef<HTMLDivElement | null>(null)
  const cardDragArrow = useRef<SVGPathElement | null>(null)
  const cardDragArrowShadow = useRef<SVGPathElement | null>(null)
  const suppressCardClick = useRef<string | null>(null)

  const endTurnEffectDragStart = useRef<EndTurnEffectDrag | null>(null)
  const endTurnEffectDragLive = useRef<EndTurnEffectDrag | null>(null)
  const endTurnEffectDragFrame = useRef<number | null>(null)
  const endTurnEffectDragMove = useRef<{ x: number; y: number } | null>(null)
  const endTurnEffectDragOverlay = useRef<HTMLDivElement | null>(null)
  const endTurnEffectDragArrow = useRef<SVGPathElement | null>(null)
  const endTurnEffectDragArrowShadow = useRef<SVGPathElement | null>(null)
  const suppressEndTurnEffectClick = useRef<string | null>(null)
  const suppressEndTurnOrbClick = useRef<string | null>(null)

  const dragRestoration = useRef(authoritativeRestoration)
  const dragConnected = useRef(authoritativeConnected)
  const dragViewer = useRef(viewerId)

  const endTurnEffectAimed = endTurnEffect !== undefined &&
    (armedEndTurnAbilityId === endTurnEffect.id || endTurnEffectDrag?.ability.id === endTurnEffect.id)
  const endTurnEffectDragVisual = endTurnEffectDrag?.ability.visual
  const endTurnEffectDragCard = !endTurnEffectDrag?.sourceOrb && endTurnEffectDragVisual?.kind === 'card' && endTurnEffectDrag
    ? state.players.find((player) => player.id === endTurnEffectDrag.ability.playerId)
      ?.powers.find((power) => power.uid === endTurnEffectDragVisual.cardUid)
    : undefined
  const endTurnEffectDragSlimeAsset = !endTurnEffectDrag?.sourceOrb && endTurnEffectDragVisual?.kind === 'slime'
    ? assetPath(`combat/slimes/${slimeAssetSlug(endTurnEffectDragVisual.cardId)}.webp`)
    : undefined
  const endTurnEffectDragRelicId = !endTurnEffectDrag?.sourceOrb && endTurnEffectDragVisual?.kind === 'relic'
    ? endTurnEffectDragVisual.relicId
    : undefined

  const draggedEnemy = cardDrag?.targetUid
    ? state.enemies.find((enemy) => enemy.uid === cardDrag.targetUid)
    : undefined
  const cardDragTargetRow = cardDrag?.hitsRow ? draggedEnemy?.row : undefined

  useEffect(() => {
    setArmedEndTurnAbilityId(null)
  }, [endTurnEffect?.id])

  useEffect(() => {
    if (state.phase !== 'player') setArmedEndTurnAbilityId(null)
  }, [state.phase])

  useEffect(() => {
    setArmedEndTurnAbilityId((current) => current === 'evoke-target' ? null : current)
  }, [evokeTargetStep])

  useEffect(() => () => {
    if (cardDragFrame.current !== null) cancelAnimationFrame(cardDragFrame.current)
    if (endTurnEffectDragFrame.current !== null) cancelAnimationFrame(endTurnEffectDragFrame.current)
  }, [])

  function clearCardDrag() {
    cardDragStart.current = null
    cardDragLive.current = null
    cardDragMove.current = null
    if (cardDragFrame.current !== null) cancelAnimationFrame(cardDragFrame.current)
    cardDragFrame.current = null
    setCardDrag(null)
  }

  function clearEndTurnEffectDrag() {
    endTurnEffectDragStart.current = null
    endTurnEffectDragLive.current = null
    endTurnEffectDragMove.current = null
    if (endTurnEffectDragFrame.current !== null) cancelAnimationFrame(endTurnEffectDragFrame.current)
    endTurnEffectDragFrame.current = null
    setEndTurnEffectDrag(null)
  }

  function cardCanStartDrag(card: CardInstance) {
    return !usingCard && !pending && !pendingTrigger && !endTurnResolving && state.phase === 'player' &&
      !forcedCard && !distilled && !relicScry && canAfford(state, viewer, card, miracleOnCard, drawCount)
  }

  function chamberCardCanStartDrag(card: CardInstance) {
    const required = state.pendingHermitChamberPlays?.[0]
    const staged = stageHermitChamberViewer(viewer, card,
      required?.playerId === viewerId && required.cardUids[0] === card.uid && required.free)
    return !usingCard && !pending && !pendingTrigger && !endTurnResolving && !forcedCard &&
      state.phase === 'player' && (required?.cardUids[0] === card.uid || !voluntaryActionsBlocked) &&
      canAfford(state, staged.player, staged.card)
  }

  useLayoutEffect(() => {
    const restored = (authoritativeRestoration !== undefined &&
      authoritativeRestoration !== dragRestoration.current) ||
      authoritativeConnected === false || dragConnected.current === false || dragViewer.current !== viewerId
    dragRestoration.current = authoritativeRestoration
    dragConnected.current = authoritativeConnected
    dragViewer.current = viewerId
    const activeDrag = cardDragStart.current
    const draggedCards = activeDrag?.chamber ? viewer.chamber : viewer.hand
    if (activeDrag && (restored || !draggedCards.some((card) => card.uid === activeDrag.card.uid) ||
      !(activeDrag.chamber ? chamberCardCanStartDrag(activeDrag.card) : cardCanStartDrag(activeDrag.card)))) {
      clearCardDrag()
    }
  }, [authoritativeConnected, authoritativeRestoration, viewerId, viewer, state, usingCard,
    pending, pendingTrigger, endTurnResolving, forcedCard, distilled, relicScry,
    miracleOnCard, drawCount, voluntaryActionsBlocked])

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

  function endTurnTargetForEnemy(enemy: Enemy, ability: EndTurnEffectDrag['ability'] | undefined = endTurnEffect): string | null {
    if (ability && 'orbChoice' in ability && ability.orbChoice) return null
    const direct = ability?.targets?.find((target) =>
      target.uid === enemy.uid || target.uid.endsWith(`:${enemy.uid}`))?.uid
    if (direct || enemy.isBoss) return direct ?? null
    return ability?.targets?.find((target) =>
      target.uid === lightningRowTarget(enemy.row) || target.uid.endsWith(`:${lightningRowTarget(enemy.row)}`))?.uid ?? null
  }

  function endTurnTargetForRow(row: number, ability: EndTurnEffectDrag['ability'] | undefined = endTurnEffect): string | null {
    return ability?.targets?.find((target) =>
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
    if (active.ability.id === pendingStartEnemy?.id) {
      const enemyUid = dragTargetAt(x, y, false)
      return enemyUid && startEnemyChoiceAvailable(enemyUid) ? enemyUid : null
    }
    if ('players' in active.ability && active.ability.players) {
      const playerId = dragPlayerAt(x, y)
      return active.ability.players.some((player) => player.id === playerId) ? playerId : null
    }
    const enemyUid = dragTargetAt(x, y, false)
    const enemy = enemyUid ? state.enemies.find((candidate) => candidate.uid === enemyUid) : undefined
    if (enemy) return endTurnTargetForEnemy(enemy, active.ability)
    const row = Number(document.elementFromPoint(x, y)?.closest<HTMLElement>('.row__enemies--targetable')?.dataset.row)
    return Number.isInteger(row) ? endTurnTargetForRow(row, active.ability) : null
  }

  function endTurnEffectCanStartDrag(abilityId: string) {
    return !pendingTrigger && !endTurnEffectDrag && (
      canResolveEndTurn && endTurnEffect?.id === abilityId ||
      canResolveStartTurn && startTurnEffectDraggable && startTurnEffectSource?.id === abilityId ||
      evokeTargetSource?.id === abilityId
    )
  }

  function isEndTurnEnemyTarget(enemy: Enemy): boolean {
    if (endTurnTargetForEnemy(enemy) !== null) return endTurnEffectAimed
    // A row hit also hits the boss, so light it while a row lies under a dragged effect or Evoke aim.
    const hovered = endTurnEffectDrag?.targetUid
    return enemy.isBoss && !enemy.dead && typeof hovered === 'string' &&
      lightningRowFromTarget(hovered.split(':').slice(-2).join(':')) !== null
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

  function onEndTurnEffectPointerDown(ability: EndTurnEffectDrag['ability'], event: React.PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || !endTurnEffectCanStartDrag(ability.id)) return
    event.currentTarget.setPointerCapture(event.pointerId)
    endTurnEffectDragStart.current = {
      ability,
      ...(ability.id === evokeTargetSource?.id && evokeTargetOrb ? { sourceOrb: evokeTargetOrb } : {}),
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
      updateDragArrow(
        endTurnEffectDragArrow.current,
        endTurnEffectDragArrowShadow.current,
        next.startX,
        next.startY,
        next.y < next.startY ? -28 : 28,
        next.x,
        next.y,
      )
      endTurnEffectDragOverlay.current?.style.setProperty('--effect-drag-x', `${next.x - next.startX}px`)
      endTurnEffectDragOverlay.current?.style.setProperty('--effect-drag-y', `${next.y - next.startY}px`)
      if (!previous || previous.targetUid !== next.targetUid) setEndTurnEffectDrag(next)
    })
  }

  function finishEndTurnEffectDrag(event: React.PointerEvent<HTMLElement>) {
    const start = endTurnEffectDragStart.current
    if (!start || start.pointerId !== event.pointerId) return
    const moved = Math.hypot(event.clientX - start.startX, event.clientY - start.startY) >= 10
    const targetUid = endTurnEffectDragTargetAt(start, event.clientX, event.clientY)
    clearEndTurnEffectDrag()
    if (start.element.hasPointerCapture(event.pointerId)) start.element.releasePointerCapture(event.pointerId)
    if (!moved) return
    if (start.sourceTargetUid) armClickSuppression(suppressEndTurnOrbClick, start.sourceTargetUid)
    else armClickSuppression(suppressEndTurnEffectClick, start.ability.id)
    if (targetUid) onResolveTurnEffectTarget(start.ability.id, targetUid)
  }

  function cancelEndTurnEffectDrag(event: React.PointerEvent<HTMLElement>) {
    if (endTurnEffectDragStart.current?.pointerId === event.pointerId) clearEndTurnEffectDrag()
  }

  function activateEndTurnEffect(ability: EndTurnEffectDrag['ability']) {
    if (suppressEndTurnEffectClick.current === ability.id) {
      suppressEndTurnEffectClick.current = null
      return
    }
    if (!endTurnEffectCanStartDrag(ability.id)) return
    setArmedEndTurnAbilityId((current) => current === ability.id ? null : ability.id)
  }

  function onCardPointerDown(card: CardInstance, event: React.PointerEvent<HTMLButtonElement>, playable: boolean, chamber = false) {
    if (event.button !== 0) return
    const canDrag = playable && (chamber ? chamberCardCanStartDrag(card) : cardCanStartDrag(card))
    const staged = chamber ? stageHermitChamberViewer(viewer, card,
      state.pendingHermitChamberPlays?.[0]?.playerId === viewerId &&
      state.pendingHermitChamberPlays[0].cardUids[0] === card.uid &&
      state.pendingHermitChamberPlays[0].free) : null
    const nextPending = canDrag ? pendingFor(staged?.card ?? card, null, state, staged?.player ?? viewer,
      false, undefined, chamber) : null
    const scrollElement = event.currentTarget.closest('.hand-scroll') as HTMLDivElement | null
    event.currentTarget.setPointerCapture(event.pointerId)
    cardDragStart.current = {
      card, chamber, pointerId: event.pointerId,
      startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY,
      needsEnemy: nextPending?.needsEnemy ?? false,
      needsPlayer: nextPending ? !nextPending.needsEnemy && (nextPending.needsAlly || nextPending.playerChoices > 0) : false,
      hitsRow: nextPending?.hitsRow ?? false,
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
    if (!cardDragLive.current && Math.hypot(dx, dy) < 10) return
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
      updateDragArrow(
        cardDragArrow.current,
        cardDragArrowShadow.current,
        next.startX,
        next.startY,
        -45,
        next.x,
        next.y,
      )
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
    armClickSuppression(suppressCardClick, start.card.uid)
    if (!start.canDrag || wasScrolling) return
    if (lifted && (!needsEnemy || targetUid) && (!needsPlayer || targetPlayerId)) {
      if (start.chamber) onHermitChamberPlay(start.card, targetUid, targetPlayerId)
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

  return {
    cardDrag,
    endTurnEffectDrag,
    armedEndTurnAbilityId,
    setArmedEndTurnAbilityId,
    endTurnEffectAimed,
    endTurnEffectDragCard,
    endTurnEffectDragSlimeAsset,
    endTurnEffectDragRelicId,
    draggedEnemy,
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
    cardCanStartDrag,
    chamberCardCanStartDrag,
    onCardPointerDown,
    onCardPointerMove,
    finishCardDrag,
    cancelCardDrag,
    activateCard,
  }
}
