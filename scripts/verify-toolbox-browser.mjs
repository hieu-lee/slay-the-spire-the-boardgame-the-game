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
    const phone = width === 844
    const page = await browser.newPage({ viewport: { width, height }, hasTouch: phone, isMobile: phone, reducedMotion: 'reduce' })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`http://localhost:${server.httpServer.address().port}`)
    const formatting = await page.evaluate(async () => {
      const { relicTooltipText } = await import('/src/ui/RelicChip.tsx')
      const { RELICS } = await import('/src/game/relics.ts')
      return Object.values(RELICS).filter(relic => /^(?:downfall_)?(?:the_abacus|toolbox)$/.test(relic.id))
        .map(relic => ({
          id: relic.id, printed: relic.text,
          invalid: [undefined, 0, 7, 1.5, NaN, Infinity].map(die => relicTooltipText(relic.id, die)),
          faces: [1, 2, 3, 4, 5, 6].map(die => relicTooltipText(relic.id, die)),
        }))
    })
    assert(formatting.length >= 2)
    for (const item of formatting) {
      assert(item.invalid.every(text => text === item.printed), `${item.id}: invalid or absent rolls must retain printed rules`)
      const adjustment = item.id.endsWith('the_abacus') ? 1 : -1
      item.faces.forEach((text, index) => {
        const die = index + 1
        assert(text.includes(`(${die} --> ${((die - 1 + adjustment + 6) % 6) + 1})`))
      })
    }
    const inspect = async control => {
      if (phone) { await page.keyboard.press('Tab'); await control.focus() }
      else await control.hover()
    }
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
    Object.assign(run.combat, { phase: 'start', startTurnStage: 'effects', startTurnProgress: undefined,
      pendingTriggers: [], presentationEvents: [] })
    Object.assign(run.combat.players[0], { powers: [], potions: [] })
    for (const [relicId, name, adjustment, example] of [
      ['toolbox', 'Toolbox', -1, '(1 becomes 6)'],
      ['the_abacus', 'The Abacus', 1, '(6 becomes 1)'],
    ]) {
      const changedDie = die => ((die - 1 + adjustment + 6) % 6) + 1
      run.players[0].relics = [{ defId: relicId, spent: false }]
      run.combat.players[0].relics = run.players[0].relics
      for (const die of [1, 2, 3, 4, 5, 6]) {
        const result = changedDie(die)
        await page.mouse.move(2, 2)
        await page.evaluate(() => document.activeElement?.blur())
        await page.evaluate(run => window.__STS_DEBUG__.setRun(run), { ...run, combat: { ...run.combat, die } })
        const expected = `(${die} --> ${result})`
        const chip = page.locator(`.relic-bar [data-relic="${relicId}"]`)
        await inspect(chip)
        await chip.locator('.relic-tip').waitFor()
        assert((await chip.innerText()).includes(expected))
        assert((await chip.getAttribute('aria-label')).includes(expected))
        await page.keyboard.press('Escape')
        await page.mouse.move(2, 2)
        const action = page.getByRole('button', { name: new RegExp(`^Use ${name}:`) })
        await inspect(action)
        const tip = page.locator('.potion-tip').filter({ hasText: name })
        await tip.waitFor()
        assert((await tip.innerText()).includes(expected))
        if (phone) {
          await action.tap()
          assert.equal(await page.evaluate(() => window.__STS_DEBUG__.getRun().combat.die), die,
            'the first touch must inspect, not consume the relic')
          await action.tap()
        }
        else await action.click()
        await page.waitForFunction(result => window.__STS_DEBUG__.getRun().combat.die === result, result)
        await inspect(chip)
        await chip.locator('.relic-tip').waitFor()
        assert((await chip.innerText()).includes(`(${result} --> ${changedDie(result)})`))
        assert((await chip.innerText()).includes('Face down'))
      }
      await page.evaluate(run => window.__STS_DEBUG__.setRun(run), { ...run, phase: 'map', combat: null })
      const chip = page.locator(`.relic-bar [data-relic="${relicId}"]`)
      await inspect(chip)
      await chip.locator('.relic-tip').waitFor()
      assert((await chip.innerText()).includes(example))
    }
    assert.deepEqual(errors, [])
    console.log(`PASS ${width}x${height}: live Abacus/Toolbox rules, all faces, actual activation and printed-rule fallback`)
    await page.close()
  }
} finally {
  await browser.close()
  await server.close()
}
