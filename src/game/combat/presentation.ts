// The animation feed. The engine records what it just did — who acted, on whom,
// with what — so a client can replay a turn it did not resolve itself.
//
// Presentation only: dropping every event here would change nothing about who
// wins, which is why the list is capped rather than kept whole.
import { lightningRowFromTarget, resolveEnemyTargets } from './board.ts'
import type {
  CombatPresentationEvent,
  CombatState,
  NewPresentationEvent,
  PresentationContext,
  PresentationTargets,
} from './types.ts'
import type { TargetScope } from '../cards.ts'

const PRESENTATION_EVENT_LIMIT = 12

export function presentationTargets(
  state: CombatState,
  actorId: string,
  enemyScope: TargetScope,
  supportScope: TargetScope,
  context: PresentationContext,
): Pick<PresentationTargets, 'enemyIds' | 'playerIds' | 'enemyRow'> {
  const scopedEnemies = ['enemy', 'row', 'allEnemies'].includes(enemyScope)
    ? resolveEnemyTargets(state, enemyScope, context.enemyUid ?? null, context.enemyRow)
    : []
  const evokeEnemies = (context.evokeEnemyUids ?? []).flatMap((id) => {
    if (typeof id !== 'string') return []
    const row = lightningRowFromTarget(id)
    return row === null ? [id] : resolveEnemyTargets(state, 'row', null, row).map((enemy) => enemy.uid)
  })
  const enemyIds = [...new Set([
    ...scopedEnemies.map((enemy) => enemy.uid),
    ...(context.enemyUids ?? []),
    ...(context.shivEnemyUids ?? []),
    ...evokeEnemies,
  ].filter((id): id is string => typeof id === 'string'))]
  const scopedPlayers = supportScope === 'allPlayers'
    ? state.players.filter((player) => !player.dead).map((player) => player.id)
    : supportScope === 'anyPlayer' ? [context.playerId ?? actorId] : []
  const playerIds = [...new Set([
    ...scopedPlayers,
    ...(context.playerIds ?? []),
    context.switchWithPlayerId,
  ].filter((id): id is string => typeof id === 'string' && id !== actorId))]
  const enemyRow = typeof context.enemyRow === 'number' && Number.isInteger(context.enemyRow)
    ? context.enemyRow
    : state.enemies.find((enemy) => enemy.uid === context.enemyUid)?.row
  return {
    enemyIds,
    playerIds,
    ...(enemyScope === 'row' && enemyRow !== undefined ? { enemyRow } : {}),
  }
}

export function addPresentationEvent(
  state: CombatState,
  event: NewPresentationEvent,
): void {
  const events = state.presentationEvents ?? []
  const added = {
    seq: (events.at(-1)?.seq ?? 0) + 1,
    ...event,
  } as CombatPresentationEvent
  state.presentationEvents = [...events, added].slice(-PRESENTATION_EVENT_LIMIT)
}
