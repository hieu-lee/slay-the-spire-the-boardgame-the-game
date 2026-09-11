"""Bake a reusable smoke mask; gameplay animates only small textured puffs."""
from pathlib import Path
import random
from PIL import Image, ImageDraw, ImageFilter, ImageChops

rng = random.Random(37)
size = 128
alpha = Image.new('L', (size, size))
for _ in range(35):
    puff = Image.new('L', (size, size))
    draw = ImageDraw.Draw(puff)
    x, y = rng.gauss(64, 18), rng.gauss(64, 13)
    radius = rng.uniform(8, 22)
    draw.ellipse((x-radius, y-radius*.7, x+radius, y+radius*.7), fill=rng.randint(90, 190))
    alpha = ImageChops.lighter(alpha, puff.filter(ImageFilter.GaussianBlur(5)))
noise = Image.new('L', (8, 8))
noise.putdata([rng.randint(70, 255) for _ in range(8*8)])
noise = noise.resize((size, size), Image.Resampling.BICUBIC).filter(ImageFilter.GaussianBlur(1))
alpha = ImageChops.multiply(alpha, noise).filter(ImageFilter.GaussianBlur(2))
image = Image.new('RGBA', (size, size), 'white')
image.putalpha(alpha)
output = Path(__file__).resolve().parents[1] / 'public/assets/combat/card-smoke.webp'
output.parent.mkdir(parents=True, exist_ok=True)
image.save(output, lossless=True)
print(output)
