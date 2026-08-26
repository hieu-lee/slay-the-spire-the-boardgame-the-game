// Runs every scripts/verify-*.mjs (except this one) and reports a summary.
// Usage: node scripts/verify-all.mjs [--changed[=ref]] [--jobs=N] [--heavy=N] [--heavy-retries=N] [filter...]
//
// The pool used to treat a pure-logic script and a full browser suite as equal
// cost. A browser suite boots its own Vite AND its own Chromium, so several at
// once starve each other into timeouts — four "failures" in this repo turned out
// to be that, each passing on its own moments later. The browser suites get their
// own narrow lane now; the cheap scripts still fill the wide one.
//
// The heavy lane itself used to run one suite at a time — serialized, wall time
// was the SUM of every browser suite (verify-browser + verify-noncombat-browser +
// verify-online-browser), the single biggest cost in this whole file by far. That
// serial default was itself a fix for measured contention: two heavy suites run
// together on a 16-core machine failed about 1 in 4 times, each passing standalone
// moments later. The heavy lane now defaults to running up to 2 suites at once —
// the concurrency level that number was actually measured at — with up to
// `--heavy-retries` extra attempts per contending suite (default 2) to absorb
// exactly that kind of flake, chosen so three independent flakes in a row
// (0.25^3 ≈ 1.6%) is unlikely. `--heavy=3` (or higher, as more suites are added)
// opts into running every suite at once for a bit more speed, but that level of
// contention has never been measured, only assumed to be no worse — the default
// stays at the number with real data behind it. In practice this default still
// gets nearly the full win: verify-browser alone (~370s standalone) outweighs
// the other two combined (~220s), so two workers already turn the heavy lane's
// wall time into roughly verify-browser's own runtime, the same as running all
// three at once would — confirmed by full-suite runs landing in that same
// ~370-380s range. If
// `flaked then recovered` starts showing up often in normal runs, that's the
// signal this default (or the retry count) needs revisiting — it's not printed
// only for that purpose, but it's the number worth watching. See the retry
// gate and the flake summary below for exactly when retries fire and how
// they're reported.
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { cpus } from 'node:os'
import { affectedVerifiers, browserScript, changedPaths, mergeBase, needsTypecheck, requiresFullSuite } from './lib/affected-verifiers.mjs'

const scriptsDir = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
// Rejected rather than coerced: `Math.max(1, Number('abc'))` is NaN, and
// `Array.from({ length: NaN })` is empty — so a typo'd --heavy= ran ZERO browser
// suites and still exited 0, which reads exactly like a green run.
// `min` defaults to 1 (a job/worker count of 0 is meaningless), but
// --heavy-retries legitimately means "none" at 0 — the exact value the
// concurrent-heavy-lane default already falls back to when nothing contends,
// so forcing it through the CLI has to work the same way, not just fall out
// as a side effect of `--heavy=1`.
const count = (flag, fallback, min = 1) => {
  const arg = args.find((a) => a.startsWith(`${flag}=`))
  if (!arg) return fallback
  const parsed = Number(arg.slice(flag.length + 1))
  if (!Number.isInteger(parsed) || parsed < min) {
    console.error(`${flag} needs a whole number >= ${min}, got ${JSON.stringify(arg.slice(flag.length + 1))}`)
    process.exit(2)
  }
  return parsed
}
// No fallback yet — the default depends on how many heavy suites are queued
// (below), so an explicit --heavy=N is captured here and resolved once the
// heavy queue is known. Passing 1 still gets the old fully-serial behavior.
const explicitHeavyJobs = count('--heavy', undefined)
const explicitHeavyRetries = count('--heavy-retries', undefined, 0)
// `--jobs` remains the TOTAL child-process cap. In particular, `--jobs=1` is the
// repository's serial release gate; changing it to one worker per lane brought
// browser contention back under a flag whose whole purpose is to prevent it.
const jobs = count('--jobs', Math.max(1, Math.min(8, cpus().length - 1)))
const filters = args.filter((a) => !a.startsWith('--'))
const changedArg = args.find((a) => a === '--changed' || a.startsWith('--changed='))
const listOnly = args.includes('--list')
if (changedArg && filters.length) {
  console.error('--changed cannot be combined with script filters')
  process.exit(2)
}

let scripts = readdirSync(scriptsDir)
  .filter((f) => f.startsWith('verify-') && f.endsWith('.mjs') && f !== 'verify-all.mjs')
  .filter((f) => filters.length === 0 || filters.some((needle) => f.includes(needle)))
  .sort()
let changedFiles = []

if (changedArg) {
  const base = changedArg.includes('=') ? changedArg.slice(changedArg.indexOf('=') + 1) : 'HEAD'
  if (!base) {
    console.error('--changed needs a git ref after =')
    process.exit(2)
  }
  const root = join(scriptsDir, '..')
  let comparison
  try { comparison = mergeBase(root, base) }
  catch (error) {
    console.error(error.message)
    process.exit(2)
  }
  const diff = spawnSync('git', ['diff', '--name-status', '-z', comparison, '--'], { cwd: root, encoding: 'utf8' })
  const untracked = spawnSync('git', ['ls-files', '-z', '--others', '--exclude-standard'], { cwd: join(scriptsDir, '..'), encoding: 'utf8' })
  if (diff.status !== 0 || untracked.status !== 0) {
    console.error((diff.stderr || untracked.stderr).trim())
    process.exit(2)
  }
  changedFiles = [...new Set([...changedPaths(diff.stdout), ...untracked.stdout.split('\0').filter(Boolean)])]
  scripts = requiresFullSuite(diff.stdout) ? scripts : affectedVerifiers(root, changedFiles, scripts)
  console.log(changedFiles.length ? `changed: ${changedFiles.join(', ')}` : 'no changed files')
}

if (scripts.length === 0) {
  if (changedArg) process.exit(0)
  console.error('no verify scripts matched')
  process.exit(1)
}

if (listOnly) {
  console.log(scripts.join('\n'))
  process.exit(0)
}

if (changedArg && needsTypecheck(changedFiles)) {
  const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const typecheck = spawnSync(command, ['typecheck'], { cwd: join(scriptsDir, '..'), stdio: 'inherit' })
  if (typecheck.status !== 0) process.exit(typecheck.status ?? 1)
}

// Detected, not hard-coded, so a new browser suite is classified on its own.
const isBrowser = (script) => {
  try { return browserScript(script, join(scriptsDir, '..')) }
  catch { return false }
}

function runOnce(script) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(scriptsDir, script)], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('close', (code) => resolve({ script, code, out: out.trimEnd() }))
  })
}

// A light script is pure logic — if it fails, it's a regression, not a fluke, so
// it gets zero retries. A heavy script sharing the machine with other Chromium +
// Vite instances can fail from contention alone (see the file header); retrying
// it up to `retries` times tells that apart from a real regression by giving it
// the same chance to pass a script run alone already has.
//
// Every attempt's output is kept (not just the last one) — if a suite fails
// three different ways that's evidence of a real bug, not contention, and
// collapsing to only the final attempt would erase the one signal that tells
// the two apart. `retries` on the returned result is read by the caller to
// report a flake unconditionally, since a suite that fails then passes ends
// with code 0 and would otherwise never be distinguished from a clean pass.
async function run(script, retries = 0) {
  const attempts = [await runOnce(script)]
  while (attempts.at(-1).code !== 0 && attempts.length <= retries) attempts.push(await runOnce(script))
  const result = attempts.at(-1)
  result.retries = attempts.length - 1
  if (result.retries > 0) {
    result.out = attempts
      .map((a, i) => (i === 0 ? a.out : `--- retry ${i}/${retries} (${a.code === 0 ? 'passed' : 'still failing'}) ---\n${a.out}`))
      .join('\n')
  }
  return result
}

// One pass: `drivesABrowser` reads the file, so filtering twice read every script
// twice.
const heavyQueue = []
const lightQueue = []
for (const script of scripts) (isBrowser(script) ? heavyQueue : lightQueue).push(script)
const results = []

// Capped at 2 by default, not the full queue size — see the file header for why.
// Explicit --heavy=N (including 1, the old behavior, or 3+ to run every suite
// at once) still wins.
const requestedHeavyJobs = explicitHeavyJobs ?? Math.max(1, Math.min(2, heavyQueue.length))
const requestedHeavyRetries = explicitHeavyRetries ?? 2

const lane = (queue, retries = 0) => async () => {
  for (let next = queue.shift(); next; next = queue.shift()) {
    const result = await run(next, retries)
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
  // Gated on heavyJobs > 1, not just this branch: contention is a property of
  // heavy suites actually sharing the machine. `--heavy=1`, or a filtered run
  // that resolves to a single heavy suite, has nothing to contend with, so it
  // gets zero retries — the same deterministic, contention-free signal the old
  // fully-serial default always gave.
  const heavyRetries = heavyJobs > 1 ? requestedHeavyRetries : 0
  await Promise.all([
    ...Array.from({ length: lightJobs }, lane(lightQueue)),
    ...Array.from({ length: heavyJobs }, lane(heavyQueue, heavyRetries)),
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
// A suite that failed then passed on retry ends with code 0 — indistinguishable
// from a clean pass unless reported here explicitly. This is unconditional
// (not gated on VERBOSE) because it's the whole point of the retry: a flake
// that self-heals silently is a flake nobody knows to go investigate.
const flaked = results.filter((r) => r.code === 0 && r.retries > 0)
for (const result of results) {
  if (result.code !== 0 || process.env.VERBOSE) console.log(result.out)
}

console.log(`\n${results.length - failed.length}/${results.length} verify scripts passed`)
if (flaked.length > 0) {
  console.log(`flaked then recovered: ${flaked.map((f) => `${f.script} (${f.retries} retr${f.retries === 1 ? 'y' : 'ies'})`).join(', ')}`)
}
if (failed.length > 0) {
  console.error(`failed: ${failed.map((f) => f.script).join(', ')}`)
  process.exit(1)
}
