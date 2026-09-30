import math
from pathlib import Path

import numpy as np
from PIL import Image

from drawn import sprites

ROOT = Path(__file__).resolve().parents[2]
SOURCES = ROOT / 'scripts/animation/sources/elite-signatures'
OUT = ROOT / 'public/assets/combat/enemies/animated'
NAMES = {'lagavulin', 'gremlin_leader', 'reptomancer', 'guardian_attack', 'guardian_defensive'}


def canonical(name):
    return Image.open(ROOT / f'public/assets/combat/rigged/{name}-idle.webp').convert('RGBA')


def feet(image):
    bounds = image.getbbox()
    lower = image.getchannel('A').crop((0, round(bounds[1] + .85 * (bounds[3] - bounds[1])), image.width, bounds[3])).getbbox()
    return (lower[0] + lower[2]) / 2


def place(drawing, size, center, ground, scale):
    bounds = drawing.getbbox()
    drawing = drawing.crop(bounds)
    anchor = feet(drawing)
    width, height = round(drawing.width * scale), round(drawing.height * scale)
    drawing = drawing.resize((width, height), Image.Resampling.LANCZOS)
    frame = Image.new('RGBA', size)
    frame.alpha_composite(drawing, (round(center - anchor * scale), ground - height))
    return frame


def sway(frame, angle):
    return frame.rotate(angle, Image.Resampling.BICUBIC, center=(feet(frame), frame.getbbox()[3]))


def save(name, frames, durations, loop=False):
    OUT.mkdir(parents=True, exist_ok=True)
    if frames[0].width > 800:
        size = (800, round(frames[0].height * 800 / frames[0].width))
        frames = [frame.resize(size, Image.Resampling.LANCZOS) for frame in frames]
    for frame in frames:
        bounds = frame.getchannel('A').point(lambda alpha: 255 if alpha > 32 else 0).getbbox()
        assert bounds and 0 < bounds[0] < bounds[2] < frame.width and 0 < bounds[1] < bounds[3] < frame.height, (name, bounds)
    frames[0].save(OUT / f'{name}.webp', save_all=True, append_images=frames[1:],
                   duration=durations, loop=0 if loop else 1, quality=85, method=4)
    print(name, len(frames), sum(durations), flush=True)


def sequence(name, poses, keys, duration=1830):
    boundaries = [time for time, _ in keys] + [duration]
    times = [round(start + index * (end - start) / max(1, round((end - start) / 30)))
             for start, end in zip(boundaries, boundaries[1:])
             for index in range(max(1, round((end - start) / 30)))] + [duration]
    frames = []
    for time in times[:-1]:
        index = next(index for boundary, index in reversed(keys) if boundary <= time)
        frames.append(sway(poses[index], .25 * math.sin(time * math.tau / duration)))
    frames[0] = poses[keys[0][1]]
    frames[-1] = poses[keys[-1][1]]
    save(name, frames, [end - start for start, end in zip(times, times[1:])])


def render(name):
    if name.startswith('guardian_'):
        render_guardian(name)
        return
    reference = canonical(name)
    neutral = 2 if name == 'lagavulin' else 0
    sheet = {'lagavulin': 'lagavulin-poses', 'gremlin_leader': 'gremlin-leader-poses',
             'reptomancer': 'reptomancer-poses'}[name]
    drawings = [drawing for drawing, _ in sprites(SOURCES / f'{sheet}.png', 6, 3)]
    bounds = reference.getbbox()
    overscan = {'lagavulin': 1, 'gremlin_leader': 1.625, 'reptomancer': 1.625}[name]
    size = (round(reference.width * overscan), round(reference.height * overscan))
    center = feet(reference) + (size[0] - reference.width) / 2
    ground = bounds[3] + size[1] - reference.height
    scale = (bounds[3] - bounds[1]) / drawings[neutral].height
    corrections = [1, 1, 1.06, 1.06, 1.05, 1.03] if name == 'gremlin_leader' else [1] * 6
    poses = [place(drawing, size, center, ground, scale * correction)
             for drawing, correction in zip(drawings, corrections)]
    idle = poses[neutral]
    idle_frames = [sway(poses[1] if name == 'reptomancer' and 900 <= time < 2100 else idle,
                        .65 * math.sin(time * math.tau / 3000) + .1 * math.sin(time * math.tau / 1500))
                   for time in range(0, 3000, 60)]
    idle_frames[0] = idle_frames[-1] = idle
    save(f'{name}-idle', idle_frames, [60] * 50, True)
    if name == 'gremlin_leader':
        sequence(f'{name}-attack', poses, [(0, 0), (180, 2), (330, 3), (730, 4), (1200, 5), (1530, 0)])
    elif name == 'reptomancer':
        sequence(f'{name}-attack', poses, [(0, 0), (300, 2), (500, 3), (900, 4), (1260, 5), (1530, 0)])
    else:
        sequence(f'{name}-attack', poses, [(0, 2), (300, 3), (730, 4), (1110, 5), (1530, 2)])
        sleep = Image.open(SOURCES / 'lagavulin-sleep.png').convert('RGBA')
        sleep_bounds = sleep.getbbox()
        sleep_pose = place(sleep, size, center, ground, .92 * (bounds[2] - bounds[0]) / (sleep_bounds[2] - sleep_bounds[0]))
        save('lagavulin-sleep-static', [sleep_pose], [60])
        save('lagavulin-sleep', [sway(sleep_pose, .35 * math.sin(time * math.tau / 3000) + .05 * math.sin(time * math.tau / 1500))
                               for time in range(0, 3000, 60)], [60] * 50, True)
        sequence('lagavulin-wake', [sleep_pose, *poses], [(0, 0), (150, 1), (330, 2), (570, 3)], 800)


def render_guardian(name):
    reference = canonical('guardian_attack')
    size, ground, center = reference.size, reference.getbbox()[3], feet(reference)
    shell_reference = canonical('guardian_defensive')
    shell = place(shell_reference, size, center, ground, 1)
    if name == 'guardian_attack':
        idle = reference
        drawings = [drawing for drawing, _ in sprites(SOURCES / 'guardian-attack-poses.png', 6, 3)]
        ratio = (reference.getbbox()[3] - reference.getbbox()[1]) / drawings[0].height
        poses = [place(drawing, size, center, ground, ratio) for drawing in drawings]
        poses[0] = poses[-1] = idle
        sequence(f'{name}-attack', poses, [(0, 0), (300, 1), (550, 2), (730, 3), (1050, 4), (1530, 5)])
    else:
        idle = shell
        frames = []
        drawing = shell.crop(shell.getbbox())
        for time in range(0, 1830, 30):
            progress = np.interp(time, [0, 220, 730, 950, 1550, 1830], [0, 0, 1, 1, 0, 0])
            rotated = drawing.rotate(-360 * progress, Image.Resampling.BICUBIC, expand=True)
            rotated = rotated.crop(rotated.getbbox())
            frame = Image.new('RGBA', size)
            frame.alpha_composite(rotated, (round(center - rotated.width / 2), ground - rotated.height))
            frames.append(frame)
        frames[0] = frames[-1] = idle
        save(f'{name}-attack', frames, [30] * 61)
    save(f'{name}-idle', [sway(idle, .6 * math.sin(time * math.tau / 3000) + .1 * math.sin(time * math.tau / 1500))
                        for time in range(0, 3000, 60)], [60] * 50, True)
    drawings = [drawing for drawing, _ in sprites(SOURCES / 'guardian-mode-poses.png', 6, 3)]
    ratio = (reference.getbbox()[3] - reference.getbbox()[1]) / drawings[0].height
    poses = [place(drawing, size, center, ground, ratio) for drawing in drawings]
    poses[0] = poses[-1] = reference
    poses[3] = shell
    if name == 'guardian_attack':
        sequence('guardian-open', poses, [(0, 3), (150, 2), (330, 4), (570, 1), (720, 0)], 800)
    else:
        sequence('guardian-close', poses, [(0, 0), (150, 1), (330, 4), (570, 2), (720, 3)], 800)


if __name__ == '__main__':
    for actor in sorted(NAMES):
        render(actor)
