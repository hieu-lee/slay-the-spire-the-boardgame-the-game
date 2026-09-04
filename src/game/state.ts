// The engine's public surface. Everything outside src/game/ imports from here,
// so the internal module layout stays free to change.
//
// This file is re-exports only. A check in scripts/verify-architecture.mjs
// asserts every engine module is reachable from here, which is what catches a
// module that was written but never wired up.
//
// Combat and 184 enemy definitions are live. 465 character card definitions are live in all rulesets.
// Of the base game, 251 of 259 unique character cards are live as ordinary definitions; the
// other 8 are implemented Golden Ticket rewards. 38 colorless card definitions are live in all rulesets;
// all 22 of 22 colorless cards are live in the base game. Relics, potions, and their
// Ascension rules are live. Event, Merchant/Courier, Treasure, and campaign
// presentation are composed from the separate noncombat implementation.
// No scan-read cards are held back in `DEFERRED_CARDS`. Official optional run
// modes and Quick Start/Catch Up data are live; achievements are a read-only
// reference to the physical campaign sheet.
export { createRng, nextFloat, nextInt, shuffle, pick, pickMany, seedFromString } from './rng.ts'
export type { RngState } from './rng.ts'

export { CAPS, BASE_CHARACTER_IDS, CHARACTER_IDS, DOWNFALL_CHARACTER_IDS } from './types.ts'
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
  SLIME_BOSS_CARDS,
  SLIME_BOSS_CARD_COUNT,
  SLIME_BOSS_GOLDEN_TICKET,
  SLIME_BOSS_MAX_HP,
  SLIME_BOSS_PHYSICAL_DECK_COUNT,
  SLIME_BOSS_PUBLIC_VERSION,
  SLIME_BOSS_RARE_DECK,
  SLIME_BOSS_REWARD_DECK,
  SLIME_BOSS_STARTER_DECK,
  bruiserSlime,
  commandSlime,
  gainSlimeVigor,
  growSlime,
  makeSlimeBossStarterDeck,
  removeTemporarySlimeVigor,
  setupSlimeBossPlayer,
  slimeDef,
} from './downfall/slime-boss.ts'

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
  abandonHermitChamberPlay,
  abandonHermitSetupLoad,
  defaultPendingDieRelicChoice,
  abandonCardCopy,
  abandonForcedCard,
  activatePower,
  activatePotion,
  activateRelic,
  beginEndTurnResolution,
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
  endTurnResolutionAbility,
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
  playHermitChamberCard,
  resolveHermitSetupLoad,
  resolveHermitStrengthReward,
  playCost,
  preparePlayerTurn,
  preparePlayerTurnThroughDraw,
  remainingRoundHpLoss,
  previewCardChoice,
  previewCardCopyChoice,
  previewHermitChamberCardChoice,
  previewPowerChoice,
  resolveStartPlayerTurn,
  resolveStartTurnDiscard,
  resolveStartTurnScry,
  pendingTriggerSlimeEnemyChoiceCount,
  slimeCommandEnemyChoiceCount,
  resolveEnemyTargets,
  resolveEndTurnAbility,
  resolvePendingTrigger,
  resolvePendingDieRelicChoice,
  resolvePlunderRowSwitch,
  resumePlayerTurnAfterDraw,
  spendMiracle,
  spendSoulburn,
  spendShiv,
  startPlayerTurn,
  startPlayerTurnWithChoices,
  startTurnAbilities,
  startTurnDiscardPreview,
  startTurnScryAbilities,
  startTurnScryPreview,
  defaultStartTurnChoices,
  mandatoryChoicePending,
  validEndTurnOrder,
} from './combat.ts'
export type { CardChoicePreview, CombatPhase, CombatState, DiscardOrders, EndTurnAbility, EndTurnOrder, EvokeChoice, PendingTrigger, PendingTriggerAbility, PlayContext, PotionContext, PowerContext, RelicContext, StartTurnAbility, StartTurnChoice, StartTurnDiscardPreview, StartTurnScryAbility, StartTurnScryPreview } from './combat.ts'

export { CARD_ASSET_ROOT, cardImagePath, tierOf } from './assets.ts'

export { ENEMIES, abilityText, actionsFor, advanceCube, enemyDef, startingHp } from './enemies.ts'
export type { CubeSlot, EnemyAbility, EnemyAction, EnemyDef, EnemyPattern } from './enemies.ts'
export { enemyActingOrder, enemyTurn } from './combat.ts'

export { actIVMap, addBurningElite, availableMoves, currentRoom, generateMap, isActComplete, moveTo } from './map.ts'
export type { MapTokenBack, Room, RoomKind, SpireMap } from './map.ts'

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
  abandonGuardianSocket,
  beginCatchUp,
  canSkipEvent,
  unavailableEventOptionIds,
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
  giveUpRun,
  canGiveUpRun,
  canRerollDownfallSelfBoss,
  migrateLegacyBossRareRewards,
  victoryIsTerminal,
  purchaseAtMerchant,
  revealCourier,
  skipEvent,
  removeAtCurrentMerchant,
  revealCardReward,
  revealRewardItems,
  revealNeowReward,
  choosePendingRelicReward,
  pendingRelicPreview,
  pendingRelicEligibleCards,
  resolvePendingRelic,
  resolveGuardianSocket,
  resolveNeowEffect,
  resolveNeowGold,
  resolveNeowReward,
  resolveRelicReward,
  resolveBossRelicReward,
  resolveGoldReward,
  resolvePotionReward,
  resolveTransformReward,
  tradePotion,
  usePotionOutsideCombat,
  visibleMap,
  resolveCardRewards,
  resolveCombat,
  rerollDownfallSelfBoss,
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
  rulesetForCharacters,
} from './meta.ts'
export type { DailyModifier, DailyModifierId, QuickSetupState, QuickStartAct, QuickStartStep, RuleSet, RunMetaOptions, RunMetaState, RunMode } from './meta.ts'
export { ACHIEVEMENTS } from './achievements.ts'

export { triggerMatches } from './triggers.ts'
export type { Trigger, TriggerEvent } from './triggers.ts'
