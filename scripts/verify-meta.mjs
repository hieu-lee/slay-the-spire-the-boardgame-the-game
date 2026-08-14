import {
  DAILY_MODIFIERS,
  DAILY_MODIFIER_SECTIONS,
  QUICK_START_DIE_REWARDS,
  QUICK_START_TABLE,
  rollDailyModifiers,
} from '../src/game/meta.ts'
import { createRng } from '../src/game/rng.ts'
import { suite, check, assertEqual, assertDeepEqual, report } from './lib/harness.mjs'

suite('Daily Climb, Custom Run, and Quick Start catalogs')

const tuples = (steps) => steps.map(({ kind, count }) => [kind, count])

check('the two Daily Climb sections map all 12 official modifiers to die faces', () => {
  assertDeepEqual(
    DAILY_MODIFIERS.map(({ id, name, section, roll, rule }) => [id, name, section, roll, rule]),
    [
      ['all_star', 'All Star', 'upper', 1, 'Each player starts with 5 random Colorless cards.'],
      ['shiny', 'Shiny', 'upper', 2, 'Each player starts with 5 random rare cards.'],
      ['heirloom', 'Heirloom', 'upper', 3, 'Each player starts with a random Boss relic.'],
      ['transformed', 'Transformed', 'upper', 4, 'Normal card rewards become Transform a card.'],
      ['vintage', 'Vintage', 'upper', 5, 'Normal card rewards from Encounters become relic rewards.'],
      ['prismatic_shard', 'Prismatic Shard', 'upper', 6, 'Each player starts with Prismatic Shard. Normal rewards reveal 3 cards from 3 different chosen reward decks, optionally including Colorless; rare rewards reveal 3 cards from 3 different character rare decks.'],
      ['terminal', 'Terminal', 'lower', 1, 'Each player loses 1 HP at the end of combat.'],
      ['insanity', 'Insanity', 'lower', 2, 'At the end of combat, each player must Transform a random card in their deck.'],
      ['uncertain_future', 'Uncertain Future', 'lower', 3, 'Map tokens remain face-down during setup and are revealed when the party lands on the room.'],
      ['cursed', 'Cursed', 'lower', 4, 'Each player starts with 2 random Curses.'],
      ['deadly_events', 'Deadly Events', 'lower', 5, 'Each player loses 2 HP after each Event.'],
      ['night_terrors', 'Night Terrors', 'lower', 6, 'Players cannot Rest.'],
    ],
  )
  assertEqual(DAILY_MODIFIER_SECTIONS.upper.length, 6)
  assertEqual(DAILY_MODIFIER_SECTIONS.lower.length, 6)
})

check('Daily Climb rolls are seeded, consume exactly two draws, and select one modifier per section', () => {
  const a = createRng(12345)
  const b = createRng(12345)
  const first = rollDailyModifiers(a)
  assertDeepEqual(first, rollDailyModifiers(b))
  assertDeepEqual(first, {
    rolls: [6, 2],
    modifiers: [DAILY_MODIFIER_SECTIONS.upper[5], DAILY_MODIFIER_SECTIONS.lower[1]],
  })
  assertEqual(a.calls, 2)
  assertEqual(b.calls, 2)
})

check('Quick Start preserves every official Act column in resolution order', () => {
  assertDeepEqual(tuples(QUICK_START_TABLE[2]), [
    ['neow', 1], ['gold', 6], ['cardReward', 4], ['transform', 1], ['rollDie', 1],
    ['potion', 1], ['relic', 2], ['rareReward', 1], ['bossRelic', 1],
    ['upgrade', 2], ['merchant', 1],
  ])
  assertDeepEqual(tuples(QUICK_START_TABLE[3]), [
    ['neow', 1], ['gold', 7], ['cardReward', 4], ['transform', 1], ['rollDie', 3],
    ['potion', 1], ['relic', 4], ['rareReward', 2], ['bossRelic', 2],
    ['cardReward', 3], ['cardRemove', 1], ['upgrade', 4], ['merchant', 1],
  ])
  assertDeepEqual(tuples(QUICK_START_TABLE[4]), [
    ['neow', 1], ['gold', 10], ['cardReward', 5], ['transform', 1], ['rollDie', 5],
    ['potion', 1], ['relic', 6], ['rareReward', 2], ['bossRelic', 2],
    ['cardReward', 5], ['cardRemove', 2], ['upgrade', 6], ['merchant', 1],
  ])
})

check('Quick Start die faces map to the exact ordered reward combinations', () => {
  assertDeepEqual(Object.fromEntries(Object.entries(QUICK_START_DIE_REWARDS).map(([face, rewards]) => [face, tuples(rewards)])), {
    1: [['relic', 1]],
    2: [['transform', 1]],
    3: [['cardReward', 1], ['gold', 1]],
    4: [['potion', 1], ['gold', 2]],
    5: [['upgrade', 1]],
    6: [['cardRemove', 1]],
  })
})

report('meta rules')
