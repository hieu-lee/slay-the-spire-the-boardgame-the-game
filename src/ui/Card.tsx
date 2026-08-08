import type React from 'react'
import { cardDef, faceOf } from '../game/cards.ts'
import type { CardDef } from '../game/cards.ts'
import { cardImagePath } from '../game/assets.ts'
import { Icon } from './Icon.tsx'
import type { CardInstance } from '../game/types.ts'

type CardProps = {
  card: CardInstance
  playable?: boolean
  /** Staged for play, waiting on a target or a choice. */
  selected?: boolean
  /** Chosen as the subject of another card's discard or exhaust effect. */
  picked?: boolean
  /** Position in the fan, -1 (leftmost) to 1 (rightmost), 0 in the middle. */
  fan?: number
  onClick?: (card: CardInstance) => void
}

/**
 * What a screen reader announces for the card.
 *
 * The face is a scan, so the printed numbers are an IMAGE and are never read
 * out. This string carries the clauses that change HOW the card is played —
 * its reach, and whether playing it spends the card for good — which is what a
 * player needs before choosing a target. It does NOT carry the effects
 * themselves: "Cleave, cost 1, attack, hits a whole row and any boss" never
 * says 2 damage. Rendering `effects` into words is the fix, and it is a bigger
 * one than this; until then the label is a targeting aid, not a card reading.
 */
function accessibleName(def: CardDef): string {
  return [
    def.name,
    // "cost —" reads as a dangling "cost" once a screen reader drops the dash
    // at its default punctuation setting. An unplayable card and one you merely
    // cannot afford are both greyed out, so the name is the only thing that can
    // tell them apart.
    def.unplayable ? 'unplayable' : `cost ${costLabel(def)}`,
    def.type,
    // A row always takes the boss too, wherever the boss stands (p.15). Saying
    // only "a whole row" tells a player picking a distant row that the boss is
    // safe from it, which is the opposite of the rule.
    def.target === 'row' ? 'hits a whole row and any boss' : '',
    def.exhaust ? 'exhausts when played' : '',
  ]
    .filter(Boolean)
    .join(', ')
}

/** The energy cost badge, or nothing at all for an unplayable card (p.24). */
function costLabel(def: CardDef): string {
  if (def.unplayable) return '—'
  return def.cost === 'X' ? 'X' : String(def.cost)
}

export function Card({
  card,
  playable = true,
  selected = false,
  picked = false,
  fan = 0,
  onClick,
}: CardProps) {
  const def = faceOf(cardDef(card.defId), card.upgraded)
  const className = [
    'card',
    playable ? '' : 'card--unplayable',
    selected ? 'card--selected' : '',
    picked ? 'card--picked' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button
      type="button"
      className={className}
      style={{
        // Tilt with distance from the middle, and drop the outer cards a
        // little so the row reads as an arc rather than a shelf.
        // The spread grows with the hand: a fixed angle made five cards look
        // merely crooked and only became a fan at eight or more.
        '--fan-angle': `${fan * 11}deg`,
        '--fan-lift': `${Math.abs(fan) * 14}px`,
      } as React.CSSProperties}
      disabled={!playable}
      onClick={() => onClick?.(card)}
      aria-label={accessibleName(def)}
      title={def.name}
    >
      <img
        className="card__art"
        src={cardImagePath(def, card.upgraded)}
        alt=""
        loading="lazy"
        onError={(event) => {
          // Not every card has a scan in the source set (Daze, for one). Fall
          // back to the card frame rather than showing a broken image.
          event.currentTarget.style.visibility = 'hidden'
        }}
      />
      <span className="card__fallback" aria-hidden="true">
        {def.name}
      </span>
      {def.target === 'row' ? (
        // The burst printed on Cleave and its like. Marked hidden because
        // `accessibleName` already says "hits a whole row" — announced here as
        // well, every such card would read its reach out twice.
        <span className="card__aoe" aria-hidden="true">
          <Icon name="aoe" size={18} />
        </span>
      ) : null}
      <span className="card__cost" aria-hidden="true">
        {costLabel(def)}
      </span>
    </button>
  )
}
