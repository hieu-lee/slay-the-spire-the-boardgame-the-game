# Slayer Pack — the discard and orbs group implementation notes

Discard-pile group: discard-pile movers, any-player effects and Orb cards — Dual Wield,
Armaments (Ironclad); Heel Hook (Silent); Rebound, Creative AI, Aggregate, Hello
World, Biased Cognition, Reboot (Defect); Master Reality, Wheel Kick (Watcher);
Magnetism (Colorless). Contract: `docs/slayer-pack.md`. Every card was checked against
the pack's published card scans (see `docs/slayer-pack.md`), and all twelve agree with the
transcription: costs, rarities, keywords and numbers on both faces.

Verification:

- `scripts/verify-slayer-discard-and-orbs.mjs` (engine, plus the authoritative room server
  through `scripts/lib/rooms.mjs`) covers both faces of all twelve cards and the
  edge cases below.
- `scripts/verify-slayer-discard-and-orbs-browser.mjs` drives every new choice on desktop
  (1440×900, mouse) and a horizontal phone (844×390, touch), locally and through
  an online room. It covers Heel Hook (choosing yourself, choosing an ally,
  Draw disabled when nothing can be drawn), Creative AI and Creative AI+,
  Master Reality+'s Retain, Magnetism+, and Aggregate's ordered Evokes.

## Shared conventions

- **Top of a discard pile** is the end of the `discard` array (`piles.ts`).
  `takeDiscardTop` (in `combat/effects.ts`) takes cards from the top, topmost
  first. The card being played is in no pile while it resolves (p.12), so Dual
  Wield and Rebound never move themselves.
- **"Any player"** means any living player, including the caster. It uses the
  existing ally target: `supportTarget: 'anyPlayer'` plus `toChosen`, the same
  as Predator. `hasInvalidChosenPlayer` rejects dead or unknown ids, and the
  room server validates the same way.
- **Pending player choices** (`CombatState.pendingPlayerChoices`, new and
  optional). This is how a card hands a decision to one player. Heel Hook's
  draw-or-discard and Magnetism's "you may return" both use it.
  - Only `choice.playerId` may answer, through
    `resolvePendingPlayerChoice(state, playerId, { choiceId, draw?, discardUid?, count? })`.
    Declining (no fields) is always legal. Stale ids, foreign answers, cards
    outside the owner's hand, and illegal counts all return the same state.
  - `mandatoryChoicePending` includes the queue, so in solo and hot-seat
    nothing else happens until the choice is answered. Other hot-seat players
    see "Waiting for X — <card>".
  - Online, the field joins the room server's per-seat `choiceFields`. During
    the simultaneous Player Turn, a seat's own actions are resolved against only its
    own choices, so other seats keep acting around an open choice. The
    `resolvePlayerChoice` action is validated by the engine.
  - Choice ids come from `CombatState.nextPlayerChoiceId` (absent until the first choice), never
    `nextTriggerId`: the public id must not reveal the masked trigger count. `SlayerChoice`
    draws its id from the same counter (`allocateChoiceId`), so the two queues never share an id.
  - The snapshot publishes to every seat who owes what (`pendingPlayerChoices`:
    owner, source card label, kind, `upTo`), so the table can see who is being
    waited on. The owner's hand and the cards they would pick stay private
    (`hand: null` for other seats).
  - A disconnected owner declines (`defaultPendingPlayerChoice`, looped in
    `settleForcedCards`).
  - The turn cannot end while a choice is open: `beginEndPlayerTurn` and `beginEndTurnResolution`
    both refuse, and the owner's End Turn is unavailable until it is answered.
    Online, the server refuses every seat's End Turn ("Wait for the … choice") while a choice is owed;
    other seats do not see the choice, so their button stays enabled and the refusal is the only signal.

## Per card

**Dual Wield** (1 / 1+: 0). Effect: `returnDiscardTop { amount 1, to 'hand', toChosen }`.
The chosen player's topmost discard goes to that same player's hand. An empty
pile is still a legal play that does nothing. Tests: own pile, ally pile,
dead target refused, empty pile, upgraded cost.

**Rebound** (1 / 1+: 0). Effects: `hit 2`, then `returnDiscardTop { to 'drawTop', toChosen }`.
The card goes onto the chosen player's draw pile as its next draw. It came off a
face-up pile, so its identity is public. The draw pile's order still reaches
only its owner, as a sorted set. Tests: engine, plus online privacy of the ally's
draw pile.

**Wheel Kick** (1; hit 2 / 3+). Effects: `hit`, then `draw 2 toChosen` (the
Predator data shape). Tests: ally draws, or self.

**Heel Hook** (1; hit 2 / 3+). Effects: `hit`, then two clauses gated on the new
condition `targetWeak`: `gainEnergy 1` for the caster, and
`drawOrDiscardChoice toChosen`. `targetWeak` reads the play's chosen enemy from
the context, like `targetDead`, and is classified in `verify-architecture`.
Interpretation decisions:

- The condition is read after the hit. Dead enemies keep their tokens in the
  engine, so killing a Weak target with the hit still pays out. This matches
  the video-game card the pack adapts.
- "May either draw or discard": the chosen player decides between drawing 1,
  discarding 1 card of their choice from their own hand, or neither.
- The discard goes through `discardByCardEffect` (a card-effect discard), so
  discard reactions and onDiscard Powers fire for the chooser.
- No choice is queued if the chosen player can do neither.
- The choice is answered after Heel Hook finishes resolving. **Simplification:**
  in the rare case where the caster chooses to draw with an empty draw pile,
  the reshuffle includes the already-discarded Heel Hook.
- Played twice (Double Tap), it queues two independent choices.

**Armaments** (1; Retain up to 2 / 3+). Effects: `retainForBlock { amount }`
(new), then `preventCardPlay` (Conclude). It adds to `retainCardsThisTurn` (the
existing discard-step Retain UI) and records `Player.retainBlockAllowance`.

- In the discard step (`endPlayerTurn`), it pays 1 Block for each optionally
  Retained card, capped at the allowance, through `grantBlock`.
- Cards with innate Retain, Meditate's guaranteed Retain, and Master Reality+'s
  own offer do not count as "Retained this way".
- Online, a disconnected seat that owes an Armaments or Master Reality+ Retain choice never holds
  the discard phase: with no connected seat owing one the turn ends at once (`settleDiscard`,
  also run when the turn end begins), and the absent seat discards its whole hand as the
  existing disconnect default (no Retain, so no Block). A connected seat's choice still waits.
  `settleDiscard` also runs after every accepted action (the `apply` wrapper), because the turn can
  land in the discard phase owing only an absent seat from the last end-of-turn effect or a trigger
  answer, not just the final vote or discard. It never advances while no seat is connected, and the
  finished step clears the per-seat discard orders (`endTurnOrders`) so nothing stale reaches the
  enemy phase. Covered by the `bothOweRetain` checks in `scripts/verify-slayer-discard-and-orbs.mjs`
  and `GDISC` in `scripts/verify-slayer-powers.mjs`.
- Order matters: `markDisconnected` and the reconnect path in `joinRoom` run `settleForcedCards` before
  `settleDiscard`, so a disconnecting Revenge Protocol owner's forced card resolves first and the turn
  then ends; the other way round leaves the room parked in `discard`. The `resolveTrigger` branch
  likewise settles disconnected end-turn effect owners after publishing the next effect. Pinned in
  `scripts/verify-rooms.mjs` (Revenge Protocol disconnect/rejoin, trigger then absent Defect Orb, and the
  start-of-turn fallback planned behind an earlier single-target ability).
- With another allowance (Well-Laid Plans), retains are credited to Armaments
  first, which is the most favourable reading at the table.
- Each card's Block icon gets Footwork's `cardBlockBonus` (it is a Skill's Block
  icon).
- The Block lasts through the Enemy Turn.
- Tests: 0..N Block, the N+1th Retain is refused, other allowances, Block soaks
  enemy damage.

**Reboot** (0, Exhaust; + Retain). Effects:

1. `discardWholeHand` (new): a card-effect discard whose reactions wait for the
   card to finish (p.12). Hermit's existing `discardHand` fires them
   immediately and is unchanged.
2. `shuffleDiscardIntoDraw` (new): one seeded shuffle of draw + discard. It sets
   `shuffledThisCombat` and queues `onShuffle`.
3. `draw 5`.

Tests: pile counts, Exhaust on both faces, Tactician fires after (so it is not
redrawn), A Thousand Cuts answers the shuffle, Reboot+ is kept at end of turn,
the shuffle is replayable.

**Aggregate** (1, Exhaust; + no Exhaust). Effect: `evokeAll { times 2 }` (new).
Every Orb leaves once, in the order the player picks, and applies its Evoke
twice. Each Lightning/Dark application picks its own target, like Dual Cast.
`effectEvokePlan`, `reachesEnemy` and `ENEMY_EFFECTS` know it, so the existing
Orb picker and the server validation work unchanged. Tests: targets per
application, a missing target is refused, no Orbs.

**Hello World** (2 / 1+). `trigger: startOfTurn`, effect: the existing
`channelDieOrb`. Its mapping (1–2 Lightning, 3–4 Frost, 5–6 Dark) matches the
scan. Start-of-Turn abilities resolve after the round's single die roll, so it
reads that roll. With full slots, the existing Start-of-Turn Evoke choice asks
which Orb makes room. Tests: all six faces on both faces, the full-slot Evoke.

Behind Mayhem (listed earlier in the power order), the planner parks Hello World's Evoke pick
until Mayhem's forced card has been played (`deferredAfterForcedCard`). If that card is
unplayable (Daze, Regret, base Companion) it is discarded at once and nothing is left to play, so
`continueStartTurn` keeps Mayhem's draw, parks the remaining abilities (`startTurnProgress.choices`,
no forced card) and asks for the pick then, exactly as after a played card, instead of rolling the
whole order back. Online that also covers a disconnected owner (the room defaults the pick). Only a
Shiv or Evoke pick that is still missing parks this way; a bad target still rolls back. Checked in
`scripts/verify-slayer-discard-and-orbs.mjs` ("Mayhem before Hello World"). A forced Electrodynamics
with full Orbs needs no planner change: its Lightning targets are rows (`row:N`) and the forced
play and the later pick both accept them.

Two start-of-turn Evokes (Hello World twice, two Storms, or Hello World with Metamorphosis) with full Orbs
can kill a Slime Boss with the first one. Its Split is pending, so the combat is not over
(`combatIsOver`) yet no enemy is left. The planner and `validStartTurnEvokeChoice` follow that rule
instead of "no living enemy": the remaining Evokes need no target (`evokeTargetless`; `null` or any uid
is accepted), the slot pick is still asked, and `defaultStartTurnChoices` and the disconnect fallback can
finish the window. Checked in `scripts/verify-start-turn-protocol.mjs` (solo defaults, online owner, absent owner).

**Biased Cognition** (2 / 1+). `resolvesOnPlay`, effects:
`gainOrbEndTurnBonus -1` and `gainOrbEvokeBonus +3` (the Defragment / Consume
machinery).

- New `orbEndTurnAmount` (`combat/board.ts`) clamps Lightning/Frost
  end-of-turn amounts at 0. Dark has no end-of-turn effect.
  `resolveOrbAtEndOfTurn` (and so Loop) deals or gains nothing at 0.
- A 0-damage Lightning asks for no target (`deterministicEndTurnTarget`).
- `TokenRow` shows the clamped value.
- Evoke +3 applies to Lightning (5), Frost (4) and Dark (3 + Powers + 3).

**Master Reality** (1). `activeAbility`, `oncePerTurn`, effect:
`returnDiscardTop { amount 1, to 'hand' }`.

- Activation is refused with an empty discard pile, so the use is not wasted.
- Author FAQ: it cannot take back end-of-turn discards. Activation is a
  Player-Turn window (`activePowerWindow`) and the discard step moves the phase
  to `enemy`.
- **Master Reality+**: "You may Retain it this turn". The returned card carries
  `mayRetainThisTurn`. The discard step then offers "Retain <card>" outside any
  allowance (`discardNeedsChoice`, `discardOrderIsValid`, the CombatScreen
  retain buttons). So the choice is made when Retain happens, not when the
  card is returned. `forgetRetain` clears the flag.

**Creative AI** (1). `activeAbility`, `oncePerTurn`, effect:
`removeOrbsForDiscardTop { anyNumber }` with `PowerContext.orbSlots`.

- Base: remove exactly one chosen Orb (removing is not Evoking), then return
  the topmost card.
- +: remove any number of Orbs, from 1 up to the cards available, and return
  that many cards, topmost first.
- Refused: no Orbs (FAQ), no card to return, empty or duplicate slots,
  non-index slots, and more Orbs than cards.
- UI: you pick on the glowing Orbs themselves. The base face removes on tap.
  The + face toggles (`aria-pressed`, green ring), and its "Return N cards"
  confirm sits in the action bar so no prompt covers the Orbs on a phone.

**Magnetism** (1). `trigger: startOfTurn`, effect: `mayReturnDiscardTop { upTo 1 / 2+ }`.

- It queues a pending choice (0..upTo topmost cards, never with an empty pile).
  `continueStartTurn` pauses the ordered Start of Turn there, and the answer
  resumes the rest of the order.
- `resolveStartPlayerTurn` refuses to skip past an open choice. CombatScreen
  hides the start-of-turn confirm while it is open.
- "Up to two from the top" means the top 1 or the top 2, never the second card
  alone.
- It counts as a pile writer for the start-turn order heuristic.
- Tests: counts on both faces, refusals, empty pile, a later ability waits,
  online owner-only and disconnect decline.

## Known limits

- When a hot-seat player owes a choice, the board must be switched to their
  seat (Settings → Seat), as for Dead or Alive.
- Heel Hook asks for its player at play time even when the target turns out
  not to be Weak (the Predator flow).
- `retainBlockAllowance` is not published to online snapshots. Nothing on the
  client needs it.
