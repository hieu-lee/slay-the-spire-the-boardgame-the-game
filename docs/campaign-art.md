# Campaign selection artwork

The user supplied both cover images. They were edited with the imagegen skill CLI using `gpt-image-2`, high quality, then converted to WebP at quality 95 for the game.

- `public/assets/menu/campaign-standard.webp`
- `public/assets/menu/campaign-downfall.webp`

First pass: remove all text, lettering, title and publisher logos, banners behind lettering, and watermarks; reconstruct the artwork behind them while preserving characters, poses, composition, painterly style, lighting and floating cards. Output: 2048 × 2048.

Second pass used those cleaned outputs as edit inputs, at the user's request. Output: 2816 × 2816. Prompt for the standard artwork:

> Upscale and extend this cleaned artwork. Produce a much sharper high-resolution painting: crisp character silhouettes and fine armor, fabric, cloud and tower details, without blur or artificial sharpening halos. Expand the scene naturally around all four edges for slightly wider framing, keeping the existing characters fully recognizable and the original composition centered. Preserve all characters, poses, painterly style, orange fiery lighting and floating cards. Reconstruct fine detail faithfully; no new characters. Absolutely no text, lettering, logos, banners or watermarks anywhere.

The Downfall prompt used “stone” in place of “armor” and “purple-blue vortex lighting” in place of “orange fiery lighting.”
