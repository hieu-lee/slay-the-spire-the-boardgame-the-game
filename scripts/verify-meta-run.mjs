import {
  advanceAct,
  advanceQuickSetup,
  beginCatchUp,
  chooseEvent,
  chooseNeow,
  createRun,
  enterRoom,
  resolveCardRewards,
  resolveNeowGold,
  resolveNeowReward,
  revealCardReward,
  revealNeowReward,
  roomChoices,
} from '../src/game/run.ts'
import { createCampaignProgress } from '../src/game/campaign.ts'
import { currentQuickSetupStep } from '../src/game/meta.ts'
import { CARD_PACKS } from '../src/game/packs.ts'
import { validateRunLog } from '../src/ui/run-log.ts'
import { MAX_BOSS_AWARD_COINS } from '../src/game/coins.ts'
import { NEOW_CARDS } from '../src/game/neow.ts'
import { createEventRoom } from '../src/game/event-room.ts'
import { EVENT_CARDS } from '../src/game/events.ts'
import { finishQuickSetup } from '../src/game/run/quick-setup.ts'
import { suite, check, assert, assertEqual, assertDeepEqual, report } from './lib/harness.mjs'

suite('official run modifiers and Quick Start')

const party = [
  { id: 'p1', name: 'Ironclad', character: 'ironclad' },
  { id: 'p2', name: 'Silent', character: 'silent' },
]

check('setup modifiers use the finite physical supplies', () => {
  const progress = { ...createCampaignProgress(), colorless: 3 }
  const run = createRun(31, party, 0, progress, false, false, {
    mode: 'custom', modifiers: ['all_star', 'cursed', 'prismatic_shard'],
  })
  assertEqual(run.players[0].deck.length, 17)
  assertEqual(run.players[1].deck.length, 19)
  assertEqual(run.itemDecks.colorless.length, 12)
  assertEqual(run.itemDecks.curses.length, 9)
  assert(run.players.every((player) => player.relics.some((relic) => relic.defId === 'prismatic_shard')))
})

check('Shiny queues Guardian Sockets during initial and Catch Up setup', () => {
  const options = { mode: 'custom', modifiers: ['shiny'], ruleset: 'downfall' }
  const initial = createRun(1, [{ id: 'guardian', name: 'Guardian', character: 'guardian' }],
    0, createCampaignProgress(), false, false, options)
  assert(initial.pendingGuardianSockets.length > 0)
  assertEqual(initial.guardianGemDeck.length, 24 - initial.pendingGuardianSockets.length)

  let run = createRun(2, [party[0]], 0, createCampaignProgress(), false, false, options)
  run = { ...run, phase: 'map', neow: null, act: 2, map: { ...run.map, act: 2, position: null } }
  const caught = beginCatchUp(run, [{ id: 'guardian', name: 'Guardian', character: 'guardian' }])
  assert(caught.pendingGuardianSockets.length > 0)
  assertEqual(caught.guardianGemDeck.length, 24 - caught.pendingGuardianSockets.length)
})

check('Quick Start skips deterministic Gold clicks and stages no future offer', () => {
  let run = createRun(32, party, 0, createCampaignProgress(), false, false, { quickStartAct: 2 })
  run = { ...run, phase: 'setup', neow: null }
  assertEqual(currentQuickSetupStep(run.setup).kind, 'gold')
  const before = run.players.map((player) => player.gold)
  run = advanceQuickSetup(run)
  assertEqual(run.players[0].gold, before[0] + 6)
  assertEqual(run.players[1].gold, before[1] + 6)
  assertEqual(currentQuickSetupStep(run.setup).kind, 'cardReward')
  assertEqual(run.phase, 'reward')
  assertEqual(run.rewards.length, 1)
  assertEqual(run.rewards[0].choices, null)
  run = revealCardReward(run, 'p1')
  assertEqual(run.rewards[0].choices.length, 3)
  run = resolveCardRewards(run, { p1: null })
  assertEqual(run.phase, 'setup')
  assertEqual(run.setup.playerIndex, 1)
})

check('Quick Start rolls its die and advances directly to the resulting real choice', () => {
  let run = createRun(33, [party[0]], 0, createCampaignProgress(), false, false, { quickStartAct: 2 })
  run = { ...run, phase: 'setup', neow: null, setup: { ...run.setup, rowIndex: 4, playerIndex: 0, repeatIndex: 0, die: null } }
  run = advanceQuickSetup(run)
  assert(run.phase === 'reward' || currentQuickSetupStep(run.setup)?.kind === 'transform' ||
    currentQuickSetupStep(run.setup)?.kind === 'upgrade' || currentQuickSetupStep(run.setup)?.kind === 'cardRemove')
  assert(currentQuickSetupStep(run.setup)?.kind !== 'rollDie')
})

check('Quick Start skips an optionless card operation before revealing the next reward', () => {
  let run = createRun(3301, [party[0]], 0, createCampaignProgress(), false, false, { quickStartAct: 2 })
  run = {
    ...run,
    phase: 'setup',
    neow: null,
    players: run.players.map((player) => ({ ...player, deck: player.deck.map((card) => ({ ...card, upgraded: true })) })),
    setup: { ...run.setup, rowIndex: 9, playerIndex: 0, repeatIndex: 0, die: null },
  }
  run = advanceQuickSetup(run)
  assertEqual(run.phase, 'room')
  assertEqual(run.roomState?.kind, 'merchant')
})

check('Quick Start removal applies Parasite HP loss and stops setup when lethal', () => {
  for (const hp of [6, 1]) {
    let run = createRun(3301, [party[0]], 0, createCampaignProgress(), false, false, { quickStartAct: 3 })
    run = { ...run, phase: 'setup', neow: null,
      setup: { ...run.setup, rowIndex: 10, playerIndex: 0, repeatIndex: 0, die: null } }
    run.players[0].hp = hp
    run.players[0].deck[0] = { ...run.players[0].deck[0], defId: 'parasite' }
    const maxHp = run.players[0].maxHp
    run = advanceQuickSetup(run, [run.players[0].deck[0].uid])
    assertEqual(run.players[0].hp, Math.max(0, hp - 2))
    assertEqual(run.players[0].maxHp, maxHp)
    assertEqual(run.players[0].dead, hp === 1)
    assertEqual(run.phase === 'defeat', hp === 1)
    if (hp === 1) assertEqual(run.setup, null)
  }
})

check('Quick Start and Catch Up skip Transform when the physical replacement supply is unusable', () => {
  for (const kind of ['quick-start', 'catch-up']) {
    let run = createRun(kind === 'quick-start' ? 3302 : 3303, [party[0]], 0,
      createCampaignProgress(), false, false, { quickStartAct: 2 })
    const owner = run.players[0]
    run = {
      ...run,
      phase: 'setup',
      neow: null,
      players: [{ ...owner, cardRewards: ['golden_ticket'], rareRewards: [] }],
      setup: { ...run.setup, kind, rowIndex: 3, playerIndex: 0, repeatIndex: 0, die: null },
    }
    const before = structuredClone(run)
    assertEqual(advanceQuickSetup(run, [owner.deck[0].uid]), run,
      `${kind} accepted a Transform that cannot draw a replacement`)
    const skipped = advanceQuickSetup(run)
    assert(currentQuickSetupStep(skipped.setup)?.kind !== 'transform', `${kind} retained an impossible Transform prompt`)
    assertDeepEqual(skipped.players[0].deck, before.players[0].deck)
    assertDeepEqual(skipped.players[0].cardRewards, ['golden_ticket'])
  }
})

check('Catch Up admits new unique characters only at an untouched Act boundary', () => {
  let run = createRun(34, [party[0]], 0, createCampaignProgress())
  run = { ...run, phase: 'map', neow: null, act: 2, map: { ...run.map, act: 2, position: null } }
  const caught = beginCatchUp(run, [party[1]])
  assertEqual(caught.phase, 'neow')
  assertEqual(caught.setup.kind, 'catch-up')
  assertDeepEqual(caught.setup.playerIds, ['p2'])
  assertEqual(caught.players.length, 2)
  assertEqual(caught.neow.players.p1, undefined)
  assert(caught.neow.players.p2)
  const third = beginCatchUp(caught, [{ id: 'p3', name: 'Defect', character: 'defect' }])
  assertEqual(third.players.length, 3)
  assertDeepEqual(third.setup.playerIds, ['p2', 'p3'])
  const entered = { ...run, map: { ...run.map, position: 'entered' } }
  assertEqual(beginCatchUp(entered, [party[1]]), entered)
})

check('Catch Up keeps finite decks, modifiers, campaign offsets, and card uids', () => {
  let run = createRun(35, [party[0]], 0, { ...createCampaignProgress(), colorless: 3 }, false, false, {
    mode: 'custom', modifiers: ['all_star', 'shiny', 'cursed', 'prismatic_shard'],
  })
  run = {
    ...run,
    phase: 'map', neow: null, act: 2,
    map: { ...run.map, act: 2, position: null },
    players: run.players.map((player) => ({ ...player, deck: [...player.deck, { uid: 'c900', defId: 'anger', upgraded: false }] })),
    campaign: { ...run.campaign, bossesDefeated: 1 },
  }
  const cardRewards = [...run.itemDecks.characterCards.silent]
  const rareRewards = [...run.itemDecks.characterRares.silent]
  const colorless = run.itemDecks.colorless.length
  const curses = run.itemDecks.curses.length
  const rngCalls = run.rng.calls
  const caught = beginCatchUp(run, [party[1]])
  const newcomer = caught.players.find((player) => player.id === 'p2')
  assertDeepEqual(newcomer.cardRewards, cardRewards)
  assertEqual(newcomer.rareRewards.length, rareRewards.length - 5)
  assertEqual(caught.itemDecks.colorless.length, colorless - 5)
  assertEqual(caught.itemDecks.curses.length, curses - 2)
  assertEqual(newcomer.deck.length, 24)
  assert(newcomer.relics.some((relic) => relic.defId === 'prismatic_shard'))
  assertEqual(caught.campaign.joinedAfterBosses.silent, 1)
  assertEqual(caught.rng.calls - rngCalls, 30, 'Catch Up shuffled throwaway reward decks')
  const uids = caught.players.flatMap((player) => player.deck.map((card) => card.uid))
  assertEqual(new Set(uids).size, uids.length)
  assert(newcomer.deck.every((entry) => Number(entry.uid.slice(1)) > 900))
})

check('Catch Up applies Heirloom without consuming a throwaway character deck', () => {
  let run = createRun(36, [party[0]], 0, createCampaignProgress(), false, false, {
    mode: 'custom', modifiers: ['heirloom'],
  })
  run = { ...run, phase: 'map', neow: null, act: 2, map: { ...run.map, act: 2, position: null } }
  const cardRewards = [...run.itemDecks.characterCards.silent]
  const bossRelics = run.bossRelicDeck.length
  const caught = beginCatchUp(run, [party[1]])
  const newcomer = caught.players.find((player) => player.id === 'p2')
  assertDeepEqual(newcomer.cardRewards, cardRewards)
  assertEqual(caught.bossRelicDeck.length, bossRelics - 1)
  assertEqual(newcomer.relics.length, 2)
})

check('Transformed replaces Quick Start normal Card Rewards', () => {
  let run = createRun(37, [party[0]], 0, createCampaignProgress(), false, false, {
    mode: 'custom', modifiers: ['transformed'], quickStartAct: 2,
  })
  run = { ...run, phase: 'setup', neow: null, setup: { ...run.setup, rowIndex: 2 } }
  run = advanceQuickSetup(run)
  assertEqual(run.phase, 'reward')
  assertEqual(run.rewards[0].cardReward, false)
  assertEqual(run.rewards[0].transformReward, true)
})

check('Prismatic Quick Start advertises only nonempty physical reward decks', () => {
  let run = createRun(3701, party, 0, createCampaignProgress(), false, false, {
    mode: 'custom', modifiers: ['prismatic_shard'], quickStartAct: 2,
  })
  run = { ...run, phase: 'setup', neow: null, setup: { ...run.setup, rowIndex: 2 } }
  run.players[1].cardRewards = []
  run = advanceQuickSetup(run)
  assertEqual(run.phase, 'reward')
  assert(!run.rewards[0].availableSources.includes('silent'))
  assert(run.rewards[0].availableSources.includes('ironclad'))
})

check('All Star does not unlock Colorless campaign content', () => {
  let run = createRun(38, [party[0]], 0, createCampaignProgress(), false, false, {
    mode: 'custom', modifiers: ['all_star'], quickStartAct: 2,
  })
  assert(run.itemDecks.colorless.length > 0)
  run = { ...run, phase: 'setup', neow: null, setup: { ...run.setup, rowIndex: 10 } }
  run = advanceQuickSetup(run)
  assertEqual(run.roomState.kind, 'merchant')
  assertDeepEqual(run.roomState.colorless, [])
})

check('two-player Prismatic rewards reserve different physical cards and bottom only unused cards', () => {
  let run = createRun(39, party, 0, { ...createCampaignProgress(), colorless: 3 }, false, false, {
    mode: 'custom', modifiers: ['prismatic_shard'],
  })
  run = {
    ...run,
    phase: 'reward', rewardDestination: 'map',
    players: run.players.map((player) => player.id === 'p1'
      ? { ...player, cardRewards: ['anger'] }
      : { ...player, cardRewards: ['acrobatics', 'backflip', 'blade_dance'] }),
    itemDecks: {
      ...run.itemDecks,
      characterCards: {
        ...run.itemDecks.characterCards,
        defect: ['claw', 'leap', 'beam_cell'],
        watcher: ['cut_through_fate', 'third_eye', 'follow_up'],
      },
    },
    rewards: party.map(({ id }) => ({
      playerId: id, cardReward: true, choices: null, upgraded: false,
      prismatic: true, availableSources: ['ironclad', 'silent', 'defect'],
      potion: false, relic: false, bossRelics: false,
    })),
  }
  run = revealCardReward(run, 'p1', ['ironclad', 'silent', 'defect'])
  assertDeepEqual(run.rewards.find((offer) => offer.playerId === 'p1').choices, ['anger', 'acrobatics', 'claw'])
  assert(!run.rewards.find((offer) => offer.playerId === 'p2').availableSources.includes('ironclad'))
  run = revealCardReward(run, 'p2', ['silent', 'defect', 'watcher'])
  assertDeepEqual(run.rewards.find((offer) => offer.playerId === 'p2').choices, ['backflip', 'leap', 'cut_through_fate'])
  run = resolveCardRewards(run, { p1: 0, p2: 1 })
  assertDeepEqual(run.players.find((player) => player.id === 'p1').cardRewards, [])
  assertDeepEqual(run.players.find((player) => player.id === 'p2').cardRewards, ['blade_dance', 'acrobatics', 'backflip'])
  assertDeepEqual(run.itemDecks.characterCards.defect, ['beam_cell', 'claw'])
  assertDeepEqual(run.itemDecks.characterCards.watcher, ['third_eye', 'follow_up', 'cut_through_fate'])
  assert(run.players.find((player) => player.id === 'p1').deck.some((card) => card.defId === 'anger'))
  assert(run.players.find((player) => player.id === 'p2').deck.some((card) => card.defId === 'leap'))
})

suite('Shop card packs in runs')

const packCards = (id) => CARD_PACKS[id].cardIds
const rewardCards = (player) => [...player.cardRewards, ...player.rareRewards]

check('no packs, an empty list or only unknown ids build byte-identical runs to before', () => {
  const plain = JSON.stringify(createRun(41, party, 3))
  for (const cardPacks of [[], ['slayer_kratos'], 'slayer_ironclad', null]) {
    assertEqual(JSON.stringify(createRun(41, party, 3, createCampaignProgress(), false, false, { cardPacks })), plain,
      `${JSON.stringify(cardPacks)} changed the run`)
  }
})

check('an owner pack joins that hero\'s reward decks and nobody else\'s', () => {
  const run = createRun(42, party, 0, createCampaignProgress(), false, false, { cardPacks: ['slayer_ironclad'] })
  const [ironclad, silent] = run.players
  for (const id of packCards('slayer_ironclad')) {
    assert(rewardCards(ironclad).includes(id), `${id} is missing from the Ironclad reward decks`)
    assert(!rewardCards(silent).includes(id), `${id} leaked into the Silent reward decks`)
  }
  assert(!rewardCards(silent).some((id) => id.startsWith('slayer_')), 'the Silent pack was never enabled')
  const plain = createRun(42, party)
  assertEqual(rewardCards(ironclad).length, rewardCards(plain.players[0]).length + packCards('slayer_ironclad').length)
  assertDeepEqual(run.meta.cardPacks, ['slayer_ironclad'])
})

check('a pack for a hero outside the party stocks only the Prismatic supply of that hero', () => {
  const run = createRun(43, [party[0]], 0, createCampaignProgress(), false, false, { cardPacks: ['slayer_watcher'] })
  const watcherSupply = [...run.itemDecks.characterCards.watcher, ...run.itemDecks.characterRares.watcher]
  for (const id of packCards('slayer_watcher')) assert(watcherSupply.includes(id), `${id} missing from the Watcher supply`)
  assert(!rewardCards(run.players[0]).some((id) => id.startsWith('slayer_')))
})

check('the Colorless pack stocks the Colorless supply even before the Colorless unlock', () => {
  const locked = createRun(44, party, 0, createCampaignProgress(), false, false, { cardPacks: ['slayer_colorless'] })
  assertDeepEqual([...locked.itemDecks.colorless].sort(), [...packCards('slayer_colorless')].sort())
  const unlocked = createRun(44, party, 0, { ...createCampaignProgress(), colorless: 3 }, false, false, { cardPacks: ['slayer_colorless'] })
  const base = createRun(44, party, 0, { ...createCampaignProgress(), colorless: 3 })
  assertEqual(unlocked.itemDecks.colorless.length, base.itemDecks.colorless.length + packCards('slayer_colorless').length)
  assert(packCards('slayer_colorless').every((id) => unlocked.itemDecks.colorless.includes(id)))
  assert(!base.itemDecks.colorless.some((id) => id.startsWith('slayer_')))
})

check('pack lists are normalised: known ids, no duplicates, catalogue order', () => {
  const run = createRun(45, party, 0, createCampaignProgress(), false, false, {
    cardPacks: ['slayer_colorless', 'slayer_kratos', 'slayer_silent', 'slayer_colorless'],
  })
  assertDeepEqual(run.meta.cardPacks, ['slayer_silent', 'slayer_colorless'])
})

check('a Daily Climb ignores bought packs entirely', () => {
  const daily = { mode: 'daily', dailyDate: '2026-10-09' }
  const plain = createRun(1, [party[0]], 0, createCampaignProgress(), false, false, daily)
  const withPacks = createRun(1, [party[0]], 0, createCampaignProgress(), false, false,
    { ...daily, cardPacks: ['slayer_ironclad', 'slayer_colorless'] })
  assertEqual(JSON.stringify(withPacks), JSON.stringify(plain))
  assertEqual(withPacks.meta.cardPacks, undefined)
})

check('Catch Up deals a late hero the packs the run started with', () => {
  let run = createRun(46, [party[0]], 0, createCampaignProgress(), false, false, { cardPacks: ['slayer_silent'] })
  run = { ...run, phase: 'map', neow: null, act: 2, map: { ...run.map, act: 2, position: null } }
  const caught = beginCatchUp(run, [party[1]])
  const newcomer = caught.players.find((player) => player.id === 'p2')
  const supply = [...newcomer.cardRewards, ...newcomer.rareRewards, ...newcomer.deck.map((card) => card.defId)]
  assert(packCards('slayer_silent').every((id) => supply.includes(id)), 'the late Silent lost its pack cards')
  assertDeepEqual(caught.meta.cardPacks, ['slayer_silent'])
})

check('a Catch Up hero with no stocked supply deck is dealt fresh reward decks with the run\'s packs', () => {
  let run = createRun(48, [party[0]], 0, createCampaignProgress(), false, false, { cardPacks: ['slayer_silent'] })
  run = { ...run, phase: 'map', neow: null, act: 2, map: { ...run.map, act: 2, position: null } }
  const { silent: _cards, ...characterCards } = run.itemDecks.characterCards
  const { silent: _rares, ...characterRares } = run.itemDecks.characterRares
  run = { ...run, itemDecks: { ...run.itemDecks, characterCards, characterRares } }
  const caught = beginCatchUp(run, [party[1]])
  const newcomer = caught.players.find((player) => player.id === 'p2')
  assert(newcomer, 'precondition: the Silent joined')
  const supply = [...newcomer.cardRewards, ...newcomer.rareRewards, ...newcomer.deck.map((card) => card.defId)]
  assert(packCards('slayer_silent').every((id) => supply.includes(id)), 'the fresh Silent decks lost the pack')
  const plain = beginCatchUp({ ...run, meta: { ...run.meta, cardPacks: undefined } }, [party[1]])
  const plainNewcomer = plain.players.find((player) => player.id === 'p2')
  assert(![...plainNewcomer.cardRewards, ...plainNewcomer.rareRewards].some((id) => id.startsWith('slayer_')), 'no pack, no pack cards')
})

check('run logs keep the packs a run started with, and reject forged ones', () => {
  const makeLog = (initial) => {
    const final = structuredClone(initial)
    final.phase = 'defeat'
    final.neow = null
    final.combat = null
    return { version: 2, runId: initial.campaign.runId, initial, events: [{ patch: [{ path: [], value: final }] }] }
  }
  const packed = createRun(47, [party[0]], 0, createCampaignProgress(), false, false, { cardPacks: ['slayer_ironclad'] })
  assert(validateRunLog(makeLog(packed)), 'a run with packs must replay')
  assert(validateRunLog(makeLog(createRun(47, [party[0]]))), 'an old log without packs stays valid')
  for (const cardPacks of [['slayer_kratos'], ['slayer_ironclad', 'slayer_ironclad'], 'slayer_ironclad']) {
    const forged = structuredClone(packed)
    forged.meta = { ...forged.meta, cardPacks }
    assertEqual(validateRunLog(makeLog(forged)), null, `${JSON.stringify(cardPacks)} must be refused`)
  }
})

suite('a bought Colorless pack without the Colorless unlock')

const colorlessPack = new Set(CARD_PACKS.slayer_colorless.cardIds)
const lockedRun = (seed, cardPacks, modifiers) => createRun(seed, [party[0]], 0, createCampaignProgress(), false, false,
  { mode: modifiers ? 'custom' : 'standard', ...(modifiers ? { modifiers } : {}), ...(cardPacks ? { cardPacks } : {}) })
/** Walks into a real Merchant: the first reachable room is made a shop for the fixture. */
const atMerchant = (run) => {
  const onMap = { ...run, phase: 'map', neow: null }
  const [first] = roomChoices(onMap)
  return enterRoom({ ...onMap, map: { ...onMap.map, rooms: { ...onMap.map.rooms, [first.id]: { ...onMap.map.rooms[first.id], kind: 'merchant' } } } }, first.id)
}

check('the Merchant sells the pack\'s cards, and still sells no Colorless card without a pack', () => {
  const shop = atMerchant(lockedRun(51, ['slayer_colorless']))
  assertEqual(shop.roomState.kind, 'merchant')
  assertEqual(shop.roomState.colorless.length, 3)
  assert(shop.roomState.colorless.every((id) => colorlessPack.has(id)), `${shop.roomState.colorless} are not pack cards`)
  assertEqual(shop.itemDecks.colorless.length, colorlessPack.size - 3, 'the offered cards left the supply')
  const plain = lockedRun(51)
  const plainShop = atMerchant(plain)
  assertDeepEqual(plainShop.roomState.colorless, [])
  assertDeepEqual(plainShop.itemDecks.colorless, [])
})

check('a modifier\'s locked base Colorless cards stay out of the Merchant even beside a pack', () => {
  const run = lockedRun(52, ['slayer_colorless'], ['all_star'])
  const base = run.itemDecks.colorless.filter((id) => !colorlessPack.has(id))
  assert(base.length > 0, 'precondition: All Star stocks the base Colorless supply')
  const shop = atMerchant(run)
  assertEqual(shop.roomState.colorless.length, 3)
  assert(shop.roomState.colorless.every((id) => colorlessPack.has(id)), `${shop.roomState.colorless} leaked a locked base card`)
  assertDeepEqual(shop.itemDecks.colorless.filter((id) => !colorlessPack.has(id)).sort(), base.sort(), 'the base cards stay in the supply')
  const withoutPack = atMerchant(lockedRun(52, undefined, ['all_star']))
  assertDeepEqual(withoutPack.roomState.colorless, [], 'without a pack the locked Merchant pile stays empty')
})

check('Neow deals the Colorless blessings, and their offer is the pack\'s cards', () => {
  const run = lockedRun(53, ['slayer_colorless'])
  const supply = [...run.neow.deck, ...Object.values(run.neow.players).map((progress) => progress.cardId)]
  assertEqual(supply.length, NEOW_CARDS.length, 'the Colorless Neow cards are dealt with the pack')
  const plain = lockedRun(53)
  const plainSupply = [...plain.neow.deck, ...Object.values(plain.neow.players).map((progress) => progress.cardId)]
  assertEqual(plainSupply.length, NEOW_CARDS.filter((card) => !card.unlocked).length, 'no pack, no Colorless Neow card')

  let neow = resolveNeowReward(resolveNeowGold(run, 'p1', false), 'p1', null)
  neow = { ...neow, neow: { ...neow.neow, players: { ...neow.neow.players, p1: { ...neow.neow.players.p1, cardId: 'neow_c06' } } } }
  neow = revealNeowReward(chooseNeow(neow, 'p1', 2), 'p1')
  const choices = neow.neow.players.p1.reward.choices
  assertEqual(choices.length, 3)
  assert(choices.every((id) => colorlessPack.has(id)), `Neow offered ${choices}`)
})

check('Act III deals Sensory Stone with the pack, and its Colorless reward offers pack cards', () => {
  const won = (run) => {
    const onMap = { ...run, phase: 'map', neow: null, act: 2, map: { ...run.map, act: 2 } }
    const boss = Object.values(onMap.map.rooms).find((room) => room.kind === 'boss')
    return advanceAct({ ...onMap, phase: 'victory', map: { ...onMap.map, position: boss.id,
      rooms: { ...onMap.map.rooms, [boss.id]: { ...boss, visited: true } } } })
  }
  assert(won(lockedRun(54, ['slayer_colorless'])).eventDeck.some((card) => card.id === 'sensory_stone'))
  assert(!won(lockedRun(54)).eventDeck.some((card) => card.id === 'sensory_stone'), 'without a pack Sensory Stone stays locked')

  const run = lockedRun(55, ['slayer_colorless'])
  let event = { ...run, phase: 'room', neow: null, roomState: createEventRoom(EVENT_CARDS.find((card) => card.id === 'sensory_stone')) }
  event = chooseEvent(event, 'p1', { optionIds: ['recall_one'] })
  const offer = event.roomState.rewardOffers.p1[0]
  assertEqual(offer.length, 3)
  assert(offer.every((id) => colorlessPack.has(id)), `Sensory Stone offered ${offer}`)
})

check('Quick Start opens the Colorless Events with the unlock or the pack, in every Act it can start in', () => {
  for (const unlocked of [false, true]) for (const cardPacks of [undefined, ['slayer_colorless']]) {
    const progress = { ...createCampaignProgress(), actIV: 5, ...(unlocked ? { colorless: 3 } : {}) }
    for (const quickStartAct of [2, 3, 4]) {
      const run = createRun(57, [party[0]], 0, progress, false, false, { quickStartAct, ...(cardPacks ? { cardPacks } : {}) })
      const done = finishQuickSetup(run)
      assertEqual(done.act, quickStartAct)
      const stone = done.eventDeck.some((card) => card.id === 'sensory_stone')
      const label = `Act ${quickStartAct}, ${unlocked ? 'unlocked' : 'locked'}, ${cardPacks ? 'pack' : 'no pack'}`
      assertEqual(stone, quickStartAct === 3 && (unlocked || Boolean(cardPacks)), label)
      if (quickStartAct === 4) assertEqual(done.eventDeck.length, 0, label)
    }
  }
})

check('Catch Up deals the Colorless Neow cards with the pack, including a refilled empty Neow supply', () => {
  const supplyOf = (run) => [...run.neow.deck, ...Object.values(run.neow.players).map((progress) => progress.cardId)]
  for (const cardPacks of [undefined, ['slayer_colorless']]) {
    let run = lockedRun(58, cardPacks)
    run = { ...run, phase: 'map', neow: null, act: 2, map: { ...run.map, act: 2, position: null } }
    const caught = beginCatchUp(run, [party[1]])
    const expected = cardPacks ? NEOW_CARDS.length : NEOW_CARDS.filter((card) => !card.unlocked).length
    assertEqual(supplyOf(caught).length, expected, `${cardPacks ? 'pack' : 'no pack'}: fresh Catch Up Neow supply`)
    // An older save stored no Neow supply: a second hero joining refills it the same way.
    const emptied = { ...caught, neow: { ...caught.neow, deck: [] } }
    const third = { id: 'p3', name: 'Defect', character: 'defect' }
    const refilled = beginCatchUp(emptied, [third])
    const dealt = Object.values(caught.neow.players).map((progress) => progress.cardId)
    assertEqual(supplyOf(refilled).length, expected, `${cardPacks ? 'pack' : 'no pack'}: refilled Neow supply`)
    assert(dealt.every((id) => supplyOf(refilled).filter((other) => other === id).length === 1), 'a dealt Neow card was dealt twice')
  }
})

check('runs without a pack are unchanged on a locked campaign', () => {
  const before = lockedRun(56)
  assertEqual(JSON.stringify(lockedRun(56, [])), JSON.stringify(before))
  assertEqual(before.itemDecks.colorless.length, 0)
})

suite('run logs validate the Slayer Pack combat state')

const combatLog = (mutate) => {
  const run = createRun(61, [party[0]], 0, createCampaignProgress(), false, false, { cardPacks: ['slayer_colorless'] })
  const onMap = { ...run, phase: 'map', neow: null }
  const initial = structuredClone(enterRoom(onMap, roomChoices(onMap)[0].id))
  mutate?.(initial.combat, initial)
  const final = structuredClone(initial)
  final.phase = 'defeat'
  final.neow = null
  final.combat = null
  return { version: 2, runId: initial.campaign.runId, initial, events: [{ patch: [{ path: [], value: final }] }] }
}

check('well-formed Slayer fields replay, and logs from before them stay valid', () => {
  assert(validateRunLog(combatLog()), 'a combat log without the new fields must stay valid')
  assert(validateRunLog(combatLog((combat) => {
    const [first, second] = combat.players[0].hand
    Object.assign(first, { mayRetainThisTurn: true, playWindowCost: 0, xPaid: 2 })
    Object.assign(second, { metamorphosis: { upgraded: false, sourceUid: second.uid, copiedX: 1 } })
    combat.players[0].lostHpLastRound = true
    combat.enemies[0].slayerAttachments = [{ card: { uid: 'c900', defId: 'slayer_nightmare', upgraded: false }, playerId: 'p1' }]
    combat.pendingCardPlayWindows = [{ id: 'w1', playerId: 'p1', sourceCardId: 'slayer_discovery', cardUids: [first.uid], cost: 0, plays: 1, optional: true, discardRest: true }]
    combat.pendingPlayerChoices = [{ id: 3, playerId: 'p1', sourceLabel: 'Magnetism', kind: 'returnDiscardTop', upTo: 1 }]
    combat.nextPlayerChoiceId = 4
    combat.pendingSlayerChoices = [{ kind: 'ritualDagger', playerId: 'p1', cardUid: first.uid, revealed: 'slayer_violence' }]
  })), 'every well-formed Slayer field must replay (a choice saved before ids existed has none)')
  assert(validateRunLog(combatLog((combat) => {
    const card = { uid: 'c901', defId: 'slayer_nightmare', upgraded: true }
    combat.pendingSlayerChoices = [
      { id: 4, kind: 'reattach', playerId: 'p1', card, fromUid: 'e1' },
      { id: 5, kind: 'ritualDagger', playerId: 'p1', cardUid: combat.players[0].hand[0].uid, revealed: 'slayer_violence' },
    ]
    combat.nextPlayerChoiceId = 6
  })), 'Slayer choices with distinct ids must replay')
})

check('Ritual Dagger rewards, onDiscard counts and the Armaments allowance replay only when well formed', () => {
  const dagger = { uid: 'c950', defId: 'slayer_ritual_dagger', upgraded: false }
  const withDagger = (extra) => (combat) => { combat.players[0].hand.push({ ...dagger }); extra(combat) }
  const trigger = { id: 7, playerId: 'p1', sourceId: 'slayer_eviscerate' }
  assert(validateRunLog(combatLog(withDagger((combat) => {
    combat.slayerKillRewards = [{ playerId: 'p1', cardUid: 'c950', reward: 'upgrade' }]
    combat.pendingTriggers = [{ ...trigger, count: 2 }]
    combat.players[0].retainBlockAllowance = 2
  }))), 'well-formed values must replay')
  const malformed = {
    'kill rewards that are not a list': (combat) => { combat.slayerKillRewards = { playerId: 'p1' } },
    'a kill reward for a card the owner does not hold': (combat) => { combat.slayerKillRewards = [{ playerId: 'p1', cardUid: 'c999', reward: 'upgrade' }] },
    'a kill reward naming a card that is no Ritual Dagger': (combat) => {
      combat.slayerKillRewards = [{ playerId: 'p1', cardUid: combat.players[0].hand[0].uid, reward: 'upgrade' }] },
    'a kill reward for another seat': withDagger((combat) => { combat.slayerKillRewards = [{ playerId: 'p9', cardUid: 'c950', reward: 'upgrade' }] }),
    'a kill reward of an unknown kind': withDagger((combat) => { combat.slayerKillRewards = [{ playerId: 'p1', cardUid: 'c950', reward: 'duplicate' }] }),
    'too many kill rewards': withDagger((combat) => { combat.slayerKillRewards = Array.from({ length: 17 }, () => ({ playerId: 'p1', cardUid: 'c950', reward: 'reveal' })) }),
    'a negative onDiscard count': (combat) => { combat.pendingTriggers = [{ ...trigger, count: -1 }] },
    'a fractional onDiscard count': (combat) => { combat.pendingTriggers = [{ ...trigger, count: 1.5 }] },
    'an Armaments allowance below zero': (combat) => { combat.players[0].retainBlockAllowance = -2 },
    'an Armaments allowance that is not whole': (combat) => { combat.players[0].retainBlockAllowance = 0.5 },
    'an absurd Armaments allowance': (combat) => { combat.players[0].retainBlockAllowance = 1e6 },
  }
  for (const [label, mutate] of Object.entries(malformed)) assertEqual(validateRunLog(combatLog(mutate)), null, label)
})

check('a boss award above the most any boss pays rejects the run log', () => {
  const withAward = (coins) => combatLog((_combat, initial) => { initial.campaign.bossCoins = [{ act: 4, coins }] })
  assert(validateRunLog(withAward(MAX_BOSS_AWARD_COINS)), 'the top award must replay')
  assertEqual(validateRunLog(withAward(MAX_BOSS_AWARD_COINS + 1)), null)
})

check('a malformed Slayer field rejects the imported run log', () => {
  const window = { id: 'w1', playerId: 'p1', sourceCardId: 'slayer_discovery', cardUids: [], cost: 0, plays: 1, optional: true }
  const malformed = {
    'mayRetainThisTurn not a boolean': (combat) => { combat.players[0].hand[0].mayRetainThisTurn = 'yes' },
    'playWindowCost above the Energy cap': (combat) => { combat.players[0].hand[0].playWindowCost = 99 },
    'xPaid negative': (combat) => { combat.players[0].hand[0].xPaid = -1 },
    'xPaid fractional': (combat) => { combat.players[0].hand[0].xPaid = 1.5 },
    'metamorphosis without its physical card': (combat) => { combat.players[0].hand[0].metamorphosis = { upgraded: false } },
    'metamorphosis copiedX not a number': (combat) => { combat.players[0].hand[0].metamorphosis = { upgraded: true, sourceUid: 'c1', copiedX: 'x' } },
    'lostHpLastRound not a boolean': (combat) => { combat.players[0].lostHpLastRound = 1 },
    'attachment owned by nobody at the table': (combat) => { combat.enemies[0].slayerAttachments = [{ card: { uid: 'c900', defId: 'slayer_nightmare', upgraded: false }, playerId: 'p9' }] },
    'attachment of an unknown card': (combat) => { combat.enemies[0].slayerAttachments = [{ card: { uid: 'c900', defId: 'not_a_card', upgraded: false }, playerId: 'p1' }] },
    'play window for another seat': (combat) => { combat.pendingCardPlayWindows = [{ ...window, playerId: 'p9' }] },
    'play window from an unknown card': (combat) => { combat.pendingCardPlayWindows = [{ ...window, sourceCardId: 'nope' }] },
    'play window costing past the cap': (combat) => { combat.pendingCardPlayWindows = [{ ...window, cost: 40 }] },
    'play window with negative plays': (combat) => { combat.pendingCardPlayWindows = [{ ...window, plays: -2 }] },
    'two play windows with one id': (combat) => { combat.pendingCardPlayWindows = [window, { ...window }] },
    'player choice counter negative': (combat) => { combat.nextPlayerChoiceId = -1 },
    'player choice counter fractional': (combat) => { combat.nextPlayerChoiceId = 1.5 },
    'player choice counter not a number': (combat) => { combat.nextPlayerChoiceId = '4' },
    'player choice of an unknown kind': (combat) => { combat.pendingPlayerChoices = [{ id: 1, playerId: 'p1', sourceLabel: 'x', kind: 'steal' }] },
    'player choice for another seat': (combat) => { combat.pendingPlayerChoices = [{ id: 1, playerId: 'p9', sourceLabel: 'x', kind: 'drawOrDiscard' }] },
    'player choice returning too many': (combat) => { combat.pendingPlayerChoices = [{ id: 1, playerId: 'p1', sourceLabel: 'x', kind: 'returnDiscardTop', upTo: 999 }] },
    'Slayer choice with a negative id': (combat) => { combat.pendingSlayerChoices = [{ id: -1, kind: 'ritualDagger', playerId: 'p1', cardUid: 'c1', revealed: 'slayer_violence' }] },
    'Slayer choice with a fractional id': (combat) => { combat.pendingSlayerChoices = [{ id: 1.5, kind: 'ritualDagger', playerId: 'p1', cardUid: 'c1', revealed: 'slayer_violence' }] },
    'Slayer choice with an id that is not a number': (combat) => { combat.pendingSlayerChoices = [{ id: '1', kind: 'ritualDagger', playerId: 'p1', cardUid: 'c1', revealed: 'slayer_violence' }] },
    'two Slayer choices with one id': (combat) => {
      const choice = { id: 2, kind: 'ritualDagger', playerId: 'p1', cardUid: 'c1', revealed: 'slayer_violence' }
      combat.pendingSlayerChoices = [choice, { ...choice }] },
    'Slayer choice for another seat': (combat) => { combat.pendingSlayerChoices = [{ kind: 'ritualDagger', playerId: 'p9', cardUid: 'c1', revealed: 'slayer_violence' }] },
    'Slayer choice revealing an unknown card': (combat) => { combat.pendingSlayerChoices = [{ kind: 'ritualDagger', playerId: 'p1', cardUid: 'c1', revealed: 'nope' }] },
  }
  for (const [label, mutate] of Object.entries(malformed)) assertEqual(validateRunLog(combatLog(mutate)), null, label)
})

report('meta run')
