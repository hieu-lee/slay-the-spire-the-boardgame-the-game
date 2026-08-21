// Runs every scripts/verify-*.mjs (except this one) and reports a summary.
// Usage: node scripts/verify-all.mjs [--jobs=N] [--heavy=N] [filter...]
//
// The pool used to treat a pure-logic script and a full browser suite as equal
// cost. A browser suite boots its own Vite AND its own Chromium, so several at
// once starve each other into timeouts — four "failures" in this repo turned out
// to be that, each passing on its own moments later. The browser suites get their
// own narrow lane now; the cheap scripts still fill the wide one, so wall time is
// unchanged (the heavy ones dominate it either way) and the false failures stop.
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { cpus } from 'node:os'

const scriptsDir = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
// Rejected rather than coerced: `Math.max(1, Number('abc'))` is NaN, and
// `Array.from({ length: NaN })` is empty — so a typo'd --heavy= ran ZERO browser
// suites and still exited 0, which reads exactly like a green run.
const count = (flag, fallback) => {
  const arg = args.find((a) => a.startsWith(`${flag}=`))
  if (!arg) return fallback
  const parsed = Number(arg.slice(flag.length + 1))
  if (!Number.isFinite(parsed) || parsed < 1) {
    console.error(`${flag} needs a positive number, got ${JSON.stringify(arg.slice(flag.length + 1))}`)
    process.exit(2)
  }
  return Math.floor(parsed)
}
// One browser suite at a time by default. Two still starved each other on a
// 16-core machine — one online run in four failed and then passed standalone —
// and a flake here costs a whole review round to tell apart from a regression.
const requestedHeavyJobs = count('--heavy', 1)
// `--jobs` remains the TOTAL child-process cap. In particular, `--jobs=1` is the
// repository's serial release gate; changing it to one worker per lane brought
// browser contention back under a flag whose whole purpose is to prevent it.
const jobs = count('--jobs', Math.max(1, Math.min(8, cpus().length - 1)))
const filters = args.filter((a) => !a.startsWith('--'))

const scripts = readdirSync(scriptsDir)
  .filter((f) => f.startsWith('verify-') && f.endsWith('.mjs') && f !== 'verify-all.mjs')
  .filter((f) => filters.length === 0 || filters.some((needle) => f.includes(needle)))
  .sort()

if (scripts.length === 0) {
  console.error('no verify scripts matched')
  process.exit(1)
}

// Detected, not hard-coded, so a new browser suite is classified on its own.
const drivesABrowser = (script) => {
  // Anchored to an import at the start of a line, so a script that merely mentions
  // playwright in a comment does not get sent to the narrow browser lane.
  try { return /^import .*from 'playwright'|^const .*require\('playwright'\)/m.test(readFileSync(join(scriptsDir, script), 'utf8')) }
  catch { return false }
}

function run(script) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(scriptsDir, script)], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('close', (code) => resolve({ script, code, out: out.trimEnd() }))
  })
}

// One pass: `drivesABrowser` reads the file, so filtering twice read every script
// twice.
const heavyQueue = []
const lightQueue = []
for (const script of scripts) (drivesABrowser(script) ? heavyQueue : lightQueue).push(script)
const results = []

const lane = (queue) => async () => {
  for (let next = queue.shift(); next; next = queue.shift()) {
    const result = await run(next)
    results.push(result)
    process.stdout.write(result.code === 0 ? '.' : 'F')
  }
}

if (jobs === 1) {
  await lane([...scripts])()
} else {
  // Leave one slot for light work when both lanes have work. If the filtered run
  // contains only browser suites, every requested slot can serve the heavy lane.
  const heavyJobs = Math.min(requestedHeavyJobs, heavyQueue.length, lightQueue.length ? jobs - 1 : jobs)
  const lightJobs = Math.min(jobs - heavyJobs, lightQueue.length)
  await Promise.all([
    ...Array.from({ length: lightJobs }, lane(lightQueue)),
    ...Array.from({ length: heavyJobs }, lane(heavyQueue)),
  ])
}
process.stdout.write('\n')

results.sort((a, b) => a.script.localeCompare(b.script))
// A script that never ran is not a script that passed.
if (results.length !== scripts.length) {
  console.error(`\nonly ${results.length} of ${scripts.length} verify scripts ran`)
  process.exit(1)
}
const failed = results.filter((r) => r.code !== 0)
for (const result of results) {
  if (result.code !== 0 || process.env.VERBOSE) console.log(result.out)
}

console.log(`\n${results.length - failed.length}/${results.length} verify scripts passed`)
if (failed.length > 0) {
  console.error(`failed: ${failed.map((f) => f.script).join(', ')}`)
  process.exit(1)
}
