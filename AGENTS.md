# Project agent rules

## Supported UI screen classes

UI layout and browser screenshot coverage targets only these two screen classes:

- Desktop screens.
- Horizontal phone screens.

Do not add or retain portrait-phone, portrait-tablet, square, or arbitrary viewport-specific UI tests. A UI change is complete when it looks and works on representative desktop and horizontal-phone screens.

Before pushing `master`, require `node scripts/verify-all.mjs --changed=origin/master --lane=light --jobs=4` to pass with no retries, then wait for every GitHub `Build and test` job to finish successfully.

## Fast local verification

- Do not run `scripts/verify-browser.mjs` or the whole browser lane during normal implementation or review. That file is a legacy umbrella and is opt-in only when the user explicitly requests it.
- Start with `node scripts/verify-all.mjs --changed=HEAD --lane=light --list` and `node scripts/verify-all.mjs --changed=HEAD --lane=browser --list`, then run the light lane plus only the focused browser verifiers that own the changed behavior.
- If a regression is covered only by the legacy umbrella, extract it into a focused `verify-*-browser.mjs` script before relying on it. Focused local validation should finish in about a minute, not block iteration for 10-15 minutes.
- A baseline failure is maintenance debt: fix the product or the test, and leave a focused regression check. Do not waive it as pre-existing and do not rerun the entire umbrella merely to classify it.

## WebMCP campaign runbook

- A finished Slay the Spire run is not complete until its campaign result is explicitly recorded: after defeat, use `Record campaign result`; after victory, use `Stop and record result`.
- Verify that the new run appears on the solo leaderboard before starting another run, and update playbook immediately after every finished run.

## AI-directed playtest budgets

For requests such as "playtest this character, budget 50 runs", follow
`docs/playtesting.md` and use `scripts/playtest.mjs`. The AI chooses meaningful
decisions; do not substitute a scripted policy or label verifier runs as AI
playtests. Use the persistent JSON-lines sessions, compact deltas, and safe
action sequences. For parallel budgets, the coordinator plays worker 0 and
spawns three playtest subagents for workers 1–3, each with its own session.
Record every terminal run locally, finish the entire budget, produce the report,
and update the requested character playbook. This headless workflow does not
write to the human leaderboard. An explicit browser/WebMCP-only request takes
precedence and uses the WebMCP campaign runbook above.
