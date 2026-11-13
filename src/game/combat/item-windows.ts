// Whether a held Relic or Potion has a legal manual activation right now. Kept apart
// from items.ts so start-turn.ts can ask without importing the code that resolves them.
import { activePowerWindow, mandatoryChoicePending } from './queries.ts'
import type { CombatState } from './types.ts'
import { cardDef, cardIsCurse } from '../cards.ts'
import { availableTransformRewards } from '../acquisition.ts'
import { chosenDieRelicAbilities, relicDef } from '../relics.ts'
import type { Player } from '../types.ts'
import { downfallRelicBaseId } from '../downfall/items.ts'

function publicHandCount(player: Player): number {
  return (player as Player & { handCount?: number }).handCount ?? player.hand.length
}

/** Whether a held Relic has a legal manual activation before choosing its targets. */
export function canActivateRelic(state: CombatState, player: Player, relicIndex: number): boolean {
  const held = player.relics[relicIndex]
  if (!held) return false
  const heldId = downfallRelicBaseId(held.defId)
  // A pending Golden Eye scry blocks every player's manual Relic activation
  // (see the `pendingRelicScry` checks below and in `activateRelic`), so its
  // own dead owner must still be able to resolve it -- refusing them here
  // would freeze Relic activation for the whole table forever, even while
  // every other player stays alive.
  const ownScry = heldId === 'golden_eye' && state.pendingRelicScry?.playerId === player.id &&
    state.pendingRelicScry.relicIndex === relicIndex
  if ((player.dead && !ownScry) || state.pendingDistilled || state.startTurnProgress?.forcedCard ||
    mandatoryChoicePending(state) ||
    (state.pendingTriggers?.length ?? 0) > 0 || !activePowerWindow(state)) return false
  const def = relicDef(held.defId)
  const reroute = ['dollys_mirror', 'nilrys_codex', 'loaded_die'].includes(heldId)
  const oncePerRoll = reroute || heldId === 'charons_ashes'
  const manual = Boolean(def.activation) || oncePerRoll || heldId === 'holy_water'
  const postRoll = oncePerRoll || ['gambling_chip', 'the_abacus', 'toolbox', 'fuel_canister'].includes(heldId)
  if (!manual || held.spent || heldId === 'the_courier' ||
    postRoll && (state.phase !== 'start' || state.startTurnProgress)) return false
  if (state.pendingRelicScry) return ownScry
  if (heldId === 'centennial_puzzle' && !player.lostHpThisCombat ||
    heldId === 'mummified_hand' && !player.powerPlayedThisTurn ||
    heldId === 'red_skull' && !player.shuffledThisCombat ||
    heldId === 'self_forming_clay' && !player.lostHpThisCombat ||
    heldId === 'holy_water' && (held.cubes ?? 0) < 1 ||
    heldId === 'charons_ashes' && (state.die > 2 || publicHandCount(player) === 0) ||
    heldId === 'dollys_mirror' && state.die !== 1 ||
    heldId === 'nilrys_codex' && state.die !== (held.defId === 'downfall_nilrys_codex' ? 2 : 4) ||
    heldId === 'loaded_die' && state.die !== 6) return false
  if (heldId === 'fuel_canister' && (!state.die || state.die > 2 || publicHandCount(player) === 0) ||
    heldId === 'makeshift_battery' && !player.hand.some((card) =>
      cardDef(card.defId).type === 'status' || cardIsCurse(card.defId)) ||
    heldId === 'unceasing_top' && publicHandCount(player) > 1 ||
    heldId === 'the_broken_seal' && player.exhaust.length < 2 ||
    heldId === 'shuriken' && (player.attacksPlayedThisTurn ?? 0) < 3 ||
    heldId === 'shot_glass' && player.potions.length === 0 ||
    heldId === 'thimble_helm' && player.energy < 1) return false
  if (reroute) {
    const face = heldId === 'nilrys_codex' ? 2 : null
    return state.players.some((owner) => !owner.dead && owner.relics.some((target, targetRelicIndex) =>
      chosenDieRelicAbilities(relicDef(target.defId)).some((ability) => ability.trigger.kind === 'dieRelic' &&
        (face === null || ability.trigger.faces.includes(face)) &&
        (!['nilrys_codex', 'loaded_die'].includes(heldId) || owner.id !== player.id || targetRelicIndex !== relicIndex))))
  }
  return true
}

/** Whether a held Potion has a legal activation window or required source card. */
export function canActivatePotion(state: CombatState, player: Player, potionId: string): boolean {
  if (player.dead || !player.potions.includes(potionId) || state.startTurnProgress?.forcedCard ||
    mandatoryChoicePending(state) ||
    (state.pendingTriggers?.length ?? 0) > 0 || potionId === 'fairy_in_a_bottle') return false
  if (potionId === 'gamblers_brew') return state.phase === 'start' &&
    !state.startTurnProgress?.beforeDraw && !state.startTurnProgress?.rollPending &&
    !state.startTurnProgress?.pauseAfterDraw && !state.startTurnProgress?.discard
  return state.phase === 'player' &&
    (potionId !== 'liquid_memories' || player.discard.length > 0) &&
    (potionId !== 'liquid_void' || player.exhaust.length > 0) &&
    (potionId !== 'transforming_brew' || player.hand.some((card) => !cardIsCurse(card.defId)) &&
      availableTransformRewards(player) > 0)
}
