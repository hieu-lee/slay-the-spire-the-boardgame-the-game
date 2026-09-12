"""Bake the end-turn bolt and its glow: blender -b -P this_file.

Runtime: one transparent 384x768 WebP, animated only with CSS opacity.
The ground contact is registered at (192, 722), or 94% of the image height.
"""
from pathlib import Path
import math
import random
import subprocess
import bpy

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'artifacts/lightning-act2'
OUT.mkdir(parents=True, exist_ok=True)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)

material = bpy.data.materials.new('Warm white lightning')
material.use_nodes = True
shader = material.node_tree.nodes.get('Principled BSDF')
shader.inputs['Base Color'].default_value = (1, .96, .88, 1)
shader.inputs['Emission Color'].default_value = (1, .96, .88, 1)
shader.inputs['Emission Strength'].default_value = 1


def filament(name, points, radius):
    curve = bpy.data.curves.new(name, 'CURVE')
    curve.dimensions = '3D'
    curve.bevel_depth = radius / 96
    curve.bevel_resolution = 2
    spline = curve.splines.new('POLY')
    spline.points.add(len(points) - 1)
    for index, (point, (x, y)) in enumerate(zip(spline.points, points)):
        point.co = ((x - 192) / 96, (384 - y) / 96, 0, 1)
        point.radius = 1 - .55 * index / max(1, len(points) - 1)
    obj = bpy.data.objects.new(name, curve)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(material)


filament('Main descending bolt', [
    (208, -20), (201, 32), (172, 57), (174, 91), (110, 127),
    (147, 158), (166, 198), (152, 226), (178, 267), (175, 316),
    (196, 360), (183, 411), (190, 454), (169, 508), (178, 550),
    (164, 596), (191, 633), (181, 673), (192, 722),
], 4.2)
for index, points in enumerate([
    [(201, 32), (224, 68), (218, 105), (247, 138), (279, 131), (310, 152), (307, 179)],
    [(166, 198), (130, 231), (132, 271), (98, 296), (70, 300), (54, 326), (74, 365), (69, 397)],
    [(175, 316), (213, 334), (225, 381), (220, 414)],
    [(147, 158), (160, 180), (148, 217), (164, 258), (155, 283)],
    [(178, 550), (213, 567), (219, 604), (243, 630), (239, 652)],
    [(181, 673), (151, 687), (158, 704), (130, 718)],
]):
    filament(f'Branch {index}', points, 1.6)

# A broken, flattened ground arc and a few hot sparks, as in the reference.
for index, (start, end) in enumerate([(0, 1.5), (2.1, 3.8), (4.1, 5.8)]):
    filament(f'Ground arc {index}', [
        (192 + 94 * math.cos(t), 722 + 9 * math.sin(t))
        for t in [start + (end - start) * i / 16 for i in range(17)]
    ], 1.4)
rng = random.Random(21)
for index in range(13):
    x, y = 192 + rng.uniform(-70, 70), rng.uniform(661, 743)
    filament(f'Spark {index}', [(x, y), (x + rng.uniform(-2, 2), y - rng.uniform(2, 6))], rng.uniform(1, 2.5))

bpy.ops.object.camera_add(location=(0, 0, 10))
scene = bpy.context.scene
scene.camera = bpy.context.object
scene.camera.data.type = 'ORTHO'
scene.camera.data.ortho_scale = 8
scene.render.engine = 'CYCLES'
scene.cycles.samples = 8
scene.render.resolution_x, scene.render.resolution_y = 384, 768
scene.render.resolution_percentage = 100
scene.render.film_transparent = True
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGBA'
scene.view_settings.view_transform = 'Standard'
scene.render.filepath = str(OUT / 'lightning-core.png')
bpy.ops.render.render(write_still=True)

# Bake the soft light once; no runtime blur, particles, canvas, or WebGL.
subprocess.run(['python3', '-c', '''
from PIL import Image, ImageFilter
from pathlib import Path
import sys
root = Path(sys.argv[1])
core = Image.open(root / 'artifacts/lightning-act2/lightning-core.png').convert('RGBA')
alpha = core.getchannel('A')
result = Image.new('RGBA', core.size)
for radius, strength, color in [(9, 1.8, (215, 175, 151)), (3, 1.5, (255, 229, 210))]:
    glow = Image.new('RGBA', core.size, (*color, 0))
    glow.putalpha(alpha.filter(ImageFilter.GaussianBlur(radius)).point(lambda a: min(255, round(a * strength))))
    result.alpha_composite(glow)
result.alpha_composite(core)
result.save(root / 'public/assets/combat/vfx/actions/turn-lightning-strike.webp', quality=90, method=6)
assert result.getchannel('A').getextrema() == (0, 255)
assert result.getchannel('A').crop((189, 719, 196, 724)).getextrema()[1] == 255
''', str(ROOT)], check=True)
