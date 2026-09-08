import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import { createRun } from '../src/game/run.ts'
import { createCombat, startPlayerTurnWithChoices } from '../src/game/combat.ts'

const out = 'artifacts/guardian-start-choice'
mkdirSync(out, { recursive: true })
const server = await createServer({ logLevel: 'silent', server: { port: 0 } })
const browser = await chromium.launch({ headless: true })
const errors = []
try {
  await server.listen()
  for (const [name, width, height] of [['desktop', 1440, 900], ['phone-landscape', 844, 390]]) {
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce', hasTouch: name !== 'desktop' })
    page.on('pageerror', e => errors.push(String(e)))
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
    await page.goto(`http://localhost:${server.httpServer.address().port}`)
    await page.getByRole('button', { name: 'Single Player', exact: true }).click()
    await page.getByRole('button', { name: 'Standard', exact: true }).click()
    await page.getByRole('button', { name: 'Embark' }).click()
    await page.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
    await page.waitForFunction(() => window.__STS_DEBUG__?.getRun()?.phase === 'neow')
    const viewerId = await page.evaluate(() => window.__STS_DEBUG__.getRun().players[0].id)
    async function load() {
      const run = createRun(908, [{ id: viewerId, name: 'Guardian', character: 'guardian' }])
      const enemy = { uid: 'e0', defId: 'jaw_worm', row: 0, isBoss: false, hp: 40, maxHp: 40,
        block: 0, strength: 0, vulnerable: 0, weak: 0, poison: 0, goldReward: 0, cardReward: null,
        actionIndex: 0, abilityUsed: false, dead: false }
      const combat = createCombat({ seed: 908, calls: 0 }, run.players, [enemy], 'guardian-start-choice')
      combat.players[0].guardianMode = 'attack'
      run.combat = startPlayerTurnWithChoices(combat)
      run.phase = 'combat'
      run.neow = null
      await page.evaluate(run => window.__STS_DEBUG__.setRun(run), run)
      await page.getByRole('button', { name: 'Stay in current Mode', exact: true }).waitFor()
      await page.locator('.card-morph').waitFor({ state: 'hidden' })
    }
    for (const shift of [false, true]) {
      await load()
      const order = page.locator('.start-turn-order')
      await order.locator('summary').click()
      const stay = page.getByRole('button', { name: 'Stay in current Mode', exact: true })
      const change = page.getByRole('button', { name: 'Mode Shift', exact: true })
      const boxes = await Promise.all([stay.boundingBox(), change.boundingBox(), order.boundingBox(), order.locator('ol').boundingBox()])
      for (const choice of boxes.slice(0, 2)) {
        assert(choice && choice.x >= 0 && choice.y >= 0 && choice.x + choice.width <= width && choice.y + choice.height <= height)
        for (const panel of boxes.slice(2)) assert(panel &&
          (choice.x + choice.width <= panel.x || panel.x + panel.width <= choice.x ||
           choice.y + choice.height <= panel.y || panel.y + panel.height <= choice.y), 'Mode choice overlaps start-of-turn order')
      }
      await page.screenshot({ path: `${out}/${name}-${shift ? 'shift' : 'stay'}.png` })
      if (name === 'desktop') {
        await (shift ? change : stay).focus()
        await page.keyboard.press('Enter')
      } else await (shift ? change : stay).tap()
      await page.getByRole('button', { name: /^Resolve start/ }).click()
      await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.phase === 'player')
      assert.equal(await page.evaluate(() => window.__STS_DEBUG__.getRun().combat.players[0].guardianMode), shift ? 'defense' : 'attack')
    }
    await page.close()
  }
  assert.deepEqual(errors, [])
  console.log('Guardian start choice passed: no order overlap; keyboard and touch Stay/Shift on desktop and horizontal phone.')
} finally {
  await browser.close()
  await server.close()
}
