import { Icon } from './Icon.tsx'
import type { IconName } from './Icon.tsx'

type TokenRowProps = {
  /** Channelled orbs, shown in the order they sit in their slots. */
  orbs?: (string | null)[]
  block?: number
  strength?: number
  vulnerable?: number
  weak?: number
  poison?: number
  shivs?: number
  miracles?: number
}

type CountKey = Exclude<keyof TokenRowProps, 'orbs'>

const TOKENS: { key: CountKey; icon: IconName; label: string }[] = [
  { key: 'block', icon: 'block', label: 'Block' },
  { key: 'strength', icon: 'strength', label: 'Strength' },
  { key: 'vulnerable', icon: 'vulnerable', label: 'Vulnerable' },
  { key: 'weak', icon: 'weak', label: 'Weak' },
  { key: 'poison', icon: 'poison', label: 'Poison' },
  { key: 'shivs', icon: 'shiv', label: 'Shivs' },
  { key: 'miracles', icon: 'miracle', label: 'Miracles' },
]

/** Shows tokens and every Defect Orb slot, including empty capacity. */
export function TokenRow(props: TokenRowProps) {
  const present = TOKENS.filter(({ key }) => (props[key] ?? 0) > 0)
  const orbs = props.orbs ?? []
  if (present.length === 0 && orbs.length === 0) return null

  return (
    <span className="tokens">
      {/* Orbs are board state the log already talks about ("Defect's Lightning
          orb hit ... for 1"), so they have to be visible somewhere. */}
      {orbs.map((orb, index) => (
        // No hidden label here: the seat is a button with an aria-label, which
        // replaces its contents wholesale, so the announcement comes from
        // describeSeat. A span here would simply never be read.
        <span
          className={`token token--orb token--orb-${orb ?? 'empty'}`}
          key={index}
          title={orb ?? 'Empty Orb slot'}
        />
      ))}
      {present.map(({ key, icon, label }) => (
        <span key={key} className={`token token--${key}`} title={`${label} ${props[key]}`}>
          {/* No hidden label: both consumers are aria-labelled buttons, which
              replace their contents wholesale, so a span here is never read.
              describeSeat and describeEnemy carry the announcement instead. */}
          <Icon name={icon} size={18} />
          <span className="token__count">{props[key]}</span>
        </span>
      ))}
    </span>
  )
}
