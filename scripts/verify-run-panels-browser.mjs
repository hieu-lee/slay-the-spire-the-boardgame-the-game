import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium, webkit } from './lib/profile-browser.mjs'
import { createServer } from 'vite'
import { postNeowRun } from './lib/post-neow-run.mjs'
import { roomChoices } from '../src/game/run.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const useWebkit = process.env.BROWSER === 'webkit'
const output = `${root}artifacts/run-panels-${useWebkit ? 'webkit-' : ''}browser`
mkdirSync(output, { recursive: true })
const server = await createServer({ root, logLevel: 'silent', server: { port: 0 } })
await server.listen()
const browser = await (useWebkit ? webkit : chromium).launch(
  useWebkit && process.env.WEBKIT_EXECUTABLE_PATH ? { executablePath: process.env.WEBKIT_EXECUTABLE_PATH } : undefined)
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
    if (touch) {
      const viewportMeta = page.locator('meta[name="viewport"]')
      const originalViewport = await viewportMeta.getAttribute('content')
      await page.evaluate(() => {
        window.viewportChanges = 0
        window.viewportObserver = new MutationObserver((records) => {
          for (const record of records) for (const node of record.addedNodes) {
            if (node.nodeName === 'META' && node.name === 'viewport') window.viewportChanges++
          }
        })
        window.viewportObserver.observe(document.head, { childList: true })
      })
      await page.evaluate((ratio) => {
        const visual = window.visualViewport
        for (let step = 0; step < 10; step++) {
          setTimeout(() => {
            Object.defineProperty(visual, 'height', {
              configurable: true, get: () => visual.width / (ratio - (9 - step) * 0.015),
            })
            visual.dispatchEvent(new Event('resize'))
          }, step * 12)
        }
      }, viewport.width / (viewport.height - 46))
      await page.waitForTimeout(360)
      assert.notEqual(await viewportMeta.getAttribute('content'), originalViewport,
        `${name}: the browser chrome animation did not update the viewport`)
      assert.equal(await page.evaluate(() => {
        window.viewportObserver.disconnect()
        return window.viewportChanges
      }), 1, `${name}: browser chrome animation rewrote the viewport more than once`)
      await page.evaluate(() => {
        delete window.visualViewport.height
        window.visualViewport.dispatchEvent(new Event('resize'))
      })
      await page.waitForFunction((expected) => document.querySelector('meta[name="viewport"]').content === expected,
        originalViewport, { timeout: 3000 })
      assert.equal(await viewportMeta.getAttribute('content'), originalViewport,
        `${name}: visual viewport did not reset after browser chrome disappeared`)
      const unzoomedMenuHeight = await page.locator('.start-menu').evaluate((menu) => menu.getBoundingClientRect().height)
      await page.evaluate(() => {
        const visual = window.visualViewport
        const width = visual.width
        const height = visual.height
        const scale = visual.scale
        Object.defineProperty(visual, 'width', { configurable: true, get: () => width / 2 })
        Object.defineProperty(visual, 'height', { configurable: true, get: () => height / 2 })
        Object.defineProperty(visual, 'scale', { configurable: true, get: () => scale * 2 })
        visual.dispatchEvent(new Event('resize'))
      })
      await page.waitForTimeout(220)
      assert.equal(await viewportMeta.getAttribute('content'), originalViewport,
        `${name}: pinch zoom changed the landscape viewport width`)
      assert(await page.locator('.start-menu').evaluate((menu, height) =>
        Math.abs(menu.getBoundingClientRect().height - height) <= 2, unzoomedMenuHeight),
      `${name}: pinch zoom shrank the menu`)
      for (const card of await cards.all()) {
        assert(await card.evaluate((element) => element.scrollHeight <= element.clientHeight),
          `${name}: pinch zoom clipped a mode panel`)
      }
      await page.screenshot({ path: `${output}/${name}-run-modes-zoom.png` })
      await page.evaluate(() => {
        const visual = window.visualViewport
        delete visual.width
        delete visual.height
        delete visual.scale
        visual.dispatchEvent(new Event('resize'))
      })
      await page.waitForTimeout(220)
      await page.setViewportSize({ width: viewport.width, height: viewport.height - 46 })
      await page.waitForFunction((previous) => document.querySelector('meta[name="viewport"]').content !== previous,
        originalViewport, { timeout: 3000 })
      const reducedViewport = await viewportMeta.getAttribute('content')
      assert.notEqual(reducedViewport, originalViewport, `${name}: landscape viewport did not adjust when browser chrome reduced its height`)
      for (const card of await cards.all()) {
        assert(await card.evaluate((element) => {
          const box = element.getBoundingClientRect()
          return box.top >= 0 && box.bottom <= innerHeight && element.scrollHeight <= element.clientHeight
        }), `${name}: a mode panel clips after the browser height changes`)
      }
      await page.screenshot({ path: `${output}/${name}-run-modes-short.png` })
      await page.setViewportSize(viewport)
      await page.waitForFunction((expected) => document.querySelector('meta[name="viewport"]').content === expected,
        originalViewport, { timeout: 3000 })
      assert.equal(await viewportMeta.getAttribute('content'), originalViewport,
        `${name}: landscape viewport did not reset when the browser height returned`)
      await page.evaluate((ratio) => {
        const field = document.createElement('input')
        field.type = 'text'
        field.dataset.viewportTest = ''
        field.style.position = 'fixed'
        document.body.append(field)
        field.focus()
        const visual = window.visualViewport
        Object.defineProperty(visual, 'height', { configurable: true, get: () => visual.width / ratio })
        visual.dispatchEvent(new Event('resize'))
      }, viewport.width / (viewport.height - 46))
      await page.waitForTimeout(220)
      assert.equal(await viewportMeta.getAttribute('content'), originalViewport,
        `${name}: focusing a text field changed the viewport during browser chrome animation`)
      for (const card of await cards.all()) {
        assert(await card.evaluate((element) => element.getBoundingClientRect().bottom <=
          visualViewport.offsetTop + visualViewport.height && element.scrollHeight <= element.clientHeight),
        `${name}: a focused text field let the browser toolbar clip a mode panel`)
      }
      await page.evaluate(() => {
        delete window.visualViewport.height
        window.visualViewport.dispatchEvent(new Event('resize'))
      })
      await page.waitForTimeout(220)
      await page.evaluate(() => {
        Object.defineProperty(window.visualViewport, 'height', { configurable: true, get: () => innerHeight * 0.8 })
        window.visualViewport.dispatchEvent(new Event('resize'))
      })
      await page.waitForTimeout(220)
      assert.equal(await viewportMeta.getAttribute('content'), originalViewport,
        `${name}: slow keyboard opening changed the viewport at 80% height`)
      await page.evaluate(() => {
        Object.defineProperty(window.visualViewport, 'height', { configurable: true, get: () => innerHeight * 0.55 })
        window.visualViewport.dispatchEvent(new Event('resize'))
      })
      await page.waitForTimeout(220)
      const keyboardViewport = await viewportMeta.getAttribute('content')
      assert.equal(keyboardViewport, originalViewport,
        `${name}: the keyboard animation changed the landscape viewport`)
      await page.setViewportSize({ width: viewport.width, height: viewport.height - 46 })
      await page.waitForTimeout(220)
      assert.equal(await viewportMeta.getAttribute('content'), keyboardViewport,
        `${name}: the browser chrome changed the viewport while the keyboard was open`)
      await page.evaluate(() => {
        const second = document.createElement('input')
        second.type = 'text'
        second.dataset.viewportSecond = ''
        second.style.position = 'fixed'
        document.body.append(second)
        second.focus()
        window.visualViewport.dispatchEvent(new Event('resize'))
      })
      await page.waitForTimeout(220)
      const switchedViewport = await viewportMeta.getAttribute('content')
      assert(Math.abs(Number(switchedViewport.slice(6)) - Number(keyboardViewport.slice(6))) <= 2,
        `${name}: switching focused fields zoomed the landscape viewport`)
      await page.evaluate(() => {
        document.querySelector('[data-viewport-test]').remove()
        document.querySelector('[data-viewport-second]').remove()
        Object.defineProperty(window.visualViewport, 'height', { configurable: true, get: () => innerHeight * 0.58 })
        window.visualViewport.dispatchEvent(new Event('resize'))
      })
      await page.waitForTimeout(220)
      const blurredViewport = await viewportMeta.getAttribute('content')
      assert(Math.abs(Number(blurredViewport.slice(6)) - Number(keyboardViewport.slice(6))) <= 4,
        `${name}: the viewport changed before the keyboard finished closing: ${blurredViewport}`)
      await page.evaluate(() => {
        delete window.visualViewport.height
        window.visualViewport.dispatchEvent(new Event('resize'))
      })
      await page.waitForFunction((previous) => document.querySelector('meta[name="viewport"]').content !== previous,
        originalViewport, { timeout: 3000 })
      for (const card of await cards.all()) {
        assert(await card.evaluate((element) => element.getBoundingClientRect().bottom <=
          visualViewport.offsetTop + visualViewport.height && element.scrollHeight <= element.clientHeight),
        `${name}: the browser toolbar clips a panel after the keyboard closes`)
      }
      await page.setViewportSize(viewport)
      await page.waitForFunction((expected) => document.querySelector('meta[name="viewport"]').content === expected,
        originalViewport, { timeout: 3000 })
    }
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
    if (touch) {
      const viewportMeta = page.locator('meta[name="viewport"]')
      const originalViewport = await viewportMeta.getAttribute('content')
      await page.getByRole('checkbox').first().focus()
      await page.setViewportSize({ width: viewport.width, height: viewport.height - 46 })
      await page.waitForFunction((previous) => document.querySelector('meta[name="viewport"]').content !== previous,
        originalViewport, { timeout: 3000 })
      assert.notEqual(await viewportMeta.getAttribute('content'), originalViewport,
        `${name}: a focused modifier checkbox blocked the landscape viewport update`)
      await page.setViewportSize(viewport)
      await page.waitForFunction((expected) => document.querySelector('meta[name="viewport"]').content === expected,
        originalViewport, { timeout: 3000 })
    }
    if (useWebkit) {
      await context.close()
      continue
    }
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
  const firstLoadContext = await browser.newContext({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true })
  await firstLoadContext.addInitScript(() => {
    const visual = window.visualViewport
    Object.defineProperty(visual, 'height', {
      configurable: true,
      get: () => visual.width * (document.readyState === 'loading' ? 390 : 344) / 844,
    })
    addEventListener('resize', (event) => event.stopImmediatePropagation(), true)
    visual.addEventListener('resize', (event) => event.stopImmediatePropagation(), true)
  })
  const firstLoadPage = await firstLoadContext.newPage()
  firstLoadPage.on('pageerror', (error) => errors.push(String(error)))
  await firstLoadPage.goto(`http://localhost:${server.httpServer.address().port}`, { waitUntil: 'load' })
  await firstLoadPage.waitForFunction(() => {
    const width = Number(document.querySelector('meta[name="viewport"]')?.content.slice(6))
    return Math.abs(width - 1767) <= 2
  }, null, { timeout: 3000 })
  await firstLoadPage.locator('.start-menu__nav').waitFor()
  const firstLoadTitle = await firstLoadPage.locator('.start-menu').evaluate((menu) => {
    const title = menu.querySelector('.start-menu__title').getBoundingClientRect()
    const nav = menu.querySelector('.start-menu__nav').getBoundingClientRect()
    const version = menu.querySelector('.start-menu__version').getBoundingClientRect()
    return { gap: nav.top - title.bottom, versionBottom: version.bottom,
      visibleBottom: visualViewport.offsetTop + visualViewport.height }
  })
  assert(firstLoadTitle.gap >= 24 && firstLoadTitle.versionBottom <= firstLoadTitle.visibleBottom,
    `initial browser chrome clipped the title menu: ${JSON.stringify(firstLoadTitle)}`)
  await firstLoadPage.screenshot({ path: `${output}/horizontal-phone-initial-title-browser-chrome.png` })
  await firstLoadPage.getByRole('button', { name: 'Single Player', exact: true }).click()
  const firstLoadCards = firstLoadPage.getByRole('region', { name: 'Run modes' }).locator('.start-menu__mode-choice')
  await firstLoadCards.first().waitFor()
  await firstLoadPage.screenshot({ path: `${output}/horizontal-phone-initial-browser-chrome.png` })
  for (const card of await firstLoadCards.all()) {
    assert(await card.evaluate((element) => {
      const box = element.getBoundingClientRect()
      const visible = window.visualViewport
      return box.top >= visible.offsetTop && box.bottom <= visible.offsetTop + visible.height &&
        element.scrollHeight <= element.clientHeight
    }), 'initial landscape load with browser chrome clipped a mode panel')
  }
  await firstLoadContext.close()
  assert.deepEqual(errors, [])
  console.log(useWebkit
    ? '✓ WebKit run panels: landscape mode cards, browser chrome, and keyboard passed'
    : '✓ Run panels: mode navigation, keyboard, reachability and touch passed on desktop and horizontal phone')
} finally {
  await browser.close()
  await server.close()
}
