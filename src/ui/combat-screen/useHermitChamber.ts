import { useEffect, useRef, useState } from 'react'
import { assetPath } from '../../game/assets.ts'
import { cardDef, faceOf } from '../../game/cards.ts'
import {
  cardCanBeForced,
  effectiveCombatCardDef,
  guardianGemForCard,
} from '../../game/combat.ts'
import type { CombatState } from '../../game/combat.ts'
import type { CardInstance, Player } from '../../game/types.ts'
import { canAfford, stageHermitChamberViewer } from './helpers.ts'
import type { ChamberReturnFlight } from './types.ts'

const CHAMBER_RETURN_MS = 460
const CHAMBER_RETURN_STAGGER_MS = 35
const CHAMBER_REFLOW_MS = 420

export function useHermitChamber({
  state,
  viewer,
  viewerId,
  reducedMotion,
}: {
  state: CombatState
  viewer: Player | undefined
  viewerId: string
  reducedMotion: boolean
}) {
  const [chamberOpen, setChamberOpen] = useState(false)
  const [chamberClosing, setChamberClosing] = useState(false)
  const [chamberContact, setChamberContact] = useState(false)
  const [chamberReturnFlights, setChamberReturnFlights] = useState<ChamberReturnFlight[]>([])
  const chamberCloseTimer = useRef<number | null>(null)
  const chamberContactTimer = useRef<number | null>(null)
  const chamberReflowFrame = useRef<number | null>(null)
  const handRevealFrame = useRef<number | null>(null)
  const chamberTriggerRef = useRef<HTMLButtonElement | null>(null)
  const handScrollRef = useRef<HTMLDivElement | null>(null)
  const handRef = useRef<HTMLDivElement | null>(null)
  const chamberViewerId = useRef(viewerId)

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

  const chamberCardsVisible = chamberOpen
  const visibleHand = viewer
    ? chamberCardsVisible ? [...viewer.chamber, ...viewer.hand] : viewer.hand
    : []
  const visibleChamberUids = viewer && chamberCardsVisible
    ? new Set(viewer.chamber.map((card) => card.uid))
    : new Set<string>()
  const requiredChamberCard = viewer && requiredHermitChamberCard?.playerId === viewer.id
    ? viewer.chamber.find((card) => card.uid === requiredHermitChamberCard.cardUids[0])
    : undefined
  const requiredChamberStaged = viewer && requiredChamberCard
    ? stageHermitChamberViewer(viewer, requiredChamberCard, requiredHermitChamberCard?.free)
    : undefined
  const requiredChamberUnplayable = !viewer || viewer.dead ||
    (requiredChamberStaged
      ? !canAfford(state, requiredChamberStaged.player, requiredChamberStaged.card) ||
        !cardCanBeForced(
          effectiveCombatCardDef(faceOf(cardDef(requiredChamberStaged.card.defId), requiredChamberStaged.card.upgraded),
            requiredChamberStaged.player.guardianMode),
          state, requiredChamberStaged.player,
          guardianGemForCard(requiredChamberStaged.player, requiredChamberStaged.card), requiredChamberStaged.card.uid,
        )
      : false)

  return {
    chamberOpen,
    chamberClosing,
    chamberContact,
    chamberReturnFlights,
    chamberTriggerRef,
    handScrollRef,
    handRef,
    requiredHermitChamberCard,
    visibleHand,
    visibleChamberUids,
    requiredChamberCard,
    requiredChamberUnplayable,
    closeChamber,
    toggleChamber,
  }
}
