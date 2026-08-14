/** Official v2.30 rulebook achievements (p.21), in printed column order. */
export const ACHIEVEMENTS = [
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
] as const

export type AchievementId = (typeof ACHIEVEMENTS)[number]['id']

const achievementIds: ReadonlySet<string> = new Set(ACHIEVEMENTS.map(({ id }) => id))
const isAchievementId = (value: unknown): value is AchievementId =>
  typeof value === 'string' && achievementIds.has(value)

/** Normalize untrusted persisted data to a unique, deterministic set. */
export function normalizeAchievementIds(value: unknown): AchievementId[] {
  if (!Array.isArray(value)) return []
  const saved = new Set(value.filter(isAchievementId))
  return ACHIEVEMENTS.flatMap(({ id }) => saved.has(id) ? [id] : [])
}

/** Idempotently set a manually controlled achievement checkbox. */
export function setAchievementCompleted(value: unknown, id: AchievementId, completed: boolean): AchievementId[] {
  const saved = new Set(normalizeAchievementIds(value))
  if (completed) saved.add(id)
  else saved.delete(id)
  return normalizeAchievementIds([...saved])
}
