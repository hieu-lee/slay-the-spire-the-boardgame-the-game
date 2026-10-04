# Painted combat effects

All 48 existing sprites under `public/assets/combat/vfx/` and all eight Downfall magic
projectiles under `public/assets/combat/enemies/projectiles/` were repainted with
`gpt-image-2.5-sunburst` using the imagegen skill's bundled `image_gen.py edit`
CLI, high quality, 1024×1024, native transparent PNG output. Three new painted
strips replace procedural lightning/dark beams and speed trails.

The style references are the existing Watcher, Ironclad, Hexaghost and Lagavulin
cutouts. Broad brush-painted forms, layered color planes and restrained highlights
replace glossy neon filaments. Original subjects, palettes, directions and empty
ring centers are preserved. Character bodies and physical enemy weapon props are
already painted in this style and are not effects sprites.

`combat-vfx-restyle.json` records the source commit, input hashes, exact prompts
(`promptPrefix` + each `subjectPrompt`), reference paths, generated-image hashes,
registration, final geometry and final WebP hashes. To reproduce an edit, obtain
its first input (`path`) from `sourceCommit`; for the three new strips, use
the committed restyled `inputPath` identified by `inputVersion`. Append the four
reference images in their listed order. Pass its complete prompt to the bundled CLI with `--no-augment`.
Generated PNG intermediates remain local under `artifacts/vfx-restyle/generated/`.

## Runtime registration

Native alpha is retained without background removal. Each generated sprite is
uniformly scaled and translated to fit the original alpha bounds (threshold 8),
then placed on the original transparent canvas and encoded as WebP at quality 88,
method 6 (the tall lightning sprite uses quality 75 to retain its 48 KiB delivery
budget). The two protective shield sprites retain 60% of generated alpha so the
protected character remains visible through them. The lightning bolt is separately
registered from its generated ground arc (512, 981) to the existing runtime
contact (192, 722), preserving the 94% ground anchor and top-edge entry.

The shared renderer uses normal alpha compositing and the painted sprite's own
highlights, with a faint tinted edge retaining the recipe's semantic color.
Procedural neon rings/streaks and strong glow filters were removed from these
overlays and Watcher's stance auras; effect reveal, contact and fade clocks are
unchanged. Painted strips also replace Defect’s SVG filaments and CSS motion
trails. Sword arcs, elite charge effects, sigils and ground waves reuse the
painted sprites, keeping their source/target geometry and clocks.

## Watcher meteor

The runtime sprite's alpha-weighted principal axis is 44.83365 degrees down and
right, with unit vector (0.70915675, 0.70505085). Its leading painted nose is at
(89.9414%, 84.4315%). `CombatScreen.tsx` uses that axis for the flight path;
`attack-timing.css` uses the nose for translation and impact placement. Contact
remains at 1050 ms, with the existing 70 ms per-target stagger. The impact burst's
painted ground center (51.1719%, 78.90625%) also stays at the enemy's feet.

`verify-rig-animation-browser.mjs --hero=watcher --only=watcher` independently
measures the decoded sprite's axis and nose, then checks rendered sky entry,
flight direction, ground contact and impact timing on desktop and horizontal
phone. The check fails with the old geometry and passes with the new geometry.
The preload verifier owns returning-player/reconnect delivery; the lightning
verifier owns its foot contact and multi-orb timing.

The older Blender renderers describe the previous bullet/lightning assets; the
Sunburst prompts and registration in this manifest are the sources of this set.

## Delayed Hermit replay

Hermit presentation removal and HP fallback now defer while the sequence's
flight/impact CSS animations remain pending or running. This retains damage
numbers when replay decoding starts the CSS clock after the wall-clock deadline.
Missing artwork still settles normally; restore and reduced-motion transitions
clear the existing timer maps. The rig verifier delays the first AoE replay
by 1200 ms and checks every real impact and damage share on both screen classes.

The Downfall orb enemies retain their historical base-game effect inputs under
`docs/downfall-enemy-sources/base-game/`; their provenance points to those archived
originals because the live channel effects have now been repainted.
