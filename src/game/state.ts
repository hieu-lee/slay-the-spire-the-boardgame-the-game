// The engine's public surface. Everything outside src/game/ imports from here,
// so the internal module layout stays free to change.
//
// This file is re-exports only. A check in scripts/verify-architecture.mjs
// asserts every engine module is reachable from here, which is what catches a
// module that was written but never wired up.
//
// Not implemented yet, so that nobody mistakes silence for correctness:
//   - Powers fire on their triggers, honouring the target scope they declare,
//     and fifteen are transcribed. Printed once-per-turn Powers share a public
//     per-round use ledger.
//   - A trigger chain is cut off after 8 levels and the rest are dropped in
//     silence. No printed card chains that deep; a future one would look like
//     a Power quietly under-performing.
//   - Effects can now read the board: a clause can carry a condition, and an
//     amount can carry a bonus or a count. Fourteen questions are transcribed
//     (`Condition` in cards.ts), plus Orb, Orb-type, Block, Strength, hand and attack counts.
//     Per-Miracle counts are not there yet, nor is X-cost.
//     `CardDef.cost` accepts `'X'`, and no card uses it — which is just as
//     well, because the readers disagree about what it means: `playCard`
//     charges the player's whole energy pool, the hand always shows the card
//     as affordable, the cost badge prints "X", and a `discardTopCosts` check
//     matches it against no number at all. Spending X needs the player to
//     choose an amount and nothing collects one.
//   - Ethereal and every Curse's in-combat text are live. Parasite's removal
//     penalty and Ascender's Bane's removal protection wait on card removal,
//     which arrives with the Merchant rather than as an unreachable API.
//   - The live enemies resolve Curl Up, Spore Cloud and Enraged. Special
//     abilities on enemies not yet transcribed remain absent with those cards.
//   - There is no boss deck: a boss room stands up the toughest elite, marked
//     as a boss so it acts last. It grants no reward rather than inventing the
//     stand-in elite's reward. Elite rooms draw from a two-entry elite list.
//   - Event, treasure and merchant rooms show a placeholder screen.
//   - Relics fire on their triggers, but there is no way to GAIN one during a
//     run. Twelve potion types can be used in combat; reward draws, replacement
//     at the limit, outside-combat trading, and the other nine effects are not
//     wired yet.
//   - Card rewards can be skipped unseen or reveal three live common/uncommon
//     cards, allow one or a skip, return the rest to the bottom, and persist
//     the pick into the deck.
//     The physical reward decks are still incomplete: only transcribed cards
//     are included, Golden Tickets are absent, and rare rewards never surface.
//   - 151 of 259 unique character cards are live.
//     22 of 22 colorless cards are live. No scan-read cards are held back in `DEFERRED_CARDS`.
//     The other 108 have not been transcribed at
//     all: their names and printed costs are known from
//     `data/card-index.json` and `data/raw/player-cards.csv`, but not their
//     effects. 11 enemies of roughly 60; no events, no shops.
//   - Ascension 2's max-HP loss, Ascension 5's starter Curse, Ascension 6's Act
//     heal and Ascension 9's starting damage are applied. Ascension 4's potion
//     limit waits on potion rewards; the others wait on their elite, event,
//     merchant, boss or Act IV content.
//   - Orbs can be individually chosen and targeted for card evokes, forced
//     full-slot channels and end-of-turn resolution.
//   - On-play, on-Poison, on-Exhaust and card-effect discard abilities wait until the
//     played card has finished its printed text, as p.12 requires. Other nested
//     triggers — such as on-draw, on-Scry, on-Block and stance changes — still fire
//     during resolution. Defer those before transcribing a card whose outcome
//     depends on their timing.
//   - Miracles can be gained and spent for Energy, and Blade Dance and Cloak
//     and Dagger produce Shivs. The tokens still cannot be transferred between
//     players. `RelicInstance.spent` is declared for
//     once-per-combat relics and is never read or written either — all of these
//     are flags that read as implemented and are not.
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
  abandonForcedCard,
  activatePotion,
  beginEndPlayerTurn,
  cardEnemyChoiceCount,
  cardNeedsChoicePreview,
  cardNeedsEnemy,
  cardIsPlayable,
  cardPlayerChoiceCount,
  cardShivChoiceCount,
  cardPlayConditionMet,
  chooseEndTurnTarget,
  defaultEndTurnOrder,
  endTurnAbilities,
  endTurnChoiceId,
  endTurnChoiceTarget,
  createCombat,
  endPlayerTurn,
  livingEnemies,
  nextEvokeChoice,
  enemyLabel,
  overflowShivCount,
  playCard,
  playCost,
  preparePlayerTurn,
  previewCardChoice,
  resolveStartPlayerTurn,
  resolveEnemyTargets,
  spendMiracle,
  spendShiv,
  startPlayerTurn,
  startPlayerTurnWithChoices,
  startTurnAbilities,
  defaultStartTurnChoices,
  validEndTurnOrder,
} from './combat.ts'
export type { CardChoicePreview, CombatPhase, CombatState, DiscardOrders, EndTurnAbility, EndTurnOrder, EvokeChoice, PlayContext, PotionContext, StartTurnAbility, StartTurnChoice } from './combat.ts'

export { CARD_ASSET_ROOT, cardImagePath, tierOf } from './assets.ts'

export { ENEMIES, abilityText, actionsFor, advanceCube, enemyDef, startingHp } from './enemies.ts'
export type { CubeSlot, EnemyAbility, EnemyAction, EnemyDef, EnemyPattern } from './enemies.ts'
export { enemyActingOrder, enemyTurn } from './combat.ts'

export { ACT_SHAPE, availableMoves, currentRoom, generateMap, isActComplete, moveTo } from './map.ts'
export type { MapShape, Room, RoomKind, SpireMap } from './map.ts'

export { RELICS, POTIONS, STARTING_RELIC, relicDef, potionDef } from './relics.ts'
export type { PotionDef, RelicDef, RelicTrigger } from './relics.ts'

export {
  MAX_HP,
  ROOM_LABEL,
  advanceAct,
  createPlayer,
  createRun,
  enterRoom,
  enteringRoom,
  leaveRoom,
  revealCardReward,
  resolveCardRewards,
  resolveCombat,
  roomChoices,
} from './run.ts'
export type { CardRewardOffer, PartyMember, RunPhase, RunState } from './run.ts'
export { resolveCampfire } from './run.ts'
export type { CampfireChoice } from './run.ts'

export { triggerMatches } from './triggers.ts'
export type { Trigger, TriggerEvent } from './triggers.ts'
