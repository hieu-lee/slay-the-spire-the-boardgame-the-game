import {
  ACHIEVEMENTS,
  normalizeAchievementIds,
  setAchievementCompleted,
} from '../src/game/achievements.ts'
import { suite, check, assertDeepEqual, assertEqual, report } from './lib/harness.mjs'

suite('achievements')

check('the catalog exactly matches all 19 official v2.30 achievements', () => {
  assertDeepEqual(ACHIEVEMENTS, [
    { id: 'jaxxed', name: 'Jaxxed', text: 'Hit the Strength limit (8).' },
    { id: 'catalyst', name: 'Catalyst', text: 'Hit the Poison limit (30).' },
    { id: 'ninja', name: 'Ninja', text: 'Play 7 Shivs in one turn.' },
    { id: 'powerful', name: 'Powerful', text: 'Have 7 Powers in play at once.' },
    { id: 'barricaded', name: 'Barricaded', text: 'Hit the Block limit (20).' },
    { id: 'you_are_nothing', name: 'You are Nothing', text: 'Defeat a Boss on turn 1.' },
    { id: 'all_for_one', name: 'All for One', text: 'Beat Act III with 4 players.' },
    { id: 'perfect', name: 'Perfect', text: 'Beat a Boss with all players at full HP.' },
    { id: 'minimalist', name: 'Minimalist', text: 'Beat Act III with a 5 card deck or smaller.' },
    { id: 'the_transient', name: 'The Transient', text: 'Kill The Transient before it kills itself.' },
    { id: 'common_sense', name: 'Common Sense', text: 'Beat Act III with a deck containing no uncommons or rares.' },
    { id: 'collector', name: 'Collector', text: 'Beat Act III with 12 relics and Boss relics combined per player.' },
    { id: 'ruby', name: 'Ruby', text: 'Beat Act III with the Ironclad.' },
    { id: 'emerald', name: 'Emerald', text: 'Beat Act III with the Silent.' },
    { id: 'sapphire', name: 'Sapphire', text: 'Beat Act III with the Defect.' },
    { id: 'amethyst', name: 'Amethyst', text: 'Beat Act III with the Watcher.' },
    { id: 'my_lucky_day', name: 'My Lucky Day', text: 'Beat Act III with a Daily Climb.' },
    { id: 'infinity', name: 'Infinity', text: 'Create an infinite card combo.', manual: true },
    { id: 'who_needs_relics', name: 'Who Needs Relics?', text: 'Beat Act III with no relics or Boss relics (you can skip items).' },
  ])
  assertEqual(new Set(ACHIEVEMENTS.map(({ id }) => id)).size, 19)
})

check('persisted completion normalizes unknown, duplicate, and unordered values', () => {
  assertDeepEqual(normalizeAchievementIds(null), [])
  assertDeepEqual(normalizeAchievementIds({}), [])
  assertDeepEqual(normalizeAchievementIds(['ruby', 'bogus', 'jaxxed', 'ruby', 7]), ['jaxxed', 'ruby'])
})

check('manual completion writes are immutable and idempotent', () => {
  const saved = ['ruby']
  const completed = setAchievementCompleted(saved, 'infinity', true)
  assertDeepEqual(saved, ['ruby'])
  assertDeepEqual(completed, ['ruby', 'infinity'])
  assertDeepEqual(setAchievementCompleted(completed, 'infinity', true), completed)
  const cleared = setAchievementCompleted(completed, 'infinity', false)
  assertDeepEqual(cleared, ['ruby'])
  assertDeepEqual(setAchievementCompleted(cleared, 'infinity', false), cleared)
})

report('achievements')
