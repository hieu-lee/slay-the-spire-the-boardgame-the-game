import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

// Browser canvas drawImage samples WebP's first frame. Inspect native frames
// offline to prove wing amplitude, complete prop release and fixed body size.
const result = spawnSync('python3', ['-c', `
from pathlib import Path
from PIL import Image
import numpy as np
import xml.etree.ElementTree as ET
root = Path('public/assets/combat/enemies/animated')
byrd = Image.open(root/'byrd-idle.webp')
tops = []
bodies = []
bottoms = []
for i in range(byrd.n_frames):
    byrd.seek(i)
    pixels = np.array(byrd.convert('RGBA'))
    y,x = np.where(pixels[:,:,3][:,560:] > 96)
    tops.append(y.min())
    bottom = np.where(pixels[:,:,3] > 96)[0].max()
    bottoms.append(bottom)
    offset = bottom-bottoms[0]
    bodies.append(pixels[285+offset:320+offset,405:435,:])
assert max(tops)-min(tops)>100, ('wings barely move', tops)
assert 20 <= max(bottoms)-min(bottoms) <= 40, ('missing gentle flight bob', bottoms)
assert max(abs(previous-current) for previous,current in zip(bottoms,bottoms[1:]+bottoms[:1])) <= 5, 'flight bob jumps at a frame or loop boundary'
assert max(np.abs(bodies[0].astype(float)-b.astype(float)).mean() for b in bodies)<3, 'wingbeat scales the torso'
attack = Image.open(root/'cultist-attack.webp')
elapsed = 0
released = 0
for i in range(attack.n_frames):
    attack.seek(i)
    pixels = np.array(attack.convert('RGBA'))
    red = (pixels[:,:,0]>140)&(pixels[:,:,1]<100)&(pixels[:,:,2]<100)&(pixels[:,:,3]>96)
    # The bird mask's red mouth stays painted throughout the throw.
    red[:,235:400] = False
    if elapsed == 0: assert red.sum()>1500, 'opening pose lost the sticks'
    if 500 <= elapsed < 1450:
        assert red.sum()<60, ('stick fragment remains after release', elapsed, red.sum())
        released += 1
    elapsed += attack.info['duration']
assert released>20 and elapsed==1830, 'missing release/recovery samples'
assert (root/'byrd-idle.webp').stat().st_size<4_000_000
assert (root/'cultist-attack.webp').stat().st_size<3_200_000
svg_path = root/'cultist-attack.svg'
svg = ET.parse(svg_path).getroot()
ns = {'s':'http://www.w3.org/2000/svg'}
assert svg.attrib['width']=='800' and int(svg.attrib['height'])==attack.height
assert svg_path.stat().st_size<250_000
assert len(svg.findall('.//s:image',ns))==6
assert all(image.attrib['href'].startswith('data:image/webp;base64,') for image in svg.findall('.//s:image',ns))
assert len(svg.findall('.//s:animateTransform',ns))==2
for transition in svg.findall('.//s:animate',ns):
    assert transition.attrib['dur']=='1830ms'
    assert abs(float(transition.attrib['keyTimes'].split(';')[1])*1830-500)<.001
print('PASS native frames: wing amplitude, smooth flight bob, fixed torso size, complete stick release, timing and size budgets')
`], { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8' })
assert.equal(result.status, 0, result.stderr || result.stdout)
console.log(result.stdout.trim())

const calibration = spawnSync('python3', ['scripts/calibrate-enemy-size.py', '--only=byrd,cultist', '--check'], {
  cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8',
})
assert.equal(calibration.status, 0, calibration.stderr)
console.log('PASS enemy size calibration: exported paths and wing clearance preserved')
