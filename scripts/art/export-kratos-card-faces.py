"""Export selected model-authored full card faces and their phone thumbnails."""
import hashlib
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
DOCS = ROOT / 'docs/kratos-card-faces'
SOURCE = ROOT / 'scripts/art/sources/kratos-card-faces'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def export_face(face):
    key = face['assetKey']
    source = SOURCE / f'{key}.webp'
    with Image.open(source) as image:
        assert image.mode == 'RGBA', f'{key}: lost native alpha'
        outputs = []
        for folder, size in [('cards', (744, 1039)), ('cards-sm', (448, 626))]:
            target = ROOT / f'public/assets/{folder}/{key}.webp'
            target.parent.mkdir(parents=True, exist_ok=True)
            image.resize(size, Image.Resampling.LANCZOS).save(target, quality=75, method=3)
            outputs.append({'path': str(target.relative_to(ROOT)), 'sha256': digest(target), 'size': size})
    return {
        'id': face['id'], 'upgraded': face['upgraded'], 'model': 'gpt-image-2.5-sunburst',
        'source': str(source.relative_to(ROOT)), 'sourceSha256': digest(source),
        'prompt': f'docs/kratos-card-faces/prompts/{key}.txt',
        'promptSha256': digest(DOCS / f'prompts/{key}.txt'),
        'references': [{'path': ref, 'sha256': digest(ROOT / ref)} for ref in face['references']],
        'outputs': outputs,
    }


def export():
    support = []
    for name, path, prompt, references in [
        ('energy-orb', 'icons/kratos-energy.png', 'energy-orb',
         ['scripts/art/sources/kratos-card-faces/red-orb-crop.png']),
        ('hud-energy-orb', 'combat/energy-orbs/kratos.webp', 'hud-energy-orb',
         ['public/assets/icons/kratos-energy.png', 'public/assets/menu/character-select/portrait-kratos.png']),
    ]:
        source = SOURCE / f'{name}.webp'
        target = ROOT / f'public/assets/{path}'
        with Image.open(source) as image:
            image = image.resize((256, 256), Image.Resampling.LANCZOS)
            image.save(target, **({'quality': 92, 'method': 3} if target.suffix == '.webp' else {}))
        support.append({
            'model': 'gpt-image-2.5-sunburst', 'background': 'transparent',
            'source': str(source.relative_to(ROOT)), 'sourceSha256': digest(source),
            'prompt': f'docs/kratos-card-faces/prompts/{prompt}.txt',
            'promptSha256': digest(DOCS / f'prompts/{prompt}.txt'),
            'references': [{'path': ref, 'sha256': digest(ROOT / ref)} for ref in references],
            'output': str(target.relative_to(ROOT)), 'outputSha256': digest(target),
        })
    (DOCS / 'support-assets.json').write_text(json.dumps(support, indent=2) + '\n')
    with ThreadPoolExecutor(max_workers=4) as pool:
        records = list(pool.map(export_face, json.loads((DOCS / 'plan.json').read_text())))
    (DOCS / 'manifest.json').write_text(json.dumps(records, indent=2) + '\n')
    print(f'Exported {len(records)} full faces and thumbnails')


if __name__ == '__main__':
    export()
