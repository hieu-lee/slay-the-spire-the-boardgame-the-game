import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import {
  ART_BAKES, affectedVerifiers, artBakeInput, browserScript, changedPaths, gateArtBakes, drivesABrowser, mergeBase, needsTypecheck, ownerMap, requiresFullSuite,
} from './lib/affected-verifiers.mjs'
import { suite, check, assert, assertDeepEqual, assertEqual, assertThrows, report } from './lib/harness.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scripts = readdirSync(resolve(root, 'scripts'))
  .filter((file) => file.startsWith('verify-') && file.endsWith('.mjs') && file !== 'verify-all.mjs')
  .sort()
const affected = (...files) => affectedVerifiers(root, files, scripts)
/** The run-everything fallback: every check except the slow art bakes, which only their own inputs select. */
const everyRoutineCheck = scripts.filter((script) => script !== ART_BAKES)
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
  for (const file of ['src/game/combat.ts', 'src/game/combat/board.ts', 'src/game/combat/create.ts']) {
    assert(affectedBrowser(file).includes('verify-combat-layout-reload-browser.mjs'), `${file} omitted combat reload coverage`)
  }
})
check('frontend surfaces select their cores and named focused browser checks', () => {
  const combat = affectedBrowser('src/ui/CombatScreen.tsx')
  includesEvery(combat, ['verify-browser.mjs', 'verify-online-browser.mjs',
    'verify-act-four-facing-browser.mjs', 'verify-combat-video-browser.mjs', 'verify-slime-hover-browser.mjs',
    'verify-safari-combat-animation-browser.mjs', 'verify-courier-browser.mjs',
    'verify-hermit-combo-browser.mjs', 'verify-hermit-load-reconnect-browser.mjs',
    'verify-hermit-online-staged-trigger-browser.mjs', 'verify-combat-layout-reload-browser.mjs',
    'verify-combat-stage-scan-browser.mjs',
    'verify-enemy-attack-once-browser.mjs', 'verify-row-target-browser.mjs',
    'verify-turn-targets-browser.mjs', 'verify-wing-and-throw-browser.mjs', 'verify-elite-signatures-browser.mjs',
    'verify-die-relic-browser.mjs', 'verify-hero-potions-browser.mjs',
    'verify-end-turn-drag-browser.mjs', 'verify-card-damage-preview-browser.mjs',
    'verify-skin-browser.mjs', 'verify-monogatari-animation-browser.mjs',
    'verify-monogatari-skins-browser.mjs', 'verify-monogatari-online-browser.mjs', 'verify-defect-chan-evoke-browser.mjs',
    'verify-start-turn-party-browser.mjs', 'verify-start-turn-resync-browser.mjs',
    'verify-run-replay-browser.mjs', 'verify-unload-shivs-browser.mjs',
    'verify-boss-heavy-attacks-browser.mjs', 'verify-double-tap-recover-browser.mjs'], 'combat screen')
  assert(!combat.includes('verify-noncombat-browser.mjs'))
  assertEqual(combat.length, 42, 'combat screen selected an unrelated browser suite')
  includesEvery(affectedBrowser('src/ui/TokenRow.tsx'), ['verify-turn-targets-browser.mjs',
    'verify-row-target-browser.mjs', 'verify-combat-target-geometry-browser.mjs'], 'Orb row')
  assert(affectedBrowser('src/ui/styles/stage-scale.css').includes('verify-combat-layout-reload-browser.mjs'))
  includesEvery(affectedBrowser('src/ui/combat-screen/HermitTriggerChoice.tsx'), [
    'verify-hermit-combo-browser.mjs', 'verify-hermit-online-staged-trigger-browser.mjs', 'verify-online-browser.mjs',
  ], 'Hermit trigger choice')
  const room = affectedBrowser('src/ui/RoomScreen.tsx')
  includesEvery(room, ['verify-browser.mjs', 'verify-noncombat-browser.mjs', 'verify-online-browser.mjs'], 'room screen')
  const online = affectedBrowser('src/ui/OnlineGame.tsx')
  includesEvery(online, ['verify-online-browser.mjs', 'verify-hosted-multiplayer-browser.mjs', 'verify-courier-browser.mjs',
    'verify-skin-browser.mjs', 'verify-skin-cards-browser.mjs', 'verify-monogatari-online-browser.mjs', 'verify-start-turn-resync-browser.mjs'], 'online screen')
  assert(!online.includes('verify-browser.mjs'))
  assert(!online.includes('verify-noncombat-browser.mjs'))
  assert(online.includes('verify-multiplayer-resume-browser.mjs'))
  assertEqual(online.length, 8, 'online screen selected an unrelated browser suite')
  assertDeepEqual(affectedBrowser('src\\ui\\OnlineGame.tsx'), online)
  assertDeepEqual(affectedBrowser('src/multiplayer/useRoomSession.ts'),
    [...online.filter((script) => script !== 'verify-courier-browser.mjs'), 'verify-ascension-sync-browser.mjs', 'verify-combat-layout-reload-browser.mjs'].sort())
  assertDeepEqual(affectedBrowser('src/ui/WelcomeScreen.tsx'), ['verify-browser.mjs'])
  includesEvery(affectedBrowser('src/ui/combat-screen/vfx.tsx'), [
    'verify-browser.mjs', 'verify-online-browser.mjs', 'verify-lightning-act2-browser.mjs',
  ], 'combat VFX')
  assertDeepEqual(affectedBrowser('src/ui/PowerRow.tsx'), ['verify-power-hover-browser.mjs'])
  assertDeepEqual(affectedBrowser('src/ui/CourierPanel.tsx'), ['verify-courier-browser.mjs'])
  assertDeepEqual(affectedBrowser('src/ui/chrome/courier.css'), ['verify-courier-browser.mjs'])
  assertDeepEqual(affectedBrowser('src/ui/run-log.ts'), ['verify-replay-controls-browser.mjs', 'verify-run-replay-browser.mjs'])
  assertDeepEqual(affected('scripts/mail-admin.mjs'), ['verify-mail.mjs', 'verify-pipeline.mjs'])
  for (const file of ['src/ui/ReplayBar.tsx', 'src/ui/run-replay.ts', 'src/ui/styles/replay-bar.css']) {
    assertDeepEqual(affectedBrowser(file), ['verify-replay-controls-browser.mjs'])
  }
  for (const file of ['src/ui/App.tsx', 'src/ui/StartMenu.tsx', 'src/ui/sfx.ts']) {
    const owners = affectedBrowser(file)
    assert(owners.includes('verify-run-replay-browser.mjs'), `${file} omitted focused replay coverage`)
    assert(owners.some((owner) => owner !== 'verify-run-replay-browser.mjs'), `${file} lost its shared browser owners`)
  }
  assert(affectedBrowser('src/ui/App.tsx').includes('verify-combat-vfx-preload-browser.mjs'),
    'app changes omitted first-visit and returning-player VFX coverage')
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
  assertDeepEqual(affected('src/game/combat/not-imported-yet.ts'), everyRoutineCheck)
  assertDeepEqual(affected('src/game/run/not-imported-yet.ts'), everyRoutineCheck)
})
check('skin attack and art tooling selects the skin verifiers rather than the whole suite', () => {
  const owned = (file, owners) => {
    const selected = affected(file)
    includesEvery(selected, owners, file)
    assert(selected.length <= owners.length + 4, `${file} fell back to ${selected.length} verifiers`)
  }
  for (const file of ['src/ui/combat-vfx.ts', 'src/ui/combat-sfx.ts']) includesEvery(affected(file), ['verify-skin-attack-browser.mjs', 'verify-skin-browser.mjs'], file)
  for (const file of ['scripts/animation/audit-poses.py', 'scripts/animation/monogatari.py', 'scripts/animation/monogatari_silent.py',
    'scripts/animation/monogatari_watcher.py', 'scripts/animation/measure-monogatari_watcher.py']) owned(file, [ART_BAKES, 'verify-skin-attack-browser.mjs'])
  // The generator, its shared geometry and the skin configs own the attack verifiers; the generated stylesheet reruns only the
  // attack verifiers and the skin registry the skin-registration proofs.
  for (const file of ['scripts/animation/skin-attack.py', 'scripts/animation/skin_geometry.py', 'scripts/animation/skins/monogatari_silent.json',
    'scripts/animation/test-skins/test_combo.json']) owned(file, [ART_BAKES, 'verify-skin-attack-browser.mjs'])
  includesEvery(affected('scripts/animation/skins/monogatari_silent.json'), ['verify-assets.mjs'], 'verify-assets reads the skin configs')
  includesEvery(affected('src/ui/styles/staged-attacks.css'), [ART_BAKES, 'verify-skin-attack-browser.mjs'], 'the generated attack stylesheet')
  includesEvery(affected('src/game/skins.ts'), ['verify-test-skins-browser.mjs'], 'src/game/skins.ts registers the test skins')
  for (const file of ['scripts/art/export-monogatari_silent-char.py', 'scripts/art/export-monogatari_watcher-char.py', 'scripts/art/cutout-monogatari_watcher-idle.py']) {
    owned(file, ['verify-assets.mjs', 'verify-skin-browser.mjs'])
  }
  for (const file of ['scripts/art/export-monogatari-noncombat.py', 'scripts/art/export-monogatari_silent-noncombat.py']) {
    owned(file, ['verify-assets.mjs', 'verify-merchant-overflow-browser.mjs', 'verify-treasure-animation-browser.mjs'])
  }
  for (const file of ['scripts/art/campfire-sitters.py', 'scripts/art/sources/campfire-sitters/manifest.json']) {
    owned(file, ['verify-assets.mjs', 'verify-art-scenes-browser.mjs'])
  }
})

check('shared frontend changes use cores plus named visual owners', () => {
  for (const file of ['src/game/assets.ts', 'src/ui/CampfireScene.tsx', 'src/ui/CampfireScreen.tsx', 'src/ui/OnlineCampfireScreen.tsx',
    'src/ui/chrome/campfire.css', 'public/assets/noncombat/campfire/sitters/kratos.webp']) {
    includesEvery(affectedBrowser(file), ['verify-art-scenes-browser.mjs'], `${file} campfire scene`)
  }
  for (const sheet of ['src/ui/chrome.css', 'src/ui/chrome/keys.css']) {
    includesEvery(affectedBrowser(sheet), [
      'verify-browser.mjs', 'verify-noncombat-browser.mjs', 'verify-online-browser.mjs',
      'verify-enemy-layout-browser.mjs', 'verify-hover-overflow-browser.mjs', 'verify-enemy-attack-once-browser.mjs',
      'verify-combat-stage-scan-browser.mjs', 'verify-wing-and-throw-browser.mjs', 'verify-elite-signatures-browser.mjs',
      'verify-unload-shivs-browser.mjs', 'verify-boss-heavy-attacks-browser.mjs', 'verify-slime-hover-browser.mjs',
    ], sheet)
    assertEqual(affectedBrowser(sheet).length, 27, `${sheet} selected an unrelated browser suite`)
  }
  const hand = affectedBrowser('src/ui/styles/hand.css')
  includesEvery(hand, ['verify-browser.mjs', 'verify-noncombat-browser.mjs', 'verify-online-browser.mjs',
    'verify-card-cancel-browser.mjs', 'verify-combat-hand-viewport-browser.mjs',
    'verify-combat-player-clipping-browser.mjs', 'verify-end-turn-drag-browser.mjs',
    'verify-enemy-layout-browser.mjs', 'verify-enemy-attack-once-browser.mjs',
    'verify-combat-stage-scan-browser.mjs',
    'verify-row-target-browser.mjs', 'verify-wing-and-throw-browser.mjs', 'verify-elite-signatures-browser.mjs',
    'verify-card-damage-preview-browser.mjs', 'verify-unload-shivs-browser.mjs',
    'verify-boss-heavy-attacks-browser.mjs', 'verify-slime-hover-browser.mjs'], 'hand stylesheet')
  assertEqual(hand.length, 31, 'hand stylesheet selected an unrelated browser suite')
  includesEvery(affectedBrowser('src/ui/styles/presentation-overlays.css'), [
    'verify-browser.mjs', 'verify-noncombat-browser.mjs', 'verify-online-browser.mjs',
    'verify-lightning-act2-browser.mjs',
  ], 'presentation overlays')
  includesEvery(affectedBrowser('src/ui/styles/title-menu.css'),
    ['verify-run-replay-browser.mjs', 'verify-title-menu-browser.mjs'], 'title menu stylesheet')
  assertDeepEqual(affectedBrowser('src/ui/styles/powers-in-play.css'), ['verify-power-hover-browser.mjs'])
})
check('toolchain changes select their focused owners', () => {
  includesEvery(affected('.github/workflows/ci.yml'), ['verify-assets.mjs', 'verify-pipeline.mjs'], 'CI toolchain owners')
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
  assertThrows(() => ownerMap([['src/ui/Card.tsx', ['a.mjs']], ['src/ui/Card.tsx', ['b.mjs']]]), 'Duplicate verifier owner')
  includesEvery(affected('src/ui/Card.tsx'), [
    'verify-card-rendering-browser.mjs', 'verify-skin-cards-browser.mjs', 'verify-card-damage-preview-browser.mjs',
  ], 'Card.tsx owners')
  assertDeepEqual(affected('scripts/lib/affected-verifiers.mjs'), ['verify-pipeline.mjs'])
  assertDeepEqual(affected('scripts/verify-all.mjs'), ['verify-pipeline.mjs'])
  assertDeepEqual(affected('scripts/verify-deleted.mjs'), everyRoutineCheck)
  assertDeepEqual(affected('scripts/lib/browser-screen-audit.mjs').filter((script) => script.includes('browser')), [
    'verify-browser.mjs', 'verify-hover-overflow-browser.mjs', 'verify-neow-viewport-browser.mjs',
    'verify-noncombat-browser.mjs', 'verify-online-browser.mjs', 'verify-viewport-browser.mjs',
  ])
  assertDeepEqual(affected('src/game/new-system.ts'), everyRoutineCheck)
  assertDeepEqual(affected('src/ui/CombatScreen.tsx', 'src/game/new-system.ts'), everyRoutineCheck)
})
check('every Rimuru Tempest file family selects its focused art owners, never the whole suite', () => {
  const skin = 'anime_slime_boss'
  const families = [
    [`scripts/animation/${skin}.py`, [ART_BAKES, 'verify-skin-attack-browser.mjs']],
    [`scripts/animation/measure-${skin}.py`, [ART_BAKES, 'verify-skin-attack-browser.mjs']],
    [`scripts/animation/skins/${skin}.json`, [ART_BAKES, 'verify-assets.mjs', 'verify-skin-attack-browser.mjs']],
    [`scripts/animation/sources/${skin}/attack/gather.webp`, [ART_BAKES, 'verify-skin-attack-browser.mjs']],
    [`scripts/animation/sources/${skin}/registration.json`, [ART_BAKES, 'verify-skin-attack-browser.mjs']],
    [`scripts/art/export-${skin}-char.py`, ['verify-assets.mjs', 'verify-skin-browser.mjs']],
    [`scripts/art/export-${skin}-noncombat.py`, ['verify-assets.mjs', 'verify-merchant-overflow-browser.mjs', 'verify-treasure-animation-browser.mjs']],
    [`scripts/art/sources/${skin}-char/idle-identity.webp`, [ART_BAKES, 'verify-assets.mjs']],
    [`scripts/art/sources/${skin}-noncombat/merchant.webp`, ['verify-assets.mjs', 'verify-merchant-overflow-browser.mjs', 'verify-treasure-animation-browser.mjs']],
    [`scripts/art/sources/${skin}-skin-cards/strike.webp`, [ART_BAKES, 'verify-assets.mjs', 'verify-skin-cards-browser.mjs']],
    [`scripts/art/sources/campfire-sitters/${skin}.webp`, [ART_BAKES, 'verify-assets.mjs', 'verify-art-scenes-browser.mjs']],
    [`docs/skins/${skin}-art/README.md`, [ART_BAKES]],
    [`docs/skins/${skin}-art/attack-manifest.json`, [ART_BAKES]],
    [`docs/skins/${skin}-art/manifest.json`, ['verify-assets.mjs']],
    [`docs/skins/${skin}-card-art/manifest.json`, [ART_BAKES]],
  ]
  for (const [file, owners] of families) {
    const selected = affected(file)
    includesEvery(selected, owners, file)
    assert(selected.length < 15, `${file} fell back to ${selected.length} verifiers`)
  }
  for (const file of [`docs/skins/${skin}-art/manifest.json`, `docs/skins/${skin}-art/prompts/idle.txt`, `docs/skins/${skin}-noncombat/README.md`]) {
    assert(!affected(file).includes(ART_BAKES), `${file} must not select ${ART_BAKES}`)
  }
})
check('only an art pipeline input selects the slow art bakes', () => {
  for (const file of ['scripts/animation/kratos.py', 'public/assets/combat/rigged/hero-defect-idle.webp', 'public/assets/sfx/ui.ogg',
    'docs/skins/kratos-card-art/manifest.json', 'docs/skins/monogatari_watcher-art/README.md', 'docs/skins/kratos-art.json',
    'docs/skins/anime_slime_boss-art/README.md', 'docs/skins/anime_slime_boss-art/attack-manifest.json', 'docs/skins/monogatari_watcher-art/attack-manifest.json',
    'docs/skins/anime_slime_boss-art/prompts/attack-punch.txt',
    'docs/monogatari-skins/prompts/combat/ironclad-ready.txt', 'docs/skins/kratos-card-art/prompts/slayer_bash.txt',
    'src/ui/combat-webm-sources.json', 'src/ui/hero-art-head.json', 'public/assets/noncombat/campfire/camp.webp', 'scripts/art/campfire-sitters.py',
    'scripts/art/sources/campfire-sitters/manifest.json', 'scripts/art/sources/kratos-skin-cards/slayer_bash.webp',
    'scripts/art/skin-cards/masks/attack.png',
    'scripts/verify-art-bakes.mjs']) {
    assert(affected(file).includes(ART_BAKES), `${file} selects ${ART_BAKES}`)
  }
  for (const file of ['src/game/enemies.ts', 'src/game/skins.ts', 'src/game/new-system.ts', 'public/assets/noncombat/merchant/test.webp',
    'public/assets/skin-cards/kratos/x.webp', 'index.html', 'docs/skins/attack-animation.md', 'scripts/calibrate-enemy-size.py', 'docs/skins/kratos-noncombat/README.md',
    'docs/monogatari-skins/validation.md', 'docs/skins/kratos-noncombat/prompts/merchant.txt',
    'docs/skins/kratos-card-art/README.md',
    'scripts/art/export-kratos-menu.py', 'scripts/art/sources/kratos-noncombat/merchant.webp', 'scripts/audio/generate-combat-sfx.py',
    'public/assets/noncombat/merchant/characters/ironclad-standing.webp', 'docs/monogatari-skins/prompts/noncombat/defect-merchant.txt',
    'scripts/animation/sources/menu-icons/stats.txt', 'scripts/animation/README.md', 'docs/monogatari-skins/cards/README.md',
    'scripts/lib/test-skins.mjs', 'docs/skins/monogatari_silent-art/prompts/select-portrait.txt',
    'public/assets/card-art/ironclad/bash.webp', 'public/assets/combat/energy-orbs/kratos.webp', 'public/assets/combat/slimes/spike.webp',
    'docs/skins/monogatari_watcher-art/manifest.json', 'docs/skins/anime_slime_boss-art/manifest.json', 'docs/monogatari-skins/cards/defect-coverage.json',
    'scripts/verify-assets.mjs',
    'scripts/verify-deleted.mjs']) {
    assert(!affected(file).includes(ART_BAKES), `${file} must not select ${ART_BAKES}`)
  }
  for (const file of [
    'docs/skins/kratos-menu-art/prompts/portrait.txt', 'docs/skins/monogatari_silent-art/manifest.json',
    'docs/monogatari-skins/noncombat-manifest.json', 'scripts/animation/sources/kratos/idle.webp',
    'scripts/animation/sources/monogatari/ironclad-idle.webp', 'scripts/art/sources/monogatari_silent-char/identity.webp',
    'scripts/art/sources/monogatari/noncombat/defect-merchant.png',
  ]) assert(affected(file).includes('verify-assets.mjs'), `${file} selects verify-assets`)
  // verify-all's full-suite path (a deletion) applies the same gate.
  assertDeepEqual(gateArtBakes(scripts, ['src/game/deleted.ts']), everyRoutineCheck)
  assertDeepEqual(gateArtBakes(scripts, ['src/game/deleted.ts', 'public/assets/sfx/ui.ogg']), scripts)
})
check('every file the art bakes hash selects them', () => {
  // The same records verify-art-bakes.mjs hashes; a new provenance folder must extend artBakeInput or this fails.
  const read = (path) => JSON.parse(readFileSync(resolve(root, path), 'utf8'))
  const hashed = Object.keys(read('scripts/animation/safari-video-sources.json'))
    .flatMap((source) => [source, source.replace(/\.webp$/, '.mov')])
  hashed.push('src/ui/combat-webm-sources.json')
  for (const name of Object.keys(read('src/ui/combat-webm-sources.json'))) hashed.push(
    `public/assets/combat/rigged/${name}.webp`, `public/assets/combat/rigged-webm/${name}.webm`,
    `public/assets/combat/rigged-posters/${name}.webp`)
  const kratos = read('docs/skins/kratos-art.json')
  for (const entry of kratos.generated) hashed.push(entry.source, entry.prompt, ...entry.inputs.map((input) => input.path))
  for (const entry of kratos.runtime) hashed.push(entry.path)
  for (const entry of [...read('docs/skins/monogatari_silent-art/manifest.json').attack.generated,
    ...read('docs/skins/monogatari_watcher-art/attack-manifest.json').generated,
    ...read('docs/skins/anime_slime_boss-art/attack-manifest.json').generated]) {
    hashed.push(...[entry.source, entry.prompt, entry.output, ...entry.inputs].filter((record) => record.path).map((record) => record.path))
  }
  for (const skin of readdirSync(resolve(root, 'docs/skins')).filter((dir) => dir.endsWith('-card-art'))) {
    const manifest = read(`docs/skins/${skin}/manifest.json`)
    for (const record of [manifest.catalogue, manifest.registration, ...(manifest.masks ?? [])].filter(Boolean)) hashed.push(record.path)
    for (const card of manifest.cards) {
      hashed.push(...[card.source, card.prompt, card.output, ...(card.regeneration?.inputs ?? [])].filter((record) => record.path)
        .map((record) => record.path))
    }
  }
  assert(hashed.length > 1000, `only ${hashed.length} hashed paths found`)
  // affectedVerifiers ends in gateArtBakes, so artBakeInput alone decides; calling affected() per path would take minutes.
  assertDeepEqual(hashed.filter((path) => !artBakeInput(path)), [], 'hashed paths that do not select the art bakes')
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
check('dependency caches keep separate repository roots isolated', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'sts-routing-roots-'))
  try {
    for (const [name, dependencies] of [['first', ['a', 'b']], ['second', ['b', 'a']]]) {
      const repo = resolve(directory, name)
      mkdirSync(resolve(repo, 'scripts'), { recursive: true })
      mkdirSync(resolve(repo, 'src'))
      for (const id of ['a', 'b']) writeFileSync(resolve(repo, `src/${id}.mjs`), 'export const value = 1')
      for (const [index, dependency] of dependencies.entries()) {
        writeFileSync(resolve(repo, `scripts/verify-${index}.mjs`), `import '../src/${dependency}.mjs'`)
      }
      assertDeepEqual(affectedVerifiers(repo, ['src/a.mjs'], ['verify-0.mjs', 'verify-1.mjs']),
        [name === 'first' ? 'verify-0.mjs' : 'verify-1.mjs'])
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
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
  const git = (...args) => spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' })
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
