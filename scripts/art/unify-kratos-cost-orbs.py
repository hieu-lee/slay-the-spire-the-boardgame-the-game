"""Give every Kratos card face the cost orb of kratos__rare__red-orbs+.

1. Cut the benchmark orb (digit 1) and have gpt-image-2.5-sunburst restyle only the
   numeral for 0, 2 and 3 (cost-orb/orb-N.png).
2. Find the circle of each face's old orb from its dark rim, so edits stay inside it.
3. Paste the matching orb at the benchmark position, then ask the model to remove the
   fragments of the old orb. Only RGBA inside the old orb's footprint is taken from the
   model; everything else stays pixel-identical to the original face. The orb is pasted
   again on top so it stays pixel-exact.

Faces are rebuilt from the original faces in ORIGINAL_REF. A model sample is one API call;
cost-orb/face-samples.json names the sample (a, b, c) picked by eye for faces where the first
sample left traces or looked wrong. Raw samples are cached in $COST_ORB_CACHE (default
/tmp/kratos-cost-orb-cache); without that cache a rebuild re-samples the model and the picks
must be redone, so the committed source faces are the record of the result. Samples are keyed
by face and sample name only: delete the cache after changing a prompt, INNER, GLOW or the footprint.
Needs OPENAI_API_KEY and numpy.
"""
import base64
import io
import json
import os
import subprocess
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'scripts/art/sources/kratos-card-faces'
ORB = SOURCE / 'cost-orb'
CACHE = Path(os.environ.get('COST_ORB_CACHE', '/tmp/kratos-cost-orb-cache'))
BENCHMARK = SOURCE / 'kratos__rare__red-orbs+.webp'
MODEL = 'gpt-image-2.5-sunburst'
ORIGINAL_REF = 'a868070d'  # last commit with the faces' original, inconsistent cost orbs
CENTER, RADIUS, CROP_AT = (118.5, 142.5), 89, (18, 42)
INNER = 86  # model mask keeps the new orb untouched
GLOW = 8  # more footprint for the gold glow of upgraded faces
OLD_ORB_OVERRIDES = {'kratos__normal__atlas-quake': (121, 176, 90)}  # detection locks onto its inner rim
SAMPLES = json.loads((ORB / 'face-samples.json').read_text())

DIGIT_PROMPT = (
    'Edit the supplied card cost orb. Keep the red orb, its swirling red energy texture, dark maroon rim, '
    'lighting, size, position and circular silhouette EXACTLY as in the image. Change ONLY the numeral: '
    'replace the digit 1 with the digit {digit}, using the identical bold cream serif numeral style, same '
    'dark brown outline, same drop shadow, same size and center position. No other changes, no extra text, '
    'no glow, no ornaments. Fully transparent background outside the orb.')
RING_PROMPT = (
    'Image 1 is a finished board-game card with a red cost orb at the top left. Image 2 is the reference '
    'card showing the correct look: the orb sits on the frame corner with the plain red frame border and '
    'rounded transparent outer corner around it. In image 1, fragments of an OLDER, differently placed cost '
    'orb (dark red rim, glow, highlights) stick out from behind the correct orb. Using the mask, remove ONLY '
    'those leftover orb fragments and fill that area exactly as in the reference: continue the red frame '
    'border, the rounded card corner and the cream/yellow edge of the title ribbon, and make the area '
    'outside the card corner fully transparent. Do not change the correct orb or its digit, the title '
    'ribbon, the illustration, or anything outside the mask. Do not add any new orb, ornament, gem or text. '
    'Outside the rounded card corner there must be NO circular outline, halo, bulge, dark crescent, double '
    'rim or tan glow: that area is fully transparent, and a thin golden frame glow, if the card has one, '
    'follows the straight rounded-rectangle frame edge like the reference, never a circle.')


def png(image):
    buffer = io.BytesIO()
    image.save(buffer, 'PNG')
    return buffer.getvalue()


def edit(files, prompt, size):
    boundary = uuid.uuid4().hex
    parts = []
    for name, value in [('model', MODEL), ('prompt', prompt), ('background', 'transparent'),
                        ('quality', 'high'), ('size', size), ('output_format', 'png')]:
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    for name, data in files:
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; filename="{name}.png"\r\n'
                     'Content-Type: image/png\r\n\r\n'.encode() + data + b'\r\n')
    parts.append(f'--{boundary}--\r\n'.encode())
    request = urllib.request.Request(
        'https://api.openai.com/v1/images/edits', b''.join(parts),
        {'Authorization': f'Bearer {os.environ["OPENAI_API_KEY"]}',
         'Content-Type': f'multipart/form-data; boundary={boundary}'})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=600) as response:
                return Image.open(io.BytesIO(base64.b64decode(json.load(response)['data'][0]['b64_json']))).convert('RGBA')
        except OSError:
            if attempt == 2:
                raise


def benchmark_orb():
    face = Image.open(BENCHMARK).convert('RGBA')
    cx, cy = CENTER
    x0, y0 = CROP_AT
    crop = face.crop((x0, y0, x0 + 200, y0 + 200))
    mask = Image.new('L', (800, 800), 0)
    ImageDraw.Draw(mask).ellipse([(cx - x0 - RADIUS) * 4, (cy - y0 - RADIUS) * 4,
                                  (cx - x0 + RADIUS) * 4, (cy - y0 + RADIUS) * 4], fill=255)
    crop.putalpha(mask.resize((200, 200), Image.Resampling.LANCZOS))
    return crop


def build_orbs():
    base = benchmark_orb()
    base.save(ORB / 'benchmark-1.png')
    orbs = {'1': base}
    canvas = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0))
    canvas.alpha_composite(base.resize((800, 800), Image.Resampling.LANCZOS), (112, 112))
    for digit in '023':
        target = ORB / f'orb-{digit}.png'
        if not target.exists():
            raw = edit([('image[]', png(canvas))], DIGIT_PROMPT.format(digit=digit), '1024x1024')
            orb = raw.crop((112, 112, 912, 912)).resize((200, 200), Image.Resampling.LANCZOS)
            orb.putalpha(base.getchannel('A'))
            orb.save(target)
        orbs[digit] = Image.open(target).convert('RGBA')
    return orbs


def old_orb(key, face):
    """Circle (cx, cy, radius) of the face's old orb, found from its dark maroon rim."""
    if key in OLD_ORB_OVERRIDES:
        return OLD_ORB_OVERRIDES[key]
    a = np.array(face.crop((0, 0, 300, 300))).astype(int)
    red, green, blue, alpha = a[..., 0], a[..., 1], a[..., 2], a[..., 3]
    angles = np.linspace(0, 2 * np.pi, 120, endpoint=False)
    cos, sin = np.cos(angles), np.sin(angles)

    def search(rim):
        def on_rim(cx, cy, radius):
            x = np.rint(cx + radius * cos).astype(int)
            y = np.rint(cy + radius * sin).astype(int)
            inside = (x >= 0) & (x < 300) & (y >= 0) & (y < 300)
            hit = np.zeros(len(angles), bool)
            hit[inside] = rim[y[inside], x[inside]]
            return hit

        def score(cx, cy, radius):
            inner = on_rim(cx, cy, radius - 3) | on_rim(cx, cy, radius - 1)
            outer = on_rim(cx, cy, radius + 4) | on_rim(cx, cy, radius + 6)
            return (inner & ~outer).mean() + 0.002 * radius  # prefer the outer ring of a double rim

        coarse = [(score(cx, cy, radius), (cx, cy, radius))
                  for cx in range(70, 170, 4) for cy in range(95, 195, 4) for radius in range(72, 110, 3)]
        _, (bx, by, br) = max(coarse)
        return max((score(cx, cy, radius), (cx, cy, radius))
                   for cx in range(bx - 3, bx + 4) for cy in range(by - 3, by + 4)
                   for radius in range(br - 3, br + 4))

    for red_max, green_max, blue_max in ((135, 52, 62), (170, 75, 85)):
        rim = ((alpha > 200) & (red > 35) & (red < red_max) & (green < green_max) & (blue < blue_max)
               & (red - green > 25))
        best, circle = search(rim)
        if best > 0.7:
            return circle
    raise AssertionError(f'old orb not found (score {best:.2f})')


def disc(cx, cy, radius):
    mask = Image.new('L', (1024, 1536), 0)
    ImageDraw.Draw(mask).ellipse([cx - radius, cy - radius, cx + radius, cy + radius], fill=255)
    return mask


def footprint(key, circle):
    return circle[2] + 24 + (GLOW if key.endswith('+') else 0)


def original_face(key):
    path = (SOURCE / f'{key}.webp').relative_to(ROOT)
    blob = subprocess.check_output(['git', 'show', f'{ORIGINAL_REF}:{path}'], cwd=ROOT)
    return Image.open(io.BytesIO(blob)).convert('RGBA')


def sample(key, name, orb, reference):
    """Cached model sample: the original face with the new orb, old-orb footprint editable."""
    cache = CACHE / f'{key}-{name}.png'
    if not cache.exists():
        face = original_face(key)
        cx, cy, _ = circle = old_orb(key, face)
        face.alpha_composite(orb, CROP_AT)
        editable = ImageChops.subtract(disc(cx, cy, footprint(key, circle) + 6), disc(*CENTER, INNER))
        mask = Image.new('RGBA', face.size, (255, 255, 255, 255))
        mask.putalpha(ImageChops.invert(editable))
        raw = edit([('image[]', png(face)), ('image[]', png(reference)), ('mask', png(mask))], RING_PROMPT, '1024x1536')
        CACHE.mkdir(parents=True, exist_ok=True)
        raw.save(cache)
    return Image.open(cache).convert('RGBA')


def clear_outer_haze(face, limit):
    """Make transparent the dark halo left outside the card corner.

    Flood fills from the top-left corner through transparent and dark pixels; frame,
    glow and ribbon pixels stop the fill. Only pixels beyond the new orb are cleared.
    """
    pixels = face.load()
    cx, cy = CENTER

    def haze(x, y):
        r, g, b, a = pixels[x, y]
        return a == 0 or (a < 96 and r + g + b < 240) or (r + g + b < 150 and r < 80)

    seen, queue = {(0, 0)}, [(0, 0)]
    while queue:
        x, y = queue.pop()
        if (x - cx) ** 2 + (y - cy) ** 2 > (RADIUS + 2) ** 2:
            pixels[x, y] = (0, 0, 0, 0)
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nx < limit and 0 <= ny < limit and (nx, ny) not in seen and haze(nx, ny):
                seen.add((nx, ny))
                queue.append((nx, ny))


def render_face(key, name, orb, reference):
    face = original_face(key)
    circle = old_orb(key, face)
    raw = sample(key, name, orb, reference)
    face.alpha_composite(orb, CROP_AT)
    cx, cy, _ = circle
    # Feathered edge: the model re-renders the whole image, so a hard edge shows a seam.
    face.paste(raw, mask=disc(cx, cy, footprint(key, circle) - 6).filter(ImageFilter.GaussianBlur(3)))
    clear_outer_haze(face, 300)
    face.alpha_composite(orb, CROP_AT)
    return face


def fix_face(job):
    key, orb, reference = job
    render_face(key, SAMPLES.get(key, 'a'), orb, reference).save(SOURCE / f'{key}.webp', lossless=True, method=6)
    return key


def main():
    orbs = build_orbs()
    reference = Image.open(BENCHMARK).convert('RGBA')
    plan = json.loads((ROOT / 'docs/kratos-card-faces/plan.json').read_text())
    jobs = [(face['assetKey'], orbs[str(face['cost'])], reference)
            for face in plan if face['assetKey'] != 'kratos__rare__red-orbs+']
    with ThreadPoolExecutor(max_workers=6) as pool:
        for key in pool.map(fix_face, jobs):
            print('done', key, flush=True)


if __name__ == '__main__':
    main()
