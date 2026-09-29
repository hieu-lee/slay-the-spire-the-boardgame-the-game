# Combat animation sources and review

The runtime uses one-shot WebP attacks, looping WebP idles and the existing CSS
travel/projectile clocks. `CHOREOGRAPHY.md` records the phase timings. Gameplay
queues still complete through the existing presentation events; rendering never
changes combat rules or multiplayer authority.

Use the method that fits the drawing:

- Ironclad rests in his canonical horizontal-sword artwork and returns to it
  during the 1260–1800ms recovery. His original ready/impact images now drive
  the attack: 90ms dash, 500ms strike/follow-through, brief settle and 90ms
  return. CSS keeps physical scale fixed. Watcher uses the original raised-staff and
  downward meteor-cast assets with their original CSS phase clocks; her newer
  experimental rig exports and Ironclad's generated attack are not used in gameplay.
- Actors use either their original drawn attacks with audited RIFE in-betweens,
  or new native-alpha body pose sheets. Guardian dashes before the attack-form punch; defense form rolls its
  canonical rigid shell to the target and back. Its static holds are encoded
  as longer WebP frames. Hermit reuses the native-alpha muzzle flash at both
  pistol mouths in every firing pose. Failed optical-flow candidates are rejected
  rather than blended through missing limbs. The exporters preserve phase
  boundaries and register body scale independently of weapon extent. Wide swings get transparent overscan, compensated by the same
  display scale for idle and attack.
- Gremlin Nob, Ironclad, Champ and staff users combine drawn bodies with one
  identical rigid weapon sprite per actor. Only
  rigid rotation and translation affect the club. Foreground fingers cover the
  shaft at the authored grip. No generated frame may introduce a different club.
- Other elites use source-space joint tracks, with rigid regions around blades,
  shafts, shields and stone shells. Rotation uses physical pixel proportions,
  rather than normalized square coordinates. Flexible cloth and tails retain
  secondary motion. Large poses that expose unpainted surfaces require drawn
  replacements, not stronger mesh deformation.
- Demon retains separate airborne and crouched ground-slam drawings, controlled
  by its original launch/landing visibility and travel phases.

Research references: Spine's [mesh guide](https://esotericsoftware.com/spine-meshes)
and [weights guide](https://esotericsoftware.com/spine-weights). Flat illustrated
characters do not contain the back surfaces needed for arbitrary 3D turns.
Blender can animate layered cutouts, but does not remove that source-art limit.

New raster sources use GPT Image 2.5 Sunburst with `background=transparent`.
Supply the canonical character, a separate weapon reference and the pose to
polish. Explicitly ask for connected shoulders/elbows/wrists, natural grip,
constant weapon dimensions and constant body scale. Audit the returned image
composited on a contrasting background: invisible RGB under zero alpha is not
background residue. Never erase or chroma-key a background in a script.
Cropping a sprite cell or compositing a hand/weapon layer preserves native alpha.

Rebuild with Python 3, Pillow, numpy, scipy, numba and torch:

```sh
python3 scripts/animation/render-rig.py scripts/animation/rigs.json
python3 scripts/animation/verify-motion.py
python3 scripts/animation/review-rigs.py --write-metadata
node scripts/verify-rig-animation-browser.mjs
```

The rig renderer also refreshes same-resolution HEVC-alpha `.mov` companions for
Safari. To refresh companions after replacing committed WebPs directly, run
`python3 scripts/animation/encode-safari.py`; runtime paths and the source-hash
manifest are derived automatically, so new art never needs a code mapping. The
encoder preserves each source frame's millisecond boundary at maximum quality
and rejects timing, alpha or decoded-pixel drift before updating the manifest.
Hosted builds load the companions and background music from the exact deployed
commit through jsDelivr and omit them from the Pages artifact, which remains
comfortably below 1 GB.

Use `--only hero-ironclad,gremlin_nob` for individual characters. Contact metadata
is sampled by elapsed milliseconds, not frame index. WebP frames must last at
least 20ms: browsers may stretch shorter frames and desynchronize the image from
CSS travel. An attack needs a fresh Blob URL for every playback; a shared decoded
URL may reuse an ended animation timeline. Release it when playback completes.

Review every drawn pose and every rendered extreme, then record and replay the
actual gameplay on desktop and horizontal phone. Check anatomy, grip, rigid
weapons, clipping, body size, target contact, return, repeated attacks, telegraph
separation and reduced motion. Alpha bounds and timing checks do not prove that
a pose looks good. Generated candidates belong outside runtime assets until
that visual audit passes.

## Drawn stabs (Looter, Mugger, Book of Stabbing)

These three attacks are chains of 16-pose Sunburst sheets, not rigged cutouts: a rigid blade that
must visibly thrust is drawn, never deformed. `sources/stab-prompts.json` has the model, prompts and
the key-drawing workflow; `sources/stab/` holds the exact sheets (lossless WebP, native alpha) and
`rigs.json` (`stabSegments`, `stabLandmark`, `stabAnchor`) their timing and joins.

`stab_frames.py` scales each pose from a rigid painted landmark (`stabLandmark`: the Looter's bandana, the
Mugger's hair, the Book's dagger blade), plants it on the canonical anchor (`stabAnchor`: the rear foot, or for
the Book `feature` with `stabAnchorKind: "book"`, where the ribbon meets the pages), joins sheets at the
best-overlapping exit/entry drawings (`entry`/`exit` are a pose or a `[from, to)` range) and emits a frame
every 20ms (the shortest duration browsers honour). The Book additionally sets `stabFitFirst` (size the first
drawing to overlay the canonical body, since the model draws the dagger smaller) and `stabPastePages` (the
model redraws the pages at growing sizes, so they are erased and the canonical pages composited) and
`stabGradeBlade` (grade the blade to the idle blade's colours on its own, since it is a small share of the pixels). RIFE
fills the gaps only between near-identical drawings (`stabMorph`, silhouette IoU, default .72); otherwise
the nearer drawing is held, because a hard cut reads better than a ghost of two poses. The last drawing
morphs onto the canonical frame, which is always the final frame (the bake asserts it).
Idle and attack share one canvas and `displayScale` (the Book needs 3.0 so its thrust is not clipped);
overscan is restored by the metadata `scale`. `maxAreaChange` and `maxFrameDuration` relax
`review-rigs.py` for these drawn attacks. Exports live in `combat/enemies/animated/` with no HEVC
companion (the encoder needs macOS).

Rebuild: `python3 scripts/animation/render-rig.py scripts/animation/rigs.json --only looter,mugger,book_of_stabbing`,
then `python3 scripts/animation/review-rigs.py --only=looter,mugger,book_of_stabbing --write-metadata` and
`python3 scripts/calibrate-enemy-size.py --only=looter,mugger`. Changing the Book's `displayScale` moves its
idle feet: rescale `book_of_stabbing[0]` in `src/ui/enemy-foot-anchors.json` about the centre: `0.5 + (x - 0.5) * old / new`.
Review every rebuilt frame for a weapon that changes hands, ghosts, bends or resizes, and for size pops.

## Offline interpolation model

`interpolate.py` uses RIFE 4.26 from the official
[Practical-RIFE repository](https://github.com/hzwer/Practical-RIFE), with its
[4.26 model archive](https://drive.google.com/file/d/1gViYvvQrtETBgU1w8axZSsr7YUuw31uy/view).
Extract the inference code/weights into `artifacts/choreography/rife/` with
`train_log/IFNet_HDv3.py`, `train_log/flownet.pkl` and `model/warplayer.py`, or set
`RIFE_MODEL_DIR` to that directory. Model files are offline authoring dependencies,
not shipped browser assets. The wrapper transports premultiplied native RGBA
through the same motion field and supports CPU, CUDA and MPS.

RIFE is used only for the accepted source sequences; 24 drawn poses replace the
occlusion failures in Hermit, Guardian hero attack form, Awakened phase1,
Bronze Automaton, Guardian attack, Champ, Collector, Time Eater, Trickster and
Wrathful. Taskmaster's drawn whip now unfurls toward the target; its wider
transparent overscan keeps the full tip visible at a constant physical size.
The Hexaghost hero's canonical rigid crystal overlays the changing
flames at one fixed size. `drawn-props.json` records hand positions in each native
source sheet, primary/supporting hand positions, weapon pivots and angles.
Two-handed weapons retain the orientation of their selected body pose;
single-handed Champ uses a continuous sword arc. Staff swings use newly drawn
intermediate arm positions, not optical-flow hand tracking. `drawnPhases` maps
their anticipation, attack and recovery drawings to the original phase clocks;
`drawnOrder` omits rejected twirls. Trickster's purple double copies the current
body and staff silhouette during his original cast window.

Boss idle/attack art shares elite layout geometry. Each sequence has one fixed
body registration and compensated overscan; no frame is independently fit by
its weapon bounds. Demon flight and landing are separately registered by
`register-demon.py` at the same canonical source scale. Its original aerial
launch/ground-slam choreography remains in CSS.

`review-rigs.py` checks every frame's alpha bounds and duration, compares boss
idle/attack endpoint painted size, and checks size drift throughout the attack.
Trickster's intentional spectral duplicate is excluded from the whole-frame
area heuristic. These checks supplement full-size pose inspection, which must
verify heads, torsos, fingers and weapons themselves.

The September 2026 size audit covers all 98 idle/attack rig pairs, plus the live
Ironclad/Watcher poses and Guardian mode transitions. Guardian's attack previously
started at 90% of idle stature because opaque-area fitting confused pixel density
with body size. `hero-guardian` now uses `drawnFit: "height"`: register the first
upright pose to idle stature, then apply that one scale to the entire sequence.
`review-rigs.py` guards its opening height ratio. Rebuild with
`python3 scripts/animation/render-rig.py scripts/animation/rigs.json --only hero-guardian` and refresh metadata with
`python3 scripts/animation/review-rigs.py --write-metadata`.
Watcher CSS no longer scales the whole body between poses, and enemy hover uses
the targeting glow without enlarging the body. Crouches, weapon arcs,
Slime squash/stretch, death collapse and Demon flight remain intentional motion;
never fit each frame independently to its silhouette.

For a larger battlefield cast, change `STAGE_GAP_REM` in `src/ui/board-signals.ts`.
Hero portraits and normal/elite/boss art derive from the same actor width, while
`stageScaleFor` fits crowded encounters and smoothly restores size after deaths.
Export overscan compensation stays separate from that display-size control.
`verify-character-size-browser.mjs` checks shared sizing through idle, attacks,
static art and Guardian transitions in Chromium and WebKit on both screen classes.

Hexaghost's heat variants share the zero-heat body registration and animation.
`render-hexaghost-heat.py` composites upright native-alpha flame artwork at
fixed bases with independent vertical flicker. It also exports matching static
variants for reduced motion; crowns of heat never rotate with the purple body.

Normal enemies use the same renderer and native-transparent source artwork.
`rigs.json` specifies each design's root motion, optional projectile/impact and
emitter position within the first idle silhouette. The audit exports the emitter
in source pixels, so browser attachment accounts for aspect ratio and overscan.
`flipX` faces the enemy Ironclad's sword and summoned Shiv toward the heroes
before registration.
Run `node scripts/verify-rig-animation-browser.mjs --normal-only` to record and
check the full normal roster on desktop and horizontal phones; use
`--hero=defect --only=none` for blue orbs, mouth-origin Lightning/Dark beams and
self Frost. Both cover repeated playback and reduced motion; evokes also check
reconnect cleanup. `review-rigs.py` records pose galleries for visual inspection.
Damage impacts and projectile destinations use the cached painted body center,
with sprite scale, padding and object fit applied. Acid instead grows from its
painted base at foot level; Defect's beam source retains its mouth registration.

Byrd's idle uses three full wingbeats per 3000ms loop, with separate rigid wing
layers behind a fixed body. Cultist draws back both sticks, releases at 500ms,
holds empty hands through impact at 1000ms and recovers by 1830ms. The two rigid
props spin along separate upward curves from their respective hands to each
living player targeted by the attack. Each 500ms curve is a linear horizontal
translation plus an exact quadratic vertical easing, not `offset-path`, whose
origin differs on iOS Safari. The curves are fixed at launch; late image
alignment cannot redirect them. Shoulder underlays cover the
surfaces exposed by the arm rotation.
`wing_and_throw.py` bakes these layers; its Sunburst native-alpha sources and exact
prompts are in `sources/wing-and-throw-prompts.json`. Rebuild via
`python3 scripts/animation/render-rig.py scripts/animation/rigs.json --only byrd,cultist`
from the repository root. Their exports live in
`combat/enemies/animated/`, without unused HEVC companions or a macOS authoring
dependency. Cultist also exports a self-contained animated SVG for WebKit:
its elapsed-time arm transforms avoid native WebP frame throttling. A matching
empty-handed pose covers the SVG from the CSS release boundary to 1500ms,
keeping held sticks from appearing beside the flying props while leaving the
animated recovery visible.
Other browsers use the baked WebP.
Refresh their size calibration with
`python3 scripts/calibrate-enemy-size.py --only=byrd,cultist`; `--check` verifies
it without writing. Byrd's full wing clearance stays separate from body scale.
Run `node scripts/verify-wing-and-throw.mjs` and
`node scripts/verify-wing-and-throw-browser.mjs` (also with `--webkit` and `--crios`) from the
repository root for native-frame, desktop, horizontal-phone, targeting, replay,
reconnect and reduced-motion checks.

Hero rigs export at 800px wide to preserve detail at desktop/Retina display sizes.
Idle exports use the original `-hero.webp` texture through `idleSource` where
available, preserving the registered canvas aspect and display scale. Ironclad's
specialized renderer uses the same doubled geometry and original texture;
Watcher's static idle uses her original texture directly. Heat flame anchors
remain in 400px authoring coordinates and scale with the exported canvas.
Run `verify-character-size-browser.mjs` to guard resolution, placement and attacks
on desktop and horizontal phones; regenerate contact metadata after exports.
