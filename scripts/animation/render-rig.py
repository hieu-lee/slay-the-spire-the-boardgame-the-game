#!/usr/bin/env python3
"""Bake continuous, weighted cutout motion to transparent WebP (Pillow/numpy/scipy).

Coordinates and pivots are relative to the source alpha bounds. A fixed canvas
and inverse-skinned texture keep the original drawing and body proportions.
"""
import argparse
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.interpolate import PchipInterpolator
from numba import njit

ROOT = Path(__file__).resolve().parents[2]


@njit(cache=True)
def raster(source, vertices, grid):
    """Forward-rasterize textured triangles, including overlapping joint folds."""
    height, width = source.shape[:2]
    result = np.zeros_like(source)
    for row in range(grid.shape[0]-1):
        for col in range(grid.shape[0]-1):
            for half in range(2):
                corners = ((row,col),(row+1,col),(row+1,col+1)) if half == 0 else ((row,col),(row+1,col+1),(row,col+1))
                a,b,c = [vertices[r,k] for r,k in corners]
                det = (b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1])
                if abs(det) < .001:
                    continue
                for y in range(max(0,int(min(a[1],b[1],c[1]))), min(height,int(max(a[1],b[1],c[1]))+1)):
                    for x in range(max(0,int(min(a[0],b[0],c[0]))), min(width,int(max(a[0],b[0],c[0]))+1)):
                        u=((b[1]-c[1])*(x-c[0])+(c[0]-b[0])*(y-c[1]))/det
                        v=((c[1]-a[1])*(x-c[0])+(a[0]-c[0])*(y-c[1]))/det
                        w=1-u-v
                        if min(u,v,w) < -1e-6:
                            continue
                        sx = u*grid[corners[0]][0] + v*grid[corners[1]][0] + w*grid[corners[2]][0]
                        sy = u*grid[corners[0]][1] + v*grid[corners[1]][1] + w*grid[corners[2]][1]
                        ix,iy=int(sx),int(sy)
                        if ix<0 or iy<0 or ix>=width-1 or iy>=height-1:
                            continue
                        fx,fy=sx-ix,sy-iy
                        pixel=(source[iy,ix]*(1-fx)*(1-fy)+source[iy,ix+1]*fx*(1-fy)
                               +source[iy+1,ix]*(1-fx)*fy+source[iy+1,ix+1]*fx*fy)
                        if pixel[3] > result[y,x,3]:
                            result[y,x]=pixel
    return result


def smooth(x):
    x = np.clip(x, 0, 1)
    return x * x * (3 - 2 * x)


def weight(points, bone):
    x, y = points[..., 0], points[..., 1]
    feather = bone.get('feather', .08)
    if 'polygon' in bone:
        vertices = bone['polygon']
        result = np.ones_like(x)
        for a, b in zip(vertices, vertices[1:] + vertices[:1]):
            dx, dy = b[0]-a[0], b[1]-a[1]
            distance = (dx*(y-a[1])-dy*(x-a[0])) / math.hypot(dx,dy)
            result *= smooth(distance / feather)
        return result
    result = np.zeros_like(x)
    for left, top, right, bottom in bone['regions']:
        result = np.maximum(result, smooth((x-left)/feather) * smooth((right-x)/feather)
                            * smooth((y-top)/feather) * smooth((bottom-y)/feather))
    return result


def deform(points, bones, phase, pose, contact):
    moved = points.copy()
    for bone in bones:
        if pose == 'idle':
            # Begin/end at the rest drawing; different phases give cloth lag.
            lag = bone.get('lag', 0)
            amount = math.sin(phase * 2 * math.pi + lag) - math.sin(lag)
            angle = bone.get('idle', 1) * amount
        else:
            anticipation = max(.08, contact - .18)
            curve = PchipInterpolator([0, anticipation, contact, min(.88, contact+.23), 1],
                                      [0, -.42, 1, -.08, 0])
            angle = bone.get('attack', 0) * float(curve(phase))
        angle = math.radians(angle)
        pivot = np.array(bone['pivot'])
        rotation = np.array([[math.cos(angle), -math.sin(angle)],
                             [math.sin(angle), math.cos(angle)]])
        delta = (points - pivot) @ rotation.T + pivot - points
        moved += delta * weight(points, bone)[..., None]
    return moved


def render(spec, pose, output, size=400, fps=30):
    source = Image.open(ROOT / spec['source']).convert('RGBA')
    width, height = size, round(size * source.height / source.width)
    source = source.crop(source.getbbox())
    # Generous fixed overscan for weapons, never independently fit each frame.
    scale = min(width * .8 / source.width, height * spec.get('heightFit', .88) / source.height)
    sw, sh = [round(v * scale) for v in source.size]
    source = source.resize((sw, sh), Image.Resampling.LANCZOS)
    ox, oy = (width-sw)//2, round(height*spec.get('ground', .98))-sh
    canvas = Image.new('RGBA', (width, height))
    canvas.paste(source, (ox, oy))
    canvas = canvas.convert('RGBa')  # Premultiplication prevents dark alpha seams.
    duration = 3000 if pose == 'idle' else spec.get('duration', 1830)
    count = round(duration * fps / 1000)
    gx, gy = np.meshgrid(np.linspace(0, width, 65), np.linspace(0, height, 65))
    grid = np.stack((gx, gy), axis=-1)
    target = np.stack(((gx-ox)/sw, (gy-oy)/sh), axis=-1)
    frames = []
    pixels = np.asarray(canvas, dtype=np.float32)
    for index in range(count):
        phase = index / (count if pose == 'idle' else count-1)
        moved = deform(target, spec['bones'], phase, pose, spec.get('contact', .4))
        rendered = raster(pixels, moved * [sw, sh] + [ox, oy], grid)
        frames.append(Image.fromarray(rendered.clip(0,255).astype('uint8'), 'RGBa').convert('RGBA'))
    output.parent.mkdir(parents=True, exist_ok=True)
    durations = [round((i+1)*duration/count)-round(i*duration/count) for i in range(count)]
    frames[0].save(output, save_all=True, append_images=frames[1:], duration=durations,
                   loop=0 if pose == 'idle' else 1, quality=78, method=4, minimize_size=True)
    print(f'{output.relative_to(ROOT)}: {count} frames, {duration}ms', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('manifest', type=Path)
    parser.add_argument('--only')
    args = parser.parse_args()
    for name, spec in json.loads(args.manifest.read_text()).items():
        if args.only and name not in args.only.split(','):
            continue
        for pose in ('idle', 'attack'):
            render(spec, pose, ROOT / spec['output'] / f'{name}-{pose}.webp')
