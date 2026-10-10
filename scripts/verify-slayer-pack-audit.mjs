// Pins every Slayer Pack card's printed frame to the scans (docs/slayer-pack.md): type, cost on both
// faces, rarity (gold banner = rare), and the Retain / Exhaust / Ethereal / Unplayable keywords on
// both faces. Effects are exercised by the per-group verify-slayer-*.mjs scripts; this file is the
// independent second transcription that the card definitions are audited against.
import { CARDS, faceOf } from '../src/game/cards.ts'
import { CARD_PACKS, CARD_PACK_IDS, cardPackOf } from '../src/game/packs.ts'
import { cardImagePath, cardThumbPath } from '../src/game/assets.ts'
import { characterRewardDeck, createItemDecks } from '../src/game/acquisition.ts'
import { createCampaignProgress } from '../src/game/campaign.ts'
import { createRng } from '../src/game/rng.ts'
import { suite, check, assert, assertEqual, assertDeepEqual, report } from './lib/harness.mjs'

suite('slayer pack audit')

// [id, owner, type, rarity, base cost, upgraded cost, base keywords, upgraded keywords]
// keywords: R retain, X exhaust, E ethereal, U unplayable
const FRAMES = [
  ['slayer_armaments', 'ironclad', 'skill', 'uncommon', 1, 1, '', ''],
  ['slayer_brutality', 'ironclad', 'power', 'rare', 0, 0, '', ''],
  ['slayer_dropkick', 'ironclad', 'attack', 'uncommon', 1, 1, '', ''],
  ['slayer_dual_wield', 'ironclad', 'skill', 'uncommon', 1, 0, '', ''],
  ['slayer_infernal_blade', 'ironclad', 'power', 'uncommon', 1, 0, '', ''],
  ['slayer_reaper', 'ironclad', 'attack', 'rare', 2, 2, '', ''],
  ['slayer_searing_blow', 'ironclad', 'attack', 'uncommon', 2, 2, '', ''],
  ['slayer_caltrops', 'silent', 'power', 'uncommon', 1, 1, '', ''],
  ['slayer_endless_agony', 'silent', 'attack', 'uncommon', 1, 1, 'E', 'E'],
  ['slayer_eviscerate', 'silent', 'power', 'uncommon', 1, 1, '', ''],
  ['slayer_glass_knife', 'silent', 'attack', 'uncommon', 2, 2, 'R', 'R'],
  ['slayer_heel_hook', 'silent', 'attack', 'uncommon', 1, 1, '', ''],
  ['slayer_nightmare', 'silent', 'skill', 'rare', 1, 1, '', ''],
  ['slayer_phantasmal_killer', 'silent', 'power', 'rare', 1, 1, '', ''],
  ['slayer_aggregate', 'defect', 'skill', 'uncommon', 1, 1, 'X', ''],
  ['slayer_auto_shields', 'defect', 'skill', 'uncommon', 0, 0, '', ''],
  ['slayer_biased_cognition', 'defect', 'power', 'rare', 2, 1, '', ''],
  ['slayer_creative_ai', 'defect', 'power', 'uncommon', 1, 1, '', ''],
  ['slayer_hello_world', 'defect', 'power', 'uncommon', 2, 1, '', ''],
  ['slayer_reboot', 'defect', 'skill', 'rare', 0, 0, 'X', 'RX'],
  ['slayer_rebound', 'defect', 'attack', 'uncommon', 1, 0, '', ''],
  ['slayer_bowling_bash', 'watcher', 'attack', 'uncommon', 1, 1, '', ''],
  ['slayer_deceive_reality', 'watcher', 'skill', 'uncommon', 2, 2, '', ''],
  ['slayer_fasting', 'watcher', 'power', 'uncommon', 2, 1, '', ''],
  ['slayer_master_reality', 'watcher', 'power', 'rare', 1, 1, '', ''],
  ['slayer_pressure_points', 'watcher', 'skill', 'rare', 1, 1, '', ''],
  ['slayer_wave_of_the_hand', 'watcher', 'skill', 'uncommon', 1, 1, '', ''],
  ['slayer_wheel_kick', 'watcher', 'attack', 'uncommon', 1, 1, '', ''],
  ['slayer_bandage_up', 'colorless', 'power', 'uncommon', 0, 0, '', ''],
  ['slayer_bite', 'colorless', 'attack', 'uncommon', 1, 1, 'RX', 'RX'],
  ['slayer_chrysalis', 'colorless', 'power', 'rare', 2, 1, '', ''],
  // The egg (unplayable, no cost) hatches into a cost-1 dragon when upgraded.
  ['slayer_companion', 'colorless', 'power', 'rare', 0, 1, 'U', ''],
  ['slayer_deep_breath', 'colorless', 'skill', 'uncommon', 0, 0, '', ''],
  ['slayer_discovery', 'colorless', 'skill', 'uncommon', 1, 1, 'X', ''],
  ['slayer_enlightenment', 'colorless', 'skill', 'uncommon', 0, 0, 'X', ''],
  ['slayer_forethought', 'colorless', 'skill', 'uncommon', 0, 0, 'X', 'X'],
  ['slayer_jack_of_all_trades', 'colorless', 'skill', 'uncommon', 0, 0, 'X', 'X'],
  ['slayer_magnetism', 'colorless', 'power', 'rare', 1, 1, '', ''],
  ['slayer_metamorphosis', 'colorless', 'power', 'rare', 'X', 'X', '', ''],
  ['slayer_panic_button', 'colorless', 'power', 'uncommon', 0, 0, 'R', 'R'],
  ['slayer_ritual_dagger', 'colorless', 'attack', 'uncommon', 1, 1, 'RX', 'RX'],
  ['slayer_secret_technique', 'colorless', 'skill', 'rare', 1, 0, 'X', 'X'],
  ['slayer_smite', 'colorless', 'attack', 'rare', 1, 1, '', ''],
  ['slayer_transmutation', 'colorless', 'skill', 'rare', 'X', 'X', 'X', 'X'],
  ['slayer_violence', 'colorless', 'skill', 'rare', 2, 2, 'X', ''],
]
const KEYWORDS = { R: 'retain', X: 'exhaust', E: 'ethereal', U: 'unplayable' }
const keywordsOf = (face) => Object.entries(KEYWORDS).filter(([, key]) => face[key] === true).map(([letter]) => letter).join('')
const sorted = (letters) => [...letters].sort().join('')

check('the pack list is exactly the 45 audited cards: 28 character cards and 17 Colorless', () => {
  assertEqual(FRAMES.length, 45)
  assertDeepEqual(Object.values(CARDS).filter((def) => def.pack).map((def) => def.id).sort(), FRAMES.map(([id]) => id).sort())
  assertEqual(FRAMES.filter(([, owner]) => owner !== 'colorless').length, 28)
  assertEqual(FRAMES.filter(([, owner]) => owner === 'colorless').length, 17)
  for (const owner of ['ironclad', 'silent', 'defect', 'watcher']) assertEqual(FRAMES.filter(([, o]) => o === owner).length, 7, owner)
})

check('five packs list exactly their cards', () => {
  assertDeepEqual([...CARD_PACK_IDS], ['slayer_ironclad', 'slayer_silent', 'slayer_defect', 'slayer_watcher', 'slayer_colorless'])
  for (const id of CARD_PACK_IDS) {
    const owner = CARD_PACKS[id].owner
    assertDeepEqual([...CARD_PACKS[id].cardIds].sort(), FRAMES.filter(([, o]) => o === owner).map(([cardId]) => cardId).sort(), id)
    for (const cardId of CARD_PACKS[id].cardIds) assertEqual(cardPackOf(cardId), id)
  }
})

check('every card frame matches its scan on both faces', () => {
  for (const [id, owner, type, rarity, baseCost, upgradedCost, baseKeywords, upgradedKeywords] of FRAMES) {
    const def = CARDS[id]
    assert(def, `${id} is defined`)
    assertEqual(def.owner, owner, `${id} owner`)
    assertEqual(def.type, type, `${id} type`)
    assertEqual(def.rarity, rarity, `${id} rarity`)
    assertEqual(def.pack, CARD_PACK_IDS.find((pack) => CARD_PACKS[pack].owner === owner), `${id} pack`)
    assert(def.upgrade, `${id} has an upgraded face`)
    const base = faceOf(def, false)
    const upgraded = faceOf(def, true)
    assertEqual(base.cost, baseCost, `${id} base cost`)
    assertEqual(upgraded.cost, upgradedCost, `${id}+ cost`)
    assertEqual(sorted(keywordsOf(base)), sorted(baseKeywords), `${id} base keywords`)
    assertEqual(sorted(keywordsOf(upgraded)), sorted(upgradedKeywords), `${id}+ keywords`)
    assertEqual(upgraded.name, `${def.name}+`, `${id} upgraded name`)
  }
})

check('ids are unique, prefixed, and never collide with another card or name-keyed asset', () => {
  const names = new Map()
  for (const def of Object.values(CARDS)) if (!def.pack) names.set(def.name.toLowerCase(), def.id)
  for (const [id] of FRAMES) assert(id.startsWith('slayer_') && /^[a-z0-9_]+$/.test(id), id)
  for (const [id] of FRAMES) {
    const def = CARDS[id]
    for (const upgraded of [false, true]) {
      const path = cardImagePath(faceOf(def, upgraded), upgraded)
      assert(path.includes(`/slayer__${def.owner}__`), `${path} is filed under the pack, never under a same-named base card`)
      assert(cardThumbPath(faceOf(def, upgraded), upgraded).includes('/slayer__'), `${id} thumbnail`)
    }
  }
})

check('every Slayer Power declares how it resolves', () => {
  for (const def of Object.values(CARDS).filter((card) => card.pack && card.type === 'power')) {
    for (const upgraded of [false, true]) {
      const face = faceOf(def, upgraded)
      if (face.unplayable) continue
      const persistent = face.persistent === true || face.corruptSkills === true || face.retainBlock === true
      assert([face.trigger !== undefined, face.resolvesOnPlay === true, face.activeAbility === true, persistent, (face.additionalTriggers?.length ?? 0) > 0].some(Boolean),
        `${face.id}${upgraded ? '+' : ''} must trigger later, activate during the turn, resolve when played, or be persistent`)
    }
  }
})

check('no Slayer card is in any reward deck unless its pack is enabled', () => {
  const progress = createCampaignProgress()
  const slayerIds = new Set(FRAMES.map(([id]) => id))
  for (const character of ['ironclad', 'silent', 'defect', 'watcher']) {
    for (const rare of [false, true]) {
      assert(!characterRewardDeck(character, rare, progress).some((id) => slayerIds.has(id)), `${character} ${rare} default`)
    }
  }
  const off = createItemDecks(createRng(5), true, progress, ['ironclad'])
  const all = Object.values(off.characterCards).flat().concat(Object.values(off.characterRares).flat(), off.colorless)
  assert(!all.some((id) => slayerIds.has(id)), 'default item decks hold no Slayer card')
  const on = createItemDecks(createRng(5), true, progress, [], undefined, [...CARD_PACK_IDS])
  assertDeepEqual(on.colorless.filter((id) => slayerIds.has(id)).sort(), CARD_PACKS.slayer_colorless.cardIds.slice().sort(), 'colorless pack joins the supply')
  // Gold banner (orange backdrop) = rare deck, blue = uncommon: two rares per character.
  for (const owner of ['ironclad', 'silent', 'defect', 'watcher']) {
    const cardsOf = (rarity) => FRAMES.filter(([, o, , r]) => o === owner && r === rarity).map(([id]) => id).sort()
    assertEqual(cardsOf('rare').length, 2, `${owner} has two rares`)
    assertDeepEqual(on.characterCards[owner].filter((id) => slayerIds.has(id)).sort(), cardsOf('uncommon'), `${owner} pack uncommons`)
    assertDeepEqual(on.characterRares[owner].filter((id) => slayerIds.has(id)).sort(), cardsOf('rare'), `${owner} pack rares`)
  }
})

report('slayer pack audit')
