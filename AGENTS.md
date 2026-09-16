# Project agent rules

## Supported UI screen classes

UI layout and browser screenshot coverage targets only these two screen classes:

- Desktop screens.
- Horizontal phone screens.

Do not add or retain portrait-phone, portrait-tablet, square, or arbitrary viewport-specific UI tests. A UI change is complete when it looks and works on representative desktop and horizontal-phone screens.

Before pushing `master`, require `node scripts/verify-all.mjs --changed=origin/master --jobs=4 --heavy=1` to pass with no retries, then wait for every GitHub `Build and test` job to finish successfully.

## WebMCP campaign runbook

- Start WebMCP campaigns from an explicitly attached built-in-browser game tab and use GPT-5.6 Sol or Terra; Luna has Site tools disabled. If discovery is unavailable on a supported model, stop and report the missing prerequisite instead of injecting a bridge or probing browser processes and ports.
- A finished Slay the Spire run is not complete until its campaign result is explicitly recorded: after defeat, use `Record campaign result`; after victory, use `Stop and record result`.
- Verify that the new run appears on the solo leaderboard before starting another run, and update `HEXAGHOST-PLAYBOOK.md` immediately after every finished run.
