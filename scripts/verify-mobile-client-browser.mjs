#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium, devices, webkit } from 'playwright'
import { preview } from 'vite'
import { createRoomServer } from './room-server.mjs'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'artifacts/mobile-client')
mkdirSync(output, { recursive: true })
const previewServer = await preview({ root, logLevel: 'silent', preview: { host: '127.0.0.1', port: 0 } })
const origin = `http://127.0.0.1:${previewServer.httpServer.address().port}`
const rooms = createRoomServer({ allowedOrigin: origin })
const { port } = await rooms.listen(0)
const roomOrigin = `http://127.0.0.1:${port}`
const failures = []
const browsers = []

async function profile(page, username) {
  page.on('pageerror', error => failures.push(String(error)))
  page.on('response', response => {
    if (response.url().startsWith(origin) && response.status() >= 400) failures.push(`${response.status()} ${response.url()}`)
  })
  await page.route(`${origin}/session.json*`, route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ origin: roomOrigin, protocolVersion: 1 }),
  }))
  await page.goto(origin, { waitUntil: 'networkidle' })
  if (await page.evaluate(() => matchMedia('(pointer: coarse)').matches)) {
    await page.keyboard.press('a')
    assert(await page.evaluate(() => document.activeElement === document.querySelector('#welcome-name')),
      'mobile player who started with a hardware keyboard cannot type their name')
    await page.reload({ waitUntil: 'networkidle' })
  }
  await page.getByRole('button', { name: 'Tap, click, or press any key to start' }).click()
  if (await page.evaluate(() => matchMedia('(pointer: coarse)').matches)) {
    await page.locator('.welcome__panel').evaluate(panel => Promise.all(panel.getAnimations().map(animation => animation.finished)))
    assert(await page.evaluate(() => document.activeElement !== document.querySelector('#welcome-name')),
      'mobile welcome screen raised the keyboard before the player tapped the name field')
    assert(await page.locator('#welcome-name').evaluate(input =>
      parseFloat(getComputedStyle(input).fontSize) * visualViewport.scale >= 16),
    'mobile username font is too small and iOS zooms the form on focus')
    assert(await page.locator('.welcome__panel').evaluate(panel => {
      const bounds = panel.getBoundingClientRect()
      return bounds.top >= 0 && bounds.bottom <= innerHeight
    }), 'mobile welcome sheet is clipped')
    await page.screenshot({ path: `${output}/landscape-phone-registration.png` })
  }
  await page.getByRole('textbox', { name: 'How should we call you?' }).fill(username)
  if (await page.evaluate(() => matchMedia('(pointer: coarse)').matches)) {
    assert(await page.evaluate(() => {
      const title = document.querySelector('.welcome__panel .reward-screen__title').getBoundingClientRect()
      const submit = document.querySelector('.welcome__confirm').getBoundingClientRect()
      // Playwright cannot raise iOS's software keyboard; bound the form to its compact footprint.
      return title.top >= 0 && submit.bottom - title.top <= 240
    }), 'mobile welcome controls exceed the keyboard-safe footprint')
    await page.screenshot({ path: `${output}/landscape-phone-registration-focused.png` })
  }
  await page.getByRole('button', { name: 'Confirm username' }).click()
  await page.getByRole('button', { name: 'Single Player', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Play online', exact: true }).waitFor()
}

try {
  const browserPreflight = await fetch(`${roomOrigin}/api/health`, {
    method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'GET' },
  })
  assert.equal(browserPreflight.status, 204)
  assert.equal(browserPreflight.headers.get('access-control-allow-origin'), origin)
  assert.equal((await fetch(`${roomOrigin}/api/health`, { headers: { origin: 'https://untrusted.example' } })).status, 403)

  const phoneBrowser = await webkit.launch()
  const desktopBrowser = await chromium.launch()
  browsers.push(phoneBrowser, desktopBrowser)
  const phone = await phoneBrowser.newPage({ ...devices['iPhone 13 landscape'], viewport: { width: 844, height: 390 }, screen: { width: 844, height: 390 } })
  const desktop = await desktopBrowser.newPage({ viewport: { width: 1440, height: 900 } })
  await profile(phone, 'iOSHost')
  assert(await phone.evaluate(() => innerWidth >= 1280 && matchMedia('(pointer: coarse)').matches && /iPhone/.test(navigator.userAgent)),
    'phone fixture did not apply the real mobile Safari viewport policy')
  await phone.screenshot({ path: `${output}/landscape-phone-menu.png` })
  await phone.getByRole('button', { name: 'Single Player', exact: true }).click()
  await phone.getByRole('button', { name: 'Standard', exact: true }).click()
  await phone.getByRole('button', { name: 'Embark', exact: true }).click()
  await phone.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
  await phone.waitForFunction(() => JSON.parse(localStorage.getItem('sts-solo-run') ?? 'null')?.run?.phase === 'neow')
  await phone.screenshot({ path: `${output}/landscape-phone-solo.png` })
  await phone.reload({ waitUntil: 'networkidle' })
  await phone.getByRole('button', { name: 'Resume', exact: true }).waitFor()
  await phone.getByRole('button', { name: 'Play online', exact: true }).click()
  await phone.getByRole('button', { name: 'Create room' }).click()
  const code = await phone.locator('.online-lobby__code h1').innerText()
  assert.match(code, /^[A-Z0-9]{6}$/)

  await profile(desktop, 'DesktopGuest')
  await desktop.getByRole('button', { name: 'Play online', exact: true }).click()
  await desktop.getByRole('button', { name: 'Silent' }).click()
  await desktop.getByLabel('Room code').fill(code)
  await desktop.getByRole('button', { name: 'Join', exact: true }).click()
  await phone.getByLabel('DesktopGuest, Silent, online').waitFor()
  await desktop.getByLabel('iOSHost, Ironclad, online').waitFor()
  await phone.screenshot({ path: `${output}/landscape-phone-multiplayer.png` })
  await desktop.screenshot({ path: `${output}/desktop-multiplayer.png` })
  await phone.getByRole('button', { name: 'Enter the Spire', exact: true }).click()
  await phone.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
  await phone.getByRole('heading', { name: 'Neow’s Blessing', exact: true }).waitFor()
  await desktop.getByRole('heading', { name: 'Neow’s Blessing', exact: true }).waitFor()
  assert((await phone.locator('.app-shell__header').boundingBox()).height <= 70,
    'the phone multiplayer HUD wrapped over the play area')
  await phone.screenshot({ path: `${output}/landscape-phone-multiplayer-run.png` })
  await phone.reload({ waitUntil: 'networkidle' })
  await phone.getByRole('heading', { name: 'Neow’s Blessing', exact: true }).waitFor()

  assert.deepEqual(failures, [])
  writeFileSync(resolve(output, 'report.json'), JSON.stringify({
    bundleIndexSha256: createHash('sha256').update(readFileSync(resolve(root, 'dist/index.html'))).digest('hex'),
    phone: ['registered through hosted session', 'solo run saved', 'multiplayer room joined and started', 'room reconnected after reload'],
    desktop: 'joined phone room', browserOrigin: 'HTTP preflight and multiplayer WebSocket accepted', failures,
  }, null, 2))
  console.log(`Mobile web client E2E verified: ${output}/report.json`)
} finally {
  await Promise.all(browsers.map(browser => browser.close()))
  await rooms.close()
  await new Promise(resolve => previewServer.httpServer.close(resolve))
}
