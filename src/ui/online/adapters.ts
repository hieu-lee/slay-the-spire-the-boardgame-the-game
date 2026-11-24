import { cardDef } from '../../game/cards.ts'
import type { CombatState } from '../../game/combat.ts'
import type { Room } from '../../game/map.ts'
import type { Player } from '../../game/types.ts'
import type { VisibleCombat, VisiblePlayer } from '../../multiplayer/useRoomSession.ts'
import type { SummarySeat } from '../RunSummary.tsx'

export function playerForUi(player: VisiblePlayer): Player {
  return {
    ...player,
    deck: player.deck ?? [],
    draw: player.draw ?? [],
    hand: player.hand ?? [],
    chamber: player.chamber ?? [],
    cardRewards: [],
    rareRewards: [],
  }
}

/**
 * A seat for the end-of-run summary.
 *
 * `deck` is left undefined rather than defaulted to `[]`: the server sends only
 * the local seat's deck, and an empty array would render every teammate as
 * "0 cards" with no build — a confident lie. Undefined makes the summary omit
 * those lines for seats it cannot see.
 */
export function onlineSummarySeat(player: VisiblePlayer): SummarySeat {
  return {
    id: player.id,
    name: player.name,
    character: player.character,
    hp: player.hp,
    maxHp: player.maxHp,
    gold: player.gold,
    dead: player.dead,
    relics: player.relics,
    damageStats: player.damageStats,
    deck: player.deck ?? undefined,
  }
}

export function pendingCardCopyLabel(copy: NonNullable<VisibleCombat['pendingCardCopy']>): string {
  const name = cardDef(copy.card.defId).name
  const source = copy.sourceNames[0]
  return copy.sourceNames.length > 1
    ? `a ${name} copy (${source})`
    : copy.card.scryDamageBonus !== undefined
      ? `Scry-played ${name}`
      : copy.virtualOnly
        ? `a ${name} copy (${source})`
        : `the original ${name} after a ${source} copy`
}

export function choices(map: { position: string | null; rows: string[][]; rooms: Record<string, Room> }): Room[] {
  if (map.position === null) {
    const id = map.rows[0]?.[0]
    return id && map.rooms[id] ? [map.rooms[id]] : []
  }
  return map.rooms[map.position]?.exits
    .map((id) => map.rooms[id])
    .filter((room): room is Room => room !== undefined) ?? []
}

export function wingChoices(map: { position: string | null; rows: string[][]; rooms: Record<string, Room> }, player?: VisiblePlayer): Room[] {
  if (!player?.relics.some((relic) => relic.defId === 'wing_boots' && (relic.uses ?? 0) > 0) || map.position === null) return []
  const current = map.rooms[map.position]
  if (!current) return []
  const normal = new Set(current.exits)
  return (map.rows[current.row + 1] ?? []).filter((id) => !normal.has(id)).map((id) => map.rooms[id])
    .filter((room): room is Room => room !== undefined)
}

export function combatForUi(
  visibleCombat: VisibleCombat,
  viewerId: string | undefined,
  asyncPlayerTurn: boolean,
): CombatState {
  const visibleProgress = visibleCombat.startTurnProgress
  return {
    ...visibleCombat,
    startTurnProgress: visibleProgress ? {
      ...visibleProgress,
      forcedCard: asyncPlayerTurn && visibleProgress.forcedCard?.playerId !== viewerId
        ? undefined : visibleProgress.forcedCard,
    } : undefined,
    pendingCardCopy: asyncPlayerTurn && visibleCombat.pendingCardCopy?.playerId !== viewerId
      ? undefined : visibleCombat.pendingCardCopy,
    pendingTriggers: asyncPlayerTurn || visibleCombat.phase === 'start'
      ? visibleCombat.pendingTriggers.filter((trigger) => trigger.playerId === viewerId)
      : visibleCombat.pendingTriggers,
    pendingPlunderSwitches: asyncPlayerTurn
      ? visibleCombat.pendingPlunderSwitches?.filter((choice) => choice.playerId === viewerId)
      : visibleCombat.pendingPlunderSwitches,
    pendingDieRelicChoices: asyncPlayerTurn
      ? visibleCombat.pendingDieRelicChoices?.filter((choice) => choice.playerId === viewerId)
      : visibleCombat.pendingDieRelicChoices,
    pendingHermitSetupLoads: asyncPlayerTurn
      ? visibleCombat.pendingHermitSetupLoads?.filter((choice) => choice.playerId === viewerId)
      : visibleCombat.pendingHermitSetupLoads,
    pendingHermitChamberPlays: asyncPlayerTurn
      ? visibleCombat.pendingHermitChamberPlays?.filter((choice) => choice.playerId === viewerId)
      : visibleCombat.pendingHermitChamberPlays,
    pendingHermitStrengthRewards: asyncPlayerTurn
      ? visibleCombat.pendingHermitStrengthRewards?.filter((choice) => choice.playerId === viewerId)
      : visibleCombat.pendingHermitStrengthRewards,
    // Slayer Pack: another seat's card choice never blocks this seat's Player Turn.
    pendingPlayerChoices: asyncPlayerTurn
      ? visibleCombat.pendingPlayerChoices?.filter((choice) => choice.playerId === viewerId)
      : visibleCombat.pendingPlayerChoices,
    pendingSlayerChoices: asyncPlayerTurn
      ? visibleCombat.pendingSlayerChoices?.filter((choice) => choice.playerId === viewerId)
      : visibleCombat.pendingSlayerChoices,
    rng: { seed: 0, calls: 0 },
    discardedThisTurn: [],
    stanceChangedThisTurn: [],
    playedCardsThisTurn: visibleCombat.playedCardsThisTurn ?? [],
    potionDeck: [],
    potionLimit: visibleCombat.potionLimit,
    lastStand: visibleCombat.lastStand,
    summonSupply: {},
    pendingSummons: visibleCombat.pendingSummons ?? [],
    pendingDistilled: visibleCombat.pendingDistilled &&
    (!asyncPlayerTurn || visibleCombat.pendingDistilled.playerId === viewerId) ? {
      ...visibleCombat.pendingDistilled,
      cards: visibleCombat.pendingDistilled.cards ?? [],
    } : undefined,
    pendingRelicScry: visibleCombat.pendingRelicScry &&
    (!asyncPlayerTurn || visibleCombat.pendingRelicScry.playerId === viewerId) ? {
      ...visibleCombat.pendingRelicScry,
      cards: visibleCombat.pendingRelicScry.cards ?? [],
    } : undefined,
    players: visibleCombat.players.map(playerForUi),
  }
}
