#!/usr/bin/env python3
"""Turn Imagegen's light checkerboard into real transparency.

Usage: python3 scripts/remove-generated-background.py input.png output.png
"""

from argparse import ArgumentParser
from collections import deque
from pathlib import Path
from tempfile import TemporaryDirectory

from PIL import Image


def remove_background(source: Path, destination: Path, dark: bool = False) -> None:
    image = Image.open(source).convert("RGBA")
    pixels = image.load()
    width, height = image.size
    background = bytearray(width * height)
    queue: deque[tuple[int, int]] = deque()

    def checker(x: int, y: int) -> bool:
        red, green, blue, _alpha = pixels[x, y]
        if dark:
            return max(red, green, blue) < 72
        return min(red, green, blue) >= 220 and max(red, green, blue) - min(red, green, blue) <= 12

    for x in range(width):
        queue.extend(((x, 0), (x, height - 1)))
    for y in range(1, height - 1):
        queue.extend(((0, y), (width - 1, y)))
    while queue:
        x, y = queue.popleft()
        index = y * width + x
        if background[index] or not checker(x, y):
            continue
        background[index] = 1
        if x > 0:
            queue.append((x - 1, y))
        if x + 1 < width:
            queue.append((x + 1, y))
        if y > 0:
            queue.append((x, y - 1))
        if y + 1 < height:
            queue.append((x, y + 1))

    for index, is_background in enumerate(background):
        x, y = index % width, index // width
        red, green, blue, alpha = pixels[x, y]
        if is_background:
            alpha = 0
        elif dark:
            light = max(red, green, blue)
            alpha = 255 if light < 72 else min(255, light * 3)
        pixels[x, y] = red, green, blue, alpha

    destination.parent.mkdir(parents=True, exist_ok=True)
    image.save(destination)


def self_test() -> None:
    with TemporaryDirectory() as directory:
        source = Path(directory) / "source.png"
        destination = Path(directory) / "result.png"
        image = Image.new("RGB", (10, 8), "white")
        pixels = image.load()
        for y in range(8):
            for x in range(10):
                pixels[x, y] = (238, 238, 238) if (x // 2 + y // 2) % 2 else (255, 255, 255)
        for y in range(2, 6):
            for x in range(2, 8):
                pixels[x, y] = (30, 150, 220)
        pixels[4, 4] = (255, 255, 255)
        image.save(source)
        remove_background(source, destination)
        alpha = Image.open(destination).getchannel("A")
        assert alpha.getpixel((0, 0)) == 0
        assert alpha.getpixel((3, 2)) == 255
        assert alpha.getpixel((4, 4)) == 255
        dark_source = Path(directory) / "dark.png"
        dark_result = Path(directory) / "dark-result.png"
        dark_image = Image.new("RGB", (8, 6))
        for y in range(1, 5):
            for x in range(1, 7):
                dark_image.putpixel((x, y), (20, 160, 40))
        dark_image.putpixel((3, 3), (0, 0, 0))
        dark_image.save(dark_source)
        remove_background(dark_source, dark_result, dark=True)
        dark_alpha = Image.open(dark_result).getchannel("A")
        assert dark_alpha.getpixel((0, 0)) == 0
        assert dark_alpha.getpixel((3, 3)) == 255


def main() -> None:
    parser = ArgumentParser()
    parser.add_argument("source", nargs="?", type=Path)
    parser.add_argument("destination", nargs="?", type=Path)
    parser.add_argument("--dark", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    if not args.source or not args.destination:
        parser.error("source and destination are required")
    remove_background(args.source, args.destination, dark=args.dark)


if __name__ == "__main__":
    main()
