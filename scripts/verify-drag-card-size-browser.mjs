import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium, devices, webkit } from './lib/profile-browser.mjs'
import { postNeowRun } from './lib/post-neow-run.mjs'
import { enterRoom } from '../src/game/run.ts'

const root = resolve(import.meta.dirname, '..')
const out = resolve(root, 'artifacts/drag-card-size')
mkdirSync(out, { recursive: true })
const server = await createServer({ root, logLevel: 'silent', server: { port: 0 } })
await server.listen()
try {
  for (const [name, engine] of Object.entries({ chromium, webkit })) {
    const browser = await engine.launch()
    try {
      for (const phone of [false, true]) {
        const screen = phone ? 'horizontal-phone' : 'desktop'
        const context = await browser.newContext(phone ? devices['iPhone 13 landscape'] : { viewport: { width: 1440, height: 900 } })
        const page = await context.newPage()
        const errors = []
        page.on('pageerror', error => errors.push(String(error)))
        await page.goto(`http://localhost:${server.httpServer.address().port}`)
        for (const label of ['Single Player', 'Standard', 'Embark', 'Start standard campaign'])
          await page.getByRole('button', { name: label, exact: true }).click()
        const run = postNeowRun(47, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
        const room = run.map.rows[0][0]
        run.map.rooms[room].kind = 'encounter'
        await page.evaluate(run => window.__STS_DEBUG__.setRun(run), enterRoom(run, room))
        const card = page.locator('.hand .card[title="Strike"]').first()
        await card.waitFor()
        await page.waitForFunction(() => [...document.querySelectorAll('.hand .card')].every(e =>
          e.getAnimations().every(animation => animation.playState === 'finished')))
        const box = await card.boundingBox()
        const point = { x: box.x + box.width / 2, y: box.y + box.height / 3 }
        const touch = phone && name === 'chromium' ? await context.newCDPSession(page) : null
        if (touch) await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, id: 1 }] })
        else { await page.mouse.move(point.x, point.y); await page.mouse.down() }
        if (touch) await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x, y: point.y - 100, id: 1 }] })
        else await page.mouse.move(point.x, point.y - 100, { steps: 5 })
        const preview = page.locator('.card-drag')
        await preview.waitFor()
        const handWidth = await card.evaluate(e => parseFloat(getComputedStyle(e).width))
        const drag = await preview.evaluate(e => ({
          width: parseFloat(getComputedStyle(e).width), renderedWidth: e.getBoundingClientRect().width,
          renderedHeight: e.getBoundingClientRect().height,
          artReady: e.querySelector('img').complete && e.querySelector('img').naturalWidth > 0,
        }))
        assert(Math.abs(drag.width - handWidth) < 1, `${name} ${screen}: preview does not share hand size ${JSON.stringify({ handWidth, ...drag })}`)
        assert(drag.renderedWidth >= handWidth * 1.1 && drag.renderedWidth <= handWidth * 1.4,
          `${name} ${screen}: dragged card has the wrong rendered scale ${JSON.stringify(drag)}`)
        assert(drag.artReady && drag.renderedHeight > drag.renderedWidth, 'drag art is missing or distorted')
        await page.screenshot({ path: resolve(out, `${name}-${screen}.png`) })
        if (touch) await touch.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] })
        else { await page.mouse.move(point.x, point.y); await page.mouse.up() }
        await preview.waitFor({ state: 'detached' })
        assert.deepEqual(errors, [])
        console.log(`✓ ${name} ${screen}: hand ${handWidth}px, drag ${drag.width}px, rendered ${drag.renderedWidth}px`)
        await context.close()
      }
    } finally { await browser.close() }
  }
} finally { await server.close() }
