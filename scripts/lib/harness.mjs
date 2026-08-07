// Tiny assertion harness shared by every scripts/verify-*.mjs.
// No framework: each verify script is a plain node program that exits non-zero
// on failure, so `node scripts/verify-foo.mjs` works standalone and in CI.

let passed = 0
const failures = []
let currentSuite = ''

export function suite(name) {
  currentSuite = name
}

export function check(label, fn) {
  const full = currentSuite ? `${currentSuite} › ${label}` : label
  try {
    fn()
    passed++
  } catch (error) {
    failures.push({ label: full, error })
    // Set the exit code here rather than in report(), so a script that throws
    // before it reaches report() — or forgets to call it — still fails loudly.
    process.exitCode = 1
  }
}

export function assert(condition, message) {
  if (!condition) throw new Error(message ?? 'assertion failed')
}

export function assertEqual(actual, expected, message) {
  if (!Object.is(actual, expected)) {
    throw new Error(`${message ?? 'not equal'}: expected ${format(expected)}, got ${format(actual)}`)
  }
}

export function assertDeepEqual(actual, expected, message) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) {
    throw new Error(`${message ?? 'not deep equal'}:\n  expected ${b}\n  actual   ${a}`)
  }
}

export function assertThrows(fn, message) {
  let threw = false
  try {
    fn()
  } catch {
    threw = true
  }
  if (!threw) throw new Error(message ?? 'expected function to throw')
}

function format(value) {
  if (typeof value === 'string') return JSON.stringify(value)
  return String(value)
}

let reported = false

export function report(title) {
  reported = true
  const total = passed + failures.length
  if (failures.length === 0) {
    console.log(`✓ ${title}: ${passed}/${total} checks passed`)
    return
  }
  console.error(`✗ ${title}: ${failures.length}/${total} checks failed`)
  for (const { label, error } of failures) {
    console.error(`  ✗ ${label}\n    ${error.message}`)
  }
  process.exitCode = 1
}

// A script that runs checks but never reports is a script whose result nobody
// reads. Treat that as a failure rather than a silent pass — most often it means
// the script died partway through and the remaining checks never ran.
process.on('exit', (code) => {
  if (code === 0 && !reported && passed + failures.length > 0) {
    console.error('✗ verify script ran checks but never called report(); refusing to pass silently')
    process.exitCode = 1
  }
})

