import { useState } from 'react'
import { potionCardImagePath, potionIconPath, relicCardImagePath, relicIconPath } from '../game/assets.ts'
import { potionDef, relicDef } from '../game/relics.ts'
import { KeywordText } from './KeywordText.tsx'

export function ItemImage({ kind, id, card = false }: {
  kind: 'relic' | 'potion'
  id: string
  card?: boolean
}) {
  const [fallback, setFallback] = useState(false)
  const def = kind === 'relic' ? relicDef(id) : potionDef(id)
  const icon = kind === 'relic' ? relicIconPath(id) : potionIconPath(id)
  const src = !card ? icon : kind === 'relic'
    ? relicCardImagePath(relicDef(id))
    : potionCardImagePath(potionDef(id))
  const nativeFace = 'publisherScan' in def && def.publisherScan === false
  if (card && (fallback || nativeFace)) return <span className={`item-card-fallback item-card-fallback--${kind}`} aria-hidden="true">
    <strong>{def.name}</strong>
    <img className="item-card-image" src={icon} alt="" />
    <small>{kind === 'relic' ? 'Relic' : 'Potion'}</small>
    <KeywordText text={def.text} />
  </span>
  return <img className={card ? 'item-card-image' : 'item-icon-image'} src={src} alt=""
    onError={card ? () => setFallback(true) : undefined} />
}
