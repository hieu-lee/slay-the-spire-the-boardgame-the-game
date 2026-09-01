import { EVENT_DEFINITIONS, eventCanStartCombat } from '../src/game/events.ts'
import { CARDS } from '../src/game/cards.ts'
import { createEventRoom, resolveEventDecision } from '../src/game/event-room.ts'
import { createItemDecks } from '../src/game/acquisition.ts'
import { createCampaignProgress } from '../src/game/campaign.ts'
import { canSkipEvent, chooseEvent, chooseRelicReward, createPlayer, createRun, enterRoom, finishMerchant, finishRun, resolveCardRewards, resolveCombat, resolvePotionReward, roomChoices, skipEvent, switchBetweenCombatRow } from '../src/game/run.ts'
import { createRng } from '../src/game/rng.ts'
import { suite, check, assert, assertEqual, assertDeepEqual, report } from './lib/harness.mjs'
import { postNeowRun } from './lib/post-neow-run.mjs'

suite('physical Event resolution')

const card = (id) => ({ ...EVENT_DEFINITIONS[id], instanceId: `test-${id}`, act: 1, minAscension: 0, requiresColorlessUnlock: false })

function setup(id, count = 2, ascension = 0) {
  const rng = createRng(4242)
  const progress = createCampaignProgress()
  const characters = ['ironclad', 'silent', 'defect', 'watcher']
  const players = characters.slice(0, count).map((character, row) => ({
    ...createPlayer(rng, `p${row + 1}`, character, character, row, [], progress),
    gold: 12,
    hp: 5,
  }))
  return { rng, players, decks: createItemDecks(rng, true), event: createEventRoom(card(id)), ascension }
}

check('Ancient Temple charges one extra HP per prior visitor', () => {
  const state = setup('ancient_temple', 3)
  const first = resolveEventDecision(state.event, state.rng, state.decks, state.players, 0, 'p1', { optionIds: ['go_inside'] })
  assert(first)
  const second = resolveEventDecision(first.event, state.rng, state.decks, first.players, 0, 'p2', { optionIds: ['go_inside'] })
  assertEqual(first.players[0].hp, 4)
  assertEqual(second?.players[1].hp, 3)
})

check('Bonfire applies only the removed card rarity rider', () => {
  const state = setup('bonfire_spirits', 1)
  const player = state.players[0]
  const rareUid = player.deck[0].uid
  player.deck[0] = { ...player.deck[0], defId: 'feed' }
  const result = resolveEventDecision(state.event, state.rng, state.decks, state.players, 0, 'p1', { optionIds: ['offer'], cardUids: [rareUid] })
  assertEqual(result?.players[0].hp, result?.players[0].maxHp)
})

check('Purifier removes Hermit Curses by printed type while preserving Ascender\'s Bane', () => {
  const state = setup('purifier', 1)
  state.players[0].deck.push(
    { uid: 'hermit-curse', defId: 'hermit_scorn', upgraded: false },
    { uid: 'base-curse', defId: 'regret', upgraded: false },
    { uid: 'bane', defId: 'ascenders_bane', upgraded: false },
  )
  const result = resolveEventDecision(state.event, state.rng, state.decks, state.players, 0, 'p1', {
    optionIds: ['cleanse'],
  })
  assertDeepEqual(result?.players[0].deck.filter(({ uid }) => ['hermit-curse', 'base-curse', 'bane'].includes(uid))
    .map(({ uid }) => uid), ['bane'])
})

check('Events honor Mark of Pain, Ectoplasm, Sozu, and canonical Relic state', () => {
  const library = setup('the_library', 1)
  library.players[0].hp = 4
  library.players[0].maxHp = 9
  library.players[0].relics.push({ defId: 'mark_of_pain', spent: false })
  const healed = resolveEventDecision(library.event, library.rng, library.decks, library.players, 0, 'p1', { optionIds: ['sleep'] })
  assertEqual(healed?.players[0].hp, 6)

  const reduced = setup('the_library', 1)
  reduced.players[0].hp = 4
  reduced.players[0].maxHp = 5
  reduced.players[0].relics.push({ defId: 'mark_of_pain', spent: false })
  const reducedHeal = resolveEventDecision(reduced.event, reduced.rng, reduced.decks, reduced.players, 0, 'p1', { optionIds: ['sleep'] })
  assertEqual(reducedHeal?.players[0].hp, 5, 'Mark of Pain healed above reduced maximum HP')

  const shrine = setup('golden_shrine', 1)
  shrine.players[0].relics.push({ defId: 'ectoplasm', spent: false })
  const gold = resolveEventDecision(shrine.event, shrine.rng, shrine.decks, shrine.players, 0, 'p1', { optionIds: ['pray'] })
  assertEqual(gold?.players[0].gold, shrine.players[0].gold)

  const potions = setup('woman_in_blue', 1)
  potions.players[0].relics.push({ defId: 'sozu', spent: false })
  const potionCount = potions.decks.potions.length
  const blockedPotion = resolveEventDecision(potions.event, potions.rng, potions.decks, potions.players, 0, 'p1', { optionIds: ['buy_one'] })
  assertDeepEqual(blockedPotion?.players[0].potions, [])
  assertEqual(potions.decks.potions.length, potionCount)

  const temple = setup('ancient_temple', 1)
  temple.decks.relics = ['wing_boots']
  const relic = resolveEventDecision(temple.event, temple.rng, temple.decks, temple.players, 0, 'p1', { optionIds: ['go_inside'] })
  assertEqual(relic?.players[0].relics.at(-1)?.uses, 3)
})

check('starter filters reject forged card identities and accept printed starters', () => {
  const state = setup('big_fish', 1)
  const nonStrike = state.players[0].deck.find((entry) => EVENT_DEFINITIONS && entry.defId.includes('defend'))
  assertEqual(resolveEventDecision(state.event, state.rng, state.decks, state.players, 0, 'p1', { optionIds: ['restraint'], cardUids: [nonStrike.uid] }), null)
  const strike = state.players[0].deck.find((entry) => entry.defId.includes('strike'))
  assert(resolveEventDecision(state.event, state.rng, state.decks, state.players, 0, 'p1', { optionIds: ['restraint'], cardUids: [strike.uid] }))
})

check('two Event rewards mint distinct stable card ids', () => {
  const state = setup('winding_halls', 1)
  const beforeState = JSON.stringify(state.players)
  const rewardDeck = [...state.players[0].cardRewards]
  const before = new Set(state.players[0].deck.map((entry) => entry.uid))
  const result = resolveEventDecision(state.event, state.rng, state.decks, state.players, 0, 'p1', { optionIds: ['embrace_madness'] })
  const added = result.players[0].deck.filter((entry) => !before.has(entry.uid))
  assertEqual(added.length, 2)
  assertEqual(new Set(added.map((entry) => entry.uid)).size, 2)
  assertEqual(JSON.stringify(state.players), beforeState, 'resolving rewards mutated the prior players')
  assertDeepEqual([...result.players[0].cardRewards, ...added.map((entry) => entry.defId)].sort(), rewardDeck.sort())
})

check('random rare rewards preserve the prior run and conserve the reward deck', () => {
  const state = setup('cursed_tome', 1)
  const beforePlayers = JSON.stringify(state.players)
  const rewards = [...state.players[0].rareRewards]
  const beforeUids = new Set(state.players[0].deck.map((card) => card.uid))
  const resolved = resolveEventDecision(state.event, state.rng, state.decks, state.players, 0, 'p1', { optionIds: ['read'] })
  const gained = resolved.players[0].deck.find((card) => !beforeUids.has(card.uid))
  assertEqual(JSON.stringify(state.players), beforePlayers)
  assert(gained)
  assertDeepEqual([...resolved.players[0].rareRewards, gained.defId].sort(), rewards.sort())
})

check('Ascension 4 potion capacity cannot be bypassed by Events', () => {
  const state = setup('woman_in_blue', 1, 4)
  state.players[0].potions = ['fire_potion', 'swift_potion']
  const skipped = resolveEventDecision(state.event, state.rng, state.decks, state.players, 4, 'p1', { optionIds: ['buy_one'] })
  assertEqual(skipped?.players[0].potions.length, 2)
  const replaced = resolveEventDecision(state.event, state.rng, state.decks, state.players, 4, 'p1', { optionIds: ['buy_one'], potionReplacementIds: ['fire_potion'] })
  assertEqual(replaced?.players[0].potions.length, 2)
  assert(!replaced.players[0].potions.includes('fire_potion'))

  const passed = setup('woman_in_blue', 2, 4)
  passed.players[0].potions = ['fire_potion', 'swift_potion']
  const shared = resolveEventDecision(passed.event, passed.rng, passed.decks, passed.players, 4, 'p1', { optionIds: ['buy_one'], potionRecipientId: 'p2' })
  assertEqual(shared?.players[0].potions.length, 2)
  assertEqual(shared?.players[1].potions.length, 1)
  const open = setup('woman_in_blue', 2)
  const openPass = resolveEventDecision(open.event, open.rng, open.decks, open.players, 0, 'p1', { optionIds: ['buy_one'], potionRecipientId: 'p2' })
  assertEqual(openPass?.players[0].potions.length, 0)
  assertEqual(openPass?.players[1].potions.length, 1)
})

check('Potion Belt capacity applies to Event potion gains', () => {
  const state = setup('woman_in_blue', 1, 4)
  state.players[0].potions = ['fire_potion', 'swift_potion']
  state.players[0].relics.push({ defId: 'potion_belt', spent: false })
  const gained = resolveEventDecision(state.event, state.rng, state.decks, state.players, 4, 'p1', {
    optionIds: ['buy_one'],
  })
  assertEqual(gained?.players[0].potions.length, 3)
})

check('an Event-acquired Potion Belt immediately draws two shared potions', () => {
  const state = setup('ancient_temple', 1)
  state.decks.relics = ['potion_belt']
  state.decks.potions = ['block_potion', 'energy_potion']
  const gained = resolveEventDecision(state.event, state.rng, state.decks, state.players, 0, 'p1', {
    optionIds: ['go_inside'],
  })
  assertDeepEqual(gained?.players[0].potions, ['block_potion', 'energy_potion'])
  assertDeepEqual(state.decks.potions, [])
})

check('Event Gold costs accept exact contributions from the party', () => {
  const state = setup('old_beggar', 2)
  state.players[0].gold = 0
  state.players[1].gold = 2
  const uid = state.players[0].deck[0].uid
  const result = resolveEventDecision(state.event, state.rng, state.decks, state.players, 0, 'p1', {
    optionIds: ['give'], cardUids: [uid], payments: { p1: 0, p2: 2 },
  })
  assert(result)
  assert(!result.players[0].deck.some((card) => card.uid === uid))
  assertEqual(result.players[0].gold, 0)
  assertEqual(result.players[1].gold, 0)
})

check('two overflow Potions may pass to two different teammates', () => {
  const state = setup('woman_in_blue', 3, 4)
  state.players[0].potions = ['fire_potion', 'swift_potion']
  const result = resolveEventDecision(state.event, state.rng, state.decks, state.players, 4, 'p1', {
    optionIds: ['buy_two'], payments: { p1: 2 }, potionRecipientIds: ['p2', 'p3'],
  })
  assert(result)
  assertEqual(result.players[1].potions.length, 1)
  assertEqual(result.players[2].potions.length, 1)
})

check('server-authored die results are replayed without advancing RNG', () => {
  const state = setup('wheel_of_change', 1)
  const before = { ...state.rng }
  const result = resolveEventDecision(state.event, state.rng, state.decks, state.players, 0, 'p1', { optionIds: ['spin'], cardUids: [state.players[0].deck[0].uid] }, [5])
  assertEqual(result?.event.dieRolls.p1.at(-1), 5)
  assertDeepEqual(state.rng, before)
  assertEqual(result?.players[0].gold, 16)
})

check('Knowing Skull rejects duplicate options and trades reject self-targets', () => {
  const skull = setup('knowing_skull', 1)
  assertEqual(resolveEventDecision(skull.event, skull.rng, skull.decks, skull.players, 0, 'p1', { optionIds: ['riches', 'riches'] }), null)
  const note = setup('note_for_yourself', 2)
  const uid = note.players[0].deck[0].uid
  assertEqual(resolveEventDecision(note.event, note.rng, note.decks, note.players, 0, 'p1', { optionIds: ['exchange'], cardUids: [uid], targetPlayerId: 'p1', receiveCardUid: uid }), null)
})

const inEvent = (id, count = 2) => {
  const state = setup(id, count)
  return {
    ...postNeowRun(4242, state.players.map((player) => ({ id: player.id, name: player.name, character: player.character }))),
    phase: 'room',
    players: state.players,
    itemDecks: state.decks,
    roomState: state.event,
  }
}

check('Event rewards and transforms use the finite Egg acquisition boundary', () => {
  let library = inEvent('the_library', 1)
  library.players[0].relics.push({ defId: 'toxic_egg', spent: false, uses: 2 })
  library.players[0].cardRewards = ['shrug_it_off', 'armaments', 'battle_trance', 'bloodletting', 'burning_pact']
  library = chooseEvent(library, 'p1', { optionIds: ['read'] })
  library = chooseEvent(library, 'p1', { optionIds: ['read'], rewardIndexes: [0] })
  assertEqual(library.players[0].deck.find((card) => card.defId === 'shrug_it_off')?.upgraded, true)
  assertEqual(library.players[0].relics.find((relic) => relic.defId === 'toxic_egg')?.uses, 1)

  let transform = inEvent('transmogriphier', 1)
  const old = transform.players[0].deck.find((card) => CARDS[card.defId]?.type === 'attack')
  transform.players[0].cardRewards = ['twin_strike']
  transform.players[0].relics.push({ defId: 'molten_egg', spent: false, uses: 1 })
  transform = chooseEvent(transform, 'p1', { optionIds: ['pray'], cardUids: [old.uid] })
  assertEqual(transform.players[0].deck.find((card) => card.defId === 'twin_strike')?.upgraded, true)
  assert(!transform.players[0].relics.some((relic) => relic.defId === 'molten_egg'), 'spent Event Egg was not discarded')
})

check('malformed multi-option input cannot stage an unrecoverable Event reward', () => {
  const run = inEvent('cursed_tome', 1)
  assertEqual(chooseEvent(run, 'p1', { optionIds: ['take', 'skim'] }), run)
  assertEqual(run.roomState.pendingDecisions, undefined)
})

check('two staged Potions preserve an empty first recipient before a later pass', () => {
  let run = inEvent('woman_in_blue', 2)
  run.ascension = 4
  run.players[0].gold = 2
  run.players[0].potions = ['fire_potion']
  run = chooseEvent(run, 'p1', { optionIds: ['buy_two'] })
  assertEqual(run.roomState.itemOffers.p1.length, 2)
  run = chooseEvent(run, 'p1', { optionIds: ['buy_two'], rewardItemChoices: ['take', 'take'], potionRecipientIds: ['', 'p2'] })
  assertEqual(run.players[0].potions.length, 2)
  assertEqual(run.players[1].potions.length, 1)
  run = chooseEvent(run, 'p2', { optionIds: ['leave'] })
  assertEqual(run.phase, 'map')
})

check('staged party and Big Fish choices cannot be duplicated by another seat', () => {
  let tomb = inEvent('tomb_red_mask', 2)
  tomb = chooseEvent(tomb, 'p1', { optionIds: ['offer_gold'] })
  assertEqual(tomb.roomState.itemOffers.p1.length, 2)
  assertEqual(chooseEvent(tomb, 'p2', { optionIds: ['offer_gold'] }), tomb)

  let fish = inEvent('big_fish', 2)
  fish = chooseEvent(fish, 'p1', { optionIds: ['box'] })
  assertEqual(chooseEvent(fish, 'p2', { optionIds: ['box'] }), fish)
  const different = chooseEvent(fish, 'p2', { optionIds: ['banana'] })
  assert(different !== fish, 'a different printed Big Fish choice remains legal')

  let four = inEvent('big_fish', 4)
  four = chooseEvent(four, 'p1', { optionIds: ['box'] })
  four = chooseEvent(four, 'p1', { optionIds: ['box'], rewardItemChoices: ['skip'] })
  assertEqual(chooseEvent(four, 'p2', { optionIds: ['box'] }), four, 'a resolved choice cannot be staged again')
  four = chooseEvent(four, 'p2', { optionIds: ['banana'] })
  const starterStrike = four.players[2].deck.find((entry) => CARDS[entry.defId]?.rarity === 'starter' && CARDS[entry.defId]?.name === 'Strike')
  four = chooseEvent(four, 'p3', { optionIds: ['restraint'], cardUids: [starterStrike.uid] })
  four.players[3].deck = four.players[3].deck.filter((entry) => !(CARDS[entry.defId]?.rarity === 'starter' && CARDS[entry.defId]?.name === 'Strike'))
  assertEqual(canSkipEvent(four, 'p4'), false)
  four = chooseEvent(four, 'p4', { optionIds: ['donut'] })
  assertEqual(four.phase, 'map')
})

check('shared Event reward previews serialize before consuming the next offer', () => {
  let run = inEvent('sensory_stone', 2)
  run.itemDecks.colorless = ['apotheosis', 'bandage_up', 'blind', 'dark_shackles', 'deep_breath', 'discovery']
  run = chooseEvent(run, 'p1', { optionIds: ['recall_one'] })
  const first = run.roomState.rewardOffers.p1[0]
  assertEqual(chooseEvent(run, 'p2', { optionIds: ['recall_one'] }), run)
  run = chooseEvent(run, 'p1', { optionIds: ['recall_one'], rewardIndexes: [-1] })
  run = chooseEvent(run, 'p2', { optionIds: ['recall_one'] })
  assert(JSON.stringify(run.roomState.rewardOffers.p2[0]) !== JSON.stringify(first), 'the second seat saw a stale shared preview')
})

check('exhausted Event card-reward supplies resolve as physical no-ops', () => {
  let colorless = inEvent('sensory_stone', 1)
  colorless.itemDecks.colorless = []
  colorless = chooseEvent(colorless, 'p1', { optionIds: ['recall_one'] })
  assertEqual(colorless.phase, 'map')

  let rare = inEvent('cursed_tome', 1)
  rare.players[0].rareRewards = []
  const hp = rare.players[0].hp
  rare = chooseEvent(rare, 'p1', { optionIds: ['read'] })
  assertEqual(rare.phase, 'map')
  assertEqual(rare.players[0].hp, hp - 2)

  let ordinary = inEvent('winding_halls', 1)
  ordinary.players[0].cardRewards = []
  ordinary.players[0].rareRewards = []
  ordinary = chooseEvent(ordinary, 'p1', { optionIds: ['embrace_madness'] })
  assertEqual(ordinary.phase, 'map')

  let partial = inEvent('sensory_stone', 1)
  partial.itemDecks.colorless = ['apotheosis']
  partial = chooseEvent(partial, 'p1', { optionIds: ['recall_two'] })
  assertEqual(partial.roomState.rewardOffers.p1.length, 1)
  partial = chooseEvent(partial, 'p1', { optionIds: ['recall_two'], rewardIndexes: [-1] })
  assertDeepEqual(partial.roomState.rewardOffers.p1[0], ['apotheosis'])
  partial = chooseEvent(partial, 'p1', { optionIds: ['recall_two'], rewardIndexes: [0] })
  assertEqual(partial.phase, 'map')
  assert(partial.players[0].deck.some((card) => card.defId === 'apotheosis'))
})

check('partial Event item supplies still reveal the available reward', () => {
  let run = inEvent('tomb_red_mask', 2)
  run.players[0].gold = 3
  run.players[1].gold = 4
  run.itemDecks.relics = ['happy_flower']
  run = chooseEvent(run, 'p1', { optionIds: ['offer_gold'] })
  assertDeepEqual(run.roomState.itemOffers.p1, [{ kind: 'relic', id: 'happy_flower' }])
  assertDeepEqual(run.players.map((player) => player.gold), [3, 4])
  run = chooseEvent(run, 'p1', { optionIds: ['offer_gold'], rewardItemChoices: ['skip'] })
  assertDeepEqual(run.roomState.itemOffers.p1, [{ kind: 'relic', id: 'happy_flower' }])
  assertDeepEqual(run.players.map((player) => player.gold), [3, 4])
  run = chooseEvent(run, 'p1', { optionIds: ['offer_gold'], rewardItemChoices: ['take'] })
  assertEqual(run.phase, 'map')
  assertEqual(run.players[0].relics.some((relic) => relic.defId === 'happy_flower'), false)
  assert(run.players[1].relics.some((relic) => relic.defId === 'happy_flower'))
  assertDeepEqual(run.players.map((player) => player.gold), [0, 0])

  let potion = inEvent('woman_in_blue', 1)
  potion.players[0].gold = 2
  potion.itemDecks.potions = ['fire_potion']
  potion = chooseEvent(potion, 'p1', { optionIds: ['buy_two'] })
  potion = chooseEvent(potion, 'p1', { optionIds: ['buy_two'], rewardItemChoices: ['skip'] })
  assertEqual(potion.roomState.itemOffers.p1[0].id, 'fire_potion')
  assertEqual(potion.players[0].gold, 2)
  potion = chooseEvent(potion, 'p1', { optionIds: ['buy_two'], rewardItemChoices: ['take'] })
  assertEqual(potion.phase, 'map')
  assertDeepEqual(potion.players[0].potions, ['fire_potion'])
  assertEqual(potion.players[0].gold, 0)

  let skipped = inEvent('woman_in_blue', 1)
  skipped.players[0].gold = 2
  skipped.itemDecks.potions = ['fire_potion']
  skipped = chooseEvent(skipped, 'p1', { optionIds: ['buy_two'] })
  skipped = chooseEvent(skipped, 'p1', { optionIds: ['buy_two'], rewardItemChoices: ['skip'] })
  skipped = chooseEvent(skipped, 'p1', { optionIds: ['buy_two'], rewardItemChoices: ['skip'] })
  assertEqual(skipped.phase, 'map')
  assertDeepEqual(skipped.itemDecks.potions, ['fire_potion'])
})

check('Event Potion choices preserve one shared physical supply across later room boundaries', () => {
  let taken = inEvent('woman_in_blue', 1)
  taken.players[0].gold = 1
  taken.itemDecks.potions = ['fire_potion']
  taken.potionDeck = ['fire_potion']
  taken = chooseEvent(taken, 'p1', { optionIds: ['buy_one'] })
  assertDeepEqual(taken.potionDeck, taken.itemDecks.potions)
  taken = chooseEvent(taken, 'p1', { optionIds: ['buy_one'], rewardItemChoices: ['take'] })
  assertDeepEqual(taken.players[0].potions, ['fire_potion'])
  assertDeepEqual(taken.potionDeck, [])
  assertDeepEqual(taken.itemDecks.potions, [])

  let skipped = inEvent('woman_in_blue', 1)
  skipped.players[0].gold = 1
  skipped.itemDecks.potions = ['fire_potion']
  skipped.potionDeck = ['fire_potion']
  skipped = chooseEvent(skipped, 'p1', { optionIds: ['buy_one'] })
  skipped = chooseEvent(skipped, 'p1', { optionIds: ['buy_one'], rewardItemChoices: ['skip'] })
  assertDeepEqual(skipped.potionDeck, ['fire_potion'])
  assertDeepEqual(skipped.itemDecks.potions, ['fire_potion'])
})

check('Face Trader Old Coin and exhausted Golden Tickets cannot strand Events', () => {
  let trader = inEvent('face_trader', 1)
  trader.players[0].relics = []
  trader.itemDecks.relics = ['old_coin']
  trader = chooseEvent(trader, 'p1', { optionIds: ['take_and_give'] })
  assertEqual(trader.players[0].gold, 22)
  trader = chooseEvent(trader, 'p1', { optionIds: ['take_and_give'] })
  assertEqual(trader.phase, 'map')

  let transform = inEvent('transmogriphier', 1)
  transform.players[0].cardRewards = ['golden_ticket']
  transform.players[0].rareRewards = []
  const uid = transform.players[0].deck.find((card) => CARDS[card.defId]?.owner !== 'curse').uid
  transform = chooseEvent(transform, 'p1', { optionIds: ['pray'], cardUids: [uid] })
  assertEqual(transform.phase, 'map')
  assertDeepEqual(transform.players[0].cardRewards, ['golden_ticket'])
})

check('Face Trader can give away the final staged Relic', () => {
  let run = inEvent('face_trader', 1)
  run.players[0].relics = []
  run.itemDecks.relics = ['anchor']
  run = chooseEvent(run, 'p1', { optionIds: ['take_and_give'] })
  assert(run.players[0].relics.some((relic) => relic.defId === 'anchor'))
  run = chooseEvent(run, 'p1', { optionIds: ['take_and_give'], relicIds: ['anchor'] })
  assertEqual(run.phase, 'map')
  assertEqual(run.players[0].relics.some((relic) => relic.defId === 'anchor'), false)
})

check('Forgotten Altar removes its revealed Relic, not another random Relic', () => {
  let run = inEvent('forgotten_altar', 1)
  run.players[0].relics = [{ defId: 'anchor', spent: false }, { defId: 'akabeko', spent: false }]
  run.roomState.revealedRelics = { p1: 'anchor' }
  run.itemDecks.relics = ['happy_flower', ...run.itemDecks.relics.filter((id) => id !== 'happy_flower')]
  run = chooseEvent(run, 'p1', { optionIds: ['offer'] })
  run = chooseEvent(run, 'p1', { optionIds: ['offer'], rewardItemChoices: ['take'] })
  assert(!run.players[0].relics.some((relic) => relic.defId === 'anchor'))
  assert(run.players[0].relics.some((relic) => relic.defId === 'akabeko'))
  assert(run.players[0].relics.some((relic) => relic.defId === 'happy_flower'))
  assert(run.itemDecks.relics.includes('anchor'), 'the offered ordinary Relic was not returned to its deck')
})

check('Mind Bloom War reserves no reward before combat and records a seeded Act I Boss hook', () => {
  let run = inEvent('mind_bloom', 1)
  run.map.position = run.map.rows[0][0]
  const relicCount = run.itemDecks.relics.length
  run = chooseEvent(run, 'p1', { optionIds: ['war'] })
  assertEqual(run.phase, 'combat')
  assertEqual(run.itemDecks.relics.length, relicCount)
  assert(['guardian_attack', 'hexaghost', 'slime_boss'].includes(run.eventCombat.bossDefId))
})

check('an Event elite rebuilds an empty Act III Elite deck', () => {
  let run = inEvent('colosseum', 1)
  run = { ...run, act: 3, enemyDecks: { act: 3, first: [], encounter: [], elite: [] } }
  run.map.position = run.map.rows[0][0]
  run = chooseEvent(run, 'p1', { optionIds: ['main_event'] })
  assert(['reptomancer', 'nemesis', 'giant_head'].includes(
    run.combat.enemies.find((enemy) => enemy.uid === 'elite').defId,
  ))
  assertEqual(run.enemyDecks.elite.length, 3)
})

check('players can switch rows after a combat Event is revealed', () => {
  const run = inEvent('mind_bloom', 2)
  const switched = switchBetweenCombatRow(run, 'p1', 1)
  assertEqual(switched.players.find((player) => player.id === 'p1').row, 1)
  assertEqual(switched.players.find((player) => player.id === 'p2').row, 0)
  assertEqual(switched.roomState.card.id, 'mind_bloom')
})

check('Secret Portal keeps row switching visible before a combat destination', () => {
  assert(eventCanStartCombat(EVENT_DEFINITIONS.secret_portal))
})

check('Mind Bloom War counts as a bonus Boss and awards its campaign mark', () => {
  let run = inEvent('mind_bloom', 1)
  run.act = 3
  const gold = run.players[0].gold
  run.map.position = run.map.rows[0][0]
  run.campaign = { ...run.campaign, bossesDefeated: 2, highestBossActDefeated: 2 }
  run = chooseEvent(run, 'p1', { optionIds: ['war'] })
  run = resolveCombat({ ...run, combat: { ...run.combat, phase: 'won', enemies: run.combat.enemies.map((enemy) => ({ ...enemy, hp: 0, dead: true })) } })
  assertEqual(run.players[0].gold, gold)
  assertEqual(run.campaign.bossesDefeated, 3)
  assertEqual(run.campaign.highestBossActDefeated, 2)
  const finished = finishRun({ ...run, phase: 'defeat' })
  assertEqual(finished.campaignProgress.characters.ironclad, 4)
})

check('The Last Stand ends the Act after Mind Bloom rewards instead of returning to the map', () => {
  let run = inEvent('mind_bloom', 2)
  run = {
    ...run,
    act: 3,
    lastStand: true,
    campaign: { ...run.campaign, bossesDefeated: 2, highestBossActDefeated: 2 },
  }
  run.map.position = run.map.rows[0][0]
  run = chooseEvent(run, 'p1', { optionIds: ['war'] })
  run = resolveCombat({
    ...run,
    combat: {
      ...run.combat,
      phase: 'won',
      players: run.combat.players.map((player, index) => index === 0
        ? { ...player, hp: 0, dead: true }
        : player),
      enemies: run.combat.enemies.map((enemy) => ({ ...enemy, hp: 0, dead: true })),
    },
  })
  assertEqual(run.campaign.bossesDefeated, 3)
  assertEqual(run.campaign.highestBossActDefeated, 3)
  assertEqual(run.rewardDestination, 'victory')
  while (run.phase === 'reward' && run.rewards.some((offer) => offer.potion !== false)) {
    const offer = run.rewards.find((candidate) => candidate.potion !== false)
    run = resolvePotionReward(run, offer.playerId, { kind: 'skip' })
  }
  if (run.phase === 'reward') run = resolveCardRewards(run, { p2: null })
  assertEqual(run.phase, 'room')
  run = chooseRelicReward(run, 'p2', 'skip')
  assertEqual(run.phase, 'victory')
  run = finishRun(run)
  assertEqual(run.campaign.finalized, true)
  assertEqual(run.campaignProgress.highestAscension, 1)
})

check('Event removal applies Parasite maximum-HP loss through the shared helper', () => {
  let run = inEvent('living_wall', 1)
  run.players[0].deck[0] = { ...run.players[0].deck[0], defId: 'parasite' }
  run.players[0].hp = 9
  run.players[0].maxHp = 9
  run = chooseEvent(run, 'p1', { optionIds: ['forget'], cardUids: [run.players[0].deck[0].uid] })
  assertEqual(run.players[0].maxHp, 7)
  assertEqual(run.players[0].hp, 7)
})

check('Purifier applies every removed Parasite maximum-HP loss', () => {
  let run = inEvent('purifier', 1)
  run.players[0].deck.push({ uid: 'c901', defId: 'parasite', upgraded: false }, { uid: 'c902', defId: 'parasite', upgraded: false })
  run.players[0].hp = 9
  run.players[0].maxHp = 9
  run = chooseEvent(run, 'p1', { optionIds: ['cleanse'] })
  assertEqual(run.players[0].maxHp, 5)
  assertEqual(run.players[0].hp, 5)
  assert(!run.players[0].deck.some((card) => card.defId === 'parasite'))
})

check('staged item rewards accept missing targets and locked selections after reconnect', () => {
  let adventure = inEvent('dead_adventurer', 2)
  adventure = chooseEvent(adventure, 'p1', { optionIds: ['search'] })
  adventure = { ...adventure, roomState: { ...adventure.roomState, pendingRolls: { p1: [6] }, dieRolls: { p1: [6] } } }
  adventure = chooseEvent(adventure, 'p1', { optionIds: ['search'] })
  assertEqual(adventure.roomState.itemOffers.p1[0].kind, 'relic')
  adventure = chooseEvent(adventure, 'p1', { optionIds: ['search'], targetPlayerId: 'p2', rewardItemChoices: ['take'] })
  assertEqual(adventure.phase, 'map')
  assertEqual(adventure.players[1].relics.length, 2)

  let card = inEvent('we_meet_again', 1)
  card.players[0].deck[0] = { ...card.players[0].deck[0], defId: 'feed' }
  const uid = card.players[0].deck[0].uid
  card = chooseEvent(card, 'p1', { optionIds: ['give_card'], cardUids: [uid] })
  card = chooseEvent(card, 'p1', { optionIds: ['give_card'], rewardItemChoices: ['take'] })
  assert(!card.players[0].deck.some((entry) => entry.uid === uid))

  let relic = inEvent('we_meet_again', 1)
  const oldRelic = relic.players[0].relics[0].defId
  relic = chooseEvent(relic, 'p1', { optionIds: ['exchange'], relicIds: [oldRelic] })
  relic = chooseEvent(relic, 'p1', { optionIds: ['exchange'], rewardItemChoices: ['take'] })
  assert(!relic.players[0].relics.some((entry) => entry.defId === oldRelic))
})

check('a targeted final Relic still requires a recipient or an explicit skip', () => {
  let take = inEvent('dead_adventurer', 2)
  take.itemDecks.relics = ['anchor']
  take.roomState.pendingDecisions = { p1: { optionIds: ['search'] } }
  take.roomState.pendingRolls = { p1: [5] }
  take = chooseEvent(take, 'p1', { optionIds: ['search'] })
  const missing = chooseEvent(take, 'p1', { optionIds: ['search'], rewardItemChoices: ['take'] })
  assertDeepEqual(missing, take)
  take = chooseEvent(take, 'p1', { optionIds: ['search'], targetPlayerId: 'p2', rewardItemChoices: ['take'] })
  assertEqual(take.phase, 'map')
  assert(take.players[1].relics.some((relic) => relic.defId === 'anchor'))

  let skip = inEvent('dead_adventurer', 1)
  skip.itemDecks.relics = ['anchor']
  skip.roomState.pendingDecisions = { p1: { optionIds: ['search'] } }
  skip.roomState.pendingRolls = { p1: [5] }
  skip = chooseEvent(skip, 'p1', { optionIds: ['search'] })
  skip = chooseEvent(skip, 'p1', { optionIds: ['search'], rewardItemChoices: ['skip'] })
  assertEqual(skip.phase, 'map')
  assertDeepEqual(skip.itemDecks.relics, ['anchor'])
})

check('malformed Event reward choices cannot duplicate or acquire revealed items', () => {
  let item = inEvent('big_fish', 1)
  item = chooseEvent(item, 'p1', { optionIds: ['box'] })
  const forgedItem = chooseEvent(item, 'p1', { optionIds: ['box'], rewardItemChoices: ['forged'] })
  assertDeepEqual(forgedItem, item)

  let card = inEvent('the_library', 1)
  card = chooseEvent(card, 'p1', { optionIds: ['read'] })
  const before = [...card.players[0].cardRewards]
  const forgedCard = chooseEvent(card, 'p1', { optionIds: ['read'], rewardIndexes: ['0'] })
  assertDeepEqual(forgedCard.players[0].cardRewards, before)
  assertDeepEqual(forgedCard, card)
})

check('each-player Potion gains preserve earlier cross-player passes', () => {
  const state = setup('lab', 2)
  state.decks.potions = []
  const result = resolveEventDecision(state.event, state.rng, state.decks, state.players, 0, 'p1', {
    optionIds: ['resolve'],
    rewardItemIds: ['fire_potion', 'swift_potion'],
    rewardItemKinds: ['potion', 'potion'],
    rewardItemChoices: ['take', 'take'],
    potionRecipientIds: ['p2', ''],
  }, [1])
  assert(result)
  assertDeepEqual(result.players[1].potions, ['fire_potion', 'swift_potion'])
})

check('Ancient Temple serializes chosen order before charging its extra HP', () => {
  let run = inEvent('ancient_temple', 2)
  run = chooseEvent(run, 'p1', { optionIds: ['go_inside'] })
  assertEqual(chooseEvent(run, 'p2', { optionIds: ['go_inside'] }), run)
  run = chooseEvent(run, 'p1', { optionIds: ['go_inside'], rewardItemChoices: ['skip'] })
  assertEqual(run.players[0].hp, 4)
  run = chooseEvent(run, 'p2', { optionIds: ['go_inside'] })
  run = chooseEvent(run, 'p2', { optionIds: ['go_inside'], rewardItemChoices: ['skip'] })
  assertEqual(run.players[1].hp, 3)
})

check('Falling removes one of the three face-up cards', () => {
  let run = inEvent('falling', 1)
  const shown = run.players[0].deck.slice(0, 3)
  run.roomState.revealedCards = { p1: shown.map((card) => card.uid) }
  run.roomState.revealedCardDefs = { p1: shown.map((card) => card.defId) }
  run = chooseEvent(run, 'p1', { optionIds: ['land'], cardUids: [shown[1].uid] })
  assert(!run.players[0].deck.some((card) => card.uid === shown[1].uid))
})

check('chosen and random Event upgrades ignore cards without upgrade faces', () => {
  let chosen = inEvent('upgrade_shrine', 1)
  chosen.players[0].deck[0] = { ...chosen.players[0].deck[0], defId: 'injury' }
  assertEqual(chooseEvent(chosen, 'p1', { optionIds: ['pray'], cardUids: [chosen.players[0].deck[0].uid] }), chosen)

  let random = inEvent('upgrade_shrine', 1)
  random.players[0].deck = random.players[0].deck.slice(0, 3)
  random.players[0].deck[0] = { ...random.players[0].deck[0], defId: 'injury' }
  random = chooseEvent(random, 'p1', { optionIds: ['sacrifice'] })
  assert(!random.players[0].deck[0].upgraded)
  assertEqual(random.players[0].deck.filter((card) => card.upgraded).length, 2)
})

check('Upgrade Shrine still resolves when every card is already upgraded', () => {
  let run = inEvent('upgrade_shrine', 1)
  run.players[0].deck = run.players[0].deck.map((entry) => ({ ...entry, upgraded: true }))
  const hp = run.players[0].hp
  assertEqual(canSkipEvent(run, 'p1'), false)
  run = chooseEvent(run, 'p1', { optionIds: ['sacrifice'] })
  assertEqual(run.phase, 'map')
  assertEqual(run.players[0].hp, hp - 2)
  let chosen = inEvent('upgrade_shrine', 1)
  chosen.players[0].deck = chosen.players[0].deck.map((entry) => ({ ...entry, upgraded: true }))
  chosen = chooseEvent(chosen, 'p1', { optionIds: ['pray'] })
  assertEqual(chosen.phase, 'map')
})

check('non-Pay or Give card effects resolve as no-ops when nothing qualifies', () => {
  let remove = inEvent('purifier', 1)
  remove.players[0].deck = remove.players[0].deck.filter((entry) => entry.defId === 'ascenders_bane')
  remove = chooseEvent(remove, 'p1', { optionIds: ['pray'] })
  assertEqual(remove.phase, 'map')

  let transform = inEvent('transmogriphier', 1)
  transform.players[0].deck = [{ uid: 'only-curse', defId: 'injury', upgraded: false }]
  transform.players[0].cardRewards = []
  transform = chooseEvent(transform, 'p1', { optionIds: ['pray'] })
  assertEqual(transform.phase, 'map')

  let trade = inEvent('note_for_yourself', 2)
  trade.players = trade.players.map((player, index) => ({ ...player, deck: [{ uid: `bane-${index}`, defId: 'ascenders_bane', upgraded: false }] }))
  trade = chooseEvent(trade, 'p1', { optionIds: ['exchange'] })
  trade = chooseEvent(trade, 'p2', { optionIds: ['exchange'] })
  assertEqual(trade.phase, 'map')
})

function enterEvent(id, modifiers = []) {
  let run = postNeowRun(8181, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
  run = { ...run, meta: { mode: modifiers.length ? 'custom' : 'standard', modifierIds: modifiers } }
  const destination = roomChoices(run)[0]
  run.map.rooms[destination.id] = { ...destination, kind: 'event' }
  run.eventDeck = [card(id), card('living_wall')]
  return enterRoom(run, destination.id)
}

check('Transformed replaces normal Event Card Rewards with a card transform', () => {
  let run = enterEvent('the_library', ['transformed'])
  const before = run.players[0].deck.length
  const uid = run.players[0].deck[0].uid
  run = chooseEvent(run, 'p1', { optionIds: ['read'], cardUids: [uid] })
  assertEqual(run.phase, 'map')
  assertEqual(run.players[0].deck.length, before)
  assert(!run.players[0].deck.some((entry) => entry.uid === uid))
})

check('Event rooms publish only currently available Prismatic reward decks', () => {
  let run = postNeowRun(8180, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
  run.players[0].cardRewards = []
  run.itemDecks.characterRares.silent = []
  const destination = roomChoices(run)[0]
  run.map.rooms[destination.id] = { ...destination, kind: 'event' }
  run.eventDeck = [card('cursed_tome')]
  run = enterRoom(run, destination.id)
  assert(!run.roomState.availableRewardSources.card.includes('ironclad'))
  assert(!run.roomState.availableRewardSources.rare.includes('silent'))
  assert(!run.roomState.availableRewardSources.rare.includes('colorless'))
})

check('only the Act I rider faces redraw as the first Event and resolve normally later', () => {
  let first = postNeowRun(8181, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
  const destination = roomChoices(first)[0]
  first.map.rooms[destination.id] = { ...destination, kind: 'event' }
  first.eventDeck = [card('merchant_redraw'), card('encounter_redraw'), card('dead_adventurer'), card('living_wall')]
  first = enterRoom(first, destination.id)
  assertEqual(first.roomState.card.id, 'living_wall')
  assertDeepEqual(first.eventDeck.map((entry) => entry.id), ['merchant_redraw', 'encounter_redraw', 'dead_adventurer', 'living_wall'])

  let later = postNeowRun(8182, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
  const laterDestination = roomChoices(later)[0]
  later.map.rooms[laterDestination.id] = { ...laterDestination, kind: 'event' }
  later.eventsVisited = 1
  later.eventDeck = [card('merchant_redraw')]
  later = enterRoom(later, laterDestination.id)
  assertEqual(later.roomState.card.id, 'merchant')
  later = chooseEvent(later, 'p1', { optionIds: ['shop'] })
  assertEqual(later.roomState.kind, 'merchant')
})

check('completed regular, Merchant, and combat Events return to the deck bottom exactly once', () => {
  let regular = enterEvent('wing_statue')
  regular = chooseEvent(regular, 'p1', { optionIds: ['gather_gold'] })
  assertEqual(regular.phase, 'map')
  assertDeepEqual(regular.eventDeck.map((entry) => entry.id), ['living_wall', 'wing_statue'])

  let merchant = enterEvent('merchant')
  merchant = chooseEvent(merchant, 'p1', { optionIds: ['shop'] })
  assertEqual(merchant.roomState.kind, 'merchant')
  merchant = finishMerchant(merchant)
  assertDeepEqual(merchant.eventDeck.map((entry) => entry.id), ['living_wall', 'merchant'])

  let combat = enterEvent('colosseum')
  combat = chooseEvent(combat, 'p1', { optionIds: ['warm_up'] })
  assertEqual(combat.phase, 'combat')
  combat.combat = { ...combat.combat, phase: 'won', enemies: combat.combat.enemies.map((enemy) => ({ ...enemy, hp: 0, dead: true })) }
  combat = resolveCombat(combat)
  assertDeepEqual(combat.eventDeck.map((entry) => entry.id), ['living_wall', 'colosseum'])
})

check('Vintage converts a normal Event-combat Card Reward into a Relic reward', () => {
  let run = enterEvent('colosseum', ['vintage'])
  run = chooseEvent(run, 'p1', { optionIds: ['warm_up'] })
  run.combat = { ...run.combat, phase: 'won', enemies: run.combat.enemies.map((enemy) => ({ ...enemy, hp: 0, dead: true })) }
  run = resolveCombat(run)
  const reward = run.rewards.find((offer) => offer.playerId === 'p1')
  assertEqual(run.phase, 'reward')
  assertEqual(reward.cardReward, false)
  assertEqual(reward.relic, null)
})

check('a lethal Event loss immediately defeats the party', () => {
  let run = inEvent('woman_in_blue', 2)
  run.players[0].hp = 1
  run = chooseEvent(run, 'p1', { optionIds: ['leave'] })
  assertEqual(run.phase, 'defeat')
  assertEqual(run.roomState, null)
})

check('die Events lock pre-roll payment and Scrap Ooze can leave after a failed reach', () => {
  const joust = inEvent('the_joust', 1)
  const staged = chooseEvent(joust, 'p1', { optionIds: ['bet'] })
  assertEqual(staged.players[0].gold, 10, 'payment is charged before the die is revealed')
  const resolved = chooseEvent(staged, 'p1', { optionIds: ['bet'], relicIds: [staged.players[0].relics[0].defId] })
  assertEqual(resolved.players[0].relics.length, staged.players[0].relics.length, 'revealed payment cannot be changed')

  const ooze = inEvent('scrap_ooze', 1)
  const reached = chooseEvent(ooze, 'p1', { optionIds: ['reach_inside'] })
  const failed = { ...reached, roomState: { ...reached.roomState, pendingRolls: { p1: [1] }, dieRolls: { p1: [1] } } }
  const left = chooseEvent(failed, 'p1', { optionIds: ['leave'] })
  assertEqual(left.phase, 'map')
  assertEqual(left.players[0].hp, 4, 'the failed reach still costs its printed HP')

  let retried = inEvent('scrap_ooze', 1)
  retried = chooseEvent(retried, 'p1', { optionIds: ['reach_inside'] })
  retried = { ...retried, roomState: { ...retried.roomState, pendingRolls: { p1: [1] }, dieRolls: { p1: [1] } } }
  retried = chooseEvent(retried, 'p1', { optionIds: ['reach_inside'] })
  retried = { ...retried, roomState: { ...retried.roomState, pendingRolls: { p1: [6] }, dieRolls: { p1: [1, 6] } } }
  assertDeepEqual(chooseEvent(retried, 'p1', { optionIds: ['leave'] }), retried, 'Leave is tied to the current failed roll')
})

check('Joust never inserts a starting Relic into the shared deck', () => {
  let run = inEvent('the_joust', 1)
  run.players[0].gold = 0
  const before = [...run.itemDecks.relics]
  run = chooseEvent(run, 'p1', { optionIds: ['bet'], relicIds: ['burning_blood'] })
  assertDeepEqual(run.itemDecks.relics, before)
  assertEqual(run.players[0].relics.some((relic) => relic.defId === 'burning_blood'), false)

  let exact = inEvent('the_joust', 1)
  exact.players[0].gold = 2
  exact.players[0].relics = []
  exact.players[0].potions = []
  exact = chooseEvent(exact, 'p1', { optionIds: ['bet'] })
  assertEqual(exact.players[0].gold, 0)
  assertEqual(exact.roomState.pendingRolls.p1.length, 1)
  exact = chooseEvent(exact, 'p1', { optionIds: ['bet'] })
  assertEqual(exact.phase, 'map')
})

check('client-supplied internal Event item ids cannot mint exhausted rewards', () => {
  let run = inEvent('wheel_of_change', 1)
  run.itemDecks.relics = []
  run.roomState.pendingDecisions = { p1: { optionIds: ['spin'] } }
  run.roomState.pendingRolls = { p1: [4] }
  const forged = chooseEvent(run, 'p1', { optionIds: ['spin'], rewardItemIds: ['anchor'], rewardItemKinds: ['relic'] })
  assertDeepEqual(forged, run)
  assertEqual(forged.players[0].relics.some((relic) => relic.defId === 'anchor'), false)
})

check('loss-before-gain Events replenish an empty Relic deck', () => {
  let meet = inEvent('we_meet_again', 1)
  meet.itemDecks.relics = []
  meet.players[0].relics = [{ defId: 'anchor', spent: false }]
  meet = chooseEvent(meet, 'p1', { optionIds: ['exchange'], relicIds: ['anchor'] })
  assertEqual(meet.phase, 'map')
  assert(meet.players[0].relics.some((relic) => relic.defId === 'anchor'))
})

check('card exchanges wait for the target owner and survive as serializable room state', () => {
  const run = inEvent('note_for_yourself', 3)
  const offered = run.players[0].deck[0]
  const returned = run.players[1].deck[0]
  const pending = chooseEvent(run, 'p1', { optionIds: ['exchange'], cardUids: [offered.uid], targetPlayerId: 'p2' })
  assertEqual(pending.players[0].deck[0].uid, offered.uid)
  assertEqual(pending.roomState.pendingTrade?.targetId, 'p2')
  assertEqual(chooseEvent(pending, 'p3', { optionIds: ['accept_trade'], cardUids: [run.players[2].deck[0].uid] }), pending)
  const accepted = chooseEvent(pending, 'p2', { optionIds: ['accept_trade'], cardUids: [returned.uid] })
  assert(accepted.players[0].deck.some((card) => card.uid === returned.uid))
  assert(accepted.players[1].deck.some((card) => card.uid === offered.uid))
})

check('card exchanges preserve an attached Guardian Gem', () => {
  let run = inEvent('note_for_yourself', 2)
  const socketed = { uid: 'traded-socket', defId: 'guardian_harden', upgraded: false,
    attachedGemId: 'guardian_ruby' }
  const returned = run.players[1].deck[0]
  run.players[0].deck = [socketed]
  run = chooseEvent(run, 'p1', {
    optionIds: ['exchange'], cardUids: [socketed.uid], targetPlayerId: 'p2',
  })
  run = chooseEvent(run, 'p2', { optionIds: ['accept_trade'], cardUids: [returned.uid] })
  assertEqual(run.players[1].deck.find((card) => card.uid === socketed.uid)?.attachedGemId, 'guardian_ruby')
  assertDeepEqual(run.pendingGuardianSockets, [])
})

check('other-character rewards reject inherited and malformed deck targets', () => {
  const run = inEvent('note_for_yourself', 1)
  assertDeepEqual(chooseEvent(run, 'p1', { optionIds: ['take'], targetPlayerId: '__proto__' }), run)
  assertDeepEqual(chooseEvent(run, 'p1', { optionIds: ['take'], targetPlayerId: 'not-a-character' }), run)
})

check('one-shot card and Relic trades cannot forge the target owner receipt', () => {
  const note = inEvent('note_for_yourself', 2)
  const offeredCard = note.players[0].deck[0]
  const receivedCard = note.players[1].deck[0]
  assertEqual(chooseEvent(note, 'p1', {
    optionIds: ['exchange'], targetPlayerId: 'p2', cardUids: [offeredCard.uid], receiveCardUid: receivedCard.uid,
  }), note)

  const faces = inEvent('face_trader', 2)
  faces.players[0].relics = [{ defId: 'anchor', spent: false }]
  faces.players[1].relics = [{ defId: 'happy_flower', spent: false }]
  assertEqual(chooseEvent(faces, 'p1', {
    optionIds: ['exchange'], targetPlayerId: 'p2', relicIds: ['anchor'], receiveRelicId: 'happy_flower',
  }), faces)
})

check('accepted Relic trades preserve the physical face-up or spent state', () => {
  let run = inEvent('face_trader', 2)
  run.players[0].relics = [{ defId: 'anchor', spent: true }]
  run.players[1].relics = [{ defId: 'happy_flower', spent: false }]
  run = chooseEvent(run, 'p1', { optionIds: ['exchange'], targetPlayerId: 'p2', relicIds: ['anchor'] })
  run = chooseEvent(run, 'p2', { optionIds: ['accept_trade'], relicIds: ['happy_flower'] })
  assertEqual(run.players[1].relics.find((relic) => relic.defId === 'anchor')?.spent, true)
  assertEqual(run.players[0].relics.find((relic) => relic.defId === 'happy_flower')?.spent, false)
})

check('Lab lets each owner resolve their Potion before the party roll', () => {
  let run = inEvent('lab', 3)
  run.players[0].potions = ['fire_potion', 'swift_potion', 'blood_potion']
  run.players[1].potions = ['fire_potion', 'swift_potion', 'blood_potion']
  run = chooseEvent(run, 'p1', { optionIds: ['resolve'] })
  assertEqual(run.roomState.itemOffers.p1[0].kind, 'potion', 'the Potion is revealed before its owner decides')
  run = chooseEvent(run, 'p1', { optionIds: ['resolve'], rewardItemChoices: ['skip'] })
  assertEqual(run.players[0].potions.join(','), 'fire_potion,swift_potion,blood_potion', 'a full seat may skip the drawn Potion')
  run = chooseEvent(run, 'p2', { optionIds: ['resolve'] })
  run = chooseEvent(run, 'p2', { optionIds: ['resolve'], rewardItemChoices: ['take'], potionReplacementIds: ['fire_potion'] })
  assert(!run.players[1].potions.includes('fire_potion'), 'only the Potion owner can replace one')
  run = chooseEvent(run, 'p3', { optionIds: ['resolve'] })
  run = chooseEvent(run, 'p3', { optionIds: ['resolve'], rewardItemChoices: ['take'] })
  run = { ...run, roomState: { ...run.roomState, pendingRolls: { p3: [6] }, dieRolls: { p3: [6] } } }
  const p1Potions = [...run.players[0].potions]
  run = chooseEvent(run, 'p3', { optionIds: ['resolve'], targetPlayerId: 'p1' })
  assertEqual(run.roomState.itemOffers.p3[0].kind, 'potion', 'the bonus Potion is revealed before assignment')
  const forged = chooseEvent(run, 'p3', { optionIds: ['resolve'], targetPlayerId: 'p1', rewardItemChoices: ['take'], potionReplacementIds: ['fire_potion'] })
  assertDeepEqual(forged, run, 'the coordinator cannot discard a target seat Potion')
  run = chooseEvent(run, 'p3', { optionIds: ['resolve'], targetPlayerId: 'p1', rewardItemChoices: ['skip'] })
  assertEqual(run.phase, 'map')
  assertEqual(run.players[0].potions.join(','), p1Potions.join(','), 'the coordinator cannot discard a target seat Potion')
})

check('Lab can pass its initial Potion while the owner has an open slot', () => {
  let run = inEvent('lab', 2)
  run = chooseEvent(run, 'p1', { optionIds: ['resolve'] })
  run = chooseEvent(run, 'p1', { optionIds: ['resolve'], rewardItemChoices: ['take'], potionRecipientIds: ['p2'] })
  assertEqual(run.players[0].potions.length, 0)
  assertEqual(run.players[1].potions.length, 1)
})

check('Lab conserves its Potion when Sozu blocks the owner or recipient', () => {
  let owner = inEvent('lab', 1)
  owner.itemDecks.potions = ['fire_potion']
  owner.potionDeck = ['fire_potion']
  owner.players[0].relics.push({ defId: 'sozu', spent: false })
  owner = chooseEvent(owner, 'p1', { optionIds: ['resolve'] })
  owner = chooseEvent(owner, 'p1', { optionIds: ['resolve'], rewardItemChoices: ['take'] })
  assertDeepEqual(owner.players[0].potions, [])
  assertDeepEqual(owner.itemDecks.potions, ['fire_potion'])
  assertDeepEqual(owner.potionDeck, owner.itemDecks.potions)

  let passed = inEvent('lab', 2)
  passed.itemDecks.potions = ['fire_potion']
  passed.potionDeck = ['fire_potion']
  passed.players[1].relics.push({ defId: 'sozu', spent: false })
  passed = chooseEvent(passed, 'p1', { optionIds: ['resolve'] })
  const rejected = chooseEvent(passed, 'p1', { optionIds: ['resolve'], rewardItemChoices: ['take'], potionRecipientIds: ['p2'] })
  assertEqual(rejected, passed, 'Lab accepted a Sozu recipient')
  passed = chooseEvent(passed, 'p1', { optionIds: ['resolve'], rewardItemChoices: ['skip'] })
  assertDeepEqual(passed.players[1].potions, [])
  assertDeepEqual(passed.itemDecks.potions, ['fire_potion'])
  assertDeepEqual(passed.potionDeck, passed.itemDecks.potions)
})

check('solo Note for Yourself draws from a persistent non-playing character deck', () => {
  let run = inEvent('note_for_yourself', 1)
  const before = run.itemDecks.characterCards.silent.length
  run = chooseEvent(run, 'p1', { optionIds: ['take'], targetPlayerId: 'silent' })
  assert(run.roomState.rewardOffers.p1[0].length >= 3)
  run = chooseEvent(run, 'p1', { optionIds: ['take'], targetPlayerId: 'silent', rewardIndexes: [0] })
  assertEqual(run.phase, 'map')
  assertEqual(run.itemDecks.characterCards.silent.length, before - 1)
})

check('inactive character rewards preserve an unchosen duplicate', () => {
  let run = inEvent('note_for_yourself', 1)
  run.itemDecks.characterCards.silent = ['backflip', 'backflip', 'acrobatics']
  run.itemDecks.characterRares.silent = []
  run = chooseEvent(run, 'p1', { optionIds: ['take'], targetPlayerId: 'silent' })
  assertDeepEqual(run.roomState.rewardOffers.p1[0], ['backflip', 'backflip', 'acrobatics'],
    'base Event rewards must preserve physical duplicate faces')
  run = chooseEvent(run, 'p1', { optionIds: ['take'], targetPlayerId: 'silent', rewardIndexes: [0] })
  assertDeepEqual(run.itemDecks.characterCards.silent, ['backflip', 'acrobatics'])
})

check('revealed Event rewards ignore choices submitted before the reveal', () => {
  let library = inEvent('the_library', 1)
  library = chooseEvent(library, 'p1', { optionIds: ['read'], rewardIndexes: [4] })
  assertEqual(library.roomState.pendingDecisions.p1.rewardIndexes, undefined)
  const selected = library.roomState.rewardOffers.p1[0][0]
  library = chooseEvent(library, 'p1', { optionIds: ['read'], rewardIndexes: [0] })
  assert(library.players[0].deck.some((entry) => entry.defId === selected))

  let blue = inEvent('woman_in_blue', 2)
  blue.players[0].gold = 1
  blue = chooseEvent(blue, 'p1', { optionIds: ['buy_one'], rewardItemChoices: ['skip'], potionRecipientIds: ['p2'] })
  assertEqual(blue.roomState.pendingDecisions.p1.rewardItemChoices, undefined)
  assertEqual(blue.roomState.pendingDecisions.p1.potionRecipientIds, undefined)
  blue = chooseEvent(blue, 'p1', { optionIds: ['buy_one'], rewardItemChoices: ['take'] })
  assertEqual(blue.players[0].potions.length, 1)
})

check('Face Trader gains before prompting which Relic to return', () => {
  let run = inEvent('face_trader', 1)
  run.players[0].relics = [{ defId: 'happy_flower', spent: false }]
  run.itemDecks.relics = ['anchor', ...run.itemDecks.relics.filter((id) => id !== 'anchor')]
  run = chooseEvent(run, 'p1', { optionIds: ['take_and_give'], relicIds: ['anchor'] })
  assertEqual(run.roomState.pendingDecisions.p1.optionIds[0], 'take_and_give')
  assertEqual(run.roomState.pendingDecisions.p1.relicIds, undefined)
  assert(run.players[0].relics.some((relic) => relic.defId === 'anchor'))
  const forged = chooseEvent(run, 'p1', { optionIds: ['take_and_give'], relicIds: ['old_coin'] })
  assertEqual(forged, run)
  const changedOption = chooseEvent(run, 'p1', { optionIds: ['exchange'], targetPlayerId: 'p1', relicIds: ['anchor'] })
  assertEqual(changedOption, run)
  run = chooseEvent(run, 'p1', { optionIds: ['take_and_give'], relicIds: ['happy_flower'] })
  assertEqual(run.phase, 'map')
  assert(run.players[0].relics.some((relic) => relic.defId === 'anchor'))
  assert(!run.players[0].relics.some((relic) => relic.defId === 'happy_flower'))
  assertEqual(run.itemDecks.relics.at(-1), 'happy_flower')
})

check('Note for Yourself resolves a teammate Golden Ticket against their rare deck', () => {
  let run = inEvent('note_for_yourself', 2)
  run.players[1].cardRewards = ['golden_ticket', 'backflip', 'acrobatics', ...run.players[1].cardRewards]
  run.players[1].rareRewards = ['bullet_time', ...run.players[1].rareRewards]
  run = chooseEvent(run, 'p1', { optionIds: ['take'], targetPlayerId: 'p2' })
  assertEqual(run.roomState.rewardOffers.p1[0][2], 'bullet_time')
  run = chooseEvent(run, 'p1', { optionIds: ['take'], targetPlayerId: 'p2', rewardIndexes: [2] })
  assert(run.players[0].deck.some((entry) => entry.defId === 'bullet_time'))
  assertDeepEqual(run.players[1].cardRewards.slice(-3), ['golden_ticket', 'backflip', 'acrobatics'])
})

check('staged Events validate costs and prerequisites before drawing an offer', () => {
  let blue = inEvent('woman_in_blue', 1)
  blue.players[0].gold = 0
  assertEqual(chooseEvent(blue, 'p1', { optionIds: ['buy_one'] }), blue)
  assertEqual(blue.roomState.itemOffers, undefined)

  let meet = inEvent('we_meet_again', 1)
  meet.players[0].relics = []
  assertEqual(chooseEvent(meet, 'p1', { optionIds: ['exchange'] }), meet)
  meet.players[0].deck = meet.players[0].deck.filter((entry) => !['rare', 'uncommon'].includes(CARDS[entry.defId]?.rarity ?? ''))
  assertEqual(chooseEvent(meet, 'p1', { optionIds: ['give_card'] }), meet)

  let nloth = inEvent('nloth', 1)
  nloth.players[0].relics = []
  nloth.players[0].potions = []
  assertEqual(chooseEvent(nloth, 'p1', { optionIds: ['offer_relic'] }), nloth)
  assertEqual(chooseEvent(nloth, 'p1', { optionIds: ['offer_potion'] }), nloth)
})

check("N'loth loses the random Relic before publishing its Rare Reward", () => {
  let run = inEvent('nloth', 1)
  run.players[0].relics = [{ defId: 'anchor', spent: false }, { defId: 'happy_flower', spent: false }]
  const calls = run.rng.calls
  run = chooseEvent(run, 'p1', { optionIds: ['offer_relic'] })
  assertEqual(run.players[0].relics.length, 1)
  assert(run.rng.calls > calls)
  assertEqual(run.roomState.rewardOffers.p1[0].length > 0, true)
  assertEqual(run.roomState.pendingDecisions.p1.optionIds[0], 'offer_relic')

  let final = inEvent('nloth', 1)
  final.players[0].relics = [{ defId: 'anchor', spent: false }]
  final = chooseEvent(final, 'p1', { optionIds: ['offer_relic'] })
  assertEqual(final.players[0].relics.length, 0)
  assertEqual(final.roomState.rewardOffers.p1[0].length > 0, true)
  final = chooseEvent(final, 'p1', { optionIds: ['offer_relic'], rewardIndexes: [-1] })
  assertEqual(final.phase, 'map')
})

check('Pay or Give options reject impossible downstream effects before charging', () => {
  let beggar = inEvent('old_beggar', 1)
  beggar.players[0].gold = 2
  beggar.players[0].deck = [{ uid: 'c1', defId: 'ascenders_bane', upgraded: false }]
  assert(canSkipEvent(beggar, 'p1'))
  assertDeepEqual(chooseEvent(beggar, 'p1', { optionIds: ['give'] }), beggar)

  let nloth = inEvent('nloth', 1)
  nloth.players[0].relics = [{ defId: 'anchor', spent: false }]
  nloth.players[0].rareRewards = []
  assert(canSkipEvent(nloth, 'p1'))
  const offered = chooseEvent(nloth, 'p1', { optionIds: ['offer_relic'] })
  assertDeepEqual(offered, nloth)
  assert(nloth.players[0].relics.some((relic) => relic.defId === 'anchor'))
})

check('staged selectors stay locked and Ascender’s Bane cannot be traded', () => {
  let note = inEvent('note_for_yourself', 3)
  note.players[1].cardRewards = ['backflip', 'acrobatics', 'dagger_throw', ...note.players[1].cardRewards]
  note.players[2].cardRewards = ['ball_lightning', 'cold_snap', 'charge_battery', ...note.players[2].cardRewards]
  note = chooseEvent(note, 'p1', { optionIds: ['take'], targetPlayerId: 'p2' })
  note = chooseEvent(note, 'p1', { optionIds: ['take'], targetPlayerId: 'p3', rewardIndexes: [0] })
  assert(note.players[0].deck.some((entry) => entry.defId === 'backflip'))
  assert(!note.players[0].deck.some((entry) => entry.defId === 'ball_lightning'))

  let trade = inEvent('note_for_yourself', 2)
  trade.players[0].deck = [{ uid: 'bane-a', defId: 'ascenders_bane', upgraded: false }, ...trade.players[0].deck]
  assertEqual(chooseEvent(trade, 'p1', { optionIds: ['exchange'], targetPlayerId: 'p2', cardUids: ['bane-a'] }), trade)
  const offered = trade.players[0].deck[1]
  trade.players[1].deck = [{ uid: 'bane-b', defId: 'ascenders_bane', upgraded: false }, ...trade.players[1].deck]
  const waiting = chooseEvent(trade, 'p1', { optionIds: ['exchange'], targetPlayerId: 'p2', cardUids: [offered.uid] })
  assertEqual(chooseEvent(waiting, 'p2', { optionIds: ['accept_trade'], cardUids: ['bane-b'] }), waiting)
})

check('Mind Bloom Awake defeats only at zero HP after its printed loss', () => {
  let run = inEvent('mind_bloom', 1)
  run.players[0].hp = 4
  const choices = run.players[0].deck.filter((entry) => CARDS[entry.defId]?.upgrade).slice(0, 2).map((entry) => entry.uid)
  run = chooseEvent(run, 'p1', { optionIds: ['awake'], cardUids: choices })
  assertEqual(run.phase, 'map')
  assertEqual(run.players[0].hp, 1)
  assertEqual(run.players[0].dead, false)
})

check('Mind Bloom Awake resolves zero or one available upgrades for later seats', () => {
  let run = inEvent('mind_bloom', 2)
  const first = run.players[0].deck.filter((entry) => CARDS[entry.defId]?.upgrade).slice(0, 2).map((entry) => entry.uid)
  run = chooseEvent(run, 'p1', { optionIds: ['awake'], cardUids: first })
  run.players[1].deck = run.players[1].deck.map((entry, index) => ({ ...entry, upgraded: index !== 0 }))
  const only = run.players[1].deck[0].uid
  run = chooseEvent(run, 'p2', { optionIds: ['awake'], cardUids: [only] })
  assertEqual(run.phase, 'map')
  assertEqual(run.players[1].deck[0].upgraded, true)

  let none = inEvent('mind_bloom', 2)
  const two = none.players[0].deck.filter((entry) => CARDS[entry.defId]?.upgrade).slice(0, 2).map((entry) => entry.uid)
  none = chooseEvent(none, 'p1', { optionIds: ['awake'], cardUids: two })
  none.players[1].deck = none.players[1].deck.map((entry) => ({ ...entry, upgraded: true }))
  none = chooseEvent(none, 'p2', { optionIds: ['awake'] })
  assertEqual(none.phase, 'map')
})

check('multi-card Event effects resolve every eligible card that remains', () => {
  let transform = inEvent('augmenter', 1)
  transform.players[0].deck = [{ uid: 'single-transform', defId: 'strike_ironclad', upgraded: false }]
  transform.players[0].cardRewards = ['bash']
  transform = chooseEvent(transform, 'p1', { optionIds: ['become_test_subject'], cardUids: ['single-transform'] })
  assertEqual(transform.phase, 'map')
  assertEqual(transform.players[0].deck[0].defId, 'bash')

  let writing = inEvent('ancient_writing', 1)
  writing.players[0].deck = writing.players[0].deck.filter((entry) => CARDS[entry.defId]?.name !== 'Strike')
  const defend = writing.players[0].deck.find((entry) => CARDS[entry.defId]?.rarity === 'starter' && CARDS[entry.defId]?.name === 'Defend' && !entry.upgraded)
  writing = chooseEvent(writing, 'p1', { optionIds: ['simplicity'], cardUids: [defend.uid] })
  assertEqual(writing.phase, 'map')
  assertEqual(writing.players[0].deck.find((entry) => entry.uid === defend.uid).upgraded, true)
})

check('losing a character or solo relic never poisons the shared relic deck', () => {
  const state = setup('nloth', 1)
  state.players[0].relics = [{ defId: 'burning_blood', spent: false }]
  const before = state.decks.relics.length
  const resolved = resolveEventDecision(state.event, state.rng, state.decks, state.players, 0, 'p1', { optionIds: ['offer_relic'], rewardIndexes: [0] })
  assert(resolved)
  assertEqual(resolved.players[0].relics.length, 0)
  assertEqual(state.decks.relics.length, before)
})

check('a player with no legal Pay or Give Event choice may leave without deadlocking', () => {
  for (const id of ['the_cleric', 'old_beggar', 'the_joust', 'we_meet_again', 'nloth']) {
    let run = inEvent(id, 1)
    run.players[0].gold = 0
    run.players[0].relics = []
    run.players[0].potions = []
    run.players[0].deck = run.players[0].deck.filter((entry) => !['rare', 'uncommon'].includes(CARDS[entry.defId]?.rarity ?? ''))
    assert(canSkipEvent(run, 'p1'), `${id} still claimed a legal option`)
    run = skipEvent(run, 'p1')
    assertEqual(run.phase, 'map')
    assertEqual(run.roomState, null)
  }
})

check('exhausted normal and Rare Prismatic Event rewards allow the no-choice escape', () => {
  let run = inEvent('cursed_tome', 1)
  run.players[0].relics.push({ defId: 'prismatic_shard', spent: false })
  run.players[0].cardRewards = []
  run.players[0].rareRewards = []
  run.itemDecks.colorless = []
  run.itemDecks.characterCards = Object.fromEntries(Object.keys(run.itemDecks.characterCards).map((id) => [id, []]))
  run.itemDecks.characterRares = Object.fromEntries(Object.keys(run.itemDecks.characterRares).map((id) => [id, []]))
  run.roomState.card = { ...run.roomState.card, options: run.roomState.card.options.filter((option) => ['take', 'skim'].includes(option.id)) }
  assert(canSkipEvent(run, 'p1'))
  assertEqual(chooseEvent(run, 'p1', { optionIds: ['skim'], rewardSources: [] }), run)
  assertEqual(chooseEvent(run, 'p1', { optionIds: ['take'], rewardSources: [] }), run)
  run = skipEvent(run, 'p1')
  assertEqual(run.phase, 'map')
})

check('exhausted item decks never strand mandatory, paid, rolled, or Lab Events', () => {
  let paid = inEvent('we_meet_again', 1)
  paid.itemDecks.relics = []
  paid.players[0].relics = []
  paid.players[0].potions = []
  paid.players[0].deck = paid.players[0].deck.filter((entry) => !['rare', 'uncommon'].includes(CARDS[entry.defId]?.rarity ?? ''))
  assert(canSkipEvent(paid, 'p1'), 'paid empty Relic reward remains available')
  assertEqual(chooseEvent(paid, 'p1', { optionIds: ['give_gold'] }), paid)

  let mandatory = inEvent('mausoleum', 1)
  mandatory.itemDecks.relics = []
  mandatory = chooseEvent(mandatory, 'p1', { optionIds: ['open_coffin'] })
  mandatory = chooseEvent(mandatory, 'p1', { optionIds: ['open_coffin'] })
  assertEqual(mandatory.phase, 'map', 'mandatory empty Relic Event')

  let rolled = inEvent('dead_adventurer', 1)
  rolled.itemDecks.relics = []
  rolled.roomState.pendingDecisions = { p1: { optionIds: ['search'] } }
  rolled.roomState.pendingRolls = { p1: [5] }
  rolled = chooseEvent(rolled, 'p1', { optionIds: ['search'] })
  assertEqual(rolled.phase, 'map', 'rolled empty Relic reward')

  let lab = inEvent('lab', 2)
  lab.itemDecks.potions = []
  lab = chooseEvent(lab, 'p1', { optionIds: ['resolve'] })
  lab = chooseEvent(lab, 'p2', { optionIds: ['resolve'] })
  lab.roomState.pendingRolls = { p2: [6] }
  lab = chooseEvent(lab, 'p2', { optionIds: ['resolve'] })
  assertEqual(lab.phase, 'map', 'empty Lab supply')
})

check('Tomb of Lord Red Mask requires the physical Red Mask for its free option', () => {
  const direct = setup('tomb_red_mask', 2)
  assertEqual(resolveEventDecision(direct.event, direct.rng, direct.decks, direct.players, 0, 'p1', { optionIds: ['don_mask'] }), null)

  let run = inEvent('tomb_red_mask', 2)
  assertEqual(chooseEvent(run, 'p1', { optionIds: ['don_mask'] }), run)
  run.players[1].relics = [...run.players[1].relics, { defId: 'red_mask', spent: false }]
  run = chooseEvent(run, 'p1', { optionIds: ['don_mask'] })
  assertEqual(run.phase, 'map')
  assert(run.players.every((player) => player.gold === 18))
})

check('Prismatic Shard reserves chosen Event reward decks and bottoms unused cards', () => {
  let run = inEvent('cursed_tome', 1)
  run.players[0].relics.push({ defId: 'prismatic_shard', spent: false })
  run.players[0].cardRewards = ['anger', 'cleave']
  run.itemDecks.characterCards.silent = ['acrobatics', 'backflip']
  run.itemDecks.characterCards.defect = ['claw', 'leap']
  run = chooseEvent(run, 'p1', { optionIds: ['skim'], rewardSources: ['ironclad', 'silent', 'defect'] })
  assertDeepEqual(run.roomState.rewardOffers.p1[0], ['anger', 'acrobatics', 'claw'])
  run = chooseEvent(run, 'p1', { optionIds: ['skim'], rewardIndexes: [1] })
  assertEqual(run.phase, 'map')
  assert(run.players[0].deck.some((card) => card.defId === 'acrobatics'))
  assertDeepEqual(run.players[0].cardRewards, ['cleave', 'anger'])
  assertDeepEqual(run.itemDecks.characterCards.silent, ['backflip'])
  assertDeepEqual(run.itemDecks.characterCards.defect, ['leap', 'claw'])
})

report('physical Event resolution')
