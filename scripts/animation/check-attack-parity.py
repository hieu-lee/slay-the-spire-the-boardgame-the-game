"""Check actual browser-painted poses against the unchanged Chrome WebP frames.

Failure modes: a WebKit decoder can stretch short frames; a hidden/preloaded
one-shot can start early; a frozen or prematurely recovered weapon can still
pass CSS timing/geometry checks. Compare pixels at the live combat clock, not
just animation duration or a screenshot hash that changes with root motion.
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

root = Path(__file__).resolve().parents[2]
manifest = Path(sys.argv[1])
rigs = json.loads((root / 'scripts/animation/rigs.json').read_text())
results = []
samples = json.loads(manifest.read_text())
assert samples, 'No painted attack samples to verify'
for sample in samples:
    actor = sample['actor']
    source = Image.open(root / rigs[actor]['output'] / f'{actor}-attack.webp')
    painted = Image.open(sample['path']).convert('RGB')
    size = painted.size
    frames, times, masks = [], [], []
    elapsed = 0
    for index in range(source.n_frames):
        source.seek(index)
        source.load()
        frame = source.convert('RGBA').resize(size, Image.Resampling.LANCZOS)
        masks.append(np.array(frame)[:, :, 3] > 32)
        background = Image.new('RGBA', size, '#17222d')
        background.alpha_composite(frame)
        frames.append(np.array(background.convert('RGB'), dtype=float))
        times.append(elapsed)
        elapsed += source.info['duration']
    mask = np.logical_or.reduce(masks)
    pixels = np.array(painted, dtype=float)
    errors = [np.abs(pixels - frame)[mask].mean() for frame in frames]
    # Screenshots are captured between these two live-clock reads; allow one
    # display/decode beat on either side, not cumulative half-second drift.
    candidates = [index for index, time in enumerate(times)
                  if time <= sample['after'] + 80 and
                  (times[index + 1] if index + 1 < len(times) else elapsed) >= sample['before'] - 80]
    nearest = min(range(len(times)), key=errors.__getitem__)
    expected = min(candidates, key=errors.__getitem__)
    visible = float((np.max(np.abs(pixels - [23, 34, 45]), axis=2)[mask] > 20).mean())
    # Browser resampling/edge antialiasing can favour another frame of the
    # same held pose. Reject missing bodies too, not just relative pose error.
    result = {**sample, 'nearestPoseMs': times[nearest], 'bestError': float(errors[nearest]),
              'clockError': float(errors[expected]),
              'visibleFraction': visible,
              'clean': bool(visible > .2 and errors[expected] <= errors[nearest] + 1.5)}
    results.append(result)
manifest.with_name('pose-report.json').write_text(json.dumps(results, indent=2) + '\n')
failures = [result for result in results if not result['clean']]
for result in failures:
    print(f"FAIL {result['actor']}: combat={result['before']:.0f}..{result['after']:.0f}ms, "
          f"painted pose={result['nearestPoseMs']}ms, pixel error={result['clockError']:.2f} "
          f"vs {result['bestError']:.2f}")
assert not failures, f'{len(failures)} painted attacks disagree with the combat clock; see {manifest.with_name("pose-report.json")}'
print(f'PASS {len(results)} live painted attack poses; report: {manifest.with_name("pose-report.json")}')
