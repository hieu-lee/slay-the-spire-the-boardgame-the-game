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

check('every defined card resolves to an image that exists', () => {
  if (cardFiles.length === 0) return // not synced
  const missing = []
  for (const def of Object.values(CARDS)) {
    for (const upgraded of [false, true]) {
      // Only check the upgraded face for cards that actually have one.
      if (upgraded && !def.upgrade) continue
      const path = cardImagePath(faceOf(def, upgraded), upgraded)
      // Daze and the Status cards are not in the scan source; the UI degrades
      // to a name plate for those rather than showing a broken image.
      if (!indexedKeys.has(path.split('/').pop())) continue
      if (!existsSync(join(publicRoot, path.replace(/^\//, '')))) {
        missing.push(`${def.id}${upgraded ? '+' : ''} -> ${path}`)
      }
    }
  }
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
