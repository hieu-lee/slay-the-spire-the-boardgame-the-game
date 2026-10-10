#!/usr/bin/env python3
"""Export the selected sources: 748x420 text-free art (<= 40 KiB, the CSS fallback face) and the manifest.
No API calls. Run after `generate.py select`.

  python3 scripts/art/skin-cards/export.py
"""
import hashlib
import json

from PIL import Image, ImageOps

from skincards import HERE, ROOT, load_catalogue

PLAN = json.loads((HERE / 'plan.json').read_text())
SELECTIONS = json.loads((HERE / 'selections.json').read_text())
REFS = {r['tag']: r for r in json.loads((HERE / 'refs.json').read_text())}
DOCS = ROOT / 'docs/skins/kratos-card-art'
OUT = ROOT / 'public/assets/skin-card-art/kratos/ironclad'


def record(path):
    return {'path': str(path.relative_to(ROOT)), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}


def export(image, path):
    image = ImageOps.fit(image.convert('RGB'), (748, 420), method=Image.Resampling.LANCZOS)
    path.parent.mkdir(parents=True, exist_ok=True)
    for quality in (90, 85, 80, 75, 70, 65, 60, 55, 50, 45, 40, 35, 30):
        image.save(path, 'WEBP', quality=quality, method=6)
        if path.stat().st_size <= 40 * 1024:
            return quality
    raise ValueError(f'{path.name}: card art exceeds 40 KiB')


def main():
    manifest = {'model': PLAN['model'], 'quality': PLAN['quality'], 'size': PLAN['size'], 'cardSize': [748, 420],
                'references': [record(ROOT / p) for p in [*PLAN['styleReferences'], PLAN['identityReference']]],
                'gameImages': {tag: {k: REFS[tag][k] for k in ('title', 'page', 'url', 'sha256')}
                               for tag in sorted({t for c in PLAN['cards'].values() for t in c['refs']})},
                'cards': []}
    for card in load_catalogue():
        selection = SELECTIONS.get(card['id'])
        if not selection:
            continue
        source = ROOT / selection['source']
        target = OUT / f"{card['id']}.webp"
        quality = export(Image.open(source), target)
        entry = PLAN['cards'][card['id']]
        manifest['cards'].append({'id': card['id'], 'scene': entry['scene'], 'gameImages': entry['refs'],
                                  'candidate': selection['candidate'], 'source': record(source),
                                  'prompt': record(DOCS / f"prompts/{card['id']}.txt"),
                                  'output': record(target), 'webpQuality': quality})
        print(card['id'], target.stat().st_size)
    (DOCS / 'manifest.json').write_text(json.dumps(manifest, indent=1) + '\n')


if __name__ == '__main__':
    main()
