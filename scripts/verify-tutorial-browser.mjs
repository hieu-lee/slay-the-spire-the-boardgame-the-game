import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from './lib/profile-browser.mjs'
import { walkTutorial } from './lib/tutorial-walk.mjs'

// The guided tutorial: the Tutorial menu entry reuses the Single Player
// character picker without Ascension and starts the chosen hero's fixed,
// scripted Act I run. The coach shields the run while it explains, lets only
// the ringed controls through when it asks for a move, and advances when the
// move is made. The tutorial leaves the saved run, campaign journal and
// leaderboard untouched.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = join(root, 'artifacts/tutorial-browser')
mkdirSync(output, { recursive: true })
const server = await createServer({ root, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } })
await server.listen()
const port = server.httpServer.address().port
const browser = await chromium.launch()

const panel = (page) => page.locator('.tutorial-coach__panel')
const getRun = (page) => page.evaluate(() => window.__STS_DEBUG__.getRun())

async function assertPanelOnScreen(page, label, where) {
  const box = await panel(page).boundingBox()
  // Phones lay out a wider desktop page and scale it, so use the layout viewport.
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  assert(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 0.5 && box.y + box.height <= viewport.height + 0.5,
    `${label}: the coach left the screen at ${where}: ${JSON.stringify(box)}`)
}

try {
  for (const [label, viewport, phone, hero, heroName, firstFight, secondRoom] of [
    ['desktop', { width: 1440, height: 900 }, false, 'ironclad', 'Ironclad', 'a1r0c0', 'a1r1c1'],
    ['horizontal-phone', { width: 844, height: 390 }, true, 'hermit', 'Hermit', 'a1r0c0', null],
    ['horizontal-phone-kratos', { width: 844, height: 390 }, true, 'kratos', 'Kratos', 'a1r0c0', null],
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
      ['Resume', 'Single Player', 'Tutorial', 'Multiplayer', 'Leaderboard', 'Stats', 'Replay', 'Compendium'])

    await page.getByRole('button', { name: 'Tutorial', exact: true }).click()
    await page.locator('.start-menu__character-select:not(.start-menu__character-loading)').waitFor()
    assert.equal(await page.getByText('Tutorial · Choose your character').count(), 1, `${label}: tutorial picker heading`)
    assert.equal(await page.locator('.start-menu__ascension').count(), 0, `${label}: tutorial picker shows Ascension`)
    assert.equal(await page.getByRole('button', { name: 'Embark' }).count(), 0, `${label}: tutorial picker shows Embark`)
    await page.getByRole('button', { name: heroName, exact: true }).click()
    await page.waitForFunction((name) => document.querySelector('#character-select-title')?.textContent === name, heroName)
    await page.getByRole('button', { name: 'Start tutorial', exact: true }).click()

    await page.locator('.pip--tutorial').waitFor()
    const { seed, first } = await page.evaluate(async (character) => {
      const { tutorialSeed } = await import('/src/ui/tutorial/index.ts')
      const run = window.__STS_DEBUG__.getRun()
      return { seed: tutorialSeed(character), first: { phase: run.phase, ascension: run.ascension, character: run.players[0].character, seed: run.seed } }
    }, hero)
    assert.deepEqual({ ...first, seed: undefined }, { phase: 'neow', ascension: 0, character: hero, seed: undefined }, `${label}: tutorial run`)
    const { seedFromString } = await import('../src/game/rng.ts')
    assert.equal(first.seed, seedFromString(seed), `${label}: the tutorial plays its fixed seed`)
    await page.locator('.tutorial-coach__panel[data-chapter="neow"]').waitFor()
    await page.screenshot({ path: join(output, `${label}-welcome.png`) })

    // While the coach explains, the run underneath takes no input.
    const neowButton = page.locator('.neow-action button').first()
    await neowButton.waitFor()
    const buttonBox = await neowButton.boundingBox()
    await page.mouse.click(buttonBox.x + buttonBox.width / 2, buttonBox.y + buttonBox.height / 2)
    assert.equal((await getRun(page)).neow.players.p1.redGoldPending, true, `${label}: a shielded Neow button still acted`)

    // Walk the scripted run through the first fight and its rewards.
    const shots = new Set()
    let rageMeterChecked = false
    const walk = await walkTutorial(page, {
      until: (step) => secondRoom ? step.chapter === `move-${secondRoom}` : step.chapter === `reward-${firstFight}`,
      onStep: async (step) => {
        await assertPanelOnScreen(page, label, `${step.chapter}#${step.step}`)
        if (hero === 'kratos' && step.title === 'Rage') {
          rageMeterChecked = true
          const meter = await page.locator('.rage-meter').boundingBox()
          const { width, height } = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
          assert(meter && meter.x >= 0 && meter.y >= 0 && meter.x + meter.width <= width && meter.y + meter.height <= height,
            `${label}: the Rage meter the coach points at is off screen: ${JSON.stringify(meter)}`)
        }
        const shot = step.task && step.chapter.startsWith('fight-') ? 'fight-task'
          : step.task && step.chapter.startsWith('move-') ? 'map-task'
            : step.task && step.chapter === 'neow' ? 'neow-task' : null
        if (shot && !shots.has(shot)) {
          shots.add(shot)
          if (shot === 'map-task') await page.waitForFunction(() => ![...document.querySelectorAll('.card')].some((card) => {
            const box = card.getBoundingClientRect()
            return box.width > 0 && box.height > 0
          }))
          assert(await page.locator('.tutorial-coach__ring').count() > 0, `${label}: ${shot} has no highlighted control`)
          await page.screenshot({ path: join(output, `${label}-${shot}.png`), animations: 'disabled' })
        }
      },
    })
    assert(walk.stoppedAt, `${label}: the walk did not reach the end of the first fight: ${walk.log.slice(-3).join(' | ')}`)
    assert(hero !== 'kratos' || rageMeterChecked, `${label}: the Rage step never showed`)
    assert(walk.chapters.includes('neow') && walk.chapters.includes(`move-${firstFight}`) &&
      walk.chapters.some((chapter) => chapter.startsWith(`fight-${firstFight}`)), `${label}: chapters ${walk.chapters.join(', ')}`)
    const after = await getRun(page)
    const plan = await page.evaluate(async (character) => (await import('/src/ui/tutorial/index.ts')).HERO_TUTORIALS[character].plan, hero)
    assert(after.players[0].deck.some((card) => card.defId === plan.neow.pick), `${label}: the forced Neow pick is in the deck`)
    assert.equal(after.map.rooms[firstFight].visited, true, `${label}: the forced route entered the first fight`)

    // The header plate hides and restores the tips without losing the run.
    await panel(page).waitFor()
    await page.locator('.tutorial-coach__hide').click()
    await page.waitForFunction(() => !document.querySelector('.tutorial-coach__panel'))
    await page.locator('.pip--tutorial').click()
    await panel(page).waitFor()

    // The tutorial's own ending replaces the campaign's record controls, and
    // trying again restarts both the run and the coach.
    await page.evaluate(() => {
      const debug = window.__STS_DEBUG__
      debug.setRun({ ...structuredClone(debug.getRun()), phase: 'defeat', combat: null })
    })
    await page.getByRole('heading', { name: 'The tutorial run has ended' }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Record campaign result' }).count(), 0, `${label}: tutorial offers to record`)
    await page.screenshot({ path: join(output, `${label}-defeat.png`) })
    await page.getByRole('button', { name: 'Try again', exact: true }).click()
    await page.locator('.tutorial-coach__panel[data-chapter="neow"][data-step="0"]').waitFor()
    const retry = await getRun(page)
    assert.deepEqual([retry.phase, retry.map.position, retry.players[0].character], ['neow', null, hero], `${label}: Try again restarts the run`)
    await page.evaluate(() => {
      const debug = window.__STS_DEBUG__
      debug.setRun({ ...structuredClone(debug.getRun()), phase: 'victory', neow: null })
    })
    await page.getByRole('heading', { name: 'Tutorial complete' }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Stop and record result' }).count(), 0, `${label}: tutorial offers to record`)
    await page.getByRole('button', { name: 'Return to main menu', exact: true }).click()

    await page.getByRole('button', { name: 'Resume', exact: true }).waitFor()
    const stored = await page.evaluate(() => ({
      solo: localStorage.getItem('sts-solo-run'),
      campaign: localStorage.getItem('sts-physical-campaign'),
    }))
    assert.equal(stored.solo, saved.solo, `${label}: the tutorial changed the saved solo run`)
    assert.equal(stored.campaign, saved.campaign, `${label}: the tutorial changed the campaign journal`)

    // Leaving from the pause menu also restores the menu with the saved run.
    await page.getByRole('button', { name: 'Tutorial', exact: true }).click()
    await page.getByRole('button', { name: 'Start tutorial', exact: true }).click()
    await page.locator('.tutorial-coach__panel[data-chapter="neow"]').waitFor()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Leave tutorial', exact: true }).click()
    await page.getByRole('button', { name: 'Resume', exact: true }).waitFor()
    assert.equal(await page.evaluate(() => localStorage.getItem('sts-solo-run')), saved.solo,
      `${label}: leaving the tutorial changed the saved solo run`)

    assert.deepEqual(errors, [], `${label}: console errors`)
    console.log(`ok - ${label}: ${heroName} tutorial (${walk.log.length} coach steps)`)
    await context.close()
  }
} finally {
  await browser.close()
  await server.close()
}
