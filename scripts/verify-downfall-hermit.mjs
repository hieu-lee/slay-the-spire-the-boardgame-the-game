import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { addCard, characterRewardDeck, merchantCardCost, removeCard, transformCard } from '../src/game/acquisition.ts'
import { cardIsCurse } from '../src/game/cards.ts'
import {
  createCombat,
  enemyTurn,
  endTurnAbilities,
  activatePower,
  abandonCardCopy,
  abandonHermitSetupLoad,
  beginEndPlayerTurn,
  chooseEndTurnTarget,
  canActivatePotion,
  canActivateRelic,
  cardNeedsEnemy,
  mandatoryChoicePending,
  pendingTriggerAbility,
  playCard,
  playCardCopy,
  playHermitChamberCard as playLiveHermitChamberCard,
  previewCardChoice,
  previewCardCopyChoice,
  previewHermitChamberCardChoice,
  previewPowerChoice,
  resolveHermitSetupLoad,
  resolveHermitStrengthReward,
  resolvePendingDieRelicChoice,
  resolvePendingTrigger,
  spendMiracle,
  spendShiv,
  startPlayerTurn,
} from '../src/game/combat.ts'
import { fireTriggers } from '../src/game/combat/effects.ts'
import { finishForcedCardPlay } from '../src/game/combat/start-turn.ts'
import { createCampaignProgress } from '../src/game/campaign.ts'
import '../src/game/downfall/items.ts'
import { createRng } from '../src/game/rng.ts'
import {
  HERMIT_BOARD,
  HERMIT_BOARD_GUID,
  HERMIT_CARDS,
  HERMIT_CARDS_BY_ID,
  HERMIT_CARD_DEFS,
  HERMIT_CURSE_MERCHANT_COST,
  HERMIT_FAQ,
  HERMIT_PHYSICAL_CARDS,
  HERMIT_PHYSICAL_DECKS,
  HERMIT_SHEET_GUIDS,
  HERMIT_SOURCE_CARDS,
  HERMIT_STARTING_CHAMBER_SLOTS,
  HERMIT_STARTING_COMBAT_ABILITY,
  createHermitChamber,
  discardHermitChamberCard,
  fatalDesireGold,
  gainHermitChamberSlots,
  hermitCurseLoadReaction,
  isHermitDeadOn,
  loadHermitCard,
  planHermitRapidFire,
  playHermitChamberCard,
  setupHermitCombat,
  shouldHermitEtherealExhaust,
  snapshotDeadOnBlock,
} from '../src/game/downfall/hermit.ts'

const manifestUrl = new URL('../tmp/downfall-reference/manifests/hermit-card-manifest.md', import.meta.url)
const manifestText = existsSync(manifestUrl) ? readFileSync(manifestUrl, 'utf8') : null
const cardsSource = readFileSync(new URL('../src/game/cards.ts', import.meta.url), 'utf8')

function range(cell) {
  if (!cell.includes('-')) return [Number(cell)]
  const [first, last] = cell.split('-').map(Number)
  return Array.from({ length: last - first + 1 }, (_, index) => first + index)
}

function parseManifestCards(text) {
  let deck = null
  const cards = []
  for (const line of text.split('\n')) {
    if (line === '## Starter deck') deck = 'starter'
    else if (line === '## Card-reward deck') deck = 'rewards'
    else if (line === '## Rare deck') deck = 'rares'
    else if (line.startsWith('## ')) deck = null
    if (!deck || !/^\| \d/.test(line)) continue
    const [indexCell, copiesCell, name, costCell, typeRarity, baseText, upgradeCell] = line
      .split('|').slice(1, -1).map((cell) => cell.trim())
    const costs = costCell === '-' ? [null, null] : costCell.split('/').map((cost) => cost.trim())
    if (costs.length === 1) costs.push(costs[0])
    const [type, rarity] = typeRarity.split('/').map((value) => value.trim())
    let upgradedText = upgradeCell.startsWith('Same rules') ? baseText : upgradeCell
    if (upgradeCell.startsWith('No upgraded face')) upgradedText = null
    const indices = range(indexCell)
    cards.push({
      deck,
      rarity: rarity.toLowerCase(),
      name,
      type,
      cost: { base: costs[0], upgraded: costs[1] },
      sheet_indices: { base: indices, upgraded: indices },
      multiplicity: Number(copiesCell),
      base_text: baseText,
      upgraded_text: upgradedText,
    })
  }
  return cards
}

const manifestCards = manifestText === null ? HERMIT_SOURCE_CARDS : parseManifestCards(manifestText)
const checks = []
function check(name, fn) {
  fn()
  checks.push(name)
}

check('all 67 definitions match the audited manifest table exactly', () => {
  assert.equal(manifestCards.length, 67)
  assert.deepEqual(HERMIT_SOURCE_CARDS, manifestCards)
  assert.equal(HERMIT_CARDS.length, 67)
  assert.equal(Object.keys(HERMIT_CARDS_BY_ID).length, 67)
  assert.match(cardsSource, /\.\.\.\(HERMIT_CARD_DEFS as unknown as Record<string, CardDef>\)/)
})

check('sheet GUIDs and every physical card cell match the public prototype', () => {
  assert.deepEqual(HERMIT_SHEET_GUIDS, {
    starter: '3a0392', starter_upgrades: 'dcdd4a', rewards: '6355da',
    reward_upgrades: '9a4007', rares: '2b8379', rare_upgrades: 'c16bb3',
  })
  const expected = { starter: 11, rewards: 62, rares: 16 }
  for (const [deck, count] of Object.entries(expected)) {
    const physical = HERMIT_PHYSICAL_CARDS.filter((card) => card.deck === deck)
    assert.equal(physical.length, count, deck)
    assert.deepEqual([...physical.map((card) => card.sheetIndex)].sort((a, b) => a - b),
      Array.from({ length: count }, (_, index) => index), deck)
    assert.deepEqual(HERMIT_PHYSICAL_DECKS[deck], physical.map((card) => card.defId), deck)
  }
  assert.equal(HERMIT_PHYSICAL_CARDS.length, 89)
  assert.equal(new Set(HERMIT_PHYSICAL_CARDS.map((card) => card.id)).size, 89)
})

check('deck composition preserves every multiplicity and rarity', () => {
  const count = (deck, rarity) => HERMIT_CARDS
    .filter((card) => card.deck === deck && card.rarity === rarity)
    .reduce((total, card) => total + card.multiplicity, 0)
  assert.equal(count('starter', 'starter'), 11)
  assert.equal(count('rewards', 'common'), 28)
  assert.equal(count('rewards', 'uncommon'), 27)
  assert.equal(count('rewards', 'curse'), 5)
  assert.equal(count('rewards', 'ticket'), 2)
  assert.equal(count('rares', 'rare'), 15)
  assert.equal(count('rares', 'curse'), 1)
})

check('audited faces preserve costs and text while every live face has executable opcodes', () => {
  for (const source of manifestCards) {
    const audited = HERMIT_CARDS.find((card) => card.name === source.name)
    assert(audited, source.name)
    assert.equal(audited.base.cost, source.cost.base, source.name)
    assert.equal(audited.base.text, source.base_text, source.name)
    assert.equal(audited.upgraded?.cost ?? null, source.upgraded_text === null ? null : source.cost.upgraded, source.name)
    assert.equal(audited.upgraded?.text ?? null, source.upgraded_text, source.name)
    const live = HERMIT_CARD_DEFS[audited.id]
    assert(live, `${source.name}: live definition`)
    assert.equal(live.hermit?.sourceText, source.base_text, `${source.name}: base audit text`)
    assert(live.effects.every((effect) => effect.kind !== 'printed'), `${source.name}: base placeholder`)
    if (source.upgraded_text !== null) {
      assert(live.upgrade, `${source.name}: upgraded face`)
      assert.equal(live.upgrade.hermit?.sourceText, source.upgraded_text, `${source.name}: upgrade audit text`)
      assert((live.upgrade.effects ?? live.effects).every((effect) => effect.kind !== 'printed'),
        `${source.name}: upgraded placeholder`)
    }
  }
  const tickets = HERMIT_PHYSICAL_CARDS.filter((card) => card.defId === 'hermit_golden_ticket')
  assert.deepEqual(tickets.map((card) => card.upgradeSheetIndex), [36, 37])
  assert(tickets.every((card) => !card.upgradeAvailable))
  assert.equal(HERMIT_CARDS_BY_ID.hermit_itchy_trigger.base.inherentRapidFire, 1)
  assert.equal(HERMIT_CARDS_BY_ID.hermit_itchy_trigger.upgraded.inherentRapidFire, 2)
  assert.equal(HERMIT_CARDS_BY_ID.hermit_vantage.base.inherentRapidFire, 0)
  assert.equal(HERMIT_CARDS_BY_ID.hermit_vantage.base.mentionsRapidFire, true)
})

check('Chamber creation, slot gain, loading, displacement, and discard are immutable', () => {
  const empty = createHermitChamber()
  assert.equal(empty.slots.length, HERMIT_STARTING_CHAMBER_SLOTS)
  assert.deepEqual(gainHermitChamberSlots(empty, 1).slots, [null, null, null])
  const first = loadHermitCard({ hand: ['a', 'b'], chamber: empty, discard: [] }, 'hand', 1, 0)
  assert.deepEqual(first, {
    zones: { hand: ['a'], chamber: { slots: ['b', null] }, discard: [] }, loaded: 'b', displaced: null,
  })
  const second = loadHermitCard(first.zones, 'hand', 0, 0)
  assert.deepEqual(second, {
    zones: { hand: [], chamber: { slots: ['a', null] }, discard: ['b'] }, loaded: 'a', displaced: 'b',
  })
  const fromDiscard = loadHermitCard(second.zones, 'discard', 0, 1)
  assert.deepEqual(fromDiscard.zones, { hand: [], chamber: { slots: ['a', 'b'] }, discard: [] })
  const discarded = discardHermitChamberCard(fromDiscard.zones, 0)
  assert.deepEqual(discarded.zones, { hand: [], chamber: { slots: [null, 'b'] }, discard: ['a'] })
  assert.deepEqual(empty.slots, [null, null])
})

check('Chamber plays activate Dead On and pass it to every generated copy', () => {
  const played = playHermitChamberCard({ slots: ['snapshot', null] }, 0)
  assert.deepEqual(played, { chamber: { slots: [null, null] }, card: 'snapshot', deadOn: true })
  assert.equal(isHermitDeadOn('hand'), false)
  assert.equal(isHermitDeadOn('chamber'), true)
  assert.equal(isHermitDeadOn('rapid-fire-copy', true), true)
  const copies = planHermitRapidFire({ rapidFireInstances: 2, playedFromChamber: true })
  assert.equal(copies.length, 3)
  assert(copies.every((copy) => copy.deadOn))
})

check('Rapid Fire copies are terminal while external copies trigger independently', () => {
  const highCaliberPotion = planHermitRapidFire({ rapidFireInstances: 1, externalCopies: 1 })
  assert.equal(highCaliberPotion.length, HERMIT_FAQ.attackPotionHighCaliberPlays)
  assert.equal(highCaliberPotion.filter((play) => play.canTriggerRapidFire).length, 2)
  assert.equal(highCaliberPotion.filter((play) => play.origin === 'rapid-fire-copy').length, 2)
  assert(highCaliberPotion.every((play) => play.targetChosenIndependently))
  assert.equal(planHermitRapidFire({ rapidFireInstances: 0 }).length, 1)
  assert.throws(() => planHermitRapidFire({ rapidFireInstances: -1 }), /non-negative integer/)
})

check('all Hermit Curse Load reactions and the three-Gold merchant cost are exact', () => {
  assert.equal(HERMIT_CURSE_MERCHANT_COST, 3)
  assert.deepEqual(hermitCurseLoadReaction('hermit_scorn', false), { kind: 'block', amount: 3 })
  assert.deepEqual(hermitCurseLoadReaction('hermit_scorn', true), { kind: 'block', amount: 4 })
  assert.deepEqual(hermitCurseLoadReaction('hermit_grudge', false, { weak: 2, vulnerable: 1 }),
    { kind: 'damage', amount: 8, target: 'enemy' })
  assert.deepEqual(hermitCurseLoadReaction('hermit_grudge', true, { weak: 2, vulnerable: 1 }),
    { kind: 'damage', amount: 12, target: 'enemy' })
  assert.deepEqual(hermitCurseLoadReaction('hermit_malice', true), { kind: 'damage', amount: 4, target: 'row' })
  assert.deepEqual(hermitCurseLoadReaction('hermit_undead', true), { kind: 'temporaryStrength', amount: 2 })
  assert.deepEqual(hermitCurseLoadReaction('hermit_horror', true),
    { kind: 'statuses', weak: 2, vulnerable: 1, target: 'enemy' })
  assert.equal(hermitCurseLoadReaction('hermit_fatal_desire', true), null)
})

check('FAQ edge cases retain the official outcomes', () => {
  assert.equal(shouldHermitEtherealExhaust('chamber'), HERMIT_FAQ.loadedEtherealExhaustsAtEndOfTurn)
  assert.equal(shouldHermitEtherealExhaust('hand'), true)
  assert.equal(snapshotDeadOnBlock(3), 3)
  assert.equal(fatalDesireGold('add', false), 10)
  assert.equal(fatalDesireGold('add', true), 10)
  assert.equal(fatalDesireGold('remove', false), 0)
  assert.equal(fatalDesireGold('remove', true), 10)
})

check('the unlabeled board ability draws one card and then Loads the chosen hand card', () => {
  assert.equal(HERMIT_BOARD_GUID, '63f2c4')
  assert.deepEqual(HERMIT_BOARD, {
    hp: 8, maxHp: 8, hpTrackMin: 1, hpTrackMax: 9,
    energy: 3, maxEnergy: 6, block: 0, maxBlock: 10, chamberSlots: 2,
    reminders: {
      load: 'Load: Store a card in the Chamber.',
      deadOn: 'Dead On: Gains a bonus effect in the Chamber.',
      rapidFire: 'Rapid Fire: This card plays an additional time.',
    },
  })
  assert.equal(HERMIT_STARTING_COMBAT_ABILITY.name, null)
  assert.equal(HERMIT_STARTING_COMBAT_ABILITY.sourceName, 'unknown / unlabeled in source')
  assert.equal(HERMIT_STARTING_COMBAT_ABILITY.text, 'Start of combat: Draw 1 card. Load 1 card.')
  const setup = setupHermitCombat(
    { hand: ['strike'], draw: ['snapshot', 'defend'], chamber: createHermitChamber(), discard: [] },
    1,
    0,
  )
  assert.deepEqual(setup, {
    hand: ['strike'], draw: ['defend'], chamber: { slots: ['snapshot', null] }, discard: [],
  })
})

const instance = (uid, defId, upgraded = false) => ({ uid, defId, upgraded })
const player = (over = {}) => ({
  id: 'p1', name: 'Hermit', character: 'hermit', row: 0, hp: 8, maxHp: 8, block: 0, energy: 3,
  deck: [], draw: [], hand: [], discard: [], exhaust: [], powers: [], gold: 0, relics: [], potions: [],
  cardRewards: [], rareRewards: [], strength: 0, strengthLossAtEndOfTurn: 0, vulnerable: 0, weak: 0,
  drawLocked: false, lostHpThisCombat: false, attacksPlayedThisTurn: 0, shivs: 0, shivDamageBonus: 0,
  cardBlockBonus: 0, hitPoison: 0, miracles: 0, stance: 'neutral', wrathAttackDamageBonus: 0,
  orbs: [null, null, null], chamber: [], chamberSlots: 2, heat: 1, soulburn: 0, guardianMode: null,
  vigor: 0, vigorSpentThisTurn: 0, slimes: [], dead: false, ...over,
})
const enemy = (over = {}) => ({
  uid: 'e1', defId: 'cultist', row: 0, isBoss: false, hp: 20, maxHp: 20, block: 0,
  strength: 0, vulnerable: 0, weak: 0, poison: 0, actionIndex: 0, abilityUsed: false, dead: false, ...over,
})

check('live start-of-combat Load is serialized, owner-authoritative, and preserves the private card', () => {
  const deck = Array.from({ length: 6 }, (_, index) => instance(`setup-${index}`, 'hermit_defend'))
  const [drawn] = deck
  const combat = createCombat(createRng(47), [player({ draw: deck })], [enemy()])
  assert.deepEqual(combat.pendingHermitSetupLoads, [{ playerId: 'p1' }])
  assert.equal(combat.players[0].hand[0]?.uid, drawn.uid)
  const restored = JSON.parse(JSON.stringify(combat))
  const loaded = resolveHermitSetupLoad(restored, 'p1', drawn.uid)
  assert.notEqual(loaded, restored)
  assert.equal(loaded.players[0].chamber[0]?.uid, drawn.uid)
  assert.deepEqual(loaded.pendingHermitSetupLoads, [])
  assert.equal(loaded.turn, 1)
  assert.equal(loaded.players[0].hand.length, 5, 'resolving the last setup Load did not open turn one')

  const abandoned = abandonHermitSetupLoad(combat, 'p1')
  assert.equal(abandoned.turn, 1)
  assert.equal(abandoned.players[0].hand.length, 6, 'abandoning the last setup Load did not open turn one')
})

check('Fully Loaded+ can repeatedly replace Chamber cards while Loading a larger hand', () => {
  const fullyLoaded = instance('fully-loaded-many', 'hermit_fully_loaded', true)
  const chamber = [instance('loaded-old-a', 'hermit_defend'), instance('loaded-old-b', 'hermit_strike')]
  const loads = Array.from({ length: 5 }, (_, index) => instance(`loaded-new-${index}`, 'hermit_defend'))
  let combat = createCombat(createRng(505), [player({ hand: [fullyLoaded, ...loads], chamber })], [enemy()])
  combat.pendingHermitSetupLoads = []
  combat = playCard(combat, 'p1', fullyLoaded.uid, {
    loadUids: loads.map((card) => card.uid),
    chamberUids: [chamber[0].uid, loads[1].uid, chamber[1].uid, loads[0].uid],
  })
  assert.deepEqual(combat.players[0].chamber.map((card) => card.uid),
    [loads[2].uid, loads[3].uid, loads[4].uid])
  assert.equal(combat.players[0].chamberSlots, 3)
})

check('a Shiv reaching two Attacks triggers Overwhelming Power immediately', () => {
  const power = instance('shiv-overwhelming', 'hermit_overwhelming_power')
  const draws = Array.from({ length: 3 }, (_, index) => instance(`shiv-draw-${index}`, 'hermit_defend'))
  let combat = createCombat(createRng(506), [player({
    powers: [power], draw: draws, shivs: 1,
  })], [enemy()])
  combat.pendingHermitSetupLoads = []
  combat.players[0].attacksPlayedThisTurn = 1
  const handBefore = combat.players[0].hand.length
  combat = spendShiv(combat, 'p1', 'e1')
  assert.equal(combat.players[0].hand.length, handBefore + 2)
  assert.deepEqual(combat.powerTriggersUsedThisTurn, [`power:${power.uid}`])
})

check('mandatory Downfall choices block every voluntary combat action', () => {
  const held = instance('blocked-card', 'hermit_feint')
  const curse = instance('blocked-curse', 'hermit_scorn')
  const power = instance('blocked-power', 'hermit_shadow_cloak')
  const finder = instance('blocked-finder', 'guardian_gem_finder')
  const combat = createCombat(createRng(93), [player({
    hand: [held], chamber: [curse], miracles: 1, energy: 2, shivs: 1,
    draw: [instance('blocked-hidden', 'hermit_defend')], powers: [power, finder],
    relics: [{ defId: 'holy_water', cubes: 1 }], potions: ['block_potion'],
  })], [enemy()])
  combat.phase = 'player'
  combat.pendingHermitSetupLoads = [{ playerId: 'p1' }]
  assert(mandatoryChoicePending(combat))
  assert.equal(spendMiracle(combat, 'p1'), combat)
  assert.equal(spendShiv(combat, 'p1', 'e1'), combat)
  assert.equal(activatePower(combat, 'p1', power.uid, { chamberUids: [curse.uid] }), combat)
  assert.equal(playCard(combat, 'p1', held.uid), combat)
  assert.equal(beginEndPlayerTurn(combat), combat)
  assert.equal(canActivateRelic(combat, combat.players[0], 0), false)
  assert.equal(canActivatePotion(combat, combat.players[0], 'block_potion'), false)
  assert.equal(previewCardChoice(combat, 'p1', held.uid), null)
  assert.equal(previewPowerChoice(combat, 'p1', finder.uid), null)

  for (const key of [
    'pendingPlunderSwitches', 'pendingHermitSetupLoads',
    'pendingHermitChamberPlays', 'pendingHermitStrengthRewards',
  ]) {
    const isolated = {
      ...combat,
      pendingPlunderSwitches: [], pendingHermitSetupLoads: [],
      pendingHermitChamberPlays: [], pendingHermitStrengthRewards: [],
      [key]: [{ playerId: 'p1' }],
    }
    assert(mandatoryChoicePending(isolated), `${key} did not freeze voluntary actions`)
  }
})

check('mandatory Chamber plays retain their private preview exception', () => {
  const coalescence = instance('required-coalescence', 'hermit_coalescence')
  const hidden = instance('required-hidden', 'hermit_defend')
  const combat = createCombat(createRng(94), [player({ chamber: [coalescence], draw: [hidden] })], [enemy()])
  combat.pendingHermitSetupLoads = []
  combat.pendingHermitChamberPlays = [{
    playerId: 'p1', sourceCardId: 'hermit_fan_the_hammer', cardUids: [coalescence.uid], free: true,
  }]
  assert.deepEqual(previewHermitChamberCardChoice(combat, 'p1', coalescence.uid)?.cards.map((card) => card.uid),
    [hidden.uid])
})

check('impossible mandatory Chamber plays advance without removing the private card', () => {
  const scenarios = [
    {
      name: 'Time Warp',
      card: instance('time-warp-chamber', 'hermit_strike'),
      enemy: enemy({ defId: 'time_eater', isBoss: true }),
      player: { cardsPlayedThisTurn: 99 },
    },
    {
      name: 'Conclude',
      card: instance('conclude-chamber', 'hermit_strike'),
      enemy: enemy(),
      player: { cardPlayLocked: true },
    },
    {
      name: 'unplayable foreign card',
      card: instance('unplayable-chamber', 'clumsy'),
      enemy: enemy(),
      player: {},
    },
  ]
  for (const scenario of scenarios) {
    let combat = createCombat(createRng(105), [player({ chamber: [scenario.card], ...scenario.player })], [scenario.enemy])
    combat.pendingHermitSetupLoads = []
    Object.assign(combat.players[0], scenario.player)
    combat.pendingHermitChamberPlays = [{
      playerId: 'p1', sourceCardId: 'hermit_fan_the_hammer', cardUids: [scenario.card.uid], free: true,
    }]
    combat = playLiveHermitChamberCard(combat, 'p1', scenario.card.uid, { enemyUid: 'e1', playerId: null })
    assert.equal(combat.pendingHermitChamberPlays?.length, 0, `${scenario.name} left the mandatory queue stuck`)
    assert.equal(combat.players[0].chamber[0]?.uid, scenario.card.uid, `${scenario.name} removed the unplayed card`)
  }
})

check('abandoned Defense Mode Guardian copies use their effective Skill cleanup', () => {
  const whirl = instance('guardian-copy-whirl', 'guardian_guardian_whirl')
  let combat = createCombat(createRng(106), [player({ character: 'guardian' })], [enemy()])
  combat.pendingHermitSetupLoads = []
  combat.players[0].guardianMode = 'defense'
  combat.players[0].powers = [instance('copy-corruption', 'corruption')]
  combat.phase = 'copy'
  combat.pendingCardCopy = {
    playerId: 'p1', card: whirl, energySpent: 0, resumePhase: 'player', forcedExhaust: false,
    forcedChoices: null, deferredHavocs: [], sourceNames: ['Echo Form'],
  }
  combat = abandonCardCopy(combat, 'p1')
  assert.equal(combat.players[0].exhaust[0]?.uid, whirl.uid)
  assert(!combat.players[0].discard.some((card) => card.uid === whirl.uid))
})

check('Cheat exposes die-relic choices and upgraded Cheat may trigger none', () => {
  const base = instance('cheat-base', 'hermit_cheat')
  let combat = createCombat(createRng(95), [player({
    chamber: [base], energy: 2, relics: [{ defId: 'happy_flower', spent: false }],
  })], [enemy()])
  combat.pendingHermitSetupLoads = []
  combat = playLiveHermitChamberCard(combat, 'p1', base.uid, {
    enemyUid: 'e1', playerId: 'p1',
    hermitDieRelics: [{ playerId: 'p1', relicIndex: 0, abilityIndex: 0 }],
  })
  assert.equal(combat.players[0].energy, 2, 'Cheat did not trigger Happy Flower after paying its cost')

  const upgraded = instance('cheat-upgraded', 'hermit_cheat', true)
  combat = createCombat(createRng(96), [player({ chamber: [upgraded] })], [enemy()])
  combat.pendingHermitSetupLoads = []
  const skipped = playLiveHermitChamberCard(combat, 'p1', upgraded.uid, {
    enemyUid: 'e1', playerId: 'p1', hermitDieRelics: [],
  })
  assert.equal(skipped.enemies[0].hp, 18)

  const wheelCheat = instance('cheat-wheel', 'hermit_cheat')
  const fodder = [instance('wheel-a', 'hermit_defend'), instance('wheel-b', 'hermit_strike')]
  combat = createCombat(createRng(97), [player({
    chamber: [wheelCheat], hand: fodder, energy: 2,
    relics: [{ defId: 'wheel_of_change', spent: false }],
  })], [enemy()])
  combat.pendingHermitSetupLoads = []
  const missing = playLiveHermitChamberCard(combat, 'p1', wheelCheat.uid, {
    enemyUid: 'e1', playerId: 'p1',
    hermitDieRelics: [{ playerId: 'p1', relicIndex: 0, abilityIndex: 0 }],
  })
  assert.equal(missing.pendingDieRelicChoices?.[0]?.playerId, 'p1')
  const wheeled = resolvePendingDieRelicChoice(missing, 'p1', { discardUids: fodder.map((card) => card.uid) })
  assert.deepEqual(wheeled.players[0].discard.slice(-2).map((card) => card.uid), fodder.map((card) => card.uid))

  const foreignCheat = instance('cheat-foreign-wheel', 'hermit_cheat')
  const foreignFodder = [instance('foreign-wheel-a', 'strike_ironclad'), instance('foreign-wheel-b', 'defend_ironclad')]
  combat = createCombat(createRng(98), [player({ chamber: [foreignCheat], energy: 2 }), player({
    id: 'p2', name: 'Ironclad', character: 'ironclad', chamber: undefined, chamberSlots: undefined,
    hand: foreignFodder, relics: [{ defId: 'wheel_of_change', spent: false }],
  })], [enemy()])
  combat.pendingHermitSetupLoads = []
  const queued = playLiveHermitChamberCard(combat, 'p1', foreignCheat.uid, {
    enemyUid: 'e1', playerId: 'p1',
    hermitDieRelics: [{ playerId: 'p2', relicIndex: 0, abilityIndex: 0 }],
  })
  assert.equal(queued.pendingDieRelicChoices?.[0]?.playerId, 'p2')
  assert.equal(resolvePendingDieRelicChoice(queued, 'p1', { discardUids: foreignFodder.map(({ uid }) => uid) }), queued,
    'the Cheat player resolved another owner’s private hand choice')
  const foreignResolved = resolvePendingDieRelicChoice(queued, 'p2', {
    discardUids: foreignFodder.map(({ uid }) => uid),
  })
  assert.deepEqual(foreignResolved.players[1].discard.slice(0, 2).map(({ uid }) => uid),
    foreignFodder.map(({ uid }) => uid))
})

check('a forced Cheat waits for its die Relic owner before resuming Start of Turn', () => {
  const fodder = [instance('forced-wheel-a', 'hermit_defend'), instance('forced-wheel-b', 'hermit_strike')]
  let combat = createCombat(createRng(99), [player({
    hand: fodder, relics: [{ defId: 'wheel_of_change', spent: false }],
  })], [enemy()])
  combat.pendingHermitSetupLoads = []
  combat.phase = 'start'
  combat.pendingDieRelicChoices = [{
    playerId: 'p1', relicDefId: 'wheel_of_change', abilityIndex: 0,
    sourceLabel: 'Cheat', enemyUid: null, targetPlayerId: 'p1',
  }]
  combat = finishForcedCardPlay(combat, [])
  assert.equal(combat.phase, 'start')
  assert.deepEqual(combat.startTurnProgress?.choices, [])
  combat = resolvePendingDieRelicChoice(combat, 'p1', { discardUids: fodder.map(({ uid }) => uid) })
  assert.equal(combat.phase, 'player')
  assert.equal(combat.startTurnProgress, undefined)
})

check('Cheat preserves chosen relic order and queues Combo after the owner payment', () => {
  const cheat = instance('ordered-cheat', 'hermit_cheat', true)
  const fodder = [instance('ordered-a', 'hermit_defend'), instance('ordered-b', 'hermit_strike')]
  const draws = [instance('ordered-draw-a', 'hermit_strike'), instance('ordered-draw-b', 'hermit_defend'),
    instance('ordered-draw-c', 'hermit_strike')]
  let combat = createCombat(createRng(100), [player({
    chamber: [cheat], hand: fodder, energy: 2,
    powers: [instance('combo-power', 'hermit_combo')],
    relics: [{ defId: 'wheel_of_change', spent: false }, { defId: 'gremlin_horn', spent: false }],
  })], [enemy()])
  combat.pendingHermitSetupLoads = []
  combat.players[0].draw = draws
  combat = playLiveHermitChamberCard(combat, 'p1', cheat.uid, {
    enemyUid: 'e1', playerId: 'p1',
    hermitDieRelics: [
      { playerId: 'p1', relicIndex: 0, abilityIndex: 0 },
      { playerId: 'p1', relicIndex: 1, abilityIndex: 0 },
    ],
  })
  assert.equal(combat.pendingDieRelicChoices?.length, 2)
  assert.deepEqual(combat.players[0].hand.map(({ uid }) => uid), fodder.map(({ uid }) => uid),
    'later Gremlin Horn drew before Wheel of Change resolved')
  const blockedCombo = pendingTriggerAbility(combat)
  assert.equal(resolvePendingTrigger(combat, 'p1', blockedCombo.id, undefined, undefined, undefined, {
    loadUids: [], chamberUids: [], hermitEnemyUids: [],
  }), combat, 'Combo resolved before Cheat payment')
  combat = resolvePendingDieRelicChoice(combat, 'p1', { discardUids: fodder.map(({ uid }) => uid) })
  assert.equal(combat.pendingDieRelicChoices?.length, 0)
  assert.equal(combat.players[0].hand[0]?.uid, draws[0].uid)
  assert.deepEqual(combat.players[0].discard.slice(-2).map(({ uid }) => uid), fodder.map(({ uid }) => uid))
  const combo = pendingTriggerAbility(combat)
  assert.equal(combo?.label, 'Hermit\'s Combo')
  const load = combo?.hermitChoices?.loadCards.find(({ uid }) => uid === draws[1].uid)
  assert(load, 'Combo preview did not reveal its post-Wheel draw before asking what to Load')
  combat = resolvePendingTrigger(combat, 'p1', combo.id, undefined, undefined, undefined, {
    loadUids: [load.uid], chamberUids: [], hermitEnemyUids: [],
  })
  assert.equal(combat.players[0].chamber[0]?.uid, load.uid)
  assert(combat.powerTriggersUsedThisTurn.includes('p1/power:combo-power'))
})

check('Combo previews a drawn targeted Curse and requires its enemy choice', () => {
  const combo = instance('targeted-combo', 'hermit_combo')
  const grudge = instance('combo-grudge', 'hermit_grudge')
  let combat = createCombat(createRng(101), [player({
    hand: [instance('combo-hand', 'hermit_defend')],
    draw: [grudge, instance('combo-draw', 'hermit_defend')],
    powers: [combo],
  })], [enemy({ uid: 'combo-e1' }), enemy({ uid: 'combo-e2', row: 1 })])
  combat.pendingHermitSetupLoads = []
  combat.pendingTriggers = [{ id: 101, playerId: 'p1', sourceId: `power:${combo.uid}` }]
  const preview = pendingTriggerAbility(combat)
  assert.deepEqual(preview?.targets?.map(({ uid }) => uid), ['combo-e1', 'combo-e2'])
  assert(preview?.hermitChoices?.loadCards.some(({ uid }) => uid === grudge.uid))
  assert.equal(resolvePendingTrigger(combat, 'p1', preview.id, undefined, undefined, undefined, {
    loadUids: [grudge.uid], chamberUids: [], hermitEnemyUids: [],
  }), combat, 'Combo accepted a targeted Curse without an enemy')
  combat = resolvePendingTrigger(combat, 'p1', preview.id, undefined, 'combo-e2', undefined, {
    loadUids: [grudge.uid], chamberUids: [], hermitEnemyUids: [],
  })
  assert.equal(combat.enemies.find(({ uid }) => uid === 'combo-e1').hp, 20)
  assert.equal(combat.enemies.find(({ uid }) => uid === 'combo-e2').hp, 18)
  assert.equal(combat.players[0].chamber[0]?.uid, grudge.uid)
})

check('an end-turn bounty kill blocks the Enemy Turn until its Strength choice resolves', () => {
  const bounty = instance('end-turn-bounty', 'hermit_dead_or_alive')
  let combat = createCombat(createRng(102), [
    player({ id: 'p1', name: 'Hermit', character: 'hermit' }),
    player({ id: 'p2', name: 'Defect', character: 'defect', row: 1, orbs: ['lightning', null, null] }),
  ], [
    enemy({ uid: 'bounty-target', hp: 1, maxHp: 1, hermitBounties: [{ playerId: 'p1', card: bounty }] }),
    enemy({ uid: 'surviving-target', row: 1, hp: 20, maxHp: 20 }),
  ])
  combat.pendingHermitSetupLoads = []
  combat = startPlayerTurn(combat)
  const orb = endTurnAbilities(combat).find((ability) => ability.id.startsWith('p2/orb:0'))
  combat = beginEndPlayerTurn(combat, [chooseEndTurnTarget(orb.id, 'bounty-target')])
  assert.equal(combat.phase, 'enemy')
  assert.equal(combat.pendingHermitStrengthRewards?.[0]?.playerId, 'p1')
  assert.equal(enemyTurn(combat), combat, 'enemies acted before the mandatory bounty reward')
  const roundEnd = { ...combat, phase: 'roundEnd' }
  assert.equal(startPlayerTurn(roundEnd), roundEnd, 'the next turn began before the bounty reward')
  combat = resolveHermitStrengthReward(combat, 'p1', 'p2')
  assert.equal(combat.players[1].strength, 1)
  assert.notEqual(enemyTurn(combat), combat, 'the Enemy Turn did not resume after the bounty reward')
})

check('multiple physical Dead or Alive cards stay attached and each award Strength', () => {
  const bounties = [instance('bounty-one', 'hermit_dead_or_alive'), instance('bounty-two', 'hermit_dead_or_alive')]
  let combat = createCombat(createRng(502), [player({ hand: bounties, energy: 4, shivs: 1 })], [
    enemy({ uid: 'double-bounty-target', hp: 1, maxHp: 1 }),
    enemy({ uid: 'double-bounty-survivor', row: 1 }),
  ])
  combat.pendingHermitSetupLoads = []
  combat = playCard(combat, 'p1', bounties[0].uid, { enemyUid: 'double-bounty-target' })
  combat = playCard(combat, 'p1', bounties[1].uid, { enemyUid: 'double-bounty-target' })
  assert.deepEqual(combat.enemies[0].hermitBounties.map(({ card }) => card.uid), bounties.map(({ uid }) => uid))
  combat = spendShiv(combat, 'p1', 'double-bounty-target')
  assert.deepEqual(combat.pendingHermitStrengthRewards.map(({ sourceUid }) => sourceUid), bounties.map(({ uid }) => uid))
  assert.deepEqual(combat.players[0].discard.slice(-2).map(({ uid }) => uid), bounties.map(({ uid }) => uid))
  combat = resolveHermitStrengthReward(combat, 'p1', 'p1')
  combat = resolveHermitStrengthReward(combat, 'p1', 'p1')
  assert.equal(combat.players[0].strength, 2)
})

check('a lethal queued Cheat relic clears every terminal mandatory choice', () => {
  const cheat = instance('lethal-cheat', 'hermit_cheat', true)
  const fodder = [instance('lethal-a', 'hermit_defend'), instance('lethal-b', 'hermit_strike')]
  let combat = createCombat(createRng(101), [player({
    chamber: [cheat], hand: fodder, energy: 2,
    relics: [{ defId: 'wheel_of_change', spent: false }, { defId: 'duality', spent: false }],
  })], [enemy({ hp: 4, maxHp: 4 })])
  combat.pendingHermitSetupLoads = []
  combat = playLiveHermitChamberCard(combat, 'p1', cheat.uid, {
    enemyUid: 'e1', playerId: 'p1',
    hermitDieRelics: [
      { playerId: 'p1', relicIndex: 0, abilityIndex: 0 },
      { playerId: 'p1', relicIndex: 1, abilityIndex: 1, enemyUid: 'e1' },
    ],
  })
  combat = resolvePendingDieRelicChoice(combat, 'p1', { discardUids: fodder.map(({ uid }) => uid) })
  assert.equal(combat.phase, 'won')
  assert.equal(mandatoryChoicePending(combat), false)
  assert.deepEqual(combat.pendingTriggers, [])
})

check('live Chamber play activates Dead On and Snapshot uses printed damage for Block', () => {
  const snapshot = instance('snapshot', 'hermit_snapshot', true)
  const combat = createCombat(createRng(48), [player({ chamber: [snapshot] })], [enemy()])
  combat.pendingHermitSetupLoads = []
  const next = playLiveHermitChamberCard(combat, 'p1', snapshot.uid, { enemyUid: 'e1', playerId: null })
  assert.notEqual(next, combat)
  assert.equal(next.enemies[0].hp, 17)
  assert.equal(next.players[0].block, 3)
  assert.equal(next.players[0].chamber.length, 0)
})

check('a Dead On-only Chamber attack chooses its enemy before resolving', () => {
  const headshot = instance('headshot', 'hermit_headshot')
  const combat = createCombat(createRng(481), [player({ chamber: [headshot], energy: 2 })], [enemy()])
  combat.pendingHermitSetupLoads = []
  assert.equal(cardNeedsEnemy(HERMIT_CARD_DEFS.hermit_headshot, combat.players[0], true, 0,
    false, undefined, headshot.uid), true)
  const stagedPlayer = { ...combat.players[0], chamber: [], hand: [{ ...headshot, hermitDeadOn: true }] }
  assert.equal(cardNeedsEnemy(HERMIT_CARD_DEFS.hermit_headshot, stagedPlayer, true, 0,
    false, undefined, headshot.uid), true)
  assert.equal(cardNeedsEnemy(HERMIT_CARD_DEFS.hermit_headshot, { ...stagedPlayer, hand: [headshot] }, true, 0,
    false, undefined, headshot.uid), false)
  assert.equal(playLiveHermitChamberCard(combat, 'p1', headshot.uid, { enemyUid: null, playerId: null }), combat)
  const next = playLiveHermitChamberCard(combat, 'p1', headshot.uid, { enemyUid: 'e1', playerId: null })
  assert.equal(next.enemies[0].hp, 15)
  assert.equal(next.players[0].chamber.length, 0)
  assert.deepEqual(next.presentationEvents.at(-1)?.enemyIds, ['e1'])

  let copied = createCombat(createRng(482), [player({ chamber: [headshot], energy: 2 })], [enemy()])
  copied.pendingHermitSetupLoads = []
  copied.players[0].doubledAttacksThisTurn = 1
  copied = playLiveHermitChamberCard(copied, 'p1', headshot.uid, { enemyUid: 'e1', playerId: null })
  assert.equal(copied.enemies[0].hp, 15)
  assert.equal(playCardCopy(copied, 'p1', { enemyUid: null, playerId: null }), copied)
  copied = playCardCopy(copied, 'p1', { enemyUid: 'e1', playerId: null })
  assert.equal(copied.enemies[0].hp, 10)
  assert.deepEqual(copied.presentationEvents.at(-1)?.enemyIds, ['e1'])
})

check('High-Caliber plus one external copy resolves four independently targeted plays', () => {
  const card = instance('high-caliber', 'hermit_high_caliber')
  let combat = createCombat(createRng(49), [player({ chamber: [card] })], [enemy()])
  combat.pendingHermitSetupLoads = []
  combat.players[0].doubledAttacksThisTurn = 1
  combat = playLiveHermitChamberCard(combat, 'p1', card.uid, { enemyUid: 'e1', playerId: null })
  while (combat.pendingCardCopy) combat = playCardCopy(combat, 'p1', { enemyUid: 'e1', playerId: null })
  assert.equal(combat.enemies[0].hp, 16)
  assert.equal(combat.players[0].block, 4)
})

check('externally queued Hermit cards retain printed, dynamic, and Vantage Rapid Fire', () => {
  const omniscience = instance('omni', 'omniscience')
  const itchy = instance('itchy', 'hermit_itchy_trigger')
  let combat = createCombat(createRng(103), [player({
    character: 'watcher',
    hand: [omniscience, instance('other', 'hermit_defend')],
    draw: [itchy], energy: 3, nextAttackRapidFire: 1,
  })], [enemy({ hp: 20, maxHp: 20 })])
  combat.pendingHermitSetupLoads = []
  combat.players[0].nextAttackRapidFire = 1
  combat = playCard(combat, 'p1', omniscience.uid, { searchDrawUids: [itchy.uid] })
  assert.deepEqual(combat.pendingCardCopy?.sourceNames,
    ['Omniscience', 'Omniscience', 'Rapid Fire', 'Rapid Fire', 'Rapid Fire', 'Rapid Fire'])
  while (combat.pendingCardCopy) combat = playCardCopy(combat, 'p1', { enemyUid: 'e1', playerId: null })
  assert.equal(combat.enemies[0].hp, 14)
  assert.equal(combat.players[0].nextAttackRapidFire, 0)

  const magnum = instance('magnum', 'hermit_magnum')
  combat = createCombat(createRng(104), [player({
    character: 'watcher',
    hand: [instance('omni-magnum', 'omniscience'), instance('a', 'hermit_defend'), instance('b', 'hermit_defend')],
    draw: [magnum], energy: 3,
  })], [enemy({ hp: 30, maxHp: 30 })])
  combat.pendingHermitSetupLoads = []
  combat = playCard(combat, 'p1', 'omni-magnum', { searchDrawUids: [magnum.uid] })
  assert.equal(combat.pendingCardCopy?.sourceNames.length, 6,
    'Magnum did not count every card left in hand for both external seeds')

  const whirl = instance('omni-guardian-whirl', 'guardian_guardian_whirl')
  combat = createCombat(createRng(107), [player({
    character: 'watcher', hand: [instance('omni-whirl', 'omniscience')], draw: [whirl], energy: 3,
    freeAttacksThisTurn: 1, nextAttackRapidFire: 1,
    powers: [instance('omni-no-holds', 'hermit_no_holds_barred')],
  })], [enemy()])
  combat.pendingHermitSetupLoads = []
  combat.players[0].freeAttacksThisTurn = 1
  combat.players[0].nextAttackRapidFire = 1
  combat = playCard(combat, 'p1', 'omni-whirl', { searchDrawUids: [whirl.uid] })
  assert.deepEqual(combat.pendingCardCopy?.sourceNames, ['Omniscience', 'Omniscience'],
    'Omniscience classified a foreign Guardian card before its mode choice')
  combat = playCardCopy(combat, 'p1', {
    enemyUid: null, playerId: 'p1', corruptedShardMode: 'defense',
  })
  combat = playCardCopy(combat, 'p1', { enemyUid: null, playerId: 'p1' })
  assert.equal(combat.players[0].freeAttacksThisTurn, 1,
    'Defense-Mode Omniscience consumed a free Attack')
  assert.equal(combat.players[0].nextAttackRapidFire, 1,
    'Defense-Mode Omniscience consumed the next-Attack Rapid Fire bonus')
})

check('Vantage is consumed by Haunting Echo without doubling its nested Attack', () => {
  const echo = instance('vantage-echo', 'haunting_echo')
  const latest = instance('vantage-latest', 'strike_hexaghost')
  let combat = createCombat(createRng(504), [player({
    hand: [echo], energy: 3, heat: 5, nextAttackRapidFire: 1,
  })], [enemy({ hp: 20, maxHp: 20 })])
  combat.pendingHermitSetupLoads = []
  combat.players[0].nextAttackRapidFire = 1
  combat.playedCardsThisTurn = [{ playerId: 'p1', card: latest, copied: false, type: 'attack' }]
  combat = playCard(combat, 'p1', echo.uid, { enemyUid: 'e1', playerId: null })
  assert.deepEqual(combat.pendingCardCopy?.sourceNames, ['Haunting Echo'])
  assert.equal(combat.players[0].nextAttackRapidFire, 0)
  for (let copies = 0; copies < 10 && combat.pendingCardCopy; copies++) {
    combat = playCardCopy(combat, 'p1', { enemyUid: 'e1', playerId: null })
  }
  assert.equal(combat.pendingCardCopy, undefined,
    `Haunting Echo copy queue did not terminate: ${combat.pendingCardCopy?.sourceNames.join(', ')}`)
  assert.equal(combat.enemies[0].hp, 15)
})

check('draw-then-Load previews cover normal, copied, and Chamber Hermit plays', () => {
  const feint = instance('feint', 'hermit_feint')
  const hidden = Array.from({ length: 4 }, (_, index) => instance(`hidden-${index}`, 'hermit_defend'))
  let combat = createCombat(createRng(53), [player({ hand: [feint], draw: [...hidden] })], [enemy()])
  combat.pendingHermitSetupLoads = []
  combat.players[0].doubledCardsThisTurn = 1
  const first = previewCardChoice(combat, 'p1', feint.uid)
  assert.equal(first?.kind, 'load')
  assert.deepEqual(first.cards.map((card) => card.uid), hidden.slice(0, 3).map((card) => card.uid))
  combat = playCard(combat, 'p1', feint.uid, { loadUids: [hidden[0].uid] })
  assert.equal(combat.phase, 'copy')
  const copied = previewCardCopyChoice(combat, 'p1')
  assert.equal(copied?.kind, 'load')
  assert.deepEqual(copied.cards.map((card) => card.uid), hidden.slice(1, 4).map((card) => card.uid))
  combat = playCardCopy(combat, 'p1', { loadUids: [hidden[2].uid] })
  assert.deepEqual(combat.players[0].chamber.map((card) => card.uid), [hidden[0].uid, hidden[2].uid])

  const coalescence = instance('coalescence', 'hermit_coalescence')
  const chamberDraw = [instance('chamber-hidden-0', 'hermit_strike'), instance('chamber-hidden-1', 'hermit_defend')]
  combat = createCombat(createRng(54), [player({ chamber: [coalescence], draw: [...chamberDraw] })], [enemy()])
  combat.pendingHermitSetupLoads = []
  const drawBeforeChamberPreview = combat.players[0].draw.map((card) => card.uid)
  const chamberPreview = previewHermitChamberCardChoice(combat, 'p1', coalescence.uid)
  assert.equal(chamberPreview?.kind, 'loadAny')
  assert.deepEqual(chamberPreview.cards.map((card) => card.uid), chamberDraw.map((card) => card.uid))
  assert.deepEqual(combat.players[0].draw.map((card) => card.uid), drawBeforeChamberPreview,
    'private Chamber preview advanced the authoritative draw pile')
  combat = playLiveHermitChamberCard(combat, 'p1', coalescence.uid, { loadUids: [chamberDraw[1].uid] })
  assert.deepEqual(combat.players[0].chamber.map((card) => card.uid), [chamberDraw[1].uid])
})

check('live Load and Load-self replace a chosen occupied Chamber slot', () => {
  const old = instance('old-chamber', 'hermit_defend')
  const kept = instance('kept-chamber', 'hermit_strike')
  const covet = instance('full-covet', 'hermit_covet')
  const loaded = instance('full-load', 'hermit_snapshot')
  let combat = createCombat(createRng(531), [player({ hand: [covet, loaded], chamber: [old, kept] })], [enemy()])
  combat.pendingHermitSetupLoads = []
  combat = playCard(combat, 'p1', covet.uid, { loadUids: [loaded.uid], chamberUids: [old.uid] })
  assert.deepEqual(combat.players[0].chamber.map((card) => card.uid), [loaded.uid, kept.uid])
  assert.ok(combat.players[0].discard.some((card) => card.uid === old.uid))

  const tracking = instance('full-tracking', 'hermit_tracking_shots')
  combat = createCombat(createRng(532), [player({ hand: [tracking], chamber: [old, kept] })], [enemy()])
  combat.pendingHermitSetupLoads = []
  combat = playCard(combat, 'p1', tracking.uid, {
    enemyUid: 'e1', playerId: null, chooseLoadSelf: true, chamberUids: [kept.uid],
  })
  assert.deepEqual(combat.players[0].chamber.map((card) => card.uid), [old.uid, tracking.uid])
  assert.ok(combat.players[0].discard.some((card) => card.uid === kept.uid))
})

check('Hermit reward decks, curse merchant pricing, and Fatal Desire gold use live acquisition paths', () => {
  const progress = createCampaignProgress()
  assert.deepEqual(characterRewardDeck('hermit', true, progress), HERMIT_PHYSICAL_DECKS.rares)
  assert.equal(characterRewardDeck('hermit', false, progress).filter((id) => id === 'golden_ticket').length, 2)
  assert.equal(HERMIT_CARD_DEFS.hermit_scorn.rarity, 'curse')
  assert.equal(HERMIT_CARD_DEFS.hermit_fatal_desire.rarity, 'curse')
  assert.equal(cardIsCurse('hermit_scorn'), true)
  assert.equal(merchantCardCost('hermit_scorn'), HERMIT_CURSE_MERCHANT_COST)
  const scorn = instance('scorn', 'hermit_scorn')
  const cursed = player({ deck: [scorn], cardRewards: ['hermit_snapshot'] })
  assert.equal(transformCard(createRng(669), cursed, scorn.uid, 'replacement'), cursed)
  const gained = addCard(player(), 'hermit_fatal_desire', 'fatal')
  assert.equal(gained.gold, 10)
  assert.equal(removeCard({ ...gained, deck: [{ ...gained.deck[0], upgraded: true }] }, 'fatal').gold, 20)
})

check('triggered Hermit Powers pause on serialized Load choices and resume exactly once', () => {
  const choice = instance('chosen-load', 'hermit_strike')
  const discardCurse = instance('discarded-grudge', 'hermit_grudge')
  const spareChamber = instance('spare-chamber', 'hermit_defend')
  const takeAim = instance('take-aim', 'hermit_take_aim')
  const combat = createCombat(createRng(50), [player({
    hand: [choice], discard: [discardCurse], chamber: [spareChamber], powers: [takeAim],
  })], [enemy({ uid: 'take-aim-e1' }), enemy({ uid: 'take-aim-e2', row: 1 })])
  combat.pendingHermitSetupLoads = []
  fireTriggers(combat, { kind: 'endOfTurn' })
  assert.equal(combat.pendingTriggers.length, 1)
  const trigger = combat.pendingTriggers[0]
  const preview = pendingTriggerAbility(combat)
  assert.deepEqual(preview.hermitChoices.loadCards.map(({ uid }) => uid), [choice.uid])
  assert.deepEqual(preview.hermitChoices.chamberCards, [], 'an open Chamber slot needs no replacement choice')
  assert.equal(preview.targets, undefined, 'a targeted Curse left in discard cannot request an enemy')
  const resolved = resolvePendingTrigger(combat, 'p1', trigger.id, undefined, undefined, undefined, {
    loadUids: [choice.uid], chamberUids: [], hermitEnemyUids: [],
  })
  assert.notEqual(resolved, combat)
  assert(resolved.players[0].chamber.some(({ uid }) => uid === choice.uid))
  assert.equal(resolved.pendingTriggers.length, 0)
})

check('Take Aim pauses and resumes through the real end-turn pipeline', () => {
  const choice = instance('end-turn-take-aim-choice', 'hermit_strike')
  const takeAim = instance('end-turn-take-aim', 'hermit_take_aim')
  let combat = createCombat(createRng(502), [player({ hand: [choice], powers: [takeAim] })], [enemy()])
  combat.pendingHermitSetupLoads = []
  combat = beginEndPlayerTurn(combat)
  const preview = pendingTriggerAbility(combat)
  assert.deepEqual(preview.hermitChoices.loadCards.map(({ uid }) => uid), [choice.uid])
  combat = resolvePendingTrigger(combat, 'p1', preview.id, undefined, undefined, undefined, {
    loadUids: [choice.uid], chamberUids: [], hermitEnemyUids: [],
  })
  assert(combat.players[0].chamber.some(({ uid }) => uid === choice.uid))
  assert.equal(combat.phase, 'enemy')
})

check('Take Aim auto-targets the only enemy for a loaded Curse', () => {
  const grudge = instance('end-turn-take-aim-grudge', 'hermit_grudge')
  const takeAim = instance('end-turn-take-aim-curse', 'hermit_take_aim')
  let combat = createCombat(createRng(504), [player({ hand: [grudge], powers: [takeAim] })], [
    enemy({ hp: 10, maxHp: 10 }),
  ])
  combat.pendingHermitSetupLoads = []
  combat = beginEndPlayerTurn(combat)
  const preview = pendingTriggerAbility(combat)
  assert.equal(preview.targets, undefined)
  combat = resolvePendingTrigger(combat, 'p1', preview.id, undefined, undefined, undefined, {
    loadUids: [grudge.uid], chamberUids: [], hermitEnemyUids: [],
  })
  assert(combat.players[0].chamber.some(({ uid }) => uid === grudge.uid))
  assert.equal(combat.enemies[0].hp, 8)
  assert.equal(combat.phase, 'enemy')
})

check('Combo offers only cards in hand after its draw, not cards left in discard', () => {
  const combo = instance('combo-discard-filter', 'hermit_combo')
  const held = instance('combo-held', 'hermit_strike')
  const drawn = [instance('combo-drawn-a', 'hermit_defend'), instance('combo-drawn-b', 'hermit_snapshot')]
  const discardedCurse = instance('combo-discarded-grudge', 'hermit_grudge')
  const combat = createCombat(createRng(501), [player({
    hand: [held], draw: [], discard: [discardedCurse], powers: [combo],
  })], [enemy({ uid: 'combo-discard-e1' }), enemy({ uid: 'combo-discard-e2', row: 1 })])
  combat.pendingHermitSetupLoads = []
  Object.assign(combat.players[0], { hand: [held], draw: [...drawn], discard: [discardedCurse] })
  combat.pendingTriggers = [{ id: 501, playerId: 'p1', sourceId: `power:${combo.uid}` }]
  const preview = pendingTriggerAbility(combat)
  assert.deepEqual(preview.hermitChoices.loadCards.map(({ uid }) => uid), [held.uid, ...drawn.map(({ uid }) => uid)])
  assert.equal(preview.hermitChoices.loadCards.some(({ uid }) => uid === discardedCurse.uid), false)
  assert.equal(preview.targets, undefined, 'a targeted Curse left in discard cannot request an enemy')
})

check('Smoking Barrel draws only after its optional Chamber discard is paid', () => {
  const barrel = instance('smoking-barrel', 'hermit_smoking_barrel')
  const chambered = instance('barrel-chamber', 'hermit_defend')
  const draws = Array.from({ length: 4 }, (_, index) => instance(`barrel-draw-${index}`, 'hermit_strike'))
  const fixture = (chamber) => {
    const combat = createCombat(createRng(503), [player({ chamber, draw: [], powers: [barrel] })], [enemy()])
    combat.pendingHermitSetupLoads = []
    combat.players[0].draw = [...draws]
    fireTriggers(combat, { kind: 'startOfTurn' })
    return combat
  }

  const declined = fixture([chambered])
  const declinedTrigger = pendingTriggerAbility(declined)
  assert.deepEqual(declinedTrigger.hermitChoices.loadCards, [])
  assert.deepEqual(declinedTrigger.hermitChoices.chamberCards.map(({ uid }) => uid), [chambered.uid])
  const declinedResult = resolvePendingTrigger(declined, 'p1', declinedTrigger.id, undefined, undefined, undefined, {
    loadUids: [], chamberUids: [], hermitEnemyUids: [],
  })
  assert.equal(declinedResult.players[0].hand.length, 0)
  assert.equal(declinedResult.players[0].chamber[0]?.uid, chambered.uid)

  const paid = fixture([chambered])
  const paidTrigger = pendingTriggerAbility(paid)
  const paidResult = resolvePendingTrigger(paid, 'p1', paidTrigger.id, undefined, undefined, undefined, {
    loadUids: [], chamberUids: [chambered.uid], hermitEnemyUids: [],
  })
  assert.equal(paidResult.players[0].hand.length, 3)
  assert.equal(paidResult.players[0].chamber.length, 0)
  assert.equal(paidResult.players[0].discard.at(-1)?.uid, chambered.uid)

  const empty = fixture([])
  assert.equal(empty.pendingTriggers.length, 0)
  assert.equal(empty.players[0].hand.length, 0)
})

check('active Hermit Powers require and apply their Chamber and Load choices', () => {
  const curse = instance('curse', 'hermit_scorn')
  const shadow = instance('shadow', 'hermit_shadow_cloak')
  let combat = createCombat(createRng(51), [player({ chamber: [curse], powers: [shadow] })], [enemy()])
  combat.pendingHermitSetupLoads = []
  assert.equal(activatePower(combat, 'p1', shadow.uid), combat, 'missing Chamber choice is refused atomically')
  const discarded = activatePower(combat, 'p1', shadow.uid, { chamberUids: [curse.uid] })
  assert.notEqual(discarded, combat)
  assert.equal(discarded.players[0].chamber.length, 0)
  assert.equal(discarded.players[0].discard[0]?.uid, curse.uid)

  const loaded = instance('load', 'hermit_strike')
  const blackWind = instance('black-wind', 'hermit_black_wind')
  combat = createCombat(createRng(52), [player({ hand: [loaded], chamber: [curse], powers: [blackWind] })], [enemy()])
  combat.pendingHermitSetupLoads = []
  const changed = activatePower(combat, 'p1', blackWind.uid, { chamberUids: [curse.uid], loadUids: [loaded.uid] })
  assert.notEqual(changed, combat)
  assert.equal(changed.players[0].chamber[0]?.uid, loaded.uid)
  assert.equal(changed.players[0].discard[0]?.uid, curse.uid)
})

console.log(`Downfall Hermit verification passed (${checks.length} checks, ${HERMIT_CARDS.length} definitions, ${HERMIT_PHYSICAL_CARDS.length} physical cards).`)
