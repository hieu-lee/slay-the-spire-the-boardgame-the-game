import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import { createRun } from '../src/game/run.ts'
import { createCombat } from '../src/game/combat.ts'

const out = 'artifacts/downfall-card-audit'
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
    await page.getByRole('button', { name: 'Start Downfall campaign', exact: true }).click()
    await page.waitForFunction(() => window.__STS_DEBUG__?.getRun()?.phase === 'neow')
    const viewerId = await page.evaluate(() => window.__STS_DEBUG__.getRun().players[0].id)
    async function load(id, upgraded = false, handCurse = false) {
      const character = id === 'forked_flame' ? 'hexaghost' : 'hermit'
      const run = createRun(908, [
        { id: viewerId, name: character, character },
        { id: 'ally', name: 'Ally', character: 'ironclad' },
      ])
      const enemy = { uid: 'e0', defId: 'jaw_worm', row: 0, isBoss: false, hp: 40, maxHp: 40,
        block: 0, strength: 0, vulnerable: 0, weak: 0, poison: 0, goldReward: 0, cardReward: null,
        actionIndex: 0, abilityUsed: false, dead: false }
      run.combat = createCombat({ seed: 908, calls: 0 }, run.players, [enemy, { ...enemy, uid: 'e1' }], 'audit')
      run.combat.pendingHermitSetupLoads = []
      const card = { uid: 'card', defId: id, upgraded }
      Object.assign(run.combat.players[0], { hand: character === 'hermit'
        ? handCurse ? [{ uid: 'curse', defId: 'hermit_scorn', upgraded: false }] : [] : [card],
        chamber: [], powers: character === 'hermit' ? [card] : [], energy: 3 })
      run.phase = 'combat'
      run.neow = null
      await page.evaluate(run => window.__STS_DEBUG__.setRun(run), run)
      await page.waitForTimeout(1200)
      await page.locator('.card-morph').waitFor({ state: 'hidden' })
    }
    for (const upgraded of [false, true]) {
      await load('hermit_shadow_cloak', upgraded, true)
      await page.screenshot({ path: `${out}/${name}-before-shadow.png` })
      await page.getByRole('button', { name: /^Use Shadow Cloak\+?$/ }).click()
      await page.getByRole('button', { name: 'Discard Scorn', exact: true }).waitFor()
      await page.screenshot({ path: `${out}/${name}-shadow${upgraded ? '-upgraded' : ''}.png` })
      await page.getByRole('button', { name: 'Discard Scorn', exact: true }).click()
      await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.players[0].hand.length === 0)
      assert.equal(await page.evaluate(() => window.__STS_DEBUG__.getRun().combat.players[0].block), upgraded ? 3 : 2)
      await load('forked_flame', upgraded)
      await page.getByRole('button', { name: /^Forked Flame\+?,/ }).click()
      await page.getByRole('button', { name: 'Three hits', exact: true }).click()
      await page.screenshot({ path: `${out}/${name}-forked${upgraded ? '-upgraded' : ''}.png` })
      await page.locator('.enemy:not(.enemy--dead)').first().click()
      await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.players[0].hand.length === 0)
      assert.deepEqual(await page.evaluate(() => window.__STS_DEBUG__.getRun().combat.enemies.map(e => e.hp)).then(hp => hp.sort()), [upgraded ? 34 : 37, 40])
    }
    await load('hermit_shadow_cloak')
    assert(await page.getByRole('button', { name: /^Use Shadow Cloak\+?$/ }).isDisabled())
    await page.close()
  }
  assert.deepEqual(errors, [])
  console.log('Downfall browser audit passed: base/upgraded Shadow Cloak and Forked Flame on desktop and horizontal phone.')
} finally {
  await browser.close()
  await server.close()
}
