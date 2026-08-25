// The combat round: a shared Player Turn, then an Enemy Turn, repeating.
//
// Every exported function takes a state and returns a new one. An illegal
// action returns the SAME REFERENCE, which is how callers and the server tell
// "not allowed" from "allowed but nothing changed".

export { chooseEndTurnTarget, defaultEndTurnOrder, endTurnChoiceId, endTurnChoiceTarget } from './combat/types.ts'
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
  lightningRowFromTarget,
  lightningRowTarget,
  lightningTargetsRows,
  livingEnemies,
  powerAbilityKey,
  powerAbilityUsed,
  remainingRoundHpLoss,
  resolveEnemyTargets,
} from './combat/board.ts'
export {
  cardEnemyChoiceCount,
  cardIsPlayable,
  cardModeIsAvailable,
  cardNeedsChoicePreview,
  cardNeedsEnemy,
  cardPlayConditionMet,
  cardPlayerChoiceCount,
  cardShivChoiceCount,
  chosenEvokeOrbs,
  effectIsActive,
  nextEvokeChoice,
  overflowShivCount,
  playCost,
  reachedTimeWarpLimit,
} from './combat/queries.ts'
export { MAX_TRIGGER_DEPTH, evokeTargetProgress } from './combat/effects.ts'
export {
  abandonCardCopy,
  abandonForcedCard,
  activatePower,
  playCard,
  playCardCopy,
  previewCardChoice,
  previewCardCopyChoice,
} from './combat/play.ts'
export {
  defaultStartTurnChoices,
  facingChoicesAreValid,
  hasPostRollStartTurnChoice,
  orderStartTurnScries,
  preparePlayerTurn,
  resolveStartPlayerTurn,
  resolveStartTurnDiscard,
  resolveStartTurnScry,
  startPlayerTurn,
  startPlayerTurnWithChoices,
  startTurnAbilities,
  startTurnDiscardPreview,
  startTurnNeedsChoice,
  startTurnScryAbilities,
  startTurnScryPreview,
} from './combat/start-turn.ts'
export {
  REBUILT_END_TURN_ORDER,
  STALE_END_TURN_ORDER,
  beginEndPlayerTurn,
  discardNeedsChoice,
  discardOrderIsValid,
  endPlayerTurn,
  endTurnAbilities,
  pendingTriggerAbility,
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
  spendShiv,
} from './combat/items.ts'
export { createCombat } from './combat/create.ts'
