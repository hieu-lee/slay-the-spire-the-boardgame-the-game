import { strict as assert } from 'node:assert'
import { mkdirSync } from 'node:fs'
import { createServer } from 'vite'
import { chromium } from './lib/profile-browser.mjs'
import { CARDS } from '../src/game/cards.ts'
import { HEARTS_BOON_CARDS } from '../src/game/neow.ts'
import { createRun, chooseNeow, resolveNeowReward, revealNeowReward } from '../src/game/run.ts'

let run = createRun(8123, [{ id: 'p1', name: 'Guardian', character: 'guardian' }])
while (run.neow.players.p1.redRewardPending) run = resolveNeowReward(run, 'p1', null)
const boon = HEARTS_BOON_CARDS.find(card => card.options.some(option => option.effects.some(effect => effect.look === 5)))
run.neow.players.p1.cardId = boon.id
run.players[0].cardRewards.unshift('guardian_crystal_edge')
run = chooseNeow(run, 'p1', boon.options.findIndex(option => option.effects.some(effect => effect.look === 5)))
run = revealNeowReward(run, 'p1')
run = resolveNeowReward(run, 'p1', run.neow.players.p1.reward.choices.findIndex(id => CARDS[id]?.guardian?.socket))
const pending = run.pendingGuardianSockets[0]
assert(pending)
const server = await createServer({ logLevel: 'silent', server: { port: 0 } })
await server.listen()
const browser = await chromium.launch()
mkdirSync('artifacts/boon-socket', { recursive: true })
try {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 844, height: 390 }]) {
    const page = await browser.newPage({ viewport, ...(viewport.width === 844 ? { isMobile: true, hasTouch: true } : {}) })
    const errors = []
    page.on('pageerror', error => errors.push(String(error)))
    await page.goto(`http://localhost:${server.httpServer.address().port}`)
    await page.getByRole('button', { name: 'Single Player', exact: true }).click()
    await page.getByRole('button', { name: 'Standard', exact: true }).click()
    await page.getByRole('button', { name: 'Embark' }).click()
    await page.getByRole('button', { name: 'Start Downfall campaign', exact: true }).click()
    await page.evaluate(run => window.__STS_DEBUG__.setRun(run), run)
    await page.getByRole('heading', { name: 'Choose a Gem', exact: true }).waitFor()
    await page.waitForTimeout(500)
    await page.screenshot({ path: `artifacts/boon-socket/gem-${viewport.width}.png` })
    await page.getByRole('button', { name: new RegExp(`^${CARDS[pending.gemIds[0]].name},`) }).click()
    await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'map')
    await page.locator('.card-morph').waitFor({ state: 'hidden' })
    await page.locator('.room--reachable').first().click({ trial: true })
    await page.screenshot({ path: `artifacts/boon-socket/map-${viewport.width}.png` })
    const finished = await page.evaluate(() => window.__STS_DEBUG__.getRun())
    assert.equal(finished.players[0].hp, run.players[0].hp - 1)
    const stuck = structuredClone(run)
    stuck.players[0].deck = finished.players[0].deck
    stuck.pendingGuardianSockets = []
    await page.evaluate(stuck => {
      const saved = JSON.parse(localStorage.getItem('sts-solo-run'))
      saved.run = stuck
      localStorage.setItem('sts-solo-run', JSON.stringify(saved))
    }, stuck)
    await page.reload()
    await page.getByRole('button', { name: 'Resume', exact: true }).click()
    await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'map')
    assert.deepEqual(errors, [])
    console.log(`Boon Socket and stuck-save recovery passed: ${viewport.width}x${viewport.height}`)
    await page.close()
  }
} finally {
  await browser.close()
  await server.close()
}
