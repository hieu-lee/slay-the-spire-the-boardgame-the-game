# Slayer Pack — the attach and hits group notes (attach, targeting and hit modifiers)

Cards: Dropkick, Reaper, Searing Blow (Ironclad); Nightmare, Glass Knife, Endless Agony
(Silent); Pressure Points, Bowling Bash, Wave of the Hand (Watcher); Bite, Ritual Dagger
(Colorless). Every scan in the pack's published card scans (see `docs/slayer-pack.md`) was read; all eleven agree
with `docs/slayer-pack.md` (costs, types, keywords, numbers, both faces).

Verification: `scripts/verify-slayer-attach-and-hits.mjs` (engine and room server, both faces of every
card) and `scripts/verify-slayer-attach-and-hits-browser.mjs` (desktop mouse/keyboard and a 844×390
landscape phone with touch; screenshots in `artifacts/slayer-attach-and-hits/`).

## Shared machinery added

All additions sit under `// Slayer Pack` comments.

* `cards.ts`: conditions `targetVulnerable`, `notRetainedLastTurn`; counts
  `upgradedCardsInHand`, `ownWeakAndVulnerable`; effects
  `attachToTarget`, `damageAdjacent`, `upgradeThisCard`, `revealRareReward`; optional
  `hit.onKill` and `gainBlockFromLastHit.allTargets`; `CardDef.bossTargetCost` and
  `CardDef.attached` (`AttachedCardText`).
* State (all optional, absent in every existing save): `Enemy.slayerAttachments`
  (`{ card, playerId }[]`), `CombatState.pendingSlayerChoices` (`SlayerChoice[]`),
  `PlayContext.lastHitTotalDamage` / `slayerAttachedAtStart`, `CombatState.slayerKillRewards`. No existing card changes RNG use
  or serialised shape.
* `board.ts` `adjacentEnemies`; `queries.ts` `cardDefForTarget`,
  `adjacentDamageChoiceCount`, `adjacentDamageChoicesAreValid`; `play.ts`
  `resolveSlayerChoice`; `effects.ts` attach/detach/ping helpers.
* Room server (`scripts/lib/rooms.mjs`): action `resolveSlayerChoice`
  (`{ choiceId, enemyUid? }` or `{ choiceId, replace }`), choice concurrency (`choiceFields`), the mandatory-choice
  gate, disconnected-owner auto answers, and the view builder (the Ritual Dagger reveal is
  `null` for everyone but its owner). Client: `useRoomSession`/`OnlineGame` carry the field;
  `CombatScreen` renders the prompts; `EnemyCard` shows attached cards; `run-log.ts`
  validates the new fields.

## Per card

**Dropkick** — `hit` with `bonus: { plus, when: targetVulnerable }`. The bonus is part of
the hit's amount, read per struck enemy before the hit spends its Vulnerable, so "bonus
first, then double" (author FAQ). Weak attacker into Vulnerable target: neither applies,
the bonus still does (the target *has* Vulnerable). Previews use the real engine and agree.

**Reaper** — `target: 'row'` hit, then `gainBlockFromLastHit { allTargets: true }`: Block
equals the HP the hit actually took from every enemy it struck (its row and the boss).
Blocked damage and overkill do not count; Block caps at 20 through the normal funnel.

**Searing Blow** — `per: upgradedCardsInHand`, `scale: 2` (upgraded face `scale: 3`). The
count never includes the played card's own uid, which is the upgraded face's "every OTHER
upgraded card" (author FAQ) and moot for the unupgraded base face, so one count serves both.

**Glass Knife** — `bonus` on `notRetainedLastTurn` (the negation of Outmaneuver/Windmill
Strike's `retainedLastTurn`, read from the played card's `retainedLastTurn` flag). A card
drawn this turn qualifies; the real end-of-turn Retain sets the flag (tested through
`endPlayerTurn → enemyTurn → startPlayerTurn`).

**Endless Agony** — `per: ownWeakAndVulnerable` (the player's own Weak + Vulnerable, each
token +1), `toDrawTop: true`, `ethereal: true`. Played, it goes on top of the draw pile;
left in hand at end of turn it Exhausts. Weak still takes 1 off the hit as usual; a forced
"Exhaust it" (Havoc) wins over the draw-top return.

**Nightmare** — `attachToTarget` + `attached: { damageWhen: 'attackAgainstHost', amount: 1 }`.
The physical card leaves every pile and sits on the enemy (`slayerAttachments`, shown on
the enemy). "Whenever you play an Attack against the target": evaluated once per Attack
resolution, after the card's text, in `resolvePendingEnemyReactions` for every host in that
Attack's struck set (`pendingAttackTargets`, the same set Thorns/Sharp Hide use). So: one
ping per card however many hits; an AoE or multi-target Attack that includes the host
pings once; each Shiv is its own Attack and pings; Double Tap/Echo copies are separate
plays and ping; plain-damage clauses (e.g. Bowling Bash's adjacent damage) do not count as
an Attack against those enemies. Only the card's owner's Attacks count. The ping is plain
damage (blockable, unmodified), resolved after the enemy's own reactions. Only cards that
were on the struck enemy when the play began react (`PlayContext.slayerAttachedAtStart`):
a Nightmare+ that moves during a play (its host killed by the same Attack or by its own
ping) waits for the next play, whatever the board order; each copy and each Shiv is its
own play.
*Death*: the card is discarded to its owner's pile (`discardByCardEffect`, like Corpse
Explosion). **Nightmare+**: with exactly one other living enemy it moves there; with two or
more its owner chooses (`pendingSlayerChoices` `reattach`, a mandatory choice: prompt with
one button per enemy); with none it is discarded. A host that revives (Rebirth) still
"died": the card leaves it. Several attachments and different owners coexist on one enemy.
End of combat needs no cleanup: the combat's piles are discarded and the run deck is
untouched by attaching.

**Pressure Points** — same attach, `damageWhen: 'skill'` (1, upgraded 2), resolved from the
`onPlayCard` Skill trigger (after the Skill finished; copies count; its own play is excluded
because it was not attached yet; an ally's Skill does not count). `bossTargetCost: 2`:
`playCard` charges `playCost(cardDefForTarget(def, state, enemyUid))`, i.e. the printed 1
becomes 2 before every other cost rule (a free/discounted card stays free/discounted). UI:
an unaffordable Boss is not highlighted and ignores clicks/drops, the (screen-reader) prompt
states the Boss price, and with only Bosses alive the card is shown unplayable below 2
Energy. "Boss" is `Enemy.isBoss`.

**Bowling Bash** — `hit` on the target, then `damageAdjacent { amount: 2|3, targets: 2 }`:
plain damage (the scan prints the word, not the hit icon), so no Strength/Vulnerable and no
token spent. Adjacency (`adjacentEnemies`): rows are stacked in board order; a row's living
non-boss enemies lie left to right in deal order and close up when one dies; left/right are
the row neighbours, up/down the enemies at the same position in the adjacent rows; a boss
"is in every row", so it borders every enemy and every enemy borders it. The target keeps
its place while checked (neighbours still take damage after the hit killed it). With more
than 2 candidates the player picks exactly 2 distinct candidates (`PlayContext.enemyUids`,
validated in `cardResolutionChoicesAreValid`, refused otherwise); with 2 or fewer all take
it and the play names none. UI: after the target, only candidates light up and accept
clicks, prompt "choose adjacent enemy n/2". Simplification: the card's presentation event
lists only the main target, so the adjacent hits show as HP changes without a hit VFX.

**Wave of the Hand** — two `modes`: Calm or Wrath ("Enter any Stance"; Neutral is not a
Stance a card enters). Each mode: `gainMiracle 1` (shared cap 5), upgraded also
`applyWeak 1` on an enemy of the player's choice (author FAQ), then `enterStance`. Choosing
the Stance you are in is legal and ignored; leaving Calm pays 2 Energy as usual.

**Bite** — `hit { onKill: [heal 1] }`. `onKill` resolves once if this hit killed the
chosen target. *Decision*: unlike other printed clauses it resolves even when that kill
ends the combat, because the heal (and Ritual Dagger's deck change) outlast the fight;
`healingCapFor` caps it. Block that saves the enemy means no heal.

**Ritual Dagger** — `hit { onKill: [upgradeThisCard] }`: the deck card with the same uid
is upgraded at once and cleanup puts the Exhausted copy away upgraded, so it is permanent
even on the winning blow. **Ritual Dagger+** — `hit { onKill: [revealRareReward] }`: queues
`ritualDagger { cardUid, revealed: rareRewards[0] }` for the owner. The reveal is private
(room view redacts it; public log never names a bottomed card). The owner answers
`replace: false` (card to the bottom of their rare deck) or `replace: true` (the unupgraded
rare takes the dagger's uid in the Exhaust pile and in the deck, leaving the rare deck — the
run keeps it via the uid-keyed deck sync). An empty rare deck reveals nothing. If the kill
won the fight, the choice survives victory (`clearTerminalChoices` keeps it),
`resolveCombat` waits for it, the Victory banner is hidden while it is shown, and answering
does not re-fire end-of-combat triggers. A card played twice (Double Tap, Echo Form, Blasphemy, Burst,
Omniscience) earns the reward once per physical play, from whichever resolution kills first
(`CombatState.slayerKillRewards`); it is granted once the card has left play (or the fight is
over), so a Replace finds the dagger in the Exhaust pile and no second reveal can appear.
Doppelganger-style virtual copies (`…:copy`) never earn it.
"Your rare rewards" is always `player.rareRewards`, also for a Prismatic/foreign owner.
A dagger that is not a deck card (made during combat) changes only the combat piles.
Absent owner online: the reveal is bottomed (keeps the deck as it was).

## Online / multiplayer

A choice owed by a dead player (Last Stand, or a death in the Enemy Turn) never holds the
table: `settle` answers it (`resolveDeadOwnerSlayerChoices` — Nightmare+ to the first other
living enemy or discarded, the Ritual Dagger+ reveal to the bottom of the rare deck),
`mandatoryChoicePending` and `resolveCombat` ignore it, and the room settles one already in a
loaded state. Other seats see a visible "Waiting for … to resolve …" banner (below the
Victory title after a winning blow); the owner's reveal is a panel with the card at reading
size. A second pending reveal for the same owner is unreachable (a pending choice blocks
that player's plays, copies never reveal), so it has no special handling.

An owed Slayer or card-given choice (`resolveSlayerChoice`, `resolvePlayerChoice`) is answerable
whatever other window its owner has open: a Double Tap/Burst copy, a Distilled Chaos pick, a
Golden Eye Scry, a private card or Power reveal, or a forced card. The room's mandatory-choice
gate already limits the answer to its owner; the window gates (`forcedCard`, `pendingCopy`,
`pendingDistilled`, `pendingRelicScry`, the locked reveal and the staged Power reveal) exempt
those two actions, so the two sides never wait on each other. Each window stays exactly as it
was (same copy id, same offered cards, still private) and resumes after the answer; every other
action stays refused until the choice is answered.

Card plays carry their choices atomically (`enemyUid`, `enemyUids`, `mode`), so the room's
existing validation and engine refusal cover Pressure Points' price and Bowling Bash's
picks. The two follow-up decisions are mandatory choices owned by one seat; other seats keep
acting during the Player Turn (the existing foreign-choice concurrency), and a disconnected
owner's choice is answered automatically (Nightmare+ to the first other living enemy).

An end-of-turn effect (Caltrops, an Orb, Companion+) can kill a Nightmare+ host while its own
owner still has an end-of-turn ability to resolve. The owed choice holds that owner's next
effect, so `resolveSlayerChoice` (and only it) is accepted while the table is ordering
end-of-turn abilities; the room then re-publishes the same pending effect under a new public
id. Other seats' effects were never held, and an owner who leaves is answered automatically.
Covered by the `SLAYEO*` checks in `scripts/verify-slayer-attach-and-hits.mjs`.

A Mayhem-forced card can kill a Nightmare+ host or a Ritual Dagger+ target while Start of Turn is
paused (Tools of the Trade's discard, another seat's forced card). `resolveSlayerChoice` is on the
room's Start-of-Turn allowlist next to `resolvePlayerChoice`, so the owed answer is accepted, the paused
order resumes (the next seat's forced card plays), and an absent owner is answered automatically
(`SLAYMA*` checks).

Every `SlayerChoice` has a public `id` (`CombatState.nextPlayerChoiceId`, shared with
`PendingPlayerChoice`) and `resolveSlayerChoice` takes `choiceId`: an answer is accepted only for the
oldest choice and only when the id matches, so two Nightmare+ hosts dying at once (two choices for one
owner) cannot both be resolved by one double-clicked answer. The room validates the id is a whole number;
the client sends the id it renders, and disables the prompt while its answer is in flight. A state saved
before ids existed has none, and its answer then carries none (`run-log.ts` accepts an absent id but not a
negative, fractional or duplicate one). The id stays public in every seat's view (only `revealed` is
redacted). Covered by the `SLAYID1` checks in `scripts/verify-slayer-attach-and-hits.mjs`.

## Known gaps

* `scripts/verify-architecture.mjs` gained the two new conditions in its classification
  sets (`targetVulnerable` target-reading, `notRetainedLastTurn` board-reading); other groups
  adding conditions edit the same lists.
* Attached cards reuse the Corpse Explosion `.enemy__attachment` style; with several on one
  enemy they stack.
* Existing UI changed (`src/ui/styles/damage-reactions.css`, all heroes): master's
  `@media (min-width: 800px) and (max-height: 700px)` block placed the discard/exhaust pile
  group at `right: calc(var(--compact-enemy-gutter) - 9rem)` (plus a Slime-party override).
  It was left over from when End turn sat at `right: var(--compact-enemy-gutter)`; End turn
  has since moved to the top-right corner on short landscape screens, and the rule put the
  piles over the leftmost hand card (844x390, and desktop windows <= 700px tall such as
  1280x700 / 1366x680). The block is removed, so the piles use their default bottom-right
  place (`right: clamp(0.9rem, 2vw, 2rem)`), the lane the hand's 18rem right padding already
  reserves. For landscape phones narrower than 800px (568x320) `.hand-scroll` loses its extra
  10rem side gutter, because the hand's own padding already clears Energy, the draw pile and
  the piles; with it a five-card hand ran under the discard pile. Before/after screenshots:
  `artifacts/slayer-attach-and-hits/pile-placement-*.png`. A hand too long for the lane (10 cards at
  844x390) still scrolls under the piles at one end, as on master (where it was the leftmost
  cards). Checked against master with the card-trails, hand-viewport, hand-readability,
  drag-card-size, layout-reload, slime-animation and Hermit Chamber browser verifiers (the
  only failure, hand-viewport's touch-drag frame budget, fails on master too under load).
  The attach-and-hits browser verifier taps the real leftmost card and asserts no pile, Energy or End
  turn box overlaps a hand card.
