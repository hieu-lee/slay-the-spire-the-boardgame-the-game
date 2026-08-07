# Architecture

Decisions, and the reasons behind them. Most of these are lifted from `~/dune-3v3`,
which solved the same problems for a different board game; the deviations are noted.

**This describes the target design, not the current tree.** `src/multiplayer/` and
`server/` do not exist yet; they arrive with the multiplayer work. Everything else below
is either built or is a constraint the existing checks already enforce.

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

## Testing

No test framework. Each check is a standalone Node program under `scripts/verify-*.mjs`
that imports the engine directly, asserts with a sentence-long message, and exits non-zero
on failure. `pnpm verify` runs them all in parallel. Browser checks use Playwright and
assert on **game state and geometry, not pixels**; screenshots are artifacts for review.
