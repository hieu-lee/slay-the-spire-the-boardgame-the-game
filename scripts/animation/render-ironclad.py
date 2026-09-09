"""Audited body poses with one rigid sword; original 1800ms choreography."""
from PIL import Image
import numpy as np, math
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]; OUT=ROOT/'public/assets/combat/rigged'; size=(400,266); scale=.39
weapon=Image.open(ROOT/'scripts/animation/sources/ironclad-sword.png').convert('RGBA')
weapon=weapon.resize((120,80),Image.Resampling.LANCZOS);pivot=(1310*120/1536,525*120/1536)
grips=[(143,46),(153,40),(170,42),(176,43),(180,28),(183,36),
       (232,57),(256,72),(277,70),(279,70),(286,86),(306,108),
       (307,112),(301,127),(284,163),(278,188),(310,184),(296,197),
       (285,203),(264,210),(280,196),(283,201),(285,200),(285,201)]
angles=[150,195,240,270,275,285,300,310,325,335,345,355,
        355,360,365,370,374,375,376,377,378,378,378,378]
bodies=[];points=[]
for half,rows in [('upper',[0,350,695,1024]),('lower',[0,335,678,1024])]:
    sheet=Image.open(ROOT/f'scripts/animation/sources/ironclad-body-{half}.png').convert('RGBA')
    for i in range(12):
        pose=sheet.crop((i%4*384,rows[i//4],(i%4+1)*384,rows[i//4+1]))
        bottom=pose.getbbox()[3]
        offset=(235-round(175*scale),263-round(bottom*scale))
        frame=Image.new('RGBA',size)
        pose=pose.resize((round(pose.width*scale),round(pose.height*scale)),Image.Resampling.LANCZOS)
        frame.alpha_composite(pose,offset);bodies.append(frame)
        grip=grips[len(points)]
        points.append((offset[0]+grip[0]*scale,offset[1]+grip[1]*scale))
from rigid_weapon import attach_weapon
def attach(body,grip,degrees):
    return attach_weapon(body,weapon,pivot,grip,degrees,7)

# The full original clock is preserved: raise, dash, swing, return, recover.
# Pose 15 briefly reverses the descending hands; omit that drawing.
sequence=[i for i in range(24) if i != 15]
keys=[(round(i*540/(len(sequence)-1)),pose) for i,pose in enumerate(reversed(sequence))]
keys += [(630,0)] + [(round(630+i*540/(len(sequence)-1)),pose) for i,pose in enumerate(sequence) if i]
keys += [(1260,23),(1800,23)]
for action,duration in [('idle',3000),('attack',1800)]:
    boundaries={ms for ms,_ in keys} if action=='attack' else {0,duration}
    segments=sorted(boundaries)
    times=[a+round(i*(b-a)/max(1,round((b-a)/30))) for a,b in zip(segments,segments[1:]) for i in range(max(1,round((b-a)/30)))]
    frames=[]
    for t in times:
        if action=='idle':
            body=bodies[23];grip=points[23];angle=angles[23]
        else:
            k=min(max(i for i,(ms,_) in enumerate(keys) if ms<=t),len(keys)-2)
            a,ai=keys[k];b,bi=keys[k+1];u=(t-a)/(b-a)
            body=bodies[ai]
            grip=points[ai]
            angle=angles[ai]*(1-u)+angles[bi]*u
        frame=attach(body,grip,angle)
        # Subtle rigid weight shift keeps the resting grip and blade unchanged.
        frame=frame.rotate(.45*math.sin(2*math.pi*t/duration),Image.Resampling.BICUBIC,center=(235,263))
        frames.append(frame)
    durations=[b-a for a,b in zip(times,times[1:]+[duration])]
    assert sum(durations)==duration and min(durations)>=20
    for frame in frames:
        bounds=frame.getchannel('A').point(lambda a:255 if a>32 else 0).getbbox()
        assert bounds and bounds[0]>0 and bounds[1]>0 and bounds[2]<size[0] and bounds[3]<size[1],bounds
    output=OUT/f'hero-ironclad-{action}.webp'
    frames[0].save(output,save_all=True,append_images=frames[1:],duration=durations,loop=0 if action=='idle' else 1,quality=88,method=4)
    print(f'{output.relative_to(ROOT)}: {len(frames)} samples, {duration}ms',flush=True)
