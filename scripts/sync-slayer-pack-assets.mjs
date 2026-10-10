// Converts The Slayer Pack's card scans into the game's WebP tiers.
//
// The publisher's Google Drive folder ("English version") holds one 744x1038 PNG per
// card face, named like `Searing_Blow.png` and `Searing_Blow+.png` inside a folder per
// character. The upgraded face is the back of the physical card and is printed upside
// down, so it is rotated 180 degrees here. Output matches sync-card-assets.mjs:
//   public/assets/cards/slayer__<owner>__<slug>[+].webp     744x1039, quality 74
//   public/assets/cards-sm/slayer__<owner>__<slug>[+].webp  448px thumbnail
//
// Usage: node --experimental-strip-types scripts/sync-slayer-pack-assets.mjs --source=<dir>
// where <dir> contains Ironclad/, Silent/, Defect/, Watcher/ and Colorless/ folders.
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SLAYER_CARD_DEFS } from '../src/game/slayer/index.ts'
import { cardImagePath, cardThumbPath } from '../src/game/assets.ts'
import { faceOf } from '../src/game/cards.ts'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = process.argv.find((arg) => arg.startsWith('--source='))?.slice('--source='.length)
if (!source) {
  console.error('usage: sync-slayer-pack-assets.mjs --source=<folder with Ironclad/ Silent/ Defect/ Watcher/ Colorless/>')
  process.exit(1)
}

const FOLDER = { ironclad: 'Ironclad', silent: 'Silent', defect: 'Defect', watcher: 'Watcher', colorless: 'Colorless' }
const scratch = join(repoRoot, 'tmp', 'slayer-pack-sync')
mkdirSync(scratch, { recursive: true })

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stderr}`)
}

let written = 0
for (const def of Object.values(SLAYER_CARD_DEFS)) {
  for (const upgraded of [false, true]) {
    const face = faceOf(def, upgraded)
    const file = join(source, FOLDER[def.owner], `${def.name.replace(/ /g, '_')}${upgraded ? '+' : ''}.png`)
    if (!existsSync(file)) throw new Error(`missing scan ${file}`)
    const full = join(repoRoot, 'public', cardImagePath(face, upgraded).replace(/^.*?\/assets\//, 'assets/'))
    const thumb = join(repoRoot, 'public', cardThumbPath(face, upgraded).replace(/^.*?\/assets\//, 'assets/'))
    const png = join(scratch, `${def.id}${upgraded ? '-up' : ''}.png`)
    // 180 degree rotation for the back face; the scale is a 1px stretch to the repo-wide 744x1039.
    run('ffmpeg', ['-v', 'error', '-y', '-i', file, '-vf',
      `${upgraded ? 'hflip,vflip,' : ''}scale=744:1039:flags=lanczos`, png])
    mkdirSync(dirname(full), { recursive: true })
    mkdirSync(dirname(thumb), { recursive: true })
    run('cwebp', ['-quiet', '-q', '74', png, '-o', full])
    const small = join(scratch, `${def.id}${upgraded ? '-up' : ''}-sm.png`)
    run('ffmpeg', ['-v', 'error', '-y', '-i', png, '-vf', 'scale=448:-1:flags=lanczos', small])
    run('cwebp', ['-quiet', '-q', '74', small, '-o', thumb])
    written += 2
  }
}
rmSync(scratch, { recursive: true, force: true })
console.log(`wrote ${written} files for ${Object.keys(SLAYER_CARD_DEFS).length} Slayer Pack cards`)
