"""Calibrate where a hero's held potions and Orbs sit above the painted head.

Run after replacing hero art: python3 scripts/calibrate-hero-head.py
Each hero state stores [animated, static]: the painted head's height above the
portrait floor in stage-actor widths, before the rig scale. The portrait is one
actor wide and 1.2 tall, the art is fitted to it (contain, bottom aligned), so
that is min(1.2, 1 / aspect) * (1 - highest painted row / height) over every frame.
"""
import argparse
import json
from multiprocessing import Pool
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
PAINTED = [255 if value > 96 else 0 for value in range(256)]
COMBAT = ROOT / 'public/assets/combat'
# Hero state -> ([animated art], [static art]), mirroring CombatScreen's seat portrait.
STATES = {
    **{hero: ([f'rigged/hero-{hero}-idle.webp'], [f'characters/{hero}-hero.webp'])
       for hero in ('ironclad', 'silent', 'defect', 'hermit', 'slime_boss')},
    'watcher': (['characters/watcher-hero.webp'], ['characters/watcher-hero.webp']),
    'guardian': (['rigged/hero-guardian-idle.webp'], ['characters/guardian-hero.webp']),
    'guardian-defense': (['rigged/hero-guardian-defense-idle.webp'], ['characters/guardian-defense.webp']),
    **{f'hexaghost-heat-{heat}': ([f'rigged/hero-hexaghost-heat-{heat}-idle.webp'], [f'characters/hexaghost-heat-{heat}.webp'])
       for heat in range(7)},
    # Shown instead of the idle pose for a moment: the Slime Boss spawn and the Guardian mode shifts.
    'slime_boss-spawn': (['characters/slime_boss-spawn.webp'],) * 2,
    'guardian-transition': (['characters/guardian-to-attack.webp', 'characters/guardian-to-defense.webp'],) * 2,
}


def head_height(path):
    """Painted head height above the floor, in actor widths (before rig scale)."""
    top, aspect = 1, 1
    with Image.open(COMBAT / path) as image:
        for index in range(getattr(image, 'n_frames', 1)):
            image.seek(index)
            alpha = image.getchannel('A') if 'A' in image.getbands() else image.convert('RGBA').getchannel('A')
            bounds = alpha.point(PAINTED).getbbox()
            assert bounds, f'{path}: empty artwork'
            top = min(top, bounds[1] / image.height)
            aspect = image.width / image.height
    return round(min(1.2, 1 / aspect) * (1 - top), 4)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='check without writing calibration')
    args = parser.parse_args()
    paths = sorted({path for pair in STATES.values() for group in pair for path in group})
    with Pool() as pool:
        heights = dict(zip(paths, pool.map(head_height, paths)))
    # The highest of several arts keeps the potions clear of every one of them.
    sizes = {state: [max(heights[path] for path in animated), max(heights[path] for path in static)]
             for state, (animated, static) in STATES.items()}
    path = ROOT / 'src/ui/hero-art-head.json'
    if args.check:
        # Another Pillow/libwebp build may decode a lossy edge a pixel differently.
        committed = json.loads(path.read_text())
        assert committed.keys() == sizes.keys(), 'hero head calibration is stale'
        for key, values in sizes.items():
            assert len(committed[key]) == len(values) and all(abs(a - b) <= .004 for a, b in zip(committed[key], values)), \
                f'{key}: hero head calibration is stale'
    else:
        path.write_text('{\n' + ',\n'.join(
            f'  {json.dumps(key)}: {json.dumps(value)}' for key, value in sizes.items()) + '\n}\n')


if __name__ == '__main__':
    main()
