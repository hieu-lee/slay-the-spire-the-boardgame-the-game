"""Roll the canonical closed shell without unfolding, warping or resizing it."""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT/'public/assets/combat/rigged'
idle = Image.open(OUT/'hero-guardian-defense-idle.webp').convert('RGBA')
box = idle.getbbox()
shell = idle.crop(box)
center, ground = (box[0]+box[2])/2, box[3]
frames = []
for t in range(0,1650,25):
    # Same travel clock and smoothstep easing as guardian-roll-travel in CSS.
    u = min(1,max(0,(t-200)/430)) if t < 850 else 1-min(1,max(0,(t-850)/550))
    angle = 360*u*u*(3-2*u)
    rotated = shell.rotate(-angle,Image.Resampling.BICUBIC,expand=True)
    rotated = rotated.crop(rotated.getbbox())
    frame = Image.new('RGBA',idle.size)
    frame.alpha_composite(rotated,(round(center-rotated.width/2),ground-rotated.height))
    frames.append(frame)
frames[0] = frames[-1] = idle
frames[0].save(OUT/'hero-guardian-defense-attack.webp',save_all=True,
    append_images=frames[1:],duration=[25]*len(frames),loop=1,quality=88,method=4)
print('Guardian defense: rigid shell rolls out and back; 1650ms')
