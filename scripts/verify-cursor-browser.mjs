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
          assert.equal(normal, 'none')
          await page.locator('.game-cursor:popover-open').waitFor()
          await page.mouse.down()
          const pressed = await target.evaluate(el => getComputedStyle(el).cursor)
          assert.equal(pressed, 'none')
          assert(await page.locator('.game-cursor').evaluate(el => el.classList.contains('game-cursor--pressed')))
          // Release away from the control so testing a cursor does not activate it.
          await page.mouse.move(1, 1)
          await page.mouse.up()
          assert.equal(await target.evaluate(el => getComputedStyle(el).cursor), normal)
        }
        await check(page.getByRole('button', { name: 'Single Player', exact: true }))
        // Actual painted cursor geometry at all edges, not just a CSS URL that
        // Chromium may silently replace with its native cursor.
        for (const [x, y] of [[1, 1], [width - 1, 1], [1, height - 1], [width - 1, height - 1]]) {
          await page.mouse.move(x, y)
          const cursor = await page.locator('.game-cursor img').first().evaluate(el => {
            const rect = el.getBoundingClientRect()
            return { x: rect.x, y: rect.y, width: rect.width, loaded: el.complete && el.naturalWidth > 0 }
          })
          assert.deepEqual(cursor, { x: x - 14, y: y - 12, width: 64, loaded: true })
          assert.equal(await page.evaluate(([x, y]) => getComputedStyle(document.elementFromPoint(x, y)).cursor, [x, y]), 'none')
        }
        await page.mouse.move(24, height - 24)
        await page.screenshot({ path: `${output}/${name}-${screen}-edge.png` })
        await page.evaluate(() => {
          const dialog = document.createElement('dialog')
          dialog.id = 'cursor-test-dialog'
          dialog.innerHTML = '<button>Cursor modal test</button>'
          document.body.append(dialog)
          dialog.showModal()
        })
        await check(page.getByRole('button', { name: 'Cursor modal test', exact: true }))
        await page.getByRole('button', { name: 'Cursor modal test', exact: true }).hover()
        await page.screenshot({ path: `${output}/${name}-${screen}-modal.png` })
        await page.getByRole('button', { name: 'Cursor modal test', exact: true }).click()

        await page.evaluate(() => window.dispatchEvent(new Event('blur')))
        assert.equal(await page.locator('.game-cursor:popover-open').count(), 0)
        assert.equal(await page.evaluate(() => document.documentElement.classList.contains('game-cursor-active')), false)
        await page.mouse.move(100, 100)
        await page.locator('.game-cursor:popover-open').waitFor()
        if (screen === 'horizontal-phone') {
          await page.touchscreen.tap(100, 100)
          assert.equal(await page.locator('.game-cursor:popover-open').count(), 0)
        }
        await page.evaluate(() => document.getElementById('cursor-test-dialog').remove())
        await page.getByRole('button', { name: 'Compendium', exact: true }).click()
        await check(page.getByRole('button').first())
        await page.goto(`http://localhost:${server.httpServer.address().port}`, { waitUntil: 'networkidle' })
        for (const label of ['Single Player', 'Standard', 'Embark', 'Start standard campaign']) {
          if (label === 'Embark') {
            await page.mouse.move(24, height - 24)
            await page.screenshot({ path: `${output}/${name}-${screen}-character-back.png` })
          }
          await page.getByRole('button', { name: label, exact: true }).click()
        }
        await page.waitForFunction(() => window.__STS_DEBUG__?.getRun().phase === 'neow')
        await check(page.locator('.app-shell__header').first())
        await page.evaluate(() => { const run = window.__STS_DEBUG__.getRun(); window.__STS_DEBUG__.setRun({ ...run, phase: 'map', neow: null }) })
        await page.locator('.room--reachable').first().click()
        if (screen === 'horizontal-phone') await page.locator('.room--reachable').first().click()
        await page.locator('.combat').waitFor()
        await check(page.locator('.combat__bar'))
        await page.screenshot({ path: `${output}/${name}-${screen}.png` })
        assert.deepEqual(errors, [])
        await context.close()
        console.log(`✓ ${name} ${screen}: stable normal/pressed cursor, shared hotspot, title/Compendium/gameplay`)
      }
    } finally { await browser.close() }
  }
} finally { await server.close() }
