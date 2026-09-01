import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { CARDS } from '../src/game/cards.ts'
import {
  DOWNFALL_BOSS_RELICS,
  DOWNFALL_BOSS_RELIC_DECK,
  DOWNFALL_COLORLESS_CARDS,
  DOWNFALL_ITEMS_MANIFEST,
  DOWNFALL_POTIONS,
  DOWNFALL_RELICS,
  DOWNFALL_RELIC_DECK,
  HEARTS_BOONS,
  conditionMet,
  downfallRelicBaseId,
  downfallRelicId,
  formatDownfallText,
  heartBoon,
  heartBoonOptionCosts,
  itemId,
  mysteryPotionEffects,
  physicalCardIds,
  resolveDownfallItem,
  whaleAleDrawCount,
} from '../src/game/downfall/items.ts'
import { POTIONS, RELICS } from '../src/game/relics.ts'
import { HEARTS_BOON_CARDS, dealBlessings, formatHeartBoonLabel } from '../src/game/neow.ts'
import { addCard, bottomCardChoices, drawCardChoices } from '../src/game/acquisition.ts'
import { createRng } from '../src/game/rng.ts'
import {
  activatePotion,
  activateRelic,
  beginEndPlayerTurn,
  canActivateRelic,
  chooseEndTurnTarget,
  createCombat,
  endTurnAbilities,
  enemyTurn,
  playCard,
  previewCardChoice,
  resolvePendingDieRelicChoice,
  spendShiv,
} from '../src/game/combat.ts'
import { SPECIAL_POTION_RUNTIME_IDS } from '../src/game/combat/items.ts'
import { triggerSources } from '../src/game/combat/effects.ts'
import { createRun, resolveCombat, resolveNeowEffect, usePotionOutsideCombat } from '../src/game/run.ts'
import { resolveCampfire } from '../src/game/run/campfire.ts'
import { readyForCombat } from '../src/game/run/encounters.ts'
import { acquireRelic, pendingRewardChoices } from '../src/game/run/rewards.ts'
import { merchantItemDecks } from '../src/game/run/supplies.ts'
import { pendingRelicPreview, resolvePendingRelic } from '../src/game/run/relic-acquisition.ts'
import { apply, createRoom, createStore, joinRoom, snapshotFor, startRun } from './lib/rooms.mjs'

const EXPECTED_MANIFEST_SHA256 = 'ebfb62e5342126e94d2cac87ffc1a498dd35718995c9605ce18829829c3116e1'
const manifestHash = createHash('sha256')
  .update(JSON.stringify(DOWNFALL_ITEMS_MANIFEST))
  .digest('hex')
assert.equal(manifestHash, EXPECTED_MANIFEST_SHA256, 'embedded manifest changed from the exact public-v1.47 transcription')

assert.deepEqual(
  DOWNFALL_ITEMS_MANIFEST.sheets.map(({ guid }) => guid),
  ['0f8234', '72a869', '7f7cc9', 'd6b384', '80fcb6', '938861', '5b1766'],
)
assert.deepEqual(
  {
    relics: DOWNFALL_RELICS.length,
    potions: DOWNFALL_POTIONS.length,
    bossRelics: DOWNFALL_BOSS_RELICS.length,
    colorlessCards: DOWNFALL_COLORLESS_CARDS.length,
    heartsBoons: HEARTS_BOONS.length,
  },
  { relics: 75, potions: 34, bossRelics: 27, colorlessCards: 38, heartsBoons: 20 },
)
assert.equal(DOWNFALL_RELICS.reduce((sum, item) => sum + item.multiplicity, 0), 75)
assert.equal(DOWNFALL_POTIONS.reduce((sum, item) => sum + item.multiplicity, 0), 44)
assert.equal(DOWNFALL_BOSS_RELICS.reduce((sum, item) => sum + item.multiplicity, 0), 27)
assert.equal(DOWNFALL_COLORLESS_CARDS.reduce((sum, item) => sum + item.multiplicity, 0), 38)
assert.equal(HEARTS_BOONS.reduce((sum, item) => sum + item.multiplicity, 0), 20)
assert.deepEqual(DOWNFALL_ITEMS_MANIFEST.completenessAudit.totals, {
  physicalFronts: 242,
  manifestRecords: 194,
  unrepresentedPhysicalIndices: 0,
})
assert.equal(formatDownfallText('At ?: Gain 2 gold when you enter the room.'),
  'When you enter an Event room: Gain 2 Gold.')
assert.equal(formatDownfallText('Start of combat: 2 [block].'), 'Start of combat: Gain 2 Block.')
assert.equal(formatDownfallText('[vulnerable] to all players.'), 'Apply 1 Vulnerable to all players.')
assert.equal(formatDownfallText('ALL players gain 2 potions and 3 gold.'),
  'All players gain 2 Potions and 3 Gold.')
assert.equal(formatDownfallText('If you have any [dazed], [burn], [slimed], or Curses in your hand.'),
  'If you have any Dazed, Burn, Slimed, or Curses in your hand.')
assert.equal(formatDownfallText('[mode-shift] to all players.'), 'All players Mode Shift.')
assert.equal(formatDownfallText('Each player reveals one of their [treasure].'),
  'Each player reveals one of their Relics.')
assert.equal(formatDownfallText('Add [treasure] to all combat rewards.'),
  'Add a Relic to all combat rewards.')
assert.equal(formatDownfallText('Your 0 cost Attacks deal +1 damage on each [damage]. (Include X.)'),
  'Your 0 cost Attacks deal +1 damage per damage icon. (Include X.)')
assert.equal(formatDownfallText('1 [damage], 1 [damage], 1 [damage]. Treat each [damage] as a separate 0 cost Attack.'),
  'Deal 1 damage three times. Treat each hit as a separate 0 cost Attack.')

const ids = physicalCardIds()
assert.equal(ids.length, 242)
assert.equal(new Set(ids).size, 242, 'every physical front must have a unique CardID')

for (const item of DOWNFALL_RELICS) {
  const sheet = DOWNFALL_ITEMS_MANIFEST.sheets.find(({ guid }) => guid === item.guid)
  assert.ok(sheet)
  assert.equal(item.cardId, sheet.deckPrefix * 100 + item.index)
  assert.ok(item.name.length > 0 && item.text.length > 0)
}
for (const item of DOWNFALL_POTIONS) {
  assert.equal(item.indices.length, item.multiplicity)
  assert.equal(item.cardIds.length, item.multiplicity)
  assert.deepEqual(item.cardIds, item.indices.map((index) => 466400 + index))
  assert.ok(item.name.length > 0 && item.text.length > 0)
}
for (const item of DOWNFALL_BOSS_RELICS) {
  assert.equal(item.cardId, 467400 + item.index)
  assert.ok(item.name.length > 0 && item.text.length > 0)
}
for (const item of DOWNFALL_COLORLESS_CARDS) {
  assert.equal(item.baseCardId, 467000 + item.index)
  assert.equal(item.upgradeCardId, 468400 + item.index)
  assert.ok(item.name.length > 0 && item.baseText.length > 0 && item.upgradedText.length > 0)
}
for (const [index, boon] of HEARTS_BOONS.entries()) {
  assert.equal(boon.index, index)
  assert.equal(boon.cardId, 438400 + index)
  assert.equal(boon.name, "The Heart's Boon")
  assert.equal(boon.options.length, 3)
  assert.ok(boon.speech.length > 0 && boon.commonText.length > 0)
  assert.ok(boon.options.every((option) => option.length > 0))
}

const representedIndices = new Map(DOWNFALL_ITEMS_MANIFEST.sheets.map(({ guid }) => [guid, []]))
for (const item of DOWNFALL_RELICS) representedIndices.get(item.guid).push(item.index)
for (const item of DOWNFALL_POTIONS) representedIndices.get(item.guid).push(...item.indices)
for (const item of DOWNFALL_BOSS_RELICS) representedIndices.get(item.guid).push(item.index)
for (const item of DOWNFALL_COLORLESS_CARDS) {
  representedIndices.get(item.baseGuid).push(item.index)
  representedIndices.get(item.upgradeGuid).push(item.index)
}
for (const item of HEARTS_BOONS) representedIndices.get(item.guid).push(item.index)
for (const sheet of DOWNFALL_ITEMS_MANIFEST.sheets) {
  const actual = representedIndices.get(sheet.guid).toSorted((a, b) => a - b)
  const expected = Array.from({ length: sheet.physicalCards }, (_, index) => index)
  assert.deepEqual(actual, expected, `${sheet.guid} must represent every occupied sheet index exactly once`)
  const audit = DOWNFALL_ITEMS_MANIFEST.completenessAudit.sheetChecks.find(({ guid }) => guid === sheet.guid)
  assert.ok(audit)
  assert.deepEqual(audit.missing, [])
  assert.deepEqual(audit.extra, [])
  assert.equal(audit.physicalCards, sheet.physicalCards)
}

assert.equal(DOWNFALL_RELICS.find(({ name }) => name === 'Ssserpent Head').text, 'At ?: Gain 2 gold when you enter the room.')
assert.equal(
  DOWNFALL_COLORLESS_CARDS.find(({ name }) => name === 'YOU ARE MINE!').upgradedText,
  '2 [block]. [vulnerable] [vulnerable] [vulnerable] [weak] [weak] [weak]. Exhaust.',
)
assert.deepEqual(heartBoon(0), HEARTS_BOONS[0])
assert.deepEqual(heartBoon(19), HEARTS_BOONS[19])
assert.equal(heartBoon(20), undefined)
assert.equal(HEARTS_BOONS[19].options[2], 'Gain [card-reward]. Look at 5 cards instead of 3. Lose 1 gold and 1 HP.')
assert.ok(HEARTS_BOONS.some(({ options }) => options.some((option) => option.includes('[yellow-card-reward]'))))
assert.ok(HEARTS_BOONS.some(({ options }) => options.some((option) => option.includes('[up-arrow-card-reward]'))))

const registry = { relics: RELICS, potions: POTIONS, cards: CARDS }
const resolveNamed = (collection, name, withRegistry = false) => {
  const item = collection.find((candidate) => candidate.name === name)
  assert.ok(item, `missing ${name}`)
  return resolveDownfallItem(item, withRegistry ? registry : undefined)
}
assert.equal(resolveNamed(DOWNFALL_RELICS, 'Anchor', true).kind, 'existing-relic')
assert.equal(resolveNamed(DOWNFALL_POTIONS, 'Block Potion', true).kind, 'existing-potion')
assert.equal(resolveNamed(DOWNFALL_COLORLESS_CARDS, 'Panache', true).kind, 'existing-card')

assert.deepEqual(resolveNamed(DOWNFALL_RELICS, 'Teleportation Stone'), {
  kind: 'downfall',
  rule: {
    kind: 'abilities',
    abilities: [
      { trigger: { kind: 'dieRelic', faces: [2] }, effects: [{ kind: 'draw', amount: 1 }] },
      { trigger: { kind: 'dieRelic', faces: [3] }, effects: [{ kind: 'block', amount: 2 }] },
    ],
  },
})
assert.deepEqual(resolveNamed(DOWNFALL_RELICS, 'Fuel Canister').rule.abilities[0], {
  trigger: { kind: 'dieRelic', faces: [1, 2] },
  optional: true,
  effects: [{ kind: 'exhaustFromHand', amount: 1 }, { kind: 'gainEnergy', amount: 1 }],
})
assert.deepEqual(resolveNamed(DOWNFALL_RELICS, 'Snecko Egg').rule.trigger, { kind: 'dieRelic', faces: [1, 6] })
assert.deepEqual(resolveNamed(DOWNFALL_BOSS_RELICS, 'Dented Plate').rule.abilities[0], {
  trigger: { kind: 'startOfTurn' },
  condition: { kind: 'hpAtLeast', amount: 5 },
  effects: [{ kind: 'gainEnergy', amount: 1 }],
})
assert.deepEqual(resolveNamed(DOWNFALL_BOSS_RELICS, 'Chronometer').rule.trigger, { kind: 'startOfTurn' })
assert.deepEqual(resolveNamed(DOWNFALL_RELICS, 'Greed Ooze').rule.abilities[0].effects, [{
  kind: 'damage', amount: { base: 2, bonus: { plus: 5, when: { kind: 'goldAtLeast', amount: 7 } } },
}])

assert.deepEqual(mysteryPotionEffects(1), [{ kind: 'damage', amount: 4 }])
assert.deepEqual(mysteryPotionEffects(2), [{ kind: 'damage', amount: 4 }])
assert.deepEqual(mysteryPotionEffects(3), [{ kind: 'draw', amount: 3 }])
assert.deepEqual(mysteryPotionEffects(4), [{ kind: 'draw', amount: 3 }])
assert.deepEqual(mysteryPotionEffects(5), [{ kind: 'gainEnergy', amount: 2 }])
assert.deepEqual(mysteryPotionEffects(6), [{ kind: 'gainEnergy', amount: 2 }])
assert.deepEqual(mysteryPotionEffects(0), [])
assert.deepEqual(mysteryPotionEffects(2.5), [])
assert.equal(whaleAleDrawCount(0), 0)
assert.equal(whaleAleDrawCount(1), 4)
assert.equal(whaleAleDrawCount(2), 2)
assert.equal(whaleAleDrawCount(4), 2)

const conditionState = {
  hp: 5,
  attacksPlayedThisTurn: 3,
  exhaustCount: 2,
  handSize: 1,
  handHasStatusOrCurse: true,
}
assert.equal(conditionMet({ kind: 'hpAtLeast', amount: 5 }, conditionState), true)
assert.equal(conditionMet({ kind: 'hpAtLeast', amount: 6 }, conditionState), false)
assert.equal(conditionMet({ kind: 'attacksPlayedAtLeast', amount: 3 }, conditionState), true)
assert.equal(conditionMet({ kind: 'cardsInExhaustAtLeast', amount: 3 }, conditionState), false)
assert.equal(conditionMet({ kind: 'cardsInHandAtMost', amount: 1 }, conditionState), true)
assert.equal(conditionMet({ kind: 'handHasStatusOrCurse' }, conditionState), true)

assert.deepEqual(heartBoonOptionCosts('Gain 11 gold. Lose 2 max HP.'), { hp: 0, maxHp: 2, gold: 0, curse: false })
assert.deepEqual(heartBoonOptionCosts('Gain [yellow-card-reward]. Gain a Curse.'), { hp: 0, maxHp: 0, gold: 0, curse: true })
assert.deepEqual(heartBoonOptionCosts('Gain [card-reward]. Lose 1 gold and 1 HP.'), { hp: 1, maxHp: 0, gold: 1, curse: false })
assert.equal(itemId("Dolly's Mirror"), 'dollys_mirror')

const variantIds = {
  'Ninja Scroll': 'downfall_ninja_scroll',
  Vajra: 'downfall_vajra',
  "Nilry's Codex": 'downfall_nilrys_codex',
  Duality: 'downfall_duality',
  'Happy Flower': 'downfall_happy_flower',
  'Ink Bottle': 'downfall_ink_bottle',
  'The Boot': 'downfall_the_boot',
  Enchiridion: 'downfall_enchiridion',
  'Snecko Eye': 'downfall_snecko_eye',
  'Wrist Blade': 'downfall_wrist_blade',
}
for (const [name, id] of Object.entries(variantIds)) {
  assert.equal(downfallRelicId(name), id)
  assert.equal(downfallRelicBaseId(id), itemId(name))
  assert.equal(resolveNamed(name === 'Enchiridion' || name === 'Snecko Eye' || name === 'Wrist Blade'
    ? DOWNFALL_BOSS_RELICS : DOWNFALL_RELICS, name, true).kind, 'downfall')
  assert.equal(RELICS[id].text, formatDownfallText([...DOWNFALL_RELICS, ...DOWNFALL_BOSS_RELICS].find((item) => item.name === name).text))
  assert.equal(RELICS[id].cost, RELICS[itemId(name)].cost, `${name} keeps its physical merchant price`)
}
assert.ok(Object.values(variantIds).slice(0, 7).every((id) => DOWNFALL_RELIC_DECK.includes(id)))
assert.ok(Object.values(variantIds).slice(7).every((id) => DOWNFALL_BOSS_RELIC_DECK.includes(id)))
assert.deepEqual(RELICS.vajra.trigger, { kind: 'dieRelic', faces: [2] })
assert.deepEqual(RELICS.downfall_vajra.trigger, { kind: 'dieRelic', faces: [1] })
assert.deepEqual(RELICS.happy_flower.trigger, { kind: 'dieRelic', faces: [3, 4] })
assert.deepEqual(RELICS.downfall_happy_flower.trigger, { kind: 'dieRelic', faces: [2, 3] })
assert.deepEqual(RELICS.ink_bottle.trigger, { kind: 'dieRelic', faces: [5, 6] })
assert.deepEqual(RELICS.downfall_ink_bottle.trigger, { kind: 'dieRelic', faces: [6] })
assert.deepEqual(RELICS.the_boot.trigger, { kind: 'dieRelic', faces: [4, 5, 6] })
assert.deepEqual(RELICS.downfall_the_boot.trigger, { kind: 'dieRelic', faces: [1, 2, 3] })

const serpent = resolveNamed(DOWNFALL_RELICS, 'Ssserpent Head')
assert.deepEqual(serpent, { kind: 'downfall', rule: { kind: 'roomEntryGold', room: 'event', amount: 2 } })

const everyItem = [
  ...DOWNFALL_RELICS,
  ...DOWNFALL_POTIONS,
  ...DOWNFALL_BOSS_RELICS,
  ...DOWNFALL_COLORLESS_CARDS,
  ...HEARTS_BOONS,
]
for (const item of everyItem) {
  const resolved = resolveDownfallItem(item, registry)
  assert.ok(['existing-relic', 'existing-potion', 'existing-card', 'downfall'].includes(resolved.kind),
    `${item.name} did not resolve to an executable item`)
  if (resolved.kind === 'downfall') assert.notEqual(resolved.rule.kind, 'printed', `${item.name} retained a printed fallback`)
}
assert.equal(everyItem.length, 194, 'the executable audit must visit every manifest record')

const sourceUnknownPotionIds = DOWNFALL_POTIONS
  .map(({ name }) => itemId(name))
  .filter((id) => POTIONS[id]?.cost === undefined)
assert.deepEqual(sourceUnknownPotionIds, [
  'transforming_brew', 'energy_drink', 'mystery_potion', 'pizzaz_potion', 'greed_potion',
  'liquid_void', 'fruit_juice', 'clever_concoction', 'destiny_draught', 'cultist_potion',
  'bottle_of_nails', 'cactus_juice', 'whale_ale',
], 'prototype Potion faces without a printed price stay explicitly source-unknown')
for (const id of sourceUnknownPotionIds) {
  assert.ok(POTIONS[id].effects.length > 0 || SPECIAL_POTION_RUNTIME_IDS.has(id),
    `${id} is registered without a generic Effect or a native runtime dispatcher`)
}
assert(Object.values(RELICS).every(({ text, rule }) => !/\[[a-z][^\]]*\]/.test(`${text} ${rule ?? ''}`)),
  'registered relic prose must not expose icon transcription tokens')
assert(Object.values(POTIONS).every(({ text }) => !/\[[a-z][^\]]*\]/.test(text)),
  'registered potion prose must not expose icon transcription tokens')
assert.equal(SPECIAL_POTION_RUNTIME_IDS.size, 8, 'all eight non-generic prototype Potions have native dispatch')

assert.equal(HEARTS_BOON_CARDS.length, 20)
assert.equal(HEARTS_BOON_CARDS.filter((card) => !card.unlocked).length, 14)
assert.equal(HEARTS_BOON_CARDS.filter((card) => card.unlocked).length, 6)
for (const [index, card] of HEARTS_BOON_CARDS.entries()) {
  assert.equal(card.id, `heart_boon_${String(index).padStart(2, '0')}`)
  assert.equal(card.source, 'heart')
  assert.deepEqual(card.options.map(({ label }) => label), HEARTS_BOONS[index].options.map(formatHeartBoonLabel))
  assert.ok(card.options.every(({ effects }) => effects.length > 0), `${card.id} has an unresolved option`)
}
assert(HEARTS_BOON_CARDS.every((card) => card.options.every(({ label }) => !/\[[a-z][^\]]*\]/.test(label))),
  'Heart Boon labels must not expose icon transcription tokens')
const mixedDeal = dealBlessings(createRng(47), [
  { id: 'base', character: 'ironclad' }, { id: 'downfall', character: 'guardian' },
], false, 'downfall')
assert.match(mixedDeal.dealt.base, /^heart_boon_/)
assert.match(mixedDeal.dealt.downfall, /^heart_boon_/)
assert.equal(mixedDeal.deck.length, 0)
assert.equal(mixedDeal.heartDeck.length, 12)

let integration = createRun(91, [
  { id: 'base', name: 'Base', character: 'ironclad' },
  { id: 'downfall', name: 'Downfall', character: 'guardian' },
])
assert.equal(integration.meta.ruleset, 'downfall')
assert.match(integration.neow.players.base.cardId, /^heart_boon_/)
assert.match(integration.neow.players.downfall.cardId, /^heart_boon_/)
assert.equal(integration.neow.players.base.redGoldPending, false)
assert.equal(integration.neow.players.base.redRewardsRemaining, 3)
assert.equal(integration.neow.players.downfall.redGoldPending, false)
assert.equal(integration.neow.players.downfall.redRewardsRemaining, 3)
const beforePain = integration.players[0]
integration = acquireRelic(integration, 'base', 'mark_of_pain')
const afterPain = integration.players[0]
assert.equal(afterPain.maxHp, beforePain.maxHp - 2)
assert.equal(afterPain.hp, Math.min(beforePain.hp, afterPain.maxHp))
assert.equal(RELICS.mark_of_pain.rule, 'If your HP would go above 6, it becomes 6.')
const basePainBefore = createRun(190, [{ id: 'base', name: 'Base', character: 'ironclad' }])
const basePainAfter = acquireRelic(basePainBefore, 'base', 'mark_of_pain')
assert.equal(basePainAfter.players[0].maxHp, basePainBefore.players[0].maxHp,
  'base Mark of Pain must not use the Downfall max-HP loss')
const painHealed = usePotionOutsideCombat({
  ...integration,
  phase: 'map',
  players: integration.players.map((owner) => owner.id === 'base'
    ? { ...owner, hp: 5, potions: ['blood_potion'] } : owner),
}, 'base', 'blood_potion')
assert.equal(painHealed.players.find(({ id }) => id === 'base').hp, 7,
  'Downfall Mark of Pain must not retain the base-game healing cap')
const merchantPotions = merchantItemDecks(integration, {
  ...integration.itemDecks,
  potions: [...sourceUnknownPotionIds, 'block_potion'],
}).potions
assert.deepEqual(merchantPotions, ['block_potion'], 'unpublished prices cannot silently become merchant prices')

const duplicate = drawCardChoices({ cardRewards: ['anger', 'anger', 'claw', 'bash'], rareRewards: [] }, 3, true)
assert.deepEqual(duplicate.cardsDrawn, ['anger', 'anger', 'claw', 'bash'])
assert.deepEqual(duplicate.choices, ['anger', 'claw', 'bash'])
const duplicateOwner = { ...integration.players[0], cardRewards: ['anger', 'anger', 'claw', 'bash'], rareRewards: [] }
assert.deepEqual(bottomCardChoices(duplicateOwner, duplicate, 0).cardRewards, ['anger', 'claw', 'bash'])
assert.deepEqual(bottomCardChoices(duplicateOwner, duplicate, 1).cardRewards, ['anger', 'anger', 'bash'])
assert.deepEqual(pendingRewardChoices(duplicateOwner, 'tiny_house'), [['anger', 'anger', 'claw']])
assert.deepEqual(pendingRewardChoices(duplicateOwner, 'tiny_house', true), [['anger', 'claw', 'bash']])
assert.deepEqual(pendingRewardChoices({ ...duplicateOwner,
  cardRewards: ['anger', 'anger', 'claw', 'bash', 'flex', 'shrug_it_off', 'pommel_strike', 'cleave',
    'headbutt', 'iron_wave', 'body_slam', 'true_grit', 'twin_strike'],
}, 'orrery', true)[0], ['anger', 'claw', 'bash'])
const legacyDuplicate = { choices: ['anger', 'anger', 'claw'], cardsDrawn: ['anger', 'anger', 'claw'], raresDrawn: [] }
assert.deepEqual(bottomCardChoices(duplicateOwner, legacyDuplicate, 1).cardRewards,
  ['bash', 'anger', 'claw'], 'the second identical visible occurrence is the selected physical card')
assert.deepEqual(bottomCardChoices(duplicateOwner, legacyDuplicate, 2).cardRewards,
  ['bash', 'anger', 'anger'], 'a later ordinary choice cannot be mistaken for a rare index')
const ticketDuplicate = drawCardChoices({ cardRewards: ['anger', 'anger', 'golden_ticket'], rareRewards: ['barricade'] }, 3, true)
assert.deepEqual(ticketDuplicate.choices, ['anger', 'barricade'])
const ticketOwner = { ...duplicateOwner, cardRewards: ticketDuplicate.cardsDrawn, rareRewards: ['barricade'] }
const pickedRare = bottomCardChoices(ticketOwner, ticketDuplicate, 1)
assert.deepEqual(pickedRare.cardRewards, ['anger', 'anger', 'golden_ticket'])
assert.deepEqual(pickedRare.rareRewards, [])

const guardianStrike = integration.players.find(({ id }) => id === 'downfall').deck
  .find(({ defId }) => CARDS[defId]?.rarity === 'starter' && CARDS[defId]?.name === 'Strike')
assert.ok(guardianStrike)
const starterState = {
  ...integration,
  neow: {
    ...integration.neow,
    players: {
      ...integration.neow.players,
      downfall: {
        ...integration.neow.players.downfall,
        pendingEffect: { kind: 'upgrade', count: 1, starter: 'strike' },
      },
    },
  },
}
const starterUpgraded = resolveNeowEffect(starterState, 'downfall', true, { cardUids: [guardianStrike.uid] })
assert.equal(starterUpgraded.players.find(({ id }) => id === 'downfall').deck
  .find(({ uid }) => uid === guardianStrike.uid).upgraded, true,
  "Heart's Boon must match Downfall starter names rather than base card id prefixes")
const guardianCard = Object.values(CARDS).find((card) => card.owner === 'guardian' && card.guardian)
assert.ok(guardianCard)
const shardOwner = addCard(integration.players[0], guardianCard.id, 'c999')
assert.equal(shardOwner.relics.filter((relic) => relic.defId === 'corrupted_shard').length, 1)
const shardCombat = readyForCombat(createRng(92), shardOwner)
assert.equal(shardCombat.chamberSlots, 1)
assert.equal(shardCombat.heat, 1)
assert.equal(shardCombat.guardianMode, null)
assert.equal(readyForCombat(createRng(93), { ...shardOwner, guardianMode: 'defense' }).guardianMode, null,
  'Corrupted Shard reused a foreign Guardian mode from the prior combat')

let itemUid = 0
const card = (defId, upgraded = false) => ({ uid: `item-c${itemUid++}`, defId, upgraded })
const player = (over = {}) => ({
  id: 'p1', name: 'Ironclad', character: 'ironclad', row: 0, hp: 8, maxHp: 10, block: 0,
  energy: 3, deck: [], draw: [], hand: [], discard: [], exhaust: [], powers: [], gold: 0,
  relics: [], potions: [], cardRewards: [], rareRewards: [], strength: 0, vulnerable: 0,
  weak: 0, shivs: 0, miracles: 0, stance: 'neutral', orbs: [null, null, null], dead: false,
  ...over,
})
const enemy = (over = {}) => ({
  uid: 'item-e1', defId: 'cultist', row: 0, isBoss: false, hp: 50, maxHp: 50, block: 0,
  strength: 0, vulnerable: 0, weak: 0, poison: 0, actionIndex: 0, abilityUsed: false, dead: false,
  ...over,
})
const combat = (owner, enemies = [enemy()]) => createCombat(createRng(147), [owner], enemies)

{
  for (const [withOther, expectedBlock] of [[false, 0], [true, 1]]) {
    const jack = card('jack_of_all_trades')
    let state = combat(player({ hand: [jack, ...(withOther ? [card('strike_ironclad')] : [])] }))
    state = playCard(state, 'p1', jack.uid, { enemyUid: 'item-e1', playerId: 'p1' })
    assert.equal(state.players[0].block, expectedBlock,
      'Jack of All Trades counted its resolving host as another Attack')
  }
}

{
  const healthy = player({ hp: 5, relics: [{ defId: 'dented_plate', spent: false }] })
  const injured = player({ hp: 4, relics: [{ defId: 'dented_plate', spent: false }] })
  assert.equal(triggerSources(healthy, { kind: 'startOfTurn' }).length, 1)
  assert.equal(triggerSources(injured, { kind: 'startOfTurn' }).length, 0,
    'Dented Plate is suppressed below its printed HP threshold')
  assert.deepEqual(triggerSources(player({ relics: [{ defId: 'snecko_egg', spent: false }] }),
    { kind: 'dieRelic', die: 1 })[0].effects, [{ kind: 'setNextCardCost', amount: 1 }])
  assert.deepEqual(triggerSources(player({ relics: [{ defId: 'chronometer', spent: false }] }),
    { kind: 'startOfTurn' })[0].effects, [{ kind: 'setNextCardCost', amount: 1 }])
  assert.deepEqual(triggerSources(player({ relics: [{ defId: 'downfall_snecko_eye', spent: false }] }),
    { kind: 'dieRelic', die: 5 })[0].effects, [{ kind: 'addDaze', amount: 1, pile: 'discard' }])
  const bossCombat = combat(player({ hp: 4, relics: [{ defId: 'pantograph', spent: false }] }),
    [enemy({ isBoss: true })])
  assert.equal(bossCombat.players[0].hp, 8, 'Pantograph heals only on boss combat creation')
}

{
  const power = card('hermit_overwhelming_power')
  let state = combat(player({
    relics: [{ defId: 'downfall_ninja_scroll', spent: false }], powers: [power],
    draw: [card('hermit_defend'), card('hermit_defend')],
  }))
  state = activateRelic(state, 'p1', 0, { shivEnemyUids: ['item-e1', 'item-e1', 'item-e1'] })
  assert.equal(state.enemies[0].hp, 47)
  assert.equal(state.players[0].attacksPlayedThisTurn, 3)
  assert.equal(state.players[0].relics[0].spent, true)
  assert.equal(state.players[0].hand.length, 2, 'Ninja Scroll triggered Overwhelming Power on its second Attack')

  let lethal = combat(player({
    powers: [power], shivs: 1, attacksPlayedThisTurn: 1,
    draw: [card('hermit_defend'), card('hermit_defend')],
  }), [enemy({ hp: 1, maxHp: 1 })])
  lethal = spendShiv(lethal, 'p1', 'item-e1')
  assert.equal(lethal.enemies[0].dead, true)
  assert.equal(lethal.players[0].hand.length, 0,
    'a lethal Shiv fired Overwhelming Power after combat ended')

  const base = activateRelic(combat(player({ relics: [{ defId: 'ninja_scroll', spent: false }] })), 'p1', 0)
  assert.equal(base.players[0].shivs, 2, 'base Ninja Scroll keeps its two-Shiv printing')
}

{
  let state = combat(player({ relics: [
    { defId: 'downfall_nilrys_codex', spent: false },
    { defId: 'downfall_duality', spent: false },
  ] }))
  state.phase = 'start'
  state.die = 2
  assert.equal(canActivateRelic(state, state.players[0], 0), true)
  state = activateRelic(state, 'p1', 0, {
    targetRelicPlayerId: 'p1', targetRelicIndex: 1, targetAbilityIndex: 1, enemyUid: 'item-e1',
  })
  assert.equal(state.enemies[0].hp, 48)
  assert.equal(state.players[0].relics[0].spent, true)

  const base = combat(player({ relics: [
    { defId: 'nilrys_codex', spent: false }, { defId: 'duality', spent: false },
  ] }))
  base.phase = 'start'
  base.die = 2
  assert.equal(canActivateRelic(base, base.players[0], 0), false,
    'base Nilry\'s Codex retains its die-4 activation')
}

{
  const old = card('strike_ironclad')
  let state = combat(player({ hand: [old], deck: [old], cardRewards: ['anger'], potions: ['transforming_brew'] }))
  state = activatePotion(state, 'p1', 'transforming_brew', { transformHandUid: old.uid })
  assert.equal(state.players[0].potions.length, 0)
  assert.equal(state.players[0].hand[0].defId, 'anger')
  assert.equal(state.players[0].deck[0].defId, 'anger', 'Transforming Brew persists its in-hand replacement in the run deck')

  const curse = card('hermit_scorn')
  const valid = card('strike_ironclad')
  state = combat(player({ hand: [curse, valid], deck: [curse, valid], cardRewards: ['anger'], potions: ['transforming_brew'] }))
  assert.equal(activatePotion(state, 'p1', 'transforming_brew', { transformHandUid: curse.uid }), state,
    'Transforming Brew must reject a Hermit Curse')
}
{
  const base = createRun(193, [{ id: 'p1', name: 'Guardian', character: 'guardian' }])
  const owner = { ...base.players[0], hp: 7, maxHp: 8, potions: ['fruit_juice'] }
  let fight = combat(owner, [enemy({ hp: 0, dead: true })])
  fight = activatePotion(fight, 'p1', 'fruit_juice')
  fight.players[0].lootChests = 1
  fight.phase = 'won'
  const resolved = resolveCombat({ ...base, phase: 'combat', players: [owner], combat: fight })
  assert.equal(resolved.players[0].maxHp, 9, 'Fruit Juice max HP persists after combat')
  assert.equal(resolved.players[0].lootChests, 1, 'Plundered Loot Chests persist after combat')
}
{
  let state = combat(player({ potions: ['mystery_potion'] }))
  state.die = 1
  state = activatePotion(state, 'p1', 'mystery_potion', { enemyUid: 'item-e1' })
  assert.equal(state.enemies[0].hp, 46)
  const draw = [card('strike_ironclad'), card('defend_ironclad'), card('bash')]
  state = combat(player({ draw, potions: ['mystery_potion'] }))
  state.die = 3
  state = activatePotion(state, 'p1', 'mystery_potion')
  assert.equal(state.players[0].hand.length, 3)
  state = combat(player({ energy: 2, potions: ['mystery_potion'] }))
  state.die = 6
  state = activatePotion(state, 'p1', 'mystery_potion')
  assert.equal(state.players[0].energy, 4)
}
{
  const strike = card('strike_ironclad')
  let state = combat(player({ hand: [strike], energy: 3, strength: 1, potions: ['pizzaz_potion'] }))
  state = activatePotion(state, 'p1', 'pizzaz_potion')
  assert.equal(state.players[0].strength, 3)
  state = playCard(state, 'p1', strike.uid, { enemyUid: 'item-e1', playerId: 'p1' })
  assert.equal(state.players[0].strength, 1, 'Pizzaz expires after exactly the next Attack instance')
  assert.equal(state.players[0].nextAttackStrength, 0)
}
{
  let state = combat(player({ gold: 7, potions: ['greed_potion'] }))
  state = activatePotion(state, 'p1', 'greed_potion', { enemyUid: 'item-e1' })
  assert.equal(state.enemies[0].hp, 43)
}
{
  const exhausted = card('bash')
  let state = combat(player({ exhaust: [exhausted], potions: ['liquid_void'] }))
  state = activatePotion(state, 'p1', 'liquid_void', { recoverExhaustUid: exhausted.uid })
  assert.equal(state.players[0].exhaust.length, 0)
  assert.equal(state.players[0].hand[0].freeThisTurn, true)
}
{
  let state = combat(player({ hp: 8, maxHp: 9, potions: ['fruit_juice'] }))
  state = activatePotion(state, 'p1', 'fruit_juice')
  assert.deepEqual([state.players[0].hp, state.players[0].maxHp], [9, 10])
}
{
  const draw = card('strike_ironclad')
  let state = combat(player({ draw: [draw], relics: [{ defId: 'teleportation_stone', spent: false }], potions: ['destiny_draught'] }))
  state = activatePotion(state, 'p1', 'destiny_draught', {
    targetRelicPlayerId: 'p1', targetRelicIndex: 0, targetAbilityIndex: 0,
  })
  assert.equal(state.players[0].hand[0].uid, draw.uid)
}
{
  const fodder = [card('strike_ironclad'), card('defend_ironclad')]
  let state = combat(player({ hand: fodder, relics: [{ defId: 'wheel_of_change', spent: false }],
    potions: ['destiny_draught'] }))
  state = activatePotion(state, 'p1', 'destiny_draught', {
    targetRelicPlayerId: 'p1', targetRelicIndex: 0, targetAbilityIndex: 0,
  })
  assert.equal(state.pendingDieRelicChoices?.[0]?.playerId, 'p1')
  assert.equal(state.players[0].potions.length, 0, 'Destiny Draught is consumed before its owner finishes Wheel of Change')
  state = resolvePendingDieRelicChoice(state, 'p1', { discardUids: fodder.map(({ uid }) => uid) })
  assert.deepEqual(state.players[0].discard.slice(0, 2).map(({ uid }) => uid), fodder.map(({ uid }) => uid))
}
{
  const fuel = card('strike_ironclad')
  let state = combat(player({ hand: [fuel], relics: [{ defId: 'fuel_canister', spent: false }],
    potions: ['destiny_draught'] }))
  state = activatePotion(state, 'p1', 'destiny_draught', {
    targetRelicPlayerId: 'p1', targetRelicIndex: 0, targetAbilityIndex: 0,
  })
  assert.equal(state.pendingDieRelicChoices?.[0]?.relicDefId, 'fuel_canister')
  state = resolvePendingDieRelicChoice(state, 'p1', { exhaustUids: [fuel.uid] })
  assert.equal(state.players[0].exhaust[0]?.uid, fuel.uid)
  assert.equal(state.players[0].energy, 4)
}
{
  let state = combat(player({ relics: [{ defId: 'fuel_canister', spent: false }],
    potions: ['destiny_draught'] }))
  state = activatePotion(state, 'p1', 'destiny_draught', {
    targetRelicPlayerId: 'p1', targetRelicIndex: 0, targetAbilityIndex: 0,
  })
  state = resolvePendingDieRelicChoice(state, 'p1', { exhaustUids: [] })
  assert.equal(state.players[0].energy, 3, 'declining Fuel Canister granted its optional Energy')
}
{
  let state = createCombat(createRng(148), [
    player({ relics: [{ defId: 'loaded_die', spent: false }] }),
    player({ id: 'p2', name: 'Silent', character: 'silent', relics: [{ defId: 'oddly_smooth_stone', spent: false }] }),
  ], [enemy()])
  state.die = 6
  state.phase = 'start'
  state = activateRelic(state, 'p1', 0, {
    targetRelicPlayerId: 'p2', targetRelicIndex: 0, targetAbilityIndex: 0, targetPlayerId: 'p2',
  })
  assert.equal(state.players[0].block, 0)
  assert.equal(state.players[1].block, 2, 'rerouted support relic ignored the selected recipient')
}
for (const [sourceRelic, die] of [['dollys_mirror', 1], ['downfall_nilrys_codex', 2], ['loaded_die', 6]]) {
  const fuel = card('strike_ironclad')
  let state = combat(player({ hand: [fuel], relics: [
    { defId: sourceRelic, spent: false }, { defId: 'fuel_canister', spent: false },
  ] }))
  state.die = die
  state.phase = 'start'
  state = activateRelic(state, 'p1', 0, {
    targetRelicPlayerId: 'p1', targetRelicIndex: 1, targetAbilityIndex: 0,
  })
  assert.equal(state.pendingDieRelicChoices?.[0]?.playerId, 'p1', `${sourceRelic} skipped Fuel Canister's private choice`)
  state = resolvePendingDieRelicChoice(state, 'p1', { exhaustUids: [fuel.uid] })
  assert.equal(state.players[0].exhaust[0]?.uid, fuel.uid)
  assert.equal(state.players[0].energy, 4)
}
{
  const fuel = card('strike_ironclad')
  let state = createCombat(createRng(149), [
    player({ potions: ['destiny_draught'] }),
    player({ id: 'p2', name: 'Silent', character: 'silent', row: 1, hand: [fuel],
      relics: [{ defId: 'charons_ashes', spent: false }] }),
  ], [enemy()])
  state = activatePotion(state, 'p1', 'destiny_draught', {
    targetRelicPlayerId: 'p2', targetRelicIndex: 0, targetAbilityIndex: 0, enemyUid: 'item-e1',
  })
  assert.equal(state.pendingDieRelicChoices?.[0]?.playerId, 'p2')
  assert.equal(resolvePendingDieRelicChoice(state, 'p1', { exhaustUids: [fuel.uid] }), state,
    'another player paid for Charon\'s Ashes')
  state = resolvePendingDieRelicChoice(state, 'p2', { exhaustUids: [fuel.uid] })
  assert.equal(state.players[1].exhaust[0]?.uid, fuel.uid)
  assert.equal(state.enemies[0].hp, 48)
}
{
  const statuses = [card('daze'), card('slimed'), card('burn')]
  const replacement = [card('strike_ironclad'), card('defend_ironclad'), card('bash')]
  let state = combat(player({ hand: statuses, draw: replacement, potions: ['cactus_juice'] }))
  state = activatePotion(state, 'p1', 'cactus_juice')
  assert.equal(state.players[0].exhaust.length, 3)
  assert.equal(state.players[0].hand.length, 3)
}

for (const [id, eligible, ineligible] of [
  ['makeshift_battery', { hand: [card('daze')] }, { hand: [card('strike_ironclad')] }],
  ['unceasing_top', { hand: [card('strike_ironclad')] }, { hand: [card('strike_ironclad'), card('defend_ironclad')] }],
  ['the_broken_seal', { exhaust: [card('strike_ironclad'), card('defend_ironclad')] }, { exhaust: [card('strike_ironclad')] }],
  ['shuriken', { attacksPlayedThisTurn: 3 }, { attacksPlayedThisTurn: 2 }],
]) {
  const yes = combat(player({ relics: [{ defId: id, spent: false }], ...eligible }))
  const no = combat(player({ relics: [{ defId: id, spent: false }], ...ineligible }))
  Object.assign(yes.players[0], eligible)
  Object.assign(no.players[0], ineligible)
  assert.equal(canActivateRelic(yes, yes.players[0], 0), true, `${id} accepts its printed condition`)
  assert.equal(canActivateRelic(no, no.players[0], 0), false, `${id} rejects its unmet condition`)
  assert.notEqual(activateRelic(yes, 'p1', 0), yes, `${id} has an executable activation hook`)
}

{
  const state = combat(player({
    relics: [{ defId: 'makeshift_battery', spent: false }], hand: [card('hermit_grudge')],
  }))
  assert.equal(canActivateRelic(state, state.players[0], 0), true,
    'Makeshift Battery accepts a Hermit-owned Curse')
}
{
  const fuel = card('strike_ironclad')
  let state = combat(player({ hand: [fuel], relics: [{ defId: 'fuel_canister', spent: false }] }))
  state.die = 2
  state.phase = 'start'
  state = activateRelic(state, 'p1', 0, { cardUids: [fuel.uid] })
  assert.equal(state.players[0].energy, 4)
  assert.equal(state.players[0].exhaust[0].uid, fuel.uid)
}
{
  let state = combat(player({ potions: ['block_potion'], relics: [{ defId: 'shot_glass', spent: false }] }))
  state = activateRelic(state, 'p1', 0, { discardPotionId: 'block_potion' })
  assert.equal(state.players[0].strength, 1)
  assert.equal(state.players[0].potions.length, 0)
}
{
  let state = combat(player({ energy: 1, relics: [{ defId: 'thimble_helm', spent: false }] }))
  state = activateRelic(state, 'p1', 0)
  assert.deepEqual([state.players[0].energy, state.players[0].block], [0, 2])

  for (const phase of ['start', 'discard']) {
    const timed = combat(player({ energy: 1, relics: [{ defId: 'thimble_helm', spent: false }] }))
    timed.phase = phase
    timed.startTurnProgress = undefined
    assert.equal(canActivateRelic(timed, timed.players[0], 0), true,
      `manual relic activation was blocked during ${phase}`)
  }

  const postRollOnly = combat(player({ hand: [card('daze')], relics: [{ defId: 'fuel_canister', spent: false }] }))
  postRollOnly.phase = 'discard'
  postRollOnly.die = 2
  assert.equal(canActivateRelic(postRollOnly, postRollOnly.players[0], 0), false,
    'a post-roll-only relic escaped its timing window')
}
{
  const technique = card('secret_technique')
  const skill = card('defend_ironclad')
  const attack = card('strike_ironclad')
  const curse = card('regret')
  let state = combat(player({ hand: [technique], draw: [skill, attack, curse] }))
  assert.equal(previewCardChoice(state, 'p1', technique.uid).kind, 'scryToHand')
  state = playCard(state, 'p1', technique.uid, {
    enemyUid: null, playerId: 'p1', scryToHandUid: skill.uid, scryDiscardUids: [attack.uid],
  })
  assert.equal(state.players[0].hand[0].uid, skill.uid)
  assert.equal(state.players[0].discard[0].uid, attack.uid)
  assert.equal(state.players[0].draw[0].uid, curse.uid)
}
{
  const lastStand = card('last_stand')
  let state = combat(player({ hand: [lastStand], weak: 2, vulnerable: 2 }), [enemy({ defId: 'acid_slime' })])
  state = playCard(state, 'p1', lastStand.uid, { enemyUid: null, playerId: 'p1' })
  state = enemyTurn({ ...state, phase: 'enemy', die: 3 })
  assert.deepEqual([state.players[0].weak, state.players[0].vulnerable], [0, 0])

  const secondLastStand = card('last_stand')
  const strike = card('strike_ironclad')
  state = combat(player({ hand: [secondLastStand, strike], energy: 3 }), [enemy({ defId: 'fungi_beast', hp: 1 })])
  state = playCard(state, 'p1', secondLastStand.uid, { enemyUid: null, playerId: 'p1' })
  state = playCard(state, 'p1', strike.uid, { enemyUid: 'item-e1', playerId: 'p1' })
  assert.equal(state.players[0].vulnerable, 0, 'Last Stand also prevents death-reaction Vulnerable')

  const panic = card('panic_button')
  state = combat(player({ hand: [panic], potions: ['block_potion'] }))
  state = playCard(state, 'p1', panic.uid, { enemyUid: null, playerId: 'p1' })
  assert.equal(state.players[0].block, 5)
  state = activatePotion(state, 'p1', 'block_potion', { targetPlayerId: 'p1' })
  assert.equal(state.players[0].block, 5, 'Panic Button prevents later Block without erasing its on-play Block')
}
{
  const invincible = card('invincible')
  let state = combat(player({ hand: [invincible], energy: 3 }))
  state = playCard(state, 'p1', invincible.uid, { enemyUid: null, playerId: 'p1' })
  const ability = endTurnAbilities(state).find(({ id }) => id.includes(invincible.uid))
  assert.ok(ability)
  const skipped = beginEndPlayerTurn(state, [chooseEndTurnTarget(ability.id, 'skip')])
  assert.equal(skipped.players[0].powers.length, 1)
  assert.equal(skipped.players[0].hpLossLimitThisRound, undefined)
  const used = beginEndPlayerTurn(state, [chooseEndTurnTarget(ability.id, 'use')])
  assert.equal(used.players[0].powers.length, 0)
  assert.equal(used.players[0].exhaust[0].uid, invincible.uid)
  assert.equal(used.players[0].hpLossLimitThisRound, 0)
}

let fruitState = {
  ...integration,
  phase: 'map',
  relicDeck: ['anchor'],
  itemDecks: { ...integration.itemDecks, relics: ['anchor'], curses: ['regret'] },
  players: integration.players.map((owner) => owner.id !== 'base' ? owner : {
    ...owner,
    cardRewards: ['anger', 'anger', 'flex', 'sword_boomerang'],
    rareRewards: ['barricade', 'berserk', 'bludgeon', 'brutality', 'demon_form'],
  }),
}
fruitState = acquireRelic(fruitState, 'base', 'forbidden_fruit')
const fruitPreview = pendingRelicPreview(fruitState, 'base')
assert.deepEqual(fruitPreview.rewardUpgraded, [true, false])
assert.deepEqual(fruitPreview.rewardChoices[0], ['anger', 'flex', 'sword_boomerang'])
fruitState = resolvePendingRelic(fruitState, 'base', [], [0, 0])
const fruitOwner = fruitState.players.find(({ id }) => id === 'base')
assert.ok(fruitOwner.deck.some(({ defId, upgraded }) => defId === 'anger' && upgraded))
assert.ok(fruitOwner.deck.some(({ defId, upgraded }) => defId === 'barricade' && !upgraded))
assert.ok(fruitOwner.deck.some(({ defId }) => defId === 'regret'))
assert.ok(fruitOwner.relics.some(({ defId }) => defId === 'anchor'))
assert.ok(!fruitOwner.relics.some(({ defId }) => defId === 'forbidden_fruit'))
assert.deepEqual(fruitState.relicDeck, fruitState.itemDecks.relics, 'Forbidden Fruit keeps reconnect item supplies mirrored')

let beltState = {
  ...integration,
  phase: 'map',
  potionDeck: ['block_potion', 'energy_potion', ...integration.potionDeck],
  itemDecks: { ...integration.itemDecks, potions: ['block_potion', 'energy_potion', ...integration.potionDeck] },
}
beltState = acquireRelic(beltState, 'base', 'potion_belt')
const beltOwner = beltState.players.find(({ id }) => id === 'base')
assert.deepEqual(beltOwner.potions.slice(-2), ['block_potion', 'energy_potion'])
assert.equal(beltState.potionDeck.length, integration.potionDeck.length)

let bellState = {
  ...integration,
  phase: 'map',
  relicDeck: ['potion_belt', 'anchor', 'happy_flower'],
  potionDeck: ['block_potion', 'energy_potion', ...integration.potionDeck],
  itemDecks: {
    ...integration.itemDecks,
    relics: ['potion_belt', 'anchor', 'happy_flower'],
    potions: ['block_potion', 'energy_potion', ...integration.potionDeck],
    curses: ['regret', ...integration.itemDecks.curses],
  },
}
bellState = acquireRelic(bellState, 'base', 'calling_bell')
const bellOwner = bellState.players.find(({ id }) => id === 'base')
assert.ok(['potion_belt', 'anchor', 'happy_flower'].every((id) => bellOwner.relics.some(({ defId }) => defId === id)),
  'Calling Bell bypassed ordinary relic acquisition')
assert.deepEqual(bellOwner.potions.slice(-2), ['block_potion', 'energy_potion'])
assert.equal(bellState.potionDeck.length, integration.potionDeck.length)
assert.ok(bellOwner.deck.some(({ defId }) => defId === 'regret'))

const razorTarget = integration.players.find(({ id }) => id === 'base').deck.find(({ defId }) => defId !== 'ascenders_bane')
const campfireId = Object.values(integration.map.rooms).find(({ kind }) => kind === 'campfire').id
let razorState = {
  ...integration,
  phase: 'room',
  map: { ...integration.map, position: campfireId },
  players: integration.players.map((owner) => owner.id !== 'base' ? owner : {
    ...owner,
    cardRewards: ['anger'],
    relics: [...owner.relics, { defId: 'straight_razor', spent: false }],
  }),
}
razorState = resolveCampfire(razorState, {
  base: { choice: 'rest', transformCardUid: razorTarget.uid },
  downfall: { choice: 'leave' },
})
const razorOwner = razorState.players.find(({ id }) => id === 'base')
assert.ok(!razorOwner.deck.some(({ uid }) => uid === razorTarget.uid))
assert.ok(razorOwner.deck.some(({ defId }) => defId === 'anger'), 'Straight Razor performs the optional Rest Transform')

const room = createRoom(createStore(), { code: 'ITEMS1' })
const host = joinRoom(room, { name: 'Base', character: 'ironclad' })
const downfall = joinRoom(room, { name: 'Downfall', character: 'guardian' })
startRun(room, host.token, { seed: 93 })
const publicRun = snapshotFor(room, downfall.token).run
assert.equal('deck' in publicRun.neow, false, 'base Blessing deck leaked to a reconnect snapshot')
assert.equal('heartDeck' in publicRun.neow, false, "Heart's Boon deck leaked to a reconnect snapshot")
assert.equal(publicRun.neow.players[downfall.playerId].card.source, 'heart')
for (let remaining = 3; remaining > 0; remaining--) {
  apply(room, downfall.token, { kind: 'neow', stage: 'red', choice: null })
  assert.equal(room.run.neow.players[downfall.playerId].redRewardsRemaining, remaining - 1)
  assert.equal(room.run.neow.players[downfall.playerId].redRewardPending, remaining > 1)
}

const onlineTechnique = card('secret_technique')
const onlineSkill = card('defend_ironclad')
const onlineAttack = card('strike_ironclad')
const onlineCurse = card('regret')
const onlineCombat = createCombat(createRng(148), [
  player({
    id: host.playerId, name: 'Base', hand: [onlineTechnique],
    draw: [onlineSkill, onlineAttack, onlineCurse], potions: ['mystery_potion'],
  }),
  player({ id: downfall.playerId, name: 'Downfall', character: 'guardian', row: 1 }),
], [enemy({ uid: 'online-e1' })])
onlineCombat.die = 1
room.run = { ...room.run, phase: 'combat', combat: onlineCombat }
apply(room, host.token, { kind: 'usePotion', potionId: 'mystery_potion', enemyUid: 'online-e1' })
assert.equal(room.run.combat.enemies[0].hp, 46, 'the room server authoritatively dispatches prototype Potions')
apply(room, host.token, { kind: 'previewCard', cardUid: onlineTechnique.uid, enemyUid: null })
assert.equal(snapshotFor(room, downfall.token).cardPreview, undefined,
  'another player cannot reconnect into a private Scry reveal')
apply(room, host.token, {
  kind: 'playCard', cardUid: onlineTechnique.uid, enemyUid: null, playerId: host.playerId,
  scryToHandUid: onlineSkill.uid, scryDiscardUids: [onlineAttack.uid],
})
const onlineOwner = room.run.combat.players.find(({ id }) => id === host.playerId)
assert.equal(onlineOwner.hand[0].uid, onlineSkill.uid, 'the authoritative server preserves Secret Technique choices')
assert.equal(onlineOwner.discard[0].uid, onlineAttack.uid)
const ownerReconnect = snapshotFor(room, host.token).run.combat.players.find(({ id }) => id === host.playerId)
const peerReconnect = snapshotFor(room, downfall.token).run.combat.players.find(({ id }) => id === host.playerId)
assert.equal(ownerReconnect.hand[0].uid, onlineSkill.uid)
assert.equal(peerReconnect.hand, null, 'reconnect snapshots keep another player\'s selected/revealed cards hidden')
assert.equal(peerReconnect.handCount, 1)

const onlineChargedPreview = card('secret_technique')
const onlineSearchTarget = card('defend_ironclad')
const onlineSpreading = {
  card: card('slime_boss_spreading_slime'), level: 1, vigor: 0,
  commandsThisTurn: 0, vigorLossAtEndOfTurn: 0,
}
room.run = { ...room.run, phase: 'combat', combat: createCombat(createRng(149), [
  player({
    id: host.playerId, name: 'Slime Boss', character: 'slime_boss', hand: [onlineChargedPreview],
    draw: [onlineSearchTarget], energy: 3, nextCardCost: 2, slimes: [onlineSpreading],
  }),
  player({ id: downfall.playerId, name: 'Downfall', character: 'guardian', row: 1 }),
], [enemy({ uid: 'online-spreading-target', hp: 12, maxHp: 12 })]) }
assert.throws(() => apply(room, host.token, {
  kind: 'previewCard', cardUid: onlineChargedPreview.uid, enemyUid: null,
}), /Choose every Slime Command target/, 'online preview ignored Spreading Slime at the card\'s charged cost')
assert.throws(() => apply(room, host.token, {
  kind: 'previewCard', cardUid: onlineChargedPreview.uid, enemyUid: null,
  slimeEnemyUids: { 0: 'online-spreading-target' },
}), /lists of ids/, 'online preview accepted a malformed Slime target list')
apply(room, host.token, {
  kind: 'previewCard', cardUid: onlineChargedPreview.uid, enemyUid: null,
  slimeEnemyUids: ['online-spreading-target'],
})
assert.throws(() => apply(room, host.token, {
  kind: 'playCard', cardUid: onlineChargedPreview.uid, enemyUid: null,
  slimeEnemyUids: [], playerId: host.playerId,
  scryToHandUid: onlineSearchTarget.uid, scryDiscardUids: [],
}), /final Slime choices/, 'the final play changed a target after seeing its private reveal')
apply(room, host.token, {
  kind: 'playCard', cardUid: onlineChargedPreview.uid, enemyUid: null,
  slimeEnemyUids: ['online-spreading-target'],
  playerId: host.playerId, scryToHandUid: onlineSearchTarget.uid, scryDiscardUids: [],
})
assert.equal(room.run.combat.enemies[0].hp, 10,
  'online preview accepted a target that the final paid play then rejected')

console.log('downfall items verification passed')
