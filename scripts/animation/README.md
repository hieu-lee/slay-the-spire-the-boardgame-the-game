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
