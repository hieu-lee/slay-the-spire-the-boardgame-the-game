import type { CardDef } from '../game/cards.ts'
import { cardArtPath } from '../game/assets.ts'
import { BASE_CHARACTER_IDS } from '../game/types.ts'

type CardFaceProps = {
  def: CardDef
  cost?: number | 'X'
  rules: string
  className?: string
  /** The full scan normally covers this fallback art; defer its decode until the scan fails. */
  illustration?: boolean
}

/** Repo-native card face shown underneath an optional publisher scan. */
export function CardFace({
  def, cost = def.cost, rules, className = '', illustration = true,
}: CardFaceProps) {
  const shownCost = def.unplayable ? '—' : cost
  // Downfall publisher illustrations are intentionally optional. Its native
  // faces stay text-first instead of requesting files a clean clone lacks.
  const hasIllustration = illustration && BASE_CHARACTER_IDS.some((owner) => owner === def.owner)
  return (
    <span
      className={['card-face', 'card__fallback', `card-face--${def.owner}`, `card-face--${def.rarity}`, className]
        .filter(Boolean).join(' ')}
      aria-hidden="true"
    >
      <strong className="card-face__title">{def.name}</strong>
      <span className="card-face__cost">{shownCost}</span>
      {hasIllustration
        ? <img className="card-face__illustration" src={cardArtPath(def)} alt="" loading="lazy" />
        : <span className="card-face__illustration card-face__illustration--empty" />}
      <span className="card-face__type">{def.guardian?.printedType ?? def.type}</span>
      <span className="card-face__rules">{rules}</span>
    </span>
  )
}
