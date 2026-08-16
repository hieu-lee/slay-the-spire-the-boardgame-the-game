// Every card the engine knows must resolve to an image that exists on disk, and
// every image path must be a safe, normalised browser path. A missing asset is
// otherwise invisible until it renders as a broken box in a real game.
//
// Publisher card scans, rulebook icons, and reference crops remain optional
// local syncs. Runtime illustrations and combat cutouts are committed and
// required by the unconditional inventories below.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { CARDS, faceOf } from '../src/game/cards.ts'
import {
  cardArtPath,
  cardImagePath,
  enemyImagePath,
  CARD_ART_ROOT,
  CARD_ASSET_ROOT,
} from '../src/game/assets.ts'
import { ENEMIES } from '../src/game/enemies.ts'
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
const cardArtRoot = join(publicRoot, 'assets/card-art')
const iconRoot = join(publicRoot, 'assets/icons')
const enemyRoot = join(publicRoot, 'assets/enemies')
const combatEnemyRoot = join(publicRoot, 'assets/combat/enemies')
const combatCharacterRoot = join(publicRoot, 'assets/combat/characters')
const combatStageRoot = join(publicRoot, 'assets/combat')
const statusIconRoot = join(publicRoot, 'assets/status-icons')
const powerIconRoot = join(publicRoot, 'assets/power-icons')
const menuRoot = join(publicRoot, 'assets/menu')
const fontRoot = join(publicRoot, 'assets/fonts')

const cardFiles = listing(cardRoot, '.webp')
const CARD_ART_OWNERS = ['ironclad', 'silent', 'defect', 'watcher']
const cardArtFiles = CARD_ART_OWNERS.flatMap((owner) =>
  listing(join(cardArtRoot, owner), '.webp').map((file) => `${owner}/${file}`))
const iconFiles = listing(iconRoot, '.png')
const enemyFiles = listing(enemyRoot, '.webp')
const combatEnemyFiles = listing(combatEnemyRoot, '.webp')
const combatCharacterFiles = listing(combatCharacterRoot, '.webp')
const statusIconFiles = listing(statusIconRoot, '.png')
const powerIconFiles = listing(powerIconRoot, '.png')

const cardIndex = JSON.parse(readFileSync(join(repoRoot, 'data/card-index.json'), 'utf8'))

/** Every icon name Icon.tsx can render. */
const REQUIRED_ICONS = [
  'attack', 'block', 'strength', 'vulnerable', 'weak', 'poison', 'daze', 'burn',
  'shiv', 'miracle', 'energy', 'potion', 'gold', 'relic', 'elite', 'monster',
  'boss', 'aoe', 'die1', 'die2', 'die3', 'die4', 'die5', 'die6',
]

suite('assets')

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

// Publisher crops are an optional local sync. Keep its mapping honest without
// making a clean clone depend on a portrait for every printed enemy variant.
check('the optional enemy art table names only real enemies', () => {
  const stray = Object.keys(ENEMY_ART).filter((defId) => !(defId in ENEMIES))
  assert(stray.length === 0, `ENEMY_ART names enemies that do not exist: ${stray.join(', ')}`)
})

check('the menu backgrounds and licensed UI font are bundled', () => {
  for (const file of ['title-spire.webp', 'compendium-archive.webp']) {
    assert(existsSync(join(menuRoot, file)), `missing menu artwork: ${file}`)
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
  }).stdout.trim().split('\n').filter(Boolean).map((file) => file.split('/').pop()).sort()
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

check('bundled combat cutouts are high-resolution images with transparency', () => {
  const expectedCharacters = ['defect.webp', 'ironclad.webp', 'silent.webp', 'watcher.webp']
  assertDeepEqual(combatCharacterFiles.sort(), expectedCharacters, 'combat character cutout inventory')
  const files = [
    ...combatEnemyFiles.map((file) => join(combatEnemyRoot, file)),
    ...combatCharacterFiles.map((file) => join(combatCharacterRoot, file)),
  ]
  const result = spawnSync('webpinfo', ['-summary', ...files], { encoding: 'utf8' })
  assert(result.status === 0, result.stderr || 'could not inspect combat cutouts')
  const inspected = result.stdout.split(/^File: /m).slice(1)
  assertEqual(inspected.length, files.length, 'webpinfo should inspect every combat cutout')
  const faults = inspected.flatMap((block) => {
    const file = block.slice(0, block.indexOf('\n')).split('/').pop()
    const width = Number(block.match(/  Width: (\d+)/)?.[1])
    const height = Number(block.match(/  Height: (\d+)/)?.[1])
    const alpha = /Alpha:\s+1/.test(block)
    const resolution = Math.min(width, height) >= 400 && Math.max(width, height) >= 700
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
    elif bbox is None or min(bbox[2] - bbox[0], bbox[3] - bbox[1]) < 400 or max(bbox[2] - bbox[0], bbox[3] - bbox[1]) < 700:
        faults.append(f"{label}: visible art is undersized ({bbox})")
print(json.dumps(faults))
`
  const pixelResult = spawnSync('python3', ['-c', probe, ...files], { encoding: 'utf8' })
  assert(pixelResult.status === 0, pixelResult.stderr || 'combat cutout pixel audit requires python3 + Pillow')
  const pixelFaults = JSON.parse(pixelResult.stdout.trim().split('\n').pop())
  assert(pixelFaults.length === 0, `combat cutouts have opaque backgrounds:\n    ${pixelFaults.join('\n    ')}`)
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
  const stage = join(combatStageRoot, 'stage-act-1.webp')
  assert(existsSync(stage), 'missing Act I combat stage')
  const stageInfo = spawnSync('webpinfo', ['-summary', stage], { encoding: 'utf8' })
  assert(stageInfo.status === 0 && /Width: 1672[\s\S]*Height: 940/.test(stageInfo.stdout),
    stageInfo.stderr || 'the Act I stage is missing, corrupt, or the wrong size')
  for (const file of [...statusIconFiles.map((name) => join(statusIconRoot, name)),
    ...powerIconFiles.map((name) => join(powerIconRoot, name))]) {
    const bytes = readFileSync(file)
    assert(bytes.subarray(1, 4).toString() === 'PNG', `${file} is not a PNG`)
    assert(bytes.readUInt32BE(16) === 256 && bytes.readUInt32BE(20) === 256,
      `${file} is not 256x256`)
    assert(bytes[25] === 6, `${file} is not an RGBA PNG`)
  }
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
    [combatStageRoot, 'webp', existsSync(join(combatStageRoot, 'stage-act-1.webp')) ? 1 : 0],
    [iconRoot, 'png', iconFiles.length],
    [statusIconRoot, 'png', statusIconFiles.length],
    [powerIconRoot, 'png', powerIconFiles.length],
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
