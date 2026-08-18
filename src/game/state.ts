// The engine's public surface. Everything outside src/game/ imports from here,
// so the internal module layout stays free to change.
//
// This file is re-exports only. A check in scripts/verify-architecture.mjs
// asserts every engine module is reachable from here, which is what catches a
// module that was written but never wired up.
//
// Combat and 105 enemy definitions covering roughly 60 physical cards are live.
// 251 of 259 unique character cards are live as ordinary definitions; the
// other 8 are implemented Golden Ticket rewards. 22 of 22 colorless cards are live. Relics, potions, and their
// Ascension rules are live. Event, Merchant/Courier, Treasure, and campaign
// presentation are composed from the separate noncombat implementation.
// No scan-read cards are held back in `DEFERRED_CARDS`. Official optional run
// modes and Quick Start/Catch Up data are live; achievements are a read-only
// reference to the physical campaign sheet.
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
  REBUILT_END_TURN_ORDER,
  STALE_END_TURN_ORDER,
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
  facingChoicesAreValid,
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

export { ACT_SHAPE, actIVMap, addBurningElite, availableMoves, currentRoom, generateMap, isActComplete, moveTo } from './map.ts'
export type { MapShape, Room, RoomKind, SpireMap } from './map.ts'

export { POTION_DECK, RELIC_DECK, RELICS, POTIONS, STARTING_RELIC, relicDef, potionDef } from './relics.ts'
export type { PotionDef, RelicDef, RelicTrigger } from './relics.ts'

export {
  GOLDEN_TICKET,
  canUpgradeCard,
  hasPendingRelicAcquisition,
  healingCapFor,
  MAX_HP,
  ROOM_LABEL,
  advanceAct,
  advanceQuickSetup,
  beginCatchUp,
  canSkipEvent,
  decideCourier,
  chooseEvent,
  chooseRelicReward,
  chooseNeow,
  createPlayer,
  createRun,
  drawTransformReward,
  enterRoom,
  enteringRoom,
  leaveRoom,
  finishMerchant,
  finishRun,
  giveUpFight,
  purchaseAtMerchant,
  revealCourier,
  skipEvent,
  removeAtCurrentMerchant,
  revealCardReward,
  revealPotionReward,
  revealRelicReward,
  revealNeowReward,
  pendingRelicPreview,
  pendingRelicEligibleCards,
  resolvePendingRelic,
  resolveNeowEffect,
  resolveNeowGold,
  resolveNeowReward,
  resolveRelicReward,
  resolveBossRelicReward,
  resolvePotionReward,
  resolveTransformReward,
  tradePotion,
  usePotionOutsideCombat,
  visibleMap,
  resolveCardRewards,
  resolveCombat,
  roomChoices,
  wingBootChoices,
  startPendingBoss,
  switchBetweenCombatRow,
  neowPreview,
} from './run.ts'
export type { CardRewardOffer, PartyMember, PendingRelicPreview, PotionRewardDecision, RunPhase, RunState } from './run.ts'
export { NEOW_CARDS, neowCard } from './neow.ts'
export type { NeowCard, NeowDecision, NeowEffect, NeowImmediateReward, NeowOption, NeowPlayerState, NeowRewardKind, NeowRewardOffer, NeowState } from './neow.ts'
export { resolveCampfire } from './run.ts'
export type { CampfireChoice, CampfireDecision } from './run.ts'

export { EVENT_CARDS, EVENT_DEFINITIONS, buildEventDeck } from './events.ts'
export type { EventCard, EventDefinition, EventEffect, EventOption } from './events.ts'
export type { EventDecision, EventRoomState } from './event-room.ts'
export { courierCost, merchantPurchaseCost } from './noncombat.ts'
export { merchantRemovalCost } from './acquisition.ts'
export type { CourierOffer, MerchantPurchase, MerchantState, RelicRewardState, TreasureDecision } from './noncombat.ts'
export {
  ACT_IV_UNLOCK_BOXES,
  CHARACTER_UNLOCKS,
  COLORLESS_UNLOCK,
  allocateSharedMarks,
  canEnterActIV,
  createCampaignProgress,
  finishCampaign,
  isActIVUnlocked,
  isColorlessUnlocked,
  parseCampaignProgress,
} from './campaign.ts'
export type { CampaignProgress, SpireKeys } from './campaign.ts'

export {
  DAILY_MODIFIERS,
  DAILY_MODIFIER_SECTIONS,
  QUICK_START_DIE_REWARDS,
  QUICK_START_TABLE,
  currentQuickSetupStep,
  normalizeModifierIds,
  rollDailyModifiers,
} from './meta.ts'
export type { DailyModifier, DailyModifierId, QuickSetupState, QuickStartAct, QuickStartStep, RunMetaOptions, RunMetaState, RunMode } from './meta.ts'
export { ACHIEVEMENTS } from './achievements.ts'

export { triggerMatches } from './triggers.ts'
export type { Trigger, TriggerEvent } from './triggers.ts'
