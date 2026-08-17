// Maps a card definition to its scanned artwork.
//
// The asset key is derived from the card's pool and name rather than stored per
// card, so adding a card to cards.ts does not also mean editing a lookup table.
// scripts/verify-assets.mjs proves every card resolves to a file that exists.
import type { CardDef } from './cards.ts'
import type { EnemyDef } from './enemies.ts'
import type { PotionDef, RelicDef } from './relics.ts'

/** Where the sync script writes, and where the client reads from. */
export const CARD_ASSET_ROOT = '/assets/cards'
export const CARD_ART_ROOT = '/assets/card-art'

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

export function relicCardImagePath(def: RelicDef): string {
  const name = def.id === 'ring_of_serpent' ? 'ring-of-the-serpent' : slugify(def.name)
  return `${CARD_ASSET_ROOT}/relics__${def.pool === 'boss' ? 'boss__' : ''}${name}.webp`
}

export function potionCardImagePath(def: PotionDef): string {
  const name = def.id === 'gamblers_brew' ? 'gambler-s-potion' : slugify(def.name)
  return `${CARD_ASSET_ROOT}/potions__${name}.webp`
}

export const relicIconPath = (id: string) => `/assets/relic-icons/${id}.png`
export const potionIconPath = (id: string) => `/assets/potion-icons/${id}.png`

/**
 * The tier directory a card's scan lives in. Player cards are filed by rarity:
 * starters together, rares together, everything else under `normal`.
 *
 * `normal` is a FILING category, not a rarity. Common and uncommon cards share
 * a directory here, but they are distinct on the table and the cards say so:
 * the banner across the top is silver on a common, teal on an uncommon and
 * gold on a rare. Do not read this directory layout back as the game's
 * vocabulary — `data/raw/player-cards.csv` lists the printed rarity, and the
 * reward decks are built from it.
 */
export function tierOf(def: CardDef): string {
  if (def.id === 'ascenders_bane') return 'ascension'
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

/** Committed, text-free artwork shared by the base and upgraded CSS faces. */
export function cardArtPath(def: CardDef): string {
  return `${CARD_ART_ROOT}/${def.owner}/${def.id}.webp`
}

export function enemyImagePath(def: EnemyDef): string {
  const artId = def.artId ?? def.id
  return `/assets/combat/enemies/${artId}.webp`
}
