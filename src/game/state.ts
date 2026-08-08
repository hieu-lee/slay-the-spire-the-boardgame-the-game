// The engine's public surface. Everything outside src/game/ imports from here,
// so the internal module layout stays free to change.
//
// This file is re-exports only. A check in scripts/verify-architecture.mjs
// asserts every engine module is reachable from here, which is what catches a
// module that was written but never wired up.
//
// Not implemented yet, so that nobody mistakes silence for correctness:
//   - Powers stay in front of the player but nothing triggers off them, so a
//     Power's ongoing effect never fires. This is the single largest gap: it
//     blocks roughly 20 cards per character.
//   - Card effects cannot scale off game state (per Orb, per Miracle, per card
//     in hand) and X-cost cards cannot read the energy spent.
//   - Retain and Ethereal are not modelled.
//   - Enemy special abilities are stored as prose on `unimplementedAbility` and
//     do NOT resolve: Curl Up, Spore Cloud, Enraged.
//   - There is no boss deck: a boss room stands up the toughest elite, marked
//     as a boss so it acts last. Elite rooms draw from a two-entry elite list.
//   - Event, treasure and merchant rooms show a placeholder screen.
//   - Relics fire on their triggers, but there is no way to GAIN one during a
//     run, and potions have no trigger and cannot be drunk at all.
//   - Only the four starter decks plus Twin Strike and True Grit are
//     transcribed; 9 enemies of roughly 60.
//   - Ascension modifiers other than the Act-heal are not applied.

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

export { ACT_SHAPE, availableMoves, currentRoom, generateMap, isActComplete, moveTo } from './map.ts'
export type { MapShape, Room, RoomKind, SpireMap } from './map.ts'

export { RELICS, POTIONS, STARTING_RELIC, relicDef, potionDef } from './relics.ts'
export type { PotionDef, RelicDef, RelicTrigger } from './relics.ts'

export { MAX_HP, advanceAct, createPlayer, createRun, enterRoom, leaveRoom, resolveCombat, roomChoices } from './run.ts'
export type { PartyMember, RunPhase, RunState } from './run.ts'
export { resolveCampfire } from './run.ts'
export type { CampfireChoice } from './run.ts'
