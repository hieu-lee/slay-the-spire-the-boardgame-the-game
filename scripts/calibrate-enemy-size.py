"""Calibrate normal enemy canvases from resting alpha silhouettes, never attack frames.

Run after replacing enemy/rig assets: python3 scripts/calibrate-enemy-size.py
Reference screenshots: Cultist body ~0.94 hero / raised props ~1.22; Jaw Worm ~0.57.
Ironclad's default painted height is ~0.63 of the stage actor width.
"""
import json
from pathlib import Path
import subprocess
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
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
sizes = {}
for art_id in ids:
    if art_id == 'sentry':  # Sentry summons share the elite presentation.
        continue
    values = []
    for animated in (True, False):
        path = f'rigged/{art_id}-idle' if animated else f'enemies/{art_id}'
        with Image.open(ROOT / f'public/assets/combat/{path}.webp') as image:
            alpha = image.convert('RGBA').getchannel('A')
            bounds = alpha.point(lambda a: 255 if a > 96 else 0).getbbox()
            assert bounds, f'{path}: empty artwork'
            scale = rigs.get(art_id, {}).get('scale', 1) if animated else 1
            fit = .63 * heights.get(art_id, 1) / (bounds[3] - bounds[1]) / scale
            values.extend(round(dimension * fit, 5) for dimension in image.size)
    sizes[art_id] = [*values, round(.63 * heights.get(art_id, 1), 5)]
# [idle width, idle height, static width, static height, body height], in actor widths.
(ROOT / 'src/ui/enemy-art-size.json').write_text('{\n' + ',\n'.join(
    f'  {json.dumps(key)}: {json.dumps(value)}' for key, value in sizes.items()) + '\n}\n')
