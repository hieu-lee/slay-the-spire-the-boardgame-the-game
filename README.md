# Slay the Spire — The Board Game

An unofficial digital implementation of Contention Games' *Slay the Spire: The Board Game*.
See [ATTRIBUTION.md](ATTRIBUTION.md) for the provenance of the limited bundled artwork.

## Quick start

```bash
pnpm install
pnpm sync:assets     # fetch card art, icons and enemy portraits (see below)
pnpm dev             # play at http://localhost:5180
```

Pick a player count and a seed, then click a card and click its target. The app runs a
full combat round: play cards, end the turn, resolve the enemies, repeat. After a win, each
survivor whose enemy grants a card reward may reveal three character cards and add one, or skip unseen.

For 2–4 player authoritative online co-op, voice chat, and Cloudflare Tunnel setup, see
[`docs/online-play.md`](docs/online-play.md).

## Assets

The repository includes 90 extracted enemy portraits, four generated board backgrounds,
generated combat art, and generated high-resolution, visually normalized status/Power pictograms. Card scans and
rulebook icons fetched by `pnpm sync:assets` stay gitignored;
enemy portrait refreshes update the tracked bundle and should be reviewed before committing.

| Group | Source | Needs |
| --- | --- | --- |
| Card, relic and potion scans | a third-party card browser | network, `ffmpeg`, `cwebp` |
| Keyword and token icons | the official rulebook PDF | `docs/reference/STS_KS_Rulebook.pdf`, PyMuPDF, Pillow |
| Enemy portraits | enemy card scans in the same PDF | same as icons, plus `cwebp` |
| Boss battle backgrounds | original OpenAI Imagegen illustrations | four committed WebP files |
| Combat stage and cutouts | original OpenAI Imagegen illustrations | committed WebP files |
| Combat status and Power pictograms | original OpenAI Imagegen illustrations | committed transparent PNG files |

```bash
brew install ffmpeg webp          # cwebp ships in the webp formula
pip install pymupdf pillow
mkdir -p docs/reference
curl -L https://contentiongames.com/_images/STS_KS_Rulebook.pdf \
  -o docs/reference/STS_KS_Rulebook.pdf
```

On Debian or Ubuntu: `apt install ffmpeg webp`. Each sync script checks for what it
needs and tells you what is missing rather than failing halfway through.

The app runs without synced card scans and icons; cards simply render without pictures.
Bundled enemy portraits and combat art are required and checked in every clone.

## Layout

| Path | What lives there |
| --- | --- |
| `src/game/` | Pure, deterministic rules engine. No React, no DOM, no `Math.random`. |
| `src/ui/` | React client. |
| `scripts/` | `verify-*.mjs` checks and the `sync-*.mjs` asset pipeline. |
| `docs/` | Rules reference and design decisions. |
| `data/` | Card index plus community-sourced manifests of cards, items and enemies. |

## Verification

```bash
pnpm verify              # every scripts/verify-*.mjs, headless
pnpm verify:browser      # drives the real app in Chromium, writes screenshots
node scripts/verify-rng.mjs   # or run one directly
```

`verify:browser` clicks real cards and asserts against engine state read through a debug
bridge, not against pixels. Screenshots land in `artifacts/browser/` for review, and the
run fails on any console error, page error or failed request.

There is no test framework. Each check is a plain Node program that imports the engine
directly (Node 22 strips TypeScript types on import) and exits non-zero on failure. This
keeps the engine importable from playtests, the server, and the browser without a build
step — at the cost of requiring **erasable-only TypeScript** in `src/`: no `enum`, no
`namespace`, no constructor parameter properties.

## Determinism

Every random decision routes through the seeded RNG in `src/game/rng.ts`. A game is fully
described by `(seed, action log)`, which is what makes server-authoritative multiplayer,
reconnection, and reproducible playtests all work off the same machinery.

## What works, and what does not

A run climbs a generated Spire map, fights through encounters, elites and a boss, and
carries HP, gold and relics between rooms. Combat covers the full round: energy, draw,
the shared die, card play with targeting and choices, orbs, stances, Scry, statuses, and
the enemy turn.

The authoritative list of what is **not** implemented lives at the top of
[`src/game/state.ts`](src/game/state.ts) and is kept in step with the code.

Duplicating that list here is how it goes stale, so this file does not repeat it — not
even a summary of it. The summary that used to sit here named "effects that scale off
game state" as a largest gap for two commits after it was implemented, which is exactly
the failure the list exists to prevent.
