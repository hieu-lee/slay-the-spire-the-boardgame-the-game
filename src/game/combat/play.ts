// Playing a card: the atomic step between "the player pressed a card" and "the
// board is settled again".
//
// A play is all-or-nothing. Every choice the card needs is validated before any
// of its text resolves, so a card can never spend its Energy and then stall
// half-resolved on a target the board cannot give it. Everything that has to
// wait for the card to finish — enemy reactions, deferred discards, a copy that
// resolves before its original — is drained here, in printed order, once.
import {
  cardResolutionIsOver,
  clone,
  combatIsOver,
  enemyLabel,
  findPlayer,
  livingEnemies,
  powerAbilityKey,
  powerAbilityUsed,
  resolveEnemyTargets,
  rowExists,
} from './board.ts'
import {
  applyEffect,
  damagePlayer,
  discardByCardEffect,
  drawInto,
  evokeTargetProgress,
  exhaustCards,
  finishDeferredHavocs,
  fireTriggers,
  releasePendingTriggers,
  resolveDiscardReactions,
  resolveEnraged,
  resolveExhaustReaction,
  settle,
  triggerEnemyDeath,
} from './effects.ts'
import { forgetRetain, grantShiftBlock, triggerAngry } from './pieces.ts'
import { addPresentationEvent, presentationTargets } from './presentation.ts'
import {
  amountOf,
  cardEnemyChoiceCount,
  cardIsPlayable,
  cardModeIsAvailable,
  cardNeedsChoicePreview,
  cardNeedsEnemy,
  cardPlayerChoiceCount,
  cardShivChoiceCount,
  copySourcesFor,
  effectIsActive,
  evokePlan,
  hasInvalidChosenPlayer,
  hasInvalidRowSwitch,
  invalidPlayChoice,
  latestPlayableAllyAttack,
  needsChosenEnemy,
  omniscienceEligibleCards,
  overflowShivCount,
  playCost,
  reachedTimeWarpLimit,
  resolutionContext,
} from './queries.ts'
import { finishCardCopy, finishForcedCardPlay } from './start-turn.ts'
import type {
  CardChoicePreview,
  CombatState,
  CopySource,
  PlayContext,
  PowerContext,
  PresentationContext,
} from './types.ts'
import { cardDef, faceOf } from '../cards.ts'
import type { CardDef, Effect, TargetScope } from '../cards.ts'
import { gainBlock, gainStrength } from '../damage.ts'
import { enemyAbilities, enemyDef } from '../enemies.ts'
import { addToDrawTop } from '../piles.ts'
import { nextInt } from '../rng.ts'
import { CAPS } from '../types.ts'
import type { CardInstance, Player } from '../types.ts'

function presentationEnemyScope(
  def: CardDef,
  effects: readonly Effect[],
  actor: Player,
  includeEvokes: boolean,
  energySpent: number,
): TargetScope {
  const active = def.modes ? { ...def, modes: undefined, effects: [...effects] } : def
  return cardNeedsEnemy(active, actor, includeEvokes, energySpent) ? def.target ?? 'enemy' : 'self'
}

function presentationCardContext(
  def: CardDef,
  effects: readonly Effect[],
  context: PlayContext,
): PresentationContext {
  return {
    enemyUid: context.enemyUid,
    enemyRow: context.enemyRow,
    enemyUids: cardEnemyChoiceCount(def, context.mode) > 0 ? context.enemyUids : [],
    shivEnemyUids: context.shivEnemyUids,
    evokeEnemyUids: context.evokeEnemyUids,
    playerId: context.playerId,
    playerIds: cardPlayerChoiceCount(def, context.mode) > 0 ? context.playerIds : [],
    switchWithPlayerId: effects.some((effect) => effect.kind === 'switchRows')
      ? context.switchWithPlayerId : undefined,
  }
}

function consumeCopySource(actor: Player, sources: readonly CopySource[]): void {
  if (sources.includes('Echo Form')) actor.doubledCardsThisTurn = actor.doubledCardsThisTurn! - 1
  else if (sources.includes('Blasphemy')) actor.tripledAttacksThisTurn = actor.tripledAttacksThisTurn! - 1
  else if (sources.includes('Double Tap')) actor.doubledAttacksThisTurn = actor.doubledAttacksThisTurn! - 1
  else if (sources.includes('Burst')) actor.doubledSkillsThisTurn = actor.doubledSkillsThisTurn! - 1
}

/**
 * Privately previews a post-reveal choice without advancing the real RNG or
 * changing combat. The played card is held outside every pile, as it will be
 * during the eventual atomic play.
 */
export function previewCardChoice(
  state: CombatState,
  playerId: string,
  cardUid: string,
): CardChoicePreview | null {
  const forced = state.startTurnProgress?.forcedCard
  if (state.phase !== 'player' && !(state.phase === 'start' && forced?.playerId === playerId &&
    forced.cardUid === cardUid)) return null
  const player = findPlayer(state, playerId)
  const held = player?.hand.find((card) => card.uid === cardUid)
  if (!player || player.dead || !held) return null
  const def = faceOf(cardDef(held.defId), held.upgraded)
  const printedCost = forced?.cardUid === cardUid ? 0 : playCost(def, player, held)
  const cost = printedCost === 'X' ? player.energy : printedCost
  if (reachedTimeWarpLimit(state, player) || !cardIsPlayable(def, state, player) ||
    cost > player.energy || !cardNeedsChoicePreview(def, state, player)) return null

  const preview = clone(state)
  const actor = findPlayer(preview, playerId)!
  actor.hand = actor.hand.filter((card) => card.uid !== cardUid)
  let drew = false
  for (const effect of def.effects) {
    if (!effectIsActive(effect, preview, actor)) continue
    if (effect.kind === 'searchDraw' || effect.kind === 'searchDrawAndPlayTwice') {
      return { kind: 'search', cards: effect.kind === 'searchDraw'
        ? actor.draw
        : omniscienceEligibleCards(preview, actor) }
    } else if (effect.kind === 'draw') {
      drawInto(preview, actor, amountOf(effect.amount, preview, actor), [])
      drew = true
    } else if (effect.kind === 'scry') {
      return { kind: 'scry', cards: actor.draw.slice(0, effect.amount) }
    } else if (drew && effect.kind === 'discard') {
      return { kind: 'discard', cards: actor.hand }
    } else if (drew && effect.kind === 'topdeck') {
      return { kind: 'topdeck', cards: actor.hand }
    }
  }
  return null
}

function settleForbiddenPendingCopy(state: CombatState, actor: Player): CombatState {
  const settled = settle(state)
  if (!settled.pendingCardCopy) return settled
  return actor.cardPlayLocked || reachedTimeWarpLimit(settled, actor)
    ? skipCardCopy(settled, actor.id, actor.cardPlayLocked ? 'was skipped by Conclude' : 'was skipped by Time Warp')
    : settled
}

function cardResolutionChoicesAreValid(
  state: CombatState,
  player: Player,
  def: CardDef,
  effects: readonly Effect[],
  context: PlayContext,
  energySpent: number,
  sourceCardUid?: string,
): boolean {
  if (effects.some((effect) => effect.kind === 'copyLastAllyAttack') &&
    !latestPlayableAllyAttack(state, player, sourceCardUid)) {
    return false
  }
  const mandatoryShivs = cardShivChoiceCount(def, player, context.mode)
  const discarded = context.discardUids?.length ?? 0
  const gainedShivs = effects.reduce((sum, effect) => sum + (effect.kind === 'gainShiv'
    ? effect.amount
    : effect.kind === 'gainShivPerDiscard' ? discarded + effect.bonus : 0), 0)
  const shivChoices = context.shivEnemyUids ?? []
  if (shivChoices.length < mandatoryShivs ||
    shivChoices.length > mandatoryShivs + overflowShivCount(state, gainedShivs) ||
    shivChoices.some((uid, index) => (index < mandatoryShivs && uid === null) ||
      (uid !== null && !livingEnemies(state).some((enemy) => enemy.uid === uid)))) return false

  const enemyChoiceCount = cardEnemyChoiceCount(def, context.mode)
  const enemyChoices = context.enemyUids ?? []
  const requiresDistinct = effects.some((effect) => effect.kind === 'hitChoices' && effect.distinct)
  if (enemyChoiceCount > 0 && (
    enemyChoices.length !== enemyChoiceCount ||
    (requiresDistinct && new Set(enemyChoices).size !== enemyChoices.length) ||
    enemyChoices.some((uid) => !livingEnemies(state).some((enemy) => enemy.uid === uid))
  )) return false
  const playerChoiceCount = cardPlayerChoiceCount(def, context.mode)
  if (playerChoiceCount > 0 && (
    context.playerIds?.length !== playerChoiceCount ||
    context.playerIds.some((id) => !state.players.some((candidate) => candidate.id === id && !candidate.dead))
  )) return false

  const recover = effects.find((effect) => effect.kind === 'recoverDiscard')
  if (recover) {
    const required = Math.min(recover.amount, player.discard.length)
    const chosen = context.recoverDiscardUids ??
      (context.recoverDiscardUid === undefined ? [] : [context.recoverDiscardUid])
    if ((context.recoverDiscardUids !== undefined && context.recoverDiscardUid !== undefined) ||
      chosen.length !== required || new Set(chosen).size !== chosen.length ||
      chosen.some((uid) => !player.discard.some((card) => card.uid === uid))) return false
  }
  const exhume = effects.find((effect) => effect.kind === 'recoverExhaust')
  if (exhume) {
    const required = Math.min(exhume.amount, player.exhaust.length)
    const chosen = context.recoverExhaustUid
    if ((required === 1 && (!chosen || !player.exhaust.some((card) => card.uid === chosen))) ||
      (required === 0 && chosen !== undefined)) return false
  }
  const search = effects.find((effect) => effect.kind === 'searchDraw' || effect.kind === 'searchDrawAndPlayTwice')
  if (search) {
    const chosen = context.searchDrawUids ?? []
    const eligible = search.kind === 'searchDraw' ? player.draw : omniscienceEligibleCards(state, sourceCardUid
      ? { ...player, hand: player.hand.filter((card) => card.uid !== sourceCardUid) }
      : player)
    const required = Math.min(search.kind === 'searchDraw' ? search.amount : 1, eligible.length)
    if (chosen.length !== required || new Set(chosen).size !== chosen.length ||
      chosen.some((uid) => !eligible.some((card) => card.uid === uid))) return false
  }

  const plan = evokePlan(def, player, context.evokeSlots ?? [], context.mode, energySpent)
  if (plan.invalid || plan.next || plan.index !== (context.evokeSlots?.length ?? 0)) return false
  if (plan.chosen.length > 0 && (!context.evokeSlots || !context.evokeEnemyUids)) return false
  if (context.evokeEnemyUids) {
    if (!context.evokeSlots || context.evokeEnemyUids.length > plan.chosen.length) return false
    const targetPlan = evokeTargetProgress(
      def, state, player, context.evokeSlots, context.evokeEnemyUids, context.mode, energySpent,
    )
    if (!targetPlan.complete || targetPlan.index !== context.evokeEnemyUids.length) return false
  }
  return !needsChosenEnemy(state, def, context.enemyUid, player, !context.evokeEnemyUids, energySpent, context.mode) &&
    !hasInvalidChosenPlayer(state, def, context.playerId) &&
    !hasInvalidRowSwitch(state, effects, context.switchWithPlayerId, player)
}

function cleanupPlayedCard(
  state: CombatState,
  actor: Player,
  held: CardInstance,
  def: CardDef,
  context: PlayContext,
  forcedExhaust = false,
): void {
  const played = context.sourceCounter === undefined
    ? forgetRetain(held)
    : { ...forgetRetain(held), counter: context.sourceCounter }
  if (context.sourceAttached) return
  if (def.exhaust || forcedExhaust ||
    (def.type === 'skill' && actor.powers.some((power) => cardDef(power.defId).corruptSkills))) {
    exhaustCards(state, actor, [played], context)
  } else if (def.type === 'power') {
    actor.powers = [...actor.powers, played]
  } else if (def.toDrawTop) {
    actor.draw = addToDrawTop(actor, [played]).draw
  } else {
    actor.discard = [...actor.discard, played]
  }
}

/**
 * Plays a card from a player's hand. Returns the same state reference when the
 * play is illegal: not that player's card, not enough energy, wrong phase.
 */
/** Printed enemy reactions wait until the current card has resolved all text. */
function resolvePendingEnemyReactions(state: CombatState, actor: Player, context: PlayContext): void {
  for (const uid of new Set(context.pendingEnemyDeathUids ?? [])) {
    const enemy = state.enemies.find((candidate) => candidate.uid === uid)
    if (enemy?.dead) triggerEnemyDeath(state, enemy)
  }
  const damage = new Map<string, number>()
  for (const event of context.pendingEnemyDamage ?? []) {
    damage.set(event.enemyUid, (damage.get(event.enemyUid) ?? 0) + event.amount)
  }
  const attacked = new Set(context.pendingAttackTargets ?? [])
  for (const enemy of state.enemies) {
    const abilities = enemyAbilities(enemyDef(enemy.defId, enemy.ascension))
    const lost = damage.get(enemy.uid) ?? 0
    if (lost > 0) {
      const curl = abilities.find((ability) => ability.kind === 'curlUp')
      if (!enemy.dead && curl?.kind === 'curlUp' && !enemy.abilityUsed) {
        enemy.abilityUsed = true
        enemy.block = gainBlock(enemy.block, curl.block)
        state.log = [...state.log, `${enemyLabel(state.enemies, enemy)}'s Curl Up gained Block`]
      }
      if (abilities.some((ability) => ability.kind === 'shift')) grantShiftBlock(state, enemy, lost)
      triggerAngry(state, enemy, (context.pendingEnemyDamage ?? [])
        .filter((event) => event.enemyUid === enemy.uid).length)
      if (attacked.has(enemy.uid) && abilities.some((ability) => ability.kind === 'reactiveReroll')) {
        state.die = nextInt(state.rng, 6) + 1
        state.log = [...state.log, `${enemyLabel(state.enemies, enemy)} rerolled enemy intents to ${state.die}`]
      }
    }
    const thorns = abilities.find((ability) => ability.kind === 'thorns')
    const sharpHide = abilities.find((ability) => ability.kind === 'sharpHide')
    if (!attacked.has(enemy.uid) ||
      (thorns?.kind !== 'thorns' && (enemy.dead || sharpHide?.kind !== 'sharpHide'))) continue
    const amount = thorns?.kind === 'thorns'
      ? (enemy.abilityCubes ?? 0) * thorns.damagePerCube
      : sharpHide?.kind === 'sharpHide' ? sharpHide.damage : 0
    if (amount <= 0) continue
    const block = actor.block
    const outcome = damagePlayer(state, actor, amount)
    const lostHp = outcome.hpLost
    const blocked = block - actor.block
    state.log = [...state.log, lostHp > 0
      ? `${enemyLabel(state.enemies, enemy)}'s ${thorns ? 'Thorns' : 'Sharp Hide'} hit ${actor.name} for ${lostHp}${blocked > 0 ? ` (${blocked} blocked)` : ''}`
      : outcome.fullyBlocked ? `${actor.name} blocked ${enemyLabel(state.enemies, enemy)}'s ${thorns ? 'Thorns' : 'Sharp Hide'}`
        : `${enemyLabel(state.enemies, enemy)}'s ${thorns ? 'Thorns' : 'Sharp Hide'} did no damage to ${actor.name}`]
    if (actor.dead) {
      state.log = [...state.log, `${actor.name} has fallen`]
      return
    }
  }
}

export function playCard(
  state: CombatState,
  playerId: string,
  cardUid: string,
  context: PlayContext = { enemyUid: null, playerId: null },
): CombatState {
  if ((state.pendingTriggers?.length ?? 0) > 0) return state
  const forced = state.startTurnProgress?.forcedCard
  const forcedPlay = (state.phase === 'start' || state.phase === 'player') &&
    forced?.playerId === playerId && forced.cardUid === cardUid
  if (forced && !forcedPlay) return state
  if (state.phase !== 'player' && !forcedPlay) return state
  const player = findPlayer(state, playerId)
  if (!player || player.dead) return state

  const held = player.hand.find((card) => card.uid === cardUid)
  if (!held) return state

  const def = faceOf(cardDef(held.defId), held.upgraded)
  if (player.cardPlayLocked) return forcedPlay ? abandonForcedCard(state, playerId) : state
  if (reachedTimeWarpLimit(state, player)) {
    return forcedPlay ? abandonForcedCard(state, playerId) : state
  }
  if (!cardIsPlayable(def, state, player)) return state
  if (def.modes) {
    if (!Number.isInteger(context.mode) || context.mode! < 0 || context.mode! >= def.modes.length) return state
    if (!cardModeIsAvailable(def, state, player, context.mode!, player.draw.length, held.uid)) return state
  } else if (context.mode !== undefined) return state
  const effects = def.modes ? def.modes[context.mode!]!.effects : def.effects
  const resolvesOnPlay = def.type !== 'power' || def.resolvesOnPlay === true
  const printedCost = forcedPlay ? 0 : playCost(def, player, held)
  if (def.cost === 'X' && printedCost !== 'X' && printedCost < (def.minimumX ?? 0)) return state
  const xCost = printedCost === 'X'
  if (xCost && (!Number.isInteger(context.energySpent) || context.energySpent! < (def.minimumX ?? 0) ||
    context.energySpent! > player.energy)) return state
  if (!xCost && context.energySpent !== undefined && context.energySpent !== 0) return state
  const cost = xCost ? context.energySpent! : printedCost
  const effectEnergy = def.cost === 'X' ? cost : 0
  const miracleOnCard = context.spendMiracle === true
  if (forcedPlay && miracleOnCard) return state
  if (miracleOnCard && (
    player.miracles < 1 || player.energy !== CAPS.energy || def.cost === 'X' || cost === 0
  )) return state
  if (cost > player.energy + (miracleOnCard ? 1 : 0)) return state
  // Choices are checked together at the trust boundary. The same validator is
  // reused when the physical card resolves after its separately targeted copy.
  if (resolvesOnPlay && !cardResolutionChoicesAreValid(
    state, player, def, effects, context, effectEnergy, held.uid,
  )) return state
  const next = clone(state)
  const actor = findPlayer(next, playerId)
  // The player was just found in `state`, so a clone must contain them too.
  // Returning `state` here would masquerade as "illegal move" and hide a bug.
  if (!actor) throw new Error(`player ${playerId} vanished from the cloned state`)
  const akabeko = def.type === 'attack' && (actor.akabekoAttacks ?? 0) > 0
  if (akabeko) {
    actor.strength = gainStrength(actor.strength, 1)
    actor.akabekoAttacks!--
  }

  // A card can be played twice by only one effect; later effects wait for the
  // next valid card (rulebook p.24). Burst itself explicitly cannot be copied.
  // The first resolution below is the virtual copy; the physical original
  // stays outside every pile and resolves through `playCardCopy` afterwards.
  const copySources = copySourcesFor(def, actor)
  const doubled = copySources.length > 0
  consumeCopySource(actor, copySources)
  addPresentationEvent(next, {
    kind: 'card',
    actorId: actor.id,
    sourceId: def.id,
    upgraded: held.upgraded,
    copied: doubled,
    energy: cost,
    ...(context.mode === undefined ? {} : { mode: context.mode }),
    ...presentationTargets(next, actor.id,
      presentationEnemyScope(def, effects, actor, !context.evokeEnemyUids, effectEnergy),
      def.supportTarget ?? 'self', presentationCardContext(def, effects, context)),
  })

  // The card leaves hand before resolving and belongs to no pile until cleanup,
  // which is what stops a card that draws from drawing itself (p.12).
  const forcedChoices = forcedPlay ? [...(state.startTurnProgress?.choices ?? [])] : null
  if (forcedPlay) next.startTurnProgress = undefined
  actor.hand = actor.hand.filter((card) => card.uid !== cardUid)
  actor.energy -= cost
  actor.nextCardCost = null
  if ((actor.freeCardsThisTurn ?? 0) > 0) actor.freeCardsThisTurn = actor.freeCardsThisTurn! - 1
  if (def.type === 'attack' && (actor.freeAttacksThisTurn ?? 0) > 0) {
    actor.freeAttacksThisTurn = actor.freeAttacksThisTurn! - 1
  }
  if (miracleOnCard) {
    actor.miracles -= 1
    actor.energy += 1
    next.log = [...next.log, `${actor.name} spends a Miracle toward ${def.name}`]
  }
  actor.cardsPlayedThisTurn = (actor.cardsPlayedThisTurn ?? 0) + 1
  if (def.type === 'power') actor.powerPlayedThisTurn = true
  if (def.type === 'attack' || def.type === 'skill') {
    next.playedCardsThisTurn = [
      ...(next.playedCardsThisTurn ?? []),
      { playerId: actor.id, card: forgetRetain(held), copied: doubled },
    ]
  }

  // Logged before its effects resolve: appended afterwards, a kill the card
  // caused reads as OLDER than the card, which is nonsense in a newest-first
  // log.
  next.log = [...next.log, doubled
    ? `${actor.name} played ${def.name} copy (${copySources[0]})`
    : `${actor.name} played ${def.name}`]

  const scope: TargetScope = def.target ?? 'enemy'
  const supportScope: TargetScope = def.supportTarget ?? 'self'
  // A Power with a trigger does nothing when played: its effects are what the
  // trigger does, every time it fires. Resolving them here as well would pay
  // out Demon Form's Strength immediately AND at every Start of Turn.
  // `spentUids` and `shortfall` are this play's verdict, not the caller's
  // request, so they go on a copy. The caller's object is theirs: in the UI it
  // is assembled out of React state, and writing a scratch field back into it
  // would be a mutation from a function that is otherwise pure.
  const ctx = resolutionContext(context, def, held, effectEnergy, doubled)
  let remainingEffects: Effect[] | undefined
  if (resolvesOnPlay) {
    for (const [index, effect] of effects.entries()) {
      applyEffect(next, actor, effect, scope, supportScope, ctx)
      if (invalidPlayChoice(ctx)) return state
      // Combat endings are immediate (p.13), including halfway through a
      // card. Nothing printed later, nor cleanup or play triggers, resolves.
      if (cardResolutionIsOver(next, ctx, actor)) {
        if (akabeko) actor.strength = Math.max(0, actor.strength - 1)
        return finishForcedCardPlay(settle(next), forcedChoices)
      }
      if (ctx.doppelgangerCopy) {
        remainingEffects = effects.slice(index + 1)
        break
      }
    }
  }
  if (akabeko) actor.strength = Math.max(0, actor.strength - 1)

  // Havoc's child is part of Havoc's resolution. Its own cleanup, card-play
  // triggers, and Enraged reaction therefore wait until that child finishes.
  // A Havoc drawn by another Havoc extends the same small stack.
  if (def.id === 'havoc' && next.startTurnProgress?.forcedCard) {
    const corrupt = def.type === 'skill' && actor.powers.some((power) => cardDef(power.defId).corruptSkills)
    next.startTurnProgress.forcedCard.deferredHavocs = [
      ...(forced?.deferredHavocs ?? []),
      { card: forgetRetain(held), exhaust: def.exhaust === true ||
        (forcedPlay && forced.exhaustNonPower && def.type !== 'power') || corrupt,
      ...(doubled ? {
        copySourceNames: copySources,
        copyResumePhase: state.phase === 'start' ? 'start' as const : 'player' as const,
      } : {}) },
    ]
    next.startTurnProgress.forcedCard.pendingTriggers = [
      ...(forced?.pendingTriggers ?? []),
      ...(ctx.pendingTriggers ?? []),
    ]
    if (forcedChoices) {
      next.startTurnProgress.choices = forcedChoices.map((choice) => ({ ...choice }))
    }
    return settle(next)
  }

  // Survivor reads "2 Block. Discard 1 card." — the discard is the COST, not a
  // suggestion. Off the network an empty or bogus list would otherwise buy the
  // card's effects for nothing. The whole play is resolved into a clone first,
  // so refusing it here costs the caller nothing and still signals illegality
  // the way every other refusal does: by handing back the very same reference.
  if (invalidPlayChoice(ctx)) return state

  resolvePendingEnemyReactions(next, actor, ctx)
  if (combatIsOver(next)) return finishForcedCardPlay(settle(next), forcedChoices)
  for (const pending of ctx.pendingDiscards ?? []) {
    const owner = findPlayer(next, pending.playerId)
    if (owner) resolveDiscardReactions(next, owner, pending.cards)
    if (combatIsOver(next)) return finishForcedCardPlay(settle(next), forcedChoices)
  }

  if (ctx.doppelgangerCopy) {
    const corrupt = def.type === 'skill' && actor.powers.some((power) => cardDef(power.defId).corruptSkills)
    next.pendingCardCopy = {
      playerId: actor.id,
      card: ctx.doppelgangerCopy,
      energySpent: effectEnergy,
      resumePhase: state.phase === 'start' ? 'start' : 'player',
      forcedExhaust: ctx.queuedCopyForcedExhaust === true,
      forcedChoices,
      deferredHavocs: [
        ...(forced?.deferredHavocs ?? []),
        {
          card: forgetRetain(held),
          exhaust: def.exhaust === true ||
            (forcedPlay && forced.exhaustNonPower && def.type !== 'power') || corrupt,
          remainingEffects,
          ...(doubled ? {
            copySourceNames: copySources,
            copyResumePhase: state.phase === 'start' ? 'start' as const : 'player' as const,
          } : {}),
        },
      ],
      deferredTriggers: [
        ...(forced?.pendingTriggers ?? []),
        ...(ctx.pendingTriggers ?? []),
      ],
      sourceNames: ctx.queuedCopySourceNames ?? (ctx.queuedCopyTwice
        ? [ctx.queuedCopySource ?? 'Doppelganger', ctx.queuedCopySource ?? 'Doppelganger']
        : [ctx.queuedCopySource ?? 'Doppelganger']),
      virtualOnly: ctx.queuedCopyVirtualOnly ?? true,
      queuedWeaves: ctx.queuedWeaves,
      queuedCopySources: ctx.queuedCopySources,
      consumeFreeCard: ctx.consumeQueuedFreeCard,
      consumeFreeAttack: ctx.consumeQueuedFreeAttack,
    }
    next.phase = 'copy'
    const settled = settle(next)
    return actor.cardPlayLocked || reachedTimeWarpLimit(settled, actor)
      ? skipCardCopy(settled, actor.id, actor.cardPlayLocked ? 'was skipped by Conclude' : 'was skipped by Time Warp')
      : settled
  }

  if (!doubled) cleanupPlayedCard(next, actor, held, def, ctx,
    forcedPlay && forced.exhaustNonPower && def.type !== 'power')

  for (const pending of ctx.pendingExhaustTriggers ?? []) {
    const owner = findPlayer(next, pending.playerId)
    if (owner) resolveExhaustReaction(next, owner, pending.card)
    if (combatIsOver(next)) return finishForcedCardPlay(settle(next), forcedChoices)
  }

  for (const ownerId of ctx.pendingPoisonTriggers ?? []) {
    const owner = findPlayer(next, ownerId)
    if (owner) fireTriggers(next, { kind: 'onApplyPoison' }, owner)
    if (combatIsOver(next)) return finishForcedCardPlay(settle(next), forcedChoices)
  }

  for (const pending of ctx.pendingEnemyTokenTriggers ?? []) {
    const owner = findPlayer(next, pending.playerId)
    if (owner) fireTriggers(next, { kind: 'onPutEnemyToken', enemyUid: pending.enemyUid }, owner)
    if (combatIsOver(next)) return finishForcedCardPlay(settle(next), forcedChoices)
  }

  if (def.type === 'attack' && !ctx.sourceAttackCounted) {
    actor.attacksPlayedThisTurn = (actor.attacksPlayedThisTurn ?? 0) + 1
  }

  // "Abilities triggered by a card do not take effect until the card has
  // finished resolving all of its text" (p.12). A doubled card stays outside
  // every pile until both resolutions finish, so only that exceptional cleanup waits.
  // `held.uid` is excluded: a Power that reacts to cards being played was not
  // in front of you when THIS card was played, so it does not see it.
  fireTriggers(next, { kind: 'onPlayCard', cardType: def.type }, actor, held.uid)
  if (combatIsOver(next)) return finishForcedCardPlay(settle(next), forcedChoices)

  if (def.type === 'skill') resolveEnraged(next, actor)
  if (combatIsOver(next)) return finishForcedCardPlay(settle(next), forcedChoices)

  if (doubled) {
    next.pendingCardCopy = {
      playerId: actor.id,
      card: { ...held },
      energySpent: effectEnergy,
      resumePhase: state.phase === 'start' ? 'start' : 'player',
      forcedExhaust: forcedPlay && forced.exhaustNonPower && def.type !== 'power',
      forcedChoices,
      deferredHavocs: [...(forced?.deferredHavocs ?? [])],
      sourceNames: copySources,
    }
    next.phase = 'copy'
    next.log = [...next.log, `${actor.name}'s ${copySources[0]} copy finished; ${def.name} remains to resolve`]
    releasePendingTriggers(next, ctx)
    const settled = settle(next)
    return actor.cardPlayLocked || reachedTimeWarpLimit(settled, actor)
      ? skipCardCopy(settled, actor.id, actor.cardPlayLocked ? 'was skipped by Conclude' : 'was skipped by Time Warp')
      : settled
  }

  const resumedTriggers = finishDeferredHavocs(next, actor, forced?.deferredHavocs ?? [])
  ctx.pendingTriggers = [
    ...(forced?.pendingTriggers ?? []), ...(ctx.pendingTriggers ?? []), ...resumedTriggers,
  ]
  releasePendingTriggers(next, ctx)
  return finishForcedCardPlay(settleForbiddenPendingCopy(next, actor), forcedChoices)
}

/** Resolves the physical original after its separately targeted virtual copy. */
export function playCardCopy(
  state: CombatState,
  playerId: string,
  context: PlayContext = { enemyUid: null, playerId: null },
): CombatState {
  if ((state.pendingTriggers?.length ?? 0) > 0) return state
  const pending = state.pendingCardCopy
  if (state.phase !== 'copy' || !pending || pending.playerId !== playerId) return state
  const player = findPlayer(state, playerId)
  if (!player || player.dead) return state
  if (player.cardPlayLocked) return skipCardCopy(state, playerId, 'was skipped by Conclude')
  if (reachedTimeWarpLimit(state, player)) return skipCardCopy(state, playerId, 'was skipped by Time Warp')
  const def = faceOf(cardDef(pending.card.defId), pending.card.upgraded)
  const sourceName = pending.sourceNames[0]
  if ((sourceName === 'Double Tap' && def.type !== 'attack') ||
    (sourceName === 'Blasphemy' && def.type !== 'attack') ||
    (sourceName === 'Omniscience' && def.type !== 'attack' && def.type !== 'skill') ||
    (sourceName === 'Weave' && def.id !== 'weave') ||
    (sourceName === 'Echo Form' && def.type !== 'attack' && def.type !== 'skill') ||
    (sourceName === 'Burst' && def.type !== 'skill') ||
    (sourceName === 'Doppelganger' && def.type !== 'attack' && def.type !== 'skill')) return state
  if (def.modes) {
    if (!Number.isInteger(context.mode) || context.mode! < 0 || context.mode! >= def.modes.length) return state
    if (!cardModeIsAvailable(def, state, player, context.mode!)) return state
  } else if (context.mode !== undefined) return state
  const effects = def.modes ? def.modes[context.mode!]!.effects : def.effects
  if (!cardResolutionChoicesAreValid(state, player, def, effects, context, pending.energySpent)) return state

  const next = clone(state)
  const copy = next.pendingCardCopy!
  const actor = findPlayer(next, playerId)!
  addPresentationEvent(next, {
    kind: 'card',
    actorId: actor.id,
    sourceId: def.id,
    upgraded: copy.card.upgraded,
    copied: copy.virtualOnly === true || copy.sourceNames.length > 1,
    energy: copy.energySpent,
    ...(context.mode === undefined ? {} : { mode: context.mode }),
    ...presentationTargets(next, actor.id,
      presentationEnemyScope(def, effects, actor, !context.evokeEnemyUids, pending.energySpent),
      def.supportTarget ?? 'self', presentationCardContext(def, effects, context)),
  })
  if ((copy.queuedCopySources?.length ?? 0) > 0) {
    consumeCopySource(actor, copy.queuedCopySources!)
    copy.queuedCopySources = []
  }
  if (copy.consumeFreeCard) actor.freeCardsThisTurn = Math.max(0, (actor.freeCardsThisTurn ?? 0) - 1)
  if (copy.consumeFreeAttack) actor.freeAttacksThisTurn = Math.max(0, (actor.freeAttacksThisTurn ?? 0) - 1)
  actor.cardsPlayedThisTurn = (actor.cardsPlayedThisTurn ?? 0) + 1
  if (def.type === 'attack' || def.type === 'skill') {
    next.playedCardsThisTurn = [
      ...(next.playedCardsThisTurn ?? []),
      {
        playerId: actor.id,
        card: forgetRetain(copy.card),
        copied: copy.virtualOnly === true || copy.sourceNames.length > 1,
      },
    ]
  }
  const ctx = resolutionContext(
    context, def, copy.card, copy.energySpent,
    copy.virtualOnly === true || copy.sourceNames.length > 1,
  )
  next.log = [...next.log, `${actor.name} played ${def.name}`]

  let remainingEffects: Effect[] | undefined
  for (const [index, effect] of effects.entries()) {
    applyEffect(next, actor, effect, def.target ?? 'enemy', def.supportTarget ?? 'self', ctx)
    if (invalidPlayChoice(ctx)) return state
    if (cardResolutionIsOver(next, ctx, actor)) {
      delete next.pendingCardCopy
      return finishForcedCardPlay(settle(next), copy.forcedChoices)
    }
    if (ctx.doppelgangerCopy) {
      remainingEffects = effects.slice(index + 1)
      break
    }
  }
  // The forced child is part of a copied Havoc. Suspend this copy until that
  // child finishes, just as the copied Havoc does above.
  if (def.id === 'havoc' && next.startTurnProgress?.forcedCard) {
    next.startTurnProgress.forcedCard.deferredHavocs = [
      ...copy.deferredHavocs,
      { card: { ...copy.card }, exhaust: copy.forcedExhaust, virtualOnly: copy.virtualOnly,
        ...(copy.sourceNames.length > 1 ? {
          copySourceNames: copy.sourceNames.slice(1) as CopySource[],
          copyResumePhase: copy.resumePhase,
        } : {}) },
    ]
    next.startTurnProgress.forcedCard.pendingTriggers = [...(ctx.pendingTriggers ?? [])]
    if (copy.deferredTriggers?.length) {
      next.startTurnProgress.forcedCard.pendingTriggers.push(...copy.deferredTriggers)
    }
    if (copy.forcedChoices) {
      next.startTurnProgress.choices = copy.forcedChoices.map((choice) => ({ ...choice }))
    }
    delete next.pendingCardCopy
    next.phase = copy.resumePhase
    return settle(next)
  }
  if (invalidPlayChoice(ctx)) return state

  resolvePendingEnemyReactions(next, actor, ctx)
  if (combatIsOver(next)) {
    delete next.pendingCardCopy
    return finishForcedCardPlay(settle(next), copy.forcedChoices)
  }

  for (const pendingDiscard of ctx.pendingDiscards ?? []) {
    const owner = findPlayer(next, pendingDiscard.playerId)
    if (owner) resolveDiscardReactions(next, owner, pendingDiscard.cards)
    if (combatIsOver(next)) {
      delete next.pendingCardCopy
      return finishForcedCardPlay(settle(next), copy.forcedChoices)
    }
  }
  const finalCopy = copy.sourceNames.length === 1
  if (ctx.doppelgangerCopy) {
    const corrupt = def.type === 'skill' && actor.powers.some((power) => cardDef(power.defId).corruptSkills)
    next.pendingCardCopy = {
      playerId: actor.id,
      card: ctx.doppelgangerCopy,
      energySpent: copy.energySpent,
      resumePhase: copy.resumePhase,
      forcedExhaust: ctx.queuedCopyForcedExhaust === true,
      forcedChoices: copy.forcedChoices,
      deferredHavocs: [
        ...copy.deferredHavocs,
        { card: forgetRetain(copy.card), exhaust: def.exhaust === true || copy.forcedExhaust || corrupt,
          virtualOnly: copy.virtualOnly,
          remainingEffects,
          ...(copy.sourceNames.length > 1 ? {
            copySourceNames: copy.sourceNames.slice(1) as CopySource[],
            copyResumePhase: copy.resumePhase,
          } : {}) },
      ],
      deferredTriggers: [...(copy.deferredTriggers ?? []), ...(ctx.pendingTriggers ?? [])],
      sourceNames: ctx.queuedCopySourceNames ?? (ctx.queuedCopyTwice
        ? [ctx.queuedCopySource ?? 'Doppelganger', ctx.queuedCopySource ?? 'Doppelganger']
        : [ctx.queuedCopySource ?? 'Doppelganger']),
      virtualOnly: ctx.queuedCopyVirtualOnly ?? true,
      queuedWeaves: ctx.queuedWeaves,
      queuedCopySources: ctx.queuedCopySources,
      consumeFreeCard: ctx.consumeQueuedFreeCard,
      consumeFreeAttack: ctx.consumeQueuedFreeAttack,
    }
    next.phase = 'copy'
    const settled = settle(next)
    return actor.cardPlayLocked || reachedTimeWarpLimit(settled, actor)
      ? skipCardCopy(settled, actor.id, actor.cardPlayLocked ? 'was skipped by Conclude' : 'was skipped by Time Warp')
      : settled
  }
  if (finalCopy && !copy.virtualOnly) cleanupPlayedCard(next, actor, copy.card, def, ctx, copy.forcedExhaust)
  for (const pendingExhaust of ctx.pendingExhaustTriggers ?? []) {
    const owner = findPlayer(next, pendingExhaust.playerId)
    if (owner) resolveExhaustReaction(next, owner, pendingExhaust.card)
    if (combatIsOver(next)) {
      delete next.pendingCardCopy
      return finishForcedCardPlay(settle(next), copy.forcedChoices)
    }
  }
  for (const ownerId of ctx.pendingPoisonTriggers ?? []) {
    const owner = findPlayer(next, ownerId)
    if (owner) fireTriggers(next, { kind: 'onApplyPoison' }, owner)
    if (combatIsOver(next)) {
      delete next.pendingCardCopy
      return finishForcedCardPlay(settle(next), copy.forcedChoices)
    }
  }
  for (const pendingToken of ctx.pendingEnemyTokenTriggers ?? []) {
    const owner = findPlayer(next, pendingToken.playerId)
    if (owner) fireTriggers(next, { kind: 'onPutEnemyToken', enemyUid: pendingToken.enemyUid }, owner)
    if (combatIsOver(next)) {
      delete next.pendingCardCopy
      return finishForcedCardPlay(settle(next), copy.forcedChoices)
    }
  }

  if (def.type === 'attack' && !ctx.sourceAttackCounted) {
    actor.attacksPlayedThisTurn = (actor.attacksPlayedThisTurn ?? 0) + 1
  }
  fireTriggers(next, { kind: 'onPlayCard', cardType: def.type }, actor, copy.card.uid)
  if (def.type === 'skill') resolveEnraged(next, actor)
  if (combatIsOver(next)) {
    delete next.pendingCardCopy
    return finishForcedCardPlay(settle(next), copy.forcedChoices)
  }
  if (!finalCopy) {
    copy.sourceNames = copy.sourceNames.slice(1)
    next.log = [...next.log, `${actor.name}'s ${copy.sourceNames[0]} copy finished; ${def.name} remains to resolve`]
    releasePendingTriggers(next, ctx)
    const settled = settle(next)
    return actor.cardPlayLocked || reachedTimeWarpLimit(settled, actor)
      ? skipCardCopy(settled, actor.id, actor.cardPlayLocked ? 'was skipped by Conclude' : 'was skipped by Time Warp')
      : settled
  }
  if (copy.queuedWeaves?.length) {
    const woven = copy.queuedWeaves[0]!
    const queuedWeaves = copy.queuedWeaves.slice(1)
    const weave = faceOf(cardDef(woven.defId), woven.upgraded)
    const queuedCopySources = copySourcesFor(weave, actor)
    const sourceNames = queuedCopySources.length > 0
      ? [...queuedCopySources, queuedCopySources.at(-1)!]
      : ['Weave' as const]
    next.pendingCardCopy = {
      playerId: actor.id,
      card: { ...woven, scryDamageBonus: weave.scryPlayBonus },
      energySpent: 0,
      resumePhase: copy.resumePhase,
      forcedExhaust: false,
      forcedChoices: copy.forcedChoices,
      deferredHavocs: copy.deferredHavocs,
      deferredTriggers: [...(copy.deferredTriggers ?? []), ...(ctx.pendingTriggers ?? [])],
      sourceNames,
      queuedWeaves,
      queuedCopySources,
      consumeFreeCard: (actor.freeCardsThisTurn ?? 0) > 0,
      consumeFreeAttack: (actor.freeAttacksThisTurn ?? 0) > 0,
    }
    next.phase = 'copy'
    const settled = settle(next)
    return actor.cardPlayLocked || reachedTimeWarpLimit(settled, actor)
      ? skipCardCopy(settled, actor.id, actor.cardPlayLocked ? 'was skipped by Conclude' : 'was skipped by Time Warp')
      : settled
  }
  delete next.pendingCardCopy
  next.phase = copy.resumePhase
  const resumedTriggers = finishDeferredHavocs(next, actor, copy.deferredHavocs)
  ctx.pendingTriggers = [
    ...(copy.deferredTriggers ?? []), ...(ctx.pendingTriggers ?? []), ...resumedTriggers,
  ]
  releasePendingTriggers(next, ctx)
  return finishCardCopy(settleForbiddenPendingCopy(next, actor), copy.forcedChoices)
}

function skipCardCopy(state: CombatState, playerId: string, reason: string): CombatState {
  const pending = state.pendingCardCopy
  if (state.phase !== 'copy' || !pending || pending.playerId !== playerId) return state
  const next = clone(state)
  const copy = next.pendingCardCopy!
  const actor = findPlayer(next, playerId)
  if (!actor) return state
  delete next.pendingCardCopy
  next.phase = copy.resumePhase
  const def = faceOf(cardDef(copy.card.defId), copy.card.upgraded)
  const ctx = resolutionContext({ enemyUid: null, playerId }, def, copy.card, copy.energySpent)
  if (!copy.virtualOnly) cleanupPlayedCard(next, actor, copy.card, def, ctx, copy.forcedExhaust)
  for (const woven of copy.queuedWeaves ?? []) actor.discard.push(forgetRetain(woven))
  for (const pendingExhaust of ctx.pendingExhaustTriggers ?? []) {
    const owner = findPlayer(next, pendingExhaust.playerId)
    if (owner) resolveExhaustReaction(next, owner, pendingExhaust.card)
  }
  next.log = [...next.log, copy.virtualOnly
    ? `${actor.name}'s ${copy.sourceNames[0]} copy of ${def.name} ${reason}`
    : `${actor.name}'s original ${def.name} ${reason}`]
  const resumedTriggers = finishDeferredHavocs(next, actor, copy.deferredHavocs)
  releasePendingTriggers(next, {
    enemyUid: null,
    playerId: actor.id,
    pendingTriggers: [...(copy.deferredTriggers ?? []), ...resumedTriggers],
  })
  return finishCardCopy(settleForbiddenPendingCopy(next, actor), copy.forcedChoices)
}

/** Releases a disconnected owner without letting the rest of the party deadlock. */
export function abandonCardCopy(state: CombatState, playerId: string): CombatState {
  return skipCardCopy(state, playerId, 'was skipped after disconnecting')
}

/** Privately previews the original card's post-copy draw or Scry choice. */
export function previewCardCopyChoice(state: CombatState, playerId: string): CardChoicePreview | null {
  const pending = state.pendingCardCopy
  const player = findPlayer(state, playerId)
  if (state.phase !== 'copy' || !pending || pending.playerId !== playerId || !player || player.dead ||
    player.cardPlayLocked || reachedTimeWarpLimit(state, player)) return null
  const def = faceOf(cardDef(pending.card.defId), pending.card.upgraded)
  if (!cardNeedsChoicePreview(def, state, player)) return null

  const preview = clone(state)
  const actor = findPlayer(preview, playerId)!
  let drew = false
  for (const effect of def.effects) {
    if (!effectIsActive(effect, preview, actor)) continue
    if (effect.kind === 'searchDraw' || effect.kind === 'searchDrawAndPlayTwice') {
      return { kind: 'search', cards: effect.kind === 'searchDraw'
        ? actor.draw
        : omniscienceEligibleCards(preview, actor) }
    } else if (effect.kind === 'draw') {
      drawInto(preview, actor, amountOf(effect.amount, preview, actor, undefined, {
        enemyUid: null, playerId, energySpent: pending.energySpent,
      }), [])
      drew = true
    } else if (effect.kind === 'scry') {
      return { kind: 'scry', cards: actor.draw.slice(0, effect.amount) }
    } else if (drew && effect.kind === 'discard') {
      return { kind: 'discard', cards: actor.hand }
    } else if (drew && effect.kind === 'topdeck') {
      return { kind: 'topdeck', cards: actor.hand }
    }
  }
  return null
}

/** Activates a printed once-per-turn Power during the shared Player Turn. */
export function activatePower(
  state: CombatState,
  playerId: string,
  powerUid: string,
  context: PowerContext = {},
): CombatState {
  if (state.phase !== 'player' || state.startTurnProgress?.forcedCard ||
    (state.pendingTriggers?.length ?? 0) > 0) return state
  const player = findPlayer(state, playerId)
  const held = player?.powers.find((power) => power.uid === powerUid)
  if (!player || player.dead || !held) return state
  const def = faceOf(cardDef(held.defId), held.upgraded)
  if (!def.activeAbility || !def.oncePerTurn || powerAbilityUsed(state, playerId, powerUid)) return state
  if (def.target === 'row') {
    if (!rowExists(state, context.enemyRow)) return state
  } else if (cardNeedsEnemy(def, player, true, undefined, true) &&
    resolveEnemyTargets(state, def.target ?? 'enemy', context.enemyUid ?? null).length === 0) return state

  const next = clone(state)
  const actor = findPlayer(next, playerId)!
  next.powerTriggersUsedThisTurn.push(powerAbilityKey(playerId, powerUid))
  const playContext: PlayContext = {
    enemyUid: context.enemyUid ?? null,
    enemyRow: context.enemyRow,
    playerId,
    sourcePowerUid: powerUid,
  }
  for (const effect of def.effects) {
    applyEffect(next, actor, effect, def.target ?? 'enemy', def.supportTarget ?? 'self', playContext,
      `${actor.name}'s ${def.name}`)
    if (combatIsOver(next)) return settle(next)
  }
  return settle(next)
}

/** Settles a disconnected owner's private forced card and resumes queued abilities. */
export function abandonForcedCard(state: CombatState, playerId: string): CombatState {
  const forced = state.startTurnProgress?.forcedCard
  if ((state.phase !== 'start' && state.phase !== 'player') || forced?.playerId !== playerId ||
    typeof forced.cardUid !== 'string') return state
  const next = clone(state)
  const actor = findPlayer(next, playerId)
  const card = actor?.hand.find((held) => held.uid === forced.cardUid)
  if (!actor || !card) return state
  const choices = [...(next.startTurnProgress?.choices ?? [])]
  next.startTurnProgress = undefined
  if (forced.exhaustNonPower && faceOf(cardDef(card.defId), card.upgraded).type !== 'power') {
    actor.hand = actor.hand.filter((held) => held.uid !== card.uid)
    exhaustCards(next, actor, [card])
  } else {
    discardByCardEffect(next, actor, [card])
  }
  next.log = [...next.log, `${actor.name}'s ${cardDef(forced.sourceCardId ?? 'mayhem').name} card was settled after disconnecting`]
  const resumedTriggers = finishDeferredHavocs(next, actor, forced.deferredHavocs ?? [])
  releasePendingTriggers(next, {
    enemyUid: null,
    playerId: actor.id,
    pendingTriggers: [...(forced.pendingTriggers ?? []), ...resumedTriggers],
  })
  return finishForcedCardPlay(settleForbiddenPendingCopy(next, actor), choices)
}
