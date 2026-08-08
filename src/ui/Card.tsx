import { cardDef, faceOf } from '../game/cards.ts'
import type { CardDef } from '../game/cards.ts'
import { cardImagePath } from '../game/assets.ts'
import type { CardInstance } from '../game/types.ts'

type CardProps = {
  card: CardInstance
  playable?: boolean
  /** Staged for play, waiting on a target or a choice. */
  selected?: boolean
  /** Chosen as the subject of another card's discard or exhaust effect. */
  picked?: boolean
  onClick?: (card: CardInstance) => void
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
      disabled={!playable}
      onClick={() => onClick?.(card)}
      aria-label={`${def.name}, cost ${costLabel(def)}, ${def.type}`}
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
      <span className="card__cost" aria-hidden="true">
        {costLabel(def)}
      </span>
    </button>
  )
}
