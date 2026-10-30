import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { chromium } from './lib/profile-browser.mjs'
import { postNeowRun } from './lib/post-neow-run.mjs'
import { EVENT_DEFINITIONS } from '../src/game/events.ts'
import { createEventRoom } from '../src/game/event-room.ts'

const server = await createServer({ logLevel: 'silent', server: { port: 0 } })
await server.listen()
const browser = await chromium.launch()
try {
  for (const [screen, viewport] of [
    ['desktop', { width: 1440, height: 900 }],
    ['horizontal-phone', { width: 844, height: 390 }],
  ]) {
    const page = await browser.newPage({ viewport })
    await page.goto(`http://localhost:${server.httpServer.address().port}`)
    for (const name of ['Single Player', 'Standard', 'Embark', 'Start standard campaign']) {
      await page.getByRole('button', { name, exact: true }).click()
    }
    await page.waitForFunction(() => window.__STS_DEBUG__?.getRun().phase === 'neow')
    for (const count of [2, 1]) {
      const run = postNeowRun(47, [
        { id: 'p1', name: 'Ironclad', character: 'ironclad' },
        { id: 'p2', name: 'Silent', character: 'silent' },
      ].slice(0, count))
      run.phase = 'room'
      run.map.position = run.map.rows[0][0]
      run.map.rooms[run.map.position].kind = 'event'
      run.roomState = createEventRoom({ ...EVENT_DEFINITIONS.face_trader,
        instanceId: `face-trader-${screen}-${count}`, act: 3, minAscension: 0, requiresColorlessUnlock: false })
      await page.evaluate(run => window.__STS_DEBUG__.setRun(run), run)
      const exchange = page.locator('[data-event-option="exchange"]')
      await exchange.waitFor()
      assert.equal(await exchange.locator('strong').innerText(), count === 1 ? '[Leave]' : '[Exchange]')
      assert.equal(await exchange.locator('span').innerText(), count === 1
        ? 'No other player to exchange with.'
        : 'Give one of your Relics to a player. Then they give a Relic to you.')
      assert(await exchange.isEnabled())
      await exchange.click()
      if (count === 1) {
        await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'map')
        assert.deepEqual(await page.evaluate(() => window.__STS_DEBUG__.getRun().players[0].relics), run.players[0].relics)
      } else {
        await page.locator('.event-panel--resolver').waitFor()
        assert.deepEqual(await page.evaluate(() => window.__STS_DEBUG__.getRun().players.map(player => player.relics)),
          run.players.map(player => player.relics), 'opening Exchange must not trade without confirmation')
      }
    }
    await page.close()
    console.log(`PASS ${screen}: solo Leave preserves inventory and party Exchange stays available`)
  }
} finally {
  await browser.close()
  await server.close()
}
