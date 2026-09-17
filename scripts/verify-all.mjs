// Runs every scripts/verify-*.mjs (except this one) and reports a summary.
// Usage: node scripts/verify-all.mjs [--changed[=ref]] [--lane=light|browser]
//   [--shard=INDEX/TOTAL] [--skip-typecheck] [--jobs=N] [--heavy=N]
//   [filter...]
//
// Browser suites share one lane because multiple Vite/browser processes on one
// machine create false timeouts. Optional sharding splits a selected set across callers.
import { readdirSync, statSync } from 'node:fs'
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
const count = (flag, fallback) => {
  const arg = args.find((a) => a.startsWith(`${flag}=`))
  if (!arg) return fallback
  const parsed = Number(arg.slice(flag.length + 1))
  if (!Number.isInteger(parsed) || parsed < 1) {
    console.error(`${flag} needs a whole number >= 1, got ${JSON.stringify(arg.slice(flag.length + 1))}`)
    process.exit(2)
  }
  return parsed
}
// An explicit --heavy=N can opt into local browser contention; the default is serial.
const explicitHeavyJobs = count('--heavy', undefined)
if (args.some((arg) => arg.startsWith('--heavy-retries'))) {
  console.error('--heavy-retries is not supported; fix flaky tests instead')
  process.exit(2)
}
// `--jobs` remains the TOTAL child-process cap. In particular, `--jobs=1` is the
// repository's serial release gate; changing it to one worker per lane brought
// browser contention back under a flag whose whole purpose is to prevent it.
const jobs = count('--jobs', Math.max(1, Math.min(8, cpus().length - 1)))
const filters = args.filter((a) => !a.startsWith('--'))
const changedArg = args.find((a) => a === '--changed' || a.startsWith('--changed='))
const listOnly = args.includes('--list')
const skipTypecheck = args.includes('--skip-typecheck')
const laneArg = args.find((a) => a.startsWith('--lane='))
const selectedLane = laneArg?.slice('--lane='.length)
if (laneArg && !['light', 'browser'].includes(selectedLane)) {
  console.error(`--lane needs light or browser, got ${JSON.stringify(selectedLane)}`)
  process.exit(2)
}
const shardArg = args.find((a) => a.startsWith('--shard='))
let shard
if (shardArg) {
  const match = /^(\d+)\/(\d+)$/.exec(shardArg.slice('--shard='.length))
  if (!match || Number(match[1]) < 1 || Number(match[2]) < 1 || Number(match[1]) > Number(match[2])) {
    console.error(`--shard needs INDEX/TOTAL with 1 <= INDEX <= TOTAL, got ${JSON.stringify(shardArg.slice('--shard='.length))}`)
    process.exit(2)
  }
  shard = { index: Number(match[1]), total: Number(match[2]) }
}
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

// Detected, not hard-coded, so a new browser suite is classified on its own.
const isBrowser = (script) => browserScript(script, join(scriptsDir, '..'))

function assignedShard(selected, { index, total }) {
  const buckets = Array.from({ length: total }, () => ({ bytes: 0, scripts: [] }))
  for (const script of [...selected].sort((a, b) =>
    statSync(join(scriptsDir, b)).size - statSync(join(scriptsDir, a)).size || a.localeCompare(b))) {
    const bucket = buckets.reduce((lightest, candidate) => candidate.bytes < lightest.bytes ? candidate : lightest)
    bucket.scripts.push(script)
    bucket.bytes += statSync(join(scriptsDir, script)).size
  }
  return buckets[index - 1].scripts.sort()
}

// Sharding happens after affected-check selection and lane classification, so
// the union of shards is exactly the original selected set. Each shard remains
// sorted and deterministic, making failures reproducible.
if (selectedLane) scripts = scripts.filter((script) => isBrowser(script) === (selectedLane === 'browser'))
if (shard) scripts = assignedShard(scripts, shard)

// Type checking belongs to the light lane and must still run if a future source
// change happens to select no light verifier. List mode remains a cheap query;
// callers may skip duplicate typechecks when scheduling multiple lanes.
if (!listOnly && changedArg && needsTypecheck(changedFiles) && !skipTypecheck) {
  const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const typecheck = spawnSync(command, ['typecheck'], { cwd: join(scriptsDir, '..'), stdio: 'inherit' })
  if (typecheck.status !== 0) process.exit(typecheck.status ?? 1)
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

function runOnce(script) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', join(scriptsDir, script)], { stdio: ['ignore', 'pipe', 'pipe'] })
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
for (const script of scripts) (isBrowser(script) ? heavyQueue : lightQueue).push(script)
const results = []

const requestedHeavyJobs = explicitHeavyJobs ?? 1

const lane = (queue) => async () => {
  for (let next = queue.shift(); next; next = queue.shift()) {
    const result = await runOnce(next)
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
