import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
report('verification pipeline')
