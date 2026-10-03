# Silent action-sequence marathon — 2026-10-03

## Delivery

Master commit `bfc42332afecc405e1b4db6cc59aea0e4d947706` is pushed. GitHub Build and test run `37105674976` completed successfully: verify, deploy-server and deploy-pages. Three independent reviewers were clean; focused WebMCP browser validation passed 12/12, the build passed, and the required changed-file light gate passed without retries. The authorized CodexAgent Chrome tab was refreshed after deployment.

The API supports solo mixed card/potion/relic sequences, repeated identical cards, distinct enemy targets, compact grouped snapshots, revision deltas and semantic control references. It retains normal UI execution, RNG and costs. Online multiplayer, even a one-person online room, and local multi-character parties reject sequencing. Swift Potion, Snecko Oil, Distilled Chaos and other random/special-resolution potions require a terminal action. Choices and automatic/manual turn boundaries stop the remainder; partial sequences are never blindly replayed. Details: `docs/webmcp.md`.

## Five-run results

One win out of five (20%). A11 cleared; A12 remains the next target. All five results were explicitly recorded and leaderboard verified before another run. Final live Silent A12 stats: four runs, zero wins, average 18 floors, zero pending classifications. Run one also has its verified CodexAgent A11 winning-deck row. Full tactical notes are in `SILENT-PLAYBOOK.md`.

| Run | Ascension | Result | Floors | Combats | WebMCP calls | Decoded output chars | Raw request + envelope token-equivalents |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | A11 | victory, Time Eater | 32 | 12 | 365 | 809,210 | 321,781 |
| 2 | A12 | defeat, Slime Boss summons | 13 | 4 | 121 | 223,140 | 92,378 |
| 3 | A12 | defeat, Collector | 23 | 9 | 206 | 435,180 | 173,310 |
| 4 | A12 | defeat, Hexaghost | 13 | 5 | 116 | 222,875 | 91,545 |
| 5 | A12 | defeat, Bronze Automaton | 23 | 7 | 197 | 448,796 | 178,923 |

The A11 victory combined Footwork, Distraction, Fumes, Wraith and Catalyst. A12 failures expose different gaps: Slime Boss wave/status dilution; Collector's delayed setup and insufficient durable Block; Hexaghost without adequate damage; Bronze Automaton's second Hyper Beam without scaling or retained protection. Run two also includes an operator error: End turn after a Scry choice had already auto-advanced. That is not a sequence-tool defect.

## What improved, and by how much

Controlled browser fixture, identical starting state and outcomes:
- Seven individual compact actions returned 10,181 characters; one seven-action sequence returned 1,188: **88.3% less output**, approximately 2,545 → 297 output token-equivalents, and seven calls → one (85.7% fewer).
- Full inspection 2,286 → compact 1,805: **21.0% less output**.
- Full compact snapshot 1,787 → compact delta 1,244: **30.4% less output**.
- Live paired same-state run-one inspection: 2,129 → 1,806 decoded characters, **15.2% reduction**. These two audit calls are excluded from run totals.

Live marathon:
- **661 confirmed sequence invocations in 251 calls**: at least **410 avoided action calls**, **62.0% fewer calls for those invocations**.
- 486 combat-category calls versus an estimated 896 with one RPC per confirmed invocation and unchanged reads/choices: **45.8% fewer combat RPCs**. This is an accounting counterfactual, not a second replayed marathon.
- Across all categories: 1005 calls versus 1415, **29.0% fewer RPCs** under the same assumption.
- Confirmed stops: 71 choice boundaries, 53 turn/choice changes and two control-metadata changes; 125 sequences completed without an explicit stop.
- One seven-action Guardian call returned a pending-only response, then inspection confirmed the next turn. Its missing completion metadata is excluded from saved-call estimates rather than guessed.

## Measurement boundaries

These are **serialized character counts and character/4 token-equivalent estimates, not exact model tokens or billing**. No per-call tokenizer/billing telemetry is available. JavaScript string lengths count UTF-16 code units, not network bytes.

Instrumentation captured every WebMCP request and returned MCP envelope throughout all five runs. Decoded output counts measure the parsed game payload; raw-envelope counts include the MCP wrapper, escaped JSON and any duplicate structured output. These are distinct from what the model actually sees. This task's rendering helper suppresses unchanged observations and, later, redundant descriptions, and sometimes emits only the last result of several internal calls. Partial `emittedChars` measurements exist for 565 responses, not the entire marathon, and are therefore not presented as complete visible-token totals. Enemy source, reasoning, shell output, historical conversation and generated text are excluded.

All five runs combined: **114,187 request characters; 3,317,559 raw returned envelope characters; 2,139,201 decoded output characters**. Decoded output is approximately **534,800 output token-equivalents**. Raw request plus envelope is approximately **857,937 token-equivalents**, not model usage.

Preflight before run one: 17 calls, 15,020 decoded output chars, excluded. Paired-inspection audit: 2 calls, 3,935 decoded output chars, also excluded.

Historical Hermit run-seven telemetry recorded 617 calls and 2,687,511 raw response characters. This Silent A11 victory recorded 365 calls and 1,243,373 raw response characters: 40.8% fewer calls and 53.7% less raw response text descriptively. **Different characters, routes, lengths and decisions prevent treating that comparison as causal token savings.** The controlled same-state fixture is the defensible direct comparison. The prior Hermit report's visible-output estimates cannot be compared directly with this report's decoded/raw payload counts.

## By category

Categories are caller-assigned work contexts, not backend room telemetry. A map-route call may return the first combat state; a combat call may end in loot. Consequently these category totals are not exactly the per-encounter totals.

| Context | Calls | Request chars | Raw envelope chars | Decoded output chars | Decoded output token-equivalents |
| --- | ---: | ---: | ---: | ---: | ---: |
| setup | 43 | 2,449 | 90,128 | 54,013 | 13,503 |
| event | 134 | 7,237 | 450,915 | 302,220 | 75,555 |
| reward | 118 | 6,697 | 346,701 | 228,886 | 57,222 |
| stats | 54 | 2,840 | 241,472 | 150,978 | 37,745 |
| map | 42 | 2,060 | 173,481 | 118,197 | 29,549 |
| combat | 486 | 85,935 | 1,486,705 | 930,583 | 232,646 |
| merchant | 47 | 2,617 | 186,767 | 124,547 | 31,137 |
| campfire | 60 | 3,276 | 283,807 | 194,287 | 48,572 |
| record | 6 | 315 | 11,120 | 7,037 | 1,759 |
| leaderboard | 15 | 761 | 46,463 | 28,453 | 7,113 |

## Per combat

Encounter IDs are chronological within each run. Counts include tagged entry calls and combat choices/pile views, but exclude reward, stats and result-recording calls. The final-state response may include loot. The 37 fights are grouped by manually maintained encounter tags; they are not backend combat IDs.

| Encounter | Calls | Sequence calls | Confirmed sequence invocations | Avoided action calls | Decoded output token-equivalents |
| --- | ---: | ---: | ---: | ---: | ---: |
| R1-C1 | 7 | 4 | 9 | 5 | 2,367 |
| R1-C2 | 14 | 8 | 14 | 6 | 4,967 |
| R1-C3 | 9 | 3 | 10 | 7 | 5,637 |
| R1-C4 | 22 | 11 | 25 | 14 | 9,252 |
| R1-C5 | 10 | 6 | 14 | 8 | 4,613 |
| R1-C6 | 17 | 10 | 19 | 9 | 8,690 |
| R1-C7 | 13 | 6 | 12 | 6 | 7,204 |
| R1-C8 | 32 | 17 | 36 | 19 | 16,952 |
| R1-C9 | 27 | 12 | 28 | 16 | 16,672 |
| R1-C10 | 17 | 8 | 16 | 8 | 9,643 |
| R1-C11 | 11 | 6 | 16 | 10 | 5,572 |
| R1-C12 | 34 | 20 | 36 | 16 | 20,844 |
| R2-C1 | 5 | 3 | 10 | 7 | 1,909 |
| R2-C2 | 8 | 5 | 15 | 10 | 2,848 |
| R2-C3 | 16 | 6 | 14 | 8 | 6,217 |
| R2-C4 | 24 | 9 | 31 | 22 | 10,965 |
| R3-C1 | 4 | 3 | 10 | 7 | 1,682 |
| R3-C2 | 6 | 5 | 18 | 13 | 3,024 |
| R3-C3 | 11 | 3 | 10 | 7 | 4,004 |
| R3-C4 | 10 | 1 | 2 | 1 | 5,040 |
| R3-C5 | 19 | 10 | 25 | 15 | 8,182 |
| R3-C6 | 11 | 3 | 9 | 6 | 6,020 |
| R3-C7 | 7 | 3 | 10 | 7 | 4,135 |
| R3-C8 | 9 | 4 | 12 | 8 | 4,525 |
| R3-C9 | 23 | 11 | 29 | 18 | 11,906 |
| R4-C1 | 7 | 5 | 16 | 11 | 2,379 |
| R4-C2 | 10 | 7 | 21 | 14 | 3,827 |
| R4-C3 | 8 | 4 | 7 | 3 | 3,164 |
| R4-C4 | 17 | 7 | 17 | 10 | 7,959 |
| R4-C5 | 15 | 8 | 19 | 11 | 6,292 |
| R5-C1 | 4 | 2 | 6 | 4 | 1,360 |
| R5-C2 | 4 | 2 | 5 | 3 | 1,659 |
| R5-C3 | 17 | 5 | 19 | 14 | 7,196 |
| R5-C4 | 12 | 7 | 21 | 14 | 7,512 |
| R5-C5 | 14 | 6 | 22 | 16 | 8,784 |
| R5-C6 | 13 | 7 | 28 | 21 | 8,110 |
| R5-C7 | 30 | 14 | 50 | 36 | 17,005 |

## Event traffic

Event groups below are reconstructed from event-category calls and visible headings. Generic selection menus stay with their preceding named event. “Event transition / unrevealed” denotes an event call that immediately returned the map without a named event screen. Card-reward/stat/shop calls remain in their own categories, so this is event-choice traffic, not the full downstream acquisition cost. Repeated names can be separate visits.

| Run | Event heading | Calls | Decoded output token-equivalents |
| --- | --- | ---: | ---: |
| 1 | Event transition / unrevealed | 4 | 2,099 |
| 1 | The Library | 2 | 560 |
| 1 | Big Fish | 4 | 1,703 |
| 1 | Wing Statue | 2 | 1,399 |
| 1 | Wheel of Change | 3 | 1,783 |
| 1 | Ominous Forge | 4 | 3,087 |
| 1 | Event transition / unrevealed | 17 | 9,461 |
| 2 | The Library | 3 | 1,716 |
| 2 | The Cleric | 2 | 1,324 |
| 2 | Event transition / unrevealed | 1 | 184 |
| 2 | Event transition / unrevealed | 2 | 1,284 |
| 2 | Event transition / unrevealed | 1 | 195 |
| 2 | Event transition / unrevealed | 2 | 1,305 |
| 2 | World of Goop | 2 | 1,344 |
| 3 | World of Goop | 2 | 1,376 |
| 3 | Scrap Ooze | 5 | 1,858 |
| 3 | Ancient Temple | 5 | 2,321 |
| 3 | Event transition / unrevealed | 1 | 230 |
| 3 | Event transition / unrevealed | 2 | 1,329 |
| 3 | Encounter! | 2 | 1,156 |
| 3 | Transmogriphier | 4 | 3,531 |
| 3 | Event transition / unrevealed | 4 | 3,685 |
| 3 | Event transition / unrevealed | 7 | 3,632 |
| 4 | Transmogriphier | 4 | 2,329 |
| 4 | Event transition / unrevealed | 1 | 184 |
| 4 | Event transition / unrevealed | 2 | 1,334 |
| 4 | Event transition / unrevealed | 1 | 236 |
| 4 | Event transition / unrevealed | 2 | 1,297 |
| 4 | The Cleric | 4 | 2,957 |
| 4 | The Library | 2 | 682 |
| 5 | Upgrade Shrine | 4 | 2,184 |
| 5 | Scrap Ooze | 4 | 1,787 |
| 5 | The Merchant | 2 | 510 |
| 5 | Event transition / unrevealed | 2 | 1,322 |
| 5 | Event transition / unrevealed | 1 | 273 |
| 5 | Event transition / unrevealed | 2 | 1,348 |
| 5 | Dead Adventurer | 3 | 1,848 |
| 5 | Event transition / unrevealed | 1 | 1,138 |
| 5 | Ancient Temple | 3 | 1,618 |
| 5 | Event transition / unrevealed | 4 | 3,322 |
| 5 | Event transition / unrevealed | 11 | 4,630 |

## Follow-up opportunities

- Stats queries now avoid natural-language parsing errors by using base card IDs such as `@cloak_and_dagger`; return only the relevant card deltas to the caller when possible.
- Draw cards intentionally end planning batches even when deterministic UI selection would technically allow further actions; replan from the new hand.
- Resolve Burst's independent targets and Survivor discards explicitly; sequence support does not guess private choices.
- Shiv overflow is a choice at the five-Shiv cap; spending Cunning before other Shiv generation avoids unnecessary overflow calls.
- A pre-existing Scrap Ooze initial Leave no-op was bypassed through the legal Reach Inside option; no unrelated gameplay fix was included in the release.
- Rich enemy and card descriptions dominate some initial snapshots. Semantic delta references reduce repeated metadata without removing planning information.

Measurement completed at 2026-10-03 08:49:16 UTC. Machine-readable aggregates and the complete per-call log: `docs/silent-webmcp-sequences-marathon-2026-10-03.metrics.json`. This report and the playbook entries are published separately from the already-pushed optimization commit.
