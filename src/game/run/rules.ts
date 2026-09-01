// Small rules the whole run consults: what an ascension level changes, what a
// daily modifier turns on, what a character's HP starts at, whether a player
// already holds a relic, whether a victory ends the campaign, and where the
// next unique id comes from.
//
// Every function here answers a question about the state it is handed, or makes
// one bounded change to it. Nothing here opens a room or hands out a reward.
import type { RunPhase, RunState } from './types.ts'
import { canEnterActIV } from '../campaign.ts'
import type { CampaignProgress, SpireKeys } from '../campaign.ts'
import { CARDS } from '../cards.ts'
import type { DailyModifierId } from '../meta.ts'
import type { CardInstance, CharacterId, Player } from '../types.ts'

export const hasPendingRelicAcquisition = (state: {
  players: readonly { relics: readonly { pending?: boolean }[] }[]
  pendingGuardianSockets?: readonly unknown[]
}): boolean =>
  state.players.some((player) => player.relics.some((relic) => relic.pending)) ||
  (state.pendingGuardianSockets?.length ?? 0) > 0

export const hasModifier = (state: Pick<RunState, 'meta'>, id: DailyModifierId): boolean =>
  state.meta?.modifierIds?.includes(id) === true

export const canUpgradeCard = (card: Pick<CardInstance, 'defId' | 'upgraded'>): boolean =>
  !card.upgraded && CARDS[card.defId]?.upgrade !== undefined

export const ASCENSION_RULES = [
  'Standard rules',
  'A1: harder elites',
  'A2: lose 1 maximum HP',
  'A3: harder Events',
  'A4: Potion limit 2',
  "A5: add Ascender's Bane",
  'A6: heal 4 HP between Acts',
  'A7: harder encounters',
  'A8: Merchant removal costs 4',
  'A9: start 1 HP damaged',
  'A10: harder bosses',
  'A11: harder Act IV',
  'A12: harder elites',
  'A13: fight two different Act III bosses',
] as const

/** Two physical Tickets are shuffled into every character reward deck. */
export const GOLDEN_TICKET = 'golden_ticket'

/** Max HP per character. Not printed in the rulebook — these come from the boards. */
export const MAX_HP: Record<CharacterId, number> = {
  ironclad: 10,
  silent: 9,
  defect: 9,
  watcher: 9,
  slime_boss: 9,
  guardian: 9,
  hexaghost: 9,
  hermit: 8,
}

export function nextRunUid(players: readonly Player[]): number {
  return Math.max(0, ...players.flatMap((player) => player.deck.map((card) =>
    Number(/^c(\d+)$/.exec(card.uid)?.[1] ?? 0)))) + 1
}

export function hasRelic(player: Player, defId: string): boolean {
  return player.relics.some((relic) => relic.defId === defId)
}

export function applyDeadlyEvent(before: RunState, after: RunState): RunState {
  if (!hasModifier(before, 'deadly_events') || after.roomState?.kind === 'event' || after.phase === 'combat') return after
  const players = after.players.map((player) => {
    if (player.dead) return player
    const hp = Math.max(0, player.hp - 2)
    return { ...player, hp, dead: hp === 0 }
  })
  return players.some((player) => player.dead)
    ? { ...after, phase: 'defeat', players, combat: null, roomState: null, eventCombat: null, rewards: [], rewardDestination: null, log: [...after.log, 'Deadly Events defeats the party.'] }
    : { ...after, players, log: [...after.log, 'Deadly Events: each player loses 2 HP.'] }
}

export function victoryIsTerminal(state: {
  phase: RunPhase
  act: number
  lastStand: boolean
  players: readonly { dead: boolean }[]
  campaign: { finalized: boolean; keys: SpireKeys }
}, campaignProgress: Pick<CampaignProgress, 'actIV'>): boolean {
  if (state.phase !== 'victory') return false
  if (state.campaign.finalized || state.act >= 4 || state.lastStand && state.players.some((player) => player.dead)) return true
  return state.act >= 3 && !canEnterActIV(campaignProgress, state.campaign.keys, state.act)
}
