#!/usr/bin/env python3
"""Package two-pose boss art into paced, unclipped attack animations."""

from argparse import ArgumentParser
from collections import deque
from pathlib import Path
import re
import subprocess
from tempfile import TemporaryDirectory

from PIL import Image


MELEE = {
    "bronze_automaton", "deca", "donu", "guardian_attack", "guardian_defensive",
    "slime_boss", "the_champ", "time_eater",
}
PHASE_MS = (184, 183, 183)


def visible_bbox(frame: Image.Image):
    return frame.getchannel("A").point(lambda alpha: 255 if alpha > 16 else 0).getbbox()


def remove_light_checkerboard(image: Image.Image) -> Image.Image:
    image = image.convert("RGBA")
    pixels = image.load()
    width, height = image.size
    seen = bytearray(width * height)
    queue = deque()
    for x in range(width):
        queue.extend(((x, 0), (x, height - 1)))
    for y in range(1, height - 1):
        queue.extend(((0, y), (width - 1, y)))
    while queue:
        x, y = queue.popleft()
        index = y * width + x
        if seen[index]:
            continue
        red, green, blue, _alpha = pixels[x, y]
        if min(red, green, blue) < 208 or max(red, green, blue) - min(red, green, blue) > 14:
            continue
        seen[index] = 1
        pixels[x, y] = (255, 255, 255, 0)
        if x:
            queue.append((x - 1, y))
        if x + 1 < width:
            queue.append((x + 1, y))
        if y:
            queue.append((x, y - 1))
        if y + 1 < height:
            queue.append((x, y + 1))
    return image


def fit_replacement(path: Path, canvas_size: tuple[int, int]) -> Image.Image:
    source = remove_light_checkerboard(Image.open(path))
    box = visible_bbox(source)
    if box is None:
        raise ValueError(f"{path}: replacement is empty")
    crop = source.crop(box)
    max_width = canvas_size[0] - 48
    max_height = canvas_size[1] - 48
    scale = min(max_width / crop.width, max_height / crop.height)
    crop = crop.resize((round(crop.width * scale), round(crop.height * scale)), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", canvas_size, (255, 255, 255, 0))
    canvas.alpha_composite(crop, (canvas.width - 24 - crop.width, canvas.height - 24 - crop.height))
    return canvas


def variant(frame: Image.Image, scale: float, shift_x: int = 0) -> Image.Image:
    box = visible_bbox(frame)
    if box is None:
        raise ValueError("empty animation frame")
    crop = frame.crop(box)
    crop = crop.resize((round(crop.width * scale), round(crop.height * scale)), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", frame.size, (255, 255, 255, 0))
    right = box[2] + shift_x
    bottom = box[3]
    left = max(0, min(canvas.width - crop.width, right - crop.width))
    top = max(0, min(canvas.height - crop.height, bottom - crop.height))
    canvas.alpha_composite(crop, (left, top))
    return canvas


def lower_body_right(frame: Image.Image) -> int:
    """Use the actor's feet/lower body as a landmark, ignoring horizontal projectiles."""
    start_y = round(frame.height * 0.72)
    box = visible_bbox(frame.crop((0, start_y, frame.width, frame.height)))
    if box is None:
        raise ValueError("frame has no lower-body landmark")
    return box[2]


def align_lower_body(frames: list[Image.Image], margin: int = 24) -> list[Image.Image]:
    boxes = [visible_bbox(frame) for frame in frames]
    if any(box is None for box in boxes):
        raise ValueError("cannot align an empty frame")
    rights = [lower_body_right(frame) for frame in frames]
    lower = max(right + margin - box[0] for right, box in zip(rights, boxes))
    upper = min(right + frame.width - margin - box[2] for frame, right, box in zip(frames, rights, boxes))
    target = min(max(rights), upper)
    if target < lower:
        raise ValueError("frames do not have room for a stable lower-body landmark")
    aligned = []
    for frame, right in zip(frames, rights):
        canvas = Image.new("RGBA", frame.size, (255, 255, 255, 0))
        canvas.alpha_composite(frame, (target - right, 0))
        aligned.append(canvas)
    return aligned


def save_animation(path: Path, frames: list[Image.Image], durations: list[int]) -> None:
    temporary = path.with_suffix(".tmp.webp")
    with TemporaryDirectory() as directory:
        inputs = []
        for index, (frame, duration) in enumerate(zip(frames, durations)):
            source = Path(directory) / f"{index}.png"
            frame.save(source)
            inputs.extend(["-d", str(duration), "-lossy", "-q", "92", "-m", "3", "-exact", str(source)])
        subprocess.run(
            ["img2webp", "-loop", "1", "-min_size", "-mixed", *inputs, "-o", str(temporary)],
            check=True,
            capture_output=True,
        )
    temporary.replace(path)


def optimize(path: Path) -> None:
    animation = Image.open(path)
    durations = frame_durations(path)
    frames = []
    for index in range(animation.n_frames):
        animation.seek(index)
        frames.append(animation.convert("RGBA"))
    save_animation(path, frames, durations)
    audit(path)


def rework(path: Path, replacement: Path | None = None) -> None:
    animation = Image.open(path)
    if animation.n_frames == 10 and replacement is None:
        audit(path)
        return
    if animation.n_frames not in (2, 3, 10):
        raise ValueError(f"{path}: expected 2, 3, or 10 frames, got {animation.n_frames}")
    animation.seek(0)
    windup = animation.convert("RGBA")
    animation.seek(1)
    impact = fit_replacement(replacement, windup.size) if replacement else animation.convert("RGBA")

    windup_frames = [variant(windup, scale, shift) for scale, shift in ((0.96, 4), (0.98, 2), (1.0, 0))]
    impact_frames = [variant(impact, scale, shift) for scale, shift in ((0.98, 2), (1.0, 0), (0.99, 1))]
    recovery_frames = [variant(windup, scale, shift) for scale, shift in ((1.0, 0), (0.99, 1), (0.98, 2))]
    frames = windup_frames
    durations = list(PHASE_MS)
    # Keep the transition as a distinct frame even for ranged casts; img2webp
    # otherwise merges two identical frames and destroys the phase cadence.
    shift = -4 if path.stem.removesuffix("-attack") in MELEE else 2
    frames.append(variant(windup, 1.0, shift))
    durations.append(180)
    frames.extend(impact_frames)
    frames.extend(recovery_frames)
    durations.extend(PHASE_MS)
    durations.extend(PHASE_MS)

    save_animation(path, frames, durations)
    audit(path)


def frame_durations(path: Path) -> list[int]:
    info = subprocess.run(
        ["webpmux", "-info", str(path)], check=True, capture_output=True, text=True,
    ).stdout
    return [int(match) for match in re.findall(
        r"^\s*\d+:.*?\s(\d+)\s+(?:none|background)\s", info, re.MULTILINE,
    )]


def audit(path: Path) -> None:
    animation = Image.open(path)
    expected = [*PHASE_MS, 180, *PHASE_MS, *PHASE_MS]
    if animation.n_frames != len(expected) or frame_durations(path) != expected:
        raise ValueError(f"{path}: invalid phase cadence")
    for index in range(animation.n_frames):
        animation.seek(index)
        box = visible_bbox(animation.convert("RGBA"))
        if box is None:
            raise ValueError(f"{path}: frame {index} is empty")
        margin = min(box[0], box[1], animation.width - box[2], animation.height - box[3])
        if margin < 20:
            raise ValueError(f"{path}: frame {index} has only {margin}px safety margin")


def self_test() -> None:
    with TemporaryDirectory() as directory:
        path = Path(directory) / "deca-attack.webp"
        windup = Image.new("RGBA", (100, 100), (255, 255, 255, 0))
        impact = windup.copy()
        windup.paste((220, 130, 40, 255), (30, 20, 76, 76))
        impact.paste((255, 180, 70, 255), (20, 22, 76, 78))
        windup.save(path, save_all=True, append_images=[impact], duration=[170, 500], loop=1, lossless=True)
        rework(path)
        result = Image.open(path)
        assert result.n_frames == 10
        for index in range(result.n_frames):
            result.seek(index)
            box = visible_bbox(result.convert("RGBA"))
            assert box and min(box[0], box[1], result.width - box[2], result.height - box[3]) >= 0
        assert frame_durations(path) == [184, 183, 183, 180, 184, 183, 183, 184, 183, 183]
        projectile = windup.copy()
        projectile.paste((255, 200, 80, 255), (0, 2, 30, 3))
        shifted = Image.new("RGBA", windup.size)
        shifted.alpha_composite(projectile, (2, 0))
        aligned = align_lower_body([windup, shifted], margin=1)
        assert lower_body_right(aligned[0]) == lower_body_right(aligned[1])


def main() -> None:
    parser = ArgumentParser()
    parser.add_argument("files", nargs="*", type=Path)
    parser.add_argument("--replace-time-eater-impact", type=Path)
    parser.add_argument("--replace-impact", type=Path)
    parser.add_argument("--audit", action="store_true")
    parser.add_argument("--optimize", action="store_true")
    parser.add_argument("--align-lower-body", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    if not args.files:
        parser.error("pass at least one two-frame boss attack WebP")
    for path in args.files:
        if args.align_lower_body:
            animation = Image.open(path)
            frames = []
            for index in range(animation.n_frames):
                animation.seek(index)
                frames.append(animation.convert("RGBA"))
            save_animation(path, align_lower_body(frames), frame_durations(path))
            audit(path)
            continue
        if args.audit:
            audit(path)
            continue
        if args.optimize:
            optimize(path)
            continue
        replacement = args.replace_impact or (
            args.replace_time_eater_impact if path.name == "time_eater-attack.webp" else None
        )
        rework(path, replacement)


if __name__ == "__main__":
    main()
