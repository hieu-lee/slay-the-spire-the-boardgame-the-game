"""Pack audited native-alpha body drawings at one physical scale.

Sprite sheets may stagger their cells. Separate the sprite objects, retaining
their original alpha; this never derives transparency from a background color.
"""
import math
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps
from rigid_weapon import attach_weapon
from scipy import ndimage

ROOT = Path(__file__).resolve().parents[2]


def sprites(path, count=24, columns=6):
    sheet = Image.open(path).convert('RGBA')
    rgba = np.array(sheet)
    assert rgba[:, :, 3].min() == 0, 'sheet must have native transparency'
    # Opaque cores separate sprites even when their faint alpha fringes touch.
    # Original alpha is kept below; the threshold only identifies crop ownership.
    labels, _ = ndimage.label(rgba[:, :, 3] > 32)
    sizes = np.bincount(labels.ravel())
    ids = np.argsort(sizes[1:])[-count:] + 1
    assert len(ids) == count and min(sizes[ids]) > 100, 'missing sprite objects'
    centers = {i: ndimage.center_of_mass(labels == i) for i in ids}
    rows = sorted(ids, key=lambda i: centers[i][0])
    order = [i for row in range(0, count, columns)
             for i in sorted(rows[row:row+columns], key=lambda i: centers[i][1])]
    seeds = np.where(np.isin(labels, ids), labels, 0)
    nearest = ndimage.distance_transform_edt(seeds == 0, return_distances=False, return_indices=True)
    owners = seeds[tuple(nearest)]
    result = []
    for i in order:
        pixels = rgba.copy()
        pixels[owners != i, 3] = 0  # Crop out neighboring sprite objects only.
        core = Image.fromarray((labels == i).astype('uint8') * 255).getbbox()
        box = (max(0, core[0]-3), max(0, core[1]-3),
               min(sheet.width, core[2]+3), min(sheet.height, core[3]+3))
        result.append((Image.fromarray(pixels).crop(box), box))
    return result


def render(name, spec, output):
    drawings = sprites(ROOT / spec['drawnSheet'])
    idle = Image.open(ROOT / spec['output'] / f'{name}-idle.webp').convert('RGBA')
    area = lambda image: sum(image.getchannel('A').histogram()[33:])
    scale = math.sqrt(area(idle) / area(drawings[0][0]))
    if name == 'the_collector':
        scale *= .94  # Canonical idle includes the staff, body-only source does not.
    ground = idle.getbbox()[3]
    def foot(image):
        box = image.getbbox()
        lower = image.getchannel('A').crop((0, round(box[1]+(box[3]-box[1])*.8), image.width, box[3])).getbbox()
        return (lower[0]+lower[2])/2
    center = foot(idle)
    poses = []
    points = []
    support_points = []
    if name == 'the_champ':
        scale *= .94  # Match body area after excluding the separate sword.
        sword = Image.open(ROOT/'scripts/animation/sources/champ-sword.png').convert('RGBA')
        sword = sword.resize((round(160*scale),round(160*scale*2/3)),Image.Resampling.LANCZOS)
        pivot = (1300*sword.width/1536,520*sword.height/1024)
        grips = [(199,225),(462,197),(730,126),(989,115),(1250,116),(1508,100),
                 (218,354),(323,450),(323,450),(830,440),(1090,441),(1351,440),
                 (70,697),(338,697),(590,696),(1001,654),(1243,639),(1500,631),
                 (232,872),(482,878),(729,880),(985,882),(1215,962),(1215,962)]
        # Two outliers reverse the attacking hand or fail to return to guard.
        drawings[8] = drawings[7]
        drawings[23] = drawings[0]
        grips[23] = grips[0]
    prop = json.loads((ROOT/'scripts/animation/drawn-props.json').read_text()).get(name)
    if prop:
        sword = Image.open(ROOT/f'scripts/animation/sources/{name}-staff.png').convert('RGBA')
        sword = sword.resize((round(prop['width']*scale),round(prop['width']*scale*sword.height/sword.width)),Image.Resampling.LANCZOS)
        pivot = (prop['pivot'][0]*sword.width/1536,prop['pivot'][1]*sword.height/1024)
        grips = prop['grips']
        order = spec.get('drawnOrder', list(range(24)))
        drawings = [drawings[i] for i in order]
        grips = [grips[i] for i in order]
        prop['angles'] = [prop['angles'][i] for i in order]
        support = [prop.get('supportGrips', [None]*24)[i] for i in order]
    if name == 'hero-hermit':
        # Reuse the first gun's native-alpha flash for the second muzzle.
        flash = Image.open(ROOT / spec['drawnSheet']).convert('RGBA').crop((728,296,782,353))
        muzzles = {8:(675,362),10:(1195,357),12:(165,610),14:(668,611),16:(1173,609)}
        drawings[2] = drawings[1]  # Reject the isolated premature gun-lowering pose.
    for index, (drawing, box) in enumerate(drawings):
        x, y = round(center-foot(drawing)*scale), ground-round(drawing.getbbox()[3]*scale)
        drawing = drawing.resize((round(drawing.width*scale), round(drawing.height*scale)), Image.Resampling.LANCZOS)
        frame = Image.new('RGBA', idle.size)
        frame.alpha_composite(drawing, (x, y))
        if name == 'hero-hermit' and index in muzzles:
            mx, my = muzzles[index]
            gx, gy = x+(mx-box[0])*scale, y+(my-box[1])*scale
            angle = math.radians(25 if index == 8 else 12)
            c, s = math.cos(angle)/scale, math.sin(angle)/scale
            second_flash = flash.transform(frame.size, Image.Transform.AFFINE,
                (c,s,-c*gx-s*gy,-s,c,30+s*gx-c*gy), Image.Resampling.BICUBIC)
            frame.alpha_composite(second_flash)
        if name == 'the_champ' or prop:
            points.append((x+(grips[index][0]-box[0])*scale,y+(grips[index][1]-box[1])*scale))
        if prop:
            point = support[index]
            support_points.append(None if point is None else
                (x+(point[0]-box[0])*scale,y+(point[1]-box[1])*scale))
        poses.append(frame)
    duration = spec.get('duration', 1830)
    phase_keys = ([0,7,16,23], [0,550,1100,duration]) if name.startswith('hero-') else ([0,6,9,16,23], [0,550,730,1280,duration])
    phase_keys = spec.get('drawnPhases', phase_keys)
    keys = np.rint(np.interp(np.arange(24), *phase_keys)).astype(int)
    boundaries = sorted({*phase_keys[1],*(round(t) for t in keys)})
    times = [a+round(i*(b-a)/max(1,round((b-a)/30)))
             for a,b in zip(boundaries,boundaries[1:]) for i in range(max(1,round((b-a)/30)))]
    frames = []
    for t in times:
        index = min(23, int(np.searchsorted(keys, t, side='right')-1))
        # Drawn in-betweens carry the anatomy. Rigid secondary sway avoids the
        # occlusion failures that optical-flow morphing caused at crossed arms.
        frame = poses[index]
        if name == 'the_champ':
            angle = np.interp(t,[0,550,730,1100,1280,duration],[200,315,180,205,300,200])
            frame = attach_weapon(frame,sword,pivot,points[index],angle)
        elif prop:
            angle = prop['angles'][index]
            grip = points[index]
            frame = attach_weapon(frame,sword,pivot,grip,angle,support_grip=support_points[index])
        if name == 'downfall_trickster':
            # His original cast summons a purple double. Reuse the exact body
            # and staff silhouette so the illusion cannot invent a new grip.
            opacity = float(np.interp(t, [0,550,730,1280,1450,duration], [0,0,.55,.55,0,0]))
            ghost = ImageOps.colorize(frame.convert('L'), (35,12,65), (211,144,255)).convert('RGBA')
            ghost.putalpha(frame.getchannel('A').point(lambda alpha: round(alpha*opacity)))
            combined = Image.new('RGBA', frame.size)
            combined.alpha_composite(ghost, (-round(45*scale), -round(12*scale)))
            combined.alpha_composite(frame)
            frame = combined
        frames.append(frame.rotate(.4*math.sin(2*math.pi*t/duration),
                      Image.Resampling.BICUBIC, center=(center,ground)))
    if name != 'the_champ' and not prop:
        frames[-1] = poses[-1]
    durations = [b-a for a,b in zip(times,times[1:]+[duration])]
    assert sum(durations) == duration and min(durations) >= 20
    frames[0].save(output, save_all=True, append_images=frames[1:], duration=durations,
                   loop=1, quality=88, method=4)
    print(f'{output.relative_to(ROOT)}: 24 drawn poses, {duration}ms', flush=True)
