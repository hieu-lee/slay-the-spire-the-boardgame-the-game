#!/usr/bin/env python3
"""Register a generated upscale to the original canvas without changing its display geometry."""
import argparse
from pathlib import Path
from PIL import Image, ImageStat


def bounds(image):
    return image.getchannel('A').point(lambda a: 255 if a > 32 else 0).getbbox()


def register(original, generated, scale=2):
    original, generated = original.convert('RGBA'), generated.convert('RGBA')
    old, new = bounds(original), bounds(generated)
    assert old and new, 'both images need a visible subject'
    target = tuple(round(v * scale) for v in old)
    sx = (target[2]-target[0]) / (new[2]-new[0])
    sy = (target[3]-target[1]) / (new[3]-new[1])
    # Resample native alpha, including soft edges; do not key or erase a background.
    output = generated.convert('RGBa').transform(
        tuple(round(v * scale) for v in original.size), Image.Transform.AFFINE,
        (1/sx, 0, new[0]-target[0]/sx, 0, 1/sy, new[1]-target[1]/sy),
        Image.Resampling.BICUBIC).convert('RGBA')
    assert max(abs(a-b) for a,b in zip(bounds(output), target)) <= 3, (bounds(output), target)
    return output


def register_sheet(original_path, generated_path):
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parent / 'animation'))
    from drawn import sprites
    original = Image.open(original_path)
    output = Image.new('RGBA', tuple(v*2 for v in original.size))
    for (old, box), (new, _) in zip(sprites(original_path), sprites(generated_path)):
        output.alpha_composite(register(old, new), (box[0]*2, box[1]*2))
    return output


def scene(original, generated):
    width = generated.width
    output = generated.convert('RGB').resize((width, round(width*original.height/original.width)), Image.Resampling.LANCZOS)
    # Keep the original scene exposure when restoration brightens its texture.
    before = ImageStat.Stat(original.convert('RGB').resize((64, 64))).mean
    after = ImageStat.Stat(output.resize((64, 64))).mean
    channels = [channel.point([round(min(255, v * a / max(b, 1))) for v in range(256)])
                for channel, a, b in zip(output.split(), before, after)]
    return Image.merge('RGB', channels)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('original', type=Path)
    parser.add_argument('generated', type=Path)
    parser.add_argument('output', type=Path)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--scene', action='store_true')
    mode.add_argument('--sheet', action='store_true')
    parser.add_argument('--scale', type=float, default=2)
    args = parser.parse_args()
    assert args.scale > 0
    with Image.open(args.original) as original, Image.open(args.generated) as generated:
        result = register_sheet(args.original, args.generated) if args.sheet else (
            scene(original, generated) if args.scene else register(original, generated, args.scale))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    result.save(args.output, quality=94, method=6, exact=True)
    print(f'{args.output}: {result.width}x{result.height}')
