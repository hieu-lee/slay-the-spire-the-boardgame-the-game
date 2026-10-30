import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { createServer } from 'vite'
import { chromium } from './lib/profile-browser.mjs'
import { postNeowRun } from './lib/post-neow-run.mjs'
import { enterRoom } from '../src/game/run.ts'

const output = 'artifacts/relic-refresh'
mkdirSync(output, { recursive: true })
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
    const run = postNeowRun(47, [{ id: 'p1', name: 'Watcher', character: 'watcher' }])
    const room = run.map.rows[0][0]
    run.map.rooms[room].kind = 'encounter'
    const fight = enterRoom(run, room)
    Object.assign(fight.combat, { phase: 'player', pendingTriggers: [], startTurnProgress: undefined })
    fight.combat.players[0].relics = [
      ...['golden_eye', 'blue_candle', 'runic_pyramid'].map(defId => ({ defId, spent: true })),
      { defId: 'holy_water', spent: false, cubes: 0 },
      { defId: 'gambling_chip', spent: true },
      { defId: 'wing_boots', spent: false, uses: 1 },
    ]
    await page.evaluate(run => window.__STS_DEBUG__.setRun(run), fight)
    const chip = id => page.locator(`.app-shell__header .relic-chip[data-relic="${id}"]`)
    await chip('golden_eye').waitFor()
    assert.match(await chip('golden_eye').getAttribute('aria-label'), /Face down/)
    await page.reload()
    await page.getByRole('button', { name: 'Resume', exact: true }).click()
    await chip('golden_eye').waitFor()
    assert.match(await chip('golden_eye').getAttribute('aria-label'), /Face down/,
      'resuming an active combat must not refresh its spent relics')
    assert.equal(await page.evaluate(() => window.__STS_DEBUG__.getRun().combat.players[0].relics
      .find(relic => relic.defId === 'holy_water').cubes), 0)
    await page.evaluate(() => {
      const run = structuredClone(window.__STS_DEBUG__.getRun())
      run.combat.phase = 'won'
      run.combat.enemies.forEach(enemy => { enemy.dead = true; enemy.hp = 0 })
      window.__STS_DEBUG__.setRun(run)
    })
    await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat === null)
    for (const id of ['golden_eye', 'blue_candle', 'runic_pyramid']) {
      assert.doesNotMatch(await chip(id).getAttribute('aria-label'), /Face down/)
      assert(!(await chip(id).getAttribute('class')).includes('relic-chip--spent'))
    }
    assert.match(await chip('gambling_chip').getAttribute('aria-label'), /Face down/)
    assert.equal(await page.evaluate(() => window.__STS_DEBUG__.getRun().players[0].relics
      .find(relic => relic.defId === 'holy_water').cubes), 2)
    await page.evaluate(async () => {
      const { EVENT_DEFINITIONS } = await import('/src/game/events.ts')
      const { createEventRoom } = await import('/src/game/event-room.ts')
      const run = structuredClone(window.__STS_DEBUG__.getRun())
      run.phase = 'room'
      run.act = 2
      run.rewards = []
      run.rewardDestination = null
      run.map.rooms[run.map.position].kind = 'event'
      run.roomState = createEventRoom({ ...EVENT_DEFINITIONS.we_meet_again,
        instanceId: 'refresh-event', act: 2, minAscension: 0, requiresColorlessUnlock: false })
      // Reproduce an event saved by the old end-of-combat cleanup.
      run.players[0].relics.find(relic => relic.defId === 'golden_eye').spent = true
      run.players[0].relics.find(relic => relic.defId === 'holy_water').cubes = 0
      window.__STS_DEBUG__.setRun(run)
    })
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('sts-solo-run')).run.roomState?.card.instanceId === 'refresh-event')
    await page.reload()
    await page.getByRole('button', { name: 'Resume', exact: true }).click()
    await page.getByRole('heading', { name: 'We Meet Again!', exact: true }).waitFor()
    assert.doesNotMatch(await chip('golden_eye').getAttribute('aria-label'), /Face down/)
    assert.match(await chip('gambling_chip').getAttribute('aria-label'), /Face down/)
    assert.match(await chip('wing_boots').getAttribute('aria-label'), /1 use remaining/)
    const state = await page.evaluate(() => window.__STS_DEBUG__.getRun())
    assert.equal(state.players[0].relics.find(relic => relic.defId === 'holy_water').cubes, 2)
    if (phone) await chip('golden_eye').tap()
    else await chip('golden_eye').hover()
    const tip = chip('golden_eye').locator('.relic-tip')
    await tip.waitFor()
    assert.match(await tip.innerText(), /Once per combat: Scry 3/)
    assert.doesNotMatch(await tip.innerText(), /Face down/)
    await page.screenshot({ path: `${output}/${screen}-event.png` })
    assert.deepEqual(errors, [])
    await page.close()
    console.log(`PASS ${screen}: end-of-combat relic refresh and legacy event resume`)
  }
} finally {
  await browser.close()
  await server.close()
}
