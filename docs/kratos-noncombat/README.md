# Kratos merchant, campfire and treasure artwork

Generated with `gpt-image-2.5-sunburst` through the imagegen skill's bundled CLI
(`edit`, high quality). Existing merchant poses and campfire scenes provide the
style/composition references; the committed Kratos combat cutout and selection
portrait provide his identity. Exact prompts are in `prompts/` and input/output
provenance is in `manifest.json`.

- `public/assets/noncombat/merchant/characters/kratos-standing.webp`: transparent
  standing pose, automatically used by the existing merchant arrival screen.
- `public/assets/noncombat/campfire/*kratos_firecamp.webp`: all 93 distinct parties
  of one to four heroes containing Kratos, in the roster's canonical order.
- `public/assets/noncombat/treasure/{hand,grip}-kratos.webp`: matched transparent
  reaching/gripping poses for the existing relic pickup animation.
- `scripts/art/sources/kratos-noncombat/`: lossless model artwork, seated reference
  and cropped canonical Kratos reference. Other characters' assets are unchanged.

Campfire model inputs were fitted into a 1536×864 content rectangle inside a
1536×1024 canvas, with 80-pixel black bands above/below. The bands are cropped
from the selected outputs; the lossless scene sources retain the 1536×864 art.
The first solo candidate was rejected for adding unwanted reference heroes.
The selected solo and all remaining parties use only their existing party scene,
seated Kratos and Kratos identity as references. The selected Ironclad/Silent/
Defect/Kratos scene additionally used the existing original four-hero scene.
Four model scenes inherited incorrect companions from mislabeled references;
their correction prompts and lossless edit inputs are retained in the manifest.

Rebuild runtime files with Pillow:

```sh
python3 scripts/art/export-kratos-noncombat.py
```

The merchant export preserves native alpha and caps its longest edge at 576px.
Campfire exports follow the existing 3840×2161 convention (WebP quality 50,
method 6); the complete collection remains below its existing 128 MiB ceiling.
Treasure hands are cropped from a single two-column model sheet and exported
to the existing 384×1024 canvas, preserving native alpha and both pose anchors.
Party scenes retain the existing pinned CDN/backup delivery and local empty-scene
fallback, so only the compact merchant and treasure poses are added to the Pages package.

Focused validation: `verify-assets.mjs` owns inventory, decoding, dimensions,
transparency and size; `verify-art-scenes-browser.mjs` owns solo/party campfire
rendering; `verify-merchant-overflow-browser.mjs` checks the Kratos arrival image
before entering the shop on desktop and horizontal phone.
`verify-treasure-animation-browser.mjs` checks both Kratos hand poses during
actual pickup, with desktop/horizontal-phone screenshots in Chromium/WebKit
and existing ownership, remote-claim, final-transition and reconnect safeguards.
