import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium, webkit } from './lib/profile-browser.mjs'
import { postNeowRun } from './lib/post-neow-run.mjs'
import { enterRoom } from '../src/game/run.ts'

const root = resolve(import.meta.dirname, '..')
const out = resolve(root, 'artifacts/enemy-hover')
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
        const fungi = page.locator('[data-enemy-def="fungi_beast"]')
        await fungi.locator('.enemy__hit-area').hover()
        const tip = page.locator('.card-keyword-tips[data-open]')
        await tip.waitFor()
        assert.match(await tip.innerText(), /Spore Cloud/)
        assert.equal(await page.locator('.enemy__ability').count(), 0)
        assert.match(await fungi.getAttribute('aria-label'), /Spore Cloud/)
        const box = await tip.boundingBox()
        assert(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1)
        await page.screenshot({ path: resolve(out, `${engineName}-${screen}-enemy.png`) })
        const target = await tip.boundingBox()
        const source = await fungi.locator('.enemy__hit-area').boundingBox()
        await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2)
        await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 })
        await page.waitForTimeout(250)
        assert.equal(await tip.count(), 1, 'tooltip must stay readable under pointer')
        await page.keyboard.press('Escape')
        await tip.waitFor({ state: 'hidden' })
        await page.locator('[data-enemy-def="jaw_worm"] .enemy__hit-area').hover()
        await tip.waitFor({ state: 'hidden' })
        assert.equal(await tip.count(), 0, 'enemy without abilities must not open a panel')
        await fungi.focus()
        await page.keyboard.press('Tab')
        await fungi.focus()
        await tip.waitFor()
        await fungi.evaluate(e => e.blur())
        await page.mouse.move(2, 2)
        await tip.waitFor({ state: 'hidden' })
        const cards = page.locator('.hand .card')
        await page.screenshot({ path: resolve(out, `${engineName}-${screen}-resting-hand.png`) })
        const center = cards.nth(3)
        const resting = await center.boundingBox()
        assert((viewport.height - resting.y) / resting.height >= .58, 'middle card must expose artwork through its type')
        for (const index of [0, 3, 6]) {
          await page.mouse.move(2, 2)
          await page.waitForTimeout(200)
          const card = cards.nth(index)
          const point = await card.evaluate(node => {
            const r = node.getBoundingClientRect()
            const y = innerHeight - 3
            for (let x = Math.ceil(r.left + 3); x < r.right - 3; x++)
              if (document.elementFromPoint(x, y)?.closest('.card') === node) return { x, y }
            return null
          })
          assert(point, `${screen}: card ${index} has no resting bottom hit area`)
          await page.mouse.move(point.x, point.y)
          await page.waitForTimeout(250)
          const samples = await card.evaluate(async node => {
            const result = []
            for (let i = 0; i < 30; i++) {
              await new Promise(requestAnimationFrame)
              const r = node.getBoundingClientRect()
              result.push({ hover: node.matches(':hover'), bottom: r.bottom, width: r.width, scroll: node.closest('.hand-scroll').scrollTop })
            }
            return result
          })
          assert(samples.every(s => s.hover && s.scroll === 0), `${engineName}/${screen} card ${index} at ${JSON.stringify(point)}: ${JSON.stringify(samples)}`)
          assert(Math.max(...samples.map(s => s.width)) - Math.min(...samples.map(s => s.width)) < .5, 'card oscillates')
          assert(samples.every(s => viewport.height - s.bottom >= 0 && viewport.height - s.bottom < 12), 'hover lifts higher than needed')
        }
        await center.hover()
        assert.equal(await tip.count(), 0, 'card help remains Shift-only')
        await page.keyboard.down('Shift')
        await tip.waitFor()
        await page.keyboard.up('Shift')
        await tip.waitFor({ state: 'hidden' })
        await page.waitForTimeout(250)
        await page.screenshot({ path: resolve(out, `${engineName}-${screen}-hand.png`) })
        await page.mouse.move(2, 2)
        await page.evaluate(() => {
          const run = structuredClone(window.__STS_DEBUG__.getRun())
          Object.assign(run.combat.enemies[0], { defId: 'time_eater', isBoss: true, hp: 30, maxHp: 30, abilityUsed: false })
          window.__STS_DEBUG__.setRun(run)
        })
        const boss = page.locator('[data-enemy-def="time_eater"]')
        await page.keyboard.press('Tab')
        await boss.focus()
        await tip.waitFor()
        assert.match(await tip.innerText(), /Time Warp/)
        assert.match(await tip.innerText(), /Haste/)
        await page.evaluate(() => {
          const run = structuredClone(window.__STS_DEBUG__.getRun())
          run.combat.enemies[0].abilityUsed = true
          window.__STS_DEBUG__.setRun(run)
        })
        await page.waitForFunction(() => document.querySelector('.card-keyword-tips[data-open]')?.textContent.includes('spent'))
        assert.match(await tip.innerText(), /Time Warp/, 'spent Haste must retain the other rule')
        await page.evaluate(() => {
          const run = structuredClone(window.__STS_DEBUG__.getRun())
          Object.assign(run.combat.enemies[0], { hp: 0, dead: true })
          window.__STS_DEBUG__.setRun(run)
        })
        await tip.waitFor({ state: 'hidden' })
        assert.deepEqual(errors, [])
        // Actual touch input gets the same rules on a tap, and an outside tap
        // dismisses them. This uses the app's mobile viewport policy too.
        if (screen === 'horizontal-phone') {
          const touchPage = await browser.newPage({ viewport, isMobile: true, hasTouch: true })
          await touchPage.goto(`http://localhost:${server.httpServer.address().port}`)
          for (const name of ['Single Player', 'Standard', 'Embark', 'Start standard campaign'])
            await touchPage.getByRole('button', { name, exact: true }).click()
          await touchPage.evaluate(run => window.__STS_DEBUG__.setRun(run), combat)
          const hit = touchPage.locator('[data-enemy-def="fungi_beast"] .enemy__hit-area')
          await hit.waitFor()
          await touchPage.waitForTimeout(1000)
          const tap = async (locator, fraction = .5) => {
            const point = await locator.evaluate((element, { webkit, fraction }) => {
              const r = element.getBoundingClientRect(), v = visualViewport
              return { x: (r.x + r.width / 2 - (webkit ? v.offsetLeft : 0)) * (webkit ? v.scale : 1),
                y: (r.y + r.height * fraction - (webkit ? v.offsetTop : 0)) * (webkit ? v.scale : 1) }
            }, { webkit: engineName === 'webkit', fraction })
            await touchPage.touchscreen.tap(point.x, point.y)
          }
          await tap(hit)
          await touchPage.locator('.card-keyword-tips[data-open]').waitFor()
          assert.match(await touchPage.locator('.card-keyword-tips[data-open]').innerText(), /Spore Cloud/)
          await touchPage.screenshot({ path: resolve(out, `${engineName}-${screen}-touch.png`) })
          await touchPage.touchscreen.tap(3, 3)
          await touchPage.locator('.card-keyword-tips[data-open]').waitFor({ state: 'hidden' })
          const defend = touchPage.locator('.hand .card[aria-label^="Defend,"]').first()
          const beforeTap = await touchPage.evaluate(() => structuredClone(window.__STS_DEBUG__.getRun().combat.players[0]))
          await tap(defend, .2)
          await touchPage.waitForTimeout(250)
          assert.deepEqual(await touchPage.evaluate(() => window.__STS_DEBUG__.getRun().combat.players[0]), beforeTap,
            'first touch must reveal the card without spending energy or applying its effect')
          assert(await defend.evaluate(e => document.activeElement === e && e.getBoundingClientRect().bottom <= innerHeight),
            'first tap must leave the full card visible')
          await touchPage.screenshot({ path: resolve(out, `${engineName}-${screen}-card-inspection.png`) })
          await tap(defend, .2)
          await touchPage.waitForFunction(count => window.__STS_DEBUG__.getRun().combat.players[0].hand.length === count - 1, beforeTap.hand.length)
          const afterTap = await touchPage.evaluate(() => window.__STS_DEBUG__.getRun().combat.players[0])
          assert.equal(afterTap.energy, beforeTap.energy - 1, 'second tap must spend energy exactly once')
          assert.equal(afterTap.block, beforeTap.block + 1, 'second tap must apply Defend exactly once')
          if (engineName === 'chromium') {
            // A deliberate first-touch drag remains an immediate play.
            await touchPage.waitForTimeout(700)
            const from = await defend.boundingBox()
            const cdp = await touchPage.context().newCDPSession(touchPage)
            const point = { x: from.x + from.width / 2, y: from.y + from.height * .2, id: 1 }
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
            for (let step = 1; step <= 8; step++) await cdp.send('Input.dispatchTouchEvent', {
              type: 'touchMove', touchPoints: [{ ...point, y: point.y - step * 15 }],
            })
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
            await touchPage.waitForFunction(count => window.__STS_DEBUG__.getRun().combat.players[0].hand.length === count - 1, afterTap.hand.length)
            assert.equal(await touchPage.evaluate(() => window.__STS_DEBUG__.getRun().combat.players[0].energy), afterTap.energy - 1)
            await cdp.detach()
          }
          await touchPage.close()
        }
        await page.close()
        console.log(`${engineName}/${screen}: enemy help, seven-card artwork and stable low hover passed`)
      }
    } finally { await browser.close() }
  }
} finally { await server.close() }
