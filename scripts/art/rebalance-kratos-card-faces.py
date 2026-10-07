"""Re-render the rules panel of Kratos card faces whose numbers changed in a balance pass.

Each changed face is edited in place: the first `generate` of a pass caches the approved
face as `rebalance/KEY-before.png`, which is both the model's edit target and the base that
`select` composites onto. The compact-effects mask limits the model to the rules
rectangle, and only that rectangle's RGB is composited back, so the illustration, title,
cost orb, frame and alpha stay pixel-identical. `plan.json` holds the new printed text and
compact layout per face. Delete a face's cached `-before.png` before starting a later pass,
or edits made to that face since this pass would be reverted.

    python3 scripts/art/rebalance-kratos-card-faces.py generate KEY...   sample the model
    python3 scripts/art/rebalance-kratos-card-faces.py select KEY=N...   composite picked samples
"""
import hashlib
import json
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
DOCS = ROOT / 'docs/kratos-card-faces'
SOURCE = ROOT / 'scripts/art/sources/kratos-card-faces'
BEFORE = SOURCE / 'rebalance'
SAMPLES = ROOT / 'artifacts/kratos-rebalance'
IMAGE_GEN = [str(Path.home() / '.cache/kratos-imagegen-venv/bin/python'),
             str(Path.home() / '.codex/skills/.system/imagegen/scripts/image_gen.py')]
PLAN = json.loads((DOCS / 'plan.json').read_text())
FACES = {face['assetKey']: face for face in PLAN}
BOXES = {face['assetKey']: face['box'] for face in json.loads((DOCS / 'compact-effects.json').read_text())['faces']}


def prompt_for(face):
    """The compact-effects prompt with this face's current mechanics and layout."""
    text = (DOCS / f"prompts/{face['assetKey']}.txt").read_text()
    text = re.sub(r'Canonical mechanics \(meaning only, NOT text to render\): ".*"',
                  lambda _: f'Canonical mechanics (meaning only, NOT text to render): "{face["printedText"]}"', text)
    return re.sub(r'(Exact compact rules layout to render, with bracketed markers replaced by their supplied pictorial glyphs:\n)'
                  r'.*?(\nUse large legible)', lambda m: m.group(1) + face['symbolText'] + m.group(2), text, flags=re.S)


def generate(key):
    face = FACES[key]
    BEFORE.mkdir(parents=True, exist_ok=True)
    before = BEFORE / f'{key}-before.png'
    if not before.exists():
        Image.open(SOURCE / f'{key}.webp').save(before)
    references = [str(before.relative_to(ROOT))] + [ref for ref in face['references'][1:] if not ref.endswith('-mask.png')]
    mask = next(ref for ref in face['references'] if ref.endswith('-mask.png'))
    face['references'] = references + [mask]
    prompt = prompt_for(face)
    (DOCS / f'prompts/{key}.txt').write_text(prompt)
    SAMPLES.mkdir(parents=True, exist_ok=True)
    command = [*IMAGE_GEN, 'edit', '--model', 'gpt-image-2.5-sunburst', '--mask', str(ROOT / mask),
               '--prompt-file', str(DOCS / f'prompts/{key}.txt'), '--n', '2', '--size', '1024x1536',
               '--quality', 'high', '--background', 'transparent', '--output-format', 'png', '--no-augment',
               '--out', str(SAMPLES / f'{key}.png'), '--force']
    for reference in references:
        command += ['--image', str(ROOT / reference)]
    for _ in range(3):
        result = subprocess.run(command, capture_output=True, text=True)
        if result.returncode == 0:
            return key
    raise RuntimeError(f'{key}: image generation failed: {result.stderr.strip()[-500:]}')


def select(key, sample):
    face_path = SOURCE / f'{key}.webp'
    face = Image.open(BEFORE / f'{key}-before.png').convert('RGBA')
    model = Image.open(SAMPLES / f'{key}-{sample}.png').convert('RGBA')
    box = tuple(BOXES[key])
    rules = model.crop(box)
    rules.putalpha(face.crop(box).getchannel('A'))
    face.paste(rules, box[:2])
    face.save(face_path, lossless=True, quality=100, method=6)
    return key, hashlib.sha256((SAMPLES / f'{key}-{sample}.png').read_bytes()).hexdigest()


if __name__ == '__main__':
    command, *keys = sys.argv[1:]
    if command == 'generate':
        with ThreadPoolExecutor(5) as pool:
            for done in pool.map(generate, keys):
                print('generated', done)
        (DOCS / 'plan.json').write_text(json.dumps(PLAN, indent=2) + '\n')
    elif command == 'select':
        picks = [(key, int(sample)) for key, sample in (pick.split('=') for pick in keys)]
        record = DOCS / 'rebalance.json'
        models = json.loads(record.read_text()) if record.exists() else {}
        with ThreadPoolExecutor(5) as pool:
            for (key, sample), (_, model) in zip(picks, pool.map(lambda pick: select(*pick), picks)):
                models[key] = {'sample': sample, 'box': BOXES[key], 'modelOutputSha256': model,
                               'input': str((BEFORE / f'{key}-before.png').relative_to(ROOT))}
                print('selected', key, sample)
        record.write_text(json.dumps(dict(sorted(models.items())), indent=2) + '\n')
    else:
        raise SystemExit(__doc__)
