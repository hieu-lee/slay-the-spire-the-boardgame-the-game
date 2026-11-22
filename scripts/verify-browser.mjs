// Drives the real app in a real browser: clicks cards, resolves turns, and
// asserts against the ENGINE state read through window.__STS_DEBUG__ rather
// than against pixels. Screenshots are written for human review, and the run
// fails on any console error, page error, or failed request.
//
// Legacy umbrella, opt-in only. Per-card rule scenarios, the Downfall character
// suite and the VFX/animation timing probes were removed because node verifiers
// (verify-combat, verify-rooms, verify-downfall-*) and focused browser verifiers
// (verify-animation-browser, verify-hermit-chamber-browser, ...) own them.
//
// Usage: node scripts/verify-browser.mjs [--headed] [--out=dir]
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium, devices, webkit } from './lib/profile-browser.mjs'
import { suite, check, assert, assertDeepEqual, assertEqual, report } from './lib/harness.mjs'
import { installScreenAudit } from './lib/browser-screen-audit.mjs'
import { enemyDef } from '../src/game/enemies.ts'
import { potionDef, relicDef } from '../src/game/relics.ts'
import { discardNeedsChoice } from '../src/game/combat.ts'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cardArtDir = join(repoRoot, 'public/assets/cards')
const GENERATED_STATUS_SCANS = new Set(['curses__daze.webp', 'curses__burn.webp', 'curses__slimed.webp'])
const artSynced = existsSync(cardArtDir) && readdirSync(cardArtDir).some((file) => !GENERATED_STATUS_SCANS.has(file))
const args = process.argv.slice(2)
const headed = args.includes('--headed')

async function openPause() {
  await page.waitForFunction(() => !document.querySelector('dialog[open]'))
  const dialog = page.getByRole('dialog', { name: 'Slay the Spire' })
  await page.mouse.move(0, 0)
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  })
  await page.waitForFunction(() => !document.querySelector(
    '.power__zoom, .potion-tip, .relic-chip:hover > .relic-tip, .relic-chip:focus-within > .relic-tip',
  ))
  await page.keyboard.press('Escape')
  await dialog.waitFor()
  return dialog
}

async function prepareDragSource(source) {
  await page.waitForFunction(() => !document.querySelector('.combat')?.getAnimations()
    .some((animation) => animation.playState === 'running'))
  await source.hover()
  await source.evaluate((element) => Promise.all(element.getAnimations()
    .map((animation) => animation.finished.catch(() => {}))))
}

const settlePaint = () => page.evaluate(() => new Promise((resolve) =>
  requestAnimationFrame(() => requestAnimationFrame(resolve))))
const outDir = join(
  repoRoot,
  (args.find((a) => a.startsWith('--out=')) ?? '--out=artifacts/browser').slice(6),
)
const animationReferenceDir = process.env.UPDATE_ANIMATION_REFERENCES === '1'
  ? join(repoRoot, 'docs/animation-reference')
  : join(outDir, 'animation-reference')

// Deliberately NOT wiped: a reviewer running this suite at the same time as
// verify-all would delete the directory out from under the other run. Files are
// overwritten in place instead, which is safe when two runs overlap.
mkdirSync(outDir, { recursive: true })
mkdirSync(animationReferenceDir, { recursive: true })

// Port 0 asks the OS for a free port. A fixed port collides whenever another
// copy of this suite is running — including verify-all's own parallelism.
const server = await createServer({
  root: repoRoot,
  logLevel: 'silent',
  server: { port: 0 },
})
await server.listen()
const address = server.httpServer?.address()
if (!address || typeof address === 'string') throw new Error('vite did not report a port')
const base = `http://localhost:${address.port}`

const browser = await chromium.launch({ headless: !headed })
const page = installScreenAudit(await browser.newPage({ viewport: { width: 1440, height: 900 } }))
page.setDefaultTimeout(30_000)
page.setDefaultNavigationTimeout(30_000)

const consoleErrors = []
const pageErrors = []
const requestFailures = []
const requestedUrls = new Set()
const auditErrors = (currentPage) => {
  currentPage.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  currentPage.on('pageerror', (error) => pageErrors.push(String(error)))
  currentPage.on('request', (request) => requestedUrls.add(request.url()))
  currentPage.on('requestfailed', (request) => {
    const canceledLocalAsset = ['net::ERR_ABORTED', 'cancelled'].includes(request.failure()?.errorText) &&
      request.url().startsWith(`${base}/assets/`)
    if (!canceledLocalAsset) requestFailures.push(`${request.url()} ${request.failure()?.errorText ?? ''}`)
  })
  currentPage.on('response', (response) => {
    if (response.status() >= 400 && response.url().startsWith(base)) {
      requestFailures.push(`${response.status()} ${response.url()}`)
    }
  })
}
auditErrors(page)

await page.addInitScript(() => {
  window.__SFX_PLAYS__ = []
  window.__SFX_DETAILS__ = []
  window.__BGM_PAUSES__ = []
  HTMLMediaElement.prototype.play = function play() {
    window.__SFX_PLAYS__.push(new URL(this.src).pathname)
    window.__SFX_DETAILS__.push({
      path: new URL(this.src).pathname,
      cue: this.dataset.combatSfx ?? null,
      rate: this.playbackRate,
      volume: this.volume,
      preservesPitch: this.preservesPitch,
      delayMs: Number(this.dataset.combatSfxDelay ?? 0),
    })
    return Promise.resolve()
  }
  // A combat video can be released twice, so pause() also runs after its src is cleared; the real pause() allows that.
  HTMLMediaElement.prototype.pause = function pause() {
    if (this.src) window.__BGM_PAUSES__.push(new URL(this.src).pathname)
  }
})

const shots = []
async function shot(label) {
  // Screenshots are the artefact a human reviews, so they must show the app as
  // a player sees it. Captured too early, lazy-loaded card art is still blank
  // and the picture misrepresents the product rather than documenting it.
  await page.waitForFunction(
    () => [...document.querySelectorAll('img')].every((img) => {
      const box = img.getBoundingClientRect()
      const visible = box.right > 0 && box.bottom > 0 && box.left < innerWidth && box.top < innerHeight &&
        getComputedStyle(img).visibility !== 'hidden'
      return !visible || img.complete && img.naturalWidth > 0
    }),
    null,
    { timeout: 15_000 },
  )
  const file = join(outDir, `${label}.png`)
  await page.screenshot({ path: file, fullPage: true, timeout: 15_000 })
  const state = await page.evaluate(() => window.__STS_DEBUG__.getState())
  writeFileSync(join(outDir, `${label}.state.json`), JSON.stringify(state, null, 2))
  shots.push(label)
  return state
}

const readRun = () => page.evaluate(() => window.__STS_DEBUG__.getRun())
const readState = () => page.evaluate(() => window.__STS_DEBUG__.getState())

async function bypassNeow() {
  await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'neow')
  const run = await readRun()
  const solo = run.players.length === 1
  const next = {
    ...run,
    phase: 'map',
    neow: null,
    players: run.players.map((player) => ({
      ...player,
      gold: solo ? 2 : 0,
      relics: solo && !player.relics.some((relic) => relic.defId === 'loaded_die')
        ? [...player.relics, { defId: 'loaded_die', spent: false }]
        : player.relics,
    })),
  }
  await page.evaluate((state) => window.__STS_DEBUG__.setRun(state), next)
  await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'map' && !document.querySelector('.neow-screen'))
}

async function waitForPowerZoom() {
  await page.waitForFunction(() => {
    const image = document.querySelector('.power__zoom-image')
    return (image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0) ||
      document.querySelector('.power__zoom--fallback')
  })
}

async function chooseSeat(playerId) {
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'general' }).click()
  const selector = page.getByLabel('Seat')
  if (await selector.count()) await selector.selectOption(playerId)
  if (await page.locator('.combat').count()) {
    const expectedViewer = page.locator(`.seat--viewer[data-player-id="${playerId}"]`)
    await expectedViewer.waitFor()
  }
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: /Back/ }).click()
}

async function confirmDiscard(player) {
  await chooseSeat(player.id)
  await page.getByRole('button', { name: /^Confirm end-turn effect/ }).click()
}

async function confirmAllDiscards() {
  const state = await readState()
  const participants = state.players.filter(discardNeedsChoice)
  const selectedSeat = participants[0]?.id ?? state.players.find((player) => !player.dead)?.id ?? 'p1'
  for (const player of participants) {
    await confirmDiscard(player)
  }
  await chooseSeat(selectedSeat)
}

async function waitForAutomaticTurn(turn) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await page.waitForFunction((expected) => {
    const state = window.__STS_DEBUG__.getState()
    return state.turn >= expected && !['enemy', 'roundEnd'].includes(state.phase)
  }, turn)
}

async function waitForAutomaticEnemyResolution() {
  await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase !== 'enemy')
}

/**
 * Gives every seat a reason to be asked for a discard order.
 *
 * The prompt only appears for a player who owns a card that reads the top of
 * their discard pile — Claw is the cheapest — so any flow that means to exercise
 * the ordering UI has to opt in. An ordinary hand now walks straight past it.
 */
async function plantDiscardOrderCards() {
  await page.evaluate(() => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    for (const player of run.combat.players) {
      if (!player.draw.some((card) => card.defId === 'claw')) {
        player.draw = [...player.draw, { uid: `ui-claw-${player.id}`, defId: 'claw', upgraded: false }]
      }
      // Two cards, or there is no order to put them in and the prompt is still
      // skipped however many Claws the deck holds.
      while (player.hand.length < 2) {
        player.hand = [...player.hand, {
          uid: `ui-order-pad-${player.id}-${player.hand.length}`, defId: 'defend_ironclad', upgraded: false,
        }]
      }
    }
    debug.setRun(run)
  })
}

async function endTurn() {
  const initialViewer = await page.locator('.seat--viewer').getAttribute('data-player-id')
  if ((await readState()).phase === 'start') {
    await page.getByRole('button', { name: 'Resolve start of turn' }).click()
  }
  await page.getByRole('button', { name: 'End turn' }).click()
  for (let attempts = 0; attempts < 12 && (await readState()).phase === 'player'; attempts++) {
    const effectOwner = await page.evaluate(() => {
      const choice = window.__STS_DEBUG__.getRun().combat.endTurnProgress?.order[0]
      return choice?.includes('/') ? choice.split('/', 1)[0] : undefined
    })
    if (effectOwner) await page.evaluate((playerId) => window.__STS_DEBUG__.setViewer(playerId), effectOwner)
    await page.waitForTimeout(25)
    const effect = page.locator('button.end-turn-effect:not([disabled]):not([aria-disabled="true"])').first()
    if (await effect.count() === 0) break
    await effect.click()
    const target = page.locator('.enemy--targeted .enemy__hit-area').first()
    try { await target.waitFor({ timeout: 1_000 }) } catch { break }
    await target.click()
  }
  await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase !== 'player')
  if ((await readState()).phase === 'discard') {
    await confirmAllDiscards()
  }
  if (initialViewer) await page.evaluate((playerId) => window.__STS_DEBUG__.setViewer(playerId), initialViewer)
}

/** Clicks the first reachable room, which starts whatever that room is. */
async function enterFirstRoom() {
  await page.locator('.room--reachable').first().waitFor()
  await page.locator('.room--reachable').first().click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase !== 'map')
  if ((await readState()).phase === 'start') {
    await page.getByRole('button', { name: 'Resolve start of turn' }).click()
  }
}

const blockedStorageContext = await browser.newContext({ viewport: { width: 800, height: 600 } })
await blockedStorageContext.addInitScript(() => {
  const getItem = Storage.prototype.getItem
  Storage.prototype.getItem = function blockedSettingsRead(key) {
    if (key === 'sts-game-settings') throw new DOMException('Blocked', 'SecurityError')
    return getItem.call(this, key)
  }
})
const blockedStoragePage = await blockedStorageContext.newPage()
await blockedStoragePage.goto(base, { waitUntil: 'networkidle' })
const blockedStorageLoads = await blockedStoragePage.getByRole('button', { name: 'Single Player' }).count()
await blockedStorageContext.close()
check('blocked settings storage falls back without preventing startup', () => assertEqual(blockedStorageLoads, 1))

const legacyContext = await browser.newContext({ viewport: { width: 800, height: 600 } })
await legacyContext.addInitScript(() => localStorage.setItem('sts-sfx-enabled', 'off'))
const legacyPage = await legacyContext.newPage()
await legacyPage.goto(base, { waitUntil: 'networkidle' })
await legacyPage.getByRole('button', { name: 'Settings' }).click()
const legacyDialog = legacyPage.getByRole('dialog', { name: 'Settings' })
await legacyDialog.getByRole('button', { name: 'audio' }).click()
const legacyVolumes = {
  bgm: await legacyDialog.getByLabel('Music volume').inputValue(),
  sfx: await legacyDialog.getByLabel('Sound effects volume').inputValue(),
}
await legacyContext.close()
check('the legacy sound-off preference migrates music and effects as muted', () => {
  assertDeepEqual(legacyVolumes, { bgm: '0', sfx: '0' })
})

await page.goto(base, { waitUntil: 'networkidle' })
await page.waitForFunction(() => window.__STS_DEBUG__ !== undefined)

suite('browser')

await page.waitForFunction(() => JSON.parse(localStorage.getItem('sts-physical-campaign')).nextRunNumber === 0)
const freshMenuCampaign = await page.evaluate(() => ({
  saved: JSON.parse(localStorage.getItem('sts-physical-campaign')),
  draftRunId: window.__STS_DEBUG__.getRun().campaign.runId,
}))
await page.reload({ waitUntil: 'networkidle' })
await page.waitForFunction(() => window.__STS_DEBUG__ !== undefined && JSON.parse(localStorage.getItem('sts-physical-campaign')).nextRunNumber === 0)
const reloadedMenuCampaign = await page.evaluate(() => ({
  saved: JSON.parse(localStorage.getItem('sts-physical-campaign')),
  draftRunId: window.__STS_DEBUG__.getRun().campaign.runId,
}))
await shot('00-title-menu')
const singlePlayerLabel = await page.getByRole('button', { name: 'Single Player' }).textContent()
const legacyRunSettings = await page.locator('.start-menu__setup').count()
await page.getByRole('button', { name: 'Settings' }).click()
const settingsDialog = page.getByRole('dialog', { name: 'Settings' })
const settingsIsModal = await settingsDialog.evaluate((dialog) => dialog.matches(':modal'))
await page.getByRole('button', { name: 'Single Player' }).evaluate((button) => button.focus())
const settingsKeepsFocus = await settingsDialog.evaluate((dialog) => dialog.contains(document.activeElement))
const screenShakeControls = await settingsDialog.getByText('Screen shake', { exact: true }).count()
await settingsDialog.getByRole('button', { name: 'video' }).click()
const selectedSettingsTab = await settingsDialog.getByRole('button', { pressed: true }).textContent()
const videoSettingsPanel = await settingsDialog.getByRole('tabpanel', { name: 'video' }).count()
const videoSettings = await settingsDialog.textContent()
const fullscreenAction = await settingsDialog.getByRole('button', { name: 'Enter fullscreen' }).count()
// Entering fullscreen puts <html> in the top layer AFTER this dialog, so its
// opaque ::backdrop painted straight over the settings menu. SettingsDialog
// reopens the dialog on `fullscreenchange` to put it back on top. Headless
// cannot really go fullscreen, so the event is dispatched directly — that is the
// exact handler, and its failure mode (the menu vanishing, or shutting itself
// because the reopen's own close event leaked) is otherwise silent.
const fullscreenSurvives = await page.evaluate(async () => {
  const dialog = document.querySelector('dialog.settings-dialog')
  // Instrumented, because headless never really enters fullscreen: nothing ever
  // covers the dialog here, so "is it still painted" has no failing
  // configuration and passed even with the whole reopen deleted. What must be
  // asserted is the reopen ITSELF — a close immediately followed by a showModal,
  // which is what puts the dialog back at the end of the top layer.
  const calls = []
  const nativeClose = dialog.close.bind(dialog)
  const nativeShow = dialog.showModal.bind(dialog)
  dialog.close = (...args) => { calls.push('close'); return nativeClose(...args) }
  dialog.showModal = (...args) => { calls.push('showModal'); return nativeShow(...args) }
  document.dispatchEvent(new Event('fullscreenchange'))
  document.dispatchEvent(new Event('fullscreenchange'))
  await new Promise((done) => setTimeout(done, 80))
  const afterTwoInOneTask = dialog.open
  dialog.close = nativeClose
  dialog.showModal = nativeShow
  // A real native close, to leave a leftover suppression somewhere to show.
  // Nothing is asserted on `dialog.open` afterwards: `close()` clears it
  // synchronously whether or not React's handler swallowed the event, so it reads
  // the same either way. What a leak actually costs is state divergence — React
  // still believes the menu is open — and that only shows on the NEXT open.
  nativeClose()
  await new Promise((done) => setTimeout(done, 60))
  return {
    reopened: calls.join(',') === 'close,showModal,close,showModal',
    calls: calls.join(','),
    afterTwoInOneTask,
  }
})
// Under a leaked suppression React never learns the menu closed, so asking for
// it again is a no-op and the player is left with a button that does nothing.
await page.getByRole('button', { name: 'Settings' }).click()
const settingsReopens = await page.evaluate(async () => {
  await new Promise((done) => setTimeout(done, 80))
  return document.querySelector('dialog.settings-dialog').open
})
// Asserted HERE, not with the other fullscreen checks further down: under a
// leaked suppression the menu never opens, and every settings step after this
// point dies on a locator timeout before that check would have been reached.
check('a genuine close leaves the settings menu able to reopen', () => {
  assert(settingsReopens,
    'after a genuine close the Settings button no longer reopened the menu')
})
// Opened directly if the click could not, so the rest of the settings flow still
// reports its own results instead of collapsing behind this one failure.
if (!settingsReopens) await page.evaluate(() => document.querySelector('dialog.settings-dialog').showModal())
await settingsDialog.getByRole('button', { name: 'video' }).click()
await settingsDialog.getByLabel('High-contrast UI').check()
const highContrastRoot = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--cream').trim())
const highContrastTitleControl = await page.getByRole('button', { name: 'Single Player' }).evaluate((button) => getComputedStyle(button).color)
await settingsDialog.getByLabel('High-contrast UI').uncheck()
await settingsDialog.getByRole('button', { name: 'audio' }).click()
const sfxSlider = settingsDialog.getByLabel('Sound effects volume')
const voiceSlider = await settingsDialog.getByLabel('Voice chat volume').count()
const sfxStartsEnabled = await sfxSlider.getAttribute('value')
await sfxSlider.fill('0')
const sfxCanMute = await page.evaluate(() => localStorage.getItem('sts-sfx-enabled'))
await sfxSlider.fill('100')
const sfxCanRestore = await page.evaluate(() => localStorage.getItem('sts-sfx-enabled'))
const menuSounds = await page.evaluate(() => window.__SFX_PLAYS__)
const settingsAudioLayout = await settingsDialog.evaluate((dialog) => {
  const dialogBox = dialog.getBoundingClientRect()
  const cards = [...dialog.querySelectorAll('.settings-volume')]
  return {
    width: dialogBox.width,
    height: dialogBox.height,
    repeatedHeadings: dialog.querySelectorAll('[role="tabpanel"] h3').length,
    cardsContained: cards.every((card) => {
      const cardBox = card.getBoundingClientRect()
      return cardBox.left >= dialogBox.left && cardBox.right <= dialogBox.right
    }),
    slidersContained: cards.every((card) => {
      const cardBox = card.getBoundingClientRect()
      const sliderBox = card.querySelector('input[type="range"]')?.getBoundingClientRect()
      return sliderBox && sliderBox.left >= cardBox.left && sliderBox.right <= cardBox.right
    }),
  }
})
await shot('00-title-settings')
await page.keyboard.press('Escape')
await settingsDialog.waitFor({ state: 'hidden' })
const settingsDismissedWithEscape = await settingsDialog.isHidden()
await page.getByRole('button', { name: 'Single Player', exact: true }).click()
await page.getByRole('button', { name: 'Standard', exact: true }).click()
const {
  backSize: characterBackSize,
  embarkSize: characterEmbarkSize,
  backClip: characterBackClip,
  ...characterPickerControls
} = await page.locator('.start-menu__character-select').evaluate((screen) => ({
  textActions: [...screen.querySelectorAll('button')].filter((button) =>
    ['Back', 'Run settings', 'Embark'].includes(button.textContent?.trim() ?? '')).length,
  backRibbon: screen.querySelector('.start-menu__character-back')?.classList.contains('ribbon-back'),
  backText: screen.querySelector('.start-menu__character-back')?.textContent?.trim(),
  embarkIcon: screen.querySelector('.start-menu__character-embark')?.textContent?.trim(),
  embarkBorder: getComputedStyle(screen.querySelector('.start-menu__character-embark')).borderWidth,
  decreaseDisabled: screen.querySelector('[aria-label="Decrease Ascension"]')?.disabled,
  increaseDisabled: screen.querySelector('[aria-label="Increase Ascension"]')?.disabled,
  ascension: screen.querySelector('.start-menu__ascension > div p strong')?.textContent,
  backSize: (() => {
    const box = screen.querySelector('.start-menu__character-back')?.getBoundingClientRect()
    return box && { width: box.width, height: box.height }
  })(),
  embarkSize: (() => {
    const box = screen.querySelector('.start-menu__character-embark')?.getBoundingClientRect()
    return box && { width: box.width, height: box.height }
  })(),
  backClip: getComputedStyle(screen.querySelector('.start-menu__character-back')).clipPath,
}))
await page.locator('.start-menu__character-back').hover()
const characterBackHover = await page.locator('.start-menu__character-back').evaluate((button) => getComputedStyle(button).filter)
await page.locator('.start-menu__character-embark').hover()
const characterEmbarkHover = await page.locator('.start-menu__character-embark').evaluate((button) => getComputedStyle(button).filter)
await page.emulateMedia({ reducedMotion: 'reduce' })
await page.mouse.move(1, 1)
const characterBackReducedStaticShadow = await page.locator('.start-menu__character-back').evaluate((button) => getComputedStyle(button).boxShadow)
await page.locator('.start-menu__character-back').hover()
const characterBackReducedHover = await page.locator('.start-menu__character-back').evaluate((button) => {
  const style = getComputedStyle(button)
  return { filter: style.filter, transitionDuration: style.transitionDuration, animationDuration: style.animationDuration }
})
await page.locator('.start-menu__character-embark').hover()
const characterEmbarkReducedHover = await page.locator('.start-menu__character-embark').evaluate((button) => {
  const style = getComputedStyle(button)
  return { filter: style.filter, transitionDuration: style.transitionDuration, animationDuration: style.animationDuration }
})
await page.locator('.start-menu__character-back').focus()
await page.keyboard.press('ArrowLeft')
const characterBackReducedFocus = await page.locator('.start-menu__character-back').evaluate((button) => getComputedStyle(button).boxShadow)
await page.emulateMedia({ reducedMotion: 'no-preference' })
await page.getByRole('button', { name: 'Back', exact: true }).click()
await page.getByRole('button', { name: 'Single Player' }).hover()
const titleMenu = await page.locator('.start-menu').evaluate((menu) => {
  const box = menu.getBoundingClientRect()
  const title = menu.querySelector('.start-menu__title')?.getBoundingClientRect()
  const nav = menu.querySelector('.start-menu__nav')?.getBoundingClientRect()
  const setup = menu.querySelector('.start-menu__setup')?.getBoundingClientRect()
  return {
    box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom },
    title: title && { left: title.left, top: title.top, right: title.right, bottom: title.bottom },
    nav: nav && { left: nav.left, top: nav.top, right: nav.right, bottom: nav.bottom },
    setup: setup && { left: setup.left, top: setup.top, right: setup.right, bottom: setup.bottom },
    background: getComputedStyle(menu).backgroundImage,
    font: getComputedStyle(menu).fontFamily,
  }
})
const menuSelection = await page.locator('.start-menu__nav').evaluate((nav) => ({
  selected: [...nav.querySelectorAll('button')].filter((button) => button.matches(':hover, :focus-visible'))
    .map((button) => button.textContent?.trim()),
  marker: getComputedStyle(nav.querySelector('button:hover, button:focus-visible'), '::before').content,
}))
const titleMenuAt = async (width, height) => {
  await page.setViewportSize({ width, height })
  return page.locator('.start-menu').evaluate((menu) => {
    const box = (selector) => {
      const rect = menu.querySelector(selector).getBoundingClientRect()
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
    }
    return { title: box('.start-menu__title'), nav: box('.start-menu__nav'), version: box('.start-menu__version') }
  })
}
const compactTitleMenu = await titleMenuAt(844, 390)
const narrowTitleMenu = await titleMenuAt(568, 320)
const narrowMenuMarkers = await page.getByRole('button', { name: 'Single Player', exact: true }).evaluate((button) => {
  const box = button.getBoundingClientRect()
  const range = document.createRange()
  range.selectNodeContents(button)
  const text = range.getBoundingClientRect()
  const before = getComputedStyle(button, '::before')
  const after = getComputedStyle(button, '::after')
  return {
    beforeRight: box.left + Number.parseFloat(before.left) + Number.parseFloat(before.width),
    afterLeft: box.right - Number.parseFloat(after.right) - Number.parseFloat(after.width),
    text: { left: text.left, right: text.right },
  }
})
await shot('00-title-menu-phone-landscape')
await page.setViewportSize({ width: 1440, height: 900 })
check('the title menu fills the viewport without clipping its controls', () => {
  const separate = (first, second) => first.right < second.left || second.right < first.left ||
    first.bottom < second.top || second.bottom < first.top
  assert(titleMenu.background.includes('title-spire.webp'), 'the generated title backdrop is missing')
  assert(titleMenu.font.includes('Kreon'), `the game-style typeface is missing: ${titleMenu.font}`)
  for (const [name, box] of Object.entries({ title: titleMenu.title, nav: titleMenu.nav })) {
    assert(box && box.left >= titleMenu.box.left - 1 && box.right <= titleMenu.box.right + 1 &&
      box.top >= titleMenu.box.top - 1 && box.bottom <= titleMenu.box.bottom + 1,
    `${name} leaves the title viewport: ${JSON.stringify(box)}`)
  }
  assertDeepEqual(menuSelection.selected, ['Single Player'])
  assert(!menuSelection.marker.includes('☞'), `the menu still uses the cheap finger marker: ${menuSelection.marker}`)
  for (const [name, layout] of Object.entries({ compact: compactTitleMenu, narrow: narrowTitleMenu })) {
    assert(separate(layout.title, layout.nav),
    `${name} landscape title/menu overlap: ${JSON.stringify(layout)}`)
  }
  assert(narrowTitleMenu.version.top >= narrowTitleMenu.nav.bottom + 6,
    `narrow landscape menu/version overlap: ${JSON.stringify(narrowTitleMenu)}`)
  assert(narrowMenuMarkers.beforeRight + 4 <= narrowMenuMarkers.text.left &&
    narrowMenuMarkers.text.right + 4 <= narrowMenuMarkers.afterLeft,
  `narrow landscape menu markers crowd the label: ${JSON.stringify(narrowMenuMarkers)}`)
  assertEqual(singlePlayerLabel?.trim(), 'Single Player')
  assertEqual(legacyRunSettings, 0, 'the removed run-settings dialog remains in the title menu')
  assertDeepEqual(characterPickerControls, {
    textActions: 0,
    backRibbon: true,
    backText: '',
    embarkIcon: '✓',
    embarkBorder: '0px',
    decreaseDisabled: true,
    increaseDisabled: true,
    ascension: 'Ascension 0',
  })
  assertDeepEqual(characterBackSize, characterEmbarkSize, 'character Back size does not match Embark')
  assert(!characterBackClip.includes('16%'), 'character Back has the short generic ribbon cutout')
  assertEqual(characterBackHover, characterEmbarkHover, 'character Back hover does not match Embark')
  assertEqual(characterBackReducedHover.filter, characterEmbarkReducedHover.filter,
    'character controls use inconsistent static hover feedback with reduced motion')
  assertDeepEqual([
    characterBackReducedHover.transitionDuration, characterBackReducedHover.animationDuration,
    characterEmbarkReducedHover.transitionDuration, characterEmbarkReducedHover.animationDuration,
  ], ['0s', '0s', '0s', '0s'], 'character controls animate their hover feedback with reduced motion')
  assert(characterBackReducedFocus !== characterBackReducedStaticShadow, 'character Back loses its keyboard-focus cue with reduced motion')
  assert(settingsIsModal, 'settings did not open in the browser top layer')
  assert(settingsKeepsFocus, 'settings allowed focus to escape to the title menu')
  assertEqual(screenShakeControls, 0, 'the removed screen-shake preference is still visible')
  assertEqual(selectedSettingsTab?.trim(), 'video', 'the selected settings tab is not exposed')
  assertEqual(videoSettingsPanel, 1, 'the video tab does not control an accessible panel')
  assert(settingsDismissedWithEscape, 'Escape did not close settings')
  assert(videoSettings.includes('Reduce motion') && videoSettings.includes('High-contrast UI'), 'video accessibility options are missing')
  assertEqual(fullscreenAction, 1, 'fullscreen control is missing')
  assertEqual(voiceSlider, 1, 'voice chat volume is missing')
  assertEqual(highContrastRoot, '#fff9e8', 'high contrast did not reach the title screen')
  assertEqual(highContrastTitleControl, 'rgb(255, 255, 255)', 'high contrast did not change a rendered title control')
  assertEqual(sfxStartsEnabled, '100', 'sound effects should default on')
  assertEqual(sfxCanMute, 'off', 'sound preference did not mute')
  assertEqual(sfxCanRestore, 'on', 'sound preference did not restore')
  assert(menuSounds.includes('/assets/sfx/ui.ogg'), 'menu clicks did not play the UI sound')
  assert(settingsAudioLayout.width <= 802 && settingsAudioLayout.height <= 514,
    `settings remained oversized: ${JSON.stringify(settingsAudioLayout)}`)
  assertEqual(settingsAudioLayout.repeatedHeadings, 0, 'a selected settings tab repeated its own label')
  assert(settingsAudioLayout.cardsContained, 'an audio control card left the settings dialog')
  assert(settingsAudioLayout.slidersContained, 'an audio slider left its control card')
  assertEqual(freshMenuCampaign.saved.nextRunNumber, 0, 'opening the menu persisted a draft campaign run')
  assertEqual(reloadedMenuCampaign.saved.nextRunNumber, 0, 'reloading the menu consumed a campaign run number')
  assertEqual(freshMenuCampaign.draftRunId, 'campaign-1')
  assertEqual(reloadedMenuCampaign.draftRunId, 'campaign-1')
})

await page.getByRole('button', { name: 'Single Player', exact: true }).click()
await page.getByRole('region', { name: 'Run modes', exact: true }).waitFor()
const runModeSelection = await page.locator('.start-menu__mode-select').evaluate((screen) => ({
  contained: screen.scrollWidth <= screen.clientWidth + 3 && screen.scrollHeight <= screen.clientHeight + 3,
  choices: [...screen.querySelectorAll('.start-menu__mode-choice')].map((choice) => ({
    mode: choice.getAttribute('data-mode'),
    art: choice.querySelector('img')?.getAttribute('src'),
  })),
}))
const customContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const customPage = await customContext.newPage()
await customPage.goto(base)
await customPage.waitForFunction(() => window.__STS_DEBUG__ !== undefined)
await customPage.getByRole('button', { name: 'Single Player', exact: true }).click()
await customPage.getByRole('button', { name: 'Daily', exact: true }).click()
await customPage.getByRole('heading', { name: 'Daily Climb', exact: true }).waitFor()
const dailyPreview = await customPage.getByLabel('Daily Climb modifiers').evaluate((panel) =>
  [...panel.querySelectorAll('li')].map((entry) => entry.textContent?.trim()))
await customPage.getByRole('button', { name: 'Back', exact: true }).click()
await customPage.getByRole('button', { name: 'Custom', exact: true }).click()
await customPage.getByRole('heading', { name: 'Customize your run', exact: true }).waitFor()
await customPage.getByRole('checkbox', { name: /All Star/ }).check()
await customPage.getByLabel('Starting Act').selectOption('2')
const customSetup = await customPage.locator('.start-menu__run-options').evaluate((screen) => ({
  allStar: screen.querySelector('input[type="checkbox"]')?.checked,
  startingAct: screen.querySelector('select[aria-label="Starting Act"]')?.value,
}))
const customDesktopLayout = await customPage.locator('.start-menu__run-options').evaluate((screen) => {
  const panel = screen.querySelector('.start-menu__meta-panel')?.getBoundingClientRect()
  return { contained: screen.scrollWidth <= screen.clientWidth && screen.scrollHeight <= screen.clientHeight,
    panelContained: Boolean(panel && panel.top >= 0 && panel.bottom <= innerHeight) }
})
await customPage.setViewportSize({ width: 560, height: 315 })
const customPhoneLayout = await customPage.locator('.start-menu__run-options').evaluate((screen) => {
  const panel = screen.querySelector('.start-menu__meta-panel')
  const footer = screen.querySelector('footer')?.getBoundingClientRect()
  return { contained: screen.scrollWidth <= screen.clientWidth && screen.scrollHeight <= screen.clientHeight,
    panelScrollable: Boolean(panel && panel.scrollHeight > panel.clientHeight),
    footerVisible: Boolean(footer && footer.bottom <= innerHeight) }
})
await customPage.setViewportSize({ width: 1440, height: 900 })
await customPage.getByLabel('Starting Act').selectOption('1')
await customPage.getByRole('button', { name: 'Continue', exact: true }).click()
await customPage.getByRole('button', { name: 'Embark', exact: true }).click()
await customPage.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
await customPage.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'neow')
const customRunMeta = await customPage.evaluate(() => {
  const run = window.__STS_DEBUG__.getRun()
  return { ...run.meta, startedAtAct: run.campaign.startedAtAct }
})
await customContext.close()
await page.getByRole('button', { name: 'Standard', exact: true }).click()
await page.getByRole('heading', { name: 'Ironclad', exact: true }).waitFor()
await page.evaluate(() => {
  const run = window.__STS_DEBUG__.getRun()
  window.__STS_DEBUG__.setRun({ ...run, campaignProgress: { ...run.campaignProgress, highestAscension: 1 } })
})
await page.waitForFunction(() => !document.querySelector('[aria-label="Increase Ascension"]')?.disabled)
await page.getByRole('button', { name: 'Increase Ascension' }).click()
const ascensionRaised = await page.locator('.start-menu__ascension > div p strong').textContent()
await page.getByRole('button', { name: 'Decrease Ascension' }).click()
const characterCopy = {}
for (const name of ['Ironclad', 'Silent', 'Defect', 'Watcher']) {
  await page.getByRole('button', { name, exact: true }).click()
  await page.getByRole('heading', { name, exact: true }).waitFor()
  characterCopy[name] = await page.locator('.start-menu__character-copy').innerText()
}
await page.getByRole('button', { name: 'Silent', exact: true }).click()
const selectedCharacterScreen = page.locator('.start-menu__character-select').last()
await selectedCharacterScreen.locator('.start-menu__character-wallpaper[src$="character-silent-wallpaper.webp"]').waitFor()
await selectedCharacterScreen.locator('.start-menu__character-wallpaper[data-decoded]').waitFor()
const characterTransition = await selectedCharacterScreen.locator('.start-menu__character-wallpaper').evaluate((wallpaper) =>
  getComputedStyle(wallpaper).animationName)
await page.getByRole('button', { name: 'Ironclad', exact: true }).click()
await page.waitForTimeout(220)
const characterSelection = await page.locator('.start-menu__character-select').evaluate((screen) => {
  const overlap = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
  const box = screen.getBoundingClientRect()
  const wallpaper = screen.querySelector('.start-menu__character-wallpaper')?.getBoundingClientRect()
  const ascensionPanel = screen.querySelector('.start-menu__ascension > div')?.getBoundingClientRect()
  return {
    contained: screen.scrollWidth <= screen.clientWidth && screen.scrollHeight <= screen.clientHeight,
    wallpaperContained: Boolean(wallpaper && wallpaper.left <= box.left + 1 && wallpaper.right >= box.right - 1 && wallpaper.top <= box.top + 1 && wallpaper.bottom >= box.bottom - 1),
    portraits: [...screen.querySelectorAll('.start-menu__character-roster img')].map((image) => image.getAttribute('src')),
    selectedFilter: getComputedStyle(screen.querySelector('.start-menu__character-roster button[aria-pressed="true"] img')).filter,
    inactiveFilter: getComputedStyle(screen.querySelector('.start-menu__character-roster button:not([aria-pressed="true"]) img')).filter,
    flame: getComputedStyle(screen.querySelector('.start-menu__ascension-level')).backgroundImage,
    ascensionButtonsClear: Boolean(ascensionPanel && [...screen.querySelectorAll('.start-menu__ascension > button')]
      .every((button) => !overlap(button.getBoundingClientRect(), ascensionPanel))),
  }
})
await shot('00-title-character-select')
await page.getByRole('button', { name: 'Back', exact: true }).click()
await page.setViewportSize({ width: 560, height: 315 })
await page.getByRole('button', { name: 'Single Player', exact: true }).click()
const phoneRunModeSelection = await page.locator('.start-menu__mode-select').evaluate((screen) => ({
  contained: screen.scrollWidth <= screen.clientWidth + 2 && screen.scrollHeight <= screen.clientHeight + 2,
  size: {
    scrollWidth: screen.scrollWidth,
    clientWidth: screen.clientWidth,
    scrollHeight: screen.scrollHeight,
    clientHeight: screen.clientHeight,
  },
  choicesContained: [...screen.querySelectorAll('.start-menu__mode-choice')].every((choice) => {
    const box = choice.getBoundingClientRect()
    return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight
  }),
  backClear: (() => {
    const back = screen.querySelector('.start-menu__screen-back')?.getBoundingClientRect()
    return Boolean(back && [...screen.querySelectorAll('.start-menu__mode-choice')].every((choice) => {
      const box = choice.getBoundingClientRect()
      return box.bottom <= back.top || back.bottom <= box.top || box.right <= back.left || back.right <= box.left
    }))
  })(),
}))
await shot('00-title-run-modes-phone')
await page.getByRole('button', { name: 'Standard', exact: true }).click()
await page.setViewportSize({ width: 560, height: 315 })
await page.getByRole('heading', { name: 'Ironclad', exact: true }).waitFor()
await page.waitForTimeout(220)
await page.locator('.start-menu__character-back').hover()
const phoneCharacterBackHover = await page.locator('.start-menu__character-back').evaluate((button) => getComputedStyle(button).filter)
await page.locator('.start-menu__character-embark').hover()
const phoneCharacterEmbarkHover = await page.locator('.start-menu__character-embark').evaluate((button) => getComputedStyle(button).filter)
const phoneCharacterSelection = await page.locator('.start-menu__character-select').evaluate((screen) => {
  const overlap = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
  const roster = [...screen.querySelectorAll('.start-menu__character-roster button')].map((button) => {
    const box = button.getBoundingClientRect()
    return { left: box.left, right: box.right, top: box.top, bottom: box.bottom }
  })
  const controls = [...screen.querySelectorAll('.start-menu__ascension, .start-menu__character-back, .start-menu__character-embark')].map((control) => {
    const box = control.getBoundingClientRect()
    return { left: box.left, right: box.right, top: box.top, bottom: box.bottom }
  })
  const copy = screen.querySelector('.start-menu__character-copy')?.getBoundingClientRect()
  const ascension = screen.querySelector('.start-menu__ascension')?.getBoundingClientRect()
  const ascensionPanel = screen.querySelector('.start-menu__ascension > div')?.getBoundingClientRect()
  const back = screen.querySelector('.start-menu__character-back')
  const embark = screen.querySelector('.start-menu__character-embark')
  const backBox = back?.getBoundingClientRect()
  const embarkBox = embark?.getBoundingClientRect()
  return {
    contained: screen.scrollWidth <= screen.clientWidth && screen.scrollHeight <= screen.clientHeight,
    rosterContained: roster.every((box) => box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight),
    actionsClear: controls.every((control) => roster.every((choice) => !overlap(control, choice))),
    copyClear: Boolean(copy && ascension && !overlap(copy, ascension)),
    ascensionButtonsClear: Boolean(ascensionPanel && [...screen.querySelectorAll('.start-menu__ascension > button')]
      .every((button) => !overlap(button.getBoundingClientRect(), ascensionPanel))),
    ascensionCentered: Math.abs((screen.querySelector('.start-menu__ascension').getBoundingClientRect().left + screen.querySelector('.start-menu__ascension').getBoundingClientRect().right) / 2 - innerWidth / 2) <= 1,
    backSize: backBox && { width: backBox.width, height: backBox.height },
    embarkSize: embarkBox && { width: embarkBox.width, height: embarkBox.height },
    backClip: getComputedStyle(back).clipPath,
    embarkBorder: getComputedStyle(embark).borderWidth,
  }
})
await shot('00-title-character-select-phone')
await page.getByRole('button', { name: 'Back', exact: true }).click()
await page.setViewportSize({ width: 1440, height: 900 })
check('Single Player opens a contained visual character picker before starting', () => {
  assert(runModeSelection.contained, 'run mode selection needs a nested scrollbar')
  assertDeepEqual(runModeSelection.choices.map(({ mode }) => mode), ['standard', 'daily', 'custom'])
  assert(runModeSelection.choices.every(({ art }) => art?.includes('/assets/menu/run-modes/mode-')),
    `run mode illustrations are missing: ${JSON.stringify(runModeSelection.choices)}`)
  assertEqual(dailyPreview.length, 2, `Daily Climb did not show its two modifiers: ${dailyPreview.join(' / ')}`)
  assertDeepEqual(customSetup, { allStar: true, startingAct: '2' })
  assert(customDesktopLayout.contained && customDesktopLayout.panelContained &&
    customPhoneLayout.contained && customPhoneLayout.panelScrollable && customPhoneLayout.footerVisible,
  `Custom setup does not fit its supported screens: ${JSON.stringify({ customDesktopLayout, customPhoneLayout })}`)
  assertEqual(customRunMeta.mode, 'custom')
  assert(customRunMeta.modifierIds?.includes('all_star') && customRunMeta.startedAtAct === 1,
    `Custom run settings were not used: ${JSON.stringify(customRunMeta)}`)
  assert(characterSelection.contained, 'character selection needs a nested scrollbar')
  assert(characterSelection.wallpaperContained, 'selected character wallpaper leaves the selection frame')
  assertEqual(characterSelection.portraits.length, 8)
  assertEqual(new Set(characterSelection.portraits).size, 8, 'character roster reuses a portrait slot')
  assert(characterSelection.selectedFilter.includes('brightness(1.16)') && characterSelection.inactiveFilter.includes('brightness(0.72)'),
    'the selected character portrait is not brighter than the inactive portraits')
  assert(characterSelection.flame.includes('ascension-flame.png'), 'Ascension uses the fallback glyph instead of the flame emblem')
  assert(characterSelection.ascensionButtonsClear, 'Ascension buttons overlap the description on desktop')
  assert(/^character-wallpaper-in-[ab]$/.test(characterTransition), 'character selection does not transition between wallpapers')
  assertEqual(ascensionRaised, 'Ascension 1', 'the Ascension increase control does not change the selected level')
  assert(phoneRunModeSelection.contained && phoneRunModeSelection.choicesContained,
    `horizontal-phone run mode choices overflow the screen: ${JSON.stringify(phoneRunModeSelection)}`)
  assert(phoneCharacterSelection.contained && phoneCharacterSelection.rosterContained && phoneCharacterSelection.actionsClear && phoneCharacterSelection.copyClear && phoneCharacterSelection.ascensionButtonsClear && phoneCharacterSelection.ascensionCentered,
    'horizontal-phone character choices overlap or overflow')
  assert(Math.abs(phoneCharacterSelection.backSize.width - phoneCharacterSelection.embarkSize.width) <= 1 &&
    Math.abs(phoneCharacterSelection.backSize.height - phoneCharacterSelection.embarkSize.height) <= 2,
  'phone character Back size does not match Embark')
  assert(!phoneCharacterSelection.backClip.includes('16%'), 'phone character Back has the short generic ribbon cutout')
  assertEqual(phoneCharacterBackHover, phoneCharacterEmbarkHover, 'phone character Back hover does not match Embark')
  assertEqual(phoneCharacterSelection.embarkBorder, '0px', 'phone character Embark keeps a yellow border')
  for (const [name, special] of Object.entries({
    Ironclad: 'Burning Blood · End of combat: heal 1 HP.',
    Silent: 'Ring of the Snake',
    Defect: 'Cracked Core · Start of combat: channel 1 Lightning.',
    Watcher: 'Pure Water · Start of combat: gain 1 Miracle.',
  })) {
    assert(characterCopy[name].includes(special), `${name} is missing its special effect`)
    assert(characterCopy[name].length > 200, `${name} description is still too short`)
  }
})

// The Compendium's filters, detail and layout live in verify-compendium-browser.mjs.
await page.getByRole('button', { name: 'Single Player' }).click()
await page.getByRole('button', { name: 'Standard', exact: true }).click()
await page.getByRole('button', { name: 'Watcher' }).click()
await page.getByRole('button', { name: 'Embark' }).click()
await page.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
await page.getByRole('heading', { name: 'Neow’s Blessing' }).waitFor()
const configuredLocalRun = await readRun()
check('single-player setup starts exactly one selected character', () => {
  assertEqual(configuredLocalRun.lastStand, false)
  assertDeepEqual(configuredLocalRun.players.map((player) => player.character), ['watcher'])
})
const openingNeowFaces = await page.locator('.neow-face').count()
await page.waitForFunction(() => {
  const image = document.querySelector('.neow-screen__neow')
  return image instanceof HTMLImageElement && image.complete && image.naturalWidth === 1659
})
const openingNeowArtVisible = await page.locator('.neow-screen__neow').isVisible()
await shot('00a-neow-opening')
check('a new local run presents Neow and deals one public face per seat', () => {
  assert(openingNeowArtVisible, 'the supplied Neow asset is not visible')
  assertEqual(openingNeowFaces, 1)
})
await page.getByRole('button', { name: 'Reveal Card Reward' }).click()
await page.locator('.reward-screen--card-choice').getByRole('heading', { name: 'Choose a Card' }).waitFor()
await page.locator('.neow-action--offer .card').first().waitFor()
const neowRewardChoiceCount = await page.evaluate(() =>
  Object.values(window.__STS_DEBUG__.getRun().neow.players)[0].redReward.choices.length)
const neowRewardCards = await page.locator('.neow-action--offer .card').evaluateAll((cards) => cards.map((card) => {
  const box = card.getBoundingClientRect()
  return { top: box.top, bottom: box.bottom, visible: box.top >= 0 && box.bottom <= innerHeight }
}))
const baseNeowRewardTitle = await page.locator('.neow-action--offer .card').first().getAttribute('data-card-name')
await page.evaluate(() => {
  const run = structuredClone(window.__STS_DEBUG__.getRun())
  Object.values(run.neow.players)[0].redReward.upgraded = true
  window.__STS_DEBUG__.setRun(run)
})
await page.waitForFunction(() => document.querySelector('.neow-action--offer .card')?.getAttribute('data-card-name')?.endsWith('+'))
const upgradedNeowRewardTitle = await page.locator('.neow-action--offer .card').first().getAttribute('data-card-name')
const staleNeowRewardLabel = await page.getByText('Resolve face-up reward', { exact: true }).count()
await shot('00b-neow-card-reward')
check('Neow shows complete private reward cards on the desktop stage', () => {
  assert(neowRewardChoiceCount > 0, 'Neow revealed no selectable card')
  assertEqual(neowRewardCards.length, neowRewardChoiceCount)
  assert(neowRewardCards.some((card) => card.visible), `no complete reward card is visible: ${JSON.stringify(neowRewardCards)}`)
  assertEqual(upgradedNeowRewardTitle, `${baseNeowRewardTitle}+`, 'an upgraded Boon offer rendered its base card face')
  assertEqual(staleNeowRewardLabel, 0)
})
await bypassNeow()
await page.locator('.map').waitFor()

// Two cards upgraded in ONE engine step queue two morphs, and effects that do
// that tend to produce identical sentences — Whetstone upgrades a starter Strike
// and another Attack, Astrolabe three cards. A live region announces on DOM
// MUTATION, so the second identical sentence is only heard if the region blanks
// between them. Recording every mutation, empty ones included, is what pins that;
// counting only non-empty text passes even when the repeat is silent.
await page.evaluate(() => {
  window.__MORPH_SPOKEN__ = []
  const region = document.querySelector('p.visually-hidden[aria-live="polite"]')
  if (!region) return
  window.__MORPH_REGION__ = region
  new MutationObserver(() => window.__MORPH_SPOKEN__.push(region.textContent.trim()))
    .observe(region, { childList: true, characterData: true, subtree: true })
})
await page.evaluate(() => {
  const run = structuredClone(window.__STS_DEBUG__.getRun())
  let upgraded = 0
  run.players[0].deck = run.players[0].deck.map((card) => {
    if (!card.upgraded && upgraded < 2) { upgraded += 1; return { ...card, upgraded: true } }
    return card
  })
  window.__STS_DEBUG__.setRun(run)
})
await page.waitForFunction(() => (window.__MORPH_SPOKEN__ ?? []).filter(Boolean).length >= 2, null,
  { timeout: 12000 })
const morphSpoken = await page.evaluate(() => ({
  sequence: window.__MORPH_SPOKEN__ ?? [],
  regionStillAttached: window.__MORPH_REGION__?.isConnected === true,
}))
check('two identical card upgrades are each announced', () => {
  const spoken = morphSpoken.sequence.filter(Boolean)
  assert(spoken.length >= 2, `expected an announcement per upgrade, got ${JSON.stringify(morphSpoken.sequence)}`)
  assertEqual(spoken[0], spoken[1], 'this check is only meaningful when both sentences match')
  assert(morphSpoken.sequence.indexOf('') > -1,
    `the region never blanked, so the repeat is silent: ${JSON.stringify(morphSpoken.sequence)}`)
  // Blanking, not re-keying: a live region that is removed and re-added is not
  // reliably announced at all, so the node must survive.
  assert(morphSpoken.regionStillAttached, 'the live region node was replaced rather than blanked')
})
await page.waitForFunction(() => !document.querySelector('.card-morph'))
await page.evaluate(async () => {
  const run = structuredClone(window.__STS_DEBUG__.getRun())
  run.players[0].deck[0] = { ...run.players[0].deck[0], defId: 'guardian_fierce_bash', upgraded: false,
    attachedGemId: undefined }
  window.__STS_DEBUG__.setRun(run)
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  const socketed = structuredClone(run)
  socketed.players[0].deck[0].attachedGemId = 'guardian_garnet'
  window.__STS_DEBUG__.setRun(socketed)
})
await page.locator('.card-morph--socket').waitFor()
await page.waitForFunction(() => document.querySelector('p.visually-hidden[aria-live="polite"]')
  ?.textContent?.includes('Fierce Bash socketed with Garnet.'))
const socketMorph = await page.locator('.card-morph--socket').evaluate((overlay) => ({
  caption: overlay.querySelector('.card-morph__caption')?.textContent,
  sourceFaces: [...overlay.querySelectorAll('.card-morph__slot--from img.card__art, .card-morph__slot--gem img.card__art')]
    .map((image) => image.getAttribute('src')),
  combinedFace: overlay.querySelector('.card-morph__slot--to img.card__art')?.getAttribute('src'),
}))
check('socketing animates the host and Gem combining into the generated face', () => {
  assertEqual(socketMorph.caption, 'Socketed')
  assert(socketMorph.sourceFaces.some((src) => src?.endsWith('/guardian__normal__fierce-bash.webp')),
    JSON.stringify(socketMorph))
  assert(socketMorph.sourceFaces.some((src) => src?.endsWith('/guardian__normal__garnet.webp')),
    JSON.stringify(socketMorph))
  assert(socketMorph.combinedFace?.endsWith('/guardian__normal__fierce-bash--garnet.webp'),
    JSON.stringify(socketMorph))
})
await page.locator('.card-morph--socket.card-morph--new').waitFor()
await shot('01a-guardian-socket-combine')
await page.waitForFunction(() => !document.querySelector('.card-morph'))
await page.setViewportSize({ width: 844, height: 390 })
await page.evaluate(async () => {
  const plain = structuredClone(window.__STS_DEBUG__.getRun())
  delete plain.players[0].deck[0].attachedGemId
  window.__STS_DEBUG__.setRun(plain)
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  const socketed = structuredClone(plain)
  socketed.players[0].deck[0].attachedGemId = 'guardian_garnet'
  window.__STS_DEBUG__.setRun(socketed)
})
await page.locator('.card-morph--socket').waitFor()
const phoneSocketBounds = await page.locator('.card-morph--socket').evaluate((overlay) => {
  const boxes = [...overlay.querySelectorAll('.card-morph__slot--from, .card-morph__slot--gem')]
    .map((slot) => slot.getBoundingClientRect())
  return boxes.map(({ left, right, top, bottom }) => ({ left, right, top, bottom }))
})
check('socket source cards fit a horizontal phone while they combine', () => {
  assert(phoneSocketBounds.length === 2 && phoneSocketBounds.every((box) =>
    box.left >= 0 && box.right <= 844 && box.top >= 0 && box.bottom <= 390),
  JSON.stringify(phoneSocketBounds))
})
await page.locator('.card-morph--socket.card-morph--new').waitFor()
await shot('01b-guardian-socket-combine-phone')
await page.waitForFunction(() => !document.querySelector('.card-morph'))
await page.setViewportSize({ width: 1440, height: 900 })
await page.evaluate(() => {
  const run = structuredClone(window.__STS_DEBUG__.getRun())
  run.players[0].deck = run.players[0].deck.slice(1)
  window.__STS_DEBUG__.setRun(run)
})
await page.locator('.card-morph--remove').waitFor()
const removalMorph = await page.locator('.card-morph--remove').evaluate((overlay) => ({
  caption: overlay.querySelector('.card-morph__caption')?.textContent,
  hasOldCard: Boolean(overlay.querySelector('.card-morph__slot--from .card')),
  hasReplacement: Boolean(overlay.querySelector('.card-morph__slot--to .card')),
}))
check('removing a card burns away the old face without inventing a replacement', () => {
  assertEqual(removalMorph.caption, 'Removed')
  assert(removalMorph.hasOldCard, 'the removed card face never appeared')
  assertEqual(removalMorph.hasReplacement, false)
})
await page.waitForFunction(() => !document.querySelector('.card-morph'))

const firstLocalRun = await readRun()
const selectedLocalParty = firstLocalRun.players.map((player) => player.character)
check('local setup starts an arbitrary legal character party', () => {
  assertDeepEqual(selectedLocalParty, ['watcher'])
  assertEqual(firstLocalRun.campaign.runId, 'campaign-1', 'the first played local run skipped its campaign number')
})
await page.evaluate(() => window.__STS_DEBUG__.reset(2, 'spire'))
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().players[0]?.character === 'ironclad')
await bypassNeow()
await page.locator('.room--reachable').waitFor()
await page.waitForFunction(() => {
  const map = document.querySelector('.map:not([inert])')
  const room = map?.querySelector('.room--reachable')
  if (!map || !room) return false
  const port = map.getBoundingClientRect()
  const node = room.getBoundingClientRect()
  return node.top >= port.top && node.bottom <= port.bottom
})

// A run opens on the map with the boot beside the board (p.9).
const opening = await readRun()
await shot('01-map-start')
check('a run opens on the map with one way in', () => {
  assertEqual(opening.phase, 'map', 'the run should start on the map')
  assertEqual(opening.act, 1)
  assertEqual(opening.map.position, null, 'the boot starts beside the map')
})

const reachableAtStart = await page.locator('.room--reachable').count()
check('exactly one room is reachable at the start', () => {
  assertEqual(reachableAtStart, 1, 'the opening encounter is the only way in')
})

await page.evaluate(() => {
  const run = structuredClone(window.__STS_DEBUG__.getRun())
  run.meta.ruleset = 'downfall'
  run.meta.campaign = 'downfall'
  run.actBossDefId = 'downfall_inferno'
  run.selfBossRerolled = false
  window.__STS_DEBUG__.setRun(run)
})
const selfBossReroll = page.getByRole('button', { name: 'Reroll The Inferno' })
await selfBossReroll.waitFor()
await selfBossReroll.click()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().actBossDefId !== 'downfall_inferno')
const rerolledBoss = (await readRun()).actBossDefId
check('the opening map exposes and spends the optional Downfall self-boss reroll', () => {
  assert(rerolledBoss !== 'downfall_inferno', 'the self-boss was not rerolled')
})
await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), opening)
await page.waitForFunction((boss) => window.__STS_DEBUG__.getRun().actBossDefId === boss, opening.actBossDefId)
const rowSwitchPanel = page.getByText('Switch rows before the next combat', { exact: true }).locator('..')
const rowSwitches = rowSwitchPanel.locator('select')
const rowSwitchCount = await rowSwitches.count()
check('the map exposes every local player row between combats', () => {
  assertEqual(rowSwitchCount, 2)
})
await rowSwitches.first().selectOption('1')
await page.waitForFunction(() => {
  const players = window.__STS_DEBUG__.getRun().players
  return players[0].row === 1 && players[1].row === 0
})
const switchedRows = (await readRun()).players.map((player) => player.row)
check('switching into an occupied row swaps the players', () => {
  assertDeepEqual(switchedRows, [1, 0])
})
await rowSwitches.first().selectOption('0')
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().players[0].row === 0)
const mapBeforeRoomSwitchCheck = await readRun()
await page.evaluate((run) => window.__STS_DEBUG__.setRun({
  ...run,
  phase: 'room',
  roomState: {
    kind: 'event', decisions: {}, dieRolls: {},
    card: { id: 'encounter', name: 'Encounter!', scope: 'party', instanceId: 'test-encounter', act: 1, minAscension: 0, requiresColorlessUnlock: false,
      options: [{ id: 'fight', label: 'Fight!', description: 'Treat this room as an Encounter.', effects: [{ tag: 'combat', room: 'encounter' }] }] },
  },
}), mapBeforeRoomSwitchCheck)
const roomRowSwitchCount = await page.getByText('Switch rows before the next combat', { exact: true })
  .locator('..').locator('select').count()
check('local noncombat rooms keep row switching available', () => {
  assertEqual(roomRowSwitchCount, 2)
})
await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), mapBeforeRoomSwitchCheck)
await page.locator('.room--reachable').waitFor()

await page.locator('.room--reachable').hover()
await page.waitForFunction(() =>
  getComputedStyle(document.querySelector('.room--reachable .room-tip')).visibility === 'visible')
const openingMapTip = await page.evaluate(() => {
  const map = document.querySelector('.map')
  const tip = document.querySelector('.room--reachable .room-tip')
  const mapBox = map.getBoundingClientRect()
  const tipBox = tip.getBoundingClientRect()
  return { contained: tipBox.bottom <= mapBox.bottom + 1 }
})
check('entering fullscreen re-enters the settings menu into the top layer', () => {
  assert(fullscreenSurvives.reopened,
    `a fullscreen change did not close-and-reopen the dialog: saw "${fullscreenSurvives.calls}"`)
  // Two events in one task is the case a boolean flag cannot survive: it is
  // consumed once, so the second reopen's close is honoured and the menu shuts.
  assert(fullscreenSurvives.afterTwoInOneTask,
    'two fullscreen changes in one task closed the settings menu')
})
check('the opening map node tooltip has room below it', () => {
  assert(openingMapTip.contained, 'the opening Encounter tooltip was clipped below the map')
})

await enterFirstRoom()
await page.waitForFunction(() => document.querySelector('.hand .card--drawn'))
const openingDealMotion = await page.locator('.hand .card--drawn').first().evaluate((card) =>
  getComputedStyle(card).animationName)
await page.evaluate(() => {
  for (const animation of document.getAnimations()) {
    if (animation.animationName === 'card-draw') {
      animation.currentTime = 260
      animation.pause()
    }
  }
})
await page.screenshot({ path: join(animationReferenceDir, 'combat-card-draw.png'), timeout: 15_000 })
await page.evaluate(() => {
  for (const animation of document.getAnimations()) {
    if (animation.animationName === 'card-draw' && animation.playState === 'paused') animation.play()
  }
})
const booted = await shot('02-combat-start')
check('the first room is an encounter and starts a combat', () => {
  assertEqual(booted.phase, 'player', 'combat opens on the Player Turn')
  assertEqual(booted.players[0].hand.length, 5, 'five cards are dealt')
  assertEqual(booted.players[0].energy, 3, 'energy starts at 3')
  assert(booted.die >= 1 && booted.die <= 6, `die should be 1-6, got ${booted.die}`)
  assertEqual(openingDealMotion, 'card-draw', 'the opening hand should deal into place')
})

await page.locator('.relic-chip').first().hover()
await page.waitForFunction(() => getComputedStyle(document.querySelector('.relic-tip')).visibility === 'visible')
const combatChrome = await page.evaluate(() => {
  const header = document.querySelector('.app-shell__header').getBoundingClientRect()
  const combat = document.querySelector('.combat').getBoundingClientRect()
  const bar = document.querySelector('.combat__bar')
  const board = document.querySelector('.board')
  const root = document.documentElement
  return {
    headerBottom: header.bottom,
    combatTop: combat.top,
    barBackground: getComputedStyle(bar).backgroundImage,
    barBorder: getComputedStyle(bar).borderBottomWidth,
    boardShadow: getComputedStyle(board).boxShadow,
    rootScrollbar: getComputedStyle(root).scrollbarWidth,
    rootWebkitScrollbar: getComputedStyle(root, '::-webkit-scrollbar').display,
  }
})
await page.mouse.move(0, 0)
await page.waitForFunction(() => getComputedStyle(document.querySelector('.relic-tip')).visibility === 'hidden')
check('relic hover adds no scrollbar chrome and combat keeps one continuous stage', () => {
  assertEqual(combatChrome.headerBottom, combatChrome.combatTop)
  assertEqual(combatChrome.barBackground, 'none')
  assertEqual(combatChrome.barBorder, '0px')
  assertEqual(combatChrome.boardShadow, 'none')
  assertEqual(combatChrome.rootScrollbar, 'none')
  assertEqual(combatChrome.rootWebkitScrollbar, 'none')
})

const pauseMenu = await openPause()
const pauseActions = await pauseMenu.getByRole('button').allTextContents()
const pausedCombat = await readState()
await shot('02a-combat-paused')
await pauseMenu.getByRole('button', { name: 'Resume' }).click()
await pauseMenu.waitFor({ state: 'hidden' })
check('Escape pauses combat without changing it and exposes the expected run actions', () => {
  assertDeepEqual(pausedCombat, booted)
  assertDeepEqual(pauseActions.map((label) => label.trim()), ['Resume', 'Settings', 'Compendium', 'Give up', 'Return to main menu'])
})

const activeRun = await readRun()
const activeRunId = activeRun.campaign.runId
await page.getByRole('button', { name: 'Settings' }).click()
const runSettings = page.getByRole('dialog', { name: 'Settings' })
const settingsRunActions = await runSettings.getByRole('button').allTextContents()
const runGeneralSettings = await runSettings.getByRole('button', { name: 'general' }).count()
await runSettings.getByRole('button', { name: /Back/ }).click()
const iconOnlySettingsText = await page.locator('.game-settings').textContent()
check('the HUD settings button is icon-only and contains no run-abandon actions', () => {
  assertEqual(iconOnlySettingsText?.trim(), '')
  assert(!settingsRunActions.some((label) => /Give up|Return to main menu|New run|Play online/.test(label)))
  assertEqual(runGeneralSettings, activeRun.meta.modifierIds.length > 0 || activeRun.players.length > 1 ? 1 : 0)
})

const runBeforeFightCompendium = await readRun()
await page.keyboard.press('Escape')
await pauseMenu.getByRole('button', { name: 'Compendium' }).click()
await page.locator('.compendium').waitFor()
await page.getByPlaceholder('Search').fill('Bash')
await page.getByLabel('View upgrades').check()
const fightCompendiumUpgrade = await page.locator('.compendium-card img').first().getAttribute('src')
await page.getByRole('button', { name: 'Back to run' }).click()
await page.locator('.combat').waitFor()
const runAfterFightCompendium = await readRun()
check('fight settings can inspect upgraded cards and resume the unchanged run', () => {
  assert(fightCompendiumUpgrade?.includes('bash+.webp'), `wrong upgraded card art: ${fightCompendiumUpgrade}`)
  assertDeepEqual(runAfterFightCompendium, runBeforeFightCompendium)
})

await openPause()
await page.evaluate(() => {
  const run = structuredClone(window.__STS_DEBUG__.getRun())
  run.combat.phase = 'enemy'
  window.__STS_DEBUG__.setRun(run)
})
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'enemy')
const runBeforeGiveUpWait = await readRun()
await pauseMenu.getByRole('button', { name: 'Give up' }).click()
const soloGiveUp = page.getByRole('dialog', { name: 'Give up this run?' })
const soloGiveUpModal = await soloGiveUp.evaluate((dialog) => dialog.matches(':modal'))
await page.waitForTimeout(1_100)
const runDuringGiveUpWait = await readRun()
await soloGiveUp.getByRole('button', { name: 'Cancel' }).click()
await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), runBeforeFightCompendium)
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'player')
const runAfterGiveUpCancel = await readRun()
await page.keyboard.press('Escape')
await pauseMenu.getByRole('button', { name: 'Give up' }).click()
await soloGiveUp.getByRole('button', { name: 'Yes, give up' }).click()
await page.getByRole('heading', { name: 'The party has fallen' }).waitFor()
const surrenderedSoloRun = await readRun()
await openPause()
const terminalPauseActions = await pauseMenu.getByRole('button').allTextContents()
await pauseMenu.getByRole('button', { name: 'Resume' }).click()
await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), runBeforeFightCompendium)
await page.locator('.combat').waitFor()
check('single-player Give up uses a modal confirmation and ends the fight immediately', () => {
  assert(soloGiveUpModal, 'the give-up confirmation was not modal')
  assertDeepEqual(runDuringGiveUpWait, runBeforeGiveUpWait, 'combat advanced behind the Give up confirmation')
  assertDeepEqual(runAfterGiveUpCancel, runBeforeFightCompendium)
  assertEqual(surrenderedSoloRun.phase, 'defeat')
  assert(surrenderedSoloRun.log.includes('The party gives up.'))
  assert(!terminalPauseActions.some((label) => label.trim() === 'Give up'), 'terminal pause offered a no-op Give up action')
})

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  Object.assign(run, { act: 2, phase: 'victory', combat: null })
  run.map.position = null
  debug.setRun(run)
})
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'victory')
const localCatchUpPanel = await page.getByRole('heading', { name: 'Catch Up' }).count()
await openPause()
const boundaryPauseActions = await pauseMenu.getByRole('button').allTextContents()
await pauseMenu.getByRole('button', { name: 'Give up' }).click()
await soloGiveUp.getByRole('button', { name: 'Yes, give up' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'defeat')
const surrenderedFromMap = await readRun()
await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), activeRun)
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'combat')
check('Escape owns the Act-boundary return flow without exposing a local catch-up setup', () => {
  assert(boundaryPauseActions.some((label) => label.trim() === 'Return to main menu'))
  assert(boundaryPauseActions.some((label) => label.trim() === 'Give up'))
  assert(boundaryPauseActions.some((label) => label.trim() === 'Compendium'))
  assertEqual(surrenderedFromMap.phase, 'defeat')
  assertEqual(activeRunId, (activeRun.campaign.runId))
  assertEqual(localCatchUpPanel, 0, 'Single Player exposed a local add-player path')
})

await plantDiscardOrderCards()
const combatAppearanceRun = await readRun()
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  Object.assign(run.combat.enemies[0], { defId: 'sentry_a', hp: 7, maxHp: 7, dead: false })
  Object.assign(run.combat.players[0], { block: 1, strength: 1 })
  debug.setRun(run)
})
await page.waitForFunction(() => document.querySelector('.enemy[data-enemy-def="sentry_a"] .enemy__art--cutout')?.naturalWidth === 800)
const combatAppearance = await page.evaluate(() => {
  const image = document.querySelector('.enemy[data-enemy-def="sentry_a"] .enemy__art--cutout')
  const strip = document.querySelector('.row__seat .seat__status-strip')
  const bar = strip?.parentElement?.querySelector('.seat > .bar')
  const overlap = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
  return {
    naturalWidth: image?.naturalWidth ?? 0,
    naturalHeight: image?.naturalHeight ?? 0,
    statusOverlapsHp: strip && bar ? overlap(strip.getBoundingClientRect(), bar.getBoundingClientRect()) : true,
  }
})
await shot('02b-sentry-cutout-and-status')
check('Sentry uses a transparent full-body cutout and character status clears HP', () => {
  assertDeepEqual([combatAppearance.naturalWidth, combatAppearance.naturalHeight], [800, 1201])
  assertEqual(combatAppearance.statusOverlapsHp, false)
})
await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), combatAppearanceRun)

const hallwayMusic = [
  [1, 'exordium.mp3', 'hallway-1-1'], [1, 'battle-trance.mp3', 'hallway-1-0'],
  [2, 'the-city.mp3', 'hallway-2-0'], [2, 'escape-plan.mp3', 'hallway-2-1'],
  [3, 'dramatic-entrance.mp3', 'hallway-3-1'], [3, 'the-beyond.mp3', 'hallway-3-0'],
  [4, 'the-ending.mp3', 'hallway-4-0'],
]
for (const [act, file, combatId] of hallwayMusic) {
  await page.evaluate(({ run, act, combatId }) => {
    const next = structuredClone(run)
    next.act = act
    next.combat.combatId = combatId
    Object.assign(next.combat.enemies[0], { defId: 'sentry_a', isBoss: false, dead: false })
    window.__STS_DEBUG__.setRun(next)
  }, { run: combatAppearanceRun, act, combatId })
  await page.waitForFunction((file) => window.__SFX_PLAYS__.includes(`/assets/bgm/${file}`), file)
}
const eliteMusicBefore = await page.evaluate(() => window.__SFX_PLAYS__.length)
await page.evaluate((run) => {
  const next = structuredClone(run)
  next.act = 1
  next.combat.combatId = 'hallway-1-1'
  Object.assign(next.combat.enemies[0], { defId: 'lagavulin', actionIndex: 0, isBoss: false, dead: false })
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
await page.waitForFunction((before) => window.__SFX_PLAYS__.slice(before).includes('/assets/bgm/exordium.mp3'), eliteMusicBefore)
const awakeEliteMusicBefore = await page.evaluate(() => window.__SFX_PLAYS__.length)
await page.evaluate(() => {
  const next = structuredClone(window.__STS_DEBUG__.getRun())
  next.combat.enemies[0].actionIndex = 1
  window.__STS_DEBUG__.setRun(next)
})
await page.waitForFunction((before) => window.__SFX_PLAYS__.slice(before).includes('/assets/bgm/facing-the-elite.mp3'), awakeEliteMusicBefore)
check('combat music follows each act and Lagavulin changes themes when it wakes', () => {
  assert(true)
})
const victoryMusicBefore = await page.evaluate(() => window.__SFX_PLAYS__.length)
await page.evaluate((run) => {
  const next = structuredClone(run)
  Object.assign(next, { act: 4, phase: 'victory', combat: null })
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
await page.waitForFunction((before) => window.__SFX_PLAYS__.slice(before).includes('/assets/bgm/the-spire-slain.mp3'), victoryMusicBefore)
const victoryMusicPauseBefore = await page.evaluate(() => window.__BGM_PAUSES__.length)
await page.evaluate(() => {
  const next = structuredClone(window.__STS_DEBUG__.getRun())
  next.campaign.finalized = true
  window.__STS_DEBUG__.setRun(next)
})
await page.waitForFunction((before) => window.__BGM_PAUSES__.slice(before).includes('/assets/bgm/the-spire-slain.mp3'), victoryMusicPauseBefore)
await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), combatAppearanceRun)
check('terminal victory plays The Spire Slain only until the campaign journal', () => assert(true))
const musicBeforeOrdinary = await page.evaluate(() => window.__SFX_PLAYS__.length)
await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), combatAppearanceRun)

const musicBeforeBoss = await page.evaluate((before) => window.__SFX_PLAYS__.slice(before), musicBeforeOrdinary)
check('ordinary combat does not start boss music', () => {
  assert(!musicBeforeBoss.some((sound) => sound.startsWith('/assets/bgm/')))
})
const bossMusic = [
  ['hexaghost', 'the-guardian-emerges.mp3'],
  ['the_champ', 'battle-with-the-champ.mp3'],
  ['awakened_one_phase_1', 'the-awakened-one.mp3'],
  ['corrupt_heart', 'the-heart.mp3'],
]
for (const [defId, file] of bossMusic) {
  const before = await page.evaluate(() => window.__SFX_PLAYS__.length)
  await page.evaluate(({ run, defId }) => {
    const next = structuredClone(run)
    Object.assign(next.combat.enemies[0], { defId, isBoss: true, dead: false })
    window.__STS_DEBUG__.setRun(next)
  }, { run: combatAppearanceRun, defId })
  await page.waitForFunction(({ before, file }) =>
    window.__SFX_PLAYS__.slice(before).includes(`/assets/bgm/${file}`), { before, file })
}
const slimeBossMusicBefore = await page.evaluate(() => window.__SFX_PLAYS__.length)
const slimeBossPauseBefore = await page.evaluate(() => window.__BGM_PAUSES__.filter((sound) => sound === '/assets/bgm/the-guardian-emerges.mp3').length)
await page.evaluate((run) => {
  const next = structuredClone(run)
  Object.assign(next.combat.enemies[0], { defId: 'slime_boss', isBoss: true, dead: false })
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
await page.waitForFunction((before) => window.__SFX_PLAYS__.slice(before).includes('/assets/bgm/the-guardian-emerges.mp3'), slimeBossMusicBefore)
await page.evaluate(() => {
  const next = structuredClone(window.__STS_DEBUG__.getRun())
  next.combat.enemies[0].dead = true
  window.__STS_DEBUG__.setRun(next)
})
await page.waitForTimeout(100)
const slimeBossMusicContinues = await page.evaluate((before) => window.__BGM_PAUSES__.filter((sound) => sound === '/assets/bgm/the-guardian-emerges.mp3').slice(before).length, slimeBossPauseBefore)
check('Slime Boss music continues through its split', () => assertEqual(slimeBossMusicContinues, 0))
for (const phase of ['won', 'lost']) {
  const before = await page.evaluate(() => window.__BGM_PAUSES__.length)
  await page.evaluate((phase) => {
    const next = structuredClone(window.__STS_DEBUG__.getRun())
    next.combat.phase = phase
    window.__STS_DEBUG__.setRun(next)
  }, phase)
  await page.waitForFunction(({ before }) => window.__BGM_PAUSES__.slice(before).includes('/assets/bgm/the-guardian-emerges.mp3'), { before })
  if (phase === 'won') {
    const restartBefore = await page.evaluate(() => window.__SFX_PLAYS__.length)
    await page.evaluate((run) => {
      const next = structuredClone(run)
      Object.assign(next.combat.enemies[0], { defId: 'slime_boss', isBoss: true, dead: false })
      window.__STS_DEBUG__.setRun(next)
    }, combatAppearanceRun)
    await page.waitForFunction((before) => window.__SFX_PLAYS__.slice(before).includes('/assets/bgm/the-guardian-emerges.mp3'), restartBefore)
  }
}
check('boss music stops when combat ends', () => assert(true))

await page.evaluate((run) => {
  const next = structuredClone(run)
  next.combat.phase = 'won'
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'won')
await openPause()
const finishedCombatGiveUpCount = await pauseMenu.getByRole('button', { name: 'Give up' }).count()
await page.waitForTimeout(1_100)
const pausedFinishedCombat = await readRun()
await pauseMenu.getByRole('button', { name: 'Resume' }).click()
await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), combatAppearanceRun)
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'player')
check('pause freezes the completed-combat transition', () => {
  assertEqual(pausedFinishedCombat.phase, 'combat')
  assertEqual(pausedFinishedCombat.combat.phase, 'won')
  assertEqual(finishedCombatGiveUpCount, 0, 'a completed combat offered a no-op Give up action')
})

await page.evaluate((run) => {
  const next = structuredClone(run)
  next.combat.phase = 'won'
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
await page.getByRole('button', { name: 'Settings' }).click()
await page.waitForTimeout(1_100)
const settingsFrozenCombat = await readRun()
await runSettings.getByRole('button', { name: /Back/ }).click()
await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), combatAppearanceRun)
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'player')
check('Settings freezes the completed-combat transition', () => {
  assertEqual(settingsFrozenCombat.phase, 'combat')
  assertEqual(settingsFrozenCombat.combat.phase, 'won')
})

const mutedBossMusicBefore = await page.evaluate(() => window.__SFX_PLAYS__.length)
await page.evaluate((run) => {
  const next = structuredClone(run)
  Object.assign(next.combat.enemies[0], { defId: 'hexaghost', isBoss: true, dead: false })
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
await page.waitForFunction((before) => window.__SFX_PLAYS__.slice(before).includes('/assets/bgm/the-guardian-emerges.mp3'), mutedBossMusicBefore)
const mutedBossPauseBefore = await page.evaluate(() => window.__BGM_PAUSES__.length)
await page.getByRole('button', { name: 'Settings' }).click()
await runSettings.getByRole('button', { name: 'audio' }).click()
await runSettings.getByLabel('Music volume').fill('0')
await page.waitForFunction((before) => window.__BGM_PAUSES__.slice(before).includes('/assets/bgm/the-guardian-emerges.mp3'), mutedBossPauseBefore)
await runSettings.getByLabel('Music volume').fill('20')
const volumeChangePlaysBefore = await page.evaluate(() => window.__SFX_PLAYS__.filter((sound) => sound === '/assets/bgm/the-guardian-emerges.mp3').length)
await runSettings.getByLabel('Music volume').fill('40')
await runSettings.getByLabel('Music volume').fill('20')
const volumeChangePlaysAfter = await page.evaluate(() => window.__SFX_PLAYS__.filter((sound) => sound === '/assets/bgm/the-guardian-emerges.mp3').length)
await runSettings.getByRole('button', { name: /Back/ }).click()
check('Music volume stops and restores active boss music', () => assert(true))
check('changing a nonzero Music volume does not restart the boss track', () => {
  assertEqual(volumeChangePlaysAfter, volumeChangePlaysBefore)
})
await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), combatAppearanceRun)

const combatSfx = []
for (const [file, action] of [
  ['draw.ogg', 'draw'],
  ['block.ogg', 'block'],
  ['player-hit.ogg', 'hurt'],
  ['heal.ogg', 'heal'],
]) {
  const before = await page.evaluate(() => window.__SFX_PLAYS__.length)
  await page.evaluate((action) => {
    const debug = window.__STS_DEBUG__
    const next = structuredClone(debug.getRun())
    const player = next.combat.players[0]
    if (action === 'draw') {
      const card = player.draw.shift()
      if (!card) throw new Error('combat SFX fixture has no card to draw')
      player.hand.push(card)
    } else if (action === 'block') player.block += 1
    else if (action === 'hurt') player.hp -= 1
    else if (action === 'heal') player.hp += 1
    else next.combat.phase = 'won'
    debug.setRun(next)
  }, action)
  await page.waitForFunction(({ before, file }) =>
    window.__SFX_PLAYS__.slice(before).includes(`/assets/sfx/${file}`), { before, file })
  combatSfx.push(file)
}
const combinedSoundBefore = await page.evaluate(() => window.__SFX_PLAYS__.length)
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const next = structuredClone(debug.getRun())
  const player = next.combat.players[0]
  const card = player.draw.shift()
  if (!card) throw new Error('combined combat SFX fixture has no card to draw')
  player.hand.push(card)
  player.hp -= 1
  player.block += 1
  debug.setRun(next)
})
await page.waitForFunction((before) => {
  const sounds = window.__SFX_PLAYS__.slice(before)
  return ['/assets/sfx/draw.ogg', '/assets/sfx/player-hit.ogg', '/assets/sfx/block.ogg']
    .every((sound) => sounds.includes(sound))
}, combinedSoundBefore)
combatSfx.push('draw.ogg + player-hit.ogg + block.ogg')
const victorySoundBefore = await page.evaluate(() => window.__SFX_PLAYS__.length)
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const next = structuredClone(debug.getRun())
  next.combat.phase = 'won'
  debug.setRun(next)
})
await page.waitForFunction((before) =>
  window.__SFX_PLAYS__.slice(before).includes('/assets/sfx/victory.ogg'), victorySoundBefore)
combatSfx.push('victory.ogg')
await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), combatAppearanceRun)
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'player')
const defeatPlaysBefore = await page.evaluate(() => window.__SFX_PLAYS__.length)
await page.evaluate((run) => {
  const next = structuredClone(run)
  next.combat.phase = 'lost'
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
await page.waitForFunction((before) =>
  window.__SFX_PLAYS__.slice(before).includes('/assets/sfx/defeat.ogg'), defeatPlaysBefore)
combatSfx.push('defeat.ogg')
await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), combatAppearanceRun)
check('live combat changes play draw, block, health, victory, and defeat sounds', () => {
  assertDeepEqual(combatSfx, [
    'draw.ogg', 'block.ogg', 'player-hit.ogg', 'heal.ogg',
    'draw.ogg + player-hit.ogg + block.ogg',
    'victory.ogg', 'defeat.ogg',
  ])
})

const weakPlaysBefore = await page.evaluate(() => window.__SFX_PLAYS__.length)
await page.evaluate((run) => {
  const next = structuredClone(run)
  next.combat.enemies[0].weak = 1
  next.combat.players[0].weak = 0
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
await page.waitForFunction((before) => window.__SFX_PLAYS__.slice(before).includes('/assets/sfx/weak.ogg'), weakPlaysBefore)
const swappedWeakPlaysBefore = await page.evaluate(() => window.__SFX_PLAYS__.length)
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const next = structuredClone(debug.getRun())
  next.combat.enemies[0].weak = 0
  next.combat.players[0].weak = 1
  debug.setRun(next)
})
await page.waitForFunction((before) => window.__SFX_PLAYS__.slice(before).includes('/assets/sfx/weak.ogg'), swappedWeakPlaysBefore)
check('gaining Weak plays the dedicated effect sound even when another actor spends Weak', () => {
  assert(true)
})
await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), combatAppearanceRun)

await page.evaluate((run) => {
  const next = structuredClone(run)
  Object.assign(next.combat, {
    phase: 'start', startTurnProgress: undefined, pendingTriggers: [], pendingRelicScry: undefined,
  })
  Object.assign(next.combat.players[0], { relics: [], powers: [] })
  for (const enemy of next.combat.enemies) enemy.pendingDefId = undefined
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'player')
check('a start phase with no choice resolves without a confirmation click', () => assert(true))

await page.evaluate((run) => {
  const next = structuredClone(run)
  Object.assign(next.combat, {
    phase: 'start', startTurnProgress: undefined, pendingTriggers: [], pendingRelicScry: undefined, die: 3,
  })
  Object.assign(next.combat.players[0], {
    energy: 0, relics: [{ defId: 'the_abacus', spent: false },
      { defId: 'happy_flower', spent: false }], potions: [], powers: [],
  })
  next.combat.players = next.combat.players.slice(0, 1)
  for (const enemy of next.combat.enemies) enemy.pendingDefId = undefined
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
await page.getByRole('button', { name: 'Use The Abacus' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'player')
const deterministicPostRollEnergy = await page.evaluate(() => window.__STS_DEBUG__.getState().players[0].energy)
check('spending the last optional post-roll item auto-resolves one deterministic ability', () => {
  assertEqual(deterministicPostRollEnergy, 1)
})

await page.evaluate((run) => {
  const next = structuredClone(run)
  Object.assign(next.combat, {
    phase: 'start', startTurnProgress: undefined, pendingTriggers: [], pendingRelicScry: undefined, die: 6,
  })
  Object.assign(next.combat.players[0], {
    hand: [{ uid: 'targetless-reroute-strike', defId: 'strike_ironclad', upgraded: false }],
    energy: 1, relics: [{ defId: 'loaded_die', spent: false }], potions: [], powers: [],
  })
  next.combat.players = next.combat.players.slice(0, 1)
  for (const enemy of next.combat.enemies) enemy.pendingDefId = undefined
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'player')
check('a post-roll reroute Relic with no eligible target does not pause start of turn', () => assert(true))

await page.evaluate((run) => {
  const next = structuredClone(run)
  const player = next.combat.players[0]
  Object.assign(next.combat, {
    phase: 'player', startTurnProgress: undefined, pendingTriggers: [], pendingDistilled: undefined,
  })
  Object.assign(player, {
    hand: [], energy: 0, shivs: 0, miracles: 0, potions: [],
    powers: [{ uid: 'auto-end-metallicize', defId: 'metallicize', upgraded: false },
      { uid: 'auto-end-like-water', defId: 'like_water', upgraded: false }], relics: [],
    strengthLossAtEndOfTurn: 0, stance: 'neutral', orbs: player.orbs.map(() => null),
  })
  next.combat.players = next.combat.players.slice(0, 1)
  next.combat.enemies = next.combat.enemies.slice(0, 1)
  for (const enemy of next.combat.enemies) enemy.poison = 0
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
await page.waitForTimeout(650)
const orderedAutoEndPhase = await page.evaluate(() => window.__STS_DEBUG__.getState().phase)
const orderedAutoEndChoices = await page.locator('.end-turn-order').count()
check('targetless end-turn effects resolve without the obsolete order panel', () => {
  assert(orderedAutoEndPhase !== 'player', `targetless effects left combat in ${orderedAutoEndPhase}`)
  assertEqual(orderedAutoEndChoices, 0)
})
await page.evaluate((baseline) => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(baseline)
  const player = run.combat.players[0]
  Object.assign(run.combat, {
    phase: 'player', turn: run.combat.turn + 1, startTurnProgress: undefined,
    pendingTriggers: [], pendingDistilled: undefined,
  })
  Object.assign(player, {
    hand: [], energy: 0, shivs: 0, miracles: 0, potions: [], powers: [], relics: [],
    strengthLossAtEndOfTurn: 0, stance: 'neutral', orbs: player.orbs.map(() => null),
  })
  run.combat.players = run.combat.players.slice(0, 1)
  run.combat.enemies = run.combat.enemies.slice(0, 1)
  for (const enemy of run.combat.enemies) enemy.poison = 0
  debug.setRun(run)
}, combatAppearanceRun)
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].powers.length === 0)
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase !== 'player')
check('local solo automatically ends a turn with no legal action', () => assert(true))
await page.evaluate((baseline) => {
  const run = structuredClone(baseline)
  const player = run.combat.players[0]
  Object.assign(run.combat, { phase: 'player', turn: run.combat.turn + 2, startTurnProgress: undefined,
    pendingTriggers: [], pendingDistilled: undefined })
  Object.assign(player, { hand: [], energy: 10, shivs: 0, miracles: 1, potions: [], powers: [], relics: [],
    strengthLossAtEndOfTurn: 0, stance: 'neutral', orbs: player.orbs.map(() => null) })
  run.combat.players = [player]
  run.combat.enemies = run.combat.enemies.slice(0, 1)
  window.__STS_DEBUG__.setRun(run)
}, combatAppearanceRun)
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase !== 'player')
check('an unusable max-Energy Miracle does not block local solo auto-end', () => assert(true))
await page.evaluate((baseline) => {
  const run = structuredClone(baseline)
  const player = run.combat.players[0]
  Object.assign(run.combat, { phase: 'player', turn: run.combat.turn + 3, startTurnProgress: undefined,
    pendingTriggers: [], pendingDistilled: undefined })
  Object.assign(player, { hand: [], energy: 0, shivs: 0, miracles: 1, potions: [], powers: [],
    relics: [{ defId: 'ice_cream', spent: false }], strengthLossAtEndOfTurn: 0,
    stance: 'neutral', orbs: player.orbs.map(() => null) })
  run.combat.players = [player]
  run.combat.enemies = run.combat.enemies.slice(0, 1)
  window.__STS_DEBUG__.setRun(run)
}, combatAppearanceRun)
await page.waitForTimeout(650)
const iceCreamMiraclePhase = await page.evaluate(() => window.__STS_DEBUG__.getState().phase)
await page.getByRole('button', { name: 'Use Miracle (+1 Energy)' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].energy === 1)
check('Ice Cream keeps a bankable Miracle action open before local auto-end', () => {
  assertEqual(iceCreamMiraclePhase, 'player')
})
await page.evaluate((baseline) => {
  const run = structuredClone(baseline)
  const player = run.combat.players[0]
  Object.assign(run.combat, { phase: 'player', turn: run.combat.turn + 4, startTurnProgress: undefined,
    pendingTriggers: [], pendingDistilled: undefined })
  Object.assign(player, { hand: [], discard: [], energy: 0, shivs: 0, miracles: 0,
    potions: ['liquid_memories'], powers: [], relics: [], strengthLossAtEndOfTurn: 0,
    stance: 'neutral', orbs: player.orbs.map(() => null) })
  run.combat.players = [player]
  run.combat.enemies = run.combat.enemies.slice(0, 1)
  window.__STS_DEBUG__.setRun(run)
}, combatAppearanceRun)
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase !== 'player')
check('an empty-discard Liquid Memories does not block local solo auto-end', () => assert(true))
await page.evaluate((baseline) => {
  const run = structuredClone(baseline)
  const player = run.combat.players[0]
  Object.assign(run.combat, { phase: 'player', turn: run.combat.turn + 5, die: 6,
    startTurnProgress: undefined, pendingTriggers: [], pendingDistilled: undefined })
  Object.assign(player, { hand: [], discard: [], energy: 0, shivs: 0, miracles: 0, potions: [],
    powers: [], relics: [{ defId: 'loaded_die', spent: false }], strengthLossAtEndOfTurn: 0,
    stance: 'neutral', orbs: player.orbs.map(() => null) })
  run.combat.players = [player]
  run.combat.enemies = run.combat.enemies.slice(0, 1)
  window.__STS_DEBUG__.setRun(run)
}, combatAppearanceRun)
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase !== 'player')
check('a skipped post-roll Relic does not block local solo auto-end', () => assert(true))
const retargetRun = structuredClone(combatAppearanceRun)
if (retargetRun.combat.players[0].hand.filter((card) => card.defId.startsWith('strike')).length < 2) {
  const replacement = retargetRun.combat.players[0].hand.findIndex((card) => !card.defId.startsWith('strike'))
  retargetRun.combat.players[0].hand[replacement] = {
    uid: 'retarget-second-strike', defId: 'strike_ironclad', upgraded: false,
  }
}
await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), retargetRun)
await page.waitForFunction((uids) => JSON.stringify(window.__STS_DEBUG__.getState().players[0].hand.map((card) =>
  card.uid)) === JSON.stringify(uids), retargetRun.combat.players[0].hand.map((card) => card.uid))

// Play a card by clicking it and then clicking an enemy, the way a player does.
// Rows render highest-first, so the first enemy on screen is NOT enemies[0];
// the assertion compares total enemy HP instead of guessing which one was hit.
const beforePlay = await readState()
const totalEnemyHp = (state) => state.enemies.reduce((sum, enemy) => sum + enemy.hp, 0)

// Pick an attack rather than whichever card happens to be first, since a Skill
// would not damage anything and the check would be vacuous.
const attackIndex = beforePlay.players[0].hand.findIndex((card) => card.defId.startsWith('strike'))
assert(attackIndex >= 0, 'expected at least one Strike in the opening hand')
const attackCard = page.locator('.hand .card').nth(attackIndex)
await page.setViewportSize({ width: 1440, height: 900 })
const cardTransformBeforeHover = await attackCard.evaluate((card) => getComputedStyle(card).transform)
await attackCard.hover()
await attackCard.focus()
await page.waitForTimeout(200)
const compactCardChrome = await attackCard.evaluate((card) => {
  const cost = card.querySelector('.card-face__cost')
  return {
    inspectionCount: document.querySelectorAll('.card__inspection').length,
    duplicateCostCount: card.querySelectorAll('.card__cost').length,
    nativeCost: cost?.textContent ?? '',
    nativeCostVisible: cost ? getComputedStyle(cost).display !== 'none' : false,
    transform: getComputedStyle(card).transform,
  }
})
check('hovering or focusing a card lifts it like the digital hand with one native cost', () => {
  assertEqual(compactCardChrome.inspectionCount, 0, 'hover/focus inspection count')
  assertEqual(compactCardChrome.duplicateCostCount, 0, 'duplicate overlay cost count')
  assert(compactCardChrome.nativeCostVisible, 'native card-face cost is hidden')
  assertEqual(compactCardChrome.nativeCost, '1', 'native card-face cost')
  assert(compactCardChrome.transform !== cardTransformBeforeHover, 'hover/focus did not lift and enlarge the card')
})
await shot('02a-card-hover-desktop')
await page.mouse.move(0, 0)

const retargetIndices = beforePlay.players[0].hand.flatMap((card, index) =>
  card.defId.startsWith('strike') ? [index] : []).slice(0, 2)
assertEqual(retargetIndices.length, 2, 'retarget fixture needs two attacks')
const boardTopBeforeTarget = await page.locator('.board').evaluate((board) => board.getBoundingClientRect().top)
await page.locator('.hand .card').nth(retargetIndices[0]).click()
await page.locator('.hand .card').nth(retargetIndices[1]).click()
const retargeted = await readState()
const retargetUi = await page.locator('.combat').evaluate((combat) => ({
  selected: [...combat.querySelectorAll('.hand .card')].map((card) => card.classList.contains('card--selected')),
  promptPosition: getComputedStyle(combat.querySelector('.prompt')).position,
  boardTop: combat.querySelector('.board').getBoundingClientRect().top,
}))
check('choosing another attack retargets without playing the previous card or moving the board', () => {
  assertEqual(retargeted.players[0].hand.length, beforePlay.players[0].hand.length)
  assertEqual(retargeted.log.length, beforePlay.log.length)
  assertEqual(retargetUi.selected[retargetIndices[0]], false)
  assertEqual(retargetUi.selected[retargetIndices[1]], true)
  assertEqual(retargetUi.promptPosition, 'absolute')
  assertEqual(retargetUi.boardTop, boardTopBeforeTarget)
})
await page.locator('.hand .card').nth(retargetIndices[1]).click()
await attackCard.click()
await page.locator('.enemy .enemy__hit-area').first().click()
const afterPlay = await readState()

check('clicking a card then an enemy actually plays it', () => {
  assertEqual(afterPlay.players[0].hand.length, beforePlay.players[0].hand.length - 1, 'the card leaves hand')
  assertEqual(afterPlay.players[0].energy, 2, 'energy is spent')
  assertEqual(afterPlay.players[0].discard.length, 1, 'and the card is discarded')
  assert(
    totalEnemyHp(afterPlay) < totalEnemyHp(beforePlay),
    `an enemy should have taken damage: ${totalEnemyHp(beforePlay)} -> ${totalEnemyHp(afterPlay)}`,
  )
})
await shot('03-after-card-played')

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[0].energy = 0
  debug.setRun(run)
})
const disabledCard = page.locator('.hand .card[aria-disabled="true"]').first()
await disabledCard.focus()
const beforeDisabledClick = await readState()
await page.keyboard.press('Enter')
await disabledCard.evaluate((card) => card.click())
const afterDisabledClick = await readState()
check('an unplayable card cannot execute', () => {
  assertEqual(afterDisabledClick.players[0].hand.length, beforeDisabledClick.players[0].hand.length)
  assertEqual(afterDisabledClick.players[0].energy, 0)
  assertEqual(afterDisabledClick.log.length, beforeDisabledClick.log.length)
})

// Regression: choosing a targeted Distilled Chaos card used to leave the
// modal open. Native showModal() made every enemy behind it inert, so Bash was
// selected authoritatively but could never receive its target.
await page.evaluate((run) => {
  const next = structuredClone(run)
  const player = next.combat.players[0]
  Object.assign(next.combat, { phase: 'player', pendingDistilled: undefined, pendingTriggers: [],
    startTurnProgress: undefined })
  Object.assign(player, { hand: [{ uid: 'empty-distilled-strike', defId: 'strike_ironclad', upgraded: false }],
    draw: [], discard: [], potions: ['distilled_chaos'], energy: 1 })
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
const distilledUseVisual = await page.locator('.combat__actions').getByRole('button', { name: /Distilled Chaos/ }).evaluate((button) => ({
  text: button.textContent?.trim(),
  icon: button.querySelector('img')?.getAttribute('src'),
  iconWidth: button.querySelector('img')?.getBoundingClientRect().width,
}))
check('Potion use controls render only the Potion icon', () => {
  assertEqual(distilledUseVisual.text, '')
  assert(distilledUseVisual.icon?.includes('/potion-icons/distilled_chaos.png'), distilledUseVisual.icon)
  assert(distilledUseVisual.iconWidth && distilledUseVisual.iconWidth >= 22 && distilledUseVisual.iconWidth <= 23,
    distilledUseVisual.iconWidth)
})
await page.locator('.combat__actions').getByRole('button', { name: /Distilled Chaos/ }).click()
await page.waitForFunction(() => !window.__STS_DEBUG__.getState().players[0].potions.includes('distilled_chaos'))
const emptyDistilledDialog = await page.getByRole('dialog', { name: 'Distilled Chaos' }).count()
const emptyDistilledPending = await page.evaluate(() => window.__STS_DEBUG__.getState().pendingDistilled)
check('Distilled Chaos with no drawable cards resolves without an empty modal lock', () => {
  assertEqual(emptyDistilledDialog, 0)
  assertEqual(emptyDistilledPending, undefined)
})
await page.evaluate((run) => {
  const next = structuredClone(run)
  const player = next.combat.players[0]
  Object.assign(next.combat, { phase: 'player', pendingDistilled: undefined, pendingTriggers: [],
    startTurnProgress: undefined })
  Object.assign(player, {
    hand: [{ uid: 'distilled-miracle-strike', defId: 'strike_ironclad', upgraded: false }],
    draw: [{ uid: 'distilled-after-miracle-defend', defId: 'defend_ironclad', upgraded: false }],
    discard: [], potions: ['distilled_chaos'], energy: 6, miracles: 1, block: 0,
  })
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
await page.getByRole('button', { name: 'Use Miracle on next card' }).click()
await page.locator('.combat__actions').getByRole('button', { name: /Distilled Chaos/ }).click()
await page.getByRole('dialog', { name: 'Distilled Chaos' }).getByRole('button', { name: /Defend/ }).click()
await page.waitForFunction(() => !window.__STS_DEBUG__.getState().pendingDistilled &&
  !window.__STS_DEBUG__.getState().startTurnProgress?.forcedCard)
const distilledAfterMiracle = await readState()
check('Distilled Chaos clears an armed Miracle before its forced card', () => {
  assertEqual(distilledAfterMiracle.players[0].miracles, 1)
  assert(distilledAfterMiracle.players[0].block > 0, 'the forced Defend never resolved')
})
await page.evaluate((run) => {
  const next = structuredClone(run)
  const player = next.combat.players[0]
  Object.assign(next.combat, { phase: 'player', pendingDistilled: undefined, pendingTriggers: [],
    startTurnProgress: undefined })
  Object.assign(player, {
    hand: [{ uid: 'pre-distilled-strike', defId: 'strike_ironclad', upgraded: false }],
    draw: [{ uid: 'distilled-after-staging-bash', defId: 'bash', upgraded: false }],
    discard: [], potions: ['distilled_chaos'], energy: 3,
  })
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
await page.getByRole('button', { name: /^Strike,/ }).click()
await page.locator('.prompt').filter({ hasText: 'Choose an enemy' }).waitFor()
await page.locator('.combat__actions').getByRole('button', { name: /Distilled Chaos/ }).click()
const stagedDistilledDialog = page.getByRole('dialog', { name: 'Distilled Chaos' })
await stagedDistilledDialog.getByRole('button', { name: /Bash/ }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().startTurnProgress?.forcedCard?.cardUid ===
  'distilled-after-staging-bash')
await page.locator('.hand .card--selected').waitFor()
const stagedAfterPotion = await page.locator('.hand .card--selected').textContent()
check('Distilled Chaos replaces stale card targeting with its forced card', () => {
  assert(stagedAfterPotion.includes('Bash'), `wrong forced card remained staged: ${stagedAfterPotion}`)
})
await page.locator('.enemy .enemy__hit-area').first().click()
const committedCardFlight = page.locator('.card-flight').filter({ hasText: 'Bash' }).last()
await committedCardFlight.waitFor()
const cardPlayMotion = await committedCardFlight.evaluate((flight) => ({
  animation: flight.getAnimations().find(animation => animation.id === 'card-resolve')?.id,
  destination: [...flight.classList].find((name) => name.startsWith('card-flight--')),
}))
await page.evaluate(() => {
  for (const animation of document.getAnimations()) {
    if (animation.id === 'card-resolve') {
      animation.currentTime = 500
      animation.pause()
    }
  }
})
await page.screenshot({ path: join(animationReferenceDir, 'combat-card-play.png'), timeout: 15_000 })
const cardPlayLanding = await page.evaluate(() => {
  const flight = [...document.querySelectorAll('.card-flight')].at(-1)
  const animation = flight?.getAnimations().find((candidate) => candidate.id === 'card-resolve')
  if (!animation) return null
  animation.currentTime = 979
  const flightRect = flight?.getBoundingClientRect()
  const pile = document.querySelector('[data-pile="discard"]')?.getBoundingClientRect()
  if (!flightRect || !pile) return null
  return {
    distance: Math.hypot(
      flightRect.left + flightRect.width / 2 - (pile.left + pile.width / 2),
      flightRect.top + flightRect.height / 2 - (pile.top + pile.height / 2),
    ),
    flightX: flightRect.left + flightRect.width / 2,
    pileX: pile.left + pile.width / 2,
    viewportWidth: innerWidth,
  }
})
await page.evaluate(() => {
  for (const animation of document.getAnimations()) {
    if (animation.id === 'card-resolve' && animation.playState === 'paused') animation.play()
  }
})
await page.waitForFunction(() => window.__STS_DEBUG__.getState().startTurnProgress?.forcedCard === undefined)
check('a committed card holds above combat before resolving to its pile', () => {
  assertEqual(cardPlayMotion.animation, 'card-resolve')
  assertEqual(cardPlayMotion.destination, 'card-flight--discard')
  assert(cardPlayLanding !== null, 'the flight and destination pile were measurable')
  assert(cardPlayLanding.flightX > cardPlayLanding.viewportWidth / 2,
    'the discard flight went toward the right-side pile')
  assert(cardPlayLanding.distance < 140, `the discard flight missed its pile by ${cardPlayLanding.distance}px`)
})

await page.evaluate((run) => {
  const next = structuredClone(run)
  const player = next.combat.players[0]
  Object.assign(next.combat, { phase: 'player', pendingDistilled: undefined, pendingCardCopy: undefined,
    pendingTriggers: [], startTurnProgress: undefined })
  Object.assign(player, {
    hand: [{ uid: 'drag-cleave', defId: 'cleave', upgraded: false }],
    draw: [], discard: [], exhaust: [], energy: 1, block: 0,
  })
  next.combat.enemies = next.combat.enemies.slice(0, 2)
  for (const enemy of next.combat.enemies) Object.assign(enemy, {
    hp: 5, maxHp: 5, block: 0, dead: false, row: player.row, isBoss: false,
  })
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
const draggedRowCard = page.getByRole('button', { name: /^Cleave, cost 1,/ })
const draggedEnemy = page.locator('.enemy .enemy__hit-area').first()
await prepareDragSource(draggedRowCard)
let draggedCardBox = await draggedRowCard.boundingBox()
let draggedEnemyBox = await draggedEnemy.boundingBox()
assert(draggedCardBox && draggedEnemyBox, 'drag fixtures are visible')
assertEqual(await draggedRowCard.getAttribute('aria-disabled'), 'false', 'dragged Cleave is playable')
await page.mouse.move(draggedCardBox.x + draggedCardBox.width / 2,
  draggedCardBox.y + draggedCardBox.height / 2)
await page.mouse.down()
await page.mouse.move(5, 5, { steps: 8 })
await page.mouse.up()
await page.waitForFunction(() => !document.querySelector('.card-drag'))
const cancelledDrag = await readState()
assertEqual(cancelledDrag.players[0].hand[0]?.uid, 'drag-cleave', 'a targeted drag released off-target cancels')
assertEqual(cancelledDrag.players[0].energy, 1, 'a cancelled targeted drag spends no energy')
await page.mouse.move(draggedCardBox.x + draggedCardBox.width / 2,
  draggedCardBox.y + draggedCardBox.height / 2)
await page.mouse.down()
await page.mouse.move(draggedEnemyBox.x + draggedEnemyBox.width / 2,
  draggedEnemyBox.y + draggedEnemyBox.height / 2, { steps: 8 })
await page.waitForFunction(() => document.querySelector('.card-drag'))
await page.evaluate(() => {
  const next = structuredClone(window.__STS_DEBUG__.getRun())
  next.combat.players[0].hand = []
  window.__STS_DEBUG__.setRun(next)
})
await page.waitForFunction(() => !document.querySelector('.card-drag') && !document.querySelector('.card-target-arrow'))
await page.mouse.up()
await page.evaluate((run) => {
  const next = structuredClone(run)
  const player = next.combat.players[0]
  Object.assign(next.combat, { phase: 'player', pendingDistilled: undefined, pendingCardCopy: undefined,
    pendingTriggers: [], startTurnProgress: undefined })
  Object.assign(player, {
    hand: [{ uid: 'drag-cleave', defId: 'cleave', upgraded: false }],
    draw: [], discard: [], exhaust: [], energy: 1, block: 0,
  })
  next.combat.enemies = next.combat.enemies.slice(0, 2)
  for (const enemy of next.combat.enemies) Object.assign(enemy, {
    hp: 5, maxHp: 5, block: 0, dead: false, row: player.row, isBoss: false,
  })
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
await prepareDragSource(draggedRowCard)
draggedCardBox = await draggedRowCard.boundingBox()
draggedEnemyBox = await draggedEnemy.boundingBox()
assert(draggedCardBox && draggedEnemyBox, 'restored drag fixtures are visible')
await page.mouse.move(draggedCardBox.x + draggedCardBox.width / 2,
  draggedCardBox.y + draggedCardBox.height / 2)
await page.mouse.down()
await page.mouse.move(draggedEnemyBox.x + draggedEnemyBox.width / 2,
  draggedEnemyBox.y + draggedEnemyBox.height / 2, { steps: 12 })
await page.waitForFunction(() => document.querySelector('.card-drag') &&
  document.querySelector('.card-target-arrow') && document.querySelector('.enemy--targeted'))
assertEqual(await page.locator('.enemy--targeted').count(), 2, 'a row drag highlights every affected enemy')
const cardDragVisual = await page.evaluate(() => ({
  cursor: getComputedStyle(document.querySelector('.combat')).cursor,
  targetCursor: getComputedStyle(document.querySelector('.enemy--targeted')).cursor,
  arrow: getComputedStyle(document.querySelector('.card-target-arrow__line')).strokeDasharray,
  touchAction: getComputedStyle(document.querySelector('.hand .card')).touchAction,
}))
await shot('03a-card-drag-target')
await page.mouse.up()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].discard
  .some((card) => card.uid === 'drag-cleave'))
const draggedAttack = await readState()
check('a row attack drags to an enemy row with the game cursor and targeting arc', () => {
  assert(cardDragVisual.cursor.includes('/assets/ui/cursor-click.png'), cardDragVisual.cursor)
  assert(cardDragVisual.targetCursor.includes('/assets/ui/cursor-click.png'), cardDragVisual.targetCursor)
  assert(cardDragVisual.arrow !== 'none', cardDragVisual.arrow)
  assertEqual(cardDragVisual.touchAction, 'none')
  assertEqual(draggedAttack.players[0].energy, 0)
  assertDeepEqual(draggedAttack.enemies.map((enemy) => enemy.hp), [3, 3])
})

await page.evaluate((run) => {
  const next = structuredClone(run)
  const player = next.combat.players[0]
  Object.assign(next.combat, { phase: 'player', pendingDistilled: undefined, pendingCardCopy: undefined,
    pendingTriggers: [], startTurnProgress: undefined })
  Object.assign(player, {
    hand: [{ uid: 'drag-cleave-boss', defId: 'cleave', upgraded: false }],
    draw: [], discard: [], exhaust: [], energy: 1,
  })
  next.combat.enemies = next.combat.enemies.slice(0, 3)
  for (const [index, enemy] of next.combat.enemies.entries()) Object.assign(enemy, {
    hp: 5, maxHp: 5, block: 0, dead: false,
    row: index === 2 ? player.row + 1 : player.row, isBoss: index === 2,
  })
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
const bossRowCard = page.getByRole('button', { name: /^Cleave, cost 1,/ })
const bossTarget = page.locator('.enemy:not(.enemy--boss)').first().locator('.enemy__hit-area')
await prepareDragSource(bossRowCard)
const bossRowCardBox = await bossRowCard.boundingBox()
const bossTargetBox = await bossTarget.boundingBox()
assert(bossRowCardBox && bossTargetBox, 'boss row-target fixtures are visible')
await page.mouse.move(bossRowCardBox.x + bossRowCardBox.width / 2,
  bossRowCardBox.y + bossRowCardBox.height / 2)
await page.mouse.down()
await page.mouse.move(bossTargetBox.x + bossTargetBox.width / 2,
  bossTargetBox.y + bossTargetBox.height / 2, { steps: 10 })
await page.waitForFunction(() => document.querySelectorAll('.enemy--targeted').length === 3)
await page.mouse.up()

await page.evaluate((run) => {
  const next = structuredClone(run)
  const player = next.combat.players[0]
  Object.assign(next.combat, { phase: 'player', pendingDistilled: undefined, pendingCardCopy: undefined,
    pendingTriggers: [], startTurnProgress: undefined })
  Object.assign(player, {
    hand: [{ uid: 'drag-strike', defId: 'strike_ironclad', upgraded: false }],
    draw: [], discard: [], exhaust: [], energy: 1,
  })
  next.combat.enemies = next.combat.enemies.slice(0, 2)
  for (const enemy of next.combat.enemies) Object.assign(enemy, {
    hp: 5, maxHp: 5, block: 0, dead: false, row: player.row, isBoss: false,
  })
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
const draggedStrike = page.getByRole('button', { name: /^Strike, cost 1,/ })
await prepareDragSource(draggedStrike)
const draggedStrikeBox = await draggedStrike.boundingBox()
const draggedSeatBox = await page.locator('.seat').first().boundingBox()
assert(draggedStrikeBox && draggedSeatBox, 'single-target row-background fixtures are visible')
await page.mouse.move(draggedStrikeBox.x + draggedStrikeBox.width / 2,
  draggedStrikeBox.y + draggedStrikeBox.height / 2)
await page.mouse.down()
await page.mouse.move(draggedSeatBox.x + draggedSeatBox.width / 2,
  draggedSeatBox.y + draggedSeatBox.height / 2, { steps: 10 })
await page.mouse.up()
await page.waitForFunction(() => !document.querySelector('.card-drag'))
const cancelledSingleTarget = await readState()
assertEqual(cancelledSingleTarget.players[0].hand[0]?.uid, 'drag-strike',
  'a single-target attack released on row background cancels')

await page.evaluate((run) => {
  const next = structuredClone(run)
  const player = next.combat.players[0]
  Object.assign(next.combat, { phase: 'player', pendingDistilled: undefined, pendingCardCopy: undefined,
    pendingTriggers: [], startTurnProgress: undefined })
  Object.assign(player, {
    character: 'watcher',
    hand: [{ uid: 'drag-ragnarok', defId: 'ragnarok', upgraded: false }],
    draw: [], discard: [], exhaust: [], slimes: [], energy: 3,
  })
  next.combat.enemies = next.combat.enemies.slice(0, 2)
  for (const enemy of next.combat.enemies) Object.assign(enemy, {
    hp: 9, maxHp: 9, block: 0, dead: false, row: player.row, isBoss: false,
  })
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
const draggedRagnarok = page.getByRole('button', { name: /^Ragnarok, cost 3,/ })
const ragnarokEnemy = page.locator('.enemy').first().locator('.enemy__hit-area')
await prepareDragSource(draggedRagnarok)
const ragnarokBox = await draggedRagnarok.boundingBox()
const ragnarokEnemyBox = await ragnarokEnemy.boundingBox()
assert(ragnarokBox && ragnarokEnemyBox, 'multi-target drag fixtures are visible')
await page.mouse.move(ragnarokBox.x + ragnarokBox.width / 2, ragnarokBox.y + ragnarokBox.height / 2)
await page.mouse.down()
await page.mouse.move(ragnarokEnemyBox.x + ragnarokEnemyBox.width / 2,
  ragnarokEnemyBox.y + ragnarokEnemyBox.height / 2, { steps: 10 })
await page.waitForFunction(() => document.querySelector('.enemy--targeted'))
await page.mouse.up()
await new Promise((resolve) => setTimeout(resolve, 100))
const ragnarokPrompts = await page.locator('.prompt').allTextContents()
assert(ragnarokPrompts.some((text) => text.includes('target 2/5')), JSON.stringify(ragnarokPrompts))
assertEqual((await readState()).players[0].energy, 3, 'Ragnarok keeps waiting after its first dragged target')
const stagedRagnarokTarget = page.locator('.enemy--targeted').first()
await stagedRagnarokTarget.hover()
const stagedTargetCursor = await stagedRagnarokTarget.evaluate((enemy) => getComputedStyle(enemy).cursor)
assert(stagedTargetCursor.includes('/assets/ui/cursor.png'), stagedTargetCursor)

await page.evaluate((run) => {
  const next = structuredClone(run)
  const player = next.combat.players[0]
  Object.assign(next.combat, { phase: 'player', pendingDistilled: undefined, pendingCardCopy: undefined,
    pendingTriggers: [], startTurnProgress: undefined })
  Object.assign(player, {
    character: 'silent',
    hand: [{ uid: 'drag-bouncing-flask', defId: 'bouncing_flask', upgraded: false }],
    draw: [], discard: [], exhaust: [], energy: 2,
  })
  next.combat.enemies = next.combat.enemies.slice(0, 2)
  for (const enemy of next.combat.enemies) Object.assign(enemy, {
    hp: 5, maxHp: 5, block: 0, poison: 0, dead: false, row: player.row, isBoss: false,
  })
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
const draggedFlask = page.getByRole('button', { name: /^Bouncing Flask, cost 2,/ })
const flaskTargets = page.locator('.enemy .enemy__hit-area')
const flaskPrompt = page.locator('.prompt').filter({ hasText: 'token target 2/2' })
await prepareDragSource(draggedFlask)
const draggedFlaskBox = await draggedFlask.boundingBox()
const firstFlaskTargetBox = await flaskTargets.first().boundingBox()
assert(draggedFlaskBox && firstFlaskTargetBox, 'Bouncing Flask drag fixtures are visible')
await page.mouse.move(draggedFlaskBox.x + draggedFlaskBox.width / 2,
  draggedFlaskBox.y + draggedFlaskBox.height / 2)
await page.mouse.down()
await page.mouse.move(firstFlaskTargetBox.x + firstFlaskTargetBox.width / 2,
  firstFlaskTargetBox.y + firstFlaskTargetBox.height / 2, { steps: 10 })
await page.mouse.up()
await flaskPrompt.waitFor()
await flaskTargets.nth(1).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].discard
  .some((card) => card.uid === 'drag-bouncing-flask'))
const draggedFlaskState = await readState()
check('a repeated-target card starts with a drag and finishes its remaining targets', () => {
  assertDeepEqual(draggedFlaskState.enemies.map((enemy) => enemy.poison), [1, 1])
  assertEqual(draggedFlaskState.players[0].energy, 0)
})

await page.evaluate((run) => {
  const next = structuredClone(run)
  const player = next.combat.players[0]
  Object.assign(next.combat, { phase: 'player', pendingDistilled: undefined, pendingCardCopy: undefined,
    pendingTriggers: [], startTurnProgress: undefined })
  Object.assign(player, {
    hand: [{ uid: 'drag-defend', defId: 'defend_ironclad', upgraded: false }],
    draw: [], discard: [], exhaust: [], energy: 1, block: 0,
  })
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
const draggedDefend = page.getByRole('button', { name: /^Defend, cost 1,/ })
await prepareDragSource(draggedDefend)
const draggedDefendBox = await draggedDefend.boundingBox()
assert(draggedDefendBox, 'dragged Defend is visible')
assertEqual(await draggedDefend.getAttribute('aria-disabled'), 'false', 'dragged Defend is playable')
await page.mouse.move(draggedDefendBox.x + draggedDefendBox.width / 2,
  draggedDefendBox.y + draggedDefendBox.height / 2)
await page.mouse.down()
await page.mouse.move(draggedDefendBox.x + draggedDefendBox.width / 2,
  draggedDefendBox.y - 24, { steps: 5 })
await page.waitForFunction(() => document.querySelector('.card-drag') && !document.querySelector('.card-target-arrow'))
await page.mouse.up()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].discard
  .some((card) => card.uid === 'drag-defend'))
const draggedDefense = await readState()
check('an untargeted defensive card plays by dragging above the hand', () => {
  assertEqual(draggedDefense.players[0].block, 1)
  assertEqual(draggedDefense.players[0].energy, 0)
})

await page.evaluate((run) => {
  const next = structuredClone(run)
  const player = next.combat.players[0]
  const ally = structuredClone(player)
  Object.assign(next.combat, { phase: 'player', pendingDistilled: undefined, pendingCardCopy: undefined,
    pendingTriggers: [], startTurnProgress: undefined })
  Object.assign(player, {
    character: 'silent',
    hand: [{ uid: 'drag-dodge-roll', defId: 'dodge_and_roll', upgraded: false }],
    draw: [], discard: [], exhaust: [], energy: 1, block: 0,
  })
  Object.assign(ally, {
    id: 'drag-ally', name: 'Defect', character: 'defect', row: player.row + 1,
    hand: [], draw: [], discard: [], exhaust: [], energy: 0, block: 0, dead: false,
  })
  next.combat.players = [player, ally]
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
const draggedDodge = page.getByRole('button', { name: /^Dodge and Roll, cost 1,/ })
const draggedAlly = page.locator('.seat[data-player-id="drag-ally"]')
await prepareDragSource(draggedDodge)
const draggedDodgeBox = await draggedDodge.boundingBox()
const draggedAllyBox = await draggedAlly.boundingBox()
assert(draggedDodgeBox && draggedAllyBox, 'defensive target drag fixtures are visible')
await page.mouse.move(draggedDodgeBox.x + draggedDodgeBox.width / 2,
  draggedDodgeBox.y + draggedDodgeBox.height / 2)
await page.mouse.down()
await page.mouse.move(draggedAllyBox.x + draggedAllyBox.width / 2,
  draggedAllyBox.y + draggedAllyBox.height / 2, { steps: 10 })
await page.waitForFunction(() => document.querySelector('.seat--targeted') && document.querySelector('.card-target-arrow'))
await page.mouse.up()
await page.locator('.prompt').filter({ hasText: 'Block recipient 2/2' }).waitFor()
await page.locator('.seat[data-player-id="p1"]').click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].discard
  .some((card) => card.uid === 'drag-dodge-roll'))
const draggedDefenseTargets = await readState()
check('a defensive multi-target card drags to players with the targeting arc', () => {
  assertDeepEqual(draggedDefenseTargets.players.map((player) => player.block), [1, 1])
  assertEqual(draggedDefenseTargets.players[0].energy, 0)
})

await page.evaluate((run) => {
  const next = structuredClone(run)
  const player = next.combat.players[0]
  Object.assign(next.combat, { phase: 'player', pendingDistilled: undefined, pendingCardCopy: undefined,
    pendingTriggers: [], startTurnProgress: undefined })
  Object.assign(player, {
    hand: [
      { uid: 'choice-survivor', defId: 'survivor', upgraded: false },
      { uid: 'choice-strike', defId: 'strike_ironclad', upgraded: false },
    ],
    draw: [], discard: [], exhaust: [], energy: 2, block: 0,
  })
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
await page.getByRole('button', { name: /^Survivor, cost 1,/ }).click()
const discardChoice = page.getByRole('button', { name: /^Strike, cost 1,/ })
await prepareDragSource(discardChoice)
const discardChoiceBox = await discardChoice.boundingBox()
assert(discardChoiceBox, 'discard-choice card is visible')
await page.mouse.move(discardChoiceBox.x + discardChoiceBox.width / 2,
  discardChoiceBox.y + discardChoiceBox.height / 2)
await page.mouse.down()
await page.mouse.move(discardChoiceBox.x + discardChoiceBox.width / 2,
  discardChoiceBox.y - 130, { steps: 8 })
await new Promise((resolve) => setTimeout(resolve, 100))
assertEqual(await page.locator('.card-drag').count(), 0, 'a hand-choice card does not start play-dragging')
await page.mouse.up()
await discardChoice.click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].discard
  .some((card) => card.uid === 'choice-strike'))
const resolvedHandChoice = await readState()
assertEqual(resolvedHandChoice.players[0].energy, 1, 'the hand-choice card remains clickable')

await page.evaluate((run) => {
  const next = structuredClone(run)
  const player = next.combat.players[0]
  Object.assign(next.combat, { phase: 'player', pendingDistilled: undefined, pendingCardCopy: undefined,
    pendingTriggers: [], startTurnProgress: undefined })
  Object.assign(player, {
    character: 'watcher',
    hand: [{ uid: 'drag-flex', defId: 'flex', upgraded: false }],
    draw: [], discard: [], exhaust: [], energy: 1,
  })
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
const draggedFlex = page.getByRole('button', { name: /^Flex, cost 0,/ })
await prepareDragSource(draggedFlex)
const draggedFlexBox = await draggedFlex.boundingBox()
assert(draggedFlexBox, 'dragged Flex is visible')
assertEqual(await draggedFlex.getAttribute('aria-disabled'), 'false', 'dragged Flex is playable')
await page.mouse.move(draggedFlexBox.x + draggedFlexBox.width / 2,
  draggedFlexBox.y + draggedFlexBox.height / 2)
await page.mouse.down()
await page.mouse.move(draggedFlexBox.x + draggedFlexBox.width / 2,
  draggedFlexBox.y - 130, { steps: 10 })
await page.mouse.up()
await page.waitForFunction(() => document.querySelector('.card-flight--exhaust'))
const exhaustFlight = await page.locator('.card-flight--exhaust').evaluate((flight) => ({
  childAnimation: getComputedStyle(flight.querySelector('.card')).animationName,
  trailAnimation: getComputedStyle(flight.parentElement.querySelector('.card-flight-trail__reveal')).animationName,
  traceColor: getComputedStyle(flight).getPropertyValue('--flight-trace').trim(),
  countInFlight: document.querySelector('[data-pile="exhaust"] .pile__count')?.textContent,
}))
await page.evaluate(() => {
  for (const animation of document.getAnimations()) {
    if (animation.id === 'card-resolve' || ['card-flight-smoke', 'card-flight-motes'].includes(animation.animationName)) {
      animation.currentTime = 500
      animation.pause()
    }
  }
})
await shot('03b-card-center-hold')
await page.evaluate(() => {
  for (const animation of document.getAnimations()) {
    if (animation.id === 'card-resolve' || ['card-flight-smoke', 'card-flight-motes'].includes(animation.animationName)) {
      animation.currentTime = 850
    }
  }
})
await shot('03c-card-smoke-flight')
await page.evaluate(() => {
  for (const animation of document.getAnimations()) if (animation.playState === 'paused') animation.play()
})
await page.waitForFunction(() => !document.querySelector('.card-flight--exhaust'))
const exhaustLanding = await page.locator('[data-pile="exhaust"]').evaluate((pile) => ({
  count: pile.querySelector('.pile__count')?.textContent,
  animation: getComputedStyle(pile).animationName,
}))
const draggedSpecial = await readState()
const tracePalette = await page.evaluate(() => {
  const probe = document.createElement('div')
  probe.className = 'card-flight'
  document.body.append(probe)
  const colors = Object.fromEntries(['ironclad', 'silent', 'defect', 'watcher'].map((character) => {
    probe.className = `card-flight card-flight--${character}`
    return [character, getComputedStyle(probe).getPropertyValue('--flight-trace').trim()]
  }))
  probe.remove()
  return colors
})
check('an Exhausting special-effect card settles, shrinks, smokes, and lands in Exhaust', () => {
  assertDeepEqual(draggedSpecial.players[0].exhaust.map((card) => card.uid), ['drag-flex'])
  assertEqual(exhaustFlight.childAnimation, 'none')
  assertEqual(exhaustFlight.trailAnimation, 'card-flight-smoke')
  assertEqual(exhaustFlight.traceColor, '#a35ce5')
  assertEqual(exhaustFlight.countInFlight, '0')
  assertEqual(exhaustLanding.count, '1')
  assert(exhaustLanding.animation.startsWith('ui-pulse'), exhaustLanding.animation)
  assertDeepEqual(tracePalette, {
    ironclad: '#e74b38', silent: '#54ca68', defect: '#42aef5', watcher: '#a35ce5',
  })
})

await page.evaluate((run) => {
  const next = structuredClone(run)
  const player = next.combat.players[0]
  Object.assign(next.combat, { phase: 'player', pendingDistilled: undefined, pendingCardCopy: undefined,
    pendingTriggers: [], startTurnProgress: undefined })
  Object.assign(player, {
    character: 'defect',
    hand: [
      { uid: 'rapid-flex-1', defId: 'flex', upgraded: false },
      { uid: 'rapid-flex-2', defId: 'flex', upgraded: false },
    ],
    draw: [], discard: [], exhaust: [], energy: 0,
  })
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
const rapidFlexes = page.locator('.hand').getByRole('button', { name: /^Flex, cost 0,/ })
await rapidFlexes.first().click()
await page.waitForFunction(() => document.querySelectorAll('.card-flight--exhaust').length === 1)
await new Promise((resolve) => setTimeout(resolve, 150))
await rapidFlexes.first().click()
await page.waitForFunction(() => document.querySelectorAll('.card-flight--exhaust').length === 2)
assertEqual(await page.locator('[data-pile="exhaust"] .pile__count').textContent(), '0',
  'overlapping flights hold both landing counts')
await page.waitForFunction(() => document.querySelectorAll('.card-flight--exhaust').length === 1 &&
  document.querySelector('[data-pile="exhaust"] .pile__count')?.textContent === '1')
await page.waitForFunction(() => document.querySelectorAll('.card-flight--exhaust').length === 0 &&
  document.querySelector('[data-pile="exhaust"] .pile__count')?.textContent === '2')

await page.emulateMedia({ reducedMotion: 'reduce' })
await page.waitForFunction(() => matchMedia('(prefers-reduced-motion: reduce)').matches &&
  !document.querySelector('.combat')?.hasAttribute('data-stage-motion'))
await page.evaluate((run) => {
  const next = structuredClone(run)
  const player = next.combat.players[0]
  Object.assign(next.combat, { phase: 'player', pendingDistilled: undefined, pendingCardCopy: undefined,
    pendingTriggers: [], startTurnProgress: undefined })
  Object.assign(player, {
    hand: [{ uid: 'reduced-flex', defId: 'flex', upgraded: false }],
    draw: [], discard: [], exhaust: [], energy: 0,
  })
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
await page.locator('.hand').getByRole('button', { name: /^Flex, cost 0,/ }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].exhaust
  .some((card) => card.uid === 'reduced-flex'))
assertEqual(await page.locator('.card-flight').count(), 0, 'reduced motion creates no hidden delayed flight')
assert((await page.locator('.token--orb:not(.token--orb-empty)').evaluateAll((orbs) =>
  orbs.every((orb) => getComputedStyle(orb, '::before').animationName === 'none'))),
'reduced motion leaves Orb idle animation running')
assertEqual(await page.locator('[data-pile="exhaust"] .pile__count').textContent(), '1',
  'reduced motion updates the pile count immediately')
await page.emulateMedia({ reducedMotion: 'no-preference' })
await page.waitForFunction(() => !matchMedia('(prefers-reduced-motion: reduce)').matches &&
  document.querySelector('.combat')?.hasAttribute('data-stage-motion'))
await page.evaluate((run) => {
  const next = structuredClone(run)
  const player = next.combat.players[0]
  const bash = { uid: 'distilled-bash-ui', defId: 'bash', upgraded: false }
  const strike = { uid: 'distilled-strike-ui', defId: 'strike_ironclad', upgraded: false }
  Object.assign(next.combat, {
    phase: 'player', pendingDistilled: { playerId: player.id, cards: [bash, strike] },
    pendingCardCopy: undefined, pendingTriggers: [], startTurnProgress: undefined,
  })
  Object.assign(player, { hand: [bash, strike], energy: 0, potions: [] })
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
const distilledDialog = page.getByRole('dialog', { name: 'Distilled Chaos' })
await distilledDialog.getByRole('button', { name: /Bash/ }).click()
await page.waitForFunction(() => !document.querySelector('.distilled-choice[open]') &&
  window.__STS_DEBUG__.getState().startTurnProgress?.forcedCard?.cardUid === 'distilled-bash-ui')
await page.locator('.hand .card--selected').waitFor()
const bashStaged = await page.locator('.hand .card--selected').textContent()
const beforeDistilledBash = await readState()
await page.locator('.enemy .enemy__hit-area').first().click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().pendingDistilled?.cards.length === 1 &&
  document.querySelector('.distilled-choice[open]'))
const afterDistilledBash = await readState()
check('Distilled Chaos closes for a targeted card, stages it, then resumes its queue', () => {
  assert(bashStaged?.includes('Bash'), `expected Bash to stage automatically, got ${bashStaged}`)
  assert(afterDistilledBash.enemies.some((enemy, index) => enemy.vulnerable > beforeDistilledBash.enemies[index].vulnerable),
    'Bash never reached its enemy target')
  assertDeepEqual(afterDistilledBash.pendingDistilled.cards.map((card) => card.uid), ['distilled-strike-ui'])
})
await distilledDialog.getByRole('button', { name: /Strike/ }).click()
await page.waitForFunction(() => !document.querySelector('.distilled-choice[open]'))
await page.locator('.enemy .enemy__hit-area').first().click()
await page.waitForFunction(() => !window.__STS_DEBUG__.getState().pendingDistilled)
const afterDistilledStrike = await readState()
check('Distilled Chaos can finish the remaining targeted card without locking', () => {
  assertEqual(afterDistilledStrike.pendingDistilled, undefined)
  assertEqual(afterDistilledStrike.startTurnProgress?.forcedCard, undefined)
})
await page.evaluate((run) => {
  const next = structuredClone(run)
  const player = next.combat.players[0]
  const remaining = { uid: 'distilled-after-copy', defId: 'strike_ironclad', upgraded: false }
  Object.assign(next.combat, {
    phase: 'copy', pendingDistilled: { playerId: player.id, cards: [remaining] }, pendingTriggers: [],
    startTurnProgress: undefined,
    pendingCardCopy: {
      playerId: player.id, card: { uid: 'distilled-double-tap-bash', defId: 'bash', upgraded: false },
      energySpent: 0, resumePhase: 'player', forcedExhaust: false, forcedChoices: null,
      deferredHavocs: [], sourceNames: ['Double Tap'], virtualOnly: true,
    },
  })
  Object.assign(player, { hand: [remaining], energy: 0, potions: [] })
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
await page.locator('.prompt').filter({ hasText: 'Choose an enemy for Bash copy (Double Tap)' }).waitFor()
const distilledDuringCopy = await page.getByRole('dialog', { name: 'Distilled Chaos' }).isVisible()
const copyTargetsOutsideDistilled = await page.locator('.enemy:not([disabled])').count()
check('Distilled Chaos stays hidden while a queued Double Tap copy needs its target', () => {
  assertEqual(distilledDuringCopy, false)
  assert(copyTargetsOutsideDistilled > 0, 'the copy target controls stayed inert')
})
await page.evaluate((run) => {
  const next = structuredClone(run)
  const player = next.combat.players[0]
  const remaining = { uid: 'distilled-after-trigger', defId: 'strike_ironclad', upgraded: false }
  const enemy = next.combat.enemies[0]
  Object.assign(next.combat, {
    phase: 'player', pendingDistilled: { playerId: player.id, cards: [remaining] },
    pendingCardCopy: undefined, startTurnProgress: undefined, nextTriggerId: 1,
    pendingTriggers: [{ id: 0, playerId: player.id, sourceId: 'power:distilled-fire-breathing' }],
    enemies: [
      { ...enemy, uid: 'distilled-trigger-row-1', row: 0, hp: 10, maxHp: 10, dead: false },
      { ...enemy, uid: 'distilled-trigger-row-2', row: 1, hp: 10, maxHp: 10, dead: false },
    ],
  })
  Object.assign(player, {
    hand: [remaining], energy: 0, potions: [],
    powers: [{ uid: 'distilled-fire-breathing', defId: 'fire_breathing', upgraded: false }],
  })
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
await page.locator('.prompt').filter({ hasText: /Fire Breathing — choose an enemy/ }).waitFor()
const distilledDuringTrigger = await page.getByRole('dialog', { name: 'Distilled Chaos' }).isVisible()
// `.enemy--targeted` (not just "not disabled") specifically confirms the
// trigger's own row-matching recognizes both enemies as legal anchors — a
// weaker "not disabled" check would pass even if that matching were broken.
const triggerRowsOutsideDistilled = await page.locator('.enemy--targeted').count()
check('Distilled Chaos stays hidden while a mandatory trigger needs its row', () => {
  assertEqual(distilledDuringTrigger, false)
  assertEqual(triggerRowsOutsideDistilled, 2)
})
await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), combatAppearanceRun)
await page.waitForFunction((expectFallback) => {
  const images = [...document.querySelectorAll('.card > .card-face > img.card-face__illustration')]
  return !expectFallback || (images.length > 0 &&
    images.every((image) => image.complete && image.naturalWidth > 0))
}, !artSynced)

await page.evaluate((run) => {
  const next = structuredClone(run)
  next.combat.players[0].hand = [
    { uid: 'keyword-help-shockwave', defId: 'shockwave', upgraded: false },
    { uid: 'keyword-help-cleave', defId: 'cleave', upgraded: false },
    { uid: 'keyword-help-choke', defId: 'choke', upgraded: false },
    { uid: 'keyword-help-loop', defId: 'loop', upgraded: false },
  ]
  next.combat.players[0].discard = [
    { uid: 'keyword-help-dialog-shockwave', defId: 'shockwave', upgraded: false },
  ]
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
const keywordCard = page.getByRole('button', { name: /^Shockwave,/ })
await page.waitForFunction((card) => !card.classList.contains('card--drawn'), await keywordCard.elementHandle())
await page.mouse.move(5, 5)
await keywordCard.hover()
await page.waitForTimeout(50)
const hoverOnlyStayedHidden = await keywordCard.evaluate((card) =>
  !document.getElementById(card.dataset.keywordHelpId)?.hasAttribute('data-open'))
await page.keyboard.down('Shift')
await page.waitForFunction((card) => document.getElementById(card.dataset.keywordHelpId)?.hasAttribute('data-open'),
  await keywordCard.elementHandle())
const hoverKeywordTips = await keywordCard.evaluate((card) => {
  const tooltip = document.getElementById(card.dataset.keywordHelpId)
  return Array.from(tooltip.querySelectorAll('.card-keyword-tip')).map((tip) => ({
    name: tip.querySelector('strong')?.textContent,
    text: tip.querySelector('span')?.textContent,
    icon: tip.querySelector('img')?.getAttribute('src') ?? null,
    visible: tooltip.hasAttribute('data-open'),
  }))
})
const hoverTooltipA11y = await keywordCard.evaluate((card) => {
  const tooltip = document.getElementById(card.dataset.keywordHelpId)
  const description = document.getElementById(card.getAttribute('aria-describedby'))
  const box = tooltip.getBoundingClientRect()
  return {
    describedBy: Boolean(description?.textContent.includes('Vulnerable:')),
    role: tooltip.getAttribute('role'),
    inViewport: box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight,
  }
})
const hoverTooltipId = await keywordCard.getAttribute('data-keyword-help-id')
const hoverTooltip = page.locator(`[id="${hoverTooltipId}"]`)
await hoverTooltip.hover()
const hoverTooltipHoverable = await hoverTooltip.getAttribute('data-open') !== null
await page.keyboard.press('Escape')
const hoverTooltipDismissed = await hoverTooltip.getAttribute('data-open') === null
await page.keyboard.up('Shift')
await page.mouse.move(5, 5)
await keywordCard.hover()
await page.keyboard.down('Shift')
await page.waitForFunction((card) => document.getElementById(card.dataset.keywordHelpId)?.hasAttribute('data-open'),
  await keywordCard.elementHandle())
const keywordCardBox = await keywordCard.boundingBox()
assert(keywordCardBox, 'keyword card did not render a pointer target')
await page.mouse.move(keywordCardBox.x + keywordCardBox.width / 2, keywordCardBox.y + keywordCardBox.height / 2)
await page.mouse.down()
await page.mouse.move(keywordCardBox.x + keywordCardBox.width / 2 + 20, keywordCardBox.y + keywordCardBox.height / 2)
await page.waitForTimeout(50)
const pointerDownDismissed = await keywordCard.evaluate((card) =>
  !document.getElementById(card.dataset.keywordHelpId)?.hasAttribute('data-open'))
await page.mouse.up()
await keywordCard.evaluate((card) => card.blur())
await page.mouse.move(5, 5)
await keywordCard.hover()
await shot('02c-card-keyword-help')
await page.mouse.move(5, 5)
await keywordCard.hover()
await page.mouse.move(5, 5)
await page.waitForFunction((card) =>
  card.hasAttribute('data-keyword-help') && document.getElementById(card.dataset.keywordHelpId)?.hasAttribute('data-open'),
  await keywordCard.elementHandle())
const pinnedCardBox = await keywordCard.boundingBox()
assert(pinnedCardBox, 'pinned keyword card did not render a pointer target')
await page.mouse.move(pinnedCardBox.x + pinnedCardBox.width / 2, pinnedCardBox.y + pinnedCardBox.height / 2)
await page.mouse.down()
await page.mouse.move(5, 5)
await page.waitForTimeout(50)
const shiftDragHidden = await keywordCard.evaluate((card) =>
  !document.getElementById(card.dataset.keywordHelpId)?.hasAttribute('data-open'))
await page.mouse.up()
await page.waitForFunction((card) => document.getElementById(card.dataset.keywordHelpId)?.hasAttribute('data-open'),
  await keywordCard.elementHandle())
await keywordCard.evaluate((card) => card.blur())
const shiftPinned = await keywordCard.evaluate((card) => {
  const tooltip = document.getElementById(card.dataset.keywordHelpId)
  return { pinned: card.hasAttribute('data-keyword-help'), visible: tooltip.hasAttribute('data-open') }
})
await page.keyboard.up('Shift')
await page.waitForFunction((card) =>
  !document.getElementById(card.dataset.keywordHelpId)?.hasAttribute('data-open'), await keywordCard.elementHandle())
const shiftReleased = await keywordCard.evaluate((card) => {
  const tooltip = document.getElementById(card.dataset.keywordHelpId)
  return { pinned: card.hasAttribute('data-keyword-help'), visible: tooltip.hasAttribute('data-open') }
})
const aoeCard = page.getByRole('button', { name: /^Cleave,/ })
await page.waitForFunction((card) => !card.classList.contains('card--drawn'), await aoeCard.elementHandle())
await page.keyboard.down('Shift')
await keywordCard.hover()
await page.evaluate(() => window.dispatchEvent(new Event('blur')))
await aoeCard.hover()
const blurReleased = await page.locator('.card[data-keyword-help]').count() === 0
await page.keyboard.up('Shift')
await page.mouse.move(5, 5)
await keywordCard.focus()
await page.keyboard.down('Shift')
await aoeCard.focus()
const focusShiftPinned = await page.locator('.card[data-keyword-help]').evaluateAll((cards) => cards.map((card) => card.dataset.cardName))
await page.keyboard.up('Shift')
await keywordCard.hover()
await aoeCard.focus()
await page.keyboard.down('Shift')
const focusWinsHover = await page.locator('.card[data-keyword-help]').evaluateAll((cards) => cards.map((card) => card.dataset.cardName))
await page.mouse.move(5, 5)
await keywordCard.hover()
const pointerFollowsFocus = await page.locator('.card[data-keyword-help]').evaluateAll((cards) => cards.map((card) => card.dataset.cardName))
await page.keyboard.up('Shift')
await page.mouse.move(5, 5)
await aoeCard.hover()
await page.keyboard.down('Shift')
await page.waitForFunction((card) => document.getElementById(card.dataset.keywordHelpId)?.hasAttribute('data-open'),
  await aoeCard.elementHandle())
const aoeKeywordTips = await aoeCard.evaluate((card) => {
  const tooltip = document.getElementById(card.dataset.keywordHelpId)
  return Array.from(tooltip.querySelectorAll('.card-keyword-tip')).map((tip) => ({
    name: tip.querySelector('strong')?.textContent,
    icon: tip.querySelector('img')?.getAttribute('src') ?? null,
  }))
})
await shot('02d-card-aoe-keyword-help')
const keywordLoopCard = page.getByRole('button', { name: /^Loop,/ })
await aoeCard.evaluate((card) => card.blur())
await page.mouse.move(5, 5)
await keywordLoopCard.hover()
await page.waitForFunction((card) => document.getElementById(card.dataset.keywordHelpId)?.hasAttribute('data-open'),
  await keywordLoopCard.elementHandle())
const resourceKeywordTips = await keywordLoopCard.evaluate((card) => {
  const tooltip = document.getElementById(card.dataset.keywordHelpId)
  return Array.from(tooltip.querySelectorAll('.card-keyword-tip')).map((tip) => ({
    name: tip.querySelector('strong')?.textContent,
    icon: tip.querySelector('img')?.getAttribute('src') ?? null,
  }))
})
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[0].powers = [
    { uid: 'keyword-help-played-power', defId: 'loop', upgraded: false },
    { uid: 'keyword-help-second-power', defId: 'capacitor', upgraded: false },
  ]
  debug.setRun(run)
})
const playedPower = page.locator('.power').first()
await playedPower.click()
const playedPowerZoom = page.locator('.power__zoom')
await playedPower.focus()
await page.waitForFunction((card) => document.getElementById(card.dataset.keywordHelpId)?.hasAttribute('data-open'),
  await playedPower.elementHandle())
await page.waitForFunction((card) => document.getElementById(card.dataset.keywordHelpId)?.hasAttribute('data-pinned'),
  await playedPower.elementHandle())
const playedPowerKeywordTips = await playedPower.evaluate((card) => {
  const tooltip = document.getElementById(card.dataset.keywordHelpId)
  return Array.from(tooltip.querySelectorAll('.card-keyword-tip')).map((tip) => ({
    name: tip.querySelector('strong')?.textContent,
    icon: tip.querySelector('img')?.getAttribute('src') ?? null,
  }))
})
const playedPowerLayout = await playedPower.evaluate((card) => {
  const tooltip = document.getElementById(card.dataset.keywordHelpId)
  const help = tooltip.getBoundingClientRect()
  const zoom = document.querySelector('.power__zoom').getBoundingClientRect()
  return {
    overlaps: help.left < zoom.right && help.right > zoom.left && help.top < zoom.bottom && help.bottom > zoom.top,
    inViewport: help.left >= 0 && help.top >= 0 && help.right <= innerWidth && help.bottom <= innerHeight,
  }
})
await shot('02i-played-power-keyword-help')
await page.evaluate(() => {
  window.__KEYWORD_READY_COUNT__ = 0
  document.addEventListener('card-keyword-help-ready', () => { window.__KEYWORD_READY_COUNT__ += 1 })
})
const secondPlayedPower = page.locator('.power').nth(1)
await secondPlayedPower.click()
await page.waitForFunction(() => window.__KEYWORD_READY_COUNT__ > 0)
await page.waitForFunction((card) => {
  const help = document.getElementById(card.dataset.keywordHelpId)?.getBoundingClientRect()
  const zoom = document.querySelector('.power__zoom')?.getBoundingClientRect()
  return help && zoom && !(help.left < zoom.right && help.right > zoom.left && help.top < zoom.bottom && help.bottom > zoom.top)
}, await secondPlayedPower.elementHandle())
const playedPowerTransferStayedPinned = await secondPlayedPower.evaluate((card) =>
  document.getElementById(card.dataset.keywordHelpId)?.hasAttribute('data-pinned'))
await page.keyboard.up('Shift')
await page.keyboard.press('Escape')
await playedPowerZoom.waitFor({ state: 'detached' })
await page.setViewportSize({ width: 1440, height: 900 })
await page.getByRole('button', { name: 'Discard pile, 1 card' }).click()
const cardDialog = page.locator('dialog.card-collection[open]')
const dialogCard = cardDialog.getByRole('button', { name: /^Shockwave,/ })
await dialogCard.hover()
await page.waitForTimeout(50)
const dialogHoverStayedHidden = await dialogCard.evaluate((card) =>
  !document.getElementById(card.dataset.keywordHelpId)?.hasAttribute('data-open'))
await page.keyboard.down('Shift')
await page.waitForFunction((card) => document.getElementById(card.dataset.keywordHelpId)?.hasAttribute('data-open'),
  await dialogCard.elementHandle())
const dialogTooltip = await dialogCard.evaluate((card) => {
  const tooltip = document.getElementById(card.dataset.keywordHelpId)
  const box = tooltip.getBoundingClientRect()
  return {
    hostedByDialog: tooltip.parentElement === card.closest('dialog'),
    filter: getComputedStyle(tooltip).filter,
    inViewport: box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight,
  }
})
await shot('02e-card-dialog-keyword-help')
await page.keyboard.up('Shift')
await cardDialog.getByRole('button', { name: 'Back', exact: true }).click()
const symbolKeywordTips = await page.evaluate(async () => {
  const [{ CARDS }, { cardKeywordTips }] = await Promise.all([
    import('/src/game/cards.ts'), import('/src/ui/Card.tsx'),
  ])
  return {
    status: cardKeywordTips(CARDS.power_through),
    retain: cardKeywordTips(CARDS.equilibrium),
    power: cardKeywordTips(CARDS.loop),
    unplayable: cardKeywordTips(CARDS.daze),
    burn: cardKeywordTips(CARDS.burn),
    allEnemies: cardKeywordTips(CARDS.the_bomb),
    nonHit: [cardKeywordTips(CARDS.pain), cardKeywordTips(CARDS.buffer)],
    exhaustReferences: [cardKeywordTips(CARDS.buffer), cardKeywordTips(CARDS.the_bomb), cardKeywordTips(CARDS.rampage)],
    hitPoison: cardKeywordTips(CARDS.envenom),
    shiv: cardKeywordTips(CARDS.blade_dance),
    orbMechanics: [cardKeywordTips(CARDS.chaos), cardKeywordTips(CARDS.zap), cardKeywordTips(CARDS.dual_cast)],
    scry: cardKeywordTips(CARDS.foresight),
    neutral: cardKeywordTips(CARDS.empty_body),
  }
})
check('card keyword help appears only while Shift is held', () => {
  assert(hoverOnlyStayedHidden, 'hover alone should not show keyword help')
  assertDeepEqual(hoverKeywordTips.map((tip) => tip.name), ['Exhaust', 'All in a row', 'Vulnerable', 'Weak'])
  assert(hoverKeywordTips.every((tip) => tip.visible && tip.text), 'every keyword panel should be visible and explained')
  assert(hoverKeywordTips.some((tip) => tip.name === 'All in a row' &&
    tip.text === 'Affects all enemies in one row and always also the boss.'), 'AoE help should not imply a hit')
  assertDeepEqual(hoverKeywordTips.map((tip) => tip.icon), [
    null, '/assets/icons/aoe.png', '/assets/icons/vulnerable.png', '/assets/icons/weak.png',
  ])
  assertDeepEqual(hoverTooltipA11y, { describedBy: true, role: 'tooltip', inViewport: true })
  assert(hoverTooltipHoverable, 'keyword help should remain visible while the board itself is hovered')
  assert(hoverTooltipDismissed, 'Escape should dismiss hover or focus keyword help')
  assert(pointerDownDismissed, 'starting a card pointer interaction should dismiss keyword help')
  assertDeepEqual(shiftPinned, { pinned: true, visible: true })
  assert(shiftDragHidden, 'a pinned board should stay hidden while its card is dragged')
  assertDeepEqual(shiftReleased, { pinned: false, visible: false })
  assert(blurReleased, 'window blur should release Shift-pinned keyword help')
  assertDeepEqual(focusShiftPinned, ['Cleave'])
  assertDeepEqual(focusWinsHover, ['Cleave'])
  assertDeepEqual(pointerFollowsFocus, ['Shockwave'])
  assertDeepEqual(symbolKeywordTips.status.map((tip) => [tip.name, tip.icon, tip.text]), [
    ['Block', 'block', 'Prevents 1 damage per Block. Player Block is capped at 20.'],
    ['Daze', 'daze', 'A Daze is Ethereal and Unplayable.'],
  ])
  assert(symbolKeywordTips.retain.some((tip) => tip.name === 'Retain' &&
    tip.text === 'A retained card stays in its owner’s hand at end of turn.'), 'Retain help should not change its target')
  assert(symbolKeywordTips.power.some((tip) => tip.name === 'Power'), 'Power cards should explain their printed type')
  assertDeepEqual(symbolKeywordTips.unplayable.map((tip) => [tip.name, tip.icon ?? null]), [
    ['Ethereal', null], ['Unplayable', null], ['Status', null], ['Daze', 'daze'],
  ])
  assert(symbolKeywordTips.burn.some((tip) => tip.name === 'Burn' && tip.icon === 'burn'),
    'Burn itself should explain its named symbol')
  assert(symbolKeywordTips.allEnemies.some((tip) => tip.name === 'All Enemies'), 'ALL Enemies should explain its reach')
  assert(symbolKeywordTips.nonHit.every((tips) => tips.every((tip) => tip.name !== 'Hit')),
    'HP-loss wording should not be mistaken for a Hit')
  assert(symbolKeywordTips.exhaustReferences.every((tips) => tips.some((tip) => tip.name === 'Exhaust')),
    'all printed Exhaust references should explain Exhaust')
  assert(symbolKeywordTips.hitPoison.some((tip) => tip.name === 'Hit' && tip.icon === 'attack'),
    'effects that explicitly modify each Hit should explain the Hit symbol')
  assert(symbolKeywordTips.shiv.some((tip) => tip.name === 'Shiv' &&
    tip.text === 'Spend a Shiv to deal 1 damage as a separate hit. Shivs are not cards.'),
  'Shiv help should not describe the token as a card')
  assert(symbolKeywordTips.orbMechanics.every((tips) =>
    tips.some((tip) => tip.name === 'Orb' && tip.statusIcon === 'orb')),
  'Channel and Evoke mechanics should explain the Orb symbol')
  assert(symbolKeywordTips.scry.some((tip) => tip.name === 'Scry' &&
    tip.text === 'Look at the top cards of your draw pile. Discard any, then return the rest on top in the same order.'),
  'Scry help should preserve the remaining cards’ order')
  assert(symbolKeywordTips.neutral.some((tip) => tip.name === 'Neutral' &&
    tip.text.includes('default Stance')), 'entering Neutral should explain the stance')
  assertDeepEqual(aoeKeywordTips, [
    { name: 'All in a row', icon: '/assets/icons/aoe.png' },
    { name: 'Hit', icon: '/assets/icons/attack.png' },
  ])
  assert(resourceKeywordTips.some((tip) => tip.name === 'Orb' && tip.icon === '/assets/status-icons/orb.png'))
  assert(resourceKeywordTips.some((tip) => tip.name === 'Power' && tip.icon === '/assets/status-icons/power.png'))
  assert(playedPowerKeywordTips.some((tip) => tip.name === 'Orb' && tip.icon === '/assets/status-icons/orb.png'))
  assert(playedPowerKeywordTips.some((tip) => tip.name === 'Power' && tip.icon === '/assets/status-icons/power.png'))
  assertDeepEqual(playedPowerLayout, { overlaps: false, inViewport: true })
  assert(playedPowerTransferStayedPinned, 'switching between in-play Powers should refresh pinned keyword help')
  assert(dialogHoverStayedHidden, 'hover alone should not show keyword help in card dialogs')
  assertDeepEqual(dialogTooltip, { hostedByDialog: true, filter: 'none', inViewport: true })
})
await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), combatAppearanceRun)

// Card art must actually load; a broken path renders an empty box that no state
// assertion would catch.
const artStatus = await page.evaluate(() =>
  [...document.querySelectorAll('.card > .card-face > img.card-face__illustration')].map((img) => {
    const scan = img.closest('.card')?.querySelector(':scope > .card__art')
    return {
      src: img.getAttribute('src'),
      ok: img.complete && img.naturalWidth > 0,
      scanUnavailable: scan instanceof HTMLImageElement &&
        (scan.naturalWidth === 0 || getComputedStyle(scan).visibility === 'hidden'),
    }
  }),
)
// A missing file under public/ is served by Vite's SPA fallback as 200 + HTML,
// so a network-status check cannot see it. Only naturalWidth tells the truth.
const enemyArtStatus = await page.evaluate(() =>
  [...document.querySelectorAll('.enemy__portrait > img')].map((img) => ({
    src: img.getAttribute('src'),
    ok: img.complete && img.naturalWidth > 0,
  })),
)
check('every enemy portrait on screen actually loaded', () => {
  assert(enemyArtStatus.length > 0, 'expected enemies to be rendered')
  const broken = enemyArtStatus.filter((entry) => !entry.ok)
  assert(broken.length === 0, `broken enemy art: ${broken.map((b) => b.src).join(', ')}`)
})

check('repo-native card illustrations load only when a scan is unavailable', () => {
  if (!artSynced) assert(artStatus.length > 0, 'expected fallback cards to be rendered')
  const broken = artStatus.filter((entry) => !entry.ok)
  assert(broken.length === 0, `broken card art: ${broken.map((b) => b.src).join(', ')}`)
  assert(artStatus.every((entry) => entry.src?.startsWith('/assets/card-art/')),
    `a native face used the wrong asset root: ${artStatus.map((entry) => entry.src).join(', ')}`)
  assert(artStatus.every((entry) => entry.scanUnavailable),
    'a fallback illustration decoded while its publisher scan was available')
})

const nativeFace = await page.locator('.hand .card').first().evaluate((card) => {
  const scan = card.querySelector('.card__art')
  const illustration = card.querySelector(':scope > .card-face > .card-face__illustration')
  return {
    scanHidden: scan instanceof HTMLElement && getComputedStyle(scan).visibility === 'hidden',
    illustrationWidth: illustration instanceof HTMLImageElement ? illustration.naturalWidth : 0,
    title: card.querySelector('.card-face__title')?.textContent ?? '',
    type: card.querySelector('.card-face__type')?.textContent ?? '',
    rules: card.querySelector('.card-face__rules')?.textContent ?? '',
  }
})
check('a clean clone renders a complete native card face when its optional scan is missing', () => {
  if (artSynced) return
  assert(nativeFace.scanHidden, 'the missing optional scan should reveal the native face')
  assertEqual(nativeFace.illustrationWidth, 748, 'native illustration width')
  assert(nativeFace.title.length > 0, 'native face title is missing')
  assert(/attack|skill|power/i.test(nativeFace.type), `native face type is missing: ${nativeFace.type}`)
  assert(nativeFace.rules.length > 0, 'native face rules are missing')
})

const originalViewport = page.viewportSize()
const nativeFaceOverflow = []
for (const viewport of [
  { width: 1440, height: 900 },
  { width: 900, height: 620 },
]) {
  await page.setViewportSize(viewport)
  nativeFaceOverflow.push(await page.locator('.hand .card-face').first().evaluate(
    async (face, size) => {
      const { CARDS: definitions, faceOf } = await import('/src/game/cards.ts')
      const { cardRulesText } = await import('/src/ui/Card.tsx')
      const title = face.querySelector('.card-face__title')
      const rules = face.querySelector('.card-face__rules')
      const original = { title: title.textContent, rules: rules.textContent }
      const clippedTitles = []
      const clippedRules = []
      for (const def of Object.values(definitions)) {
        if (!['ironclad', 'silent', 'defect', 'watcher'].includes(def.owner)) continue
        for (const upgraded of [false, true]) {
          const shown = faceOf(def, upgraded)
          title.textContent = shown.name
          rules.textContent = cardRulesText(shown)
          const label = `${shown.name}${upgraded ? '+' : ''}`
          if (title.scrollHeight > title.clientHeight + 1 || title.scrollWidth > title.clientWidth + 1) clippedTitles.push(label)
          if (rules.scrollHeight > rules.clientHeight + 1 || rules.scrollWidth > rules.clientWidth + 1) clippedRules.push(label)
        }
      }
      title.textContent = original.title
      rules.textContent = original.rules
      return { size, clippedTitles, clippedRules, lineClamp: getComputedStyle(title).webkitLineClamp }
    },
    viewport,
  ))
}
check('every base and upgraded character face fits at desktop sizes', () => {
  for (const probe of nativeFaceOverflow) {
    assertEqual(probe.lineClamp, '2')
    assertDeepEqual(probe.clippedTitles, [], `title clipping at ${probe.size.width}x${probe.size.height}`)
    assertDeepEqual(probe.clippedRules, [], `rules clipping at ${probe.size.width}x${probe.size.height}`)
  }
})
if (originalViewport) await page.setViewportSize(originalViewport)

// The map, read from inside a fight. This is where a party decides what its
// deck is FOR, so the act's boss has to be legible without leaving the combat.
const bossDuringCombat = (await readRun()).actBossDefId
const deckButton = await page.getByRole('button', { name: /^Current deck,/ }).evaluate((button) => {
  const icon = button.querySelector('img')
  const style = getComputedStyle(button)
  return {
    source: icon?.getAttribute('src'),
    loaded: icon instanceof HTMLImageElement && icon.complete && icon.naturalWidth > 0,
    border: style.borderWidth,
    background: style.backgroundImage,
  }
})
const mapButtonIcon = await page.getByRole('button', { name: 'Map' }).locator('img').evaluate((image) => ({
  source: image.getAttribute('src'), loaded: image.complete && image.naturalWidth > 0,
}))
const mapButtonBackground = await page.getByRole('button', { name: 'Map' }).evaluate((button) => getComputedStyle(button).backgroundImage)
const mapButtonPlacement = await page.evaluate(() => {
  const map = document.querySelector('.map-peek__open').getBoundingClientRect()
  const menu = document.querySelector('.game-settings').getBoundingClientRect()
  return { gap: menu.left - map.right, centered: Math.abs((menu.top + menu.bottom - map.top - map.bottom) / 2) < 2 }
})
const settingsButton = await page.locator('.game-settings').evaluate((summary) => {
  const icon = summary.querySelector('img')
  const style = getComputedStyle(summary)
  return { label: summary.getAttribute('aria-label'), text: summary.textContent?.trim(), source: icon?.getAttribute('src'), loaded: icon instanceof HTMLImageElement && icon.complete && icon.naturalWidth > 0, border: style.borderWidth, background: style.backgroundImage }
})
check('the combat header uses icon-only deck, map, and settings controls', () => {
  assertEqual(deckButton.source, '/assets/menu/current-deck.webp')
  assert(deckButton.loaded, 'the current-deck icon did not load')
  assertEqual(deckButton.border, '0px')
  assertEqual(deckButton.background, 'none')
  assertEqual(mapButtonIcon.source, '/assets/menu/map-scroll.png')
  assert(mapButtonIcon.loaded, 'the map-scroll icon did not load')
  assertEqual(mapButtonBackground, 'none')
  assert(mapButtonPlacement.gap >= 0 && mapButtonPlacement.gap <= 24 && mapButtonPlacement.centered,
    `the map button is not beside Settings: ${JSON.stringify(mapButtonPlacement)}`)
  assertEqual(settingsButton.label, 'Settings')
  assertEqual(settingsButton.text, '')
  assertEqual(settingsButton.source, '/assets/menu/settings-cog.png')
  assert(settingsButton.loaded, 'the settings-cog icon did not load')
  assertEqual(settingsButton.border, '0px')
  assertEqual(settingsButton.background, 'none')
})
await page.getByRole('button', { name: /^Current deck,/ }).click()
const currentDeckDialog = page.getByRole('dialog', { name: 'Current deck' })
await currentDeckDialog.waitFor()
const currentDeckCardCount = await currentDeckDialog.locator('.card').count()
check('the current-deck control opens the read-only card viewer', () => {
  assert(currentDeckCardCount > 0, 'the current deck rendered no cards')
})
const deckSortControls = await currentDeckDialog.locator('.card-collection__sort button').allTextContents()
await currentDeckDialog.getByRole('button', { name: /A - Z/ }).click()
const alphabeticalDeckNames = await currentDeckDialog.locator('.choice-modal__cards > .card').evaluateAll((cards) =>
  cards.map((card) => card.getAttribute('aria-label')?.split(',')[0] ?? ''))
await currentDeckDialog.getByLabel('Current deck upgrade preview').check()
const deckUpgradePreview = await currentDeckDialog.locator('.choice-modal__cards > .card').first().getAttribute('aria-label')
check('the deck viewer sorts cards and previews their upgrades', () => {
  assertDeepEqual(deckSortControls.map((text) => text.replace(/\s*[↑↓↕]\s*$/, '').trim()), ['Obtained', 'Card Type', 'Cost', 'A - Z'])
  assertDeepEqual(alphabeticalDeckNames, [...alphabeticalDeckNames].sort((left, right) => left.localeCompare(right)))
  assert((deckUpgradePreview ?? '').includes('+, '), `the deck upgrade preview is not shown: ${deckUpgradePreview}`)
})
await currentDeckDialog.getByRole('button', { name: 'Back', exact: true }).click()
await page.getByRole('button', { name: 'Map' }).click()
await page.locator('.map-peek[open] .room').first().waitFor()
const peekBossNode = page.locator('.map-peek .room--boss').first()
await peekBossNode.hover()
await page.waitForFunction(() =>
  getComputedStyle(document.querySelector('.map-peek .room--boss .room-tip')).visibility === 'visible')
const mapPeek = await page.evaluate(() => {
  const node = document.querySelector('.map-peek .room--boss')
  const tip = node.querySelector('.room-tip')
  const box = tip.getBoundingClientRect()
  const panel = document.querySelector('.map-peek__panel').getBoundingClientRect()
  return {
    label: node.getAttribute('aria-label'),
    tip: tip.textContent,
    reachable: document.querySelectorAll('.map-peek .room--reachable').length,
    contained: box.top >= panel.top - 1 && box.bottom <= panel.bottom + 1 &&
      box.left >= panel.left - 1 && box.right <= panel.right + 1,
    modal: document.querySelector('.map-peek').matches(':modal'),
  }
})
await shot('03a1-map-during-combat')
check('the map opens over a fight, names the act boss, and cannot be walked', () => {
  assert(mapPeek.modal, 'the map peek is not a modal dialog')
  assertEqual(mapPeek.reachable, 0, 'a map opened mid-fight offered a room to enter')
  const bossName = enemyDef(bossDuringCombat, 0).name
  assert(mapPeek.label.includes(bossName), `${bossName} missing from ${mapPeek.label}`)
  assert(mapPeek.tip.includes(bossName), `${bossName} missing from the hover panel: ${mapPeek.tip}`)
  assert(mapPeek.contained, 'the hover panel opened outside the map dialog and was clipped')
})
await page.locator('.map-peek').getByRole('button', { name: 'Close' }).click()
await page.waitForFunction(() => !document.querySelector('.map-peek[open]'))

await page.getByRole('button', { name: 'End turn' }).click()
const beforeDiscard = await readState()
check('end-of-turn effects resolve before the hand order is confirmed', () => {
  assertEqual(beforeDiscard.phase, 'discard', 'the game pauses for the post-trigger hand')
  assertEqual(beforeDiscard.players[0].hand.length, combatAppearanceRun.combat.players[0].hand.length,
    'the hand is still present for ordering')
})
await shot('03b-discard-order')
const discardPlayers = beforeDiscard.players.filter(discardNeedsChoice)
await confirmDiscard(discardPlayers[0])
if (discardPlayers.length > 1) {
  const waitingForDiscards = await readState()
  check('one local seat cannot finalize another living player\'s hand', () => {
    assertEqual(waitingForDiscards.phase, 'discard', 'the other seat must confirm its own order')
    assertEqual(waitingForDiscards.players[0].hand.length, combatAppearanceRun.combat.players[0].hand.length,
      'no hand is discarded early')
  })
}
for (const player of discardPlayers.slice(1)) await confirmDiscard(player)
await chooseSeat(discardPlayers[0].id)
const afterEnd = await readState()
check('ending the turn discards the hand and hands over to the enemies', () => {
  assertEqual(afterEnd.players[0].hand.length, 0, 'the hand is discarded')
  assert(['enemy', 'roundEnd', 'start', 'player', 'lost'].includes(afterEnd.phase), 'the Enemy Turn follows')
})
await shot('04-enemy-phase')

if (afterEnd.phase === 'enemy') await waitForAutomaticEnemyResolution()
const afterEnemies = await readState()
check('enemies resolve automatically and the next round continues', () => {
  assert(
    ['roundEnd', 'start', 'player', 'lost'].includes(afterEnemies.phase),
    `expected the round to continue or the party to fall, got ${afterEnemies.phase}`,
  )
})
await shot('05-after-enemy-turn')

// The whole reason a combat is worth playing is that it lasts more than one
// round. This suite used to stop at the click above, which is exactly why the
// game shipped unplayable past round 1: nothing on screen started turn 2.
if (afterEnemies.phase !== 'lost') {
  await waitForAutomaticTurn(2)
  const secondRound = await readState()
  check('a second round can actually be started and played', () => {
    assertEqual(secondRound.phase, 'player', 'the next Player Turn begins')
    assertEqual(secondRound.turn, 2, 'the turn counter advances')
    assertEqual(secondRound.players[0].hand.length, 5, 'a fresh hand is dealt')
    assertEqual(secondRound.players[0].energy, 3, 'and Energy is reset')
  })

  const beforeSecondPlay = await readState()
  await chooseSeat(beforeSecondPlay.players[0].id)
  const secondAttack = beforeSecondPlay.players[0].hand.findIndex((card) =>
    card.defId.startsWith('strike'),
  )
  assert(secondAttack >= 0, 'expected a Strike in the second hand')
  await page.getByRole('button', { name: /^Strike,/ }).first().press('Enter')
  await page.locator('.enemy .enemy__hit-area').first().click()
  const afterSecondPlay = await readState()
  check('cards are playable in the second round, not just the first', () => {
    assertEqual(afterSecondPlay.players[0].hand.length, 4, 'the card leaves hand')
    assertEqual(afterSecondPlay.players[0].energy, beforeSecondPlay.players[0].energy - 1,
      'the card spends its printed Energy')
    assert(afterSecondPlay.log.length > beforeSecondPlay.log.length &&
      afterSecondPlay.log.some((line) => line.includes('played Strike')),
      'the play resolves even when Weak or Block prevents HP damage')
  })
  await shot('05b-second-round')
}

// Play the encounter out to its end, clicking only what a player can click.
// The suite used to stop a few clicks in, which is how a combat that could not
// reach round 2 shipped green. A whole fight is the only thing that proves the
// loop closes.
async function playOutCombat(limit = 60) {
  for (let step = 0; step < limit; step++) {
    const state = await readState()
    if (state.phase === 'won' || state.phase === 'lost') return state

    if (state.phase === 'roundEnd') {
      await waitForAutomaticTurn(state.turn + 1)
      continue
    }
    if (state.phase === 'enemy') {
      await waitForAutomaticEnemyResolution()
      continue
    }

    // Player turn: swing with whatever is affordable, then end the turn.
    const attack = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('.hand .card')]
      const index = cards.findIndex((card) => card.getAttribute('aria-disabled') !== 'true')
      return index
    })
    if (attack >= 0) {
      await page.locator('.hand .card').nth(attack).click()
      // Targeted cards need an enemy; untargeted ones resolve on the spot.
      const wantsTarget = await page.locator('.prompt').count()
      if (wantsTarget > 0) {
        const enemy = page.locator('.enemy:not([disabled]) .enemy__hit-area').first()
        if (await enemy.count()) await enemy.click()
        else await page.locator('.hand .card').nth(attack).click()
      }
      continue
    }
    await endTurn()
  }
  const stalled = await readState()
  throw new Error(`the combat never ended: phase=${stalled.phase}, turn=${stalled.turn}, enemies=${stalled.enemies.map((enemy) => enemy.hp).join(',')}`)
}

const finished = await playOutCombat()
// A busy four-player round proves the engine retains its diagnostic history
// without putting a battle-log control on the playable board.
await page.evaluate(() => window.__STS_DEBUG__.reset(4, 'log-round'))
await bypassNeow()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().players.length === 4)
await enterFirstRoom()
await endTurn()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase !== 'enemy')

const battleLogUi = await page.evaluate(() => ({
  lines: window.__STS_DEBUG__.getState().log.length,
  drawer: document.querySelector('.combat-log-drawer'),
  report: document.querySelector('.combat__enemy-report'),
}))
check('combat keeps debug logs without rendering battle-log UI', () => {
  assert(battleLogUi.lines > 4, 'the engine stopped recording combat events')
  assertEqual(battleLogUi.drawer, null)
  assertEqual(battleLogUi.report, null)
})

await page.evaluate((source) => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(source)
  for (const player of run.combat.players) Object.assign(player, {
    hp: 999, maxHp: 999, block: 999, dead: false,
  })
  for (const enemy of run.combat.enemies) Object.assign(enemy, {
    defId: 'sentry_a', pendingDefId: undefined, actionIndex: 0,
    hp: 999, maxHp: 999, block: 999, poison: 0, corpseExplosion: undefined, dead: false,
  })
  debug.setRun(run)
}, combatAppearanceRun)
// Two turns, each proving End turn is actually unmounted before verifying that
// keyboard focus returns when the player's phase comes back.
for (let enemyTurn = 0; enemyTurn < 2; enemyTurn += 1) {
  // Asserted rather than assumed: if the fight ends inside this loop the waits
  // below can never be satisfied, and the round reports a 30s Playwright
  // timeout instead of naming what went wrong.
  const before = await readState()
  assert(before && !['won', 'lost'].includes(before.phase),
    `the fight ended before enemy turn ${enemyTurn + 1}; this block needs a live combat`)
  await plantDiscardOrderCards()
  // The enemy round can pass between Playwright round-trips, so observe the
  // transient missing-button frame in the page itself.
  await page.evaluate(() => {
    window.__END_TURN_WAS_REMOVED__ = false
    const generation = (window.__BLUR_WATCH_GENERATION__ = (window.__BLUR_WATCH_GENERATION__ ?? 0) + 1)
    let sawEnemy = false
    const watch = () => {
      if (window.__BLUR_WATCH_GENERATION__ !== generation) return
      const enemyRound = ['enemy', 'roundEnd'].includes(window.__STS_DEBUG__.getState().phase)
      sawEnemy ||= enemyRound
      if (sawEnemy && !enemyRound) return
      if (enemyRound && !document.querySelector('.combat__end-turn')) window.__END_TURN_WAS_REMOVED__ = true
      requestAnimationFrame(watch)
    }
    watch()
  })
  await endTurn()
  // Anchored to the turn this iteration started on: reading the live turn here
  // waits for one MORE turn whenever the enemy already finished its own.
  await waitForAutomaticTurn(before.turn + 1)
  assert(await page.evaluate(() => window.__END_TURN_WAS_REMOVED__),
    `enemy turn ${enemyTurn + 1} never removed End turn, so the focus restore below tests nothing`)
}
// `waitForAutomaticTurn` polls the store, but the focus restore is a React
// effect that runs after commit — waiting on the DOM removes that race rather
// than relying on two Playwright round-trips of slack.
await page.waitForFunction(() => document.activeElement?.classList?.contains('combat__end-turn'))
const endTurnFocus = await page.evaluate(() => ({
  phase: window.__STS_DEBUG__.getState().phase,
  onEndTurn: document.activeElement?.classList?.contains('combat__end-turn') ?? false,
  active: document.activeElement?.className || document.activeElement?.tagName || '<body>',
}))
check("focus returns to End turn once the board is the player's again", () => {
  assertEqual(endTurnFocus.phase, 'player')
  assert(endTurnFocus.onEndTurn, `focus landed on ${endTurnFocus.active}`)
})
// Pin the GUARD, not just the restore. The effect keys on the phase it came
// FROM; ungated it also fires on `start -> player`, parking focus on End turn
// the instant the player resolves their start of turn, where the next Space or
// Enter ends the turn they just began — with no ring, because that path is
// mouse-driven. Deleting the guard leaves the check above green, so this drives
// the transition the guard exists to refuse.
await page.evaluate(() => {
  const run = structuredClone(window.__STS_DEBUG__.getRun())
  run.combat.phase = 'start'
  window.__STS_DEBUG__.setRun(run)
})
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'start')
await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
await page.evaluate(() => {
  const run = structuredClone(window.__STS_DEBUG__.getRun())
  run.combat.phase = 'player'
  window.__STS_DEBUG__.setRun(run)
})
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'player')
const focusAfterStartOfTurn = await page.evaluate(() =>
  document.activeElement?.className || document.activeElement?.tagName || '<body>')
check('resolving a start of turn does not hand focus to End turn', () => {
  assert(!String(focusAfterStartOfTurn).includes('combat__end-turn'),
    `focus was stolen to ${focusAfterStartOfTurn} on start -> player`)
})

// Hand focus back. This block deliberately parks it on End turn, and leaving it
// there changes where a later Tab walk starts — the fanned-card checks measure
// scroll after a Shift+Tab/Tab pair and pick up 5px of drift from it.
await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())

check('a whole encounter can be fought to its end', () => {
  assert(
    finished.phase === 'won' || finished.phase === 'lost',
    `the combat should end, got ${finished.phase}`,
  )
})
await shot('05c-combat-over')

// Victory is its own path — rewards, and the hand-off back to the map — and a
// starter deck does not reliably win the opening fight, so it is set up rather
// than hoped for. Testing "won or lost" alone would pass with the victory path
// completely broken.
await page.evaluate(() => window.__STS_DEBUG__.reset(2, 'winnable'))
await bypassNeow()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'map')
await enterFirstRoom()
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  for (const foe of run.combat.enemies) {
    foe.hp = 1
    foe.cardReward = 'normal'
  }
  debug.setRun(run)
})
await page.waitForFunction(() => window.__STS_DEBUG__.getState().enemies.every((foe) => foe.hp === 1))

const won = await playOutCombat()
check('a combat can actually be won', () => {
  assertEqual(won.phase, 'won', 'the party should win against 1 hit point of enemy')
  assert(won.enemies.every((foe) => foe.dead), 'and every enemy is dead')
})
await shot('05d-victory')

// A win becomes an immediate, click-to-claim Loot panel. Every row is an
// independent choice; cards do not wait on Gold, Potions, or Relics.
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'reward', null, { timeout: 5000 })
const lootRun = await readRun()
const lootRows = await page.locator('.reward-screen--loot .loot-choice').count()
const hiddenCardChoices = await page.locator('.reward-screen--card-choice .card').count()
const lootTitleVisible = await page.getByRole('heading', { name: 'Loot!' }).isVisible()
const cardLootEnabled = await page.getByRole('button', { name: 'Add a card to your deck.' }).first().isEnabled()
const individualPotionSkips = await page.getByRole('button', { name: /^Skip .*Potion$/ }).count()
const lootSkipPlacement = await page.locator('.reward-screen--loot > .reward-screen__skip').evaluate((skip) => {
  const panel = document.querySelector('.reward-screen--loot .reward-screen__players')?.getBoundingClientRect()
  const box = skip.getBoundingClientRect()
  return Boolean(panel && box.left > panel.right && box.right <= innerWidth && box.top > innerHeight * 0.5)
})
check('victory presents immediate loot before any card choice', () => {
  assertEqual(lootRun.rewards.length, 2)
  assert(lootTitleVisible)
  assert(lootRows >= 2, 'the Loot panel omitted its click-to-claim rows')
  assertEqual(hiddenCardChoices, 0)
  assert(cardLootEnabled, 'the card reward was coupled to unclaimed item loot')
  assertEqual(individualPotionSkips, 0, 'the loot table still has an individual Potion skip button')
  assert(lootSkipPlacement, 'the Loot Skip is not anchored at the lower-right outside the panel')
})
await shot('05e-loot')

for (;;) {
  const current = await readRun()
  const offer = current.rewards.find((candidate) => candidate.gold || typeof candidate.potion === 'string' || typeof candidate.relic === 'string')
  if (!offer) break
  const label = offer.gold ? `${offer.gold} Gold`
    : typeof offer.potion === 'string' ? potionDef(offer.potion).name
      : relicDef(offer.relic).name
  await page.getByRole('button', { name: label }).first().click()
}
await page.waitForFunction(() => [...document.querySelectorAll('.loot-choice')].every((row) => !/Gold|Potion|Relic/.test(row.textContent ?? '')))
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.rewards[0].upgraded = true
  debug.setRun(run)
})
const rewardRun = await readRun()
const deckSizesBeforeReward = rewardRun.players.map((player) => player.deck.length)
await page.locator('.reward-screen__player').nth(0).getByRole('button', { name: 'Add a card to your deck.' }).click()
await page.getByRole('heading', { name: 'Choose a Card' }).waitFor()
if (artSynced) {
  await page.waitForFunction(() => [...document.querySelectorAll('.reward-screen__cards .card__art')]
    .every((image) => image.complete && image.naturalWidth > 0))
}
const rewardCards = await page.locator('.reward-screen__cards .card').count()
const rewardArt = await page.locator('.reward-screen__cards .card__art').evaluateAll((images) =>
  images.map((image) => image.complete && image.naturalWidth > 0),
)
const firstReward = page.locator('.reward-screen__cards .card').first()
const restingCard = await firstReward.boundingBox()
await firstReward.hover()
await page.waitForTimeout(180)
const hoveredCard = await firstReward.boundingBox()
check('a card loot row opens three full-size choices with the requested hover lift', () => {
  assertEqual(rewardCards, 3)
  assert(restingCard && hoveredCard && hoveredCard.width > restingCard.width * 1.05,
    'hovering a reward card did not enlarge it')
  if (artSynced) assert(rewardArt.every(Boolean), 'a card-reward image did not load')
})
await shot('05ea-card-rewards')
await page.setViewportSize({ width: 844, height: 390 })
await page.waitForTimeout(100)
const horizontalCardPicker = await page.locator('.reward-screen--card-choice').evaluate((screen) => {
  const cards = [...screen.querySelectorAll('.card')].map((card) => card.getBoundingClientRect())
  const skip = screen.querySelector('button.reward-screen__skip')?.getBoundingClientRect()
  return cards.length === 3 && cards.every((card) => card.width >= 64 && card.top >= 0 && card.bottom <= innerHeight) &&
    Boolean(skip && skip.bottom <= innerHeight)
})
check('the card picker remains usable on a horizontal phone screen', () => {
  assert(horizontalCardPicker)
})
await page.screenshot({ path: join(outDir, '05eb-horizontal-phone-card-reward.png'), timeout: 15_000 })
await page.setViewportSize({ width: 1440, height: 900 })
await firstReward.click()
await page.getByRole('heading', { name: 'Loot!' }).waitFor()
await page.locator('.reward-screen__player').nth(1).getByRole('button', { name: 'Add a card to your deck.' }).click()
await page.getByRole('heading', { name: 'Choose a Card' }).waitFor()
await page.getByRole('button', { name: 'Skip' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'map')
const backOnMap = await readRun()
check('winning hands the party back to the map with somewhere to go', () => {
  assertEqual(backOnMap.phase, 'map', 'the run continues on the map')
  assert(backOnMap.map.position !== null, 'and the boot has moved onto the board')
  assert(
    backOnMap.map.rooms[backOnMap.map.position].visited,
    'the room just cleared is marked visited',
  )
  assertEqual(backOnMap.players[0].deck.length, deckSizesBeforeReward[0] + 1, 'the chosen card persists')
  assertEqual(backOnMap.players[0].deck.at(-1).upgraded, true, 'an upgraded reward upgrades only the collected card')
  assertEqual(backOnMap.players[1].deck.length, deckSizesBeforeReward[1], 'skipping adds no card')
})
await page.waitForFunction(() => document.querySelector('.map__path--live') && document.querySelector('.room--here'))
await page.waitForFunction(() => {
  const map = document.querySelector('.map:not([inert])')
  const room = map?.querySelector('.room--here')
  if (!map || !room) return false
  const port = map.getBoundingClientRect()
  const node = room.getBoundingClientRect()
  return node.top >= port.top && node.bottom <= port.bottom
})
const mapMotion = await page.evaluate(() => ({
  route: getComputedStyle(document.querySelector('.map__path--live')).animationName,
  marker: getComputedStyle(document.querySelector('.room--here'), '::after').animationName,
  positionInView: (() => {
    const map = document.querySelector('.map:not([inert])').getBoundingClientRect()
    const room = document.querySelector('.map:not([inert]) .room--here').getBoundingClientRect()
    return room.top >= map.top && room.bottom <= map.bottom
  })(),
}))
await page.evaluate(() => {
  for (const animation of document.getAnimations()) {
    if (animation.animationName === 'map-trail' || animation.animationName === 'map-ring') {
      animation.currentTime = 500
      animation.pause()
    }
  }
})
await page.screenshot({ path: join(animationReferenceDir, 'map-route.png'), timeout: 15_000 })
await page.evaluate(() => {
  for (const animation of document.getAnimations()) {
    if ((animation.animationName === 'map-trail' || animation.animationName === 'map-ring') &&
      animation.playState === 'paused') animation.play()
  }
})
check('the current map position and reachable route stay visibly marked', () => {
  assertEqual(mapMotion.route, 'none')
  assertEqual(mapMotion.marker, 'none')
  assert(mapMotion.positionInView, 'the current room is outside the map scrollport')
})
await shot('05f-back-on-map')

// Prismatic Shard still needs its printed three-deck choice before exposing
// cards; the compact Loot row must not turn that into an impossible reveal.
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.phase = 'reward'
  run.rewardDestination = 'map'
  run.rewards = [{
    playerId: run.players[0].id,
    gold: false,
    cardReward: true,
    choices: null,
    upgraded: false,
    cardSource: 'ordinary',
    prismatic: true,
    availableSources: ['ironclad', 'silent', 'defect'],
    potion: false,
    relic: false,
    bossRelics: false,
  }]
  debug.setRun(run)
})
await page.getByRole('button', { name: 'Add a card to your deck.' }).click()
await page.getByRole('heading', { name: 'Choose a Card' }).waitFor()
const prismaticSources = page.locator('.reward-screen__sources input[type="checkbox"]')
const prismaticReveal = page.getByRole('button', { name: 'Reveal cards' })
const prismaticRevealDisabled = await prismaticReveal.isDisabled()
const prismaticSourceCount = await prismaticSources.count()
for (let index = 0; index < 3; index += 1) await prismaticSources.nth(index).check()
await prismaticReveal.click()
await page.waitForFunction(() => document.querySelectorAll('.reward-screen--card-choice .card').length === 3)
check('a Prismatic Loot row keeps the required three-deck reveal choice', () => {
  assertEqual(prismaticSourceCount, 3)
  assert(prismaticRevealDisabled, 'Prismatic reveal did not require three reward decks')
})
await page.getByRole('button', { name: 'Skip' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'map')

// Hit feedback has to survive the rest of the combat without moving the board.
await page.evaluate(() => window.__STS_DEBUG__.reset(2, 'hit-feedback'))
await bypassNeow()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'map')
await enterFirstRoom()

// Orbs are board state the log talks about ("Defect's Lightning orb hit ...
// for 1"), so they have to be visible. Nothing rendered them at all.
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[0].orbs = ['lightning', 'frost', null]
  const viewer = run.combat.players[0]
  viewer.miracles = 1
  viewer.energy = 2
  debug.setRun(run)
})
await page.getByRole('button', { name: 'Use Miracle (+1 Energy)' }).click()
const miracleSpent = await readState()
check('the local board can spend a Miracle for Energy', () => {
  assertEqual(miracleSpent.players[0].miracles, 0)
  assertEqual(miracleSpent.players[0].energy, 3)
})
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].orbs[0] === 'lightning')
const orbView = await page.evaluate(() => ({
  slots: document.querySelectorAll('.row--viewer .token--orb').length,
  beads: document.querySelectorAll('.row--viewer .token--orb:not(.token--orb-empty)').length,
  classes: [...document.querySelectorAll('.row--viewer .token--orb')].map((b) => b.className),
  sprites: [...document.querySelectorAll('.row--viewer .token--orb:not(.token--orb-empty)')]
    .map((orb) => getComputedStyle(orb, '::before').backgroundImage),
  values: [...document.querySelectorAll('.row--viewer .orb__value')].map((value) => value.textContent),
  floatsOverPortrait: Boolean(document.querySelector('.row--viewer .seat__interactive > .orbs')),
  label: document.querySelector('.seat--viewer')?.getAttribute('aria-label') ?? '',
}))
check('channelled orbs are visible on the seat', () => {
  assertEqual(orbView.slots, 2, 'non-Defect seats show occupied Orbs without empty capacity')
  assertEqual(orbView.beads, 2, 'one bead per channelled orb')
  // The per-type class is what colours them; without it all three orb kinds
  // render as the same bead and the board stops telling you which is which.
  assert(
    orbView.classes.some((name) => name.includes('token--orb-lightning')),
    `expected a lightning bead: ${orbView.classes.join(' | ')}`,
  )
  assert(
    orbView.classes.some((name) => name.includes('token--orb-frost')),
    `expected a frost bead: ${orbView.classes.join(' | ')}`,
  )
  assert(orbView.floatsOverPortrait, 'Orbs should float around the character portrait')
  assert(orbView.sprites.some((source) => source.includes('lightning-channel.webp')) &&
    orbView.sprites.some((source) => source.includes('frost-channel.webp')),
  `the painted Orb sprites did not render: ${orbView.sprites.join(' | ')}`)
  assertDeepEqual(orbView.values, ['1', '1'])
  assert(orbView.label.includes('lightning orb'), `and named to a screen reader: ${orbView.label}`)
  assert(orbView.label.includes('frost orb'), `both of them: ${orbView.label}`)
  assert(orbView.label.includes('1 damage at end of turn') && orbView.label.includes('1 Block at end of turn'),
    `Orb values are not exposed accessibly: ${orbView.label}`)
})
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[0].damageDealtZeroThisTurn = true
  debug.setRun(run)
})
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].damageDealtZeroThisTurn === true)
await page.evaluate(() => new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))))
const suppressedOrbValues = await page.locator('.row--viewer .orb__value').allTextContents()
const suppressedOrbLabel = await page.locator('.seat--viewer').getAttribute('aria-label')
check('Orb values follow effects that suppress damage this turn', () => {
  assertDeepEqual(suppressedOrbValues, ['0', '1'])
  assert(suppressedOrbLabel?.includes('0 damage at end of turn'), suppressedOrbLabel ?? 'missing seat label')
})

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[0].draw = [
    { uid: 'ui-draw-strike', defId: 'strike_ironclad', upgraded: false },
    { uid: 'ui-draw-strike-silent', defId: 'strike_silent', upgraded: false },
    { uid: 'ui-draw-defend', defId: 'defend_ironclad', upgraded: false },
    { uid: 'ui-draw-bash', defId: 'bash', upgraded: false },
  ]
  debug.setRun(run)
})
const drawPile = page.getByRole('button', { name: 'Draw pile, 4 cards' })
await drawPile.waitFor()
await drawPile.click()
const drawPileDialog = page.getByRole('dialog', { name: 'Draw pile' })
await drawPileDialog.waitFor()
const drawPileCards = await drawPileDialog.locator('.card').evaluateAll((cards) => cards.map((card) => ({
  title: card.getAttribute('data-card-name'),
  art: card.querySelector('img')?.getAttribute('src') ?? '',
})))
const drawPileTitles = drawPileCards.map(({ title }) => title)
const drawPileSortLabels = await drawPileDialog.locator('.card-collection__sort button').allTextContents()
check('the Draw pile opens the shared viewer as an unordered card set', () => {
  assertDeepEqual(drawPileTitles, ['Bash', 'Defend', 'Strike', 'Strike'])
  const duplicateStrikeSources = drawPileCards.filter(({ title }) => title === 'Strike').map(({ art }) => art)
  assert(duplicateStrikeSources[0]?.includes('/cards-sm/ironclad__'), duplicateStrikeSources.join(' | '))
  assert(duplicateStrikeSources[1]?.includes('/cards-sm/silent__'), duplicateStrikeSources.join(' | '))
  assert(!drawPileSortLabels.some((label) => label.includes('Obtained')), drawPileSortLabels.join(' | '))
})
await shot('06zj1-draw-pile')
await drawPileDialog.getByRole('button', { name: 'Back', exact: true }).click()
await page.setViewportSize({ width: 844, height: 390 })
await drawPile.click()
await drawPileDialog.waitFor()
const drawPilePhoneLayout = await drawPileDialog.evaluate((dialog) => {
  const panel = dialog.querySelector('.card-collection__sort')
  const dialogBox = dialog.getBoundingClientRect()
  const panelBox = panel?.getBoundingClientRect()
  const buttons = [...(panel?.querySelectorAll('button') ?? [])].map((button) => {
    const box = button.getBoundingClientRect()
    return { left: box.left, right: box.right }
  })
  return {
    dialogWithinViewport: dialogBox.left >= 0 && dialogBox.right <= innerWidth && dialogBox.top >= 0 && dialogBox.bottom <= innerHeight,
    sortWithinDialog: panelBox && panelBox.left >= dialogBox.left && panelBox.right <= dialogBox.right,
    buttonCount: buttons.length,
    buttonsWithinPanel: buttons.every(({ left, right }) => panelBox && left >= panelBox.left && right <= panelBox.right),
    columns: panel ? getComputedStyle(panel).gridTemplateColumns.split(' ').length : 0,
  }
})
check('the unordered Draw pile sort bar fits a horizontal phone', () => {
  assert(drawPilePhoneLayout.dialogWithinViewport, 'the Draw pile dialog spills outside the horizontal phone viewport')
  assert(drawPilePhoneLayout.sortWithinDialog, 'the Draw pile sort bar spills outside its dialog')
  assertEqual(drawPilePhoneLayout.buttonCount, 3)
  assert(drawPilePhoneLayout.buttonsWithinPanel, 'a Draw pile sort button spills outside the sort bar')
  assertEqual(drawPilePhoneLayout.columns, 3, 'the unordered sort bar kept an empty fourth column')
})
await drawPileDialog.getByRole('button', { name: 'Back', exact: true }).click()
await page.setViewportSize({ width: 1440, height: 900 })
await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), combatAppearanceRun)
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'player')

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[0].potions = ['cunning_potion', 'block_potion', 'fire_potion', 'explosive_potion']
  run.combat.players[0].shivs = 3
  run.combat.players[0].strength = 0
  run.combat.players[0].strengthLossAtEndOfTurn = 0
  run.combat.players[0].drawLocked = false
  run.combat.players[1].shivs = 2
  const fragile = run.combat.enemies.find((enemy) => !enemy.dead && !enemy.isBoss)
  const durable = run.combat.enemies.find((enemy) => !enemy.dead && enemy.uid !== fragile?.uid)
  if (!fragile || !durable) throw new Error('potion browser fixture needs two living enemies')
  for (const enemy of run.combat.enemies) {
    enemy.block = 0
    enemy.abilityUsed = true
    if (!enemy.dead) {
      enemy.hp = Math.max(enemy.hp, 10)
      enemy.maxHp = Math.max(enemy.maxHp, 10)
    }
  }
  Object.assign(fragile, { hp: 1, maxHp: 1 })
  Object.assign(durable, { hp: 11, maxHp: 11 })
  debug.setRun(run)
})
await page.waitForFunction(() => window.__STS_DEBUG__.getState().enemies.some((enemy) => !enemy.dead && enemy.hp === 1))
const combatPotionButton = page.locator('.combat__actions').getByRole('button', { name: /Cunning Potion/ })
const combatPotionDescriptionId = await combatPotionButton.getAttribute('aria-describedby')
const combatPotionDescription = await page.locator(`[id="${combatPotionDescriptionId}"]`).textContent()
const seatWithCunning = page.getByRole('button', { name: /Cunning Potion: Gain 3 Shivs/ })
const seatPotionIcon = seatWithCunning.locator('.seat__potions .potion-chip').first()
const seatPotionText = await seatWithCunning.locator('.seat__potions').textContent()
const seatPotionLabel = await seatWithCunning.getAttribute('aria-label')
await seatPotionIcon.hover()
const seatPotionTip = page.locator('.potion-tip').filter({ hasText: 'Cunning Potion' })
await seatPotionTip.waitFor()
const seatPotionTipBox = await seatPotionTip.boundingBox()
const visibleSeatPotionTips = await page.locator('.potion-tip').count()
check('seat-held Potions expose their effects and keep the tooltip inside the viewport', () => {
  assertEqual(seatPotionText, '', 'Potion names rendered beside their icons')
  assert(seatPotionLabel.includes('Cunning Potion: Gain 3 Shivs. Treat each Shiv as a separate 0 cost Attack.'))
  assert(seatPotionTipBox && seatPotionTipBox.x >= 0 && seatPotionTipBox.y >= 0)
  assert(seatPotionTipBox.x + seatPotionTipBox.width <= 1440)
  assert(seatPotionTipBox.y + seatPotionTipBox.height <= 900)
  assertEqual(visibleSeatPotionTips, 1, 'another focused Potion left an overlapping tooltip open')
})
await shot('05d-seat-potion-tooltip')
await page.keyboard.press('Escape')
await seatPotionTip.waitFor({ state: 'hidden' })
await page.mouse.move(0, 0)
await combatPotionButton.hover()
const combatPotionTip = page.locator('.potion-tip').filter({ hasText: 'Cunning Potion' })
await combatPotionTip.waitFor()
const combatPotionTipText = await combatPotionTip.textContent()
const combatPotionTipBox = await combatPotionTip.boundingBox()
await shot('05e-potion-tooltip')
assert(combatPotionTipBox, 'the Potion tooltip did not render a visible box')
await page.mouse.move(combatPotionTipBox.x + combatPotionTipBox.width / 2,
  combatPotionTipBox.y + combatPotionTipBox.height / 2)
await combatPotionTip.waitFor({ state: 'hidden' })
check('hovering a combat Potion icon shows its printed effect inside the viewport', () => {
  assertEqual(combatPotionDescription, 'Gain 3 Shivs. Treat each Shiv as a separate 0 cost Attack.')
  assert(combatPotionTipText.includes('Gain 3 Shivs. Treat each Shiv as a separate 0 cost Attack.'))
  assert(combatPotionTipBox && combatPotionTipBox.x >= 0 && combatPotionTipBox.y >= 0)
  assert(combatPotionTipBox.x + combatPotionTipBox.width <= 1440)
  assert(combatPotionTipBox.y + combatPotionTipBox.height <= 900)
})
await page.mouse.move(0, 0)
const cunningBefore = await readState()
const fragilePotionTarget = cunningBefore.enemies.find((enemy) => !enemy.dead && enemy.hp === 1)
const cunningTarget = cunningBefore.enemies.find((enemy) => !enemy.dead && enemy.hp === 11)
assert(fragilePotionTarget && cunningTarget, 'the browser potion playtest needs fragile and durable targets')
await page.locator('.combat__actions').getByRole('button', { name: /Cunning Potion/ }).click()
await page.waitForSelector('.enemy--targeted')
const fragilePotionButton = page.getByRole('button', { name: /1 of 1 hit points/ }).first()
  .locator('.enemy__hit-area')
const cunningTargetButton = page.getByRole('button', {
  name: new RegExp(`${cunningTarget.hp} of ${cunningTarget.maxHp} hit points`),
}).first().locator('.enemy__hit-area')
await fragilePotionButton.click()
await page.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('2/3'))
await fragilePotionButton.click()
await page.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('3/3'))
await cunningTargetButton.click()
await page.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('1/3'))
const invalidPotionTargets = await readState()
check('Cunning Potion keeps targeting open when a queued attack would hit a dead enemy', () => {
  assert(invalidPotionTargets.players[0].potions.includes('cunning_potion'))
  assertEqual(invalidPotionTargets.enemies.find((enemy) => enemy.uid === fragilePotionTarget.uid).hp, 1)
})
await cunningTargetButton.click()
await page.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('2/3'))
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[1].shivs = 0
  debug.setRun(run)
})
await page.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('1/1'))
await page.locator('.prompt').evaluate(async (element) => {
  await Promise.all(element.getAnimations().map((animation) => animation.finished))
})
await shot('05fa-cunning-potion-overflow')
await cunningTargetButton.click()
await page.waitForFunction(() => !window.__STS_DEBUG__.getState().players[0].potions.includes('cunning_potion'))
const cunningAfter = await readState()
check('Cunning Potion restarts overflow targeting when a teammate frees shared Shivs', () => {
  const after = cunningAfter.enemies.find((enemy) => enemy.uid === cunningTarget.uid)
  assertEqual(after.hp, cunningTarget.hp - 1)
  assertEqual(cunningAfter.players[0].shivs, 5, 'the full shared supply stays capped')
})
const blockBeforePotion = (await readState()).players[0].block
await page.locator('.combat__actions').getByRole('button', { name: /Block Potion/ }).click()
await page.waitForSelector('.seat--targetable')
await page.locator('.prompt').evaluate(async (element) => {
  await Promise.all(element.getAnimations().map((animation) => animation.finished))
})
await shot('05f-block-potion-targeting')
await page.locator('.enemy:not([disabled]) .enemy__hit-area').first().click()
const wrongBlockTarget = await readState()
check('a support potion ignores enemy clicks while waiting for a player', () => {
  assertEqual(wrongBlockTarget.players[0].block, blockBeforePotion)
  assert(wrongBlockTarget.players[0].potions.includes('block_potion'))
})
await page.locator('.seat--viewer').click()
const blockedByPotion = await readState()
check('a support potion chooses a player from the combat board', () => {
  assertEqual(blockedByPotion.players[0].block, blockBeforePotion + 2)
  assertEqual(blockedByPotion.players[0].potions.includes('block_potion'), false)
})
const durabilityBeforePotion = blockedByPotion.enemies.reduce((sum, enemy) => sum + enemy.hp + enemy.block, 0)
const fireTarget = blockedByPotion.enemies
  .filter((enemy) => !enemy.dead)
  .sort((a, b) => b.hp + b.block - a.hp - a.block)[0]
assert(fireTarget && fireTarget.hp + fireTarget.block >= 4,
  'the browser Fire Potion playtest needs a target that can take all 4 damage')
const fireSfxCombatId = await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.combatId = `${run.combat.combatId}-fire-sfx`
  run.combat.presentationEvents = []
  debug.setRun(run)
  return run.combat.combatId
})
await page.waitForFunction((combatId) => window.__STS_DEBUG__.getState().combatId === combatId, fireSfxCombatId)
const firePotionSoundsBefore = await page.evaluate(() => window.__SFX_DETAILS__.length)
await page.locator('.combat__actions').getByRole('button', { name: /Fire Potion/ }).click()
await page.waitForSelector('.enemy--targeted')
await page.locator('.prompt').evaluate(async (element) => {
  await Promise.all(element.getAnimations().map((animation) => animation.finished))
})
await shot('05g-potion-targeting')
await page.locator(
  `.enemy--targeted:not(:disabled)[aria-label*="${fireTarget.hp} of ${fireTarget.maxHp} hit points"]`,
).first().locator('.enemy__hit-area').click()
await page.waitForFunction(() => !window.__STS_DEBUG__.getState().players[0].potions.includes('fire_potion'))
await page.waitForTimeout(400)
const firedPotion = await readState()
const firePotionSounds = await page.evaluate((before) => window.__SFX_DETAILS__.slice(before), firePotionSoundsBefore)
check('a targeted potion waits for an enemy, then consumes itself', () => {
  const durability = firedPotion.enemies.reduce((sum, enemy) => sum + enemy.hp + enemy.block, 0)
  assertEqual(durability, durabilityBeforePotion - 4)
  assertEqual(firedPotion.players[0].potions.includes('fire_potion'), false)
})
check('an actual Potion use has one UI click plus its personal effect, without duplicate UI audio', () => {
  assertEqual(firePotionSounds.filter((sound) => !sound.cue && sound.path === '/assets/sfx/ui.ogg').length, 1)
  assertEqual(firePotionSounds.filter((sound) => sound.cue === 'potion:fire_potion').length, 2,
    `captured ${JSON.stringify(firePotionSounds)}`)
  assertEqual(firePotionSounds.filter((sound) =>
    sound.cue === 'potion:fire_potion' && sound.path === '/assets/sfx/ui.ogg').length, 0)
})

const explosiveTarget = firedPotion.enemies
  .filter((enemy) => !enemy.dead && !enemy.isBoss)
  .sort((a, b) => b.row - a.row)[0]
assert(explosiveTarget, 'the browser potion playtest needs one living row target')
await page.setViewportSize({ width: 1280, height: 800 })
const explosivePotionButton = page.locator('.combat__actions').getByRole('button', { name: /Explosive Potion/ })
await explosivePotionButton.focus()
await page.locator('.potion-tip').filter({ hasText: 'Explosive Potion' }).waitFor()
await page.keyboard.press('Enter')
// A row potion has no target of its own: any enemy in the chosen row anchors
// it, the same as clicking a `target: 'row'` card. The affordance to check on
// a compact viewport is therefore every LIVING enemy's own card, not a
// separate row button.
await page.waitForSelector('.enemy--targeted')
const compactRowTargets = page.locator('.enemy--targeted')
const compactRowTargetGeometry = await compactRowTargets.evaluateAll((targets) => ({
  sizes: targets.map((target) => {
    const box = target.getBoundingClientRect()
    return { width: box.width, height: box.height }
  }),
}))
const compactRowTargetReachability = []
for (const target of await compactRowTargets.all()) {
  await target.scrollIntoViewIfNeeded()
  compactRowTargetReachability.push(await target.evaluate((button) => {
    const board = button.closest('.board').getBoundingClientRect()
    const box = button.getBoundingClientRect()
    return box.left >= board.left - 1 && box.right <= board.right + 1
  }))
}
check('two-player compact desktop row targets remain reachable, laid out with their lanes', () => {
  assert(compactRowTargetGeometry.sizes.every((size) => size.width >= 44 && size.height >= 44),
    `row target below 44px: ${JSON.stringify(compactRowTargetGeometry.sizes)}`)
  assert(compactRowTargetReachability.every(Boolean), 'a row target cannot be scrolled fully into the board viewport')
})
await page.locator('.prompt').evaluate(async (element) => {
  await Promise.all(element.getAnimations().map((animation) => animation.finished))
})
const activatedExplosivePotionTips = await page.locator('.potion-tip').count()
check('activating a Potion dismisses its tooltip before row targeting', () => {
  assertEqual(activatedExplosivePotionTips, 0)
})
await shot('05h-explosive-potion-row-targeting')
await page.locator(`.enemy[data-enemy-id="${explosiveTarget.uid}"] .enemy__hit-area`).click()
await page.waitForFunction(() =>
  !window.__STS_DEBUG__.getState().players[0].potions.includes('explosive_potion'))
const explodedPotion = await readState()
await page.setViewportSize({ width: 1440, height: 900 })
check('Explosive Potion damages the chosen row and any boss, but no other row', () => {
  for (const [index, before] of firedPotion.enemies.entries()) {
    const after = explodedPotion.enemies[index]
    const shouldTakeDamage = !before.dead && (before.row === explosiveTarget.row || before.isBoss)
    assertEqual(after.hp, shouldTakeDamage ? Math.max(0, before.hp - 2) : before.hp)
  }
  assertEqual(explodedPotion.players[0].potions.includes('explosive_potion'), false)
})

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[0].dead = true
  run.combat.players[0].potions = ['energy_potion']
  debug.setRun(run)
})
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].dead === true)
const deadPotionControls = await page.locator('.combat__actions').getByRole('button', { name: /Energy Potion/ }).count()
const deadPotionIcons = await page.locator('.seat--viewer .seat__potions .potion-chip').count()
const deadSeatLabel = await page.locator('.seat--viewer').getAttribute('aria-label')
check('a dead seat keeps public potion information but gets no Player Turn controls', () => {
  assertEqual(deadPotionControls, 0)
  assertEqual(deadPotionIcons, 1)
  assert(deadSeatLabel.includes('Energy Potion: Gain 2 Energy.'))
})
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[0].dead = false
  run.combat.players[0].potions = []
  debug.setRun(run)
})
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].dead === false)

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[0].strength = 8
  run.combat.players[0].strengthLossAtEndOfTurn = 0
  run.combat.players[0].potions = ['flex_potion']
  debug.setRun(run)
})
await page.locator('.combat__actions').getByRole('button', { name: /Flex Potion/ }).click()
const cappedFlex = await readState()
const cappedFlexReminder = await page.locator('.seat--viewer .seat__pending').textContent()
const cappedFlexSeatName = await page.locator('.seat--viewer').getAttribute('aria-label')
check('capped Flex shows its pending end-of-turn Strength loss', () => {
  assertEqual(cappedFlex.players[0].strength, 8)
  assertEqual(cappedFlex.players[0].strengthLossAtEndOfTurn, 1)
  assert(cappedFlexReminder.includes('−1 Strength at end of turn'))
  assert(cappedFlexSeatName.includes('Strength loss at end of turn 1'))
})
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[0].strength = 0
  run.combat.players[0].strengthLossAtEndOfTurn = 0
  run.combat.players[0].potions = []
  debug.setRun(run)
})
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].strength === 0)

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const viewer = run.combat.players[0]
  viewer.hand = [{ uid: 'miracle-defend', defId: 'defend_ironclad', upgraded: false }]
  viewer.energy = 6
  viewer.miracles = 1
  viewer.shivs = 1
  viewer.weak = 0
  for (const enemy of run.combat.enemies) {
    enemy.block = 0
    enemy.vulnerable = 0
    // This probe measures one Shiv, not a first-damage special ability.
    enemy.abilityUsed = true
  }
  debug.setRun(run)
})
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].energy === 6)
await page.getByRole('button', { name: 'Use Miracle on next card' }).click()
const miracleToggle = await page.getByRole('button', { name: /Use Miracle on next card/ }).getAttribute('aria-pressed')
await page.locator('.hand .card').click()
const cappedMiracle = await readState()
check('a capped Miracle can be spent atomically on the next card', () => {
  assertEqual(miracleToggle, 'true', 'the pending Miracle payment is not exposed as pressed')
  assertEqual(cappedMiracle.players[0].miracles, 0)
  assertEqual(cappedMiracle.players[0].energy, 6, 'Defend immediately consumes the temporary seventh Energy')
})

const durabilityBeforeShiv = cappedMiracle.enemies.reduce((sum, enemy) => sum + enemy.hp + enemy.block, 0)
await page.getByRole('button', { name: 'Use Shiv' }).click()
await page.waitForSelector('.enemy--targeted')
await page.locator('.enemy:not([disabled]) .enemy__hit-area').first().click()
const shivSpent = await readState()
check('the local board can aim and spend a Shiv', () => {
  assertEqual(shivSpent.players[0].shivs, 0)
  const durability = shivSpent.enemies.reduce((sum, enemy) => sum + enemy.hp + enemy.block, 0)
  assertEqual(durability, durabilityBeforeShiv - 1)
})

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[0].hand = [{ uid: 'overflow-dance', defId: 'blade_dance', upgraded: false }]
  run.combat.players[0].energy = 3
  run.combat.players[0].shivs = 4
  run.combat.players[1].shivs = 1
  Object.assign(run.combat.enemies[0], { hp: 1, maxHp: 1, block: 0, dead: false })
  Object.assign(run.combat.enemies[1], { hp: 5, maxHp: 5, block: 0, dead: false })
  debug.setRun(run)
})
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hand[0]?.uid === 'overflow-dance')
await page.locator('.hand .card').click()
await page.getByRole('button', { name: /1 of 1 hit points/ }).locator('.enemy__hit-area').click()
await page.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('2/2'))
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[1].shivs = 0
  debug.setRun(run)
})
await page.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('1/1'))
const changedCardSupply = await readState()
check('a gain-Shiv card restarts targeting when the shared supply changes', () => {
  assertEqual(changedCardSupply.players[0].hand[0]?.uid, 'overflow-dance')
  assertEqual(changedCardSupply.enemies[0].hp, 1)
})
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[1].shivs = 1
  debug.setRun(run)
})
await page.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('1/2'))
await page.getByRole('button', { name: /1 of 1 hit points/ }).locator('.enemy__hit-area').click()
await page.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('2/2'))
await page.getByRole('button', { name: /1 of 1 hit points/ }).locator('.enemy__hit-area').click()
await page.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('1/2'))
const refusedCardOverflow = await readState()
check('a card keeps targeting open when a queued Shiv would hit a dead enemy', () => {
  assertEqual(refusedCardOverflow.players[0].hand[0]?.uid, 'overflow-dance')
  assertEqual(refusedCardOverflow.enemies[0].hp, 1)
  assertEqual(refusedCardOverflow.enemies[1].hp, 5)
})
await page.getByRole('button', { name: /1 of 1 hit points/ }).locator('.enemy__hit-area').click()
await page.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('2/2'))
await page.getByRole('button', { name: /5 of 5 hit points/ }).locator('.enemy__hit-area').click()
const splitOverflow = await readState()
check('overflow Shivs choose independent targets', () => {
  assert(splitOverflow.enemies[0].dead, 'the first overflow Shiv should finish its target')
  assertEqual(splitOverflow.enemies[1].hp, 4, 'the second overflow Shiv should hit another target')
})
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[0].orbs = [null, null, null]
  debug.setRun(run)
})
await page.waitForFunction(() => !document.querySelector('.character-attack'))

const idleMotion = await page.evaluate(() => {
  const seatPortrait = document.querySelector('.seat:not(.seat--dead) .seat__portrait')
  const enemyPortrait = document.querySelector('.enemy:not(.enemy--dead) .enemy__portrait')
  const seatArt = seatPortrait?.querySelector('img')
  const enemyArt = enemyPortrait?.querySelector('.enemy__art--cutout')
  const power = document.createElement('span')
  power.className = 'power'
  document.body.append(power)
  const powerGlowAnimation = getComputedStyle(power, '::after').animationName
  power.remove()
  return {
    seat: seatArt ? getComputedStyle(seatArt).animationName : '',
    enemy: enemyArt ? getComputedStyle(enemyArt).animationName : '',
    seatMotes: seatPortrait ? getComputedStyle(seatPortrait, '::before').backgroundImage : '',
    enemyMotes: enemyPortrait ? getComputedStyle(enemyPortrait, '::before').backgroundImage : '',
    seatMotesAnimation: seatPortrait ? getComputedStyle(seatPortrait, '::before').animationName : '',
    enemyMotesAnimation: enemyPortrait ? getComputedStyle(enemyPortrait, '::before').animationName : '',
    powerGlowAnimation,
  }
})
check('combat stays still between actions', () => {
  assertEqual(idleMotion.seat, 'none')
  assertEqual(idleMotion.enemy, 'none')
  assert(idleMotion.seatMotes.includes('/assets/combat/vfx/hero-motes.webp'), idleMotion.seatMotes)
  assert(idleMotion.enemyMotes.includes('/assets/combat/vfx/enemy-motes.webp'), idleMotion.enemyMotes)
  assertEqual(idleMotion.seatMotesAnimation, 'none')
  assertEqual(idleMotion.enemyMotesAnimation, 'none')
  assertEqual(idleMotion.powerGlowAnimation, 'none')
})
const hoverEnemy = page.locator('.enemy:not(:disabled)').first()
await hoverEnemy.locator('.enemy__hit-area').hover()
await hoverEnemy.locator('.enemy__art--cutout').evaluate((art) =>
  Promise.all(art.getAnimations().map((animation) => animation.finished)))
const hoverScale = await hoverEnemy.locator('.enemy__art--cutout').evaluate((art) =>
  new DOMMatrix(getComputedStyle(art).transform).a)
check('enemy hover stays still between actions', () => {
  assertEqual(hoverScale, 1)
})

// The enemy's remaining hit points are the number the whole turn is planned
// around. Twice it fell below the fold at small sizes because the board was
// sized by reasoning rather than measurement, so this measures.
//
// From a clean one-player board: this is about how the board is SIZED, and by
// this point in the suite the seat carries injected Powers and tokens that
// make the row taller for unrelated reasons.
await page.evaluate(() => window.__STS_DEBUG__.reset(1, 'fold'))
await bypassNeow()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().players.length === 1)
await enterFirstRoom()
const foldProbe = []
for (const size of [
  { width: 900, height: 620 },
  { width: 1440, height: 900 },
]) {
  await page.setViewportSize(size)
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  foldProbe.push(
    await page.evaluate((label) => {
      const board = document.querySelector('.board')
      const bar = document.querySelector('.enemy .bar')
      if (!board || !bar) return { label, missing: true }
      const b = board.getBoundingClientRect()
      const r = bar.getBoundingClientRect()
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return {
        label,
        missing: false,
        inside: r.top >= b.top - 1 && r.bottom <= b.bottom + 1,
        // Inside the board is not enough: the board itself can sit partly off
        // the page, so the viewport is the thing that decides whether a player
        // can actually see the number.
        onScreen: r.top >= 0 && r.bottom <= window.innerHeight,
        onTop: !!hit?.closest('.bar'),
        hit: hit ? `${hit.tagName}.${hit.className}` : 'nothing',
      }
    }, `${size.width}x${size.height}`),
  )
}
await page.setViewportSize({ width: 1440, height: 900 })
check("an enemy's hit points are on screen without scrolling at desktop sizes", () => {
  for (const probe of foldProbe) {
    assert(!probe.missing, `${probe.label}: no enemy bar found`)
    assert(probe.inside, `${probe.label}: the bar is outside the board's visible box`)
    assert(probe.onScreen, `${probe.label}: the bar is off the viewport entirely`)
    assert(probe.onTop, `${probe.label}: the bar is covered by ${probe.hit}`)
  }
})

// And during the round-end pause, where the log opens up and used to squeeze
// the board until the bar was sliced — exactly when the pause asks you to read
// the board.
//
// From a clean board on purpose: this is about the LOG's effect on the board,
// and by this point in the suite the seat carries injected Powers and tokens
// that make the row taller for reasons that have nothing to do with the log.
await page.evaluate(() => window.__STS_DEBUG__.reset(1, 'pause'))
await bypassNeow()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().players.length === 1)
await enterFirstRoom()
await endTurn()
await waitForAutomaticEnemyResolution()
const pauseProbe = []
for (const size of [
  { width: 900, height: 620 },
  { width: 1440, height: 900 },
]) {
  await page.setViewportSize(size)
  pauseProbe.push(
    await page.evaluate((label) => {
      const board = document.querySelector('.board')
      const bar = document.querySelector('.enemy .bar')
      if (!board || !bar) return { label, missing: true }
      const b = board.getBoundingClientRect()
      const r = bar.getBoundingClientRect()
      return {
        label,
        missing: false,
        inside: r.top >= b.top - 1 && r.bottom <= b.bottom + 1,
        onScreen: r.top >= 0 && r.bottom <= window.innerHeight,
      }
    }, `${size.width}x${size.height}`),
  )
}
await page.setViewportSize({ width: 1440, height: 900 })
// And on the FOUR-player board, where the rows are tightest and the portrait
// squash rules apply. Both fold probes ran only on the two-player board, so
// the squash could be deleted with everything green.
await page.evaluate(() => window.__STS_DEBUG__.reset(4, 'fold-four'))
await bypassNeow()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().players.length === 4)
await enterFirstRoom()
const crowdedState = await readState()
const crowdedEnemyCount = crowdedState.enemies.length
const crowdedViewerRow = crowdedState.players[0].row
const crowdedViewerEnemyCount = crowdedState.enemies
  .filter((enemy) => !enemy.isBoss && enemy.row === crowdedViewerRow).length
const crowdedProbe = []
// The whole four-row board scrolls, but the row you control — including every
// summon in it — must fit at each supported size.
for (const size of [
  { width: 900, height: 620 },
  { width: 1440, height: 900 },
]) {
  await page.setViewportSize(size)
  // The board scrolls the viewer's row into view on resize; give it a frame.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  crowdedProbe.push(
    await page.evaluate((label) => {
      const bars = [...document.querySelectorAll('.enemy .bar')]
      const board = document.querySelector('.board')
      if (!board || bars.length === 0) return { label, missing: true }
      const b = board.getBoundingClientRect()
      // The row the viewer controls is the one scrolled into view, so its
      // main enemy AND every summon must be readable at once.
      const own = [...document.querySelectorAll('.row--viewer .enemy .bar')]
      const rects = own.map((bar) => bar.getBoundingClientRect())
      return {
        label,
        missing: false,
        rows: bars.length,
        own: own.length,
        inside: rects.every((r) => r.top >= b.top - 1 && r.bottom <= b.bottom + 1),
        onScreen: rects.every((r) => r.top >= 0 && r.bottom <= window.innerHeight),
      }
    }, `4p ${size.width}x${size.height}`),
  )
}
await page.setViewportSize({ width: 1440, height: 900 })

check("a four-player board still shows the viewer's own enemy", () => {
  for (const probe of crowdedProbe) {
    assert(!probe.missing, `${probe.label}: no enemy bar found`)
    assertEqual(probe.rows, crowdedEnemyCount, `${probe.label}: every main enemy and summon is visible`)
    assertEqual(probe.own, crowdedViewerEnemyCount, `${probe.label}: viewer-row summon count`)
    assert(probe.inside, `${probe.label}: the bar is outside the board's visible box`)
    assert(probe.onScreen, `${probe.label}: the bar is off the viewport entirely`)
  }
})

check("an enemy's hit points stay on screen during the round-end pause", () => {
  for (const probe of pauseProbe) {
    assert(!probe.missing, `${probe.label}: no enemy bar found`)
    assert(probe.inside, `${probe.label}: the log squeezed the bar out of the board`)
    assert(probe.onScreen, `${probe.label}: the bar is off the viewport entirely`)
  }
})

// A dead enemy must stop telegraphing and stop announcing tokens: a corpse
// showing an attack it will never make is misleading while choosing a target.
const corpse = await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const foe = run.combat.enemies[0]
  foe.hp = 0
  foe.dead = true
  foe.poison = 3
  foe.block = 2
  debug.setRun(run)
  return foe.uid
})
await page.waitForFunction(() => window.__STS_DEBUG__.getState().enemies[0].dead)
await page.evaluate(() => {
  for (const animation of document.getAnimations()) {
    if (['enemy-clear', 'enemy-disintegrate', 'enemy-dissolve', 'enemy-death-ash', 'death-ring'].includes(animation.animationName) &&
      Number(animation.currentTime) < 250) {
      animation.currentTime = 380
      animation.pause()
    }
  }
})
await shot('09c-enemy-defeat-animation')
await page.evaluate(() => {
  for (const animation of document.getAnimations()) {
    if (['enemy-clear', 'enemy-disintegrate', 'enemy-dissolve', 'enemy-death-ash', 'death-ring'].includes(animation.animationName) &&
      animation.playState === 'paused') animation.play()
  }
})
const corpseView = await page.evaluate(() => {
  const tile = document.querySelector('.enemy--dead')
  const portrait = tile?.querySelector('.enemy__portrait')
  return {
    found: tile != null,
    intents: tile?.querySelectorAll('.intent').length ?? -1,
    tokens: tile?.querySelectorAll('.token').length ?? -1,
    disabled: tile?.disabled ?? false,
    label: tile?.getAttribute('aria-label') ?? '',
    deathAnimation: portrait ? getComputedStyle(portrait).animationName : '',
    ash: portrait ? getComputedStyle(portrait, '::before').backgroundImage : '',
    ring: portrait ? getComputedStyle(portrait, '::after').backgroundImage : '',
  }
})
check('a defeated enemy stops telegraphing and stops carrying tokens', () => {
  assert(corpseView.found, `expected a defeated enemy on the board (${corpse})`)
  assertEqual(corpseView.intents, 0, 'a corpse has no intent')
  assertEqual(corpseView.tokens, 0, 'and no tokens')
  assert(corpseView.disabled, 'and cannot be clicked')
  assert(corpseView.label.includes('defeated'), `and says so: ${corpseView.label}`)
  assertEqual(corpseView.deathAnimation, 'enemy-disintegrate', 'and plays its defeat animation')
  assert(corpseView.ash.includes('/assets/combat/vfx/death-ash.webp'), corpseView.ash)
  assert(corpseView.ring.includes('/assets/combat/vfx/death-ring.webp'), corpseView.ring)
})

await page.locator(`.enemy[data-enemy-id="${corpse}"]`).waitFor({ state: 'detached' })
const clearedEnemyCount = await page.locator(`.enemy[data-enemy-id="${corpse}"]`).count()
check('a defeated enemy releases its stage slot after dissolving', () => {
  assertEqual(clearedEnemyCount, 0)
})

// A reconnect remounts the combat with its authoritative dead actors, but
// settled corpses neither replay old deaths nor occupy stage slots.
const restoredCombat = await readRun()
await page.evaluate((run) => window.__STS_DEBUG__.setRun({ ...run, phase: 'map' }), restoredCombat)
await page.waitForFunction(() => !document.querySelector('.board'))
await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), restoredCombat)
await page.locator('.board').waitFor()
const restoredCorpses = await page.locator('.enemy--dead').count()
check('restored and reconnected corpses stay out of the stage layout', () => {
  assertEqual(restoredCorpses, 0)
})

// A summoning Boss keeps dead pieces in authoritative state for effects such
// as Regrow, but those pieces must stop consuming stage positions. The real
// insertion order is B, C, D, E, Boss; filtering settled B/C should put D/E in
// the exact same two visual slots.
const slotReuseRestore = await readRun()
const slotFixture = await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const template = run.combat.enemies[0]
  const row = run.combat.players[0].row
  const enemy = (uid, defId, isBoss = false) => ({
    ...structuredClone(template), uid, defId, row, isBoss, hp: 5, maxHp: 5,
    dead: false, block: 0, strength: 0, vulnerable: 0, weak: 0, poison: 0,
    actionIndex: 0, phase: 0, abilityUsed: false,
  })
  run.combat.enemies = [
    enemy('slot-summon-b', 'cultist'),
    enemy('slot-summon-c', 'jaw_worm'),
    enemy('slot-boss-a', 'slime_boss', true),
  ]
  debug.setRun(run)
  return { b: 'slot-summon-b', c: 'slot-summon-c', d: 'slot-summon-d', e: 'slot-summon-e' }
})
await page.waitForFunction(({ b, c }) =>
  document.querySelector(`[data-enemy-id="${b}"]`) && document.querySelector(`[data-enemy-id="${c}"]`), slotFixture)
await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
const oldSummonSlots = await page.evaluate(({ b, c }) => [b, c].map((id) =>
  document.querySelector(`[data-enemy-id="${id}"]`).getBoundingClientRect().left), slotFixture)
await page.evaluate(({ b, c }) => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  for (const enemy of run.combat.enemies) if (enemy.uid === b || enemy.uid === c) {
    enemy.hp = 0
    enemy.dead = true
  }
  debug.setRun(run)
}, slotFixture)
await page.waitForFunction(({ b, c }) => [b, c].every((id) =>
  document.querySelector(`[data-enemy-id="${id}"]`)?.classList.contains('enemy--falling')), slotFixture)
await Promise.all([slotFixture.b, slotFixture.c].map((id) =>
  page.locator(`[data-enemy-id="${id}"]`).waitFor({ state: 'detached' })))
await page.evaluate(({ b, c, d, e }) => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const deadB = run.combat.enemies.find((enemy) => enemy.uid === b)
  const deadC = run.combat.enemies.find((enemy) => enemy.uid === c)
  const bossIndex = run.combat.enemies.findIndex((enemy) => enemy.isBoss)
  run.combat.enemies.splice(bossIndex, 0,
    { ...structuredClone(deadB), uid: d, hp: 5, dead: false },
    { ...structuredClone(deadC), uid: e, hp: 5, dead: false })
  debug.setRun(run)
}, slotFixture)
await page.waitForFunction(({ d, e }) =>
  document.querySelector(`[data-enemy-id="${d}"]`) && document.querySelector(`[data-enemy-id="${e}"]`), slotFixture)
await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
const reusedSummonSlots = await page.evaluate(({ d, e }) => [d, e].map((id) =>
  document.querySelector(`[data-enemy-id="${id}"]`).getBoundingClientRect().left), slotFixture)
const retainedDeadSummons = await page.evaluate(({ b, c }) => {
  const enemies = window.__STS_DEBUG__.getState().enemies
  return [b, c].every((id) => enemies.some((enemy) => enemy.uid === id && enemy.dead))
}, slotFixture)
check('later Boss summons reuse the cleared positions of dead summons', () => {
  assert(retainedDeadSummons, 'slot cleanup mutated authoritative corpses needed by revive rules')
  assertDeepEqual(reusedSummonSlots.map((left, index) => Math.abs(left - oldSummonSlots[index]) < 1), [true, true],
    `old ${oldSummonSlots.join(', ')}; reused ${reusedSummonSlots.join(', ')}`)
})
await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), slotReuseRestore)

// A cost the hand cannot fully pay must still be committable — the engine
// accepts it, and the UI used to demand the printed count and strand the card.
const lastCard = await page.evaluate(async () => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const me = run.combat.players[0]
  me.hand = [{ uid: 'solo-survivor', defId: 'survivor', upgraded: false }]
  me.energy = 3
  me.block = 0
  debug.setRun(run)
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  document.querySelector('.hand .card')?.click()
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  const state = window.__STS_DEBUG__.getState()
  return { block: state.players[0].block, hand: state.players[0].hand.length }
})
check('a card whose cost the hand cannot pay is still playable', () => {
  assertEqual(lastCard.hand, 0, 'the card left the hand')
  assert(lastCard.block > 0, `and it resolved, giving Block (got ${lastCard.block})`)
})

// Orb cards may be played for no effect when there is nothing to Evoke.
const emptyEvoke = await page.evaluate(async () => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const me = run.combat.players[0]
  me.hand = [{ uid: 'solo-dual', defId: 'dual_cast', upgraded: false }]
  me.orbs = [null, null, null]
  me.energy = 3
  debug.setRun(run)
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  const dualDisabled = document.querySelector('.hand .card')?.getAttribute('aria-disabled') === 'true'
  me.hand = [{ uid: 'solo-recursion', defId: 'recursion', upgraded: false }]
  debug.setRun(structuredClone(run))
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  const recursionDisabled = document.querySelector('.hand .card')?.getAttribute('aria-disabled') === 'true'
  me.hand = [{ uid: 'solo-chaos', defId: 'chaos', upgraded: false }]
  debug.setRun(structuredClone(run))
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  const chaosLabel = document.querySelector('.hand .card')?.getAttribute('aria-label') ?? ''
  return { dualDisabled, recursionDisabled, chaosLabel }
})
check('no-effect Orb cards remain playable and Chaos announces its die mapping', () => {
  assert(!emptyEvoke.dualDisabled, 'Dual Cast with no Orbs should remain playable')
  assert(!emptyEvoke.recursionDisabled, 'Recursion with no Orbs should remain playable')
  assert(emptyEvoke.chaosLabel.includes('Lightning on die 1 or 2') &&
    emptyEvoke.chaosLabel.includes('Frost on 3 or 4') && emptyEvoke.chaosLabel.includes('Dark on 5 or 6'),
  'Chaos should announce its full die mapping')
})

// A row card and a single-target card are the same interaction -- click one
// enemy -- so without a mark on the card and a word in the prompt, nothing
// tells the player that Cleave hits the crowd and Strike does not.
const aoeAffordance = await page.evaluate(async () => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const me = run.combat.players[0]
  me.hand = [
    { uid: 'aoe-cleave', defId: 'cleave', upgraded: false },
    { uid: 'aoe-strike', defId: 'strike_ironclad', upgraded: false },
  ]
  me.energy = 3
  debug.setRun(run)
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  await Promise.allSettled([...document.querySelectorAll('.hand .card--drawn')]
    .flatMap((card) => card.getAnimations().map((animation) => animation.finished)))

  const cards = [...document.querySelectorAll('.hand .card')]
  const badges = cards.map((card) => card.querySelector('.card__aoe') !== null)
  const names = cards.map((card) => card.getAttribute('aria-label') ?? '')
  // A bounding box and `visibility` are not enough on their own: the Icon
  // renders <img width=18 height=18>, so the box is 18x18 even if the file
  // 404s, and both `opacity: 0` and a badge parked off-screen keep a box of
  // that size. So walk up to the card accumulating opacity, and require the
  // badge to sit INSIDE the card it belongs to.
  const painted = cards.map((card) => {
    const badge = card.querySelector('.card__aoe img')
    if (!badge) return null
    const box = badge.getBoundingClientRect()
    const cardBox = card.getBoundingClientRect()
    let opacity = 1
    for (let node = badge; node && node !== document.body; node = node.parentElement) {
      const style = getComputedStyle(node)
      if (style.visibility === 'hidden' || style.display === 'none') return false
      opacity *= Number(style.opacity)
    }
    return (
      box.width > 0 &&
      box.height > 0 &&
      opacity > 0.1 &&
      box.left >= cardBox.left - 1 &&
      box.right <= cardBox.right + 1 &&
      box.top >= cardBox.top - 1 &&
      box.bottom <= cardBox.bottom + 1
    )
  })

  // Stage the row card and read the prompt it asks the player for.
  cards[0].click()
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  const rowPrompt = document.querySelector('.prompt')?.textContent ?? ''

  // And the single-target card, so the prompt is pinned in BOTH directions --
  // `hitsRow` is its own code path in CombatScreen, not the one the badge uses,
  // so a version that claimed every card takes a row would pass otherwise.
  document.querySelectorAll('.hand .card')[1]?.click()
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  const singlePrompt = document.querySelector('.prompt')?.textContent ?? ''

  return { badges, names, painted, rowPrompt, singlePrompt }
})
check('a card that takes a whole row says so', () => {
  assert(aoeAffordance.badges[0], 'Cleave should carry the area-of-effect burst')
  assert(!aoeAffordance.badges[1], 'a single-target Strike should not')
  assert(
    aoeAffordance.painted[0] === true,
    'and the burst must actually be painted, not merely present in the markup',
  )
  assert(
    /affects a whole row and any boss/.test(aoeAffordance.names[0]),
    `the card's accessible name should carry the reach: "${aoeAffordance.names[0]}"`,
  )
  assert(
    !/affects a whole row/.test(aoeAffordance.names[1]),
    `and a single-target card should not claim it: "${aoeAffordance.names[1]}"`,
  )
  assert(
    /whole row/.test(aoeAffordance.rowPrompt),
    `the prompt should say the row is hit, got "${aoeAffordance.rowPrompt}"`,
  )
  assert(
    !/whole row/.test(aoeAffordance.singlePrompt),
    `a single-target card must not claim a row, got "${aoeAffordance.singlePrompt}"`,
  )
})

// The face is a scan, so the printed text is an image nobody's screen reader
// will ever read. The accessible name is the only card text some players get.
const exhaustName = await page.evaluate(async () => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[0].hand = [{ uid: 'ex-1', defId: 'poisoned_stab', upgraded: false }]
  run.combat.players[0].energy = 3
  debug.setRun(run)
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  return document.querySelector('.hand .card')?.getAttribute('aria-label') ?? ''
})
check('a card that spends itself says so too', () => {
  assert(
    /exhausts when played/.test(exhaustName),
    `Poisoned Stab exhausts and should announce it: "${exhaustName}"`,
  )
})

// The hand is fanned, not stacked: each card tilted by its distance from the
// middle. Zeroing the angle and the lift left a flat row and passed everything.
// Its own hand, because the check above deliberately leaves one card.
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[0].hand = Array.from({ length: 5 }, (_unused, i) => ({
    uid: `fan-${i}`,
    defId: 'strike_ironclad',
    upgraded: false,
  }))
  debug.setRun(run)
})
await page.waitForFunction(() => document.querySelectorAll('.hand .card').length === 5)
await page.locator('.hand .card--drawn').first().waitFor()
await page.waitForFunction(() => !document.querySelector('.hand .card--drawn'))
const fanShape = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('.hand .card')]
  if (cards.length < 3) return { few: true }
  const matrix = (card) => getComputedStyle(card).transform
  return {
    few: false,
    count: cards.length,
    first: matrix(cards[0]),
    middle: matrix(cards[Math.floor(cards.length / 2)]),
    last: matrix(cards[cards.length - 1]),
  }
})
check('the hand is fanned rather than laid flat', () => {
  assert(!fanShape.few, 'need at least three cards to see a fan')
  assert(fanShape.first !== 'none', 'the outer cards should be transformed')
  assert(
    fanShape.first !== fanShape.last,
    `the two ends of the fan should tilt opposite ways, both are ${fanShape.first}`,
  )
  assert(
    fanShape.first !== fanShape.middle,
    'the middle card should sit straighter than the ends',
  )
})

// The telegraph belongs ABOVE the creature, the way the video game shows it.
// Its position comes from the markup order, so swapping the two spans back
// would silently undo it.
const intentPlace = await page.evaluate(() => {
  const enemy = document.querySelector('.enemy')
  const intent = enemy?.querySelector('.enemy__intent')
  const portrait = enemy?.querySelector('.enemy__portrait')
  if (!intent || !portrait) return { missing: true }
  return {
    missing: false,
    intentBottom: Math.round(intent.getBoundingClientRect().bottom),
    portraitTop: Math.round(portrait.getBoundingClientRect().top),
  }
})
check('an enemy telegraphs above itself', () => {
  assert(!intentPlace.missing, 'expected an enemy with an intent')
  assert(
    intentPlace.intentBottom <= intentPlace.portraitTop + 1,
    `the intent sits below the portrait (${intentPlace.intentBottom} vs ${intentPlace.portraitTop})`,
  )
})

const brokenHudIcons = await page.locator('.combat img.icon').evaluateAll((icons) =>
  icons.filter((icon) => !icon.complete || icon.naturalWidth === 0).map((icon) => icon.getAttribute('src')),
)
check('combat HUD icons have bundled fallbacks when rulebook icons are not synced', () => {
  assertDeepEqual(brokenHudIcons, [])
})

const energyReadability = await page.evaluate(() => {
  const pip = document.querySelector('.pip--energy')
  const number = pip?.querySelector('.icon-value__number')
  if (!pip || !number) return { missing: true }
  const pipBox = pip.getBoundingClientRect()
  const numberBox = number.getBoundingClientRect()
  const style = getComputedStyle(number)
  return {
    missing: false,
    strokeWidth: parseFloat(style.getPropertyValue('-webkit-text-stroke-width')),
    shadow: style.textShadow,
    centerOffset: Math.hypot(
      (numberBox.left + numberBox.right - pipBox.left - pipBox.right) / 2,
      (numberBox.top + numberBox.bottom - pipBox.top - pipBox.bottom) / 2,
    ),
    contained: numberBox.left >= pipBox.left && numberBox.right <= pipBox.right &&
      numberBox.top >= pipBox.top && numberBox.bottom <= pipBox.bottom,
  }
})
check('the energy count stays outlined, centred, and unclipped', () => {
  assert(!energyReadability.missing, 'expected an energy pip')
  assert(energyReadability.strokeWidth >= 1, 'the count needs a dark outline over moving liquid')
  assert(energyReadability.shadow !== 'none', 'the count needs a shadow over bright liquid')
  assert(energyReadability.contained, 'the energy count is clipped by its orb')
  assert(energyReadability.centerOffset <= 1,
    `the energy count is ${energyReadability.centerOffset}px off-centre`)
})

const energyOrbVariants = []
for (const character of ['ironclad', 'silent', 'defect', 'watcher']) {
  await page.evaluate((nextCharacter) => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    for (const player of run.combat.players) player.character = nextCharacter
    debug.setRun(run)
  }, character)
  await page.waitForFunction((nextCharacter) =>
    document.querySelector('.pip--energy')?.dataset.character === nextCharacter, character)
  energyOrbVariants.push(await page.locator('.pip--energy').evaluate((pip) => ({
    character: pip.dataset.character,
    shape: getComputedStyle(pip).clipPath,
    liquid: getComputedStyle(pip, '::before').backgroundImage,
    flow: getComputedStyle(pip, '::after').backgroundImage,
    animation: getComputedStyle(pip, '::after').animationName,
  })))
}
check('each character has a distinct static energy orb', () => {
  assertDeepEqual(energyOrbVariants.map(({ character }) => character), ['ironclad', 'silent', 'defect', 'watcher'])
  assertEqual(new Set(energyOrbVariants.map(({ shape }) => shape)).size, 4, 'orb silhouettes')
  assertEqual(new Set(energyOrbVariants.map(({ liquid }) => liquid)).size, 4, 'orb liquids')
  assert(energyOrbVariants.every(({ flow }) => flow !== 'none'), 'every orb needs a liquid-flow layer')
  assert(energyOrbVariants.every(({ animation }) => animation === 'none'),
    'energy liquid movement must stay disabled')
})

const energyDrawStack = await page.evaluate(() => {
  const energy = document.querySelector('.pip--energy')?.getBoundingClientRect()
  const draw = document.querySelector('[data-pile="draw"]')?.getBoundingClientRect()
  return energy && draw ? { leftOffset: draw.left - energy.left, gap: draw.top - energy.bottom } : null
})
check('the draw pile sits directly below the raised energy orb', () => {
  assert(energyDrawStack !== null, 'expected the energy and draw controls')
  assert(Math.abs(energyDrawStack.leftOffset) <= 1,
    `the draw pile is ${energyDrawStack.leftOffset}px sideways from the energy orb`)
  assert(energyDrawStack.gap >= 8, `the draw pile has only ${energyDrawStack.gap}px clearance below the energy orb`)
})

// Four players is the maximum the box supports and the layout most likely to
// break, so it gets its own capture.
await page.evaluate(() => window.__STS_DEBUG__.reset(4, 'four-player'))
await bypassNeow()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().players.length === 4)
await shot('06a-four-player-map')
await enterFirstRoom()
const four = await shot('06-four-players')
const fourPlayerGutter = await page.locator('.board').evaluate((board) => {
  const boardBox = board.getBoundingClientRect()
  const seats = [...board.querySelectorAll('.row__seat')]
    .filter((seat) => seat.querySelector('.seat:not(.seat--empty)'))
  const hpBars = seats.map((seat) => seat.querySelector('.seat .bar')?.getBoundingClientRect())
  return {
    left: Math.min(...seats.map((seat) => seat.getBoundingClientRect().left)) - boardBox.left,
    hpInside: hpBars.every((bar) => bar && bar.left >= boardBox.left && bar.right <= boardBox.right),
  }
})
check('a four player game lays out one row per player', () => {
  const mainEnemies = four.enemies.filter((enemy) => !enemy.uid.includes('-summon'))
  assertEqual(four.players.length, 4, 'four seats')
  assertEqual(new Set(four.players.map((p) => p.row)).size, 4, 'each player gets their own row')
  assertEqual(mainEnemies.length, 4, 'a normal encounter draws one card per player')
  assertEqual(new Set(mainEnemies.map((enemy) => enemy.defId)).size, 4, 'opening cards are not duplicated')
})
check('a four-player party keeps a deliberate desktop gutter', () => {
  assert(fourPlayerGutter.left >= 14, `the party starts only ${fourPlayerGutter.left}px from the board edge`)
  assert(fourPlayerGutter.hpInside, 'a shifted player HP bar left the board')
})

const rowCount = await page.locator('.row').count()
check('every player row is rendered on screen', () => {
  assertEqual(rowCount, 4, 'the board should show four rows')
})
const enemyAbilities = await page.locator('.enemy').evaluateAll((enemies) => enemies.map((enemy) => ({
  text: document.getElementById(enemy.getAttribute('aria-describedby'))?.textContent ?? '',
  label: enemy.getAttribute('aria-label') ?? '',
})))
check('printed enemy special abilities are available in help and announced', () => {
  const curl = enemyAbilities.find((ability) => ability.text.includes('Curl Up'))
  assert(curl, 'the Louse Curl Up ability is absent from the board')
  assert(curl.label.includes('after the first damage'), `the accessible rule is incomplete: ${curl.label}`)
})
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[0].hand = [{ uid: 'ui-curl-up-strike', defId: 'strike_ironclad', upgraded: false }]
  run.combat.players[0].energy = 3
  debug.setRun(run)
})
await page.locator('.hand .card[aria-label^="Strike,"]').first().click()
await page.locator('.enemy').filter({ hasText: 'Red Louse' }).locator('.enemy__hit-area').click()
await page.waitForFunction(() => document.querySelector('.enemy[aria-label*="Curl Up"][aria-label*="spent"]') !== null)
const spentCurl = await page.locator('.enemy[aria-label*="Curl Up"][aria-label*="spent"]').evaluate((enemy) => ({
  text: document.getElementById(enemy.getAttribute('aria-describedby'))?.textContent ?? '',
  label: enemy.getAttribute('aria-label') ?? '',
}))
check('a used Curl Up is marked spent in help and its accessible label', () => {
  assert(spentCurl.text.includes('spent'), `the help still looks active: ${spentCurl.text}`)
  assert(spentCurl.label.includes('spent'), `the accessible ability still sounds active: ${spentCurl.label}`)
})

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  for (const enemy of run.combat.enemies) Object.assign(enemy, { defId: 'fungi_beast', abilityUsed: false })
  debug.setRun(run)
})
await page.locator('.enemy').filter({ hasText: 'Fungi Beast' }).first().locator('.enemy__hit-area').hover()
await page.locator('.card-keyword-tips[data-open]').waitFor()
const longAbilityInspect = await page.locator('.card-keyword-tips[data-open]').evaluate((ability) => ({
  text: ability.textContent ?? '',
  clipped: ability.scrollHeight > ability.clientHeight + 1 || ability.scrollWidth > ability.clientWidth + 1,
}))
check('the enemy ability is fully visible on hover', () => {
  assert(longAbilityInspect.text.includes('Spore Cloud'), `unexpected rule: ${longAbilityInspect.text}`)
  assert(!longAbilityInspect.clipped, 'Spore Cloud is clipped')
})
await page.mouse.move(0, 0)

// A normal Red Louse encounter can put a main enemy plus two summons in one
// row. The fixed opening only reaches two, so exercise the real wider case.
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const state = run.combat
  const row = state.players[0].row
  const red = state.enemies.find((enemy) => enemy.row === row)
  state.enemies = state.enemies.filter((enemy) => enemy.isBoss || enemy.row !== row)
  for (let index = 0; index < 3; index++) state.enemies.push({
    ...red,
    uid: `layout-enemy-${index}`,
    row,
    isBoss: false,
    hp: red.maxHp,
    dead: false,
    block: 0,
    abilityUsed: false,
  })
  debug.setRun(run)
})
await page.waitForFunction(() => document.querySelectorAll('.row--viewer .enemy').length === 3)
const threeEnemyProbe = []

// Nothing should overflow horizontally at supported desktop widths.
for (const [label, width, height] of [
  ['07-desktop', 1280, 800],
  ['09-desktop-wide', 1920, 1080],
]) {
  await page.setViewportSize({ width, height })
  await settlePaint()
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
  check(`the layout does not overflow horizontally at ${width}px`, () => {
    assert(
      overflow.scrollWidth <= overflow.clientWidth + 1,
      `page scrolls horizontally at ${width}px: ${overflow.scrollWidth} > ${overflow.clientWidth}`,
    )
  })
  await shot(label)
  threeEnemyProbe.push(await page.evaluate((size) => {
    const board = document.querySelector('.board')
    const bars = [...document.querySelectorAll('.row--viewer .enemy .bar')]
    if (!board || bars.length !== 3) return { size, missing: true }
    const boardRect = board.getBoundingClientRect()
    const rects = bars.map((bar) => bar.getBoundingClientRect())
    return {
      size,
      missing: false,
      insideRow: rects.every((rect) => rect.left >= boardRect.left - 1 && rect.right <= boardRect.right + 1),
      insideBoard: rects.every((rect) => rect.top >= boardRect.top - 1 && rect.bottom <= boardRect.bottom + 1),
      onScreen: rects.every((rect) => rect.top >= 0 && rect.bottom <= window.innerHeight),
      duplicatePlayerHud: Boolean(document.querySelector('.party-rail')),
    }
  }, `${width}x${height}`))
}

check('three enemies in one player row remain readable at every supported width', () => {
  for (const probe of threeEnemyProbe) {
    assert(!probe.missing, `${probe.size}: expected three enemy health bars`)
    assert(probe.insideRow, `${probe.size}: an enemy clips outside its player row`)
    assert(probe.insideBoard, `${probe.size}: an enemy health bar clips outside the board`)
    assert(probe.onScreen, `${probe.size}: an enemy health bar is off screen`)
    assert(!probe.duplicatePlayerHud, `${probe.size}: duplicate player HUD is still visible`)
  }
})

// Cards that need a choice or an ally are the ones most easily broken by a UI
// rewrite: a wrong auto-commit silently skips the discard, exhaust or ally
// selection and quietly breaks the printed rule.
await page.setViewportSize({ width: 1440, height: 900 })
await page.evaluate(() => window.__STS_DEBUG__.reset(2, 'choice-flows'))
await bypassNeow()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'map')
await enterFirstRoom()
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const state = run.combat
  const p1 = state.players[0]
  // Deal a known hand: Survivor (discard 1), True Grit (exhaust 1 + block ally),
  // Predator (enemy + ally), and two spare cards to choose.
  p1.hand = [
    { uid: 'h-survivor', defId: 'survivor', upgraded: false },
    { uid: 'h-grit', defId: 'true_grit', upgraded: false },
    { uid: 'h-predator', defId: 'predator', upgraded: false },
    { uid: 'h-backstab', defId: 'backstab', upgraded: false },
    { uid: 'h-sweeping', defId: 'sweeping_beam', upgraded: false },
    { uid: 'h-spare1', defId: 'strike_ironclad', upgraded: false },
    { uid: 'h-spare2', defId: 'strike_ironclad', upgraded: false },
    { uid: 'h-fnp', defId: 'feel_no_pain', upgraded: false },
    { uid: 'h-heavy', defId: 'heavy_blade', upgraded: false },
    { uid: 'h-heavy-plus', defId: 'heavy_blade', upgraded: true },
  ]
  p1.energy = 6
  debug.setRun(run)
})
// Wait for a card that ONLY the injected hand contains. Waiting on hand.length
// is not enough: the natural opening hand is also five cards, so the condition
// can be true before the injection lands. That raced about one run in eight.
await page.waitForFunction(() =>
  window.__STS_DEBUG__.getState()?.players[0].hand.some((card) => card.uid === 'h-survivor'),
)
// And wait for React to actually render that hand before clicking by index.
await page.waitForFunction(() => document.querySelectorAll('.hand .card').length === 10)
const injectedLabels = await page.locator('.hand .card').evaluateAll((cards) =>
  cards.map((card) => card.getAttribute('aria-label') ?? ''),
)
check('scanned card labels include conditional numbers and support targets', () => {
  const backstab = injectedLabels.find((label) => label.startsWith('Backstab')) ?? ''
  const predator = injectedLabels.find((label) => label.startsWith('Predator')) ?? ''
  const sweeping = injectedLabels.find((label) => label.startsWith('Sweeping Beam')) ?? ''
  const feelNoPain = injectedLabels.find((label) => label.startsWith('Feel No Pain')) ?? ''
  const heavy = injectedLabels.find((label) => label.startsWith('Heavy Blade,')) ?? ''
  const heavyPlus = injectedLabels.find((label) => label.startsWith('Heavy Blade+')) ?? ''
  assert(backstab.includes('2 if the target is at full hit points'), `Backstab bonus is missing: ${backstab}`)
  assert(predator.includes('support effect may target any player'), `Predator support target is missing: ${predator}`)
  assert(sweeping.includes('affects a whole row and any boss'), `Sweeping Beam target is missing: ${sweeping}`)
  assert(feelNoPain.includes('whenever you exhaust a card'), `Power trigger is missing: ${feelNoPain}`)
  assert(heavy.includes('3 per Strength'), `Heavy Blade multiplier is wrong: ${heavy}`)
  assert(heavyPlus.includes('5 per Strength'), `Heavy Blade+ multiplier is wrong: ${heavyPlus}`)
})

// Enemies can Weaken players and make them Vulnerable. If the seat panel does
// not show those tokens, a player cannot see a debuff that is affecting them.
// reset() goes through React state, so reading it back in the same tick would
// see the old run. Wait for it to land before touching anything.
await page.evaluate(() => window.__STS_DEBUG__.reset(2, 'debuff-display'))
await bypassNeow()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'map')
await enterFirstRoom()
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[0].weak = 2
  run.combat.players[0].vulnerable = 1
  debug.setRun(run)
})
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].weak === 2)
const seatTokens = await page.evaluate(() =>
  [...document.querySelectorAll('.row__seat .seat__status-strip .token')].map((el) => el.className),
)
// aria-label replaces the button's contents wholesale, so anything left out of
// it is unreachable no matter how it is marked up — which is how the tokens'
// own hidden labels ended up invisible. The class-name check above cannot see
// that; this reads the label a screen reader would actually announce.
const debuffLabel = await page.evaluate(
  () => document.querySelector('.seat--viewer')?.getAttribute('aria-label') ?? '',
)
check('the seat announces its debuffs, not just renders them', () => {
  assert(/Weak \d/.test(debuffLabel), `expected a Weak count in: ${debuffLabel}`)
  assert(/Vulnerable \d/.test(debuffLabel), `expected a Vulnerable count in: ${debuffLabel}`)
})

check('a player can see the Weak and Vulnerable on their own seat', () => {
  assert(
    seatTokens.some((name) => name.includes('token--weak')),
    `expected a Weak token on the seat, saw: ${seatTokens.join(', ') || 'none'}`,
  )
  assert(
    seatTokens.some((name) => name.includes('token--vulnerable')),
    `expected a Vulnerable token on the seat, saw: ${seatTokens.join(', ') || 'none'}`,
  )
})
await shot('13-player-debuffs')

// A Power stays in play for the whole combat and changes how every turn plays
// out. If it is not on screen the player cannot plan around it.
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[0].powers = [
    { uid: 'pw-1', defId: 'demon_form', upgraded: false },
    { uid: 'pw-2', defId: 'metallicize', upgraded: false },
  ]
  debug.setRun(run)
})
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].powers.length === 2)

// Powers render as readable status glyphs; the full card remains available on
// hover/focus/click. Verify the generated icon itself loaded.
await page.waitForFunction(() => {
  const art = [...document.querySelectorAll('.row__seat .power > .icon')]
  return art.length === 2 && art.every((img) => img.complete)
})
const powerArt = await page.evaluate(() =>
  [...document.querySelectorAll('.row__seat .power')].map((button) => {
    const img = button.querySelector(':scope > .icon')
    return {
      alt: button.getAttribute('aria-label') ?? '',
      loaded: img.complete && img.naturalWidth > 0,
      width: img.getBoundingClientRect().width,
      isButton: button.tagName === 'BUTTON',
      focusable: button.tabIndex >= 0,
    }
  }),
)
check('Powers in play are shown on the seat as readable glyphs', () => {
  assertEqual(powerArt.length, 2, 'both Powers should be on the seat')
  for (const art of powerArt) {
    assert(art.loaded, `the Power's card scan failed to load: ${art.alt}`)
    assert(art.width > 8, `the Power thumbnail collapsed to ${art.width}px`)
  }
})

await page.setViewportSize({ width: 1280, height: 800 })
const compactPowerTargets = await page.locator('.row__seat .power').evaluateAll((buttons) => buttons.map((button) => {
  const box = button.getBoundingClientRect()
  const icon = button.querySelector('.icon').getBoundingClientRect()
  return { width: box.width, height: box.height, iconWidth: icon.width, iconHeight: icon.height }
}))
check('compact desktop Power inspection keeps a 44px hit area around its compact glyph', () => {
  assert(compactPowerTargets.every((target) => target.width >= 44 && target.height >= 44),
    `Power hit target below 44px: ${JSON.stringify(compactPowerTargets)}`)
  assert(compactPowerTargets.every((target) => target.iconWidth <= 22 && target.iconHeight <= 22),
    `Power glyph grew instead of its hit area: ${JSON.stringify(compactPowerTargets)}`)
})
await page.setViewportSize({ width: 1440, height: 900 })

const statusStripGeometry = await page.locator('.row__seat').first().evaluate((seat) => {
  const bar = seat.querySelector('.seat .bar')?.getBoundingClientRect()
  const strip = seat.querySelector('.seat__status-strip')?.getBoundingClientRect()
  const overlaps = bar && strip
    ? strip.left < bar.right && strip.right > bar.left && strip.top < bar.bottom && strip.bottom > bar.top
    : true
  return { present: Boolean(strip), gap: bar && strip ? strip.top - bar.bottom : Infinity, overlaps }
})
check('player tokens and Powers stay anchored below their HP bar', () => {
  assert(statusStripGeometry.present, 'the shared status strip is missing')
  assertEqual(statusStripGeometry.overlaps, false, 'the shared status strip covers HP')
  assert(statusStripGeometry.gap >= 0 && statusStripGeometry.gap < 64,
    `the status strip is detached from its owner by ${statusStripGeometry.gap}px`)
})

const permanentEffectPlayerId = await page.locator('.seat--viewer').getAttribute('data-player-id')
await page.evaluate((playerId) => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players.find((player) => player.id === playerId).powers = [
    'demon_form', 'metallicize', 'inflame', 'barricade', 'combust', 'corruption', 'evolve', 'feel_no_pain',
  ].map((defId, index) => ({ uid: `scroll-power-${index}`, defId, upgraded: false }))
  debug.setRun(run)
}, permanentEffectPlayerId)
await page.waitForFunction(() => document.querySelectorAll('.row__seat:has(.seat--viewer) .power').length === 8)
const permanentEffectScroll = await page.locator('.row__seat').filter({ has: page.locator('.seat--viewer') })
  .locator('.seat__status-strip').evaluate((strip) => {
  const before = strip.scrollLeft
  strip.scrollLeft = strip.scrollWidth
  return {
    before,
    after: strip.scrollLeft,
    clientWidth: strip.clientWidth,
    scrollWidth: strip.scrollWidth,
    overflowX: getComputedStyle(strip).overflowX,
    scrollbarWidth: getComputedStyle(strip).scrollbarWidth,
    tabIndex: strip.tabIndex,
  }
})
check('overflowing permanent effects scroll with an invisible scrollbar', () => {
  assert(permanentEffectScroll.scrollWidth > permanentEffectScroll.clientWidth,
    `permanent effects did not overflow: ${JSON.stringify(permanentEffectScroll)}`)
  assert(permanentEffectScroll.after > permanentEffectScroll.before,
    `permanent effects did not scroll: ${JSON.stringify(permanentEffectScroll)}`)
  assertEqual(permanentEffectScroll.overflowX, 'auto')
  assertEqual(permanentEffectScroll.scrollbarWidth, 'none')
  assert(permanentEffectScroll.tabIndex >= 0, 'the invisible scroll region is not keyboard reachable')
})
await page.evaluate((playerId) => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players.find((player) => player.id === playerId).powers = [
    { uid: 'pw-1', defId: 'demon_form', upgraded: false },
    { uid: 'pw-2', defId: 'metallicize', upgraded: false },
  ]
  debug.setRun(run)
}, permanentEffectPlayerId)
await page.waitForFunction(() => document.querySelectorAll('.row__seat:has(.seat--viewer) .power').length === 2)

const topmostOverPower = await page.evaluate(() => {
  const tile = document.querySelector('.row__seat .power')
  if (!tile) return 'no tile'
  const box = tile.getBoundingClientRect()
  const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
  return hit?.className ?? 'nothing'
})
check('the Power glyph paints at the center of its tile', () => {
  assert(
    String(topmostOverPower).includes('power'),
    `expected the glyph on top of the tile, found: ${topmostOverPower}`,
  )
})

// Multi-viewport Power hover coverage lives in the focused, fast
// verify-power-hover-browser.mjs suite.
await page.setViewportSize({ width: 1440, height: 900 })
await page.mouse.move(0, 0)

// Re-hover after the resize. Changing the viewport re-renders and drops the
// zoom, so reading it straight afterwards found `null` roughly one run in
// twelve and reported it as the card being parented wrongly. This is the same
// cause as an earlier flake in this file: a hover does not survive a resize.
await page.locator('.row__seat .power').first().hover()
await waitForPowerZoom()

// The clipping bug this all exists for was caused by the card being a
// DESCENDANT of the board. Geometry alone cannot see that — at a viewport
// where the board happens not to clip, an inline card looks identical.
const zoomParent = await page.evaluate(() => {
  const img = document.querySelector('.power__zoom')
  return {
    parentIsBody: img?.parentElement === document.body,
    parent: img?.parentElement?.className ?? img?.parentElement?.tagName ?? 'none',
  }
})
check('the enlarged card is rendered outside the board, not inside it', () => {
  assert(
    zoomParent.parentIsBody,
    `the enlarged card is a child of "${zoomParent.parent}" — anything with a scroll box will clip it`,
  )
})

if (!artSynced) {
  const powerFallback = await page.locator('.power__zoom--fallback').evaluate((zoom) => {
    const description = zoom.querySelector('.power__zoom-description')
    return {
      text: description?.textContent ?? '',
      fontSize: description ? Number.parseFloat(getComputedStyle(description).fontSize) : 0,
    }
  })
  check('a Power stays readable when optional card scans are missing', () => {
    assert(/Demon Form|Metallicize/.test(powerFallback.text), `missing Power rules fallback: ${powerFallback.text}`)
    assert(powerFallback.fontSize >= 13,
      `Power rules fallback is too small to inspect: ${powerFallback.fontSize}px`)
  })
}
await page.mouse.move(0, 0)

// The clamp only does anything when the tile sits close enough to an edge that
// an unclamped card would overflow. At the widths above it never did, so the
// clamp could be deleted with every assertion still green.
await page.setViewportSize({ width: 1440, height: 900 })
await page.mouse.move(0, 0)
// Shove the row hard right so the tile is within a card's width of the edge.
await page.evaluate(() => {
  const tile = document.querySelector('.row--viewer .power')
  const row = tile.closest('.row__seat')
  row.style.marginLeft = `${window.innerWidth - 120 - tile.getBoundingClientRect().left}px`
})
// A REAL hover: React synthesises onMouseEnter from mouseover/mouseout and
// ignores a dispatched `mouseenter`, so the previous version of this probe
// never ran the placement code and read a stale card from an earlier hover.
await page.locator('.row--viewer .power').first().hover()
await waitForPowerZoom()
const clampProbe = await page.evaluate(() => {
  const tile = document.querySelector('.row--viewer .power')
  const zoom = document.querySelector('.power__zoom')
  const box = zoom.getBoundingClientRect()
  return {
    tileLeft: Math.round(tile.getBoundingClientRect().left),
    zoomLeft: Math.round(box.left),
    zoomRight: Math.round(box.right),
    viewportWidth: window.innerWidth,
  }
})
await page.evaluate(() => {
  const row = document.querySelector('.row--viewer .power').closest('.row__seat')
  row.style.marginLeft = ''
})
await page.mouse.move(0, 0)

check('an enlarged card near the right edge is pulled back on screen', () => {
  assert(
    clampProbe.tileLeft + 190 > clampProbe.viewportWidth,
    `precondition: the tile must be close enough to the edge to need clamping ` +
      `(tile at ${clampProbe.tileLeft}, viewport ${clampProbe.viewportWidth})`,
  )
  // The exact clamped position, not an inequality: "left of the tile" is true
  // of a stale card sitting at x=27 as well as a correctly clamped one.
  assertEqual(
    clampProbe.zoomLeft,
    clampProbe.viewportWidth - 190 - 8,
    'the card should sit exactly one margin in from the right edge',
  )
  assert(
    clampProbe.zoomRight <= clampProbe.viewportWidth,
    `and fully on screen, got right edge ${clampProbe.zoomRight}`,
  )
})

// Geometry alone cannot tell "on screen" from "painted behind the board", so
// the same region is captured with and without the card and compared.
await page.mouse.move(0, 0)
// The region comes from where the card ACTUALLY lands, not a fixed rectangle:
// a hardcoded clip silently stops covering the card the moment the layout
// moves, and then compares two identical patches of background forever.
await page.locator('.row__seat .power').first().hover()
await waitForPowerZoom()
const zoomRegion = await page.evaluate(() => {
  const box = document.querySelector('.power__zoom').getBoundingClientRect()
  return {
    x: Math.max(0, Math.round(box.left)),
    y: Math.max(0, Math.round(box.top)),
    width: Math.round(box.width),
    height: Math.round(box.height),
  }
})
const withZoom = await page.screenshot({ clip: zoomRegion })
await page.mouse.move(0, 0)
await page.waitForFunction(() => !document.querySelector('.power__zoom'))
const withoutZoom = await page.screenshot({ clip: zoomRegion })
await page.locator('.row__seat .power').first().hover()
await waitForPowerZoom()
check('the enlarged card is actually painted, not just positioned', () => {
  assert(
    !withoutZoom.equals(withZoom),
    'hovering a Power changed nothing on screen in the region the card should occupy',
  )
})

await page.locator('.row__seat .power').first().hover()
await waitForPowerZoom()
const tileWhileHovered = await page.evaluate(() => {
  const tile = document.querySelector('.row__seat .power')
  const box = tile.getBoundingClientRect()
  return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.className
})
check('the tile keeps showing its own glyph while the card is enlarged', () => {
  assert(
    String(tileWhileHovered).includes('power'),
    `the tile went blank while hovered: ${tileWhileHovered}`,
  )
})
await shot('14b-power-hover')
await page.mouse.move(0, 0)

// The whole pinned-zoom lifecycle. Every one of these behaviours has a comment
// naming the bug it fixes, and none of them was checked: the suite hovered and
// focused but never clicked to pin.
const pinLife = await page.evaluate(async () => {
  const tiles = [...document.querySelectorAll('.row__seat .power')]
  const count = () => document.querySelectorAll('.power__zoom').length
  const settle = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))

  tiles[0].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  await settle()
  tiles[0].click()
  await settle()
  const afterPin = count()

  // Hovering a neighbour must not steal a pin.
  tiles[1]?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  await settle()
  const afterNeighbour = count()

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await settle()
  const afterEscape = count()

  tiles[0].click()
  await settle()
  const rePinned = count()
  document.querySelector('.board')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  await settle()
  const afterClickAway = count()

  return { afterPin, afterNeighbour, afterEscape, rePinned, afterClickAway }
})
// A pin belongs to the player, not to the row that happens to hold it: another
// row could see its own state as empty, put a hover card up, and destroy it.
const crossRow = await page.evaluate(async () => {
  const settle = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  const rows = [...document.querySelectorAll('.row__seat')].filter(
    (row) => row.querySelector('.power'),
  )
  if (rows.length < 2) return { rows: rows.length, skipped: true }
  const mine = rows[0].querySelector('.power')
  const theirs = rows[1].querySelector('.power')

  mine.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  await settle()
  mine.click()
  await settle()
  const pinned = document.querySelectorAll('.power__zoom').length

  theirs.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  await settle()
  const afterOtherRowHover = document.querySelectorAll('.power__zoom').length
  const stillMine = rows[0].querySelector('.power--open') != null

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await settle()
  return { rows: rows.length, skipped: false, pinned, afterOtherRowHover, stillMine }
})
check('a pin survives a hover in another row', () => {
  if (crossRow.skipped) return // needs two seats carrying Powers
  assertEqual(crossRow.pinned, 1, 'the card is pinned')
  assertEqual(crossRow.afterOtherRowHover, 1, 'and another row hovering does not destroy it')
  assert(crossRow.stillMine, 'the pin stays with the row that made it')
})

check('a pinned Power stays pinned, and every dismissal works', () => {
  assertEqual(pinLife.afterPin, 1, 'clicking a tile pins the card')
  assertEqual(pinLife.afterNeighbour, 1, 'hovering a neighbour does not steal the pin')
  assertEqual(pinLife.afterEscape, 0, 'Escape dismisses it')
  assertEqual(pinLife.rePinned, 1, 'it can be pinned again')
  assertEqual(pinLife.afterClickAway, 0, 'and clicking elsewhere puts it down')
})

check('a Power can be reached without a mouse', () => {
  // Hover-only left pointer and keyboard users with unidentifiable 34x22 blobs.
  for (const art of powerArt) {
    assert(art.isButton, 'a Power tile should be a button')
    assert(art.focusable, 'and reachable by keyboard')
  }
})

check('a Power tells a screen reader what it does, not just its name', () => {
  const alts = powerArt.map((art) => art.alt)
  const demon = alts.find((alt) => alt.startsWith('Demon Form'))
  assert(demon, `expected a Demon Form label, saw: ${alts.join(' | ')}`)
  assert(demon.includes('Strength'), `the label should say what it grants: ${demon}`)
  assert(demon.includes('start of each turn'), `and when it grants it: ${demon}`)
})

// aria-label replaces an element's contents wholesale, so anything missing
// from it is invisible to a screen reader however it is marked up.
const seatLabel = await page.evaluate(
  () => document.querySelector('.seat--viewer')?.getAttribute('aria-label') ?? '',
)
check('the seat announces its tokens, and does not repeat the Powers', () => {
  assert(seatLabel.includes('hit points'), `expected hit points in: ${seatLabel}`)
  // The Powers are a sibling list with their own labels. Naming them here too
  // made a screen reader announce every Power twice.
  assert(
    !seatLabel.includes('Demon Form'),
    `the seat label duplicates the Power list: ${seatLabel}`,
  )
})

const nested = await page.evaluate(
  () => document.querySelector('.seat--viewer')?.querySelectorAll('button, a, [tabindex]').length ?? -1,
)
check('the seat button contains no other interactive element', () => {
  assertEqual(nested, 0, 'nested interactive elements break the seat button')
})
await shot('14-powers-in-play')

// Steam Barrier reads the top discard card, and p.13 lets each player choose
// the order. Exercise the actual end-turn control rather than injecting the
// pile behind it.
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[0].hand = [
    { uid: 'end-bash', defId: 'bash', upgraded: false },
    { uid: 'end-deflect', defId: 'deflect', upgraded: false },
    { uid: 'end-protect', defId: 'protect', upgraded: false },
  ]
  debug.setRun(run)
})
await page.setViewportSize({ width: 1280, height: 800 })
await plantDiscardOrderCards()
await page.getByRole('button', { name: 'End turn' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'discard')
const compactDiscardControls = await page.locator('.combat__actions').evaluate((element) => {
  const box = element.getBoundingClientRect()
  return { left: box.left, right: box.right, width: window.innerWidth }
})
check('multiplayer discard controls fit a minimum desktop screen', () => {
  assert(compactDiscardControls.left >= 0, 'discard controls spill off the left edge')
  assert(compactDiscardControls.right <= compactDiscardControls.width, 'discard controls spill off the right edge')
})
await shot('15a-compact-desktop-discard-order')
const discardOptions = await page.getByLabel('Top discard for Ironclad').locator('option').allTextContents()
check('Retain cards are excluded from the top-discard choice', () => {
  assert(!discardOptions.some((option) => option.includes('Protect')), `Retain leaked into: ${discardOptions.join(' | ')}`)
})
await page.getByLabel('Top discard for Ironclad').selectOption('end-deflect')
await confirmAllDiscards()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'enemy')
const compactDiscardPile = await page.locator('[data-pile="discard"]').evaluate((element) => {
  const box = element.getBoundingClientRect()
  return {
    visible: box.width > 0 && box.height > 0,
    onScreen: box.left >= 0 && box.right <= window.innerWidth,
    namedTopCardCount: document.querySelectorAll('.pile__top').length,
  }
})
check('compact pile icons fit without painting a clipping-prone card name', () => {
  assert(compactDiscardPile.visible, 'the discard pile should be painted')
  assert(compactDiscardPile.onScreen, 'the discard pile should fit on screen')
  assertEqual(compactDiscardPile.namedTopCardCount, 0)
})
await shot('15-compact-desktop-discard-pile')

// A card keeps its uid when it cycles through the deck. A top-card choice from
// one turn must not silently select that same card when it comes back later.
await chooseSeat('p1')
await plantDiscardOrderCards()
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const player = run.combat.players[0]
  player.hand = [
    { uid: 'end-deflect', defId: 'deflect', upgraded: false },
    { uid: 'end-bash', defId: 'bash', upgraded: false },
  ]
  run.combat.phase = 'player'
  run.combat.turn += 1
  debug.setRun(run)
})
await page.getByRole('button', { name: 'End turn' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'discard')
await page.waitForFunction(() => document.querySelector('[aria-label="Top discard for Ironclad"]')?.value === 'end-bash')
const freshDiscardTop = await page.getByLabel('Top discard for Ironclad').inputValue()
check('a prior turn\'s top-card choice is cleared when that card returns', () => {
  assertEqual(freshDiscardTop, 'end-bash', 'the new hand defaults to its current top')
})
await page.setViewportSize({ width: 1440, height: 900 })

// Curses are full card faces, not hidden counters: verify their scans, spoken
// rules, end-turn effects, Ethereal cleanup and Retain through the real UI.
await page.evaluate(() => window.__STS_DEBUG__.reset(1, 'curse-playtest'))
await bypassNeow()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'map')
await enterFirstRoom()
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const player = run.combat.players[0]
  Object.assign(run.combat, {
    phase: 'player', pendingCardCopy: undefined, pendingTriggers: [], startTurnProgress: undefined,
    endTurnProgress: undefined, presentationEvents: [],
  })
  player.hp = 8
  player.block = 1
  player.orbs = ['lightning', 'lightning', null]
  const enemy = run.combat.enemies[0]
  run.combat.enemies = [
    { ...enemy, uid: 'curse-fragile', hp: 1, maxHp: 1, block: 0, dead: false, row: 0 },
    { ...enemy, uid: 'curse-safe', defId: 'acid_slime', hp: 4, maxHp: 4, block: 0, dead: false, row: 1 },
  ]
  player.hand = [
    { uid: 'curse-clumsy', defId: 'clumsy', upgraded: false },
    { uid: 'curse-decay', defId: 'decay', upgraded: false },
    { uid: 'curse-doubt', defId: 'doubt', upgraded: false },
    { uid: 'curse-pain', defId: 'pain', upgraded: false },
    { uid: 'curse-regret', defId: 'regret', upgraded: false },
    { uid: 'curse-shame', defId: 'shame', upgraded: false },
    { uid: 'curse-bane', defId: 'ascenders_bane', upgraded: false },
  ]
  debug.setRun(run)
})
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hand.length === 7)
if (artSynced) await page.waitForFunction(() => [...document.querySelectorAll('.hand .card img')]
  .every((img) => img.complete && img.naturalWidth > 0))
const curseCards = await page.locator('.hand .card').evaluateAll((cards) => cards.map((card) => ({
  label: card.getAttribute('aria-label') ?? '',
  artLoaded: card.querySelector('img')?.naturalWidth > 0,
})))
check('Curse scans and spoken keyword rules render in hand', () => {
  if (artSynced) assert(curseCards.every((card) => card.artLoaded), 'every Curse scan should load')
  assert(curseCards.some((card) => card.label.startsWith('Clumsy') && card.label.includes('ethereal')),
    'Clumsy should announce Ethereal')
  assert(curseCards.some((card) => card.label.startsWith('Pain') && card.label.includes('2 or fewer')),
    'Pain should announce its hand-size condition')
})
await shot('15b-curse-hand')
await page.getByRole('button', { name: 'End turn' }).click()
const firstCurseOrb = page.locator('button.end-turn-effect--orb')
await firstCurseOrb.waitFor()
await firstCurseOrb.click()
await page.locator('.enemy--targeted').first().waitFor()
await page.locator('[data-enemy-id="curse-fragile"] .enemy__hit-area').click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'enemy')
const curseResolved = await readState()
check('the fixed end-turn sequence resolves every Curse and deterministic target', () => {
  const player = curseResolved.players[0]
  assertEqual(player.hp, 8, 'Decay spends the available Block before Shame')
  assertEqual(player.block, 0, 'Decay spends the only Block')
  assertEqual(player.weak, 1, 'Doubt grants Weak')
  assertDeepEqual(curseResolved.enemies.map((enemy) => enemy.hp), [0, 3],
    'the later Lightning Orb retargets after the first overkills its chosen enemy')
  assertDeepEqual(player.exhaust.map((card) => card.uid).sort(), ['curse-bane', 'curse-clumsy'])
  assertDeepEqual(player.hand.map((card) => card.uid), ['curse-regret'])
})
await shot('15c-curse-end-turn')

await page.evaluate(() => window.__STS_DEBUG__.reset(2, 'potion-seat-reset'))
await bypassNeow()
const potionSeatIds = await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.phase = 'map'
  run.combat = null
  run.players = run.players.map((player) => ({ ...player, potions: ['energy_potion'] }))
  debug.setRun(run)
  return run.players.map((player) => player.id)
})
await chooseSeat(potionSeatIds[0])
await page.setViewportSize({ width: 844, height: 390 })
await settlePaint()
const outsidePotionHud = await page.locator('.outside-potions').evaluate((bar) => {
  const box = bar.getBoundingClientRect()
  const header = bar.closest('.app-shell__header')?.getBoundingClientRect()
  const label = bar.querySelector(':scope > strong')
  return {
    inHeader: Boolean(header),
    directShellChild: bar.parentElement?.classList.contains('app-shell'),
    labelVisible: Boolean(label && getComputedStyle(label).display !== 'none'),
    height: box.height,
    insideHeader: Boolean(header && box.top >= header.top && box.bottom <= header.bottom),
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: innerWidth,
  }
})
check('held Potions stay in compact top-HUD slots on a phone', () => {
  assert(outsidePotionHud.inHeader && outsidePotionHud.insideHeader,
    `the Potion inventory escaped the header: ${JSON.stringify(outsidePotionHud)}`)
  assert(!outsidePotionHud.directShellChild, 'the Potion inventory still owns a separate shell row')
  assert(!outsidePotionHud.labelVisible, 'the redundant Potions label is still visible')
  assert(outsidePotionHud.height >= 30 && outsidePotionHud.height <= 48,
    `the Potion slots are ${outsidePotionHud.height}px tall`)
  assert(outsidePotionHud.documentWidth <= outsidePotionHud.viewportWidth,
    `the Potion HUD widened the page to ${outsidePotionHud.documentWidth}px`)
})
await page.setViewportSize({ width: 1440, height: 900 })
const outsidePotionIcon = page.locator('.outside-potions .potion-chip').first()
const outsidePotionLabel = await outsidePotionIcon.getAttribute('aria-label')
await outsidePotionIcon.evaluate((element) => {
  element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }))
  element.focus()
})
const outsidePotionTip = page.locator('.potion-tip').filter({ hasText: 'Energy Potion' })
await outsidePotionTip.waitFor()
const outsidePotionTipText = await outsidePotionTip.textContent()
check('held Potion icons expose the printed effect on touch or keyboard focus', () => {
  assert(outsidePotionLabel.includes('Energy Potion. Potion. Gain 2 Energy.'))
  assert(outsidePotionTipText.includes('Gain 2 Energy.'))
})
await shot('15d-outside-potion-tooltip')
await page.keyboard.press('Escape')
await outsidePotionTip.waitFor({ state: 'hidden' })
const outsidePotionVisual = await outsidePotionIcon.evaluate((icon) => {
  return { text: icon.textContent?.trim(), icon: icon.querySelector('img')?.getAttribute('src') }
})
check('the outside Potion inventory renders icons without item-name text', () => {
  assertEqual(outsidePotionVisual.text, '')
  assert(outsidePotionLabel.includes('Energy Potion'))
  assertEqual(outsidePotionVisual.icon, '/assets/potion-icons/energy_potion.png')
})
await page.locator('.outside-potions').getByRole('button', { name: 'Give Energy Potion', exact: true }).click()
await page.locator('.outside-potions__targets').waitFor()
await chooseSeat(potionSeatIds[1])
await page.locator('.outside-potions__targets').waitFor({ state: 'detached' })
const inheritedPotionMenu = await page.locator('.outside-potions')
  .getByRole('button', { name: 'Give Energy Potion', exact: true }).getAttribute('aria-expanded')
check('switching equal-inventory hot-seat players closes staged Potion actions', () => {
  assertEqual(inheritedPotionMenu, 'false')
})
await page.locator('.outside-potions').getByRole('button', { name: 'Give Energy Potion', exact: true }).click()
await page.locator('.outside-potions__targets').waitFor()
const potionViewerId = await page.getByLabel('Seat').inputValue()
await page.evaluate((viewerId) => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const recipient = run.players.find((player) => player.id !== viewerId)
  sessionStorage.setItem('potion-seat-removed', JSON.stringify(recipient))
  run.players = run.players.filter((player) => player.id === viewerId)
  debug.setRun(run)
}, potionViewerId)
const soloGive = page.locator('.outside-potions').getByRole('button', { name: 'Give Energy Potion', exact: true })
await soloGive.waitFor({ state: 'detached' })
const soloGiveCount = await soloGive.count()
check('solo Potion inventory hides the redundant Give control', () => {
  assertEqual(soloGiveCount, 0)
})
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.players.push(JSON.parse(sessionStorage.getItem('potion-seat-removed')))
  debug.setRun(run)
})
await page.waitForFunction(() => {
  const button = [...document.querySelectorAll('.outside-potions button')]
    .find((candidate) => candidate.getAttribute('aria-label') === 'Give Energy Potion')
  return button && !button.disabled && button.getAttribute('aria-expanded') === 'false' &&
    !document.querySelector('.outside-potions__targets')
})
const restoredGiveExpanded = await page.locator('.outside-potions')
  .getByRole('button', { name: 'Give Energy Potion', exact: true }).getAttribute('aria-expanded')
check('restoring a legal Potion recipient does not reopen a stale Give menu', () => {
  assertEqual(restoredGiveExpanded, 'false')
})
await page.evaluate((viewerId) => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.players = run.players.map((player) => player.id === viewerId
    ? { ...player, potions: ['entropic_brew', 'energy_potion', 'energy_potion', 'energy_potion'],
        relics: [...player.relics.filter((relic) => relic.defId !== 'potion_belt'), { defId: 'potion_belt', spent: false }] }
    : { ...player, potions: ['fire_potion', 'skill_potion', 'block_potion'],
        relics: [...player.relics.filter((relic) => relic.defId !== 'potion_belt'), { defId: 'potion_belt', spent: false }] })
  debug.setRun(run)
}, potionViewerId)
await page.waitForFunction(() => {
  const use = document.querySelector('[aria-label="Use Entropic Brew"]')
  const give = document.querySelector('[aria-label="Give Entropic Brew"]')
  return use && !use.hasAttribute('aria-expanded') && give && !give.disabled
})
const potionBeltActions = await page.locator('.outside-potions').evaluate((bar) => ({
  brewExpanded: bar.querySelector('[aria-label="Use Entropic Brew"]')?.getAttribute('aria-expanded'),
  giveDisabled: bar.querySelector('[aria-label="Give Entropic Brew"]')?.disabled,
}))
check('Potion Belt capacity permits a direct Brew use and a trade to a three-Potion recipient', () => {
  assertEqual(potionBeltActions.brewExpanded, null)
  assertEqual(potionBeltActions.giveDisabled, false)
})
await page.evaluate((viewerId) => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.players = run.players.map((player) => player.id === viewerId
    ? { ...player, potions: ['entropic_brew', 'energy_potion', 'energy_potion'],
        relics: player.relics.filter((relic) => relic.defId !== 'potion_belt') }
    : player)
  debug.setRun(run)
}, potionViewerId)
const localBrewUse = page.locator('.outside-potions').getByRole('button', { name: 'Use Entropic Brew', exact: true })
await localBrewUse.click()
await page.locator('.outside-potions__targets').waitFor()
await page.evaluate((viewerId) => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.players = run.players.map((player) => player.id === viewerId
    ? { ...player, relics: [...player.relics, { defId: 'sozu', spent: false }] }
    : player)
  debug.setRun(run)
}, potionViewerId)
await page.locator('.outside-potions__targets').waitFor({ state: 'detached' })
const sozuBrewEnabled = await localBrewUse.isEnabled()
const sozuBrewExpanded = await localBrewUse.getAttribute('aria-expanded')
check('gaining Sozu closes replacement while keeping Entropic Brew usable', () => {
  assert(sozuBrewEnabled)
  assertEqual(sozuBrewExpanded, null)
})
await page.evaluate((viewerId) => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.players = run.players.map((player) => player.id === viewerId
    ? { ...player, relics: player.relics.filter((relic) => relic.defId !== 'sozu'),
        potions: ['entropic_brew', 'blood_potion', 'energy_potion'] }
    : player)
  debug.setRun(run)
}, potionViewerId)
await localBrewUse.click()
await page.locator('.outside-potions__targets').waitFor()
await page.evaluate((viewerId) => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.players = run.players.map((player) => player.id === viewerId
    ? { ...player, dead: true, hp: 0 }
    : player)
  debug.setRun(run)
}, potionViewerId)
await page.locator('.outside-potions__targets').waitFor({ state: 'detached' })
const deadPotionActions = await page.locator('.outside-potions').getByRole('button').evaluateAll((buttons) =>
  buttons.map((button) => ({ name: button.getAttribute('aria-label'), disabled: button.disabled,
    expanded: button.getAttribute('aria-expanded') })))
check('a dead seat cannot use or give held Potions', () => {
  assert(deadPotionActions.every((button) => button.disabled))
  assert(deadPotionActions.every((button) => button.expanded !== 'true'))
})

await page.evaluate(() => window.__STS_DEBUG__.reset(2, 'local-pending-relic'))
await bypassNeow()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'map')
const localRelicSeats = await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.players[0].relics.push({ defId: 'astrolabe', spent: false, pending: true })
  debug.setRun(run)
  return run.players.map((player) => player.id)
})
await chooseSeat(localRelicSeats[0])
await page.getByRole('heading', { name: 'Resolve Astrolabe' }).waitFor()
await page.locator('.map[hidden][inert]').waitFor({ state: 'attached' })
const localOwnerMapBlocked = await page.locator('.map').evaluate((map) => {
  const room = map.querySelector('button')
  room?.focus()
  return map.hidden && map.inert && document.activeElement !== room
})
await chooseSeat(localRelicSeats[1])
await page.getByRole('status').filter({ hasText: 'Waiting for Ironclad to resolve Astrolabe' }).waitFor()
await page.locator('.map[hidden][inert]').waitFor({ state: 'attached' })
const localTeammateMapBlocked = await page.locator('.map').evaluate((map) => {
  const room = map.querySelector('button')
  room?.focus()
  return map.hidden && map.inert && document.activeElement !== room
})
check('a mandatory local Relic hides and blocks map progression for owner and teammate', () => {
  assert(localOwnerMapBlocked)
  assert(localTeammateMapBlocked)
})
await chooseSeat(localRelicSeats[0])
const localAstrolabeChoices = page.locator('.campfire__deck button')
for (let index = 0; index < 3; index++) await localAstrolabeChoices.nth(index).click()
await page.getByRole('button', { name: 'Confirm Astrolabe' }).click()
await page.locator('.map:not([inert]) .room--reachable').first().waitFor()
await page.waitForFunction(() => document.activeElement?.classList.contains('room--reachable'))
const localMapFocusRestored = await page.locator('.room--reachable').first()
  .evaluate((room) => document.activeElement === room)
check('resolving a local Relic restores map keyboard focus', () => {
  assert(localMapFocusRestored)
})

// The campfire is the first non-combat room with real interaction: each player
// independently Rests or Smiths, and nobody leaves until all have chosen.
await page.evaluate(() => window.__STS_DEBUG__.reset(4, 'campfire'))
await bypassNeow()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().players.length === 4)
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.phase = 'room'
  run.map.position = run.map.rows[run.map.rows.length - 2][0]
  run.players = run.players.map((player) => ({ ...player, hp: 4 }))
  debug.setRun(run)
})
await page.waitForSelector('.campfire')
const campfirePlayerControls = await page.evaluate(() => ({
  statusCards: document.querySelectorAll('.campfire__players, .campfire__seat').length,
  navigation: [...document.querySelectorAll('.campfire__turn-nav button')].map((button) => button.getAttribute('aria-label')),
}))
check('multiplayer campfires omit player status cards but keep accessible player navigation', () => {
  assertEqual(campfirePlayerControls.statusCards, 0)
  assert(campfirePlayerControls.navigation[0]?.startsWith('Previous campfire player: '), JSON.stringify(campfirePlayerControls))
  assert(campfirePlayerControls.navigation[1]?.startsWith('Next campfire player: '), JSON.stringify(campfirePlayerControls))
})

const campfirePartyLayouts = []
const campfireCharacters = ['ironclad', 'silent', 'defect', 'watcher']
for (let mask = 1; mask < 16; mask += 1) {
  const expectedParty = campfireCharacters.filter((_, index) => mask & (1 << index)).join('_')
  await page.evaluate((livingMask) => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.players = run.players.map((player, index) => ({ ...player, dead: !(livingMask & (1 << index)) }))
    debug.setRun(run)
  }, mask)
  await page.waitForFunction((party) => [...document.querySelectorAll('.campfire__sitter')]
    .map((sitter) => sitter.dataset.visual).join('_') === party, expectedParty)
  campfirePartyLayouts.push(await page.locator('.campfire').evaluate(async (campfire, { expected, decode }) => {
    const sitters = [...campfire.querySelectorAll('.campfire__sitter')]
    if (decode) await Promise.all(sitters.map((sitter) => sitter.decode()))
    return {
      statusCards: campfire.querySelectorAll('.campfire__players, .campfire__seat').length,
      expected,
      selected: sitters.map((sitter) => sitter.dataset.visual).join('_') === expected,
      loaded: !decode || sitters.every((sitter) => sitter.naturalWidth === 1408 && sitter.naturalHeight === 1808),
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    }
  }, { expected: expectedParty, decode: [1, 3, 7, 15].includes(mask) }))
}
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.players = run.players.map((player) => ({ ...player, dead: false }))
  debug.setRun(run)
})
await page.waitForFunction(() => document.querySelector('.campfire')?.getAttribute('data-party-size') === '4')
const customCampfireLayouts = []
for (const characters of [['guardian', 'hermit', 'hexaghost', 'slime_boss'], ['ironclad', 'guardian', 'silent', 'hermit']]) {
  await page.evaluate((party) => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.players = run.players.map((player, index) => ({ ...player, character: party[index], dead: false }))
    debug.setRun(run)
  }, characters)
  await page.waitForFunction((party) => [...document.querySelectorAll('.campfire__sitter')]
    .map((sitter) => sitter.dataset.visual).join() === party.join(), characters)
  customCampfireLayouts.push(await page.locator('.campfire__sitter').evaluateAll(async (sitters) => {
    await Promise.all(sitters.map((sitter) => sitter.decode()))
    return sitters.map((sitter) => [sitter.dataset.visual, sitter.naturalWidth, sitter.naturalHeight])
  }))
}
check('Downfall-only and mixed parties seat every hero at the campfire in party order', () => {
  assertDeepEqual(customCampfireLayouts, [
    [['guardian', 1408, 1808], ['hermit', 1408, 1808], ['hexaghost', 1408, 1808], ['slime_boss', 1408, 1808]],
    [['ironclad', 1408, 1808], ['guardian', 1408, 1808], ['silent', 1408, 1808], ['hermit', 1408, 1808]],
  ])
})
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const characters = ['ironclad', 'silent', 'defect', 'watcher']
  run.players = run.players.map((player, index) => ({ ...player, character: characters[index] }))
  debug.setRun(run)
})
await page.waitForFunction(() => [...document.querySelectorAll('.campfire__sitter')].map((sitter) => sitter.dataset.visual).join() === 'ironclad,silent,defect,watcher')
const campfireResponsiveLayouts = []
for (const viewport of [{ width: 1440, height: 900 }, { width: 667, height: 375 }]) {
  await page.setViewportSize(viewport)
  campfireResponsiveLayouts.push({ ...viewport, ...await page.locator('.campfire').evaluate((campfire) => {
    const blockers = [...document.querySelectorAll('.campfire__leave')].map((element) => element.getBoundingClientRect())
    const header = document.querySelector('.app-shell__header')?.getBoundingClientRect()
    const heading = campfire.querySelector('h2')?.getBoundingClientRect()
    const overlaps = (box) => blockers.some((blocker) =>
      blocker.left < box.right && blocker.right > box.left && blocker.top < box.bottom && blocker.bottom > box.top)
    return {
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth ||
        document.documentElement.scrollHeight > document.documentElement.clientHeight,
      sceneFits: (() => {
        const scene = campfire.querySelector('.campfire__scene').getBoundingClientRect()
        const box = campfire.getBoundingClientRect()
        return scene.left <= box.left + 0.5 && scene.right >= box.right - 0.5 && scene.top <= box.top + 0.5 && scene.bottom >= box.bottom - 0.5
      })(),
      headingClearOfHeader: Boolean(header && heading && heading.top >= header.bottom - 1),
      switchers: [...campfire.querySelectorAll('.campfire__turn-nav button')].map((button) => {
        const box = button.getBoundingClientRect()
        return {
          visible: box.left >= -1 && box.right <= innerWidth + 1 && box.top >= -1 && box.bottom <= innerHeight + 1,
          covered: overlaps(box),
        }
      }),
    }
  }) })
  if (viewport.width === 667) await shot('12-campfire-scene-mobile')
}
await page.setViewportSize({ width: 1440, height: 900 })
await shot('12-campfire-scene')
check('campfire party art covers every living party size without overflow', () => {
  assertEqual(campfirePartyLayouts.length, 15)
  assert(campfirePartyLayouts.every((layout) => layout.statusCards === 0 &&
    layout.selected && layout.loaded && !layout.overflow), JSON.stringify(campfirePartyLayouts))
  assert(campfireResponsiveLayouts.every((layout) => !layout.overflow && layout.sceneFits && layout.headingClearOfHeader &&
    layout.switchers.every((button) => button.visible && !button.covered)), JSON.stringify(campfireResponsiveLayouts))
})

const campfireLeaveControls = await page.locator('.campfire__leave').count()
check('campfire choices have no separate Leave phase', () => {
  assertEqual(campfireLeaveControls, 0, 'the obsolete Leave the campfire control is still mounted')
})

const campfirePrompt = page.locator('.campfire__prompt')
await campfirePrompt.getByRole('button', { name: /Rest/ }).click()
const restReadyStatus = await campfirePrompt.getByRole('status').textContent()
const restReadyButtons = await campfirePrompt.locator('.campfire__choices button').count()
check('a completed Rest replaces the action choices with player status', () => {
  assert(restReadyStatus.includes('chose to Rest'), restReadyStatus)
  assertEqual(restReadyButtons, 0)
})
await campfirePrompt.getByRole('button', { name: 'Next campfire player' }).click()
await campfirePrompt.getByRole('button', { name: /Smith/ }).click()
await page.waitForSelector('.card-picker')
await page.setViewportSize({ width: 1244, height: 409 })
await settlePaint()
const compactSmithPicker = await page.evaluate(() => {
  const picker = document.querySelector('.card-picker')
  const grid = document.querySelector('.card-picker__grid')
  const pickerBox = picker?.getBoundingClientRect()
  const cardBoxes = [...(grid?.querySelectorAll(':scope > .card') ?? [])].map((card) => card.getBoundingClientRect())
  const firstTop = cardBoxes[0]?.top
  const firstRow = cardBoxes.filter((box) => firstTop !== undefined && Math.abs(box.top - firstTop) <= 1)
  return {
    documentScrolls: document.documentElement.scrollHeight > document.documentElement.clientHeight + 1,
    gridScrollsHorizontally: Boolean(grid && grid.scrollWidth > grid.clientWidth + 1),
    firstRowCards: firstRow.length,
    clippedFirstRowCards: pickerBox
      ? firstRow.filter((box) => box.top < pickerBox.top - 1 || box.bottom > pickerBox.bottom + 1).length
      : firstRow.length,
    backVisible: Boolean(picker?.querySelector('.card-picker__back')),
    confirmVisible: Boolean(picker?.querySelector('.card-picker__confirm')),
  }
})
check('the compact Smith picker shows full card rows plus Back and Confirm controls', () => {
  assert(!compactSmithPicker.documentScrolls, `the page itself scrolls: ${JSON.stringify(compactSmithPicker)}`)
  assert(!compactSmithPicker.gridScrollsHorizontally, `the card grid scrolls sideways: ${JSON.stringify(compactSmithPicker)}`)
  assert(compactSmithPicker.firstRowCards > 0 && compactSmithPicker.clippedFirstRowCards === 0,
    `the first row is clipped: ${JSON.stringify(compactSmithPicker)}`)
  assert(compactSmithPicker.backVisible && compactSmithPicker.confirmVisible, JSON.stringify(compactSmithPicker))
})
await shot('12a-compact-campfire-smith')
await page.locator('.card-picker__grid > .card').first().click()
await page.waitForSelector('.card-picker__preview')
const compactSmithPicked = []
for (const viewport of [{ width: 1244, height: 409 }, { width: 1244, height: 521 }]) {
  await page.setViewportSize(viewport)
  await settlePaint()
  compactSmithPicked.push({ ...viewport, ...await page.evaluate(() => {
    const picker = document.querySelector('.card-picker')
    const preview = document.querySelector('.card-picker__preview')
    const previewCards = [...(preview?.querySelectorAll('.card') ?? [])].map((card) => card.getBoundingClientRect())
    const pickerBox = picker?.getBoundingClientRect()
    return {
      documentScrolls: document.documentElement.scrollHeight > document.documentElement.clientHeight + 1,
      previewCount: previewCards.length,
      previewFits: Boolean(pickerBox && previewCards.length === 2 && previewCards.every((box) =>
        box.left >= pickerBox.left - 1 && box.right <= pickerBox.right + 1 && box.top >= pickerBox.top - 1 && box.bottom <= pickerBox.bottom + 1)),
      confirmEnabled: (picker?.querySelector('.card-picker__confirm') instanceof HTMLButtonElement) &&
        !picker.querySelector('.card-picker__confirm').disabled,
    }
  }) })
}
check('selecting a Smith card previews its upgraded face and keeps confirmation reachable', () => {
  for (const shape of compactSmithPicked) {
    assert(!shape.documentScrolls, `the selected picker made the page scroll: ${JSON.stringify(shape)}`)
    assertEqual(shape.previewCount, 2, `the base and upgraded cards are not both visible: ${JSON.stringify(shape)}`)
    assert(shape.previewFits && shape.confirmEnabled, JSON.stringify(shape))
  }
})
await page.locator('.card-picker').getByRole('button', { name: 'Confirm' }).click()
const smithReady = await page.evaluate(() => ({
  status: document.querySelector('.campfire__choice-status')?.textContent ?? '',
  legacyCards: document.querySelectorAll('.campfire__deck--smith').length,
  choices: document.querySelectorAll('.campfire__choices button').length,
}))
await shot('12b-campfire-smith-ready')
check('confirming Smith returns to campfire status without the old deck and Leave phase', () => {
  assert(smithReady.status.includes('chose to Smith'), JSON.stringify(smithReady))
  assertEqual(smithReady.legacyCards, 0)
  assertEqual(smithReady.choices, 0)
})
for (let remaining = 2; remaining > 0; remaining -= 1) {
  await campfirePrompt.getByRole('button', { name: 'Next campfire player' }).click()
  await campfirePrompt.getByRole('button', { name: /Rest/ }).click()
}
await page.setViewportSize({ width: 1440, height: 900 })
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'map')
const afterCampfire = await readRun()

check('the final Campfire choice immediately resolves Rest and Smith and returns to the map', () => {
  assertEqual(afterCampfire.phase, 'map', 'the party returns to the map')
  assertEqual(afterCampfire.players[0].hp, 7, 'the resting player heals 3 (p.9)')
  assertEqual(afterCampfire.players[1].hp, 4, 'the smithing player does not heal')
  assertEqual(
    afterCampfire.players[1].deck.filter((card) => card.upgraded).length,
    1,
    'and upgrades exactly one card',
  )
})

// Peace Pipe uses the same full-card picker as Smith but has no upgrade preview.
// A selected removal must keep local player navigation available so another
// player can finish their campfire choice.
await page.evaluate(() => window.__STS_DEBUG__.reset(2, 'campfire-peace-pipe'))
await bypassNeow()
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.phase = 'room'
  run.map.position = run.map.rows[run.map.rows.length - 2][0]
  run.players[0].relics.push({ defId: 'peace_pipe', spent: false })
  debug.setRun(run)
})
await page.waitForSelector('.campfire')
await page.locator('.campfire__prompt').getByRole('button', { name: /Rest/ }).click()
await page.waitForSelector('.card-picker')
await page.locator('.card-picker__grid > .card').first().click()
await page.waitForSelector('.card-picker__preview')
await page.locator('.card-picker').getByRole('button', { name: 'Back' }).click()
await page.waitForSelector('.card-picker__preview', { state: 'detached' })
await page.locator('.card-picker__grid > .card').first().click()
await page.locator('.card-picker').getByRole('button', { name: 'Confirm' }).click()
const peacePipeNextControl = await page.getByRole('button', { name: 'Next campfire player' }).evaluate((button) => {
  const box = button.getBoundingClientRect()
  const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
  return box.width > 0 && box.height > 0 && Boolean(hit && (hit === button || button.contains(hit)))
})
check('Peace Pipe lets a player back out of a selected card before confirming removal', () => {
  assert(peacePipeNextControl, 'the next-player control did not return after confirming a Peace Pipe choice')
})

await page.evaluate(() => window.__STS_DEBUG__.reset(1, 'campfire-peace-pipe-razor'))
await bypassNeow()
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.phase = 'room'
  run.map.position = run.map.rows[run.map.rows.length - 2][0]
  run.players[0].relics.push({ defId: 'peace_pipe', spent: false }, { defId: 'straight_razor', spent: false })
  debug.setRun(run)
})
await page.waitForSelector('.campfire')
await page.locator('.campfire__prompt').getByRole('button', { name: /Rest/ }).click()
await page.waitForSelector('.card-picker')
const removedCardName = await page.locator('.card-picker__grid > .card').last().getAttribute('aria-label')
await page.locator('.card-picker__grid > .card').last().click()
await page.locator('.card-picker').getByRole('button', { name: 'Confirm' }).click()
await page.waitForFunction((name) => ![...document.querySelectorAll('.card-picker__grid > .card')]
  .some((card) => card.getAttribute('aria-label') === name), removedCardName)
check('Peace Pipe excludes its removed card from Straight Razor’s transform picker', () => {
  assert(removedCardName, 'the removal picker did not expose a card to remove')
})

await page.evaluate(() => window.__STS_DEBUG__.reset(1, 'campfire-solo'))
await bypassNeow()
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.phase = 'room'
  run.map.position = run.map.rows[run.map.rows.length - 2][0]
  debug.setRun(run)
})
await page.waitForSelector('.campfire')
const soloCampfireSummaryCount = await page.locator('.campfire__players, .campfire__seat, .campfire__turn-nav').count()
await page.locator('.campfire__prompt').getByRole('button', { name: /Smith/ }).click()
await page.locator('.card-picker__grid > .card').first().click()
await page.setViewportSize({ width: 568, height: 320 })
await settlePaint()
const compactSoloSmith = await page.evaluate(() => {
  const picker = document.querySelector('.card-picker')
  const previewCards = [...document.querySelectorAll('.card-picker__preview .card')].map((card) => card.getBoundingClientRect())
  const pickerBox = picker?.getBoundingClientRect()
  return {
    redundantPlayerUi: document.querySelectorAll('.campfire__players, .campfire__seat, .campfire__turn-nav').length,
    documentScrolls: document.documentElement.scrollHeight > document.documentElement.clientHeight + 1,
    previewFits: Boolean(pickerBox && previewCards.length === 2 && previewCards.every((box) =>
      box.left >= pickerBox.left - 1 && box.right <= pickerBox.right + 1 && box.top >= pickerBox.top - 1 && box.bottom <= pickerBox.bottom + 1)),
  }
})
check('a compact solo Smith picker uses the full scene for its upgrade preview', () => {
  assertEqual(soloCampfireSummaryCount, 0, 'the solo Campfire shows redundant player UI before choosing')
  assertEqual(compactSoloSmith.redundantPlayerUi, 0, `the solo player UI still consumes picker height: ${JSON.stringify(compactSoloSmith)}`)
  assert(!compactSoloSmith.documentScrolls, `the solo picker makes the page scroll: ${JSON.stringify(compactSoloSmith)}`)
  assert(compactSoloSmith.previewFits, `the solo picker clips its upgrade preview: ${JSON.stringify(compactSoloSmith)}`)
})

// A card whose width is unbounded turns aspect-ratio into runaway height. This
// caught a real regression where one enemy portrait grew to ~560px tall and the
// page to three times the viewport.
await page.setViewportSize({ width: 1440, height: 900 })
await settlePaint()
const boxes = await page.evaluate(() => ({
  pageHeight: document.documentElement.scrollHeight,
  viewport: window.innerHeight,
  widest: Math.max(...[...document.querySelectorAll('.enemy')].map((el) => el.getBoundingClientRect().width), 0),
  tallest: Math.max(...[...document.querySelectorAll('.enemy')].map((el) => el.getBoundingClientRect().height), 0),
}))
check('enemy cards stay a sane size and the page does not run away', () => {
  assert(boxes.widest <= 320, `an enemy card is ${Math.round(boxes.widest)}px wide; cards should stay card-sized`)
  assert(boxes.tallest <= 320, `an enemy card is ${Math.round(boxes.tallest)}px tall; aspect-ratio has run away`)
  assert(
    boxes.pageHeight <= boxes.viewport * 1.5,
    `page is ${boxes.pageHeight}px for a ${boxes.viewport}px viewport; the board should fit`,
  )
})

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  debug.setRun({ ...run, campaignProgress: { ...run.campaignProgress, highestAscension: 13 } })
})
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().campaignProgress.highestAscension === 13)
await page.evaluate(() => window.__STS_DEBUG__.reset(1, 'ascension-9', 9))
await bypassNeow()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().ascension === 9)
const ascendedSetup = await readRun()
const ascensionHeader = await page.locator('.run-status').textContent()
check('the solo table starts and labels a cumulative Ascension 9 run', () => {
  assertEqual(ascendedSetup.players[0].maxHp, 9, 'A2 reduces Ironclad max HP')
  assertEqual(ascendedSetup.players[0].hp, 8, 'A9 starts Ironclad 1 HP below the reduced maximum')
  assert(ascendedSetup.players.every((player) =>
    player.deck.some((card) => card.defId === 'ascenders_bane')), 'A5 remains cumulative at A9')
  assert(ascensionHeader.includes('Ascension 9'), `missing Ascension status: ${ascensionHeader}`)
})
await shot('16-ascension-9-setup')
const eventDefeatSoundBefore = await page.evaluate(() => window.__SFX_PLAYS__.length)
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  debug.setRun({ ...structuredClone(debug.getRun()), phase: 'defeat' })
})
await page.waitForFunction((before) =>
  window.__SFX_PLAYS__.slice(before).includes('/assets/sfx/defeat.ogg'), eventDefeatSoundBefore)
await page.getByRole('button', { name: 'Record campaign result' }).click()
await page.getByRole('button', { name: 'Prepare next run →' }).click()
await page.getByRole('heading', { name: 'Ironclad', exact: true }).waitFor()
const runBeforeEmbark = await readRun()
await page.getByRole('button', { name: 'Back', exact: true }).click()
await page.getByRole('button', { name: 'Compendium', exact: true }).click()
await page.locator('.compendium').waitFor()
await page.getByRole('button', { name: 'Back to main menu', exact: true }).click()
await page.getByRole('button', { name: 'Single Player', exact: true }).waitFor()
const nextRunPickerAfterRemount = await page.getByRole('heading', { name: 'Ironclad', exact: true }).count()
await page.getByRole('button', { name: 'Single Player', exact: true }).click()
await page.getByRole('button', { name: 'Standard', exact: true }).click()
await page.getByRole('button', { name: 'Embark' }).click()
await page.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'neow')
const ascensionRetry = await readRun()
check('the campaign journal returns to character select and preserves every Ascension setup modifier', () => {
  assertEqual(runBeforeEmbark.campaign.finalized, true, 'Prepare next run started before choosing a character')
  assertEqual(nextRunPickerAfterRemount, 0, 'backing out of a next run reopened character select after a menu remount')
  assert(ascensionRetry.seed !== runBeforeEmbark.seed, 'the next run reused the previous seed')
  assertEqual(ascensionRetry.ascension, 9)
  assertEqual(ascensionRetry.players[0].maxHp, 9)
  assertEqual(ascensionRetry.players[0].hp, 8)
  assert(ascensionRetry.players[0].deck.some((card) => card.defId === 'ascenders_bane'))
})


// Boss cards use tracked rulebook-extracted portraits over generated act-specific
// backdrops. Exercise three mechanically distinct cards in the real UI so a
// missing asset, unreadable ability, or runaway boss layout fails visibly.
await page.setViewportSize({ width: 1505, height: 430 })
await page.evaluate(() => window.__STS_DEBUG__.reset(1, 'boss-gallery'))
await bypassNeow()
await enterFirstRoom()
const originalHand = await page.evaluate(() => structuredClone(window.__STS_DEBUG__.getRun().combat.players[0].hand))
const handFixture = [
  ['hand-stability-1', 'strike_ironclad'],
  ['hand-stability-2', 'defend_ironclad'],
  ['hand-stability-3', 'bash'],
  ['hand-stability-4', 'defend_ironclad'],
  ['hand-stability-5', 'strike_ironclad'],
  ['hand-stability-6', 'bash'],
  ['hand-stability-7', 'defend_ironclad'],
].map(([uid, defId]) => ({ uid, defId, upgraded: false }))
await page.evaluate((hand) => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[0].hand = hand
  debug.setRun(run)
}, handFixture)
await page.waitForFunction((count) => document.querySelector('.hand')?.getAttribute('data-count') === String(count), handFixture.length)
await page.waitForTimeout(850)
const populatedHand = await page.locator('.combat').evaluate((combat) => {
  const hand = combat.querySelector('.hand-area')
  const board = combat.querySelector('.board')
  return {
    hand: hand.getBoundingClientRect().toJSON(),
    board: board.getBoundingClientRect().toJSON(),
    cards: [...combat.querySelectorAll('.hand .card')].map((card) => card.getBoundingClientRect().toJSON()),
    documentHeight: document.documentElement.scrollHeight,
    viewportHeight: innerHeight,
    background: getComputedStyle(hand).backgroundImage,
  }
})
await shot('17a-immersive-hand-stage', page.locator('.combat'))
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[0].hand = []
  debug.setRun(run)
})
await page.waitForFunction(() => document.querySelector('.hand')?.getAttribute('data-count') === '0')
const emptyHand = await page.locator('.combat').evaluate((combat) => {
  const hand = combat.querySelector('.hand-area')
  const board = combat.querySelector('.board')
  return {
    hand: hand.getBoundingClientRect().toJSON(),
    board: board.getBoundingClientRect().toJSON(),
    background: getComputedStyle(hand).backgroundImage,
  }
})
await page.evaluate((hand) => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[0].hand = hand
  debug.setRun(run)
}, originalHand)
await page.waitForFunction((count) => document.querySelector('.hand')?.getAttribute('data-count') === String(count), originalHand.length)
check('the transparent hand stage does not reflow combat when cards arrive', () => {
  assert(populatedHand.background === 'none' && emptyHand.background === 'none',
    'the hand stage still paints an opaque separation bar')
  assert(populatedHand.documentHeight <= populatedHand.viewportHeight,
    `the short combat stage scrolls vertically: ${populatedHand.documentHeight}/${populatedHand.viewportHeight}`)
  assert(populatedHand.cards.every((card) => card.top >= 0 && card.bottom <= populatedHand.viewportHeight + 4),
    `the short combat stage clips a hand card: ${JSON.stringify(populatedHand.cards)}`)
  for (const key of ['top', 'height']) {
    assert(Math.abs(populatedHand.hand[key] - emptyHand.hand[key]) <= 1,
      `hand ${key} shifted between empty and populated states`)
    assert(Math.abs(populatedHand.board[key] - emptyHand.board[key]) <= 1,
      `board ${key} shifted between empty and populated states`)
  }
})
await page.setViewportSize({ width: 1440, height: 900 })
await page.evaluate(() => performance.clearResourceTimings())
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const template = run.combat.enemies[0]
  run.combat.enemies = [
    ['guardian_defensive', 40, 0],
    ['time_eater', 60, 1],
    ['corrupt_heart', 100, 0],
  ].map(([defId, hp, actionIndex], index) => ({
    ...template,
    uid: `boss-${index}`,
    defId,
    hp,
    maxHp: hp,
    actionIndex,
    isBoss: true,
    abilityUsed: false,
    abilityCubes: defId === 'corrupt_heart' ? 1 : undefined,
    dead: false,
  }))
  run.combat.phase = 'player'
  debug.setRun(run)
})
await page.waitForFunction(() => document.querySelectorAll('.enemy--boss').length === 3)
const bossVisuals = await page.locator('.enemy--boss').evaluateAll((cards) => cards.map((card) => ({
  label: card.getAttribute('aria-label'),
  text: card.textContent,
  background: getComputedStyle(card).backgroundImage,
  image: card.querySelector('.enemy__art--cutout')?.getAttribute('src'),
  asset: card.querySelector('.enemy__art--cutout')?.getAttribute('data-animation-asset'),
  animation: card.getAttribute('data-animation'),
  aura: getComputedStyle(card.querySelector('.enemy__art--cutout')).filter,
  loaded: (card.querySelector('.enemy__art--cutout')?.naturalWidth ?? 0) > 0,
  objectFit: getComputedStyle(card.querySelector('.enemy__art--cutout')).objectFit,
  maskImage: getComputedStyle(card.querySelector('.enemy__art--cutout')).maskImage,
  visualHeight: card.querySelector('.enemy__art--cutout').getBoundingClientRect().height,
  artBox: card.querySelector('.enemy__art--cutout').getBoundingClientRect().toJSON(),
  paintedBox: card.querySelector('.enemy__hit-area').getBoundingClientRect().toJSON(),
  portraitBox: card.querySelector('.enemy__portrait').getBoundingClientRect().toJSON(),
  headBox: card.querySelector('.enemy__head').getBoundingClientRect().toJSON(),
  hpBox: card.querySelector('.bar').getBoundingClientRect().toJSON(),
  intentBox: card.querySelector('.enemy__intent').getBoundingClientRect().toJSON(),
  help: document.getElementById(card.getAttribute('aria-describedby'))?.textContent ?? '',
  inlineAbility: card.querySelector('.enemy__ability') !== null,
  box: card.getBoundingClientRect().toJSON(),
})))
const bossStage = await page.locator('.combat').evaluate((combat) => ({
  act: combat.getAttribute('data-act'),
  background: getComputedStyle(combat).backgroundImage,
  heroHeight: combat.querySelector('.seat__portrait > img').getBoundingClientRect().height,
}))
await page.locator('.enemy--boss').first().hover()
const hoveredBossHeight = await page.locator('.enemy--boss').first()
  .locator('.enemy__art--cutout').evaluate((image) => image.getBoundingClientRect().height)
await page.mouse.move(0, 0)
check('boss portraits, backdrops, mechanics, and accessible labels render together', () => {
  assert(bossVisuals.every((boss) => boss.loaded), 'a tracked boss portrait did not load')
  assert(bossVisuals.every((boss) => boss.objectFit === 'contain' && boss.maskImage === 'none'),
    'a boss portrait is cropped or masked')
  assert(bossStage.act === '1' && bossStage.background.includes('/assets/backgrounds/boss-act-1.webp'),
    'the combat stage is missing its act backdrop')
  assert(bossVisuals.every((boss) => boss.background === 'none'),
    'a boss card still paints a rectangular backdrop')
  assert(bossVisuals.every((boss) => boss.animation === 'idle' &&
    boss.asset?.includes('/assets/combat/rigged/') && boss.asset.endsWith('-idle.webp')),
  'a boss is missing its idle animation')
  assert(bossVisuals.every((boss) => boss.aura.includes('drop-shadow')),
    'a boss is missing its restrained aura')
  assert(new Set(bossVisuals.map((boss) => boss.aura)).size === bossVisuals.length,
    'boss auras should follow each boss identity, not only the act')
  assert(bossVisuals.every((boss) => boss.intentBox.bottom <= boss.paintedBox.top + 4),
    `boss intent must sit above the painted body: ${JSON.stringify(bossVisuals.map((boss) => ({ painted: boss.paintedBox, intent: boss.intentBox })))}`)
  assert(bossVisuals.every((boss) => !boss.inlineAbility && boss.help), 'boss rules belong in hover help')
  assert(bossVisuals.every((boss) => [boss.portraitBox, boss.headBox]
    .every((box) => Math.abs((box.left + box.right) / 2 - (boss.hpBox.left + boss.hpBox.right) / 2) <= 1)),
  `boss art, name, and HP centers diverged: ${JSON.stringify(bossVisuals.map((boss) => ({ art: boss.artBox, portrait: boss.portraitBox, head: boss.headBox, hp: boss.hpBox })))}`)
  assert(bossVisuals.every((boss) => boss.visualHeight >= bossStage.heroHeight * 0.98),
    `boss silhouettes should read larger than the hero: hero ${bossStage.heroHeight}, bosses ${bossVisuals.map((boss) => boss.visualHeight).join(', ')}`)
  assert(hoveredBossHeight >= bossStage.heroHeight * 0.98,
    'hovering must not collapse a boss to the normal enemy scale')
  assert(bossVisuals.some((boss) => boss.label.includes('Sharp Hide')))
  assert(bossVisuals.some((boss) => boss.label.includes('Time Warp')))
  assert(bossVisuals.some((boss) => boss.label.includes('each player can play at most 4 cards this turn')))
  assert(bossVisuals.some((boss) => boss.label.includes('Haste')))
  assert(bossVisuals.some((boss) => boss.label.includes('gain 1 Strength')
    && boss.label.includes('remove all Weak and Vulnerable') && boss.label.includes('Poison remains')))
  assert(bossVisuals.some((boss) => boss.label.includes('Invincible: cannot gain Weak')))
  assert(bossVisuals.some((boss) => boss.label.includes('every player takes 1 damage')))
  assert(bossVisuals.some((boss) => boss.help.includes('Haste')))
  assert(bossVisuals.some((boss) => boss.help.includes('each player can play at most 4 cards this turn')))
  assert(bossVisuals.some((boss) => boss.help.includes('every player takes 1 damage')))
  assert(bossVisuals.some((boss) => boss.help.includes('Invincible: cannot gain Weak')))
  assert(bossVisuals.every((boss) => boss.box.width <= 320 && boss.box.height <= 360),
    'boss cards must remain card-sized')
})

await page.setViewportSize({ width: 1505, height: 430 })
await page.waitForFunction(() => [...document.querySelectorAll('.enemy--boss')].every((card) => {
  const painted = card.querySelector('.enemy__hit-area').getBoundingClientRect()
  const intent = card.querySelector('.enemy__intent').getBoundingClientRect()
  const board = card.closest('.board').getBoundingClientRect()
  return intent.top >= board.top - 1 && intent.bottom <= painted.top + 4
}))
const shortBossVisuals = await page.locator('.enemy--boss').evaluateAll((cards) => cards.map((card) => ({
  painted: card.querySelector('.enemy__hit-area').getBoundingClientRect().toJSON(),
  intent: card.querySelector('.enemy__intent').getBoundingClientRect().toJSON(),
  board: card.closest('.board').getBoundingClientRect().toJSON(),
})))
await shot('17aa-short-boss-intents')
check('short boss stages keep every intent above its portrait and inside the board', () => {
  assert(shortBossVisuals.every(({ intent, board }) =>
    intent.top >= board.top - 1 && intent.bottom <= board.bottom + 1),
  `a short-stage boss intent is clipped by the board: ${JSON.stringify(shortBossVisuals)}`)
  assert(shortBossVisuals.every(({ painted, intent }) => intent.bottom <= painted.top + 4),
    `a short-stage boss intent overlaps its portrait: ${JSON.stringify(shortBossVisuals)}`)
})
await page.setViewportSize({ width: 1440, height: 900 })

const bossAttackSources = await page.locator('.enemy--boss').evaluateAll((cards) => cards.map((card) => {
  const idle = card.querySelector('.enemy__art--cutout')?.getAttribute('data-animation-asset')
  return idle?.includes('downfall_demon-idle.webp')
    ? idle.replace('downfall_demon-idle.webp', 'downfall_demon-airborne.webp')
    : idle?.replace('-idle.webp', '-attack.webp')
}))
await page.waitForFunction((assets) => assets.every((asset) => asset && performance
  .getEntriesByName(new URL(asset, location.href).href)
  .some((entry) => entry.responseEnd > 0)), bossAttackSources)
await settlePaint()
check('boss attacks preload before the enemy phase', () => {
  assert(bossAttackSources.every((asset) => asset && requestedUrls.has(new URL(asset, base).href)))
})

const actStages = []
for (const act of [1, 2, 3, 4]) {
  await page.evaluate((nextAct) => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.act = nextAct
    debug.setRun(run)
  }, act)
  await page.waitForFunction((nextAct) => document.querySelector('.combat')?.getAttribute('data-act') === String(nextAct), act)
  actStages.push(await page.locator('.combat').evaluate((combat) => getComputedStyle(combat).backgroundImage))
}
check('each act paints its own full-stage combat background', () => {
  assertDeepEqual(actStages.map((background, index) =>
    background.includes(`/assets/backgrounds/boss-act-${index + 1}.webp`)), [true, true, true, true])
})

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.phase = 'enemy'
  debug.setRun(run)
})
await page.waitForFunction(() => document.querySelector('.enemy--boss[data-animation="attack"]'))
const bossAttack = await page.locator('.enemy--boss[data-animation="attack"]').first().evaluate((card) => ({
  image: card.querySelector('.enemy__art--cutout')?.getAttribute('src'),
  asset: card.querySelector('.enemy__art--cutout')?.getAttribute('data-animation-asset'),
  loaded: (card.querySelector('.enemy__art--cutout')?.naturalWidth ?? 0) > 0,
}))
check('an attacking boss swaps to its one-shot left-facing animation', () => {
  assert(bossAttack.loaded)
  assert(bossAttack.asset.endsWith('-attack.webp'), bossAttack.asset)
})
await page.waitForFunction(() => document.querySelector('.enemy--boss[data-animation="attack"][data-attack-motion="melee"]'))
const meleeBossArt = page.locator('.enemy--boss[data-animation="attack"][data-attack-motion="melee"]')
  .first().locator('.enemy__art--cutout')
const meleeBossMotion = await meleeBossArt.evaluate((image) => getComputedStyle(image).animationName)
check('melee bosses dash toward the player side while attacking', () => {
  assert(meleeBossMotion === 'boss-melee-dash', meleeBossMotion)
})
await page.waitForTimeout(220)
await meleeBossArt.evaluate((image) => {
  for (const animation of image.getAnimations()) {
    animation.currentTime = 800
    animation.pause()
  }
})
const meleeImpact = await page.locator('.board').evaluate((board) => {
  const heroes = [...board.querySelectorAll('.row--viewer .seat__portrait > img')]
  const animations = heroes.map((hero) => hero.style.animation)
  for (const hero of heroes) hero.style.animation = 'none'
  const heroRight = Math.max(...heroes.map((hero) => hero.getBoundingClientRect().right))
  const art = board.querySelector('.enemy--boss[data-animation="attack"][data-attack-motion="melee"] .enemy__art--cutout')
  const boss = art.getBoundingClientRect().toJSON()
  const contactLeft = Number.parseFloat(getComputedStyle(art.closest('.enemy')).getPropertyValue('--boss-contact-left'))
  heroes.forEach((hero, index) => { hero.style.animation = animations[index] ?? '' })
  return {
    boss,
    visibleBossLeft: boss.left + contactLeft / art.naturalHeight * boss.height,
    heroRight,
  }
})
check('a melee boss reaches the player lane at its impact frame', () => {
  assert(meleeImpact.visibleBossLeft < meleeImpact.heroRight,
    `melee boss missed the rightmost hero edge: ${JSON.stringify(meleeImpact)}`)
})
await shot('17b-boss-attack', page.locator('.board'))
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  Object.assign(run.combat.enemies[0], { hp: 0, dead: true })
  debug.setRun(run)
})
await page.waitForFunction(() => document.querySelector('.enemy--boss.enemy--dead')?.getAttribute('data-animation') === 'static')
const deadBossArt = await page.locator('.enemy--boss.enemy--dead .enemy__art--cutout').getAttribute('src')
check('a defeated boss falls back to static art during later enemy phases', () => {
  assert(deadBossArt && !deadBossArt.includes('/animations/'), deadBossArt)
})
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.act = 1
  run.combat.phase = 'player'
  Object.assign(run.combat.enemies[0], { hp: 40, dead: false })
  debug.setRun(run)
})
await page.locator('.board').evaluate((board) => { board.scrollTop = 0 })
const bossContainment = await page.locator('.board').evaluate((board) => {
  const outer = board.getBoundingClientRect()
  return [...board.querySelectorAll('.enemy')].map((card) => {
    const box = card.getBoundingClientRect()
    return box.top >= outer.top && box.left >= outer.left && box.bottom <= outer.bottom && box.right <= outer.right
  })
})
check('the boss gallery capture contains every complete card', () => {
  assertDeepEqual(bossContainment, [true, true, true])
})
await shot('17-boss-mechanics-gallery', page.locator('.board'))

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.enemies.find((enemy) => enemy.defId === 'time_eater').abilityUsed = true
  debug.setRun(run)
})
const timeEater = page.locator('.enemy--boss[data-enemy-def="time_eater"]')
await timeEater.locator('.enemy__hit-area').hover()
await page.locator('.card-keyword-tips[data-open]').waitFor()
const spentHaste = await timeEater.getAttribute('aria-label')
const timeEaterHelp = await page.locator('.card-keyword-tips[data-open]').innerText()
check('Time Eater exposes Haste as spent after its one revival', () => {
  assert(spentHaste.includes('Haste: spent'))
  assert(timeEaterHelp.includes('Haste') && timeEaterHelp.includes('spent'))
  assert(timeEaterHelp.includes('Time Warp'), 'spending Haste must retain Time Warp')
})
await page.mouse.move(0, 0)

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const template = run.combat.enemies[0]
  run.combat.enemies = [
    { ...template, uid: 'slime', defId: 'slime_boss', ascension: 10, hp: 23, maxHp: 23, isBoss: true, abilityUsed: false },
    { ...template, uid: 'awakened', defId: 'awakened_one_phase_1', ascension: 10, hp: 50, maxHp: 50, isBoss: true, abilityUsed: false },
  ]
  debug.setRun(run)
})
const ascendedAbilities = await page.locator('.enemy--boss').evaluateAll((cards) => cards.map((card) => ({
  text: document.getElementById(card.getAttribute('aria-describedby'))?.textContent ?? '',
  label: card.getAttribute('aria-label') ?? '',
})))
check('ascended boss abilities are visible and announced', () => {
  assert(ascendedAbilities.some((ability) => ability.text.includes('Large Slimes gain 1 Strength')
    && ability.label.includes('Large Slimes gain 1 Strength')))
  assert(ascendedAbilities.some((ability) => ability.text.includes('Strength equal to the largest number of Powers')
    && ability.label.includes('Strength equal to the largest number of Powers')))
})

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const player = run.combat.players[0]
  run.combat.players = Array.from({ length: 4 }, (_, index) => ({
    ...structuredClone(player),
    id: index === 0 ? player.id : `facing-p${index + 1}`,
    name: index === 0 ? player.name : `Player ${index + 1}`,
    row: index,
    facingEnemyUid: null,
  }))
  const template = run.combat.enemies[0]
  run.combat.enemies = [
    { ...template, uid: 'shield', defId: 'spire_shield', row: 0, hp: 30, maxHp: 30, isBoss: false, abilityUsed: false, dead: false },
    { ...template, uid: 'spear', defId: 'spire_spear', row: 3, hp: 42, maxHp: 42, isBoss: false, abilityUsed: false, dead: false },
  ]
  run.combat.phase = 'start'
  run.combat.startTurnStage = 'facing'
  debug.setRun(run)
})
await page.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('choose an enemy'))
await page.getByRole('button', { name: /^Spire Shield,/ }).locator('.enemy__hit-area').click()
await page.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('Player 2'))
await page.getByRole('button', { name: /^Spire Shield,/ }).locator('.enemy__hit-area').click()
await page.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('Player 3'))
const facingCapacity = await page.locator('.enemy').evaluateAll((cards) => Object.fromEntries(cards.map((card) => [
  card.getAttribute('aria-label')?.split(',')[0], {
    targeted: card.classList.contains('enemy--targeted'), disabled: card.matches(':disabled'),
  },
])))
check('Facing UI semantically disables a side after its two rows are filled', () => {
  assertDeepEqual(facingCapacity['Spire Shield'], { targeted: false, disabled: true })
  assertDeepEqual(facingCapacity['Spire Spear'], { targeted: true, disabled: false })
})
await page.getByRole('button', { name: /^Spire Spear,/ }).locator('.enemy__hit-area').click()
await page.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('Player 4'))
await page.getByRole('button', { name: /^Spire Spear,/ }).locator('.enemy__hit-area').click()
await page.getByRole('button', { name: 'Resolve start of turn' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'player')
const capacityState = await readState()
check('four-player Facing resolves with two players on each side', () => {
  assertDeepEqual(capacityState.players.map((player) => player.facingEnemyUid), ['shield', 'shield', 'spear', 'spear'])
})

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const template = run.combat.enemies[0]
  run.combat.enemies = [
    { ...template, uid: 'shield', defId: 'spire_shield', row: 0, hp: 30, maxHp: 30, actionIndex: 0, isBoss: false, abilityUsed: false, dead: false },
    { ...template, uid: 'spear', defId: 'spire_spear', row: 3, hp: 42, maxHp: 42, actionIndex: 0, isBoss: false, abilityUsed: false, dead: false },
  ]
  run.combat.players = [run.combat.players[0]]
  run.combat.players[0].id = run.players[0].id
  run.combat.players[0].name = run.players[0].name
  run.combat.players[0].row = 0
  run.combat.phase = 'start'
  run.combat.startTurnStage = 'facing'
  run.combat.players[0].energy = 3
  run.combat.players[0].facingEnemyUid = null
  debug.setRun(run)
})
await page.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('choose an enemy'))
const shieldFacingLabel = await page.getByRole('button', { name: /^Spire Shield,/ }).getAttribute('aria-label')
check('Facing exposes its current physical penalty to assistive technology', () => {
  assert(shieldFacingLabel.includes('lose 1 Energy'))
})
await page.getByRole('button', { name: /^Spire Shield,/ }).locator('.enemy__hit-area').click()
await page.getByRole('button', { name: 'Resolve start of turn' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'player')
const facingState = await readState()
check('the browser can choose and resolve Act IV Facing authoritatively', () => {
  assertEqual(facingState.players[0].facingEnemyUid, 'shield')
  assertEqual(facingState.players[0].energy, 2)
})
// Keep one player opposite each Act IV elite for the visual artefact. Empty
// rows intentionally compact, which is correct in play but hides Spear's card.
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const first = run.combat.players[0]
  const second = {
    ...first,
    id: 'facing-visual-p2', name: 'Silent', character: 'silent', row: 3,
    hp: 9, maxHp: 9, block: 0, facingEnemyUid: 'spear',
    deck: [], draw: [], hand: [], discard: [], exhaust: [], powers: [],
    shivs: 0, miracles: 0, stance: 'neutral', orbs: [null, null, null],
    relics: [{ defId: 'ring_of_the_snake', spent: false }], potions: [],
  }
  run.players.push(structuredClone(second))
  run.combat.players.push(second)
  debug.setRun(run)
})
await page.waitForFunction(() => document.querySelectorAll('.seat:not(.seat--empty)').length === 2)
const actFourBoxes = await page.locator('.enemy').evaluateAll((cards) => cards.map((card) => card.getBoundingClientRect().height))
check('the Act IV capture keeps both elite cards readable', () => {
  assertEqual(actFourBoxes.length, 2)
  assert(actFourBoxes.every((height) => height >= 200), `compact enemy card in capture: ${actFourBoxes.join(', ')}`)
})
await page.locator('.board').evaluate((board) => { board.scrollTop = 0 })
const actFourContainment = await page.locator('.board').evaluate((board) => {
  const outer = board.getBoundingClientRect()
  return [...board.querySelectorAll('.enemy')].map((card) => {
    const box = card.getBoundingClientRect()
    return box.top >= outer.top && box.left >= outer.left && box.bottom <= outer.bottom && box.right <= outer.right
  })
})
check('the Act IV capture contains both complete enemy cards', () => {
  assertDeepEqual(actFourContainment, [true, true])
})
await shot('18-act4-facing', page.locator('.board'))

// Manual Relics are game actions, not catalog text. Exercise the private,
// reconnect-shaped Golden Eye interaction on the supported desktop stage.
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.combat.players[0]
  actor.relics = [
    { defId: 'golden_eye', spent: false },
    { defId: 'akabeko', spent: false },
  ]
  actor.draw = [
    { uid: 'ui-golden-eye-1', defId: 'strike_ironclad', upgraded: false },
    { uid: 'ui-golden-eye-2', defId: 'defend_ironclad', upgraded: false },
    { uid: 'ui-golden-eye-3', defId: 'bash', upgraded: false },
  ]
  run.combat.phase = 'player'
  debug.setRun(run)
})
await page.setViewportSize({ width: 1440, height: 900 })
const goldenEyeUseVisual = await page.getByRole('button', { name: 'Use Golden Eye' }).evaluate((button) => ({
  text: button.textContent?.trim(),
  icon: button.querySelector('img')?.getAttribute('src'),
}))
check('Relic use controls render only the Relic icon', () => {
  assertEqual(goldenEyeUseVisual.text, '')
  assert(goldenEyeUseVisual.icon?.includes('/relic-icons/golden_eye.png'), goldenEyeUseVisual.icon)
})
await page.getByRole('button', { name: 'Use Golden Eye' }).click()
const goldenEyePanel = page.getByRole('dialog', { name: 'Golden Eye — Scry 3' })
await goldenEyePanel.waitFor()
await page.mouse.move(0, 0)
await page.waitForTimeout(400)
const goldenEyeCardCount = await goldenEyePanel.locator('.card').count()
const competingRelicActions = await page.getByRole('button', { name: 'Use Akabeko' }).count()
check('manual Relics expose a private desktop card-choice surface', () => {
  assertEqual(goldenEyeCardCount, 3)
  assert(competingRelicActions === 0,
    'other combat actions stayed available during the private Scry')
})
await shot('manual-relic-desktop')
await goldenEyePanel.getByRole('button', { name: /^Strike,/ }).click()
await goldenEyePanel.getByRole('button', { name: 'Discard 1' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().pendingRelicScry === undefined)
const afterGoldenEye = await readState()
check('Golden Eye resolves the selected physical Scry choice', () => {
  assertEqual(afterGoldenEye.players[0].relics[0].spent, true)
  assertEqual(afterGoldenEye.players[0].discard.at(-1).uid, 'ui-golden-eye-1')
})
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.combat.players[0]
  actor.character = 'defect'
  actor.orbs = ['lightning', 'frost', 'dark']
  actor.relics = [
    { defId: 'golden_eye', spent: false },
    { defId: 'akabeko', spent: false },
    { defId: 'calipers', spent: false },
  ]
  run.combat.phase = 'player'
  debug.setRun(run)
})
await page.setViewportSize({ width: 844, height: 390 })
await page.waitForFunction(() => document.querySelectorAll('.relic-actions > section > .potion-chip > button').length === 3)
const compactRelicStrip = await page.evaluate(() => {
  const buttons = [...document.querySelectorAll('.relic-actions > section > .potion-chip > button')]
    .map((button) => button.getBoundingClientRect())
  const strip = document.querySelector('.relic-actions > section')?.getBoundingClientRect()
  const important = [...document.querySelectorAll('.orbs .token, .seat__portrait, .seat__name')]
    .map((element) => element.getBoundingClientRect())
  return {
    strip: strip ? { width: strip.width, height: strip.height } : null,
    buttons: buttons.map((box) => ({ top: box.top, width: box.width, height: box.height })),
    obscuresDefectInfo: Boolean(strip && important.some((box) =>
      strip.left < box.right && strip.right > box.left && strip.top < box.bottom && strip.bottom > box.top)),
  }
})
check('simple Relic activations stay in one compact icon strip on a Defect phone layout', () => {
  assert(compactRelicStrip.strip && compactRelicStrip.strip.width < 300 && compactRelicStrip.strip.height < 70,
    JSON.stringify(compactRelicStrip))
  assert(compactRelicStrip.buttons.every((button) => button.width <= 84 && button.height <= 64),
    JSON.stringify(compactRelicStrip))
  assertEqual(new Set(compactRelicStrip.buttons.map((button) => Math.round(button.top))).size, 1,
    JSON.stringify(compactRelicStrip))
})
await shot('manual-relic-mobile')
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.combat.players[0]
  actor.lostHpThisCombat = true
  actor.powerPlayedThisTurn = true
  actor.shuffledThisCombat = true
  actor.shivs = 0
  actor.relics = [
    'golden_eye', 'akabeko', 'calipers', 'centennial_puzzle',
    'dead_branch', 'mummified_hand', 'ninja_scroll', 'red_skull',
  ].map((defId) => ({ defId, spent: false }))
  debug.setRun(run)
})
await page.setViewportSize({ width: 568, height: 320 })
await page.waitForFunction(() => document.querySelectorAll('.relic-actions > section > .potion-chip > button').length === 8)
await page.locator('.relic-actions > section > .potion-chip').first().hover()
const scrollableRelicStrip = await page.locator('.relic-actions > section').evaluate((strip) => {
  strip.scrollLeft = strip.scrollWidth
  const outer = strip.getBoundingClientRect()
  const last = strip.lastElementChild?.getBoundingClientRect()
  return {
    clientWidth: strip.clientWidth,
    scrollWidth: strip.scrollWidth,
    withinViewport: outer.left >= 0 && outer.right <= innerWidth,
    lastReachable: Boolean(last && last.left >= outer.left && last.right <= outer.right),
    scrollbarWidth: getComputedStyle(strip).scrollbarWidth,
    webkitScrollbarDisplay: getComputedStyle(strip, '::-webkit-scrollbar').display,
  }
})
check('hovered simple Relics scroll without scrollbar chrome on a horizontal phone', () => {
  assert(scrollableRelicStrip.scrollWidth > scrollableRelicStrip.clientWidth, JSON.stringify(scrollableRelicStrip))
  assert(scrollableRelicStrip.withinViewport, JSON.stringify(scrollableRelicStrip))
  assert(scrollableRelicStrip.lastReachable, JSON.stringify(scrollableRelicStrip))
  assertEqual(scrollableRelicStrip.scrollbarWidth, 'none')
  assertEqual(scrollableRelicStrip.webkitScrollbarDisplay, 'none')
})
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.combat.players[0]
  actor.relics = [
    { defId: 'blue_candle', spent: false },
    { defId: 'golden_eye', spent: false },
    { defId: 'calipers', spent: false },
  ]
  debug.setRun(run)
})
await page.setViewportSize({ width: 844, height: 390 })
await page.waitForFunction(() => document.querySelectorAll('.relic-actions > section > .potion-chip > button').length === 2 &&
  document.querySelectorAll('.relic-actions > section > details').length === 1)
const mixedRelicStrip = await page.locator('.relic-actions > section').evaluate((strip) => {
  const outer = strip.getBoundingClientRect()
  const actions = [...strip.children].map((action) => action.getBoundingClientRect())
  const important = [...document.querySelectorAll('.orbs .token, .seat__portrait, .seat__name')]
    .map((element) => element.getBoundingClientRect())
  return {
    height: outer.height,
    oneRow: new Set(actions.map((box) => Math.round(box.top))).size === 1,
    obscuresDefectInfo: important.some((box) =>
      outer.left < box.right && outer.right > box.left && outer.top < box.bottom && outer.bottom > box.top),
  }
})
check('simple Relics stay compact beside a closed card-choice Relic on Defect', () => {
  assert(mixedRelicStrip.height < 70, JSON.stringify(mixedRelicStrip))
  assert(mixedRelicStrip.oneRow, JSON.stringify(mixedRelicStrip))
})
await page.setViewportSize({ width: 1440, height: 900 })
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.combat.players[0]
  run.combat.phase = 'start'
  run.combat.die = 6
  run.combat.pendingTriggers = []
  delete run.combat.pendingRelicScry
  delete run.combat.startTurnProgress
  actor.relics = [
    { defId: 'loaded_die', spent: false },
    { defId: 'stone_calendar', spent: false },
  ]
  debug.setRun(run)
})
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'start' &&
  window.__STS_DEBUG__.getState().players[0].relics[0]?.defId === 'loaded_die')
const calendarDetails = page.locator('.relic-actions details').filter({ hasText: 'Loaded Die' })
await calendarDetails.locator('summary').click()
const calendarTarget = calendarDetails.getByRole('button', { name: /Stone Calendar/ }).first()
await calendarTarget.waitFor()
const calendarTargetName = await calendarTarget.getAttribute('aria-label')
const calendarBefore = await readState()
await calendarTarget.click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].relics[0]?.spent === true)
const calendarAfter = await readState()
const calendarHpChanges = calendarAfter.enemies.map((enemy, index) =>
  enemy.hp - calendarBefore.enemies[index].hp)
check('Loaded Die lets Stone Calendar choose and damage an enemy', () => {
  assert(calendarTargetName?.includes('→'), `Stone Calendar had no target: ${calendarTargetName}`)
  assert(calendarTargetName?.includes('die 4'), `Stone Calendar ability had no die-face label: ${calendarTargetName}`)
  assertDeepEqual(calendarHpChanges.sort((a, b) => a - b), [-4, ...Array(calendarHpChanges.length - 1).fill(0)])
  assertEqual(calendarAfter.players[0].relics[0].spent, true)
})
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const combat = run.combat
  const actor = combat.players[0]
  actor.powers = [{ uid: 'ui-combo-priority', defId: 'hermit_combo', upgraded: false }]
  combat.phase = 'player'
  combat.pendingTriggers = [{ id: 9191, playerId: actor.id, sourceId: 'power:ui-combo-priority' }]
  combat.pendingDieRelicChoices = [{
    playerId: actor.id, relicDefId: 'wheel_of_change', abilityIndex: 0,
    sourceLabel: 'Cheat', enemyUid: null, targetPlayerId: actor.id,
  }]
  debug.setRun(run)
})
await page.getByRole('status').filter({ hasText: 'Cheat — finish the chosen die Relic' }).waitFor()
const staleComboControls = await page.locator('.prompt').getByText(/Combo/).count()
check('a pending Cheat payment hides stale Combo controls', () => {
  assertEqual(staleComboControls, 0)
})
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.combat.players[0]
  run.combat.phase = 'start'
  run.combat.die = 3
  run.combat.pendingTriggers = []
  run.combat.pendingDieRelicChoices = []
  actor.powers = []
  actor.potions = ['gamblers_brew']
  actor.relics = [
    { defId: 'dollys_mirror', spent: false },
    { defId: 'nilrys_codex', spent: false },
    { defId: 'loaded_die', spent: false },
    { defId: 'charons_ashes', spent: false },
    { defId: 'the_abacus', spent: false },
    { defId: 'gambling_chip', spent: false },
  ]
  debug.setRun(run)
})
const gamblingChip = page.getByRole('button', { name: /^Use Gambling Chip:/ })
const gamblingChipVisual = await gamblingChip.evaluate((button) => ({
  text: button.textContent?.trim(),
  icon: button.querySelector('img')?.getAttribute('src'),
}))
await gamblingChip.hover()
const gamblingChipTip = page.locator('.potion-tip')
await gamblingChipTip.waitFor({ state: 'visible' })
const gamblingChipTipText = await gamblingChipTip.textContent()
check('Gambling Chip uses its relic icon with its effect on hover', () => {
  assertEqual(gamblingChipVisual.text, '')
  assert(gamblingChipVisual.icon?.includes('/relic-icons/gambling_chip.png'), gamblingChipVisual.icon)
  assert(gamblingChipTipText?.includes('Once per room: reroll the die.'), gamblingChipTipText)
})
await shot('manual-relic-gambling-chip')
const invalidPostRollRelics = await page.getByRole('button', {
  name: /Use (Dolly's Mirror|Nilry's Codex|Loaded Die|Charon's Ashes)/,
}).count()
await page.getByRole('button', { name: 'Use The Abacus' }).waitFor()
await page.waitForTimeout(400)
const validPostRollRelic = await page.getByRole('button', { name: 'Use The Abacus' }).count()
const postRollPhase = await page.evaluate(() => window.__STS_DEBUG__.getState().phase)
check('a paused post-roll window shows only Relics matching the rolled face', () => {
  assertEqual(invalidPostRollRelics, 0)
  assertEqual(validPostRollRelic, 1)
  assertEqual(postRollPhase, 'start')
})
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.startTurnProgress = { choices: [] }
  debug.setRun(run)
})
await page.waitForFunction(() => ![...document.querySelectorAll('button')]
  .some((button) => button.getAttribute('aria-label') === 'Use The Abacus'))
const relicDuringStartProgress = await page.getByRole('button', { name: 'Use The Abacus' }).count()
check('private start progress hides post-roll Relic controls', () => {
  assertEqual(relicDuringStartProgress, 0)
})
await shot('manual-relic-post-roll')
await page.setViewportSize({ width: 1440, height: 900 })

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.act = 1
  run.phase = 'victory'
  run.combat = null
  run.lastStand = true
  run.pendingBossDefId = null
  run.roomState = null
  run.rewards = []
  run.campaign.finalized = false
  run.campaignProgress.unspentMarks = 0
  run.players = run.players.map((player, index) => ({
    ...player,
    hp: index === 1 ? 0 : Math.max(1, player.hp),
    dead: index === 1,
    relics: player.relics.map((relic) => ({ ...relic, pending: undefined })),
  }))
  debug.setRun(run)
})
await page.getByRole('heading', { name: 'Act 1 complete' }).waitFor()
const localLastStandNotice = await page.getByRole('status').filter({ hasText: 'cannot continue to the next Act' }).count()
const localForbiddenNextAct = await page.getByRole('button', { name: 'Climb to Act 2' }).count()
const localRecordLastStand = await page.getByRole('button', { name: 'Stop and record result' }).count()
const localTerminalInventory = await page.locator('.outside-potions').count()
const localTerminalPotionActions = await page.locator('.outside-potions__give, .outside-potions button[aria-label^="Use "]').count()
check('a local Last Stand boss win has a clear terminal continuation state', () => {
  assertEqual(localLastStandNotice, 1)
  assertEqual(localForbiddenNextAct, 0)
  assertEqual(localRecordLastStand, 1)
  assertEqual(localTerminalInventory, 1)
  assertEqual(localTerminalPotionActions, 0)
})
await shot('20-last-stand-victory')

// The local Neow scene stays full-bleed on desktop and horizontal phones.
const localNeowBleed = []
await page.evaluate(() => window.__STS_DEBUG__.reset(1, 'neow-reach'))
await page.getByRole('heading', { name: 'Neow’s Blessing' }).waitFor()
for (const size of [{ width: 844, height: 390 }, { width: 568, height: 320 }, { width: 1280, height: 800 }]) {
  await page.setViewportSize(size)
  await page.waitForFunction(() => document.querySelectorAll('.neow-face').length === 1)
  localNeowBleed.push({
    size: `${size.width}x${size.height}`,
    ...await page.evaluate(() => ({
      faces: document.querySelectorAll('.neow-face').length,
      // `width: 100vw` plus the negative inline margin, against the shell's
      // 1400px cap and 1rem gutter. Dropping either letterboxes the scene.
      bled: Math.round(document.querySelector('.neow-screen').getBoundingClientRect().width) >= innerWidth,
    })),
  })
}
await page.setViewportSize({ width: 1440, height: 900 })
check('the local Neow scene keeps its full-bleed at every width', () => {
  for (const sample of localNeowBleed) {
    assertEqual(sample.faces, 1, `local Neow dealt ${sample.faces} faces at ${sample.size}`)
    assert(sample.bled, `the local Neow scene lost its full-bleed width at ${sample.size}`)
  }
})

await page.evaluate(() => window.__STS_DEBUG__.reset(3, 'hit-feedback'))
await bypassNeow()
await enterFirstRoom()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'combat')
const openingDefectId = (await readState()).players.find((player) => player.character === 'defect')?.id
assert(openingDefectId, 'the opening Orb VFX fixture needs a Defect')
const openingOrbVfx = page.locator(
  `.seat[data-player-id="${openingDefectId}"] .combat-vfx[data-vfx-kind="orb"][data-vfx-source="cracked_core"]`,
)
await openingOrbVfx.waitFor()
const openingOrbAsset = await openingOrbVfx.getAttribute('data-vfx-asset')
check('fresh combat animates Cracked Core on the Defect', () => {
  assertEqual(openingOrbAsset, 'lightning-channel')
})

await page.evaluate((run) => {
  const next = structuredClone(run)
  next.players[0].deck.push({ uid: 'abandoned-extra', defId: 'anger', upgraded: false })
  next.combat.phase = 'won'
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'won')
await openPause()
page.once('dialog', (dialog) => dialog.accept())
await pauseMenu.getByRole('button', { name: 'Return to main menu' }).click()
await page.getByRole('heading', { name: 'Slay the Spire' }).waitFor()
await page.waitForTimeout(1_100)
const abandonedFinishedCombat = await readRun()
check('returning to the menu does not resume a paused completed-combat transition', () => {
  assertEqual(abandonedFinishedCombat.phase, 'combat')
  assertEqual(abandonedFinishedCombat.combat.phase, 'won')
})
await page.getByRole('button', { name: 'Single Player', exact: true }).click()
await page.getByRole('button', { name: 'Standard', exact: true }).click()
await page.getByRole('button', { name: 'Embark' }).click()
await page.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
await page.getByRole('heading', { name: 'Neow’s Blessing' }).waitFor()
await page.waitForTimeout(100)
const abandonedRunMorphs = await page.locator('.card-morph').count()
check('starting over after abandoning a run does not replay old deck removals', () => {
  assertEqual(abandonedRunMorphs, 0)
})

// Landscape phones use a desktop layout viewport and let the browser scale it
// uniformly. This keeps one UI instead of a second mobile combat layout.
const phoneLayouts = []
const webkitBrowser = await webkit.launch({ headless: !headed })
for (const [engineName, phoneBrowser, deviceName] of [
  ['Chromium', browser, 'iPhone SE landscape'],
  ['Chromium', browser, 'iPhone 15 Pro Max landscape'],
  ['Chromium', browser, 'Pixel 7 landscape'],
  ['WebKit', webkitBrowser, 'iPhone SE landscape'],
  ['WebKit', webkitBrowser, 'iPhone 15 Pro Max landscape'],
]) {
  const phoneContext = await phoneBrowser.newContext({ ...devices[deviceName] })
  const phonePage = installScreenAudit(await phoneContext.newPage())
  auditErrors(phonePage)
  const tap = async (locator) => {
    if (engineName === 'Chromium') return locator.tap()
    // Playwright's touchscreen takes viewport coordinates, and `boundingBox`
    // reports a box that may be off screen — a node below the fold was tapped
    // at a point that resolved to whatever was scrolled into that spot instead.
    // Harmless for a menu key that is always in view; decisive for a 52px map
    // node in the bottom row.
    await locator.scrollIntoViewIfNeeded({ timeout: 5000 })
    const box = await locator.boundingBox()
    assert(box, `${engineName} could not locate the touch target`)
    const viewport = await phonePage.evaluate(() => ({
      left: visualViewport.offsetLeft, top: visualViewport.offsetTop, scale: visualViewport.scale,
    }))
    await phonePage.touchscreen.tap(
      (box.x + box.width / 2 - viewport.left) * viewport.scale,
      (box.y + box.height / 2 - viewport.top) * viewport.scale,
    )
  }
  await phonePage.goto(base, { waitUntil: 'networkidle' })
  await tap(phonePage.getByRole('button', { name: 'Single Player' }))
  await tap(phonePage.getByRole('button', { name: 'Standard' }))
  await tap(phonePage.getByRole('button', { name: 'Ironclad' }))
  await tap(phonePage.getByRole('button', { name: 'Embark' }))
  await tap(phonePage.getByRole('button', { name: 'Start standard campaign', exact: true }))
  await phonePage.waitForFunction(() => window.__STS_DEBUG__?.getRun().phase === 'neow')
  await phonePage.evaluate((run) => window.__STS_DEBUG__.setRun(run), combatAppearanceRun)
  await phonePage.locator('.combat').waitFor()
  await phonePage.waitForFunction(() => [...document.querySelectorAll('.hand .card')].every((card) =>
    card.getAnimations().every((animation) => animation.playState === 'finished')))
  const layout = await phonePage.evaluate(() => {
    const visible = (selector) => {
      const element = document.querySelector(selector)
      if (!element) return false
      const box = element.getBoundingClientRect()
      return box.left >= -4 && box.top >= -4 && box.right <= innerWidth + 4 && box.bottom <= innerHeight + 4
    }
    const cards = [...document.querySelectorAll('.hand .card')]
    const cardProbe = cards[0]
    cardProbe?.classList.add('card--unplayable')
    const unplayableFilter = cardProbe ? getComputedStyle(cardProbe).filter : 'none'
    cardProbe?.classList.remove('card--unplayable')
    cardProbe?.classList.add('card--selected')
    const selectedCue = cardProbe ? getComputedStyle(cardProbe).boxShadow : 'none'
    cardProbe?.classList.remove('card--selected')
    return {
      width: innerWidth,
      height: innerHeight,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      requiredRegions: ['.app-shell__header', '.combat__bar', '.board', '.row--viewer', '.hand-area', '.combat__end-turn']
        .every(visible),
      cardCount: cards.length,
      fallbackIllustrations: document.querySelectorAll('.hand .card-face__illustration:is(img)').length,
      mobilePerformance: document.documentElement.dataset.mobilePerformance === 'true',
      ambientAnimations: [...document.querySelectorAll(
        '.seat__portrait > img, .enemy__portrait > .enemy__art--cutout, .stance-aura',
      )].some((element) => element.getAnimations().some((animation) =>
        animation.effect?.getTiming().iterations === Infinity)) ||
        [...document.querySelectorAll('.token--orb:not(.token--orb-empty)')]
          .some((orb) => getComputedStyle(orb, '::before').animationName !== 'none') ||
        getComputedStyle(document.querySelector('.pip--energy'), '::after').animationName !== 'none',
      unplayableFilter,
      selectedCue,
      clippedCards: cards.filter((card) => {
        const box = card.getBoundingClientRect()
        return box.left < -1 || box.right > innerWidth + 1 || box.top < -1 || box.bottom > innerHeight + 1
      }).length,
      mobileRules: matchMedia('(max-width: 760px)').matches || matchMedia('(max-height: 600px)').matches,
    }
  })
  const populatedHandLayout = await phonePage.locator('.combat').evaluate((combat) => {
    const hand = combat.querySelector('.hand-area')
    const board = combat.querySelector('.board')
    return {
      hand: hand.getBoundingClientRect().toJSON(),
      board: board.getBoundingClientRect().toJSON(),
      background: getComputedStyle(hand).backgroundImage,
    }
  })
  await phonePage.evaluate(() => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.combat.players[0].hand = []
    debug.setRun(run)
  })
  await phonePage.waitForFunction(() => document.querySelector('.hand')?.getAttribute('data-count') === '0')
  const emptyHandLayout = await phonePage.locator('.combat').evaluate((combat) => {
    const hand = combat.querySelector('.hand-area')
    const board = combat.querySelector('.board')
    return {
      hand: hand.getBoundingClientRect().toJSON(),
      board: board.getBoundingClientRect().toJSON(),
      background: getComputedStyle(hand).backgroundImage,
    }
  })
  layout.handTransparent = populatedHandLayout.background === 'none' && emptyHandLayout.background === 'none'
  layout.handStable = ['top', 'height'].every((key) =>
    Math.abs(populatedHandLayout.hand[key] - emptyHandLayout.hand[key]) <= 1 &&
    Math.abs(populatedHandLayout.board[key] - emptyHandLayout.board[key]) <= 1)
  await phonePage.evaluate((run) => window.__STS_DEBUG__.setRun(run), retargetRun)
  await phonePage.waitForFunction((count) => document.querySelectorAll('.hand .card').length === count,
    retargetRun.combat.players[0].hand.length)
  await tap(phonePage.getByRole('button', { name: 'Map' }))
  const mapDialog = phonePage.getByRole('dialog', { name: /Act .* map/ })
  await mapDialog.waitFor()
  Object.assign(layout, await mapDialog.evaluate((dialog) => ({
    mapBackdropFilter: getComputedStyle(dialog, '::backdrop').backdropFilter,
    mapHerePresent: Boolean(document.querySelector('.map .room--here')),
    mapHereAnimation: document.querySelector('.map .room--here')
      ? getComputedStyle(document.querySelector('.map .room--here'), '::after').animationName
      : 'none',
  })))
  await tap(mapDialog.getByRole('button', { name: 'Close' }))
  await tap(phonePage.getByRole('button', { name: 'Settings' }))
  const settingsDialog = phonePage.getByRole('dialog', { name: 'Settings' })
  await settingsDialog.waitFor()
  await tap(settingsDialog.getByRole('button', { name: 'audio' }))
  Object.assign(layout, await settingsDialog.evaluate((dialog) => {
    const dialogBox = dialog.getBoundingClientRect()
    const cards = [...dialog.querySelectorAll('.settings-volume')]
    return {
      settingsBackdropFilter: getComputedStyle(dialog, '::backdrop').backdropFilter,
      settingsRepeatedHeadings: dialog.querySelectorAll('[role="tabpanel"] h3').length,
      settingsAudioContained: cards.every((card) => {
        const cardBox = card.getBoundingClientRect()
        const sliderBox = card.querySelector('input[type="range"]')?.getBoundingClientRect()
        return cardBox.left >= dialogBox.left && cardBox.right <= dialogBox.right && sliderBox &&
          sliderBox.left >= cardBox.left && sliderBox.right <= cardBox.right
      }),
    }
  }))
  await phonePage.screenshot({
    path: join(outDir, `phone-settings-audio-${engineName.toLowerCase()}-${deviceName.replaceAll(' ', '-').toLowerCase()}.png`),
    scale: 'css',
  })
  await tap(settingsDialog.getByRole('button', { name: /Back/ }))
  await phonePage.screenshot({ path: join(outDir, `phone-${engineName.toLowerCase()}-${deviceName.replaceAll(' ', '-').toLowerCase()}.png`), scale: 'css' })


  if (deviceName === 'iPhone SE landscape') {
    const before = await phonePage.evaluate(() => window.__STS_DEBUG__.getState().players[0].hand.length)
    const attackIndex = await phonePage.evaluate(() => window.__STS_DEBUG__.getState().players[0].hand
      .findIndex((card) => card.defId.startsWith('strike')))
    assert(attackIndex >= 0, 'phone fixture needs an attack card')
    const attackCard = phonePage.locator('.hand .card').nth(attackIndex)
    await tap(attackCard)
    await tap(attackCard)
    await tap(phonePage.locator('.enemy--targeted .enemy__hit-area').first())
    await phonePage.waitForFunction((count) => window.__STS_DEBUG__.getState().players[0].hand.length < count, before)

    await phonePage.setViewportSize({ width: 568, height: 320 })
    await phonePage.waitForFunction(() => innerWidth >= 1280 && innerHeight >= 700)
  } else {
    await phonePage.evaluate(() => {
      const run = structuredClone(window.__STS_DEBUG__.getRun())
      const player = run.combat.players[0]
      if (player.hand.filter((card) => card.defId.startsWith('strike')).length < 2) {
        player.hand.push({ uid: 'mobile-cancel-strike', defId: 'strike_ironclad', upgraded: false })
        window.__STS_DEBUG__.setRun(run)
      }
    })
    await phonePage.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hand
      .filter((card) => card.defId.startsWith('strike')).length >= 2)
    const before = await phonePage.evaluate(() => window.__STS_DEBUG__.getState().players[0].hand.length)
    const attackIndex = await phonePage.evaluate(() => window.__STS_DEBUG__.getState().players[0].hand
      .findIndex((card) => card.defId.startsWith('strike')))
    assert(attackIndex >= 0, 'mobile drag fixture needs an attack card')
    const card = phonePage.locator('.hand .card').nth(attackIndex)
    const enemy = phonePage.locator('.enemy:not(.enemy--dead) .enemy__hit-area').first()
    const cardBox = await card.boundingBox()
    const enemyBox = await enemy.boundingBox()
    assert(cardBox && enemyBox, `${engineName} ${deviceName}: mobile drag fixtures are not visible`)
    const startX = cardBox.x + cardBox.width / 2
    const startY = cardBox.y + cardBox.height / 2
    const realTouch = engineName === 'Chromium' && deviceName === 'Pixel 7 landscape'
    const cdp = realTouch ? await phoneContext.newCDPSession(phonePage) : null
    let pointer = { x: startX, y: startY }
    const touchPoint = (point) => ({
      x: point.x,
      y: point.y,
      id: 1,
      radiusX: 1,
      radiusY: 1,
    })
    const pointerDown = async () => {
      if (cdp) {
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchStart', touchPoints: [touchPoint(pointer)],
        })
      } else {
        await phonePage.mouse.move(pointer.x, pointer.y)
        await phonePage.mouse.down()
      }
    }
    const pointerMove = async (x, y, steps) => {
      if (cdp) {
        const from = pointer
        for (let step = 1; step <= steps; step += 1) {
          const point = {
            x: from.x + (x - from.x) * step / steps,
            y: from.y + (y - from.y) * step / steps,
          }
          await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove', touchPoints: [touchPoint(point)],
          })
        }
      } else await phonePage.mouse.move(x, y, { steps })
      pointer = { x, y }
    }
    const pointerUp = async (cancel = false) => {
      if (cdp) {
        await cdp.send('Input.dispatchTouchEvent', {
          type: cancel ? 'touchCancel' : 'touchEnd', touchPoints: [],
        })
      } else await phonePage.mouse.up()
    }
    await pointerDown()
    const previewX = realTouch ? startX : startX - 24
    await pointerMove(previewX, startY - 35, 3)
    await phonePage.locator('.card-drag').waitFor()
    const firstTransform = await phonePage.locator('.card-drag').evaluate((preview) =>
      getComputedStyle(preview).transform)
    await pointerMove(realTouch ? startX : startX - 48, startY - 75, 3)
    await phonePage.evaluate(() => new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const secondTransform = await phonePage.locator('.card-drag').evaluate((preview) =>
      getComputedStyle(preview).transform)
    await pointerMove(enemyBox.x + enemyBox.width / 2, enemyBox.y + enemyBox.height / 2, 8)
    await phonePage.locator('.enemy--targeted').first().waitFor()
    // Read in the same evaluation that waits, rather than waiting for the
    // glow and then going back for it. Targeting moves while the pointer
    // settles, so between the two calls the first `.enemy--targeted` could be a
    // different element than the one the wait was satisfied by — which read as
    // "drag target feedback is invisible" on a board that was showing it.
    const targetFeedback = await phonePage.waitForFunction(() => {
      const target = document.querySelector('.enemy--targeted')
      const filter = target ? getComputedStyle(target).filter : null
      return filter && filter !== 'none' ? filter : null
    }).then((handle) => handle.jsonValue())
    await pointerUp()
    await phonePage.waitForFunction((count) =>
      window.__STS_DEBUG__.getState().players[0].hand.length < count, before)
    let cancellationCleared = true
    if (cdp) {
      const cancelIndex = await phonePage.evaluate(() => window.__STS_DEBUG__.getState().players[0].hand
        .findIndex((held) => held.defId.startsWith('strike')))
      assert(cancelIndex >= 0, 'mobile pointer-cancel fixture needs a second attack card')
      const cancelCard = phonePage.locator('.hand .card').nth(cancelIndex)
      const cancelBox = await cancelCard.boundingBox()
      assert(cancelBox, 'mobile pointer-cancel card is not visible')
      pointer = { x: cancelBox.x + cancelBox.width / 2, y: cancelBox.y + cancelBox.height / 2 }
      await pointerDown()
      await pointerMove(pointer.x, pointer.y - 35, 3)
      await phonePage.locator('.card-drag').waitFor()
      await pointerUp(true)
      await phonePage.locator('.card-drag').waitFor({ state: 'detached' })
      cancellationCleared = await phonePage.evaluate((count) =>
        window.__STS_DEBUG__.getState().players[0].hand.length === count, before - 1)
      await cdp.detach()
    }
    layout.drag = {
      previewMoved: firstTransform !== secondTransform,
      targetFeedback,
      played: true,
      realTouch,
      cancellationCleared,
    }
  }
  // Every panel that explains a thing — what a room holds, what a relic does,
  // what a potion costs you — opens on hover, which a phone does not have. The
  // tap that would reach them is also the tap that COMMITS, so on touch these
  // surfaces read first and act on a second tap. Asserted per device, because
  // the engines disagree about what a touch even dispatches.
  //
  // LAST in the iteration on purpose. These cases walk the app through a map,
  // a combat and an event screen, and handing a settled board back to the
  // checks above turned out to be worth more care than it was worth taking:
  // reading a run back in deals a fresh hand, and the drag case measured a
  // card's box while it was still on its way in. Nothing follows this, so
  // nothing has to be handed back.
  await phonePage.evaluate((run) => window.__STS_DEBUG__.setRun({
    ...run,
    // TWO relics: one chip cannot collide with itself, and every tip in the bar
    // opens at the same anchored rect — so a second open panel is the failure
    // this owns-one-open-chip arrangement exists to prevent.
    players: run.players.map((player) => ({
      ...player,
      relics: [{ defId: 'akabeko', spent: false }, { defId: 'anchor', spent: false }],
    })),
  }), mapBeforeRoomSwitchCheck)
  // Wait for THESE relics, not merely for a chip. Reading a run in replaces the
  // bar's chips with new elements (their React keys carry the relic id), and a
  // locator that resolves on "some chip" can hand back the outgoing node — the
  // tap then lands on an element React detaches a frame later and is simply
  // lost, which is what left the panel closed on every device at once.
  const relicChips = phonePage.locator('.app-shell__header .relic-bar .relic-chip')
  await phonePage.locator('.app-shell__header .relic-chip[aria-label^="Akabeko"]').waitFor()
  await phonePage.locator('.app-shell__header .relic-chip[aria-label^="Anchor"]').waitFor()
  const readRelicBar = () => phonePage.evaluate(() => {
    const chips = [...document.querySelectorAll('.app-shell__header .relic-bar .relic-chip')]
    return {
      visible: chips.filter((chip) => {
        const tip = chip.querySelector('.relic-tip')
        return tip && getComputedStyle(tip).visibility === 'visible'
      }).length,
      // The attribute is the mechanism under test. Visibility alone cannot fail:
      // `:hover` and `:focus-within` open the same panel, so a tap that focused
      // the chip would satisfy it with `data-tip-open` deleted entirely.
      open: chips.filter((chip) => chip.dataset.tipOpen === 'true').length,
    }
  })
  const relicClosed = await readRelicBar()
  await tap(relicChips.first())
  // Both conditions, because they are two different claims: that the tap set the
  // attribute, and that the attribute is what puts the panel on screen. Waiting
  // on the attribute alone raced the panel's own visibility transition.
  await phonePage.waitForFunction(() => {
    const chip = document.querySelector('.relic-chip[data-tip-open="true"]')
    const tip = chip?.querySelector('.relic-tip')
    return Boolean(tip && getComputedStyle(tip).visibility === 'visible')
  }, null, { timeout: 4000 })
  const relicOpened = await readRelicBar()
  // Hit-testing, not the side effect: a click-through panel would ALSO end with
  // the panel closed, because the tap-away listener would fire on whatever it
  // landed on instead. Only this says the tap reached the panel.
  layout.relicPanelTakesTaps = await phonePage.evaluate(() => {
    const tip = document.querySelector('.relic-chip[data-tip-open="true"] .relic-tip')
    if (!tip) return false
    const box = tip.getBoundingClientRect()
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
    return Boolean(hit && tip.contains(hit))
  })
  await tap(phonePage.locator('.relic-chip[data-tip-open="true"] .relic-tip').first())
  await phonePage.waitForFunction(() => !document.querySelector('.relic-chip[data-tip-open="true"]'),
    null, { timeout: 4000 })
  await phonePage.waitForFunction(() => [...document.querySelectorAll('.app-shell__header .relic-tip')]
    .every((tip) => getComputedStyle(tip).visibility === 'hidden'), null, { timeout: 4000 })
  layout.relicPanelTapCloses = (await readRelicBar()).open === 0
  await tap(relicChips.first())
  await phonePage.waitForFunction(() => document.querySelector('.relic-chip[data-tip-open="true"]'),
    null, { timeout: 4000 })
  // Asserted in its own right: if this re-open silently failed, the switch case
  // below would be satisfied by the second chip alone and would no longer be
  // testing that opening one panel closes another.
  layout.relicTap = { reopened: await readRelicBar() }
  await tap(relicChips.nth(1))
  // `visibility` is transitioned, so it lags the attribute that drives it —
  // reading the moment the attribute flips catches the panel mid-fade and the
  // measurement disagrees with itself. Settle on the rendered state.
  await phonePage.waitForFunction(() => {
    const chips = [...document.querySelectorAll('.app-shell__header .relic-bar .relic-chip')]
    const shown = chips.filter((chip) => {
      const tip = chip.querySelector('.relic-tip')
      return tip && getComputedStyle(tip).visibility === 'visible'
    })
    return chips[1]?.dataset.tipOpen === 'true' && shown.length === 1
  }, null, { timeout: 4000 })
  const relicSwitched = await readRelicBar()
  await tap(relicChips.nth(1))
  await phonePage.waitForFunction(() => !document.querySelector('.relic-chip[data-tip-open="true"]') &&
    [...document.querySelectorAll('.app-shell__header .relic-tip')]
      .every((tip) => getComputedStyle(tip).visibility === 'hidden'),
  null, { timeout: 4000 })
  Object.assign(layout.relicTap, {
    closed: relicClosed, opened: relicOpened, switched: relicSwitched, reclosed: await readRelicBar(),
  })

  layout.mapHint = await phonePage.locator('.map__hint').textContent()
  const phoneRoom = phonePage.locator('.map:not([inert]) .room--reachable').first()
  await phoneRoom.waitFor()
  const aimedRoom = await phoneRoom.getAttribute('data-room')
  await tap(phoneRoom)
  await phonePage.waitForFunction(() => document.querySelector('.room--reading'),
    null, { timeout: 4000 })
  layout.mapTap = await phonePage.evaluate((aimed) => {
    const node = document.querySelector('.room--reading')
    return {
      phase: window.__STS_DEBUG__.getRun().phase,
      reading: document.querySelectorAll('.room--reading').length,
      readTheAimedRoom: node?.dataset.room === aimed,
      tip: node?.querySelector('.room-tip')
        ? getComputedStyle(node.querySelector('.room-tip')).visibility
        : 'missing',
      // `visibility` is not the question a player asks. The rows run bottom-up,
      // so the opening row sits lowest and its panel used to open past the fold
      // — visible, and entirely unreadable.
      // `.map` scrolls, so `.map` clips: a panel inside the window but outside
      // the scrollport is cut with nothing on screen to say so.
      tipOnScreen: (() => {
        const box = node?.querySelector('.room-tip')?.getBoundingClientRect()
        const port = node?.closest('.map')?.getBoundingClientRect()
        return Boolean(box && port && box.top >= port.top - 1 && box.bottom <= port.bottom + 1)
      })(),
      flipped: node?.getAttribute('data-tip-flip') ?? '',
      // An open panel lies across the row below it and belongs to its own
      // node's button, so a tap meant for the room underneath would otherwise
      // enter the room being read.
      tipTakesTaps: node?.querySelector('.room-tip')
        ? getComputedStyle(node.querySelector('.room-tip')).pointerEvents !== 'none'
        : false,
      confirm: node?.querySelector('.room-tip__confirm')?.textContent ?? '',
    }
  }, aimedRoom)
  // The board screenshot above is taken before any of this, so without one here
  // the artefacts a human reviews show none of the surfaces this block is about.
  await phonePage.waitForFunction(() => {
    const tip = document.querySelector('.room--reading .room-tip')
    return tip && getComputedStyle(tip).opacity === '1' &&
      tip.getAnimations().every((animation) => animation.playState === 'finished')
  }, null, { timeout: 4000 })
  await phonePage.screenshot({
    path: join(outDir, `phone-tap-read-${engineName.toLowerCase()}-${deviceName.replaceAll(' ', '-').toLowerCase()}.png`),
    scale: 'css',
  })
  await tap(phoneRoom)
  await phonePage.waitForFunction(() => window.__STS_DEBUG__.getRun().phase !== 'map',
    null, { timeout: 6000 })
  Object.assign(layout.mapTap, await phonePage.evaluate((aimed) => ({
    enteredPhase: window.__STS_DEBUG__.getRun().phase,
    // Entering the WRONG room is the harm this two-step prevents, so the room
    // that was actually walked into is the thing worth pinning.
    enteredTheAimedRoom: window.__STS_DEBUG__.getRun().map.position === aimed,
  }), aimedRoom))

  await phonePage.waitForFunction(() => !document.documentElement.dataset.mapTransition,
    null, { timeout: 2000 })
  await phonePage.evaluate((run) => window.__STS_DEBUG__.setRun(run), combatAppearanceRun)
  await phonePage.locator('.combat').waitFor()
  await phonePage.evaluate(() => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.combat.phase = 'player'
    run.combat.players[0].potions = ['energy_potion']
    debug.setRun(run)
  })
  const phonePotion = phonePage.locator(
    `.combat__actions .potion-chip button[aria-label="Use ${potionDef('energy_potion').name}"]`)
  await phonePotion.waitFor()
  const potionsHeld = await phonePage.evaluate(() =>
    window.__STS_DEBUG__.getState().players[0].potions.length)
  await tap(phonePotion)
  await phonePage.locator('.potion-tip').first().waitFor({ timeout: 4000 })
  layout.potionTap = await phonePage.evaluate((held) => {
    const tip = document.querySelector('.potion-tip')
    const box = tip?.getBoundingClientRect()
    return {
      stillHeld: window.__STS_DEBUG__.getState().players[0].potions.length === held,
      rules: tip?.querySelector('.relic-tip__text')?.textContent ?? '',
      confirm: tip?.querySelector('.relic-tip__confirm')?.textContent ?? '',
      // A panel in the DOM but invisible, or placed off screen, satisfies every
      // text assertion while telling the player nothing.
      onScreen: Boolean(tip && getComputedStyle(tip).visibility !== 'hidden' && box &&
        box.top >= 0 && box.bottom <= window.innerHeight + 1),
      // One panel at a time is the whole point of `claimTooltip`.
      tips: document.querySelectorAll('.potion-tip').length,
    }
  }, potionsHeld)
  // WebKit can drop a second synthetic touchscreen coordinate after the fixed
  // read-first panel opens. The first tap above already proves hit-testing;
  // invoke the same live button's native click to verify the commit path.
  await phonePotion.evaluate((button) => button.click())
  await phonePage.waitForFunction((held) =>
    window.__STS_DEBUG__.getState().players[0].potions.length < held, potionsHeld,
  { timeout: 6000 })
  layout.potionTap.drankOnSecondTap = await phonePage.evaluate((held) =>
    window.__STS_DEBUG__.getState().players[0].potions.length < held, potionsHeld)
  layout.potionTap.expectedRules = potionDef('energy_potion').text

  // Tapping away must DISARM, not merely hide: a panel raised by a stray tap
  // that left the button armed would spend the next potion the player pressed.
  // Relic option buttons keep their rules in a `title` a touchscreen cannot
  // open, so the prose is printed instead where there is no hover.
  await phonePage.evaluate((run) => window.__STS_DEBUG__.setRun({
    ...run,
    phase: 'room',
    combat: null,
    players: run.players.map((player, index) => index === 0
      ? { ...player, hp: 1, gold: 0, potions: ['blood_potion'], relics: [{ defId: 'akabeko', spent: false }] }
      : player),
    roomState: { kind: 'event', decisions: {}, dieRolls: {}, card: {
      id: 'the_joust', instanceId: 'phone-joust', act: 2, minAscension: 0,
      requiresColorlessUnlock: false, name: 'The Joust', scope: 'player',
      options: [{ id: 'bet', label: 'Bet', description: 'Pay 2 Gold, a Relic, or a Potion.',
        effects: [{ tag: 'pay-gold', amount: 2, filter: 'or lose one Relic or Potion' }] }],
    } },
  }), mapBeforeRoomSwitchCheck)
  await tap(phonePage.getByRole('button', { name: /\[Bet\]/ }))
  await phonePage.locator('.relic-option__text').first().waitFor({ timeout: 8000 })
  const beltPotion = phonePage.getByRole('button', { name: `Use ${potionDef('blood_potion').name}` })
  await phonePage.waitForFunction(() => {
    const run = window.__STS_DEBUG__.getRun()
    return run.phase === 'room' && run.combat === null &&
      run.players[0].potions.length === 1 && run.players[0].potions[0] === 'blood_potion'
  })
  await beltPotion.waitFor()
  const beltPotionsHeld = await phonePage.evaluate(() =>
    window.__STS_DEBUG__.getRun().players[0].potions.length)
  assertEqual(beltPotionsHeld, 1, `${engineName} ${deviceName}: belt potion fixture did not settle`)
  await tap(beltPotion)
  await phonePage.locator('.potion-tip').first().waitFor({ timeout: 4000 })
  layout.beltPotion = await phonePage.evaluate((held) => {
    const tip = document.querySelector('.potion-tip')
    const box = tip?.getBoundingClientRect()
    return {
      stillHeld: window.__STS_DEBUG__.getRun().players[0].potions.length === held,
      rules: tip?.querySelector('.relic-tip__text')?.textContent ?? '',
      confirm: tip?.querySelector('.relic-tip__confirm')?.textContent ?? '',
      onScreen: Boolean(tip && getComputedStyle(tip).visibility !== 'hidden' && box &&
        box.top >= 0 && box.bottom <= window.innerHeight + 1),
      tips: document.querySelectorAll('.potion-tip').length,
    }
  }, beltPotionsHeld)
  await tap(beltPotion)
  await phonePage.waitForFunction((held) =>
    window.__STS_DEBUG__.getRun().players[0].potions.length < held, beltPotionsHeld,
  { timeout: 6000 })
  layout.beltPotion.drankOnSecondTap = await phonePage.evaluate((held) =>
    window.__STS_DEBUG__.getRun().players[0].potions.length < held, beltPotionsHeld)
  layout.beltPotion.expectedRules = potionDef('blood_potion').text
  // Playwright's accessible-name computation, which is the only thing here that
  // actually resolves one. A substring test against the button's own text can
  // never fail, because the span is inside the button either way.
  layout.relicOptionNamed = await phonePage.getByRole('button', {
    name: new RegExp(relicDef('akabeko').text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  }).count()
  layout.relicOption = await phonePage.evaluate(() => {
    const text = document.querySelector('.relic-option__text')
    const button = text?.closest('button')
    if (!text || !button) return { printed: false, titled: null, stacked: false }
    const textBox = text.getBoundingClientRect()
    const label = button.querySelector('.item-card-image, .item-icon-image')?.getBoundingClientRect()
    return {
      printed: getComputedStyle(text).display !== 'none' && (text.textContent ?? '').length > 0,
      // The `title` would otherwise be announced as a description saying the
      // same sentence the name now carries.
      titled: button.getAttribute('title'),
      // Its own line, rather than beside the name on whichever relic happens to
      // have a short enough sentence.
      stacked: Boolean(label && textBox.top >= label.bottom - 1),
    }
  })

  // The flip only fires for a node with no room beneath it inside the map's own
  // scrollport, which the opening choice may or may not be. Read the lowest node
  // on the board explicitly so the branch is exercised somewhere.
  await phonePage.evaluate((run) => window.__STS_DEBUG__.setRun(run), mapBeforeRoomSwitchCheck)
  await phonePage.locator('.map:not([inert]) .room--reachable').first().waitFor()
  const lowestRoom = await phonePage.evaluate(async () => {
    const map = document.querySelector('.map:not([inert])')
    if (!map) return null
    map.scrollTop = map.scrollHeight
    await new Promise((resolve) => requestAnimationFrame(resolve))
    const port = map.getBoundingClientRect()
    const rooms = [...map.querySelectorAll('.room')]
    const lowest = rooms.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0]
    if (!lowest) return null
    map.scrollTop += lowest.getBoundingClientRect().bottom - port.bottom + 8
    await new Promise((resolve) => requestAnimationFrame(resolve))
    return lowest?.dataset.room ?? null
  })
  if (lowestRoom) {
    await phonePage.locator(`.map:not([inert]) [data-room="${lowestRoom}"]`).evaluate((node) =>
      node.scrollIntoView({ block: 'end' }))
    await phonePage.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await tap(phonePage.locator(`.map:not([inert]) [data-room="${lowestRoom}"]`))
    await phonePage.waitForFunction(() => document.querySelector('.room--reading'),
      null, { timeout: 4000 })
    layout.lowRoom = await phonePage.evaluate(() => {
      const node = document.querySelector('.room--reading')
      if (!node) return null
      const tip = node.querySelector('.room-tip')
      const box = tip?.getBoundingClientRect()
      const port = node.closest('.map')?.getBoundingClientRect()
      return {
        flipped: node.getAttribute('data-tip-flip') ?? '',
        insidePort: Boolean(box && port && box.top >= port.top - 1 && box.bottom <= port.bottom + 1),
      }
    })
  }

  phoneLayouts.push({ deviceName: `${engineName} ${deviceName}`, ...layout })
  await phoneContext.close()
}

await webkitBrowser.close()
check('landscape phones render and play the complete desktop combat UI', () => {
  for (const layout of phoneLayouts) {
    assert(layout.width >= 1280 && layout.height >= 700, `${layout.deviceName}: ${layout.width}x${layout.height}`)
    assert(!layout.mobileRules, `${layout.deviceName}: mobile CSS is active`)
    assert(!layout.horizontalOverflow, `${layout.deviceName}: document overflows horizontally`)
    assert(layout.requiredRegions, `${layout.deviceName}: required combat information is missing or clipped`)
    assert(layout.handTransparent, `${layout.deviceName}: hand paints a black separation bar`)
    assert(layout.handStable, `${layout.deviceName}: combat reflows when the hand changes between empty and populated`)
    assert(layout.cardCount > 0, `${layout.deviceName}: hand is missing`)
    assertEqual(layout.fallbackIllustrations, 0, `${layout.deviceName}: hidden fallback card art was decoded`)
    assert(layout.mobilePerformance, `${layout.deviceName}: mobile performance mode is inactive`)
    assert(!layout.ambientAnimations, `${layout.deviceName}: ambient combat animations are still running`)
    assert(layout.unplayableFilter !== 'none', `${layout.deviceName}: unplayable cards lost their visual cue`)
    assert(layout.selectedCue !== 'none', `${layout.deviceName}: selected cards lost their visual cue`)
    assert(layout.mapBackdropFilter === 'none', `${layout.deviceName}: map backdrop still blurs`)
    assert(layout.settingsBackdropFilter === 'none', `${layout.deviceName}: settings backdrop still blurs`)
    assertEqual(layout.settingsRepeatedHeadings, 0, `${layout.deviceName}: settings repeated the selected tab label`)
    assert(layout.settingsAudioContained, `${layout.deviceName}: an audio slider clips its control card`)
    assert(layout.mapHerePresent, `${layout.deviceName}: map location probe is missing`)
    assert(layout.mapHereAnimation === 'none', `${layout.deviceName}: map location ring still animates`)
    if (layout.drag) {
      assert(layout.drag.previewMoved, `${layout.deviceName}: same-target drag preview did not move`)
      assert(layout.drag.targetFeedback !== 'none', `${layout.deviceName}: drag target feedback is invisible`)
      assert(layout.drag.played, `${layout.deviceName}: dragging a card did not play it`)
      if (layout.drag.realTouch) {
        assert(layout.drag.cancellationCleared, `${layout.deviceName}: pointer cancellation changed the hand`)
      }
    }
    assertEqual(layout.clippedCards, 0, `${layout.deviceName}: clipped cards`)
  }
})

// A phone cannot hover, so every panel that explains a room, a relic or a potion
// is reached by the same tap that would COMMIT to it. These surfaces read on the
// first tap and act on the second; this is that contract, per device, because
// the engines disagree about what a touch dispatches.
check('phones can read a hover-only panel before committing to it', () => {
  for (const layout of phoneLayouts) {
    assertEqual(layout.relicTap.closed.visible, 0, `${layout.deviceName}: a relic panel was open before any tap`)
    assertEqual(layout.relicTap.opened.open, 1, `${layout.deviceName}: tapping a relic did not open its panel`)
    assertEqual(layout.relicTap.opened.visible, 1, `${layout.deviceName}: a tapped relic panel is not visible`)
    assert(layout.relicPanelTakesTaps,
      `${layout.deviceName}: an open relic panel is click-through — a tap on it presses whatever it covers`)
    assert(layout.relicPanelTapCloses, `${layout.deviceName}: tapping the panel did not close it`)
    assertEqual(layout.relicTap.reopened.open, 1,
      `${layout.deviceName}: the panel did not reopen, so the switch case below proves nothing`)
    assertEqual(layout.relicTap.switched.open, 1,
      `${layout.deviceName}: tapping a second relic left ${layout.relicTap.switched.open} panels open`)
    assertEqual(layout.relicTap.switched.visible, 1,
      `${layout.deviceName}: tapping a second relic left ${layout.relicTap.switched.visible} panels on screen`)
    assertEqual(layout.relicTap.reclosed.open, 0, `${layout.deviceName}: a tapped relic panel would not close`)
    assertEqual(layout.relicTap.reclosed.visible, 0,
      `${layout.deviceName}: a closed relic panel is still on screen`)

    assert(/tap a room to read it, then tap it again to enter\./.test(layout.mapHint ?? ''),
      `${layout.deviceName}: the map never teaches the two-step tap: "${layout.mapHint}"`)
    assertEqual(layout.mapTap.phase, 'map', `${layout.deviceName}: the first tap on a room entered it`)
    assertEqual(layout.mapTap.reading, 1, `${layout.deviceName}: the first tap on a room opened no panel`)
    assert(layout.mapTap.readTheAimedRoom, `${layout.deviceName}: the tap landed on a different room`)
    assert(!layout.mapTap.tipTakesTaps, `${layout.deviceName}: an open room panel still swallows taps`)
    assertEqual(layout.mapTap.tip, 'visible', `${layout.deviceName}: a read room kept its panel hidden`)
    assert(layout.mapTap.tipOnScreen, `${layout.deviceName}: a read room opened its panel off screen`)
    // The lowest node is where the panel runs out of room below and the flip has
    // to earn its keep; wherever it lands, it must land inside the scrollport.
    assert(layout.lowRoom, `${layout.deviceName}: the lowest room was never read`)
    assert(layout.lowRoom.insidePort,
      `${layout.deviceName}: the lowest room opened its panel outside the map (flip: "${layout.lowRoom.flipped}")`)
    assertEqual(layout.mapTap.confirm, 'Tap again to enter',
      `${layout.deviceName}: the room panel does not offer its confirmation step`)
    assert(layout.mapTap.enteredPhase !== 'map',
      `${layout.deviceName}: a second tap on the same room did not enter it`)
    assert(layout.mapTap.enteredTheAimedRoom, `${layout.deviceName}: the party entered a room it never read`)

    assert(layout.potionTap.stillHeld, `${layout.deviceName}: the first tap on a potion drank it`)
    assert(layout.potionTap.onScreen, `${layout.deviceName}: the potion panel is not on screen to be read`)
    assertEqual(layout.potionTap.rules, layout.potionTap.expectedRules,
      `${layout.deviceName}: a tapped potion printed the wrong rules`)
    assertEqual(layout.potionTap.confirm, 'Tap again to drink',
      `${layout.deviceName}: the potion panel does not say what the next tap does`)
    assert(layout.potionTap.drankOnSecondTap, `${layout.deviceName}: a second tap did not drink the potion`)
    assertEqual(layout.potionTap.tips, 1, `${layout.deviceName}: ${layout.potionTap.tips} potion panels were open at once`)

    assert(layout.beltPotion.stillHeld, `${layout.deviceName}: the first tap on a belt potion drank it`)
    assertEqual(layout.beltPotion.rules, layout.beltPotion.expectedRules,
      `${layout.deviceName}: a tapped belt potion printed the wrong rules`)
    assertEqual(layout.beltPotion.confirm, 'Tap again to drink',
      `${layout.deviceName}: the belt panel does not say what the next tap does`)
    assert(layout.beltPotion.onScreen, `${layout.deviceName}: the belt potion panel is not on screen to be read`)
    assertEqual(layout.beltPotion.tips, 1,
      `${layout.deviceName}: ${layout.beltPotion.tips} belt potion panels were open at once`)
    assert(layout.beltPotion.drankOnSecondTap,
      `${layout.deviceName}: a second tap did not drink the belt potion`)

    assert(layout.relicOption.printed, `${layout.deviceName}: a relic option hid its rules from touch`)
    assertEqual(layout.relicOptionNamed, 1,
      `${layout.deviceName}: relic option rules are not in the button's accessible name`)
    assertEqual(layout.relicOption.titled, null,
      `${layout.deviceName}: a relic option prints its rules AND repeats them in a title`)
    assert(layout.relicOption.stacked, `${layout.deviceName}: relic option rules did not get their own line`)
  }
  // Somewhere in the matrix the panel must actually have been flipped, or the
  // branch that exists for it is guarded but never taken.
  assert(phoneLayouts.some((layout) => layout.lowRoom?.flipped === 'up'),
    `no device opened a room panel upward: ${phoneLayouts.map((layout) =>
      `${layout.deviceName}=${layout.lowRoom?.flipped || 'none'}`).join(', ')}`)
})

writeFileSync(
  join(outDir, 'summary.json'),
  JSON.stringify(
    { screenshots: shots, consoleErrors, pageErrors, requestFailures },
    null,
    2,
  ),
)

check('the browser reported no errors', () => {
  assert(consoleErrors.length === 0, `console errors:\n    ${consoleErrors.join('\n    ')}`)
  assert(pageErrors.length === 0, `page errors:\n    ${pageErrors.join('\n    ')}`)
  assert(requestFailures.length === 0, `failed requests:\n    ${requestFailures.join('\n    ')}`)
})

await browser.close()
await server.close()
report('browser')
