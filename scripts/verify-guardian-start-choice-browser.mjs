import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { chromium } from './lib/profile-browser.mjs'
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
      await page.getByRole('group', { name: 'Choose Guardian form for this turn' }).waitFor()
      await page.locator('.card-morph').waitFor({ state: 'hidden' })
    }
    for (const mode of ['attack', 'defense']) {
      await load()
      const choice = page.getByRole('button', { name: `Choose ${mode === 'attack' ? 'Attack' : 'Defense'} Mode` })
      const boxes = await page.getByRole('group', { name: 'Choose Guardian form for this turn' })
        .locator('button').evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().toJSON()))
      for (const box of boxes) {
        assert(box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height)
      }
      assert.equal(await page.locator('.start-turn-order').count(), 0)
      await page.screenshot({ path: `${out}/${name}-${mode}.png` })
      if (name === 'desktop') {
        await choice.focus()
        await page.keyboard.press('Enter')
      } else await choice.tap()
      await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.phase === 'player')
      assert.equal(await page.evaluate(() => window.__STS_DEBUG__.getRun().combat.players[0].guardianMode), mode)
    }
    const party = createRun(909, [
      { id: viewerId, name: 'Guardian One', character: 'guardian' },
      { id: 'guardian-two', name: 'Guardian Two', character: 'guardian' },
    ])
    const partyCombat = createCombat({ seed: 909, calls: 0 }, party.players, [{
      uid: 'party-enemy', defId: 'jaw_worm', row: 0, isBoss: false, hp: 40, maxHp: 40,
      block: 0, strength: 0, vulnerable: 0, weak: 0, poison: 0, goldReward: 0, cardReward: null,
      actionIndex: 0, abilityUsed: false, dead: false,
    }], 'guardian-party-start-choice')
    party.combat = startPlayerTurnWithChoices(partyCombat)
    party.phase = 'combat'; party.neow = null
    await page.evaluate(run => window.__STS_DEBUG__.setRun(run), party)
    await page.getByRole('button', { name: 'Choose Defense Mode' }).click()
    assert.equal(await page.evaluate(() => window.__STS_DEBUG__.getRun().combat.phase), 'start')
    await page.getByRole('button', { name: 'Choose Attack Mode' }).click()
    await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.phase === 'player')
    assert.deepEqual(await page.evaluate(() => window.__STS_DEBUG__.getRun().combat.players.map(player => player.guardianMode)),
      ['defense', 'attack'])
    assert.equal(await page.getByRole('button', { name: /^Resolve start/ }).count(), 0)
    await page.close()
  }
  assert.deepEqual(errors, [])
  console.log('Guardian start choice passed: asset-only choices resolve by keyboard, touch, and final party selection.')
} finally {
  await browser.close()
  await server.close()
}
