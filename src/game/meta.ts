import { nextInt } from './rng.ts'
import type { RngState } from './rng.ts'

export type DieFace = 1 | 2 | 3 | 4 | 5 | 6
export type DailyModifierSection = 'upper' | 'lower'

export const DAILY_MODIFIERS = [
  { id: 'all_star', name: 'All Star', section: 'upper', roll: 1, rule: 'Each player starts with 5 random Colorless cards.' },
  { id: 'shiny', name: 'Shiny', section: 'upper', roll: 2, rule: 'Each player starts with 5 random rare cards.' },
  { id: 'heirloom', name: 'Heirloom', section: 'upper', roll: 3, rule: 'Each player starts with a random Boss relic.' },
  { id: 'transformed', name: 'Transformed', section: 'upper', roll: 4, rule: 'Normal card rewards become Transform a card.' },
  { id: 'vintage', name: 'Vintage', section: 'upper', roll: 5, rule: 'Normal card rewards from Encounters become relic rewards.' },
  { id: 'prismatic_shard', name: 'Prismatic Shard', section: 'upper', roll: 6, rule: 'Each player starts with Prismatic Shard. Normal rewards reveal 3 cards from 3 different chosen reward decks, optionally including Colorless; rare rewards reveal 3 cards from 3 different character rare decks.' },
  { id: 'terminal', name: 'Terminal', section: 'lower', roll: 1, rule: 'Each player loses 1 HP at the end of combat.' },
  { id: 'insanity', name: 'Insanity', section: 'lower', roll: 2, rule: 'At the end of combat, each player must Transform a random card in their deck.' },
  { id: 'uncertain_future', name: 'Uncertain Future', section: 'lower', roll: 3, rule: 'Map tokens remain face-down during setup and are revealed when the party lands on the room.' },
  { id: 'cursed', name: 'Cursed', section: 'lower', roll: 4, rule: 'Each player starts with 2 random Curses.' },
  { id: 'deadly_events', name: 'Deadly Events', section: 'lower', roll: 5, rule: 'Each player loses 2 HP after each Event.' },
  { id: 'night_terrors', name: 'Night Terrors', section: 'lower', roll: 6, rule: 'Players cannot Rest.' },
] as const

export type DailyModifier = (typeof DAILY_MODIFIERS)[number]
export type DailyModifierId = DailyModifier['id']

export type RunMode = 'standard' | 'daily' | 'custom'

export type RunMetaOptions = Readonly<{
  mode?: RunMode
  /** Custom Run choices. Daily choices are rolled authoritatively from the seed. */
  modifiers?: readonly DailyModifierId[]
  /** Act 1 is the ordinary setup; Acts 2–4 use the Quick Start table. */
  quickStartAct?: 1 | 2 | 3 | 4
}>

export type RunMetaState = Readonly<{
  mode: RunMode
  modifierIds: readonly DailyModifierId[]
}>

export const DAILY_MODIFIER_SECTIONS: Readonly<Record<DailyModifierSection, readonly DailyModifier[]>> = {
  upper: DAILY_MODIFIERS.slice(0, 6),
  lower: DAILY_MODIFIERS.slice(6),
}

export type DailyClimbRoll = Readonly<{
  rolls: readonly [DieFace, DieFace]
  modifiers: readonly [DailyModifier, DailyModifier]
}>

/** Rolls once on each of the two official Daily Climb modifier sections. */
export function rollDailyModifiers(rng: RngState): DailyClimbRoll {
  const upperIndex = nextInt(rng, 6)
  const lowerIndex = nextInt(rng, 6)
  return {
    rolls: [(upperIndex + 1) as DieFace, (lowerIndex + 1) as DieFace],
    modifiers: [DAILY_MODIFIER_SECTIONS.upper[upperIndex]!, DAILY_MODIFIER_SECTIONS.lower[lowerIndex]!],
  }
}

export type QuickStartAct = 2 | 3 | 4
export type QuickStartRewardKind =
  | 'neow'
  | 'gold'
  | 'cardReward'
  | 'transform'
  | 'rollDie'
  | 'potion'
  | 'relic'
  | 'rareReward'
  | 'bossRelic'
  | 'cardRemove'
  | 'upgrade'
  | 'merchant'

export type QuickStartStep = Readonly<{ kind: QuickStartRewardKind; count: number }>

export type QuickSetupState = {
  kind: 'quick-start' | 'catch-up'
  targetAct: QuickStartAct
  playerIds: string[]
  rowIndex: number
  repeatIndex: number
  playerIndex: number
  die: null | { value: DieFace; effectIndex: number }
}

const step = (kind: QuickStartRewardKind, count = 1): QuickStartStep => ({ kind, count })

/** Resolve one Act column from top to bottom without revealing later rewards early. */
export const QUICK_START_TABLE: Readonly<Record<QuickStartAct, readonly QuickStartStep[]>> = {
  2: [step('neow'), step('gold', 6), step('cardReward', 4), step('transform'), step('rollDie'), step('potion'), step('relic', 2), step('rareReward'), step('bossRelic'), step('upgrade', 2), step('merchant')],
  3: [step('neow'), step('gold', 7), step('cardReward', 4), step('transform'), step('rollDie', 3), step('potion'), step('relic', 4), step('rareReward', 2), step('bossRelic', 2), step('cardReward', 3), step('cardRemove'), step('upgrade', 4), step('merchant')],
  4: [step('neow'), step('gold', 10), step('cardReward', 5), step('transform'), step('rollDie', 5), step('potion'), step('relic', 6), step('rareReward', 2), step('bossRelic', 2), step('cardReward', 5), step('cardRemove', 2), step('upgrade', 6), step('merchant')],
}

/** Each die icon in Quick Start is rolled separately by each affected player. */
export const QUICK_START_DIE_REWARDS: Readonly<Record<DieFace, readonly QuickStartStep[]>> = {
  1: [step('relic')],
  2: [step('transform')],
  3: [step('cardReward'), step('gold')],
  4: [step('potion'), step('gold', 2)],
  5: [step('upgrade')],
  6: [step('cardRemove')],
}

export function normalizeModifierIds(value: unknown): DailyModifierId[] {
  if (!Array.isArray(value)) return []
  const selected = new Set(value.filter((entry): entry is DailyModifierId =>
    typeof entry === 'string' && DAILY_MODIFIERS.some(({ id }) => id === entry)))
  return DAILY_MODIFIERS.flatMap(({ id }) => selected.has(id) ? [id] : [])
}

export function currentQuickSetupStep(setup: QuickSetupState): QuickStartStep | null {
  const row = QUICK_START_TABLE[setup.targetAct][setup.rowIndex]
  if (!row) return null
  if (row.kind !== 'rollDie' || !setup.die) return row
  return QUICK_START_DIE_REWARDS[setup.die.value][setup.die.effectIndex] ?? null
}
