# Slay the Spire — The Board Game

An unofficial digital implementation of Contention Games' *Slay the Spire: The Board Game*.
See [ATTRIBUTION.md](ATTRIBUTION.md) for the provenance of the limited bundled artwork.

## Quick start

```bash
pnpm install
pnpm dev             # play at http://localhost:5180
```

Choose **Single Player** for a one-character run. The app handles setup, the shared die,
enemy turns, rewards, rooms, campaign progress, and Acts II–IV. Click a card and then its
target to play it.

For 2–4 friends, choose **Multiplayer**, share the room code, and play from one browser per
person. For the authoritative room server, voice chat, and Cloudflare Tunnel setup, see
[`docs/online-play.md`](docs/online-play.md).

## Assets

The repository includes optimized card, relic, and potion scans; original generated combat art
for the four characters, all 61 canonical enemy designs and stages; and 251 text-free
character-card illustrations. Every asset needed to play, including the optimized rulebook icons,
is included in a fresh clone. Eleven optional Act I reference crops are fetched by `pnpm sync:assets`.

| Group | Source | Needs |
| --- | --- | --- |
| Native character-card illustrations | original OpenAI Imagegen illustrations | committed WebP files |
| Card, relic and potion scans | a third-party card browser | committed WebP files |
| Keyword and token icons | the official rulebook PDF | committed transparent PNG files; PDF, PyMuPDF, and Pillow to refresh |
| Enemy reference crops | enemy card scans in the same PDF | optional local sync only |
| Combat stage and cutouts | original OpenAI Imagegen illustrations | 61 committed enemy WebP files |
| Combat status and Power pictograms | original OpenAI Imagegen illustrations | committed transparent PNG files |
| Title-menu and compendium backgrounds | original OpenAI Imagegen illustrations | committed WebP files |
| Kreon UI typeface | Google Fonts / Kreon Project Authors, SIL OFL 1.1 | committed TTF and license |

```bash
brew install ffmpeg webp          # cwebp ships in the webp formula
pip install pymupdf pillow
mkdir -p docs/reference
curl -L https://contentiongames.com/_images/STS_KS_Rulebook.pdf \
  -o docs/reference/STS_KS_Rulebook.pdf
```

On Debian or Ubuntu: `apt install ffmpeg webp`. Each sync script checks for what it
needs and tells you what is missing rather than failing halfway through.

Run `pnpm sync:assets` only to refresh the bundled scans and official HUD symbols or add the
eleven optional local Act I reference crops described in [ATTRIBUTION.md](ATTRIBUTION.md).

## Layout

| Path | What lives there |
| --- | --- |
| `src/game/` | Pure, deterministic rules engine. No React, no DOM, no `Math.random`. |
| `src/ui/` | React client. |
| `scripts/` | `verify-*.mjs` checks and the `sync-*.mjs` asset pipeline. |
| `docs/` | Rules reference and design decisions. |
| `data/` | Card index plus community-sourced manifests of cards, items and enemies. |

## Verification

The asset verifier requires Python 3 and Pillow for pixel-level transparency checks.

```bash
pnpm verify              # every scripts/verify-*.mjs, headless
pnpm verify:changed      # only checks affected by uncommitted files (vs HEAD)
node scripts/verify-all.mjs --changed=origin/master  # affected branch checks since a base ref
pnpm verify:browser      # drives the real app in Chromium, writes screenshots
node scripts/verify-rng.mjs   # or run one directly
```

`verify:browser` clicks real cards and asserts against engine state read through a debug
bridge, not against pixels. Screenshots land in `artifacts/browser/` for review, and the
run fails on any console error, page error or failed request.

`verify-all.mjs` runs its 3 browser suites 2 at a time by default (each boots its own Vite
and Chromium) and retries a suite that fails while contending, up to twice, before counting
it as a failure — a suite that needed a retry still gets logged as `flaked then recovered:
...` even though the run passes. If that line shows up often on your machine, pass
`--heavy=1` to fall back to running the browser suites one at a time (no contention, no
retries); `--heavy-retries=N` tunes the retry count instead, including `0` to disable it.

There is no test framework. Each check is a plain Node program that imports the engine
directly (Node 22 strips TypeScript types on import) and exits non-zero on failure. This
keeps the engine importable from playtests, the server, and the browser without a build
step — at the cost of requiring **erasable-only TypeScript** in `src/`: no `enum`, no
`namespace`, no constructor parameter properties.

## Determinism

Every random decision routes through the seeded RNG in `src/game/rng.ts`. A game is fully
described by `(seed, action log)`, which is what makes server-authoritative multiplayer,
reconnection, and reproducible playtests all work off the same machinery.

## Implemented scope

A run climbs a generated Spire map, fights through encounters, elites and a boss, and
carries HP, gold and relics between rooms. Combat covers the full round: energy, draw,
the shared die, card play with targeting and choices, orbs, stances, Scry, statuses, and
the enemy turn.

The current scope is summarized at the top of [`src/game/state.ts`](src/game/state.ts).
Executable inventory checks in [`scripts/verify-architecture.mjs`](scripts/verify-architecture.mjs)
keep its counts aligned with the physical component manifests and fail if a printed character
card is missing or the deferred-card list disagrees with the implementation.
