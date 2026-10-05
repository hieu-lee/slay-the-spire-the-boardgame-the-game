# Kratos playtest artwork

Greek Kratos uses God of War 1/2/3 equipment and the game's soft painted sprite
style. The October 5 correction supplies all four actual Ironclad, Silent, Defect
and Watcher sprites to Sunburst, replacing heavy comic outlines and dense armor
patterns with matte color planes, restrained detail and softer shading. Identity
still follows the supplied crouched Blades of Exile / Golden Fleece reference:
ash-white skin, left red tattoo, short goatee, right ram armor and red Spartan skirt.
Native transparency is preserved.

The square-square-triangle combo uses fourteen complete drawings and fifteen timed
keys, below the maximum of twenty. Anticipation starts at 120ms, left cast at 280ms,
left extension at 420ms, right cast at 650ms and right extension at 800ms. Both blades
cast upward at 940ms, extend overhead at 1080ms, descend airborne at 1180ms and strike
at 1280ms. Both blades remain remote from the fists on separate intact chains during
this heavy swing; the contact tips meet the same ground as his soles. Recovery at
1480ms reels them in, 1600ms shows the halfway pull, 1710ms catches the two grips,
1810ms settles into the held-blade stance and 1980ms returns to the exact idle drawing.
The complete clock stays 2200ms. Idle uses eight small rigid sway frames over 3200ms.

`combo-v2/registration.json` records inspected crown/jaw, sole and stance-center
landmarks. Each complete drawing gets one uniform scale to a fixed 65.25px skull;
there is no limb morphing or per-beat body scaling. A 1152px canvas with 2.3x display
overscan leaves room for both extended chains while preserving the on-screen body
scale. The ground anchor is 1136px. Reduced-motion static art reverses that overscan.
The bony jaw is projected where the ram pauldron partly occludes the right-cast face.
The gallery audit checks shoulder/elbow/wrist connections, two hands and legs,
matching blades, chain connections, stable proportions and planted feet. Rejected
heavy drafts stood too tall, enlarged chain reach or put tips below the soles;
rejected right-strike drafts repeated the left arm. Those drafts are not exported.

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

Selected sources and exact prompts live in `scripts/animation/sources/kratos/combo-v2/`.
`kratos-art.json` records model sources, input references and hashes. Generation
uses the imagegen skill's bundled CLI, `gpt-image-2.5-sunburst`, high quality and native
alpha. Ground-position guides only help the image model repair chain connections;
they are never runtime assets. The earlier `combo/` drawings remain pose references.
Original `sources/kratos/idle.webp` remains the recorded card-art identity reference.

Rebuild with `python3 scripts/animation/kratos.py` and
`python3 scripts/calibrate-hero-head.py`. Review outputs are under
`artifacts/kratos-art/` and `artifacts/kratos-revision/`.
`verify-kratos-animation-browser.mjs` owns Chromium/WebKit on desktop and horizontal
phone: real engine single/row plays, weighted HP/numbers, queued lethal cards/Shivs,
sound cues, cold art, all fifteen pose beats, exact idle return, reduced motion and
restoration. Its composited skin-mask check catches invisible WebKit cutouts.
Asset verification owns native alpha, fixed canvases, ground, clipping, prompt/hash
provenance and sound decoding. Hero-potion browser coverage checks head calibration.
Kratos stays playtest-only until separately released.

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
