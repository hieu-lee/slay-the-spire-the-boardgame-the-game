// The two pure functions behind the end-of-run summary and the card-morph
// overlay. Both are branchy and neither had a check: `diffDeckMorphs` decides
// whether an animation fires at all, and it infers a transform from a shape the
// engine does not label, so a regression there is silent — a bogus animation
// over a reward screen, or none where a card really did change.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { diffDeckMorphs, planMorphs } from '../src/ui/useCardMorphs.ts'
import { deckHighlights } from '../src/ui/run-summary-data.ts'
import { EVENT_DEFINITIONS } from '../src/game/events.ts'
import { suite, check, assert, assertDeepEqual, assertEqual, report } from './lib/harness.mjs'

suite('run presentation')

check('every event has its own full-screen background', () => {
  const files = Object.keys(EVENT_DEFINITIONS).map((id) => new URL(`../public/assets/noncombat/events/${id}.webp`, import.meta.url))
  const hashes = files.map((file) => createHash('sha256').update(readFileSync(file)).digest('hex'))
  assertEqual(new Set(hashes).size, hashes.length, 'event backgrounds must not reuse one generic scene')
  for (const file of files) {
    const inspected = spawnSync('webpinfo', ['-summary', fileURLToPath(file)], { encoding: 'utf8' })
    const width = Number(inspected.stdout.match(/Width:\s+(\d+)/)?.[1])
    const height = Number(inspected.stdout.match(/Height:\s+(\d+)/)?.[1])
    assert(inspected.status === 0 && width / height >= 1.9,
      `${file.pathname.split('/').at(-1)} is not a decodable panoramic background: ${width}x${height}`)
  }
})

// `diffDeckMorphs` never resolves a card definition, so its cases may use any
// id. `deckHighlights` does resolve, so its cases must use REAL ids — `cardDef`
// throws on an unknown one, which is how the first draft of this file caught
// itself using `strike` when the real id is `strike_ironclad`.
const card = (uid, defId, upgraded = false) => ({ uid, defId, upgraded })
const base = [card('c1', 'strike'), card('c2', 'strike'), card('c3', 'defend')]

check('an upgrade in place is reported as an upgrade', () => {
  const after = [card('c1', 'strike', true), card('c2', 'strike'), card('c3', 'defend')]
  const found = diffDeckMorphs(base, after)
  assertEqual(found.length, 1)
  assertEqual(found[0].kind, 'upgrade')
  assertEqual(found[0].from.upgraded, false, 'the "before" face must be the un-upgraded one')
  assertEqual(found[0].to.upgraded, true)
})

check('several upgrades at once all report, so the queue has something to drain', () => {
  // Astrolabe upgrades three cards in a single engine step.
  const after = base.map((entry) => ({ ...entry, upgraded: true }))
  assertEqual(diffDeckMorphs(base, after).length, 3)
})

check('one card out and one in is inferred as a transform', () => {
  const after = [card('c2', 'strike'), card('c3', 'defend'), card('c9', 'anger')]
  const found = diffDeckMorphs(base, after)
  assertEqual(found.length, 1)
  assertEqual(found[0].kind, 'transform')
  assertEqual(found[0].from.uid, 'c1')
  assertEqual(found[0].to.uid, 'c9')
})

check('gaining a card is not a transform', () => {
  // A card reward only adds. Firing here would put the overlay over the reward
  // screen, which is worse than missing an animation.
  assertEqual(diffDeckMorphs(base, [...base, card('c9', 'anger')]).length, 0)
})

check('an armed gain surfaces the arrived card, with no source to burn from', () => {
  const found = diffDeckMorphs(base, [...base, card('c9', 'anger')], true)
  assertEqual(found.length, 1)
  assertEqual(found[0].kind, 'gain')
  assertEqual(found[0].from, null)
  assertEqual(found[0].to.uid, 'c9')
})

check('arming does not turn a real transform into a gain', () => {
  // Whichever inference wins, only one request should come out of a single
  // one-out-one-in diff.
  const after = [card('c2', 'strike'), card('c3', 'defend'), card('c9', 'anger')]
  const found = diffDeckMorphs(base, after, true)
  assertEqual(found.length, 1)
  assertEqual(found[0].kind, 'transform')
})

check('arming a two-card gain queues both', () => {
  // Embrace Madness adds two random card rewards in one step.
  const after = [...base, card('c9', 'anger'), card('c10', 'cleave')]
  const found = diffDeckMorphs(base, after, true)
  assertEqual(found.length, 2)
  assert(found.every((entry) => entry.kind === 'gain'))
})

check('removing cards queues each departed face without inventing a replacement', () => {
  const found = diffDeckMorphs(base, base.slice(2))
  assertEqual(found.length, 2)
  assert(found.every((entry) => entry.kind === 'remove' && entry.to === null))
  assertEqual(found.map((entry) => entry.from.uid).join(','), 'c1,c2')
})

check('removing one card while upgrading another queues both animations', () => {
  const found = diffDeckMorphs(base, [card('c1', 'strike', true), card('c3', 'defend')])
  assertDeepEqual(found.map((entry) => entry.kind), ['upgrade', 'remove'])
  assertEqual(found[1].from.uid, 'c2')
})

check('a multi-card transform queues every changed card', () => {
  const after = [card('c7', 'anger'), card('c8', 'cleave'), card('c9', 'clash')]
  const found = diffDeckMorphs(base, after)
  assertEqual(found.length, 3)
  assert(found.every((entry) => entry.kind === 'transform'))
})

check('transforms still queue when a later effect also gains a card', () => {
  // Transmogriphier transforms two, then adds a Curse. Replacements are appended
  // first by transformCard, so the surplus arrival is not paired as a transform.
  const after = [card('c3', 'defend'), card('c7', 'anger'), card('c8', 'cleave'), card('c9', 'curse')]
  const found = diffDeckMorphs(base, after)
  assertEqual(found.length, 2)
  assert(found.every((entry) => entry.kind === 'transform'))
  assertDeepEqual(found.map((entry) => entry.to.uid), ['c7', 'c8'])
})

check('an armed transform plus gain animates both kinds in order', () => {
  const after = [card('c2', 'strike'), card('c3', 'defend'), card('c7', 'anger'), card('c8', 'curse')]
  const found = diffDeckMorphs(base, after, true)
  assertDeepEqual(found.map((entry) => entry.kind), ['transform', 'gain'])
})

check('an unchanged deck reports nothing', () => {
  assertEqual(diffDeckMorphs(base, [...base]).length, 0)
})

check('an upgrade alongside a swap does not also claim a transform', () => {
  const after = [card('c1', 'strike', true), card('c3', 'defend'), card('c9', 'anger')]
  const found = diffDeckMorphs(base, after)
  assertEqual(found.length, 1, 'only the upgrade should report')
  assertEqual(found[0].kind, 'upgrade')
})

check('deck highlights count duplicates, most-copied first', () => {
  const deck = [
    ...Array.from({ length: 5 }, (_, i) => card(`s${i}`, 'strike_ironclad')),
    ...Array.from({ length: 3 }, (_, i) => card(`d${i}`, 'defend_ironclad')),
    card('u1', 'anger'),
  ]
  const top = deckHighlights(deck)
  assertEqual(top.length, 2, 'the singleton is dropped')
  assertEqual(top[0].count, 5)
  assertEqual(top[1].count, 3)
  assertEqual(top[0].name, 'Strike', 'the most-copied card leads')
})

check('deck highlights break ties by name, so the summary is stable run to run', () => {
  const deck = [card('a1', 'anger'), card('a2', 'anger'), card('b1', 'cleave'), card('b2', 'cleave')]
  const first = deckHighlights(deck)
  const reversed = deckHighlights([...deck].reverse())
  assertEqual(first.map((entry) => entry.name).join(','), reversed.map((entry) => entry.name).join(','),
    'the same deck in a different order must summarise identically')
})

check('deck highlights respect the limit', () => {
  const deck = ['strike_ironclad', 'defend_ironclad', 'anger', 'cleave', 'clash']
    .flatMap((defId) => [card(`${defId}1`, defId), card(`${defId}2`, defId)])
  assertEqual(deckHighlights(deck, 3).length, 3)
})

check('a card that ARRIVES already upgraded is not reported as an upgrade', () => {
  // Neow blessings and upgraded rewards add an upgraded card outright. The
  // `=== false` test on the previous face is what rejects it; rewriting that as
  // `!previous.get(...)?.upgraded` would call this an upgrade of a card that
  // never existed un-upgraded.
  const after = [...base, card('c9', 'anger', true)]
  assertEqual(diffDeckMorphs(base, after).filter((entry) => entry.kind === 'upgrade').length, 0)
})

check('a fresh run reusing the previous run\'s uids is not a transform', () => {
  // `createRun` resets the uid counter, so run B's starters are c1, c2, c3…
  // exactly the ids run A used. Diffed naively across that seam, the ordinary
  // shape of a finished run — a card gained, a starter removed — looks like
  // one-out/one-in. The hook re-baselines on `runId` so this diff never runs;
  // this pins the shape that made it dangerous.
  const finished = [card('c1', 'strike_ironclad'), card('c2', 'defend_ironclad'), card('c9', 'anger')]
  const freshRun = [card('c1', 'strike_ironclad'), card('c2', 'defend_ironclad'), card('c3', 'bash')]
  const found = diffDeckMorphs(finished, freshRun)
  assertEqual(found.length, 1, 'the raw diff really does see a transform here')
  assertEqual(found[0].kind, 'transform')
})

check('deck highlights default to four entries', () => {
  const deck = ['strike_ironclad', 'defend_ironclad', 'anger', 'cleave', 'clash']
    .flatMap((defId) => [card(`${defId}1`, defId), card(`${defId}2`, defId)])
  assertEqual(deckHighlights(deck).length, 4, 'five duplicated cards, default limit of four')
})

check('an upgraded card is counted apart from its base version', () => {
  // Four Strikes and one Strike+ used to read "5x Strike", hiding the upgrade
  // the player spent a campfire on. Only the four repeat, so only they show.
  const deck = [
    ...Array.from({ length: 4 }, (_, i) => card(`s${i}`, 'strike_ironclad')),
    card('s9', 'strike_ironclad', true),
  ]
  const top = deckHighlights(deck)
  assertEqual(top.length, 1)
  assertEqual(top[0].count, 4, 'the upgraded copy must not inflate the base count')
  assertEqual(top[0].name, 'Strike')
})

check('repeated upgrades get their own upgraded name', () => {
  const deck = Array.from({ length: 3 }, (_, i) => card(`s${i}`, 'strike_ironclad', true))
  const top = deckHighlights(deck)
  assertEqual(top.length, 1)
  assertEqual(top[0].count, 3)
  assert(top[0].name.endsWith('+'), `an upgraded face should read as upgraded, got ${top[0].name}`)
})

check('an empty deck highlights nothing', () => {
  assertEqual(deckHighlights([]).length, 0)
})

// --- planMorphs: the queue decision that has regressed three times ---

const upgraded = [card('c1', 'strike_ironclad', true), card('c2', 'defend_ironclad')]
const plain = [card('c1', 'strike_ironclad'), card('c2', 'defend_ironclad')]

check('an upgrade that lands WITH a phase change still animates', () => {
  // The engine's usual shape: resolveCampfire writes `upgraded: true` AND
  // returns `phase: map` in one object, so deck and phase change together.
  // Re-baselining on any phase change silenced Smith, most upgrade events, the
  // last transform reward and solo Neow — every path a solo player takes.
  const plan = planMorphs(plain, upgraded, false, true)
  assertEqual(plan.mode, 'replace', 'the previous screen\'s morph must not linger')
  assertEqual(plan.morphs.length, 1, 'but this update\'s upgrade must still play')
  assertEqual(plan.morphs[0].kind, 'upgrade')
})

check('a phase change with no deck change clears what was on screen', () => {
  // Walking from the map into combat must not drag a veil along with it.
  const plan = planMorphs(plain, plain, false, true)
  assertEqual(plan.mode, 'replace')
  assertEqual(plan.morphs.length, 0)
})

check('a new run discards everything, diffing nothing', () => {
  // Run B's uids collide with run A's; diffing across that seam invents a
  // transform. The baseline moves forward without producing a morph.
  const plan = planMorphs(plain, upgraded, true, true)
  assertEqual(plan.mode, 'replace')
  assertEqual(plan.morphs.length, 0, 'a run boundary is never a card change')
  assertEqual(plan.baseline, upgraded, 'the new run becomes the baseline')
})

check('the first deck seen is a baseline, not a diff', () => {
  const plan = planMorphs(null, upgraded, false, false)
  assertEqual(plan.mode, 'idle')
  assertEqual(plan.morphs.length, 0, 'reloading mid-run must not replay old upgrades')
  assertEqual(plan.baseline, upgraded)
})

check('an in-phase upgrade appends, so several in one step all play', () => {
  const plan = planMorphs(plain, upgraded, false, false)
  assertEqual(plan.mode, 'append')
  assertEqual(plan.morphs.length, 1)
})

check('an in-phase update with no change leaves the queue alone', () => {
  const plan = planMorphs(plain, plain, false, false)
  assertEqual(plan.mode, 'idle', 'appending nothing would still re-render the queue')
})

check('losing the deck clears the baseline without touching the queue', () => {
  const plan = planMorphs(plain, undefined, false, false)
  assertEqual(plan.mode, 'idle')
  assertEqual(plan.baseline, null)
})

check('an armed plain add appends as a gain', () => {
  const gained = [...plain, card('c9', 'anger')]
  const plan = planMorphs(plain, gained, false, false, true)
  assertEqual(plan.mode, 'append')
  assertEqual(plan.morphs.length, 1)
  assertEqual(plan.morphs[0].kind, 'gain')
})

check('an unarmed plain add stays silent', () => {
  const gained = [...plain, card('c9', 'anger')]
  const plan = planMorphs(plain, gained, false, false)
  assertEqual(plan.mode, 'idle')
  assertEqual(plan.morphs.length, 0)
})

report('run presentation')
