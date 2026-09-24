# Menu reference artwork

The September 24, 2026 user-supplied Slay the Spire II screenshots are the visual reference.

- `public/assets/menu/title-spire.webp`: edited with `gpt-image-2.5-sunburst` at 3840×2160, high quality; WebP quality 92. The edit removes UI, reconstructs obscured clouds, extends the waterfront, and preserves the bright orange sky and blue water. Bottom-aligned CSS cropping keeps the water visible on wide screens. The original generated PNG is a local artifact under `artifacts/menu-reference/`.
- `title-logo.webp`: actual reference lettering, without the sequel numeral, extracted from screenshot 14.31.12 at crop `(428, 220, 958, 588)`. Yellow letters and cyan flame are isolated with a four-pixel outline; transparent lossless WebP, 530×368.
- `title-flame.webp`: the cyan flame is separated from the wordmark and animated with CSS transforms and one fading ember. Both OS and in-game Reduce Motion settings keep it static.
- `menu-ornament.webp`: gold hover ornament extracted from screenshot 14.33.40 at crop `(27, 34, 58, 55)`, mirrored in CSS for the other side; transparent lossless WebP, 31×21.
- UI text retains bundled OFL-licensed Kreon, also identified in the reference game's `kreon_bold_glyph_space_two` theme. Competing fallback-first families were replaced with Kreon; menu text uses the reference's cream/gold fill, dark outline, and slight letter spacing. The title is custom lettering, not a font available for arbitrary text.

An SVG tracing trial of the ornament was 2,965 bytes versus 754 bytes for the exact WebP crop, with less faithful edges; the raster version is retained.

Repeat the desktop and horizontal-phone visual checks with:

```sh
node scripts/verify-title-menu-browser.mjs
BROWSER=webkit node scripts/verify-title-menu-browser.mjs
```

Screenshots include idle, hover, keyboard focus, saved-game menus, settings, character selection, and the desktop lobby in `artifacts/title-menu/` and `artifacts/title-menu-webkit/`.
