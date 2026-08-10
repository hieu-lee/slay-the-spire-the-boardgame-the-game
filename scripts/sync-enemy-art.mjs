// Extracts enemy portraits from the enemy card scans embedded in the rulebook.
//
// The board game's enemy cards carry the creature art in a window across the
// top of the card. Cropping that window gives a portrait per enemy, which is
// what makes the board read as a game rather than a spreadsheet of hit points.
//
// Pinned by content hash for the same reason as sync-icons.mjs: a rulebook
// revision that reorders its images must not silently remap the art.
//
// Requires: docs/reference/STS_KS_Rulebook.pdf, PyMuPDF + Pillow, and cwebp.
// Usage: node scripts/sync-enemy-art.mjs [--width=280]
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { ENEMY_ART } from './lib/enemy-art.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pdfPath = join(repoRoot, 'docs/reference/STS_KS_Rulebook.pdf')
const outDir = join(repoRoot, 'public/assets/enemies')

const args = process.argv.slice(2)
const width = Number((args.find((a) => a.startsWith('--width=')) ?? '--width=280').slice(8))

// The table lives in its own module so a verify script can read it without
// running this pipeline as a side effect of the import.
export { ENEMY_ART } from './lib/enemy-art.mjs'
if (!existsSync(pdfPath)) {
  console.error(`missing ${pdfPath} — see ATTRIBUTION.md for where to fetch it`)
  process.exit(1)
}

// Check the encoder up front rather than after extracting every portrait.
if (spawnSync('cwebp', ['-version'], { stdio: 'ignore' }).error) {
  console.error('missing `cwebp` — install it with `brew install webp` or `apt install webp`')
  process.exit(1)
}

mkdirSync(outDir, { recursive: true })

// The art window sits below the title banner, above the stat block, and inside
// the reward column on the left and the HP track on the right. These fractions
// were measured against the scans and hold for every enemy card, which all
// share one template.
const script = `
import fitz, hashlib, io, json, sys
from PIL import Image

pdf, out, width = sys.argv[1], sys.argv[2], int(sys.argv[3])
wanted = json.loads(sys.argv[4])
by_hash = {h: name for name, h in wanted.items() if h != "prebuilt"}

TOP, BOTTOM, LEFT, RIGHT = 0.115, 0.44, 0.145, 0.135

doc = fitz.open(pdf)
found = {}
for pno in range(len(doc)):
    for info in doc[pno].get_images(full=True):
        data = doc.extract_image(info[0])["image"]
        h = hashlib.md5(data).hexdigest()[:8]
        name = by_hash.get(h)
        if not name or name in found:
            continue
        im = Image.open(io.BytesIO(data)).convert("RGB")
        w, hh = im.size
        art = im.crop((int(w * LEFT), int(hh * TOP), int(w * (1 - RIGHT)), int(hh * BOTTOM)))
        scale = width / art.width
        art = art.resize((width, max(1, int(art.height * scale))), Image.LANCZOS)
        art.save(f"{out}/{name}.png")
        found[name] = h

print(json.dumps({
    "found": sorted(found),
    "missing": sorted(name for name, source in wanted.items() if source != "prebuilt" and name not in found),
}))
`

const result = spawnSync(
  'python3',
  ['-c', script, pdfPath, outDir, String(width), JSON.stringify(ENEMY_ART)],
  { encoding: 'utf8' },
)

if (result.status !== 0) {
  console.error(result.stderr || 'python failed')
  console.error('\nPyMuPDF and Pillow are required:  pip install pymupdf pillow')
  process.exit(1)
}

const report = JSON.parse(result.stdout.trim().split('\n').pop())

// Re-encode to WebP, which halves the bytes at this size. A failure here used
// to leave the intermediate PNGs behind and still exit 0, so the app silently
// rendered no portraits at all.
const encodeFailures = []
for (const name of report.found) {
  const png = join(outDir, `${name}.png`)
  const webp = join(outDir, `${name}.webp`)
  const encode = spawnSync('cwebp', ['-quiet', '-q', '84', png, '-o', webp], { encoding: 'utf8' })
  if (encode.status === 0) {
    rmSync(png, { force: true })
  } else {
    rmSync(webp, { force: true })
    encodeFailures.push(`${name}: ${encode.error?.message ?? encode.stderr?.trim() ?? 'cwebp failed'}`)
  }
}

if (encodeFailures.length > 0) {
  console.error('cwebp failed — install it with `brew install webp` or `apt install webp`')
  for (const failure of encodeFailures.slice(0, 5)) console.error(`  ✗ ${failure}`)
  process.exit(1)
}

const written = readdirSync(outDir).filter((f) => f.endsWith('.webp'))
const bytes = written.reduce((sum, f) => sum + statSync(join(outDir, f)).size, 0)
console.log(`extracted ${written.length}/${Object.keys(ENEMY_ART).length} portraits at ${width}px`)
console.log(`total ${(bytes / 1024).toFixed(0)} KB`)
if (report.missing.length > 0) {
  console.error(`missing: ${report.missing.join(', ')}`)
  process.exit(1)
}
