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

/** Orb order matters when the Defect Evokes, so slots get their own uncrowded rail. */
export function OrbRow({ orbs }: { orbs: (string | null)[] }) {
  if (orbs.length === 0) return null
  return (
    <span className="orbs">
      {orbs.map((orb, index) => (
        <span
          className={`token token--orb token--orb-${orb ?? 'empty'}`}
          key={index}
          title={orb ?? 'Empty Orb slot'}
        />
      ))}
    </span>
  )
}
