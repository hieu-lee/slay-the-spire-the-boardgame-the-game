// Condition, cost, and counted-amount queries over combat state.
//
// Every function here is a pure read: it answers what a card costs, whether a
// printed condition holds, or what numeric amount a clause evaluates to.
import { playersInRowOf } from './board.ts'
import type { CombatState, CountablePlayer, PlayContext } from './types.ts'
import { cardCost, cardDef, faceOf, isStarterStrikeOrDefend } from '../cards.ts'
import type { Amount, CardDef, Condition, CountOf, Effect } from '../cards.ts'
import { actionsForEnemy } from '../enemies.ts'
import type { CardInstance, Enemy, GuardianMode, Player } from '../types.ts'
import { previewSlimeCommand } from '../downfall/slime-boss.ts'

const GUARDIAN_ROW_CARDS = new Set(['guardian_prismatic_spray', 'guardian_sentry_beam'])
const GUARDIAN_UPGRADED_ROW_CARDS = new Set(['guardian_roll_attack', 'guardian_vent_steam'])
const GUARDIAN_ATTACK_MODE_ROW_CARDS = new Set([
  'guardian_guardian_whirl', 'guardian_giga_beam',
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
  player: Pick<Player, 'powers' | 'relics' | 'lostHpThisCombat' | 'freeCardsThisTurn' | 'nextCardCost' | 'enemyNextCardCost' | 'freeAttacksThisTurn' | 'freeGemCardsThisTurn' | 'freePowersThisTurn' | 'nextPowerOrSlimeDiscount' | 'spentTwoEnergyOnCardThisTurn' | 'exhaust' | 'heat' | 'chamber' | 'attacksPlayedThisTurn' | 'guardianMode'> & { hand: readonly CardInstance[] | null },
  card?: Pick<CardInstance, 'freeThisTurn' | 'costReductionThisTurn' | 'stasisRetained' | 'hermitDeadOn' | 'playWindowCost'>,
): number | 'X' {
  // Slayer Pack: An open card-play window charges exactly its own cost.
  if (card?.playWindowCost !== undefined) return card.playWindowCost
  if (player.enemyNextCardCost !== null && player.enemyNextCardCost !== undefined) return player.enemyNextCardCost
  if (card?.freeThisTurn === true || (player.freeCardsThisTurn ?? 0) > 0 ||
    card?.stasisRetained === true ||
    (def.type === 'attack' && (player.freeAttacksThisTurn ?? 0) > 0) ||
    (def.guardian?.printedType.startsWith('Gem') && (player.freeGemCardsThisTurn ?? 0) > 0) ||
    (def.type === 'power' && ((player.freePowersThisTurn ?? 0) > 0 ||
      player.powers.some((power) => power.defId === 'guardian_construction_form')))
  ) return 0
  if (def.costAfterSpentTwoEnergy !== undefined && player.spentTwoEnergyOnCardThisTurn) return def.costAfterSpentTwoEnergy
  const cost = player.nextCardCost ?? cardCost(def, player.powers, player.lostHpThisCombat)
  if (cost === 'X') return cost
  const retainDiscount = def.retainCostReduction
    ? (player.hand ?? []).filter((held) => cardHasRetain(player, held)).length : 0
  const tackleDiscount = def.tackleCostReduction
    ? Math.max(0, (player.hand ?? []).filter((held) => cardDef(held.defId).name.includes('Tackle')).length - 1) : 0
  const nextDiscount = def.type === 'power' || def.type === 'slime' ? player.nextPowerOrSlimeDiscount : undefined
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
  const command = def.effects.find((effect) => effect.kind === 'commandSlime')
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
  const mustCommand = def.effects.some((effect) => {
    if (!effectIsActive(effect, state, actor)) return false
    return effect.kind === 'commandSlime' && !effect.all &&
      amountOf(effect.amount, state, actor, undefined, { enemyUid: null, playerId: actor.id, energySpent }) > 0 ||
      (effect.kind === 'growSlime' || effect.kind === 'gainSlimeVigor') && effect.commandAfter === true
  })
  return !mustCommand || previewSlimeCommand(slime) !== null
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
    case 'hasNoSkillsInHand':
      return actor.hand.every((card) => effectiveCombatCardDef(
        faceOf(cardDef(card.defId), card.upgraded), actor.guardianMode,
      ).type !== 'skill')
    case 'hasDeadOnAttackInChamber':
      return actor.chamber.some((card) => {
        const def = faceOf(cardDef(card.defId), card.upgraded)
        return def.type === 'attack' && def.hermit?.deadOn === true
      })
    case 'hpAtMost':
      return actor.hp <= condition.amount
    case 'targetVulnerable':
      return (target?.vulnerable ?? 0) > 0
    case 'notRetainedLastTurn':
      return true
    case 'targetWeak':
      return false
    case 'lostHpLastRound':
      return actor.lostHpLastRound === true
    case 'hasStatusOrCurseInHand':
      return actor.hand.some((card) => {
        const type = faceOf(cardDef(card.defId), card.upgraded).type
        return type === 'status' || type === 'curse'
      })
    case 'hasActivePower':
      return actor.powers.length > 0
  }
}

export function conditionIsActive(
  condition: Condition,
  state: CombatState,
  actor: Player,
  context?: Pick<PlayContext, 'drewSkill' | 'sourceRetainedLastTurn' | 'enemyUid'>,
  target?: Enemy,
): boolean {
  if (condition.kind === 'drewSkill') return context?.drewSkill === true
  if (condition.kind === 'retainedLastTurn') return context?.sourceRetainedLastTurn === true
  if (condition.kind === 'notRetainedLastTurn') return context?.sourceRetainedLastTurn !== true
  // Slayer Pack: Heel Hook reads its chosen target. Death keeps an enemy's
  // tokens on its card, so a Weak target killed by the hit still counts.
  if (condition.kind === 'targetWeak') {
    return typeof context?.enemyUid === 'string' && state.enemies.some((enemy) => enemy.uid === context.enemyUid && enemy.weak > 0)
  }
  return holds(condition, state, actor, target)
}

/** Slayer Pack: This Power's printed persistent effect of one kind, read off its current face. */
export function persistentEffectOf<K extends Effect['kind']>(
  power: CardInstance,
  kind: K,
): Extract<Effect, { kind: K }> | undefined {
  return (faceOf(cardDef(power.defId), power.upgraded).persistentEffects ?? [])
    .find((effect): effect is Extract<Effect, { kind: K }> => effect.kind === kind)
}

/** Slayer Pack: Whether an active Power's printed precondition (Infernal Blade) allows using it now. */
export function powerActivationAllowed(def: CardDef, state: CombatState, actor: Player): boolean {
  return !def.activationCondition || holds(def.activationCondition, state, actor)
}

/**
 * Slayer Pack: Hit icons in this enemy's current intent that will land on
 * `player`, read the way the Enemy Turn aims them: AoE hits everyone, a Facing
 * attack only its facing players, anything else the players in its row (bosses
 * reach every row; Last Stand redirects an empty row). Flame Barrier and Caltrops.
 */
export function attackIconsAgainst(
  state: CombatState,
  enemy: Enemy,
  player: Pick<Player, 'id' | 'facingEnemyUid'>,
): number {
  const targetsRow = playersInRowOf(state, enemy).some((candidate) => candidate.id === player.id)
  return actionsForEnemy(enemy, state.die).reduce((total, action) => {
    if (action.kind === 'attackSequence') return total + action.hits.filter((hit) => hit.aoe || targetsRow).length
    if (action.kind !== 'attack') return total
    const lands = action.aoe || (action.facing ? player.facingEnemyUid === enemy.uid : targetsRow)
    return total + (lands ? action.times ?? 1 : 0)
  }, 0)
}

/**
 * Slayer Pack: Metamorphosis's X for attaching to this Power in play: the
 * copied Power's Energy cost, +1 on the base face. An X-cost Power (including
 * another Metamorphosis) costs what it was played for (author FAQ).
 */
export function metamorphosisCost(
  player: Pick<Player, 'powers'>,
  powerUid: string | undefined,
  upgraded: boolean,
): number | undefined {
  const target = player.powers.find((power) => power.uid === powerUid)
  if (!target) return undefined
  const face = faceOf(cardDef(target.defId), target.upgraded)
  const cost = target.metamorphosis || face.cost === 'X' ? target.xPaid ?? 0 : face.cost
  return cost + (upgraded ? 0 : 1)
}

/** Effects that make a Power's printed effect a lasting modifier when applied on play. */
const LASTING_PLAY_EFFECTS = new Set<Effect['kind']>([
  'gainStrength', 'gainShivDamageBonus', 'gainCardBlockBonus', 'gainHitPoison', 'gainWrathAttackDamageBonus',
  'gainOrbEvokeBonus', 'gainDarkOrbEvokeBonus', 'gainOrbEndTurnBonus', 'gainLightningEndTurnBonus', 'gainOrbSlots',
  'upgradeStarterCards', 'empowerStarterStrikes', 'gainChamberSlot', 'lightningTargetsRow',
])

/**
 * The copied Power's printed play clauses that Metamorphosis takes on. A Power
 * whose whole printed effect is a lasting modifier applied when played (Accuracy,
 * Inflame) is copied by applying it again; a Power with its own "When played"
 * line beside a trigger (Brutality's draw) keeps that line to itself, because
 * Metamorphosis copies what the Power does while it is in play.
 */
export function metamorphosisPlayEffects(copied: CardDef): Effect[] {
  // Only lasting modifiers are copied: one-shot "When played" clauses (Bandage Up's draw,
  // Electrodynamics' Channel, Last Stand's Block) stay with the original.
  return copied.resolvesOnPlay && !copied.trigger && !copied.additionalTriggers?.length && !copied.activeAbility &&
    !copied.persistentEffects?.length && !copied.persistent
    ? copied.effects.filter((effect) => LASTING_PLAY_EFFECTS.has(effect.kind)) : []
}

/** Whether a conditional printed clause applies to the current board. */
export function effectIsActive(
  effect: Effect,
  state: CombatState,
  actor: Player,
  context?: Pick<PlayContext, 'drewSkill' | 'sourceRetainedLastTurn' | 'enemyUid'>,
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
  // Online snapshots hide draw order and redact identities from non-owners;
  // use the public count whenever the set is unavailable.
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
export function countOf(count: CountOf, actor: CountablePlayer, state?: CombatState, energySpent = 0, sourceCardUid?: string): number {
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
      if (!state.players.some((player) => player.id === actor.id && !player.dead)) return 0
      return state.enemies.filter((enemy) => {
        if (enemy.dead) return false
        const targetsRow = playersInRowOf(state, enemy).some((player) => player.id === actor.id)
        return actionsForEnemy(enemy, state.die).some((action) => {
          if (action.kind === 'guardianModeShift') return enemy.block > 0 && targetsRow
          if (action.kind === 'attackSequence') return action.hits.some((hit) => hit.aoe || targetsRow)
          if (action.kind !== 'attack') return false
          if (action.aoe) return true
          if (action.facing) return state.players.some((player) =>
            player.id === actor.id && player.facingEnemyUid === enemy.uid)
          return targetsRow
        })
      }).length
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
    case 'currentHp':
      return actor.hp
    case 'upgradedCardsInHand':
      return actor.hand?.filter((card) => card.uid !== sourceCardUid && card.upgraded).length ?? 0
    case 'ownWeakAndVulnerable':
      return actor.weak + actor.vulnerable
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
