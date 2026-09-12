# End-turn lightning and Act 2 city

The end-turn Lightning Orb uses a white branching bolt descending to the enemy's
portrait floor, with a broken ground arc and small sparks, matching the supplied
September 12 lightning reference. Evoke beams and channel effects retain their
existing artwork and timing. The event feed still owns targets, staggering,
reconnect suppression, and reduced motion.

Rebuild the 384×768 transparent texture with Blender 5.2 and Python 3 + Pillow:

```sh
blender --background --factory-startup --python-exit-code 1 --python scripts/animation/render-lightning-strike.py
```

The runtime WebP is 41 KiB (1.125 MiB decoded). Its glow is baked; the existing
single overlay animates opacity for 360ms. It sits outside the portrait's death
filter and transform, so killing blows remain bright and grounded. Ground contact is at 94% canvas height.
No runtime canvas, particle system, blur filter, or animation library is added.
During the strike, the redundant enemy-container shadow is disabled so WebKit
does not clip the upper bolt; the artwork keeps its own shadow.

Act 2 uses `public/assets/backgrounds/boss-act-2.webp`, extracted from the user's
second screenshot with GPT Image 2 through the imagegen CLI/API fallback.
The model generated 3072×1536 pixels; the shipped version is 2048×1024, WebP
quality 86, 169 KiB (previous background: 203 KiB). The source PNG stays in
`artifacts/lightning-act2/act-2-city-source.png` for local reuse. The broad floor
begins at roughly 60% of the image, above the characters' feet. Bottom-aligned cover keeps this floor visible when
wide phone screens crop the image vertically.

Generation: `image_gen.py edit --model gpt-image-2 --quality high --size 3072x1536`,
with the supplied screenshot as `--image` and this exact prompt:

```text
Use case: precise-object-edit
Asset type: opaque widescreen combat background for a 2D hand-painted fantasy game.
Input image 1 is the edit target. Extract and faithfully reconstruct ONLY its environment, upscale and restore painted detail. Remove ALL characters (the blue robot on the left and the golden automaton on the right), every glowing yellow orb, health bar, card, number, icon, cursor, UI panel, top HUD and text. Reconstruct the environment behind every removed object seamlessly.
Preserve the recognizable Act 2 setting: dark teal underground city of rounded stone towers with little warm amber windows, distant floating or suspended buildings, enormous rust-brown foreground pillars, teal atmospheric depth and a few soft blue wisps. Preserve the original hand-painted game-art style, architecture and palette; avoid photorealism.
Critical composition: a broad continuous walkable gray-brown cobblestone platform across the entire width. Its far edge sits about 54 percent down the image; the entire bottom 46 percent is visible grounded stone floor with convincing receding perspective. No holes, drop-offs, raised steps or obstacles in the central playable floor. Pillars frame the scene and end at the back edge of this floor. Foreground corner stone silhouettes can stay only at the extreme edges. Keep a wide clear floor for characters to stand on across both halves, and preserve background-city visibility above it. Fill the former top HUD area with continued architecture. Full bleed, 2:1 landscape. Detailed but quiet enough behind gameplay. No characters, creatures, yellow orbs, weapons, UI, lettering, borders or watermark.
```

Verify with `node --experimental-strip-types scripts/verify-lightning-act2-browser.mjs`.
It records desktop and horizontal-phone gameplay in Chromium and WebKit under
`artifacts/lightning-act2/`, checks the actual target-selection flow, foot contact, upper-bolt pixels,
lethal hits, repeated/batched passives, old snapshot suppression, and reduced motion.
