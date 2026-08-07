// Extracts the board game's own iconography from the official rulebook PDF.
//
// This is the right source for a board game implementation: the rulebook's
// symbols ARE the game's visual language, and they come out of the PDF as
// transparent PNGs at print resolution. Using video game sprites instead would
// be a different game's art.
//
// Icons are pinned by content hash rather than by position, so a different
// rulebook revision that reorders its images cannot silently remap them.
//
// Requires: docs/reference/STS_KS_Rulebook.pdf (see ATTRIBUTION.md) and PyMuPDF.
//   pip install pymupdf
//
// Usage: node scripts/sync-icons.mjs [--size=96]
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pdfPath = join(repoRoot, 'docs/reference/STS_KS_Rulebook.pdf')
const outDir = join(repoRoot, 'public/assets/icons')

const args = process.argv.slice(2)
const size = Number((args.find((a) => a.startsWith('--size=')) ?? '--size=96').slice(7))

/** md5 prefix of each icon's embedded image data, keyed by the name we use. */
export const ICONS = {
  attack: '3573163c',
  block: '0c6183bb',
  strength: '03887064',
  vulnerable: '66817b5e',
  weak: '7d4666f5',
  poison: '2fe2e85a',
  daze: '0336face',
  burn: '2c290e5d',
  shiv: '2085d840',
  miracle: '0bad830a',
  energy: '6c5a247f',
  potion: '3059d509',
  gold: '150806a5',
  relic: '0c6668b6',
  elite: '09eaf6cc',
  monster: '0bf87246',
  boss: '36ae6a66',
  aoe: '0895570d',
  die1: '046e8f59',
  die2: '1a664908',
  die3: '0490a47c',
  die4: '1eb93f3a',
  die5: '291b5740',
  die6: '2a932d72',
}

if (!existsSync(pdfPath)) {
  console.error(`missing ${pdfPath}`)
  console.error('Fetch it first — see ATTRIBUTION.md:')
  console.error('  curl -L https://contentiongames.com/_images/STS_KS_Rulebook.pdf \\')
  console.error('    -o docs/reference/STS_KS_Rulebook.pdf')
  process.exit(1)
}

mkdirSync(outDir, { recursive: true })

const script = `
import fitz, hashlib, io, json, sys
from PIL import Image

pdf, out, size = sys.argv[1], sys.argv[2], int(sys.argv[3])
wanted = json.loads(sys.argv[4])
by_hash = {h: name for name, h in wanted.items()}

doc = fitz.open(pdf)
found = {}
for pno in range(len(doc)):
    for info in doc[pno].get_images(full=True):
        xref = info[0]
        data = doc.extract_image(xref)["image"]
        h = hashlib.md5(data).hexdigest()[:8]
        name = by_hash.get(h)
        if not name or name in found:
            continue
        im = Image.open(io.BytesIO(data)).convert("RGBA")
        # Trim fully transparent margins so every icon fills its box evenly.
        bbox = im.getbbox()
        if bbox:
            im = im.crop(bbox)
        im.thumbnail((size, size), Image.LANCZOS)
        canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        canvas.paste(im, ((size - im.width) // 2, (size - im.height) // 2), im)
        canvas.save(f"{out}/{name}.png")
        found[name] = h

print(json.dumps({"found": sorted(found), "missing": sorted(set(wanted) - set(found))}))
`

const result = spawnSync('python3', ['-c', script, pdfPath, outDir, String(size), JSON.stringify(ICONS)], {
  encoding: 'utf8',
})

if (result.status !== 0) {
  console.error(result.stderr || 'python failed')
  console.error('\nPyMuPDF and Pillow are required:  pip install pymupdf pillow')
  process.exit(1)
}

const report = JSON.parse(result.stdout.trim().split('\n').pop())
const written = readdirSync(outDir).filter((f) => f.endsWith('.png'))
const bytes = written.reduce((sum, f) => sum + statSync(join(outDir, f)).size, 0)

console.log(`extracted ${report.found.length}/${Object.keys(ICONS).length} icons at ${size}px`)
console.log(`total ${(bytes / 1024).toFixed(0)} KB`)
if (report.missing.length > 0) {
  console.error(`missing: ${report.missing.join(', ')}`)
  for (const name of report.missing) rmSync(join(outDir, `${name}.png`), { force: true })
  process.exit(1)
}
