import assert from 'node:assert/strict'
import {
  SLIME_BOSS_CARDS,
  SLIME_BOSS_CARD_COUNT,
  SLIME_BOSS_GOLDEN_TICKET,
  SLIME_BOSS_PHYSICAL_DECK_COUNT,
  SLIME_BOSS_RARE_DECK,
  SLIME_BOSS_REWARD_DECK,
  SLIME_BOSS_STARTER_DECK,
  bruiserSlime,
  commandSlime,
  gainSlimeVigor,
  growSlime,
  removeTemporarySlimeVigor,
} from '../src/game/downfall/slime-boss.ts'
import { activatePower, beginEndPlayerTurn, cardHasRetain, cardNeedsEnemy, createCombat, endTurnAbilities, pendingTriggerAbility, pendingTriggerSlimeEnemyChoiceCount, pendingTriggerSlimeEnemyChoiceLabels, playCard, playCardCopy, playCost, previewCardCopyChoice, resolvePendingTrigger, slimeCommandEnemyChoiceCount, slimeCommandEnemyChoiceLabels } from '../src/game/combat.ts'
import { fireTriggers, resolveSlimeCommand } from '../src/game/combat/effects.ts'
import { createRng } from '../src/game/rng.ts'
import { CARDS, STARTER_DECKS } from '../src/game/cards.ts'
import { characterRewardDeck } from '../src/game/acquisition.ts'
import { createCampaignProgress } from '../src/game/campaign.ts'

const expected = [
  ['Slime Slap', 0], ['Lick', 0], ['Defend', 0], ['Strike', 0], ['Bruiser Slime', 2],
  ['Massive Slime', 3], ['Leeching Slime', 3], ['Scrappy Slime', 3], ['Spike Slime', 3],
  ['Spreading Slime', 3], ['Sticky Slime', 3], ['Taunting Slime', 3], ['Psychic Slime', 3],
  ['Muscle Slime', 3], ['Combo Tackle', 0], ['Opening Tackle', 0], ['Forward Tackle', 0],
  ['Flame Tackle', 0], ['Hungry Tackle', 0], ['Ravenous Tackle', 0], ['Relentless Tackle', 0],
  ['Spear Tackle', 0], ['Growth', 0], ['Reformation', 0], ['Nibble and Lick', 0], ['Recollect', 0],
  ['Pile On!', 0], ['Just Desserts', 0], ['Repurpose', 0], ['Leech Energy', 0], ['Goop Spray', 0],
  ['Recklessness', 0], ['Slippery', 0], ['Protect the Boss', 0], ['Quick Snack', 0],
  ['It Looks Tasty', 0], ['Divide & Conquer', 0], ['Digest', 0], ['Living Wall', 0],
  ['Prepare Crush', 0], ['Spit', 0], ['Haunting Lick', 0], ['Glop Chop', 0],
  ['Smothering Tackle', 0], ['Dive Tackle', 0], ['Gluttony', 0], ['Tongue Lash', 0],
  ['Slime Brawl', 0], ['Ooze Bath', 0], ['Goop Armor', 0], ['Delegate', 0], ['Royal Slime', 3],
  ['Feeding Frenzy', 0], ['Slime Tap', 0], ['Rain of Goop', 0], ['Consult Playbook', 0],
  ['Duplicated Form', 0], ['Minion Master', 0], ['Overexert', 0], ['Replication', 0],
  ['Darkling Duo', 0], ['Shape of Puddle', 0], ['Rally the Troops', 0], ['Vicious Tackle', 0],
  ['Level Up', 0], ['Evolution Slime', 6], ['Armored Slime', 3],
]

assert.equal(SLIME_BOSS_CARD_COUNT, 67, 'all 67 deck-legal v1.47 definitions')
assert.equal(SLIME_BOSS_PHYSICAL_DECK_COUNT, 88, '86 deck cards plus two Golden Tickets')
assert.equal(SLIME_BOSS_STARTER_DECK.length, 10, 'Bruiser starts in play, not in the draw deck')
assert.equal(SLIME_BOSS_REWARD_DECK.length, 59, 'reward deck excludes two Golden Tickets')
assert.equal(SLIME_BOSS_RARE_DECK.length, 16)
assert.deepEqual(SLIME_BOSS_GOLDEN_TICKET.sheetIndices, [53, 54])
assert.deepEqual(STARTER_DECKS.slime_boss, SLIME_BOSS_STARTER_DECK, 'live starter deck')
assert.ok(Object.keys(SLIME_BOSS_CARDS).every((id) => CARDS[id] === SLIME_BOSS_CARDS[id]), 'all definitions registered live')
assert.equal(characterRewardDeck('slime_boss', false, createCampaignProgress()).length, 61, '59 rewards plus 2 tickets')
assert.deepEqual(characterRewardDeck('slime_boss', true, createCampaignProgress()), SLIME_BOSS_RARE_DECK)

const byName = new Map(Object.values(SLIME_BOSS_CARDS).map((card) => [card.name, card]))
assert.deepEqual([...byName.keys()], expected.map(([name]) => name), 'manifest order and names')
for (const [name, levelCount] of expected) {
  const card = byName.get(name)
  assert.ok(card, `missing manifest card ${name}`)
  assert.equal(typeof card.multiplicity, 'number', `${name} multiplicity`)
  assert.ok(card.printedText === null || typeof card.printedText === 'string', `${name} base text`)
  assert.ok(!card.effects.some((effect) => effect.kind === 'printed'), `${name} has executable effect data`)
  assert.ok(card.effects.length > 0 || card.slimeLevels || card.persistent || card.activeAbility,
    `${name} is executable rather than text-only`)
  if (card.upgrade) assert.ok(card.upgrade.printedText === null || typeof card.upgrade.printedText === 'string', `${name} upgraded text`)
  assert.equal(Object.keys(card.slimeLevels ?? {}).length, levelCount, `${name} base level table`)
  if (levelCount > 0 && name !== 'Bruiser Slime') {
    assert.equal(Object.keys(card.upgrade?.slimeLevels ?? card.slimeLevels ?? {}).length, levelCount, `${name} upgraded level table`)
  }
}
assert.ok(Object.values(SLIME_BOSS_CARDS)
  .filter((card) => card.cardKind === 'slime')
  .every((card) => card.resolvesOnPlay), 'every Slime resolves its printed “When played” effects')

const bruiser = bruiserSlime('audit-bruiser')
assert.equal(growSlime(bruiser, 99), 1, 'Grow caps at Bruiser level 2')
assert.equal(bruiser.level, 2)
assert.equal(gainSlimeVigor(bruiser, 2, true), 2)
const strike = commandSlime(bruiser)
assert.equal(strike.effects[0].kind, 'hit')
assert.equal(strike.effects[0].amount, 4, 'Slime Vigor adds to its damage icon')
assert.doesNotThrow(() => JSON.parse(JSON.stringify(bruiser)), 'Slime state survives reconnect JSON')
assert.equal(removeTemporarySlimeVigor(bruiser), 2)
assert.equal(bruiser.vigor, 0)

const armoredDef = byName.get('Armored Slime')
const armored = { card: { uid: 'audit-armored', defId: armoredDef.id, upgraded: false }, level: 1, vigor: 0, commandsThisTurn: 0, vigorLossAtEndOfTurn: 0 }
assert.ok(commandSlime(armored), 'Armored Slime permits its first Command')
assert.equal(commandSlime(armored), null, 'Armored Slime rejects a second Command in the turn')

const evolution = byName.get('Evolution Slime')
assert.deepEqual(Object.keys(evolution.slimeLevels), ['1', '2', '3', '4', '5', '6'], 'all Evolution levels')
assert.equal(byName.get('Bruiser Slime').slimeEndOfTurn, true)
assert.equal(byName.get('Spike Slime').slimeEndOfTurn, true)

const player = {
  id: 'slime-player', name: 'Slime Boss', character: 'ironclad', row: 0,
  hp: 9, maxHp: 9, block: 0, energy: 3, gold: 0,
  deck: [], draw: [], hand: [], discard: [], exhaust: [], powers: [],
  relics: [], potions: [], cardRewards: [], rareRewards: [],
  strength: 0, strengthLossAtEndOfTurn: 0, vulnerable: 0, weak: 0,
  drawLocked: false, lostHpThisCombat: false, shivs: 0, miracles: 0,
  stance: 'neutral', orbs: [null, null, null], dead: false,
  slimes: [bruiserSlime('end-turn-bruiser')],
}
const enemy = {
  uid: 'target', defId: 'cultist', row: 0, isBoss: false,
  hp: 6, maxHp: 6, block: 0, strength: 0, vulnerable: 0, weak: 0, poison: 0,
  actionIndex: 0, abilityUsed: false, dead: false,
}
const combat = createCombat(createRng(47), [player], [enemy])
assert.ok(endTurnAbilities(combat).some((ability) => ability.id === 'slime-player/slime:end-turn-bruiser'), 'Bruiser is a mandatory ordered end-turn Command')
const afterEndTurn = beginEndPlayerTurn(combat)
assert.equal(afterEndTurn.enemies[0].hp, 5, 'Bruiser end-turn Command resolves through the combat engine')
assert.deepEqual(afterEndTurn.presentationEvents.at(-1), {
  seq: 1,
  kind: 'slime',
  actorId: player.id,
  sourceId: byName.get('Bruiser Slime').id,
  slimeUid: 'end-turn-bruiser',
  upgraded: false,
  animationIndex: 0,
  enemyIds: [enemy.uid],
  playerIds: [],
}, 'a resolved Slime Command records its exact minion and target for live presentation')

const taunting = {
  card: { uid: 'support-taunting', defId: byName.get('Taunting Slime').id, upgraded: false },
  level: 1, vigor: 0, commandsThisTurn: 0, vigorLossAtEndOfTurn: 0,
}
const supportCombat = createCombat(createRng(4701), [{
  ...player, character: 'slime_boss', block: 0, slimes: [taunting],
}], [{ ...enemy, uid: 'surplus-support-target' }])
assert(resolveSlimeCommand(supportCombat, supportCombat.players[0], supportCombat.players[0].slimes[0], {
  enemyUid: 'surplus-support-target', playerId: player.id,
}))
assert.equal(supportCombat.players[0].block, 1)
assert.deepEqual(supportCombat.presentationEvents.at(-1).enemyIds, [],
  'a self-support Command does not publish an unused enemy choice as an affected target')

const repeatSlime = bruiserSlime('repeat-command-slime')
const repeatCombat = createCombat(createRng(47015), [{
  ...player, character: 'slime_boss', slimes: [repeatSlime],
}], [{ ...enemy, uid: 'repeat-command-target', hp: 20, maxHp: 20 }])
const repeatContext = { enemyUid: 'repeat-command-target', playerId: player.id }
for (let index = 0; index < 2; index++) assert(resolveSlimeCommand(
  repeatCombat, repeatCombat.players[0], repeatCombat.players[0].slimes[0], repeatContext,
))
assert.deepEqual(repeatCombat.presentationEvents.map((event) => event.animationIndex), [0, 1],
  'repeat Commands publish their shared sprite, hit, HP, and death timeline')
assert(resolveSlimeCommand(repeatCombat, repeatCombat.players[0], repeatCombat.players[0].slimes[0], {
  enemyUid: 'repeat-command-target', playerId: player.id,
}))
assert.equal(repeatCombat.presentationEvents.at(-1).animationIndex, 0,
  'a later action starts a fresh Command animation timeline')

const rallySlimes = Array.from({ length: 15 }, (_, index) => bruiserSlime(`rally-slime-${index}`))
const rallyCombat = createCombat(createRng(4702), [{
  ...player, character: 'slime_boss', slimes: rallySlimes,
}], [{ ...enemy, uid: 'rally-target', hp: 100, maxHp: 100 }])
for (const slime of rallyCombat.players[0].slimes) assert(resolveSlimeCommand(
  rallyCombat, rallyCombat.players[0], slime, { enemyUid: 'rally-target', playerId: player.id },
))
assert.deepEqual(rallyCombat.presentationEvents.filter((event) => event.kind === 'slime')
  .map((event) => event.slimeUid), rallySlimes.map((slime) => slime.card.uid),
'a full 15-Slime Rally reaches clients as one complete presentation batch')

const leechEnergy = { uid: 'retain-leech-energy', defId: byName.get('Leech Energy').id, upgraded: false }
const retainBlock = playCard(createCombat(createRng(471), [{
  ...player, character: 'slime_boss', hand: [leechEnergy,
    { uid: 'retain-card', defId: 'perseverance', upgraded: false }], energy: 3, block: 0,
  powers: [{ uid: 'retain-juggernaut', defId: 'juggernaut', upgraded: false }],
}], [{ ...enemy, uid: 'retain-target', hp: 10, maxHp: 10 }]), player.id, leechEnergy.uid, {
  enemyUid: 'retain-target', playerId: player.id,
})
assert.equal(retainBlock.players[0].block, 1)
assert.equal(retainBlock.enemies[0].hp, 8, 'Leech Energy Block bypassed onGainBlock triggers')

const shiftCombat = createCombat(createRng(470), [{ ...player, character: 'slime_boss', block: 0,
  slimes: [bruiserSlime('shift-bruiser')] }], [{ ...enemy, uid: 'shift-target', defId: 'transient', hp: 99, maxHp: 99 }])
const shifted = beginEndPlayerTurn(shiftCombat)
assert.equal(shifted.players[0].block, 1, 'an end-turn Slime Command triggers Shift from actual HP loss')

const spreading = {
  card: { uid: 'spreading', defId: byName.get('Spreading Slime').id, upgraded: false },
  level: 1, vigor: 0, commandsThisTurn: 0, vigorLossAtEndOfTurn: 0,
}
const slimeActor = { ...player, character: 'slime_boss', slimes: [spreading], strength: 5, weak: 1, hitPoison: 3 }
assert.equal(cardNeedsEnemy(CARDS[byName.get('Defend').id], slimeActor, true, undefined, false,
  undefined, 'cheap', 1), false, 'Spreading Slime does not target after spending under 2 Energy')
assert.equal(cardNeedsEnemy(CARDS.the_bomb, slimeActor, true, undefined, false,
  undefined, 'bomb', 2), false, 'an ALL-enemy card does not borrow a global target for its Slime Command')
assert.equal(slimeCommandEnemyChoiceCount(CARDS.the_bomb, combat, slimeActor, [], 0, 2), 1,
  'a 2-Energy card collects the Spreading Slime Command target separately')
const bomb = { uid: 'bomb', defId: 'the_bomb', upgraded: false }
const spreadingCombat = createCombat(createRng(471), [{ ...slimeActor, hand: [bomb], energy: 3 }],
  [{ ...enemy, vulnerable: 1 }])
assert.equal(playCard(spreadingCombat, player.id, bomb.uid, {
  enemyUid: null, playerId: player.id,
}), spreadingCombat, 'a targetless 2-Energy Power cannot silently skip Spreading Slime')
const spread = playCard(spreadingCombat, player.id, bomb.uid, {
  enemyUid: null, playerId: player.id, slimeEnemyUids: [enemy.uid],
})
assert.notEqual(spread, spreadingCombat, 'Spreading Slime target is accepted for an ALL-enemy Power')
assert.equal(spread.enemies[0].hp, 4, 'Spreading Slime Commands the chosen target after 2 Energy')
assert.equal(spread.enemies[0].vulnerable, 1, 'a Slime Command spent the enemy Vulnerable token')
assert.equal(spread.enemies[0].poison, 0, 'a Slime Command inherited the hero\'s on-hit Poison')
assert.equal(spread.players[0].weak, 1, 'a Slime Command spent the hero\'s Weak token')
assert.deepEqual(spread.presentationEvents.filter((event) => event.kind === 'slime').map((event) => ({
  slimeUid: event.slimeUid,
  sourceId: event.sourceId,
  enemyIds: event.enemyIds,
})), [{
  slimeUid: spreading.card.uid,
  sourceId: spreading.card.defId,
  enemyIds: [enemy.uid],
}], 'a triggered Command identifies the minion without masquerading as a hero card play')
if (process.argv.includes('--presentation-only')) {
  console.log('Downfall Slime Command presentation events verified.')
  process.exit(0)
}

const nestedSpreading = {
  ...spreading,
  card: { ...spreading.card, uid: 'nested-spreading' },
  commandsThisTurn: 0,
}
const omniscience = { uid: 'slime-omniscience', defId: 'omniscience', upgraded: false }
const nestedStrike = { uid: 'slime-omni-strike', defId: byName.get('Strike').id, upgraded: false }
let nestedCopy = createCombat(createRng(478), [{
  ...player, character: 'slime_boss', hand: [omniscience], draw: [], energy: 3, slimes: [nestedSpreading],
}], [{ ...enemy, uid: 'nested-copy-target' }])
nestedCopy.players[0].draw = [nestedStrike]
nestedCopy = playCard(nestedCopy, player.id, omniscience.uid, {
  searchDrawUids: [nestedStrike.uid], enemyUid: null, slimeEnemyUids: ['nested-copy-target'], playerId: player.id,
})
assert(nestedCopy.pendingCardCopy, 'high-cost nested copy card did not queue its child')
assert.equal(nestedCopy.enemies[0].hp, 4, 'Spreading Slime did not Command before the parent suspended')
assert.equal(nestedCopy.log.filter((line) => line.includes('Commands Spreading Slime')).length, 1,
  'the parent Energy spend Commanded Spreading Slime more than once')
while (nestedCopy.pendingCardCopy) {
  nestedCopy = playCardCopy(nestedCopy, player.id, { enemyUid: 'nested-copy-target', playerId: player.id })
}
assert.equal(nestedCopy.log.filter((line) => line.includes('Commands Spreading Slime')).length, 1,
  'the copied child repeated the parent Energy-spend reaction')

const leech = (uid) => ({
  card: { uid, defId: byName.get('Leeching Slime').id, upgraded: false },
  level: 1, vigor: 0, commandsThisTurn: 0, vigorLossAtEndOfTurn: 0, vigorTriggerUsedThisTurn: false,
})
const growable = (uid) => ({
  card: { uid, defId: byName.get('Scrappy Slime').id, upgraded: false },
  level: 1, vigor: 0, commandsThisTurn: 0, vigorLossAtEndOfTurn: 0, vigorTriggerUsedThisTurn: false,
})
const feeding = { uid: 'multi-grow-feeding', defId: byName.get('Feeding Frenzy').id, upgraded: false }
const evolutionCommand = {
  card: { uid: 'evolution-command', defId: byName.get('Evolution Slime').id, upgraded: false },
  level: 2, vigor: 0, commandsThisTurn: 0, vigorLossAtEndOfTurn: 0, vigorTriggerUsedThisTurn: false,
}
const nibble = { uid: 'evolution-nibble', defId: byName.get('Nibble and Lick').id, upgraded: false }
let evolutionGrow = createCombat(createRng(481), [{
  ...player, character: 'slime_boss', hand: [nibble], energy: 3, slimes: [evolutionCommand],
}], [{ ...enemy, uid: 'evolution-left', hp: 10, maxHp: 10 },
  { ...enemy, uid: 'evolution-right', row: 1, hp: 10, maxHp: 10 }])
assert.equal(slimeCommandEnemyChoiceCount(CARDS[nibble.defId], evolutionGrow, evolutionGrow.players[0],
  [evolutionCommand.card.uid]), 0, 'level-3 Evolution Commands ALL enemies after its Grow')
evolutionGrow = playCard(evolutionGrow, player.id, nibble.uid, {
  enemyUid: null, playerId: player.id, slimeUids: [evolutionCommand.card.uid], slimeEnemyUids: [],
})
assert.deepEqual(evolutionGrow.enemies.map((held) => held.hp), [6, 6],
  'Nibble and Lick uses Evolution Slime\'s post-Grow ALL-enemy Command')

let multiGrow = createCombat(createRng(479), [{
  ...player, character: 'slime_boss', hand: [feeding], energy: 3,
  slimes: [leech('multi-grow-leech'), growable('multi-grow-a'), growable('multi-grow-b')],
}], [{ ...enemy, uid: 'multi-grow-left', hp: 10, maxHp: 10 },
  { ...enemy, uid: 'multi-grow-right', row: 1, hp: 10, maxHp: 10 }])
assert.equal(slimeCommandEnemyChoiceCount(CARDS[feeding.defId], multiGrow, multiGrow.players[0],
  ['multi-grow-a', 'multi-grow-b']), 2)
multiGrow = playCard(multiGrow, player.id, feeding.uid, {
  enemyUid: 'multi-grow-left', playerId: player.id,
  slimeUids: ['multi-grow-a', 'multi-grow-b'],
  slimeEnemyUids: ['multi-grow-left', 'multi-grow-right'],
})
assert.deepEqual(multiGrow.enemies.map((held) => held.hp), [7, 9],
  'each successful Grow Commanded Leeching Slime against its independently chosen target')

let deferredLeech = createCombat(createRng(482), [{
  ...player, character: 'slime_boss', hand: [feeding], energy: 3,
  slimes: [growable('deferred-growable'), leech('deferred-leech')],
}], [{ ...enemy, uid: 'deferred-left', hp: 10, maxHp: 10 },
  { ...enemy, uid: 'deferred-right', row: 1, hp: 10, maxHp: 10 }])
deferredLeech = playCard(deferredLeech, player.id, feeding.uid, {
  enemyUid: 'deferred-left', playerId: player.id,
  slimeUids: ['deferred-growable', 'deferred-leech'],
  slimeEnemyUids: ['deferred-left', 'deferred-right'],
})
assert.deepEqual(deferredLeech.enemies.map((held) => held.hp), [6, 8],
  'Grow triggers wait for Leeching Slime to reach its final level')

const levelUp = { uid: 'trigger-level-up', defId: byName.get('Level Up').id, upgraded: false }
let levelTrigger = createCombat(createRng(483), [{
  ...player, character: 'slime_boss', powers: [levelUp],
  slimes: [growable('trigger-growable'), leech('trigger-leech-a'), leech('trigger-leech-b')],
}], [{ ...enemy, uid: 'trigger-left', hp: 10, maxHp: 10 },
  { ...enemy, uid: 'trigger-right', row: 1, hp: 10, maxHp: 10 }])
levelTrigger.pendingTriggers = [{ id: 912, playerId: player.id, sourceId: `power:${levelUp.uid}` }]
assert.equal(pendingTriggerSlimeEnemyChoiceCount(levelTrigger, 912, ['trigger-growable']), 2,
  'Level Up collects one independent target for each deferred Leeching Command')
assert.equal(resolvePendingTrigger(levelTrigger, player.id, 912, undefined, undefined, undefined, {
  slimeUids: ['trigger-growable'], slimeEnemyUids: [],
}), levelTrigger, 'a triggered Grow cannot silently skip its Leeching Command targets')
levelTrigger = resolvePendingTrigger(levelTrigger, player.id, 912, undefined, undefined, undefined, {
  slimeUids: ['trigger-growable'], slimeEnemyUids: ['trigger-left', 'trigger-right'],
})
assert.deepEqual(levelTrigger.enemies.map((held) => held.hp), [9, 9],
  'triggered Leeching Commands preserve their independent targets')

const minionMaster = { uid: 'single-minion-master', defId: byName.get('Minion Master').id, upgraded: false }
let singleMinion = createCombat(createRng(484), [{
  ...player, character: 'slime_boss', powers: [minionMaster], slimes: [bruiserSlime('single-minion')],
}], [{ ...enemy, uid: 'single-minion-left', hp: 10, maxHp: 10 },
  { ...enemy, uid: 'single-minion-right', row: 1, hp: 10, maxHp: 10 }])
singleMinion.pendingTriggers = [{ id: 913, playerId: player.id, sourceId: `power:${minionMaster.uid}` }]
assert.equal(pendingTriggerAbility(singleMinion).slimeEnemyAmount, 1,
  'a trigger with one automatic Slime still asks for its enemy target')
assert.equal(resolvePendingTrigger(singleMinion, player.id, 913), singleMinion,
  'a single automatic Slime silently used the first enemy')
singleMinion = resolvePendingTrigger(singleMinion, player.id, 913, undefined, undefined, undefined, {
  slimeEnemyUids: ['single-minion-right'],
})
assert.deepEqual(singleMinion.enemies.map((held) => held.hp), [10, 9],
  'a single automatic Slime Commands the chosen enemy')

const divide = { uid: 'split-divide', defId: byName.get('Divide & Conquer').id, upgraded: false }
const divideZero = createCombat(createRng(479), [{ ...player, character: 'slime_boss',
  hand: [divide], energy: 0, slimes: [] }], [enemy])
assert.notEqual(playCard(divideZero, player.id, divide.uid, { energySpent: 0, enemyUid: null,
  playerId: player.id, slimeUids: [], slimeEnemyUids: [] }), divideZero,
'base Divide & Conquer permits X=0')
const dividePlus = { ...divide, uid: 'split-divide-plus', upgraded: true }
const dividePlusZero = createCombat(createRng(4791), [{ ...player, character: 'slime_boss',
  hand: [dividePlus], energy: 0, slimes: [] }], [enemy])
assert.equal(playCard(dividePlusZero, player.id, dividePlus.uid, { energySpent: 0, enemyUid: null,
  playerId: player.id, slimeUids: [], slimeEnemyUids: [] }), dividePlusZero,
'upgraded Divide & Conquer enforces its printed X minimum')
let split = createCombat(createRng(480), [{
  ...player, character: 'slime_boss', hand: [divide], energy: 3,
  slimes: [bruiserSlime('split-bruiser'), growable('split-scrappy')],
}], [{ ...enemy, uid: 'split-left', hp: 10, maxHp: 10 },
  { ...enemy, uid: 'split-right', row: 1, hp: 10, maxHp: 10 }])
assert.deepEqual(slimeCommandEnemyChoiceLabels(CARDS[divide.defId], split, split.players[0],
  ['split-scrappy', 'split-bruiser'], 2), ['Scrappy Slime · level 1', 'Bruiser Slime · level 1'],
  'multi-Command target prompts preserve the selected Slime order')
const labeledSlimes = [growable('labeled-scrappy-one'), {
  ...growable('labeled-scrappy-two'), level: 2, vigor: 1,
}]
assert.deepEqual(slimeCommandEnemyChoiceLabels(CARDS[divide.defId], split,
  { ...split.players[0], slimes: labeledSlimes }, labeledSlimes.map((slime) => slime.card.uid), 2),
['Scrappy Slime · level 1', 'Scrappy Slime · level 2 · 1 Strength'],
'same-name Slime target prompts expose their different Command strength')
split = playCard(split, player.id, divide.uid, {
  energySpent: 2, enemyUid: null, playerId: player.id,
  slimeUids: ['split-scrappy', 'split-bruiser'], slimeEnemyUids: ['split-left', 'split-right'],
})
assert.deepEqual(split.enemies.map((held) => held.hp), [8, 9],
  'Divide & Conquer preserves the chosen Slime order and independent enemy targets')

const lick = { uid: 'angry-lick', defId: byName.get('Lick').id, upgraded: false }
let angry = createCombat(createRng(472), [{ ...player, character: 'slime_boss', hand: [lick], energy: 3,
  slimes: [bruiserSlime('angry-bruiser')] }], [{ ...enemy, uid: 'angry-target', defId: 'mad_gremlin', hp: 10, maxHp: 10 }])
angry = playCard(angry, player.id, lick.uid, { enemyUid: 'angry-target', playerId: player.id,
  slimeUids: ['angry-bruiser'], slimeEnemyUids: ['angry-target'] })
assert.equal(angry.enemies[0].hp, 9)
assert.equal(angry.enemies[0].strength, 0, 'a Skill Slime Command must not trigger Angry')

const opening = { uid: 'angry-opening', defId: byName.get('Opening Tackle').id, upgraded: false }
angry = createCombat(createRng(473), [{ ...player, character: 'slime_boss', hand: [opening], energy: 3,
  slimes: [bruiserSlime('opening-bruiser')] }], [{ ...enemy, uid: 'opening-target', defId: 'mad_gremlin', hp: 10, maxHp: 10 }])
angry = playCard(angry, player.id, opening.uid, { enemyUid: 'opening-target', playerId: player.id,
  slimeUids: ['opening-bruiser'], slimeEnemyUids: ['opening-target'] })
assert.equal(angry.enemies[0].hp, 8)
assert.equal(angry.enemies[0].strength, 1, 'Opening Tackle triggers Angry once for its Attack, not its Command')

const zeroLick = { uid: 'zero-lick', defId: byName.get('Lick').id, upgraded: false }
const zero = createCombat(createRng(474), [{ ...player, character: 'slime_boss', hand: [zeroLick], energy: 3,
  damageDealtZeroThisTurn: true, slimes: [bruiserSlime('zero-bruiser')] }], [{ ...enemy, hp: 10, maxHp: 10 }])
const zeroed = playCard(zero, player.id, zeroLick.uid, { enemyUid: enemy.uid, playerId: player.id,
  slimeUids: ['zero-bruiser'], slimeEnemyUids: [enemy.uid] })
assert.equal(zeroed.enemies[0].hp, 10, 'Slime Commands obey damageDealtZeroThisTurn')

const shape = { uid: 'shape', defId: byName.get('Shape of Puddle').id, upgraded: false }
let shaped = createCombat(createRng(48), [{ ...player, character: 'slime_boss', powers: [shape] }], [enemy])
for (let index = 0; index < 3; index++) shaped = activatePower(shaped, player.id, shape.uid)
assert.equal(shaped.players[0].block, 6, 'Shape of Puddle can be activated repeatedly')
assert.equal(shaped.players[0].powers.some((power) => power.uid === shape.uid), false,
  'Shape of Puddle Exhausts after its third activation')

const rain = { uid: 'rain', defId: byName.get('Rain of Goop').id, upgraded: false, counter: 1 }
let rainy = createCombat(createRng(49), [{ ...player, character: 'slime_boss', powers: [rain],
  slimes: [bruiserSlime('rain-bruiser')] }], [enemy])
fireTriggers(rainy, { kind: 'startOfTurn' })
const rainChoice = pendingTriggerAbility(rainy)
assert.equal(rainChoice.slimeChoice.minimum, 0, 'Rain of Goop offers its owner as well as a Slime')
rainy = resolvePendingTrigger(rainy, player.id, rainChoice.id, undefined, undefined, undefined, { slimeUids: [] })
assert.equal(rainy.players[0].strength, 1, 'Rain of Goop can move Strength onto its owner')

const muscle = {
  card: { uid: 'rain-muscle', defId: byName.get('Muscle Slime').id, upgraded: false },
  level: 1, vigor: 0, commandsThisTurn: 0, vigorLossAtEndOfTurn: 0, vigorTriggerUsedThisTurn: false,
}
const brawl = byName.get('Slime Brawl')
const chargeSpreading = {
  card: { uid: 'charge-spreading', defId: byName.get('Spreading Slime').id, upgraded: false },
  level: 1, vigor: 0, commandsThisTurn: 0, vigorLossAtEndOfTurn: 0, vigorTriggerUsedThisTurn: false,
}
const chargeState = createCombat(createRng(4901), [{ ...player, character: 'slime_boss', energy: 3,
  slimes: [muscle, chargeSpreading] }], [enemy])
assert.deepEqual(slimeCommandEnemyChoiceLabels(brawl, chargeState, chargeState.players[0], [muscle.card.uid]),
  ['Muscle Slime · level 1 · 1 Strength', 'Muscle Slime · level 1 · 1 Strength'],
  'Slime Brawl labels its printed Command and Muscle Slime trigger separately')
const brawlCard = { uid: 'muscle-brawl', defId: brawl.id, upgraded: false }
let brawlCombat = createCombat(createRng(4902), [{ ...player, character: 'slime_boss', energy: 3,
  hand: [brawlCard], slimes: [muscle] }], [{ ...enemy, uid: 'muscle-brawl-target', hp: 10, maxHp: 10 }])
brawlCombat = playCard(brawlCombat, player.id, brawlCard.uid, { enemyUid: null, playerId: player.id,
  slimeUids: [muscle.card.uid], slimeEnemyUids: ['muscle-brawl-target', 'muscle-brawl-target'] })
assert.equal(brawlCombat.enemies[0].hp, 4,
  'Slime Brawl resolves both its printed Command and Muscle Slime Strength trigger')
const cappedMuscle = { ...muscle, card: { ...muscle.card, uid: 'capped-muscle' }, vigor: 8 }
const cappedState = createCombat(createRng(4903), [{ ...player, character: 'slime_boss', energy: 3,
  slimes: [cappedMuscle] }], [enemy])
assert.deepEqual(slimeCommandEnemyChoiceLabels(brawl, cappedState, cappedState.players[0], [cappedMuscle.card.uid]),
  ['Muscle Slime · level 1 · 8 Strength'],
  'Slime Brawl keeps its printed Command when the Strength supply is capped')
assert.deepEqual(slimeCommandEnemyChoiceLabels(byName.get('Rain of Goop'), chargeState, chargeState.players[0], [],
  2, 0), [],
'a copied X card does not falsely trigger Spreading Slime')
assert.deepEqual(slimeCommandEnemyChoiceLabels(byName.get('Slippery'), chargeState, chargeState.players[0], [],
  0, 2), ['Spreading Slime · level 1'],
'a paid Chamber card stages its Spreading Slime target')
const futurePlans = { uid: 'mixed-future-plans', defId: 'guardian_future_plans', upgraded: false }
const twinSlam = { uid: 'mixed-twin-slam', defId: 'guardian_twin_slam', upgraded: false }
const mixedDigest = { uid: 'mixed-digest', defId: byName.get('Digest').id, upgraded: false }
const mixedBruiser = bruiserSlime('mixed-bruiser')
const mixedActor = { ...player, character: 'slime_boss', energy: 4, guardianMode: null,
  hand: [mixedDigest, twinSlam], powers: [futurePlans,
    { uid: 'mixed-darkling', defId: byName.get('Darkling Duo').id, upgraded: false }], slimes: [mixedBruiser] }
assert.equal(cardHasRetain(mixedActor, twinSlam), true,
  'Future Plans did not grant Retain to a mixed-character Attack Mode card')
assert.equal(playCost(byName.get('Digest'), mixedActor, mixedDigest), 2,
  'Digest ignored Retain granted by Future Plans')
let mixedCombat = createCombat(createRng(4904), [mixedActor],
  [{ ...enemy, uid: 'mixed-future-target', hp: 10, maxHp: 10 }])
assert.equal(slimeCommandEnemyChoiceCount(CARDS[twinSlam.defId], mixedCombat, mixedCombat.players[0], [],
  0, 2, twinSlam), 1, 'Future Plans Retain did not stage Darkling Duo\'s Bruiser target')
mixedCombat = playCard(mixedCombat, player.id, twinSlam.uid, {
  enemyUid: 'mixed-future-target', playerId: player.id, corruptedShardMode: 'attack',
  slimeEnemyUids: ['mixed-future-target'],
})
assert.equal(mixedCombat.players[0].slimes[0].commandsThisTurn, 1,
  'Darkling Duo ignored Retain granted by Future Plans')
let muscleRain = createCombat(createRng(491), [{ ...player, character: 'slime_boss', powers: [rain],
  slimes: [muscle] }], [{ ...enemy, uid: 'rain-muscle-target', hp: 10, maxHp: 10 }])
fireTriggers(muscleRain, { kind: 'startOfTurn' })
const muscleRainChoice = pendingTriggerAbility(muscleRain)
assert.deepEqual(pendingTriggerSlimeEnemyChoiceLabels(muscleRain, muscleRainChoice.id, [muscle.card.uid]),
  ['Muscle Slime · level 1 · 1 Strength'], 'Rain of Goop labels its Strength before Command')
assert.equal(pendingTriggerSlimeEnemyChoiceCount(muscleRain, muscleRainChoice.id, [muscle.card.uid]), 1,
  'Rain of Goop collects the target for Muscle Slime\'s Strength trigger')
muscleRain = resolvePendingTrigger(muscleRain, player.id, muscleRainChoice.id, undefined, undefined, undefined, {
  slimeUids: [muscle.card.uid], slimeEnemyUids: ['rain-muscle-target'],
})
assert.equal(muscleRain.enemies[0].hp, 7, 'Rain of Goop Commands Muscle Slime with its new Strength')

for (const [name, upgraded] of [['Combo Tackle', false], ['Feeding Frenzy', false], ['Lick', true], ['Haunting Lick', true]]) {
  const card = { uid: `optional-${name}`, defId: byName.get(name).id, upgraded }
  let optional = createCombat(createRng(50), [{ ...player, character: 'slime_boss', hand: [card], slimes: [], energy: 3 }], [enemy])
  const resolved = playCard(optional, player.id, card.uid, { enemyUid: enemy.uid, playerId: player.id, slimeUids: [] })
  assert.notEqual(resolved, optional, `${name}${upgraded ? '+' : ''} rejected zero optional Slimes`)
}

const tackle = { uid: 'copied-tackle', defId: byName.get('Combo Tackle').id, upgraded: false }
let copied = createCombat(createRng(51), [{
  ...player, character: 'slime_boss', hand: [tackle], draw: [{ uid: 'reaction-draw', defId: 'slime_boss_defend', upgraded: false }],
  slimes: [], energy: 3, block: 0,
  powers: [
    { uid: 'goop-armor', defId: byName.get('Goop Armor').id, upgraded: false },
    { uid: 'consult', defId: byName.get('Consult Playbook').id, upgraded: false },
  ],
}], [enemy])
copied.players[0].doubledAttacksThisTurn = 1
copied = playCard(copied, player.id, tackle.uid, { enemyUid: enemy.uid, playerId: player.id, slimeUids: [] })
assert.equal(copied.players[0].block, 1, 'Goop Armor skipped the original doubled Tackle')
assert.equal(copied.players[0].energy, 2, 'Consult Playbook did not trigger exactly once on the original Tackle')
copied = playCardCopy(copied, player.id, { enemyUid: enemy.uid, playerId: player.id, slimeUids: [] })
assert.equal(copied.players[0].block, 2, 'Goop Armor skipped the copied Tackle')
assert.equal(copied.players[0].energy, 2, 'Consult Playbook triggered more than once this turn')

const doubledFeeding = { uid: 'copied-feeding', defId: byName.get('Feeding Frenzy').id, upgraded: false }
let copiedGrow = createCombat(createRng(52), [{
  ...player, character: 'slime_boss', hand: [doubledFeeding], energy: 3,
  slimes: [leech('copied-leech'), growable('copied-growable')],
}], [{ ...enemy, uid: 'copied-grow-left', hp: 10, maxHp: 10 },
  { ...enemy, uid: 'copied-grow-right', row: 1, hp: 10, maxHp: 10 }])
copiedGrow.players[0].doubledAttacksThisTurn = 1
copiedGrow = playCard(copiedGrow, player.id, doubledFeeding.uid, {
  enemyUid: 'copied-grow-left', playerId: player.id,
  slimeUids: ['copied-growable'], slimeEnemyUids: ['copied-grow-left'],
})
assert(copiedGrow.pendingCardCopy, 'doubled Feeding Frenzy did not queue its physical resolution')
copiedGrow = playCardCopy(copiedGrow, player.id, {
  enemyUid: 'copied-grow-right', playerId: player.id,
  slimeUids: ['copied-growable'], slimeEnemyUids: ['copied-grow-right'],
})
assert.deepEqual(copiedGrow.enemies.map((held) => held.hp), [7, 7],
  'the physical second Grow dropped its deferred Leeching Command')

const ravenous = { uid: 'multi-step-grow', defId: byName.get('Ravenous Tackle').id, upgraded: false }
let multiStepGrow = createCombat(createRng(53), [{
  ...player, character: 'slime_boss', hand: [ravenous], energy: 3,
  slimes: [leech('multi-step-leech'), growable('multi-step-target')],
}], [{ ...enemy, uid: 'multi-step-left', hp: 10, maxHp: 10 },
  { ...enemy, uid: 'multi-step-right', row: 1, hp: 10, maxHp: 10 }])
assert.equal(slimeCommandEnemyChoiceCount(CARDS[ravenous.defId], multiStepGrow, multiStepGrow.players[0],
  ['multi-step-target']), 2, 'Grow twice produces two Leeching target choices')
multiStepGrow = playCard(multiStepGrow, player.id, ravenous.uid, {
  enemyUid: 'multi-step-left', playerId: player.id, slimeUids: ['multi-step-target'],
  slimeEnemyUids: ['multi-step-left', 'multi-step-right'],
})
assert.deepEqual(multiStepGrow.enemies.map((held) => held.hp), [4, 9],
  'each successful level of Grow twice triggers Leeching Slime')

const cappedTarget = { ...growable('near-cap-target'), level: 2 }
const nearCap = createCombat(createRng(54), [{
  ...player, character: 'slime_boss', hand: [ravenous], energy: 3,
  slimes: [leech('near-cap-leech'), cappedTarget],
}], [{ ...enemy, uid: 'near-cap-enemy', hp: 10, maxHp: 10 }])
assert.equal(slimeCommandEnemyChoiceCount(CARDS[ravenous.defId], nearCap, nearCap.players[0],
  [cappedTarget.card.uid]), 1, 'Grow twice queues only the one level still available at the cap')

const growth = { uid: 'lethal-growth', defId: byName.get('Growth').id, upgraded: false }
let lethalLeech = createCombat(createRng(55), [{
  ...player, character: 'slime_boss', hand: [growth], energy: 3,
  slimes: [growable('lethal-growable'), leech('lethal-leech-a'), leech('lethal-leech-b')],
}], [{ ...enemy, uid: 'lethal-leech-target', hp: 1, maxHp: 1 }])
const lethalLeechBefore = lethalLeech
lethalLeech = playCard(lethalLeech, player.id, growth.uid, {
  enemyUid: null, playerId: player.id, slimeUids: ['lethal-growable'],
  slimeEnemyUids: ['lethal-leech-target', 'lethal-leech-target'],
})
assert.notEqual(lethalLeech, lethalLeechBefore, 'a winning deferred Command rolled the card play back')
assert.equal(lethalLeech.enemies[0].dead, true, 'the first deferred Command did not end combat')

const lethalDivide = { uid: 'lethal-divide', defId: byName.get('Divide & Conquer').id, upgraded: false }
let lethalPrinted = createCombat(createRng(56), [{
  ...player, character: 'slime_boss', hand: [lethalDivide], energy: 3,
  slimes: [bruiserSlime('lethal-bruiser'), growable('lethal-scrappy')],
}], [{ ...enemy, uid: 'lethal-command-target', hp: 1, maxHp: 1 }])
const lethalPrintedBefore = lethalPrinted
lethalPrinted = playCard(lethalPrinted, player.id, lethalDivide.uid, {
  energySpent: 2, enemyUid: null, playerId: player.id,
  slimeUids: ['lethal-bruiser', 'lethal-scrappy'],
  slimeEnemyUids: ['lethal-command-target', 'lethal-command-target'],
})
assert.notEqual(lethalPrinted, lethalPrintedBefore, 'a winning printed Command rolled the card play back')
assert.equal(lethalPrinted.enemies[0].dead, true, 'the first printed Command did not end combat')

const staleArmored = {
  card: { uid: 'stale-armored', defId: armoredDef.id, upgraded: false },
  level: 2, vigor: 0, commandsThisTurn: 0, vigorLossAtEndOfTurn: 0, vigorTriggerUsedThisTurn: false,
}
const staleFollowup = { uid: 'stale-followup', defId: byName.get('Lick').id, upgraded: false }
let staleCommandTarget = createCombat(createRng(561), [{
  ...player, character: 'slime_boss', hand: [lethalDivide, staleFollowup], energy: 3,
  slimes: [bruiserSlime('stale-bruiser'), staleArmored],
}], [{ ...enemy, uid: 'stale-command-target', hp: 1, maxHp: 1 },
  { ...enemy, uid: 'stale-command-survivor', row: 1, hp: 10, maxHp: 10 }])
const staleCommandBefore = staleCommandTarget
staleCommandTarget = playCard(staleCommandTarget, player.id, lethalDivide.uid, {
  energySpent: 2, enemyUid: null, playerId: player.id,
  slimeUids: ['stale-bruiser', staleArmored.card.uid],
  slimeEnemyUids: ['stale-command-target', 'stale-command-target'],
})
assert.notEqual(staleCommandTarget, staleCommandBefore, 'a target killed by an earlier Command rolled the play back')
assert.deepEqual(staleCommandTarget.enemies.map((held) => held.hp), [0, 10],
  'a later Command reused a target that an earlier Command killed')
assert.equal(staleCommandTarget.players[0].slimes.find((slime) => slime.card.uid === staleArmored.card.uid)
  ?.commandsThisTurn, 0, 'a skipped stale target consumed Armored Slime\'s only Command')
staleCommandTarget = playCard(staleCommandTarget, player.id, staleFollowup.uid, {
  enemyUid: 'stale-command-survivor', playerId: player.id,
  slimeUids: [staleArmored.card.uid], slimeEnemyUids: ['stale-command-survivor'],
})
assert.equal(staleCommandTarget.enemies[1].vulnerable, 1,
  'Armored Slime could not Command after its stale target was skipped')

const massive = {
  card: { uid: 'lethal-massive', defId: byName.get('Massive Slime').id, upgraded: false },
  level: 1, vigor: 0, commandsThisTurn: 0, vigorLossAtEndOfTurn: 0, vigorTriggerUsedThisTurn: false,
}
const massiveLick = { uid: 'lethal-massive-lick', defId: byName.get('Lick').id, upgraded: false }
let lethalMassive = createCombat(createRng(562), [{
  ...player, character: 'slime_boss', hand: [massiveLick], energy: 3, block: 0, slimes: [massive],
}], [{ ...enemy, uid: 'lethal-massive-target', hp: 1, maxHp: 1 }])
lethalMassive = playCard(lethalMassive, player.id, massiveLick.uid, {
  enemyUid: 'lethal-massive-target', playerId: player.id,
  slimeUids: [massive.card.uid], slimeEnemyUids: ['lethal-massive-target'],
})
assert.equal(lethalMassive.players[0].block, 0,
  'Massive Slime resolved later Command effects after its hit ended combat')

const immediateSlime = (name, uid) => ({ uid, defId: byName.get(name).id, upgraded: false })
let massiveOnPlay = createCombat(createRng(563), [{
  ...player, character: 'slime_boss', hand: [immediateSlime('Massive Slime', 'massive-on-play')], energy: 3, block: 0,
}], [{ ...enemy, uid: 'massive-on-play-target', hp: 10, maxHp: 10 }])
massiveOnPlay = playCard(massiveOnPlay, player.id, 'massive-on-play', {
  enemyUid: 'massive-on-play-target', playerId: player.id,
})
assert.equal(massiveOnPlay.enemies[0].hp, 6, 'Massive Slime did not deal its printed when-played damage')
assert.equal(massiveOnPlay.players[0].block, 2, 'Massive Slime did not gain its printed when-played Block')

let stickyOnPlay = createCombat(createRng(564), [{
  ...player, character: 'slime_boss', hand: [immediateSlime('Sticky Slime', 'sticky-on-play')], energy: 3,
}], [{ ...enemy, uid: 'sticky-on-play-left' }, { ...enemy, uid: 'sticky-on-play-right', row: 1 }])
stickyOnPlay = playCard(stickyOnPlay, player.id, 'sticky-on-play', { enemyUid: null, playerId: player.id })
assert.deepEqual(stickyOnPlay.enemies.map((held) => held.weak), [1, 1],
  'Sticky Slime did not apply its printed when-played Weak to ALL enemies')

let psychicOnPlay = createCombat(createRng(565), [{
  ...player, character: 'slime_boss', hand: [immediateSlime('Psychic Slime', 'psychic-on-play')],
  draw: [immediateSlime('Strike', 'psychic-draw-one'), immediateSlime('Defend', 'psychic-draw-two')], energy: 3,
}], [enemy])
psychicOnPlay = playCard(psychicOnPlay, player.id, 'psychic-on-play', { enemyUid: null, playerId: player.id })
assert.equal(psychicOnPlay.players[0].hand.length, 2, 'Psychic Slime did not draw its printed cards when played')

const emptyOverexert = { uid: 'empty-overexert', defId: byName.get('Overexert').id, upgraded: false }
const emptyOverexertCombat = createCombat(createRng(569), [{
  ...player, character: 'slime_boss', hand: [emptyOverexert], draw: [], discard: [], energy: 3,
}], [enemy])
const emptyOverexertResolved = playCard(emptyOverexertCombat, player.id, emptyOverexert.uid, {
  enemyUid: null, playerId: player.id, searchDrawUids: [],
})
assert.notEqual(emptyOverexertResolved, emptyOverexertCombat,
  'Overexert rejected its legal zero-card choice when nothing was playable')
assert(emptyOverexertResolved.players[0].exhaust.some((card) => card.uid === emptyOverexert.uid),
  'zero-choice Overexert did not finish resolving')

const copiedChoicePreview = (card, draw) => {
  const combat = createCombat(createRng(570), [{
    ...player, character: 'slime_boss', hand: [], draw, discard: [], energy: 3,
  }], [enemy])
  combat.phase = 'copy'
  combat.pendingCardCopy = {
    playerId: player.id, card, energySpent: 1, resumePhase: 'player', forcedExhaust: true,
    forcedChoices: null, deferredHavocs: [], sourceNames: ['Burst'],
  }
  return previewCardCopyChoice(combat, player.id)
}
const copiedOverexertCards = [
  { uid: 'copied-overexert-strike', defId: 'strike_ironclad', upgraded: false },
  { uid: 'copied-overexert-defend', defId: 'defend_ironclad', upgraded: false },
]
assert.deepEqual(copiedChoicePreview(emptyOverexert, copiedOverexertCards).cards.map((card) => card.uid),
  copiedOverexertCards.map((card) => card.uid), 'copied Overexert did not preview its post-draw choice')
const copiedReplicationSlime = { uid: 'copied-replication-slime', defId: byName.get('Sticky Slime').id, upgraded: false }
const copiedReplication = { uid: 'copied-replication', defId: byName.get('Replication').id, upgraded: false }
assert.deepEqual(copiedChoicePreview(copiedReplication, [
  { uid: 'copied-replication-strike', defId: 'strike_ironclad', upgraded: false }, copiedReplicationSlime,
]).cards.map((card) => card.uid), [copiedReplicationSlime.uid],
'copied Replication did not preview its Slime search')

const queueWhirl = (seed, rapidFire = 0, noHoldsBarred = false) => {
  const overexert = { uid: `mode-overexert-${seed}`, defId: byName.get('Overexert').id, upgraded: false }
  const whirl = { uid: `mode-whirl-${seed}`, defId: 'guardian_guardian_whirl', upgraded: false }
  const combat = createCombat(createRng(seed), [{
    ...player, character: 'slime_boss', guardianMode: null, hand: [overexert], draw: [whirl],
    discard: [], energy: 3, slimes: [],
    powers: noHoldsBarred
      ? [{ uid: `mode-no-holds-${seed}`, defId: 'hermit_no_holds_barred', upgraded: false }]
      : [],
  }], [enemy])
  combat.players[0].nextAttackRapidFire = rapidFire
  return playCard(combat, player.id, overexert.uid, {
    enemyUid: null, playerId: player.id, searchDrawUids: [whirl.uid],
  })
}
let defenseWhirl = queueWhirl(5691, 1, true)
assert.deepEqual(defenseWhirl.pendingCardCopy?.sourceNames, ['Overexert'],
  'Overexert counted Rapid Fire before the Guardian mode choice')
defenseWhirl = playCardCopy(defenseWhirl, player.id, {
  enemyUid: null, playerId: player.id, corruptedShardMode: 'defense',
})
assert.equal(defenseWhirl.pendingCardCopy, undefined,
  'Overexert repeated a variable Guardian card after it became a Defense-Mode Skill')
assert.equal(defenseWhirl.players[0].cardsPlayedThisTurn, 2,
  'Defense-Mode Overexert resolved the selected Skill more than once')
assert.equal(defenseWhirl.players[0].nextAttackRapidFire, 1,
  'Defense-Mode Overexert consumed the next-Attack Rapid Fire bonus')
let attackWhirl = queueWhirl(5692, 1, true)
attackWhirl = playCardCopy(attackWhirl, player.id, {
  enemyUid: enemy.uid, playerId: player.id, corruptedShardMode: 'attack',
})
assert(attackWhirl.pendingCardCopy, 'Overexert did not repeat a variable Guardian card chosen as an Attack')
assert.equal(attackWhirl.pendingCardCopy.sourceNames.length, 5,
  'Attack-Mode Overexert did not apply Vantage and No Holds Barred after choosing the mode')
while (attackWhirl.pendingCardCopy) {
  attackWhirl = playCardCopy(attackWhirl, player.id, { enemyUid: enemy.uid, playerId: player.id })
}
assert.equal(attackWhirl.players[0].cardsPlayedThisTurn, 7,
  'Attack-Mode Overexert did not resolve both plays and their Rapid Fire copies')
assert.equal(attackWhirl.players[0].nextAttackRapidFire, 0,
  'Attack-Mode Overexert did not consume the next-Attack Rapid Fire bonus')
assert.deepEqual(attackWhirl.presentationEvents
  .filter((event) => event.kind === 'card' && event.sourceId === 'guardian_guardian_whirl')
  .map((event) => event.copied), [true, true, true, true, true, false],
  'Overexert did not preserve the shared virtual-copies-first, physical-original-last contract')

const replication = { uid: 'replication-plus', defId: byName.get('Replication').id, upgraded: true }
const replicated = { uid: 'replicated-sticky', defId: byName.get('Sticky Slime').id, upgraded: false }
const replicationBruiser = bruiserSlime('replication-bruiser')
let replicatedCombat = createCombat(createRng(57), [{
  ...player, character: 'slime_boss', hand: [replication], draw: [replicated], energy: 3,
  powers: [{ uid: 'replication-darkling', defId: byName.get('Darkling Duo').id, upgraded: false }],
  slimes: [leech('replication-leech'), replicationBruiser],
}], [{ ...enemy, uid: 'replication-target', hp: 1, maxHp: 1 }])
replicatedCombat = playCard(replicatedCombat, player.id, replication.uid, {
  enemyUid: null, playerId: player.id, searchDrawUids: [replicated.uid],
})
assert(replicatedCombat.pendingCardCopy?.card.growOnPlay, 'Replication+ did not preserve its post-play Grow')
assert.equal(slimeCommandEnemyChoiceCount(CARDS[replicated.defId], replicatedCombat,
  replicatedCombat.players[0], [], 0, 0, replicatedCombat.pendingCardCopy.card), 2,
  'Replication+ did not collect its Leeching and retained-card Command targets')
replicatedCombat = playCardCopy(replicatedCombat, player.id, {
  enemyUid: null, playerId: player.id,
  slimeEnemyUids: ['replication-target', 'replication-target'],
})
assert.equal(replicatedCombat.players[0].slimes.find((slime) => slime.card.uid === replicated.uid)?.level, 2,
  'Replication+ did not Grow the played Slime')
assert.equal(replicatedCombat.enemies[0].dead, true, 'Replication+ bypassed the Leeching Grow trigger')
assert.equal(replicatedCombat.players[0].slimes.find((slime) => slime.card.uid === replicationBruiser.card.uid)
  ?.commandsThisTurn, 0, 'Replication+ continued into Darkling Duo after its Grow trigger ended combat')

console.log('Downfall Slime Boss: 67 definitions, 88 physical cards, 13 complete Slime level tables, and core mechanics verified.')
