"""Register Demon's existing flight/landing drawings at canonical body scale."""
from pathlib import Path
from PIL import Image
ROOT = Path(__file__).resolve().parents[2]
source = Image.open(ROOT/'scripts/animation/sources/downfall_demon.webp').convert('RGBA')
box = source.getbbox()
# The original drawings share pixel proportions. Use the canonical idle's ONE
# scale for both poses; raised fists and wings must not determine body size.
scale = min(400*.8/(box[2]-box[0]),400*.88/(box[3]-box[1]))
for pose in ('airborne','ground-slam'):
    frame = Image.open(ROOT/f'public/assets/combat/enemies/animations/downfall_demon-{pose}.webp').convert('RGBA')
    box = frame.getbbox()
    frame = frame.resize((round(frame.width*scale),round(frame.height*scale)),Image.Resampling.LANCZOS)
    canvas = Image.new('RGBA',(400,400))
    canvas.alpha_composite(frame,(round(200-(box[0]+box[2])/2*scale),392-round(box[3]*scale)))
    bounds=canvas.getbbox()
    assert bounds[0]>0 and bounds[1]>0 and bounds[2]<400 and bounds[3]<400
    canvas.save(ROOT/f'public/assets/combat/rigged/downfall_demon-{pose}.webp',quality=90,method=4)
