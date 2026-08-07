# Slay the Spire — The Board Game

A digital implementation of Contention Games' *Slay the Spire: The Board Game*, built for
3–4 player online co-op over a Cloudflare tunnel, with voice chat.

## Quick start

```bash
pnpm install
pnpm dev            # web client on :5173
```

Online play over a `cloudflared` tunnel is not wired up yet; `server/` and the launcher
script land with the multiplayer work.

## Layout

| Path | What lives there |
| --- | --- |
| `src/game/` | Pure, deterministic rules engine. No React, no DOM, no `Math.random`. |
| `src/ui/` | React client. |
| `scripts/` | `verify-*.mjs` checks. Asset pipeline and playtest harnesses land here too. |
| `docs/` | Rules reference and design decisions. |
| `data/raw/` | Community-sourced manifests of every card, item, enemy and event. |

## Verification

```bash
pnpm verify              # every scripts/verify-*.mjs
node scripts/verify-rng.mjs   # or run one directly
```

There is no test framework. Each check is a plain Node program that imports the engine
directly (Node 22 strips TypeScript types on import) and exits non-zero on failure. This
keeps the engine importable from playtests, the server, and the browser without a build
step — at the cost of requiring **erasable-only TypeScript** in `src/`: no `enum`, no
`namespace`, no constructor parameter properties.

## Determinism

Every random decision routes through the seeded RNG in `src/game/rng.ts`. A game is fully
described by `(seed, action log)`, which is what makes server-authoritative multiplayer,
reconnection, and reproducible playtests all work off the same machinery.
