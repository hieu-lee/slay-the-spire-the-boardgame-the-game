# Slay the Spire — The Board Game

An unofficial digital implementation of Contention Games' *Slay the Spire: The Board Game*.
See [ATTRIBUTION.md](ATTRIBUTION.md) — this is a fan project and ships no artwork.

## Quick start

```bash
pnpm install
pnpm sync:assets     # fetch card art, icons and enemy portraits (see below)
pnpm dev             # play at http://localhost:5173
```

Pick a player count and a seed, then click a card and click its target. The app runs a
full combat round: play cards, end the turn, resolve the enemies, repeat.

## Assets

No artwork is committed. `pnpm sync:assets` fetches it into `public/assets/`, which is
gitignored:

| Group | Source | Needs |
| --- | --- | --- |
| Card, relic and potion scans | a third-party card browser | network, `ffmpeg`, `cwebp` |
| Keyword and token icons | the official rulebook PDF | `docs/reference/STS_KS_Rulebook.pdf`, PyMuPDF, Pillow |
| Enemy portraits | enemy card scans in the same PDF | same as icons, plus `cwebp` |

```bash
brew install ffmpeg webp          # cwebp ships in the webp formula
pip install pymupdf pillow
mkdir -p docs/reference
curl -L https://contentiongames.com/_images/STS_KS_Rulebook.pdf \
  -o docs/reference/STS_KS_Rulebook.pdf
```

On Debian or Ubuntu: `apt install ffmpeg webp`. Each sync script checks for what it
needs and tells you what is missing rather than failing halfway through.

The app runs without any of it — cards and enemies simply render without pictures.

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

## Not built yet

Online play over a `cloudflared` tunnel, voice chat, the map and campaign layer, relics,
potions and events. `src/game/state.ts` carries an up-to-date list of what the engine
does and does not yet implement.
