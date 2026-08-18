import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { potionIconPath } from '../game/assets.ts'
import { potionDef } from '../game/relics.ts'

type AnchorProps = {
  id: string
  children: React.ReactNode
  focusable?: boolean
  decorative?: boolean
}

const tooltipListeners = new Set<(owner: object) => void>()

/** An unclipped Potion tooltip anchor for either an icon or an action button. */
export function PotionTooltipAnchor({ id, children, focusable = false, decorative = false }: AnchorProps) {
  const def = potionDef(id)
  const anchor = useRef<HTMLSpanElement>(null)
  const tip = useRef<HTMLSpanElement>(null)
  const owner = useRef({}).current
  const leaveTimer = useRef<number | undefined>(undefined)
  const pointerActivating = useRef(false)
  const [hovered, setHovered] = useState(false)
  const [tipHovered, setTipHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [dismissed, setDismissed] = useState<false | 'manual' | 'superseded'>(false)
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const showing = (hovered || tipHovered || focused) && !dismissed

  const claimTooltip = () => tooltipListeners.forEach((listener) => listener(owner))

  const enterAnchor = () => {
    window.clearTimeout(leaveTimer.current)
    claimTooltip()
    if (dismissed === 'superseded') setDismissed(false)
    setTipHovered(false)
    setHovered(true)
  }
  const leaveAnchor = () => {
    window.clearTimeout(leaveTimer.current)
    leaveTimer.current = window.setTimeout(() => setHovered(false), 150)
  }
  const enterTip = () => {
    window.clearTimeout(leaveTimer.current)
    setHovered(false)
    setTipHovered(true)
  }
  const leaveTip = () => {
    window.clearTimeout(leaveTimer.current)
    leaveTimer.current = window.setTimeout(() => setTipHovered(false), 150)
  }

  useLayoutEffect(() => {
    if (!showing || !anchor.current || !tip.current) return
    const trigger = anchor.current.getBoundingClientRect()
    const panel = tip.current.getBoundingClientRect()
    const left = Math.max(16, Math.min(trigger.left, window.innerWidth - panel.width - 16))
    const below = trigger.bottom + 8
    const top = below + panel.height <= window.innerHeight - 16
      ? below
      : Math.max(16, trigger.top - panel.height - 8)
    setPosition({ left, top })
  }, [showing])

  useEffect(() => {
    if (!showing) return undefined
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setTipHovered(false)
      setDismissed('manual')
    }
    document.addEventListener('keydown', dismiss, true)
    return () => document.removeEventListener('keydown', dismiss, true)
  }, [showing])

  useEffect(() => {
    if (!hovered && !tipHovered && !focused) setDismissed(false)
  }, [hovered, tipHovered, focused])

  useEffect(() => {
    const closeOther = (activeOwner: object) => {
      if (activeOwner === owner) return
      setHovered(false)
      setTipHovered(false)
      setDismissed('superseded')
    }
    tooltipListeners.add(closeOther)
    return () => { tooltipListeners.delete(closeOther) }
  }, [owner])

  useEffect(() => () => window.clearTimeout(leaveTimer.current), [])

  return <span ref={anchor} className="potion-chip" tabIndex={focusable ? 0 : undefined}
    role={focusable ? 'img' : undefined} aria-hidden={decorative ? 'true' : undefined}
    aria-label={focusable ? `${def.name}. Potion. ${def.text}` : undefined}
    onMouseEnter={enterAnchor} onMouseLeave={leaveAnchor}
    onPointerDownCapture={(event) => {
      const activatesButton = event.target instanceof Element && Boolean(event.target.closest('button'))
      if (event.pointerType !== 'mouse' && !activatesButton) return
      pointerActivating.current = true
      setDismissed('manual')
      queueMicrotask(() => { pointerActivating.current = false })
    }}
    onClickCapture={(event) => {
      if (event.target instanceof Element && event.target.closest('button')) setDismissed('manual')
    }}
    onFocus={() => {
      setFocused(true)
      if (pointerActivating.current) return
      claimTooltip()
      if (dismissed === 'superseded') setDismissed(false)
    }}
    onBlur={() => setFocused(false)}>
    {children}
    {showing ? createPortal(<span ref={tip}
      className={`relic-tip potion-tip${hovered || tipHovered ? ' potion-tip--hoverable' : ''}`} aria-hidden="true"
      style={position} onMouseEnter={enterTip} onMouseLeave={leaveTip}>
        <strong className="relic-tip__name">{def.name}</strong>
        <span className="relic-tip__pool">Potion</span>
        <span className="relic-tip__text">{def.text}</span>
      </span>, document.body) : null}
  </span>
}

/** A held Potion icon that explains its printed effect on hover or focus. */
export function PotionIcon({ id, focusable = true }: { id: string; focusable?: boolean }) {
  return <PotionTooltipAnchor id={id} focusable={focusable} decorative={!focusable}>
    <img className="item-icon-image" src={potionIconPath(id)} alt="" />
  </PotionTooltipAnchor>
}
