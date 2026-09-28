"""Calibrate normal enemy canvases from resting alpha silhouettes, never attack frames.

Run after replacing enemy/rig assets: python3 scripts/calibrate-enemy-size.py
Reference screenshots: Cultist body ~0.94 hero / raised props ~1.22; Jaw Worm ~0.57.
Ironclad's default painted height is ~0.63 of the stage actor width.
"""
import json
import argparse
from pathlib import Path
import subprocess
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--only', help='comma-separated enemy art IDs')
parser.add_argument('--check', action='store_true', help='check without writing calibration')
args = parser.parse_args()
ids = json.loads(subprocess.check_output([
    'node', '--experimental-strip-types', '--input-type=module', '-e',
    'import {ENEMIES} from "./src/game/enemies.ts"; console.log(JSON.stringify([...new Set(Object.values(ENEMIES).filter(d=>!d.isBoss&&!d.elite).map(d=>d.artId??d.id))]));',
], cwd=ROOT))
# Total resting silhouette height relative to Ironclad, including held props.
heights = {
    'cultist': 1.22, 'jaw_worm': .57, 'small_slime': .4, 'acid_slime': .55,
    'spike_slime': .6, 'large_slime': .8, 'green_louse': .35, 'red_louse': .35,
    'fungi_beast': .65, 'mad_gremlin': .7, 'sneaky_gremlin': .7,
    'gremlin_wizard': .85, 'fat_gremlin': .85, 'byrd': .8,
    'snake_plant': 1.2, 'shelled_parasite': .95, 'snecko': 1.2,
    'spheric_guardian': .7, 'spire_growth': 1.3, 'repulsor': .6,
    'exploder': .6, 'orb_walker': .85, 'transient': 1.5, 'maw': 1.3,
    'writhing_mass': .95, 'darkling': .5, 'spiker': .65, 'dagger': .65,
    'torch_head': 1.1, 'bronze_orb': .8, 'downfall_dark_orb': .55,
    'downfall_lightning_orb': .55, 'downfall_frost_orb': .55,
    'downfall_shiv': .4, 'downfall_loot_chest': .85,
}
rigs = json.loads((ROOT / 'src/ui/rig-animation-metadata.json').read_text())
sources = json.loads((ROOT / 'scripts/animation/rigs.json').read_text())
size_path = ROOT / 'src/ui/enemy-art-size.json'
sizes = json.loads(size_path.read_text()) if args.only else {}
if args.only:
    selected = set(args.only.split(','))
    assert selected <= set(ids), f'unknown normal enemy art: {selected-set(ids)}'
    ids = [art_id for art_id in ids if art_id in selected]
for art_id in ids:
    if art_id == 'sentry':  # Sentry summons share the elite presentation.
        continue
    values = []
    for animated in (True, False):
        path = (ROOT / sources[art_id]['output'] / f'{art_id}-idle.webp' if animated
                else ROOT / f'public/assets/combat/enemies/{art_id}.webp')
        with Image.open(path) as image:
            alpha = image.convert('RGBA').getchannel('A')
            bounds = alpha.point(lambda a: 255 if a > 96 else 0).getbbox()
            assert bounds, f'{path}: empty artwork'
            scale = rigs.get(art_id, {}).get('scale', 1) if animated else 1
            fit = .63 * heights.get(art_id, 1) / (bounds[3] - bounds[1]) / scale
            values.extend(round(dimension * fit, 5) for dimension in image.size)
    # Raised wings need HUD clearance independent of the resting body scale.
    hud_height = max(.63 * heights.get(art_id, 1), .62 if art_id == 'byrd' else 0)
    sizes[art_id] = [*values, round(hud_height, 5)]
# [idle width, idle height, static width, static height, body height], in actor widths.
content = '{\n' + ',\n'.join(
    f'  {json.dumps(key)}: {json.dumps(value)}' for key, value in sizes.items()) + '\n}\n'
if args.check:
    assert size_path.read_text() == content, 'enemy size calibration is stale'
else:
    size_path.write_text(content)
