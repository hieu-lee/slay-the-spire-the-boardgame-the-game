# Reviewed image sources

Model: `gpt-image-2.5-sunburst`, quality high, `background=transparent`, PNG.
These are native-alpha model outputs. RGB beneath zero alpha is retained.

## Gremlin Nob

`nob-club.png` is a separate skull/spine club, matching the canonical enemy.
Keep the skull, ribs, shaft, butt and painted style; render the complete rigid
weapon horizontally, without hands, body, effects or ground. The runtime export
composites this ONE asset into every body pose, with no resizing between frames.

`nob-body-poses.png` is a 6-column/4-row sheet at 1536×1024. References: canonical
Nob, accepted body poses, and the standalone club to explain the grip and weight.
Draw 24 successive body-only poses for a one-handed heavy swing, facing left.
The image-left fist attacks; the other hand balances near the torso. Lift the
fist from waist to shoulder, then overhead; drive it forward/down beside the left
knee with braced legs; lift and return to rest. Keep head, horns, torso, arm
thickness, clothing and planted feet consistent. No prop appears in this layer.
Each 256×256 cell must contain its complete body with transparent padding.
Audit shoulder/elbow/wrist connections, fist orientation, balance and neighboring
cell contamination. The renderer records the accepted grip position per cell.

## Ironclad

`ironclad-body-upper.png` and `ironclad-body-lower.png` provide24 body-only poses.
The exact silver sword is `ironclad-sword.png`. Keep a natural two-handed grip,
constant helmet/armor/trouser proportions and a planted foot baseline. Pose15
is omitted because its hands reverse the intended descending arc.

## Other drawn attacks

Awakened1, Bronze, Guardian, Time Eater, Hermit and Guardian hero use24 native
transparent poses:6 columns by4 rows at1536x1024. Use the canonical character and
original attack poses as references; preserve identity, head/body size, original
choreography and exact phase boundaries. Draw small successive changes with
connected shoulders, elbows and wrists; no duplicated limbs or changing props.

Champ and staff users use a second edit to remove only the weapon while retaining
body poses and gripping hands, then a standalone horizontal rigid weapon asset.
The body-only Collector/Trickster edits were corrected again to remove accidental
extra hands left where the model had mistaken staff parts for limbs. Preserve
native alpha in every edit; do not erase a background with a script. Sprite
extraction only partitions neighboring objects and retains their original alpha.

Watcher, Wrathful and Trickster were redrawn again with smaller successive hand
movements across anticipation, overhead-to-forward action and recovery. The
prompt required exactly 24 bodies in six columns/four rows, native transparency,
constant head/torso scale, connected shoulders/elbows/wrists, two hands only and
no ghosts or weapon in the final body layer. Staff-removal edits preserved each
fist position and body pose; every final composite was audited with its single
rigid staff. Recovery omits unrelated twirls and returns to the initial guard.
Body/prop contact must be checked in the final composite, not inferred from
separate plausible-looking sources.

`taskmaster-poses.png`: use the canonical red hood, gold stitching, green hands
and blue whip, facing left. Draw 24 successive full-body poses: raise the whip
behind the shoulder, snap the gripping hand toward the left, let the flexible
blue whip unfurl toward the target, then retract and settle. Constant body size,
exactly two connected arms, complete whip tip, no ghosting or extra effects.
Preserve native alpha; extend transparent output space for the full whip arc.

Generated poses and alternate experiments are excluded from runtime until their
anatomy, grip, prop dimensions, source-cell bounds and playback are reviewed.


## Bronze Automaton resolution refresh — 2026-09-11

Model: `gpt-image-2.5-sunburst`, imagegen CLI edit, high quality, native transparent background. Idle: 1024×1024 from the previous `bronze_automaton.webp`. Attack: four 1536×1024 edits of the previous sheet’s six-pose rows; packed the 24 native-alpha sprites without background removal. Runtime idle/attack renders use 800px canvases (previously 400px), retaining timing and rig. Static cutout uses the same generated idle. Cropped stray alpha-1 padding outside the idle silhouette and centered the native-alpha cutout on a square canvas; no background removal.

Idle prompt:

Upscale and restore this exact Bronze Automaton game sprite with crisp painted detail. Preserve the identical character design, gold bronze armor, horned shoulder shapes, crossed-arm idle pose, thin long legs, proportions, palette and full-body silhouette. Improve resolution and edge/detail clarity only; do not redesign, add parts, add glow, text or shadows. Keep entire character centered with transparent padding and native transparent background. This is the edit target, not loose inspiration.
STRICT CUTOUT: All pixels outside the metal body must have alpha 0. The body must be opaque alpha 255. No aura, halo, lighting bloom, vignette, fog, gradient, cast shadow or background of any kind. Preserve transparent empty space. This sprite will be composited directly on a game board.

Attack row prompt:

Upscale and restore these EXACT SIX successive Bronze Automaton full-body animation poses. Output exactly six separate sprites in ONE horizontal row, evenly spaced left to right, all fully visible and with identical relative poses and same gold bronze armor design as input. Preserve pose progression, silhouette, thin long legs, horned shoulders, hand positions, proportions, colors and painted style. Render each sprite much larger and sharper using the available canvas height; maintain the original body aspect ratios. Native transparent background and transparent gaps between every sprite; no ground, text, shadows, glow, additional limbs or additional poses. This is a fidelity-preserving resolution restoration, not an animation redesign.
STRICT CUTOUT: All pixels outside the metal body must have alpha 0. The body must be opaque alpha 255. No aura, halo, lighting bloom, vignette, fog, gradient, cast shadow or background of any kind. Preserve transparent empty space. This sprite will be composited directly on a game board.


## Boss resolution audit and The Champ — 2026-09-11

Audited all 26 distinct boss art sets, including shared phase art and Downfall bosses. All now render idle and attack on 800px-wide canvases; Bronze Automaton already did. Existing detailed source drawings and attack poses are retained for the other bosses. Authored attacks and Demon’s airborne/landing registration now honor the same per-rig resolution. Frame timing, body scale, weapons, and choreography remain unchanged.

The Champ’s static/idle source was restored with `gpt-image-2.5-sunburst`, imagegen CLI edit, high quality, 1024×1024, native transparent background. Cropped empty padding around the native-alpha silhouette and centered it on a square canvas. Its 24 attack drawings were restored in eight three-pose edits at 1536×1024 and fitted to the original cells at 2× resolution. Re-registered the separate original sword to the restored hand positions; pose order and attack timing are preserved.

Prompt:

Edit target: the attached exact The Champ Slay the Spire game sprite. Upscale and restore crisp painted edges and armor detail while preserving the identical design, blue armor, visor slits, small gold crown, red cape and shield, gold sword, stance, silhouette, proportions, facing direction and palette. This is resolution restoration only, not a redesign. Preserve the entire character, feet, shield and sword with comfortable transparent padding. Native transparent RGBA background: all background pixels alpha 0, solid character opaque. No backdrop, vignette, aura, glow, cast shadow, new details, text or extra parts.

Attack prompt:

Edit target: these EXACT THREE consecutive game-animation sprites of The Champ. Upscale all three with crisp painted armor edges and details, preserving each original pose, blue armor, visor, gold crown, red shield, cape, anatomy, hands, palette and facing direction. Exactly three full-body sprites in one horizontal row, same order, with large transparent gaps and padding around every sprite. Enlarge all three consistently to use the canvas. Preserve the precise arm positions and shield grip. Do not add a sword: the game attaches it separately to the empty weapon hand. No redesign, extra limbs, aura, shadows, backdrop, text or frames. Native transparent RGBA background, alpha 0 outside the three bodies, opaque characters. Each source is an edit target, not loose inspiration.

## Elite resolution refresh — 2026-09-11

Model: `gpt-image-2.5-sunburst`, imagegen CLI edits, high quality, native transparent background. Restored the 13 elite encounter art sets: Blue/Red Slaver, Book of Stabbing, Gremlin Leader, Taskmaster, Giant Head, Nemesis, Reptomancer, Sentry, Gremlin Nob, Lagavulin, Spire Shield and Spire Spear. Each static source was edited at 1024×1024 and registered into its original silhouette bounds on a canvas twice the original dimensions. Transparent padding was cropped for registration; alpha was retained, without background removal.

Gremlin Nob and Taskmaster also received 8 three-pose edits each at 1536×1024, packed back into their original 24 poses at twice the source resolution (3072×2048). Registration uses visible alpha bounds rather than faint transparent fringes; Taskmaster poses retain their original painted areas and foot positions. Nob retains the original rigid club source and authored grip coordinates; his renderer scales the complete coordinate system together. Other elites animate the restored canonical source through their existing joint tracks. Idle/attack outputs are 800px wide, except Nob's existing wider club-swing canvas, now 1200×1000 instead of 600×500. Timing and display scale are unchanged. Giant Head and Red Slaver have additional bottom overscan so their sharper attack outlines remain inside the canvas.

Static edit prompt:

```text
Use case: identity-preserve. Edit target: the attached original Slay the Spire enemy game sprite. Restore this EXACT drawing at higher resolution with crisp painted edges and details. Preserve the exact character design, pose, silhouette, anatomy, expression, clothing, weapons, colors, proportions and facing direction. This is resolution restoration only, not redesign. Preserve all original parts, full body and transparent padding; no new parts, texture style, aura, glow, shadow, background, text or watermark. Native transparent RGBA background, alpha 0 outside character. Match original composition and relative positions exactly. Keep the original flat painted game art style.
```

Three-pose edit prompt:

```text
Use case: identity-preserve. Edit target: these EXACT THREE consecutive game animation sprites. Upscale all three with crisp painted edges and details, preserving each original pose, anatomy, hands, face, clothing, colors, weapons and facing direction. Exactly three full body sprites in ONE horizontal row, same order, with transparent gaps and padding around every sprite. Enlarge all three consistently to use the canvas. Preserve precise hand and limb positions, physical proportions, and the original flat game art style. Do not add weapons to empty hands. No redesign, extra limbs, aura, shadows, backdrop, text or frames. Native transparent RGBA background, alpha 0 outside bodies. Input is an exact edit target, not loose inspiration.
```
