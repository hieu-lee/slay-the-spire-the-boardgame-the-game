import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { chromium, setTestUsername } from './lib/profile-browser.mjs'
import { createServer } from 'vite'
import { createRoomServer } from './room-server.mjs'

const out = 'artifacts/campaign-browser'
mkdirSync(out, { recursive: true })
const rooms = createRoomServer()
const address = await rooms.listen(0)
const target = `http://127.0.0.1:${address.port}`
const vite = await createServer({ logLevel: 'silent', server: { host: '127.0.0.1', port: 0,
  proxy: { '/api': { target }, '/ws': { target, ws: true } } } })
await vite.listen()
const origin = `http://127.0.0.1:${vite.httpServer.address().port}`
const browser = await chromium.launch({ headless: true })
const errors = []
const campaignAssetPaths = ['menu/campaign-standard-menu.webp', 'menu/campaign-downfall-menu.webp']

async function waitForCampaignAssets(page) {
  await page.waitForFunction((paths) => paths.every((path) => performance.getEntriesByType('resource')
    .some((entry) => entry.name.endsWith(`/assets/${path}`) && entry.responseEnd > 0)), campaignAssetPaths)
}

async function chooseSide(page, campaign, touch = false) {
  // Select the center of each clipped campaign panel.
  const button = page.getByRole('button', { name: campaign === 'base' ? 'Start standard campaign' : 'Start Downfall campaign', exact: true })
  const box = await button.boundingBox()
  const position = { x: box.width * .5, y: box.height * .5 }
  if (touch) await button.tap({ position })
  else await button.click({ position })
}
async function inspect(page, name) {
  const split = page.locator('.campaign-select__split')
  await split.scrollIntoViewIfNeeded()
  await page.waitForFunction(() => [...document.querySelectorAll('.campaign-select__side img')]
    .every((image) => image.dataset.decoded === 'true'))
  const geometry = await split.evaluate((element) => {
    const box = element.getBoundingClientRect()
    return { width: box.width, left: box.left, right: box.right, viewport: innerWidth, top: box.top, bottom: box.bottom, height: innerHeight,
      images: [...element.querySelectorAll('img')].every((image) => image.naturalWidth >= 1280),
      clips: [...element.querySelectorAll('button')].map((button) => getComputedStyle(button).clipPath) }
  })
  assert.equal(geometry.left, 0)
  assert.equal(geometry.right, geometry.viewport)
  assert.equal(geometry.top, 0)
  assert.equal(geometry.bottom, geometry.height)
  assert(geometry.images)
  const back = page.getByRole('button', { name: 'Back', exact: true })
  if (await back.count()) assert.equal(await back.evaluate((el) => el.classList.contains('ribbon-back') && getComputedStyle(el).clipPath !== 'none'), true)
  assert(geometry.clips.every((clip) => clip.startsWith('polygon')))
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: true })
}
try {
  const loadingContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const loadingPage = await loadingContext.newPage()
  const heldRequests = new Map()
  let allRequestsHeld
  const allHeld = new Promise((resolve) => { allRequestsHeld = resolve })
  const delayedAssets = [
    'menu/character-select/character-ironclad-wallpaper.webp',
    ...campaignAssetPaths,
  ]
  await loadingPage.route('**/assets/menu/**', async (route) => {
    const path = delayedAssets.find((asset) => route.request().url().endsWith(`/assets/${asset}`))
    if (!path) return route.continue()
    await new Promise((resolve) => {
      heldRequests.set(path, () => void route.continue().then(resolve, resolve))
      if (heldRequests.size === delayedAssets.length) allRequestsHeld()
    })
  })
  const assetRequests = Promise.all(delayedAssets.map((asset) =>
    loadingPage.waitForRequest((request) => request.url().endsWith(`/assets/${asset}`))))
  await loadingPage.goto(origin, { waitUntil: 'networkidle' })
  await loadingPage.getByRole('button', { name: 'Single Player', exact: true }).click()
  await Promise.all([assetRequests, allHeld])
  await loadingPage.getByRole('button', { name: 'Standard', exact: true }).click()
  assert.equal(await loadingPage.getByRole('button', { name: 'Standard', exact: true }).isDisabled(), true)
  assert.equal(await loadingPage.locator('.start-menu__character-select').count(), 0)
  await loadingPage.locator('.start-menu__mode-loading').waitFor()
  heldRequests.get('menu/character-select/character-ironclad-wallpaper.webp')?.()
  await loadingPage.locator('.start-menu__character-wallpaper').waitFor()
  await loadingPage.getByRole('button', { name: 'Embark', exact: true }).click()
  assert.equal(await loadingPage.getByRole('button', { name: 'Embark', exact: true }).isDisabled(), true)
  assert.equal(await loadingPage.locator('.campaign-select').count(), 0)
  await loadingPage.getByRole('button', { name: 'Back', exact: true }).click()
  await loadingPage.getByRole('button', { name: 'Single Player', exact: true }).waitFor()
  for (const asset of campaignAssetPaths) heldRequests.get(asset)?.()
  await loadingPage.waitForTimeout(50)
  assert.equal(await loadingPage.locator('.campaign-select').count(), 0)
  await loadingContext.close()

  for (const viewport of [{ name: 'desktop', width: 1440, height: 900 }, { name: 'landscape-phone', width: 844, height: 390 }]) {
    for (const [campaign, character] of [['base', 'Guardian'], ['downfall', 'Ironclad']]) {
      const touch = viewport.name === 'landscape-phone'
      const context = await browser.newContext({ viewport, hasTouch: touch })
      const page = await context.newPage()
      page.on('pageerror', (error) => errors.push(String(error)))
      await page.goto(origin, { waitUntil: 'networkidle' })
      await page.getByRole('button', { name: 'Single Player', exact: true }).click()
      await page.getByRole('button', { name: 'Standard', exact: true }).click()
      await page.getByRole('button', { name: character, exact: true }).click()
      await waitForCampaignAssets(page)
      await page.getByRole('button', { name: 'Embark', exact: true }).click()
      await page.locator('.campaign-select').waitFor()
      await inspect(page, `solo-${viewport.name}-${campaign}`)
      await page.getByRole('button', { name: 'Back', exact: true }).click()
      const characterScreen = page.locator('.start-menu__character-select')
      await characterScreen.waitFor()
      assert.equal(await characterScreen.locator('.start-menu__character-wallpaper').evaluate((image) => image.naturalWidth >= 2048), true)
      await page.waitForFunction((name) => [...document.querySelectorAll('button')]
        .some((button) => button.getAttribute('aria-label') === name && button === document.activeElement), character)
      await page.getByRole('button', { name: 'Embark', exact: true }).click()
      await page.locator('.campaign-select').waitFor()
      assert.equal(await page.getByRole('heading', { name: 'Choose your campaign' }).evaluate((el) => el === document.activeElement), true)
      if (!touch) {
        const side = page.locator('.campaign-select__side--base')
        const box = await side.boundingBox()
        await side.hover({ position: { x: box.width * .22, y: box.height * .5 } })
        await page.waitForTimeout(450)
        assert.equal(await side.locator('img').evaluate((img) => getComputedStyle(img).filter), 'brightness(1.08)')
        await page.screenshot({ path: `${out}/solo-desktop-hover.png` })
        await side.focus()
        assert.equal(await side.locator('.campaign-select__copy').evaluate((el) => getComputedStyle(el).outlineWidth), '3px')
        await page.screenshot({ path: `${out}/solo-desktop-focus.png` })
        await page.emulateMedia({ reducedMotion: 'reduce' })
        assert.equal(await side.locator('img').evaluate((el) => getComputedStyle(el).transitionDuration), '0s')
      }
      if (touch) await chooseSide(page, campaign, true)
      else {
        await page.getByRole('button', { name: campaign === 'base' ? 'Start standard campaign' : 'Start Downfall campaign', exact: true }).focus()
        await page.keyboard.press('Enter')
      }
      await page.locator('.neow-screen').waitFor()
      let run = await page.evaluate(() => window.__STS_DEBUG__.getRun())
      assert.equal(run.meta.campaign, campaign)
      assert.equal(run.neow.players.p1.cardId.startsWith('heart_boon_'), character === 'Guardian')
      await page.reload()
      await page.getByRole('button', { name: 'Resume', exact: true }).click()
      await page.locator('.neow-screen').waitFor()
      run = await page.evaluate(() => window.__STS_DEBUG__.getRun())
      assert.equal(run.meta.campaign, campaign)
      await context.close()
    }
    for (const campaign of ['base', 'downfall']) {
      const hostContext = await browser.newContext({ viewport })
      const guestContext = await browser.newContext({ viewport })
      const host = await hostContext.newPage()
      const guest = await guestContext.newPage()
      for (const [page, name, character] of [[host, 'Host', 'Ironclad'], [guest, 'Guest', 'Guardian']]) {
        page.on('pageerror', (error) => errors.push(String(error)))
        await page.goto(origin, { waitUntil: 'networkidle' })
        await setTestUsername(page, name)
        await page.getByRole('button', { name: 'Play online', exact: true }).click()
        await page.locator('.online-character-roster').getByRole('button', { name: character, exact: true }).click()
      }
      await host.getByRole('button', { name: 'Create room', exact: true }).click()
      const code = await host.locator('.online-lobby__code h1').textContent()
      await guest.getByLabel('Room code', { exact: true }).fill(code)
      await guest.getByRole('button', { name: 'Join', exact: true }).click()
      await guest.locator('.online-lobby').waitFor()
      await host.waitForFunction(() => !document.querySelector('.online-lobby__start')?.disabled)
      await Promise.all([waitForCampaignAssets(host), waitForCampaignAssets(guest)])
      assert.equal(await host.locator('.campaign-select').count(), 0)
      await host.getByRole('button', { name: 'Enter the Spire', exact: true }).click()
      await guest.locator('.campaign-select').waitFor()
      await guest.reload()
      await guest.locator('.campaign-select').waitFor()
      await host.getByRole('button', { name: 'Back', exact: true }).click()
      await guest.locator('.online-lobby').waitFor()
      await host.getByRole('button', { name: 'Enter the Spire', exact: true }).click()
      await guest.locator('.campaign-select').waitFor()
      assert.equal(await guest.locator('.campaign-select__side:disabled').count(), 2)
      assert.match(await guest.getByRole('status').textContent(), /Host chooses the campaign/)
      await inspect(host, `online-${viewport.name}-${campaign}`)
      await inspect(guest, `online-guest-${viewport.name}-${campaign}`)
      await chooseSide(host, campaign)
      await host.locator('.neow-screen').waitFor()
      await guest.locator('.neow-screen').waitFor()
      const live = rooms.store.rooms.get(code)
      assert.equal(live.run.meta.campaign, campaign)
      assert.equal(live.run.neow.players[live.seats[0].playerId].cardId.startsWith('heart_boon_'), false)
      assert.equal(live.run.neow.players[live.seats[1].playerId].cardId.startsWith('heart_boon_'), true)
      await guest.reload()
      await guest.locator('.neow-screen').waitFor()
      assert.equal(live.run.meta.campaign, campaign)
      assert.equal(await guest.getByRole('heading', { name: 'The Heart’s Boon', exact: true }).count(), 1)
      await hostContext.close()
      await guestContext.close()
    }
  }
  assert.deepEqual(errors, [])
  console.log('Campaign browser: desktop/landscape, hover/focus/touch, both solo and multiplayer choices, resume/reconnect passed')
} finally {
  await browser.close()
  await vite.close()
  await rooms.close()
}
