import { useLayoutEffect, useState } from 'react'
import { potionDef } from '../game/relics.ts'
import { healingCapFor } from '../game/run.ts'
import type { Player } from '../game/types.ts'
import { ItemImage } from './ItemImage.tsx'
import { PotionIcon, PotionTooltipAnchor } from './PotionIcon.tsx'

type Props = {
  players: Player[]
  viewerId: string
  potionLimit: number
  disabled?: boolean
  onTrade: (potionId: string, playerId: string) => void
  onUse: (potionId: string, replacePotionId?: string) => void
}

/** Potions are the only tradeable component, and only outside combat (p.8). */
export function OutsidePotionBar({ players, viewerId, potionLimit, disabled = false, onTrade, onUse }: Props) {
  const [giving, setGiving] = useState<{ index: number; id: string; context: string } | null>(null)
  const [replacing, setReplacing] = useState<{ index: number; id: string; context: string } | null>(null)
  const viewer = players.find((player) => player.id === viewerId)
  const viewerDead = viewer?.dead ?? true
  const unavailable = viewerDead || disabled
  const inventory = viewer?.potions.join('\0') ?? ''
  const recipients = unavailable ? [] : players.filter((player) => player.id !== viewerId && !player.dead &&
    player.potions.length < potionLimit && !player.relics.some((relic) => relic.defId === 'sozu'))
  const recipientIds = recipients.map((player) => player.id).join('\0')
  const sozu = viewer?.relics.some((relic) => relic.defId === 'sozu') ?? false
  const inventoryContext = `${viewerId}\0${inventory}\0${sozu}\0${unavailable}`
  const giveContext = `${inventoryContext}\0${recipientIds}`
  useLayoutEffect(() => {
    setGiving(null)
    setReplacing(null)
  }, [viewerId, inventory, recipientIds, sozu, unavailable])
  // Whether this item's replacement chooser is already open. Its button toggles,
  // so with the chooser up the next press only collapses it — free and
  // reversible, which is nothing to read first and nothing to promise.
  const choosingReplacement = (index: number, id: string) =>
    replacing?.context === inventoryContext && replacing.index === index && replacing.id === id
  if (!viewer?.potions.length) return null
  return <aside className="outside-potions" aria-label="Potion inventory" aria-disabled={disabled || undefined}>
    <strong>Potions</strong>
    {viewer.potions.map((id, index) => <div className="outside-potions__item" key={`${id}-${index}`}>
      {id !== 'blood_potion' && id !== 'entropic_brew' ? <PotionIcon id={id} /> : null}
      {/* The anchor WRAPS the button rather than sitting inside it, the way the
          combat action bar arranges the same pair. That nesting is what lets the
          anchor gate its own button on a device with no hover, so the potion's
          rules are read before it is irreversibly drunk — nested the other way
          round the anchor cannot tell the press apart from a tap on somebody
          else's control, and the belt kept spending potions on first touch. */}
      {id === 'blood_potion' ? <PotionTooltipAnchor id={id} confirmLabel="drink">
        <button type="button" aria-label={`Use ${potionDef(id).name}`}
          title={`Use ${potionDef(id).name}`} disabled={unavailable || viewer.hp >= healingCapFor(viewer)}
          onClick={() => onUse(id)}><ItemImage kind="potion" id={id} /></button>
      </PotionTooltipAnchor> : null}
      {/* Entropic Brew only drinks when there is room for what it pours; on a
          full belt the committing tap opens the replacement chooser instead,
          and the panel has to say which of the two it is about to do. */}
      {id === 'entropic_brew' ? <PotionTooltipAnchor id={id}
        confirmLabel={sozu || viewer.potions.length - 1 + 2 <= potionLimit ? 'drink'
          : choosingReplacement(index, id) ? undefined : 'choose a replacement'}>
        <button type="button" aria-label={`Use ${potionDef(id).name}`}
          aria-expanded={!sozu && viewer.potions.length - 1 + 2 > potionLimit
            ? replacing?.context === inventoryContext && replacing.index === index && replacing.id === id : undefined}
          title={`Use ${potionDef(id).name}`} disabled={unavailable} onClick={() => {
          if (sozu || viewer.potions.length - 1 + 2 <= potionLimit) onUse(id)
          else setReplacing(replacing?.context === inventoryContext && replacing.index === index && replacing.id === id
            ? null : { index, id, context: inventoryContext })
        }}><ItemImage kind="potion" id={id} /></button>
      </PotionTooltipAnchor> : null}
      {id === 'entropic_brew' && !unavailable && !sozu && replacing?.context === inventoryContext && replacing.index === index && replacing.id === id
        ? <div className="outside-potions__targets">
        {viewer.potions.filter((held) => held !== 'entropic_brew').map((held, heldIndex) =>
          <button type="button" key={`${held}:${heldIndex}`} onClick={() => {
            onUse(id, held); setReplacing(null)
          }}><ItemImage kind="potion" id={held} />Replace {potionDef(held).name}</button>)}
      </div> : null}
      <button type="button" className="outside-potions__give" aria-label={`Give ${potionDef(id).name}`}
        title={`Give ${potionDef(id).name}`} disabled={recipients.length === 0}
        aria-expanded={recipients.length > 0
          ? giving?.context === giveContext && giving.index === index && giving.id === id : undefined} onClick={() =>
        setGiving(giving?.context === giveContext && giving.index === index && giving.id === id
          ? null : { index, id, context: giveContext })}><span aria-hidden="true">⇢</span></button>
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
