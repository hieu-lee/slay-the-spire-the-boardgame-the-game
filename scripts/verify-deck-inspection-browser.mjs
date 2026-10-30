import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { createServer } from 'vite'
import { chromium } from './lib/profile-browser.mjs'

const output = 'artifacts/deck-inspection'
mkdirSync(output, { recursive: true })
const server = await createServer({ logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } })
await server.listen()
const browser = await chromium.launch()
try {
  for (const [screen, viewport, phone] of [
    ['desktop', { width: 1440, height: 900 }, false],
    ['horizontal-phone', { width: 844, height: 390 }, true],
  ]) {
    const page = await browser.newPage({ viewport, hasTouch: phone, isMobile: phone, reducedMotion: 'reduce' })
    page.setDefaultTimeout(10_000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`)
    for (const name of ['Single Player', 'Standard', 'Embark', 'Start standard campaign']) {
      await page.getByRole('button', { name, exact: true }).click()
    }
    await page.waitForFunction(() => window.__STS_DEBUG__?.getRun().phase === 'neow')
    await page.evaluate(() => {
      const run = structuredClone(window.__STS_DEBUG__.getRun())
      run.phase = 'map'
      run.neow = null
      run.players[0].deck = [
        { uid: 'bash', defId: 'bash', upgraded: false },
        { uid: 'defend-plus', defId: 'defend_ironclad', upgraded: true },
        { uid: 'defend', defId: 'defend_ironclad', upgraded: false },
        { uid: 'regret', defId: 'regret', upgraded: false },
      ]
      window.__STS_DEBUG__.setRun(run)
    })
    const activate = locator => phone ? locator.tap() : locator.click()
    await activate(page.getByRole('button', { name: /^Current deck,/ }))
    const deck = page.getByRole('dialog', { name: 'Current deck', exact: true })
    await deck.waitFor()
    const original = await page.evaluate(() => JSON.stringify(window.__STS_DEBUG__.getRun()))
    const grid = deck.locator('.choice-modal__cards')
    const inspection = page.locator('.card-inspection')
    const preview = inspection.locator('.card-inspection__card')
    const checkbox = inspection.getByRole('checkbox', { name: 'View Upgrades', exact: true })
    const previous = inspection.getByRole('button', { name: 'Previous card' })
    const next = inspection.getByRole('button', { name: 'Next card' })
    const bash = grid.locator('.card[title="Bash"]')
    await activate(bash)
    await inspection.waitFor()
    assert.equal(await previous.count(), 0, 'the first card must not offer wraparound navigation')
    assert.equal(await checkbox.isChecked(), false)
    const baseArt = await preview.locator('img.card__art').getAttribute('src')
    await checkbox.check()
    await preview.locator('img.card__art').evaluate(image => image.decode())
    assert.equal(await preview.getAttribute('title'), 'Bash+')
    assert.notEqual(await preview.locator('img.card__art').getAttribute('src'), baseArt)
    assert(await inspection.getByRole('complementary', { name: 'Card keywords' }).isVisible())
    assert(await inspection.evaluate(element => {
      const card = element.querySelector('.card-inspection__card').getBoundingClientRect()
      const controls = [...element.querySelectorAll('input, button')].filter(control =>
        getComputedStyle(control).visibility !== 'hidden')
      return element.matches(':modal') && card.left >= 0 && card.right <= innerWidth &&
        card.top >= 0 && card.bottom <= innerHeight && controls.every(control => {
          const box = control.getBoundingClientRect()
          return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight
        })
    }), `${screen}: enlarged card and controls must fit`)
    await page.screenshot({ path: `${output}/${screen}-upgraded.png` })
    await activate(next)
    assert.equal(await preview.getAttribute('title'), 'Defend+')
    assert(await checkbox.isChecked(), 'owned upgrades open on their upgraded face')
    await checkbox.uncheck()
    assert.equal(await preview.getAttribute('title'), 'Defend',
      'an actually upgraded card must also have a base preview')
    await activate(next)
    assert.equal(await checkbox.isChecked(), false, 'navigation resets to the next card actual upgrade state')
    await activate(next)
    assert.equal(await preview.getAttribute('title'), 'Regret')
    assert.equal(await checkbox.count(), 0, 'unupgradable cards have no upgrade checkbox')
    assert.equal(await next.count(), 0, 'the last card must not wrap around')
    await page.keyboard.press('ArrowRight')
    assert.equal(await preview.getAttribute('title'), 'Regret')
    await page.keyboard.press('ArrowLeft')
    assert.equal(await preview.getAttribute('title'), 'Defend')
    await page.keyboard.press('Escape')
    await inspection.waitFor({ state: 'detached' })
    assert(await deck.isVisible(), 'Escape must close only the inspector')
    assert(await bash.evaluate(element => element === document.activeElement),
      `focus must return to the clicked deck card: ${await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 250))}`)
    assert.equal(await deck.getByLabel('Current deck upgrade preview').isChecked(), false)

    await deck.getByLabel('Current deck upgrade preview').check()
    await activate(grid.locator('.card[title="Bash+"]'))
    await inspection.waitFor()
    assert(await checkbox.isChecked())
    await activate(next)
    await activate(next)
    assert(await checkbox.isChecked(), 'the deck-wide upgrade preview carries into navigation')
    await checkbox.uncheck()
    await activate(previous)
    assert(await checkbox.isChecked(), 'owned upgrades still win after leaving global preview mode')
    await activate(previous)
    assert.equal(await checkbox.isChecked(), false, 'a manual toggle ends the inherited deck-wide preview')
    if (phone) await page.touchscreen.tap(8, 8)
    else await page.mouse.click(8, 8)
    await inspection.waitFor({ state: 'detached' })
    assert(await deck.isVisible())
    assert(await deck.getByLabel('Current deck upgrade preview').isChecked(),
      'the inspector must not change the deck-wide toggle')
    await deck.getByLabel('Current deck upgrade preview').uncheck()
    await deck.getByRole('button', { name: /A - Z/ }).click()
    await activate(grid.locator('.card[title="Defend+"]'))
    await inspection.waitFor()
    await activate(next)
    assert.equal(await preview.getAttribute('title'), 'Regret', 'inspect order follows the sorted grid')
    await page.keyboard.press('d')
    assert(await inspection.isVisible(), 'deck shortcut must not close a background dialog')
    await page.keyboard.press('Escape')
    await inspection.waitFor({ state: 'detached' })
    await activate(deck.getByRole('button', { name: 'Back', exact: true }))
    await deck.waitFor({ state: 'hidden' })
    await activate(page.getByRole('button', { name: /^Current deck,/ }))
    await deck.waitFor()
    assert.equal(await inspection.count(), 0, 'reopening the deck must not restore a stale inspector')
    assert.equal(await page.evaluate(() => JSON.stringify(window.__STS_DEBUG__.getRun())), original,
      'all inspection controls must leave the live run unchanged')
    assert.deepEqual(errors, [])
    await page.close()
    console.log(`PASS ${screen}: card inspection, both faces, navigation, focus, nested dismissal and read-only state`)
  }
} finally {
  await browser.close()
  await server.close()
}
