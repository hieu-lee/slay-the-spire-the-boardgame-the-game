// Focused coverage for restored scene decoding and campfire WebP routing.
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium } from './lib/profile-browser.mjs'
import { postNeowRun } from './lib/post-neow-run.mjs'
const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'artifacts/art-scenes')
mkdirSync(output, { recursive: true })
const server = await createServer({ root, logLevel: 'silent', server: { port: 0 } })
await server.listen()
const browser = await chromium.launch({ headless: true })
try {
  for (const [name, viewport] of [['desktop', { width: 1440, height: 900 }], ['horizontal-phone', { width: 844, height: 390 }]]) {
    const page = await browser.newPage({ viewport })
    await page.goto(`http://localhost:${server.httpServer.address().port}`)
    for (const name of ['Single Player', 'Standard', 'Embark', 'Start standard campaign'])
      await page.getByRole('button', { name, exact: true }).click()
    await page.getByRole('heading', { name: 'Neow’s Blessing' }).waitFor()
    await page.waitForFunction(() => window.__STS_DEBUG__)
    for (const characters of [['ironclad'], ['guardian'], ['ironclad', 'silent', 'defect', 'watcher'], ['guardian', 'hexaghost', 'hermit']]) {
      const run = postNeowRun(47, characters.map((character, i) => ({ id: `p${i+1}`, name: character, character })))
      const roomId = run.map.rows[0][0]
      run.phase = 'room'; run.map.position = roomId; run.map.rooms[roomId].kind = 'campfire'
      await page.evaluate(run => window.__STS_DEBUG__.setRun(run), run)
      await page.getByRole('heading', { name: /Campfire/ }).waitFor().catch(async error => { await page.screenshot({ path: resolve(output, 'failure.png') }); throw error })
      const expected = `${characters.join('_')}_firecamp.webp`
      await page.waitForFunction(expected => getComputedStyle(document.querySelector('.campfire')).backgroundImage.includes(expected), expected)
      const size = await page.locator('.campfire').evaluate(async node => {
        const url = getComputedStyle(node).backgroundImage.match(/url\(["']?([^"')]+)["']?\)/)[1]
        const image = new Image(); image.src = url; await image.decode()
        return [image.naturalWidth, image.naturalHeight]
      })
      assert.deepEqual(size, [3840, 2161])
      await page.screenshot({ path: resolve(output, `${name}-${characters.join('-')}.png`) })
    }
    await page.close()
    console.log(`PASS ${name}: base, Downfall and multiplayer party campfire scenes decode at 4K`)
  }
} finally { await browser.close(); await server.close() }
