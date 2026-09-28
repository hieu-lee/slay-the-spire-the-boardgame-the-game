#!/usr/bin/env node
// The shared-seed Daily Climb: a fixed day seed, a fully unlocked baseline and
// no campaign marks, so two players with different journals start identically.
import { createCampaignProgress } from '../src/game/campaign.ts'
import { dailyDate } from '../src/daily-date.ts'
import { DAILY_ASCENSION, dailyClimbResult, dailySeedText } from '../src/game/daily.ts'
import { createRun, finishRun } from '../src/game/run.ts'
import { rollDailyModifiers } from '../src/game/meta.ts'
import { createRng, seedFromString } from '../src/game/rng.ts'
import { assert, assertDeepEqual, assertEqual, assertThrows, check, report, suite } from './lib/harness.mjs'

suite('Daily Climb')

const day = '2026-09-28'
const party = [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }]
// The caller's seed, Ascension, Quick Start and campaign never reach a Daily Climb.
const climb = (journal, seed = 1, ascension = 0) => createRun(seed, party, ascension, journal, false, false,
  { mode: 'daily', quickStartAct: 3, campaign: 'downfall', modifiers: ['cursed'], dailyDate: day })

check('the day is the UTC calendar date', () => {
  assertEqual(dailyDate(Date.parse('2026-09-28T23:59:59Z')), '2026-09-28')
  assertEqual(dailyDate(Date.parse('2026-09-29T00:00:00Z')), '2026-09-29')
})

const fresh = createCampaignProgress()
const veteran = { ...createCampaignProgress(), characters: { ...fresh.characters, ironclad: 3 }, colorless: 1, actIV: 2, highestAscension: 4, nextRunNumber: 40 }
const first = climb(fresh)
const second = climb(veteran, 999, 4)

check('players with different campaign journals start the same climb', () => {
  const opening = (run) => ({ map: run.map, deck: run.players[0].deck, neow: run.neow, enemyDecks: run.enemyDecks,
    relics: run.relicDeck, events: run.eventDeck, modifiers: run.meta.modifierIds, boss: run.actBossDefId })
  assertDeepEqual(opening(first), opening(second))
  assertEqual(first.seed, seedFromString(dailySeedText(day)))
  assertEqual(first.ascension, DAILY_ASCENSION)
  assertEqual(first.meta.dailyDate, day)
  assertEqual(first.meta.campaign, 'base')
  assertEqual(first.setup, null, 'a Daily Climb took a Quick Start')
  assertEqual(first.meta.modifierIds.length, 2)
})

check('the menu preview rolls the same modifiers the climb uses', () => {
  const preview = rollDailyModifiers(createRng(seedFromString(dailySeedText(day)))).modifiers.map(({ id }) => id)
  assertDeepEqual(preview, first.meta.modifierIds)
})

check('a climb is won once the Act III boss falls', () => {
  assertDeepEqual([0, 1, 2, 3, 4].map(dailyClimbResult), [
    { won: false, label: 'Fell in Act I' }, { won: false, label: 'Fell in Act II' }, { won: false, label: 'Fell in Act III' },
    { won: true, label: 'Victory' }, { won: true, label: 'Victory · Act IV' },
  ])
})

check('another day deals another climb', () => {
  const other = createRun(1, party, 0, fresh, false, false, { mode: 'daily', dailyDate: '2026-09-29' })
  assert(JSON.stringify(other.map) !== JSON.stringify(first.map), 'two days produced the same map')
})

check('a climb may continue into Act IV on the unlocked baseline', () => {
  assertEqual(first.campaignProgress.actIV, 5)
  assert(Object.values(first.map.rooms).some((room) => room.burning), 'the Act IV Burning Elite is missing')
})

check('the run number still follows the player journal', () => {
  assertEqual(second.campaign.runId, 'campaign-41')
})

check('a finished climb awards no campaign marks', () => {
  const finished = finishRun({ ...second, phase: 'defeat' })
  assertEqual(finished.campaign.finalized, true)
  assertDeepEqual(finished.campaignProgress, second.campaignProgress)
})

check('a Daily Climb needs its day and exactly one player', () => {
  assertThrows(() => createRun(1, party, 0, fresh, false, false, { mode: 'daily' }))
  assertThrows(() => createRun(1, [...party, { id: 'p2', name: 'Silent', character: 'silent' }], 0, fresh, false, false,
    { mode: 'daily', dailyDate: day }))
})

check('standard runs still earn campaign marks', () => {
  const finished = finishRun({ ...createRun(123, party, 0, fresh), phase: 'defeat' })
  assertEqual(finished.campaignProgress.characters.ironclad, 1)
})

report('daily climb')
