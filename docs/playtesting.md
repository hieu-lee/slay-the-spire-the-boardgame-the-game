# AI playtesting

Use this system when asked “playtest Silent, budget 50 runs.” The AI chooses every
meaningful card, target, route, reward, event, potion, and ordering decision.
Only compulsory transitions (revealing offered rewards, enemy turns, draws,
rolls, uncontested start effects, and recording terminal results) are collapsed.
There is no built-in playing policy and no OpenAI API bill from this tool.
The coordinating agent and worker agents provide the decisions through their normal tools.

## Start a budget

All development and engine execution stay in WSL. No browser, account, saved
game, live leaderboard, or campaign journal is touched. A batch plays solo
Act I through terminal Act III victory or defeat with the real game engine.
Every seed starts with independent campaign progress; marks never change the
next run's card supply. `--unlocks full` unlocks character/colorless cards;
Act IV is excluded. `--unlocks starter` uses the engine's initial campaign baseline.
Ascension is explicit, from 0 to 13 (default 0).

```sh
node --experimental-strip-types scripts/playtest.mjs init \
  --character silent --ascension 3 --runs 50 --seed 1 --workers 4 \
  --out artifacts/playtest/silent-a3-50
```

Kratos is no longer a character: he is a skin of Ironclad (presentation only, with
Ironclad's cards, relic and rules), so there is no Kratos playbook or
`--character kratos` run.

Use a task-specific output directory, and keep the same directory and engine
revision to resume. `init` refuses to change an existing batch's configuration.
The manifest records the source fingerprint, Git revision, seeds, unlocks,
budget, and worker count. Results are local ignored artifacts.

For four AIs, the coordinator owns worker 0 and delegates workers 1, 2, and 3
to three subagents. Give each agent this document, the absolute output directory,
its worker number, and the character's playbook. No worker may use another
worker's session. Worker `w` owns run indices `w, w+4, w+8, ...`; seeds cannot
collide or consume more than the requested budget. For 50 runs this assigns
13, 13, 12, and 12 runs. Agents run concurrently in separate Node processes.
The coordinator must wait for all workers to finish and reconcile its children.

## Drive a worker cheaply

A persistent JSON-lines process avoids importing the engine for every decision:

```sh
node --experimental-strip-types scripts/playtest.mjs serve \
  --out artifacts/playtest/silent-a3-50 --worker 0
```

The first stdout line is the initial prompt. Send one JSON object per line on
stdin, and receive one stdout JSON response. In Codex, retain the returned
`exec_command` session ID and send each next line with `write_stdin`. Set
`tty:true` in `exec_command` so stdin stays open. To suppress terminal input
echo, start `stty -echo && node --experimental-strip-types scripts/playtest.mjs serve ...`
in that task-owned terminal. Each agent
has its own process and session ID. Stop the process by closing its stdin or
sending Ctrl-C when the worker is done; the checkpoint is already on disk.
A new `serve` process resumes at the same decision after a disconnect.

```json
{"command":"act","revision":0,"request":"worker0-1","actions":[["resolveNeowGold",true]],"since":0}
```

- Always use the latest `revision`. Each accepted action and compulsory
  transition advances it. Stale input never plays against a newer state.
- Give each invocation a unique `request` ID. Retrying the same ID and identical
  input returns its saved receipt, never replays actions. The latest 32 receipts
  survive across runs. Older retries are rejected by their stale revision.
- Supply `since` with the previous response revision to get compact deltas.
  Apply top-level `changes`; `null` deletes a section. Merge `cardText`,
  `relicText`, `potionText`, `enemyText`, and `gemText` entries into the cached dictionaries. Those
  dictionaries only send new/changed definitions, including across new hands.
  Other changed sections replace their prior values. An unmatched baseline
  returns a full snapshot. An unchanged inspection returns `changes: {}`.
- Every action response contains the settled next prompt. Do not inspect again
  unless recovering, requesting detail, or refreshing the baseline.
- Card tuples are `[uid, definitionIdWithOptionalPlus, optionalAttachedGem, optionalInstanceMetadata]`.
  Metadata carries temporary costs, retention flags, Power counters, and other
  public instance effects. The gem slot is `null` when only metadata is present.
  Omitted ordinary player counters are zero, flags are false, and lists are empty.
  Zero-valued `nextCardCost`, `enemyNextCardCost`, and `hpLossLimitThisRound`
  remain explicit: absence means no override.
  HP, max HP, Energy, Block, and Gold are always explicit.
- `turnState` preserves public discard/stance/Power-use ledgers and played-card
  history, including after a restart. Compulsory forced cards resolve automatically
  only when the real engine proves exactly one legal outcome, and count in card statistics.
- `inspect` with `detail:true` returns your known deck, the public map, and recent
  logs. Draw order, RNG state, enemy/reward supplies, and future offers are never
  returned. All legal private reveals belong solely to this worker.
- Request `report` occasionally for compact budget progress. When `done:true`,
  this worker has recorded every assigned terminal run, including defeats.

One-shot commands use the same interface:

```sh
node --experimental-strip-types scripts/playtest.mjs inspect --out artifacts/playtest/silent-a3-50 --worker 0
node --experimental-strip-types scripts/playtest.mjs act --out artifacts/playtest/silent-a3-50 --worker 0 \
  --revision 0 --request worker0-1 --actions '[["resolveNeowGold",true]]' --since 0
```

Use structured JSON stdin for text containing shell-special characters. The
persistent process is the preferred interface for long campaigns.

## Safe sequences

```json
{"command":"act","revision":27,"request":"worker0-12","since":27,"actions":[["play","c1","e0"],["play","c2","e0"],["play","c6"]]}
```

Up to 64 explicit actions may be submitted together. The tool executes only
while the planned actions remain safe, and returns
`sequence: {completed, total, stopped}`. It stops after a draw, random result,
private reveal, pending choice, target death, turn/phase transition, or new run.
Inspect the returned prompt before replanning the unexecuted suffix. A later
illegal action preserves the accepted prefix; the error and checkpoint remain
reviewable. Never blindly replay a prefix. A request receipt resolves normal
transport retries; after a hard process crash, inspect before deciding what
remains. A sequence cannot cross into the next worker-owned run.

Cards that reveal private choices require a separate commitment:

```json
{"command":"act","revision":40,"request":"worker0-20","actions":[["reveal","c13"]]}
{"command":"act","revision":41,"request":"worker0-21","actions":[["play","c13",{"discardUids":["c2"]}]]}
```

`reveal`, `revealCopy`, `revealChamber`, and `revealPower` show the engine's
permitted preview and commit that exact card/Power. It must finish before any
other play, reveal, or end-turn operation. Revealing is not a way to scout a
draw and switch actions. Reveals always stop the current sequence.

## Actions

Each action is `[operation, ...arguments]`. The player ID `p1` is inserted by
the adapter. Long names refer to the public exports of `src/game/run.ts` and
`src/game/combat.ts`; no arbitrary code or state replacement is accepted.
Optional arguments expressed as `null` in a pending-trigger action mean unset.
All choices are checked by the real engine; an illegal action produces an
error and consumes no run budget.

| Short operation | Arguments | Meaning |
| --- | --- | --- |
| `play` | card UID, enemy UID or choice object | Play from hand |
| `copy` | choice object | Resolve pending copied/original card |
| `chamber` | card UID, enemy UID or choice object | Play pending Hermit Chamber card |
| `power` | Power UID, choice object | Activate a Power |
| `relic` | relic array index, context object | Activate a relic |
| `potion` | potion ID, context object | Use a potion |
| `room` | room ID, optional `true` for Wing Boots | Enter a route from `routes` or spend Wing Boots on `wingRoutes` |
| `neow` | blue option index | Choose Neow blessing |
| `event` | EventDecision object | Resolve an event or its staged reward |
| `reward` | choice index or `null` | Choose/skip the card reward |
| `campfire` | `{choice:"rest"}` / `{choice:"smith",cardUid:"..."}` / `{choice:"leave"}` | Campfire choice |
| `end` | optional array of ability IDs with `@target` suffixes | Start end turn with AI-selected order; required for multiple ordinary abilities |

Common additional operations:

```json
["resolveNeowGold",true]
["revealNeowReward",["ironclad","silent","defect"]]
["revealCardReward",["ironclad","silent","defect"]]
["resolveNeowReward",0]
["resolveNeowReward",{"kind":"skip"}]
["resolveNeowEffect",true,{"cardUids":["c1"]}]
["resolveGoldReward",true]
["resolvePotionReward",{"kind":"gain"}]
["resolveRelicReward",true]
["resolveBossRelicReward","relic_id"]
["chooseRelicReward",0]
["resolvePendingRelic",["c1"],[0,1,2,0]]
["resolveGuardianSocket","c17","gem_id"]
["purchaseAtMerchant",{"buyerId":"p1","section":"card","slot":0,"payments":{"p1":3}}]
["removeAtCurrentMerchant","c1",{"p1":3}]
["finishMerchant"]
["event",{"optionIds":["leave"]}]
["event",{"optionIds":["take"],"rewardIndexes":[0],"rewardItemChoices":["take"]}]
["resolveHermitSetupLoad","c1","e0"]
["resolvePendingTrigger",1,null,"e0",null]
["resolvePendingDieRelicChoice",{"choiceId":2,"discardUids":["c1"]}]
["chooseDistilledCard","c1"]
["resolveStartPlayerTurn",[{"id":"ability-id","enemyUid":"e0","shivEnemyUids":[]}]]
["orderStartTurnScries",["ability-id"]]
["resolveStartTurnScry","ability-id",["c1"]]
["resolveStartTurnDiscard","source-id","c1"]
["resolveEndTurnAbility","ability-id@target-uid"]
["end",["p1/card:c1","p1/orb:0"]]
["endPlayerTurn",{"p1":["c1","c2"]}]
["advanceAct"]
["startPendingBoss"]
```

Read the returned prompt for current IDs, targets, indices, offer kinds, and
costs; examples are shapes, not reusable IDs or prices. A `play` choice object
uses `PlayContext` in `src/game/combat/types.ts`: `enemyUid`, `enemyRow`,
`playerId`, `mode`, `energySpent`, `discardUids`, `exhaustUids`, `topdeckUids`,
`searchDrawUids`, `recoverDiscardUid(s)`, `recoverExhaustUid(s)`,
`scryDiscardUids`, `scryToHandUid`, `evokeSlots`, `evokeEnemyUids`,
`shivEnemyUids`, `loadUids`, `chamberUids`, `hermitEnemyUids`, `slimeUids`,
`slimeEnemyUids`, Guardian mode/Block/Vigor choices, and other printed choices.
Use the engine types for less common cards. Prepared event fights expose
opening Load/Scry choices before the event decision, just as the browser does.
Prismatic Shard rewards retain source selection: choose three distinct entries
from the prompt's `availableSources` before revealing. End-turn orders use
`prompts.endAbilities`. For Loop orb choices the real engine fixes their order:
use `end` without an order, then choose each displayed `endAbility` target.
An open Courier offer locks gameplay and private previews until `decideCourier`.
Acquisition choices from a Courier purchase are deferred until combat finishes;
enemy turns and compulsory draws continue normally in the meantime.

## Completion, reports, and recovery

```sh
node --experimental-strip-types scripts/playtest.mjs report --out artifacts/playtest/silent-a3-50
```

Completion requires `completed == requested`, no worker errors, and every
worker returning `done:true`. The terminal engine campaign is finalized and
saved as `run-NNNN.json` before the worker moves on. Each receipt contains
seed, action trace, final deck, campaign result, per-act metrics, and card deltas.
These local receipts are the playtest result ledger; do not publish them to the
human leaderboard or claim WebMCP leaderboard evidence.

`report.md` and `report.json` include average floors, combats/turns, damage
dealt/taken, damage actually blocked, net Block gained, per-combat rates,
Act I/II/III reach and conditional boss win rates, wins/defeats/errors, card
plays and action-level contributions, additions/removals/upgrades, final-deck
frequency, and per-run results. Acts never reached report `n/a`/`null`.
Only terminal runs enter performance denominators. Card contributions include
simultaneous triggers and are observational, not causal balance rankings.
Passive or delayed damage remains in the authoritative run/act totals.

When the budget ends, read the report, identify practical deck/decision lessons,
and update the requested character's playbook with those actual observations.
The final answer links the report and states budget, wins, average floor, and
important limits. Do not claim an AI batch from the scripted verifier.

Verify any completed action trace with `replay --out <directory> --run 25`;
it rebuilds the campaign from its seed and checks final deck, outcome, act
counters, and card deltas against the receipt without changing the batch.

The output directory is the whole checkpoint. Resume with `serve` or `inspect`
at the original source fingerprint; do not copy human browser storage. Invalid
choices preserve state and can be corrected with a new request at the returned
revision. A hard-killed writer may leave `worker-N.lock`: check its recorded PID
and remove only that lock after proving the writer has stopped. Never delete a
live worker's lock. `maxSteps` is a guard against a stuck engine, not a completion
or defeat rule; exceeding it retains the checkpoint and reports an error.

Validate this tooling with `node --experimental-strip-types scripts/verify-playtest.mjs`.
It owns safe sequences, reveals/privacy, revision and retry semantics, terminal
receipts, report denominators, all-character initialization, and a real four-process
50-run scripted integration budget. UI and multiplayer remain their existing
focused browser verifiers' responsibility.
