import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { chromium } from './lib/profile-browser.mjs'
import { createServer } from 'vite'
import { createRun } from '../src/game/run.ts'
import { createCombat } from '../src/game/combat.ts'

const out = 'artifacts/taskmaster-target'
const server = await createServer({ logLevel: 'silent', server: { port: 0 } })
const browser = await chromium.launch({ headless: true })
const errors = []

try {
  await server.listen()
  const address = server.httpServer.address()
  if (!address || typeof address === 'string') throw new Error('Vite did not provide a port')
  mkdirSync(out, { recursive: true })
  for (const [name, width, height] of [['desktop', 1440, 900], ['phone-landscape', 844, 390]]) {
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce', hasTouch: name !== 'desktop' })
    page.on('pageerror', (error) => errors.push(String(error)))
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
    await page.goto(`http://localhost:${address.port}`)
    await page.getByRole('button', { name: 'Single Player', exact: true }).click()
    await page.getByRole('button', { name: 'Standard', exact: true }).click()
    await page.getByRole('button', { name: 'Embark' }).click()
    await page.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
    await page.waitForFunction(() => window.__STS_DEBUG__?.getRun()?.phase === 'neow')
    const viewerId = await page.evaluate(() => window.__STS_DEBUG__.getRun().players[0].id)
    const run = createRun(914, [{ id: viewerId, name: 'Watcher', character: 'watcher' }])
    const enemy = (uid, defId, hp, actsLast = false) => ({
      uid, defId, row: 0, isBoss: false, actsLast, hp, maxHp: hp,
      block: 0, strength: 0, vulnerable: 0, weak: 0, poison: 0,
      goldReward: 0, cardReward: null, actionIndex: 0, abilityUsed: false, dead: false,
    })
    run.combat = createCombat({ seed: 914, calls: 0 }, run.players, [
      enemy('blue-slaver', 'blue_slaver', 10),
      enemy('red-slaver', 'red_slaver', 10),
      enemy('taskmaster', 'taskmaster', 13, true),
    ], 'taskmaster-target')
    Object.assign(run.combat.players[0], {
      hand: [{ uid: 'strike', defId: 'strike_watcher', upgraded: false }],
      energy: 3,
    })
    run.phase = 'combat'
    run.neow = null
    await page.evaluate((fixture) => window.__STS_DEBUG__.setRun(fixture), run)
    await page.getByRole('button', { name: /^Strike,/ }).click()
    const redSlaver = page.locator('.enemy[data-enemy-id="red-slaver"]')
    await redSlaver.waitFor()
    const hitTest = await redSlaver.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return hit?.closest('.enemy')?.getAttribute('data-enemy-id')
    })
    assert.equal(hitTest, 'red-slaver', `${name}: the visible Red Slaver must receive its own click`)
    await redSlaver.click()
    await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.players[0].hand.length === 0)
    const hitPoints = await page.evaluate(() => Object.fromEntries(
      window.__STS_DEBUG__.getRun().combat.enemies.map((enemy) => [enemy.uid, enemy.hp]),
    ))
    assert.deepEqual(hitPoints, { 'blue-slaver': 10, 'red-slaver': 9, taskmaster: 13 },
      `${name}: clicking Red Slaver must damage Red Slaver, not Taskmaster`)
    await page.screenshot({ path: `${out}/${name}.png` })
    await page.close()
  }
  assert.deepEqual(errors, [])
  console.log('Taskmaster target audit passed: Red Slaver receives visible hit tests and single-target attacks on desktop and horizontal phone.')
} finally {
  await browser.close()
  await server.close()
}
