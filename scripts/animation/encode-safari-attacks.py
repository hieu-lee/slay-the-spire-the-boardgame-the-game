"""Export pixel-identical APNG attacks; Safari's WebP decoder stretches frames.

Run after regenerating the source WebPs. Chrome keeps its existing exports.
"""
import argparse
import json
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
NAMES = ['looter', 'mugger', 'book_of_stabbing', 'gremlin_nob', 'lagavulin',
         'sentry', 'gremlin_leader', 'taskmaster', 'giant_head', 'nemesis',
         'reptomancer', 'spire_shield', 'spire_spear', 'red_slaver', 'blue_slaver']

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--only', default=','.join(NAMES))
    args = parser.parse_args()
    rigs = json.loads((ROOT / 'scripts/animation/rigs.json').read_text())
    for name in args.only.split(','):
        assert name in NAMES, name
        source = ROOT / rigs[name]['output'] / f'{name}-attack.webp'
        frames, durations = [], []
        with Image.open(source) as image:
            for index in range(image.n_frames):
                image.seek(index)
                image.load()
                frames.append(image.convert('RGBA'))
                durations.append(image.info['duration'])
        output = source.with_suffix('.png')
        frames[0].save(output, save_all=True, append_images=frames[1:],
                       duration=durations, loop=1, disposal=0, blend=0, compress_level=9)
        print(f'{output.relative_to(ROOT)}: {len(frames)} frames, {sum(durations)}ms')
