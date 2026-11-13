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
    const page = await browser.newPage({ viewport, hasTouch: phone, isMobile: phone })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`)
    for (const name of ['Single Player', 'Standard', 'Embark', 'Start standard campaign']) {
      await page.getByRole('button', { name, exact: true }).click()
    }
    await page.waitForFunction(() => window.__STS_DEBUG__?.getRun().phase === 'neow')
    await page.evaluate(() => {
      const run = structuredClone(window.__STS_DEBUG__.getRun())
      run.phase = 'map'
      run.neow = null
      run.players[0].potions = ['distilled_chaos', 'fire_potion']
      window.__STS_DEBUG__.setRun(run)
    })
    const belt = page.locator('.outside-potions')
    await belt.waitFor()
    assert.equal(await belt.locator('.outside-potions__give').count(), 0, 'solo Give controls should be absent')
    assert.deepEqual(await page.evaluate(() => window.__STS_DEBUG__.getRun().players[0].potions),
      ['distilled_chaos', 'fire_potion'], 'hiding Give must not remove held potions')
    await page.evaluate(() => {
      const run = structuredClone(window.__STS_DEBUG__.getRun())
      run.players.push({ ...structuredClone(run.players[0]), id: 'recipient', name: 'Teammate', row: 1, potions: [] })
      window.__STS_DEBUG__.setRun(run)
    })
    await belt.getByRole('button', { name: 'Give Distilled Chaos', exact: true }).click()
    await belt.getByRole('button', { name: 'Give to Teammate', exact: true }).click()
    await page.waitForFunction(() => window.__STS_DEBUG__.getRun().players[1].potions.includes('distilled_chaos'))
    assert.deepEqual(await page.evaluate(() => window.__STS_DEBUG__.getRun().players[0].potions), ['fire_potion'])
    await page.evaluate(() => {
      const run = structuredClone(window.__STS_DEBUG__.getRun())
      run.players = [run.players[0]]
      window.__STS_DEBUG__.setRun(run)
    })
    await page.waitForFunction(() => document.querySelectorAll('.outside-potions__give').length === 0)
    assert.deepEqual(errors, [])
    await page.close()
    console.log(`PASS ${screen}: solo controls hidden and party trading preserved`)
  }
} finally {
  await browser.close()
  await server.close()
}
