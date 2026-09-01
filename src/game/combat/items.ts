// What a player can do on their turn without playing a card: spend a Miracle or
// a Shiv, and activate a Relic or a Potion.
//
// Each is its own atomic action with its own legality check, so the UI can offer
// exactly the ones the board currently allows.
import { clone, combatIsOver, findPlayer, livingEnemies, powerAbilityKey, powerAbilityUsed, resolveEnemyTargets, rowExists } from './board.ts'
import { applyEffect, damageEnemyLogged, discardByCardEffect, drawInto, exhaustCards, fireTriggers, recordAttackPlayed, settle, triggerChosenDieRelic } from './effects.ts'
import { addPresentationEvent, presentationTargets } from './presentation.ts'
import { activePowerWindow, cardIsPlayable, mandatoryChoicePending, overflowShivCount, reachedTimeWarpLimit, reachesEnemy } from './queries.ts'
import type { CombatState, PlayContext, PotionContext, RelicContext } from './types.ts'
import { cardDef, cardIsCurse, faceOf } from '../cards.ts'
import { healingCapFor, transformCard } from '../acquisition.ts'
import { gainBlock, gainStrength } from '../damage.ts'
import { scry } from '../piles.ts'
import { chosenDieRelicAbilities, potionDef, relicDef } from '../relics.ts'
import { nextInt } from '../rng.ts'
import { CAPS } from '../types.ts'
import type { Player } from '../types.ts'
import { MAX_HP } from '../run/rules.ts'
import { playerCanGainBlock } from './pieces.ts'
import { downfallRelicBaseId } from '../downfall/items.ts'

/** Potions whose official face cannot be expressed by the generic Effect list. */
export const SPECIAL_POTION_RUNTIME_IDS = new Set([
  'transforming_brew',
  'mystery_potion',
  'pizzaz_potion',
  'greed_potion',
  'liquid_void',
  'fruit_juice',
  'destiny_draught',
  'cactus_juice',
] as const)

/** Spend one Miracle for one Energy during the shared Player Turn (p.17). */
export function spendMiracle(state: CombatState, playerId: string): CombatState {
  if (state.phase !== 'player' || state.startTurnProgress?.forcedCard || mandatoryChoicePending(state) ||
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
    mandatoryChoicePending(state) ||
    (state.pendingTriggers?.length ?? 0) > 0 || !activePowerWindow(state)) return false
  const def = relicDef(held.defId)
  const heldId = downfallRelicBaseId(held.defId)
  const reroute = ['dollys_mirror', 'nilrys_codex', 'loaded_die'].includes(heldId)
  const oncePerRoll = reroute || heldId === 'charons_ashes'
  const manual = Boolean(def.activation) || oncePerRoll || heldId === 'holy_water'
  const postRoll = oncePerRoll || ['gambling_chip', 'the_abacus', 'toolbox', 'fuel_canister'].includes(heldId)
  if (!manual || held.spent || heldId === 'the_courier' ||
    postRoll && (state.phase !== 'start' || state.startTurnProgress)) return false
  if (state.pendingRelicScry) return heldId === 'golden_eye' &&
    state.pendingRelicScry.playerId === player.id && state.pendingRelicScry.relicIndex === relicIndex
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
    const face = heldId === 'dollys_mirror' ? 1 : heldId === 'nilrys_codex' ? 2 : null
    return state.players.some((owner) => !owner.dead && owner.relics.some((target, targetRelicIndex) =>
      chosenDieRelicAbilities(relicDef(target.defId)).some((ability) => ability.trigger.kind === 'dieRelic' &&
        (face === null || ability.trigger.faces.includes(face)) &&
        (!['nilrys_codex', 'loaded_die'].includes(heldId) || owner.id !== player.id || targetRelicIndex !== relicIndex))))
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
  const heldId = downfallRelicBaseId(held.defId)
  const oncePerRoll = ['charons_ashes', 'dollys_mirror', 'nilrys_codex', 'loaded_die'].includes(heldId)

  if (heldId === 'golden_eye') {
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
  if (heldId === 'blue_candle' && cards.length > 2) return state
  if (heldId === 'centennial_puzzle' && !player.lostHpThisCombat) return state
  if (heldId === 'mummified_hand' && !player.powerPlayedThisTurn) return state
  if (heldId === 'red_skull' && !player.shuffledThisCombat) return state
  if (heldId === 'self_forming_clay' && !player.lostHpThisCombat) return state
  if (heldId === 'holy_water' && (held.cubes ?? 0) < 1) return state
  if (heldId === 'gambling_chip' && context.die !== undefined) return state
  if (heldId === 'charons_ashes' && (!state.die || state.die > 2 || cards.length !== 1)) return state
  if (heldId === 'ninja_scroll') {
    const targets = held.defId === 'downfall_ninja_scroll' ? 3 : overflowShivCount(state, 2)
    if ((context.shivEnemyUids?.length ?? 0) !== targets ||
      context.shivEnemyUids?.some((uid) => !livingEnemies(state).some((enemy) => enemy.uid === uid))) return state
  }
  if (heldId === 'fuel_canister' && (state.die > 2 || cards.length !== 1)) return state
  if (heldId === 'shot_glass' && !player.potions.includes(context.discardPotionId ?? '')) return state
  if (['dollys_mirror', 'nilrys_codex', 'loaded_die'].includes(heldId)) {
    const required = heldId === 'dollys_mirror' ? 1
      : heldId === 'nilrys_codex' ? (held.defId === 'downfall_nilrys_codex' ? 2 : 4) : 6
    if (state.die !== required) return state
    const owner = state.players.find((candidate) => candidate.id === context.targetRelicPlayerId)
    const targetHeld = owner?.relics[context.targetRelicIndex ?? -1]
    const ability = targetHeld && chosenDieRelicAbilities(relicDef(targetHeld.defId))[context.targetAbilityIndex ?? 0]
    const face = ability?.trigger.kind === 'dieRelic' ? ability.trigger.faces : []
    const targetFace = heldId === 'nilrys_codex' ? 2 : heldId === 'dollys_mirror' ? 1 : undefined
    const needsEnemy = ability && (ability.target ?? 'enemy') !== 'allEnemies' &&
      ability.effects.some((effect) => reachesEnemy(effect, owner))
    if (!owner || owner.dead || !ability || (targetFace !== undefined && !face.includes(targetFace)) ||
      needsEnemy && !livingEnemies(state).some((enemy) => enemy.uid === context.enemyUid) ||
      ['nilrys_codex', 'loaded_die'].includes(heldId) && owner.id === playerId &&
      context.targetRelicIndex === relicIndex) return state
  }

  const next = clone(state)
  const actor = findPlayer(next, playerId)!
  const item = actor.relics[relicIndex]!
  const spend = () => { item.spent = true }
  const source = `${actor.name}'s ${def.name}`
  if (def.activation || oncePerRoll) spend()
  if (heldId === 'holy_water') { item.cubes!--; actor.energy = Math.min(CAPS.energy, actor.energy + 1) }
  else if (heldId === 'akabeko') actor.akabekoAttacks = (actor.akabekoAttacks ?? 0) + 1
  else if (heldId === 'blue_candle') {
    const chosen = cards.map((uid) => actor.hand.find((card) => card.uid === uid)!)
    actor.hand = actor.hand.filter((card) => !cards.includes(card.uid))
    exhaustCards(next, actor, chosen)
  } else if (heldId === 'calipers') actor.calipersArmed = true
  else if (heldId === 'centennial_puzzle') drawInto(next, actor, 3)
  else if (heldId === 'dead_branch') drawInto(next, actor, actor.exhaust.length)
  else if (heldId === 'gambling_chip') next.die = nextInt(next.rng, 6) + 1
  else if (heldId === 'the_abacus') next.die = next.die === 6 ? 1 : next.die + 1
  else if (heldId === 'toolbox') next.die = next.die === 1 ? 6 : next.die - 1
  else if (heldId === 'mummified_hand') actor.energy = Math.min(CAPS.energy, actor.energy + 2)
  else if (held.defId === 'downfall_ninja_scroll') {
    const wristBlade = actor.relics.some((relic) => downfallRelicBaseId(relic.defId) === 'wrist_blade') ? 1 : 0
    for (const enemyUid of context.shivEnemyUids!) {
      applyEffect(next, actor, { kind: 'hit', amount: 1 + wristBlade }, 'enemy', 'self',
        { enemyUid, playerId: actor.id }, source)
      recordAttackPlayed(next, actor)
      if (combatIsOver(next)) break
    }
  } else if (heldId === 'ninja_scroll') applyEffect(next, actor, { kind: 'gainShiv', amount: 2 }, 'self', 'self', {
    enemyUid: null,
    playerId: actor.id,
    shivEnemyUids: context.shivEnemyUids,
    shivTargetIndex: 0,
    invalidShivTarget: false,
  }, source)
  else if (heldId === 'red_skull') actor.strength = gainStrength(actor.strength, 1)
  else if (heldId === 'runic_pyramid') actor.retainCardsThisTurn = cards.length
  else if (heldId === 'self_forming_clay' && playerCanGainBlock(actor)) actor.block = gainBlock(actor.block, 3)
  else if (heldId === 'charons_ashes') {
    const card = actor.hand.find((candidate) => candidate.uid === cards[0])!
    actor.hand = actor.hand.filter((candidate) => candidate.uid !== card.uid)
    exhaustCards(next, actor, [card])
    const target = livingEnemies(next).find((enemy) => enemy.uid === context.enemyUid)
    if (!target) return state
    damageEnemyLogged(next, target, actor.damageDealtZeroThisTurn ? 0 : 2, source, actor)
  } else if (['dollys_mirror', 'nilrys_codex', 'loaded_die'].includes(heldId)) {
    const owner = findPlayer(next, context.targetRelicPlayerId!)!
    const targetHeld = owner.relics[context.targetRelicIndex!]!
    if (!triggerChosenDieRelic(next, owner, targetHeld.defId, context.targetAbilityIndex ?? 0, {
      enemyUid: context.enemyUid ?? null,
      playerId: context.targetPlayerId ?? owner.id,
    }, source)) return state
  } else if (heldId === 'fuel_canister') {
    const card = actor.hand.find((candidate) => candidate.uid === cards[0])!
    actor.hand = actor.hand.filter((candidate) => candidate.uid !== card.uid)
    exhaustCards(next, actor, [card])
    actor.energy = Math.min(CAPS.energy, actor.energy + 1)
  } else if (heldId === 'shot_glass') {
    const potionId = context.discardPotionId!
    actor.potions.splice(actor.potions.indexOf(potionId), 1)
    next.potionDeck.push(potionId)
    actor.strength = gainStrength(actor.strength, 1)
  } else if (def.activation) {
    const effectContext: PlayContext = { enemyUid: context.enemyUid ?? null, playerId: actor.id, shortfall: false }
    for (const effect of def.effects) applyEffect(next, actor, effect, def.target ?? 'self', def.supportTarget ?? 'self', effectContext, source)
    if (effectContext.shortfall) return state
  } else return state
  next.log = [...next.log, `${source} activates`]
  return settle(next)
}

/** Spend one Shiv as its own one-damage attack (p.17). */
export function spendShiv(state: CombatState, playerId: string, enemyUid: string): CombatState {
  if (state.phase !== 'player' || state.pendingDistilled || state.pendingRelicScry || mandatoryChoicePending(state) ||
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
  if (combatIsOver(next)) return settle(next)
  recordAttackPlayed(next, actor)
  return settle(next)
}

/** Spend one Hexaghost Soulburn for plain damage equal to current Heat. */
export function spendSoulburn(
  state: CombatState,
  playerId: string,
  enemyUid: string,
  extraCrispyPowerUid?: string,
): CombatState {
  if (state.phase !== 'player' || state.pendingDistilled || state.pendingRelicScry || mandatoryChoicePending(state) ||
    state.startTurnProgress?.forcedCard || (state.pendingTriggers?.length ?? 0) > 0) return state
  const player = findPlayer(state, playerId)
  if (!player || player.dead || player.soulburn < 1 ||
    player.character !== 'hexaghost' && !player.relics.some((relic) => relic.defId === 'corrupted_shard') ||
    player.cardPlayLocked || reachedTimeWarpLimit(state, player) ||
    resolveEnemyTargets(state, 'enemy', enemyUid).length === 0) return state
  const crispy = extraCrispyPowerUid === undefined ? undefined
    : player.powers.find((power) => power.uid === extraCrispyPowerUid && power.defId === 'extra_crispy')
  if (extraCrispyPowerUid !== undefined && (!crispy || powerAbilityUsed(state, playerId, crispy.uid))) return state

  const next = clone(state)
  const actor = findPlayer(next, playerId)!
  actor.soulburn -= 1
  actor.soulburnUsedThisTurn = true
  addPresentationEvent(next, {
    kind: 'card',
    actorId: actor.id,
    sourceId: 'strike_hexaghost',
    upgraded: false,
    copied: false,
    energy: 0,
    resolvedType: 'attack',
    enemyIds: [enemyUid],
    playerIds: [],
  })
  const bonus = actor.nextSoulburnDamageBonus ?? 0
  actor.nextSoulburnDamageBonus = 0
  const multiplier = crispy ? 2 : 1
  if (crispy) next.powerTriggersUsedThisTurn.push(powerAbilityKey(playerId, crispy.uid))
  next.log = [...next.log, `${actor.name} spends a Soulburn${crispy ? ' with Extra Crispy' : ''}`]
  applyEffect(next, actor, { kind: 'damage', amount: (actor.heat + bonus) * multiplier }, 'enemy', 'self',
    { enemyUid, playerId }, 'Soulburn')
  if (!combatIsOver(next)) fireTriggers(next, { kind: 'onUseSoulburn' }, actor)
  return settle(next)
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
      player.cardRewards.length > 0)
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
  if (potionId === 'liquid_void' && (
    !context.recoverExhaustUid || !player.exhaust.some((card) => card.uid === context.recoverExhaustUid)
  )) return state
  if (potionId === 'transforming_brew' && (
    !context.transformHandUid || !player.hand.some((card) => card.uid === context.transformHandUid && !cardIsCurse(card.defId))
  )) return state
  if (potionId === 'purity_potion' && (
    (context.exhaustUids?.length ?? 0) > 3 || new Set(context.exhaustUids ?? []).size !== (context.exhaustUids?.length ?? 0) ||
    (context.exhaustUids ?? []).some((uid) => !player.hand.some((card) => card.uid === uid))
  )) return state
  if (potionId === 'entropic_brew') {
    if (!player.relics.some((relic) => relic.defId === 'sozu')) {
      const capacity = state.potionLimit + (player.relics.some((relic) => relic.defId === 'potion_belt') ? 2 : 0)
      const overflow = Math.max(0, player.potions.length - 1 + 2 - capacity)
      const replaceable = context.replacePotionId !== potionId && player.potions.includes(context.replacePotionId ?? '')
      if (overflow > 1 || (overflow === 1) !== replaceable) return state
    }
  } else if (context.replacePotionId !== undefined) return state
  const mysteryNeedsEnemy = potionId === 'mystery_potion' && state.die <= 2
  const target = def.target ?? (mysteryNeedsEnemy ? 'enemy' : 'self')
  if (def.target === 'row') {
    if (!rowExists(state, context.enemyRow)) return state
  } else if ((def.target || mysteryNeedsEnemy) && resolveEnemyTargets(state, target, context.enemyUid ?? null).length === 0) {
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
  if (potionId === 'transforming_brew') {
    const old = actor.hand.find((card) => card.uid === context.transformHandUid)!
    const newUid = old.uid
    const transformed = transformCard(next.rng, actor, old.uid, newUid)
    const replacement = transformed.deck.find((card) => card.uid === newUid)
    if (!replacement) return state
    Object.assign(actor, transformed)
    actor.hand = [...actor.hand.filter((card) => card.uid !== old.uid), { ...replacement }]
    next.log = [...next.log, `${actor.name} transforms ${faceOf(cardDef(old.defId), old.upgraded).name} into ${cardDef(replacement.defId).name}`]
    return settle(next)
  }
  if (potionId === 'mystery_potion') {
    const effects = next.die <= 2 ? [{ kind: 'damage' as const, amount: 4 }]
      : next.die <= 4 ? [{ kind: 'draw' as const, amount: 3 }]
        : [{ kind: 'gainEnergy' as const, amount: 2 }]
    const ctx: PlayContext = { enemyUid: context.enemyUid ?? null, playerId: actor.id }
    for (const effect of effects) applyEffect(next, actor, effect, target, 'self', ctx, def.name)
    return settle(next)
  }
  if (potionId === 'pizzaz_potion') {
    const before = actor.strength
    actor.strength = gainStrength(actor.strength, 2)
    actor.nextAttackStrength = (actor.nextAttackStrength ?? 0) + actor.strength - before
    return settle(next)
  }
  if (potionId === 'greed_potion') {
    applyEffect(next, actor, { kind: 'damage', amount: actor.gold }, 'enemy', 'self', {
      enemyUid: context.enemyUid ?? null, playerId: actor.id,
    }, def.name)
    return settle(next)
  }
  if (potionId === 'liquid_void') {
    const recovered = actor.exhaust.find((card) => card.uid === context.recoverExhaustUid)!
    actor.exhaust = actor.exhaust.filter((card) => card.uid !== recovered.uid)
    actor.hand = [...actor.hand, { ...recovered, freeThisTurn: true }]
    return settle(next)
  }
  if (potionId === 'fruit_juice') {
    actor.maxHp = Math.min(MAX_HP[actor.character], actor.maxHp + 1)
    actor.hp = Math.min(healingCapFor(actor, next.ruleset), actor.hp + 1)
    return settle(next)
  }
  if (potionId === 'destiny_draught') {
    const owner = findPlayer(next, context.targetRelicPlayerId ?? '')
    const held = owner?.relics[context.targetRelicIndex ?? -1]
    const ability = held && chosenDieRelicAbilities(relicDef(held.defId))[context.targetAbilityIndex ?? -1]
    if (!owner || owner.dead || !ability || ability.trigger.kind !== 'dieRelic') return state
    const needsEnemy = (ability.target ?? 'enemy') !== 'allEnemies' &&
      ability.effects.some((effect) => reachesEnemy(effect, owner))
    if (needsEnemy && !livingEnemies(next).some((enemy) => enemy.uid === context.enemyUid)) return state
    if (!triggerChosenDieRelic(next, owner, held.defId, context.targetAbilityIndex ?? -1, {
      enemyUid: context.enemyUid ?? null,
      playerId: context.targetPlayerId ?? owner.id,
    }, def.name)) return state
    return settle(next)
  }
  if (potionId === 'cactus_juice') {
    const statuses = new Set(['daze', 'slimed', 'burn'])
    const moved = actor.hand.filter((card) => statuses.has(card.defId))
    actor.hand = actor.hand.filter((card) => !statuses.has(card.defId))
    exhaustCards(next, actor, moved)
    drawInto(next, actor, moved.length)
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

/** Resolve or decline the optional row switch granted by Downfall Plunder. */
export function resolvePlunderRowSwitch(
  state: CombatState,
  playerId: string,
  row: number | null,
): CombatState {
  const pending = state.pendingPlunderSwitches?.[0]
  const player = findPlayer(state, playerId)
  if (!pending || pending.playerId !== playerId || !player || player.dead ||
    (row !== null && (!Number.isInteger(row) || row < 0 || row >= state.players.length))) return state
  const next = clone(state)
  const actor = findPlayer(next, playerId)!
  if (row !== null && row !== actor.row) {
    const other = next.players.find((candidate) => !candidate.dead && candidate.row === row)
    const oldRow = actor.row
    actor.row = row
    if (other) other.row = oldRow
    next.log = [...next.log, `${actor.name} switches rows after Plunder`]
  } else {
    next.log = [...next.log, `${actor.name} stays in their row after Plunder`]
  }
  next.pendingPlunderSwitches = next.pendingPlunderSwitches!.slice(1)
  return settle(next)
}
