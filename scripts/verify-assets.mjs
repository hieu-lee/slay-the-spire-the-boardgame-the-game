// Every card the engine knows must resolve to an image that exists on disk, and
// every image path must be a safe, normalised browser path. A missing asset is
// otherwise invisible until it renders as a broken box in a real game.
//
// Publisher card scans and reference crops remain optional local syncs.
// Runtime icons, illustrations, and combat cutouts are committed and required
// by the unconditional inventories below.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { CARDS, faceOf } from '../src/game/cards.ts'
import '../src/game/downfall/slime-boss.ts'
import {
  cardArtPath,
  cardImagePath,
  cardThumbPath,
  enemyAnimationImagePath,
  enemyImagePath,
  relicIconPath,
  CARD_ART_ROOT,
  CARD_ASSET_ROOT,
  CARD_THUMB_ROOT,
  SKIN_CARD_ART_ROOT,
  SKIN_CARD_ROOT,
  SKIN_CARD_THUMB_ROOT,
} from '../src/game/assets.ts'
import { ENEMIES } from '../src/game/enemies.ts'
import { CHARACTER_IDS } from '../src/game/types.ts'
import { SKINS, SKIN_IDS, VISUAL_IDS, SKIN_TRAITS, skinsOf } from '../src/game/skins.ts'
import { POTIONS, RELICS } from '../src/game/relics.ts'
import {
  bossProjectileImagePath,
} from '../src/ui/combat-vfx.ts'
import { DOWNFALL_COLORLESS_CARD_DEFS } from '../src/game/downfall/items.ts'
// From the data module, NOT from sync-enemy-art.mjs: importing that script runs
// the extraction pipeline, which regenerated the very portraits this file
// checks for — so the check asserted its own side effect and could never fail.
import { ENEMY_ART } from './lib/enemy-art.mjs'
import { webpSize } from './lib/webp-size.mjs'
import { skinCardFaces } from './sync-skin-card-faces.mjs'
import { SKIN_CARD_FACES } from '../src/game/skin-card-faces.ts'
import { STAGED_ATTACKS, STAGED_SOUND_VOLUMES } from '../src/ui/combat-screen/staged-attacks.ts'
import { suite, check, assert, assertDeepEqual, assertEqual, report } from './lib/harness.mjs'
import {
  repoRoot,
  publicRoot,
  listing,
  cardRoot,
  cardThumbRoot,
  socketedCardThumbRoot,
  cardArtRoot,
  iconRoot,
  enemyRoot,
  combatEnemyRoot,
  bossProjectileRoot,
  combatCharacterRoot,
  combatSlimeRoot,
  merchantCharacterRoot,
  combatVfxRoot,
  combatActionVfxRoot,
  combatPileRoot,
  combatStageRoot,
  statusIconRoot,
  powerIconRoot,
  relicIconRoot,
  potionIconRoot,
  menuRoot,
  compendiumIconRoot,
  campfireRoot,
  fontRoot,
  sfxRoot,
  cardFiles,
  cardThumbFiles,
  socketedCardThumbFiles,
  CARD_ART_OWNERS,
  DOWNFALL_CARD_OWNERS,
  cardArtFiles,
  iconFiles,
  enemyFiles,
  combatEnemyFiles,
  combatRiggedFiles,
  combatRiggedVideoFiles,
  bossAnimationFiles,
  bossProjectileFiles,
  combatCharacterFiles,
  combatSlimeFiles,
  merchantCharacterFiles,
  combatVfxFiles,
  combatActionVfxFiles,
  combatPileFiles,
  statusIconFiles,
  powerIconFiles,
  requiredRelicIconFiles,
  potionIconFiles,
  compendiumIconFiles,
  SLIME_ASSET_SLUGS,
  cardIndex,
  PILE_ICON_EDGE,
  ENEMY_CUTOUT_EDGE,
  BOSS_ELITE_CUTOUT_EDGE,
  CHARACTER_HERO_EDGE,
  CHARACTER_CUTOUT_EDGE,
  MERCHANT_CHARACTER_EDGE,
  DIE_ICON_EDGE,
  CARD_THUMB_WIDTH,
  REQUIRED_ICONS,
  stagedSkins,
  skinConfigs,
} from './lib/asset-inventory.mjs'

suite('assets')

check('every hero rig animation has a current Safari hardware-video companion', () => {
  const manifestPath = join(repoRoot, 'scripts/animation/safari-video-sources.json')
  assert(existsSync(manifestPath), 'missing Safari animation manifest; run pnpm sync:combat-video')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const expected = combatRiggedFiles.map((file) => `public/assets/combat/rigged/${file}`).sort()
  assertDeepEqual(Object.keys(manifest).sort(), expected, 'Safari animation source inventory')
  assertDeepEqual(combatRiggedVideoFiles.sort(), combatRiggedFiles.map((file) => file.replace(/\.webp$/, '.mov')).sort(),
    'Safari animation video inventory')
})

// The camp is one painting; CampfireScene seats each hero's sprite on its logs, so a new hero or skin needs one sprite.
check('the campfire is one camp painting plus one seated sprite per visual id', () => {
  assertDeepEqual(listing(campfireRoot, '.webp').sort(), ['camp.webp', 'rest.webp', 'smith.webp'], 'campfire art outside sitters/')
  assertDeepEqual(webpSize(join(campfireRoot, 'camp.webp')), [3840, 2161], 'camp.webp size (CampfireScene aspect ratio)')
  const expected = VISUAL_IDS.map((id) => `${id}.webp`).sort()
  const sittersRoot = join(campfireRoot, 'sitters')
  assertDeepEqual(listing(sittersRoot, '.webp').sort(), expected, 'one seated campfire sprite per visual id')
  for (const file of expected) assertDeepEqual(webpSize(join(sittersRoot, file)), [1408, 1808], `${file} sprite canvas`)
  const sources = join(repoRoot, 'scripts/art/sources/campfire-sitters')
  const manifest = JSON.parse(readFileSync(join(sources, 'manifest.json'), 'utf8'))
  assertDeepEqual(Object.keys(manifest).sort(), [...VISUAL_IDS].sort(), 'campfire-sitters manifest entries')
  for (const id of VISUAL_IDS) assert(existsSync(join(sources, `${id}.webp`)), `${id} has no accepted campfire sprite source`)
})

check('sound effects are complete and compact', () => {
  const expected = [
    'attack.ogg', 'block.ogg', 'card.ogg', 'defeat.ogg', 'draw.ogg', 'enemy-hit.ogg',
    'heal.ogg', 'magic.ogg', 'player-hit.ogg', 'ui.ogg', 'victory.ogg', 'weak.ogg',
    'gunshot.mp3', 'bullet-impact.mp3', 'meteor-fall.mp3', 'meteor-impact.mp3',
    'sword-swing.mp3', 'sword-clash.mp3', 'lightning-burst.mp3', 'dark-beam.mp3',
    'frost-bloom.mp3', 'flame-burst.mp3', 'slime-splat.mp3', 'poison-hiss.mp3',
    ...Object.keys(STAGED_SOUND_VOLUMES).map((sound) => `${sound}.mp3`),
  ].sort()
  assertDeepEqual([...listing(sfxRoot, '.ogg'), ...listing(sfxRoot, '.mp3')].sort(), expected)
  const files = expected.map((file) => join(sfxRoot, file))
  assert(files.reduce((bytes, file) => bytes + statSync(file).size, 0) < 512 * 1024,
    'sound effects exceed 512 KiB')
})

check('every character card has exactly one committed illustration', () => {
  // Slayer Pack cards ship only their full scans; there is no text-free illustration for them.
  const expected = Object.values(CARDS)
    .filter((def) => CARD_ART_OWNERS.includes(def.owner) && !def.pack)
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
  assertEqual(cardArtFiles.length, 251, 'complete original-hero illustration inventory')
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
  assert(sizes.reduce((sum, bytes) => sum + bytes, 0) < 9 * 1024 * 1024, 'illustrations exceed 9 MiB')
})

// Per-skin provenance manifests (menu art and energy orb). Extend this table when a skin is registered:
// the check below fails until every registered skin has an entry.
const MENU_ART_MANIFESTS = {
  monogatari_ironclad: 'docs/monogatari-skins/noncombat-manifest.json',
  monogatari_defect: 'docs/monogatari-skins/noncombat-manifest.json',
  kratos: 'docs/skins/kratos-menu-art/manifest.json',
  monogatari_silent: 'docs/skins/monogatari_silent-art/manifest.json',
  monogatari_watcher: 'docs/skins/monogatari_watcher-art/manifest.json',
  anime_slime_boss: 'docs/skins/anime_slime_boss-art/manifest.json',
}

check('every skin has portrait, wallpaper and (with the energyOrb trait) energy orb art at the audited sizes', () => {
  assertDeepEqual(SKIN_IDS.filter((skin) => !Object.hasOwn(MENU_ART_MANIFESTS, skin)), [], 'MENU_ART_MANIFESTS needs an entry per skin')
  const skinPaths = SKIN_IDS.flatMap((skin) => [`character-select/portrait-${skin}.png`, `character-select/character-${skin}-wallpaper.webp`])
    .map((path) => join(menuRoot, path))
  const probe = `
from PIL import Image
import sys
for portrait_path, wallpaper_path in zip(sys.argv[1::2], sys.argv[2::2]):
    portrait = Image.open(portrait_path); portrait.load()
    wallpaper = Image.open(wallpaper_path); wallpaper.load()
    assert portrait.size == (256,384) and portrait.mode == 'RGB', portrait_path
    assert wallpaper.size == (1536,864) and wallpaper.mode == 'RGB', wallpaper_path
`
  const result = spawnSync('python3', ['-c', probe, ...skinPaths], { encoding: 'utf8' })
  assert(result.status === 0, result.stderr || 'skin menu exports did not decode at the audited sizes')
  const orbs = SKIN_IDS.map((skin) => [skin, join(publicRoot, 'assets/combat/energy-orbs', `${skin}.webp`)])
  for (const [skin, file] of orbs) {
    assertEqual(existsSync(file), SKIN_TRAITS[skin].energyOrb, `${skin} paints an energy orb exactly when its energyOrb trait says so`)
  }
  const painted = orbs.filter(([skin]) => SKIN_TRAITS[skin].energyOrb).map(([, file]) => file)
  if (painted.length === 0) return
  const info = spawnSync('webpinfo', ['-summary', ...painted], { encoding: 'utf8' })
  assert(info.status === 0, info.stderr || 'could not decode the skin energy orbs')
  const inspected = info.stdout.split(/^File: /m).slice(1)
  assertEqual(inspected.length, painted.length, 'decoded energy orb count')
  for (const block of inspected) {
    assert(/Width: 256[\s\S]*Height: 256/.test(block) && /Alpha:\s+1/.test(block), `${block.split('\n')[0]} must be a 256x256 transparent orb`)
  }
})

check('skin selected sources, prompts and ready-to-release menu exports match their provenance', () => {
  const verifyHash = ({ path, sha256 }) => {
    assert(!path.startsWith('/') && !path.split('/').includes('..'), 'unsafe provenance path')
    assertEqual(createHash('sha256').update(readFileSync(join(repoRoot, path))).digest('hex'), sha256, path)
  }
  for (const skin of SKIN_IDS) {
    if (MENU_ART_MANIFESTS[skin].startsWith('docs/monogatari-skins/')) continue
    const manifest = JSON.parse(readFileSync(join(repoRoot, MENU_ART_MANIFESTS[skin]), 'utf8'))
    if (manifest.assets) {
      // Character-art manifests (the Monogatari skins): one entry per exported file, hashed source, prompt and output.
      const menu = manifest.assets.filter((entry) => entry.output.path.startsWith('public/assets/menu/'))
      assertDeepEqual(menu.map((entry) => entry.output.path).sort(), [
        `public/assets/menu/character-select/character-${skin}-wallpaper.webp`,
        `public/assets/menu/character-select/portrait-${skin}.png`,
      ], `${skin} menu provenance inventory`)
      for (const entry of manifest.assets) {
        for (const asset of [entry.source, entry.output, ...(entry.prompt ? [entry.prompt] : [])]) verifyHash(asset)
        for (const reference of entry.references) assert(reference.sha256 && (reference.path || reference.description), `${skin}: ${entry.name} reference`)
      }
      assertEqual(manifest.assets.some((entry) => entry.output.path === `public/assets/combat/energy-orbs/${skin}.webp`), SKIN_TRAITS[skin].energyOrb,
        `${skin} documents its energy orb exactly when its energyOrb trait says so`)
      continue
    }
    assertDeepEqual(manifest.otherAssets.map((entry) => entry.output.path).sort(), [
      `public/assets/menu/character-select/character-${skin}-wallpaper.webp`,
      `public/assets/menu/character-select/portrait-${skin}.png`,
    ], `${skin} menu provenance inventory`)
    for (const entry of manifest.otherAssets) {
      for (const asset of [entry.source, entry.prompt, entry.output, ...entry.references]) verifyHash(asset)
    }
    if (!SKIN_TRAITS[skin].energyOrb) continue
    const { energyOrb } = manifest
    assertEqual(energyOrb.output, `public/assets/combat/energy-orbs/${skin}.webp`)
    for (const [path, sha256] of [[energyOrb.source, energyOrb.sourceSha256], [energyOrb.prompt, energyOrb.promptSha256],
      [energyOrb.output, energyOrb.outputSha256], ...energyOrb.references.map((entry) => [entry.path, entry.sha256])]) {
      verifyHash({ path, sha256 })
    }
  }
})

// Ironclad-chan and Defect-chan were produced as one batch: their combat, noncombat/menu and card manifests live in
// docs/monogatari-skins and hash every source, prompt and output.
check('Ironclad-chan and Defect-chan provenance manifests match their committed sources, prompts and outputs', () => {
  const hash = (path) => createHash('sha256').update(readFileSync(join(repoRoot, path))).digest('hex')
  const safe = (path) => !path.startsWith('/') && !path.split('/').includes('..')
  let checked = 0
  const walk = (value) => {
    if (Array.isArray(value)) return value.forEach(walk)
    if (!value || typeof value !== 'object') return
    if (typeof value.path === 'string' && typeof value.sha256 === 'string' && safe(value.path) && existsSync(join(repoRoot, value.path))) {
      assertEqual(hash(value.path), value.sha256, value.path)
      checked += 1
    }
    for (const child of Object.values(value)) walk(child)
  }
  const combat = JSON.parse(readFileSync(join(repoRoot, 'docs/monogatari-skins/combat-manifest.json'), 'utf8'))
  for (const group of [combat.sources, combat.prompts]) {
    for (const [path, sha256] of Object.entries(group)) { assertEqual(hash(path), sha256, path); checked += 1 }
  }
  walk(JSON.parse(readFileSync(join(repoRoot, 'docs/monogatari-skins/noncombat-manifest.json'), 'utf8')))
  assert(checked >= 56, `only ${checked} hashes were checked`)
})

// Cards a skin does not have art for yet, as `<skin>:<cardId>`. Each entry is a promise to
// add the art; an Ironclad card that is neither skinned nor listed here fails this check.
const PENDING_SKIN_CARDS = new Set([])

// Card types a character's skins deliberately leave on the default scan (the Slime Boss `slime` creature cards keep
// their default face in every skin), unlike PENDING_SKIN_CARDS this is not a promise to add art.
const UNSKINNED_CARD_TYPES = { slime_boss: new Set(['slime']) }

check('every skin has a face, a thumbnail and an illustration for every card of its character, and nothing else', () => {
  const listed = skinCardFaces()
  assertDeepEqual(SKIN_CARD_FACES, listed, 'src/game/skin-card-faces.ts is stale; run node scripts/sync-skin-card-faces.mjs')
  for (const [character, skins] of Object.entries(SKINS)) {
    const unskinned = UNSKINNED_CARD_TYPES[character] ?? new Set()
    const owned = Object.values(CARDS).filter((def) => def.owner === character && def.publisherScan !== false && !unskinned.has(def.type))
    const defaults = Object.values(CARDS).filter((def) => def.owner === character && def.publisherScan !== false && unskinned.has(def.type))
    for (const skin of skins) {
      const pending = (def) => PENDING_SKIN_CARDS.has(`${skin}:${def.id}`)
      const covered = owned.filter((def) => !pending(def))
      const faces = covered.flatMap((def) => [cardImagePath(def, false), cardImagePath(faceOf(def, true), true)]
        .map((path) => path.slice(CARD_ASSET_ROOT.length + 1, -'.webp'.length))).sort()
      assertDeepEqual(listed[skin]?.faces ?? [], faces, `${skin} faces must be exactly ${character}'s cards`)
      assertDeepEqual(listed[skin]?.art ?? [], covered.map((def) => `${def.owner}/${def.id}`).sort(), `${skin} art`)
      assertEqual(listed[skin].faces.length, 2 * covered.length, `${skin} has both faces of every card`)
      const thumbs = listing(join(publicRoot, 'assets/skin-cards-sm', skin), '.webp').map((file) => file.slice(0, -5)).sort()
      assertDeepEqual(thumbs, faces, `${skin} 448px faces must match the full faces`)
      // Every shipped path resolves into the skin roots, never a default scan.
      for (const def of covered) {
        assertEqual(cardImagePath(def, false, skin), `${SKIN_CARD_ROOT}/${skin}/${cardImagePath(def, false).split('/').pop()}`)
        assertEqual(cardThumbPath(def, false, undefined, skin), `${SKIN_CARD_THUMB_ROOT}/${skin}/${cardImagePath(def, false).split('/').pop()}`)
        assertEqual(cardArtPath(def, skin), `${SKIN_CARD_ART_ROOT}/${skin}/${def.owner}/${def.id}.webp`)
      }
      // Gems keep the default socketed faces, and a card the skin lacks keeps its default scan.
      const gem = CARDS.strike_ironclad ?? owned[0]
      assertEqual(cardThumbPath(owned[0], false, gem, skin), cardThumbPath(owned[0], false, gem))
      for (const def of defaults) {
        assertEqual(cardImagePath(def, false, skin), cardImagePath(def, false), `${skin} keeps the default ${def.id} face`)
        assertEqual(cardThumbPath(def, true, undefined, skin), cardThumbPath(def, true), `${skin} keeps the default ${def.id}+ thumbnail`)
        assertEqual(cardArtPath(def, skin), cardArtPath(def), `${skin} keeps the default ${def.id} art`)
      }
      const foreign = character === 'silent' ? CARDS.strike_ironclad : CARDS.strike_silent
      assertEqual(cardImagePath(foreign, false, skin), cardImagePath(foreign, false))
      assertEqual(cardArtPath(foreign, skin), cardArtPath(foreign))
    }
  }
})

check('skin card images keep the audited dimensions and sizes', () => {
  for (const skin of SKIN_IDS) {
    assert(SKIN_CARD_FACES[skin], `${skin} has no skin-card-faces entry`)
    const dir = (name) => join(publicRoot, 'assets', name, skin)
    for (const key of SKIN_CARD_FACES[skin].faces) {
      const full = webpSize(join(dir('skin-cards'), `${key}.webp`))
      const thumb = webpSize(join(dir('skin-cards-sm'), `${key}.webp`))
      assert((full[0] === 744 && full[1] === 1039) || (full[0] === 960 && full[1] === 1341), `${key} is ${full.join('x')}`)
      assertEqual(thumb[0], 448, `${key} thumbnail width`)
      assert(Math.abs(thumb[1] / thumb[0] - full[1] / full[0]) < 0.01, `${key} thumbnail aspect`)
      // The skin face replaces the default scan one for one, so it must have its geometry.
      const original = join(cardRoot, `${key}.webp`)
      if (existsSync(original)) assertDeepEqual(full, webpSize(original), `${key} matches the default scan size`)
      assert(statSync(join(dir('skin-cards'), `${key}.webp`)).size <= 160 * 1024, `${key} exceeds 160 KiB`)
      assert(statSync(join(dir('skin-cards-sm'), `${key}.webp`)).size <= 80 * 1024, `${key} thumbnail exceeds 80 KiB`)
    }
    const artDir = dir('skin-card-art')
    for (const key of SKIN_CARD_FACES[skin].art) {
      const file = join(artDir, `${key}.webp`)
      assertDeepEqual(webpSize(file), [748, 420], `${skin} ${key} art size`)
      assert(statSync(file).size <= 40 * 1024, `${skin} ${key} art exceeds 40 KiB`)
    }
  }
})

check('committed card illustration paths are stable across upgrades', () => {
  for (const def of Object.values(CARDS).filter((card) => CARD_ART_OWNERS.includes(card.owner) && !card.pack)) {
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
// The Slayer Pack: both faces of all 45 Shop pack cards, each filed under `slayer__<owner>__`.
const slayerCardKeys = new Set(Object.values(CARDS)
  .filter((def) => def.pack)
  .flatMap((def) => [cardImagePath(def, false), cardImagePath(faceOf(def, true), true)])
  .map((path) => path.split('/').pop()))
const knownCardKeys = new Set([...indexedKeys, ...GENERATED_CARD_KEYS, ...downfallCardKeys, ...slayerCardKeys])
const cardGroup = (file) => slayerCardKeys.has(file) ? 'slayer' : 'existing'
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
  for (const [group, budget] of [['existing', 28], ['slayer', 4]]) {
    const bytes = cardThumbFiles.filter(file => cardGroup(file) === group)
      .reduce((sum, file) => sum + statSync(join(cardThumbRoot, file)).size, 0)
    assert(bytes < budget * 1024 * 1024, `${group} thumbnails total ${(bytes / 1048576).toFixed(1)} MB`)
  }
})

check('every Guardian Socket and Gem pair has one compact combined face', () => {
  const gems = Object.values(CARDS).filter((def) => def.guardian?.printedType === 'Gem')
  const hosts = Object.values(CARDS).filter((def) =>
    def.guardian?.socket || def.id === 'guardian_strike')
  const expected = hosts.flatMap((host) => [false, true]
    .filter((upgraded) => !upgraded || host.upgrade)
    .flatMap((upgraded) => gems.map((gem) =>
      cardThumbPath(faceOf(host, upgraded), upgraded, gem).split('/').pop())))
    .sort()
  assertEqual(expected.length, 420, 'complete Socket host and Gem face matrix')
  assertDeepEqual(socketedCardThumbFiles.sort(), expected, 'missing or stale combined Socket faces')
  const files = expected.map((file) => join(socketedCardThumbRoot, file))
  const result = spawnSync('webpinfo', ['-summary', ...files], { encoding: 'utf8' })
  assert(result.status === 0, result.stderr || 'combined Socket faces did not decode')
  const inspected = result.stdout.split(/^File: /m).slice(1)
  assertEqual(inspected.length, files.length, 'decoded combined Socket face count')
  assert(inspected.every((block) => Number(block.match(/  Width: (\d+)/)?.[1]) === 448),
    'combined Socket faces must be 448px wide')
  assert(files.reduce((bytes, file) => bytes + statSync(file).size, 0) < 32 * 1024 * 1024,
    'combined Socket faces exceed 32 MiB')
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
    GENERATED_CARD_KEYS.size + downfallCardKeys.size + slayerCardKeys.size
  assertEqual(slayerCardKeys.size, 90, 'The Slayer Pack: 45 cards, two faces each')
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
    .filter((file) => /^(ironclad|silent|defect|watcher|slayer)__/.test(file))
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
  // Keep the existing crop budget; the Slayer Pack faces have a separate
  // bounded allowance, without raising other cards' limits.
  for (const [group, budget, perFile] of [['existing', 48, 60], ['slayer', 6, 60]]) {
    let total = 0
    const oversized = []
    for (const file of cardFiles.filter(file => cardGroup(file) === group)) {
      const bytes = statSync(join(cardRoot, file)).size
      total += bytes
      if (bytes > perFile * 1024) oversized.push(`${file} is ${Math.round(bytes / 1024)} KB`)
    }
    assert(oversized.length === 0, `oversized card art:\n    ${oversized.join('\n    ')}`)
    const megabytes = total / 1024 / 1024
    assert(megabytes < budget, `${group} card art totals ${megabytes.toFixed(1)} MB, over the ${budget} MB budget`)
  }
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
  for (const key of slayerCardKeys) expected.add(key)
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

// The calibration itself (pixel measurement) runs in verify-art-bakes; this keeps its keys in step with the roster.
check('every boss and elite has an intent calibration entry', () => {
  const ids = [...new Set(Object.values(ENEMIES).filter((def) => def.isBoss || def.elite).map((def) => def.artId ?? def.id))]
  const heads = JSON.parse(readFileSync(join(repoRoot, 'src/ui/elite-art-head.json'), 'utf8'))
  assertDeepEqual(Object.keys(heads).sort(), [...ids, 'lagavulin_sleep'].sort(), 'run python3 scripts/calibrate-elite-intent.py')
})

check('every Downfall enemy asset maps to an official source', () => {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'docs/downfall-enemy-asset-provenance.json'), 'utf8'))
  assertEqual(manifest.upstream?.commit, '030ff7d4a7419a3e21c3075661550b1b479f3502',
    'Downfall provenance must pin the inspected PC-mod revision')
  assertEqual(manifest.boardGame?.workshopId, '3687082014',
    'Downfall provenance must pin the official public-playtest TTS item')
  const entries = manifest.assets ?? []
  const expected = [
    ...combatEnemyFiles.filter((file) => file.startsWith('downfall_') || file === 'spire_shield.webp')
      .map((file) => `public/assets/combat/enemies/${file}`),
    ...bossAnimationFiles.filter((file) => file.startsWith('downfall_') || file.startsWith('spire_shield-'))
      .map((file) => `public/assets/combat/enemies/animations/${file}`),
    ...bossProjectileFiles.map((file) => `public/assets/combat/enemies/projectiles/${file}`),
    ...combatActionVfxFiles.filter((file) => file.startsWith('downfall-'))
      .map((file) => `public/assets/combat/vfx/actions/${file}`),
  ].sort()
  assertDeepEqual(entries.flatMap((entry) => entry.runtime ?? []).sort(), expected,
    'Downfall source-to-runtime asset mapping')
  const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
  for (const entry of entries) {
    assert([
      'pc-downfall-extraction', 'base-game-extraction-via-pc-downfall',
      'base-game-exact-reuse', 'board-game-boss-card-imagegen',
    ].includes(entry.sourceKind),
      `${entry.artId} is not sourced from an official board-game/PC asset or an exact base-game reuse`)
    assert(typeof entry.source === 'string' && entry.source.length > 0, `${entry.artId} lacks an exact source`)
    const source = join(repoRoot, entry.source)
    assert(existsSync(source), `${entry.artId} source capture is not committed`)
    assertEqual(digest(source), entry.sourceSha256, `${entry.artId} source capture hash`)
    if (entry.sourceKind === 'board-game-boss-card-imagegen') {
      assert(Number.isInteger(entry.cardDeckId) && Number.isInteger(entry.cardIndex),
        `${entry.artId} lacks its TTS deck/index source`)
    } else {
      assert(typeof entry.upstreamCode === 'string' && entry.upstreamCode.startsWith('src/'),
        `${entry.artId} lacks its PC Downfall code path`)
      assert(/^[a-f0-9]{64}$/.test(entry.upstreamCodeSha256 ?? ''),
        `${entry.artId} lacks its pinned upstream-code hash`)
    }
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
})

check('every enemy resolves to the continuous rig inventory', () => {
  const defs = Object.values(ENEMIES)
  for (const def of defs) for (const pose of ['idle', 'attack']) {
    const relative = enemyAnimationImagePath(def, pose).replace(/^\/assets\//, '')
    assert(existsSync(join(publicRoot, 'assets', relative)), `${def.id}: missing ${pose} rig`)
  }
})

check('every ranged Downfall boss has one complete transparent projectile', () => {
  const artIds = [
    'downfall_blasphemer', 'downfall_corrupted', 'downfall_dark_core', 'downfall_inferno',
    'downfall_neow', 'downfall_orb_master', 'downfall_witch', 'downfall_wraith',
  ]
  const expected = artIds.map((id) => `${id}.webp`).sort()
  assertDeepEqual(bossProjectileFiles.sort(), expected, 'Downfall boss projectile inventory')
  for (const artId of artIds) {
    assertEqual(bossProjectileImagePath(artId), `/assets/combat/enemies/projectiles/${artId}.webp`)
  }
  for (const artId of ['downfall_demon', 'downfall_doppelganger', 'downfall_trickster', 'downfall_wrathful']) {
    assertEqual(bossProjectileImagePath(artId), undefined, `${artId} is a melee boss`)
  }
  const paths = expected.map((file) => join(bossProjectileRoot, file))
  const result = spawnSync('python3', ['-c', `
import sys
from PIL import Image
for path in sys.argv[1:]:
    image = Image.open(path).convert('RGBA')
    alpha = image.getchannel('A')
    bounds = alpha.point(lambda value: 255 if value > 16 else 0).getbbox()
    assert max(image.size) == 256 and min(image.size) >= 128, (path, image.size)
    assert bounds and min(bounds[0], bounds[1], image.width - bounds[2], image.height - bounds[3]) >= 8, (path, bounds)
    assert max(alpha.getpixel(point) for point in ((0, 0), (image.width - 1, 0),
               (0, image.height - 1), (image.width - 1, image.height - 1))) <= 8, path
`, ...paths], { encoding: 'utf8' })
  assert(result.status === 0, result.stderr || 'a Downfall boss projectile clips its transparent canvas')
  assert(paths.reduce((bytes, path) => bytes + statSync(path).size, 0) < 1024 * 1024,
    'Downfall boss projectiles exceed 1 MiB')
})

check('Downfall Slayers use separate PC Downfall art instead of playable hero cutouts', () => {
  const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
  for (const hero of ['ironclad', 'silent', 'defect', 'watcher']) {
    const playable = join(combatCharacterRoot, `${hero}.webp`)
    const enemy = join(combatEnemyRoot, `downfall_pc_${hero}.webp`)
    assert(existsSync(enemy), `missing PC Downfall ${hero} Slayer cutout`)
    assert(digest(enemy) !== digest(playable), `PC Downfall ${hero} Slayer reuses the playable hero cutout`)
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
  assert(result.status === 0, result.stderr || 'Slayer comparison requires python3 + Pillow')
  const faults = JSON.parse(result.stdout.trim().split('\n').pop())
  assert(faults.length === 0, `Slayer art is not distinct:\n    ${faults.join('\n    ')}`)
})

check('Slime Boss minions ship one transparent cutout and one complete Command animation', () => {
  const expected = SLIME_ASSET_SLUGS.flatMap((slug) => [`${slug}.webp`, `${slug}-command.webp`]).sort()
  assertDeepEqual(combatSlimeFiles.sort(), expected, 'Slime minion asset inventory')

  const cutouts = SLIME_ASSET_SLUGS.map((slug) => join(combatSlimeRoot, `${slug}.webp`))
  const result = spawnSync('webpinfo', ['-summary', ...cutouts], { encoding: 'utf8' })
  assert(result.status === 0, result.stderr || 'could not inspect Slime minion cutouts')
  for (const block of result.stdout.split(/^File: /m).slice(1)) {
    const file = block.slice(0, block.indexOf('\n')).split('/').pop()
    assert(/Canvas size 384 x 384/.test(block) && /Alpha:\s+1/.test(block),
      `${file} is not a transparent 384x384 cutout`)
  }

  for (const slug of SLIME_ASSET_SLUGS) {
    const animation = join(combatSlimeRoot, `${slug}-command.webp`)
    const mux = spawnSync('webpmux', ['-info', animation], { encoding: 'utf8' })
    assert(mux.status === 0, mux.stderr || `could not inspect ${slug} Command animation`)
    assert(/Canvas size: 256 x 256/.test(mux.stdout) && /Number of frames: 12/.test(mux.stdout) &&
      /Loop Count : 1/.test(mux.stdout) && /Features present:.*transparency/.test(mux.stdout),
    `${slug} Command is not a transparent one-shot 1.7-second 256px animation`)
    const durations = mux.stdout.split('\n').filter((line) => /^\s*\d+:/.test(line))
      .map((line) => Number(line.trim().split(/\s+/)[6]))
    assertDeepEqual(durations, [600, ...Array(10).fill(50), 600],
      `${slug} Command does not use 0.6s dash, 0.5s personal attack, and 0.6s return timing`)
  }
  const commandEdgeProbe = spawnSync('python3', ['-c', `
import sys
from PIL import Image
for path in sys.argv[1:]:
    image = Image.open(path)
    for index in range(image.n_frames):
        image.seek(index)
        bounds = image.convert('RGBA').getchannel('A').getbbox()
        assert bounds and min(bounds[0], bounds[1], image.width - bounds[2], image.height - bounds[3]) >= 4, (path, index, bounds)
`, ...SLIME_ASSET_SLUGS.map((slug) => join(combatSlimeRoot, `${slug}-command.webp`))], { encoding: 'utf8' })
  assert(commandEdgeProbe.status === 0,
    commandEdgeProbe.stderr || 'a Slime Command frame touches its canvas edge')
  assert(SLIME_ASSET_SLUGS.flatMap((slug) => [
    join(combatSlimeRoot, `${slug}.webp`), join(combatSlimeRoot, `${slug}-command.webp`),
  ]).reduce((bytes, file) => bytes + statSync(file).size, 0) < 12 * 1024 * 1024,
  'Slime minion assets exceed 12 MiB')

  const spawn = spawnSync('webpmux', ['-info', join(combatCharacterRoot, 'slime_boss-spawn.webp')],
    { encoding: 'utf8' })
  assert(spawn.status === 0 && /Canvas size: 256 x 256/.test(spawn.stdout) &&
    /Number of frames: 16/.test(spawn.stdout) && /Loop Count : 1/.test(spawn.stdout) &&
    /Features present:.*transparency/.test(spawn.stdout),
  spawn.stderr || 'Slime Boss spawn is not a transparent one-shot 16-frame 256px animation')
  const spawnDurations = spawn.stdout.split('\n').filter((line) => /^\s*\d+:/.test(line))
    .map((line) => Number(line.trim().split(/\s+/)[6]))
  assert(spawnDurations.length === 16 && spawnDurations.every((duration) => duration === 90),
    'Slime Boss spawn does not use sixteen 90ms key frames')
})

check('bundled combat cutouts are sized for their render box, with an alpha channel', () => {
  const expectedCharacters = [
    'defect-charge.webp', 'defect-hero.webp', 'defect-release.webp', 'defect.webp',
    'guardian-defense.webp', 'guardian-hero.webp', 'guardian-impact.webp', 'guardian-ready.webp',
    'guardian-to-attack.webp', 'guardian-to-defense.webp', 'guardian.webp',
    'hermit-hero.webp', 'hermit-impact.webp', 'hermit-ready.webp', 'hermit.webp',
    ...Array.from({ length: 7 }, (_, heat) => [
      `hexaghost-heat-${heat}-attack.webp`, `hexaghost-heat-${heat}.webp`,
    ]).flat(),
    'hexaghost-hero.webp', 'hexaghost-impact.webp', 'hexaghost-ready.webp', 'hexaghost.webp',
    'ironclad-hero.webp', 'ironclad-impact.webp', 'ironclad-ready.webp', 'ironclad.webp',
    ...SKIN_IDS.flatMap((id) => [`${id}-hero.webp`, `${id}.webp`]),
    ...skinsOf('slime_boss').map((id) => `${id}-spawn.webp`),
    'monogatari_defect-charge.webp', 'monogatari_defect-release.webp',
    'monogatari_ironclad-impact.webp', 'monogatari_ironclad-ready.webp',
    'silent-hero.webp', 'silent-throw.webp', 'silent.webp',
    'slime_boss-hero.webp', 'slime_boss-impact.webp', 'slime_boss-ready.webp', 'slime_boss-spawn.webp',
    'slime_boss.webp',
    'watcher-hero.webp', 'watcher-ready.webp', 'watcher-thrust.webp', 'watcher.webp',
  ]
  assertDeepEqual(combatCharacterFiles.sort(), expectedCharacters.sort(), 'combat character cutout inventory')
  const enemyPaths = combatEnemyFiles.map((file) => join(combatEnemyRoot, file))
  const files = [
    ...enemyPaths,
    ...combatCharacterFiles.filter((file) => file !== 'slime_boss-spawn.webp')
      .map((file) => join(combatCharacterRoot, file)),
  ]
  const enemyPathSet = new Set(enemyPaths)
  const bossEliteFiles = new Set(Object.values(ENEMIES).filter(enemy => enemy.isBoss || enemy.elite ||
      ['sentry_a', 'sentry_b', 'red_slaver', 'blue_slaver'].includes(enemy.id))
    .map(enemy => `${enemy.artId ?? enemy.id}.webp`))
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
    const [floor, cap] = enemyPathSet.has(path) ? (bossEliteFiles.has(file) ? BOSS_ELITE_CUTOUT_EDGE : ENEMY_CUTOUT_EDGE)
      : /-(hero|spawn)\.webp$/.test(file) ? CHARACTER_HERO_EDGE
      : CHARACTER_CUTOUT_EDGE
    const resolution = Math.min(width, height) >= floor / 2 &&
      Math.max(width, height) >= floor && Math.max(width, height) <= cap
    return resolution && alpha ? [] : [`${file} is ${width}x${height}, alpha ${alpha}`]
  })
  assert(faults.length === 0, `invalid combat cutouts:\n    ${faults.join('\n    ')}`)

  const flameIcon = readFileSync(join(iconRoot, 'hexaghost-flame.png'))
  assert(flameIcon.subarray(1, 4).toString() === 'PNG', 'Hexaghost flame action icon is not a PNG')
  assert(flameIcon.readUInt32BE(16) === 512 && flameIcon.readUInt32BE(20) === 512,
    'Hexaghost flame action icon is not 512x512')
  assertEqual(flameIcon[25], 6, 'Hexaghost flame action icon is not RGBA')
  for (const name of ['hermit-chamber.png', 'hermit-chamber-loaded.png']) {
    const chamberIcon = readFileSync(join(iconRoot, name))
    assert(chamberIcon.subarray(1, 4).toString() === 'PNG', `${name} is not a PNG`)
    assert(chamberIcon.readUInt32BE(16) === 512 && chamberIcon.readUInt32BE(20) === 512,
      `${name} is not 512x512`)
    assertEqual(chamberIcon[25], 6, `${name} is not RGBA`)
  }

  for (const direction of ['attack', 'defense']) {
    const animation = join(combatCharacterRoot, `guardian-to-${direction}.webp`)
    const mux = spawnSync('webpmux', ['-info', animation], { encoding: 'utf8' })
    assert(mux.status === 0, mux.stderr || `could not inspect Guardian ${direction} transformation`)
    assert(/Loop Count\s*:\s*1/.test(mux.stdout), `Guardian ${direction} transformation is not one-shot`)
    assert(/Number of frames:\s*5/.test(mux.stdout), `Guardian ${direction} transformation does not use five frames`)
    assertEqual([...mux.stdout.matchAll(/\s(\d+)\s+none\s+no\s+\d+\s+lossy/g)]
      .reduce((sum, frame) => sum + Number(frame[1]), 0), 600,
    `Guardian ${direction} transformation duration`)
  }
})

check('every staged attack skin has its config, table, hit effects and sounds', () => {
  // Registering a skin with the stagedAttack trait needs scripts/animation/skins/<skin>.json and a regenerated table.
  // A config may exist before its skin is registered (the art is drawn first); the generated table always lists every config.
  assertDeepEqual(stagedSkins.filter((skin) => !(skin in skinConfigs)), [], 'stagedAttack skins without an animation config')
  assertDeepEqual(Object.keys(STAGED_ATTACKS).sort(), Object.keys(skinConfigs).sort(), 'staged attack table vs the animation configs')
  for (const skin of stagedSkins) {
    const config = skinConfigs[skin]
    for (const hit of config.hits) {
      assert(existsSync(join(combatActionVfxRoot, skin, `${hit.vfx}.webp`)), `${skin}: missing hit VFX ${hit.vfx}`)
    }
    for (const sound of Object.keys(config.sounds)) assert(sound in STAGED_SOUND_VOLUMES, `${skin}: sound ${sound} missing from the generated table`)
  }
})

check('every hero and skin has a merchant figure offset that lands its feet on the party floor line', () => {
  // merchant-arrival.css pushes each standing sprite down by its transparent bottom margin (translateY in % of its height).
  const css = readFileSync(join(repoRoot, 'src/ui/chrome/merchant-arrival.css'), 'utf8')
  const offsets = Object.fromEntries([...css.matchAll(/figure\[data-character='([a-z_]+)'\] img \{[^}]*transform: translateY\(([\d.]+)%\); \}/g)]
    .map(([, id, percent]) => [id, Number(percent)]))
  const ids = [...CHARACTER_IDS.filter((id) => !['slime_boss', 'hexaghost'].includes(id)), ...SKIN_IDS]
  const probe = `
import json, sys
from PIL import Image
for path in sys.argv[1:]:
    image = Image.open(path).convert('RGBA')
    box = image.getchannel('A').point(lambda a: 255 if a > 32 else 0).getbbox()
    print(json.dumps((image.height - box[3]) / image.height * 100))
`
  const result = spawnSync('python3', ['-c', probe, ...ids.map((id) => join(publicRoot, `assets/noncombat/merchant/characters/${id}-standing.webp`))], { encoding: 'utf8' })
  assert(result.status === 0, result.stderr)
  const gaps = result.stdout.trim().split('\n').map(Number)
  ids.forEach((id, index) => {
    assert(Object.hasOwn(offsets, id), `merchant-arrival.css has no floor offset for ${id}`)
    assert(Math.abs(offsets[id] - gaps[index]) <= 0.06, `${id}: floor offset ${offsets[id]}% but its standing figure leaves ${gaps[index].toFixed(2)}% under the feet`)
  })
})

check('every character and skin has its combat, menu and merchant art', () => {
  const missing = VISUAL_IDS.flatMap((id) => [
    `combat/characters/${id}.webp`, `combat/characters/${id}-hero.webp`,
    `menu/character-select/portrait-${id}.png`, `menu/character-select/character-${id}-wallpaper.webp`,
    `noncombat/merchant/characters/${id}-standing.webp`,
  ]).filter((path) => !existsSync(join(publicRoot, 'assets', path)))
  assertDeepEqual(missing, [], 'visual-id art inventory')
  const heads = Object.keys(JSON.parse(readFileSync(join(repoRoot, 'src/ui/hero-art-head.json'), 'utf8')))
  assertDeepEqual(VISUAL_IDS.filter((id) => !heads.some((head) => head === id || head.startsWith(`${id}-`))), [], 'hero head calibration per visual id')
  assertDeepEqual(skinsOf('slime_boss').filter((id) => !heads.includes(`${id}-spawn`)), [], 'hero head calibration of each summon drawing')
})

check('every Slime Boss skin summons from a drawing framed like its hero cutout', () => {
  // CombatScreen shows `<skin>-spawn.webp` unscaled in the cutout's box while a Slime card resolves, so the figure has to stand where
  // `<skin>-hero.webp` stands (same canvas, same ground line, same stature) or the hero jumps when the Slime appears.
  const probe = `
import json, sys
from PIL import Image
for path in sys.argv[1:]:
    image = Image.open(path).convert('RGBA')
    box = image.getchannel('A').point(lambda a: 255 if a > 32 else 0).getbbox()
    print(json.dumps([image.width, image.height, *box]))
`
  const root = join(publicRoot, 'assets/combat/characters')
  for (const skin of skinsOf('slime_boss')) {
    const result = spawnSync('python3', ['-c', probe, join(root, `${skin}-hero.webp`), join(root, `${skin}-spawn.webp`)], { encoding: 'utf8' })
    assert(result.status === 0, result.stderr)
    const [hero, spawn] = result.stdout.trim().split('\n').map((line) => JSON.parse(line))
    assertDeepEqual(spawn.slice(0, 2), hero.slice(0, 2), `${skin}-spawn.webp is not the size of its hero cutout`)
    const [width, height, left, top, right, bottom] = spawn
    assert(Math.min(left, top, width - right, height - bottom) >= 4, `${skin}-spawn.webp touches its canvas edge`)
    assert(Math.abs(bottom - hero[5]) <= 12, `${skin}-spawn.webp stands ${bottom - hero[5]}px off the hero's ground line`)
    const stature = (bottom - top) / (hero[5] - hero[3])
    assert(stature > 0.7 && stature < 1.3, `${skin}-spawn.webp is ${stature.toFixed(2)}x the hero's stature`)
    assert(Math.abs((left + right) / 2 - (hero[2] + hero[4]) / 2) <= width * 0.15, `${skin}-spawn.webp stands off the hero's centre line`)
  }
})

check('every released hero and skin has registered transparent treasure pickup poses', () => {
  const root = join(repoRoot, 'public/assets/noncombat/treasure')
  const expected = VISUAL_IDS.flatMap((id) => [`hand-${id}.webp`, `grip-${id}.webp`]).sort()
  assertDeepEqual(listing(root, '.webp').filter((name) => /^(hand|grip)-/.test(name)).sort(), expected)
  const result = spawnSync('webpinfo', ['-summary', ...expected.map((name) => join(root, name))], { encoding: 'utf8' })
  assert(result.status === 0, result.stderr || 'could not decode treasure pickup poses')
  const inspected = result.stdout.split(/^File: /m).slice(1)
  assertEqual(inspected.length, expected.length, 'decoded treasure pickup pose count')
  for (const block of inspected) {
    assert(/Width: 384[\s\S]*Height: 1024/.test(block) && /Alpha:\s+1/.test(block),
      `${block.split('\n')[0]} must retain the registered 384x1024 transparent canvas`)
  }
  assert(expected.reduce((bytes, name) => bytes + statSync(join(root, name)).size, 0) < 96 * 1024 * VISUAL_IDS.length,
    'treasure pickup poses exceed 96 KiB per hero or skin')
})

check('Downfall and skin merchant poses are complete, transparent, and edge-capped', () => {
  const characters = [...CHARACTER_IDS.filter((id) => !['ironclad', 'silent', 'defect', 'watcher'].includes(id)), ...SKIN_IDS]
  assertDeepEqual(
    merchantCharacterFiles.filter((file) => characters.some((id) => file === `${id}-standing.webp`)).sort(),
    characters.map((id) => `${id}-standing.webp`).sort(),
    'Downfall/skin merchant pose inventory',
  )
  const groups = [[merchantCharacterRoot, characters.map((id) => `${id}-standing.webp`), MERCHANT_CHARACTER_EDGE]]
  for (const [root, names, [floor, cap]] of groups) {
    const result = spawnSync('webpinfo', ['-summary', ...names.map((file) => join(root, file))], { encoding: 'utf8' })
    assert(result.status === 0, result.stderr || 'could not inspect Downfall/skin noncombat poses')
    const inspected = result.stdout.split(/^File: /m).slice(1)
    assertEqual(inspected.length, names.length, 'decoded Downfall/skin noncombat pose count')
    const faults = inspected.flatMap((block) => {
      const file = block.slice(0, block.indexOf('\n')).split('/').pop()
      const width = Number(block.match(/  Width: (\d+)/)?.[1])
      const height = Number(block.match(/  Height: (\d+)/)?.[1])
      const longEdge = Math.max(width, height)
      return longEdge >= floor && longEdge <= cap && /Alpha:\s+1/.test(block)
        ? [] : [`${file} is ${width}x${height}, alpha ${/Alpha:\s+1/.test(block)}`]
    })
    assertDeepEqual(faults, [], 'Downfall/skin noncombat pose dimensions')
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

check('combat animation effects are complete, warmed, alpha WebPs and compact', () => {
  const expected = [
    'death-ash.webp', 'death-ring.webp', 'enemy-motes.webp', 'hero-motes.webp', 'hit-burst.webp',
  ]
  const expectedActions = [
    'awakened-blue-fire.webp', 'awakened-claw-scratch.webp', 'dark-channel.webp',
    'defect-face-orb.webp', 'defect-lightning-beam.webp', 'defect-dark-beam.webp', 'speed-trail.webp', 'downfall-demon-ground-splat.webp',
    'frost-channel.webp', 'guard-bloom.webp', 'hermit-bullet.webp', 'hermit-impact.webp', 'hexaghost-flame-impact.webp',
    'hexaghost-flame.webp',
    'ironclad-bash.webp', 'ironclad-strike.webp', 'lightning-channel.webp', 'magic-burst.webp',
    'potion-burst.webp', 'silent-knife.webp', 'silent-poison.webp', 'silent-shiv.webp',
    'turn-lightning-strike.webp',
    'watcher-calm-aura.webp', 'watcher-meteor-impact.webp', 'watcher-meteor.webp',
    'watcher-pray.webp', 'watcher-wrath-aura.webp',
  ]
  const expectedTurnEffects = [
    'block', 'block-loss', 'buff', 'burn', 'countdown', 'damage', 'dark-evoke',
    'discard', 'draw', 'exhaust', 'frost-passive', 'heal', 'lightning-passive',
    'poison', 'strength', 'strength-loss', 'vulnerable', 'weak',
  ].map(name => `turn-${name}-impact.webp`)
  assertDeepEqual(combatVfxFiles.sort(), expected, 'combat VFX inventory')
  assertDeepEqual(combatActionVfxFiles.sort(), [...expectedActions, ...expectedTurnEffects].sort(), 'personal combat VFX inventory')
  const entryHtml = readFileSync(join(repoRoot, 'index.html'), 'utf8')
  const appSource = readFileSync(join(repoRoot, 'src/ui/App.tsx'), 'utf8')
  for (const file of ['hit-burst.webp', 'death-ash.webp', 'death-ring.webp']) {
    assert(appSource.includes(`'combat/vfx/${file}'`), `${file} is not warmed after registration`)
    assert(entryHtml.includes(`'${file.replace('.webp', '')}'`), `${file} is not warmed for returning players`)
  }
  for (const file of expectedActions.filter((file) => file !== 'downfall-demon-ground-splat.webp' && !file.startsWith('hermit-'))) {
    assert(appSource.includes(`'${file.replace('.webp', '')}'`), `${file} is not warmed after registration`)
    assert(entryHtml.includes(`'${file.replace('.webp', '')}'`), `${file} is not warmed for returning players`)
  }
  assert(!entryHtml.includes('/assets/combat/vfx/actions/downfall-demon-ground-splat.webp'),
    'Demon-only splat is globally preloaded')
  assert(readFileSync(join(repoRoot, 'src/ui/EnemyCard.tsx'), 'utf8')
    .includes("'combat/vfx/actions/downfall-demon-ground-splat.webp'"),
  'Demon splat is not conditionally preloaded with the rendered boss')
  assert(readFileSync(join(repoRoot, 'src/ui/combat-screen/useAttackPosePreload.ts'), 'utf8')
    .includes("['hermit-bullet', 'hermit-impact']"), 'Hermit assets are not conditionally preloaded')
  const files = [
    ...expected.map((file) => join(combatVfxRoot, file)),
    ...[...expectedActions, ...expectedTurnEffects].map((file) => join(combatActionVfxRoot, file)),
  ]
  const result = spawnSync('webpinfo', ['-summary', ...files], { encoding: 'utf8' })
  assert(result.status === 0, result.stderr || 'could not inspect combat VFX')
  const inspected = result.stdout.split(/^File: /m).slice(1)
  assertEqual(inspected.length, files.length, 'decoded combat VFX count')
  for (const block of inspected) {
    const file = block.slice(0, block.indexOf('\n')).split('/').pop()
    const dimensions = file === 'turn-lightning-strike.webp'
      ? /  Width: 384[\s\S]*  Height: 768/
      : file === 'hermit-bullet.webp' ? /  Width: 256[\s\S]*  Height: 64/
      : file === 'hermit-impact.webp' ? /  Width: 256[\s\S]*  Height: 256/
      : file.startsWith('defect-') && file.endsWith('-beam.webp') ? /  Width: 512[\s\S]*  Height: 128/
      : file === 'speed-trail.webp' ? /  Width: 512[\s\S]*  Height: 256/
      : /  Width: 512[\s\S]*  Height: 512/
    assert(dimensions.test(block), `${file} has incorrect dimensions`)
    assert(/Alpha:\s+1/.test(block), `${file} has no alpha channel`)
  }
  assert(expected.map((file) => join(combatVfxRoot, file))
    .reduce((bytes, file) => bytes + statSync(file).size, 0) < 320 * 1024,
    'base combat VFX exceed 320 KiB')
  assert(expectedActions.map((file) => join(combatActionVfxRoot, file))
    .reduce((bytes, file) => bytes + statSync(file).size, 0) < 1.5 * 1024 * 1024,
    'personal combat VFX exceed 1.5 MiB')
})

check('bundled stage and generated icon inventories are complete and decodable', () => {
  const expectedStatus = [
    'aoe', 'attack', 'block', 'burn', 'draw', 'energy', 'miracle', 'orb', 'poison',
    'power', 'shiv', 'slime', 'strength', 'vigor', 'vulnerable', 'weak',
  ].map((name) => `${name}.png`)
  const expectedPowers = [
    'accuracy', 'after_image', 'apotheosis', 'barricade', 'capacitor', 'combust', 'consume',
    'corruption', 'dark_embrace', 'defragment', 'demon_form', 'distraction', 'envenom', 'evolve',
    'feel_no_pain', 'footwork', 'fusion', 'heatsinks', 'infinite_blades', 'inflame',
    'machine_learning', 'mayhem', 'metallicize', 'noxious_fumes', 'panache', 'sadistic_nature',
    'storm', 'the_bomb',
  ].map((name) => `${name}.png`).sort()
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
  assert(stageInfo.status === 0 && /Width: 3840[\s\S]*Height: 2159/.test(stageInfo.stdout),
    stageInfo.stderr || 'the Act I stage is missing, corrupt, or the wrong size')
  for (const file of [...statusIconFiles.map((name) => join(statusIconRoot, name)),
    ...powerIconFiles.map((name) => join(powerIconRoot, name)),
    ...requiredRelicIconFiles.map((name) => join(relicIconRoot, name)),
    ...potionIconFiles.map((name) => join(potionIconRoot, name))]) {
    const bytes = readFileSync(file)
    assert(bytes.subarray(1, 4).toString() === 'PNG', `${file} is not a PNG`)
    const size = file === join(statusIconRoot, 'vigor.png') ? 128 : 256
    assert(bytes.readUInt32BE(16) === size && bytes.readUInt32BE(20) === size,
      `${file} is not ${size}x${size}`)
    assert(bytes[25] === 6, `${file} is not an RGBA PNG`)
  }
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

const groups = [
  ['cards', cardFiles.length],
  ['icons', iconFiles.length],
]
for (const [name, count] of groups) {
  if (count === 0) console.log(`· ${name} not synced — run \`pnpm sync:assets\``)
}

report('assets')
