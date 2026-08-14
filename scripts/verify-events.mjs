import { readFileSync } from 'node:fs'
import { EVENT_CARDS, EVENT_DEFINITIONS, buildEventDeck } from '../src/game/events.ts'
import { createRng } from '../src/game/rng.ts'
import { suite, check, assert, assertEqual, assertDeepEqual, report } from './lib/harness.mjs'

suite('physical event catalog')

const normalizeName = (name) => {
  const normalized = name.toLowerCase().replaceAll(/[^a-z0-9]+/g, '_').replaceAll(/^_|_$/g, '')
  if (normalized === 'encouter') return 'encounter'
  return normalized === 'the_merchant' ? 'merchant' : normalized
}

const rawEventInventory = readFileSync(new URL('../data/raw/enemies-events-elites.csv', import.meta.url), 'utf8')
  .trim().split('\n').slice(1)
  .map((line) => line.slice(1, -1).split('","'))
  .filter((columns) => columns[1] === 'Event')
  .map((columns) => ({
    name: normalizeName(columns[0]),
    act: ({ I: 1, II: 2, III: 3 })[columns[2]],
    copies: Number(columns[3]),
    minAscension: columns[9] === '3' ? 3 : 0,
    requiresColorlessUnlock: columns[10] === 'C',
  }))

check('contains all 51 physical Event cards with unique instance ids', () => {
  assertEqual(EVENT_CARDS.length, 51)
  assertEqual(new Set(EVENT_CARDS.map((card) => card.instanceId)).size, 51)
  for (const card of EVENT_CARDS) {
    assert(EVENT_DEFINITIONS[card.id], `${card.instanceId} has no definition`)
    assert(card.options.length > 0, `${card.instanceId} has no options`)
    assert(card.options.every((choice) => choice.effects.length > 0), `${card.instanceId} has an untagged option`)
  }
})

check('exact names, copies, Acts, A3 flags, and Colorless flag match the physical component inventory', () => {
  const actual = new Map()
  for (const card of EVENT_CARDS) {
    const key = JSON.stringify({
      name: normalizeName(card.name),
      act: card.act,
      minAscension: card.minAscension,
      requiresColorlessUnlock: card.requiresColorlessUnlock,
    })
    actual.set(key, (actual.get(key) ?? 0) + 1)
  }
  const normalizedActual = [...actual].map(([key, copies]) => {
    const entry = JSON.parse(key)
    return { name: entry.name, act: entry.act, copies, minAscension: entry.minAscension, requiresColorlessUnlock: entry.requiresColorlessUnlock }
  })
  const byInventoryKey = (entry) => `${entry.act}:${entry.name}:${entry.minAscension}:${entry.requiresColorlessUnlock}`
  assertDeepEqual(
    normalizedActual.sort((a, b) => byInventoryKey(a).localeCompare(byInventoryKey(b))),
    rawEventInventory.sort((a, b) => byInventoryKey(a).localeCompare(byInventoryKey(b))),
  )
})

check('base and Ascension 3 decks match the physical card counts', () => {
  const base = [1, 2, 3].map((act) => buildEventDeck(createRng(1), act, 0, false).length)
  const harder = [1, 2, 3].map((act) => buildEventDeck(createRng(1), act, 3, false).length)
  assertDeepEqual(base, [12, 14, 11])
  assertDeepEqual(harder, [18, 19, 13])
  assertEqual(buildEventDeck(createRng(1), 3, 0, true).length, 12)
  assertEqual(buildEventDeck(createRng(1), 3, 3, true).length, 14)
})

check('Ascension 3 adds only the harder Event cards', () => {
  for (const act of [1, 2, 3]) {
    const base = new Set(buildEventDeck(createRng(9), act, 0, false).map((card) => card.instanceId))
    assertDeepEqual(
      buildEventDeck(createRng(9), act, 2, false).map((card) => card.instanceId),
      buildEventDeck(createRng(9), act, 0, false).map((card) => card.instanceId),
      `Act ${act} harder Events must not enter before Ascension 3`,
    )
    const harder = buildEventDeck(createRng(9), act, 3, false)
    for (const card of harder) if (!base.has(card.instanceId)) assertEqual(card.minAscension, 3)
  }
})

check('easy-to-miss printed riders are machine-readable', () => {
  const sacrifice = EVENT_DEFINITIONS.upgrade_shrine.options.find((choice) => choice.id === 'sacrifice')
  assert(sacrifice.effects.some((effect) => effect.tag === 'lose-hp' && effect.amount === 2), 'Upgrade Shrine Sacrifice must lose 2 HP')
  const bonfire = EVENT_DEFINITIONS.bonfire_spirits.options[0].effects
  assert(bonfire.some((effect) => effect.tag === 'heal' && effect.amount === 3 && effect.filter?.includes('uncommon')))
  assert(bonfire.some((effect) => effect.tag === 'full-heal' && effect.filter?.includes('rare')))
  assert(bonfire.some((effect) => effect.tag === 'lose-hp' && effect.filter?.includes('Curse')))
  assertEqual(EVENT_CARDS.filter((card) => card.id === 'encounter_redraw').length, 1, 'only one Act I Encounter has the first-Event rider')
  assertEqual(EVENT_CARDS.filter((card) => card.id === 'merchant_redraw').length, 1, 'only the Act I Merchant has the first-Event rider')
})

check('Sensory Stone is gated only by the Colorless unlock', () => {
  for (const ascension of [0, 3, 13]) {
    const locked = buildEventDeck(createRng(2), 3, ascension, false)
    const unlocked = buildEventDeck(createRng(2), 3, ascension, true)
    assert(!locked.some((card) => card.id === 'sensory_stone'))
    assertEqual(unlocked.filter((card) => card.id === 'sensory_stone').length, 1)
  }
})

check('deck construction is deterministic and never mutates the catalog', () => {
  const before = EVENT_CARDS.map((card) => card.instanceId)
  const a = buildEventDeck(createRng(8675309), 2, 3, true).map((card) => card.instanceId)
  const b = buildEventDeck(createRng(8675309), 2, 3, true).map((card) => card.instanceId)
  assertDeepEqual(a, b)
  assertDeepEqual(EVENT_CARDS.map((card) => card.instanceId), before)
})

check('shared acquisition paths have explicit effect tags', () => {
  const tags = new Set(EVENT_CARDS.flatMap((card) => card.options.flatMap((choice) => choice.effects.map((effect) => effect.tag))))
  for (const tag of ['gain-relic', 'gain-potion', 'card-reward', 'rare-reward']) {
    assert(tags.has(tag), `missing ${tag} acquisition hook`)
  }
})

report('physical event catalog')
