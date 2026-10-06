# Kratos complete card faces

All 64 cards have separate base and upgraded faces (128 images), authored with
`gpt-image-2.5-sunburst`, high quality and `background: transparent`. Each request
supplies the approved illustrated face, two existing finished Ironclad examples,
and each applicable effect glyph, including the user's red-orb Energy symbol
and the production Rage of Sparta glyph. Prompts specify exact
card information and yellow keyword emphasis. Damage, Block, Vulnerable, Weak,
Strength, Rage and Energy use the supplied effect symbols directly in the rules,
as the existing cards do. All values and surrounding conditions remain written;
canonical plain-damage behavior remains in gameplay and tooltips. Upgraded faces use the existing
green title (including the plus sign) and subtle gold frame glow. Their exact
upgraded costs/effects are preserved, while keyword emphasis stays yellow.
Upgraded requests use existing upgraded faces as style references.

All 128 faces were audited at the type tab and full bottom border. Masked
model edits remove invented decorative gems from 23 base faces; upgraded faces
are clear. `diamond-cleanup.json` records original inputs, masks and repair
boxes. Only RGB pixels inside each repair box are composited from the model;
all visible pixels outside are preserved. The original alpha plane is retained except
for two protruding bottom-edge housings, restored to the adjacent frame edge
in the explicitly recorded alpha repair boxes.
The prompts forbid stray rarity badges while preserving real effect symbols.

All 128 rules panels use compact Ironclad notation: `1 [DAMAGE]` and
`[AOE] 2 [DAMAGE]`, without redundant Deal/Gain/Apply or row prose. Conditions,
repeat counts, ownership and timing remain visible. Typhon's Bane uses two
separate Weak icons (three upgraded), and Zeus' Fury uses two separate
`1 [DAMAGE]` hits (three upgraded), without targeting prose or repeat text.
Rage of the Titans, Soul Summon, Army of Hades and Golden Fleece omit the
redundant Plain label in both versions. At the
user's request, the AOE glyph represents both row and all-enemy effects on
the printed faces; canonical rules and accessible tooltips keep their exact
targeting distinctions. Canonical `printedText` and gameplay are unchanged.
`compact-effects.json` records masked panel inputs and composition boxes;
only the rules rectangles are replaced, preserving all approved headers,
illustrations, costs, upgrade styling and the cleaned frame geometry.

All 128 faces share one cost orb. The orb of `kratos__rare__red-orbs+` is the
benchmark: `scripts/art/unify-kratos-cost-orbs.py` cuts it out
(`scripts/art/sources/kratos-card-faces/cost-orb/benchmark-1.png`), has
`gpt-image-2.5-sunburst` restyle only the numeral for costs 0, 2 and 3
(`orb-N.png`), and pastes the matching orb at the benchmark position on every
face. Each face's old orb is located from its dark rim, and the model removes
the old orb's fragments only inside that circle (plus its shadow and glow).
Only that footprint, with a feathered edge, is taken from the model, so the rest
of every face stays pixel-identical to the previous commit; the new orb is pasted
again on top so it stays pixel-exact. Prompts are in the script.
`cost-orb/face-samples.json` names the model sample picked by eye for the few
faces where the first sample invented a golden arc or damaged the frame. A flood
fill from the corner clears dark haze outside the card corner. The script
rebuilds every face from the pre-change commit it pins and the cached model
samples; without that cache it re-samples the model and the picks must be
redone, so the committed source faces are the record of the result.

The Energy symbol was reconstructed from the user's cropped God of War red
orb reference. Its source keeps native alpha; the runtime icon is 256 square.
It supplies Kratos's native fallback cost and model references for the finished
card faces. A separate original HUD design uses that red core inside a Greek
bronze meander ring with chain segments and red Spartan fittings. Its frame
leaves the center clear for the live Energy count and dims when empty.

`plan.json` records all 128 face definitions, canonical mechanics, symbolic
rules layouts and input references. `prompts/` contains the final per-card
model requests and the two orb prompts. Bracketed tokens in `symbolText` are
rendering instructions for pictorial glyphs and never appear on the cards.
The model receives both canonical mechanics and the symbolic rules layout so
repeated effects, conditional effects and base/upgrade values stay intact.
Selected model outputs are kept as lossless WebP under
`scripts/art/sources/kratos-card-faces/`. `manifest.json` records source,
reference, prompt and runtime hashes.

Rebuild without API calls:

```sh
python3 scripts/art/export-kratos-card-faces.py
```

Full card exports follow the game's 744x1039 convention. The 448x626 thumbnail
exports keep hand/deck rendering within the existing phone texture budget.
Generated images are used by the normal card and compendium paths. Live rules
remain the authority for accessibility and image-load fallbacks. Temporary
Energy discounts show a live red-orb badge above the printed card cost.

Focused validation owns all 128 mounted images, exact native fallback rules,
base/upgrade values, yellow keyword markup, and the red-orb HUD on desktop and
horizontal phones in Chromium and WebKit. Local OCR reports and visual audit
screenshots live in `artifacts/kratos-card-faces/` and
`artifacts/kratos-card-art/`.

Pages excludes hero idle WebP animations and resolves them from the existing
SHA-pinned raw asset host, alongside large APNG attacks. Music, Safari videos
and campfire scenes also use that host; jsDelivr failed to serve the release
commit. Raw hosting provides the required MIME types, CORS and video byte-range
requests. This preserves the original image bytes and saves approximately 52 MB of the Pages package.

Native alpha is retained at quality 75. Kratos has a separate 16 MiB full-face
allowance (160 KiB per image) and 8 MiB thumbnail allowance; existing card
budgets and the 448px thumbnail decode limit are unchanged.

HEVC-alpha playback is restricted to native macOS Safari. Linux WebKit advertises
HEVC decoding but loses its alpha plane, so it uses the animated WebP assets.
iPhones retain their existing WebP path.
