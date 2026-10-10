// The combat round: a shared Player Turn, then an Enemy Turn, repeating.
//
// Every exported function takes a state and returns a new one. An illegal
// action returns the SAME REFERENCE, which is how callers and the server tell
// "not allowed" from "allowed but nothing changed".

export {
  chooseEndTurnTarget, defaultEndTurnOrder, endTurnChoiceId, endTurnChoiceTarget, parseSelfExhaustEndTurnTarget,
  selfExhaustEndTurnTarget,
} from './combat/types.ts'
export type {
  CardChoicePreview,
  CombatPhase,
  CombatPresentationEvent,
  CombatState,
  DiscardOrders,
  EndTurnAbility,
  EndTurnOrder,
  EvokeChoice,
  PendingTrigger,
  PendingTriggerAbility,
  PendingPlayerChoice,
  PlayerChoiceAnswer,
  PlayedCard,
  PlayContext,
  PotionContext,
  PowerContext,
  RelicContext,
  StartTurnAbility,
  StartTurnChoice,
  StartTurnDiscardPreview,
  StartTurnScryAbility,
  StartTurnScryPreview,
} from './combat/types.ts'
export {
  combatRowLabel,
  enemyLabel,
  initialEnemySlots,
  lightningRowFromTarget,
  lightningRowTarget,
  lightningTargetsRows,
  livingEnemies,
  orbEndTurnAmount,
  powerAbilityKey,
  powerAbilityUsed,
  remainingRoundHpLoss,
  resolveEnemyTargets,
} from './combat/board.ts'
export {
  cardCanBeForced,
  cardEnemyChoiceCount,
  cardHasRetain,
  cardIsPlayable,
  cardModeIsAvailable,
  cardNeedsChoicePreview,
  cardNeedsEnemy,
  cardPlayConditionMet,
  cardPlayerChoiceCount,
  cardReferencesGuardianMode,
  cardShivChoiceCount,
  chosenEvokeOrbs,
  effectIsActive,
  effectiveCombatCardDef,
  evokePlan,
  guardianPowerBeamCards,
  guardianGemForCard,
  guardianCardNeedsAlly,
  amountOf,
  activePowerWindow,
  nextEvokeChoice,
  mandatoryChoicePending,
  owedPlayerChoices,
  maximumXEnergy,
  metamorphosisCost,
  overflowShivCount,
  playCost,
  powerActivationAllowed,
  reachesEnemy,
  reachedTimeWarpLimit,
  slimeChoiceIsAvailable,
  slimeCommandEnemyChoiceLabels,
  slimeCommandEnemyChoiceCount,
} from './combat/queries.ts'
export {
  MAX_TRIGGER_DEPTH,
  evokeTargetProgress,
  pendingTriggerSlimeEnemyChoiceLabels,
  pendingTriggerSlimeEnemyChoiceCount,
} from './combat/effects.ts'
export {
  abandonHermitChamberPlay,
  abandonHermitSetupLoad,
  abandonCardCopy,
  abandonForcedCard,
  activatePower,
  playCard,
  playCardCopy,
  playHermitChamberCard,
  previewCardChoice,
  previewCardCopyChoice,
  previewHermitChamberCardChoice,
  previewPowerChoice,
  resolveDeterministicForcedCard,
  resolveHermitSetupLoad,
  resolveHermitStrengthReward,
} from './combat/play.ts'
export { previewCardDamage } from './combat/preview.ts'
export type { CardDamagePreview } from './combat/preview.ts'
export {
  defaultPendingDieRelicChoice,
  defaultStartTurnChoices,
  facingChoicesAreValid,
  hasPostRollStartTurnChoice,
  isPostRollStartTurnPotionChoice,
  isPostRollStartTurnRelicChoice,
  playerHasPostRollStartTurnChoice,
  orderStartTurnScries,
  preparePlayerTurn,
  preparePlayerTurnThroughDraw,
  resumePlayerTurnAfterDraw,
  resolvePendingDieRelicChoice,
  defaultPendingPlayerChoice,
  lapseStrandedPlayerChoices,
  resolvePendingPlayerChoice,
  resolveStartPlayerTurn,
  resolveStartTurnDiscard,
  resolveStartTurnScry,
  startPlayerTurn,
  startPlayerTurnWithChoices,
  startTurnAbilities,
  startTurnChoicePending,
  startTurnChoicePlayerIds,
  startTurnDiscardPreview,
  startTurnNeedsChoice,
  startTurnOrderChoicePlayerId,
  startTurnScryAbilities,
  startTurnScryPreview,
} from './combat/start-turn.ts'
export {
  advanceDeterministicEndTurnChoices,
  beginEndTurnResolution,
  beginEndPlayerTurn,
  discardNeedsChoice,
  discardTopNeedsChoice,
  discardOrderIsValid,
  endPlayerTurn,
  endTurnResolutionAbility,
  endTurnAbilities,
  pendingTriggerAbility,
  resolveEndTurnAbility,
  resolvePendingTrigger,
  validEndTurnOrder,
} from './combat/end-turn.ts'
export { enemyActingOrder, enemyTurn } from './combat/enemy-turn.ts'
export {
  activatePotion,
  activateRelic,
  canActivatePotion,
  canActivateRelic,
  chooseDistilledCard,
  spendMiracle,
  spendSoulburn,
  spendVigor,
  spendShiv,
  resolvePlunderRowSwitch,
} from './combat/items.ts'
export { createCombat } from './combat/create.ts'
export { scryPlayCardPlayable } from './combat/effects.ts'
export { activeCardPlayWindow, cardPlayWindowCardPlayable } from './combat/queries.ts'
export { finishCardPlayWindow } from './combat/play.ts'
export type { CardPlayWindow } from './combat/types.ts'
export { adjacentEnemies } from './combat/board.ts'
export { adjacentDamageChoiceCount, cardDefForTarget } from './combat/queries.ts'
export { resolveSlayerChoice } from './combat/play.ts'
export type { SlayerChoice } from './combat/types.ts'
