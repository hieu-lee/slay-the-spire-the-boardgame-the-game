// A run: the campaign that strings map rooms and combats together.
//
// The combat engine knows nothing about the map, and the map knows nothing
// about combat. This module owns the seam — it builds a CombatState when the
// party enters a fighting room, and folds the result back into the run.

export type {
  CampfireChoice,
  CampfireDecision,
  CardRewardOffer,
  EncounterCard,
  EnemyDecks,
  PartyMember,
  PendingRelicPreview,
  PendingGuardianSocket,
  PotionRewardDecision,
  RewardSource,
  RunPhase,
  RunState,
} from './run/types.ts'
export {
  ASCENSION_RULES,
  GOLDEN_TICKET,
  MAX_HP,
  canUpgradeCard,
  hasPendingRelicAcquisition,
  victoryIsTerminal,
} from './run/rules.ts'
export { ROOM_LABEL, beginCatchUp, createPlayer, createRun, enteringRoom } from './run/setup.ts'
export {
  chooseNeow,
  neowEffectSelection,
  neowPreview,
  resolveNeowEffect,
  resolveNeowGold,
  resolveNeowReward,
  revealNeowReward,
} from './run/neow.ts'
export { advanceQuickSetup } from './run/quick-setup.ts'
export {
  advanceAct,
  canGiveUpRun,
  canRerollDownfallSelfBoss,
  enterRoom,
  finishRun,
  giveUpFight,
  giveUpRun,
  leaveRoom,
  resolveCombat,
  rerollDownfallSelfBoss,
  roomChoices,
  startPendingBoss,
  switchBetweenCombatRow,
  visibleMap,
  wingBootChoices,
} from './run/rooms.ts'
export {
  acquireRelic,
  cardRewardSources,
  chooseRelicReward,
  drawTransformReward,
  migrateLegacyBossRareRewards,
  neowRewardSources,
  pendingRelicEligibleCards,
  potionLimitFor,
  resolveBossRelicReward,
  resolveCardRewards,
  resolvePotionReward,
  resolveRelicReward,
  resolveTransformReward,
  revealCardReward,
  revealPotionReward,
  revealRelicReward,
  tradePotion,
  usePotionOutsideCombat,
} from './run/rewards.ts'
export {
  decideCourier,
  finishMerchant,
  purchaseAtMerchant,
  removeAtCurrentMerchant,
  revealCourier,
} from './run/merchant.ts'
export { canSkipEvent, chooseEvent, skipEvent, unavailableEventOptionIds } from './run/events.ts'
export { resolveCampfire } from './run/campfire.ts'
export { pendingRelicPreview, resolvePendingRelic } from './run/relic-acquisition.ts'
export { abandonGuardianSocket, resolveGuardianSocket } from './run/guardian-gems.ts'
export { healingCapFor } from './acquisition.ts'
