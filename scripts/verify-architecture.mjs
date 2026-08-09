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
import { CARDS, DEFERRED_CARDS } from '../src/game/cards.ts'
import { ENEMIES } from '../src/game/enemies.ts'
import { RELICS, POTIONS } from '../src/game/relics.ts'
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

// The list has also drifted on countable claims. Where it states a number, that
// number is checkable, so check it rather than trusting prose.
check('the not-implemented list states the real card count', () => {
  const notes = readFileSync(join(srcRoot, 'game/state.ts'), 'utf8')
  const claimed = notes.match(/(\d+) of (\d+) unique character cards are live/)
  assert(claimed !== null, 'the list should state how many unique character cards are live')

  // Counted from the real table, not scraped: a regex over the source only
  // sees cards written the way it expects, so the one card declared without
  // the `card(...)` helper was invisible to it. Each verify script is its own
  // process, so fixtures other suites register at runtime cannot leak in.
  //
  // Character cards only. Physical component counts include repeated copies,
  // while CARDS holds one rule definition per unique face.
  const POOLED = new Set(['status', 'curse', 'colorless'])
  const live = Object.values(CARDS).filter((def) => !POOLED.has(def.owner)).length
  const printed = new Set()
  const rows = readFileSync(join(repoRoot, 'data/raw/player-cards.csv'), 'utf8')
  const decks = new Set(['Ironclad', 'Silent', 'Defect', 'Watcher'])
  for (const line of rows.split('\n').slice(1)) {
    const cells = line.split('","').map((cell) => cell.replace(/^"|"\r?$/g, ''))
    if (decks.has(cells[0]) && cells[1]) printed.add(`${cells[0]}:${cells[1]}`)
  }

  assertEqual(
    Number(claimed[1]),
    live,
    `state.ts claims ${claimed[1]} cards are live but cards.ts defines ${live}`,
  )
  assertEqual(Number(claimed[2]), printed.size, 'the full set count should use unique printed definitions')

  const untranscribed = notes.match(/other (\d+) have not been transcribed/)
  assert(untranscribed !== null, 'the list should state how many player cards remain untranscribed')
  assertEqual(
    Number(untranscribed[1]),
    printed.size - live - DEFERRED_CARDS.length,
    'the untranscribed count should exclude both live and explicitly deferred cards',
  )
})

// DEFERRED_CARDS is a promise about what is NOT in the game. A promise nothing
// checks is just a comment, and this one is the record of which transcribed
// cards were held back and why -- if an id quietly appears in both lists, the
// list stops describing the game.
check('the deferred list and the live table do not overlap', () => {
  const clash = DEFERRED_CARDS.filter((id) => CARDS[id] !== undefined)
  assertEqual(
    clash.length,
    0,
    `these ids are listed as deferred but are live: ${clash.join(', ')}`,
  )
})

check('the not-implemented list states the real deferred count', () => {
  const notes = readFileSync(join(srcRoot, 'game/state.ts'), 'utf8')
  const WORDS = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
    ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
    fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  }
  const claimed = notes.match(/(?:(\w+) more|No scan-read cards are)[^.]*?held back/i)
  assert(claimed !== null, 'the list should say how many cards are held back')
  const stated = claimed[1] ? WORDS[claimed[1].toLowerCase()] ?? Number(claimed[1]) : 0
  assert(Number.isFinite(stated), `could not read "${claimed[1] ?? 'No'}" as a number`)
  assertEqual(
    stated,
    DEFERRED_CARDS.length,
    `state.ts says ${claimed[1] ?? 'no'} cards are held back but DEFERRED_CARDS lists ${DEFERRED_CARDS.length}`,
  )
})

check('the not-implemented list states the real enemy count', () => {
  const notes = readFileSync(join(srcRoot, 'game/state.ts'), 'utf8')
  const claimed = notes.match(/(\d+) enemies of roughly 60/)
  assert(claimed !== null, 'the list should state how many enemy definitions are live')
  assertEqual(
    Number(claimed[1]),
    Object.keys(ENEMIES).length,
    `state.ts claims ${claimed[1]} enemies but enemies.ts defines ${Object.keys(ENEMIES).length}`,
  )
})


// Post-draw discard now has a private two-step protocol. Post-draw exhaust does
// not: allowing one into the live table would silently make it unplayable.
check('no live card draws before exhausting from hand', () => {
  const offenders = []
  for (const def of Object.values(CARDS)) {
    for (const face of [def, def.upgrade ? { ...def, ...def.upgrade } : null]) {
      let drewFirst = false
      for (const effect of face?.effects ?? []) {
        if (effect.kind === 'draw') drewFirst = true
        if (drewFirst && effect.kind === 'exhaustFromHand') offenders.push(def.id)
      }
    }
  }
  assertEqual(offenders.length, 0,
    `these cards need a post-draw exhaust protocol: ${offenders.join(', ')}`)
})


// A condition that reads the enemy being struck can only be answered once a
// target is chosen. `applyEffect` checks an effect-level `when` BEFORE it
// resolves the target scope -- it has to, since a clause that does not happen
// picks no target -- so `targetPoisoned` there has no enemy to read and comes
// back false every time. The clause would simply never fire, and nothing about
// the card would look wrong. Target-reading conditions belong inside an
// `Amount`, where the resolver runs them per enemy.
check('no condition reads a target that its reader was never handed', () => {
  const TARGET_READING = new Set(['targetPoisoned', 'targetFullHp'])
  const BOARD_READING = new Set([
    'hasShiv', 'discardTopCosts', 'dieShows', 'inStance', 'discardedThisTurn', 'stanceChangedThisTurn',
    'orbsAtLeast',
  ])
  // A hardcoded list quietly stops covering the condition somebody adds next,
  // and this one is the whole check: an unclassified kind would be treated as
  // safe everywhere. So every variant of the `Condition` union has to be filed
  // under exactly one of the two sets above, read off the source rather than
  // remembered. The engine's own `holds` switch is exhaustive by type; this is
  // the same guarantee for a list TypeScript cannot see.
  const union = readFileSync(new URL('../src/game/cards.ts', import.meta.url), 'utf8')
    .split('export type Condition =')[1]
    .split('export type CountOf')[0]
  const declared = [...union.matchAll(/kind: '(\w+)'/g)].map((match) => match[1])
  assert(declared.length > 0, 'the Condition union should have parsed')
  const unfiled = declared.filter((kind) => !TARGET_READING.has(kind) && !BOARD_READING.has(kind))
  assertEqual(
    unfiled.length,
    0,
    `these conditions are not classified as target- or board-reading: ${unfiled.join(', ')}`,
  )

  // `hit.amount` is the ONLY place the resolver passes an enemy through. The
  // clause-level `when` runs before a target is picked; `hit.times` is read
  // once for the whole attack; `block.amount` is worked out off the caster's
  // board. A target-reading condition in any of those returns false for ever.
  const offenders = []
  const blame = (def, where, condition) => {
    if (condition && TARGET_READING.has(condition.kind)) {
      offenders.push(`${def.id} (${where} gated on ${condition.kind})`)
    }
  }
  const inspect = (def, effects) => {
    for (const effect of effects ?? []) {
      blame(def, `${effect.kind} clause`, effect.when)
      if (effect.kind === 'hit') blame(def, 'hit times', effect.times?.bonus?.when)
      if (effect.kind === 'block') blame(def, 'block amount', effect.amount?.bonus?.when)
    }
  }
  for (const def of Object.values(CARDS)) {
    for (const face of [def, def.upgrade ? { ...def, ...def.upgrade } : null]) {
      inspect(def, face?.effects)
    }
  }
  // Relics and potions carry the same `Effect` list through the same resolver,
  // so the same condition in the same place fails the same way. Checking only
  // cards left the other two thirds of the vocabulary's users unguarded.
  for (const def of Object.values(RELICS)) inspect(def, def.effects)
  for (const def of Object.values(POTIONS)) inspect(def, def.effects)
  assertEqual(
    offenders.length,
    0,
    `these conditions would silently never fire: ${offenders.join(', ')}`,
  )
})

// Both checks above are self-consistency only: the list is compared with itself
// and with prose. Nothing tied an entry to a card that exists, so a typo --
// 'thirdeye' for 'third_eye' -- would drop a card from the live table AND from
// the record of what was held back, silently, in both directions.
check('every deferred id names a real printed card', () => {
  const rows = readFileSync(join(srcRoot, '../data/raw/player-cards.csv'), 'utf8')
  const slugs = new Set()
  for (const line of rows.split('\n').slice(1)) {
    const cells = line.split('","').map((cell) => cell.replace(/^"|"\r?$/g, ''))
    if (cells.length < 2 || !cells[1]) continue
    slugs.add(cells[1].toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/(^_|_$)/g, ''))
  }
  assert(slugs.size > 250, `the component list should have parsed, got ${slugs.size} names`)

  const unknown = DEFERRED_CARDS.filter((id) => !slugs.has(id))
  assertEqual(
    unknown.length,
    0,
    `these deferred ids match no card in the printed component list: ${unknown.join(', ')}`,
  )
})


report('architecture')
