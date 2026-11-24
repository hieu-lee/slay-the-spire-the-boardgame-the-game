// Turn-effect presentation helpers and die-relic party scaling.
//
// Pure leaf helpers used by effect resolution and turn transitions to publish
// structured presentation events without forming cycles back into `effects.ts`.
import { addPresentationEvent } from './presentation.ts'
import { conditionIsActive, effectIsActive } from './queries.ts'
import type { CombatState, PlayContext, TurnEffectPresentation } from './types.ts'
import type { Effect } from '../cards.ts'
import type { Player } from '../types.ts'

export const TURN_PRESENTATION_TRIGGERS = new Set(['startOfCombat', 'beforeDraw', 'startOfTurn', 'dieRelic', 'endOfTurn'])

export function dieRelicNeedsOwnerChoice(effects: readonly Effect[]): boolean {
  return effects.some((effect) => effect.kind === 'discard' || effect.kind === 'exhaustFromHand')
}

export function publishTurnEffect(
  state: CombatState,
  actorId: string,
  sourceId: string,
  effect: TurnEffectPresentation,
  targets: {
    actorTargeted?: boolean
    enemyIds?: string[]
    playerIds?: string[]
    enemyRow?: number
  } = {},
): void {
  addPresentationEvent(state, {
    kind: 'turn', effect,
    actorTargeted: targets.actorTargeted ?? false,
    actorId, sourceId,
    enemyIds: targets.enemyIds ?? [],
    playerIds: targets.playerIds ?? [],
    ...(targets.enemyRow === undefined ? {} : { enemyRow: targets.enemyRow }),
  })
}

export function markTurnEffect(
  context: PlayContext | undefined,
  effect: TurnEffectPresentation,
  target: { actor?: boolean; enemyId?: string; playerId?: string } = {},
): void {
  const applications = context?.turnEffectApplications
  if (!applications) return
  let applied = applications.find((candidate) => candidate.effect === effect)
  if (!applied) applications.push(applied = { effect })
  if (target.actor) applied.actorTargeted = true
  if (target.enemyId && !(applied.enemyIds ??= []).includes(target.enemyId)) applied.enemyIds.push(target.enemyId)
  if (target.playerId && !(applied.playerIds ??= []).includes(target.playerId)) applied.playerIds.push(target.playerId)
}

export function publishTurnEffectApplications(
  state: CombatState,
  actorId: string,
  sourceId: string,
  applications: NonNullable<PlayContext['turnEffectApplications']>,
): void {
  for (const applied of applications) {
    publishTurnEffect(state, actorId, sourceId, applied.effect, {
      actorTargeted: applied.actorTargeted,
      enemyIds: applied.enemyIds,
      playerIds: applied.playerIds,
    })
  }
}

export function activeTurnEffectLeaves(
  effects: readonly Effect[],
  state: CombatState,
  actor: Player,
): Effect[] {
  return effects.flatMap((effect): Effect[] => {
    if (!effectIsActive(effect, state, actor)) return []
    if (effect.kind === 'sequence') return effect.guardianAction || effect.guardianGemId
      ? [effect]
      : activeTurnEffectLeaves(effect.effects, state, actor)
    if (effect.kind === 'branch') return activeTurnEffectLeaves(
      conditionIsActive(effect.condition, state, actor) ? effect.effects : effect.otherwise,
      state,
      actor,
    )
    return [effect]
  })
}

export function dieRelicEffectsForParty(
  relicDefId: string,
  effects: readonly Effect[],
  playerCount: number,
): readonly Effect[] {
  return relicDefId === 'tungsten_rod' && playerCount === 1
    ? effects.map((effect) => effect.kind === 'block' ? { ...effect, amount: 3 } : effect)
    : effects
}
