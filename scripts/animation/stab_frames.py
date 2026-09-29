"""Bake a thrusting attack from successive drawn poses (Sunburst sprite sheets).

An attack is a chain of 16-pose sheets (guard -> coil -> lunge -> withdraw -> guard), each generated
from the canonical drawing plus its start and end key drawings, so neighbouring poses differ only
slightly. Poses are scaled from a rigid painted landmark, planted on the canonical anchor and graded
to the idle palette once per sheet; sheets are joined at the best-overlapping drawing pair and the last one slides
back onto the canonical anchor, so idle -> attack -> idle cannot pop. Frames land every 20ms (the shortest
duration browsers honour), filled with RIFE in-betweens where neighbouring drawings overlap. Timing
follows the 1830ms combat clock, with contact at 730ms.
"""
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = Path(__file__).resolve().parents[2]
COLUMNS, ROWS = 4, 4
MIN_FRAME_MS = 20  # browsers may stretch animated-WebP frames shorter than this
MAX_REPAINT = .48  # above this share of repainted pixels, a RIFE morph turns into a doubled-weapon ghost


def sheet_cells(path):
    """Split a 4x4 sheet into per-cell sprites by component centroid, keeping native alpha."""
    sheet = Image.open(path).convert('RGBA')
    pixels = np.array(sheet)
    height, width = pixels.shape[:2]
    solid = pixels[:, :, 3] > 32
    labels, count = ndimage.label(solid)
    sizes = np.bincount(labels.ravel())
    owner = np.full(count + 1, -1)
    for index, (y, x) in enumerate(ndimage.center_of_mass(solid, labels, range(1, count + 1)), 1):
        if sizes[index] >= 60:
            owner[index] = min(ROWS - 1, int(y // (height / ROWS))) * COLUMNS + min(COLUMNS - 1, int(x // (width / COLUMNS)))
    owned = owner[labels]
    cells = []
    for cell in range(COLUMNS * ROWS):
        mask = owned == cell
        box = Image.fromarray(mask.astype('uint8') * 255).getbbox()
        if box is None:
            cells.append(None)
            continue
        cropped = pixels.copy()
        cropped[~ndimage.binary_dilation(mask, iterations=3), 3] = 0  # Neighbour objects only.
        cells.append(Image.fromarray(cropped).crop(
            (max(0, box[0] - 3), max(0, box[1] - 3), min(width, box[2] + 3), min(height, box[3] + 3))))
    return cells


def solid(image):
    return image.getchannel('A').point(lambda a: 255 if a > 32 else 0)


def feature_mask(image, kind, loose=False):
    """Pixels of a rigid painted feature whose true size never changes during the attack.

    Colour alone also catches shirt shadows and ribbon shading, so keep only the blob that sits
    highest (a head cloth, hair) or lowest (the Book's pages) among the matching pixels.
    """
    pixels = np.array(image)
    r, g, b = (pixels[:, :, i].astype(int) for i in range(3))
    opaque = pixels[:, :, 3] > (32 if loose else 200)
    if kind == 'bandana':  # Looter's dark head cloth
        mask = opaque & (r < 75) & (g < 75) & (b < 110) & (b > r + 8) & (r + g + b < 230)
    elif kind == 'hair':  # Mugger's red hair
        mask = opaque & (r > 150) & (g < 90) & (b > 40) & (b < 120) & (r > g + 90)
    elif kind == 'blade':  # the Book's cyan dagger blade
        mask = opaque & (b > 150) & (g > 120) & (r < 190) & (b > r + 30) if loose else opaque & (b > 170) & (g > 140) & (r < 150) & (b > r + 60)
    else:  # the Book's open pink-and-cream pages
        assert kind == 'book', kind
        mask = opaque & (((r > 200 if loose else r > 215) & (g < (130 if loose else 100)) & (b > 90 if loose else b > 110) & (b < 200)) |
                         ((r > 210 if loose else r > 225) & (g > 190 if loose else g > 205) & (b > 120 if loose else b > 140) & (b < 215) & (r > b + 15)))
    labels, count = ndimage.label(ndimage.binary_closing(mask, iterations=2))
    if count == 0:
        return mask
    rows = ndimage.maximum_position if kind == 'book' else ndimage.minimum_position
    extreme = [(rows(np.where(mask, np.arange(mask.shape[0])[:, None], 0 if kind == 'book' else 1 << 20), labels, i)[0]) for i in range(1, count + 1)]
    sizes = np.bincount(labels.ravel())[1:]
    keep = [i for i in range(count) if sizes[i] >= max(200, sizes.max() * .1)]
    pick = (max if kind == 'book' else min)(keep, key=lambda i: extreme[i])
    return mask & (labels == pick + 1)


def landmark_area(image, kind):
    return int(feature_mask(image, kind).sum())


def grade_table(images, reference, kind=None, loose=False):
    """One fixed per-channel grade for a whole sheet: idle art is the palette reference (`kind` restricts it to a feature)."""
    def samples(frames):
        return np.concatenate([np.array(f)[(feature_mask(f, kind, loose) if kind else np.array(f)[:, :, 3] > 250)][:, :3] for f in frames]).astype('float32')
    source, target = samples(images), samples([reference])
    quantiles = np.linspace(0, 100, 257)
    return np.stack([np.interp(np.arange(256), np.percentile(source[:, c], quantiles),
                               np.percentile(target[:, c], quantiles)) for c in range(3)], 1)


def grade(image, table, blade_table=None):
    pixels = np.array(image)
    blade = feature_mask(image, 'blade', loose=True) if blade_table is not None else None
    for c in range(3):
        graded = table[pixels[:, :, c], c].clip(0, 255).astype('uint8')
        if blade is not None:  # a weapon is a small share of the pixels: it needs its own palette match
            graded = np.where(blade, blade_table[pixels[:, :, c], c].clip(0, 255).astype('uint8'), graded)
        pixels[:, :, c] = graded
    return Image.fromarray(pixels)


def anchor_of(image, mode, kind=None):
    """(x, ground) of the planted point: the rear (right) foot, or where the ribbon meets the Book's pages."""
    if mode == 'feature':
        ys, xs = np.nonzero(feature_mask(image, kind))
        top = ys < ys.min() + max(3, (ys.max() - ys.min()) * .35)  # where the ribbon meets the pages
        return (xs[top].min() + xs[top].max()) / 2, ys.min()
    ys, xs = np.nonzero(np.array(solid(image)) > 0)
    bottom = ys.max()
    band = ys > bottom - max(4, (bottom - ys.min()) * .12)
    assert mode == 'right', mode
    return xs[band].max(), bottom


def canvas_for(spec, original):
    """The canonical drawing registered exactly like the idle export."""
    width = spec.get('size', 400)
    height = round(width * original.height / original.width)
    box = spec.get('sourceBounds', original.getbbox())
    crop = original.crop(box)
    display = spec.get('displayScale', 1)
    scale = min(width * .8 / crop.width, height * spec.get('heightFit', .88) / crop.height) / display
    size = tuple(round(v * scale) for v in crop.size)
    ground = round(height * (1 - (1 - spec.get('ground', .98)) / display))
    frame = Image.new('RGBA', (width, height))
    frame.paste(crop.resize(size, Image.Resampling.LANCZOS), ((width - size[0]) // 2, ground - size[1]))
    return frame


def place(image, scale, anchor, base, rest_size):
    """Canvas frame of `image` scaled by `scale`, with its planted `anchor` (already in scaled px) on `base`."""
    image = image.resize((round(image.width * scale), round(image.height * scale)), Image.Resampling.LANCZOS)
    frame = Image.new('RGBA', rest_size)
    frame.alpha_composite(image, (round(base[0] - anchor[0]), round(base[1] - anchor[1])))
    return frame


def shifted(image, dx):
    """`image` moved horizontally by `dx` pixels (whole canvas, so the ground line is untouched)."""
    frame = Image.new('RGBA', image.size)
    frame.alpha_composite(image, (dx, 0)) if dx >= 0 else frame.alpha_composite(image.crop((-dx, 0, image.width, image.height)))
    return frame


def best_shift(a, b, span=40):
    """Horizontal shift of `b` that best overlays `a`: (IoU, dx)."""
    a, b = np.array(solid(a)) > 0, np.array(solid(b)) > 0
    best = (-1, 0)
    for dx in range(-span, span + 1, 2):
        moved = np.roll(b, dx, axis=1)
        if dx > 0: moved[:, :dx] = False
        if dx < 0: moved[:, dx:] = False
        iou = (a & moved).sum() / max((a | moved).sum(), 1)
        best = max(best, (iou, dx))
    return best


def erase_feature(image, kind):
    """`image` without a feature: its loose colour match plus a soft margin, and without the specks of it that
    the margin missed. The ribbon keeps its own tapered tip, which the canonical pages then meet."""
    pixels = np.array(image)
    gone = ndimage.binary_dilation(feature_mask(image, kind, loose=True), iterations=6)
    pixels[gone, 3] = 0
    labels, count = ndimage.label(pixels[:, :, 3] > 32)
    sizes = np.bincount(labels.ravel())
    pixels[np.isin(labels, np.nonzero(sizes < max(150, sizes[1:].max() * .01))[0]) & (labels > 0), 3] = 0
    return Image.fromarray(pixels)


def register(spec, rest):
    """Every planned drawing as a canvas-sized frame, in playback order with its start time.

    The model draws each sheet at its own zoom but keeps it steady inside a sheet, so a rigid painted
    landmark (the Looter's bandana, the Mugger's hair, the Book's dagger blade) fixes every pose's scale against the canonical
    drawing (median-filtered). Every pose is planted on the canonical rear foot (also median-filtered,
    since toes and heels are drawn loosely), so the body keeps one physical size and one ground line
    through every seam. Sheets never reproduce their key drawing exactly, so at each seam the exit/entry drawing pair
    with the best overlap is chosen and the next sheet slides horizontally onto it; the last sheet slides
    back onto the canonical anchor as it plays. The model redraws the Book's pages at growing sizes, so
    the Book (`stabPastePages`) erases them, plants the body where its ribbon meets them and composites
    the canonical pages at their fixed place.
    """
    median_filter = ndimage.median_filter
    mode, kind = spec['stabAnchor'], spec['stabLandmark']
    anchor_kind = spec.get('stabAnchorKind')  # a different feature plants the body (the Book's pages)
    pages = None
    if spec.get('stabPastePages'):  # the model redraws the pages at growing sizes: keep the canonical ones
        pages = rest.copy()
        pages.putalpha(Image.fromarray(np.where(ndimage.binary_dilation(feature_mask(rest, anchor_kind), iterations=3),
                                                np.array(rest.getchannel('A')), 0).astype('uint8')))
    target = landmark_area(rest, kind)
    base = anchor_of(rest, mode, anchor_kind)
    sheets = []
    fit_first = spec.get('stabFitFirst')  # the model draws the Book's dagger smaller than the canonical one
    for segment in spec['stabSegments']:
        cells = sheet_cells(ROOT / segment['sheet'])
        assert all(cell is not None for cell in cells), (segment['sheet'], 'missing pose')
        table = grade_table(cells, rest)
        blade_table = grade_table(cells, rest, 'blade', loose=True) if spec.get('stabGradeBlade') else None
        raw = np.array([landmark_area(c, kind) for c in cells], dtype=float)
        assert raw.min() > 0, (segment['sheet'], 'landmark missing in a pose')
        anchors = np.array([anchor_of(c, mode, anchor_kind) for c in cells])
        drawn = [erase_feature(c, anchor_kind) for c in cells] if pages is not None else cells
        sheets.append({'cells': [grade(c, table, blade_table) for c in drawn],
                       'scales': np.sqrt(target / median_filter(raw, 5, mode='nearest')),
                       # Toes and heels are drawn loosely, but a feature (the Book's pages) is exact: never smooth it.
                       'anchors': anchors if mode == 'feature' else np.stack(
                           [median_filter(anchors[:, 0], 5, mode='nearest'), median_filter(anchors[:, 1], 5, mode='nearest')], 1)})

    def frame_of(number, pose, dx=0):
        sheet = sheets[number]
        scale = sheet['scales'][pose]
        frame = shifted(place(sheet['cells'][pose], scale, sheet['anchors'][pose] * scale, base, rest.size), dx)
        if pages is not None:
            frame.alpha_composite(pages)
        return frame

    for sheet in sheets:  # the lunge crouch shrinks the painted body: size it back up (see README `stabSize`)
        sheet['scales'] = sheet['scales'] * spec.get('stabSize', 1)
    first, last = 0, len(sheets) - 1
    entry = spec['stabSegments'][first].get('entry', 0)
    if fit_first:
        # Size the first guard drawing to overlay the canonical body, then keep its dagger's painted size everywhere.
        cell, anchor = sheets[first]['cells'][entry], sheets[first]['anchors'][entry]
        ratio = max((overlap(rest, place(cell, k * sheets[first]['scales'][entry], anchor * k * sheets[first]['scales'][entry],
                                         base, rest.size)), k) for k in np.linspace(.8, 2.4, 65))[1]
        print(f'first drawing sized x{ratio:.2f} to overlay the canonical body', flush=True)
        for sheet in sheets:
            sheet['scales'] = sheet['scales'] * ratio
    exit_pose = spec['stabSegments'][last].get('exit', 15)
    if isinstance(exit_pose, list):  # the last sheet's drawing that overlays the canonical body best ends the attack
        exit_pose = max(range(*exit_pose), key=lambda x: overlap(rest, frame_of(last, x)))
        print(f'last drawing: #{exit_pose + 1}', flush=True)
    chosen, offsets = [], [0]
    for number, segment in enumerate(spec['stabSegments']):
        if number == last:
            chosen.append((entry, exit_pose))
            break
        following = spec['stabSegments'][number + 1]
        exits = range(*segment['exit'])
        entries = range(*following['entry'])
        best = None
        for x in exits:
            exit_frame = frame_of(number, x, offsets[-1])
            for e in entries:
                iou, dx = best_shift(exit_frame, frame_of(number + 1, e))
                score = iou - .008 * (exits[-1] - x) - .008 * (e - entries[0])
                if best is None or score > best[0]:
                    best = (score, iou, x, e, dx)
        _, iou, x, e, dx = best
        print(f'seam {number}->{number + 1}: exit #{x + 1} entry #{e + 1}, IoU {iou:.2f}, slide {dx}px', flush=True)
        assert iou > .2, (segment['sheet'], 'no drawing pair overlays')
        chosen.append((entry, x))
        offsets.append(dx)
        entry = e
    started, ended = overlap(rest, frame_of(first, chosen[0][0])), overlap(rest, frame_of(last, exit_pose))
    print(f'canonical vs first drawing IoU {started:.2f}, vs last {ended:.2f}', flush=True)
    assert started > .25 and ended > .15, ('the attack does not start and end on the canonical body', started, ended)
    plan = []
    for number, (segment, (entry_pose, exit_index)) in enumerate(zip(spec['stabSegments'], chosen)):
        poses = range(entry_pose + 1 if number else entry_pose, exit_index + 1)
        for index, pose in enumerate(poses):
            dx = offsets[number]
            if number == last:
                dx = round(dx * (1 - (index + 1) / len(poses)))  # ease back onto the canonical anchor
            start = segment['start'] + (segment['end'] - segment['start']) * index / len(poses)
            plan.append((round(start), frame_of(number, pose, dx)))
    return plan


def repainted(a, b):
    """Share of the two drawings' union whose colour differs strongly: a large share means a big pose change,
    which RIFE renders as two blended poses (a doubled knife)."""
    A, B = np.array(a).astype(int), np.array(b).astype(int)
    differs = np.abs(A[:, :, :3] * A[:, :, 3:4] // 255 - B[:, :, :3] * B[:, :, 3:4] // 255).sum(2) > 90
    union = (A[:, :, 3] > 32) | (B[:, :, 3] > 32)
    return (differs & union).sum() / max(union.sum(), 1)


def overlap(a, b):
    a, b = np.array(solid(a)) > 0, np.array(solid(b)) > 0
    return (a & b).sum() / max((a | b).sum(), 1)


def sample(keys, rest, duration, threshold, max_repaint=MAX_REPAINT):
    """Frames every MIN_FRAME_MS: the canonical drawing, every keyframe, and the canonical drawing again.

    Between two keyframes a RIFE in-between supplies the intermediate time when both drawings overlap
    enough to be morphed safely; otherwise the nearer drawing is held (a hard cut beats a ghost of two
    poses), and a morph that ghosts is replaced by the nearer drawing. The last drawing morphs onto the
    canonical frame (the final frame) over the last two in-between frames, or cuts to it when the two
    drawings overlap too little to morph safely.
    """
    from interpolate import interpolate
    keys = [(0, rest), *keys, (duration, rest)]
    times = list(range(0, duration - MIN_FRAME_MS + 1, MIN_FRAME_MS))
    cache, frames = {}, []

    def translucent(frame):
        alpha = np.array(frame.getchannel('A')).astype(int)
        return int(((alpha > 20) & (alpha < 200) & ndimage.binary_erosion(alpha > 20, iterations=5)).sum())

    def morph(index, a, b, fraction):
        """RIFE in-between, or None when it ghosts: two blended poses leave far more translucent interior
        than either drawing has (the off-hand arm is translucent in the art itself)."""
        key = (index, round(fraction, 2))
        if key not in cache:
            frame = interpolate(a, b, key[1])
            cache[key] = frame if translucent(frame) <= 1.5 * max(translucent(a), translucent(b)) + 40 else None
        return cache[key]

    for t in times:
        index = max(i for i in range(len(keys) - 1) if keys[i][0] <= t)
        (t0, a), (t1, b) = keys[index], keys[index + 1]
        fraction = (t - t0) / max(t1 - t0, 1)
        if index == len(keys) - 2:
            w = min(max((t - (times[-1] - 3 * MIN_FRAME_MS)) / (3 * MIN_FRAME_MS), 0), 1)
            frame = a if w <= 0 else b if w >= 1 else (morph(index, a, b, w) if overlap(a, b) >= .15 else None) or a
        elif fraction < .06:
            frame = a
        elif index == 0:  # canonical -> first drawing: a cut, never a two-pose ghost
            frame = b
        else:
            frame = (morph(index, a, b, fraction) if overlap(a, b) >= threshold and repainted(a, b) <= max_repaint else None) or (a if fraction < .5 else b)
        frames.append(frame)
    return times, frames


def render(name, spec, output):
    original = Image.open(ROOT / spec['source']).convert('RGBA')
    rest = canvas_for(spec, original)
    duration = spec.get('duration', 1830)
    plan = register(spec, rest)
    times, frames = sample(plan, rest, duration, spec.get('stabMorph', .72), spec.get('stabRepaint', MAX_REPAINT))
    durations = [b - a for a, b in zip(times, times[1:] + [duration])]
    assert min(durations) >= MIN_FRAME_MS and sum(durations) == duration, (name, sorted(durations)[:4], sum(durations))
    assert frames[-1] is rest, (name, 'the attack must end on the canonical frame')
    for frame in frames:
        box = solid(frame).getbbox()
        assert box and box[0] > 0 and box[1] > 0 and box[2] < rest.width and box[3] < rest.height, (name, 'clipped', box)
    output.parent.mkdir(parents=True, exist_ok=True)
    frames[0].save(output, save_all=True, append_images=frames[1:], duration=durations,
                   loop=1, quality=82, method=4, minimize_size=True)
    print(f'{output.name}: {len(frames)} frames, {sum(durations)}ms', flush=True)
