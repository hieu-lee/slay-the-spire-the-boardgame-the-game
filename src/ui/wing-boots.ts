/** Structural, so both the local player and the online viewer fit. */
type RelicHolder = { relics: readonly { defId: string; uses?: number }[] }

/** Printed uses left on this player's Wing Boots; 0 without them. */
export function wingBootUses(player: RelicHolder | null | undefined): number {
  return player?.relics.find((relic) => relic.defId === 'wing_boots')?.uses ?? 0
}
