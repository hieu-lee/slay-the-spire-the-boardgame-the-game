import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createServer as createViteServer } from 'vite'
import { createRoomServer } from './room-server.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'artifacts/multiplayer-ui-browser')
mkdirSync(out, { recursive: true })

const rooms = createRoomServer()
const roomAddress = await rooms.listen(0)
const vite = await createViteServer({
  root,
  logLevel: 'silent',
  server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: `http://127.0.0.1:${roomAddress.port}` }, '/ws': { target: `http://127.0.0.1:${roomAddress.port}`, ws: true } } },
})
await vite.listen()
const address = vite.httpServer?.address()
if (!address || typeof address === 'string') throw new Error('vite did not report a port')
const origin = `http://127.0.0.1:${address.port}`
const browser = await chromium.launch({ headless: true })

async function openExpedition(page, name, character) {
  await page.goto(origin, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Play online', exact: true }).click()
  const entry = page.locator('.online-entry')
  await entry.waitFor()
  await entry.getByLabel('Your name').fill(name)
  await entry.locator('.online-character-roster').getByRole('button', { name: character, exact: true }).click()
  return entry
}

try {
  for (const viewport of [{ name: 'desktop', width: 1440, height: 900 }, { name: 'landscape-phone', width: 560, height: 315 }]) {
    const context = await browser.newContext({ viewport })
    const page = await context.newPage()
    const browserErrors = []
    page.on('pageerror', (error) => browserErrors.push(String(error)))
    page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()) })

    const entry = await openExpedition(page, `UI ${viewport.name}`, 'Silent')
    await page.screenshot({ path: join(out, `${viewport.name}-entry.png`) })
    const entryChrome = await entry.evaluate((screen) => {
      const ribbon = screen.querySelector('.ribbon-back')
      const selected = screen.querySelector('.online-character-roster__portrait[aria-pressed="true"]')
      const unselected = screen.querySelector('.online-character-roster__portrait[aria-pressed="false"]')
      const ribbonBox = ribbon?.getBoundingClientRect()
      return {
        ribbonClip: ribbon ? getComputedStyle(ribbon).clipPath : 'none',
        ribbonRed: ribbon ? getComputedStyle(ribbon).backgroundImage.includes('235, 37, 19') : false,
        ribbonVisible: Boolean(ribbonBox && ribbonBox.left >= 0 && ribbonBox.top >= 0 && ribbonBox.right <= innerWidth && ribbonBox.bottom <= innerHeight),
        selected: selected?.getAttribute('aria-label'),
        unselectedBorder: unselected ? getComputedStyle(unselected).borderColor : '',
        selectedBorder: selected ? getComputedStyle(selected).borderColor : '',
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
      }
    })
    assert.notEqual(entryChrome.ribbonClip, 'none', `${viewport.name}: back ribbon lost its silhouette`)
    assert(entryChrome.ribbonRed, `${viewport.name}: back ribbon lost its red treatment`)
    assert(entryChrome.ribbonVisible, `${viewport.name}: entry back ribbon leaves the viewport`)
    const entryBack = entry.getByRole('button', { name: 'Back to solo table', exact: true })
    await entryBack.hover()
    await page.waitForTimeout(250)
    await page.screenshot({ path: join(out, `${viewport.name}-entry-back-hover.png`) })
    const entryBackHover = await entryBack.evaluate((button) => ({
      filter: getComputedStyle(button).filter,
      outline: getComputedStyle(button).outlineStyle,
    }))
    assert(entryBackHover.filter.includes('brightness(1.2)') && entryBackHover.filter.includes('drop-shadow'), `${viewport.name}: back hover lost its clean glow: ${JSON.stringify(entryBackHover)}`)
    assert.equal(entryBackHover.outline, 'none', `${viewport.name}: back hover retains the clipped outline`)
    for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+Tab')
    await page.waitForTimeout(250)
    const entryBackFocus = await entryBack.evaluate((button) => ({
      focusVisible: button.matches(':focus-visible'),
      outline: getComputedStyle(button).outlineStyle,
    }))
    assert(entryBackFocus.focusVisible, `${viewport.name}: keyboard navigation did not focus Back`)
    assert.equal(entryBackFocus.outline, 'none', `${viewport.name}: back focus restores the clipped outline`)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.mouse.move(1, 1)
    await page.keyboard.press('Tab')
    const entryBackReducedRest = await entryBack.evaluate((button) => getComputedStyle(button).boxShadow)
    await page.keyboard.press('Shift+Tab')
    const entryBackReducedFocus = await entryBack.evaluate((button) => ({
      boxShadow: getComputedStyle(button).boxShadow,
      focusVisible: button.matches(':focus-visible'),
    }))
    assert(entryBackReducedFocus.focusVisible && entryBackReducedFocus.boxShadow !== entryBackReducedRest,
      `${viewport.name}: reduced-motion Back loses its keyboard-focus cue`)
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.emulateMedia({ forcedColors: 'active' })
    const entryBackForcedFocus = await entryBack.evaluate((button) => ({
      focusVisible: button.matches(':focus-visible'),
      outline: getComputedStyle(button).outlineStyle,
    }))
    assert(entryBackForcedFocus.focusVisible && entryBackForcedFocus.outline !== 'none',
      `${viewport.name}: forced-colors Back loses its keyboard-focus cue`)
    await page.emulateMedia({ forcedColors: 'none' })
    assert.equal(entryChrome.selected, 'Silent', `${viewport.name}: hero strip did not select Silent`)
    assert.notEqual(entryChrome.unselectedBorder, entryChrome.selectedBorder, `${viewport.name}: all entry heroes look selected`)
    assert(!entryChrome.overflow, `${viewport.name}: entry overflows horizontally`)

    await entry.getByRole('button', { name: 'Back to solo table', exact: true }).click()
    await page.getByRole('button', { name: 'Single Player', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Single Player', exact: true }).click()
    await page.getByRole('button', { name: 'Custom', exact: true }).click()
    const customBack = await page.locator('.start-menu__run-options .ribbon-back').evaluate((button) => ({
      clip: getComputedStyle(button).clipPath,
      red: getComputedStyle(button).backgroundImage.includes('235, 37, 19'),
    }))
    assert.notEqual(customBack.clip, 'none', `${viewport.name}: Custom Back lost its ribbon silhouette`)
    assert(customBack.red, `${viewport.name}: Custom Back retained its old brown treatment`)

    const entryAgain = await openExpedition(page, `Room ${viewport.name}`, 'Ironclad')
    await entryAgain.getByRole('button', { name: 'Create room', exact: true }).click()
    const lobby = page.locator('.online-lobby')
    await lobby.waitFor()
    await page.screenshot({ path: join(out, `${viewport.name}-lobby.png`) })
    const lobbyChrome = await lobby.evaluate((screen) => {
      const panel = screen.querySelector('.online-lobby__table')
      const roster = screen.querySelector('.online-character-roster')
      const ribbon = screen.querySelector('.ribbon-back')
      const panelBox = panel?.getBoundingClientRect()
      const ribbonBox = ribbon?.getBoundingClientRect()
      return {
        seats: screen.querySelectorAll('.online-seat').length,
        roster: roster?.querySelectorAll('button').length,
        selected: roster?.querySelector('[aria-pressed="true"]')?.getAttribute('aria-label'),
        ribbonClip: ribbon ? getComputedStyle(ribbon).clipPath : 'none',
        ribbonVisible: Boolean(ribbonBox && ribbonBox.left >= 0 && ribbonBox.top >= 0 && ribbonBox.right <= innerWidth && ribbonBox.bottom <= innerHeight),
        ribbonClear: Boolean(ribbonBox && panelBox && ribbonBox.bottom <= panelBox.top),
        withinViewport: Boolean(panelBox && panelBox.left >= -1 && panelBox.right <= innerWidth + 1),
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
        scrollTop: scrollY,
      }
    })
    assert.equal(lobbyChrome.seats, 4, `${viewport.name}: party staging lost seats`)
    assert.equal(lobbyChrome.roster, 8, `${viewport.name}: party character strip lost heroes`)
    assert.equal(lobbyChrome.selected, 'Ironclad', `${viewport.name}: lobby selection diverged from the room`)
    assert.notEqual(lobbyChrome.ribbonClip, 'none', `${viewport.name}: lobby leave ribbon lost its silhouette`)
    assert(lobbyChrome.ribbonVisible, `${viewport.name}: lobby leave ribbon leaves the viewport`)
    assert(lobbyChrome.ribbonClear, `${viewport.name}: lobby leave ribbon overlaps the party table`)
    assert(lobbyChrome.withinViewport && !lobbyChrome.overflow, `${viewport.name}: lobby does not fit its viewport`)
    assert.equal(lobbyChrome.scrollTop, 0, `${viewport.name}: lobby retained stale form scroll`)

    await lobby.getByRole('button', { name: 'Enter the Spire', exact: true }).click()
    await page.getByRole('heading', { name: 'Neow’s Blessing', exact: true }).waitFor()
    await context.close()
    assert.deepEqual(browserErrors, [], `${viewport.name}: browser errors\n${browserErrors.join('\n')}`)
    console.log(`✓ multiplayer ${viewport.name}`)
  }
} finally {
  await browser.close()
  await vite.close()
  await rooms.close()
}
