// Downloads every card, relic and potion scan and converts it to a web-sized
// WebP under public/assets/cards/.
//
// The source images are 744x1039 PNGs of about 350 KB each. Character cards
// retain that resolution; relics, potions and other scans use 320px. Lossy WebP
// keeps the complete library within its 25 MB payload budget.
//
// Usage:
//   node scripts/sync-card-assets.mjs             # fetch anything missing
//   node scripts/sync-card-assets.mjs --force     # re-fetch everything
//   node scripts/sync-card-assets.mjs --force --characters # upgrade existing character cards
//   node scripts/sync-card-assets.mjs --width=480 --quality=74 # override export settings
//   node scripts/sync-card-assets.mjs --limit=20  # sample, for a quick check
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outRoot = join(repoRoot, 'public/assets/cards')
const SOURCE = 'https://rustywolf.github.io/sts/assets/images'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const force = args.includes('--force')
const charactersOnly = args.includes('--characters')
const width = Number(flag('width', '0'))
const quality = Number(flag('quality', '0'))
const limit = Number(flag('limit', '0'))
const concurrency = Number(flag('jobs', '8'))

const index = JSON.parse(readFileSync(join(repoRoot, 'data/card-index.json'), 'utf8'))
const isCharacter = (entry) => ['ironclad', 'silent', 'defect', 'watcher'].includes(entry.tier.split('/')[0])

// Fail before downloading 650 files rather than after each one fails to encode.
function requireTool(command, hint) {
  const probe = spawnSync(command, ['-version'], { stdio: 'ignore' })
  if (probe.error) {
    console.error(`missing \`${command}\` — ${hint}`)
    return false
  }
  return true
}

const haveTools = [
  requireTool('ffmpeg', 'install it with `brew install ffmpeg` or `apt install ffmpeg`'),
  requireTool('cwebp', 'install it with `brew install webp` or `apt install webp`'),
].every(Boolean)
if (!haveTools) process.exit(1)

/** A stable, filesystem-safe id for a card. Also used as the asset key. */
export function assetKey(entry, upgraded) {
  const slug = entry.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
  return `${entry.tier}/${slug}${upgraded ? '+' : ''}`.replace(/\//g, '__')
}

function sourceUrl(entry, upgraded) {
  return `${SOURCE}/${entry.tier}/${upgraded ? 'upgraded/' : ''}${entry.index}.png`
}

const jobs = []
for (const entry of index) {
  if (charactersOnly && !isCharacter(entry)) continue
  jobs.push({ entry, upgraded: false })
  if (entry.hasUpgrade) jobs.push({ entry, upgraded: true })
}
const selected = limit > 0 ? jobs.slice(0, limit) : jobs

mkdirSync(outRoot, { recursive: true })

function run(command, commandArgs) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, commandArgs, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (code) => resolvePromise({ code, stderr }))
    child.on('error', (error) => resolvePromise({ code: 1, stderr: error.message }))
  })
}

async function fetchOne({ entry, upgraded }) {
  const key = assetKey(entry, upgraded)
  const target = join(outRoot, `${key}.webp`)
  if (!force && existsSync(target) && statSync(target).size > 0) return { key, skipped: true }

  const master = join(repoRoot, 'public/assets/cards-hd', `${key}.png`)
  const hasMaster = existsSync(master)
  const source = hasMaster ? master : join(outRoot, `.${key}.src.png`)
  const scaled = join(outRoot, `.${key}.scaled.png`)
  const targetWidth = width || (isCharacter(entry) ? 744 : 320)
  const targetQuality = quality || (isCharacter(entry) ? 74 : 82)
  if (!hasMaster) {
    const url = sourceUrl(entry, upgraded)
    const response = await fetch(url)
    if (!response.ok) return { key, error: `HTTP ${response.status} for ${url}` }
    writeFileSync(source, Buffer.from(await response.arrayBuffer()))
  }

  // Two steps on purpose: this ffmpeg build has no WebP encoder, and ffmpeg's
  // lanczos scaler is better than cwebp's built-in resize.
  const scale = await run('ffmpeg', [
    '-v', 'error', '-y',
    '-i', source,
    '-vf', hasMaster && width === 0 ? 'null' : `scale=${targetWidth}:-1:flags=lanczos`,
    scaled,
  ])
  if (scale.code !== 0) {
    if (!hasMaster) rmSync(source, { force: true })
    return { key, error: scale.stderr.trim() || 'ffmpeg scale failed' }
  }

  // Card art is illustration, so lossy WebP keeps scans sharp at a fraction of
  // the bytes. Quality is configurable for full-resolution character exports.
  const encode = await run('cwebp', ['-quiet', '-q', String(targetQuality), scaled, '-o', target])
  if (!hasMaster) rmSync(source, { force: true })
  rmSync(scaled, { force: true })
  if (encode.code !== 0) {
    // cwebp may have written a partial file before failing. Leaving it would
    // make the next run skip it as "already present" and ship a corrupt image.
    rmSync(target, { force: true })
    return { key, error: encode.stderr.trim() || 'cwebp failed' }
  }
  return { key, bytes: statSync(target).size }
}

const results = []
const queue = [...selected]
let done = 0
await Promise.all(
  Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let job = queue.shift(); job !== undefined; job = queue.shift()) {
      const result = await fetchOne(job)
      results.push(result)
      done++
      if (done % 25 === 0) process.stdout.write(`  ${done}/${selected.length}\n`)
    }
  }),
)

const errors = results.filter((r) => r.error)
const written = results.filter((r) => r.bytes)
const skipped = results.filter((r) => r.skipped)
const totalBytes = written.reduce((sum, r) => sum + r.bytes, 0)

console.log(`\nwrote ${written.length}, skipped ${skipped.length}, failed ${errors.length}`)
if (written.length > 0) {
  console.log(`total ${(totalBytes / 1024 / 1024).toFixed(1)} MB, mean ${Math.round(totalBytes / written.length / 1024)} KB`)
}
for (const error of errors.slice(0, 10)) console.error(`  ✗ ${error.key}: ${error.error}`)
if (errors.length > 0) process.exit(1)
