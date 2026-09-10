"""Render the shared, text-free slate/gold key plates: blender -b -P this_file."""
from pathlib import Path
import bpy
import subprocess

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'artifacts' / 'stone-buttons'
OUT.mkdir(parents=True, exist_ok=True)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)

def stone(name, color):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    shader = nodes.get('Principled BSDF')
    shader.inputs['Roughness'].default_value = .88
    noise = nodes.new('ShaderNodeTexNoise')
    noise.inputs['Scale'].default_value = 75
    noise.inputs['Detail'].default_value = 3
    ramp = nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].color = (*[c * .72 for c in color], 1)
    ramp.color_ramp.elements[1].color = (*color, 1)
    links.new(noise.outputs['Fac'], ramp.inputs[0])
    links.new(ramp.outputs['Color'], shader.inputs['Base Color'])
    bump = nodes.new('ShaderNodeBump')
    bump.inputs['Strength'].default_value = .22
    bump.inputs['Distance'].default_value = .035
    links.new(noise.outputs['Fac'], bump.inputs['Height'])
    links.new(bump.outputs['Normal'], shader.inputs['Normal'])
    return material

def plate(name, width, height, z, bevel, material):
    x, y = width / 2, height / 2
    outline = [(-x, 0), (-x + y * .7, -y), (x - y * .7, -y),
               (x, 0), (x - y * .7, y), (-x + y * .7, y)]
    vertices = [(a, b, h) for h in [z - .08, z] for a, b in outline]
    faces = [tuple(reversed(range(6))), tuple(range(6, 12))]
    faces += [(i, (i + 1) % 6, (i + 1) % 6 + 6, i + 6) for i in range(6)]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(material)
    modifier = obj.modifiers.new('Chipped bevel', 'BEVEL')
    modifier.width = bevel
    modifier.segments = 1
    return obj

plate('Dark stone silhouette', 8, 2.7, 0, .04, stone('Charcoal edge', (.038, .042, .037)))
plate('Warm carved rim', 7.84, 2.56, .09, .035, stone('Weathered limestone', (.36, .34, .24)))
plate('Recess shadow', 7.46, 2.20, .16, .025, stone('Deep blue seam', (.021, .047, .055)))
plate('Blue bevel', 7.32, 2.08, .20, .035, stone('Slate bevel', (.085, .16, .19)))
face = plate('Inset stone face', 6.94, 1.72, .23, .025, stone('Blue slate', (.043, .103, .134)))

bpy.ops.object.camera_add(location=(0, 0, 10))
camera = bpy.context.object
camera.data.type = 'ORTHO'
camera.data.ortho_scale = 8.2
bpy.context.scene.camera = camera
bpy.ops.object.light_add(type='AREA', location=(-3, 4, 7))
bpy.context.object.data.energy = 950
bpy.context.object.data.shape = 'DISK'
bpy.context.object.data.size = 5
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = 32
scene.render.resolution_x, scene.render.resolution_y = 768, 288
scene.render.resolution_percentage = 100
scene.render.film_transparent = True
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGBA'
scene.world.color = (.25, .25, .25)
scene.view_settings.view_transform = 'Standard'
for name, color in [('stone-key', None), ('stone-key-selected', (.68, .43, .10))]:
    if color:
        face.data.materials[0] = stone('Selected ochre stone', color)
    scene.render.filepath = str(OUT / f'{name}.png')
    bpy.ops.render.render(write_still=True)

# Encode Blender's transparent renders; crop only the camera's empty overscan.
subprocess.run(['python3', '-c', '''
from PIL import Image
from pathlib import Path
import sys
root = Path(sys.argv[1])
for name in ['stone-key', 'stone-key-selected']:
    image = Image.open(root / 'artifacts/stone-buttons' / (name + '.png'))
    image = image.crop(image.getchannel('A').getbbox())
    image.save(root / 'public/assets/ui/panels' / (name + '.webp'), quality=92, method=6)
''', str(ROOT)], check=True)
