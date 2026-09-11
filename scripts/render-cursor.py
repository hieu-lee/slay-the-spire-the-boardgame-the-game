"""Blender: render the reference gold pointer at native and Retina resolution.

Run: blender -b --python scripts/render-cursor.py
"""
import math
from pathlib import Path

import bpy

OUT = Path(__file__).resolve().parents[1] / 'public/assets/ui'
HOTSPOT = (14, 12)

# Flat beveled faces preserve the reference silhouette without a blurry light halo.
FACES = [
    ('49391e', [(13, 11), (15, 11), (47, 40), (47, 42), (29, 43), (15, 55), (12, 54), (12, 13)]),
    ('f7dda0', [(14, 13), (44, 40), (28, 40), (14, 52)]),
    ('ad843b', [(16, 18), (41, 39), (28, 39), (16, 49)]),
    ('dfbd67', [(16, 18), (38, 37), (27, 37), (16, 47)]),
    ('efd68c', [(16, 18), (27, 37), (16, 47)]),
    ('c9a34d', [(16, 18), (38, 37), (27, 37)]),
]


def linear(channel):
    value = channel / 255
    return value / 12.92 if value <= .04045 else ((value + .055) / 1.055) ** 2.4


def render(pressed, scale):
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 32
    scene.render.film_transparent = True
    scene.render.resolution_x = scene.render.resolution_y = 64 * scale
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    scene.view_settings.view_transform = 'Standard'
    scene.view_settings.look = 'None'
    scene.view_settings.exposure = 0
    scene.view_settings.gamma = 1
    scene.render.filter_size = .75
    angle = math.radians(-10 if pressed else 0)
    for layer, (color, points) in enumerate(FACES):
        vertices = []
        for x, y in points:
            dx, dy = x - HOTSPOT[0], y - HOTSPOT[1]
            x = HOTSPOT[0] + dx * math.cos(angle) - dy * math.sin(angle)
            y = HOTSPOT[1] + dx * math.sin(angle) + dy * math.cos(angle)
            vertices.append((x, 64 - y, layer * .01))
        mesh = bpy.data.meshes.new('facet')
        mesh.from_pydata(vertices, [], [list(range(len(vertices)))])
        obj = bpy.data.objects.new('facet', mesh)
        scene.collection.objects.link(obj)
        material = bpy.data.materials.new(color)
        material.use_nodes = True
        nodes = material.node_tree.nodes
        nodes.clear()
        emission = nodes.new('ShaderNodeEmission')
        emission.inputs['Color'].default_value = (*[linear(int(color[i:i + 2], 16)) for i in (0, 2, 4)], 1)
        output = nodes.new('ShaderNodeOutputMaterial')
        material.node_tree.links.new(emission.outputs[0], output.inputs['Surface'])
        obj.data.materials.append(material)
    bpy.ops.object.camera_add(location=(32, 32, 100))
    scene.camera = bpy.context.object
    scene.camera.data.type = 'ORTHO'
    scene.camera.data.ortho_scale = 64
    name = 'cursor-click' if pressed else 'cursor'
    scene.render.filepath = str(OUT / f'{name}{"@2x" if scale == 2 else ""}.png')
    bpy.ops.render.render(write_still=True)


for pressed in (False, True):
    for scale in (1, 2):
        render(pressed, scale)
