import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium, devices, webkit } from './lib/profile-browser.mjs'
import { postNeowRun } from './lib/post-neow-run.mjs'
import { enterRoom } from '../src/game/run.ts'

const root = resolve(import.meta.dirname, '..')
const out = resolve(root, 'artifacts/card-damage-preview')
mkdirSync(out, { recursive: true })
const server = await createServer({ root, logLevel: 'silent', server: { port: 0 } })
await server.listen()

const card = (defId, i) => ({ uid: `live-${i}`, defId, upgraded: false })
const enemy = (base, uid, defId, over = {}) => ({
  ...base, uid, defId, row: 0, hp: 60, maxHp: 60, block: 0, dead: false, isBoss: false, vulnerable: 0, weak: 0, ...over,
})

/** Reads each hand card's badge by card name: { name: { text, trend } | null }. */
const badges = (page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.hand .card')].map((element) => {
  const badge = element.querySelector('.card__live-damage')
  return [element.getAttribute('aria-label').split(',')[0], badge ? { text: badge.textContent.trim(), trend: badge.dataset.trend ?? null } : null]
})))

try {
  for (const [engineName, engine] of Object.entries({ chromium, webkit })) {
    if (process.argv.includes('--webkit-only') && engineName !== 'webkit') continue
    const browser = await engine.launch()
    try {
      for (const [screen, viewport] of [['desktop', { width: 1440, height: 900 }], ['horizontal-phone', { width: 844, height: 390 }]]) {
        if (process.argv.includes('--touch-only') && screen !== 'horizontal-phone') continue
        const context = await browser.newContext(screen === 'horizontal-phone' ? devices['iPhone 13 landscape'] : { viewport })
        const page = await context.newPage()
        const errors = []
        page.on('pageerror', (error) => errors.push(String(error)))
        await page.goto(`http://localhost:${server.httpServer.address().port}`)
        for (const name of ['Single Player', 'Standard', 'Embark', 'Start standard campaign']) {
          const button = page.getByRole('button', { name, exact: true })
          if (engineName === 'webkit' && screen === 'horizontal-phone') {
            await button.scrollIntoViewIfNeeded()
            const box = await button.boundingBox()
            const visual = await page.evaluate(() => ({ x: visualViewport.offsetLeft, y: visualViewport.offsetTop, scale: visualViewport.scale }))
            await page.touchscreen.tap((box.x + box.width / 2 - visual.x) * visual.scale,
              (box.y + box.height / 2 - visual.y) * visual.scale)
          } else await button.click()
        }
        const run = postNeowRun(47, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
        const id = run.map.rows[0][0]
        run.map.rooms[id].kind = 'encounter'
        const combat = enterRoom(run, id)
        const player = combat.combat.players[0]
        player.energy = 3
        player.hand = ['strike_ironclad', 'twin_strike', 'body_slam', 'heavy_blade', 'defend_ironclad', 'cleave', 'headbutt']
          .map(card)
        // Headbutt asks which discarded card to recover, so only then does it need a decision.
        player.discard = [card('strike_ironclad', 99)]
        const base = combat.combat.enemies[0]
        const play = async (change, enemies) => {
          const next = structuredClone(combat)
          change(next.combat.players[0])
          next.combat.enemies = enemies(next.combat.enemies[0])
          await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), next)
          await page.locator('.hand .card').first().waitFor()
          await page.waitForTimeout(1200)
        }

        // One enemy: its Vulnerable counts. Strength 3 and 12 Block.
        await play((p) => { p.strength = 3; p.block = 12 }, (b) => [enemy(b, 'only', 'jaw_worm', { vulnerable: 2 })])
        let shown = await badges(page)
        assert.deepEqual(shown.Strike, { text: '8', trend: 'up' }, `${screen}: Strength then Vulnerable ${JSON.stringify(shown)}`)
        assert.deepEqual(shown['Twin Strike'], { text: '16', trend: 'up' }, `${screen}: both hits ${JSON.stringify(shown)}`)
        assert.deepEqual(shown['Body Slam'], { text: '30', trend: 'up' }, `${screen}: Block-scaled ${JSON.stringify(shown)}`)
        assert.equal(shown.Defend, null, `${screen}: a Skill has no damage`)
        assert.equal(shown.Headbutt, null, `${screen}: a card that needs a choice has no preview`)
        const geometry = await page.evaluate(() => [...document.querySelectorAll('.hand .card')].flatMap((element) => {
          const badge = element.querySelector('.card__live-damage')
          if (!badge) return []
          const card = element.getBoundingClientRect(), mark = badge.getBoundingClientRect()
          const burst = element.querySelector('.card__aoe')?.getBoundingClientRect()
          return [{ inside: mark.left >= card.left - 1 && mark.right <= card.right + 1 && mark.top >= card.top - 1 && mark.bottom <= card.bottom + 1,
            clear: !burst || mark.right <= burst.left || mark.left >= burst.right || mark.bottom <= burst.top || mark.top >= burst.bottom,
            name: element.getAttribute('aria-label').split(',')[0] }]
        }))
        assert(geometry.length > 0 && geometry.every((item) => item.inside && item.clear), `${screen}: badge clipped or on the AoE burst ${JSON.stringify(geometry)}`)
        await page.screenshot({ path: resolve(out, `${engineName}-${screen}-strength-vulnerable.png`) })
        const bodySlam = page.locator('.hand .card[aria-label^="Body Slam"]')
        await bodySlam.hover()
        await page.waitForTimeout(500)
        await page.screenshot({ path: resolve(out, `${engineName}-${screen}-hover-body-slam.png`) })
        await page.mouse.move(2, 2)

        // Weak with no Strength: the hit is smaller than printed.
        await play((p) => { p.weak = 1 }, (b) => [enemy(b, 'only', 'jaw_worm')])
        shown = await badges(page)
        assert.deepEqual(shown.Strike, { text: '0', trend: 'down' }, `${screen}: Weak ${JSON.stringify(shown)}`)
        assert.deepEqual(shown['Twin Strike'], { text: '0', trend: 'down' }, `${screen}: Weak per hit ${JSON.stringify(shown)}`)
        await page.screenshot({ path: resolve(out, `${engineName}-${screen}-weak.png`) })

        // Several enemies: a neutral number until the pointer picks one.
        await play((p) => { p.strength = 1 }, (b) => [
          enemy(b, 'plain', 'jaw_worm'), enemy(b, 'marked', 'fungi_beast', { vulnerable: 1 })])
        shown = await badges(page)
        assert.deepEqual(shown.Strike, { text: '2', trend: 'up' }, `${screen}: neutral stand-in ${JSON.stringify(shown)}`)
        const marked = page.locator('[data-enemy-id="marked"] .enemy__hit-area')
        await marked.hover()
        await page.waitForFunction(() => document.querySelector('.hand .card[aria-label^="Strike"] .card__live-damage')?.textContent.trim() === '4')
        await page.screenshot({ path: resolve(out, `${engineName}-${screen}-hover-vulnerable-enemy.png`) })
        // The aim stays on the last enemy pointed at while the pointer travels to the hand.
        await page.mouse.move(2, 2)
        await page.waitForTimeout(300)
        assert.equal((await badges(page)).Strike.text, '4', `${screen}: aim lost on the way to the hand`)
        await page.locator('[data-enemy-id="plain"] .enemy__hit-area').hover()
        await page.waitForFunction(() => document.querySelector('.hand .card[aria-label^="Strike"] .card__live-damage')?.textContent.trim() === '2')

        // Dragging a card over an enemy aims at it, though the pointer is captured by the card.
        await page.locator('[data-enemy-id="plain"] .enemy__hit-area').hover()
        await page.waitForFunction(() => document.querySelector('.hand .card[aria-label^="Strike"] .card__live-damage')?.textContent.trim() === '2')
        const strike = await page.locator('.hand .card[aria-label^="Strike"]').boundingBox()
        const aim = await marked.boundingBox()
        await page.mouse.move(strike.x + strike.width / 2, strike.y + strike.height / 2)
        await page.mouse.down()
        await page.mouse.move(aim.x + aim.width / 2, aim.y + aim.height / 2, { steps: 12 })
        await page.waitForFunction(() => document.querySelector('.hand .card[aria-label^="Strike"] .card__live-damage')?.textContent.trim() === '4')
        await page.mouse.move(2, 2, { steps: 6 })
        await page.mouse.up()
        await page.waitForTimeout(400)

        // Settings > Card hints hides the damage badge and the area-of-effect symbol, and remembers it.
        const aoe = () => page.locator('.hand .card[aria-label^="Cleave"] .card__aoe').evaluate((symbol) => getComputedStyle(symbol).display)
        assert.equal(await page.evaluate(() => document.documentElement.dataset.cardHints), 'true', `${screen}: Card hints default to on`)
        assert.notEqual(await aoe(), 'none', `${screen}: the area-of-effect symbol is shown by default`)
        await page.getByRole('button', { name: 'Settings', exact: true }).click()
        const dialog = page.getByRole('dialog', { name: 'Settings' })
        await dialog.getByRole('button', { name: 'video', exact: true }).click()
        const hints = dialog.getByRole('checkbox', { name: /Card hints/ })
        assert(await hints.isChecked(), `${screen}: the Card hints checkbox starts on`)
        await hints.uncheck()
        await dialog.getByRole('button', { name: /Back/ }).click()
        await page.waitForTimeout(300)
        assert.equal(await page.locator('.hand .card__live-damage').count(), 0, `${screen}: damage badges remain with Card hints off`)
        assert.equal(await aoe(), 'none', `${screen}: the area-of-effect symbol remains with Card hints off`)
        assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('sts-game-settings')).cardHints), false, `${screen}: the choice is not saved`)
        await page.screenshot({ path: resolve(out, `${engineName}-${screen}-card-hints-off.png`) })
        await page.getByRole('button', { name: 'Settings', exact: true }).click()
        await dialog.getByRole('button', { name: 'video', exact: true }).click()
        await dialog.getByRole('checkbox', { name: /Card hints/ }).check()
        await dialog.getByRole('button', { name: /Back/ }).click()
        await page.waitForFunction(() => document.querySelectorAll('.hand .card__live-damage').length > 0)
        assert.notEqual(await aoe(), 'none', `${screen}: the area-of-effect symbol does not return`)

        // Nothing is spent or changed by showing a number.
        const before = await page.evaluate(() => JSON.stringify(window.__STS_DEBUG__.getRun().combat))
        await marked.hover()
        await page.waitForTimeout(300)
        assert.equal(await page.evaluate(() => JSON.stringify(window.__STS_DEBUG__.getRun().combat)), before, `${screen}: previewing changed combat`)
        // Snecko changes the next play's price, while each full scan keeps its printed cost.
        const snecko = structuredClone(combat)
        snecko.players[0].character = 'kratos'
        const kratos = snecko.combat.players[0]
        Object.assign(kratos, { character: 'kratos', energy: 9, rage: 0, enemyNextCardCost: 3,
          hand: ['kratos_rage_of_the_gods', 'defend_kratos', 'kratos_hyperion_charge'].map(card) })
        snecko.combat.enemies = [enemy(base, 'snecko', 'snecko')]
        await page.evaluate(run => window.__STS_DEBUG__.setRun(run), snecko)
        await page.waitForFunction(() => document.querySelectorAll('.hand .card').length === 3)
        await page.locator('.hand .card__art').evaluateAll(images => Promise.all(images.map(image => image.decode())))
        await page.waitForFunction(() => [...document.querySelectorAll('.hand .card__art')]
          .every(image => getComputedStyle(image).visibility === 'visible'))
        await page.waitForFunction(() => [...document.querySelectorAll('.hand .card')].every(card => {
          const box = card.getBoundingClientRect()
          return box.width > 0 && box.top >= 0 && box.bottom <= innerHeight + 1 &&
            Number(getComputedStyle(card).opacity) === 1 && card.getAnimations().every(animation => animation.playState !== 'running')
        }))
        assert.equal(await page.locator('.hand .card__live-cost').count(), 0, 'Snecko must not cover every printed cost with its next-play price')
        assert((await page.locator('.hand .card').evaluateAll(cards => cards.map(card => card.getAttribute('aria-label'))))
          .every(label => label.includes('cost 3')), 'play information must still expose the actual next-play price')
        assert((await page.locator('.hand .card-face').evaluateAll(faces => faces.map(face => getComputedStyle(face).visibility)))
          .every(visibility => visibility === 'hidden'), 'fallback costs must not leak through transparent scans')
        await page.mouse.move(2, 2)
        await page.screenshot({ path: resolve(out, `${engineName}-${screen}-snecko-hand.png`) })
        await page.locator('.hand .card[aria-label^="Rage of the Gods"]').click()
        await page.waitForFunction(() => {
          const player = window.__STS_DEBUG__.getRun().combat.players[0]
          return player.energy === 6 && player.enemyNextCardCost === null && player.hand.length === 2
        })
        assert.match(await page.locator('.hand .card[aria-label^="Defend"]').getAttribute('aria-label'), /cost 1/)
        assert.match(await page.locator('.hand .card[aria-label^="Hyperion Charge"]').getAttribute('aria-label'), /cost 2/)
        assert.equal(await page.locator('.hand .card__live-cost').count(), 0)
        await page.screenshot({ path: resolve(out, `${engineName}-${screen}-snecko-after-first-card.png`) })
        assert.deepEqual(errors, [])
        await context.close()
        console.log(`${engineName}/${screen}: live card damage passed`)
      }
    } finally { await browser.close() }
  }
} finally { await server.close() }
