# Downfall boss asset pipeline

The source of truth is the official public-playtest TTS item `3687082014`. The
normal boss faces are preserved under `docs/downfall-enemy-sources/boardgame/`:

| TTS deck | Card indices | Runtime bosses |
| --- | --- | --- |
| `4700` | 0–2 | Witch, Dark Core, Wrathful |
| `4699` | 0–2 | Orb Master, Inferno, Trickster |
| `4698` | 0–2 | Demon, Wraith, Blasphemer |
| `4685` | 0 | Neow |
| `4707` | 0–1 | Flame Barrier, Doppelganger |
| `4704` | 0 | Corrupted |

Generation mode: OpenAI Images API edit, model `gpt-image-2`, quality `high`,
PNG output, and native `background=transparent`. Runtime files are optimized
WebP derivatives; alpha is preserved through every conversion.

Every generated boss pose must receive its canonical cutout as the first,
identity-authority input. Additional references may supply pose geometry only;
they may not alter the boss's face, anatomy, costume, equipment, or palette.

## Canonical cutout prompt

> Extract the named boss character depicted on the supplied official Downfall
> board-game boss card. Preserve that exact character design, costume, anatomy,
> face, colors, weapons, magical effects, and painterly board-game illustration
> style. Remove the card UI, title banner, rules panel, health boxes, room
> background, floor, and every other non-character element. Complete only body
> parts that are naturally obscured by the card UI while staying faithful to the
> visible design. Pose the boss in the same recognizable neutral/ready stance,
> facing toward the left side of the canvas where the players stand. Show the
> complete body and all equipment at large readable scale with comfortable
> transparent margin on every edge. Output exactly one isolated boss cutout, no
> text, no card frame, no scenery, no platform, no rectangular shadow, no
> checkerboard, no white matte. The canvas background must be genuinely
> transparent RGBA, including transparent gaps between limbs, clothing,
> weapons, wings, and magical trails. Boss name: `{boss name}`.

## Animation-sheet prompt

> Create a clean 2x2 animation key-pose sheet for the supplied canonical
> Downfall boss cutout. Preserve the exact same character identity, anatomy,
> costume, colors, weapons, and painterly board-game style in every cell. The
> boss faces and attacks toward the LEFT, where the players stand. Cell 1
> top-left: grounded neutral idle pose. Cell 2 top-right: a subtly different
> breathing idle pose, same camera, scale, foot position, and silhouette. Cell
> 3 bottom-left: readable attack wind-up. Cell 4 bottom-right: the decisive
> contact/impact pose with the specified signature attack fully visible and
> directed left. Each cell contains exactly one complete boss, consistently
> sized and anchored, with generous margin; attack magic/projectiles may extend
> left but must remain fully inside the cell. No cell borders, labels, numbers,
> text, scenery, card UI, floor, shadows, checkerboard, white matte, or
> duplicated body parts. All four cell backgrounds must be genuinely
> transparent RGBA, including gaps between limbs, clothing, equipment, wings,
> and effects. Compose the four cells on one 1024x1024 transparent canvas with
> exact equal 512x512 quadrants. Signature attack: `{attack description}`.

## Framing-repair prompt

Every generated sheet is passed through one final `gpt-image-2` edit before
packaging:

> Repair the framing of this existing 2x2 transparent animation key-pose sheet
> while preserving the exact four poses, character identity, painterly style,
> and signature attack. Each equal 512x512 quadrant must be completely
> self-contained. Scale and recompose every figure, weapon, wing, projectile,
> beam, flame, smoke trail, debris particle, magical arc, and glow so its
> complete natural shape is visible with at least 48 pixels of genuinely
> transparent padding from all four edges of its own quadrant. Reconstruct
> naturally every effect or body part currently cut off by an edge. No visible
> content may touch or cross the outer canvas edges or the central quadrant
> boundaries. Keep exactly one coherent boss per quadrant except intentional
> translucent Doppelganger copies. Keep the two top idle poses, bottom-left
> wind-up, and bottom-right impact. No grid lines, text, card UI, scenery,
> floor, shadow, checkerboard, matte, or colored background. Preserve genuine
> RGBA transparency everywhere outside the four isolated poses.

The packager rejects a sheet when any pose has less than 24 pixels of
thresholded transparent safety margin, then adds a final runtime margin before
building the WebP frames.

For ranged bosses, the travelling effect is not baked into the body animation.
The body uses its complete casting pose while a separate projectile flies to
each living player. This prevents a wide beam or flame trail from being cropped
by the boss frame and lets multiplayer attacks visibly reach every target.

## Ranged-projectile prompt

> Extract and refine exactly one standalone projectile for this boss,
> travelling toward the left. Preserve the attack's exact colors, materials,
> painterly board-game style, and magical visual language. Show the complete
> projectile and its short coherent motion tail at large readable scale. It
> must have a natural rounded or tapered endpoint at both ends and at least 15
> percent genuinely transparent margin on every side. Nothing may touch or be
> cut by an edge. No boss body, hands, weapons, targets, impact burst, scenery,
> floor, shadow, label, text, card UI, border, checkerboard, white matte, or
> colored background. Output genuine transparent RGBA everywhere outside the
> single isolated projectile.

The projectile-bearing bosses are Witch, Dark Core, Orb Master, Inferno,
Wraith, Blasphemer, Neow, and Corrupted. Wrathful, Trickster, Demon, and
Doppelganger use the shared dynamically measured melee dash instead.

The Demon is the melee exception: its launch and ground-slam poses contain only
the character. A separate native-alpha ground-splat VFX fires at takeoff, at the
target landing, and when the Demon lands back at its origin. This keeps dirt and
debris on the ground while the character is above the screen. Every generated
pose edit receives the canonical Demon cutout under the identity rule above.

The signature attacks are a curse wave, Dark beam, ribbon-staff sweep,
three-Orb convergence, ground fire wave, shadow-double cross strike, winged
ground slam, spectral Shiv fan, divine lightning lance, Neow cosmic breath,
Doppelganger multi-thrust, and Corrupted twin infernal blast. Flame Barrier is
idle-only because its current action set contains no attack.
