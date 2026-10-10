"""Shared helpers for the skin card pipeline: card catalogue, scan paths, art-window masks, compositing.

Deterministic, Pillow + numpy only, no API calls. The art-window masks in masks/ are built from the
committed scans by build_masks.py; everything else reads them.
"""
import json
import re
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent
MASKS = HERE / 'masks'
CARDS = ROOT / 'public/assets/cards'
THUMBS = ROOT / 'public/assets/cards-sm'
REF_SIZE = (744, 1039)
ART_SIZE = (748, 420)
# The art window, in 744x1039 scan pixels: (x0, y0, x1, y1). The new art is cover-fitted into it.
WINDOW_BOX = {'attack': (111, 186, 639, 546), 'skill': (111, 186, 639, 546), 'power': (104, 186, 648, 546)}


def slug(name):
    return re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')


def load_catalogue():
    """Every Ironclad card: id, name, type, rarity, pack. Generated from src/game by dump-cards.mjs."""
    return json.loads((HERE / 'cards.json').read_text())


def scan_key(card, upgraded):
    """assetKey in src/game/assets.ts: <tier>__<slug>[+], tier from pack/rarity."""
    name = slug(card['name']) + ('+' if upgraded else '')
    if card.get('pack'):
        return f"slayer__{card['pack'].removeprefix('slayer_')}__{name}"
    tier = {'starter': 'starter', 'rare': 'rare'}.get(card['rarity'], 'normal')
    return f"ironclad__{tier}__{name}"


def family(card):
    return 'slayer' if card.get('pack') else 'base'


def mask_path(fam, card_type, upgraded):
    """The pack scans share the base template's geometry (see validate.py), so they use the base masks."""
    return MASKS / f"base-{card_type}{'-up' if upgraded else ''}.png"


def registration(key):
    """Affine mapping reference coordinates (744x1039) to this scan resized to 744x1039; identity for most scans."""
    path = HERE / 'registration.json'
    table = json.loads(path.read_text()) if path.exists() else {}
    return np.array(table.get(key, [1, 0, 0, 0, 1, 0]), dtype=np.float64).reshape(2, 3)


def window_box(card_type):
    return WINDOW_BOX[card_type]


def fit_art(art, box, focus=(0.5, 0.5)):
    """Cover-fit `art` into the window `box`; returns an RGB canvas in reference (744x1039) space."""
    x0, y0, x1, y1 = box
    bw, bh = x1 - x0, y1 - y0
    scale = max(bw / art.width, bh / art.height)
    w, h = max(bw, round(art.width * scale)), max(bh, round(art.height * scale))
    resized = art.convert('RGB').resize((w, h), Image.Resampling.LANCZOS)
    left, top = round((w - bw) * focus[0]), round((h - bh) * focus[1])
    canvas = Image.new('RGB', REF_SIZE, (0, 0, 0))
    canvas.paste(resized.crop((left, top, left + bw, top + bh)), (x0, y0))
    return canvas


def warp(image, matrix, resample):
    """Render a reference-space image into the scan's own 744x1039 space (inverse of `registration`)."""
    if np.allclose(matrix, [[1, 0, 0], [0, 1, 0]], atol=1e-6):
        return image
    inverse = np.linalg.inv(np.vstack([matrix, [0, 0, 1]]))[:2]
    return image.transform(REF_SIZE, Image.Transform.AFFINE, tuple(inverse.flatten()), resample)


def window_alpha(card, upgraded, size):
    """Soft alpha (float32 0..1, shape h x w) of the art window in this scan's own pixel space."""
    mask = Image.open(mask_path(family(card), card['type'], upgraded)).convert('L')
    mask = warp(mask, registration(scan_key(card, upgraded)), Image.Resampling.BILINEAR)
    if tuple(size) != REF_SIZE:
        mask = mask.resize(tuple(size), Image.Resampling.BILINEAR)
    return np.asarray(mask, dtype=np.float32) / 255.0


def composite(scan, art, card, upgraded, focus=(0.5, 0.5), flat=None):
    """Paste `art` into the scan's art window. Everything outside the soft mask stays the scan's own pixels.

    `card` is a catalogue entry. Art and mask are rendered in the 744x1039 reference space, warped by the
    scan's registration, then resized to the scan's own size (the 448px thumbnails and the few 960px scans).
    """
    scan = scan.convert('RGB')
    layer = Image.new('RGB', REF_SIZE, flat) if flat else fit_art(art, WINDOW_BOX[card['type']], focus)
    layer = warp(layer, registration(scan_key(card, upgraded)), Image.Resampling.BICUBIC)
    if scan.size != REF_SIZE:
        layer = layer.resize(scan.size, Image.Resampling.LANCZOS)
    alpha = window_alpha(card, upgraded, scan.size)[..., None]
    out = np.asarray(scan, dtype=np.float32) * (1 - alpha) + np.asarray(layer, dtype=np.float32) * alpha
    return Image.fromarray(np.clip(np.rint(out), 0, 255).astype(np.uint8))


def extract_art(scan, card, upgraded):
    """The scan's own art window (frame pixels blanked), in reference space, cropped to the window box."""
    matrix = registration(scan_key(card, upgraded))
    scan = scan.convert('RGB').resize(REF_SIZE, Image.Resampling.LANCZOS)
    # scan -> reference is the inverse of the stored reference -> scan map
    inverse = np.linalg.inv(np.vstack([matrix, [0, 0, 1]]))[:2]
    registered = warp(scan, inverse, Image.Resampling.BICUBIC)
    alpha = np.asarray(Image.open(mask_path(family(card), card['type'], upgraded)).convert('L'), dtype=np.float32)[..., None] / 255.0
    flat = np.asarray(registered, dtype=np.float32) * alpha + 20 * (1 - alpha)
    return Image.fromarray(flat.astype(np.uint8)).crop(WINDOW_BOX[card['type']])
