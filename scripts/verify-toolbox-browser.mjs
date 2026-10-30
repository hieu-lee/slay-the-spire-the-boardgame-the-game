import assert from 'node:assert/strict'
import { chromium } from './lib/profile-browser.mjs'
import { createServer } from 'vite'
import { createRun } from '../src/game/run.ts'
import { createCombat } from '../src/game/combat.ts'

const server = await createServer({ logLevel: 'silent', server: { port: 0 } })
await server.listen()
const browser = await chromium.launch()
try {
  for (const [width, height] of [[1440, 900], [844, 390]]) {
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
    run.combat = createCombat({ seed: 931, calls: 0 }, run.players, [enemy], `toolbox-${width}`)
    run.phase = 'combat'
    run.neow = null
    run.players[0].relics = [{ defId: 'toolbox', spent: false }]
    Object.assign(run.combat, { phase: 'start', startTurnStage: 'effects', startTurnProgress: undefined,
      pendingTriggers: [], presentationEvents: [] })
    Object.assign(run.combat.players[0], { relics: run.players[0].relics, powers: [], potions: [] })
    for (const [die, result] of [[1, 6], [2, 1], [3, 2], [4, 3], [5, 4], [6, 5]]) {
      await page.mouse.move(2, 2)
      await page.evaluate(run => window.__STS_DEBUG__.setRun(run), { ...run, combat: { ...run.combat, die } })
      const expected = `(${die} --> ${result})`
      const chip = page.locator('.relic-bar [data-relic="toolbox"]')
      await chip.hover()
      await chip.locator('.relic-tip').waitFor()
      assert((await chip.innerText()).includes(expected))
      assert((await chip.getAttribute('aria-label')).includes(expected))
      await page.keyboard.press('Escape')
      await page.mouse.move(2, 2)
      const action = page.getByRole('button', { name: /^Use Toolbox:/ })
      await action.hover()
      const tip = page.locator('.potion-tip').filter({ hasText: 'Toolbox' })
      await tip.waitFor()
      assert((await tip.innerText()).includes(expected))
      await action.click()
      await page.waitForFunction(result => window.__STS_DEBUG__.getRun().combat.die === result, result)
      await chip.hover()
      await chip.locator('.relic-tip').waitFor()
      assert((await chip.innerText()).includes(`(${result} --> ${result === 1 ? 6 : result - 1})`))
      assert((await chip.innerText()).includes('Face down'))
    }
    await page.evaluate(run => window.__STS_DEBUG__.setRun(run), { ...run, phase: 'map', combat: null })
    const chip = page.locator('.relic-bar [data-relic="toolbox"]')
    await chip.hover()
    await chip.locator('.relic-tip').waitFor()
    assert((await chip.innerText()).includes('(1 becomes 6)'))
    assert.deepEqual(errors, [])
    await page.close()
  }
} finally {
  await browser.close()
  await server.close()
}
