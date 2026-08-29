import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { potionIconPath } from '../game/assets.ts'
import { potionDef } from '../game/relics.ts'
import { POINTER_CLICK_WINDOW_MS, useHoverUnavailable } from './touch-input.ts'

type AnchorProps = {
  id: string
  children: React.ReactNode
  focusable?: boolean
  decorative?: boolean
  name?: string
  text?: string
  kindLabel?: string
  /**
   * What the second tap will actually do, as a verb phrase — today "drink",
   * "aim", or "choose a replacement".
   *
   * Supplying it is also what ARMS the two-step: an anchor that wraps a button
   * without one swallows nothing, because a gate that prints no instruction is
   * worse than no gate. Written per call site because the anchors do not commit
   * the same act — a combat potion needing a target only stages that target,
   * the belt's Entropic Brew either drinks or opens a replacement chooser
   * depending on how full the belt is, and a bare inventory icon has nothing to
   * commit at all. One blanket verb was wrong on all of them.
   */
  confirmLabel?: string
}

const tooltipListeners = new Set<(owner: object) => void>()

/** An unclipped Potion tooltip anchor for either an icon or an action button. */
export function PotionTooltipAnchor({
  id, children, focusable = false, decorative = false, name, text, kindLabel = 'Potion', confirmLabel,
}: AnchorProps) {
  const def = name === undefined || text === undefined ? potionDef(id) : undefined
  const itemName = name ?? def!.name
  const itemText = text ?? def!.text
  const anchor = useRef<HTMLSpanElement>(null)
  const tip = useRef<HTMLSpanElement>(null)
  const owner = useRef({}).current
  const leaveTimer = useRef<number | undefined>(undefined)
  const pointerActivating = useRef(false)
  const pointerActivatedAt = useRef(Number.NEGATIVE_INFINITY)
  const [hovered, setHovered] = useState(false)
  const [tipHovered, setTipHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [dismissed, setDismissed] = useState<false | 'manual' | 'superseded'>(false)
  const [position, setPosition] = useState({ left: 0, top: 0 })
  // A potion is spent the instant its button is pressed, and on a phone that
  // press is also the only way to reach the panel saying what the potion does —
  // so the rules arrived, at best, as an explanation of what the player had
  // just irreversibly done. Where there is no hover, the first tap opens the
  // panel and the second spends the potion.
  const tapToRead = useHoverUnavailable()
  const [readingTap, setReadingTap] = useState(false)
  // A tap fires `mouseenter` and leaves `:hover` stuck, so on a touch device the
  // hover state is noise that would hold this panel open after the player had
  // moved on — and `onMouseLeave` may never arrive to clear it. Where there is
  // no hover, only the tap and real focus open the panel.
  const showing = (readingTap || focused || (!tapToRead && (hovered || tipHovered))) && !dismissed

  const claimTooltip = () => tooltipListeners.forEach((listener) => listener(owner))

  /** True only for a button this anchor wraps — never one it merely sits in. */
  const ownsPressedButton = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return false
    const button = target.closest('button')
    return Boolean(button && anchor.current?.contains(button))
  }

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
    // `readingTap` too: the browser focuses the button before dispatching the
    // click, so `showing` turns true one commit BEFORE the confirm line is
    // added — and the guard above would place the panel using a height that is
    // one line short of what it renders.
  }, [showing, readingTap])

  useEffect(() => {
    if (!showing) return undefined
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (anchor.current?.closest('dialog[open]')) event.preventDefault()
      event.stopPropagation()
      setTipHovered(false)
      setReadingTap(false)
      setDismissed('manual')
    }
    document.addEventListener('keydown', dismiss, true)
    return () => document.removeEventListener('keydown', dismiss, true)
  }, [showing])

  // Tapping anywhere else disarms, so a panel opened by a stray tap cannot
  // leave the next tap on this button spending a potion the player never
  // decided to drink.
  useEffect(() => {
    if (!readingTap) return undefined
    const away = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return
      // The panel is portalled to the body, so it is not inside the anchor and
      // a tap on the text a player is reading would otherwise disarm the very
      // confirmation it is explaining.
      if (anchor.current?.contains(event.target) || tip.current?.contains(event.target)) return
      setReadingTap(false)
    }
    document.addEventListener('pointerdown', away, true)
    return () => document.removeEventListener('pointerdown', away, true)
  }, [readingTap])

  useEffect(() => {
    if (!hovered && !tipHovered && !focused && !readingTap) setDismissed(false)
  }, [hovered, tipHovered, focused, readingTap])

  useEffect(() => {
    const closeOther = (activeOwner: object) => {
      if (activeOwner === owner) return
      setHovered(false)
      setTipHovered(false)
      setReadingTap(false)
      setDismissed('superseded')
    }
    tooltipListeners.add(closeOther)
    return () => { tooltipListeners.delete(closeOther) }
  }, [owner])

  useEffect(() => () => window.clearTimeout(leaveTimer.current), [])

  return <span ref={anchor} className="potion-chip" tabIndex={focusable ? 0 : undefined}
    role={focusable ? 'img' : undefined} aria-hidden={decorative ? 'true' : undefined}
    aria-label={focusable ? `${itemName}. ${kindLabel}. ${itemText}` : undefined}
    onMouseEnter={enterAnchor} onMouseLeave={leaveAnchor}
    onPointerDownCapture={(event) => {
      pointerActivatedAt.current = Date.now()
      const activatesButton = event.target instanceof Element && Boolean(event.target.closest('button'))
      if (event.pointerType !== 'mouse' && !activatesButton) return
      // The arming tap must NOT pre-dismiss: this handler runs before the click
      // below, and dismissing here would close the panel that tap is opening.
      if (tapToRead && ownsPressedButton(event.target) && !readingTap) return
      pointerActivating.current = true
      setDismissed('manual')
      queueMicrotask(() => { pointerActivating.current = false })
    }}
    onClickCapture={(event) => {
      if (!(event.target instanceof Element)) return
      // The panel is portalled to the body, but React routes its events up the
      // REACT tree — so a tap on the rules text arrives here and matches no
      // button. The panel's own handler closes it; letting it fall through to
      // the bare-icon branch below would toggle the same state twice.
      if (tip.current?.contains(event.target)) return
      // Keyboard only when BOTH signals say so: a synthesised Enter carries
      // `detail === 0` AND has no `pointerdown` behind it. Either signal alone
      // is unreliable — WebKit was observed reaching this handler without the
      // pointerdown having been recorded — and the safe direction is obvious:
      // guessing "pointer" costs a keyboard user one press, guessing "keyboard"
      // spends their potion without ever showing them what it does.
      const keyboardActivated = event.detail === 0 &&
        Date.now() - pointerActivatedAt.current > POINTER_CLICK_WINDOW_MS
      const button = event.target.closest('button')
      // A button this anchor does NOT own is somebody else's control — the seat
      // that a teammate's potion icon is drawn inside, for one. Its tap must go
      // through untouched, but the panel still has to get out of the way: left
      // up, it covers the board for the rest of that targeting interaction.
      if (button && !anchor.current?.contains(button)) {
        setDismissed('manual')
        return
      }
      if (button) {
        // A keyboard has already opened this panel through focus, so a
        // read-first step there charges for nothing. Pointer activation comes
        // from the preceding `pointerdown` rather than `MouseEvent.detail`,
        // which the engines disagree about for a synthesised tap.
        if (tapToRead && confirmLabel && !keyboardActivated && !readingTap) {
          // Swallow the press rather than let it reach the button underneath.
          // Capture phase, so the button's own `onClick` never runs and the
          // potion is not spent — this tap bought the rules, nothing else.
          event.preventDefault()
          event.stopPropagation()
          claimTooltip()
          setDismissed(false)
          setReadingTap(true)
          return
        }
        setReadingTap(false)
        setDismissed('manual')
        return
      }
      // A bare icon with no action under it. Tapping it is purely a request to
      // read, and it has to be handled here rather than left to focus: iOS
      // Safari does not focus a `tabindex` span on tap.
      if (!tapToRead || keyboardActivated) return
      if (readingTap) {
        // `dismissed` as well as `readingTap`: this tap focused the span, and
        // focus alone keeps `showing` true — the panel would stay on screen
        // while losing `--hoverable`, which is the click-through lid described
        // above. Re-arming clears the flag again just below.
        setReadingTap(false)
        setDismissed('manual')
        return
      }
      claimTooltip()
      setDismissed(false)
      setReadingTap(true)
    }}
    onFocus={() => {
      setFocused(true)
      if (pointerActivating.current) return
      claimTooltip()
      if (dismissed === 'superseded') setDismissed(false)
    }}
    onBlur={() => setFocused(false)}>
    {children}
    {/* The panel itself is `aria-hidden`, so without this a screen-reader user
        activates the button, has the press swallowed, and hears nothing at all.
        Outside the portal because the portal is the hidden part, and always
        mounted because a live region that appears with its text already in it
        is the case assistive technology routinely skips.

        `aria-live` rather than `role="status"`, for the reason App.tsx gives at
        its own region: the run already owns status regions, a second one
        competes with them, and — since this renders once per potion anchor —
        it made `getByRole('status')` ambiguous for the suites. */}
    <span className="visually-hidden" aria-live="polite" aria-atomic="true">
      {readingTap && confirmLabel ? `${itemName}. ${itemText} Activate again to ${confirmLabel}.` : ''}
    </span>
    {showing ? createPortal(<span ref={tip}
      className={`relic-tip potion-tip${readingTap || (!tapToRead && (hovered || tipHovered)) ? ' potion-tip--hoverable' : ''}`} aria-hidden="true"
      style={position} onMouseEnter={enterTip} onMouseLeave={leaveTip}
      // `--hoverable` is the only thing that makes this panel hit-testable
      // (chrome/relic-bar.css). Without it while a tap holds the panel open,
      // the 320px box is a click-through lid: a tap on the rules is delivered
      // to whatever is behind them and quietly presses it. Tapping the panel
      // puts it away instead, which is the gesture a player reaches for and the
      // one the relic panel already has by being a child of its own chip.
      onClick={() => setReadingTap(false)}>
        <strong className="relic-tip__name">{itemName}</strong>
        <span className="relic-tip__pool">{kindLabel}</span>
        <span className="relic-tip__text">{itemText}</span>
        {/* Only while a tap is holding the panel open, and only where the call
            site has said what the next tap commits to. */}
        {readingTap && confirmLabel
          ? <span className="relic-tip__confirm">Tap again to {confirmLabel}</span>
          : null}
      </span>, document.body) : null}
  </span>
}

/** A held Potion icon that explains its printed effect on hover or focus. */
export function PotionIcon({ id, focusable = true }: { id: string; focusable?: boolean }) {
  return <PotionTooltipAnchor id={id} focusable={focusable} decorative={!focusable}>
    <img className="item-icon-image" src={potionIconPath(id)} alt="" />
  </PotionTooltipAnchor>
}
