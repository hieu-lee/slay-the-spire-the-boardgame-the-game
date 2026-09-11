"""Sample the original drawn attacks without deforming their anatomy or weapons.

One registration per source sequence, never an independently fitted frame.
World travel and projectile clocks remain in CSS. Newly drawn in-betweens can
replace the source poses without changing those clocks.
"""
import math
from pathlib import Path
from PIL import Image, ImageDraw
from interpolate import interpolate

ROOT = Path(__file__).resolve().parents[2]
CHARACTERS = ROOT / 'public/assets/combat/characters'
BOSSES = ROOT / 'public/assets/combat/enemies/animations'


def frames_at(path):
    image = Image.open(path)
    frames, ends, elapsed = [], [], 0
    for i in range(image.n_frames):
        image.seek(i)
        frames.append(image.convert('RGBA'))
        elapsed += image.info.get('duration', 0)
        ends.append(elapsed)
    return frames, ends


def available(name):
    return name.startswith('hero-') or (BOSSES / f'{name}-attack.webp').exists()


def render(name, spec, output):
    original = Image.open(ROOT / spec['source']).convert('RGBA')
    rest = original.crop(original.getbbox())
    width = spec.get('size', 400)
    height = round(width * original.height / original.width)
    scale = min(width*.8/rest.width, height*spec.get('heightFit', .88)/rest.height)
    display_scale = spec.get('displayScale', 1)
    scale /= display_scale
    ground = round(height*(1-(1-spec.get('ground', .98))/display_scale))
    duration = spec.get('duration', 1830)
    if name.startswith('hero-'):
        character = name.removeprefix('hero-')
        if character.startswith('hexaghost'):
            poses, ends = frames_at(CHARACTERS / f'{character}-attack.webp')
        else:
            character = 'guardian' if character == 'guardian-defense' else character
            suffixes = {'silent': ('throw', 'throw'), 'defect': ('charge', 'release'),
                        'watcher': ('ready', 'thrust')}.get(character, ('ready', 'impact'))
            ready, impact = [Image.open(CHARACTERS / f'{character}-{suffix}.webp').convert('RGBA') for suffix in suffixes]
            if character == 'silent': poses, ends = [original, impact], [150,1900]
            elif character == 'slime_boss': poses, ends = [ready, impact, ready, original], [600,1100,1630,1700]
            else: poses, ends = [original,ready,impact,original], [550,1100,1650,1650]
        # Hero sources share physical artwork scale in their original canvases.
        # Watcher's files differ in canvas width but retain the same 512px height.
        source_scale = scale
    else:
        poses, ends = frames_at(BOSSES / f'{name}-attack.webp')
        # Match the first anticipation drawing to canonical idle once.
        # Ready silhouettes can have raised limbs, unlike the canonical idle.
        # Match physical painted area once, then keep that scale for ALL poses.
        # Per-frame fitting would resize the body whenever a weapon extends.
        def area(image):
            return sum(image.getchannel('A').histogram()[33:])
        source_scale = scale * math.sqrt(area(original) / area(poses[0]))
    fixed_core = name.startswith('hero-hexaghost')
    rest_box = original.getbbox()
    foot_band = original.getchannel('A').crop((0, round(rest_box[1]+(rest_box[3]-rest_box[1])*.75), original.width, rest_box[3])).getbbox()
    rest_center = (foot_band[0]+foot_band[2])/2
    target_center = (width-rest.width*scale)/2 + (rest_center-rest_box[0])*scale
    registered = []
    for pose in poses:
        box = original.getbbox() if fixed_core else pose.getbbox()
        # Ground anchor, with body registration from the lower half (excludes
        # long horizontal weapons). All frames use the SAME physical scale.
        lower = pose.getchannel('A').crop((0, round(box[1]+(box[3]-box[1])*.75), pose.width, box[3])).getbbox()
        center = rest_center if fixed_core else ((lower[0]+lower[2])/2 if lower else (box[0]+box[2])/2)
        resized = pose.resize((round(pose.width*source_scale), round(pose.height*source_scale)), Image.Resampling.LANCZOS)
        canvas = Image.new('RGBA',(width,height))
        canvas.alpha_composite(resized,(round(target_center-center*source_scale),ground-round(box[3]*source_scale)))
        registered.append(canvas)
    core = None
    if fixed_core:
        # One canonical crystal overlays the changing flame drawings. Its rigid
        # outline and position stay fixed; no generated small-core pose is used.
        mask = Image.new('L', original.size)
        ImageDraw.Draw(mask).polygon([(192,212),(246,163),(298,158),(362,210),
            (369,251),(359,296),(310,341),(275,344),(230,321),(193,285)],fill=255)
        crystal = original.copy()
        crystal.putalpha(mask)
        crystal = crystal.resize((round(original.width*scale),round(original.height*scale)),Image.Resampling.LANCZOS)
        core = Image.new('RGBA',(width,height))
        core.alpha_composite(crystal,(round(target_center-rest_center*scale),ground-round(rest_box[3]*scale)))
    # Thirty samples per second within each original phase. Boundaries are exact
    # and no sub-20ms WebP frames are emitted (browsers may clamp those delays).
    boundaries = {0, duration, *ends}
    times = sorted((boundaries-{duration}) | {t for t in range(0,duration,33) if min(abs(t-b) for b in boundaries)>=20})
    frames = []
    for t in times:
        index = next((i for i,end in enumerate(ends) if t<end),len(ends)-1)
        start = 0 if index == 0 else ends[index-1]
        next_index = min(index+1, len(registered)-1)
        fraction = (t-start)/(ends[index]-start)
        pose = (registered[index] if registered[index].tobytes() == registered[next_index].tobytes()
                else interpolate(registered[index], registered[next_index], fraction))
        if core is not None:
            pose = pose.copy()
            pose.alpha_composite(core)
        # Small rigid anticipation/recoil accompanies the drawn in-betweens.
        phase = t/duration
        angle = math.sin(phase*math.pi*2)*.7
        frame = pose.rotate(angle, Image.Resampling.BICUBIC, center=(width/2,ground))
        frames.append(frame)
    durations = [b-a for a,b in zip(times,times[1:]+[duration])]
    assert sum(durations)==duration and min(durations)>=20
    frames[0].save(output,save_all=True,append_images=frames[1:],duration=durations,loop=1,quality=86,method=4)
    print(f'{output.relative_to(ROOT)}: authored poses, {duration}ms',flush=True)
