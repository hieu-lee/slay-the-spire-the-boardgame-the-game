import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'

// The two stylesheets are index files of `@import`ed partials, and a partial
// change is a change to the sheet that imports it.
const sharedUi = /^(src\/main\.tsx|src\/ui\/(App|StartMenu)\.tsx|src\/ui\/(chrome|styles)(\/[\w.-]+)*\.css)$/
const noncombatRoots = [
  'AchievementsScreen', 'CampfireScreen', 'CompendiumScreen', 'MapOverlay', 'MapScreen', 'MetaRunOptions',
  'NeowScreen', 'QuickSetupScreen', 'RelicResolvePanel', 'RewardScreen', 'RoomScreen', 'RunSummary',
  'SettingsDialog', 'StartMenu',
].map((name) => `src/ui/${name}.tsx`)
const localRoots = [
  'App', 'CombatScreen', 'CompendiumScreen', 'EnemyCard', 'MapOverlay', 'MapScreen', 'NeowScreen',
  'RewardScreen', 'StartMenu',
].map((name) => `src/ui/${name}.tsx`)
const onlineUi = /^(src\/multiplayer\/|src\/ui\/Online)/
const sourceExtensions = ['', '.ts', '.tsx', '.mjs', '.js']
// src/game/combat/*.ts and src/game/run/*.ts are the insides of combat.ts and
// run.ts; everything outside the engine imports them only through those barrels.
const engineModuleOf = (file) => cleanPath(file).replace(/^src\/game\/(combat|run)\/[\w.-]+\.ts$/, 'src/game/$1.ts')
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
    const pattern = /\bfrom\s*['"]((?:\.\.?\/|\/src\/)[^'"]+)['"]|\bimport\s*(?:\(\s*)?['"]((?:\.\.?\/|\/src\/)[^'"]+)['"]\s*\)?/g
    const dependencies = []
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1] ?? match[2]
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
  const extraBrowser = browser.filter((script) => ![
    'verify-browser.mjs', 'verify-noncombat-browser.mjs', 'verify-online-browser.mjs',
  ].includes(script))
  const externalReferences = [...changed].filter((file) => !file.startsWith('src/')).flatMap((file) => {
    const directory = file.split('/').slice(0, -1).join('/')
    return [file, basename(file), ...(directory.includes('/') ? [directory] : [])]
  })

  for (const script of scripts) {
    const dependencies = imports(join('scripts', script), root)
    const source = sourceOf(resolve(root, 'scripts', script))
    const mentions = externalReferences.some((reference) => source.includes(reference))
    const directBrowserDependency = browser.includes(script)
      && directImports(join('scripts', script), root).some((file) => changed.has(cleanPath(relative(root, file))))
    if ((!browser.includes(script) && [...dependencies].some((file) => changed.has(cleanPath(relative(root, file)))))
      || directBrowserDependency || mentions) {
      selected.add(script)
    }
  }

  for (const file of changed) {
    let covered = [...selected].some((script) => imports(join('scripts', script), root).has(resolve(root, file)))
    if (file === 'scripts/verify-all.mjs') {
      for (const script of scripts) selected.add(script)
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
        ? ['verify-noncombat-browser.mjs', 'verify-online-browser.mjs', ...extraBrowser]
        : /public\/assets\/(combat|enemies)\//.test(file)
          ? ['verify-browser.mjs', 'verify-online-browser.mjs', ...extraBrowser]
          : browser
      for (const script of owners) selected.add(script)
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
    if (sharedUi.test(file)) { for (const script of browser) selected.add(script); covered = true }
    else if (onlineUi.test(file)) {
      selected.add('verify-online-browser.mjs')
      for (const script of extraBrowser) selected.add(script)
      covered = true
    }
    else if (file.startsWith('src/ui/')) {
      selected.add('verify-browser.mjs')
      for (const script of extraBrowser) selected.add(script)
      const absolute = resolve(root, file)
      if (noncombatRoots.some((entry) => imports(entry, root).has(absolute))) selected.add('verify-noncombat-browser.mjs')
      if (imports('src/ui/OnlineGame.tsx', root).has(absolute)) selected.add('verify-online-browser.mjs')
      covered = true
    }
    else if (file === 'src/game/run.ts') {
      for (const script of browser) selected.add(script)
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
      if (owners.length) {
        for (const script of [...owners, ...extraBrowser]) selected.add(script)
        // Answering for the barrel must not also answer for the file: a module
        // nothing imports yet is still uncovered, and has to keep the
        // run-everything fallback below. A module that IS imported already had
        // `covered` set by the transitive scan.
        if (barrel === file) covered = true
      }
    }

    if (/^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig|vite\.config)/.test(file)) {
      for (const script of scripts) selected.add(script)
      covered = true
    }
    if ((file.startsWith('src/') || file.startsWith('scripts/')) && !covered && extname(file)) {
      for (const script of scripts) selected.add(script)
    }
    if (file.startsWith('src/')) selected.add('verify-architecture.mjs')
  }

  return scripts.filter((script) => selected.has(script))
}
