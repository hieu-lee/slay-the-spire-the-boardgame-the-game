import { Icon } from './Icon.tsx'
import type { IconName } from './Icon.tsx'

type TokenRowProps = {
  block?: number
  strength?: number
  vulnerable?: number
  weak?: number
  poison?: number
  shivs?: number
  miracles?: number
}

const TOKENS: { key: keyof TokenRowProps; icon: IconName; label: string }[] = [
  { key: 'block', icon: 'block', label: 'Block' },
  { key: 'strength', icon: 'strength', label: 'Strength' },
  { key: 'vulnerable', icon: 'vulnerable', label: 'Vulnerable' },
  { key: 'weak', icon: 'weak', label: 'Weak' },
  { key: 'poison', icon: 'poison', label: 'Poison' },
  { key: 'shivs', icon: 'shiv', label: 'Shivs' },
  { key: 'miracles', icon: 'miracle', label: 'Miracles' },
]

/** Shows only the tokens actually present, so an empty board stays quiet. */
export function TokenRow(props: TokenRowProps) {
  const present = TOKENS.filter(({ key }) => (props[key] ?? 0) > 0)
  if (present.length === 0) return null

  return (
    <span className="tokens">
      {present.map(({ key, icon, label }) => (
        <span key={key} className={`token token--${key}`} title={`${label} ${props[key]}`}>
          <Icon name={icon} size={18} />
          <span className="token__count">{props[key]}</span>
          <span className="visually-hidden">{`${label} ${props[key]}`}</span>
        </span>
      ))}
    </span>
  )
}
