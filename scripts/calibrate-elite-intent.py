"""Calibrate where an Elite or Boss telegraph sits above its painted head.

Run after replacing Elite/Boss art: python3 scripts/calibrate-elite-intent.py
Each art stores [idle aspect, idle top, static aspect, static top]: the canvas
width/height and the highest painted row, as a fraction of canvas height, over
every idle frame. CSS places the intent just above that row.
"""
import argparse
import json
from pathlib import Path
import subprocess
from multiprocessing import Pool
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
PAINTED = [255 if value > 96 else 0 for value in range(256)]


def measure(path):
    """[aspect, highest painted row / height] over every frame."""
    top, aspect = 1, 1
    with Image.open(path) as image:
        for index in range(getattr(image, 'n_frames', 1)):
            image.seek(index)
            alpha = image.getchannel('A') if 'A' in image.getbands() else image.convert('RGBA').getchannel('A')
            bounds = alpha.point(PAINTED).getbbox()
            assert bounds, f'{path}: empty artwork'
            top = min(top, bounds[1] / image.height)
            aspect = image.width / image.height
    return [round(aspect, 5), round(top, 5)]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='check without writing calibration')
    args = parser.parse_args()
    catalog = json.loads(subprocess.check_output([
        'node', '--experimental-strip-types', '--input-type=module', '-e',
        'import {ENEMIES} from "./src/game/enemies.ts"; import {WEBP_ONLY_ANIMATIONS} from "./src/game/assets.ts"; '
        'console.log(JSON.stringify({ids: [...new Set(Object.values(ENEMIES).filter(d=>d.isBoss||d.elite).map(d=>d.artId??d.id))], authored: [...WEBP_ONLY_ANIMATIONS]}));',
    ], cwd=ROOT))
    ids, authored = catalog['ids'], set(catalog['authored'])
    combat = ROOT / 'public/assets/combat'
    sleep = combat / 'enemies/animated'
    paths = [*(combat / ('enemies/animated' if art_id in authored else 'rigged') / f'{art_id}-idle.webp' for art_id in ids),
             *(combat / f'enemies/{art_id}.webp' for art_id in ids),
             sleep / 'lagavulin-sleep.webp', sleep / 'lagavulin-sleep-static.webp']
    with Pool() as pool:
        measured = pool.map(measure, paths)
    sizes = {art_id: [*measured[index], *measured[len(ids) + index]] for index, art_id in enumerate(ids)}
    # Sleeping Lagavulin shows its own poses, not the awake ones above.
    sizes['lagavulin_sleep'] = [*measured[-2], *measured[-1]]
    path = ROOT / 'src/ui/elite-art-head.json'
    if args.check:
        # Another Pillow/libwebp build may decode a lossy edge a pixel differently.
        committed = json.loads(path.read_text())
        assert committed.keys() == sizes.keys(), 'elite intent calibration is stale'
        for key, values in sizes.items():
            assert len(committed[key]) == len(values) and all(abs(a - b) <= .004 for a, b in zip(committed[key], values)), \
                f'{key}: elite intent calibration is stale'
    else:
        path.write_text('{\n' + ',\n'.join(
            f'  {json.dumps(key)}: {json.dumps(value)}' for key, value in sizes.items()) + '\n}\n')


if __name__ == '__main__':
    main()
