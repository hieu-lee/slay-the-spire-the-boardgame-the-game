#!/usr/bin/env node
// The Skins section of the Profile screen in a real browser, on desktop and horizontal-phone
// screens: the Record/Skins rail, the Ironclad row (Default and, once bought, Kratos), wearing
// a skin with one click or tap, keyboard use, a choice that survives a reload, follows other
// tabs live, belongs to one account, and reaches the next solo run (character select portrait
// and wallpaper, the run's seat, the combat idle sprite). A skin the wallet does not own shows
// as a locked tile with its price that opens the Shop's Skins tab, and a stored choice for it
// reads as Default. Screenshots land in artifacts/skin-profile/.
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium, webkit } from './lib/profile-browser.mjs'
import { createRoomServer } from './room-server.mjs'
import { postNeowRun } from './lib/post-neow-run.mjs'
import { createCombat, preparePlayerTurn } from '../src/game/combat.ts'
import { createRng } from '../src/game/rng.ts'
import { skinsOf } from '../src/game/skins.ts'
import { CHARACTER_IDS } from '../src/game/types.ts'

const root = resolve(import.meta.dirname, '..')
const output = join(root, 'artifacts/skin-profile')
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
const url = `http://127.0.0.1:${address.port}`
const browser = await chromium.launch()
const errors = []
// `--skins=all` runs only the three-skin pass at the end (the normal run does both).
const multiSkinsOnly = process.argv.includes('--skins=all')
// The heroes with a skin right now, before the multi-skin pass registers more.
const skinHeroes = CHARACTER_IDS.filter((hero) => skinsOf(hero).length > 0)

// The seeded test profile is TestPlayer; its choices live under this key.
const KEY = 'sts-skins:testplayer'
const SCREENS = [
  ['desktop-1920x1080', { width: 1920, height: 1080 }, false],
  ['desktop-1366x650', { width: 1366, height: 650 }, false],
  ['desktop-1280x720', { width: 1280, height: 720 }, false],
  ['phone-844x390', { width: 844, height: 390 }, true],
  ['phone-932x430', { width: 932, height: 430 }, true],
]

const wallet = (skins) => ({ version: 1, coins: 3000, packs: [], skins, credited: {} })

/** A new context starts with a wallet that owns `skins` (seeded anonymously; the account adopts it on first read). */
async function open(viewport, phone, context, skins = ['kratos'], { engine = browser, base = url } = {}) {
  if (!context) {
    context = await engine.newContext({ viewport, isMobile: phone, hasTouch: phone })
    await context.addInitScript((value) => {
      // Once per browser, not per tab: a second tab must not reset the wallet.
      if (!localStorage.getItem('seeded-wallet')) {
        localStorage.setItem('sts-wallet', JSON.stringify(value))
        localStorage.setItem('seeded-wallet', '1')
      }
    }, wallet(skins))
  }
  const page = await context.newPage()
  page.setDefaultTimeout(15_000)
  page.setDefaultNavigationTimeout(90_000)
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error' && !/status of (401|404|409)/.test(message.text())) errors.push(message.text()) })
  await page.goto(base)
  await page.locator('.start-menu__nav').waitFor()
  return { context, page }
}

const stored = (page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null'), KEY)
const tile = (page, name) => page.getByRole('radio', { name: `Ironclad, ${name}`, exact: true })
// `phone` is 'dom' for WebKit's phone emulation, which never reports lazily loaded controls as stable: it clicks through the DOM.
const press = (locator, phone) => phone === 'dom' ? locator.dispatchEvent('click') : phone ? locator.tap() : locator.click()

async function openSkins(page, phone) {
  await page.getByRole('button', { name: 'Profile', exact: true }).click()
  await page.getByRole('heading', { name: 'Profile', exact: true }).waitFor()
  await press(page.getByRole('tab', { name: 'Skins', exact: true }), phone)
  await page.locator('#profile-panel-skins').waitFor({ state: 'visible' })
  await settledImages(page)
}

async function settledImages(page) {
  await page.waitForFunction(() => [...document.querySelectorAll('.profile-skin img')]
    .every((image) => image.complete && image.naturalWidth > 0), undefined, { timeout: 15_000 })
  await page.locator('.profile-skin img').evaluateAll((images) => Promise.all(images.map((image) => image.decode().catch(() => {}))))
  // Let the check badge's pop and the hover transitions end before a screenshot.
  await page.evaluate(() => Promise.all(document.getAnimations().filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
    .map((animation) => animation.finished.catch(() => {}))))
}

/** Every tile, its badge and the rail's controls are whole on screen, and the panel has no sideways overflow. */
async function assertFits(page, label) {
  const faults = await page.evaluate(() => {
    const faults = []
    const scroll = document.querySelector('#profile-panel-skins .profile__scroll')
    const area = scroll.getBoundingClientRect()
    if (scroll.scrollWidth > scroll.clientWidth + 1) faults.push(`sideways overflow ${scroll.scrollWidth} > ${scroll.clientWidth}`)
    const inside = (name, element, bounds) => {
      const box = element.getBoundingClientRect()
      if (!(box.width > 0 && box.height > 0)) faults.push(`${name} has no size`)
      else if (box.left < bounds.left - 1 || box.right > bounds.right + 1) faults.push(`${name} leaves the panel sideways`)
    }
    for (const element of document.querySelectorAll('.profile-skin, .profile-skin__check, .profile-skins__hero h3')) inside(element.className || element.tagName, element, area)
    // The first tiles must be reachable without scrolling the page; the row itself may scroll.
    const first = document.querySelector('.profile-skin').getBoundingClientRect()
    if (first.top < area.top - 1 || first.top > innerHeight) faults.push('the first tile starts off screen')
    for (const selector of ['.profile__back', '.profile__tab', '.profile__logout']) for (const element of document.querySelectorAll(selector)) {
      const box = element.getBoundingClientRect()
      if (box.left < 0 || box.right > innerWidth) faults.push(`${selector} is cut off sideways`)
    }
    if (document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight + 1) faults.push('the page itself scrolls')
    return faults
  })
  assert.deepEqual(faults, [], `${label}: ${faults.join('; ')}`)
  // Whatever the viewport, a tile can be scrolled fully into view and tapped.
  const tiles = page.locator('.profile-skin')
  for (let index = 0; index < await tiles.count(); index++) {
    // Not scrollIntoViewIfNeeded: WebKit's phone emulation never reports a tile as stable.
    await tiles.nth(index).evaluate((element) => element.scrollIntoView({ block: 'nearest' }))
    const box = await tiles.nth(index).evaluate((element) => element.getBoundingClientRect().toJSON())
    assert(box.top >= 0 && box.bottom <= await page.evaluate(() => innerHeight) + 1, `${label}: tile ${index} cannot be scrolled whole into view`)
  }
}

try {
  if (!multiSkinsOnly) {
  // Layout on every supported screen class.
  for (const [name, viewport, phone] of SCREENS) {
    const { context, page } = await open(viewport, phone)
    await page.getByRole('button', { name: 'Profile', exact: true }).click()
    await page.getByRole('heading', { name: 'Profile', exact: true }).waitFor()
    assert.equal(await page.getByRole('tab', { name: 'Record' }).getAttribute('aria-selected'), 'true', `${name}: Record opens first`)
    assert.equal(await page.locator('#profile-panel-skins').isVisible(), false, `${name}: Skins is hidden until chosen`)
    await page.screenshot({ path: join(output, `${name}-record.png`) })
    await press(page.getByRole('tab', { name: 'Skins', exact: true }), phone)
    await page.locator('#profile-panel-skins').waitFor({ state: 'visible' })
    assert.equal(await page.locator('#profile-panel-record').isVisible(), false, `${name}: Record gives way to Skins`)
    await settledImages(page)
    assert.equal(await page.getByRole('radiogroup').count(), skinHeroes.length, `${name}: one row per hero with a skin`)
    assert.equal(await page.getByRole('radiogroup', { name: 'Ironclad' }).getByRole('radio').count(), 2, `${name}: Default and Kratos`)
    assert.equal(await tile(page, 'Default').getAttribute('aria-checked'), 'true', `${name}: Default is worn at first`)
    assert.match(await tile(page, 'Default').locator('img').evaluate((image) => image.currentSrc), /portrait-ironclad\.png$/)
    assert.match(await tile(page, 'Kratos').locator('img').evaluate((image) => image.currentSrc), /portrait-kratos\.png$/)
    await assertFits(page, `${name} (default worn)`)
    await page.evaluate(() => document.querySelector('#profile-panel-skins .profile__scroll').scrollTo(0, 0))
    await page.screenshot({ path: join(output, `${name}-skins-default.png`) })
    await press(tile(page, 'Kratos'), phone)
    await tile(page, 'Kratos').and(page.locator('[aria-checked="true"]')).waitFor()
    await settledImages(page)
    await assertFits(page, `${name} (Kratos worn)`)
    await page.evaluate(() => document.querySelector('#profile-panel-skins .profile__scroll').scrollTo(0, 0))
    await page.screenshot({ path: join(output, `${name}-skins-kratos.png`) })
    await context.close()
    console.log(`PASS ${name}: Record and Skins fit`)
  }

  // Behavior on a desktop and a horizontal phone.
  for (const [name, viewport, phone] of [SCREENS[2], SCREENS[3]]) {
    const { context, page } = await open(viewport, phone)
    await openSkins(page, phone)

    // One click wears Kratos at once (no save button); it persists across a reload.
    assert.equal(await page.getByRole('button', { name: /save/i }).count(), 0, `${name}: there is no Save button`)
    assert.equal(await stored(page), null, `${name}: nothing is stored before a choice`)
    await press(tile(page, 'Kratos'), phone)
    assert.equal(await tile(page, 'Kratos').getAttribute('aria-checked'), 'true')
    assert.equal(await tile(page, 'Default').getAttribute('aria-checked'), 'false')
    assert.equal(await tile(page, 'Kratos').locator('.profile-skin__check').count(), 1, `${name}: the worn tile carries a check`)
    assert.equal(await tile(page, 'Default').locator('.profile-skin__check').count(), 0)
    assert.deepEqual(await stored(page), { ironclad: 'kratos' })
    await page.reload()
    await page.locator('.start-menu__nav').waitFor()
    await openSkins(page, phone)
    assert.equal(await tile(page, 'Kratos').getAttribute('aria-checked'), 'true', `${name}: Kratos survives a reload`)

    // Another tab sees the change without a reload.
    const second = await open(viewport, phone, context)
    await openSkins(second.page, phone)
    assert.equal(await tile(second.page, 'Kratos').getAttribute('aria-checked'), 'true')
    await press(tile(second.page, 'Default'), phone)
    await tile(page, 'Default').and(page.locator('[aria-checked="true"]')).waitFor()
    assert.deepEqual(await stored(page), {}, `${name}: Default clears the choice`)
    await second.page.close()

    // Keyboard: the rail tabs, then the radio group (arrows wear, Enter and Space too).
    await page.getByRole('tab', { name: 'Skins', exact: true }).focus()
    await page.keyboard.press('ArrowUp')
    assert.equal(await page.getByRole('tab', { name: 'Record' }).getAttribute('aria-selected'), 'true', `${name}: arrow keys move between the tabs`)
    assert.equal(await page.locator('#profile-panel-record').isVisible(), true)
    await page.keyboard.press('End')
    assert.equal(await page.getByRole('tab', { name: 'Skins' }).getAttribute('aria-selected'), 'true')
    await tile(page, 'Default').focus()
    assert.equal(await tile(page, 'Default').getAttribute('tabindex'), '0', `${name}: only the worn tile is in the tab order`)
    assert.equal(await tile(page, 'Kratos').getAttribute('tabindex'), '-1')
    await page.keyboard.press('ArrowRight')
    assert.equal(await tile(page, 'Kratos').getAttribute('aria-checked'), 'true', `${name}: ArrowRight wears the next look`)
    assert.equal(await tile(page, 'Kratos').evaluate((element) => element === document.activeElement), true, `${name}: and focuses it`)
    await page.keyboard.press('ArrowRight')
    assert.equal(await tile(page, 'Default').getAttribute('aria-checked'), 'true', `${name}: the row wraps around`)
    await page.keyboard.press('End')
    assert.equal(await tile(page, 'Kratos').getAttribute('aria-checked'), 'true')
    await page.keyboard.press('Home')
    assert.equal(await tile(page, 'Default').getAttribute('aria-checked'), 'true')
    await tile(page, 'Kratos').focus()
    await page.keyboard.press('Enter')
    assert.deepEqual(await stored(page), { ironclad: 'kratos' }, `${name}: Enter wears the focused look`)
    await tile(page, 'Default').focus()
    await page.keyboard.press('Space')
    assert.deepEqual(await stored(page), {}, `${name}: Space wears the focused look`)
    await tile(page, 'Default').focus()
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Tab')
    assert.equal(await page.evaluate(() => document.activeElement?.closest('[role="radiogroup"]')?.getAttribute('aria-labelledby') !== 'profile-skins-ironclad'), true,
      `${name}: Tab leaves the Ironclad row (to the next hero's row)`)
    // Focus is visible on a tile reached by keyboard.
    await tile(page, 'Kratos').focus()
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Tab')
    assert.notEqual(await tile(page, 'Kratos').evaluate((element) => getComputedStyle(element).outlineStyle), 'none', `${name}: focus shows an outline`)
    await page.screenshot({ path: join(output, `${name}-skins-focus.png`) })

    // Reduced motion: no transform or animation on hover or selection.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    assert.equal(await tile(page, 'Default').evaluate((element) => getComputedStyle(element).transitionDuration), '0s', `${name}: no transition when motion is reduced`)
    assert.equal(await tile(page, 'Kratos').locator('.profile-skin__check').evaluate((element) => getComputedStyle(element).animationName), 'none')
    await page.emulateMedia({ reducedMotion: 'no-preference' })

    // The next solo run wears the choice: wear Kratos, back to the menu, character select, a run.
    await press(tile(page, 'Kratos'), phone)
    await page.getByRole('button', { name: 'Back to main menu' }).click()
    await page.getByRole('button', { name: 'Single Player', exact: true }).click()
    await page.getByRole('button', { name: 'Standard', exact: true }).click()
    await page.locator('.start-menu__character-roster').waitFor()
    const decoded = (selector) => page.locator(selector).first().evaluate(async (image) => { await image.decode(); return image.currentSrc })
    assert.match(await decoded('.start-menu__character-roster button[aria-label="Ironclad"] img'), /portrait-kratos\.png$/, `${name}: character select shows the Kratos portrait`)
    assert.match(await decoded('.start-menu__character-wallpaper'), /character-kratos-wallpaper\.webp$/, `${name}: and the Kratos wallpaper`)
    await page.screenshot({ path: join(output, `${name}-character-select-kratos.png`) })
    await page.getByRole('button', { name: 'Embark', exact: true }).click()
    await page.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
    await page.waitForFunction(() => window.__STS_DEBUG__?.getRun().phase === 'neow')
    const worn = await page.evaluate(() => window.__STS_DEBUG__.getRun().players[0])
    assert.equal(worn.character, 'ironclad')
    assert.equal(worn.skin, 'kratos', `${name}: the run carries the chosen skin`)
    const fixture = postNeowRun(71, [{ id: 'p1', name: 'Ironclad', character: 'ironclad', skin: worn.skin }])
    const enemy = { uid: 'enemy-0', defId: 'jaw_worm', row: 0, isBoss: false, hp: 30, maxHp: 30, block: 0, strength: 0,
      vulnerable: 0, weak: 0, poison: 0, actionIndex: 0, abilityUsed: true, dead: false }
    const fight = { ...structuredClone(fixture), phase: 'combat' }
    fight.combat = preparePlayerTurn(createCombat(createRng(72), fight.players, [enemy], 'skin-profile'))
    await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), fight)
    await page.locator('.seat__interactive[data-character="kratos"]').waitFor()
    assert.match(await decoded('.seat__portrait > img'), /kratos/, `${name}: the idle sprite is Kratos`)
    await page.screenshot({ path: join(output, `${name}-combat-kratos.png`) })

    // A run already started keeps its skin when the choice changes afterwards.
    await page.evaluate(() => localStorage.setItem('sts-skins:testplayer', '{}'))
    assert.equal(await page.evaluate(() => window.__STS_DEBUG__.getRun().players[0].skin), 'kratos', `${name}: a started run keeps its look`)
    await page.close()

    // The choice is per account: a different account starts in Default; this one keeps Kratos.
    const { page: account } = await open(viewport, phone, context)
    await account.evaluate((key) => localStorage.setItem(key, JSON.stringify({ ironclad: 'kratos' })), KEY)
    await account.reload()
    await account.locator('.start-menu__nav').waitFor()
    await account.getByRole('button', { name: 'Profile', exact: true }).click()
    await account.getByRole('button', { name: 'Log out' }).click()
    await account.getByRole('button', { name: 'Tap, click, or press any key to start' }).click()
    await account.getByLabel('Password', { exact: true }).waitFor()
    const other = `SkinOther${phone ? 'Phone' : 'Desktop'}`
    await account.getByLabel('Username').fill(other)
    await account.getByLabel('Password', { exact: true }).fill('skin profile password')
    await account.getByRole('button', { name: 'Create account' }).click()
    await account.locator('.start-menu__nav').waitFor()
    await openSkins(account, phone)
    assert.equal(await tile(account, 'Default').getAttribute('aria-checked'), 'true', `${name}: another account wears Default`)
    // Ownership is per account too: this one has bought nothing until its wallet says so.
    assert.equal(await tile(account, 'Kratos').count(), 0, `${name}: another account does not own Kratos`)
    await account.evaluate(([key, value]) => localStorage.setItem(key, JSON.stringify(value)), [`sts-wallet:${other.toLowerCase()}`, wallet(['kratos'])])
    await account.reload()
    await account.locator('.start-menu__nav').waitFor()
    await openSkins(account, phone)
    assert.equal(await tile(account, 'Kratos').getAttribute('aria-checked'), 'false')
    await press(tile(account, 'Kratos'), phone)
    assert.deepEqual(await account.evaluate((key) => JSON.parse(localStorage.getItem(key)), `sts-skins:${other.toLowerCase()}`), { ironclad: 'kratos' })
    assert.deepEqual(await stored(account), { ironclad: 'kratos' }, `${name}: the first account's choice is untouched`)
    await account.evaluate(() => localStorage.setItem('sts-skins:testplayer', '{}'))
    await account.getByRole('button', { name: 'Back to main menu' }).click()
    await account.evaluate(() => localStorage.setItem('sts-profile', JSON.stringify({ username: 'TestPlayer', token: '00000000-0000-4000-8000-000000000001', secured: true })))
    await account.reload()
    await account.locator('.start-menu__nav').waitFor()
    await openSkins(account, phone)
    assert.equal(await tile(account, 'Default').getAttribute('aria-checked'), 'true', `${name}: switching back reads this account's own choice`)
    await context.close()
    console.log(`PASS ${name}: wearing, persistence, tabs, keyboard, accounts and the next run`)
  }

  // A skin the account has not bought: a locked tile with its price that opens the Shop's Skins tab.
  for (const [name, viewport, phone] of [SCREENS[1], SCREENS[2], SCREENS[3], SCREENS[4]]) {
    const { context, page } = await open(viewport, phone, undefined, [])
    // A stored choice for an unowned skin reads as Default and never reaches a run.
    await page.evaluate((key) => localStorage.setItem(key, JSON.stringify({ ironclad: 'kratos' })), KEY)
    await page.reload()
    await page.locator('.start-menu__nav').waitFor()
    await openSkins(page, phone)
    assert.equal(await page.getByRole('radiogroup', { name: 'Ironclad' }).getByRole('radio').count(), 1, `${name}: only Default is selectable`)
    assert.equal(await tile(page, 'Default').getAttribute('aria-checked'), 'true', `${name}: an unowned choice reads as Default`)
    assert.equal(await page.getByRole('radio', { name: 'Ironclad, Kratos' }).count(), 0, `${name}: Kratos is not a choice`)
    const locked = page.getByRole('button', { name: 'Ironclad, Kratos, locked: 2,500 coins. Open the Shop', exact: true })
    assert.equal(await locked.count(), 1, `${name}: one locked tile`)
    assert.match(await locked.locator('.profile-skin__price').innerText(), /2,500/, `${name}: the tile shows the price`)
    assert.equal(await locked.locator('.profile-skin__lock').isVisible(), true, `${name}: and a lock`)
    assert.match(await locked.locator('.profile-skin__art > img').evaluate((image) => image.currentSrc), /portrait-kratos\.png$/)
    await assertFits(page, `${name} (locked)`)
    await page.evaluate(() => document.querySelector('#profile-panel-skins .profile__scroll').scrollTo(0, 0))
    await page.screenshot({ path: join(output, `${name}-skins-locked.png`) })
    // Tapping it opens the Shop on the Skins tab.
    await press(locked, phone)
    await page.locator('.shop').waitFor()
    assert.equal(await page.getByRole('tab', { name: 'Skins' }).getAttribute('aria-selected'), 'true', `${name}: the Shop opens on Skins`)
    assert.equal(await page.locator('#shop-panel-skins').isVisible(), true)
    // The run it would have started stays Default.
    await page.getByRole('button', { name: 'Back to main menu' }).click()
    await page.getByRole('button', { name: 'Single Player', exact: true }).click()
    await page.getByRole('button', { name: 'Standard', exact: true }).click()
    await page.locator('.start-menu__character-roster').waitFor()
    assert.match(await page.locator('.start-menu__character-roster button[aria-label="Ironclad"] img').first().evaluate((image) => image.currentSrc),
      /portrait-ironclad\.png$/, `${name}: character select ignores the unowned choice`)
    await page.getByRole('button', { name: 'Embark', exact: true }).click()
    await page.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
    await page.waitForFunction(() => window.__STS_DEBUG__?.getRun().phase === 'neow')
    assert.equal(await page.evaluate(() => window.__STS_DEBUG__.getRun().players[0].skin), undefined, `${name}: the run starts in the default look`)
    // The next write drops the stale choice.
    await page.evaluate(async () => (await import('/src/skin-preference.ts')).setPreferredSkin('ironclad', undefined))
    assert.deepEqual(await stored(page), {}, `${name}: the unowned choice is dropped`)
    await page.evaluate(async () => (await import('/src/skin-preference.ts')).setPreferredSkin('ironclad', 'kratos'))
    assert.deepEqual(await stored(page), {}, `${name}: an unowned skin cannot be worn`)
    await context.close()
    console.log(`PASS ${name}: a skin the account has not bought is locked`)
  }
  }

  // Several skins across heroes: Ironclad has Kratos and Ironclad-chan, Silent has Silent-chan, Defect has Defect-chan and Watcher has Watcher-chan.
  const radio = (page, hero, look) => page.getByRole('radio', { name: `${hero}, ${look}`, exact: true })
  const lockedTile = (page, hero, look) => page.getByRole('button', { name: `${hero}, ${look}, locked: 2,500 coins. Open the Shop`, exact: true })
  const checked = (page) => page.locator('.profile-skins__radios [role="radio"][aria-checked="true"]').evaluateAll((items) => items.map((item) => item.getAttribute('aria-label')))
  const OWNS_SOME = ['kratos', 'monogatari_silent', 'monogatari_defect']
  const OWNS_ALL = ['kratos', 'monogatari_ironclad', 'monogatari_silent', 'monogatari_defect', 'monogatari_watcher', 'anime_slime_boss']
  const ROW_IDS = ['profile-skins-ironclad', 'profile-skins-silent', 'profile-skins-defect', 'profile-skins-watcher', 'profile-skins-slime_boss']
  const ALL_DEFAULT = ['Ironclad, Default', 'Silent, Default', 'Defect, Default', 'Watcher, Default', 'Slime Boss, Default']
  const webkitBrowser = await webkit.launch()
  try {
    for (const [engineName, engine] of [['chromium', browser], ['webkit', webkitBrowser]]) {
      for (const [screen, viewport, phoneScreen] of SCREENS) {
        const phone = phoneScreen && engineName === 'webkit' ? 'dom' : phoneScreen
        const label = `${engineName} ${screen}`
        // Kratos, Silent-chan and Defect-chan owned, Ironclad-chan, Watcher-chan and Rimuru Tempest locked: five rows, owned and unowned tiles.
        const { context, page } = await open(viewport, phoneScreen, undefined, OWNS_SOME, { engine })
        await openSkins(page, phone)
        assert.deepEqual(await page.getByRole('radiogroup').evaluateAll((groups) => groups.map((group) => group.getAttribute('aria-labelledby'))),
          ROW_IDS, `${label}: a row per hero, every hero has a skin`)
        assert.equal(await page.getByRole('radiogroup', { name: 'Ironclad' }).getByRole('radio').count(), 2, `${label}: Ironclad has Default and Kratos`)
        assert.equal(await lockedTile(page, 'Ironclad', 'Ironclad-chan').count(), 1, `${label}: Ironclad-chan is a locked tile`)
        assert.equal(await page.getByRole('radiogroup', { name: 'Defect' }).getByRole('radio').count(), 2, `${label}: Defect has Default and Defect-chan`)
        assert.equal(await page.getByRole('radiogroup', { name: 'Silent' }).getByRole('radio').count(), 2, `${label}: Silent has Default and Silent-chan`)
        assert.equal(await page.getByRole('radiogroup', { name: 'Watcher' }).getByRole('radio').count(), 1, `${label}: Watcher owns nothing yet`)
        assert.equal(await lockedTile(page, 'Watcher', 'Watcher-chan').count(), 1, `${label}: Watcher-chan is a locked tile`)
        assert.equal(await lockedTile(page, 'Slime Boss', 'Rimuru Tempest').count(), 1, `${label}: Rimuru Tempest is a locked tile`)
        assert.equal(await page.getByRole('radiogroup', { name: 'Slime Boss' }).getByRole('radio').count(), 1, `${label}: Slime Boss owns nothing yet`)
        assert.equal(await page.getByRole('button', { name: /locked/ }).count(), 3, `${label}: only those three are locked`)
        assert.deepEqual(await checked(page), ALL_DEFAULT, `${label}: Default is worn on every hero`)
        assert.match(await radio(page, 'Silent', 'Silent-chan').locator('img').evaluate((image) => image.currentSrc), /portrait-monogatari_silent\.png$/)
        assert.match(await lockedTile(page, 'Watcher', 'Watcher-chan').locator('.profile-skin__art > img').evaluate((image) => image.currentSrc), /portrait-monogatari_watcher\.png$/)
        await assertFits(page, `${label} (default worn)`)
        const scroll = (to) => page.evaluate((target) => { const area = document.querySelector('#profile-panel-skins .profile__scroll'); area.scrollTo(0, target === 'end' ? area.scrollHeight : 0) }, to)
        await scroll('top')
        await page.screenshot({ path: join(output, `multi-${engineName}-${screen}-skins-top.png`), timeout: 90_000 })
        await scroll('end')
        await page.screenshot({ path: join(output, `multi-${engineName}-${screen}-skins-bottom.png`), timeout: 90_000 })
        await press(radio(page, 'Silent', 'Silent-chan'), phone)
        await press(radio(page, 'Ironclad', 'Kratos'), phone)
        await press(radio(page, 'Defect', 'Defect-chan'), phone)
        assert.deepEqual(await checked(page), ['Ironclad, Kratos', 'Silent, Silent-chan', 'Defect, Defect-chan', 'Watcher, Default', 'Slime Boss, Default'], `${label}: one look worn per hero`)
        await settledImages(page)
        await scroll('top')
        await assertFits(page, `${label} (Kratos, Silent-chan and Defect-chan worn)`)
        await page.screenshot({ path: join(output, `multi-${engineName}-${screen}-skins-worn.png`), timeout: 90_000 })
        await context.close()
        console.log(`PASS ${label}: five hero rows with owned and locked skins fit`)
      }
    }
  } finally { await webkitBrowser.close() }

  for (const [name, viewport, phone] of [SCREENS[2], SCREENS[3]]) {
    const { context, page } = await open(viewport, phone, undefined, OWNS_ALL)
    await openSkins(page, phone)
    assert.equal(await page.getByRole('button', { name: /locked/ }).count(), 0, `${name}: everything is owned`)
    assert.equal(await stored(page), null)
    // Wearing a look changes only its hero.
    await press(radio(page, 'Silent', 'Silent-chan'), phone)
    assert.deepEqual(await stored(page), { silent: 'monogatari_silent' })
    await press(radio(page, 'Watcher', 'Watcher-chan'), phone)
    await press(radio(page, 'Defect', 'Defect-chan'), phone)
    await press(radio(page, 'Ironclad', 'Kratos'), phone)
    assert.deepEqual(await stored(page), { silent: 'monogatari_silent', watcher: 'monogatari_watcher', defect: 'monogatari_defect', ironclad: 'kratos' })
    assert.deepEqual(await checked(page), ['Ironclad, Kratos', 'Silent, Silent-chan', 'Defect, Defect-chan', 'Watcher, Watcher-chan', 'Slime Boss, Default'], `${name}: exactly one worn per hero`)
    assert.equal(await page.locator('.profile-skin__check').count(), 5, `${name}: one check badge per hero row (the worn tile, Default for Slime Boss)`)
    await press(radio(page, 'Silent', 'Default'), phone)
    assert.deepEqual(await stored(page), { watcher: 'monogatari_watcher', defect: 'monogatari_defect', ironclad: 'kratos' }, `${name}: Default clears only Silent`)
    assert.deepEqual(await checked(page), ['Ironclad, Kratos', 'Silent, Default', 'Defect, Defect-chan', 'Watcher, Watcher-chan', 'Slime Boss, Default'])
    // A hero with two skins cycles through Default, Kratos and Ironclad-chan.
    await radio(page, 'Ironclad', 'Kratos').focus()
    await page.keyboard.press('ArrowRight')
    assert.equal(await radio(page, 'Ironclad', 'Ironclad-chan').getAttribute('aria-checked'), 'true', `${name}: ArrowRight wears Ironclad-chan after Kratos`)
    await page.keyboard.press('ArrowRight')
    assert.equal(await radio(page, 'Ironclad', 'Default').getAttribute('aria-checked'), 'true', `${name}: and wraps to Default`)
    await press(radio(page, 'Ironclad', 'Kratos'), phone)
    // Keyboard: arrows move inside one hero's group and never into another's.
    await radio(page, 'Silent', 'Default').focus()
    await page.keyboard.press('ArrowRight')
    assert.equal(await radio(page, 'Silent', 'Silent-chan').getAttribute('aria-checked'), 'true', `${name}: ArrowRight wears Silent's next look`)
    await page.keyboard.press('ArrowRight')
    assert.equal(await radio(page, 'Silent', 'Default').getAttribute('aria-checked'), 'true', `${name}: and wraps inside the Silent row`)
    assert.equal(await radio(page, 'Watcher', 'Watcher-chan').getAttribute('aria-checked'), 'true', `${name}: Watcher is untouched`)
    assert.equal(await radio(page, 'Silent', 'Silent-chan').getAttribute('tabindex'), '-1')
    assert.equal(await radio(page, 'Watcher', 'Watcher-chan').getAttribute('tabindex'), '0', `${name}: each row keeps one tab stop`)

    // The next solo run wears the chosen look of the hero picked: Silent-chan.
    await press(radio(page, 'Silent', 'Silent-chan'), phone)
    await press(radio(page, 'Slime Boss', 'Rimuru Tempest'), phone)
    await page.getByRole('button', { name: 'Back to main menu' }).click()
    await page.getByRole('button', { name: 'Single Player', exact: true }).click()
    await page.getByRole('button', { name: 'Standard', exact: true }).click()
    await page.locator('.start-menu__character-roster').waitFor()
    const decoded = (selector) => page.locator(selector).first().evaluate(async (image) => { await image.decode(); return image.currentSrc })
    assert.match(await decoded('.start-menu__character-roster button[aria-label="Ironclad"] img'), /portrait-kratos\.png$/, `${name}: Ironclad shows Kratos`)
    assert.match(await decoded('.start-menu__character-roster button[aria-label="Silent"] img'), /portrait-monogatari_silent\.png$/, `${name}: Silent shows its -chan portrait`)
    assert.match(await decoded('.start-menu__character-roster button[aria-label="Watcher"] img'), /portrait-monogatari_watcher\.png$/, `${name}: Watcher shows its -chan portrait`)
    assert.match(await decoded('.start-menu__character-roster button[aria-label="Defect"] img'), /portrait-monogatari_defect\.png$/, `${name}: Defect shows its -chan portrait`)
    assert.match(await decoded('.start-menu__character-roster button[aria-label="Slime Boss"] img'), /portrait-anime_slime_boss\.png$/, `${name}: Slime Boss shows its -chan portrait`)
    await page.screenshot({ path: join(output, `multi-${name}-character-select.png`), timeout: 90_000 })
    await page.locator('.start-menu__character-roster button[aria-label="Slime Boss"]').click()
    assert.match(await decoded('.start-menu__character-wallpaper'), /character-anime_slime_boss-wallpaper\.webp$/, `${name}: Slime Boss's wallpaper is the -chan one`)
    await page.locator('.start-menu__character-roster button[aria-label="Ironclad"]').click()
    await page.locator('.start-menu__character-roster button[aria-label="Silent"]').click()
    assert.match(await decoded('.start-menu__character-wallpaper'), /character-monogatari_silent-wallpaper\.webp$/, `${name}: Silent's wallpaper is the -chan one`)
    await page.getByRole('button', { name: 'Embark', exact: true }).click()
    await page.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
    await page.waitForFunction(() => window.__STS_DEBUG__?.getRun().phase === 'neow')
    const players = await page.evaluate(() => window.__STS_DEBUG__.getRun().players.map(({ character, skin }) => ({ character, skin })))
    assert.deepEqual(players, [{ character: 'silent', skin: 'monogatari_silent' }], `${name}: the run carries the Silent skin`)
    await context.close()
    console.log(`PASS ${name}: one look per hero, keyboard rows and the next run`)
  }

  {
    // Choices that name a skin the account does not own, or a skin of another hero, read as Default; locked tiles open the Shop.
    const { context, page } = await open(SCREENS[2][1], false, undefined, ['monogatari_silent'])
    await page.evaluate((key) => localStorage.setItem(key, JSON.stringify({
      ironclad: 'monogatari_silent', silent: 'monogatari_silent', watcher: 'monogatari_watcher',
    })), KEY)
    await page.reload()
    await page.locator('.start-menu__nav').waitFor()
    await openSkins(page, false)
    assert.deepEqual(await checked(page), ['Ironclad, Default', 'Silent, Silent-chan', 'Defect, Default', 'Watcher, Default', 'Slime Boss, Default'],
      'a skin of another hero and an unowned skin read as Default; the owned one stays')
    assert.equal(await lockedTile(page, 'Ironclad', 'Kratos').count(), 1)
    assert.equal(await lockedTile(page, 'Watcher', 'Watcher-chan').count(), 1)
    assert.equal(await radio(page, 'Watcher', 'Watcher-chan').count(), 0, 'an unowned skin is not a choice')
    await page.evaluate(async () => (await import('/src/skin-preference.ts')).setPreferredSkin('watcher', 'monogatari_watcher'))
    await page.evaluate(async () => (await import('/src/skin-preference.ts')).setPreferredSkin('ironclad', 'monogatari_silent'))
    // Neither attempt wrote anything; the next real write drops the stale choices.
    assert.deepEqual(await checked(page), ['Ironclad, Default', 'Silent, Silent-chan', 'Defect, Default', 'Watcher, Default', 'Slime Boss, Default'], 'an unowned skin and another hero\'s skin cannot be worn')
    await page.evaluate(async () => (await import('/src/skin-preference.ts')).setPreferredSkin('watcher', undefined))
    assert.deepEqual(await stored(page), { silent: 'monogatari_silent' }, 'the stale choices are dropped by the next write')
    await lockedTile(page, 'Watcher', 'Watcher-chan').click()
    await page.locator('.shop').waitFor()
    assert.equal(await page.getByRole('tab', { name: 'Skins' }).getAttribute('aria-selected'), 'true')
    assert.equal(await page.getByRole('button', { name: 'Buy the Watcher-chan skin for Watcher, 2,500 coins', exact: true }).count(), 1,
      'the Shop sells exactly the Watcher skin that was locked')
    await context.close()
    console.log('PASS unowned and foreign choices read as Default; locked tiles open the Shop')
  }
  assert.deepEqual(errors, [], `browser errors: ${errors.join('; ')}`)
} finally {
  await browser.close()
  await vite.close()
  await rooms.close()
}
