// Damage arithmetic. Small, but it is where a port of this game is most likely
// to be quietly wrong, so every rule here cites the rulebook.
import { CAPS } from './types.ts'
import type { Enemy, Player } from './types.ts'

/** Everything about an attacker that changes a hit's damage. */
export type AttackerMods = {
  strength: number
  weak: number
  /** Watcher only: Wrath is "effectively the same as having 1 Strength" (p.17). */
  wrath: boolean
  wrathAttackDamageBonus: number
}

export type DefenderMods = {
  vulnerable: number
}

export function attackerModsOfPlayer(player: Player): AttackerMods {
  return {
    strength: player.strength,
    weak: player.weak,
    wrath: player.stance === 'wrath',
    wrathAttackDamageBonus: player.wrathAttackDamageBonus ?? 0,
  }
}

export function attackerModsOfEnemy(enemy: Enemy): AttackerMods {
  return { strength: enemy.strength, weak: enemy.weak, wrath: false, wrathAttackDamageBonus: 0 }
}

/**
 * Damage of a single hit, before Block.
 *
 * Order matters and is stated explicitly on p.24: "Add damage bonuses like
 * Strength before doubling." And a Weak attacker striking a Vulnerable target is
 * "unaffected by both" — the two cancel rather than compounding.
 */
export function hitDamage(base: number, attacker: AttackerMods, defender: DefenderMods): number {
  const bonus = attacker.strength + (attacker.wrath ? 1 + attacker.wrathAttackDamageBonus : 0)
  const boosted = base + bonus

  const attackerIsWeak = attacker.weak > 0
  const defenderIsVulnerable = defender.vulnerable > 0

  let total = boosted
  if (attackerIsWeak && defenderIsVulnerable) {
    // Neither applies.
  } else if (attackerIsWeak) {
    total = boosted - 1
  } else if (defenderIsVulnerable) {
    total = boosted * 2
  }

  return Math.max(0, total)
}

/** Result of pushing damage through Block. */
export type DamageOutcome = {
  block: number
  hp: number
  /** Damage that got past Block and actually cost HP. */
  hpLost: number
  /** True when Block absorbed the hit entirely. */
  fullyBlocked: boolean
}

/** Block prevents 1 damage per point and is spent as it prevents (p.24). */
export function applyDamage(block: number, hp: number, damage: number): DamageOutcome {
  const absorbed = Math.min(block, damage)
  const throughput = damage - absorbed
  return {
    block: block - absorbed,
    hp: Math.max(0, hp - throughput),
    hpLost: Math.min(hp, throughput),
    fullyBlocked: throughput === 0,
  }
}

/**
 * "Lose X HP" bypasses Block entirely (p.18). Poison is the common case: it is
 * HP loss, not damage, which is why it also ignores Block.
 */
export function applyHpLoss(hp: number, amount: number): { hp: number; hpLost: number } {
  const lost = Math.min(hp, Math.max(0, amount))
  return { hp: hp - lost, hpLost: lost }
}

/** Tokens clamp at their cap; excess is discarded rather than banked (p.18). */
export function addCapped(current: number, amount: number, cap: number): number {
  return Math.max(0, Math.min(cap, current + amount))
}

export function gainBlock(current: number, amount: number): number {
  return addCapped(current, amount, CAPS.block)
}

export function gainStrength(current: number, amount: number): number {
  return addCapped(current, amount, CAPS.strength)
}

export function gainVulnerable(current: number, amount: number): number {
  return addCapped(current, amount, CAPS.vulnerable)
}

export function gainWeak(current: number, amount: number): number {
  return addCapped(current, amount, CAPS.weak)
}

/**
 * Poison is capped at 30 across every enemy combined, not per enemy (p.17).
 *
 * `poisonOnAllEnemies` must be the total across the whole combat **including
 * this target's own current poison** — pass `totalPoisonInPlay(enemies)`
 * directly. Passing only the other enemies' poison would let the table exceed
 * the cap by `current`.
 */
export function gainPoison(current: number, amount: number, poisonOnAllEnemies: number): number {
  const headroom = Math.max(0, CAPS.poison - poisonOnAllEnemies)
  return current + Math.max(0, Math.min(headroom, amount))
}

export function totalPoisonInPlay(enemies: readonly Enemy[]): number {
  let total = 0
  for (const enemy of enemies) if (!enemy.dead) total += enemy.poison
  return total
}
