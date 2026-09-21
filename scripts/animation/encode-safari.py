#!/usr/bin/env python3
"""Encode rigged WebPs as Safari's hardware-decoded HEVC-with-alpha format."""
import argparse
import hashlib
import json
import re
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageChops, ImageSequence

ROOT = Path(__file__).resolve().parents[2]
RIGGED = ROOT / 'public/assets/combat/rigged'
MANIFEST = ROOT / 'scripts/animation/safari-video-sources.json'
ENCODER = 'hevc-alpha-vfr-q100-v1'


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def verify_pixels(source, video, width, height):
    frame_size = width * height * 4
    decoder = subprocess.Popen([
        'ffmpeg', '-v', 'error', '-i', str(video), '-fps_mode', 'passthrough',
        '-enc_time_base', 'demux', '-f', 'rawvideo',
        '-pix_fmt', 'bgra', 'pipe:1',
    ], stdout=subprocess.PIPE)
    worst_mean = worst_large_error = worst_alpha_error = 0
    def read_frame():
        pixels = bytearray()
        while len(pixels) < frame_size:
            block = decoder.stdout.read(frame_size - len(pixels))
            if not block:
                break
            pixels.extend(block)
        return bytes(pixels)
    try:
        with Image.open(source) as animation:
            for index, frame in enumerate(ImageSequence.Iterator(animation)):
                pixels = read_frame()
                if len(pixels) != frame_size:
                    raise RuntimeError(f'decoded only {index} frames from {video.name}')
                reference = Image.new('RGBA', (width, height))
                reference.paste(frame.convert('RGBA'), ((width - animation.width) // 2, height - animation.height))
                decoded = Image.frombytes('RGBA', (width, height), pixels, 'raw', 'BGRA')
                difference = ImageChops.difference(reference, decoded)
                visible = reference.getchannel('A').point(lambda alpha: 255 if alpha > 128 else 0)
                visible_pixels = visible.histogram()[255]
                if visible_pixels:
                    histogram = difference.convert('RGB').histogram(visible)
                    mean = sum((value % 256) * count for value, count in enumerate(histogram)) / (visible_pixels * 3)
                    large_error = sum(
                        sum(histogram[channel * 256 + 21:(channel + 1) * 256]) for channel in range(3)
                    ) / (visible_pixels * 3)
                    worst_mean = max(worst_mean, mean)
                    worst_large_error = max(worst_large_error, large_error)
                alpha_histogram = difference.getchannel('A').histogram()
                worst_alpha_error = max(worst_alpha_error, sum(alpha_histogram[11:]) / (width * height))
        # The concat sentinel repeats the final source frame for one millisecond.
        if len(read_frame()) != frame_size or decoder.stdout.read(1):
            raise RuntimeError(f'unexpected sentinel frames in {video.name}')
        decoder.stdout.close()
        if decoder.wait() != 0:
            raise RuntimeError(f'ffmpeg could not decode {video.name}')
    except BaseException:
        decoder.kill()
        decoder.wait()
        raise
    if worst_mean > 16 or worst_large_error > .3 or worst_alpha_error > .005:
        raise RuntimeError(
            f'visible quality loss in {video.name}: mean={worst_mean:.2f}, '
            f'RGB>20={worst_large_error:.2%}, alpha>10={worst_alpha_error:.2%}'
        )


def encode(source, output):
    mux = subprocess.check_output(['webpmux', '-info', str(source)], text=True)
    durations = [int(line.split()[6]) for line in mux.splitlines() if re.match(r'^\s*\d+:', line)]
    if not durations:
        durations = [33]
    with Image.open(source) as animation:
        width, height = animation.size
        encoded_width, encoded_height = width + width % 2, height + height % 2
        if animation.n_frames != len(durations):
            raise RuntimeError(f'webpmux/Pillow frame mismatch for {source.name}: {len(durations)} != {animation.n_frames}')
        with tempfile.TemporaryDirectory(prefix='safari-animation-') as directory:
            directory = Path(directory)
            concat = ['ffconcat version 1.0']
            for index, (frame, duration) in enumerate(zip(ImageSequence.Iterator(animation), durations)):
                name = f'{index:05}.png'
                rgba = frame.convert('RGBA')
                if rgba.size != (encoded_width, encoded_height):
                    padded = Image.new('RGBA', (encoded_width, encoded_height))
                    # Preserve bottom-anchored combat geometry when HEVC needs an even canvas.
                    padded.paste(rgba, ((encoded_width - width) // 2, encoded_height - height))
                    rgba = padded
                rgba.save(directory / name)
                concat.extend((f"file '{name}'", 'option framerate 1000', f'duration {duration / 1000:.3f}'))
            # The concat demuxer needs the terminal frame twice to retain its duration.
            concat.extend((f"file '{len(durations) - 1:05}.png'", 'option framerate 1000'))
            concat_path = directory / 'frames.ffconcat'
            concat_path.write_text('\n'.join(concat) + '\n')
            subprocess.run([
                'ffmpeg', '-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', str(concat_path),
                '-fps_mode', 'vfr', '-an', '-c:v', 'hevc_videotoolbox', '-tag:v', 'hvc1',
                '-pix_fmt', 'bgra', '-alpha_quality', '1', '-q:v', '100',
                '-movflags', '+faststart', str(output),
            ], check=True)
    details = json.loads(subprocess.check_output([
        'ffprobe', '-v', 'error', '-show_entries',
        'stream=codec_name,codec_tag_string,width,height,nb_frames,duration:packet=pts_time,duration_time',
        '-of', 'json', str(output),
    ]))
    probe = details['streams'][0]
    actual = (probe['codec_name'], probe['codec_tag_string'], probe['width'], probe['height'], int(probe['nb_frames']))
    expected = ('hevc', 'hvc1', encoded_width, encoded_height, len(durations) + 1)
    if actual != expected:
        raise RuntimeError(f'invalid video for {source.name}: expected {expected}, got {actual}')
    starts = [sum(durations[:index]) for index in range(len(durations))]
    packets = [(round(float(packet['pts_time']) * 1000), round(float(packet['duration_time']) * 1000))
      for packet in details['packets']]
    expected_packets = [*zip(starts, durations), (sum(durations), 1)]
    if packets != expected_packets or round(float(probe['duration']) * 1000) != sum(durations) + 1:
        raise RuntimeError(f'timing changed for {source.name}: expected {expected_packets}, got {packets}')
    verify_pixels(source, output, encoded_width, encoded_height)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('files', nargs='*', type=Path)
    parser.add_argument('--rigs', help='comma-separated rig names')
    parser.add_argument('--force', action='store_true')
    args = parser.parse_args()
    files = [path if path.is_absolute() else ROOT / path for path in args.files]
    if not files:
        files = sorted(RIGGED.glob('*.webp'))
    if args.rigs:
        rigs = set(args.rigs.split(','))
        known_rigs = json.loads((ROOT / 'scripts/animation/rigs.json').read_text())
        files = [path for path in files if max(
            (rig for rig in known_rigs if path.stem.startswith(f'{rig}-')), key=len, default=''
        ) in rigs]

    records = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {}
    for source in files:
        relative = source.relative_to(ROOT).as_posix()
        output = source.with_suffix('.mov')
        source_hash = digest(source)
        current = records.get(relative)
        if not args.force and current and current.get('encoder') == ENCODER and current.get('source') == source_hash \
          and output.exists() and current.get('video') == digest(output):
            print(f'{output.relative_to(ROOT)}: current', flush=True)
            continue
        temporary = output.with_name(f'.{output.stem}.tmp.mov')
        encode(source, temporary)
        temporary.replace(output)
        records[relative] = {'encoder': ENCODER, 'source': source_hash, 'video': digest(output)}
        MANIFEST.write_text(json.dumps(dict(sorted(records.items())), indent=2) + '\n')
        print(f'{output.relative_to(ROOT)}', flush=True)

    existing = {path.relative_to(ROOT).as_posix() for path in RIGGED.glob('*.webp')}
    records = {name: records[name] for name in sorted(records) if name in existing}
    MANIFEST.write_text(json.dumps(records, indent=2) + '\n')


if __name__ == '__main__':
    main()
