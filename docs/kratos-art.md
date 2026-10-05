# Kratos playtest artwork

Greek Kratos uses God of War 1/2/3 equipment and the game's soft painted sprite
style. The October 5 correction supplies all four actual Ironclad, Silent, Defect
and Watcher sprites to Sunburst, replacing heavy comic outlines and dense armor
patterns with matte color planes, restrained detail and softer shading. Identity
still follows the supplied crouched Blades of Exile / Golden Fleece reference:
ash-white skin, left red tattoo, short goatee, right ram armor and red Spartan skirt.
Native transparency is preserved.

The square-square-triangle combo uses fifteen complete drawings and seventeen timed
keys, below the maximum of twenty, on a 2400ms clock: dash in, left extend, right
extend, wind up and slam, pull the blades back, dash back. Kratos dashes in from 60ms
to 300ms in the anticipation drawing. The left extend takes 150ms (blade in flight at
300ms, full reach and first hit at 375ms), then the arm under the ram pauldron takes the
right extend for another 150ms (cast at 450ms while the first blade flies home to his
rear fist, full reach and second hit at 525ms); the right-arm drawings keep a back
view rather than mirroring him. The light strikes aim slightly down to belt height, so
they meet short creatures. The windup and slam take 1.2s: at 600ms he yanks the second
blade back while the first is still in his rear fist (the right-pull drawing), at 700ms
both fists rise and the blades lift above his head, at 820ms he holds the backswing
with both blades behind him on taut chains, as in the user's sketch, at 1060ms they
pass back over his head, at 1120ms they whip forward and at 1250ms they bite into the ground ahead along
the chain line, tips on the line of his soles; the impact holds until 1800ms. The
retract takes 200ms: he yanks the blades out of the ground on taut chains at 1800ms and
reels them in toward his fists at 1900ms. He catches both in front of him at 2000ms,
dashes back to 2280ms through the catch and settle drawings and returns to the exact
idle drawing. Idle uses eight small rigid sway frames over 3200ms.

The twelve attack drawings in `combo-v3/` (casts, extends, pull-back, windup, slam,
recovery, retract and catch) were redrawn by Sunburst from the registered idle
(supplied at 1.15x runtime scale on a layout canvas) plus the Ironclad, Silent, Defect and Watcher sprites
as the style reference, so only the poses changed. Later drawings also receive an
approved neighbouring keyframe as a body, blade, grip and reach reference; drafts that
served only as references are kept in `combo-v3/refs/`. Rejected drafts repeated the
left arm on the right strike or mirrored him, grew the blades 1.3-1.9x, put both chains
in one fist or on an elbow, bowed a chain upward, mangled the pauldron, dropped the
pauldron arm, ran a chain blade to blade along the ground, reversed the blades, let a
chain float loose of the hand, or drew proportions the scale check below rejects.

`combo-v3/registration.json` records each crown-to-goatee-tip head landmark.
`kratos.py` scales each combo-v3 drawing and the kept settle drawing by the geometric
mean of its head scale (75.5px, the same length on the registered idle) and its planted
rear-sole scale against the median rear sole of the kept idle and anticipation
drawings, and fails if the two disagree by more than 20%. The image model draws every
re-posed head 6-19% small against its rear sole, so the mean keeps body and head each
within about 10% rather than letting one landmark inflate the other. Blades vary by up
to about 12% between drawings (left-extended's is the smallest). The kept idle and
anticipation drawings stay registered by their original crown/jaw skull at 65.25px,
and their exports are byte-for-byte unchanged.

A 1152px canvas with 2.3x display overscan keeps the on-screen body scale. Each attack
drawing is centred in its own canvas so the long chains fit. `kratos.py` generates the
whole Kratos clock in `attack-timing.css`: the travel, every pose's opacity keyframes
and a per-pose shift that plants every drawing's rear sole on the idle rear sole, so
his planted foot never slides while he is out (the front foot steps as his stance
changes). The two light hits use `chainTrim` to remove whole
links from their straight thrown chains, so their blade tips meet the slam's on one
line (the bake fails if the three tips differ by more than 12 canvas px). It also
generates `vfx.tsx`'s pose list, attack length, hit and chain-cue times, display scale and
`KRATOS_CONTACT_REACH`; the travel parks that blade line on the target's body point,
and while he is out he draws in front of every enemy, bosses included, so his blades
stay visible on the target and he covers the enemy he stands over (and its intent) for
that moment rather than vanishing behind it. A cold play
keeps the idle fallback and its box-edge travel. `python3 scripts/animation/kratos.py
--check`, run by `verify-assets.mjs`, fails when any generated value is stale. The
ground anchor is 1136px; reduced-motion static art reverses the overscan.

Light hits use two painted flame crescents; the slam uses a larger twin flame / rock
shock, generated against actual Ironclad strike/bash and Watcher meteor impact VFX.
Real CSS impact onsets drive visible HP and numbers at weights 0.1/0.1/0.8, using the
same additive presentation debt as Hermit. Authoritative damage, Block, powers,
relic triggers and gameplay hit counts are unchanged. Rapid cards and item-granted
Shivs queue separate combos; lethal targets fall after the final slam. Reduced motion
settles immediately, and restoration/disconnect clears effects and pending debt.
A cold play retains loaded idle art throughout its timed combo; later plays use
all registered poses. Artwork never changes partway through an active clock.
Actor, pose, chain and target animations share an explicit document-timeline epoch,
so delayed target-portal mounting in WebKit cannot separate their contact clocks.

Three original procedural sounds retain the chain swings, light cuts and heavy
slam synchronized to the visible CSS beats. Row targets deduplicate each cue and
mute/reconnect cleanup is unchanged. Rebuild sounds with
`python3 scripts/audio/generate-combat-sfx.py`; no supplied video audio is copied.

The attack drawings, their exact prompts and layout canvases live in
`scripts/animation/sources/kratos/combo-v3/`; the kept idle, anticipation, settle and
VFX drawings stay in `combo-v2/`. `kratos-art.json` records model sources,
input references and hashes. Generation uses the imagegen skill's bundled CLI,
`gpt-image-2.5-sunburst`, high quality and native alpha. The earlier `combo/` drawings
remain pose references.
Original `sources/kratos/idle.webp` remains the recorded card-art identity reference.

Rebuild with `python3 scripts/animation/kratos.py` and
`python3 scripts/calibrate-hero-head.py`. Review outputs are under
`artifacts/kratos-art/` and `artifacts/kratos-revision/`.
`verify-kratos-animation-browser.mjs` owns Chromium/WebKit on desktop and horizontal
phone: real engine single/row plays, weighted HP/numbers, queued lethal cards/Shivs,
sound cues, cold art, all seventeen pose beats on the registered clock, a planted rear
sole while he is out, one blade line for the three hits that lands inside the target,
exact idle return, reduced motion and restoration. Its composited skin-mask check catches invisible WebKit cutouts.
Asset verification owns native alpha, fixed canvases, ground, clipping, prompt/hash
provenance and sound decoding. Hero-potion browser coverage checks head calibration.
Kratos is released in solo and online play, including Daily and Custom runs.

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
