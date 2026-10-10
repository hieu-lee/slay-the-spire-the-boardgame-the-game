#!/usr/bin/env python3
"""Export the Kratos skin's menu art from the selected model sources; no generation API calls are made here."""
import hashlib
import json
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'scripts/art/sources/kratos'
DOCS = ROOT / 'docs/skins/kratos-menu-art'
MANIFEST = DOCS / 'manifest.json'
IDENTITY = 'scripts/animation/sources/kratos/idle.webp'


def record(path):
    return {'path': str(path.relative_to(ROOT)), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}


other_assets = []
for name, target, size, mode, prompt, refs in [
    ('portrait-kratos-v2', 'menu/character-select/portrait-kratos.png', (256, 384), 'RGB', 'select-portrait-v2',
     ['public/assets/menu/character-select/portrait-ironclad.png',
      'scripts/art/sources/kratos/character-kratos-wallpaper.webp', IDENTITY]),
    ('character-kratos-wallpaper', 'menu/character-select/character-kratos-wallpaper.webp', (1536, 864), 'RGB', 'select-wallpaper',
     ['public/assets/menu/character-select/character-ironclad-wallpaper.webp',
      'public/assets/menu/character-select/character-hermit-wallpaper.webp', IDENTITY]),
]:
    source = SOURCE / f'{name}.webp'
    image = Image.open(source).convert(mode)
    source_size = image.size
    # Preserve the wallpaper's head and quiet left half; crop only the bottom.
    if name == 'character-kratos-wallpaper':
        image = image.crop((0, 0, 1536, 864))
    image = image.resize(size, Image.Resampling.LANCZOS)
    output = ROOT / f'public/assets/{target}'
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.suffix == '.webp': image.save(output, 'WEBP', quality=90, method=6)
    else: image.save(output, optimize=True)
    other_assets.append({'source': record(source), 'sourceSize': source_size,
                         'outputSize': size, 'output': record(output),
                         'prompt': record(DOCS / f'prompts/{prompt}.txt'),
                         'references': [record(ROOT / p) for p in refs],
                         'background': 'transparent' if mode == 'RGBA' else 'opaque'})
manifest = json.loads(MANIFEST.read_text())
manifest['otherAssets'] = other_assets
MANIFEST.write_text(json.dumps(manifest, indent=2) + '\n')
print(f'Exported {len(other_assets)} menu assets')
