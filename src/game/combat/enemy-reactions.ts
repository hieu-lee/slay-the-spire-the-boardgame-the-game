// Enemy death reactions, logged enemy damage, post-attack enemy reactions,
// and Enraged triggers.
//
// Cycle-free helper module below `effects.ts`: effects-layer mutations
// (discarding attached cards and damaging players) are supplied as callbacks.
import { combatIsOver, enemyLabel, findPlayer, playersInRowOf } from './board.ts'
import { addStatus, damageEnemy, grantShiftBlock, playerCanGainDebuffs, triggerAngry } from './pieces.ts'
import { detachSlayerCards, resolveSlayerAttachedDamage } from './slayer.ts'
import type { CombatState, PlayContext } from './types.ts'
import { gainBlock, gainStrength, gainVulnerable, recordDamageDealt } from '../damage.ts'
import { advanceCube, enemyAbilities, enemyDef } from '../enemies.ts'
import { nextInt } from '../rng.ts'
import type { CardInstance, Enemy, Player } from '../types.ts'

export type DamagePlayerCallback = (
  state: CombatState,
  player: Player,
  damage: number,
) => { fullyBlocked: boolean; hpLost: number }

export interface EnemyReactionCallbacks {
  discardByCardEffect: (state: CombatState, actor: Player, cards: readonly CardInstance[]) => void
  damagePlayer: DamagePlayerCallback
}

export function playerWeakIsRetained(state: CombatState): boolean {
  return state.enemies.some((enemy) => !enemy.dead &&
    enemyAbilities(enemyDef(enemy.defId, enemy.ascension)).some((ability) => ability.kind === 'retainPlayerWeak'))
}

export function triggerEnemyDeath(
  state: CombatState,
  enemy: Enemy,
  callbacks: EnemyReactionCallbacks,
): void {
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
  const secondWind = abilities.find((ability) => ability.kind === 'secondWind')
  if (secondWind?.kind === 'secondWind' && !enemy.abilityUsed) {
    enemy.abilityUsed = true
    state.pendingSummons.push({
      sourceUid: enemy.uid,
      row: enemy.row,
      defIds: [secondWind.defId],
      turn: state.turn + 1,
      timing: 'startOfTurn',
      direct: true,
      isBoss: enemy.isBoss,
      strength: secondWind.transferStrength ? enemy.strength : 0,
    })
    state.log = [...state.log, `${name}'s Second Wind will return next round`]
  }
  const blasphemy = abilities.find((ability) => ability.kind === 'blasphemy')
  if (blasphemy?.kind === 'blasphemy' && !enemy.abilityUsed) {
    enemy.abilityUsed = true
    const oldIndex = enemy.actionIndex
    enemy.defId = blasphemy.defId
    enemy.dead = false
    enemy.hp = 1
    enemy.weak = 0
    enemy.actionIndex = advanceCube(enemyDef(enemy.defId, enemy.ascension), oldIndex)
    state.log = [...state.log, `${enemyLabel(state.enemies, enemy)} enters Divinity with 1 HP`]
  }
  const spore = abilities.find((ability) => ability.kind === 'sporeCloud')
  if (spore?.kind === 'sporeCloud') {
    for (const target of playersInRowOf(state, enemy)) {
      if (!playerCanGainDebuffs(target)) continue
      const before = target.vulnerable
      target.vulnerable = gainVulnerable(target.vulnerable, spore.vulnerable)
      if (target.vulnerable > before) {
        state.log = [...state.log, `${name}'s Spore Cloud left ${target.name} vulnerable`]
      }
    }
  }
  const cleanup = abilities.find((ability) => ability.kind === 'deathTokenCleanup')
  if (cleanup?.kind === 'deathTokenCleanup') for (const player of state.players.filter((candidate) => !candidate.dead)) {
    const before = player[cleanup.token]
    player[cleanup.token] = Math.max(0, before - cleanup.amount)
    if (player[cleanup.token] < before) state.log = [...state.log,
      `${name}'s defeat removes ${before - player[cleanup.token]} ${cleanup.token} from ${player.name}`]
  }
  const plunder = abilities.find((ability) => ability.kind === 'plunder')
  if (plunder?.kind === 'plunder') for (const player of playersInRowOf(state, enemy).filter((candidate) => !candidate.dead)) {
    const gained = addStatus(state, player, 'burn', plunder.burns, enemy.uid)
    player.lootChests = (player.lootChests ?? 0) + plunder.chests
    state.pendingPlunderSwitches = [...(state.pendingPlunderSwitches ?? []),
      { playerId: player.id, sourceUid: enemy.uid }]
    state.log = [...state.log,
      `${player.name} plunders ${plunder.chests} chest and gains ${gained} Burn${gained === 1 ? '' : 's'}`]
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
      damageEnemyLogged(state, target, attachment.damage, callbacks, 'Corpse Explosion', owner)
    }
    if (owner) callbacks.discardByCardEffect(state, owner, [attachment.card])
  }
  const bounties = enemy.hermitBounties ?? []
  enemy.hermitBounties = undefined
  for (const bounty of bounties) {
    const owner = findPlayer(state, bounty.playerId)
    if (owner) {
      state.pendingHermitStrengthRewards = [...(state.pendingHermitStrengthRewards ?? []),
        { playerId: owner.id, sourceUid: bounty.card.uid }]
      callbacks.discardByCardEffect(state, owner, [bounty.card])
    }
  }
  detachSlayerCards(state, enemy, callbacks.discardByCardEffect)
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
  callbacks: EnemyReactionCallbacks,
  source?: string,
  actor?: Player,
): void {
  const wasAlive = !enemy.dead
  const hpBefore = enemy.hp
  const result = damageEnemy(state, enemy, damage)
  recordDamageDealt(actor, 'special', result.blocked + result.hpLost)
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
    triggerEnemyDeath(state, enemy, callbacks)
  } else if (result.curled) {
    state.log = [...state.log, `${name}'s Curl Up gained Block`]
  }
  if (result.hpLost > 0 && !combatIsOver(state) &&
    enemyAbilities(enemyDef(enemy.defId, enemy.ascension)).some((ability) => ability.kind === 'shift')) {
    grantShiftBlock(state, enemy, result.hpLost)
  }
}

/** Printed enemy reactions wait until one whole Attack has resolved. */
export function resolvePendingEnemyReactions(
  state: CombatState,
  actor: Player,
  context: PlayContext,
  callbacks: EnemyReactionCallbacks,
): void {
  for (const uid of new Set(context.pendingEnemyDeathUids ?? [])) {
    const enemy = state.enemies.find((candidate) => candidate.uid === uid)
    if (enemy?.dead) triggerEnemyDeath(state, enemy, callbacks)
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
        .filter((event) => event.enemyUid === enemy.uid && event.attack).length)
      if (attacked.has(enemy.uid) && abilities.some((ability) => ability.kind === 'reactiveReroll')) {
        state.die = nextInt(state.rng, 6) + 1
        state.log = [...state.log, `${enemyLabel(state.enemies, enemy)} rerolled enemy intents to ${state.die}`]
      }
    }
    const flameBarrier = abilities.find((ability) => ability.kind === 'burnOnAttackWhileSlot')
    if (attacked.has(enemy.uid) && flameBarrier?.kind === 'burnOnAttackWhileSlot' &&
      enemy.actionIndex === flameBarrier.slot) {
      const gained = addStatus(state, actor, 'burn', flameBarrier.amount, enemy.uid)
      if (gained > 0) state.log = [...state.log,
        `${enemyLabel(state.enemies, enemy)} gives ${actor.name} ${gained} Burn`]
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
    const outcome = callbacks.damagePlayer(state, actor, amount)
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
  // Slayer Pack: Nightmare answers each Attack its owner struck its host with.
  if (attacked.size > 0 && !combatIsOver(state)) {
    resolveSlayerAttachedDamage(
      state,
      actor,
      'attackAgainstHost',
      attacked,
      (targetState, targetEnemy, targetDamage, targetSource, targetActor) =>
        damageEnemyLogged(targetState, targetEnemy, targetDamage, callbacks, targetSource, targetActor),
      undefined,
      context.slayerAttachedAtStart,
    )
  }
}

export function resolveEnraged(
  state: CombatState,
  actor: Player,
  damagePlayer: DamagePlayerCallback,
): void {
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
