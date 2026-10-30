// Every Event panel fits its screen, both on opening and after picking the
// first choice: nothing spills past the panel's border, under the header, or
// below the window. A panel may scroll inside itself only if its frame stays
// on screen; only a resolver picker may hand scrolling to the stage. Every
// die lands on 1, so the Scrap Ooze retry state is covered on each screen. The 844x390 touch phone renders the scaled desktop canvas that
// index.html sets up; the fine-pointer 844x390 window is the short-landscape
// layout that event-phone.css owns.
import { dirname, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from './lib/profile-browser.mjs'
import { suite, check, assertEqual, report } from './lib/harness.mjs'
import { relicDef, potionDef } from '../src/game/relics.ts'

suite('event panels browser')

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const vite = await createServer({ root, logLevel: 'silent', server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } })
await vite.listen()
const address = vite.httpServer?.address()
if (!address || typeof address === 'string') throw new Error('vite did not report a port')
const browser = await chromium.launch()

const screens = [
  ['desktop', { viewport: { width: 1440, height: 900 } }],
  ['landscape-phone', { viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true }],
  ['short-landscape-window', { viewport: { width: 844, height: 390 } }],
]

const measure = () => {
  const panel = document.querySelector('.event-panel')
  if (!panel) return { missing: true }
  const header = document.querySelector('.app-shell__header')?.getBoundingClientRect().bottom ?? 0
  const frame = panel.getBoundingClientRect()
  if (frame.height === 0) return { missing: true }
  const scrolls = panel.scrollHeight > panel.clientHeight + 1 && getComputedStyle(panel).overflowY === 'auto'
  const boxes = [...panel.children].map((node) => node.getBoundingClientRect()).filter((box) => box.height > 0)
  const bottom = Math.max(...boxes.map((box) => box.bottom))
  const sideways = boxes.some((box) => box.left < frame.left - 1 || box.right > frame.right + 1)
  const stage = panel.closest('.event-stage')
  const stageScrolls = panel.classList.contains('event-panel--resolver') && stage.scrollHeight > stage.clientHeight + 1
  const onScreen = stageScrolls || (frame.top >= header - 1 && frame.bottom <= innerHeight + 1)
  return { onScreen, contained: !sideways && (scrolls || bottom <= frame.bottom + 1) }
}

try {
  for (const [screen, options] of screens) {
    const page = await browser.newPage(options)
    await page.goto(`http://127.0.0.1:${address.port}`, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'Single Player', exact: true }).click()
    await page.getByRole('button', { name: 'Standard', exact: true }).click()
    await page.getByRole('button', { name: 'Embark' }).click()
    await page.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
    await page.waitForFunction(() => window.__STS_DEBUG__?.getRun().phase === 'neow')
    const base = await page.evaluate(() => {
      const run = structuredClone(window.__STS_DEBUG__.getRun())
      run.players[0].gold = 10
      run.rng = { ...run.rng, replayValues: Array(8).fill(0.01) }
      return run
    })
    const cards = await page.evaluate(async () => {
      const { EVENT_CARDS } = await import('/src/game/events.ts')
      return [...new Map(EVENT_CARDS.map((card) => [card.id, card.name])).entries()]
    })
    const failures = []
    for (const [id, name] of cards) {
      await page.evaluate((run) => window.__STS_DEBUG__.setRun({ ...structuredClone(run), phase: 'map', neow: null, roomState: null }), base)
      await page.locator('.event-panel').waitFor({ state: 'detached' })
      await page.evaluate(async ([run, id]) => {
        const { EVENT_CARDS } = await import('/src/game/events.ts')
        const next = structuredClone(run)
        next.phase = 'room'
        next.neow = null
        next.map.position = next.map.rows[0][0]
        next.roomState = { kind: 'event', card: EVENT_CARDS.find((card) => card.id === id), decisions: {}, dieRolls: {} }
        window.__STS_DEBUG__.setRun(next)
      }, [base, id])
      await page.waitForFunction((name) => document.querySelector('#event-title')?.textContent === name, name)
      const opening = await page.evaluate(measure)
      if (opening.missing || !opening.onScreen || !opening.contained) failures.push(`${id} opening ${JSON.stringify(opening)}`)
      const first = page.locator('.event-panel .event-options button:not(:disabled)').first()
      if (!await first.count()) continue
      await first.click()
      await page.waitForFunction(() => {
        const die = document.querySelector('.event-die')
        return !document.querySelector('.event-panel') || !die || die.hasAttribute('data-landed')
      })
      await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
      const chosen = await page.evaluate(measure)
      if (chosen.missing) continue
      if (!chosen.onScreen || !chosen.contained) failures.push(`${id} after choice ${JSON.stringify(chosen)}`)
    }
    check(`${screen}: all ${cards.length} Event panels stay inside their frame`, () => assertEqual(failures.join('\n'), ''))
    await page.evaluate(async base => {
      const { EVENT_DEFINITIONS } = await import('/src/game/events.ts')
      const { createEventRoom } = await import('/src/game/event-room.ts')
      const run = structuredClone(base)
      run.phase = 'room'
      run.neow = null
      run.players[0].relics = [
        { defId: 'golden_eye', spent: true }, { defId: 'omamori', spent: false, uses: 1 },
      ]
      run.players.push({ ...structuredClone(run.players[0]), id: 'partner', name: 'Partner' })
      run.roomState = createEventRoom({ ...EVENT_DEFINITIONS.face_trader,
        instanceId: 'tooltip-face-trader', act: 2, minAscension: 0, requiresColorlessUnlock: false })
      window.__STS_DEBUG__.setRun(run)
    }, base)
    await page.locator('[data-event-option="exchange"]').waitFor()
    const headerRules = new Map()
    for (const id of ['golden_eye', 'omamori']) {
      await page.mouse.move(2, 2)
      await page.keyboard.press('Tab')
      const chip = page.locator(`.relic-chip[data-relic="${id}"]`)
      await chip.focus()
      const help = chip.locator('.relic-tip')
      await help.waitFor()
      headerRules.set(id, await help.innerText())
      await page.keyboard.press('Escape')
    }
    await page.locator('[data-event-option="exchange"]').click()
    const picker = page.getByRole('group', { name: 'Your relic', exact: true })
    await picker.waitFor()
    const beforeReading = await page.evaluate(() => JSON.stringify(window.__STS_DEBUG__.getRun()))
    for (const id of ['golden_eye', 'omamori']) {
      const option = picker.getByRole('button', { name: new RegExp(`^${relicDef(id).name}`) })
      if (options.hasTouch) await option.focus()
      else await option.hover()
      const help = page.locator('.potion-tip').filter({ hasText: relicDef(id).name })
      await help.waitFor()
      assert.equal(await help.innerText(), headerRules.get(id), `${screen}: exact header rules and status`)
      assert.equal(await option.getAttribute('aria-pressed'), 'false')
      assert.equal(await option.getAttribute('title'), null)
      assert(await help.evaluate(tip => {
        const box = tip.getBoundingClientRect()
        return tip.parentElement === document.body && box.left >= 0 && box.top >= 0 &&
          box.right <= innerWidth && box.bottom <= innerHeight
      }), `${screen}: event tooltip fits outside its scroller`)
      await page.keyboard.press('Escape')
    }
    assert.equal(await page.evaluate(() => JSON.stringify(window.__STS_DEBUG__.getRun())), beforeReading)
    const goldenEye = picker.getByRole('button', { name: /^Golden Eye/ })
    if (options.hasTouch) await goldenEye.tap()
    else await goldenEye.click()
    assert.equal(await goldenEye.getAttribute('aria-pressed'), 'true')
    assert.equal(await page.evaluate(() => JSON.stringify(window.__STS_DEBUG__.getRun())), beforeReading,
      'selecting an exchange must still wait for confirmation')
    await page.evaluate(async () => {
      const { EVENT_DEFINITIONS } = await import('/src/game/events.ts')
      const { createEventRoom } = await import('/src/game/event-room.ts')
      const run = structuredClone(window.__STS_DEBUG__.getRun())
      run.roomState = createEventRoom({ ...EVENT_DEFINITIONS.moai_head,
        instanceId: 'tooltip-moai', act: 3, minAscension: 0, requiresColorlessUnlock: false })
      window.__STS_DEBUG__.setRun(run)
    })
    await page.locator('[data-event-option="offer"]').click()
    assert.match(await picker.getByRole('button', { name: /^Golden Eye/ }).innerText(), /7 Gold/)
    const heldPotions = ['fire_potion', 'weak_potion', 'swift_potion']
    await page.evaluate(async ([base, potions]) => {
      const { EVENT_DEFINITIONS } = await import('/src/game/events.ts')
      const run = structuredClone(base)
      const id = run.players[0].id
      run.phase = 'room'
      run.neow = null
      run.players[0].potions = potions
      run.roomState = {
        kind: 'event',
        card: { ...EVENT_DEFINITIONS.lab, instanceId: 'tooltip-lab', act: 1,
          minAscension: 0, requiresColorlessUnlock: false },
        decisions: {}, dieRolls: {},
        pendingDecisions: { [id]: { optionIds: ['resolve'] } },
        itemOffers: { [id]: [{ kind: 'potion', id: 'block_potion' }] },
      }
      window.__STS_DEBUG__.setRun(run)
    }, [base, heldPotions])
    const reward = page.locator('.event-loot').filter({ hasText: 'Block Potion' })
    await reward.getByRole('button', { name: 'Take', exact: true }).click()
    const swaps = reward.getByRole('group', { name: 'Replace', exact: true })
    await swaps.waitFor()
    for (const id of heldPotions) {
      const option = swaps.getByRole('button', { name: potionDef(id).name, exact: true })
      if (options.hasTouch) await option.focus()
      else await option.hover()
      const help = page.locator('.potion-tip').filter({ hasText: potionDef(id).name })
      await help.waitFor()
      assert((await help.innerText()).includes(potionDef(id).text))
      assert.equal(await option.getAttribute('aria-pressed'), 'false')
      await page.keyboard.press('Escape')
    }
    const replacement = swaps.getByRole('button').first()
    if (options.hasTouch) await replacement.tap()
    else await replacement.click()
    assert.equal(await replacement.getAttribute('aria-pressed'), 'true')
    assert.deepEqual(await page.evaluate(() => window.__STS_DEBUG__.getRun().players[0].potions), heldPotions)
    await page.getByRole('button', { name: /Resolve rewards/ }).click()
    await page.waitForFunction(() =>
      window.__STS_DEBUG__.getRun().players[0].potions.join(',') === 'weak_potion,swift_potion,block_potion')
    await page.close()
  }
} finally {
  await browser.close()
  await vite.close()
}
report('event panels browser')
