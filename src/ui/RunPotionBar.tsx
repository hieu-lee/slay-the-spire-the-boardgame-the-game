import { useState } from 'react'
import type { Player } from '../game/types.ts'
import { potionDef } from '../game/relics.ts'
import { Icon } from './Icon.tsx'

type Props = {
  player: Player
  players: Player[]
  ascension: number
  onUse: (potionId: string, discardPotionId?: string) => void
  onTrade: (potionId: string, toPlayerId: string) => void
}

/** Outside-combat potion use and the physical table's potion trading. */
export function RunPotionBar({ player, players, ascension, onUse, onTrade }: Props) {
  const [pending, setPending] = useState(false)
  const usable = player.potions.filter((id) => id === 'blood_potion' || id === 'entropic_brew')
  const cap = ascension >= 4 ? 2 : 3
  const recipients = players.filter((candidate) => !candidate.dead && candidate.id !== player.id && candidate.potions.length < cap)
  if (usable.length === 0 && (player.potions.length === 0 || recipients.length === 0)) return null
  const entropicNeedsDiscard = player.potions.length >= cap
  return (
    <div className="run-potions" aria-label="Potions outside combat">
      {[...new Set(usable)].map((id) => {
        const def = potionDef(id)
        return (
          <button type="button" key={id} title={def.text} onClick={() => {
            if (id === 'entropic_brew' && entropicNeedsDiscard) setPending(true)
            else onUse(id)
          }}>
            <Icon name="potion" size={16} /> Use {def.name}
          </button>
        )
      })}
      {recipients.flatMap((recipient) => [...new Set(player.potions)].map((id) => (
        <button type="button" key={`${recipient.id}-${id}`} title={potionDef(id).text}
          onClick={() => onTrade(id, recipient.id)}>
          Give {potionDef(id).name} to {recipient.name}
        </button>
      )))}
      {pending ? (
        <div className="run-potions__discard" role="group" aria-label="Choose a potion to discard">
          <span>Discard before drawing:</span>
          {[...new Set(player.potions.filter((_id, index) => index !== player.potions.indexOf('entropic_brew')))].map((id) => (
            <button type="button" key={id} onClick={() => { onUse('entropic_brew', id); setPending(false) }}>
              {potionDef(id).name}
            </button>
          ))}
          <button type="button" onClick={() => setPending(false)}>Cancel</button>
        </div>
      ) : null}
    </div>
  )
}
