import { strict as assert } from 'node:assert'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium, webkit } from 'playwright'
import { createRoomServer } from './room-server.mjs'
import { createRoom, joinRoom, startRun } from './lib/rooms.mjs'
import { installScreenAudit } from './lib/browser-screen-audit.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'artifacts/neow-viewport')
mkdirSync(out, { recursive: true })
const rooms = createRoomServer({ maxUpgradesPerWindow: 100 })
const address = await rooms.listen(0)
const target = `http://127.0.0.1:${address.port}`
const server = await createServer({ root, logLevel: 'silent', server: { port: 0, proxy: {
  '/api': { target }, '/ws': { target, ws: true },
} } })
await server.listen()
const origin = `http://localhost:${server.httpServer.address().port}`
const browser = await (process.argv.includes('--webkit') ? webkit : chromium).launch()
try {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 600 }, { width: 960, height: 450 }, { width: 844, height: 390 }]) {
    const phone = viewport.width === 844
    const context = await browser.newContext({ viewport, ...(phone ? { isMobile: true, hasTouch: true } : {}) })
    const page = installScreenAudit(await context.newPage())
    await page.addInitScript(() => {
      window.__NEOW_SOCKETS__ = []
      window.WebSocket = new Proxy(window.WebSocket, { construct(Target, args) {
        const socket = new Target(...args)
        window.__NEOW_SOCKETS__.push(socket)
        return socket
      } })
    })
    const errors = []
    page.on('pageerror', error => errors.push(String(error)))
    async function capture(label) {
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      const layout = await page.evaluate(() => {
        const scene = document.querySelector('.neow-screen').getBoundingClientRect()
        const action = document.querySelector('.neow-action').getBoundingClientRect()
        const buttons = [...document.querySelectorAll('.neow-action button')].filter(button => !button.disabled)
        return { height: innerHeight, width: innerWidth, scene: scene.toJSON(), action: action.toJSON(),
          scrollHeight: document.documentElement.scrollHeight, scrollWidth: document.documentElement.scrollWidth,
          buttons: buttons.map(button => ({ text: button.textContent, rect: button.getBoundingClientRect().toJSON() })) }
      })
      assert(layout.scene.bottom <= layout.height + 1, `${label}: Neow extends below viewport`)
      assert(layout.action.top >= layout.scene.top && layout.action.bottom <= layout.height + 1, `${label}: controls extend outside scene`)
      assert(layout.scrollHeight <= layout.height + 1, `${label}: document scrolls vertically`)
      assert(layout.scrollWidth <= layout.width + 1, `${label}: document scrolls horizontally`)
      for (const button of layout.buttons) {
        assert(button.rect.left >= 0 && button.rect.right <= layout.width + 1, `${label}: ${button.text} overflows horizontally`)
      }
      // Only the party list or the action panel may scroll; never the game viewport.
      for (const button of await page.locator('.neow-action button:enabled').all()) {
        await button.scrollIntoViewIfNeeded()
        await button.focus()
        assert(await button.evaluate(element => {
          const box = element.getBoundingClientRect()
          return box.top >= 0 && box.bottom <= innerHeight + 1 &&
            element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
        }), `${label}: control cannot be reached`)
      }
      assert.equal(await page.evaluate(() => scrollY), 0, `${label}: reaching a control scrolled the page`)
      await page.screenshot({ path: join(out, `${label}-${viewport.width}.png`) })
    }
    await page.goto(origin)
    await page.getByRole('button', { name: 'Single Player', exact: true }).click()
    await page.getByRole('button', { name: 'Standard', exact: true }).click()
    await page.getByRole('button', { name: 'Embark' }).click()
    await page.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
    await page.getByRole('heading', { name: 'Neow’s Blessing' }).waitFor()
    await page.evaluate(() => window.__STS_DEBUG__.reset(1, 'neow-viewport'))
    await capture('solo-gold')
    await page.getByRole('button', { name: 'Skip 3 Gold', exact: true }).click()
    await capture('solo')
    await page.getByRole('button', { name: 'Reveal Card Reward', exact: true }).click()
    await page.locator('.reward-screen--card-choice').waitFor()
    await page.screenshot({ path: join(out, `reward-${viewport.width}.png`) })
    await page.getByRole('button', { name: 'Skip', exact: true }).click()
    await page.locator('.neow-options').waitFor()
    await capture('choices')

    // Use the real online wrapper and server-owned four-player Neow state.
    const room = createRoom(rooms.store)
    const seats = ['ironclad', 'silent', 'defect', 'watcher'].map(character => joinRoom(room, { character, name: character }))
    startRun(room, seats[0].token, { seed: 'neow-viewport' })
    await page.evaluate(saved => sessionStorage.setItem('sts-room-session', JSON.stringify(saved)), { code: room.code, token: seats[0].token })
    await page.reload()
    await page.locator('.app-shell--online .neow-screen').waitFor()
    await page.locator('.connection--connected').waitFor()
    await capture('party-gold')
    await page.getByRole('button', { name: 'Skip 3 Gold', exact: true }).click()
    await capture('party-reveal')
    await page.getByRole('button', { name: 'Reveal Card Reward', exact: true }).click()
    await page.locator('.reward-screen--card-choice').waitFor()
    await page.getByRole('button', { name: 'Skip', exact: true }).click()
    await page.locator('.neow-options').waitFor()
    await capture('party-choices')
    const faces = page.locator('.neow-faces')
    await faces.evaluate(element => { element.scrollTop = element.scrollHeight })
    assert(await faces.locator('.neow-face').last().evaluate(element => {
      const box = element.getBoundingClientRect()
      const list = element.parentElement.getBoundingClientRect()
      return box.bottom <= list.bottom + 1 && box.bottom <= innerHeight
    }), 'last party blessing is clipped')
    await context.setOffline(true)
    await page.evaluate(() => window.__NEOW_SOCKETS__.at(-1).close())
    await page.locator('.connection--reconnecting').waitFor()
    await capture('party-disconnected')
    assert.equal(await page.locator('.neow-action button:enabled').count(), 0)
    await context.setOffline(false)
    // Reconnect preserves the viewer and pending choices in the same bounded shell.
    await page.reload()
    await page.locator('.connection--connected').waitFor()
    await page.locator('.neow-options').waitFor()
    await capture('party-reconnected')
    assert.equal(await page.locator('.neow-face--active .neow-face__owner strong').textContent(), 'ironclad')
    assert.deepEqual(errors, [])
    console.log(`Neow viewport checks passed: ${viewport.width}x${viewport.height}${phone ? ' touch' : ' desktop'}`)
    await context.close()
  }
} finally {
  await browser.close()
  await server.close()
  await rooms.close()
}
