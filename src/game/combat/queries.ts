// What the rules say before anything moves.
//
// What a card costs on this board, whether its printed condition holds, what
// number a clause actually uses once the board has been read, and which choices
// the player still owes before it can resolve.
//
// Every function here is a question, not an action: none of them changes the
// state, so a UI can call them to grey out a card or count a prompt without
// risking a half-resolved play.
import {
  cardIsPlayable,
  effectIsActive,
  effectiveCombatCardDef,
  guardianGemForCard,
  metamorphosisCost,
} from './query-conditions.ts'
import { cardCanBeForced } from './query-targeting.ts'
import type { CardPlayWindow, CombatState, CopySource, PendingPlayerChoice, PlayContext } from './types.ts'
import { cardDef, faceOf } from '../cards.ts'
import type { CardDef } from '../cards.ts'
import { enemyAbilities, enemyDef } from '../enemies.ts'
import { CAPS } from '../types.ts'
import type { CardInstance, Player } from '../types.ts'

export {
  amountOf,
  attackIconsAgainst,
  cardHasRetain,
  cardIsPlayable,
  cardPlayConditionMet,
  cardReferencesGuardianMode,
  conditionIsActive,
  countOf,
  effectIsActive,
  effectiveCombatCardDef,
  guardianGemForCard,
  guardianPowerBeamCards,
  latestPlayableAllyAttack,
  maximumXEnergy,
  metamorphosisCost,
  metamorphosisPlayEffects,
  persistentEffectOf,
  playCost,
  powerActivationAllowed,
  slimeChoiceIsAvailable,
} from './query-conditions.ts'

export {
  adjacentDamageChoiceCount,
  adjacentDamageChoicesAreValid,
  cardCanBeForced,
  cardDefForTarget,
  cardEnemyChoiceCount,
  cardModeIsAvailable,
  cardNeedsEnemy,
  cardPlayerChoiceCount,
  cardShivChoiceCount,
  chosenEvokeOrbs,
  effectEvokePlan,
  evokePlan,
  guardianCardNeedsAlly,
  hasInvalidChosenPlayer,
  hasInvalidRowSwitch,
  needsChosenEnemy,
  nextEvokeChoice,
  reachesEnemy,
  slimeCommandEnemyChoiceCount,
  slimeCommandEnemyChoiceLabels,
  soulburnChoiceCount,
} from './query-targeting.ts'

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

/**
 * Slayer Pack: the card-given choices a living player still owes. A choice whose owner
 * died (Last Stand) or left the combat is declined by `defaultPendingPlayerChoice` and blocks nothing.
 */
export function owedPlayerChoices(state: Pick<CombatState, 'pendingPlayerChoices' | 'players'>): PendingPlayerChoice[] {
  return (state.pendingPlayerChoices ?? []).filter((choice) =>
    state.players.some((player) => player.id === choice.playerId && !player.dead))
}

/** Mandatory Downfall choices freeze every voluntary combat action until resolved. */
export function mandatoryChoicePending(state: CombatState | null | undefined, allowHermitChamberPlay = false): boolean {
  if (!state) return false
  return (state.pendingPlunderSwitches?.length ?? 0) > 0 ||
    (state.pendingDieRelicChoices?.length ?? 0) > 0 ||
    (state.pendingHermitSetupLoads?.length ?? 0) > 0 ||
    (!allowHermitChamberPlay && (state.pendingHermitChamberPlays?.length ?? 0) > 0) ||
    (state.pendingHermitStrengthRewards?.length ?? 0) > 0 ||
    // Slayer Pack: a dead or absent owner's choice holds nobody (see `owedPlayerChoices`).
    owedPlayerChoices(state).length > 0 ||
    // Slayer Pack: a dead owner's choice resolves itself (`resolveDeadOwnerSlayerChoices`) and never holds the table.
    (state.pendingSlayerChoices ?? []).some((choice) =>
      state.players.some((player) => player.id === choice.playerId && !player.dead))
}

/** The card-play window this player is resolving now: their newest open one. */
export function activeCardPlayWindow(
  state: Pick<CombatState, 'pendingCardPlayWindows'>,
  playerId: string,
): CardPlayWindow | undefined {
  const windows = state.pendingCardPlayWindows ?? []
  for (let index = windows.length - 1; index >= 0; index--) {
    if (windows[index]!.playerId === playerId) return windows[index]
  }
  return undefined
}

/**
 * Whether a card could be played through a window at `cost` on this board,
 * Energy aside. A card that fails is skipped rather than allowed to strand a
 * window that must be played: unplayable cards, a play lock or Time Warp, an
 * X card whose minimum exceeds the window's fixed X, or a printed choice the
 * board can never supply.
 */
export function cardPlayWindowCardPlayable(
  state: CombatState,
  player: Player,
  card: CardInstance,
  cost: number,
): boolean {
  const def = effectiveCombatCardDef(faceOf(cardDef(card.defId), card.upgraded), player.guardianMode)
  return !player.dead && cardIsPlayable(def, state, player) && !reachedTimeWarpLimit(state, player) &&
    (def.cost !== 'X' || (def.minimumX ?? 0) <= cost) &&
    // Slayer Pack: The window's fixed cost is Metamorphosis's X; it needs a Power to match.
    (def.id !== 'slayer_metamorphosis' ||
      player.powers.some((power) => metamorphosisCost(player, power.uid, card.upgraded) === cost)) &&
    cardCanBeForced(def, state, player, guardianGemForCard(player, card), card.uid)
}

/**
 * Players whose live card-play window must still be played: it is not optional
 * and one of its offered cards can be played. Every window that must be played
 * costs 0, so Energy never decides it. Like any mandatory choice, this holds
 * the Player Turn open.
 */
export function mandatoryCardPlayWindowOwners(state: CombatState): string[] {
  return state.players.filter((player) => {
    const live = activeCardPlayWindow(state, player.id)
    return live !== undefined && !live.optional && !player.dead &&
      player.hand.some((card) => live.cardUids.includes(card.uid) &&
        cardPlayWindowCardPlayable(state, player, card, live.cost))
  }).map((player) => player.id)
}

/** A printed active Power may be used anywhere in the Player Turn, but not mid-step. */
export function activePowerWindow(state: Pick<CombatState, 'phase' | 'startTurnProgress'>): boolean {
  if (state.phase === 'player' || state.phase === 'discard') return true
  return state.phase === 'start' && !state.startTurnProgress?.beforeDraw &&
    !state.startTurnProgress?.rollPending && !state.startTurnProgress?.pauseAfterDraw &&
    !state.startTurnProgress?.discard
}

const discardTopFlagCache = new WeakMap<CardDef, { readsTop: boolean; recoversTop: boolean }>()

function discardTopFlags(def: CardDef): { readsTop: boolean; recoversTop: boolean } {
  let flags = discardTopFlagCache.get(def)
  if (!flags) {
    const text = JSON.stringify([faceOf(def, false), faceOf(def, true)]).toLowerCase()
    flags = {
      readsTop: text.includes('discardtopcosts'),
      recoversTop: text.includes('recoverdiscardtopcosts'),
    }
    discardTopFlagCache.set(def, flags)
  }
  return flags
}

/** Whether ordering these discarded cards changes a later top-card effect. */
export function discardOrderNeedsChoice(player: Player, discarding: readonly CardInstance[]): boolean {
  if (discarding.length <= 1) return false
  const piles = [player.hand, player.draw, player.discard, player.exhaust, player.powers, player.chamber]
  let hasReader = false
  let recoversTop = false
  let canCorrupt = false
  for (let pileIndex = 0; pileIndex < piles.length; pileIndex++) {
    const pile = piles[pileIndex]!
    for (let cardIndex = 0; cardIndex < pile.length; cardIndex++) {
      const def = cardDef(pile[cardIndex]!.defId)
      const flags = discardTopFlags(def)
      if (flags.readsTop) hasReader = true
      if (flags.recoversTop) recoversTop = true
      if (def.corruptSkills) canCorrupt = true
    }
  }
  if (!hasReader) return false
  const outcomes = new Set(discarding.map((card) => {
    const face = faceOf(cardDef(card.defId), card.upgraded)
    if (face.unplayable) return false
    // Match cardCost across later HP loss and Power-count changes, before a
    // top-card reader resolves. -1 means the cost never reaches zero.
    const afterHpLoss = face.costAfterHpLoss ?? face.cost
    const zeroAtPowers = [player.lostHpThisCombat ? afterHpLoss : face.cost, afterHpLoss].map((cost) =>
      face.cost === 'X' ? -1 : cost === 0 ? 0 : (face.powerCostReduction ?? 0) > 0
        ? Math.ceil(Number(cost) / face.powerCostReduction!) : -1)
    const corruptible = canCorrupt && face.type === 'skill'
    if (zeroAtPowers.every((count) => count < 0) && !corruptible) return false
    return recoversTop ? JSON.stringify({ ...card, uid: undefined })
      : zeroAtPowers.every((count) => count === 0) ? true : JSON.stringify([zeroAtPowers, corruptible])
  }))
  return outcomes.size > 1
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
    previewShivTarget: undefined,
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
    lastHitDamageBeforeBlock: 0,
  }
}

export function overflowShivCount(state: { players: readonly { shivs: number }[] }, amount: number): number {
  const held = state.players.reduce((sum, player) => sum + player.shivs, 0)
  return Math.max(0, amount - Math.max(0, CAPS.shivs - held))
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
      effect.kind === 'scryAndPlay' || effect.kind === 'overexert' || effect.kind === 'replicateSlime') return true
    if (effect.kind === 'draw') drew = true
    if (effect.kind === 'scry' || (drew && (effect.kind === 'discard' || effect.kind === 'topdeck' || effect.kind === 'load'))) return true
  }
  return false
}
