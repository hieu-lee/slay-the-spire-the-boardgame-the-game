// Every card the engine knows must resolve to an image that exists on disk, and
// every image path must be a safe, normalised browser path. A missing asset is
// otherwise invisible until it renders as a broken box in a real game.
//
// Publisher card scans and reference crops remain optional local syncs.
// Runtime icons, illustrations, and combat cutouts are committed and required
// by the unconditional inventories below.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { CARDS, faceOf } from '../src/game/cards.ts'
import '../src/game/downfall/slime-boss.ts'
import {
  cardArtPath,
  cardImagePath,
  cardThumbPath,
  bossAnimationImagePath,
  campfireScenePath,
  enemyImagePath,
  relicIconPath,
  CARD_ART_ROOT,
  CARD_ASSET_ROOT,
  CARD_THUMB_ROOT,
} from '../src/game/assets.ts'
import { ENEMIES } from '../src/game/enemies.ts'
import { POTIONS, RELICS } from '../src/game/relics.ts'
import { bossAttackContactLeftFor, bossAttackScaleFor } from '../src/ui/combat-vfx.ts'
import { DOWNFALL_COLORLESS_CARD_DEFS } from '../src/game/downfall/items.ts'
// From the data module, NOT from sync-enemy-art.mjs: importing that script runs
// the extraction pipeline, which regenerated the very portraits this file
// checks for — so the check asserted its own side effect and could never fail.
import { ENEMY_ART } from './lib/enemy-art.mjs'
import { suite, check, assert, assertDeepEqual, assertEqual, report } from './lib/harness.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const publicRoot = join(repoRoot, 'public')

const listing = (dir, extension) =>
  existsSync(dir) ? readdirSync(dir).filter((file) => file.endsWith(extension)) : []

const cardRoot = join(publicRoot, 'assets/cards')
const cardThumbRoot = join(publicRoot, 'assets/cards-sm')
const cardArtRoot = join(publicRoot, 'assets/card-art')
const iconRoot = join(publicRoot, 'assets/icons')
const enemyRoot = join(publicRoot, 'assets/enemies')
const combatEnemyRoot = join(publicRoot, 'assets/combat/enemies')
const bossAnimationRoot = join(combatEnemyRoot, 'animations')
const combatCharacterRoot = join(publicRoot, 'assets/combat/characters')
const campfireCharacterRoot = join(publicRoot, 'assets/noncombat/campfire')
const merchantCharacterRoot = join(publicRoot, 'assets/noncombat/merchant/characters')
const combatVfxRoot = join(publicRoot, 'assets/combat/vfx')
const combatActionVfxRoot = join(combatVfxRoot, 'actions')
const combatPileRoot = join(publicRoot, 'assets/combat/piles')
const combatStageRoot = join(publicRoot, 'assets/combat')
const statusIconRoot = join(publicRoot, 'assets/status-icons')
const powerIconRoot = join(publicRoot, 'assets/power-icons')
const relicIconRoot = join(publicRoot, 'assets/relic-icons')
const potionIconRoot = join(publicRoot, 'assets/potion-icons')
const menuRoot = join(publicRoot, 'assets/menu')
const compendiumIconRoot = join(menuRoot, 'compendium-icons')
const campfireRoot = join(publicRoot, 'assets/noncombat/campfire')
const fontRoot = join(publicRoot, 'assets/fonts')
const sfxRoot = join(publicRoot, 'assets/sfx')

const cardFiles = listing(cardRoot, '.webp')
const cardThumbFiles = listing(cardThumbRoot, '.webp')
const CARD_ART_OWNERS = ['ironclad', 'silent', 'defect', 'watcher']
const DOWNFALL_CARD_OWNERS = ['slime_boss', 'guardian', 'hexaghost', 'hermit']
const cardArtFiles = CARD_ART_OWNERS.flatMap((owner) =>
  listing(join(cardArtRoot, owner), '.webp').map((file) => `${owner}/${file}`))
const iconFiles = listing(iconRoot, '.png')
const enemyFiles = listing(enemyRoot, '.webp')
const combatEnemyFiles = listing(combatEnemyRoot, '.webp')
const bossAnimationFiles = listing(bossAnimationRoot, '.webp')
const combatCharacterFiles = listing(combatCharacterRoot, '.webp')
const campfireCharacterFiles = listing(campfireCharacterRoot, '-back.webp')
const merchantCharacterFiles = listing(merchantCharacterRoot, '-standing.webp')
const combatVfxFiles = listing(combatVfxRoot, '.webp')
const combatActionVfxFiles = listing(combatActionVfxRoot, '.webp')
const combatPileFiles = listing(combatPileRoot, '.webp')
const statusIconFiles = listing(statusIconRoot, '.png')
const powerIconFiles = listing(powerIconRoot, '.png')
const relicIconFiles = listing(relicIconRoot, '.png')
// The official prototype's Hexaghost starting component is unlabeled and has
// no publisher icon. A locally generated placeholder may exist, but runtime
// correctness and clean-clone verification must not depend on it.
const optionalRelicIconFiles = new Set(['hexaghost_starting_relic.png'])
const requiredRelicIconFiles = relicIconFiles.filter((file) => !optionalRelicIconFiles.has(file))
const potionIconFiles = listing(potionIconRoot, '.png')
const compendiumIconFiles = listing(compendiumIconRoot, '.webp')
const campfireSceneFiles = listing(campfireRoot, '.png')

const cardIndex = JSON.parse(readFileSync(join(repoRoot, 'data/card-index.json'), 'utf8'))

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
const PILE_ICON_EDGE = [160, 256]
const ENEMY_CUTOUT_EDGE = [256, 512]
/** Only the `-hero` pair, painted by the character-select and Neow scenes. */
const CHARACTER_HERO_EDGE = [700, 1536]
/** Every other character cutout: combat seats, roster thumbs, lobby seats. */
const CHARACTER_CUTOUT_EDGE = [256, 512]
const CAMPFIRE_CHARACTER_EDGE = [512, 816]
const MERCHANT_CHARACTER_EDGE = [256, 576]
const DIE_ICON_EDGE = 128
/** Matches THUMB_WIDTH in scripts/sync-card-assets.mjs. */
const CARD_THUMB_WIDTH = 448

/** Every icon name Icon.tsx can render. */
const REQUIRED_ICONS = [
  'attack', 'block', 'strength', 'vulnerable', 'weak', 'poison', 'daze', 'burn',
  'shiv', 'miracle', 'energy', 'potion', 'gold', 'relic', 'elite', 'monster',
  'boss', 'aoe', 'die1', 'die2', 'die3', 'die4', 'die5', 'die6',
]

suite('assets')

check('every campfire party resolves to one complete wide PNG scene', () => {
  const characters = ['ironclad', 'silent', 'defect', 'watcher']
  const expected = Array.from({ length: 15 }, (_, index) => characters
    .filter((_, characterIndex) => (index + 1) & (1 << characterIndex)))
    .map((party) => campfireScenePath(party).split('/').pop())
    .sort()
  const scenes = [...expected, 'empty_firecamp.png'].sort()
  assertDeepEqual(campfireSceneFiles.sort(), scenes)
  for (const file of scenes) {
    const bytes = readFileSync(join(campfireRoot, file))
    assert(bytes.subarray(1, 4).toString() === 'PNG', `${file} is not a PNG`)
    assert(bytes.readUInt32BE(16) === 1672 && bytes.readUInt32BE(20) === 941,
      `${file} is not 1672x941`)
  }
  assert(scenes.reduce((bytes, file) => bytes + statSync(join(campfireRoot, file)).size, 0) < 32 * 1024 * 1024,
    'campfire scenes exceed 32 MiB')
})

check('sound effects are complete, compact, and decodable', () => {
  const expected = [
    'attack.ogg', 'block.ogg', 'card.ogg', 'defeat.ogg', 'draw.ogg', 'enemy-hit.ogg',
    'heal.ogg', 'magic.ogg', 'player-hit.ogg', 'ui.ogg', 'victory.ogg', 'weak.ogg',
  ]
  assertDeepEqual(listing(sfxRoot, '.ogg').sort(), expected)
  const files = expected.map((file) => join(sfxRoot, file))
  for (const file of files) {
    const result = spawnSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file,
    ], { encoding: 'utf8' })
    assert(result.status === 0 && Number(result.stdout) > 0, result.stderr || `${file} did not decode`)
  }
  assert(files.reduce((bytes, file) => bytes + statSync(file).size, 0) < 320 * 1024,
    'sound effects exceed 320 KiB')
})

check('every character card has exactly one committed illustration', () => {
  const expected = Object.values(CARDS)
    .filter((def) => CARD_ART_OWNERS.includes(def.owner))
    .map((def) => `${def.owner}/${def.id}.webp`)
    .sort()
  // The bundled inventory already contains the pending Watcher batch. Keep its
  // assets through branch composition, while still rejecting unknown IDs.
  const indexed = new Set(cardIndex
    .filter((entry) => CARD_ART_OWNERS.some((owner) => entry.tier.startsWith(`${owner}/`)))
    .map((entry) => {
      const owner = entry.tier.split('/')[0]
      const slug = entry.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/(^_|_$)/g, '')
      const id = entry.name === 'Strike' ? `strike_${owner}` : entry.name === 'Defend' ? `defend_${owner}` : slug
      return `${owner}/${id}.webp`
    }))
  assertDeepEqual(expected.filter((file) => !cardArtFiles.includes(file)), [], 'live card art missing')
  assertDeepEqual(cardArtFiles.filter((file) => !indexed.has(file)), [], 'unknown bundled card art')
  assertEqual(cardArtFiles.length, 251, 'complete four-character illustration inventory')
})

check('committed card illustrations decode at the audited size and budget', () => {
  const files = cardArtFiles.map((file) => join(cardArtRoot, file))
  const result = spawnSync('webpinfo', ['-summary', ...files], { encoding: 'utf8' })
  assert(result.status === 0, result.stderr || 'could not inspect committed card illustrations')
  const inspected = result.stdout.split(/^File: /m).slice(1)
  assertEqual(inspected.length, files.length, 'decoded illustration count')
  const faults = inspected.flatMap((block) => {
    const file = block.slice(0, block.indexOf('\n')).split('/').slice(-2).join('/')
    const width = Number(block.match(/  Width: (\d+)/)?.[1])
    const height = Number(block.match(/  Height: (\d+)/)?.[1])
    return width === 748 && height === 420 ? [] : [`${file} is ${width}x${height}`]
  })
  assertDeepEqual(faults, [], 'illustration dimensions')
  const sizes = files.map((file) => statSync(file).size)
  assert(Math.max(...sizes) <= 60 * 1024, 'a committed illustration exceeds 60 KiB')
  assert(sizes.reduce((sum, bytes) => sum + bytes, 0) < 7 * 1024 * 1024, 'illustrations exceed 7 MiB')
})

check('committed card illustration paths are stable across upgrades', () => {
  for (const def of Object.values(CARDS).filter((card) => CARD_ART_OWNERS.includes(card.owner))) {
    const path = cardArtPath(def)
    assertEqual(path, `${CARD_ART_ROOT}/${def.owner}/${def.id}.webp`)
    assertEqual(cardArtPath(faceOf(def, true)), path, `${def.id} upgrade reuses its illustration`)
  }
})

/** Slugs the sync script actually produced, so we only demand art it can fetch. */
const indexedKeys = new Set(
  cardIndex.flatMap((entry) => {
    const slug = entry.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
    const key = `${entry.tier}/${slug}`.replace(/\//g, '__')
    return entry.hasUpgrade ? [`${key}.webp`, `${key}+.webp`] : [`${key}.webp`]
  }),
)

const GENERATED_CARD_KEYS = new Set(['curses__daze.webp', 'curses__burn.webp', 'curses__slimed.webp'])
const downfallCardKeys = new Set(Object.values(CARDS)
  .filter((def) => DOWNFALL_CARD_OWNERS.includes(def.owner) ||
    Object.hasOwn(DOWNFALL_COLORLESS_CARD_DEFS, def.id))
  .flatMap((def) => [cardImagePath(def, false), ...(def.upgrade ? [cardImagePath(def, true)] : [])])
  .map((path) => path.split('/').pop()))
const knownCardKeys = new Set([...indexedKeys, ...GENERATED_CARD_KEYS, ...downfallCardKeys])
const hasPublisherScans = cardFiles.some((file) => !GENERATED_CARD_KEYS.has(file))

check('every defined card resolves to an image that exists', () => {
  if (cardFiles.length === 0) return // not synced
  const missing = []
  const unindexed = []
  for (const def of Object.values(CARDS)) {
    if (def.publisherScan === false) continue
    if (def.owner !== 'status' && !hasPublisherScans) continue
    for (const upgraded of [false, true]) {
      // Only check the upgraded face for cards that actually have one.
      if (upgraded && !def.upgrade) continue
      const path = cardImagePath(faceOf(def, upgraded), upgraded)
      if (!knownCardKeys.has(path.split('/').pop())) {
        unindexed.push(`${def.id}${upgraded ? '+' : ''} -> ${path}`)
        continue
      }
      if (!existsSync(join(publicRoot, path.replace(/^\//, '')))) {
        missing.push(`${def.id}${upgraded ? '+' : ''} -> ${path}`)
      }
    }
  }
  assert(
    unindexed.length === 0,
    `these cards resolve to a path the index does not know, which usually means ` +
      `the path builder is wrong rather than the art missing:\n    ${unindexed.join('\n    ')}`,
  )
  assert(missing.length === 0, `missing card art:\n    ${missing.join('\n    ')}`)
})

check('generated status scans decode at the shipped card resolution', () => {
  const files = [...GENERATED_CARD_KEYS].map((file) => join(cardRoot, file))
  const result = spawnSync('webpinfo', ['-summary', ...files], { encoding: 'utf8' })
  assert(result.status === 0, result.stderr || 'could not inspect generated status scans')
  const inspected = result.stdout.split(/^File: /m).slice(1)
  assertEqual(inspected.length, files.length, 'decoded generated status scan count')
  const faults = inspected.flatMap((block) => {
    const file = block.slice(0, block.indexOf('\n')).split('/').pop()
    const width = Number(block.match(/  Width: (\d+)/)?.[1])
    const height = Number(block.match(/  Height: (\d+)/)?.[1])
    return width === 744 && height === 1039 && statSync(join(cardRoot, file)).size <= 60 * 1024
      ? [] : [`${file} must be a 744x1039 WebP under 60 KiB`]
  })
  assertDeepEqual(faults, [], 'generated status scan faults')
})

// Every gameplay surface reads the thumbnail tier: the hand, the deck viewer,
// the reward and merchant rows, the compendium grid. A card missing from it
// renders as a broken image, and one left at full resolution silently puts the
// 3 MB decode back — which is the whole reason the tier exists.
check('every card scan has a thumbnail inside the decode budget', () => {
  if (cardFiles.length === 0) return // not synced
  assertDeepEqual(
    cardFiles.filter((file) => !cardThumbFiles.includes(file)), [],
    'card scans without a thumbnail — re-run `pnpm sync:cards`',
  )
  assertDeepEqual(
    cardThumbFiles.filter((file) => !cardFiles.includes(file)), [],
    'stale thumbnails with no scan behind them',
  )
  const files = cardThumbFiles.map((file) => join(cardThumbRoot, file))
  const result = spawnSync('webpinfo', ['-summary', ...files], { encoding: 'utf8' })
  assert(result.status === 0, result.stderr || 'could not inspect card thumbnails')
  const inspected = result.stdout.split(/^File: /m).slice(1)
  assertEqual(inspected.length, files.length, 'decoded card thumbnail count')
  const faults = inspected.flatMap((block) => {
    const file = block.slice(0, block.indexOf('\n')).split('/').pop()
    const width = Number(block.match(/  Width: (\d+)/)?.[1])
    return width > 0 && width <= CARD_THUMB_WIDTH ? [] : [`${file} is ${width}px wide`]
  })
  assertDeepEqual(faults, [], `card thumbnails over ${CARD_THUMB_WIDTH}px`)
  const bytes = files.reduce((sum, file) => sum + statSync(file).size, 0)
  assert(bytes < 28 * 1024 * 1024, `card thumbnails total ${(bytes / 1048576).toFixed(1)} MB`)
})

// Path shape is checked even without artwork, since it is pure code.
check('image paths are safe, normalised browser paths', () => {
  for (const def of Object.values(CARDS)) {
    for (const [root, path] of [
      [CARD_ASSET_ROOT, cardImagePath(def, false)],
      [CARD_THUMB_ROOT, cardThumbPath(def, false)],
    ]) {
      assert(path.startsWith(`${root}/`), `${def.id}: path must live under the asset root`)
      assert(!path.includes('\\'), `${def.id}: no backslashes in a browser path`)
      assert(!path.includes('..'), `${def.id}: no parent traversal`)
      assert(!/%[0-9a-f]{2}/i.test(path), `${def.id}: paths must not be percent-encoded`)
      assert(path === path.trim(), `${def.id}: no surrounding whitespace`)
    }
    // The two tiers are the same scan at two sizes; a key that drifted between
    // them would render one card's art on another card's face.
    assertEqual(
      cardThumbPath(def, false).slice(CARD_THUMB_ROOT.length),
      cardImagePath(def, false).slice(CARD_ASSET_ROOT.length),
      `${def.id}: thumbnail and scan keys disagree`,
    )
  }
})

check('the card art on disk matches the index exactly', () => {
  if (!hasPublisherScans) return
  const expected = cardIndex.reduce((count, entry) => count + (entry.hasUpgrade ? 2 : 1), 0) +
    GENERATED_CARD_KEYS.size + downfallCardKeys.size
  assertEqual(cardFiles.length, expected, 'every index entry should have exactly one file per face')
})

check('every Downfall card has its official full-size board-game face', () => {
  const files = [...downfallCardKeys].map((file) => join(cardRoot, file))
  assertEqual(files.length, 576, 'Downfall base and upgraded face inventory')
  const result = spawnSync('webpinfo', ['-summary', ...files], { encoding: 'utf8' })
  assert(result.status === 0, result.stderr || 'could not inspect Downfall card faces')
  const inspected = result.stdout.split(/^File: /m).slice(1)
  assertEqual(inspected.length, files.length, 'decoded Downfall card face count')
  const gemFiles = new Set([
    'amethyst', 'emerald', 'garnet', 'opal', 'ruby', 'sapphire', 'tourmaline', 'amber', 'aquamarine',
    'bismuth', 'morganite', 'jasper', 'onyx', 'pearl', 'peridot',
  ].map((gem) => `guardian__normal__${gem}.webp`))
  const faults = inspected.flatMap((block) => {
    const file = block.slice(0, block.indexOf('\n')).split('/').pop()
    const width = Number(block.match(/  Width: (\d+)/)?.[1])
    const height = Number(block.match(/  Height: (\d+)/)?.[1])
    return width === 744 && height === (gemFiles.has(file) ? 1016 : 1039)
      ? [] : [`${file} is ${width}x${height}`]
  })
  assertDeepEqual(faults, [], 'Downfall card face dimensions')
})

check('character card art stays at source resolution', () => {
  if (!hasPublisherScans) return
  const files = cardFiles
    .filter((file) => /^(ironclad|silent|defect|watcher)__/.test(file))
    .map((file) => join(cardRoot, file))
  const result = spawnSync('webpinfo', ['-summary', ...files], { encoding: 'utf8' })
  assert(result.status === 0, result.stderr || 'could not inspect character card dimensions')
  const inspected = result.stdout.split(/^File: /m).slice(1)
  assertEqual(inspected.length, files.length, 'webpinfo should inspect every character card')
  const faults = inspected.flatMap((block) => {
    const file = block.slice(0, block.indexOf('\n')).split('/').pop()
    const width = Number(block.match(/  Width: (\d+)/)?.[1])
    const height = Number(block.match(/  Height: (\d+)/)?.[1])
    return width >= 744 && height >= 1039 ? [] : [`${file} is ${width}x${height}`]
  })
  assert(faults.length === 0, `low-resolution character card art:\n    ${faults.join('\n    ')}`)
})

// Card art is the bulk of the payload; a careless re-sync at full resolution
// would add hundreds of megabytes without anyone noticing until clone time.
check('card art stays within its size budget', () => {
  if (!hasPublisherScans) return
  let total = 0
  const oversized = []
  for (const file of cardFiles) {
    const bytes = statSync(join(cardRoot, file)).size
    total += bytes
    if (bytes > 60 * 1024) oversized.push(`${file} is ${Math.round(bytes / 1024)} KB`)
  }
  assert(oversized.length === 0, `oversized card art:\n    ${oversized.join('\n    ')}`)
  const megabytes = total / 1024 / 1024
  assert(megabytes < 48, `card art totals ${megabytes.toFixed(1)} MB, over the 48 MB budget`)
})

check('no stale card images linger from an older naming scheme', () => {
  if (cardFiles.length === 0) return
  const expected = new Set()
  for (const entry of cardIndex) {
    const slug = entry.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
    const key = `${entry.tier}/${slug}`.replace(/\//g, '__')
    expected.add(`${key}.webp`)
    if (entry.hasUpgrade) expected.add(`${key}+.webp`)
  }
  for (const key of GENERATED_CARD_KEYS) expected.add(key)
  for (const key of downfallCardKeys) expected.add(key)
  const strays = cardFiles.filter((file) => !expected.has(file))
  assert(
    strays.length === 0,
    `unexpected files in the card directory:\n    ${strays.slice(0, 10).join('\n    ')}`,
  )
})

check('every icon the UI can render exists on disk', () => {
  const missing = REQUIRED_ICONS.filter((name) => !iconFiles.includes(`${name}.png`))
  assert(missing.length === 0, `missing icons — re-run \`pnpm sync:icons\`: ${missing.join(', ')}`)
})

// The die faces are regenerated art rather than rulebook crops, so they do not
// inherit the 96px export the other icons come out of sync-icons.mjs at. They
// still only ever paint into a 26 CSS px box; shipping them at generator
// resolution cost 800 KB and 4 MB of decoded texture each, per die shown.
check('die faces stay inside the icon decode budget', () => {
  const dice = iconFiles.filter((file) => /^die[1-6]\.png$/.test(file))
  assertEqual(dice.length, 6, 'die face inventory')
  for (const file of dice) {
    const bytes = readFileSync(join(iconRoot, file))
    const width = bytes.readUInt32BE(16)
    const height = bytes.readUInt32BE(20)
    assert(Math.max(width, height) <= DIE_ICON_EDGE,
      `${file} is ${width}x${height}, over the ${DIE_ICON_EDGE}px cap`)
  }
})

// Publisher crops are an optional local sync. Keep its mapping honest without
// making a clean clone depend on a portrait for every printed enemy variant.
check('the optional enemy art table names only real enemies', () => {
  const stray = Object.keys(ENEMY_ART).filter((defId) => !(defId in ENEMIES))
  assert(stray.length === 0, `ENEMY_ART names enemies that do not exist: ${stray.join(', ')}`)
})

check('the menu artwork and licensed UI font are bundled', () => {
  for (const file of ['title-spire.webp', 'compendium-archive.webp']) {
    assert(existsSync(join(menuRoot, file)), `missing menu artwork: ${file}`)
  }
  const expectedIcons = [
    'all', 'colorless', 'curse', 'defect', 'guardian', 'hermit', 'hexaghost', 'ironclad',
    'silent', 'slime_boss', 'status', 'watcher',
  ]
    .map((name) => `${name}.webp`)
  assertDeepEqual(compendiumIconFiles.sort(), expectedIcons, 'compendium icon inventory')
  const iconInfo = spawnSync('webpinfo', ['-summary', ...expectedIcons.map((file) => join(compendiumIconRoot, file))], { encoding: 'utf8' })
  assert(iconInfo.status === 0, iconInfo.stderr || 'could not inspect compendium icons')
  for (const block of iconInfo.stdout.split(/^File: /m).slice(1)) {
    const file = block.slice(0, block.indexOf('\n')).split('/').pop()
    assert(/  Width: 256[\s\S]*  Height: 256/.test(block), `${file} is not 256x256`)
    assert(/Alpha:\s+1/.test(block), `${file} has no alpha channel`)
  }
  assert(existsSync(join(fontRoot, 'Kreon.ttf')), 'missing Kreon UI font')
  const license = readFileSync(join(fontRoot, 'Kreon-OFL.txt'), 'utf8')
  assert(license.includes('SIL OPEN FONT LICENSE Version 1.1'), 'Kreon OFL license is incomplete')
})

check('every enemy has exactly one canonical combat cutout', () => {
  const expected = [...new Set(Object.values(ENEMIES)
    .map((def) => `${def.artId ?? def.id}.webp`))].sort()
  assertDeepEqual(combatEnemyFiles.sort(), expected, 'combat enemy cutout inventory')
  const trackedCombat = spawnSync('git', ['ls-files', 'public/assets/combat/enemies'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).stdout.trim().split('\n').filter((file) => dirname(file) === 'public/assets/combat/enemies')
    .map((file) => file.split('/').pop()).sort()
  assertDeepEqual(trackedCombat, expected, 'tracked combat enemy cutout inventory')
  const legacy = spawnSync('git', ['ls-files', 'public/assets/enemies'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).stdout.trim().split('\n').filter(Boolean).map((file) => file.split('/').pop()).sort()
  assertDeepEqual(legacy, [], 'tracked legacy portrait inventory')
})

check('every live enemy runtime image path exists', () => {
  const missing = Object.values(ENEMIES).filter((def) => {
    const relative = enemyImagePath(def).replace(/^\/assets\//, '')
    return !existsSync(join(publicRoot, 'assets', relative))
  }).map((def) => `${def.id}: ${enemyImagePath(def)}`)
  assert(missing.length === 0, `missing runtime enemy images:\n    ${missing.join('\n    ')}`)
})

check('every Downfall enemy asset maps to PC Downfall or an exact base-game reuse', () => {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'docs/downfall-enemy-asset-provenance.json'), 'utf8'))
  assertEqual(manifest.upstream?.commit, '030ff7d4a7419a3e21c3075661550b1b479f3502',
    'Downfall provenance must pin the inspected PC-mod revision')
  const entries = manifest.assets ?? []
  const expected = [
    ...combatEnemyFiles.filter((file) => file.startsWith('downfall_') || file === 'spire_shield.webp')
      .map((file) => `public/assets/combat/enemies/${file}`),
    ...bossAnimationFiles.filter((file) => file.startsWith('downfall_') || file.startsWith('spire_shield-'))
      .map((file) => `public/assets/combat/enemies/animations/${file}`),
  ].sort()
  assertDeepEqual(entries.flatMap((entry) => entry.runtime ?? []).sort(), expected,
    'Downfall source-to-runtime asset mapping')
  const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
  for (const entry of entries) {
    assert([
      'pc-downfall-extraction', 'base-game-extraction-via-pc-downfall',
      'base-game-exact-reuse',
    ].includes(entry.sourceKind),
      `${entry.artId} is not sourced from PC Downfall or an exact base-game reuse`)
    assert(typeof entry.source === 'string' && entry.source.length > 0, `${entry.artId} lacks an exact source`)
    const source = join(repoRoot, entry.source)
    assert(existsSync(source), `${entry.artId} source capture is not committed`)
    assertEqual(digest(source), entry.sourceSha256, `${entry.artId} source capture hash`)
    assert(typeof entry.upstreamCode === 'string' && entry.upstreamCode.startsWith('src/'),
      `${entry.artId} lacks its PC Downfall code path`)
    assert(/^[a-f0-9]{64}$/.test(entry.upstreamCodeSha256 ?? ''),
      `${entry.artId} lacks its pinned upstream-code hash`)
    for (const runtime of entry.runtime ?? []) {
      const path = join(repoRoot, runtime)
      assert(existsSync(path), `${runtime} is missing`)
      assertEqual(digest(path), entry.runtimeSha256?.[runtime], `${runtime} derivative hash`)
    }
    if (entry.pipelineArtifact) {
      const artifact = join(repoRoot, entry.pipelineArtifact)
      assert(existsSync(artifact), `${entry.artId} pipeline artifact is not committed`)
      assertEqual(digest(artifact), entry.pipelineArtifactSha256, `${entry.artId} pipeline artifact hash`)
    }
  }
  for (const hero of ['ironclad', 'silent', 'defect', 'watcher']) {
    const entry = entries.find((candidate) => candidate.artId === `downfall_pc_${hero}`)
    assert(entry?.sourceKind === 'pc-downfall-extraction', `${hero} evil boss is not a PC Downfall extraction`)
  }
  const exactReuse = spawnSync('cwebp', [
    '-quiet', '-lossless', '-crop', '15', '15', '66', '66', '-resize', '512', '512',
    join(repoRoot, 'public/assets/icons/shiv.png'), '-o', '-',
  ])
  assert(exactReuse.status === 0 && exactReuse.stdout.equals(
    readFileSync(join(combatEnemyRoot, 'downfall_shiv.webp')),
  ), 'Downfall Shiv is not the deterministic lossless conversion of the existing base-game Shiv asset')
})

check('every boss has transparent idle and left-facing attack animation assets', () => {
  const bosses = Object.values(ENEMIES).filter((def) => def.isBoss)
  const artIds = [...new Set(bosses.map((def) => def.artId ?? def.id))].sort()
  const expected = artIds.flatMap((id) => [`${id}-attack.webp`, `${id}-idle.webp`]).sort()
  assertDeepEqual(bossAnimationFiles.sort(), expected, 'boss animation inventory')
  const missing = bosses.flatMap((def) => ['idle', 'attack'].filter((pose) => {
    const relative = bossAnimationImagePath(def, pose).replace(/^\/assets\//, '')
    return !existsSync(join(publicRoot, 'assets', relative))
  }).map((pose) => `${def.id}: ${pose}`))
  assert(missing.length === 0, `missing boss animations:\n    ${missing.join('\n    ')}`)

  const probe = `
import sys, json, os, subprocess
from collections import deque
from PIL import Image, ImageChops
faults = []
metadata = json.loads(sys.argv[1])
def components(alpha):
    pixels = alpha.load()
    seen = set()
    sizes = []
    for y in range(alpha.height):
        for x in range(alpha.width):
            if pixels[x, y] <= 32 or (x, y) in seen:
                continue
            queue = deque([(x, y)])
            seen.add((x, y))
            size = 0
            while queue:
                px, py = queue.popleft()
                size += 1
                for point in ((px - 1, py), (px + 1, py), (px, py - 1), (px, py + 1)):
                    if 0 <= point[0] < alpha.width and 0 <= point[1] < alpha.height and \
                      pixels[point[0], point[1]] > 32 and point not in seen:
                        seen.add(point)
                        queue.append(point)
            sizes.append(size)
    return sorted(sizes, reverse=True)
for name in sys.argv[2:]:
    im = Image.open(name)
    is_evil = any(f"downfall_pc_{hero}" in name for hero in ("ironclad", "silent", "defect", "watcher"))
    is_evil_static = is_evil and "/animations/" not in name.replace("\\\\", "/")
    if getattr(im, "n_frames", 1) < 2 and not is_evil_static:
        faults.append(f"{name}: not animated")
        continue
    boxes = []
    mux = subprocess.run(["webpmux", "-info", name], check=True, capture_output=True, text=True).stdout
    durations = [int(line.split()[6]) for line in mux.splitlines()
                 if line.lstrip()[:1].isdigit() and line.split()[0].endswith(":" )]
    for frame in range(im.n_frames):
        im.seek(frame)
        rgba = im.convert("RGBA")
        alpha = rgba.getchannel("A")
        w, h = rgba.size
        visible_box = alpha.point(lambda value: 255 if value > 16 else 0).getbbox()
        boxes.append(visible_box)
        corners = [alpha.getpixel((0, 0)), alpha.getpixel((w - 1, 0)),
                   alpha.getpixel((0, h - 1)), alpha.getpixel((w - 1, h - 1))]
        if max(corners) > 16:
            faults.append(f"{name} frame {frame}: opaque corners {corners}")
            break
        if name.endswith("-attack.webp") and visible_box and min(
            visible_box[0], visible_box[1], w - visible_box[2], h - visible_box[3]
        ) < 20:
            faults.append(f"{name} frame {frame}: attack art has no transparent safety margin {visible_box}")
            break
        if is_evil:
            box = alpha.getbbox()
            if not box or box[0] <= 1 or box[1] <= 1 or box[2] >= w - 1 or box[3] >= h - 1:
                faults.append(f"{name} frame {frame}: character clips the canvas edge {box}")
            islands = components(alpha)
            if islands and any(size >= w * h * .001 and size < islands[0] * .02 for size in islands[1:]):
                faults.append(f"{name} frame {frame}: detached sheet fragment detected {islands[:5]}")
            opaque = alpha.point(lambda value: 255 if value > 32 else 0)
            band_rows = sum(sum(bool(value) for value in opaque.crop((0, y, w, y + 1)).getdata()) > w * .85
                            for y in range(h))
            band_columns = sum(sum(bool(value) for value in opaque.crop((x, 0, x + 1, h)).getdata()) > h * .85
                               for x in range(w))
            if band_rows > h * .12 or band_columns > w * .25:
                faults.append(f"{name} frame {frame}: opaque extraction band detected {(band_rows, band_columns)}")
        if name.endswith("bronze_automaton-attack.webp") and frame == 0 and alpha.crop((int(w * .72), 0, w, h)).getbbox():
            faults.append(f"{name}: impact leaked into the wind-up frame")
    if len(boxes) >= 2 and all(boxes[:2]) and name.endswith("bronze_automaton-attack.webp"):
        heights = [box[3] - box[1] for box in boxes[:2]]
        if abs(heights[0] - heights[1]) > h * .08:
            faults.append(f"{name}: attack frames use different character heights {heights}")
    if len(boxes) >= 2 and all(boxes[:2]) and name.endswith("bronze_automaton-idle.webp"):
        centers = [(box[0] + box[2]) / 2 for box in boxes[:2]]
        if abs(centers[0] - centers[1]) > w * .03:
            faults.append(f"{name}: idle frames jump sideways {centers}")
    if name.endswith("-attack.webp"):
        art_id = os.path.basename(name).removesuffix("-attack.webp")
        art = metadata[art_id]
        phase_sizes = (2, 1, 2, 2) if "awakened_one_phase_" in name else (3, 1, 3, 3)
        expected = (550, 180, 550, 550)
        if len(durations) != sum(phase_sizes):
            faults.append(f"{name}: expected {sum(phase_sizes)} timed frames, got {len(durations)}")
        else:
            offset = 0
            for label, size, total in zip(("windup", "dash", "impact", "recovery"), phase_sizes, expected):
                phase = durations[offset:offset + size]
                offset += size
                if sum(phase) != total:
                    faults.append(f"{name}: {label} is {sum(phase)}ms, expected {total}ms")
                if size > 1 and max(phase) - min(phase) > 1:
                    faults.append(f"{name}: {label} cadence is uneven {phase}")
        contact_frame = 4 if "awakened_one_phase_" in name else 5
        if boxes[contact_frame][0] != art["contactLeft"]:
            faults.append(f'{name}: contact edge is {boxes[contact_frame][0]}px, metadata says {art["contactLeft"]}px')
        idle = Image.open(name.replace("-attack.webp", "-idle.webp"))
        idle_heights = []
        for frame in range(idle.n_frames):
            idle.seek(frame)
            box = idle.convert("RGBA").getchannel("A").point(lambda value: 255 if value > 16 else 0).getbbox()
            idle_heights.append(box[3] - box[1])
        idle_css_height = sum(idle_heights) / len(idle_heights) * min(144 / idle.width, 137 / idle.height)
        attack_css_height = (boxes[0][3] - boxes[0][1]) * 137 / im.height * art["scale"]
        if abs(attack_css_height / idle_css_height - 1) > .03:
            faults.append(f"{name}: scaled wind-up height {attack_css_height:.1f}px differs from idle {idle_css_height:.1f}px")
    if any(f"downfall_pc_{hero}-attack.webp" in name for hero in ("ironclad", "silent", "defect", "watcher")) and im.n_frames >= 2:
        im.seek(0)
        idle_frame = im.convert("RGBA")
        im.seek(1)
        strike_frame = im.convert("RGBA")
        alpha = strike_frame.getchannel("A")
        left_reach = sum(value > 128 for value in alpha.crop((0, 0, int(w * .2), h)).getdata())
        # The combat layout anchors the whole boss on the right. The strike
        # frame itself must visibly reach into the player's left side.
        if left_reach < 75 or not alpha.getbbox() or alpha.getbbox()[0] > w * .12:
            faults.append(f"{name}: strike does not reach left {left_reach}")
        changed = sum(value > 20 for value in ImageChops.difference(idle_frame, strike_frame).convert("L").getdata())
        if changed < w * h * .04:
            faults.append(f"{name}: strike reuses the idle pose {changed}")
print(json.dumps(faults))
`
  const paths = [
    ...expected.map((file) => join(bossAnimationRoot, file)),
    ...['ironclad', 'silent', 'defect', 'watcher'].map((hero) => join(combatEnemyRoot, `downfall_pc_${hero}.webp`)),
  ]
  const metadata = Object.fromEntries(artIds.map((id) => [id, {
    scale: bossAttackScaleFor(id),
    contactLeft: bossAttackContactLeftFor(id),
  }]))
  const result = spawnSync('python3', ['-c', probe, JSON.stringify(metadata), ...paths], { encoding: 'utf8' })
  assert(result.status === 0, result.stderr || 'boss animation audit requires python3 + Pillow')
  const faults = JSON.parse(result.stdout.trim().split('\n').pop())
  assert(faults.length === 0, `invalid boss animation assets:\n    ${faults.join('\n    ')}`)
})

check('evil hero bosses use separate PC Downfall art instead of playable hero cutouts', () => {
  const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
  for (const hero of ['ironclad', 'silent', 'defect', 'watcher']) {
    const playable = join(combatCharacterRoot, `${hero}.webp`)
    const enemy = join(combatEnemyRoot, `downfall_pc_${hero}.webp`)
    assert(existsSync(enemy), `missing PC Downfall ${hero} boss cutout`)
    assert(digest(enemy) !== digest(playable), `PC Downfall ${hero} boss reuses the playable hero cutout`)
    for (const pose of ['idle', 'attack']) {
      const animation = join(bossAnimationRoot, `downfall_pc_${hero}-${pose}.webp`)
      assert(existsSync(animation), `missing PC Downfall ${hero} ${pose} animation`)
      assert(digest(animation) !== digest(playable),
        `PC Downfall ${hero} ${pose} animation reuses the playable hero cutout`)
    }
  }

  const probe = `
import sys, json
from PIL import Image, ImageChops, ImageStat
faults = []
for index in range(1, len(sys.argv), 2):
    playable = Image.open(sys.argv[index]).convert("RGBA").resize((64, 64))
    enemy = Image.open(sys.argv[index + 1]).convert("RGBA").resize((64, 64))
    distance = sum(ImageStat.Stat(ImageChops.difference(playable, enemy)).mean) / 4
    if distance < 20:
        faults.append(f"{sys.argv[index + 1]}: perceptually reuses playable hero ({distance:.2f})")
print(json.dumps(faults))
`
  const pairs = ['ironclad', 'silent', 'defect', 'watcher'].flatMap((hero) => [
    join(combatCharacterRoot, `${hero}.webp`),
    join(combatEnemyRoot, `downfall_pc_${hero}.webp`),
  ])
  const result = spawnSync('python3', ['-c', probe, ...pairs], { encoding: 'utf8' })
  assert(result.status === 0, result.stderr || 'evil boss comparison requires python3 + Pillow')
  const faults = JSON.parse(result.stdout.trim().split('\n').pop())
  assert(faults.length === 0, `evil boss art is not distinct:\n    ${faults.join('\n    ')}`)
})

check('bundled combat cutouts are sized for their render box, with transparency', () => {
  const expectedCharacters = [
    'defect-charge.webp', 'defect-hero.webp', 'defect-release.webp', 'defect.webp',
    'guardian-hero.webp', 'guardian-impact.webp', 'guardian-ready.webp', 'guardian.webp',
    'hermit-hero.webp', 'hermit-impact.webp', 'hermit-ready.webp', 'hermit.webp',
    'hexaghost-hero.webp', 'hexaghost-impact.webp', 'hexaghost-ready.webp', 'hexaghost.webp',
    'ironclad-hero.webp', 'ironclad-impact.webp', 'ironclad-ready.webp', 'ironclad.webp',
    'silent-hero.webp', 'silent-throw.webp', 'silent.webp',
    'slime_boss-hero.webp', 'slime_boss-impact.webp', 'slime_boss-ready.webp', 'slime_boss.webp',
    'watcher-hero.webp', 'watcher-ready.webp', 'watcher-thrust.webp', 'watcher.webp',
  ]
  assertDeepEqual(combatCharacterFiles.sort(), expectedCharacters, 'combat character cutout inventory')
  const enemyPaths = combatEnemyFiles.map((file) => join(combatEnemyRoot, file))
  const files = [
    ...enemyPaths,
    ...combatCharacterFiles.map((file) => join(combatCharacterRoot, file)),
  ]
  const enemyPathSet = new Set(enemyPaths)
  const result = spawnSync('webpinfo', ['-summary', ...files], { encoding: 'utf8' })
  assert(result.status === 0, result.stderr || 'could not inspect combat cutouts')
  const inspected = result.stdout.split(/^File: /m).slice(1)
  assertEqual(inspected.length, files.length, 'webpinfo should inspect every combat cutout')
  const faults = inspected.flatMap((block) => {
    const path = block.slice(0, block.indexOf('\n')).trim()
    const file = path.split('/').pop()
    const width = Number(block.match(/  Width: (\d+)/)?.[1])
    const height = Number(block.match(/  Height: (\d+)/)?.[1])
    const alpha = /Alpha:\s+1/.test(block)
    const [floor, cap] = enemyPathSet.has(path) ? ENEMY_CUTOUT_EDGE
      : file.endsWith('-hero.webp') ? CHARACTER_HERO_EDGE
      : CHARACTER_CUTOUT_EDGE
    const resolution = Math.min(width, height) >= floor / 2 &&
      Math.max(width, height) >= floor && Math.max(width, height) <= cap
    return resolution && alpha ? [] : [`${file} is ${width}x${height}, alpha ${alpha}`]
  })
  assert(faults.length === 0, `invalid combat cutouts:\n    ${faults.join('\n    ')}`)

  const probe = `
import sys, json
from PIL import Image
faults = []
for name in sys.argv[1:]:
    im = Image.open(name).convert("RGBA")
    alpha = im.getchannel("A")
    w, h = im.size
    corners = [alpha.getpixel((0, 0)), alpha.getpixel((w - 1, 0)),
               alpha.getpixel((0, h - 1)), alpha.getpixel((w - 1, h - 1))]
    label = name.rsplit("/", 1)[-1]
    bbox = alpha.point(lambda value: 255 if value >= 16 else 0).getbbox()
    if max(corners) > 8:
        faults.append(f"{label}: corners are opaque {corners}")
    elif sum(1 for value in alpha.getdata() if value < 16) / (w * h) < 0.05:
        faults.append(f"{label}: less than 5% of its canvas is transparent")
    elif bbox is None or min(bbox[2] - bbox[0], bbox[3] - bbox[1]) < 0.30 * min(w, h) or max(bbox[2] - bbox[0], bbox[3] - bbox[1]) < 0.55 * max(w, h):
        faults.append(f"{label}: visible art is undersized ({bbox})")
print(json.dumps(faults))
`
  const pixelResult = spawnSync('python3', ['-c', probe, ...files], { encoding: 'utf8' })
  assert(pixelResult.status === 0, pixelResult.stderr || 'combat cutout pixel audit requires python3 + Pillow')
  const pixelFaults = JSON.parse(pixelResult.stdout.trim().split('\n').pop())
  assert(pixelFaults.length === 0, `combat cutouts have opaque backgrounds:\n    ${pixelFaults.join('\n    ')}`)
})

check('Downfall noncombat poses are complete, transparent, and edge-capped', () => {
  const base = ['ironclad', 'silent', 'defect', 'watcher']
  const downfall = ['guardian', 'hermit', 'hexaghost', 'slime_boss']
  assertDeepEqual(
    campfireCharacterFiles.sort(),
    [...base, ...downfall].map((id) => `${id}-back.webp`).sort(),
    'mixed-party campfire pose inventory',
  )
  assertDeepEqual(
    merchantCharacterFiles.filter((file) => downfall.some((id) => file === `${id}-standing.webp`)).sort(),
    downfall.map((id) => `${id}-standing.webp`).sort(),
    'Downfall merchant pose inventory',
  )
  const groups = [
    [campfireCharacterRoot, [...base, ...downfall].map((id) => `${id}-back.webp`), CAMPFIRE_CHARACTER_EDGE],
    [merchantCharacterRoot, downfall.map((id) => `${id}-standing.webp`), MERCHANT_CHARACTER_EDGE],
  ]
  for (const [root, names, [floor, cap]] of groups) {
    const result = spawnSync('webpinfo', ['-summary', ...names.map((file) => join(root, file))], { encoding: 'utf8' })
    assert(result.status === 0, result.stderr || 'could not inspect Downfall noncombat poses')
    const inspected = result.stdout.split(/^File: /m).slice(1)
    assertEqual(inspected.length, names.length, 'decoded Downfall noncombat pose count')
    const faults = inspected.flatMap((block) => {
      const file = block.slice(0, block.indexOf('\n')).split('/').pop()
      const width = Number(block.match(/  Width: (\d+)/)?.[1])
      const height = Number(block.match(/  Height: (\d+)/)?.[1])
      const longEdge = Math.max(width, height)
      return longEdge >= floor && longEdge <= cap && /Alpha:\s+1/.test(block)
        ? [] : [`${file} is ${width}x${height}, alpha ${/Alpha:\s+1/.test(block)}`]
    })
    assertDeepEqual(faults, [], 'Downfall noncombat pose dimensions')
  }
})

check('combat pile and current-deck icons are HUD-sized transparent images', () => {
  assertDeepEqual(combatPileFiles.sort(), ['discard.webp', 'draw.webp', 'exhaust.webp'])
  const files = [
    ...combatPileFiles.map((file) => join(combatPileRoot, file)),
    join(menuRoot, 'current-deck.webp'),
  ]
  const result = spawnSync('webpinfo', ['-summary', ...files], { encoding: 'utf8' })
  assert(result.status === 0, result.stderr || 'could not inspect pile icons')
  const inspected = result.stdout.split(/^File: /m).slice(1)
  assertEqual(inspected.length, files.length, 'decoded pile icon count')
  const [floor, cap] = PILE_ICON_EDGE
  for (const block of inspected) {
    const file = block.slice(0, block.indexOf('\n')).split('/').pop()
    const width = Number(block.match(/  Width: (\d+)/)?.[1])
    const height = Number(block.match(/  Height: (\d+)/)?.[1])
    const long = Math.max(width, height)
    assert(long >= floor && long <= cap, `${file} is ${width}x${height}, outside ${floor}-${cap}px`)
    assert(/Alpha:\s+1/.test(block), `${file} has no alpha channel`)
  }
})

check('combat animation effects are complete, transparent, and compact', () => {
  const expected = [
    'death-ash.webp', 'death-ring.webp', 'enemy-motes.webp', 'hero-motes.webp', 'hit-burst.webp',
  ]
  const expectedActions = [
    'awakened-blue-fire.webp', 'awakened-claw-scratch.webp', 'dark-channel.webp',
    'defect-face-orb.webp', 'frost-channel.webp', 'guard-bloom.webp',
    'ironclad-bash.webp', 'ironclad-strike.webp', 'lightning-channel.webp', 'magic-burst.webp',
    'potion-burst.webp', 'silent-knife.webp', 'silent-poison.webp', 'silent-shiv.webp',
    'watcher-calm-aura.webp', 'watcher-meteor-impact.webp', 'watcher-meteor.webp',
    'watcher-pray.webp', 'watcher-wrath-aura.webp',
  ]
  assertDeepEqual(combatVfxFiles.sort(), expected, 'combat VFX inventory')
  assertDeepEqual(combatActionVfxFiles.sort(), expectedActions, 'personal combat VFX inventory')
  const entryHtml = readFileSync(join(repoRoot, 'index.html'), 'utf8')
  for (const file of expectedActions) {
    assert(entryHtml.includes(`/assets/combat/vfx/actions/${file}`), `${file} is not preloaded for first use`)
  }
  const files = [
    ...expected.map((file) => join(combatVfxRoot, file)),
    ...expectedActions.map((file) => join(combatActionVfxRoot, file)),
  ]
  const result = spawnSync('webpinfo', ['-summary', ...files], { encoding: 'utf8' })
  assert(result.status === 0, result.stderr || 'could not inspect combat VFX')
  const inspected = result.stdout.split(/^File: /m).slice(1)
  assertEqual(inspected.length, files.length, 'decoded combat VFX count')
  for (const block of inspected) {
    const file = block.slice(0, block.indexOf('\n')).split('/').pop()
    assert(/  Width: 512[\s\S]*  Height: 512/.test(block), `${file} is not 512x512`)
    assert(/Alpha:\s+1/.test(block), `${file} has no alpha channel`)
  }
  const probe = `
import sys, json
from PIL import Image
faults = []
for name in sys.argv[1:]:
    alpha = Image.open(name).convert("RGBA").getchannel("A")
    w, h = alpha.size
    values = list(alpha.getdata())
    label = name.rsplit("/", 1)[-1]
    corners = [alpha.getpixel((0, 0)), alpha.getpixel((w - 1, 0)),
               alpha.getpixel((0, h - 1)), alpha.getpixel((w - 1, h - 1))]
    transparent = sum(value < 16 for value in values) / len(values)
    visible = sum(value >= 16 for value in values) / len(values)
    if max(corners) > 8:
        faults.append(f"{label}: corners are opaque {corners}")
    elif transparent < 0.5:
        faults.append(f"{label}: only {transparent * 100:.1f}% transparent")
    elif visible < 0.005:
        faults.append(f"{label}: only {visible * 100:.1f}% visible")
print(json.dumps(faults))
`
  const pixelResult = spawnSync('python3', ['-c', probe, ...files], { encoding: 'utf8' })
  assert(pixelResult.status === 0, pixelResult.stderr || 'combat VFX pixel audit requires python3 + Pillow')
  assertDeepEqual(JSON.parse(pixelResult.stdout.trim().split('\n').pop()), [],
    'combat VFX must be visible effects on transparent canvases')
  assert(expected.map((file) => join(combatVfxRoot, file))
    .reduce((bytes, file) => bytes + statSync(file).size, 0) < 320 * 1024,
    'base combat VFX exceed 320 KiB')
  assert(expectedActions.map((file) => join(combatActionVfxRoot, file))
    .reduce((bytes, file) => bytes + statSync(file).size, 0) < 1.25 * 1024 * 1024,
    'personal combat VFX exceed 1.25 MiB')
})

check('bundled stage and generated icon inventories are complete and decodable', () => {
  const expectedStatus = [
    'aoe', 'attack', 'block', 'burn', 'draw', 'energy', 'miracle', 'orb', 'poison',
    'power', 'shiv', 'strength', 'vulnerable', 'weak',
  ].map((name) => `${name}.png`)
  const expectedPowers = [
    'accuracy', 'after_image', 'apotheosis', 'barricade', 'capacitor', 'combust', 'consume',
    'corruption', 'dark_embrace', 'defragment', 'demon_form', 'distraction', 'envenom', 'evolve',
    'feel_no_pain', 'footwork', 'fusion', 'heatsinks', 'infinite_blades', 'inflame',
    'machine_learning', 'mayhem', 'metallicize', 'noxious_fumes', 'panache', 'sadistic_nature',
    'storm', 'the_bomb',
  ].map((name) => `${name}.png`)
  assertDeepEqual(statusIconFiles.sort(), expectedStatus, 'status icon inventory')
  assertDeepEqual(powerIconFiles.sort(), expectedPowers, 'Power icon inventory')
  assertDeepEqual(requiredRelicIconFiles.sort(), [...new Set(Object.keys(RELICS)
    .filter((id) => id !== 'hexaghost_starting_relic')
    .map((id) => `${id.replace(/^downfall_/, '')}.png`))].sort(),
    'relic icon inventory')
  assertEqual(relicIconPath('downfall_ninja_scroll'), '/assets/relic-icons/ninja_scroll.png',
    'Downfall variant relics reuse their matching physical icon')
  assertDeepEqual(potionIconFiles.sort(), Object.keys(POTIONS).map((id) => `${id}.png`).sort(),
    'potion icon inventory')
  const stage = join(combatStageRoot, 'stage-act-1.webp')
  assert(existsSync(stage), 'missing Act I combat stage')
  const stageInfo = spawnSync('webpinfo', ['-summary', stage], { encoding: 'utf8' })
  assert(stageInfo.status === 0 && /Width: 1672[\s\S]*Height: 940/.test(stageInfo.stdout),
    stageInfo.stderr || 'the Act I stage is missing, corrupt, or the wrong size')
  for (const file of [...statusIconFiles.map((name) => join(statusIconRoot, name)),
    ...powerIconFiles.map((name) => join(powerIconRoot, name)),
    ...requiredRelicIconFiles.map((name) => join(relicIconRoot, name)),
    ...potionIconFiles.map((name) => join(potionIconRoot, name))]) {
    const bytes = readFileSync(file)
    assert(bytes.subarray(1, 4).toString() === 'PNG', `${file} is not a PNG`)
    assert(bytes.readUInt32BE(16) === 256 && bytes.readUInt32BE(20) === 256,
      `${file} is not 256x256`)
    assert(bytes[25] === 6, `${file} is not an RGBA PNG`)
  }
})

check('generated status, relic, and potion icons have transparent backgrounds', () => {
  const files = [
    ...statusIconFiles.map((name) => join(statusIconRoot, name)),
    ...requiredRelicIconFiles.map((name) => join(relicIconRoot, name)),
    ...potionIconFiles.map((name) => join(potionIconRoot, name)),
  ]
  const probe = `
import sys, json
from PIL import Image
faults = []
for name in sys.argv[1:]:
    alpha = Image.open(name).convert("RGBA").getchannel("A")
    w, h = alpha.size
    corners = [alpha.getpixel((0, 0)), alpha.getpixel((w - 1, 0)),
               alpha.getpixel((0, h - 1)), alpha.getpixel((w - 1, h - 1))]
    visible = sum(1 for value in alpha.getdata() if value > 32) / (w * h)
    if max(corners) > 8 or visible < 0.01:
        faults.append(f"{name}: corners={corners}, visible={visible:.3f}")
print(json.dumps(faults))
`
  const result = spawnSync('python3', ['-c', probe, ...files], { encoding: 'utf8' })
  assert(result.status === 0, result.stderr || 'generated icon audit requires python3 + Pillow')
  const faults = JSON.parse(result.stdout.trim().split('\n').pop())
  assertDeepEqual(faults, [], 'generated icons need transparent corners and visible art')
})

// Bytes are not pixels. Every broken conversion this pipeline can produce —
// keying disabled, luminance inverted, alpha left faint — yields a file well
// over any size threshold while rendering as a white tile or as nothing at
// all. An invisible icon does not look broken, and this pass removed the text
// captions that used to cover for one.
check('every icon is a symbol on transparent paper, not a tile', () => {
  if (iconFiles.length === 0) return // not synced

  // Measured with Pillow, which this pipeline already requires to build the
  // icons in the first place. Hand-rolling a PNG decoder here would be more
  // code than the check.
  const probe = `
import sys, json
from PIL import Image
faults = []
for name in sys.argv[1:]:
    im = Image.open(name).convert("RGBA")
    w, h = im.size
    px = im.load()
    corners = [px[0, 0][3], px[w - 1, 0][3], px[0, h - 1][3], px[w - 1, h - 1][3]]
    label = name.rsplit("/", 1)[-1]
    if max(corners) > 8:
        faults.append(f"{label}: corners are opaque {corners} - the paper was not keyed out")
        continue
    opaque = [px[x, y] for y in range(h) for x in range(w) if px[x, y][3] > 200]
    fraction = len(opaque) / (w * h)
    if fraction < 0.02:
        faults.append(f"{label}: only {fraction * 100:.1f}% opaque - effectively invisible")
        continue
    # The paper is white, so ANY opaque near-white pixel means it survived the
    # keying. Measured: a correctly keyed icon has none at all; leaving the
    # paper in gives 50-67%. The corners alone cannot catch this, because the
    # extracted images already have transparent margins.
    paper = sum(1 for p in opaque if min(p[0], p[1], p[2]) > 230) / len(opaque)
    if paper > 0.15:
        faults.append(f"{label}: {paper * 100:.0f}% of the symbol is white paper - it renders as a tile")
print(json.dumps(faults))
`
  const files = REQUIRED_ICONS.map((name) => join(iconRoot, `${name}.png`)).filter((file) =>
    existsSync(file),
  )
  const result = spawnSync('python3', ['-c', probe, ...files], { encoding: 'utf8' })
  if (result.status !== 0) {
    // Pillow is only needed to BUILD these; a machine without it should not
    // fail the suite, it should say why the check could not run.
    console.log('· icon pixels not checked (needs python3 + Pillow)')
    return
  }
  const faults = JSON.parse(result.stdout.trim().split('\n').pop())
  assert(faults.length === 0, `icon conversion is wrong:\n    ${faults.join('\n    ')}`)
})

check('synced artwork is never truncated', () => {
  for (const [dir, files] of [
    [iconRoot, iconFiles],
    [enemyRoot, enemyFiles],
  ]) {
    for (const file of files) {
      assert(statSync(join(dir, file)).size > 512, `${file} looks truncated; re-sync it`)
    }
  }
})

check('every artwork file fully decodes', () => {
  for (const [dir, extension, count] of [
    [cardRoot, 'webp', cardFiles.length],
    [enemyRoot, 'webp', enemyFiles.length],
    [combatEnemyRoot, 'webp', combatEnemyFiles.length],
    [combatCharacterRoot, 'webp', combatCharacterFiles.length],
    [combatVfxRoot, 'webp', combatVfxFiles.length],
    [combatPileRoot, 'webp', combatPileFiles.length],
    [combatStageRoot, 'webp', existsSync(join(combatStageRoot, 'stage-act-1.webp')) ? 1 : 0],
    [iconRoot, 'png', iconFiles.length],
    [statusIconRoot, 'png', statusIconFiles.length],
    [powerIconRoot, 'png', powerIconFiles.length],
    [relicIconRoot, 'png', relicIconFiles.length],
    [potionIconRoot, 'png', potionIconFiles.length],
    [campfireRoot, 'png', campfireSceneFiles.length],
  ]) {
    if (count === 0) continue
    const result = spawnSync('ffmpeg', [
      '-v', 'error', '-pattern_type', 'glob', '-i', join(dir, `*.${extension}`), '-f', 'null', '-',
    ], { encoding: 'utf8' })
    assert(result.status === 0, result.stderr || `could not decode ${dir}/*.${extension}`)
  }
})

const groups = [
  ['cards', cardFiles.length],
  ['icons', iconFiles.length],
]
for (const [name, count] of groups) {
  if (count === 0) console.log(`· ${name} not synced — run \`pnpm sync:assets\``)
}

report('assets')
