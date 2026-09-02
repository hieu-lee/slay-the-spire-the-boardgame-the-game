// What the rules say before anything moves.
//
// What a card costs on this board, whether its printed condition holds, what
// number a clause actually uses once the board has been read, and which choices
// the player still owes before it can resolve.
//
// Every function here is a question, not an action: none of them changes the
// state, so a UI can call them to grey out a card or count a prompt without
// risking a half-resolved play.
import { findPlayer, resolveEnemyTargets } from './board.ts'
import type { CombatState, CopySource, CountablePlayer, EvokeChoice, PlayContext } from './types.ts'
import { cardCost, cardDef, faceOf, isStarterStrikeOrDefend } from '../cards.ts'
import type { Amount, CardDef, Condition, CountOf, Effect } from '../cards.ts'
import { actionsFor, enemyAbilities, enemyDef } from '../enemies.ts'
import { CAPS } from '../types.ts'
import type { CardInstance, Enemy, GuardianMode, OrbType, Player } from '../types.ts'
import { previewSlimeCommand, slimeDef } from '../downfall/slime-boss.ts'
import type { SlimeBossEffect } from '../downfall/slime-boss.ts'

const GUARDIAN_ROW_CARDS = new Set(['guardian_prismatic_spray', 'guardian_sentry_beam'])
const GUARDIAN_UPGRADED_ROW_CARDS = new Set(['guardian_roll_attack', 'guardian_vent_steam'])
const GUARDIAN_ATTACK_MODE_ROW_CARDS = new Set([
  'guardian_guardian_whirl', 'guardian_giga_beam', 'guardian_refracted_beam',
])

export function effectiveCombatCardDef(def: CardDef, guardianMode?: GuardianMode | null): CardDef {
  const effective: CardDef = def.guardianVariableType && guardianMode === 'defense'
    ? { ...def, type: 'skill' }
    : def
  const targetsRow = GUARDIAN_ROW_CARDS.has(def.id) ||
    GUARDIAN_UPGRADED_ROW_CARDS.has(def.id) && def.guardian?.sourceText.includes('[aoe]') === true ||
    GUARDIAN_ATTACK_MODE_ROW_CARDS.has(def.id) && guardianMode === 'attack'
  return targetsRow ? { ...effective, target: 'row' } : effective
}

export function cardReferencesGuardianMode(def: CardDef, attachedGemId?: string): boolean {
  return def.guardianVariableType === true ||
    /\b(?:Attack|Defense) Mode\b|\bMode Shift\b|\[mode-shift\]/i.test(def.guardian?.sourceText ?? '') ||
    attachedGemId !== undefined && cardReferencesGuardianMode(cardDef(attachedGemId))
}

function timeWarpLimit(state: CombatState): number {
  const eater = state.enemies.find((enemy) => !enemy.dead &&
    enemyAbilities(enemyDef(enemy.defId, enemy.ascension)).some((ability) => ability.kind === 'timeWarp'))
  const warp = eater && enemyAbilities(enemyDef(eater.defId, eater.ascension))
    .find((ability) => ability.kind === 'timeWarp')
  return warp?.kind === 'timeWarp'
    ? warp.limits[eater!.actionIndex] ?? Number.POSITIVE_INFINITY
    : Number.POSITIVE_INFINITY
}

export function reachedTimeWarpLimit(state: CombatState, player: Player): boolean {
  return (player.cardsPlayedThisTurn ?? 0) >= timeWarpLimit(state)
}

/** Mandatory Downfall choices freeze every voluntary combat action until resolved. */
export function mandatoryChoicePending(state: CombatState | null | undefined, allowHermitChamberPlay = false): boolean {
  if (!state) return false
  return (state.pendingPlunderSwitches?.length ?? 0) > 0 ||
    (state.pendingDieRelicChoices?.length ?? 0) > 0 ||
    (state.pendingHermitSetupLoads?.length ?? 0) > 0 ||
    (!allowHermitChamberPlay && (state.pendingHermitChamberPlays?.length ?? 0) > 0) ||
    (state.pendingHermitStrengthRewards?.length ?? 0) > 0
}

/** A printed active Power may be used anywhere in the Player Turn, but not mid-step. */
export function activePowerWindow(state: Pick<CombatState, 'phase' | 'startTurnProgress'>): boolean {
  if (state.phase === 'player' || state.phase === 'discard') return true
  return state.phase === 'start' && !state.startTurnProgress?.beforeDraw &&
    !state.startTurnProgress?.rollPending && !state.startTurnProgress?.pauseAfterDraw &&
    !state.startTurnProgress?.discard
}

/** Every rule that makes this physical card count as having Retain. */
export function cardHasRetain(player: { powers?: readonly CardInstance[] }, card: CardInstance): boolean {
  const def = faceOf(cardDef(card.defId), card.upgraded)
  return def.retain === true || guardianGemForCard(player, card) === 'guardian_onyx' ||
    player.powers?.some((power) => power.defId === 'guardian_future_plans') === true &&
      def.guardian?.sourceText.includes('Attack Mode') === true
}

/** Power Beam may pull one Power from either private pile, but never its source card. */
export function guardianPowerBeamCards(player: Player, sourceCardUid?: string): CardInstance[] {
  return [...player.hand.filter((card) => card.uid !== sourceCardUid), ...player.discard]
    .filter((card) => faceOf(cardDef(card.defId), card.upgraded).type === 'power')
}

/** Crystallize's socketed Gem is printed onto every starter Strike while the Power is active. */
export function guardianGemForCard(
  player: { powers?: readonly CardInstance[] },
  card: CardInstance,
): string | undefined {
  if (card.attachedGemId) return card.attachedGemId
  if (!isStarterStrikeOrDefend(card.defId, 'Strike')) return undefined
  return player.powers?.find((power) => power.defId === 'guardian_crystallize')?.attachedGemId
}

/** The Energy actually charged for a card on this player's current board. */
export function playCost(
  def: CardDef,
  player: Pick<Player, 'powers' | 'relics' | 'lostHpThisCombat' | 'freeCardsThisTurn' | 'nextCardCost' | 'enemyNextCardCost' | 'freeAttacksThisTurn' | 'freeGemCardsThisTurn' | 'freePowersThisTurn' | 'nextPowerOrSlimeDiscount' | 'energySpentThisTurn' | 'exhaust' | 'heat' | 'chamber' | 'attacksPlayedThisTurn' | 'guardianMode'> & { hand: readonly CardInstance[] | null },
  card?: Pick<CardInstance, 'freeThisTurn' | 'costReductionThisTurn' | 'stasisRetained' | 'hermitDeadOn'>,
): number | 'X' {
  if (player.enemyNextCardCost !== null && player.enemyNextCardCost !== undefined) return player.enemyNextCardCost
  if (card?.freeThisTurn === true || (player.freeCardsThisTurn ?? 0) > 0 ||
    card?.stasisRetained === true ||
    (def.type === 'attack' && (player.freeAttacksThisTurn ?? 0) > 0) ||
    (def.guardian?.printedType.startsWith('Gem') && (player.freeGemCardsThisTurn ?? 0) > 0) ||
    (def.type === 'power' && ((player.freePowersThisTurn ?? 0) > 0 ||
      player.powers.some((power) => power.defId === 'guardian_construction_form')))
  ) return 0
  if (def.costAfterSpentTwoEnergy !== undefined && (player.energySpentThisTurn ?? 0) >= 2) return def.costAfterSpentTwoEnergy
  const cost = player.nextCardCost ?? cardCost(def, player.powers, player.lostHpThisCombat)
  if (cost === 'X') return cost
  const retainDiscount = def.retainCostReduction
    ? (player.hand ?? []).filter((held) => cardHasRetain(player, held)).length : 0
  const tackleDiscount = def.tackleCostReduction
    ? Math.max(0, (player.hand ?? []).filter((held) => cardDef(held.defId).name.includes('Tackle')).length - 1) : 0
  const nextDiscount = def.type === 'power' || def.cardKind === 'slime' ? player.nextPowerOrSlimeDiscount : undefined
  if (nextDiscount === 'free') return 0
  if (def.hermit?.costZeroWhenDeadOn && card?.hermitDeadOn) return 0
  const hermitDiscount = def.hermit?.costReductionBy === 'attacksInChamber'
    ? player.chamber.filter((held) => effectiveCombatCardDef(
      faceOf(cardDef(held.defId), held.upgraded), player.guardianMode,
    ).type === 'attack').length
    : def.hermit?.costReductionBy === 'starterCards'
      ? [...(player.hand ?? []), ...player.chamber].filter((held) => ['Strike', 'Defend'].includes(cardDef(held.defId).name) && cardDef(held.defId).rarity === 'starter').length
      : def.hermit?.costReductionBy === 'attacksPlayed' ? player.attacksPlayedThisTurn
        : def.hermit?.costReductionBy === 'curses'
          ? [...(player.hand ?? []), ...player.chamber].filter((held) => faceOf(cardDef(held.defId), held.upgraded).type === 'curse').length : 0
  if (def.id === 'hermit_strike' && player.powers.some((power) => power.defId === 'hermit_maintenance')) return 0
  return Math.max(0, cost - (card?.costReductionThisTurn ?? 0) - retainDiscount - tackleDiscount - hermitDiscount - (nextDiscount ?? 0) -
    (def.exhaustCostReduction ?? 0) * (player.exhaust?.length ?? 0) - (def.heatCostReduction ?? 0) * (player.heat ?? 0))
}

/** The largest legal X on this board, including card-specific physical limits. */
export function maximumXEnergy(def: CardDef, actor: Player): number {
  if (def.id !== 'slime_boss_divide_conquer') return actor.energy
  const command = def.effects.find((effect) =>
    (effect as unknown as SlimeBossEffect).kind === 'commandSlime') as unknown as
    | Extract<SlimeBossEffect, { kind: 'commandSlime' }>
    | undefined
  const bonus = command && typeof command.amount !== 'number' ? command.amount.base : 0
  return Math.min(actor.energy, Math.max(0,
    actor.slimes.filter((slime) => previewSlimeCommand(slime) !== null).length - bonus))
}

/** Whether this card can resolve its selected-Slime clauses for this Slime. */
export function slimeChoiceIsAvailable(
  def: CardDef,
  state: CombatState,
  actor: Player,
  slimeUid: string,
  energySpent = 0,
): boolean {
  const slime = actor.slimes.find((candidate) => candidate.card.uid === slimeUid)
  if (!slime) return false
  const mustCommand = def.effects.some((raw) => {
    if (!effectIsActive(raw, state, actor)) return false
    const effect = raw as unknown as SlimeBossEffect
    return effect.kind === 'commandSlime' && !effect.all &&
      amountOf(effect.amount, state, actor, undefined, { enemyUid: null, playerId: actor.id, energySpent }) > 0 ||
      (effect.kind === 'growSlime' || effect.kind === 'gainSlimeVigor') && effect.commandAfter === true
  })
  return !mustCommand || previewSlimeCommand(slime) !== null
}

export function invalidPlayChoice(context: PlayContext): boolean {
  return Boolean(context.shortfall || context.invalidShivTarget || context.invalidEvokeTarget ||
    context.invalidScryChoice || context.invalidDiscardChoice || context.invalidExhaustChoice ||
    context.invalidTopdeckChoice || context.invalidRecoverChoice || context.invalidSearchChoice || context.invalidSlimeChoice ||
    context.invalidHermitChoice)
}

export function resolutionContext(
  context: PlayContext,
  def: CardDef,
  held: CardInstance,
  energySpent: number,
  sourceIsCopy = false,
): PlayContext {
  return {
    ...context,
    enemyUids: context.enemyUids ? [...context.enemyUids] : undefined,
    loadUids: context.loadUids ? [...context.loadUids] : undefined,
    chamberUids: context.chamberUids ? [...context.chamberUids] : undefined,
    hermitEnemyUids: context.hermitEnemyUids ? [...context.hermitEnemyUids] : undefined,
    hermitDieRelics: context.hermitDieRelics?.map((choice) => ({
      ...choice,
      ...(choice.discardUids ? { discardUids: [...choice.discardUids] } : {}),
    })),
    soulburnEnemyUids: context.soulburnEnemyUids ? [...context.soulburnEnemyUids] : undefined,
    playerIds: context.playerIds ? [...context.playerIds] : undefined,
    topdeckUids: context.topdeckUids ? [...context.topdeckUids] : undefined,
    recoverDiscardUids: context.recoverDiscardUids ? [...context.recoverDiscardUids] : undefined,
    recoverExhaustUids: context.recoverExhaustUids ? [...context.recoverExhaustUids] : undefined,
    searchDrawUids: context.searchDrawUids ? [...context.searchDrawUids] : undefined,
    scryDiscardUids: context.scryDiscardUids ? [...context.scryDiscardUids] : undefined,
    scryToHandUid: context.scryToHandUid,
    slimeUids: context.slimeUids ? [...context.slimeUids] : undefined,
    slimeEnemyUids: context.slimeEnemyUids ? [...context.slimeEnemyUids] : undefined,
    shivEnemyUids: context.shivEnemyUids ? [...context.shivEnemyUids] : undefined,
    evokeSlots: context.evokeSlots ? [...context.evokeSlots] : undefined,
    evokeEnemyUids: context.evokeEnemyUids ? [...context.evokeEnemyUids] : undefined,
    spentUids: new Set<string>(),
    shortfall: false,
    shivTargetIndex: 0,
    enemyChoiceIndex: 0,
    soulburnTargetIndex: 0,
    invalidShivTarget: false,
    evokeIndex: 0,
    evokeTargetIndex: 0,
    invalidEvokeTarget: false,
    invalidScryChoice: false,
    invalidDiscardChoice: false,
    invalidExhaustChoice: false,
    invalidTopdeckChoice: false,
    invalidRecoverChoice: false,
    invalidSearchChoice: false,
    slimeChoiceIndex: 0,
    slimeEnemyChoiceIndex: 0,
    pendingSlimeCommandUids: [],
    invalidSlimeChoice: false,
    invalidHermitChoice: false,
    loadChoiceIndex: 0,
    chamberChoiceIndex: 0,
    hermitEnemyChoiceIndex: 0,
    hermitDieRelicChoiceIndex: 0,
    discardedByCard: 0,
    exhaustedByCard: 0,
    exhaustedCardCost: undefined,
    pendingDiscards: [],
    pendingPoisonTriggers: [],
    pendingEnemyTokenTriggers: [],
    pendingEnemyDamage: [],
    pendingEnemyDeathUids: [],
    pendingAttackTargets: [],
    pendingTriggers: [],
    pendingExhaustTriggers: [],
    drewSkill: false,
    presentationSourceId: def.id,
    sourceRetainedLastTurn: held.retainedLastTurn === true,
    sourceCardType: def.type,
    sourceCardId: def.id,
    sourceCardUid: held.uid,
    sourceCardUpgraded: held.upgraded,
    sourceAttachedGemId: held.attachedGemId,
    sourceScryDamageBonus: held.scryDamageBonus,
    sourceHermitDeadOn: held.hermitDeadOn === true,
    sourcePlayedFromChamber: held.hermitDeadOn === true,
    sourceIsCopy,
    doppelgangerCopy: undefined,
    queuedCopySource: undefined,
    queuedCopyVirtualOnly: undefined,
    queuedCopyTwice: undefined,
    queuedCopyTwiceIfAttack: undefined,
    queuedCopyForcedExhaust: undefined,
    queuedCopySourceNames: undefined,
    sourceCounter: undefined,
    sourceAttached: false,
    energySpent,
    sourceAttackCounted: false,
    lastHitDamage: 0,
  }
}

export function overflowShivCount(state: { players: readonly { shivs: number }[] }, amount: number): number {
  const held = state.players.reduce((sum, player) => sum + player.shivs, 0)
  return Math.max(0, amount - Math.max(0, CAPS.shivs - held))
}

/**
 * Whether a conditional clause's condition holds right now.
 *
 * "Right now" is load-bearing: this is read as the clause resolves, not when
 * the card is played, so an earlier clause of the same card can change the
 * answer. No printed card does that yet — every condition here reads something
 * its own card leaves alone — but resolving them all up front would be a
 * decision, not a simplification, and the wrong one: the table reads a card
 * top to bottom.
 */
function holds(
  condition: Condition,
  state: CombatState,
  actor: Player,
  /** The enemy this clause is landing on, for conditions that read the target. */
  target?: Enemy,
): boolean {
  switch (condition.kind) {
    case 'hasShiv':
      return actor.shivs > 0
    case 'targetPoisoned':
      return (target?.poison ?? 0) > 0
    case 'discardTopCosts': {
      // The topmost card is the one most recently discarded, which is the end
      // of the array — the pile is stored bottom-first.
      const top = actor.discard.at(-1)
      if (!top) return false
      // The UPGRADED face's cost, when that is the face in the pile: upgrading
      // a card to 0 is the ordinary way a player turns Steam Barrier on.
      const face = faceOf(cardDef(top.defId), top.upgraded)
      // An unplayable card has NO cost -- p.24, and the scans print no energy
      // gem at all on one. `CARDS.daze` stores 0 because the field is not
      // optional, and that placeholder made a Daze read as a 0-cost card and
      // pay out Steam Barrier's bonus. Reachable in ordinary play: an enemy
      // deals a Daze, it cannot be played, and it is left on top of the discard
      // by the end-of-turn sweep precisely because everything else WAS played.
      if (face.unplayable) return false
      return cardCost(face, actor.powers, actor.lostHpThisCombat) === condition.cost
    }
    case 'dieShows':
      return condition.faces.includes(state.die)
    case 'inStance':
      return actor.stance === condition.stance
    case 'notInStance':
      return actor.stance !== condition.stance
    case 'discardedThisTurn':
      return state.discardedThisTurn.includes(actor.id)
    case 'stanceChangedThisTurn':
      return state.stanceChangedThisTurn.includes(actor.id)
    case 'targetFullHp':
      return target?.hp === target?.maxHp
    case 'firstTurnOfCombat':
      return state.turn === 1
    case 'firstCardPlayedThisTurn':
      return (actor.cardsPlayedThisTurn ?? 0) === 1
    case 'hasNoAttacksInHand':
      return actor.hand.every((card) => effectiveCombatCardDef(
        faceOf(cardDef(card.defId), card.upgraded), actor.guardianMode,
      ).type !== 'attack')
    case 'allCardsInHandAreAttacks':
      return actor.hand.every((card) => effectiveCombatCardDef(
        faceOf(cardDef(card.defId), card.upgraded), actor.guardianMode,
      ).type === 'attack')
    case 'onlyAttackInHand':
      return actor.hand.filter((card) => effectiveCombatCardDef(
        faceOf(cardDef(card.defId), card.upgraded), actor.guardianMode,
      ).type === 'attack').length === 1
    case 'goldAtLeast':
      return actor.gold >= condition.amount
    case 'orbsAtLeast':
      return actor.orbs.filter((orb) => orb !== null).length >= condition.amount
    case 'drawPileEmpty':
      return actor.draw.length === 0
    case 'handEmpty':
      return actor.hand.length === 0
    case 'drewSkill':
    case 'retainedLastTurn':
      return false
    case 'heatAtLeast':
      return actor.heat >= condition.amount
    case 'heatBelow':
      return actor.heat < condition.amount
    case 'cardsInExhaustAtLeast':
      return actor.exhaust.length >= condition.amount
    case 'soulburnUsedThisTurn':
      return actor.soulburnUsedThisTurn === true
    case 'hasCurseInChamber':
      return actor.chamber.some((card) => faceOf(cardDef(card.defId), card.upgraded).type === 'curse')
    case 'hasDeadOnAttackInChamber':
      return actor.chamber.some((card) => {
        const def = faceOf(cardDef(card.defId), card.upgraded)
        return def.type === 'attack' && def.hermit?.deadOn === true
      })
    case 'hpAtMost':
      return actor.hp <= condition.amount
  }
}

export function conditionIsActive(
  condition: Condition,
  state: CombatState,
  actor: Player,
  context?: Pick<PlayContext, 'drewSkill' | 'sourceRetainedLastTurn'>,
  target?: Enemy,
): boolean {
  if (condition.kind === 'drewSkill') return context?.drewSkill === true
  if (condition.kind === 'retainedLastTurn') return context?.sourceRetainedLastTurn === true
  return holds(condition, state, actor, target)
}

/** Whether a conditional printed clause applies to the current board. */
export function effectIsActive(
  effect: Effect,
  state: CombatState,
  actor: Player,
  context?: Pick<PlayContext, 'drewSkill' | 'sourceRetainedLastTurn'>,
): boolean {
  return !effect.when || conditionIsActive(effect.when, state, actor, context)
}

/** Whether the card's printed play restriction currently allows it. */
export function cardPlayConditionMet(
  def: CardDef,
  state: CombatState,
  actor: Player,
  drawCount = actor.draw.length,
  sourceInHand = true,
): boolean {
  // Online snapshots hide draw identities but publish their count.
  if (def.playCondition?.kind === 'drawPileEmpty') return drawCount === 0
  if (def.playCondition?.kind === 'onlyAttackInHand') {
    const attacks = actor.hand.filter((card) => effectiveCombatCardDef(
      faceOf(cardDef(card.defId), card.upgraded), actor.guardianMode,
    ).type === 'attack').length
    return attacks === (sourceInHand ? 1 : 0)
  }
  return !def.playCondition || holds(def.playCondition, state, actor)
}

/** Whether a card can resolve at all before Energy and player choices are considered. */
export function cardIsPlayable(
  def: CardDef,
  state: CombatState,
  actor: Player,
  drawCount = actor.draw.length,
  sourceInHand = true,
): boolean {
  return actor.cardPlayLocked !== true && !def.unplayable &&
    cardPlayConditionMet(def, state, actor, drawCount, sourceInHand)
}

/** What a card counts off the board. */
function countOf(count: CountOf, actor: CountablePlayer, state?: CombatState, energySpent = 0, sourceCardUid?: string): number {
  const typeOf = (card: CardInstance) => effectiveCombatCardDef(
    faceOf(cardDef(card.defId), card.upgraded), actor.guardianMode,
  ).type
  switch (count) {
    case 'orbs':
      return actor.orbs.filter((orb) => orb !== null).length
    case 'frostOrbs':
      return actor.orbs.filter((orb) => orb === 'frost').length
    case 'lightningOrbs':
      return actor.orbs.filter((orb) => orb === 'lightning').length
    case 'orbTypes':
      return new Set(actor.orbs.filter((orb) => orb !== null)).size
    case 'block':
      return actor.block
    case 'strength':
      return actor.strength
    case 'miracles':
      return actor.miracles
    case 'cardsInHand':
      return actor.hand?.length ?? 0
    case 'retainCardsInHand':
      return actor.hand?.filter((held) => cardHasRetain(actor, held)).length ?? 0
    case 'cardsInExhaust':
      return actor.exhaust.length
    case 'attacksInExhaust':
      return actor.exhaust.filter((card) => typeOf(card) === 'attack').length
    case 'heat':
      return actor.heat
    case 'energySpent':
      return energySpent
    case 'strikesInHand':
      return actor.hand?.filter((card) => cardDef(card.defId).name.includes('Strike')).length ?? 0
    case 'skillsInHand':
      return actor.hand?.filter((card) => typeOf(card) === 'skill').length ?? 0
    case 'attacksInHand':
      return actor.hand?.filter((card) => typeOf(card) === 'attack').length ?? 0
    case 'otherAttacksInHand':
      return actor.hand?.filter((card) => card.uid !== sourceCardUid && typeOf(card) === 'attack').length ?? 0
    case 'attacksPlayedThisTurn':
      return actor.attacksPlayedThisTurn ?? 0
    case 'attackingEnemies':
      if (!state) return 0
      return state.enemies.filter((enemy) => !enemy.dead && actionsFor(
        enemyDef(enemy.defId, enemy.ascension), state.die, enemy.actionIndex,
      ).some((action) => action.kind === 'attack' && (action.aoe || enemy.isBoss || enemy.row === actor.row))).length
    case 'clawCubesGainedThisCombat':
      return actor.clawCubesGainedThisCombat ?? 0
    case 'attacksInChamber':
      return actor.chamber.filter((card) => typeOf(card) === 'attack').length
    case 'cursesInHandAndChamber':
      return [...(actor.hand ?? []), ...actor.chamber].filter((card) => faceOf(cardDef(card.defId), card.upgraded).type === 'curse').length
    case 'starterCardsInHandAndChamber':
      return [...(actor.hand ?? []), ...actor.chamber].filter((card) => ['Strike', 'Defend'].includes(cardDef(card.defId).name) && cardDef(card.defId).rarity === 'starter').length
    case 'otherCardsInHand':
      return Math.max(0, (actor.hand?.length ?? 0) - 1)
  }
}

/** The number a clause actually uses, once the board has been read. */
export function amountOf(
  amount: Amount,
  state: CombatState,
  actor: Player,
  target?: Enemy,
  context?: PlayContext,
): number {
  if (typeof amount === 'number') return amount
  let total = amount.base
  if (amount.bonus && conditionIsActive(amount.bonus.when, state, actor, context, target)) {
    total += amount.bonus.plus
  }
  if (amount.per) total += countOf(amount.per, actor, state, context?.energySpent, context?.sourceCardUid) * (amount.scale ?? 1)
  if (amount.perSlime) total += (actor.slimes?.length ?? 0) * amount.perSlime
  if (amount.plusHighestSlimeLevel) total += Math.max(0, ...(actor.slimes ?? []).map((slime) => slime.level))
  if (target && amount.targetTokens) {
    for (const token of amount.targetTokens) total += target[token]
  }
  return total
}

function latestAllyAttack(state: CombatState, playerId: string) {
  return [...(state.playedCardsThisTurn ?? [])].reverse().find((played) =>
    played.playerId !== playerId && !played.copied &&
    (played.type ?? effectiveCombatCardDef(
      faceOf(cardDef(played.card.defId), played.card.upgraded),
      state.players.find((player) => player.id === played.playerId)?.guardianMode,
    ).type) === 'attack')
}

export function latestPlayableAllyAttack(
  state: CombatState,
  actor: Player,
  sourceCardUid?: string,
  drawCount = actor.draw.length,
) {
  const latest = latestAllyAttack(state, actor.id)
  if (!latest) return undefined
  const def = faceOf(cardDef(latest.card.defId), latest.card.upgraded)
  const checkingActor = sourceCardUid
    ? { ...actor, hand: actor.hand.filter((card) => card.uid !== sourceCardUid) }
    : actor
  return (def.minimumX ?? 0) === 0 && cardIsPlayable(
    def, state, checkingActor, drawCount, false,
  )
    ? latest
    : undefined
}

export function omniscienceEligibleCards(state: CombatState, actor: Player): CardInstance[] {
  return actor.draw.filter((card) => {
    const def = effectiveCombatCardDef(faceOf(cardDef(card.defId), card.upgraded), actor.guardianMode)
    return (def.type === 'attack' || def.type === 'skill') &&
      (def.minimumX ?? 0) === 0 && cardIsPlayable(def, state, actor, actor.draw.length - 1, false)
  })
}

export function copySourcesFor(def: CardDef, actor: Player): CopySource[] {
  return def.id === 'burst' ? []
    : (def.type === 'attack' || def.type === 'skill') && (actor.doubledCardsThisTurn ?? 0) > 0
      ? ['Echo Form']
      : def.type === 'attack' && (actor.tripledAttacksThisTurn ?? 0) > 0
        ? ['Blasphemy', 'Blasphemy']
        : def.type === 'attack' && (actor.doubledAttacksThisTurn ?? 0) > 0
          ? ['Double Tap']
          : def.type === 'skill' && (actor.doubledSkillsThisTurn ?? 0) > 0
            ? ['Burst']
            : []
}

/** Whether playing this card reveals hidden cards before asking for a choice. */
export function cardNeedsChoicePreview(def: CardDef, state?: CombatState, actor?: Player): boolean {
  if (def.type === 'power' && def.resolvesOnPlay !== true) return false
  let drew = false
  for (const effect of def.effects) {
    if (state && actor && !effectIsActive(effect, state, actor)) continue
    if (effect.kind === 'searchDraw' || effect.kind === 'searchDrawAndPlayTwice' || effect.kind === 'scryToHand' ||
      ['overexert', 'replicateSlime'].includes((effect as { kind: string }).kind)) return true
    if (effect.kind === 'draw') drew = true
    if (effect.kind === 'scry' || (drew && (effect.kind === 'discard' || effect.kind === 'topdeck' || effect.kind === 'load'))) return true
  }
  return false
}

/**
 * Effects that have to be pointed at an enemy before the card can resolve.
 *
 * `evoke` is here because an evoked Lightning or Dark orb picks a target: left
 * out, Dual Cast silently aimed at the first living enemy and the Defect could
 * not direct their biggest starter card.
 */
const ENEMY_EFFECTS = [
  'hit', 'rowHit', 'damage', 'loseHp', 'applyVulnerable', 'applyWeak', 'poison', 'multiplyPoison',
  'evoke', 'recurseOrb', 'clearTargetBlock', 'hitPerExhaust', 'execute',
]

/**
 * Whether this clause can reach an enemy at all, for this player.
 *
 * Conservative on purpose: it answers "no" only when the clause CERTAINLY
 * touches nobody. A counted attack is the case that matters — Barrage swings
 * once per Orb, and with none charged it swings zero times, so asking the
 * player to point it at something is asking for a decision that changes
 * nothing. A bonus reads board state this function is not given, so any bonus
 * counts as "might swing".
 */
export function reachesEnemy(
  effect: Effect,
  actor: CountablePlayer | undefined,
  energySpent?: number,
): boolean {
  if (!ENEMY_EFFECTS.includes(effect.kind)) return false
  if (actor && effect.when?.kind === 'inStance' && actor.stance !== effect.when.stance) return false
  if (actor && effect.when?.kind === 'notInStance' && actor.stance === effect.when.stance) return false
  if (effect.kind === 'hitPerExhaust') return !actor || actor.hand === null || actor.hand.length > 1
  if (effect.kind === 'evoke') {
    if (!actor) return true
    const times = typeof effect.times === 'number' ? effect.times : effect.times.base +
      (effect.times.per ? countOf(effect.times.per, actor, undefined,
        effect.times.per === 'energySpent' && energySpent === undefined ? 1 : energySpent) : 0)
    return times > 0 && actor.orbs.some((orb) => orb === 'lightning' || orb === 'dark')
  }
  if (effect.kind === 'recurseOrb') {
    return !actor || actor.orbs.some((orb) => orb === 'lightning' || orb === 'dark')
  }
  if (effect.kind !== 'hit' || effect.times === undefined || !actor) return true
  const times = effect.times
  if (typeof times === 'number') return times > 0
  if (times.bonus) return true
  return times.base + (times.per
    ? countOf(times.per, actor, undefined,
      times.per === 'energySpent' && energySpent === undefined ? 1 : energySpent)
    : 0) > 0
}

/** Ordered labels for independently targeted Commands produced by the selected Slimes. */
export function slimeCommandEnemyChoiceLabels(
  def: CardDef,
  state: CombatState,
  actor: Player,
  slimeUids: readonly string[],
  energySpent = 0,
  energyCharged = energySpent,
  playedCard?: CardInstance,
): string[] {
  let cursor = 0
  const labels: string[] = []
  const slimes = actor.slimes.map((slime) => ({ ...slime, card: { ...slime.card } }))
  const grownSlime = playedCard?.growOnPlay ? playedCard : undefined
  if (grownSlime) slimes.push({
    card: { ...grownSlime, growOnPlay: undefined }, level: 1, vigor: 0,
    commandsThisTurn: 0, vigorLossAtEndOfTurn: 0, vigorTriggerUsedThisTurn: false,
  })
  const selectedUids = grownSlime ? [...slimeUids, grownSlime.uid] : slimeUids
  const select = (uids: readonly string[]) => uids.flatMap((uid) => {
    const slime = slimes.find((candidate) => candidate.card.uid === uid)
    return slime ? [slime] : []
  })
  const used = new Map(slimes.map((slime) => [slime.card.uid, slime.commandsThisTurn]))
  const deferred: string[] = []
  const command = (slime: Player['slimes'][number], times = 1) => {
    const slimeCard = slimeDef(slime)
    const available = slimeCard.slimeCommandLimit === undefined
      ? times : Math.max(0, Math.min(times, slimeCard.slimeCommandLimit - (used.get(slime.card.uid) ?? 0)))
    used.set(slime.card.uid, (used.get(slime.card.uid) ?? 0) + available)
    if ((slimeCard.id === 'slime_boss_evolution_slime' && slime.level >= 3
      ? 'allEnemies' : slimeCard.slimeTarget ?? 'enemy') !== 'allEnemies' &&
      slimeCard.slimeLevels?.[slime.level]?.some((effect) => reachesEnemy(effect, actor))) {
      const label = `${slimeCard.name} · level ${slime.level}${slime.vigor > 0 ? ` · ${slime.vigor} Strength` : ''}`
      labels.push(...Array(available).fill(label))
    }
  }
  const effects = grownSlime
    ? [...def.effects, { kind: 'growSlime' as const, amount: 1 } as unknown as Effect]
    : def.effects
  for (const raw of effects) {
    if (!effectIsActive(raw, state, actor)) continue
    const effect = raw as unknown as SlimeBossEffect
    if (effect.kind === 'commandSlime') {
      const repeat = amountOf(effect.amount, state, actor, undefined, { enemyUid: null, playerId: actor.id, energySpent })
      let picked: typeof slimes
      if (effect.all) picked = slimes
      else if (effect.same) {
        picked = select(selectedUids.slice(cursor, cursor + 1))
        cursor += 1
      } else {
        picked = select(selectedUids.slice(cursor, cursor +
          (effect.upToDifferent === 99 ? repeat : effect.upToDifferent ?? 1)))
        cursor += picked.length
      }
      for (const slime of picked) command(slime, effect.same ? repeat : 1)
    } else if (effect.kind === 'growSlime') {
      const amount = effect.upToDifferent ?? 1
      const picked = select(selectedUids.slice(cursor, cursor + amount))
      cursor += picked.length
      for (const slime of picked) {
        const max = Math.max(1, ...Object.keys(slimeDef(slime).slimeLevels ?? {}).map(Number))
        const grown = Math.min(max - slime.level, effect.upToDifferent === undefined ? effect.amount : 1)
        if (grown <= 0) continue
        slime.level += grown
        if (effect.commandAfter) command(slime)
        for (let step = 0; step < grown; step++) deferred.push(...slimes
          .filter((candidate) => slimeDef(candidate).slimeTrigger === 'onGrow')
          .map((candidate) => candidate.card.uid))
      }
    } else if (effect.kind === 'gainSlimeVigor') {
      const slime = slimes.find((candidate) => candidate.card.uid === selectedUids[cursor++])
      if (!slime) continue
      const gained = Math.max(0, Math.min(effect.amount, 8 - slime.vigor))
      slime.vigor += gained
      const triggered = gained > 0 && slimeDef(slime).slimeTrigger === 'onGainVigor' &&
        !slime.vigorTriggerUsedThisTurn
      if (triggered) slime.vigorTriggerUsedThisTurn = true
      if (effect.commandAfter) command(slime)
      if (triggered) command(slime)
    } else if (effect.kind === 'rainOfGoop') {
      const slime = slimes.find((candidate) => candidate.card.uid === selectedUids[cursor++])
      if (!slime) continue
      const gained = Math.min(1, 8 - slime.vigor)
      slime.vigor += gained
      if (gained > 0 && slimeDef(slime).slimeTrigger === 'onGainVigor' &&
        !slime.vigorTriggerUsedThisTurn) {
        slime.vigorTriggerUsedThisTurn = true
        command(slime)
      }
    }
  }
  for (const uid of deferred) {
    const slime = slimes.find((candidate) => candidate.card.uid === uid)
    if (slime) command(slime)
  }
  if (energyCharged >= 2) {
    for (const slime of slimes.filter((candidate) => slimeDef(candidate).slimeTrigger === 'onSpendTwoEnergy')) command(slime)
  }
  if ((playedCard ? cardHasRetain(actor, playedCard) : def.retain) &&
    actor.powers.some((power) => power.defId === 'slime_boss_darkling_duo')) {
    const bruiser = slimes.find((slime) => slime.card.defId === 'slime_boss_bruiser_slime')
    if (bruiser) command(bruiser)
  }
  return labels
}

/** Number of independently targeted enemy Commands produced by the selected Slimes. */
export function slimeCommandEnemyChoiceCount(
  def: CardDef,
  state: CombatState,
  actor: Player,
  slimeUids: readonly string[],
  energySpent = 0,
  energyCharged = energySpent,
  playedCard?: CardInstance,
): number {
  return slimeCommandEnemyChoiceLabels(
    def, state, actor, slimeUids, energySpent, energyCharged, playedCard,
  ).length
}

/**
 * Whether this card asks the player to point at an enemy.
 *
 * Only single-target scopes need a choice: `allEnemies` hits everything, and a
 * card with no enemy-facing effect needs nothing. A `row` scope does need one,
 * since the chosen enemy is what picks the row.
 *
 * Exported so the UI prompts for exactly what the engine will require. Two
 * copies of this rule drifted apart once: the UI collected a target the engine
 * then discarded. `actor` is what lets both sides agree that a zero-swing
 * attack needs no target; without it the UI asked, and then nothing happened.
 */
export function cardNeedsEnemy(
  def: CardDef,
  actor?: CountablePlayer,
  includeEvokes = true,
  energySpent?: number,
  forActivation = false,
  attachedGemId?: string,
  sourceCardUid?: string,
  _energyCharged = energySpent,
  sourceDeadOn = false,
): boolean {
  if (def.type === 'power' && (def.trigger || (def.activeAbility && !forActivation))) return false
  if ((def.target ?? 'enemy') === 'allEnemies') return false
  if (def.target === 'row') return true
  if ((attachedGemId && ['guardian_emerald', 'guardian_garnet', 'guardian_ruby'].includes(attachedGemId)) ||
    attachedGemId === 'guardian_peridot' && (!actor || actor.hand?.some((card) => card.uid !== sourceCardUid &&
      cardDef(card.defId).guardian?.printedType.startsWith('Gem')))) return true
  if (def.guardian) {
    return new Set([
      'guardian_strike', 'guardian_twin_slam', 'guardian_orb_support', 'guardian_strike_for_strike',
      'guardian_disrupt', 'guardian_crystal_edge', 'guardian_fierce_bash', 'guardian_orb_slam',
      'guardian_poly_beam', 'guardian_priming_shot', 'guardian_walker_claw', 'guardian_roll_attack',
      'guardian_vent_steam', 'guardian_speed_boost', 'guardian_incinerate', 'guardian_focus_beam',
      'guardian_gem_cannon', 'guardian_multi_beam', 'guardian_stasis_beam', 'guardian_power_beam',
      'guardian_scale_slash', 'guardian_bauble_burst', 'guardian_body_crash', 'guardian_destroy',
    ]).has(def.id)
  }
  const sourceIsDeadOn = sourceDeadOn || sourceCardUid !== undefined && (
    actor?.hand?.some((card) => card.uid === sourceCardUid && card.hermitDeadOn === true) === true ||
    actor?.chamber.some((card) => card.uid === sourceCardUid && cardDef(card.defId).hermit?.deadOn === true) === true
  )
  const targetsEnemy = (effect: Effect) =>
    (includeEvokes || (effect.kind !== 'evoke' && effect.kind !== 'recurseOrb')) &&
    reachesEnemy(effect, actor, energySpent)
  const effects = def.modes?.flatMap((mode) => mode.effects) ?? def.effects
  return effects.some((effect) => targetsEnemy(effect) || sourceIsDeadOn && effect.kind === 'deadOnEffects' &&
    effect.effects.some(targetsEnemy))
}

/** Independent printed targets collected before an atomic card play. */
export function cardEnemyChoiceCount(
  def: CardDef,
  mode?: number,
  state?: CombatState,
  actor?: Player,
): number {
  const effects = def.modes ? def.modes[mode ?? -1]?.effects ?? [] : def.effects
  return effects.reduce((sum, effect) => sum + (
    state && actor && !effectIsActive(effect, state, actor) ? 0 :
    effect.kind === 'poisonChoices' || effect.kind === 'hitChoices' || effect.kind === 'weakChoices' ||
      effect.kind === 'vulnerableChoices' ? effect.targets : 0
  ), 0)
}

export function cardPlayerChoiceCount(def: CardDef, mode?: number): number {
  const effects = def.modes ? def.modes[mode ?? -1]?.effects ?? [] : def.effects
  const explicit = effects.reduce((sum, effect) => sum + (effect.kind === 'blockChoices' ? effect.targets : 0), 0)
  if (explicit > 0 || def.id !== 'guardian_stasis_field') return explicit
  return def.guardian?.sourceText.match(/\b1 \[block\]/g)?.length ?? 0
}

export function guardianCardNeedsAlly(
  def: CardDef,
  actor: Pick<Player, 'guardianMode'>,
  attachedGemId?: string,
): boolean {
  if (attachedGemId === 'guardian_onyx') {
    return def.id !== 'guardian_prismatic_barrier' && def.id !== 'guardian_prismatic_spray'
  }
  if (def.id === 'guardian_harden') return true
  if ((def.id === 'guardian_curl_up' || def.id === 'guardian_defend') &&
    def.guardian?.sourceText.includes('to any player')) return true
  if (def.id === 'guardian_spheric_shield') return actor.guardianMode === 'defense'
  return def.id === 'guardian_guardian_whirl' && def.type === 'skill'
}

export function cardModeIsAvailable(
  def: CardDef,
  state: CombatState,
  player: Player,
  mode: number,
  drawCount = player.draw.length,
  sourceCardUid?: string,
): boolean {
  const effects = def.modes?.[mode]?.effects
  return effects !== undefined &&
    (!effects.some((effect) => effect.kind === 'copyLastAllyAttack') ||
      Boolean(latestPlayableAllyAttack(state, player, sourceCardUid, drawCount)))
}

/** Mandatory targets for a card that spends every Shiv the actor currently holds. */
export function cardShivChoiceCount(
  def: CardDef,
  actor: Pick<Player, 'shivs'>,
  mode?: number,
): number {
  const effects = def.modes ? def.modes[mode ?? -1]?.effects ?? [] : def.effects
  return effects.some((effect) => effect.kind === 'useAllShivs') ? actor.shivs : 0
}

export function effectEvokePlan(
  effects: readonly Effect[],
  actor: Pick<Player, 'orbs'> & CountablePlayer,
  slots: readonly number[],
  energySpent = 0,
) {
  const orbs = [...actor.orbs]
  const chosen: OrbType[] = []
  let index = 0
  let next: EvokeChoice | null = null
  let invalid = false

  const evoke = (times = 1) => {
    const options = orbs.flatMap((orb, slot) => orb ? [{ slot, orb }] : [])
    if (options.length === 0) return true
    const slot = slots[index]
    if (slot === undefined) {
      next = { index, options }
      return false
    }
    const picked = options.find((option) => option.slot === slot)
    if (!picked) {
      invalid = true
      return false
    }
    chosen.push(...Array<OrbType>(times).fill(picked.orb))
    orbs[slot] = null
    index += 1
    return true
  }

  for (const effect of effects) {
    if (effect.when?.kind === 'orbsAtLeast' &&
      orbs.filter((orb) => orb !== null).length < effect.when.amount) continue
    if (effect.kind === 'channel' || effect.kind === 'channelDieOrb') {
      const amount = effect.kind === 'channel'
        ? typeof effect.amount === 'number'
          ? effect.amount
          : effect.amount.base + (effect.amount.per
            ? countOf(effect.amount.per, actor, undefined, energySpent) * (effect.amount.scale ?? 1)
            : 0)
        : 1
      for (let count = 0; count < amount; count++) {
        if (orbs.every((orb) => orb !== null) && !evoke()) return { chosen, index, next, invalid, orbs }
        const open = orbs.indexOf(null)
        if (open >= 0) orbs[open] = effect.kind === 'channel' ? effect.orb : 'lightning'
      }
    } else if (effect.kind === 'evoke' || effect.kind === 'recurseOrb' ||
      (effect.kind === 'fission' && effect.evoke)) {
      if (effect.kind === 'fission') {
        while (orbs.some((orb) => orb !== null)) {
          if (!evoke()) return { chosen, index, next, invalid, orbs }
        }
        continue
      }
      if (effect.kind === 'recurseOrb') {
        if (!evoke()) return { chosen, index, next, invalid, orbs }
        const open = orbs.indexOf(null)
        const orb = chosen.at(-1)
        if (open >= 0 && orb) orbs[open] = orb
        continue
      }
      const times = typeof effect.times === 'number' ? effect.times : effect.times.base +
        (effect.times.per ? countOf(effect.times.per, actor, undefined, energySpent) : 0)
      if (times > 0 && !evoke(times)) return { chosen, index, next, invalid, orbs }
    }
  }
  return { chosen, index, next, invalid, orbs }
}

export function evokePlan(
  def: CardDef,
  actor: Pick<Player, 'orbs'> & CountablePlayer,
  slots: readonly number[],
  mode?: number,
  energySpent = 0,
) {
  const effects = def.type === 'power' && def.resolvesOnPlay !== true
    ? []
    : def.modes ? def.modes[mode ?? -1]?.effects ?? [] : def.effects
  return effectEvokePlan(effects, actor, slots, energySpent)
}

/** The next Orb choice a staged card needs, after its earlier choices. */
export function nextEvokeChoice(
  def: CardDef,
  actor: Pick<Player, 'orbs'> & CountablePlayer,
  slots: readonly number[],
  mode?: number,
  energySpent = 0,
): EvokeChoice | null {
  return evokePlan(def, actor, slots, mode, energySpent).next
}

/** Orb types already chosen by a staged play, including slots filled earlier in that same card. */
export function chosenEvokeOrbs(
  def: CardDef,
  actor: Pick<Player, 'orbs'> & CountablePlayer,
  slots: readonly number[],
  mode?: number,
  energySpent = 0,
): OrbType[] {
  return evokePlan(def, actor, slots, mode, energySpent).chosen
}

function cardRequiresChosenEnemy(
  def: CardDef,
  actor: Player,
  includeEvokes = true,
  energySpent?: number,
  mode?: number,
  attachedGemId?: string,
  sourceCardUid?: string,
  energyCharged = energySpent,
  sourceDeadOn = false,
): boolean {
  const effects = def.modes ? def.modes[mode ?? -1]?.effects : undefined
  return cardNeedsEnemy(effects ? { ...def, modes: undefined, effects } : def,
    actor, includeEvokes, energySpent, false, attachedGemId, sourceCardUid, energyCharged, sourceDeadOn)
}

export function needsChosenEnemy(
  state: CombatState,
  def: CardDef,
  chosenUid: string | null,
  actor: Player,
  includeEvokes = true,
  energySpent?: number,
  mode?: number,
  attachedGemId?: string,
  sourceCardUid?: string,
  energyCharged = energySpent,
  sourceDeadOn = false,
): boolean {
  if (!cardRequiresChosenEnemy(def, actor, includeEvokes, energySpent, mode, attachedGemId, sourceCardUid,
    energyCharged, sourceDeadOn)) return false
  return resolveEnemyTargets(state, def.target ?? 'enemy', chosenUid).length === 0
}

export function hasInvalidChosenPlayer(
  state: CombatState,
  def: CardDef,
  chosenId: unknown,
): boolean {
  if (def.supportTarget !== 'anyPlayer') return false
  const effects = def.modes?.flatMap((mode) => mode.effects) ?? def.effects
  if (!effects.some((effect) => 'toChosen' in effect && effect.toChosen)) return false
  if (chosenId === null) return false
  if (typeof chosenId !== 'string' || chosenId.length === 0) return true
  const chosen = findPlayer(state, chosenId)
  return !chosen || chosen.dead
}

export function hasInvalidRowSwitch(
  state: CombatState,
  effects: readonly Effect[],
  chosenId: unknown,
  actor: Player,
): boolean {
  if (!effects.some((effect) => effect.kind === 'switchRows') || chosenId === null || chosenId === undefined) {
    return false
  }
  if (typeof chosenId !== 'string') return true
  const chosen = findPlayer(state, chosenId)
  return !chosen || chosen.dead || chosen.id === actor.id
}
