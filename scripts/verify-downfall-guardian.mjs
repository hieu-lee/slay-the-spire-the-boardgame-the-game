import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import {
  GUARDIAN_CARDS,
  GUARDIAN_CARD_DEFS,
  GUARDIAN_CARDS_BY_ID,
  GUARDIAN_ICON_LEGEND,
  GUARDIAN_GEM_RULES,
  GUARDIAN_PHYSICAL_CARDS,
  GUARDIAN_PHYSICAL_DECKS,
  GUARDIAN_SHEET_GUIDS,
  GUARDIAN_SOURCE,
  GUARDIAN_SOURCE_SAVE,
  GUARDIAN_SOURCE_CARDS,
  GUARDIAN_STARTING_MODE,
  GUARDIAN_VERIFICATION,
  GUARDIAN_VIGOR_CAP,
  attachGuardianGem,
  clearSpentGuardianVigor,
  gainGuardianVigor,
  guardianBlockPerIconBonus,
  guardianDamagePerHitBonus,
  guardianModeBonuses,
  mayBuyGuardianSocketCard,
  reclaimSpentGuardianVigor,
  resolveGuardianCardType,
  revealGuardianDraftGems,
  revealGuardianGainedCardGem,
  settleGuardianGemChoice,
  shiftGuardianMode,
  spendGuardianVigor,
} from '../src/game/downfall/guardian.ts'
import { CARDS, STARTER_DECKS, faceOf, isStarterStrikeOrDefend } from '../src/game/cards.ts'
import { addCard, characterRewardDeck } from '../src/game/acquisition.ts'
import { createCampaignProgress } from '../src/game/campaign.ts'
import { acquireRelic, chooseEvent, createRun, pendingRelicEligibleCards, pendingRelicPreview, purchaseAtMerchant, resolveCardRewards, resolveGuardianSocket, resolvePendingRelic, revealCardReward } from '../src/game/run.ts'
import { pendingRewardChoices } from '../src/game/run/rewards.ts'
import {
  activatePotion,
  activatePower,
  amountOf,
  beginEndPlayerTurn,
  chooseEndTurnTarget,
  createCombat,
  defaultEndTurnOrder,
  endPlayerTurn,
  endTurnAbilities,
  enemyTurn,
  playCard,
  playCardCopy,
  playCost,
  previewPowerChoice,
  preparePlayerTurn,
  resolveStartPlayerTurn,
  startTurnAbilities,
  startPlayerTurn,
} from '../src/game/combat.ts'
import { resolveCombat } from '../src/game/run/rooms.ts'
import { createMerchant } from '../src/game/noncombat.ts'
import { createEventRoom } from '../src/game/event-room.ts'
import { EVENT_DEFINITIONS } from '../src/game/events.ts'

const manifestUrl = new URL('../tmp/downfall-reference/manifests/guardian.json', import.meta.url)
const manifest = process.env.DOWNFALL_VERIFY_CLEAN !== '1' && existsSync(manifestUrl)
  ? JSON.parse(readFileSync(manifestUrl, 'utf8')) : null

const checks = []
function check(name, fn) {
  fn()
  checks.push(name)
}

check('source metadata matches the audited official manifest', () => {
  if (!manifest) return
  assert.equal(GUARDIAN_SOURCE, manifest.source)
  assert.equal(GUARDIAN_SOURCE_SAVE, manifest.source_save)
  assert.equal(GUARDIAN_VERIFICATION, manifest.verification)
  assert.deepEqual(GUARDIAN_SHEET_GUIDS, manifest.sheet_guids)
  assert.deepEqual(GUARDIAN_ICON_LEGEND, manifest.icon_legend)
})

check('Guardian Whirl is neither an Egg nor Whetstone target outside combat', () => {
  let run = createRun(399, [{ id: 'p1', name: 'Guardian', character: 'guardian' }])
  const player = run.players[0]
  player.relics.push({ defId: 'molten_egg', spent: false, uses: 3 })
  const gained = addCard(player, 'guardian_guardian_whirl', 'whirl')
  assert.equal(gained.deck.find((card) => card.uid === 'whirl').upgraded, false)
  assert.equal(gained.relics.find((relic) => relic.defId === 'molten_egg').uses, 3)

  run = { ...run, phase: 'map', combat: null, players: [{ ...gained,
    deck: [
      { uid: 'starter', defId: 'guardian_strike', upgraded: false },
      { uid: 'edge', defId: 'guardian_crystal_edge', upgraded: false },
      { uid: 'whirl', defId: 'guardian_guardian_whirl', upgraded: false },
    ],
    relics: [...gained.relics, { defId: 'whetstone', spent: false, pending: true }],
  }] }
  assert.deepEqual(pendingRelicEligibleCards(run.players[0], 'whetstone').map((card) => card.uid), ['edge'])
  const refused = resolvePendingRelic(run, 'p1', ['whirl'], [])
  assert(refused.players[0].relics.some((relic) => relic.defId === 'whetstone' && relic.pending))
  assert.equal(refused.players[0].deck.find((card) => card.uid === 'whirl').upgraded, false)
})

check('all 83 definitions match every manifest field exactly', () => {
  assert.equal(GUARDIAN_SOURCE_CARDS.length, 83)
  if (manifest) assert.deepEqual(GUARDIAN_SOURCE_CARDS, manifest.cards)
  assert.equal(GUARDIAN_CARDS.length, 83)
  assert.equal(Object.keys(GUARDIAN_CARDS_BY_ID).length, 83)
})

check('physical sheet copies total 10 starter, 62 reward, 16 rare, and 24 Gems', () => {
  const expected = { starter: 10, rewards: 62, rares: 16, gems: 24 }
  for (const [deck, count] of Object.entries(expected)) {
    const physical = GUARDIAN_PHYSICAL_CARDS.filter((card) => card.deck === deck)
    assert.equal(physical.length, count)
    assert.equal(GUARDIAN_CARDS.filter((card) => card.deck === deck).reduce((sum, card) => sum + card.multiplicity, 0), count)
    assert.deepEqual([...physical.map((card) => card.sheetIndex)].sort((a, b) => a - b),
      Array.from({ length: count }, (_, index) => index), deck)
    assert.deepEqual(GUARDIAN_PHYSICAL_DECKS[deck], physical.map((card) => card.defId), deck)
  }
  assert.equal(GUARDIAN_PHYSICAL_CARDS.length, 112)
  assert.equal(new Set(GUARDIAN_PHYSICAL_CARDS.map((card) => card.id)).size, 112)
})

check('every physical copy points at its exact base and upgrade cell', () => {
  for (const source of GUARDIAN_SOURCE_CARDS) {
    const definition = GUARDIAN_CARDS.find((card) => card.name === source.name)
    assert(definition, `missing ${source.name}`)
    const copies = GUARDIAN_PHYSICAL_CARDS.filter((card) => card.defId === definition.id)
    assert.equal(copies.length, source.multiplicity, source.name)
    assert.deepEqual(copies.map((copy) => copy.sheetIndex), source.sheet_indices.base, source.name)
    assert.deepEqual(copies.map((copy) => copy.upgradeSheetIndex).filter((index) => index !== null),
      source.sheet_indices.upgraded, source.name)
    assert(copies.every((copy) => copy.upgradeAvailable === (source.upgraded_text !== null)), source.name)
    assert.equal(definition.base.cost, source.cost.base, source.name)
    assert.equal(definition.base.text, source.base_text, source.name)
    assert(!JSON.stringify(definition.base.effects).includes('printed'), source.name)
    assert(definition.base.effects.length > 0, source.name)
    assert.equal(definition.upgraded?.cost ?? null, source.upgraded_text === null ? null : source.cost.upgraded, source.name)
    assert.equal(definition.upgraded?.text ?? null, source.upgraded_text, source.name)
    assert.equal(definition.upgraded?.effects.length ?? null,
      source.upgraded_text === null ? null : 1, source.name)
  }
})

check('all audited definitions are registered executable CardDefs with exhaustive handlers', () => {
  const resolver = readFileSync(new URL('../src/game/combat/effects.ts', import.meta.url), 'utf8')
  for (const source of GUARDIAN_SOURCE_CARDS) {
    const id = `guardian_${source.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`
    const def = GUARDIAN_CARD_DEFS[id]
    assert(def, `missing live definition ${id}`)
    assert.equal(CARDS[id], def, `${id} is not registered`)
    assert(!JSON.stringify(def).includes('"kind":"printed"'), `${id} retains printed placeholder behavior`)
    if (source.type === 'Gem') {
      assert.deepEqual(def.effects, [{ kind: 'sequence', effects: [], guardianGemId: id }], id)
      assert(resolver.includes(`case '${id}'`), `missing Gem handler ${id}`)
    } else {
      assert.deepEqual(def.effects, [{ kind: 'sequence', effects: [], guardianAction: 'card' }], id)
      assert(resolver.includes(`case '${id}'`), `missing card handler ${id}`)
    }
    if (def.upgrade) assert(!JSON.stringify(faceOf(def, true)).includes('"kind":"printed"'), `${id}+ unresolved`)
  }
})

check('live starter, reward, and rare decks preserve all physical copies', () => {
  assert.deepEqual(STARTER_DECKS.guardian, GUARDIAN_PHYSICAL_DECKS.starter)
  const progress = createCampaignProgress()
  const rewards = characterRewardDeck('guardian', false, progress)
  const rares = characterRewardDeck('guardian', true, progress)
  assert.equal(rewards.length, 62)
  assert.equal(rewards.filter((id) => id === 'golden_ticket').length, 2)
  assert.deepEqual(rares, GUARDIAN_PHYSICAL_DECKS.rares)
  assert.equal(rares.length, 16)
})

check('Socket and source-uncertainty metadata are preserved without inference', () => {
  const socketNames = GUARDIAN_CARDS.filter((card) => card.socket).map((card) => card.name)
  assert.deepEqual(socketNames, [
    'Prismatic Barrier', 'Prismatic Spray', 'Disrupt', 'Crystal Edge', 'Fierce Bash',
    'Suspension', 'Walker Claw', 'Crystallize', 'Harden', 'Multi Beam', 'Bauble Burst', 'Exploit Gems', 'Floating Orbs',
  ])
  assert.deepEqual(GUARDIAN_CARDS.filter((card) => card.grantsSocket).map((card) => card.name), ['Crystallize'])
  assert.deepEqual(
    GUARDIAN_CARDS.filter((card) => card.ocr_uncertainty !== null).map((card) => [card.name, card.ocr_uncertainty]),
    GUARDIAN_SOURCE_CARDS.filter((card) => card.ocr_uncertainty !== null).map((card) => [card.name, card.ocr_uncertainty]),
  )
  assert.equal(GUARDIAN_CARDS_BY_ID.guardian_guardian_whirl.type, '???')
  assert.equal(GUARDIAN_CARDS_BY_ID.guardian_refracted_beam.type, '???')
})

check('printed icon and mode metadata is derived from both faces', () => {
  const sentry = GUARDIAN_CARDS_BY_ID.guardian_sentry_beam
  assert.deepEqual(sentry.base.iconCounts, { '[damage]': 1, '[vigor]': 1, '[mode-shift]': 1, '[aoe]': 1 })
  assert.deepEqual(sentry.base.modeEffects, ['attack'])
  assert.equal(sentry.base.vigorReference, 'gain')
  assert.deepEqual(GUARDIAN_CARDS_BY_ID.guardian_guardian_whirl.upgraded.modeEffects, ['attack', 'defense'])
  assert.equal(GUARDIAN_CARDS_BY_ID.guardian_time_sifter.base.vigorReference, 'spent-zone')
  assert.equal(GUARDIAN_CARDS_BY_ID.guardian_tourmaline.base.vigorReference, 'spend-attached')
})

check('variable card types resolve only in combat and Gems retain their playable type', () => {
  assert.equal(resolveGuardianCardType('???'), null)
  assert.equal(resolveGuardianCardType('???', 'attack'), 'attack')
  assert.equal(resolveGuardianCardType('???', 'defense'), 'skill')
  assert.equal(resolveGuardianCardType('Gem Attack', 'defense'), 'attack')
  assert.equal(resolveGuardianCardType('Gem Skill', 'attack'), 'skill')
  assert.equal(resolveGuardianCardType('Gem Power', 'attack'), 'power')
})

check('Mode Shift and the four-token Vigor supply follow the rulebook', () => {
  assert.equal(GUARDIAN_VIGOR_CAP, 4)
  assert.equal(GUARDIAN_STARTING_MODE, 'attack')
  assert.equal(shiftGuardianMode('attack'), 'defense')
  assert.equal(shiftGuardianMode('defense'), 'attack')
  assert.deepEqual(gainGuardianVigor({ available: 1, spent: 2 }, 4), { available: 2, spent: 2 })
  assert.deepEqual(spendGuardianVigor({ available: 3, spent: 1 }, 2), { available: 1, spent: 3 })
  assert.deepEqual(clearSpentGuardianVigor({ available: 1, spent: 3 }), { available: 1, spent: 0 })
  assert.deepEqual(reclaimSpentGuardianVigor({ available: 1, spent: 3 }), { available: 4, spent: 0 })
  assert.throws(() => spendGuardianVigor({ available: 1, spent: 0 }, 2), /Cannot spend/)
  assert.throws(() => gainGuardianVigor({ available: 0, spent: 0 }, 0.5), /non-negative integer/)
})

check('spent Vigor adds once per hit or Block icon only to Attacks and Skills', () => {
  assert.deepEqual(guardianModeBonuses('attack', 3, 'Attack'), { damagePerHit: 3, blockPerIcon: 0 })
  assert.deepEqual(guardianModeBonuses('attack', 3, 'Gem Skill'), { damagePerHit: 3, blockPerIcon: 0 })
  assert.deepEqual(guardianModeBonuses('attack', 3, 'Gem Power'), { damagePerHit: 0, blockPerIcon: 0 })
  assert.deepEqual(guardianModeBonuses('attack', 3, 'Skill', true), { damagePerHit: 6, blockPerIcon: 0 })
  assert.deepEqual(guardianModeBonuses('defense', 3, 'Gem Attack'), { damagePerHit: 0, blockPerIcon: 3 })
  assert.deepEqual(guardianModeBonuses('defense', 3, 'Power'), { damagePerHit: 0, blockPerIcon: 0 })
  assert.deepEqual(guardianModeBonuses('defense', 3, '???'), { damagePerHit: 0, blockPerIcon: 3 })
  assert.equal(guardianDamagePerHitBonus('attack', 3, 'Gem Skill'), 3)
  assert.equal(guardianBlockPerIconBonus('defense', 3, 'Gem Attack'), 3)
})

check('Socket reveal, attach, bottom-deck, and Merchant-limit flows are deterministic', () => {
  const socketCard = GUARDIAN_CARDS_BY_ID.guardian_crystal_edge
  const ordinaryCard = GUARDIAN_CARDS_BY_ID.guardian_orb_slam
  const gems = [{ id: 'ruby' }, { id: 'opal' }, { id: 'onyx' }]
  assert.deepEqual(revealGuardianDraftGems([ordinaryCard], gems), { revealed: [], deck: gems })
  const draft = revealGuardianDraftGems([ordinaryCard, socketCard], gems)
  assert.deepEqual(draft, { revealed: gems.slice(0, 2), deck: gems.slice(2) })
  assert.deepEqual(settleGuardianGemChoice(draft.deck, draft.revealed, 'opal'), [{ id: 'onyx' }, { id: 'ruby' }])
  assert.deepEqual(revealGuardianGainedCardGem(socketCard, gems), { revealed: gems.slice(0, 1), deck: gems.slice(1) })
  assert.deepEqual(
    attachGuardianGem({ uid: 'card-1', defId: socketCard.id, upgraded: false }, socketCard, 'guardian_ruby'),
    { uid: 'card-1', defId: socketCard.id, upgraded: false, attachedGemId: 'guardian_ruby' },
  )
  assert.throws(() => attachGuardianGem({ uid: 'card-2', defId: ordinaryCard.id, upgraded: false }, ordinaryCard, 'guardian_ruby'), /Socket/)
  assert.equal(mayBuyGuardianSocketCard(0), true)
  assert.equal(mayBuyGuardianSocketCard(1), true)
  assert.equal(mayBuyGuardianSocketCard(2), false)
  assert.deepEqual(GUARDIAN_GEM_RULES, {
    shuffleBetweenActs: true, draftRevealCount: 2, directGainRevealCount: 1, merchantSocketLimit: 2,
  })
})

check('the run owns all 24 Gems and parks a drafted Socket until its revealed choice is attached', () => {
  let run = createRun(417, [{ id: 'p1', name: 'Guardian', character: 'guardian' }])
  assert.equal(run.guardianGemDeck.length, 24)
  run.guardianGemDeck = [
    'guardian_ruby', 'guardian_ruby', 'guardian_onyx', ...run.guardianGemDeck.slice(3),
  ]
  const owner = run.players[0]
  owner.cardRewards = ['guardian_crystal_edge', 'guardian_orb_slam', 'guardian_overload']
  run = { ...run, phase: 'reward', neow: null, rewardDestination: 'map', rewards: [{
    playerId: owner.id, cardReward: true, choices: null, upgraded: false,
    potion: false, relic: false, bossRelics: false,
  }] }
  run = revealCardReward(run, owner.id)
  assert.deepEqual(run.rewards[0].guardianGems, ['guardian_ruby', 'guardian_onyx'])
  assert.equal(run.guardianGemDeck.at(-1), 'guardian_ruby', 'duplicate revealed Gem was not replaced and bottomed')
  assert.equal(run.rewards[0].guardianGems.length, 2)
  assert.equal(run.guardianGemDeck.length, 22)
  run = resolveCardRewards(run, { [owner.id]: 0 })
  assert.equal(run.pendingGuardianSockets.length, 1)
  const pending = run.pendingGuardianSockets[0]
  run = resolveGuardianSocket(run, owner.id, pending.gemIds[1])
  assert.equal(run.pendingGuardianSockets.length, 0)
  assert.equal(run.guardianGemDeck.length, 23)
  assert.equal(run.players[0].deck.find((card) => card.uid === pending.cardUid).attachedGemId, pending.gemIds[1])
})

check('Event Card Rewards replace duplicate faces and attach the chosen Socket Gem', () => {
  let run = createRun(446, [{ id: 'p1', name: 'Guardian', character: 'guardian' }])
  const owner = run.players[0]
  owner.cardRewards = ['guardian_crystal_edge', 'guardian_crystal_edge', 'guardian_orb_slam', 'guardian_overload']
  run.guardianGemDeck = ['guardian_ruby', 'guardian_ruby', 'guardian_onyx', ...run.guardianGemDeck.slice(3)]
  run = { ...run, phase: 'room', neow: null, roomState: createEventRoom({
    ...EVENT_DEFINITIONS.cursed_tome,
    instanceId: 'guardian-event-reward', act: 1, minAscension: 0, requiresColorlessUnlock: false,
  }) }
  run = chooseEvent(run, owner.id, { optionIds: ['skim'] })
  assert.deepEqual(run.roomState?.kind === 'event' ? run.roomState.rewardOffers?.[owner.id]?.[0] : null,
    ['guardian_crystal_edge', 'guardian_orb_slam', 'guardian_overload'])
  assert.deepEqual(run.roomState?.kind === 'event' ? run.roomState.guardianGemOffers?.[owner.id]?.[0] : null,
    ['guardian_ruby', 'guardian_onyx'])
  assert.equal(chooseEvent(run, owner.id, { optionIds: ['skim'], rewardIndexes: [0] }), run,
    'a Socket reward cannot be taken without choosing its revealed Gem')
  run = chooseEvent(run, owner.id, {
    optionIds: ['skim'], rewardIndexes: [0], guardianGemIds: ['guardian_onyx'],
  })
  assert.equal(run.pendingGuardianSockets.length, 0)
  assert.equal(run.players[0].deck.find((card) => card.defId === 'guardian_crystal_edge')?.attachedGemId,
    'guardian_onyx')
  assert.equal(run.guardianGemDeck.at(-1), 'guardian_ruby')
})

check('Merchant Socket buys replenish revealed Gems and stop after two cards', () => {
  let run = createRun(418, [{ id: 'p1', name: 'Guardian', character: 'guardian' }])
  run.players[0].gold = 10
  run.players[0].cardRewards = ['guardian_crystal_edge', 'guardian_walker_claw', 'guardian_fierce_bash']
  const guardianGemDeck = [...run.guardianGemDeck]
  const roomState = createMerchant(run.itemDecks, run.players, guardianGemDeck)
  run = { ...run, phase: 'room', neow: null, roomState, guardianGemDeck }
  assert.equal(roomState.guardianGems.p1.length, 2)
  run = purchaseAtMerchant(run, { buyerId: 'p1', section: 'card', slot: 0, payments: { p1: 2 } })
  run = resolveGuardianSocket(run, 'p1', run.pendingGuardianSockets[0].gemIds[0])
  assert.equal(run.roomState.guardianGems.p1.length, 2)
  run = purchaseAtMerchant(run, { buyerId: 'p1', section: 'card', slot: 1, payments: { p1: 2 } })
  run = resolveGuardianSocket(run, 'p1', run.pendingGuardianSockets[0].gemIds[0])
  assert.equal(run.roomState.socketCardsBought.p1, 2)
  const refused = purchaseAtMerchant(run, { buyerId: 'p1', section: 'card', slot: 2, payments: { p1: 2 } })
  assert.equal(refused, run)
})

check('Transforming Brew persists a combat transform and queues its new Socket after victory', () => {
  let run = createRun(426, [{ id: 'p1', name: 'Guardian', character: 'guardian' }])
  run.neow = null
  const original = run.players[0].deck[0]
  const combatPlayer = structuredClone(run.players[0])
  combatPlayer.hand = [{ ...original }]
  combatPlayer.draw = []
  combatPlayer.discard = []
  combatPlayer.exhaust = []
  combatPlayer.potions = ['transforming_brew']
  combatPlayer.cardRewards = ['guardian_crystal_edge']
  let combat = createCombat({ seed: 426, calls: 0 }, [combatPlayer], [{
    uid: 'brew-enemy', defId: 'cultist', row: 0, isBoss: false, hp: 1, maxHp: 1, block: 0,
    strength: 0, vulnerable: 0, weak: 0, poison: 0, goldReward: 0, cardReward: null,
    actionIndex: 0, abilityUsed: false, dead: false,
  }], 'brew', [], 3, {}, false, 'downfall')
  combat = activatePotion(combat, 'p1', 'transforming_brew', { transformHandUid: original.uid })
  combat.phase = 'won'
  combat.enemies[0].hp = 0
  combat.enemies[0].dead = true
  run = resolveCombat({ ...run, phase: 'combat', combat })
  assert.equal(run.players[0].deck.find((card) => card.uid === original.uid).defId, 'guardian_crystal_edge')
  assert.deepEqual(run.players[0].cardRewards, [])
  assert.equal(run.pendingGuardianSockets[0].cardUid, original.uid)
})

check('Transforming Brew replaces same-definition socket metadata', () => {
  let run = createRun(427, [{ id: 'p1', name: 'Guardian', character: 'guardian' }])
  run.neow = null
  const original = { ...run.players[0].deck[0], defId: 'guardian_crystal_edge', attachedGemId: 'guardian_ruby' }
  run.players[0].deck[0] = original
  const combatPlayer = structuredClone(run.players[0])
  combatPlayer.hand = [{ ...original }]
  combatPlayer.draw = []
  combatPlayer.discard = []
  combatPlayer.exhaust = []
  combatPlayer.potions = ['transforming_brew']
  combatPlayer.cardRewards = ['golden_ticket']
  combatPlayer.rareRewards = ['guardian_crystal_edge']
  let combat = createCombat({ seed: 427, calls: 0 }, [combatPlayer], [{
    uid: 'brew-enemy', defId: 'cultist', row: 0, isBoss: false, hp: 1, maxHp: 1, block: 0,
    strength: 0, vulnerable: 0, weak: 0, poison: 0, goldReward: 0, cardReward: null,
    actionIndex: 0, abilityUsed: false, dead: false,
  }], 'brew', [], 3, {}, false, 'downfall')
  combat = activatePotion(combat, 'p1', 'transforming_brew', { transformHandUid: original.uid })
  assert.deepEqual(combat.players[0].cardRewards, ['golden_ticket'])
  assert.deepEqual(combat.players[0].rareRewards, [])
  assert.equal(combat.players[0].deck.find((card) => card.uid === original.uid).attachedGemId, undefined)
  combat.phase = 'won'
  combat.enemies[0].hp = 0
  combat.enemies[0].dead = true
  run = resolveCombat({ ...run, phase: 'combat', combat })
  const transformed = run.players[0].deck.find((card) => card.uid === original.uid)
  assert.equal(transformed.defId, 'guardian_crystal_edge')
  assert.equal(transformed.attachedGemId, undefined)
  assert.deepEqual(run.players[0].cardRewards, ['golden_ticket'])
  assert.deepEqual(run.players[0].rareRewards, [])
  assert.equal(run.pendingGuardianSockets[0].cardUid, original.uid)
})

check('Terminal defeat skips a Socket choice created by Transforming Brew', () => {
  let run = createRun(428, [{ id: 'p1', name: 'Guardian', character: 'guardian' }])
  run.neow = null
  run.meta = { ...run.meta, mode: 'custom', modifierIds: ['terminal'] }
  run.players[0].hp = 1
  const original = run.players[0].deck[0]
  const combatPlayer = structuredClone(run.players[0])
  combatPlayer.hand = [{ ...original }]
  combatPlayer.draw = []
  combatPlayer.discard = []
  combatPlayer.exhaust = []
  combatPlayer.potions = ['transforming_brew']
  combatPlayer.cardRewards = ['guardian_crystal_edge']
  let combat = createCombat({ seed: 428, calls: 0 }, [combatPlayer], [{
    uid: 'brew-enemy', defId: 'cultist', row: 0, isBoss: false, hp: 1, maxHp: 1, block: 0,
    strength: 0, vulnerable: 0, weak: 0, poison: 0, goldReward: 0, cardReward: null,
    actionIndex: 0, abilityUsed: false, dead: false,
  }], 'brew', [], 3, {}, false, 'downfall')
  combat = activatePotion(combat, 'p1', 'transforming_brew', { transformHandUid: original.uid })
  combat.phase = 'won'
  combat.enemies[0].hp = 0
  combat.enemies[0].dead = true
  run = resolveCombat({ ...run, phase: 'combat', combat })
  assert.equal(run.phase, 'defeat')
  assert.equal(run.pendingGuardianSockets.length, 0)
})

check('combat victory strips Stasis metadata from the master deck', () => {
  let run = createRun(429, [{ id: 'p1', name: 'Guardian', character: 'guardian' }])
  run.neow = null
  const combatPlayer = structuredClone(run.players[0])
  combatPlayer.hand = [combatPlayer.deck[0]]
  combatPlayer.hand[0].stasisRetained = true
  const combat = createCombat({ seed: 429, calls: 0 }, [combatPlayer], [{
    uid: 'stasis-enemy', defId: 'cultist', row: 0, isBoss: false, hp: 0, maxHp: 1, block: 0,
    strength: 0, vulnerable: 0, weak: 0, poison: 0, goldReward: 0, cardReward: null,
    actionIndex: 0, abilityUsed: false, dead: true,
  }], 'stasis-win', [], 3, {}, false, 'downfall')
  combat.phase = 'won'
  run = resolveCombat({ ...run, phase: 'combat', combat })
  assert.equal(run.players[0].deck[0].stasisRetained, undefined)
})

check('Transforming Brew keeps a Burning Elite Burn transformed into a Socket', () => {
  let run = createRun(430, [{ id: 'p1', name: 'Guardian', character: 'guardian' }])
  run.neow = null
  const burn = { uid: 'burning-brew', defId: 'burn', upgraded: false }
  run.players[0].deck = [burn]
  const combatPlayer = structuredClone(run.players[0])
  combatPlayer.hand = [combatPlayer.deck[0]]
  combatPlayer.draw = []
  combatPlayer.discard = []
  combatPlayer.exhaust = []
  combatPlayer.potions = ['transforming_brew']
  combatPlayer.cardRewards = ['guardian_crystal_edge']
  let combat = createCombat({ seed: 430, calls: 0 }, [combatPlayer], [{
    uid: 'burn-enemy', defId: 'cultist', row: 0, isBoss: false, hp: 1, maxHp: 1, block: 0,
    strength: 0, vulnerable: 0, weak: 0, poison: 0, goldReward: 0, cardReward: null,
    actionIndex: 0, abilityUsed: false, dead: false,
  }], 'burn-brew', [], 3, {}, false, 'downfall')
  combat = activatePotion(combat, 'p1', 'transforming_brew', { transformHandUid: burn.uid })
  assert.deepEqual(combat.players[0].cardRewards, [])
  combat.phase = 'won'
  combat.enemies[0].hp = 0
  combat.enemies[0].dead = true
  run = resolveCombat({ ...run, phase: 'combat', combat })
  assert.equal(run.players[0].deck[0].defId, 'guardian_crystal_edge')
  assert.deepEqual(run.players[0].cardRewards, [])
  assert.equal(run.pendingGuardianSockets[0].cardUid, burn.uid)
})

check('Guardian Powers execute their printed live combat rules', () => {
  const enemy = () => ({ uid: 'e1', defId: 'jaw_worm', row: 0, isBoss: false, hp: 20, maxHp: 20,
    block: 0, strength: 0, vulnerable: 0, weak: 0, poison: 0, goldReward: 0,
    cardReward: null, actionIndex: 0, abilityUsed: false, dead: false })
  const fresh = () => createRun(419, [{ id: 'p1', name: 'Guardian', character: 'guardian' }]).players[0]

  let player = fresh()
  player.hand = [
    { uid: 'attack-mode', defId: 'guardian_twin_slam', upgraded: false },
    { uid: 'plain', defId: 'guardian_defend', upgraded: false },
  ]
  player.draw = []
  player.discard = []
  player.powers = [{ uid: 'future', defId: 'guardian_future_plans', upgraded: false }]
  let combat = createCombat({ seed: 419, calls: 0 }, [player], [enemy()], 'future')
  combat = endPlayerTurn(combat)
  assert.deepEqual(combat.players[0].hand.map((card) => card.uid), ['attack-mode'])
  assert.deepEqual(combat.players[0].discard.map((card) => card.uid), ['plain'])

  player = fresh()
  player.energy = 3
  player.hand = [{ uid: 'strike', defId: 'guardian_strike', upgraded: false }]
  player.powers = [{ uid: 'revenge', defId: 'guardian_revenge_protocol', upgraded: false }]
  combat = createCombat({ seed: 420, calls: 0 }, [player], [enemy()], 'revenge')
  combat = activatePower(combat, 'p1', 'revenge', { cardUid: 'strike' })
  assert.equal(combat.startTurnProgress.forcedCard.cardUid, 'strike')
  combat = playCard(combat, 'p1', 'strike', { enemyUid: 'e1', playerId: 'p1' })
  assert.equal(combat.players[0].energy, 3)

  player = fresh()
  player.hand = []
  player.draw = [
    { uid: 'gem', defId: 'guardian_crystal_edge', upgraded: false },
    { uid: 'other', defId: 'guardian_defend', upgraded: false },
  ]
  player.discard = []
  player.powers = [{ uid: 'finder', defId: 'guardian_gem_finder', upgraded: false }]
  combat = createCombat({ seed: 421, calls: 0 }, [player], [enemy()], 'finder')
  assert.deepEqual(previewPowerChoice(combat, 'p1', 'finder').cards.map((card) => card.uid), ['gem', 'other'])
  combat = activatePower(combat, 'p1', 'finder', { scryDiscardUids: ['other'] })
  assert(combat.players[0].hand.some((card) => card.uid === 'gem'))
  assert(combat.players[0].discard.some((card) => card.uid === 'other'))

  player = fresh()
  player.powers = [{ uid: 'orbs', defId: 'guardian_floating_orbs', upgraded: false, attachedGemId: 'guardian_ruby' }]
  combat = createCombat({ seed: 422, calls: 0 }, [player], [enemy()], 'orbs')
  combat = activatePower(combat, 'p1', 'orbs', { enemyUid: 'e1' })
  assert.equal(combat.enemies[0].hp, 19)

  player = fresh()
  player.hand = [
    { uid: 'jasper-a', defId: 'guardian_strike', upgraded: false },
    { uid: 'jasper-b', defId: 'guardian_defend', upgraded: false },
  ]
  player.powers = [{ uid: 'jasper-orbs', defId: 'guardian_floating_orbs', upgraded: false,
    attachedGemId: 'guardian_jasper' }]
  combat = createCombat({ seed: 423, calls: 0 }, [player], [enemy()], 'jasper-orbs')
  combat = activatePower(combat, 'p1', 'jasper-orbs', { exhaustUids: ['jasper-a', 'jasper-b'] })
  assert.deepEqual(combat.players[0].exhaust.map((card) => card.uid), ['jasper-a', 'jasper-b'])

  const ally = createRun(424, [{ id: 'p2', name: 'Defect', character: 'defect' }]).players[0]
  player = fresh()
  player.powers = [{ uid: 'onyx-orbs', defId: 'guardian_floating_orbs', upgraded: false,
    attachedGemId: 'guardian_onyx' }]
  ally.weak = 2
  ally.vulnerable = 2
  combat = createCombat({ seed: 424, calls: 0 }, [player, ally], [enemy()], 'onyx-orbs')
  combat = activatePower(combat, 'p1', 'onyx-orbs', { playerId: 'p2' })
  assert.deepEqual([combat.players[1].weak, combat.players[1].vulnerable], [0, 0])

  player = fresh()
  player.powers = [{ uid: 'amethyst-orbs', defId: 'guardian_floating_orbs', upgraded: false,
    attachedGemId: 'guardian_amethyst' }]
  combat = createCombat({ seed: 425, calls: 0 }, [player], [enemy()], 'amethyst-orbs')
  combat = activatePower(combat, 'p1', 'amethyst-orbs', { guardianModeShift: true })
  assert.equal(combat.players[0].guardianMode, 'defense')
})

check('active Powers remain usable during legal Start- and End-of-Turn windows', () => {
  const enemy = () => ({ uid: 'e1', defId: 'jaw_worm', row: 0, isBoss: false, hp: 20, maxHp: 20,
    block: 0, strength: 0, vulnerable: 0, weak: 0, poison: 0, goldReward: 0,
    cardReward: null, actionIndex: 0, abilityUsed: false, dead: false })
  const fresh = () => createRun(809, [{ id: 'p1', name: 'Guardian', character: 'guardian' }]).players[0]

  let player = fresh()
  player.hand = [{ uid: 'strike', defId: 'guardian_strike', upgraded: false }]
  player.powers = [{ uid: 'revenge', defId: 'guardian_revenge_protocol', upgraded: false }]
  let combat = createCombat({ seed: 809, calls: 0 }, [player], [enemy()], 'start-power')
  combat.phase = 'start'
  combat.startTurnStage = 'effects'
  combat = activatePower(combat, 'p1', 'revenge', { cardUid: 'strike' })
  assert.equal(combat.startTurnProgress?.forcedCard?.cardUid, 'strike')
  combat = playCard(combat, 'p1', 'strike', { enemyUid: 'e1', playerId: 'p1' })
  assert.equal(combat.phase, 'start', 'a Start-of-Turn Power skipped the remaining Start phase')
  assert(startTurnAbilities(combat).some((ability) => ability.guardianModeShift),
    'the Guardian printed Start-of-Turn choice disappeared')

  player = fresh()
  player.hand = [{ uid: 'strike', defId: 'guardian_strike', upgraded: false }]
  player.powers = [{ uid: 'revenge', defId: 'guardian_revenge_protocol', upgraded: false }]
  combat = createCombat({ seed: 810, calls: 0 }, [player], [enemy()], 'end-power')
  combat.phase = 'discard'
  combat = activatePower(combat, 'p1', 'revenge', { cardUid: 'strike' })
  combat = playCard(combat, 'p1', 'strike', { enemyUid: 'e1', playerId: 'p1' })
  assert.equal(combat.phase, 'discard')
  assert.equal(combat.enemies[0].hp, 19)

  player = fresh()
  player.draw = [{ uid: 'gem', defId: 'guardian_crystal_edge', upgraded: false }]
  player.powers = [{ uid: 'finder', defId: 'guardian_gem_finder', upgraded: false }]
  combat = createCombat({ seed: 811, calls: 0 }, [player], [enemy()], 'end-preview')
  combat.phase = 'discard'
  assert.deepEqual(previewPowerChoice(combat, 'p1', 'finder')?.cards.map((card) => card.uid), ['gem'])
  combat.phase = 'start'
  combat.startTurnProgress = { choices: [], rollPending: { drewFrom: 0 } }
  assert.equal(activatePower(combat, 'p1', 'finder'), combat,
    'an active Power interrupted the mandatory Draw/Roll step')
})

check('Blitz can be ordered before a free-Power effect', () => {
  const player = createRun(812, [{ id: 'p1', name: 'Guardian', character: 'guardian' }]).players[0]
  player.nextCardCost = 1
  player.freePowersThisTurn = 1
  assert.equal(playCost(faceOf(CARDS.guardian_floating_orbs, false), player), 0)
  player.freePowersThisTurn = 0
  player.powers = [{ uid: 'construction', defId: 'guardian_construction_form', upgraded: false }]
  assert.equal(playCost(faceOf(CARDS.guardian_floating_orbs, false), player), 0)
})

check('a copied Gem card triggers Brilliant Scales for both plays', () => {
  const player = createRun(813, [{ id: 'p1', name: 'Guardian', character: 'guardian' }]).players[0]
  player.energy = 3
  player.block = 0
  player.hand = [{ uid: 'copied-harden', defId: 'guardian_harden', upgraded: false }]
  player.powers = [{ uid: 'scales', defId: 'guardian_brilliant_scales', upgraded: false }]
  let combat = createCombat({ seed: 813, calls: 0 }, [player], [{
    uid: 'e1', defId: 'jaw_worm', row: 0, isBoss: false, hp: 20, maxHp: 20,
    block: 0, strength: 0, vulnerable: 0, weak: 0, poison: 0, goldReward: 0,
    cardReward: null, actionIndex: 0, abilityUsed: false, dead: false,
  }], 'copied-gem')
  combat.players[0].doubledCardsThisTurn = 1
  combat = playCard(combat, 'p1', 'copied-harden', { playerId: 'p1' })
  assert.equal(combat.players[0].block, 4)
  combat = playCardCopy(combat, 'p1', { playerId: 'p1' })
  assert.equal(combat.players[0].block, 8)
  assert.equal(combat.log.filter((line) => line.includes('Brilliant Scales grants 1 Block')).length, 2)
})

check('reviewed Guardian Power timing, selection, and Retain rules resolve exactly', () => {
  const enemy = () => ({ uid: 'e1', defId: 'jaw_worm', row: 0, isBoss: false, hp: 30, maxHp: 30,
    block: 0, strength: 0, vulnerable: 0, weak: 0, poison: 0, goldReward: 0,
    cardReward: null, actionIndex: 0, abilityUsed: false, dead: false })
  const fresh = (seed) => createRun(seed, [{ id: 'p1', name: 'Guardian', character: 'guardian' }]).players[0]

  let player = fresh(434)
  player.energy = 5
  player.hand = [
    { uid: 'repulsor', defId: 'guardian_repulsor', upgraded: false },
    { uid: 'crystallize', defId: 'guardian_crystallize', upgraded: false, attachedGemId: 'guardian_ruby' },
    { uid: 'strike', defId: 'guardian_strike', upgraded: false },
  ]
  let combat = createCombat({ seed: 434, calls: 0 }, [player], [enemy()], 'guardian-live-timing')
  combat = playCard(combat, 'p1', 'repulsor')
  assert.equal(combat.players[0].guardianMode, 'defense', 'Repulsor did not Mode Shift when played')
  combat = playCard(combat, 'p1', 'crystallize', { enemyUid: 'e1', playerId: 'p1' })
  combat = playCard(combat, 'p1', 'strike', { enemyUid: 'e1', playerId: 'p1' })
  assert.equal(combat.enemies[0].hp, 27, 'Crystallize did not add its socketed Ruby to a starter Strike')
  combat = endPlayerTurn(combat)
  combat = startPlayerTurn(enemyTurn(combat))
  assert.equal(combat.players[0].energy, 4,
    'Repulsor did not grant Energy at Start of Turn')

  player = fresh(4341)
  player.hand = [
    { uid: 'crystallize-onyx', defId: 'guardian_crystallize', upgraded: false,
      attachedGemId: 'guardian_onyx' },
    { uid: 'crystallize-retain', defId: 'guardian_strike', upgraded: false },
  ]
  combat = createCombat({ seed: 4341, calls: 0 }, [player], [enemy()], 'guardian-crystallize-onyx')
  combat = playCard(combat, 'p1', 'crystallize-onyx', { enemyUid: null, playerId: 'p1' })
  combat = endPlayerTurn(combat)
  assert(combat.players[0].hand.some((card) => card.uid === 'crystallize-retain'),
    'Crystallize did not apply its socketed Onyx Retain to a starter Strike')

  player = fresh(435)
  player.energy = 5
  player.guardianMode = 'defense'
  player.hand = [{ uid: 'beam', defId: 'guardian_power_beam', upgraded: false }]
  player.discard = [{ uid: 'future', defId: 'guardian_future_plans', upgraded: false }]
  combat = createCombat({ seed: 435, calls: 0 }, [player], [enemy()], 'guardian-power-beam')
  combat.players[0].guardianMode = 'defense'
  assert.equal(playCard(combat, 'p1', 'beam', { enemyUid: 'e1', playerId: 'p1' }), combat,
    'Power Beam accepted no Defense-mode Power choice')
  combat = playCard(combat, 'p1', 'beam', {
    enemyUid: 'e1', playerId: 'p1', guardianPowerCardUid: 'future',
  })
  assert.equal(combat.startTurnProgress.forcedCard.cardUid, 'future')
  assert(combat.players[0].hand.some((card) => card.uid === 'future'))
  combat = playCard(combat, 'p1', 'future')
  assert.equal(combat.players[0].energy, 3, 'Power Beam charged Energy for the chosen Power')
  assert(combat.players[0].powers.some((card) => card.uid === 'future'))

  player = fresh(436)
  player.energy = 5
  player.hand = [
    { uid: 'construction', defId: 'guardian_construction_form', upgraded: false },
    { uid: 'scales', defId: 'guardian_brilliant_scales', upgraded: false },
  ]
  combat = createCombat({ seed: 436, calls: 0 }, [player], [enemy()], 'guardian-construction')
  combat = playCard(combat, 'p1', 'construction')
  assert.equal(combat.players[0].block, 0, 'Construction Form triggered on itself')
  combat = playCard(combat, 'p1', 'scales')
  assert.equal(combat.players[0].block, 1, 'Construction Form did not trigger on another Power')

  player = fresh(437)
  player.hand = [
    { uid: 'onyx-host', defId: 'guardian_harden', upgraded: false, attachedGemId: 'guardian_onyx' },
    { uid: 'plain', defId: 'guardian_defend', upgraded: false },
  ]
  combat = createCombat({ seed: 437, calls: 0 }, [player], [enemy()], 'guardian-onyx-retain')
  combat = endPlayerTurn(combat)
  assert.deepEqual(combat.players[0].hand.map((card) => card.uid), ['onyx-host'])

  player = fresh(438)
  player.hand = [
    { uid: 'stasis-a', defId: 'guardian_strike', upgraded: false },
    { uid: 'stasis-b', defId: 'guardian_harden', upgraded: false, attachedGemId: 'guardian_onyx' },
  ]
  player.powers = [{ uid: 'stasis-engine', defId: 'guardian_stasis_engine', upgraded: false }]
  combat = createCombat({ seed: 438, calls: 0 }, [player], [enemy()], 'guardian-stasis-engine')
  const abilities = endTurnAbilities(combat)
  const stasis = abilities.find((ability) => ability.label.includes('Stasis Engine'))
  const order = defaultEndTurnOrder(abilities).map((choice) =>
    choice.startsWith(stasis.id) ? chooseEndTurnTarget(stasis.id, 'stasis-b') : choice)
  combat = beginEndPlayerTurn(combat, order)
  const retained = combat.players[0].hand.find((card) => card.uid === 'stasis-b')
  assert.equal(retained?.stasisRetained, true)
  assert.equal(playCost(faceOf(CARDS[retained.defId], retained.upgraded), combat.players[0], retained), 0)
  combat = endPlayerTurn(combat)
  combat = startPlayerTurn(enemyTurn(combat))
  assert.equal(playCost(faceOf(CARDS[retained.defId], retained.upgraded), combat.players[0],
    combat.players[0].hand.find((card) => card.uid === retained.uid)), 0)
  const laterAbilities = endTurnAbilities(combat)
  const laterStasis = laterAbilities.find((ability) => ability.label.includes('Stasis Engine'))
  const skipOrder = defaultEndTurnOrder(laterAbilities).map((choice) =>
    choice.startsWith(laterStasis.id) ? chooseEndTurnTarget(laterStasis.id, 'skip') : choice)
  combat = endPlayerTurn(beginEndPlayerTurn(combat, skipOrder))
  combat = startPlayerTurn(enemyTurn(combat))
  const naturallyRetained = combat.players[0].hand.find((card) => card.uid === retained.uid)
  assert(naturallyRetained && !naturallyRetained.stasisRetained)
  assert.equal(playCost(faceOf(CARDS[naturallyRetained.defId], naturallyRetained.upgraded),
    combat.players[0], naturallyRetained), 2)

  player = fresh(4381)
  player.hand = [
    { uid: 'stasis-ethereal', defId: 'daze', upgraded: false },
    { uid: 'stasis-survivor', defId: 'guardian_strike', upgraded: false },
  ]
  player.powers = [{ uid: 'stasis-engine-stale', defId: 'guardian_stasis_engine', upgraded: false }]
  combat = createCombat({ seed: 4381, calls: 0 }, [player], [enemy()], 'guardian-stasis-stale')
  const staleAbilities = endTurnAbilities(combat)
  const staleStasis = staleAbilities.find((ability) => ability.label.includes('Stasis Engine'))
  const ethereal = staleAbilities.find((ability) => ability.id.endsWith('/card:stasis-ethereal'))
  const staleOrder = defaultEndTurnOrder(staleAbilities)
    .filter((choice) => !choice.startsWith(staleStasis.id) && choice !== ethereal.id)
  combat = beginEndPlayerTurn(combat, [
    ethereal.id,
    chooseEndTurnTarget(staleStasis.id, 'stasis-ethereal'),
    ...staleOrder,
  ])
  assert(combat.players[0].exhaust.some((card) => card.uid === 'stasis-ethereal'))
  assert(!combat.players[0].hand.find((card) => card.uid === 'stasis-survivor')?.stasisRetained,
    'Stasis Engine retargeted after its chosen card left the hand')

  player = fresh(439)
  player.guardianMode = 'defense'
  player.hand = []
  player.draw = [
    { uid: 'forecast-a', defId: 'guardian_strike', upgraded: false },
    { uid: 'forecast-b', defId: 'guardian_defend', upgraded: false },
    { uid: 'forecast-c', defId: 'guardian_strike', upgraded: false },
  ]
  player.powers = [{ uid: 'forecasting', defId: 'guardian_forecasting', upgraded: false }]
  combat = createCombat({ seed: 439, calls: 0 }, [player], [enemy()], 'guardian-forecasting')
  combat.players[0].guardianMode = 'defense'
  combat = beginEndPlayerTurn(combat)
  assert.deepEqual(combat.players[0].hand.map((card) => card.uid), ['forecast-a', 'forecast-b'])
  assert.deepEqual(combat.players[0].draw.map((card) => card.uid), ['forecast-c'])
})

check('Guardian board Mode Shift, colorless Vigor, and Exhaust recovery use explicit choices', () => {
  const enemy = { uid: 'e1', defId: 'jaw_worm', row: 0, isBoss: false, hp: 20, maxHp: 20,
    block: 0, strength: 0, vulnerable: 0, weak: 0, poison: 0, goldReward: 0,
    cardReward: null, actionIndex: 0, abilityUsed: false, dead: false }
  let player = createRun(440, [{ id: 'p1', name: 'Guardian', character: 'guardian' }]).players[0]
  let combat = preparePlayerTurn(createCombat({ seed: 440, calls: 0 }, [player], [enemy], 'guardian-mode-shift'))
  const modeAbility = startTurnAbilities(combat).find((ability) => ability.guardianModeShift)
  assert(modeAbility)
  const choices = startTurnAbilities(combat).map((ability) => ({
    id: ability.id,
    guardianModeShift: ability.id === modeAbility.id,
    shivEnemyUids: [],
    evokeSlots: [],
    evokeEnemyUids: [],
  }))
  combat = resolveStartPlayerTurn(combat, choices)
  assert.equal(combat.players[0].guardianMode, 'defense')

  player = createRun(441, [{ id: 'p1', name: 'Guardian', character: 'guardian' }]).players[0]
  player.guardianMode = 'attack'
  player.energy = 3
  player.vigor = 1
  player.hand = [{ uid: 'bite', defId: 'bite', upgraded: false }]
  combat = createCombat({ seed: 441, calls: 0 }, [player], [enemy], 'guardian-colorless-vigor')
  combat = playCard(combat, 'p1', 'bite', { enemyUid: 'e1', playerId: 'p1', spendVigor: 1 })
  assert.equal(combat.enemies[0].hp, 17)

  player = createRun(442, [{ id: 'p1', name: 'Guardian', character: 'guardian' }]).players[0]
  player.energy = 3
  player.hand = [{ uid: 'breath', defId: 'deep_breath', upgraded: true }]
  player.exhaust = [
    { uid: 'recover-a', defId: 'guardian_strike', upgraded: false },
    { uid: 'recover-b', defId: 'guardian_defend', upgraded: false },
    { uid: 'leave', defId: 'guardian_harden', upgraded: false },
  ]
  combat = createCombat({ seed: 442, calls: 0 }, [player], [enemy], 'downfall-deep-breath')
  assert.equal(playCard(combat, 'p1', 'breath'), combat, 'Deep Breath accepted no Exhaust-pile choice')
  combat = playCard(combat, 'p1', 'breath', { enemyUid: null, playerId: 'p1',
    recoverExhaustUids: ['recover-b', 'recover-a'] })
  assert.deepEqual(combat.players[0].exhaust.map((card) => card.uid), ['leave', 'breath'])
  assert.deepEqual(combat.players[0].discard.slice(-2).map((card) => card.uid), ['recover-b', 'recover-a'])

  const eerieCombat = (seed, upgraded = false) => {
    const hexaghost = createRun(seed, [{ id: 'p1', name: 'Hexaghost', character: 'hexaghost' }]).players[0]
    hexaghost.energy = 3
    hexaghost.hand = [{ uid: 'expedition', defId: 'eerie_expedition', upgraded }]
    hexaghost.draw = []
    hexaghost.exhaust = [
      { uid: 'draw-a', defId: 'strike_hexaghost', upgraded: false },
      { uid: 'draw-b', defId: 'defend_hexaghost', upgraded: false },
      { uid: 'draw-leave', defId: 'sear', upgraded: false },
    ]
    return createCombat({ seed, calls: 0 }, [hexaghost], [enemy], `downfall-eerie-expedition-${seed}`)
  }
  combat = playCard(eerieCombat(443), 'p1', 'expedition')
  assert.deepEqual(combat.players[0].draw, [], 'Eerie Expedition could not choose zero cards')
  assert.deepEqual(combat.players[0].exhaust.map((card) => card.uid),
    ['draw-a', 'draw-b', 'draw-leave', 'expedition'])

  combat = playCard(eerieCombat(444), 'p1', 'expedition', { enemyUid: null, playerId: 'p1',
    recoverExhaustUids: ['draw-b'] })
  assert.deepEqual(combat.players[0].draw.slice(0, 1).map((card) => card.uid), ['draw-b'])
  assert.deepEqual(combat.players[0].exhaust.map((card) => card.uid), ['draw-a', 'draw-leave', 'expedition'])

  combat = eerieCombat(445, true)
  combat = playCard(combat, 'p1', 'expedition', { enemyUid: null, playerId: 'p1',
    recoverExhaustUids: ['draw-b', 'draw-a', 'draw-leave'] })
  assert.deepEqual(combat.players[0].draw.slice(0, 3).map((card) => card.uid),
    ['draw-b', 'draw-a', 'draw-leave'])
  assert.deepEqual(combat.players[0].exhaust.map((card) => card.uid), ['expedition'])
})

check('starter identity uses printed metadata for every Downfall deck', () => {
  for (const id of ['guardian_strike', 'strike_hexaghost', 'slime_boss_strike', 'hermit_strike']) {
    assert.equal(isStarterStrikeOrDefend(id, 'Strike'), true, id)
  }
  for (const id of ['guardian_defend', 'defend_hexaghost', 'slime_boss_defend', 'hermit_defend']) {
    assert.equal(isStarterStrikeOrDefend(id, 'Defend'), true, id)
  }

  let run = createRun(424, [{ id: 'p1', name: 'Guardian', character: 'guardian' }])
  const firstDefend = run.players[0].deck.find((card) => card.defId === 'guardian_defend')
  const secondDefend = run.players[0].deck.find((card) => card.defId === 'guardian_defend' && card.uid !== firstDefend.uid)
  assert(!pendingRelicEligibleCards(run.players[0], 'war_paint').some((card) => card.uid === firstDefend.uid))
  run = acquireRelic({ ...run, phase: 'map' }, 'p1', 'war_paint')
  run = resolvePendingRelic(run, 'p1', [secondDefend.uid])
  assert(run.players[0].deck.find((card) => card.uid === firstDefend.uid).upgraded)
  assert(run.players[0].deck.find((card) => card.uid === secondDefend.uid).upgraded)

  const player = createRun(425, [{ id: 'p1', name: 'Guardian', character: 'guardian' }]).players[0]
  player.hand = [{ uid: 'strike', defId: 'guardian_strike', upgraded: false }]
  player.relics.push({ defId: 'strike_dummy', spent: false })
  let combat = createCombat({ seed: 425, calls: 0 }, [player], [{
    uid: 'e1', defId: 'jaw_worm', row: 0, isBoss: false, hp: 20, maxHp: 20, block: 0,
    strength: 0, vulnerable: 0, weak: 0, poison: 0, goldReward: 0, cardReward: null,
    actionIndex: 0, abilityUsed: false, dead: false,
  }], 'starter-bonus')
  combat = playCard(combat, 'p1', 'strike', { enemyUid: 'e1', playerId: 'p1' })
  assert.equal(combat.enemies[0].hp, 18)
})

check('Guardian card and socket choices are enforced by the shared play path', () => {
  const run = createRun(426, [
    { id: 'p1', name: 'Guardian', character: 'guardian' },
    { id: 'p2', name: 'Defect', character: 'defect' },
  ])
  const foe = {
    uid: 'e1', defId: 'jaw_worm', row: 0, isBoss: false, hp: 20, maxHp: 20, block: 0,
    strength: 0, vulnerable: 0, weak: 0, poison: 0, goldReward: 0, cardReward: null,
    actionIndex: 0, abilityUsed: false, dead: false,
  }
  run.players[0].hand = [{ uid: 'stasis', defId: 'guardian_stasis_field', upgraded: false }]
  run.players[0].energy = 3
  let combat = createCombat({ seed: 426, calls: 0 }, run.players, [foe], 'guardian-choices')
  assert.equal(playCard(combat, 'p1', 'stasis', { enemyUid: null, playerId: null }), combat,
    'Stasis Field resolved without assigning its three Block icons')
  combat = playCard(combat, 'p1', 'stasis', {
    enemyUid: null, playerId: null, playerIds: ['p1', 'p2', 'p2'],
  })
  assert.deepEqual(combat.players.map((player) => player.block), [1, 2])

  const socketRun = createRun(427, [
    { id: 'p1', name: 'Guardian', character: 'guardian' },
    { id: 'p2', name: 'Defect', character: 'defect' },
  ])
  socketRun.players[0].hand = [
    { uid: 'harden', defId: 'guardian_harden', upgraded: false, attachedGemId: 'guardian_jasper' },
    { uid: 'spare-a', defId: 'guardian_defend', upgraded: false },
    { uid: 'spare-b', defId: 'guardian_strike', upgraded: false },
  ]
  socketRun.players[0].energy = 2
  combat = createCombat({ seed: 427, calls: 0 }, socketRun.players, [foe], 'guardian-jasper')
  combat = playCard(combat, 'p1', 'harden', {
    enemyUid: null, playerId: 'p2', exhaustUids: ['spare-a', 'spare-b'],
  })
  assert.equal(combat.players[1].block, 3)
  assert.deepEqual(combat.players[0].exhaust.map((card) => card.uid), ['spare-a', 'spare-b'])

  const rubyRun = createRun(428, [{ id: 'p1', name: 'Guardian', character: 'guardian' }])
  rubyRun.players[0].hand = [
    { uid: 'ruby-harden', defId: 'guardian_harden', upgraded: false, attachedGemId: 'guardian_ruby' },
  ]
  rubyRun.players[0].energy = 2
  combat = createCombat({ seed: 428, calls: 0 }, rubyRun.players, [foe], 'guardian-ruby')
  assert.equal(playCard(combat, 'p1', 'ruby-harden', { enemyUid: null, playerId: 'p1' }), combat,
    'an offensive socket Gem resolved without an enemy target')
  combat = playCard(combat, 'p1', 'ruby-harden', { enemyUid: 'e1', playerId: 'p1' })
  assert.equal(combat.enemies[0].hp, 19)

  const jasperCapRun = createRun(429, [{ id: 'p1', name: 'Guardian', character: 'guardian' }])
  jasperCapRun.players[0].hand = [
    { uid: 'capped-harden', defId: 'guardian_harden', upgraded: false, attachedGemId: 'guardian_jasper' },
    ...[0, 1, 2, 3].map((index) => ({
      uid: `capped-${index}`, defId: 'guardian_defend', upgraded: false,
    })),
  ]
  jasperCapRun.players[0].energy = 3
  combat = createCombat({ seed: 429, calls: 0 }, jasperCapRun.players, [foe], 'guardian-jasper-cap')
  assert.equal(playCard(combat, 'p1', 'capped-harden', {
    enemyUid: null, playerId: 'p1', exhaustUids: ['capped-0', 'capped-1', 'capped-2', 'capped-3'],
  }), combat, 'Jasper accepted more than three cards')

  const burstRun = createRun(430, [{ id: 'p1', name: 'Guardian', character: 'guardian' }])
  burstRun.players[0].hand = [
    { uid: 'burst', defId: 'guardian_bauble_burst', upgraded: false, attachedGemId: 'guardian_jasper' },
    ...[0, 1, 2, 3, 4, 5].map((index) => ({
      uid: `burst-${index}`, defId: 'guardian_defend', upgraded: false,
    })),
  ]
  burstRun.players[0].energy = 3
  combat = createCombat({ seed: 430, calls: 0 }, burstRun.players, [foe], 'guardian-bauble-jasper')
  combat = playCard(combat, 'p1', 'burst', {
    enemyUid: 'e1', playerId: 'p1', exhaustUids: burstRun.players[0].hand.slice(1).map((card) => card.uid),
  })
  assert.equal(combat.enemies[0].hp, 18)
  assert.equal(combat.players[0].exhaust.length, 6)

  const prismRun = createRun(431, [
    { id: 'p1', name: 'Guardian', character: 'guardian' },
    { id: 'p2', name: 'Defect', character: 'defect' },
  ])
  prismRun.players[0].hand = [{ uid: 'prism', defId: 'guardian_prismatic_barrier', upgraded: false,
    attachedGemId: 'guardian_onyx' }]
  prismRun.players[0].energy = 3
  for (const player of prismRun.players) Object.assign(player, { weak: 2, vulnerable: 2 })
  combat = createCombat({ seed: 431, calls: 0 }, prismRun.players, [foe], 'guardian-prismatic-onyx')
  combat = playCard(combat, 'p1', 'prism', { enemyUid: null, playerId: null })
  assert.deepEqual(combat.players.map((player) => [player.weak, player.vulnerable]), [[0, 0], [0, 0]])

  const peridotRun = createRun(432, [{ id: 'p1', name: 'Guardian', character: 'guardian' }])
  peridotRun.players[0].hand = [{ uid: 'peridot-harden', defId: 'guardian_harden', upgraded: false,
    attachedGemId: 'guardian_peridot' }]
  peridotRun.players[0].energy = 3
  combat = createCombat({ seed: 432, calls: 0 }, peridotRun.players, [foe], 'guardian-peridot-alone')
  combat = playCard(combat, 'p1', 'peridot-harden', { enemyUid: null, playerId: 'p1' })
  assert(!combat.players[0].hand.some((card) => card.uid === 'peridot-harden'))
  assert.equal(combat.enemies[0].hp, 20)

  const otherGemRun = createRun(433, [{ id: 'p1', name: 'Guardian', character: 'guardian' }])
  otherGemRun.players[0].hand = [
    { uid: 'peridot-harden', defId: 'guardian_harden', upgraded: false, attachedGemId: 'guardian_peridot' },
    { uid: 'other-gem', defId: 'guardian_crystal_edge', upgraded: false },
  ]
  otherGemRun.players[0].energy = 3
  combat = createCombat({ seed: 433, calls: 0 }, otherGemRun.players, [foe], 'guardian-peridot-other')
  assert.equal(playCard(combat, 'p1', 'peridot-harden', { enemyUid: null, playerId: 'p1' }), combat,
    'Peridot resolved without a target while another Gem was held')
  combat = playCard(combat, 'p1', 'peridot-harden', { enemyUid: 'e1', playerId: 'p1' })
  assert.equal(combat.enemies[0].hp, 18)

  for (const [seed, attachedGemId, expectedBlock] of [
    [439, 'guardian_bismuth', 0],
    [440, 'guardian_bismuth', 1],
  ]) {
    const run = createRun(seed, [{ id: 'p1', name: 'Guardian', character: 'guardian' }])
    run.players[0].hand = [
      { uid: `bismuth-${seed}`, defId: 'guardian_crystal_edge', upgraded: false, attachedGemId },
      ...(expectedBlock ? [{ uid: `bismuth-other-${seed}`, defId: 'guardian_crystal_edge', upgraded: false }] : []),
    ]
    run.players[0].energy = 3
    combat = createCombat({ seed, calls: 0 }, run.players, [foe], `guardian-bismuth-${seed}`)
    combat = playCard(combat, 'p1', `bismuth-${seed}`, { enemyUid: 'e1', playerId: 'p1' })
    assert.equal(combat.players[0].block, expectedBlock, 'Bismuth counted its resolving host as another Gem')
  }

  for (const [seed, withOther, expectedBlock] of [[441, false, 1], [442, true, 2]]) {
    const run = createRun(seed, [{ id: 'p1', name: 'Guardian', character: 'guardian' }])
    run.players[0].hand = [
      { uid: `suspension-${seed}`, defId: 'guardian_suspension', upgraded: false },
      ...(withOther ? [{ uid: `suspension-other-${seed}`, defId: 'guardian_crystal_edge', upgraded: false }] : []),
    ]
    run.players[0].energy = 3
    combat = createCombat({ seed, calls: 0 }, run.players, [foe], `guardian-suspension-${seed}`)
    combat = playCard(combat, 'p1', `suspension-${seed}`, { enemyUid: null, playerId: 'p1' })
    assert.equal(combat.players[0].block, expectedBlock, 'Suspension counted itself as another Gem')
  }

  for (const [seed, withOther, expectedHp] of [[443, false, 19], [444, true, 17]]) {
    const run = createRun(seed, [{ id: 'p1', name: 'Guardian', character: 'guardian' }])
    run.players[0].hand = [
      { uid: `peridot-edge-${seed}`, defId: 'guardian_crystal_edge', upgraded: false,
        attachedGemId: 'guardian_peridot' },
      ...(withOther ? [{ uid: `peridot-other-${seed}`, defId: 'guardian_crystal_edge', upgraded: false }] : []),
    ]
    run.players[0].energy = 3
    combat = createCombat({ seed, calls: 0 }, run.players, [foe], `guardian-peridot-edge-${seed}`)
    combat = playCard(combat, 'p1', `peridot-edge-${seed}`, { enemyUid: 'e1', playerId: 'p1' })
    assert.equal(combat.enemies[0].hp, expectedHp, 'Peridot counted its resolving host as another Gem')
  }
})

check('Defense Mode type counts use Guardian cards current effective type in every pile', () => {
  const run = createRun(434, [{ id: 'p1', name: 'Guardian', character: 'guardian' }])
  const actor = run.players[0]
  actor.guardianMode = 'defense'
  actor.hand = [
    { uid: 'count-whirl', defId: 'guardian_guardian_whirl', upgraded: false },
    { uid: 'count-beam', defId: 'guardian_refracted_beam', upgraded: false },
  ]
  actor.exhaust = [{ uid: 'count-exhaust', defId: 'guardian_guardian_whirl', upgraded: false }]
  actor.chamber = [{ uid: 'count-chamber', defId: 'guardian_refracted_beam', upgraded: false }]
  const combat = createCombat({ seed: 434, calls: 0 }, [actor], [{
    uid: 'count-enemy', defId: 'jaw_worm', row: 0, isBoss: false, hp: 20, maxHp: 20,
    block: 0, strength: 0, vulnerable: 0, weak: 0, poison: 0, actionIndex: 0, abilityUsed: false, dead: false,
  }], 'guardian-effective-counts')
  const live = combat.players[0]
  live.guardianMode = 'defense'
  assert.equal(playCost(faceOf(CARDS.hermit_midnight, false), live), 2,
    'Defense-mode Guardian cards in a foreign Chamber discounted Midnight as printed Attacks')
  const count = (per) => amountOf({ base: 0, per, scale: 1 }, combat, live)
  assert.deepEqual({ attacks: count('attacksInHand'), skills: count('skillsInHand'),
    exhaustAttacks: count('attacksInExhaust'), chamberAttacks: count('attacksInChamber') },
  { attacks: 0, skills: 2, exhaustAttacks: 0, chamberAttacks: 0 })

  const typedPlayer = (seed, over) => Object.assign(
    createRun(seed, [{ id: 'p1', name: 'Guardian', character: 'guardian' }]).players[0], over,
  )
  const typedEnemy = () => ({
    uid: 'effective-enemy', defId: 'jaw_worm', row: 0, isBoss: false, hp: 20, maxHp: 20,
    block: 0, strength: 0, vulnerable: 0, weak: 0, poison: 0, actionIndex: 0, abilityUsed: false, dead: false,
  })
  const variable = { uid: 'effective-whirl', defId: 'guardian_guardian_whirl', upgraded: false }
  let typed = createCombat({ seed: 436, calls: 0 }, [typedPlayer(436, {
    hand: [{ uid: 'effective-escape', defId: 'escape_plan', upgraded: false }], draw: [variable], energy: 3,
  })], [typedEnemy()], 'guardian-effective-draw')
  typed.players[0].guardianMode = 'defense'
  typed = playCard(typed, 'p1', 'effective-escape', { enemyUid: null, playerId: 'p1' })
  assert.equal(typed.players[0].block, 1, 'Escape Plan ignored a drawn effective Skill')

  typed = createCombat({ seed: 437, calls: 0 }, [typedPlayer(437, {
    hand: [{ uid: 'effective-second-wind', defId: 'second_wind', upgraded: false }, variable], energy: 3,
  })], [typedEnemy()], 'guardian-effective-exhaust')
  typed.players[0].guardianMode = 'defense'
  typed = playCard(typed, 'p1', 'effective-second-wind', { enemyUid: null, playerId: 'p1' })
  assert(typed.players[0].exhaust.some((card) => card.uid === variable.uid),
    'Second Wind kept a Defense-mode effective Skill')

  typed = createCombat({ seed: 439, calls: 0 }, [typedPlayer(439, {
    hand: [{ uid: 'effective-technique', defId: 'secret_technique', upgraded: false }], draw: [variable], energy: 3,
  })], [typedEnemy()], 'guardian-effective-scry')
  typed.players[0].guardianMode = 'defense'
  typed = playCard(typed, 'p1', 'effective-technique', {
    enemyUid: null, playerId: 'p1', scryToHandUid: variable.uid, scryDiscardUids: [],
  })
  assert(typed.players[0].hand.some((card) => card.uid === variable.uid),
    'Secret Technique rejected a Defense-mode effective Skill')

  typed = createCombat({ seed: 438, calls: 0 }, [typedPlayer(438, { freeAttacksThisTurn: 1,
    hand: [{ uid: 'effective-havoc', defId: 'havoc', upgraded: false }], draw: [variable], energy: 3,
  })], [typedEnemy()], 'guardian-effective-havoc')
  typed.players[0].guardianMode = 'defense'
  typed = playCard(typed, 'p1', 'effective-havoc', { enemyUid: null, playerId: 'p1' })
  typed = playCard(typed, 'p1', variable.uid, { enemyUid: null, playerId: 'p1' })
  assert.equal(typed.players[0].attacksPlayedThisTurn, 0,
    'deferred Havoc finalized a Defense-mode effective Skill as an Attack')
})

check('Downfall Enchiridion reveals five ordinary rewards rather than five rares', () => {
  let run = createRun(423, [{ id: 'p1', name: 'Guardian', character: 'guardian' }])
  const player = run.players[0]
  player.cardRewards = ['guardian_orb_slam', 'guardian_crystal_edge', 'guardian_overload', 'guardian_fortify', 'guardian_poly_beam']
  player.rareRewards = ['guardian_destroy']
  const gemDeck = [...run.guardianGemDeck]
  const firstGems = gemDeck.slice(0, 2)
  assert.deepEqual(pendingRewardChoices(player, 'downfall_enchiridion')[0], player.cardRewards)
  run = acquireRelic({ ...run, phase: 'map' }, player.id, 'downfall_enchiridion')
  assert.deepEqual(pendingRelicPreview(run, player.id)?.guardianGemGroups, [firstGems])
  assert.deepEqual(run.guardianGemDeck, gemDeck.slice(2), 'face-up reward Gems remained in the face-down deck')
  const skipped = resolvePendingRelic(structuredClone(run), player.id, [], [0])
  assert.deepEqual(skipped.guardianGemDeck.slice(-2), firstGems)
  assert.equal(skipped.pendingGuardianSockets.length, 0)
  assert(run.players[0].relics.some((relic) => relic.defId === 'downfall_enchiridion' && relic.pending))
  run = resolvePendingRelic(run, player.id, [], [1])
  assert(run.players[0].deck.some((card) => card.defId === 'guardian_crystal_edge'))
  assert.equal(run.pendingGuardianSockets[0].gemIds.length, 2)
  assert(!run.players[0].relics.some((relic) => relic.defId === 'downfall_enchiridion'))
})

check('multi-group Relic rewards reserve each Socket group Gems in face-up order', () => {
  let run = createRun(435, [{ id: 'p1', name: 'Guardian', character: 'guardian' }])
  const player = run.players[0]
  player.cardRewards = [
    'guardian_orb_slam', 'guardian_crystal_edge', 'guardian_overload',
    'guardian_fortify', 'guardian_crystal_edge', 'guardian_poly_beam',
    'guardian_orb_slam', 'guardian_overload', 'guardian_fortify',
    'guardian_poly_beam', 'guardian_orb_slam', 'guardian_overload',
  ]
  const revealed = run.guardianGemDeck.slice(0, 4)
  run = acquireRelic({ ...run, phase: 'map' }, player.id, 'orrery')
  assert.deepEqual(pendingRelicPreview(run, player.id)?.guardianGemGroups,
    [revealed.slice(0, 2), revealed.slice(2, 4), [], []])
  run = resolvePendingRelic(run, player.id, [], [1, -1, -1, -1])
  assert.deepEqual(run.pendingGuardianSockets[0]?.gemIds, revealed.slice(0, 2))
  assert.deepEqual(run.guardianGemDeck.slice(-2), revealed.slice(2, 4))
})

check('Relic reward Gems are reserved after an already-revealed card reward', () => {
  let run = createRun(445, [{ id: 'p1', name: 'Guardian', character: 'guardian' }])
  const player = run.players[0]
  const alreadyRevealed = ['guardian_orb_slam', 'guardian_overload', 'guardian_fortify']
  player.cardRewards = [
    ...alreadyRevealed,
    'guardian_orb_slam', 'guardian_crystal_edge', 'guardian_overload',
    'guardian_fortify', 'guardian_poly_beam', 'guardian_orb_slam',
    'guardian_overload', 'guardian_fortify', 'guardian_poly_beam',
    'guardian_orb_slam', 'guardian_overload', 'guardian_fortify',
  ]
  run = { ...run, phase: 'reward', neow: null, rewards: [{
    playerId: player.id, cardReward: true, choices: alreadyRevealed, cardsDrawn: alreadyRevealed,
    raresDrawn: [], drawsReserved: false, upgraded: false, potion: false, relic: false, bossRelics: false,
  }] }
  const gems = run.guardianGemDeck.slice(0, 2)
  run = acquireRelic(run, player.id, 'orrery')
  assert.deepEqual(pendingRelicPreview(run, player.id)?.rewardChoices[0],
    ['guardian_orb_slam', 'guardian_crystal_edge', 'guardian_overload'])
  assert.deepEqual(pendingRelicPreview(run, player.id)?.guardianGemGroups[0], gems)
})

console.log(`Downfall Guardian verification passed (${checks.length} checks, ${GUARDIAN_CARDS.length} definitions, ${GUARDIAN_PHYSICAL_CARDS.length} physical cards).`)
