"""Regenerate the short, original UI click in both browser audio formats."""

import math
import random
import struct
import subprocess
import wave
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1] / "public/assets/sfx"
RATE = 48_000
rng = random.Random(17)
samples = []
noise_average = 0.0
for i in range(round(RATE * 0.105)):
    t = i / RATE
    noise_average = 0.82 * noise_average + 0.18 * rng.uniform(-1, 1)
    snap = (rng.uniform(-1, 1) - noise_average) * math.exp(-t / 0.0035) * 0.24
    body = math.sin(2 * math.pi * (510 * t - 2400 * t * t)) * math.exp(-t / 0.022) * 0.36
    ring = math.sin(2 * math.pi * 890 * t) * math.exp(-t / 0.029) * 0.09
    # A quieter release gives the press a tactile "down/up" shape.
    release = math.sin(2 * math.pi * 440 * (t - 0.026)) * math.exp(-(t - 0.026) / 0.012) * 0.085 if t >= 0.026 else 0
    envelope = min(1, t / 0.0005, (0.105 - t) / 0.008)
    samples.append(round(32767 * (snap + body + ring + release) * envelope))

with wave.open(str(ROOT / "ui.wav"), "wb") as output:
    output.setnchannels(1)
    output.setsampwidth(2)
    output.setframerate(RATE)
    output.writeframes(struct.pack(f"<{len(samples)}h", *samples))
subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(ROOT / "ui.wav"),
                "-ac", "2", "-codec:a", "vorbis", "-strict", "experimental", "-qscale:a", "4",
                "-bitexact", "-serial_offset", "42",
                str(ROOT / "ui.ogg")], check=True)
