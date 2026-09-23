import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from './lib/profile-browser.mjs'
import { createRoomServer } from './room-server.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = join(root, 'artifacts/title-menu')
mkdirSync(output, { recursive: true })
const rooms = createRoomServer()
const roomAddress = await rooms.listen(0)
const target = `http://127.0.0.1:${roomAddress.port}`
const vite = await createServer({ root, logLevel: 'silent', server: {
  host: '127.0.0.1', port: 0, proxy: { '/api': { target }, '/ws': { target, ws: true } },
} })
await vite.listen()
const address = vite.httpServer?.address()
if (!address || typeof address === 'string') throw new Error('vite did not report a port')
const browser = await chromium.launch()

try {
  for (const [label, viewport] of [
    ['desktop', { width: 1440, height: 900 }],
    ['saved-wide-desktop', { width: 1920, height: 900 }],
    ['saved-short-wide-desktop', { width: 1920, height: 768 }],
    ['saved-medium-desktop', { width: 1440, height: 800 }],
    ['saved-desktop', { width: 1280, height: 720 }],
    ['touch-desktop', { width: 1280, height: 540 }],
    ['saved-touch-desktop', { width: 1280, height: 540 }],
    ['saved-touch-boundary-desktop', { width: 1280, height: 621 }],
    ['landscape-phone', { width: 844, height: 390 }],
    ['saved-landscape-phone', { width: 844, height: 390 }],
    ['narrow-landscape-phone', { width: 568, height: 320 }],
  ]) {
    const phone = label.includes('phone')
    const touch = phone || label.includes('touch')
    const saved = label.startsWith('saved')
    const context = await browser.newContext({ viewport, isMobile: phone, hasTouch: touch })
    const page = await context.newPage()
    await page.goto(`http://127.0.0.1:${address.port}`)
    await page.locator('.start-menu__nav').waitFor()
    assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), touch, `${label}: unexpected pointer mode`)
    if (saved) {
      await page.evaluate(async () => {
        const { createRun } = await import('/src/game/run.ts')
        const run = createRun(21, [{ id: 'p1', name: 'TestPlayer', character: 'ironclad' }])
        run.phase = 'map'
        run.neow = null
        localStorage.setItem('sts-solo-run', JSON.stringify({ version: 1, run, built: {
          count: 1, seed: '21', ascension: 0, chooseYourRelic: false, lastStand: false,
          characters: ['ironclad'], meta: { mode: 'standard', modifiers: [], quickStartAct: 1 },
        } }))
      })
      await page.reload()
      await page.getByRole('button', { name: 'Resume', exact: true }).waitFor()
    }
    await page.evaluate(async () => {
      await document.fonts.ready
      const backdrop = new Image()
      backdrop.src = '/assets/menu/title-spire.webp'
      await backdrop.decode()
    })
    const layout = await page.locator('.start-menu').evaluate((menu) => {
      const box = (selector) => menu.querySelector(selector).getBoundingClientRect().toJSON()
      return {
        width: innerWidth, height: innerHeight,
        title: box('.start-menu__title'), nav: box('.start-menu__nav'), version: box('.start-menu__version'),
        buttons: [...menu.querySelectorAll('.start-menu__nav button')].map((button) => button.getBoundingClientRect().toJSON()),
      }
    })
    assert(layout.nav.top >= layout.title.bottom + 8, `${label}: options overlap the title: ${JSON.stringify(layout)}`)
    assert(Math.abs(layout.nav.x + layout.nav.width / 2 - layout.title.x - layout.title.width / 2) < 2,
      `${label}: options are not centered under the title: ${JSON.stringify(layout)}`)
    assert(layout.version.top >= layout.nav.bottom + 6, `${label}: menu overlaps the version: ${JSON.stringify(layout)}`)
    for (const box of [layout.title, layout.nav, ...layout.buttons]) {
      assert(box.left >= 0 && box.top >= 0 && box.right <= layout.width && box.bottom <= layout.height,
        `${label}: title or menu leaves the screen: ${JSON.stringify(layout)}`)
    }
    if (phone) assert(layout.buttons.every((button) => button.height * viewport.width / layout.width >= 22),
      `${label}: a menu target is too short to tap: ${JSON.stringify(layout)}`)
    assert.deepEqual(await page.locator('.start-menu__nav button').allTextContents(),
      [...(saved ? ['Resume'] : []), 'Single Player', 'Multiplayer', 'Leaderboard', 'Stats', 'Replay', 'Compendium', 'Settings'])
    await page.screenshot({ path: join(output, `${label}.png`) })
    if (label === 'desktop') {
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      await page.getByRole('dialog', { name: 'Settings' }).waitFor()
      await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: /Back/ }).click()
      await page.getByRole('button', { name: 'Play online', exact: true }).click()
      await page.getByRole('button', { name: 'Create room', exact: true }).click()
      const lobby = page.locator('.online-lobby')
      await lobby.waitFor()
      assert.equal(await lobby.getByRole('button', { name: 'Achievements' }).count(), 0)
    }
    await context.close()
    console.log(`${label}: title and options fit and remain centered`)
  }
} finally {
  await browser.close()
  await vite.close()
  await rooms.close()
}
