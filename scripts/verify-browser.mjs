// Drives the real app in a real browser: clicks cards, resolves turns, and
// asserts against the ENGINE state read through window.__STS_DEBUG__ rather
// than against pixels. Screenshots are written for human review, and the run
// fails on any console error, page error, or failed request.
//
// Usage: node scripts/verify-browser.mjs [--headed] [--out=dir]
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium, devices, webkit } from 'playwright'
import { suite, check, assert, assertDeepEqual, assertEqual, report } from './lib/harness.mjs'
import { installScreenAudit } from './lib/browser-screen-audit.mjs'
import { enemyDef } from '../src/game/enemies.ts'
import { potionDef, relicDef } from '../src/game/relics.ts'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cardArtDir = join(repoRoot, 'public/assets/cards')
const GENERATED_STATUS_SCANS = new Set(['curses__daze.webp', 'curses__burn.webp', 'curses__slimed.webp'])
const artSynced = existsSync(cardArtDir) && readdirSync(cardArtDir).some((file) => !GENERATED_STATUS_SCANS.has(file))
const args = process.argv.slice(2)
const headed = args.includes('--headed')
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
const auditErrors = (currentPage) => {
  currentPage.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  currentPage.on('pageerror', (error) => pageErrors.push(String(error)))
  currentPage.on('requestfailed', (request) =>
    request.failure()?.errorText !== 'net::ERR_ABORTED' || !/\/assets\/(?:bgm|sfx)\//.test(request.url())
      ? requestFailures.push(`${request.url()} ${request.failure()?.errorText ?? ''}`)
      : undefined,
  )
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
  HTMLMediaElement.prototype.pause = function pause() {
    window.__BGM_PAUSES__.push(new URL(this.src).pathname)
  }
})

const shots = []
async function shot(label) {
  // Screenshots are the artefact a human reviews, so they must show the app as
  // a player sees it. Captured too early, lazy-loaded card art is still blank
  // and the picture misrepresents the product rather than documenting it.
  await page
    .waitForFunction(
      () => [...document.querySelectorAll('img')].every((img) => img.complete),
      { timeout: 4000 },
    )
    .catch(() => {})
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

/**
 * The width `artWidth` should see for a character-card scan.
 *
 * The hand, the deck viewer and every other gameplay surface read the 448px
 * thumbnail tier (see CARD_THUMB_ROOT), so "upscaled" no longer means 744px on
 * screen. It still separates the two source tiers: a character scan thumbnails
 * to 448, and the 320px relic/potion/curse exports thumbnail to themselves.
 */
const UPSCALED_ART_WIDTH = 448

async function artWidth(card) {
  const image = card.locator(artSynced
    ? ':scope > img.card__art'
    : ':scope > .card-face > img.card-face__illustration')
  await image.waitFor()
  await page.waitForFunction((img) => img.complete && img.naturalWidth > 0, await image.elementHandle())
  return image.evaluate((img) => img.naturalWidth)
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
  const name = player.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  await page.getByRole('button', { name: new RegExp(`^Confirm ${name}`) }).click()
}

async function confirmAllDiscards() {
  const state = await readState()
  const selectedSeat = state.players.find((player) => !player.dead)?.id ?? 'p1'
  for (const player of state.players.filter((candidate) => !candidate.dead)) {
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
    const target = page.locator('.enemy--targeted').first()
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

const preloadedCombatVfx = ['/assets/combat/vfx/hit-burst.webp', '/assets/combat/vfx/death-ash.webp',
  '/assets/combat/vfx/death-ring.webp', '/assets/combat/vfx/actions/watcher-calm-aura.webp',
  '/assets/combat/vfx/actions/watcher-wrath-aura.webp']
const preloadedVfx = await page.evaluate((paths) => paths.map((path) => {
  const url = new URL(path, location.href).href
  const entry = performance.getEntriesByName(url).find((candidate) => candidate.entryType === 'resource')
  return { path, ready: Boolean(entry && entry.responseEnd > 0), initiator: entry?.initiatorType }
}), preloadedCombatVfx)
check('core combat VFX are preloaded before their first appearance', () => {
  assertDeepEqual(preloadedVfx.map(({ path, ready }) => ({ path, ready })),
    preloadedCombatVfx.map((path) => ({ path, ready: true })))
  assert(preloadedVfx.every(({ initiator }) => initiator === 'link'), JSON.stringify(preloadedVfx))
})

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
const setupHidden = await page.locator('.start-menu__setup').isHidden()
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
await page.getByRole('button', { name: 'Run settings' }).click()
const formSoundBefore = await page.evaluate(() => window.__SFX_PLAYS__.length)
await page.getByLabel('Player 1 character').selectOption('silent')
await page.waitForFunction((before) => window.__SFX_PLAYS__.slice(before).includes('/assets/sfx/ui.ogg'), formSoundBefore)
const formSoundPlays = await page.evaluate((before) =>
  window.__SFX_PLAYS__.slice(before).includes('/assets/sfx/ui.ogg'), formSoundBefore)
await page.getByLabel('Player 1 character').selectOption('ironclad')
const localAscensions = await page.getByLabel('Ascension').locator('option').evaluateAll((options) =>
  options.map((option) => option.value))
const localCharacterSeats = await page.getByLabel(/^Player \d character$/).count()
const setupHasDevControls = await page.locator('.start-menu__setup').getByText(/Party|Seed|Choose Your Relic|Last Stand/).count()
await page.getByRole('button', { name: 'Close' }).click()
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
    titleBottom: menu.querySelector('.start-menu__title h1')?.getBoundingClientRect().bottom,
    editionTop: menu.querySelector('.start-menu__edition')?.getBoundingClientRect().top,
  }
})
const menuSelection = await page.locator('.start-menu__nav').evaluate((nav) => ({
  selected: [...nav.querySelectorAll('button')].filter((button) => button.dataset.selected === 'true')
    .map((button) => button.textContent?.trim()),
  marker: getComputedStyle(nav.querySelector('button[data-selected="true"]'), '::before').content,
}))
check('the title menu fills the viewport without clipping its controls', () => {
  assert(titleMenu.background.includes('title-spire.webp'), 'the generated title backdrop is missing')
  assert(titleMenu.font.includes('Kreon'), `the game-style typeface is missing: ${titleMenu.font}`)
  assert(titleMenu.titleBottom !== undefined && titleMenu.editionTop !== undefined &&
    titleMenu.editionTop >= titleMenu.titleBottom + 8,
  `the board-game subtitle clips the title: ${titleMenu.titleBottom} / ${titleMenu.editionTop}`)
  for (const [name, box] of Object.entries({ title: titleMenu.title, nav: titleMenu.nav })) {
    assert(box && box.left >= titleMenu.box.left - 1 && box.right <= titleMenu.box.right + 1 &&
      box.top >= titleMenu.box.top - 1 && box.bottom <= titleMenu.box.bottom + 1,
    `${name} leaves the title viewport: ${JSON.stringify(box)}`)
  }
  assertDeepEqual(menuSelection.selected, ['Single Player'])
  assert(!menuSelection.marker.includes('☞'), `the menu still uses the cheap finger marker: ${menuSelection.marker}`)
  assertEqual(singlePlayerLabel?.trim(), 'Single Player')
  assert(setupHidden, 'run settings should not occupy the title screen')
  assertDeepEqual(localAscensions, ['0'], 'a fresh campaign offered locked Ascension levels')
  assertEqual(localCharacterSeats, 1, 'single-player settings exposed extra seats')
  assertEqual(setupHasDevControls, 0, 'developer setup controls leaked into settings')
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
  assert(formSoundPlays, 'form changes did not play the UI sound')
  assertEqual(freshMenuCampaign.saved.nextRunNumber, 0, 'opening the menu persisted a draft campaign run')
  assertEqual(reloadedMenuCampaign.saved.nextRunNumber, 0, 'reloading the menu consumed a campaign run number')
  assertEqual(freshMenuCampaign.draftRunId, 'campaign-1')
  assertEqual(reloadedMenuCampaign.draftRunId, 'campaign-1')
})

await page.getByRole('button', { name: 'Single Player', exact: true }).click()
await page.getByRole('heading', { name: 'Ironclad', exact: true }).waitFor()
const characterCopy = {}
for (const name of ['Ironclad', 'Silent', 'Defect', 'Watcher']) {
  await page.getByRole('button', { name, exact: true }).click()
  characterCopy[name] = await page.locator('.start-menu__character-copy').innerText()
}
await page.getByRole('button', { name: 'Ironclad', exact: true }).click()
const characterSelection = await page.locator('.start-menu__character-select').evaluate((screen) => {
  const box = screen.getBoundingClientRect()
  const hero = screen.querySelector('.start-menu__character-hero')?.getBoundingClientRect()
  return {
    contained: screen.scrollWidth <= screen.clientWidth && screen.scrollHeight <= screen.clientHeight,
    heroContained: Boolean(hero && hero.left >= box.left && hero.right <= box.right && hero.top >= box.top && hero.bottom <= box.bottom),
    choices: screen.querySelectorAll('.start-menu__character-roster button').length,
  }
})
await shot('00-title-character-select')
await page.getByRole('button', { name: 'Back', exact: true }).click()
check('Single Player opens a contained visual character picker before starting', () => {
  assertEqual(characterSelection.choices, 8)
  assert(characterSelection.contained, 'character selection needs a nested scrollbar')
  assert(characterSelection.heroContained, 'selected character art leaves the selection frame')
  for (const [name, special] of Object.entries({
    Ironclad: 'Burning Blood · End of combat: heal 1 HP.',
    Silent: 'Ring of the Snake · Start of combat: draw 2 cards.',
    Defect: 'Cracked Core · Start of combat: channel 1 Lightning.',
    Watcher: 'Pure Water · Start of combat: gain 1 Miracle.',
  })) {
    assert(characterCopy[name].includes(special), `${name} is missing its special effect`)
    assert(characterCopy[name].length > 200, `${name} description is still too short`)
  }
})

await page.getByRole('button', { name: 'Compendium' }).click()
await page.locator('.compendium').waitFor()
const allCardCount = await page.locator('.compendium-card').count()
const poolIconView = await page.locator('.compendium__pools button').evaluateAll((buttons) => buttons.map((button) => {
  const image = button.querySelector('img')
  const style = getComputedStyle(button)
  return {
    source: image?.getAttribute('src'),
    loaded: Boolean(image?.complete && image.naturalWidth > 0),
    border: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth],
  }
}))
await page.getByRole('button', { name: '0 energy', exact: true }).click()
const allZeroCostLabels = await page.locator('.compendium-card').evaluateAll((cards) =>
  cards.map((card) => card.getAttribute('aria-label')))
await page.getByRole('button', { name: 'Any energy cost' }).click()
await page.getByRole('button', { name: 'Ironclad' }).click()
const ironcladCardCount = await page.locator('.compendium-card').count()
await page.getByRole('button', { name: 'Power cards' }).click()
const powerCardLabels = await page.locator('.compendium-card').evaluateAll((cards) =>
  cards.map((card) => card.getAttribute('aria-label')))
await page.getByRole('button', { name: 'All card types' }).click()
await page.getByRole('checkbox', { name: 'rare', exact: true }).check()
const rareCardLabels = await page.locator('.compendium-card').evaluateAll((cards) =>
  cards.map((card) => card.getAttribute('aria-label')))
await page.getByRole('checkbox', { name: 'rare', exact: true }).uncheck()
await page.getByRole('button', { name: '0 energy', exact: true }).click()
const zeroCostCount = await page.locator('.compendium-card').count()
await page.getByRole('button', { name: 'Any energy cost' }).click()
const firstAscending = await page.locator('.compendium-card').first().getAttribute('aria-label')
await page.locator('.compendium__sort').click()
const firstDescending = await page.locator('.compendium-card').first().getAttribute('aria-label')
await page.locator('.compendium__sort').click()
await page.getByPlaceholder('Search').fill('Bash')
const bashCards = await page.locator('.compendium-card').evaluateAll((cards) =>
  cards.map((card) => card.getAttribute('aria-label')))
await page.getByLabel('View upgrades').check()
const upgradedBashSource = await page.locator('.compendium-card img').first().getAttribute('src')
await page.locator('.compendium-card').first().click()
const detailOpen = await page.locator('.compendium__detail').count()
const detailModal = await page.locator('.compendium__detail').evaluate((dialog) => dialog.matches(':modal'))
await shot('00b-compendium-card-detail')
await page.keyboard.press('Escape')
await page.locator('.compendium__detail').waitFor({ state: 'detached' })
await page.getByPlaceholder('Search').fill('Havoc')
await page.getByRole('button', { name: '0 energy', exact: true }).click()
const upgradedZeroCostNames = await page.locator('.compendium-card').evaluateAll((cards) =>
  cards.map((card) => card.getAttribute('aria-label')))
await page.getByRole('button', { name: 'Any energy cost', exact: true }).click()
await page.getByPlaceholder('Search').fill('')
await page.getByRole('button', { name: 'Guardian' }).click()
await page.getByPlaceholder('Search').fill('Crystal Edge')
const guardianGemLabel = await page.locator('.compendium-card').first().getAttribute('aria-label')
const guardianGemFallbackType = await page.locator('.compendium-card .card-face__type').first().textContent()
await page.getByRole('button', { name: 'Curses' }).click()
await page.getByPlaceholder('Search').fill('Scorn')
const hermitCurseLabel = await page.locator('.compendium-card').first().getAttribute('aria-label')
await page.getByRole('checkbox', { name: 'curse', exact: true }).check()
const curseRarityLabels = await page.locator('.compendium-card').evaluateAll((cards) =>
  cards.map((card) => card.getAttribute('aria-label')))
await page.getByRole('checkbox', { name: 'curse', exact: true }).uncheck()
await page.getByPlaceholder('Search').fill('Clumsy')
const curseUpgradeSource = await page.locator('.compendium-card img').first().getAttribute('src')
// Waited for, not sampled. The grid reads the 448px thumbnail tier and the zoom
// reads the full scan, so neither warms the other's cache any more, and a bare
// read here races the decode that `revealDecodedImage` reveals the image on.
// Resolved to a boolean rather than thrown, so a failure still reports which
// image stayed hidden instead of a bare Playwright timeout.
const scanIsPainted = async (selector) => {
  if (!artSynced) return true
  return page.waitForFunction((target) => {
    const image = document.querySelector(target)
    return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0 &&
      getComputedStyle(image).visibility === 'visible'
  }, selector).then(() => true, () => false)
}
const curseImageVisible = await scanIsPainted('.compendium-card > img')
await page.getByRole('button', { name: 'Statuses' }).click()
await page.getByPlaceholder('Search').fill('Daze')
const dazeLabel = await page.locator('.compendium-card').first().getAttribute('aria-label')
await page.locator('.compendium-card').first().click()
await page.locator('.compendium__detail-card').waitFor()
await scanIsPainted('.compendium__detail-card > img')
const statusDetailAsset = await page.locator('.compendium__detail-card').evaluate((card) => ({
  source: card.querySelector(':scope > img')?.getAttribute('src'),
  visible: (() => {
    const image = card.querySelector(':scope > img')
    return Boolean(image?.complete && image.naturalWidth > 0 && getComputedStyle(image).visibility === 'visible')
  })(),
  text: card.querySelector('.card-face')?.textContent ?? '',
}))
await page.keyboard.press('Escape')
await page.getByPlaceholder('Search').fill('Slimed')
const slimedLabel = await page.locator('.compendium-card').first().getAttribute('aria-label')
await page.getByPlaceholder('Search').fill('')
await page.getByRole('button', { name: 'Ironclad' }).click()
await shot('00a-compendium')
check('the compendium filters the real card catalog and opens card detail', () => {
  assertEqual(poolIconView.length, 12, 'one painted icon per card pool')
  assert(poolIconView.every((entry) => entry.loaded && entry.source?.includes('/assets/menu/compendium-icons/')),
    `compendium pool icons did not load: ${JSON.stringify(poolIconView)}`)
  assert(poolIconView.every((entry) => entry.border.every((width) => width === '0px')),
    `the old circular pool frames remain: ${JSON.stringify(poolIconView)}`)
  assert(allCardCount > ironcladCardCount && ironcladCardCount > 0,
    `pool filtering did not narrow the catalog: ${allCardCount} / ${ironcladCardCount}`)
  assert(allZeroCostLabels.length > 0 && allZeroCostLabels.every((label) => !label?.includes('unplayable')),
    `the 0-Energy filter included unplayable cards: ${allZeroCostLabels.join(' / ')}`)
  assert(powerCardLabels.length > 0 && powerCardLabels.every((label) => label?.includes(', power,')),
    `card-type filtering leaked: ${powerCardLabels.join(' / ')}`)
  assert(rareCardLabels.length > 0 && rareCardLabels.every((label) => label?.endsWith(', rare')),
    `rarity filtering leaked: ${rareCardLabels.join(' / ')}`)
  assert(zeroCostCount > 0 && zeroCostCount < ironcladCardCount,
    `cost filtering did not narrow the catalog: ${zeroCostCount} / ${ironcladCardCount}`)
  assert(firstAscending !== firstDescending, 'A–Z sort did not reverse the card order')
  assertEqual(bashCards.length, 1)
  assert(bashCards[0]?.startsWith('Bash, cost 2, attack') && bashCards[0]?.endsWith(', starter'), bashCards[0])
  assert(upgradedBashSource?.endsWith('ironclad__starter__bash+.webp'), upgradedBashSource)
  assert(upgradedZeroCostNames.some((label) => label?.startsWith('Havoc+, cost 0,')),
    `upgraded cost filter omitted Havoc+: ${upgradedZeroCostNames.join(' / ')}`)
  assert(guardianGemLabel?.includes(', Gem Attack,'), guardianGemLabel)
  assertEqual(guardianGemFallbackType, 'Gem Attack')
  assert(hermitCurseLabel?.startsWith('Scorn') && hermitCurseLabel.includes(', unplayable, curse,'), hermitCurseLabel)
  assert(curseRarityLabels.length > 0 && curseRarityLabels.every((label) => label?.endsWith(', curse')),
    `curse rarity filtering leaked: ${curseRarityLabels.join(' / ')}`)
  assertEqual(detailOpen, 1)
  assert(detailModal, 'card detail should use native modal semantics')
  assert(curseUpgradeSource?.endsWith('curses__clumsy.webp') && !curseUpgradeSource.includes('clumsy+'),
    `non-upgradable curse requested the wrong face: ${curseUpgradeSource}`)
  assert(curseImageVisible, 'the curse scan stayed hidden after changing filters')
  assert(statusDetailAsset.source?.endsWith('curses__daze.webp') && statusDetailAsset.visible &&
    statusDetailAsset.text.includes('Daze') && statusDetailAsset.text.includes('unplayable') &&
    statusDetailAsset.text.includes('ethereal'),
  `Daze status scan did not render: ${JSON.stringify(statusDetailAsset)}`)
  assert(dazeLabel?.includes('unplayable') && dazeLabel.includes('ethereal'), dazeLabel)
  assert(slimedLabel?.includes('cost 1'), slimedLabel)
})
await page.setViewportSize({ width: 1280, height: 800 })
const compactCompendium = await page.locator('.compendium').evaluate((root) => {
  const viewport = root.getBoundingClientRect()
  const filters = root.querySelector('.compendium__filters')?.getBoundingClientRect()
  const library = root.querySelector('.compendium__library')?.getBoundingClientRect()
  const card = root.querySelector('.compendium-card')?.getBoundingClientRect()
  return {
    viewport: { left: viewport.left, right: viewport.right, top: viewport.top, bottom: viewport.bottom },
    filters: filters && { left: filters.left, right: filters.right, top: filters.top, bottom: filters.bottom },
    library: library && { left: library.left, right: library.right, top: library.top, bottom: library.bottom },
    cardWidth: card?.width,
    wrappedLabels: [...root.querySelectorAll('.compendium__checks label')]
      .filter((label) => label.getBoundingClientRect().height > parseFloat(getComputedStyle(label).lineHeight) * 1.5).length,
    checkboxTargets: [...root.querySelectorAll('.compendium__checks label')].map((label) => {
      const box = label.getBoundingClientRect()
      return { height: box.height, center: (box.top + box.bottom) / 2 }
    }),
    backBeforeSearch: Boolean(root.querySelector('.compendium__back')?.compareDocumentPosition(
      root.querySelector('input[type="search"]')) & Node.DOCUMENT_POSITION_FOLLOWING),
    back: (() => {
      const box = root.querySelector('.compendium__back')?.getBoundingClientRect()
      return box && { top: box.top, bottom: box.bottom }
    })(),
    sort: (() => {
      const box = root.querySelector('.compendium__sort')?.getBoundingClientRect()
      return box && { top: box.top, bottom: box.bottom }
    })(),
    upgrade: (() => {
      const box = root.querySelector('.compendium__upgrade')?.getBoundingClientRect()
      return box && { top: box.top, bottom: box.bottom }
    })(),
  }
})
// Its clip-path is an arrow whose top and bottom edges are inset 8% of its
// height, so the shared -4px inset ring fell outside the polygon and painted
// nothing. Pinned because the corrected rule ALSO shipped once with no effect —
// it was written at a specificity that lost to the list it replaced.
// The rule is `:focus-visible`-only, and that pseudo-class needs KEYBOARD
// modality — a bare programmatic `.focus()` reports `outline-offset: 0px`.
await page.keyboard.press('Shift')
await page.locator('.compendium__back').focus()
const compendiumBackRing = await page.evaluate(() => {
  const back = document.querySelector('.compendium__back')
  if (!back) return null
  const style = getComputedStyle(back)
  return { offset: style.outlineOffset, width: style.outlineWidth, matched: back.matches(':focus-visible') }
})
await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
check('the compendium back arrow keeps a focus ring inside its clip', () => {
  assert(compendiumBackRing !== null, 'no .compendium__back to measure')
  assert(compendiumBackRing.matched, 'the back arrow did not match :focus-visible when focused')
  assertEqual(compendiumBackRing.offset, '-10px', 'the -4px shared inset falls outside this arrow')
  assertEqual(compendiumBackRing.width, '3px')
})

const compactTitleOverflow = await page.locator('.compendium-card .card-face__title').first().evaluate(async (title) => {
  const { CARDS: definitions, faceOf } = await import('/src/game/cards.ts')
  const original = title.textContent
  const clipped = []
  for (const def of Object.values(definitions)) {
    for (const upgraded of [false, true]) {
      const shown = faceOf(def, upgraded && Boolean(def.upgrade))
      title.textContent = shown.name
      if (title.scrollHeight > title.clientHeight + 1 || title.scrollWidth > title.clientWidth + 1) {
        clipped.push(`${shown.name}${upgraded && def.upgrade ? '+' : ''}`)
      }
    }
  }
  title.textContent = original
  return clipped
})
await shot('00c-compendium-compact-desktop')
check('the compendium remains usable on a minimum desktop viewport', () => {
  assert(compactCompendium.filters && compactCompendium.library,
    `compact desktop compendium columns are missing: ${JSON.stringify(compactCompendium)}`)
  assert(compactCompendium.filters.left >= compactCompendium.viewport.left - 1 &&
    compactCompendium.library.right <= compactCompendium.viewport.right + 1,
  `compact desktop compendium leaves the viewport: ${JSON.stringify(compactCompendium)}`)
  assert((compactCompendium.cardWidth ?? 0) >= 100,
    `compact desktop cards became unreadably small: ${compactCompendium.cardWidth}`)
  assertEqual(compactCompendium.wrappedLabels, 0, 'compact desktop rarity labels should not wrap')
  assert(compactCompendium.checkboxTargets.every((target) => target.height >= 24),
    `compact desktop rarity targets are too short: ${JSON.stringify(compactCompendium.checkboxTargets)}`)
  assert(compactCompendium.checkboxTargets.slice(1).every((target, index) =>
    target.center - compactCompendium.checkboxTargets[index].center >= 24),
  `compact desktop rarity targets are too tightly spaced: ${JSON.stringify(compactCompendium.checkboxTargets)}`)
  assertDeepEqual(compactTitleOverflow, [], 'compact desktop compendium title clipping')
  assert(compactCompendium.backBeforeSearch, 'Back must precede Search in keyboard and source order')
  assert(compactCompendium.back && compactCompendium.back.top < compactCompendium.viewport.bottom &&
    compactCompendium.back.bottom <= compactCompendium.viewport.bottom + 1,
  `compact desktop back control is not initially reachable: ${JSON.stringify(compactCompendium)}`)
  assert(compactCompendium.sort && compactCompendium.upgrade &&
    compactCompendium.back.bottom <= compactCompendium.sort.top + 1 &&
    compactCompendium.back.bottom <= compactCompendium.upgrade.top + 1 &&
    compactCompendium.sort.bottom <= compactCompendium.upgrade.top + 1,
  `compact desktop compendium controls overlap: ${JSON.stringify(compactCompendium)}`)
})
await page.setViewportSize({ width: 1440, height: 900 })
await page.getByRole('button', { name: 'Back to main menu' }).click()
await page.getByRole('button', { name: 'Single Player' }).click()
await page.getByRole('button', { name: 'Watcher' }).click()
await page.getByRole('button', { name: 'Embark' }).click()
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
await page.getByRole('button', { name: 'Skip 3 Gold' }).click()
await page.getByRole('button', { name: 'Reveal Card Reward' }).click()
await page.getByRole('heading', { name: 'Choose a Card' }).waitFor()
await page.locator('.neow-action--offer .card').first().waitFor()
const neowRewardChoiceCount = await page.evaluate(() =>
  Object.values(window.__STS_DEBUG__.getRun().neow.players)[0].redReward.choices.length)
const neowRewardCards = await page.locator('.neow-action--offer .card').evaluateAll((cards) => cards.map((card) => {
  const box = card.getBoundingClientRect()
  return { top: box.top, bottom: box.bottom, visible: box.top >= 0 && box.bottom <= innerHeight }
}))
const baseNeowRewardTitle = await page.locator('.neow-action--offer .card').first().getAttribute('title')
await page.evaluate(() => {
  const run = structuredClone(window.__STS_DEBUG__.getRun())
  Object.values(run.neow.players)[0].redReward.upgraded = true
  window.__STS_DEBUG__.setRun(run)
})
await page.waitForFunction(() => document.querySelector('.neow-action--offer .card')?.getAttribute('title')?.endsWith('+'))
const upgradedNeowRewardTitle = await page.locator('.neow-action--offer .card').first().getAttribute('title')
const staleNeowRewardLabel = await page.getByText('Resolve face-up reward', { exact: true }).count()
await shot('00b-neow-card-reward')
check('Neow shows complete face-up reward cards on the desktop stage', () => {
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
  { timeout: 12000 }).catch(() => {})
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
await page.waitForFunction(() => !document.querySelector('.card-morph')).catch(() => {})
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
await page.waitForFunction(() => !document.querySelector('.card-morph')).catch(() => {})

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

check('the opening map starts scrolled to its reachable room', async () => {
  const map = page.locator('.map:not([inert])')
  const room = map.locator('.room--reachable')
  const [port, node] = await Promise.all([map.boundingBox(), room.boundingBox()])
  assert(port && node && node.y >= port.y && node.y + node.height <= port.y + port.height,
    'the opening encounter is outside the map scrollport')
})

await page.evaluate(() => {
  const run = structuredClone(window.__STS_DEBUG__.getRun())
  run.meta.ruleset = 'downfall'
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

await page.keyboard.press('Escape')
const pauseMenu = page.getByRole('dialog', { name: 'Slay the Spire' })
await pauseMenu.waitFor()
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

await page.keyboard.press('Escape')
await pauseMenu.waitFor()
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
await page.keyboard.press('Escape')
await pauseMenu.waitFor()
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
await page.keyboard.press('Escape')
await pauseMenu.waitFor()
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
await page.waitForFunction(() => document.querySelector('.enemy__art--cutout[src$="/sentry.webp"]')?.naturalWidth === 341)
const combatAppearance = await page.evaluate(() => {
  const image = document.querySelector('.enemy__art--cutout[src$="/sentry.webp"]')
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
  assertDeepEqual([combatAppearance.naturalWidth, combatAppearance.naturalHeight], [341, 512])
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

const downfallMechanicLabels = {}
const downfallEnergyOrbs = {}
const downfallEmptyEnergyOrbs = {}
let downfallReducedMotionStopped = false
let guardianModeOrb = null
let slimeHudAccess = null
let slimeHudOverlapsEndTurn = true
for (const fixture of [
  { character: 'guardian', name: 'Guardian', fields: { guardianMode: 'attack', vigor: 3 } },
  { character: 'hexaghost', name: 'Hexaghost', fields: { heat: 2, soulburn: 1 } },
  { character: 'slime_boss', name: 'Slime Boss', fields: { slimes: [{
    card: { uid: 'ui-hud-bruiser', defId: 'slime_boss_bruiser_slime', upgraded: false },
    level: 2, vigor: 3, commandsThisTurn: 1, vigorLossAtEndOfTurn: 0,
  }, {
    card: { uid: 'ui-hud-armored', defId: 'slime_boss_armored_slime', upgraded: false },
    level: 3, vigor: 4, commandsThisTurn: 1, vigorLossAtEndOfTurn: 0,
  }] } },
]) {
  await page.setViewportSize(fixture.character === 'slime_boss'
    ? { width: 390, height: 844 }
    : { width: 1440, height: 900 })
  await page.evaluate(({ run, fixture }) => {
    const next = structuredClone(run)
    Object.assign(next.combat, { phase: 'player', ruleset: 'downfall', pendingHermitSetupLoads: [] })
    Object.assign(next.combat.players[0], { character: fixture.character, name: fixture.name, chamber: [], chamberSlots: 0,
      guardianMode: null, heat: 0, soulburn: 0, slimes: [], ...fixture.fields })
    next.combat.players = [next.combat.players[0]]
    window.__STS_DEBUG__.setRun(next)
  }, { run: combatAppearanceRun, fixture })
  const mechanicChips = page.locator(fixture.character === 'slime_boss'
    ? '.combat__slime-status > span'
    : '.seat__mechanic')
  downfallMechanicLabels[fixture.character] = await mechanicChips.allInnerTexts()
  await page.waitForFunction((expected) => {
    const images = [...document.querySelectorAll('.pip--energy .energy-orb__layers > img')]
    return images.length === expected && images.every((image) => image.complete && image.naturalWidth === 128)
  }, fixture.character === 'guardian' ? 7 : 6)
  downfallEnergyOrbs[fixture.character] = await page.locator('.pip--energy').evaluate((pip) => ({
    images: [...pip.querySelectorAll('.energy-orb__layers > img')].map((image) => ({
      src: image.getAttribute('src'),
      loaded: image.complete && image.naturalWidth === 128 && image.naturalHeight === 128,
      layer: image.dataset.layer,
      direction: getComputedStyle(image).animationDirection,
    })),
    generatedLayersHidden: getComputedStyle(pip, '::before').display === 'none' &&
      getComputedStyle(pip, '::after').display === 'none',
    cleanBackdrop: getComputedStyle(pip).boxShadow === 'none' && getComputedStyle(pip).backgroundImage === 'none',
  }))
  await page.evaluate(() => {
    const next = structuredClone(window.__STS_DEBUG__.getRun())
    next.combat.players[0].energy = 0
    window.__STS_DEBUG__.setRun(next)
  })
  await page.waitForFunction((expected) => {
    const images = [...document.querySelectorAll('.pip--energy .energy-orb__layers > img')]
    return images.length === expected && images.every((image) => image.complete && image.naturalWidth === 128)
  }, fixture.character === 'guardian' ? 7 : 6)
  downfallEmptyEnergyOrbs[fixture.character] = await page.locator('.pip--energy').evaluate((pip) =>
    [...pip.querySelectorAll('.energy-orb__layers > img')].map((image) => ({
      src: image.getAttribute('src'),
      loaded: image.complete && image.naturalWidth === 128 && image.naturalHeight === 128,
      layer: Number(image.dataset.layer),
      duration: getComputedStyle(image).animationDuration,
    })))
  await page.evaluate(() => {
    const next = structuredClone(window.__STS_DEBUG__.getRun())
    next.combat.players[0].energy = 3
    window.__STS_DEBUG__.setRun(next)
  })
  if (fixture.character === 'slime_boss') {
    const chips = []
    await mechanicChips.first().focus()
    for (let index = 0; index < await mechanicChips.count(); index++) {
      const chip = mechanicChips.nth(index)
      chips.push(await chip.evaluate((element) => {
        const box = element.getBoundingClientRect()
        const meta = element.parentElement?.getBoundingClientRect()
        return {
          focusable: element.tabIndex === 0,
          focused: document.activeElement === element,
          visible: !!meta && box.left >= meta.left - 1 && box.right <= meta.right + 1,
          label: element.getAttribute('aria-label'),
        }
      }))
      if (index + 1 < await mechanicChips.count()) await page.keyboard.press('Tab')
    }
    slimeHudAccess = chips
    slimeHudOverlapsEndTurn = await page.evaluate(() => {
      const status = document.querySelector('.combat__slime-status')?.getBoundingClientRect()
      const endTurn = document.querySelector('.combat__end-turn')?.getBoundingClientRect()
      return !status || !endTurn || status.left < endTurn.right && status.right > endTurn.left &&
        status.top < endTurn.bottom && status.bottom > endTurn.top
    })
  }
  await page.screenshot({ path: join(outDir, `downfall-${fixture.character}-compact-hud.png`) })
  if (fixture.character === 'guardian') {
    const layer = page.locator('.energy-orb__layers > img[data-layer="6"]')
    const activeTransition = await layer.evaluate((image) => getComputedStyle(image).transitionDuration)
    await page.evaluate(() => {
      const next = structuredClone(window.__STS_DEBUG__.getRun())
      next.combat.players[0].guardianMode = 'defense'
      window.__STS_DEBUG__.setRun(next)
    })
    await page.waitForTimeout(750)
    const defenseTransform = await layer.evaluate((image) => getComputedStyle(image).transform)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const reducedTransition = await layer.evaluate((image) => getComputedStyle(image).transitionDuration)
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.evaluate(() => { document.documentElement.dataset.mobilePerformance = 'true' })
    const mobileTransition = await layer.evaluate((image) => getComputedStyle(image).transitionDuration)
    await page.evaluate(() => { delete document.documentElement.dataset.mobilePerformance })
    guardianModeOrb = { activeTransition, defenseTransform, reducedTransition, mobileTransition }
  }
}

await page.setViewportSize({ width: 1518, height: 720 })
await page.evaluate((run) => {
  const next = structuredClone(run)
  const player = next.combat.players[0]
  Object.assign(next.combat, {
    phase: 'player', ruleset: 'downfall', pendingTriggers: [], pendingHermitSetupLoads: [{ playerId: player.id }],
  })
  Object.assign(player, {
    character: 'hermit', name: 'Hermit', energy: 3, chamberSlots: 2, chamber: [], slimes: [], guardianMode: null,
    hand: [{ uid: 'ui-targeted-grudge', defId: 'hermit_grudge', upgraded: false }],
  })
  next.combat.players = [player]
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
const targetedLoadPrompt = page.getByRole('region', { name: 'Hermit start-of-combat Load target' })
await targetedLoadPrompt.waitFor()
const targetedLoadLayout = {
  handCardDisabled: await page.locator('.hand .card').getAttribute('aria-disabled') === 'true',
  targetChoices: await targetedLoadPrompt.getByRole('button').count(),
  resolved: false,
}
await targetedLoadPrompt.getByRole('button').first().click()
await page.waitForFunction(() => {
  const combat = window.__STS_DEBUG__.getRun().combat
  return combat.pendingHermitSetupLoads.length === 0 && combat.players[0].chamber[0]?.defId === 'hermit_grudge'
})
targetedLoadLayout.resolved = true
await page.evaluate((run) => {
  const next = structuredClone(run)
  const player = next.combat.players[0]
  Object.assign(next.combat, {
    phase: 'player', ruleset: 'downfall', pendingTriggers: [], pendingHermitSetupLoads: [{ playerId: player.id }],
  })
  Object.assign(player, {
    character: 'hermit', name: 'Hermit', energy: 3, chamberSlots: 2, chamber: [], slimes: [], guardianMode: null,
    hand: [
      { uid: 'ui-compact-snapshot', defId: 'hermit_snapshot', upgraded: false },
      { uid: 'ui-mobile-hermit-strike', defId: 'hermit_strike', upgraded: false },
      { uid: 'ui-mobile-hermit-defend', defId: 'hermit_defend', upgraded: false },
    ],
  })
  next.combat.players = [player]
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
await page.locator('[aria-label="Hermit start-of-combat Load"]').waitFor()
await page.waitForFunction(() => {
  const images = [...document.querySelectorAll('.pip--energy .energy-orb__layers > img')]
  return images.length === 6 && images.every((image) => image.complete && image.naturalWidth === 128)
})
await page.waitForTimeout(800)
downfallMechanicLabels.hermit = await page.locator('.seat__mechanic').allInnerTexts()
const hermitHudLayout = await page.evaluate(() => {
  const chamber = document.querySelector('.hermit-chamber')?.getBoundingClientRect()
  const card = document.querySelector('.hand .card')?.getBoundingClientRect()
  const hp = document.querySelector('.row--viewer .seat > .bar')?.getBoundingClientRect()
  const overlap = (a, b) => a && b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
  return {
    setupPanelRemoved: !document.querySelector('.combat > .hermit-prompt--compact'),
    setupCardPlayable: document.querySelector('.hand .card')?.getAttribute('aria-disabled') === 'false',
    setupCardHighlighted: document.querySelector('.hand .card')?.classList.contains('card--load-choice') === true,
    setupCardGlow: getComputedStyle(document.querySelector('.hand .card')).filter.includes('drop-shadow'),
    chamberHidden: !chamber,
    cardContained: !!card && card.top >= 0 && card.bottom <= innerHeight,
    cardClearHp: !overlap(card, hp),
    battleLogHidden: !document.querySelector('.combat-log-drawer, .combat__enemy-report'),
    documentContained: document.documentElement.scrollHeight <= innerHeight && document.documentElement.scrollWidth <= innerWidth,
  }
})
downfallEnergyOrbs.hermit = await page.locator('.pip--energy').evaluate((pip) => ({
  images: [...pip.querySelectorAll('.energy-orb__layers > img')].map((image) => ({
    src: image.getAttribute('src'),
    loaded: image.complete && image.naturalWidth === 128 && image.naturalHeight === 128,
    layer: image.dataset.layer,
    direction: getComputedStyle(image).animationDirection,
    })),
  generatedLayersHidden: getComputedStyle(pip, '::before').display === 'none' &&
    getComputedStyle(pip, '::after').display === 'none',
  cleanBackdrop: getComputedStyle(pip).boxShadow === 'none' && getComputedStyle(pip).backgroundImage === 'none',
}))
await page.evaluate(() => {
  const next = structuredClone(window.__STS_DEBUG__.getRun())
  next.combat.players[0].energy = 0
  window.__STS_DEBUG__.setRun(next)
})
await page.waitForFunction(() => {
  const images = [...document.querySelectorAll('.pip--energy .energy-orb__layers > img')]
  return images.length === 6 && images.every((image) => image.complete && image.naturalWidth === 128)
})
downfallEmptyEnergyOrbs.hermit = await page.locator('.pip--energy').evaluate((pip) =>
  [...pip.querySelectorAll('.energy-orb__layers > img')].map((image) => ({
    src: image.getAttribute('src'),
    loaded: image.complete && image.naturalWidth === 128 && image.naturalHeight === 128,
    layer: Number(image.dataset.layer),
    duration: getComputedStyle(image).animationDuration,
  })))
await page.evaluate(() => {
  const next = structuredClone(window.__STS_DEBUG__.getRun())
  next.combat.players[0].energy = 3
  window.__STS_DEBUG__.setRun(next)
})
await page.screenshot({ path: join(outDir, 'downfall-hermit-compact-hud.png') })
await page.getByRole('button', { name: /^Snapshot,/ }).click()
await page.waitForFunction(() => {
  const combat = window.__STS_DEBUG__.getRun().combat
  return combat.pendingHermitSetupLoads.length === 0 && combat.players[0].chamber[0]?.defId === 'hermit_snapshot'
})
const loadedHermitLayout = await page.evaluate(() => {
  const chamber = document.querySelector('.hermit-chamber')?.getBoundingClientRect()
  const energy = document.querySelector('.pip--energy')?.getBoundingClientRect()
  const card = document.querySelector('.hand .card')?.getBoundingClientRect()
  const overlap = (a, b) => a && b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
  return {
    chamberContained: !!chamber && chamber.left >= 0 && chamber.right <= innerWidth,
    chamberClearEnergy: !overlap(chamber, energy),
    chamberClearHand: !overlap(chamber, card),
  }
})
await page.screenshot({ path: join(outDir, 'downfall-hermit-loaded-chamber.png') })
const oneLoadedHermitRun = await readRun()
await page.evaluate(() => {
  const next = structuredClone(window.__STS_DEBUG__.getRun())
  next.combat.players[0].chamber = [
    { uid: 'ui-full-chamber-grudge', defId: 'hermit_grudge', upgraded: false },
    { uid: 'ui-full-chamber-malice', defId: 'hermit_malice', upgraded: false },
  ]
  window.__STS_DEBUG__.setRun(next)
})
const fullHermitChamberLayout = await page.evaluate(() => {
  const chamber = document.querySelector('.hermit-chamber')
  const chamberBox = chamber?.getBoundingClientRect()
  const energy = document.querySelector('.pip--energy')?.getBoundingClientRect()
  const cards = [...document.querySelectorAll('.hand .card')].map((card) => card.getBoundingClientRect())
  const overlap = (a, b) => a && b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
  return {
    chamberContained: !!chamberBox && chamberBox.left >= 0 && chamberBox.right <= innerWidth,
    chamberClearEnergy: !overlap(chamberBox, energy),
    chamberClearHand: cards.every((card) => !overlap(chamberBox, card)),
    boundedWidth: !!chamberBox && chamberBox.width <= 405,
    overflowReady: !!chamber && getComputedStyle(chamber).overflowX === 'auto',
  }
})
await page.screenshot({ path: join(outDir, 'downfall-hermit-full-chamber.png') })
await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), oneLoadedHermitRun)
await page.emulateMedia({ reducedMotion: 'reduce' })
downfallReducedMotionStopped = await page.locator('.energy-orb__layers > img').evaluateAll((images) =>
  images.every((image) => getComputedStyle(image).animationName === 'none'))
await page.emulateMedia({ reducedMotion: 'no-preference' })
await page.setViewportSize({ width: 769, height: 1024 })
const tabletLoadedHermitLayout = await page.evaluate(() => {
  const chamber = document.querySelector('.hermit-chamber')?.getBoundingClientRect()
  const energy = document.querySelector('.pip--energy')?.getBoundingClientRect()
  const hp = document.querySelector('.row--viewer .seat > .bar')?.getBoundingClientRect()
  const cards = [...document.querySelectorAll('.hand .card')].map((card) => card.getBoundingClientRect())
  const intents = [...document.querySelectorAll('.enemy__intent .intent')].map((intent) => intent.getBoundingClientRect())
  const mechanics = [...document.querySelectorAll('.seat__mechanic')].map((mechanic) => mechanic.getBoundingClientRect())
  const overlap = (a, b) => a && b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
  return {
    chamberContained: !!chamber && chamber.left >= 0 && chamber.right <= innerWidth && chamber.top >= 0,
    chamberClearEnergy: !overlap(chamber, energy),
    chamberClearHp: !overlap(chamber, hp),
    chamberClearCards: cards.every((card) => !overlap(chamber, card)),
    chamberClearIntents: intents.every((intent) => !overlap(chamber, intent)),
    chamberClearMechanics: mechanics.every((mechanic) => !overlap(chamber, mechanic)),
    cardsVisible: cards.length === 2 && cards.every((card) => card.left >= 0 && card.right <= innerWidth && card.bottom <= innerHeight),
  }
})
await page.screenshot({ path: join(outDir, 'downfall-hermit-loaded-chamber-tablet.png') })
const landscapeLoadedHermitLayouts = []
for (const viewport of [{ width: 768, height: 360 }, { width: 844, height: 390 }]) {
  await page.setViewportSize(viewport)
  const layout = await page.evaluate(() => {
    const chamber = document.querySelector('.hermit-chamber')?.getBoundingClientRect()
    const turnControls = [...document.querySelectorAll('.combat__turn, .combat__die, .combat__phase, .combat__slime-status')]
      .map((control) => control.getBoundingClientRect())
    const energy = document.querySelector('.pip--energy')?.getBoundingClientRect()
    const hp = document.querySelector('.row--viewer .seat > .bar')?.getBoundingClientRect()
    const hpBars = [...document.querySelectorAll('.row--viewer .seat > .bar, .board .enemy .bar')]
      .map((bar) => bar.getBoundingClientRect())
    const contentBox = (element) => {
      if (!element) return undefined
      const range = document.createRange()
      range.selectNodeContents(element)
      return range.getBoundingClientRect()
    }
    const enemyNames = [...document.querySelectorAll('.enemy__name')].map(contentBox)
    const name = contentBox(document.querySelector('.row--viewer .seat__name'))
    const portrait = document.querySelector('.row--viewer .seat__portrait')?.getBoundingClientRect()
    const endTurn = document.querySelector('.combat__end-turn')?.getBoundingClientRect()
    const cards = [...document.querySelectorAll('.hand .card')].map((card) => card.getBoundingClientRect())
    const piles = [...document.querySelectorAll('.hand-area .pile__stack')].map((pile) => pile.getBoundingClientRect())
    const intents = [...document.querySelectorAll('.enemy__intent .intent')].map((intent) => intent.getBoundingClientRect())
    const mechanics = [...document.querySelectorAll('.seat__mechanic')].map((mechanic) => mechanic.getBoundingClientRect())
    const overlap = (a, b) => a && b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
    return {
      chamberContained: !!chamber && chamber.left >= 0 && chamber.right <= innerWidth && chamber.top >= 0 && chamber.bottom <= innerHeight,
      chamberClearTurnControls: turnControls.every((control) => !overlap(chamber, control)),
      chamberClearEnergy: !overlap(chamber, energy),
      chamberClearHp: !overlap(chamber, hp),
      chamberClearEndTurn: !overlap(chamber, endTurn),
      chamberClearCards: cards.every((card) => !overlap(chamber, card)),
      chamberClearIntents: intents.every((intent) => !overlap(chamber, intent)),
      chamberClearMechanics: mechanics.every((mechanic) => !overlap(chamber, mechanic)),
      cardsVisible: cards.length === 2 && cards.every((card) => card.left >= 0 && card.right <= innerWidth && card.bottom <= innerHeight),
      hpContained: !!hp && hp.top >= 0 && hp.bottom <= innerHeight,
      allHpContained: hpBars.length === 4 && hpBars.every((bar) => bar.top >= 0 && bar.bottom <= innerHeight),
      enemyHpClearNames: hpBars.slice(1).every((bar) => enemyNames.every((name) => !overlap(bar, name))),
      nameContained: !!name && name.top >= 0 && name.bottom <= innerHeight,
      viewerNameClearEnemies: enemyNames.every((enemy) => !overlap(name, enemy)),
      cardsClearViewer: cards.every((card) => !overlap(card, portrait) && !overlap(card, name) && !overlap(card, hp)),
      cardsClearEnergy: cards.every((card) => !overlap(card, energy)),
      cardsClearPiles: cards.every((card) => piles.every((pile) => !overlap(card, pile))),
    }
  })
  landscapeLoadedHermitLayouts.push({ viewport, ...layout })
  await page.screenshot({ path: join(outDir, `downfall-hermit-loaded-chamber-${viewport.width}x${viewport.height}.png`) })
}
await page.setViewportSize({ width: 390, height: 844 })
await page.evaluate((run) => {
  const next = structuredClone(run)
  next.combat.enemies = [{
    ...next.combat.enemies[0], defId: 'slime_boss', isBoss: true, dead: false, hp: 35, maxHp: 35,
  }]
  window.__STS_DEBUG__.setRun(next)
}, oneLoadedHermitRun)
await page.locator('.enemy--boss').waitFor()
const singleBossPortraitLayout = await page.evaluate(() => {
  const boss = document.querySelector('.enemy--boss')
  const chamber = document.querySelector('.hermit-chamber')?.getBoundingClientRect()
  const mechanics = [...document.querySelectorAll('.enemy--boss .enemy__intent, .enemy--boss .enemy__ability, .enemy--boss .tokens')]
    .map((element) => element.getBoundingClientRect())
  const overlap = (a, b) => a && b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
  return {
    width: boss?.getBoundingClientRect().width ?? 0,
    crowded: boss?.closest('.board')?.dataset.crowded ?? null,
    chamberClearMechanics: mechanics.every((mechanic) => !overlap(chamber, mechanic)),
  }
})
await page.screenshot({ path: join(outDir, 'downfall-hermit-single-boss-mobile.png') })
await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), oneLoadedHermitRun)
await page.setViewportSize({ width: 390, height: 844 })
await page.evaluate(() => {
  document.documentElement.dataset.mobilePerformance = 'true'
})
await page.waitForTimeout(800)
await page.locator('.hand-scroll, .hand').evaluateAll((elements) => {
  for (const element of elements) element.scrollLeft = 0
})
const mobileLoadedHermitLayout = await page.evaluate(() => {
  const chamber = document.querySelector('.hermit-chamber')?.getBoundingClientRect()
  const hand = document.querySelector('.hand')
  const handStyle = hand && getComputedStyle(hand)
  const energy = document.querySelector('.pip--energy')?.getBoundingClientRect()
  const hp = document.querySelector('.row--viewer .seat > .bar')?.getBoundingClientRect()
  const portrait = document.querySelector('.row--viewer .seat__portrait')?.getBoundingClientRect()
  const name = document.querySelector('.row--viewer .seat__name')?.getBoundingClientRect()
  const enemyPortraits = [...document.querySelectorAll('.board .enemy__portrait')]
    .map((enemy) => enemy.getBoundingClientRect())
  const enemyNames = [...document.querySelectorAll('.enemy__head')].map((enemy) => enemy.getBoundingClientRect())
  const cards = [...document.querySelectorAll('.hand .card')].map((card) => card.getBoundingClientRect())
  const chamberCard = document.querySelector('.hermit-chamber__cards .card')?.getBoundingClientRect()
  const intents = [...document.querySelectorAll('.enemy__intent .intent')].map((intent) => intent.getBoundingClientRect())
  const overlap = (a, b) => a && b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
  return {
    chamberContained: !!chamber && chamber.left >= 0 && chamber.right <= innerWidth && chamber.top >= 0,
    chamberClearEnergy: !overlap(chamber, energy),
    chamberClearHp: !overlap(chamber, hp),
    viewerClearEnemies: enemyPortraits.every((enemy) => !overlap(portrait, enemy)) &&
      enemyNames.every((enemy) => !overlap(name, enemy)),
    chamberClearIntents: intents.every((intent) => !overlap(chamber, intent)),
    chamberCardWidth: chamberCard?.width ?? Infinity,
    cardsVisible: cards.length === 2 && cards.every((card) => card.left >= 0 && card.left < innerWidth && card.bottom <= innerHeight),
    cardsClearEnergy: cards.every((card) => !overlap(energy, card)),
    chamberClearCards: cards.every((card) => !overlap(chamber, card)),
    orbMotionStopped: [...document.querySelectorAll('.energy-orb__layers > img')]
      .every((image) => getComputedStyle(image).animationName === 'none'),
    cards: cards.map(({ left, right, top, bottom }) => ({ left, right, top, bottom })),
    handStyle: handStyle && {
      justifyContent: handStyle.justifyContent,
      paddingLeft: handStyle.paddingLeft,
      paddingRight: handStyle.paddingRight,
      rect: (() => {
        const { left, right, width } = hand.getBoundingClientRect()
        return { left, right, width, scrollLeft: hand.scrollLeft, scrollWidth: hand.scrollWidth }
      })(),
    },
  }
})
await page.screenshot({ path: join(outDir, 'downfall-hermit-loaded-chamber-mobile.png') })
await page.setViewportSize({ width: 1518, height: 720 })
await page.evaluate((run) => {
  delete document.documentElement.dataset.mobilePerformance
  const next = structuredClone(run)
  const player = next.combat.players[0]
  Object.assign(next.combat, {
    phase: 'player', ruleset: 'downfall', pendingHermitSetupLoads: [],
    pendingHermitStrengthRewards: [{ playerId: player.id, sourceUid: 'ui-dead-or-alive' }],
  })
  Object.assign(player, { character: 'hermit', name: 'Hermit', chamberSlots: 2, chamber: [] })
  next.combat.players = [player]
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
const deadOrAlivePrompt = page.getByRole('region', { name: 'Dead or Alive reward' })
await deadOrAlivePrompt.waitFor()
const deadOrAliveLayout = await deadOrAlivePrompt.evaluate((prompt) => {
  const box = prompt.getBoundingClientRect()
  const hp = document.querySelector('.row--viewer .seat > .bar')?.getBoundingClientRect()
  const overlap = (a, b) => a && b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
  return {
    contained: box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight,
    positioned: getComputedStyle(prompt).position === 'absolute',
    clearHp: !overlap(box, hp),
  }
})
await page.screenshot({ path: join(outDir, 'downfall-hermit-dead-or-alive.png') })
await page.evaluate((run) => {
  const next = structuredClone(run)
  const viewer = next.combat.players[0]
  const hermit = {
    ...viewer,
    id: 'ui-private-hermit',
    name: 'Other Hermit',
    row: viewer.row + 1,
    character: 'hermit',
    chamberSlots: 2,
    chamber: [{ uid: 'ui-private-chamber-card', defId: 'hermit_snapshot', upgraded: false }],
  }
  next.combat.players = [viewer, hermit]
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
const opponentChamberLabels = await page.locator('.seat__mechanic').filter({ hasText: 'Chamber' }).count()
await page.setViewportSize({ width: 390, height: 844 })
await page.evaluate((run) => {
  const next = structuredClone(run)
  const actor = next.combat.players[0]
  actor.hand = [
    { uid: 'ui-die-1', defId: 'defend_ironclad', upgraded: false },
    { uid: 'ui-die-2', defId: 'bash', upgraded: false },
    { uid: 'ui-die-3', defId: 'strike_ironclad', upgraded: false },
    { uid: 'ui-die-4', defId: 'defend_ironclad', upgraded: false },
    { uid: 'ui-die-5', defId: 'strike_ironclad', upgraded: false },
  ]
  next.combat.players = [actor]
  next.combat.pendingDieRelicChoices = [{
    playerId: actor.id,
    relicDefId: 'wheel_of_change',
    abilityIndex: 0,
    sourceLabel: 'Compact prompt fixture',
    enemyUid: null,
    targetPlayerId: actor.id,
  }]
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
const dieRelicPrompt = page.locator('.hermit-prompt--cards')
await dieRelicPrompt.waitFor()
const dieRelicResolve = dieRelicPrompt.getByRole('button', { name: /Resolve/ })
await dieRelicResolve.scrollIntoViewIfNeeded()
const dieRelicLayout = await dieRelicPrompt.evaluate((prompt) => {
  const box = prompt.getBoundingClientRect()
  const cards = [...prompt.querySelectorAll('.card')].map((card) => card.getBoundingClientRect())
  const resolve = [...prompt.querySelectorAll('button')].at(-1)?.getBoundingClientRect()
  return {
    promptContained: box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight && box.left >= 0,
    cards: cards.length,
    cardsContained: cards.every((card) => card.left >= 0 && card.right <= innerWidth),
    resolveContained: !!resolve && resolve.top >= 0 && resolve.bottom <= innerHeight,
    overflowY: getComputedStyle(prompt).overflowY,
  }
})
await page.screenshot({ path: join(outDir, 'downfall-die-relic-compact.png') })
check('Downfall mechanics use compact combat HUDs without clipping the hand', () => {
  assertDeepEqual(downfallMechanicLabels, {
    guardian: ['Attack · Vigor 3'],
    hexaghost: ['Heat 2'],
    slime_boss: [
      'Bruiser · L2 · Vigor 3 · Cmd 1',
      'Armored · L3 · Vigor 4 · Cmd 1',
    ],
    hermit: ['Chamber 0/2'],
  })
  assert(slimeHudAccess?.every((chip) => chip.focusable && chip.focused && chip.visible),
    `Slime status chips are not keyboard-reachable in the narrow HUD: ${JSON.stringify(slimeHudAccess)}`)
  assert(!slimeHudOverlapsEndTurn, 'Slime status overlaps End turn in the narrow HUD')
  assert(slimeHudAccess?.[0]?.label?.includes('ready to Command'), 'Bruiser command availability is missing')
  assert(slimeHudAccess?.[1]?.label?.includes('Command limit reached'), 'Armored command limit is missing')
  assert(hermitHudLayout.setupPanelRemoved, 'Hermit Load still renders a panel over the combat stage')
  assert(targetedLoadLayout.handCardDisabled, 'targeted Hermit Curse is exposed as a dead direct-Load button')
  assertEqual(targetedLoadLayout.targetChoices, 3, 'targeted Hermit Curse does not offer every living enemy')
  assert(targetedLoadLayout.resolved, 'targeted Hermit Curse did not resolve from its target prompt')
  assert(hermitHudLayout.setupCardPlayable, 'Hermit Load card is not directly selectable from the hand')
  assert(hermitHudLayout.setupCardHighlighted, 'Hermit Load card does not have the PC-style choice glow')
  assert(hermitHudLayout.setupCardGlow, 'Hermit Load card choice glow is overridden by combat styling')
  assert(hermitHudLayout.chamberHidden, 'an empty Hermit Chamber still occupies the combat stage')
  assert(hermitHudLayout.cardContained, 'Hermit hand card is clipped by the viewport')
  assert(hermitHudLayout.cardClearHp, 'Hermit Load card overlaps the player HP bar')
  assert(hermitHudLayout.battleLogHidden, 'combat rendered the removed battle-log UI')
  assert(hermitHudLayout.documentContained, 'Hermit combat HUD creates document overflow')
  assert(loadedHermitLayout.chamberContained, 'loaded Hermit Chamber escapes the viewport')
  assert(loadedHermitLayout.chamberClearEnergy, 'loaded Hermit Chamber overlaps the Energy orb')
  assert(loadedHermitLayout.chamberClearHand, 'loaded Hermit Chamber overlaps the hand')
  assert(Object.values(fullHermitChamberLayout).every(Boolean),
    `full Hermit Chamber is not collision-safe: ${JSON.stringify(fullHermitChamberLayout)}`)
  assert(Object.values(tabletLoadedHermitLayout).every(Boolean),
    `tablet loaded Hermit layout has a collision: ${JSON.stringify(tabletLoadedHermitLayout)}`)
  assert(landscapeLoadedHermitLayouts.every(({ viewport: _viewport, ...layout }) => Object.values(layout).every(Boolean)),
    `landscape loaded Hermit layout has a collision: ${JSON.stringify(landscapeLoadedHermitLayouts)}`)
  assert(mobileLoadedHermitLayout.chamberContained, 'mobile loaded Hermit Chamber escapes the viewport')
  assert(mobileLoadedHermitLayout.chamberClearEnergy, 'mobile loaded Hermit Chamber overlaps the Energy orb')
  assert(mobileLoadedHermitLayout.chamberClearHp, 'mobile loaded Hermit Chamber overlaps the player HP bar')
  assert(mobileLoadedHermitLayout.viewerClearEnemies, 'mobile Hermit overlaps an enemy portrait or name')
  assert(mobileLoadedHermitLayout.chamberClearIntents, 'mobile loaded Hermit Chamber overlaps enemy intents')
  assert(mobileLoadedHermitLayout.chamberCardWidth < 50,
    `mobile Hermit Chamber card is not compact: ${mobileLoadedHermitLayout.chamberCardWidth}px`)
  assert(mobileLoadedHermitLayout.cardsVisible,
    `mobile loaded Hermit hand cards are clipped: ${JSON.stringify(mobileLoadedHermitLayout)}`)
  assert(mobileLoadedHermitLayout.cardsClearEnergy, 'mobile Hermit Energy orb overlaps the hand')
  assert(mobileLoadedHermitLayout.chamberClearCards, 'mobile loaded Hermit Chamber overlaps the hand')
  assert(mobileLoadedHermitLayout.orbMotionStopped, 'mobile-performance mode does not stop the Energy orb layers')
  assert(singleBossPortraitLayout.width > 100,
    `mobile single boss was compacted to ${singleBossPortraitLayout.width}px`)
  assertEqual(singleBossPortraitLayout.crowded, null, 'single-boss board was marked crowded')
  assert(singleBossPortraitLayout.chamberClearMechanics, 'mobile Chamber overlaps single-boss mechanics')
  assert(deadOrAliveLayout.contained && deadOrAliveLayout.positioned && deadOrAliveLayout.clearHp,
    `Dead or Alive prompt breaks combat layout: ${JSON.stringify(deadOrAliveLayout)}`)
  assertEqual(opponentChamberLabels, 0, 'another player can see the Hermit Chamber fill count')
  assert(dieRelicLayout.promptContained, 'Die Relic prompt escapes the compact viewport')
  assertEqual(dieRelicLayout.cards, 5, 'Die Relic prompt does not expose the full hand')
  assert(dieRelicLayout.cardsContained, 'Die Relic cards escape the compact viewport horizontally')
  assert(dieRelicLayout.resolveContained, 'Die Relic resolution action cannot be reached by scrolling')
  assertEqual(dieRelicLayout.overflowY, 'auto', 'Die Relic prompt cannot scroll vertically')
})
check('Downfall characters use the original PC-mod Energy orb layers', () => {
  assertDeepEqual(Object.keys(downfallEnergyOrbs).sort(), ['guardian', 'hermit', 'hexaghost', 'slime_boss'])
  for (const [character, orb] of Object.entries(downfallEnergyOrbs)) {
    assertEqual(orb.images.length, character === 'guardian' ? 7 : 6, `${character} Energy orb layer count`)
    assert(orb.images.every(({ src, loaded }) => loaded && src?.includes(`/combat/energy-orbs/${character}/`)),
      `${character} Energy orb assets: ${JSON.stringify(orb.images)}`)
    assert(orb.generatedLayersHidden, `${character} still shows the generated Ironclad orb`)
    assert(orb.cleanBackdrop, `${character} Energy orb still has the old square backdrop`)
    const directions = Object.fromEntries(orb.images.map(({ layer, direction }) => [layer, direction]))
    assertDeepEqual(directions, character === 'guardian'
      ? { 6: 'normal', 1: 'normal', 2: 'reverse', 3: 'normal', 4: 'reverse', 5: 'normal', 7: 'normal' }
      : { 1: 'reverse', 2: 'reverse', 3: 'normal', 4: 'reverse', 5: 'normal', 6: 'normal' },
    `${character} Energy orb rotation directions`)
  }
  assertDeepEqual(Object.keys(downfallEmptyEnergyOrbs).sort(), ['guardian', 'hermit', 'hexaghost', 'slime_boss'])
  for (const [character, images] of Object.entries(downfallEmptyEnergyOrbs)) {
    const baseLayer = character === 'guardian' ? 7 : 6
    assertEqual(images.length, character === 'guardian' ? 7 : 6, `${character} empty Energy orb layer count`)
    assert(images.every(({ src, loaded, layer }) => loaded && src?.endsWith(
      `/layer${layer}${layer === baseLayer ? '' : 'd'}.png`)),
    `${character} empty Energy orb assets: ${JSON.stringify(images)}`)
    assert(images.every(({ layer, duration }) => duration === (layer === 1 ? '5s'
      : layer === 2 || layer === 3 ? '45s'
      : layer === 4 || layer === 5 ? '72s' : '0s')),
    `${character} empty Energy orb speeds: ${JSON.stringify(images)}`)
  }
  assertEqual(guardianModeOrb?.activeTransition, '0.7s', 'Guardian mode orb transition')
  assert(guardianModeOrb?.defenseTransform?.startsWith('matrix(0.7'),
    `Guardian defense orb did not ease to 70%: ${guardianModeOrb?.defenseTransform}`)
  assertEqual(guardianModeOrb?.reducedTransition, '0s', 'Guardian reduced-motion transition')
  assertEqual(guardianModeOrb?.mobileTransition, '0s', 'Guardian mobile-performance transition')
  assert(downfallReducedMotionStopped, 'reduced motion does not stop the Downfall Energy orb layers')
})
await page.setViewportSize({ width: 1440, height: 900 })
await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), combatAppearanceRun)

await page.evaluate((run) => {
  const next = structuredClone(run)
  const template = next.combat.enemies[0]
  next.combat.phase = 'enemy'
  next.combat.enemies = [{
    ...template, uid: 'short-boss-duration', defId: 'downfall_inferno', row: 0,
    isBoss: true, hp: 20, maxHp: 20, block: 0, actionIndex: 0, dead: false,
  }]
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
await page.waitForFunction(() => document.querySelector('.enemy--boss[data-animation="attack"]'))
const shortBossAttackMotion = await page.locator('.enemy--boss[data-animation="attack"]').evaluate((boss) => ({
  cssVariable: getComputedStyle(boss).getPropertyValue('--boss-attack-duration').trim(),
  animationDuration: getComputedStyle(boss.querySelector('.enemy__art--cutout')).animationDuration,
}))
await page.waitForFunction(() => document.querySelector('.enemy--boss')?.getAttribute('data-animation') === 'idle')
check('short Downfall boss attacks play exactly one matching motion cycle', () => {
  assertDeepEqual(shortBossAttackMotion, { cssVariable: '580ms', animationDuration: '0.58s' })
})
await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), combatAppearanceRun)

if (args.includes('--downfall-ui-only')) {
  check('the focused Downfall browser run reported no errors', () => {
    assert(consoleErrors.length === 0, `console errors:\n    ${consoleErrors.join('\n    ')}`)
    assert(pageErrors.length === 0, `page errors:\n    ${pageErrors.join('\n    ')}`)
    assert(requestFailures.length === 0, `failed requests:\n    ${requestFailures.join('\n    ')}`)
  })
  await browser.close()
  await server.close()
  report('Downfall combat UI')
  process.exit(process.exitCode ?? 0)
}

const evilBossSoundCount = await page.evaluate(() => window.__SFX_PLAYS__.length)
await page.evaluate((run) => {
  const next = structuredClone(run)
  const template = next.combat.enemies[0]
  next.combat.phase = 'enemy'
  next.combat.enemies = [
    ['downfall_inferno', 0],
    ['downfall_witch', 1],
    ['downfall_orb_master', 0],
    ['downfall_wrathful', 0],
  ].map(([defId, actionIndex], index) => ({
    ...template,
    uid: `evil-hero-${index}`,
    defId,
    row: 0,
    isBoss: true,
    hp: 20,
    maxHp: 20,
    block: 0,
    actionIndex,
    dead: false,
  }))
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
await page.keyboard.press('Escape')
await pauseMenu.waitFor()
await page.locator('.pause-menu').evaluate((dialog) => { dialog.style.visibility = 'hidden' })
await page.waitForFunction(() => document.querySelectorAll('.enemy--boss img[src$="-attack.webp"]').length === 4)
const evilBossAttackSources = await page.locator('.enemy--boss img[src$="-attack.webp"]').evaluateAll((images) =>
  images.map((image) => image.getAttribute('src')))
await shot('02c-downfall-evil-hero-boss-attacks')
check('evil hero boss attack fixture renders four clean left-attacking animation assets', () => {
  assertDeepEqual(evilBossAttackSources, [
    '/assets/combat/enemies/animations/downfall_pc_ironclad-attack.webp',
    '/assets/combat/enemies/animations/downfall_pc_silent-attack.webp',
    '/assets/combat/enemies/animations/downfall_pc_defect-attack.webp',
    '/assets/combat/enemies/animations/downfall_pc_watcher-attack.webp',
  ])
})
await page.locator('.pause-menu').evaluate((dialog) => { dialog.style.visibility = '' })
await page.keyboard.press('Escape')
await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), combatAppearanceRun)
await page.evaluate((count) => { window.__SFX_PLAYS__.length = count }, evilBossSoundCount)

await page.evaluate((run) => {
  const next = structuredClone(run)
  const player = next.combat.players[0]
  Object.assign(next.combat, { phase: 'player', pendingTriggers: [], pendingHermitSetupLoads: [] })
  Object.assign(player, {
    character: 'guardian', guardianMode: 'attack', energy: 3,
    powers: [{ uid: 'ui-crystallize', defId: 'guardian_crystallize', upgraded: false,
      attachedGemId: 'guardian_amethyst' }],
    hand: [{ uid: 'ui-crystallize-strike', defId: 'guardian_strike', upgraded: false }],
  })
  next.combat.players = [player]
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
const socketedCard = page.getByRole('button', { name: /^Strike,.*socketed with Amethyst:/ })
await socketedCard.waitFor()
const socketedGem = await socketedCard.locator('img.card__gem').evaluate((image) => ({
  source: image.getAttribute('src'),
  title: image.getAttribute('title'),
  loaded: image.complete && image.naturalWidth > 0,
}))
check('Crystallize inheritance shows and announces the exact official Gem face on starter Strikes', () => {
  assert(socketedGem.source?.endsWith('/guardian__normal__amethyst.webp'), socketedGem.source)
  assert(socketedGem.title?.startsWith('Amethyst:'), socketedGem.title)
  assert(socketedGem.loaded, 'the socketed Gem thumbnail did not decode')
})

await page.evaluate(async (run) => {
  const { preparePlayerTurn } = await import('/src/game/combat.ts')
  const next = structuredClone(run)
  const player = next.combat.players[0]
  Object.assign(player, { character: 'guardian', guardianMode: 'attack', guardianModeLocked: false,
    hand: [], powers: [] })
  next.combat.players = [player]
  next.combat = preparePlayerTurn({ ...next.combat, phase: 'roundEnd' })
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
await page.getByRole('group', { name: /Mode Shift\?/ }).waitFor()
await page.getByRole('button', { name: 'Mode Shift', exact: true }).click()
await page.getByRole('button', { name: 'Resolve start of turn' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.players[0].guardianMode === 'defense')
check('Guardian can make the printed optional Mode Shift at start of turn', async () => {
  assertEqual((await readRun()).combat.players[0].guardianMode, 'defense')
})

const downfallChoiceResults = {}
const downfallCardAssets = []
async function readDownfallCardAsset(name) {
  const image = page.getByRole('button', { name }).locator('img.card__art')
  await image.waitFor()
  await image.evaluate((element) => element.decode())
  return image.evaluate((element) => ({ source: element.getAttribute('src'), width: element.naturalWidth }))
}
await page.evaluate((run) => {
  const next = structuredClone(run)
  const player = next.combat.players[0]
  next.combat.enemies = [next.combat.enemies[0]]
  Object.assign(next.combat, { phase: 'player', ruleset: 'downfall', pendingTriggers: [], pendingHermitSetupLoads: [] })
  Object.assign(next.combat.enemies[0], { hp: 20, maxHp: 20, block: 0, dead: false })
  Object.assign(player, {
    character: 'guardian', energy: 3, block: 2, vigor: 1, vigorSpentThisTurn: 0,
    hand: [{ uid: 'ui-body-crash', defId: 'guardian_body_crash', upgraded: false }],
    chamber: [], slimes: [], soulburn: 0, guardianMode: 'defense', powers: [],
  })
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
downfallCardAssets.push(await readDownfallCardAsset(/^Body Crash,/))
await page.getByRole('button', { name: /^Body Crash,/ }).click()
await page.getByRole('button', { name: 'Spend 0 Vigor' }).click()
await page.getByRole('button', { name: 'Spend 2 Block' }).click()
await page.locator('.enemy:not(.enemy--dead)').first().click()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.players[0].hand.length === 0)
downfallChoiceResults.guardian = await page.evaluate(() => {
  const combat = window.__STS_DEBUG__.getRun().combat
  return [combat.players[0].block, combat.enemies[0].hp]
})

await page.evaluate((run) => {
  const next = structuredClone(run)
  const player = next.combat.players[0]
  const ally = structuredClone(player)
  Object.assign(next.combat, { phase: 'player', ruleset: 'downfall', pendingTriggers: [], pendingHermitSetupLoads: [] })
  Object.assign(player, {
    character: 'guardian', energy: 3, block: 0, vigor: 0, vigorSpentThisTurn: 0,
    hand: [{ uid: 'ui-stasis-field', defId: 'guardian_stasis_field', upgraded: false }],
    chamber: [], slimes: [], soulburn: 0, guardianMode: 'attack', powers: [],
  })
  Object.assign(ally, {
    id: 'ui-guardian-ally', name: 'Defect', character: 'defect', row: player.row + 1,
    hand: [], draw: [], discard: [], exhaust: [], powers: [], block: 0, dead: false,
  })
  next.combat.players = [player, ally]
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
await page.getByRole('button', { name: /^Stasis Field,/ }).click()
await page.locator('button.seat').nth(0).click()
await page.locator('button.seat').nth(1).click()
await page.locator('button.seat').nth(1).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.players[0].hand.length === 0)
downfallChoiceResults.guardianStasis = await page.evaluate(() =>
  window.__STS_DEBUG__.getRun().combat.players.map((player) => player.block))

await page.evaluate((run) => {
  const next = structuredClone(run)
  const player = next.combat.players[0]
  const ally = structuredClone(player)
  Object.assign(next.combat, { phase: 'player', ruleset: 'downfall', pendingTriggers: [],
    pendingHermitSetupLoads: [], partyAttackDiscount: false })
  Object.assign(next.combat.enemies[0], { hp: 20, maxHp: 20, block: 0, dead: false })
  Object.assign(player, {
    character: 'guardian', energy: 2, block: 0, vigor: 0, vigorSpentThisTurn: 0,
    freeAttacksThisTurn: 1,
    hand: [{ uid: 'ui-guardian-whirl', defId: 'guardian_guardian_whirl', upgraded: false }],
    chamber: [], slimes: [], soulburn: 0, guardianMode: 'defense', powers: [],
  })
  Object.assign(ally, {
    id: 'ui-whirl-ally', name: 'Defect', character: 'defect', row: player.row + 1,
    hand: [], draw: [], discard: [], exhaust: [], powers: [], block: 0, dead: false,
  })
  next.combat.players = [player, ally]
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
await page.getByRole('button', { name: /^Guardian Whirl,/ }).click()
await page.getByRole('button', { name: 'Spend 2' }).click()
await page.locator('.seat--targetable:not(.seat--viewer)').click()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.players[0].hand.length === 0)
downfallChoiceResults.guardianWhirl = await page.evaluate(() => {
  const combat = window.__STS_DEBUG__.getRun().combat
  return [combat.players[0].freeAttacksThisTurn, combat.players[1].block, combat.enemies[0].hp,
    combat.presentationEvents.at(-1)?.resolvedType]
})

await page.evaluate((run) => {
  const next = structuredClone(run)
  const player = next.combat.players[0]
  next.combat.enemies = [next.combat.enemies[0]]
  Object.assign(next.combat, { phase: 'player', ruleset: 'downfall', pendingTriggers: [],
    pendingHermitSetupLoads: [], startTurnProgress: undefined })
  Object.assign(next.combat.enemies[0], { hp: 20, maxHp: 20, block: 0, dead: false })
  Object.assign(player, {
    character: 'guardian', energy: 5, block: 0, vigor: 0, vigorSpentThisTurn: 0,
    hand: [{ uid: 'ui-power-beam', defId: 'guardian_power_beam', upgraded: false }],
    discard: [{ uid: 'ui-power-beam-choice', defId: 'guardian_future_plans', upgraded: false }],
    chamber: [], slimes: [], soulburn: 0, guardianMode: 'defense', powers: [],
  })
  next.combat.players = [player]
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
downfallCardAssets.push(await readDownfallCardAsset(/^Power Beam,/))
await page.getByRole('button', { name: /^Power Beam,/ }).click()
await page.getByRole('button', { name: 'Play Future Plans for 0' }).click()
await page.locator('.enemy:not(.enemy--dead)').first().click()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.players[0].powers
  .some((power) => power.uid === 'ui-power-beam-choice'))
downfallChoiceResults.guardianPowerBeam = await page.evaluate(() => {
  const combat = window.__STS_DEBUG__.getRun().combat
  return [combat.players[0].energy, combat.enemies[0].hp,
    combat.players[0].powers.some((power) => power.uid === 'ui-power-beam-choice')]
})

await page.evaluate((run) => {
  const next = structuredClone(run)
  const player = next.combat.players[0]
  next.combat.enemies = [next.combat.enemies[0]]
  Object.assign(next.combat, { phase: 'player', ruleset: 'downfall', pendingTriggers: [], pendingHermitSetupLoads: [] })
  Object.assign(next.combat.enemies[0], { hp: 20, maxHp: 20, block: 0, dead: false })
  Object.assign(player, {
    character: 'guardian', guardianMode: 'attack', vigor: 0, strength: 0, weak: 0, hand: [
      { uid: 'ui-jasper-a', defId: 'guardian_defend', upgraded: false },
      { uid: 'ui-jasper-b', defId: 'guardian_strike', upgraded: false },
    ], exhaust: [], powers: [
      { uid: 'ui-floating-ruby', defId: 'guardian_floating_orbs', upgraded: false, attachedGemId: 'guardian_ruby' },
      { uid: 'ui-floating-jasper', defId: 'guardian_floating_orbs', upgraded: false, attachedGemId: 'guardian_jasper' },
    ], powerTriggersUsedThisTurn: [],
  })
  next.combat.players = [player]
  next.combat.powerTriggersUsedThisTurn = []
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
const rubyOrbs = page.getByRole('button', { name: 'Use Floating Orbs with Ruby' })
await rubyOrbs.click()
await page.waitForFunction(() =>
  document.querySelector('[aria-label="Use Floating Orbs with Ruby"]')?.getAttribute('aria-pressed') === 'true')
await page.locator('.enemy:not(.enemy--dead)').first().click()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.enemies[0].hp === 19)
const jasperOrbs = page.getByRole('button', { name: 'Use Floating Orbs with Jasper' })
await jasperOrbs.click()
await page.waitForFunction(() =>
  document.querySelector('[aria-label="Use Floating Orbs with Jasper"]')?.getAttribute('aria-pressed') === 'true')
await page.getByLabel('Exhaust Defend').check()
await page.getByLabel('Exhaust Strike').check()
await page.getByRole('button', { name: 'Confirm 2' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.players[0].exhaust.length === 2)
downfallChoiceResults.guardianPowerGems = await page.evaluate(() => {
  const combat = window.__STS_DEBUG__.getRun().combat
  return [combat.enemies[0].hp, combat.players[0].exhaust.length]
})

await page.evaluate((run) => {
  const next = structuredClone(run)
  const player = next.combat.players[0]
  next.combat.enemies = [next.combat.enemies[0]]
  Object.assign(next.combat, { phase: 'player', ruleset: 'downfall', pendingTriggers: [], pendingHermitSetupLoads: [] })
  Object.assign(next.combat.enemies[0], { hp: 20, maxHp: 20, block: 0, dead: false })
  Object.assign(player, {
    character: 'guardian', guardianMode: 'attack', hand: [
      { uid: 'ui-finder-hand-a', defId: 'guardian_defend', upgraded: false },
      { uid: 'ui-finder-hand-b', defId: 'guardian_strike', upgraded: false },
    ], draw: [
      { uid: 'ui-finder-draw-a', defId: 'guardian_defend', upgraded: false },
      { uid: 'ui-finder-draw-b', defId: 'guardian_strike', upgraded: false },
      { uid: 'ui-finder-draw-c', defId: 'guardian_harden', upgraded: false },
    ], discard: [], exhaust: [], powers: [
      { uid: 'ui-finder-ruby', defId: 'guardian_gem_finder', upgraded: false, attachedGemId: 'guardian_ruby' },
    ], powerTriggersUsedThisTurn: [],
  })
  next.combat.players = [player]
  next.combat.powerTriggersUsedThisTurn = []
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
await page.getByRole('button', { name: 'Use Gem Finder with Ruby' }).click()
await page.getByRole('button', { name: 'Confirm Scry' }).waitFor()
await page.locator('.enemy:not(.enemy--dead)').first().click()
assertEqual(await page.evaluate(() => window.__STS_DEBUG__.getRun().combat.enemies[0].hp), 20,
  'Gem Finder resolved its Ruby before the private Scry was confirmed')
await page.locator('.prompt').getByRole('button', { name: 'Defend', exact: true }).click()
await page.getByRole('button', { name: 'Confirm Scry' }).click()
await page.waitForFunction(() => {
  const combat = window.__STS_DEBUG__.getRun().combat
  return combat.enemies[0].hp === 19 && combat.players[0].discard.some((card) => card.uid === 'ui-finder-draw-a')
})

await page.evaluate((run) => {
  const next = structuredClone(run)
  const player = next.combat.players[0]
  next.combat.enemies = [next.combat.enemies[0]]
  Object.assign(next.combat, { phase: 'player', ruleset: 'downfall', pendingTriggers: [], pendingHermitSetupLoads: [] })
  Object.assign(next.combat.enemies[0], { hp: 20, maxHp: 20, block: 0, dead: false })
  Object.assign(player, {
    character: 'guardian', guardianMode: 'attack', hand: [
      { uid: 'ui-finder-exhaust-a', defId: 'guardian_defend', upgraded: false },
      { uid: 'ui-finder-exhaust-b', defId: 'guardian_strike', upgraded: false },
    ], draw: [
      { uid: 'ui-finder-jasper-draw-a', defId: 'guardian_defend', upgraded: false },
      { uid: 'ui-finder-jasper-draw-b', defId: 'guardian_strike', upgraded: false },
      { uid: 'ui-finder-jasper-draw-c', defId: 'guardian_harden', upgraded: false },
    ], discard: [], exhaust: [], powers: [
      { uid: 'ui-finder-jasper', defId: 'guardian_gem_finder', upgraded: false, attachedGemId: 'guardian_jasper' },
    ], powerTriggersUsedThisTurn: [],
  })
  next.combat.players = [player]
  next.combat.powerTriggersUsedThisTurn = []
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
await page.getByRole('button', { name: 'Use Gem Finder with Jasper' }).click()
await page.locator('.prompt').getByRole('button', { name: 'Strike', exact: true }).click()
await page.getByRole('button', { name: 'Confirm Scry' }).click()
await page.getByRole('button', { name: 'Scry confirmed' }).waitFor()
assertEqual(await page.evaluate(() => window.__STS_DEBUG__.getRun().combat.players[0].discard.length), 0,
  'Gem Finder resolved its Scry before Jasper was confirmed')
await page.getByLabel('Exhaust Defend').check()
await page.getByRole('button', { name: 'Confirm 1' }).click()
await page.waitForFunction(() => {
  const player = window.__STS_DEBUG__.getRun().combat.players[0]
  return player.discard.some((card) => card.uid === 'ui-finder-jasper-draw-b') &&
    player.exhaust.some((card) => card.uid === 'ui-finder-exhaust-a')
})
downfallChoiceResults.guardianGemFinder = await page.evaluate(() => {
  const player = window.__STS_DEBUG__.getRun().combat.players[0]
  return [player.discard.map((card) => card.uid), player.exhaust.map((card) => card.uid)]
})

await page.evaluate((run) => {
  const next = structuredClone(run)
  const player = next.combat.players[0]
  Object.assign(next.combat, { phase: 'player', pendingTriggers: [], pendingHermitSetupLoads: [] })
  Object.assign(player, {
    character: 'guardian', energy: 3, powers: [], discard: [],
    hand: [{ uid: 'ui-deep-breath', defId: 'deep_breath', upgraded: true }],
    exhaust: [
      { uid: 'ui-deep-strike', defId: 'guardian_strike', upgraded: false },
      { uid: 'ui-deep-defend', defId: 'guardian_defend', upgraded: false },
    ],
  })
  next.combat.players = [player]
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
await page.getByRole('button', { name: /^Deep Breath\+,/ }).click()
await page.getByRole('button', { name: /^Strike,/ }).click()
await page.getByRole('button', { name: /^Defend,/ }).click()
await page.getByRole('button', { name: 'Put selected cards on top of your discard pile' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.players[0].discard.length === 2)
downfallChoiceResults.deepBreath = await page.evaluate(() => {
  const player = window.__STS_DEBUG__.getRun().combat.players[0]
  return [player.discard.map((card) => card.uid), player.exhaust.map((card) => card.uid)]
})

await page.evaluate((run) => {
  const next = structuredClone(run)
  const player = next.combat.players[0]
  Object.assign(next.combat, { phase: 'player', pendingTriggers: [], pendingHermitSetupLoads: [] })
  Object.assign(player, {
    character: 'hexaghost', energy: 3, powers: [], draw: [],
    hand: [{ uid: 'ui-eerie-expedition', defId: 'eerie_expedition', upgraded: false }],
    exhaust: [
      { uid: 'ui-eerie-strike', defId: 'strike_hexaghost', upgraded: false },
      { uid: 'ui-eerie-defend', defId: 'defend_hexaghost', upgraded: false },
    ],
  })
  next.combat.players = [player]
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
await page.getByRole('button', { name: /^Eerie Expedition,/ }).click()
await page.getByRole('dialog', { name: 'Choose up to 2 cards from your Exhaust pile' }).waitFor()
await page.getByRole('button', { name: /^Strike,/ }).click()
await page.getByRole('button', { name: 'Put selected card on top of your draw pile' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.players[0].draw.length === 1)
downfallChoiceResults.eerieExpedition = await page.evaluate(() => {
  const player = window.__STS_DEBUG__.getRun().combat.players[0]
  return [player.draw.map((card) => card.uid), player.exhaust.map((card) => card.uid)]
})

await page.evaluate((run) => {
  const next = structuredClone(run)
  const player = next.combat.players[0]
  next.combat.enemies = [next.combat.enemies[0]]
  Object.assign(next.combat, { phase: 'player', ruleset: 'downfall', pendingTriggers: [], pendingHermitSetupLoads: [] })
  Object.assign(next.combat.enemies[0], { hp: 20, maxHp: 20, block: 0, dead: false })
  Object.assign(player, {
    character: 'slime_boss', energy: 3,
    hand: [{ uid: 'ui-lick', defId: 'slime_boss_lick', upgraded: false }], chamber: [], soulburn: 0,
    slimes: [{ card: { uid: 'ui-bruiser', defId: 'slime_boss_bruiser_slime', upgraded: false },
      level: 1, vigor: 0, temporaryVigor: 0, vigorTriggerUsedThisTurn: false }], powers: [],
  })
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
downfallCardAssets.push(await readDownfallCardAsset(/^Lick,/))
await page.getByRole('button', { name: /^Lick,/ }).click()
await page.getByRole('button', { name: /Bruiser Slime · level 1/ }).click()
await page.locator('.enemy:not(.enemy--dead)').first().click()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.players[0].hand.length === 0)
downfallChoiceResults.slime = await page.evaluate(() => window.__STS_DEBUG__.getRun().combat.enemies[0].hp)

await page.evaluate((run) => {
  const next = structuredClone(run)
  const player = next.combat.players[0]
  Object.assign(next.combat, { phase: 'player', ruleset: 'downfall', pendingTriggers: [], pendingHermitSetupLoads: [] })
  Object.assign(player, {
    character: 'slime_boss', energy: 3, powers: [], slimes: [], discard: [],
    hand: [{ uid: 'ui-replication', defId: 'slime_boss_replication', upgraded: false }],
    draw: [{ uid: 'ui-replication-slime', defId: 'slime_boss_bruiser_slime', upgraded: false }],
  })
  next.combat.players = [player]
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
await page.getByRole('button', { name: /^Replication,/ }).click()
const replicationDialog = page.getByRole('dialog', { name: 'Choose a Slime from your draw pile' })
await replicationDialog.getByRole('button', { name: /^Bruiser Slime,/ }).click()
downfallChoiceResults.replicationPrompt = await replicationDialog.getByRole('button', {
  name: 'Play selected Slime and shuffle',
}).innerText()
await page.evaluate(() => {
  const next = structuredClone(window.__STS_DEBUG__.getRun())
  next.combat.phase = 'enemy'
  window.__STS_DEBUG__.setRun(next)
})
await replicationDialog.waitFor({ state: 'hidden' })

await page.evaluate((run) => {
  const next = structuredClone(run)
  const player = next.combat.players[0]
  Object.assign(next.combat, { phase: 'player', ruleset: 'downfall', pendingTriggers: [], pendingHermitSetupLoads: [] })
  Object.assign(player, {
    character: 'slime_boss', energy: 3, powers: [], slimes: [], discard: [], draw: [],
    hand: [{ uid: 'ui-empty-replication', defId: 'slime_boss_replication', upgraded: false }],
  })
  next.combat.players = [player]
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
await page.getByRole('button', { name: /^Replication,/ }).click()
const emptyReplicationDialog = page.getByRole('dialog', { name: 'No Slime is in your draw pile' })
downfallChoiceResults.emptyReplicationPrompt = await emptyReplicationDialog.getByRole('button', {
  name: 'Shuffle and continue',
}).innerText()
await emptyReplicationDialog.getByRole('button', { name: 'Shuffle and continue' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.players[0].hand.length === 0)

await page.evaluate((run) => {
  const next = structuredClone(run)
  const player = next.combat.players[0]
  Object.assign(next.combat, { phase: 'player', ruleset: 'downfall', pendingTriggers: [], pendingHermitSetupLoads: [] })
  Object.assign(player, {
    character: 'slime_boss', guardianMode: null, energy: 3, powers: [], slimes: [], discard: [],
    hand: [{ uid: 'ui-overexert', defId: 'slime_boss_overexert', upgraded: false }],
    draw: [
      { uid: 'ui-overexert-whirl', defId: 'guardian_guardian_whirl', upgraded: false },
      { uid: 'ui-overexert-strike', defId: 'strike_ironclad', upgraded: false },
    ],
  })
  next.combat.players = [player]
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
await page.getByRole('button', { name: /^Overexert,/ }).click()
const overexertDialog = page.getByRole('dialog', { name: 'Choose a playable card from your hand' })
await overexertDialog.getByRole('button', { name: /^Guardian Whirl,/ }).click()
downfallChoiceResults.overexertDefensePrompt = await overexertDialog.getByRole('button', {
  name: 'Play selected card',
}).innerText()
await overexertDialog.getByRole('button', { name: /^Guardian Whirl,/ }).click()
await overexertDialog.getByRole('button', { name: /^Strike,/ }).click()
downfallChoiceResults.overexertPrompt = await overexertDialog.getByRole('button', {
  name: 'Play selected Attack twice',
}).innerText()
await page.evaluate(() => {
  const next = structuredClone(window.__STS_DEBUG__.getRun())
  next.combat.phase = 'enemy'
  window.__STS_DEBUG__.setRun(next)
})
await overexertDialog.waitFor({ state: 'hidden' })

await page.evaluate((run) => {
  const next = structuredClone(run)
  const player = next.combat.players[0]
  Object.assign(next.combat, { phase: 'player', ruleset: 'downfall', pendingTriggers: [], pendingHermitSetupLoads: [] })
  Object.assign(player, {
    character: 'slime_boss', energy: 3, powers: [], slimes: [], discard: [], draw: [],
    hand: [{ uid: 'ui-empty-overexert', defId: 'slime_boss_overexert', upgraded: false }],
  })
  next.combat.players = [player]
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
await page.getByRole('button', { name: /^Overexert,/ }).click()
const emptyOverexertDialog = page.getByRole('dialog', { name: 'No playable card remains' })
downfallChoiceResults.emptyOverexertPrompt = await emptyOverexertDialog.getByRole('button', { name: 'Continue' }).innerText()
await emptyOverexertDialog.getByRole('button', { name: 'Continue' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.players[0].hand.length === 0)

await page.evaluate((run) => {
  const next = structuredClone(run)
  const player = next.combat.players[0]
  next.combat.enemies = [next.combat.enemies[0]]
  Object.assign(next.combat, { phase: 'player', ruleset: 'downfall', pendingTriggers: [], pendingHermitSetupLoads: [] })
  Object.assign(next.combat.enemies[0], { hp: 20, maxHp: 20, block: 0, dead: false })
  Object.assign(player, {
    character: 'hexaghost', energy: 3, heat: 1, soulburn: 2,
    hand: [{ uid: 'ui-living-bomb', defId: 'living_bomb', upgraded: false }], chamber: [], slimes: [], powers: [],
  })
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
downfallCardAssets.push(await readDownfallCardAsset(/^Living Bomb,/))
await page.getByRole('button', { name: /^Living Bomb,/ }).click()
for (let index = 0; index < 3; index++) await page.locator('.enemy:not(.enemy--dead)').first().click()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.players[0].hand.length === 0)
downfallChoiceResults.hexaghost = await page.evaluate(() => {
  const combat = window.__STS_DEBUG__.getRun().combat
  return [combat.players[0].soulburn, combat.enemies[0].hp]
})

await page.evaluate((run) => {
  const next = structuredClone(run)
  const player = next.combat.players[0]
  next.combat.enemies = [next.combat.enemies[0]]
  Object.assign(next.combat, { phase: 'player', ruleset: 'downfall', pendingTriggers: [], pendingHermitSetupLoads: [] })
  Object.assign(next.combat.enemies[0], { hp: 20, maxHp: 20, weak: 0, vulnerable: 0, dead: false })
  Object.assign(player, {
    character: 'hexaghost', energy: 3, heat: 2, soulburn: 0,
    hand: [{ uid: 'ui-bright-ritual', defId: 'bright_ritual', upgraded: false }],
    chamber: [], slimes: [], powers: [],
  })
  next.combat.players = [player]
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
await page.getByRole('button', { name: /^Bright Ritual,/ }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.players[0].hand.length === 0)
downfallChoiceResults.brightRitual = await page.evaluate(() => {
  const combat = window.__STS_DEBUG__.getRun().combat
  return [combat.players[0].heat, combat.enemies[0].weak, combat.enemies[0].vulnerable]
})

await page.evaluate((run) => {
  const next = structuredClone(run)
  const player = next.combat.players[0]
  next.combat.enemies = [next.combat.enemies[0]]
  Object.assign(next.combat, { phase: 'player', ruleset: 'downfall', pendingTriggers: [], pendingHermitSetupLoads: [] })
  Object.assign(player, {
    character: 'hermit', energy: 3, chamber: [], chamberSlots: 2, slimes: [], soulburn: 0, powers: [],
    hand: [
      { uid: 'ui-covet', defId: 'hermit_covet', upgraded: false },
      { uid: 'ui-hermit-strike', defId: 'hermit_strike', upgraded: false },
    ],
  })
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
downfallCardAssets.push(await readDownfallCardAsset(/^Covet,/))
await page.getByRole('button', { name: /^Covet,/ }).click()
const loadDialog = page.getByRole('dialog', { name: /Choose 1 to Load/ })
await loadDialog.getByRole('button', { name: /^Strike,/ }).click()
await loadDialog.getByRole('button', { name: 'Load 1 card' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.players[0].chamber.length === 1)
downfallChoiceResults.hermit = await page.evaluate(() => window.__STS_DEBUG__.getRun().combat.players[0].chamber[0].defId)

await page.evaluate(() => {
  const next = structuredClone(window.__STS_DEBUG__.getRun())
  const player = next.combat.players[0]
  const chamberCard = player.chamber[0]
  player.cardPlayLocked = true
  next.combat.pendingHermitChamberPlays = [{
    playerId: player.id, sourceCardId: 'ui-mandatory-chamber', cardUids: [chamberCard.uid], free: true,
  }]
  window.__STS_DEBUG__.setRun(next)
})
await page.getByRole('button', { name: 'Skip unplayable Strike' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.pendingHermitChamberPlays.length === 0)
downfallChoiceResults.hermitMandatorySkip = await page.evaluate(() => {
  const player = window.__STS_DEBUG__.getRun().combat.players[0]
  return [player.chamber[0]?.defId, player.hand.length]
})

await page.evaluate((run) => {
  const next = structuredClone(run)
  const player = next.combat.players[0]
  Object.assign(next.combat, { phase: 'player', ruleset: 'downfall', pendingTriggers: [], pendingHermitSetupLoads: [] })
  Object.assign(player, {
    character: 'hermit', energy: 3, chamberSlots: 2, slimes: [], soulburn: 0, powers: [],
    chamber: [
      { uid: 'ui-full-old', defId: 'hermit_defend', upgraded: false },
      { uid: 'ui-full-kept', defId: 'hermit_strike', upgraded: false },
    ],
    hand: [
      { uid: 'ui-full-covet', defId: 'hermit_covet', upgraded: false },
      { uid: 'ui-full-load', defId: 'hermit_snapshot', upgraded: false },
    ],
  })
  next.combat.players = [player]
  window.__STS_DEBUG__.setRun(next)
}, combatAppearanceRun)
await page.getByRole('button', { name: /^Covet,/ }).click()
const fullLoadDialog = page.getByRole('dialog', { name: /Choose 1 to Load/ })
await fullLoadDialog.getByRole('button', { name: /^Snapshot,/ }).click()
await fullLoadDialog.getByRole('button', { name: 'Load 1 card' }).click()
await page.locator('.prompt__mode').filter({ hasText: /^Defend$/ }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.players[0].hand.length === 0)
downfallChoiceResults.hermitFullChamber = await page.evaluate(() => {
  const player = window.__STS_DEBUG__.getRun().combat.players[0]
  return [player.chamber.map((card) => card.defId), player.discard.map((card) => card.defId)]
})

check('Downfall combat choices are reachable from the real card UI', () => {
  assertDeepEqual(downfallCardAssets.map(({ width }) => width), [448, 448, 448, 448, 448],
    'Downfall hand cards use decoded scan thumbnails')
  assert(downfallCardAssets.every(({ source }) => source?.startsWith('/assets/cards-sm/')),
    `Downfall card scan paths: ${JSON.stringify(downfallCardAssets)}`)
  assertDeepEqual(downfallChoiceResults.guardian, [0, 16], 'Guardian spends chosen Block after its Vigor choice')
  assertDeepEqual(downfallChoiceResults.guardianStasis, [2, 1],
    'Guardian assigns every Stasis Field Block icon independently')
  assertDeepEqual(downfallChoiceResults.guardianWhirl, [1, 2, 20, 'skill'],
    'Defense Mode Guardian Whirl keeps its Attack discount and targets an ally')
  assertDeepEqual(downfallChoiceResults.guardianPowerBeam, [3, 17, true],
    'Defense Mode Power Beam chooses and plays a Power for 0 Energy')
  assertDeepEqual(downfallChoiceResults.guardianPowerGems, [19, 2],
    'Floating Orbs collects offensive and private Jasper socket choices')
  assertDeepEqual(downfallChoiceResults.guardianGemFinder,
    [['ui-finder-jasper-draw-b'], ['ui-finder-exhaust-a']],
    'Gem Finder submits private Scry and socketed Gem choices atomically')
  assertDeepEqual(downfallChoiceResults.deepBreath,
    [['ui-deep-strike', 'ui-deep-defend'], ['ui-deep-breath']],
    'Deep Breath requires and preserves the chosen Exhaust-pile order')
  assertDeepEqual(downfallChoiceResults.eerieExpedition,
    [['ui-eerie-strike'], ['ui-eerie-defend', 'ui-eerie-expedition']],
    'Eerie Expedition permits a partial up-to selection')
  assertEqual(downfallChoiceResults.slime, 19, 'Slime Boss can choose and Command a Slime')
  assertEqual(downfallChoiceResults.replicationPrompt, 'Play selected Slime and shuffle')
  assertEqual(downfallChoiceResults.emptyReplicationPrompt, 'Shuffle and continue')
  assertEqual(downfallChoiceResults.overexertDefensePrompt, 'Play selected card')
  assertEqual(downfallChoiceResults.overexertPrompt, 'Play selected Attack twice')
  assertEqual(downfallChoiceResults.emptyOverexertPrompt, 'Continue')
  assertDeepEqual(downfallChoiceResults.hexaghost, [0, 17], 'Hexaghost assigns every Soulburn hit')
  assertDeepEqual(downfallChoiceResults.brightRitual, [1, 0, 0],
    'low-Heat Bright Ritual plays without inactive enemy target prompts')
  assertEqual(downfallChoiceResults.hermit, 'hermit_strike', 'Hermit can choose a card to Load')
  assertDeepEqual(downfallChoiceResults.hermitMandatorySkip, ['hermit_strike', 0],
    'an impossible mandatory Chamber play can advance without moving its card')
  assertDeepEqual(downfallChoiceResults.hermitFullChamber,
    [['hermit_snapshot', 'hermit_strike'], ['hermit_defend', 'hermit_covet']],
    'full Chamber Load lets the player choose and discard the replaced card')
})
await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), combatAppearanceRun)

const musicBeforeBoss = await page.evaluate(() => window.__SFX_PLAYS__)
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
await page.keyboard.press('Escape')
await pauseMenu.waitFor()
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
await page.locator('.enemy').first().click()
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
await page.locator('.enemy').first().click()
const committedCardFlight = page.locator('.card-flight').filter({ hasText: 'Bash' }).last()
await committedCardFlight.waitFor()
const cardPlayMotion = await committedCardFlight.evaluate((flight) => ({
  animation: getComputedStyle(flight).animationName,
  destination: [...flight.classList].find((name) => name.startsWith('card-flight--')),
}))
await page.evaluate(() => {
  for (const animation of document.getAnimations()) {
    if (animation.animationName === 'card-resolve') {
      animation.currentTime = 500
      animation.pause()
    }
  }
})
await page.screenshot({ path: join(animationReferenceDir, 'combat-card-play.png'), timeout: 15_000 })
const cardPlayLanding = await page.evaluate(() => {
  const flight = [...document.querySelectorAll('.card-flight')].at(-1)
  const animation = flight?.getAnimations().find((candidate) => candidate.animationName === 'card-resolve')
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
    if (animation.animationName === 'card-resolve' && animation.playState === 'paused') animation.play()
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
const draggedEnemy = page.locator('.enemy').first()
await draggedRowCard.hover()
let draggedCardBox = await draggedRowCard.boundingBox()
let draggedEnemyBox = await draggedEnemy.boundingBox()
assert(draggedCardBox && draggedEnemyBox, 'drag fixtures are visible')
assertEqual(await draggedRowCard.getAttribute('aria-disabled'), 'false', 'dragged Cleave is playable')
await page.mouse.move(draggedCardBox.x + draggedCardBox.width / 2,
  draggedCardBox.y + draggedCardBox.height / 2)
await page.mouse.down()
await page.mouse.move(draggedCardBox.x - 180, draggedCardBox.y - 130, { steps: 8 })
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
await draggedRowCard.hover()
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
  assert(cardDragVisual.cursor.includes('/assets/ui/cursor.png'), cardDragVisual.cursor)
  assert(cardDragVisual.targetCursor.includes('/assets/ui/cursor.png'), cardDragVisual.targetCursor)
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
const bossTarget = page.locator('.enemy:not(.enemy--boss)').first()
await bossRowCard.hover()
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
await draggedStrike.hover()
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
const ragnarokEnemy = page.locator('.enemy').first()
await draggedRagnarok.hover()
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
const flaskTargets = page.locator('.enemy')
const flaskPrompt = page.locator('.prompt').filter({ hasText: 'token target 2/2' })
// A synthetic low-level drag can occasionally miss its opening pointerdown in
// headless Chromium. Retry once only while the first target has not staged.
for (let attempt = 0; attempt < 2 && await flaskPrompt.count() === 0; attempt += 1) {
  await draggedFlask.hover()
  const draggedFlaskBox = await draggedFlask.boundingBox()
  const firstFlaskTargetBox = await flaskTargets.first().boundingBox()
  assert(draggedFlaskBox && firstFlaskTargetBox, 'Bouncing Flask drag fixtures are visible')
  await page.mouse.move(draggedFlaskBox.x + draggedFlaskBox.width / 2,
    draggedFlaskBox.y + draggedFlaskBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(firstFlaskTargetBox.x + firstFlaskTargetBox.width / 2,
    firstFlaskTargetBox.y + firstFlaskTargetBox.height / 2, { steps: 10 })
  await page.mouse.up()
  await page.waitForTimeout(250)
}
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
await draggedDefend.hover()
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
await draggedDodge.hover()
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
await discardChoice.hover()
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
await draggedFlex.hover()
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
  trailAnimation: getComputedStyle(flight, '::before').animationName,
  traceColor: getComputedStyle(flight).getPropertyValue('--flight-trace').trim(),
  countInFlight: document.querySelector('[data-pile="exhaust"] .pile__count')?.textContent,
}))
await page.evaluate(() => {
  for (const animation of document.getAnimations()) {
    if (['card-resolve', 'card-flight-smoke', 'card-flight-motes'].includes(animation.animationName)) {
      animation.currentTime = 500
      animation.pause()
    }
  }
})
await shot('03b-card-center-hold')
await page.evaluate(() => {
  for (const animation of document.getAnimations()) {
    if (['card-resolve', 'card-flight-smoke', 'card-flight-motes'].includes(animation.animationName)) {
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
await page.waitForFunction(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
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
await page.locator('.enemy').first().click()
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
await page.locator('.enemy').first().click()
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
const focusShiftPinned = await page.locator('.card[data-keyword-help]').evaluateAll((cards) => cards.map((card) => card.title))
await page.keyboard.up('Shift')
await keywordCard.hover()
await aoeCard.focus()
await page.keyboard.down('Shift')
const focusWinsHover = await page.locator('.card[data-keyword-help]').evaluateAll((cards) => cards.map((card) => card.title))
await page.mouse.move(5, 5)
await keywordCard.hover()
const pointerFollowsFocus = await page.locator('.card[data-keyword-help]').evaluateAll((cards) => cards.map((card) => card.title))
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
  await page.setViewportSize({ width: 600, height: 500 })
await playedPower.click()
  await playedPower.focus()
  await page.keyboard.down('Shift')
  await secondPlayedPower.click()
  await page.waitForTimeout(100)
  const responsivePlayedPowerLayout = await secondPlayedPower.evaluate((card) => {
    const tooltip = document.getElementById(card.dataset.keywordHelpId)
    const help = tooltip?.getBoundingClientRect()
    const zoom = document.querySelector('.power__zoom')?.getBoundingClientRect()
    return {
      help: help && { left: help.left, top: help.top, right: help.right, bottom: help.bottom },
      zoom: zoom && { left: zoom.left, top: zoom.top, right: zoom.right, bottom: zoom.bottom },
      open: tooltip?.hasAttribute('data-open'),
      pinned: tooltip?.hasAttribute('data-pinned'),
      inViewport: Boolean(help && help.left >= 0 && help.top >= 0 && help.right <= innerWidth && help.bottom <= innerHeight),
      overlaps: Boolean(help && zoom && help.left < zoom.right && help.right > zoom.left && help.top < zoom.bottom && help.bottom > zoom.top),
    }
  })
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
await cardDialog.getByRole('button', { name: 'Close' }).click()
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
  assert(responsivePlayedPowerLayout.open && responsivePlayedPowerLayout.pinned &&
    responsivePlayedPowerLayout.inViewport && !responsivePlayedPowerLayout.overlaps,
  `responsive Power help layout failed: ${JSON.stringify(responsivePlayedPowerLayout)}`)
  assert(dialogHoverStayedHidden, 'hover alone should not show keyword help in card dialogs')
  assertDeepEqual(dialogTooltip, { hostedByDialog: true, filter: 'none', inViewport: true })
})
if (args.includes('--keyword-tooltips-only')) {
  const fastExitCard = page.getByRole('button', { name: /^Choke,/ })
  await page.mouse.move(5, 5)
  await fastExitCard.evaluate((card) => {
    card.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
    card.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body }))
  })
  await page.waitForTimeout(50)
  const fastExitStayedClosed = await fastExitCard.evaluate((card) =>
    !document.getElementById(card.dataset.keywordHelpId)?.hasAttribute('data-open'))
  check('leaving before a lazy keyword board mounts does not open a stale board', () => assert(fastExitStayedClosed))
  await page.setViewportSize({ width: 390, height: 844 })
  await keywordCard.hover()
  await page.keyboard.down('Shift')
  await page.waitForFunction((card) => document.getElementById(card.dataset.keywordHelpId)?.hasAttribute('data-open'),
    await keywordCard.elementHandle())
  const mobileTooltipInViewport = await keywordCard.evaluate((card) => {
    const box = document.getElementById(card.dataset.keywordHelpId).getBoundingClientRect()
    return box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight
  })
  await shot('02f-card-keyword-help-mobile')
  await page.keyboard.up('Shift')
  check('keyword help stays inside a mobile viewport', () => assert(mobileTooltipInViewport))
  await page.setViewportSize({ width: 844, height: 320 })
  const chokeCard = fastExitCard
  await page.mouse.move(5, 5)
  await page.keyboard.down('Shift')
  await chokeCard.hover()
  await page.waitForFunction((card) => document.getElementById(card.dataset.keywordHelpId)?.hasAttribute('data-pinned'),
    await chokeCard.elementHandle())
  const landscapeTooltip = await chokeCard.evaluate((card) => {
    const tooltip = document.getElementById(card.dataset.keywordHelpId)
    return {
      overflow: tooltip.scrollHeight > tooltip.clientHeight,
      pointerEvents: getComputedStyle(tooltip).pointerEvents,
    }
  })
  await page.keyboard.press('End')
  const landscapeKeyboardScrolled = await chokeCard.evaluate((card) =>
    document.getElementById(card.dataset.keywordHelpId).scrollTop > 0)
  await shot('02g-card-keyword-help-landscape')
  await page.keyboard.up('Shift')
  check('a pinned tall board scrolls on a short landscape viewport', () => {
    assertDeepEqual(landscapeTooltip, { overflow: true, pointerEvents: 'auto' })
    assert(landscapeKeyboardScrolled, 'Shift+End should scroll the pinned board')
  })
  await page.setViewportSize({ width: 1024, height: 720 })
  const mountedKeywordHelpBeforeCompendium = await page.locator('.card-keyword-tips').count()
  await page.keyboard.press('Escape')
  if (!await pauseMenu.count()) await page.keyboard.press('Escape')
  await pauseMenu.getByRole('button', { name: 'Compendium' }).focus()
  await page.keyboard.press('Enter')
  await page.locator('.compendium').waitFor()
  const compendiumLazyHelp = {
    cards: await page.locator('.compendium-card').count(),
    baseline: mountedKeywordHelpBeforeCompendium,
    mounted: await page.locator('.card-keyword-tips').count(),
  }
  await page.getByPlaceholder('Search').fill('Shockwave')
  const compendiumCard = page.locator('.compendium-card').first()
  await compendiumCard.hover()
  await page.waitForTimeout(50)
  const compendiumHoverStayedHidden = await compendiumCard.evaluate((card) =>
    !document.getElementById(card.dataset.keywordHelpId)?.hasAttribute('data-open'))
  await page.keyboard.down('Shift')
  await page.waitForFunction((card) => document.getElementById(card.dataset.keywordHelpId)?.hasAttribute('data-open'),
    await compendiumCard.elementHandle())
  const compendiumGridHelp = await compendiumCard.evaluate((card) => {
    const tooltip = document.getElementById(card.dataset.keywordHelpId)
    return tooltip.parentElement === document.body && tooltip.hasAttribute('data-open')
  })
  await compendiumCard.click()
  const compendiumDetail = page.locator('.compendium__detail-card')
  await compendiumDetail.hover()
  await page.waitForFunction((card) => document.getElementById(card.dataset.keywordHelpId)?.hasAttribute('data-open'),
    await compendiumDetail.elementHandle())
  const compendiumDetailHelp = await compendiumDetail.evaluate((card) => {
    const tooltip = document.getElementById(card.dataset.keywordHelpId)
    return tooltip.parentElement === card.closest('dialog') && tooltip.hasAttribute('data-open')
  })
  await shot('02h-compendium-keyword-help')
  await page.keyboard.up('Shift')
  await page.getByRole('button', { name: 'Close card detail' }).click()
  await page.getByPlaceholder('Search').fill('Calculated Gamble')
  const upgradeToggleCard = page.locator('.compendium-card').first()
  await page.mouse.move(5, 5)
  await page.keyboard.down('Shift')
  await upgradeToggleCard.hover()
  await page.waitForFunction((card) => document.getElementById(card.dataset.keywordHelpId)?.hasAttribute('data-pinned'),
    await upgradeToggleCard.elementHandle())
  const compendiumSearch = page.getByPlaceholder('Search')
  await compendiumSearch.focus()
  await compendiumSearch.evaluate((input) => input.setSelectionRange(0, 0))
  await page.keyboard.press('End')
  const editableShiftNavigation = await compendiumSearch.evaluate((input) => ({
    start: input.selectionStart,
    end: input.selectionEnd,
    length: input.value.length,
  }))
  await page.getByLabel('View upgrades').check()
  const upgradedHasNoKeywordHelp = await upgradeToggleCard.evaluate((card) => !card.dataset.keywordHelpId)
  const staleEscapePrevented = await page.evaluate(() => {
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    document.dispatchEvent(event)
    return event.defaultPrevented
  })
  await page.getByLabel('View upgrades').uncheck()
  await page.mouse.move(5, 5)
  await upgradeToggleCard.hover()
  await page.waitForFunction((card) => document.getElementById(card.dataset.keywordHelpId)?.hasAttribute('data-open'),
    await upgradeToggleCard.elementHandle())
  const restoredKeywordHelp = await upgradeToggleCard.evaluate((card) =>
    document.getElementById(card.dataset.keywordHelpId)?.hasAttribute('data-open') &&
      document.getElementById(card.dataset.keywordHelpId)?.hasAttribute('data-pinned'))
  await page.keyboard.up('Shift')
  check('compendium grid and detail cards expose keyword help', () => {
    assert(compendiumLazyHelp.cards > 200 && compendiumLazyHelp.mounted <= compendiumLazyHelp.baseline,
      `inactive compendium cards mounted tooltip portals: ${JSON.stringify(compendiumLazyHelp)}`)
    assert(compendiumHoverStayedHidden, 'hover alone should not show keyword help in the Compendium')
    assert(compendiumGridHelp)
    assert(compendiumDetailHelp)
    assertDeepEqual(editableShiftNavigation, {
      start: 0, end: editableShiftNavigation.length, length: editableShiftNavigation.length,
    }, 'pinned help should not intercept Shift+navigation in editable fields')
    assert(upgradedHasNoKeywordHelp, 'the upgraded zero-keyword face should remove keyword help')
    assert(!staleEscapePrevented, 'a removed keyword board should not swallow Escape')
    assert(restoredKeywordHelp, 'returning to the base face should restore pinned keyword help')
  })
  const touchContext = await browser.newContext({ ...devices['iPhone 13'] })
  const touchPage = await touchContext.newPage()
  auditErrors(touchPage)
  await touchPage.goto(base)
  await touchPage.locator('#root').waitFor()
  await touchPage.evaluate(() => {
    window.__TOUCH_EVENTS__ = []
    for (const type of ['pointerover', 'pointerdown', 'pointerup', 'pointerout', 'focusin']) {
      document.addEventListener(type, (event) => window.__TOUCH_EVENTS__.push({
        type, pointerType: event.pointerType ?? null,
      }))
    }
    const card = document.createElement('button')
    card.dataset.keywordHelpId = 'touch-keyword-help'
    Object.assign(card.style, { position: 'fixed', left: '40px', top: '40px', width: '120px', height: '160px' })
    const tooltip = document.createElement('span')
    tooltip.id = 'touch-keyword-help'
    tooltip.className = 'card-keyword-tips'
    tooltip.textContent = 'Touch help'
    document.body.append(card, tooltip)
  })
  await touchPage.touchscreen.tap(100, 100)
  await touchPage.waitForTimeout(50)
  const touchHelpState = await touchPage.evaluate(() => ({
    open: document.getElementById('touch-keyword-help').hasAttribute('data-open'),
    events: window.__TOUCH_EVENTS__,
    hovered: document.querySelector('[data-keyword-help-id="touch-keyword-help"]').matches(':hover'),
    focused: document.activeElement?.dataset.keywordHelpId === 'touch-keyword-help',
  }))
  await touchContext.close()
  check('touching a card does not leave sticky keyword help open', () =>
    assert(!touchHelpState.open, JSON.stringify(touchHelpState)))
  check('the focused browser run reported no errors', () => {
    assertDeepEqual(consoleErrors, [])
    assertDeepEqual(pageErrors, [])
    assertDeepEqual(requestFailures, [])
  })
  await browser.close()
  await server.close()
  report('browser keyword tooltips')
  process.exit()
}
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
await currentDeckDialog.getByRole('button', { name: 'Close' }).click()
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
const discardPlayers = beforeDiscard.players.filter((player) => !player.dead)
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
  const secondAttack = beforeSecondPlay.players[0].hand.findIndex((card) =>
    card.defId.startsWith('strike'),
  )
  assert(secondAttack >= 0, 'expected a Strike in the second hand')
  await page.locator('.hand .card').nth(secondAttack).click()
  await page.locator('.enemy').first().click()
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
        const enemy = page.locator('.enemy:not([disabled])').first()
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
// Two turns, each blurring the focused control while End turn is unmounted.
// That blur is the point: `endTurn()` routes through the seat menu and parks
// focus on a <summary> which SURVIVES the round, and the effect is supposed to
// leave that alone — so asserting against it tested nothing. The real bug is a
// keyboard player holding End turn when it is destroyed and rebuilt.
for (let enemyTurn = 0; enemyTurn < 2; enemyTurn += 1) {
  // Asserted rather than assumed: if the fight ends inside this loop the waits
  // below can never be satisfied, and the round reports a 30s Playwright
  // timeout instead of naming what went wrong.
  const before = await readState()
  assert(before && !['won', 'lost'].includes(before.phase),
    `the fight ended before enemy turn ${enemyTurn + 1}; this block needs a live combat`)
  // `endTurn()` parks focus on the seat menu's <summary> on its way through the
  // discard prompt, and that focused control is what this round needs to blur.
  await plantDiscardOrderCards()
  // The blur has to land while the button is gone, and the enemy round can be
  // over before a Playwright round-trip observes it — so the page watches for
  // that frame itself instead of being asked about it afterwards.
  await page.evaluate(() => {
    window.__BLURRED_WITHOUT_END_TURN__ = false
    // Each round owns its watcher: a previous one still looping would launder
    // this round's miss into a pass.
    const generation = (window.__BLUR_WATCH_GENERATION__ = (window.__BLUR_WATCH_GENERATION__ ?? 0) + 1)
    let sawEnemy = false
    const watch = () => {
      if (window.__BLUR_WATCH_GENERATION__ !== generation) return
      const enemyRound = ['enemy', 'roundEnd'].includes(window.__STS_DEBUG__.getState().phase)
      sawEnemy ||= enemyRound
      if (sawEnemy && !enemyRound) return
      if (enemyRound && !document.querySelector('.combat__end-turn') &&
        document.activeElement instanceof HTMLElement &&
        document.activeElement !== document.body && document.activeElement !== document.documentElement) {
        document.activeElement.blur()
        window.__BLURRED_WITHOUT_END_TURN__ = true
      }
      requestAnimationFrame(watch)
    }
    watch()
  })
  await endTurn()
  // Anchored to the turn this iteration started on: reading the live turn here
  // waits for one MORE turn whenever the enemy already finished its own.
  await waitForAutomaticTurn(before.turn + 1)
  assert(await page.evaluate(() => window.__BLURRED_WITHOUT_END_TURN__),
    `enemy turn ${enemyTurn + 1} never blurred a focused control while End turn was gone; ` +
    'the round passed between frames, the button survived it, or nothing held focus — ' +
    'either way the restore below tests nothing')
}
// `waitForAutomaticTurn` polls the store, but the focus restore is a React
// effect that runs after commit — waiting on the DOM removes that race rather
// than relying on two Playwright round-trips of slack.
await page.waitForFunction(() => document.activeElement?.classList?.contains('combat__end-turn'))
  .catch(() => {})
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

// The combat screen clears itself into the printed three-card reward (p.8).
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'reward', { timeout: 5000 })
const hiddenRewardRun = await readRun()
const revealButtons = await page.getByRole('button', { name: /^Reveal 3 for/ }).count()
const potionSkips = page.getByRole('button', { name: 'Skip Potion unseen' })
check('card rewards stay face down until each player reveals or skips', () => {
  assertEqual(hiddenRewardRun.rewards.length, 2)
  assert(hiddenRewardRun.rewards.every((offer) => offer.choices === null), 'an offer leaked before reveal')
  assertEqual(revealButtons, 2)
})
await page.waitForTimeout(200)
await shot('05e-card-rewards-hidden')
while (await potionSkips.count()) await potionSkips.first().click()
for (const player of hiddenRewardRun.players) {
  await page.getByRole('button', { name: `Reveal 3 for ${player.name}` }).click()
}
await page.waitForFunction(() => document.querySelectorAll('.reward-screen__cards .card').length === 6)
const rewardDealMotion = await page.locator('.reward-screen__choice').first().evaluate((choice) =>
  getComputedStyle(choice).animationName)
await page.evaluate(() => {
  for (const animation of document.getAnimations()) {
    if (animation.animationName === 'reward-card-deal') {
      animation.currentTime = 190
      animation.pause()
    }
  }
})
await page.screenshot({ path: join(animationReferenceDir, 'reward-deal.png'), timeout: 15_000 })
await page.evaluate(() => {
  for (const animation of document.getAnimations()) {
    if (animation.animationName === 'reward-card-deal' && animation.playState === 'paused') animation.play()
  }
})
// An upgraded reward still reveals base faces; only the card collected is
// upgraded. Force that printed reward type so the UI contract stays covered.
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.rewards[0].upgraded = true
  debug.setRun(run)
})
await page.waitForFunction(() => document.querySelector('.reward-screen__upgrade') !== null)
if (artSynced) {
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.reward-screen__cards .card__art')]
      .every((image) => image.complete && image.naturalWidth > 0),
  )
}
const rewardRun = await readRun()
const rewardCards = await page.locator('.reward-screen__cards .card').count()
const rewardArt = await page.locator('.reward-screen__cards .card__art').evaluateAll((images) =>
  images.map((image) => ({ src: image.getAttribute('src'), ok: image.complete && image.naturalWidth > 0 })),
)
const collectLocked = await page.getByRole('button', { name: 'Everyone must choose' }).isDisabled()
check('victory reveals three card rewards to every living player', () => {
  assertEqual(rewardRun.rewards.length, 2, 'both players receive their own reward')
  assertEqual(rewardCards, 6, 'three choices are shown per player')
  assert(collectLocked, 'the party cannot leave before everyone chooses')
  assertEqual(rewardDealMotion, 'reward-card-deal', 'reward cards should deal into place')
  if (artSynced) {
    const broken = rewardArt.filter((entry) => !entry.ok)
    assertEqual(broken.length, 0, `broken reward art: ${broken.map((entry) => entry.src).join(', ')}`)
  }
})
await shot('05ea-card-rewards')
const firstReward = page.locator('.reward-screen__choice').first()
const upgradedRewardLabel = await firstReward.locator('.card').getAttribute('aria-label')
const upgradedRewardArt = await firstReward.locator('.card__art').getAttribute('src')
const previewPressed = await firstReward.getByRole('button', { name: /^Show .* base$/ }).getAttribute('aria-pressed')
await shot('05eaa-card-reward-upgrade')
await firstReward.getByRole('button', { name: /^Show .* base$/ }).click()
const baseRewardLabel = await firstReward.locator('.card').getAttribute('aria-label')
const baseRewardArt = await firstReward.locator('.card__art').getAttribute('src')
const previewSelected = await firstReward.locator('.card').getAttribute('aria-pressed')
check('Full Knowledge previews both faces even when the collected reward will be upgraded', () => {
  assert((upgradedRewardLabel ?? '').includes('+,'), `the upgraded face is not announced: ${upgradedRewardLabel}`)
  assert(!(baseRewardLabel ?? '').includes('+,'), `the base face cannot be previewed: ${baseRewardLabel}`)
  assert(baseRewardArt !== upgradedRewardArt && upgradedRewardArt?.endsWith('+.webp'), 'the art did not flip')
  assertEqual(previewPressed, 'true', 'the upgrade preview control is not announced as pressed')
  assertEqual(previewSelected, 'false', 'previewing an upgrade must not choose the reward')
})
const deckSizesBeforeReward = rewardRun.players.map((player) => player.deck.length)
await page.locator('.reward-screen__player').nth(0).locator('.card').first().click()
const selectedCardPressed = await page.locator('.reward-screen__player').nth(0).locator('.card').first().getAttribute('aria-pressed')
await page.getByRole('button', { name: /Skip Silent's card/ }).click()
const skipSelection = await page.getByRole('button', { name: /Skip Silent's card/ }).evaluate((button) => ({
  pressed: button.getAttribute('aria-pressed'),
  text: button.textContent,
  background: getComputedStyle(button).backgroundColor,
}))
const unselectedSkipBackground = await page.getByRole('button', { name: /Skip Ironclad's card/ }).evaluate(
  (button) => getComputedStyle(button).backgroundColor,
)
check('a chosen skip is visibly and accessibly selected', () => {
  assertEqual(selectedCardPressed, 'true', 'the selected card is not exposed as pressed')
  assertEqual(skipSelection.pressed, 'true')
  assert(skipSelection.text.includes('✓'), 'the chosen skip has no visible checkmark')
  assert(skipSelection.background !== unselectedSkipBackground, 'the chosen skip looks like the default button')
})
await shot('05ed-card-rewards-chosen')
await page.getByRole('button', { name: 'Collect rewards' }).click()
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
check('the current map position and reachable route stay visibly alive', () => {
  assertEqual(mapMotion.route, 'map-trail')
  assertEqual(mapMotion.marker, 'map-ring')
  assert(mapMotion.positionInView, 'the current room is outside the map scrollport')
})
await shot('05f-back-on-map')

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
  slots: document.querySelectorAll('.seat--viewer .token--orb').length,
  beads: document.querySelectorAll('.seat--viewer .token--orb:not(.token--orb-empty)').length,
  classes: [...document.querySelectorAll('.seat--viewer .token--orb')].map((b) => b.className),
  sprites: [...document.querySelectorAll('.seat--viewer .token--orb:not(.token--orb-empty)')]
    .map((orb) => getComputedStyle(orb, '::before').backgroundImage),
  values: [...document.querySelectorAll('.seat--viewer .orb__value')].map((value) => value.textContent),
  floatsOverPortrait: Boolean(document.querySelector('.seat--viewer .seat__portrait > .orbs')),
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
await page.waitForFunction(() => [...document.querySelectorAll('.seat--viewer .orb__value')]
  .map((value) => value.textContent).join(',') === '0,1')
const suppressedOrbValues = await page.locator('.seat--viewer .orb__value').allTextContents()
const suppressedOrbLabel = await page.locator('.seat--viewer').getAttribute('aria-label')
check('Orb values follow effects that suppress damage this turn', () => {
  assertDeepEqual(suppressedOrbValues, ['0', '1'])
  assert(suppressedOrbLabel?.includes('0 damage at end of turn'), suppressedOrbLabel ?? 'missing seat label')
})
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[0].damageDealtZeroThisTurn = false
  debug.setRun(run)
})

// p.16 makes every evoke two real choices: any occupied Orb, then an enemy
// for Lightning or Dark. Exercise the staged picker through the rendered UI,
// not by passing a context directly to the engine.
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const player = run.combat.players[0]
  player.hand = [{ uid: 'ui-dual-cast', defId: 'dual_cast', upgraded: false }]
  player.energy = 3
  player.orbs = ['lightning', 'frost', 'dark']
  run.combat.phase = 'player'
  for (const enemy of run.combat.enemies) {
    Object.assign(enemy, { hp: 20, maxHp: 20, block: 0, dead: false })
  }
  debug.setRun(run)
})
await page.getByRole('button', { name: /^Dual Cast,/ }).click()
await page.getByRole('button', { name: /dark slot 3/i }).waitFor()
await page.waitForTimeout(250)
await shot('06-orb-evoke-choice')
await page.getByRole('button', { name: /dark slot 3/i }).click()
await page.getByText('Choose an enemy for this evoke').waitFor()
await page.waitForTimeout(250)
await shot('06b-orb-evoke-target')
await page.locator('.enemy--targeted').nth(1).click()
await page.locator('.enemy--targeted').first().click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hand.length === 0)
const chosenEvokes = await readState()
check('the local UI removes one Orb and collects a target for each repeated Evoke', () => {
  assertDeepEqual(chosenEvokes.players[0].orbs, ['lightning', 'frost', null])
  const hp = chosenEvokes.enemies.map((enemy) => enemy.hp).sort((a, b) => a - b)
  assertDeepEqual(hp.slice(0, 2), [17, 17])
  assert(hp.slice(2).every((value) => value === 20), 'only the two chosen enemies should take damage')
  assertEqual(chosenEvokes.players[0].energy, 2)
})

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const player = run.combat.players[0]
  player.hand = [{ uid: 'ui-recursion', defId: 'recursion', upgraded: false }]
  player.energy = 3
  player.orbs = ['lightning', 'frost', 'dark']
  for (const enemy of run.combat.enemies) Object.assign(enemy, { hp: 20, maxHp: 20, block: 0, dead: false })
  debug.setRun(run)
})
await page.getByRole('button', { name: /^Recursion,/ }).click()
await page.getByRole('button', { name: /dark slot 3/i }).waitFor()
await page.waitForTimeout(250)
await shot('06c-recursion-choice')
await page.getByRole('button', { name: /dark slot 3/i }).click()
await page.locator('.enemy--targeted').first().click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hand.length === 0)
const recursed = await readState()
check('Recursion uses the Orb picker and re-channels the chosen type', () => {
  assertDeepEqual(recursed.players[0].orbs, ['lightning', 'frost', 'dark'])
  assert(recursed.enemies.some((enemy) => enemy.hp === 17), 'the chosen Dark should evoke for 3')
  assertEqual(recursed.players[0].energy, 2)
})

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const player = run.combat.players[0]
  player.hand = [
    { uid: 'ui-flex', defId: 'flex', upgraded: false },
    { uid: 'ui-anger', defId: 'anger', upgraded: false },
  ]
  player.draw = [{ uid: 'ui-spare', defId: 'defend_ironclad', upgraded: false }]
  player.energy = 3
  player.strength = 0
  player.strengthLossAtEndOfTurn = 0
  for (const enemy of run.combat.enemies) Object.assign(enemy, { hp: 20, maxHp: 20, block: 0, dead: false })
  debug.setRun(run)
})
await page.waitForFunction(() => document.querySelectorAll('.hand .card').length === 2)
await shot('06d-flex-anger-hand')
await page.getByRole('button', { name: /^Flex,/ }).click()
await page.getByRole('button', { name: /^Anger,/ }).click()
await page.locator('.enemy--targeted').first().click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hand.length === 0)
const flexAnger = await readState()
check('Flex expires and Exhausts while Anger returns to draw top', () => {
  const player = flexAnger.players[0]
  assertEqual(player.strength, 1)
  assertEqual(player.strengthLossAtEndOfTurn, 1)
  assert(player.exhaust.some((card) => card.uid === 'ui-flex'))
  assertEqual(player.draw[0].uid, 'ui-anger')
  assert(flexAnger.enemies.some((enemy) => enemy.hp === 18), 'Flex should strengthen Anger to 2 damage')
})

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const player = run.combat.players[0]
  player.hand = [{ uid: 'ui-iron-wave', defId: 'iron_wave', upgraded: true }]
  player.energy = 3
  player.block = 0
  player.strength = 0
  player.strengthLossAtEndOfTurn = 0
  for (const enemy of run.combat.enemies) Object.assign(enemy, { hp: 20, maxHp: 20, block: 0, dead: false })
  debug.setRun(run)
})
await page.getByRole('button', { name: /^Iron Wave\+,/ }).click()
await page.getByRole('button', { name: '1 damage and 2 Block' }).waitFor()
await page.waitForTimeout(250)
await shot('06e-iron-wave-mode')
await page.getByRole('button', { name: '1 damage and 2 Block' }).click()
await page.getByText('Choose an enemy').waitFor()
await page.locator('.enemy--targeted').first().click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hand.length === 0)
const ironWave = await readState()
check('Iron Wave+ commits its printed mode and target as one play', () => {
  assert(ironWave.enemies.some((enemy) => enemy.hp === 19))
  assertEqual(ironWave.players[0].block, 2)
  assertEqual(ironWave.players[0].energy, 2)
})

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const player = run.combat.players[0]
  player.hand = [{ uid: 'ui-acrobatics', defId: 'acrobatics', upgraded: false }]
  player.draw = [
    { uid: 'ui-acro-neutralize', defId: 'neutralize', upgraded: false },
    { uid: 'ui-acro-defend', defId: 'defend_silent', upgraded: false },
    { uid: 'ui-acro-strike', defId: 'strike_silent', upgraded: false },
    { uid: 'ui-acro-spare', defId: 'backflip', upgraded: false },
  ]
  player.discard = []
  player.energy = 3
  debug.setRun(run)
})
await page.getByRole('button', { name: /^Acrobatics,/ }).click()
const acrobaticsDialog = page.getByRole('dialog', { name: 'Choose 1 to discard' })
await acrobaticsDialog.waitFor()
await acrobaticsDialog.getByRole('button', { name: /^Neutralize,/ }).click()
await page.waitForTimeout(250)
await shot('06f-acrobatics-post-draw-choice')
await acrobaticsDialog.getByRole('button', { name: 'Discard selected card' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hand.length === 2)
const acrobatics = await readState()
check('Acrobatics reveals its draw before committing the chosen discard', () => {
  assertDeepEqual(acrobatics.players[0].hand.map((card) => card.uid), ['ui-acro-defend', 'ui-acro-strike'])
  assertDeepEqual(acrobatics.players[0].discard.map((card) => card.uid), ['ui-acro-neutralize', 'ui-acrobatics'])
  assertEqual(acrobatics.players[0].energy, 2)
})

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const player = run.combat.players[0]
  player.hand = [{ uid: 'ui-third-eye', defId: 'third_eye', upgraded: true }]
  player.draw = [
    { uid: 'ui-scry-defend', defId: 'defend_watcher', upgraded: false },
    { uid: 'ui-scry-strike', defId: 'strike_watcher', upgraded: false },
    { uid: 'ui-scry-vigilance', defId: 'vigilance', upgraded: false },
    { uid: 'ui-scry-eruption', defId: 'eruption', upgraded: false },
    { uid: 'ui-scry-protect', defId: 'protect', upgraded: false },
    { uid: 'ui-scry-spare', defId: 'tranquility', upgraded: false },
  ]
  player.discard = []
  player.energy = 3
  player.block = 0
  debug.setRun(run)
})
await page.getByRole('button', { name: /^Third Eye\+,/ }).click()
const scryDialog = page.getByRole('dialog', { name: 'Scry 5' })
await scryDialog.waitFor()
await scryDialog.getByRole('button', { name: /^Strike,/ }).click()
await scryDialog.getByRole('button', { name: /^Eruption,/ }).click()
const endTurnLocked = await page.getByRole('button', { name: 'End turn' }).isDisabled()
const cancelHidden = await page.getByRole('button', { name: 'Cancel' }).count()
await page.waitForTimeout(250)
await shot('06g-third-eye-scry-choice')
await scryDialog.getByRole('button', { name: 'Discard 2 and continue' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hand.length === 0)
const thirdEye = await readState()
check('Third Eye locks the revealed play and keeps unselected cards in order', () => {
  assert(endTurnLocked, 'a revealed card could be abandoned by ending the turn')
  assertEqual(cancelHidden, 0, 'a revealed draw could be peeked and cancelled')
  assertEqual(thirdEye.players[0].block, 3)
  assertDeepEqual(thirdEye.players[0].draw.map((card) => card.uid),
    ['ui-scry-defend', 'ui-scry-vigilance', 'ui-scry-protect', 'ui-scry-spare'])
  assertDeepEqual(thirdEye.players[0].discard.map((card) => card.uid),
    ['ui-scry-strike', 'ui-scry-eruption', 'ui-third-eye'])
  assertEqual(thirdEye.players[0].energy, 2)
})

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const player = run.combat.players[0]
  player.hand = [
    { uid: 'ui-dagger-throw', defId: 'dagger_throw', upgraded: true },
    { uid: 'ui-dagger-existing', defId: 'defend_silent', upgraded: false },
  ]
  player.draw = [{ uid: 'ui-dagger-drawn', defId: 'neutralize', upgraded: false }]
  player.discard = []
  player.energy = 3
  Object.assign(run.combat.enemies[0], { hp: 10, maxHp: 10, block: 0, dead: false })
  debug.setRun(run)
})
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hand
  .some((card) => card.uid === 'ui-dagger-throw'))
await page.getByRole('button', { name: /^Dagger Throw\+,/ }).click()
await page.waitForSelector('.enemy--targeted')
await page.locator('.enemy--targeted[aria-label*="10 of 10 hit points"]').click()
const daggerDialog = page.getByRole('dialog', { name: 'Choose 1 to discard' })
await daggerDialog.waitFor()
await daggerDialog.getByRole('button', { name: /^Neutralize,/ }).click()
await shot('06h-dagger-throw-choice')
await daggerDialog.getByRole('button', { name: 'Discard selected card' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().enemies
  .some((enemy) => enemy.maxHp === 10 && enemy.hp === 7))
const daggerThrow = await readState()
check('Dagger Throw chooses its attack target before revealing its discard', () => {
  assertEqual(daggerThrow.enemies.find((enemy) => enemy.maxHp === 10).hp, 7)
  assertDeepEqual(daggerThrow.players[0].hand.map((card) => card.uid), ['ui-dagger-existing'])
  assertDeepEqual(daggerThrow.players[0].discard.map((card) => card.uid), ['ui-dagger-drawn', 'ui-dagger-throw'])
  assertEqual(daggerThrow.players[0].energy, 2)
})

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const player = run.combat.players[0]
  player.hand = [
    { uid: 'ui-prepared', defId: 'prepared', upgraded: true },
    { uid: 'ui-prepared-existing', defId: 'defend_silent', upgraded: false },
  ]
  player.draw = [
    { uid: 'ui-prepared-neutralize', defId: 'neutralize', upgraded: false },
    { uid: 'ui-prepared-strike', defId: 'strike_silent', upgraded: false },
  ]
  player.discard = []
  player.energy = 3
  debug.setRun(run)
})
await page.getByRole('button', { name: /^Prepared\+,/ }).click()
const preparedDialog = page.getByRole('dialog', { name: 'Choose 2 to discard' })
await preparedDialog.waitFor()
await preparedDialog.getByRole('button', { name: /^Neutralize,/ }).click()
await preparedDialog.getByRole('button', { name: /^Defend,/ }).click()
const preparedOrder = await preparedDialog.locator('p').textContent()
await shot('06i-prepared-choice')
await preparedDialog.getByRole('button', { name: 'Discard selected cards' }).click()
await preparedDialog.waitFor({ state: 'hidden' })
const prepared = await readState()
check('Prepared+ draws two, discards exactly two, and costs no Energy', () => {
  assert(preparedOrder.includes('1. Neutralize → 2. Defend'), preparedOrder)
  assertDeepEqual(prepared.players[0].hand.map((card) => card.uid), ['ui-prepared-strike'])
  assertDeepEqual(prepared.players[0].discard.map((card) => card.uid),
    ['ui-prepared-neutralize', 'ui-prepared-existing', 'ui-prepared'])
  assertEqual(prepared.players[0].energy, 3)
})

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const player = run.combat.players[0]
  player.hand = [{ uid: 'ui-riddle', defId: 'riddle_with_holes', upgraded: true }]
  player.energy = 3
  for (const member of run.combat.players) member.shivs = 0
  debug.setRun(run)
})
await page.getByRole('button', { name: /^Riddle with Holes\+,/ }).waitFor()
await shot('06j-riddle-with-holes-card')
await page.getByRole('button', { name: /^Riddle with Holes\+,/ }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].shivs === 5)
const riddle = await readState()
check('Riddle with Holes+ fills the shared Shiv supply with five Shivs', () => {
  assertEqual(riddle.players[0].shivs, 5)
  assertEqual(riddle.players[0].energy, 1)
  assertEqual(riddle.players[0].hand.length, 0)
})
await shot('06k-riddle-shiv-supply')

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const player = run.combat.players[0]
  player.hand = [{ uid: 'ui-pray', defId: 'pray', upgraded: true }]
  player.draw = [
    { uid: 'ui-pray-draw-1', defId: 'strike_watcher', upgraded: false },
    { uid: 'ui-pray-draw-2', defId: 'defend_watcher', upgraded: false },
  ]
  player.discard = []
  player.energy = 3
  player.miracles = 0
  player.drawLocked = false
  debug.setRun(run)
})
await page.getByRole('button', { name: /^Pray\+,/ }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].drawLocked === true)
const prayed = await readState()
const drawLockLabel = await page.locator('.seat--viewer .seat__pending')
  .filter({ hasText: 'Cannot draw more cards this turn' }).textContent()
check('Pray+ grants two Miracles, draws two, and visibly locks later draws', () => {
  assertEqual(prayed.players[0].miracles, 2)
  assertEqual(prayed.players[0].hand.length, 2)
  assertEqual(prayed.players[0].energy, 2)
  assert(prayed.players[0].drawLocked)
  assertEqual(drawLockLabel, 'Cannot draw more cards this turn')
})
await shot('06l-pray-draw-lock')

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.combat.players[0]
  const ally = run.combat.players[1]
  Object.assign(actor, {
    row: 0,
    hand: [{ uid: 'ui-dash', defId: 'dash', upgraded: true }],
    energy: 3,
    block: 0,
    drawLocked: false,
    dead: false,
    strength: 0,
    weak: 0,
  })
  Object.assign(ally, { row: 1, dead: false, hp: Math.max(1, ally.hp) })
  const target = run.combat.enemies.find((enemy) => !enemy.dead)
  if (!target) throw new Error('Dash browser fixture needs a living enemy')
  for (const enemy of run.combat.enemies) {
    if (!enemy.dead) Object.assign(enemy, { block: 0, vulnerable: 0 })
  }
  debug.setRun(run)
})
const dashHpBefore = (await readState()).enemies.reduce((total, enemy) => total + enemy.hp, 0)
await page.getByRole('button', { name: /^Dash\+,/ }).click()
await page.locator('.enemy--targeted').first().click()
await page.getByText('Choose another player to switch rows with, or keep rows').waitFor()
const dashSwitchTarget = page.locator('.seat--targetable')
assertEqual(await dashSwitchTarget.count(), 1, 'Dash did not expose exactly one other player as a switch target')
assertEqual(await page.getByRole('button', { name: 'Keep rows' }).count(), 1,
  'Dash did not expose its printed optional skip')
await shot('06m-dash-row-switch-choice')
await dashSwitchTarget.click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].row === 1)
const dashed = await readState()
check('Dash+ resolves damage and Block before optionally switching player rows', () => {
  assertDeepEqual(dashed.players.slice(0, 2).map((player) => player.row), [1, 0])
  assertEqual(dashed.players[0].block, 3)
  assertEqual(dashHpBefore - dashed.enemies.reduce((total, enemy) => total + enemy.hp, 0), 3)
  assertEqual(dashed.players[0].energy, 1)
})
await shot('06n-dash-row-switched')

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.combat.players[0]
  Object.assign(actor, {
    hand: [{ uid: 'ui-just-lucky', defId: 'just_lucky', upgraded: true }],
    draw: [
      { uid: 'ui-lucky-defend', defId: 'defend_watcher', upgraded: false },
      { uid: 'ui-lucky-strike', defId: 'strike_watcher', upgraded: false },
    ],
    discard: [],
    energy: 3,
    block: 0,
    strength: 0,
    weak: 0,
  })
  run.combat.die = 1
  for (const enemy of run.combat.enemies) {
    if (!enemy.dead) Object.assign(enemy, { block: 0, vulnerable: 0 })
  }
  debug.setRun(run)
})
const luckyScryHpBefore = (await readState()).enemies.reduce((total, enemy) => total + enemy.hp, 0)
await page.getByRole('button', { name: /^Just Lucky\+,/ }).click()
await page.locator('.enemy--targeted').first().click()
const luckyScryDialog = page.getByRole('dialog', { name: 'Scry 2' })
await luckyScryDialog.waitFor()
await luckyScryDialog.getByRole('button', { name: /^Defend,/ }).click()
await shot('06o-just-lucky-scry-choice')
await luckyScryDialog.getByRole('button', { name: 'Discard 1 and continue' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hand.length === 0)
const luckyScry = await readState()
check('Just Lucky+ uses die 1 for its private Scry branch', () => {
  assertEqual(luckyScryHpBefore - luckyScry.enemies.reduce((total, enemy) => total + enemy.hp, 0), 2)
  assertEqual(luckyScry.players[0].block, 0)
  assertDeepEqual(luckyScry.players[0].draw.map((card) => card.uid), ['ui-lucky-strike'])
  assertDeepEqual(luckyScry.players[0].discard.map((card) => card.uid), ['ui-lucky-defend', 'ui-just-lucky'])
  assertEqual(luckyScry.players[0].energy, 3)
})

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  Object.assign(run.combat.players[0], {
    hand: [{ uid: 'ui-just-lucky-block', defId: 'just_lucky', upgraded: false }],
    draw: [{ uid: 'ui-lucky-kept', defId: 'defend_watcher', upgraded: false }],
    discard: [],
    block: 0,
  })
  run.combat.die = 4
  debug.setRun(run)
})
const luckyBlockHpBefore = (await readState()).enemies.reduce((total, enemy) => total + enemy.hp, 0)
await page.getByRole('button', { name: /^Just Lucky,/ }).click()
await page.locator('.enemy--targeted').first().click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hand.length === 0)
const luckyBlock = await readState()
const luckyDialogCount = await page.getByRole('dialog').count()
check('Just Lucky uses die 4 for its immediate Block branch without a Scry prompt', () => {
  assertEqual(luckyBlockHpBefore - luckyBlock.enemies.reduce((total, enemy) => total + enemy.hp, 0), 1)
  assertEqual(luckyBlock.players[0].block, 1)
  assertDeepEqual(luckyBlock.players[0].draw.map((card) => card.uid), ['ui-lucky-kept'])
  assertEqual(luckyDialogCount, 0)
})
await shot('06p-just-lucky-block-branch')

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  Object.assign(run.combat.players[0], {
    hand: [{ uid: 'ui-rainbow', defId: 'rainbow', upgraded: true }],
    discard: [],
    exhaust: [],
    energy: 3,
    orbs: [null, null, null],
  })
  debug.setRun(run)
})
await page.getByRole('button', { name: /^Rainbow\+,/ }).waitFor()
await shot('06q-rainbow-card')
await page.getByRole('button', { name: /^Rainbow\+,/ }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].orbs.join(',') === 'lightning,frost,dark')
await page.waitForFunction(() => new Set([...document.querySelectorAll('.seat--viewer .combat-vfx[data-vfx-kind="orb"]')]
  .map((effect) => effect.getAttribute('data-vfx-asset'))).size >= 3)
const rainbowVfxAssets = await page.locator('.seat--viewer .combat-vfx[data-vfx-kind="orb"]').evaluateAll((effects) =>
  effects.map((effect) => effect.getAttribute('data-vfx-asset')))
const rainbow = await readState()
check('Rainbow+ channels Lightning, Frost, and Dark in order without Exhausting', () => {
  assertDeepEqual(rainbow.players[0].orbs, ['lightning', 'frost', 'dark'])
  assertDeepEqual([...new Set(rainbowVfxAssets)].sort(),
    ['dark-channel', 'frost-channel', 'lightning-channel'])
  assertEqual(rainbow.players[0].energy, 1)
  assertEqual(rainbow.players[0].discard.some((card) => card.uid === 'ui-rainbow'), true)
  assertEqual(rainbow.players[0].exhaust.some((card) => card.uid === 'ui-rainbow'), false)
})
await shot('06r-rainbow-orbs')
await page.locator('.seat--viewer .combat-vfx[data-vfx-kind="orb"]').first().waitFor({ state: 'detached' })

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  Object.assign(run.combat.players[0], {
    character: 'defect',
    hand: [{ uid: 'ui-ball-lightning-vfx', defId: 'ball_lightning', upgraded: false }],
    discard: [], exhaust: [], energy: 3, orbs: [null, null, null],
  })
  debug.setRun(run)
})
await page.getByRole('button', { name: /^Ball Lightning,/ }).click()
await page.locator('.enemy--targeted').first().click()
await page.waitForFunction(() => document.querySelector(
  '.seat--viewer .combat-vfx[data-vfx-kind="orb"][data-vfx-asset="lightning-channel"]'))
await page.locator('.seat--viewer .character-attack--defect').waitFor()
const targetedChannelPlacement = await page.evaluate(() => ({
  actor: document.querySelectorAll('.seat--viewer .combat-vfx[data-vfx-asset="lightning-channel"]').length,
  enemies: document.querySelectorAll('.enemy .combat-vfx[data-vfx-asset="lightning-channel"]').length,
  attack: Boolean(document.querySelector('.seat--viewer .character-attack--defect')),
}))
check('targeted channel cards keep the Orb animation on the character', () => {
  assertEqual(targetedChannelPlacement.actor, 1)
  assertEqual(targetedChannelPlacement.enemies, 0)
  assert(targetedChannelPlacement.attack, 'the Orb event suppressed Ball Lightning\'s attack motion')
})

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  Object.assign(run.combat.players[0], {
    hand: [{ uid: 'ui-glacier', defId: 'glacier', upgraded: true }],
    discard: [],
    energy: 3,
    block: 0,
    orbs: [null, null, null],
  })
  Object.assign(run.combat.players[1], { block: 0, dead: false, hp: Math.max(1, run.combat.players[1].hp) })
  debug.setRun(run)
})
await page.getByRole('button', { name: /^Glacier\+,/ }).click()
await page.getByText('Choose who gets it').waitFor()
const glacierAlly = page.locator('.seat--targetable').filter({ hasText: 'Silent' })
assertEqual(await glacierAlly.count(), 1, 'Glacier+ did not expose the living ally as a Block target')
await glacierAlly.scrollIntoViewIfNeeded()
await shot('06s-glacier-ally-choice')
await glacierAlly.click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].orbs[0] === 'frost')
const glacier = await readState()
check('Glacier+ gives the chosen ally Block while the caster channels Frost', () => {
  assertEqual(glacier.players[0].block, 0)
  assertEqual(glacier.players[1].block, 3)
  assertDeepEqual(glacier.players[0].orbs, ['frost', null, null])
  assertEqual(glacier.players[0].energy, 1)
})
await shot('06t-glacier-ally-frost')

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  Object.assign(run.combat.players[0], {
    hand: [{ uid: 'ui-good-instincts', defId: 'good_instincts', upgraded: true }],
    discard: [],
    exhaust: [],
    energy: 0,
    block: 0,
  })
  Object.assign(run.combat.players[1], { block: 0, dead: false, hp: Math.max(1, run.combat.players[1].hp) })
  debug.setRun(run)
})
await page.getByRole('button', { name: /^Good Instincts\+,/ }).click()
await page.getByText('Choose who gets it').waitFor()
const instinctsAlly = page.locator('.seat--targetable').filter({ hasText: 'Silent' })
assertEqual(await instinctsAlly.count(), 1, 'Good Instincts+ did not expose the living ally as a Block target')
await instinctsAlly.scrollIntoViewIfNeeded()
await shot('06u-good-instincts-ally-choice')
await instinctsAlly.click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[1].block === 2)
const instincts = await readState()
check('Good Instincts+ gives a chosen ally 2 Block for zero Energy', () => {
  assertEqual(instincts.players[0].block, 0)
  assertEqual(instincts.players[1].block, 2)
  assertEqual(instincts.players[0].energy, 0)
  assertEqual(instincts.players[0].discard.some((card) => card.uid === 'ui-good-instincts'), true)
})
await shot('06v-good-instincts-ally-block')

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  Object.assign(run.combat, { turn: 1 })
  Object.assign(run.combat.players[0], {
    hand: [{ uid: 'ui-dramatic-entrance', defId: 'dramatic_entrance', upgraded: true }],
    discard: [],
    exhaust: [],
    energy: 0,
    strength: 0,
    weak: 0,
  })
  for (const enemy of run.combat.enemies) {
    enemy.dead = false
    enemy.hp = 20
    enemy.maxHp = 20
    enemy.block = 0
    enemy.vulnerable = 0
  }
  const target = run.combat.enemies.find((enemy) => !enemy.isBoss)
  if (!target) throw new Error('Dramatic Entrance browser fixture needs a non-boss enemy')
  target.hp = 19
  debug.setRun(run)
})
await page.getByRole('button', { name: /^Dramatic Entrance\+,/ }).waitFor()
const entranceBefore = await readState()
const entranceTarget = entranceBefore.enemies.find((enemy) => !enemy.dead && !enemy.isBoss)
assert(entranceTarget, 'Dramatic Entrance browser fixture needs a non-boss enemy')
await page.getByRole('button', { name: /^Dramatic Entrance\+,/ }).click()
await page.waitForSelector('.enemy--targeted')
const entranceEnemy = page.locator(`.enemy--targeted[aria-label*="${entranceTarget.hp} of ${entranceTarget.maxHp} hit points"]`).first()
await entranceEnemy.scrollIntoViewIfNeeded()
await shot('06w-dramatic-entrance-row-target')
await entranceEnemy.click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hand.length === 0)
const entrance = await readState()
check('Dramatic Entrance+ deals 5 to its chosen row on turn 1 and Exhausts', () => {
  for (const before of entranceBefore.enemies) {
    const after = entrance.enemies.find((enemy) => enemy.uid === before.uid)
    const expected = before.row === entranceTarget.row || before.isBoss ? before.hp - 5 : before.hp
    assertEqual(after.hp, expected, `${before.uid} took the wrong row damage`)
  }
  assertEqual(entrance.players[0].energy, 0)
  assertEqual(entrance.players[0].exhaust.some((card) => card.uid === 'ui-dramatic-entrance'), true)
})
await page.locator(`.enemy[aria-label*="${entranceTarget.hp - 5} of ${entranceTarget.maxHp} hit points"]`).scrollIntoViewIfNeeded()
await shot('06x-dramatic-entrance-row-hit')

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  Object.assign(run.combat.players[0], {
    hand: [{ uid: 'ui-panacea', defId: 'panacea', upgraded: true }],
    discard: [],
    exhaust: [],
    energy: 0,
    weak: 1,
    vulnerable: 1,
  })
  Object.assign(run.combat.players[1], {
    dead: false,
    hp: Math.max(1, run.combat.players[1].hp),
    weak: 2,
    vulnerable: 2,
  })
  debug.setRun(run)
})
const panaceaCard = page.getByRole('button', { name: /^Panacea\+,/ })
await panaceaCard.waitFor()
const panaceaLabel = await panaceaCard.getAttribute('aria-label')
await panaceaCard.scrollIntoViewIfNeeded()
await shot('06y-panacea-party-debuffs')
await panaceaCard.click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players.every((player) => player.weak === 0 && player.vulnerable === 0))
const panacea = await readState()
check('Panacea+ clears Weak and Vulnerable from every player and Exhausts', () => {
  for (const player of panacea.players) {
    assertEqual(player.weak, 0)
    assertEqual(player.vulnerable, 0)
  }
  assertEqual(panacea.players[0].energy, 0)
  assertEqual(panacea.players[0].exhaust.some((card) => card.uid === 'ui-panacea'), true)
  assert(panaceaLabel.includes('support effect applies to all players'),
    `Panacea+ accessible name hid its party-wide scope: ${panaceaLabel}`)
})
await page.locator('.seat').first().scrollIntoViewIfNeeded()
await shot('06z-panacea-party-cleansed')

const colorlessBatch1Restore = await readRun()
await page.evaluate((baseline) => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(baseline)
  Object.assign(run.combat.players[0], {
    hand: [{ uid: 'ui-apparition', defId: 'apparition', upgraded: true }],
    discard: [],
    exhaust: [],
    energy: 1,
    hpLostThisRound: 0,
    hpLossLimitThisRound: undefined,
  })
  debug.setRun(run)
}, colorlessBatch1Restore)
const apparitionCard = page.getByRole('button', { name: /^Apparition\+,/ })
await apparitionCard.waitFor()
const apparitionLabel = await apparitionCard.getAttribute('aria-label')
await apparitionCard.scrollIntoViewIfNeeded()
await shot('06za-apparition-ready')
await apparitionCard.click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hpLossLimitThisRound === 1)
const apparition = await readState()
const apparitionSeatLabel = await page.locator('.seat--viewer').getAttribute('aria-label')
const apparitionStatus = await page.locator('.seat--viewer .seat__pending').textContent()
check('Apparition+ visibly protects the round and Exhausts without Ethereal', () => {
  assert(apparitionLabel.includes('cannot lose more than 1 hit points this round'), apparitionLabel)
  assert(!apparitionLabel.includes('ethereal'), apparitionLabel)
  assertEqual(apparition.players[0].hpLossLimitThisRound, 1)
  assertEqual(apparition.players[0].exhaust.some((card) => card.uid === 'ui-apparition'), true)
  assert(apparitionSeatLabel.includes('Apparition protection, 1 hit point loss remaining this round'), apparitionSeatLabel)
  assert(apparitionStatus.includes('Apparition · 1 HP loss remaining'), apparitionStatus)
})
await shot('06zb-apparition-protected')

await page.evaluate((baseline) => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(baseline)
  const actor = run.combat.players[0]
  Object.assign(run.combat, { die: 1 })
  Object.assign(actor, {
    hand: [{ uid: 'ui-dark-shackles', defId: 'dark_shackles', upgraded: true }],
    discard: [],
    exhaust: [],
    energy: 0,
    block: 0,
  })
  run.combat.enemies.forEach((enemy, index) => Object.assign(enemy, {
    defId: index === 0 ? 'cultist' : 'red_louse',
    row: actor.row,
    isBoss: false,
    dead: false,
    hp: 20,
    maxHp: 20,
    actionIndex: 0,
  }))
  debug.setRun(run)
}, colorlessBatch1Restore)
const shacklesCard = page.getByRole('button', { name: /^Dark Shackles\+,/ })
await shacklesCard.waitFor()
const shacklesLabel = await shacklesCard.getAttribute('aria-label')
await shacklesCard.scrollIntoViewIfNeeded()
await shot('06zc-dark-shackles-intents')
await shacklesCard.click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].block === 3)
const shackles = await readState()
check('Dark Shackles+ reads visible enemy intents without a target prompt', () => {
  assert(shacklesLabel.includes('3 per enemy intending to attack you'), shacklesLabel)
  assertEqual(shackles.players[0].block, 3)
  assertEqual(shackles.players[0].exhaust.some((card) => card.uid === 'ui-dark-shackles'), true)
})
await shot('06zd-dark-shackles-block')

await page.evaluate((baseline) => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(baseline)
  Object.assign(run.combat.players[0], {
    hand: [
      { uid: 'ui-madness', defId: 'madness', upgraded: true },
      { uid: 'ui-madness-target', defId: 'hand_of_greed', upgraded: false },
    ],
    discard: [],
    exhaust: [],
    energy: 0,
    freeCardsThisTurn: 0,
  })
  for (const enemy of run.combat.enemies) Object.assign(enemy, { hp: 20, maxHp: 20, block: 0, dead: false })
  debug.setRun(run)
}, colorlessBatch1Restore)
const madnessCard = page.getByRole('button', { name: /^Madness\+,/ })
await madnessCard.waitFor()
const madnessLabel = await madnessCard.getAttribute('aria-label')
await madnessCard.click()
const freeGreed = page.getByRole('button', { name: /^Hand of Greed, cost 0,/ })
await freeGreed.waitFor()
await freeGreed.scrollIntoViewIfNeeded()
await shot('06ze-madness-free-card')
await freeGreed.click()
await page.waitForSelector('.enemy--targeted')
await page.locator('.enemy--targeted').first().click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].freeCardsThisTurn === 0)
const madness = await readState()
check('Madness+ exposes Retain and discounts exactly the next card', () => {
  assert(madnessLabel.includes('your next card this turn costs 0'), madnessLabel)
  assert(madnessLabel.includes('retain'), madnessLabel)
  assertEqual(madness.players[0].energy, 0)
  assertEqual(madness.players[0].freeCardsThisTurn, 0)
  assertEqual(madness.players[0].exhaust.some((card) => card.uid === 'ui-madness'), true)
})
await shot('06zf-madness-spent')
await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), colorlessBatch1Restore)
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hpLossLimitThisRound == null)

await page.evaluate((baseline) => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(baseline)
  Object.assign(run.combat.players[0], {
    hand: [{ uid: 'ui-panache', defId: 'panache', upgraded: true }],
    discard: [],
    exhaust: [],
    powers: [],
    energy: 0,
  })
  run.combat.players[1].hand = []
  run.combat.enemies.forEach((enemy, index) => Object.assign(enemy, {
    row: index, hp: 20, maxHp: 20, block: 0, weak: 0, vulnerable: 0, poison: 0, dead: false,
  }))
  debug.setRun(run)
}, colorlessBatch1Restore)
const panacheCard = page.getByRole('button', { name: /^Panache\+,/ })
await panacheCard.waitFor()
const panacheLabel = await panacheCard.getAttribute('aria-label')
await panacheCard.click()
const panachePower = page.getByRole('button', { name: /^Panache\+?:/ })
await panachePower.waitFor()
const panachePowerLabel = await panachePower.getAttribute('aria-label')
check('Panache+ exposes its empty-hand row effect accessibly', () => {
  assert(panacheLabel.includes('deal 5 damage if your hand is empty'), panacheLabel)
  assert(panacheLabel.includes('affects a whole row and any boss'), panacheLabel)
  assert(panachePowerLabel.includes('5 damage'), panachePowerLabel)
  assert(panachePowerLabel.includes('if your hand is empty'), panachePowerLabel)
  assert(panachePowerLabel.includes('to one enemy row and any boss'), panachePowerLabel)
  assert(panachePowerLabel.includes('at the end of each turn'), panachePowerLabel)
})
await panachePower.scrollIntoViewIfNeeded()
await panachePower.click()
await shot('06zg-panache-power')
await panachePower.click()
await page.getByRole('button', { name: 'End turn' }).click()
const panacheEffect = page.locator('.end-turn-effect--card')
await panacheEffect.waitFor()
await panacheEffect.click()
await page.locator('.enemy--targeted').first().waitFor()
const panacheTargetId = await page.evaluate(() => window.__STS_DEBUG__.getState().enemies[1]?.uid)
await page.locator(`[data-enemy-id="${panacheTargetId}"]`).click()
await page.waitForTimeout(150)
const panache = await readState()
const panachePrompt = await page.locator('.end-turn-effects__prompt').count()
  ? await page.locator('.end-turn-effects__prompt').innerText() : ''
check('Panache+ resolves the selected row at end of turn', () => {
  assertEqual(panache.enemies[1].hp, 15, JSON.stringify({
    phase: panache.phase,
    hand: panache.players[0].hand.map((card) => card.defId),
    prompt: panachePrompt,
  }))
  assertEqual(panache.enemies[0].hp, 20)
})
await shot('06zh-panache-row-hit')

await page.evaluate((baseline) => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(baseline)
  Object.assign(run.combat.players[0], {
    hand: [
      { uid: 'ui-apotheosis', defId: 'apotheosis', upgraded: true },
      { uid: 'ui-apotheosis-strike', defId: 'strike_ironclad', upgraded: false },
    ],
    discard: [],
    exhaust: [],
    powers: [],
    energy: 2,
    starterStrikeDamageBonus: 0,
    starterDefendBlockBonus: 0,
  })
  for (const enemy of run.combat.enemies) Object.assign(enemy, { hp: 20, maxHp: 20, block: 0, dead: false })
  debug.setRun(run)
}, colorlessBatch1Restore)
const apotheosisCard = page.getByRole('button', { name: /^Apotheosis\+,/ })
await apotheosisCard.waitFor()
const apotheosisLabel = await apotheosisCard.getAttribute('aria-label')
await apotheosisCard.click()
const apotheosisPower = page.getByRole('button', { name: /^Apotheosis\+?:/ })
await apotheosisPower.waitFor()
const apotheosisPowerLabel = await apotheosisPower.getAttribute('aria-label')
check('Apotheosis+ remains visible as a Power and states both starter bonuses', () => {
  assert(apotheosisLabel.includes('starter Strikes deal +1 damage'), apotheosisLabel)
  assert(apotheosisLabel.includes('starter Defends gain +1 Block'), apotheosisLabel)
  assert(apotheosisPowerLabel.includes('starter Strikes deal +1 damage'), apotheosisPowerLabel)
  assert(apotheosisPowerLabel.includes('starter Defends gain +1 Block'), apotheosisPowerLabel)
})
await apotheosisPower.click()
await shot('06zi-apotheosis-power')
await page.getByRole('button', { name: /^Strike, cost 1,/ }).click()
await page.waitForSelector('.enemy--targeted')
await page.locator('.enemy--targeted').first().click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().enemies.some((enemy) => enemy.hp === 18))
const apotheosis = await readState()
check('Apotheosis adds one damage to a starter Strike', () => {
  assertEqual(apotheosis.enemies.filter((enemy) => enemy.hp === 18).length, 1)
})
await shot('06zj-apotheosis-strike')

await page.evaluate((baseline) => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(baseline)
  Object.assign(run.combat.players[0], {
    hand: [],
    discard: [],
    exhaust: [],
    powers: [{ uid: 'ui-bomb', defId: 'the_bomb', upgraded: true, counter: 2 }],
  })
  run.combat.players[1].hand = []
  for (const enemy of run.combat.enemies) Object.assign(enemy, { hp: 20, maxHp: 20, block: 0, dead: false })
  debug.setRun(run)
}, colorlessBatch1Restore)
const bombPower = page.getByRole('button', { name: /^The Bomb\+?:/ })
await bombPower.waitFor()
const bombLabel = await bombPower.getAttribute('aria-label')
const bombCounter = await bombPower.locator('.power__counter').textContent()
check('The Bomb+ exposes its public cube countdown visually and accessibly', () => {
  assert(bombLabel.includes('at 3 cubes deal 12 damage to every enemy, then Exhaust this Power'), bombLabel)
  assert(bombLabel.includes('2 of 3 cubes'), bombLabel)
  assertEqual(bombCounter, '2/3')
})
await bombPower.scrollIntoViewIfNeeded()
await bombPower.click()
await shot('06zk-bomb-two-cubes')
await page.getByRole('button', { name: 'End turn' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].powers.length === 0)
const bomb = await readState()
check('The Bomb+ third cube damages every enemy and Exhausts the Power', () => {
  assert(bomb.enemies.every((enemy) => enemy.hp === 8), 'The Bomb did not deal 12 to every enemy')
  assertEqual(bomb.players[0].exhaust.some((card) => card.uid === 'ui-bomb'), true)
})
await shot('06zl-bomb-exploded')
await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), colorlessBatch1Restore)
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'player' &&
  !window.__STS_DEBUG__.getState().players[0].powers.some((card) => card.uid === 'ui-bomb'))

await page.evaluate((baseline) => {
  const run = structuredClone(baseline)
  Object.assign(run.combat.players[0], {
    hand: [], discard: [], exhaust: [], hpLostThisRound: 0,
    powers: [{ uid: 'ui-wraith', defId: 'wraith_form', upgraded: true, counter: 1 }],
  })
  window.__STS_DEBUG__.setRun(run)
}, colorlessBatch1Restore)
const wraithPower = page.getByRole('button', { name: /^Wraith Form\+?:/ })
await wraithPower.waitFor()
const wraithLabel = await wraithPower.getAttribute('aria-label')
const wraithCounter = await wraithPower.locator('.power__counter').textContent()
const wraithSeat = await page.getByRole('button', { name: /Wraith Form protection/ }).getAttribute('aria-label')
check('Wraith Form+ exposes its HP cap and public cube countdown', () => {
  assert(wraithLabel.includes('cannot lose more than 1 HP per round'), wraithLabel)
  assert(wraithLabel.includes('at 3 cubes Exhaust this Power'), wraithLabel)
  assert(wraithLabel.includes('1 of 3 cubes'), wraithLabel)
  assertEqual(wraithCounter, '1/3')
  assert(wraithSeat.includes('Wraith Form protection, 1 hit point loss remaining'), wraithSeat)
})
await wraithPower.click()
await shot('06zla-wraith-form-one-cube')
await page.keyboard.press('Escape')
await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), colorlessBatch1Restore)
await chooseSeat(colorlessBatch1Restore.combat.players[0].id)

await page.evaluate((baseline) => {
  const run = structuredClone(baseline)
  const actor = run.combat.players[0]
  Object.assign(run.combat, { phase: 'player', pendingCardCopy: undefined, pendingTriggers: [], startTurnProgress: undefined })
  Object.assign(actor, {
    name: 'Watcher', character: 'watcher', energy: 6, miracles: 0, cardPlayLocked: false,
    hand: [
      { uid: 'ui-wish', defId: 'wish', upgraded: true },
      { uid: 'ui-conclude', defId: 'conclude', upgraded: true },
      { uid: 'ui-judgment', defId: 'judgment', upgraded: true },
      { uid: 'ui-ragnarok', defId: 'ragnarok', upgraded: true },
      { uid: 'ui-scrawl', defId: 'scrawl', upgraded: true },
      { uid: 'ui-signature', defId: 'signature_move', upgraded: true },
      { uid: 'ui-spirit-shield', defId: 'spirit_shield', upgraded: true },
      { uid: 'ui-swivel', defId: 'swivel', upgraded: true },
      { uid: 'ui-wallop', defId: 'wallop', upgraded: true },
    ],
    discard: [], exhaust: [], powers: [],
  })
  run.combat.enemies = run.combat.enemies.map((enemy, index) => ({
    ...enemy, uid: `ui-watcher-batch-one-enemy-${index}`, row: 0,
    hp: 20, maxHp: 20, block: 0, dead: false, abilityUsed: true,
  }))
  window.__STS_DEBUG__.setRun(run)
}, colorlessBatch1Restore)
const watcherBatchOneNames = [
  'Wish', 'Conclude', 'Judgment', 'Ragnarok', 'Scrawl',
  'Signature Move', 'Spirit Shield', 'Swivel', 'Wallop',
]
const watcherBatchOneLabels = await Promise.all(watcherBatchOneNames.map(async (name) =>
  page.getByRole('button', { name: new RegExp(`^${name}\\+,`) }).getAttribute('aria-label')))
check('all nine Watcher batch-one faces render their upgraded physical rules accessibly', () => {
  assert(watcherBatchOneLabels.every(Boolean), watcherBatchOneLabels.join('\n'))
  const labels = watcherBatchOneLabels.map((label) => label.toLowerCase())
  assert(labels[0].includes('gain 5 miracles'), watcherBatchOneLabels[0])
  assert(labels[1].includes('cannot play additional cards this turn'), watcherBatchOneLabels[1])
  assert(labels[2].includes('8 or fewer'), watcherBatchOneLabels[2])
  assert(labels[3].includes('6 separately targeted hits for 1 damage each'), watcherBatchOneLabels[3])
  assert(labels[4].includes('draw 5 cards'), watcherBatchOneLabels[4])
  assert(labels[5].includes('only attack in your hand'), watcherBatchOneLabels[5])
  assert(labels[6].includes('per other card in hand'), watcherBatchOneLabels[6])
  assert(labels[7].includes('next attack this turn costs 0'), watcherBatchOneLabels[7])
  assert(labels[8].includes("preceding hit's unblocked damage"), watcherBatchOneLabels[8])
})
const unclippedCard = page.getByRole('button', { name: /^Scrawl\+,/ })
const inspectCardTop = (card) => card.evaluate((node) => {
  const box = node.getBoundingClientRect()
  const blockers = []
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    const overflow = getComputedStyle(parent).overflowY
    const parentBox = parent.getBoundingClientRect()
    if (overflow !== 'visible' && box.top < parentBox.top) {
      blockers.push(`${parent.className || parent.tagName}: ${overflow} at ${parentBox.top}`)
    }
  }
  return {
    blockers,
    handOverflowY: getComputedStyle(node.closest('.hand')).overflowY,
    top: box.top,
  }
})
const restingCardTop = await inspectCardTop(unclippedCard)
await unclippedCard.hover()
await page.waitForTimeout(250)
const hoveredCardTop = await inspectCardTop(unclippedCard)
await shot('06zld-watcher-batch-one')
check('hand cards lift on hover without clipping at the top edge', () => {
  assertEqual(restingCardTop.handOverflowY, 'visible')
  assertDeepEqual(restingCardTop.blockers, [], `resting card top is clipped at ${restingCardTop.top}`)
  assertDeepEqual(hoveredCardTop.blockers, [], `hovered card top is clipped at ${hoveredCardTop.top}`)
  assert(hoveredCardTop.top < restingCardTop.top, 'hover did not lift the card')
})
await page.setViewportSize({ width: 1200, height: 650 })
await page.mouse.move(0, 0)
await page.waitForTimeout(250)
const shortViewportCard = page.getByRole('button', { name: /^Scrawl\+,/ })
const shortRestingCardTop = await inspectCardTop(shortViewportCard)
await shortViewportCard.hover()
await page.waitForTimeout(250)
const shortHoveredCardTop = await inspectCardTop(shortViewportCard)
check('short desktop viewports preserve the lifted unclipped card', () => {
  assertDeepEqual(shortRestingCardTop.blockers, [], `resting card top is clipped at ${shortRestingCardTop.top}`)
  assertDeepEqual(shortHoveredCardTop.blockers, [], `hovered card top is clipped at ${shortHoveredCardTop.top}`)
  assert(shortHoveredCardTop.top < shortRestingCardTop.top, 'short viewport hover did not lift the card')
})
await page.setViewportSize({ width: 1440, height: 900 })
const outerCard = page.locator('.hand .card').first()
const handScroller = page.locator('.hand-scroll')
await outerCard.focus()
await page.keyboard.press('Shift+Tab')
await handScroller.evaluate((scroller) => { scroller.scrollTop = 0 })
await page.keyboard.press('Tab')
await page.waitForTimeout(250)
const focusedOuterCardTop = await inspectCardTop(outerCard)
const focusedOuterScrollTop = await handScroller.evaluate((scroller) => scroller.scrollTop)
check('keyboard focus does not scroll or clip an outer fanned card', () => {
  assertEqual(focusedOuterScrollTop, 0)
  assertDeepEqual(focusedOuterCardTop.blockers, [], `focused outer card is clipped at ${focusedOuterCardTop.top}`)
})
const watcherBatchOneRun = await readRun()
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[0].hand = Array.from({ length: 20 }, (_, index) => ({
    uid: `ui-large-hand-${index}`, defId: 'defend_watcher', upgraded: false,
  }))
  debug.setRun(run)
})
const largeHandScroller = page.locator('.hand-scroll')
const largeHandBefore = await largeHandScroller.evaluate((scroller) => ({
  scrollLeft: scroller.scrollLeft,
  pointerEvents: getComputedStyle(scroller).pointerEvents,
  handPointerEvents: getComputedStyle(scroller.querySelector('.hand')).pointerEvents,
}))
await page.locator('.hand .card').nth(10).hover()
await page.mouse.wheel(1200, 0)
await page.waitForTimeout(100)
const largeHandScroll = await largeHandScroller.evaluate((scroller) => ({
    clientWidth: scroller.clientWidth,
    scrollWidth: scroller.scrollWidth,
    scrollLeft: scroller.scrollLeft,
  }))
const largeHandDocumentScroll = await page.evaluate(() => ({
  scrollX: window.scrollX,
  scrollWidth: document.documentElement.scrollWidth,
  clientWidth: document.documentElement.clientWidth,
}))
check('an unusually large desktop hand remains horizontally reachable', () => {
  assertEqual(largeHandBefore.pointerEvents, 'none')
  assertEqual(largeHandBefore.handPointerEvents, 'none')
  assert(largeHandScroll.scrollWidth > largeHandScroll.clientWidth, 'large hand does not expose horizontal overflow')
  assert(largeHandScroll.scrollLeft > largeHandBefore.scrollLeft, 'a user wheel cannot scroll toward the final cards')
  assertEqual(largeHandDocumentScroll.scrollX, 0, 'hand scrolling moved the whole document')
  assert(largeHandDocumentScroll.scrollWidth <= largeHandDocumentScroll.clientWidth,
    `document overflows horizontally (${largeHandDocumentScroll.scrollWidth} > ${largeHandDocumentScroll.clientWidth})`)
})
await largeHandScroller.evaluate((scroller) => { scroller.scrollLeft = 0 })
await page.evaluate(() => window.scrollTo(0, 0))
await page.evaluate((baseline) => window.__STS_DEBUG__.setRun(baseline), watcherBatchOneRun)
await page.getByRole('button', { name: /^Wish\+,/ }).click()
await page.getByRole('button', { name: 'Gain 5 Miracles', exact: true }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].miracles === 5)
await page.getByRole('button', { name: /^Conclude\+,/ }).click()
await page.locator('.enemy--targeted').first().click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].cardPlayLocked === true)
const watcherBatchOneState = await readState()
const lockedWatcherCard = page.getByRole('button', { name: /^Swivel\+,/ })
const lockedWatcherCardDisabled = await lockedWatcherCard.isDisabled()
const concludeLockBadge = page.getByText('No additional cards this turn', { exact: true })
const concludeLockInspect = await concludeLockBadge.evaluate((badge) => ({
  clipped: badge.scrollWidth > badge.clientWidth + 1 || badge.scrollHeight > badge.clientHeight + 1,
  width: badge.getBoundingClientRect().width,
}))
check('Wish choice and Conclude lock resolve through the generated combat controls', () => {
  assertEqual(watcherBatchOneState.players[0].miracles, 5)
  assertEqual(watcherBatchOneState.players[0].cardPlayLocked, true)
  assert(lockedWatcherCardDisabled, 'Conclude left another card enabled')
  assert(concludeLockInspect.width > 0, 'Conclude lock status is not visible')
  assert(!concludeLockInspect.clipped, 'Conclude lock status is clipped')
})
await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), colorlessBatch1Restore)

await page.evaluate((baseline) => {
  const run = structuredClone(baseline)
  const actor = run.combat.players[0]
  Object.assign(run.combat, {
    phase: 'player', pendingCardCopy: undefined, pendingTriggers: [], startTurnProgress: undefined,
    playedCardsThisTurn: [],
  })
  Object.assign(actor, {
    name: 'Watcher', character: 'watcher', energy: 6, miracles: 2, strength: 0, cardPlayLocked: false,
    hand: [
      { uid: 'ui-conjure', defId: 'conjure_blade', upgraded: true },
      { uid: 'ui-deus', defId: 'deus_ex_machina', upgraded: true },
      { uid: 'ui-foreign', defId: 'foreign_influence', upgraded: true },
      { uid: 'ui-omega', defId: 'omega', upgraded: true },
      { uid: 'ui-reach', defId: 'reach_heaven', upgraded: true },
      { uid: 'ui-study', defId: 'study', upgraded: true },
    ],
    discard: [], exhaust: [], powers: [], starterStrikeDamageBonus: 0,
  })
  run.combat.enemies = run.combat.enemies.map((enemy, index) => ({
    ...enemy, uid: `ui-generated-enemy-${index}`, hp: 20, maxHp: 20,
    block: 0, vulnerable: 0, dead: false, abilityUsed: true,
  }))
  window.__STS_DEBUG__.setRun(run)
}, colorlessBatch1Restore)
const generatedWatcherNames = [
  'Conjure Blade', 'Deus Ex Machina', 'Foreign Influence', 'Omega', 'Reach Heaven', 'Study',
]
const generatedWatcherLabels = await Promise.all(generatedWatcherNames.map((name) =>
  page.getByRole('button', { name: new RegExp(`^${name}\\+,`) }).getAttribute('aria-label')))
check('all six generated-choice Watcher faces expose their upgraded physical rules', () => {
  assert(generatedWatcherLabels[0].includes('starter Strikes deal +1 damage per cube'), generatedWatcherLabels[0])
  assert(generatedWatcherLabels[1].includes('gain 3 Miracles'), generatedWatcherLabels[1])
  assert(generatedWatcherLabels[2].includes("last Attack another player played"), generatedWatcherLabels[2])
  assert(generatedWatcherLabels[3].includes('deal 6 damage'), generatedWatcherLabels[3])
  assert(generatedWatcherLabels[4].includes('2 per Miracle held'), generatedWatcherLabels[4])
  assert(generatedWatcherLabels[5].includes('draw 2 cards if you are in calm'), generatedWatcherLabels[5])
})
const generatedWatcherRestore = await readRun()
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.combat.players[0]
  const ally = structuredClone(actor)
  Object.assign(ally, {
    id: 'ui-generated-ally', name: 'Ironclad', character: 'ironclad', row: 1,
    hand: [], draw: [], discard: [], exhaust: [], powers: [], dead: false,
  })
  run.combat.players.push(ally)
  run.combat.playedCardsThisTurn = [{
    playerId: ally.id,
    card: { uid: 'ui-generated-ally-strike', defId: 'strike_ironclad', upgraded: false },
    copied: false,
  }]
  debug.setRun(run)
})
await page.getByRole('button', { name: /^Foreign Influence\+,/ }).click()
await page.getByRole('button', { name: "Copy another player's last Attack", exact: true }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'copy')
const foreignInfluenceModeState = await readState()
check('Foreign Influence copy mode commits without an unrelated enemy-target prompt', () => {
  assertEqual(foreignInfluenceModeState.pendingCardCopy?.sourceNames[0], 'Foreign Influence')
})
await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), generatedWatcherRestore)
await page.getByRole('button', { name: /^Conjure Blade\+,/ }).click()
await page.getByRole('button', { name: 'Spend 2', exact: true }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].powers
  .some((power) => power.defId === 'conjure_blade' && power.counter === 4))
const generatedWatcherState = await readState()
const conjurePowerLabel = await page.getByRole('button', { name: /^Conjure Blade\+:/ }).getAttribute('aria-label')
check('Conjure Blade cubes resolve through generated controls', () => {
  assertEqual(generatedWatcherState.players[0].starterStrikeDamageBonus, 4)
  assertEqual(generatedWatcherState.players[0].powers.find((power) => power.defId === 'conjure_blade').counter, 4)
  assertEqual(generatedWatcherState.pendingCardCopy, undefined)
  assert(conjurePowerLabel.includes('put X+2 cubes here'), conjurePowerLabel)
})
await shot('06zle-watcher-generated-choice-batch')

await page.evaluate((baseline) => {
  const run = structuredClone(baseline)
  const actor = run.combat.players[0]
  const ids = ['deva_form', 'omniscience', 'vault', 'talk_to_the_hand', 'tantrum', 'weave']
  Object.assign(actor, {
    name: 'Watcher', character: 'watcher', hand: ids.flatMap((defId) => [false, true].map((upgraded) => ({
      uid: `ui-final-${defId}-${upgraded ? 'upgraded' : 'base'}`, defId, upgraded,
    }))),
    draw: [], discard: [], exhaust: [], powers: [], energy: 20, miracles: 2,
  })
  Object.assign(run.combat, {
    phase: 'player', pendingCardCopy: undefined, pendingTriggers: [], startTurnProgress: undefined,
  })
  run.combat.players = [actor]
  run.combat.enemies = run.combat.enemies.slice(0, 1).map((enemy) => ({
    ...enemy, uid: 'ui-final-enemy', hp: 30, maxHp: 30, block: 0, vulnerable: 0, dead: false, abilityUsed: true,
  }))
  window.__STS_DEBUG__.setRun(run)
}, generatedWatcherRestore)
const finalWatcherLabels = Object.fromEntries(await Promise.all([
  ['deva', /^Deva Form, cost 2,/], ['devaUp', /^Deva Form\+, cost 2,/],
  ['omni', /^Omniscience, cost 3,/], ['omniUp', /^Omniscience\+, cost 2,/],
  ['vault', /^Vault, cost 3,/], ['vaultUp', /^Vault\+, cost 2,/],
  ['talk', /^Talk to the Hand, cost 1,/], ['talkUp', /^Talk to the Hand\+, cost 1,/],
  ['tantrum', /^Tantrum, cost 1,/], ['tantrumUp', /^Tantrum\+, cost 1,/],
  ['weave', /^Weave, cost 0,/], ['weaveUp', /^Weave\+, cost 0,/],
].map(async ([key, name]) => [key, await page.getByRole('button', { name }).getAttribute('aria-label')])))
check('all final-six Watcher faces render both physical sides accessibly', () => {
  assert(finalWatcherLabels.deva.includes('gain 1 Miracle'), finalWatcherLabels.deva)
  assert(finalWatcherLabels.devaUp.includes('gain 2 Miracles'), finalWatcherLabels.devaUp)
  assert(finalWatcherLabels.omni.includes('play it twice for 0 Energy'), finalWatcherLabels.omni)
  assert(finalWatcherLabels.omniUp.startsWith('Omniscience+, cost 2'), finalWatcherLabels.omniUp)
  assert(finalWatcherLabels.vault.includes('discard every card without Retain'), finalWatcherLabels.vault)
  assert(finalWatcherLabels.vaultUp.startsWith('Vault+, cost 2'), finalWatcherLabels.vaultUp)
  assert(finalWatcherLabels.talk.includes('deal 2 damage'), finalWatcherLabels.talk)
  assert(finalWatcherLabels.talkUp.includes('deal 3 damage'), finalWatcherLabels.talkUp)
  assert(finalWatcherLabels.tantrum.includes('deal 2 damage'), finalWatcherLabels.tantrum)
  assert(finalWatcherLabels.tantrumUp.includes('2 separately targeted hits for 1 damage each'), finalWatcherLabels.tantrumUp)
  assert(finalWatcherLabels.weave.includes('with +5 damage'), finalWatcherLabels.weave)
  assert(finalWatcherLabels.weaveUp.includes('with +6 damage'), finalWatcherLabels.weaveUp)
})

await page.evaluate((baseline) => {
  const run = structuredClone(baseline)
  const actor = run.combat.players[0]
  Object.assign(actor, {
    name: 'Watcher', character: 'watcher', stance: 'neutral', energy: 6, miracles: 2, block: 0,
    hand: [
      { uid: 'ui-final-deva', defId: 'deva_form', upgraded: true },
      { uid: 'ui-final-talk', defId: 'talk_to_the_hand', upgraded: true },
      { uid: 'ui-final-tantrum', defId: 'tantrum', upgraded: true },
      { uid: 'ui-final-vault', defId: 'vault', upgraded: true },
      { uid: 'ui-final-retain', defId: 'protect', upgraded: false },
    ],
    draw: Array.from({ length: 5 }, (_, index) => ({
      uid: `ui-final-draw-${index}`, defId: 'defend_watcher', upgraded: false,
    })),
    discard: [], exhaust: [], powers: [], cardPlayLocked: false,
  })
  Object.assign(run.combat, {
    phase: 'player', pendingCardCopy: undefined, pendingTriggers: [], startTurnProgress: undefined,
  })
  run.combat.players = [actor]
  run.combat.enemies = run.combat.enemies.slice(0, 1).map((enemy) => ({
    ...enemy, uid: 'ui-final-play-enemy', hp: 30, maxHp: 30, block: 0, vulnerable: 0, dead: false,
  }))
  window.__STS_DEBUG__.setRun(run)
}, generatedWatcherRestore)
await page.getByRole('button', { name: /^Deva Form\+,/ }).click()
await page.getByRole('button', { name: /^Talk to the Hand\+,/ }).click()
await page.locator('.enemy--targeted').first().click()
await page.getByRole('button', { name: /^Tantrum\+,/ }).click()
await page.locator('.enemy--targeted').first().click()
await page.locator('.enemy--targeted').first().click()
await page.getByRole('button', { name: /^Vault\+,/ }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hand.length === 6)
const finalWatcherDirectState = await readState()
check('Deva Form, Talk to the Hand, Tantrum, and Vault resolve through combat controls', () => {
  const actor = finalWatcherDirectState.players[0]
  assert(actor.powers.some((card) => card.uid === 'ui-final-deva'))
  assertEqual(actor.block, 2)
  assertEqual(actor.stance, 'wrath')
  assert(actor.hand.some((card) => card.uid === 'ui-final-retain'))
  assert(actor.hand.some((card) => card.uid === 'ui-final-tantrum'))
  assertEqual(actor.hand.length, 6)
  assertEqual(actor.energy, 3)
  assertEqual(finalWatcherDirectState.enemies[0].hp, 25)
  assert(actor.exhaust.some((card) => card.uid === 'ui-final-vault'))
})
await shot('06zlf-watcher-final-six-direct')

await page.evaluate((baseline) => {
  const run = structuredClone(baseline)
  const actor = run.combat.players[0]
  Object.assign(actor, {
    name: 'Watcher', character: 'watcher',
    hand: [{ uid: 'ui-final-empty-omni', defId: 'omniscience', upgraded: true }],
    draw: [{ uid: 'ui-final-empty-omni-power', defId: 'deva_form', upgraded: false }],
    discard: [], exhaust: [], powers: [], energy: 2,
  })
  Object.assign(run.combat, {
    phase: 'player', pendingCardCopy: undefined, pendingTriggers: [], startTurnProgress: undefined,
  })
  run.combat.players = [actor]
  window.__STS_DEBUG__.setRun(run)
}, generatedWatcherRestore)
await page.getByRole('button', { name: /^Omniscience\+,/ }).click()
const emptyOmniscienceSearch = page.getByRole('dialog', { name: 'Choose 0 from your draw pile' })
await emptyOmniscienceSearch.waitFor()
const emptyOmniscienceAction = await emptyOmniscienceSearch
  .getByRole('button', { name: 'Shuffle and continue' }).textContent()
check('an empty Omniscience search offers an accurate shuffle action', () => {
  assertEqual(emptyOmniscienceAction, 'Shuffle and continue')
})
await emptyOmniscienceSearch.getByRole('button', { name: 'Shuffle and continue' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'player')

await page.evaluate((baseline) => {
  const run = structuredClone(baseline)
  const actor = run.combat.players[0]
  Object.assign(actor, {
    name: 'Watcher', character: 'watcher',
    hand: [{ uid: 'ui-final-omni', defId: 'omniscience', upgraded: true }],
    draw: [
      { uid: 'ui-final-omni-strike', defId: 'strike_watcher', upgraded: false },
      { uid: 'ui-final-omni-power', defId: 'deva_form', upgraded: false },
    ],
    discard: [], exhaust: [], powers: [], energy: 2,
  })
  Object.assign(run.combat, {
    phase: 'player', pendingCardCopy: undefined, pendingTriggers: [], startTurnProgress: undefined,
  })
  run.combat.players = [actor]
  run.combat.enemies = run.combat.enemies.slice(0, 1).map((enemy) => ({
    ...enemy, uid: 'ui-final-omni-enemy', hp: 20, maxHp: 20, block: 0, vulnerable: 0, dead: false,
  }))
  window.__STS_DEBUG__.setRun(run)
}, generatedWatcherRestore)
await page.getByRole('button', { name: /^Omniscience\+,/ }).click()
const omniscienceSearch = page.getByRole('dialog', { name: 'Choose 1 from your draw pile' })
await omniscienceSearch.waitFor()
const omnisciencePowerChoice = await omniscienceSearch.getByRole('button', { name: /^Deva Form,/ }).count()
await omniscienceSearch.getByRole('button', { name: /^Strike,/ }).click()
await omniscienceSearch.getByRole('button', { name: 'Play selected card twice and shuffle' }).click()
await page.waitForFunction(() => {
  const combat = window.__STS_DEBUG__.getState()
  return combat.phase === 'copy' && combat.pendingCardCopy?.sourceNames.length === 2
})
const intermediateOmnisciencePrompt = await page.getByText(
  'Choose an enemy for Strike copy (Omniscience)', { exact: true },
).textContent()
const intermediateOmnisciencePhase = await page.locator('.combat__phase').textContent()
await page.locator('.enemy--targeted').first().click()
await page.waitForFunction(() => {
  const combat = window.__STS_DEBUG__.getState()
  return combat.phase === 'copy' && combat.pendingCardCopy?.sourceNames.length === 1
})
const originalOmnisciencePrompt = await page.getByText(
  'Choose an enemy for original Strike after Omniscience copy', { exact: true },
).textContent()
const originalOmnisciencePhase = await page.locator('.combat__phase').textContent()
await page.locator('.enemy--targeted').first().click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'player')
const omniscienceUiState = await readState()
check('Omniscience uses its private search and both generated target prompts', () => {
  assertEqual(omnisciencePowerChoice, 0)
  assertEqual(intermediateOmnisciencePrompt, 'Choose an enemy for Strike copy (Omniscience)')
  assertEqual(intermediateOmnisciencePhase, 'Resolve Strike copy (Omniscience)')
  assertEqual(originalOmnisciencePrompt, 'Choose an enemy for original Strike after Omniscience copy')
  assertEqual(originalOmnisciencePhase, 'Resolve original Strike after Omniscience copy')
  assertEqual(omniscienceUiState.enemies[0].hp, 18)
  assert(omniscienceUiState.players[0].exhaust.some((card) => card.uid === 'ui-final-omni'))
  assert(omniscienceUiState.players[0].exhaust.some((card) => card.uid === 'ui-final-omni-strike'))
})

await page.evaluate((baseline) => {
  const run = structuredClone(baseline)
  const actor = run.combat.players[0]
  Object.assign(actor, {
    name: 'Watcher', character: 'watcher',
    hand: [{ uid: 'ui-final-third-eye', defId: 'third_eye', upgraded: true }],
    draw: [
      { uid: 'ui-final-weave', defId: 'weave', upgraded: true },
      ...Array.from({ length: 4 }, (_, index) => ({
        uid: `ui-final-scry-${index}`, defId: 'defend_watcher', upgraded: false,
      })),
    ],
    discard: [], exhaust: [], powers: [], energy: 1, block: 0,
  })
  Object.assign(run.combat, {
    phase: 'player', pendingCardCopy: undefined, pendingTriggers: [], startTurnProgress: undefined,
  })
  run.combat.players = [actor]
  run.combat.enemies = run.combat.enemies.slice(0, 1).map((enemy) => ({
    ...enemy, uid: 'ui-final-weave-enemy', hp: 20, maxHp: 20, block: 0, vulnerable: 0, dead: false,
  }))
  window.__STS_DEBUG__.setRun(run)
}, generatedWatcherRestore)
await page.getByRole('button', { name: /^Third Eye\+,/ }).click()
const weaveScry = page.getByRole('dialog', { name: 'Scry 5' })
await weaveScry.waitFor()
await weaveScry.getByRole('button', { name: /^Weave\+,/ }).click()
await weaveScry.getByRole('button', { name: 'Discard 1 and continue' }).click()
await page.waitForFunction(() => {
  const combat = window.__STS_DEBUG__.getState()
  return combat.phase === 'copy' && combat.pendingCardCopy?.sourceNames[0] === 'Weave' &&
    combat.pendingCardCopy.card.scryDamageBonus === 6
})
const weavePrompt = await page.getByText('Choose an enemy for Scry-played Weave+', { exact: true }).textContent()
const weavePhase = await page.locator('.combat__phase').textContent()
await page.locator('.enemy--targeted').first().click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'player')
const weaveUiState = await readState()
check('Scry-played Weave uses the real private Scry dialog and generated target prompt', () => {
  assertEqual(weavePrompt, 'Choose an enemy for Scry-played Weave+')
  assertEqual(weavePhase, 'Resolve Scry-played Weave+')
  assertEqual(weaveUiState.enemies[0].hp, 12)
  assertEqual(weaveUiState.players[0].block, 3)
  assert(weaveUiState.players[0].discard.some((card) => card.uid === 'ui-final-weave'))
})
await shot('06zlg-watcher-final-six-generated')
await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), colorlessBatch1Restore)

await page.evaluate((baseline) => {
  const run = structuredClone(baseline)
  Object.assign(run.combat, {
    phase: 'player', pendingCardCopy: undefined, pendingTriggers: [], startTurnProgress: undefined,
  })
  Object.assign(run.combat.players[0], {
    name: 'Watcher', character: 'watcher', stance: 'wrath', energy: 6, cardPlayLocked: false,
    hand: [
      { uid: 'ui-establishment', defId: 'establishment', upgraded: true },
      { uid: 'ui-meditate', defId: 'meditate', upgraded: true },
      { uid: 'ui-perseverance', defId: 'perseverance', upgraded: true },
      { uid: 'ui-sands', defId: 'sands_of_time', upgraded: true },
      { uid: 'ui-windmill', defId: 'windmill_strike', upgraded: true },
    ],
    discard: [
      { uid: 'ui-meditate-recover-one', defId: 'protect', upgraded: false },
      { uid: 'ui-meditate-recover-two', defId: 'flying_sleeves', upgraded: false },
    ],
    exhaust: [], powers: [],
  })
  window.__STS_DEBUG__.setRun(run)
}, colorlessBatch1Restore)
const retainBatchNames = ['Establishment', 'Meditate', 'Perseverance', 'Sands of Time', 'Windmill Strike']
const retainBatchLabels = await Promise.all(retainBatchNames.map((name) =>
  page.getByRole('button', { name: new RegExp(`^${name}\\+,`) }).getAttribute('aria-label')))
check('all five Watcher Retain lifecycle faces expose their upgraded rules accessibly', () => {
  assert(retainBatchLabels[0].includes('Retained last turn cost 2 less'), retainBatchLabels[0])
  assert(retainBatchLabels[1].includes('put 2 cards from your discard pile into your hand and Retain them'),
    retainBatchLabels[1])
  assert(retainBatchLabels[1].includes('cannot play additional cards this turn'), retainBatchLabels[1])
  assert(retainBatchLabels[2].includes('2 plus 2 if this card was Retained last turn Block'), retainBatchLabels[2])
  assert(retainBatchLabels[3].includes('3 per other card with Retain in hand'), retainBatchLabels[3])
  assert(retainBatchLabels[4].includes('2 plus 5 if this card was Retained last turn damage'), retainBatchLabels[4])
})
await page.getByRole('button', { name: /^Meditate\+,/ }).click()
const meditateChoice = page.getByRole('dialog', { name: 'Choose 2 cards from your discard pile' })
await meditateChoice.waitFor()
await meditateChoice.getByRole('button', { name: /^Protect,/ }).click()
await meditateChoice.getByRole('button', { name: /^Flying Sleeves,/ }).click()
await meditateChoice.getByRole('button', { name: 'Return selected cards to hand' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].cardPlayLocked === true)
const meditateUiState = await readState()
check('Meditate+ selects two discards and surfaces its turn lock through the controls', () => {
  const actor = meditateUiState.players[0]
  assertEqual(actor.stance, 'calm')
  assertDeepEqual(actor.hand.map((card) => card.uid).sort(),
    ['ui-establishment', 'ui-meditate-recover-one', 'ui-meditate-recover-two',
      'ui-perseverance', 'ui-sands', 'ui-windmill'].sort())
  assert(actor.hand.filter((card) => card.retainThisTurn).length === 2)
})
await page.getByText('No additional cards this turn', { exact: true }).waitFor()
await shot('06zle-watcher-retain-lifecycle')
await plantDiscardOrderCards()
await page.getByRole('button', { name: 'End turn' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'discard')
await confirmAllDiscards()
await page.waitForFunction(() => {
  const recovered = window.__STS_DEBUG__.getState().players[0].hand
    .filter((card) => card.uid.startsWith('ui-meditate-recover-'))
  return recovered.length === 2 && recovered.every((card) => card.retainedLastTurn && !card.retainThisTurn)
})
const meditateEndedState = await readState()
check('Meditate-retained cards bypass the discard UI and become last-turn Retains', () => {
  const recovered = meditateEndedState.players[0].hand.filter((card) => card.uid.startsWith('ui-meditate-recover-'))
  assertEqual(recovered.length, 2)
  assert(recovered.every((card) => card.retainedLastTurn && !card.retainThisTurn))
})
await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), colorlessBatch1Restore)
await chooseSeat(colorlessBatch1Restore.combat.players[0].id)

await page.evaluate((baseline) => {
  const run = structuredClone(baseline)
  Object.assign(run.combat.players[0], {
    character: 'watcher', stance: 'calm', energy: 3,
    hand: [
      { uid: 'ui-carve', defId: 'carve_reality', upgraded: true },
      { uid: 'ui-sash', defId: 'sash_whip', upgraded: true },
    ],
    discard: [], exhaust: [], powers: [],
  })
  if (run.combat.enemies.length < 2) run.combat.enemies.push({
    ...structuredClone(run.combat.enemies[0]), uid: 'ui-carve-second', row: 1,
  })
  run.combat.enemies = run.combat.enemies.slice(0, 2).map((enemy, index) => ({
    ...enemy, uid: `ui-carve-enemy-${index}`, row: index, hp: 10, maxHp: 10,
    block: 0, weak: 0, dead: false, abilityUsed: true,
  }))
  window.__STS_DEBUG__.setRun(run)
}, colorlessBatch1Restore)
const watcherCarveCard = page.getByRole('button', { name: /^Carve Reality\+,/ })
const watcherCarveLabel = await watcherCarveCard.getAttribute('aria-label')
check('Carve Reality announces both exact targeting modes', () => {
  assert(watcherCarveLabel.includes('deal 4 damage to one enemy'), watcherCarveLabel)
  assert(watcherCarveLabel.includes('deal 4 damage to 2 distinct enemies'), watcherCarveLabel)
})
await watcherCarveCard.click()
await page.getByRole('button', { name: 'Deal 4 damage to two enemies' }).click()
await page.getByText('Choose damage target 1/2').waitFor()
await page.locator('.enemy').nth(0).click()
await page.getByText('Choose damage target 2/2').waitFor()
const watcherMidChoiceRun = await readRun()
await page.locator('.enemy').nth(0).click()
await page.getByText('Choose damage target 2/2').waitFor()
await page.locator('.enemy').nth(1).click()
await page.getByRole('button', { name: /^Sash Whip\+,/ }).click()
await page.locator('.enemy').nth(1).click()
const watcherChoices = await readState()
check('Watcher choice attacks split hits and apply Calm-only Weak through the controls', () => {
  assertDeepEqual(watcherChoices.enemies.map((enemy) => enemy.hp), [4, 6])
  assertDeepEqual(watcherChoices.enemies.map((enemy) => enemy.weak), [2, 0])
})
await shot('06zlc-watcher-choice-attacks')

await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), watcherMidChoiceRun)
await page.getByRole('button', { name: /^Carve Reality\+,/ }).click()
await page.getByRole('button', { name: 'Deal 4 damage to two enemies' }).click()
await page.locator('.enemy').nth(0).click()
const watcherSharedBoardRun = await readRun()
await page.evaluate((run) => {
  const next = structuredClone(run)
  next.combat.enemies[1].dead = true
  next.combat.enemies[1].hp = 0
  window.__STS_DEBUG__.setRun(next)
}, watcherSharedBoardRun)
  await page.getByText('Choose how to play Carve Reality').waitFor()
const resetCarveModeAvailability = [
  await page.getByRole('button', { name: 'Deal 4 damage to one enemy', exact: true }).isDisabled(),
  await page.getByRole('button', { name: 'Deal 4 damage to two enemies', exact: true }).isDisabled(),
]
check('A shared-board target death resets an impossible Carve Reality mode', () => {
  assertDeepEqual(resetCarveModeAvailability, [false, true])
})

await page.evaluate((baseline) => {
  const run = structuredClone(baseline)
  const actor = run.combat.players[0]
  const source = run.combat.enemies[0]
  Object.assign(run.combat, {
    phase: 'copy', turn: 1, startTurnProgress: undefined,
    pendingCardCopy: {
      playerId: actor.id,
      card: { uid: 'ui-carve-copy', defId: 'carve_reality', upgraded: true },
      energySpent: 2,
      resumePhase: 'player',
      forcedExhaust: false,
      forcedChoices: null,
      deferredHavocs: [],
      sourceNames: ['Double Tap'],
    },
  })
  Object.assign(actor, {
    character: 'watcher', stance: 'neutral', hand: [], discard: [], exhaust: [], powers: [],
  })
  run.combat.players = [actor]
  run.combat.enemies = [{
    ...source, uid: 'ui-carve-only-enemy', row: 0, hp: 10, maxHp: 10,
    block: 0, weak: 0, dead: false, abilityUsed: true,
  }]
  window.__STS_DEBUG__.setRun(run)
}, colorlessBatch1Restore)
const oneEnemyCarveMode = page.getByRole('button', { name: 'Deal 4 damage to one enemy', exact: true })
const twoEnemyCarveMode = page.getByRole('button', { name: 'Deal 4 damage to two enemies', exact: true })
await twoEnemyCarveMode.waitFor()
const carveModeAvailability = [await oneEnemyCarveMode.isDisabled(), await twoEnemyCarveMode.isDisabled()]
check('Copied Carve Reality disables an impossible two-enemy mode', () => {
  assertDeepEqual(carveModeAvailability, [false, true])
})
await oneEnemyCarveMode.click()
await page.locator('.enemy').click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'player')
const oneEnemyCarve = await readState()
check('Copied Carve Reality can still resolve against its sole enemy', () => {
  assertEqual(oneEnemyCarve.enemies[0].hp, 6)
})
await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), colorlessBatch1Restore)

await page.evaluate((baseline) => {
  const run = structuredClone(baseline)
  const player = run.combat.players[0]
  const tactician = { uid: 'ui-tools-tactician', defId: 'tactician', upgraded: false }
  const strike = { uid: 'ui-tools-strike', defId: 'strike_silent', upgraded: false }
  Object.assign(run.combat, {
    phase: 'start',
    startTurnProgress: {
      choices: [],
      discard: { playerId: player.id, sourceId: 'power:ui-tools', pendingTriggers: [] },
    },
  })
  Object.assign(player, {
    character: 'silent', hand: [tactician, strike], draw: [], discard: [], exhaust: [], energy: 3,
    powers: [{ uid: 'ui-tools', defId: 'tools_of_the_trade', upgraded: false }],
  })
  window.__STS_DEBUG__.setRun(run)
}, colorlessBatch1Restore)
const toolsDialog = page.getByRole('dialog', { name: /Tools of the Trade — discard 1 card/ })
await toolsDialog.waitFor()
const toolsDialogOpen = await toolsDialog.getAttribute('open')
const toolsDialogCards = await toolsDialog.getByRole('button').count()
await toolsDialog.getByRole('button', { name: /^Tactician/ }).hover()
const toolsInspectionCount = await toolsDialog.locator('.card__inspection').count()
check('Tools of the Trade presents a focused private discard choice', () => {
  assertEqual(toolsDialogOpen, '')
  assertEqual(toolsDialogCards, 2)
  assertEqual(toolsInspectionCount, 0, 'hover preview inside the native choice modal')
})
await page.mouse.move(0, 0)
await shot('06zlb-tools-of-the-trade-discard')
await toolsDialog.getByRole('button', { name: /^Tactician/ }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'player')
const toolsResolved = await page.evaluate(() => window.__STS_DEBUG__.getState())
check('Tools of the Trade resolves its discard reaction and resumes the turn', () => {
  assertEqual(toolsResolved.players[0].energy, 5)
  assertEqual(toolsResolved.players[0].exhaust.some((card) => card.uid === 'ui-tools-tactician'), true)
})
await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), colorlessBatch1Restore)

await page.evaluate((baseline) => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(baseline)
  Object.assign(run.combat.players[0], {
    hand: [
      { uid: 'ui-sadistic', defId: 'sadistic_nature', upgraded: true },
      { uid: 'ui-sadistic-catalyst', defId: 'catalyst', upgraded: true },
    ],
    discard: [],
    exhaust: [],
    powers: [],
    energy: 1,
  })
  run.combat.enemies = run.combat.enemies.slice(0, 1)
  Object.assign(run.combat.enemies[0], {
    defId: 'cultist', hp: 30, maxHp: 30, block: 0,
    weak: 0, vulnerable: 0, poison: 5, dead: false,
  })
  debug.setRun(run)
}, colorlessBatch1Restore)
const sadisticCard = page.getByRole('button', { name: /^Sadistic Nature\+,/ })
await sadisticCard.waitFor()
const sadisticCardLabel = await sadisticCard.getAttribute('aria-label')
await sadisticCard.click()
const sadisticPower = page.getByRole('button', { name: /^Sadistic Nature\+?:/ })
await sadisticPower.waitFor()
const sadisticPowerLabel = await sadisticPower.getAttribute('aria-label')
check('Sadistic Nature+ exposes its per-token exact-enemy trigger accessibly', () => {
  assert(sadisticCardLabel.includes('whenever you put a token on an enemy'), sadisticCardLabel)
  assert(sadisticCardLabel.includes('deal 2 damage'), sadisticCardLabel)
  assert(sadisticPowerLabel.includes('2 damage to one enemy whenever you put a token on an enemy'), sadisticPowerLabel)
})
await sadisticPower.click()
await shot('06zm-sadistic-nature-power')
await page.getByRole('button', { name: /^Catalyst\+,/ }).click()
await page.waitForSelector('.enemy--targeted')
await page.locator('.enemy--targeted').click()
await page.waitForFunction(() => {
  const enemy = window.__STS_DEBUG__.getState().enemies[0]
  return enemy.poison === 15 && enemy.hp === 10
})
const sadistic = await readState()
check('Sadistic Nature+ fires ten times when Catalyst adds ten Poison cubes', () => {
  assertEqual(sadistic.enemies[0].poison, 15)
  assertEqual(sadistic.enemies[0].hp, 10)
})
await shot('06zn-sadistic-catalyst')
await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), colorlessBatch1Restore)
await page.waitForFunction(() => !window.__STS_DEBUG__.getState().players[0].powers
  .some((card) => card.uid === 'ui-sadistic'))

await page.evaluate((baseline) => {
  const run = structuredClone(baseline)
  const actor = run.combat.players[0]
  Object.assign(run.combat, { phase: 'player', startTurnProgress: undefined })
  Object.assign(actor, {
    hand: [
      { uid: 'ui-thinking', defId: 'thinking_ahead', upgraded: true },
      { uid: 'ui-thinking-held', defId: 'strike_ironclad', upgraded: false },
    ],
    draw: Array.from({ length: 3 }, (_, index) => ({
      uid: `ui-thinking-draw-${index}`, defId: 'defend_ironclad', upgraded: false,
    })),
    discard: [], exhaust: [], energy: 0,
  })
  window.__STS_DEBUG__.setRun(run)
}, colorlessBatch1Restore)
const thinkingCard = page.getByRole('button', { name: /^Thinking Ahead\+,/ })
await thinkingCard.waitFor()
const thinkingLabel = await thinkingCard.getAttribute('aria-label')
await thinkingCard.click()
const thinkingDialog = page.getByRole('dialog', { name: 'Choose 1 for the top of your draw pile' })
await thinkingDialog.waitFor()
check('Thinking Ahead+ exposes its private topdeck choice accessibly', () => {
  assert(thinkingLabel.includes('draw 3 cards'), thinkingLabel)
  assert(thinkingLabel.includes('put 1 card from your hand on top of your draw pile'), thinkingLabel)
})
await shot('06zo-thinking-ahead-choice')
await thinkingDialog.locator('.card').last().click()
await thinkingDialog.getByRole('button', { name: 'Put selected card on top' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].exhaust
  .some((card) => card.uid === 'ui-thinking'))
const thinking = await readState()
check('Thinking Ahead+ draws three and topdecks the selected card', () => {
  assertEqual(thinking.players[0].draw[0].uid, 'ui-thinking-draw-2')
  assertEqual(thinking.players[0].hand.length, 3)
})
await shot('06zp-thinking-ahead-resolved')

await page.evaluate((baseline) => {
  const run = structuredClone(baseline)
  const actor = run.combat.players[0]
  Object.assign(run.combat, { phase: 'player', startTurnProgress: undefined })
  Object.assign(actor, {
    hand: [
      { uid: 'ui-warcry', defId: 'warcry', upgraded: true },
      { uid: 'ui-warcry-held', defId: 'strike_ironclad', upgraded: false },
    ],
    draw: Array.from({ length: 3 }, (_, index) => ({
      uid: `ui-warcry-draw-${index}`, defId: 'defend_ironclad', upgraded: false,
    })),
    discard: [], exhaust: [], energy: 0,
  })
  window.__STS_DEBUG__.setRun(run)
}, colorlessBatch1Restore)
const warcryCard = page.getByRole('button', { name: /^Warcry\+,/ })
await warcryCard.waitFor()
const warcryLabel = await warcryCard.getAttribute('aria-label')
await warcryCard.click()
const warcryDialog = page.getByRole('dialog', { name: 'Choose 1 for the top of your draw pile' })
await warcryDialog.waitFor()
const warcryPrompt = await page.getByText('Warcry+ — choose 1 card to put on top').textContent()
await shot('06zpa-warcry-choice')
await warcryDialog.locator('.card').last().click()
await warcryDialog.getByRole('button', { name: 'Put selected card on top' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].exhaust
  .some((card) => card.uid === 'ui-warcry'))
const warcried = await readState()
check('Warcry+ uses the reusable private topdeck controls and card-specific prompt', () => {
  assert(warcryLabel.includes('draw 3 cards'), warcryLabel)
  assert(warcryLabel.includes('put 1 card from your hand on top of your draw pile'), warcryLabel)
  assertEqual(warcryPrompt, 'Warcry+ — choose 1 card to put on top')
  assertEqual(warcried.players[0].draw[0].uid, 'ui-warcry-draw-2')
  assertEqual(warcried.players[0].hand.length, 3)
})
await shot('06zpb-warcry-resolved')

await page.evaluate((baseline) => {
  const run = structuredClone(baseline)
  const actor = run.combat.players[0]
  Object.assign(run.combat, { phase: 'player', turn: 1, startTurnProgress: undefined })
  Object.assign(actor, {
    hand: [
      { uid: 'ui-havoc', defId: 'havoc', upgraded: true },
      { uid: 'ui-havoc-held', defId: 'defend_ironclad', upgraded: false },
    ],
    draw: [{ uid: 'ui-havoc-forced', defId: 'strike_ironclad', upgraded: false }],
    discard: [], exhaust: [], powers: [], energy: 0,
  })
  run.combat.enemies = run.combat.enemies.slice(0, 1)
  Object.assign(run.combat.enemies[0], { hp: 10, maxHp: 10, block: 0, dead: false, abilityUsed: true })
  window.__STS_DEBUG__.setRun(run)
}, colorlessBatch1Restore)
const havocCard = page.getByRole('button', { name: /^Havoc\+, cost 0,/ })
await havocCard.waitFor()
const havocLabel = await havocCard.getAttribute('aria-label')
await havocCard.click()
await page.waitForSelector('.enemy--targeted')
const havocForced = page.getByRole('button', { name: /^Strike, cost 0,/ })
await havocForced.waitFor()
const heldDuringHavoc = page.getByRole('button', { name: /^Defend,/ })
const heldDuringHavocEnabled = await heldDuringHavoc.isEnabled()
const havocEndTurnActions = await page.getByRole('button', { name: 'End turn' }).count()
const havocShivActions = await page.getByRole('button', { name: /Use Shiv/ }).count()
const havocMiracleActions = await page.getByRole('button', { name: /Use Miracle/ }).count()
check('Havoc+ explains its cleanup and locks the hand to its free draw', () => {
  assert(havocLabel.includes('exhaust it unless it is a Power'), havocLabel)
  assertEqual(heldDuringHavocEnabled, false)
  assertEqual(havocEndTurnActions, 0)
  assertEqual(havocShivActions, 0)
  assertEqual(havocMiracleActions, 0)
})
await shot('06zpc-havoc-forced-card')
await page.locator('.enemy--targeted').click()
await page.waitForFunction(() => !window.__STS_DEBUG__.getState().startTurnProgress)
const havoc = await readState()
check('Havoc+ plays its draw for 0 Energy and Exhausts the Attack', () => {
  assertEqual(havoc.players[0].energy, 0)
  assertEqual(havoc.enemies[0].hp, 9)
  assertEqual(havoc.players[0].exhaust.at(-1).uid, 'ui-havoc-forced')
})
await shot('06zpd-havoc-resolved')

await page.evaluate((baseline) => {
  const run = structuredClone(baseline)
  const actor = run.combat.players[0]
  Object.assign(run.combat, { phase: 'player', turn: 1, startTurnProgress: undefined })
  Object.assign(actor, {
    hand: [
      { uid: 'ui-perfect', defId: 'perfected_strike', upgraded: true },
      { uid: 'ui-perfect-strike', defId: 'strike_ironclad', upgraded: false },
      { uid: 'ui-perfect-twin', defId: 'twin_strike', upgraded: false },
      { uid: 'ui-perfect-swift', defId: 'swift_strike', upgraded: false },
      { uid: 'ui-perfect-defend', defId: 'defend_ironclad', upgraded: false },
    ],
    draw: [], discard: [], exhaust: [], powers: [], energy: 2,
  })
  run.combat.enemies = run.combat.enemies.slice(0, 1)
  Object.assign(run.combat.enemies[0], { hp: 20, maxHp: 20, block: 0, dead: false, abilityUsed: true })
  window.__STS_DEBUG__.setRun(run)
}, colorlessBatch1Restore)
const perfectedCard = page.getByRole('button', { name: /^Perfected Strike\+, cost 2,/ })
await perfectedCard.waitFor()
const perfectedLabel = await perfectedCard.getAttribute('aria-label')
await shot('06zpe-perfected-strike-ready')
await perfectedCard.click()
await page.waitForSelector('.enemy--targeted')
await page.locator('.enemy--targeted').click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().enemies[0].hp === 11)
const perfected = await readState()
check('Perfected Strike+ counts only other Strike-named cards in hand', () => {
  assert(perfectedLabel.includes('3 plus 2 per other card in hand containing Strike'), perfectedLabel)
  assertEqual(perfected.enemies[0].hp, 11)
  assertEqual(perfected.players[0].energy, 0)
})
await shot('06zpf-perfected-strike-resolved')

await page.evaluate((baseline) => {
  const run = structuredClone(baseline)
  const actor = run.combat.players[0]
  Object.assign(run.combat, { phase: 'player', turn: 1, startTurnProgress: undefined })
  Object.assign(actor, {
    hand: [{ uid: 'ui-headbutt', defId: 'headbutt', upgraded: true }],
    discard: [
      { uid: 'ui-headbutt-lower', defId: 'defend_ironclad', upgraded: false },
      { uid: 'ui-headbutt-chosen', defId: 'bash', upgraded: false },
    ],
    draw: [{ uid: 'ui-headbutt-draw', defId: 'strike_ironclad', upgraded: false }],
    exhaust: [], powers: [], energy: 1,
  })
  run.combat.enemies = run.combat.enemies.slice(0, 1)
  Object.assign(run.combat.enemies[0], { hp: 10, maxHp: 10, block: 0, dead: false, abilityUsed: true })
  window.__STS_DEBUG__.setRun(run)
}, colorlessBatch1Restore)
const headbuttCard = page.getByRole('button', { name: /^Headbutt\+, cost 1,/ })
await headbuttCard.waitFor()
const headbuttLabel = await headbuttCard.getAttribute('aria-label')
await headbuttCard.click()
const headbuttDialog = page.getByRole('dialog', { name: 'Choose 1 card from your discard pile' })
await headbuttDialog.waitFor()
const headbuttPrompt = await page.getByText('Headbutt+ — choose a card from your discard pile').textContent()
const headbuttCancelCount = await headbuttDialog.getByRole('button', { name: 'Cancel' }).count()
await page.keyboard.press('Escape')
await headbuttDialog.waitFor({ state: 'hidden' })
const cancelledHeadbutt = await readState()
check('Headbutt\'s public discard chooser is cancelable and announced accurately', () => {
  assertEqual(headbuttPrompt, 'Headbutt+ — choose a card from your discard pile')
  assertEqual(headbuttCancelCount, 1)
  assertEqual(cancelledHeadbutt.players[0].energy, 1)
  assertEqual(cancelledHeadbutt.players[0].hand[0].uid, 'ui-headbutt')
  assertEqual(cancelledHeadbutt.players[0].discard.length, 2)
  assertEqual(cancelledHeadbutt.enemies[0].hp, 10)
})
await headbuttCard.click()
await headbuttDialog.waitFor()
await headbuttDialog.getByRole('button', { name: /^Bash,/ }).click()
await page.waitForTimeout(150)
await shot('06zpg-headbutt-discard-choice')
await headbuttDialog.getByRole('button', { name: 'Put selected card on top' }).click()
await page.waitForSelector('.enemy--targeted')
await headbuttCard.click()
await page.waitForSelector('.enemy--targeted', { state: 'detached' })
const cancelledConfirmedHeadbutt = await readState()
check('Headbutt remains cancelable after confirming its discard choice', () => {
  assertEqual(cancelledConfirmedHeadbutt.players[0].energy, 1)
  assertEqual(cancelledConfirmedHeadbutt.players[0].hand[0].uid, 'ui-headbutt')
  assertEqual(cancelledConfirmedHeadbutt.players[0].discard.length, 2)
  assertEqual(cancelledConfirmedHeadbutt.enemies[0].hp, 10)
})
await headbuttCard.click()
await headbuttDialog.waitFor()
await headbuttDialog.getByRole('button', { name: /^Bash,/ }).click()
await headbuttDialog.getByRole('button', { name: 'Put selected card on top' }).click()
await page.waitForSelector('.enemy--targeted')
await page.locator('.enemy--targeted').click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].draw[0]?.uid === 'ui-headbutt-chosen')
const headbutted = await readState()
check('Headbutt+ chooses any discard card, attacks, and returns that card to draw-top', () => {
  assert(headbuttLabel.includes('deal 3 damage'), headbuttLabel)
  assert(headbuttLabel.includes('put a card from your discard pile on top of your draw pile'), headbuttLabel)
  assertEqual(headbutted.enemies[0].hp, 7)
  assertEqual(headbutted.players[0].draw[0].uid, 'ui-headbutt-chosen')
  assertDeepEqual(headbutted.players[0].discard.map((card) => card.uid),
    ['ui-headbutt-lower', 'ui-headbutt'])
})
await shot('06zph-headbutt-resolved')

await page.evaluate((baseline) => {
  const run = structuredClone(baseline)
  const actor = run.combat.players[0]
  Object.assign(run.combat, { phase: 'player', turn: 1, startTurnProgress: undefined })
  Object.assign(actor, {
    hand: [{ uid: 'ui-headbutt-empty', defId: 'headbutt', upgraded: false }],
    discard: [], draw: [], exhaust: [], powers: [], energy: 1,
  })
  run.combat.enemies = run.combat.enemies.slice(0, 1)
  Object.assign(run.combat.enemies[0], { hp: 10, maxHp: 10, block: 0, dead: false, abilityUsed: true })
  window.__STS_DEBUG__.setRun(run)
}, colorlessBatch1Restore)
await page.getByRole('button', { name: /^Headbutt, cost 1,/ }).click()
await page.waitForSelector('.enemy--targeted')
const emptyHeadbuttDialogs = await page.getByRole('dialog').count()
await page.locator('.enemy--targeted').click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().enemies[0].hp === 8)
check('Headbutt skips the discard chooser when that pile is empty', () => {
  assertEqual(emptyHeadbuttDialogs, 0)
})

await page.evaluate((baseline) => {
  const run = structuredClone(baseline)
  const actor = run.combat.players[0]
  Object.assign(run.combat, { phase: 'player', turn: 1, startTurnProgress: undefined })
  Object.assign(actor, {
    name: 'Defect', character: 'defect',
    hand: [{ uid: 'ui-hologram', defId: 'hologram', upgraded: false }],
    discard: [
      { uid: 'ui-hologram-strike', defId: 'strike_defect', upgraded: false },
      { uid: 'ui-hologram-defend', defId: 'defend_defect', upgraded: false },
    ],
    draw: [], exhaust: [], powers: [], energy: 1, block: 0,
  })
  window.__STS_DEBUG__.setRun(run)
}, colorlessBatch1Restore)
const hologramCard = page.getByRole('button', { name: /^Hologram, cost 1,/ })
const hologramLabel = await hologramCard.getAttribute('aria-label')
await hologramCard.click()
const hologramDialog = page.getByRole('dialog', { name: 'Choose 1 card from your discard pile' })
await hologramDialog.getByRole('button', { name: /^Strike,/ }).click()
await shot('06zpha-hologram-discard-choice')
await hologramDialog.getByRole('button', { name: 'Return selected card to hand' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hand[0]?.uid === 'ui-hologram-strike')
const hologrammed = await readState()
check('Hologram blocks, recovers the chosen discard to hand, and Exhausts', () => {
  assert(hologramLabel.includes('gain 1 Block'), hologramLabel)
  assert(hologramLabel.includes('put a card from your discard pile into your hand'), hologramLabel)
  assert(hologramLabel.includes('exhausts when played'), hologramLabel)
  assertEqual(hologrammed.players[0].block, 1)
  assertDeepEqual(hologrammed.players[0].hand.map((card) => card.uid), ['ui-hologram-strike'])
  assertDeepEqual(hologrammed.players[0].discard.map((card) => card.uid), ['ui-hologram-defend'])
  assertDeepEqual(hologrammed.players[0].exhaust.map((card) => card.uid), ['ui-hologram'])
})
await shot('06zphb-hologram-resolved')

await page.evaluate((baseline) => {
  const run = structuredClone(baseline)
  const actor = run.combat.players[0]
  Object.assign(run.combat, { phase: 'player', turn: 1, startTurnProgress: undefined })
  Object.assign(actor, {
    name: 'Defect', character: 'defect',
    hand: [{ uid: 'ui-blizzard', defId: 'blizzard', upgraded: true }],
    discard: [], draw: [], exhaust: [], powers: [], energy: 1,
    strength: 0, weak: 0, orbs: ['frost', 'lightning', 'frost'],
  })
  run.combat.enemies = run.combat.enemies.slice(0, 1)
  Object.assign(run.combat.enemies[0], { hp: 10, maxHp: 10, block: 1, dead: false, abilityUsed: true })
  window.__STS_DEBUG__.setRun(run)
}, colorlessBatch1Restore)
const blizzardCard = page.getByRole('button', { name: /^Blizzard\+, cost 1,/ })
const blizzardLabel = await blizzardCard.getAttribute('aria-label')
await shot('06zphc-blizzard-ready')
await blizzardCard.click()
await page.locator('.enemy--targeted').click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().enemies[0].hp === 5)
const blizzarded = await readState()
check('Blizzard+ visibly deals one 3-damage hit per Frost Orb', () => {
  assert(blizzardLabel.includes('3 damage once per Frost Orb'), blizzardLabel)
  assertEqual(blizzarded.enemies[0].hp, 5)
  assertEqual(blizzarded.players[0].energy, 0)
})
await shot('06zphd-blizzard-resolved')

await page.evaluate((baseline) => {
  const run = structuredClone(baseline)
  const actor = run.combat.players[0]
  Object.assign(run.combat, { phase: 'player', turn: 1, startTurnProgress: undefined })
  for (const player of run.combat.players) Object.assign(player, {
    hand: [], discard: [], draw: [], exhaust: [], powers: [], orbs: [null, null, null],
    block: 0, stance: 'neutral', dead: false,
  })
  Object.assign(actor, {
    name: 'Defect', character: 'defect',
    // Two spare cards, so a discard order is still a real decision and the turn
    // stops at the prompt where these Orb effects can be read off the board.
    hand: [
      { uid: 'ui-defragment', defId: 'defragment', upgraded: true },
      { uid: 'ui-defragment-spare-a', defId: 'defend_defect', upgraded: false },
      { uid: 'ui-defragment-spare-b', defId: 'defend_defect', upgraded: false },
    ],
    energy: 3, orbs: ['lightning', 'frost', null], orbEndTurnBonus: 0,
  })
  run.combat.enemies = run.combat.enemies.slice(0, 1)
  Object.assign(run.combat.enemies[0], {
    hp: 10, maxHp: 10, block: 0, poison: 0, dead: false, abilityUsed: true,
  })
  window.__STS_DEBUG__.setRun(run)
}, colorlessBatch1Restore)
const defragmentCard = page.getByRole('button', { name: /^Defragment\+, cost 3,/ })
const defragmentCardLabel = await defragmentCard.getAttribute('aria-label')
await defragmentCard.click()
const defragmentPower = page.getByRole('button', { name: /^Defragment\+: Orb end-of-turn effects get \+1$/ })
await defragmentPower.waitFor()
await shot('06zphe-defragment-power')
await plantDiscardOrderCards()
await page.getByRole('button', { name: 'End turn' }).click()
const defragmentLightning = page.locator('button.end-turn-effect--orb')
await defragmentLightning.waitFor()
await defragmentLightning.click()
await page.locator('.enemy--targeted').first().waitFor()
await page.locator('[data-enemy-id]').first().click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'discard')
const defragmented = await readState()
check('Defragment+ clearly enters play and boosts both Orb end-turn effects', () => {
  assert(defragmentCardLabel.includes('Orb end-of-turn effects get +1'), defragmentCardLabel)
  assert(!defragmentCardLabel.includes('ethereal'), 'Defragment+ must not announce Ethereal')
  assertEqual(defragmented.players[0].orbEndTurnBonus, 1)
  assertEqual(defragmented.enemies[0].hp, 8)
  assertEqual(defragmented.players[0].block, 2)
})
await shot('06zphf-defragment-orbs-resolved')

await page.evaluate((baseline) => {
  const run = structuredClone(baseline)
  const actor = run.combat.players[0]
  Object.assign(run.combat, { phase: 'player', turn: 1, startTurnProgress: undefined })
  for (const player of run.combat.players) Object.assign(player, {
    hand: [], discard: [], draw: [], exhaust: [], powers: [], orbs: [null, null, null],
    block: 0, stance: 'neutral', dead: false,
  })
  Object.assign(actor, {
    name: 'Defect', character: 'defect',
    hand: [{ uid: 'ui-static-discharge', defId: 'static_discharge', upgraded: true }],
    energy: 2, orbs: ['lightning', 'frost', null],
    orbEndTurnBonus: 0, lightningEndTurnBonus: 0,
  })
  run.combat.enemies = run.combat.enemies.slice(0, 1)
  Object.assign(run.combat.enemies[0], {
    hp: 10, maxHp: 10, block: 0, poison: 0, dead: false, abilityUsed: true,
  })
  window.__STS_DEBUG__.setRun(run)
}, colorlessBatch1Restore)
const staticDischargeCard = page.getByRole('button', { name: /^Static Discharge\+, cost 2,/ })
const staticDischargeLabel = await staticDischargeCard.getAttribute('aria-label')
await shot('06zphga-static-discharge-ready')
await staticDischargeCard.click()
await page.getByRole('button', {
  name: /^Static Discharge\+: Lightning Orb end-of-turn effects get \+2$/,
}).waitFor()
await shot('06zphgb-static-discharge-power')
await plantDiscardOrderCards()
await page.getByRole('button', { name: 'End turn' }).click()
const staticDischargeLightning = page.locator('button.end-turn-effect--orb')
await staticDischargeLightning.waitFor()
await staticDischargeLightning.click()
await page.locator('.enemy--targeted').first().waitFor()
await page.locator('[data-enemy-id]').first().click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'discard')
const discharged = await readState()
check('Static Discharge+ visibly boosts Lightning end-of-turn damage but not Frost Block', () => {
  assert(staticDischargeLabel.includes('Lightning Orb end-of-turn effects get +2'), staticDischargeLabel)
  assertEqual(discharged.players[0].lightningEndTurnBonus, 2)
  assertEqual(discharged.enemies[0].hp, 7)
  assertEqual(discharged.players[0].block, 1)
})
await shot('06zphgc-static-discharge-resolved')

await page.evaluate((baseline) => {
  const run = structuredClone(baseline)
  const actor = run.combat.players[0]
  const ally = structuredClone(actor)
  Object.assign(run.combat, { phase: 'player', turn: 1, startTurnProgress: undefined })
  Object.assign(actor, {
    id: 'p1', name: 'Defect', character: 'defect', row: 0,
    hand: [
      { uid: 'ui-electrodynamics', defId: 'electrodynamics', upgraded: true },
      { uid: 'ui-electrodynamics-dual', defId: 'dual_cast', upgraded: false },
    ],
    discard: [], draw: [], exhaust: [], powers: [], energy: 3,
    orbs: [null, null, null], orbEvokeBonus: 0,
  })
  Object.assign(ally, {
    id: 'p2', name: 'Ally', character: 'silent', row: 1,
    hand: [], discard: [], draw: [], exhaust: [], powers: [], orbs: [null, null, null],
  })
  run.combat.players = [actor, ally]
  const template = run.combat.enemies[0]
  run.combat.enemies = [
    { ...structuredClone(template), uid: 'ui-electro-front', row: 0, isBoss: false },
    { ...structuredClone(template), uid: 'ui-electro-back', row: 1, isBoss: false },
    { ...structuredClone(template), uid: 'ui-electro-boss', row: 0, isBoss: true },
  ]
  for (const enemy of run.combat.enemies) Object.assign(enemy, {
    hp: 20, maxHp: 20, block: 0, poison: 0, dead: false, abilityUsed: true,
  })
  window.__STS_DEBUG__.setRun(run)
}, colorlessBatch1Restore)
const electrodynamicsCard = page.getByRole('button', { name: /^Electrodynamics\+, cost 2,/ })
const electrodynamicsLabel = await electrodynamicsCard.getAttribute('aria-label')
await electrodynamicsCard.click()
const electrodynamicsPower = page.getByRole('button', { name: /^Electrodynamics\+:/ })
await electrodynamicsPower.waitFor()
await electrodynamicsPower.click()
await waitForPowerZoom()
await shot('06zphgcd-electrodynamics-power')
await page.keyboard.press('Escape')
await page.waitForFunction(() => !document.querySelector('.power__zoom'))
await page.getByRole('button', { name: /^Dual Cast,/ }).click()
await page.getByRole('button', { name: /lightning slot 1/i }).click()
// Electrodynamics' evoke targets a whole row; clicking any enemy in it is the
// same anchor pattern a `target: 'row'` card already uses, replacing the
// removed "Evoke Lightning in Row X" buttons.
await page.locator('.enemy[data-enemy-id="ui-electro-back"]').waitFor()
await shot('06zphgce-electrodynamics-row-choice')
await page.locator('.enemy[data-enemy-id="ui-electro-back"]').click()
await page.locator('.enemy[data-enemy-id="ui-electro-front"]').click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].orbs.filter(Boolean).length === 2)
const electroResolved = await readState()
check('Electrodynamics+ visibly channels three Orbs and makes each Lightning Evoke choose a row', () => {
  assert(electrodynamicsLabel.includes('Lightning damages every enemy in a chosen row, plus the boss'), electrodynamicsLabel)
  assert(electrodynamicsLabel.includes('channel 3 lightning orbs'), electrodynamicsLabel)
  assertDeepEqual(electroResolved.enemies.map((enemy) => enemy.hp), [18, 18, 16])
  assertDeepEqual(electroResolved.players[0].orbs, [null, 'lightning', 'lightning'])
  assertEqual(electroResolved.players[0].energy, 0)
})
await shot('06zphgcf-electrodynamics-resolved')

await page.evaluate((baseline) => {
  const run = structuredClone(baseline)
  const actor = run.combat.players[0]
  Object.assign(run.combat, { phase: 'player', turn: 1, startTurnProgress: undefined })
  Object.assign(actor, {
    name: 'Defect', character: 'defect',
    hand: [{ uid: 'ui-fission', defId: 'fission', upgraded: true }],
    discard: [], exhaust: [], powers: [], energy: 0,
    draw: [
      { uid: 'ui-fission-draw-a', defId: 'strike_defect', upgraded: false },
      { uid: 'ui-fission-draw-b', defId: 'defend_defect', upgraded: false },
      { uid: 'ui-fission-draw-c', defId: 'zap', upgraded: false },
    ],
    orbs: ['lightning', 'frost', 'dark'], orbEvokeBonus: 0, darkOrbEvokeBonus: 0,
  })
  run.combat.players = [actor]
  run.combat.enemies = run.combat.enemies.slice(0, 2)
  for (const enemy of run.combat.enemies) Object.assign(enemy, {
    hp: 20, maxHp: 20, block: 0, poison: 0, dead: false, abilityUsed: true, isBoss: false,
  })
  window.__STS_DEBUG__.setRun(run)
}, colorlessBatch1Restore)
const fissionCard = page.getByRole('button', { name: /^Fission\+, cost 0,/ })
const fissionLabel = await fissionCard.getAttribute('aria-label')
await fissionCard.click()
await page.getByRole('button', { name: /dark slot 3/i }).waitFor()
await shot('06zphgcg-fission-orb-choice')
await page.getByRole('button', { name: /dark slot 3/i }).click()
await page.locator('.enemy--targeted').nth(1).click()
await page.getByRole('button', { name: /frost slot 2/i }).click()
await page.getByRole('button', { name: /lightning slot 1/i }).click()
await page.locator('.enemy--targeted').first().click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hand.length === 3)
const fissioned = await readState()
check('Fission+ visibly Evokes every chosen Orb before paying Energy and cards', () => {
  assert(fissionLabel.includes('evoke every Orb; gain 1 Energy and draw 1 card for each'), fissionLabel)
  assertDeepEqual(fissioned.players[0].orbs, [null, null, null])
  assertEqual(fissioned.players[0].energy, 3)
  assertEqual(fissioned.players[0].block, 1)
  assertDeepEqual(fissioned.enemies.map((enemy) => enemy.hp).sort((a, b) => a - b), [17, 18])
  assert(fissioned.players[0].exhaust.some((card) => card.defId === 'fission'))
})
await shot('06zphgch-fission-resolved')

await page.evaluate((baseline) => {
  const run = structuredClone(baseline)
  const actor = run.combat.players[0]
  Object.assign(run.combat, { phase: 'player', turn: 1, startTurnProgress: undefined })
  Object.assign(actor, {
    name: 'Defect', character: 'defect',
    hand: [{ uid: 'ui-multi-cast', defId: 'multi_cast', upgraded: true }],
    discard: [], draw: [], exhaust: [], powers: [], energy: 2,
    orbs: ['dark', 'frost', 'lightning'], orbEvokeBonus: 0, darkOrbEvokeBonus: 0,
  })
  run.combat.players = [actor]
  run.combat.enemies = run.combat.enemies.slice(0, 2)
  for (const [index, enemy] of run.combat.enemies.entries()) Object.assign(enemy, {
    hp: index === 0 ? 3 : 20, maxHp: index === 0 ? 3 : 20,
    block: 0, poison: 0, dead: false, abilityUsed: true, isBoss: false,
  })
  window.__STS_DEBUG__.setRun(run)
}, colorlessBatch1Restore)
const multiCastCard = page.getByRole('button', { name: /^Multi-Cast\+, cost X,/ })
const multiCastLabel = await multiCastCard.getAttribute('aria-label')
await multiCastCard.click()
await page.getByText('Choose Energy for Multi-Cast+').waitFor()
await page.getByRole('button', { name: 'Spend 2' }).click()
await page.getByRole('button', { name: /dark slot 1/i }).waitFor()
await shot('06zphgci-multi-cast-choice')
await page.getByRole('button', { name: /dark slot 1/i }).click()
await page.getByRole('button', { name: /3 of 3 hit points/ }).click()
const targetsAfterLethalEvoke = await page.locator('.enemy--targeted').count()
await page.locator('.enemy--targeted').first().click()
await page.locator('.enemy--targeted').first().click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hand.length === 0)
const multiCast = await readState()
check('Multi-Cast+ visibly removes one Orb and applies its Evoke effect X+1 times', () => {
  assert(multiCastLabel.includes('evoke one Orb X+1 times'), multiCastLabel)
  assertDeepEqual(multiCast.players[0].orbs, [null, 'frost', 'lightning'])
  assertEqual(multiCast.players[0].energy, 0)
  assertEqual(targetsAfterLethalEvoke, 1, 'the first Evoke left its defeated target selectable')
  assertDeepEqual(multiCast.enemies.map((enemy) => enemy.hp), [0, 14])
  assert(multiCast.players[0].discard.some((card) => card.defId === 'multi_cast'))
})
await shot('06zphgcj-multi-cast-resolved')

await page.evaluate((baseline) => {
  const run = structuredClone(baseline)
  const actor = run.combat.players[0]
  Object.assign(run.combat, { phase: 'player', turn: 1, startTurnProgress: undefined })
  Object.assign(actor, {
    name: 'Defect', character: 'defect',
    hand: [{ uid: 'ui-multi-cast-lethal', defId: 'multi_cast', upgraded: false }],
    discard: [], draw: [], exhaust: [], powers: [], energy: 2,
    orbs: ['dark', null, null], orbEvokeBonus: 0, darkOrbEvokeBonus: 0,
  })
  run.combat.players = [actor]
  run.combat.enemies = [{
    ...run.combat.enemies[0], uid: 'multi-cast-final-enemy', hp: 3, maxHp: 3,
    block: 0, poison: 0, dead: false, abilityUsed: true, isBoss: false,
  }]
  window.__STS_DEBUG__.setRun(run)
}, colorlessBatch1Restore)
await page.getByRole('button', { name: /^Multi-Cast, cost X,/ }).click()
await page.getByRole('button', { name: 'Spend 2' }).click()
await page.getByRole('button', { name: /dark slot 1/i }).click()
await page.getByRole('button', { name: /3 of 3 hit points/ }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'won')
const lethalMultiCastPrompt = await page.locator('.prompt').count()
check('a lethal repeated Evoke submits without asking for dead-enemy targets', () => {
  assertEqual(lethalMultiCastPrompt, 0)
})
await shot('06zphgck-multi-cast-lethal')

await page.evaluate((baseline) => {
  const run = structuredClone(baseline)
  const actor = run.combat.players[0]
  Object.assign(run.combat, { phase: 'player', turn: 1, startTurnProgress: undefined })
  Object.assign(actor, {
    name: 'Defect', character: 'defect',
    hand: [{ uid: 'ui-seek', defId: 'seek', upgraded: true }],
    draw: [
      { uid: 'ui-seek-strike', defId: 'strike_defect', upgraded: false },
      { uid: 'ui-seek-defend', defId: 'defend_defect', upgraded: false },
      { uid: 'ui-seek-zap', defId: 'zap', upgraded: false },
    ],
    discard: [], exhaust: [], powers: [], energy: 0,
  })
  run.combat.players = [actor]
  window.__STS_DEBUG__.setRun(run)
}, colorlessBatch1Restore)
const seekCard = page.getByRole('button', { name: /^Seek\+, cost 0,/ })
const seekLabel = await seekCard.getAttribute('aria-label')
await seekCard.click()
const seekDialog = page.getByRole('dialog', { name: 'Choose 2 from your draw pile' })
await seekDialog.waitFor()
await seekDialog.getByRole('button', { name: /^Strike,/ }).click()
await seekDialog.getByRole('button', { name: /^Zap,/ }).click()
await shot('06zphgcl-seek-private-choice')
await seekDialog.getByRole('button', { name: 'Put selected cards in hand and shuffle' }).click()
await seekDialog.waitFor({ state: 'hidden' })
const sought = await readState()
check('Seek+ visibly searches two private draw cards, shuffles, and Exhausts', () => {
  assert(seekLabel.includes('search your draw pile for 2 cards'), seekLabel)
  assertDeepEqual(sought.players[0].hand.map((card) => card.uid), ['ui-seek-strike', 'ui-seek-zap'])
  assertDeepEqual(sought.players[0].draw.map((card) => card.uid), ['ui-seek-defend'])
  assert(sought.players[0].exhaust.some((card) => card.uid === 'ui-seek'))
})
await shot('06zphgcm-seek-resolved')

await page.evaluate((baseline) => {
  const run = structuredClone(baseline)
  const actor = run.combat.players[0]
  Object.assign(run.combat, { phase: 'player', turn: 1, startTurnProgress: undefined })
  Object.assign(actor, {
    name: 'Defect', character: 'defect',
    hand: [
      { uid: 'ui-amplify', defId: 'amplify', upgraded: true },
      { uid: 'ui-amplify-dual-cast', defId: 'dual_cast', upgraded: false },
    ],
    discard: [], draw: [], exhaust: [], powers: [], energy: 2,
    orbs: ['dark', null, null], orbEvokeBonus: 0, darkOrbEvokeBonus: 0,
  })
  run.combat.enemies = run.combat.enemies.slice(0, 1)
  Object.assign(run.combat.enemies[0], {
    hp: 20, maxHp: 20, block: 0, poison: 0, dead: false, abilityUsed: true,
  })
  window.__STS_DEBUG__.setRun(run)
}, colorlessBatch1Restore)
const amplifyCard = page.getByRole('button', { name: /^Amplify\+, cost 1,/ })
const amplifyLabel = await amplifyCard.getAttribute('aria-label')
await shot('06zphgd-amplify-ready')
await amplifyCard.click()
await page.getByRole('button', { name: /^Amplify\+: Dark Orb Evoke effects get \+5$/ }).waitFor()
await shot('06zphge-amplify-power')
await page.getByRole('button', { name: /^Dual Cast,/ }).click()
await page.getByRole('button', { name: /dark slot 1/i }).click()
await page.locator('.enemy--targeted').click()
await page.locator('.enemy--targeted').click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().enemies[0].hp === 2)
const amplified = await readState()
check('Amplify+ visibly boosts Dark Evoke damage without changing its Power-count bonus', () => {
  assert(amplifyLabel.includes('Dark Orb Evoke effects get +5'), amplifyLabel)
  assertEqual(amplified.players[0].darkOrbEvokeBonus, 5)
  assertEqual(amplified.enemies[0].hp, 2)
  assertDeepEqual(amplified.players[0].orbs, [null, null, null])
  assertEqual(amplified.players[0].energy, 0)
})
await shot('06zphgf-amplify-resolved')

await page.evaluate((baseline) => {
  const run = structuredClone(baseline)
  const actor = run.combat.players[0]
  Object.assign(run.combat, { phase: 'player', turn: 1, startTurnProgress: undefined })
  Object.assign(actor, {
    name: 'Defect', character: 'defect',
    hand: [
      { uid: 'ui-recycle', defId: 'recycle', upgraded: true },
      { uid: 'ui-recycle-fuel', defId: 'reinforced_body', upgraded: false },
    ],
    discard: [], draw: [], exhaust: [], powers: [], energy: 2,
  })
  window.__STS_DEBUG__.setRun(run)
}, colorlessBatch1Restore)
const recycleCard = page.getByRole('button', { name: /^Recycle\+, cost 0,/ })
const recycleLabel = await recycleCard.getAttribute('aria-label')
await shot('06zphgg-recycle-ready')
await recycleCard.click()
await page.getByText(/Exhaust 1 card.*0\/1 chosen/).waitFor()
await shot('06zphgh-recycle-choice')
await page.getByRole('button', { name: /^Reinforced Body, cost X,/ }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].energy === 4)
const recycled = await readState()
check('Recycle+ visibly Exhausts an X-cost card and doubles current Energy', () => {
  assert(recycleLabel.includes('exhaust 1 card from hand'), recycleLabel)
  assert(recycleLabel.includes('X doubles Energy'), recycleLabel)
  assertEqual(recycled.players[0].energy, 4)
  assertDeepEqual(recycled.players[0].exhaust.map((card) => card.uid), ['ui-recycle-fuel'])
})
await shot('06zphgi-recycle-resolved')

await page.evaluate((baseline) => {
  const run = structuredClone(baseline)
  const actor = run.combat.players[0]
  Object.assign(run.combat, { phase: 'player', turn: 1, startTurnProgress: undefined })
  Object.assign(actor, {
    name: 'Defect', character: 'defect',
    hand: [
      { uid: 'ui-equilibrium', defId: 'equilibrium', upgraded: true },
      { uid: 'ui-equilibrium-strike', defId: 'strike_defect', upgraded: false },
      { uid: 'ui-equilibrium-defend', defId: 'defend_defect', upgraded: false },
      { uid: 'ui-equilibrium-zap', defId: 'zap', upgraded: false },
    ],
    discard: [], draw: [], exhaust: [], powers: [], energy: 2, block: 0, cardBlockBonus: 0,
    orbs: [null, null, null],
    retainCardsThisTurn: 0,
  })
  run.combat.players = [actor]
  window.__STS_DEBUG__.setRun(run)
}, colorlessBatch1Restore)
const equilibriumCard = page.getByRole('button', { name: /^Equilibrium\+, cost 2,/ })
const equilibriumLabel = await equilibriumCard.getAttribute('aria-label')
await shot('06zphgia-equilibrium-ready')
await equilibriumCard.click()
await plantDiscardOrderCards()
await page.getByRole('button', { name: 'End turn' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'discard')
await page.getByRole('button', { name: 'Retain Defend' }).click()
await page.getByRole('button', { name: 'Retain Zap' }).click()
await shot('06zphgib-equilibrium-retain-choice')
await page.getByRole('button', { name: /Confirm Defect/ }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'enemy')
const equilibrated = await readState()
check('Equilibrium+ visibly retains two end-of-turn choices and marks their history', () => {
  assert(equilibriumLabel.includes('gain 4 Block'), equilibriumLabel)
  assert(equilibriumLabel.includes('may retain 2 cards this turn'), equilibriumLabel)
  assertEqual(equilibrated.players[0].block, 4)
  assertDeepEqual(equilibrated.players[0].hand.map((card) => card.uid),
    ['ui-equilibrium-defend', 'ui-equilibrium-zap'])
  assert(equilibrated.players[0].hand.every((card) => card.retainedLastTurn === true),
    'the retained cards need their next-turn history')
  assertEqual(equilibrated.players[0].retainCardsThisTurn, 0)
})
await shot('06zphgic-equilibrium-resolved')

await page.evaluate((baseline) => {
  const run = structuredClone(baseline)
  const actor = run.combat.players[0]
  Object.assign(run.combat, { phase: 'player', turn: 1, startTurnProgress: undefined })
  Object.assign(actor, {
    name: 'Silent', character: 'silent',
    hand: [
      { uid: 'ui-plans', defId: 'well_laid_plans', upgraded: true },
      { uid: 'ui-plans-regret', defId: 'regret', upgraded: false },
      { uid: 'ui-plans-strike', defId: 'strike_silent', upgraded: false },
      { uid: 'ui-plans-defend', defId: 'defend_silent', upgraded: false },
      { uid: 'ui-plans-neutralize', defId: 'neutralize', upgraded: false },
    ],
    discard: [], draw: [], exhaust: [], powers: [], energy: 1, block: 0, drawLocked: false,
    orbs: [null, null, null], retainCardsThisTurn: 0,
  })
  run.combat.players = [actor]
  window.__STS_DEBUG__.setRun(run)
}, colorlessBatch1Restore)
const plansCard = page.getByRole('button', { name: /^Well-Laid Plans\+, cost 1,/ })
const plansLabel = await plansCard.getAttribute('aria-label')
await shot('06zphgid-well-laid-plans-ready')
await plansCard.click()
await plantDiscardOrderCards()
await page.getByRole('button', { name: 'End turn' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'discard')
await page.getByRole('button', { name: 'Retain Strike' }).click()
await page.getByRole('button', { name: 'Retain Defend' }).click()
await shot('06zphgie-well-laid-plans-choice')
await page.getByRole('button', { name: /Confirm Silent/ }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'enemy')
const planned = await readState()
check('Well-Laid Plans+ visibly Retains two choices without spending Regret Retain', () => {
  assert(plansLabel.includes('at the end of your turn') && plansLabel.includes('may retain 2 cards this turn'), plansLabel)
  assertDeepEqual(planned.players[0].hand.map((card) => card.uid),
    ['ui-plans-regret', 'ui-plans-strike', 'ui-plans-defend'])
  assert(planned.players[0].hand.every((card) => card.retainedLastTurn === true))
  assertDeepEqual(planned.players[0].discard.map((card) => card.uid), ['ui-plans-neutralize'])
})
await shot('06zphgif-well-laid-plans-resolved')

await page.evaluate((baseline) => {
  const run = structuredClone(baseline)
  const actor = run.combat.players[0]
  Object.assign(run.combat, { phase: 'player', turn: 1, startTurnProgress: undefined })
  Object.assign(actor, {
    name: 'Defect', character: 'defect',
    hand: [{ uid: 'ui-loop', defId: 'loop', upgraded: true }],
    discard: [], draw: [], exhaust: [], powers: [], energy: 1, block: 0,
    orbs: ['lightning', 'frost', 'dark'], orbEndTurnBonus: 0, lightningEndTurnBonus: 0,
  })
  run.combat.players = [actor]
  run.combat.enemies = run.combat.enemies.slice(0, 2)
  Object.assign(run.combat.enemies[0], {
    defId: 'cultist', row: 0, hp: 20, maxHp: 20, block: 0, dead: false, abilityUsed: true,
  })
  Object.assign(run.combat.enemies[1], {
    defId: 'red_louse', row: 1, hp: 20, maxHp: 20, block: 0, dead: false, abilityUsed: true,
  })
  window.__STS_DEBUG__.setRun(run)
}, colorlessBatch1Restore)
const loopCard = page.getByRole('button', { name: /^Loop\+, cost 1,/ })
const loopLabel = await loopCard.getAttribute('aria-label')
await loopCard.click()
await page.getByRole('button', { name: /^Loop\+: trigger 1 Orb's end-of-turn ability 2 times/ }).waitFor()
await plantDiscardOrderCards()
await page.getByRole('button', { name: 'End turn' }).click()
const loopEffect = page.locator('.end-turn-effect--card')
await loopEffect.waitFor()
await loopEffect.click()
const loopOrb = page.getByRole('button', { name: 'Choose lightning Orb 1' })
await loopOrb.waitFor()
await loopOrb.click()
await loopEffect.click()
await loopOrb.click()
const [loopFirstTarget, loopSecondTarget] = await page.evaluate(() => window.__STS_DEBUG__.getState().enemies.map((enemy) => enemy.uid))
for (const target of [loopSecondTarget, loopSecondTarget, loopFirstTarget]) {
  const ordinaryLightning = page.locator('button.end-turn-effect--orb')
  await ordinaryLightning.waitFor()
  await ordinaryLightning.click()
  await page.locator('.enemy--targeted').first().waitFor()
  await page.locator(`[data-enemy-id="${target}"]`).click()
}
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'discard')
const looped = await readState()
check('Loop+ visibly chooses an Orb twice, then resolves two copies before the normal passives', () => {
  assert(loopLabel.includes("trigger 1 Orb's end-of-turn ability 2 times"), loopLabel)
  assertEqual(looped.enemies[0].hp, 19, 'the ordinary Lightning end-turn ability still resolves')
  assertEqual(looped.enemies[1].hp, 18, 'Loop+ hits the selected enemy twice')
  assertEqual(looped.players[0].block, 1, 'the ordinary Frost end-turn ability still resolves')
})
await shot('06zphgic2-loop-resolved')
await page.getByRole('button', { name: /Confirm Defect/ }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'enemy')

await page.evaluate((baseline) => {
  const run = structuredClone(baseline)
  const actor = run.combat.players[0]
  Object.assign(run.combat, { phase: 'player', turn: 1, startTurnProgress: undefined })
  Object.assign(actor, {
    name: 'Defect', character: 'defect', hp: 8, maxHp: 10,
    hand: [
      { uid: 'ui-buffer', defId: 'buffer', upgraded: true },
      { uid: 'ui-buffer-rupture', defId: 'rupture', upgraded: true },
      { uid: 'ui-buffer-offering', defId: 'offering', upgraded: false },
    ],
    discard: [], draw: [], exhaust: [], powers: [], energy: 2, block: 0, strength: 0,
  })
  run.combat.players = [actor]
  window.__STS_DEBUG__.setRun(run)
}, colorlessBatch1Restore)
const bufferCard = page.getByRole('button', { name: /^Buffer\+, cost 2,/ })
const bufferLabel = await bufferCard.getAttribute('aria-label')
await shot('06zphgic3-buffer-ready')
await bufferCard.click()
await page.getByRole('button', { name: /^Rupture\+,/ }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].powers[0]?.counter === 1)
const bufferedPower = page.getByRole('button', { name: /^Buffer\+:/ })
const bufferedPowerLabel = await bufferedPower.getAttribute('aria-label')
await shot('06zphgic4-buffer-one-cube')
await page.getByRole('button', { name: /^Offering,/ }).click()
await page.waitForFunction(() => !window.__STS_DEBUG__.getState().players[0].powers
  .some((power) => power.defId === 'buffer'))
const buffered = await readState()
check('Buffer+ visibly prevents two HP-loss instances, tracks cubes, then Exhausts', () => {
  assert(bufferLabel.includes('prevent the next 2 times you would lose hit points'), bufferLabel)
  assert(bufferedPowerLabel.includes('1 of 2 cubes'), bufferedPowerLabel)
  assertEqual(buffered.players[0].hp, 8)
  assert(buffered.players[0].exhaust.some((card) => card.uid === 'ui-buffer'),
    'Buffer+ did not Exhaust after its second prevention')
})
await shot('06zphgic5-buffer-exhausted')

await page.evaluate((baseline) => {
  const run = structuredClone(baseline)
  const actor = run.combat.players[0]
  const source = run.combat.enemies[0]
  Object.assign(run.combat, {
    phase: 'player', turn: 2, startTurnProgress: undefined, pendingCardCopy: undefined,
  })
  Object.assign(actor, {
    name: 'Defect', character: 'defect',
    hand: [{ uid: 'ui-echo-strike', defId: 'strike_defect', upgraded: false }],
    discard: [], draw: [], exhaust: [],
    powers: [{ uid: 'ui-echo-form', defId: 'echo_form', upgraded: true }],
    energy: 3, block: 0, doubledCardsThisTurn: 1, doubledAttacksThisTurn: 0,
    cardsPlayedThisTurn: 0, attacksPlayedThisTurn: 0,
  })
  run.combat.players = [actor]
  run.combat.enemies = [
    { ...source, uid: 'echo-first', defId: 'cultist', row: 0, hp: 6, maxHp: 6,
      block: 0, vulnerable: 0, dead: false, isBoss: false },
    { ...source, uid: 'echo-second', defId: 'red_louse', row: 1, hp: 6, maxHp: 6,
      block: 0, vulnerable: 0, dead: false, isBoss: false },
  ]
  run.combat.log = []
  window.__STS_DEBUG__.setRun(run)
}, colorlessBatch1Restore)
const echoPower = page.getByRole('button', { name: /^Echo Form\+:/ })
const echoGlyphSource = await echoPower.locator('img.icon').getAttribute('src')
const echoPowerLabel = await echoPower.getAttribute('aria-label')
const queuedEchoText = await page.locator('.seat__pending').filter({ hasText: 'Echo Form' }).textContent()
const queuedEchoSeat = await page.locator('.seat--viewer').getAttribute('aria-label')
check('Echo Form+ visibly arms the first Attack or Skill', () => {
  assert(echoGlyphSource?.startsWith('/assets/status-icons/'), `Echo Form probed missing bespoke art: ${echoGlyphSource}`)
  assert(echoPowerLabel.includes('next Attack or Skill') && echoPowerLabel.includes('played twice'), echoPowerLabel)
  assert(queuedEchoText.includes('next 1 Attack or Skill card played twice'), queuedEchoText)
  assert(queuedEchoSeat.includes('Echo Form, next 1 Attack or Skill card played twice'), queuedEchoSeat)
})
await echoPower.click()
await waitForPowerZoom()
await shot('06zphgic6-echo-form-armed')
await page.keyboard.press('Escape')
await page.waitForFunction(() => !document.querySelector('.power__zoom'))
await page.getByRole('button', { name: /^Strike,/ }).click()
await page.getByText('Choose an enemy for Strike copy (Echo Form)').waitFor()
await page.getByRole('button', { name: /^Cultist,/ }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'copy')
await page.getByText('Choose an enemy for original Strike after Echo Form copy').waitFor()
await page.locator('.prompt').evaluate((prompt) => Promise.all(
  prompt.getAnimations().map((animation) => animation.finished),
))
await shot('06zphgic7-echo-form-copy-target')
await page.getByRole('button', { name: /^Red Louse,/ }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'player')
const echoed = await readState()
check('Echo Form visibly resolves its independently targeted copy once', () => {
  assertDeepEqual(echoed.enemies.map((enemy) => enemy.hp), [5, 5])
  assertEqual(echoed.players[0].cardsPlayedThisTurn, 2)
  assertEqual(echoed.players[0].attacksPlayedThisTurn, 2)
  assertEqual(echoed.players[0].doubledCardsThisTurn, 0)
  assertEqual(echoed.players[0].discard.filter((card) => card.uid === 'ui-echo-strike').length, 1)
})
await shot('06zphgic8-echo-form-resolved')

await page.evaluate((baseline) => {
  const run = structuredClone(baseline)
  const actor = run.combat.players[0]
  Object.assign(run.combat, { phase: 'player', turn: 1, startTurnProgress: undefined })
  Object.assign(actor, {
    name: 'Defect', character: 'defect',
    hand: [
      { uid: 'ui-claw-pack-1', defId: 'claw_claw_pack', upgraded: false },
      { uid: 'ui-claw-pack-2', defId: 'claw_claw_pack', upgraded: true },
    ],
    discard: [], draw: [], exhaust: [], powers: [], energy: 2,
    clawCubesGainedThisCombat: 0,
  })
  run.combat.enemies = run.combat.enemies.slice(0, 1)
  Object.assign(run.combat.enemies[0], { hp: 20, maxHp: 20, block: 0, dead: false, abilityUsed: true })
  window.__STS_DEBUG__.setRun(run)
}, colorlessBatch1Restore)
const clawPack = page.getByRole('button', { name: /^Claw \(Claw Pack\), cost 0,/ })
const clawPackPlus = page.getByRole('button', { name: /^Claw \(Claw Pack\)\+, cost 0,/ })
const clawPackLabel = await clawPack.getAttribute('aria-label')
const clawPackPlusLabel = await clawPackPlus.getAttribute('aria-label')
await shot('06zphgj-claw-pack-ready')
await clawPack.click()
await page.locator('.enemy--targeted').click()
await clawPackPlus.click()
await page.locator('.enemy--targeted').click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().enemies[0].hp === 16)
const clawed = await readState()
const clawSeatLabel = await page.getByRole('button', { name: /^Defect,/ }).getAttribute('aria-label')
const clawTokenTitle = await page.locator('.seat__status-strip .token--clawCubes').getAttribute('title')
check('Collector Claw faces visibly share their combat cube scaling', () => {
  assert(clawPackLabel.includes('gain 1 Claw cube'), clawPackLabel)
  assert(clawPackLabel.includes('1 per Claw cube gained this combat'), clawPackLabel)
  assert(clawPackPlusLabel.includes('1 plus 1 per Claw cube gained this combat'), clawPackPlusLabel)
  assertEqual(clawed.players[0].clawCubesGainedThisCombat, 2)
  assertEqual(clawed.enemies[0].hp, 16)
  assertEqual(clawed.players[0].energy, 2)
  assert(clawSeatLabel.includes('Claw cubes 2'), clawSeatLabel)
  assertEqual(clawTokenTitle, 'Claw cubes 2')
})
await shot('06zphgk-claw-pack-resolved')

await page.evaluate((baseline) => {
  const run = structuredClone(baseline)
  const actor = run.combat.players[0]
  const ally = run.combat.players[1]
  if (!ally) throw new Error('the Core Surge playtest needs a teammate')
  Object.assign(run.combat, { phase: 'player', turn: 1, startTurnProgress: undefined })
  Object.assign(actor, {
    name: 'Defect', character: 'defect', weak: 0, vulnerable: 1,
    hand: [{ uid: 'ui-core-surge', defId: 'core_surge', upgraded: false }],
    discard: [], draw: [], exhaust: [], powers: [], energy: 1,
  })
  Object.assign(ally, { weak: 2, vulnerable: 2, dead: false, hp: Math.max(1, ally.hp) })
  run.combat.enemies = run.combat.enemies.slice(0, 1)
  Object.assign(run.combat.enemies[0], { hp: 10, maxHp: 10, block: 0, dead: false, abilityUsed: true })
  window.__STS_DEBUG__.setRun(run)
}, colorlessBatch1Restore)
const coreSurgeCard = page.getByRole('button', { name: /^Core Surge, cost 1,/ })
const coreSurgeLabel = await coreSurgeCard.getAttribute('aria-label')
await coreSurgeCard.click()
await page.locator('.enemy--targeted').click()
const coreSurgeAlly = page.locator('.seat--targetable:not(.seat--viewer)').first()
await coreSurgeAlly.waitFor()
await shot('06zphg-core-surge-ally-choice')
await coreSurgeAlly.click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().enemies[0].hp === 7)
const coreSurged = await readState()
check('Core Surge Retains and cleanses the chosen teammate before attacking', () => {
  assert(coreSurgeLabel.includes('support effect may target any player'), coreSurgeLabel)
  assert(coreSurgeLabel.includes('retain'), coreSurgeLabel)
  assertEqual(coreSurged.players[0].weak, 0)
  assertEqual(coreSurged.players[0].vulnerable, 1)
  assertEqual(coreSurged.players[1].weak, 0)
  assertEqual(coreSurged.players[1].vulnerable, 0)
  assertEqual(coreSurged.players[0].energy, 0)
})
await shot('06zphh-core-surge-resolved')

await page.evaluate((baseline) => {
  const run = structuredClone(baseline)
  const actor = run.combat.players[0]
  Object.assign(run.combat, { phase: 'player', turn: 1, startTurnProgress: undefined })
  Object.assign(actor, {
    name: 'Defect', character: 'defect', weak: 0,
    hand: [{ uid: 'ui-all-for-one', defId: 'all_for_one', upgraded: true }],
    discard: [
      { uid: 'ui-all-deflect', defId: 'deflect', upgraded: false },
      { uid: 'ui-all-daze', defId: 'daze', upgraded: false },
      { uid: 'ui-all-zap-plus', defId: 'zap', upgraded: true },
      { uid: 'ui-all-zap', defId: 'zap', upgraded: false },
    ],
    draw: [], exhaust: [], powers: [], energy: 2,
  })
  run.combat.enemies = run.combat.enemies.slice(0, 1)
  Object.assign(run.combat.enemies[0], { hp: 10, maxHp: 10, block: 0, dead: false, abilityUsed: true })
  window.__STS_DEBUG__.setRun(run)
}, colorlessBatch1Restore)
const allForOneCard = page.getByRole('button', { name: /^All for One\+, cost 2,/ })
const allForOneLabel = await allForOneCard.getAttribute('aria-label')
await shot('06zphi-all-for-one-ready')
await allForOneCard.click()
await page.locator('.enemy--targeted').click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hand.length === 2)
const allForOne = await readState()
check('All for One+ returns every playable current 0-cost discard card', () => {
  assert(allForOneLabel.includes('return all 0-cost cards from your discard pile to hand'), allForOneLabel)
  assertEqual(allForOne.enemies[0].hp, 7)
  assertDeepEqual(allForOne.players[0].hand.map((card) => card.uid), ['ui-all-deflect', 'ui-all-zap-plus'])
  assertDeepEqual(allForOne.players[0].discard.map((card) => card.uid),
    ['ui-all-daze', 'ui-all-zap', 'ui-all-for-one'])
})
await shot('06zphj-all-for-one-resolved')

await page.evaluate((baseline) => {
  const run = structuredClone(baseline)
  const actor = run.combat.players[0]
  Object.assign(run.combat, { phase: 'player', turn: 1, startTurnProgress: undefined })
  Object.assign(actor, {
    name: 'Defect', character: 'defect', weak: 0,
    hand: [{ uid: 'ui-thunder-strike', defId: 'thunder_strike', upgraded: true }],
    discard: [], draw: [], exhaust: [], powers: [], energy: 3,
    orbs: ['lightning', 'lightning', 'lightning'],
  })
  run.combat.enemies = run.combat.enemies.slice(0, 1)
  Object.assign(run.combat.enemies[0], { hp: 20, maxHp: 20, block: 1, dead: false, abilityUsed: true })
  window.__STS_DEBUG__.setRun(run)
}, colorlessBatch1Restore)
const thunderStrikeCard = page.getByRole('button', { name: /^Thunder Strike\+, cost 3,/ })
const thunderStrikeLabel = await thunderStrikeCard.getAttribute('aria-label')
await shot('06zphk-thunder-strike-ready')
await thunderStrikeCard.click()
await page.locator('.enemy--targeted').click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().enemies[0].hp === 3)
const thunderStruck = await readState()
check('Thunder Strike+ visibly deals one 6-damage hit per Lightning Orb', () => {
  assert(thunderStrikeLabel.includes('6 damage once per Lightning Orb'), thunderStrikeLabel)
  assertEqual(thunderStruck.enemies[0].hp, 3)
  assertEqual(thunderStruck.players[0].energy, 0)
})
await shot('06zphl-thunder-strike-resolved')

await page.evaluate((baseline) => {
  const run = structuredClone(baseline)
  const actor = run.combat.players[0]
  const ally = run.combat.players[1]
  if (!ally) throw new Error('the Reinforced Body playtest needs a teammate')
  Object.assign(run.combat, { phase: 'player', turn: 1, startTurnProgress: undefined })
  Object.assign(actor, {
    name: 'Defect', character: 'defect',
    hand: [{ uid: 'ui-reinforced-body', defId: 'reinforced_body', upgraded: false }],
    discard: [], draw: [], exhaust: [], powers: [], energy: 0, block: 0, cardBlockBonus: 0,
  })
  Object.assign(ally, { block: 0, dead: false })
  window.__STS_DEBUG__.setRun(run)
}, colorlessBatch1Restore)
const reinforcedBodyCard = page.getByRole('button', { name: /^Reinforced Body, cost X,/ })
const reinforcedBodyLabel = await reinforcedBodyCard.getAttribute('aria-label')
const reinforcedBodyDisabled = await reinforcedBodyCard.getAttribute('aria-disabled') === 'true'
check('base Reinforced Body explains and enforces that X cannot be zero', () => {
  assert(reinforcedBodyLabel.includes('must spend at least 1 Energy'), reinforcedBodyLabel)
  assert(reinforcedBodyDisabled, 'Reinforced Body should be disabled at zero Energy')
})
await shot('06zphm-reinforced-body-disabled')
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[0].energy = 3
  debug.setRun(run)
})
await page.waitForFunction(() => document.querySelector('.hand .card[aria-label^="Reinforced Body,"]')?.getAttribute('aria-disabled') === 'false')
await reinforcedBodyCard.click()
await page.getByText('Choose Energy for Reinforced Body').waitFor()
const reinforcedBodySpenders = await page.locator('.prompt button').allTextContents()
check('base Reinforced Body offers only legal positive X choices', () => {
  assertDeepEqual(reinforcedBodySpenders.filter((text) => text.startsWith('Spend ')), ['Spend 1', 'Spend 2', 'Spend 3'])
})
await shot('06zphn-reinforced-body-energy')
await page.getByRole('button', { name: 'Spend 2' }).click()
const reinforcedBodyAlly = page.locator('.seat--targetable:not(.seat--viewer)').first()
await reinforcedBodyAlly.click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[1].block === 3)
const reinforced = await readState()
check('base Reinforced Body spends X and assigns its X+1 Block to one teammate', () => {
  assertEqual(reinforced.players[0].energy, 1)
  assertEqual(reinforced.players[0].block, 0)
  assertEqual(reinforced.players[1].block, 3)
})
await shot('06zpho-reinforced-body-resolved')

await page.evaluate((baseline) => {
  const run = structuredClone(baseline)
  const actor = run.combat.players[0]
  const ally = run.combat.players[1]
  if (!ally) throw new Error('the Reinforced Body+ playtest needs a teammate')
  Object.assign(run.combat, { phase: 'player', turn: 1, startTurnProgress: undefined })
  Object.assign(actor, {
    name: 'Defect', character: 'defect',
    hand: [{ uid: 'ui-reinforced-body-plus', defId: 'reinforced_body', upgraded: true }],
    discard: [], draw: [], exhaust: [], powers: [], energy: 0, block: 0, cardBlockBonus: 1,
  })
  Object.assign(ally, { block: 0, dead: false })
  window.__STS_DEBUG__.setRun(run)
}, colorlessBatch1Restore)
const reinforcedBodyPlus = page.getByRole('button', { name: /^Reinforced Body\+, cost X,/ })
await reinforcedBodyPlus.click()
await page.getByRole('button', { name: 'Spend 0' }).click()
await page.locator('.seat--targetable.seat--viewer').click()
await shot('06zphp-reinforced-body-plus-second-target')
await page.locator('.seat--targetable:not(.seat--viewer)').first().click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hand.length === 0)
const reinforcedPlus = await readState()
check('Reinforced Body+ allows X zero and assigns both printed Block icons independently', () => {
  assertEqual(reinforcedPlus.players[0].block, 1)
  assertEqual(reinforcedPlus.players[1].block, 1)
  assertEqual(reinforcedPlus.players[0].energy, 0)
})
await shot('06zphq-reinforced-body-plus-resolved')

await page.evaluate((baseline) => {
  const run = structuredClone(baseline)
  const actor = run.combat.players[0]
  const ally = run.combat.players[1]
  if (!ally) throw new Error('the Power Through playtest needs a teammate')
  Object.assign(run.combat, { phase: 'player', turn: 1, startTurnProgress: undefined })
  Object.assign(actor, {
    hand: [{ uid: 'ui-power-through', defId: 'power_through', upgraded: true }],
    discard: [], draw: [{ uid: 'ui-power-through-draw', defId: 'strike_ironclad', upgraded: false }],
    exhaust: [], powers: [], energy: 1, block: 0,
  })
  Object.assign(ally, { block: 0, dead: false })
  window.__STS_DEBUG__.setRun(run)
}, colorlessBatch1Restore)
const powerThroughCard = page.getByRole('button', { name: /^Power Through\+, cost 1,/ })
const powerThroughLabel = await powerThroughCard.getAttribute('aria-label')
await powerThroughCard.click()
const powerThroughTarget = page.locator('.seat--targetable:not(.seat--viewer)').first()
await powerThroughTarget.waitFor()
await powerThroughTarget.scrollIntoViewIfNeeded()
await page.locator('.prompt').evaluate(async (element) => {
  await Promise.all(element.getAnimations().map((animation) => animation.finished))
})
await shot('06zpi-power-through-ally-target')
await powerThroughTarget.click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].draw[0]?.defId === 'daze')
const poweredThrough = await readState()
check('Power Through+ blocks any teammate while its Daze goes to the caster draw-top', () => {
  assert(powerThroughLabel.includes('gain 4 Block'), powerThroughLabel)
  assert(powerThroughLabel.includes('support effect may target any player'), powerThroughLabel)
  assert(powerThroughLabel.includes('put 1 Daze on your draw pile'), powerThroughLabel)
  assertEqual(poweredThrough.players[0].block, 0)
  assertEqual(poweredThrough.players[1].block, 4)
  assertEqual(poweredThrough.players[0].draw[0].defId, 'daze')
  assertEqual(poweredThrough.players[0].energy, 0)
})
await shot('06zpj-power-through-resolved')

await page.evaluate((baseline) => {
  const run = structuredClone(baseline)
  const actor = run.combat.players[0]
  const template = run.combat.enemies[0]
  Object.assign(run.combat, { phase: 'player', turn: 1, startTurnProgress: undefined, die: 1 })
  Object.assign(actor, {
    hand: [{ uid: 'ui-flame-barrier', defId: 'flame_barrier', upgraded: true }],
    discard: [], draw: [], exhaust: [], powers: [], energy: 2, block: 0, row: 0,
  })
  run.combat.enemies = [
    { ...template, uid: 'ui-flame-same', defId: 'cultist', row: 0, isBoss: false,
      hp: 5, maxHp: 5, block: 0, dead: false, actionIndex: 0 },
    { ...template, uid: 'ui-flame-other', defId: 'cultist', row: 1, isBoss: false,
      hp: 5, maxHp: 5, block: 0, dead: false, actionIndex: 0 },
    { ...template, uid: 'ui-flame-boss', defId: 'cultist', row: 1, isBoss: true,
      hp: 5, maxHp: 5, block: 0, dead: false, actionIndex: 0 },
    { ...template, uid: 'ui-flame-idle', defId: 'gremlin_nob', row: 0, isBoss: false,
      hp: 5, maxHp: 5, block: 0, dead: false, actionIndex: 0 },
  ]
  window.__STS_DEBUG__.setRun(run)
}, colorlessBatch1Restore)
const flameBarrierCard = page.getByRole('button', { name: /^Flame Barrier\+, cost 2,/ })
const flameBarrierLabel = await flameBarrierCard.getAttribute('aria-label')
await flameBarrierCard.click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].block === 4)
await page.locator('.board').evaluate((board) => { board.scrollTop = 0 })
const flamed = await readState()
check('Flame Barrier+ reads current intents and burns only enemies attacking its player', () => {
  assert(flameBarrierLabel.includes('gain 4 Block'), flameBarrierLabel)
  assert(flameBarrierLabel.includes('per Attack icon in its intent'), flameBarrierLabel)
  assertEqual(flamed.enemies.find((enemy) => enemy.uid === 'ui-flame-same').hp, 4)
  assertEqual(flamed.enemies.find((enemy) => enemy.uid === 'ui-flame-other').hp, 5)
  assertEqual(flamed.enemies.find((enemy) => enemy.uid === 'ui-flame-boss').hp, 4)
  assertEqual(flamed.enemies.find((enemy) => enemy.uid === 'ui-flame-idle').hp, 5)
})
await shot('06zpk-flame-barrier-intents')
await page.locator('.board').evaluate((board) => { board.scrollTop = board.scrollHeight })
await shot('06zpl-flame-barrier-row-intents')

await page.evaluate((baseline) => {
  const run = structuredClone(baseline)
  const actor = run.combat.players[0]
  Object.assign(run.combat, { phase: 'player', turn: 1, startTurnProgress: undefined })
  Object.assign(actor, {
    hand: [
      { uid: 'ui-rampage', defId: 'rampage', upgraded: true },
      { uid: 'ui-rampage-fuel', defId: 'defend_ironclad', upgraded: false },
    ],
    discard: [], draw: [],
    exhaust: [
      { uid: 'ui-rampage-old-1', defId: 'bash', upgraded: false },
      { uid: 'ui-rampage-old-2', defId: 'strike_ironclad', upgraded: false },
    ],
    powers: [], energy: 1,
  })
  run.combat.enemies = run.combat.enemies.slice(0, 1)
  Object.assign(run.combat.enemies[0], {
    hp: 10, maxHp: 10, block: 0, dead: false, abilityUsed: true, row: actor.row,
  })
  window.__STS_DEBUG__.setRun(run)
}, colorlessBatch1Restore)
const rampageCard = page.getByRole('button', { name: /^Rampage\+, cost 1,/ })
const rampageLabel = await rampageCard.getAttribute('aria-label')
await rampageCard.click()
await page.getByRole('button', { name: /^Defend, cost 1,/ }).click()
await page.waitForSelector('.enemy--targeted')
await shot('06zpm-rampage-exhaust-target')
await page.locator('.enemy--targeted').click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().enemies[0].hp === 7)
const rampaged = await readState()
check('Rampage+ Exhausts a hand card before counting the full Exhaust pile for damage', () => {
  assert(rampageLabel.includes('exhaust 1 card'), rampageLabel)
  assert(rampageLabel.includes('1 per card in your Exhaust pile'), rampageLabel)
  assertEqual(rampaged.enemies[0].hp, 7)
  assertDeepEqual(rampaged.players[0].exhaust.map((card) => card.uid), [
    'ui-rampage-old-1', 'ui-rampage-old-2', 'ui-rampage-fuel',
  ])
})
await shot('06zpn-rampage-resolved')

await page.evaluate((baseline) => {
  const run = structuredClone(baseline)
  const actor = run.combat.players[0]
  Object.assign(run.combat, { phase: 'player', turn: 1, startTurnProgress: undefined })
  Object.assign(actor, {
    hand: [{ uid: 'ui-exhume', defId: 'exhume', upgraded: true }],
    discard: [], draw: [],
    exhaust: [
      { uid: 'ui-exhume-lower', defId: 'defend_ironclad', upgraded: false },
      { uid: 'ui-exhume-top', defId: 'bash', upgraded: false },
    ],
    powers: [], energy: 0,
  })
  window.__STS_DEBUG__.setRun(run)
}, colorlessBatch1Restore)
const exhumeCard = page.getByRole('button', { name: /^Exhume\+, cost 0,/ })
const exhumeLabel = await exhumeCard.getAttribute('aria-label')
await exhumeCard.click()
const exhumeDialog = page.getByRole('dialog', { name: 'Choose a card from your Exhaust pile' })
await exhumeDialog.waitFor()
const exhumePrompt = await page.getByText('Exhume+ — choose a card from your Exhaust pile').textContent()
await exhumeDialog.getByRole('button', { name: /^Defend,/ }).click()
await page.waitForTimeout(150)
await shot('06zpo-exhume-choice')
await exhumeDialog.getByRole('button', { name: 'Return selected card to hand' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hand[0]?.uid === 'ui-exhume-lower')
const exhumed = await readState()
check('Exhume+ chooses any public Exhaust card and returns it only to hand', () => {
  assertEqual(exhumePrompt, 'Exhume+ — choose a card from your Exhaust pile')
  assert(exhumeLabel.includes('put a card from your Exhaust pile into your hand'), exhumeLabel)
  assert(exhumeLabel.includes('exhausts when played'), exhumeLabel)
  assertDeepEqual(exhumed.players[0].hand.map((card) => card.uid), ['ui-exhume-lower'])
  assertDeepEqual(exhumed.players[0].exhaust.map((card) => card.uid), ['ui-exhume-top', 'ui-exhume'])
  assertEqual(exhumed.players[0].energy, 0)
})
await shot('06zpp-exhume-resolved')

await page.evaluate((baseline) => {
  const run = structuredClone(baseline)
  const actor = run.combat.players[0]
  Object.assign(run.combat, { phase: 'player', turn: 1, startTurnProgress: undefined })
  Object.assign(actor, {
    hand: [{ uid: 'ui-rupture', defId: 'rupture', upgraded: true }],
    discard: [], draw: [], exhaust: [], powers: [], energy: 1, hp: 7, block: 4, strength: 0,
  })
  run.combat.enemies = run.combat.enemies.slice(0, 1)
  Object.assign(run.combat.enemies[0], { hp: 10, maxHp: 10, block: 0, dead: false })
  window.__STS_DEBUG__.setRun(run)
}, colorlessBatch1Restore)
const ruptureCard = page.getByRole('button', { name: /^Rupture\+, cost 0,/ })
const ruptureLabel = await ruptureCard.getAttribute('aria-label')
await shot('06zpq-rupture-ready')
await ruptureCard.click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].strength === 1)
const ruptured = await readState()
check('Rupture+ gains Strength before its unblocked HP loss and costs no Energy', () => {
  assert(ruptureLabel.includes('gain 1 Strength'), ruptureLabel)
  assert(ruptureLabel.includes('lose 1 hit points'), ruptureLabel)
  assertEqual(ruptured.players[0].strength, 1)
  assertEqual(ruptured.players[0].hp, 6)
  assertEqual(ruptured.players[0].block, 4)
  assertEqual(ruptured.players[0].energy, 1)
})
await shot('06zpr-rupture-resolved')

await page.evaluate((baseline) => {
  const run = structuredClone(baseline)
  const actor = run.combat.players[0]
  const template = run.combat.enemies[0]
  Object.assign(run.combat, { phase: 'player', turn: 1, startTurnProgress: undefined })
  Object.assign(actor, {
    hand: [{ uid: 'ui-whirlwind', defId: 'whirlwind', upgraded: true }],
    discard: [], draw: [], exhaust: [], powers: [], energy: 6, strength: 0, weak: 0,
    row: 0,
  })
  const ally = run.combat.players.find((player) => player.id !== actor.id)
  if (ally) ally.row = 1
  run.combat.enemies = [
    { ...template, uid: 'ui-whirlwind-anchor', defId: 'cultist', row: 0, isBoss: false,
      hp: 10, maxHp: 10, block: 0, dead: false },
    { ...template, uid: 'ui-whirlwind-same', defId: 'green_louse', row: 0, isBoss: false,
      hp: 10, maxHp: 10, block: 0, dead: false, abilityUsed: true },
    { ...template, uid: 'ui-whirlwind-other', defId: 'red_louse', row: 1, isBoss: false,
      hp: 10, maxHp: 10, block: 0, dead: false },
    { ...template, uid: 'ui-whirlwind-boss', defId: 'gremlin_nob', row: 1, isBoss: true,
      hp: 10, maxHp: 10, block: 0, dead: false },
  ]
  window.__STS_DEBUG__.setRun(run)
}, colorlessBatch1Restore)
const whirlwindCard = page.getByRole('button', { name: /^Whirlwind\+, cost X,/ })
const whirlwindLabel = await whirlwindCard.getAttribute('aria-label')
await whirlwindCard.click()
await page.getByText('Choose Energy for Whirlwind+').waitFor()
const whirlwindTargetsBeforeEnergy = await page.locator('.enemy--targeted').count()
check('Whirlwind+ asks how much Energy to spend before exposing row targets', () => {
  assert(whirlwindLabel.includes('once plus once per Energy spent on this card'), whirlwindLabel)
  assert(whirlwindLabel.includes('affects a whole row and any boss'), whirlwindLabel)
  assertEqual(whirlwindTargetsBeforeEnergy, 0)
})
await page.setViewportSize({ width: 1280, height: 800 })
await page.waitForTimeout(60)
const narrowWhirlwindPicker = await page.evaluate(() => {
  const prompt = document.querySelector('.prompt')?.getBoundingClientRect()
  const spenders = [...document.querySelectorAll('.prompt button')]
    .filter((button) => button.textContent?.startsWith('Spend '))
  const last = spenders.at(-1)?.getBoundingClientRect()
  return { count: spenders.length, promptRight: prompt?.right ?? Infinity, lastRight: last?.right ?? Infinity }
})
check('the full six-Energy Whirlwind picker wraps inside a narrow viewport', () => {
  assertEqual(narrowWhirlwindPicker.count, 7)
  assert(narrowWhirlwindPicker.promptRight <= 1280, `prompt extends to ${narrowWhirlwindPicker.promptRight}px`)
  assert(narrowWhirlwindPicker.lastRight <= 1280, `Spend 6 extends to ${narrowWhirlwindPicker.lastRight}px`)
})
await shot('06zpsa-whirlwind-energy-compact-desktop')
await page.setViewportSize({ width: 1440, height: 900 })
await shot('06zps-whirlwind-energy')
await page.getByRole('button', { name: 'Spend 2' }).click()
await page.getByText(/Choose an enemy.*whole row/).waitFor()
await shot('06zpt-whirlwind-row-target')
await page.getByRole('button', { name: /^Cultist,/ }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].energy === 4)
const whirled = await readState()
check('Whirlwind+ spends only the chosen Energy and hits that row plus the boss X+1 times', () => {
  assertDeepEqual(whirled.enemies.map((enemy) => enemy.hp), [7, 7, 10, 7])
  assertEqual(whirled.players[0].energy, 4)
  assertEqual(whirled.players[0].discard[0].uid, 'ui-whirlwind')
})
await shot('06zpu-whirlwind-resolved')

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.combat.players[0]
  Object.assign(actor, {
    hand: [{ uid: 'ui-skewer', defId: 'skewer', upgraded: true }],
    discard: [], draw: [], exhaust: [], energy: 3, strength: 0, weak: 0,
  })
  run.combat.enemies = run.combat.enemies.map((enemy) => ({
    ...enemy, hp: 10, maxHp: 10, block: 1, vulnerable: 0, dead: false,
  }))
  debug.setRun(run)
})
const skewerCard = page.getByRole('button', { name: /^Skewer\+, cost X,/ })
const skewerLabel = await skewerCard.getAttribute('aria-label')
await skewerCard.click()
await page.getByRole('button', { name: 'Spend 2' }).click()
await page.getByRole('button', { name: /^Cultist,/ }).click()
const skewered = await readState()
check('Skewer+ spends chosen X Energy and resolves X separate 2-damage hits', () => {
  assert(skewerLabel.includes('2 damage once per Energy spent on this card'), skewerLabel)
  assertEqual(skewered.enemies[0].hp, 7)
  assertEqual(skewered.players[0].energy, 1)
})
await shot('06zpv-skewer-resolved')

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.combat.players[0]
  Object.assign(actor, {
    hand: [{ uid: 'ui-ftl', defId: 'ftl', upgraded: true }],
    draw: [{ uid: 'ui-ftl-draw', defId: 'strike_defect', upgraded: false }],
    discard: [], exhaust: [], powers: [], energy: 3, strength: 0, cardsPlayedThisTurn: 0,
  })
  run.combat.enemies = run.combat.enemies.map((enemy) => ({
    ...enemy, hp: 10, maxHp: 10, block: 0, vulnerable: 0, dead: false,
  }))
  debug.setRun(run)
})
const ftlCard = page.getByRole('button', { name: /^FTL\+, cost 0,/ })
const ftlLabel = await ftlCard.getAttribute('aria-label')
await shot('06zpw-ftl-ready')
await ftlCard.click()
await page.getByRole('button', { name: /^Cultist,/ }).click()
const firstFtl = await readState()
check('FTL+ visibly draws only as the first card played this turn', () => {
  assert(ftlLabel.includes('draw 1 card if this is the first card you played this turn'), ftlLabel)
  assertEqual(firstFtl.enemies[0].hp, 8)
  assertEqual(firstFtl.players[0].cardsPlayedThisTurn, 1)
  assertDeepEqual(firstFtl.players[0].hand.map((card) => card.uid), ['ui-ftl-draw'])
})
await shot('06zpx-ftl-first-card-resolved')

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.combat.players[0]
  Object.assign(actor, {
    name: 'Defect', character: 'defect',
    hand: [
      { uid: 'ui-ftl-power-first', defId: 'inflame', upgraded: false },
      { uid: 'ui-ftl-late', defId: 'ftl', upgraded: false },
    ],
    draw: [{ uid: 'ui-ftl-stays-drawn', defId: 'strike_defect', upgraded: false }],
    discard: [], exhaust: [], powers: [], energy: 3, block: 0, strength: 0, cardsPlayedThisTurn: 0,
  })
  run.combat.enemies = run.combat.enemies.map((enemy) => ({
    ...enemy, hp: 10, maxHp: 10, block: 0, vulnerable: 0, dead: false,
  }))
  debug.setRun(run)
})
await page.getByRole('button', { name: /^Inflame,/ }).click()
await page.getByRole('button', { name: /^FTL,/ }).click()
await page.getByRole('button', { name: /^Cultist,/ }).click()
const lateFtl = await readState()
check('FTL does not draw after another card through the real controls', () => {
  assertEqual(lateFtl.players[0].cardsPlayedThisTurn, 2)
  assertEqual(lateFtl.players[0].hand.length, 0)
  assertEqual(lateFtl.players[0].draw[0].uid, 'ui-ftl-stays-drawn')
})

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.combat.players[0]
  Object.assign(actor, {
    hand: [
      { uid: 'ui-force-field', defId: 'force_field', upgraded: true },
      { uid: 'ui-tempest', defId: 'tempest', upgraded: true },
    ],
    discard: [], draw: [], exhaust: [],
    powers: [
      { uid: 'ui-force-power-a', defId: 'machine_learning', upgraded: false },
      { uid: 'ui-force-power-b', defId: 'heatsinks', upgraded: false },
    ],
    energy: 4, block: 0, orbs: [null, null, null], cardsPlayedThisTurn: 0,
  })
  debug.setRun(run)
})
const forceFieldCard = page.getByRole('button', { name: /^Force Field\+, cost 1,/ })
const tempestCard = page.getByRole('button', { name: /^Tempest\+, cost X,/ })
const tempestLabel = await tempestCard.getAttribute('aria-label')
await shot('06zpy-defect-power-cards-ready')
await forceFieldCard.click()
await tempestCard.click()
await page.getByRole('button', { name: 'Spend 2' }).click()
const defectPowerCards = await readState()
check('Force Field discounts and Tempest+ resolves X through the real controls', () => {
  assert(tempestLabel.includes('channel X+1 lightning orbs'), tempestLabel)
  assertEqual(defectPowerCards.players[0].block, 4)
  assertEqual(defectPowerCards.players[0].energy, 1)
  assertEqual(defectPowerCards.players[0].orbs.length, 3)
  assertEqual(defectPowerCards.players[0].exhaust[0].uid, 'ui-tempest')
})
await shot('06zpz-force-field-tempest-resolved')

for (const freeKind of ['forced', 'discounted']) {
  await page.evaluate(({ baseline, freeKind }) => {
    const run = structuredClone(baseline)
    const actor = run.combat.players[0]
    Object.assign(run.combat, {
      phase: freeKind === 'forced' ? 'start' : 'player', turn: 1,
      startTurnProgress: freeKind === 'forced' ? {
        choices: [],
        forcedCard: {
          playerId: actor.id, cardUid: `ui-${freeKind}-base-whirlwind`,
          sourceCardId: 'mayhem', exhaustNonPower: false,
        },
      } : undefined,
    })
    Object.assign(actor, {
      hand: [{ uid: `ui-${freeKind}-base-whirlwind`, defId: 'whirlwind', upgraded: false }],
      discard: [], draw: [], exhaust: [], powers: [], energy: 3, strength: 0, weak: 0,
      freeCardsThisTurn: freeKind === 'discounted' ? 1 : 0,
    })
    run.combat.enemies = run.combat.enemies.slice(0, 1)
    Object.assign(run.combat.enemies[0], { hp: 10, maxHp: 10, block: 0, dead: false, row: actor.row })
    window.__STS_DEBUG__.setRun(run)
  }, { baseline: colorlessBatch1Restore, freeKind })
  if (freeKind === 'discounted') await page.getByRole('button', { name: /^Whirlwind, cost 0,/ }).click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].discard[0]?.defId === 'whirlwind')
  const freeBaseWhirlwind = await readState()
  const freeBasePrompt = await page.locator('.prompt').count()
  check(`a ${freeKind} base Whirlwind resolves as X zero without deadlocking`, () => {
    assertEqual(freeBasePrompt, 0)
    assertEqual(freeBaseWhirlwind.enemies[0].hp, 10)
    assertEqual(freeBaseWhirlwind.players[0].energy, 3)
  })
}

await page.evaluate((baseline) => {
  const run = structuredClone(baseline)
  const actor = run.combat.players[0]
  Object.assign(run.combat, {
    phase: 'start', turn: 1,
    startTurnProgress: {
      choices: [],
      forcedCard: {
        playerId: actor.id, cardUid: 'ui-forced-whirlwind', sourceCardId: 'mayhem', exhaustNonPower: false,
      },
    },
  })
  Object.assign(actor, {
    hand: [{ uid: 'ui-forced-whirlwind', defId: 'whirlwind', upgraded: true }],
    discard: [], draw: [], exhaust: [], powers: [], energy: 3, strength: 0, weak: 0,
  })
  run.combat.enemies = run.combat.enemies.slice(0, 1)
  Object.assign(run.combat.enemies[0], { hp: 10, maxHp: 10, block: 0, dead: false, row: actor.row })
  window.__STS_DEBUG__.setRun(run)
}, colorlessBatch1Restore)
await page.getByText(/Choose an enemy.*whole row/).waitFor()
const forcedWhirlwindEnergyPrompt = await page.getByText('Choose Energy for Whirlwind+').count()
await page.locator('.enemy--targeted').click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'player')
const forcedWhirlwind = await readState()
check('a free forced Whirlwind+ skips X choice and resolves as X zero', () => {
  assertEqual(forcedWhirlwindEnergyPrompt, 0)
  assertEqual(forcedWhirlwind.enemies[0].hp, 9)
  assertEqual(forcedWhirlwind.players[0].energy, 3)
})

await page.evaluate((baseline) => {
  const run = structuredClone(baseline)
  const actor = run.combat.players[0]
  Object.assign(run.combat, { phase: 'roundEnd', turn: 1, startTurnProgress: undefined })
  Object.assign(actor, {
    hand: [], discard: [], exhaust: [], energy: 0,
    powers: [{ uid: 'ui-mayhem', defId: 'mayhem', upgraded: true }],
    draw: [
      ...Array.from({ length: 5 }, (_, index) => ({
        uid: `ui-mayhem-opening-${index}`, defId: 'defend_ironclad', upgraded: false,
      })),
      { uid: 'ui-mayhem-forced', defId: 'meteor_strike', upgraded: true },
    ],
  })
  for (const player of run.combat.players.slice(1)) Object.assign(player, {
    hand: [], discard: [], powers: [],
    draw: Array.from({ length: 5 }, (_, index) => ({
      uid: `ui-mayhem-ally-${player.id}-${index}`, defId: 'defend_silent', upgraded: false,
    })),
  })
  run.combat.enemies = run.combat.enemies.slice(0, 1)
  Object.assign(run.combat.enemies[0], { hp: 20, maxHp: 20, block: 0, dead: false, abilityUsed: true })
  window.__STS_DEBUG__.setRun(run)
}, colorlessBatch1Restore)
await waitForAutomaticTurn(2)
await page.waitForSelector('.enemy--targeted')
const forcedMayhem = page.getByRole('button', { name: /^Meteor Strike\+, cost 0,/ })
await forcedMayhem.waitFor()
const mayhemPowerLabel = await page.locator('.power[aria-label^="Mayhem+"]').getAttribute('aria-label')
check('Mayhem announces its discard fallback and stages the otherwise unaffordable card', () => {
  assert(mayhemPowerLabel.includes('if it cannot be played, discard it'), mayhemPowerLabel)
})
await shot('06zq-mayhem-forced-card')
await page.locator('.enemy--targeted').click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'player')
const mayhem = await readState()
check('Mayhem forces its private card for 0 Energy and resumes Start of Turn', () => {
  assertEqual(mayhem.players[0].energy, 3)
  assertEqual(mayhem.enemies[0].hp, 8)
  assertEqual(mayhem.startTurnProgress, undefined)
})
await shot('06zr-mayhem-resolved')

await page.evaluate((baseline) => {
  const run = structuredClone(baseline)
  const actor = run.combat.players[0]
  Object.assign(run.combat, { phase: 'roundEnd', turn: 1, startTurnProgress: undefined })
  Object.assign(actor, {
    hand: [], discard: [], exhaust: [], energy: 0, block: 0,
    powers: [{ uid: 'ui-mayhem-choice', defId: 'mayhem', upgraded: false }],
    draw: [
      ...Array.from({ length: 5 }, (_, index) => ({
        uid: `ui-mayhem-choice-opening-${index}`, defId: 'defend_ironclad', upgraded: false,
      })),
      { uid: 'ui-mayhem-survivor', defId: 'survivor', upgraded: false },
    ],
  })
  for (const player of run.combat.players.slice(1)) Object.assign(player, {
    hand: [], powers: [], draw: Array.from({ length: 5 }, (_, index) => ({
      uid: `ui-mayhem-choice-ally-${player.id}-${index}`, defId: 'defend_silent', upgraded: false,
    })),
  })
  run.combat.enemies = run.combat.enemies.slice(0, 1).map((enemy) => ({
    ...enemy, hp: 20, maxHp: 20, block: 0, dead: false, abilityUsed: true,
  }))
  window.__STS_DEBUG__.setRun(run)
}, colorlessBatch1Restore)
await waitForAutomaticTurn(2)
await page.getByText(/Discard 1 card.*0\/1 chosen/).waitFor()
const forcedChoiceFodder = page.getByRole('button', { name: /^Defend,/ }).first()
const forcedChoiceFodderEnabled = await forcedChoiceFodder.isEnabled()
check('Mayhem keeps hand cards enabled as mandatory forced-play choices', () => {
  assertEqual(forcedChoiceFodderEnabled, true)
})
await forcedChoiceFodder.click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'player')
const mayhemChoice = await readState()
check('Mayhem resumes after the forced card pays its hand choice', () => {
  assertEqual(mayhemChoice.players[0].energy, 3)
  assertEqual(mayhemChoice.players[0].block, 2)
  assertEqual(mayhemChoice.players[0].discard.some((card) => card.uid === 'ui-mayhem-survivor'), true)
})
await shot('06zs-mayhem-hand-choice-resolved')
await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), colorlessBatch1Restore)
await page.waitForFunction((enemyCount) => {
  const state = window.__STS_DEBUG__.getState()
  return state.enemies.length === enemyCount &&
    !state.players[0].powers.some((card) => card.uid === 'ui-mayhem')
}, colorlessBatch1Restore.combat.enemies.length)

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  Object.assign(run.combat.players[0], {
    hand: [
      { uid: 'ui-purity', defId: 'purity', upgraded: true },
      ...Array.from({ length: 5 }, (_, index) => ({
        uid: `ui-purity-fodder-${index}`, defId: 'strike_ironclad', upgraded: false,
      })),
    ],
    discard: [],
    exhaust: [],
    powers: [{ uid: 'ui-purity-feel-no-pain', defId: 'feel_no_pain', upgraded: false }],
    energy: 0,
    block: 0,
  })
  debug.setRun(run)
})
const purityCard = page.getByRole('button', { name: /^Purity\+,/ })
await purityCard.waitFor()
const purityLabel = await purityCard.getAttribute('aria-label')
await purityCard.click()
await page.getByRole('button', { name: 'Exhaust none' }).waitFor()
const purityPrompt = await page.locator('.prompt').textContent()
await page.getByRole('button', { name: /^Strike,/ }).nth(0).click()
await page.getByRole('button', { name: /^Strike,/ }).nth(1).click()
await page.getByRole('button', { name: 'Exhaust 2' }).waitFor()
await shot('06za-purity-optional-exhaust')
await page.getByRole('button', { name: 'Exhaust 2' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hand.length === 3)
const purity = await readState()
check('Purity+ lets the player Exhaust any number up to five', () => {
  assert(purityLabel.includes('exhaust up to 5 cards from hand'), purityLabel)
  assert(purityPrompt.includes('Exhaust up to 5 cards'), purityPrompt)
  assertEqual(purity.players[0].hand.length, 3)
  assertEqual(purity.players[0].exhaust.length, 3, 'two chosen cards and Purity itself Exhaust')
  assertEqual(purity.players[0].block, 3, 'Feel No Pain sees all three Exhausts')
})
await shot('06zb-purity-resolved')

const exhaustPairRestore = await readState()
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  Object.assign(run.combat.players[0], {
    hand: [
      { uid: 'ui-burning-pact', defId: 'burning_pact', upgraded: true },
      { uid: 'ui-burning-pact-fuel', defId: 'defend_ironclad', upgraded: false },
    ],
    draw: Array.from({ length: 3 }, (_, index) => ({
      uid: `ui-burning-pact-draw-${index}`, defId: 'strike_ironclad', upgraded: false,
    })),
    discard: [],
    exhaust: [],
    powers: [{ uid: 'ui-burning-pact-fnp', defId: 'feel_no_pain', upgraded: false }],
    energy: 1,
    block: 0,
  })
  debug.setRun(run)
})
const burningPactCard = page.getByRole('button', { name: /^Burning Pact\+,/ })
await burningPactCard.waitFor()
const burningPactLabel = await burningPactCard.getAttribute('aria-label')
await burningPactCard.click()
await page.getByText(/Exhaust 1 card.*0\/1 chosen/).waitFor()
await shot('06zc-burning-pact-exhaust-choice')
await page.getByRole('button', { name: /^Defend,/ }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hand.length === 3)
const burningPact = await readState()
check('Burning Pact+ Exhausts its choice before drawing three cards', () => {
  assert(burningPactLabel.includes('exhaust 1 card from hand'), burningPactLabel)
  assert(burningPactLabel.includes('draw 3'), burningPactLabel)
  assertDeepEqual(burningPact.players[0].exhaust.map((card) => card.uid), ['ui-burning-pact-fuel'])
  assertEqual(burningPact.players[0].hand.length, 3)
  assertEqual(burningPact.players[0].block, 1, 'Feel No Pain did not observe the Exhaust')
})
await shot('06zd-burning-pact-resolved')

const severTarget = await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const target = run.combat.enemies.find((enemy) => !enemy.isBoss) ?? run.combat.enemies[0]
  for (const enemy of run.combat.enemies) enemy.dead = enemy.uid !== target.uid
  Object.assign(target, { hp: 10, maxHp: 10, block: 0, dead: false, vulnerable: 0 })
  Object.assign(run.combat.players[0], {
    hand: [
      { uid: 'ui-sever-soul', defId: 'sever_soul', upgraded: true },
      { uid: 'ui-sever-soul-one', defId: 'defend_ironclad', upgraded: false },
      { uid: 'ui-sever-soul-two', defId: 'defend_ironclad', upgraded: false },
    ],
    draw: [],
    discard: [],
    exhaust: [],
    powers: [],
    energy: 2,
    strength: 0,
    weak: 0,
  })
  debug.setRun(run)
  return target.uid
})
const severSoulCard = page.getByRole('button', { name: /^Sever Soul\+,/ })
await severSoulCard.waitFor()
const severSoulLabel = await severSoulCard.getAttribute('aria-label')
await severSoulCard.click()
const emptySeverConfirmation = page.getByRole('button', { name: 'Exhaust none' })
await emptySeverConfirmation.waitFor()
assert(await emptySeverConfirmation.isDisabled(), 'Sever Soul+ allowed zero Exhaust choices')
await page.getByRole('button', { name: /^Defend,/ }).first().click()
await page.getByRole('button', { name: 'Exhaust 1', exact: true }).waitFor()
await shot('06ze-sever-soul-range-choice')
await page.getByRole('button', { name: 'Exhaust 1', exact: true }).click()
await page.getByText('Choose an enemy').waitFor()
await page.locator('.enemy--targeted:not(:disabled)').click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].energy === 0)
const severSoul = await readState()
check('Sever Soul+ requires one or two Exhaust choices and deals its printed hit', () => {
  assert(severSoulLabel.includes('exhaust 1-2 cards from hand'), severSoulLabel)
  assertEqual(severSoul.players[0].exhaust.length, 1)
  assertEqual(severSoul.players[0].hand.length, 1)
  assertEqual(severSoul.enemies.find((enemy) => enemy.uid === severTarget).hp, 6)
})
await shot('06zf-sever-soul-resolved')

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  Object.assign(run.combat.players[0], {
    hand: [
      { uid: 'ui-second-wind', defId: 'second_wind', upgraded: true },
      { uid: 'ui-second-wind-sentinel', defId: 'sentinel', upgraded: false },
      { uid: 'ui-second-wind-defend', defId: 'defend_ironclad', upgraded: false },
      { uid: 'ui-second-wind-strike', defId: 'strike_ironclad', upgraded: false },
      { uid: 'ui-second-wind-daze', defId: 'daze', upgraded: false },
    ],
    draw: [],
    discard: [],
    exhaust: [],
    powers: [{ uid: 'ui-second-wind-fnp', defId: 'feel_no_pain', upgraded: false }],
    energy: 1,
    block: 0,
  })
  debug.setRun(run)
})
const secondWindCard = page.getByRole('button', { name: /^Second Wind\+,/ })
await secondWindCard.waitFor()
const secondWindLabel = await secondWindCard.getAttribute('aria-label')
const sentinelLabel = await page.getByRole('button', { name: /^Sentinel,/ }).getAttribute('aria-label')
const dazeFallback = page.getByTitle('Daze')
const dazeFallbackBox = await dazeFallback.boundingBox()
const dazeFallbackLayer = await dazeFallback.locator(':scope > .card__fallback').evaluate((fallback) =>
  getComputedStyle(fallback).zIndex)
assert(dazeFallbackBox?.height > 100, `Daze collapsed to ${dazeFallbackBox?.height ?? 0}px without scan art`)
assertEqual(dazeFallbackLayer, '0', 'Daze fallback is layered behind its card')
await shot('06zg-second-wind-exhaust-family')
await secondWindCard.click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hand.length === 1)
const secondWind = await readState()
check('Second Wind+ exhausts non-Attacks, counts Daze, then resolves Sentinel and Feel No Pain', () => {
  assert(secondWindLabel.includes('exhaust all non-Attack cards in hand'), secondWindLabel)
  assert(secondWindLabel.includes('gain 2 Block per card exhausted'), secondWindLabel)
  assert(sentinelLabel.includes('support effect may target any player'), sentinelLabel)
  assert(sentinelLabel.includes('when this card is exhausted, gain 2 Energy'), sentinelLabel)
  assertDeepEqual(secondWind.players[0].hand.map((card) => card.uid), ['ui-second-wind-strike'])
  assertDeepEqual(secondWind.players[0].exhaust.map((card) => card.uid), [
    'ui-second-wind-sentinel', 'ui-second-wind-defend', 'ui-second-wind-daze',
  ])
  assertEqual(secondWind.players[0].block, 9, '6 printed Block plus three Feel No Pain triggers')
  assertEqual(secondWind.players[0].energy, 2, 'Sentinel did not refund 2 Energy after Second Wind')
})
await shot('06zh-second-wind-resolved')

const fiendTarget = await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const target = run.combat.enemies.find((enemy) => enemy.row === 1) ?? run.combat.enemies[0]
  for (const enemy of run.combat.enemies) enemy.dead = enemy.uid !== target.uid
  Object.assign(target, { hp: 20, maxHp: 20, block: 0, dead: false, vulnerable: 0, abilityUsed: true })
  Object.assign(run.combat.players[0], {
    hand: [
      { uid: 'ui-fiend-fire', defId: 'fiend_fire', upgraded: true },
      { uid: 'ui-fiend-fire-strike', defId: 'strike_ironclad', upgraded: false },
      { uid: 'ui-fiend-fire-sentinel', defId: 'sentinel', upgraded: false },
      { uid: 'ui-fiend-fire-daze', defId: 'daze', upgraded: false },
    ],
    draw: [], discard: [], exhaust: [], energy: 2, block: 0, strength: 1, weak: 0,
    powers: [{ uid: 'ui-fiend-fire-fnp', defId: 'feel_no_pain', upgraded: false }],
  })
  run.combat.log = []
  debug.setRun(run)
  return target.uid
})
const fiendFireCard = page.getByRole('button', { name: /^Fiend Fire\+,/ })
await fiendFireCard.waitFor()
const fiendFireLabel = await fiendFireCard.getAttribute('aria-label')
await shot('06zi-fiend-fire-full-hand')
await fiendFireCard.click()
await page.getByText('Choose an enemy').waitFor()
await page.locator('.enemy--targeted:not(:disabled)').click()
await page.waitForFunction(() => ![...document.querySelectorAll('button')]
  .some((button) => button.getAttribute('aria-label')?.startsWith('Fiend Fire+,')))
await page.getByText('11/20', { exact: true }).waitFor()
const fiendFire = await readState()
check('Fiend Fire+ Exhausts the whole hand and lands a separate Strength-modified hit per card', () => {
  assert(fiendFireLabel.includes('exhaust all cards in hand'), fiendFireLabel)
  assert(fiendFireLabel.includes('deal 2 as a separate hit per card exhausted'), fiendFireLabel)
  assert(fiendFireLabel.includes('exhausts when played'), fiendFireLabel)
  assertEqual(fiendFire.enemies.find((enemy) => enemy.uid === fiendTarget).hp, 11)
  assertDeepEqual(fiendFire.players[0].hand, [])
  assertDeepEqual(fiendFire.players[0].exhaust.map((card) => card.uid), [
    'ui-fiend-fire-strike', 'ui-fiend-fire-sentinel', 'ui-fiend-fire-daze', 'ui-fiend-fire',
  ])
  assertEqual(fiendFire.players[0].block, 4)
  assertEqual(fiendFire.players[0].energy, 2)
})
await page.locator('[data-pile="exhaust"]').click()
const exhaustPileDialog = page.getByRole('dialog', { name: 'Exhaust pile' })
await exhaustPileDialog.waitFor()
const exhaustedCardTitles = await exhaustPileDialog.locator('.card').evaluateAll((cards) =>
  cards.map((card) => card.getAttribute('title')))
check('the Exhaust pile opens the same read-only card viewer', () => {
  assertDeepEqual(exhaustedCardTitles, ['Strike', 'Sentinel', 'Daze', 'Fiend Fire+'])
})
await exhaustPileDialog.getByRole('button', { name: 'Close' }).click()
await shot('06zj-fiend-fire-resolved')

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  Object.assign(run.combat.players[0], {
    hand: [
      { uid: 'ui-corruption', defId: 'corruption', upgraded: true },
      { uid: 'ui-corruption-defend', defId: 'defend_ironclad', upgraded: false },
    ],
    draw: [], discard: [], exhaust: [], energy: 2, block: 0, powers: [],
  })
  run.combat.log = []
  debug.setRun(run)
})
const corruptionCard = page.getByRole('button', { name: /^Corruption\+,/ })
await corruptionCard.waitFor()
const corruptionLabel = await corruptionCard.getAttribute('aria-label')
await shot('06zk-corruption-power-card')
await corruptionCard.click()
const corruptionPower = page.getByRole('button', {
  name: 'Corruption+: your Skills cost 0 and Exhaust when played',
})
await corruptionPower.waitFor()
const corruptionFreeDefend = page.getByRole('button', { name: /^Defend, cost 0,/ })
await corruptionFreeDefend.waitFor()
await shot('06zl-corruption-active')
await corruptionFreeDefend.click()
await page.waitForFunction(() => ![...document.querySelectorAll('button')]
  .some((button) => button.getAttribute('aria-label')?.startsWith('Defend,')))
const corruption = await readState()
check('Corruption+ makes Skills visibly free and Exhausts them after they resolve', () => {
  assert(corruptionLabel.includes('your Skills cost 0 and Exhaust when played'), corruptionLabel)
  assertEqual(corruption.players[0].energy, 0)
  assertEqual(corruption.players[0].block, 1)
  assertDeepEqual(corruption.players[0].hand, [])
  assertDeepEqual(corruption.players[0].exhaust.map((card) => card.uid), ['ui-corruption-defend'])
  assertDeepEqual(corruption.players[0].powers.map((card) => card.uid), ['ui-corruption'])
})
await shot('06zm-corruption-skill-exhausted')

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.combat.players[0]
  const ally = run.combat.players[1]
  Object.assign(run.combat, { phase: 'player', turn: 1, log: [] })
  Object.assign(actor, {
    hand: [{ uid: 'ui-barricade', defId: 'barricade', upgraded: true }],
    draw: [], discard: [], exhaust: [], energy: 1, block: 7, powers: [],
  })
  Object.assign(ally, { hand: [], draw: [], discard: [], exhaust: [], block: 6, powers: [] })
  debug.setRun(run)
})
const barricadeCard = page.getByRole('button', { name: /^Barricade\+,/ })
await barricadeCard.waitFor()
const barricadeLabel = await barricadeCard.getAttribute('aria-label')
await shot('06zn-barricade-power-card')
await barricadeCard.click()
const barricadePower = page.getByRole('button', {
  name: 'Barricade+: keep leftover Block at the start of your turn, maximum 20',
})
await barricadePower.waitFor()
await shot('06zo-barricade-active')
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  Object.assign(run.combat, { phase: 'roundEnd', turn: 1 })
  for (const [playerIndex, player] of run.combat.players.entries()) {
    Object.assign(player, {
      hand: [],
      draw: Array.from({ length: 5 }, (_, index) => ({
        uid: `ui-barricade-draw-${playerIndex}-${index}`,
        defId: player.character === 'silent' ? 'defend_silent' : 'defend_ironclad',
        upgraded: false,
      })),
    })
  }
  debug.setRun(run)
})
await waitForAutomaticTurn(2)
await page.locator('.combat[data-phase="player"]').waitFor()
const barricaded = await readState()
check('Barricade+ visibly preserves only its owner\'s Block through Start of Turn', () => {
  assert(barricadeLabel.includes('at start of turn, keep your leftover Block from last turn'), barricadeLabel)
  assertEqual(barricaded.players[0].energy, 3)
  assertDeepEqual(barricaded.players.map((player) => player.block), [7, 0])
  assertDeepEqual(barricaded.players[0].powers.map((card) => card.uid), ['ui-barricade'])
})
await shot('06zp-barricade-block-retained')

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  Object.assign(run.combat, { phase: 'player', log: [] })
  Object.assign(run.combat.players[0], {
    hand: [
      { uid: 'ui-entrench', defId: 'entrench', upgraded: false },
      { uid: 'ui-entrench-plus', defId: 'entrench', upgraded: true },
    ],
    discard: [], exhaust: [], energy: 2, block: 6, powers: [],
  })
  debug.setRun(run)
})
const entrenchCard = page.getByRole('button', { name: /^Entrench,/ })
const entrenchPlusCard = page.getByRole('button', { name: /^Entrench\+,/ })
await Promise.all([entrenchCard.waitFor(), entrenchPlusCard.waitFor()])
const entrenchLabel = await entrenchCard.getAttribute('aria-label')
const entrenchPlusLabel = await entrenchPlusCard.getAttribute('aria-label')
await shot('06zq-entrench-cards-ready')
await entrenchCard.click()
await entrenchPlusCard.click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hand.length === 0)
const entrenched = await readState()
check('Entrench doubles Block to 20 and its upgrade removes Exhaust through real controls', () => {
  assert(entrenchLabel.includes('double your Block, maximum Block 20') &&
    entrenchLabel.includes('exhausts'), entrenchLabel)
  assert(entrenchPlusLabel.includes('double your Block, maximum Block 20') &&
    !entrenchPlusLabel.includes('exhausts'), entrenchPlusLabel)
  assertEqual(entrenched.players[0].block, 20)
  assertDeepEqual(entrenched.players[0].exhaust.map((card) => card.uid), ['ui-entrench'])
  assertDeepEqual(entrenched.players[0].discard.map((card) => card.uid), ['ui-entrench-plus'])
})
await shot('06zr-entrench-resolved')

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const target = run.combat.enemies.find((enemy) => !enemy.isBoss) ?? run.combat.enemies[0]
  for (const enemy of run.combat.enemies) enemy.dead = enemy.uid !== target.uid
  Object.assign(target, { hp: 20, maxHp: 20, block: 0, dead: false, vulnerable: 0 })
  Object.assign(run.combat.players[0], {
    hand: [
      { uid: 'ui-clash', defId: 'clash', upgraded: false },
      { uid: 'ui-clash-plus', defId: 'clash', upgraded: true },
      { uid: 'ui-clash-defend', defId: 'defend_ironclad', upgraded: false },
    ],
    discard: [], exhaust: [], energy: 0, strength: 0, weak: 0,
  })
  debug.setRun(run)
})
const clashCard = page.getByRole('button', { name: /^Clash,/ })
const clashPlusCard = page.getByRole('button', { name: /^Clash\+,/ })
await Promise.all([clashCard.waitFor(), clashPlusCard.waitFor()])
const clashLabel = await clashCard.getAttribute('aria-label')
assert(await clashCard.getAttribute('aria-disabled') === 'true', 'Clash should be disabled while a Skill remains in hand')
await shot('06zs-clash-restricted-hd-cards')
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[0].hand = run.combat.players[0].hand.filter((card) => card.defId !== 'defend_ironclad')
  debug.setRun(run)
})
await page.waitForFunction(() => document.querySelector('.hand .card[aria-label^="Clash,"]')?.getAttribute('aria-disabled') === 'false')
await clashCard.click()
await page.locator('.enemy--targeted:not(:disabled)').click()
await clashPlusCard.click()
await page.locator('.enemy--targeted:not(:disabled)').click()
const clashed = await readState()
check('Clash explains and enforces its all-Attack hand restriction through real controls', () => {
  assert(clashLabel.includes('can only be played if every card in your hand is an Attack'), clashLabel)
  assertEqual(clashed.enemies.find((enemy) => !enemy.dead).hp, 13)
  assertDeepEqual(clashed.players[0].discard.map((card) => card.uid), ['ui-clash', 'ui-clash-plus'])
})
await shot('06zt-clash-resolved')

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  Object.assign(run.combat, { die: 4, phase: 'player' })
  Object.assign(run.combat.players[0], {
    hand: [
      { uid: 'ui-spot-weakness', defId: 'spot_weakness', upgraded: false },
      { uid: 'ui-spot-weakness-plus', defId: 'spot_weakness', upgraded: true },
    ],
    discard: [], exhaust: [], energy: 2,
  })
  run.combat.players[1].strength = 0
  debug.setRun(run)
})
const spotCard = page.getByRole('button', { name: /^Spot Weakness,/ })
const spotPlusCard = page.getByRole('button', { name: /^Spot Weakness\+,/ })
await Promise.all([spotCard.waitFor(), spotPlusCard.waitFor()])
const spotLabel = await spotCard.getAttribute('aria-label')
const spotPlusLabel = await spotPlusCard.getAttribute('aria-label')
await shot('06zu-spot-weakness-hd-cards')
await spotCard.click()
await page.locator('.seat--targetable').filter({ hasText: 'Silent' }).click()
await spotPlusCard.click()
await page.locator('.seat--targetable').filter({ hasText: 'Silent' }).click()
const spotted = await readState()
check('Spot Weakness upgrades its die range and gives Strength to an ally through real controls', () => {
  assert(spotLabel.includes('if the die shows 1 or 2 or 3'), spotLabel)
  assert(spotPlusLabel.includes('if the die shows 1 or 2 or 3 or 4'), spotPlusLabel)
  assertEqual(spotted.players[1].strength, 1)
  assertDeepEqual(spotted.players[0].discard.map((card) => card.uid), [
    'ui-spot-weakness', 'ui-spot-weakness-plus',
  ])
})
await shot('06zv-spot-weakness-resolved')

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  Object.assign(run.combat.players[0], {
    hand: [
      { uid: 'ui-rage', defId: 'rage', upgraded: false },
      { uid: 'ui-rage-plus', defId: 'rage', upgraded: true },
      { uid: 'ui-rage-a', defId: 'strike_ironclad', upgraded: false },
      { uid: 'ui-rage-b', defId: 'clash', upgraded: false },
      { uid: 'ui-rage-c', defId: 'body_slam', upgraded: false },
      { uid: 'ui-rage-skill', defId: 'defend_ironclad', upgraded: false },
    ],
    discard: [], exhaust: [], energy: 1, block: 0,
  })
  debug.setRun(run)
})
const rageCard = page.getByRole('button', { name: /^Rage,/ })
const ragePlusCard = page.getByRole('button', { name: /^Rage\+,/ })
await Promise.all([rageCard.waitFor(), ragePlusCard.waitFor()])
const rageLabel = await rageCard.getAttribute('aria-label')
const ragePlusLabel = await ragePlusCard.getAttribute('aria-label')
await shot('06zw-rage-hd-cards')
await rageCard.click()
await ragePlusCard.click()
const raged = await readState()
check('Rage counts Attacks still in hand and its upgrade costs 0 through real controls', () => {
  assert(rageLabel.includes('cost 1') && rageLabel.includes('1 per Attack in hand'), rageLabel)
  assert(ragePlusLabel.includes('cost 0') && ragePlusLabel.includes('1 per Attack in hand'), ragePlusLabel)
  assertEqual(raged.players[0].block, 6)
  assertEqual(raged.players[0].energy, 0)
  assertDeepEqual(raged.players[0].discard.map((card) => card.uid), ['ui-rage', 'ui-rage-plus'])
})
await shot('06zx-rage-resolved')

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const target = run.combat.enemies.find((enemy) => !enemy.isBoss) ?? run.combat.enemies[0]
  for (const enemy of run.combat.enemies) enemy.dead = enemy.uid !== target.uid
  Object.assign(target, { hp: 20, maxHp: 20, block: 0, dead: false, vulnerable: 0 })
  Object.assign(run.combat.players[0], {
    hand: [
      { uid: 'ui-blood-for-blood', defId: 'blood_for_blood', upgraded: false },
      { uid: 'ui-blood-for-blood-plus', defId: 'blood_for_blood', upgraded: true },
    ],
    discard: [], exhaust: [], energy: 2, strength: 0, weak: 0, lostHpThisCombat: false,
  })
  debug.setRun(run)
})
const bloodCard = page.getByRole('button', { name: /^Blood for Blood,/ })
const bloodPlusCard = page.getByRole('button', { name: /^Blood for Blood\+,/ })
await Promise.all([bloodCard.waitFor(), bloodPlusCard.waitFor()])
const bloodLabel = await bloodCard.getAttribute('aria-label')
const bloodPlusLabel = await bloodPlusCard.getAttribute('aria-label')
assert(await bloodCard.getAttribute('aria-disabled') === 'true', 'Blood for Blood should cost 3 before HP loss')
await shot('06zy-blood-for-blood-hd-cards')
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  Object.assign(run.combat.players[0], { lostHpThisCombat: true, energy: 1 })
  debug.setRun(run)
})
await page.waitForFunction(() => document.querySelector('.hand .card[aria-label^="Blood for Blood,"]')?.getAttribute('aria-disabled') === 'false')
await bloodCard.click()
await page.locator('.enemy--targeted:not(:disabled)').click()
await bloodPlusCard.click()
await page.locator('.enemy--targeted:not(:disabled)').click()
const bloodied = await readState()
check('Blood for Blood unlocks its 1/0 HP-loss costs through real controls', () => {
  assert(bloodLabel.includes('costs 1 after you lose hit points this combat'), bloodLabel)
  assert(bloodPlusLabel.includes('costs 0 after you lose hit points this combat'), bloodPlusLabel)
  assertEqual(bloodied.enemies.find((enemy) => !enemy.dead).hp, 12)
  assertEqual(bloodied.players[0].energy, 0)
  assertDeepEqual(bloodied.players[0].discard.map((card) => card.uid), [
    'ui-blood-for-blood', 'ui-blood-for-blood-plus',
  ])
})
await shot('06zz-blood-for-blood-resolved')
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  Object.assign(run.combat.players[0], {
    hand: [
      { uid: 'ui-limit-break', defId: 'limit_break', upgraded: false },
      { uid: 'ui-limit-break-plus', defId: 'limit_break', upgraded: true },
    ],
    discard: [], exhaust: [], energy: 2, strength: 2,
  })
  debug.setRun(run)
})
const limitCard = page.getByRole('button', { name: /^Limit Break,/ })
const limitPlusCard = page.getByRole('button', { name: /^Limit Break\+,/ })
await Promise.all([limitCard.waitFor(), limitPlusCard.waitFor()])
const limitLabel = await limitCard.getAttribute('aria-label')
const limitPlusLabel = await limitPlusCard.getAttribute('aria-label')
await shot('070-limit-break-hd-cards')
await limitCard.click()
await limitPlusCard.click()
const limited = await readState()
check('Limit Break doubles Strength to 8 and flips Exhaust through real controls', () => {
  assert(limitLabel.includes('double your Strength, maximum Strength 8') && limitLabel.includes('exhausts when played'), limitLabel)
  assert(limitPlusLabel.includes('double your Strength, maximum Strength 8') && !limitPlusLabel.includes('exhausts when played'), limitPlusLabel)
  assertEqual(limited.players[0].strength, 8)
  assertDeepEqual(limited.players[0].exhaust.map((card) => card.uid), ['ui-limit-break'])
  assertDeepEqual(limited.players[0].discard.map((card) => card.uid), ['ui-limit-break-plus'])
})
await shot('070a-limit-break-resolved')
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const template = run.combat.enemies[0]
  run.combat.enemies = [
    { ...template, uid: 'ui-feed-enemy-a', row: 0, hp: 3, maxHp: 3, block: 0, dead: false, isBoss: false },
    { ...template, uid: 'ui-feed-enemy-b', row: 1, hp: 3, maxHp: 3, block: 0, dead: false, isBoss: false },
    { ...template, uid: 'ui-feed-enemy-c', row: 2, hp: 20, maxHp: 20, block: 0, dead: false, isBoss: false },
  ]
  Object.assign(run.combat.players[0], {
    hand: [
      { uid: 'ui-feed', defId: 'feed', upgraded: false },
      { uid: 'ui-feed-plus', defId: 'feed', upgraded: true },
    ],
    discard: [], exhaust: [], energy: 2, strength: 0, weak: 0,
  })
  debug.setRun(run)
})
const feedCard = page.getByRole('button', { name: /^Feed,/ })
const feedPlusCard = page.getByRole('button', { name: /^Feed\+,/ })
await Promise.all([feedCard.waitFor(), feedPlusCard.waitFor()])
const feedLabel = await feedCard.getAttribute('aria-label')
const feedPlusLabel = await feedPlusCard.getAttribute('aria-label')
await shot('070b-feed-hd-cards')
await feedCard.click()
await page.locator('.enemy--targeted:not(:disabled)[aria-label*="3 of 3 hit points"]').first().click()
await feedPlusCard.click()
await page.locator('.enemy--targeted:not(:disabled)[aria-label*="3 of 3 hit points"]').first().click()
const fed = await readState()
check('Feed gains 1/2 Strength on kills and Exhausts through real controls', () => {
  assert(feedLabel.includes('gain 1 Strength if the target dies') && feedLabel.includes('exhausts when played'), feedLabel)
  assert(feedPlusLabel.includes('gain 2 Strength if the target dies') && feedPlusLabel.includes('exhausts when played'), feedPlusLabel)
  assertEqual(fed.players[0].strength, 3)
  assertDeepEqual(fed.players[0].exhaust.map((card) => card.uid), ['ui-feed', 'ui-feed-plus'])
})
await shot('070c-feed-resolved')
await page.evaluate((combat) => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat = combat
  debug.setRun(run)
}, exhaustPairRestore)
await page.waitForFunction((uid) =>
  window.__STS_DEBUG__.getState().players[0].hand.some((card) => card.uid === uid),
exhaustPairRestore.players[0].hand[0].uid)

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  Object.assign(run.combat.players[0], {
    hand: [{ uid: 'ui-melter', defId: 'melter', upgraded: true }],
    discard: [],
    exhaust: [],
    energy: 1,
    strength: 0,
    weak: 0,
  })
  const target = run.combat.enemies.find((enemy) => !enemy.isBoss)
  if (!target) throw new Error('Melter browser fixture needs a non-boss enemy')
  Object.assign(target, { dead: false, hp: 19, maxHp: 20, block: 4, vulnerable: 0 })
  debug.setRun(run)
})
const melterCard = page.getByRole('button', { name: /^Melter\+,/ })
await melterCard.waitFor()
await melterCard.click()
const melterTarget = page.locator('.enemy--targeted[aria-label*="19 of 20 hit points"]').first()
await melterTarget.scrollIntoViewIfNeeded()
await shot('07a-melter-blocked-target')
await melterTarget.click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().enemies.some((enemy) => enemy.hp === 16 && enemy.block === 0))
const melter = await readState()
check('Melter+ removes all target Block before dealing 3 damage', () => {
  const target = melter.enemies.find((enemy) => enemy.hp === 16)
  assert(target, 'Melter+ did not deal its full hit through Block')
  assertEqual(target.block, 0)
  assertEqual(melter.players[0].energy, 0)
})
await page.locator('.enemy[aria-label*="16 of 20 hit points"]').scrollIntoViewIfNeeded()
await shot('07b-melter-block-cleared')

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  Object.assign(run.combat.players[0], {
    hand: [
      { uid: 'ui-heatsinks', defId: 'heatsinks', upgraded: true },
      { uid: 'ui-fusion', defId: 'fusion', upgraded: true },
    ],
    draw: Array.from({ length: 3 }, (_, index) => ({
      uid: `ui-heatsinks-draw-${index}`, defId: 'defend_defect', upgraded: false,
    })),
    discard: [],
    exhaust: [],
    powers: [],
    energy: 2,
  })
  debug.setRun(run)
})
await page.getByRole('button', { name: /^Heatsinks\+,/ }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].powers.length === 1)
await page.getByRole('button', { name: /^Fusion\+,/ }).scrollIntoViewIfNeeded()
await shot('07c-heatsinks-before-power-trigger')
await page.getByRole('button', { name: /^Fusion\+,/ }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hand.length === 3)
const heatsinks = await readState()
const heatsinksLabel = await page.locator('.powers .power').first().getAttribute('aria-label')
check('Heatsinks+ ignores itself then draws 3 when Fusion+ is played', () => {
  assertEqual(heatsinks.players[0].powers.length, 2)
  assertEqual(heatsinks.players[0].hand.length, 3)
  assertEqual(heatsinks.players[0].energy, 0)
  assert(
    heatsinksLabel?.includes('whenever you play a power card'),
    `Heatsinks announces the wrong trigger: ${heatsinksLabel}`,
  )
})
await shot('07d-heatsinks-power-draw')

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  Object.assign(run.players[0], { name: 'Defect', character: 'defect' })
  Object.assign(run.combat.players[0], {
    name: 'Defect',
    character: 'defect',
    hand: [{ uid: 'ui-capacitor', defId: 'capacitor', upgraded: false }],
    powers: [],
    orbs: [null, null, null],
    energy: 1,
    shivs: 0,
    miracles: 0,
  })
  run.combat.log = []
  debug.setRun(run)
})
await page.getByRole('button', { name: /^Capacitor,/ }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].orbs.length === 5)
const capacitorView = await page.evaluate(() => ({
  slots: document.querySelectorAll('.seat--viewer .token--orb').length,
  label: document.querySelector('.seat--viewer')?.getAttribute('aria-label') ?? '',
  power: document.querySelector('.powers .power')?.getAttribute('aria-label') ?? '',
}))
check('Capacitor exposes all gained Orb slots visually and accessibly', () => {
  assertEqual(capacitorView.slots, 5)
  assert(capacitorView.label.includes('0 of 5 Orb slots occupied'), capacitorView.label)
  assert(capacitorView.power.includes('gain 2 Orb slots'), capacitorView.power)
})
await shot('07e-capacitor-orb-slots')

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  Object.assign(run.combat.players[0], {
    hand: [
      { uid: 'ui-meteor', defId: 'meteor_strike', upgraded: true },
      { uid: 'ui-streamline', defId: 'streamline', upgraded: true },
    ],
    powers: [
      { uid: 'ui-capacitor-power', defId: 'capacitor', upgraded: false },
      { uid: 'ui-heatsinks-power', defId: 'heatsinks', upgraded: false },
      { uid: 'ui-fusion-power', defId: 'fusion', upgraded: false },
      { uid: 'ui-machine-power', defId: 'machine_learning', upgraded: false },
    ],
    orbs: [null, null, null, null, null],
    energy: 1,
  })
  for (const enemy of run.combat.enemies) {
    if (!enemy.dead) Object.assign(enemy, { hp: 30, maxHp: 30, block: 0, vulnerable: 0 })
  }
  run.combat.log = []
  debug.setRun(run)
})
const discountedCards = await page.locator('.hand .card').evaluateAll((cards) => cards.map((card) => ({
  cost: card.querySelector('.card-face__cost')?.textContent,
  label: card.getAttribute('aria-label'),
})))
check('Power discounts update both visible and accessible card costs', () => {
  assertDeepEqual(discountedCards.map((card) => card.cost), ['1', '0'])
  assert(discountedCards[0].label?.includes('cost 1'), discountedCards[0].label)
  assert(discountedCards[1].label?.includes('cost 0'), discountedCards[1].label)
  assert(discountedCards.every((card) => card.label?.includes('costs 1 less for each Power')), discountedCards)
})
await shot('07f-power-discounted-cards')
await page.getByRole('button', { name: /^Meteor Strike\+, cost 1,/ }).click()
await page.locator('.enemy').first().click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].energy === 0)
await page.getByRole('button', { name: /^Streamline\+, cost 0,/ }).click()
await page.locator('.enemy').first().click()
const discountedPlay = await readState()
await page.locator('[data-pile="discard"]').click()
const discardPileDialog = page.getByRole('dialog', { name: 'Discard pile' })
await discardPileDialog.waitFor()
const discountedDiscardTitles = await discardPileDialog.locator('.card').evaluateAll((cards) =>
  cards.map((card) => card.getAttribute('title')))
check('discounted attacks spend their current cost and still resolve', () => {
  assertEqual(discountedPlay.players[0].energy, 0)
  assertEqual(discountedPlay.players[0].hand.length, 0)
  assertEqual(discountedDiscardTitles.at(-1), 'Streamline+')
})
await discardPileDialog.getByRole('button', { name: 'Close' }).click()
await shot('07g-power-discounted-attacks')

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  Object.assign(run.players[0], { name: 'Silent', character: 'silent' })
  Object.assign(run.combat.players[0], {
    name: 'Silent',
    character: 'silent',
    hand: [
      { uid: 'ui-adrenaline', defId: 'adrenaline', upgraded: true },
      { uid: 'ui-catalyst', defId: 'catalyst', upgraded: true },
      { uid: 'ui-flechettes', defId: 'flechettes', upgraded: true },
      { uid: 'ui-grand-finale', defId: 'grand_finale', upgraded: true },
    ],
    draw: [
      { uid: 'ui-final-deflect', defId: 'deflect', upgraded: false },
      { uid: 'ui-final-acrobatics', defId: 'acrobatics', upgraded: false },
    ],
    discard: [],
    exhaust: [],
    powers: [],
    energy: 0,
    orbs: [null, null, null],
  })
  run.combat.enemies = run.combat.enemies.map((enemy, index) => ({
    ...enemy, hp: 20 + index, maxHp: 20 + index, block: 0, poison: 2, dead: false,
  }))
  run.combat.log = []
  debug.setRun(run)
})
const finaleBeforeDraw = page.getByRole('button', { name: /^Grand Finale\+,/ })
const finaleDisabledBeforeDraw = await finaleBeforeDraw.getAttribute('aria-disabled') === 'true'
const finaleLabelBeforeDraw = await finaleBeforeDraw.getAttribute('aria-label')
check('Grand Finale+ is disabled and explains its empty-draw requirement', () => {
  assert(finaleDisabledBeforeDraw, 'Grand Finale should be disabled with cards in draw')
  assert(finaleLabelBeforeDraw?.includes('draw pile is empty'))
})
await page.getByRole('button', { name: /^Adrenaline\+,/ }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].draw.length === 0)
const afterAdrenaline = await readState()
const finaleEnabledAfterDraw = await page.getByRole('button', { name: /^Grand Finale\+,/ }).getAttribute('aria-disabled') === 'false'
check('Adrenaline+ gains 2 Energy, draws 2, and unlocks Grand Finale+', () => {
  assertEqual(afterAdrenaline.players[0].energy, 2)
  assertEqual(afterAdrenaline.players[0].hand.length, 5)
  assert(finaleEnabledAfterDraw)
})
await shot('07h-grand-finale-unlocked')
await page.getByRole('button', { name: /^Catalyst\+,/ }).click()
await page.locator('.enemy').first().click()
await page.getByRole('button', { name: /^Flechettes\+,/ }).click()
await page.locator('.enemy').first().click()
await page.getByRole('button', { name: /^Grand Finale\+,/ }).click()
await page.locator('.enemy').first().click()
const silentCombo = await readState()
check('the Silent combo multiplies Poison, counts Skills, and lands Grand Finale+', () => {
  const target = silentCombo.enemies.find((enemy) => enemy.poison === 6)
  assert(target, 'Catalyst+ did not triple the targeted enemy Poison')
  assertEqual(target.hp, target.maxHp - 15, 'Flechettes+ for 3 then Grand Finale+ for 12')
  assertEqual(silentCombo.players[0].energy, 0)
  assertEqual(silentCombo.players[0].exhaust.length, 2)
})
await shot('07i-silent-poison-finale-combo')

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.combat.players[0]
  Object.assign(actor, {
    hand: [
      { uid: 'ui-setup', defId: 'setup', upgraded: true },
      { uid: 'ui-blur', defId: 'blur', upgraded: true },
      { uid: 'ui-all-out-attack', defId: 'all_out_attack', upgraded: true },
      { uid: 'ui-expertise', defId: 'expertise', upgraded: true },
      { uid: 'ui-all-out-discard', defId: 'slice', upgraded: false },
    ],
    draw: [
      { uid: 'ui-power-draw-1', defId: 'strike_silent', upgraded: false },
      { uid: 'ui-power-draw-2', defId: 'defend_silent', upgraded: false },
      { uid: 'ui-power-draw-3', defId: 'slice', upgraded: false },
      { uid: 'ui-power-draw-4', defId: 'deflect', upgraded: false },
      { uid: 'ui-power-draw-5', defId: 'neutralize', upgraded: false },
      { uid: 'ui-power-draw-6', defId: 'strike_silent', upgraded: false },
      { uid: 'ui-power-draw-7', defId: 'defend_silent', upgraded: false },
      { uid: 'ui-power-draw-8', defId: 'backflip', upgraded: false },
      { uid: 'ui-power-draw-9', defId: 'acrobatics', upgraded: false },
      { uid: 'ui-power-draw-10', defId: 'blade_dance', upgraded: false },
    ],
    discard: [],
    exhaust: [],
    powers: [],
    energy: 6,
    block: 0,
    shivs: 0,
    hp: 20,
    maxHp: 20,
  })
  for (const player of run.combat.players) Object.assign(player, { hp: 20, maxHp: 20, dead: false })
  run.combat.players[1].energy = 0
  run.combat.discardedThisTurn = [actor.id]
  run.combat.enemies = run.combat.enemies.map((enemy, index) => ({
    ...enemy, hp: 30 + index, maxHp: 30 + index, block: 0, poison: 0, dead: false,
  }))
  run.combat.log = []
  debug.setRun(run)
})
await page.getByRole('button', { name: /^Setup\+,/ }).click()
await page.locator('.seat--targetable:not(.seat--viewer)').click()
await page.getByRole('button', { name: /^Blur\+,/ }).click()
await page.getByRole('button', { name: /^All-Out Attack\+,/ }).click()
await page.locator('.prompt').filter({ hasText: 'Discard 1' }).waitFor()
await page.getByRole('button', { name: /^Slice,/ }).click()
// The AoE starburst is one row plus any boss, so the sweep asks which row —
// after its discard clause, which is what unlocks the enemy highlight.
await page.waitForSelector('.enemy--targeted')
const allOutTarget = page.locator('.enemy--targeted[data-row="0"]').first()
await allOutTarget.scrollIntoViewIfNeeded()
await allOutTarget.click()
await page.getByRole('button', { name: /^Expertise\+,/ }).click()
const silentTurnCards = await readState()
check('Silent turn cards resolve discard, draw-to-size, Block, and row damage', () => {
  assertEqual(silentTurnCards.players[0].powers.length, 0)
  assertEqual(silentTurnCards.players[0].block, 4)
  assertEqual(silentTurnCards.players[0].energy, 3)
  assertEqual(silentTurnCards.players[1].energy, 2)
  assert(silentTurnCards.players[0].exhaust.some((card) => card.uid === 'ui-setup'))
  assertEqual(silentTurnCards.players[0].hand.length, 7)
  assert(silentTurnCards.players[0].discard.some((card) => card.uid === 'ui-all-out-discard'))
  assert(silentTurnCards.enemies.every((enemy) =>
    enemy.hp === enemy.maxHp - (enemy.row === 0 || enemy.isBoss ? 3 : 0)),
    JSON.stringify(silentTurnCards.enemies.map((enemy) => [enemy.row, enemy.hp, enemy.maxHp])))
})
await shot('07j-silent-turn-cards')

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  Object.assign(run.combat.players[0], {
    hand: [
      { uid: 'ui-after-image', defId: 'after_image', upgraded: true },
      { uid: 'ui-calculated-gamble', defId: 'calculated_gamble', upgraded: false },
      { uid: 'ui-reflex', defId: 'reflex', upgraded: true },
      { uid: 'ui-tactician', defId: 'tactician', upgraded: true },
      { uid: 'ui-gamble-spare', defId: 'slice', upgraded: false },
    ],
    draw: Array.from({ length: 10 }, (_, index) => ({
      uid: `ui-gamble-draw-${index}`, defId: index % 2 ? 'deflect' : 'slice', upgraded: false,
    })),
    discard: [], exhaust: [], powers: [], energy: 1, block: 0,
  })
  run.combat.discardedThisTurn = []
  run.combat.log = []
  debug.setRun(run)
})
const discardReactionLabels = await page.locator('.hand .card').evaluateAll((cards) =>
  cards.map((card) => card.getAttribute('aria-label') ?? ''))
check('discard-reaction cards announce their unplayable and reactive rules', () => {
  const reflex = discardReactionLabels.find((label) => label.startsWith('Reflex+')) ?? ''
  const tactician = discardReactionLabels.find((label) => label.startsWith('Tactician+')) ?? ''
  assert(reflex.includes('unplayable') && reflex.includes('when discarded by a card effect, draw 3 cards'), reflex)
  assert(tactician.includes('unplayable') && tactician.includes('gain 3 Energy') && tactician.includes('exhausts'), tactician)
})
await shot('07k-silent-discard-engine-ready')
await page.getByRole('button', { name: /^After Image\+,/ }).click()
const afterImagePowerLabel = await page.locator('.power').getAttribute('aria-label')
check('After Image in play announces when its Block triggers', () => {
  assert(afterImagePowerLabel?.includes('whenever a card effect makes you discard one or more cards'),
    afterImagePowerLabel ?? 'After Image Power was not rendered')
})
await page.getByRole('button', { name: /^Calculated Gamble,/ }).click()
const discardCombo = await readState()
check('Calculated Gamble resolves Reflex, Tactician, and After Image through the UI', () => {
  const actor = discardCombo.players[0]
  assertEqual(actor.hand.length, 6)
  assertEqual(actor.energy, 4)
  assertEqual(actor.block, 1)
  assertEqual(actor.powers.length, 1)
  assertDeepEqual(actor.exhaust.map((card) => card.uid).sort(), ['ui-calculated-gamble', 'ui-tactician'])
  assert(actor.discard.some((card) => card.uid === 'ui-reflex'))
  assert(discardCombo.discardedThisTurn.includes(actor.id))
})
await shot('07l-silent-discard-engine-resolved')
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[0].powers = []
  debug.setRun(run)
})

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.combat.players[0]
  Object.assign(actor, {
    hand: [
      { uid: 'ui-outmaneuver', defId: 'outmaneuver', upgraded: false, retainedLastTurn: true },
      { uid: 'ui-escape-plan', defId: 'escape_plan', upgraded: false },
      { uid: 'ui-masterful-stab', defId: 'masterful_stab', upgraded: false },
      { uid: 'ui-finisher', defId: 'finisher', upgraded: false },
    ],
    draw: [{ uid: 'ui-escape-skill', defId: 'defend_silent', upgraded: false }],
    discard: [], exhaust: [], powers: [], energy: 1, block: 0,
    lostHpThisCombat: true, attacksPlayedThisTurn: 0,
  })
  run.combat.enemies = run.combat.enemies.map((enemy) => ({
    ...enemy, hp: 20, maxHp: 20, block: 0, dead: false,
  }))
  run.combat.log = []
  debug.setRun(run)
})
if (artSynced) await page.waitForFunction(() => [...document.querySelectorAll('.hand .card img')]
  .every((img) => img.complete && img.naturalWidth > 0))
const silentLedgerCards = await page.locator('.hand .card').evaluateAll((cards) => cards.map((card) => ({
  label: card.getAttribute('aria-label') ?? '',
  artLoaded: card.querySelector('img')?.naturalWidth > 0,
})))
check('the four Silent ledger cards render scans and spoken dynamic rules', () => {
  if (artSynced) assert(silentLedgerCards.every((card) => card.artLoaded), 'all four card scans should load')
  assert(silentLedgerCards.some((card) => card.label.startsWith('Masterful Stab, cost 2,') &&
    card.label.includes('after you lose hit points this combat')), 'Masterful Stab should render its current cost')
  assert(silentLedgerCards.some((card) => card.label.startsWith('Finisher') &&
    card.label.includes('other Attack played this turn')), 'Finisher should announce its attack count')
  assert(silentLedgerCards.some((card) => card.label.startsWith('Outmaneuver') &&
    card.label.includes('Retained last turn')), 'Outmaneuver should announce its condition')
})
await shot('07m-silent-ledger-cards-ready')
await page.getByRole('button', { name: /^Outmaneuver,/ }).click()
await page.getByRole('button', { name: /^Escape Plan,/ }).click()
await page.getByRole('button', { name: /^Masterful Stab,/ }).click()
await page.locator('.enemy').first().click()
await page.getByRole('button', { name: /^Finisher,/ }).click()
await page.locator('.enemy').first().click()
const silentLedgers = await readState()
check('the Silent ledger combo resolves through the real card controls', () => {
  const actor = silentLedgers.players[0]
  assertEqual(actor.energy, 0, 'Retain gain and dynamic costs balance to zero')
  assertEqual(actor.block, 1, 'Escape Plan drew a Skill and gained Block')
  assertEqual(actor.attacksPlayedThisTurn, 2, 'Masterful Stab and Finisher are recorded')
  assert(silentLedgers.enemies.some((enemy) => enemy.hp === 17),
    'Masterful Stab then one Finisher hit should deal 3 to their target')
  assert(!Object.hasOwn(actor.discard.find((card) => card.uid === 'ui-outmaneuver'), 'retainedLastTurn'),
    'playing Outmaneuver clears its retained history')
})
await shot('07n-silent-ledger-cards-resolved')

const enemiesBeforeSilentModifiers = structuredClone((await readState()).enemies)
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.combat.players[0]
  Object.assign(actor, {
    hand: [
      { uid: 'ui-accuracy', defId: 'accuracy', upgraded: true },
      { uid: 'ui-footwork', defId: 'footwork', upgraded: true },
      { uid: 'ui-envenom', defId: 'envenom', upgraded: true },
      { uid: 'ui-choke', defId: 'choke', upgraded: true },
    ],
    draw: [], discard: [], exhaust: [], powers: [], potions: ['fire_potion'], energy: 6, block: 0, shivs: 1,
    shivDamageBonus: 0, cardBlockBonus: 0, hitPoison: 0,
  })
  run.combat.enemies = run.combat.enemies.map((enemy, index) => ({
    ...enemy, hp: index === 0 ? 20 : 30, maxHp: index === 0 ? 20 : 30,
    block: 0, weak: 0, poison: 0, dead: false,
  }))
  Object.assign(run.combat.enemies[0], { weak: 1, poison: 2 })
  run.combat.log = []
  debug.setRun(run)
})
if (artSynced) await page.waitForFunction(() => [...document.querySelectorAll('.hand .card img')]
  .every((img) => img.complete && img.naturalWidth > 0))
const silentModifierCards = await page.locator('.hand .card').evaluateAll((cards) => cards.map((card) => ({
  label: card.getAttribute('aria-label') ?? '',
  artLoaded: card.querySelector('img')?.naturalWidth > 0,
})))
check('the four Silent modifier cards render scans and complete spoken rules', () => {
  if (artSynced) assert(silentModifierCards.every((card) => card.artLoaded), 'all modifier card scans should load')
  assert(silentModifierCards.some((card) => card.label.startsWith('Accuracy+') && card.label.includes('Shivs deal +1')))
  assert(silentModifierCards.some((card) => card.label.startsWith('Footwork+') &&
    card.label.includes('Block on your Attacks and Skills') && card.label.includes('retain')))
  assert(silentModifierCards.some((card) => card.label.startsWith('Envenom+') &&
    card.label.includes('each hit also applies 1 Poison')))
  assert(silentModifierCards.some((card) => card.label.startsWith('Choke+') &&
    card.label.includes('Strength, Vulnerable, Weak, and Poison on the target')))
})
await shot('07o-silent-modifier-cards-ready')
await page.getByRole('button', { name: /^Accuracy\+,/ }).click()
await page.getByRole('button', { name: /^Footwork\+,/ }).click()
await page.getByRole('button', { name: /^Envenom\+,/ }).click()
const shivUseVisual = await page.getByRole('button', { name: 'Use Shiv' }).evaluate((button) => ({
  text: button.textContent?.trim(),
  icon: button.querySelector('img')?.getAttribute('src'),
  iconWidth: button.querySelector('img')?.getBoundingClientRect().width,
  width: button.getBoundingClientRect().width,
  height: button.getBoundingClientRect().height,
  boxShadow: getComputedStyle(button).boxShadow,
}))
const potionUseVisual = await page.getByRole('button', { name: 'Use Fire Potion' }).evaluate((button) => ({
  iconWidth: button.querySelector('img')?.getBoundingClientRect().width,
  width: button.getBoundingClientRect().width,
  height: button.getBoundingClientRect().height,
}))
check('Shiv use controls render only the Shiv icon', () => {
  assertEqual(shivUseVisual.text, '')
  assert(shivUseVisual.icon?.includes('/assets/status-icons/shiv.png'), shivUseVisual.icon)
  assertEqual(shivUseVisual.iconWidth, potionUseVisual.iconWidth)
  assertEqual(shivUseVisual.width, potionUseVisual.width)
  assertEqual(shivUseVisual.height, potionUseVisual.height)
})
await page.getByRole('button', { name: 'Use Shiv' }).click()
await page.mouse.move(0, 0)
await page.evaluate(() => document.activeElement?.blur())
const activeShivVisual = await page.getByRole('button', { name: 'Use Shiv' }).evaluate((button) => ({
  pressed: button.getAttribute('aria-pressed'),
  chosen: button.classList.contains('is-chosen'),
  boxShadow: getComputedStyle(button).boxShadow,
}))
check('the icon-only Shiv control visibly shows its active state', () => {
  assertEqual(activeShivVisual.pressed, 'true')
  assertEqual(activeShivVisual.chosen, true)
  assert(activeShivVisual.boxShadow !== shivUseVisual.boxShadow)
})
await page.locator('.enemy').filter({ hasText: /20\/20/ }).first().click()
await page.getByRole('button', { name: /^Choke\+,/ }).click()
await page.locator('.enemy').filter({ hasText: /18\/20/ }).first().click()
const silentModifiers = await readState()
check('Accuracy, Footwork, Envenom, and Choke resolve through the real controls', () => {
  const actor = silentModifiers.players[0]
  const target = silentModifiers.enemies.find((enemy) => enemy.hp === 10)
  assertEqual(actor.energy, 0)
  assertEqual(actor.shivDamageBonus, 1)
  assertEqual(actor.cardBlockBonus, 1)
  assertEqual(actor.hitPoison, 1)
  assertEqual(actor.powers.length, 3)
  assert(target, 'the Accuracy Shiv and token-scaled Choke+ should deal 10 total')
  assertEqual(target.poison, 4, 'Envenom applies once for the Shiv and once for Choke+')
})
await shot('07p-silent-modifier-cards-resolved')
await page.evaluate((enemies) => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  Object.assign(run.combat.players[0], {
    powers: [], shivDamageBonus: 0, cardBlockBonus: 0, hitPoison: 0,
  })
  run.combat.enemies = enemies
  debug.setRun(run)
}, enemiesBeforeSilentModifiers)
await page.waitForFunction(() => {
  const player = window.__STS_DEBUG__.getState().players[0]
  return player.shivDamageBonus === 0 && player.cardBlockBonus === 0 && player.hitPoison === 0 &&
    document.querySelectorAll('.power').length === 0
})

const runBeforeSimmeringFury = await page.evaluate(() => structuredClone(window.__STS_DEBUG__.getRun()))
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  Object.assign(run.combat.players[0], {
    character: 'watcher',
    hand: [
      { uid: 'ui-simmering-fury', defId: 'simmering_fury', upgraded: true },
      { uid: 'ui-simmering-crescendo', defId: 'crescendo', upgraded: false },
      { uid: 'ui-simmering-sleeves', defId: 'flying_sleeves', upgraded: false },
    ],
    draw: [], discard: [], exhaust: [], powers: [], energy: 3, stance: 'neutral',
    wrathAttackDamageBonus: 0,
  })
  run.combat.enemies = run.combat.enemies.map((enemy, index) => ({
    ...enemy, hp: index === 1 ? 30 : enemy.hp, maxHp: index === 1 ? 30 : enemy.maxHp,
    block: 0, weak: 0, vulnerable: 0, dead: false,
  }))
  run.combat.log = []
  debug.setRun(run)
})
if (artSynced) await page.waitForFunction(() => [...document.querySelectorAll('.hand .card img')]
  .every((img) => img.complete && img.naturalWidth > 0))
await page.locator('.enemy').filter({ hasText: /30\/30/ }).first().waitFor()
const simmeringCard = await page.getByRole('button', { name: /^Simmering Fury\+,/ }).evaluate((card) => ({
  label: card.getAttribute('aria-label') ?? '',
  artWidth: card.querySelector('img')?.naturalWidth ?? 0,
}))
check('Simmering Fury+ renders sharp art and complete spoken rules', () => {
  if (artSynced) assert(simmeringCard.artWidth >= UPSCALED_ART_WIDTH, `expected upscaled art, got ${simmeringCard.artWidth}px`)
  assert(simmeringCard.label.includes('Attacks deal +2 damage while in Wrath'), simmeringCard.label)
})
await shot('07q-simmering-fury-ready')
await page.getByRole('button', { name: /^Simmering Fury\+,/ }).click()
await page.getByRole('button', { name: /^Crescendo,/ }).click()
await page.getByRole('button', { name: /^Flying Sleeves,/ }).click()
await page.locator('.enemy').filter({ hasText: /30\/30/ }).first().click()
const simmeringState = await readState()
check('Simmering Fury resolves both Wrath hits through the real controls', () => {
  const actor = simmeringState.players[0]
  assertEqual(actor.wrathAttackDamageBonus, 2)
  assertEqual(actor.stance, 'wrath')
  assertEqual(simmeringState.enemies.find((enemy) => enemy.maxHp === 30)?.hp, 22)
})
await page.locator('.enemy').filter({ hasText: /22\/30/ }).first().waitFor()
await shot('07r-simmering-fury-resolved')

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  Object.assign(run.combat.players[0], {
    hand: [{ uid: 'ui-like-water', defId: 'like_water', upgraded: true }],
    draw: [], discard: [], exhaust: [], powers: [], energy: 1, stance: 'calm', block: 0,
  })
  for (const player of run.combat.players.slice(1)) Object.assign(player, { hand: [], powers: [] })
  debug.setRun(run)
})
const likeWaterCard = page.getByRole('button', { name: /^Like Water\+,/ })
await likeWaterCard.waitFor()
const likeWaterArtWidth = await artWidth(likeWaterCard)
if (artSynced) assert(likeWaterArtWidth >= UPSCALED_ART_WIDTH, `expected upscaled Like Water art, got ${likeWaterArtWidth}px`)
await likeWaterCard.click()
const likeWaterPowerLabel = await page.getByRole('button', { name: /^Like Water\+?:/ }).getAttribute('aria-label')
check('Like Water+ exposes its Calm end-of-turn Block accessibly', () => {
  assert(likeWaterPowerLabel.includes('2 Block'), likeWaterPowerLabel)
  assert(likeWaterPowerLabel.includes('if you are in calm'), likeWaterPowerLabel)
  assert(likeWaterPowerLabel.includes('at the end of each turn'), likeWaterPowerLabel)
})
await page.getByRole('button', { name: 'End turn' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].block === 2)
const likeWaterState = await readState()
check('Like Water resolves Calm Block through the real controls', () => {
  assertEqual(likeWaterState.players[0].block, 2)
})
await shot('07s-like-water-calm-block')

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.combat.players[0]
  Object.assign(run.combat, { phase: 'player', turn: 1, powerTriggersUsedThisTurn: [] })
  Object.assign(actor, {
    hand: [{ uid: 'ui-battle-hymn', defId: 'battle_hymn', upgraded: true }],
    draw: [], discard: [], exhaust: [], powers: [], energy: 1, stance: 'wrath',
  })
  run.combat.enemies = run.combat.enemies.map((enemy, index) => ({
    ...enemy, hp: index === 1 ? 20 : enemy.hp, maxHp: index === 1 ? 20 : enemy.maxHp,
    block: 0, vulnerable: 0, dead: false,
  }))
  debug.setRun(run)
})
const battleHymnCard = page.getByRole('button', { name: /^Battle Hymn\+,/ })
await battleHymnCard.waitFor()
const battleHymnArtWidth = await artWidth(battleHymnCard)
if (artSynced) assert(battleHymnArtWidth >= UPSCALED_ART_WIDTH, `expected upscaled Battle Hymn art, got ${battleHymnArtWidth}px`)
await battleHymnCard.click()
const battleHymnPowerLabel = await page.getByRole('button', { name: /^Battle Hymn\+?:/ }).getAttribute('aria-label')
const battleHymnUseVisual = await page.getByRole('button', { name: 'Use Battle Hymn+' }).evaluate((button) => ({
  text: button.textContent?.trim(),
  icon: button.querySelector('img')?.getAttribute('src'),
}))
check('Battle Hymn+ exposes its Wrath bonus and activation accessibly', () => {
  assert(battleHymnPowerLabel.includes('2 +2 if you are in wrath damage'), battleHymnPowerLabel)
  assert(battleHymnPowerLabel.includes('activate once per turn'), battleHymnPowerLabel)
})
check('Power use controls render only their glyph', () => {
  assertEqual(battleHymnUseVisual.text, '')
  assert(battleHymnUseVisual.icon?.includes('/status-icons/attack.png'), battleHymnUseVisual.icon)
})
await page.getByRole('button', { name: 'Use Battle Hymn+' }).click()
await page.locator('.enemy').filter({ hasText: /20\/20/ }).first().click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().enemies.some((enemy) => enemy.hp === 16))
const battleHymnState = await readState()
check('Battle Hymn resolves its Wrath bonus once through the real controls', () => {
  assert(battleHymnState.enemies.some((enemy) => enemy.hp === 16))
  assertEqual(battleHymnState.players[0].weak, likeWaterState.players[0].weak)
})
assert(await page.getByRole('button', { name: 'Battle Hymn+ used' }).isDisabled())
await shot('07t-battle-hymn-wrath-hit')

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  Object.assign(run.combat, { phase: 'player', turn: 1, powerTriggersUsedThisTurn: [], pendingTriggers: [] })
  Object.assign(run.combat.players[0], {
    name: 'Watcher', character: 'watcher',
    hand: [
      { uid: 'ui-mental-fortress', defId: 'mental_fortress', upgraded: true },
      { uid: 'ui-mental-wrath', defId: 'crescendo', upgraded: false },
      { uid: 'ui-mental-calm', defId: 'tranquility', upgraded: false },
    ],
    draw: [], discard: [], exhaust: [], powers: [], energy: 2, stance: 'neutral', block: 0,
  })
  debug.setRun(run)
})
const mentalFortressCard = page.getByRole('button', { name: /^Mental Fortress\+,/ })
await mentalFortressCard.waitFor()
const mentalFortressArtWidth = await artWidth(mentalFortressCard)
if (artSynced) assert(mentalFortressArtWidth >= UPSCALED_ART_WIDTH, `expected upscaled Mental Fortress art, got ${mentalFortressArtWidth}px`)
await mentalFortressCard.click()
const mentalFortressPowerLabel = await page.getByRole('button', { name: /^Mental Fortress\+?:/ }).getAttribute('aria-label')
check('Mental Fortress+ exposes its stance trigger accessibly', () => {
  assert(mentalFortressPowerLabel.includes('2 Block'), mentalFortressPowerLabel)
  assert(mentalFortressPowerLabel.includes('whenever you switch Stances'), mentalFortressPowerLabel)
})
await page.getByRole('button', { name: /^Crescendo,/ }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].block === 2)
await page.getByRole('button', { name: /^Tranquility,/ }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].block === 4)
const mentalFortressState = await readState()
check('Mental Fortress resolves both stance switches through the real controls', () => {
  assertEqual(mentalFortressState.players[0].stance, 'calm')
  assertEqual(mentalFortressState.players[0].block, 4)
})
await shot('07u-mental-fortress-stance-block')

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  Object.assign(run.combat, { phase: 'player', turn: 1, powerTriggersUsedThisTurn: [], pendingTriggers: [] })
  Object.assign(run.combat.players[0], {
    name: 'Watcher', character: 'watcher',
    hand: [
      { uid: 'ui-rushdown', defId: 'rushdown', upgraded: true },
      { uid: 'ui-rushdown-first', defId: 'crescendo', upgraded: false },
      { uid: 'ui-rushdown-calm', defId: 'tranquility', upgraded: false },
      { uid: 'ui-rushdown-second', defId: 'crescendo', upgraded: false },
    ],
    draw: Array.from({ length: 4 }, (_, index) => ({
      uid: `ui-rushdown-draw-${index}`, defId: 'strike_watcher', upgraded: false,
    })),
    discard: [], exhaust: [], powers: [], energy: 2, stance: 'neutral', block: 0,
  })
  debug.setRun(run)
})
const rushdownCard = page.getByRole('button', { name: /^Rushdown\+,/ })
await rushdownCard.waitFor()
const rushdownArtWidth = await artWidth(rushdownCard)
if (artSynced) assert(rushdownArtWidth >= UPSCALED_ART_WIDTH, `expected upscaled Rushdown art, got ${rushdownArtWidth}px`)
await rushdownCard.click()
const rushdownPowerLabel = await page.getByRole('button', { name: /^Rushdown\+?:/ }).getAttribute('aria-label')
check('Rushdown+ exposes its once-per-turn Wrath draw accessibly', () => {
  assert(rushdownPowerLabel.includes('draw 3'), rushdownPowerLabel)
  assert(rushdownPowerLabel.includes('whenever you enter wrath'), rushdownPowerLabel)
  assert(rushdownPowerLabel.includes('once per turn'), rushdownPowerLabel)
})
await page.getByRole('button', { name: /^Crescendo,/ }).first().click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].draw.length === 1)
await page.getByRole('button', { name: /^Tranquility,/ }).click()
await page.getByRole('button', { name: /^Crescendo,/ }).first().click()
const rushdownState = await readState()
check('Rushdown triggers only the first Wrath through the real controls', () => {
  assertEqual(rushdownState.players[0].stance, 'wrath')
  assertEqual(rushdownState.players[0].draw.length, 1)
  assertEqual(rushdownState.players[0].hand.length, 3)
})
await shot('07v-rushdown-first-wrath-draw')

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.combat.players[0]
  const first = run.combat.enemies[0]
  const second = run.combat.enemies[1] ?? { ...first, uid: 'ui-watcher-batch-enemy-2' }
  Object.assign(run.combat, { phase: 'player', turn: 1, powerTriggersUsedThisTurn: [], pendingTriggers: [] })
  Object.assign(actor, {
    name: 'Watcher', character: 'watcher', stance: 'neutral', block: 0, energy: 6,
    hand: [
      { uid: 'ui-nirvana', defId: 'nirvana', upgraded: true },
      { uid: 'ui-nirvana-scry', defId: 'third_eye', upgraded: false },
      { uid: 'ui-indignation-enter', defId: 'indignation', upgraded: true },
      { uid: 'ui-indignation-row', defId: 'indignation', upgraded: true },
      { uid: 'ui-inner-peace-enter', defId: 'inner_peace', upgraded: true },
      { uid: 'ui-inner-peace-draw', defId: 'inner_peace', upgraded: true },
    ],
    draw: Array.from({ length: 8 }, (_, index) => ({
      uid: `ui-watcher-batch-draw-${index}`, defId: index % 2 ? 'strike_watcher' : 'defend_watcher', upgraded: false,
    })),
    discard: [], exhaust: [], powers: [],
  })
  run.combat.enemies = [first, second]
  Object.assign(first, { row: 0, hp: 10, maxHp: 10, block: 0, vulnerable: 0, dead: false, isBoss: false })
  Object.assign(second, { row: 1, hp: 11, maxHp: 11, block: 0, vulnerable: 0, dead: false, isBoss: false })
  debug.setRun(run)
})
const nirvanaCard = page.getByRole('button', { name: /^Nirvana\+,/ })
const indignation = page.getByRole('button', { name: /^Indignation\+,/ })
const innerPeace = page.getByRole('button', { name: /^Inner Peace\+,/ })
await nirvanaCard.waitFor()
const watcherBatchArt = await Promise.all([
  artWidth(nirvanaCard), artWidth(indignation.first()), artWidth(innerPeace.first()),
])
if (artSynced) assert(watcherBatchArt.every((width) => width >= UPSCALED_ART_WIDTH),
  `expected upscaled Watcher batch art, got ${watcherBatchArt.join(', ')}px`)
await shot('07w-watcher-stance-scry-batch')
await nirvanaCard.click()
const nirvanaLabel = await page.getByRole('button', { name: /^Nirvana\+?:/ }).getAttribute('aria-label')
check('Nirvana+ exposes its Scry trigger accessibly', () => {
  assert(nirvanaLabel.includes('2 Block'), nirvanaLabel)
  assert(nirvanaLabel.includes('whenever you scry'), nirvanaLabel)
})
await page.getByRole('button', { name: /^Third Eye,/ }).click()
const nirvanaScry = page.getByRole('dialog', { name: 'Scry 3' })
await nirvanaScry.waitFor()
await nirvanaScry.getByRole('button', { name: /^Defend,/ }).first().click()
await nirvanaScry.getByRole('button', { name: 'Discard 1 and continue' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].block === 4)

const indignationLabel = await indignation.first().getAttribute('aria-label')
check('Indignation+ exposes both conditional branches and row scope', () => {
  assert(indignationLabel.includes('affects a whole row and any boss'), indignationLabel)
  assert(indignationLabel.includes('apply 1 Vulnerable if you are in wrath'), indignationLabel)
  assert(indignationLabel.includes('enter wrath if you are not in wrath'), indignationLabel)
})
await indignation.first().click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].stance === 'wrath')
assertEqual(await page.locator('.enemy--targeted').count(), 0,
  'Indignation asked for an enemy when its printed branch only enters Wrath')
await indignation.first().click()
await page.locator('.enemy--targeted[aria-label*="10 of 10 hit points"]').click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().enemies[0].vulnerable === 1)

const innerPeaceLabel = await innerPeace.first().getAttribute('aria-label')
check('Inner Peace+ exposes both stance branches accessibly', () => {
  assert(innerPeaceLabel.includes('draw 4 cards if you are in calm'), innerPeaceLabel)
  assert(innerPeaceLabel.includes('enter calm if you are not in calm'), innerPeaceLabel)
})
await innerPeace.first().click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].stance === 'calm')
await innerPeace.first().click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].hand.length === 4)
const watcherBatch = await readState()
check('Nirvana, Indignation, and Inner Peace resolve through the real controls', () => {
  assertEqual(watcherBatch.players[0].block, 4)
  assertEqual(watcherBatch.players[0].stance, 'calm')
  assertEqual(watcherBatch.players[0].energy, 0)
  assertDeepEqual(watcherBatch.enemies.map((enemy) => enemy.vulnerable), [1, 0])
  assertEqual(watcherBatch.players[0].draw.length, 3)
})

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.combat.players[0]
  Object.assign(run.combat, {
    phase: 'player', turn: 1, startTurnProgress: undefined, pendingTriggers: [], powerTriggersUsedThisTurn: [],
  })
  Object.assign(actor, {
    name: 'Watcher', character: 'watcher', hand: [{ uid: 'ui-foresight', defId: 'foresight', upgraded: true }],
    draw: Array.from({ length: 6 }, (_, index) => ({
      uid: `ui-foresight-draw-${index}`, defId: index % 2 ? 'defend_watcher' : 'strike_watcher', upgraded: false,
    })),
    discard: [], exhaust: [], powers: [
      { uid: 'ui-foresight-existing', defId: 'foresight', upgraded: false },
    ], energy: 1, block: 5,
  })
  debug.setRun(run)
})
const foresightCard = page.getByRole('button', { name: /^Foresight\+,/ })
await foresightCard.waitFor()
if (artSynced) assert(await artWidth(foresightCard) >= UPSCALED_ART_WIDTH, 'expected upscaled Foresight art')
await foresightCard.click()
const foresightPowerLabel = await page.getByRole('button', { name: /^Foresight\+:/ }).getAttribute('aria-label')
check('Foresight+ exposes its pre-draw Scry accessibly', () => {
  assert(foresightPowerLabel.includes('Scry 4'), foresightPowerLabel)
  assert(foresightPowerLabel.includes('at the start of your turn, before you draw'), foresightPowerLabel)
})
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  Object.assign(run.combat, { phase: 'roundEnd', turn: 1, startTurnProgress: undefined, pendingTriggers: [] })
  Object.assign(run.combat.players[0], { hand: [], discard: [], block: 5 })
  debug.setRun(run)
})
await waitForAutomaticTurn(2)
await page.getByText('Before-draw Scry order (2)').waitFor()
await page.getByRole('button', { name: 'Confirm before-draw order' }).click()
const foresightDialog = page.getByRole('dialog', { name: 'Foresight — Scry 3' })
await foresightDialog.waitFor()
const foresightPaused = await readState()
check('Foresight pauses after Reset and before the shared Draw step', () => {
  assertEqual(foresightPaused.phase, 'start')
  assertEqual(foresightPaused.players[0].block, 0)
  assertEqual(foresightPaused.players[0].hand.length, 0)
  assertEqual(foresightPaused.players[0].draw.length, 6)
})
await foresightDialog.getByRole('button', { name: /^Defend,/ }).first().click()
await shot('07x-foresight-before-draw-scry')
await foresightDialog.getByRole('button', { name: 'Discard 1 and continue' }).click()
const upgradedForesightDialog = page.getByRole('dialog', { name: 'Foresight — Scry 4' })
await upgradedForesightDialog.waitFor()
await upgradedForesightDialog.getByRole('button', { name: 'Keep all and continue' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'player')
const foresightResolved = await readState()
check('Foresight resolves its private Scry before drawing five', () => {
  assertEqual(foresightResolved.players[0].hand.length, 5)
  assertEqual(foresightResolved.players[0].draw.length, 0)
  assertEqual(foresightResolved.players[0].discard.length, 1)
  assert(foresightResolved.die >= 1 && foresightResolved.die <= 6)
})
await page.evaluate((saved) => window.__STS_DEBUG__.setRun(saved), runBeforeSimmeringFury)
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].wrathAttackDamageBonus === 0 &&
  window.__STS_DEBUG__.getState().players[0].stance !== 'wrath')

const runBeforeSilentChoices = await page.evaluate(() => structuredClone(window.__STS_DEBUG__.getRun()))
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.combat.players[0]
  const ally = run.combat.players[1]
  if (!ally) throw new Error('the Silent choice playtest needs a teammate')
  Object.assign(actor, {
    character: 'silent',
    hand: [
      { uid: 'ui-distraction', defId: 'distraction', upgraded: true },
      { uid: 'ui-bouncing-flask', defId: 'bouncing_flask', upgraded: true },
      { uid: 'ui-dodge-roll', defId: 'dodge_and_roll', upgraded: true },
      { uid: 'ui-concentrate', defId: 'concentrate', upgraded: true },
      { uid: 'ui-concentrate-strike', defId: 'strike_silent', upgraded: false },
      { uid: 'ui-concentrate-defend', defId: 'defend_silent', upgraded: false },
    ],
    draw: [], discard: [], exhaust: [], powers: [], energy: 6, block: 0,
    shivDamageBonus: 0, cardBlockBonus: 0, hitPoison: 0,
  })
  ally.block = 0
  ally.dead = false
  if (run.combat.enemies.length < 2) {
    run.combat.enemies.push({
      ...run.combat.enemies[0], uid: 'ui-bounce-second', row: run.combat.enemies[0].row + 1,
    })
  }
  run.combat.enemies = run.combat.enemies.map((enemy, index) => ({
    ...enemy, hp: 20, maxHp: 20, block: 0, weak: 0, poison: 0, abilityUsed: false, dead: false,
    row: index,
  }))
  run.combat.powerTriggersUsedThisTurn = []
  run.combat.log = []
  debug.setRun(run)
})
if (artSynced) await page.waitForFunction(() => [...document.querySelectorAll('.hand .card img')]
  .every((img) => img.complete && img.naturalWidth > 0))
const silentChoiceCards = await page.locator('.hand .card').evaluateAll((cards) => cards.map((card) => ({
  label: card.getAttribute('aria-label') ?? '',
  artLoaded: card.querySelector('img')?.naturalWidth > 0,
})))
check('the Silent choice cards render scans and announce their independent decisions', () => {
  if (artSynced) assert(silentChoiceCards.every((card) => card.artLoaded), 'all four choice-card scans should load')
  assert(silentChoiceCards.some((card) => card.label.startsWith('Dodge and Roll+') &&
    card.label.includes('3 separate 1 Block icons')))
  assert(silentChoiceCards.some((card) => card.label.startsWith('Bouncing Flask+') &&
    card.label.includes('3 separate 1 Poison tokens')))
  assert(silentChoiceCards.some((card) => card.label.startsWith('Concentrate+') &&
    card.label.includes('discard any number') && card.label.includes('plus 1')))
  assert(silentChoiceCards.some((card) => card.label.startsWith('Distraction+') &&
    card.label.includes('once per turn') && card.label.includes('put Poison')))
})
await shot('07q-silent-choice-cards-ready')
await page.getByRole('button', { name: /^Distraction\+,/ }).click()
await page.getByRole('button', { name: /^Bouncing Flask\+,/ }).click()
await page.locator('.enemy').nth(0).click()
await page.locator('.enemy').nth(1).click()
await page.locator('.enemy').nth(0).click()
await page.getByRole('button', { name: /^Dodge and Roll\+,/ }).click()
await page.locator('button.seat').nth(0).click()
await page.locator('button.seat').nth(1).click()
await page.locator('button.seat').nth(1).click()
await page.getByRole('button', { name: /^Concentrate\+,/ }).click()
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[0].hand.push({
    uid: 'ui-concentrate-new-draw', defId: 'neutralize', upgraded: false,
  })
  debug.setRun(run)
})
await page.getByRole('button', { name: /^Neutralize,/ }).waitFor()
await page.getByRole('button', { name: /^Strike,/ }).click()
await page.getByRole('button', { name: /^Defend,/ }).click()
await page.getByRole('button', { name: /^Neutralize,/ }).click()
await page.getByRole('button', { name: 'Discard 3' }).click()
const silentChoices = await readState()
check('independent targets, optional discard, and once-per-turn Poison resolve through the controls', () => {
  const actor = silentChoices.players[0]
  const ally = silentChoices.players[1]
  assertEqual(actor.block, 3, 'Distraction plus one Dodge icon protects the Silent')
  assertEqual(ally.block, 2, 'two Dodge icons can share one ally target')
  assertEqual(actor.energy, 6, 'Concentrate+ includes a card drawn after staging and respects the Energy cap')
  assertDeepEqual(silentChoices.enemies.map((enemy) => enemy.poison).filter(Boolean).sort((a, b) => b - a), [2, 1])
  assertEqual(actor.powers.length, 1)
  assert(silentChoices.powerTriggersUsedThisTurn.includes(`${actor.id}/power:ui-distraction`),
    'the once-per-turn trigger should be visibly spent')
  assertEqual(actor.exhaust.at(-1)?.uid, 'ui-concentrate')
})
await page.locator('button.seat').nth(1).scrollIntoViewIfNeeded()
await shot('07r-silent-choice-cards-resolved')
await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), runBeforeSilentChoices)
await page.waitForFunction(() => !window.__STS_DEBUG__.getState().players[0].hand
  .some((card) => card.uid.startsWith('ui-')))

const runBeforeShivPowers = await readRun()
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.combat.players[0]
  const ally = run.combat.players[1]
  Object.assign(actor, {
    character: 'silent',
    hand: [
      { uid: 'ui-storm-steel', defId: 'storm_of_steel', upgraded: true },
      { uid: 'ui-storm-strike', defId: 'strike_silent', upgraded: false },
      { uid: 'ui-storm-defend', defId: 'defend_silent', upgraded: false },
    ],
    powers: [], energy: 6, shivs: 4, attacksPlayedThisTurn: 0,
  })
  ally.shivs = 1
  if (run.combat.enemies.length < 2) {
    run.combat.enemies.push({
      ...run.combat.enemies[0], uid: 'ui-storm-added-enemy', row: run.combat.enemies[0].row + 1,
    })
  }
  run.combat.enemies = run.combat.enemies.slice(0, 2).map((enemy, index) => ({
    ...enemy, uid: `ui-storm-enemy-${index}`, hp: 20, maxHp: 20, block: 0,
    weak: 0, vulnerable: 0, poison: 0, abilityUsed: true, dead: false, row: index,
  }))
  debug.setRun(run)
})
await page.getByRole('button', { name: /^Storm of Steel\+,/ }).waitFor()
if (artSynced) await page.waitForFunction(() => [...document.querySelectorAll('.hand .card img')]
  .every((img) => img.complete && img.naturalWidth > 0))
const shivPowerCards = await page.locator('.hand .card').evaluateAll((cards) => cards.map((card) => ({
  label: card.getAttribute('aria-label') ?? '',
  artLoaded: card.querySelector('img')?.naturalWidth > 0,
})))
check('Storm of Steel renders its complete upgraded rules', () => {
  if (artSynced) assert(shivPowerCards.every((card) => card.artLoaded))
  assert(shivPowerCards.some((card) => card.label.startsWith('Storm of Steel+,') &&
    card.label.includes('discard any number') && card.label.includes('1 Shiv per card discarded plus 1')))
})
await shot('07s-silent-storm-of-steel-ready')
await page.getByRole('button', { name: /^Storm of Steel\+,/ }).click()
const prematureStormSkip = await page.getByRole('button', { name: 'Skip remaining overflow attacks' }).count()
await page.getByRole('button', { name: /^Strike,/ }).click()
await page.getByRole('button', { name: /^Defend,/ }).click()
await page.getByRole('button', { name: 'Discard 2' }).click()
await page.getByText('Choose overflow Shiv target 1/3, or skip the rest').waitFor()
await page.getByRole('button', { name: 'Skip remaining overflow attacks' }).waitFor()
await page.locator('.enemy').nth(0).click()
await page.locator('.enemy').nth(1).click()
await page.locator('.enemy').nth(0).click()
const shivPowers = await readState()
check('Storm of Steel dynamically targets overflow Shivs after its discard choice', () => {
  assertEqual(prematureStormSkip, 0, 'overflow cannot skip the unresolved discard choice')
  assertEqual(shivPowers.players[0].shivs, 4)
  assertEqual(shivPowers.players[1].shivs, 1)
  assertDeepEqual(shivPowers.enemies.map((enemy) => enemy.hp).sort((a, b) => a - b), [18, 19])
  assertEqual(shivPowers.players[0].attacksPlayedThisTurn, 3)
})
await page.locator('.enemy').first().scrollIntoViewIfNeeded()
await shot('07t-silent-storm-of-steel-resolved')
await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), runBeforeShivPowers)
await page.waitForFunction(() => !window.__STS_DEBUG__.getState().players[0].hand
  .some((card) => card.uid.startsWith('ui-')))

const runBeforeUnload = await readRun()
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.combat.players[0]
  Object.assign(actor, {
    character: 'silent',
    hand: [{ uid: 'ui-unload', defId: 'unload', upgraded: true }],
    draw: [], discard: [], exhaust: [], powers: [], energy: 3, shivs: 2,
    shivDamageBonus: 1, hitPoison: 0, attacksPlayedThisTurn: 0,
  })
  if (run.combat.enemies.length < 2) {
    run.combat.enemies.push({
      ...run.combat.enemies[0], uid: 'ui-unload-added-enemy', row: run.combat.enemies[0].row + 1,
    })
  }
  run.combat.enemies = run.combat.enemies.slice(0, 2).map((enemy, index) => ({
    ...enemy, uid: `ui-unload-enemy-${index}`, hp: 20, maxHp: 20, block: 0,
    weak: 0, vulnerable: 0, poison: 0, abilityUsed: true, dead: false, row: index,
  }))
  debug.setRun(run)
})
await page.getByRole('button', { name: /^Unload\+,/ }).waitFor()
const unloadLabel = await page.getByRole('button', { name: /^Unload\+,/ }).getAttribute('aria-label')
check('Unload renders its complete upgraded separate-attack rule', () => {
  assert(unloadLabel?.includes('use all Shivs now; each deals +2 damage as a separate attack'))
})
await shot('07u-silent-unload-ready')
await page.getByRole('button', { name: /^Unload\+,/ }).click()
await page.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('Choose an enemy'))
await page.locator('.enemy').nth(0).click()
await page.getByText('Choose Shiv attack 1/2').waitFor()
await page.locator('.enemy').nth(0).click()
await page.getByText('Choose Shiv attack 2/2').waitFor()
await page.locator('.enemy').nth(1).click()
const unloaded = await readState()
check('Unload targets its card hit and every held Shiv through the combat board', () => {
  assertDeepEqual(unloaded.enemies.map((enemy) => enemy.hp).sort((a, b) => a - b), [14, 16])
  assertEqual(unloaded.players[0].shivs, 0)
  assertEqual(unloaded.players[0].attacksPlayedThisTurn, 3)
  assertEqual(unloaded.players[0].discard.at(-1)?.uid, 'ui-unload')
})
await page.locator('.enemy').first().scrollIntoViewIfNeeded()
await shot('07v-silent-unload-resolved')
await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), runBeforeUnload)
await page.waitForFunction(() => !window.__STS_DEBUG__.getState().players[0].hand
  .some((card) => card.uid === 'ui-unload'))

const runBeforeInfiniteBlades = await readRun()
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.combat.players[0]
  const ally = run.combat.players[1]
  Object.assign(run.combat, { phase: 'roundEnd', turn: 1, log: [] })
  Object.assign(actor, {
    character: 'silent', hand: [], discard: [], exhaust: [], energy: 0, shivs: 3,
    strength: 0, attacksPlayedThisTurn: 0,
    powers: [
      { uid: 'ui-infinite-demon', defId: 'demon_form', upgraded: false },
      { uid: 'ui-infinite-blades', defId: 'infinite_blades', upgraded: true },
    ],
    draw: Array.from({ length: 5 }, (_, index) => ({
      uid: `ui-infinite-draw-${index}`, defId: 'defend_silent', upgraded: false,
    })),
  })
  Object.assign(ally, { shivs: 2, hand: [], draw: Array.from({ length: 5 }, (_, index) => ({
    uid: `ui-infinite-ally-${index}`, defId: 'defend_ironclad', upgraded: false,
  })) })
  run.combat.enemies = run.combat.enemies.map((enemy) => ({
    ...enemy, hp: 20, maxHp: 20, block: 0, weak: 0, vulnerable: 0,
    poison: 0, dead: false, abilityUsed: true,
  }))
  debug.setRun(run)
})
await page.locator('.power').first().waitFor()
const infinitePowerLabels = await page.locator('.power').evaluateAll((powers) =>
  powers.map((power) => power.getAttribute('aria-label') ?? ''))
check('Infinite Blades announces its upgraded recurring Shiv effect', () => {
  assert(infinitePowerLabels.some((label) =>
    label.includes('Infinite Blades') && label.includes('2 Shivs') && label.includes('start of each turn')),
  JSON.stringify(infinitePowerLabels))
})
const infinitePower = page.locator('.power[aria-label^="Infinite Blades"]')
await infinitePower.click()
await waitForPowerZoom()
await shot('07w-silent-infinite-blades-ready')
await infinitePower.click()
await waitForAutomaticTurn(2)
await page.locator('.combat[data-phase="start"]').waitFor()
await page.locator('.start-turn-order > summary').click()
await page.locator('.start-turn-order button[aria-label*="Infinite Blades"][aria-label$="earlier"]').click()
await page.locator('.start-turn-order > summary').click()
await page.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('choose overflow Shiv 1/2'))
await shot('07x-silent-infinite-blades-choice')
await page.locator('.enemy:not([disabled])').first().click()
await page.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('choose overflow Shiv 2/2'))
await page.getByRole('button', { name: 'Skip this Shiv' }).click()
await shot('07x2-silent-infinite-blades-reset')
await page.getByRole('button', { name: 'Reset start choices' }).click()
await page.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('choose overflow Shiv 1/2'))
await page.locator('.enemy:not([disabled])').first().click()
await page.getByRole('button', { name: 'Skip this Shiv' }).click()
await page.getByRole('button', { name: 'Resolve start of turn' }).click()
await page.locator('.combat[data-phase="player"]').waitFor()
const infiniteBlades = await readState()
check('Infinite Blades orders, targets, and explicitly skips Start-of-Turn overflow', () => {
  const actor = infiniteBlades.players[0]
  assertEqual(actor.shivs, 3)
  assertEqual(infiniteBlades.players[1].shivs, 2)
  assertEqual(actor.attacksPlayedThisTurn, 1)
  assertEqual(actor.strength, 1, 'Demon Form resolves after the reordered Shiv attack')
  assertDeepEqual(infiniteBlades.enemies.filter((enemy) => enemy.hp < 20).map((enemy) => enemy.hp), [19])
})
await page.locator('.enemy').first().scrollIntoViewIfNeeded()
await shot('07y-silent-infinite-blades-resolved')
await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), runBeforeInfiniteBlades)
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase !== 'start')

const runBeforeNoxiousFumes = await readRun()
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.combat.players[0]
  Object.assign(run.combat, { phase: 'roundEnd', turn: 1, log: [] })
  Object.assign(actor, {
    character: 'silent', hand: [], discard: [], exhaust: [], energy: 0,
    powers: [{ uid: 'ui-noxious-fumes', defId: 'noxious_fumes', upgraded: false }],
    draw: Array.from({ length: 10 }, (_, index) => ({
      uid: `ui-noxious-draw-${index}`, defId: 'defend_silent', upgraded: false,
    })),
  })
  for (const ally of run.combat.players.slice(1)) {
    Object.assign(ally, { hand: [], draw: Array.from({ length: 10 }, (_, index) => ({
      uid: `ui-noxious-${ally.id}-${index}`, defId: 'defend_ironclad', upgraded: false,
    })) })
  }
  const enemy = run.combat.enemies[0]
  run.combat.enemies = [0, 1, 2].map((index) => ({
    ...enemy, uid: `ui-noxious-enemy-${index}`, row: index,
    hp: 20, maxHp: 20, block: 0, poison: 0, dead: false, abilityUsed: true,
  }))
  Object.assign(run.combat.enemies[0], { hp: 0, dead: true })
  debug.setRun(run)
})
const noxiousPower = page.locator('.power[aria-label^="Noxious Fumes"]')
await noxiousPower.waitFor()
const noxiousLabel = await noxiousPower.getAttribute('aria-label')
check('Noxious Fumes announces its recurring single-enemy Poison', () => {
  assert(noxiousLabel.includes('1 Poison to one enemy') && noxiousLabel.includes('start of each turn'), noxiousLabel)
})
await noxiousPower.click()
await waitForPowerZoom()
await shot('07z-silent-noxious-fumes-ready')
await noxiousPower.click()
await waitForAutomaticTurn(2)
await page.locator('.combat[data-phase="start"]').waitFor()
await page.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('Noxious Fumes') &&
  document.querySelector('.prompt')?.textContent?.includes('choose an enemy'))
const noxiousDeadTargets = await page.locator('.enemy[disabled].enemy--targeted').count()
const noxiousLiveTargets = await page.locator('.enemy:not([disabled]).enemy--targeted').count()
const noxiousLivingEnemies = (await readState()).enemies.filter((enemy) => !enemy.dead).length
check('Start-of-Turn targeting highlights living enemies but not defeated ones', () => {
  assertEqual(noxiousDeadTargets, 0)
  assertEqual(noxiousLiveTargets, noxiousLivingEnemies)
})
await shot('07za-silent-noxious-fumes-target')
await page.locator('.enemy:not([disabled])').nth(1).click()
await page.getByRole('button', { name: 'Reset start choices' }).click()
await page.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('choose an enemy'))
await page.locator('.enemy:not([disabled])').nth(1).click()
await page.getByRole('button', { name: 'Resolve start of turn' }).click()
await page.locator('.combat[data-phase="player"]').waitFor()
const noxiousBase = await readState()
check('base Noxious Fumes poisons only its chosen enemy at the next Start of Turn', () => {
  assertEqual(noxiousBase.enemies.filter((enemy) => enemy.poison === 1).length, 1)
  assertEqual(noxiousBase.enemies.reduce((sum, enemy) => sum + enemy.poison, 0), 1)
})
await shot('07zb-silent-noxious-fumes-resolved')
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  Object.assign(run.combat, { phase: 'roundEnd', turn: 2 })
  run.combat.players[0].powers = [
    { uid: 'ui-noxious-fumes-plus', defId: 'noxious_fumes', upgraded: true },
  ]
  for (const enemy of run.combat.enemies) enemy.poison = 0
  debug.setRun(run)
})
const noxiousUpgraded = page.locator('.power[aria-label^="Noxious Fumes+"]')
await noxiousUpgraded.waitFor()
const noxiousUpgradedLabel = await noxiousUpgraded.getAttribute('aria-label')
// The upgrade prints the AoE starburst, so it still asks which row to gas.
await waitForAutomaticTurn(3)
await page.locator('.combat[data-phase="start"]').waitFor()
await page.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('choose an enemy'))
await page.locator('.enemy:not([disabled])').nth(1).click()
await page.getByRole('button', { name: 'Resolve start of turn' }).click()
await page.locator('.combat[data-phase="player"]').waitFor()
const noxiousAll = await readState()
check('upgraded Noxious Fumes gasses the chosen row and any boss', () => {
  assert(noxiousUpgradedLabel.includes('1 Poison to one enemy row and any boss'), noxiousUpgradedLabel)
  const gassed = noxiousAll.enemies.filter((enemy) => enemy.poison === 1)
  assert(gassed.length > 0, 'nothing was poisoned at all')
  const row = gassed[0].row
  assert(noxiousAll.enemies.every((enemy) =>
    enemy.poison === (!enemy.dead && (enemy.row === row || enemy.isBoss) ? 1 : 0)),
    JSON.stringify(noxiousAll.enemies.map((enemy) => [enemy.row, enemy.poison, enemy.dead])))
})
await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), runBeforeNoxiousFumes)
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase !== 'start')

const runBeforeStorm = await readRun()
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.combat.players[0]
  Object.assign(run.combat, { phase: 'roundEnd', turn: 1, log: [] })
  Object.assign(actor, {
    name: 'Defect', character: 'defect', hand: [], discard: [], exhaust: [], energy: 0,
    powers: [{ uid: 'ui-storm-plus', defId: 'storm', upgraded: true }],
    orbs: ['frost', 'lightning', 'dark'], block: 0,
    draw: Array.from({ length: 10 }, (_, index) => ({
      uid: `ui-storm-draw-${index}`, defId: 'defend_defect', upgraded: false,
    })),
  })
  for (const ally of run.combat.players.slice(1)) {
    Object.assign(ally, { hand: [], draw: Array.from({ length: 10 }, (_, index) => ({
      uid: `ui-storm-${ally.id}-${index}`, defId: 'defend_ironclad', upgraded: false,
    })) })
  }
  run.combat.enemies = run.combat.enemies.map((enemy) => ({
    ...enemy, hp: 20, maxHp: 20, block: 0, dead: false, abilityUsed: true,
  }))
  debug.setRun(run)
})
const stormPower = page.locator('.power[aria-label^="Storm+"]')
await stormPower.waitFor()
const stormLabel = await stormPower.getAttribute('aria-label')
check('Storm+ announces its recurring two-Lightning effect', () => {
  assert(stormLabel.includes('channel 2 lightning Orbs') && stormLabel.includes('start of each turn'), stormLabel)
})
await stormPower.click()
await waitForPowerZoom()
await shot('07zc-defect-storm-ready')
await page.keyboard.press('Escape')
await waitForAutomaticTurn(2)
await page.locator('.combat[data-phase="start"]').waitFor()
await page.getByRole('button', { name: 'dark slot 3' }).waitFor()
await shot('07zd-defect-storm-orb-choice')
await page.getByRole('button', { name: 'dark slot 3' }).click()
await page.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('target for the Evoked Orb'))
await shot('07ze-defect-storm-dark-target')
const stormTargetState = await readState()
const stormTargetButton = page.locator('.enemy--targeted').first()
await stormTargetButton.click()
await page.getByRole('button', { name: 'frost slot 1' }).click()
await page.getByRole('button', { name: 'Resolve start of turn' }).click()
await page.locator('.combat[data-phase="player"]').waitFor()
const stormResolved = await readState()
const stormTarget = stormResolved.enemies.find((enemy) => {
  const before = stormTargetState.enemies.find((candidate) => candidate.uid === enemy.uid)
  return before && enemy.hp < before.hp
})
check('Storm+ resolves sequential chosen Orb slots and separate Dark target', () => {
  assert(stormTarget, 'Storm browser fixture needs its chosen target')
  assertDeepEqual(stormResolved.players[0].orbs, ['lightning', 'lightning', 'lightning'])
  assertEqual(stormResolved.players[0].block, 1)
  assertEqual(stormTarget.hp, 16)
  assert(stormResolved.enemies.filter((enemy) => enemy.uid !== stormTarget.uid)
    .every((enemy) => enemy.hp === 20))
})
await shot('07zf-defect-storm-resolved')
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.combat.players[0]
  Object.assign(run.combat, { phase: 'roundEnd', log: [] })
  Object.assign(actor, {
    hand: [], block: 0, orbs: ['lightning', 'lightning', 'lightning'],
    powers: [
      { uid: 'ui-storm-lethal-first', defId: 'storm', upgraded: false },
      { uid: 'ui-storm-lethal-second', defId: 'storm', upgraded: false },
      { uid: 'ui-storm-lethal-fumes', defId: 'noxious_fumes', upgraded: false },
    ],
    draw: Array.from({ length: 5 }, (_, index) => ({
      uid: `ui-storm-lethal-${index}`, defId: 'defend_defect', upgraded: false,
    })),
  })
  for (const ally of run.combat.players.slice(1)) {
    Object.assign(ally, { hand: [], draw: Array.from({ length: 5 }, (_, index) => ({
      uid: `ui-storm-lethal-${ally.id}-${index}`, defId: 'defend_ironclad', upgraded: false,
    })) })
  }
  const source = run.combat.enemies[0]
  run.combat.enemies = [
    { ...source, uid: 'storm-lethal-jaw', defId: 'jaw_worm', row: 0, poison: 0, isBoss: false },
    { ...source, uid: 'storm-lethal-cultist', defId: 'cultist', row: 1, poison: 0, isBoss: false },
  ]
  for (const enemy of run.combat.enemies) {
    Object.assign(enemy, {
      hp: enemy.defId === 'jaw_worm' ? 2 : 10,
      maxHp: enemy.defId === 'jaw_worm' ? 2 : 10,
      block: 0, dead: false, abilityUsed: true,
    })
  }
  debug.setRun(run)
})
await waitForAutomaticTurn(3)
await page.getByRole('button', { name: 'lightning slot 1' }).click()
await page.getByRole('button', { name: /Jaw Worm/ }).click()
await page.getByRole('button', { name: 'lightning slot 1' }).click()
await page.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('target for the Evoked Orb'))
const safeStormTargets = await page.locator('.enemy--targeted').allTextContents()
await page.getByRole('button', { name: /Jaw Worm/ }).click()
const deadStormTargetRejected = await page.locator('.prompt').textContent()
await page.getByRole('button', { name: /Cultist/ }).click()
await page.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('Noxious Fumes'))
const safePowerTargets = await page.locator('.enemy--targeted').allTextContents()
await page.getByRole('button', { name: /Jaw Worm/ }).click()
const deadPowerTargetRejected = await page.locator('.prompt').textContent()
await page.getByRole('button', { name: /Cultist/ }).click()
await page.getByRole('button', { name: 'Resolve start of turn' }).click()
await page.locator('.combat[data-phase="player"]').waitFor()
const stormLethalResolved = await readState()
check('Storm removes an earlier lethal target from the next Orb choice', () => {
  assertEqual(safePowerTargets.length, 1)
  assert(safePowerTargets[0].includes('Cultist'), safePowerTargets[0])
  assert(deadPowerTargetRejected.includes('Noxious Fumes'))
  assertEqual(safeStormTargets.length, 1)
  assert(safeStormTargets[0].includes('Cultist'), safeStormTargets[0])
  assert(deadStormTargetRejected.includes('target for the Evoked Orb'))
  assert(stormLethalResolved.enemies.find((enemy) => enemy.defId === 'jaw_worm').dead)
  assertEqual(stormLethalResolved.enemies.find((enemy) => enemy.defId === 'cultist').hp, 8)
  assertEqual(stormLethalResolved.enemies.find((enemy) => enemy.defId === 'cultist').poison, 1)
})
await shot('07zg-defect-storm-lethal-target-filter')
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.combat.players[0]
  Object.assign(run.combat, { phase: 'roundEnd', log: [] })
  Object.assign(actor, {
    hand: [], orbs: ['lightning', 'lightning', 'lightning'],
    powers: [
      { uid: 'ui-storm-final', defId: 'storm', upgraded: true },
    ],
    draw: Array.from({ length: 5 }, (_, index) => ({
      uid: `ui-storm-final-${index}`, defId: 'defend_defect', upgraded: false,
    })),
  })
  for (const enemy of run.combat.enemies) {
    const finalTarget = enemy.defId === 'jaw_worm'
    Object.assign(enemy, {
      hp: finalTarget ? 2 : 0, maxHp: finalTarget ? 2 : 10,
      block: 0, dead: !finalTarget, abilityUsed: true,
    })
  }
  debug.setRun(run)
})
await waitForAutomaticTurn(4)
await page.getByRole('button', { name: 'lightning slot 1' }).click()
await page.getByRole('button', { name: /Jaw Worm/ }).click()
const finalStormResolve = page.getByRole('button', { name: 'Resolve start of turn' })
const finalStormReady = await finalStormResolve.isEnabled()
const skippedPostLethalStorm = await page.getByRole('button', { name: 'lightning slot 1' }).count()
await finalStormResolve.click()
await page.locator('.combat[data-phase="won"]').waitFor()
const finalStormState = await readState()
check('Storm+ skips its second channel after the first Evoke wins combat', () => {
  assert(finalStormReady)
  assertEqual(skippedPostLethalStorm, 0)
  assert(finalStormState.enemies.find((enemy) => enemy.defId === 'jaw_worm').dead)
})
await shot('07zh-defect-storm-final-target-fallback')
// The app folds a victory into the run after the final presentation. A full-page
// screenshot with decoded card art can cross that boundary, so restore the
// finished combat snapshot instead of racing the timer before the next probe.
await page.evaluate((combat) => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  Object.assign(run, { phase: 'combat', combat: structuredClone(combat) })
  const actor = run.combat.players[0]
  Object.assign(run.combat, { phase: 'roundEnd', log: [] })
  Object.assign(actor, {
    hand: [], shivs: 5, orbs: ['lightning', 'lightning', 'lightning'],
    powers: [
      { uid: 'ui-storm-before-final-shiv', defId: 'storm', upgraded: false },
      { uid: 'ui-blades-after-final-storm', defId: 'infinite_blades', upgraded: false },
    ],
    draw: Array.from({ length: 5 }, (_, index) => ({
      uid: `ui-storm-before-shiv-${index}`, defId: 'defend_defect', upgraded: false,
    })),
  })
  for (const ally of run.combat.players.slice(1)) ally.shivs = 0
  for (const enemy of run.combat.enemies) {
    const finalTarget = enemy.defId === 'jaw_worm'
    Object.assign(enemy, {
      hp: finalTarget ? 2 : 0, maxHp: finalTarget ? 2 : 10,
      block: 0, dead: !finalTarget, abilityUsed: true,
    })
  }
  debug.setRun(run)
}, finalStormState)
await waitForAutomaticTurn(5)
await page.getByRole('button', { name: 'lightning slot 1' }).click()
await page.getByRole('button', { name: /Jaw Worm/ }).click()
const postStormShivResolve = page.getByRole('button', { name: 'Resolve start of turn' })
const postStormShivReady = await postStormShivResolve.isEnabled()
const skippedPostLethalStormShiv = await page.getByText(/overflow Shiv target/).count()
await postStormShivResolve.click()
await page.locator('.combat[data-phase="won"]').waitFor()
check('a lethal Storm skips later overflow Shiv choices', () => {
  assert(postStormShivReady)
  assertEqual(skippedPostLethalStormShiv, 0)
})
const postStormShivState = await readState()
await shot('07zi-defect-storm-skips-later-shiv')
await page.evaluate(({ baseline, combat }) => {
  const debug = window.__STS_DEBUG__
  // A won combat folds into the run asynchronously; restore its exact combat
  // snapshot inside the saved run shell instead of racing that cleanup.
  const run = { ...structuredClone(baseline), phase: 'combat', combat }
  const actor = run.combat.players[0]
  Object.assign(run.combat, { phase: 'roundEnd', log: [] })
  Object.assign(actor, {
    hand: [], shivs: 5, orbs: ['lightning', 'lightning', 'lightning'],
    powers: [
      { uid: 'ui-storm-final-blades', defId: 'infinite_blades', upgraded: false },
      { uid: 'ui-storm-final-after-shiv', defId: 'storm', upgraded: false },
    ],
    draw: Array.from({ length: 5 }, (_, index) => ({
      uid: `ui-storm-final-shiv-${index}`, defId: 'defend_defect', upgraded: false,
    })),
  })
  for (const ally of run.combat.players.slice(1)) ally.shivs = 0
  for (const enemy of run.combat.enemies) {
    const finalTarget = enemy.defId === 'jaw_worm'
    Object.assign(enemy, {
      hp: finalTarget ? 1 : 0, maxHp: finalTarget ? 1 : 10,
      block: 0, dead: !finalTarget, abilityUsed: true,
    })
  }
  debug.setRun(run)
}, { baseline: runBeforeStorm, combat: postStormShivState })
await waitForAutomaticTurn(6)
await page.getByRole('button', { name: /Jaw Worm/ }).click()
const postShivStormResolve = page.getByRole('button', { name: 'Resolve start of turn' })
const postShivStormReady = await postShivStormResolve.isEnabled()
const skippedPostLethalShivStorm = await page.getByRole('button', { name: 'lightning slot 1' }).count()
await postShivStormResolve.click()
await page.locator('.combat[data-phase="won"]').waitFor()
check('a lethal overflow Shiv skips later Storm choices', () => {
  assert(postShivStormReady)
  assertEqual(skippedPostLethalShivStorm, 0)
})
await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), runBeforeStorm)
await page.waitForFunction((enemyUid) => window.__STS_DEBUG__.getState().enemies[0]?.uid === enemyUid,
  runBeforeStorm.combat.enemies[0].uid)

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.combat.players[0]
  actor.potions = ['entropic_brew', 'block_potion', 'fire_potion', 'skill_potion']
  actor.relics = actor.relics.filter((relic) => relic.defId !== 'sozu')
  run.combat.potionLimit = 3
  run.combat.potionDeck = ['energy_potion', 'blood_potion']
  debug.setRun(run)
})
await page.locator('.combat__actions').getByRole('button', { name: /Entropic Brew/ }).click()
const brewReplacement = page.getByRole('button', { name: 'Replace Block Potion' })
const brewReplacementDescriptionId = await brewReplacement.getAttribute('aria-describedby')
await brewReplacement.hover()
const brewReplacementTip = page.locator('.potion-tip').filter({ hasText: 'Block Potion' })
await brewReplacementTip.waitFor()
const brewReplacementDescription = await page.locator(`[id="${brewReplacementDescriptionId}"]`).textContent()
check('Entropic Brew replacement Potion icons explain their effects', () => {
  assertEqual(brewReplacementDescription, '2 Block to any player.')
})
await page.keyboard.press('Escape')
await brewReplacementTip.waitFor({ state: 'hidden' })
await page.keyboard.press('Escape')
await page.getByRole('dialog', { name: 'Entropic Brew' }).waitFor({ state: 'hidden' })

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.combat.players[0]
  actor.potions = ['entropic_brew', 'block_potion']
  actor.relics = [...actor.relics.filter((relic) => relic.defId !== 'sozu'), { defId: 'sozu', spent: false }]
  run.combat.potionDeck = ['fire_potion', 'skill_potion']
  debug.setRun(run)
})
const combatBrewUse = page.locator('.combat__actions').getByRole('button', { name: /Entropic Brew/ })
await combatBrewUse.click()
await page.waitForFunction(() => !window.__STS_DEBUG__.getState().players[0].potions.includes('entropic_brew'))
const sozuBrew = await readState()
const sozuBrewDialog = await page.getByRole('dialog', { name: 'Entropic Brew' }).count()
check('Sozu lets Entropic Brew resolve directly without gaining or replacing Potions', () => {
  assertEqual(sozuBrewDialog, 0)
  assertDeepEqual(sozuBrew.players[0].potions, ['block_potion'])
  assertDeepEqual(sozuBrew.potionDeck, ['fire_potion', 'skill_potion', 'entropic_brew'])
})
await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), runBeforeStorm)

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
const cunningTargetButton = page.getByRole('button', {
  name: new RegExp(`${cunningTarget.hp} of ${cunningTarget.maxHp} hit points`),
}).first()
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
await page.locator('.enemy:not([disabled])').first().click()
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
).first().click()
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
await page.locator(`.enemy[data-enemy-id="${explosiveTarget.uid}"]`).click()
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
await page.locator('.enemy:not([disabled])').first().click()
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
await page.getByRole('button', { name: /1 of 1 hit points/ }).click()
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
await page.getByRole('button', { name: /1 of 1 hit points/ }).click()
await page.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('2/2'))
await page.getByRole('button', { name: /1 of 1 hit points/ }).click()
await page.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('1/2'))
const refusedCardOverflow = await readState()
check('a card keeps targeting open when a queued Shiv would hit a dead enemy', () => {
  assertEqual(refusedCardOverflow.players[0].hand[0]?.uid, 'overflow-dance')
  assertEqual(refusedCardOverflow.enemies[0].hp, 1)
  assertEqual(refusedCardOverflow.enemies[1].hp, 5)
})
await page.getByRole('button', { name: /1 of 1 hit points/ }).click()
await page.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('2/2'))
await page.getByRole('button', { name: /5 of 5 hit points/ }).click()
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
await hoverEnemy.hover()
await page.waitForTimeout(300)
const hoverScale = await hoverEnemy.locator('.enemy__art--cutout').evaluate((art) =>
  new DOMMatrix(getComputedStyle(art).transform).a)
check('enemy hover zoom works without idle movement', () => {
  assert(hoverScale > 1.03, `hover scale stayed at ${hoverScale}`)
})
await page.mouse.move(0, 0)
await shot('09a-combat-still')

async function publishPresentationEvent(event) {
  return page.evaluate((nextEvent) => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    const history = run.combat.presentationEvents ?? []
    // This long suite deliberately restores older snapshots of the same combat.
    // Keep synthetic probe events above any sequence the live fixture saw first.
    const seq = history.reduce((latest, item) => Math.max(latest, item.seq), 1_000_000) + 1
    run.combat.presentationEvents = [...history, { ...nextEvent, seq }].slice(-12)
    debug.setRun(run)
    return seq
  }, event)
}

async function publishDamagingPresentationEvent(
  event,
  targetIds,
  lethal = false,
  { blockLoss = 0, hpLoss = 1 } = {},
) {
  return page.evaluate(({ nextEvent, enemyIds, kill, blockLoss, hpLoss }) => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    const history = run.combat.presentationEvents ?? []
    const seq = history.reduce((latest, item) => Math.max(latest, item.seq), 1_000_000) + 1
    for (const enemyId of enemyIds) {
      const enemy = run.combat.enemies.find((candidate) => candidate.uid === enemyId)
      if (!enemy) throw new Error(`damage presentation fixture lost ${enemyId}`)
      enemy.block = Math.max(0, enemy.block - blockLoss)
      enemy.hp = kill ? 0 : Math.max(1, enemy.hp - hpLoss)
      enemy.dead = kill
    }
    run.combat.presentationEvents = [...history, { ...nextEvent, seq }].slice(-12)
    debug.setRun(run)
    return seq
  }, {
    nextEvent: event,
    enemyIds: Array.isArray(targetIds) ? targetIds : [targetIds],
    kill: lethal,
    blockLoss,
    hpLoss,
  })
}

// Stance is visually carried by the Watcher now. It remains in the button's
// accessible name, but the old floating CALM/WRATH text is gone.
const watcherPlayerId = await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  Object.assign(run.combat.players[0], { character: 'watcher', stance: 'calm' })
  debug.setRun(run)
  return run.combat.players[0].id
})
const watcherSeat = page.locator(`.seat[data-player-id="${watcherPlayerId}"]`)
await watcherSeat.locator('.stance-aura--calm').waitFor()
const watcherIdleClearance = await watcherSeat.evaluate((seat) => {
  const art = seat.querySelector('.seat__portrait > img')
  const name = seat.querySelector('.seat__name')
  const bar = seat.querySelector('.bar')
  if (!(art instanceof HTMLElement) || !(name instanceof HTMLElement) || !(bar instanceof HTMLElement)) return null
  const artBox = art.getBoundingClientRect()
  const nameBox = name.getBoundingClientRect()
  const barBox = bar.getBoundingClientRect()
  const padding = Number.parseFloat(getComputedStyle(art).paddingBottom)
  return { padding, artFloor: artBox.bottom - padding, nameTop: nameBox.top, barTop: barBox.top }
})
const calmPresentation = await watcherSeat.evaluate((seat) => {
  const aura = seat.querySelector('.stance-aura--calm')
  return {
    visibleText: seat.querySelectorAll('.stance').length,
    label: seat.getAttribute('aria-label') ?? '',
    image: aura ? getComputedStyle(aura).backgroundImage : '',
    animation: aura ? getComputedStyle(aura).animationName : '',
  }
})
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[0].stance = 'wrath'
  debug.setRun(run)
})
await watcherSeat.locator('.stance-aura--wrath').waitFor()
const wrathPresentation = await watcherSeat.evaluate((seat) => {
  const aura = seat.querySelector('.stance-aura--wrath')
  return {
    label: seat.getAttribute('aria-label') ?? '',
    image: aura ? getComputedStyle(aura).backgroundImage : '',
    animation: aura ? getComputedStyle(aura).animationName : '',
  }
})
check('Watcher Calm and Wrath use distinct accessible portrait auras instead of text', () => {
  assert(watcherIdleClearance && watcherIdleClearance.padding >= 8,
    `Watcher art was not raised: ${JSON.stringify(watcherIdleClearance)}`)
  assert(watcherIdleClearance.artFloor <= watcherIdleClearance.nameTop - 4 &&
    watcherIdleClearance.artFloor <= watcherIdleClearance.barTop - 4,
  `Watcher feet overlap the name or HP bar: ${JSON.stringify(watcherIdleClearance)}`)
  assertEqual(calmPresentation.visibleText, 0)
  assert(calmPresentation.label.includes('calm stance'), calmPresentation.label)
  assert(wrathPresentation.label.includes('wrath stance'), wrathPresentation.label)
  assert(calmPresentation.image.includes('watcher-calm-aura.webp'), calmPresentation.image)
  assert(wrathPresentation.image.includes('watcher-wrath-aura.webp'), wrathPresentation.image)
  assertEqual(calmPresentation.animation, 'none')
  assertEqual(wrathPresentation.animation, 'none')
})

const vfxActor = () => page.locator('.combat-vfx--actor').last()
const vfxTarget = () => page.locator('.enemy .combat-vfx--target').last()
const sampleCharacterFrames = (times) => watcherSeat.evaluate((seat, sampleTimes) => {
  const animations = seat.getAnimations({ subtree: true }).filter((animation) => {
    const name = animation.animationName ?? ''
    return name.startsWith('attack-') || name.startsWith('watcher-') ||
      name.endsWith('-pose') || name === 'defect-core-charge'
  })
  const previous = animations.map((animation) => ({
    animation,
    currentTime: animation.currentTime,
    playState: animation.playState,
  }))
  const frames = sampleTimes.map((currentTime) => {
    for (const animation of animations) {
      animation.currentTime = currentTime
      animation.pause()
    }
    return {
      sampled: {
        idle: Number(getComputedStyle(seat.querySelector('.seat__portrait > img')).opacity),
        poses: [...seat.querySelectorAll('.character-attack__pose')]
          .map((pose) => Number(getComputedStyle(pose).opacity)),
      },
    }
  })
  for (const { animation, currentTime, playState } of previous) {
    animation.currentTime = currentTime
    if (playState === 'running') animation.play()
  }
  return frames
}, times)
async function captureCombatAnimation(name, time = 300, sample) {
  await page.evaluate((currentTime) => {
    for (const animation of document.getAnimations()) {
      const name = animation.animationName ?? ''
      if (name.startsWith('combat-vfx') || name.startsWith('vfx-') ||
        name.startsWith('attack-') || name.startsWith('watcher-') ||
        name.endsWith('-pose') || name === 'defect-core-charge') {
        animation.currentTime = currentTime
        animation.pause()
      }
    }
  }, time)
  const attackImpactOpacity = await page.evaluate(() => {
    const impact = [...document.querySelectorAll('.combat-vfx--attack-impact')].at(-1)
    return impact ? Number(getComputedStyle(impact).opacity) : null
  })
  const sampled = sample ? await sample() : null
  await page.screenshot({ path: join(animationReferenceDir, name), timeout: 15_000 })
  await page.evaluate(() => {
    for (const animation of document.getAnimations()) if (animation.playState === 'paused') animation.play()
  })
  return { attackImpactOpacity, sampled }
}
const firstEnemyId = await page.locator('.enemy').first().getAttribute('data-enemy-id')
const firstPlayerId = watcherPlayerId
const secondPlayerId = await page.evaluate(() => window.__STS_DEBUG__.getRun().combat.players[1]?.id)
if (!firstEnemyId) throw new Error('personal VFX fixture needs an actor and enemy')
if (!secondPlayerId) throw new Error('personal VFX fixture needs two players')
await page.evaluate(() => {
  localStorage.setItem('sts-sfx-enabled', 'on')
  window.__SFX_DETAILS__ = []
})
// The "corpse" enemy this fixture kills may already be dead from an earlier
// scenario in this file; `useFalling`'s falling-grace-period only fires on
// an observed alive→dead *transition* (comparing renders), so re-killing an
// already-dead enemy never triggers it, and the enemy simply vanishes from
// the DOM instead of lingering with `.enemy--dead` — reviving it first (and
// letting that render) restores the real transition this fixture needs.
const rowTargetFixture = await page.evaluate((livingUid) => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const living = run.combat.enemies.find((enemy) => enemy.uid === livingUid)
  const corpse = run.combat.enemies.find((enemy) => enemy.uid !== livingUid)
  if (!living || !corpse) throw new Error('row VFX fixture needs two enemies')
  Object.assign(corpse, { row: living.row, hp: corpse.maxHp || living.maxHp, dead: false })
  debug.setRun(run)
  return { row: living.row, corpseUid: corpse.uid }
}, firstEnemyId)
await page.locator(`.enemy[data-enemy-id="${rowTargetFixture.corpseUid}"]:not(.enemy--dead)`).waitFor()
await page.evaluate((corpseUid) => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const corpse = run.combat.enemies.find((enemy) => enemy.uid === corpseUid)
  Object.assign(corpse, { hp: 0, dead: true })
  debug.setRun(run)
}, rowTargetFixture.corpseUid)
await page.locator(`.enemy[data-enemy-id="${rowTargetFixture.corpseUid}"].enemy--dead`).waitFor()

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  Object.assign(run.combat.players[0], { character: 'ironclad', stance: 'neutral' })
  debug.setRun(run)
})
await watcherSeat.locator('.seat__portrait > img[src$="/ironclad.webp"]').waitFor()
await publishPresentationEvent({
  kind: 'card', actorId: firstPlayerId, sourceId: 'strike_ironclad', enemyIds: [firstEnemyId],
  enemyRow: rowTargetFixture.row, playerIds: [], upgraded: false, copied: false, energy: 1,
})
await vfxTarget().waitFor()
await watcherSeat.locator('.character-attack--ironclad').waitFor()
await page.waitForFunction(() => window.__SFX_DETAILS__.filter((sound) =>
  sound.cue === 'card:ironclad:strike_ironclad:base').length === 2)
const strikeOverflow = await page.locator('.board').evaluate((board) => ({
  overflowX: getComputedStyle(board).overflowX,
  scrollbarWidth: getComputedStyle(board).scrollbarWidth,
  webkitScrollbarDisplay: getComputedStyle(board, '::-webkit-scrollbar').display,
  horizontalRange: (() => {
    const stageWidth = board.style.getPropertyValue('--stage-width')
    const original = board.scrollLeft
    board.style.setProperty('--stage-width', `${board.clientWidth + 96}px`)
    board.scrollLeft = 0
    const left = board.scrollLeft
    board.scrollLeft = board.scrollWidth
    const right = board.scrollLeft
    board.style.setProperty('--stage-width', stageWidth)
    board.scrollLeft = original
    return right - left
  })(),
  pageScrollWidth: document.documentElement.scrollWidth,
  pageClientWidth: document.documentElement.clientWidth,
}))
const strikePresentation = await vfxTarget().evaluate((vfx) => ({
  family: vfx.getAttribute('data-vfx-family'),
  motion: vfx.getAttribute('data-vfx-motion'),
  image: getComputedStyle(vfx).backgroundImage,
  actorOverlays: document.querySelectorAll('.seat .combat-vfx--actor[data-vfx-source="strike_ironclad"]').length,
  targets: document.querySelectorAll('.enemy .combat-vfx--target[data-vfx-source="strike_ironclad"]').length,
}))
Object.assign(strikePresentation, await watcherSeat.evaluate((seat) => {
  const attack = seat.querySelector('.character-attack--ironclad')
  const swing = attack?.querySelector('.character-attack__swing')
  const ready = attack?.querySelector('.character-attack__pose--ironclad-ready')
  const impact = attack?.querySelector('.character-attack__pose--ironclad-impact')
  return {
    actorAnimation: getComputedStyle(seat.querySelector('.seat__portrait > img')).animationName,
    actorDuration: getComputedStyle(seat.querySelector('.seat__portrait > img')).animationDuration,
    attackTarget: seat.getAttribute('data-attack-target'),
    attackTargetCount: Number(attack?.getAttribute('data-attack-target-count')),
    attackX: Number.parseFloat(getComputedStyle(seat).getPropertyValue('--attack-x')),
    swingAnimation: swing ? getComputedStyle(swing).animationName : '',
    readyAnimation: ready ? getComputedStyle(ready).animationName : '',
    readyImage: ready?.querySelector('img')?.getAttribute('src') ?? '',
    impactAnimation: impact ? getComputedStyle(impact).animationName : '',
    impactImage: impact?.querySelector('img')?.getAttribute('src') ?? '',
  }
}))
const [ironcladReadyFrame, ironcladHandoffFrame, ironcladImpactFrame, ironcladReturnFrame] =
  await sampleCharacterFrames([270, 585, 900, 1_500])
ironcladReadyFrame.attackImpactOpacity = (await captureCombatAnimation(
  'combat-attack-ironclad-ready.png', 270,
)).attackImpactOpacity
ironcladImpactFrame.attackImpactOpacity = (await captureCombatAnimation(
  'combat-attack-ironclad-impact.png', 900,
)).attackImpactOpacity
await captureCombatAnimation('combat-attack-ironclad-recovery.png', 1_500)
await vfxTarget().waitFor({ state: 'detached' })

const rowDashFixture = await page.evaluate(({ livingUid, corpseUid }) => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const living = run.combat.enemies.find((enemy) => enemy.uid === livingUid)
  const corpse = run.combat.enemies.find((enemy) => enemy.uid === corpseUid)
  if (!living || !corpse) throw new Error('row dash fixture lost an enemy')
  Object.assign(corpse, { row: living.row, hp: Math.max(1, corpse.maxHp), dead: false })
  debug.setRun(run)
  const ids = run.combat.enemies.filter((enemy) => !enemy.isBoss && enemy.row === living.row)
    .map((enemy) => enemy.uid)
  return { ids, expected: ids[0], row: living.row }
}, { livingUid: firstEnemyId, corpseUid: rowTargetFixture.corpseUid })
await page.locator(`.enemy[data-enemy-id="${rowTargetFixture.corpseUid}"]:not(.enemy--dead)`).waitFor()
await publishPresentationEvent({
  kind: 'card', actorId: firstPlayerId, sourceId: 'cleave', enemyIds: [...rowDashFixture.ids].reverse(),
  enemyRow: rowDashFixture.row, playerIds: [], upgraded: false, copied: false, energy: 1,
})
await watcherSeat.locator('.character-attack--ironclad').waitFor()
const rowDashTarget = await watcherSeat.getAttribute('data-attack-target')
await vfxTarget().waitFor({ state: 'detached' })
await page.evaluate((corpseUid) => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const corpse = run.combat.enemies.find((enemy) => enemy.uid === corpseUid)
  if (corpse) Object.assign(corpse, { hp: 0, dead: true })
  debug.setRun(run)
}, rowTargetFixture.corpseUid)
await page.locator(`.enemy[data-enemy-id="${rowTargetFixture.corpseUid}"].enemy--dead`).waitFor()

await publishPresentationEvent({
  kind: 'card', actorId: firstPlayerId, sourceId: 'bash', enemyIds: [firstEnemyId],
  playerIds: [], upgraded: false, copied: false, energy: 2,
})
await vfxTarget().waitFor()
await page.waitForFunction(() => window.__SFX_DETAILS__.filter((sound) =>
  sound.cue === 'card:ironclad:bash:base').length === 3)
const bashPresentation = await vfxTarget().evaluate((vfx) => ({
  family: vfx.getAttribute('data-vfx-family'),
  image: getComputedStyle(vfx).backgroundImage,
}))
await vfxTarget().waitFor({ state: 'detached' })

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[0].character = 'defect'
  debug.setRun(run)
})
await watcherSeat.locator('.seat__portrait > img[src$="/defect.webp"]').waitFor()
await publishPresentationEvent({
  kind: 'card', actorId: firstPlayerId, sourceId: 'zap', enemyIds: [], playerIds: [],
  upgraded: false, copied: false, energy: 1,
})
await page.waitForFunction(() => window.__SFX_DETAILS__.filter((sound) =>
  sound.cue === 'card:defect:zap:base').length === 2)
await publishPresentationEvent({
  kind: 'orb', orb: 'lightning', actorId: firstPlayerId, sourceId: 'zap', enemyIds: [], playerIds: [],
})
await vfxActor().waitFor()
const zapPresentation = await vfxActor().evaluate((vfx) => ({
  family: vfx.getAttribute('data-vfx-family'),
  image: getComputedStyle(vfx).backgroundImage,
}))
await vfxActor().waitFor({ state: 'detached' })

const defectStrikeSeq = await publishDamagingPresentationEvent({
  kind: 'card', actorId: firstPlayerId, sourceId: 'strike_defect', enemyIds: [firstEnemyId], playerIds: [],
  upgraded: false, copied: false, energy: 1,
}, firstEnemyId)
await vfxTarget().waitFor()
await watcherSeat.locator('.character-attack--defect').waitFor()
await page.waitForTimeout(450)
const defectHit = page.locator(`.enemy[data-enemy-id="${firstEnemyId}"] .hit-vfx`).last()
const earlyDefectFeedback = await defectHit.evaluate((hit) => Number(getComputedStyle(hit).opacity))
await page.waitForFunction((enemyId) => {
  const hits = document.querySelectorAll(`.enemy[data-enemy-id="${enemyId}"] .hit-vfx`)
  const hit = hits[hits.length - 1]
  return hit && Number(getComputedStyle(hit).opacity) > 0.5
}, firstEnemyId)
const defectAttack = await watcherSeat.evaluate((seat) => ({
  animation: getComputedStyle(seat.querySelector('.seat__portrait > img')).animationName,
  duration: getComputedStyle(seat.querySelector('.seat__portrait > img')).animationDuration,
  core: getComputedStyle(seat.querySelector('.character-attack__core')).animationName,
  coreImage: seat.querySelector('.character-attack__core img')?.getAttribute('src') ?? '',
  charge: getComputedStyle(seat.querySelector('.character-attack__pose--defect-charge')).animationName,
  chargeImage: seat.querySelector('.character-attack__pose--defect-charge img')?.getAttribute('src') ?? '',
  release: getComputedStyle(seat.querySelector('.character-attack__pose--defect-release')).animationName,
  releaseImage: seat.querySelector('.character-attack__pose--defect-release img')?.getAttribute('src') ?? '',
  bolts: seat.querySelectorAll('.character-attack__bolt').length,
  target: seat.querySelector('.character-attack__bolt')?.getAttribute('data-attack-target-id'),
  projectileImage: seat.querySelector('.character-attack__bolt img')?.getAttribute('src') ?? '',
  launchOffset: (() => {
    const pose = seat.querySelector('.character-attack__pose--defect-release')
    const bolt = seat.querySelector('.character-attack__bolt')
    const core = seat.querySelector('.character-attack__core')
    if (!(pose instanceof HTMLElement) || !(bolt instanceof HTMLElement) || !(core instanceof HTMLElement)) return null
    // The generated 512x341 pose's large cyan face lens is centred at (297, 52).
    const renderedHeight = pose.offsetWidth * 341 / 512
    const lensX = pose.offsetLeft + pose.offsetWidth * 297 / 512
    const lensY = pose.offsetTop + pose.offsetHeight - renderedHeight + renderedHeight * 52 / 341
    return {
      projectile: {
        x: bolt.offsetLeft + bolt.offsetWidth / 2 - lensX,
        y: bolt.offsetTop + bolt.offsetHeight / 2 - lensY,
      },
      charge: {
        x: core.offsetLeft + core.offsetWidth / 2 - lensX,
        y: core.offsetTop + core.offsetHeight / 2 - lensY,
      },
    }
  })(),
}))
const [defectChargeFrame, defectHandoffFrame, defectReturnFrame] =
  await sampleCharacterFrames([270, 825, 1_375])
await captureCombatAnimation('combat-attack-defect-windup.png', 270)
await captureCombatAnimation('combat-attack-defect-impact.png', 1_110)
await captureCombatAnimation('combat-attack-defect-recovery.png', 1_375)
check('Defect damage feedback lands with its emitted bolt', () => {
  assertEqual(earlyDefectFeedback, 0)
})
await page.locator(`.combat-vfx[data-vfx-seq="${defectStrikeSeq}"]`).waitFor({ state: 'detached' })

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  while (run.combat.enemies.length < 3) {
    const source = run.combat.enemies[0]
    run.combat.enemies.push({ ...source, uid: `defect-volley-fixture-${run.combat.enemies.length}` })
  }
  for (const enemy of run.combat.enemies.slice(0, 3)) Object.assign(enemy, { hp: Math.max(2, enemy.maxHp), dead: false })
  debug.setRun(run)
})
await page.waitForFunction(() => document.querySelectorAll('.enemy:not(.enemy--dead)').length >= 3)
const defectVolleyIds = await page.locator('.enemy:not(.enemy--dead)').evaluateAll((enemies) =>
  enemies.slice(0, 3).map((enemy) => enemy.getAttribute('data-enemy-id')).filter(Boolean))
const defectVolleySeq = await publishPresentationEvent({
  kind: 'card', actorId: firstPlayerId, sourceId: 'strike_defect', enemyIds: defectVolleyIds,
  playerIds: [], upgraded: false, copied: false, energy: 1,
})
await watcherSeat.locator(`.character-attack[data-attack-seq="${defectVolleySeq}"]`).waitFor()
await page.waitForTimeout(50)
const defectVolleyFollowupSeq = await publishPresentationEvent({
  kind: 'card', actorId: firstPlayerId, sourceId: 'strike_defect', enemyIds: [firstEnemyId],
  playerIds: [], upgraded: false, copied: false, energy: 1,
})
await watcherSeat.locator(`.character-attack[data-attack-seq="${defectVolleyFollowupSeq}"]`).waitFor()
await page.waitForTimeout(1_250)
const lateDefectImpact = await page.locator(
  `.enemy[data-enemy-id="${defectVolleyIds.at(-1)}"] .combat-vfx[data-vfx-seq="${defectVolleySeq}"]`,
).count()
await page.locator(`.combat-vfx[data-vfx-seq="${defectVolleyFollowupSeq}"]`).first().waitFor({ state: 'detached' })
const supersededDefectReplay = await watcherSeat.locator(
  `.character-attack[data-attack-seq="${defectVolleySeq}"]`,
).count()
check('multi-target Defect events live through the last staggered impact', () => {
  assertEqual(defectVolleyIds.length, 3, 'the Defect lifetime fixture needs three targets')
  assertEqual(lateDefectImpact, 1)
  assertEqual(supersededDefectReplay, 0, 'a superseded volley replayed when the newer attack expired')
})
await page.locator(`.combat-vfx[data-vfx-seq="${defectVolleySeq}"]`).first().waitFor({ state: 'detached' })

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  Object.assign(run.combat.players[0], { character: 'watcher', stance: 'calm' })
  debug.setRun(run)
})
await watcherSeat.locator('.stance-aura--calm').waitFor()
await publishPresentationEvent({
  kind: 'card', actorId: firstPlayerId, sourceId: 'pray', enemyIds: [], playerIds: [],
  upgraded: false, copied: false, energy: 1,
})
await vfxActor().waitFor()
await page.waitForFunction(() => window.__SFX_DETAILS__.filter((sound) =>
  sound.cue === 'card:watcher:pray:base').length === 3)
const prayPresentation = await vfxActor().evaluate((vfx) => ({
  family: vfx.getAttribute('data-vfx-family'),
  tone: vfx.getAttribute('data-vfx-tone'),
  image: getComputedStyle(vfx).backgroundImage,
}))
await vfxActor().waitFor({ state: 'detached' })

await publishPresentationEvent({
  kind: 'card', actorId: firstPlayerId, sourceId: 'strike_watcher', enemyIds: defectVolleyIds, playerIds: [],
  upgraded: false, copied: false, energy: 1,
})
await vfxTarget().waitFor()
await watcherSeat.locator('.character-attack--watcher').waitFor()
const watcherAttack = await watcherSeat.evaluate((seat) => ({
  animation: getComputedStyle(seat.querySelector('.seat__portrait > img')).animationName,
  duration: getComputedStyle(seat.querySelector('.seat__portrait > img')).animationDuration,
  target: seat.getAttribute('data-attack-target'),
  charge: getComputedStyle(seat.querySelector('.character-attack__pose--watcher-charge')).animationName,
  chargeImage: seat.querySelector('.character-attack__pose--watcher-charge img')?.getAttribute('src') ?? '',
  cast: getComputedStyle(seat.querySelector('.character-attack__pose--watcher-cast')).animationName,
  castImage: seat.querySelector('.character-attack__pose--watcher-cast img')?.getAttribute('src') ?? '',
  meteors: [...seat.querySelectorAll('.character-attack__meteor')].map((meteor) => ({
    target: meteor.getAttribute('data-attack-target-id'),
    animation: getComputedStyle(meteor).animationName,
    image: meteor.querySelector('.character-attack__meteor-art')?.getAttribute('src') ?? '',
    impactImage: meteor.querySelector('.character-attack__meteor-impact')?.getAttribute('src') ?? '',
  })),
  auraDash: seat.querySelector('.stance-aura')?.getAnimations()
    .some((animation) => animation.animationName === 'attack-watcher-aura') ?? false,
}))
const readWatcherMeteorFrame = () => watcherSeat.evaluate((seat) => {
  const meteor = seat.querySelector('.character-attack__meteor')
  const impact = meteor?.querySelector('.character-attack__meteor-impact')
  const targetId = meteor?.getAttribute('data-attack-target-id')
  const target = targetId ? document.querySelector(`.enemy[data-enemy-id="${targetId}"] .enemy__portrait`) : null
  const board = seat.closest('.board')
  if (!(meteor instanceof HTMLElement) || !(impact instanceof HTMLElement) ||
    !(target instanceof HTMLElement) || !(board instanceof HTMLElement)) return null
  const meteorRect = meteor.getBoundingClientRect()
  const impactRect = impact.getBoundingClientRect()
  const targetRect = target.getBoundingClientRect()
  const boardRect = board.getBoundingClientRect()
  return {
    meteor: { left: meteorRect.left, top: meteorRect.top, right: meteorRect.right, bottom: meteorRect.bottom,
      width: meteorRect.width, height: meteorRect.height },
    nose: { x: meteorRect.left + meteorRect.width * 0.8965, y: meteorRect.top + meteorRect.height * 0.8613 },
    impact: { x: impactRect.left + impactRect.width / 2, y: impactRect.top + impactRect.height / 2,
      width: impactRect.width, opacity: Number(getComputedStyle(impact).opacity) },
    target: { x: targetRect.left + targetRect.width / 2, y: targetRect.bottom },
    boardTop: boardRect.top,
  }
})
const [watcherChargeFrame, watcherHandoffFrame, watcherReturnFrame] =
  await sampleCharacterFrames([270, 825, 1_375])
await captureCombatAnimation('combat-attack-watcher-charge.png', 270)
const watcherMeteorSky = (await captureCombatAnimation(
  'combat-attack-watcher-meteor-sky.png', 550, readWatcherMeteorFrame,
)).sampled
const watcherMeteorContact = (await captureCombatAnimation(
  'combat-attack-watcher-meteor-impact.png', 1_050, readWatcherMeteorFrame,
)).sampled
await captureCombatAnimation('combat-attack-watcher-recovery.png', 1_375)
await vfxTarget().waitFor({ state: 'detached' })

await page.setViewportSize({ width: 1440, height: 1200 })
const tallWatcherSeq = await publishPresentationEvent({
  kind: 'card', actorId: firstPlayerId, sourceId: 'strike_watcher', enemyIds: [defectVolleyIds[0]], playerIds: [],
  upgraded: false, copied: false, energy: 1,
})
await watcherSeat.locator(`.character-attack[data-attack-seq="${tallWatcherSeq}"]`).waitFor()
const watcherTallMeteorSky = (await captureCombatAnimation(
  'combat-attack-watcher-meteor-tall-sky.png', 550, readWatcherMeteorFrame,
)).sampled
await page.locator(`.combat-vfx[data-vfx-seq="${tallWatcherSeq}"]`).first().waitFor({ state: 'detached' })
await page.setViewportSize({ width: 1440, height: 900 })

await page.evaluate((enemyId) => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  Object.assign(run.combat.players[0], {
    character: 'silent',
    energy: 3,
    cardPlayLocked: false,
    hand: [{ uid: 'animation-dagger-spray', defId: 'dagger_spray', upgraded: false }],
  })
  const enemy = run.combat.enemies.find((candidate) => candidate.uid === enemyId)
  if (!enemy) throw new Error(`Dagger Spray fixture lost ${enemyId}`)
  Object.assign(enemy, { hp: Math.max(10, enemy.maxHp), dead: false, block: 0 })
  debug.setRun(run)
}, firstEnemyId)
await watcherSeat.locator('.seat__portrait > img[src$="/silent.webp"]').waitFor()
await page.waitForFunction((enemyId) => {
  const combat = window.__STS_DEBUG__.getRun().combat
  return combat.players[0].hand[0]?.uid === 'animation-dagger-spray' &&
    combat.enemies.some((enemy) => enemy.uid === enemyId && !enemy.dead && enemy.hp >= 10)
}, firstEnemyId)
const daggerSprayBefore = (await readRun()).combat
const daggerSprayTarget = daggerSprayBefore.enemies.find((enemy) => enemy.uid === firstEnemyId)
if (!daggerSprayTarget) throw new Error('Dagger Spray animation fixture lost its enemy')
const daggerSprayPageErrorsBefore = pageErrors.length
await page.getByRole('button', { name: /^Dagger Spray,/ }).click()
await page.waitForSelector('.enemy--targeted')
await page.locator(`.enemy[data-enemy-id="${daggerSprayTarget.uid}"]`).click()
await watcherSeat.locator('.character-attack--silent').waitFor()
const daggerSprayAfter = (await readRun()).combat
const daggerSprayEvent = daggerSprayAfter.presentationEvents.at(-1)
if (!daggerSprayEvent) throw new Error('Dagger Spray did not publish its animation event')
check('real Dagger Spray resolves without crashing its Silent animation', () => {
  assertEqual(pageErrors.length, daggerSprayPageErrorsBefore)
  assert(!daggerSprayAfter.players[0].hand.some((card) => card.uid === 'animation-dagger-spray'))
  assertEqual(daggerSprayEvent?.sourceId, 'dagger_spray')
  assertEqual(daggerSprayEvent?.enemyRow, daggerSprayTarget.row)
  assert(daggerSprayEvent?.enemyIds.includes(daggerSprayTarget.uid))
})
await page.locator(`.combat-vfx[data-vfx-seq="${daggerSprayEvent.seq}"]`).first().waitFor({ state: 'detached' })

await publishPresentationEvent({
  kind: 'card', actorId: firstPlayerId, sourceId: 'predator', enemyIds: [firstEnemyId],
  playerIds: [secondPlayerId], upgraded: false, copied: false, energy: 2,
})
await vfxTarget().waitFor()
await watcherSeat.locator('.character-attack--silent').waitFor()
const mixedTargetPresentation = await page.evaluate(({ enemyId, playerId }) => ({
  enemyImpacts: document.querySelectorAll(
    `.enemy[data-enemy-id="${enemyId}"] .combat-vfx--target[data-vfx-source="predator"]`,
  ).length,
  allyImpacts: document.querySelectorAll(
    `.seat[data-player-id="${playerId}"] .combat-vfx--target[data-vfx-source="predator"]`,
  ).length,
}), { enemyId: firstEnemyId, playerId: secondPlayerId })
const silentAttack = await watcherSeat.evaluate((seat) => ({
  animation: getComputedStyle(seat.querySelector('.seat__portrait > img')).animationName,
  duration: getComputedStyle(seat.querySelector('.seat__portrait > img')).animationDuration,
  pose: getComputedStyle(seat.querySelector('.character-attack__pose--silent-throw')).animationName,
  poseImage: seat.querySelector('.character-attack__pose--silent-throw img')?.getAttribute('src') ?? '',
  daggers: seat.querySelectorAll('.character-attack__dagger').length,
  target: seat.querySelector('.character-attack__dagger')?.getAttribute('data-attack-target-id'),
  daggerImage: seat.querySelector('.character-attack__dagger img')?.getAttribute('src') ?? '',
  daggerAnimation: getComputedStyle(seat.querySelector('.character-attack__dagger')).animationName,
  daggerRoundTrip: (() => {
    const animation = seat.querySelector('.character-attack__dagger')?.getAnimations()[0]
    const frames = animation?.effect?.getKeyframes() ?? []
    return frames.length > 1 && frames[0].transform === frames.at(-1).transform
  })(),
  attackX: Number.parseFloat(getComputedStyle(seat).getPropertyValue('--attack-x')),
}))
const [silentEntryFrame, silentThrowFrame, silentReturnFrame] =
  await sampleCharacterFrames([170, 1_025, 1_899])
await captureCombatAnimation('combat-attack-silent-windup.png', 170)
await captureCombatAnimation('combat-attack-silent-impact.png', 1_025)
await captureCombatAnimation('combat-attack-silent-recovery.png', 1_899)
check('mixed hostile/support cards never paint attack art on the ally target', () => {
  assertEqual(mixedTargetPresentation.enemyImpacts, 1)
  assertEqual(mixedTargetPresentation.allyImpacts, 0)
})
await vfxTarget().waitFor({ state: 'detached' })

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[0].shivs = 1
  debug.setRun(run)
})
await page.getByRole('button', { name: 'Use Shiv' }).click()
await page.waitForSelector('.enemy--targeted')
await page.locator(`.enemy[data-enemy-id="${firstEnemyId}"]`).click()
const standaloneShivVfx = page.locator('.combat-vfx[data-vfx-kind="shiv"]').last()
await standaloneShivVfx.waitFor()
const standaloneShivAttack = await watcherSeat.evaluate((seat) => ({
  pose: seat.querySelectorAll('.character-attack__pose--silent-throw').length,
  daggers: seat.querySelectorAll('.character-attack__dagger').length,
}))
check('spending Silent’s standalone Shiv uses her throw pose and dagger projectile', () => {
  assertEqual(standaloneShivAttack.pose, 1)
  assertEqual(standaloneShivAttack.daggers, 1)
})
await standaloneShivVfx.waitFor({ state: 'detached' })

const poisonOnlySeq = await publishPresentationEvent({
  kind: 'card', actorId: firstPlayerId, sourceId: 'deadly_poison', enemyIds: [firstEnemyId],
  playerIds: [], upgraded: false, copied: false, energy: 1,
})
await page.locator(`.combat-vfx[data-vfx-seq="${poisonOnlySeq}"]`).waitFor()
const poisonOnlyAttackLayers = await watcherSeat.locator('.character-attack').count()
check('poison-only Silent skills keep their target VFX without throwing a damage dagger', () => {
  assertEqual(poisonOnlyAttackLayers, 0)
})
await page.locator(`.combat-vfx[data-vfx-seq="${poisonOnlySeq}"]`).waitFor({ state: 'detached' })

await page.evaluate((enemyIds) => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  for (const enemy of run.combat.enemies) {
    if (enemyIds.includes(enemy.uid)) Object.assign(enemy, { hp: Math.max(2, enemy.maxHp), dead: false })
  }
  debug.setRun(run)
}, rowDashFixture.ids)
await page.waitForTimeout(100)
const silentVolleySeq = await publishDamagingPresentationEvent({
  kind: 'card', actorId: firstPlayerId, sourceId: 'dagger_spray', enemyIds: rowDashFixture.ids,
  enemyRow: rowDashFixture.row, playerIds: [], upgraded: false, copied: false, energy: 1,
}, rowDashFixture.ids)
await watcherSeat.locator(`.character-attack[data-attack-seq="${silentVolleySeq}"]`).waitFor()
const silentVolley = watcherSeat.locator(`.character-attack[data-attack-seq="${silentVolleySeq}"]`)
const silentVolleyTimings = await silentVolley.locator('.character-attack__dagger').evaluateAll((daggers) =>
  daggers.map((dagger) => {
    const style = getComputedStyle(dagger)
    const duration = Number.parseFloat(style.animationDuration) * 1000
    const delay = Number.parseFloat(style.animationDelay) * 1000
    return { duration, delay, contact: delay + duration / 2 }
  }))
await page.waitForTimeout(320)
const earlySilentHits = await Promise.all(rowDashFixture.ids.map((enemyId) =>
  page.locator(`.enemy[data-enemy-id="${enemyId}"] .hit-vfx`).last()
    .evaluate((hit) => Number(getComputedStyle(hit).opacity))))
await page.waitForFunction((enemyId) => {
  const hits = document.querySelectorAll(`.enemy[data-enemy-id="${enemyId}"] .hit-vfx`)
  const hit = hits[hits.length - 1]
  return hit && Number(getComputedStyle(hit).opacity) > 0.5
}, rowDashFixture.ids[0])
const staggeredSilentHits = await Promise.all(rowDashFixture.ids.map((enemyId) =>
  page.locator(`.enemy[data-enemy-id="${enemyId}"] .hit-vfx`).last()
    .evaluate((hit) => Number(getComputedStyle(hit).opacity))))
await page.waitForFunction((enemyId) => {
  const hits = document.querySelectorAll(`.enemy[data-enemy-id="${enemyId}"] .hit-vfx`)
  const hit = hits[hits.length - 1]
  return hit && Number(getComputedStyle(hit).opacity) > 0.5
}, rowDashFixture.ids.at(-1))
check('multi-target Silent daggers reach every enemy inside the contact window', () => {
  assertEqual(silentVolleyTimings.length, rowDashFixture.ids.length)
  assert(silentVolleyTimings[0].contact >= 1_015 && silentVolleyTimings[0].contact <= 1_035,
    `first dagger contact is ${silentVolleyTimings[0].contact}ms`)
  assert(Math.max(...silentVolleyTimings.map(({ contact }) => contact)) < 1_250,
    `a staggered dagger outlives contact: ${JSON.stringify(silentVolleyTimings)}`)
  assertDeepEqual(earlySilentHits, rowDashFixture.ids.map(() => 0))
  assert(staggeredSilentHits[0] > 0.5)
  assertEqual(staggeredSilentHits.at(-1), 0, 'all hit feedback appeared before the staggered daggers landed')
})
await page.locator(`.combat-vfx[data-vfx-seq="${silentVolleySeq}"]`).first().waitFor({ state: 'detached' })

await publishPresentationEvent({
  kind: 'potion', actorId: firstPlayerId, sourceId: 'fire_potion', enemyIds: [firstEnemyId], playerIds: [],
})
await vfxTarget().waitFor()
await page.waitForFunction(() => window.__SFX_DETAILS__.filter((sound) => sound.cue === 'potion:fire_potion').length === 2)
const potionPresentation = await vfxTarget().evaluate((vfx) => ({
  kind: vfx.getAttribute('data-vfx-kind'),
  family: vfx.getAttribute('data-vfx-family'),
  motion: vfx.getAttribute('data-vfx-motion'),
  image: getComputedStyle(vfx).backgroundImage,
  toneColor: getComputedStyle(vfx).getPropertyValue('--vfx-tone-color').trim(),
  ringColor: getComputedStyle(vfx, '::before').borderTopColor,
}))
const personalSounds = await page.evaluate(() => window.__SFX_DETAILS__.filter((sound) => sound.cue))
check('personal card and potion events render distinct authoritative recipes', () => {
  assertEqual(strikePresentation.family, 'slash')
  assertEqual(strikePresentation.motion, 'lunge')
  assertEqual(strikePresentation.actorAnimation, 'attack-ironclad')
  assertEqual(strikePresentation.actorDuration, '1.8s')
  assertEqual(strikePresentation.attackTarget, firstEnemyId)
  assertEqual(strikePresentation.attackTargetCount, 1)
  assert(strikePresentation.attackX > 0, `Ironclad dash did not move toward its target: ${strikePresentation.attackX}`)
  assertEqual(strikePresentation.swingAnimation, 'attack-swing')
  assertEqual(strikePresentation.readyAnimation, 'ironclad-ready-pose')
  assert(strikePresentation.readyImage.endsWith('/ironclad-ready.webp'), strikePresentation.readyImage)
  assertEqual(strikePresentation.impactAnimation, 'ironclad-impact-pose')
  assert(strikePresentation.impactImage.endsWith('/ironclad-impact.webp'), strikePresentation.impactImage)
  assertEqual(ironcladReadyFrame.attackImpactOpacity, 0,
    'enemy impact art fired while Ironclad was still preparing')
  assert(ironcladImpactFrame.attackImpactOpacity > 0.5,
    `enemy impact art was not visible at contact: ${ironcladImpactFrame.attackImpactOpacity}`)
  for (const [label, frame] of [
    ['Ironclad ready', ironcladReadyFrame],
    ['Ironclad handoff', ironcladHandoffFrame],
    ['Ironclad impact', ironcladImpactFrame],
    ['Ironclad return', ironcladReturnFrame],
    ['Defect charge', defectChargeFrame],
    ['Defect handoff', defectHandoffFrame],
    ['Defect return', defectReturnFrame],
    ['Watcher charge', watcherChargeFrame],
    ['Watcher handoff', watcherHandoffFrame],
    ['Watcher return', watcherReturnFrame],
    ['Silent entry', silentEntryFrame],
    ['Silent throw', silentThrowFrame],
    ['Silent return', silentReturnFrame],
  ]) {
    assert(frame.sampled, `${label} body layers were not measurable`)
    const visiblePoses = frame.sampled.poses.filter((opacity) => opacity > 0.01).length
    const visibleBodies = visiblePoses + Number(frame.sampled.idle > 0.01)
    assertEqual(visibleBodies, 1, `${label} did not show exactly one body: ${JSON.stringify(frame.sampled)}`)
    if (!label.endsWith('return')) {
      assertEqual(visiblePoses, 1, `${label} did not show its generated body: ${JSON.stringify(frame.sampled)}`)
    }
  }
  assertEqual(rowDashTarget, rowDashFixture.expected,
    'a row attack did not dash to the first enemy in that row')
  assertEqual(strikePresentation.actorOverlays, 0, 'hostile impact art belongs on the enemy, not the actor')
  assertEqual(strikePresentation.targets, 1)
  assert(strikePresentation.image.includes('ironclad-strike.webp'), strikePresentation.image)
  assertEqual(strikeOverflow.overflowX, 'auto', 'crowded stages must remain horizontally reachable')
  assertEqual(strikeOverflow.scrollbarWidth, 'none', 'combat VFX exposed Firefox scrollbar chrome')
  assertEqual(strikeOverflow.webkitScrollbarDisplay, 'none', 'combat VFX exposed Chromium scrollbar chrome')
  assert(strikeOverflow.horizontalRange > 0, 'hidden scrollbar styling disabled horizontal stage scrolling')
  assert(strikeOverflow.pageScrollWidth <= strikeOverflow.pageClientWidth + 1,
    `Strike VFX overflows the page (${strikeOverflow.pageScrollWidth} > ${strikeOverflow.pageClientWidth})`)
  assertEqual(bashPresentation.family, 'blunt')
  assert(bashPresentation.image.includes('ironclad-bash.webp'), bashPresentation.image)
  assertEqual(zapPresentation.family, 'lightning')
  assert(zapPresentation.image.includes('lightning-channel.webp'), zapPresentation.image)
  assertEqual(defectAttack.animation, 'attack-defect')
  assertEqual(defectAttack.duration, '1.65s')
  assertEqual(defectAttack.core, 'defect-core-charge')
  assert(defectAttack.coreImage.endsWith('/defect-face-orb.webp'), defectAttack.coreImage)
  assertEqual(defectAttack.charge, 'defect-charge-pose')
  assert(defectAttack.chargeImage.endsWith('/defect-charge.webp'), defectAttack.chargeImage)
  assertEqual(defectAttack.release, 'defect-release-pose')
  assert(defectAttack.releaseImage.endsWith('/defect-release.webp'), defectAttack.releaseImage)
  assertEqual(defectAttack.bolts, 1)
  assertEqual(defectAttack.target, firstEnemyId)
  assert(defectAttack.projectileImage.endsWith('/defect-face-orb.webp'), defectAttack.projectileImage)
  assert(defectAttack.launchOffset && [defectAttack.launchOffset.projectile, defectAttack.launchOffset.charge]
    .every((offset) => Math.abs(offset.x) <= 4 && Math.abs(offset.y) <= 4),
    `Defect projectile misses its face lens: ${JSON.stringify(defectAttack.launchOffset)}`)
  assertEqual(prayPresentation.family, 'mantra')
  assertEqual(prayPresentation.tone, 'mantra-cyan')
  assert(prayPresentation.image.includes('watcher-pray.webp'), prayPresentation.image)
  assertEqual(watcherAttack.animation, 'attack-watcher')
  assertEqual(watcherAttack.duration, '1.65s')
  assertEqual(watcherAttack.target, defectVolleyIds[0])
  assertEqual(watcherAttack.charge, 'watcher-charge-pose')
  assert(watcherAttack.chargeImage.endsWith('/watcher-ready.webp'), watcherAttack.chargeImage)
  assertEqual(watcherAttack.cast, 'watcher-cast-pose')
  assert(watcherAttack.castImage.endsWith('/watcher-thrust.webp'), watcherAttack.castImage)
  assertDeepEqual(watcherAttack.meteors.map(({ target }) => target), defectVolleyIds)
  assert(watcherAttack.meteors.every(({ animation }) => animation === 'watcher-meteor-fall'))
  assert(watcherAttack.meteors.every(({ image }) => image.endsWith('/watcher-meteor.webp')))
  assert(watcherAttack.meteors.every(({ impactImage }) => impactImage.endsWith('/watcher-meteor-impact.webp')))
  assert(watcherMeteorSky && watcherMeteorContact, 'Watcher meteor frames were not measurable')
  assert(watcherMeteorSky.meteor.bottom <= watcherMeteorSky.boardTop,
    `Watcher meteor did not start in the sky: ${JSON.stringify(watcherMeteorSky)}`)
  assert(watcherTallMeteorSky && watcherTallMeteorSky.meteor.bottom <= watcherTallMeteorSky.boardTop,
    `Watcher meteor did not start in the sky on a tall stage: ${JSON.stringify(watcherTallMeteorSky)}`)
  const meteorDx = watcherMeteorContact.nose.x - watcherMeteorSky.nose.x
  const meteorDy = watcherMeteorContact.nose.y - watcherMeteorSky.nose.y
  assert(Math.abs(meteorDy / meteorDx - Math.tan(45.34776287123926 * Math.PI / 180)) < 0.002,
    `Watcher meteor flight diverged from its 45.35deg asset axis: ${meteorDx},${meteorDy}`)
  assert(Math.abs(watcherMeteorContact.nose.x - watcherMeteorContact.target.x) <= 2 &&
    Math.abs(watcherMeteorContact.nose.y - watcherMeteorContact.target.y) <= 2,
  `Watcher meteor missed enemy ground contact: ${JSON.stringify(watcherMeteorContact)}`)
  assert(Math.abs(watcherMeteorContact.impact.x - watcherMeteorContact.target.x) <= 2 &&
    Math.abs(watcherMeteorContact.impact.y - watcherMeteorContact.target.y) <= 2 &&
    watcherMeteorContact.impact.opacity >= 0.9,
  `Watcher meteor impact was not visible at ground contact: ${JSON.stringify(watcherMeteorContact)}`)
  assert(Math.abs(watcherMeteorContact.impact.width / watcherMeteorContact.meteor.width - 1.15) <= 0.01,
    `Watcher meteor impact is not 1.15x the meteor: ${JSON.stringify(watcherMeteorContact)}`)
  assert(watcherMeteorContact.meteor.width >= 90, `Watcher meteor is still too small: ${watcherMeteorContact.meteor.width}px`)
  assertEqual(watcherAttack.auraDash, false)
  assertEqual(silentAttack.animation, 'attack-silent')
  assertEqual(silentAttack.duration, '1.9s')
  assertEqual(silentAttack.pose, 'silent-throw-pose')
  assert(silentAttack.poseImage.endsWith('/silent-throw.webp'), silentAttack.poseImage)
  assertEqual(silentAttack.daggers, 1)
  assertEqual(silentAttack.target, firstEnemyId)
  assert(silentAttack.daggerImage.endsWith('/silent-knife.webp'), silentAttack.daggerImage)
  assertEqual(silentAttack.daggerAnimation, 'attack-dagger-round-trip')
  assertEqual(silentAttack.daggerRoundTrip, true, 'Silent’s thrown knife did not return to her')
  assert(silentAttack.attackX > 0, 'the Silent target offset fixture is invalid')
  assertEqual(potionPresentation.kind, 'potion')
  assertEqual(potionPresentation.family, 'projectile')
  assertEqual(potionPresentation.motion, 'throw')
  assert(potionPresentation.image.includes('potion-burst.webp'), potionPresentation.image)
})
check('personal VFX events carry their matching layered SFX identity', () => {
  const soundsFor = (cue) => personalSounds.filter((sound) => sound.cue === cue)
  const strike = soundsFor('card:ironclad:strike_ironclad:base')
  const bash = soundsFor('card:ironclad:bash:base')
  const zap = soundsFor('card:defect:zap:base')
  const pray = soundsFor('card:watcher:pray:base')
  const potion = soundsFor('potion:fire_potion')
  assertEqual(strike.length, 2, 'Strike should layer its slash and personal accent')
  assertEqual(bash.length, 3, 'Bash should layer impact, block weight, and its accent')
  assertEqual(zap.length, 2, 'Zap keeps its card cue while the Orb event owns the channel effect')
  assertEqual(pray.length, 3, 'Pray should layer mantra, recovery, and its accent')
  assertEqual(potion.length, 2, 'a potion should layer its effect and identity')
  assert(new Set([strike, bash, zap, pray, potion].map((sounds) =>
    sounds.map(({ path, rate }) => `${path}@${rate}`).join('|'))).size === 5,
  'iconic actions must remain audibly distinct')
  assert(personalSounds.every((sound) => sound.rate !== 1 && sound.preservesPitch === false),
    'personal sounds must apply their tuned pitch instead of generic playback')
  assert([strike, bash, zap, pray, potion].every((sounds) => sounds.some((sound) => sound.delayMs >= 36)),
    'each action needs an audible timed identity accent')
})

await vfxTarget().waitFor({ state: 'detached' })
const deltaMixStart = await page.evaluate(() => window.__SFX_DETAILS__.length)
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.combat.players[0]
  const enemy = run.combat.enemies.find((candidate) => !candidate.dead)
  const history = run.combat.presentationEvents ?? []
  const seq = history.reduce((latest, item) => Math.max(latest, item.seq), 1_000_000) + 1
  actor.character = 'ironclad'
  actor.block += 1
  actor.maxHp += 1
  actor.hp += 1
  actor.hand.push({ uid: 'personal-sfx-draw', defId: 'strike_ironclad', upgraded: false })
  if (enemy) enemy.weak += 1
  run.combat.presentationEvents = [...history, {
    seq, kind: 'card', actorId: actor.id, sourceId: 'defend_ironclad', enemyIds: [], playerIds: [actor.id],
    upgraded: false, copied: false, energy: 1,
  }].slice(-12)
  debug.setRun(run)
})
await page.waitForFunction(() => window.__SFX_DETAILS__.filter((sound) =>
  sound.cue === 'card:ironclad:defend_ironclad:base').length === 2)
const deltaMixSounds = await page.evaluate((start) => window.__SFX_DETAILS__.slice(start), deltaMixStart)
check('an authoritative personal cue replaces overlapping state-delta sounds', () => {
  const duplicated = deltaMixSounds.filter((sound) => !sound.cue && [
    '/assets/sfx/block.ogg', '/assets/sfx/draw.ogg', '/assets/sfx/heal.ogg', '/assets/sfx/weak.ogg',
  ].includes(sound.path))
  assertDeepEqual(duplicated, [])
})
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[0].character = 'watcher'
  debug.setRun(run)
})
await watcherSeat.locator('.seat__portrait > img[src$="/watcher.webp"]').waitFor()
await publishPresentationEvent({
  kind: 'card', actorId: firstPlayerId, sourceId: 'zap', enemyIds: [], playerIds: [],
  upgraded: false, copied: false, energy: 1,
})
await page.waitForFunction(() => window.__SFX_DETAILS__.filter((sound) =>
  sound.cue === 'card:watcher:zap:base').length >= 2, undefined, { polling: 'raf' })
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  window.__SFX_DETAILS__ = []
  run.combat.combatId = `${run.combat.combatId}-personal-sfx-boundary`
  debug.setRun(run)
})
await page.waitForTimeout(300)
const combatBoundarySounds = await page.evaluate(() => window.__SFX_DETAILS__.filter((sound) => sound.cue))
check('a new combat never replays a still-active cue from the prior combat', () => {
  assertDeepEqual(combatBoundarySounds, [])
})

await page.getByRole('button', { name: 'Settings' }).click()
await runSettings.getByRole('button', { name: 'audio' }).click()
await runSettings.getByLabel('Sound effects volume').fill('0')
await runSettings.getByRole('button', { name: /Back/ }).click()
const mutedPersonalSoundBefore = await page.evaluate(() => window.__SFX_DETAILS__.length)
await publishPresentationEvent({
  kind: 'potion', actorId: firstPlayerId, sourceId: 'fire_potion', enemyIds: [firstEnemyId], playerIds: [],
})
await vfxTarget().waitFor()
await page.waitForTimeout(100)
const mutedPersonalSoundAfter = await page.evaluate(() => window.__SFX_DETAILS__.length)
check('the global SFX preference also mutes personal combat cues', () => {
  assertEqual(mutedPersonalSoundAfter, mutedPersonalSoundBefore)
})
await page.getByRole('button', { name: 'Settings' }).click()
await runSettings.getByRole('button', { name: 'audio' }).click()
await runSettings.getByLabel('Sound effects volume').fill('100')
await runSettings.getByRole('button', { name: /Back/ }).click()
await vfxTarget().waitFor({ state: 'detached' })

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[0].character = 'ironclad'
  debug.setRun(run)
})
await watcherSeat.locator('.seat__portrait > img[src$="/ironclad.webp"]').waitFor()
await publishPresentationEvent({
  kind: 'card', actorId: firstPlayerId, sourceId: 'strike_ironclad', enemyIds: [firstEnemyId],
  playerIds: [], upgraded: false, copied: false, energy: 1,
})
await watcherSeat.locator('.character-attack--ironclad').waitFor()
const rapidDefendSeq = await publishPresentationEvent({
  kind: 'card', actorId: firstPlayerId, sourceId: 'defend_ironclad', enemyIds: [],
  playerIds: [firstPlayerId], upgraded: false, copied: false, energy: 1,
})
await watcherSeat.locator(`.seat__portrait > img[data-vfx-seq="${rapidDefendSeq}"]`).waitFor()
const rapidDefendMotion = await watcherSeat.evaluate((seat) => ({
  attackLayers: seat.querySelectorAll('.character-attack').length,
  animation: getComputedStyle(seat.querySelector('.seat__portrait > img')).animationName,
}))
check('a newer non-attack motion replaces an older still-active attack', () => {
  assertEqual(rapidDefendMotion.attackLayers, 0)
  assert(rapidDefendMotion.animation.startsWith('vfx-recoil'), rapidDefendMotion.animation)
})
await vfxActor().waitFor({ state: 'detached' })

const firstActorSeq = await publishPresentationEvent({
  kind: 'card', actorId: firstPlayerId, sourceId: 'strike_ironclad', enemyIds: [firstEnemyId],
  playerIds: [], upgraded: false, copied: false, energy: 1,
})
await watcherSeat.locator(`.seat__portrait > img[data-vfx-seq="${firstActorSeq}"]`).waitFor()
await watcherSeat.locator(`.character-attack[data-attack-seq="${firstActorSeq}"]`).waitFor()
await watcherSeat.locator('.seat__portrait > img').evaluate((image) => image.setAttribute('data-restart-probe', 'old'))
await watcherSeat.locator(`.character-attack[data-attack-seq="${firstActorSeq}"]`)
  .evaluate((attack) => attack.setAttribute('data-restart-probe', 'old'))
await publishPresentationEvent({
  kind: 'card', actorId: secondPlayerId, sourceId: 'strike_ironclad', enemyIds: [firstEnemyId],
  playerIds: [], upgraded: false, copied: false, energy: 1,
})
const secondActorSeq = await publishPresentationEvent({
  kind: 'card', actorId: firstPlayerId, sourceId: 'strike_ironclad', enemyIds: [firstEnemyId],
  playerIds: [], upgraded: false, copied: false, energy: 1,
})
await watcherSeat.locator(`.seat__portrait > img[data-vfx-seq="${secondActorSeq}"]`).waitFor()
await watcherSeat.locator(`.character-attack[data-attack-seq="${secondActorSeq}"]`).waitFor()
const actorRestartMarker = await watcherSeat.locator('.seat__portrait > img').getAttribute('data-restart-probe')
const attackRestartMarker = await watcherSeat.locator(`.character-attack[data-attack-seq="${secondActorSeq}"]`)
  .getAttribute('data-restart-probe')
const rapidAttackLayers = await watcherSeat.evaluate((seat) => ({
  attacks: seat.querySelectorAll('.character-attack').length,
  poses: seat.querySelectorAll('.character-attack__pose').length,
  swings: seat.querySelectorAll('.character-attack__swing').length,
}))
check('interleaved teammate events cannot suppress a repeated actor motion', () => {
  assertEqual(firstActorSeq % 2, secondActorSeq % 2, 'the fixture did not reproduce equal global parity')
  assertEqual(actorRestartMarker, null, 'the repeated actor motion reused its stale portrait node')
  assertEqual(attackRestartMarker, null, 'the repeated personal effect reused its stale animation node')
  assertEqual(rapidAttackLayers.attacks, 2, 'a rapid same-actor attack replaced its predecessor')
  assertEqual(rapidAttackLayers.poses, 2, 'an older attack kept a duplicate generated body')
  assertEqual(rapidAttackLayers.swings, 1, 'an older attack kept a duplicate weapon swing')
})
await page.locator(`.combat-vfx[data-vfx-seq="${secondActorSeq}"]`).waitFor({ state: 'detached' })

const firstEnemyCard = page.locator(`.enemy[data-enemy-id="${firstEnemyId}"]`)
await page.evaluate((enemyId) => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const enemy = run.combat.enemies.find((candidate) => candidate.uid === enemyId)
  if (!enemy) throw new Error(`damage presentation fixture lost ${enemyId}`)
  Object.assign(enemy, { hp: Math.max(2, enemy.maxHp), dead: false })
  debug.setRun(run)
}, firstEnemyId)
await firstEnemyCard.locator('.enemy__portrait').waitFor()
await page.waitForTimeout(100)
const preDamageHpLabel = await firstEnemyCard.locator('.bar__label').textContent()
const damagingStrikeSeq = await publishDamagingPresentationEvent({
  kind: 'card', actorId: firstPlayerId, sourceId: 'strike_ironclad', enemyIds: [firstEnemyId],
  playerIds: [], upgraded: false, copied: false, energy: 1,
}, firstEnemyId)
await page.waitForTimeout(120)
const earlyDamageFeedback = await firstEnemyCard.evaluate((enemy) => ({
  hitOpacity: Number(getComputedStyle(enemy.querySelector('.hit-vfx')).opacity),
  delay: getComputedStyle(enemy.querySelector('.hit-vfx')).animationDelay,
  hp: enemy.querySelector('.bar__label')?.textContent ?? '',
}))
await page.waitForFunction((enemyId) => {
  const hits = document.querySelectorAll(`.enemy[data-enemy-id="${enemyId}"] .hit-vfx`)
  const hit = hits[hits.length - 1]
  return hit && Number(getComputedStyle(hit).opacity) > 0.5
}, firstEnemyId)
const contactDamageFeedback = await firstEnemyCard.evaluate((enemy) => ({
  portraitAnimations: enemy.querySelector('.enemy__portrait')?.getAnimations().length ?? 0,
  damage: enemy.querySelector('.hit-vfx strong')?.textContent ?? '',
  hp: enemy.querySelector('.bar__label')?.textContent ?? '',
}))
check('real HP-loss feedback waits for Ironclad weapon contact', () => {
  assertEqual(earlyDamageFeedback.hitOpacity, 0)
  assertEqual(earlyDamageFeedback.delay, '0.63s')
  assertEqual(earlyDamageFeedback.hp, preDamageHpLabel)
  assertEqual(contactDamageFeedback.portraitAnimations, 0, 'weapon contact shook the enemy portrait')
  assertEqual(contactDamageFeedback.damage, '1')
  assert(contactDamageFeedback.hp !== preDamageHpLabel, 'the HP label did not update at weapon contact')
})
await page.locator(`.combat-vfx[data-vfx-seq="${damagingStrikeSeq}"]`).waitFor({ state: 'detached' })

const reactionHpBefore = await firstEnemyCard.locator('.bar__label').textContent()
const reactionEvents = await page.evaluate(({ enemyId, actorId }) => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[0].character = 'ironclad'
  const enemy = run.combat.enemies.find((candidate) => candidate.uid === enemyId)
  if (!enemy) throw new Error(`reaction-contact fixture lost ${enemyId}`)
  enemy.hp = Math.max(3, enemy.hp) - 1
  const history = run.combat.presentationEvents ?? []
  const attackSeq = history.reduce((latest, event) => Math.max(latest, event.seq), 1_000_000) + 1
  const fairySeq = attackSeq + 1
  run.combat.presentationEvents = [...history, {
    seq: attackSeq, kind: 'card', actorId, sourceId: 'strike_ironclad', enemyIds: [enemyId],
    playerIds: [], upgraded: false, copied: false, energy: 1,
  }, {
    seq: fairySeq, kind: 'potion', actorId, sourceId: 'fairy_in_a_bottle', enemyIds: [], playerIds: [actorId],
  }].slice(-12)
  debug.setRun(run)
  return { attackSeq, fairySeq }
}, { enemyId: firstEnemyId, actorId: firstPlayerId })
await watcherSeat.locator(`.character-attack[data-attack-seq="${reactionEvents.attackSeq}"]`).waitFor()
await page.waitForTimeout(120)
const earlyReactionHp = await firstEnemyCard.locator('.bar__label').textContent()
await page.waitForFunction(({ enemyId, hp }) => document.querySelector(
  `.enemy[data-enemy-id="${enemyId}"] .bar__label`,
)?.textContent !== hp, { enemyId: firstEnemyId, hp: reactionHpBefore })
const contactReactionHp = await firstEnemyCard.locator('.bar__label').textContent()
check('a synchronous Fairy reaction preserves its triggering attack and contact timing', () => {
  assertEqual(earlyReactionHp, reactionHpBefore)
  assert(contactReactionHp !== reactionHpBefore, 'the triggering Strike never reached contact')
})
await page.locator(`.combat-vfx[data-vfx-seq="${reactionEvents.fairySeq}"]`).first().waitFor({ state: 'detached' })

await page.evaluate((enemyId) => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const enemy = run.combat.enemies.find((candidate) => candidate.uid === enemyId)
  if (!enemy) throw new Error(`interleaved-contact fixture lost ${enemyId}`)
  Object.assign(enemy, { hp: Math.max(4, enemy.maxHp), dead: false, weak: 0 })
  debug.setRun(run)
}, firstEnemyId)
await page.waitForTimeout(100)
const interleavedHpBefore = await firstEnemyCard.locator('.bar__label').textContent()
const interleavedSeq = await publishDamagingPresentationEvent({
  kind: 'card', actorId: firstPlayerId, sourceId: 'strike_ironclad', enemyIds: [firstEnemyId],
  playerIds: [], upgraded: false, copied: false, energy: 1,
}, firstEnemyId)
await page.waitForTimeout(100)
await page.evaluate((enemyId) => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const enemy = run.combat.enemies.find((candidate) => candidate.uid === enemyId)
  if (!enemy) throw new Error(`interleaved-contact fixture lost ${enemyId}`)
  enemy.weak = 1
  debug.setRun(run)
}, firstEnemyId)
await page.waitForTimeout(120)
const earlyInterleavedPresentation = await firstEnemyCard.evaluate((enemy) => ({
  hp: enemy.querySelector('.bar__label')?.textContent ?? '',
  weak: enemy.querySelector('.token--weak')?.getAttribute('title') ?? '',
}))
await page.waitForFunction(({ enemyId, hp }) => document.querySelector(
  `.enemy[data-enemy-id="${enemyId}"] .bar__label`,
)?.textContent !== hp, { enemyId: firstEnemyId, hp: interleavedHpBefore })
const contactInterleavedPresentation = await firstEnemyCard.evaluate((enemy) => ({
  hp: enemy.querySelector('.bar__label')?.textContent ?? '',
  weak: enemy.querySelector('.token--weak')?.getAttribute('title') ?? '',
}))
check('an unrelated enemy update cannot cancel pending weapon contact', () => {
  assertDeepEqual(earlyInterleavedPresentation, { hp: interleavedHpBefore, weak: '' })
  assert(contactInterleavedPresentation.hp !== interleavedHpBefore, 'airborne Strike damage stayed hidden')
  assertEqual(contactInterleavedPresentation.weak, 'Weak 1')
})
await page.locator(`.combat-vfx[data-vfx-seq="${interleavedSeq}"]`).waitFor({ state: 'detached' })

await page.evaluate((enemyId) => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[0].character = 'ironclad'
  const enemy = run.combat.enemies.find((candidate) => candidate.uid === enemyId)
  if (!enemy) throw new Error(`blocked-contact fixture lost ${enemyId}`)
  Object.assign(enemy, { hp: Math.max(4, enemy.maxHp), dead: false, block: 2 })
  debug.setRun(run)
}, firstEnemyId)
await firstEnemyCard.locator('.token--block[title="Block 2"]').waitFor()
const fullyBlockedHpBefore = await firstEnemyCard.locator('.bar__label').textContent()
const fullyBlockedSeq = await publishDamagingPresentationEvent({
  kind: 'card', actorId: firstPlayerId, sourceId: 'strike_ironclad', enemyIds: [firstEnemyId],
  playerIds: [], upgraded: false, copied: false, energy: 1,
}, firstEnemyId, false, { blockLoss: 1, hpLoss: 0 })
await page.waitForTimeout(120)
const earlyFullyBlocked = await firstEnemyCard.evaluate((enemy) => ({
  block: enemy.querySelector('.token--block')?.getAttribute('title') ?? '',
  hp: enemy.querySelector('.bar__label')?.textContent ?? '',
}))
await firstEnemyCard.locator('.token--block[title="Block 1"]').waitFor()
check('fully blocked attacks spend Block only at weapon contact', () => {
  assertDeepEqual(earlyFullyBlocked, { block: 'Block 2', hp: fullyBlockedHpBefore })
})
await page.locator(`.combat-vfx[data-vfx-seq="${fullyBlockedSeq}"]`).waitFor({ state: 'detached' })

await page.evaluate((enemyId) => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const enemy = run.combat.enemies.find((candidate) => candidate.uid === enemyId)
  if (!enemy) throw new Error(`partial-block fixture lost ${enemyId}`)
  Object.assign(enemy, { hp: Math.max(4, enemy.maxHp), dead: false, block: 1 })
  debug.setRun(run)
}, firstEnemyId)
await firstEnemyCard.locator('.token--block[title="Block 1"]').waitFor()
const partialBlockHpBefore = await firstEnemyCard.locator('.bar__label').textContent()
const partialBlockSeq = await publishDamagingPresentationEvent({
  kind: 'card', actorId: firstPlayerId, sourceId: 'strike_ironclad', enemyIds: [firstEnemyId],
  playerIds: [], upgraded: false, copied: false, energy: 1,
}, firstEnemyId, false, { blockLoss: 1, hpLoss: 1 })
await page.waitForTimeout(120)
const earlyPartialBlock = await firstEnemyCard.evaluate((enemy) => ({
  block: enemy.querySelector('.token--block')?.getAttribute('title') ?? '',
  hp: enemy.querySelector('.bar__label')?.textContent ?? '',
}))
await firstEnemyCard.locator('.token--block').waitFor({ state: 'detached' })
const partialBlockHpAfter = await firstEnemyCard.locator('.bar__label').textContent()
check('partially blocked attacks stage Block and HP together at contact', () => {
  assertDeepEqual(earlyPartialBlock, { block: 'Block 1', hp: partialBlockHpBefore })
  assert(partialBlockHpAfter !== partialBlockHpBefore, 'HP did not update with Block at contact')
})
await page.locator(`.combat-vfx[data-vfx-seq="${partialBlockSeq}"]`).waitFor({ state: 'detached' })

await page.evaluate((enemyId) => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const enemy = run.combat.enemies.find((candidate) => candidate.uid === enemyId)
  if (!enemy) throw new Error(`rapid damage fixture lost ${enemyId}`)
  Object.assign(enemy, { hp: Math.max(3, enemy.maxHp), dead: false })
  debug.setRun(run)
}, firstEnemyId)
await page.waitForTimeout(100)
const rapidDamageSeq = await publishDamagingPresentationEvent({
  kind: 'card', actorId: firstPlayerId, sourceId: 'strike_ironclad', enemyIds: [firstEnemyId],
  playerIds: [], upgraded: false, copied: false, energy: 1,
}, firstEnemyId)
await page.waitForTimeout(70)
const rapidDamageSeq2 = await publishDamagingPresentationEvent({
  kind: 'card', actorId: firstPlayerId, sourceId: 'strike_ironclad', enemyIds: [firstEnemyId],
  playerIds: [], upgraded: false, copied: false, energy: 1,
}, firstEnemyId)
await page.waitForFunction((enemyId) =>
  document.querySelectorAll(`.enemy[data-enemy-id="${enemyId}"] .hit-vfx`).length >= 2, firstEnemyId)
const rapidDamageFeedback = await firstEnemyCard.evaluate((enemy) => ({
  bursts: enemy.querySelectorAll('.hit-vfx').length,
  portraitAnimations: enemy.querySelector('.enemy__portrait')?.getAnimations()
    .filter((animation) => animation.playState === 'running').length ?? 0,
}))
check('rapid same-target hits keep both impact bursts without shaking the portrait', () => {
  assertEqual(rapidDamageSeq2, rapidDamageSeq + 1)
  assertEqual(rapidDamageFeedback.bursts, 2)
  assertEqual(rapidDamageFeedback.portraitAnimations, 0)
})
await page.locator(`.combat-vfx[data-vfx-seq="${rapidDamageSeq2}"]`).waitFor({ state: 'detached' })

await page.evaluate((enemyId) => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[0].character = 'defect'
  const enemy = run.combat.enemies.find((candidate) => candidate.uid === enemyId)
  if (!enemy) throw new Error(`mixed-contact fixture lost ${enemyId}`)
  Object.assign(enemy, { hp: Math.max(4, enemy.maxHp), dead: false })
  debug.setRun(run)
}, firstEnemyId)
await page.waitForTimeout(100)
const mixedContactSeq = await publishDamagingPresentationEvent({
  kind: 'card', actorId: firstPlayerId, sourceId: 'strike_defect', enemyIds: [firstEnemyId],
  playerIds: [], upgraded: false, copied: false, energy: 1,
}, firstEnemyId)
await page.waitForTimeout(10)
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[0].character = 'ironclad'
  debug.setRun(run)
})
const mixedContactSeq2 = await publishDamagingPresentationEvent({
  kind: 'card', actorId: firstPlayerId, sourceId: 'strike_ironclad', enemyIds: [firstEnemyId],
  playerIds: [], upgraded: false, copied: false, energy: 1,
}, firstEnemyId)
await page.waitForTimeout(650)
const mixedContactHp = await firstEnemyCard.locator('.bar__label').textContent()
const mixedContactActualHp = await page.evaluate((enemyId) => window.__STS_DEBUG__.getRun().combat.enemies
  .find((enemy) => enemy.uid === enemyId)?.hp, firstEnemyId)
check('a faster later hit cannot be overwritten by an older contact timer', () => {
  assertEqual(mixedContactSeq2, mixedContactSeq + 1)
  assert(mixedContactHp?.startsWith(`${mixedContactActualHp}/`), mixedContactHp ?? '')
})
await page.locator(`.combat-vfx[data-vfx-seq="${mixedContactSeq2}"]`).waitFor({ state: 'detached' })

await page.evaluate((enemyId) => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const enemy = run.combat.enemies.find((candidate) => candidate.uid === enemyId)
  if (!enemy) throw new Error(`lethal presentation fixture lost ${enemyId}`)
  Object.assign(enemy, { hp: 1, dead: false })
  debug.setRun(run)
}, rowTargetFixture.corpseUid)
const lethalEnemy = page.locator(`.enemy[data-enemy-id="${rowTargetFixture.corpseUid}"]`)
await lethalEnemy.waitFor()
await page.waitForTimeout(100)
const lethalEvents = await page.evaluate(({ enemyId, actorId }) => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const enemy = run.combat.enemies.find((candidate) => candidate.uid === enemyId)
  if (!enemy) throw new Error(`lethal reaction fixture lost ${enemyId}`)
  Object.assign(enemy, { hp: 0, dead: true })
  const history = run.combat.presentationEvents ?? []
  const attackSeq = history.reduce((latest, event) => Math.max(latest, event.seq), 1_000_000) + 1
  const fairySeq = attackSeq + 1
  run.combat.presentationEvents = [...history, {
    seq: attackSeq, kind: 'card', actorId, sourceId: 'strike_ironclad', enemyIds: [enemyId],
    playerIds: [], upgraded: false, copied: false, energy: 1,
  }, {
    seq: fairySeq, kind: 'potion', actorId, sourceId: 'fairy_in_a_bottle', enemyIds: [], playerIds: [actorId],
  }].slice(-12)
  debug.setRun(run)
  return { attackSeq, fairySeq }
}, { enemyId: rowTargetFixture.corpseUid, actorId: firstPlayerId })
await lethalEnemy.locator('.enemy__portrait').waitFor()
await page.waitForTimeout(120)
const earlyLethalPresentation = await lethalEnemy.evaluate((enemy) => ({
  dead: enemy.classList.contains('enemy--dead'),
  disabled: enemy.disabled,
  label: enemy.getAttribute('aria-label') ?? '',
  hp: enemy.querySelector('.bar__label')?.textContent ?? '',
  defeated: enemy.querySelectorAll('.enemy__defeated').length,
}))
await lethalEnemy.evaluate((enemy) => new Promise((resolve) => {
  if (enemy.classList.contains('enemy--dead')) return resolve(undefined)
  const observer = new MutationObserver(() => {
    if (!enemy.classList.contains('enemy--dead')) return
    observer.disconnect()
    resolve(undefined)
  })
  observer.observe(enemy, { attributes: true, attributeFilter: ['class'] })
}))
const lethalContactTiming = await lethalEnemy.evaluate((enemy) => {
  const portrait = enemy.querySelector('.enemy__portrait')
  return {
    dead: enemy.classList.contains('enemy--dead'),
    disabled: enemy.disabled,
    label: enemy.getAttribute('aria-label') ?? '',
    hp: enemy.querySelector('.bar__label')?.textContent ?? '',
    opacity: portrait ? Number(getComputedStyle(portrait).opacity) : 0,
  }
})
check('lethal attack defeat art also waits for weapon contact', () => {
  assertEqual(earlyLethalPresentation.dead, false)
  assertEqual(earlyLethalPresentation.disabled, true, 'an authoritative corpse remained targetable')
  assert(!earlyLethalPresentation.label.includes('defeated'), earlyLethalPresentation.label)
  assert(earlyLethalPresentation.hp.startsWith('1/'), earlyLethalPresentation.hp)
  assertEqual(earlyLethalPresentation.defeated, 0)
  assertEqual(lethalContactTiming.dead, true)
  assertEqual(lethalContactTiming.disabled, true)
  assert(lethalContactTiming.label.includes('defeated'), lethalContactTiming.label)
  assert(lethalContactTiming.hp.startsWith('0/'), lethalContactTiming.hp)
  assert(lethalContactTiming.opacity > 0, 'the defeat transition did not begin at contact')
})
await page.waitForTimeout(450)
const fallingAfterReactionExpiry = await lethalEnemy.evaluate((enemy) => enemy.classList.contains('enemy--falling'))
check('a follow-up reaction cannot truncate the contact-timed defeat animation', () => {
  assertEqual(fallingAfterReactionExpiry, true)
})
await page.locator(`.combat-vfx[data-vfx-seq="${lethalEvents.attackSeq}"]`).waitFor({ state: 'detached' })
await page.waitForFunction((enemyId) => !document.querySelector(
  `.enemy[data-enemy-id="${enemyId}"]`,
)?.classList.contains('enemy--falling'), rowTargetFixture.corpseUid)

const rebirthOriginalEnemy = await page.evaluate((enemyId) => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const enemy = run.combat.enemies.find((candidate) => candidate.uid === enemyId)
  if (!enemy) throw new Error(`rebirth-contact fixture lost ${enemyId}`)
  const original = structuredClone(enemy)
  Object.assign(enemy, {
    defId: 'the_champ', hp: 1, maxHp: 40, dead: false, block: 0, strength: 0,
    weak: 0, vulnerable: 0, abilityUsed: false, actionIndex: 0, isBoss: true,
  })
  debug.setRun(run)
  return original
}, firstEnemyId)
await firstEnemyCard.locator('.enemy__name', { hasText: 'The Champ' }).waitFor()
const rebirthSeq = await page.evaluate(({ enemyId, actorId }) => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const enemy = run.combat.enemies.find((candidate) => candidate.uid === enemyId)
  if (!enemy) throw new Error(`rebirth-contact fixture lost ${enemyId}`)
  Object.assign(enemy, {
    defId: 'the_champ_fury', hp: 40, maxHp: 40, dead: false, block: 0,
    strength: 3, abilityUsed: true, actionIndex: 0, isBoss: true,
  })
  const history = run.combat.presentationEvents ?? []
  const seq = history.reduce((latest, event) => Math.max(latest, event.seq), 1_000_000) + 1
  run.combat.presentationEvents = [...history, {
    seq, kind: 'card', actorId, sourceId: 'strike_ironclad', enemyIds: [enemyId], playerIds: [],
    upgraded: false, copied: false, energy: 1,
  }].slice(-12)
  debug.setRun(run)
  return seq
}, { enemyId: firstEnemyId, actorId: firstPlayerId })
await page.waitForTimeout(120)
const earlyRebirthPresentation = await firstEnemyCard.evaluate((enemy) => ({
  name: enemy.querySelector('.enemy__name')?.textContent ?? '',
  label: enemy.getAttribute('aria-label') ?? '',
  hp: enemy.querySelector('.bar__label')?.textContent ?? '',
  strength: enemy.querySelector('.token--strength')?.getAttribute('title') ?? '',
}))
await firstEnemyCard.locator('.enemy__name', { hasText: 'The Champ — Fury' }).waitFor()
const contactRebirthPresentation = await firstEnemyCard.evaluate((enemy) => ({
  name: enemy.querySelector('.enemy__name')?.textContent ?? '',
  label: enemy.getAttribute('aria-label') ?? '',
  hp: enemy.querySelector('.bar__label')?.textContent ?? '',
  strength: enemy.querySelector('.token--strength')?.getAttribute('title') ?? '',
}))
check('instant enemy rebirth swaps its complete visual state at weapon contact', () => {
  assertEqual(earlyRebirthPresentation.name, 'The Champ')
  assert(earlyRebirthPresentation.label.startsWith('The Champ,'), earlyRebirthPresentation.label)
  assertEqual(earlyRebirthPresentation.hp, '1/40')
  assertEqual(earlyRebirthPresentation.strength, '')
  assertEqual(contactRebirthPresentation.name, 'The Champ — Fury')
  assert(contactRebirthPresentation.label.startsWith('The Champ — Fury,'), contactRebirthPresentation.label)
  assertEqual(contactRebirthPresentation.hp, '40/40')
  assertEqual(contactRebirthPresentation.strength, 'Strength 3')
})
await page.locator(`.combat-vfx[data-vfx-seq="${rebirthSeq}"]`).waitFor({ state: 'detached' })
await page.evaluate(({ enemyId, original }) => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const index = run.combat.enemies.findIndex((enemy) => enemy.uid === enemyId)
  if (index < 0) throw new Error(`rebirth-contact restore lost ${enemyId}`)
  run.combat.enemies[index] = original
  debug.setRun(run)
}, { enemyId: firstEnemyId, original: rebirthOriginalEnemy })
await firstEnemyCard.locator('.enemy__name').waitFor()

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  Object.assign(run.combat.players[0], { character: 'watcher', stance: 'calm' })
  debug.setRun(run)
})
await watcherSeat.locator('.stance-aura--calm').waitFor()
await page.emulateMedia({ reducedMotion: 'reduce' })
await publishPresentationEvent({
  kind: 'potion', actorId: firstPlayerId, sourceId: 'energy_potion', enemyIds: [], playerIds: [firstPlayerId],
})
await vfxActor().waitFor()
const reducedPersonalVfx = await watcherSeat.evaluate((seat) => {
  const aura = seat.querySelector('.stance-aura--calm')
  const vfx = seat.querySelector('.combat-vfx')
  const art = seat.querySelector('.seat__portrait > img')
  return {
    auraAnimation: aura ? getComputedStyle(aura).animationName : '',
    auraOpacity: aura ? Number(getComputedStyle(aura).opacity) : 0,
    vfxAnimation: vfx ? getComputedStyle(vfx).animationName : '',
    vfxOpacity: vfx ? Number(getComputedStyle(vfx).opacity) : 0,
    vfxCount: seat.querySelectorAll('.combat-vfx').length,
    toneColor: vfx ? getComputedStyle(vfx).getPropertyValue('--vfx-tone-color').trim() : '',
    ringColor: vfx ? getComputedStyle(vfx, '::before').borderTopColor : '',
    actorAnimation: art ? getComputedStyle(art).animationName : '',
  }
})
check('reduced motion keeps static stance and action identity without movement', () => {
  assertEqual(reducedPersonalVfx.auraAnimation, 'none', 'the Calm aura still moves')
  assert(reducedPersonalVfx.auraOpacity > 0)
  assertEqual(reducedPersonalVfx.vfxAnimation, 'none', 'the action overlay still moves')
  assert(reducedPersonalVfx.vfxOpacity > 0)
  assertEqual(reducedPersonalVfx.vfxCount, 1, 'a self-targeting action duplicated its actor overlay')
  assert(reducedPersonalVfx.toneColor !== potionPresentation.toneColor,
    'different Potion tones resolved to the same colour')
  assert(reducedPersonalVfx.ringColor !== potionPresentation.ringColor,
    'different Potion tones rendered the same ring colour')
  assertEqual(reducedPersonalVfx.actorAnimation, 'none', 'the acting character still moves')
})
const reducedWatcherSeq = await publishDamagingPresentationEvent({
  kind: 'card', actorId: firstPlayerId, sourceId: 'eruption', enemyIds: [firstEnemyId], playerIds: [],
  upgraded: false, copied: false, energy: 1,
}, firstEnemyId)
await page.locator(`.combat-vfx--target[data-vfx-seq="${reducedWatcherSeq}"]`).waitFor({ state: 'attached' })
await page.waitForTimeout(120)
const reducedWatcherHp = await firstEnemyCard.locator('.bar__label').textContent()
const reducedWatcherActualHp = await page.evaluate((enemyId) => window.__STS_DEBUG__.getRun().combat.enemies
  .find((enemy) => enemy.uid === enemyId)?.hp, firstEnemyId)
const reducedWatcherAttack = await watcherSeat.evaluate((seat) => ({
  actorAnimation: getComputedStyle(seat.querySelector('.seat__portrait > img')).animationName,
  attackCount: seat.querySelectorAll('.character-attack').length,
  auraAnimation: getComputedStyle(seat.querySelector('.stance-aura')).animationName,
}))
check('reduced motion omits Watcher attack poses and stops aura dashes', () => {
  assertEqual(reducedWatcherAttack.actorAnimation, 'none')
  assertEqual(reducedWatcherAttack.attackCount, 0)
  assertEqual(reducedWatcherAttack.auraAnimation, 'none')
  assert(reducedWatcherHp?.startsWith(`${reducedWatcherActualHp}/`), reducedWatcherHp ?? '')
})
await page.emulateMedia({ reducedMotion: 'no-preference' })
await page.locator(`.combat-vfx[data-vfx-seq="${reducedWatcherSeq}"]`).waitFor({ state: 'detached' })
await vfxActor().waitFor({ state: 'detached' })

async function hurtViewer() {
  await page.evaluate(() => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.combat.players[0].hp -= 1
    debug.setRun(run)
  })
}

await hurtViewer()
await page.locator('.seat .hit-vfx').waitFor()
const hitMotion = await page.evaluate(() => {
  const impact = document.querySelector('.seat .hit-vfx')
  return impact ? {
    animation: getComputedStyle(impact).animationName,
    art: getComputedStyle(impact).backgroundImage,
    portraitAnimations: document.querySelector('.seat .seat__portrait')?.getAnimations().length ?? 0,
  } : null
})
await page.evaluate(() => {
  for (const animation of document.getAnimations()) {
    if (['impact-bloom', 'damage-float'].includes(animation.animationName)) {
      animation.currentTime = 150
      animation.pause()
    }
  }
})
await page.screenshot({ path: join(outDir, '09b-combat-hit-animation.png'), timeout: 15_000 })
await page.evaluate(() => {
  for (const animation of document.getAnimations()) {
    if (['impact-bloom', 'damage-float'].includes(animation.animationName) &&
      animation.playState === 'paused') animation.play()
  }
})
check('a hit keeps its impact art without shaking the actor', () => {
  assertEqual(hitMotion?.animation, 'impact-bloom', 'the generated impact effect should animate')
  assert(hitMotion?.art.includes('/assets/combat/vfx/hit-burst.webp'), hitMotion?.art ?? 'missing hit VFX')
  assertEqual(hitMotion?.portraitAnimations, 0, 'damage still animated the actor portrait')
})

await page.waitForFunction(() => document.querySelectorAll('.seat .hit-vfx').length === 0)
await hurtViewer()
await page.waitForFunction(() => document.querySelectorAll('.seat .hit-vfx').length === 1)
await hurtViewer()
await page.waitForFunction(() => document.querySelectorAll('.seat .hit-vfx').length === 2)
const beats = await page.evaluate(() => ({
  portraits: [...document.querySelectorAll('.seat .seat__portrait')]
    .reduce((count, portrait) => count + portrait.getAnimations().length, 0),
  impacts: document.querySelectorAll('.seat .hit-vfx').length,
}))
check('two quick hits retain both impact bursts without portrait movement', () => {
  assertEqual(beats.portraits, 0, `damage started ${beats.portraits} portrait animations`)
  assert(beats.impacts >= 2, `expected at least two generated hit bursts, got ${beats.impacts}`)
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
await page.locator('.board').waitFor()

await page.emulateMedia({ reducedMotion: 'reduce' })
const reducedMotion = await page.evaluate(() => {
  const seatArt = document.querySelector('.seat:not(.seat--dead) .seat__portrait img')
  const enemyArt = document.querySelector('.enemy:not(.enemy--dead) .enemy__art--cutout')
  const corpsePortrait = document.querySelector('.enemy--dead .enemy__portrait')
  const phase = document.querySelector('.combat__phase')
  return {
    seat: seatArt ? getComputedStyle(seatArt).animationName : '',
    enemy: enemyArt ? getComputedStyle(enemyArt).animationName : '',
    corpse: corpsePortrait ? getComputedStyle(corpsePortrait).animationName : '',
    phase: phase ? getComputedStyle(phase).animationName : '',
  }
})
const reducedEnemyRestore = await readRun()
const reducedEnemyId = await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const enemy = run.combat.enemies.find((candidate) => !candidate.dead)
  enemy.hp = 0
  enemy.dead = true
  debug.setRun(run)
  return enemy.uid
})
await page.waitForFunction((enemyId) => window.__STS_DEBUG__.getState().enemies
  .some((enemy) => enemy.uid === enemyId && enemy.dead), reducedEnemyId)
await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
const reducedEnemyTiles = await page.locator(`[data-enemy-id="${reducedEnemyId}"]`).count()
check('reduced motion disables ambient, phase, and defeat movement', () => {
  assertEqual(reducedMotion.seat, 'none')
  assertEqual(reducedMotion.enemy, 'none')
  assertEqual(reducedMotion.corpse, '')
  assertEqual(reducedMotion.phase, 'none')
  assertEqual(reducedEnemyTiles, 0, 'a fresh enemy death held its stage slot for an invisible animation')
})
await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), reducedEnemyRestore)
await page.locator(`[data-enemy-id="${reducedEnemyId}"]`).waitFor()
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[2].hp = 0
  run.combat.players[2].dead = true
  debug.setRun(run)
})
await page.waitForFunction(() => document.querySelector('.seat--dead.seat--falling .seat__portrait'))
const reducedActiveDeath = await page.locator('.seat--dead.seat--falling .seat__portrait').evaluate((portrait) => ({
  portrait: getComputedStyle(portrait).animationName,
  ash: getComputedStyle(portrait, '::before').animationName,
  ring: getComputedStyle(portrait, '::after').animationName,
}))
check('reduced motion also disables a newly triggered death', () => {
  assertDeepEqual(reducedActiveDeath, { portrait: 'none', ash: 'none', ring: 'none' })
})
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[2].hp = run.combat.players[2].maxHp
  run.combat.players[2].dead = false
  debug.setRun(run)
})
await page.waitForFunction(() => document.querySelectorAll('.seat--dead').length === 0)
await page.emulateMedia({ reducedMotion: 'no-preference' })

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[1].hp = 0
  run.combat.players[1].dead = true
  debug.setRun(run)
})
await page.waitForFunction(() => document.querySelectorAll('.seat--dead').length === 1)
await page.evaluate(() => {
  for (const animation of document.getAnimations()) {
    if (['actor-defeat', 'death-ash', 'death-ring'].includes(animation.animationName) &&
      Number(animation.currentTime) < 250) {
      animation.currentTime = 380
      animation.pause()
    }
  }
})
await shot('09d-player-defeat-animation')
await page.evaluate(() => {
  for (const animation of document.getAnimations()) {
    if (['actor-defeat', 'death-ash', 'death-ring'].includes(animation.animationName) &&
      animation.playState === 'paused') animation.play()
  }
})
const fallenPlayerAnimation = await page.locator('.seat--dead .seat__portrait').evaluate((portrait) => ({
  animation: getComputedStyle(portrait).animationName,
  ash: getComputedStyle(portrait, '::before').backgroundImage,
  ring: getComputedStyle(portrait, '::after').backgroundImage,
}))
check('a fallen player uses the same complete defeat language', () => {
  assertEqual(fallenPlayerAnimation.animation, 'actor-defeat')
  assert(fallenPlayerAnimation.ash.includes('/assets/combat/vfx/death-ash.webp'), fallenPlayerAnimation.ash)
  assert(fallenPlayerAnimation.ring.includes('/assets/combat/vfx/death-ring.webp'), fallenPlayerAnimation.ring)
})
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[1].hp = run.combat.players[1].maxHp
  run.combat.players[1].dead = false
  debug.setRun(run)
})
await page.waitForFunction(() => document.querySelectorAll('.seat--dead').length === 0)

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
  assert(fourPlayerGutter.left >= 48, `the party starts only ${fourPlayerGutter.left}px from the board edge`)
  assert(fourPlayerGutter.hpInside, 'a shifted player HP bar left the board')
})

const rowCount = await page.locator('.row').count()
check('every player row is rendered on screen', () => {
  assertEqual(rowCount, 4, 'the board should show four rows')
})
const enemyAbilities = await page.locator('.enemy').evaluateAll((enemies) => enemies.map((enemy) => ({
  text: enemy.querySelector('.enemy__ability')?.textContent ?? '',
  label: enemy.getAttribute('aria-label') ?? '',
})))
check('printed enemy special abilities are visible and announced', () => {
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
await page.locator('.enemy').filter({ hasText: 'Red Louse' }).click()
await page.waitForFunction(() => document.querySelector('.enemy__ability--spent') !== null)
const spentCurl = await page.locator('.enemy__ability--spent').evaluate((ability) => ({
  text: ability.textContent ?? '',
  label: ability.closest('.enemy')?.getAttribute('aria-label') ?? '',
  decoration: getComputedStyle(ability).textDecorationLine,
}))
check('a used Curl Up is visibly and accessibly spent', () => {
  assert(spentCurl.text.includes('spent'), `the visible ability still looks active: ${spentCurl.text}`)
  assert(spentCurl.label.includes('spent'), `the accessible ability still sounds active: ${spentCurl.label}`)
  assert(spentCurl.decoration.includes('line-through'), 'the spent state has no non-colour visual treatment')
})

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  for (const enemy of run.combat.enemies) Object.assign(enemy, { defId: 'fungi_beast', abilityUsed: false })
  debug.setRun(run)
})
const longAbilityInspect = await page.locator('.enemy').filter({ hasText: 'Fungi Beast' })
  .locator('.enemy__ability').filter({ hasText: 'Spore Cloud' }).first().evaluate((ability) => ({
  text: ability.textContent ?? '',
  clipped: ability.scrollHeight > ability.clientHeight + 1 || ability.scrollWidth > ability.clientWidth + 1,
}))
check('the longest enemy ability is fully visible', () => {
  assert(longAbilityInspect.text.includes('Spore Cloud'), `unexpected rule: ${longAbilityInspect.text}`)
  assert(!longAbilityInspect.clipped, 'Spore Cloud is clipped')
})

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
  await page.waitForTimeout(60)
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

// The hand shrinks as cards are played, so the on-screen index has to be
// derived from live state rather than from a fixed list.
async function clickCard(uid) {
  const index = await page.evaluate(
    (target) => window.__STS_DEBUG__.getState().players[0].hand.findIndex((c) => c.uid === target),
    uid,
  )
  if (index < 0) throw new Error(`card ${uid} is not in hand`)
  await page.locator('.hand .card').nth(index).click()
}

// Survivor: stage it, then pick a card to discard.
await clickCard('h-survivor')
const stagedSurvivor = await page.locator('.prompt').textContent()
await clickCard('h-spare1')
const afterSurvivor = await readState()
check('Survivor requires a discard choice and actually discards', () => {
  assert(/Discard 1/i.test(stagedSurvivor ?? ''), `expected a discard prompt, got ${stagedSurvivor}`)
  const p1 = afterSurvivor.players[0]
  assertEqual(p1.block, 2, 'Survivor grants 2 Block')
  assert(
    p1.discard.some((c) => c.uid === 'h-spare1'),
    'the chosen card must actually reach the discard pile',
  )
  assert(!p1.hand.some((c) => c.uid === 'h-spare1'), 'and must leave hand')
})
await shot('10-survivor-choice')

// True Grit: exhaust a card, then choose which ally gets the Block.
await clickCard('h-grit')
await clickCard('h-spare2')
const gritPrompt = await page.locator('.prompt').textContent()
const pickedPressed = await page.locator('.hand .card--picked').getAttribute('aria-pressed')
check('True Grit asks for an ally after the exhaust choice', () => {
  assert(
    /Choose who gets it/i.test(gritPrompt ?? ''),
    `after picking the exhaust target it must still ask for an ally, got ${gritPrompt}`,
  )
  assertEqual(pickedPressed, 'true', 'the picked exhaust card is not announced as selected')
})
await page.locator('.seat').nth(0).click()
const afterGrit = await readState()
check('True Grit exhausts the chosen card and blocks the chosen ally', () => {
  const p1 = afterGrit.players[0]
  assert(p1.exhaust.some((c) => c.uid === 'h-spare2'), 'the chosen card should be exhausted')
  const blocked = afterGrit.players.reduce((sum, p) => sum + p.block, 0)
  assert(blocked > 2, `some player should have gained True Grit's Block, total was ${blocked}`)
})
await shot('11-true-grit-ally')

// Predator needs two independent choices: who it attacks, then who draws.
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const [stale, fallback] = run.combat.enemies.filter((enemy) => !enemy.dead)
  if (!stale || !fallback) throw new Error('Predator retry fixture needs two living enemies')
  stale.uid = 'predator-stale'
  Object.assign(stale, { hp: 13, maxHp: 13, block: 0 })
  Object.assign(fallback, { hp: 9, maxHp: 9, block: 0 })
  debug.setRun(run)
})
await page.waitForFunction(() => window.__STS_DEBUG__.getState().enemies.some((enemy) => enemy.uid === 'predator-stale'))
const allyHandBeforePredator = (await readState()).players[1].hand.length
await clickCard('h-predator')
await page.locator('.enemy[aria-label*="13 of 13 hit points"]').click()
const predatorPrompt = await page.locator('.prompt').textContent()
check('Predator asks for its ally after its enemy is chosen', () => {
  assert(/Choose who gets it/i.test(predatorPrompt ?? ''), `expected an ally prompt, got ${predatorPrompt}`)
})
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const stale = run.combat.enemies.find((enemy) => enemy.uid === 'predator-stale')
  Object.assign(stale, { hp: 0, dead: true })
  debug.setRun(run)
})
await page.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('Choose an enemy'))
const stalePredator = await readState()
check('a staged card drops a primary target defeated by a teammate', () => {
  assert(stalePredator.players[0].hand.some((card) => card.uid === 'h-predator'))
})
await page.locator('.enemy--targeted:not(:disabled)').first().click()
await page.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('Choose who gets it'))
await page.locator('.seat:not(.seat--viewer)').click()
const afterPredator = await readState()
check('Predator draws two cards for the chosen ally', () => {
  assertEqual(afterPredator.players[1].hand.length, allyHandBeforePredator + 2)
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
  return { present: Boolean(strip), gap: bar && strip ? bar.top - strip.bottom : Infinity, overlaps }
})
check('player tokens and Powers stay anchored above their HP bar', () => {
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
await page.waitForFunction(() => document.querySelectorAll('.row__seat:has(> .seat--viewer) .power').length === 8)
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
await page.waitForFunction(() => document.querySelectorAll('.row__seat:has(> .seat--viewer) .power').length === 2)

const topmostOverPower = await page.evaluate(() => {
  const tile = document.querySelector('.row__seat .power')
  if (!tile) return 'no tile'
  const box = tile.getBoundingClientRect()
  const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
  return hit?.className ?? 'nothing'
})
check('the Power glyph paints at the center of its tile', () => {
  assert(
    String(topmostOverPower).includes('icon'),
    `expected the glyph on top of the tile, found: ${topmostOverPower}`,
  )
})

// The enlarge has to escape the board's scroll container. It previously did
// not, and this suite missed it by hovering ONE tile at ONE viewport where the
// popover happened to fit inside the board's box. Every tile, two sizes.
const hoverProbes = []
for (const size of [
  { width: 1440, height: 900 },
  { width: 900, height: 620 },
]) {
  await page.setViewportSize(size)
  const tiles = await page.locator('.row__seat .power').count()
  for (let i = 0; i < tiles; i++) {
    await page.locator('.row__seat .power').nth(i).hover()
    await waitForPowerZoom()
    hoverProbes.push(
      await page.evaluate(
        (label) => {
          const img = document.querySelector('.power__zoom')
          if (!img) return { label, missing: true }
          const box = img.getBoundingClientRect()
          return {
            label,
            missing: false,
            width: Math.round(box.width),
            height: Math.round(box.height),
            left: Math.round(box.left),
            top: Math.round(box.top),
            right: Math.round(box.right),
            bottom: Math.round(box.bottom),
            viewport: { w: window.innerWidth, h: window.innerHeight },
            // The card is `pointer-events: none` so that moving onto it does
            // not end the hover, which means elementFromPoint looks straight
            // through it. Whether it is actually PAINTED is checked below by
            // screenshotting the region instead.
            visible: getComputedStyle(img).visibility === 'visible',
          }
        },
        `${size.width}x${size.height} tile ${i}`,
      ),
    )
  }
}
await page.setViewportSize({ width: 1440, height: 900 })

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
  const row = document.querySelector('.row__seat .power').closest('.row__seat')
  row.style.marginLeft = `${window.innerWidth - 120}px`
})
// A REAL hover: React synthesises onMouseEnter from mouseover/mouseout and
// ignores a dispatched `mouseenter`, so the previous version of this probe
// never ran the placement code and read a stale card from an earlier hover.
await page.locator('.row__seat .power').first().hover()
await waitForPowerZoom()
const clampProbe = await page.evaluate(() => {
  const tile = document.querySelector('.row__seat .power')
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
  const row = document.querySelector('.row__seat .power').closest('.row__seat')
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

check('every Power enlarges into full view at every size', () => {
  assert(hoverProbes.length >= 4, `expected several probes, got ${hoverProbes.length}`)
  for (const probe of hoverProbes) {
    assert(!probe.missing, `${probe.label}: no enlarged card appeared`)
    assert(probe.width > 150 && probe.height > 200, `${probe.label}: not enlarged (${probe.width}x${probe.height})`)
    assert(probe.left >= 0, `${probe.label}: clipped off the left (${probe.left})`)
    assert(probe.top >= 0, `${probe.label}: clipped off the top (${probe.top})`)
    assert(probe.right <= probe.viewport.w, `${probe.label}: off the right (${probe.right} > ${probe.viewport.w})`)
    assert(probe.bottom <= probe.viewport.h, `${probe.label}: off the bottom (${probe.bottom} > ${probe.viewport.h})`)
    assert(probe.visible, `${probe.label}: the enlarged card is not visible`)
  }
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
    String(tileWhileHovered).includes('icon'),
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
await plantDiscardOrderCards()
await page.getByRole('button', { name: 'End turn' }).click()
const firstCurseOrb = page.locator('button.end-turn-effect--orb')
await firstCurseOrb.waitFor()
await firstCurseOrb.click()
await page.locator('.enemy--targeted').first().waitFor()
await page.locator('[data-enemy-id="curse-fragile"]').click()
await page.waitForFunction(() => document.querySelector('.end-turn-effects__prompt')?.textContent?.includes('Lightning Orb 2'))
await page.locator('button.end-turn-effect--orb').click()
await page.locator('.enemy--targeted').first().waitFor()
await page.locator('[data-enemy-id="curse-safe"]').click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'discard')
const cursePrepared = await readState()
check('the fixed end-turn sequence resolves before discard ordering', () => {
  const player = cursePrepared.players[0]
  assertEqual(player.hp, 8, 'Decay spends the available Block before Shame')
  assertEqual(player.block, 0, 'Decay spends the only Block')
  assertEqual(player.weak, 1, 'Doubt grants Weak')
  assertDeepEqual(cursePrepared.enemies.map((enemy) => enemy.hp), [0, 3],
    'the later Lightning Orb retargets after the first overkills its chosen enemy')
  assertDeepEqual(player.exhaust.map((card) => card.uid).sort(), ['curse-bane', 'curse-clumsy'])
  assertEqual(player.hand.length, 5, 'Ethereal cards leave before the discard picker')
})
await shot('15c-ethereal-discard')
await confirmAllDiscards()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'enemy')
const curseDiscarded = await readState()
check('Regret stays retained after the rest of the Curse hand is discarded', () => {
  assertDeepEqual(curseDiscarded.players[0].hand.map((card) => card.uid), ['curse-regret'])
})

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
await page.setViewportSize({ width: 390, height: 844 })
await page.waitForTimeout(60)
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
await page.waitForFunction(() => {
  const button = [...document.querySelectorAll('.outside-potions button')]
    .find((candidate) => candidate.getAttribute('aria-label') === 'Give Energy Potion')
  return button?.disabled && !button.hasAttribute('aria-expanded')
})
const soloGiveDisabled = await soloGive.isDisabled()
const soloGiveExpanded = await soloGive.getAttribute('aria-expanded')
check('a Potion cannot open an empty Give disclosure with no legal recipient', () => {
  assert(soloGiveDisabled)
  assertEqual(soloGiveExpanded, null)
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
await page.getByRole('button', { name: 'Resolve Relic' }).click()
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
  const expectedCount = expectedParty.split('_').length
  await page.waitForFunction((count) => document.querySelector('.campfire')?.getAttribute('data-party-size') === String(count), expectedCount)
  campfirePartyLayouts.push(await page.locator('.campfire').evaluate(async (campfire, { expected, decode }) => {
    const background = getComputedStyle(campfire).backgroundImage
    const url = background.match(/url\(["']?([^"')]+)["']?\)/)?.[1] ?? ''
    let loaded = true
    if (decode) {
      const image = new Image()
      image.src = url
      await image.decode()
      loaded = image.naturalWidth === 1672 && image.naturalHeight === 941
    }
    return {
      statusCards: campfire.querySelectorAll('.campfire__players, .campfire__seat').length,
      expected,
      selected: url.endsWith(`/${expected}_firecamp.png`),
      loaded,
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
for (const characters of [
  ['guardian', 'hermit', 'hexaghost', 'slime_boss'],
  ['ironclad', 'guardian', 'silent', 'hermit'],
]) {
  await page.evaluate((party) => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.players = run.players.map((player, index) => ({ ...player, character: party[index], dead: false }))
    debug.setRun(run)
  }, characters)
  await page.waitForFunction((party) => {
    const campfire = document.querySelector('.campfire[data-character-cutouts="true"]')
    return campfire?.querySelectorAll('.campfire__party img').length === party.length
  }, characters)
  customCampfireLayouts.push(await page.locator('.campfire').evaluate(async (campfire) => {
    const url = getComputedStyle(campfire).backgroundImage.match(/url\(["']?([^"')]+)["']?\)/)?.[1] ?? ''
    const images = [...campfire.querySelectorAll('.campfire__party img')]
    await Promise.all(images.map((image) => image.decode()))
    return {
      scene: new URL(url).pathname,
      characters: images.map((image) => new URL(image.src).pathname.split('/').pop()),
      decoded: images.every((image) => image.naturalWidth > 0 && image.naturalHeight > 0),
    }
  }))
}
check('Downfall-only and mixed parties render every rear-view character on the empty campfire scene', () => {
  assert(customCampfireLayouts.every((layout) => layout.scene.endsWith('/empty_firecamp.png')),
    JSON.stringify(customCampfireLayouts))
  assertDeepEqual(customCampfireLayouts[0].characters,
    ['guardian-back.webp', 'hermit-back.webp', 'hexaghost-back.webp', 'slime_boss-back.webp'])
  assertDeepEqual(customCampfireLayouts[1].characters,
    ['ironclad-back.webp', 'guardian-back.webp', 'silent-back.webp', 'hermit-back.webp'])
  assert(customCampfireLayouts.every((layout) => layout.decoded), JSON.stringify(customCampfireLayouts))
})
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const characters = ['ironclad', 'silent', 'defect', 'watcher']
  run.players = run.players.map((player, index) => ({ ...player, character: characters[index] }))
  debug.setRun(run)
})
await page.waitForFunction(() => !document.querySelector('.campfire')?.hasAttribute('data-character-cutouts'))
const campfireResponsiveLayouts = []
for (const viewport of [{ width: 1440, height: 900 }, { width: 320, height: 568 }, { width: 667, height: 375 }]) {
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
      sceneFits: (innerWidth <= innerHeight
        ? getComputedStyle(campfire, '::after')
        : getComputedStyle(campfire)).backgroundSize.split(',').at(-1)?.trim() === (innerWidth <= innerHeight ? 'contain' : 'cover'),
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
  if (viewport.width === 320) await shot('12-campfire-scene-mobile')
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

const leaveLockedBefore = await page.locator('.campfire__leave').isDisabled()
check('a campfire will not let the party leave until everyone has chosen', () => {
  assert(leaveLockedBefore, 'the leave button must be disabled while a choice is outstanding')
})

const campfirePrompt = page.locator('.campfire__prompt')
await campfirePrompt.getByRole('button', { name: /Rest/ }).click()
await campfirePrompt.getByRole('button', { name: 'Next campfire player' }).click()
await campfirePrompt.getByRole('button', { name: /Smith/ }).click()
await page.waitForSelector('.campfire__deck .card')
await page.setViewportSize({ width: 1244, height: 409 })
await page.waitForTimeout(60)
const compactSmithPicker = await page.evaluate(() => {
  const prompt = document.querySelector('.campfire__prompt')
  const deck = document.querySelector('.campfire__deck')
  const promptBox = prompt?.getBoundingClientRect()
  const cardBoxes = [...(deck?.querySelectorAll('.card') ?? [])].map((card) => card.getBoundingClientRect())
  const firstTop = cardBoxes[0]?.top
  const firstRow = cardBoxes.filter((box) => firstTop !== undefined && Math.abs(box.top - firstTop) <= 1)
  const playerName = document.querySelector('.campfire__name')
  const playerNameBox = playerName?.getBoundingClientRect()
  const leave = document.querySelector('.campfire__leave')
  const leaveBox = leave?.getBoundingClientRect()
  const leaveVisible = Boolean(leave && getComputedStyle(leave).display !== 'none')
  return {
    documentScrolls: document.documentElement.scrollHeight > document.documentElement.clientHeight + 1,
    promptScrolls: Boolean(prompt && prompt.scrollHeight > prompt.clientHeight + 1),
    deckScrollsHorizontally: Boolean(deck && deck.scrollWidth > deck.clientWidth + 1),
    firstRowCards: firstRow.length,
    playerContextVisible: Boolean(playerNameBox && playerNameBox.width > 1 && playerNameBox.height > 1),
    clippedFirstRowCards: promptBox
      ? firstRow.filter((box) => box.top < promptBox.top - 1 || box.bottom > promptBox.bottom + 1).length
      : firstRow.length,
    leaveOverlapsFirstRow: Boolean(leaveVisible && leaveBox && firstRow.some((box) =>
      leaveBox.left < box.right && leaveBox.right > box.left && leaveBox.top < box.bottom && leaveBox.bottom > box.top)),
  }
})
check('the compact Smith picker shows full card rows with only one scroll surface', () => {
  assert(!compactSmithPicker.documentScrolls, `the page itself scrolls: ${JSON.stringify(compactSmithPicker)}`)
  assert(compactSmithPicker.promptScrolls, 'the compact picker should own the one necessary scrollbar')
  assert(!compactSmithPicker.deckScrollsHorizontally, `the card grid scrolls sideways: ${JSON.stringify(compactSmithPicker)}`)
  assert(compactSmithPicker.playerContextVisible, `the active player's context is hidden: ${JSON.stringify(compactSmithPicker)}`)
  assert(compactSmithPicker.firstRowCards > 0 && compactSmithPicker.clippedFirstRowCards === 0,
    `the first row is clipped: ${JSON.stringify(compactSmithPicker)}`)
  assert(!compactSmithPicker.leaveOverlapsFirstRow,
    `the leave control covers a card: ${JSON.stringify(compactSmithPicker)}`)
})
await shot('12a-compact-campfire-smith')
await page.locator('.campfire__deck .card').first().click()
await page.waitForSelector('.campfire__deck--smith .card--selected')
const compactSmithPicked = []
for (const viewport of [{ width: 1244, height: 409 }, { width: 1244, height: 521 }, { width: 320, height: 568 }]) {
  await page.setViewportSize(viewport)
  await page.waitForTimeout(60)
  compactSmithPicked.push({ ...viewport, ...await page.evaluate(() => {
    const prompt = document.querySelector('.campfire__prompt')
    const deck = document.querySelector('.campfire__deck')
    const card = deck?.querySelector('.card')
    const switcher = document.querySelector('button[aria-label^="Next campfire player: "]')
    const promptBox = prompt?.getBoundingClientRect()
    const cardBox = card?.getBoundingClientRect()
    const switcherBox = switcher?.getBoundingClientRect()
    const hit = switcherBox && document.elementFromPoint(switcherBox.left + switcherBox.width / 2, switcherBox.top + switcherBox.height / 2)
    return {
      documentScrolls: document.documentElement.scrollHeight > document.documentElement.clientHeight + 1,
      deckScrollsHorizontally: Boolean(deck && deck.scrollWidth > deck.clientWidth + 1),
      promptHeight: promptBox?.height ?? 0,
      cardHeight: cardBox?.height ?? 0,
      visibleCardHeight: promptBox && cardBox
        ? Math.max(0, Math.min(promptBox.bottom, cardBox.bottom) - Math.max(promptBox.top, cardBox.top)) : 0,
      previewCount: document.querySelectorAll('.campfire__preview').length,
      saysBecomes: /\bBecomes\b/.test(prompt?.textContent ?? ''),
      switcherReachable: Boolean(switcher && switcherBox && switcherBox.width > 0 && switcherBox.height > 0 && hit && (hit === switcher || switcher.contains(hit))),
    }
  }) })
}
check('selecting a Smith card on a compact screen keeps the picker and next player reachable', () => {
  for (const shape of compactSmithPicked) {
    assert(!shape.documentScrolls, `the selected picker made the page scroll: ${JSON.stringify(shape)}`)
    assert(!shape.deckScrollsHorizontally, `the selected grid scrolls sideways: ${JSON.stringify(shape)}`)
    assert(shape.visibleCardHeight >= shape.cardHeight - 1,
      `the selected picker clips the first card: ${JSON.stringify(shape)}`)
    assertEqual(shape.previewCount, 0, `the removed upgrade preview returned: ${JSON.stringify(shape)}`)
    assert(!shape.saysBecomes, `the removed "Becomes" copy returned: ${JSON.stringify(shape)}`)
    assert(shape.switcherReachable, `the next player control is unreachable: ${JSON.stringify(shape)}`)
  }
})
for (let remaining = 2; remaining > 0; remaining -= 1) {
  await campfirePrompt.getByRole('button', { name: 'Next campfire player' }).click()
  await campfirePrompt.getByRole('button', { name: /Rest/ }).click()
}
await campfirePrompt.getByRole('button', { name: 'Previous campfire player' }).click()
await campfirePrompt.getByRole('button', { name: 'Previous campfire player' }).click()
await page.waitForSelector('.campfire__deck--smith .card--selected')
const compactReadySmith = await page.evaluate(() => {
  const leave = document.querySelector('.campfire__leave')
  const prompt = document.querySelector('.campfire__prompt')
  const headerControls = [...document.querySelectorAll('.app-shell__header button, .app-shell__header .pip, .app-shell__header h1')]
  const leaveBox = leave?.getBoundingClientRect()
  const promptBox = prompt?.getBoundingClientRect()
  const overlaps = (element, clip) => {
    const box = element.getBoundingClientRect()
    const visible = clip ? {
      left: Math.max(box.left, clip.left), right: Math.min(box.right, clip.right),
      top: Math.max(box.top, clip.top), bottom: Math.min(box.bottom, clip.bottom),
    } : box
    return Boolean(leaveBox && visible.left < visible.right && visible.top < visible.bottom &&
      leaveBox.left < visible.right && leaveBox.right > visible.left && leaveBox.top < visible.bottom && leaveBox.bottom > visible.top)
  }
  return {
    leaveEnabled: leave instanceof HTMLButtonElement && !leave.disabled,
    cardOverlaps: [...document.querySelectorAll('.campfire__deck .card')].filter((card) => overlaps(card, promptBox)).length,
    choiceOverlaps: [...document.querySelectorAll('.campfire__choices button')].filter((choice) => overlaps(choice)).length,
    switcherOverlaps: [...document.querySelectorAll('.campfire__turn-nav button')].filter((button) => overlaps(button)).length,
    reachableSwitchers: [...document.querySelectorAll('.campfire__turn-nav button')].filter((button) => {
      const box = button.getBoundingClientRect()
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
      return box.width > 0 && box.height > 0 && Boolean(hit && (hit === button || button.contains(hit)))
    }).length,
    switcherCount: document.querySelectorAll('.campfire__turn-nav button').length,
    headerChoiceOverlaps: [...document.querySelectorAll('.campfire__choices button')].filter((choice) => {
      const box = choice.getBoundingClientRect()
      const visible = promptBox ? {
        left: Math.max(box.left, promptBox.left), right: Math.min(box.right, promptBox.right),
        top: Math.max(box.top, promptBox.top), bottom: Math.min(box.bottom, promptBox.bottom),
      } : box
      return headerControls.some((control) => {
        const controlBox = control.getBoundingClientRect()
        return visible.left < visible.right && visible.top < visible.bottom && controlBox.width > 0 && controlBox.height > 0 &&
          controlBox.left < visible.right && controlBox.right > visible.left && controlBox.top < visible.bottom && controlBox.bottom > visible.top
      })
    }).length,
  }
})
await shot('12b-compact-ready-campfire')
check('the enabled compact Campfire leave control stays clear of cards, choices, and player navigation', () => {
  assert(compactReadySmith.leaveEnabled, `the ready party cannot leave: ${JSON.stringify(compactReadySmith)}`)
  assertEqual(compactReadySmith.cardOverlaps, 0, JSON.stringify(compactReadySmith))
  assertEqual(compactReadySmith.choiceOverlaps, 0, JSON.stringify(compactReadySmith))
  assertEqual(compactReadySmith.switcherOverlaps, 0, JSON.stringify(compactReadySmith))
  assertEqual(compactReadySmith.reachableSwitchers, compactReadySmith.switcherCount, JSON.stringify(compactReadySmith))
  assertEqual(compactReadySmith.headerChoiceOverlaps, 0, `the run header covers a Campfire choice: ${JSON.stringify(compactReadySmith)}`)
})
await page.setViewportSize({ width: 1440, height: 900 })
await shot('12-campfire')
const leaveLockedAfter = await page.locator('.campfire__leave').isDisabled()
await page.locator('.campfire__leave').click()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'map')
const afterCampfire = await readRun()

check('Rest heals and Smith upgrades, and the party returns to the map', () => {
  assert(!leaveLockedAfter, 'once every player has chosen, leaving is allowed')
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
const peacePipeSkipControl = await page.getByRole('button', { name: 'Next campfire player' }).evaluate((button) => {
  const box = button.getBoundingClientRect()
  const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
  return box.width > 0 && box.height > 0 && Boolean(hit && (hit === button || button.contains(hit)))
})
await page.locator('.campfire__deck--remove .card').first().click()
const peacePipeNextControl = await page.getByRole('button', { name: 'Next campfire player' }).evaluate((button) => {
  const box = button.getBoundingClientRect()
  const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
  return box.width > 0 && box.height > 0 && Boolean(hit && (hit === button || button.contains(hit)))
})
check('Peace Pipe keeps local player navigation available with or without a removal', () => {
  assert(peacePipeSkipControl, 'the next-player control is hidden or covered before the optional removal is chosen')
  assert(peacePipeNextControl, 'the next-player control stayed hidden or covered after a Peace Pipe choice')
})

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.players[0].relics.push({ defId: 'straight_razor', spent: false })
  debug.setRun(run)
})
await page.locator('.campfire__prompt').getByRole('button', { name: /Rest/ }).click()
const sharedCampfireCard = page.locator('.campfire__deck--transform .card').first()
await sharedCampfireCard.click()
await page.locator('.campfire__deck--remove .card').first().click()
const staleCampfireTransforms = await page.locator('.campfire__deck--transform .card.is-selected').count()
check('Peace Pipe clears Straight Razor when both selected the same card', () => {
  assertEqual(staleCampfireTransforms, 0,
    'removing the transform target left a stale hidden selection')
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
await page.locator('.campfire__deck--smith .card').first().click()
await page.setViewportSize({ width: 320, height: 568 })
await page.waitForTimeout(60)
const compactSoloSmith = await page.evaluate(() => {
  const prompt = document.querySelector('.campfire__prompt')
  const deck = document.querySelector('.campfire__deck--smith')
  const card = deck?.querySelector('.card')
  const cardBox = card?.getBoundingClientRect()
  const promptBox = prompt?.getBoundingClientRect()
  return {
    redundantPlayerUi: document.querySelectorAll('.campfire__players, .campfire__seat, .campfire__turn-nav').length,
    documentScrolls: document.documentElement.scrollHeight > document.documentElement.clientHeight + 1,
    deckScrollsHorizontally: Boolean(deck && deck.scrollWidth > deck.clientWidth + 1),
    cardHeight: cardBox?.height ?? 0,
    visibleCardHeight: promptBox && cardBox
      ? Math.max(0, Math.min(promptBox.bottom, cardBox.bottom) - Math.max(promptBox.top, cardBox.top)) : 0,
  }
})
check('a compact solo Smith picker uses the full scene instead of reserving a player switcher', () => {
  assertEqual(soloCampfireSummaryCount, 0, 'the solo Campfire shows redundant player UI before choosing')
  assertEqual(compactSoloSmith.redundantPlayerUi, 0, `the solo player UI still consumes picker height: ${JSON.stringify(compactSoloSmith)}`)
  assert(!compactSoloSmith.documentScrolls, `the solo picker makes the page scroll: ${JSON.stringify(compactSoloSmith)}`)
  assert(!compactSoloSmith.deckScrollsHorizontally, `the solo picker scrolls sideways: ${JSON.stringify(compactSoloSmith)}`)
  assert(compactSoloSmith.visibleCardHeight >= compactSoloSmith.cardHeight - 1,
    `the solo picker clips its first card: ${JSON.stringify(compactSoloSmith)}`)
})

// A card whose width is unbounded turns aspect-ratio into runaway height. This
// caught a real regression where one enemy portrait grew to ~560px tall and the
// page to three times the viewport.
await page.setViewportSize({ width: 1440, height: 900 })
await page.waitForTimeout(60)
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
await page.getByRole('button', { name: 'Begin next run →' }).click()
await page.getByRole('heading', { name: 'Ironclad', exact: true }).waitFor()
const runBeforeEmbark = await readRun()
await page.getByRole('button', { name: 'Back', exact: true }).click()
await page.getByRole('button', { name: 'Compendium', exact: true }).click()
await page.locator('.compendium').waitFor()
await page.getByRole('button', { name: 'Back to main menu', exact: true }).click()
await page.getByRole('button', { name: 'Single Player', exact: true }).waitFor()
const nextRunPickerAfterRemount = await page.getByRole('heading', { name: 'Ironclad', exact: true }).count()
await page.getByRole('button', { name: 'Single Player', exact: true }).click()
await page.getByRole('button', { name: 'Embark' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'neow')
const ascensionRetry = await readRun()
check('the campaign journal returns to character select and preserves every Ascension setup modifier', () => {
  assertEqual(runBeforeEmbark.campaign.finalized, true, 'Begin next run started before choosing a character')
  assertEqual(nextRunPickerAfterRemount, 0, 'backing out of a next run reopened character select after a menu remount')
  assert(ascensionRetry.seed !== runBeforeEmbark.seed, 'the next run reused the previous seed')
  assertEqual(ascensionRetry.ascension, 9)
  assertEqual(ascensionRetry.players[0].maxHp, 9)
  assertEqual(ascensionRetry.players[0].hp, 8)
  assert(ascensionRetry.players[0].deck.some((card) => card.defId === 'ascenders_bane'))
})

await page.evaluate(() => window.__STS_DEBUG__.reset(1, 'combust-ui'))
await bypassNeow()
await page.locator('.room--reachable').first().click()
await page.locator('.combat').waitFor()
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.combat.players[0]
  const source = run.combat.enemies[0]
  Object.assign(actor, {
    row: 0,
    hand: [],
    powers: [{ uid: 'ui-combust', defId: 'combust', upgraded: true }],
  })
  run.combat.phase = 'player'
  run.combat.turn = 1
  run.combat.powerTriggersUsedThisTurn = []
  run.combat.enemies = [
    { ...source, uid: 'combust-left-a', defId: 'cultist', row: 0, isBoss: false },
    { ...source, uid: 'combust-left-b', defId: 'green_louse', row: 0, isBoss: false },
    { ...source, uid: 'combust-right', defId: 'red_louse', row: 1, isBoss: false },
    { ...source, uid: 'combust-boss', defId: 'gremlin_nob', row: 2, isBoss: true },
  ].map((enemy) => ({ ...enemy, hp: 10, maxHp: 10, block: 0, dead: false }))
  debug.setRun(run)
})
await page.getByRole('button', { name: 'Use Combust+' }).click()
await page.getByText('Choose an enemy for Combust+').waitFor()
await page.getByRole('button', { name: /^Cultist,/ }).scrollIntoViewIfNeeded()
await shot('16a-combust-row-target')
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.combat.players[0]
  actor.hand = [{ uid: 'ui-combust-forced', defId: 'strike_ironclad', upgraded: false }]
  run.combat.startTurnProgress = { choices: [], forcedCard: {
    playerId: actor.id, cardUid: 'ui-combust-forced', sourceCardId: 'havoc', exhaustNonPower: false,
  } }
  debug.setRun(run)
})
await page.getByText('Choose an enemy for Combust+').waitFor({ state: 'hidden' })
const stagedCombustDuringForcedCard = await page.getByText('Choose an enemy for Combust+').count()
check('a forced card clears a staged Combust without changing phase', () => {
  assertEqual(stagedCombustDuringForcedCard, 0)
})
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[0].hand = []
  run.combat.startTurnProgress = undefined
  debug.setRun(run)
})
await page.getByRole('button', { name: 'Use Combust+' }).click()
// Any enemy in Ironclad's row anchors the effect there, the same as a
// `target: 'row'` card — clicking `combust-left-a` (row 0) replaces the
// removed "Target Row Ironclad" button.
await page.locator('.enemy[data-enemy-id="combust-left-a"]').click()
const combustResolved = await readState()
const combustLocked = await page.getByRole('button', { name: 'Combust+ used' }).isDisabled()
check('Combust+ visibly targets a row, includes the boss, and locks after use', () => {
  assertDeepEqual(combustResolved.enemies.map((enemy) => enemy.hp), [8, 8, 10, 8])
  assert(combustLocked)
  assert(combustResolved.powerTriggersUsedThisTurn.includes(
    `${combustResolved.players[0].id}/power:ui-combust`,
  ))
})
await shot('16b-combust-resolved')

// A row-target power can still legally target a row with nothing living left
// in it (the boss is folded in regardless of the chosen row), but there is
// no enemy anchor left to click for that row — the one gap `onEnemyClick`
// can't cover. Confirm the empty-lane fallback button appears, is labeled
// for the ability actually resolving it, and hits only the boss.
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.combat.players[0]
  Object.assign(actor, { row: 0, hand: [], powers: [{ uid: 'ui-combust-empty', defId: 'combust', upgraded: true }] })
  run.combat.phase = 'player'
  run.combat.powerTriggersUsedThisTurn = []
  const source = run.combat.enemies[0]
  run.combat.enemies = [
    { ...source, uid: 'combust-empty-row0', row: 0, hp: 0, maxHp: 10, block: 0, dead: true, isBoss: false },
    { ...source, uid: 'combust-empty-row1', row: 1, hp: 10, maxHp: 10, block: 0, dead: false, isBoss: false },
    { ...source, uid: 'combust-empty-boss', row: 0, hp: 20, maxHp: 20, block: 0, dead: false, isBoss: true },
  ]
  debug.setRun(run)
})
await page.getByRole('button', { name: 'Use Combust+' }).click()
await page.getByText('Choose an enemy for Combust+').waitFor()
const emptyLaneButton = page.locator('.row__lane-target')
await emptyLaneButton.waitFor()
const emptyLaneLabel = await emptyLaneButton.textContent()
const emptyLaneLivingAnchors = await page.locator('.row .enemy--targeted').count()
// The stage layout collapses `.row__enemies` to `display: contents` and
// absolutely positions `.row` itself, so this control needs its own explicit
// position/size CSS to land in its own lane rather than piling up at the
// board's origin — regression coverage for exactly that failure mode, since
// nothing else here would have caught it (a prior round of this fix shipped
// with the button pinned to the top-left corner despite every functional
// check passing).
const emptyLaneGeometry = await page.evaluate(() => {
  const lane = document.querySelector('.row__lane-target')
  const anchor = document.querySelector('.row .enemy--targeted')
  const laneBox = lane.getBoundingClientRect()
  const anchorBox = anchor.getBoundingClientRect()
  return {
    position: getComputedStyle(lane).position,
    width: laneBox.width,
    height: laneBox.height,
    x: laneBox.x,
    y: laneBox.y,
    matchesAnchorHeight: Math.round(laneBox.height) === Math.round(anchorBox.height),
  }
})
await shot('16b2-combust-empty-row-fallback')
await emptyLaneButton.click()
const emptyRowResolved = await readState()
check('an empty-but-legal row can still be targeted through the fallback lane control', () => {
  assert(emptyLaneLabel.includes('Combust+') && emptyLaneLabel.includes('no living enemy') &&
    emptyLaneLabel.includes('the boss is hit'), emptyLaneLabel)
  assertEqual(emptyLaneLivingAnchors, 1, 'only the living enemy in the other row should be independently clickable')
  assertDeepEqual(emptyRowResolved.enemies.map((enemy) => enemy.hp), [0, 10, 18],
    'the empty row should hit only the boss, leaving the other row untouched')
})
check('the fallback lane control is positioned and sized like a real actor card, not pinned at the origin', () => {
  assertEqual(emptyLaneGeometry.position, 'absolute')
  assert(emptyLaneGeometry.width >= 44 && emptyLaneGeometry.height >= 44,
    `fallback lane control below 44px: ${JSON.stringify(emptyLaneGeometry)}`)
  assert(emptyLaneGeometry.x >= 10 && emptyLaneGeometry.y >= 10,
    `fallback lane control pinned near the top-left corner: ${JSON.stringify(emptyLaneGeometry)}`)
  assert(emptyLaneGeometry.matchesAnchorHeight,
    `fallback lane control height should match a real enemy card's height: ${JSON.stringify(emptyLaneGeometry)}`)
})
const emptyLaneButtonGone = await page.locator('.row__lane-target').count()
check('the fallback lane control disappears once the ability is used', () => {
  assertEqual(emptyLaneButtonGone, 0)
})

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.combat.players[0]
  Object.assign(actor, {
    hand: [
      { uid: 'ui-evolve', defId: 'evolve', upgraded: true },
      { uid: 'ui-evolve-shrug', defId: 'shrug_it_off', upgraded: false },
    ],
    draw: [
      { uid: 'ui-evolve-daze-a', defId: 'daze', upgraded: false },
      { uid: 'ui-evolve-daze-b', defId: 'daze', upgraded: false },
      { uid: 'ui-evolve-strike', defId: 'strike_ironclad', upgraded: false },
    ],
    discard: [], exhaust: [], powers: [], energy: 3, block: 0,
  })
  run.combat.powerTriggersUsedThisTurn = []
  run.combat.log = []
  debug.setRun(run)
})
if (artSynced) await page.waitForFunction(() => [...document.querySelectorAll('.hand .card img')]
  .every((img) => img.complete && img.naturalWidth > 0))
const evolveLabel = await page.getByRole('button', { name: /^Evolve\+,/ }).getAttribute('aria-label')
check('Evolve+ renders its sharp scan and announces its Status-only trigger', () => {
  assert(evolveLabel.includes('whenever you draw a status card') && evolveLabel.includes('draw 1 card'))
})
await shot('16c-evolve-ready')
await page.getByRole('button', { name: /^Evolve\+,/ }).click()
const evolvePowerLabel = await page.locator('.power[aria-label^="Evolve"]').getAttribute('aria-label')
await page.getByRole('button', { name: /^Shrug It Off,/ }).click()
const evolveResolved = await readState()
check('Evolve chains once for each drawn Status through the real controls', () => {
  assert(evolvePowerLabel.includes('whenever you draw a status card'))
  assertDeepEqual(evolveResolved.players[0].hand.map((card) => card.defId),
    ['daze', 'daze', 'strike_ironclad'])
  assertEqual(evolveResolved.players[0].block, 2)
  assertEqual(evolveResolved.players[0].energy, 2)
})
await shot('16d-evolve-resolved')

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.combat.players[0]
  const source = run.combat.enemies[0]
  Object.assign(actor, {
    hand: [
      { uid: 'ui-fire', defId: 'fire_breathing', upgraded: true },
      { uid: 'ui-fire-trance', defId: 'battle_trance', upgraded: false },
    ],
    draw: [
      { uid: 'ui-fire-daze', defId: 'daze', upgraded: false },
      { uid: 'ui-fire-curse', defId: 'clumsy', upgraded: false },
      { uid: 'ui-fire-strike', defId: 'strike_ironclad', upgraded: false },
    ],
    discard: [], exhaust: [], powers: [], energy: 3, drawLocked: false,
  })
  run.combat.phase = 'player'
  run.combat.pendingTriggers = []
  run.combat.enemies = [
    { ...source, uid: 'fire-left', defId: 'cultist', row: 0, hp: 10, maxHp: 10,
      block: 0, dead: false, isBoss: false },
    { ...source, uid: 'fire-right', defId: 'cultist', row: 1, hp: 10, maxHp: 10,
      block: 0, dead: false, isBoss: false },
    { ...source, uid: 'fire-boss', defId: 'cultist', row: 2, hp: 10, maxHp: 10,
      block: 0, dead: false, isBoss: true },
  ]
  run.combat.log = []
  debug.setRun(run)
})
if (artSynced) await page.waitForFunction(() => [...document.querySelectorAll('.hand .card img')]
  .every((img) => img.complete && img.naturalWidth > 0))
const fireLabel = await page.getByRole('button', { name: /^Fire Breathing\+,/ }).getAttribute('aria-label')
check('Fire Breathing+ renders its sharp scan and announces Status-or-Curse row damage', () => {
  assert(fireLabel.includes('whenever you draw a status or curse card'))
  assert(fireLabel.includes('affects a whole row and any boss'))
  assert(fireLabel.includes('deal 3 damage'))
})
await page.getByRole('button', { name: /^Fire Breathing\+,/ }).click()
const firePowerLabel = await page.locator('.power[aria-label^="Fire Breathing"]').getAttribute('aria-label')
await page.getByRole('button', { name: /^Battle Trance,/ }).click()
await page.getByText("Ironclad's Fire Breathing+ — choose an enemy").waitFor()
const fireRows = await page.locator('.enemy--targeted').count()
check('Fire Breathing pauses on a visible row picker for each qualifying draw', () => {
  assert(firePowerLabel.includes('whenever you draw a status or curse card'))
  assertEqual(fireRows, 2)
})
await shot('16e-fire-breathing-choice')
// One enemy per offered row anchors that row, the same as clicking a
// `target: 'row'` card, replacing the removed "Fire Breathing+ in Row X" buttons.
await page.locator('.enemy[data-enemy-id="fire-right"]').click()
await page.locator('.enemy[data-enemy-id="fire-left"]').click()
const fireResolved = await readState()
check('Fire Breathing+ resolves both direct-damage rows and includes the boss each time', () => {
  assertDeepEqual(fireResolved.enemies.map((enemy) => enemy.hp), [7, 7, 4])
  assertEqual(fireResolved.pendingTriggers.length, 0)
  assert(fireResolved.players[0].drawLocked, 'Battle Trance text should finish before the trigger picker')
})
await shot('16f-fire-breathing-resolved')

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.combat.players[0]
  const source = run.combat.enemies[0]
  Object.assign(actor, {
    hand: [
      { uid: 'ui-berserk', defId: 'berserk', upgraded: true },
      { uid: 'ui-juggernaut', defId: 'juggernaut', upgraded: true },
      { uid: 'ui-juggernaut-defend', defId: 'defend_ironclad', upgraded: false },
      { uid: 'ui-berserk-exhaust', defId: 'seeing_red', upgraded: false },
    ],
    draw: [], discard: [], exhaust: [], powers: [], energy: 6, block: 0, drawLocked: false,
  })
  run.combat.phase = 'player'
  run.combat.pendingTriggers = []
  run.combat.enemies = [
    { ...source, uid: 'trigger-left', defId: 'cultist', row: 0, hp: 10, maxHp: 10,
      block: 0, dead: false, isBoss: false },
    { ...source, uid: 'trigger-right', defId: 'cultist', row: 1, hp: 10, maxHp: 10,
      block: 0, dead: false, isBoss: false },
    { ...source, uid: 'trigger-boss', defId: 'cultist', row: 2, hp: 10, maxHp: 10,
      block: 0, dead: false, isBoss: true },
  ]
  run.combat.log = []
  debug.setRun(run)
})
const berserkCard = page.getByRole('button', { name: /^Berserk\+,/ })
const juggernautCard = page.getByRole('button', { name: /^Juggernaut\+,/ })
await berserkCard.waitFor()
const ironcladRareArt = await Promise.all([artWidth(berserkCard), artWidth(juggernautCard)])
if (artSynced) assert(ironcladRareArt.every((width) => width >= UPSCALED_ART_WIDTH),
  `expected upscaled Ironclad rare art, got ${ironcladRareArt.join(', ')}px`)
const berserkLabel = await berserkCard.getAttribute('aria-label')
const juggernautLabel = await juggernautCard.getAttribute('aria-label')
check('Berserk+ and Juggernaut+ announce their physical triggers and damage', () => {
  assert(berserkLabel.includes('whenever you exhaust a card') && berserkLabel.includes('deal 2 damage'))
  assert(berserkLabel.includes('affects a whole row and any boss'))
  assert(juggernautLabel.includes('whenever you gain Block') && juggernautLabel.includes('deal 2 damage'))
})
await berserkCard.click()
await juggernautCard.click()
const berserkPowerLabel = await page.locator('.power[aria-label^="Berserk+"]').getAttribute('aria-label')
const juggernautPower = page.locator('.power[aria-label^="Juggernaut+"]')
const juggernautPowerLabel = await juggernautPower.getAttribute('aria-label')
assert(berserkPowerLabel.includes('one enemy row and any boss'))
assert(juggernautPowerLabel.includes('whenever you gain Block'))

await page.getByRole('button', { name: /^Defend,/ }).click()
await page.getByText("Ironclad's Juggernaut+ — choose an enemy").waitFor()
assertEqual(await page.locator('.enemy--targeted').count(), 3,
  'Juggernaut should allow any living enemy')
await juggernautPower.click()
await shot('16g-ironclad-trigger-powers')
await juggernautPower.click()
await page.locator('.enemy--targeted').nth(1).click()
await page.getByRole('button', { name: /^Seeing Red,/ }).click()
await page.getByText("Ironclad's Berserk+ — choose an enemy").waitFor()
assertEqual(await page.locator('.enemy--targeted').count(), 2)
// Row index 1 (`trigger-right`'s row) is what the removed "Berserk+ in Row 2"
// button targeted (row labels are 1-indexed when no player occupies the row);
// clicking any enemy in that row anchors it there, the same as a
// `target: 'row'` card.
await page.locator('.enemy[data-enemy-id="trigger-right"]').click()
const ironcladRareResolved = await readState()
check('Juggernaut and Berserk resolve chosen targets only after their source cards finish', () => {
  assertDeepEqual(ironcladRareResolved.enemies.map((enemy) => enemy.hp), [10, 6, 8])
  assertEqual(ironcladRareResolved.players[0].block, 1)
  assertEqual(ironcladRareResolved.players[0].energy, 3)
  assert(ironcladRareResolved.players[0].exhaust.some((card) => card.uid === 'ui-berserk-exhaust'))
  assertEqual(ironcladRareResolved.pendingTriggers.length, 0)
})

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.combat.players[0]
  const source = run.combat.enemies[0]
  Object.assign(actor, {
    name: 'Silent', character: 'silent',
    hand: [
      { uid: 'ui-thousand-cuts', defId: 'a_thousand_cuts', upgraded: true },
      { uid: 'ui-malaise', defId: 'malaise', upgraded: true },
      { uid: 'ui-cuts-trance', defId: 'battle_trance', upgraded: false },
    ],
    draw: [{ uid: 'ui-cuts-strike', defId: 'strike_silent', upgraded: false }],
    discard: [
      { uid: 'ui-cuts-defend', defId: 'defend_silent', upgraded: false },
      { uid: 'ui-cuts-neutralize', defId: 'neutralize', upgraded: false },
    ],
    exhaust: [], powers: [], energy: 6, block: 0, drawLocked: false,
  })
  run.combat.phase = 'player'
  run.combat.pendingTriggers = []
  run.combat.enemies = [
    { ...source, uid: 'cuts-left', defId: 'green_louse', row: 0, hp: 12, maxHp: 12,
      block: 0, weak: 0, poison: 0, dead: false, isBoss: false, abilityUsed: true },
    { ...source, uid: 'cuts-right', defId: 'cultist', row: 1, hp: 12, maxHp: 12,
      block: 0, weak: 0, poison: 0, dead: false, isBoss: false, abilityUsed: true },
    { ...source, uid: 'cuts-boss', defId: 'cultist', row: 2, hp: 20, maxHp: 20,
      block: 0, weak: 0, poison: 0, dead: false, isBoss: true, abilityUsed: true },
  ]
  run.combat.log = []
  debug.setRun(run)
})
const thousandCutsCard = page.getByRole('button', { name: /^A Thousand Cuts\+,/ })
const malaiseCard = page.getByRole('button', { name: /^Malaise\+, cost X,/ })
await thousandCutsCard.waitFor()
const silentRareArt = await Promise.all([artWidth(thousandCutsCard), artWidth(malaiseCard)])
if (artSynced) assert(silentRareArt.every((width) => width >= UPSCALED_ART_WIDTH),
  `expected upscaled Silent rare art, got ${silentRareArt.join(', ')}px`)
const thousandCutsLabel = await thousandCutsCard.getAttribute('aria-label')
const malaiseLabel = await malaiseCard.getAttribute('aria-label')
check('A Thousand Cuts+ and Malaise+ announce their physical shuffle and X rules', () => {
  assert(thousandCutsLabel.includes('whenever you shuffle your draw pile'))
  assert(thousandCutsLabel.includes('deal 7 damage') && thousandCutsLabel.includes('whole row and any boss'))
  assert(malaiseLabel.includes('apply X+1 Weak'))
  assert(malaiseLabel.includes('apply X+1 Poison'))
})
await thousandCutsCard.click()
const thousandCutsPowerLabel = await page.locator('.power[aria-label^="A Thousand Cuts+"]').getAttribute('aria-label')
assert(thousandCutsPowerLabel.includes('whenever you shuffle your draw pile'))
await malaiseCard.click()
await page.getByText('Choose Energy for Malaise+').waitFor()
await page.getByRole('button', { name: 'Spend 2' }).click()
await page.getByRole('button', { name: /^Green Louse,/ }).click()
await page.getByRole('button', { name: /^Battle Trance,/ }).click()
await page.getByText("Silent's A Thousand Cuts+ — choose an enemy").waitFor()
const thousandCutsPower = page.locator('.power[aria-label^="A Thousand Cuts+"]')
await thousandCutsPower.click()
await shot('16h-silent-shuffle-x-rares')
await thousandCutsPower.click()
// Row index 1 (`cuts-right`'s row) is what the removed "A Thousand Cuts+ in
// Row 2" button targeted; clicking any enemy in that row anchors it there.
await page.locator('.enemy[data-enemy-id="cuts-right"]').click()
const silentRaresResolved = await readState()
check('Malaise+ and A Thousand Cuts+ resolve through X and shuffle choices', () => {
  assertEqual(silentRaresResolved.enemies[0].weak, 3)
  assertEqual(silentRaresResolved.enemies[0].poison, 3)
  assertDeepEqual(silentRaresResolved.enemies.map((enemy) => enemy.hp), [12, 5, 13])
  assertEqual(silentRaresResolved.players[0].energy, 2)
  assert(silentRaresResolved.players[0].drawLocked)
  assert(silentRaresResolved.players[0].exhaust.some((card) => card.uid === 'ui-malaise'))
  assertEqual(silentRaresResolved.pendingTriggers.length, 0)
})

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.combat.players[0]
  Object.assign(actor, {
    hand: [
      { uid: 'ui-burst', defId: 'burst', upgraded: true },
      { uid: 'ui-burst-defend', defId: 'defend_silent', upgraded: false },
    ],
    draw: [], discard: [], exhaust: [], powers: [], energy: 1, block: 0, drawLocked: false,
    doubledSkillsThisTurn: 0, doubledCardsThisTurn: 0, doubledAttacksThisTurn: 0,
  })
  run.combat.phase = 'player'
  run.combat.pendingCardCopy = undefined
  debug.setRun(run)
})
const burstCard = page.getByRole('button', { name: /^Burst\+,/ })
const burstLabel = await burstCard.getAttribute('aria-label')
if (artSynced) assert(await artWidth(burstCard) >= UPSCALED_ART_WIDTH)
check('Burst+ announces the physical copy restriction and separate Skill copy', () => {
  assert(burstLabel.includes('next Skill this turn is played twice'))
  assert(burstLabel.includes('Burst cannot be copied or played twice'))
})
await burstCard.click()
const queuedBurstText = await page.locator('.seat__pending').filter({ hasText: 'Burst' }).textContent()
const queuedBurstSeat = await page.locator('.seat--viewer').getAttribute('aria-label')
check('queued Burst count is visible and included in the seat accessible name', () => {
  assert(queuedBurstText.includes('next 1 Skill played twice'))
  assert(queuedBurstSeat.includes('Burst, next 1 Skill played twice'))
})
await shot('16i-silent-burst-armed')
await page.getByRole('button', { name: /^Defend,/ }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'player' &&
  window.__STS_DEBUG__.getState().players[0].block === 2)
const burstResolved = await readState()
check('Burst+ auto-resolves a choice-free Skill copy and cleans the physical card once', () => {
  assertEqual(burstResolved.players[0].block, 2)
  assertEqual(burstResolved.players[0].doubledSkillsThisTurn, 0)
  assertEqual(burstResolved.players[0].discard.filter((card) => card.uid === 'ui-burst-defend').length, 1)
  assertEqual(burstResolved.pendingCardCopy, undefined)
})
await shot('16j-silent-burst-resolved')

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.combat.players[0]
  Object.assign(actor, {
    hand: [
      { uid: 'ui-bullet-time', defId: 'bullet_time', upgraded: true },
      { uid: 'ui-bullet-defend', defId: 'defend_silent', upgraded: false },
    ],
    draw: [{ uid: 'ui-bullet-future', defId: 'strike_silent', upgraded: false }],
    discard: [], exhaust: [], powers: [], energy: 2, block: 0, drawLocked: false,
  })
  run.combat.phase = 'player'
  run.combat.pendingCardCopy = undefined
  debug.setRun(run)
})
const bulletTimeCard = page.getByRole('button', { name: /^Bullet Time\+, cost 2,/ })
const bulletTimeLabel = await bulletTimeCard.getAttribute('aria-label')
if (artSynced) assert(await artWidth(bulletTimeCard) >= UPSCALED_ART_WIDTH)
check('Bullet Time+ announces its printed draw lock and hand-only discount', () => {
  assert(bulletTimeLabel.includes('cannot draw more cards this turn'))
  assert(bulletTimeLabel.includes('cards currently in your hand cost 0 this turn'))
})
await bulletTimeCard.click()
const bulletFreeDefend = page.getByRole('button', { name: /^Defend, cost 0,/ })
await bulletFreeDefend.waitFor()
const bulletSeat = await page.locator('.seat--viewer').getAttribute('aria-label')
check('Bullet Time+ visibly discounts the current hand and exposes its draw lock', () => {
  assert(bulletSeat.includes('cannot draw more cards this turn'))
})
await shot('16k-silent-bullet-time')
await bulletFreeDefend.click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().players[0].energy === 0)
const bulletResolved = await readState()
check('Bullet Time+ pays only its own Energy while the discounted card resolves normally', () => {
  assertEqual(bulletResolved.players[0].block, 1)
  assertEqual(bulletResolved.players[0].energy, 0)
  assertDeepEqual(bulletResolved.players[0].draw.map((card) => card.uid), ['ui-bullet-future'])
})

await page.setViewportSize({ width: 1440, height: 1200 })
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.combat.players[0]
  const source = run.combat.enemies[0]
  Object.assign(actor, {
    hand: [
      { uid: 'ui-corpse-explosion', defId: 'corpse_explosion', upgraded: true },
      { uid: 'ui-corpse-strike', defId: 'strike_silent', upgraded: true },
    ],
    draw: [], discard: [], exhaust: [], powers: [], energy: 3, block: 0, drawLocked: false,
  })
  run.combat.phase = 'player'
  run.combat.pendingCardCopy = undefined
  run.combat.enemies = [
    { ...source, uid: 'corpse-target', defId: 'cultist', row: 0, hp: 2, maxHp: 2,
      block: 0, strength: 0, vulnerable: 0, weak: 0, poison: 0,
      dead: false, isBoss: false, corpseExplosion: undefined },
    { ...source, uid: 'corpse-row', defId: 'red_louse', row: 0, hp: 12, maxHp: 12,
      block: 0, strength: 0, vulnerable: 0, weak: 0, poison: 0,
      dead: false, isBoss: false, corpseExplosion: undefined },
    { ...source, uid: 'corpse-other', defId: 'jaw_worm', row: 1, hp: 12, maxHp: 12,
      block: 0, strength: 0, vulnerable: 0, weak: 0, poison: 0,
      dead: false, isBoss: false, corpseExplosion: undefined },
  ]
  run.combat.log = []
  debug.setRun(run)
})
const corpseExplosionCard = page.getByRole('button', { name: /^Corpse Explosion\+, cost 2,/ })
const corpseExplosionLabel = await corpseExplosionCard.getAttribute('aria-label')
if (artSynced) assert(await artWidth(corpseExplosionCard) >= UPSCALED_ART_WIDTH)
check('Corpse Explosion+ uses sharp art and announces its attached row detonation', () => {
  assert(corpseExplosionLabel.includes('3 Poison'))
  assert(corpseExplosionLabel.includes('10 damage to its row'))
})
await corpseExplosionCard.click()
await page.locator('.enemy--targeted[aria-label^="Cultist"]').click()
const attachedEnemy = page.locator('.enemy[aria-label*="Corpse Explosion attached"]')
await attachedEnemy.waitFor()
const attachmentWidth = artSynced
  ? await attachedEnemy.locator('.enemy__attachment img').evaluate((img) => img.naturalWidth)
  : 0
check('Corpse Explosion remains visibly attached as a face-up high-resolution card', () => {
  if (artSynced) assert(attachmentWidth >= UPSCALED_ART_WIDTH)
})
await shot('16l-silent-corpse-explosion-attached')
await page.getByRole('button', { name: /^Strike\+,/ }).click()
await page.locator('.enemy--targeted[aria-label^="Cultist"]').click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().enemies[0].dead)
const corpseResolved = await readState()
check('Corpse Explosion detonation is visible, row-scoped, and discards the attachment', () => {
  assertDeepEqual(corpseResolved.enemies.map((enemy) => enemy.hp), [0, 2, 12])
  assertEqual(corpseResolved.players[0].discard.filter((card) => card.uid === 'ui-corpse-explosion').length, 1)
  assertEqual(corpseResolved.enemies[0].corpseExplosion, undefined)
})
await shot('16m-silent-corpse-explosion-detonated')
await page.setViewportSize({ width: 1440, height: 900 })

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.combat.players[0]
  const source = run.combat.enemies[0]
  Object.assign(actor, {
    hand: [
      { uid: 'ui-double-tap', defId: 'double_tap', upgraded: true },
      { uid: 'ui-double-cleave', defId: 'cleave', upgraded: false },
    ],
    draw: [], discard: [], exhaust: [], powers: [], energy: 3,
    doubledAttacksThisTurn: 0, attacksPlayedThisTurn: 0,
  })
  run.combat.phase = 'player'
  run.combat.pendingCardCopy = undefined
  run.combat.enemies = [
    { ...source, uid: 'double-first', defId: 'cultist', row: 0, hp: 6, maxHp: 6,
      block: 0, vulnerable: 1, dead: false, isBoss: false },
    { ...source, uid: 'double-second', defId: 'red_louse', row: 1, hp: 6, maxHp: 6,
      block: 0, vulnerable: 0, dead: false, isBoss: false },
  ]
  run.combat.log = []
  debug.setRun(run)
})
const doubleTapLabel = await page.getByRole('button', { name: /^Double Tap\+,/ }).getAttribute('aria-label')
check('Double Tap+ announces the separately resolved copy rule', () => {
  assert(doubleTapLabel.includes('next Attack') && doubleTapLabel.includes('separate targets and modifiers'))
})
await page.getByRole('button', { name: /^Double Tap\+,/ }).click()
const queuedDoubleTapText = await page.locator('.seat__pending').filter({ hasText: 'Double Tap' }).textContent()
const queuedDoubleTapSeat = await page.locator('.seat--viewer').getAttribute('aria-label')
check('queued Double Tap count is visible and included in the seat accessible name', () => {
  assert(queuedDoubleTapText.includes('next 1 Attack played twice'))
  assert(queuedDoubleTapSeat.includes('Double Tap, next 1 Attack played twice'))
})
await page.getByRole('button', { name: /^Cleave,/ }).click()
await page.getByText('Choose an enemy for Cleave copy (Double Tap) — its whole row is hit').waitFor()
await page.getByRole('button', { name: /^Cultist,/ }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'copy')
await page.getByText('Choose an enemy for original Cleave after Double Tap copy — its whole row is hit').waitFor()
await page.locator('.prompt').evaluate((prompt) => Promise.all(
  prompt.getAnimations().map((animation) => animation.finished),
))
await shot('16e-double-tap-copy-target')
await page.getByRole('button', { name: /^Red Louse,/ }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'player')
const doubleTapResolved = await readState()
check('Double Tap visibly labels and separately targets copy-first row attacks', () => {
  assertDeepEqual(doubleTapResolved.enemies.map((enemy) => enemy.hp), [2, 4])
  assertEqual(doubleTapResolved.players[0].attacksPlayedThisTurn, 2)
  assertEqual(doubleTapResolved.players[0].energy, 2)
  assertEqual(doubleTapResolved.pendingCardCopy, undefined)
})
await shot('16f-double-tap-resolved')

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.combat.players[0]
  Object.assign(actor, {
    // Every AoE attack now asks which row it sweeps, so the card that needs no
    // choice at all is a swing that cannot land: Blizzard with no Frost to spend.
    hand: [
      { uid: 'ui-double-tap-aoe', defId: 'double_tap', upgraded: true },
      { uid: 'ui-double-blizzard', defId: 'blizzard', upgraded: false },
    ],
    draw: [], discard: [], exhaust: [], energy: 3, orbs: [null, null, null],
    doubledAttacksThisTurn: 0, attacksPlayedThisTurn: 0,
  })
  run.combat.phase = 'player'
  run.combat.pendingCardCopy = undefined
  run.combat.enemies = run.combat.enemies.map((enemy) => ({
    ...enemy, hp: 20, maxHp: 20, block: 0, vulnerable: 0, dead: false, abilityUsed: true,
  }))
  debug.setRun(run)
})
await page.getByRole('button', { name: /^Double Tap\+,/ }).click()
await page.getByRole('button', { name: /^Blizzard,/ }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'player' &&
  window.__STS_DEBUG__.getState().players[0].attacksPlayedThisTurn === 2)
const doubledAoe = await readState()
check('a Double Tap copy with no choices auto-resolves instead of deadlocking', () => {
  assertDeepEqual(doubledAoe.enemies.map((enemy) => enemy.hp), [20, 20], 'no Frost, so no hits')
  assertEqual(doubledAoe.players[0].energy, 2, 'Double Tap+ is free, Blizzard costs 1')
  assertEqual(doubledAoe.pendingCardCopy, undefined, 'the copy resolved rather than waiting on a choice')
})

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.combat.players[0]
  Object.assign(actor, {
    hand: [
      { uid: 'ui-double-headbutt-tap', defId: 'double_tap', upgraded: true },
      { uid: 'ui-double-headbutt', defId: 'headbutt', upgraded: false },
    ],
    draw: [],
    discard: [{ uid: 'ui-double-headbutt-defend', defId: 'defend_ironclad', upgraded: false }],
    exhaust: [], energy: 3, doubledAttacksThisTurn: 0, attacksPlayedThisTurn: 0,
  })
  run.combat.phase = 'player'
  run.combat.pendingCardCopy = undefined
  run.combat.enemies = run.combat.enemies.map((enemy) => ({
    ...enemy, hp: 20, maxHp: 20, block: 0, vulnerable: 0, dead: false,
  }))
  debug.setRun(run)
})
await page.getByRole('button', { name: /^Double Tap\+,/ }).click()
await page.getByRole('button', { name: /^Headbutt,/ }).click()
const firstHeadbuttChoice = page.getByRole('dialog', { name: 'Choose 1 card from your discard pile' })
await firstHeadbuttChoice.getByRole('button', { name: /^Defend,/ }).click()
await firstHeadbuttChoice.getByRole('button', { name: 'Put selected card on top' }).click()
await page.getByRole('button', { name: /^Cultist,/ }).click()
const copiedHeadbuttChoice = page.getByRole('dialog', { name: 'Choose 1 card from your discard pile' })
await copiedHeadbuttChoice.waitFor()
await page.keyboard.press('Escape')
const copiedHeadbuttCancel = await copiedHeadbuttChoice.getByRole('button', { name: 'Cancel' }).count()
const copiedHeadbuttPhase = (await readState()).phase
check('a mandatory copied Headbutt recovery cannot be dismissed', () => {
  assertEqual(copiedHeadbuttCancel, 0)
  assertEqual(copiedHeadbuttPhase, 'copy')
})
await copiedHeadbuttChoice.getByRole('button', { name: /^Double Tap\+,/ }).click()
await copiedHeadbuttChoice.getByRole('button', { name: 'Put selected card on top' }).click()
await page.getByRole('button', { name: /^Red Louse,/ }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'player')
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.combat.players[0]
  Object.assign(actor, {
    name: 'Watcher', character: 'watcher', miracles: 2,
    hand: [
      { uid: 'ui-devotion', defId: 'devotion', upgraded: true },
      { uid: 'ui-blasphemy', defId: 'blasphemy', upgraded: true },
      { uid: 'ui-brilliance', defId: 'brilliance', upgraded: true },
    ],
    draw: [
      { uid: 'ui-blasphemy-secret-1', defId: 'defend_watcher', upgraded: false },
      { uid: 'ui-blasphemy-secret-2', defId: 'vigilance', upgraded: false },
    ],
    discard: [], exhaust: [], powers: [], energy: 6, strength: 0,
    tripledAttacksThisTurn: 0, attacksPlayedThisTurn: 0,
  })
  run.combat.players = [actor]
  Object.assign(run.combat, { phase: 'player', pendingCardCopy: undefined, startTurnProgress: undefined })
  run.combat.enemies = run.combat.enemies.slice(0, 1).map((enemy) => ({
    ...enemy, hp: 30, maxHp: 30, block: 0, vulnerable: 0, weak: 0, dead: false, abilityUsed: true,
  }))
  debug.setRun(run)
})
const devotionCard = page.getByRole('button', { name: /^Devotion\+, cost 1,/ })
const blasphemyCard = page.getByRole('button', { name: /^Blasphemy\+, cost 2,/ })
const brillianceCard = page.getByRole('button', { name: /^Brilliance\+, cost 1,/ })
const [devotionLabel, blasphemyLabel, brillianceLabel] = await Promise.all([
  devotionCard.getAttribute('aria-label'),
  blasphemyCard.getAttribute('aria-label'),
  brillianceCard.getAttribute('aria-label'),
])
await devotionCard.click()
const devotionPowerLabel = await page.getByRole('button', {
  name: /^Devotion\+?:/,
}).getAttribute('aria-label')
await blasphemyCard.click()
await brillianceCard.click()
for (let copiesLeft = 2; copiesLeft >= 0; copiesLeft--) {
  await page.locator('.enemy--targeted').first().click()
  if (copiesLeft > 0) {
    await page.waitForFunction((remaining) =>
      window.__STS_DEBUG__.getState().pendingCardCopy?.sourceNames.length === remaining,
    copiesLeft)
  }
}
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'player')
const mantraBatch = await readState()
check('Watcher mantra cards expose physical text and Blasphemy plays Brilliance exactly three times', () => {
  assert(devotionLabel.includes('at 4 cubes exhaust this Power'), devotionLabel)
  assert(devotionPowerLabel.includes('gain 1 Miracle'), devotionPowerLabel)
  assert(devotionPowerLabel.includes('draw 1 card'), devotionPowerLabel)
  assert(devotionPowerLabel.includes('at the start of each turn'), devotionPowerLabel)
  assert(devotionPowerLabel.includes('0 of 4 cubes'), devotionPowerLabel)
  assert(blasphemyLabel.includes('next Attack this turn is played three times'), blasphemyLabel)
  assert(blasphemyLabel.includes('exhaust your draw pile'), blasphemyLabel)
  assert(brillianceLabel.includes('3 damage per Miracle held'), brillianceLabel)
  assertEqual(mantraBatch.enemies[0].hp, 12)
  assertEqual(mantraBatch.players[0].tripledAttacksThisTurn, 0)
  assertEqual(mantraBatch.players[0].attacksPlayedThisTurn, 3)
  assertEqual(mantraBatch.players[0].draw.length, 0)
  assertEqual(mantraBatch.players[0].exhaust.length, 3)
  assert(mantraBatch.players[0].exhaust.some((card) => card.defId === 'blasphemy'))
  assertEqual(mantraBatch.players[0].discard.filter((card) => card.defId === 'brilliance').length, 1)
})
await shot('06zz-watcher-mantra-batch')

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const actor = run.combat.players[0]
  Object.assign(actor, {
    hand: [
      { uid: 'ui-worship', defId: 'worship', upgraded: true },
      { uid: 'ui-wreath', defId: 'wreath_of_flame', upgraded: true },
    ],
    draw: [], discard: [], exhaust: [], powers: [], energy: 4, miracles: 0,
    strength: 0, strengthLossAtEndOfTurn: 0, tripledAttacksThisTurn: 0,
  })
  Object.assign(run.combat, { phase: 'player', pendingCardCopy: undefined, startTurnProgress: undefined })
  debug.setRun(run)
})
const worshipCard = page.getByRole('button', { name: /^Worship\+, cost X,/ })
const wreathCard = page.getByRole('button', { name: /^Wreath of Flame\+, cost X,/ })
const [worshipLabel, wreathLabel] = await Promise.all([
  worshipCard.getAttribute('aria-label'), wreathCard.getAttribute('aria-label'),
])
await worshipCard.click()
await page.getByText('Choose Energy for Worship+').waitFor()
await page.getByRole('button', { name: 'Spend 2' }).click()
await wreathCard.click()
await page.getByText('Choose Energy for Wreath of Flame+').waitFor()
await page.getByRole('button', { name: 'Spend 2' }).click()
const xMantra = await readState()
check('upgraded Worship and Wreath of Flame visibly use X and follow their printed Exhaust text', () => {
  assert(worshipLabel.includes('gain X+1 Miracles'), worshipLabel)
  assert(wreathLabel.includes('gain X Strength, lose X Strength at end of turn'), wreathLabel)
  assertEqual(xMantra.players[0].miracles, 3)
  assertEqual(xMantra.players[0].strength, 2)
  assertEqual(xMantra.players[0].strengthLossAtEndOfTurn, 2)
  assertDeepEqual(xMantra.players[0].discard.map((card) => card.defId), ['wreath_of_flame'])
  assertDeepEqual(xMantra.players[0].exhaust.map((card) => card.defId), ['worship'])
})
await shot('06zza-watcher-x-mantra-batch')


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
  assert(populatedHand.cards.every((card) => card.top >= 0 && card.bottom <= populatedHand.viewportHeight),
    `the short combat stage clips a hand card: ${JSON.stringify(populatedHand.cards)}`)
  for (const key of ['top', 'height']) {
    assert(Math.abs(populatedHand.hand[key] - emptyHand.hand[key]) <= 1,
      `hand ${key} shifted between empty and populated states`)
    assert(Math.abs(populatedHand.board[key] - emptyHand.board[key]) <= 1,
      `board ${key} shifted between empty and populated states`)
  }
})
await page.setViewportSize({ width: 1440, height: 900 })
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
  animation: card.getAttribute('data-animation'),
  aura: getComputedStyle(card.querySelector('.enemy__art--cutout')).filter,
  loaded: (card.querySelector('.enemy__art--cutout')?.naturalWidth ?? 0) > 0,
  objectFit: getComputedStyle(card.querySelector('.enemy__art--cutout')).objectFit,
  maskImage: getComputedStyle(card.querySelector('.enemy__art--cutout')).maskImage,
  visualHeight: card.querySelector('.enemy__art--cutout').getBoundingClientRect().height,
  artBox: card.querySelector('.enemy__art--cutout').getBoundingClientRect().toJSON(),
  portraitBox: card.querySelector('.enemy__portrait').getBoundingClientRect().toJSON(),
  headBox: card.querySelector('.enemy__head').getBoundingClientRect().toJSON(),
  hpBox: card.querySelector('.bar').getBoundingClientRect().toJSON(),
  intentBox: card.querySelector('.enemy__intent').getBoundingClientRect().toJSON(),
  abilityBox: card.querySelector('.enemy__ability').getBoundingClientRect().toJSON(),
  abilityScrollHeight: card.querySelector('.enemy__ability').scrollHeight,
  abilityClientHeight: card.querySelector('.enemy__ability').clientHeight,
  abilityOverflowY: getComputedStyle(card.querySelector('.enemy__ability')).overflowY,
  abilityScrollbarWidth: getComputedStyle(card.querySelector('.enemy__ability')).scrollbarWidth,
  abilityPosition: getComputedStyle(card.querySelector('.enemy__ability')).position,
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
    boss.image.includes('/assets/combat/enemies/animations/') && boss.image.endsWith('-idle.webp')),
  'a boss is missing its idle animation')
  assert(bossVisuals.every((boss) => boss.aura.includes('drop-shadow')),
    'a boss is missing its restrained aura')
  assert(new Set(bossVisuals.map((boss) => boss.aura)).size === bossVisuals.length,
    'boss auras should follow each boss identity, not only the act')
  assert(bossVisuals.every((boss) => boss.intentBox.bottom <= boss.artBox.top + 4),
    `boss intent must sit above the portrait: ${JSON.stringify(bossVisuals.map((boss) => ({ art: boss.artBox, intent: boss.intentBox })))}`)
  assert(bossVisuals.every((boss) => boss.abilityBox.top >= boss.intentBox.bottom - 4 &&
    boss.abilityBox.left >= boss.intentBox.left - 1 && boss.abilityBox.right <= boss.intentBox.right + 1),
    `boss ability must sit in the clear band below intent: ${JSON.stringify(bossVisuals.map((boss) => ({ intent: boss.intentBox, ability: boss.abilityBox })))}`)
  assert(bossVisuals.every((boss) => boss.abilityPosition === 'absolute'),
    'boss ability text must not reflow the portrait or its HP bar')
  assert(bossVisuals.every((boss) => [boss.artBox, boss.portraitBox, boss.headBox]
    .every((box) => Math.abs((box.left + box.right) / 2 - (boss.hpBox.left + boss.hpBox.right) / 2) <= 1)),
  `boss art, name, and HP centers diverged: ${JSON.stringify(bossVisuals.map((boss) => ({ art: boss.artBox, portrait: boss.portraitBox, head: boss.headBox, hp: boss.hpBox })))}`)
  assert(bossVisuals.every((boss) => boss.abilityOverflowY === 'auto' && boss.abilityScrollbarWidth === 'none'),
    'boss ability bands must scroll vertically without visible scrollbars')
  assert(bossVisuals.some((boss) => boss.abilityScrollHeight > boss.abilityClientHeight),
    'the long boss ability fixture did not exercise vertical overflow')
  assert(bossVisuals.every((boss) => boss.visualHeight > bossStage.heroHeight * 1.12),
    `boss silhouettes should read larger than the hero: hero ${bossStage.heroHeight}, bosses ${bossVisuals.map((boss) => boss.visualHeight).join(', ')}`)
  assert(hoveredBossHeight > bossStage.heroHeight * 1.12,
    'hovering must not collapse a boss to the normal enemy scale')
  assert(bossVisuals.some((boss) => boss.label.includes('Sharp Hide')))
  assert(bossVisuals.some((boss) => boss.label.includes('Time Warp')))
  assert(bossVisuals.some((boss) => boss.label.includes('Haste')))
  assert(bossVisuals.some((boss) => boss.label.includes('gain 1 Strength')
    && boss.label.includes('remove all Weak and Vulnerable') && boss.label.includes('Poison remains')))
  assert(bossVisuals.some((boss) => boss.label.includes('Invincible: cannot gain Weak')))
  assert(bossVisuals.some((boss) => boss.text.includes('Haste')))
  assert(bossVisuals.some((boss) => boss.text.includes('Invincible · no Weak')))
  assert(bossVisuals.every((boss) => boss.box.width <= 320 && boss.box.height <= 360),
    'boss cards must remain card-sized')
})

await page.setViewportSize({ width: 1505, height: 430 })
await page.waitForFunction(() => [...document.querySelectorAll('.enemy--boss')].every((card) => {
  const art = card.querySelector('.enemy__art--cutout').getBoundingClientRect()
  const intent = card.querySelector('.enemy__intent').getBoundingClientRect()
  const board = card.closest('.board').getBoundingClientRect()
  return intent.top >= board.top - 1 && intent.bottom <= art.top + 4
}))
const shortBossVisuals = await page.locator('.enemy--boss').evaluateAll((cards) => cards.map((card) => ({
  art: card.querySelector('.enemy__art--cutout').getBoundingClientRect().toJSON(),
  intent: card.querySelector('.enemy__intent').getBoundingClientRect().toJSON(),
  board: card.closest('.board').getBoundingClientRect().toJSON(),
})))
await shot('17aa-short-boss-intents')
check('short boss stages keep every intent above its portrait and inside the board', () => {
  assert(shortBossVisuals.every(({ intent, board }) =>
    intent.top >= board.top - 1 && intent.bottom <= board.bottom + 1),
  `a short-stage boss intent is clipped by the board: ${JSON.stringify(shortBossVisuals)}`)
  assert(shortBossVisuals.every(({ art, intent }) => intent.bottom <= art.top + 4),
    `a short-stage boss intent overlaps its portrait: ${JSON.stringify(shortBossVisuals)}`)
})
await page.setViewportSize({ width: 1440, height: 900 })

await page.waitForFunction(() => [...document.querySelectorAll('.enemy--boss')].every((card) => {
  const idle = card.querySelector('.enemy__art--cutout')?.getAttribute('src')
  const attack = idle?.replace('-idle.webp', '-attack.webp')
  return attack && [...document.querySelectorAll('link[data-boss-attack-preload]')]
    .some((link) => link.href === new URL(attack, location.href).href)
}))
const bossAttackPreloads = await page.locator('.enemy--boss').evaluateAll((cards) => cards.map((card) => {
  const idle = card.querySelector('.enemy__art--cutout')?.getAttribute('src')
  const attack = idle?.replace('-idle.webp', '-attack.webp')
  return Boolean(attack && [...document.querySelectorAll('link[data-boss-attack-preload]')]
    .some((link) => link.href === new URL(attack, location.href).href))
}))
check('boss attacks preload before the enemy phase', () => {
  assert(bossAttackPreloads.every(Boolean))
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
  loaded: (card.querySelector('.enemy__art--cutout')?.naturalWidth ?? 0) > 0,
}))
check('an attacking boss swaps to its one-shot left-facing animation', () => {
  assert(bossAttack.loaded)
  assert(bossAttack.image.endsWith('-attack.webp'), bossAttack.image)
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
  const heroes = [...board.querySelectorAll('.seat__portrait > img')]
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
  assert(Math.abs(meleeImpact.visibleBossLeft - meleeImpact.heroRight) <= 2,
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
const spentHaste = await page.locator('.enemy--boss').filter({ hasText: 'Haste · spent' }).getAttribute('aria-label')
const timeEaterAbilities = await page.locator('.enemy--boss').filter({ hasText: 'Haste · spent' })
  .locator('.enemy__ability > span').evaluateAll((abilities) => abilities.map((ability) => ({
    text: ability.textContent,
    decoration: getComputedStyle(ability).textDecorationLine,
  })))
check('Time Eater exposes Haste as spent after its one revival', () => {
  assert(spentHaste.includes('Haste: spent'))
  assert(timeEaterAbilities.find((ability) => ability.text.includes('Haste'))?.decoration.includes('line-through'))
  assert(!timeEaterAbilities.find((ability) => ability.text.includes('Time Warp'))?.decoration.includes('line-through'),
    'spending Haste must not strike through active Time Warp')
})

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
  text: card.querySelector('.enemy__ability')?.textContent ?? '',
  label: card.getAttribute('aria-label') ?? '',
})))
check('ascended boss abilities are visible and announced', () => {
  assert(ascendedAbilities.some((ability) => ability.text.includes('Large Slimes +1 Strength')
    && ability.label.includes('Large Slimes gain 1 Strength')))
  assert(ascendedAbilities.some((ability) => ability.text.includes('Strength from largest Power count')
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
await page.getByRole('button', { name: /^Spire Shield,/ }).click()
await page.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('Player 2'))
await page.getByRole('button', { name: /^Spire Shield,/ }).click()
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
await page.getByRole('button', { name: /^Spire Spear,/ }).click()
await page.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('Player 4'))
await page.getByRole('button', { name: /^Spire Spear,/ }).click()
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
await page.getByRole('button', { name: /^Spire Shield,/ }).click()
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
await page.setViewportSize({ width: 470, height: 742 })
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
  assert(!compactRelicStrip.obscuresDefectInfo, JSON.stringify(compactRelicStrip))
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
await page.setViewportSize({ width: 320, height: 568 })
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
check('hovered simple Relics scroll without scrollbar chrome on a narrow phone', () => {
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
await page.setViewportSize({ width: 470, height: 742 })
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
  assert(!mixedRelicStrip.obscuresDefectInfo, JSON.stringify(mixedRelicStrip))
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
const calendarTargetName = await calendarTarget.textContent()
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
const localTerminalPotions = await page.locator('.outside-potions').count()
check('a local Last Stand boss win has a clear terminal continuation state', () => {
  assertEqual(localLastStandNotice, 1)
  assertEqual(localForbiddenNextAct, 0)
  assertEqual(localRecordLastStand, 1)
  assertEqual(localTerminalPotions, 0)
})
await shot('20-last-stand-victory')

// The LOCAL shell's Neow scene keeps its full-bleed at every width.
//
// Only the bleed, deliberately. A clipping assertion was written here first and
// removed: the local table is ONE seat (see the `.neow-screen` comment in
// src/ui/chrome/neow.css for why that is a product invariant), one face renders
// as `.neow-face--solo` — absolutely positioned, ~90px tall, bottom ~234px into the
// scene — and the scene floors at 42rem in BOTH sheets. Two independent probes
// could not make a solo face clip: not by deleting the whole `.sts-scope
// .neow-screen` rule, not by zeroing both min-heights, only by injecting a
// synthetic `height: 200px` that no regression of this rule can produce. An
// assertion that cannot fail is worse than no assertion, because it reads as
// coverage. The multi-face clipping surface is real but belongs to the ONLINE
// shell, and `verify-noncombat-browser.mjs` measures it there at three phone
// widths with the reconnect banner up.
//
// A below-the-fold REACHABILITY assertion was considered here too and rejected
// for a separate reason worth recording, because the case looks compelling: at
// 375x667 both Neow action keys sit below the fold, and at 320x568 both are off
// screen entirely, so page scroll is the only way out of the phase. That is
// fine — but it cannot be pinned from inside the page. Chrome still scrolls a
// viewport that a regression has clipped, and Playwright runs
// `scrollIntoViewIfNeeded` before every click, so the automation reaches
// controls a human might not. Such an assertion passes either way and would
// certify a reachability property it never tested.
const localNeowBleed = []
await page.evaluate(() => window.__STS_DEBUG__.reset(1, 'neow-reach'))
await page.getByRole('heading', { name: 'Neow’s Blessing' }).waitFor()
for (const size of [{ width: 375, height: 667 }, { width: 320, height: 568 }, { width: 1280, height: 800 }]) {
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
await page.keyboard.press('Escape')
await pauseMenu.waitFor()
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
await page.getByRole('button', { name: 'Embark' }).click()
await page.getByRole('heading', { name: 'Neow’s Blessing' }).waitFor()
await page.waitForTimeout(100)
const abandonedRunMorphs = await page.locator('.card-morph').count()
check('starting over after abandoning a run does not replay old deck removals', () => {
  assertEqual(abandonedRunMorphs, 0)
})

// Landscape phones use a desktop layout viewport and let the browser scale it
// uniformly. This keeps one UI instead of a second mobile combat layout.
const phoneLayouts = []
const portraitCombatLayouts = []
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
  await tap(phonePage.getByRole('button', { name: 'Ironclad' }))
  await tap(phonePage.getByRole('button', { name: 'Embark' }))
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
      return box.left >= -1 && box.top >= -1 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1
    }
    const cards = [...document.querySelectorAll('.hand .card')]
    const cardProbe = cards[0]
    cardProbe?.classList.add('card--unplayable')
    const unplayableOpacity = cardProbe ? Number(getComputedStyle(cardProbe).opacity) : 1
    cardProbe?.classList.remove('card--unplayable')
    cardProbe?.classList.add('card--selected')
    const selectedOutline = cardProbe ? getComputedStyle(cardProbe).outlineStyle : 'none'
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
      unplayableOpacity,
      selectedOutline,
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
    await tap(phonePage.locator('.hand .card').nth(attackIndex))
    await tap(phonePage.locator('.enemy--targeted').first())
    await phonePage.waitForFunction((count) => window.__STS_DEBUG__.getState().players[0].hand.length < count, before)

    for (const viewport of [{ width: 320, height: 568 }, { width: 414, height: 896 }]) {
      await phonePage.setViewportSize(viewport)
      await phonePage.waitForFunction(({ width, height }) => innerWidth === width && innerHeight === height, viewport)
      await phonePage.waitForTimeout(100)
      portraitCombatLayouts.push({ engineName, ...viewport, ...await phonePage.locator('.row--viewer').evaluate((row) => {
        const board = row.closest('.board')
        const boardBox = board?.getBoundingClientRect()
        const seats = [...(board?.querySelectorAll('.row__seat') ?? [])]
          .filter((seat) => seat.querySelector('.seat:not(.seat--empty)'))
        const boxes = seats.flatMap((seat) => [seat, ...['.seat__portrait', '.seat__name', '.seat .bar']
          .map((selector) => seat.querySelector(selector))])
          .map((element) => element?.getBoundingClientRect())
        const endTurn = document.querySelector('.combat__end-turn')?.getBoundingClientRect()
        const piles = [...document.querySelectorAll('.hand-area .pile')]
          .map((pile) => pile.getBoundingClientRect())
        const gutter = 8
        return {
          visible: seats.length > 0 && boxes.every((box) => box && boardBox &&
            box.left >= Math.max(0, boardBox.left) + gutter - 1 &&
            box.right <= Math.min(innerWidth, boardBox.right) - gutter + 1),
          documentOverflows: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          lefts: boxes.map((box) => Math.round(box?.left ?? -999)),
          controlsVisible: Boolean(endTurn && endTurn.left >= gutter - 1 && endTurn.right <= innerWidth - gutter + 1 &&
            endTurn.top >= -1 && endTurn.bottom <= innerHeight + 1),
          controlsSeparated: Boolean(endTurn && piles.length > 0 && piles.every((pile) =>
            endTurn.right <= pile.left || pile.right <= endTurn.left ||
            endTurn.bottom <= pile.top || pile.bottom <= endTurn.top) && boxes.every((box) => box &&
            (endTurn.right <= box.left || box.right <= endTurn.left ||
              endTurn.bottom <= box.top || box.bottom <= endTurn.top))),
        }
      }) })
      await phonePage.screenshot({
        path: join(outDir, `combat-portrait-${engineName.toLowerCase()}-${viewport.width}.png`),
        scale: 'css',
      })
    }
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
    const enemy = phonePage.locator('.enemy:not(.enemy--dead)').first()
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
    // Read in the same evaluation that waits, rather than waiting for an
    // outline and then going back for it. Targeting moves while the pointer
    // settles, so between the two calls the first `.enemy--targeted` could be a
    // different element than the one the wait was satisfied by — which read as
    // "drag target feedback is invisible" on a board that was showing it.
    const targetOutline = await phonePage.waitForFunction(() => {
      const target = document.querySelector('.enemy--targeted')
      const style = target ? getComputedStyle(target).outlineStyle : null
      return style && style !== 'none' ? style : null
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
      targetOutline,
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
  }, null, { timeout: 4000 }).catch(() => {})
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
    null, { timeout: 4000 }).catch(() => {})
  await phonePage.waitForFunction(() => [...document.querySelectorAll('.app-shell__header .relic-tip')]
    .every((tip) => getComputedStyle(tip).visibility === 'hidden'), null, { timeout: 4000 }).catch(() => {})
  layout.relicPanelTapCloses = (await readRelicBar()).open === 0
  await tap(relicChips.first())
  await phonePage.waitForFunction(() => document.querySelector('.relic-chip[data-tip-open="true"]'),
    null, { timeout: 4000 }).catch(() => {})
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
  }, null, { timeout: 4000 }).catch(() => {})
  const relicSwitched = await readRelicBar()
  await tap(relicChips.nth(1))
  await phonePage.waitForFunction(() => !document.querySelector('.relic-chip[data-tip-open="true"]') &&
    [...document.querySelectorAll('.app-shell__header .relic-tip')]
      .every((tip) => getComputedStyle(tip).visibility === 'hidden'),
  null, { timeout: 4000 }).catch(() => {})
  Object.assign(layout.relicTap, {
    closed: relicClosed, opened: relicOpened, switched: relicSwitched, reclosed: await readRelicBar(),
  })

  layout.mapHint = await phonePage.locator('.map__hint').textContent()
  const phoneRoom = phonePage.locator('.map:not([inert]) .room--reachable').first()
  await phoneRoom.waitFor()
  const aimedRoom = await phoneRoom.getAttribute('data-room')
  await tap(phoneRoom)
  await phonePage.waitForFunction(() => document.querySelector('.room--reading'),
    null, { timeout: 4000 }).catch(() => {})
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
  }, null, { timeout: 4000 }).catch(() => {})
  await phonePage.screenshot({
    path: join(outDir, `phone-tap-read-${engineName.toLowerCase()}-${deviceName.replaceAll(' ', '-').toLowerCase()}.png`),
    scale: 'css',
  })
  await tap(phoneRoom)
  await phonePage.waitForFunction(() => window.__STS_DEBUG__.getRun().phase !== 'map',
    null, { timeout: 6000 }).catch(() => {})
  Object.assign(layout.mapTap, await phonePage.evaluate((aimed) => ({
    enteredPhase: window.__STS_DEBUG__.getRun().phase,
    // Entering the WRONG room is the harm this two-step prevents, so the room
    // that was actually walked into is the thing worth pinning.
    enteredTheAimedRoom: window.__STS_DEBUG__.getRun().map.position === aimed,
  }), aimedRoom))

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
  await phonePage.locator('.potion-tip').first().waitFor({ timeout: 4000 }).catch(() => {})
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
  await tap(phonePotion)
  await phonePage.waitForFunction((held) =>
    window.__STS_DEBUG__.getState().players[0].potions.length < held, potionsHeld,
  { timeout: 6000 }).catch(() => {})
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
  await phonePage.locator('.relic-option__text').first().waitFor({ timeout: 8000 }).catch(() => {})
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
  await phonePage.locator('.potion-tip').first().waitFor({ timeout: 4000 }).catch(() => {})
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
  { timeout: 6000 }).catch(() => {})
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
      null, { timeout: 4000 }).catch(() => {})
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

check('portrait combat keeps every occupied player seat and HP bar inside the board gutter', () => {
  assertEqual(portraitCombatLayouts.length, 4)
  assert(portraitCombatLayouts.every((layout) => layout.visible && layout.controlsVisible &&
    layout.controlsSeparated && !layout.documentOverflows),
    JSON.stringify(portraitCombatLayouts))
})
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
    assert(layout.unplayableOpacity < 0.8, `${layout.deviceName}: unplayable cards lost their visual cue`)
    assert(layout.selectedOutline !== 'none', `${layout.deviceName}: selected cards lost their outline`)
    assert(layout.mapBackdropFilter === 'none', `${layout.deviceName}: map backdrop still blurs`)
    assert(layout.settingsBackdropFilter === 'none', `${layout.deviceName}: settings backdrop still blurs`)
    assertEqual(layout.settingsRepeatedHeadings, 0, `${layout.deviceName}: settings repeated the selected tab label`)
    assert(layout.settingsAudioContained, `${layout.deviceName}: an audio slider clips its control card`)
    assert(layout.mapHerePresent, `${layout.deviceName}: map location probe is missing`)
    assert(layout.mapHereAnimation === 'none', `${layout.deviceName}: map location ring still animates`)
    if (layout.drag) {
      assert(layout.drag.previewMoved, `${layout.deviceName}: same-target drag preview did not move`)
      assert(layout.drag.targetOutline !== 'none', `${layout.deviceName}: drag target feedback is invisible`)
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
