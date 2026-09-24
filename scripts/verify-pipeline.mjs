import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import {
  affectedVerifiers, browserScript, changedPaths, drivesABrowser, mergeBase, needsTypecheck, requiresFullSuite,
} from './lib/affected-verifiers.mjs'
import { suite, check, assert, assertDeepEqual, assertEqual, assertThrows, report } from './lib/harness.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scripts = readdirSync(resolve(root, 'scripts'))
  .filter((file) => file.startsWith('verify-') && file.endsWith('.mjs') && file !== 'verify-all.mjs')
  .sort()
const affected = (...files) => affectedVerifiers(root, files, scripts)
const affectedBrowser = (...files) => affected(...files).filter((script) => script.includes('browser'))
const includesEvery = (actual, expected, context) => {
  for (const script of expected) assert(actual.includes(script), `${context}: missing ${script}`)
}

suite('verification pipeline')
check('deep equality compares Set and Map contents', () => {
  assertDeepEqual(new Set([1, 2]), new Set([2, 1]))
  assertThrows(() => assertDeepEqual(new Set([1]), new Set([2])))
  assertThrows(() => assertDeepEqual(new Map([['key', 1]]), new Map([['key', 2]])))
  assertThrows(() => assertDeepEqual({ values: new Set([1]) }, { values: new Set([2]) }))
})
check('logic changes select dependent logic checks and direct browser consumers', () => {
  const selected = affected('src/game/rng.ts')
  assert(selected.includes('verify-rng.mjs'))
  assert(selected.includes('verify-browser.mjs'))
  assert(selected.includes('verify-online-browser.mjs'))
  assert(!selected.includes('verify-noncombat-browser.mjs'))
})
check('shared engine changes select every browser flow that imports them', () => {
  const run = affectedBrowser('src/game/run.ts')
  includesEvery(run, ['verify-browser.mjs', 'verify-noncombat-browser.mjs', 'verify-online-browser.mjs'], 'run barrel')
  assert(!run.includes('verify-animation-browser.mjs'), 'run barrel selected an unrelated animation fixture')
  assert(affected('src/game/damage.ts').includes('verify-browser.mjs'))
})
check('frontend surfaces select their cores and named focused browser checks', () => {
  const combat = affectedBrowser('src/ui/CombatScreen.tsx')
  includesEvery(combat, ['verify-browser.mjs', 'verify-online-browser.mjs',
    'verify-safari-combat-animation-browser.mjs', 'verify-courier-browser.mjs'], 'combat screen')
  assert(!combat.includes('verify-noncombat-browser.mjs'))
  assertEqual(combat.length, 11, 'combat screen selected an unrelated browser suite')
  const room = affectedBrowser('src/ui/RoomScreen.tsx')
  includesEvery(room, ['verify-browser.mjs', 'verify-noncombat-browser.mjs', 'verify-online-browser.mjs'], 'room screen')
  const online = affectedBrowser('src/ui/OnlineGame.tsx')
  includesEvery(online, ['verify-online-browser.mjs', 'verify-hosted-multiplayer-browser.mjs', 'verify-courier-browser.mjs'], 'online screen')
  assert(!online.includes('verify-browser.mjs'))
  assert(!online.includes('verify-noncombat-browser.mjs'))
  assertEqual(online.length, 3, 'online screen selected an unrelated browser suite')
  assertDeepEqual(affectedBrowser('src\\ui\\OnlineGame.tsx'), online)
  assertDeepEqual(affectedBrowser('src/multiplayer/useRoomSession.ts'), online.filter((script) => script !== 'verify-courier-browser.mjs'))
  assertDeepEqual(affectedBrowser('src/ui/WelcomeScreen.tsx'), ['verify-browser.mjs'])
  includesEvery(affectedBrowser('src/ui/combat-screen/vfx.tsx'), [
    'verify-browser.mjs', 'verify-online-browser.mjs', 'verify-lightning-act2-browser.mjs',
  ], 'combat VFX')
  assertDeepEqual(affectedBrowser('src/ui/PowerRow.tsx'), ['verify-power-hover-browser.mjs'])
  assertDeepEqual(affectedBrowser('src/ui/CourierPanel.tsx'), ['verify-courier-browser.mjs'])
  assertDeepEqual(affectedBrowser('src/ui/chrome/courier.css'), ['verify-courier-browser.mjs'])
  assertDeepEqual(affectedBrowser('src/ui/run-log.ts'), ['verify-run-replay-browser.mjs'])
  for (const file of ['src/ui/App.tsx', 'src/ui/StartMenu.tsx', 'src/ui/sfx.ts']) {
    const owners = affectedBrowser(file)
    assert(owners.includes('verify-run-replay-browser.mjs'), `${file} omitted focused replay coverage`)
    assert(owners.some((owner) => owner !== 'verify-run-replay-browser.mjs'), `${file} lost its shared browser owners`)
  }
  assert(affected('src/ui/icons.ts').includes('verify-noncombat-browser.mjs'))
  assert(affected('src/ui/run-summary-data.ts').includes('verify-noncombat-browser.mjs'))
  assert(affected('src/ui/RewardScreen.tsx').includes('verify-browser.mjs'))
  assert(affected('src/ui/RunSummary.tsx').includes('verify-browser.mjs'))
  includesEvery(affectedBrowser('src/ui/StartMenu.tsx'), [
    'verify-browser.mjs', 'verify-noncombat-browser.mjs', 'verify-online-browser.mjs',
  ], 'start menu')
})
check('an engine submodule selects what its barrel selects', () => {
  // combat.ts is a barrel over src/game/combat/. Nothing outside the engine
  // imports those files directly, so the broad owning browser suites must
  // still run for changes inside them. Specialized fixtures that import the
  // whole barrel are intentionally not treated as owners of every submodule.
  const combatModule = affected('src/game/combat/effects.ts')
  const combatBarrel = affected('src/game/combat.ts')
  assertDeepEqual(combatModule.filter((script) => !script.includes('browser')),
    combatBarrel.filter((script) => !script.includes('browser')))
  includesEvery(combatModule, ['verify-browser.mjs', 'verify-online-browser.mjs'], 'combat submodule')
  const runModule = affected('src/game/run/events.ts')
  const runBarrel = affected('src/game/run.ts')
  assertDeepEqual(runModule.filter((script) => !script.includes('browser')),
    runBarrel.filter((script) => !script.includes('browser')))
  includesEvery(runModule, ['verify-browser.mjs', 'verify-noncombat-browser.mjs', 'verify-online-browser.mjs'], 'run submodule')
  assertEqual(runModule.filter((script) => script.includes('browser')).length, 3,
    'a run submodule selected unrelated focused browser suites')
  const guardianGems = affectedBrowser('src/game/guardian-gems.ts')
  includesEvery(guardianGems, [
    'verify-browser.mjs', 'verify-noncombat-browser.mjs', 'verify-online-browser.mjs',
    'verify-boon-socket-browser.mjs', 'verify-loot-browser.mjs',
  ], 'shared Guardian gem state')
  assertEqual(guardianGems.length, 5, 'Guardian gem state selected unrelated focused browser suites')
  includesEvery(affectedBrowser('src/game/run/merchant.ts'), [
    'verify-browser.mjs', 'verify-noncombat-browser.mjs', 'verify-online-browser.mjs',
    'verify-merchant-overflow-browser.mjs', 'verify-courier-browser.mjs',
  ], 'merchant engine')
  for (const file of ['src/ui/App.tsx', 'src/ui/chrome/stone-keys.css', 'src/game/noncombat.ts', 'src/game/acquisition.ts',
    'src/ui/ItemImage.tsx', 'src/ui/RelicChip.tsx', 'src/game/combat.ts', 'src/ui/chrome/run-header.css', 'src/ui/styles/combat.css',
    'src/ui/styles/painterly-combat-stage.css']) {
    includesEvery(affectedBrowser(file), ['verify-courier-browser.mjs'], `${file} hosts the Courier`)
  }
  const guardianSocketResolution = affectedBrowser('src/game/run/guardian-gems.ts')
  includesEvery(guardianSocketResolution, [
    'verify-browser.mjs', 'verify-noncombat-browser.mjs', 'verify-online-browser.mjs',
    'verify-boon-socket-browser.mjs', 'verify-loot-browser.mjs',
  ], 'Guardian socket resolution')
  assertEqual(guardianSocketResolution.length, 5,
    'Guardian socket resolution selected unrelated focused browser suites')
  // Answering for the barrel must not make an unimported new module look
  // covered: a file no script reaches still runs everything.
  assertDeepEqual(affected('src/game/combat/not-imported-yet.ts'), scripts)
  assertDeepEqual(affected('src/game/run/not-imported-yet.ts'), scripts)
})
check('shared frontend changes use cores plus named visual owners', () => {
  for (const file of ['src/game/assets.ts', 'src/ui/useCampfireScene.ts', 'src/ui/CampfireScreen.tsx',
    'src/ui/OnlineCampfireScreen.tsx']) {
    includesEvery(affectedBrowser(file), ['verify-campfire-assets-browser.mjs'], `${file} campfire artwork`)
  }
  for (const sheet of ['src/ui/chrome.css', 'src/ui/chrome/keys.css']) {
    includesEvery(affectedBrowser(sheet), [
      'verify-browser.mjs', 'verify-noncombat-browser.mjs', 'verify-online-browser.mjs',
      'verify-enemy-layout-browser.mjs', 'verify-hover-overflow-browser.mjs',
    ], sheet)
    assertEqual(affectedBrowser(sheet).length, 15, `${sheet} selected an unrelated browser suite`)
  }
  const hand = affectedBrowser('src/ui/styles/hand.css')
  includesEvery(hand, ['verify-browser.mjs', 'verify-noncombat-browser.mjs', 'verify-online-browser.mjs',
    'verify-card-cancel-browser.mjs', 'verify-combat-hand-viewport-browser.mjs',
    'verify-combat-player-clipping-browser.mjs', 'verify-end-turn-drag-browser.mjs',
    'verify-enemy-layout-browser.mjs'], 'hand stylesheet')
  assertEqual(hand.length, 18, 'hand stylesheet selected an unrelated browser suite')
  includesEvery(affectedBrowser('src/ui/styles/presentation-overlays.css'), [
    'verify-browser.mjs', 'verify-noncombat-browser.mjs', 'verify-online-browser.mjs',
    'verify-lightning-act2-browser.mjs',
  ], 'presentation overlays')
  includesEvery(affectedBrowser('src/ui/styles/title-menu.css'),
    ['verify-run-replay-browser.mjs', 'verify-title-menu-browser.mjs'], 'title menu stylesheet')
  assertDeepEqual(affectedBrowser('src/ui/styles/powers-in-play.css'), ['verify-power-hover-browser.mjs'])
})
check('toolchain changes select their focused owners', () => {
  for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.app.json', 'vite.config.ts']) {
    assertDeepEqual(affected(file), ['verify-build.mjs', 'verify-pipeline.mjs'])
  }
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
  assertDeepEqual(affected('scripts/verify-all.mjs'), ['verify-pipeline.mjs'])
  assertDeepEqual(affected('scripts/verify-deleted.mjs'), scripts)
  assertDeepEqual(affected('scripts/lib/browser-screen-audit.mjs').filter((script) => script.includes('browser')), [
    'verify-browser.mjs', 'verify-hover-overflow-browser.mjs', 'verify-neow-viewport-browser.mjs',
    'verify-noncombat-browser.mjs', 'verify-online-browser.mjs', 'verify-viewport-browser.mjs',
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
// Exercise lane and shard scheduling against disposable verifier fixtures.
// The copy keeps a failed test from leaving fake verify scripts in this repo.
const runRealVerifyAll = (...args) => spawnSync(process.execPath, [resolve(root, 'scripts/verify-all.mjs'), ...args], { encoding: 'utf8', timeout: 30_000 })
const withHeavyLaneFixture = (buildFixtures, run) => {
  // verify-all.mjs resolves its own project root as `dirname(scriptsDir)` and
  // then rejoins 'scripts' onto it (see browserScript() in affected-verifiers.mjs)
  // — it assumes it always lives in a directory literally named "scripts".
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
check('lane filtering and sharding partition browser checks without overlap', () => {
  withHeavyLaneFixture(() => ({
    'verify-a-browser.mjs': "console.log('a')\n".repeat(100),
    'verify-b-browser.mjs': "console.log('b')\n",
    'verify-c-browser.mjs': "console.log('c')\n",
    'verify-d-browser.mjs': "console.log('d')\n",
    'verify-light-one.mjs': "console.log('one')\n",
    'verify-light-two.mjs': "console.log('two')\n",
  }), (runVerifyAll) => {
    const lines = (...args) => runVerifyAll(...args, '--list').stdout.trim().split('\n').filter(Boolean)
    const browser = lines('--lane=browser')
    const shard1 = lines('--lane=browser', '--shard=1/2')
    const shard2 = lines('--lane=browser', '--shard=2/2')
    assertDeepEqual(browser, [
      'verify-a-browser.mjs', 'verify-b-browser.mjs', 'verify-c-browser.mjs', 'verify-d-browser.mjs',
    ])
    assertDeepEqual([...shard1, ...shard2].sort(), browser)
    assert(!shard1.some((script) => shard2.includes(script)), 'browser shards overlap')
    assertDeepEqual(shard1, ['verify-a-browser.mjs'], 'the largest browser suite should own its shard')
    assertDeepEqual(lines('--lane=light'), ['verify-light-one.mjs', 'verify-light-two.mjs'])
    const invalid = runVerifyAll('--lane=browser', '--shard=0/2', '--list')
    assertEqual(invalid.status, 2)
    assert(invalid.stderr.includes('--shard needs INDEX/TOTAL'))
  })
})
check('retry flags are rejected', () => {
  const result = runRealVerifyAll('--heavy-retries=2', '--list')
  assertEqual(result.status, 2)
  assert(result.stderr.includes('fix flaky tests instead'))
})
report('verification pipeline')
