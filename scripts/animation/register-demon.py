"""Register Demon's existing flight/landing drawings at canonical body scale."""
import json
from pathlib import Path
from PIL import Image
ROOT = Path(__file__).resolve().parents[2]
size = json.loads((ROOT/'scripts/animation/rigs.json').read_text())['downfall_demon'].get('size', 400)
source = Image.open(ROOT/'scripts/animation/sources/downfall_demon.webp').convert('RGBA')
box = source.getbbox()
# The original drawings share pixel proportions. Use the canonical idle's ONE
# scale for both poses; raised fists and wings must not determine body size.
scale = min(size*.8/(box[2]-box[0]),size*.88/(box[3]-box[1]))
for pose in ('airborne','ground-slam'):
    frame = Image.open(ROOT/f'public/assets/combat/enemies/animations/downfall_demon-{pose}.webp').convert('RGBA')
    box = frame.getbbox()
    frame = frame.resize((round(frame.width*scale),round(frame.height*scale)),Image.Resampling.LANCZOS)
    canvas = Image.new('RGBA',(size,size))
    canvas.alpha_composite(frame,(round(size/2-(box[0]+box[2])/2*scale),round(size*.98)-round(box[3]*scale)))
    bounds=canvas.getbbox()
    assert bounds[0]>0 and bounds[1]>0 and bounds[2]<size and bounds[3]<size
    canvas.save(ROOT/f'public/assets/combat/rigged/downfall_demon-{pose}.webp',quality=90,method=4)
