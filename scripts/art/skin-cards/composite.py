#!/usr/bin/env python3
"""Composite new art into the Ironclad scans (base and upgraded face, full size and 448px thumbnail).

Only pixels inside the art window change; frame, banner, title, cost orb, type tab and rules text keep
the scan's own pixels. Deterministic, no API calls.

  # published layout: <root>/skin-cards/<skin>/<assetKey>.webp and <root>/skin-cards-sm/<skin>/<assetKey>.webp
  python3 scripts/art/skin-cards/composite.py --all --skin kratos --root public/assets
  # one card, any art file, flat output folder (full size in DIR, thumbnails in DIR/sm)
  python3 scripts/art/skin-cards/composite.py --card strike_ironclad --art art.png --out DIR
"""
import argparse
from pathlib import Path

from PIL import Image

from skincards import CARDS, ROOT, THUMBS, composite, load_catalogue, scan_key

SOURCES = ROOT / 'scripts/art/sources/kratos-skin-cards'


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--card', nargs='+', help='card ids')
    parser.add_argument('--all', action='store_true', help='every card that has a source in scripts/art/sources/kratos-skin-cards')
    parser.add_argument('--art', help='art file for a single --card (default: the committed source)')
    parser.add_argument('--skin', default='kratos')
    parser.add_argument('--root', help='assets root for the published layout')
    parser.add_argument('--out', help='flat output folder instead of --root')
    parser.add_argument('--focus', default='0.5,0.5', help='x,y share of the cover crop kept left/top (default centre)')
    parser.add_argument('--quality', type=int, default=90, help='WebP quality (the scans are lossy WebP too)')
    args = parser.parse_args()
    catalogue = {c['id']: c for c in load_catalogue()}
    ids = [i for i in catalogue if (SOURCES / f'{i}.webp').exists()] if args.all else args.card
    focus = tuple(float(v) for v in args.focus.split(','))
    for card_id in ids:
        card = catalogue[card_id]
        art = Image.open(args.art or SOURCES / f'{card_id}.webp')
        for upgraded in (False, True):
            key = scan_key(card, upgraded)
            full, thumb = (composite(Image.open(root / f'{key}.webp'), art, card, upgraded, focus) for root in (CARDS, THUMBS))
            if args.out:
                targets = [Path(args.out) / f'{key}.webp', Path(args.out) / 'sm' / f'{key}.webp']
            else:
                targets = [Path(args.root) / f'skin-cards/{args.skin}/{key}.webp', Path(args.root) / f'skin-cards-sm/{args.skin}/{key}.webp']
            for image, target in zip((full, thumb), targets):
                target.parent.mkdir(parents=True, exist_ok=True)
                image.save(target, 'WEBP', quality=args.quality, method=6)
        print(card_id)


if __name__ == '__main__':
    main()
