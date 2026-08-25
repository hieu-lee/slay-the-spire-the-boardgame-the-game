// Packages Imagegen 2x2 RGBA boss sheets into compact idle/attack WebPs.
// Usage: node scripts/sync-boss-animation-art.mjs boss_id=/path/to/sheet.png [...]
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(repoRoot, 'public/assets/combat/enemies/animations')
const sheets = process.argv.slice(2).map((arg) => {
  const split = arg.indexOf('=')
  const id = arg.slice(0, split)
  const path = resolve(arg.slice(split + 1))
  if (split < 1 || !/^[a-z0-9_]+$/.test(id) || !existsSync(path)) {
    throw new Error(`expected boss_id=/existing/sheet.png, got: ${arg}`)
  }
  return { id, path }
})

if (sheets.length === 0) throw new Error('pass at least one boss_id=/path/to/sheet.png')
for (const command of ['cwebp', 'img2webp']) {
  if (spawnSync(command, ['-version'], { stdio: 'ignore' }).error) {
    throw new Error(`missing ${command}; install the WebP tools first`)
  }
}

function pngSize(path) {
  const header = readFileSync(path).subarray(0, 24)
  if (header.toString('ascii', 1, 4) !== 'PNG') throw new Error(`${path} is not a PNG`)
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) }
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || `${command} failed`)
}

mkdirSync(outDir, { recursive: true })
for (const { id, path } of sheets) {
  const { width, height } = pngSize(path)
  const halfW = Math.floor(width / 2)
  const halfH = Math.floor(height / 2)
  const cropW = halfW
  const cropH = halfH
  const x = width - cropW
  const y = height - cropH
  const temp = mkdtempSync(join(tmpdir(), `boss-${id}-`))
  const frames = [
    ['idle-1', 0, 0],
    ['idle-2', x, 0],
    ['windup', 0, y],
    ['impact', x, y],
  ]
  try {
    for (const [name, left, top] of frames) {
      run('cwebp', [
        '-quiet', '-q', '90', '-alpha_q', '100',
        '-crop', String(left), String(top), String(cropW), String(cropH),
        '-resize', '640', '0', path, '-o', join(temp, `${name}.webp`),
      ])
    }
    run('img2webp', [
      '-loop', '0', '-min_size',
      '-d', '900', join(temp, 'idle-1.webp'),
      '-d', '900', join(temp, 'idle-2.webp'),
      '-d', '900', join(temp, 'idle-1.webp'),
      '-o', join(outDir, `${id}-idle.webp`),
    ])
    run('img2webp', [
      '-loop', '1', '-min_size',
      '-d', '170', join(temp, 'windup.webp'),
      '-d', '330', join(temp, 'impact.webp'),
      '-o', join(outDir, `${id}-attack.webp`),
    ])
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

console.log(`packaged ${sheets.length} boss animation sheets in ${outDir}`)
