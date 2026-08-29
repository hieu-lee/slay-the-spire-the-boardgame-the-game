import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRng } from '../src/game/rng.ts'
import { buildEventDeck } from '../src/game/events.ts'
import { applyEventCombatStartEffects } from '../src/game/event-room.ts'
import { createRun } from '../src/game/run/setup.ts'
import {
  DOWNFALL_EVENT_DECKS,
  DOWNFALL_EVENT_DECK_SOURCES,
  DOWNFALL_EVENT_ICON_LEGEND,
  DOWNFALL_EVENT_SOURCE,
  DOWNFALL_EVENT_SOURCE_ENTRIES,
  DOWNFALL_EVENTS,
  DOWNFALL_EVENTS_BY_ID,
  DOWNFALL_PHYSICAL_EVENT_CARDS,
  downfallEventByCardId,
  resolveDownfallEventCard,
} from '../src/game/downfall/events.ts'

const manifestUrl = new URL('../tmp/downfall-reference/manifests/downfall-events.json', import.meta.url)
const saveUrl = new URL('../tmp/downfall-reference/downfall-workshop.json', import.meta.url)
const cleanClone = process.env.DOWNFALL_VERIFY_CLEAN === '1'
const manifest = !cleanClone && existsSync(manifestUrl) ? JSON.parse(readFileSync(manifestUrl, 'utf8')) : null
const save = !cleanClone && existsSync(saveUrl) ? JSON.parse(readFileSync(saveUrl, 'utf8')) : null

function allObjects(saveData) {
  const result = []
  const visit = (object) => {
    result.push(object)
    for (const child of object.ContainedObjects ?? []) visit(child)
  }
  for (const object of saveData.ObjectStates ?? []) visit(object)
  return result
}

const objects = save ? allObjects(save) : []
const checks = []
function check(name, fn) {
  fn()
  checks.push(name)
}

check('source and icon notation match the visually audited v1.47 manifest', () => {
  assert.equal(DOWNFALL_EVENT_SOURCE.version, 'official public TTS v1.47')
  assert.equal(Object.keys(DOWNFALL_EVENT_ICON_LEGEND).length, 8)
  if (!manifest) return
  assert.equal(DOWNFALL_EVENT_SOURCE.manifest, manifest.manifest)
  assert.equal(DOWNFALL_EVENT_SOURCE.version, manifest.version_scope)
  assert.equal(DOWNFALL_EVENT_SOURCE.save, manifest.source_save)
  assert.equal(DOWNFALL_EVENT_SOURCE.method, manifest.method)
  assert.deepEqual(DOWNFALL_EVENT_ICON_LEGEND, manifest.icon_legend)
})

check('all exact text, options, outcomes, sources, and ambiguity notes are preserved', () => {
  assert.equal(DOWNFALL_EVENT_SOURCE_ENTRIES.length, 14)
  if (manifest) assert.deepEqual(DOWNFALL_EVENT_SOURCE_ENTRIES, manifest.events)
  assert.equal(DOWNFALL_EVENTS.length, 14)
  assert.equal(Object.keys(DOWNFALL_EVENTS_BY_ID).length, 14)
  for (const event of DOWNFALL_EVENTS) {
    assert.equal(event.multiplicity, event.sources.length, event.title)
    assert.equal(event.options.length, Math.max(1, event.choices.length), event.title)
    assert(event.options.every((option) => option.effects.length > 0), event.title)
    assert(!JSON.stringify(event.options).includes('printed'), event.title)
  }
})

check('all printed options map to the complete native effect vocabulary', () => {
  const signatures = Object.fromEntries(DOWNFALL_EVENTS.flatMap((event) => event.choices.map((choice) => [
    `${event.act}/${event.title}/${choice.label}`,
    choice.effects.map((effect) => effect.tag).join(','),
  ])))
  assert.deepEqual(signatures, {
    '1/The Sssssrpent/Agree': 'gain-gold,gain-curse',
    '1/The Sssssrpent/Stomp': 'card-reward,lose-hp',
    '1/The Sssssrpent/Debate': 'remove-card,lose-gold',
    '1/World of Goop/Gather Gold': 'gain-gold,lose-hp',
    '1/World of Goop/Reach Deeper': 'gain-relic,gain-curse',
    '1/World of Goop/Leave It': 'lose-gold',
    '1/Scrap Ooze/Reach Inside': 'lose-hp,roll-d6',
    '1/Scrap Ooze/Leave': 'nothing',
    '1/Dead Adventurer/Search': 'roll-d6',
    '1/Dead Adventurer/Leave': 'nothing',
    '2/Masked Bandits/Duel Pointy': 'gain-relic,lose-hp',
    '2/Masked Bandits/Bribe Romeo': 'upgrade-card,lose-gold',
    '2/Masked Bandits/Hug Bear': 'remove-card,lose-max-hp',
    '2/The Mausoleum/Open Coffin': 'gain-relic,roll-d6',
    '2/The Mausoleum/Leave': 'nothing',
    '2/Forgotten Altar/Offer': 'lose-relic,gain-relic',
    '2/Forgotten Altar/Sacrifice': 'lose-hp',
    '2/Forgotten Altar/Desecrate': 'gain-curse',
    '3/Mysterious Sphere/Open Sphere': 'apply-vulnerable,combat',
    '3/Mysterious Sphere/Charge In': 'mode-shift,combat',
  })
})

check('official TTS deck GUIDs, CustomDeck ids, FaceURLs, and CardIDs match the save', () => {
  if (!save) return
  for (const source of DOWNFALL_EVENT_DECK_SOURCES) {
    const deck = objects.find((object) => object.GUID === source.deck_guid)
    assert(deck, source.deck_guid)
    assert.deepEqual(deck.DeckIDs, source.card_ids, source.deck_guid)
    assert.equal(deck.CustomDeck[source.sheet_id].FaceURL, source.face_url, source.deck_guid)
    assert.equal(deck.CustomDeck[source.sheet_id].NumWidth, 10, source.deck_guid)
    assert.equal(deck.CustomDeck[source.sheet_id].NumHeight, 7, source.deck_guid)
    assert.deepEqual(source.occupied_indices, source.card_ids.map((cardId) => cardId % 100), source.deck_guid)
    assert.equal(source.expected_count, source.card_ids.length, source.deck_guid)
  }
})

check('all 17 physical cards retain unique GUID/CardID/index metadata', () => {
  assert.equal(DOWNFALL_PHYSICAL_EVENT_CARDS.length, 17)
  assert.equal(new Set(DOWNFALL_PHYSICAL_EVENT_CARDS.map((card) => card.id)).size, 17)
  assert.equal(new Set(DOWNFALL_PHYSICAL_EVENT_CARDS.map((card) => card.card_guid)).size, 17)
  assert.equal(new Set(DOWNFALL_PHYSICAL_EVENT_CARDS.map((card) => card.card_id)).size, 17)
  for (const physical of DOWNFALL_PHYSICAL_EVENT_CARDS) {
    assert.equal(physical.index, physical.card_id % 100, physical.id)
    if (save) {
      const card = objects.find((object) => object.GUID === physical.card_guid)
      assert(card, physical.card_guid)
      assert.equal(card.CardID, physical.card_id, physical.card_guid)
    }
    assert.equal(physical.deck_guid,
      DOWNFALL_EVENT_DECK_SOURCES.find((deck) => deck.act === physical.act).deck_guid, physical.card_guid)
    assert.equal(downfallEventByCardId(physical.card_id).id, physical.eventId)
  }
})

check('physical Act decks are complete and use every occupied cell once', () => {
  const expected = { 1: 7, 2: 6, 3: 4 }
  for (const [actText, count] of Object.entries(expected)) {
    const act = Number(actText)
    const cards = DOWNFALL_PHYSICAL_EVENT_CARDS.filter((card) => card.act === act)
    assert.equal(cards.length, count)
    assert.deepEqual(DOWNFALL_EVENT_DECKS[act], cards.map((card) => card.id))
    assert.deepEqual([...cards.map((card) => card.index)].sort((a, b) => a - b),
      Array.from({ length: count }, (_, index) => index))
  }
})

check('Merchant and Encounter routing is derived only from exact printed icons', () => {
  assert.equal(DOWNFALL_EVENTS.filter((event) => event.route === 'merchant').length, 3)
  assert.equal(DOWNFALL_EVENTS.filter((event) => event.route === 'encounter').length, 3)
  assert(DOWNFALL_EVENTS.filter((event) => event.route !== null).every((event) => event.scope === 'automatic'))
  assert.equal(resolveDownfallEventCard(DOWNFALL_EVENTS_BY_ID.downfall_event_act2_the_merchant, false).room, 'merchant')
  assert.equal(resolveDownfallEventCard(DOWNFALL_EVENTS_BY_ID.downfall_event_act3_encounter, false).room, 'encounter')
})

check('Act I first-Event riders redraw before choices or room routing', () => {
  const riderIds = DOWNFALL_EVENTS.filter((event) => event.firstEventRedraw).map((event) => event.id)
  assert.deepEqual(riderIds, [
    'downfall_event_act1_dead_adventurer',
    'downfall_event_act1_the_merchant',
    'downfall_event_act1_encounter',
  ])
  for (const id of riderIds) {
    assert.deepEqual(resolveDownfallEventCard(DOWNFALL_EVENTS_BY_ID[id], true),
      { kind: 'redraw', discard: true, drawAgain: true }, id)
  }
  assert.equal(resolveDownfallEventCard(DOWNFALL_EVENTS_BY_ID.downfall_event_act1_the_merchant, false).room, 'merchant')
  assert.equal(resolveDownfallEventCard(DOWNFALL_EVENTS_BY_ID.downfall_event_act1_dead_adventurer, false).kind, 'choose')
})

check('party-choice cards and per-player cards retain their printed scope', () => {
  assert.equal(DOWNFALL_EVENTS_BY_ID.downfall_event_act1_dead_adventurer.scope, 'party')
  assert.equal(DOWNFALL_EVENTS_BY_ID.downfall_event_act3_mysterious_sphere.scope, 'party')
  assert.equal(DOWNFALL_EVENTS_BY_ID.downfall_event_act1_world_of_goop.scope, 'player')
  const sphere = resolveDownfallEventCard(DOWNFALL_EVENTS_BY_ID.downfall_event_act3_mysterious_sphere, false)
  assert.equal(sphere.kind, 'choose')
  assert.equal(sphere.scope, 'party')
})

check('every icon-only or semantically unnamed source detail remains explicit', () => {
  const ambiguous = DOWNFALL_EVENTS.filter((event) => event.ambiguities.length > 0)
  assert.equal(ambiguous.length, 7)
  assert.equal(ambiguous.flatMap((event) => event.ambiguities).length, 7)
  assert(ambiguous.some((event) => event.title === 'World of Goop' && event.ambiguities[0].includes('visual token')))
  assert(ambiguous.some((event) => event.title === 'Mysterious Sphere' && event.ambiguities[0].includes('icon-only')))
})

check('the grouped manifest completeness audit agrees with the isolated catalog', () => {
  if (!manifest) return
  assert.equal(manifest.completeness_audit.result, 'complete')
  assert.equal(manifest.completeness_audit.grouped_entry_count, DOWNFALL_EVENTS.length)
  assert.equal(manifest.completeness_audit.physical_card_count, DOWNFALL_PHYSICAL_EVENT_CARDS.length)
  for (const source of DOWNFALL_EVENT_DECK_SOURCES) {
    const audit = manifest.completeness_audit[`sheet_${source.sheet_id}`]
    assert.deepEqual(audit.covered_indices, source.occupied_indices)
    assert.deepEqual(audit.missing, [])
    assert.deepEqual(audit.duplicates, [])
  }
})

check('Downfall rulesets append the audited physical cards at Ascension 3+', () => {
  const downfall = buildEventDeck(createRng(147), 1, 13, true, 'downfall')
  const base = buildEventDeck(createRng(147), 1, 13, true, 'base')
  assert.equal(downfall.length, base.length + 7)
  assert.equal(downfall.filter((card) => card.id.startsWith('downfall_event_act1_')).length, 7)
  assert(base.every((card) => !card.id.startsWith('downfall_event_')))
  const lowAscension = buildEventDeck(createRng(147), 1, 0, true, 'downfall')
  const lowAscensionBase = buildEventDeck(createRng(147), 1, 0, true, 'base')
  assert.deepEqual(lowAscension.map(({ id }) => id), lowAscensionBase.map(({ id }) => id))
  const run = createRun(147, [{ id: 'p1', name: 'Guardian', character: 'guardian' }], 3)
  assert.equal(run.meta.ruleset, 'downfall')
  assert.equal(run.eventDeck.filter((card) => card.id.startsWith('downfall_event_act1_')).length, 7)
})

check('Mysterious Sphere effects resolve after opening hands without leaking other hands', () => {
  const run = createRun(147, [
    { id: 'p1', name: 'Guardian', character: 'guardian' },
    { id: 'p2', name: 'Ironclad', character: 'ironclad' },
  ])
  const open = DOWNFALL_EVENTS_BY_ID.downfall_event_act3_mysterious_sphere.options[0]
  const charge = DOWNFALL_EVENTS_BY_ID.downfall_event_act3_mysterious_sphere.options[1]
  const opened = applyEventCombatStartEffects(run.players, open.effects.filter((effect) => effect.combatStart))
  assert.deepEqual(opened.map((player) => player.vulnerable), [1, 1])
  const charged = applyEventCombatStartEffects(run.players, charge.effects.filter((effect) => effect.combatStart))
  assert.equal(charged[0].guardianMode, 'defense')
  assert.equal(charged[1].guardianMode, null)
  assert.equal(open.effects.find((effect) => effect.tag === 'combat').combatReward, 'relic-each-player')
})

console.log(`Downfall event verification passed (${checks.length} checks, ${DOWNFALL_EVENTS.length} grouped entries, ${DOWNFALL_PHYSICAL_EVENT_CARDS.length} physical cards${manifest && save ? ', external TTS audit checked' : ', clean-clone mode'}).`)
