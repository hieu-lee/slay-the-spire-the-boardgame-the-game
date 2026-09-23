import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'vite'
import { chromium } from './lib/profile-browser.mjs'
import { createRun } from '../src/game/run.ts'
import { createCombat } from '../src/game/combat.ts'

const output = 'artifacts/slippery-browser'
mkdirSync(output, { recursive: true })
const server = await createServer({ logLevel: 'silent', server: { port: 0 } })
const browser = await chromium.launch({ headless: true })
const receipts = []
try {
  await server.listen()
  for (const [screen, width, height] of [['desktop', 1440, 900], ['horizontal-phone', 844, 390]]) {
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' })
    const errors = []
    page.on('pageerror', error => errors.push(String(error)))
    await page.goto(`http://localhost:${server.httpServer.address().port}`)
    for (const name of ['Single Player', 'Standard', 'Embark', 'Start standard campaign']) {
      await page.getByRole('button', { name, exact: true }).click()
    }
    await page.waitForFunction(() => window.__STS_DEBUG__?.getRun()?.phase === 'neow')
    const viewerId = await page.evaluate(() => window.__STS_DEBUG__.getRun().players[0].id)
    const load = async (cards) => {
      const run = createRun(721, [{ id: viewerId, name: 'Slime Boss', character: 'slime_boss' }])
      const enemy = { uid: 'target', defId: 'jaw_worm', row: 0, isBoss: false, hp: 40, maxHp: 40,
        block: 0, strength: 0, vulnerable: 0, weak: 0, poison: 0, goldReward: 0, cardReward: null,
        actionIndex: 0, abilityUsed: false, dead: false }
      run.combat = createCombat({ seed: 721, calls: 0 }, run.players, [enemy], 'slippery-browser')
      run.combat.players[0].hand = cards.map((defId, index) => ({ uid: `slippery-${index}`, defId, upgraded: false }))
      run.combat.players[0].energy = 4
      run.phase = 'combat'
      run.neow = null
      await page.evaluate(run => window.__STS_DEBUG__.setRun(run), run)
      await page.waitForFunction(count => window.__STS_DEBUG__.getRun().combat?.players[0].hand.length === count, cards.length)
    }
    const play = async (name, remaining) => {
      await page.getByRole('button', { name: new RegExp(`^${name},`) }).first().click()
      await page.waitForFunction(count => window.__STS_DEBUG__.getRun().combat.players[0].hand.length === count, remaining)
    }
    const slippery = page.getByRole('button', { name: /^Slippery,/ })
    await load(['slime_boss_defend', 'slime_boss_defend', 'slime_boss_slippery'])
    await play('Defend', 2)
    await play('Defend', 1)
    const paidLabel = await slippery.getAttribute('aria-label')
    assert.match(paidLabel, /cost 2/, `${screen}: two one-cost cards must not discount Slippery`)
    await page.screenshot({ path: `${output}/${screen}-two-one-cost-cards.png` })
    await play('Slippery', 0)
    const paidEnergy = await page.evaluate(() => window.__STS_DEBUG__.getRun().combat.players[0].energy)
    assert.equal(paidEnergy, 0)

    await load(['slime_boss_living_wall', 'slime_boss_slippery'])
    await play('Living Wall', 1)
    const freeLabel = await slippery.getAttribute('aria-label')
    assert.match(freeLabel, /cost 0/, `${screen}: one two-cost card discounts Slippery`)
    await page.screenshot({ path: `${output}/${screen}-one-two-cost-card.png` })
    await play('Slippery', 0)
    const freeEnergy = await page.evaluate(() => window.__STS_DEBUG__.getRun().combat.players[0].energy)
    assert.equal(freeEnergy, 2)
    receipts.push({ screen, twoOneCostCards: { renderedCost: paidLabel, energyAfterSlippery: paidEnergy },
      oneTwoCostCard: { renderedCost: freeLabel, energyAfterSlippery: freeEnergy } })
    assert.deepEqual(errors, [])
    await page.close()
  }
  writeFileSync(`${output}/results.json`, `${JSON.stringify(receipts, null, 2)}\n`)
  console.log(`Slippery browser check passed; screenshots in ${output}`)
} finally {
  await browser.close()
  await server.close()
}
