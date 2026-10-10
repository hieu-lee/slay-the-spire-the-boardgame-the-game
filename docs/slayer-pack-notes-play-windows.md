# The Slayer Pack — the play windows group notes ("play & draw")

Cards: Discovery, Enlightenment, Transmutation, Violence, Deep Breath, Forethought,
Secret Technique, Jack of All Trades, Smite (Colorless), Auto-Shields (Defect),
Deceive Reality (Watcher). Every scan in the pack's published card scans (see `docs/slayer-pack.md`) was read;
all eleven match `docs/slayer-pack.md` (no discrepancies). Jack of All Trades+ prints
"1 Strength **and** 1 hit" on the 5-6 row; the base row prints the Strength icon alone.

Verification: `scripts/verify-slayer-play-windows.mjs` (engine, both faces of every card, window
edge cases, two online-room checks) and `scripts/verify-slayer-play-windows-browser.mjs` (desktop
keyboard and landscape-phone touch, screenshots in `artifacts/slayer-play-windows/`).

## The card-play window (one mechanism for five cards)

Discovery, Enlightenment, Transmutation, Violence and Deceive Reality all say "play
these cards for N Energy" while the card is resolving. They share one engine concept:

* `CombatState.pendingCardPlayWindows?: CardPlayWindow[]` (`src/game/combat/types.ts`):
  `{ id, playerId, sourceCardId, cardUids, cost, plays, optional, discardRest? }`. Plain
  JSON, so it survives saves and reconnects. Windows stack per player; a player's last
  entry is the live one (`activeCardPlayWindow`, `queries.ts`). Violence played through
  Enlightenment opens on top, and Enlightenment resumes when it closes.
* Opened by the effect `openPlayWindow` (`cards: 'drawn' | 'hand' | 'attacksInHand'`,
  `cost`, `plays` (null = any number), `optional`, `discardRest`) and by `scryAndPlay`.
  `drawn` reads `PlayContext.drawnUids`, filled by the card's preceding `draw` clause.
* Played through the ordinary `playCard` (so targets, modes, choices, Retain/Exhaust,
  Power-in-play, play triggers, Double Tap/Burst copies, "cards played this turn" and
  every server validation behave as a normal play). `playCard` charges exactly the
  window cost, refuses any card the live window does not offer (that is the "you are
  still resolving the card" rule, and it stops discounted plays of other cards), and
  spends one play. Forced plays (Mayhem/Havoc/Distilled Chaos) and a mandatory Hermit
  Chamber play are not held back by a window.
* X-cost cards: author FAQ ("You have to play the X-cost card for that amount, and the X
  effect uses the same amount") — X equals the window cost: 0 through Discovery,
  Violence, Transmutation, Deceive Reality; 1 through Enlightenment. A card whose
  `minimumX` exceeds that cannot be played through the window.
* Cost is exact, not "at most": a 0-cost card played through Enlightenment costs 1 (the
  owner may finish the window first and play it normally). The window cost overrides
  every other cost rule; like Mayhem's forced plays, a window play still counts as "the
  next card" for next-card effects (Snecko Eye, Snecko confusion, free-card counters).
* Closing (`settleCardPlayWindows`, run from `settle` in `effects.ts`): offered cards that
  left hand drop out; a window closes when its plays are used, nothing it offered is in
  hand, or — for a window that must be played — none of its cards is playable
  (`cardPlayWindowCardPlayable`: Unplayable, play lock, Time Warp, X minimum, a choice
  the board can never supply). It only closes while nothing is resolving (no copy phase,
  pending trigger or Start-of-Turn work), so a card's copy finishes first.
* `finishCardPlayWindow(state, playerId, windowId)` (action `finishCardPlayWindow`
  online) ends an optional window; a stale id or a mandatory window with a playable
  card is refused (same state reference). Like other mandatory choices, a window that
  must be played and still can (`mandatoryCardPlayWindowOwners`) refuses the turn end in
  the engine (`beginEndTurnResolution`/`beginEndPlayerTurn`) and the room server; a
  disconnected owner forfeits it (`abandonCardPlayWindows`) so the party is never stuck.
  Ending the turn closes the remaining (optional) windows, and Discovery's discard of
  the unplayed offer still happens at any close; combat ending clears them.
* Hidden information: the room server sends a player only their own windows
  (`redactCombat`); offered cards are private hand cards. The public log never states
  counts ("Violence: Ann must play the offered cards for 0 Energy").
* Display: `CardInstance.playWindowCost` mirrors the live window onto the offered hand
  cards, so `playCost`, the cost in the accessible name, `canAfford`, damage previews
  and the new cost badge all read it. The engine never trusts the mark; it charges from
  the window and strips stale marks.
* UI (`CombatScreen.tsx`, `combat-screen/helpers.ts`, `Card.tsx`, `styles/hand.css`):
  offered cards get a blue outline and a window-cost badge, other cards are disabled,
  a visible banner (`prompt--status`, also for windows with no button) names the window, an optional window has a "Done with <card>" button, and
  End Turn is hidden while a window that must be played is open.

## Per card

**Discovery** (`colorless.ts`): `draw 3` + `openPlayWindow drawn, cost 0, plays 1,
mandatory, discardRest`. "Play one of these" is not optional; unplayable drawn cards are
skipped, and if none is playable the window closes at once. The remaining drawn cards
still in hand are discarded by card effect (discard reactions apply). Upgraded: no
Exhaust. Simplification: Discovery itself finishes (cleanup and its own play triggers)
before the chosen card is played, rather than holding its cleanup until after.

**Enlightenment**: `draw 1` + `openPlayWindow hand, cost 1, any number, optional`. The offer
is the hand as it stands after the draw; cards drawn while the window is open are not
offered. Energy or a Miracle (spent as usual) pays each 1. Upgraded: no Exhaust.

**Transmutation**: X cost; `draw X` (`X+1` upgraded) + `openPlayWindow drawn, cost 0, any
number, optional`. X = 0 draws nothing (one card upgraded). Exhaust on both faces.

**Violence**: `openPlayWindow attacksInHand, cost 0, any number, mandatory`. The Attacks in
hand when Violence resolves, played in the order and at the targets the player picks;
an Attack that cannot be played (e.g. Clash beside a Skill) is skipped. Upgraded: no
Exhaust.

**Deceive Reality** (`watcher.ts`): `block 1` + `scryAndPlay 3` (5 upgraded). Uses the
existing private Scry reveal (`CardChoicePreview` kind `scryToHand`, staged online
plays). The play context names the revealed card to play in `scryToHandUid`.
Playability is judged on a throwaway copy exactly as the card will be played
(`scryPlayCardPlayable`): moved to hand, the Scry's binned cards gone with their discard
reactions resolved, Deceive Reality counted. So Signature Move/Clash read the real hand
and Grand Finale reads the post-Scry draw pile. A named card must be playable under the
submitted discards; naming one is required if any reveal would be playable were it kept
instead of binned (binning cannot dodge the play, but the player is never forced to bin
cards to enable one). The UI uses the same check. The rest Scry normally (discards, Weave, onScry). The named card goes to hand
behind a one-card, 0-Energy, mandatory window and is then played with its own targets.
Simplification: it is played after the Scry finishes rather than in the middle of it.
A disconnected owner's open reveal (also a Double Tap/Burst copy's reveal) is resolved by the
room server with no discards and the first revealed card `scryPlayCardPlayable` accepts (judged
as the UI does); with none playable it is the plain Scry, so the party's End Turn is never stuck.

**Auto-Shields** (`defect.ts`, `playOnDraw`): 3 Block (4) and a Daze on top of the draw
pile. `drawInto` plays it the moment it is drawn — any draw, including the Start-of-Turn
draw; Scry/Search/recovering to hand are not draws. It is a full card play inline (cost,
cards/Skills played, next-card costs, Burst/Echo Form doubling, Corruption, exhaust-next).
Each resolution (a Burst copy, then the card) counts as its own play and fires the same
`onPlayCard` reactions as `playCard`/`playCardCopy` (on-play Powers such as Chrysalis,
Pressure Points, Enraged) right away, even when drawn in the middle of another card: it
has finished resolving. It stays inline in `drawInto` because `play.ts` sits above the draw
in the module graph. Its Daze is drawn
before the rest of that same draw: the cards the batch had already taken go back under
the Daze and are drawn again (no RNG). "If able": Player Turn only (not once the turn has
started ending), not under a play lock or the Time Warp limit, and only if its current
cost is payable. Not handled: a batch that reshuffled after Auto-Shields keeps its dealt
cards (the Daze then waits on top), since undoing a reshuffle is not possible.

**Deep Breath**: `draw 2` (3) `when: hasNoSkillsInHand` (new Condition). Deep Breath has
left the hand, so "no other Skills" is "no Skills"; Guardian's ??? cards use their mode.

**Forethought**: new effect `bottomdeck` (1, upgraded `'any'`) then `draw 1`; Exhaust on both
faces. Chosen cards travel in `PlayContext.topdeckUids` (reused) in selection order — the
last chosen ends lowest. Energy gained = the cards' cost on this board via `cardCost`
(Corruption etc. apply, turn-only discounts do not); X and Unplayable count 0; capped at 6.
Base face needs exactly one card when the hand has one; upgraded allows zero. UI: a new
`bottomdeck` hand-pick choice (pick, then "Put N on the bottom").

**Secret Technique**: existing `searchDraw 1` (private search reveal, reshuffle). Upgraded
cost 0. Combat setup: `combatSetupOnTop` — `shuffleCombatDraw` (`combat/create.ts`) sets it
aside, shuffles the rest, and puts it on top; used by `readyForCombat` and by the
start-of-combat Status reshuffle in `createCombat`. With several, they go on top in deck
order (no setup prompt exists; Bottled relics are not in this game). A deck without one
shuffles with identical RNG use.

**Jack of All Trades**: printed rows as `when: dieShows` clauses on the shared die; the
upgraded 5-6 row is one `branch` (Strength, then the hit, so the hit includes the new
Strength). Energy capped at 6. Exhaust. Known UI cost: the upgraded face always asks for
an enemy, even when the die is 1-4 (target prediction has no die).

**Smite**: new effect `takeDamage 2` (1) — blockable self-damage through `damagePlayer` —
then `hit` with Amount `per: 'currentHp'` (new CountOf), read after the self-damage
(author FAQ). Strength/Weak/Vulnerable apply to the hit. Damage previews play the real
card, so they show the post-damage HP. Taking the damage at 2 HP kills the player first.

## Files

Engine: `src/game/cards.ts` (Effect/Condition/CountOf/CardDef additions), `src/game/types.ts`
(`playWindowCost`), `src/game/combat/types.ts`, `queries.ts`, `effects.ts`, `play.ts`,
`end-turn.ts`, `pieces.ts`, `create.ts`, `src/game/run/encounters.ts`, `src/game/combat.ts`,
`src/game/state.ts`, `src/game/slayer/{colorless,defect,watcher}.ts`. Online:
`scripts/lib/rooms.mjs`, `src/multiplayer/useRoomSession.ts`. UI: `src/ui/CombatScreen.tsx`,
`src/ui/combat-screen/{helpers,types}.ts`, `src/ui/Card.tsx`, `src/ui/styles/hand.css`,
`src/ui/run-log.ts`. Tests: `scripts/verify-slayer-play-windows.mjs`, `scripts/verify-slayer-play-windows-browser.mjs`,
`scripts/verify-architecture.mjs` (condition classified).
