// Maps a card definition to its scanned artwork.
//
// The asset key is derived from the card's pool and name rather than stored per
// card, so adding a card to cards.ts does not also mean editing a lookup table.
// scripts/verify-assets.mjs proves every card resolves to a file that exists.
import type { CardDef } from './cards.ts'

/** Where the sync script writes, and where the client reads from. */
export const CARD_ASSET_ROOT = '/assets/cards'

const POOL_TIERS: Record<string, string> = {
  colorless: 'colourless',
  curse: 'curses',
  status: 'curses',
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
}

/**
 * The tier directory a card's scan lives in. Player cards are filed by rarity:
 * starters together, rares together, everything else under `normal`.
 */
export function tierOf(def: CardDef): string {
  const pooled = POOL_TIERS[def.owner]
  if (pooled) return pooled
  if (def.rarity === 'starter') return `${def.owner}/starter`
  if (def.rarity === 'rare') return `${def.owner}/rare`
  return `${def.owner}/normal`
}

/**
 * Path to a card's image. Upgraded faces are separate scans, since the upgraded
 * card is physically the reverse side rather than a recolour.
 */
export function cardImagePath(def: CardDef, upgraded: boolean): string {
  const key = `${tierOf(def)}/${slugify(def.name)}${upgraded ? '+' : ''}`.replace(/\//g, '__')
  return `${CARD_ASSET_ROOT}/${key}.webp`
}
