# Architecture

Decisions, and the reasons behind them. Most of these are lifted from `~/dune-3v3`,
which solved the same problems for a different board game; the deviations are noted.

Most sections below describe the target architecture, not the complete current tree.
Today, the authoritative room protocol lives in `scripts/room-server.mjs` and
`scripts/lib/rooms.mjs`; the browser session and WebRTC mesh live in `src/multiplayer/`.

## Layers

```
src/game/        pure rules engine — no React, no DOM, no I/O, no Math.random
src/ui/          React client, presentational; all state comes in as props
src/multiplayer/ wire protocol + sanitization; may import src/game/, never src/ui/
server/          Node room server; owns the authoritative state
scripts/         verify-*.mjs checks, playtest harnesses, asset pipeline
```

The `src/multiplayer/` → `src/ui/` direction is forbidden so the server can import the
protocol module without dragging in JSX or stylesheets. `scripts/verify-architecture.mjs`
enforces this, plus the absence of import cycles inside `src/game/`.

## Big modules are folders behind a barrel

The engine's two largest modules are directories, not files. `src/game/combat.ts` and
`src/game/run.ts` hold nothing but re-exports; the code lives in `src/game/combat/` and
`src/game/run/`. Everything outside the engine imports the barrel, never a file inside it,
which is what lets the insides be reorganised without touching a caller.

Inside each folder the modules are grouped by depth, and the no-cycles rule above is what
keeps the grouping honest: a module imports only from groups to the left of its own, never
from its own group or the right of it.

```
combat  types | board | pieces, presentation, queries, create | effects
              | enemy-turn, items | start-turn | end-turn, play

run     types | rules, supplies, encounters | rewards, campfire
              | setup, quick-setup, neow | rooms, merchant, relic-acquisition | events
```

In combat everything above `effects` goes through it: `enemy-turn` and `items` import it,
`start-turn` imports those two, and `end-turn` and `play` import `start-turn`. In a run the
top half is a fan rather than a chain — the only imports between its last three groups are
`rooms → setup`, `merchant → quick-setup`, `relic-acquisition → neow` and `events → rooms`,
that last one because an event card can send the party into a room.

The modules nothing inside the folder imports are the ones the barrel exists to expose:
`combat/create.ts`, `combat/end-turn.ts` and `combat/play.ts`; `run/campfire.ts`,
`run/merchant.ts`, `run/relic-acquisition.ts` and `run/events.ts`.

One file resists the layering on purpose. `combat/effects.ts` holds both the effect
resolver and the trigger loop, because an effect fires triggers and a trigger applies
effects — genuine mutual recursion. Splitting them would buy two files and an import
cycle, so they stay together and the file says so at the top.

`scripts/lib/affected-verifiers.mjs` knows about the barrels: a change inside
`src/game/combat/` selects exactly the suites a change to `combat.ts` would, so
`pnpm verify:changed` does not quietly stop running the browser checks. A file nothing
imports yet still falls back to running everything.

The same shape appears in the client. `src/ui/styles.css` and `src/ui/chrome.css` are
index files of `@import`ed partials in cascade order, and `src/ui/CombatScreen.tsx` keeps
the component while its types, helpers, hooks and effect overlay live in
`src/ui/combat-screen/`.

## Engine shape

Every rules function is `(state, ...args) => GameState` — pure, returning a new object, or
**the same reference** when the action was not legal. Reference identity is the legality
signal; the server turns "unchanged" into a `409`. No reducer, no action enum, no
dispatcher: named functions are easier to test one at a time and give better stack traces.

`GameState` is one flat, JSON-serializable object. No classes, no `Map`, no `Set` — it has
to survive `JSON.stringify` on every broadcast and every save.

## Determinism

**Deviation from dune-3v3**, which calls `Math.random()` and monkey-patches it in tests.
A roguelike needs shareable, replayable seeds, so the RNG state lives *in* `GameState` and
is threaded explicitly (`src/game/rng.ts`). A run is fully described by
`(seed, action log)`. That single property gives us reproducible playtests, cheap
server-side validation, and replay-based debugging for free.

## Prompts: the pending-action queue

Slay the Spire is mostly prompts — card rewards, "discard 1", choosing a target, potions,
Neow's bonus, shops, campfire options, Bottled-X at setup. Rather than blocking, any effect
that needs a decision pushes a `PendingAction` onto a queue. One panel per prompt kind, one
resolver per prompt kind, and a scheduler small enough to read in one sitting.

## Card effects are data, not code

A card carries a typed effect spec — `{ damage: 6 }`, `{ block: 5 }`,
`{ applyPower: 'weak', amount: 1 }` — resolved by one interpreter and checked by one
validator. Several hundred cards times two upgrade states is far too many to express as
code without the bugs living in the long tail.

## One handler contract, two implementations

UI panels take a handler object described by a single interface. A local implementation
mutates React state (hotseat); a network implementation posts to the room server. Panels
are written once and work in both modes with no branching.

## Hidden information is default-deny

The server rebuilds each player's view **field by field** from an allowlist rather than
deleting secrets from a copy. A field added later is private until someone deliberately
adds it to the allowlist. The sanitizer ships with a check that injects sentinel fields
into a state and asserts they do not survive the rebuild.

In co-op the practical secrets are draw-pile order, unrevealed rewards, and undrawn enemy
intents — not player hands, which the table can freely discuss.

The act's boss is deliberately **not** one of them. Setup step 6 rolls it in the open before
anybody moves, so `actBossDefId` is rolled with the act's map and published, and the map
names it. Deciding it on arrival instead meant a party spent a whole act building a deck
against an unknown. It is drawn from a side RNG stream keyed on the run's position and the
act, so it stays deterministic without consuming the main sequence — every existing seed
deals the same cards. The Ascension 13 *second* Act III boss (`pendingBossDefId`) is a
different thing and stays hidden: it is drawn when the first boss falls, not at the table.

## Testing

No test framework. Each check is a standalone Node program under `scripts/verify-*.mjs`
that imports the engine directly, asserts with a sentence-long message, and exits non-zero
on failure. `pnpm verify` runs them all in parallel. Browser checks use Playwright and
assert on **game state and geometry, not pixels**; screenshots are artifacts for review.
