// The board game's own symbols, extracted from the rulebook by
// scripts/sync-icons.mjs. Emoji were a placeholder and a bad one: ⚔ falls back
// to a multiplication sign in several fonts, and none of them are this game's
// visual language.
//
// Names and helpers live in ./icons.ts so verify scripts can import them; Node's
// type stripping cannot parse JSX.
import { useEffect, useState } from 'react'
import { ICON_LABELS, dieIcon, iconPath, statusIconPath } from './icons.ts'
import type { IconName, StatusIconName } from './icons.ts'

export { dieIcon }
export type { IconName }
export type { StatusIconName }

const LABELS = ICON_LABELS

const FALLBACKS: Partial<Record<IconName, StatusIconName>> = {
  attack: 'attack', block: 'block', strength: 'strength', vulnerable: 'vulnerable',
  weak: 'weak', poison: 'poison', daze: 'draw', burn: 'burn', shiv: 'shiv',
  miracle: 'miracle', energy: 'energy', potion: 'poison', gold: 'energy', relic: 'power',
  elite: 'strength', monster: 'attack', boss: 'power', aoe: 'aoe',
}

type IconProps = {
  name: IconName
  size?: number
  /** Decorative icons sit next to their own number and are hidden from AT. */
  decorative?: boolean
}

export function Icon({ name, size = 20, decorative = true }: IconProps) {
  const [missing, setMissing] = useState(false)
  useEffect(() => setMissing(false), [name])
  const fallback = FALLBACKS[name]
  const die = name.startsWith('die') ? name.slice(3) : null

  if (missing && !fallback) {
    return (
      <span
        className="icon icon--native"
        style={{ width: size, height: size, fontSize: size * 0.68 }}
        aria-label={decorative ? undefined : LABELS[name]}
        aria-hidden={decorative ? 'true' : undefined}
      >
        {die}
      </span>
    )
  }

  // Drawn as an image, in its own colours. These are full-colour printed
  // symbols — a blue shield, a gold bicep, an orange flame — so recolouring
  // them from a single-channel mask both threw the colour away and left the
  // palest of them almost invisible. What actually needed removing was the
  // white PAPER behind them, which sync-icons.mjs now keys out.
  return (
    <img
      className="icon"
      src={missing && fallback ? statusIconPath(fallback) : iconPath(name)}
      width={size}
      height={size}
      alt={decorative ? '' : LABELS[name]}
      aria-hidden={decorative ? 'true' : undefined}
      draggable={false}
      onError={() => setMissing(true)}
    />
  )
}

export function StatusIcon({ name, size = 22 }: { name: StatusIconName; size?: number }) {
  return (
    <img
      className="icon icon--status"
      src={statusIconPath(name)}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  )
}

/** An icon with a number beside it, which is how the cards themselves read. */
export function IconValue({
  name,
  value,
  size = 20,
  prefix = '',
}: {
  name: IconName
  value: number | string
  size?: number
  prefix?: string
}) {
  return (
    <span className="icon-value">
      <span className="icon-value__number">
        {prefix}
        {value}
      </span>
      <Icon name={name} size={size} />
      <span className="visually-hidden">{` ${LABELS[name]}`}</span>
    </span>
  )
}
