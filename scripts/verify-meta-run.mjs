import {
  advanceQuickSetup,
  beginCatchUp,
  createRun,
  revealCardReward,
  resolveCardRewards,
} from '../src/game/run.ts'
import { createCampaignProgress } from '../src/game/campaign.ts'
import { currentQuickSetupStep } from '../src/game/meta.ts'
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

check('Quick Start grants each player one row at a time and stages no future offer', () => {
  let run = createRun(32, party, 0, createCampaignProgress(), false, false, { quickStartAct: 2 })
  run = { ...run, phase: 'setup', neow: null }
  assertEqual(currentQuickSetupStep(run.setup).kind, 'gold')
  const before = run.players.map((player) => player.gold)
  run = advanceQuickSetup(run)
  assertEqual(run.players[0].gold, before[0] + 6)
  assertEqual(currentQuickSetupStep(run.setup).kind, 'gold')
  run = advanceQuickSetup(run)
  assertEqual(run.players[1].gold, before[1] + 6)
  assertEqual(currentQuickSetupStep(run.setup).kind, 'cardReward')
  run = advanceQuickSetup(run)
  assertEqual(run.phase, 'reward')
  assertEqual(run.rewards.length, 1)
  assertEqual(run.rewards[0].choices, null)
  run = revealCardReward(run, 'p1')
  assertEqual(run.rewards[0].choices.length, 3)
  run = resolveCardRewards(run, { p1: null })
  assertEqual(run.phase, 'setup')
  assertEqual(run.setup.playerIndex, 1)
})

check('Quick Start die keeps only the public current result', () => {
  let run = createRun(33, [party[0]], 0, createCampaignProgress(), false, false, { quickStartAct: 2 })
  run = { ...run, phase: 'setup', neow: null, setup: { ...run.setup, rowIndex: 4, playerIndex: 0, repeatIndex: 0, die: null } }
  run = advanceQuickSetup(run)
  assert(run.setup.die && run.setup.die.value >= 1 && run.setup.die.value <= 6)
  assert(currentQuickSetupStep(run.setup).kind !== 'rollDie')
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

report('meta run')
