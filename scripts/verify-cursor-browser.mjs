import assert from 'node:assert/strict'
import { mkdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium, webkit } from './lib/profile-browser.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const output = `${root}artifacts/cursor`
mkdirSync(output, { recursive: true })
// Chromium 153 exempts cursors <=32 CSS pixels from viewport-edge fallback.
// CSS alone cannot reveal a native cursor fallback, so check the actual assets.
for (const name of ['cursor', 'cursor-click']) {
  const png = readFileSync(`${root}public/assets/ui/${name}.png`)
  assert.equal(png.readUInt32BE(16), 32)
  assert.equal(png.readUInt32BE(20), 32)
}
const server = await createServer({ root, base: '/cursor-check/', logLevel: 'silent', server: { port: 0 } })
await server.listen()
try {
  for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    if (process.argv.includes('--chrome') && name !== 'chromium') continue
    const browser = await engine.launch(process.argv.includes('--chrome') ? { channel: 'chrome' } : {})
    try {
      for (const [screen, width, height, scale] of [['desktop', 1440, 900, 1], ['retina-desktop', 1440, 900, 2], ['horizontal-phone', 844, 390, 2]]) {
        const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, hasTouch: screen === 'horizontal-phone' })
        const page = await context.newPage()
        const errors = []
        const cursorRequests = []
        page.on('response', response => {
          if (/cursor(?:-click)?\.png$/.test(response.url())) cursorRequests.push(response.status())
        })
        page.on('pageerror', error => errors.push(String(error)))
        await page.goto(`http://localhost:${server.httpServer.address().port}/cursor-check/`, { waitUntil: 'networkidle' })
        const check = async (target) => {
          await target.hover()
          const normal = await target.evaluate(el => getComputedStyle(el).cursor)
          assert(normal.includes('/cursor.png') && !normal.includes('image-set(') && normal.includes('7 6'), normal)
          await page.mouse.down()
          const pressed = await target.evaluate(el => getComputedStyle(el).cursor)
          assert(pressed.includes('/cursor-click.png') && !pressed.includes('image-set(') && pressed.includes('7 6'), pressed)
          // Release away from the control so testing a cursor does not activate it.
          await page.mouse.move(1, 1)
          await page.mouse.up()
          assert.equal(await target.evaluate(el => getComputedStyle(el).cursor), normal)
        }
        await check(page.getByRole('button', { name: 'Single Player', exact: true }))
        assert.equal(await page.locator('.game-cursor').count(), 0, 'software cursor overlay returned')
        for (const [x, y] of [[1, 1], [width - 1, 1], [1, height - 1], [width - 1, height - 1]]) {
          await page.mouse.move(x, y)
          assert((await page.evaluate(([x, y]) => getComputedStyle(document.elementFromPoint(x, y)).cursor, [x, y])).includes('/cursor.png'))
        }
        await page.evaluate(() => {
          const dialog = document.createElement('dialog')
          dialog.id = 'cursor-test-dialog'
          dialog.innerHTML = '<button>Cursor modal test</button>'
          document.body.append(dialog)
          dialog.showModal()
        })
        await check(page.getByRole('button', { name: 'Cursor modal test', exact: true }))
        assert((await page.locator('#cursor-test-dialog').evaluate(el => getComputedStyle(el, '::backdrop').cursor)).includes('/cursor.png'))
        await page.evaluate(() => document.getElementById('cursor-test-dialog').remove())
        await page.getByRole('button', { name: 'Compendium', exact: true }).click()
        await check(page.getByRole('button').first())
        await page.goto(`http://localhost:${server.httpServer.address().port}/cursor-check/`, { waitUntil: 'networkidle' })
        for (const label of ['Single Player', 'Standard', 'Embark', 'Start standard campaign']) await page.getByRole('button', { name: label, exact: true }).click()
        await page.waitForFunction(() => window.__STS_DEBUG__?.getRun().phase === 'neow')
        await check(page.locator('.app-shell__header').first())
        await page.evaluate(() => { const run = window.__STS_DEBUG__.getRun(); window.__STS_DEBUG__.setRun({ ...run, phase: 'map', neow: null }) })
        await page.locator('.room--reachable').first().click()
        if (screen === 'horizontal-phone') await page.locator('.room--reachable').first().click()
        await page.locator('.combat').waitFor()
        await check(page.locator('.combat__bar'))
        await page.screenshot({ path: `${output}/${name}-${screen}.png` })
        assert(cursorRequests.length >= 2 && cursorRequests.every(status => status === 200 || status === 304), `cursor asset requests: ${cursorRequests}`)
        assert.deepEqual(errors, [])
        await context.close()
        console.log(`✓ ${name} ${screen}: stable normal/pressed cursor, shared hotspot, title/Compendium/gameplay`)
      }
    } finally { await browser.close() }
  }
} finally { await server.close() }
