# Continuous cutout animation

The old assets alternated independently drawn poses. Their silhouette, costume
and scale changed at each cut. These rigs animate the original drawing through
continuous joint curves; the exported frames are samples of that motion.

Research: Spine's [mesh guide](https://esotericsoftware.com/spine-meshes) and
[weights guide](https://esotericsoftware.com/spine-weights) describe textured
meshes and linear blend skinning for moving a drawing with bones. Blender can
perform the same deformation and render it offline. For these flat cutouts a
small offline 2D rasterizer avoids constructing 3D surfaces that the source
artwork does not contain. No animation library or GPU context is added to the
game. Blender CLI 5.2.1 LTS was checked during the prototype work.

`rigs.json` defines source-space pivots, feathered attachment regions (including convex polygons around limbs), idle
amplitudes, attack angles and contact times. Regions follow the artwork: weapons
and forearms, construct limbs, wings, cloth, tails and floating components. The
renderer forward-rasterizes weighted textured triangles. This matters near
joint folds: inverse image warping stretched weapon tips in the first prototype.

Each attack has anticipation, contact, follow-through and recovery. Idle curves
have delayed secondary movement and loop continuously. Canvas, source scale and
ground position are fixed for both animations; frames are never independently
cropped or rescaled. Existing gameplay VFX, projectile timing and presentation
authority remain in the UI. Reduced motion uses static source art.

Attack files play once. Preload their bytes as Blobs and create a fresh object
URL for each playback; reusing an image URL can reuse a finished browser
animation timeline. Release the URL when the attack ends. Cold or failed loads
use the static drawing so combat timing never waits for the network.

Rebuild with Python 3, Pillow, numpy, scipy and numba:

```sh
python3 scripts/animation/render-rig.py scripts/animation/rigs.json
python3 scripts/animation/review-rigs.py --write-metadata
node scripts/verify-rig-animation-browser.mjs
```

Use `--only hero-ironclad,gremlin_nob` to iterate on individual rigs. Source
snapshots under `sources` preserve the first idle drawings from the previous
boss exports so rebuilding never feeds an already deformed frame into a rig.
Review galleries and runtime recordings are written under
`artifacts/rig-animation`. The review script also checks frame cadence, canvas
identity, clipped alpha, silhouette area and return to rest, and produces the
contact-offset metadata used for melee travel.

This remains animation of a single illustrated view. Large turns that reveal
unpainted surfaces need additional painted layers or a complete character model;
keep each joint's range appropriate to the available source drawing.
