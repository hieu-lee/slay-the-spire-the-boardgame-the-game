"""Upright, independently flickering heat flames over the shared zero-heat body."""
import json
import math
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT/'public/assets/combat/rigged'
ART = ROOT/'public/assets/combat/characters'
# Bottom centers in the 400px registered body canvas. Every flame points up.
ANCHORS = [(132,194),(268,194),(320,292),(268,390),(132,390),(82,292)]
flame = Image.open(ROOT/'public/assets/combat/vfx/actions/hexaghost-flame.webp').convert('RGBA')
flame = flame.crop(flame.getbbox())


def overlay(body, heat, time, factor=1, offset=(0,0)):
    frame = body.copy()
    for index, (x,y) in enumerate(ANCHORS[:heat]):
        phase = time/1000*math.tau
        # Short vertical pulses imitate rising fire; the base never tilts or drifts.
        width = round(27*factor*(1+.045*math.sin(phase*3+index*1.7)))
        height = round(62*factor*(1+.09*math.sin(phase*5+index*1.3)))
        tongue = flame.resize((width,height),Image.Resampling.LANCZOS)
        opacity = .92+.08*math.sin(phase*4+index*2.1)
        tongue.putalpha(tongue.getchannel('A').point(lambda a: round(a*opacity)))
        frame.alpha_composite(tongue,(round((x-offset[0])*factor-width/2),round((y-offset[1])*factor-height)))
    return frame


def render(heat):
    for action in ('idle','attack'):
        body = Image.open(OUT/f'hero-hexaghost-heat-0-{action}.webp')
        frames, durations, time = [], [], 0
        for index in range(body.n_frames):
            body.seek(index)
            frame = body.convert('RGBA')
            duration = body.info['duration']
            frames.append(overlay(frame,heat,time))
            durations.append(duration)
            time += duration
        frames[0].save(OUT/f'hero-hexaghost-heat-{heat}-{action}.webp',save_all=True,
            append_images=frames[1:],duration=durations,loop=0 if action=='idle' else 1,quality=88,method=4)
    # Reduced motion uses the same vertical flames, frozen in a natural phase.
    original = Image.open(ART/'hexaghost-heat-0.webp').convert('RGBA')
    box = original.getbbox()
    spec = json.loads((ROOT/'scripts/animation/rigs.json').read_text())['hero-hexaghost-heat-0']
    scale = min(400*.8/(box[2]-box[0]),400*.88/(box[3]-box[1]))/spec['displayScale']
    ground = round(400*(1-.02/spec['displayScale']))
    offset = ((400-(box[2]-box[0])*scale)/2-box[0]*scale,ground-box[3]*scale)
    overlay(original,heat,0,1/scale,offset).save(ART/f'hexaghost-heat-{heat}.webp',quality=90,method=4)
    print(f'Hexaghost heat {heat}: vertical flames, shared body, idle and attack clocks preserved',flush=True)


if __name__ == '__main__':
    for heat in range(1,7):
        render(heat)
