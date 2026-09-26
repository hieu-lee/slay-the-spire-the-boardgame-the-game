import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'

// The two stylesheets are index files of `@import`ed partials, and a partial
// change is a change to the sheet that imports it.
const sharedUi = /^(src\/main\.tsx|src\/ui\/(App|StartMenu)\.tsx|src\/ui\/(chrome|styles)(\/[\w.-]+)*\.css)$/
const noncombatRoots = [
  'CampfireScreen', 'CompendiumScreen', 'MapOverlay', 'MapScreen', 'MetaRunOptions',
  'NeowScreen', 'QuickSetupScreen', 'RelicResolvePanel', 'RewardScreen', 'RoomScreen', 'RunSummary',
  'SettingsDialog', 'StartMenu',
].map((name) => `src/ui/${name}.tsx`)
const localRoots = [
  'App', 'CombatScreen', 'CompendiumScreen', 'EnemyCard', 'MapOverlay', 'MapScreen', 'NeowScreen',
  'RewardScreen', 'StartMenu',
].map((name) => `src/ui/${name}.tsx`)
const onlineUi = /^(src\/multiplayer\/|src\/ui\/Online)/
// Focused browser suites often enter through the public run barrel, which is
// too broad for dependency inference. Keep the few domain owners explicit so
// an engine helper change does not launch the entire visual matrix.
const focusedEngineOwners = new Map([
  ['src/game/assets.ts', ['verify-campfire-assets-browser.mjs']],
  ['src/game/guardian-gems.ts', ['verify-boon-socket-browser.mjs', 'verify-loot-browser.mjs']],
  ['src/game/run/guardian-gems.ts', ['verify-boon-socket-browser.mjs', 'verify-loot-browser.mjs']],
  ['src/game/acquisition.ts', ['verify-courier-browser.mjs']],
  ['src/game/combat.ts', ['verify-courier-browser.mjs', 'verify-combat-layout-reload-browser.mjs']],
  ['src/game/combat/board.ts', ['verify-combat-layout-reload-browser.mjs']],
  ['src/game/combat/create.ts', ['verify-combat-layout-reload-browser.mjs']],
  ['src/game/noncombat.ts', ['verify-courier-browser.mjs']],
  ['src/game/run/merchant.ts', ['verify-merchant-overflow-browser.mjs', 'verify-courier-browser.mjs']],
  ['src/game/run/neow.ts', [
    'verify-blessing-potions-browser.mjs', 'verify-boon-socket-browser.mjs', 'verify-neow-viewport-browser.mjs',
  ]],
  ['src/game/run/quick-setup.ts', [
    'verify-guardian-online-start-choice-browser.mjs', 'verify-guardian-start-choice-browser.mjs',
  ]],
  ['src/game/run/relic-acquisition.ts', ['verify-tiny-house-browser.mjs']],
  ['src/game/run/rewards.ts', ['verify-loot-browser.mjs', 'verify-tiny-house-browser.mjs']],
])
const focusedUiOwners = new Map([
  ['src/ui/App.tsx', ['verify-run-replay-browser.mjs', 'verify-courier-browser.mjs']],
  ['src/ui/CampfireScreen.tsx', ['verify-campfire-assets-browser.mjs']],
  ['src/ui/CompendiumScreen.tsx', ['verify-compendium-browser.mjs']],
  ['src/ui/CombatScreen.tsx', [
    'verify-courier-browser.mjs', 'verify-hermit-combo-browser.mjs', 'verify-hermit-load-reconnect-browser.mjs',
    'verify-hermit-online-staged-trigger-browser.mjs', 'verify-combat-layout-reload-browser.mjs',
    'verify-row-target-browser.mjs', 'verify-turn-targets-browser.mjs',
  ]],
  ['src/ui/ItemImage.tsx', ['verify-courier-browser.mjs']],
  ['src/multiplayer/useRoomSession.ts', ['verify-combat-layout-reload-browser.mjs']],
  ['src/ui/RelicChip.tsx', ['verify-courier-browser.mjs']],
  ['src/ui/OnlineGame.tsx', ['verify-courier-browser.mjs']],
  ['src/ui/OnlineCampfireScreen.tsx', ['verify-campfire-assets-browser.mjs']],
  ['src/ui/StartMenu.tsx', ['verify-run-replay-browser.mjs', 'verify-title-menu-browser.mjs']],
  ['src/ui/sfx.ts', ['verify-run-replay-browser.mjs']],
  ['src/ui/useCampfireScene.ts', ['verify-campfire-assets-browser.mjs']],
  ['src/ui/combat-screen/HermitTriggerChoice.tsx', [
    'verify-hermit-combo-browser.mjs', 'verify-hermit-online-staged-trigger-browser.mjs',
  ]],
  ['src/ui/combat-screen/vfx.tsx', ['verify-lightning-act2-browser.mjs']],
  ['src/ui/styles/compendium.css', ['verify-compendium-browser.mjs']],
  ['src/ui/styles/prompt.css', ['verify-hermit-combo-browser.mjs']],
  ['src/ui/TokenRow.tsx', ['verify-turn-targets-browser.mjs']],
  ['src/ui/styles/enemy-portrait.css', ['verify-turn-targets-browser.mjs', 'verify-end-turn-drag-browser.mjs']],
  ['src/ui/styles/presentation-overlays.css', ['verify-lightning-act2-browser.mjs']],
  ['src/ui/styles/stage-scale.css', ['verify-combat-layout-reload-browser.mjs']],
  ['src/ui/styles/title-menu.css', ['verify-run-replay-browser.mjs', 'verify-title-menu-browser.mjs']],
])
const focusedOnlyUiOwners = new Map([
  ['src/ui/useWebMcp.ts', ['verify-webmcp-browser.mjs']],
  ['src/ui/CourierPanel.tsx', ['verify-courier-browser.mjs']],
  ['src/ui/chrome/courier.css', ['verify-courier-browser.mjs']],
  ['src/ui/PowerRow.tsx', ['verify-power-hover-browser.mjs']],
  ['src/ui/run-log.ts', ['verify-run-replay-browser.mjs']],
  ['src/ui/styles/powers-in-play.css', ['verify-power-hover-browser.mjs']],
])
const sourceExtensions = ['', '.ts', '.tsx', '.mjs', '.js']
const sharedBrowserOwners = ['verify-browser.mjs', 'verify-noncombat-browser.mjs', 'verify-online-browser.mjs']
const onlineBrowserOwners = ['verify-online-browser.mjs', 'verify-hosted-multiplayer-browser.mjs']
const stylesheetBrowserOwners = (file) => file === 'src/ui/styles/hand.css'
  ? ['verify-card-cancel-browser.mjs', 'verify-combat-hand-viewport-browser.mjs',
    'verify-combat-player-clipping-browser.mjs', 'verify-end-turn-drag-browser.mjs']
  : file === 'src/ui/styles/combat.css' || file === 'src/ui/styles/painterly-combat-stage.css'
    ? ['verify-courier-browser.mjs']
  : file === 'src/ui/chrome/stone-keys.css' || file === 'src/ui/chrome/run-header.css'
    ? ['verify-hover-overflow-browser.mjs', 'verify-courier-browser.mjs']
  : file === 'src/ui/chrome.css' || file.startsWith('src/ui/chrome/')
    ? ['verify-hover-overflow-browser.mjs']
    : []
// src/game/combat/*.ts and src/game/run/*.ts are the insides of combat.ts and
// run.ts; everything outside the engine imports them only through those barrels.
const engineModuleOf = (file) => {
  const clean = cleanPath(file)
  if (clean === 'src/game/guardian-gems.ts') return 'src/game/run.ts'
  return clean.replace(/^src\/game\/(combat|run)\/[\w.-]+\.ts$/, 'src/game/$1.ts')
}
const directImportCache = new Map()
const sourceCache = new Map()
const cleanPath = (file) => file.replaceAll('\\', '/')

const importsPlaywright = (source) =>
  /^\s*import\s+(?:['"]playwright['"]|(?:(?:[\w$]+\s*,\s*)?(?:\{[\w$,\s]*}|\*\s+as\s+[\w$]+)|[\w$]+)\s+from\s*['"]playwright['"])/m.test(source)
  || /^\s*export\s+(?:\*|\{[\w$,\s]*})\s+from\s*['"]playwright['"]/m.test(source)
  || /^\s*(?:(?:const|let|var)\b[^\n]*=\s*)?(?:await\s*)?(?:import|require)\s*\(\s*['"]playwright['"]/m.test(source)

export function drivesABrowser(script, source, dependencies = []) {
  return script.includes('browser') || [source, ...dependencies].some(importsPlaywright)
}

export function changedPaths(status) {
  const fields = status.split('\0')
  const files = []
  for (let index = 0; fields[index];) {
    const kind = fields[index++]
    files.push(fields[index++])
    if (kind.startsWith('R') || kind.startsWith('C')) files.push(fields[index++])
  }
  return files
}

export function requiresFullSuite(status) {
  for (let index = 0, fields = status.split('\0'); fields[index];) {
    const kind = fields[index++]
    index += kind.startsWith('R') || kind.startsWith('C') ? 2 : 1
    if (!/^(A|M|C\d+|R\d+)$/.test(kind)) return true
  }
  return false
}

export const needsTypecheck = (files) => files.some((file) => /^(src\/|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|tsconfig)/.test(cleanPath(file)))

export function mergeBase(root, base) {
  const result = spawnSync('git', ['merge-base', base, 'HEAD'], { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr.trim() || `cannot find merge base for ${base}`)
  return result.stdout.trim()
}

function sourceOf(file) {
  if (!sourceCache.has(file)) sourceCache.set(file, readFileSync(file, 'utf8'))
  return sourceCache.get(file)
}

function directImports(file, root) {
  const absolute = resolve(root, file)
  if (!existsSync(absolute)) return []
  if (!directImportCache.has(absolute)) {
    const source = sourceOf(absolute)
    const pattern = /\bfrom\s*['"]((?:\.\.?\/|\/src\/)[^'"]+)['"]|\bimport\s*(?:\(\s*)?['"]((?:\.\.?\/|\/src\/)[^'"]+)['"]\s*\)?|@import\s+(?:url\(\s*)?['"]((?:\.\.?\/|\/src\/)[^'"]+)['"]/g
    const dependencies = []
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1] ?? match[2] ?? match[3]
      const target = specifier.startsWith('/') ? resolve(root, `.${specifier}`) : resolve(dirname(absolute), specifier)
      const dependency = sourceExtensions.map((extension) => `${target}${extension}`).find(existsSync)
      if (dependency) dependencies.push(dependency)
    }
    directImportCache.set(absolute, dependencies)
  }
  return directImportCache.get(absolute)
}

function imports(file, root, seen = new Set()) {
  const absolute = resolve(root, file)
  if (seen.has(absolute) || !existsSync(absolute)) return seen
  seen.add(absolute)
  for (const dependency of directImports(file, root)) imports(relative(root, dependency), root, seen)
  return seen
}

export function browserScript(script, root) {
  const file = resolve(root, 'scripts', script)
  const dependencies = [...imports(join('scripts', script), root)].filter((dependency) => dependency !== file)
  return drivesABrowser(script, sourceOf(file), dependencies.map(sourceOf))
}

export function affectedVerifiers(root, changedFiles, scripts) {
  const changed = new Set(changedFiles.map(cleanPath))
  const selected = new Set()
  const browser = scripts.filter((script) => browserScript(script, root))
  // Broad suites own engine flows. Focused suites often load the application
  // dynamically, so UI and asset changes must select them explicitly below.
  const coreBrowser = browser.filter((script) => [
    'verify-browser.mjs', 'verify-noncombat-browser.mjs', 'verify-online-browser.mjs',
  ].includes(script))
  const browserMentioning = (files) => browser.filter((script) =>
    [...imports(join('scripts', script), root)].some((dependency) => {
      const source = sourceOf(dependency)
      return files.some((file) => source.includes(`/${cleanPath(file)}`))
    }))
  const stylesheetRootsFor = (file) => ['src/ui/styles.css', 'src/ui/chrome.css'].filter((entry) =>
    imports(entry, root).has(resolve(root, file)))
  const uiOwners = (file) => {
    const absolute = resolve(root, file)
    const owners = []
    if (localRoots.some((entry) => imports(entry, root).has(absolute))) owners.push('verify-browser.mjs')
    if (noncombatRoots.some((entry) => imports(entry, root).has(absolute))) owners.push('verify-noncombat-browser.mjs')
    if (imports('src/ui/OnlineGame.tsx', root).has(absolute)) owners.push('verify-online-browser.mjs')
    return owners
  }
  const externalReferences = [...changed].filter((file) => !file.startsWith('src/')).flatMap((file) => {
    const directory = file.split('/').slice(0, -1).join('/')
    return [file, basename(file), ...(directory.includes('/') ? [directory] : [])]
  })

  for (const script of scripts) {
    const dependencies = imports(join('scripts', script), root)
    const source = sourceOf(resolve(root, 'scripts', script))
    const mentions = externalReferences.some((reference) => source.includes(reference))
    const directBrowserDependency = browser.includes(script)
      && directImports(join('scripts', script), root).some((file) => {
        const changedFile = cleanPath(relative(root, file))
        return changed.has(changedFile) && !focusedOnlyUiOwners.has(changedFile)
      })
    if ((!browser.includes(script) && [...dependencies].some((file) => changed.has(cleanPath(relative(root, file)))))
      || directBrowserDependency || mentions) {
      selected.add(script)
    }
  }

  for (const file of changed) {
    let covered = [...selected].some((script) => imports(join('scripts', script), root).has(resolve(root, file)))
    if (file === 'scripts/verify-all.mjs') {
      // Scheduler behavior is exercised with disposable light/browser fixtures
      // by verify-pipeline. Running every product suite for a scheduler-only
      // change both adds no coverage and can turn a CI orchestration repair
      // into an hour-long visual-regression run.
      selected.add('verify-pipeline.mjs')
      covered = true
    }
    else if (file.startsWith('scripts/verify-') && file.endsWith('.mjs')) {
      const script = file.slice('scripts/'.length)
      if (scripts.includes(script)) selected.add(script)
      else for (const candidate of scripts) selected.add(candidate)
    }
    if (file.startsWith('scripts/verify-') && file.endsWith('.mjs')) covered = true
    if (file.startsWith('scripts/')) {
      let browserCovered = false
      for (const script of browser) {
        if (imports(join('scripts', script), root).has(resolve(root, file))) {
          selected.add(script)
          browserCovered = true
        }
      }
      covered ||= browserCovered
    }
    if (file.startsWith('public/assets/')) {
      selected.add('verify-assets.mjs')
      const owners = file.startsWith('public/assets/noncombat/')
        ? ['verify-noncombat-browser.mjs', 'verify-online-browser.mjs']
        : /public\/assets\/(combat|enemies)\//.test(file)
          ? ['verify-browser.mjs', 'verify-online-browser.mjs']
          : sharedBrowserOwners
      for (const script of owners) selected.add(script)
      for (const script of browserMentioning([file])) selected.add(script)
      covered = true
    }
    if (file.startsWith('data/')) {
      selected.add('verify-architecture.mjs')
      selected.add('verify-assets.mjs')
      covered = true
    }
    if (file === 'index.html') {
      selected.add('verify-assets.mjs')
      for (const script of browser) selected.add(script)
      covered = true
    }
    // Keep one representative browser flow per surface. Focused verifiers are
    // added only when they name the changed source (or a stylesheet importing
    // it), rather than making every UI edit run the whole visual matrix.
    for (const script of focusedUiOwners.get(file) ?? []) selected.add(script)
    const focusedOwners = focusedOnlyUiOwners.get(file)
    if (focusedOwners) {
      for (const script of focusedOwners) selected.add(script)
      covered = true
    }
    else if (sharedUi.test(file)) {
      for (const script of sharedBrowserOwners) selected.add(script)
      for (const script of stylesheetBrowserOwners(file)) selected.add(script)
      for (const script of focusedUiOwners.get(file) ?? []) selected.add(script)
      for (const script of browserMentioning([file, ...stylesheetRootsFor(file)])) selected.add(script)
      covered = true
    }
    else if (onlineUi.test(file)) {
      for (const script of onlineBrowserOwners) selected.add(script)
      covered = true
    }
    else if (file.startsWith('src/ui/')) {
      const owners = [...uiOwners(file), ...(focusedUiOwners.get(file) ?? []),
        ...browserMentioning([file, ...stylesheetRootsFor(file)])]
      for (const script of owners) selected.add(script)
      if (owners.length === 0) selected.add('verify-browser.mjs')
      covered = true
    }
    else if (file === 'src/game/run.ts') {
      for (const script of coreBrowser) selected.add(script)
      covered = true
    }
    else if (file.startsWith('src/')) {
      // A screen imports the engine through its barrel, so a change inside
      // src/game/combat/ reaches the UI exactly as a change to the barrel
      // itself does. Ask the direct-import checks about the barrel.
      const barrel = engineModuleOf(file)
      const absolute = resolve(root, barrel)
      const owners = []
      if (localRoots.some((entry) => directImports(entry, root).includes(absolute))) owners.push('verify-browser.mjs')
      if (noncombatRoots.some((entry) => directImports(entry, root).includes(absolute))) owners.push('verify-noncombat-browser.mjs')
      if (directImports('src/ui/OnlineGame.tsx', root).includes(absolute)) owners.push('verify-online-browser.mjs')
      owners.push(...(focusedEngineOwners.get(cleanPath(file)) ?? []))
      if (owners.length) {
        for (const script of owners) selected.add(script)
        // Answering for the barrel must not also answer for the file: a module
        // nothing imports yet is still uncovered, and has to keep the
        // run-everything fallback below. A module that IS imported already had
        // `covered` set by the transitive scan.
        if (barrel === file) covered = true
      }
    }

    if (/^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig)/.test(file)) {
      selected.add('verify-build.mjs')
      covered = true
    }
    if (/^vite\.config/.test(file)) {
      selected.add('verify-build.mjs')
      covered = true
    }
    if ((file.startsWith('src/') || file.startsWith('scripts/')) && !covered && extname(file)) {
      for (const script of scripts) selected.add(script)
    }
    if (file.startsWith('src/')) selected.add('verify-architecture.mjs')
  }

  return scripts.filter((script) => selected.has(script))
}
