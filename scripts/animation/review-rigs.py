#!/usr/bin/env python3
"""Verify baked motion and record every rig's idle/attack in review galleries."""
import json
import sys
import subprocess
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'artifacts/rig-animation/review'
OUT.mkdir(parents=True, exist_ok=True)
rigs = json.loads((ROOT / 'scripts/animation/rigs.json').read_text())
metadata = {}
def reviewed_rigs():
    for name, spec in rigs.items():
        poses = {}
        for pose in ('idle', 'attack'):
            path = ROOT / spec['output'] / f'{name}-{pose}.webp'
            im = Image.open(path)
            frames, durations, boxes, areas = [], [], [], []
            for i in range(im.n_frames):
                im.seek(i)
                frame = im.convert('RGBA')
                frames.append(frame.copy())
                durations.append(im.info['duration'])
                alpha = np.array(frame.getchannel('A'))
                boxes.append(Image.fromarray(np.where(alpha>32,255,0).astype('uint8')).getbbox())
                areas.append((alpha>32).sum())
            assert len(frames) >= 45, (name, pose, 'insufficient motion samples')
            assert max(durations) <= 67, (name, pose, 'held pose')
            assert sum(durations) == (3000 if pose == 'idle' else spec.get('duration',1830)), (name,pose,'duration')
            assert all(b and b[0]>0 and b[1]>0 and b[2]<im.width and b[3]<im.height for b in boxes), (name,pose,'clipped silhouette')
            assert max(areas)/min(areas)<1.3, (name,pose,'area changed too much',max(areas)/min(areas))
            poses[pose] = (frames, np.cumsum(durations))
        assert poses['idle'][0][0].size == poses['attack'][0][0].size, (name,'canvas mismatch')
        first,last = [np.array(f).astype(float) for f in [poses['attack'][0][0],poses['attack'][0][-1]]]
        assert np.abs(first[:,:,:3]*first[:,:,3:]/255-last[:,:,:3]*last[:,:,3:]/255).mean()<3, (name,'rest pose does not return')
        idx = round((len(poses['attack'][0])-1)*spec.get('contact',.4))
        metadata[name] = {'contactLeft': poses['attack'][0][idx].getbbox()[0], 'height': poses['attack'][0][idx].height}
        yield (name,poses,spec.get('duration',1830))

def render_gallery(group, batch):
    file=OUT/f'roster-{batch//8+1}.mp4'
    encoder=subprocess.Popen(['ffmpeg','-y','-v','error','-f','rawvideo','-pix_fmt','rgb24','-s','1280x640','-r','30','-i','-','-an','-c:v','libx264','-preset','fast','-crf','20','-pix_fmt','yuv420p',str(file)],stdin=subprocess.PIPE)
    strip=Image.new('RGB',(1280,640*4),'#26333c')
    for tick in range(210):
        t=tick*1000/30
        canvas=Image.new('RGB',(1280,640),'#26333c');draw=ImageDraw.Draw(canvas)
        for j,(name,poses,duration) in enumerate(group):
            pose='attack' if 3000<=t<3000+duration else 'idle'
            local=t-3000 if pose=='attack' else t%3000
            frames,ends=poses[pose];frame=frames[min(len(frames)-1,int(np.searchsorted(ends,local)))].copy()
            frame.thumbnail((310,280),Image.Resampling.LANCZOS)
            x=j%4*320;y=j//4*320
            draw.line((x,y+291,x+320,y+291),fill='#52636f')
            canvas.paste(frame,(x+(320-frame.width)//2,y+291-frame.height),frame)
            draw.text((x+8,y+301),name+' / '+pose,fill='white')
        encoder.stdin.write(canvas.tobytes())
        if tick in (60,96,112,145):strip.paste(canvas,(0,[60,96,112,145].index(tick)*640))
    encoder.stdin.close();assert encoder.wait()==0
    strip.save(OUT/f'roster-{batch//8+1}-frames.jpg',quality=90)
    print(file.relative_to(ROOT),flush=True)

# Release each rig after validation, or each gallery batch after encoding.
group = []
for index, rig in enumerate(reviewed_rigs()):
    if '--check-only' in sys.argv:
        continue
    group.append(rig)
    if len(group) == 8:
        render_gallery(group, index - 7)
        group.clear()
if group:
    render_gallery(group, len(rigs) - len(group))

# Contact offsets are expressed in source pixels, matching EnemyCard's measurement.
metadata_path = ROOT/'src/ui/rig-animation-metadata.json'
if '--write-metadata' in sys.argv:
    metadata_path.write_text(json.dumps(metadata,indent=2)+'\n')
else:
    assert json.loads(metadata_path.read_text()) == metadata, 'stale contact metadata; run --write-metadata'
print(f'PASS: {len(rigs)} rigs, 2 poses each; timing, alpha bounds, area and return pose')
