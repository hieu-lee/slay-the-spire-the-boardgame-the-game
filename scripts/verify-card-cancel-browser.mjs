import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium, webkit } from './lib/profile-browser.mjs'
import { postNeowRun } from './lib/post-neow-run.mjs'
import { enterRoom } from '../src/game/run.ts'

const root = resolve(import.meta.dirname, '..')
const out = resolve(root, 'artifacts/card-cancel')
mkdirSync(out, { recursive: true })
const server = await createServer({ root, logLevel: 'silent', server: { port: 0 } })
await server.listen()
try {
  for (const [engineName, engine] of Object.entries({ chromium, webkit })) {
    if (process.argv.includes('--webkit-only') && engineName !== 'webkit') continue
    const browser = await engine.launch()
    try {
      for (const [screen, viewport] of [['desktop', { width: 1440, height: 900 }], ['horizontal-phone', { width: 844, height: 390 }]]) {
        const page = await browser.newPage({ viewport })
        const errors = []
        page.on('pageerror', error => errors.push(String(error)))
        await page.goto(`http://localhost:${server.httpServer.address().port}`)
        for (const name of ['Single Player', 'Standard', 'Embark', 'Start standard campaign'])
          await page.getByRole('button', { name, exact: true }).click()
        const run = postNeowRun(47, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
        const id = run.map.rows[0][0]
        run.map.rooms[id].kind = 'encounter'
        const combat = enterRoom(run, id)
        combat.combat.players[0].hand = Array.from({ length: 7 }, (_, i) => ({ uid: `hover-${i}`, defId: i % 2 ? 'defend_ironclad' : 'strike_ironclad', upgraded: false }))
        combat.combat.enemies = ['fungi_beast', 'jaw_worm'].map((defId, i) => ({
          ...combat.combat.enemies[0], uid: `hover-enemy-${i}`, defId, row: 0, hp: 5, maxHp: 5, dead: false, isBoss: false,
        }))
        await page.evaluate(run => window.__STS_DEBUG__.setRun(run), combat)
        await page.locator('.hand .card').first().waitFor()
        await page.waitForTimeout(1500)
        const card = page.locator('.hand .card').first()
        const resting = await card.boundingBox()
        const before = await page.evaluate(() => structuredClone(window.__STS_DEBUG__.getRun().combat))
        await card.hover()
        await card.click()
        assert.equal(await card.getAttribute('aria-pressed'), 'true')
        const board = await page.locator('.board').boundingBox()
        await page.mouse.click(board.x + board.width / 2, board.y + 15)
        await page.waitForTimeout(250)
        assert.equal(await card.getAttribute('aria-pressed'), 'false', 'blank click must cancel targeting')
        assert(await card.evaluate(e => !e.matches(':hover, :focus, .card--selected')), 'cancelled card must lose its raised state')
        const cancelled = await card.boundingBox()
        assert(Math.abs(cancelled.y - resting.y) < 1, 'cancelled card must return to its resting position')
        assert.deepEqual(await page.evaluate(() => window.__STS_DEBUG__.getRun().combat), before, 'cancellation must not play a card')
        await page.screenshot({ path: resolve(out, `${engineName}-${screen}-cancelled.png`) })
        await card.hover()
        await page.waitForTimeout(250)
        assert((await card.boundingBox()).y < resting.y - 5, 'hover must work again after cancellation')
        await card.click()
        await page.locator('[data-enemy-def="jaw_worm"] .enemy__head').click()
        await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.players[0].hand.length === 6)
        if (screen === 'horizontal-phone') {
          const touch = await browser.newPage({ viewport, isMobile: true, hasTouch: true })
          touch.on('pageerror', error => errors.push(String(error)))
          await touch.goto(`http://localhost:${server.httpServer.address().port}`)
          for (const name of ['Single Player', 'Standard', 'Embark', 'Start standard campaign'])
            await touch.getByRole('button', { name, exact: true }).click()
          await touch.evaluate(run => window.__STS_DEBUG__.setRun(run), combat)
          const strike = touch.locator('.hand .card').first()
          await strike.waitFor()
          await touch.waitForTimeout(1500)
          const tapCard = async () => {
            const point = await strike.evaluate((e, webkit) => {
              const r = e.getBoundingClientRect(), v = visualViewport
              return { x: (r.x + r.width / 2 - (webkit ? v.offsetLeft : 0)) * (webkit ? v.scale : 1),
                y: (r.y + r.height * .2 - (webkit ? v.offsetTop : 0)) * (webkit ? v.scale : 1) }
            }, engineName === 'webkit')
            await touch.touchscreen.tap(point.x, point.y)
            await touch.waitForTimeout(250)
          }
          await tapCard()
          await tapCard()
          assert.equal(await strike.getAttribute('aria-pressed'), 'true')
          await touch.touchscreen.tap(viewport.width / 2, 80)
          await touch.waitForTimeout(250)
          assert.equal(await strike.getAttribute('aria-pressed'), 'false')
          assert(await strike.evaluate(e => !e.matches(':hover, :focus, .card--selected')),
            'touch cancellation must clear the reveal and its second-tap activation state')
          assert.deepEqual(await touch.evaluate(() => window.__STS_DEBUG__.getRun().combat), before)
          await tapCard()
          assert.equal(await strike.getAttribute('aria-pressed'), 'false', 'after cancellation a fresh first tap only inspects')
          await touch.close()
        }
        assert.deepEqual(errors, [])
        await page.close()
        console.log(`${engineName}/${screen}: blank cancellation resets hover and allows replay`)
      }
    } finally { await browser.close() }
  }
} finally { await server.close() }
