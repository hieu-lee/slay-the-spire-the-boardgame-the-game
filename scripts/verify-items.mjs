import { readFileSync } from 'node:fs'
import { POTIONS, POTION_DECK, RELICS, RELIC_DECK, potionDef, relicDef } from '../src/game/relics.ts'
import { suite, check, assert, assertEqual, assertDeepEqual, report } from './lib/harness.mjs'

suite('physical shared items')

const raw = readFileSync(new URL('../data/raw/items.csv', import.meta.url), 'utf8')
const rows = [...raw.matchAll(/^"(\d+)","([^"]+)","(Relic|Potion)"/gm)].map((match) => ({
  quantity: Number(match[1]),
  name: match[2],
  type: match[3],
}))
const idFor = (name) => name.toLowerCase().replaceAll(/['’]/g, '').replaceAll(/[^a-z0-9]+/g, '_').replaceAll(/^_|_$/g, '')

const costMap = (tiers) => new Map(
  Object.entries(tiers).flatMap(([cost, ids]) => ids.map((id) => [id, Number(cost)])),
)

const relicCosts = costMap({
  4: ['golden_idol'],
  5: ['omamori', 'orichalcum', 'the_boot'],
  6: [
    'akabeko', 'anchor', 'blood_vial', 'calipers', 'gambling_chip', 'happy_flower', 'horn_cleat',
    'ink_bottle', 'lantern', 'mercury_hourglass', 'mutagen', 'ninja_scroll', 'regal_pillow',
    'runic_pyramid', 'ssserpent_head', 'the_abacus', 'the_courier',
  ],
  7: [
    'bag_of_preparation', 'blue_candle', 'charons_ashes', 'dollys_mirror', 'du_vu_doll',
    'golden_eye', 'ice_cream', 'nilrys_codex', 'oddly_smooth_stone', 'red_mask', 'stone_calendar',
    'toolbox', 'vajra', 'whetstone', 'wing_boots',
  ],
  8: [
    'captains_wheel', 'centennial_puzzle', 'duality', 'gremlin_horn', 'meat_on_the_bone',
    'molten_egg', 'peace_pipe', 'pen_nib', 'self_forming_clay', 'strike_dummy', 'sundial',
    'toxic_egg', 'tungsten_rod', 'war_paint',
  ],
  9: ['bird_faced_urn', 'dead_branch', 'necronomicon', 'pocketwatch', 'red_skull'],
  10: ['mummified_hand'],
  11: ['incense_burner'],
})

const potionCosts = costMap({
  2: [
    'ancient_potion', 'attack_potion', 'block_potion', 'energy_potion', 'explosive_potion',
    'fire_potion', 'flex_potion', 'purity_potion', 'skill_potion', 'swift_potion',
    'vulnerable_potion', 'weak_potion',
  ],
  3: [
    'blood_potion', 'cunning_potion', 'distilled_chaos', 'entropic_brew', 'gamblers_brew',
    'fairy_in_a_bottle', 'liquid_memories', 'snecko_oil',
  ],
  4: ['ghost_in_a_jar'],
})

check('the relic deck matches all 58 physical ordinary relic cards', () => {
  const physical = rows.filter((row) => row.type === 'Relic')
  assertEqual(physical.length, 58)
  assertDeepEqual(RELIC_DECK, physical.map((row) => idFor(row.name)))
  assertEqual(new Set(RELIC_DECK).size, 58, 'ordinary relic cards must be unique')

  for (const row of physical) {
    const id = idFor(row.name)
    const def = relicDef(id)
    assertEqual(def.id, id)
    assertEqual(def.name, row.name)
    assertEqual(def.cost, relicCosts.get(id), `${row.name} has the wrong Merchant cost`)
  }
})

check('Old Coin is unpriced and the two corrected relics cost 6 Gold', () => {
  assertEqual(relicCosts.size, 57, 'all relics except Old Coin need a printed price')
  assertEqual(relicDef('old_coin').cost, undefined)
  assertEqual(relicDef('anchor').cost, 6)
  assertEqual(relicDef('akabeko').cost, 6)
})

check('easy-to-miss physical relic text is not replaced with digital behavior', () => {
  assertEqual(relicDef('akabeko').text, 'Once per combat: gain 1 Strength for one Attack.')
  assertDeepEqual(relicDef('akabeko').effects, [])
  assertEqual(relicDef('charons_ashes').text, 'On a 1 or 2: you may Exhaust a card to deal 2 damage.')
  assertEqual(relicDef('dollys_mirror').text, 'On a 1: trigger a die relic ability. Its owner gains the effect.')
  assertEqual(relicDef('ssserpent_head').text, 'At an Event: gain 2 Gold when you enter the room.')
})

check('digital-only Bag of Marbles is absent', () => {
  assert(!RELIC_DECK.includes('bag_of_marbles'))
  assert(!Object.hasOwn(RELICS, 'bag_of_marbles'))
})

check('the potion deck matches all 29 physical cards and their copies', () => {
  const physical = rows.filter((row) => row.type === 'Potion')
  const expectedDeck = physical.flatMap((row) => Array(row.quantity).fill(idFor(row.name)))
  assertEqual(physical.length, 21, 'the physical deck has 21 distinct potion names')
  assertEqual(expectedDeck.length, 29, 'the physical deck has 29 potion cards')
  assertDeepEqual(POTION_DECK, expectedDeck)
  assertEqual(new Set(POTION_DECK).size, 21)
  assertEqual(Object.keys(POTIONS).length, 21, 'the potion catalog should not contain digital-only entries')

  for (const row of physical) {
    const id = idFor(row.name)
    const def = potionDef(id)
    assertEqual(def.id, id)
    assertEqual(def.name, row.name)
    assertEqual(def.cost, potionCosts.get(id), `${row.name} has the wrong Merchant cost`)
    assertEqual(POTION_DECK.filter((entry) => entry === id).length, row.quantity, `${row.name} has the wrong quantity`)
  }
})

check('all 21 physical Potions have a printed Merchant price', () => {
  assertEqual(potionCosts.size, 21)
  assertEqual(potionDef('fairy_in_a_bottle').cost, 3)
  for (const id of POTION_DECK) {
    assert(Number.isInteger(potionDef(id).cost), `${id} needs an integer Merchant cost`)
  }
})

check('Weak Potion uses the physical two-cube value', () => {
  const weak = potionDef('weak_potion')
  assertEqual(weak.text, 'Apply 2 Weak.')
  assertDeepEqual(weak.effects, [{ kind: 'applyWeak', amount: 2 }])
})

report('physical shared items')
