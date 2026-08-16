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
import { chromium } from 'playwright'
import { suite, check, assert, assertDeepEqual, assertEqual, report } from './lib/harness.mjs'
import { installScreenAudit } from './lib/browser-screen-audit.mjs'
import { STALE_END_TURN_ORDER } from '../src/game/combat.ts'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cardArtDir = join(repoRoot, 'public/assets/cards')
const artSynced = existsSync(cardArtDir) && readdirSync(cardArtDir).length > 0
const args = process.argv.slice(2)
const headed = args.includes('--headed')
const outDir = join(
  repoRoot,
  (args.find((a) => a.startsWith('--out=')) ?? '--out=artifacts/browser').slice(6),
)

// Deliberately NOT wiped: a reviewer running this suite at the same time as
// verify-all would delete the directory out from under the other run. Files are
// overwritten in place instead, which is safe when two runs overlap.
mkdirSync(outDir, { recursive: true })

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
page.setDefaultTimeout(10_000)
page.setDefaultNavigationTimeout(30_000)

const consoleErrors = []
const pageErrors = []
const requestFailures = []
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text())
})
page.on('pageerror', (error) => pageErrors.push(String(error)))
page.on('requestfailed', (request) =>
  requestFailures.push(`${request.url()} ${request.failure()?.errorText ?? ''}`),
)
page.on('response', (response) => {
  if (response.status() >= 400 && response.url().startsWith(base)) {
    requestFailures.push(`${response.status()} ${response.url()}`)
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
  const menu = page.locator('details.game-settings')
  if (!(await menu.evaluate((details) => details.open))) await menu.locator(':scope > summary').click()
  const selector = page.getByLabel('Seat')
  if (await selector.count()) await selector.selectOption(playerId)
  await menu.locator(':scope > summary').click()
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

async function endTurn() {
  if ((await readState()).phase === 'start') {
    await page.getByRole('button', { name: 'Resolve start of turn' }).click()
  }
  await page.getByRole('button', { name: 'End turn' }).click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase !== 'player')
  if ((await readState()).phase === 'discard') {
    await confirmAllDiscards()
  }
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
const setupHidden = await page.locator('.start-menu__setup').isHidden()
await page.getByRole('button', { name: 'Settings' }).click()
const settingsDialog = page.getByRole('dialog', { name: 'Settings' })
const settingsIsModal = await settingsDialog.evaluate((dialog) => dialog.matches(':modal'))
await page.getByRole('button', { name: 'Single Player' }).evaluate((button) => button.focus())
const settingsKeepsFocus = await settingsDialog.evaluate((dialog) => dialog.contains(document.activeElement))
const localAscensions = await page.getByLabel('Ascension').locator('option').evaluateAll((options) =>
  options.map((option) => option.value))
const localCharacterSeats = await page.getByLabel(/^Player \d character$/).count()
const setupHasDevControls = await page.locator('.start-menu__setup').getByText(/Party|Seed|Choose Your Relic|Last Stand/).count()
await shot('00-title-settings')
await page.keyboard.press('Escape')
await settingsDialog.waitFor({ state: 'hidden' })
const settingsDismissedWithEscape = await settingsDialog.isHidden()
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
  assert(settingsDismissedWithEscape, 'Escape did not close settings')
  assertEqual(freshMenuCampaign.saved.nextRunNumber, 0, 'opening the menu persisted a draft campaign run')
  assertEqual(reloadedMenuCampaign.saved.nextRunNumber, 0, 'reloading the menu consumed a campaign run number')
  assertEqual(freshMenuCampaign.draftRunId, 'campaign-1')
  assertEqual(reloadedMenuCampaign.draftRunId, 'campaign-1')
})

await page.getByRole('button', { name: 'Compendium' }).click()
await page.locator('.compendium').waitFor()
const allCardCount = await page.locator('.compendium-card').count()
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
await page.getByRole('button', { name: 'Curses' }).click()
await page.getByPlaceholder('Search').fill('Clumsy')
const curseUpgradeSource = await page.locator('.compendium-card img').first().getAttribute('src')
const curseImageVisible = !artSynced || await page.locator('.compendium-card > img').first().evaluate((img) =>
  img.complete && img.naturalWidth > 0 && getComputedStyle(img).visibility === 'visible')
await page.getByRole('button', { name: 'Statuses' }).click()
await page.getByPlaceholder('Search').fill('Daze')
const dazeLabel = await page.locator('.compendium-card').first().getAttribute('aria-label')
await page.locator('.compendium-card').first().click()
const statusDetailFallback = await page.locator('.compendium__detail-card').evaluate((card) => ({
  hasPublisherImage: Boolean(card.querySelector(':scope > img')),
  fallbackVisible: getComputedStyle(card.querySelector('.card-face')).visibility === 'visible',
  text: card.querySelector('.card-face')?.textContent ?? '',
  rulesSize: Number.parseFloat(getComputedStyle(card.querySelector('.card-face__rules')).fontSize),
}))
await page.keyboard.press('Escape')
await page.getByPlaceholder('Search').fill('Slimed')
const slimedLabel = await page.locator('.compendium-card').first().getAttribute('aria-label')
await page.getByPlaceholder('Search').fill('')
await page.getByRole('button', { name: 'Ironclad' }).click()
await shot('00a-compendium')
check('the compendium filters the real card catalog and opens card detail', () => {
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
  assertEqual(detailOpen, 1)
  assert(detailModal, 'card detail should use native modal semantics')
  assert(curseUpgradeSource?.endsWith('curses__clumsy.webp') && !curseUpgradeSource.includes('clumsy+'),
    `non-upgradable curse requested the wrong face: ${curseUpgradeSource}`)
  assert(curseImageVisible, 'the curse scan stayed hidden after changing filters')
  assert(!statusDetailFallback.hasPublisherImage && statusDetailFallback.fallbackVisible &&
    statusDetailFallback.text.includes('Daze') && statusDetailFallback.text.includes('unplayable') &&
    statusDetailFallback.text.includes('ethereal') && statusDetailFallback.rulesSize >= 13,
  `unscanned status detail has no fallback: ${JSON.stringify(statusDetailFallback)}`)
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
await page.getByRole('button', { name: 'Settings' }).click()
await page.getByLabel('Player 1 character').selectOption('watcher')
await page.getByRole('button', { name: 'Close' }).click()
await page.getByRole('button', { name: 'Single Player' }).click()
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
const neowRewardCards = await page.locator('.neow-action--offer .card').evaluateAll((cards) => cards.map((card) => {
  const box = card.getBoundingClientRect()
  return { top: box.top, bottom: box.bottom, visible: box.top >= 0 && box.bottom <= innerHeight }
}))
const staleNeowRewardLabel = await page.getByText('Resolve face-up reward', { exact: true }).count()
await shot('00b-neow-card-reward')
check('Neow shows complete face-up reward cards on the desktop stage', () => {
  assertEqual(neowRewardCards.length, 3)
  assert(neowRewardCards.some((card) => card.visible), `no complete reward card is visible: ${JSON.stringify(neowRewardCards)}`)
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
  const region = [...document.querySelectorAll('p.visually-hidden[aria-live="polite"]')]
    .find((node) => !node.classList.contains('combat__enemy-report'))
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

await enterFirstRoom()
const booted = await shot('02-combat-start')
check('the first room is an encounter and starts a combat', () => {
  assertEqual(booted.phase, 'player', 'combat opens on the Player Turn')
  assertEqual(booted.players[0].hand.length, 5, 'five cards are dealt')
  assertEqual(booted.players[0].energy, 3, 'energy starts at 3')
  assert(booted.die >= 1 && booted.die <= 6, `die should be 1-6, got ${booted.die}`)
})

const activeRun = await readRun()
const activeRunId = activeRun.campaign.runId
let newRunPrompt = ''
page.once('dialog', async (dialog) => {
  newRunPrompt = dialog.message()
  await dialog.dismiss()
})
const gameMenu = page.locator('details.game-settings')
await gameMenu.locator(':scope > summary').click()
await gameMenu.getByRole('button', { name: 'New run' }).click()
if (await gameMenu.evaluate((details) => details.open)) await gameMenu.locator(':scope > summary').click()
const runAfterCancelledRestart = await readRun()
check('New run confirms before discarding an active run', () => {
  assertEqual(newRunPrompt, 'Start a new run? The one in progress will be lost.')
  assertEqual(runAfterCancelledRestart.campaign.runId, activeRunId)
  assertEqual(runAfterCancelledRestart.phase, 'combat')
})

let boundaryRunPrompt = ''
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  Object.assign(run, { act: 2, phase: 'map', combat: null })
  run.map.position = null
  debug.setRun(run)
})
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'map')
const localCatchUpPanel = await page.getByRole('heading', { name: 'Catch Up' }).count()
page.once('dialog', async (dialog) => {
  boundaryRunPrompt = dialog.message()
  await dialog.dismiss()
})
await gameMenu.locator(':scope > summary').click()
await gameMenu.getByRole('button', { name: 'New run' }).click()
const boundaryRunAfterCancelledRestart = await readRun()
if (await gameMenu.evaluate((details) => details.open)) await gameMenu.locator(':scope > summary').click()
await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), activeRun)
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'combat')
check('New run confirms before discarding an Act-boundary run', () => {
  assertEqual(boundaryRunPrompt, 'Start a new run? The one in progress will be lost.')
  assertEqual(boundaryRunAfterCancelledRestart.campaign.runId, activeRunId)
  assertEqual(boundaryRunAfterCancelledRestart.phase, 'map')
  assertEqual(localCatchUpPanel, 0, 'Single Player exposed a local add-player path')
})

const combatAppearanceRun = await readRun()
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  Object.assign(run.combat.enemies[0], { defId: 'sentry_a', hp: 7, maxHp: 7, dead: false })
  Object.assign(run.combat.players[0], { block: 1, strength: 1 })
  debug.setRun(run)
})
await page.waitForFunction(() => document.querySelector('.enemy__art--cutout[src$="/sentry.webp"]')?.naturalWidth === 1024)
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
  assertDeepEqual([combatAppearance.naturalWidth, combatAppearance.naturalHeight], [1024, 1536])
  assertEqual(combatAppearance.statusOverlapsHp, false)
})
await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), combatAppearanceRun)

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
check('hovering or focusing a card keeps it compact with one native cost', () => {
  assertEqual(compactCardChrome.inspectionCount, 0, 'hover/focus inspection count')
  assertEqual(compactCardChrome.duplicateCostCount, 0, 'duplicate overlay cost count')
  assert(compactCardChrome.nativeCostVisible, 'native card-face cost is hidden')
  assertEqual(compactCardChrome.nativeCost, '1', 'native card-face cost')
  assertEqual(compactCardChrome.transform, cardTransformBeforeHover, 'hover/focus moved the card')
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
  assertEqual(afterPlay.players[0].hand.length, 4, 'the card leaves hand')
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

// Card art must actually load; a broken path renders an empty box that no state
// assertion would catch.
const artStatus = await page.evaluate(() =>
  [...document.querySelectorAll('.card > .card-face > .card-face__illustration')].map((img) => ({
    src: img.getAttribute('src'),
    ok: img.complete && img.naturalWidth > 0,
  })),
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

check('every repo-native card illustration in hand actually loaded', () => {
  assert(artStatus.length > 0, 'expected cards to be rendered')
  const broken = artStatus.filter((entry) => !entry.ok)
  assert(broken.length === 0, `broken card art: ${broken.map((b) => b.src).join(', ')}`)
  assert(artStatus.every((entry) => entry.src?.startsWith('/assets/card-art/')),
    `a native face used the wrong asset root: ${artStatus.map((entry) => entry.src).join(', ')}`)
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

await page.getByRole('button', { name: 'End turn' }).click()
const beforeDiscard = await readState()
check('end-of-turn effects resolve before the hand order is confirmed', () => {
  assertEqual(beforeDiscard.phase, 'discard', 'the game pauses for the post-trigger hand')
  assertEqual(beforeDiscard.players[0].hand.length, 4, 'the hand is still present for ordering')
})
await shot('03b-discard-order')
const discardPlayers = beforeDiscard.players.filter((player) => !player.dead)
await confirmDiscard(discardPlayers[0])
if (discardPlayers.length > 1) {
  const waitingForDiscards = await readState()
  check('one local seat cannot finalize another living player\'s hand', () => {
    assertEqual(waitingForDiscards.phase, 'discard', 'the other seat must confirm its own order')
    assertEqual(waitingForDiscards.players[0].hand.length, 4, 'no hand is discarded early')
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
// Sampled from a FOUR-player round, which is where rounds actually run long.
// Against a short round these all pass trivially: a tail keeps every line, so
// the fixed-tail regression they exist to catch slips straight through.
await page.evaluate(() => window.__STS_DEBUG__.reset(4, 'log-round'))
await bypassNeow()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().players.length === 4)
await enterFirstRoom()
await endTurn()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase !== 'enemy')

await page.getByText('Battle log', { exact: true }).click()
const logShape = await page.evaluate(() => {
  const list = document.querySelector('.combat__log')
  if (!list) return null
  const items = [...list.querySelectorAll('li')]
  const listBox = list.getBoundingClientRect()
  const engineNewest = window.__STS_DEBUG__.getState().log.at(-1)
  const showing = items.find((li) => li.textContent.trim() === engineNewest.trim())
  const box = showing?.getBoundingClientRect()
  const colourOf = (el) => (el ? getComputedStyle(el).color : '')
  return {
    engineNewest,
    engineLines: window.__STS_DEBUG__.getState().log.length,
    // Everything since the round opened — what the panel is supposed to show.
    engineRound: (() => {
      const log = window.__STS_DEBUG__.getState().log
      let start = -1
      for (let i = log.length - 1; i >= 0; i--) {
        if (/^Turn \d+ begins/.test(log[i])) {
          start = i
          break
        }
      }
      return (start >= 0 ? log.slice(start) : log).map((line) => line.trim())
    })(),
    rendered: items.map((li) => li.textContent.trim()),
    found: showing != null,
    isFirst: showing != null && showing === items[0],
    fullyVisible: box != null && box.top >= listBox.top - 1 && box.bottom <= listBox.bottom + 1,
    overflowing: list.scrollHeight > list.clientHeight + 1,
    newestColour: colourOf(items[0]),
    // NOT the last item: that is usually the round divider, which has a colour
    // of its own — so the comparison passed even with the emphasis removed.
    olderColour: colourOf(
      items.slice(1).find((li) => !li.className.includes('combat__log-turn')) ?? null,
    ),
  }
})
check('the log shows the whole round, dropping nothing', () => {
  // A fixed tail silently dropped lines — a four-player enemy turn ran to
  // fifteen and rendered ten, losing a "hit for 4" without the box even
  // overflowing to hint that anything was missing.
  assert(logShape, 'expected a combat log on screen')
  assert(logShape.engineLines > 4, `the fight produced only ${logShape.engineLines} lines`)
  // Long enough that the tail this exists to catch would ACTUALLY cut it. The
  // regression was a fixed `slice(-10)`, so the round has to exceed ten lines
  // or the check passes with that bug still in place — which it did at nine.
  assert(
    logShape.engineRound.length > 10,
    `this round is only ${logShape.engineRound.length} lines; a 10-line tail would keep them all`,
  )
  assert(logShape.rendered.length > 1, 'more than one line should be rendered')
  const missing = logShape.engineRound.filter((line) => !logShape.rendered.includes(line))
  assertEqual(
    missing.length,
    0,
    `the log dropped ${missing.length} line(s) of this round: ${missing.join(' | ')}`,
  )
})
check('the newest line is rendered first and fully visible', () => {
  assert(
    logShape.found,
    `the engine's newest line "${logShape.engineNewest}" is not rendered: ${logShape.rendered.join(' | ')}`,
  )
  assert(logShape.isFirst, `the newest line should lead the list, not "${logShape.rendered[0]}"`)
  assert(
    logShape.fullyVisible,
    `the newest line "${logShape.engineNewest}" is clipped or scrolled out of its box`,
  )
})

// Driven AFTER the log assertions on purpose: these end extra turns, which
// changes the round the log checks above measure.
//
// The battle log lives in a collapsed <details>, so what the enemy did reaches a
// screen reader only through the live region. TWO enemy turns are driven: a live
// region announces on DOM MUTATION, so an earlier version that re-set the same
// string went silent from the second identical turn, and a one-turn check stays
// green against exactly that. The observer counts mutations rather than reading
// final text, so a repeat with identical wording still registers.
await page.evaluate(() => {
  window.__ENEMY_REPORTS__ = []
  const region = document.querySelector('.combat__enemy-report')
  if (!region) return
  // EVERY mutation, empty ones included. Recording only non-empty text cannot
  // catch the bug this guards: a live region announces on mutation, so the
  // failure is "same string set twice, no mutation, silence" — and two turns
  // that happen to differ still mutate twice without the fix. The clear-to-""
  // between reports is the thing that makes a REPEAT audible, so that is what
  // gets asserted.
  new MutationObserver(() => {
    window.__ENEMY_REPORTS__.push(region.textContent.trim())
  }).observe(region, { childList: true, characterData: true, subtree: true })
})
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
const enemyTurnReports = await page.evaluate(() => window.__ENEMY_REPORTS__ ?? [])
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
check('every enemy turn reaches the live region, including a repeat', () => {
  const spoken = enemyTurnReports.filter(Boolean)
  assert(spoken.length >= 2,
    `expected one announcement per enemy turn, got ${JSON.stringify(enemyTurnReports)}`)
  // Between the two reports the region must have gone empty. Without that a
  // second identical enemy turn re-sets the same string, React bails on
  // Object.is, no mutation fires, and the player hears nothing.
  const firstReport = enemyTurnReports.indexOf(spoken[0])
  const secondReport = enemyTurnReports.indexOf(spoken[1], firstReport + 1)
  assert(enemyTurnReports.slice(firstReport + 1, secondReport).some((entry) => entry === ''),
    `the region was never cleared between turns: ${JSON.stringify(enemyTurnReports)}`)
})
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

check('the newest line is visibly emphasised, not just positioned', () => {
  assert(logShape.olderColour, 'need a non-divider older line to compare against')
  assert(
    logShape.newestColour !== logShape.olderColour,
    `the newest line looks identical to an older one (${logShape.newestColour})`,
  )
})

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
await shot('05e-card-rewards-hidden')
while (await potionSkips.count()) await potionSkips.first().click()
for (const player of hiddenRewardRun.players) {
  await page.getByRole('button', { name: `Reveal 3 for ${player.name}` }).click()
}
await page.waitForFunction(() => document.querySelectorAll('.reward-screen__cards .card').length === 6)
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
await shot('05f-back-on-map')

// Hit feedback has to survive the rest of the combat. The flinch class used to
// stick forever the first time a state change landed inside its 380ms window
// without hurting anyone — and being unchanged, it then never re-animated.
await page.evaluate(() => window.__STS_DEBUG__.reset(2, 'flinch'))
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
  assert(orbView.label.includes('lightning orb'), `and named to a screen reader: ${orbView.label}`)
  assert(orbView.label.includes('frost orb'), `both of them: ${orbView.label}`)
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
const rainbow = await readState()
check('Rainbow+ channels Lightning, Frost, and Dark in order without Exhausting', () => {
  assertDeepEqual(rainbow.players[0].orbs, ['lightning', 'frost', 'dark'])
  assertEqual(rainbow.players[0].energy, 1)
  assertEqual(rainbow.players[0].discard.some((card) => card.uid === 'ui-rainbow'), true)
  assertEqual(rainbow.players[0].exhaust.some((card) => card.uid === 'ui-rainbow'), false)
})
await shot('06r-rainbow-orbs')

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
await page.locator('.end-turn-order summary').click()
const panacheTarget = page.getByRole('combobox', { name: /Target for .*Panache/ })
const panacheTargetUid = await panacheTarget.locator('option').nth(1).getAttribute('value')
await panacheTarget.selectOption(panacheTargetUid)
await page.getByRole('button', { name: 'End turn' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().enemies[1].hp === 15)
const panache = await readState()
check('Panache+ resolves the selected row at end of turn', () => {
  assertEqual(panache.enemies[0].hp, 20)
  assertEqual(panache.enemies[1].hp, 15)
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
check('hand cards stay put on hover and are not clipped at the top edge', () => {
  assertEqual(restingCardTop.handOverflowY, 'visible')
  assertDeepEqual(restingCardTop.blockers, [], `resting card top is clipped at ${restingCardTop.top}`)
  assertDeepEqual(hoveredCardTop.blockers, [], `hovered card top is clipped at ${hoveredCardTop.top}`)
  assertEqual(hoveredCardTop.top, restingCardTop.top, 'hover moved the card')
})
await page.setViewportSize({ width: 1200, height: 650 })
await page.mouse.move(0, 0)
await page.waitForTimeout(250)
const shortViewportCard = page.getByRole('button', { name: /^Scrawl\+,/ })
const shortRestingCardTop = await inspectCardTop(shortViewportCard)
await shortViewportCard.hover()
await page.waitForTimeout(250)
const shortHoveredCardTop = await inspectCardTop(shortViewportCard)
check('short desktop viewports preserve the stationary unclipped card', () => {
  assertDeepEqual(shortRestingCardTop.blockers, [], `resting card top is clipped at ${shortRestingCardTop.top}`)
  assertDeepEqual(shortHoveredCardTop.blockers, [], `hovered card top is clipped at ${shortHoveredCardTop.top}`)
  assertEqual(shortHoveredCardTop.top, shortRestingCardTop.top, 'short viewport hover moved the card')
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
await page.getByText('Havoc — play the drawn card for 0 Energy').waitFor()
const havocForced = page.getByRole('button', { name: /^Strike, cost 0,/ })
await havocForced.waitFor()
const heldDuringHavoc = page.getByRole('button', { name: /^Defend,/ })
const havocForcedEnabled = await havocForced.isEnabled()
const heldDuringHavocEnabled = await heldDuringHavoc.isEnabled()
const havocEndTurnActions = await page.getByRole('button', { name: 'End turn' }).count()
const havocShivActions = await page.getByRole('button', { name: /Use Shiv/ }).count()
const havocMiracleActions = await page.getByRole('button', { name: /Use Miracle/ }).count()
check('Havoc+ explains its cleanup and locks the hand to its free draw', () => {
  assert(havocLabel.includes('exhaust it unless it is a Power'), havocLabel)
  assertEqual(havocForcedEnabled, true)
  assertEqual(heldDuringHavocEnabled, false)
  assertEqual(havocEndTurnActions, 0)
  assertEqual(havocShivActions, 0)
  assertEqual(havocMiracleActions, 0)
})
await shot('06zpc-havoc-forced-card')
await havocForced.click()
await page.waitForSelector('.enemy--targeted')
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
    hand: [{ uid: 'ui-defragment', defId: 'defragment', upgraded: true }],
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
await page.getByRole('button', { name: 'End turn' }).click()
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
await page.getByRole('button', { name: 'End turn' }).click()
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
await page.getByRole('button', { name: 'Evoke Lightning in row 2' }).waitFor()
await shot('06zphgce-electrodynamics-row-choice')
await page.getByRole('button', { name: 'Evoke Lightning in row 2' }).click()
await page.getByRole('button', { name: 'Evoke Lightning in row 1' }).click()
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
await page.locator('.end-turn-order > summary').click()
const loopTarget = page.getByRole('combobox', { name: /Target for Defect — Loop/ })
const loopTargetUid = await loopTarget.locator('option', { hasText: 'Lightning Orb 1 → Red Louse' }).getAttribute('value')
await loopTarget.selectOption(loopTargetUid)
await shot('06zphgic1-loop-order')
await page.setViewportSize({ width: 1280, height: 800 })
const compactLoopOrder = await page.locator('.end-turn-order[open] > ol').evaluate((panel) => {
  const rect = panel.getBoundingClientRect()
  return {
    insideViewport: rect.left >= 0 && rect.right <= innerWidth,
    rowsFit: [...panel.querySelectorAll('li')].every((row) => row.scrollWidth <= row.clientWidth),
  }
})
check('Loop target choices stay inside a narrow end-turn tray', () => {
  assert(compactLoopOrder.insideViewport, 'the end-turn tray left the viewport')
  assert(compactLoopOrder.rowsFit, 'an end-turn ability row overflowed its tray')
})
await shot('06zphgic1a-loop-compact-desktop-order')
await page.setViewportSize({ width: 1440, height: 900 })
await page.getByRole('button', { name: 'End turn' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'discard')
const looped = await readState()
check('Loop+ visibly chooses one Orb and repeats its end-of-turn ability twice', () => {
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
  await page.getByRole('button', { name: /^Whirlwind, cost 0,/ }).click()
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
await page.getByRole('button', { name: /^Whirlwind\+, cost 0,/ }).click()
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
await page.getByText('Mayhem — play the drawn card for 0 Energy').waitFor()
const forcedMayhem = page.getByRole('button', { name: /^Meteor Strike\+, cost 0,/ })
await forcedMayhem.waitFor()
const mayhemPowerLabel = await page.locator('.power[aria-label^="Mayhem+"]').getAttribute('aria-label')
const forcedMayhemEnabled = await forcedMayhem.isEnabled()
check('Mayhem announces its discard fallback and enables an otherwise unaffordable card', () => {
  assert(mayhemPowerLabel.includes('if it cannot be played, discard it'), mayhemPowerLabel)
  assertEqual(forcedMayhemEnabled, true)
})
await shot('06zq-mayhem-forced-card')
await forcedMayhem.click()
await page.waitForSelector('.enemy--targeted')
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
await page.getByRole('button', { name: /^Survivor, cost 0,/ }).click()
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
    'ui-second-wind-sentinel', 'ui-second-wind-defend',
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
    'ui-fiend-fire-strike', 'ui-fiend-fire-sentinel', 'ui-fiend-fire',
  ])
  assertEqual(fiendFire.players[0].block, 4)
  assertEqual(fiendFire.players[0].energy, 2)
})
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
const discountedDiscardTop = await page.locator('.pile__top').filter({ hasText: 'Streamline+' }).textContent()
check('discounted attacks spend their current cost and still resolve', () => {
  assertEqual(discountedPlay.players[0].energy, 0)
  assertEqual(discountedPlay.players[0].hand.length, 0)
  assertEqual(discountedDiscardTop, '0 · Streamline+')
})
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
await page.getByRole('button', { name: /^Expertise\+,/ }).click()
const silentTurnCards = await readState()
check('Silent turn cards resolve discard, draw-to-size, Block, and all-enemy damage', () => {
  assertEqual(silentTurnCards.players[0].powers.length, 0)
  assertEqual(silentTurnCards.players[0].block, 4)
  assertEqual(silentTurnCards.players[0].energy, 3)
  assertEqual(silentTurnCards.players[1].energy, 2)
  assert(silentTurnCards.players[0].exhaust.some((card) => card.uid === 'ui-setup'))
  assertEqual(silentTurnCards.players[0].hand.length, 7)
  assert(silentTurnCards.players[0].discard.some((card) => card.uid === 'ui-all-out-discard'))
  assert(silentTurnCards.enemies.every((enemy) => enemy.hp === enemy.maxHp - 3))
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
    draw: [], discard: [], exhaust: [], powers: [], energy: 6, block: 0, shivs: 1,
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
    card.label.includes('Weak and Poison on the target')))
})
await shot('07o-silent-modifier-cards-ready')
await page.getByRole('button', { name: /^Accuracy\+,/ }).click()
await page.getByRole('button', { name: /^Footwork\+,/ }).click()
await page.getByRole('button', { name: /^Envenom\+,/ }).click()
await page.getByRole('button', { name: 'Use Shiv' }).click()
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
  if (artSynced) assert(simmeringCard.artWidth >= 700, `expected upscaled art, got ${simmeringCard.artWidth}px`)
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
if (artSynced) assert(likeWaterArtWidth >= 700, `expected upscaled Like Water art, got ${likeWaterArtWidth}px`)
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
if (artSynced) assert(battleHymnArtWidth >= 700, `expected upscaled Battle Hymn art, got ${battleHymnArtWidth}px`)
await battleHymnCard.click()
const battleHymnPowerLabel = await page.getByRole('button', { name: /^Battle Hymn\+?:/ }).getAttribute('aria-label')
check('Battle Hymn+ exposes its Wrath bonus and activation accessibly', () => {
  assert(battleHymnPowerLabel.includes('2 +2 if you are in wrath damage'), battleHymnPowerLabel)
  assert(battleHymnPowerLabel.includes('activate once per turn'), battleHymnPowerLabel)
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
if (artSynced) assert(mentalFortressArtWidth >= 700, `expected upscaled Mental Fortress art, got ${mentalFortressArtWidth}px`)
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
if (artSynced) assert(rushdownArtWidth >= 700, `expected upscaled Rushdown art, got ${rushdownArtWidth}px`)
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
if (artSynced) assert(watcherBatchArt.every((width) => width >= 700),
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
if (artSynced) assert(await artWidth(foresightCard) >= 700, 'expected upscaled Foresight art')
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
await page.locator('.end-turn-order > summary').click()
await page.locator('.end-turn-order button[aria-label*="Infinite Blades"][aria-label$="earlier"]').click()
await page.locator('.end-turn-order > summary').click()
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
await waitForAutomaticTurn(3)
await page.locator('.combat[data-phase="player"]').waitFor()
const noxiousAll = await readState()
check('upgraded Noxious Fumes automatically poisons every enemy', () => {
  assert(noxiousUpgradedLabel.includes('1 Poison to every enemy'), noxiousUpgradedLabel)
  assert(noxiousAll.enemies.every((enemy) => enemy.poison === (enemy.dead ? 0 : 1)))
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
// The app automatically folds a victory into the run after 900ms. A full-page
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
const firedPotion = await readState()
check('a targeted potion waits for an enemy, then consumes itself', () => {
  const durability = firedPotion.enemies.reduce((sum, enemy) => sum + enemy.hp + enemy.block, 0)
  assertEqual(durability, durabilityBeforePotion - 4)
  assertEqual(firedPotion.players[0].potions.includes('fire_potion'), false)
})

const explosiveTarget = firedPotion.enemies
  .filter((enemy) => !enemy.dead && !enemy.isBoss)
  .sort((a, b) => b.row - a.row)[0]
assert(explosiveTarget, 'the browser potion playtest needs one living row target')
await page.setViewportSize({ width: 1280, height: 800 })
await page.locator('.combat__actions').getByRole('button', { name: /Explosive Potion/ }).click()
await page.waitForSelector('.row__potion-target')
const compactRowTargets = page.locator('.row__potion-target')
const compactRowTargetGeometry = await compactRowTargets.evaluateAll((targets) => {
  const board = document.querySelector('.board')
  const seats = [...document.querySelectorAll('.row .row__seat')]
  const x = (element) => element.getBoundingClientRect().left + board.scrollLeft
  return {
    targetSteps: targets.slice(1).map((target, index) => Math.round(x(target) - x(targets[index]))),
    seatSteps: seats.slice(1).map((seat, index) => Math.round(x(seat) - x(seats[index]))),
    sizes: targets.map((target) => {
      const box = target.getBoundingClientRect()
      return { width: box.width, height: box.height }
    }),
  }
})
const compactRowTargetReachability = []
for (const target of await compactRowTargets.all()) {
  await target.scrollIntoViewIfNeeded()
  compactRowTargetReachability.push(await target.evaluate((button) => {
    const board = button.closest('.board').getBoundingClientRect()
    const box = button.getBoundingClientRect()
    return box.left >= board.left - 1 && box.right <= board.right + 1
  }))
}
check('two-player compact desktop row targets track their lanes and remain reachable', () => {
  assertDeepEqual(compactRowTargetGeometry.targetSteps, compactRowTargetGeometry.seatSteps)
  assert(compactRowTargetGeometry.sizes.every((size) => size.width >= 44 && size.height >= 44),
    `row target below 44px: ${JSON.stringify(compactRowTargetGeometry.sizes)}`)
  assert(compactRowTargetReachability.every(Boolean), 'a row target cannot be scrolled fully into the board viewport')
})
await page.locator('.prompt').evaluate(async (element) => {
  await Promise.all(element.getAnimations().map((animation) => animation.finished))
})
await shot('05h-explosive-potion-row-targeting')
await page.getByRole('button', { name: `Target row ${explosiveTarget.row + 1}` }).click()
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
const deadPotionSummary = await page.locator('.seat--viewer .seat__potions').textContent()
check('a dead seat keeps public potion information but gets no Player Turn controls', () => {
  assertEqual(deadPotionControls, 0)
  assert(deadPotionSummary.includes('Energy Potion'))
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

async function hurtViewer() {
  await page.evaluate(() => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.combat.players[0].hp -= 1
    debug.setRun(run)
  })
}

// Two alternating classes, so a second hit inside the window restarts the
// animation instead of leaving the class name unchanged.
const FLINCHING = '.seat--struck, .seat--struck-alt'
async function flinchCount(expected) {
  await page
    .waitForFunction(
      ({ want, selector }) => document.querySelectorAll(selector).length === want,
      { want: expected, selector: FLINCHING },
      { timeout: 2000 },
    )
    .catch(() => {})
  return page.locator(FLINCHING).count()
}

await hurtViewer()
const flinchedAtOnce = await flinchCount(1)
// A state change that hurts nobody, landing inside the flinch window.
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[0].gold += 1
  debug.setRun(run)
})
const flinchCleared = await flinchCount(0)
await hurtViewer()
const flinchedAgain = await flinchCount(1)

check('a hit is felt, and keeps being felt for the rest of the combat', () => {
  assertEqual(flinchedAtOnce, 1, 'the damaged seat should flinch')
  assertEqual(flinchCleared, 0, 'and stop flinching even if another change interrupts')
  assertEqual(flinchedAgain, 1, 'and flinch again on the next hit')
})

// Two blows landing inside the same 380ms window: the class has to CHANGE, or
// the browser never restarts the animation and the second hit is not felt.
await flinchCount(0)
await page.evaluate(() => {
  window.__STS_FLINCHES__ = []
  document.addEventListener('animationstart', (event) => {
    if (event.animationName.startsWith('struck')) window.__STS_FLINCHES__.push(event.animationName)
  })
})
for (let i = 0; i < 2; i++) {
  const before = await page.evaluate(() => window.__STS_FLINCHES__.length)
  await hurtViewer()
  await page.waitForFunction((count) => window.__STS_FLINCHES__.length > count, before)
}
const beats = await page.evaluate(() => ({
  count: window.__STS_FLINCHES__.length,
  names: window.__STS_FLINCHES__,
}))
check('two hits in quick succession are both felt', () => {
  assert(beats.count >= 2, `expected at least two flinches, got ${beats.count}`)
  assertEqual(new Set(beats.names).size, 2,
    `the two flinches must use different animations to restart: ${beats.names.join(', ')}`)
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
const corpseView = await page.evaluate(() => {
  const tile = document.querySelector('.enemy--dead')
  return {
    found: tile != null,
    intents: tile?.querySelectorAll('.intent').length ?? -1,
    tokens: tile?.querySelectorAll('.token').length ?? -1,
    disabled: tile?.disabled ?? false,
    label: tile?.getAttribute('aria-label') ?? '',
  }
})
check('a defeated enemy stops telegraphing and stops carrying tokens', () => {
  assert(corpseView.found, `expected a defeated enemy on the board (${corpse})`)
  assertEqual(corpseView.intents, 0, 'a corpse has no intent')
  assertEqual(corpseView.tokens, 0, 'and no tokens')
  assert(corpseView.disabled, 'and cannot be clicked')
  assert(corpseView.label.includes('defeated'), `and says so: ${corpseView.label}`)
})

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
await page.evaluate(async () => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.players[0].hand = Array.from({ length: 5 }, (_unused, i) => ({
    uid: `fan-${i}`,
    defId: 'strike_ironclad',
    upgraded: false,
  }))
  debug.setRun(run)
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
})
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

// The energy count sits ON the gold disc, so it cannot be gold.
const energyContrast = await page.evaluate(() => {
  const pip = document.querySelector('.pip--energy')
  const number = pip?.querySelector('.icon-value__number')
  if (!pip || !number) return { missing: true }
  const pipBox = pip.getBoundingClientRect()
  const numberBox = number.getBoundingClientRect()
  const iconBox = pip.querySelector('.icon').getBoundingClientRect()
  const pairBox = {
    left: Math.min(numberBox.left, iconBox.left),
    right: Math.max(numberBox.right, iconBox.right),
    top: Math.min(numberBox.top, iconBox.top),
    bottom: Math.max(numberBox.bottom, iconBox.bottom),
  }
  const parse = (value) => (value.match(/\d+/g) ?? []).slice(0, 3).map(Number)
  const lum = ([r, g, b]) => {
    const channel = (v) => {
      const c = v / 255
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
  }
  const ink = lum(parse(getComputedStyle(number).color))
  // The disc is a gradient; sample its lightest declared stop conservatively.
  const plate = lum([255, 226, 150])
  const ratio = (Math.max(ink, plate) + 0.05) / (Math.min(ink, plate) + 0.05)
  return {
    missing: false,
    ratio,
    pairCenterOffset: Math.hypot(
      (pairBox.left + pairBox.right - pipBox.left - pipBox.right) / 2,
      (pairBox.top + pairBox.bottom - pipBox.top - pipBox.bottom) / 2,
    ),
    contained: pairBox.left >= pipBox.left && pairBox.right <= pipBox.right &&
      pairBox.top >= pipBox.top && pairBox.bottom <= pipBox.bottom,
  }
})
check('the energy count is readable on its disc', () => {
  assert(!energyContrast.missing, 'expected an energy pip')
  assert(
    energyContrast.ratio >= 4.5,
    `the count contrasts at ${energyContrast.ratio.toFixed(2)}:1 against the disc`,
  )
  assert(energyContrast.contained, 'the energy count is clipped by its disc')
  assert(energyContrast.pairCenterOffset <= 1,
    `the energy count and icon are ${energyContrast.pairCenterOffset}px off-centre`)
})

// Four players is the maximum the box supports and the layout most likely to
// break, so it gets its own capture.
await page.evaluate(() => window.__STS_DEBUG__.reset(4, 'four-player'))
await bypassNeow()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().players.length === 4)
await shot('06a-four-player-map')
await enterFirstRoom()
const four = await shot('06-four-players')
check('a four player game lays out one row per player', () => {
  const mainEnemies = four.enemies.filter((enemy) => !enemy.uid.includes('-summon'))
  assertEqual(four.players.length, 4, 'four seats')
  assertEqual(new Set(four.players.map((p) => p.row)).size, 4, 'each player gets their own row')
  assertEqual(mainEnemies.length, 4, 'a normal encounter draws one card per player')
  assertEqual(new Set(mainEnemies.map((enemy) => enemy.defId)).size, 4, 'opening cards are not duplicated')
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
  assert(sweeping.includes('affects every enemy'), `Sweeping Beam target is missing: ${sweeping}`)
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
await page.waitForFunction(() => document.querySelector('.pile__top')?.textContent?.includes('Deflect'))
const compactPileTop = await page.locator('.pile__top').first().evaluate((element) => {
  const box = element.getBoundingClientRect()
  return {
    text: element.textContent ?? '',
    visible: box.width > 0 && box.height > 0,
    onScreen: box.left >= 0 && box.right <= window.innerWidth,
  }
})
check('the top discard card and cost are visible on minimum desktop screens', () => {
  assert(compactPileTop.visible, 'the top card should be painted')
  assert(compactPileTop.onScreen, 'the top card should fit on screen')
  assert(/0 · Deflect/.test(compactPileTop.text), `expected Deflect and its cost, got ${compactPileTop.text}`)
})
await shot('15-compact-desktop-discard-top')

// A card keeps its uid when it cycles through the deck. A top-card choice from
// one turn must not silently select that same card when it comes back later.
await chooseSeat('p1')
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
await page.locator('.end-turn-order > summary').click()
for (let step = 0; step < 6; step++) {
  await page.getByRole('button', { name: /Move Ironclad — Shame earlier/ }).click()
}
const visibleEndTurnOrder = await page.locator('.end-turn-order li span').allTextContents()
check('the player can order end-of-turn abilities before committing', () => {
  assert(visibleEndTurnOrder.findIndex((label) => label.endsWith('Shame')) <
    visibleEndTurnOrder.findIndex((label) => label.endsWith('Decay')),
    `expected Shame before Decay: ${visibleEndTurnOrder.join(' → ')}`)
  assert(visibleEndTurnOrder.some((label) => label.endsWith('Lightning Orb 1')),
    'each Orb should appear as its own ability')
})
await shot('15bb-end-turn-order')
await page.getByRole('button', { name: 'End turn' }).click()
await page.getByRole('alert').filter({ hasText: STALE_END_TURN_ORDER }).waitFor()
const rejectedOrbPlan = await readState()
check('a stale Lightning target keeps the whole end-turn plan editable', () => {
  assertEqual(rejectedOrbPlan.phase, 'player')
  assertDeepEqual(rejectedOrbPlan.enemies.map((enemy) => enemy.hp), [1, 4],
    'the rejected plan must not leak partial Orb damage')
})
await shot('15bba-stale-orb-target')
await page.getByLabel('Target for Ironclad — Lightning Orb 2').selectOption({ label: 'Acid Slime' })
await page.getByRole('button', { name: 'End turn' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'discard')
const cursePrepared = await readState()
check('the Curse end-turn step resolves before discard ordering', () => {
  const player = cursePrepared.players[0]
  assertEqual(player.hp, 7, 'the chosen Shame-before-Decay order exposes one damage')
  assertEqual(player.block, 0, 'Shame removes the only Block before Decay')
  assertEqual(player.weak, 1, 'Doubt grants Weak')
  assertDeepEqual(cursePrepared.enemies.map((enemy) => enemy.hp), [0, 3],
    'each Lightning Orb uses its selected target')
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
    ? { ...player, potions: ['entropic_brew', 'energy_potion', 'energy_potion'] }
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
await page.locator('.map[inert]').waitFor()
const localOwnerMapBlocked = await page.locator('.map').evaluate((map) => {
  const room = map.querySelector('button')
  room?.focus()
  return map.inert && document.activeElement !== room
})
await chooseSeat(localRelicSeats[1])
await page.getByRole('status').filter({ hasText: 'Waiting for Ironclad to resolve Astrolabe' }).waitFor()
await page.locator('.map[inert]').waitFor()
const localTeammateMapBlocked = await page.locator('.map').evaluate((map) => {
  const room = map.querySelector('button')
  room?.focus()
  return map.inert && document.activeElement !== room
})
check('a mandatory local Relic makes owner and teammate map progression inert', () => {
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
await page.evaluate(() => window.__STS_DEBUG__.reset(2, 'campfire'))
await bypassNeow()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().players.length === 2)
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.phase = 'room'
  run.map.position = run.map.rows[run.map.rows.length - 2][0]
  run.players = run.players.map((player) => ({ ...player, hp: 4 }))
  debug.setRun(run)
})
await page.waitForSelector('.campfire')
// Four seats offering "Rest" and "Smith" are indistinguishable in a tab ring
// without a per-seat name.
const campfireSeatNames = await page.evaluate(() => [...document.querySelectorAll('.campfire__player')]
  .map((seat) => ({ role: seat.getAttribute('role'), label: seat.getAttribute('aria-label') })))
check('each campfire seat is named for the player it belongs to', () => {
  assert(campfireSeatNames.length > 1, 'expected more than one seat')
  assert(campfireSeatNames.every((seat) => seat.role === 'group' && /\d+ of \d+ HP$/.test(seat.label ?? '')),
    `seats not individually named: ${JSON.stringify(campfireSeatNames)}`)
  assertEqual(new Set(campfireSeatNames.map((seat) => seat.label)).size, campfireSeatNames.length,
    'two seats share a name')
})

const leaveLockedBefore = await page.locator('.campfire__leave').isDisabled()
check('a campfire will not let the party leave until everyone has chosen', () => {
  assert(leaveLockedBefore, 'the leave button must be disabled while a choice is outstanding')
})

await page.locator('.campfire__player').nth(0).getByRole('button', { name: /Rest/ }).click()
await page.locator('.campfire__player').nth(1).getByRole('button', { name: /Smith/ }).click()
await page.waitForSelector('.campfire__deck .card')
await shot('12-campfire')
await page.locator('.campfire__deck .card').first().click()
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
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  debug.setRun({ ...structuredClone(debug.getRun()), phase: 'defeat' })
})
await page.getByRole('button', { name: 'Record campaign result' }).click()
await page.getByRole('button', { name: 'Begin next run →' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'neow')
const ascensionRetry = await readRun()
check('the campaign journal next run preserves every Ascension setup modifier', () => {
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
await page.getByText('Choose a row for Combust+').waitFor()
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
await page.getByText('Choose a row for Combust+').waitFor({ state: 'hidden' })
const stagedCombustDuringForcedCard = await page.getByText('Choose a row for Combust+').count()
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
await page.getByRole('button', { name: 'Target row 1' }).click()
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
await page.getByText("Ironclad's Fire Breathing+ — choose a row").waitFor()
const fireRows = await page.getByRole('button', { name: /^Resolve .*Fire Breathing\+ in row/ }).count()
check('Fire Breathing pauses on a visible row picker for each qualifying draw', () => {
  assert(firePowerLabel.includes('whenever you draw a status or curse card'))
  assertEqual(fireRows, 2)
})
await shot('16e-fire-breathing-choice')
await page.getByRole('button', { name: /Fire Breathing\+ in row 2$/ }).click()
await page.getByRole('button', { name: /Fire Breathing\+ in row 1$/ }).click()
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
if (artSynced) assert(ironcladRareArt.every((width) => width >= 700),
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
await page.getByText("Ironclad's Berserk+ — choose a row").waitFor()
assertEqual(await page.getByRole('button', { name: /^Resolve .*Berserk\+ in row/ }).count(), 2)
await page.getByRole('button', { name: /Berserk\+ in row 2$/ }).click()
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
if (artSynced) assert(silentRareArt.every((width) => width >= 700),
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
await page.getByText("Silent's A Thousand Cuts+ — choose a row").waitFor()
const thousandCutsPower = page.locator('.power[aria-label^="A Thousand Cuts+"]')
await thousandCutsPower.click()
await shot('16h-silent-shuffle-x-rares')
await thousandCutsPower.click()
await page.getByRole('button', { name: /A Thousand Cuts\+ in row 2$/ }).click()
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
if (artSynced) assert(await artWidth(burstCard) >= 700)
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
if (artSynced) assert(await artWidth(bulletTimeCard) >= 700)
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
if (artSynced) assert(await artWidth(corpseExplosionCard) >= 700)
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
  if (artSynced) assert(attachmentWidth >= 700)
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
    hand: [
      { uid: 'ui-double-tap-aoe', defId: 'double_tap', upgraded: true },
      { uid: 'ui-double-immolate', defId: 'immolate', upgraded: false },
    ],
    draw: [], discard: [], exhaust: [], energy: 3,
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
await page.getByRole('button', { name: /^Immolate,/ }).click()
await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'player' &&
  window.__STS_DEBUG__.getState().players[0].attacksPlayedThisTurn === 2)
const doubledAoe = await readState()
check('a Double Tap copy with no choices auto-resolves instead of deadlocking', () => {
  assertDeepEqual(doubledAoe.enemies.map((enemy) => enemy.hp), [10, 10])
  assertEqual(doubledAoe.players[0].draw.filter((card) => card.defId === 'daze').length, 4)
  assertEqual(doubledAoe.players[0].energy, 1)
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
await page.evaluate(() => window.__STS_DEBUG__.reset(1, 'boss-gallery'))
await bypassNeow()
await enterFirstRoom()
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
  image: card.querySelector('img')?.getAttribute('src'),
  loaded: (card.querySelector('img')?.naturalWidth ?? 0) > 0,
  objectFit: getComputedStyle(card.querySelector('img')).objectFit,
  maskImage: getComputedStyle(card.querySelector('img')).maskImage,
  box: card.getBoundingClientRect().toJSON(),
})))
check('boss portraits, backdrops, mechanics, and accessible labels render together', () => {
  assert(bossVisuals.every((boss) => boss.loaded), 'a tracked boss portrait did not load')
  assert(bossVisuals.every((boss) => boss.objectFit === 'contain' && boss.maskImage === 'none'),
    'a boss portrait is cropped or masked')
  assert(bossVisuals.every((boss) => boss.background.includes('/assets/backgrounds/boss-act-')),
    'a boss is missing its act backdrop')
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
await page.locator('.relic-actions > summary').click()
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
  run.combat.phase = 'start'
  run.combat.die = 3
  actor.potions = ['gamblers_brew']
  actor.relics = [
    { defId: 'dollys_mirror', spent: false },
    { defId: 'nilrys_codex', spent: false },
    { defId: 'loaded_die', spent: false },
    { defId: 'charons_ashes', spent: false },
    { defId: 'the_abacus', spent: false },
  ]
  debug.setRun(run)
})
await page.locator('.relic-actions > summary').click()
const invalidPostRollRelics = await page.getByRole('button', {
  name: /Use (Dolly's Mirror|Nilry's Codex|Loaded Die|Charon's Ashes)/,
}).count()
await page.getByRole('button', { name: 'Use The Abacus' }).waitFor()
const validPostRollRelic = await page.getByRole('button', { name: 'Use The Abacus' }).count()
check('a paused post-roll window shows only Relics matching the rolled face', () => {
  assertEqual(invalidPostRollRelics, 0)
  assertEqual(validPostRollRelic, 1)
})
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.combat.startTurnProgress = { choices: [] }
  debug.setRun(run)
})
await page.waitForFunction(() => ![...document.querySelectorAll('button')]
  .some((button) => button.textContent?.trim() === 'Use The Abacus'))
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
// chrome.css for why that is a product invariant), one face renders as
// `.neow-face--solo` — absolutely positioned, ~90px tall, bottom ~234px into the
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
