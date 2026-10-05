# Kratos complete card faces

All 64 cards have separate base and upgraded faces (128 images), authored with
`gpt-image-2.5-sunburst`, high quality and `background: transparent`. Each request
supplies the approved card illustration, the user's red-orb Energy symbol,
the production Rage of Sparta glyph, two existing finished card examples and
any applicable attack, Block, debuff or draw symbols. Prompts specify exact
card information and yellow keyword emphasis; symbols must supplement words.

The Energy symbol was reconstructed from the user's cropped God of War red
orb reference. Its source keeps native alpha; the runtime icon is 256 square.
It supplies Kratos's native fallback cost and model references for the finished
card faces. A separate original HUD design uses that red core inside a Greek
bronze meander ring with chain segments and red Spartan fittings. Its frame
leaves the center clear for the live Energy count and dims when empty.

`plan.json` records all 128 face definitions and input references. `prompts/`
contains the final prompt set, including the orb extraction prompt. Early
requests used the same card prompts before the final mandatory text-accuracy
paragraph was added; faces with omitted words or duplicate numbers were
regenerated. Godslayer faces were also corrected to avoid a misleading Rage
glyph. Selected model outputs are kept as lossless WebP under
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
SHA-pinned raw asset host, alongside large APNG attacks. This preserves the
original image bytes and saves approximately 52 MB of the Pages package.

Native alpha is retained at quality 86. Kratos has a separate 16 MiB full-face
allowance (160 KiB per image) and 8 MiB thumbnail allowance; existing card
budgets and the 448px thumbnail decode limit are unchanged.
