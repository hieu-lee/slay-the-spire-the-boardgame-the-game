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
- For VOD visual or timing iteration, start with `node scripts/verify-run-vod-visual-browser.mjs` (layout, raster fidelity, animation clock). `node scripts/verify-run-vod-browser.mjs` checks persistence and decisions without encoding videos. Add `--export` for real encoding/download integration before delivery, not after every CSS adjustment. Benchmark full recorded runs separately from the quick visual check.
- For VOD encoding changes, use `node scripts/verify-run-vod-encoder-browser.mjs` (bounded worker concurrency and lossless pixels) and `node scripts/verify-run-vod-recorder.mjs` (fast recorder lifecycle/error checks). Use the visual verifier's optional `--benchmark` for frame timings; do not run full exports to debug a unit-level failure.
- For offline movie encoding or audio timing, use `node scripts/verify-run-vod-video-browser.mjs` (native 1080p/120 fps timestamps, timed audio, cancellation). Do not benchmark while another export/browser verifier is running, and do not edit frontend files during an export: HMR invalidates the replay iframe.
- Native VOD export streams captured frames straight into the movie encoder; the export browser verifier asserts zero temporary PNG workers/bytes. Do not restore PNG encode/write/read/decode between capture and video encoding or accumulate run-length frame buffers. Browser quota is not configurable by the app. The recorder verifier covers the bounded legacy fallback; the encoder verifier checks its lossless sparse tiles.
- VOD location rendering uses up to four isolated replay documents, split only at stable map checkpoints. Keep combat plus rewards together, bound active/encoded lookahead to eight clips, append encoded packets in run order, and mix audio once. The video verifier checks joins/timestamps/audio/cancellation; the visual verifier checks document-scoped decoder cleanup. Do not label same-origin iframe concurrency as separate renderer processes or claim speedups without a matched benchmark.

## WebMCP campaign runbook

- Start WebMCP campaigns from an explicitly attached built-in-browser game tab and use GPT-5.6 Sol or Terra; Luna has Site tools disabled. If discovery is unavailable on a supported model, stop and report the missing prerequisite instead of injecting a bridge or probing browser processes and ports.
- A finished Slay the Spire run is not complete until its campaign result is explicitly recorded: after defeat, use `Record campaign result`; after victory, use `Stop and record result`.
- Verify that the new run appears on the solo leaderboard before starting another run, and update `HEXAGHOST-PLAYBOOK.md` immediately after every finished run.
