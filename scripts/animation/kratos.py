"""Bake the audited Sunburst drawings without morphing limbs or scaling bodies.

Run from any directory with python3 scripts/animation/kratos.py.
Native alpha stays intact; registration.json supplies inspected skull/sole landmarks.
"""
import json
import math
from pathlib import Path

from PIL import Image, ImageChops

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'scripts/animation/sources/kratos'
OUT = ROOT / 'public/assets/combat/characters'
REG = json.loads((SOURCE / 'registration.json').read_text())
SIZE = REG['runtimeCanvas']


def drawing(name):
    image = Image.open(SOURCE / f'{name}.webp').convert('RGBA')
    mark = REG['landmarks'][name]
    scale = REG['skullPixels'] / (mark['skull'][1] - mark['skull'][0])
    image = image.resize((round(image.width * scale), round(image.height * scale)), Image.Resampling.LANCZOS)
    frame = Image.new('RGBA', (SIZE, SIZE))
    frame.alpha_composite(image, (round(SIZE / 2 - mark['stanceCenter'] * scale),
                                 round(REG['ground'] - mark['foot'][1] * scale)))
    return frame


def sway(frame, angle):
    return frame.rotate(angle, Image.Resampling.BICUBIC, center=(SIZE / 2, REG['ground']))


def save(path, frames, durations, loop):
    path.parent.mkdir(parents=True, exist_ok=True)
    for frame in frames:
        box = frame.getchannel('A').point(lambda a: 255 if a > 32 else 0).getbbox()
        assert box and min(box[0], box[1], SIZE - box[2], SIZE - box[3]) >= 4, (path, box)
    assert min(durations) >= 20, 'Browsers stretch frames shorter than 20ms'
    frames[0].save(path, save_all=True, append_images=frames[1:], duration=durations,
                   loop=loop, quality=88, method=6)
    print(f'{path.relative_to(ROOT)}: {len(frames)} frames, {sum(durations)}ms')


def main():
    poses = {name: drawing(name) for name in REG['landmarks']}
    idle = poses['idle']
    # Eight slow, rigid sway drawings keep stature and blade length constant.
    idle_frames = [sway(idle, .3 * math.sin(i * math.tau / 8)) for i in range(8)]
    save(OUT / 'animated/kratos-idle.webp', idle_frames, [400] * 8, 0)
    keys = [(0, idle), (180, sway(poses['windup'], -1)),
            (400, poses['windup']), (630, poses['contact']),
            (1060, poses['followthrough']), (1120, sway(poses['followthrough'], -.5)),
            (1440, idle)]
    frames = [frame for _, frame in keys]
    durations = [b - a for a, b in zip([time for time, _ in keys],
                                     [time for time, _ in keys][1:] + [REG['durationMs']])]
    assert sum(durations) == REG['durationMs']
    assert ImageChops.difference(frames[0], frames[-1]).getbbox() is None
    save(ROOT / 'artifacts/kratos-art/kratos-attack.webp', frames, durations, 1)
    for name, pose in poses.items():
        pose.save(OUT / f'animated/kratos-{"ready" if name == "idle" else name}.webp', quality=88, method=6)
    # Inverse overscan gives reduced motion the same on-screen stature as idle.
    edge = round(SIZE * REG['displayScale'])
    full = idle.resize((edge, edge), Image.Resampling.LANCZOS)
    left, top = (edge - SIZE) // 2, edge - SIZE
    hero = full.crop((left, top, left + SIZE, edge))
    hero.save(OUT / 'kratos-hero.webp', quality=92, method=6)
    hero.resize((512, 512), Image.Resampling.LANCZOS).save(OUT / 'kratos.webp', quality=90, method=6)
    vfx = ROOT / 'public/assets/combat/vfx/actions/kratos'
    vfx.mkdir(parents=True, exist_ok=True)
    for name in ['slash', 'impact']:
        Image.open(SOURCE / f'{name}.webp').resize((512, 512), Image.Resampling.LANCZOS).save(
            vfx / f'{name}.webp', quality=88, method=6)
    # A contrasting contact sheet makes every delivered drawing reviewable.
    sheet = Image.new('RGBA', (SIZE * len(poses), SIZE), '#15556c')
    for i, pose in enumerate(poses.values()):
        sheet.alpha_composite(pose, (i * SIZE, 0))
    review = ROOT / 'artifacts/kratos-art'
    review.mkdir(parents=True, exist_ok=True)
    sheet.convert('RGB').save(review / 'registered-keyframes.jpg')


if __name__ == '__main__':
    main()
