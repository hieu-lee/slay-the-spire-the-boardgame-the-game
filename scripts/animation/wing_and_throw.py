"""Bake Byrd's layered wingbeats and Cultist's rigid-prop throw with native alpha.

All layers use canonical source coordinates, one registration and one scale.
No runtime canvas, frame loop, background removal or per-frame silhouette fit.
"""
import math
import base64
import io
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy.interpolate import PchipInterpolator

ROOT = Path(__file__).resolve().parents[2]
SOURCES = ROOT / 'scripts/animation/sources'


def layer(image, polygon):
    mask = Image.new('L', image.size)
    ImageDraw.Draw(mask).polygon(polygon, fill=255)
    result = image.copy()
    result.putalpha(Image.fromarray(np.minimum(np.array(image.getchannel('A')), np.array(mask))))
    return result


def rotate(image, angle, pivot):
    return image.rotate(angle, Image.Resampling.BICUBIC, center=pivot)


def render(name, spec, output):
    original = Image.open(ROOT / spec['source']).convert('RGBA')
    width = spec['size']
    size = (width, round(width * original.height / original.width))
    left, top, right, bottom = spec['sourceBounds']
    scale = min(width * .8 / (right-left), size[1] * .88 / (bottom-top)) / spec['displayScale']
    offset = ((width-round((right-left)*scale))//2-left*scale,
              round(size[1]*(1-(1-spec.get('ground', .98))/spec['displayScale']))-bottom*scale)

    def register(source):
        return source.transform(size, Image.Transform.AFFINE,
            (1/scale, 0, -offset[0]/scale, 0, 1/scale, -offset[1]/scale), Image.Resampling.BICUBIC)

    if name == 'byrd':
        body = Image.open(SOURCES / 'byrd-body.png').convert('RGBA').resize(original.size, Image.Resampling.LANCZOS)
        # Visible feather regions extend behind the restored body at both roots.
        wings = [layer(original, [(0,60),(420,157),(375,228),(340,264),(287,312),(165,307),(0,263)]),
                 layer(original, [(620,202),(685,108),(780,22),(1024,0),(1024,322),(745,355),(662,312)])]
        wings = [register(wing) for wing in wings]
        body = register(body)
        pivots = [(x*scale+offset[0], y*scale+offset[1]) for x,y in [(400,220),(630,245)]]
        duration = 3000
        times = [round(i*duration/72) for i in range(72)]
        frames = []
        for t in times:
            # Three wingbeats per loop; the torso does not scale with the wings.
            wave = math.sin(2*math.pi*t/1000)
            canvas = Image.new('RGBA', size)
            canvas.alpha_composite(rotate(wings[0], -24*wave, pivots[0]))
            canvas.alpha_composite(rotate(wings[1], 27*wave, pivots[1]))
            canvas.alpha_composite(body)
            frames.append(canvas.transform(size, Image.Transform.AFFINE,
                (1, 0, 0, 0, 1, round(14*wave)), Image.Resampling.BICUBIC))
    else:
        empty = Image.open(SOURCES / 'cultist-body.png').convert('RGBA').resize(original.size, Image.Resampling.LANCZOS)
        # Only replace the released arms and feather sleeves; keep canonical head,
        # torso and feet. The source canvas has the same normalized registration.
        arms = [[(0,0),(280,0),(264,291),(218,407),(0,520)],
                [(465,0),(896,0),(896,591),(538,566),(465,432)]]
        held = [layer(original, polygon) for polygon in arms]
        released = [layer(empty, polygon) for polygon in arms]
        mask = Image.new('L', original.size, 255)
        draw = ImageDraw.Draw(mask)
        for polygon in arms: draw.polygon(polygon, fill=0)
        body = original.copy()
        body.putalpha(Image.fromarray(np.minimum(np.array(body.getchannel('A')), np.array(mask))))
        torso = Image.open(SOURCES / 'cultist-torso.png').convert('RGBA').resize(original.size, Image.Resampling.LANCZOS)
        underlay = layer(torso, [(160,250),(300,250),(300,490),(160,490)])
        underlay.alpha_composite(layer(torso, [(445,315),(620,315),(620,530),(445,530)]))
        underlay = register(underlay)
        held = [register(arm) for arm in held]
        released = [register(arm) for arm in released]
        body = register(body)
        pivots = [(x*scale+offset[0], y*scale+offset[1]) for x,y in [(246,345),(497,395)]]
        duration = 1830
        # Exact release at 500ms, when the CSS projectile flight begins.
        times = sorted({t for t in range(0,duration-19,33) if abs(t-500)>=20} | {500})
        motion = PchipInterpolator([0,300,430,500,650,1000,1500,1790,1830],
                                  [0,-12,-19,20,24,16,0,0,0])
        frames = []
        for t in times:
            canvas = underlay.copy()
            layers = released if 500 <= t < 1500 else held
            angle = float(motion(t))
            canvas.alpha_composite(rotate(layers[0], angle, pivots[0]))
            canvas.alpha_composite(rotate(layers[1], angle*.65, pivots[1]))
            canvas.alpha_composite(body)
            frames.append(canvas)
        # WebKit may paint the animated SVG's held layer a frame late. This
        # registered empty-handed pose covers it on the CSS release clock.
        released_pose = frames[min(range(len(times)), key=lambda i: abs(times[i]-650))]
        released_pose.save(output.with_name('cultist-released.webp'), quality=90, method=6)
        # WebKit can throttle animated WebP frames independently of CSS flight.
        # SMIL uses elapsed time for the same rigid layers and release boundary.
        def svg_image(image):
            data = io.BytesIO()
            image.save(data, format='WEBP', quality=90, method=6)
            return f'<image width="{size[0]}" height="{size[1]}" href="data:image/webp;base64,{base64.b64encode(data.getvalue()).decode()}"/>'

        svg = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{size[0]}" height="{size[1]}" viewBox="0 0 {size[0]} {size[1]}">', svg_image(underlay)]
        key_times = ';'.join(f'{t/duration:.8f}' for t in times+[duration])
        for index, pivot in enumerate(pivots):
            values = ';'.join(f'{-float(motion(t))*(1 if index==0 else .65):.5f} {pivot[0]:.5f} {pivot[1]:.5f}' for t in times+[duration])
            svg.append(f'<g><animateTransform attributeName="transform" type="rotate" dur="{duration}ms" values="{values}" keyTimes="{key_times}" fill="freeze"/>')
            for images, visibility in [(held,'1;0;1;1'),(released,'0;1;0;0')]:
                svg.append(f'<g opacity="{visibility[0]}"><animate attributeName="opacity" dur="{duration}ms" calcMode="discrete" keyTimes="0;{500/duration:.8f};{1500/duration:.8f};1" values="{visibility}" fill="freeze"/>{svg_image(images[index])}</g>')
            svg.append('</g>')
        svg.extend([svg_image(body), '</svg>'])
        output.parent.mkdir(parents=True, exist_ok=True)
        output.with_suffix('.svg').write_text(''.join(svg))
        # The same source prop is used for both spinning sticks in the browser.
        prop = Image.open(SOURCES / 'cultist-stick.png').convert('RGBA')
        prop = prop.crop(prop.getchannel('A').point(lambda a: 255 if a > 32 else 0).getbbox())
        prop.thumbnail((160,240), Image.Resampling.LANCZOS)
        path = ROOT / 'public/assets/combat/enemies/props/cultist-sticks.webp'
        path.parent.mkdir(exist_ok=True)
        prop.save(path, quality=90, method=6)

    for frame in frames:
        box = frame.getchannel('A').point(lambda a: 255 if a > 32 else 0).getbbox()
        assert box and box[0]>0 and box[1]>0 and box[2]<size[0] and box[3]<size[1], (name, 'clipped', box)
    durations = [end-start for start,end in zip(times,times[1:]+[duration])]
    assert min(durations)>=20
    output.parent.mkdir(parents=True, exist_ok=True)
    frames[0].save(output, save_all=True, append_images=frames[1:], duration=durations,
                   loop=0 if name=='byrd' else 1, quality=82, method=4)
    print(f'{output.resolve().relative_to(ROOT)}: {len(frames)} frames, {duration}ms', flush=True)
