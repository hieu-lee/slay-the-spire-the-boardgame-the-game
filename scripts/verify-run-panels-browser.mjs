import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import { postNeowRun } from './lib/post-neow-run.mjs'
import { roomChoices } from '../src/game/run.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const output = `${root}artifacts/run-panels-browser`
mkdirSync(output, { recursive: true })
const server = await createServer({ root, logLevel: 'silent', server: { port: 0 } })
await server.listen()
const browser = await chromium.launch()
const errors = []

try {
  for (const [name, viewport, touch] of [
    ['desktop', { width: 1440, height: 900 }, false],
    ['horizontal-phone', { width: 844, height: 390 }, true],
  ]) {
    const context = await browser.newContext({ viewport, hasTouch: touch, isMobile: touch })
    const page = await context.newPage()
    page.on('pageerror', (error) => errors.push(String(error)))
    await page.goto(`http://localhost:${server.httpServer.address().port}`, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'Single Player', exact: true }).click()
    const modes = page.getByRole('region', { name: 'Run modes' })
    await modes.waitFor()
    assert.equal(await modes.locator('h1').count(), 0, 'the removed run-mode heading remains')
    const cards = modes.locator('.start-menu__mode-choice')
    assert.equal(await cards.count(), 3)
    for (const card of await cards.all()) {
      assert(await card.evaluate((element) => {
        const box = element.getBoundingClientRect()
        const image = element.querySelector('img')
        return box.top >= 0 && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth &&
          element.scrollHeight <= element.clientHeight && image.complete && image.naturalWidth > 0 &&
          getComputedStyle(element, '::before').backgroundImage.includes('parchment.svg')
      }), `${name}: a parchment panel or its contents are clipped`)
    }
    await page.mouse.move(0, 0)
    await page.screenshot({ path: `${output}/${name}-run-modes.png` })
    if (!touch) {
      for (const card of await cards.all()) {
        await card.hover()
        await card.evaluate(async (element) => {
          const transitions = element.getAnimations()
          if (!['transform', 'filter'].every((property) => transitions.some((animation) =>
            animation.transitionProperty === property))) throw new Error('mode hover must animate lift and glow')
          for (const animation of transitions) { animation.pause(); animation.currentTime = 120 }
          const lift = new DOMMatrixReadOnly(getComputedStyle(element).transform).m42
          if (!(lift < 0 && lift > -5.6)) throw new Error('mode hover jumped to its endpoint')
          for (const animation of transitions) animation.finish()
        })
        await page.mouse.move(0, 0)
        await card.evaluate(async (element) => {
          const transitions = element.getAnimations()
          if (!transitions.some((animation) => animation.transitionProperty === 'transform'))
            throw new Error('mode hover must ease back on exit')
          await Promise.all(transitions.map((animation) => animation.finished))
        })
      }
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await cards.first().hover()
      assert.equal(await cards.first().evaluate((element) => getComputedStyle(element).transform), 'none')
      assert.equal(await cards.first().evaluate((element) => getComputedStyle(element).transitionDuration), '0s')
      await page.mouse.move(0, 0)
      await page.emulateMedia({ reducedMotion: 'no-preference' })
    }
    await cards.first().focus()
    await page.keyboard.press('ArrowRight')
    await cards.first().evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)))
    assert(await cards.first().evaluate((element) => getComputedStyle(element).filter.includes('brightness')),
      'keyboard focus lost its highlight')
    await page.screenshot({ path: `${output}/${name}-run-mode-focus.png` })
    await page.getByRole('button', { name: 'Daily', exact: true }).click()
    await page.getByRole('heading', { name: 'Daily Climb' }).waitFor()
    await page.getByRole('button', { name: 'Back', exact: true }).click()
    await page.getByRole('button', { name: 'Custom', exact: true }).click()
    await page.getByRole('heading', { name: 'Customize your run' }).waitFor()
    await page.getByRole('button', { name: 'Back', exact: true }).click()
    await page.getByRole('button', { name: 'Standard', exact: true }).click()
    await page.getByRole('button', { name: 'Embark', exact: true }).click()
    await page.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
    await page.waitForFunction(() => window.__STS_DEBUG__?.getRun().phase === 'neow')

    const run = postNeowRun('run-panel-map', [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
    const current = Object.values(run.map.rooms).find((room) => room.exits.length >= 2)
    assert(current)
    run.map.position = current.id
    current.visited = true
    const choices = roomChoices(run).map((room) => room.id)
    assert(choices.length > 0)
    await page.evaluate((fixture) => window.__STS_DEBUG__.setRun(fixture), run)
    const map = page.locator('.map:not([inert])')
    await map.waitFor()
    const nodes = await map.locator('.room').evaluateAll((elements) => elements.map((element) => ({
      id: element.dataset.room,
      disabled: element.getAttribute('aria-disabled'),
      opacity: Number(getComputedStyle(element.querySelector('.icon')).opacity),
    })))
    for (const node of nodes) {
      assert.equal(node.disabled, choices.includes(node.id) ? 'false' : 'true')
      assert.equal(node.opacity, choices.includes(node.id) || node.id === current.id ? 1 : 0.3,
        `${name}: ${node.id} has the wrong reachability emphasis`)
    }
    // Inspecting a future room must never enter it, including keyboard activation.
    const unavailable = nodes.find((node) => node.disabled === 'true' && node.id !== current.id)
    const disabledRoom = map.locator(`[data-room="${unavailable.id}"]`)
    await disabledRoom.focus()
    await page.keyboard.press('Enter')
    assert.equal(await page.evaluate(() => window.__STS_DEBUG__.getRun().map.position), current.id)
    await map.locator(`[data-room="${choices[0]}"]`).scrollIntoViewIfNeeded()
    await map.evaluate((element) => { element.scrollTop = element.scrollHeight })
    await page.mouse.move(0, 0)
    await disabledRoom.evaluate((element) => element.blur())
    await page.screenshot({ path: `${output}/${name}-reachable-map.png` })
    const reachable = map.locator(`[data-room="${choices[0]}"]`)
    if (touch) {
      await reachable.tap()
      assert.equal(await page.evaluate(() => window.__STS_DEBUG__.getRun().map.position), current.id,
        'the first touch should read the room')
      await reachable.tap()
    } else {
      await reachable.focus()
      await page.keyboard.press('Enter')
    }
    await page.waitForFunction((id) => window.__STS_DEBUG__.getRun().map.position === id, choices[0])
    await context.close()
  }
  assert.deepEqual(errors, [])
  console.log('✓ Run panels: mode navigation, keyboard, reachability and touch passed on desktop and horizontal phone')
} finally {
  await browser.close()
  await server.close()
}
