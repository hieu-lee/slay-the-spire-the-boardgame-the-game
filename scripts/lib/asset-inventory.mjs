// Asset roots, inventories and budgets shared by verify-assets.mjs (fast inventory) and verify-art-bakes.mjs (slow
// re-bakes and pixel audits).
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { SKIN_IDS, SKIN_TRAITS } from '../../src/game/skins.ts'

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const publicRoot = join(repoRoot, 'public')

export const listing = (dir, extension) =>
  existsSync(dir) ? readdirSync(dir).filter((file) => file.endsWith(extension)) : []

export const cardRoot = join(publicRoot, 'assets/cards')
export const cardThumbRoot = join(publicRoot, 'assets/cards-sm')
export const socketedCardThumbRoot = join(publicRoot, 'assets/cards-socketed-sm')
export const cardArtRoot = join(publicRoot, 'assets/card-art')
export const iconRoot = join(publicRoot, 'assets/icons')
export const enemyRoot = join(publicRoot, 'assets/enemies')
export const combatEnemyRoot = join(publicRoot, 'assets/combat/enemies')
const combatRiggedRoot = join(publicRoot, 'assets/combat/rigged')
const bossAnimationRoot = join(combatEnemyRoot, 'animations')
export const bossProjectileRoot = join(combatEnemyRoot, 'projectiles')
export const combatCharacterRoot = join(publicRoot, 'assets/combat/characters')
export const combatSlimeRoot = join(publicRoot, 'assets/combat/slimes')
export const merchantCharacterRoot = join(publicRoot, 'assets/noncombat/merchant/characters')
export const combatVfxRoot = join(publicRoot, 'assets/combat/vfx')
export const combatActionVfxRoot = join(combatVfxRoot, 'actions')
export const combatPileRoot = join(publicRoot, 'assets/combat/piles')
export const combatStageRoot = join(publicRoot, 'assets/combat')
export const statusIconRoot = join(publicRoot, 'assets/status-icons')
export const powerIconRoot = join(publicRoot, 'assets/power-icons')
export const relicIconRoot = join(publicRoot, 'assets/relic-icons')
export const potionIconRoot = join(publicRoot, 'assets/potion-icons')
export const menuRoot = join(publicRoot, 'assets/menu')
export const compendiumIconRoot = join(menuRoot, 'compendium-icons')
export const campfireRoot = join(publicRoot, 'assets/noncombat/campfire')
export const fontRoot = join(publicRoot, 'assets/fonts')
export const sfxRoot = join(publicRoot, 'assets/sfx')

export const cardFiles = listing(cardRoot, '.webp')
export const cardThumbFiles = listing(cardThumbRoot, '.webp')
export const socketedCardThumbFiles = listing(socketedCardThumbRoot, '.webp')
// Per-hero art is keyed by visual id (VISUAL_IDS): every character, plus every skin
// (which wears a character's slot with its own art, named by the skin id).
export const CARD_ART_OWNERS = ['ironclad', 'silent', 'defect', 'watcher']
export const DOWNFALL_CARD_OWNERS = ['slime_boss', 'guardian', 'hexaghost', 'hermit']
export const cardArtFiles = CARD_ART_OWNERS.flatMap((owner) =>
  listing(join(cardArtRoot, owner), '.webp').map((file) => `${owner}/${file}`))
export const iconFiles = listing(iconRoot, '.png')
export const enemyFiles = listing(enemyRoot, '.webp')
export const combatEnemyFiles = listing(combatEnemyRoot, '.webp')
// Enemies always paint WebP/APNG in Safari (EnemyCard forces it); only heroes ship HEVC companions.
export const combatRiggedFiles = listing(combatRiggedRoot, '.webp').filter((file) => file.startsWith('hero-'))
export const combatRiggedVideoFiles = listing(combatRiggedRoot, '.mov')
export const bossAnimationFiles = listing(bossAnimationRoot, '.webp')
export const bossProjectileFiles = listing(bossProjectileRoot, '.webp')
export const combatCharacterFiles = listing(combatCharacterRoot, '.webp')
export const combatSlimeFiles = listing(combatSlimeRoot, '.webp')
export const merchantCharacterFiles = listing(merchantCharacterRoot, '-standing.webp')
export const combatVfxFiles = listing(combatVfxRoot, '.webp')
export const combatActionVfxFiles = listing(combatActionVfxRoot, '.webp')
export const combatPileFiles = listing(combatPileRoot, '.webp')
export const statusIconFiles = listing(statusIconRoot, '.png')
export const powerIconFiles = listing(powerIconRoot, '.png')
export const relicIconFiles = listing(relicIconRoot, '.png')
// The official prototype's Hexaghost starting component is unlabeled and has
// no publisher icon. A locally generated placeholder may exist, but runtime
// correctness and clean-clone verification must not depend on it.
const optionalRelicIconFiles = new Set(['hexaghost_starting_relic.png'])
export const requiredRelicIconFiles = relicIconFiles.filter((file) => !optionalRelicIconFiles.has(file))
export const potionIconFiles = listing(potionIconRoot, '.png')
export const compendiumIconFiles = listing(compendiumIconRoot, '.webp')

export const SLIME_ASSET_SLUGS = [
  'armored', 'bruiser', 'evolution', 'leeching', 'massive', 'muscle', 'psychic',
  'royal', 'scrappy', 'spike', 'spreading', 'sticky', 'taunting',
]

export const cardIndex = JSON.parse(readFileSync(join(repoRoot, 'data/card-index.json'), 'utf8'))

/**
 * Longest-edge [floor, cap] in pixels for the runtime art below, as
 * `[floor, cap]` pairs.
 *
 * The cap matters as much as the floor. Decoded image memory is width x height
 * x 4 bytes regardless of how small the element is on screen, and iOS Safari
 * evicts and re-decodes under pressure — which is a stutter, not a slow load.
 * A 1326x1187 pile icon painted into a 41px box cost 6 MB of texture to draw
 * 41 pixels; the combat screen alone held 59 MB that way. Each cap below is
 * the widest CSS box the asset is ever painted into, times three for a
 * DPR-3 screen, rounded up to a power of two.
 *
 *   pile stacks / current deck  .pile__stack, 2.55rem       -> 41 CSS px
 *   enemy cutouts               .enemy__portrait             -> 146 CSS px
 *   die faces                   Icon size={26}               -> 26 CSS px
 *
 * The enemy figure is measured, not read off a rule: `.row__enemies` declares
 * `minmax(190px, 250px)` columns, but a later unconditional
 * `.row__enemies { display: contents }` takes the enemies out of that grid, so
 * the portrait is sized by `.enemy` under `.board` instead. Measured at 146 CSS
 * px across seven viewports from 900x600 to 3440x1440 and one to four enemies.
 *
 * Character cutouts keep their full resolution: the character-select hero
 * paints one at `max-height: 62vh`.
 */
export const PILE_ICON_EDGE = [160, 256]
export const ENEMY_CUTOUT_EDGE = [256, 1024]
export const BOSS_ELITE_CUTOUT_EDGE = [256, 1024]
/** Only the `-hero` pair, painted by the character-select and Neow scenes. */
export const CHARACTER_HERO_EDGE = [700, 1536]
/** Every other character cutout: combat seats, roster thumbs, lobby seats. */
export const CHARACTER_CUTOUT_EDGE = [256, 1024]
export const MERCHANT_CHARACTER_EDGE = [256, 576]
export const DIE_ICON_EDGE = 128
/** Matches THUMB_WIDTH in scripts/sync-card-assets.mjs. */
export const CARD_THUMB_WIDTH = 448

/** Every icon name Icon.tsx can render. */
export const REQUIRED_ICONS = [
  'attack', 'block', 'strength', 'vulnerable', 'weak', 'poison', 'daze', 'burn',
  'shiv', 'miracle', 'energy', 'potion', 'gold', 'relic', 'elite', 'monster',
  'boss', 'aoe', 'die1', 'die2', 'die3', 'die4', 'die5', 'die6',
]

export const stagedSkins = SKIN_IDS.filter((id) => SKIN_TRAITS[id].stagedAttack)
export const skinConfigs = Object.fromEntries(readdirSync(join(repoRoot, 'scripts/animation/skins')).filter((file) => file.endsWith('.json'))
  .map((file) => [file.slice(0, -'.json'.length), JSON.parse(readFileSync(join(repoRoot, 'scripts/animation/skins', file), 'utf8'))]))
