import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium, webkit } from './lib/profile-browser.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const out = `${root}artifacts/card-trails`
mkdirSync(out, { recursive: true })
const server = await createServer({ root, logLevel: 'silent', server: { port: 0 } })
await server.listen()
const colors = { ironclad: '#e74b38', silent: '#54ca68', defect: '#42aef5', watcher: '#a35ce5', hexaghost: '#a35ce5', slime_boss: '#a5df42', guardian: '#49d9c5', hermit: '#e8b650' }
const errors = []
const recording = process.argv.includes('--record')
try {
  for (const [engineName, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    if (process.env.TRAIL_ENGINE && process.env.TRAIL_ENGINE !== engineName) continue
    const browser = await engine.launch()
    try {
      if (recording && engineName !== 'chromium') continue
      for (const [screen, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 844, height: 390 }]]) {
        if (process.env.TRAIL_SCREEN && process.env.TRAIL_SCREEN !== screen) continue
        if (recording && screen !== 'desktop') continue
        const context = await browser.newContext({ viewport, hasTouch: screen === 'phone', ...(recording ? { recordVideo: { dir: out, size: viewport } } : {}) })
        const page = await context.newPage()
        page.on('pageerror', error => errors.push(String(error)))
        await page.goto(`http://localhost:${server.httpServer.address().port}`, { waitUntil: 'networkidle' })
        for (const name of ['Single Player', 'Standard', 'Embark', 'Start standard campaign']) await page.getByRole('button', { name, exact: true }).click()
        await page.waitForFunction(() => window.__STS_DEBUG__?.getRun().phase === 'neow')
        await page.evaluate(() => { const run = window.__STS_DEBUG__.getRun(); window.__STS_DEBUG__.setRun({ ...run, phase: 'map', neow: null }) })
        await page.locator('.map__legend').waitFor()
        const legend = await page.locator('.map__legend').boundingBox()
        assert(legend.y >= 0 && legend.y + legend.height <= viewport.height, 'Legend fits the viewport')
        await page.locator('.map__legend').evaluate(async el => {
          const image = new Image()
          image.src = getComputedStyle(el).backgroundImage.slice(5, -2)
          await image.decode()
        })
        await page.screenshot({ path: `${out}/${engineName}-${screen}-legend.png` })
        if (engineName === 'chromium' && screen === 'desktop') await page.waitForTimeout(1800)
        const mapRun = await page.evaluate(() => window.__STS_DEBUG__.getRun())
        await page.evaluate(() => {
          const run = structuredClone(window.__STS_DEBUG__.getRun())
          run.phase = 'reward'
          run.rewardDestination = 'map'
          run.rewards = [{ playerId: run.players[0].id, cardReward: true, choices: null, upgraded: false, gold: 0, potion: null, relic: null, bossRelics: false }]
          window.__STS_DEBUG__.setRun(run)
        })
        await page.getByRole('button', { name: 'Add a card to your deck.' }).click()
        await page.getByRole('heading', { name: 'Choose a Card' }).waitFor()
        const skip = page.getByRole('button', { name: 'Skip', exact: true })
        const normal = await skip.evaluate(el => getComputedStyle(el).backgroundImage)
        await skip.hover()
        await page.waitForTimeout(650)
        assert.equal(await skip.evaluate(el => getComputedStyle(el).backgroundImage), normal)
        await page.screenshot({ path: `${out}/${engineName}-${screen}-skip-hover.png` })
        if (engineName === 'chromium' && screen === 'desktop') await page.waitForTimeout(1000)
        await page.evaluate(run => window.__STS_DEBUG__.setRun(run), mapRun)
        await page.locator('.map__legend').waitFor()

        await page.locator('.room--reachable').first().click()
        if (screen === 'phone') await page.locator('.room--reachable').first().click()
        await page.locator('.combat').waitFor()
        const baseline = await page.evaluate(() => window.__STS_DEBUG__.getRun())
        if (!recording) {
          await page.evaluate(baseline => {
            const run = structuredClone(baseline)
            run.combat.enemies = [run.combat.enemies[0], { ...run.combat.enemies[0], uid: 'second-order-target', row: 1 }]
            Object.assign(run.combat, { phase: 'start', turn: 2, die: 1, startTurnProgress: undefined, pendingTriggers: [] })
            Object.assign(run.combat.players[0], { character: 'silent', shivs: 3, relics: [], powers: [
              { uid: 'order-demon', defId: 'demon_form', upgraded: false },
              { uid: 'order-blades', defId: 'infinite_blades', upgraded: true },
              { uid: 'order-fumes', defId: 'noxious_fumes', upgraded: false },
            ] })
            window.__STS_DEBUG__.setRun(run)
          }, baseline)
          await page.locator('.start-turn-order > summary').waitFor()
          await page.locator('.start-turn-order > summary').click()
          await page.locator('.start-turn-order button[aria-label*="Infinite Blades"][aria-label$="earlier"]').click()
          await page.locator('.start-turn-order > summary').click()
          await page.locator('.enemy__hit-area').first().click()
          await page.screenshot({ path: `${out}/${engineName}-${screen}-start-controls-closed.png` })
          const reset = page.getByRole('button', { name: 'Reset start choices', exact: true })
          await reset.waitFor()
          const summary = await page.locator('.start-turn-order > summary').boundingBox()
          const button = await reset.boundingBox()
          assert(summary.x + summary.width <= button.x || button.x + button.width <= summary.x || summary.y + summary.height <= button.y || button.y + button.height <= summary.y, 'Reset and order controls must not overlap')
          await page.locator('.start-turn-order > summary').click()
          const order = page.locator('.start-turn-order > ol')
          assert(await order.isVisible())
          const first = order.getByRole('button').nth(1)
          await first.click()
          await page.screenshot({ path: `${out}/${engineName}-${screen}-start-controls.png` })
        }
        const cases = [['silent','defend_silent','discard'], ['ironclad','flex','exhaust'], ['watcher','tantrum','draw']]
        if (engineName === 'chromium' && screen === 'desktop') for (const character of ['defect','hexaghost','slime_boss','guardian','hermit']) cases.push([character, 'defend_silent', 'discard'])
        for (const [character, card, destination] of cases) {
          await page.evaluate(({ baseline, character, card }) => {
            const run = structuredClone(baseline)
            const player = run.combat.players[0]
            run.combat.phase = 'player'
            run.combat.combatId += `-${character}-${card}`
            Object.assign(player, { character, hand: [{ uid: `trail-${card}`, defId: card, upgraded: false }, { uid: 'keep-turn-open', defId: 'injury', upgraded: false }], draw: [], discard: [], exhaust: [], energy: 9, block: 0 })
            player.name = character.replaceAll('_', ' ')
            run.players[0].name = player.name
            run.players[0].character = character
            run.combat.enemies.forEach(enemy => { enemy.hp = 90; enemy.maxHp = 90 })
            window.__STS_DEBUG__.setRun(run)
          }, { baseline, character, card })
          const playable = page.locator(`.hand .card[data-card-uid="trail-${card}"]`)
          // Card UID is exposed on the hand wrapper in some render paths.
          const target = await playable.count() ? playable : page.locator('.hand .card').first()
          await target.waitFor()
          await target.click()
          if (destination === 'draw') await page.locator('.enemy__hit-area').first().click()
          const flight = page.locator(`.card-flight--${destination}.card-flight`)
          await flight.waitFor({ state: 'attached', timeout: 5000 }).catch(async error => {
            await page.screenshot({ path: `${out}/${engineName}-${screen}-${character}-failure.png` })
            console.log(await page.evaluate(() => ({ phase: window.__STS_DEBUG__.getState().phase, prompt: document.querySelector('.prompt')?.textContent, hand: window.__STS_DEBUG__.getState().players[0].hand.map(c => c.defId) })))
            throw error
          })
          assert.equal(await flight.evaluate(el => getComputedStyle(el).getPropertyValue('--flight-trace').trim()), colors[character])
          await page.locator('.card-flight-trail[data-texture-ready="true"]').waitFor()
          assert.equal(await page.locator('.card-flight-effect filter').count(), 0, 'No live noise filter during playback')
          // Freeze close to landing to verify the real pile coordinates, then let it finish.
          const distance = recording ? 0 : await flight.evaluate(el => {
            const animation = el.getAnimations().find(a => a.animationName === 'card-resolve')
            const previousTime = animation.currentTime
            animation.pause(); animation.currentTime = 979
            const rect = el.getBoundingClientRect()
            const pile = document.querySelector(`[data-pile="${el.className.match(/card-flight--(draw|discard|exhaust)/)[1]}"]`).getBoundingClientRect()
            const distance = Math.hypot(rect.x + rect.width / 2 - pile.x - pile.width / 2, rect.y + rect.height / 2 - pile.y - pile.height / 2)
            animation.currentTime = previousTime; animation.play()
            return distance
          })
          assert(distance < 20, `${engineName} ${screen} ${destination} missed pile by ${distance}`)
          await page.waitForTimeout(700)
          if (!recording) await page.screenshot({ path: `${out}/${engineName}-${screen}-${character}-${destination}.png` })
          await flight.waitFor({ state: 'detached' })
          const trail = page.locator('.card-flight-trail__reveal')
          assert.equal(await trail.count(), 1, 'Trail should linger after card lands')
          assert(Number(await trail.evaluate(el => getComputedStyle(el).opacity)) > 0, 'Lingering trail is visible')
          await trail.waitFor({ state: 'detached' })
        }
        await page.evaluate(() => { document.documentElement.dataset.reducedMotion = 'true'; const run = window.__STS_DEBUG__.getRun(); run.combat.players[0].hand = [{ uid: 'quiet', defId: 'defend_silent', upgraded: false }]; window.__STS_DEBUG__.setRun({ ...run }) })
        await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hand.some(card => card.uid === 'quiet'))
        await page.locator('.hand .card').first().click()
        await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].discard.some(card => card.uid === 'quiet'))
        assert.equal(await page.locator('.card-flight-effect').count(), 0, 'Reduced motion omits both card flight and lingering trail')
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
        if (page.video()) console.log(`Recording: ${await page.video().path()}`)
        await context.close()
        console.log(`✓ ${engineName} ${screen}: pile endpoints, character colors, lingering fade, reduced motion`)
      }
    } finally { await browser.close() }
  }
  assert.deepEqual(errors, [])
} finally { await server.close() }
