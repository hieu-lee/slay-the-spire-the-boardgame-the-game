import { useLayoutEffect, useState } from 'react'
import { potionDef } from '../game/relics.ts'
import { healingCapFor } from '../game/run.ts'
import { potionIconPath } from '../game/assets.ts'
import type { Player } from '../game/types.ts'
import { ItemImage } from './ItemImage.tsx'

type Props = {
  players: Player[]
  viewerId: string
  potionLimit: number
  onTrade: (potionId: string, playerId: string) => void
  onUse: (potionId: string, replacePotionId?: string) => void
}

/** Potions are the only tradeable component, and only outside combat (p.8). */
export function OutsidePotionBar({ players, viewerId, potionLimit, onTrade, onUse }: Props) {
  const [giving, setGiving] = useState<{ index: number; id: string; context: string } | null>(null)
  const [replacing, setReplacing] = useState<{ index: number; id: string; context: string } | null>(null)
  const viewer = players.find((player) => player.id === viewerId)
  const viewerDead = viewer?.dead ?? true
  const inventory = viewer?.potions.join('\0') ?? ''
  const recipients = viewerDead ? [] : players.filter((player) => player.id !== viewerId && !player.dead &&
    player.potions.length < potionLimit && !player.relics.some((relic) => relic.defId === 'sozu'))
  const recipientIds = recipients.map((player) => player.id).join('\0')
  const sozu = viewer?.relics.some((relic) => relic.defId === 'sozu') ?? false
  const inventoryContext = `${viewerId}\0${inventory}\0${sozu}\0${viewerDead}`
  const giveContext = `${inventoryContext}\0${recipientIds}`
  useLayoutEffect(() => {
    setGiving(null)
    setReplacing(null)
  }, [viewerId, inventory, recipientIds, sozu, viewerDead])
  if (!viewer?.potions.length) return null
  return <aside className="outside-potions" aria-label="Potion inventory">
    <strong>Potions</strong>
    {viewer.potions.map((id, index) => <div className="outside-potions__item" key={`${id}-${index}`}>
      <span><img className="item-icon-image" src={potionIconPath(id)} alt="" />{potionDef(id).name}</span>
      {id === 'blood_potion' ? <button type="button" aria-label={`Use ${potionDef(id).name}`}
        disabled={viewerDead || viewer.hp >= healingCapFor(viewer)} onClick={() => onUse(id)}>Use</button> : null}
      {id === 'entropic_brew' ? <button type="button" aria-label={`Use ${potionDef(id).name}`}
        aria-expanded={!sozu && viewer.potions.length - 1 + 2 > potionLimit
          ? replacing?.context === inventoryContext && replacing.index === index && replacing.id === id : undefined}
        disabled={viewerDead} onClick={() => {
        if (sozu || viewer.potions.length - 1 + 2 <= potionLimit) onUse(id)
        else setReplacing(replacing?.context === inventoryContext && replacing.index === index && replacing.id === id
          ? null : { index, id, context: inventoryContext })
      }}>Use</button> : null}
      {id === 'entropic_brew' && !viewerDead && !sozu && replacing?.context === inventoryContext && replacing.index === index && replacing.id === id
        ? <div className="outside-potions__targets">
        {viewer.potions.filter((held) => held !== 'entropic_brew').map((held, heldIndex) =>
          <button type="button" key={`${held}:${heldIndex}`} onClick={() => {
            onUse(id, held); setReplacing(null)
          }}><ItemImage kind="potion" id={held} card />Replace {potionDef(held).name}</button>)}
      </div> : null}
      <button type="button" aria-label={`Give ${potionDef(id).name}`} disabled={recipients.length === 0}
        aria-expanded={recipients.length > 0
          ? giving?.context === giveContext && giving.index === index && giving.id === id : undefined} onClick={() =>
        setGiving(giving?.context === giveContext && giving.index === index && giving.id === id
          ? null : { index, id, context: giveContext })}>Give</button>
      {recipients.length > 0 && giving?.context === giveContext && giving.index === index && giving.id === id
        ? <div className="outside-potions__targets">
        {recipients.map((player) =>
          <button type="button" key={player.id} onClick={() => { onTrade(id, player.id); setGiving(null) }}>
            Give to {player.name}
          </button>)}
      </div> : null}
    </div>)}
  </aside>
}
