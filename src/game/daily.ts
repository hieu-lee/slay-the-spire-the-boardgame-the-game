// The Daily Climb: one shared seed per UTC day, played at a fixed Ascension
// with every unlock available, so the same hero sees the same opening run.

import { ACT_IV_UNLOCK_BOXES, CHARACTER_UNLOCK_BOXES, COLORLESS_UNLOCK, MAX_ASCENSION } from './campaign.ts'
import type { CampaignProgress } from './campaign.ts'
import { CHARACTER_IDS } from './types.ts'
import type { CharacterId } from './types.ts'

export const DAILY_ASCENSION = 10

/** `date` is the UTC calendar day as `YYYY-MM-DD`; the clock is read outside the engine. */
export function dailySeedText(date: string): string {
  return `daily-climb:${date}`
}

/**
 * The progress a Daily Climb is built from. Campaign unlocks change which
 * cards and rooms the seed deals, so every player uses the same fully
 * unlocked baseline; only the run number follows the player's own journal.
 */
export function dailyCampaignProgress(progress: CampaignProgress): CampaignProgress {
  return {
    version: 1,
    characters: Object.fromEntries(CHARACTER_IDS.map((id) => [id, CHARACTER_UNLOCK_BOXES])) as Record<CharacterId, number>,
    colorless: COLORLESS_UNLOCK.boxes,
    actIV: ACT_IV_UNLOCK_BOXES,
    unspentMarks: 0,
    highestAscension: MAX_ASCENSION,
    nextRunNumber: progress.nextRunNumber,
    finishedRunIds: [],
  }
}

const ACTS = ['I', 'II', 'III'] as const

/** A climb is won once the Act III boss falls; otherwise it ended in the Act after its last boss. */
export function dailyClimbResult(highestBossActDefeated: number): { won: boolean; label: string } {
  if (highestBossActDefeated >= 4) return { won: true, label: 'Victory · Act IV' }
  if (highestBossActDefeated >= 3) return { won: true, label: 'Victory' }
  return { won: false, label: `Fell in Act ${ACTS[Math.max(0, highestBossActDefeated)]}` }
}
