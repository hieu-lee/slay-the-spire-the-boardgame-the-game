#!/usr/bin/env python3
"""Export selected image-model sources; no generation API calls are made here."""
import hashlib
import json
from pathlib import Path
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'scripts/art/sources/kratos'
DOCS = ROOT / 'docs/kratos-card-art'
PLAN = json.loads((DOCS / 'plan.json').read_text())
OVERRIDES = {
    'kratos_golden_fleece': 'golden-fleece',
    'kratos_cronos_rage': 'cronos-rage',
    'kratos_head_of_helios': 'head-of-helios',
    'kratos_head_of_euryale': 'head-of-euryale',
}


def record(path):
    return {'path': str(path.relative_to(ROOT)), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}


def card_export(image, path):
    image = ImageOps.fit(image.convert('RGB'), (748, 420), method=Image.Resampling.LANCZOS)
    path.parent.mkdir(parents=True, exist_ok=True)
    for quality in (90, 85, 80, 75, 70, 65, 60, 55, 50, 45):
        image.save(path, 'WEBP', quality=quality, method=6)
        if path.stat().st_size <= 40 * 1024:
            return quality
    raise ValueError(f'{path.name}: card art exceeds 40 KiB')


manifest = {'model': PLAN['model'], 'sourceCommit': PLAN['sourceCommit'], 'quality': 'high',
            'cardSize': [748, 420], 'cardSourceSize': [1536, 1024],
            'references': [record(ROOT / p) for p in [*PLAN['styleReferences'], PLAN['identityReference']]],
            'cards': [], 'otherAssets': []}
for sheet in PLAN['sheets']:
    for index, card in enumerate(sheet['cards']):
        name = OVERRIDES.get(card, sheet['sheet'])
        source = SOURCE / f'{name}.webp'
        image = Image.open(source)
        assert image.size == (1536, 1024), source
        crop = None
        if card not in OVERRIDES:
            x, y = (index % 2) * 768, (index // 2) * 512
            crop = [x, y, x + 768, y + 512]
            image = image.crop(crop)
        target = ROOT / f'public/assets/card-art/kratos/{card}.webp'
        quality = card_export(image, target)
        manifest['cards'].append({'id': card, 'source': record(source), 'quadrant': crop,
                                  'prompt': record(DOCS / f'prompts/{name}.txt'),
                                  'output': record(target), 'webpQuality': quality})

for name, target, size, mode, prompt, refs in [
    ('menu-icon', 'menu/compendium-icons/kratos.webp', (256, 256), 'RGBA', 'menu-icon',
     ['public/assets/menu/compendium-icons/ironclad.webp', 'public/assets/menu/compendium-icons/hermit.webp', PLAN['identityReference']]),
    ('ashes-of-sparta', 'relic-icons/ashes_of_sparta.png', (256, 256), 'RGBA', 'relic',
     ['public/assets/relic-icons/burning_blood.png', 'public/assets/relic-icons/cracked_core.png']),
    ('portrait-kratos-v2', 'menu/character-select/portrait-kratos.png', (256, 384), 'RGB', 'select-portrait-v2',
     ['public/assets/menu/character-select/portrait-ironclad.png',
      'scripts/art/sources/kratos/character-kratos-wallpaper.webp', PLAN['identityReference']]),
    ('character-kratos-wallpaper', 'menu/character-select/character-kratos-wallpaper.webp', (1536, 864), 'RGB', 'select-wallpaper',
     ['public/assets/menu/character-select/character-ironclad-wallpaper.webp',
      'public/assets/menu/character-select/character-hermit-wallpaper.webp', PLAN['identityReference']]),
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
    manifest['otherAssets'].append({'source': record(source), 'sourceSize': source_size,
                                    'outputSize': size, 'output': record(output),
                                    'prompt': record(DOCS / f'prompts/{prompt}.txt'),
                                    'references': [record(ROOT / p) for p in refs],
                                    'background': 'transparent' if mode == 'RGBA' else 'opaque'})
(DOCS / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(f'Exported {len(manifest["cards"])} illustrations and {len(manifest["otherAssets"])} assets')
