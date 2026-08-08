// Structural invariants that keep the engine importable from the server, the
// browser, and the playtests. These are the rules that no type checker enforces
// and that quietly rot as the codebase grows.
//
//   1. src/game/ has no import cycles.
//   2. src/game/ imports nothing outside src/game/ and no external package.
//   3. src/multiplayer/ never imports src/ui/.
//   4. Nothing reachable from the engine imports a stylesheet.
//   5. src/ uses erasable-only TypeScript, because scripts/verify-*.mjs and the
//      server load .ts files through Node's type stripping, which rejects enum,
//      namespace, and constructor parameter properties.
import { readFileSync, existsSync, readdirSync, statSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { suite, check, assert, assertEqual, report } from './lib/harness.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const srcRoot = join(repoRoot, 'src')

function walk(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full)
  }
  return out
}

// Two strippers, because the two kinds of scan want opposite failure modes.
//
// The import graph must never MISS an import — a missed edge hides a real cycle
// or boundary violation. So it only removes block comments and whole-line
// comments, neither of which can truncate a string literal.
function stripSafeComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

// The banned-spelling scans below would rather over-match than under-match: a
// false alarm is a one-line fix, a miss ships a desync nobody can reproduce. So
// this also drops trailing comments, accepting that it can truncate a line
// containing a `//` inside a string.
function stripAllComments(source) {
  return stripSafeComments(source).replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** Import specifiers, ignoring anything inside a line/block comment. */
function importsOf(file) {
  const source = stripSafeComments(readFileSync(file, 'utf8'))
  const specifiers = []
  const pattern = /(?:^|[\s;}])(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g
  for (const match of source.matchAll(pattern)) specifiers.push(match[1])
  for (const match of source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specifiers.push(match[1])
  return specifiers
}

// Vite lets you suffix an import with ?inline, ?url, ?raw — strip it before
// deciding what kind of file a specifier names.
const withoutQuery = (specifier) => specifier.split('?')[0]

function resolveLocal(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null
  const base = resolve(dirname(fromFile), withoutQuery(specifier))
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return base
}

function buildGraph(root) {
  const graph = new Map()
  for (const file of walk(root)) {
    graph.set(
      file,
      importsOf(file)
        .map((specifier) => resolveLocal(file, specifier))
        .filter((target) => target !== null),
    )
  }
  return graph
}

/** Returns a cycle as a list of files, or null. */
function findCycle(graph) {
  const state = new Map()
  const stack = []
  const visit = (node) => {
    if (state.get(node) === 'done') return null
    if (state.get(node) === 'open') return [...stack.slice(stack.indexOf(node)), node]
    state.set(node, 'open')
    stack.push(node)
    for (const next of graph.get(node) ?? []) {
      if (!graph.has(next)) continue
      const cycle = visit(next)
      if (cycle) return cycle
    }
    stack.pop()
    state.set(node, 'done')
    return null
  }
  for (const node of graph.keys()) {
    const cycle = visit(node)
    if (cycle) return cycle
  }
  return null
}

const show = (file) => relative(repoRoot, file)

suite('architecture')

check('src/game has no import cycles', () => {
  const cycle = findCycle(buildGraph(join(srcRoot, 'game')))
  assert(cycle === null, `import cycle: ${cycle?.map(show).join(' -> ')}`)
})

check('the cycle detector actually detects cycles', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arch-'))
  try {
    writeFileSync(join(dir, 'a.ts'), "import { b } from './b.ts'\nexport const a = b\n")
    writeFileSync(join(dir, 'b.ts'), "import { a } from './a.ts'\nexport const b = a\n")
    assert(findCycle(buildGraph(dir)) !== null, 'detector missed an obvious two-file cycle')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

check('comment stripping never hides an import', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arch-'))
  try {
    // A `//` inside the specifier, and a trailing comment after it. If either
    // truncates the line, the edge vanishes and every boundary check below
    // silently stops covering this file.
    writeFileSync(join(dir, 'a.ts'), "import { b } from './sub//b.ts' // see docs\nexport const a = b\n")
    writeFileSync(join(dir, 'b.ts'), 'export const b = 1\n')
    const found = importsOf(join(dir, 'a.ts'))
    assert(found.includes('./sub//b.ts'), `import was lost to comment stripping, got ${JSON.stringify(found)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

check('src/game imports nothing outside itself', () => {
  const gameRoot = join(srcRoot, 'game')
  for (const file of walk(gameRoot)) {
    for (const specifier of importsOf(file)) {
      if (specifier.startsWith('node:')) continue
      assert(
        specifier.startsWith('.'),
        `${show(file)} imports external package "${specifier}"; the engine must stay dependency-free`,
      )
      const target = resolveLocal(file, specifier)
      assert(
        target !== null && target.startsWith(gameRoot),
        `${show(file)} imports "${specifier}" outside src/game/; the engine must not depend on UI or transport`,
      )
    }
  }
})

check('src/multiplayer never imports the UI', () => {
  for (const file of walk(join(srcRoot, 'multiplayer'))) {
    for (const specifier of importsOf(file)) {
      assert(
        !specifier.includes('/ui/'),
        `${show(file)} imports "${specifier}"; the server loads this module and cannot render React`,
      )
    }
  }
})

check('the engine and the protocol import no stylesheets', () => {
  for (const file of [...walk(join(srcRoot, 'game')), ...walk(join(srcRoot, 'multiplayer'))]) {
    for (const specifier of importsOf(file)) {
      assert(!withoutQuery(specifier).endsWith('.css'), `${show(file)} imports the stylesheet "${specifier}"`)
    }
  }
})

check('src/ uses erasable-only TypeScript', () => {
  // Node's type stripping rejects these outright, which would break every
  // verify script and the server the moment such a construct is introduced.
  const banned = [
    [/(^|[\s;])(?:const\s+)?enum\s+\w/m, 'enum (use a const object plus a union type)'],
    [/(^|[\s;])namespace\s+\w/m, 'namespace (use a module)'],
    [/constructor\s*\([^)]*\b(?:public|private|protected|readonly)\s+\w/s, 'constructor parameter property'],
  ]
  for (const file of walk(srcRoot)) {
    const source = stripAllComments(readFileSync(file, 'utf8'))
    for (const [pattern, label] of banned) {
      assert(!pattern.test(source), `${show(file)} uses ${label}, which Node's type stripping cannot erase`)
    }
  }
})

check('the erasable-syntax detector actually fires', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arch-'))
  try {
    const file = join(dir, 'bad.ts')
    writeFileSync(file, 'export enum Colour { Red, Blue }\n')
    assert(/(^|[\s;])(?:const\s+)?enum\s+\w/m.test(readFileSync(file, 'utf8')), 'enum detector missed an enum')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

check('the engine has no source of nondeterminism', () => {
  // A run replays from (seed, action log). Any ambient randomness or clock read
  // in the engine breaks replay, desyncs multiplayer, and makes playtests flaky.
  // Matched by spelling rather than by AST: over-matching a string literal is a
  // one-line false alarm, under-matching ships a desync nobody can reproduce.
  const banned = [
    [/Math\s*\.\s*random|Math\s*\[\s*['"]random['"]\s*\]/, 'Math.random', 'draw from src/game/rng.ts instead'],
    [/Date\s*\.\s*now|new\s+Date\s*\(/, 'the wall clock', 'the engine must be a pure function of its state'],
    [/performance\s*\.\s*now/, 'performance.now', 'the engine must be a pure function of its state'],
    [/crypto\s*\.\s*(?:randomUUID|getRandomValues)/, 'crypto randomness', 'draw from src/game/rng.ts instead'],
  ]
  for (const file of walk(join(srcRoot, 'game'))) {
    const source = stripAllComments(readFileSync(file, 'utf8'))
    for (const [pattern, what, why] of banned) {
      assert(!pattern.test(source), `${show(file)} reaches for ${what}; ${why}`)
    }
  }
})

check('the nondeterminism detector catches the ways around it', () => {
  const evasions = [
    'const r = Math.random; r()',
    'const r = Math["random"]()',
    'Math . random ()',
    'const t = new Date().getTime()',
    'const t = Date .now()',
    'const t = performance.now()',
    'const id = crypto.randomUUID()',
  ]
  const banned = [
    /Math\s*\.\s*random|Math\s*\[\s*['"]random['"]\s*\]/,
    /Date\s*\.\s*now|new\s+Date\s*\(/,
    /performance\s*\.\s*now/,
    /crypto\s*\.\s*(?:randomUUID|getRandomValues)/,
  ]
  for (const evasion of evasions) {
    assert(banned.some((pattern) => pattern.test(evasion)), `detector missed: ${evasion}`)
  }
})

check('every src/game module is reachable from the barrel', () => {
  const barrel = join(srcRoot, 'game', 'state.ts')
  if (!existsSync(barrel)) return // barrel arrives with the engine
  const graph = buildGraph(join(srcRoot, 'game'))
  const reachable = new Set()
  const visit = (node) => {
    if (reachable.has(node)) return
    reachable.add(node)
    for (const next of graph.get(node) ?? []) if (graph.has(next)) visit(next)
  }
  visit(barrel)
  for (const file of graph.keys()) {
    assertEqual(reachable.has(file), true, `${show(file)} is not reachable from src/game/state.ts — dead engine module?`)
  }
})

// The "Not implemented yet" list in state.ts has drifted three times: it has
// both under-reported (claiming things worked that did not) and over-reported
// (claiming things were missing after they were built). A list nobody trusts is
// worse than no list, so this pins it to something checkable: a room kind with
// its own screen component is, by definition, no longer a placeholder.
check('the not-implemented list does not call a built room a placeholder', () => {
  const notes = readFileSync(join(srcRoot, 'game/state.ts'), 'utf8')
  // Read only the room list, not the whole line: prose after the sentence may
  // legitimately mention a room that IS built.
  const listed = notes.match(/-\s*([^\n]*?)\s+rooms show a placeholder/)?.[1] ?? ''

  const screens = readdirSync(join(srcRoot, 'ui')).filter((file) => file.endsWith('Screen.tsx'))
  for (const screen of screens) {
    const kind = screen.replace('Screen.tsx', '').toLowerCase()
    // Combat and Map are not room kinds; only the room screens matter here.
    if (kind === 'combat' || kind === 'map') continue
    assert(
      !listed.toLowerCase().includes(kind),
      `${kind} has its own screen (${screen}) but state.ts still lists it as a placeholder`,
    )
  }
})

report('architecture')
