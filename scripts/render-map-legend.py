"""Render the text-free torn map legend scroll with Blender: blender -b -P this_file."""
from pathlib import Path
import subprocess

import bpy


ROOT = Path(__file__).resolve().parents[1]
PREVIEW = ROOT / 'artifacts' / 'card-trails' / 'map-legend-scroll.png'
ASSET = ROOT / 'public' / 'assets' / 'noncombat' / 'map-legend-scroll.webp'
PREVIEW.parent.mkdir(parents=True, exist_ok=True)
ASSET.parent.mkdir(parents=True, exist_ok=True)
X_SCALE = 1.06


# The outline follows the supplied 320 x 470 reference panel.  It is kept as
# a small hand-authored polygon so the torn silhouette remains deterministic.
OUTLINE_CW = [
    (-2.40, 4.02), (-2.15, 4.05), (-2.03, 3.68), (-1.86, 4.08),
    (-1.22, 4.02), (-0.68, 4.08), (-0.08, 4.01), (0.52, 4.02),
    (1.12, 4.01), (1.33, 3.70), (1.51, 4.02), (1.62, 4.03),
    (2.35, 4.16), (2.18, 3.70), (2.15, 3.28), (2.08, 2.76),
    (2.10, 2.22), (2.02, 1.70), (2.09, 1.18), (2.03, 0.62),
    (2.08, 0.12), (2.02, -0.46), (1.98, -1.04), (1.86, -1.62),
    (1.85, -2.18), (1.75, -2.76), (1.70, -3.34), (1.58, -3.96),
    (1.45, -3.55), (1.28, -3.96), (0.93, -4.03), (0.62, -3.94),
    (0.25, -4.03), (-0.16, -3.96), (-0.31, -3.56), (-0.47, -4.01),
    (-1.12, -3.94), (-1.29, -3.57), (-1.47, -3.91), (-1.63, -3.88),
    (-1.98, -3.94),
    (-2.18, -3.64), (-2.34, -4.03), (-2.63, -3.93), (-2.55, -3.55),
    (-2.53, -3.09), (-2.62, -2.67), (-2.55, -2.22), (-2.60, -1.78),
    (-2.53, -1.32), (-2.58, -0.89), (-2.55, -0.43), (-2.63, 0.02),
    (-2.55, 0.48), (-2.62, 0.96), (-2.55, 1.42), (-2.59, 1.93),
    (-2.49, 2.46), (-2.54, 3.05), (-2.47, 3.56),
]
OUTLINE = list(reversed(OUTLINE_CW))


def material(name, low, high, scale=38.0):
    result = bpy.data.materials.new(name)
    result.use_nodes = True
    nodes = result.node_tree.nodes
    links = result.node_tree.links
    nodes.clear()

    output = nodes.new('ShaderNodeOutputMaterial')
    shader = nodes.new('ShaderNodeBsdfPrincipled')
    shader.inputs['Roughness'].default_value = 0.88
    if 'Specular IOR Level' in shader.inputs:
        shader.inputs['Specular IOR Level'].default_value = 0.16

    coordinates = nodes.new('ShaderNodeTexCoord')
    noise = nodes.new('ShaderNodeTexNoise')
    noise.inputs['Scale'].default_value = scale
    noise.inputs['Detail'].default_value = 2.0
    noise.inputs['Roughness'].default_value = 0.62
    ramp = nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].position = 0.22
    ramp.color_ramp.elements[0].color = (*low, 1.0)
    ramp.color_ramp.elements[1].position = 0.78
    ramp.color_ramp.elements[1].color = (*high, 1.0)
    bump = nodes.new('ShaderNodeBump')
    bump.inputs['Strength'].default_value = 0.03
    bump.inputs['Distance'].default_value = 0.018

    links.new(coordinates.outputs['Generated'], noise.inputs['Vector'])
    links.new(noise.outputs['Fac'], ramp.inputs['Fac'])
    links.new(ramp.outputs['Color'], shader.inputs['Base Color'])
    links.new(noise.outputs['Fac'], bump.inputs['Height'])
    links.new(bump.outputs['Normal'], shader.inputs['Normal'])
    links.new(shader.outputs['BSDF'], output.inputs['Surface'])
    result.diffuse_color = (*high, 1.0)
    return result


def extruded(name, outline, bottom, top, mat):
    vertices = [(x * X_SCALE, y, bottom) for x, y in outline]
    vertices.extend((x * X_SCALE, y, top) for x, y in outline)
    count = len(outline)
    faces = [tuple(reversed(range(count))), tuple(range(count, count * 2))]
    faces.extend(
        (index, (index + 1) % count, (index + 1) % count + count, index + count)
        for index in range(count)
    )
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(mat)
    bevel = obj.modifiers.new('Soft paper edge', 'BEVEL')
    bevel.width = 0.025
    bevel.segments = 2
    return obj


bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)

rim_material = material('Muted teal scroll rim', (0.13, 0.34, 0.39), (0.24, 0.52, 0.58), 30.0)
face_material = material('Icy blue paper', (0.58, 0.78, 0.86), (0.66, 0.86, 0.93), 48.0)
rim_outline = [(x * 1.035, y * 1.012) for x, y in OUTLINE]
extruded('Teal torn rim', rim_outline, -0.06, 0.06, rim_material)
extruded('Pale torn paper face', OUTLINE, 0.04, 0.16, face_material)

bpy.ops.object.camera_add(location=(0, 0, 10))
camera = bpy.context.object
camera.data.type = 'ORTHO'
camera.data.ortho_scale = 9.7
bpy.context.scene.camera = camera

for location, energy, size in [((-3.2, 4.6, 8.0), 240, 5.0), ((3.8, -3.0, 7.5), 260, 5.0), ((0.0, 0.0, 10.0), 560, 8.0)]:
    bpy.ops.object.light_add(type='AREA', location=location)
    light = bpy.context.object
    light.data.energy = energy
    light.data.shape = 'DISK'
    light.data.size = size

scene = bpy.context.scene
scene.render.engine = 'BLENDER_EEVEE'
scene.render.resolution_x, scene.render.resolution_y = 768, 1152
scene.render.resolution_percentage = 100
scene.render.film_transparent = True
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGBA'
scene.render.image_settings.color_depth = '8'
scene.render.filepath = str(PREVIEW)
scene.render.image_settings.compression = 15
scene.world.color = (0.025, 0.035, 0.045)
scene.view_settings.view_transform = 'Standard'
scene.view_settings.look = 'None'
scene.view_settings.exposure = 0.0
scene.view_settings.gamma = 1.0

bpy.ops.render.render(write_still=True)

# Keep the Blender PNG as a review artifact and encode the application asset
# with the same Pillow convention used by the other generated assets.
subprocess.run(['python3', '-c', '''
from pathlib import Path
import sys
from PIL import Image

source, target = map(Path, sys.argv[1:])
with Image.open(source) as image:
    image = image.convert('RGBA')
    assert image.size == (768, 1152)
    bbox = image.getchannel('A').getbbox()
    assert bbox is not None
    image.crop(bbox).save(target, format='WEBP', quality=92, method=6)
with Image.open(target) as encoded:
    assert encoded.size == (bbox[2] - bbox[0], bbox[3] - bbox[1])
    assert encoded.mode == 'RGBA'
''', str(PREVIEW), str(ASSET)], check=True)
print(f'Saved {PREVIEW} and {ASSET}.')
