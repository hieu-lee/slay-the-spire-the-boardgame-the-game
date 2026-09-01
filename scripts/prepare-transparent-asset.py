#!/usr/bin/env python3
"""Remove a baked neutral checker/background and verify real RGBA transparency."""

from __future__ import annotations

import argparse
from collections import deque
from pathlib import Path
from tempfile import TemporaryDirectory

from PIL import Image, ImageFilter


def neutral_background(pixel: tuple[int, int, int, int]) -> bool:
    red, green, blue, alpha = pixel
    return alpha == 0 or (min(red, green, blue) >= 208 and max(red, green, blue) - min(red, green, blue) <= 18)


def remove_edge_background(image: Image.Image) -> Image.Image:
    rgba = image.convert('RGBA')
    pixels = rgba.load()
    width, height = rgba.size
    queue: deque[tuple[int, int]] = deque()
    seen: set[tuple[int, int]] = set()
    for x in range(width):
        queue.extend(((x, 0), (x, height - 1)))
    for y in range(height):
        queue.extend(((0, y), (width - 1, y)))
    while queue:
        x, y = queue.popleft()
        if (x, y) in seen or not neutral_background(pixels[x, y]):
            continue
        seen.add((x, y))
        pixels[x, y] = (0, 0, 0, 0)
        for y_step in (-1, 0, 1):
            for x_step in (-1, 0, 1):
                adjacent = (x + x_step, y + y_step)
                if adjacent != (x, y) and 0 <= adjacent[0] < width and 0 <= adjacent[1] < height:
                    queue.append(adjacent)
    # Image generators often bake a pale anti-aliased fringe around a checkerboard.
    # Eroding the foreground by three source pixels removes that fringe before resize.
    alpha = rgba.getchannel('A').filter(ImageFilter.MinFilter(7))
    rgba.putalpha(alpha)
    rgba.paste((0, 0, 0, 0), mask=alpha.point(lambda value: 255 if value == 0 else 0))
    return rgba


def keep_largest_component(image: Image.Image, minimum_fraction: float = 1.0) -> Image.Image:
    """Drop disconnected sheet debris while preserving substantial character pieces."""
    alpha = image.getchannel('A')
    visible = alpha.point(lambda value: 255 if value > 16 else 0)
    pixels = visible.load()
    width, height = visible.size
    seen: set[tuple[int, int]] = set()
    components: list[list[tuple[int, int]]] = []
    largest: list[tuple[int, int]] = []
    for y in range(height):
        for x in range(width):
            if not pixels[x, y] or (x, y) in seen:
                continue
            component: list[tuple[int, int]] = []
            queue = deque([(x, y)])
            seen.add((x, y))
            while queue:
                point = queue.popleft()
                component.append(point)
                px, py = point
                for adjacent in ((px - 1, py), (px + 1, py), (px, py - 1), (px, py + 1)):
                    if 0 <= adjacent[0] < width and 0 <= adjacent[1] < height and \
                      pixels[adjacent[0], adjacent[1]] and adjacent not in seen:
                        seen.add(adjacent)
                        queue.append(adjacent)
            if len(component) > len(largest):
                largest = component
            components.append(component)
    if not largest:
        raise ValueError('expected visible pixels')
    mask = Image.new('L', image.size)
    mask_pixels = mask.load()
    for component in components:
        if len(component) < len(largest) * minimum_fraction:
            continue
        for x, y in component:
            mask_pixels[x, y] = alpha.getpixel((x, y))
    cleaned = image.copy()
    cleaned.putalpha(mask)
    cleaned.paste((0, 0, 0, 0), mask=mask.point(lambda value: 255 if value == 0 else 0))
    return cleaned


def prepare(source: Path, destination: Path, max_edge: int | None, largest_component: bool = False) -> None:
    with Image.open(source) as opened:
        image = remove_edge_background(opened)
    if largest_component:
        image = keep_largest_component(image)
    if max_edge and max(image.size) > max_edge:
        scale = max_edge / max(image.size)
        size = (round(image.width * scale), round(image.height * scale))
        image = image.convert('RGBa').resize(size, Image.Resampling.LANCZOS).convert('RGBA')
    alpha = image.getchannel('A')
    transparent = alpha.histogram()[0]
    if transparent < image.width * image.height // 20 or alpha.getbbox() is None:
        raise ValueError(f'{source}: expected at least 5% transparent background and visible foreground')
    destination.parent.mkdir(parents=True, exist_ok=True)
    options = {'quality': 92, 'method': 6, 'exact': True} if destination.suffix.lower() == '.webp' else {}
    image.save(destination, **options)


def fit_alpha(source: Path, destination: Path, max_edge: int, flip_horizontal: bool = False) -> None:
    with Image.open(source) as opened:
        image = opened.convert('RGBA')
    bounds = image.getchannel('A').getbbox()
    if bounds is None:
        raise ValueError(f'{source}: expected visible pixels')
    image = image.crop(bounds)
    if flip_horizontal:
        image = image.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    scale = min(max_edge / image.width, max_edge / image.height)
    size = (round(image.width * scale), round(image.height * scale))
    image = image.convert('RGBa').resize(size, Image.Resampling.LANCZOS).convert('RGBA')
    canvas = Image.new('RGBA', (max_edge, max_edge))
    canvas.alpha_composite(image, ((max_edge - image.width) // 2, max_edge - image.height))
    destination.parent.mkdir(parents=True, exist_ok=True)
    options = {'quality': 92, 'method': 6, 'exact': True} if destination.suffix.lower() == '.webp' else {}
    canvas.save(destination, **options)


def split_pair(source: Path, destination: Path, max_edge: int,
               minimum_component_fraction: float | None = None, padding: int = 0) -> tuple[Path, Path]:
    with Image.open(source) as opened:
        sheet = opened.convert('RGBA')
    middle = sheet.width // 2
    outputs = []
    for name, bounds in (('idle', (0, 0, middle, sheet.height)),
                         ('attack', (middle, 0, sheet.width, sheet.height))):
        frame = sheet.crop(bounds)
        if minimum_component_fraction is not None:
            frame = keep_largest_component(frame, minimum_component_fraction)
        alpha_bounds = frame.getchannel('A').getbbox()
        if alpha_bounds is None:
            raise ValueError(f'{source}: {name} frame has no visible pixels')
        frame = frame.crop(alpha_bounds)
        available = max_edge - padding * 2
        scale = min(available / frame.width, available / frame.height)
        size = (round(frame.width * scale), round(frame.height * scale))
        frame = frame.convert('RGBa').resize(size, Image.Resampling.LANCZOS).convert('RGBA')
        canvas = Image.new('RGBA', (max_edge, max_edge))
        canvas.alpha_composite(frame, ((max_edge - frame.width) // 2, max_edge - padding - frame.height))
        output = destination.with_name(f'{destination.stem}-{name}{destination.suffix}')
        output.parent.mkdir(parents=True, exist_ok=True)
        options = {'quality': 92, 'method': 6, 'exact': True} if output.suffix.lower() == '.webp' else {}
        canvas.save(output, **options)
        outputs.append(output)
    return outputs[0], outputs[1]


def split_grid_row(source: Path, destination: Path, max_edge: int, row: int, rows: int = 4) -> tuple[Path, Path]:
    """Extract one idle/attack row from a two-column transparent key-frame sheet."""
    with Image.open(source) as opened:
        sheet = opened.convert('RGBA')
    if row < 0 or row >= rows:
        raise ValueError(f'row must be between 0 and {rows - 1}')
    middle = sheet.width // 2
    top = round(sheet.height * row / rows)
    bottom = round(sheet.height * (row + 1) / rows)
    row_image = sheet.crop((0, top, sheet.width, bottom))
    temporary = destination.with_name(f'{destination.stem}-row{destination.suffix}')
    row_image.save(temporary)
    try:
        return split_pair(temporary, destination, max_edge, .02)
    finally:
        temporary.unlink()


def horizontal_bands(image: Image.Image, expected: int = 4) -> list[tuple[int, int]]:
    alpha = image.getchannel('A')
    occupied = [alpha.crop((0, y, image.width, y + 1)).getbbox() is not None for y in range(image.height)]
    bands: list[tuple[int, int]] = []
    start: int | None = None
    for y, visible in enumerate([*occupied, False]):
        if visible and start is None:
            start = y
        elif not visible and start is not None:
            if y - start >= image.height * .05:
                bands.append((start, y))
            start = None
    if len(bands) != expected:
        raise ValueError(f'expected {expected} horizontal character bands, got {bands}')
    return bands


def split_grid_band(source: Path, destination: Path, max_edge: int, row: int) -> tuple[Path, Path]:
    """Extract one visual row without assuming generated figures obey exact grid boundaries."""
    with Image.open(source) as opened:
        sheet = opened.convert('RGBA')
    bands = horizontal_bands(sheet)
    if row < 0 or row >= len(bands):
        raise ValueError(f'row must be between 0 and {len(bands) - 1}')
    top, bottom = bands[row]
    row_image = sheet.crop((0, top, sheet.width, bottom))
    temporary = destination.with_name(f'{destination.stem}-band{destination.suffix}')
    row_image.save(temporary)
    try:
        return split_pair(temporary, destination, max_edge, .02, max_edge // 20)
    finally:
        temporary.unlink()


def animate_pair(idle_source: Path, attack_source: Path, destination: Path, max_edge: int) -> tuple[Path, Path]:
    """Build lightweight idle and attack WebPs from two transparent key frames."""
    frames = []
    for source in (idle_source, attack_source):
        with Image.open(source) as opened:
            frame = opened.convert('RGBA')
        if frame.size != (max_edge, max_edge):
            raise ValueError(f'{source}: expected {max_edge}x{max_edge}, got {frame.size}')
        frames.append(frame)
    idle, attack = frames
    bob = Image.new('RGBA', idle.size)
    bob.alpha_composite(idle, (0, -3))
    outputs = []
    for name, sequence, durations in (
        ('idle', [idle, bob, idle], [480, 480, 480]),
        ('attack', [idle, attack, idle], [180, 220, 180]),
    ):
        output = destination.with_name(f'{destination.stem}-{name}{destination.suffix}')
        output.parent.mkdir(parents=True, exist_ok=True)
        sequence[0].save(output, save_all=True, append_images=sequence[1:], duration=durations,
                         loop=0, quality=92, method=6, exact=True, minimize_size=True,
                         background=(0, 0, 0, 0), disposal=[1] * len(sequence), blend=[0] * len(sequence))
        outputs.append(output)
    return outputs[0], outputs[1]


def package_hero_grid(source: Path, destination: Path, max_edge: int) -> None:
    with TemporaryDirectory() as directory:
        for row, hero in enumerate(('ironclad', 'silent', 'defect', 'watcher')):
            key = Path(directory) / hero
            idle, attack = split_grid_band(source, key.with_suffix('.webp'), max_edge, row)
            animate_pair(idle, attack, destination / f'downfall_pc_{hero}.webp', max_edge)


def self_test() -> None:
    with TemporaryDirectory() as directory:
        source = Path(directory) / 'checker.png'
        output = Path(directory) / 'cutout.webp'
        image = Image.new('RGBA', (48, 48), (240, 240, 240, 255))
        for y in range(48):
            for x in range(48):
                if (x // 6 + y // 6) % 2: image.putpixel((x, y), (255, 255, 255, 255))
        for y in range(12, 36):
            for x in range(16, 32): image.putpixel((x, y), (20, 160, 70, 255))
        image.save(source)
        prepare(source, output, 24)
        with Image.open(output) as checked:
            assert max(checked.size) == 24
            assert checked.convert('RGBA').getpixel((0, 0))[3] == 0
            assert checked.convert('RGBA').getpixel((12, 12))[3] > 0
        pair = Path(directory) / 'pair.png'
        pair_image = Image.new('RGBA', (40, 20))
        pair_image.paste((255, 0, 0, 255), (4, 2, 16, 20))
        pair_image.paste((0, 0, 255, 255), (24, 4, 38, 20))
        pair_image.save(pair)
        idle, attack = split_pair(pair, Path(directory) / 'boss.webp', 24)
        assert idle.name == 'boss-idle.webp' and attack.name == 'boss-attack.webp'
        assert Image.open(idle).size == (24, 24) and Image.open(attack).size == (24, 24)
        animated_idle, animated_attack = animate_pair(idle, attack, Path(directory) / 'animated.webp', 24)
        assert Image.open(animated_idle).n_frames == 3 and Image.open(animated_attack).n_frames == 3
        grid = Path(directory) / 'grid.png'
        grid_image = Image.new('RGBA', (40, 80))
        grid_image.paste((255, 0, 0, 255), (2, 42, 18, 78))
        grid_image.paste((0, 0, 255, 255), (22, 42, 38, 78))
        grid_image.save(grid)
        grid_idle, grid_attack = split_grid_row(grid, Path(directory) / 'grid-frame.webp', 24, 2)
        assert Image.open(grid_idle).convert('RGBA').getpixel((12, 12))[0] > 200
        assert Image.open(grid_attack).convert('RGBA').getpixel((12, 12))[2] > 200
        band_grid = Path(directory) / 'band-grid.png'
        band_image = Image.new('RGBA', (40, 80))
        for row in range(4):
            band_image.paste((255, 0, 0, 255), (2, row * 20 + 2, 18, row * 20 + 18))
            band_image.paste((0, 0, 255, 255), (22, row * 20 + 2, 38, row * 20 + 18))
        band_image.save(band_grid)
        band_idle, band_attack = split_grid_band(band_grid, Path(directory) / 'band-frame.webp', 24, 2)
        assert Image.open(band_idle).getchannel('A').getbbox()[1] > 0
        assert Image.open(band_attack).getchannel('A').getbbox()[3] < 24
        asymmetric = Path(directory) / 'asymmetric.png'
        flipped = Path(directory) / 'flipped.png'
        asymmetric_image = Image.new('RGBA', (20, 20))
        asymmetric_image.paste((255, 0, 0, 255), (2, 2, 10, 18))
        asymmetric_image.paste((0, 0, 255, 255), (10, 2, 18, 18))
        asymmetric_image.save(asymmetric)
        fit_alpha(asymmetric, flipped, 20, True)
        with Image.open(flipped) as checked:
            assert checked.convert('RGBA').getpixel((2, 10))[2] > 200
            assert checked.convert('RGBA').getpixel((17, 10))[0] > 200


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('source', nargs='?')
    parser.add_argument('destination', nargs='?')
    parser.add_argument('--max-edge', type=int)
    parser.add_argument('--self-test', action='store_true')
    parser.add_argument('--split-pair', action='store_true')
    parser.add_argument('--split-grid-row', type=int)
    parser.add_argument('--split-grid-band', type=int)
    parser.add_argument('--fit-alpha', action='store_true')
    parser.add_argument('--flip-horizontal', action='store_true')
    parser.add_argument('--largest-component', action='store_true')
    parser.add_argument('--animate-pair')
    parser.add_argument('--package-hero-grid', action='store_true')
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    if not args.source or not args.destination:
        parser.error('source and destination are required unless --self-test is used')
    if args.split_pair:
        split_pair(Path(args.source), Path(args.destination), args.max_edge or 512)
        return
    if args.package_hero_grid:
        package_hero_grid(Path(args.source), Path(args.destination), args.max_edge or 512)
        return
    if args.split_grid_row is not None:
        split_grid_row(Path(args.source), Path(args.destination), args.max_edge or 512, args.split_grid_row)
        return
    if args.split_grid_band is not None:
        split_grid_band(Path(args.source), Path(args.destination), args.max_edge or 512, args.split_grid_band)
        return
    if args.fit_alpha:
        fit_alpha(Path(args.source), Path(args.destination), args.max_edge or 512, args.flip_horizontal)
        return
    if args.animate_pair:
        animate_pair(Path(args.source), Path(args.animate_pair), Path(args.destination), args.max_edge or 512)
        return
    prepare(Path(args.source), Path(args.destination), args.max_edge, args.largest_component)


if __name__ == '__main__':
    main()
