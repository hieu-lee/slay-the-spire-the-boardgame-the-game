import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { chromium } from './lib/profile-browser.mjs'

const server = await createServer({ logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } })
await server.listen()
const browser = await chromium.launch()
try {
  for (const [screen, viewport, phone] of [
    ['desktop', { width: 1440, height: 900 }, false],
    ['horizontal-phone', { width: 844, height: 390 }, true],
  ]) {
    const page = await browser.newPage({ viewport, hasTouch: phone, isMobile: phone, reducedMotion: 'reduce' })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`)
    for (const name of ['Single Player', 'Standard', 'Embark', 'Start standard campaign'])
      await page.getByRole('button', { name, exact: true }).click()
    await page.waitForFunction(() => window.__STS_DEBUG__?.getRun().phase === 'neow')
    await page.evaluate(() => {
      const run = structuredClone(window.__STS_DEBUG__.getRun())
      run.phase = 'map'
      run.neow = null
      window.__STS_DEBUG__.setRun(run)
    })
    const map = page.locator('.app-shell > .map')
    await map.waitFor()
    const gap = () => map.evaluate(element => element.getBoundingClientRect().top -
      element.parentElement.querySelector('.app-shell__header').getBoundingClientRect().bottom)
    assert(Math.abs(await gap()) <= 1, `${screen}: hidden dialogs must not leave a strip below the header`)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.locator('.settings-dialog[open]').waitFor()
    assert(Math.abs(await gap()) <= 1, 'opening a modal must not move the map')
    await page.keyboard.press('Escape')
    await page.locator('.settings-dialog[open]').waitFor({ state: 'detached' })
    assert(Math.abs(await gap()) <= 1, 'closing a modal must not reintroduce the gap')
    assert(await map.evaluate(element => {
      const sibling = document.createElement('section')
      sibling.hidden = true
      element.before(sibling)
      try {
        return Math.abs(element.getBoundingClientRect().top -
          element.parentElement.querySelector('.app-shell__header').getBoundingClientRect().bottom) <= 1
      } finally { sibling.remove() }
    }), 'other hidden siblings must not break header adjacency')
    assert(await map.evaluate(element => {
      const panel = document.createElement('section')
      panel.className = 'room-screen'
      panel.textContent = 'Waiting for another player to resolve a Relic.'
      element.before(panel)
      try { return element.getBoundingClientRect().top >= panel.getBoundingClientRect().bottom - 1 }
      finally { panel.remove() }
    }), 'a real in-flow panel must retain its clearance')
    assert.deepEqual(errors, [])
    console.log(`PASS ${screen}: map/header adjacency, modal lifecycle, hidden siblings and in-flow clearance`)
    await page.close()
  }
} finally {
  await browser.close()
  await server.close()
}
