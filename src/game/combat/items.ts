// What a player can do on their turn without playing a card: spend a Miracle or
// a Shiv, and activate a Relic or a Potion.
//
// Each is its own atomic action with its own legality check, so the UI can offer
// exactly the ones the board currently allows.
import { clone, findPlayer, livingEnemies, resolveEnemyTargets, rowExists } from './board.ts'
import { applyEffect, damageEnemyLogged, discardByCardEffect, drawInto, exhaustCards, settle } from './effects.ts'
import { addPresentationEvent, presentationTargets } from './presentation.ts'
import { cardIsPlayable, overflowShivCount, reachedTimeWarpLimit, reachesEnemy } from './queries.ts'
import type { CombatState, PlayContext, PotionContext, RelicContext } from './types.ts'
import { cardDef, faceOf } from '../cards.ts'
import { gainBlock, gainStrength } from '../damage.ts'
import { scry } from '../piles.ts'
import { potionDef, relicAbilities, relicDef } from '../relics.ts'
import { nextInt } from '../rng.ts'
import { CAPS } from '../types.ts'
import type { Player } from '../types.ts'

/** Spend one Miracle for one Energy during the shared Player Turn (p.17). */
export function spendMiracle(state: CombatState, playerId: string): CombatState {
  if (state.phase !== 'player' || state.startTurnProgress?.forcedCard ||
    (state.pendingTriggers?.length ?? 0) > 0) return state
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (!player || player.dead || player.miracles < 1 || player.energy >= CAPS.energy) return state
  const next = clone(state)
  const actor = next.players.find((candidate) => candidate.id === playerId)!
  actor.miracles -= 1
  actor.energy += 1
  next.log = [...next.log, `${actor.name} spends a Miracle for 1 Energy`]
  return next
}

function publicHandCount(player: Player): number {
  return (player as Player & { handCount?: number }).handCount ?? player.hand.length
}

/** Whether a held Relic has a legal manual activation before choosing its targets. */
export function canActivateRelic(state: CombatState, player: Player, relicIndex: number): boolean {
  const held = player.relics[relicIndex]
  if (!held || player.dead || state.pendingDistilled || state.startTurnProgress?.forcedCard ||
    (state.pendingTriggers?.length ?? 0) > 0 || (state.phase !== 'player' && state.phase !== 'start')) return false
  const def = relicDef(held.defId)
  const reroute = ['dollys_mirror', 'nilrys_codex', 'loaded_die'].includes(held.defId)
  const oncePerRoll = reroute || held.defId === 'charons_ashes'
  const manual = Boolean(def.activation) || oncePerRoll || held.defId === 'holy_water'
  const postRoll = oncePerRoll || ['gambling_chip', 'the_abacus', 'toolbox'].includes(held.defId)
  if (!manual || held.spent || held.defId === 'the_courier' ||
    state.phase === 'start' && !postRoll || postRoll && (state.phase !== 'start' || state.startTurnProgress)) return false
  if (state.pendingRelicScry) return held.defId === 'golden_eye' &&
    state.pendingRelicScry.playerId === player.id && state.pendingRelicScry.relicIndex === relicIndex
  if (held.defId === 'centennial_puzzle' && !player.lostHpThisCombat ||
    held.defId === 'mummified_hand' && !player.powerPlayedThisTurn ||
    held.defId === 'red_skull' && !player.shuffledThisCombat ||
    held.defId === 'self_forming_clay' && !player.lostHpThisCombat ||
    held.defId === 'holy_water' && (held.cubes ?? 0) < 1 ||
    held.defId === 'charons_ashes' && (state.die > 2 || publicHandCount(player) === 0) ||
    held.defId === 'dollys_mirror' && state.die !== 1 ||
    held.defId === 'nilrys_codex' && state.die !== 4 ||
    held.defId === 'loaded_die' && state.die !== 6) return false
  if (reroute) {
    const face = held.defId === 'dollys_mirror' ? 1 : held.defId === 'nilrys_codex' ? 2 : null
    return state.players.some((owner) => !owner.dead && owner.relics.some((target, targetRelicIndex) =>
      relicAbilities(relicDef(target.defId)).some((ability) => ability.trigger.kind === 'dieRelic' &&
        (face === null || ability.trigger.faces.includes(face)) &&
        (!['nilrys_codex', 'loaded_die'].includes(held.defId) || owner.id !== player.id || targetRelicIndex !== relicIndex))))
  }
  return true
}

/** Owner-authoritative activation for printed face-down and cube relics. */
export function activateRelic(
  state: CombatState,
  playerId: string,
  relicIndex: number,
  context: RelicContext = {},
): CombatState {
  const player = findPlayer(state, playerId)
  const held = player?.relics[relicIndex]
  if (!player || !held || !canActivateRelic(state, player, relicIndex)) return state
  const def = relicDef(held.defId)
  const oncePerRoll = ['charons_ashes', 'dollys_mirror', 'nilrys_codex', 'loaded_die'].includes(held.defId)

  if (held.defId === 'golden_eye') {
    const pending = state.pendingRelicScry
    if (!pending) {
      if (context.scryDiscardUids !== undefined) return state
      const next = clone(state)
      const actor = findPlayer(next, playerId)!
      next.pendingRelicScry = { playerId, relicIndex, cards: actor.draw.slice(0, 3) }
      return next
    }
    const chosen = context.scryDiscardUids
    if (pending.playerId !== playerId || pending.relicIndex !== relicIndex || !chosen ||
      new Set(chosen).size !== chosen.length || chosen.some((uid) => !pending.cards.some((card) => card.uid === uid))) return state
    const next = clone(state)
    const actor = findPlayer(next, playerId)!
    const result = scry(actor, 3, chosen)
    actor.draw = result.draw
    actor.hand = result.hand
    actor.discard = result.discard
    actor.relics[relicIndex]!.spent = true
    delete next.pendingRelicScry
    next.log = [...next.log, `${actor.name}'s Golden Eye Scries 3`]
    return next
  }
  if (state.pendingRelicScry) return state

  const cards = context.cardUids ?? []
  if (new Set(cards).size !== cards.length || cards.some((uid) => !player.hand.some((card) => card.uid === uid))) return state
  if (held.defId === 'blue_candle' && cards.length > 2) return state
  if (held.defId === 'centennial_puzzle' && !player.lostHpThisCombat) return state
  if (held.defId === 'mummified_hand' && !player.powerPlayedThisTurn) return state
  if (held.defId === 'red_skull' && !player.shuffledThisCombat) return state
  if (held.defId === 'self_forming_clay' && !player.lostHpThisCombat) return state
  if (held.defId === 'holy_water' && (held.cubes ?? 0) < 1) return state
  if (held.defId === 'gambling_chip' && context.die !== undefined) return state
  if (held.defId === 'charons_ashes' && (!state.die || state.die > 2 || cards.length !== 1)) return state
  if (held.defId === 'ninja_scroll') {
    const overflow = overflowShivCount(state, 2)
    if ((context.shivEnemyUids?.length ?? 0) !== overflow ||
      context.shivEnemyUids?.some((uid) => !livingEnemies(state).some((enemy) => enemy.uid === uid))) return state
  }
  if (['dollys_mirror', 'nilrys_codex', 'loaded_die'].includes(held.defId)) {
    const required = held.defId === 'dollys_mirror' ? 1 : held.defId === 'nilrys_codex' ? 4 : 6
    if (state.die !== required) return state
    const owner = state.players.find((candidate) => candidate.id === context.targetRelicPlayerId)
    const targetHeld = owner?.relics[context.targetRelicIndex ?? -1]
    const ability = targetHeld && relicAbilities(relicDef(targetHeld.defId))[context.targetAbilityIndex ?? 0]
    const face = ability?.trigger.kind === 'dieRelic' ? ability.trigger.faces : []
    const targetFace = held.defId === 'nilrys_codex' ? 2 : held.defId === 'dollys_mirror' ? 1 : undefined
    const needsEnemy = ability && (ability.target ?? 'enemy') !== 'allEnemies' &&
      ability.effects.some((effect) => reachesEnemy(effect, owner))
    if (!owner || owner.dead || !ability || (targetFace !== undefined && !face.includes(targetFace)) ||
      needsEnemy && !livingEnemies(state).some((enemy) => enemy.uid === context.enemyUid) ||
      ['nilrys_codex', 'loaded_die'].includes(held.defId) && owner.id === playerId &&
      context.targetRelicIndex === relicIndex) return state
  }

  const next = clone(state)
  const actor = findPlayer(next, playerId)!
  const item = actor.relics[relicIndex]!
  const spend = () => { item.spent = true }
  const source = `${actor.name}'s ${def.name}`
  if (def.activation || oncePerRoll) spend()
  if (held.defId === 'holy_water') { item.cubes!--; actor.energy = Math.min(CAPS.energy, actor.energy + 1) }
  else if (held.defId === 'akabeko') actor.akabekoAttacks = (actor.akabekoAttacks ?? 0) + 1
  else if (held.defId === 'blue_candle') {
    const chosen = cards.map((uid) => actor.hand.find((card) => card.uid === uid)!)
    actor.hand = actor.hand.filter((card) => !cards.includes(card.uid))
    exhaustCards(next, actor, chosen)
  } else if (held.defId === 'calipers') actor.calipersArmed = true
  else if (held.defId === 'centennial_puzzle') drawInto(next, actor, 3)
  else if (held.defId === 'dead_branch') drawInto(next, actor, actor.exhaust.length)
  else if (held.defId === 'gambling_chip') next.die = nextInt(next.rng, 6) + 1
  else if (held.defId === 'the_abacus') next.die = next.die === 6 ? 1 : next.die + 1
  else if (held.defId === 'toolbox') next.die = next.die === 1 ? 6 : next.die - 1
  else if (held.defId === 'mummified_hand') actor.energy = Math.min(CAPS.energy, actor.energy + 2)
  else if (held.defId === 'ninja_scroll') applyEffect(next, actor, { kind: 'gainShiv', amount: 2 }, 'self', 'self', {
    enemyUid: null,
    playerId: actor.id,
    shivEnemyUids: context.shivEnemyUids,
    shivTargetIndex: 0,
    invalidShivTarget: false,
  }, source)
  else if (held.defId === 'red_skull') actor.strength = gainStrength(actor.strength, 1)
  else if (held.defId === 'runic_pyramid') actor.retainCardsThisTurn = cards.length
  else if (held.defId === 'self_forming_clay') actor.block = gainBlock(actor.block, 3)
  else if (held.defId === 'charons_ashes') {
    const card = actor.hand.find((candidate) => candidate.uid === cards[0])!
    actor.hand = actor.hand.filter((candidate) => candidate.uid !== card.uid)
    exhaustCards(next, actor, [card])
    const target = livingEnemies(next).find((enemy) => enemy.uid === context.enemyUid)
    if (!target) return state
    damageEnemyLogged(next, target, actor.damageDealtZeroThisTurn ? 0 : 2, source)
  } else if (['dollys_mirror', 'nilrys_codex', 'loaded_die'].includes(held.defId)) {
    const owner = findPlayer(next, context.targetRelicPlayerId!)!
    const ability = relicAbilities(relicDef(owner.relics[context.targetRelicIndex!]!.defId))[context.targetAbilityIndex ?? 0]!
    for (const effect of ability.effects) applyEffect(next, owner, effect, ability.target ?? 'enemy', ability.supportTarget ?? 'self',
      { enemyUid: context.enemyUid ?? null, playerId: owner.id }, source)
  } else return state
  next.log = [...next.log, `${source} activates`]
  return settle(next)
}

/** Spend one Shiv as its own one-damage attack (p.17). */
export function spendShiv(state: CombatState, playerId: string, enemyUid: string): CombatState {
  if (state.phase !== 'player' || state.pendingDistilled || state.pendingRelicScry ||
    state.startTurnProgress?.forcedCard ||
    (state.pendingTriggers?.length ?? 0) > 0) return state
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (!player || player.dead || player.shivs < 1 || player.cardPlayLocked || reachedTimeWarpLimit(state, player)) {
    return state
  }
  if (resolveEnemyTargets(state, 'enemy', enemyUid).length === 0) return state
  const next = clone(state)
  const actor = next.players.find((candidate) => candidate.id === playerId)!
  actor.shivs -= 1
  addPresentationEvent(next, {
    kind: 'shiv',
    actorId: actor.id,
    sourceId: 'shiv',
    enemyIds: [enemyUid],
    playerIds: [],
  })
  next.log = [...next.log, `${actor.name} spends a Shiv`]
  applyEffect(
    next,
    actor,
    { kind: 'hit', amount: 1 + actor.shivDamageBonus },
    'enemy',
    'self',
    { enemyUid, playerId },
    'Shiv',
  )
  actor.attacksPlayedThisTurn = (actor.attacksPlayedThisTurn ?? 0) + 1
  return settle(next)
}

/** Whether a held Potion has a legal activation window or required source card. */
export function canActivatePotion(state: CombatState, player: Player, potionId: string): boolean {
  if (player.dead || !player.potions.includes(potionId) || state.startTurnProgress?.forcedCard ||
    (state.pendingTriggers?.length ?? 0) > 0 || potionId === 'fairy_in_a_bottle') return false
  if (potionId === 'gamblers_brew') return state.phase === 'start' &&
    !state.startTurnProgress?.beforeDraw && !state.startTurnProgress?.rollPending &&
    !state.startTurnProgress?.discard
  return state.phase === 'player' && (potionId !== 'liquid_memories' || player.discard.length > 0)
}

/** Use and discard one held potion during the shared Player Turn (p.8, p.12). */
export function activatePotion(
  state: CombatState,
  playerId: string,
  potionId: string,
  context: PotionContext = {},
): CombatState {
  const changingDie = potionId === 'gamblers_brew'
  const player = findPlayer(state, playerId)
  if (!player || !canActivatePotion(state, player, potionId)) return state
  const def = potionDef(potionId)
  if (changingDie && (!Number.isInteger(context.die) || context.die! < 1 || context.die! > 6)) return state
  if (potionId === 'liquid_memories' && (
    !context.recoverDiscardUid || !player.discard.some((card) => card.uid === context.recoverDiscardUid)
  )) return state
  if (potionId === 'purity_potion' && (
    (context.exhaustUids?.length ?? 0) > 3 || new Set(context.exhaustUids ?? []).size !== (context.exhaustUids?.length ?? 0) ||
    (context.exhaustUids ?? []).some((uid) => !player.hand.some((card) => card.uid === uid))
  )) return state
  if (potionId === 'entropic_brew') {
    if (!player.relics.some((relic) => relic.defId === 'sozu')) {
      const overflow = Math.max(0, player.potions.length - 1 + 2 - state.potionLimit)
      const replaceable = context.replacePotionId !== potionId && player.potions.includes(context.replacePotionId ?? '')
      if (overflow > 1 || (overflow === 1) !== replaceable) return state
    }
  } else if (context.replacePotionId !== undefined) return state
  const target = def.target ?? 'enemy'
  if (def.target === 'row') {
    if (!rowExists(state, context.enemyRow)) return state
  } else if (def.target && resolveEnemyTargets(state, target, context.enemyUid ?? null).length === 0) {
    return state
  }
  if (def.supportTarget === 'anyPlayer' && context.targetPlayerId !== null && context.targetPlayerId !== undefined) {
    const chosen = findPlayer(state, context.targetPlayerId)
    if (!chosen || chosen.dead) return state
  }

  const next = clone(state)
  const actor = findPlayer(next, playerId)!
  addPresentationEvent(next, {
    kind: 'potion',
    actorId: actor.id,
    sourceId: potionId,
    ...presentationTargets(next, actor.id, def.target ?? 'self', def.supportTarget ?? 'self', {
      enemyUid: context.enemyUid,
      enemyRow: context.enemyRow,
      shivEnemyUids: potionId === 'cunning_potion' ? context.shivEnemyUids : [],
      playerId: context.targetPlayerId,
    }),
  })
  actor.potions.splice(actor.potions.indexOf(potionId), 1)
  next.potionDeck.push(potionId)
  next.log = [...next.log, `${actor.name} uses ${def.name}`]
  if (changingDie) {
    next.die = context.die!
    next.log = [...next.log, `${actor.name} changes the shared die to ${context.die}`]
    return next
  }
  if (potionId === 'entropic_brew') {
    if (actor.relics.some((relic) => relic.defId === 'sozu')) {
      next.log = [...next.log, `${actor.name} cannot gain Potions because of Sozu`]
      return next
    }
    if (context.replacePotionId) {
      actor.potions.splice(actor.potions.indexOf(context.replacePotionId), 1)
      next.potionDeck.push(context.replacePotionId)
    }
    const gained = next.potionDeck.splice(0, 2)
    actor.potions.push(...gained)
    next.log = [...next.log, `${actor.name} gains ${gained.length} Potion${gained.length === 1 ? '' : 's'}`]
    return next
  }
  if (potionId === 'distilled_chaos') {
    const drawn = drawInto(next, actor, 3)
    const cards = drawn.filter((card) => actor.hand.some((held) => held.uid === card.uid))
    next.pendingDistilled = cards.length ? { playerId: actor.id, cards } : undefined
    next.log = [...next.log, `${actor.name} draws ${drawn.length} cards; ${cards.length} remain to play for 0 Energy in any order`]
    return settle(next)
  }
  const ctx: PlayContext = {
    enemyUid: context.enemyUid ?? null,
    enemyRow: context.enemyRow,
    playerId: context.targetPlayerId ?? null,
    shivEnemyUids: context.shivEnemyUids,
    shivTargetIndex: 0,
    recoverDiscardUid: context.recoverDiscardUid,
    exhaustUids: context.exhaustUids,
    invalidShivTarget: false,
  }
  for (const effect of def.effects) {
    applyEffect(
      next,
      actor,
      effect,
      def.target ? target : 'self',
      def.supportTarget ?? 'self',
      ctx,
      def.name,
    )
  }
  if (potionId === 'liquid_memories' && context.recoverDiscardUid) {
    actor.hand = actor.hand.map((card) => card.uid === context.recoverDiscardUid
      ? { ...card, freeThisTurn: true }
      : card)
  }
  if (ctx.invalidShivTarget) return state
  return settle(next)
}

/** Choose the next Distilled Chaos card; normal forced-card targeting resolves it. */
export function chooseDistilledCard(state: CombatState, playerId: string, cardUid: string): CombatState {
  const pending = state.pendingDistilled
  if (state.phase !== 'player' || state.startTurnProgress?.forcedCard || state.pendingCardCopy ||
    (state.pendingTriggers?.length ?? 0) > 0 || pending?.playerId !== playerId) return state
  const queued = pending.cards.find((card) => card.uid === cardUid)
  const player = findPlayer(state, playerId)
  if (!queued || !player?.hand.some((card) => card.uid === cardUid)) return state
  const next = clone(state)
  const actor = findPlayer(next, playerId)!
  const remaining = next.pendingDistilled!.cards.filter((card) => card.uid !== cardUid)
  const def = faceOf(cardDef(queued.defId), queued.upgraded)
  next.pendingDistilled = remaining.length ? { playerId, cards: remaining } : undefined
  if (reachedTimeWarpLimit(next, actor) || !cardIsPlayable(def, next, actor) || (def.minimumX ?? 0) > 0) {
    discardByCardEffect(next, actor, [actor.hand.find((card) => card.uid === cardUid)!])
    next.log = [...next.log, `${actor.name} cannot play ${def.name}; it is discarded`]
    return settle(next)
  }
  next.startTurnProgress = {
    choices: [],
    forcedCard: {
      playerId,
      cardUid,
      sourceCardId: 'mayhem',
      sourceLabel: 'Distilled Chaos',
      exhaustNonPower: false,
    },
  }
  next.log = [...next.log, `${actor.name} chooses ${def.name} from Distilled Chaos`]
  return next
}
