import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium, devices } from './lib/profile-browser.mjs'
import { postNeowRun } from './lib/post-neow-run.mjs'
import { enterRoom } from '../src/game/run.ts'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'artifacts/android-landscape')
mkdirSync(output, { recursive: true })
const server = await createServer({ root, logLevel: 'silent', server: { port: 0 } })
await server.listen()
const browser = await chromium.launch()
const base = postNeowRun('android-landscape', [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
const combat = enterRoom(base, base.map.rows[0][0])

try {
  const layouts = []
  for (const [name, device] of [
    ['iphone', devices['iPhone 13 landscape']],
    ['android', { ...devices['Pixel 7'], viewport: { width: 1024, height: 472 }, screen: { width: 2048, height: 945 } }],
  ]) {
    const context = await browser.newContext(device)
    const page = await context.newPage()
    await page.goto(`http://localhost:${server.httpServer.address().port}`)
    for (const label of ['Single Player', 'Standard', 'Embark', 'Start standard campaign']) {
      await page.getByRole('button', { name: label, exact: true }).click()
    }
    await page.evaluate(run => window.__STS_DEBUG__.setRun(run), combat)
    await page.locator('.hand .card').first().waitFor()
    await page.waitForTimeout(1000)
    const layout = await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
      viewport: document.querySelector('meta[name="viewport"]').content,
      performance: document.documentElement.dataset.mobilePerformance,
      header: document.querySelector('.app-shell__header').getBoundingClientRect().height,
      card: document.querySelector('.hand .card').getBoundingClientRect().height,
      shell: document.querySelector('.app-shell').getBoundingClientRect().toJSON(),
    }))
    assert.match(layout.viewport, /^width=\d+$/, `${name}: not using the phone viewport`)
    assert.equal(layout.performance, 'true', `${name}: mobile performance mode is disabled`)
    assert(layout.shell.left >= 0 && layout.shell.right <= layout.width + 1 &&
      layout.shell.top >= 0 && layout.shell.bottom <= layout.height + 1,
    `${name}: combat shell overflows the phone`)
    layouts.push(layout)
    await page.screenshot({ path: resolve(output, `${name}-combat.png`) })
    if (name === 'android') {
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.waitForFunction(() => document.querySelector('meta[name="viewport"]').content.startsWith('width=device-width'))
      assert.equal(await page.locator('html').getAttribute('data-mobile-performance'), 'false')
      assert.equal(await page.locator('html').evaluate(element => element.style.getPropertyValue('--visible-viewport-height')), '')
      await page.setViewportSize({ width: 960, height: 540 })
      await page.waitForFunction(() => document.querySelector('meta[name="viewport"]').content === 'width=1280')
      assert.equal(await page.locator('html').getAttribute('data-mobile-performance'), 'true')
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.waitForFunction(() => document.querySelector('meta[name="viewport"]').content.startsWith('width=device-width'))
      assert.equal(await page.locator('html').getAttribute('data-mobile-performance'), 'false')
      assert.equal(await page.locator('html').evaluate(element => element.style.getPropertyValue('--visible-viewport-height')), '')
    }
    await context.close()
  }
  for (const property of ['height', 'header', 'card']) {
    assert(Math.abs(layouts[0][property] - layouts[1][property]) < 3,
      `Android and iPhone ${property} differ: ${layouts[0][property]} vs ${layouts[1][property]}`)
  }
  const rotatedContext = await browser.newContext({
    ...devices['Pixel 7'], viewport: { width: 472, height: 1024 }, screen: { width: 945, height: 2048 },
  })
  const rotatedPage = await rotatedContext.newPage()
  await rotatedPage.goto(`http://localhost:${server.httpServer.address().port}`)
  await rotatedPage.setViewportSize({ width: 1024, height: 472 })
  await rotatedPage.waitForFunction(() => document.querySelector('meta[name="viewport"]').content === 'width=1562')
  assert.equal(await rotatedPage.locator('html').getAttribute('data-mobile-performance'), 'true')
  await rotatedContext.close()
  for (const device of [{}, devices['Pixel 7']]) {
    const touchDesktop = await browser.newContext({
      ...device, viewport: { width: 1440, height: 600 }, screen: { width: 2560, height: 1440 },
      isMobile: true, hasTouch: true,
    })
    const desktopPage = await touchDesktop.newPage()
    await desktopPage.goto(`http://localhost:${server.httpServer.address().port}`)
    assert.match(await desktopPage.locator('meta[name="viewport"]').getAttribute('content'), /^width=device-width/)
    assert.equal(await desktopPage.locator('html').getAttribute('data-mobile-performance'), 'false')
    await touchDesktop.close()
  }
  const noVisualContext = await browser.newContext({
    ...devices['Pixel 7'], viewport: { width: 1024, height: 472 }, screen: { width: 2048, height: 945 },
  })
  await noVisualContext.addInitScript(() => Object.defineProperty(window, 'visualViewport', { value: undefined }))
  const noVisualPage = await noVisualContext.newPage()
  await noVisualPage.goto(`http://localhost:${server.httpServer.address().port}`)
  await noVisualPage.waitForFunction(() => document.querySelector('meta[name="viewport"]').content === 'width=1562')
  await noVisualPage.evaluate(() => dispatchEvent(new Event('resize')))
  await noVisualPage.waitForTimeout(200)
  assert.equal(await noVisualPage.locator('meta[name="viewport"]').getAttribute('content'), 'width=1562')
  await noVisualContext.close()
  console.log('Android and iPhone landscape combat layout matched')
} finally {
  await browser.close()
  await server.close()
}
