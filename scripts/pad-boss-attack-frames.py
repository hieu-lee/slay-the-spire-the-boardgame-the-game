#!/usr/bin/env python3
"""Add transparent safety margins to animated boss attack WebPs."""

from argparse import ArgumentParser
from collections import deque
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory

from PIL import Image


def visible_bbox(frame: Image.Image):
    return frame.getchannel("A").point(lambda alpha: 255 if alpha > 16 else 0).getbbox()


def components_of(frame: Image.Image) -> list[list[tuple[int, int]]]:
    alpha = frame.getchannel("A")
    width, height = frame.size
    seen = bytearray(width * height)
    components: list[list[tuple[int, int]]] = []
    for y in range(height):
        for x in range(width):
            index = y * width + x
            if seen[index] or alpha.getpixel((x, y)) <= 16:
                continue
            seen[index] = 1
            queue = deque([(x, y)])
            component = []
            while queue:
                current_x, current_y = queue.popleft()
                component.append((current_x, current_y))
                for next_x, next_y in (
                    (current_x - 1, current_y), (current_x + 1, current_y),
                    (current_x, current_y - 1), (current_x, current_y + 1),
                ):
                    if not (0 <= next_x < width and 0 <= next_y < height):
                        continue
                    next_index = next_y * width + next_x
                    if seen[next_index] or alpha.getpixel((next_x, next_y)) <= 16:
                        continue
                    seen[next_index] = 1
                    queue.append((next_x, next_y))
            components.append(component)
    return components


def clear_component(frame: Image.Image, component: list[tuple[int, int]]) -> None:
    pixels = frame.load()
    for x, y in component:
        red, green, blue, _alpha = pixels[x, y]
        pixels[x, y] = red, green, blue, 0


def remove_clipped_specks(frame: Image.Image) -> None:
    width, height = frame.size
    components = components_of(frame)
    if not components:
        return
    cutoff = max(8, len(max(components, key=len)) * 0.01)
    for component in components:
        touches_edge = any(x in (0, width - 1) or y in (0, height - 1) for x, y in component)
        if not touches_edge or len(component) >= cutoff:
            continue
        clear_component(frame, component)


def remove_windup_leaks(frame: Image.Image) -> None:
    """Drop detached pieces copied from the impact cell to the wind-up's right edge."""
    width, _height = frame.size
    components = components_of(frame)
    if not components:
        return
    actor = max(components, key=len)
    for component in components:
        if component is actor or min(x for x, _y in component) < width * 0.72:
            continue
        clear_component(frame, component)


def save_animation(path: Path, frames: list[Image.Image], durations: list[int], loop: int) -> None:
    temporary = path.with_suffix('.tmp.webp')
    with TemporaryDirectory() as directory:
        inputs = []
        for index, (frame, duration) in enumerate(zip(frames, durations)):
            source = Path(directory) / f'{index}.png'
            frame.save(source)
            inputs.extend(['-d', str(duration), '-lossy', '-q', '90', '-m', '3', '-exact', str(source)])
        subprocess.run(
            ['img2webp', '-loop', str(loop), '-min_size', '-mixed', *inputs, '-o', str(temporary)],
            check=True,
            capture_output=True,
        )
    temporary.replace(path)


def pad_animation(path: Path, margin: int = 24) -> None:
    animation = Image.open(path)
    frames = []
    durations = []
    for index in range(animation.n_frames):
        animation.seek(index)
        frame = animation.convert("RGBA")
        if index == 0 and path.stem in {
            "time_eater-attack", "the_champ-attack", "slime_boss-attack", "deca-attack"
        }:
            remove_windup_leaks(frame)
            if path.stem == "the_champ-attack":
                # Keep the raised sword, remove the neighboring impact-cell arc.
                frame.paste(
                    (0, 0, 0, 0),
                    (round(frame.width * 0.80), round(frame.height * 0.36), frame.width, frame.height),
                )
        remove_clipped_specks(frame)
        frames.append(frame)
        durations.append(animation.info.get("duration", 100))
    boxes = [box for frame in frames if (box := visible_bbox(frame))]
    if not boxes:
        return
    width, height = frames[0].size
    left = max(0, margin - min(box[0] for box in boxes))
    top = max(0, margin - min(box[1] for box in boxes))
    right = max(0, margin - min(width - box[2] for box in boxes))
    bottom = max(0, margin - min(height - box[3] for box in boxes))
    if left or top or right or bottom:
        padded = []
        for frame in frames:
            canvas = Image.new("RGBA", (width + left + right, height + top + bottom))
            canvas.alpha_composite(frame, (left, top))
            padded.append(canvas)
        frames = padded
    save_animation(path, frames, durations, animation.info.get('loop', 1))


def self_test() -> None:
    with TemporaryDirectory() as directory:
        path = Path(directory) / "attack.webp"
        frames = [Image.new("RGBA", (8, 6)), Image.new("RGBA", (8, 6))]
        for frame in frames:
            for x in range(4):
                for y in range(3):
                    frame.putpixel((x, y), (30, 150, 220, 255))
        frames[1].putpixel((2, 1), (20, 100, 180, 255))
        frames[1].putpixel((7, 5), (255, 220, 20, 255))
        frames[0].putpixel((7, 2), (255, 220, 20, 255))
        frames[0].save(path, save_all=True, append_images=frames[1:], duration=[170, 500], loop=1, lossless=True)
        pad_animation(path, 2)
        result = Image.open(path)
        assert result.size == (10, 8) and result.n_frames == 2
        sizes = []
        for index in range(result.n_frames):
            result.seek(index)
            frame = result.convert("RGBA")
            sizes.append(result.info["duration"])
            assert visible_bbox(frame)[0:2] == (2, 2)
            if index == 0:
                assert frame.getpixel((9, 4))[3] == 0
        assert sizes == [170, 500]
        pad_animation(path, 2)
        assert Image.open(path).size == (10, 8)


def main() -> None:
    parser = ArgumentParser()
    parser.add_argument("files", nargs="*", type=Path)
    parser.add_argument("--margin", type=int, default=24)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    if not args.files:
        parser.error("pass at least one animated WebP")
    for path in args.files:
        pad_animation(path, args.margin)


if __name__ == "__main__":
    main()
