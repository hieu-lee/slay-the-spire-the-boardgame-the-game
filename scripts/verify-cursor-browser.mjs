import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium, webkit } from './lib/profile-browser.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const output = `${root}artifacts/cursor`
mkdirSync(output, { recursive: true })
const server = await createServer({ root, logLevel: 'silent', server: { port: 0 } })
await server.listen()
try {
  for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await engine.launch()
    try {
      for (const [screen, width, height, scale] of [['desktop', 1440, 900, 1], ['retina-desktop', 1440, 900, 2], ['horizontal-phone', 844, 390, 2]]) {
        const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, hasTouch: screen === 'horizontal-phone' })
        const page = await context.newPage()
        const errors = []
        page.on('pageerror', error => errors.push(String(error)))
        await page.goto(`http://localhost:${server.httpServer.address().port}`, { waitUntil: 'networkidle' })
        const check = async (target) => {
          await target.hover()
          const normal = await target.evaluate(el => getComputedStyle(el).cursor)
          assert(normal.includes('image-set(') && normal.includes('/cursor@2x.png') && normal.includes('14 12'), normal)
          await page.mouse.down()
          const pressed = await target.evaluate(el => getComputedStyle(el).cursor)
          assert(pressed.includes('/cursor-click@2x.png') && pressed.includes('14 12'), pressed)
          // Release away from the control so testing a cursor does not activate it.
          await page.mouse.move(1, 1)
          await page.mouse.up()
          assert.equal(await target.evaluate(el => getComputedStyle(el).cursor), normal)
        }
        await check(page.getByRole('button', { name: 'Single Player', exact: true }))
        await page.getByRole('button', { name: 'Compendium', exact: true }).click()
        await check(page.getByRole('button').first())
        await page.goto(`http://localhost:${server.httpServer.address().port}`, { waitUntil: 'networkidle' })
        for (const label of ['Single Player', 'Standard', 'Embark', 'Start standard campaign']) await page.getByRole('button', { name: label, exact: true }).click()
        await page.waitForFunction(() => window.__STS_DEBUG__?.getRun().phase === 'neow')
        await check(page.locator('.app-shell__header').first())
        await page.evaluate(() => { const run = window.__STS_DEBUG__.getRun(); window.__STS_DEBUG__.setRun({ ...run, phase: 'map', neow: null }) })
        await page.locator('.room--reachable').first().click()
        if (screen === 'horizontal-phone') await page.locator('.room--reachable').first().click()
        await page.locator('.combat').waitFor()
        await check(page.locator('.combat__bar'))
        await page.evaluate(async () => {
          const gallery = document.createElement('div')
          gallery.style.cssText = 'position:fixed;z-index:99999;left:20px;top:150px;padding:20px;background:#b49b70;display:flex;gap:24px;color:#21190b'
          for (const [label, file] of [['Normal', 'cursor'], ['Pressed', 'cursor-click']]) {
            const cell = document.createElement('div')
            cell.textContent = label
            const image = new Image(64, 64)
            image.src = `/assets/ui/${file}.png`
            image.srcset = `/assets/ui/${file}.png 1x, /assets/ui/${file}@2x.png 2x`
            image.style.display = 'block'
            cell.append(image); gallery.append(cell)
            await image.decode()
            if (devicePixelRatio === 2 && !image.currentSrc.includes('@2x.png')) throw new Error('Retina asset not selected')
          }
          document.body.append(gallery)
        })
        await page.screenshot({ path: `${output}/${name}-${screen}.png` })
        assert.deepEqual(errors, [])
        await context.close()
        console.log(`✓ ${name} ${screen}: normal/pressed/release, shared hotspot, title/Compendium/gameplay, density assets`)
      }
    } finally { await browser.close() }
  }
} finally { await server.close() }
