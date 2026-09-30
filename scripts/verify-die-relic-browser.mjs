import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { chromium } from './lib/profile-browser.mjs'
import { createServer } from 'vite'
import { createRun } from '../src/game/run.ts'
import { createCombat } from '../src/game/combat.ts'

const out = 'artifacts/die-relic'
mkdirSync(out, { recursive: true })
const server = await createServer({ logLevel: 'silent', server: { port: 0 } })
const browser = await chromium.launch({ headless: true })
const errors = []
try {
  await server.listen()
  for (const [name, width, height] of [['desktop', 1440, 900], ['phone-landscape', 844, 390]]) {
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' })
    page.setDefaultTimeout(10_000)
    page.on('pageerror', error => errors.push(String(error)))
    await page.goto(`http://localhost:${server.httpServer.address().port}`)
    await page.getByRole('button', { name: 'Single Player', exact: true }).click()
    await page.getByRole('button', { name: 'Standard', exact: true }).click()
    await page.getByRole('button', { name: 'Embark' }).click()
    await page.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
    await page.waitForFunction(() => window.__STS_DEBUG__?.getRun()?.phase === 'neow')
    const viewerId = await page.evaluate(() => window.__STS_DEBUG__.getRun().players[0].id)
    const run = createRun(931, [{ id: viewerId, name: 'Ironclad', character: 'ironclad' }])
    const enemy = { uid: 'e0', defId: 'jaw_worm', row: 0, isBoss: false, hp: 30, maxHp: 30,
      block: 0, strength: 0, vulnerable: 0, weak: 0, poison: 0, goldReward: 0, cardReward: null,
      actionIndex: 0, abilityUsed: true, dead: false }
    run.combat = createCombat({ seed: 931, calls: 0 }, run.players, [enemy], `die-relic-${name}`)
    Object.assign(run.combat.players[0], { hand: [], powers: [], potions: [], relics: [
      { defId: 'dollys_mirror', spent: false }, { defId: 'red_mask', spent: false },
      { defId: 'necronomicon', spent: false },
    ] })
    Object.assign(run.combat, { phase: 'start', die: 1, startTurnStage: 'effects',
      startTurnProgress: undefined, pendingTriggers: [], presentationEvents: [] })
    run.phase = 'combat'
    run.neow = null
    await page.evaluate(run => window.__STS_DEBUG__.setRun(run), run)
    const mirror = page.locator('.relic-actions details').filter({ hasText: "Dolly's Mirror" })
    await mirror.locator('summary').click()
    const redMask = mirror.getByRole('button', { name: /Red Mask/ })
    await redMask.waitFor({ state: 'visible' })
    assert.match(await redMask.innerText(), /die 5\/6/, `${name}: the copied ability lost its printed faces`)
    await redMask.scrollIntoViewIfNeeded()
    const bounds = await redMask.boundingBox()
    assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width &&
      bounds.y >= 0 && bounds.y + bounds.height <= height, `${name}: the Red Mask choice is clipped`)
    await page.screenshot({ path: `${out}/${name}-mirror-red-mask.png` })
    await redMask.click()
    await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.players[0].relics[0].spent)
    assert.equal(await page.evaluate(() => window.__STS_DEBUG__.getRun().combat.enemies[0].weak), 1,
      `${name}: selecting Red Mask did not apply Weak`)
    assert.equal(await mirror.count(), 0, `${name}: the spent Mirror still offers choices`)
    await page.close()
  }
  assert.deepEqual(errors, [])
  console.log('✓ Dolly\'s Mirror offers and resolves Red Mask on desktop and horizontal phone')
} finally {
  await browser.close()
  await server.close()
}
