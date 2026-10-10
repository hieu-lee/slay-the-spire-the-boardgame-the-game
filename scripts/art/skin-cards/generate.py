#!/usr/bin/env python3
"""Generate Kratos-themed Ironclad card illustrations with the bundled imagegen CLI (gpt-image-2.5-sunburst).

One `edit` call per card. Input images, in this fixed order (the prompt names them by number):
  1-2  style authority: the committed Cleave and Shrug It Off illustrations
  3    Kratos identity: scripts/animation/sources/kratos/idle.webp
  4..  God of War 1/2/3 game images chosen for the card (plan.json "refs", fetched by fetch_refs.py)
  n-1  the Ironclad card scan itself (frame and text are to be ignored)
  n    the card's original text-free artwork (slayer cards: cut out of the scan with the window mask)

Commands (all idempotent and resumable; existing candidates are skipped unless --force):
  run     call the API: raw PNG candidates in <work>/raw/<id>-<n>.png, prompts in docs/skins/kratos-card-art/prompts/
  select  <id>=<n> ...  keep candidate n as the card's WebP source (<= 150 KiB, or --lossless) in scripts/art/sources/kratos-skin-cards/

  python3 scripts/art/skin-cards/generate.py run --prototype            # the six prototype cards, 2 candidates each
  python3 scripts/art/skin-cards/generate.py run --all --candidates 1   # the mass run
  python3 scripts/art/skin-cards/generate.py select strike_ironclad=2
"""
import argparse
import concurrent.futures
import json
import os
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

from PIL import Image

from skincards import CARDS, HERE, ROOT, extract_art, load_catalogue, scan_key

CLI = Path(os.environ.get('CODEX_HOME', Path.home() / '.codex')) / 'skills/.system/imagegen/scripts/image_gen.py'
PLAN = json.loads((HERE / 'plan.json').read_text())
PROMPTS = ROOT / 'docs/skins/kratos-card-art/prompts'
SOURCES = ROOT / 'scripts/art/sources/kratos-skin-cards'
# Scratch space for reference downloads and raw candidates (git-ignored under artifacts/).
WORK_ROOT = Path(os.environ.get('STS_SKIN_ART_WORK', ROOT / 'artifacts/skin-art'))
DEFAULT_WORK = WORK_ROOT / 'work-gen'
REFS = WORK_ROOT / 'refs'
PROTOTYPE = ['strike_ironclad', 'defend_ironclad', 'inflame', 'shrug_it_off', 'demon_form', 'slayer_dropkick']

TEMPLATE = """Use case: stylized-concept. Asset type: one text-free Slay the Spire card illustration, re-themed as Greek-era God of War 1, 2 and 3 with Kratos.
Reference images, by number. Images 1 and 2 are the STYLE AUTHORITY: Slay the Spire's bold flat graphic card paintings with rough angular silhouettes, expressive ink-dark outlines, chunky simplified forms, limited cel-shaded color planes, occasional painted texture and deep vignetted backgrounds. Match these two paintings, not photographic realism and not glossy detailed 3D. Image 3 is the KRATOS IDENTITY ONLY: young Greek-era Kratos from God of War 1 to 3, bald ash-white skin, red tattoo down the left side, short pointed dark goatee, bronze bracers, red cloth skirt, Blades of Chaos on chains; simplify him into the card painting style of images 1 and 2. {game_refs}Image {scan_n} is the original Ironclad card and image {art_n} is that card's original artwork: keep the card's meaning, subject and gesture, but translate it into the God of War scene below. Ignore every letter, number, symbol and the frame of the card scan; none of them may appear in the result.
SCENE: {name} ({type} card). {scene}
Compose {composition}. Produce one wide 1536x1024 painting with no frame, no border, no labels, no text, no symbols resembling letters, no watermark. Keep the main subject inside the central 75 percent of the image height and the central 85 percent of its width, because the painting is later cropped to a shallow wide window and shown small, so keep the focal shapes bold and readable at thumbnail size.
Kratos is always the young Greek Kratos of image 3: no Norse beard, fur, runes, Leviathan axe or modern setting. Every figure has coherent connected anatomy, exactly two arms and two legs, correct hands and grips, and consistent weapon construction.
"""

COMPOSITION = {
    'attack': 'a dynamic, diagonal, high-impact composition',
    'skill': 'a solid, grounded, readable composition that reads inside a rounded rectangle',
    'power': 'an iconic, centered, emblematic composition whose important shapes read inside a circle or oval, with calm margins at all four edges',
}


def png(source, target, max_side=None):
    """Re-encode an input image as PNG/JPEG the API accepts (the webp scans are fine, the wiki images can be odd)."""
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        return target
    image = Image.open(source).convert('RGB')
    if max_side and max(image.size) > max_side:
        image.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
    image.save(target)
    return target


def original_art(card, target):
    """Text-free original art: the committed card-art file, or for pack cards the window cut out of the scan."""
    path = ROOT / f"public/assets/card-art/ironclad/{card['id']}.webp"
    if path.exists():
        return png(path, target)
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        extract_art(Image.open(CARDS / f"{scan_key(card, False)}.webp"), card, False).save(target)
    return target


def build(card, entry, work):
    """Returns (prompt, ordered list of input image paths, role labels)."""
    inputs = [(ROOT / p, f'style{i + 1}') for i, p in enumerate(PLAN['styleReferences'])]
    inputs.append((ROOT / PLAN['identityReference'], 'identity'))
    refs = [next(iter(REFS.glob(f'{tag}.*'))) for tag in entry['refs']]
    inputs += [(r, f'gow-{r.stem}') for r in refs]
    scan = CARDS / f"{scan_key(card, False)}.webp"
    n = len(inputs)
    paths = [png(src, work / 'inputs' / card['id'] / f'{i + 1:02d}-{role}.png', 1280) for i, (src, role) in enumerate(inputs)]
    paths.append(png(scan, work / 'inputs' / card['id'] / f'{n + 1:02d}-scan.png'))
    paths.append(original_art(card, work / 'inputs' / card['id'] / f'{n + 2:02d}-art.png'))
    numbers = [str(i + 1) for i in range(3, n)]
    game_refs = (f"Images {', '.join(numbers[:-1])} and {numbers[-1]} are God of War 1, 2 and 3 game images for the world, costume, weapon and monster shapes only; do not copy their realistic 3D rendering. "
                 if len(numbers) > 1 else f"Image {numbers[0]} is a God of War game image for the world, costume, weapon and monster shapes only; do not copy its realistic 3D rendering. ")
    prompt = TEMPLATE.format(game_refs=game_refs, scan_n=n + 1, art_n=n + 2, name=card['name'], type=card['type'],
                             scene=entry['scene'], composition=COMPOSITION[card['type']])
    return prompt, paths


lock = threading.Lock()


def run_one(card, entry, work, candidates, force, dry_run, attempts=4):
    raw = work / 'raw'
    raw.mkdir(parents=True, exist_ok=True)
    outs = [raw / f"{card['id']}-{i}.png" for i in range(1, candidates + 1)]
    if all(o.exists() for o in outs) and not force:
        return card['id'], 'cached'
    prompt, images = build(card, entry, work)
    PROMPTS.mkdir(parents=True, exist_ok=True)
    (PROMPTS / f"{card['id']}.txt").write_text(prompt)
    out = raw / f"{card['id']}.png"
    command = [sys.executable, str(CLI), 'edit', '--model', PLAN['model'], '--quality', PLAN['quality'], '--size', PLAN['size'],
               '--output-format', 'png', '--n', str(candidates), '--no-augment', '--force', '--prompt-file', str(PROMPTS / f"{card['id']}.txt"),
               '--out', str(out)]
    for image in images:
        command += ['--image', str(image)]
    if dry_run:
        return card['id'], 'dry-run: ' + ' '.join(command[:12]) + f' ... {len(images)} images'
    last = ''
    for attempt in range(1, attempts + 1):
        result = subprocess.run(command, capture_output=True, text=True)
        if result.returncode == 0:
            produced = [out] if candidates == 1 else [raw / f"{card['id']}-{i}.png" for i in range(1, candidates + 1)]
            if candidates == 1:
                out.rename(outs[0])
            if all(o.exists() for o in outs):
                return card['id'], 'ok'
        last = (result.stderr or result.stdout)[-400:]
        with lock:
            print(f"{card['id']} attempt {attempt}/{attempts} failed: {last.strip().splitlines()[-1] if last.strip() else ''}", file=sys.stderr, flush=True)
        if re.search(r'moderation|safety|content_policy', last, re.I):
            break
        time.sleep(min(90, 8 * 2 ** attempt))
    return card['id'], 'FAILED ' + last


def command_run(args):
    catalogue = {c['id']: c for c in load_catalogue()}
    ids = PROTOTYPE if args.prototype else list(PLAN['cards']) if args.all else args.cards
    work = Path(args.work)
    with concurrent.futures.ThreadPoolExecutor(args.concurrency) as pool:
        futures = [pool.submit(run_one, catalogue[i], PLAN['cards'][i], work, args.candidates, args.force, args.dry_run) for i in ids]
        failed = 0
        for future in concurrent.futures.as_completed(futures):
            card_id, status = future.result()
            failed += status.startswith('FAILED')
            print(f'{card_id}: {status}', flush=True)
    return 1 if failed else 0


def command_select(args):
    SOURCES.mkdir(parents=True, exist_ok=True)
    selections_path = HERE / 'selections.json'
    selections = json.loads(selections_path.read_text()) if selections_path.exists() else {}
    for item in args.picks:
        card_id, number = item.split('=')
        raw = Path(args.work) / 'raw' / f'{card_id}-{number}.png'
        image = Image.open(raw).convert('RGB')
        assert image.size == (1536, 1024), (raw, image.size)
        target = SOURCES / f'{card_id}.webp'
        if args.lossless:
            image.save(target, 'WEBP', lossless=True, quality=100, method=6)
        else:  # the highest quality that keeps the repo source at or under 150 KiB
            for quality in range(90, 69, -2):
                image.save(target, 'WEBP', quality=quality, method=6)
                if target.stat().st_size <= 150 * 1024:
                    break
        selections[card_id] = {'candidate': int(number), 'source': str(target.relative_to(ROOT)), 'webpQuality': 'lossless' if args.lossless else quality, 'bytes': target.stat().st_size}
        print(card_id, target.stat().st_size)
    selections_path.write_text(json.dumps(dict(sorted(selections.items())), indent=1) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--work', default=str(DEFAULT_WORK))
    sub = parser.add_subparsers(dest='command', required=True)
    run = sub.add_parser('run')
    group = run.add_mutually_exclusive_group(required=True)
    group.add_argument('--prototype', action='store_true')
    group.add_argument('--all', action='store_true')
    group.add_argument('--cards', nargs='+')
    run.add_argument('--candidates', type=int, default=1)
    run.add_argument('--concurrency', type=int, default=3)
    run.add_argument('--force', action='store_true')
    run.add_argument('--dry-run', action='store_true')
    select = sub.add_parser('select')
    select.add_argument('picks', nargs='+', metavar='id=n')
    select.add_argument('--lossless', action='store_true', help='store the model PNG as lossless WebP (~1.4 MB per card) instead of <= 150 KiB lossy')
    args = parser.parse_args()
    sys.exit({'run': command_run, 'select': command_select}[args.command](args) or 0)


if __name__ == '__main__':
    main()
