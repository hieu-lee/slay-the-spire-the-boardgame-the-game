import type React from 'react'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cardDef, faceOf } from '../game/cards.ts'
import type { CardDef } from '../game/cards.ts'
import { cardThumbPath } from '../game/assets.ts'
import { useCardSkin } from './skin-context.tsx'
import { CardFace } from './CardFace.tsx'
import { Icon, StatusIcon } from './Icon.tsx'
import type { IconName, StatusIconName } from './icons.ts'
import type { CardInstance } from '../game/types.ts'
import {
  EMPTY_KEYWORD_TIPS,
  cardAccessibleName,
  cardRuleDescription,
  cardRulesText,
  composeCardKeywordTips,
  stanceBonusTips,
} from './card/text.ts'

export {
  cardAccessibleName,
  cardKeywordTips,
  cardPlayText,
  cardRuleDescription,
  cardRulesText,
  composeCardKeywordTips,
  slimeCommandText,
  stanceBonusTips,
} from './card/text.ts'

type CardProps = {
  card: CardInstance
  className?: string
  style?: React.CSSProperties
  /** Current cost after board-state reductions. */
  cost?: number | 'X'
  playable?: boolean
  /** Recessed combat cards reveal on the first tap, then activate on the next. */
  inspectOnTouch?: boolean
  /** Transient copies must paint an already-visible scan on their first frame. */
  immediateArt?: boolean
  /** Staged for play, waiting on a target or a choice. */
  selected?: boolean
  /** Chosen as the subject of another card's discard or exhaust effect. */
  picked?: boolean
  /** The attached Gem came from a Gem Power such as Crystallize. */
  gemPowerDamage?: boolean
  /** Position in the fan, -1 (leftmost) to 1 (rightmost), 0 in the middle. */
  fan?: number
  /** Damage the card would deal now, against the same play with no Strength, Weak or Vulnerable. */
  liveDamage?: { damage: number, baseline: number }
  stanceChangedThisTurn?: boolean
  /** Removes an otherwise-real card button from sequential keyboard navigation. */
  tabIndex?: number
  /** Appended to the accessible name, e.g. to tell a just-drawn duplicate apart. */
  accessibleNote?: string
  onClick?: (card: CardInstance) => void
  /** `playable` is the card's state at press time, so a press can pan without starting a play. */
  onPointerDown?: (event: React.PointerEvent<HTMLButtonElement>, playable: boolean) => void
  onPointerMove?: React.PointerEventHandler<HTMLButtonElement>
  onPointerUp?: React.PointerEventHandler<HTMLButtonElement>
  onPointerCancel?: React.PointerEventHandler<HTMLButtonElement>
  onLostPointerCapture?: React.PointerEventHandler<HTMLButtonElement>
}

/** Show an optional publisher scan only after Chromium can decode its pixels. */
export function revealDecodedImage(image: HTMLImageElement, options?: {
  isCurrent?: () => boolean
  onDecodeError?: () => void
}) {
  void image.decode().then(
    () => {
      if (options?.isCurrent && !options.isCurrent()) return
      image.style.visibility = 'visible'
    },
    () => {
      if (options?.isCurrent && !options.isCurrent()) return
      image.style.visibility = 'hidden'
      options?.onDecodeError?.()
    },
  )
}

export function CardKeywordHelp({ def, additionalDef, gemPowerDamage, extraTips = EMPTY_KEYWORD_TIPS, hover = false, children }: {
  def?: CardDef
  hover?: boolean
  additionalDef?: CardDef | null
  gemPowerDamage?: boolean
  extraTips?: readonly { name: string, text: string, icon?: IconName, statusIcon?: StatusIconName }[]
  children: (props: {
    ref?: (element: HTMLElement | null) => void
    'aria-describedby'?: string
    'data-keyword-help-id'?: string
    'data-help-on-hover'?: boolean
  }) => React.ReactNode
}) {
  const { tips, tipsKey, description } = useMemo(() => {
    const tips = composeCardKeywordTips(def, additionalDef, gemPowerDamage, extraTips)
    return { tips, tipsKey: JSON.stringify(tips), description: tips.map((tip) => `${tip.name}: ${tip.text}`).join(' ') }
  }, [def, additionalDef, gemPowerDamage, extraTips])
  const tooltipId = `card-keyword-help-${useId()}`
  const anchorRef = useRef<HTMLElement | null>(null)
  const [mounted, setMounted] = useState(false)
  const setAnchor = useCallback((element: HTMLElement | null) => {
    const previous = anchorRef.current as (HTMLElement & { mountKeywordHelp?: () => void }) | null
    if (previous) delete previous.mountKeywordHelp
    anchorRef.current = element
    if (element) (element as HTMLElement & { mountKeywordHelp?: () => void }).mountKeywordHelp = () => setMounted(true)
  }, [])
  useEffect(() => {
    if (mounted && tips.length > 0) anchorRef.current?.dispatchEvent(new Event('card-keyword-help-ready', { bubbles: true }))
  }, [mounted, tipsKey])
  const host = mounted && anchorRef.current ? anchorRef.current.closest('dialog') ?? document.body : null
  const props = tips.length > 0 ? {
    ref: setAnchor,
    'aria-describedby': `${tooltipId}-description`,
    'data-keyword-help-id': tooltipId,
    'data-help-on-hover': hover || undefined,
  } : mounted ? { ref: setAnchor } : {}
  return <>
    {children(props)}
    {tips.length > 0 ? <span className="visually-hidden" id={`${tooltipId}-description`}>
      {description}
    </span> : null}
    {host && tips.length > 0 ? createPortal(
      <span className="card-keyword-tips" id={tooltipId} role="tooltip">
        {tips.map((tip) => (
          <span className="card-keyword-tip" key={tip.name}>
            <strong>{tip.icon ? <Icon name={tip.icon} size={18} />
              : tip.statusIcon ? <StatusIcon name={tip.statusIcon} size={18} /> : null}{tip.name}</strong>
            <span>{tip.text}</span>
          </span>
        ))}
      </span>,
      host,
    ) : null}
  </>
}

export function Card({
  card,
  className: extraClassName,
  style,
  cost,
  playable = true,
  inspectOnTouch = false,
  immediateArt = false,
  selected = false,
  picked = false,
  gemPowerDamage,
  fan = 0,
  liveDamage,
  stanceChangedThisTurn,
  tabIndex,
  accessibleNote,
  onClick,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onLostPointerCapture,
}: CardProps) {
  const touchNeedsInspection = useRef(false)
  const blockedMousePress = useRef(false)
  const def = faceOf(cardDef(card.defId), card.upgraded)
  const attachedGem = card.attachedGemId ? faceOf(cardDef(card.attachedGemId), false) : null
  const showStanceBonus = def.id === 'flurry_of_blows' && stanceChangedThisTurn !== undefined
  const skin = useCardSkin(def)
  const scan = cardThumbPath(def, card.upgraded, attachedGem ?? undefined, skin)
  const hasPublisherScan = def.publisherScan !== false
  const [scanUnavailable, setScanUnavailable] = useState(!hasPublisherScan)
  useEffect(() => setScanUnavailable(!hasPublisherScan), [hasPublisherScan, scan])
  const className = [
    'card',
    extraClassName ?? '',
    playable ? '' : 'card--unplayable',
    selected ? 'card--selected' : '',
    picked ? 'card--picked' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return <CardKeywordHelp def={def} additionalDef={attachedGem}
    extraTips={stanceBonusTips(def.id, stanceChangedThisTurn)}
    gemPowerDamage={gemPowerDamage}>{(keywordHelpProps) => (
    <button
      {...keywordHelpProps}
      type="button"
      className={className}
      data-sfx="card"
      tabIndex={tabIndex}
      style={{
        ...style,
        // Tilt with distance from the middle, and drop the outer cards a
        // little so the row reads as an arc rather than a shelf.
        // The spread grows with the hand: a fixed angle made five cards look
        // merely crooked and only became a fan at eight or more.
        '--fan-angle': `${fan * 4}deg`,
        '--fan-lift': `${Math.abs(fan) * 5}px`,
      } as React.CSSProperties}
      aria-disabled={!playable}
      onPointerDown={(event) => {
        touchNeedsInspection.current = inspectOnTouch && event.pointerType === 'touch' &&
          document.activeElement !== event.currentTarget
        blockedMousePress.current = event.pointerType === 'mouse' && !playable
        if (blockedMousePress.current) event.preventDefault()
        onPointerDown?.(event, playable)
      }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onLostPointerCapture}
      onClick={(event) => {
        const inspect = touchNeedsInspection.current && event.detail !== 0
        touchNeedsInspection.current = false
        const blocked = blockedMousePress.current && event.detail !== 0
        if (event.detail !== 0) blockedMousePress.current = false
        if (inspect) {
          event.currentTarget.focus({ preventScroll: true })
          return
        }
        if (blocked || !playable) {
          event.preventDefault()
          return
        }
        onClick?.(card)
      }}
      aria-label={`${cardAccessibleName(def, cost)}${attachedGem
        ? `, socketed with ${attachedGem.name}: ${cardRuleDescription(attachedGem)}` : ''}${
        accessibleNote ? `, ${accessibleNote}` : ''}`}
      aria-pressed={selected || picked}
      data-card-name={def.name}
    >
      {hasPublisherScan ? <img
        className="card__art"
        src={scan}
        alt=""
        draggable={false}
        loading={immediateArt ? 'eager' : 'lazy'}
        decoding={immediateArt ? 'sync' : 'async'}
        onLoad={(event) => {
          const image = event.currentTarget
          revealDecodedImage(image, {
            isCurrent: () => image.isConnected && image.getAttribute('src') === scan,
            onDecodeError: () => setScanUnavailable(true),
          })
        }}
        onError={(event) => {
          if (event.currentTarget.getAttribute('src') !== scan) return
          // Some source-set cards have no scan. Fall back to the card frame
          // rather than showing a broken image.
          event.currentTarget.style.visibility = 'hidden'
          setScanUnavailable(true)
        }}
      /> : null}
      <CardFace def={def} cost={cost} rules={cardRulesText(def)} illustration={scanUnavailable} />
      {showStanceBonus ? <span className="card__stance-bonus" data-active={stanceChangedThisTurn} aria-hidden="true">
        {stanceChangedThisTurn ? 'Stance ✓' : 'Stance ✕'}
      </span> : null}
      {attachedGem && scanUnavailable ? <img className="card__gem" src={cardThumbPath(attachedGem, false)} alt=""
        draggable={false} title={`${attachedGem.name}: ${cardRuleDescription(attachedGem)}`} /> : null}
      {liveDamage ? (
        // The scan prints the base number; this is what the hit really deals now.
        <span className="card__live-damage" aria-hidden="true"
          data-trend={liveDamage.damage > liveDamage.baseline ? 'up' : liveDamage.damage < liveDamage.baseline ? 'down' : undefined}>
          <Icon name="attack" size={14} />{liveDamage.damage}
        </span>
      ) : null}
      {card.playWindowCost !== undefined ? (
        // Slayer Pack: The exact cost an open card-play window charges, over the printed gem.
        <span className="card__window-cost" aria-hidden="true">
          <Icon name="energy" size={14} />{card.playWindowCost}
        </span>
      ) : null}
      {def.target === 'row' ? (
        // The burst printed on Cleave and its like. Marked hidden because
        // `accessibleName` already says "affects a whole row" — announced here as
        // well, every such card would read its reach out twice.
        <span className="card__aoe" aria-hidden="true">
          <Icon name="aoe" size={18} />
        </span>
      ) : null}
    </button>
  )}</CardKeywordHelp>
}
