import {
  buyFromMerchant,
  createMerchant,
  createRelicReward,
  courierCost,
  decideRelicReward,
  removeAtMerchant,
  resolveRelicReward,
  resolveCourierOffer,
} from '../src/game/noncombat.ts'
import { bottomCardChoices, createItemDecks, gainRelic, merchantRemovalCost, potionLimit, transformCard } from '../src/game/acquisition.ts'
import { createPlayer, createRun, decideCourier, enterRoom, revealCourier, resolveCombat, roomChoices } from '../src/game/run.ts'
import { activatePotion } from '../src/game/combat.ts'
import { createCampaignProgress } from '../src/game/campaign.ts'
import { createRng } from '../src/game/rng.ts'
import { suite, check, assert, assertEqual, assertDeepEqual, report } from './lib/harness.mjs'
import { postNeowRun } from './lib/post-neow-run.mjs'

const players = (count = 3, ascension = 0) => {
  const rng = createRng(91)
  const ids = ['ironclad', 'silent', 'defect', 'watcher']
  return ids.slice(0, count).map((character, row) => ({
    ...createPlayer(rng, `p${row + 1}`, character, character, row, ascension >= 5 ? ['ascenders_bane'] : []),
    gold: 12,
  }))
}

suite('non-combat acquisition')

check('Choose Your Relic is clamped off for solo runs', () => {
  assertEqual(createRun(1, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }], 0, createCampaignProgress(), true).chooseYourRelic, false)
})

check('shared physical decks are deterministic but seed-sensitive', () => {
  const decks = createItemDecks(createRng(1), true)
  assertDeepEqual(decks, createItemDecks(createRng(1), true))
  assert(JSON.stringify(createItemDecks(createRng(1), true)) !== JSON.stringify(createItemDecks(createRng(2), true)))
  assertEqual(decks.curses.length, 13)
  for (const id of ['clumsy', 'injury', 'parasite', 'regret']) assertEqual(decks.curses.filter((curse) => curse === id).length, 2)
})

check('mixed Downfall parties keep every inactive character reward stack available', () => {
  const decks = createItemDecks(createRng(808), true, createCampaignProgress(),
    ['ironclad', 'hexaghost'], 'downfall')
  assertDeepEqual(Object.keys(decks.characterCards).sort(),
    ['defect', 'guardian', 'hermit', 'silent', 'slime_boss', 'watcher'])
  assertDeepEqual(Object.keys(decks.characterRares).sort(),
    ['defect', 'guardian', 'hermit', 'silent', 'slime_boss', 'watcher'])
})

check('Merchant reveals exact physical inventory and redraws only unsellable Old Coin', () => {
  const party = players()
  const decks = createItemDecks(createRng(2), true)
  decks.relics = ['old_coin', 'anchor', 'happy_flower', 'akabeko']
  decks.potions = ['fairy_in_a_bottle', 'fire_potion', 'swift_potion', 'blood_potion']
  const shop = createMerchant(decks, party)
  assertDeepEqual(shop.relics, ['anchor', 'happy_flower', 'akabeko'])
  assertDeepEqual(shop.potions, ['fairy_in_a_bottle', 'fire_potion', 'swift_potion'])
  assertEqual(shop.colorless.length, 3)
  for (const player of party) assert(shop.cards[player.id].choices.length >= 3)
})

check('Merchant preserves duplicate base faces and replaces them only under Downfall rules', () => {
  const owner = players(1)[0]
  owner.cardRewards = ['anger', 'anger', 'claw', 'bash']
  const base = createMerchant(createItemDecks(createRng(202), true), [owner], undefined, 'base')
  assertDeepEqual(base.cards[owner.id].choices, ['anger', 'anger', 'claw'])
  assertDeepEqual(base.cards[owner.id].cardsDrawn, ['anger', 'anger', 'claw'])
  const downfall = createMerchant(createItemDecks(createRng(203), true), [owner], undefined, 'downfall')
  assertDeepEqual(downfall.cards[owner.id].choices, ['anger', 'claw', 'bash'])
  assertDeepEqual(downfall.cards[owner.id].cardsDrawn, ['anger', 'anger', 'claw', 'bash'])
})

check('one seat cannot forge another player contribution', () => {
  const party = players(2)
  const decks = createItemDecks(createRng(3), false)
  decks.relics = ['anchor', 'happy_flower', 'akabeko']
  const shop = createMerchant(decks, party)
  const refused = buyFromMerchant(shop, decks, party, 0, {
    buyerId: 'p1', section: 'relic', slot: 0, payments: { p2: 99 },
  })
  assertEqual(refused, null)
  const bought = buyFromMerchant(shop, decks, party, 0, {
    buyerId: 'p1', section: 'relic', slot: 0, payments: { p1: 2, p2: 3 },
  })
  assert(bought)
  assertEqual(bought.players[0].gold, 10)
  assertEqual(bought.players[1].gold, 9)
  assert(bought.players[0].relics.some((relic) => relic.defId === 'anchor'))
  assertEqual(buyFromMerchant(bought.shop, decks, bought.players, 0, {
    buyerId: 'p2', section: 'relic', slot: 0, payments: { p2: 5 },
  }), null, 'sold slot can be charged only once')
})

check('non-combat relic gains use canonical finite-use and pending instances', () => {
  const party = players(2)
  const decks = createItemDecks(createRng(303), false)
  const wingReward = {
    kind: 'treasure', offers: { p1: 'wing_boots', p2: 'war_paint' }, playerIds: ['p1', 'p2'],
    decisions: { p1: 'take', p2: 'take' },
  }
  const resolved = resolveRelicReward(wingReward, decks, party, false)
  assertEqual(resolved?.players[0].relics.at(-1)?.uses, 3)
  assertEqual(resolved?.players[1].relics.at(-1)?.pending, true)
})

check('Potion Belt draws two potions through the shared and Treasure acquisition boundaries', () => {
  const top = ['block_potion', 'energy_potion']
  for (const route of ['shared', 'treasure']) {
    const party = players(1)
    const decks = createItemDecks(createRng(306), false)
    decks.potions = [...top]
    let owner
    if (route === 'shared') owner = gainRelic(party[0], 'potion_belt', decks.potions, 0)
    else {
      owner = resolveRelicReward({
        kind: 'treasure', offers: { p1: 'potion_belt' }, playerIds: ['p1'], decisions: { p1: 'take' },
      }, decks, party, false)?.players[0]
    }
    assertDeepEqual(owner?.potions, top, `${route} omitted Potion Belt's on-acquire potions`)
    assertDeepEqual(decks.potions, [], `${route} did not consume the shared potion supply`)
  }
})

check('Merchant card gains apply and exhaust the matching Egg', () => {
  const party = players(1)
  party[0].relics.push({ defId: 'molten_egg', spent: false, uses: 1 })
  const decks = createItemDecks(createRng(305), false)
  const shop = createMerchant(decks, party)
  shop.cards.p1 = { choices: ['twin_strike'], cardsDrawn: ['twin_strike'], raresDrawn: [] }
  const bought = buyFromMerchant(shop, decks, party, 0, {
    buyerId: 'p1', section: 'card', slot: 0, payments: { p1: 2 },
  })
  const gained = bought?.players[0].deck.find((card) => card.defId === 'twin_strike')
  assertEqual(gained?.upgraded, true)
  assert(!bought?.players[0].relics.some((relic) => relic.defId === 'molten_egg'), 'spent Molten Egg was not discarded')
})

check('Ectoplasm and Sozu apply to non-combat item gains atomically', () => {
  const party = players(2)
  party[0].relics.push({ defId: 'ectoplasm', spent: false })
  party[1].relics.push({ defId: 'sozu', spent: false })
  const decks = createItemDecks(createRng(304), false)
  const coin = resolveRelicReward({
    kind: 'treasure', offers: { p1: 'old_coin' }, playerIds: ['p1'], decisions: { p1: 'take' },
  }, decks, party, false)
  assertEqual(coin?.players[0].gold, party[0].gold)

  const shop = createMerchant(decks, party)
  shop.potions[0] = 'fire_potion'
  const merchantGold = party[1].gold
  assertEqual(buyFromMerchant(shop, decks, party, 0, {
    buyerId: 'p2', section: 'potion', slot: 0, payments: { p2: 3 },
  }), null)
  assertEqual(party[1].gold, merchantGold)

  const courierGold = party[1].gold
  assertEqual(resolveCourierOffer({ playerId: 'p2', kind: 'potion', id: 'fire_potion' }, decks, party, 0, true, { p2: 3 }), null)
  assertEqual(party[1].gold, courierGold)
})

check('A4 potion limit and A8 removal price are exact thresholds', () => {
  assertEqual(potionLimit(3), 3)
  assertEqual(potionLimit(4), 2)
  assertEqual(merchantRemovalCost(7), 3)
  assertEqual(merchantRemovalCost(8), 4)
  const party = players(2, 8)
  const decks = createItemDecks(createRng(4), false)
  const shop = createMerchant(decks, party)
  const bane = party[0].deck.find((card) => card.defId === 'ascenders_bane')
  assert(bane)
  assertEqual(removeAtMerchant(shop, party, 8, 'p1', bane.uid, { p1: 4 }), null)
  const card = party[0].deck.find((candidate) => candidate.defId !== 'ascenders_bane')
  const removed = removeAtMerchant(shop, party, 8, 'p1', card.uid, { p1: 4 })
  assert(removed)
  assertEqual(removeAtMerchant(removed.shop, removed.players, 8, 'p1', removed.players[0].deck[0].uid, { p1: 4 }), null)
})

check('removing Parasite applies its printed maximum-HP loss at the Merchant', () => {
  const party = players(1)
  party[0].deck[0] = { ...party[0].deck[0], defId: 'parasite' }
  party[0].hp = 9
  party[0].maxHp = 9
  const shop = createMerchant(createItemDecks(createRng(404), false), party)
  const removed = removeAtMerchant(shop, party, 0, 'p1', party[0].deck[0].uid, { p1: 3 })
  assertEqual(removed?.players[0].maxHp, 7)
  assertEqual(removed?.players[0].hp, 7)
})

check('replacing one duplicate Potion bottoms exactly that copy', () => {
  const party = players(1)
  party[0].potions = ['fire_potion', 'fire_potion', 'swift_potion']
  const decks = createItemDecks(createRng(44), false)
  decks.potions = ['blood_potion', 'weak_potion', 'block_potion']
  const shop = createMerchant(decks, party)
  const bought = buyFromMerchant(shop, decks, party, 0, {
    buyerId: 'p1', section: 'potion', slot: 0, payments: { p1: 3 }, discardPotionId: 'fire_potion',
  })
  assert(bought)
  assertDeepEqual(bought.players[0].potions, ['fire_potion', 'swift_potion', 'blood_potion'])
  assertEqual(decks.potions.at(-1), 'fire_potion')
})

check('Sapphire requires every living player to skip the same relic reward', () => {
  const party = players(4)
  const decks = createItemDecks(createRng(5), false)
  let reward = createRelicReward('treasure', decks, party)
  for (const player of party) reward = decideRelicReward(reward, player.id, 'sapphire')
  const result = resolveRelicReward(reward, decks, party, false)
  assert(result?.sapphire)

  const decks2 = createItemDecks(createRng(5), false)
  let mixed = createRelicReward('elite', decks2, party)
  for (const player of party) mixed = decideRelicReward(mixed, player.id, player.id === 'p4' ? 'take' : 'sapphire')
  const denied = resolveRelicReward(mixed, decks2, party, false)
  assert(denied && !denied.sapphire)
})

check('Choose Your Relic assigns each shared offer exactly once, including slot zero', () => {
  const party = players(4)
  const decks = createItemDecks(createRng(6), false)
  let reward = createRelicReward('treasure', decks, party, true)
  const offered = [...reward.sharedOffers]
  for (const [index, player] of party.entries()) reward = decideRelicReward(reward, player.id, index)
  const result = resolveRelicReward(reward, decks, party, false)
  assert(result)
  assertDeepEqual(result.players.map((player) => player.relics.at(-1)?.defId), offered)
})

check('a Golden Ticket resolves through the rare deck during transformation', () => {
  const player = players(1)[0]
  const old = player.deck[0]
  player.cardRewards = ['golden_ticket', ...player.cardRewards]
  player.rareRewards = ['feed', ...player.rareRewards]
  const transformed = transformCard(createRng(7), player, old.uid, 'c999')
  assertEqual(transformed.deck.find((card) => card.uid === 'c999')?.defId, 'feed')
  assert(!transformed.deck.some((card) => card.defId === 'golden_ticket'))
  assertEqual(transformed.cardRewards.at(-1), 'golden_ticket')
})

check('taking one duplicate reward bottoms the other physical copy', () => {
  const player = players(1)[0]
  player.cardRewards = ['ball_lightning', 'ball_lightning', 'cold_snap', ...player.cardRewards]
  const draw = { choices: ['ball_lightning', 'ball_lightning', 'cold_snap'], cardsDrawn: ['ball_lightning', 'ball_lightning', 'cold_snap'], raresDrawn: [] }
  const bottomed = bottomCardChoices(player, draw, 0)
  assertDeepEqual(bottomed.cardRewards.slice(-2), ['ball_lightning', 'cold_snap'])
})

check('transform sets the old card aside and refuses every Curse', () => {
  const player = players(1)[0]
  const old = player.deck[0]
  const transformed = transformCard(createRng(8), player, old.uid, 'c998')
  assert(!transformed.cardRewards.includes(old.defId))
  assertDeepEqual(transformed.cardRewards, player.cardRewards.slice(1))
  const cursed = { ...player, deck: [{ uid: 'curse', defId: 'injury', upgraded: false }, ...player.deck] }
  assertEqual(transformCard(createRng(8), cursed, 'curse', 'c997'), cursed)
})

check('empty relic rewards can be skipped but cannot create a Sapphire Key', () => {
  const party = players(2)
  const decks = createItemDecks(createRng(17), true)
  decks.relics = []
  let reward = createRelicReward('treasure', decks, party)
  assertEqual(decideRelicReward(reward, 'p1', 'sapphire'), null)
  reward = decideRelicReward(reward, 'p1', 'skip')
  reward = decideRelicReward(reward, 'p2', 'skip')
  const result = resolveRelicReward(reward, decks, party, false)
  assert(result)
  assertEqual(result.sapphire, false)
})

check('The Courier buys or discards one top-deck item at printed cost', () => {
  const party = players(2)
  const decks = createItemDecks(createRng(23), true)
  const relic = { playerId: 'p1', kind: 'relic', id: 'anchor' }
  assertEqual(courierCost(relic), 6)
  const bought = resolveCourierOffer(relic, decks, party, 0, true, { p1: 2, p2: 4 })
  assert(bought?.[0].relics.some((entry) => entry.defId === 'anchor'))
  assertEqual(bought?.[0].gold, 10)
  assertEqual(bought?.[1].gold, 8)
  const potion = { playerId: 'p1', kind: 'potion', id: 'fire_potion' }
  const before = decks.potions.length
  assert(resolveCourierOffer(potion, decks, party, 0, false, {}))
  assertEqual(decks.potions.length, before + 1)
  assertEqual(decks.potions.at(-1), 'fire_potion')
})

check('The Courier run hook is once per combat and keeps its reveal stable', () => {
  let run = postNeowRun(41, [{ id: 'p1', name: 'Ann', character: 'ironclad' }])
  run.players[0].relics.push({ defId: 'the_courier', spent: false })
  run.players[0].gold = 6
  run.itemDecks.relics = ['old_coin', 'anchor', ...run.itemDecks.relics.filter((id) => id !== 'old_coin' && id !== 'anchor')]
  run = enterRoom(run, roomChoices(run)[0].id)
  run = revealCourier(run, 'p1', 'relic')
  assertEqual(run.courier.offer?.id, 'anchor')
  const revealed = run
  const prematurelyWon = { ...run, combat: { ...run.combat, phase: 'won' } }
  assertEqual(resolveCombat(prematurelyWon), prematurelyWon)
  assertEqual(revealCourier({ ...revealed, courier: { usedBy: [], offer: null }, combat: { ...revealed.combat, phase: 'won' } }, 'p1', 'potion').courier.offer, null)
  assertEqual(decideCourier(prematurelyWon, 'p1', 'discard'), prematurelyWon)
  assertEqual(revealCourier(run, 'p1', 'potion'), run)
  run = decideCourier(run, 'p1', 'buy', { p1: 6 })
  assert(run.combat?.players[0].relics.some((relic) => relic.defId === 'anchor'))
  assertEqual(revealCourier(run, 'p1', 'potion'), run)
  assertEqual(revealed.itemDecks.relics.at(-1), 'old_coin')
})

check('The Courier bottoms combat-used Potions before its same-combat draw', () => {
  let run = postNeowRun(42, [{ id: 'p1', name: 'Ann', character: 'ironclad' }])
  run.players[0].relics.push({ defId: 'the_courier', spent: false })
  run.players[0].potions = ['block_potion']
  run.itemDecks.potions = []
  run.potionDeck = []
  run = enterRoom(run, roomChoices(run)[0].id)
  run = { ...run, combat: { ...run.combat, phase: 'player' } }
  run = { ...run, combat: activatePotion(run.combat, 'p1', 'block_potion') }
  assertEqual(run.combat.potionDeck.at(-1), 'block_potion')
  run = revealCourier(run, 'p1', 'potion')
  assertEqual(run.courier.offer?.id, 'block_potion')
  assertDeepEqual(run.combat.potionDeck, [])
})

report('non-combat acquisition')
