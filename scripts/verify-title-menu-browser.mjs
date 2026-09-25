import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium, webkit } from './lib/profile-browser.mjs'
import { createRoomServer } from './room-server.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const useWebkit = process.env.BROWSER === 'webkit'
const output = join(root, `artifacts/title-menu${useWebkit ? '-webkit' : ''}`)
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
const browser = await (useWebkit ? webkit : chromium).launch(
  useWebkit && process.env.WEBKIT_EXECUTABLE_PATH ? { executablePath: process.env.WEBKIT_EXECUTABLE_PATH } : undefined)

try {
  for (const [screen, viewport, phone] of [
    ['desktop', { width: 1440, height: 900 }, false],
    ['landscape-phone', { width: 844, height: 390 }, true],
    ['narrow-landscape-phone', { width: 568, height: 320 }, true],
  ]) {
    const context = await browser.newContext({ viewport, isMobile: phone, hasTouch: phone })
    const page = await context.newPage()
    await page.goto(`http://127.0.0.1:${address.port}`)
    await page.locator('.start-menu__nav').waitFor()
    assert.equal(await page.getByText('THE BOARD GAME', { exact: true }).count(), 0, `${screen}: removed subtitle is visible`)
    assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), phone, `${screen}: unexpected pointer mode`)
    for (const saved of [false, true]) {
      const label = saved ? `saved-${screen}` : screen
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
        await Promise.all(['title-spire.webp', 'title-flame.webp', 'menu-ornament.webp'].map(async asset => {
          const image = new Image()
          image.src = `/assets/menu/${asset}`
          await image.decode()
        }))
        await document.querySelector('.start-menu__title img').decode()
      })
      const layout = await page.locator('.start-menu').evaluate((menu) => {
        const box = (selector) => menu.querySelector(selector).getBoundingClientRect().toJSON()
        return {
          width: innerWidth, height: innerHeight,
          title: box('.start-menu__title'), nav: box('.start-menu__nav'), version: box('.start-menu__version'),
          buttons: [...menu.querySelectorAll('.start-menu__nav button')].map((button) => button.getBoundingClientRect().toJSON()),
        }
      })
      assert(layout.nav.top >= layout.title.bottom + (phone ? 24 : 8), `${label}: options are too close to the title: ${JSON.stringify(layout)}`)
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
      assert.equal(await page.locator('.start-menu__title img').getAttribute('alt'), 'Slay the Spire')
      const flame = page.locator('.start-menu__title-flame')
      assert.equal(await flame.evaluate(element => getComputedStyle(element, '::before').animationName), 'title-flame-burn')
      assert.equal(await flame.getAttribute('aria-hidden'), 'true')
      const burn = await flame.evaluate(element => {
        const style = getComputedStyle(element, '::before')
        return { duration: style.animationDuration, timing: style.animationTimingFunction }
      })
      assert.deepEqual(burn, { duration: '0.7s', timing: 'steps(7)' })
      const transform = await flame.evaluate(element => getComputedStyle(element, '::before').transform)
      await page.waitForFunction(previous => getComputedStyle(document.querySelector('.start-menu__title-flame'), '::before').transform !== previous, transform)
      await page.emulateMedia({ reducedMotion: 'reduce' })
      assert.equal(await flame.evaluate(element => getComputedStyle(element, '::before').animationName), 'none')
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      const menuStyle = await page.locator('.start-menu__nav button').first().evaluate(button => {
        const style = getComputedStyle(button)
        return { font: style.fontFamily, stroke: style.webkitTextStrokeWidth, spacing: style.letterSpacing }
      })
      assert(menuStyle.font.includes('Kreon') && parseFloat(menuStyle.stroke) >= 3 && parseFloat(menuStyle.spacing) > 0,
        `${label}: reference menu typography is missing: ${JSON.stringify(menuStyle)}`)
      await page.screenshot({ path: join(output, `${label}.png`) })
      if (!phone) {
        const option = page.getByRole('button', { name: 'Settings', exact: true })
        await option.hover()
        await page.waitForFunction(() => getComputedStyle(document.querySelector('.start-menu__nav button:last-child'), '::before').opacity === '1')
        assert.equal(await option.evaluate(button => getComputedStyle(button).backgroundImage), 'none')
        await page.screenshot({ path: join(output, `${label}-hover.png`) })
        await page.mouse.move(0, 0)
        await page.waitForFunction(() => getComputedStyle(document.querySelector('.start-menu__nav button:last-child'), '::before').opacity === '0')
        await page.keyboard.press('Tab')
        await option.focus()
        assert.equal(await option.evaluate(button => button.matches(':focus-visible')), true)
        await page.screenshot({ path: join(output, `${label}-keyboard.png`) })
        await option.evaluate(button => button.blur())
      }
      if (phone) {
        const originalViewport = await page.locator('meta[name="viewport"]').getAttribute('content')
        await page.setViewportSize({ width: viewport.width, height: viewport.height - 46 })
        await page.waitForFunction((previous) => document.querySelector('meta[name="viewport"]').content !== previous,
          originalViewport, { timeout: 3000 })
        const gap = await page.locator('.start-menu__nav').evaluate((nav) =>
          nav.getBoundingClientRect().top - document.querySelector('.start-menu__title').getBoundingClientRect().bottom)
        assert(gap >= 24, `${label}: title and options are too close after browser chrome resizes: ${gap}`)
        await page.screenshot({ path: join(output, `${label}-browser-chrome.png`) })
        await page.setViewportSize(viewport)
        await page.waitForFunction((expected) => document.querySelector('meta[name="viewport"]').content === expected,
          originalViewport, { timeout: 3000 })
        if (viewport.width === 568) {
          await page.setViewportSize({ width: viewport.width, height: viewport.height - 81 })
          await page.waitForFunction((previous) => document.querySelector('meta[name="viewport"]').content !== previous,
            originalViewport, { timeout: 3000 })
          const shortLayout = await page.locator('.start-menu').evaluate((menu) => {
            const title = menu.querySelector('.start-menu__title').getBoundingClientRect()
            const nav = menu.querySelector('.start-menu__nav').getBoundingClientRect()
            const version = menu.querySelector('.start-menu__version').getBoundingClientRect()
            return { gap: nav.top - title.bottom, navBottom: nav.bottom, versionTop: version.top,
              versionBottom: version.bottom, visibleBottom: visualViewport.offsetTop + visualViewport.height }
          })
          assert(shortLayout.gap >= 24 && shortLayout.versionTop >= shortLayout.navBottom + 6 &&
            shortLayout.versionBottom <= shortLayout.visibleBottom,
          `${label}: title menu clipped with a tall browser toolbar: ${JSON.stringify(shortLayout)}`)
          await page.screenshot({ path: join(output, `${label}-short-browser-chrome.png`) })
          await page.setViewportSize(viewport)
          await page.waitForFunction((expected) => document.querySelector('meta[name="viewport"]').content === expected,
            originalViewport, { timeout: 3000 })
        }
      }
      console.log(`${label}: title and options fit and remain centered`)
    }
    const assertTypeface = async () => {
      const wrongFaces = await page.locator('body').evaluate(body => [...body.querySelectorAll('*')]
        .filter(element => element.getClientRects().length && [...element.childNodes].some(node =>
          node.nodeType === Node.TEXT_NODE && node.textContent.trim()))
        .filter(element => !getComputedStyle(element).fontFamily.startsWith('Kreon'))
        .map(element => `${element.tagName}.${element.className}: ${getComputedStyle(element).fontFamily}`))
      assert.deepEqual(wrongFaces, [], `${screen}: visible text uses a competing typeface`)
    }
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('dialog', { name: 'Settings' }).waitFor()
    await assertTypeface()
    await page.screenshot({ path: join(output, `${screen}-settings.png`) })
    const contrast = page.getByRole('checkbox', { name: /High-contrast UI/ })
    await contrast.check()
    assert((await page.locator('.start-menu').evaluate(menu => getComputedStyle(menu).backgroundImage))
      .includes('rgba(0, 0, 0, 0.72)'), 'high contrast needs its dark background layer')
    await contrast.uncheck()
    const motion = page.getByRole('checkbox', { name: /Reduce motion/ })
    await motion.check()
    assert.equal(await page.locator('.start-menu__title-flame').evaluate(element => getComputedStyle(element, '::before').animationName), 'none')
    await motion.uncheck()
    await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: /Back/ }).click()
    await page.getByRole('button', { name: 'Single Player', exact: true }).click()
    await page.getByRole('button', { name: 'Standard', exact: true }).click()
    await page.locator('.start-menu__character-wallpaper[data-decoded]').waitFor()
    await page.waitForFunction(() => document.querySelector('.start-menu__character-wallpaper').getAnimations().every(animation => animation.playState === 'finished'))
    await assertTypeface()
    await page.screenshot({ path: join(output, `${screen}-character.png`) })
    await page.getByRole('button', { name: 'Back', exact: true }).click()
    const backdrop = async selector => page.locator(selector).evaluate(element => {
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return { image: style.backgroundImage, position: style.backgroundPosition, size: style.backgroundSize,
        attachment: style.backgroundAttachment, color: style.backgroundColor,
        width: rect.width, height: rect.height, x: rect.x, y: rect.y }
    })
    const photographBackdrop = async (selector, label) => {
      // `display: none`, not `visibility: hidden`: a hidden child with a filter keeps its
      // compositing layer, which re-rasterizes the backdrop beneath it by a few levels.
      const hidePanels = await page.addStyleTag({ content: `${selector} > * { display: none !important; }` })
      const image = await page.locator(selector).screenshot({ path: join(output, `${screen}-background-${label}.png`) })
      await hidePanels.evaluate(element => element.remove())
      return image
    }
    const menuImage = await photographBackdrop('.start-menu', 'menu')
    const menuBackdrop = await backdrop('.start-menu')
    await page.locator('html').evaluate(element => { element.dataset.highContrast = 'true' })
    const contrastBackdrop = await backdrop('.start-menu')
    await page.locator('html').evaluate(element => { element.dataset.highContrast = 'false' })
    await page.getByRole('button', { name: 'Play online', exact: true }).click()
    await page.locator('.online-entry').waitFor()
    assert.deepEqual(await backdrop('.online-entry'), menuBackdrop, `${screen}: multiplayer entry changes the menu backdrop`)
    assert.equal(Buffer.compare(await photographBackdrop('.online-entry', 'entry'), menuImage), 0,
      `${screen}: multiplayer entry background pixels differ from the menu`)
    await page.screenshot({ path: join(output, `${screen}-multiplayer-entry.png`) })
    await page.getByRole('button', { name: 'Create room', exact: true }).click()
    const lobby = page.locator('.online-lobby')
    await lobby.waitFor()
    assert.deepEqual(await backdrop('.online-lobby'), menuBackdrop, `${screen}: party lobby changes the menu backdrop`)
    assert.equal(Buffer.compare(await photographBackdrop('.online-lobby', 'lobby'), menuImage), 0,
      `${screen}: party lobby background pixels differ from the menu`)
    await page.locator('html').evaluate(element => { element.dataset.highContrast = 'true' })
    assert.deepEqual(await backdrop('.online-lobby'), contrastBackdrop, `${screen}: high contrast changes the lobby backdrop`)
    await page.locator('html').evaluate(element => { element.dataset.highContrast = 'false' })
    assert.equal(await lobby.getByRole('button', { name: 'Achievements' }).count(), 0)
    await assertTypeface()
    await page.screenshot({ path: join(output, `${screen}-lobby.png`) })
    await context.close()
  }
} finally {
  await browser.close()
  await vite.close()
  await rooms.close()
}
