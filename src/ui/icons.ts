// Icon names and helpers, kept free of JSX so the verify scripts can import
// them directly through Node's type stripping, which cannot parse .tsx.

import { assetPath } from '../game/assets.ts'

export type IconName =
  | 'attack'
  | 'block'
  | 'strength'
  | 'vulnerable'
  | 'weak'
  | 'poison'
  | 'daze'
  | 'burn'
  | 'shiv'
  | 'miracle'
  | 'energy'
  | 'potion'
  | 'gold'
  | 'relic'
  | 'elite'
  | 'monster'
  | 'boss'
  | 'aoe'
  | 'die1'
  | 'die2'
  | 'die3'
  | 'die4'
  | 'die5'
  | 'die6'

export type StatusIconName =
  | 'attack'
  | 'aoe'
  | 'block'
  | 'burn'
  | 'draw'
  | 'energy'
  | 'miracle'
  | 'orb'
  | 'poison'
  | 'power'
  | 'shiv'
  | 'strength'
  | 'vulnerable'
  | 'weak'

export const ICON_LABELS: Record<IconName, string> = {
  attack: 'Attack',
  block: 'Block',
  strength: 'Strength',
  vulnerable: 'Vulnerable',
  weak: 'Weak',
  poison: 'Poison',
  daze: 'Daze',
  burn: 'Burn',
  shiv: 'Shiv',
  miracle: 'Miracle',
  energy: 'Energy',
  potion: 'Potion',
  gold: 'Gold',
  relic: 'Relic',
  elite: 'Elite',
  monster: 'Monster',
  boss: 'Boss',
  aoe: 'All in a row',
  die1: 'Die showing 1',
  die2: 'Die showing 2',
  die3: 'Die showing 3',
  die4: 'Die showing 4',
  die5: 'Die showing 5',
  die6: 'Die showing 6',
}

/** The die face for a roll, clamped to the six faces a d6 actually has. */
export function dieIcon(value: number): IconName {
  const face = Math.min(6, Math.max(1, Math.trunc(value)))
  return `die${face}` as IconName
}

export const iconPath = (name: IconName): string => assetPath(`icons/${name}.png`)
export const statusIconPath = (name: StatusIconName): string => assetPath(`status-icons/${name}.png`)
