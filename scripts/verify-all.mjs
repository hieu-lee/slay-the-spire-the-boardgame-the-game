// Runs every scripts/verify-*.mjs (except this one) and reports a summary.
// Usage: node scripts/verify-all.mjs [--jobs=N] [filter...]
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { cpus } from 'node:os'

const scriptsDir = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const jobsArg = args.find((a) => a.startsWith('--jobs='))
const jobs = jobsArg ? Math.max(1, Number(jobsArg.slice(7))) : Math.max(1, Math.min(8, cpus().length - 1))
const filters = args.filter((a) => !a.startsWith('--'))

const scripts = readdirSync(scriptsDir)
  .filter((f) => f.startsWith('verify-') && f.endsWith('.mjs') && f !== 'verify-all.mjs')
  .filter((f) => filters.length === 0 || filters.some((needle) => f.includes(needle)))
  .sort()

if (scripts.length === 0) {
  console.error('no verify scripts matched')
  process.exit(1)
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

const queue = [...scripts]
const results = []
await Promise.all(
  Array.from({ length: Math.min(jobs, queue.length) }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const result = await run(next)
      results.push(result)
      process.stdout.write(result.code === 0 ? '.' : 'F')
    }
  }),
)
process.stdout.write('\n')

results.sort((a, b) => a.script.localeCompare(b.script))
const failed = results.filter((r) => r.code !== 0)
for (const result of results) {
  if (result.code !== 0 || process.env.VERBOSE) console.log(result.out)
}

console.log(`\n${results.length - failed.length}/${results.length} verify scripts passed`)
if (failed.length > 0) {
  console.error(`failed: ${failed.map((f) => f.script).join(', ')}`)
  process.exit(1)
}
