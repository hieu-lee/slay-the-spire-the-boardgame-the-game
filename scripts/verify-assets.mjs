// Every card the engine knows must resolve to an image that exists on disk, and
// every image path must be a safe, normalised browser path. A missing asset is
// otherwise invisible until it renders as a broken box in a real game.
//
// Card scans, icons, and refreshed source art are not committed (see
// ATTRIBUTION.md), so those synced groups may be absent in a fresh clone.
// Bundled enemy, background, and combat art is always checked; a partial sync
// is still a real problem and fails.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { CARDS, faceOf } from '../src/game/cards.ts'
import { cardImagePath, enemyImagePath, CARD_ASSET_ROOT } from '../src/game/assets.ts'
import { ENEMIES } from '../src/game/enemies.ts'
// From the data module, NOT from sync-enemy-art.mjs: importing that script runs
// the extraction pipeline, which regenerated the very portraits this file
// checks for — so the check asserted its own side effect and could never fail.
import { ENEMY_ART } from './lib/enemy-art.mjs'
import { suite, check, assert, assertEqual, report } from './lib/harness.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const publicRoot = join(repoRoot, 'public')

const listing = (dir, extension) =>
  existsSync(dir) ? readdirSync(dir).filter((file) => file.endsWith(extension)) : []

const cardRoot = join(publicRoot, 'assets/cards')
const iconRoot = join(publicRoot, 'assets/icons')
const enemyRoot = join(publicRoot, 'assets/enemies')

const cardFiles = listing(cardRoot, '.webp')
const iconFiles = listing(iconRoot, '.png')
const enemyFiles = listing(enemyRoot, '.webp')

const cardIndex = JSON.parse(readFileSync(join(repoRoot, 'data/card-index.json'), 'utf8'))

/** Every icon name Icon.tsx can render. */
const REQUIRED_ICONS = [
  'attack', 'block', 'strength', 'vulnerable', 'weak', 'poison', 'daze', 'burn',
  'shiv', 'miracle', 'energy', 'potion', 'gold', 'relic', 'elite', 'monster',
  'boss', 'aoe', 'die1', 'die2', 'die3', 'die4', 'die5', 'die6',
]

const REQUIRED_COMBAT_ART = [
  'stage-act-1.webp',
  'characters/ironclad.webp',
  'characters/silent.webp',
  'characters/defect.webp',
  'characters/watcher.webp',
  'enemies/cultist.webp',
  'enemies/acid_slime.webp',
  'enemies/jaw_worm.webp',
  'enemies/red_louse.webp',
  'enemies/green_louse.webp',
  'enemies/gremlin_nob.webp',
  'enemies/lagavulin.webp',
]

const REQUIRED_BACKGROUNDS = [1, 2, 3, 4].map((act) => `boss-act-${act}.webp`)

suite('assets')

/** Slugs the sync script actually produced, so we only demand art it can fetch. */
const indexedKeys = new Set(
  cardIndex.flatMap((entry) => {
    const slug = entry.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
    const key = `${entry.tier}/${slug}`.replace(/\//g, '__')
    return entry.hasUpgrade ? [`${key}.webp`, `${key}+.webp`] : [`${key}.webp`]
  }),
)

/**
 * Pools with no scans in the source set. The UI degrades to a name plate for
 * these rather than showing a broken image.
 *
 * An explicit allowlist, NOT "skip anything whose path is not in the index":
 * that used `cardImagePath` as its own skip condition, so a regression in the
 * path builder made every card skip itself and the check passed while pointing
 * every single card at one nonexistent file.
 */
const UNSCANNED_POOLS = new Set(['status'])

check('every defined card resolves to an image that exists', () => {
  if (cardFiles.length === 0) return // not synced
  const missing = []
  const unindexed = []
  for (const def of Object.values(CARDS)) {
    if (UNSCANNED_POOLS.has(def.owner)) continue
    for (const upgraded of [false, true]) {
      // Only check the upgraded face for cards that actually have one.
      if (upgraded && !def.upgrade) continue
      const path = cardImagePath(faceOf(def, upgraded), upgraded)
      if (!indexedKeys.has(path.split('/').pop())) {
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

// Path shape is checked even without artwork, since it is pure code.
check('image paths are safe, normalised browser paths', () => {
  for (const def of Object.values(CARDS)) {
    const path = cardImagePath(def, false)
    assert(path.startsWith(`${CARD_ASSET_ROOT}/`), `${def.id}: path must live under the asset root`)
    assert(!path.includes('\\'), `${def.id}: no backslashes in a browser path`)
    assert(!path.includes('..'), `${def.id}: no parent traversal`)
    assert(!/%[0-9a-f]{2}/i.test(path), `${def.id}: paths must not be percent-encoded`)
    assert(path === path.trim(), `${def.id}: no surrounding whitespace`)
  }
})

check('the card art on disk matches the index exactly', () => {
  if (cardFiles.length === 0) return
  const expected = cardIndex.reduce((count, entry) => count + (entry.hasUpgrade ? 2 : 1), 0)
  assertEqual(cardFiles.length, expected, 'every index entry should have exactly one file per face')
})

check('character card art stays at source resolution', () => {
  if (cardFiles.length === 0) return
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
  if (cardFiles.length === 0) return
  let total = 0
  const oversized = []
  for (const file of cardFiles) {
    const bytes = statSync(join(cardRoot, file)).size
    total += bytes
    if (bytes > 60 * 1024) oversized.push(`${file} is ${Math.round(bytes / 1024)} KB`)
  }
  assert(oversized.length === 0, `oversized card art:\n    ${oversized.join('\n    ')}`)
  const megabytes = total / 1024 / 1024
  assert(megabytes < 25, `card art totals ${megabytes.toFixed(1)} MB, over the 25 MB budget`)
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
  const strays = cardFiles.filter((file) => !expected.has(file))
  assert(
    strays.length === 0,
    `unexpected files in the card directory:\n    ${strays.slice(0, 10).join('\n    ')}`,
  )
})

check('every icon the UI can render exists on disk', () => {
  if (iconFiles.length === 0) return // not synced
  const missing = REQUIRED_ICONS.filter((name) => !iconFiles.includes(`${name}.png`))
  assert(missing.length === 0, `missing icons — re-run \`pnpm sync:icons\`: ${missing.join(', ')}`)
})

check('every committed battlefield asset exists, decodes, and cutouts stay transparent', () => {
  const combatFiles = REQUIRED_COMBAT_ART.map((path) => join(publicRoot, 'assets/combat', path))
  const backgroundFiles = REQUIRED_BACKGROUNDS.map((path) =>
    join(publicRoot, 'assets/backgrounds', path))
  const files = [...combatFiles, ...backgroundFiles]
  const missing = files.filter((file) => !existsSync(file))
  assert(missing.length === 0, `missing battlefield art: ${missing.join(', ')}`)
  const result = spawnSync('webpinfo', ['-summary', ...files], { encoding: 'utf8' })
  assert(result.status === 0, result.stderr || 'could not decode committed battlefield art')
  const inspected = result.stdout.split(/^File: /m).slice(1)
  assertEqual(inspected.length, files.length, 'webpinfo should inspect every battlefield asset')
  const opaque = inspected.slice(1, combatFiles.length)
    .filter((block) => !/\n  Alpha: 1\n/.test(block))
    .map((block) => block.slice(0, block.indexOf('\n')))
  assert(opaque.length === 0, `combat cutouts lost transparency: ${opaque.join(', ')}`)
})

// The table in sync-enemy-art.mjs drifted from ENEMIES once already, which is
// how the Blue Slaver shipped as a black box: the sync ran clean because it
// never knew the enemy existed. This runs even on a clone with no artwork.
check('the enemy art table covers every enemy', () => {
  const missing = Object.keys(ENEMIES).filter((defId) => !(defId in ENEMY_ART))
  assert(missing.length === 0, `not in sync-enemy-art.mjs's ENEMY_ART: ${missing.join(', ')}`)
  const stray = Object.keys(ENEMY_ART).filter((defId) => !(defId in ENEMIES))
  assert(stray.length === 0, `ENEMY_ART names enemies that do not exist: ${stray.join(', ')}`)
})

check('the complete bundled enemy portrait inventory exists and decodes', () => {
  const tracked = spawnSync('git', ['ls-files', 'public/assets/enemies/*.webp'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  assert(tracked.status === 0, tracked.stderr || 'could not read the bundled enemy inventory')
  const expected = tracked.stdout.trim().split('\n').filter(Boolean)
    .map((file) => file.split('/').pop()).sort()
  assertEqual(expected.length, 90, 'bundled enemy portrait inventory')
  const missing = expected.filter((file) => !enemyFiles.includes(file))
  const stray = enemyFiles.filter((file) => !expected.includes(file))
  assert(missing.length === 0, `missing bundled enemy portraits: ${missing.join(', ')}`)
  assert(stray.length === 0, `unexpected bundled enemy portraits: ${stray.join(', ')}`)
  const result = spawnSync('webpinfo', ['-summary', ...expected.map((file) => join(enemyRoot, file))], {
    encoding: 'utf8',
  })
  assert(result.status === 0, result.stderr || 'could not decode bundled enemy portraits')
})

// EnemyCard renders enemyImagePath(def). A missing file is served by
// Vite's SPA fallback as 200 + HTML, so it renders as a black box rather than
// a broken image — nothing in the running app complains about it.
check('every enemy the game can spawn has a portrait', () => {
  const missing = Object.values(ENEMIES).filter((def) =>
    !existsSync(join(publicRoot, enemyImagePath(def).replace(/^\//, '')))).map((def) => def.id)
  assert(
    missing.length === 0,
    `enemies with no portrait: ${missing.join(', ')}`,
  )
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

const groups = [
  ['cards', cardFiles.length],
  ['icons', iconFiles.length],
  ['enemy portraits', enemyFiles.length],
]
for (const [name, count] of groups) {
  if (count === 0) console.log(`· ${name} not synced — run \`pnpm sync:assets\``)
}

report('assets')
