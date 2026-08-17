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

/**
 * Which flinch class to use this time.
 *
 * A CSS animation only restarts when the computed animation-name changes, so
 * two hits on the same target inside the window produced one flinch. The two
 * classes name different keyframes; alternating between them makes every blow
 * land visibly.
 */
export function strikeClass(base: 'seat' | 'enemy', beat: number): string {
  return beat % 2 === 0 ? `${base}--struck` : `${base}--struck-alt`
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
