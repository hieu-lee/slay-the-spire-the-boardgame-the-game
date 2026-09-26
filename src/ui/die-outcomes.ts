import type { EventEffect } from '../game/events.ts'
import type { IconName } from './icons.ts'

export type DieFace = 1 | 2 | 3 | 4 | 5 | 6
export const DIE_FACES: readonly DieFace[] = [1, 2, 3, 4, 5, 6]

/** One face's result, short enough to sit under a die pip. */
export type DieOutcome = { icon?: IconName; text: string; label: string; tone: 'good' | 'bad' | 'plain' }

const NONE: DieOutcome = { text: '—', label: 'Nothing', tone: 'plain' }

function amountOf(effect: EventEffect): number {
  return typeof effect.amount === 'number' ? effect.amount : 1
}

function outcomeOf(effect: EventEffect): DieOutcome | null {
  switch (effect.tag) {
    case 'gain-potion': return { icon: 'potion', text: effect.count && effect.count > 1 ? `×${effect.count}` : '', label: 'Potion', tone: 'good' }
    case 'gain-relic': return { icon: 'relic', text: '', label: 'Relic', tone: 'good' }
    case 'gain-gold': return { icon: 'gold', text: `+${amountOf(effect)}`, label: `${amountOf(effect)} Gold`, tone: 'good' }
    case 'full-heal': return { text: '♥', label: 'Heal to full', tone: 'good' }
    case 'remove-card': return { text: 'Remove', label: 'Remove a card', tone: 'good' }
    case 'gain-curse': return { text: 'Curse', label: 'Curse', tone: 'bad' }
    case 'lose-hp': return { text: `−${amountOf(effect)}♥`, label: `Lose ${amountOf(effect)} HP`, tone: 'bad' }
    case 'combat': return effect.room === 'elite'
      ? { icon: 'elite', text: '', label: 'Elite fight', tone: 'bad' }
      : { icon: 'monster', text: '', label: 'Fight', tone: 'bad' }
    case 'nothing': return effect.filter === 'repeat-or-leave'
      ? { text: '↻', label: 'Reach again or leave', tone: 'plain' }
      : null
    default: return null
  }
}

/** Every face of a printed d6 table, the empty ones included. */
export function dieOutcomes(results: EventEffect['results']): Record<DieFace, DieOutcome> {
  return Object.fromEntries(DIE_FACES.map((face) => [face,
    (results?.[face] ?? []).map(outcomeOf).find((outcome) => outcome !== null) ?? NONE])) as Record<DieFace, DieOutcome>
}

/** The first die table among the chosen options, if any of them roll. */
export function rolledTable(options: readonly { id: string; effects: readonly EventEffect[] }[], optionIds: readonly string[]): EventEffect['results'] {
  const chosen = options.length === 1 ? options : options.filter((option) => optionIds.includes(option.id))
  return chosen.flatMap((option) => option.effects).find((effect) => effect.tag === 'roll-d6')?.results
}
