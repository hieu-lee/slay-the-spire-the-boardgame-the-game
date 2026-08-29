// The data behind the end-of-run summary, kept out of the component.
//
// Not an abstraction for its own sake: `deckHighlights` is the one piece of
// non-trivial logic on that screen, and Node can strip types from `.ts` but not
// JSX from `.tsx`, so a plain `verify-*.mjs` can only import it from here.
// Living next to the component it feeds, in the same directory.
import { cardDef, faceOf } from '../game/cards.ts'
import type { DamageStats, Player, RelicInstance } from '../game/types.ts'

export const CHARACTER_LABEL: Record<string, string> = {
  ironclad: 'Ironclad',
  silent: 'Silent',
  defect: 'Defect',
  watcher: 'Watcher',
}

/** The seat as the summary needs it, so the online shell can pass a redacted one. */
export type SummarySeat = {
  id: string
  name: string
  character: string
  hp: number
  maxHp: number
  gold: number
  dead: boolean
  relics: readonly RelicInstance[]
  damageStats?: DamageStats
  /** Absent online, where the server does not send other seats' decks. */
  deck?: readonly { defId: string; upgraded: boolean }[]
}

export function summarySeat(player: Player): SummarySeat {
  return {
    id: player.id,
    name: player.name,
    character: player.character,
    hp: player.hp,
    maxHp: player.maxHp,
    gold: player.gold,
    dead: player.dead,
    relics: player.relics,
    damageStats: player.damageStats,
    deck: player.deck,
  }
}

export function damageTotals(stats?: DamageStats): DamageStats & { dealt: number; received: number } {
  const value = (key: keyof DamageStats) => Math.max(0, Math.floor(stats?.[key] ?? 0))
  const attack = value('attack')
  const poison = value('poison')
  const special = value('special')
  const taken = value('taken')
  const blocked = value('blocked')
  return { attack, poison, special, taken, blocked, dealt: attack + poison + special, received: taken + blocked }
}

/**
 * The three or four cards a deck leans on, most-copied first.
 *
 * A full decklist at the end of a run is 30-odd rows nobody reads. The shape of
 * a deck is in its repeats — six Strikes is a different run from six Shivs —
 * so this counts duplicates and shows only what the player actually doubled
 * down on. Singletons are dropped: they say nothing about the build.
 *
 * The name tie-break is not cosmetic: without it two cards with equal counts
 * would order by insertion, so the same finished deck could summarise
 * differently depending on the order it happened to be assembled in.
 */
export function deckHighlights(
  deck: readonly { defId: string; upgraded?: boolean }[],
  limit = 4,
): { name: string; count: number }[] {
  // Keyed on the upgrade too, not just the id. Counting by id alone reported a
  // deck of four Strikes and one Strike+ as "5x Strike", so the upgrade the
  // player spent a campfire on vanished from the one screen that sums the run
  // up. They are different cards on the table and they read as different here.
  const counts = new Map<string, { name: string; count: number }>()
  for (const card of deck) {
    const key = `${card.defId}:${card.upgraded ? 'up' : 'base'}`
    const existing = counts.get(key)
    if (existing) existing.count += 1
    else counts.set(key, { name: faceOf(cardDef(card.defId), Boolean(card.upgraded)).name, count: 1 })
  }
  return [...counts.values()]
    .filter((entry) => entry.count > 1)
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
    .slice(0, limit)
}
