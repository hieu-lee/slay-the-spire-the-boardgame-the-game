# Hermit A4 marathon — 2026-10-03

## Results

Seven runs, zero Act III wins. A4 remains the climb target. Every result was explicitly recorded and independently verified in the solo leaderboard database. The latest result was recorded at Unix milliseconds `1791007555657`.

| Run | Campaign | Total floors | Ended at | Bosses defeated | Estimated visible WebMCP output tokens |
| --- | --- | ---: | --- | ---: | ---: |
| 1 | 105 | 3 | Act I Slimes | 0 | 26,598 |
| 2 | 106 | 13 | Guardian | 0 | 57,380 |
| 3 | 107 | 13 | Guardian | 0 | 56,458 |
| 4 | 108 | 19 | Act II Slavers | 1 | 91,349 |
| 5 | 109 | 11 | Burning Sentries | 0 | 16,670 |
| 6 | 110 | 23 | Bronze Automaton | 1 | 40,825 |
| 7 | 111 | 29 | Awakened One | 2 | 62,378 |

The final run beat Guardian and Bronze Automaton. Its repeatable defense was substantially better, but an opening hand without an attack or loader on the following turn let both Awakened One Cultists survive. Playing Called Shot into an empty Chamber also increased Curiosity damage without immediate benefit. Avoid Portal shortcuts without sufficient opening consistency and a defensive potion. Delay nonessential Powers until the Cultists die.

Runs one and three also suffered operator mistakes: an explicit End turn followed an automatic turn transition. A guard subsequently prevented this error. These losses are not evidence of character strength alone. No confirmed WebMCP execution defect required a production fix or push.

## Measurement methodology

These are **estimates, not exact model-token or billing counts**. The estimate is serialized text characters divided by four, rounded. No model-specific tokenizer or per-WebMCP billing attribution was available.

The complete seven-run comparison reconstructs WebMCP JSON output blocks actually emitted into the assistant transcript, starting with the seven-run request. It includes repeated snapshots and pre-run WebMCP preparation, but excludes shell output, enemy source, reasoning, tool-call JavaScript, and other conversation. Batches often return several WebMCP responses internally but emit only their final compressed snapshot: those hidden intermediate responses are not counted in this visible-output table. Categories and encounter boundaries are inferred from screen headings and combat turns, not backend telemetry. Rounded subtotals can differ by a few tokens.

Raw request/response instrumentation began during run six, after the measurement request. It captured **104 calls in the remainder of run six and 617 calls throughout run seven**. The raw counter measures the entire returned MCP JSON envelope, not the smaller snapshot shown to the model. There is no defensible full-seven-run raw-payload total; earlier hidden responses cannot be reconstructed from emitted snapshots.

| Instrumented scope | Calls | Request characters | Returned MCP JSON characters | Estimated request + response token-equivalents |
| --- | ---: | ---: | ---: | ---: |
| Run six, partial | 104 | 5,814 | 361,607 | 91,855 |
| Run seven, complete | 617 | 30,558 | 2,687,511 | 679,517 |

Thus run seven's approximately **62,400 visible output tokens** and **679,500 raw payload token-equivalents** describe different things. Neither is total model usage: input history, cached input, reasoning and generated text are not included.

## Visible output by screen category

| Category | Emitted JSON blocks | Estimated tokens |
| --- | ---: | ---: |
| Combat, including in-combat choices and pile views | 927 | 252,523 |
| Preparation / map | 92 | 29,534 |
| Events / boon / miscellaneous acquisition screens | 109 | 18,679 |
| Historical card stats | 54 | 17,109 |
| Merchant | 32 | 14,001 |
| Campfire / upgrade screens | 24 | 7,118 |
| Card reward screens | 45 | 5,952 |
| Loot / act-end / defeat summaries | 70 | 6,087 |
| Result-recording confirmation | 7 | 653 |
| **Total** | **1,360** | **351,656** |

The event bucket contains some generic early setup and relic acquisition screens; it is a screen-based grouping, not an exact count of event-room traffic. Approximately 45 detected combats averaged **5,612 visible output token-equivalents each**. Quiet batching explains why later runs have fewer visible blocks despite more underlying calls.

## Per combat

Names identify the initial enemy lineup. All numbers are estimated visible output tokens; they exclude that fight's subsequent reward screens and separate stats requests.

| Run | Encounter, in order | Estimated tokens |
| --- | --- | ---: |
| 1 | Red / Green Louse | 8,336 |
| 1 | Small / Acid / Spike Slime | 7,799 |
| 2 | Red / Green Louse | 2,825 |
| 2 | Two Fungi Beasts | 3,488 |
| 2 | Two Red Louses / Green Louse | 2,722 |
| 2 | Jaw Worm | 6,888 |
| 2 | Looter | 2,217 |
| 2 | Guardian | 18,905 |
| 3 | Cultist | 2,029 |
| 3 | Small / Acid / Spike Slime | 4,732 |
| 3 | Blue Slaver | 4,344 |
| 3 | Two Fungi Beasts | 4,948 |
| 3 | Guardian | 23,346 |
| 4 | Small / Acid Slime | 2,965 |
| 4 | Looter | 3,539 |
| 4 | Cultist / Green Louse | 3,740 |
| 4 | Two Fungi Beasts | 2,072 |
| 4 | Lagavulin | 13,808 |
| 4 | Sentries | 9,258 |
| 4 | Hexaghost | 12,632 |
| 4 | Spheric Guardian | 8,667 |
| 4 | Slavers / Taskmaster | 19,014 |
| 5 | Red / Green Louse | 1,244 |
| 5 | Two Red Louses / Green Louse | 1,770 |
| 5 | Mad / Fat / Sneaky Gremlin | 2,001 |
| 5 | Burning Sentries | 3,917 |
| 6 | Red / Green Louse | 1,947 |
| 6 | Large Slime | 2,626 |
| 6 | Red Slaver | 1,401 |
| 6 | Cultist / Green Louse | 1,573 |
| 6 | Hexaghost | 3,312 |
| 6 | Centurion / Mystic | 3,303 |
| 6 | Snecko | 3,668 |
| 6 | Slavers / Taskmaster | 5,308 |
| 6 | Bronze Automaton / Orb | 5,688 |
| 7 | Small / Acid Slime | 1,202 |
| 7 | Cultist / Spike Slime | 1,500 |
| 7 | Two Sneaky Gremlins / Fat Gremlin | 1,602 |
| 7 | Mad / Sneaky / Fat Gremlin | 1,272 |
| 7 | Guardian | 7,311 |
| 7 | Three Cultists | 4,220 |
| 7 | Chosen / Cultist | 2,815 |
| 7 | Bronze Automaton / Orb | 15,502 |
| 7 | Exploder / Repulsor / Spiker | 8,710 |
| 7 | Awakened One / two Cultists | 2,360 |

## Per event title

Only emitted event snapshots are represented. An event resolved entirely inside a quiet batch can be absent. Repeated occurrences of a title within a run are combined. Boon submenus are combined; relic choice and resolution menus are listed separately from actual event rooms.

| Run | Event or menu | Estimated tokens |
| --- | --- | ---: |
| 1 | Heart's Boon | 1,132 |
| 1 | Ancient Temple | 262 |
| 2 | Heart's Boon | 1,442 |
| 2 | Scrap Ooze | 481 |
| 2 | Encounter! | 79 |
| 2 | Relic choice | 241 |
| 2 | Dead Adventurer | 368 |
| 2 | World of Goop | 114 |
| 3 | Heart's Boon | 350 |
| 3 | Lab | 442 |
| 3 | Relic choice | 314 |
| 3 | Scrap Ooze | 304 |
| 3 | Wing Statue | 122 |
| 4 | Heart's Boon | 502 |
| 4 | Living Wall | 119 |
| 4 | Relic choice | 274 |
| 4 | Forgotten Altar | 251 |
| 4 | We Meet Again! | 237 |
| 5 | Heart's Boon | 230 |
| 5 | Bonfire Spirits | 436 |
| 5 | The Library | 97 |
| 5 | Relic choice | 250 |
| 5 | Transmogriphier | 518 |
| 5 | Ominous Forge | 358 |
| 6 | Heart's Boon | 646 |
| 6 | The Cleric | 126 |
| 6 | Wheel of Change | 263 |
| 6 | Relic choice | 284 |
| 6 | Resolve Whetstone | 164 |
| 6 | Bonfire Spirits | 548 |
| 6 | Lab | 689 |
| 6 | Cursed Tome | 135 |
| 6 | Designer In-Spire | 173 |
| 7 | Heart's Boon | 325 |
| 7 | Transmogriphier | 127 |
| 7 | Relic choice | 149 |
| 7 | World of Goop | 143 |
| 7 | Ancient Temple | 298 |
| 7 | Golden Shrine | 94 |
| 7 | Wheel of Change | 352 |
| 7 | Knowing Skull | 199 |
| 7 | Cursed Tome | 178 |
| 7 | Resolve Empty Cage | 510 |
| 7 | Tomb of Lord Red Mask | 245 |
| 7 | Secret Portal | 896 |

An additional approximately 3,215 tokens from initial mode/character setup were classified under the generic event bucket by the heading heuristic; they are not an event room and are excluded from the per-event table.

## Practical usage lessons

- Combat dominates emitted WebMCP output: approximately 72% of this reconstructed total.
- Batch independent, already-planned actions and emit the final compact state, but inspect every modal or uncertain transition. Never batch an unconditional End turn after a card that could auto-end.
- Attribute future raw measurements using a stable run/act/room identifier before the first action, rather than only the current screen heading. Modal screens and map pagination otherwise make encounter attribution ambiguous.
- Start instrumentation before run one. Preserve raw traffic and emitted-context estimates as separate metrics; do not present either as exact model billing.
