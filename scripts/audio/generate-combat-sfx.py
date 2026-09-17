#!/usr/bin/env python3
"""Deterministic original combat effects; requires NumPy and FFmpeg."""
from pathlib import Path
import subprocess
import tempfile
import wave
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'public/assets/sfx'
RATE = 48000
rng = np.random.default_rng(20260917)


def noise(n, smooth=1):
    values = rng.standard_normal(n)
    if smooth > 1:
        values = np.convolve(values, np.ones(smooth) / smooth, mode='same')
    return values / max(np.std(values), .001)


def tone(t, start, end, duration):
    return np.sin(2 * np.pi * (start * t + (end - start) * t * t / (2 * duration)))


def render(name, duration, build, echoes=()):
    t = np.arange(round(duration * RATE)) / RATE
    signal = build(t)
    for delay, gain in echoes:
        offset = round(delay * RATE)
        signal[offset:] += signal[:-offset].copy() * gain
    # Remove DC and taper both boundaries; no clipping or start/end clicks.
    signal -= signal.mean()
    edge = min(240, len(signal) // 10)
    signal[:48] *= np.linspace(0, 1, 48)
    signal[-edge:] *= np.linspace(1, 0, edge)
    signal = np.tanh(signal * .65)
    signal *= .78 / max(np.max(np.abs(signal)), .001)
    with tempfile.TemporaryDirectory() as directory:
        source = Path(directory) / 'source.wav'
        with wave.open(str(source), 'wb') as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(RATE)
            wav.writeframes((signal * 32767).astype('<i2').tobytes())
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', str(source),
                        '-c:a', 'libmp3lame', '-q:a', '4', str(OUT / f'{name}.mp3')], check=True)
    print(f'{name}: {duration:.2f}s')


render('gunshot', .24, lambda t: noise(len(t)) * np.exp(-t * 105) * 2.2
       + noise(len(t), 32) * np.exp(-t * 22) * .9
       + tone(t, 150, 48, .24) * np.exp(-t * 24), [(0.024, .25), (.052, .10)])
render('bullet-impact', .17, lambda t: noise(len(t)) * np.exp(-t * 90)
       + tone(t, 380, 85, .17) * np.exp(-t * 48) * .65)
render('meteor-fall', .5, lambda t: noise(len(t), 18) * (.12 + t * 2) * .8
       + noise(len(t), 160) * t * 1.3
       + tone(t, 210, 950, .5) * t * .12)
render('meteor-impact', .85, lambda t: noise(len(t), 65) * np.exp(-t * 8) * 1.5
       + noise(len(t)) * np.exp(-t * 32) * .8
       + tone(t, 95, 28, .85) * np.exp(-t * 9)
       + noise(len(t), 6) * np.exp(-t * 9) * np.maximum(0, np.sin(t * 105)) * .35,
       [(.075, .24), (.16, .12)])
render('sword-swing', .32, lambda t: (noise(len(t), 3) - noise(len(t), 55) * .22)
       * np.sin(np.pi * t / .32) ** 2 * (.5 + t)
       + tone(t, 900, 180, .32) * np.sin(np.pi * t / .32) ** 3 * .07)
render('sword-clash', .46, lambda t: noise(len(t)) * np.exp(-t * 130) * 1.3
       + sum(np.sin(2 * np.pi * frequency * t) * np.exp(-t * decay) * gain
             for frequency, decay, gain in [(1463, 17, .23), (2381, 22, .16), (3749, 28, .11), (691, 13, .22)])
       + noise(len(t), 35) * np.exp(-t * 32) * .45, [(.038, .16)])
render('lightning-burst', .38, lambda t: noise(len(t)) * np.exp(-t * 12)
       * (.25 + .75 * np.maximum(0, np.sin(t * 420)) ** 3)
       + noise(len(t), 80) * np.exp(-t * 13) * .7
       + tone(t, 1600, 180, .38) * np.exp(-t * 24) * .09, [(.032, .15)])
render('dark-beam', .55, lambda t: (tone(t, 165, 47, .55) * .55
       + tone(t, 171, 50, .55) * .3 + noise(len(t), 14) * .22)
       * np.sin(np.pi * t / .55) ** .6 + noise(len(t)) * np.exp(-t * 65) * .3,
       [(.055, .17)])
render('frost-bloom', .55, lambda t: sum(np.sin(2 * np.pi * f * t) * np.exp(-t * d) * g
       for f, d, g in [(1847, 12, .18), (2939, 15, .16), (4133, 19, .09)])
       + noise(len(t)) * np.exp(-t * 13) * .35
       + noise(len(t), 32) * np.sin(np.pi * t / .55) * .22, [(.048, .23)])
render('flame-burst', .48, lambda t: noise(len(t), 28) * np.sin(np.pi * t / .48) ** .7
       + noise(len(t)) * np.exp(-t * 18) * .25
       + tone(t, 110, 40, .48) * np.exp(-t * 12) * .25)
render('slime-splat', .30, lambda t: sum(tone(np.maximum(0, t - d), f, 45, .30)
       * np.exp(-np.maximum(0, t - d) * 30) * (t >= d) * .3
       for d, f in [(0, 330), (.027, 470), (.062, 250), (.1, 570)])
       + noise(len(t), 12) * np.exp(-t * 19) * .5)
render('poison-hiss', .45, lambda t: noise(len(t), 4) * np.sin(np.pi * t / .45) * .45
       + tone(t, 650, 95, .45) * np.exp(-t * 17) * .16)
