// The Shop in a real browser, on desktop and a horizontal phone: the coin purse
// on the main menu, the Card Packs shelf (owned, affordable and short states),
// the confirm-and-celebrate purchase, browsing a pack's cards at full size, the
// Skins tab (buying the Kratos skin, wearing it, locked racks), keyboard use, and the wallet that boss victories fill — once,
// and never from a replay or the tutorial. Screenshots land in artifacts/shop/.
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium, webkit } from './lib/profile-browser.mjs'
import { createRoomServer } from './room-server.mjs'
import { joinRoom } from './lib/rooms.mjs'
import { CARD_PACK_PRICE, SKIN_PRICE } from '../src/game/coins.ts'
import { CARD_PACK_IDS, CARD_PACKS } from '../src/game/packs.ts'
import { SKIN_IDS, skinsOf } from '../src/game/skins.ts'
import { BASE_CHARACTER_IDS } from '../src/game/types.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = join(root, 'artifacts/shop')
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
// `--skins=all` runs only the three-skin pass at the end (the normal run does both).
const multiSkinsOnly = process.argv.includes('--skins=all')
let url = `http://127.0.0.1:${address.port}`
const browser = await chromium.launch()
// What the registry holds: the skin offers and the locked racks of heroes without a skin.
const HERO_NAME = { ironclad: 'Ironclad', silent: 'Silent', defect: 'Defect', watcher: 'Watcher' }
const offeredSkins = [...SKIN_IDS]
const lockedHeroes = BASE_CHARACTER_IDS.filter((hero) => skinsOf(hero).length === 0)
const price = CARD_PACK_PRICE.toLocaleString('en-US')

const wallet = (coins, packs = [], extra = {}) => ({ version: 1, coins, packs, skins: [], credited: {}, ...extra })
const storedSkins = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('sts-skins:testplayer') ?? 'null'))
// The test profile is signed in, so its wallet lives under its account's key (seeded
// anonymously below, then adopted by the account on first read).
const storedWallet = (page) => page.evaluate(async () => {
  const { currentWalletKey } = await import('/src/wallet-storage.ts')
  return JSON.parse(localStorage.getItem(currentWalletKey()) ?? 'null')
})

async function open(viewport, phone, seed, { engine = browser, base = url } = {}) {
  const context = await engine.newContext({ viewport, deviceScaleFactor: 1, isMobile: phone, hasTouch: phone })
  if (seed) await context.addInitScript((value) => {
    // Seeded once per browser, not per tab: a second tab must not reset the wallet.
    if (!localStorage.getItem('seeded-wallet')) {
      localStorage.setItem('sts-wallet', JSON.stringify(value))
      localStorage.setItem('seeded-wallet', '1')
    }
  }, seed)
  const page = await context.newPage()
  page.setDefaultTimeout(15_000)
  page.setDefaultNavigationTimeout(90_000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(base)
  await page.locator('.start-menu__nav').waitFor()
  return { context, page, errors }
}

async function settledImages(page, selector) {
  await page.waitForFunction((query) => [...document.querySelectorAll(query)]
    .every((image) => image.complete && image.naturalWidth > 0), selector, { timeout: 15_000 })
  // Loaded is not painted: wait for every image to finish decoding too.
  await page.locator(selector).evaluateAll((images) => Promise.all(images.map((image) => image.decode().catch(() => {}))))
}

/**
 * Lets an element's entry animations (and its children's) run to the end before a
 * screenshot. Delayed ones are exits (the toast's fade-out) and are not waited for.
 */
async function settledAnimations(locator) {
  await locator.evaluate((element) => Promise.all(element.getAnimations({ subtree: true })
    .filter((animation) => animation.effect?.getTiming().delay === 0 && animation.effect.getTiming().iterations !== Infinity)
    .map((animation) => animation.finished)))
}

/** Screenshots only once every image on screen has loaded and decoded, so no card is an empty outline. */
async function paintedShot(page, name) {
  const onScreen = 'img:not([hidden])'
  await page.waitForFunction((query) => [...document.querySelectorAll(query)].filter((image) => {
    const box = image.getBoundingClientRect()
    return box.width > 0 && box.bottom > 0 && box.right > 0 && box.top < innerHeight && box.left < innerWidth
  }).every((image) => image.complete), onScreen, { timeout: 20_000 })
  await page.evaluate((query) => Promise.all([...document.querySelectorAll(query)]
    .filter((image) => image.complete && image.naturalWidth > 0).map((image) => image.decode().catch(() => {}))), onScreen)
  const shot = await page.screenshot({ path: join(output, name) })
  await assertFansPainted(page, shot, name)
}

/**
 * `complete` and `decode()` can both succeed while a tile still paints empty (async decoding
 * on mobile emulation did). So read the screenshot's own pixels: wherever a pack-fan card is
 * the topmost thing, its art must vary, where an unpainted card shows flat backdrop.
 */
async function assertFansPainted(page, shot, name) {
  const blank = await page.evaluate(async (dataUrl) => {
    const picture = new Image()
    picture.src = dataUrl
    await picture.decode()
    const canvas = document.createElement('canvas')
    canvas.width = picture.width
    canvas.height = picture.height
    const context = canvas.getContext('2d', { willReadFrequently: true })
    context.drawImage(picture, 0, 0)
    const scale = picture.width / innerWidth
    const faults = []
    // A modal dialog legitimately covers the shelf's fans, and another tab removes them.
    const cards = document.querySelector('dialog[open]') ? []
      : [...document.querySelectorAll('.shop-fan__card')].filter((card) => card.getClientRects().length)
    // Every visible tile owes a sampled fan, even one whose fan was removed or hidden outright.
    const tiles = document.querySelector('dialog[open]') ? []
      : [...document.querySelectorAll('.shop-pack')].filter((tile) => tile.getClientRects().length)
    const sampled = new Map([...tiles, ...cards.map((card) => card.closest('.shop-pack') ?? card.parentElement)].map((tile) => [tile, 0]))
    for (const card of cards) {
      const box = card.getBoundingClientRect()
      const lumas = []
      for (let row = 1; row < 20; row++) for (let column = 1; column < 20; column++) {
        const x = box.left + box.width * column / 20
        const y = box.top + box.height * row / 20
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight || document.elementFromPoint(x, y) !== card) continue
        const [r, g, b] = context.getImageData(Math.floor(x * scale), Math.floor(y * scale), 1, 1).data
        lumas.push(0.299 * r + 0.587 * g + 0.114 * b)
      }
      if (lumas.length < 20) continue
      const tile = card.closest('.shop-pack') ?? card.parentElement
      sampled.set(tile, sampled.get(tile) + 1)
      const mean = lumas.reduce((sum, luma) => sum + luma, 0) / lumas.length
      const deviation = Math.sqrt(lumas.reduce((sum, luma) => sum + (luma - mean) ** 2, 0) / lumas.length)
      if (deviation < 20) faults.push(`${tile.getAttribute('data-pack') ?? card.className} #${[...card.parentElement.children].indexOf(card)} (deviation ${deviation.toFixed(1)})`)
    }
    const unsampled = [...sampled].filter(([, count]) => count === 0).map(([tile]) => tile.getAttribute('data-pack') ?? tile.className)
    return { faults, unsampled }
  }, `data:image/png;base64,${shot.toString('base64')}`)
  assert.deepEqual(blank.faults, [], `${name}: pack art painted blank: ${blank.faults.join('; ')}`)
  // Hidden or covered cards are skipped above, so every tile with a fan must have had a card sampled.
  assert.deepEqual(blank.unsampled, [], `${name}: pack-fan cards could not be sampled for: ${blank.unsampled.join(', ')}`)
}

/** Nothing inside `selector` is cut off by its own box or by the window. */
async function assertUnclipped(page, selector, label) {
  const faults = await page.locator(selector).evaluateAll((elements) => elements.flatMap((element) => {
    const box = element.getBoundingClientRect()
    const name = `${element.className || element.tagName}: ${element.textContent?.trim().slice(0, 40)}`
    const out = []
    if (box.left < -1 || box.top < -1 || box.right > innerWidth + 1 || box.bottom > innerHeight + 1) out.push(`${name} leaves the window`)
    if (element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflowX !== 'visible') out.push(`${name} clips its text`)
    return out
  }))
  assert.deepEqual(faults, [], `${label}: ${faults.join('; ')}`)
}

async function assertSkinRacks(page, label) {
  const shelf = page.getByRole('list', { name: 'Skins on display' })
  const scale = page.viewportSize().width / await page.evaluate(() => innerWidth)
  for (const rack of await shelf.locator('.shop-skin').all()) {
    await rack.evaluate((element) => element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' }))
    const art = await rack.locator('.shop-skin__art').boundingBox()
    assert(art.width * scale >= 120 && art.height * scale >= 120, `${label}: the skin portrait is too small to see its face`)
    const reachable = await rack.evaluate((element) => {
      const box = element.getBoundingClientRect()
      const shelf = element.parentElement.getBoundingClientRect()
      return { skin: element.dataset.skin, box: box.toJSON(), shelf: shelf.toJSON(), children:
        [...element.querySelectorAll('h3, .shop-button, .shop-skin__soon')].map((child) => {
          const own = child.getBoundingClientRect()
          return { box: own.toJSON(), width: child.clientWidth, scroll: child.scrollWidth }
        }) }
    })
    const inside = (inner, outer) => inner.left >= outer.left - 1 && inner.right <= outer.right + 1 &&
      inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1
    assert(inside(reachable.box, reachable.shelf) && reachable.children.every((child) =>
      inside(child.box, reachable.box) && child.scroll <= child.width + 1),
    `${label}: a skin cannot be scrolled fully into view: ${JSON.stringify(reachable)}`)
  }
  await shelf.evaluate((element) => { element.scrollLeft = 0 })
  await shelf.focus()
  await page.keyboard.press('ArrowRight')
  await page.waitForFunction(() => document.querySelector('.shop-skins__racks').scrollLeft > 0)
  await shelf.evaluate((element) => { element.scrollLeft = 0 })
}

/** Every pack tile shows its whole content, and each button sits inside its tile. */
async function assertTilesHoldTheirButtons(page, label) {
  const faults = await page.locator('.shop-pack').evaluateAll((tiles) => tiles.flatMap((tile) => {
    const box = tile.getBoundingClientRect()
    const out = []
    if (tile.scrollHeight > tile.clientHeight + 1) out.push(`${tile.dataset.pack} clips ${tile.scrollHeight - tile.clientHeight}px of its content`)
    for (const button of tile.querySelectorAll('.shop-button, .shop-pack__owned')) {
      const own = button.getBoundingClientRect()
      if (own.bottom > box.bottom - 2 || own.top < box.top) out.push(`${tile.dataset.pack}: "${button.textContent}" spans ${Math.round(own.top)}-${Math.round(own.bottom)}, tile ${Math.round(box.top)}-${Math.round(box.bottom)}`)
    }
    return out
  }))
  assert.deepEqual(faults, [], `${label}: ${faults.join('; ')}`)
}

try {
  if (!multiSkinsOnly) {
  // Short desktop windows (a laptop with browser chrome): nothing is cut off, and the shelf and rail do not scroll.
  for (const viewport of [{ width: 1366, height: 650 }, { width: 1280, height: 643 }]) {
    const screen = `desktop-${viewport.width}x${viewport.height}`
    const { context, page, errors } = await open(viewport, false, wallet(1000, ['slayer_silent']))
    await page.getByRole('button', { name: 'Shop', exact: true }).click()
    await page.locator('.shop-pack').first().waitFor()
    await settledImages(page, '.shop-fan__card')
    await assertTilesHoldTheirButtons(page, screen)
    await assertUnclipped(page, '.shop-pack, .shop-button', `${screen} shelf`)
    const scrolls = await page.evaluate(() => Object.fromEntries(['.shop__packs', '.shop__rail'].map((selector) => {
      const element = document.querySelector(selector)
      return [selector, element.scrollHeight - element.clientHeight]
    })))
    assert(scrolls['.shop__packs'] <= 1 && scrolls['.shop__rail'] <= 1, `${screen}: the shelf or the rail scrolls: ${JSON.stringify(scrolls)}`)
    await paintedShot(page, `${screen}-packs.png`)
    assert.deepEqual(errors, [], `${screen}: page errors`)
    await context.close()
    console.log(`${screen}: Shop shelf fits the short window`)
  }

  for (const [screen, viewport, phone] of [
    ['desktop', { width: 1440, height: 900 }, false],
    ['desktop-1280', { width: 1280, height: 720 }, false],
    ['landscape-phone', { width: 844, height: 390 }, true],
    ['landscape-phone-932', { width: 932, height: 430 }, true],
  ]) {
    const { context, page, errors } = await open(viewport, phone, wallet(1000, ['slayer_silent']))
    const scale = viewport.width / await page.evaluate(() => innerWidth)

    // The purse on the main menu shows the balance and opens the Shop.
    const purse = page.locator('.start-menu__purse')
    assert.equal(await purse.getAttribute('aria-label'), 'Shop · 1000 coins')
    assert.match(await purse.innerText(), /1,000/)
    await paintedShot(page, `${screen}-menu.png`)
    await purse.click()
    await page.locator('.shop').waitFor()
    await page.getByRole('button', { name: 'Back to main menu' }).click()
    await page.getByRole('button', { name: 'Shop', exact: true }).click()

    // The shelf: five packs, their real scans, and each state's action.
    const packs = page.locator('.shop-pack')
    assert.equal(await packs.count(), CARD_PACK_IDS.length)
    assert.deepEqual(await packs.evaluateAll((items) => items.map((item) => item.dataset.pack)), [...CARD_PACK_IDS])
    assert.match(await page.locator('.shop__purse').innerText(), /1,000/)
    assert.equal(await page.getByRole('tab', { name: /^Card Packs/ }).getAttribute('aria-selected'), 'true')
    await settledImages(page, '.shop-fan__card')
    assert(await page.locator('.shop-fan__card').evaluateAll((images) => images.length === 15 &&
      images.every((image) => /\/assets\/cards-sm\/slayer__/.test(image.src))), 'pack art is not the packs\' own scans')
    for (const id of CARD_PACK_IDS) {
      const tile = page.locator(`.shop-pack[data-pack="${id}"]`)
      assert.equal(await tile.locator('.shop-pack__count').textContent(), String(CARD_PACKS[id].cardIds.length))
      await tile.getByRole('button', { name: `Browse the ${CARD_PACKS[id].cardIds.length} cards of the ${CARD_PACKS[id].name}`, exact: true }).waitFor()
      if (id === 'slayer_silent') {
        assert.equal(await tile.getAttribute('data-owned'), 'true')
        assert(await tile.locator('.shop-pack__owned').isVisible())
        assert.equal(await tile.locator('.shop-pack__buy').count(), 0, 'an owned pack can be bought again')
      } else {
        const buy = tile.getByRole('button', { name: `Buy ${CARD_PACKS[id].name}, ${price} coins`, exact: true })
        assert.match(await buy.innerText(), new RegExp(price))
        assert(await buy.isEnabled())
      }
    }
    await assertUnclipped(page, '.shop-pack, .shop-pack h3, .shop-pack__owned, .shop-button, .shop__tab, .shop__purse', `${screen} shelf`)
    await assertTilesHoldTheirButtons(page, screen)
    const shelf = await page.locator('.shop__packs').evaluate((list) => ({ height: list.scrollHeight - list.clientHeight, width: list.scrollWidth - list.clientWidth }))
    assert(shelf.height <= 1 && shelf.width <= 1, `${screen}: the pack shelf scrolls: ${JSON.stringify(shelf)}`)
    if (phone) {
      const short = await page.locator('.shop-button, .shop__tab, .shop__back, .shop__use-packs').evaluateAll((controls, factor) =>
        controls.filter((control) => control.getClientRects().length && control.getBoundingClientRect().height * factor < 22).map((control) => control.textContent), scale)
      assert.deepEqual(short, [], `${screen}: Shop controls too short to tap`)
    }
    await paintedShot(page, `${screen}-packs.png`)

    // Buying asks first; Escape backs out without spending.
    await page.getByRole('button', { name: 'Buy Ironclad Slayer Pack' }).click()
    const confirm = page.getByRole('dialog', { name: 'Buy the Ironclad Slayer Pack?' })
    await confirm.waitFor()
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Cancel', 'the confirmation must not pre-focus the purchase')
    await settledImages(page, '.shop-confirm .shop-fan__card')
    await assertUnclipped(page, '.shop-confirm__panel, .shop-confirm .shop-button', `${screen} confirm`)
    await paintedShot(page, `${screen}-confirm.png`)
    await page.keyboard.press('Escape')
    await confirm.waitFor({ state: 'detached' })
    assert(await page.locator('.shop').isVisible(), 'Escape in the dialog left the Shop')
    assert.equal((await storedWallet(page)).coins, 1000)

    await page.getByRole('button', { name: 'Buy Ironclad Slayer Pack' }).click()
    await page.locator('.shop-confirm .shop-button--buy').click()
    await page.getByRole('dialog', { name: 'Ironclad Slayer Pack unlocked' }).waitFor()
    assert.deepEqual(await storedWallet(page), { ...wallet(1000 - CARD_PACK_PRICE, ['slayer_ironclad', 'slayer_silent']), credited: {} })
    await page.waitForTimeout(900)
    await paintedShot(page, `${screen}-bought.png`)
    await page.getByRole('button', { name: 'Done' }).click()
    await page.locator('.shop-confirm').waitFor({ state: 'detached' })
    assert.equal(await page.locator('.shop-pack[data-pack="slayer_ironclad"]').getAttribute('data-owned'), 'true')
    assert.match(await page.locator('.shop__purse').innerText(), new RegExp(String(1000 - CARD_PACK_PRICE)))

    // The rest are now out of reach, each saying how far and filling toward the price.
    const needed = CARD_PACK_PRICE - (1000 - CARD_PACK_PRICE)
    for (const id of ['slayer_defect', 'slayer_watcher', 'slayer_colorless']) {
      const tile = page.locator(`.shop-pack[data-pack="${id}"]`)
      const buy = tile.getByRole('button', { name: `Not enough coins for ${CARD_PACKS[id].name}, ${price} coins: need ${needed} more`, exact: true })
      assert(await buy.isDisabled())
      assert.equal(Number(await buy.evaluate((button) => getComputedStyle(button).getPropertyValue('--progress'))),
        (1000 - CARD_PACK_PRICE) / CARD_PACK_PRICE)
    }
    await paintedShot(page, `${screen}-insufficient.png`)

    // Browsing a pack: every card, either face, and a zoom of both faces at once.
    await page.getByRole('button', { name: 'Browse the 17 cards of the Colorless Slayer Pack' }).click()
    const browse = page.getByRole('dialog', { name: 'Colorless Slayer Pack' })
    await browse.waitFor()
    const cards = browse.locator('.shop-browse__card')
    assert.equal(await cards.count(), CARD_PACKS.slayer_colorless.cardIds.length)
    await settledImages(page, '.shop-browse__card > img')
    await paintedShot(page, `${screen}-browse.png`)
    await browse.getByText('Upgrades').click()
    await page.waitForFunction(() => [...document.querySelectorAll('.shop-browse__card > img')]
      .every((image) => decodeURIComponent(image.src).includes('+.webp')))
    await cards.nth(2).click()
    const zoom = page.locator('.shop-zoom')
    await zoom.waitFor()
    assert.deepEqual(await zoom.locator('figcaption').allTextContents(), ['Base', 'Upgraded'])
    await settledImages(page, '.shop-zoom__card > img')
    assert.deepEqual(await zoom.locator('.shop-zoom__card > img').evaluateAll((images) =>
      images.map((image) => decodeURIComponent(new URL(image.src).pathname))),
    ['/assets/cards/slayer__colorless__chrysalis.webp', '/assets/cards/slayer__colorless__chrysalis+.webp'])
    await assertUnclipped(page, '.shop-zoom__card', `${screen} zoom`)
    await paintedShot(page, `${screen}-zoom.png`)
    await page.keyboard.press('Escape')
    await zoom.waitFor({ state: 'detached' })
    assert(await browse.isVisible(), 'Escape on the zoom closed the whole pack')
    await page.keyboard.press('Escape')
    await browse.waitFor({ state: 'detached' })
    assert(await page.locator('.shop').isVisible())

    // Skins, reached from the keyboard: the Kratos offer is out of reach with the coins left after a pack, and the
    // heroes without a skin keep locked racks.
    await page.getByRole('tab', { name: /^Card Packs/ }).focus()
    await page.keyboard.press('ArrowDown')
    const skinsTab = page.getByRole('tab', { name: /^Skins/ })
    assert.equal(await skinsTab.getAttribute('aria-selected'), 'true')
    assert(await skinsTab.evaluate((tab) => tab === document.activeElement), 'arrow keys move focus with the tab')
    const skins = page.getByRole('tabpanel', { name: /Skins/ })
    assert.equal(await skins.getByRole('listitem').count(), offeredSkins.length + lockedHeroes.length, `${screen}: every skin and a locked rack for each hero without one`)
    assert.equal(await skins.getByText('Coming soon').count(), lockedHeroes.length)
    assert.deepEqual(await skins.locator('.shop-skin--locked').evaluateAll((racks) => racks.map((rack) => rack.getAttribute('aria-label'))),
      lockedHeroes.map((hero) => `${HERO_NAME[hero]} skin, coming soon`))
    assert.equal(await skins.locator('.shop-skin--locked button, .shop-skin--locked a').count(), 0, 'a locked rack must offer nothing')
    const short = skins.getByRole('button', { name: `Not enough coins for the Kratos skin for Ironclad, ${SKIN_PRICE.toLocaleString('en-US')} coins: need ${(SKIN_PRICE - (1000 - CARD_PACK_PRICE)).toLocaleString('en-US')} more` })
    assert(await short.isDisabled(), `${screen}: Kratos is not for sale below its price`)
    assert.match(await short.innerText(), /2,500/)
    await settledImages(page, '.shop-skin__portrait')
    await assertSkinRacks(page, `${screen} skins`)
    await paintedShot(page, `${screen}-skins.png`)

    // Escape with no dialog open returns to the main menu, whose purse caught up.
    await page.keyboard.press('Escape')
    await page.locator('.start-menu__nav').waitFor()
    assert.match(await page.locator('.start-menu__purse').innerText(), new RegExp(String(1000 - CARD_PACK_PRICE)))
    assert.deepEqual(errors, [], `${screen}: page errors`)
    await context.close()
    console.log(`${screen}: Shop shelf, purchase, browse and skins verified`)
  }

  // Buying the Kratos skin: confirm, spend 2,500 coins, own and wear it at once; wear it on and off; it survives a reload.
  for (const [screen, viewport, phone] of [
    ['desktop-1366x650', { width: 1366, height: 650 }, false],
    ['desktop-1280x643', { width: 1280, height: 643 }, false],
    ['desktop-1440', { width: 1440, height: 900 }, false],
    ['landscape-phone', { width: 844, height: 390 }, true],
    ['landscape-phone-932', { width: 932, height: 430 }, true],
  ]) {
    const { context, page, errors } = await open(viewport, phone, wallet(SKIN_PRICE + 300))
    const press = (locator) => phone ? locator.tap() : locator.click()
    await page.getByRole('button', { name: 'Shop', exact: true }).click()
    await press(page.getByRole('tab', { name: /^Skins/ }))
    const rack = page.locator('.shop-skin[data-skin="kratos"]')
    await rack.waitFor()
    await settledImages(page, '.shop-skin__portrait')
    assert.match(await rack.locator('.shop-skin__portrait').evaluate((image) => image.currentSrc), /portrait-kratos\.png$/)
    assert.equal(await rack.locator('h3').innerText().then((text) => text.replace(/\s+/g, ' ')), 'Kratos Ironclad')
    assert.equal(await rack.getAttribute('data-owned'), null)
    const buy = rack.getByRole('button', { name: `Buy the Kratos skin for Ironclad, ${SKIN_PRICE.toLocaleString('en-US')} coins` })
    assert(await buy.isEnabled(), `${screen}: the price is covered`)
    await assertSkinRacks(page, `${screen} skins`)
    await paintedShot(page, `${screen}-skins-offer.png`)
    await press(buy)
    const dialog = page.getByRole('dialog', { name: 'Buy the Kratos skin for Ironclad?' })
    await dialog.waitFor()
    await settledImages(page, '.shop-confirm__portrait')
    assert.match(await dialog.innerText(), /2,800[\s\S]*after buying[\s\S]*300/, `${screen}: the dialog shows the balance before and after`)
    await assertUnclipped(page, '.shop-confirm__panel, .shop-confirm .shop-button', `${screen} skin confirm`)
    await page.screenshot({ path: join(output, `${screen}-skin-confirm.png`) })
    // Cancelling spends nothing.
    await press(dialog.getByRole('button', { name: 'Cancel' }))
    await dialog.waitFor({ state: 'detached' })
    assert.deepEqual((await storedWallet(page)).skins, [])
    assert.equal((await storedWallet(page)).coins, SKIN_PRICE + 300)
    assert.equal(await storedSkins(page), null, `${screen}: nothing is worn before a purchase`)
    await press(buy)
    await dialog.waitFor()
    await press(dialog.locator('.shop-button--buy'))
    const unlocked = page.getByRole('dialog', { name: 'Kratos skin for Ironclad unlocked' })
    await unlocked.waitFor()
    await settledAnimations(unlocked)
    await assertUnclipped(page, '.shop-confirm__panel, .shop-confirm .shop-button', `${screen} skin unlocked`)
    await page.screenshot({ path: join(output, `${screen}-skin-unlocked.png`) })
    const after = await storedWallet(page)
    assert.deepEqual(after.skins, ['kratos'])
    assert.equal(after.coins, 300, `${screen}: exactly 2,500 coins were spent`)
    assert.deepEqual(after.packs, [], 'a skin purchase touched the packs')
    assert.deepEqual(await storedSkins(page), { ironclad: 'kratos' }, `${screen}: a bought skin is worn at once`)
    assert.equal(await unlocked.getByRole('button', { name: 'Browse' }).count(), 0, 'a skin has no pack to browse')
    await press(unlocked.getByRole('button', { name: 'Done' }))
    await unlocked.waitFor({ state: 'detached' })
    assert.match(await page.locator('.shop__purse').innerText(), /300/)
    // The rack: Owned seal, no price, a pressed Worn control.
    assert.equal(await rack.getAttribute('data-owned'), 'true')
    assert.equal(await rack.getAttribute('data-worn'), 'true')
    assert(await rack.locator('.shop-skin__seal').isVisible(), `${screen}: the Owned seal`)
    assert.equal(await rack.locator('.shop-skin__buy').count(), 0, 'an owned skin can be bought again')
    const worn = rack.getByRole('button', { name: /^Worn: Kratos/ })
    assert.equal(await worn.getAttribute('aria-pressed'), 'true')
    await assertSkinRacks(page, `${screen} skin owned`)
    if (phone) {
      const scale = viewport.width / await page.evaluate(() => innerWidth)
      assert.deepEqual(await page.locator('.shop-skin .shop-button').evaluateAll((controls, factor) =>
        controls.filter((control) => control.getBoundingClientRect().height * factor < 22).map((control) => control.textContent), scale), [],
      `${screen}: skin controls too short to tap`)
    }
    await paintedShot(page, `${screen}-skins-owned.png`)
    // One tap takes it off, one tap puts it on, and the choice is the Profile's too.
    await press(worn)
    const wear = rack.getByRole('button', { name: /^Wear: Kratos/ })
    assert.equal(await wear.getAttribute('aria-pressed'), 'false')
    assert.deepEqual(await storedSkins(page), {})
    await press(wear)
    assert.equal(await rack.getByRole('button', { name: /^Worn: Kratos/ }).getAttribute('aria-pressed'), 'true')
    assert.deepEqual(await storedSkins(page), { ironclad: 'kratos' })
    // Ownership is the wallet's: it stays after a reload, and so does the pressed state.
    await page.reload()
    await page.locator('.start-menu__nav').waitFor()
    await page.getByRole('button', { name: 'Shop', exact: true }).click()
    await press(page.getByRole('tab', { name: /^Skins/ }))
    await rack.waitFor()
    assert.equal(await rack.getAttribute('data-worn'), 'true')
    assert.equal((await storedWallet(page)).coins, 300)
    assert.deepEqual(errors, [], `${screen}: page errors`)
    await context.close()
    console.log(`${screen}: the Kratos skin is bought, owned and worn from the Shop`)
  }

  {
    // Refusals: not enough coins never sells, a balance spent elsewhere is refused at confirmation,
    // and a skin already owned elsewhere is never charged twice. Owning without wearing offers Wear.
    const { context, page } = await open({ width: 1440, height: 900 }, false, wallet(SKIN_PRICE - 1))
    await page.getByRole('button', { name: 'Shop', exact: true }).click()
    await page.getByRole('tab', { name: /^Skins/ }).click()
    const buy = page.getByRole('button', { name: /^Not enough coins for the Kratos skin for Ironclad/ })
    assert(await buy.isDisabled(), 'one coin short must not sell')
    await buy.click({ force: true }).catch(() => {})
    assert.equal(await page.locator('.shop-confirm').count(), 0, 'a disabled Buy opened the dialog')
    await page.evaluate(() => {
      const key = Object.keys(localStorage).find((name) => name.startsWith('sts-wallet:'))
      localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key)), coins: 2500 }))
      window.dispatchEvent(new Event('sts-wallet-change'))
    })
    await page.getByRole('button', { name: `Buy the Kratos skin for Ironclad, ${SKIN_PRICE.toLocaleString('en-US')} coins` }).click()
    await page.evaluate(() => {
      const key = Object.keys(localStorage).find((name) => name.startsWith('sts-wallet:'))
      localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key)), coins: 10 }))
    })
    await page.locator('.shop-confirm .shop-button--buy').click()
    await page.getByRole('alert').filter({ hasText: 'You no longer have enough coins.' }).waitFor()
    assert.deepEqual((await storedWallet(page)).skins, [], 'a stale confirmation still sold the skin')
    assert.equal((await storedWallet(page)).coins, 10)
    assert.equal(await storedSkins(page), null)
    await context.close()

    // Owned (bought on another device) but not worn: the rack offers Wear, and wearing it is one tap.
    const owned = await open({ width: 1440, height: 900 }, false, wallet(5, [], { skins: ['kratos'] }))
    await owned.page.getByRole('button', { name: 'Shop', exact: true }).click()
    await owned.page.getByRole('tab', { name: /^Skins/ }).click()
    const rack = owned.page.locator('.shop-skin[data-skin="kratos"]')
    assert.equal(await rack.getAttribute('data-owned'), 'true')
    assert.equal(await rack.getAttribute('data-worn'), null)
    assert.equal(await rack.getByRole('button', { name: /^Wear: Kratos/ }).getAttribute('aria-pressed'), 'false')
    await rack.getByRole('button', { name: /^Wear: Kratos/ }).click()
    assert.deepEqual(await storedSkins(owned.page), { ironclad: 'kratos' })
    assert.equal(await rack.getAttribute('data-worn'), 'true')
    // Another tab sees it without a reload.
    const second = await owned.context.newPage()
    await second.goto(url)
    await second.locator('.start-menu__nav').waitFor()
    await second.getByRole('button', { name: 'Shop', exact: true }).click()
    await second.getByRole('tab', { name: /^Skins/ }).click()
    await second.locator('.shop-skin[data-skin="kratos"][data-worn="true"]').waitFor()
    await second.getByRole('button', { name: /^Worn: Kratos/ }).click()
    await rack.and(owned.page.locator(':not([data-worn])')).waitFor()
    await owned.context.close()
    console.log('skin refusals, owned-not-worn and cross-tab wear verified')
  }

  {
    // The "Play with my packs" switch: shown only to an owner, on by default, off keeps the packs but deals none, per account, survives a reload.
    const none = await open({ width: 1440, height: 900 }, false, wallet(0))
    await none.page.getByRole('button', { name: 'Shop', exact: true }).click()
    await none.page.locator('.shop-pack').first().waitFor()
    assert.equal(await none.page.getByRole('checkbox', { name: /Play with my packs/ }).count(), 0, 'a player with no pack is offered the switch')
    await none.context.close()

    const { context, page, errors } = await open({ width: 1440, height: 900 }, false, wallet(0, ['slayer_silent', 'slayer_colorless']))
    const dealt = () => page.evaluate(async () => (await import('/src/pack-preference.ts')).selectedCardPacks())
    const stored = () => page.evaluate(() => localStorage.getItem('sts-use-packs:testplayer'))
    await page.getByRole('button', { name: 'Shop', exact: true }).click()
    const packSwitch = page.getByRole('checkbox', { name: /Play with my packs/ })
    await packSwitch.waitFor()
    assert.equal(await packSwitch.isChecked(), true, 'the packs are not on by default')
    assert.deepEqual(await dealt(), ['slayer_silent', 'slayer_colorless'])
    await packSwitch.click()
    assert.equal(await packSwitch.isChecked(), false)
    assert.equal(await stored(), 'false')
    assert.deepEqual(await dealt(), [], 'switched-off packs are still dealt')
    assert.match(await page.locator('.shop__use-packs').innerText(), /base cards only/)
    assert.deepEqual((await storedWallet(page)).packs, ['slayer_silent', 'slayer_colorless'], 'switching off lost ownership')
    assert.equal(await page.locator('.shop-pack[data-owned="true"]').count(), 2, 'the Shop stopped showing owned packs')
    // Another tab hears it, and a reload keeps it.
    const second = await context.newPage()
    await second.goto(url)
    await second.locator('.start-menu__nav').waitFor()
    await second.getByRole('button', { name: 'Shop', exact: true }).click()
    assert.equal(await second.getByRole('checkbox', { name: /Play with my packs/ }).isChecked(), false)
    await second.getByRole('checkbox', { name: /Play with my packs/ }).click()
    await page.waitForFunction(() => document.querySelector('.shop__use-packs input').checked)
    assert.equal(await stored(), null, 'turning it back on keeps a stored choice')
    await second.close()
    await packSwitch.click()
    await page.reload()
    await page.locator('.start-menu__nav').waitFor()
    await page.getByRole('button', { name: 'Shop', exact: true }).click()
    assert.equal(await page.getByRole('checkbox', { name: /Play with my packs/ }).isChecked(), false, 'the choice was lost on reload')
    assert.deepEqual(await dealt(), [])
    // A run started now plays without them; switching them back on deals them again.
    const startRun = async () => {
      await page.getByRole('button', { name: 'Single Player', exact: true }).click()
      await page.getByRole('button', { name: 'Standard', exact: true }).click()
      await page.getByRole('button', { name: 'Embark' }).click()
      await page.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
      await page.waitForFunction(() => window.__STS_DEBUG__?.getRun().phase === 'neow')
      return page.evaluate(() => window.__STS_DEBUG__.getRun().meta.cardPacks)
    }
    await page.reload()
    await page.locator('.start-menu__nav').waitFor()
    assert.equal(await startRun(), undefined, 'a run started with the packs switched off still plays them')
    await page.reload()
    await page.evaluate(async () => (await import('/src/pack-preference.ts')).setPlayWithPacks(true))
    await page.locator('.start-menu__nav').waitFor()
    assert.deepEqual(await startRun(), ['slayer_silent', 'slayer_colorless'], 'switching the packs back on dealt none')
    assert.deepEqual(errors, [], 'switch: page errors')
    await context.close()
    console.log('the play-with-my-packs switch is owner-only, per account, and keeps ownership')
  }

  {
    // Keyboard only: Tab to Buy, Enter, Tab past Cancel, Enter. A stale balance
    // (another tab spent the coins) is refused at confirmation.
    const { context, page } = await open({ width: 1440, height: 900 }, false, wallet(CARD_PACK_PRICE * 2))
    await page.getByRole('button', { name: 'Shop', exact: true }).click()
    await page.locator('.shop').waitFor()
    const buyDefect = page.getByRole('button', { name: 'Buy Defect Slayer Pack' })
    const browseDefect = page.getByRole('button', { name: 'Browse the 7 cards of the Defect Slayer Pack' })
    for (let presses = 0; presses < 40 && !await browseDefect.evaluate((button) => button === document.activeElement); presses += 1) {
      await page.keyboard.press('Tab')
    }
    assert(await browseDefect.evaluate((button) => button === document.activeElement && button.matches(':focus-visible')),
      'a pack\'s card fan is not reachable with Tab')
    await page.keyboard.press('Tab')
    assert(await buyDefect.evaluate((button) => button === document.activeElement && button.matches(':focus-visible')),
      'Buy is not reachable with Tab')
    await settledImages(page, '.shop-fan__card')
    await paintedShot(page, 'desktop-keyboard-focus.png')
    await page.keyboard.press('Enter')
    await page.getByRole('dialog', { name: 'Buy the Defect Slayer Pack?' }).waitFor()
    await page.keyboard.press('Tab')
    await page.keyboard.press('Enter')
    await page.getByRole('dialog', { name: 'Defect Slayer Pack unlocked' }).waitFor()
    assert.deepEqual((await storedWallet(page)).packs, ['slayer_defect'])
    // The celebration's Browse (just before the focused Done) opens the new pack's cards.
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Enter')
    const boughtBrowse = page.getByRole('dialog', { name: 'Defect Slayer Pack' })
    await boughtBrowse.waitFor()
    await page.locator('.shop-confirm').waitFor({ state: 'detached' })
    assert.equal(await boughtBrowse.locator('.shop-browse__card').count(), CARD_PACKS.slayer_defect.cardIds.length)
    await page.keyboard.press('Escape')
    await boughtBrowse.waitFor({ state: 'detached' })
    await page.getByRole('button', { name: 'Buy Watcher Slayer Pack' }).click()
    await page.evaluate(() => {
      const key = Object.keys(localStorage).find((name) => name.startsWith('sts-wallet:'))
      const stored = JSON.parse(localStorage.getItem(key))
      localStorage.setItem(key, JSON.stringify({ ...stored, coins: 10 }))
    })
    await page.locator('.shop-confirm .shop-button--buy').click()
    await page.getByRole('alert').filter({ hasText: 'You no longer have enough coins.' }).waitFor()
    assert.deepEqual((await storedWallet(page)).packs, ['slayer_defect'], 'a stale confirmation still bought the pack')
    assert.equal((await storedWallet(page)).coins, 10)
    await context.close()
    console.log('keyboard purchase and stale-balance refusal verified')
  }

  {
    // Earning: a run started with owned packs plays them. Its boss only promises coins;
    // they reach the wallet when the result is recorded, once.
    const startStandardRun = async (page) => {
      await page.getByRole('button', { name: 'Single Player', exact: true }).click()
      await page.getByRole('button', { name: 'Standard', exact: true }).click()
      await page.getByRole('button', { name: 'Embark' }).click()
      await page.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
      await page.waitForFunction(() => window.__STS_DEBUG__?.getRun().phase === 'neow')
    }
    const winBoss = (page) => page.evaluate(async () => {
      const { enterRoom, roomChoices } = await import('/src/game/run.ts')
      const debug = window.__STS_DEBUG__
      const onMap = { ...structuredClone(debug.getRun()), phase: 'map', neow: null }
      const fighting = enterRoom(onMap, roomChoices(onMap)[0].id)
      const boss = Object.values(fighting.map.rooms).find((room) => room.kind === 'boss')
      debug.setRun({
        ...fighting,
        map: { ...fighting.map, position: boss.id, rooms: { ...fighting.map.rooms, [boss.id]: { ...boss, visited: true } } },
        combat: { ...fighting.combat, phase: 'won', enemies: fighting.combat.enemies.map((enemy) => ({ ...enemy, hp: 0, dead: true, isBoss: true })) },
      })
      const { rollBossCoins } = await import('/src/game/coins.ts')
      return rollBossCoins(fighting.seed, 0, 1, fighting.ascension)
    })
    const owned = ['slayer_ironclad', 'slayer_colorless']
    for (const [screen, viewport, phone] of [['desktop', { width: 1440, height: 900 }, false], ['landscape-phone', { width: 844, height: 390 }, true]]) {
      const { context, page, errors } = await open(viewport, phone, wallet(5, owned))
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await startStandardRun(page)
      const started = await page.evaluate(() => {
        const run = window.__STS_DEBUG__.getRun()
        return { packs: run.meta.cardPacks, rewards: [...run.players[0].cardRewards, ...run.players[0].rareRewards], colorless: run.itemDecks.colorless }
      })
      assert.deepEqual(started.packs, owned)
      assert(CARD_PACKS.slayer_ironclad.cardIds.every((id) => started.rewards.includes(id)), 'the Ironclad pack is not in the run')
      assert(CARD_PACKS.slayer_colorless.cardIds.every((id) => started.colorless.includes(id)), 'the Colorless pack is not in the run')

      const award = await winBoss(page)
      await page.waitForFunction(() => window.__STS_DEBUG__.getRun().campaign.bossCoins?.length === 1)
      const toast = page.locator('.coin-gain__toast')
      await toast.waitFor()
      assert.equal(await toast.getAttribute('data-pending'), 'true')
      assert.match(await toast.innerText(), new RegExp(`\\+${award} coins pending`))
      assert.match(await toast.innerText(), /claimed when you record the run/)
      assert.equal((await storedWallet(page)).coins, 5, `${screen}: a boss win paid before the run was recorded`)
      await settledAnimations(toast)
      await paintedShot(page, `${screen}-bounty-pending.png`)

      // A reload and Resume announce and pay nothing.
      await page.reload()
      await page.getByRole('button', { name: 'Resume', exact: true }).click()
      await page.waitForFunction(() => window.__STS_DEBUG__?.getRun().campaign.bossCoins?.length === 1)
      await page.waitForTimeout(400)
      assert.equal((await storedWallet(page)).coins, 5, `${screen}: resuming paid the unrecorded boss`)
      assert.equal(await page.locator('.coin-gain__toast').count(), 0)
      await page.evaluate(() => {
        const debug = window.__STS_DEBUG__
        debug.setRun({ ...debug.getRun(), phase: 'victory', rewards: [], rewardDestination: null, roomState: null })
      })
      const tally = page.locator('.run-summary__coins')
      await tally.waitFor()
      assert.match(await tally.innerText(), new RegExp(`Coins to claim\\s*${award}`, 'i'))
      assert.match(await tally.innerText(), /record the run to claim/)
      const noteSize = await page.locator('.run-summary__coins-note').evaluate((note, glass) =>
        parseFloat(getComputedStyle(note).fontSize) * glass / innerWidth, viewport.width)
      assert(noteSize >= 10, `${screen}: the "record the run to claim" note is ${noteSize.toFixed(1)}px on screen`)
      await paintedShot(page, `${screen}-victory-summary.png`)

      // Recording the result pays the coins, once.
      await page.getByRole('button', { name: 'Stop and record result' }).click()
      await page.waitForFunction(() => window.__STS_DEBUG__.getRun().campaign.finalized)
      const credited = page.locator('.coin-gain__toast')
      await credited.waitFor()
      assert.equal(await credited.getAttribute('data-pending'), null)
      assert.match(await credited.innerText(), new RegExp(`\\+${award} coins`))
      assert.match(await credited.innerText(), new RegExp(`Run recorded · ${5 + award} in your purse`))
      assert.equal((await storedWallet(page)).coins, 5 + award, `${screen}: recording did not pay the boss`)
      await settledAnimations(credited)
      await paintedShot(page, `${screen}-bounty-credited.png`)
      await page.reload()
      await page.locator('.start-menu__nav, .campaign-end').first().waitFor()
      await page.waitForTimeout(500)
      assert.equal((await storedWallet(page)).coins, 5 + award, `${screen}: reloading a recorded run paid it twice`)
      assert.deepEqual(errors, [])
      await context.close()
    }

    // A run left without recording pays nothing, even when another run replaces it.
    const { context, page } = await open({ width: 1440, height: 900 }, false, wallet(5))
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await startStandardRun(page)
    await winBoss(page)
    await page.waitForFunction(() => window.__STS_DEBUG__.getRun().campaign.bossCoins?.length === 1)
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Return to main menu' }).click()
    await page.locator('.start-menu__nav').waitFor()
    assert.match(await page.locator('.start-menu__purse').getAttribute('aria-label'), /Shop · 5 coins/)
    await startStandardRun(page)
    await page.waitForTimeout(400)
    assert.equal((await storedWallet(page)).coins, 5, 'an abandoned run paid its boss')
    await context.close()
    // One recorded run pays one account per browser: after recording, switching account
    // offers no Resume, and even a forced second recording pays the new account nothing.
    {
      const { context, page } = await open({ width: 1440, height: 900 }, false, wallet(0))
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await startStandardRun(page)
      const bounty = await winBoss(page)
      await page.waitForFunction(() => window.__STS_DEBUG__.getRun().campaign.bossCoins?.length === 1)
      await page.evaluate(() => {
        const debug = window.__STS_DEBUG__
        debug.setRun({ ...debug.getRun(), phase: 'victory', rewards: [], rewardDestination: null, roomState: null })
      })
      await page.getByRole('button', { name: 'Stop and record result' }).waitFor()
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: 'Return to main menu' }).click()
      await page.getByRole('button', { name: 'Resume', exact: true }).click()
      await page.getByRole('button', { name: 'Stop and record result' }).click()
      await page.waitForFunction(() => window.__STS_DEBUG__.getRun().campaign.finalized)
      assert.equal((await storedWallet(page)).coins, bounty)
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: 'Return to main menu' }).click()
      await page.locator('.start-menu__nav').waitFor()
      // The recorded run resumes into its campaign journal, never back to the victory it was recorded from.
      await page.getByRole('button', { name: 'Resume', exact: true }).click()
      await page.locator('.campaign-end').waitFor()
      assert.equal(await page.getByRole('button', { name: 'Stop and record result' }).count(), 0, 'Resume offered the recorded run\'s victory again')
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: 'Return to main menu' }).click()
      await page.locator('.start-menu__nav').waitFor()
      // The real account switch: profile.ts signs in a new account and clears the play in progress.
      await page.evaluate(async () => {
        const { registerProfile } = await import('/src/profile.ts')
        await registerProfile('SecondPlayer', 'second player password')
      })
      await page.waitForFunction(() => !document.querySelector('.start-menu__nav button[aria-label="Resume"]') &&
        document.querySelector('.start-menu__purse')?.getAttribute('aria-label') === 'Shop · 0 coins')
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('sts-profile')).username), 'SecondPlayer')
      // A second tab that still shows the unrecorded victory records it as this account: nothing is paid.
      const paid = await page.evaluate(async (awards) => {
        const { creditRunCoins } = await import('/src/wallet-storage.ts')
        const key = Object.keys(JSON.parse(localStorage.getItem('sts-paid-runs')))[0]
        return creditRunCoins(key, awards).coins
      }, [{ act: 1, coins: bounty }])
      assert.equal(paid, 0, 'a second account was paid for a run already recorded on this browser')
      assert.equal((await storedWallet(page))?.coins ?? 0, 0, 'the second account has no coins')
      await context.close()
    }
    // A bounty toast never outlives its run: not after a tutorial and Resume, not on a new run.
    {
      const { context, page } = await open({ width: 1440, height: 900 }, false, wallet(0))
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await startStandardRun(page)
      await winBoss(page)
      await page.locator('.coin-gain__toast[data-pending]').waitFor()
      await page.locator('.coin-gain__toast').waitFor({ state: 'detached', timeout: 10_000 })
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: 'Return to main menu' }).click()
      await page.getByRole('button', { name: 'Tutorial', exact: true }).click()
      await page.getByRole('button', { name: 'Start tutorial' }).click()
      await page.waitForFunction(() => window.__STS_DEBUG__?.getRun().phase === 'neow')
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: 'Leave tutorial' }).click()
      await page.getByRole('button', { name: 'Resume', exact: true }).click()
      await page.waitForFunction(() => window.__STS_DEBUG__.getRun().campaign.bossCoins?.length === 1)
      await page.waitForTimeout(500)
      assert.equal(await page.locator('.coin-gain__toast').count(), 0, 'Resume after the tutorial announced the old bounty again')
      // Abandon it for a new run while the app stays mounted (the toast state must not carry over).
      await page.evaluate(() => window.__STS_DEBUG__.reset(1, 'a fresh seed'))
      await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'neow')
      await page.waitForTimeout(500)
      assert.equal(await page.evaluate(() => window.__STS_DEBUG__.getRun().campaign.bossCoins?.length ?? 0), 0)
      assert.equal(await page.locator('.coin-gain__toast').count(), 0, 'a new run showed the abandoned run\'s bounty')
      // A new run started WHILE a bounty is on screen takes that toast down at once.
      await winBoss(page)
      await page.locator('.coin-gain__toast[data-pending]').waitFor()
      await page.evaluate(() => window.__STS_DEBUG__.reset(1, 'another fresh seed'))
      await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'neow')
      await page.locator('.coin-gain__toast').waitFor({ state: 'detached', timeout: 1_000 })
      await context.close()
    }

    // Two tabs: tab A's run was started by TestPlayer; tab B signs in a new account. Tab A
    // leaves the run, offers no record button, and the new account is never paid for it.
    {
      const { context, page } = await open({ width: 1440, height: 900 }, false, wallet(0))
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await startStandardRun(page)
      await winBoss(page)
      await page.evaluate(() => {
        const debug = window.__STS_DEBUG__
        debug.setRun({ ...debug.getRun(), phase: 'victory', rewards: [], rewardDestination: null, roomState: null })
      })
      await page.getByRole('button', { name: 'Stop and record result' }).waitFor()
      const other = await context.newPage()
      await other.goto(url)
      await other.locator('.start-menu__nav').waitFor()
      await other.evaluate(async () => {
        const { registerProfile } = await import('/src/profile.ts')
        await registerProfile('OtherAcct', 'other account password')
      })
      await page.locator('.start-menu__nav').waitFor()
      assert.equal(await page.getByRole('button', { name: 'Stop and record result' }).count(), 0, 'tab A still offers to record the old account\'s run')
      assert.equal(await page.getByRole('button', { name: 'Resume', exact: true }).count(), 0, 'the new account was offered the old account\'s run')
      assert.equal(await page.evaluate(() => localStorage.getItem('sts-solo-run')), null, 'tab A saved the old run under the new account')
      assert.equal((await storedWallet(page))?.coins ?? 0, 0, 'the new account was paid for the old account\'s run')
      await context.close()
    }
    console.log('solo boss coins are pending until recorded, then paid once')
  }

  {
    // The tutorial's boss and a replayed run's bosses pay nothing and announce nothing.
    const { context, page } = await open({ width: 1440, height: 900 }, false, wallet(7))
    await page.getByRole('button', { name: 'Tutorial', exact: true }).click()
    await page.getByRole('button', { name: 'Start tutorial' }).click()
    await page.waitForFunction(() => window.__STS_DEBUG__?.getRun().phase === 'neow')
    assert.equal(await page.evaluate(() => window.__STS_DEBUG__.getRun().meta.cardPacks), undefined)
    await page.evaluate(() => {
      const debug = window.__STS_DEBUG__
      const run = debug.getRun()
      debug.setRun({ ...run, campaign: { ...run.campaign, bossCoins: [{ act: 1, coins: 12 }] } })
    })
    await page.waitForTimeout(400)
    assert.equal((await storedWallet(page)).coins, 7, 'the tutorial paid a boss')
    assert.equal(await page.locator('.coin-gain__toast').count(), 0, 'the tutorial announced a bounty')

    await page.goto(url)
    await page.getByRole('button', { name: 'Replay', exact: true }).click()
    await page.getByText('Give your run to me', { exact: true }).waitFor()
    await page.locator('.run-replay-import').evaluate(async (screen) => {
      const { createRun } = await import('/src/game/run.ts')
      const initial = createRun(77, [{ id: 'p1', name: 'Replay Tester', character: 'ironclad' }])
      // The bosses fall during playback, so a replay that announced bounties would show one.
      const final = structuredClone(initial)
      final.campaign.bossCoins = [{ act: 1, coins: 11 }, { act: 2, coins: 22 }]
      final.phase = 'defeat'
      final.neow = null
      final.combat = null
      const log = { version: 2, runId: initial.campaign.runId, initial, events: [{ patch: [{ path: [], value: final }] }] }
      const transfer = new DataTransfer()
      transfer.items.add(new File([JSON.stringify(log)], 'run.json', { type: 'application/json' }))
      screen.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
    })
    await page.waitForFunction(() => window.__STS_DEBUG__?.getRun().campaign.bossCoins?.length === 2)
    await page.waitForTimeout(600)
    assert.equal((await storedWallet(page)).coins, 7, 'a replay paid its bosses')
    assert.equal(await page.locator('.coin-gain__toast').count(), 0, 'a replay announced a bounty')
    await context.close()
    console.log('tutorial and replay pay nothing')
  }

  {
    // Online: the lobby names the packs in play, the run freezes them, and each
    // browser pays its own wallet from the snapshot once — reconnects pay nothing.
    for (const [screen, viewport, phone] of [['desktop', { width: 1440, height: 900 }, false], ['landscape-phone', { width: 844, height: 390 }, true]]) {
      const { context, page, errors } = await open(viewport, phone, wallet(3, ['slayer_defect']))
      await page.getByRole('button', { name: 'Play online', exact: true }).click()
      await page.getByRole('button', { name: 'Create room' }).click()
      const strip = page.locator('.online-lobby__packs')
      await strip.waitFor()
      assert.match(await strip.innerText(), /Slayer packs in play[\s\S]*Defect[\s\S]*you/i)
      assert.equal(await strip.locator('li').getAttribute('aria-label'), 'Defect Slayer Pack, from you')
      await assertUnclipped(page, '.online-lobby__packs li, .online-lobby__table', `${screen} lobby`)
      await paintedShot(page, `${screen}-lobby-packs.png`)
      const code = await page.evaluate(() => document.querySelector('.online-lobby__code h1')?.textContent)
      await page.getByRole('button', { name: 'Enter the Spire' }).click()
      await page.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
      await page.getByRole('heading', { name: 'Neow’s Blessing' }).waitFor()
      const live = rooms.store.rooms.get(code)
      assert.deepEqual(live.run.meta.cardPacks, ['slayer_defect'])
      live.run.campaign = { ...live.run.campaign, bossesDefeated: 1, highestBossActDefeated: 1, bossCoins: [{ act: 1, coins: 13 }] }
      live.version += 1
      rooms.publishRoom(code)
      // The boss's bounty is only promised until the party records the run.
      const toast = page.locator('.coin-gain__toast')
      await toast.waitFor()
      assert.equal(await toast.getAttribute('data-pending'), 'true')
      assert.match(await toast.innerText(), /\+13 coins pending/)
      assert.equal((await storedWallet(page)).coins, 3, `${screen}: an unrecorded online boss paid`)
      await settledAnimations(toast)
      await paintedShot(page, `${screen}-online-bounty-pending.png`)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.locator('.connection--connected').waitFor()
      await page.getByRole('heading', { name: 'Neow’s Blessing' }).waitFor()
      await page.waitForTimeout(500)
      assert.equal((await storedWallet(page)).coins, 3, `${screen}: a reconnect paid the unrecorded boss`)
      assert.equal(await page.locator('.coin-gain__toast').count(), 0)
      // Recording the result (`finishRun`) pays this seat's wallet, once.
      live.run = { ...live.run, phase: 'defeat', neow: null, combat: null }
      live.version += 1
      rooms.publishRoom(code)
      await page.getByRole('button', { name: 'Record campaign result' }).click()
      await page.waitForFunction(() => document.querySelector('.coin-gain__toast:not([data-pending])'))
      assert.match(await toast.innerText(), /\+13 coins[\s\S]*Run recorded · 16 in your purse/)
      assert.equal((await storedWallet(page)).coins, 16)
      assert.equal(live.run.campaign.finalized, true)
      await settledAnimations(toast)
      await paintedShot(page, `${screen}-online-bounty-credited.png`)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.locator('.connection--connected').waitFor()
      await page.waitForTimeout(600)
      assert.equal((await storedWallet(page)).coins, 16, `${screen}: a reconnect paid the recorded run again`)
      if (!phone) {
        // Another account signs in afterwards: nothing is withheld (the run was paid here), so no notice.
        const other = await context.newPage()
        await other.goto(url)
        await other.evaluate(async () => {
          const { registerProfile } = await import('/src/profile.ts')
          await registerProfile('LaterAccount', 'later account password')
        })
        await other.close()
        await page.reload({ waitUntil: 'domcontentloaded' })
        await page.locator('.connection--connected').waitFor()
        await page.waitForTimeout(800)
        assert.equal(await page.locator('.coin-gain__notice').count(), 0, 'a notice claimed already-paid coins were withheld')
      }
      assert.deepEqual(errors, [])
      await context.close()
    }
    // Online: another account signing in (in another tab) before the record pays it nothing.
    {
      const { context, page } = await open({ width: 1440, height: 900 }, false, wallet(3))
      await page.getByRole('button', { name: 'Play online', exact: true }).click()
      await page.getByRole('button', { name: 'Create room' }).click()
      await page.locator('.online-lobby').waitFor()
      const code = await page.evaluate(() => document.querySelector('.online-lobby__code h1')?.textContent)
      await page.getByRole('button', { name: 'Enter the Spire' }).click()
      await page.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
      await page.getByRole('heading', { name: 'Neow’s Blessing' }).waitFor()
      const live = rooms.store.rooms.get(code)
      live.run = { ...live.run, phase: 'defeat', neow: null, combat: null,
        campaign: { ...live.run.campaign, bossesDefeated: 1, highestBossActDefeated: 1, bossCoins: [{ act: 1, coins: 13 }] } }
      live.version += 1
      rooms.publishRoom(code)
      await page.getByRole('button', { name: 'Record campaign result' }).waitFor()
      const other = await context.newPage()
      await other.goto(url)
      // This tab may open on the room (its seat is remembered); only the profile module matters here.
      await other.evaluate(async () => {
        const { registerProfile } = await import('/src/profile.ts')
        await registerProfile('OtherSeat', 'other seat password')
      })
      await page.getByRole('button', { name: 'Record campaign result' }).click()
      const notice = page.getByRole('status').filter({ hasText: 'Another account signed in after this seat was taken' })
      await notice.waitFor()
      assert.equal(live.run.campaign.finalized, true)
      assert.equal((await storedWallet(page))?.coins ?? 0, 0, 'a seat\'s coins paid the account that signed in later')
      await notice.getByRole('button', { name: 'Dismiss' }).click()
      await notice.waitFor({ state: 'detached' })
      await context.close()
    }
    console.log('online lobby packs and per-browser boss bounty verified')
  }

  {
    // Two busy tables, both with three 24-character names besides the host: everyone
    // owning every pack, and each player owning different ones. Every chip shows the
    // same compact owner marker, and the strip stays one line inside the lobby board.
    const others = ['silent', 'defect', 'watcher'].map((character, index) => ({ character, name: `Wanderer${index}`.padEnd(24, 'x') }))
    const tables = [
      { label: 'full-table', host: [...CARD_PACK_IDS], seat: () => [...CARD_PACK_IDS],
        markers: CARD_PACK_IDS.map(() => '×4'), owners: 'from you, Wanderer0x+, Wanderer1x+, Wanderer2x+' },
      { label: 'mixed-table', host: ['slayer_ironclad', 'slayer_colorless'], seat: (index) => [['slayer_silent', 'slayer_defect', 'slayer_watcher'][index]],
        markers: ['you', 'WA', 'WA', 'WA', 'you'], owners: 'from you' },
    ]
    for (const table of tables) for (const [screen, viewport, phone] of [['desktop', { width: 1440, height: 900 }, false], ['landscape-phone', { width: 844, height: 390 }, true]]) {
      const { context, page, errors } = await open(viewport, phone, wallet(0, table.host))
      await page.getByRole('button', { name: 'Play online', exact: true }).click()
      await page.getByRole('button', { name: 'Create room' }).click()
      await page.locator('.online-lobby__packs').waitFor()
      const code = await page.evaluate(() => document.querySelector('.online-lobby__code h1')?.textContent)
      const live = rooms.store.rooms.get(code)
      for (const [index, other] of others.entries()) {
        joinRoom(live, { name: other.name, character: other.character, cardPacks: table.seat(index), connected: false })
      }
      rooms.publishRoom(code)
      await page.waitForFunction(() => document.querySelectorAll('.online-seat:not(.online-seat--empty)').length === 4)
      const strip = page.locator('.online-lobby__packs')
      await page.waitForFunction((count) => document.querySelectorAll('.online-lobby__packs li').length === count, CARD_PACK_IDS.length)
      assert.deepEqual(await strip.locator('li small').allTextContents(), table.markers, `${screen} ${table.label}: owner markers`)
      assert.match(await strip.locator('li').first().getAttribute('aria-label'), new RegExp(`^Ironclad Slayer Pack, ${table.owners}$`))
      if (table.label === 'mixed-table') assert.equal(await strip.locator('li').nth(1).getAttribute('aria-label'), `Silent Slayer Pack, from ${others[0].name}`)
      const layout = await page.evaluate(() => {
        const box = (element) => element.getBoundingClientRect().toJSON()
        const strip = document.querySelector('.online-lobby__packs')
        const panels = ['.online-lobby__ascension', '.online-lobby__character', '.online-lobby__toolbar', '.online-lobby__status',
          '.online-lobby__leave', '.online-lobby__start', '.online-lobby__alerts']
          .flatMap((selector) => [...document.querySelectorAll(selector)]).filter((element) => element.getClientRects().length)
        return { strip: box(strip), board: box(document.querySelector('.online-lobby__table')), panels: panels.map(box),
          chips: [...strip.querySelectorAll('li')].map(box), lineHeight: strip.querySelector('li').getBoundingClientRect().height,
          markers: [...strip.querySelectorAll('li small')].map((marker) => {
            const own = marker.getBoundingClientRect()
            const chip = marker.closest('li').getBoundingClientRect()
            return { width: own.width, cut: marker.scrollWidth > marker.clientWidth + 1 || own.right > chip.right + 0.5 }
          }) }
      })
      const inside = (inner, outer) => inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5 &&
        inner.top >= outer.top - 0.5 && inner.bottom <= outer.bottom + 0.5
      const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
      const where = `${screen} ${table.label}`
      assert(inside(layout.strip, layout.board), `${where}: the pack strip leaves the lobby board: ${JSON.stringify(layout)}`)
      assert(layout.chips.every((chip) => inside(chip, layout.strip)), `${where}: a pack chip is cut off: ${JSON.stringify(layout)}`)
      assert(layout.markers.every((marker) => !marker.cut && marker.width >= 8), `${where}: an owner marker is hidden or cut: ${JSON.stringify(layout.markers)}`)
      assert(layout.strip.height <= layout.lineHeight * 1.6, `${where}: the pack strip wraps: ${JSON.stringify(layout)}`)
      assert(layout.panels.every((panel) => !overlaps(layout.strip, panel)), `${where}: the pack strip overlaps a lobby panel: ${JSON.stringify(layout)}`)
      await paintedShot(page, `${screen}-lobby-${table.label}.png`)
      assert.deepEqual(errors, [])
      await context.close()
    }
    console.log('busy tables\' pack strips stay one line inside the lobby board, every owner marked')
  }

  {
    // A saved run adds Resume: every option must still fit a 1280x720 desktop.
    const { context, page } = await open({ width: 1280, height: 720 }, false)
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
    await page.evaluate(() => document.querySelector('.start-menu__title img').decode())
    const fit = await page.evaluate(() => {
      const box = (selector) => document.querySelector(selector).getBoundingClientRect()
      return { title: box('.start-menu__title').bottom, navTop: box('.start-menu__nav').top, navBottom: box('.start-menu__nav').bottom,
        version: box('.start-menu__version').top, count: document.querySelectorAll('.start-menu__nav button').length }
    })
    assert.equal(fit.count, 7, 'Resume and the six main options')
    assert(fit.navTop >= fit.title + 8 && fit.navBottom + 6 <= fit.version, `1280x720 menu with Resume overflows: ${JSON.stringify(fit)}`)
    await paintedShot(page, 'desktop-1280-menu-resume.png')
    await context.close()
    console.log('1280x720 menu with Resume and Shop fits')
  }
  }

  // Several skins across heroes: the six real skins of the registry (two for Ironclad), so the offers, the owned/short
  // states and the per-hero Wear toggles run against them directly. Every base hero has a skin, so no rack is locked.
  const cost = SKIN_PRICE.toLocaleString('en-US')
  const OFFERS = [
    ['kratos', 'Kratos', 'Ironclad'], ['monogatari_ironclad', 'Ironclad-chan', 'Ironclad'], ['monogatari_silent', 'Silent-chan', 'Silent'],
    ['monogatari_defect', 'Defect-chan', 'Defect'], ['monogatari_watcher', 'Watcher-chan', 'Watcher'],
    ['anime_slime_boss', 'Rimuru Tempest', 'Slime Boss'],
  ]
  assert.deepEqual(OFFERS.map(([id]) => id), offeredSkins, 'the Shop test lists every registered skin in catalogue order')
  for (const engineName of ['chromium', 'webkit']) {
    for (const [screen, viewport, phone] of [
      ['desktop-1366x650', { width: 1366, height: 650 }, false],
      ['desktop-1280x643', { width: 1280, height: 643 }, false],
      ['desktop-1280x720', { width: 1280, height: 720 }, false],
      ['desktop-1920x1080', { width: 1920, height: 1080 }, false],
      ['phone-844x390', { width: 844, height: 390 }, true],
      ['phone-932x430', { width: 932, height: 430 }, true],
    ]) {
      const engine = engineName === 'webkit' ? await webkit.launch() : browser
      try {
        const label = `${engineName} ${screen}`
        // Six offers (one owned, so Wear shows beside five prices) and no locked rack.
        const { context, page, errors } = await open(viewport, phone, wallet(3000, [], { skins: ['kratos'] }), { engine })
        // WebKit's phone emulation never reports the lazily loaded Shop's controls as stable, so it clicks through the DOM.
        const press = (locator) => phone && engineName === 'webkit' ? locator.dispatchEvent('click') : phone ? locator.tap() : locator.click()
        await page.getByRole('button', { name: 'Shop', exact: true }).click()
        // The Shop is a lazy chunk: on a busy machine WebKit paints "Loading" for a while before the tabs settle.
        await page.locator('.shop').waitFor({ timeout: 60_000 })
        if (phone) await press(page.getByRole('tab', { name: /^Skins/ }))
        else {
          await page.getByRole('tab', { name: /^Card Packs/ }).focus()
          await page.keyboard.press('ArrowDown')
        }
        const racks = page.locator('.shop-skin')
        await racks.first().waitFor()
        await settledImages(page, '.shop-skin__portrait')
        assert.deepEqual(await racks.evaluateAll((items) => items.map((item) => item.dataset.skin ?? 'locked')),
          [...OFFERS.map(([id]) => id), ...lockedHeroes.map(() => 'locked')], `${label}: one rack per skin, then a locked rack for a hero without one`)
        assert.deepEqual(await page.locator('.shop-skin--locked').evaluateAll((items) => items.map((item) => item.getAttribute('aria-label'))),
          lockedHeroes.map((hero) => `${HERO_NAME[hero]} skin, coming soon`), label)
        for (const [id, name, hero] of OFFERS) {
          const rack = page.locator(`.shop-skin[data-skin="${id}"]`)
          assert.equal(await rack.locator('h3').innerText().then((text) => text.replace(/\s+/g, ' ')), `${name} ${hero}`, `${label}: ${id} heading`)
          assert.equal(await rack.getByRole('heading', { name: `${name} ${hero}` }).count(), 1, `${label}: ${id} heading name`)
          assert.match(await rack.locator('.shop-skin__portrait').evaluate((image) => image.currentSrc), new RegExp(`portrait-${id}\\.png$`))
          if (id === 'kratos') {
            assert.equal(await rack.getAttribute('data-owned'), 'true')
            assert.equal(await page.getByRole('button', { name: `Wear: Kratos, Ironclad skin` }).count(), 1, `${label}: Kratos is owned, so Wear`)
          } else {
            const buy = page.getByRole('button', { name: `Buy the ${name} skin for ${hero}, ${cost} coins`, exact: true })
            assert.equal(await buy.count(), 1, `${label}: ${id} has one Buy button named for its hero`)
            assert(await buy.isEnabled(), `${label}: ${id} is affordable`)
            assert.match(await buy.innerText(), /2,500/)
          }
        }
        assert.equal(await page.getByRole('button', { name: /^Buy the ((Ironclad|Silent|Defect|Watcher)-chan|Rimuru Tempest) skin/ }).count(), 5, `${label}: all five -chan and Rimuru Tempest offers`)
        await assertSkinRacks(page, `${label} skins`)
        const reach = await page.evaluate(() => {
          const scroll = (selector) => { const element = document.querySelector(selector); return element.scrollHeight - element.clientHeight }
          const faults = []
          for (const rack of document.querySelectorAll('.shop-skin')) {
            if (rack.scrollHeight > rack.clientHeight + 1) faults.push(`${rack.dataset.skin ?? 'locked'} clips ${rack.scrollHeight - rack.clientHeight}px`)
            const box = rack.getBoundingClientRect()
            for (const button of rack.querySelectorAll('.shop-button')) {
              const own = button.getBoundingClientRect()
              if (own.top < box.top || own.bottom > box.bottom - 1 || own.right > box.right) faults.push(`${rack.dataset.skin}: button leaves its rack`)
            }
          }
          return { faults, racks: scroll('.shop-skins__racks'), rail: scroll('.shop__rail'), stock: scroll('#shop-panel-skins'), page: document.documentElement.scrollHeight - innerHeight }
        })
        assert.deepEqual(reach.faults, [], `${label}: ${reach.faults.join('; ')}`)
        assert(reach.racks <= 1 && reach.rail <= 1 && reach.stock <= 1 && reach.page <= 1, `${label}: the skins shelf scrolls vertically: ${JSON.stringify(reach)}`)
        if (phone) {
          const scale = viewport.width / await page.evaluate(() => innerWidth)
          assert.deepEqual(await page.locator('.shop-skin .shop-button').evaluateAll((controls, factor) =>
            controls.filter((control) => control.getBoundingClientRect().height * factor < 22).map((control) => control.textContent), scale), [],
          `${label}: skin controls too short to tap`)
        }
        await page.screenshot({ path: join(output, `multi-${engineName}-${screen}-skins.png`), timeout: 90_000 })
        assert.deepEqual(errors, [], `${label}: page errors`)
        await context.close()
        console.log(`${label}: six skin offers scroll with readable portraits`)
      } finally { if (engineName === 'webkit') await engine.close() }
    }
  }

  for (const [screen, viewport, phone] of [
    ['desktop-1280x720', { width: 1280, height: 720 }, false],
    ['phone-844x390', { width: 844, height: 390 }, true],
  ]) {
    // 2,500 + 3,000: one -chan skin fits the purse, and the second is short until the purse is refilled.
    const { context, page, errors } = await open(viewport, phone, wallet(SKIN_PRICE + 3000))
    const press = (locator) => phone ? locator.tap() : locator.click()
    await page.getByRole('button', { name: 'Shop', exact: true }).click()
    await press(page.getByRole('tab', { name: /^Skins/ }))
    const silent = page.locator('.shop-skin[data-skin="monogatari_silent"]')
    const watcher = page.locator('.shop-skin[data-skin="monogatari_watcher"]')
    await silent.waitFor()
    await settledImages(page, '.shop-skin__portrait')
    await press(silent.getByRole('button', { name: `Buy the Silent-chan skin for Silent, ${cost} coins`, exact: true }))
    const confirm = page.getByRole('dialog', { name: 'Buy the Silent-chan skin for Silent?' })
    await confirm.waitFor()
    await settledImages(page, '.shop-confirm__portrait')
    assert.match(await confirm.locator('h2').innerText(), /Silent-chan skin/)
    assert.match(await confirm.innerText(), /Silent skin/, `${screen}: the dialog names the hero`)
    assert.match(await confirm.locator('.shop-confirm__portrait').evaluate((image) => image.currentSrc), /portrait-monogatari_silent\.png$/)
    await assertUnclipped(page, '.shop-confirm__panel, .shop-confirm .shop-button', `${screen} -chan confirm`)
    await page.screenshot({ path: join(output, `multi-${screen}-confirm.png`), timeout: 90_000 })
    await press(confirm.locator('.shop-button--buy'))
    const unlocked = page.getByRole('dialog', { name: 'Silent-chan skin for Silent unlocked' })
    await unlocked.waitFor()
    await press(unlocked.getByRole('button', { name: 'Done' }))
    await unlocked.waitFor({ state: 'detached' })
    let saved = await storedWallet(page)
    assert.deepEqual(saved.skins, ['monogatari_silent'], `${screen}: only the Silent skin was bought`)
    assert.equal(saved.coins, 3000, `${screen}: exactly one price was spent`)
    assert.deepEqual(await storedSkins(page), { silent: 'monogatari_silent' }, `${screen}: the bought skin is worn on its own hero only`)
    assert.equal(await silent.getAttribute('data-worn'), 'true')
    assert.equal(await watcher.getAttribute('data-owned'), null, `${screen}: the Watcher skin is still for sale`)
    assert.equal(await silent.getByRole('button', { name: 'Worn: Silent-chan, Silent skin' }).getAttribute('aria-pressed'), 'true')
    // The purse still covers one more; drain it to prove the short state names the right skin.
    await page.evaluate(() => {
      const key = Object.keys(localStorage).find((name) => name.startsWith('sts-wallet:'))
      localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key)), coins: 2499 }))
      window.dispatchEvent(new Event('sts-wallet-change'))
    })
    const short = page.getByRole('button', { name: `Not enough coins for the Watcher-chan skin for Watcher, ${cost} coins: need 1 more`, exact: true })
    assert(await short.isDisabled(), `${screen}: the Watcher skin is one coin short`)
    await page.evaluate(() => {
      const key = Object.keys(localStorage).find((name) => name.startsWith('sts-wallet:'))
      localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key)), coins: 2500 }))
      window.dispatchEvent(new Event('sts-wallet-change'))
    })
    await press(watcher.getByRole('button', { name: `Buy the Watcher-chan skin for Watcher, ${cost} coins`, exact: true }))
    const second = page.getByRole('dialog', { name: 'Buy the Watcher-chan skin for Watcher?' })
    await second.waitFor()
    await press(second.locator('.shop-button--buy'))
    await page.getByRole('dialog', { name: 'Watcher-chan skin for Watcher unlocked' }).waitFor()
    await press(page.getByRole('dialog', { name: 'Watcher-chan skin for Watcher unlocked' }).getByRole('button', { name: 'Done' }))
    saved = await storedWallet(page)
    assert.deepEqual(saved.skins, ['monogatari_silent', 'monogatari_watcher'])
    assert.equal(saved.coins, 0)
    assert.deepEqual(await storedSkins(page), { silent: 'monogatari_silent', watcher: 'monogatari_watcher' },
      `${screen}: one skin worn per hero`)
    await settledImages(page, '.shop-skin__portrait')
    await assertSkinRacks(page, `${screen} -chan owned`)
    await page.screenshot({ path: join(output, `multi-${screen}-owned.png`), timeout: 90_000 })
    // Wear toggles are per hero: taking one off leaves the other worn, and Kratos (unowned) stays on sale.
    await press(silent.getByRole('button', { name: 'Worn: Silent-chan, Silent skin' }))
    assert.deepEqual(await storedSkins(page), { watcher: 'monogatari_watcher' })
    assert.equal(await watcher.getAttribute('data-worn'), 'true')
    assert.equal(await silent.getAttribute('data-worn'), null)
    await press(silent.getByRole('button', { name: 'Wear: Silent-chan, Silent skin' }))
    assert.deepEqual(await storedSkins(page), { silent: 'monogatari_silent', watcher: 'monogatari_watcher' })
    assert.equal(await page.locator('.shop-skin[data-skin="kratos"]').getAttribute('data-owned'), null)
    await page.reload()
    await page.locator('.start-menu__nav').waitFor()
    await page.getByRole('button', { name: 'Shop', exact: true }).click()
    await press(page.getByRole('tab', { name: /^Skins/ }))
    await page.locator('.shop-skin[data-skin="monogatari_silent"][data-worn="true"]').waitFor()
    await page.locator('.shop-skin[data-skin="monogatari_watcher"][data-worn="true"]').waitFor()
    assert.deepEqual(errors, [], `${screen}: page errors`)
    await context.close()
    console.log(`${screen}: both -chan skins are bought and worn per hero`)
  }
} finally {
  await browser.close()
  await vite.close()
  await rooms.close()
}
