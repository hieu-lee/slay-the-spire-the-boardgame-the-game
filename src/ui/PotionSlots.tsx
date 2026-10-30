import type { ReactNode } from 'react'
import { potionLimit } from '../game/acquisition.ts'
import type { Player } from '../game/types.ts'
import { PotionIcon } from './PotionIcon.tsx'

/** Persistent inventory; action-capable screens supply their existing potion controls. */
export function PotionSlots({ player, ascension, children, disabled = false }: {
  player: Pick<Player, 'potions' | 'relics'>
  ascension: number
  children?: ReactNode
  disabled?: boolean
}) {
  const capacity = potionLimit(ascension, player)
  const slots = Math.max(3, capacity, player.potions.length)
  return <aside className="outside-potions" aria-label="Potion inventory" aria-disabled={disabled || undefined}>
    {children ?? player.potions.map((id, index) =>
      <div className="outside-potions__item" key={`${id}-${index}`}><PotionIcon id={id} /></div>)}
    {Array.from({ length: slots - player.potions.length }, (_, empty) => {
      const index = player.potions.length + empty
      const locked = index >= capacity
      const label = locked ? `Potion slot ${index + 1} unavailable at this Ascension` : `Empty potion slot ${index + 1}`
      return <div className="outside-potions__item" key={`empty-${index}`}>
        <span className="outside-potions__empty" data-locked={locked || undefined} role="img" aria-label={label} title={label}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M9 3h6M10 3v6l-5 8a3 3 0 0 0 3 4h8a3 3 0 0 0 3-4l-5-8V3M8 15h8" />
          </svg>
        </span>
      </div>
    })}
  </aside>
}
