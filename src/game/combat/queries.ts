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
import { cardCost, cardDef, faceOf } from '../cards.ts'
import type { Amount, CardDef, Condition, CountOf, Effect } from '../cards.ts'
import { actionsFor, enemyAbilities, enemyDef } from '../enemies.ts'
import { CAPS } from '../types.ts'
import type { CardInstance, Enemy, OrbType, Player } from '../types.ts'

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

/** The Energy actually charged for a card on this player's current board. */
export function playCost(
  def: CardDef,
  player: Pick<Player, 'powers' | 'relics' | 'lostHpThisCombat' | 'freeCardsThisTurn' | 'nextCardCost' | 'freeAttacksThisTurn'>,
  card?: Pick<CardInstance, 'freeThisTurn' | 'costReductionThisTurn'>,
): number | 'X' {
  if (player.nextCardCost !== null && player.nextCardCost !== undefined) return player.nextCardCost
  if (card?.freeThisTurn === true || (player.freeCardsThisTurn ?? 0) > 0 ||
    (def.type === 'attack' && (player.freeAttacksThisTurn ?? 0) > 0)
  ) return 0
  const cost = cardCost(def, player.powers, player.lostHpThisCombat)
  return cost === 'X' ? cost : Math.max(0, cost - (card?.costReductionThisTurn ?? 0))
}

export function invalidPlayChoice(context: PlayContext): boolean {
  return Boolean(context.shortfall || context.invalidShivTarget || context.invalidEvokeTarget ||
    context.invalidScryChoice || context.invalidDiscardChoice || context.invalidExhaustChoice ||
    context.invalidTopdeckChoice || context.invalidRecoverChoice || context.invalidSearchChoice)
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
    playerIds: context.playerIds ? [...context.playerIds] : undefined,
    topdeckUids: context.topdeckUids ? [...context.topdeckUids] : undefined,
    recoverDiscardUids: context.recoverDiscardUids ? [...context.recoverDiscardUids] : undefined,
    searchDrawUids: context.searchDrawUids ? [...context.searchDrawUids] : undefined,
    shivEnemyUids: context.shivEnemyUids ? [...context.shivEnemyUids] : undefined,
    evokeSlots: context.evokeSlots ? [...context.evokeSlots] : undefined,
    evokeEnemyUids: context.evokeEnemyUids ? [...context.evokeEnemyUids] : undefined,
    spentUids: new Set<string>(),
    shortfall: false,
    shivTargetIndex: 0,
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
    sourceScryDamageBonus: held.scryDamageBonus,
    sourceIsCopy,
    doppelgangerCopy: undefined,
    queuedCopySource: undefined,
    queuedCopyVirtualOnly: undefined,
    queuedCopyTwice: undefined,
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
      return actor.hand.every((card) => cardDef(card.defId).type !== 'attack')
    case 'allCardsInHandAreAttacks':
      return actor.hand.every((card) => cardDef(card.defId).type === 'attack')
    case 'onlyAttackInHand':
      return actor.hand.filter((card) => cardDef(card.defId).type === 'attack').length === 1
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
    const attacks = actor.hand.filter((card) => cardDef(card.defId).type === 'attack').length
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
function countOf(count: CountOf, actor: CountablePlayer, state?: CombatState, energySpent = 0): number {
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
      return actor.hand?.filter((card) => faceOf(cardDef(card.defId), card.upgraded).retain).length ?? 0
    case 'cardsInExhaust':
      return actor.exhaust.length
    case 'energySpent':
      return energySpent
    case 'strikesInHand':
      return actor.hand?.filter((card) => cardDef(card.defId).name.includes('Strike')).length ?? 0
    case 'skillsInHand':
      return actor.hand?.filter((card) => faceOf(cardDef(card.defId), card.upgraded).type === 'skill').length ?? 0
    case 'attacksInHand':
      return actor.hand?.filter((card) => faceOf(cardDef(card.defId), card.upgraded).type === 'attack').length ?? 0
    case 'attacksPlayedThisTurn':
      return actor.attacksPlayedThisTurn ?? 0
    case 'attackingEnemies':
      if (!state) return 0
      return state.enemies.filter((enemy) => !enemy.dead && actionsFor(
        enemyDef(enemy.defId, enemy.ascension), state.die, enemy.actionIndex,
      ).some((action) => action.kind === 'attack' && (action.aoe || enemy.isBoss || enemy.row === actor.row))).length
    case 'clawCubesGainedThisCombat':
      return actor.clawCubesGainedThisCombat ?? 0
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
  if (amount.per) total += countOf(amount.per, actor, state, context?.energySpent) * (amount.scale ?? 1)
  if (target && amount.targetTokens) {
    for (const token of amount.targetTokens) total += target[token]
  }
  return total
}

function latestAllyAttack(state: CombatState, playerId: string) {
  return [...(state.playedCardsThisTurn ?? [])].reverse().find((played) =>
    played.playerId !== playerId && !played.copied &&
    faceOf(cardDef(played.card.defId), played.card.upgraded).type === 'attack')
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
    const def = faceOf(cardDef(card.defId), card.upgraded)
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
    if (effect.kind === 'searchDraw' || effect.kind === 'searchDrawAndPlayTwice') return true
    if (effect.kind === 'draw') drew = true
    if (effect.kind === 'scry' || (drew && (effect.kind === 'discard' || effect.kind === 'topdeck'))) return true
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
  'hit', 'damage', 'loseHp', 'applyVulnerable', 'applyWeak', 'poison', 'multiplyPoison',
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
): boolean {
  if (def.type === 'power' && (def.trigger || (def.activeAbility && !forActivation))) return false
  if ((def.target ?? 'enemy') === 'allEnemies') return false
  const effects = def.modes?.flatMap((mode) => mode.effects) ?? def.effects
  return effects.some((effect) =>
    (includeEvokes || (effect.kind !== 'evoke' && effect.kind !== 'recurseOrb')) &&
      reachesEnemy(effect, actor, energySpent))
}

/** Independent printed targets collected before an atomic card play. */
export function cardEnemyChoiceCount(def: CardDef, mode?: number): number {
  const effects = def.modes ? def.modes[mode ?? -1]?.effects ?? [] : def.effects
  return effects.reduce((sum, effect) => sum + (
    effect.kind === 'poisonChoices' || effect.kind === 'hitChoices' ? effect.targets : 0
  ), 0)
}

export function cardPlayerChoiceCount(def: CardDef, mode?: number): number {
  const effects = def.modes ? def.modes[mode ?? -1]?.effects ?? [] : def.effects
  return effects.reduce((sum, effect) => sum + (effect.kind === 'blockChoices' ? effect.targets : 0), 0)
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
): boolean {
  const effects = def.modes ? def.modes[mode ?? -1]?.effects : undefined
  return cardNeedsEnemy(effects ? { ...def, modes: undefined, effects } : def, actor, includeEvokes, energySpent)
}

export function needsChosenEnemy(
  state: CombatState,
  def: CardDef,
  chosenUid: string | null,
  actor: Player,
  includeEvokes = true,
  energySpent?: number,
  mode?: number,
): boolean {
  if (!cardRequiresChosenEnemy(def, actor, includeEvokes, energySpent, mode)) return false
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
