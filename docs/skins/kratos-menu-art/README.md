# Kratos skin menu art and energy orb

Generated with `gpt-image-2.5-sunburst`, high quality, using the bundled imagegen CLI, with the approved
Greek Kratos idle source (`scripts/animation/sources/kratos/idle.webp`) as the identity reference and the
existing Ironclad and Hermit menu art as style references. `prompts/` preserves the submitted prompts and
`manifest.json` records each selected source, prompt, supplied reference and output by SHA-256.

- `public/assets/menu/character-select/portrait-kratos.png` (256x384) and
  `character-kratos-wallpaper.webp` (1536x864, a top-aligned crop of the model's 1536x1024 output; the
  CLI rejected the first 4K request before any API call, and no upscaling is used) are shown in character
  select when the Ironclad card wears the Kratos skin.
- Menu, stats, leaderboard and compendium icons stay per character (Ironclad's); the skin has none.
- `public/assets/combat/energy-orbs/kratos.webp` is the combat HUD Energy orb. Its recorded model entry is
  `energyOrb` in `manifest.json`; the red-orb icon it was edited from no longer ships.

Re-export the two menu assets with `python3 scripts/art/export-kratos-menu.py` (Pillow required); this
makes no API calls. `verify-assets.mjs` checks that the exports decode at the audited sizes.
