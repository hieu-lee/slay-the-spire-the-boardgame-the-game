# Phone combat recording findings — 2026-09-12

## Recording review

The 447.86-second phone recording was reviewed across its full duration at 4 fps, with combat excerpts checked at 10–12 fps. A transient card's native fallback face is first clear around 00:00.6–00:01.5 and recurs when cards are dragged or flown in Act I and Act II. These overlays mount a second `Card`; the visible hand scan is already available, but the duplicate asked Safari to lazy-load and asynchronously decode it.

No additional missing map, merchant, deck, or enemy assets were identified. Long static intervals on those screens are player decision time or intentional transitions.

The 6.58-second desktop recording from 09:56:49 shows an end-turn Lightning Orb resolved against the rightmost of three ordinary enemies without a visible bolt. The live event was present with the correct `orb-end-turn` source and target. Its computed image URL was `/assets/assets/combat/vfx/actions/turn-lightning-strike.webp`: the CSS custom property resolved the relative asset URL from the hashed stylesheet directory. That malformed URL returns 404 `text/html`; `/assets/combat/vfx/actions/turn-lightning-strike.webp` returns 200 `image/webp`. Reward and event backdrop variables had the same production-only URL defect.

## Result

- Transient card copies request their already-visible scan eagerly with synchronous paint preference.
- CSS-variable image URLs are made absolute before CSS consumes them, covering shared combat VFX, solo and online reward backdrops, and event art.
- End-turn lightning is rendered at combat level, from the combat ceiling through the control strip to the target's resting feet, including while the board scrolls. It reveals top-to-bottom over exactly 100 ms, then runs the impact flash.
- The existing HTML preload covers the 41,960-byte lightning sprite. The production first-use check does not add a separate decode warmup.

## Phone drag cost

An iPhone 13 landscape Chromium profile using real CDP touch measured steady-state drag frames at p95 8.6 ms and max 49.8 ms. The initial overlay render produced one 57 ms task; the same task was present with the original lazy/async image attributes, so the art fix did not introduce a synchronous stall. Removing the moving card and full-screen arrow filters did not improve p95 or maximum frame time, so those visual effects were retained. WebKit has no Playwright touch-drag API; its phone run uses the real device context and a mouse drag fallback for overlay/art checks.

## Focused validation

The hosted relative-base production build passed Chromium and WebKit on desktop and iPhone 13 landscape. Coverage includes first-use pixels, three ordinary enemies with mouse drag resolution, boss and normal targets, lethal anchoring, ceiling/foot geometry through scrolling and resizing, 50 ms partial travel and 100 ms arrival, repeated and batched Orbs, restored state, reduced motion, and computed VFX/reward/event URLs without `/assets/assets/`. The hand verifier passed the same two engines and supported screen classes; Chromium exercised real touch.
