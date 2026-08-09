// The engine's public surface. Everything outside src/game/ imports from here,
// so the internal module layout stays free to change.
//
// This file is re-exports only. A check in scripts/verify-architecture.mjs
// asserts every engine module is reachable from here, which is what catches a
// module that was written but never wired up.
//
// Not implemented yet, so that nobody mistakes silence for correctness:
//   - Powers fire on their triggers, honouring the target scope they declare,
//     but only four are transcribed (Metallicize, Demon Form, Feel No Pain,
//     Dark Embrace). "Once per turn" is not modelled, so a Power carrying that
//     clause would fire every time instead.
//   - A trigger chain is cut off after 8 levels and the rest are dropped in
//     silence. No printed card chains that deep; a future one would look like
//     a Power quietly under-performing.
//   - Effects can now read the board: a clause can carry a condition, and an
//     amount can carry a bonus or a count. Four questions are transcribed
//     (`Condition` in cards.ts) and one count, Orbs. Per-Miracle, per-card-in-
//     hand and per-Strength counts are not there yet, and neither is X-cost.
//     `CardDef.cost` accepts `'X'`, and no card uses it — which is just as
//     well, because the readers disagree about what it means: `playCard`
//     charges the player's whole energy pool, the hand always shows the card
//     as affordable, the cost badge prints "X", and a `discardTopCosts` check
//     matches it against no number at all. Spending X needs the player to
//     choose an amount and nothing collects one.
//   - Retain and Ethereal are not modelled.
//   - Enemy special abilities are stored as prose on `unimplementedAbility` and
//     do NOT resolve: Curl Up, Spore Cloud, Enraged.
//   - There is no boss deck: a boss room stands up the toughest elite, marked
//     as a boss so it acts last. Elite rooms draw from a two-entry elite list.
//   - Event, treasure and merchant rooms show a placeholder screen.
//   - Relics fire on their triggers, but there is no way to GAIN one during a
//     run, and potions have no trigger and cannot be drunk at all.
//   - There are no card reward decks. `cardRewards` and `rareRewards` are
//     declared on Player, initialised empty, and never written, so the only
//     cards that ever enter a deck are the starters. "Live" below means the
//     engine resolves the card correctly, NOT that a run can draw it; most
//     live reward cards are reachable only from verify scripts and the debug
//     bridge. A campfire can upgrade starters; nothing adds to the deck.
//   - 41 cards are live of 381. Nine more have been read off the scans and
//     are held back in `DEFERRED_CARDS`, each named with the mechanic it needs
//     — Retain, modal faces, temporary Strength, deck manipulation, an evoke
//     the UI cannot ask about, and choices that can only be made after the
//     same card reveals cards. The other ~331 have not been transcribed at
//     all: their names and printed costs are known from
//     `data/card-index.json` and `data/raw/player-cards.csv`, but not their
//     effects. 9 enemies of roughly 60; no events, no shops.
//   - Ascension modifiers other than the Act-heal are not applied.
//   - Orbs: the engine lets a player evoke ANY orb and the room layer forwards
//     the choice, but the local UI never collects it, so a client-side play
//     always evokes the first occupied slot. Nor can the two evokes of one
//     card pick different targets, which p.16 allows. End-of-turn Lightning
//     orbs are worse: `beginEndPlayerTurn` takes no orb-target context, so every one of
//     them hits the first living enemy, and p.16 says explicitly that they
//     "can each have a different target".
//   - Abilities triggered BY a card fire during its resolution rather than
//     after it, which p.12 forbids ("don't take effect until after the card is
//     finished resolving all of its text"). Only the on-play trigger is
//     correctly deferred. Nothing in the live card set can tell the difference;
//     the case that would is a Power that draws when you gain Block, played
//     alongside a card whose discard cost is sized against the hand before the
//     draw. Fix this when the cards that reach it are transcribed.
//   - Miracles can be gained but never spent, so the Watcher's own starting
//     relic hands her one every combat that she can never turn into Energy
//     (p.192). Shivs are worse off: `gainShiv` resolves, but NOTHING in the
//     game produces one — no card, relic, potion or enemy action — so a player
//     holds zero for the whole run. That is now visible rather than academic,
//     because Slice and Deflect both print "+1 if you have a shiv" and neither
//     bonus can currently fire. `RelicInstance.spent` is declared for
//     once-per-combat relics and is never read or written either — all of these
//     are flags that read as implemented and are not.
//   - There is no server yet. scripts/lib/rooms.mjs holds the co-op rules —
//     seats, reconnection, who may do what, and what each seat is allowed to
//     see — but nothing carries them over a socket, so play is local only.

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
export type { Amount, CardDef, Condition, CountOf, Effect, TargetScope } from './cards.ts'

export {
  beginEndPlayerTurn,
  cardNeedsEnemy,
  createCombat,
  endPlayerTurn,
  livingEnemies,
  enemyLabel,
  playCard,
  resolveEnemyTargets,
  startPlayerTurn,
} from './combat.ts'
export type { CombatPhase, CombatState, DiscardOrders, PlayContext } from './combat.ts'

export { CARD_ASSET_ROOT, cardImagePath, tierOf } from './assets.ts'

export { ENEMIES, actionsFor, advanceCube, enemyDef, startingHp } from './enemies.ts'
export type { CubeSlot, EnemyAction, EnemyDef, EnemyPattern } from './enemies.ts'
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
  resolveCombat,
  roomChoices,
} from './run.ts'
export type { PartyMember, RunPhase, RunState } from './run.ts'
export { resolveCampfire } from './run.ts'
export type { CampfireChoice } from './run.ts'

export { triggerMatches } from './triggers.ts'
export type { Trigger, TriggerEvent } from './triggers.ts'
