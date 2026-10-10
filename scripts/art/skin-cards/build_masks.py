#!/usr/bin/env python3
"""Derive scan registrations and art-window masks from the committed scans (a one-off build step: the
outputs, registration.json and masks/*.png, are committed; compositing needs only Pillow and numpy).
This step additionally needs opencv-python-headless for the affine ECC alignment.

Why registration: the scans are not pixel-registered. Most sit within +-2px of each other, ten are
960x1341, and the window edge is exactly where that jitter shows as an old-art halo. Each scan is
aligned (scale + translation, weighted NCC of gradient magnitude over the constant frame) to a
reference scan of its type and face; `registration.json` stores reference -> scan affines.

Why variance masks: the frame, banner, rim, type tab and cost orb are identical on every card of one
frame type and rarity; only art, title text, cost digit and rules text vary. So, on registered scans,
the pixels deviating from the group median on any card are the art window plus the title strip. The
title strip is cut away, holes filled, the window component kept, grown 1px so no old art survives at
the edge, and feathered ~1px.

  python3 scripts/art/skin-cards/build_masks.py [--reuse]   # --reuse keeps registration.json and only rebuilds the masks
"""
import json
import sys
from collections import defaultdict
from multiprocessing import Pool

import cv2
import numpy as np
from scipy.optimize import minimize
from PIL import Image, ImageChops, ImageDraw, ImageFilter

from skincards import CARDS, HERE, MASKS, REF_SIZE, WINDOW_BOX, family, load_catalogue, registration, scan_key

THRESHOLD = 14      # max channel deviation from the group median
TITLE_CUT = 186     # rows above this belong to the banner/title, never the window
SEED = (372, 360)   # inside every window
REFERENCE = {'attack': 'ironclad__normal__twin-strike', 'skill': 'ironclad__normal__true-grit', 'power': 'ironclad__normal__inflame'}

cv2.setNumThreads(1)


def read(key, size=REF_SIZE):
    image = Image.open(CARDS / f'{key}.webp').convert('RGB')
    return image if image.size == size else image.resize(size, Image.Resampling.LANCZOS)


HALF = (REF_SIZE[0] // 2, REF_SIZE[1] // 2)


def gradient(key):
    gray = cv2.cvtColor(np.asarray(read(key, HALF)), cv2.COLOR_RGB2GRAY).astype(np.float32) / 255
    gray = cv2.GaussianBlur(gray, (0, 0), 1.0)
    return np.hypot(cv2.Sobel(gray, cv2.CV_32F, 1, 0), cv2.Sobel(gray, cv2.CV_32F, 0, 1))


def frame_weights():
    """Where scans of every card agree: the frame around the window and the text panel, not the art, title,
    cost orb or rules text."""
    w = np.zeros(REF_SIZE[::-1], np.float32)
    w[40:1010, 40:704] = 1
    w[190:545, 120:630] = 0       # art window interior
    w[605:960, 100:650] = 0       # rules text interior
    w[90:190, 170:580] = 0        # title strip
    w[:190, :170] = 0             # cost orb
    return cv2.GaussianBlur(cv2.resize(w, HALF, interpolation=cv2.INTER_AREA), (0, 0), 1.0)


WEIGHTS = frame_weights()


def objective(params, template, image):
    sx, sy, tx, ty = params
    matrix = np.array([[sx, 0, tx / 2], [0, sy, ty / 2]], np.float32)
    warped = cv2.warpAffine(image, matrix, HALF, flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP, borderValue=0)
    total = WEIGHTS.sum()
    mt, mi = (WEIGHTS * template).sum() / total, (WEIGHTS * warped).sum() / total
    a, b = template - mt, warped - mi
    return -float((WEIGHTS * a * b).sum() / np.sqrt((WEIGHTS * a * a).sum() * (WEIGHTS * b * b).sum() + 1e-9))


def register(job):
    """Scale + translation (reference -> scan) maximising weighted NCC of gradient magnitude over the frame."""
    key, ref_key = job
    template, image = gradient(ref_key), gradient(key)
    shift, _ = cv2.phaseCorrelate(template * WEIGHTS, image * WEIGHTS)
    best, retried = None, False
    starts = [[1, 1, 0, 0], [1, 1, shift[0] * 2, shift[1] * 2], [1, 1, -shift[0] * 2, -shift[1] * 2]]
    while starts:
        result = minimize(objective, starts.pop(0), args=(template, image), method='Powell', options={'xtol': 1e-3, 'ftol': 1e-7})
        if best is None or result.fun < best.fun:
            best = result
        if not starts and -best.fun < 0.85 and not retried:   # a mis-cropped scan: try other scales
            retried = True
            starts = [[s, s, tx, ty] for s in (0.983, 1.03) for tx, ty in ((16, 12), (-5, -25), (0, 0))]
    sx, sy, tx, ty = best.x
    return key, float(-best.fun), np.array([[sx, 0, tx], [0, sy, ty]], np.float64)


def registered(key, matrix):
    """The scan in reference space."""
    image = np.asarray(read(key))
    return cv2.warpAffine(image, matrix, REF_SIZE, flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_REPLICATE).astype(np.int16)


def deviation(stack):
    """Pixels that differ from the group median on at least two cards (on the one card for a pair), so a
    single odd scan cannot widen the window."""
    if len(stack) == 2:
        return np.abs(stack[0] - stack[1]).max(axis=-1) > THRESHOLD
    return (np.abs(stack - np.median(stack, axis=0)).max(axis=-1) > THRESHOLD).sum(axis=0) >= 2


def grow(mask, n):
    for _ in range(n):
        mask = mask.filter(ImageFilter.MaxFilter(3))
    return mask


def shrink(mask, n):
    for _ in range(n):
        mask = mask.filter(ImageFilter.MinFilter(3))
    return mask


def window_from(deviant):
    mask = shrink(grow(Image.fromarray((deviant * 255).astype(np.uint8)), 3), 3)       # close pin holes
    mask = Image.fromarray(np.where(np.arange(mask.height)[:, None] < TITLE_CUT, 0, np.asarray(mask)).astype(np.uint8))
    marked = mask.copy()                                                              # keep the component at the seed
    ImageDraw.floodfill(marked, SEED, 128)
    mask = Image.fromarray(((np.asarray(marked) == 128) * 255).astype(np.uint8))
    outside = mask.copy()                                                             # fill holes
    ImageDraw.floodfill(outside, (0, 0), 128)
    mask = Image.fromarray(((np.asarray(outside) != 128) * 255).astype(np.uint8))
    return grow(shrink(mask, 2), 2)                                                   # drop 1-2px spurs


def build_masks(cards, matrices, report):
    groups = defaultdict(list)
    for card in cards:
        for upgraded in (False, True):
            groups[(family(card), card['type'], upgraded, card['rarity'])].append(scan_key(card, upgraded))
    votes = defaultdict(lambda: np.zeros(REF_SIZE[::-1], np.uint8))
    groups_per = defaultdict(int)
    for (fam, card_type, upgraded, rarity), keys in sorted(groups.items()):
        if len(keys) < 2:
            report.append(f'skip {fam} {card_type} {rarity} up={upgraded}: single card')
            continue
        stack = np.stack([registered(k, matrices[k]) for k in keys])
        votes[(fam, card_type, upgraded)] += deviation(stack)
        groups_per[(fam, card_type, upgraded)] += 1
    masks = {}
    for key, count in sorted(votes.items()):
        # a pixel belongs to the window if every group but at most one (when there are three or more) saw art there
        need = max(1, groups_per[key] - (1 if groups_per[key] >= 3 else 0))
        masks[key] = window_from(count >= need)
    return masks


def main():
    MASKS.mkdir(exist_ok=True)
    cards = load_catalogue()
    keys = [(scan_key(card, up), card['type'], up) for card in cards for up in (False, True)]
    matrices, scores = {}, {}
    cache = HERE / 'registration.json'
    if '--reuse' in sys.argv and cache.exists():
        matrices = {key: registration(key) for key, _, _ in keys}
        scores = {k: 1.0 for k in matrices}
    if not matrices:
        jobs = [(key, REFERENCE[card_type] + ('+' if up else '')) for key, card_type, up in keys]
        with Pool(4) as pool:
            for key, score, matrix in pool.imap_unordered(register, jobs):
                matrices[key], scores[key] = matrix, score
    report = []
    masks = build_masks([c for c in cards if family(c) == 'base'], matrices, report)
    print(f'min registration NCC {min(scores.values()):.3f}', *report, sep='\n')
    # Both faces print the same window: clip each face's mask to the other's, which removes bumps (a stray
    # column over the type tab, say) that only one face's sample cards produced.
    for card_type in ('attack', 'skill', 'power'):
        base, up = masks[('base', card_type, False)], masks[('base', card_type, True)]
        masks[('base', card_type, False)] = ImageChops.multiply(base, grow(up, 2))
        masks[('base', card_type, True)] = ImageChops.multiply(up, grow(base, 2))
    for (fam, card_type, up), mask in sorted(masks.items()):
        soft = grow(mask, 1).filter(ImageFilter.GaussianBlur(0.7))
        soft.save(MASKS / f"{fam}-{card_type}{'-up' if up else ''}.png", optimize=True)
        print(f"{fam}-{card_type}{'-up' if up else ''}", int((np.asarray(mask) > 0).sum()), 'px')
    table = {key: [round(float(v), 4) for v in matrix.flatten()] for key, matrix in sorted(matrices.items())}
    (HERE / 'registration.json').write_text(json.dumps(table, indent=0) + '\n')
    print(len(table), 'registered scans; worst scores:', sorted(scores.items(), key=lambda kv: kv[1])[:8])


if __name__ == '__main__':
    main()
