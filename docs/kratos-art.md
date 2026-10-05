# Kratos playtest artwork

Greek-era Kratos (God of War 1–3) uses the game's painted character style:
ash-white skin, red left-side tattoo, short goatee, bronze Greek equipment and
two chained Blades of Chaos. The exact Sunburst prompts, reference paths,
source hashes and runtime hashes are in `kratos-art.json` and
`scripts/animation/sources/kratos/`. Generation used the imagegen skill's
bundled CLI with `gpt-image-2.5-sunburst`, high quality and native transparency.
Ironclad, Watcher and Hermit were supplied as style references; later keyframes
and VFX also used the approved Kratos idle drawing as their identity reference.
The lossless WebP sources retain native alpha without background removal.

The original six-pose sheet was rejected because its wide contact drawing crossed
a cell boundary and its blades changed length. Three separate wide drawings
replace that candidate. Inspect each drawing on a contrasting background for
connected shoulders, elbows, wrists, fingers, two legs, two held blades and
continuous pommel-to-bracer chains. The raised rear blade guards the windup;
the tattooed forward arm sweeps right and follows through downwards.

`registration.json` records inspected crown-to-jaw and sole landmarks. Each
drawing receives one uniform scale from its skull, then placement from its
stance center and ground anchor. Weapon width and crouched height never control
body scaling. The 800px animations have 2× transparent overscan; static art
undoes that overscan so reduced motion retains the same physical stature.
No optical-flow limbs, blended duplicate bodies or body squash are used.

Idle is an eight-frame 3200ms gentle rigid sway about the feet. Attack is a
1800ms CSS sequence of registered static drawings: canonical anticipation,
rear-blade windup at 180ms, travel beginning at 360ms, forward-blade contact
at 630ms, follow-through at 1060ms, return beginning at 1116ms and canonical
idle at 1440ms. Body scale never changes. The paired painted slash starts at
contact, with a painted impact on every authoritative target. Poses, travel
and impacts share one event clock in Chromium and WebKit. Busy renderers retain
the visible return. Traveling attacks bypass the seat filter, which otherwise
clips their bodies in WebKit. Reconnect/restoration clears the existing presentation.
Kratos's living idle also bypasses seat and image filters, preserving sharp
animated WebP rendering in WebKit at its fixed overscan scale.
Kratos remains a playtest-only character.

Native one-shot WebP/APNG attack playback was rejected after composited WebKit
recordings showed windup lagging behind target impact. Registered static pose
layers use the same CSS timing approach as Ironclad and Watcher. All four poses
and both VFX warm only when Kratos is present. A cold play snapshots readiness
and uses the loaded idle cutout for that whole timed strike; later plays use
the generated poses, avoiding mid-strike asset swaps. The exporter also saves
a standalone animated attack preview under `artifacts/kratos-art/`.

Rebuild with `python3 scripts/animation/kratos.py`, then
`python3 scripts/calibrate-hero-head.py`. The exporter writes a review gallery
to `artifacts/kratos-art/registered-keyframes.jpg`.

Focused verification: `node scripts/verify-kratos-animation-browser.mjs` checks
desktop and horizontal phone in Chromium and WebKit, using real engine card
plays for single and row targets. Add `--record` to save playback under
`artifacts/kratos-art/browser/`. It checks stature, ground placement, travel,
return, painted contact/recovery poses on repeated attacks, reduced motion and
restoration. Composited contact screenshots must contain the generated skin
mask, guarding against an invisible attacker despite correct DOM opacity.
`verify-assets.mjs` owns exported alpha, clipping, fixed canvases and planted feet. The existing Kratos verifier owns roster gating and rules.
