// The engine's public surface. Everything outside src/game/ imports from here,
// so the internal module layout stays free to change.
//
// This file is re-exports only. A check in scripts/verify-architecture.mjs
// asserts every engine module is reachable from here, which is what catches a
// module that was written but never wired up.
//
// Not implemented yet, so that nobody mistakes silence for correctness:
//   - Orbs (channel/evoke) and Scry resolve as no-ops, so Zap and Dual Cast do
//     nothing useful.
//   - Players cannot carry Weak or Vulnerable, so enemy actions applying them
//     are no-ops.
//   - A Power card plays and stays in front of the player, but nothing triggers
//     off it, so a Power's ongoing effect never fires. No Power is transcribed.
//   - Only the four starter decks plus Twin Strike and True Grit are transcribed;
//     3 enemies of roughly 60, and no elites or bosses.
//   - Relics, potions, gold, events, the map and the campaign do not exist.

export { createRng, nextFloat, nextInt, shuffle, pick, pickMany, seedFromString } from './rng.ts'
export type { RngState } from './rng.ts'

export { CAPS } from './types.ts'
export type {
  CardInstance,
  CardType,
  CharacterId,
  Enemy,
  OrbType,
  Player,
  Rarity,
  Stance,
} from './types.ts'

export {
  addCapped,
  applyDamage,
  applyHpLoss,
  attackerModsOfEnemy,
  attackerModsOfPlayer,
  gainBlock,
  gainPoison,
  gainStrength,
  gainVulnerable,
  gainWeak,
  hitDamage,
  totalPoisonInPlay,
} from './damage.ts'
export type { AttackerMods, DamageOutcome, DefenderMods } from './damage.ts'

export {
  addToDiscardTop,
  addToDrawTop,
  collectDeck,
  discardHand,
  drawCards,
  moveToDiscard,
  scry,
} from './piles.ts'
export type { DrawResult, Piles } from './piles.ts'

export { CARDS, STARTER_DECKS, cardDef, faceOf } from './cards.ts'
export type { CardDef, Effect, TargetScope } from './cards.ts'

export {
  createCombat,
  endPlayerTurn,
  livingEnemies,
  playCard,
  resolveEnemyTargets,
  startPlayerTurn,
} from './combat.ts'
export type { CombatPhase, CombatState, PlayContext } from './combat.ts'

export { CARD_ASSET_ROOT, cardImagePath, tierOf } from './assets.ts'

export { ENEMIES, actionsFor, advanceCube, enemyDef, startingHp } from './enemies.ts'
export type { CubeSlot, EnemyAction, EnemyDef, EnemyPattern } from './enemies.ts'
export { enemyActingOrder, enemyTurn } from './combat.ts'
