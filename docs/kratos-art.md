# Kratos playtest artwork

Greek-era Kratos uses God of War 1/2/3 equipment and the game's simplified painted
sprite style. The October 5 revision follows the user's supplied crouched pose,
broad fiery Blades of Exile, short goatee, red left-side tattoo and right-side
ram-themed Golden Fleece armor. The screenshot is supplied to Sunburst alongside
actual Ironclad and Watcher sprites. Native transparency is preserved.

The square-square-triangle combo contains ten complete drawings and eleven timed
keys, below the user's maximum of twenty. It anticipates at 120ms, casts the left
blade at 280ms, extends it at 420ms, recoils/casts the right at 650ms, extends that
at 800ms, lifts both blades at 1020ms, slams at 1280ms, retracts at 1480ms, settles
at 1710ms and returns to the exact idle drawing at 1900ms. The 2200ms CSS clock
moves the complete cutout without stretching limbs, blending duplicate bodies,
or scaling the character. Idle is eight slow rigid sway frames over 3200ms.

`registration.json` records crown/jaw, sole and stance-center landmarks. The right
arm's pauldron occludes the lower jaw in its turned pose; its projected endpoint
is registered against the neck and body proportions. Each complete drawing gets
one uniform scale, with a planted ground anchor. The 800px runtime canvas uses
2x overscan for full chain reach; reduced-motion static art reverses that overscan.
Inspect the registered gallery for connected shoulders/elbows/wrists, two hands,
two legs, two matching blades, continuous pommel-to-bracer chains and stable body
and weapon size. Rejected drafts repeated the first arm, added fingers at a flying
blade, stood too tall, or put blade tips below the ground. They are not exported.

Each target receives two light painted flame crescents and a separate heavy ground
shock. Real CSS impact onsets drive visible HP and numbers in weights 0.1/0.1/0.8,
using the same additive presentation-debt logic as Hermit. Authoritative damage,
Block, powers, relic triggers and gameplay hit counts are unchanged. Rapid card or item-granted Shiv plays
queue separate combos; a lethal target falls after the final slam. Reduced motion
settles immediately, and restoration/disconnect clears effects and pending debt.
A cold play retains the loaded idle drawing throughout the timed combo; later
plays use all registered poses. Event clocks never swap poses partway through.

Three original procedural sounds provide metallic chain swings, lighter fiery
cuts and a heavier bass/rock slam. They play from the corresponding visible CSS
beats, deduplicate simultaneous row targets and honor mute/reconnect cleanup.
Generate them with `python3 scripts/audio/generate-combat-sfx.py`; no audio is
copied from the supplied video.

Sources and exact prompts live in `scripts/animation/sources/kratos/combo/`.
`kratos-art.json` records selected/intermediate model sources, references and hashes.
Generation used the imagegen skill's bundled CLI, `gpt-image-2.5-sunburst`, high
quality and native alpha. Original `sources/kratos/idle.webp` remains the recorded
identity reference for the separately delivered card art; combat now uses `combo/`.

Rebuild with `python3 scripts/animation/kratos.py` and
`python3 scripts/calibrate-hero-head.py`. Review outputs are under
`artifacts/kratos-art/`. `verify-kratos-animation-browser.mjs` owns Chromium/WebKit
on desktop and horizontal phone, including actual engine single/row plays, weighted
HP/numbers, queued lethal combos, original sound cues, cold art, exact idle return,
reduced motion and restoration. Its screenshot skin-mask check catches invisible
WebKit cutouts. `verify-rig-animation-browser.mjs --hero=hermit --only=jaw_worm
--normal-only` covers the shared Hermit presentation regression. Asset verification
owns native alpha, clipping, canvases, planted feet and sound decoding. Kratos stays
playtest-only until separately released.

## Rage of Sparta meter

Kratos's Rage resource is shown by the God of War III Rage of Sparta glyph, drawn
in SVG by `src/ui/combat-screen/RageMeter.tsx` with styles in
`src/ui/styles/rage-meter.css`. Two capped pillars with outward barbs join a ring
broken at its foot. A heavy dark outline, a grained bronze bevel and an ember
channel give it the painted look of the other icons; molten Rage rises from the
ring up the pillars in fifths, and the count sits in the ring. A full meter burns,
gains flare and Unleash spends flash. Like the Hermit's Chamber it is a board
piece rather than a corner token: it docks beside the Energy orb in the Chamber's
place, the hand keeps its lane clear, and pressing it toggles holding Rage for
the rest of the combat. Holding sends `holdRage` with each play, makes the card
damage numbers skip Unleash, and cools the lava to iron.
`node scripts/verify-rage-meter-browser.mjs` checks it on desktop, short desktop
and horizontal phone with a full hand against four enemies.

## Power icons

The 13 Kratos Power icons (`public/assets/power-icons/kratos_*.png`) were
generated with `gpt-image-2.5-sunburst` through the imagegen bundled
`image_gen.py edit`, high quality, native transparency, using existing Power
icons as style references, then downscaled to 256px. Prompts are in
`scripts/animation/sources/kratos/icons/`; models, references and hashes are in
`docs/kratos-icons.json`.
