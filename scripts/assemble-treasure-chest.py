"""Assemble screenshot-extracted RGBA chest layers into a stable opening.
Usage: uv run --with pillow python scripts/assemble-treasure-chest.py
The original image-model alpha is preserved; masks only separate lid from base.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageChops

root = Path(__file__).resolve().parents[1]
assets = root / 'public/assets/noncombat/treasure'
opened = Image.open(root / 'scripts/animation/treasure-source/chest-open-source.png').convert('RGBA')
closed = Image.open(root / 'scripts/animation/treasure-source/chest-closed-source.png').convert('RGBA')
size = opened.size

def split(image, points):
    mask = Image.new('L', size)
    ImageDraw.Draw(mask).polygon(points, fill=255)
    part = image.copy()
    part.putalpha(ImageChops.multiply(image.getchannel('A'), mask))
    return part

# The reference hinge runs diagonally across the three-quarter-view chest.
inner = split(opened, [(0,0),(1536,0),(1536,515),(1265,515),(680,450),(0,450)])
base = opened.copy()
base.putalpha(ImageChops.subtract(opened.getchannel('A'), inner.getchannel('A')))
outer = split(closed, [(0,0),(1536,0),(1536,493),(1315,493),(950,565),(315,480),(0,480)])
# Match the three front-rim anchors to the fixed base; never animate the body.
# Affine inverse of source (315,480),(950,565),(1315,493) -> target (376,500),(945,585),(1265,520).
outer = outer.transform(size, Image.Transform.AFFINE, (1.11702,.02586,-117.94,-.00466,1.00447,-20.48), Image.Resampling.BICUBIC)

def hinged(image, scale, lift=0):
    slope = 65/585
    intercept = 450 - slope*680
    return image.transform(size, Image.Transform.AFFINE,
        (1,0,0,slope*(1-1/scale),1/scale,intercept*(1-1/scale)+lift/scale), Image.Resampling.BICUBIC)

frames = []
for frame in range(19):
    t = frame / 18
    eased = 1-(1-t)**3
    image = base.copy()
    inside = hinged(inner, max(.025,eased))
    outside = hinged(outer, 1-.5*eased, 110*eased)
    outside.putalpha(outside.getchannel('A').point(lambda a: round(a*max(0,1-eased*1.8))))
    image.alpha_composite(inside)
    image.alpha_composite(outside)
    frames.append(image)
frames[-1] = opened
frames[0].save(assets/'chest-closed.webp', quality=92)
frames[-1].save(assets/'chest-open.webp', quality=92)
frames[0].save(assets/'chest-opening.webp',save_all=True,append_images=frames[1:],duration=[110]+[28]*18,loop=1,quality=90)
print('Saved closed, open and 614 ms one-shot opening from extracted artwork.')
