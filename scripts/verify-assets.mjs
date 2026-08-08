// Every card the engine knows must resolve to an image that exists on disk, and
// every image path must be a safe, normalised browser path. A missing asset is
// otherwise invisible until it renders as a broken box in a real game.
//
// Artwork is not committed (see ATTRIBUTION.md), so a fresh clone legitimately
// has none. Each group skips when it is entirely absent, but a PARTIAL sync is
// a real problem and fails.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { CARDS, faceOf } from '../src/game/cards.ts'
import { cardImagePath, CARD_ASSET_ROOT } from '../src/game/assets.ts'
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
const UNSCANNED_POOLS = new Set(['status', 'curse'])

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

// The table in sync-enemy-art.mjs drifted from ENEMIES once already, which is
// how the Blue Slaver shipped as a black box: the sync ran clean because it
// never knew the enemy existed. This runs even on a clone with no artwork.
check('the enemy art table covers every enemy', () => {
  const missing = Object.keys(ENEMIES).filter((defId) => !(defId in ENEMY_ART))
  assert(missing.length === 0, `not in sync-enemy-art.mjs's ENEMY_ART: ${missing.join(', ')}`)
  const stray = Object.keys(ENEMY_ART).filter((defId) => !(defId in ENEMIES))
  assert(stray.length === 0, `ENEMY_ART names enemies that do not exist: ${stray.join(', ')}`)
})

// EnemyCard renders /assets/enemies/<defId>.webp. A missing file is served by
// Vite's SPA fallback as 200 + HTML, so it renders as a black box rather than
// a broken image — nothing in the running app complains about it.
check('every enemy the game can spawn has a portrait', () => {
  if (enemyFiles.length === 0) return // not synced
  const missing = Object.keys(ENEMIES).filter((defId) => !enemyFiles.includes(`${defId}.webp`))
  assert(
    missing.length === 0,
    `enemies with no portrait — re-run \`pnpm sync:enemy-art\`: ${missing.join(', ')}`,
  )
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
