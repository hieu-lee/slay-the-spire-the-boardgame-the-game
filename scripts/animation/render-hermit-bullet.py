"""Render Hermit's bullet and spark impact: blender -b -P this_file."""
from pathlib import Path
import math
import subprocess
import bpy

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'artifacts/hermit-bullets'
OUT.mkdir(parents=True, exist_ok=True)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = 16
scene.render.film_transparent = True
scene.render.image_settings.color_mode = 'RGBA'
scene.view_settings.view_transform = 'Standard'
scene.render.resolution_percentage = 100
bpy.ops.object.camera_add(location=(0, 0, 10))
scene.camera = bpy.context.object
scene.camera.data.type = 'ORTHO'
scene.camera.data.ortho_scale = 4


def material(name, color, glow):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    shader = mat.node_tree.nodes.get('Principled BSDF')
    shader.inputs['Base Color'].default_value = (*color, 1)
    shader.inputs['Metallic'].default_value = .65
    shader.inputs['Roughness'].default_value = .25
    shader.inputs['Emission Color'].default_value = (*color, 1)
    shader.inputs['Emission Strength'].default_value = glow
    return mat


gold = material('Copper jacket', (1, .48, .08), .6)
white = material('Hot sparks', (1, .86, .47), 3)
bpy.ops.object.light_add(type='AREA', location=(0, 2, 4))
bpy.context.object.data.energy = 450
bpy.context.object.data.shape = 'DISK'
bpy.context.object.data.size = 5
# Rounded projectile, pointing right. No cartridge casing flies with it.
bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=16)
bullet = bpy.context.object
bullet.scale = (1.45, .27, .27)
bullet.data.materials.append(gold)
bpy.ops.object.shade_smooth()
scene.render.resolution_x, scene.render.resolution_y = 256, 64
scene.render.filepath = str(OUT / 'bullet.png')
bpy.ops.render.render(write_still=True)
bpy.data.objects.remove(bullet, do_unlink=True)
# One baked starburst; each arrival expands/fades its own instance in CSS.
for i in range(13):
    angle = i * 2.39996
    length = .5 + (i % 4) * .26
    bpy.ops.mesh.primitive_cone_add(vertices=8, radius1=.075, radius2=0, depth=length,
        location=(math.cos(angle)*length*.57, math.sin(angle)*length*.57, 0))
    spark = bpy.context.object
    from mathutils import Vector
    spark.rotation_euler = Vector((math.cos(angle), math.sin(angle), 0)).to_track_quat('Z', 'Y').to_euler()
    spark.data.materials.append(white if i % 3 else gold)
scene.render.resolution_x = scene.render.resolution_y = 256
scene.render.filepath = str(OUT / 'impact.png')
bpy.ops.render.render(write_still=True)
subprocess.run(['python3', '-c', '''
from PIL import Image, ImageFilter
from pathlib import Path
import sys
root = Path(sys.argv[1])
for name in ['bullet', 'impact']:
    core = Image.open(root / f'artifacts/hermit-bullets/{name}.png').convert('RGBA')
    glow = Image.new('RGBA', core.size, (255, 155, 48, 0))
    glow.putalpha(core.getchannel('A').filter(ImageFilter.GaussianBlur(3)))
    glow.alpha_composite(core)
    glow.save(root / f'public/assets/combat/vfx/actions/hermit-{name}.webp', quality=92, method=6)
    assert glow.getchannel('A').getextrema() == (0, 255)
''', str(ROOT)], check=True)
