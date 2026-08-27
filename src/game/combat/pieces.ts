// The physical pieces, and the supplies they come out of.
//
// Enemy HP and Block, the shared Poison cubes, the one ten-card Daze deck and
// the Status piles every source draws from. These functions move components,
// including the enemy's own reflex when a component moves — Curl Up's Block,
// Angry's Strength, a Shift. What made the component move is printed on a card
// or a Relic, and that lives a layer up, in the resolver.
import { enemyLabel, playersInRowOf } from './board.ts'
import type { CombatState } from './types.ts'
import { applyDamage, applyHpLoss, gainBlock, gainPoison, gainStrength, totalPoisonInPlay } from '../damage.ts'
import { enemyAbilities, enemyDef, startingHp } from '../enemies.ts'
import { addToDiscardTop } from '../piles.ts'
import { CAPS } from '../types.ts'
import type { CardInstance, Enemy, Player } from '../types.ts'

export function forgetRetain(card: CardInstance): CardInstance {
  const {
    retainedLastTurn: _retained,
    retainThisTurn: _retain,
    freeThisTurn: _free,
    costReductionThisTurn: _reduction,
    scryDamageBonus: _scryBonus,
    ...rest
  } = card
  return rest
}

function enemyCannotLoseHp(enemy: Enemy): boolean {
  const immunity = enemyAbilities(enemyDef(enemy.defId, enemy.ascension))
    .find((ability) => ability.kind === 'immuneOnSlots')
  return immunity?.kind === 'immuneOnSlots' && immunity.slots.includes(enemy.actionIndex)
}

function enemyHpAfterLoss(state: CombatState, enemy: Enemy, hp: number): number {
  if (enemyCannotLoseHp(enemy)) return enemy.hp
  const invincible = enemyAbilities(enemyDef(enemy.defId, enemy.ascension))
    .find((ability) => ability.kind === 'invincible')
  if (invincible?.kind !== 'invincible' || enemy.abilityUsed) return hp
  return Math.max(hp, invincible.hpPerPlayer * state.players.length)
}

export function loseEnemyHp(state: CombatState, enemy: Enemy, amount: number): { hp: number; hpLost: number } {
  const outcome = applyHpLoss(enemy.hp, amount)
  const hp = enemyHpAfterLoss(state, enemy, outcome.hp)
  return { hp, hpLost: enemy.hp - hp }
}

/** Deals `damage` to an enemy, spending Block and firing Curl Up immediately. */
export function damageEnemy(
  state: CombatState,
  enemy: Enemy,
  damage: number,
  deferAbilities = false,
): { blocked: number; curled: boolean; hpLost: number } {
  const hpBefore = enemy.hp
  const blockBefore = enemy.block
  const outcome = applyDamage(enemy.block, enemy.hp, damage)
  enemy.block = outcome.block
  enemy.hp = enemyHpAfterLoss(state, enemy, outcome.hp)
  if (enemy.hp === 0) enemy.dead = true
  const ability = enemyAbilities(enemyDef(enemy.defId, enemy.ascension))
    .find((candidate) => candidate.kind === 'curlUp')
  if (
    !deferAbilities && enemy.hp < hpBefore && !enemy.dead && !enemy.abilityUsed && ability?.kind === 'curlUp'
  ) {
    enemy.abilityUsed = true
    enemy.block = gainBlock(enemy.block, ability.block)
    return { blocked: blockBefore - outcome.block, curled: true, hpLost: hpBefore - enemy.hp }
  }
  return { blocked: blockBefore - outcome.block, curled: false, hpLost: hpBefore - enemy.hp }
}

export function grantShiftBlock(state: CombatState, enemy: Enemy, amount: number): void {
  if (amount <= 0) return
  for (const player of playersInRowOf(state, enemy)) {
    const before = player.block
    player.block = gainBlock(player.block, amount)
    if (player.block > before) state.log = [...state.log,
      `${enemyLabel(state.enemies, enemy)}'s Shift gave ${player.name} ${player.block - before} Block`]
  }
}

export function triggerAngry(state: CombatState, enemy: Enemy, damagingHits: number): void {
  const ability = enemyAbilities(enemyDef(enemy.defId, enemy.ascension))
    .find((candidate) => candidate.kind === 'angry')
  if (enemy.dead || damagingHits === 0 || ability?.kind !== 'angry') return
  const before = enemy.strength
  enemy.strength = gainStrength(enemy.strength, ability.strength * damagingHits)
  if (enemy.strength > before) state.log = [...state.log,
    `${enemyLabel(state.enemies, enemy)}'s Angry gained ${enemy.strength - before} Strength`]
}

/** Adds Poison through the shared cube cap. */
export function putPoison(state: CombatState, target: Enemy, amount: number): number {
  if (target.dead) return 0
  const before = target.poison
  target.poison = gainPoison(target.poison, amount, totalPoisonInPlay(state.enemies))
  return target.poison - before
}

function enemyInGroup(enemy: Enemy, group: 'gremlin' | 'darkling'): boolean {
  return group === 'darkling'
    ? enemy.defId.startsWith('darkling')
    : ['mad_gremlin', 'sneaky_gremlin', 'gremlin_wizard', 'fat_gremlin'].includes(enemy.defId)
}

export function reviveAll(state: CombatState, group: 'gremlin' | 'darkling'): number {
  let revived = 0
  for (const target of state.enemies) {
    if (!target.dead || !enemyInGroup(target, group)) continue
    target.dead = false
    target.hp = group === 'darkling' ? 4 : startingHp(enemyDef(target.defId, target.ascension), state.players.length)
    target.block = target.strength = target.vulnerable = target.weak = target.poison = 0
    target.actionIndex = 0
    target.abilityUsed = false
    revived++
  }
  return revived
}

/** Whether this enemy's death has printed work that must wait for the card to finish. */
export function enemyHasDeathReaction(state: CombatState, enemy: Enemy): boolean {
  const own = enemyAbilities(enemyDef(enemy.defId, enemy.ascension))
  if (own.some((ability) =>
    ability.kind === 'splitOnDeath' || ability.kind === 'rebirth' || ability.kind === 'sporeCloud')) return true
  if (enemy.corpseExplosion) return true
  return state.enemies.some((ally) => !ally.dead && ally.row === enemy.row &&
    enemyAbilities(enemyDef(ally.defId, ally.ascension)).some((ability) =>
      ability.kind === 'furyOnAllyDeath' &&
      (ability.allyDefId === enemy.defId || enemy.defId.startsWith(`${ability.allyDefId}_`))))
}

/** Take Daze from the one physical ten-card deck shared by every source. */
export function addDaze(
  state: CombatState,
  target: Player,
  amount: number,
  pile: 'draw' | 'discard',
  source: string,
): number {
  const inPlay = state.players.reduce((total, player) => total + [
    ...player.draw,
    ...player.hand,
    ...player.discard,
    ...player.exhaust,
  ].filter((card) => card.defId === 'daze').length, 0)
  const gained = Math.min(amount, Math.max(0, CAPS.daze - inPlay))
  const cards = Array.from({ length: gained }, (_, index) => ({
    uid: `daze-${state.turn}-${source}-${target.id}-${state.log.length}-${index}`,
    defId: 'daze',
    upgraded: false,
  }))
  if (pile === 'draw') target.draw = [...cards, ...target.draw]
  else target.discard = [...target.discard, ...cards]
  return gained
}

export function addStatus(
  state: CombatState,
  target: Player,
  defId: 'burn' | 'slimed',
  amount: number,
  source: string,
  pile: 'draw' | 'discard' = 'discard',
): number {
  const inPlay = state.players.reduce((total, player) => total + [
    ...player.draw, ...player.hand, ...player.discard, ...player.exhaust,
  ].filter((card) => card.defId === 'burn' || card.defId === 'slimed').length, 0)
  const gained = Math.min(amount, Math.max(0, CAPS.status - inPlay))
  const cards = Array.from({ length: gained }, (_, index) => ({
    uid: `status-${state.turn}-${source}-${target.id}-${state.log.length}-${index}`,
    defId,
    upgraded: false,
  }))
  if (pile === 'draw') target.draw = [...cards, ...target.draw]
  else target.discard = addToDiscardTop(target, cards).discard
  return gained
}
