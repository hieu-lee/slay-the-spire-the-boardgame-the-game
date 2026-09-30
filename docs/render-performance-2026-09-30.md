# Rendering performance — September 30, 2026

## Changes

- Cache rules text and spoken descriptions by card-definition identity, matching the existing upgraded-face and keyword caches. Weak keys do not retain temporary definitions. Energy cost, selection, sockets and playability remain live inputs, not cached game state.
- Memoize assembled keyword help until its definition, attached Gem, Gem Power behavior or extra tips change.
- Skip unchanged native card faces and icon components with React's ordinary shallow-prop memoization. Image errors and other component-local state still update normally.
- Preserve the compendium grid's element identity until filtering, sorting or the upgraded face changes. Opening or closing a detail dialog no longer recreates all 583 tiles. Existing scan decoding and tooltip state remain mounted.

No artwork, resolution, CSS, shadows, animations, timing, reduced-motion settings or multiplayer protocol changes are involved.

## Measurements

Measurements used independent private Chromium contexts, the local Vite development build, and React Profiler `actualDuration`. These are rendering CPU measurements, not production FPS or measurements on physical phone hardware. Host load affects absolute timings.

| Workload | Before | After |
| --- | ---: | ---: |
| Rules and accessible names for 1,166 base/upgraded faces, 30 passes | 539 ms | 89 ms |
| Open/close card detail five times, full catalog, desktop | 483 ms mean render | 11 ms mean render |
| Open/close card detail five times, full catalog, horizontal phone layout | 513 ms mean render | 16 ms mean render |

The library measurements include scan-ready updates reported by the profiler. The substantive saving is eliminating catalog-wide work when only the selected detail changes. Representative viewports are 1440×900 and 844×390.

The serialized rules, accessible names at costs 0, 1, X and the default cost, and keyword help for every base/upgraded face have the same before/after SHA-256:

`bc63504221240a3c3923b4553b9f872bf6a42ebc44aef721072fee8b9cd40a30`

## Focused validation

- `pnpm build` and the changed light lane cover compilation and the selected architecture/presentation contracts.
- `verify-card-rendering-browser.mjs` checks repeated updates of the same mounted card: cost, upgrade, selection, playability, attached Gem, Gem Power help and icon values/sizes, in Chromium and WebKit on both supported layouts.
- `verify-compendium-browser.mjs` owns library filters, upgrades, scans, detail dialogs and desktop/horizontal-phone layout screenshots.
- `verify-card-hover-browser.mjs`, `verify-hand-readability-browser.mjs`, `verify-guardian-card-browser.mjs` and `verify-drag-card-size-browser.mjs` own hover, touch, hand presentation, socketed card play and transient drag copies.
- `verify-hermit-load-reconnect-browser.mjs` covers owner-private card choices and reconnect restoration through the online game.

The broad legacy browser umbrella is not required for these changes.
