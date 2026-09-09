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
from authored import available as has_authored_attack, render as render_authored

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


def bone_motion(bone, phase, pose, contact, duration):
    if pose == 'idle':
        lag = bone.get('lag', 0)
        angle = bone.get('idle', 1) * (math.sin(phase*2*math.pi+lag)-math.sin(lag))
        return math.radians(angle), np.zeros(2)
    if 'motion' in bone:
        keys = np.array(bone['motion'])
        values = PchipInterpolator(keys[:,0], keys[:,1:], axis=0)(phase*duration)
        return math.radians(values[0]), values[1:]
    anticipation = max(.08, contact-.18)
    curve = PchipInterpolator([0, anticipation, contact, min(.88,contact+.23),1], [0,-.42,1,-.08,0])
    return math.radians(bone.get('attack',0)*float(curve(phase))), np.zeros(2)


def deform(points, bones, phase, pose, contact, duration=1830, aspect=1):
    moved = points.copy()
    rigid = []
    for bone in bones:
        angle, offset = bone_motion(bone,phase,pose,contact,duration)
        pivot = np.array(bone['pivot'])
        rotation = np.array([[math.cos(angle),-math.sin(angle)], [math.sin(angle),math.cos(angle)]])
        transformed = ((points-pivot)*[aspect,1])@rotation.T/[aspect,1]+pivot+offset
        moved += (transformed-points)*weight(points,bone)[...,None]
        if 'rigid' in bone:
            rigid.append((bone, transformed))
    # A weapon has ONE rigid transform. Overlapping shoulder/cloth weights must
    # not stretch its shaft or blade. Only the attachment boundary is feathered.
    for bone, transformed in rigid:
        region = weight(points, {**bone['rigid'], 'feather': .015})
        moved = moved*(1-region[...,None])+transformed*region[...,None]
    return moved


def render(spec, pose, output, size=400, fps=30):
    source = Image.open(ROOT / spec['source']).convert('RGBA')
    width, height = size, round(size * source.height / source.width)
    source = source.crop(source.getbbox())
    # Generous fixed overscan for weapons, never independently fit each frame.
    display_scale = spec.get('displayScale', 1)
    scale = min(width * .8 / source.width, height * spec.get('heightFit', .88) / source.height) / display_scale
    sw, sh = [round(v * scale) for v in source.size]
    source = source.resize((sw, sh), Image.Resampling.LANCZOS)
    ox, oy = (width-sw)//2, round(height*(1-(1-spec.get('ground', .98))/display_scale))-sh
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
        moved = deform(target, spec['bones'], phase, pose, spec.get('contact', .4), duration, sw/sh)
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
        if name in ('gremlin_nob', 'hero-ironclad'):
            import runpy
            renderer = 'render-nob.py' if name == 'gremlin_nob' else 'render-ironclad.py'
            runpy.run_path(str(ROOT / 'scripts/animation' / renderer), run_name='__main__')
            continue
        if name == 'downfall_demon':
            import runpy
            runpy.run_path(str(ROOT / 'scripts/animation/register-demon.py'), run_name='__main__')
        for pose in ('idle', 'attack'):
            output = ROOT / spec['output'] / f'{name}-{pose}.webp'
            if pose == 'attack' and name == 'hero-guardian-defense':
                import runpy
                runpy.run_path(str(ROOT / 'scripts/animation/render-guardian-defense.py'), run_name='__main__')
            elif pose == 'attack' and 'drawnSheet' in spec:
                from drawn import render as render_drawn
                render_drawn(name, spec, output)
            elif pose == 'attack' and has_authored_attack(name):
                render_authored(name, spec, output)
            else:
                render(spec, pose, output)
