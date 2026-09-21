// Generated art retains the original canvas, subject scale and placement.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
const result = spawnSync('python3', ['-c', `
import json, runpy
from pathlib import Path
from PIL import Image, ImageDraw
m = runpy.run_path('scripts/register-upscaled-art.py')
a = Image.new('RGBA', (100,80)); ImageDraw.Draw(a).rectangle((20,10,70,75), fill='red')
b = Image.new('RGBA', (400,400)); ImageDraw.Draw(b).rectangle((130,40,250,350), fill='red')
c = m['register'](a,b)
assert c.size == (200,160)
assert max(abs(x-y) for x,y in zip(m['bounds'](c),(40,20,142,152))) <= 1
manifest = json.loads(Path('docs/asset-resolution.json').read_text())
assert manifest['assets'], 'missing resolution inventory'
for entry in manifest['assets']:
    im = Image.open(entry['path'])
    assert list(im.size) == entry['size'], (entry['path'], 'resolution regressed', im.size)
    if 'bounds' in entry:
        assert im.mode == 'RGBA', (entry['path'], 'lost native alpha')
        actual = m['bounds'](im)
        assert actual and max(abs(a-b) for a,b in zip(actual,entry['bounds'])) <= 4, (entry['path'], 'subject moved or changed size', actual, entry['bounds'])
print(f"PASS: {len(manifest['assets'])} high-resolution assets; native alpha and original registration preserved")
`], { encoding: 'utf8' })
assert.equal(result.status, 0, result.stderr || result.stdout)
process.stdout.write(result.stdout)
