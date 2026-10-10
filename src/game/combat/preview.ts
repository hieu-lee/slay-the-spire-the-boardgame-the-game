// What an Attack would do right now, worked out by the real engine.
//
// The physical card prints a number that ignores Strength, Weak, Vulnerable and
// Block-scaled amounts. Rather than re-deriving every card's arithmetic here
// (and drifting from it), the card is played on a throwaway copy and the
// damage is read off a target that cannot die or block.
import { cardDef, faceOf } from '../cards.ts'
import type { CardDef } from '../cards.ts'
import { clone, findPlayer } from './board.ts'
import { playCard } from './play.ts'
import { effectiveCombatCardDef, maximumXEnergy, persistentEffectOf, playCost } from './queries.ts'
import type { CombatState } from './types.ts'
import type { CardInstance } from '../types.ts'

/** Headroom added to the target so no single card can kill it. */
const STAND_IN_HP = 9999

export type CardDamagePreview = {
  /** Damage the card deals to the target now, before the target's Block. */
  damage: number
  /** The same play with no Strength, Weak, Wrath or target Vulnerable. */
  baseline: number
}

/** Rules an online client cannot evaluate: its copy of the state blanks these ledgers and piles. */
const PRIVATE_BOARD_RULES = /stanceChangedThisTurn|discardedThisTurn|drawPileEmpty/
const DRAW_EFFECTS = /"kind":"[a-zA-Z]*[dD]raw/
const defText = new WeakMap<CardDef, string>()
const textOf = (def: CardDef) => {
  if (!defText.has(def)) defText.set(def, JSON.stringify(def))
  return defText.get(def)!
}

const hasCardIconBonus = (power: CardInstance): boolean => persistentEffectOf(power, 'cardIconBonus') !== undefined

function damageDealt(
  state: CombatState,
  playerId: string,
  cardUid: string,
  enemyUid: string,
  plain: boolean,
  standIn: boolean,
  hiddenBoard: boolean,
): number | null {
  // The log can run to thousands of lines and a probe never reads it.
  const probe = clone({ ...state, log: [], presentationEvents: [] })
  if (standIn) {
    // No enemy picked: a plain enemy alone, so no one's Flying, Buffer or guard rules count.
    const first = probe.enemies.find((enemy) => !enemy.dead)
    if (!first) return null
    probe.enemies = [{ ...first, uid: enemyUid, defId: 'cultist', ascension: undefined, isBoss: false, strength: 0,
      vulnerable: 0, weak: 0, poison: 0, abilityUsed: false, abilityCubes: undefined, phase: undefined,
      corpseExplosion: undefined, hermitBounties: undefined, slayerAttachments: undefined }]
  }
  const actor = findPlayer(probe, playerId)
  const target = probe.enemies.find((enemy) => enemy.uid === enemyUid && !enemy.dead)
  const held = actor?.hand.find((card) => card.uid === cardUid)
  if (!actor || !target || !held) return null
  const def = effectiveCombatCardDef(faceOf(cardDef(held.defId), held.upgraded), actor.guardianMode)
  if (def.type !== 'attack') return null
  if (hiddenBoard && PRIVATE_BOARD_RULES.test(textOf(def))) return null
  // A card that draws would show whether the top card is a Status (Fire Breathing): hidden information.
  if (actor.powers.some((power) => cardDef(power.defId).trigger?.kind === 'onDraw') && DRAW_EFFECTS.test(textOf(def))) return null
  const cost = playCost(def, actor, held)
  // Shown even when the card is unaffordable: the number is about the card.
  if (cost !== 'X') actor.energy = Math.max(actor.energy, cost)
  if (plain) {
    actor.strength = 0
    actor.weak = 0
    actor.stance = 'neutral'
    actor.wrathAttackDamageBonus = 0
    actor.akabekoAttacks = 0
    // Slayer Pack: Fasting's per-icon bonus is a modifier like Strength, not printed text.
    actor.powers = actor.powers.filter((power) => !hasCardIconBonus(power))
    target.vulnerable = 0
  }
  // Add headroom rather than overwrite, so "full HP" rules (Backstab) still see the real target.
  if (standIn) target.hp = target.maxHp
  const hpBefore = target.hp + STAND_IN_HP
  target.hp = hpBefore
  target.maxHp += STAND_IN_HP
  target.block = 0
  const next = playCard(probe, playerId, cardUid, {
    enemyUid,
    enemyRow: target.row,
    playerId,
    ...(cost === 'X' ? { energySpent: Math.min(actor.energy, maximumXEnergy(def, actor)) } : {}),
  })
  if (next === probe) return null
  const after = next.enemies.find((enemy) => enemy.uid === enemyUid)
  return after ? hpBefore - after.hp : null
}

/**
 * The damage a held Attack would deal, or null when it cannot be worked out
 * without a decision from the player (a discard, a second target). With no
 * `enemyUid` a plain enemy stands in, so the number claims nothing about a
 * target the player has not picked. The input state is never changed and no
 * random number is consumed.
 */
export function previewCardDamage(
  state: CombatState,
  playerId: string,
  cardUid: string,
  enemyUid: string | null,
  /** The state is an online client's copy, which blanks some of the board. */
  hiddenBoard = false,
): CardDamagePreview | null {
  const target = enemyUid ?? state.enemies.find((enemy) => !enemy.dead)?.uid
  if (!target || state.phase !== 'player') return null
  const actor = findPlayer(state, playerId)
  // With nothing to switch off, the plain play is this play: skip the second probe.
  const modified = !actor || actor.strength !== 0 || actor.weak !== 0 || actor.stance !== 'neutral' ||
    (actor.wrathAttackDamageBonus ?? 0) !== 0 || (actor.akabekoAttacks ?? 0) !== 0 || actor.powers.some(hasCardIconBonus) ||
    enemyUid !== null && (state.enemies.find((enemy) => enemy.uid === enemyUid)?.vulnerable ?? 0) !== 0
  try {
    const damage = damageDealt(state, playerId, cardUid, target, false, enemyUid === null, hiddenBoard)
    const baseline = damage === null ? null
      : modified ? damageDealt(state, playerId, cardUid, target, true, enemyUid === null, hiddenBoard) : damage
    return damage === null || baseline === null ? null : { damage, baseline }
  } catch {
    // A badge is only a hint: an engine fault here must not take the combat screen down.
    return null
  }
}
