#!/usr/bin/env python3
"""Safari Web Audio cannot decode Ogg; retain its exact decoded float samples."""
from pathlib import Path
import subprocess

for source in sorted((Path(__file__).resolve().parents[2] / 'public/assets/sfx').glob('*.ogg')):
    target = source.with_suffix('.wav')
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(source), '-c:a', 'pcm_f32le', str(target)], check=True)
    decoded = [subprocess.check_output(['ffmpeg', '-v', 'error', '-i', str(path), '-f', 'f32le', '-'])
               for path in (source, target)]
    assert decoded[0] == decoded[1], f'{source.name}: audio samples changed'
    print(f'{target.name}: exact PCM parity ({len(decoded[0])} bytes)')
