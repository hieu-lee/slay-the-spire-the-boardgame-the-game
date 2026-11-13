import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { chromium } from './lib/profile-browser.mjs'
import { createServer } from 'vite'
import { createRun } from '../src/game/run.ts'
import { createCombat } from '../src/game/combat.ts'

mkdirSync('artifacts/choice-backdrop', { recursive: true })
const server = await createServer({ logLevel: 'silent', server: { port: 0 } })
await server.listen()
const browser = await chromium.launch()
try {
  for (const [name, width, height] of [['desktop', 1440, 900], ['horizontal-phone', 844, 390]]) {
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`http://localhost:${server.httpServer.address().port}`)
    for (const name of ['Single Player', 'Standard', 'Embark', 'Start standard campaign']) {
      await page.getByRole('button', { name, exact: true }).click()
    }
    await page.waitForFunction(() => window.__STS_DEBUG__?.getRun()?.phase === 'neow')
    const id = await page.evaluate(() => window.__STS_DEBUG__.getRun().players[0].id)
    const run = createRun(931, [{ id, name: 'Ironclad', character: 'ironclad' }])
    const enemy = { uid: 'e0', defId: 'jaw_worm', row: 0, isBoss: false, hp: 30, maxHp: 30,
      block: 0, strength: 0, vulnerable: 0, weak: 0, poison: 0, goldReward: 0, cardReward: null,
      actionIndex: 0, abilityUsed: true, dead: false }
    run.combat = createCombat({ seed: 931, calls: 0 }, run.players, [enemy], `choice-${name}`)
    run.phase = 'combat'
    run.neow = null
    run.combat.phase = 'player'
    Object.assign(run.combat.players[0], {
      hand: [{ uid: 'warcry', defId: 'warcry', upgraded: false }],
      draw: [{ uid: 'drawn', defId: 'defend_ironclad', upgraded: false }],
      discard: [], relics: [], powers: [], energy: 3,
    })
    await page.evaluate(run => window.__STS_DEBUG__.setRun(run), run)
    await page.getByRole('button', { name: /^Warcry,/ }).click()
    const choice = page.getByRole('dialog', { name: 'Choose 1 for the top of your draw pile', exact: true })
    await choice.waitFor()
    assert(await choice.evaluate(dialog => {
      const style = getComputedStyle(dialog, '::backdrop')
      const alpha = Number(style.backgroundColor.match(/[\d.]+/g)?.at(3) ?? 1)
      const energy = document.querySelector('.pip--energy').getBoundingClientRect()
      const box = dialog.getBoundingClientRect()
      return alpha <= .4 && style.backdropFilter === 'none' && dialog.matches(':modal') &&
        energy.left >= 0 && energy.top >= 0 && energy.right <= innerWidth && energy.bottom <= innerHeight &&
        (energy.right <= box.left || energy.left >= box.right || energy.bottom <= box.top || energy.top >= box.bottom)
    }), `${name}: modal choices must keep the Energy HUD readable`)
    await page.screenshot({ path: `artifacts/choice-backdrop/${name}.png` })
    await choice.locator('.card').click()
    await choice.getByRole('button', { name: 'Put selected card on top', exact: true }).click()
    await choice.waitFor({ state: 'detached' })
    assert.deepEqual(errors, [])
    await page.close()
  }
} finally {
  await browser.close()
  await server.close()
}
