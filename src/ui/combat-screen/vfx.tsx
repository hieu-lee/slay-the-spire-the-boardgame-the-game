// The visual effect a play puts on the board.
//
// An authoritative presentation event says who acted, on whom, and with what;
// this turns that into the overlay both the actor and the target render, and
// works out when a weapon is supposed to make contact.
import type { ActiveCombatVfx } from './types.ts'
import { cardDef } from '../../game/cards.ts'
import type { CombatPresentationEvent, CombatState } from '../../game/combat.ts'
import { cardVfxRecipe, shivVfxRecipe, vfxAssetPath, vfxToneColor } from '../combat-vfx.ts'

const OFFENSIVE_VFX_FAMILIES = new Set([
  'slash', 'blunt', 'projectile', 'shiv', 'lightning', 'frost', 'dark',
])

/**
 * How far apart consecutive end-of-turn orb reveals land, in ms.
 *
 * The engine resolves every ordered orb before the client sees any of it, so
 * two or three orbs can arrive in the SAME state update — with nothing here,
 * they would all flash on the same frame, one burst standing in for however
 * many orbs actually fired. `usePresentationEvents` extends each such event's
 * lifetime by this much per sibling ahead of it in the same arrival batch, and
 * CombatScreen delays its reveal by the same amount, so they read as separate
 * beats — zap, pause, zap — rather than one.
 */
export const ORB_END_TURN_STAGGER_MS = 380

export const isCharacterAttack = ({ event, recipe }: ActiveCombatVfx): boolean =>
  event.kind !== 'potion' && event.kind !== 'orb' && event.enemyIds.length > 0 &&
  (event.kind === 'shiv' || cardDef(event.sourceId).type === 'attack' || OFFENSIVE_VFX_FAMILIES.has(recipe.family))

export function characterAttackContactMs(
  state: CombatState,
  targetId: string,
  event?: CombatPresentationEvent,
): number {
  if (!event || event.kind === 'potion' || event.kind === 'orb' || !event.enemyIds.includes(targetId)) return 0
  const actor = state.players.find((player) => player.id === event.actorId)
  if (!actor) return 0
  const active = {
    event,
    recipe: event.kind === 'shiv'
      ? shivVfxRecipe()
      : cardVfxRecipe(actor.character, event.sourceId, event.mode, event.upgraded),
  }
  if (!isCharacterAttack(active)) return 0
  const targetIndex = Math.max(0, event.enemyIds.indexOf(targetId))
  if (actor.character === 'silent') return 400 + targetIndex * 70
  if (actor.character === 'defect') return 1_110 + targetIndex * 70
  if (actor.character === 'watcher') return 1_050 + targetIndex * 70
  return 630
}

export function latestTargetPresentationEvent(
  events: readonly CombatPresentationEvent[] | undefined,
  targetId: string,
): CombatPresentationEvent | undefined {
  for (let index = (events?.length ?? 0) - 1; index >= 0; index--) {
    const event = events![index]!
    if (event.enemyIds.includes(targetId) || event.playerIds.includes(targetId)) return event
  }
  return undefined
}

export function CombatVfx({
  active,
  role,
  attackContactMs = 0,
  revealDelayMs = 0,
}: {
  active: ActiveCombatVfx
  role: 'actor' | 'target'
  attackContactMs?: number
  /** Staggers this event's own reveal behind an earlier one in the same
   * state update — see CombatScreen's `orbEndTurnRevealDelayMs`. */
  revealDelayMs?: number
}) {
  const { event, recipe } = active

  return (
    <span
      className={[
        'combat-vfx', `combat-vfx--${role}`, `combat-vfx--${recipe.family}`,
        role === 'target' && attackContactMs > 0 ? 'combat-vfx--attack-impact' : '',
      ].filter(Boolean).join(' ')}
      data-vfx-seq={event.seq}
      data-vfx-kind={event.kind}
      data-vfx-source={event.sourceId}
      data-vfx-family={recipe.family}
      data-vfx-motion={recipe.actorMotion}
      data-vfx-asset={recipe.asset}
      data-vfx-tone={recipe.tone}
      style={{
        '--vfx-image': `url("${vfxAssetPath(recipe)}")`,
        '--vfx-tone-color': vfxToneColor(recipe.tone),
        ...(attackContactMs > 0 ? { '--attack-impact-delay': `${attackContactMs}ms` } : {}),
        ...(revealDelayMs > 0 ? { '--vfx-reveal-delay': `${revealDelayMs}ms` } : {}),
      } as React.CSSProperties}
      aria-hidden="true"
    />
  )
}
