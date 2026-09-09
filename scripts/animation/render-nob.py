#!/usr/bin/env python3
"""Drawn body poses with one unchanging, rigid skull club and native alpha.

Sources: GPT Image 2.5 Sunburst, background=transparent. Cell positions and
grips are authored coordinates, not independent per-frame bounding-box fits.
"""
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
SOURCES = ROOT / 'scripts/animation/sources'
OUTPUT = ROOT / 'public/assets/combat/rigged'
SIZE = (600, 500)
ORIGIN = (200, 228)
GRIPS = [(60,135), (61,119), (61,76), (58,54), (61,38), (70,21),
         (75,22), (77,19), (62,23), (37,44), (28,76), (17,86),
         (51,181), (61,194), (59,191), (61,167), (52,134), (42,60),
         (57,43), (66,29), (58,77), (60,102), (60,118), (61,135)]
# Drawn anticipation, quick swing, weight absorption, and a slower recovery.
KEYS = [(0,0,10), (60,1,-2), (140,2,-22), (240,3,-35), (340,4,-45),
        (440,5,-55), (510,6,-62), (550,7,-65), (585,8,-85),
        (615,9,-105), (645,10,-140), (670,11,-165), (730,12,-200),
        (800,13,-201), (870,14,-200), (940,15,-180), (1030,16,-150),
        (1200,17,-110), (1290,18,-85), (1380,19,-55), (1480,20,-25),
        (1570,21,-10), (1660,22,0), (1740,23,10), (1830,0,10)]


def render(pose, angle, bodies, club, pivot, breath=0):
    body = bodies[pose]
    gx, gy = GRIPS[pose]
    if breath:
        sy = 1 + breath
        body = body.transform(body.size, Image.Transform.AFFINE,
                              (1, 0, 0, 0, 1 / sy, 246 * (1 - 1 / sy)),
                              Image.Resampling.BICUBIC)
        gy = 246 + (gy - 246) * sy
    grip = (ORIGIN[0] + gx, ORIGIN[1] + gy)
    frame = Image.new('RGBA', SIZE)
    frame.alpha_composite(body, ORIGIN)
    c, s = math.cos(math.radians(angle)), math.sin(math.radians(angle))
    # Rotation/translation only: shaft length and skull pixels never morph.
    weapon = club.transform(SIZE, Image.Transform.AFFINE,
                            (c, s, pivot[0] - c * grip[0] - s * grip[1],
                             -s, c, pivot[1] + s * grip[0] - c * grip[1]),
                            Image.Resampling.BICUBIC)
    frame.alpha_composite(weapon)
    # Foreground fingers wrap the shaft. This is a hand layer, not background
    # removal; all source transparency comes directly from the image model.
    fingers = body.copy()
    mask = Image.new('L', body.size)
    ImageDraw.Draw(mask).ellipse((gx-11, gy-11, gx+11, gy+11), fill=255)
    fingers.putalpha(Image.fromarray(np.minimum(np.array(body.getchannel('A')),
                                                np.array(mask))))
    frame.alpha_composite(fingers, ORIGIN)
    return frame


def main():
    sheet = Image.open(SOURCES / 'nob-body-poses.png').convert('RGBA')
    bodies = [sheet.crop((i % 6 * 256, i // 6 * 256,
                         (i % 6 + 1) * 256, (i // 6 + 1) * 256)) for i in range(24)]
    club = Image.open(SOURCES / 'nob-club.png').convert('RGBA')
    club = club.resize((235, round(235 * club.height / club.width)), Image.Resampling.LANCZOS)
    shaft = np.flatnonzero(np.array(club.getchannel('A'))[:, 49] > 32)
    pivot = (49, (int(shaft[0]) + int(shaft[-1])) / 2)
    for action, duration in [('idle', 3000), ('attack', 1830)]:
        boundaries = {key[0] for key in KEYS}
        # Browsers stretch very short animation frames. Keep exact authored
        # boundaries, dropping nearby regular samples instead of emitting 5ms.
        times = ([round(i * duration / 90) for i in range(90)] if action == 'idle'
                 else sorted({t for t in range(0, duration, 30)
                              if min(abs(t-b) for b in boundaries) >= 20}
                             | (boundaries - {duration})))
        frames = []
        for t in times:
            if action == 'idle':
                wave = math.sin(2 * math.pi * t / duration)
                frame = render(0, 10 + wave * .6, bodies, club, pivot, wave * .004)
            else:
                k = min(max(j for j, key in enumerate(KEYS) if key[0] <= t), len(KEYS)-2)
                start, pose, angle = KEYS[k]
                end, _, next_angle = KEYS[k+1]
                f = (t-start) / (end-start)
                f = f*f*(3-2*f)
                frame = render(pose, angle + (next_angle-angle)*f, bodies, club, pivot)
            frames.append(frame)
        if action == 'attack':
            frames[-1] = render(0, 10, bodies, club, pivot)
        durations = [end-start for start, end in zip(times, times[1:] + [duration])]
        for frame in frames:
            bounds = frame.getchannel('A').point(lambda a: 255 if a > 32 else 0).getbbox()
            assert bounds and min(bounds[:2]) > 0 and bounds[2] < SIZE[0] and bounds[3] < SIZE[1], bounds
        assert sum(durations) == duration
        assert min(durations) >= 20, 'short frames would change browser playback timing'
        path = OUTPUT / f'gremlin_nob-{action}.webp'
        frames[0].save(path, save_all=True, append_images=frames[1:], duration=durations,
                       loop=0 if action == 'idle' else 1, quality=88, method=4)
        print(f'{path.relative_to(ROOT)}: {len(frames)} samples, {duration}ms')


if __name__ == '__main__':
    main()
