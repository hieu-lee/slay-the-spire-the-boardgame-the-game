// The engine's public surface. Everything outside src/game/ imports from here,
// so the internal module layout stays free to change.
//
// This file is re-exports only. A check in scripts/verify-architecture.mjs
// asserts every engine module is reachable from here, which is what catches a
// module that was written but never wired up.
//
// Combat and 105 enemies of roughly 60 physical cards are live.
// 251 of 259 unique character cards are live as ordinary definitions; the
// other eight are implemented Golden Ticket rewards. 22 of 22 colorless cards are live. Relics, potions, and their
// Ascension rules are live. Event, Merchant/Courier, Treasure, and campaign
// presentation are composed from the separate noncombat implementation.
// No scan-read cards are held back in `DEFERRED_CARDS`.
// The other 8 have not been transcribed as ordinary card definitions.
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

export { CARDS, STARTER_DECKS, cardCost, cardDef, faceOf } from './cards.ts'
export type { Amount, CardDef, CardMode, Condition, CountOf, Effect, HandEndOfTurnEffect, TargetScope } from './cards.ts'

export {
  abandonCardCopy,
  abandonForcedCard,
  activatePower,
  activatePotion,
  activateRelic,
  beginEndPlayerTurn,
  cardEnemyChoiceCount,
  cardNeedsChoicePreview,
  cardNeedsEnemy,
  cardIsPlayable,
  cardPlayerChoiceCount,
  cardShivChoiceCount,
  cardPlayConditionMet,
  chooseEndTurnTarget,
  chooseDistilledCard,
  chosenEvokeOrbs,
  defaultEndTurnOrder,
  discardOrderIsValid,
  endTurnAbilities,
  endTurnChoiceId,
  endTurnChoiceTarget,
  createCombat,
  endPlayerTurn,
  livingEnemies,
  lightningRowFromTarget,
  lightningRowTarget,
  lightningTargetsRows,
  nextEvokeChoice,
  enemyLabel,
  overflowShivCount,
  orderStartTurnScries,
  pendingTriggerAbility,
  powerAbilityKey,
  powerAbilityUsed,
  playCard,
  playCardCopy,
  playCost,
  preparePlayerTurn,
  remainingRoundHpLoss,
  previewCardChoice,
  previewCardCopyChoice,
  resolveStartPlayerTurn,
  resolveStartTurnDiscard,
  resolveStartTurnScry,
  resolveEnemyTargets,
  resolvePendingTrigger,
  spendMiracle,
  spendShiv,
  startPlayerTurn,
  startPlayerTurnWithChoices,
  startTurnAbilities,
  startTurnDiscardPreview,
  startTurnScryAbilities,
  startTurnScryPreview,
  defaultStartTurnChoices,
  validEndTurnOrder,
} from './combat.ts'
export type { CardChoicePreview, CombatPhase, CombatState, DiscardOrders, EndTurnAbility, EndTurnOrder, EvokeChoice, PendingTrigger, PendingTriggerAbility, PlayContext, PotionContext, PowerContext, RelicContext, StartTurnAbility, StartTurnChoice, StartTurnDiscardPreview, StartTurnScryAbility, StartTurnScryPreview } from './combat.ts'

export { CARD_ASSET_ROOT, cardImagePath, tierOf } from './assets.ts'

export { ENEMIES, abilityText, actionsFor, advanceCube, enemyDef, startingHp } from './enemies.ts'
export type { CubeSlot, EnemyAbility, EnemyAction, EnemyDef, EnemyPattern } from './enemies.ts'
export { enemyActingOrder, enemyTurn } from './combat.ts'

export { ACT_SHAPE, availableMoves, currentRoom, generateMap, isActComplete, moveTo } from './map.ts'
export type { MapShape, Room, RoomKind, SpireMap } from './map.ts'

export { RELICS, POTIONS, POTION_DECK, STARTING_RELIC, relicDef, potionDef } from './relics.ts'
export type { PotionDef, RelicDef, RelicTrigger } from './relics.ts'

export {
  GOLDEN_TICKET,
  canUpgradeCard,
  hasPendingRelicAcquisition,
  healingCapFor,
  MAX_HP,
  ROOM_LABEL,
  advanceAct,
  createPlayer,
  createRun,
  drawTransformReward,
  enterRoom,
  enteringRoom,
  leaveRoom,
  revealCardReward,
  revealPotionReward,
  revealRelicReward,
  pendingRelicPreview,
  pendingRelicEligibleCards,
  resolvePendingRelic,
  resolveRelicReward,
  resolveBossRelicReward,
  resolvePotionReward,
  tradePotion,
  usePotionOutsideCombat,
  resolveCardRewards,
  resolveCombat,
  roomChoices,
  wingBootChoices,
  startPendingBoss,
  switchBetweenCombatRow,
} from './run.ts'
export type { CardRewardOffer, PartyMember, PendingRelicPreview, PotionRewardDecision, RunPhase, RunState } from './run.ts'
export { resolveCampfire } from './run.ts'
export type { CampfireChoice, CampfireDecision } from './run.ts'

export { triggerMatches } from './triggers.ts'
export type { Trigger, TriggerEvent } from './triggers.ts'
