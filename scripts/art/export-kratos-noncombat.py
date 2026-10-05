"""Export the committed model artwork into the existing noncombat asset formats."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
SOURCES = ROOT / 'scripts/art/sources/kratos-noncombat'

merchant = Image.open(SOURCES / 'merchant.webp').convert('RGBA')
box = merchant.getchannel('A').getbbox()
merchant = merchant.crop((0, max(0, box[1] - 12), merchant.width, min(merchant.height, box[3] + 12)))
merchant.thumbnail((576, 576), Image.Resampling.LANCZOS)
merchant.save(ROOT / 'public/assets/noncombat/merchant/characters/kratos-standing.webp', quality=88, method=6)

hands = Image.open(SOURCES / 'treasure-hands.webp').convert('RGBA')
for index, pose in enumerate(['hand', 'grip']):
    hands.crop((index * 512, 0, (index + 1) * 512, 1536)).resize(
        (384, 1024), Image.Resampling.LANCZOS).save(
            ROOT / f'public/assets/noncombat/treasure/{pose}-kratos.webp', quality=88, method=6)


def export_scene(source):
    scene = Image.open(source).convert('RGB')
    assert scene.size == (1536, 864), (source, scene.size)
    scene.resize((3840, 2161), Image.Resampling.LANCZOS).save(
        ROOT / 'public/assets/noncombat/campfire' / source.name, quality=50, method=6)


with ThreadPoolExecutor(max_workers=4) as pool:
    list(pool.map(export_scene, sorted(SOURCES.glob('*_firecamp.webp'))))
