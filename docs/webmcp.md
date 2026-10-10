# WebMCP combat automation

`inspect_game`, `interact_with_game` and `get_stats` operate on the visible UI. They do not expose hidden draw order, other players' private cards, or alternative game rules.

Menu screens need no dedicated tool. The main menu's **Shop** row (and the coin purse, the first item of the top-right corner: purse, Leaderboard, Stats, Mail, Profile, Settings) opens the Shop, whose section tabs, **Buy**, **Browse cards** and confirmation buttons are ordinary labelled controls; a purchase still needs its confirmation step. See [shop.md](shop.md).

## One call for a solo action sequence

Pass `actions` instead of the single-action `controlId`. Every ID comes from one current inspection. `repeat` uses another available, identical card when the first card is consumed. An enemy's initial exact `targetLabel` binds its visible element for the entire sequence, so changing HP does not require another inspection and a dead/replaced enemy is never silently substituted.

Hand and Chamber cards have distinct `context` values. Repetition stays in that zone: it cannot replace a staged Dead On card with an identical-looking hand card.

```json
{
  "actions": [
    { "controlId": "defend-id", "repeat": 2 },
    { "controlId": "strike-id", "targetLabel": "enemy X's exact listed label" }
  ]
}
```

Mixed actions and separate targets work the same way:

```json
{
  "actions": [
    { "controlId": "energy-potion-id" },
    { "controlId": "fire-potion-id", "targetLabel": "enemy X's exact listed label" },
    { "controlId": "strike-id", "targetLabel": "enemy X's exact listed label", "repeat": 2 },
    { "controlId": "strike-id", "targetLabel": "enemy Y's exact listed label" },
    { "controlId": "defend-id" }
  ]
}
```

Limits: 1–20 entries, 1–10 repeats per entry, at most 30 expanded actions. Only visible combat card, potion, relic, ability and End turn buttons are accepted. Whole-input validation occurs before any action. Sequencing is disabled for both online multiplayer, including one-person online rooms, and local multi-character parties. It requires a settled solo player turn, not a modal choice.

The tool uses the same visible click/target paths and waits for each action to settle. It does not alter Energy costs, enemy rules, RNG, targeting, animations or automatic turn advancement. Only intermediate returned states are collapsed. A concurrent interaction is rejected; inspection during execution returns `pending` rather than reusable intermediate controls.

## Stops and partial execution

Controls with `sequenceEnd: true` must be the last entry, with no repeat. Draw potions (Swift Potion, Snecko Oil) and special-resolution potions (including Distilled Chaos, Entropic Brew and Mystery Potion) expose this flag. A misplaced terminal potion rejects the whole plan before any action: draw or random results require replanning. Deterministic Energy, Fire and Block potions can still precede other actions.

The response includes only the final state plus `sequence`:

```json
{ "sequence": { "completed": 2, "total": 4, "stopped": "target_unavailable" } }
```

Choices, explicit or automatic turn transitions, unavailable controls, dead/replaced targets, timeouts and cancellation stop the remainder. No queued action crosses a turn or combat boundary. A choice opened by a card is not cancelled by playing the next queued card.

`completed` counts settled action invocations, expanded by `repeat`; it does not claim that a card with a newly opened choice has finished resolving. `attempted`, when present, identifies the next action whose UI invocation started but whose complete outcome was not confirmed. An action can change state before cancellation. **Never replay a batch or its completed/attempted prefix.** Inspect current state and supply a new plan. There is no rollback. Selection notices and intermediate card-change announcements are preserved in the final response's `announcements`.

For a transport timeout, the whole call's outcome remains unknown. Reconnect and inspect before deciding what remains.

## Compact inspection and incremental updates

Use `inspect_game({"compact":true})` and `interact_with_game({"controlId":"…","compact":true})`. Sequences default to compact output; single interactions and inspections retain the original full format unless requested. `compact:false` requests the full format.

- Identical available controls share one record: its `id` is the first control, and `copies` contains the other valid IDs. Each copy remains individually invokable.
- Identical unavailable controls share one record with `count`. They remain planning-only and have no actionable IDs.
- Empty screen fields and observations already represented by control labels/contexts are omitted. Unique observations, descriptions, selected state, values, ranges and choices remain available.
- Grouping is page-local. Existing `nextOffset`, `snapshotId`, `textNextOffset` and truncation metadata continue to refer to the original ungrouped snapshot.

Pass the last response's `revision` as `since`, using the same compact/full format, to receive lossless changes. An unchanged state returns an empty `changes` object. Apply `removed` and `removedScreen` as well as the changes. A format switch or unavailable baseline returns a full snapshot instead of an incompatible delta. After pagination or `pending`, obtain a fresh complete baseline.

Compact deltas additionally reuse unchanged control metadata: a record such as `{"id":"new-id","ref":"old-id"}` takes its label, context, description and other semantic fields from the baseline control with that `id`. Only metadata is inherited: replace `id` and `copies` with the new record's values, treating omitted `copies` as no duplicates. References always point to the response identified by `baseRevision`, never an intermediate action. Cache the expanded final state for the next delta. This avoids retransmitting long card and relic descriptions just because snapshot IDs rotated.

Do not add an inspection after every settled interaction: its response already contains the new controls. Inspect again only for planning details, pagination, pending state, recovery or an intentionally refreshed baseline.

## Validation

`node scripts/verify-webmcp-browser.mjs` owns this contract. It compares a mixed potion/card batch with individual UI actions, checks both target identities, repeated cards, authoritative piles/RNG, compact payload size, deltas, malformed-input no-ops, deaths, choices, automatic/manual turn boundaries, concurrency, cancellation and multiplayer rejection.
