import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import {
  affectedVerifiers, browserScript, changedPaths, drivesABrowser, mergeBase, needsTypecheck, requiresFullSuite,
} from './lib/affected-verifiers.mjs'
import { suite, check, assert, assertDeepEqual, assertEqual, report } from './lib/harness.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scripts = readdirSync(resolve(root, 'scripts'))
  .filter((file) => file.startsWith('verify-') && file.endsWith('.mjs') && file !== 'verify-all.mjs')
  .sort()
const affected = (...files) => affectedVerifiers(root, files, scripts)

suite('verification pipeline')
check('logic changes select dependent logic checks and direct browser consumers', () => {
  const selected = affected('src/game/rng.ts')
  assert(selected.includes('verify-rng.mjs'))
  assert(selected.includes('verify-browser.mjs'))
  assert(selected.includes('verify-online-browser.mjs'))
  assert(!selected.includes('verify-noncombat-browser.mjs'))
})
check('shared engine changes select every browser flow that imports them', () => {
  assertDeepEqual(affected('src/game/run.ts').filter((script) => script.includes('browser')), [
    'verify-browser.mjs', 'verify-noncombat-browser.mjs', 'verify-online-browser.mjs',
  ])
  assertDeepEqual(affected('src/game/achievements.ts').filter((script) => script.includes('browser')), [
    'verify-noncombat-browser.mjs',
  ])
  assert(affected('src/game/damage.ts').includes('verify-browser.mjs'))
})
check('frontend surfaces select only their owning browser suite', () => {
  assertDeepEqual(affected('src/ui/CombatScreen.tsx').filter((script) => script.includes('browser')), [
    'verify-browser.mjs', 'verify-online-browser.mjs',
  ])
  assertDeepEqual(affected('src/ui/RoomScreen.tsx').filter((script) => script.includes('browser')), [
    'verify-browser.mjs', 'verify-noncombat-browser.mjs', 'verify-online-browser.mjs',
  ])
  assertDeepEqual(affected('src/ui/OnlineGame.tsx').filter((script) => script.includes('browser')), ['verify-online-browser.mjs'])
  assertDeepEqual(affected('src\\ui\\OnlineGame.tsx').filter((script) => script.includes('browser')), ['verify-online-browser.mjs'])
  assert(affected('src/ui/icons.ts').includes('verify-noncombat-browser.mjs'))
  assert(affected('src/ui/run-summary-data.ts').includes('verify-noncombat-browser.mjs'))
  assert(affected('src/ui/RewardScreen.tsx').includes('verify-browser.mjs'))
  assert(affected('src/ui/RunSummary.tsx').includes('verify-browser.mjs'))
  assertDeepEqual(affected('src/ui/StartMenu.tsx').filter((script) => script.includes('browser')), [
    'verify-browser.mjs', 'verify-noncombat-browser.mjs', 'verify-online-browser.mjs',
  ])
})
check('an engine submodule selects what its barrel selects', () => {
  // combat.ts is a barrel over src/game/combat/. Nothing outside the engine
  // imports those files directly, so without this the browser suites stop
  // running for any engine change made inside them.
  assertDeepEqual(affected('src/game/combat/effects.ts'), affected('src/game/combat.ts'))
  assertDeepEqual(affected('src/game/run/events.ts'), affected('src/game/run.ts'))
  // Answering for the barrel must not make an unimported new module look
  // covered: a file no script reaches still runs everything.
  assertDeepEqual(affected('src/game/combat/not-imported-yet.ts'), scripts)
  assertDeepEqual(affected('src/game/run/not-imported-yet.ts'), scripts)
})
check('shared frontend and toolchain changes stay conservative', () => {
  for (const sheet of ['src/ui/chrome.css', 'src/ui/chrome/keys.css', 'src/ui/styles/hand.css']) {
    assertDeepEqual(affected(sheet).filter((script) => script.includes('browser')), [
      'verify-browser.mjs', 'verify-noncombat-browser.mjs', 'verify-online-browser.mjs',
    ], sheet)
  }
  assertDeepEqual(affected('package.json'), scripts)
  assertDeepEqual(affected('pnpm-workspace.yaml'), scripts)
})
check('assets and the selector itself keep focused checks', () => {
  const merchant = affected('public/assets/noncombat/merchant/test.webp')
  assert(merchant.includes('verify-assets.mjs'))
  assert(merchant.includes('verify-noncombat-browser.mjs'))
  assert(merchant.includes('verify-online-browser.mjs'))
  assert(affected('data/raw/items.csv').includes('verify-items.mjs'))
  assert(affected('data/raw/enemies-events-elites.csv').includes('verify-events.mjs'))
  assert(affected('data/raw/player-cards.csv').includes('verify-combat.mjs'))
  assert(affected('public/assets/noncombat/events/big-fish.webp').includes('verify-run-presentation.mjs'))
  assert(affected('src/game/cards.ts').includes('verify-browser.mjs'))
  assert(!affected('data/card-index.json').some((script) => script.includes('browser')))
  assert(!affected('scripts/room-server.mjs').includes('verify-browser.mjs'))
  assertDeepEqual(affected('scripts/lib/affected-verifiers.mjs'), ['verify-pipeline.mjs'])
  assertDeepEqual(affected('scripts/verify-all.mjs'), scripts)
  assertDeepEqual(affected('scripts/verify-deleted.mjs'), scripts)
  assertDeepEqual(affected('scripts/lib/browser-screen-audit.mjs').filter((script) => script.includes('browser')), [
    'verify-browser.mjs', 'verify-noncombat-browser.mjs', 'verify-online-browser.mjs',
  ])
  assertDeepEqual(affected('src/game/new-system.ts'), scripts)
  assertDeepEqual(affected('src/ui/CombatScreen.tsx', 'src/game/new-system.ts'), scripts)
})
check('browser lane detection handles formatting and wrappers', () => {
  assert(drivesABrowser('verify-example.mjs', 'import {\n  chromium,\n} from "playwright"'))
  assert(drivesABrowser('verify-example.mjs', 'const playwright = require("playwright")'))
  assert(drivesABrowser('verify-accessibility.mjs', "import './wrapper.mjs'", ['import { chromium } from "playwright"']))
  assert(drivesABrowser('verify-accessibility.mjs', "import './wrapper.mjs'", ["export { chromium } from 'playwright'"]))
  assert(drivesABrowser('verify-accessibility.mjs', "import './wrapper.mjs'", ["export * from 'playwright'"]))
  assert(drivesABrowser('verify-accessibility.mjs', "await import('playwright')"))
  assert(drivesABrowser('verify-custom-browser.mjs', "import './wrapper.mjs'"))
  assert(!drivesABrowser('verify-example.mjs', '// playwright is intentionally absent'))
  assert(!browserScript('verify-pipeline.mjs', root))
})
check('rename parsing keeps both ownership paths', () => {
  assertDeepEqual(changedPaths('R100\0src/ui/RoomScreen.tsx\0src/ui/CombatRoom.tsx\0M\0package.json\0'), [
    'src/ui/RoomScreen.tsx', 'src/ui/CombatRoom.tsx', 'package.json',
  ])
  assert(!requiresFullSuite('R100\0src/ui/RoomScreen.tsx\0src/ui/CombatRoom.tsx\0M\0package.json\0'))
  assert(requiresFullSuite('T\0src/game/run.ts\0'))
  assert(requiresFullSuite('D\0src/game/run.ts\0'))
  assert(requiresFullSuite('U\0src/game/run.ts\0'))
})
check('changed refs compare from their merge base', () => {
  const repo = mkdtempSync(resolve(tmpdir(), 'verify-pipeline-'))
  const git = (...args) => spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: repo, encoding: 'utf8' })
  try {
    assertEqual(git('init', '-q').status, 0)
    writeFileSync(resolve(repo, 'file'), 'base')
    assertEqual(git('add', 'file').status, 0)
    assertEqual(git('commit', '-qm', 'base').status, 0)
    assertEqual(git('branch', 'upstream').status, 0)
    writeFileSync(resolve(repo, 'file'), 'feature')
    assertEqual(git('commit', '-qam', 'feature').status, 0)
    const expected = git('rev-parse', 'HEAD^').stdout.trim()
    assertEqual(git('switch', '-q', 'upstream').status, 0)
    writeFileSync(resolve(repo, 'upstream'), 'upstream')
    assertEqual(git('add', 'upstream').status, 0)
    assertEqual(git('commit', '-qm', 'upstream').status, 0)
    assertEqual(git('switch', '-q', '-').status, 0)
    assertEqual(mergeBase(repo, 'upstream'), expected)
  } finally { rmSync(repo, { recursive: true, force: true }) }
})
check('source changes require incremental type checking', () => {
  assert(needsTypecheck(['src/game/run.ts']))
  assert(needsTypecheck(['src\\ui\\App.tsx']))
  assert(needsTypecheck(['tsconfig.json']))
  assert(needsTypecheck(['package.json']))
  assert(needsTypecheck(['pnpm-lock.yaml']))
  assert(needsTypecheck(['pnpm-workspace.yaml']))
  assert(!needsTypecheck(['scripts/verify-all.mjs']))
})
check('changed mode rejects filters that could hide an affected check', () => {
  const result = spawnSync(process.execPath, [resolve(root, 'scripts/verify-all.mjs'), '--changed', 'rng'], { encoding: 'utf8' })
  assertEqual(result.status, 2)
  assert(result.stderr.includes('--changed cannot be combined with script filters'))
})
// The heavy-lane concurrency/retry logic below (verify-all.mjs's `run`, and the
// `heavyJobs > 1` retry gate) has twice shipped with real bugs that only showed
// up under actual concurrent execution — a silently-swallowed self-healed flake,
// and retries firing with no real contention to retry against. Static reading
// missed both; these checks run a throwaway copy of verify-all.mjs against
// disposable fixture "heavy" scripts (named with "browser" so they're
// classified heavy) to lock the fixed behavior in. The copy lives entirely in
// an mkdtemp directory, never the tracked scripts/ tree, so a hard kill
// mid-test (not just a thrown assertion) can't leave a fixture file behind for
// a later real `pnpm verify` to mistake for an actual verify script — the same
// isolation verify-architecture.mjs already uses for its own fixture files.
// A timeout guards the exact failure mode these checks exist to catch: if a
// future regression turns the retry loop into an infinite one, the test fails
// fast instead of hanging the whole pipeline forever.
const runRealVerifyAll = (...args) => spawnSync(process.execPath, [resolve(root, 'scripts/verify-all.mjs'), ...args], { encoding: 'utf8', timeout: 30_000 })
const withHeavyLaneFixture = (buildFixtures, run) => {
  // verify-all.mjs resolves its own project root as `dirname(scriptsDir)` and
  // then rejoins 'scripts' onto it (see browserScript() in affected-verifiers.mjs)
  // — it assumes it always lives in a directory literally named "scripts", so
  // the copy needs that same shape or heavy-suite detection silently throws
  // (caught by `isBrowser`'s try/catch) and every fixture falls into the light
  // lane with no retries at all, which looks like a passing test for the wrong
  // reason rather than an error.
  const projectRoot = mkdtempSync(resolve(tmpdir(), 'verify-pipeline-heavy-'))
  const dir = resolve(projectRoot, 'scripts')
  try {
    mkdirSync(dir)
    cpSync(resolve(root, 'scripts/verify-all.mjs'), resolve(dir, 'verify-all.mjs'))
    cpSync(resolve(root, 'scripts/lib'), resolve(dir, 'lib'), { recursive: true })
    for (const [name, content] of Object.entries(buildFixtures(dir))) writeFileSync(resolve(dir, name), content)
    const runVerifyAll = (...args) => spawnSync(process.execPath, [resolve(dir, 'verify-all.mjs'), ...args], { encoding: 'utf8', timeout: 30_000 })
    run(runVerifyAll, dir)
  } finally {
    rmSync(projectRoot, { recursive: true, force: true })
  }
}
// Fails on its first invocation, then passes on every one after — simulates a
// suite that lost to contention once but would pass standalone, via a counter
// file since each retry is a brand-new child process with no shared memory.
const flakyOnceScript = (counterFile) => [
  "import { readFileSync, writeFileSync } from 'node:fs'",
  `const n = Number(readFileSync(${JSON.stringify(counterFile)}, 'utf8'))`,
  `writeFileSync(${JSON.stringify(counterFile)}, String(n + 1))`,
  "if (n < 1) { console.error('simulated contention failure'); process.exit(1) }",
  "console.log('passed')",
].join('\n')

check('a heavy suite that fails once then passes is retried and reported, never silently', () => {
  withHeavyLaneFixture((dir) => ({
    counter: '0',
    'verify-test-fixture-flaky-browser.mjs': flakyOnceScript(resolve(dir, 'counter')),
    'verify-test-fixture-friend-browser.mjs': "console.log('ok')\n",
  }), (runVerifyAll) => {
    // --jobs/--heavy forced so this doesn't depend on the host's core count.
    const result = runVerifyAll('--jobs=4', '--heavy=2', 'test-fixture-flaky-browser', 'test-fixture-friend-browser')
    assertEqual(result.status, 0)
    assert(result.stdout.includes('flaked then recovered: verify-test-fixture-flaky-browser.mjs (1 retry)'), result.stdout)
  })
})
check('a heavy suite that never recovers still fails, with every attempt shown', () => {
  withHeavyLaneFixture(() => ({
    'verify-test-fixture-broken-browser.mjs': "console.error('real bug')\nprocess.exit(1)\n",
    'verify-test-fixture-friend2-browser.mjs': "console.log('ok')\n",
  }), (runVerifyAll) => {
    const result = runVerifyAll('--jobs=4', '--heavy=2', 'test-fixture-broken-browser', 'test-fixture-friend2-browser')
    assertEqual(result.status, 1)
    assert(result.stdout.includes('--- retry 1/2 (still failing) ---'), result.stdout)
    assert(result.stdout.includes('--- retry 2/2 (still failing) ---'), result.stdout)
    assert(result.stderr.includes('failed: verify-test-fixture-broken-browser.mjs'), result.stderr)
  })
})
check('--heavy=1 gets zero retries even when heavy suites are queued together', () => {
  withHeavyLaneFixture((dir) => ({
    counter: '0',
    'verify-test-fixture-flaky2-browser.mjs': flakyOnceScript(resolve(dir, 'counter')),
    'verify-test-fixture-friend3-browser.mjs': "console.log('ok')\n",
  }), (runVerifyAll) => {
    const result = runVerifyAll('--jobs=4', '--heavy=1', 'test-fixture-flaky2-browser', 'test-fixture-friend3-browser')
    assertEqual(result.status, 1)
    assert(!result.stdout.includes('retry'), result.stdout)
    assert(result.stderr.includes('failed: verify-test-fixture-flaky2-browser.mjs'), result.stderr)
  })
})
check('--heavy-retries accepts 0 to explicitly disable retries without forcing --heavy=1', () => {
  const badValue = runRealVerifyAll('--heavy-retries=abc', '--list')
  assertEqual(badValue.status, 2)
  assert(badValue.stderr.includes('--heavy-retries needs a whole number >= 0'))
  withHeavyLaneFixture((dir) => ({
    counter: '0',
    'verify-test-fixture-flaky3-browser.mjs': flakyOnceScript(resolve(dir, 'counter')),
    'verify-test-fixture-friend4-browser.mjs': "console.log('ok')\n",
  }), (runVerifyAll) => {
    const result = runVerifyAll('--jobs=4', '--heavy=2', '--heavy-retries=0', 'test-fixture-flaky3-browser', 'test-fixture-friend4-browser')
    assertEqual(result.status, 1)
    assert(!result.stdout.includes('retry'), result.stdout)
  })
})
// Each of the 3 fixtures below bumps a shared "how many are active right now"
// counter under a mkdir-based lock (directory creation is atomic at the OS
// level, unlike a plain read-modify-write on a file, which two processes
// starting in the same instant could both read before either writes — that
// race would silently undercount and make this test pass whether or not the
// default is actually capped). This is the one path none of the checks above
// exercise: they all pin an explicit --heavy=N, so a change to the default
// formula itself (verify-all.mjs's `Math.max(1, Math.min(2, heavyQueue.length))`)
// could regress without any of them noticing.
const concurrencyProbeScript = (dir) => [
  "import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'",
  `const activeFile = ${JSON.stringify(resolve(dir, 'active'))}`,
  `const maxActiveFile = ${JSON.stringify(resolve(dir, 'max-active'))}`,
  `const lockDir = ${JSON.stringify(resolve(dir, 'lock'))}`,
  // Bounded and EEXIST-only: a non-contention error (ENOENT, permissions)
  // fails immediately instead of spinning, and a sibling that crashes while
  // holding the lock loses it after 15s instead of hanging the others for the
  // full 30s outer timeout (which only kills the direct child anyway, not a
  // grandchild fixture process already spinning on a stale lock). The 15s
  // margin — not the 5s a crash alone would need — is sized for this test
  // running in the light lane *alongside the real heavy suites it's testing
  // around*: genuine OS scheduling delay under that load can stall a lock
  // holder's few-microsecond critical section without anything having
  // crashed. The sleep between attempts matters for the same reason: an
  // unthrottled spin adds to the very CPU contention it needs to survive.
  'const withLock = (fn) => {',
  '  const deadline = Date.now() + 15000',
  '  const sleepBuffer = new Int32Array(new SharedArrayBuffer(4))',
  '  for (;;) {',
  '    try { mkdirSync(lockDir); break }',
  '    catch (error) {',
  '      if (error.code !== "EEXIST") throw error',
  '      if (Date.now() > deadline) throw new Error("lock timed out — a sibling probe crashed while holding it, or the machine is too contended to schedule it")',
  '      Atomics.wait(sleepBuffer, 0, 0, 5)',
  '    }',
  '  }',
  '  try { return fn() } finally { rmSync(lockDir, { recursive: true, force: true }) }',
  '}',
  'withLock(() => {',
  '  const active = Number(readFileSync(activeFile, "utf8")) + 1',
  '  writeFileSync(activeFile, String(active))',
  '  writeFileSync(maxActiveFile, String(Math.max(Number(readFileSync(maxActiveFile, "utf8")), active)))',
  '})',
  'await new Promise((r) => setTimeout(r, 400))',
  'withLock(() => writeFileSync(activeFile, String(Number(readFileSync(activeFile, "utf8")) - 1)))',
].join('\n')
check('the default heavy concurrency is 2, not every queued suite', () => {
  withHeavyLaneFixture((dir) => ({
    active: '0',
    'max-active': '0',
    'verify-test-fixture-conc1-browser.mjs': concurrencyProbeScript(dir),
    'verify-test-fixture-conc2-browser.mjs': concurrencyProbeScript(dir),
    'verify-test-fixture-conc3-browser.mjs': concurrencyProbeScript(dir),
  }), (runVerifyAll, dir) => {
    // No --heavy flag — this exercises the real default, not an override.
    const result = runVerifyAll(
      '--jobs=8', 'test-fixture-conc1-browser', 'test-fixture-conc2-browser', 'test-fixture-conc3-browser',
    )
    assertEqual(result.status, 0)
    const peak = Number(readFileSync(resolve(dir, 'max-active'), 'utf8'))
    assertEqual(peak, 2, `expected the default to cap heavy concurrency at 2, observed a peak of ${peak}`)
  })
})
report('verification pipeline')
