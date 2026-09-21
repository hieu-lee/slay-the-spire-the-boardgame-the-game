# Artwork resolution restoration

Generated with the imagegen skill's bundled `image_gen.py edit` CLI, model
`gpt-image-2.5-sunburst`, `quality=high`, PNG intermediate output. Final runtime
art is optimized WebP (scenes: quality 85, method 6); animation source sheets retain PNG. The inventory in
`asset-resolution.json` records original hashes, dimensions and final geometry.

## Scene prompt

Faithful high-resolution restoration of this exact game scene. Copy the original composition, camera, perspective, all subjects and their count, exact positions and scale, props, architecture, colors and painting style. Preserve original dark lighting and exposure; do not brighten the image. Recover crisp painted texture and edge details lost to downsampling. No added objects, characters, lights, writing, logos or UI. Keep every existing character and its identity, pose, face and clothing unchanged. This is the identical scene at higher resolution, not a redesign. Preserve framing exactly.

Settings: 3840×2160, opaque background. Processing restores original aspect ratio
and mean channel exposure.

## Cutout and pose specification

Faithfully restore the supplied character/enemy artwork at higher resolution.
Preserve identity, silhouette, pose, face, anatomy, clothing, weapons, colors and
painting style. Recover crisp painted detail without redesign, new objects,
text, scenery or shadows. Keep the complete subject on a native transparent
background, including soft translucent effects.

Settings: native transparent background; aspect-matched 1024–1536px output.
Processing scales and translates painted bounds onto the original canvas at 2×.
It preserves native alpha rather than deriving transparency from RGB colors.

## Animation sheet specification

Faithfully restore all 24 supplied poses in the same row/column order and layout.
Preserve each pose, character identity, anatomy, hands and weapon attachment
positions, colors and painting style. Recover crisp painted details without
adding, deleting or rearranging poses. Native transparent background.

Settings: 3072×2048 (Bronze Automaton: 2816×2688). Each pose is independently
registered to the original pose's painted bounds and canvas position at 2×.
Renderer grip, muzzle and prop coordinates use the same doubled source scale.

Generated details are illustrative derivatives, not recovered official source
pixels. Printed card scans were retained intact to protect rules and numbers.
