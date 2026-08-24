import type { CSSProperties } from 'react'
import type { OrbType, Player } from '../game/types.ts'
import { StatusIcon } from './Icon.tsx'
import type { StatusIconName } from './Icon.tsx'

type TokenRowProps = {
  block?: number
  strength?: number
  vulnerable?: number
  weak?: number
  poison?: number
  shivs?: number
  miracles?: number
  clawCubes?: number
}

type CountKey = keyof TokenRowProps

const TOKENS: { key: CountKey; icon: StatusIconName; label: string }[] = [
  { key: 'block', icon: 'block', label: 'Block' },
  { key: 'strength', icon: 'strength', label: 'Strength' },
  { key: 'vulnerable', icon: 'vulnerable', label: 'Vulnerable' },
  { key: 'weak', icon: 'weak', label: 'Weak' },
  { key: 'poison', icon: 'poison', label: 'Poison' },
  { key: 'shivs', icon: 'shiv', label: 'Shivs' },
  { key: 'miracles', icon: 'miracle', label: 'Miracles' },
  { key: 'clawCubes', icon: 'attack', label: 'Claw cubes' },
]

/** Shows public combat tokens beside HP. */
export function TokenRow(props: TokenRowProps) {
  const present = TOKENS.filter(({ key }) => (props[key] ?? 0) > 0)
  if (present.length === 0) return null

  return (
    <span className="tokens" aria-hidden="true">
      {present.map(({ key, icon, label }) => (
        <span key={key} className={`token token--${key}`} title={`${label} ${props[key]}`}>
          {/* No hidden label: describeSeat and describeEnemy already carry the
              announcement, while title exposes it to pointer users. */}
          <StatusIcon name={icon} />
          <span className="token__count">{props[key]}</span>
        </span>
      ))}
    </span>
  )
}

function orbDisplayValue(player: Player, orb: OrbType): number {
  if (orb === 'lightning') {
    return player.damageDealtZeroThisTurn ? 0
      : 1 + (player.orbEndTurnBonus ?? 0) + (player.lightningEndTurnBonus ?? 0)
  }
  if (orb === 'frost') return 1 + (player.orbEndTurnBonus ?? 0)
  return player.damageDealtZeroThisTurn ? 0
    : 3 + player.powers.length + (player.orbEvokeBonus ?? 0) + (player.darkOrbEvokeBonus ?? 0)
}

export function orbDisplayText(player: Player, orb: OrbType): string {
  const value = orbDisplayValue(player, orb)
  return orb === 'frost' ? `${value} Block at end of turn`
    : `${value} damage ${orb === 'dark' ? 'when Evoked' : 'at end of turn'}`
}

/** The original game floats Orb sprites and their current value around the Defect. */
export function OrbRow({ player }: { player: Player }) {
  const orbs = player.character === 'defect' ? player.orbs : player.orbs.filter((orb) => orb !== null)
  if (orbs.length === 0) return null
  return (
    <span className="orbs" aria-hidden="true"
      style={{ '--orb-count': orbs.length } as CSSProperties}>
      {orbs.map((orb, index) => {
        const value = orb ? orbDisplayValue(player, orb) : null
        return (
          <span
            className={`token token--orb token--orb-${orb ?? 'empty'}`}
            key={index}
            title={orb ? `${orb} Orb · ${orbDisplayText(player, orb)}` : 'Empty Orb slot'}
            style={{ '--orb-depth': Math.abs(index - (orbs.length - 1) / 2) } as CSSProperties}
          >
            {value !== null ? <span className="orb__value">{value}</span> : null}
          </span>
        )
      })}
    </span>
  )
}
