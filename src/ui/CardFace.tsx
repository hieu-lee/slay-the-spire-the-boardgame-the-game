import type { CardDef } from '../game/cards.ts'
import { cardArtPath } from '../game/assets.ts'

type CardFaceProps = {
  def: CardDef
  cost?: number | 'X'
  rules: string
  className?: string
}

/** Repo-native card face shown underneath an optional publisher scan. */
export function CardFace({ def, cost = def.cost, rules, className = '' }: CardFaceProps) {
  const shownCost = def.unplayable ? '—' : cost
  const hasIllustration = ['ironclad', 'silent', 'defect', 'watcher'].includes(def.owner)
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
      <span className="card-face__type">{def.type}</span>
      <span className="card-face__rules">{rules}</span>
    </span>
  )
}
