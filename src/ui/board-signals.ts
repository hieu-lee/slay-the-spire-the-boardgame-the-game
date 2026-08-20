// Pure helpers that decide how the board SIGNALS a change, kept out of the
// component files so a plain Node check can import them — a .tsx module cannot
// be loaded by the verify scripts, which is why these went untested for so long.
import type { CombatState } from '../game/combat.ts'
import type { CardInstance, Player } from '../game/types.ts'

/**
 * Which band a health bar is in.
 *
 * Three named bands rather than a continuous hue, so the colour is a signal a
 * player can learn rather than a gradient they have to interpret. A boundary
 * value falls to the LOWER band: at exactly 60% you are already hurt.
 */
export function healthBand(hp: number, maxHp: number): 'healthy' | 'hurt' | 'critical' {
  const fraction = maxHp === 0 ? 0 : hp / maxHp
  if (fraction > 0.6) return 'healthy'
  if (fraction > 0.3) return 'hurt'
  return 'critical'
}

/** Stage geometry at full size, in rem: actor pitch, then the slack either end. */
export const STAGE_GAP_REM = 10
export const STAGE_MARGIN_REM = 4
/** Below this a card stops being readable, so the board scrolls instead. */
export const MIN_STAGE_SCALE = 0.66

/**
 * How far to shrink the stage so its actors fit the board.
 *
 * The stage is one line, so its width grows with the party AND with every
 * summon: a Slime Boss splitting in front of four players puts 17 actors on it.
 * Scaling the whole stage keeps them on one floor and stops the auto-scroll from
 * having to choose between showing a player their own character and showing them
 * what they are fighting.
 */
export function stageScaleFor(actors: number, boardWidthPx: number, remPx: number): number {
  const needed = (actors * STAGE_GAP_REM + STAGE_MARGIN_REM) * remPx
  if (actors <= 0 || needed <= 0 || boardWidthPx <= 0) return 1
  return Math.min(1, Math.max(MIN_STAGE_SCALE, boardWidthPx / needed))
}

export function pendingUiSurvivesContext(
  phase: CombatState['phase'],
  copyPlayerId: string | undefined,
  viewerId: string,
): boolean {
  return phase === 'copy' && copyPlayerId === viewerId
}

/** Cards newly visible in a hand, in their dealt order. */
export function drawnCardUids(
  before: readonly CardInstance[],
  after: readonly CardInstance[],
): string[] {
  const held = new Set(before.map((card) => card.uid))
  return after.filter((card) => !held.has(card.uid)).map((card) => card.uid)
}

export function shouldAnimateOnlineOpeningHand(
  previousPhase: string | undefined,
  phase: string | undefined,
  connected: boolean,
): boolean {
  return connected && phase === 'combat' && previousPhase !== undefined && previousPhase !== 'combat'
}

export function shouldDisarmCardFlight(cardInHand: boolean, committed: boolean): boolean {
  return cardInHand && !committed
}

/** Where a committed card visibly resolves after leaving the hand. */
export function cardMotionDestination(
  cardUid: string,
  player: Pick<Player, 'draw' | 'discard' | 'exhaust'>,
  returnsToDraw = false,
): 'draw' | 'discard' | 'exhaust' | 'stage' {
  if (player.exhaust.some((card) => card.uid === cardUid)) return 'exhaust'
  if (player.discard.some((card) => card.uid === cardUid)) return 'discard'
  if (player.draw.some((card) => card.uid === cardUid)) return 'draw'
  // Online snapshots deliberately redact the draw pile, so the public card
  // rule is the fallback for Anger/Tantrum after visible piles are checked.
  if (returnsToDraw) return 'draw'
  return 'stage'
}
