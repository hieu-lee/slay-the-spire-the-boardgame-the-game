import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from './lib/profile-browser.mjs'

// The guided tutorial: the Tutorial menu entry reuses the Single Player
// character picker without Ascension, starts a coached Act I run for the chosen
// hero, and leaves the saved run, campaign journal and leaderboard untouched.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = join(root, 'artifacts/tutorial-browser')
mkdirSync(output, { recursive: true })
const server = await createServer({ root, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } })
await server.listen()
const port = server.httpServer.address().port
const browser = await chromium.launch()

async function finishChapter(page, chapter, label) {
  const panel = page.locator('.tutorial-coach__panel')
  await page.locator(`.tutorial-coach__panel[data-chapter="${chapter}"]`).waitFor()
  const titles = []
  for (let guard = 0; guard < 20; guard += 1) {
    titles.push(await panel.locator('h2').textContent())
    const box = await panel.boundingBox()
    // Phones lay out a wider desktop page and scale it, so use the layout viewport.
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    assert(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 0.5 && box.y + box.height <= viewport.height + 0.5,
      `${label}: the ${chapter} coach left the screen: ${JSON.stringify(box)}`)
    const next = panel.locator('.tutorial-coach__next')
    if ((await next.textContent()) === 'Got it') {
      await next.click()
      break
    }
    await next.click()
  }
  await page.waitForFunction((id) => !document.querySelector(`.tutorial-coach__panel[data-chapter="${id}"]`), chapter)
  return titles
}

try {
  for (const [label, viewport, phone, hero, heroName, intro] of [
    ['desktop', { width: 1440, height: 900 }, false, 'silent', 'Silent', 'Playing the Silent'],
    ['horizontal-phone', { width: 844, height: 390 }, true, 'hermit', 'Hermit', 'Playing the Hermit'],
  ]) {
    const context = await browser.newContext({ viewport, isMobile: phone, hasTouch: phone })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
    await page.goto(`http://127.0.0.1:${port}`)
    await page.locator('.start-menu__nav').waitFor()

    // A saved solo run and campaign journal the tutorial must not touch.
    const saved = await page.evaluate(async () => {
      const { createRun } = await import('/src/game/run.ts')
      const run = createRun(21, [{ id: 'p1', name: 'TestPlayer', character: 'ironclad' }])
      run.phase = 'map'
      run.neow = null
      localStorage.setItem('sts-solo-run', JSON.stringify({ version: 1, run, built: {
        count: 1, seed: '21', ascension: 0, chooseYourRelic: false, lastStand: false,
        characters: ['ironclad'], meta: { mode: 'standard', modifiers: [], quickStartAct: 1 },
      } }))
      return { solo: localStorage.getItem('sts-solo-run') }
    })
    await page.reload()
    await page.getByRole('button', { name: 'Resume', exact: true }).waitFor()
    saved.campaign = await page.evaluate(() => localStorage.getItem('sts-physical-campaign'))
    assert.deepEqual(await page.locator('.start-menu__nav button').allTextContents(),
      ['Resume', 'Single Player', 'Tutorial', 'Multiplayer', 'Leaderboard', 'Stats', 'Replay', 'Compendium', 'Settings'])

    await page.getByRole('button', { name: 'Tutorial', exact: true }).click()
    await page.locator('.start-menu__character-select:not(.start-menu__character-loading)').waitFor()
    assert.equal(await page.getByText('Tutorial · Choose your character').count(), 1, `${label}: tutorial picker heading`)
    assert.equal(await page.locator('.start-menu__ascension').count(), 0, `${label}: tutorial picker shows Ascension`)
    assert.equal(await page.getByRole('button', { name: 'Embark' }).count(), 0, `${label}: tutorial picker shows Embark`)
    await page.getByRole('button', { name: heroName, exact: true }).click()
    await page.waitForFunction((name) => document.querySelector('#character-select-title')?.textContent === name, heroName)
    await page.screenshot({ path: join(output, `${label}-picker.png`) })
    await page.getByRole('button', { name: 'Start tutorial', exact: true }).click()

    await page.locator('.pip--tutorial').waitFor()
    const run = await page.evaluate(() => window.__STS_DEBUG__.getRun())
    assert.equal(run.phase, 'neow', `${label}: tutorial should open at Neow`)
    assert.equal(run.ascension, 0, `${label}: tutorial runs at Ascension 0`)
    assert.equal(run.players[0].character, hero, `${label}: tutorial uses the chosen hero`)
    await page.locator('.tutorial-coach__panel[data-chapter="welcome"]').waitFor()
    await page.screenshot({ path: join(output, `${label}-welcome.png`) })
    const welcome = await finishChapter(page, 'welcome', label)
    assert.deepEqual(welcome, ['Welcome to the Spire', 'Your health', 'Deck and relics', "Neow's blessing"])

    // Skip Neow's choices; the coach follows the run to the map.
    await page.evaluate(() => {
      const debug = window.__STS_DEBUG__
      debug.setRun({ ...structuredClone(debug.getRun()), phase: 'map', neow: null })
    })
    await page.locator('.tutorial-coach__panel[data-chapter="map"]').waitFor()
    await page.locator('.tutorial-coach__ring').waitFor()
    await page.waitForTimeout(500)
    await page.screenshot({ path: join(output, `${label}-map.png`) })
    await finishChapter(page, 'map', label)

    await page.locator('.room--reachable').first().click()
    if (phone && await page.locator('.combat').count() === 0) await page.locator('.room--reachable').first().click()
    await page.locator('.combat').waitFor()
    if (hero === 'hermit') {
      // The Hermit's mandatory opening Load comes before turn 1, with its own chapter.
      await page.locator('.tutorial-coach__panel[data-chapter="hermit-setup"]').waitFor()
      await page.screenshot({ path: join(output, `${label}-hermit-setup.png`) })
      await page.locator('.hand .card').first().click()
      await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.turn > 0)
    }
    await page.locator('.tutorial-coach__panel[data-chapter="combat"]').waitFor()
    const panel = page.locator('.tutorial-coach__panel')
    const missingTargets = []
    const combatTitles = []
    for (let guard = 0; guard < 12; guard += 1) {
      const title = await panel.locator('h2').textContent()
      combatTitles.push(title)
      await page.waitForTimeout(250)
      if (await page.locator('.tutorial-coach__ring').count() === 0) missingTargets.push(title)
      if (title === 'Playing a card' || title === 'End your turn') {
        await page.waitForTimeout(300)
        await page.screenshot({ path: join(output, `${label}-combat-${title.toLowerCase().replaceAll(' ', '-')}.png`) })
      }
      const next = panel.locator('.tutorial-coach__next')
      const last = (await next.textContent()) === 'Got it'
      await next.click()
      if (last) break
    }
    assert.equal(combatTitles.length, 9, `${label}: combat basics steps: ${combatTitles.join(', ')}`)
    assert.deepEqual(missingTargets, [], `${label}: combat coach steps without a highlighted target`)

    await page.locator(`.tutorial-coach__panel[data-chapter="${hero}-intro"]`).waitFor()
    assert.equal(await panel.locator('h2').textContent(), intro, `${label}: character chapter`)
    await page.waitForTimeout(500)
    await page.screenshot({ path: join(output, `${label}-character.png`) })
    await finishChapter(page, `${hero}-intro`, label)

    // The header pill hides and restores tips without losing the run.
    await page.evaluate(() => {
      const debug = window.__STS_DEBUG__
      const next = structuredClone(debug.getRun())
      next.combat.turn = 2
      debug.setRun(next)
    })
    await page.locator('.tutorial-coach__panel[data-chapter="status-effects"]').waitFor()
    await page.locator('.pip--tutorial').click()
    await page.waitForFunction(() => !document.querySelector('.tutorial-coach__panel'))
    await page.locator('.pip--tutorial').click()
    await page.locator('.tutorial-coach__panel[data-chapter="status-effects"]').waitFor()
    await finishChapter(page, 'status-effects', label)

    // The tutorial's own ending replaces the campaign's record controls.
    await page.evaluate(() => {
      const debug = window.__STS_DEBUG__
      debug.setRun({ ...structuredClone(debug.getRun()), phase: 'defeat', combat: null })
    })
    await page.getByRole('heading', { name: 'The tutorial run has ended' }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Record campaign result' }).count(), 0, `${label}: tutorial offers to record`)
    await page.screenshot({ path: join(output, `${label}-defeat.png`) })
    await page.getByRole('button', { name: 'Try again', exact: true }).click()
    await page.locator('.tutorial-coach__panel[data-chapter="welcome"]').waitFor()
    assert.equal(await page.evaluate(() => window.__STS_DEBUG__.getRun().players[0].character), hero)
    await page.evaluate(() => {
      const debug = window.__STS_DEBUG__
      debug.setRun({ ...structuredClone(debug.getRun()), phase: 'victory', neow: null })
    })
    await page.getByRole('heading', { name: 'Tutorial complete' }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Stop and record result' }).count(), 0, `${label}: tutorial offers to record`)
    await page.screenshot({ path: join(output, `${label}-complete.png`) })
    await page.getByRole('button', { name: 'Return to main menu', exact: true }).click()

    await page.getByRole('button', { name: 'Resume', exact: true }).waitFor()
    const after = await page.evaluate(() => ({
      solo: localStorage.getItem('sts-solo-run'),
      campaign: localStorage.getItem('sts-physical-campaign'),
      runLogs: Object.keys(localStorage).filter((key) => key.includes('run-log')),
    }))
    assert.equal(after.solo, saved.solo, `${label}: the tutorial changed the saved solo run`)
    assert.equal(after.campaign, saved.campaign, `${label}: the tutorial changed the campaign journal`)

    // Leaving from the pause menu also restores the menu with the saved run.
    await page.getByRole('button', { name: 'Tutorial', exact: true }).click()
    await page.getByRole('button', { name: 'Start tutorial', exact: true }).click()
    await page.locator('.tutorial-coach__panel[data-chapter="welcome"]').waitFor()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Leave tutorial', exact: true }).click()
    await page.getByRole('button', { name: 'Resume', exact: true }).waitFor()
    assert.equal(await page.evaluate(() => localStorage.getItem('sts-solo-run')), saved.solo,
      `${label}: leaving the tutorial changed the saved solo run`)

    assert.deepEqual(errors, [], `${label}: console errors`)
    console.log(`ok - ${label}: ${heroName} tutorial`)
    await context.close()
  }
} finally {
  await browser.close()
  await server.close()
}
