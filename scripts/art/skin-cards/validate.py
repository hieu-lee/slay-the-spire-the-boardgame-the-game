#!/usr/bin/env python3
"""Validate the registrations and masks against every Ironclad scan (needs opencv for the group median).

  swap   the art cut from a card's base face is composited into its upgraded face (and the reverse); both faces
         print the same art, so the result must equal the scan: exactly outside the window, near-zero inside.
  halo   a flat colour is composited over every scan; pixels in a 3px ring outside the window are compared with
         the median frame of the card's rarity group. Old art would show there.

  python3 scripts/art/skin-cards/validate.py
"""
from collections import defaultdict

import cv2
import numpy as np
from PIL import Image

from build_masks import registered
from skincards import CARDS, THUMBS, composite, extract_art, family, load_catalogue, mask_path, registration, scan_key, window_alpha

KERNEL = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))


def regions(alpha):
    inner = cv2.erode((alpha > 0.999).astype(np.uint8), KERNEL).astype(bool)
    outer = ~cv2.dilate((alpha > 0).astype(np.uint8), KERNEL).astype(bool)
    return inner, outer, ~(inner | outer)


def swap(card, root, size_name):
    rows = []
    for src_up in (False, True):
        src, dst = scan_key(card, src_up), scan_key(card, not src_up)
        art = extract_art(Image.open(root / f'{src}.webp'), card, src_up)
        target = Image.open(root / f'{dst}.webp').convert('RGB')
        out = composite(target, art, card, not src_up)
        diff = np.abs(np.asarray(out, np.int16) - np.asarray(target, np.int16)).mean(axis=-1)
        inner, outer, edge = regions(window_alpha(card, not src_up, target.size))
        rows.append((f'{dst} {size_name}', diff[outer].max(), diff[inner].mean(), np.percentile(diff[inner], 99), diff[edge].mean()))
    return rows


def main():
    cards = load_catalogue()
    results = []
    for card in cards:
        for root, name in ((CARDS, 'full'), (THUMBS, 'sm')):
            results += [(card, *row) for row in swap(card, root, name)]
    for name in ('full', 'sm'):
        rows = [r for r in results if r[1].endswith(name)]
        print(f'swap {name}: {len(rows)} faces | outside-window max diff {max(r[2] for r in rows):.2f} | '
              f'inside mean {np.mean([r[3] for r in rows]):.2f} (worst {max(r[3] for r in rows):.2f}) | '
              f'inside p99 mean {np.mean([r[4] for r in rows]):.1f} | edge-band mean {np.mean([r[5] for r in rows]):.1f}')
    print('worst swap faces (inside mean):')
    for card, key, out_max, inside, p99, edge in sorted(results, key=lambda r: -r[3])[:8]:
        print(f'  {key:48s} outside {out_max:.2f} inside {inside:.2f} p99 {p99:.1f} edge {edge:.1f}')

    groups = defaultdict(list)
    for card in cards:
        for up in (False, True):
            groups[(family(card), card['type'], card['rarity'], up)].append((card, up))
    leaks = []
    for (fam, card_type, rarity, up), members in sorted(groups.items()):
        if len(members) < 3:
            continue
        stack = np.stack([registered(scan_key(c, up), registration(scan_key(c, up))) for c, _ in members])
        median = np.median(stack, axis=0)
        for (card, _), scan in zip(members, stack):
            key = scan_key(card, up)
            mask = np.asarray(Image.open(mask_path(fam, card_type, up)).convert('L'))
            support = (mask > 5).astype(np.uint8)
            ring = cv2.dilate(support, KERNEL).astype(bool) & ~support.astype(bool)
            ring &= np.arange(mask.shape[0])[:, None] > 186
            bad = (np.abs(scan - median).max(axis=-1) > 30) & ring
            leaks.append((key, bad.sum() / ring.sum()))
    print(f'halo: {len(leaks)} faces, mean ring deviation {np.mean([l[1] for l in leaks]) * 100:.2f}% worst {max(l[1] for l in leaks) * 100:.1f}%')
    for key, share in sorted(leaks, key=lambda l: -l[1])[:6]:
        print(f'  {key:48s} {share * 100:.1f}%')


if __name__ == '__main__':
    main()
