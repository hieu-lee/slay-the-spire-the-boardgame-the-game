"""Preserve the existing drawn unfold/fold around the defensive claw attack."""
from pathlib import Path
import math
import numpy as np
from PIL import Image
from authored import frames_at

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT/'public/assets/combat/rigged'
idle = Image.open(OUT/'hero-guardian-defense-idle.webp').convert('RGBA')
fold, _ = frames_at(ROOT/'public/assets/combat/characters/guardian-to-defense.webp')
area = lambda image: sum(image.getchannel('A').histogram()[33:])
scale = math.sqrt(area(idle)/area(fold[-1]))
ground = idle.getbbox()[3]
center = (idle.getbbox()[0]+idle.getbbox()[2])/2

def register(image, factor):
    box = image.getbbox()
    foot = image.getchannel('A').crop((0,round(box[1]+(box[3]-box[1])*.8),image.width,box[3])).getbbox()
    x = (foot[0]+foot[2])/2
    result = Image.new('RGBA',idle.size)
    image = image.resize((round(image.width*factor),round(image.height*factor)),Image.Resampling.LANCZOS)
    result.alpha_composite(image,(round(center-x*factor),ground-round(box[3]*factor)))
    return result

fold = [register(frame,scale) for frame in fold]
fold[-1] = idle
attack, ends = frames_at(OUT/'hero-guardian-attack.webp')
attack_scale = math.sqrt(area(fold[0])/area(attack[0]))
attack = [register(frame,attack_scale) for frame in attack]
times = list(range(0,1650,25))
frames = []
for t in times:
    if t < 550:
        frame = fold[4-min(4,round(t/550*4))]
    elif t < 1100:
        frame = attack[min(len(attack)-1,int(np.searchsorted(ends,t,side='right')))]
    else:
        frame = fold[min(4,round((t-1100)/550*4))]
    frames.append(frame.rotate(.25*math.sin(2*math.pi*t/1650),Image.Resampling.BICUBIC,center=(center,ground)))
frames[0] = frames[-1] = idle
frames[0].save(OUT/'hero-guardian-defense-attack.webp',save_all=True,
    append_images=frames[1:],duration=[25]*len(frames),loop=1,quality=88,method=4)
print('Guardian defense: existing unfold, claw action, existing fold; 1650ms')
