import { memo } from 'react'
import { cardThumbPath } from '../../game/assets.ts'
import { cardDef, faceOf } from '../../game/cards.ts'
import type { Enemy } from '../../game/types.ts'
import { cardRuleDescription, revealDecodedImage } from '../Card.tsx'
import { cardSkin, type useCardSkins } from '../skin-context.tsx'

type Skins = ReturnType<typeof useCardSkins>

export const SlayerAttachments = memo(function SlayerAttachments({ enemy, skins }: { enemy: Enemy; skins: Skins }) {
  return <>
    {(enemy.slayerAttachments ?? []).map((entry) => (
      <span key={entry.card.uid} className="enemy__attachment" data-slayer-attachment={entry.card.defId}
        title={`${faceOf(cardDef(entry.card.defId), entry.card.upgraded).name}: ${
          cardRuleDescription(faceOf(cardDef(entry.card.defId), entry.card.upgraded))}`}>
        <img src={cardThumbPath(cardDef(entry.card.defId), entry.card.upgraded, undefined, cardSkin(skins, cardDef(entry.card.defId)))} alt=""
          onLoad={(event) => revealDecodedImage(event.currentTarget)}
          onError={(event) => { event.currentTarget.style.visibility = 'hidden' }} />
        <span>{faceOf(cardDef(entry.card.defId), entry.card.upgraded).name}</span>
      </span>
    ))}
  </>
})

export const CorpseExplosionAttachment = memo(function CorpseExplosionAttachment({ enemy, skins }: { enemy: Enemy; skins: Skins }) {
  if (!enemy.corpseExplosion) return null
  return (
    <span className="enemy__attachment" title={`Corpse Explosion · ${enemy.corpseExplosion.damage} row damage on death`}>
      <img src={cardThumbPath(cardDef(enemy.corpseExplosion.card.defId), enemy.corpseExplosion.card.upgraded,
        undefined, cardSkin(skins, cardDef(enemy.corpseExplosion.card.defId)))} alt=""
        onLoad={(event) => revealDecodedImage(event.currentTarget)}
        onError={(event) => { event.currentTarget.style.visibility = 'hidden' }} />
      <span>Corpse Explosion · {enemy.corpseExplosion.damage}</span>
    </span>
  )
})
