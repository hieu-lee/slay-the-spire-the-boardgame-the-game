import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import { createRun } from '../src/game/run.ts'
import { createCombat } from '../src/game/combat.ts'

const out = 'artifacts/original-card-audit'
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
    await page.waitForFunction(() => window.__STS_DEBUG__?.getRun()?.phase === 'neow')
    const viewerId = await page.evaluate(() => window.__STS_DEBUG__.getRun().players[0].id)
    for (const id of ['reinforced_body', 'tantrum']) for (const upgraded of [false, true]) {
      const character = id === 'tantrum' ? 'watcher' : 'defect'
      const run = createRun(913, [{ id: viewerId, name: 'Hero', character }, { id: 'ally', name: 'Ally', character: 'ironclad' }])
      const enemies = [0, 1].map(i => ({ uid: `e${i}`, defId: 'jaw_worm', row: i, isBoss: false,
        hp: 100, maxHp: 100, block: 0, strength: 0, vulnerable: 0, weak: 0, poison: 0,
        goldReward: 0, cardReward: null, actionIndex: 0, abilityUsed: false, dead: false }))
      run.combat = createCombat({ seed: 913, calls: 0 }, run.players, enemies, `original-${id}-${upgraded}`)
      Object.assign(run.combat.players[0], { hand: [{ uid: 'card', defId: id, upgraded },
        { uid: 'spare', defId: `strike_${character}`, upgraded: false }], energy: 3, strength: 1, cardBlockBonus: 1 })
      run.phase = 'combat'; run.neow = null
      await page.evaluate(run => window.__STS_DEBUG__.setRun(run), run)
      await page.waitForTimeout(1200)
      const card = page.getByRole('button', { name: id === 'tantrum' ? /^Tantrum/ : /^Reinforced Body/ })
      if (name === 'desktop') { await card.focus(); await page.keyboard.press('Enter') }
      else await card.tap()
      if (id === 'reinforced_body') {
        await page.getByText(/Choose Energy for Reinforced Body/).waitFor()
        await page.screenshot({ path: `${out}/${name}-${id}-${upgraded}-choice.png` })
        await page.getByRole('button', { name: 'Spend 2', exact: true }).click()
      } else {
        await page.locator('.enemy--targeted[data-enemy-id="e0"]').waitFor()
        await page.screenshot({ path: `${out}/${name}-${id}-${upgraded}-choice.png` })
        await page.locator('.enemy--targeted[data-enemy-id="e0"]').click()
      }
      await page.waitForFunction(() => !window.__STS_DEBUG__.getRun().combat.players[0].hand.some(c => c.uid === 'card'))
      const result = await page.evaluate(() => window.__STS_DEBUG__.getRun().combat)
      if (id === 'reinforced_body') assert.deepEqual(result.players.map(p => p.block), [upgraded ? 6 : 4, 0])
      else {
        assert.deepEqual(result.enemies.map(e => e.hp), [upgraded ? 96 : 97, 100])
        assert.equal(result.players[0].stance, 'wrath')
      }
      assert.equal(await page.locator('.seat--targetable, .enemy--targeted').count(), 0)
      await page.waitForTimeout(1200)
      await page.screenshot({ path: `${out}/${name}-${id}-${upgraded}-resolved.png` })
    }
    await page.close()
  }
  assert.deepEqual(errors, [])
  console.log('Original card UI passed: Reinforced Body self Block and single-target Tantrum, both faces, desktop keyboard and landscape touch.')
} finally { await browser.close(); await server.close() }
