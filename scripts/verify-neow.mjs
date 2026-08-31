import { CARDS } from '../src/game/cards.ts'
import { createCampaignProgress } from '../src/game/campaign.ts'
import { HEARTS_BOON_CARDS, NEOW_CARDS, formatHeartBoonLabel } from '../src/game/neow.ts'
import {
  chooseNeow,
  createRun,
  GOLDEN_TICKET,
  neowPreview,
  pendingRelicEligibleCards,
  pendingRelicPreview,
  revealNeowReward,
  resolveNeowEffect,
  resolveNeowGold,
  resolveNeowReward,
  resolvePendingRelic,
} from '../src/game/run.ts'
import { suite, check, assert, assertDeepEqual, assertEqual, report } from './lib/harness.mjs'

suite("Neow's Blessing")

const party = (count = 2) => [
  { id: 'p1', name: 'Ironclad', character: 'ironclad' },
  { id: 'p2', name: 'Silent', character: 'silent' },
  { id: 'p3', name: 'Defect', character: 'defect' },
  { id: 'p4', name: 'Watcher', character: 'watcher' },
].slice(0, count)

const beginBlue = (seed = 1, count = 2, progress = createCampaignProgress()) => {
  let run = createRun(seed, party(count), 0, progress)
  run = resolveNeowGold(run, 'p1', false)
  return resolveNeowReward(run, 'p1', null)
}

const forceCard = (run, cardId) => ({
  ...run,
  neow: { ...run.neow, players: { ...run.neow.players, p1: { ...run.neow.players.p1, cardId } } },
})

const beginHeart = (seed, cardId) => {
  let run = createRun(seed, [{ id: 'p1', name: 'Guardian', character: 'guardian' }])
  while (run.neow.players.p1.redRewardPending) run = resolveNeowReward(run, 'p1', null)
  return forceCard(run, cardId)
}

const choiceUids = (run, option) => {
  const selection = option.effects.find((effect) => ['upgrade', 'remove', 'transform'].includes(effect.kind) && !effect.random)
  if (!selection) return []
  const legal = run.players[0].deck.filter((card) => selection.kind === 'upgrade'
    ? !card.upgraded && CARDS[card.defId]?.upgrade
    : selection.kind === 'remove' ? card.defId !== 'ascenders_bane' : CARDS[card.defId]?.owner !== 'curse')
  return legal.slice(0, selection.count).map((card) => card.uid)
}

const resolveImmediate = (run, gain = true) => {
  const effect = run.neow?.players.p1?.pendingEffect
  return effect ? resolveNeowEffect(run, 'p1', gain, { cardUids: gain ? choiceUids(run, { effects: [effect] }) : [] }) : run
}

const inventory = NEOW_CARDS.map((card) => card.options.map((option) => option.label))

check("Heart's Boon labels name Rare rewards and pluralize Potions", () => {
  assertEqual(formatHeartBoonLabel('Gain [yellow-card-reward].'), 'Gain a Rare Card Reward.')
  assertEqual(formatHeartBoonLabel('Gain [potion].'), 'Gain Potion.')
  assertEqual(formatHeartBoonLabel('Gain 1 [potion].'), 'Gain 1 Potion.')
  assertEqual(formatHeartBoonLabel('Gain 3 [potion].'), 'Gain 3 Potions.')
  assert(HEARTS_BOON_CARDS.every((card) => card.options.every((option) =>
    !option.label.includes('[yellow-card-reward]') && !option.label.includes('[potion]'))))
})

check('the exact 14 base and six Colorless-unlocked faces are transcribed', () => {
  assertEqual(NEOW_CARDS.length, 20)
  assertEqual(NEOW_CARDS.filter((card) => !card.unlocked).length, 14)
  assertEqual(NEOW_CARDS.filter((card) => card.unlocked).length, 6)
  assertDeepEqual(inventory, [
    ['Upgrade 1 card', 'Remove 1 card', 'Gain 10 Gold, lose 2 HP'],
    ['Upgrade 1 card', 'Gain 1 random Rare card', 'Gain 10 Gold and 1 Curse'],
    ['Upgrade 1 card', 'Gain 5 Gold', 'Gain 1 Relic and 1 Curse'],
    ['Upgrade 1 card', 'Gain 3 Potions', 'Gain 1 Rare Card Reward and 1 Curse'],
    ['Gain 3 Potions', 'Gain 1 Card Reward', 'Gain 1 Relic, lose 3 Gold'],
    ['Remove 1 card', 'Transform 1 card', 'Gain 1 Relic, lose 2 HP'],
    ['Gain 5 Gold', 'Gain 1 random Rare card', 'Gain 1 Rare Card Reward, lose 3 Gold'],
    ['Upgrade 1 card', 'Gain 3 Potions', 'Upgrade 2 random cards, lose 2 HP'],
    ['Transform 1 card', 'Gain 5 Gold', 'Remove 2 cards, lose 3 HP'],
    ['Gain 1 random Rare card', 'Gain 1 Card Reward', 'Remove 2 cards, lose 2 HP'],
    ['Gain 1 random Rare card', 'Transform 1 card', 'Upgrade 2 random cards and gain 1 Curse'],
    ['Remove 1 card', 'Gain 5 Gold', 'Upgrade 2 random cards, lose 3 Gold'],
    ['Remove 1 card', 'Transform 1 card', 'Transform 2 cards, lose 3 HP'],
    ['Remove 1 card', 'Gain 3 Potions', 'Gain 5 Gold, 1 Card Reward, and 1 Curse'],
    ['Gain 1 Colorless Card Reward', 'Transform 1 card', 'Gain 10 Gold, lose 2 HP'],
    ['Gain 1 Colorless Card Reward', 'Remove 1 card', 'Gain 1 Rare Card Reward, lose 2 HP'],
    ['Gain 1 Colorless Card Reward', 'Gain 1 random Rare card', 'Gain 1 Relic, lose 3 Gold'],
    ['Gain 1 Colorless Card Reward', 'Upgrade 1 card', 'Remove 2 cards, lose 3 Gold'],
    ['Gain 1 Colorless Card Reward', 'Gain 3 Potions', 'Transform 2 cards and gain 1 Curse'],
    ['Transform 1 card', 'Gain 5 Gold', 'Gain 2 Colorless Card Rewards and 1 Curse'],
  ])
})

check('createRun deals one deterministic unique base face per player and red rewards precede blue choices', () => {
  const first = createRun(4001, party(4))
  const same = createRun(4001, party(4))
  assertEqual(first.phase, 'neow')
  assertEqual(first.neow.deck.length, 10)
  const faces = Object.values(first.neow.players).map((progress) => progress.cardId)
  assertEqual(new Set(faces).size, 4)
  assertDeepEqual(faces, Object.values(same.neow.players).map((progress) => progress.cardId))
  assert(faces.every((id) => !NEOW_CARDS.find((card) => card.id === id).unlocked))
  assert(first.players.every((player) => player.gold === 0))
  assert(first.players.every((player) => first.neow.players[player.id].redGoldPending && first.neow.players[player.id].redRewardPending && first.neow.players[player.id].redReward === null))
  assertEqual(chooseNeow(first, 'p1', 0), first, 'blue resolved before the red reward')
  let skipped = resolveNeowGold(first, 'p1', false)
  skipped = resolveNeowReward(skipped, 'p1', null)
  assertEqual(skipped.neow.players.p1.redReward, null)
  assert(neowPreview(skipped, 'p1').card)
  assertEqual('deck' in neowPreview(skipped, 'p1'), false)
  let rejected = 0
  for (const invalid of [[], [...party(4), { id: 'p5', name: 'Fifth', character: 'ironclad' }]]) {
    try { createRun(1, invalid) } catch { rejected++ }
  }
  assertEqual(rejected, 2)
})

check('Colorless unlock adds exactly the six unlock faces to the deal', () => {
  const progress = createCampaignProgress()
  progress.colorless = 3
  let sawUnlocked = false
  for (let seed = 0; seed < 100; seed++) {
    const run = createRun(seed, party(4), 0, progress)
    assertEqual(run.neow.deck.length, 16)
    sawUnlocked ||= Object.values(run.neow.players).some((offer) => NEOW_CARDS.find((card) => card.id === offer.cardId).unlocked)
  }
  assert(sawUnlocked, 'the unlocked faces never entered the shuffled deck')
})

check('All Star supplies Colorless cards without unlocking Colorless Neow faces', () => {
  const run = createRun(4050, party(1), 0, createCampaignProgress(), false, false, {
    mode: 'custom', modifiers: ['all_star'],
  })
  assert(run.itemDecks.colorless.length > 0)
  const faceIds = [run.neow.players.p1.cardId, ...run.neow.deck]
  assertEqual(faceIds.length, 14)
  assert(faceIds.every((id) => !NEOW_CARDS.find((card) => card.id === id).unlocked))
})

check('Heirloom Tiny House gains and conserves its Potion during Neow', () => {
  const run = createRun(16, party(1), 0, createCampaignProgress(), false, false, {
    mode: 'custom', modifiers: ['heirloom'],
  })
  assert(run.players[0].relics.some((relic) => relic.defId === 'tiny_house'))
  assertEqual(run.players[0].potions.length, 1)
  assertEqual(run.potionDeck.length + run.players[0].potions.length, 29)
  assertDeepEqual(run.itemDecks.potions, run.potionDeck)
})

check('Transformed replaces red and blue normal Neow Card Rewards', () => {
  let run = createRun(4051, party(1), 0, createCampaignProgress(), false, false, {
    mode: 'custom', modifiers: ['transformed'],
  })
  run = resolveNeowGold(run, 'p1', false)
  run = revealNeowReward(run, 'p1')
  assertDeepEqual(run.neow.players.p1.pendingEffect, { kind: 'transform', count: 1 })
  const firstUid = run.players[0].deck.find((card) => CARDS[card.defId]?.owner !== 'curse').uid
  run = resolveNeowEffect(run, 'p1', true, { cardUids: [firstUid] })

  run = forceCard(run, 'neow_05')
  run = chooseNeow(run, 'p1', 1)
  run = revealNeowReward(run, 'p1')
  assertDeepEqual(run.neow.players.p1.pendingEffect, { kind: 'transform', count: 1 })
  const secondUid = run.players[0].deck.find((card) => CARDS[card.defId]?.owner !== 'curse').uid
  run = resolveNeowEffect(run, 'p1', true, { cardUids: [secondUid] })
  assertEqual(run.phase, 'map')
})

check('all sixty printed blue options are legal from an ordinary opening deck', () => {
  for (const card of NEOW_CARDS) for (let optionIndex = 0; optionIndex < 3; optionIndex++) {
    const progress = createCampaignProgress()
    if (card.unlocked) progress.colorless = 1
    let run = forceCard(beginBlue(4100 + Number(card.id.replace(/\D/g, '')), 2, progress), card.id)
    const before = run
    run = chooseNeow(run, 'p1', optionIndex)
    assert(run !== before, `${card.id} option ${optionIndex + 1} was refused`)
    assertEqual(run.neow?.players.p1.blueOption, optionIndex)
  }
})

check('red and blue Card Rewards reveal three, may be skipped, and bottom unused cards', () => {
  let run = createRun(4201, party(2))
  run = resolveNeowGold(run, 'p1', true)
  run = revealNeowReward(run, 'p1')
  const red = run.neow.players.p1.redReward
  const beforeDeck = [...run.players[0].cardRewards]
  run = resolveNeowReward(run, 'p1', 0)
  assert(run.players[0].deck.some((card) => card.defId === red.choices[0]))
  assertEqual(run.players[0].cardRewards.length, beforeDeck.length - 1)
  assertDeepEqual(run.players[0].cardRewards.slice(-2), red.cardsDrawn.filter((id) => id !== 'golden_ticket').slice(1))

  run = forceCard(run, 'neow_05')
  run = chooseNeow(run, 'p1', 1)
  assertEqual(run.neow.players.p1.reward, null)
  run = revealNeowReward(run, 'p1')
  const blue = run.neow.players.p1.reward
  const deckSize = run.players[0].deck.length
  run = resolveNeowReward(run, 'p1', null)
  assertEqual(run.players[0].deck.length, deckSize)
  assert(run.players[0].cardRewards.slice(-blue.cardsDrawn.length).every((id, index) => id === blue.cardsDrawn[index]))
})

check('unseen rewards skip without drawing while revealed rewards advance and bottom exact cards', () => {
  let red = createRun(4251, party(2))
  const redDeck = [...red.players[0].cardRewards]
  red = resolveNeowGold(red, 'p1', false)
  red = resolveNeowReward(red, 'p1', null)
  assertDeepEqual(red.players[0].cardRewards, redDeck)
  assertEqual(red.neow.players.p1.redRewardPending, false)

  let card = forceCard(beginBlue(4252), 'neow_05')
  card = chooseNeow(card, 'p1', 1)
  const cardDeck = [...card.players[0].cardRewards]
  card = resolveNeowReward(card, 'p1', null)
  assertDeepEqual(card.players[0].cardRewards, cardDeck)

  const progress = createCampaignProgress()
  progress.colorless = 3
  let colorless = forceCard(beginBlue(4253, 2, progress), 'neow_c01')
  colorless = chooseNeow(colorless, 'p1', 0)
  const colorlessDeck = [...colorless.itemDecks.colorless]
  colorless = resolveNeowReward(colorless, 'p1', null)
  assertDeepEqual(colorless.itemDecks.colorless, colorlessDeck)

  let potion = forceCard(beginBlue(4254), 'neow_04')
  potion = chooseNeow(potion, 'p1', 1)
  const potionDeck = [...potion.potionDeck]
  potion = resolveNeowReward(potion, 'p1', null)
  assertDeepEqual(potion.potionDeck, potionDeck)

  let relic = forceCard(beginBlue(4255), 'neow_03')
  const curses = relic.itemDecks.curses.length
  relic = chooseNeow(relic, 'p1', 2)
  const relicDeck = [...relic.relicDeck]
  assertEqual(relic.itemDecks.curses.length, curses, 'the Curse resolved before the preceding Relic choice')
  relic = resolveNeowReward(relic, 'p1', null)
  assertDeepEqual(relic.relicDeck, relicDeck)
  assertEqual(relic.itemDecks.curses.length, curses - 1, 'skipping the preceding Relic also skipped its mandatory Curse')

  let revealed = forceCard(beginBlue(4256), 'neow_03')
  revealed = chooseNeow(revealed, 'p1', 2)
  const top = revealed.relicDeck[0]
  revealed = revealNeowReward(revealed, 'p1')
  assertEqual(revealed.neow.players.p1.reward.choices[0], top)
  assertEqual(revealed.relicDeck.includes(top), false)
  revealed = resolveNeowReward(revealed, 'p1', null)
  assertEqual(revealed.relicDeck.at(-1), top)
})

check('every immediate positive reward may be skipped independently while ordered penalties still resolve', () => {
  let red = createRun(4270, party(2))
  red = resolveNeowGold(red, 'p1', false)
  assertEqual(red.players[0].gold, 0)
  assert(red.neow.players.p1.redRewardPending, 'skipping Gold also skipped the Card Reward')

  let gold = forceCard(beginBlue(4271), 'neow_01')
  const hp = gold.players[0].hp
  gold = chooseNeow(gold, 'p1', 2)
  assertEqual(gold.players[0].hp, hp, 'later HP loss resolved before the preceding Gold decision')
  gold = resolveNeowEffect(gold, 'p1', false)
  assertEqual(gold.players[0].gold, 0)
  assertEqual(gold.players[0].hp, hp - 2)

  let upgrade = forceCard(beginBlue(4272), 'neow_01')
  const upgradeUid = upgrade.players[0].deck.find((card) => !card.upgraded && CARDS[card.defId]?.upgrade)?.uid
  upgrade = chooseNeow(upgrade, 'p1', 0)
  upgrade = resolveNeowEffect(upgrade, 'p1', false)
  assert(!upgrade.players[0].deck.find((card) => card.uid === upgradeUid)?.upgraded)

  let remove = forceCard(beginBlue(4273), 'neow_01')
  const removeSize = remove.players[0].deck.length
  remove = chooseNeow(remove, 'p1', 1)
  remove = resolveNeowEffect(remove, 'p1', false)
  assertEqual(remove.players[0].deck.length, removeSize)

  let transform = forceCard(beginBlue(4274), 'neow_06')
  const transformDeck = structuredClone(transform.players[0].deck)
  transform = chooseNeow(transform, 'p1', 1)
  transform = resolveNeowEffect(transform, 'p1', false)
  assertDeepEqual(transform.players[0].deck, transformDeck)

  let rare = forceCard(beginBlue(4275), 'neow_02')
  const rareDeck = [...rare.players[0].rareRewards]
  rare = chooseNeow(rare, 'p1', 1)
  rare = resolveNeowEffect(rare, 'p1', false)
  assertDeepEqual(rare.players[0].rareRewards, rareDeck)
})

check('direct random Rare differs from a staged three-card Rare Reward', () => {
  let direct = forceCard(beginBlue(4301), 'neow_02')
  const top = direct.players[0].rareRewards[0]
  direct = chooseNeow(direct, 'p1', 1)
  direct = resolveImmediate(direct)
  assert(direct.players[0].deck.some((card) => card.defId === top))
  assertEqual(direct.players[0].rareRewards.includes(top), false)
  assertEqual(direct.neow.players.p1.reward, null)

  let staged = forceCard(beginBlue(4302), 'neow_04')
  staged = chooseNeow(staged, 'p1', 2)
  assertEqual(staged.neow.players.p1.reward, null)
  staged = revealNeowReward(staged, 'p1')
  assertEqual(staged.neow.players.p1.reward.kind, 'rare')
  assertEqual(staged.neow.players.p1.reward.choices.length, 3)
})

check('two Colorless rewards resolve sequentially and conserve their shared physical deck', () => {
  const progress = createCampaignProgress()
  progress.colorless = 3
  let run = forceCard(beginBlue(4401, 2, progress), 'neow_c06')
  const total = run.itemDecks.colorless.length
  run = chooseNeow(run, 'p1', 2)
  run = revealNeowReward(run, 'p1')
  const first = [...run.neow.players.p1.reward.choices]
  run = resolveNeowReward(run, 'p1', 0)
  run = revealNeowReward(run, 'p1')
  const second = [...run.neow.players.p1.reward.choices]
  assert(first.every((id) => !second.includes(id)), 'the second offer redrew a still-reserved first offer')
  run = resolveNeowReward(run, 'p1', null)
  assertEqual(run.itemDecks.colorless.length + run.players[0].deck.filter((card) => first.includes(card.defId)).length, total)
  assertEqual(run.players[0].deck.some((card) => card.defId === first[0]), true)
})

check("Heart's Boon conserves unchosen Relics and duplicate random Card Rewards", () => {
  for (const [index, cardId] of ['heart_boon_12', 'heart_boon_14'].entries()) {
    let run = beginHeart(4450 + index, cardId)
    const offer = ['anchor', 'happy_flower', 'vajra']
    const tail = run.relicDeck.filter((id) => !offer.includes(id))
    run = { ...run, relicDeck: [...offer, ...tail], itemDecks: { ...run.itemDecks, relics: [...offer, ...tail] } }
    run = chooseNeow(run, 'p1', 2)
    run = revealNeowReward(run, 'p1')
    assertDeepEqual(run.neow.players.p1.reward.choices, offer)
    run = resolveNeowReward(run, 'p1', 1)
    assert(run.players[0].relics.some((relic) => relic.defId === 'happy_flower'))
    assertEqual(run.relicDeck.length, offer.length + tail.length - 1)
    assertDeepEqual(run.relicDeck.slice(-2), ['anchor', 'vajra'])
    assertDeepEqual(run.itemDecks.relics, run.relicDeck)
  }

  let duplicate = beginHeart(4452, 'heart_boon_15')
  const deckSize = duplicate.players[0].deck.length
  duplicate.players[0].cardRewards = ['anger', 'anger', ...duplicate.players[0].cardRewards]
  duplicate = chooseNeow(duplicate, 'p1', 2)
  duplicate = resolveNeowEffect(duplicate, 'p1', true)
  assertEqual(duplicate.players[0].deck.length, deckSize + 2)
  assertDeepEqual(duplicate.players[0].deck.slice(-2).map((card) => card.defId), ['anger', 'anger'])
  assertEqual(duplicate.players[0].cardRewards[0] === 'anger' && duplicate.players[0].cardRewards[1] === 'anger', false)

  let tickets = beginHeart(4453, 'heart_boon_15')
  const rares = tickets.players[0].rareRewards.slice(0, 2)
  tickets.players[0].cardRewards = [GOLDEN_TICKET, GOLDEN_TICKET, ...tickets.players[0].cardRewards]
  tickets = chooseNeow(tickets, 'p1', 2)
  tickets = resolveNeowEffect(tickets, 'p1', true)
  assertDeepEqual(tickets.players[0].deck.slice(-2).map((card) => card.defId), rares)
  assertDeepEqual(tickets.players[0].cardRewards.slice(-2), [GOLDEN_TICKET, GOLDEN_TICKET])
})

check('three Potion icons are independent offers with pass, replace, skip, and A4 conservation', () => {
  let run = forceCard(beginBlue(4501), 'neow_04')
  run = { ...run, ascension: 4 }
  const total = run.potionDeck.length + run.players.reduce((sum, player) => sum + player.potions.length, 0)
  run = chooseNeow(run, 'p1', 1)
  run = revealNeowReward(run, 'p1')
  const first = run.neow.players.p1.reward.choices[0]
  run = resolveNeowReward(run, 'p1', { kind: 'pass', playerId: 'p2' })
  run = revealNeowReward(run, 'p1')
  assert(run.players[1].potions.includes(first))
  const second = run.neow.players.p1.reward.choices[0]
  run = resolveNeowReward(run, 'p1', { kind: 'gain' })
  run = revealNeowReward(run, 'p1')
  const third = run.neow.players.p1.reward.choices[0]
  run = resolveNeowReward(run, 'p1', { kind: 'replace', potionId: second })
  assertDeepEqual(run.players[0].potions, [third])
  assertEqual(run.potionDeck.length + run.players.reduce((sum, player) => sum + player.potions.length, 0), total)

  let skipped = forceCard(beginBlue(4502), 'neow_04')
  skipped = chooseNeow(skipped, 'p1', 1)
  skipped = revealNeowReward(skipped, 'p1')
  const bottom = skipped.neow.players.p1.reward.choices[0]
  skipped = resolveNeowReward(skipped, 'p1', { kind: 'skip' })
  assertEqual(skipped.potionDeck.at(-1), bottom)
})

check('mandatory penalties persist when their staged positive reward is skipped', () => {
  let run = forceCard(beginBlue(4601), 'neow_07')
  const hp = run.players[0].hp
  const gold = run.players[0].gold
  run = chooseNeow(run, 'p1', 2)
  run = resolveNeowReward(run, 'p1', null)
  assertEqual(run.players[0].gold, Math.max(0, gold - 3))
  assertEqual(run.players[0].hp, hp)

  run = forceCard(beginBlue(4602), 'neow_c02')
  const hp2 = run.players[0].hp
  run = chooseNeow(run, 'p1', 2)
  run = resolveNeowReward(run, 'p1', null)
  assertEqual(run.players[0].hp, hp2 - 2)
})

check('canonical removal, transforms, Eggs, curses, and one-shot Relics retain their rules', () => {
  let run = forceCard(beginBlue(4701), 'neow_01')
  run.players[0].deck[0] = { ...run.players[0].deck[0], defId: 'parasite' }
  const maxHp = run.players[0].maxHp
  const parasite = run.players[0].deck[0].uid
  run = chooseNeow(run, 'p1', 1)
  run = resolveNeowEffect(run, 'p1', true, { cardUids: [parasite] })
  assertEqual(run.players[0].maxHp, maxHp - 2)

  run = forceCard(beginBlue(4702), 'neow_02')
  run.players[0].relics.push({ defId: 'molten_egg', spent: false })
  run.players[0].rareRewards = ['bludgeon']
  run = chooseNeow(run, 'p1', 1)
  run = resolveImmediate(run)
  assert(run.players[0].deck.some((card) => card.defId === 'bludgeon' && card.upgraded))

  run = forceCard(beginBlue(4703), 'neow_03')
  run.relicDeck = ['war_paint', ...run.relicDeck.filter((id) => id !== 'war_paint')]
  run.itemDecks.relics = [...run.relicDeck]
  run = chooseNeow(run, 'p1', 2)
  assertEqual(run.neow.players.p1.rewardKind, 'relic')
  run = revealNeowReward(run, 'p1')
  run = resolveNeowReward(run, 'p1', 0)
  assert(pendingRelicPreview(run, 'p1'))
  const cursesBeforePending = run.itemDecks.curses.length
  const pending = pendingRelicPreview(run, 'p1')
  const eligible = pendingRelicEligibleCards(run.players[0], pending.relicId)
  run = resolvePendingRelic(run, 'p1', eligible.slice(0, 1).map((card) => card.uid))
  assertEqual(run.itemDecks.curses.length, cursesBeforePending - 1)
  assertEqual(run.neow.players.p1.done, true)
})

check('a preceding Omamori can prevent Neow\'s following Curse, but skipping it cannot', () => {
  let taken = forceCard(beginBlue(4751), 'neow_03')
  taken.relicDeck = ['omamori', ...taken.relicDeck.filter((id) => id !== 'omamori')]
  taken.itemDecks.relics = [...taken.relicDeck]
  const takenCurses = taken.itemDecks.curses.length
  taken = chooseNeow(taken, 'p1', 2)
  assertEqual(taken.itemDecks.curses.length, takenCurses, 'the Curse resolved before the Relic decision')
  taken = revealNeowReward(taken, 'p1')
  taken = resolveNeowReward(taken, 'p1', 0)
  assert(taken.players[0].relics.some((relic) => relic.defId === 'omamori'))
  assertEqual(taken.itemDecks.curses.length, takenCurses, 'Omamori did not prevent the following Curse')

  let skipped = forceCard(beginBlue(4752), 'neow_03')
  skipped.relicDeck = ['omamori', ...skipped.relicDeck.filter((id) => id !== 'omamori')]
  skipped.itemDecks.relics = [...skipped.relicDeck]
  const skippedCurses = skipped.itemDecks.curses.length
  skipped = chooseNeow(skipped, 'p1', 2)
  skipped = revealNeowReward(skipped, 'p1')
  skipped = resolveNeowReward(skipped, 'p1', null)
  assert(!skipped.players[0].relics.some((relic) => relic.defId === 'omamori'))
  assertEqual(skipped.itemDecks.curses.length, skippedCurses - 1, 'skipping Omamori also skipped the following Curse')
  assertEqual(skipped.relicDeck.at(-1), 'omamori')
})

check('no-legal-card options resolve as no-ops while random choices remain deterministic', () => {
  let first = forceCard(beginBlue(4801), 'neow_08')
  first.players[0].deck = first.players[0].deck.map((card) => ({ ...card, upgraded: true }))
  const beforeHp = first.players[0].hp
  const same = structuredClone(first)
  first = chooseNeow(first, 'p1', 2)
  first = resolveImmediate(first)
  const second = chooseNeow(same, 'p1', 2)
  const resolvedSecond = resolveImmediate(second)
  assertDeepEqual(first.players[0].deck, resolvedSecond.players[0].deck)
  assertEqual(first.players[0].hp, beforeHp - 2)

  let noRemove = forceCard(beginBlue(4802), 'neow_01')
  noRemove.players[0].deck = noRemove.players[0].deck.map((card) => ({ ...card, defId: 'ascenders_bane' }))
  noRemove = chooseNeow(noRemove, 'p1', 1)
  noRemove = resolveImmediate(noRemove)
  assertEqual(noRemove.players[0].deck.length, 10)
})

check('Prismatic Neow bottoms every unused physical card without overwriting its owner', () => {
  let run = createRun(4850, party(3), 0, createCampaignProgress(), false, false, {
    mode: 'custom', modifiers: ['prismatic_shard'],
  })
  run.players = run.players.map((player) => ({
    ...player,
    cardRewards: player.character === 'ironclad' ? ['anger', 'cleave']
      : player.character === 'silent' ? ['acrobatics', 'backflip'] : ['claw', 'leap'],
  }))
  run = resolveNeowGold(run, 'p1', false)
  run = revealNeowReward(run, 'p1', ['ironclad', 'silent', 'defect'])
  assertDeepEqual(run.neow.players.p1.redReward.choices, ['anger', 'acrobatics', 'claw'])
  run = resolveNeowReward(run, 'p1', 1)
  assertDeepEqual(run.players.find((player) => player.id === 'p1').cardRewards, ['cleave', 'anger'])
  assertDeepEqual(run.players.find((player) => player.id === 'p2').cardRewards, ['backflip'])
  assertDeepEqual(run.players.find((player) => player.id === 'p3').cardRewards, ['leap', 'claw'])
  assert(run.players.find((player) => player.id === 'p1').deck.some((card) => card.defId === 'acrobatics'))
})

check('Guardian Neow offers reveal and settle Socket Gems with the draft', () => {
  const guardian = [{ id: 'p1', name: 'Guardian', character: 'guardian' }]
  const stage = (seed, kind) => {
    const run = createRun(seed, guardian, 0, createCampaignProgress(), false, false, { ruleset: 'downfall' })
    const progress = run.neow.players.p1
    return {
      ...run,
      neow: { ...run.neow, players: { p1: { ...progress, redGoldPending: false,
        redRewardPending: false, redReward: null, rewardKind: kind, reward: null } } },
    }
  }

  let run = stage(4852, 'card')
  run.players[0].cardRewards = ['guardian_crystal_edge', 'guardian_orb_slam', 'guardian_fortify']
  run.guardianGemDeck = ['guardian_ruby', 'guardian_onyx', ...run.guardianGemDeck.slice(2)]
  const gems = run.guardianGemDeck.slice(0, 2)
  run = revealNeowReward(run, 'p1')
  assertDeepEqual(run.neow.players.p1.reward.guardianGems, gems)
  assertEqual(run.guardianGemDeck.length, 22)
  run = resolveNeowReward(run, 'p1', 0)
  assertDeepEqual(run.pendingGuardianSockets[0].gemIds, gems)

  let skipped = stage(4853, 'rare')
  skipped.players[0].rareRewards = ['guardian_bauble_burst', 'guardian_destroy', 'guardian_overclock']
  const rareGems = skipped.guardianGemDeck.slice(0, 2)
  skipped = revealNeowReward(skipped, 'p1')
  assertDeepEqual(skipped.neow.players.p1.reward.guardianGems, rareGems)
  skipped = resolveNeowReward(skipped, 'p1', null)
  assertDeepEqual(skipped.guardianGemDeck.slice(-2), rareGems)

  let prismatic = stage(4854, 'card')
  prismatic.players[0].relics.push({ defId: 'prismatic_shard', spent: false })
  prismatic.neow.players.p1.rewardRequest = { look: 3, upgraded: true }
  prismatic.players[0].cardRewards = ['guardian_crystal_edge']
  prismatic.itemDecks.characterCards = {
    ...prismatic.itemDecks.characterCards,
    guardian: ['guardian_crystal_edge'], ironclad: ['anger'], silent: ['acrobatics'],
  }
  const prismaticGems = prismatic.guardianGemDeck.slice(0, 2)
  prismatic = revealNeowReward(prismatic, 'p1', ['guardian', 'ironclad', 'silent'])
  assertDeepEqual(prismatic.neow.players.p1.reward.guardianGems, prismaticGems)
  assertEqual(prismatic.neow.players.p1.reward.upgraded, true)
  prismatic = resolveNeowReward(prismatic, 'p1', 0)
  assert(prismatic.players[0].deck.some((card) => card.defId === 'guardian_crystal_edge' && card.upgraded))
})

check('Transformed Neow does not require irrelevant Prismatic reward sources', () => {
  let run = createRun(4851, party(1), 0, createCampaignProgress(), false, false, {
    mode: 'custom', modifiers: ['prismatic_shard', 'transformed'],
  })
  run = resolveNeowGold(run, 'p1', false)
  assertDeepEqual(neowPreview(run, 'p1').availableSources, [])
  const next = revealNeowReward(run, 'p1', [])
  assert(next !== run)
  assert(next.neow.players.p1.pendingEffect?.kind === 'transform')
})

check('solo receives 2 Gold and Loaded Die only after every Neow decision is complete', () => {
  let run = createRun(4901, party(1))
  assertEqual(run.players[0].gold, 0)
  assert(!run.players[0].relics.some((relic) => relic.defId === 'loaded_die'))
  run = resolveNeowGold(run, 'p1', false)
  run = resolveNeowReward(run, 'p1', null)
  run = forceCard(run, 'neow_01')
  const uid = run.players[0].deck.find((card) => !card.upgraded).uid
  run = chooseNeow(run, 'p1', 0)
  run = resolveNeowEffect(run, 'p1', true, { cardUids: [uid] })
  assertEqual(run.phase, 'map')
  assertEqual(run.neow, null)
  assertEqual(run.players[0].gold, 2)
  assert(run.players[0].relics.some((relic) => relic.defId === 'loaded_die'))
})

report("Neow's Blessing")
