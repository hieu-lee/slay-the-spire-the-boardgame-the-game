// The resolver. `applyEffect` turns one printed clause into changes on the
// board, and the trigger loop turns those changes back into more printed
// clauses — a Relic that answers a Block gain, a Power that answers a death.
//
// Those two directions call each other, which is why they live together here:
// an effect fires triggers, and a trigger applies effects. Splitting them would
// buy two files and an import cycle. Pure and domain-specific logic that can
// stand below the recursion lives in flat sibling modules (`board.ts`,
// `pieces.ts`, `queries.ts`, `slayer.ts`, `enemy-reactions.ts`, `orbs.ts`,
// `slime-effects.ts`, `hermit-effects.ts`, `card-flow-effects.ts`) and is only
// ever called downwards from here via explicit callbacks.
import {
  adjacentEnemies,
  clone,
  combatIsOver,
  combatRows,
  enemyLabel,
  findPlayer,
  lastStandActive,
  lightningDamageTargets,
  lightningTargetOptions,
  livingEnemies,
  loopOrbTargets,
  powerAbilityKey,
  remainingRoundHpLoss,
  resolveEnemyTargets,
  supportTargets,
} from './board.ts'
import { applyCardFlowEffect, isCardFlowEffect } from './card-flow-effects.ts'
import type { CardFlowEffectCallbacks } from './card-flow-effects.ts'
import {
  damageEnemyLogged as damageEnemyLoggedWithCallbacks,
  playerWeakIsRetained,
  resolveEnraged as resolveEnragedWithDamage,
  resolvePendingEnemyReactions as resolvePendingEnemyReactionsWithCallbacks,
  triggerEnemyDeath as triggerEnemyDeathWithCallbacks,
} from './enemy-reactions.ts'
import type { EnemyReactionCallbacks } from './enemy-reactions.ts'
import { applyHermitEffect, isHermitEffect } from './hermit-effects.ts'
import type { HermitEffectCallbacks } from './hermit-effects.ts'
import {
  applyOrbEffect,
  evokeTargetProgress as evokeTargetProgressWithCallbacks,
  isOrbEffect,
  resolveOrbAtEndOfTurn as resolveOrbAtEndOfTurnWithCallbacks,
} from './orbs.ts'
import type { OrbEffectCallbacks } from './orbs.ts'
import {
  consumeCopySource,
  damageEnemy,
  enemyHasDeathReaction,
  forgetRetain,
  grantShiftBlock,
  loseEnemyHp,
  playedCardExhausts,
  playerCanGainBlock,
  playerCanGainDebuffs,
  putPoison,
  triggerAngry,
} from './pieces.ts'
import { addPresentationEvent, presentationTargets } from './presentation.ts'
import {
  amountOf,
  attackIconsAgainst,
  cardCanBeForced,
  cardIsPlayable,
  cardPlayWindowCardPlayable,
  conditionIsActive,
  copySourcesFor,
  effectiveCombatCardDef,
  effectIsActive,
  guardianGemForCard,
  invalidPlayChoice,
  persistentEffectOf,
  playCost,
  reachedTimeWarpLimit,
  reachesEnemy,
  resolutionContext,
} from './queries.ts'
import {
  attachSlayerCard,
  bandageUp,
  cardIconBonus,
  clearTerminalChoices,
  closeAllCardPlayWindowsWithDiscard,
  closeCardPlayWindowWithDiscard,
  discardTopLine,
  followCopiedPowers,
  grantSlayerKillRewards,
  lapseDeadOwnerPlayerChoices,
  metamorphosisCard,
  resolveDeadOwnerSlayerChoicesWithDiscard,
  resolveSlayerAttachedDamage,
  settleCardPlayWindows,
  shedSlayerCardsOnLeaveWithDiscard,
  slayerAttachmentKeys,
  sweepMetamorphoses,
  syncCardPlayWindowMarks,
  takeDiscardTop,
} from './slayer.ts'
import {
  applySlimeEffect,
  growSlimeWithTriggers as growSlimeWithTriggersWithCallbacks,
  isSlimeEffect,
  resolvePendingSlimeCommands as resolvePendingSlimeCommandsWithCallbacks,
  resolveSlimeCommand as resolveSlimeCommandWithCallbacks,
} from './slime-effects.ts'
import type { SlimeEffectCallbacks } from './slime-effects.ts'
import {
  pendingTriggerSlimeEnemyChoiceCount,
  pendingTriggerSlimeEnemyChoiceLabels,
  queuedTriggers,
  triggerHermitChoices,
  triggerNeedsEnemyChoice,
  triggerNeedsHermitChoice,
  triggerNeedsPlayerChoice,
  triggerNeedsRowChoice,
  triggerSlimeChoice,
  triggerSourceById,
  triggerSourceReachesEnemy,
  triggerSources,
} from './trigger-queries.ts'
import type { TriggerResolutionOptions } from './trigger-queries.ts'
import {
  TURN_PRESENTATION_TRIGGERS,
  activeTurnEffectLeaves,
  dieRelicEffectsForParty,
  dieRelicNeedsOwnerChoice,
  markTurnEffect,
  publishTurnEffect,
  publishTurnEffectApplications,
} from './turn-presentation.ts'
import type {
  CombatState,
  DeferredHavoc,
  PendingTrigger,
  PlayContext,
  TriggerSource,
} from './types.ts'
import { healingCapFor } from '../acquisition.ts'
import { cardCost, cardDef, faceOf, isStarterStrikeOrDefend } from '../cards.ts'
import type { CardDef, Effect, TargetScope } from '../cards.ts'
import {
  applyDamage,
  applyHpLoss,
  attackerModsOfPlayer,
  gainBlock,
  gainStrength,
  gainVulnerable,
  gainWeak,
  hitDamage,
  recordDamageBlocked,
  recordDamageDealt,
  recordDamageTaken,
} from '../damage.ts'
import { enemyAbilities, enemyDef } from '../enemies.ts'
import { addToDrawTop, drawCards } from '../piles.ts'
import { chosenDieRelicAbilities, relicDef } from '../relics.ts'
import type { TriggerEvent } from '../triggers.ts'
import { CAPS } from '../types.ts'
import type { CardInstance, Enemy, Player } from '../types.ts'

export {
  attachSlayerCard,
  cardIconBonus,
  dieRelicEffectsForParty,
  discardTopLine,
  pendingTriggerSlimeEnemyChoiceCount,
  pendingTriggerSlimeEnemyChoiceLabels,
  publishTurnEffect,
  publishTurnEffectApplications,
  slayerAttachmentKeys,
  syncCardPlayWindowMarks,
  takeDiscardTop,
  triggerHermitChoices,
  triggerNeedsEnemyChoice,
  triggerNeedsHermitChoice,
  triggerNeedsPlayerChoice,
  triggerNeedsRowChoice,
  triggerSlimeChoice,
  triggerSourceById,
  triggerSourceReachesEnemy,
  triggerSources,
}
export type { TriggerResolutionOptions }

const enemyReactionCallbacks: EnemyReactionCallbacks = {
  discardByCardEffect: (state, actor, cards) => discardByCardEffect(state, actor, cards),
  damagePlayer: (state, player, damage) => damagePlayer(state, player, damage),
}

const orbCallbacks: OrbEffectCallbacks = {
  applyEffect: (...args) => applyEffect(...args),
  damageEnemyLogged: (...args) => damageEnemyLogged(...args),
  grantBlock: (...args) => grantBlock(...args),
}

const slimeEffectCallbacks: SlimeEffectCallbacks = {
  applyEffect: (...args) => applyEffect(...args),
  drawInto: (...args) => drawInto(...args),
  exhaustCards: (...args) => exhaustCards(...args),
}

const hermitEffectCallbacks: HermitEffectCallbacks = {
  applyEffect: (...args) => applyEffect(...args),
  discardByCardEffect: (...args) => discardByCardEffect(...args),
  triggerChosenDieRelic: (...args) => triggerChosenDieRelic(...args),
}

const cardFlowEffectCallbacks: CardFlowEffectCallbacks = {
  applyEffect: (...args) => applyEffect(...args),
  drawInto: (...args) => drawInto(...args),
  discardByCardEffect: (...args) => discardByCardEffect(...args),
  exhaustCards: (...args) => exhaustCards(...args),
  fireTriggers: (...args) => fireTriggers(...args),
  scryPlayCardPlayable: (...args) => scryPlayCardPlayable(...args),
}

/** Applies a chosen die face now, or queues its private hand choice for the relic owner. */
export function triggerChosenDieRelic(
  state: CombatState,
  owner: Player,
  relicDefId: string,
  abilityIndex: number,
  context: Pick<PlayContext, 'enemyUid' | 'playerId' | 'pendingTriggers'>,
  sourceLabel: string,
): boolean {
  const ability = chosenDieRelicAbilities(relicDef(relicDefId))[abilityIndex]
  const needsEnemy = ability?.effects.some((effect) => reachesEnemy(effect, owner)) === true
  const target = needsEnemy ? livingEnemies(state).find((enemy) => enemy.uid === context.enemyUid) : undefined
  const targetPlayer = context.playerId === null || context.playerId === undefined
    ? owner : state.players.find((player) => player.id === context.playerId && !player.dead)
  if (!ability || ability.trigger.kind !== 'dieRelic' || needsEnemy && !target ||
    ability.supportTarget === 'anyPlayer' && !targetPlayer) return false
  if (dieRelicNeedsOwnerChoice(ability.effects) || (state.pendingDieRelicChoices?.length ?? 0) > 0) {
    state.pendingDieRelicChoices ??= []
    state.pendingDieRelicChoices.push({
      id: state.nextTriggerId++,
      playerId: owner.id,
      relicDefId,
      abilityIndex,
      sourceLabel,
      enemyUid: target?.uid ?? null,
      targetPlayerId: targetPlayer?.id ?? owner.id,
    })
    state.log = [...state.log, `${sourceLabel}: ${owner.name} must finish ${relicDef(relicDefId).name}`]
    return true
  }
  const turnEffectApplications: NonNullable<PlayContext['turnEffectApplications']> = []
  const nestedContext: PlayContext = {
    enemyUid: target?.uid ?? null,
    playerId: targetPlayer?.id ?? owner.id,
    shortfall: false,
    invalidDiscardChoice: false,
    invalidExhaustChoice: false,
    pendingTriggers: context.pendingTriggers ?? [],
    turnEffectApplications,
  }
  for (const effect of dieRelicEffectsForParty(relicDefId, ability.effects, state.players.length)) {
    applyEffect(state, owner, effect, ability.target ?? 'enemy', ability.supportTarget ?? 'self', nestedContext,
      sourceLabel)
    if (invalidPlayChoice(nestedContext) || combatIsOver(state)) break
  }
  if (context.pendingTriggers === undefined && nestedContext.pendingTriggers?.length) {
    state.pendingTriggers = [...nestedContext.pendingTriggers, ...(state.pendingTriggers ?? [])]
    flushPendingTriggers(state)
  }
  if (invalidPlayChoice(nestedContext)) return false
  publishTurnEffectApplications(state, owner.id, relicDefId, turnEffectApplications)
  return true
}

function poisonApplied(state: CombatState, actor: Player, context: PlayContext): void {
  if (context.pendingPoisonTriggers) context.pendingPoisonTriggers.push(actor.id)
  else fireTriggers(state, { kind: 'onApplyPoison' }, actor)
}

function enemyTokensApplied(
  state: CombatState,
  actor: Player,
  target: Enemy,
  gained: number,
  context: PlayContext,
): void {
  for (let i = 0; i < gained; i++) {
    if (context.pendingEnemyTokenTriggers) {
      context.pendingEnemyTokenTriggers.push({ playerId: actor.id, enemyUid: target.uid })
    } else {
      fireTriggers(state, { kind: 'onPutEnemyToken', enemyUid: target.uid }, actor)
    }
  }
}

/** Commands one Slime, consuming its own target without reusing a sibling Command's choice. */
export function resolveSlimeCommand(
  state: CombatState,
  actor: Player,
  slime: Player['slimes'][number],
  context: PlayContext,
  source?: string,
): boolean {
  return resolveSlimeCommandWithCallbacks(state, actor, slime, context, slimeEffectCallbacks, source)
}

/** Resolve Slime triggers only after the current card or triggered ability finishes. */
export function resolvePendingSlimeCommands(state: CombatState, actor: Player, context: PlayContext): void {
  resolvePendingSlimeCommandsWithCallbacks(state, actor, context, slimeEffectCallbacks)
}

export function growSlimeWithTriggers(
  state: CombatState,
  actor: Player,
  slime: Player['slimes'][number],
  amount: number,
  context: PlayContext,
): number {
  return growSlimeWithTriggersWithCallbacks(state, actor, slime, amount, context, slimeEffectCallbacks)
}

export function triggerEnemyDeath(state: CombatState, enemy: Enemy): void {
  triggerEnemyDeathWithCallbacks(state, enemy, enemyReactionCallbacks)
}

export function resolveDeadOwnerSlayerChoices(state: CombatState): void {
  resolveDeadOwnerSlayerChoicesWithDiscard(state, discardByCardEffect)
}

export function shedSlayerCardsOnLeave(state: CombatState, enemy: Enemy): void {
  shedSlayerCardsOnLeaveWithDiscard(state, enemy, discardByCardEffect)
}

/**
 * Damages an enemy and says so.
 *
 * The log reported every blow an enemy struck but nothing the party struck
 * back, which left the player's own damage — the number Strength, Weak and
 * Vulnerable all modify — as the one figure they had to read off an HP bar.
 */
export function damageEnemyLogged(
  state: CombatState,
  enemy: Enemy,
  damage: number,
  source?: string,
  actor?: Player,
): void {
  damageEnemyLoggedWithCallbacks(state, enemy, damage, enemyReactionCallbacks, source, actor)
}

function preventPlayerHpLoss(state: CombatState, player: Player, amount: number): boolean {
  if (amount <= 0) return false
  const held = player.powers.find((power) =>
    power.defId === 'guardian_armored_protocol' ||
    faceOf(cardDef(power.defId), power.upgraded).effects.some((effect) => effect.kind === 'preventHpLoss'))
  if (!held) return false
  if (held.defId === 'guardian_armored_protocol') {
    gainGuardianVigorLive(state, player, held.upgraded ? 3 : 2, { enemyUid: null, playerId: player.id })
    player.powers = player.powers.filter((power) => power.uid !== held.uid)
    exhaustCards(state, player, [held])
    state.log = [...state.log, `${player.name}'s Armored Protocol prevents ${amount} HP loss and Exhausts`]
    return true
  }
  const effect = faceOf(cardDef(held.defId), held.upgraded).effects
    .find((candidate) => candidate.kind === 'preventHpLoss')!
  held.counter = (held.counter ?? 0) + 1
  state.log = [...state.log, `${player.name}'s Buffer prevents ${amount} HP loss`]
  if (held.counter < effect.uses) return true
  player.powers = player.powers.filter((power) => power.uid !== held.uid)
  held.counter = undefined
  exhaustCards(state, player, [held])
  state.log = [...state.log, `${player.name} exhausts Buffer`]
  return true
}

export function losePlayerHp(state: CombatState, player: Player, amount: number, countsAsDamage = false): number {
  const remaining = remainingRoundHpLoss(player)
  const limited = remaining === undefined
    ? amount
    : Math.min(amount, remaining)
  let losable = Math.min(player.hp, Math.max(0, limited))
  // Slayer Pack: Panic Button stops every HP loss outright, before Buffer would spend a use.
  if (losable > 0 && player.powers.some((power) => persistentEffectOf(power, 'preventAllHpLoss'))) {
    state.log = [...state.log, `${player.name}'s Panic Button prevents ${losable} HP loss`]
    return 0
  }
  if (preventPlayerHpLoss(state, player, losable)) return 0
  losable = bandageUp(state, player, Math.max(0, limited), losable, exhaustCards)
  const outcome = applyHpLoss(player.hp, losable)
  if (outcome.hpLost > 0) {
    player.lostHpThisCombat = true
    player.hpLostThisRound = (player.hpLostThisRound ?? 0) + outcome.hpLost
    if (countsAsDamage) recordDamageTaken(player, outcome.hpLost)
  }
  player.hp = outcome.hp
  if (player.hp === 0) {
    const fairy = player.potions.indexOf('fairy_in_a_bottle')
    if (fairy >= 0) {
      player.potions.splice(fairy, 1)
      state.potionDeck.push('fairy_in_a_bottle')
      player.hp = 2
      addPresentationEvent(state, {
        kind: 'potion',
        actorId: player.id,
        sourceId: 'fairy_in_a_bottle',
        enemyIds: [],
        playerIds: [player.id],
      })
      state.log = [...state.log, `${player.name}'s Fairy in a Bottle restores them to 2 HP`]
    } else {
      player.dead = true
    }
  }
  return outcome.hpLost
}

export function damagePlayer(state: CombatState, player: Player, damage: number): { fullyBlocked: boolean; hpLost: number } {
  const outcome = applyDamage(player.block, player.hp, damage)
  // The unblocked damage before it is capped by the HP left: losePlayerHp caps it
  // itself, after Bandage Up has taken its 1 off the full amount.
  const throughput = Math.max(0, damage - (player.block - outcome.block))
  recordDamageBlocked(player, player.block - outcome.block)
  player.block = outcome.block
  return { fullyBlocked: outcome.fullyBlocked, hpLost: losePlayerHp(state, player, throughput, true) }
}

/** Printed enemy reactions wait until one whole Attack has resolved. */
export function resolvePendingEnemyReactions(state: CombatState, actor: Player, context: PlayContext): void {
  resolvePendingEnemyReactionsWithCallbacks(state, actor, context, enemyReactionCallbacks)
}

/** A Shiv is its own Attack, including one complete enemy-reaction window (p.17). */
export function resolveShivAttack(
  state: CombatState,
  actor: Player,
  enemyUid: string,
  amount: number,
  context: PlayContext,
): void {
  const shivContext: PlayContext = {
    ...context,
    enemyUid,
    playerId: actor.id,
    sourceCardType: 'attack',
    pendingEnemyDamage: [],
    pendingEnemyDeathUids: [],
    pendingAttackTargets: [],
    slayerAttachedAtStart: slayerAttachmentKeys(state),
  }
  applyEffect(state, actor, { kind: 'hit', amount }, 'enemy', 'self', shivContext, 'Shiv')
  resolvePendingEnemyReactions(state, actor, shivContext)
  // Slayer Pack: Phantasmal Killer: "Whenever you play a [Shiv], deal 1 damage to the
  // target's row" -- plain damage to the struck enemy's row and the boss, even if the Shiv killed it.
  const row = state.enemies.find((enemy) => enemy.uid === enemyUid)?.row
  for (const power of [...actor.powers]) {
    const effect = persistentEffectOf(power, 'shivRowDamage')
    if (!effect || row === undefined || actor.dead || combatIsOver(state)) continue
    applyEffect(state, actor, { kind: 'damage', amount: effect.amount }, 'row', 'self',
      { enemyUid: null, enemyRow: row, playerId: actor.id }, `${actor.name}'s Phantasmal Killer`)
  }
}

export function releasePendingTriggers(state: CombatState, context: PlayContext): void {
  if (context.pendingTriggers?.length) {
    state.pendingTriggers = [...(state.pendingTriggers ?? []), ...context.pendingTriggers]
  }
  flushPendingTriggers(state)
}

function gainGuardianVigorLive(state: CombatState, actor: Player, amount: number, context: PlayContext): void {
  const gained = Math.min(amount, Math.max(0, 4 - actor.vigor - actor.vigorSpentThisTurn))
  actor.vigor += gained
  if (gained > 0) {
    state.log = [...state.log, `${actor.name} gains ${gained} Vigor`]
    markTurnEffect(context, 'buff', { actor: true })
  }
  ;(context as PlayContext & { guardianVigorGained?: number }).guardianVigorGained =
    ((context as PlayContext & { guardianVigorGained?: number }).guardianVigorGained ?? 0) + gained
}

function shiftGuardianModeLive(state: CombatState, actor: Player): void {
  if (actor.guardianMode === null || actor.guardianModeLocked) return
  actor.guardianMode = actor.guardianMode === 'attack' ? 'defense' : 'attack'
  state.log = [...state.log, `${actor.name} enters ${actor.guardianMode === 'attack' ? 'Attack' : 'Defense'} Mode`]
}

/** Resolve one audited Guardian card face, followed by its transparent Gem overlay. */
function resolveGuardianCard(
  state: CombatState,
  actor: Player,
  scope: TargetScope,
  supportScope: TargetScope,
  context: PlayContext,
  source?: string,
): void {
  const sourcePower = context.sourcePowerUid
    ? actor.powers.find((power) => power.uid === context.sourcePowerUid)
    : undefined
  const id = context.sourceCardId ?? sourcePower?.defId
  if (!id) throw new Error('Guardian action has no source card')
  const upgraded = context.sourceCardUpgraded === true || sourcePower?.upgraded === true
  const attack = actor.guardianMode === 'attack'
  const defense = actor.guardianMode === 'defense'
  const x = context.energySpent ?? 0
  const powers = actor.powers.length
  const gemsInHand = actor.hand.filter((held) => cardDef(held.defId).guardian?.printedType.startsWith('Gem')).length
  const otherGemsInHand = actor.hand.filter((held) => held.uid !== context.sourceCardUid &&
    cardDef(held.defId).guardian?.printedType.startsWith('Gem')).length
  const doEffect = (effect: Effect, targetScope = scope, allyScope = supportScope) =>
    applyEffect(state, actor, effect, targetScope, allyScope, context, source)
  const hit = (amount: number, times?: number, targetScope = scope) =>
    doEffect({ kind: 'hit', amount, ...(times === undefined ? {} : { times }) }, targetScope)
  const block = (amount: number, toChosen = false, targetScope = supportScope) =>
    doEffect({ kind: 'block', amount, ...(toChosen ? { toChosen: true } : {}) }, scope, targetScope)
  const draw = (amount: number) => doEffect({ kind: 'draw', amount })
  const modeShift = () => shiftGuardianModeLive(state, actor)
  const vigor = (amount = 1) => gainGuardianVigorLive(state, actor, amount, context)

  switch (id) {
    case 'guardian_curl_up': block(upgraded ? 3 : 2, upgraded, upgraded ? 'anyPlayer' : 'self'); if (defense) vigor(); break
    case 'guardian_defend': block(upgraded ? 2 : 1, upgraded, upgraded ? 'anyPlayer' : 'self'); break
    case 'guardian_strike': hit(upgraded ? 2 : 1); break
    case 'guardian_twin_slam': hit(2); if (attack) hit(upgraded ? 3 : 1); break
    case 'guardian_orb_support': hit(attack ? (upgraded ? 4 : 3) : 1); block(defense ? (upgraded ? 4 : 3) : 1); break
    case 'guardian_resilient_plate': block(upgraded ? 4 : 3); if (defense) block(powers); break
    case 'guardian_overload': draw(upgraded ? 5 : 4); doEffect({ kind: 'addDaze', amount: 1, pile: 'draw' }); break
    case 'guardian_prismatic_barrier': block(upgraded ? 2 : 1, true, 'anyPlayer'); break
    case 'guardian_prismatic_spray': hit(upgraded ? 2 : 1, undefined, 'row'); break
    case 'guardian_tune_up': block(upgraded ? 3 : 2); if (attack) doEffect({ kind: 'discountNextAttack' }); break
    case 'guardian_stasis_field': doEffect({ kind: 'blockChoices', amount: 1, targets: upgraded ? 5 : 4 }, scope, 'anyPlayer'); break
    case 'guardian_strike_for_strike': hit(upgraded ? 2 : 1); if (attack) doEffect({ kind: 'gainBlockFromLastHit' }); break
    case 'guardian_sentry_beam': hit(upgraded ? 4 : 3, undefined, 'row'); if (attack) { vigor(); doEffect({ kind: 'addDaze', amount: 1, pile: 'draw' }) } break
    case 'guardian_disrupt': block(upgraded ? 2 : 1); doEffect({ kind: 'applyVulnerable', amount: 1 }); break
    case 'guardian_charge_core': vigor(); break
    case 'guardian_crystal_edge': hit(upgraded ? 2 : 1); draw(1); break
    case 'guardian_fierce_bash': hit(upgraded ? 7 : 5); break
    case 'guardian_orb_slam': hit(upgraded ? 3 : 2); if (defense) block(1); break
    case 'guardian_hack': draw(upgraded ? 3 : 2); if (context.guardianModeShift) modeShift(); break
    case 'guardian_poly_beam': hit(upgraded ? 3 : 2); if (attack) doEffect({ kind: 'gainEnergy', amount: 1 }); break
    case 'guardian_priming_shot': hit(upgraded ? 3 : 2); if (attack) { vigor(); const gained = (context as PlayContext & { guardianVigorGained?: number }).guardianVigorGained ?? 0; actor.vigor -= gained; actor.vigorSpentThisTurn += gained } break
    case 'guardian_gear_up': block(upgraded ? 2 : 1); if (context.guardianModeShift) modeShift(); break
    case 'guardian_spheric_shield': block(upgraded ? 2 : 1); if (defense) block(1, true, 'anyPlayer'); break
    case 'guardian_suspension': block(upgraded ? 2 : 1); if (otherGemsInHand > 0) block(1); break
    case 'guardian_fortify': block(upgraded ? 3 : 2); if (attack) draw(2); break
    case 'guardian_walker_claw': hit(1, upgraded ? 3 : 2); break
    case 'guardian_roll_attack': hit(actor.block, undefined, upgraded ? 'row' : scope); break
    case 'guardian_orbwalk': break
    case 'guardian_guardian_whirl': if (attack) hit(x + Number(upgraded), undefined, 'row'); else block(x + Number(upgraded), true, 'anyPlayer'); break
    case 'guardian_vent_steam': if (attack) doEffect({ kind: 'applyVulnerable', amount: 1 }, upgraded ? 'row' : scope); else doEffect({ kind: 'applyWeak', amount: 1 }, upgraded ? 'row' : scope); break
    case 'guardian_turbocharge':
      if (context.sourcePowerUid) {
        if (attack) vigor()
        else {
          const held = actor.powers.find((card) => card.uid === context.sourcePowerUid)
          if (held) {
            actor.powers = actor.powers.filter((card) => card.uid !== held.uid)
            exhaustCards(state, actor, [held])
            markTurnEffect(context, 'exhaust', { actor: true })
          }
        }
      }
      break
    case 'guardian_speed_boost': hit(upgraded ? 2 : 1); if (context.guardianModeShift) modeShift(); break
    case 'guardian_charge_up':
      if (context.sourcePowerUid) {
        vigor(upgraded ? 3 : 2)
        const held = actor.powers.find((card) => card.uid === context.sourcePowerUid)
        if (held) {
          actor.powers = actor.powers.filter((card) => card.uid !== held.uid)
          actor.discard = [...actor.discard, held]
          markTurnEffect(context, 'discard', { actor: true })
        }
      }
      break
    case 'guardian_incinerate': hit(1, 2); if (attack) draw(upgraded ? 4 : 2); break
    case 'guardian_crystallize': break
    case 'guardian_focus_beam': hit(upgraded ? 3 : 2); if (actor.block >= 3) vigor(); break
    case 'guardian_gem_cannon': hit(2); actor.freeGemCardsThisTurn = (actor.freeGemCardsThisTurn ?? 0) + (upgraded ? 2 : 1); break
    case 'guardian_harden': block(upgraded ? 4 : 3, true, 'anyPlayer'); break
    case 'guardian_multi_beam': hit(1, x + Number(upgraded)); break
    case 'guardian_stasis_beam': hit(2 + powers * (upgraded ? 2 : 1)); break
    case 'guardian_power_beam': {
      hit(upgraded ? 4 : 3)
      if (defense && context.guardianPowerCardUid) {
        const power = [...actor.hand, ...actor.discard]
          .find((card) => card.uid === context.guardianPowerCardUid)
        const powerDef = power && faceOf(cardDef(power.defId), power.upgraded)
        if (power && powerDef && (powerDef.minimumX ?? 0) === 0 &&
          cardCanBeForced(powerDef, state, actor, power.attachedGemId, power.uid)) {
          actor.discard = actor.discard.filter((card) => card.uid !== power.uid)
          if (!actor.hand.some((card) => card.uid === power.uid)) actor.hand.push(forgetRetain(power))
          state.startTurnProgress = {
            choices: [],
            forcedCard: {
              playerId: actor.id,
              cardUid: power.uid,
              sourceCardId: id,
              sourceLabel: 'Power Beam',
              exhaustNonPower: false,
            },
          }
          state.log = [...state.log,
            `${actor.name}'s Power Beam readies ${cardDef(power.defId).name} for 0 Energy`]
        }
      }
      break
    }
    case 'guardian_laser_turret': if (context.sourcePowerUid) doEffect({ kind: 'damage', amount: powers }, upgraded ? 'row' : scope); break
    case 'guardian_future_plans': break
    case 'guardian_preprogram': draw(upgraded ? 3 : 2); if (actor.vigorSpentThisTurn > 0) vigor(); break
    case 'guardian_brilliant_scales': if (context.sourcePowerUid) block(1); break
    case 'guardian_repulsor': if (context.sourcePowerUid) doEffect({ kind: 'gainEnergy', amount: 1 }); else doEffect({ kind: 'addDaze', amount: 1, pile: 'draw' }); break
    case 'guardian_ancient_construct': if (context.sourcePowerUid && actor.block >= 4) vigor(); break
    case 'guardian_shield_charger': break
    case 'guardian_time_sifter': {
      const before = [actor.vigor, actor.vigorSpentThisTurn]
      actor.vigor = Math.min(4, actor.vigor + actor.vigorSpentThisTurn)
      actor.vigorSpentThisTurn = 0
      if (actor.vigor !== before[0] || actor.vigorSpentThisTurn !== before[1]) {
        markTurnEffect(context, 'buff', { actor: true })
      }
      break
    }
    case 'guardian_scale_slash':
      hit(1, upgraded ? 3 : 2)
      if (attack && context.sourceCardUid) {
        actor.draw = addToDrawTop(actor, [{
          uid: context.sourceCardUid,
          defId: id,
          upgraded,
          ...(context.sourceAttachedGemId ? { attachedGemId: context.sourceAttachedGemId } : {}),
        }]).draw
        context.sourceAttached = true
      }
      break
    case 'guardian_blitz': draw(upgraded ? 2 : 1); actor.nextCardCost = 1; break
    case 'guardian_bauble_burst': hit(upgraded ? 4 : 2); break
    case 'guardian_body_crash': { const paid = Math.min(actor.block, context.guardianBlockSpend ?? 0); actor.block -= paid; hit(paid, 2); break }
    case 'guardian_spiker_protocol': if (context.sourcePowerUid) doEffect({ kind: 'damagePerAttackIntent', amount: upgraded ? 4 : 3, oncePerEnemy: true }); break
    case 'guardian_evade':
      block(upgraded ? 3 : 2)
      if (defense) {
        const before = actor.block
        grantBlock(state, actor, before, context.pendingTriggers)
        if (actor.block > before) {
          state.log = [...state.log, `${actor.name} gains ${actor.block - before} Block`]
          markTurnEffect(context, 'block', { actor: true })
        }
      }
      break
    case 'guardian_giga_beam': if (attack) { hit(upgraded ? 7 : 5, undefined, 'row'); actor.guardianMode = 'attack'; actor.guardianModeLocked = true } break
    case 'guardian_revenge_protocol': break
    case 'guardian_armored_protocol': break
    case 'guardian_gem_finder':
      if (context.sourcePowerUid) {
        const revealed = actor.draw.slice(0, upgraded ? 4 : 3)
        const gems = revealed.filter((card) => cardDef(card.defId).guardian?.printedType.startsWith('Gem'))
        if ((context.scryDiscardUids ?? []).some((uid) => gems.some((card) => card.uid === uid))) {
          context.invalidScryChoice = true
          break
        }
        doEffect({ kind: 'scry', amount: upgraded ? 4 : 3 })
        if (!context.invalidScryChoice && !actor.drawLocked && gems.length > 0) {
          const drawn = new Set(gems.map((card) => card.uid))
          actor.draw = actor.draw.filter((card) => !drawn.has(card.uid))
          actor.hand.push(...gems)
          for (const card of gems) {
            const event = { kind: 'onDraw' as const, cardType: effectiveCombatCardDef(
              faceOf(cardDef(card.defId), card.upgraded), actor.guardianMode,
            ).type }
            if (context.pendingTriggers) context.pendingTriggers.push(...queuedTriggers(state, event, actor))
            else fireTriggers(state, event, actor)
          }
          state.log = [...state.log, `${actor.name} draws ${gems.length} Gem${gems.length === 1 ? '' : 's'}`]
        }
      }
      break
    case 'guardian_exploit_gems': doEffect({ kind: 'gainEnergy', amount: upgraded ? 2 : 1 }); break
    case 'guardian_stasis_engine': break
    case 'guardian_construction_form': if (context.sourcePowerUid) block(1); break
    case 'guardian_floating_orbs': break
    case 'guardian_time_capacitor': vigor(powers); break
    case 'guardian_destroy': hit((upgraded ? 5 : 4) + gemsInHand * (upgraded ? 5 : 4)); break
    case 'guardian_refracted_beam': if (attack) hit(0, upgraded ? 4 : 3); else for (let i = 0; i < (upgraded ? 4 : 3); i++) block(0); break
    case 'guardian_forecasting': if (context.sourcePowerUid && defense) {
      const before = new Set(actor.hand.map((card) => card.uid))
      draw(2)
      actor.hand = actor.hand.map((card) => before.has(card.uid) ? card : { ...card, retainThisTurn: true })
    } break
    case 'guardian_golden_ticket': throw new Error('Golden Ticket cannot resolve as a card')
    default: throw new Error(`Unresolved Guardian card: ${id}`)
  }

  if (context.sourceAttachedGemId) {
    const prismatic = id === 'guardian_prismatic_barrier' || id === 'guardian_prismatic_spray'
    if (id === 'guardian_bauble_burst' && context.sourceAttachedGemId === 'guardian_jasper') {
      doEffect({ kind: 'exhaustAny', amount: 6 })
    } else {
      const gemScope = prismatic ? 'row' : scope
      const gemSupportScope = prismatic && context.sourceAttachedGemId === 'guardian_onyx' ? 'allPlayers' : supportScope
      resolveGuardianGem(state, actor, context.sourceAttachedGemId,
        gemScope, gemSupportScope, context, source)
      if (id === 'guardian_bauble_burst') {
        resolveGuardianGem(state, actor, context.sourceAttachedGemId, gemScope, gemSupportScope, {
          ...context,
          guardianModeShift: context.secondGuardianModeShift,
        }, source)
      }
    }
  }
}

function resolveGuardianGem(
  state: CombatState, actor: Player, id: string, scope: TargetScope, supportScope: TargetScope,
  context: PlayContext, source?: string,
): void {
  const otherGemsInHand = actor.hand.filter((held) => held.uid !== context.sourceCardUid &&
    cardDef(held.defId).guardian?.printedType.startsWith('Gem')).length
  const sourcePower = context.sourcePowerUid
    ? actor.powers.find((power) => power.uid === context.sourcePowerUid)
    : undefined
  const sourceFace = context.sourceCardId
    ? faceOf(cardDef(context.sourceCardId), context.sourceCardUpgraded ?? false)
    : sourcePower
      ? faceOf(cardDef(sourcePower.defId), sourcePower.upgraded)
      : undefined
  const inheritedFromCrystallize = context.sourceCardId !== undefined &&
    isStarterStrikeOrDefend(context.sourceCardId, 'Strike') && actor.powers.some((power) =>
      power.defId === 'guardian_crystallize' && power.attachedGemId === id)
  const powerDamage = sourceFace?.guardian?.printedType === 'Gem Power' || inheritedFromCrystallize
  const doEffect = (effect: Effect, targetScope = scope, allyScope = supportScope) =>
    applyEffect(state, actor, effect, targetScope, allyScope,
      powerDamage && effect.kind === 'hit' ? { ...context, guardianGemPowerDamage: true } : context, source)
  switch (id) {
    case 'guardian_amethyst': if (context.guardianModeShift) shiftGuardianModeLive(state, actor); break
    case 'guardian_emerald': doEffect({ kind: 'applyWeak', amount: 1 }); break
    case 'guardian_garnet': doEffect({ kind: 'applyVulnerable', amount: 1 }); doEffect({ kind: 'addDaze', amount: 1, pile: 'draw' }); break
    case 'guardian_opal': if (actor.guardianMode === 'defense') doEffect({ kind: 'draw', amount: 2 }); break
    case 'guardian_ruby': doEffect({ kind: 'hit', amount: 1 }); break
    case 'guardian_sapphire': doEffect({ kind: 'block', amount: 1 }); break
    case 'guardian_tourmaline': {
      const before = actor.vigor
      gainGuardianVigorLive(state, actor, 1, context)
      const gained = actor.vigor - before
      actor.vigor -= gained
      actor.vigorSpentThisTurn += gained
      break
    }
    case 'guardian_amber': if (actor.guardianMode === 'attack') doEffect({ kind: 'draw', amount: 2 }); break
    case 'guardian_aquamarine': gainGuardianVigorLive(state, actor, 1, context); doEffect({ kind: 'preventCardPlay' }); break
    case 'guardian_bismuth': doEffect({ kind: 'block', amount: otherGemsInHand }); break
    case 'guardian_morganite': if ((actor.cardsPlayedThisTurn ?? 0) <= 1) doEffect({ kind: 'gainEnergy', amount: 1 }); break
    case 'guardian_jasper': doEffect({ kind: 'exhaustAny', amount: 3 }); break
    case 'guardian_onyx': doEffect({ kind: 'clearDebuffs', toChosen: true }, scope,
      supportScope === 'allPlayers' ? 'allPlayers' : 'anyPlayer'); break
    case 'guardian_pearl': actor.freePowersThisTurn = (actor.freePowersThisTurn ?? 0) + 1; break
    case 'guardian_peridot': if (otherGemsInHand > 0) doEffect({ kind: 'hit', amount: 2 }); break
    default: throw new Error(`Unresolved Guardian Gem: ${id}`)
  }
}

const DAMAGE_EFFECT_KIND_LIST = [
  'hit',
  'rowHit',
  'hitChoices',
  'hitPerExhaust',
  'damage',
  'damagePerAttackIntent',
  'damagePerDiscard',
  'damageAdjacent',
  'loseHp',
  'loseOwnHp',
  'takeDamage',
  'execute',
  'countdownDamage',
  'countdownExhaust',
  'useAllSoulburn',
  'attachToTarget',
  'upgradeThisCard',
  'revealRareReward',
] as const satisfies readonly Effect['kind'][]

type DamageEffect = Extract<Effect, { kind: (typeof DAMAGE_EFFECT_KIND_LIST)[number] }>

const DAMAGE_EFFECT_KINDS: ReadonlySet<string> = new Set(DAMAGE_EFFECT_KIND_LIST)

function isDamageEffect(effect: Effect): effect is DamageEffect {
  return DAMAGE_EFFECT_KINDS.has(effect.kind)
}

const BLOCK_AND_STATUS_EFFECT_KIND_LIST = [
  'block',
  'blockChoices',
  'gainBlockFromLastHit',
  'gainBlockPerExhaust',
  'applyVulnerable',
  'applyWeak',
  'weakChoices',
  'vulnerableChoices',
  'gainStrength',
  'doubleStrength',
  'gainTemporaryStrength',
  'gainStrengthIfTargetDead',
  'poison',
  'poisonChoices',
  'multiplyPoison',
  'attachCorpseExplosion',
  'heal',
  'clearDebuffs',
  'clearTargetBlock',
  'gainVulnerable',
  'limitRoundHpLoss',
  'preventHpLoss',
  'preventDebuffs',
  'preventBlock',
  'preventAllHpLoss',
  'reduceHpLoss',
  'cardIconBonus',
  'shivRowDamage',
] as const satisfies readonly Effect['kind'][]

type BlockAndStatusEffect = Extract<Effect, { kind: (typeof BLOCK_AND_STATUS_EFFECT_KIND_LIST)[number] }>

const BLOCK_AND_STATUS_EFFECT_KINDS: ReadonlySet<string> = new Set(BLOCK_AND_STATUS_EFFECT_KIND_LIST)

function isBlockAndStatusEffect(effect: Effect): effect is BlockAndStatusEffect {
  return BLOCK_AND_STATUS_EFFECT_KINDS.has(effect.kind)
}

const RESOURCE_AND_STANCE_EFFECT_KIND_LIST = [
  'gainEnergy',
  'spendEnergy',
  'doubleEnergy',
  'gainEnergyPerDiscard',
  'gainEnergyFromExhaust',
  'gainEnergyIfTargetDead',
  'gainShiv',
  'gainShivPerDiscard',
  'useAllShivs',
  'gainMiracle',
  'enterStance',
  'advance',
  'retract',
  'gainSoulburn',
  'nextSoulburnDamageBonus',
  'discountNextCard',
  'setNextCardCost',
  'discountNextAttack',
  'discountHand',
  'discountRetainedCards',
  'doubleNextAttack',
  'tripleNextAttack',
  'doubleNextAttackOrSkill',
  'doubleNextSkill',
  'retainAtEndOfTurn',
  'retainForBlock',
  'upgradeStarterCards',
  'empowerStarterStrikes',
  'switchRows',
  'gainWrathAttackDamageBonus',
  'gainShivDamageBonus',
  'gainCardBlockBonus',
  'gainHitPoison',
  'gainClawCube',
] as const satisfies readonly Effect['kind'][]

type ResourceAndStanceEffect = Extract<Effect, { kind: (typeof RESOURCE_AND_STANCE_EFFECT_KIND_LIST)[number] }>

const RESOURCE_AND_STANCE_EFFECT_KINDS: ReadonlySet<string> = new Set(RESOURCE_AND_STANCE_EFFECT_KIND_LIST)

function isResourceAndStanceEffect(effect: Effect): effect is ResourceAndStanceEffect {
  return RESOURCE_AND_STANCE_EFFECT_KINDS.has(effect.kind)
}

function applyDamageEffect(
  state: CombatState,
  actor: Player,
  effect: DamageEffect,
  scope: TargetScope,
  supportScope: TargetScope,
  context: PlayContext,
  source: string | undefined,
  deferWeakSpend: boolean,
  deferVulnerableSpend: boolean,
): void {
  const slimeCommand = context.slimeCommand === true
  const ignoresHitModifiers = slimeCommand || context.guardianGemPowerDamage === true
  const mods = ignoresHitModifiers
    ? { strength: 0, weak: 0, wrath: false, wrathAttackDamageBonus: 0 }
    : attackerModsOfPlayer(actor)
  const who = source ?? actor.name
  const note = (text: string) => {
    state.log = [...state.log, source ? `${source}: ${text}` : text]
  }

  switch (effect.kind) {
    case 'hit': {
      const targets = resolveEnemyTargets(state, scope, context.enemyUid, context.enemyRow)
      // Barrage deals one hit per Orb, so the swing count is read off the board
      // once, before the first target — not per target, which would let an
      // area-of-effect card re-count between enemies.
      const times = effect.times === undefined ? 1 : amountOf(effect.times, state, actor, undefined, context)
      // A counted attack can come to nothing — Barrage held with no Orbs. It is
      // a legal play and still costs the Energy, but it lands no hits, and both
      // Weak and Vulnerable are spent by a hit LANDING (p.24). Paying them out
      // anyway laundered the attacker's own Weak off for 1 Energy. Such a card
      // also asks for no target, so `targets` is empty and the loop below would
      // leave the log silent about a card the player just spent.
      if (times === 0) {
        // `note` prefixes the source itself, so this names the player, not
        // `who` -- which already carries the source and would print it twice.
        note(`${actor.name} had nothing to attack with`)
        return
      }
      context.lastHitTotalDamage = 0
      let killedChosen = false
      for (const target of targets) {
        if (!slimeCommand && context.sourceCardType === 'attack') context.pendingAttackTargets?.push(target.uid)
        // Every hit of a multi-hit is modified, but only ONE token comes off
        // after the whole thing resolves (p.14).
        const vulnerableAtStart = target.vulnerable
        const hpBefore = target.hp
        const wasAlive = !target.dead
        // Bane's bonus reads the enemy being struck, so the printed number is
        // worked out per target rather than once for the card.
        const sourceFace = context.sourceCardId
          ? faceOf(cardDef(context.sourceCardId), context.sourceCardUpgraded ?? false)
          : undefined
        const guardianDamageBonus = !ignoresHitModifiers && actor.guardianMode === 'attack' &&
          (context.sourceCardType === 'attack' || context.sourceCardType === 'skill')
          ? actor.vigorSpentThisTurn * (actor.powers.some((power) => power.defId === 'guardian_orbwalk') ? 2 : 1)
          : 0
        const tackleBonus = context.sourceCardId && cardDef(context.sourceCardId).name.includes('Tackle')
          ? actor.powers.reduce((sum, power) => sum +
            (power.defId === 'slime_boss_recklessness' ? (power.upgraded ? 3 : 2) : 0), 0)
          : 0
        const sourceCost = sourceFace && cardCost(sourceFace, actor.powers, actor.lostHpThisCombat)
        const wristBlade = actor.relics.some((relic) => relic.defId === 'wrist_blade' &&
          (source === 'Shiv' || sourceCost === 0) || relic.defId === 'downfall_wrist_blade' &&
          (source === 'Shiv' || sourceCost === 0 || sourceFace?.cost === 'X')) ? 1 : 0
        const each = actor.damageDealtZeroThisTurn ? 0 : slimeCommand
          ? amountOf(effect.amount, state, actor, target, context)
          : amountOf(effect.amount, state, actor, target, context) + wristBlade +
          guardianDamageBonus + tackleBonus +
          (context.hermitRapidFireCard && actor.powers.some((power) => power.defId === 'hermit_showdown') ? 1 : 0) +
          (context.sourceCardId === 'hermit_strike' && actor.powers.some((power) => power.defId === 'hermit_maintenance' && power.upgraded) ? 1 : 0) +
          (context.sourceScryDamageBonus ?? 0) +
          (context.sourceCardId && isStarterStrikeOrDefend(context.sourceCardId, 'Strike') ? (actor.starterStrikeDamageBonus ?? 0) : 0) +
          cardIconBonus(actor, context, source)
        let blocked = 0
        let curled = false
        let poisonAppliedTotal = 0
        let poisonEvents = 0
        let damagingHits = 0
        let damageBeforeBlock = 0
        for (let i = 0; i < times; i++) {
          if (target.dead) break
          const abilities = enemyAbilities(enemyDef(target.defId, target.ascension))
          const slow = abilities.find((ability) => ability.kind === 'slow')
          const flying = abilities.find((ability) => ability.kind === 'flying')
          let amount = each + (slow?.kind === 'slow' ? slow.damagePerHit : 0)
          amount = hitDamage(amount, mods, { vulnerable: ignoresHitModifiers ? 0 : vulnerableAtStart })
          // Golden Bullet replaces Vulnerable's double with quadruple after all bonuses.
          if (!ignoresHitModifiers && context.sourceCardId === 'hermit_golden_bullet' &&
            context.sourceHermitDeadOn && vulnerableAtStart > 0 && mods.weak === 0) amount *= 2
          if (actor.damageDealtZeroThisTurn) amount = 0
          if (flying?.kind === 'flying') amount = Math.min(amount, flying.maxDamagePerHit)
          const bufferBefore = target.abilityCubes ?? 0
          const result = damageEnemy(state, target, amount, !slimeCommand && context.sourceCardType !== undefined)
          if ((target.abilityCubes ?? 0) === bufferBefore) damageBeforeBlock += amount
          recordDamageDealt(actor, 'attack', result.blocked + result.hpLost)
          blocked += result.blocked
          curled = result.curled || curled
          if (result.hpLost > 0) {
            damagingHits++
            if (context.pendingEnemyDamage) context.pendingEnemyDamage.push({
              enemyUid: target.uid,
              amount: result.hpLost,
              attack: !slimeCommand && context.sourceCardType === 'attack',
            })
            else if (!combatIsOver(state) && abilities.some((ability) => ability.kind === 'shift')) {
              grantShiftBlock(state, target, result.hpLost)
            }
          }
          if (!slimeCommand && !target.dead && actor.hitPoison > 0) {
            const gained = putPoison(state, target, actor.hitPoison, actor.id)
            poisonAppliedTotal += gained
            if (gained > 0) poisonEvents += 1
          }
        }
        if (!ignoresHitModifiers && !deferVulnerableSpend && vulnerableAtStart > 0) {
          target.vulnerable = vulnerableAtStart - 1
        }
        // One line for the whole attack, not one per swing: a five-hit card
        // would otherwise bury the round in near-identical lines.
        const name = enemyLabel(state.enemies, target)
        const lost = hpBefore - target.hp
        context.lastHitDamage = lost
        context.lastHitDamageBeforeBlock = damageBeforeBlock
        context.lastHitTotalDamage += lost
        if (wasAlive && target.dead && target.uid === context.enemyUid) killedChosen = true
        state.log = [
          ...state.log,
          lost > 0
            ? `${who} hit ${name} for ${lost}${blocked > 0 ? ` (${blocked} blocked)` : ''}`
            : blocked > 0
              ? `${name} blocked ${who} completely (${blocked} spent)`
              : `${who} did no damage to ${name}`,
        ]
        if (poisonAppliedTotal > 0) {
          state.log = [...state.log, `${actor.name}'s Envenom applies ${poisonAppliedTotal} Poison to ${name}`]
          for (let i = 0; i < poisonEvents; i++) poisonApplied(state, actor, context)
          enemyTokensApplied(state, actor, target, poisonAppliedTotal, context)
        }
        if (blocked > 0 || damagingHits > 0) {
          markTurnEffect(context, 'damage', { enemyId: target.uid })
        }
        if (wasAlive && target.dead) {
          state.log = [...state.log, `${name} is dead`]
          if (!slimeCommand && context.sourceCardType !== undefined && enemyHasDeathReaction(state, target)) {
            context.pendingEnemyDeathUids?.push(target.uid)
          }
          else triggerEnemyDeath(state, target)
        } else if (curled) {
          state.log = [...state.log, `${name}'s Curl Up gained Block`]
        }
        if (!slimeCommand && context.sourceCardType === undefined) triggerAngry(state, target, damagingHits)
        if (combatIsOver(state)) break
      }
      // The attacker's own Weak is spent by attacking, exactly as an enemy's is
      // (p.24). One token per attack, however many targets or hits it had.
      if (!ignoresHitModifiers && !deferWeakSpend && targets.length > 0 && actor.weak > 0 &&
        !playerWeakIsRetained(state)) {
        actor.weak -= 1
        // Logged because it is usually the reason the attack underperformed.
        note(`${actor.name} spends a Weak`)
      }
      // Slayer Pack: "If this killed the target": resolved even when the
      // kill ended the combat, since a heal or a deck change outlasts the fight.
      if (killedChosen) {
        for (const nested of effect.onKill ?? []) applyEffect(state, actor, nested, scope, supportScope, context, source)
      }
      return
    }
    case 'rowHit':
      return applyEffect(state, actor, { kind: 'hit', amount: effect.amount, times: effect.times }, 'row', supportScope,
        context, source, deferWeakSpend, deferVulnerableSpend)
    case 'hitChoices': {
      const weakAtStart = actor.weak
      const vulnerableAtStart = new Map<string, number>()
      for (const enemyUid of context.enemyUids ?? []) {
        const target = state.enemies.find((enemy) => enemy.uid === enemyUid && !enemy.dead)
        if (!target) continue
        if (!vulnerableAtStart.has(enemyUid)) vulnerableAtStart.set(enemyUid, target.vulnerable)
        applyEffect(state, actor, { kind: 'hit', amount: effect.amount }, 'enemy', 'self', {
          ...context,
          enemyUid,
        }, source, true, true)
        if (combatIsOver(state)) break
      }
      for (const [enemyUid, vulnerable] of vulnerableAtStart) {
        if (vulnerable <= 0) continue
        const target = state.enemies.find((enemy) => enemy.uid === enemyUid)
        if (target) target.vulnerable = vulnerable - 1
      }
      if (weakAtStart > 0 && actor.weak === weakAtStart && (context.enemyUids?.length ?? 0) > 0 &&
        !playerWeakIsRetained(state)) {
        actor.weak -= 1
        note(`${actor.name} spends a Weak`)
      }
      return
    }
    case 'hitPerExhaust':
      return applyEffect(state, actor, {
        kind: 'hit', amount: effect.amount, times: context.exhaustedByCard ?? 0,
      }, scope, supportScope, context, source)
    case 'damage': {
      // Not a hit: blockable, but unmodified by Strength/Weak/Vulnerable.
      for (const target of resolveEnemyTargets(state, scope, context.enemyUid, context.enemyRow)) {
        const before = [target.hp, target.block, target.dead]
        damageEnemyLogged(state, target, actor.damageDealtZeroThisTurn ? 0 : amountOf(effect.amount, state, actor, target, context), who, actor)
        if (target.hp !== before[0] || target.block !== before[1] || target.dead !== before[2]) {
          markTurnEffect(context, 'damage', { enemyId: target.uid })
        }
        if (combatIsOver(state)) return
      }
      return
    }
    case 'damagePerAttackIntent': {
      for (const target of state.enemies) {
        if (target.dead) continue
        // Slayer Pack: Aimed as the Enemy Turn aims it (Facing, Last Stand redirection).
        const icons = attackIconsAgainst(state, target, actor)
        if (icons > 0) {
          const before = [target.hp, target.block, target.dead]
          damageEnemyLogged(state, target, actor.damageDealtZeroThisTurn ? 0 : effect.amount * (effect.oncePerEnemy ? 1 : icons), who, actor)
          if (target.hp !== before[0] || target.block !== before[1] || target.dead !== before[2]) {
            markTurnEffect(context, 'damage', { enemyId: target.uid })
          }
        }
        if (combatIsOver(state)) return
      }
      return
    }
    case 'damagePerDiscard':
      return applyEffect(state, actor, {
        kind: 'damage', amount: effect.amount * (context.triggerCount ?? 0),
      }, scope, supportScope, context, source)
    case 'damageAdjacent': {
      const candidates = adjacentEnemies(state, context.enemyUid)
      const chosen = candidates.length > effect.targets
        ? candidates.filter((enemy) => context.enemyUids?.includes(enemy.uid))
        : candidates
      for (const target of chosen) {
        if (target.dead) continue
        const before = [target.hp, target.block, target.dead]
        damageEnemyLogged(state, target, actor.damageDealtZeroThisTurn ? 0 : effect.amount, who, actor)
        if (target.hp !== before[0] || target.block !== before[1] || target.dead !== before[2]) {
          markTurnEffect(context, 'damage', { enemyId: target.uid })
        }
        if (combatIsOver(state)) return
      }
      return
    }
    case 'loseHp': {
      for (const target of resolveEnemyTargets(state, scope, context.enemyUid, context.enemyRow)) {
        const name = enemyLabel(state.enemies, target)
        const wasAlive = !target.dead
        const outcome = loseEnemyHp(state, target, effect.amount)
        // What was actually lost, not what was printed: an enemy on 2 hit
        // points struck for 5 loses 2.
        state.log = [...state.log, `${name} loses ${outcome.hpLost}`]
        target.hp = outcome.hp
        if (target.hp === 0) {
          target.dead = true
          // Every other kill in the game announces itself; this one used to
          // write `dead` inline and skip the line.
          if (wasAlive) state.log = [...state.log, `${name} is dead`]
          if (wasAlive) triggerEnemyDeath(state, target)
        }
        if (combatIsOver(state)) return
      }
      return
    }
    case 'loseOwnHp': {
      const lost = losePlayerHp(state, actor, effect.amount)
      if (lost > 0) note(`${actor.name} loses ${lost} HP`)
      return
    }
    case 'takeDamage': {
      const block = actor.block
      const outcome = damagePlayer(state, actor, effect.amount)
      const blocked = block - actor.block
      // Prevented HP loss (Panic Button, Buffer) already says so; nothing blocked is no news.
      if (outcome.hpLost > 0) note(`${actor.name} takes ${outcome.hpLost} damage${blocked > 0 ? ` (${blocked} blocked)` : ''}`)
      else if (blocked > 0) note(`${actor.name} blocks ${blocked} damage`)
      if (actor.dead) note(`${actor.name} has fallen`)
      return
    }
    case 'execute': {
      for (const target of resolveEnemyTargets(state, scope, context.enemyUid, context.enemyRow)) {
        if (target.hp > effect.hpAtMost) continue
        const name = enemyLabel(state.enemies, target)
        target.hp = 0
        target.dead = true
        state.log = [...state.log, `${who} sets ${name}'s hit points to 0`, `${name} is dead`]
        triggerEnemyDeath(state, target)
        if (combatIsOver(state)) return
      }
      return
    }
    case 'countdownDamage': {
      const held = actor.powers.find((card) => card.uid === context.sourcePowerUid)
      if (!held) return
      held.counter = (held.counter ?? 0) + 1
      note(`${actor.name} places cube ${held.counter} of ${effect.cubes}`)
      if (held.counter < effect.cubes) {
        markTurnEffect(context, 'countdown', { actor: true })
        return
      }
      applyEffect(state, actor, { kind: 'damage', amount: effect.damage }, 'allEnemies', 'self', context, source)
      actor.powers = actor.powers.filter((card) => card.uid !== held.uid)
      held.counter = undefined
      exhaustCards(state, actor, [held])
      note(`${actor.name} exhausts The Bomb`)
      markTurnEffect(context, 'exhaust', { actor: true })
      return
    }
    case 'countdownExhaust': {
      const held = actor.powers.find((card) => card.uid === context.sourcePowerUid)
      if (!held) return
      held.counter = (held.counter ?? 0) + 1
      note(`${actor.name} places cube ${held.counter} of ${effect.cubes}`)
      if (held.counter < effect.cubes) {
        markTurnEffect(context, 'countdown', { actor: true })
        return
      }
      actor.powers = actor.powers.filter((card) => card.uid !== held.uid)
      held.counter = undefined
      exhaustCards(state, actor, [held])
      note(`${actor.name} exhausts ${cardDef(held.defId).name}`)
      markTurnEffect(context, 'exhaust', { actor: true })
      return
    }
    case 'useAllSoulburn': {
      const count = actor.soulburn
      actor.soulburn = 0
      for (let index = 0; index < count; index++) {
        const enemyUid = context.soulburnEnemyUids?.[context.soulburnTargetIndex ?? 0]
        context.soulburnTargetIndex = (context.soulburnTargetIndex ?? 0) + 1
        if (!enemyUid) {
          context.shortfall = true
          continue
        }
        if (resolveEnemyTargets(state, effect.target, enemyUid).length === 0) continue
        const bonus = actor.nextSoulburnDamageBonus ?? 0
        actor.nextSoulburnDamageBonus = 0
        actor.soulburnUsedThisTurn = true
        applyEffect(state, actor, { kind: 'damage', amount: actor.heat + bonus }, effect.target, supportScope,
          { ...context, enemyUid }, 'Soulburn')
        const event = { kind: 'onUseSoulburn' as const }
        if (context.pendingTriggers) context.pendingTriggers.push(...queuedTriggers(state, event, actor))
        else fireTriggers(state, event, actor)
        if (combatIsOver(state)) break
      }
      if (effect.regain && !combatIsOver(state)) actor.soulburn = Math.min(6, actor.soulburn + count)
      return
    }
    case 'attachToTarget': {
      const target = resolveEnemyTargets(state, 'enemy', context.enemyUid)[0]
      // A virtual copy has no physical card to leave on the enemy.
      if (!target || context.sourceIsCopy || !context.sourceCardUid) return
      attachSlayerCard(state, target, {
        card: { uid: context.sourceCardUid, defId: context.sourceCardId!, upgraded: context.sourceCardUpgraded === true },
        playerId: actor.id,
      })
      context.sourceAttached = true
      return
    }
    case 'upgradeThisCard':
    case 'revealRareReward': {
      // Doppelganger-style copies are virtual (`…:copy`): no card of this player to change.
      // A Double Tap/Echo/Burst copy IS this card: whichever resolution kills first earns
      // the reward, once per play; it lands when the card has left play.
      const uid = context.sourceCardUid
      if (!uid || uid.endsWith(':copy') || effect.kind === 'upgradeThisCard' && context.sourceCardUpgraded ||
        state.slayerKillRewards?.some((earned) => earned.cardUid === uid)) return
      state.slayerKillRewards = [...(state.slayerKillRewards ?? []),
        { playerId: actor.id, cardUid: uid, reward: effect.kind === 'upgradeThisCard' ? 'upgrade' : 'reveal' }]
      return
    }
  }
}

function applyBlockAndStatusEffect(
  state: CombatState,
  actor: Player,
  effect: BlockAndStatusEffect,
  scope: TargetScope,
  supportScope: TargetScope,
  context: PlayContext,
  source?: string,
): void {
  const note = (text: string) => {
    state.log = [...state.log, source ? `${source}: ${text}` : text]
  }

  switch (effect.kind) {
    case 'block': {
      // Deflect and Steam Barrier both read the CASTER's board, not the ally
      // they may be handing the Block to, so this is worked out once.
      const printedCard = context.sourceCardType === 'attack' || context.sourceCardType === 'skill'
      const base = amountOf(effect.amount, state, actor, undefined, context)
      const bonusIcon = typeof effect.amount !== 'number'
        && effect.amount.bonus
        && conditionIsActive(effect.amount.bonus.when, state, actor, context)
      const icons = 1 + Number(Boolean(bonusIcon))
      const amount = base + (printedCard ? icons * (actor.cardBlockBonus + cardIconBonus(actor, context, source)) : 0) +
        (actor.guardianMode === 'defense' &&
          (context.sourceCardType === 'attack' || context.sourceCardType === 'skill')
          ? icons * actor.vigorSpentThisTurn : 0) +
        (context.sourceCardId && isStarterStrikeOrDefend(context.sourceCardId, 'Defend') ? (actor.starterDefendBlockBonus ?? 0) : 0)
      for (const target of supportTargets(state, effect, supportScope, context, actor)) {
        const before = target.block
        grantBlock(state, target, amount, context.sourceCardId ? context.pendingTriggers : undefined)
        if (target.block > before) {
          note(`${target.name} gains ${target.block - before} Block`)
          markTurnEffect(context, 'block', target.id === actor.id ? { actor: true } : { playerId: target.id })
        }
      }
      return
    }
    case 'blockChoices': {
      for (const playerId of context.playerIds ?? []) {
        applyEffect(state, actor, { kind: 'block', amount: effect.amount, toChosen: true },
          scope, 'anyPlayer', { ...context, playerId }, source)
      }
      return
    }
    case 'gainBlockFromLastHit':
      return applyEffect(state, actor, {
        kind: 'block', amount: (effect.allTargets ? context.lastHitTotalDamage : context.lastHitDamage) ?? 0,
      }, scope, supportScope, context, source)
    case 'gainBlockPerExhaust':
      return applyEffect(state, actor, {
        kind: 'block', amount: effect.amount * (context.exhaustedByCard ?? 0),
      }, scope, supportScope, context, source)
    case 'applyVulnerable': {
      for (const target of resolveEnemyTargets(state, scope, context.enemyUid, context.enemyRow)) {
        const invincible = enemyAbilities(enemyDef(target.defId, target.ascension))
          .some((ability) => ability.kind === 'invincible') && !target.abilityUsed
        if (invincible) continue
        const before = target.vulnerable
        target.vulnerable = gainVulnerable(target.vulnerable, effect.amount)
        // Only when the token actually went on: at the cap nothing happened,
        // and saying otherwise tells the player a card did something it did not.
        if (target.vulnerable > before) {
          note(`${enemyLabel(state.enemies, target)} is vulnerable`)
          markTurnEffect(context, 'vulnerable', { enemyId: target.uid })
        }
        enemyTokensApplied(state, actor, target, target.vulnerable - before, context)
      }
      return
    }
    case 'applyWeak': {
      for (const target of resolveEnemyTargets(state, scope, context.enemyUid, context.enemyRow)) {
        const abilities = enemyAbilities(enemyDef(target.defId, target.ascension))
        const invincible = abilities.some((ability) => ability.kind === 'invincible') && !target.abilityUsed
        if (invincible || abilities.some((ability) => ability.kind === 'immuneToWeak')) continue
        const before = target.weak
        target.weak = gainWeak(target.weak, amountOf(effect.amount, state, actor, target, context))
        if (target.weak > before) {
          note(`${enemyLabel(state.enemies, target)} is weakened`)
          markTurnEffect(context, 'weak', { enemyId: target.uid })
        }
        enemyTokensApplied(state, actor, target, target.weak - before, context)
      }
      return
    }
    case 'weakChoices':
    case 'vulnerableChoices': {
      for (let index = 0; index < effect.targets; index++) {
        const at = context.enemyChoiceIndex ?? 0
        const enemyUid = context.enemyUids?.[at]
        context.enemyChoiceIndex = at + 1
        if (!enemyUid) {
          context.shortfall = true
          continue
        }
        applyEffect(state, actor, effect.kind === 'weakChoices'
          ? { kind: 'applyWeak', amount: effect.amount }
          : { kind: 'applyVulnerable', amount: effect.amount }, 'enemy', supportScope,
        { ...context, enemyUid }, source)
      }
      return
    }
    case 'gainStrength': {
      for (const target of supportTargets(state, effect, supportScope, context, actor)) {
        const before = target.strength
        target.strength = gainStrength(target.strength, amountOf(effect.amount, state, actor, undefined, context))
        if (target.strength > before) {
          note(`${target.name} gains ${target.strength - before} Strength`)
          markTurnEffect(context, 'strength', target.id === actor.id ? { actor: true } : { playerId: target.id })
        }
      }
      return
    }
    case 'doubleStrength': {
      const before = actor.strength
      actor.strength = gainStrength(actor.strength, actor.strength)
      if (actor.strength > before) {
        note(`${actor.name} gains ${actor.strength - before} Strength`)
        markTurnEffect(context, 'strength', { actor: true })
      }
      return
    }
    case 'gainTemporaryStrength': {
      const amount = amountOf(effect.amount, state, actor, undefined, context)
      const before = actor.strength
      actor.strength = gainStrength(actor.strength, amount)
      const gained = actor.strength - before
      actor.strengthLossAtEndOfTurn = (actor.strengthLossAtEndOfTurn ?? 0) +
        (effect.loseGainedOnly ? gained : amount)
      if (gained > 0) {
        note(`${actor.name} gains ${gained} Strength`)
        markTurnEffect(context, 'strength', { actor: true })
      }
      return
    }
    case 'gainStrengthIfTargetDead': {
      const target = typeof context.enemyUid === 'string'
        ? state.enemies.find((enemy) => enemy.uid === context.enemyUid)
        : undefined
      if (!target?.dead) return
      const before = actor.strength
      actor.strength = gainStrength(actor.strength, effect.amount)
      if (actor.strength > before) note(`${actor.name} gains ${actor.strength - before} Strength`)
      return
    }
    case 'poison': {
      for (const target of resolveEnemyTargets(state, scope, context.enemyUid, context.enemyRow)) {
        const gained = putPoison(state, target, amountOf(effect.amount, state, actor, target, context), actor.id)
        if (gained > 0) {
          note(`${enemyLabel(state.enemies, target)} takes ${gained} Poison`)
          markTurnEffect(context, 'poison', { enemyId: target.uid })
          poisonApplied(state, actor, context)
          enemyTokensApplied(state, actor, target, gained, context)
        }
      }
      return
    }
    case 'poisonChoices': {
      for (const enemyUid of context.enemyUids ?? []) {
        applyEffect(state, actor, { kind: 'poison', amount: effect.amount }, 'enemy', 'self', {
          ...context,
          enemyUid,
        }, source)
      }
      return
    }
    case 'multiplyPoison': {
      for (const target of resolveEnemyTargets(state, scope, context.enemyUid, context.enemyRow)) {
        const before = target.poison
        const added = before * Math.max(0, effect.factor - 1)
        const gained = putPoison(state, target, added, actor.id)
        if (gained > 0) {
          note(`${enemyLabel(state.enemies, target)} takes ${gained} Poison`)
          markTurnEffect(context, 'poison', { enemyId: target.uid })
          poisonApplied(state, actor, context)
          enemyTokensApplied(state, actor, target, gained, context)
        }
      }
      return
    }
    case 'attachCorpseExplosion': {
      if (context.sourceIsCopy) return
      const target = resolveEnemyTargets(state, 'enemy', context.enemyUid)[0]
      // FAQ: playing Corpse Explosion twice adds Poison twice, but its death
      // effect happens only once. The later physical card discards normally.
      if (!target || target.corpseExplosion || !context.sourceCardUid) return
      target.corpseExplosion = {
        card: {
          uid: context.sourceCardUid,
          defId: context.sourceCardId!,
          upgraded: context.sourceCardUpgraded === true,
        },
        playerId: actor.id,
        damage: effect.damage,
      }
      context.sourceAttached = true
      note(`${actor.name} attaches Corpse Explosion to ${enemyLabel(state.enemies, target)}`)
      return
    }
    case 'heal': {
      for (const target of supportTargets(state, effect, supportScope, context, actor)) {
        const before = target.hp
        target.hp = Math.min(healingCapFor(target, state.ruleset), target.hp + effect.amount)
        if (target.hp > before) {
          note(`${target.name} heals ${target.hp - before}`)
          markTurnEffect(context, 'heal', target.id === actor.id ? { actor: true } : { playerId: target.id })
        }
      }
      return
    }
    case 'clearDebuffs': {
      for (const target of supportTargets(state, effect, supportScope, context, actor)) {
        target.weak = 0
        target.vulnerable = 0
        note(`${target.name} removes all Weak and Vulnerable`)
      }
      return
    }
    case 'clearTargetBlock': {
      for (const target of resolveEnemyTargets(state, scope, context.enemyUid)) {
        if (target.block > 0) note(`${enemyLabel(state.enemies, target)} loses ${target.block} Block`)
        target.block = 0
      }
      return
    }
    case 'gainVulnerable': {
      if (!playerCanGainDebuffs(actor)) return
      const before = actor.vulnerable
      actor.vulnerable = gainVulnerable(actor.vulnerable, effect.amount)
      if (actor.vulnerable > before) {
        note(`${actor.name} gains ${actor.vulnerable - before} Vulnerable`)
        markTurnEffect(context, 'vulnerable', { actor: true })
      }
      return
    }
    case 'limitRoundHpLoss': {
      const before = actor.hpLossLimitThisRound
      actor.hpLossLimitThisRound = Math.min(actor.hpLossLimitThisRound ?? effect.amount, effect.amount)
      note(`${actor.name} cannot lose more than ${effect.amount} HP this round`)
      if (actor.hpLossLimitThisRound !== before) markTurnEffect(context, 'buff', { actor: true })
      return
    }
    case 'preventHpLoss':
      // Buffer reacts in the shared HP-loss boundary, not when the Power is played.
      return
    case 'preventDebuffs':
    case 'preventBlock':
    case 'preventAllHpLoss':
    case 'reduceHpLoss':
    case 'cardIconBonus':
    case 'shivRowDamage':
      return
  }
}

function applyResourceAndStanceEffect(
  state: CombatState,
  actor: Player,
  effect: ResourceAndStanceEffect,
  scope: TargetScope,
  supportScope: TargetScope,
  context: PlayContext,
  source?: string,
): void {
  const note = (text: string) => {
    state.log = [...state.log, source ? `${source}: ${text}` : text]
  }

  switch (effect.kind) {
    case 'advance':
    case 'retract': {
      const advancing = effect.kind === 'advance'
      const times = amountOf(effect.times ?? 1, state, actor, undefined, context)
      for (let index = 0; index < times; index++) {
        const before = actor.heat
        actor.heat = Math.max(1, Math.min(6, actor.heat + (advancing ? 1 : -1)))
        note(`${actor.name} ${advancing ? 'Advances' : 'Retracts'} (Heat ${actor.heat})`)
        if (actor.heat !== before) markTurnEffect(context, 'buff', { actor: true })
        const event = { kind: advancing ? 'onAdvance' as const : 'onRetract' as const }
        if (context.pendingTriggers) context.pendingTriggers.push(...queuedTriggers(state, event, actor))
        else fireTriggers(state, event, actor)
      }
      return
    }
    case 'gainSoulburn': {
      const before = actor.soulburn
      actor.soulburn = Math.min(6, actor.soulburn + amountOf(effect.amount, state, actor, undefined, context))
      if (actor.soulburn > before) {
        note(`${actor.name} gains ${actor.soulburn - before} Soulburn`)
        markTurnEffect(context, 'buff', { actor: true })
      }
      return
    }
    case 'nextSoulburnDamageBonus':
      actor.nextSoulburnDamageBonus = (actor.nextSoulburnDamageBonus ?? 0) + effect.amount
      note(`${actor.name}'s next Soulburn this turn deals +${effect.amount} damage`)
      return
    case 'spendEnergy': {
      if (actor.energy < effect.amount) {
        context.shortfall = true
        return
      }
      actor.energy -= effect.amount
      note(`${actor.name} spends ${effect.amount} Energy`)
      return
    }
    case 'gainEnergy': {
      for (const target of supportTargets(state, effect, supportScope, context, actor)) {
        const before = target.energy
        target.energy = Math.min(CAPS.energy, target.energy + amountOf(effect.amount, state, actor, undefined, context))
        if (target.energy > before) {
          note(`${target.name} gains ${target.energy - before} Energy`)
          markTurnEffect(context, 'buff', target.id === actor.id ? { actor: true } : { playerId: target.id })
        }
      }
      return
    }
    case 'doubleEnergy': {
      const before = actor.energy
      actor.energy = Math.min(effect.max, actor.energy * 2)
      if (actor.energy > before) note(`${actor.name} gains ${actor.energy - before} Energy`)
      return
    }
    case 'gainEnergyPerDiscard': {
      const amount = (context.discardedByCard ?? 0) + effect.bonus
      const before = actor.energy
      actor.energy = Math.min(CAPS.energy, actor.energy + amount)
      if (actor.energy > before) note(`${actor.name} gains ${actor.energy - before} Energy`)
      return
    }
    case 'gainEnergyFromExhaust': {
      const cost = context.exhaustedCardCost
      if (cost === undefined) return
      const before = actor.energy
      actor.energy = cost === 'X'
        ? Math.min(CAPS.energy, actor.energy * 2)
        : Math.min(CAPS.energy, actor.energy + cost)
      if (actor.energy > before) note(`${actor.name} gains ${actor.energy - before} Energy`)
      return
    }
    case 'gainEnergyIfTargetDead': {
      const target = typeof context.enemyUid === 'string'
        ? state.enemies.find((enemy) => enemy.uid === context.enemyUid)
        : undefined
      if (!target?.dead) return
      const before = actor.energy
      actor.energy = Math.min(CAPS.energy, actor.energy + effect.amount)
      if (actor.energy > before) note(`${actor.name} gains ${actor.energy - before} Energy`)
      return
    }
    case 'gainShiv': {
      for (const target of supportTargets(state, effect, supportScope, context, actor)) {
        const available = Math.max(0, CAPS.shivs - state.players.reduce((sum, player) => sum + player.shivs, 0))
        const gained = Math.min(available, effect.amount)
        target.shivs += gained
        if (gained > 0) {
          note(`${target.name} gains ${gained} Shiv`)
          markTurnEffect(context, 'buff', target.id === actor.id ? { actor: true } : { playerId: target.id })
        }
        // The five cubes are a shared supply. A Shiv that cannot be taken may
        // be thrown immediately instead, using the card's chosen enemy (p.17).
        for (let i = gained; i < effect.amount; i++) {
          const at = context.shivTargetIndex ?? 0
          const enemyUid = context.shivEnemyUids?.[at]
          context.shivTargetIndex = at + 1
          if (context.previewShivTarget?.(state, at, enemyUid, true)) {
            context.invalidShivTarget = true
            return
          }
          if (!enemyUid) continue
          if (resolveEnemyTargets(state, 'enemy', enemyUid).length === 0) {
            context.invalidShivTarget = true
            continue
          }
          resolveShivAttack(state, target, enemyUid, 1 + target.shivDamageBonus, context)
          recordAttackPlayed(state, target)
          if (target.dead || combatIsOver(state)) return
        }
      }
      return
    }
    case 'gainShivPerDiscard':
      return applyEffect(state, actor, {
        kind: 'gainShiv', amount: (context.discardedByCard ?? 0) + effect.bonus,
      }, scope, supportScope, context, source)
    case 'useAllShivs': {
      const count = actor.shivs
      actor.shivs = 0
      if (context.sourceCardType === 'attack' && !context.sourceAttackCounted) {
        recordAttackPlayed(state, actor)
        context.sourceAttackCounted = true
      }
      if (count > 0) note(`${actor.name} uses ${count} Shiv${count === 1 ? '' : 's'}`)
      for (let i = 0; i < count; i++) {
        const at = context.shivTargetIndex ?? 0
        const enemyUid = context.shivEnemyUids?.[at]
        context.shivTargetIndex = at + 1
        if (context.previewShivTarget?.(state, at, enemyUid, false)) {
          context.invalidShivTarget = true
          return
        }
        if (!enemyUid || resolveEnemyTargets(state, 'enemy', enemyUid).length === 0) {
          context.invalidShivTarget = true
          continue
        }
        resolveShivAttack(state, actor, enemyUid, 1 + actor.shivDamageBonus + effect.bonus, context)
        recordAttackPlayed(state, actor)
        if (actor.dead || combatIsOver(state)) break
      }
      return
    }
    case 'gainMiracle': {
      for (const target of supportTargets(state, effect, supportScope, context, actor)) {
        const available = Math.max(0, CAPS.miracles - state.players.reduce((sum, player) => sum + player.miracles, 0))
        const amount = amountOf(effect.amount, state, actor, undefined, context)
        const before = target.miracles
        target.miracles += Math.min(available, amount)
        if (target.miracles > before) {
          note(`${target.name} gains ${target.miracles - before} Miracle`)
          markTurnEffect(context, 'buff', target.id === actor.id ? { actor: true } : { playerId: target.id })
        }
      }
      return
    }
    case 'enterStance': {
      // Always the caster. Vigilance reads "2 Block to any player. Enter Calm."
      // — the target clause belongs to the Block, and no printed card puts an
      // ally into a stance (only the Prismatic Shard can, per docs/rules.md).
      if (actor.stance === effect.stance) return
      note(`${actor.name} enters ${effect.stance}`)
      // Leaving Calm grants 2 energy.
      if (actor.stance === 'calm') {
        const before = actor.energy
        actor.energy = Math.min(CAPS.energy, actor.energy + 2)
        // Leaving Calm pays 2 Energy. Unlogged, a card that cost 2 looked free.
        if (actor.energy > before) note(`${actor.name} gains ${actor.energy - before} Energy from Calm`)
      }
      actor.stance = effect.stance
      if (!state.stanceChangedThisTurn.includes(actor.id)) state.stanceChangedThisTurn.push(actor.id)
      const event = { kind: 'onEnterStance' as const, stance: effect.stance }
      if (context.pendingTriggers) context.pendingTriggers.push(...queuedTriggers(state, event, actor))
      else fireTriggers(state, event, actor)
      return
    }
    case 'discountNextCard': {
      actor.freeCardsThisTurn = (actor.freeCardsThisTurn ?? 0) + 1
      note(`${actor.name}'s next card costs 0 this turn`)
      markTurnEffect(context, 'buff', { actor: true })
      return
    }
    case 'setNextCardCost': {
      const changed = actor.nextCardCost !== effect.amount
      actor.nextCardCost = effect.amount
      note(`${actor.name}'s next card costs ${effect.amount} Energy this turn`)
      if (changed) markTurnEffect(context, 'buff', { actor: true })
      return
    }
    case 'discountNextAttack': {
      actor.freeAttacksThisTurn = (actor.freeAttacksThisTurn ?? 0) + 1
      note(`${actor.name}'s next Attack costs 0 this turn`)
      markTurnEffect(context, 'buff', { actor: true })
      return
    }
    case 'discountHand': {
      const changed = actor.hand.some((card) => !card.freeThisTurn)
      actor.hand = actor.hand.map((card) => ({ ...card, freeThisTurn: true }))
      note(`${actor.name}'s cards in hand cost 0 this turn`)
      if (changed) markTurnEffect(context, 'buff', { actor: true })
      return
    }
    case 'discountRetainedCards': {
      const changed = actor.hand.some((card) => card.retainedLastTurn)
      actor.hand = actor.hand.map((card) => card.retainedLastTurn
        ? { ...card, costReductionThisTurn: (card.costReductionThisTurn ?? 0) + effect.amount }
        : card)
      note(`${actor.name}'s Retained cards cost ${effect.amount} less this turn`)
      if (changed) markTurnEffect(context, 'buff', { actor: true })
      return
    }
    case 'doubleNextAttack': {
      actor.doubledAttacksThisTurn = (actor.doubledAttacksThisTurn ?? 0) + 1
      note(`${actor.name}'s next Attack will be played twice`)
      markTurnEffect(context, 'buff', { actor: true })
      return
    }
    case 'tripleNextAttack': {
      actor.tripledAttacksThisTurn = (actor.tripledAttacksThisTurn ?? 0) + 1
      note(`${actor.name}'s next Attack will be played three times`)
      markTurnEffect(context, 'buff', { actor: true })
      return
    }
    case 'doubleNextAttackOrSkill': {
      actor.doubledCardsThisTurn = (actor.doubledCardsThisTurn ?? 0) + 1
      note(`${actor.name}'s next Attack or Skill will be played twice`)
      markTurnEffect(context, 'buff', { actor: true })
      return
    }
    case 'doubleNextSkill': {
      actor.doubledSkillsThisTurn = (actor.doubledSkillsThisTurn ?? 0) + 1
      note(`${actor.name}'s next Skill will be played twice`)
      markTurnEffect(context, 'buff', { actor: true })
      return
    }
    case 'retainAtEndOfTurn': {
      actor.retainCardsThisTurn = (actor.retainCardsThisTurn ?? 0) + effect.amount
      note(`${actor.name} may Retain ${effect.amount} card${effect.amount === 1 ? '' : 's'} this turn`)
      if (effect.amount > 0) markTurnEffect(context, 'buff', { actor: true })
      return
    }
    case 'retainForBlock': {
      actor.retainCardsThisTurn = (actor.retainCardsThisTurn ?? 0) + effect.amount
      actor.retainBlockAllowance = (actor.retainBlockAllowance ?? 0) + effect.amount
      note(`${actor.name} may Retain ${effect.amount} cards this turn, gaining 1 Block for each`)
      markTurnEffect(context, 'buff', { actor: true })
      return
    }
    case 'upgradeStarterCards': {
      actor.starterStrikeDamageBonus = (actor.starterStrikeDamageBonus ?? 0) + effect.amount
      actor.starterDefendBlockBonus = (actor.starterDefendBlockBonus ?? 0) + effect.amount
      note(`${actor.name}'s starter Strikes and Defends get +${effect.amount}`)
      return
    }
    case 'empowerStarterStrikes': {
      const cubes = amountOf(effect.amount, state, actor, undefined, context)
      actor.starterStrikeDamageBonus = (actor.starterStrikeDamageBonus ?? 0) + cubes
      context.sourceCounter = cubes
      note(`${actor.name} puts ${cubes} cubes on Conjure Blade; starter Strikes deal +${cubes} damage`)
      return
    }
    case 'switchRows': {
      if (context.switchWithPlayerId === null || context.switchWithPlayerId === undefined) return
      const other = findPlayer(state, context.switchWithPlayerId)
      if (!other || other.dead || other.id === actor.id) return
      const row = actor.row
      actor.row = other.row
      other.row = row
      note(`${actor.name} switches rows with ${other.name}`)
      return
    }
    case 'gainWrathAttackDamageBonus': {
      actor.wrathAttackDamageBonus = (actor.wrathAttackDamageBonus ?? 0) + effect.amount
      note(`${actor.name}'s Attacks deal +${effect.amount} damage while in Wrath`)
      return
    }
    case 'gainShivDamageBonus': {
      actor.shivDamageBonus += effect.amount
      note(`${actor.name}'s Shivs deal +${effect.amount} damage`)
      return
    }
    case 'gainCardBlockBonus': {
      actor.cardBlockBonus += effect.amount
      note(`${actor.name}'s Attack and Skill Block gets +${effect.amount}`)
      return
    }
    case 'gainHitPoison': {
      actor.hitPoison += effect.amount
      note(`${actor.name}'s hits apply ${effect.amount} Poison`)
      return
    }
    case 'gainClawCube': {
      actor.clawCubesGainedThisCombat = (actor.clawCubesGainedThisCombat ?? 0) + effect.amount
      note(`${actor.name} gains ${effect.amount} Claw cube`)
      return
    }
  }
}

/**
 * Applies one effect. Mutates the draft state, which is always a clone owned by
 * the caller — never the state handed in from outside.
 */
export function applyEffect(
  state: CombatState,
  actor: Player,
  effect: Effect,
  scope: TargetScope,
  supportScope: TargetScope,
  context: PlayContext,
  /** The Power or relic that caused this, when it was not a card being played. */
  source?: string,
  /** Keep the attacker's Weak until a parent multi-target clause finishes. */
  deferWeakSpend = false,
  /** Keep each target's Vulnerable until a parent multi-target clause finishes. */
  deferVulnerableSpend = false,
): void {
  // Slime Boss clauses do not pass through `effectIsActive` gating.
  if (isSlimeEffect(effect)) {
    applySlimeEffect(state, actor, effect, scope, supportScope, context, slimeEffectCallbacks, source)
    return
  }

  // A whole clause that the board can switch off, as the Weak on Go for the
  // Eyes is. Checked before the target scope is resolved, because a clause that
  // does not happen does not pick a target either.
  //
  // Conditions that read a TARGET are not usable here — there is no one target
  // yet — and the only one of those, `targetPoisoned`, is a damage bonus that
  // belongs inside an `Amount`. `verify-architecture.mjs` holds that line.
  if (!effectIsActive(effect, state, actor, context)) return

  if (effect.kind === 'sequence') {
    if (effect.guardianAction === 'card') {
      resolveGuardianCard(state, actor, scope, supportScope, context, source)
      return
    }
    if (effect.guardianGemId) {
      resolveGuardianGem(state, actor, effect.guardianGemId, scope, supportScope, context, source)
      return
    }
    for (const nested of effect.effects) {
      applyEffect(state, actor, nested, scope, supportScope, context, source,
        deferWeakSpend, deferVulnerableSpend)
      if (combatIsOver(state)) break
    }
    return
  }
  if (effect.kind === 'branch') {
    const branch = conditionIsActive(effect.condition, state, actor, context) ? effect.effects : effect.otherwise
    for (const nested of branch) {
      applyEffect(state, actor, nested, scope, supportScope, context, source,
        deferWeakSpend, deferVulnerableSpend)
      if (combatIsOver(state)) break
    }
    return
  }
  if (isDamageEffect(effect)) {
    applyDamageEffect(state, actor, effect, scope, supportScope, context, source,
      deferWeakSpend, deferVulnerableSpend)
    return
  }
  if (isBlockAndStatusEffect(effect)) {
    applyBlockAndStatusEffect(state, actor, effect, scope, supportScope, context, source)
    return
  }
  if (isResourceAndStanceEffect(effect)) {
    applyResourceAndStanceEffect(state, actor, effect, scope, supportScope, context, source)
    return
  }
  if (isOrbEffect(effect)) {
    applyOrbEffect(state, actor, effect, scope, supportScope, context, orbCallbacks, source)
    return
  }
  if (isCardFlowEffect(effect)) {
    applyCardFlowEffect(state, actor, effect, scope, supportScope, context, cardFlowEffectCallbacks, source)
    return
  }
  if (isHermitEffect(effect)) {
    applyHermitEffect(state, actor, effect, scope, supportScope, context, hermitEffectCallbacks, source)
    return
  }

  const exhaustive: never = effect
  return exhaustive
}

/**
 * The one place a player's Block goes up.
 *
 * Three separate sites used to write `player.block` and only this one fired
 * the trigger, so a Frost orb quietly skipped every Block-reacting Power. A
 * single funnel is the only version of this that cannot drift again.
 *
 * The trigger fires only on a real increase: at the 20 Block cap the gain is a
 * no-op, and a Power reacting to a no-op is paying out for nothing.
 */
export function grantBlock(
  state: CombatState,
  target: Player,
  amount: number,
  pendingTriggers?: PendingTrigger[],
): void {
  if (!playerCanGainBlock(target)) return
  const before = target.block
  target.block = gainBlock(target.block, amount)
  if (target.block <= before) return
  const event = { kind: 'onGainBlock' as const }
  if (pendingTriggers) pendingTriggers.push(...queuedTriggers(state, event, target))
  else fireTriggers(state, event, target)
}

/**
 * The one place cards are drawn.
 *
 * Same reasoning as `grantBlock`: the Start of Turn draw of 5 is the biggest
 * draw in the game and it used to bypass the trigger path entirely, so an
 * on-draw Power saw nothing and an on-shuffle Power missed the reshuffle that
 * the Start of Turn draw is the usual cause of.
 */
export function drawInto(
  state: CombatState,
  actor: Player,
  amount: number,
  pendingTriggers?: PendingTrigger[],
): CardInstance[] {
  if (actor.drawLocked) return []
  const handSize = actor.hand.length
  const result = drawCards(state.rng, actor, amount)
  const drawnCards = result.hand.slice(handSize)
  actor.draw = result.draw
  actor.hand = result.hand
  actor.discard = result.discard
  // The reshuffle lands in the MIDDLE of the draw (p.12): cards taken before
  // the pile ran out were drawn first, then it was shuffled, then the rest.
  // Firing all the draws on one side of the shuffle gets the order wrong in
  // both directions.
  for (let i = 0; i < result.drawn; i++) {
    if (result.reshuffled && i === result.reshuffledAfter) {
      actor.shuffledThisCombat = true
      state.log = [...state.log, `${actor.name} shuffles their discard pile back in`]
      if (pendingTriggers) pendingTriggers.push(...queuedTriggers(state, { kind: 'onShuffle' }, actor))
      else fireTriggers(state, { kind: 'onShuffle' }, actor)
    }
    const event = { kind: 'onDraw' as const, cardType: effectiveCombatCardDef(
      faceOf(cardDef(drawnCards[i]!.defId), drawnCards[i]!.upgraded), actor.guardianMode,
    ).type }
    if (pendingTriggers) pendingTriggers.push(...queuedTriggers(state, event, actor))
    else fireTriggers(state, event, actor)
    if (drawnCards[i]!.defId === 'burn' && state.enemies.some((enemy) => !enemy.dead &&
      enemyAbilities(enemyDef(enemy.defId, enemy.ascension)).some((ability) => ability.kind === 'fireBreathing'))) {
      drawInto(state, actor, 1, pendingTriggers)
      state.log = [...state.log, `${actor.name} draws another card from Fire Breathing`]
    }
    // Slayer Pack: A card that plays itself as it is drawn interrupts the
    // draw, exactly as drawing one card at a time would: the cards this batch
    // had already taken go back on top first, the card plays (its Daze and any
    // draw its play sets off take from that top), then the rest of the draw is
    // drawn again. A batch that reshuffled after this card is left as dealt,
    // because the play might mean the pile never ran out.
    if (faceOf(cardDef(drawnCards[i]!.defId), drawnCards[i]!.upgraded).playOnDraw &&
      drawnCardPlaysItself(state, actor, drawnCards[i]!)) {
      const rest = i < result.drawn - 1 && (!result.reshuffled || result.reshuffledAfter <= i)
        ? drawnCards.slice(i + 1) : []
      const restUids = new Set(rest.map((card) => card.uid))
      if (rest.length > 0) {
        actor.hand = actor.hand.filter((card) => !restUids.has(card.uid))
        actor.draw = [...rest, ...actor.draw]
      }
      playDrawnCardImmediately(state, actor, drawnCards[i]!)
      if (rest.length > 0) {
        if (combatIsOver(state)) return drawnCards.slice(0, i + 1)
        return [...drawnCards.slice(0, i + 1), ...drawInto(state, actor, rest.length, pendingTriggers)]
      }
    }
    if (drawnCards[i]!.defId === 'slimed' && actor.energy > 0 && state.enemies.some((enemy) =>
      !enemy.dead && enemyAbilities(enemyDef(enemy.defId, enemy.ascension))
        .some((ability) => ability.kind === 'void'))) {
      actor.energy -= 1
      actor.hand = actor.hand.filter((card) => card.uid !== drawnCards[i]!.uid)
      exhaustCards(state, actor, [drawnCards[i]!])
      state.log = [...state.log, `${actor.name} spends 1 Energy and Exhausts Slimed to Void`]
    }
  }
  return drawnCards
}

/** Exhaust cards once and retain them in the player's exhaust pile. */
export function exhaustCards(
  state: CombatState,
  actor: Player,
  cards: readonly Player['hand'][number][],
  context?: PlayContext,
): void {
  const lasting = cards.map((card) => metamorphosisCard(forgetRetain(card)))
  actor.exhaust = [...actor.exhaust, ...lasting]
  if (cards.length > 0) markTurnEffect(context, 'exhaust', { actor: true })
  for (const card of lasting) {
    if (context?.pendingExhaustTriggers) {
      context.pendingExhaustTriggers.push({ playerId: actor.id, card })
    } else {
      resolveExhaustReaction(state, actor, card)
    }
  }
  // Slayer Pack: A Metamorphosis attached to an exhausted Power is exhausted with it.
  if (cards.length > 0) followCopiedPowers(state, actor, new Set(cards.map((card) => card.uid)), 'exhaust', exhaustCards, context)
}

export function resolveExhaustReaction(state: CombatState, actor: Player, card: CardInstance): void {
  const def = faceOf(cardDef(card.defId), card.upgraded)
  for (const effect of def.exhaustReaction?.effects ?? []) {
    applyEffect(state, actor, effect, 'enemy', 'self', {
      enemyUid: livingEnemies(state)[0]?.uid ?? null,
      playerId: actor.id,
    }, `${actor.name}'s ${def.name}`)
  }
  fireTriggers(state, { kind: 'onExhaust' }, actor)
}

/** Discard from a card effect, deferring reactions until its printed text ends (p.12). */
export function discardByCardEffect(
  state: CombatState,
  actor: Player,
  cards: readonly CardInstance[],
  context?: PlayContext,
): void {
  if (cards.length === 0) return
  const before = [actor.hand, actor.draw, actor.discard]
    .map((pile) => pile.map((card) => card.uid).join('\u0000')).join('\u0001')
  const uids = new Set(cards.map((card) => card.uid))
  const discarded = cards.map(forgetRetain)
  // Slayer Pack: Cards leaving an enemy they were attached to are not from hand or draw.
  const fromPiles = [...actor.hand, ...actor.draw].filter((card) => uids.has(card.uid)).length
  actor.hand = actor.hand.filter((card) => !uids.has(card.uid))
  actor.draw = actor.draw.filter((card) => !uids.has(card.uid))
  actor.discard = [...actor.discard.filter((card) => !uids.has(card.uid)), ...discarded]
  const after = [actor.hand, actor.draw, actor.discard]
    .map((pile) => pile.map((card) => card.uid).join('\u0000')).join('\u0001')
  if (after !== before) markTurnEffect(context, 'discard', { actor: true })
  if (!state.discardedThisTurn.includes(actor.id)) state.discardedThisTurn.push(actor.id)
  state.log = [...state.log, `${actor.name} discards ${cards.length}`]

  if (context?.pendingDiscards) {
    context.pendingDiscards.push({ playerId: actor.id, cards: discarded })
    return
  }
  resolveDiscardReactions(state, actor, discarded, fromPiles)
}

export function resolveDiscardReactions(
  state: CombatState,
  actor: Player,
  cards: readonly CardInstance[],
  fromPiles = cards.length,
): void {
  for (const held of cards) {
    const def = faceOf(cardDef(held.defId), held.upgraded)
    if (!def.discardReaction) continue
    for (const effect of def.discardReaction.effects) {
      applyEffect(state, actor, effect, 'enemy', 'self', { enemyUid: null, playerId: actor.id }, def.name)
    }
    if (def.discardReaction.exhaust) {
      actor.hand = actor.hand.filter((card) => card.uid !== held.uid)
      actor.draw = actor.draw.filter((card) => card.uid !== held.uid)
      actor.discard = actor.discard.filter((card) => card.uid !== held.uid)
      exhaustCards(state, actor, [held])
      state.log = [...state.log, `${actor.name} exhausts ${def.name}`]
    }
  }
  fireTriggers(state, { kind: 'onDiscard', count: fromPiles }, actor)
}

/**
 * Auto-Shields: "Whenever you draw this card, play it immediately, if able."
 *
 * The card prints no choice (Block for its owner, a Daze on top of the draw
 * pile), so the play resolves right here inside the draw, one card at a time:
 * a Daze it adds is the next card a longer draw takes. It is a real play for
 * every counter that reads one (cards and Skills played this turn, next-card
 * costs, Burst and Echo Form, Corruption, Enraged, "when you play" Powers and
 * Pressure Points). It lives here rather than in `playCard` because the play
 * happens in the middle of a draw, which sits below `play.ts` in the module
 * graph; each resolution fires the same `onPlayCard` and Enraged reactions
 * `playCard` and `playCardCopy` fire. "If able" is a Player Turn card play the board allows: not once the turn has
 * started ending, not while card play is locked or at the Time Warp limit, and
 * only when its current cost can be paid.
 */
function drawnCardPlaysItself(state: CombatState, actor: Player, card: CardInstance): boolean {
  if (actor.dead || state.endTurnProgress || !['start', 'player', 'copy'].includes(state.phase) ||
    !actor.hand.some((held) => held.uid === card.uid)) return false
  const def = effectiveCombatCardDef(faceOf(cardDef(card.defId), card.upgraded), actor.guardianMode)
  if (!cardIsPlayable(def, state, actor) || reachedTimeWarpLimit(state, actor)) return false
  const cost = playCost(def, actor, card)
  return cost !== 'X' && cost <= actor.energy
}

function playDrawnCardImmediately(state: CombatState, actor: Player, card: CardInstance): boolean {
  if (!drawnCardPlaysItself(state, actor, card)) return false
  const def = effectiveCombatCardDef(faceOf(cardDef(card.defId), card.upgraded), actor.guardianMode)
  const cost = playCost(def, actor, card) as number
  actor.hand = actor.hand.filter((held) => held.uid !== card.uid)
  actor.energy -= cost
  actor.energySpentThisTurn = (actor.energySpentThisTurn ?? 0) + cost
  if (cost >= 2) actor.spentTwoEnergyOnCardThisTurn = true
  actor.nextCardCost = null
  actor.enemyNextCardCost = null
  if ((actor.freeCardsThisTurn ?? 0) > 0) actor.freeCardsThisTurn = actor.freeCardsThisTurn! - 1
  // The same single play-twice source `playCard` would spend on this card.
  const copies = copySourcesFor(def, actor)
  consumeCopySource(actor, copies)
  addPresentationEvent(state, {
    kind: 'card', actorId: actor.id, sourceId: def.id, upgraded: card.upgraded, copied: copies.length > 0,
    energy: cost, resolvedType: def.type,
    ...presentationTargets(state, actor.id, 'self', def.supportTarget ?? 'self', { playerId: actor.id }),
  })
  state.log = [...state.log, `${actor.name} played ${def.name} as it was drawn`]
  // Each resolution is a card play of its own, as `playCard` and `playCardCopy`
  // count them: the copies first, then the physical card, which is cleaned up
  // before its own reactions. Auto-Shields has finished resolving when it is
  // drawn mid-card, so its reactions (on-play Powers, Pressure Points, Enraged)
  // resolve right away rather than waiting for the card that drew it.
  for (let resolution = 0; resolution <= copies.length; resolution++) {
    const copied = resolution < copies.length
    actor.cardsPlayedThisTurn = (actor.cardsPlayedThisTurn ?? 0) + 1
    if (def.type === 'attack' || def.type === 'skill') {
      state.playedCardsThisTurn = [...(state.playedCardsThisTurn ?? []),
        { playerId: actor.id, card: forgetRetain(card), copied, type: def.type }]
    }
    const context = resolutionContext({ enemyUid: null, playerId: actor.id }, def, card, 0, copied)
    for (const effect of def.effects) {
      applyEffect(state, actor, effect, def.target ?? 'enemy', def.supportTarget ?? 'self', context)
      if (combatIsOver(state)) return true
    }
    if (!copied) {
      if (playedCardExhausts(state, actor, def, card.uid)) exhaustCards(state, actor, [card])
      else actor.discard = [...actor.discard, forgetRetain(card)]
      if (combatIsOver(state)) return true
    }
    fireTriggers(state, { kind: 'onPlayCard', cardType: def.type }, actor, card.uid)
    if (def.type === 'skill' && !combatIsOver(state)) resolveEnraged(state, actor)
    if (combatIsOver(state)) return true
    releasePendingTriggers(state, context)
  }
  return true
}

/**
 * Deceive Reality: whether `cardUid`, one of `revealed` (the top of the draw
 * pile, in order), could be played for 0 once the Scry binning `discardUids`
 * has finished. Judged on a throwaway copy exactly as it will be played: the
 * card in hand, the binned cards gone with their discard reactions resolved,
 * and the resolving card already counted. No random number of the real state
 * is consumed.
 */
export function scryPlayCardPlayable(
  state: CombatState,
  playerId: string,
  revealed: readonly CardInstance[],
  cardUid: string,
  discardUids: readonly string[],
): boolean {
  const card = revealed.find((candidate) => candidate.uid === cardUid)
  if (!card || discardUids.includes(cardUid) || faceOf(cardDef(card.defId), card.upgraded).unplayable) return false
  const probe = clone({ ...state, log: [], presentationEvents: [] })
  const actor = findPlayer(probe, playerId)
  if (!actor) return false
  const shown = new Set(revealed.map((candidate) => candidate.uid))
  actor.draw = [...revealed.filter((candidate) => candidate.uid !== cardUid),
    ...actor.draw.filter((candidate) => !shown.has(candidate.uid))]
  const context: PlayContext = {
    enemyUid: null, playerId, scryDiscardUids: [...discardUids], pendingDiscards: [], pendingTriggers: [],
  }
  applyEffect(probe, actor, { kind: 'scry', amount: revealed.length - 1 }, 'enemy', 'self', context)
  if (invalidPlayChoice(context)) return false
  for (const pending of context.pendingDiscards ?? []) {
    const owner = findPlayer(probe, pending.playerId)
    if (owner) resolveDiscardReactions(probe, owner, pending.cards)
  }
  if (combatIsOver(probe)) return false
  actor.hand = [...actor.hand, forgetRetain(card)]
  return cardPlayWindowCardPlayable(probe, actor, card, 0)
}

export function closeCardPlayWindow(state: CombatState, player: Player): void {
  closeCardPlayWindowWithDiscard(state, player, discardByCardEffect)
}

export function closeAllCardPlayWindows(state: CombatState): void {
  closeAllCardPlayWindowsWithDiscard(state, discardByCardEffect)
}

/** Next legal target after applying every already-staged Evoke in sequence. */
export function evokeTargetProgress(
  def: CardDef,
  state: CombatState,
  actor: Player,
  slots: readonly number[],
  targets: readonly (string | null | undefined)[],
  mode?: number,
  energySpent = 0,
): { index: number; options: { uid: string; label: string }[]; complete: boolean } {
  return evokeTargetProgressWithCallbacks(def, state, actor, slots, targets, orbCallbacks, mode, energySpent)
}

export function resolveEnraged(state: CombatState, actor: Player): void {
  resolveEnragedWithDamage(state, actor, damagePlayer)
}

/** Records one played Attack and resolves Hermit's once-per-turn threshold. */
export function recordAttackPlayed(state: CombatState, actor: Player): void {
  actor.attacksPlayedThisTurn = (actor.attacksPlayedThisTurn ?? 0) + 1
  resolveOverwhelmingPower(state, actor)
}

/** Check the threshold both when an Attack resolves and when the Power enters play. */
export function resolveOverwhelmingPower(state: CombatState, actor: Player): void {
  const power = actor.powers.find((held) => held.defId === 'hermit_overwhelming_power')
  const key = power && `power:${power.uid}`
  if (!power || actor.attacksPlayedThisTurn < 2 || state.powerTriggersUsedThisTurn.includes(key!)) return
  state.powerTriggersUsedThisTurn.push(key!)
  drawInto(state, actor, 2)
}

/** Completes nested Havocs from the innermost card back to the outermost. */
export function finishDeferredHavocs(
  state: CombatState,
  actor: Player,
  deferred: readonly DeferredHavoc[],
): PendingTrigger[] {
  const remaining = [...deferred]
  const pendingTriggers: PendingTrigger[] = []
  while (remaining.length > 0) {
    const { card, exhaust, remainingEffects, virtualOnly, copySourceNames, copyResumePhase } = remaining.pop()!
    if (combatIsOver(state)) return pendingTriggers
    const def = effectiveCombatCardDef(faceOf(cardDef(card.defId), card.upgraded), actor.guardianMode)
    if (remainingEffects?.length) {
      const context = resolutionContext(
        { enemyUid: null, playerId: actor.id }, def, card, 0,
        virtualOnly === true || Boolean(copySourceNames?.length),
      )
      for (const effect of remainingEffects) {
        applyEffect(state, actor, effect, def.target ?? 'enemy', def.supportTarget ?? 'self', context)
        if (combatIsOver(state)) return pendingTriggers
      }
      pendingTriggers.push(...(context.pendingTriggers ?? []))
    }
    if (copySourceNames?.length && !cardCanBeForced(def, state, actor, guardianGemForCard(actor, card), card.uid, false)) {
      if (!virtualOnly) {
        if (exhaust) exhaustCards(state, actor, [card])
        else actor.discard = [...actor.discard, card]
      }
      state.log = [...state.log, `${actor.name}'s ${copySourceNames[0]} copy of ${def.name} could not be played`]
      continue
    }
    if (copySourceNames?.length) {
      if (def.type === 'attack') recordAttackPlayed(state, actor)
      fireTriggers(state, { kind: 'onPlayCard', cardType: def.type }, actor, card.uid)
      if (combatIsOver(state)) return pendingTriggers
      if (def.type === 'skill') resolveEnraged(state, actor)
      if (combatIsOver(state)) return pendingTriggers
      state.pendingCardCopy = {
        id: state.nextTriggerId++,
        playerId: actor.id,
        card: { ...card },
        energySpent: 0,
        resumePhase: copyResumePhase ?? 'player',
        forcedExhaust: exhaust,
        forcedChoices: null,
        deferredHavocs: remaining,
        sourceNames: copySourceNames,
        finalResolutionCopied: copySourceNames.every((source) => source === 'Rapid Fire'),
      }
      state.phase = 'copy'
      state.log = [...state.log,
        `${actor.name}'s ${copySourceNames[0]} copy finished; ${def.name} remains to resolve`]
      return pendingTriggers
    }
    if (!virtualOnly) {
      if (exhaust) exhaustCards(state, actor, [card])
      else actor.discard = [...actor.discard, card]
    }
    if (combatIsOver(state)) return pendingTriggers
    if (def.type === 'attack') recordAttackPlayed(state, actor)
    fireTriggers(state, { kind: 'onPlayCard', cardType: def.type }, actor, card.uid)
    if (combatIsOver(state)) return pendingTriggers
    if (def.type === 'skill') resolveEnraged(state, actor)
  }
  return pendingTriggers
}

/**
 * Resolves one Orb's end-turn effect; each Orb is separately ordered (p.16).
 */
export function resolveOrbAtEndOfTurn(state: CombatState, actor: Player, slot: number, targetUid?: string): boolean {
  return resolveOrbAtEndOfTurnWithCallbacks(state, actor, slot, orbCallbacks, targetUid)
}

/**
 * How deep a trigger chain may go. A Power that gains Block whenever it gains
 * Block would otherwise recurse until the stack blew. The board game has no
 * such card, but the engine must not be one data entry away from a hang, and a
 * silent infinite loop is far worse than a chain that stops.
 *
 * Triggers past this depth are DROPPED, silently and deliberately: there is no
 * sensible way to surface it mid-resolution, and a truncated chain is a better
 * failure than a frozen tab. If a real card ever chains deeper than this, the
 * cap is the thing to revisit — a legitimate combo would look like a card
 * quietly under-performing rather than an error. Draw events are exempt: a
 * draw-only chain consumes the finite draw/discard piles, while any cyclic
 * non-draw event it fires still passes through this guard.
 */
export const MAX_TRIGGER_DEPTH = 8

let triggerDepth = 0

export function fireTriggers(
  state: CombatState,
  event: TriggerEvent,
  only?: Player,
  excludeUid?: string,
): void {
  const finiteDrawChain = event.kind === 'onDraw'
  if (!finiteDrawChain && triggerDepth >= MAX_TRIGGER_DEPTH) return
  if (!finiteDrawChain) triggerDepth++
  try {
    fireTriggersInner(state, event, only, excludeUid)
    // Slayer Pack: Pressure Points answers each Skill its owner plays.
    if (event.kind === 'onPlayCard' && event.cardType === 'skill' && only && !combatIsOver(state)) {
      resolveSlayerAttachedDamage(state, only, 'skill', null, damageEnemyLogged, excludeUid)
    }
  } finally {
    if (!finiteDrawChain) triggerDepth--
  }
}

export function resolveTriggerSource(
  state: CombatState,
  player: Player,
  source: TriggerSource,
  {
    allowCombatOver = false, shivEnemyUids, enemyUid, enemyRow, evokeSlots, evokeEnemyUids,
    scryDiscardUids, targetPlayerId, exhaustUids, hermitContext,
  }: TriggerResolutionOptions = {},
): boolean {
  // Revalidate staged targets before this source begins; later Commands may still kill their own targets.
  if (hermitContext?.slimeEnemyUids?.some((uid) => !livingEnemies(state).some((enemy) => enemy.uid === uid))) return false
  const exhaust = source.effects.find((effect) => effect.kind === 'exhaustFromHand')
  if (exhaust) {
    const chosen = exhaustUids ?? []
    const required = Math.min(exhaust.amount, player.hand.length)
    if (chosen.length !== required || new Set(chosen).size !== chosen.length ||
      chosen.some((uid) => !player.hand.some((card) => card.uid === uid))) return false
  } else if (exhaustUids !== undefined) return false
  const useKey = source.powerUid ? powerAbilityKey(player.id, source.powerUid) : `${player.id}/${source.id}`
  if (source.oncePerTurn) {
    const used = (state.powerTriggersUsedThisTurn ??= [])
    if (used.includes(useKey)) return true
    used.push(useKey)
  }
  const activeTurnEffects = TURN_PRESENTATION_TRIGGERS.has(source.trigger.kind)
    ? activeTurnEffectLeaves(source.effects, state, player)
    : []
  const turnEffectApplications: NonNullable<PlayContext['turnEffectApplications']> | undefined =
    activeTurnEffects.length > 0 ? [] : undefined
  const presentTurnEffects = () => publishTurnEffectApplications(
    state, player.id, source.presentationSourceId, turnEffectApplications ?? [],
  )
  const loop = source.effects.find((effect) => effect.kind === 'triggerOrbEndTurn')
  if (loop) {
    const slot = evokeSlots?.[0]
    if (slot === undefined) {
      const resolved = loopOrbTargets(player) === undefined
      if (resolved) presentTurnEffects()
      return resolved
    }
    const orb = player.orbs[slot]
    let target = evokeEnemyUids?.[0] ?? undefined
    if (orb === 'lightning' && !target) target = lightningTargetOptions(state, player)[0]?.uid
    if (!orb || (orb === 'lightning' && !target) || (orb === 'frost' && target !== undefined)) return false
    for (let index = 0; index < loop.amount; index++) {
      // Loop+ repeats one chosen Orb. If its first Lightning trigger kills the
      // chosen enemy, keep the Orb slot and aim the repeat at the next legal
      // enemy instead of dropping the rest of the printed effect.
      if (orb === 'lightning' && !lightningDamageTargets(state, player, target)) {
        target = lightningTargetOptions(state, player)[0]?.uid
      }
      if (!resolveOrbAtEndOfTurn(state, player, slot, target)) {
        if (index === 0) return false
        break
      }
      if (combatIsOver(state)) break
    }
    presentTurnEffects()
    return true
  }
  const target = livingEnemies(state)[0]
  const pendingTriggers: PendingTrigger[] = []
  const context: PlayContext = {
    enemyUid: enemyUid ?? target?.uid ?? null,
    enemyRow,
    playerId: targetPlayerId ?? player.id,
    shivEnemyUids: shivEnemyUids ? [...shivEnemyUids] : undefined,
    shivTargetIndex: 0,
    invalidShivTarget: false,
    evokeSlots: evokeSlots ? [...evokeSlots] : undefined,
    evokeEnemyUids: evokeEnemyUids ? [...evokeEnemyUids] : undefined,
    scryDiscardUids: scryDiscardUids ? [...scryDiscardUids] : undefined,
    evokeIndex: 0,
    invalidEvokeTarget: false,
    sourcePowerUid: source.powerUid,
    presentationSourceId: source.presentationSourceId,
    pendingTriggers,
    exhaustUids: exhaustUids ? [...exhaustUids] : undefined,
    loadUids: hermitContext?.loadUids ? [...hermitContext.loadUids] : undefined,
    chamberUids: hermitContext?.chamberUids ? [...hermitContext.chamberUids] : undefined,
    hermitEnemyUids: hermitContext?.hermitEnemyUids ? [...hermitContext.hermitEnemyUids] : undefined,
    slimeUids: hermitContext?.slimeUids ? [...hermitContext.slimeUids] : undefined,
    slimeEnemyUids: hermitContext?.slimeEnemyUids ? [...hermitContext.slimeEnemyUids] : undefined,
    slimeEnemyChoiceIndex: 0,
    pendingSlimeCommandUids: [],
    turnEffectApplications,
    triggerCount: hermitContext?.triggerCount,
    optionalSelfExhaust: hermitContext?.optionalSelfExhaust,
  }
  const effects = dieRelicEffectsForParty(source.presentationSourceId, source.effects, state.players.length)
  for (const effect of effects) {
    applyEffect(state, player, effect, source.scope, source.supportScope, context, source.name)
    if (!allowCombatOver && combatIsOver(state)) {
      presentTurnEffects()
      return true
    }
  }
  resolvePendingSlimeCommands(state, player, context)
  if (source.powerUid) {
    const held = player.powers.find((power) => power.uid === source.powerUid)
    if (held?.defId === 'slime_boss_prepare_crush') {
      player.powers = player.powers.filter((power) => power.uid !== held.uid)
      player.discard = [...player.discard, held]
      state.log = [...state.log, `${player.name} discards Prepare Crush`]
    }
  }
  const privateDiscard = state.startTurnProgress?.discard
  if (privateDiscard) {
    privateDiscard.pendingTriggers = pendingTriggers
    presentTurnEffects()
    return !context.invalidShivTarget && !context.invalidEvokeTarget && !context.invalidScryChoice &&
      !context.invalidHermitChoice && !context.invalidSlimeChoice
  }
  const forced = state.startTurnProgress?.forcedCard
  if (forced && pendingTriggers.length > 0) {
    forced.pendingTriggers = [...(forced.pendingTriggers ?? []), ...pendingTriggers]
  } else {
    releasePendingTriggers(state, context)
  }
  const resolved = !context.invalidShivTarget && !context.invalidEvokeTarget && !context.invalidScryChoice &&
    !context.invalidHermitChoice && !context.invalidSlimeChoice
  if (resolved) presentTurnEffects()
  return resolved
}

export function resolveQueuedTriggerSource(
  state: CombatState,
  player: Player,
  source: TriggerSource,
  enemyUid?: string,
  enemyRow?: number,
  targetPlayerId?: string,
  hermitContext?: Pick<PlayContext, 'loadUids' | 'chamberUids' | 'hermitEnemyUids' | 'slimeUids' | 'slimeEnemyUids' |
    'triggerCount' | 'optionalSelfExhaust'>,
): boolean {
  if (source.trigger.kind === 'onDraw') {
    return resolveTriggerSource(state, player, source, { enemyUid, enemyRow, targetPlayerId, hermitContext })
  }
  if (triggerDepth >= MAX_TRIGGER_DEPTH) return false
  triggerDepth++
  try {
    return resolveTriggerSource(state, player, source, { enemyUid, enemyRow, targetPlayerId, hermitContext })
  } finally {
    triggerDepth--
  }
}

export function flushPendingTriggers(state: CombatState): void {
  state.pendingTriggers ??= []
  if ((state.pendingDieRelicChoices?.length ?? 0) > 0) return
  while (state.pendingTriggers.length > 0 && !combatIsOver(state)) {
    const pending = state.pendingTriggers[0]!
    const player = findPlayer(state, pending.playerId)
    const source = player && triggerSourceById(player, pending.sourceId)
    // A dead owner's OWN trigger must not be silently discarded here: unlike
    // `!player`/`!source` (nothing left to resolve), the owner dying under
    // Last Stand does not make the trigger's effect moot, and a needs-choice
    // trigger has to fall through to the `return` below so its owner can
    // still resolve it via `resolvePendingTrigger`, exactly as intended.
    if (!player || !source) {
      state.pendingTriggers.shift()
      continue
    }
    if (triggerNeedsRowChoice(state, player, source) ||
      triggerNeedsEnemyChoice(state, player, source, pending.enemyUid) ||
      triggerNeedsPlayerChoice(state, source) || triggerNeedsHermitChoice(state, player, source) ||
      triggerSlimeChoice(state, player, source) ||
      pendingTriggerSlimeEnemyChoiceCount(state, pending.id, []) > 0) return
    state.pendingTriggers.shift()
    resolveQueuedTriggerSource(
      state,
      player,
      source,
      pending.enemyUid ?? (source.scope === 'enemy' ? livingEnemies(state)[0]?.uid : undefined),
      source.scope === 'row' ? combatRows(state)[0] : undefined,
      undefined,
      pending.count === undefined ? undefined : { triggerCount: pending.count },
    )
  }
}

function fireTriggersInner(
  state: CombatState,
  event: TriggerEvent,
  only?: Player,
  excludeUid?: string,
): void {
  const allowCombatOver = event.kind === 'endOfCombat'
  for (const player of state.players) {
    if (!allowCombatOver && combatIsOver(state)) return
    if (player.dead) continue
    if (only && player.id !== only.id) continue

    for (const source of triggerSources(player, event, excludeUid)) {
      if (!allowCombatOver && ((state.pendingTriggers?.length ?? 0) > 0 ||
        triggerNeedsRowChoice(state, player, source) ||
        triggerNeedsEnemyChoice(state, player, source, event.enemyUid) ||
        triggerNeedsPlayerChoice(state, source) || triggerNeedsHermitChoice(state, player, source) ||
        triggerSlimeChoice(state, player, source))) {
        state.pendingTriggers ??= []
        state.nextTriggerId ??= 0
        state.pendingTriggers.push({
          id: state.nextTriggerId++, playerId: player.id, sourceId: source.id,
          enemyUid: event.enemyUid,
          ...(event.count === undefined ? {} : { count: event.count }),
        })
        continue
      }
      resolveTriggerSource(state, player, source, {
        allowCombatOver,
        enemyUid: event.enemyUid,
        enemyRow: source.scope === 'row' ? combatRows(state)[0] : undefined,
        hermitContext: event.count === undefined ? undefined : { triggerCount: event.count },
      })
      if (!allowCombatOver && combatIsOver(state)) return
    }
  }
}

/** Decides whether the combat has ended, and returns the state either way. */
export function settle(state: CombatState): CombatState {
  sweepMetamorphoses(state, exhaustCards)
  grantSlayerKillRewards(state)
  resolveDeadOwnerSlayerChoices(state)
  // Slayer Pack: a card-given choice owed by a dead (Last Stand) or departed player lapses.
  // A Start of Turn it paused must also resume, which `lapseStrandedPlayerChoices` does instead.
  if (state.phase !== 'start') lapseDeadOwnerPlayerChoices(state)
  if (lastStandActive(state) && state.players.every((player) => player.dead)) {
    clearTerminalChoices(state)
    state.phase = 'lost'
    return state
  }
  // Outside The Last Stand, victory is tested first. `combatIsOver` normally
  // stops each phase at the moment either ending happens, so this ordering is
  // only a backstop for a state assembled by hand.
  if (state.enemies.every((enemy) => enemy.dead) && state.pendingSummons.length === 0) {
    clearTerminalChoices(state)
    state.phase = 'won'
    fireTriggers(state, { kind: 'endOfCombat' })
    return state
  }
  // p.13: ONE death, not a wipe. The optional Last Stand rule on p.23 is the
  // only exception, and applies only to a Boss fight.
  if (!lastStandActive(state) && state.players.some((player) => player.dead)) {
    clearTerminalChoices(state)
    state.phase = 'lost'
    return state
  }
  if (state.pendingCardPlayWindows?.length) {
    settleCardPlayWindows(state, discardByCardEffect)
    // Discovery's closing discard can set off a reaction that ends the fight.
    if (combatIsOver(state)) return settle(state)
  }
  return state
}
