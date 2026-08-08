// Pure helpers that decide how the board SIGNALS a change, kept out of the
// component files so a plain Node check can import them — a .tsx module cannot
// be loaded by the verify scripts, which is why these went untested for so long.

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
