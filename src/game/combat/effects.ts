// The resolver. `applyEffect` turns one printed clause into changes on the
// board, and the trigger loop turns those changes back into more printed
// clauses — a Relic that answers a Block gain, a Power that answers a death.
//
// Those two directions call each other, which is why they are one module: an
// effect fires triggers, and a trigger applies effects. Splitting them would
// buy two files and an import cycle. What can stand below the recursion does:
// reading the board, moving components, and answering rules questions all live
// in their own modules and are only ever called downwards from here.
//
// What is in here: HP loss and death, the clause resolver, the card movements
// whose reactions have to run inside it, Orbs, and the trigger loop that closes
// the circle.
import {
  clone,
  combatIsOver,
  combatRows,
  enemyLabel,
  findPlayer,
  lastStandActive,
  lightningDamageTargets,
  lightningRowTarget,
  lightningTargetOptions,
  lightningTargetsRows,
  livingEnemies,
  loopOrbTargets,
  playersInRowOf,
  powerAbilityKey,
  remainingRoundHpLoss,
  resolveEnemyTargets,
  supportTargets,
} from './board.ts'
import {
  addDaze,
  damageEnemy,
  enemyHasDeathReaction,
  forgetRetain,
  grantShiftBlock,
  loseEnemyHp,
  putPoison,
  triggerAngry,
} from './pieces.ts'
import { addPresentationEvent } from './presentation.ts'
import {
  amountOf,
  cardIsPlayable,
  conditionIsActive,
  copySourcesFor,
  effectIsActive,
  evokePlan,
  latestPlayableAllyAttack,
  omniscienceEligibleCards,
  reachesEnemy,
  resolutionContext,
} from './queries.ts'
import type { CombatState, DeferredHavoc, PendingTrigger, PlayContext, TriggerSource } from './types.ts'
import { cardCost, cardDef, faceOf } from '../cards.ts'
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
} from '../damage.ts'
import { actionsForEnemy, enemyAbilities, enemyDef } from '../enemies.ts'
import { addToDrawTop, drawCards, scry } from '../piles.ts'
import { relicAbilities, relicDef } from '../relics.ts'
import { shuffle } from '../rng.ts'
import { triggerMatches } from '../triggers.ts'
import type { TriggerEvent } from '../triggers.ts'
import { CAPS } from '../types.ts'
import type { CardInstance, Enemy, OrbType, Player } from '../types.ts'

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

export function triggerEnemyDeath(state: CombatState, enemy: Enemy): void {
  const abilities = enemyAbilities(enemyDef(enemy.defId, enemy.ascension))
  const name = enemyLabel(state.enemies, enemy)
  const split = abilities.find((ability) => ability.kind === 'splitOnDeath')
  if (split?.kind === 'splitOnDeath' && !enemy.abilityUsed) {
    enemy.abilityUsed = true
    for (const player of state.players.filter((candidate) => !candidate.dead)) {
      state.pendingSummons.push({
        sourceUid: enemy.uid, row: player.row, defIds: split.defIds, turn: state.turn + 1,
        strength: split.largeSlimeStrength, strengthDefId: 'large_slime',
      })
    }
    state.log = [...state.log, `${name} will Split next turn`]
  }
  const rebirth = abilities.find((ability) => ability.kind === 'rebirth')
  if (rebirth?.kind === 'rebirth' && !enemy.abilityUsed) {
    enemy.abilityUsed = true
    if (rebirth.timing) {
      state.pendingSummons.push({
        sourceUid: enemy.uid, row: enemy.row, defIds: [rebirth.defId ?? enemy.defId],
        turn: state.turn + Number(rebirth.timing === 'startOfTurn'), timing: rebirth.timing,
        direct: true, isBoss: enemy.isBoss,
        strength: rebirth.strength, strengthPerPower: rebirth.strengthPerPower && (enemy.ascension ?? 0) >= 10,
      })
      state.log = [...state.log, `${name} will return ${rebirth.timing === 'startOfTurn' ? 'next round' : 'at the end of the turn'}`]
    } else {
      const nextDefId = rebirth.defId ?? enemy.defId
      if (nextDefId !== enemy.defId) enemy.actionIndex = 0
      enemy.defId = nextDefId
      enemy.dead = false
      enemy.hp = rebirth.hpPerPlayer * state.players.length
      enemy.maxHp = Math.max(enemy.maxHp, enemy.hp)
      enemy.block = 0
      if (rebirth.clearWeakVulnerable) enemy.weak = enemy.vulnerable = 0
      enemy.strength = gainStrength(enemy.strength, rebirth.strength ?? 0)
      state.log = [...state.log, `${enemyLabel(state.enemies, enemy)} returns with ${enemy.hp} HP`]
    }
  }
  const spore = abilities.find((ability) => ability.kind === 'sporeCloud')
  if (spore?.kind === 'sporeCloud') {
    for (const target of playersInRowOf(state, enemy)) {
      const before = target.vulnerable
      target.vulnerable = gainVulnerable(target.vulnerable, spore.vulnerable)
      if (target.vulnerable > before) {
        state.log = [...state.log, `${name}'s Spore Cloud left ${target.name} vulnerable`]
      }
    }
  }
  for (const ally of state.enemies) {
    if (ally.dead || ally.row !== enemy.row) continue
    const fury = enemyAbilities(enemyDef(ally.defId, ally.ascension)).find((ability) =>
      ability.kind === 'furyOnAllyDeath' &&
      (ability.allyDefId === enemy.defId || enemy.defId.startsWith(`${ability.allyDefId}_`)))
    if (fury?.kind !== 'furyOnAllyDeath' || ally.abilityUsed) continue
    ally.abilityUsed = true
    ally.strength = gainStrength(ally.strength, fury.strength)
    state.log = [...state.log, `${enemyLabel(state.enemies, ally)} enters Fury`]
  }
  const attachment = enemy.corpseExplosion
  enemy.corpseExplosion = undefined
  if (attachment) {
    const owner = findPlayer(state, attachment.playerId)
    state.log = [...state.log, `Corpse Explosion detonates for ${attachment.damage} in ${name}'s row`]
    for (const target of state.enemies.filter((candidate) =>
      !candidate.dead && (enemy.isBoss || candidate.row === enemy.row || candidate.isBoss))) {
      if (target.dead) continue
      damageEnemyLogged(state, target, attachment.damage, 'Corpse Explosion')
    }
    if (owner) discardByCardEffect(state, owner, [attachment.card])
  }
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
): void {
  const wasAlive = !enemy.dead
  const hpBefore = enemy.hp
  const result = damageEnemy(state, enemy, damage)
  const name = enemyLabel(state.enemies, enemy)
  if (source) {
    const lost = hpBefore - enemy.hp
    const blocked = result.blocked
    state.log = [
      ...state.log,
      lost > 0
        // "damages", never "hit": a hit is specifically what Strength, Weak
        // and Vulnerable modify, and every caller here — the plain `damage`
        // effect and the orbs — is none of those. The `hit` case builds its
        // own line because it aggregates a multi-hit into one.
        ? `${source} damages ${name} for ${lost}${blocked > 0 ? ` (${blocked} blocked)` : ''}`
        : blocked > 0
          ? `${name} blocked ${source} completely (${blocked} spent)`
          : `${source} did no damage to ${name}`,
    ]
  }
  if (wasAlive && enemy.dead) {
    state.log = [...state.log, `${name} is dead`]
    triggerEnemyDeath(state, enemy)
  } else if (result.curled) {
    state.log = [...state.log, `${name}'s Curl Up gained Block`]
  }
  if (result.hpLost > 0 && !combatIsOver(state) &&
    enemyAbilities(enemyDef(enemy.defId, enemy.ascension)).some((ability) => ability.kind === 'shift')) {
    grantShiftBlock(state, enemy, result.hpLost)
  }
}

function preventPlayerHpLoss(state: CombatState, player: Player, amount: number): boolean {
  if (amount <= 0) return false
  const held = player.powers.find((power) =>
    faceOf(cardDef(power.defId), power.upgraded).effects.some((effect) => effect.kind === 'preventHpLoss'))
  if (!held) return false
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

export function losePlayerHp(state: CombatState, player: Player, amount: number): number {
  const remaining = remainingRoundHpLoss(player)
  const limited = remaining === undefined
    ? amount
    : Math.min(amount, remaining)
  const losable = Math.min(player.hp, Math.max(0, limited))
  if (preventPlayerHpLoss(state, player, losable)) return 0
  const outcome = applyHpLoss(player.hp, losable)
  if (outcome.hpLost > 0) {
    player.lostHpThisCombat = true
    player.hpLostThisRound = (player.hpLostThisRound ?? 0) + outcome.hpLost
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
  player.block = outcome.block
  return { fullyBlocked: outcome.fullyBlocked, hpLost: losePlayerHp(state, player, outcome.hpLost) }
}

export function releasePendingTriggers(state: CombatState, context: PlayContext): void {
  if (context.pendingTriggers?.length) {
    state.pendingTriggers = [...(state.pendingTriggers ?? []), ...context.pendingTriggers]
  }
  flushPendingTriggers(state)
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
  const mods = attackerModsOfPlayer(actor)
  /** Who the log should credit: the ongoing effect if there is one, else the player. */
  const who = source ?? actor.name
  /**
   * Reports a change to the party's own state.
   *
   * The enemies' equivalents were all logged and the players' were not, which
   * made the log read as a record of what was done TO you rather than of the
   * round. A Power or relic names itself, so a recurring effect can be told
   * apart from a card that was just played.
   */
  const note = (text: string) => {
    state.log = [...state.log, source ? `${source}: ${text}` : text]
  }
  const noteAt = (at: number, text: string) => {
    const line = source ? `${source}: ${text}` : text
    state.log = [...state.log.slice(0, at), line, ...state.log.slice(at)]
  }

  // A whole clause that the board can switch off, as the Weak on Go for the
  // Eyes is. Checked before the target scope is resolved, because a clause that
  // does not happen does not pick a target either.
  //
  // Conditions that read a TARGET are not usable here — there is no one target
  // yet — and the only one of those, `targetPoisoned`, is a damage bonus that
  // belongs inside an `Amount`. `verify-architecture.mjs` holds that line.
  if (!effectIsActive(effect, state, actor, context)) return

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
      for (const target of targets) {
        if (context.sourceCardType === 'attack') context.pendingAttackTargets?.push(target.uid)
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
        const wristBlade = actor.relics.some((relic) => relic.defId === 'wrist_blade') &&
          (source === 'Shiv' || (sourceFace && cardCost(sourceFace, actor.powers, actor.lostHpThisCombat) === 0)) ? 1 : 0
        const each = actor.damageDealtZeroThisTurn ? 0 : amountOf(effect.amount, state, actor, target, context) + wristBlade +
          (context.sourceScryDamageBonus ?? 0) +
          (context.sourceCardId?.startsWith('strike_') ? (actor.starterStrikeDamageBonus ?? 0) : 0)
        let blocked = 0
        let curled = false
        let poisonAppliedTotal = 0
        let poisonEvents = 0
        let damagingHits = 0
        for (let i = 0; i < times; i++) {
          if (target.dead) break
          const abilities = enemyAbilities(enemyDef(target.defId, target.ascension))
          const slow = abilities.find((ability) => ability.kind === 'slow')
          const flying = abilities.find((ability) => ability.kind === 'flying')
          let amount = each + (slow?.kind === 'slow' ? slow.damagePerHit : 0)
          amount = hitDamage(amount, mods, { vulnerable: vulnerableAtStart })
          if (actor.damageDealtZeroThisTurn) amount = 0
          if (flying?.kind === 'flying') amount = Math.min(amount, flying.maxDamagePerHit)
          const result = damageEnemy(state, target, amount, context.sourceCardType !== undefined)
          blocked += result.blocked
          curled = result.curled || curled
          if (result.hpLost > 0) {
            damagingHits++
            context.pendingEnemyDamage?.push({ enemyUid: target.uid, amount: result.hpLost })
          }
          if (!target.dead && actor.hitPoison > 0) {
            const gained = putPoison(state, target, actor.hitPoison)
            poisonAppliedTotal += gained
            if (gained > 0) poisonEvents += 1
          }
        }
        if (!deferVulnerableSpend && vulnerableAtStart > 0) target.vulnerable = vulnerableAtStart - 1
        // One line for the whole attack, not one per swing: a five-hit card
        // would otherwise bury the round in near-identical lines.
        const name = enemyLabel(state.enemies, target)
        const lost = hpBefore - target.hp
        context.lastHitDamage = lost
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
        if (wasAlive && target.dead) {
          state.log = [...state.log, `${name} is dead`]
          if (context.sourceCardType !== undefined && enemyHasDeathReaction(state, target)) {
            context.pendingEnemyDeathUids?.push(target.uid)
          }
          else triggerEnemyDeath(state, target)
        } else if (curled) {
          state.log = [...state.log, `${name}'s Curl Up gained Block`]
        }
        if (context.sourceCardType === undefined) triggerAngry(state, target, damagingHits)
        if (combatIsOver(state)) break
      }
      // The attacker's own Weak is spent by attacking, exactly as an enemy's is
      // (p.24). One token per attack, however many targets or hits it had.
      if (!deferWeakSpend && targets.length > 0 && actor.weak > 0) {
        actor.weak -= 1
        // Logged because it is usually the reason the attack underperformed.
        note(`${actor.name} spends a Weak`)
      }
      return
    }
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
      if (weakAtStart > 0 && actor.weak === weakAtStart && (context.enemyUids?.length ?? 0) > 0) {
        actor.weak -= 1
        note(`${actor.name} spends a Weak`)
      }
      return
    }
    case 'damage': {
      // Not a hit: blockable, but unmodified by Strength/Weak/Vulnerable.
      for (const target of resolveEnemyTargets(state, scope, context.enemyUid, context.enemyRow)) {
        damageEnemyLogged(state, target, actor.damageDealtZeroThisTurn ? 0 : amountOf(effect.amount, state, actor, target, context), who)
        if (combatIsOver(state)) return
      }
      return
    }
    case 'damagePerAttackIntent': {
      for (const target of state.enemies) {
        if (target.dead) continue
        const icons = actionsForEnemy(target, state.die).reduce((total, action) => {
          if (action.kind === 'attack') {
            return total + (action.aoe || target.isBoss || target.row === actor.row ? action.times ?? 1 : 0)
          }
          if (action.kind === 'attackSequence') {
            return total + action.hits.filter((hit) => hit.aoe || target.isBoss || target.row === actor.row).length
          }
          return total
        }, 0)
        if (icons > 0) damageEnemyLogged(state, target, actor.damageDealtZeroThisTurn ? 0 : effect.amount * icons, who)
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
    case 'block': {
      // Deflect and Steam Barrier both read the CASTER's board, not the ally
      // they may be handing the Block to, so this is worked out once.
      const printedCard = context.sourceCardType === 'attack' || context.sourceCardType === 'skill'
      const base = amountOf(effect.amount, state, actor, undefined, context)
      const bonusIcon = typeof effect.amount !== 'number'
        && effect.amount.bonus
        && conditionIsActive(effect.amount.bonus.when, state, actor, context)
      const icons = 1 + Number(Boolean(bonusIcon))
      const amount = base + (printedCard ? icons * actor.cardBlockBonus : 0) +
        (context.sourceCardId?.startsWith('defend_') ? (actor.starterDefendBlockBonus ?? 0) : 0)
      for (const target of supportTargets(state, effect, supportScope, context, actor)) {
        const before = target.block
        grantBlock(state, target, amount, context.sourceCardId ? context.pendingTriggers : undefined)
        if (target.block > before) note(`${target.name} gains ${target.block - before} Block`)
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
    case 'applyVulnerable': {
      for (const target of resolveEnemyTargets(state, scope, context.enemyUid, context.enemyRow)) {
        const invincible = enemyAbilities(enemyDef(target.defId, target.ascension))
          .some((ability) => ability.kind === 'invincible') && !target.abilityUsed
        if (invincible) continue
        const before = target.vulnerable
        target.vulnerable = gainVulnerable(target.vulnerable, effect.amount)
        // Only when the token actually went on: at the cap nothing happened,
        // and saying otherwise tells the player a card did something it did not.
        if (target.vulnerable > before) note(`${enemyLabel(state.enemies, target)} is vulnerable`)
        enemyTokensApplied(state, actor, target, target.vulnerable - before, context)
      }
      return
    }
    case 'applyWeak': {
      for (const target of resolveEnemyTargets(state, scope, context.enemyUid, context.enemyRow)) {
        const invincible = enemyAbilities(enemyDef(target.defId, target.ascension))
          .some((ability) => ability.kind === 'invincible') && !target.abilityUsed
        if (invincible) continue
        const before = target.weak
        target.weak = gainWeak(target.weak, amountOf(effect.amount, state, actor, target, context))
        if (target.weak > before) note(`${enemyLabel(state.enemies, target)} is weakened`)
        enemyTokensApplied(state, actor, target, target.weak - before, context)
      }
      return
    }
    case 'gainStrength': {
      for (const target of supportTargets(state, effect, supportScope, context, actor)) {
        const before = target.strength
        target.strength = gainStrength(target.strength, effect.amount)
        if (target.strength > before) {
          note(`${target.name} gains ${target.strength - before} Strength`)
        }
      }
      return
    }
    case 'doubleStrength': {
      const before = actor.strength
      actor.strength = gainStrength(actor.strength, actor.strength)
      if (actor.strength > before) note(`${actor.name} gains ${actor.strength - before} Strength`)
      return
    }
    case 'gainTemporaryStrength': {
      const amount = amountOf(effect.amount, state, actor, undefined, context)
      const before = actor.strength
      actor.strength = gainStrength(actor.strength, amount)
      const gained = actor.strength - before
      actor.strengthLossAtEndOfTurn = (actor.strengthLossAtEndOfTurn ?? 0) +
        (effect.loseGainedOnly ? gained : amount)
      if (gained > 0) note(`${actor.name} gains ${gained} Strength`)
      return
    }
    case 'poison': {
      for (const target of resolveEnemyTargets(state, scope, context.enemyUid, context.enemyRow)) {
        const gained = putPoison(state, target, amountOf(effect.amount, state, actor, target, context))
        if (gained > 0) {
          note(`${enemyLabel(state.enemies, target)} takes ${gained} Poison`)
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
        const gained = putPoison(state, target, added)
        if (gained > 0) {
          note(`${enemyLabel(state.enemies, target)} takes ${gained} Poison`)
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
    case 'copyLastPlayed': {
      if (context.sourceIsCopy) return
      const plays = state.playedCardsThisTurn ?? []
      const latest = [...plays].reverse().find((played, reverseIndex) => {
        if (played.copied || (reverseIndex === 0 && played.card.uid === context.sourceCardUid)) return false
        const def = faceOf(cardDef(played.card.defId), played.card.upgraded)
        return cardCost(def, actor.powers, actor.lostHpThisCombat) === context.energySpent &&
          (def.type === 'attack' || def.type === 'skill')
      })
      if (!latest || !context.sourceCardUid) return
      const copiedDef = faceOf(cardDef(latest.card.defId), latest.card.upgraded)
      if (copiedDef.id === 'burst') {
        note(`${actor.name}'s Doppelganger cannot copy Burst`)
        return
      }
      if (!cardIsPlayable(copiedDef, state, actor, actor.draw.length, false) ||
        context.energySpent! < (copiedDef.minimumX ?? 0)) {
        note(`${actor.name}'s Doppelganger cannot play ${copiedDef.name}`)
        return
      }
      context.doppelgangerCopy = { ...latest.card, uid: `${context.sourceCardUid}:copy` }
      context.queuedCopySource = 'Doppelganger'
      note(`${actor.name}'s Doppelganger copies ${copiedDef.name}`)
      return
    }
    case 'copyLastAllyAttack': {
      if (context.sourceIsCopy) return
      const latest = latestPlayableAllyAttack(state, actor)
      if (!latest || !context.sourceCardUid) return
      const copiedDef = faceOf(cardDef(latest.card.defId), latest.card.upgraded)
      context.doppelgangerCopy = { ...latest.card, uid: `${context.sourceCardUid}:copy` }
      context.queuedCopySource = 'Foreign Influence'
      note(`${actor.name}'s Foreign Influence copies ${copiedDef.name}`)
      return
    }
    case 'draw': {
      for (const target of supportTargets(state, effect, supportScope, context, actor)) {
        // Reserve the line before drawing: a draw can reshuffle and fire
        // triggers that log, and those belong under this line, not above it.
        const at = state.log.length
        const drawnCards = drawInto(
          state,
          target,
          amountOf(effect.amount, state, actor, undefined, context),
          context.pendingTriggers,
        )
        if (target.id === actor.id) {
          context.drewSkill = drawnCards.some((card) => faceOf(cardDef(card.defId), card.upgraded).type === 'skill')
        }
        const drawn = drawnCards.length
        if (drawn > 0) {
          const line = source ? `${source}: ${target.name} draws ${drawn}` : `${target.name} draws ${drawn}`
          state.log = [...state.log.slice(0, at), line, ...state.log.slice(at)]
        }
      }
      return
    }
    case 'drawThenDiscard': {
      applyEffect(state, actor, { kind: 'draw', amount: effect.amount }, scope, supportScope, context, source)
      if (actor.hand.length > 0) {
        state.startTurnProgress = {
          choices: [],
          discard: {
            playerId: actor.id,
            sourceId: context.sourcePowerUid ? `power:${context.sourcePowerUid}` : '',
            pendingTriggers: [],
          },
        }
      }
      return
    }
    case 'drawToHandSize':
      return applyEffect(state, actor, {
        kind: 'draw', amount: Math.max(0, effect.size - actor.hand.length),
      }, scope, supportScope, context, source)
    case 'cycleHand': {
      const moved = [...actor.hand]
      discardByCardEffect(state, actor, moved, context)
      return applyEffect(state, actor, { kind: 'draw', amount: moved.length },
        scope, supportScope, context, source)
    }
    case 'discardNonRetain': {
      const moved = actor.hand.filter((card) =>
        !card.retainThisTurn && !faceOf(cardDef(card.defId), card.upgraded).retain)
      discardByCardEffect(state, actor, moved, context)
      return
    }
    case 'preventDraw': {
      actor.drawLocked = true
      note(`${actor.name} cannot draw more cards this turn`)
      return
    }
    case 'preventCardPlay': {
      actor.cardPlayLocked = true
      note(`${actor.name} cannot play additional cards this turn`)
      return
    }
    case 'discountNextCard': {
      actor.freeCardsThisTurn = (actor.freeCardsThisTurn ?? 0) + 1
      note(`${actor.name}'s next card costs 0 this turn`)
      return
    }
    case 'discountNextAttack': {
      actor.freeAttacksThisTurn = (actor.freeAttacksThisTurn ?? 0) + 1
      note(`${actor.name}'s next Attack costs 0 this turn`)
      return
    }
    case 'discountHand': {
      actor.hand = actor.hand.map((card) => ({ ...card, freeThisTurn: true }))
      note(`${actor.name}'s cards in hand cost 0 this turn`)
      return
    }
    case 'discountRetainedCards': {
      actor.hand = actor.hand.map((card) => card.retainedLastTurn
        ? { ...card, costReductionThisTurn: (card.costReductionThisTurn ?? 0) + effect.amount }
        : card)
      note(`${actor.name}'s Retained cards cost ${effect.amount} less this turn`)
      return
    }
    case 'doubleNextAttack': {
      actor.doubledAttacksThisTurn = (actor.doubledAttacksThisTurn ?? 0) + 1
      note(`${actor.name}'s next Attack will be played twice`)
      return
    }
    case 'tripleNextAttack': {
      actor.tripledAttacksThisTurn = (actor.tripledAttacksThisTurn ?? 0) + 1
      note(`${actor.name}'s next Attack will be played three times`)
      return
    }
    case 'doubleNextAttackOrSkill': {
      actor.doubledCardsThisTurn = (actor.doubledCardsThisTurn ?? 0) + 1
      note(`${actor.name}'s next Attack or Skill will be played twice`)
      return
    }
    case 'doubleNextSkill': {
      actor.doubledSkillsThisTurn = (actor.doubledSkillsThisTurn ?? 0) + 1
      note(`${actor.name}'s next Skill will be played twice`)
      return
    }
    case 'retainAtEndOfTurn': {
      actor.retainCardsThisTurn = (actor.retainCardsThisTurn ?? 0) + effect.amount
      note(`${actor.name} may Retain ${effect.amount} card${effect.amount === 1 ? '' : 's'} this turn`)
      return
    }
    case 'limitRoundHpLoss': {
      actor.hpLossLimitThisRound = Math.min(actor.hpLossLimitThisRound ?? effect.amount, effect.amount)
      note(`${actor.name} cannot lose more than ${effect.amount} HP this round`)
      return
    }
    case 'preventHpLoss':
      // Buffer reacts in the shared HP-loss boundary, not when the Power is played.
      return
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
    case 'countdownDamage': {
      const held = actor.powers.find((card) => card.uid === context.sourcePowerUid)
      if (!held) return
      held.counter = (held.counter ?? 0) + 1
      note(`${actor.name} places cube ${held.counter} of ${effect.cubes}`)
      if (held.counter < effect.cubes) return
      applyEffect(state, actor, { kind: 'damage', amount: effect.damage }, 'allEnemies', 'self', context, source)
      actor.powers = actor.powers.filter((card) => card.uid !== held.uid)
      held.counter = undefined
      exhaustCards(state, actor, [held])
      note(`${actor.name} exhausts The Bomb`)
      return
    }
    case 'countdownExhaust': {
      const held = actor.powers.find((card) => card.uid === context.sourcePowerUid)
      if (!held) return
      held.counter = (held.counter ?? 0) + 1
      note(`${actor.name} places cube ${held.counter} of ${effect.cubes}`)
      if (held.counter < effect.cubes) return
      actor.powers = actor.powers.filter((card) => card.uid !== held.uid)
      held.counter = undefined
      exhaustCards(state, actor, [held])
      note(`${actor.name} exhausts ${cardDef(held.defId).name}`)
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
    case 'gainEnergy': {
      for (const target of supportTargets(state, effect, supportScope, context, actor)) {
        const before = target.energy
        target.energy = Math.min(CAPS.energy, target.energy + effect.amount)
        if (target.energy > before) note(`${target.name} gains ${target.energy - before} Energy`)
      }
      return
    }
    case 'gainEnergyPerDiscard': {
      const amount = (context.discardedByCard ?? 0) + effect.bonus
      const before = actor.energy
      actor.energy = Math.min(CAPS.energy, actor.energy + amount)
      if (actor.energy > before) note(`${actor.name} gains ${actor.energy - before} Energy`)
      return
    }
    case 'gainShiv': {
      for (const target of supportTargets(state, effect, supportScope, context, actor)) {
        const available = Math.max(0, CAPS.shivs - state.players.reduce((sum, player) => sum + player.shivs, 0))
        const gained = Math.min(available, effect.amount)
        target.shivs += gained
        if (gained > 0) note(`${target.name} gains ${gained} Shiv`)
        // The five cubes are a shared supply. A Shiv that cannot be taken may
        // be thrown immediately instead, using the card's chosen enemy (p.17).
        for (let i = gained; i < effect.amount; i++) {
          const at = context.shivTargetIndex ?? 0
          const enemyUid = context.shivEnemyUids?.[at]
          context.shivTargetIndex = at + 1
          if (!enemyUid) continue
          if (resolveEnemyTargets(state, 'enemy', enemyUid).length === 0) {
            context.invalidShivTarget = true
            continue
          }
          applyEffect(
            state,
            target,
            { kind: 'hit', amount: 1 + target.shivDamageBonus },
            'enemy',
            'self',
            { ...context, enemyUid },
            'Shiv',
          )
          target.attacksPlayedThisTurn = (target.attacksPlayedThisTurn ?? 0) + 1
          if (combatIsOver(state)) return
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
        actor.attacksPlayedThisTurn = (actor.attacksPlayedThisTurn ?? 0) + 1
        context.sourceAttackCounted = true
      }
      if (count > 0) note(`${actor.name} uses ${count} Shiv${count === 1 ? '' : 's'}`)
      for (let i = 0; i < count; i++) {
        const at = context.shivTargetIndex ?? 0
        const enemyUid = context.shivEnemyUids?.[at]
        context.shivTargetIndex = at + 1
        if (!enemyUid || resolveEnemyTargets(state, 'enemy', enemyUid).length === 0) {
          context.invalidShivTarget = true
          continue
        }
        applyEffect(
          state,
          actor,
          { kind: 'hit', amount: 1 + actor.shivDamageBonus + effect.bonus },
          'enemy',
          'self',
          { ...context, enemyUid },
          'Shiv',
        )
        actor.attacksPlayedThisTurn = (actor.attacksPlayedThisTurn ?? 0) + 1
        if (combatIsOver(state)) break
      }
      return
    }
    case 'gainMiracle': {
      for (const target of supportTargets(state, effect, supportScope, context, actor)) {
        const available = Math.max(0, CAPS.miracles - state.players.reduce((sum, player) => sum + player.miracles, 0))
        const amount = amountOf(effect.amount, state, actor, undefined, context)
        const before = target.miracles
        target.miracles += Math.min(available, amount)
        if (target.miracles > before) note(`${target.name} gains ${target.miracles - before} Miracle`)
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
    case 'heal': {
      for (const target of supportTargets(state, effect, supportScope, context, actor)) {
        const before = target.hp
        const cap = target.relics.some((relic) => relic.defId === 'mark_of_pain') ? 6 : target.maxHp
        target.hp = Math.min(cap, target.maxHp, target.hp + effect.amount)
        if (target.hp > before) note(`${target.name} heals ${target.hp - before}`)
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
    case 'discard': {
      const chosen = allocate(actor, context.discardUids, effect.amount, context)
      const moved = chosen.map((uid) => actor.hand.find((card) => card.uid === uid)!)
      discardByCardEffect(state, actor, moved, context)
      return
    }
    case 'discardAny': {
      const chosen = context.discardUids ?? []
      if (new Set(chosen).size !== chosen.length ||
        chosen.some((uid) => !actor.hand.some((card) => card.uid === uid))) {
        context.invalidDiscardChoice = true
        return
      }
      const picked = new Set(chosen)
      const moved = actor.hand.filter((card) => picked.has(card.uid))
      context.discardedByCard = moved.length
      discardByCardEffect(state, actor, moved, context)
      return
    }
    case 'exhaustFromHand': {
      const chosen = allocate(actor, context.exhaustUids, effect.amount, context)
      const moved = actor.hand.filter((card) => chosen.includes(card.uid))
      context.exhaustedCardCost = moved.length === 1
        ? cardCost(faceOf(cardDef(moved[0]!.defId), moved[0]!.upgraded), actor.powers, actor.lostHpThisCombat)
        : undefined
      actor.hand = actor.hand.filter((card) => !chosen.includes(card.uid))
      exhaustCards(state, actor, moved, context)
      if (moved.length > 0) note(`${actor.name} exhausts ${moved.length}`)
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
    case 'exhaustAny': {
      const chosen = context.exhaustUids ?? []
      const minimum = Math.min(effect.minimum ?? 0, actor.hand.length)
      if (chosen.length < minimum || chosen.length > effect.amount || new Set(chosen).size !== chosen.length ||
        chosen.some((uid) => !actor.hand.some((card) => card.uid === uid))) {
        context.invalidExhaustChoice = true
        return
      }
      const picked = new Set(chosen)
      const moved = actor.hand.filter((card) => picked.has(card.uid))
      actor.hand = actor.hand.filter((card) => !picked.has(card.uid))
      exhaustCards(state, actor, moved, context)
      if (moved.length > 0) note(`${actor.name} exhausts ${moved.length}`)
      return
    }
    case 'exhaustHand': {
      const moved = actor.hand.filter((card) =>
        !effect.except || faceOf(cardDef(card.defId), card.upgraded).type !== effect.except)
      const picked = new Set(moved.map((card) => card.uid))
      actor.hand = actor.hand.filter((card) => !picked.has(card.uid))
      context.exhaustedByCard = moved.length
      exhaustCards(state, actor, moved, context)
      if (moved.length > 0) note(`${actor.name} exhausts ${moved.length}`)
      return
    }
    case 'exhaustDrawPile': {
      const moved = [...actor.draw]
      actor.draw = []
      exhaustCards(state, actor, moved, context)
      if (moved.length > 0) note(`${actor.name} exhausts their draw pile (${moved.length})`)
      return
    }
    case 'gainBlockPerExhaust':
      return applyEffect(state, actor, {
        kind: 'block', amount: effect.amount * (context.exhaustedByCard ?? 0),
      }, scope, supportScope, context, source)
    case 'hitPerExhaust':
      return applyEffect(state, actor, {
        kind: 'hit', amount: effect.amount, times: context.exhaustedByCard ?? 0,
      }, scope, supportScope, context, source)
    case 'channel': {
      // Reserve the line's position before forced evokes log, but write it only
      // after an Orb was really placed: a lethal forced evoke ends combat first.
      const at = state.log.length
      let channeled = 0
      for (let i = 0; i < amountOf(effect.amount, state, actor, undefined, context); i++) {
        if (channelOrb(state, actor, effect.orb, context)) channeled += 1
        if (combatIsOver(state)) break
      }
      if (channeled > 0) noteAt(at, `${actor.name} channels ${channeled} ${effect.orb}`)
      return
    }
    case 'channelDieOrb': {
      const orb: OrbType = state.die <= 2 ? 'lightning' : state.die <= 4 ? 'frost' : 'dark'
      const at = state.log.length
      if (channelOrb(state, actor, orb, context)) noteAt(at, `${actor.name} channels 1 ${orb}`)
      return
    }
    case 'addDaze': {
      const gained = addDaze(state, actor, effect.amount, effect.pile, actor.id)
      if (gained > 0) note(`${actor.name} gains ${gained} Daze`)
      return
    }
    case 'recoverDiscardTopCosts': {
      const top = actor.discard.at(-1)
      if (!top) return
      const face = faceOf(cardDef(top.defId), top.upgraded)
      if (face.unplayable || cardCost(face, actor.powers, actor.lostHpThisCombat) !== effect.cost) return
      actor.discard = actor.discard.slice(0, -1)
      actor.hand = [...actor.hand, top]
      note(`${actor.name} returns ${face.name} to hand`)
      return
    }
    case 'recoverAllDiscardCosts': {
      const recovered = actor.discard.filter((card) => {
        const face = faceOf(cardDef(card.defId), card.upgraded)
        return !face.unplayable && cardCost(face, actor.powers, actor.lostHpThisCombat) === effect.cost
      })
      if (recovered.length === 0) return
      const uids = new Set(recovered.map((card) => card.uid))
      actor.discard = actor.discard.filter((card) => !uids.has(card.uid))
      actor.hand = [...actor.hand, ...recovered]
      note(`${actor.name} returns ${recovered.length} ${effect.cost}-cost cards to hand`)
      return
    }
    case 'evoke': {
      const times = amountOf(effect.times, state, actor, undefined, context)
      if (times > 0 && actor.orbs.every((orb) => orb == null)) note(`${actor.name} has no orb to evoke`)
      if (times > 0) evokeOrb(state, actor, context, times)
      return
    }
    case 'recurseOrb': {
      const orb = evokeOrb(state, actor, context)
      if (combatIsOver(state)) return
      if (orb) {
        note(`${actor.name} channels 1 ${orb}`)
        channelOrb(state, actor, orb, context)
      }
      return
    }
    case 'fission': {
      const count = actor.orbs.filter((orb) => orb !== null).length
      if (effect.evoke) {
        for (let index = 0; index < count; index++) {
          evokeOrb(state, actor, context)
          if (combatIsOver(state)) return
        }
      } else {
        actor.orbs = actor.orbs.map(() => null)
        if (count > 0) note(`${actor.name} removes ${count} Orbs`)
      }
      applyEffect(state, actor, { kind: 'gainEnergy', amount: count }, scope, supportScope, context, source)
      applyEffect(state, actor, { kind: 'draw', amount: count }, scope, supportScope, context, source)
      return
    }
    case 'removeAllOrbs': {
      const removed = actor.orbs.filter((orb) => orb !== null).length
      actor.orbs = actor.orbs.map(() => null)
      if (removed > 0) note(`${actor.name} removes ${removed} Orbs`)
      return
    }
    case 'gainOrbSlots': {
      actor.orbs = [...actor.orbs, ...Array<null>(effect.amount).fill(null)]
      note(`${actor.name} gains ${effect.amount} Orb slots`)
      return
    }
    case 'gainOrbEvokeBonus': {
      actor.orbEvokeBonus = (actor.orbEvokeBonus ?? 0) + effect.amount
      note(`${actor.name}'s Orb Evoke effects get +${effect.amount}`)
      return
    }
    case 'gainDarkOrbEvokeBonus': {
      actor.darkOrbEvokeBonus = (actor.darkOrbEvokeBonus ?? 0) + effect.amount
      note(`${actor.name}'s Dark Orb Evoke effects get +${effect.amount}`)
      return
    }
    case 'gainOrbEndTurnBonus': {
      actor.orbEndTurnBonus = (actor.orbEndTurnBonus ?? 0) + effect.amount
      note(`${actor.name}'s Orb end-of-turn effects get +${effect.amount}`)
      return
    }
    case 'gainLightningEndTurnBonus': {
      actor.lightningEndTurnBonus = (actor.lightningEndTurnBonus ?? 0) + effect.amount
      note(`${actor.name}'s Lightning Orb end-of-turn effects get +${effect.amount}`)
      return
    }
    case 'lightningTargetsRow':
      // The face-up Power is read by every Lightning resolution boundary.
      return
    case 'triggerOrbEndTurn':
      // Loop resolves here only through its chosen end-turn ability.
      return
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
    case 'doubleEnergy': {
      const before = actor.energy
      actor.energy = Math.min(effect.max, actor.energy * 2)
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
    case 'gainBlockFromLastHit': {
      applyEffect(state, actor, { kind: 'block', amount: context.lastHitDamage ?? 0 },
        scope, supportScope, context, source)
      return
    }
    case 'scry': {
      // Scry shows the top X and lets the player bin any of them; the rest go
      // back on top IN THE SAME ORDER (p.24).
      const revealed = actor.draw.slice(0, Math.max(0, effect.amount))
      const chosen = context.scryDiscardUids ?? []
      if (new Set(chosen).size !== chosen.length ||
        chosen.some((uid) => !revealed.some((card) => card.uid === uid))) {
        context.invalidScryChoice = true
        return
      }
      const looked = revealed.length
      const tossed = revealed.filter((card) => chosen.includes(card.uid))
      const piles = scry({ draw: actor.draw, hand: actor.hand, discard: actor.discard },
        effect.amount, chosen)
      actor.draw = piles.draw
      const wovenCards = tossed.filter((card) => faceOf(cardDef(card.defId), card.upgraded).scryPlayBonus !== undefined)
      const woven = wovenCards[0]
      discardByCardEffect(state, actor, tossed.filter((card) => !wovenCards.some((weave) => weave.uid === card.uid)), context)
      if (woven) {
        const weave = faceOf(cardDef(woven.defId), woven.upgraded)
        const queued = { ...forgetRetain(woven), scryDamageBonus: weave.scryPlayBonus }
        const copySources = copySourcesFor(weave, actor)
        const sourceNames = copySources.length > 0
          ? [...copySources, copySources.at(-1)!]
          : ['Weave' as const]
        if (context.sourceCardUid) {
          context.doppelgangerCopy = queued
          context.queuedCopySource = 'Weave'
          context.queuedCopyVirtualOnly = false
          context.queuedCopySourceNames = sourceNames
          context.queuedWeaves = wovenCards.slice(1).map(forgetRetain)
          context.queuedCopySources = copySources
          context.consumeQueuedFreeCard = (actor.freeCardsThisTurn ?? 0) > 0
          context.consumeQueuedFreeAttack = (actor.freeAttacksThisTurn ?? 0) > 0
        } else {
          state.pendingCardCopy = {
            playerId: actor.id,
            card: queued,
            energySpent: 0,
            resumePhase: state.phase === 'start' ? 'start' : 'player',
            forcedExhaust: false,
            forcedChoices: null,
            deferredHavocs: [],
            sourceNames,
            queuedWeaves: wovenCards.slice(1).map(forgetRetain),
            queuedCopySources: copySources,
            consumeFreeCard: (actor.freeCardsThisTurn ?? 0) > 0,
            consumeFreeAttack: (actor.freeAttacksThisTurn ?? 0) > 0,
          }
          state.phase = 'copy'
        }
        note(`${actor.name} plays ${weave.name} instead of discarding it`)
      }
      // An empty draw pile means no cards were looked at, so nothing scried.
      if (looked > 0) context.pendingTriggers?.push(
        ...queuedTriggers(state, { kind: 'onScry' }, actor),
      )
      return
    }
    case 'topdeck': {
      const requested = context.topdeckUids ?? []
      if (requested.length !== Math.min(effect.amount, actor.hand.length) ||
        new Set(requested).size !== requested.length ||
        requested.some((uid) => !actor.hand.some((card) => card.uid === uid))) {
        context.invalidTopdeckChoice = true
        return
      }
      const chosen = allocate(actor, requested, effect.amount, context)
      const moved = chosen.map((uid) => actor.hand.find((card) => card.uid === uid)!)
      const picked = new Set(chosen)
      actor.hand = actor.hand.filter((card) => !picked.has(card.uid))
      actor.draw = addToDrawTop(actor, moved.map(forgetRetain)).draw
      if (moved.length > 0) note(`${actor.name} puts ${moved.length} card on top of their draw pile`)
      return
    }
    case 'recoverDiscard': {
      const required = Math.min(effect.amount, actor.discard.length)
      const requested = context.recoverDiscardUids ??
        (context.recoverDiscardUid === undefined ? [] : [context.recoverDiscardUid])
      if ((context.recoverDiscardUids !== undefined && context.recoverDiscardUid !== undefined) ||
        requested.length !== required || new Set(requested).size !== requested.length ||
        requested.some((uid) => !actor.discard.some((card) => card.uid === uid))) {
        context.invalidRecoverChoice = true
        return
      }
      if (requested.length === 0) return
      const selected = new Set(requested)
      const moved = requested.map((uid) => actor.discard.find((card) => card.uid === uid)!)
      actor.discard = actor.discard.filter((card) => !selected.has(card.uid))
      const cleaned = moved.map((card) => effect.retain
        ? { ...forgetRetain(card), retainThisTurn: true }
        : forgetRetain(card))
      if (effect.toHand) actor.hand = [...actor.hand, ...cleaned]
      else actor.draw = addToDrawTop(actor, cleaned).draw
      note(`${actor.name} returns ${moved.length} card${moved.length === 1 ? '' : 's'} to their ${effect.toHand ? 'hand' : 'draw pile'}`)
      return
    }
    case 'recoverExhaust': {
      const required = Math.min(effect.amount, actor.exhaust.length)
      const chosen = context.recoverExhaustUid
      if ((required === 1 && (!chosen || !actor.exhaust.some((card) => card.uid === chosen))) ||
        (required === 0 && chosen !== undefined)) {
        context.invalidRecoverChoice = true
        return
      }
      if (!chosen) return
      const moved = actor.exhaust.find((card) => card.uid === chosen)!
      actor.exhaust = actor.exhaust.filter((card) => card.uid !== chosen)
      const recovered = forgetRetain(moved)
      recovered.counter = undefined
      actor.hand = [...actor.hand, recovered]
      note(`${actor.name} returns ${faceOf(cardDef(moved.defId), moved.upgraded).name} to their hand`)
      return
    }
    case 'searchDraw': {
      const requested = context.searchDrawUids ?? []
      const required = Math.min(effect.amount, actor.draw.length)
      if (requested.length !== required || new Set(requested).size !== requested.length ||
        requested.some((uid) => !actor.draw.some((card) => card.uid === uid))) {
        context.invalidSearchChoice = true
        return
      }
      const chosen = requested.map((uid) => actor.draw.find((card) => card.uid === uid)!)
      const picked = new Set(requested)
      actor.draw = shuffle(state.rng, actor.draw.filter((card) => !picked.has(card.uid)))
      actor.hand = [...actor.hand, ...chosen.map(forgetRetain)]
      if (chosen.length > 0) note(`${actor.name} searches ${chosen.length} card${chosen.length === 1 ? '' : 's'} into their hand`)
      context.pendingTriggers?.push(...queuedTriggers(state, { kind: 'onShuffle' }, actor))
      return
    }
    case 'searchDrawAndPlayTwice': {
      const eligible = omniscienceEligibleCards(state, actor)
      const requested = context.searchDrawUids ?? []
      if (requested.length !== Math.min(1, eligible.length) ||
        requested.some((uid) => !eligible.some((card) => card.uid === uid))) {
        context.invalidSearchChoice = true
        return
      }
      const chosen = eligible.find((card) => card.uid === requested[0])
      actor.draw = shuffle(state.rng, actor.draw.filter((card) => card.uid !== chosen?.uid))
      context.pendingTriggers?.push(...queuedTriggers(state, { kind: 'onShuffle' }, actor))
      if (!chosen) return
      const chosenDef = faceOf(cardDef(chosen.defId), chosen.upgraded)
      context.doppelgangerCopy = forgetRetain(chosen)
      context.queuedCopySource = 'Omniscience'
      context.queuedCopyVirtualOnly = false
      context.queuedCopyTwice = true
      context.queuedCopyForcedExhaust = true
      context.queuedCopySources = []
      context.consumeQueuedFreeCard = (actor.freeCardsThisTurn ?? 0) > 0
      context.consumeQueuedFreeAttack = chosenDef.type === 'attack' && (actor.freeAttacksThisTurn ?? 0) > 0
      note(`${actor.name} will play ${chosenDef.name} twice for 0 Energy`)
      return
    }
    case 'drawAndPlayFree': {
      const [drawn] = drawInto(state, actor, 1, context.pendingTriggers)
      if (!drawn) return
      const drawnDef = faceOf(cardDef(drawn.defId), drawn.upgraded)
      if (!cardIsPlayable(drawnDef, state, actor) || (drawnDef.minimumX ?? 0) > 0) {
        if (effect.exhaustNonPower && drawnDef.type !== 'power') {
          actor.hand = actor.hand.filter((card) => card.uid !== drawn.uid)
          exhaustCards(state, actor, [drawn], context)
        } else {
          discardByCardEffect(state, actor, [drawn])
        }
        note(`${actor.name} cannot play ${drawnDef.name} with ${cardDef(context.sourceCardId ?? 'mayhem').name}`)
        return
      }
      state.startTurnProgress = {
        choices: [],
        forcedCard: {
          playerId: actor.id,
          cardUid: drawn.uid,
          sourceCardId: context.sourceCardId ?? 'mayhem',
          exhaustNonPower: effect.exhaustNonPower === true,
        },
      }
      note(`${actor.name} must play ${cardDef(context.sourceCardId ?? 'mayhem').name}'s drawn card for 0 Energy`)
      return
    }
  }
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
function grantBlock(
  state: CombatState,
  target: Player,
  amount: number,
  pendingTriggers?: PendingTrigger[],
): void {
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
    const event = { kind: 'onDraw' as const, cardType: cardDef(drawnCards[i]!.defId).type }
    if (pendingTriggers) pendingTriggers.push(...queuedTriggers(state, event, actor))
    else fireTriggers(state, event, actor)
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
  const lasting = cards.map(forgetRetain)
  actor.exhaust = [...actor.exhaust, ...lasting]
  for (const card of cards) {
    if (context?.pendingExhaustTriggers) {
      context.pendingExhaustTriggers.push({ playerId: actor.id, card: forgetRetain(card) })
    } else {
      resolveExhaustReaction(state, actor, card)
    }
  }
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
  const uids = new Set(cards.map((card) => card.uid))
  const discarded = cards.map(forgetRetain)
  actor.hand = actor.hand.filter((card) => !uids.has(card.uid))
  actor.draw = actor.draw.filter((card) => !uids.has(card.uid))
  actor.discard = [...actor.discard.filter((card) => !uids.has(card.uid)), ...discarded]
  if (!state.discardedThisTurn.includes(actor.id)) state.discardedThisTurn.push(actor.id)
  state.log = [...state.log, `${actor.name} discards ${cards.length}`]

  if (context?.pendingDiscards) {
    context.pendingDiscards.push({ playerId: actor.id, cards: discarded })
    return
  }
  resolveDiscardReactions(state, actor, discarded)
}

export function resolveDiscardReactions(
  state: CombatState,
  actor: Player,
  cards: readonly CardInstance[],
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
  fireTriggers(state, { kind: 'onDiscard' }, actor)
}

/**
 * The uids this effect actually takes, and whether the player paid what they
 * owed.
 *
 * This is the ONLY place a consuming clause is validated, and it runs as the
 * clause resolves, against the hand as it stands right then. An earlier
 * version also pre-checked the whole card up front against the hand the player
 * held BEFORE the card started; that rejected Acrobatics ("Draw 3 cards.
 * Discard 1 card.") whenever the discarded card was one of the three just
 * drawn, which is the ordinary way to play it. Two validators reading two
 * different hands is one validator too many.
 *
 * A card asking for more than the hand can pay is paid in full by what there
 * is, exactly as it would be at the table: discarding your only other card
 * settles a "discard 2".
 */
function allocate(
  actor: Player,
  uids: readonly string[] | undefined,
  amount: number,
  context: PlayContext,
): string[] {
  const spent = (context.spentUids ??= new Set<string>())
  const usable = (uids ?? []).filter(
    (uid, index, all) =>
      all.indexOf(uid) === index &&
      !spent.has(uid) &&
      actor.hand.some((held) => held.uid === uid),
  )
  // The played card has already left hand, so what remains is exactly the pool
  // this clause may take from.
  const required = Math.min(amount, actor.hand.length)
  const taken = usable.slice(0, required)
  if (taken.length < required) context.shortfall = true
  for (const uid of taken) spent.add(uid)
  return taken
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
): { index: number; options: { uid: string; label: string }[]; complete: boolean; endedCombat: boolean } {
  const chosen = evokePlan(def, actor, slots, mode, energySpent).chosen
  const simulation = clone(state)
  const simulationActor = findPlayer(simulation, actor.id)
  if (!simulationActor) return { index: 0, options: [], complete: false, endedCombat: false }
  for (let index = 0; index < chosen.length; index++) {
    if (combatIsOver(simulation)) return { index, options: [], complete: true, endedCombat: true }
    const orb = chosen[index]!
    const target = targets[index]
    if (orb === 'frost') {
      if (target !== null) return { index, options: [], complete: false, endedCombat: false }
      continue
    }
    const options = orb === 'lightning'
      ? lightningTargetOptions(simulation, simulationActor, def.id)
      : livingEnemies(simulation).map((enemy) => ({
        uid: enemy.uid, label: enemyLabel(simulation.enemies, enemy),
      }))
    if (typeof target !== 'string' || !options.some((option) => option.uid === target)) {
      return { index, options, complete: false, endedCombat: false }
    }
    if (!applyOrbEvokeEffect(simulation, simulationActor, orb, target, def.id)) {
      return { index, options, complete: false, endedCombat: false }
    }
  }
  return { index: chosen.length, options: [], complete: true, endedCombat: false }
}

export function resolveEnraged(state: CombatState, actor: Player): void {
  for (const enemy of state.enemies) {
    const ability = enemyDef(enemy.defId, enemy.ascension).ability
    if (enemy.dead || ability?.kind !== 'enraged' || state.turn < ability.fromTurn) continue
    const blockBefore = actor.block
    const outcome = damagePlayer(state, actor, ability.damage)
    const name = enemyLabel(state.enemies, enemy)
    const lost = outcome.hpLost
    const blocked = blockBefore - actor.block
    state.log = [
      ...state.log,
      lost > 0
        ? `${name}'s Enraged hit ${actor.name} for ${lost}${blocked > 0 ? ` (${blocked} blocked)` : ''}`
        : outcome.fullyBlocked
          ? `${actor.name} blocked ${name}'s Enraged (${blocked} spent)`
          : `${name}'s Enraged did no damage to ${actor.name}${blocked > 0 ? ` (${blocked} blocked)` : ''}`,
    ]
    if (actor.dead) {
      state.log = [...state.log, `${actor.name} has fallen`]
      return
    }
  }
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
    const def = faceOf(cardDef(card.defId), card.upgraded)
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
    if (copySourceNames?.length) {
      if (def.type === 'attack') actor.attacksPlayedThisTurn = (actor.attacksPlayedThisTurn ?? 0) + 1
      fireTriggers(state, { kind: 'onPlayCard', cardType: def.type }, actor, card.uid)
      if (combatIsOver(state)) return pendingTriggers
      if (def.type === 'skill') resolveEnraged(state, actor)
      if (combatIsOver(state)) return pendingTriggers
      state.pendingCardCopy = {
        playerId: actor.id,
        card: { ...card },
        energySpent: 0,
        resumePhase: copyResumePhase ?? 'player',
        forcedExhaust: exhaust,
        forcedChoices: null,
        deferredHavocs: remaining,
        sourceNames: copySourceNames,
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
    if (def.type === 'attack') actor.attacksPlayedThisTurn = (actor.attacksPlayedThisTurn ?? 0) + 1
    fireTriggers(state, { kind: 'onPlayCard', cardType: def.type }, actor, card.uid)
    if (combatIsOver(state)) return pendingTriggers
    if (def.type === 'skill') resolveEnraged(state, actor)
  }
  return pendingTriggers
}

/**
 * Channels an orb into any OPEN slot. If every slot is full, an orb of the
 * player's choice is evoked first and the new one takes its place (p.16).
 * Running out of orb cubes is not modelled: the slots are the limit here.
 */
function channelOrb(
  state: CombatState,
  actor: Player,
  orb: OrbType,
  context: PlayContext,
): boolean {
  if (combatIsOver(state)) return false
  let open = actor.orbs.indexOf(null)
  // A full set forces an evoke to make room (p.16). Unsaid, the evoke's line
  // appeared with nothing to explain why an orb had vanished.
  if (open < 0) {
    state.log = [...state.log, `${actor.name} has no free orb slot, and must evoke to make room`]
    evokeOrb(state, actor, context)
    if (combatIsOver(state)) return false
    open = actor.orbs.indexOf(null)
    if (open < 0) return false
  }
  actor.orbs[open] = orb
  addPresentationEvent(state, {
    kind: 'orb', orb, actorId: actor.id,
    sourceId: context.presentationSourceId ?? 'orb-channel',
    enemyIds: [], playerIds: [],
  })
  return true
}

function applyOrbEvokeEffect(
  state: CombatState,
  actor: Player,
  orb: OrbType,
  chosenTarget: string | null | undefined,
  sourceCardId?: string,
  pendingTriggers?: PendingTrigger[],
): boolean {
  if (orb === 'lightning') {
    const targets = lightningDamageTargets(state, actor, chosenTarget, sourceCardId)
    if (!targets) return false
    for (const target of targets) {
      damageEnemyLogged(state, target, actor.damageDealtZeroThisTurn ? 0 : 2 + (actor.orbEvokeBonus ?? 0), `${actor.name}'s Lightning orb`)
    }
  } else if (orb === 'frost') {
    const before = actor.block
    grantBlock(state, actor, 1 + (actor.orbEvokeBonus ?? 0), pendingTriggers)
    if (actor.block > before) {
      state.log = [...state.log, `${actor.name}'s Frost orb gives ${actor.block - before} Block`]
    }
  } else {
    const target = livingEnemies(state).find((enemy) => enemy.uid === chosenTarget)
    if (!target) return false
    // Dark: 3 damage plus 1 for each Power in play. That bonus is fixed at evoke
    // time and is not boosted by card effects (rulebook FAQ, p.18).
    damageEnemyLogged(
      state,
      target,
      actor.damageDealtZeroThisTurn ? 0 :
        3 + actor.powers.length + (actor.orbEvokeBonus ?? 0) + (actor.darkOrbEvokeBonus ?? 0),
      `${actor.name}'s Dark orb`,
    )
  }
  return true
}

/**
 * Evokes one orb and applies its effect.
 *
 * The board game lets you evoke ANY orb — there is no front slot and no
 * rotation (p.16) — and the atomic context carries one slot and, where needed,
 * one enemy for each evoke.
 */
function evokeOrb(state: CombatState, actor: Player, context: PlayContext, times = 1): OrbType | null {
  // The slot has to be a real array INDEX, not any property key. These values
  // arrive as JSON from a client, and `orbs['length']` was truthy — it evoked
  // a non-existent Dark orb for free damage and then assigned null to
  // `length`, truncating the array to zero slots for the rest of the combat.
  // `orbs['__proto__']` was worse: it nulled the prototype and the next call
  // threw straight out of the room layer.
  const index = context.evokeIndex ?? 0
  const chosen = context.evokeSlots?.[index]
  const slot = chosen !== undefined && Number.isInteger(chosen) && chosen >= 0 &&
    chosen < actor.orbs.length && actor.orbs[chosen] != null
    ? chosen
    : actor.orbs.findIndex((orb) => orb != null)
  if (slot < 0) return null
  const orb = actor.orbs[slot]
  if (!orb) return null
  actor.orbs[slot] = null
  context.evokeIndex = index + 1

  for (let repeat = 0; repeat < times && !combatIsOver(state); repeat++) {
    const targetIndex = context.evokeTargetIndex ?? 0
    context.evokeTargetIndex = targetIndex + 1
    const fallbackEnemy = resolveEnemyTargets(state, 'enemy', context.enemyUid)[0] ?? livingEnemies(state)[0]
    const chosenTarget = context.evokeEnemyUids?.[targetIndex] ??
      (orb === 'lightning' && lightningTargetsRows(actor, context.sourceCardId) && fallbackEnemy
        ? lightningRowTarget(fallbackEnemy.row)
        : fallbackEnemy?.uid)
    if (!applyOrbEvokeEffect(
      state,
      actor,
      orb,
      chosenTarget,
      context.sourceCardId,
      context.sourceCardId ? context.pendingTriggers : undefined,
    ) &&
      livingEnemies(state).length > 0) context.invalidEvokeTarget = true
  }
  return orb
}

/** Resolves one Orb's end-turn effect; each Orb is separately ordered (p.16). */
export function resolveOrbAtEndOfTurn(state: CombatState, actor: Player, slot: number, targetUid?: string): boolean {
  const orb = actor.orbs[slot]
  if (orb === 'lightning') {
    const targets = lightningDamageTargets(state, actor, targetUid)
    if (!targets) return false
    for (const target of targets) {
      damageEnemyLogged(
        state,
        target,
        actor.damageDealtZeroThisTurn ? 0 :
          1 + (actor.orbEndTurnBonus ?? 0) + (actor.lightningEndTurnBonus ?? 0),
        `${actor.name}'s Lightning orb`,
      )
    }
  } else if (orb === 'frost') {
    const before = actor.block
    grantBlock(state, actor, 1 + (actor.orbEndTurnBonus ?? 0))
    if (actor.block > before) {
      state.log = [...state.log, `${actor.name}'s Frost orb gives ${actor.block - before} Block`]
    }
  }
  return true
}

/**
 * Fires every ongoing effect that matches an event: relics first, then Powers
 * in the order they were played.
 *
 * Relics and Powers are the same mechanism — a permanent thing in front of you
 * that reacts — so they share one dispatcher rather than drifting apart.
 *
 * Legacy trigger paths target the first living enemy where needed. The
 * table-facing Start-of-Turn phase supplies its explicit ordered choices.
 */
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
  } finally {
    if (!finiteDrawChain) triggerDepth--
  }
}

export function triggerSourceById(player: Player, id: string): TriggerSource | undefined {
  if (id.startsWith('relic:')) {
    const [indexText, abilityText] = id.slice(6).split(':')
    const index = Number(indexText)
    const held = Number.isInteger(index) ? player.relics[index] : undefined
    if (!held) return undefined
    const def = relicDef(held.defId)
    const ability = relicAbilities(def)[Number(abilityText ?? 0)]
    if (!ability) return undefined
    return {
      id,
      presentationSourceId: held.defId,
      trigger: ability.trigger,
      effects: ability.effects,
      name: `${player.name}'s ${def.name}`,
      scope: ability.target ?? 'enemy',
      supportScope: ability.supportTarget ?? 'self',
      oncePerTurn: false,
    }
  }
  if (!id.startsWith('power:')) return undefined
  const held = player.powers.find((power) => power.uid === id.slice(6))
  if (!held) return undefined
  const def = faceOf(cardDef(held.defId), held.upgraded)
  if (!def.trigger) return undefined
  return {
    id,
    presentationSourceId: held.defId,
    trigger: def.trigger,
    effects: def.effects,
    name: `${player.name}'s ${def.name}`,
    scope: def.target ?? 'enemy',
    supportScope: def.supportTarget ?? 'self',
    oncePerTurn: def.oncePerTurn === true,
    powerUid: held.uid,
  }
}

export function triggerSources(player: Player, event: TriggerEvent, excludeUid?: string): TriggerSource[] {
  const sources: TriggerSource[] = []
  for (const index of player.relics.keys()) {
    if (player.relics[index]!.defId === 'loaded_die' && player.relics[index]!.spent) continue
    for (const abilityIndex of relicAbilities(relicDef(player.relics[index]!.defId)).keys()) {
      const source = triggerSourceById(player, `relic:${index}:${abilityIndex}`)
      if (source && triggerMatches(source.trigger, event)) sources.push(source)
    }
  }
  for (const held of player.powers) {
    if (held.uid === excludeUid) continue
    const source = triggerSourceById(player, `power:${held.uid}`)
    if (source && triggerMatches(source.trigger, event)) sources.push(source)
  }
  return sources
}

function queuedTriggers(
  state: CombatState,
  event: TriggerEvent,
  only?: Player,
  excludeUid?: string,
): PendingTrigger[] {
  state.nextTriggerId ??= 0
  return state.players.flatMap((player) => player.dead || (only && player.id !== only.id) ? [] :
    triggerSources(player, event, excludeUid).map((source) => ({
      id: state.nextTriggerId++, playerId: player.id, sourceId: source.id,
      enemyUid: event.enemyUid,
    })))
}

export function triggerNeedsRowChoice(state: CombatState, player: Player, source: TriggerSource): boolean {
  return source.scope === 'row' && source.effects.some((effect) => reachesEnemy(effect, player)) &&
    combatRows(state).length > 1
}

export function triggerNeedsEnemyChoice(
  state: CombatState,
  player: Player,
  source: TriggerSource,
  enemyUid?: string,
): boolean {
  return enemyUid === undefined && source.scope === 'enemy' &&
    source.effects.some((effect) => reachesEnemy(effect, player)) && livingEnemies(state).length > 1
}

export function triggerNeedsPlayerChoice(state: CombatState, source: TriggerSource): boolean {
  return source.supportScope === 'anyPlayer' &&
    state.players.filter((candidate) => !candidate.dead).length > 1
}

export function resolveTriggerSource(
  state: CombatState,
  player: Player,
  source: TriggerSource,
  allowCombatOver = false,
  shivEnemyUids?: readonly (string | null)[],
  enemyUid?: string,
  enemyRow?: number,
  evokeSlots?: readonly number[],
  evokeEnemyUids?: readonly (string | null)[],
  scryDiscardUids?: readonly string[],
  targetPlayerId?: string,
): boolean {
  const useKey = source.powerUid ? powerAbilityKey(player.id, source.powerUid) : `${player.id}/${source.id}`
  if (source.oncePerTurn) {
    const used = (state.powerTriggersUsedThisTurn ??= [])
    if (used.includes(useKey)) return true
    used.push(useKey)
  }
  const loop = source.effects.find((effect) => effect.kind === 'triggerOrbEndTurn')
  if (loop) {
    const slot = evokeSlots?.[0]
    if (slot === undefined) return loopOrbTargets(state, player) === undefined
    const orb = player.orbs[slot]
    let target = evokeEnemyUids?.[0] ?? undefined
    if ((orb !== 'lightning' && orb !== 'frost') || (orb === 'lightning' && !target) ||
      (orb === 'frost' && target !== undefined)) return false
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
  }
  const effects = source.name.endsWith("'s Tungsten Rod") && state.players.length === 1
    ? [{ kind: 'block' as const, amount: 3 }]
    : source.effects
  for (const effect of effects) {
    applyEffect(state, player, effect, source.scope, source.supportScope, context, source.name)
    if (!allowCombatOver && combatIsOver(state)) return true
  }
  const privateDiscard = state.startTurnProgress?.discard
  if (privateDiscard) {
    privateDiscard.pendingTriggers = pendingTriggers
    return !context.invalidShivTarget && !context.invalidEvokeTarget && !context.invalidScryChoice
  }
  const forced = state.startTurnProgress?.forcedCard
  if (forced && pendingTriggers.length > 0) {
    forced.pendingTriggers = [...(forced.pendingTriggers ?? []), ...pendingTriggers]
  } else {
    releasePendingTriggers(state, context)
  }
  return !context.invalidShivTarget && !context.invalidEvokeTarget && !context.invalidScryChoice
}

export function resolveQueuedTriggerSource(
  state: CombatState,
  player: Player,
  source: TriggerSource,
  enemyUid?: string,
  enemyRow?: number,
  targetPlayerId?: string,
): void {
  if (source.trigger.kind === 'onDraw') {
    resolveTriggerSource(state, player, source, false, undefined, enemyUid, enemyRow,
      undefined, undefined, undefined, targetPlayerId)
    return
  }
  if (triggerDepth >= MAX_TRIGGER_DEPTH) return
  triggerDepth++
  try {
    resolveTriggerSource(state, player, source, false, undefined, enemyUid, enemyRow,
      undefined, undefined, undefined, targetPlayerId)
  } finally {
    triggerDepth--
  }
}

export function flushPendingTriggers(state: CombatState): void {
  state.pendingTriggers ??= []
  while (state.pendingTriggers.length > 0 && !combatIsOver(state)) {
    const pending = state.pendingTriggers[0]!
    const player = findPlayer(state, pending.playerId)
    const source = player && triggerSourceById(player, pending.sourceId)
    if (!player || player.dead || !source) {
      state.pendingTriggers.shift()
      continue
    }
    if (triggerNeedsRowChoice(state, player, source) ||
      triggerNeedsEnemyChoice(state, player, source, pending.enemyUid) ||
      triggerNeedsPlayerChoice(state, source)) return
    state.pendingTriggers.shift()
    resolveQueuedTriggerSource(
      state,
      player,
      source,
      pending.enemyUid ?? (source.scope === 'enemy' ? livingEnemies(state)[0]?.uid : undefined),
      source.scope === 'row' ? combatRows(state)[0] : undefined,
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
        triggerNeedsPlayerChoice(state, source))) {
        state.pendingTriggers ??= []
        state.nextTriggerId ??= 0
        state.pendingTriggers.push({
          id: state.nextTriggerId++, playerId: player.id, sourceId: source.id,
          enemyUid: event.enemyUid,
        })
        continue
      }
      resolveTriggerSource(
        state,
        player,
        source,
        allowCombatOver,
        undefined,
        event.enemyUid,
        source.scope === 'row' ? combatRows(state)[0] : undefined,
      )
      if (!allowCombatOver && combatIsOver(state)) return
    }
  }
}

/** Decides whether the combat has ended, and returns the state either way. */
export function settle(state: CombatState): CombatState {
  if (lastStandActive(state) && state.players.every((player) => player.dead)) {
    state.pendingTriggers = []
    delete state.pendingDistilled
    delete state.endTurnProgress
    delete state.pendingCardCopy
    delete state.startTurnProgress
    state.phase = 'lost'
    return state
  }
  // Outside The Last Stand, victory is tested first. `combatIsOver` normally
  // stops each phase at the moment either ending happens, so this ordering is
  // only a backstop for a state assembled by hand.
  if (state.enemies.every((enemy) => enemy.dead) && state.pendingSummons.length === 0) {
    state.pendingTriggers = []
    delete state.pendingDistilled
    delete state.endTurnProgress
    delete state.pendingCardCopy
    delete state.startTurnProgress
    state.phase = 'won'
    fireTriggers(state, { kind: 'endOfCombat' })
    return state
  }
  // p.13: ONE death, not a wipe. The optional Last Stand rule on p.23 is the
  // only exception, and applies only to a Boss fight.
  if (!lastStandActive(state) && state.players.some((player) => player.dead)) {
    state.pendingTriggers = []
    delete state.pendingDistilled
    delete state.endTurnProgress
    delete state.pendingCardCopy
    delete state.startTurnProgress
    state.phase = 'lost'
    return state
  }
  return state
}
