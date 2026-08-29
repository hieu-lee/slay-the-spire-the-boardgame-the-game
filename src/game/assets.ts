// Maps a card definition to its scanned artwork.
//
// The asset key is derived from the card's pool and name rather than stored per
// card, so adding a card to cards.ts does not also mean editing a lookup table.
// scripts/verify-assets.mjs proves every card resolves to a file that exists.
import type { CardDef } from './cards.ts'
import type { EnemyDef } from './enemies.ts'
import type { PotionDef, RelicDef } from './relics.ts'
import { BASE_CHARACTER_IDS, type CharacterId } from './types.ts'

/** Public asset URL under Vite's current deployment base. */
export const assetPath = (path: string): string => `${import.meta.env?.BASE_URL ?? '/'}assets/${path}`

/** Where the sync script writes, and where the client reads from. */
export const CARD_ASSET_ROOT = assetPath('cards')
/**
 * The same scans at 448px, which is every card surface but the compendium's
 * zoom. Decoded image memory is width x height x 4 bytes no matter how small
 * the element is, so a full 744x1039 scan costs 3 MB of texture to paint a
 * 130px hand card — and opening the deck viewer on a ten-card starter deck
 * alone put 48 MB of it on a phone GPU, which iOS answers by evicting and
 * re-decoding mid-scroll. 448px covers the widest non-zoom surface (the 250px
 * card-reveal moment) at a phone's device pixel ratio.
 */
export const CARD_THUMB_ROOT = assetPath('cards-sm')
export const CARD_ART_ROOT = assetPath('card-art')

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

export const relicIconPath = (id: string) => assetPath(`relic-icons/${id.replace(/^downfall_/, '')}.png`)
export const potionIconPath = (id: string) => assetPath(`potion-icons/${id}.png`)

const CAMPFIRE_CHARACTER_ORDER: CharacterId[] = [...BASE_CHARACTER_IDS]
const BASE_CAMPFIRE_CHARACTERS = new Set<CharacterId>(BASE_CHARACTER_IDS)

export function campfireUsesCharacterCutouts(characters: CharacterId[]): boolean {
  return characters.some((character) => !BASE_CAMPFIRE_CHARACTERS.has(character))
}

export function campfireCharacterImagePath(character: CharacterId): string {
  return assetPath(`noncombat/campfire/${character}-back.webp`)
}

export function campfireScenePath(characters: CharacterId[]): string {
  if (campfireUsesCharacterCutouts(characters)) return assetPath('noncombat/campfire/empty_firecamp.png')
  const party = CAMPFIRE_CHARACTER_ORDER.filter((character) => characters.includes(character)).join('_')
  return assetPath(`noncombat/campfire/${party}_firecamp.png`)
}

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
  return `${CARD_ASSET_ROOT}/${cardAssetKey(def, upgraded)}.webp`
}

/**
 * The 448px scan. Prefer this everywhere except the compendium's full-screen
 * zoom, which is the one surface that paints a card larger than 448px.
 */
export function cardThumbPath(def: CardDef, upgraded: boolean): string {
  return `${CARD_THUMB_ROOT}/${cardAssetKey(def, upgraded)}.webp`
}

function cardAssetKey(def: CardDef, upgraded: boolean): string {
  return `${tierOf(def)}/${slugify(def.name)}${upgraded ? '+' : ''}`.replace(/\//g, '__')
}

/** Committed, text-free artwork shared by the base and upgraded CSS faces. */
export function cardArtPath(def: CardDef): string {
  return `${CARD_ART_ROOT}/${def.owner}/${def.id}.webp`
}

export function enemyImagePath(def: EnemyDef): string {
  const artId = def.artId ?? def.id
  return assetPath(`combat/enemies/${artId}.webp`)
}

export function bossAnimationImagePath(def: EnemyDef, pose: 'idle' | 'attack'): string {
  const artId = def.artId ?? def.id
  return assetPath(`combat/enemies/animations/${artId}-${pose}.webp`)
}

/**
 * The full-resolution cutout, for the two surfaces that paint a character
 * several hundred pixels tall: the character-select hero and the Neow scene.
 *
 * Everything else — the combat seat, the roster thumbnails, the lobby seat
 * list — reads `combat/characters/<id>.webp`, which is the same art at 512px.
 * That split is the point of having two files rather than a `srcset`: an
 * `<img srcset>` is allowed to reuse a larger candidate the browser already
 * holds, and the character-select hero puts one in the cache before combat
 * ever starts, so every seat inherited a 6 MB decode to draw a 145px
 * thumbnail. Distinct URLs cannot be substituted for each other.
 */
export function characterHeroArt(character: string): string {
  return `combat/characters/${character}-hero.webp`
}
