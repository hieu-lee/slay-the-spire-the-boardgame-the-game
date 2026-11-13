import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { chromium } from './lib/profile-browser.mjs'
import { postNeowRun } from './lib/post-neow-run.mjs'
import { enterRoom } from '../src/game/run.ts'

const server = await createServer({ logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } })
await server.listen()
const browser = await chromium.launch()
try {
  for (const [screen, viewport] of [
    ['desktop', { width: 1440, height: 900 }],
    ['horizontal-phone', { width: 844, height: 390 }],
  ]) {
    const page = await browser.newPage({ viewport })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`)
    for (const name of ['Single Player', 'Standard', 'Embark', 'Start standard campaign']) {
      await page.getByRole('button', { name, exact: true }).click()
    }
    await page.waitForFunction(() => window.__STS_DEBUG__?.getRun().phase === 'neow')
    const run = postNeowRun(47, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
    const room = run.map.rows[0][0]
    run.map.rooms[room].kind = 'encounter'
    const next = enterRoom(run, room)
    Object.assign(next.combat.players[0], {
      relics: [{ defId: 'runic_pyramid', spent: false }],
      hand: Array.from({ length: 8 }, (_, index) =>
        ({ uid: `choose-${index}`, defId: 'defend_ironclad', upgraded: false })),
      draw: Array.from({ length: 6 }, (_, index) =>
        ({ uid: `draw-${index}`, defId: 'strike_ironclad', upgraded: false })),
      discard: [],
    })
    await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), next)
    const panel = page.locator('.relic-actions details').filter({ hasText: 'Runic Pyramid' })
    await panel.locator('summary').waitFor()
    const before = await page.evaluate(() => JSON.stringify(window.__STS_DEBUG__.getRun()))
    await panel.locator('summary').click()
    assert(await panel.getByRole('button', { name: 'Retain 0 cards', exact: true }).isDisabled())
    await panel.locator('.card').first().click()
    await panel.locator('summary').click()
    assert.equal(await page.evaluate(() => JSON.stringify(window.__STS_DEBUG__.getRun())), before,
      'opening or closing the picker must not spend the relic')
    await panel.locator('summary').click()
    await panel.locator('.card').last().click()
    const confirm = panel.getByRole('button', { name: 'Retain 2 cards', exact: true })
    await confirm.scrollIntoViewIfNeeded()
    assert(await confirm.evaluate((button) => {
      const box = button.getBoundingClientRect()
      return box.top >= 0 && box.bottom <= innerHeight &&
        button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
    }), `${screen}: the retain confirmation is clipped or covered`)
    assert.equal(await page.evaluate(() => JSON.stringify(window.__STS_DEBUG__.getRun())), before,
      'selecting cards must not activate the relic before confirmation')
    await confirm.click()
    await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.players[0].relics[0].spent)
    assert.deepEqual(await page.evaluate(() => window.__STS_DEBUG__.getRun().combat.players[0].hand
      .filter((card) => card.retainThisTurn).map((card) => card.uid)), ['choose-0', 'choose-7'])
    assert.equal(await panel.count(), 0, 'a spent Runic Pyramid must not be usable again')
    const turn = next.combat.turn
    await page.getByRole('button', { name: 'End turn', exact: true }).click()
    await page.waitForFunction((turn) => window.__STS_DEBUG__.getRun().combat.turn > turn, turn)
    const actor = await page.evaluate(() => window.__STS_DEBUG__.getRun().combat.players[0])
    assert.deepEqual(actor.hand.filter((card) => card.uid.startsWith('choose-')).map((card) => card.uid),
      ['choose-0', 'choose-7'], 'only the chosen cards should survive the end-of-turn discard')
    assert.equal(await page.locator('.retain-options').count(), 0, 'Runic Pyramid must not ask for the same choices twice')
    assert.deepEqual(errors, [])
    console.log(`PASS ${screen}: Runic Pyramid selection, safe confirmation and actual retention`)
    await page.close()
  }
} finally {
  await browser.close()
  await server.close()
}
