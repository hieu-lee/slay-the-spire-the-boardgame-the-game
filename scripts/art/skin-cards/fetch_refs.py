#!/usr/bin/env python3
"""Download God of War 1/2/3 reference images from the GoW fandom wiki (MediaWiki API) into a local,
git-ignored folder, and record title/URL/SHA-256 in refs.json. Images stay out of git; the repo only
keeps the manifest.

  python3 scripts/art/skin-cards/fetch_refs.py [--out <dir>]

The default folder is $STS_SKIN_ART_WORK/refs (default artifacts/skin-art/refs), where generate.py reads it.
"""
import argparse
import hashlib
import json
import os
import time
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
REFS = Path(os.environ.get('STS_SKIN_ART_WORK', ROOT / 'artifacts/skin-art')) / 'refs'
API = 'https://godofwar.fandom.com/api.php'
UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
WIDTH = 1280

# tag -> wiki file titles. Tags are what plan.json's "refs" entries refer to.
FILES = json.loads((HERE / 'ref-files.json').read_text())


def get(url):
    request = urllib.request.Request(url, headers={'User-Agent': UA, 'Referer': 'https://godofwar.fandom.com/'})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return response.read()
        except Exception:
            if attempt == 3:
                raise
            time.sleep(2 * (attempt + 1))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', default=str(REFS))
    out = Path(parser.parse_args().out)
    out.mkdir(parents=True, exist_ok=True)
    manifest = []
    for tag, title in FILES.items():
        query = urllib.parse.urlencode({'action': 'query', 'titles': title, 'prop': 'imageinfo', 'iiprop': 'url|size',
                                        'iiurlwidth': WIDTH, 'format': 'json'})
        page = next(iter(json.loads(get(f'{API}?{query}'))['query']['pages'].values()))
        info = page['imageinfo'][0]
        url = info.get('thumburl') or info['url']
        target = next(iter(out.glob(f'{tag}.*')), None)
        if target is None:
            data = get(url)
            target = out / f"{tag}.{'webp' if data[8:12] == b'WEBP' else 'png' if data[:4] == b'\x89PNG' else 'jpg'}"
            target.write_bytes(data)
        manifest.append({'tag': tag, 'title': title, 'page': 'https://godofwar.fandom.com/wiki/' + urllib.parse.quote(title.replace(' ', '_')),
                         'url': url, 'sha256': hashlib.sha256(target.read_bytes()).hexdigest()})
        print(tag, target.stat().st_size)
    (HERE / 'refs.json').write_text(json.dumps(manifest, indent=1) + '\n')


if __name__ == '__main__':
    main()
