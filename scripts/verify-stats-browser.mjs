#!/usr/bin/env node
import { mkdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as createViteServer } from 'vite'
import { chromium } from './lib/profile-browser.mjs'
import { createRoomServer } from './room-server.mjs'
import { statsSnapshot } from './lib/stats.mjs'
import { assert, assertEqual, check, report, suite } from './lib/harness.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = join(root, 'artifacts/stats-explorer-browser')
mkdirSync(output, { recursive: true })
process.env.VITE_LEADERBOARD = 'true'
const server = createRoomServer({ classifierEnabled: true, deckClassifier: async (entry) =>
  entry.character === 'ironclad' ? 'Ironclad Barricade Body Slam Entrench Exhaust Control'
    : entry.finalDeck.some((card) => card.defId === 'claw') ? 'Defect Claw Spam' : 'Defect Lightning Orb Focus' })
const address = await server.listen(0)
const roomOrigin = `http://127.0.0.1:${address.port}`
const vite = await createViteServer({ root, logLevel: 'silent', server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: roomOrigin } } } })
await vite.listen()
const viteAddress = vite.httpServer?.address()
if (!viteAddress || typeof viteAddress === 'string') throw new Error('Vite did not report a port')
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: output, size: { width: 1440, height: 900 } } })
let hostedVite
const page = await context.newPage()
const errors = []
page.on('pageerror', (error) => errors.push(String(error)))
const checkAsync = async (label, assertion) => {
  try { await assertion(); check(label, () => {}) }
  catch (error) { check(label, () => { throw error }) }
}

const card = (defId, upgraded = false) => ({ defId, upgraded })
const deck = (id, character, cards, floorsCleared, damageDealt, damageTaken, damageBlocked) => ({
  id: `browser-1234:stats-${id}`, character, ascension: 3, mode: 'standard',
  damageStatsComplete: true, startedAtAct: 1, highestBossActDefeated: 0,
  combatsFinished: 10, damageDealt, damageTaken, damageBlocked, floorsCleared, finalDeck: cards,
})

try {
  suite('stats explorer browser')
  const submissions = [
    deck(1, 'defect', [card('dual_cast'), card('strike_defect')], 20, 100, 30, 70),
    { ...deck(2, 'defect', [card('dual_cast', true), card('coolheaded')], 30, 220, 20, 80), ascension: 9 },
    deck(3, 'defect', [card('dual_cast'), card('coolheaded')], 24, 180, 40, 60),
    deck(4, 'defect', [card('claw')], 12, 130, 70, 30),
    deck(5, 'ironclad', [card('barricade'), card('body_slam')], 32, 260, 10, 90),
    deck(6, 'defect', [card('dual_cast'), card('claw')], 18, 140, 60, 40),
  ]
  for (const submission of submissions) {
    const response = await fetch(`${roomOrigin}/api/leaderboard`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(submission) })
    assertEqual(response.status, 201)
  }
  for (let attempt = 0; attempt < 100 && server.store.leaderboardRuns.some((run) => !run.deckType); attempt++)
    await new Promise((done) => setTimeout(done, 10))
  check('server classifies the browser fixture without public AI requests', () => {
    assertEqual(server.store.leaderboardRuns.filter((run) => run.deckType).length, 6)
  })

  await page.goto(`http://127.0.0.1:${viteAddress.port}`, { waitUntil: 'networkidle' })
  await page.setViewportSize({ width: 844, height: 390 })
  await page.screenshot({ path: join(output, 'stats-menu-horizontal-phone.png') })
  await checkAsync('Stats menu entry fits the horizontal phone before opening the archive', async () => {
    const entry = await page.getByRole('button', { name: 'Stats', exact: true }).boundingBox()
    assert(entry && entry.y >= 0 && entry.y + entry.height <= 390)
    const profile = await page.locator('.start-menu__profile').boundingBox()
    assert(profile)
    for (const button of await page.locator('.start-menu__nav button').all()) {
      const box = await button.boundingBox()
      assert(box && box.y >= profile.y + profile.height && box.y + box.height <= 390)
    }
  })
  await page.setViewportSize({ width: 568, height: 320 })
  await page.locator('.start-menu__nav').evaluate((navigation) => {
    const selected = navigation.querySelector('button')
    const resume = selected.cloneNode(true)
    selected.dataset.selected = 'false'
    resume.textContent = 'Resume'
    resume.setAttribute('aria-label', 'Resume')
    navigation.prepend(resume)
  })
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(output, 'stats-menu-small-horizontal-phone.png') })
  await checkAsync('all menu entries fit a small horizontal phone with Resume available', async () => {
    assertEqual(await page.locator('.start-menu__nav button[data-selected="true"]').count(), 1)
    const profile = await page.locator('.start-menu__profile').boundingBox()
    assert(profile)
    for (const button of await page.locator('.start-menu__nav button').all()) {
      const box = await button.boundingBox()
      assert(box && box.y >= profile.y + profile.height && box.y + box.height <= 320, `${await button.innerText()} is clipped`)
    }
  })
  await page.getByRole('button', { name: 'Resume' }).evaluate((button) => button.remove())
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByRole('button', { name: 'Stats', exact: true }).click()
  await page.getByRole('heading', { name: 'Deck archetypes' }).waitFor()
  await page.getByRole('button', { name: /Defect Lightning Orb Focus/ }).waitFor()
  await page.screenshot({ path: join(output, 'stats-desktop.png') })
  await checkAsync('header actions keep their compact type instead of the inherited button font', async () => {
    await page.getByRole('searchbox', { name: 'Find a card for All of these' }).fill('Dual Cast')
    await page.getByRole('listbox', { name: 'All of these suggestions' }).getByRole('option').first().click()
    const sizes = await page.evaluate(() => ['.stats__clear', '.stats__chip', '.stats__editor-tabs button']
      .map((selector) => getComputedStyle(document.querySelector(selector)).fontSize))
    assert(sizes.every((size) => parseFloat(size) < 14), `Header action font sizes: ${sizes}`)
    await page.getByRole('button', { name: 'Clear filters' }).click()
  })
  await page.locator('.stats__metric').first().locator('strong').getByText('6', { exact: true }).waitFor()
  await page.locator('.stats__metric').nth(1).locator('strong').getByText('22.7', { exact: true }).waitFor()
  await page.locator('.stats__table tbody tr').nth(2).waitFor()
  await checkAsync('default columns and run averages render from recorded data', async () => {
    for (const heading of ['Deck', 'Floors', 'Damage', 'Block'])
      assertEqual(await page.getByRole('columnheader', { name: heading }).count(), 1)
    assertEqual(await page.locator('.stats__table tbody tr').count(), 3)
    assert((await page.locator('.stats__metrics').innerText()).includes('22.7'))
    await page.waitForFunction(() => {
      const icons = [...document.querySelectorAll('.stats__metric img')]
      return icons.length === 4 && icons.every((icon) => icon.complete && icon.naturalWidth > 0)
    }, undefined, { timeout: 10_000 })
  })

  for (const viewport of [{ width: 1150, height: 700 }, { width: 1200, height: 800 }, { width: 1280, height: 800 }, { width: 1536, height: 864 }, { width: 932, height: 430 }]) {
    await page.setViewportSize(viewport)
    await checkAsync(`card impact text and deck names are not truncated at ${viewport.width}x${viewport.height}`, async () => {
      const fits = await page.locator('.stats__next-name').evaluateAll((names) => names.flatMap((name) => [...name.querySelectorAll('strong, small span')]
        .map((element) => element.scrollWidth <= element.clientWidth && element.getBoundingClientRect().right <= name.getBoundingClientRect().right + 0.5)))
      assert(fits.length > 0 && fits.every(Boolean), `Truncated card impact text: ${fits}`)
      assert(await page.locator('.stats__row-button strong').evaluateAll((names) => names.length === 3 &&
        names.every((name) => name.scrollHeight <= name.clientHeight + 1 && name.scrollWidth <= name.clientWidth)), 'Deck names are truncated')
    })
  }
  await page.setViewportSize({ width: 1440, height: 900 })

  await page.getByRole('searchbox', { name: 'Find a card for None of these' }).fill('s')
  await checkAsync('card suggestions stay above the archetype table header', async () => {
    const listbox = page.getByRole('listbox', { name: 'None of these suggestions' })
    await listbox.waitFor()
    assert(await listbox.evaluate((list) => {
      const box = list.getBoundingClientRect()
      return Array.from({ length: Math.floor(box.height / 8) }, (_, index) => box.top + 4 + index * 8)
        .every((y) => list.contains(document.elementFromPoint(box.left + box.width / 2, y)))
    }), 'Suggestions are covered by other content')
  })
  await page.getByRole('searchbox', { name: 'Find a card for None of these' }).fill('')
  await page.getByLabel('Ascension').selectOption('3+')
  await checkAsync('Ascension 3+ includes higher-level runs', async () => {
    await page.locator('.stats__metric').first().locator('strong').getByText('6', { exact: true }).waitFor()
  })
  await page.getByLabel('Ascension').selectOption('3')
  await checkAsync('exact Ascension 3 excludes the Ascension 9 run', async () => {
    await page.locator('.stats__metric').first().locator('strong').getByText('5', { exact: true }).waitFor()
  })
  await page.getByLabel('Ascension').selectOption('9+')
  await checkAsync('Ascension 9+ narrows the archive and deck samples', async () => {
    await page.locator('.stats__metric').first().locator('strong').getByText('1', { exact: true }).waitFor()
  })
  await page.getByLabel('Ascension').selectOption('all')
  await page.locator('.stats__metric').first().locator('strong').getByText('6', { exact: true }).waitFor()

  await page.getByRole('button', { name: 'Defect', exact: true }).click()
  await page.getByRole('searchbox', { name: 'Find a card for Any of these' }).fill('Dual Cast')
  await page.getByRole('option').filter({ hasText: 'Dual Cast+' }).first().click()
  await page.getByRole('searchbox', { name: 'Find a card for Any of these' }).fill('Dual Cast')
  await page.getByRole('option').filter({ hasText: 'Dual Cast' }).filter({ hasNotText: 'Dual Cast+' }).filter({ hasText: 'Defect' }).first().click()
  await page.getByRole('searchbox', { name: 'Find a card for None of these' }).fill('Strike')
  await page.getByRole('option').filter({ hasText: /^Strike\s*Defect/ }).first().click()
  await page.locator('.stats__metric').first().locator('strong').getByText('3', { exact: true }).waitFor()
  await page.locator('.stats__metric').nth(1).locator('strong').getByText('24.0', { exact: true }).waitFor()
  await page.getByRole('button', { name: /Defect Lightning Orb Focus/ }).waitFor()
  await page.screenshot({ path: join(output, 'stats-filtered-desktop.png') })
  await checkAsync('visual ANY upgrades and NONE starter filters compose', async () => {
    assertEqual(await page.locator('.stats__table tbody tr').count(), 2)
    assert((await page.locator('.stats__metrics').innerText()).includes('24.0'))
  })

  await page.getByRole('button', { name: /Defect Lightning Orb Focus/ }).click()
  await page.getByRole('dialog').waitFor()
  await page.screenshot({ path: join(output, 'stats-random-deck.png') })
  await checkAsync('a matching archetype opens a random, read-only deck', async () => {
    assert((await page.getByRole('dialog').innerText()).includes('Defect Lightning Orb Focus'))
    assert(await page.getByRole('dialog').locator('.card').count() > 0)
  })
  await page.getByRole('dialog').press('Escape')
  await page.getByRole('button', { name: 'Expression' }).click()
  await page.getByLabel('Card expression').fill('(Dual Cast or Dual Cast+) and not (Strike or Strike+)')
  await page.getByRole('button', { name: 'Apply' }).click()
  await checkAsync('expression parser handles parentheses, OR upgrades, and NOT cards', async () => {
    await page.locator('.stats__metric').first().locator('strong').getByText('3', { exact: true }).waitFor()
    await page.locator('.stats__metric').nth(1).locator('strong').getByText('24.0', { exact: true }).waitFor()
    await page.locator('.stats__table tbody tr').nth(1).waitFor()
    assertEqual(await page.locator('.stats__table tbody tr').count(), 2)
  })
  await page.getByLabel('Card expression').fill(`${'not '.repeat(14)}Dual Cast`)
  await page.getByRole('button', { name: 'Apply' }).click()
  await checkAsync('expressions beyond server depth limits fail locally without dropping the last valid query', async () => {
    assert((await page.getByRole('alert').innerText()).includes('nested operators'))
    assertEqual(await page.locator('.stats__table tbody tr').count(), 2)
  })
  await page.getByLabel('Card expression').fill('(Dual Cast or')
  await page.getByRole('button', { name: 'Apply' }).click()
  await checkAsync('invalid expressions explain the error without losing the applied query', async () => {
    assert(await page.getByRole('alert').count() > 0)
    assertEqual(await page.locator('.stats__table tbody tr').count(), 2)
  })
  await page.getByRole('button', { name: 'Visual builder' }).click()
  await page.getByRole('button', { name: 'All heroes', exact: true }).click()
  await page.getByRole('searchbox', { name: 'Find a card for All of these' }).fill('Explosive Corps')
  await checkAsync('the requested Explosive Corps spelling suggests the real card art', async () => {
    assert(await page.getByRole('option').filter({ hasText: 'Corpse Explosion' }).count() >= 2)
    assert(await page.getByRole('option').filter({ hasText: 'Corpse Explosion' }).first().locator('img').isVisible())
  })
  await page.getByRole('searchbox', { name: 'Find a card for All of these' }).fill('')
  await page.locator('.stats__metric').first().locator('strong').getByText('3', { exact: true }).waitFor()
  await page.locator('.stats__table tbody tr').nth(1).waitFor()
  await page.setViewportSize({ width: 844, height: 390 })
  await page.getByRole('heading', { name: 'Deck archetypes' }).waitFor()
  await page.getByRole('heading', { name: 'Deck archetypes' }).click()
  await page.getByRole('listbox').waitFor({ state: 'hidden' })
  await page.locator('.stats__scroll').evaluate((element) => { element.scrollTop = 0 })
  await page.screenshot({ path: join(output, 'stats-horizontal-phone.png') })
  await checkAsync('horizontal phone preserves a visible header, filters, and scrollable results', async () => {
    const frame = await page.locator('.stats').boundingBox()
    const rail = await page.locator('.stats__rail').boundingBox()
    const workbench = await page.locator('.stats__workbench').boundingBox()
    const selects = await page.locator('.stats__rail-selects').boundingBox()
    const tabs = await page.locator('.stats__editor-tabs').boundingBox()
    assert(frame && rail && workbench && rail.height < 80 && workbench.x >= 0 && workbench.x < 844)
    assert(selects && tabs && selects.x + selects.width <= 844 && tabs.x + tabs.width <= 844)
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    assert(await page.getByRole('searchbox', { name: 'Find a card for All of these' }).isVisible())
    const back = await page.locator('.stats__back.ribbon-back').boundingBox()
    assert(back && back.width >= 44 && back.height >= 44 && back.x >= 0 && back.y >= 0 && back.y + back.height <= rail.y + rail.height, 'Back ribbon is clipped or too small')
    const heroes = await page.locator('.stats__heroes button').evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().right))
    assert(heroes.length === 9 && heroes.every((right) => right <= selects.x), `Hero buttons hidden behind filters: ${heroes}`)
  })
  await page.setViewportSize({ width: 568, height: 320 })
  await page.screenshot({ path: join(output, 'stats-small-horizontal-phone.png') })
  await checkAsync('small horizontal phone keeps every hero and filter in the top bar', async () => {
    const back = await page.locator('.stats__back.ribbon-back').boundingBox()
    const selects = await page.locator('.stats__rail-selects').boundingBox()
    const heroes = await page.locator('.stats__heroes').evaluate((strip) => ({
      scrolls: strip.scrollWidth > strip.clientWidth,
      rights: [...strip.querySelectorAll('button')].map((button) => button.getBoundingClientRect().right),
    }))
    assert(selects && selects.x + selects.width <= 568, 'Filters overflow the small phone')
    assert(back && back.width >= 44 && back.height >= 44, 'Back ribbon touch target is too small')
    assert(await page.locator('.stats__table-scroll').evaluate((table) => table.scrollWidth <= table.clientWidth), 'Archetype table overflows the small phone')
    assert(await page.locator('.stats__row-button strong').evaluateAll((names) => names.length > 0 && names.every((name) => name.scrollHeight <= name.clientHeight + 1)), 'Archetype names are truncated on the small phone')
    assert(!heroes.scrolls && heroes.rights.length === 9 && heroes.rights.every((right) => right <= selects.x), `Hero buttons hidden on small phone: ${heroes.rights}`)
  })
  await page.setViewportSize({ width: 844, height: 390 })
  await page.locator('.stats__scroll').evaluate((element) => { element.scrollTop = element.scrollHeight })
  await page.screenshot({ path: join(output, 'stats-next-card-phone.png') })
  await checkAsync('next-card comparison remains reachable on a horizontal phone', async () => {
    assert(await page.getByRole('region', { name: 'Next card comparison' }).isVisible())
  })
  await page.getByRole('button', { name: /Coolheaded/ }).click()
  await checkAsync('choosing a next-card delta adds an any-upgrade required card', async () => {
    assert(await page.getByRole('button', { name: /Remove Coolheaded \(any upgrade\) from All of these/ }).isVisible())
    await page.locator('.stats__metric').first().locator('strong').getByText('2', { exact: true }).waitFor()
  })
  await page.getByRole('button', { name: 'Expression' }).click()
  await page.getByLabel('Card expression').fill('Dual Cast or Dual Cast+')
  await page.getByRole('button', { name: 'Apply' }).click()
  await page.locator('.stats__metric').first().locator('strong').getByText('4', { exact: true }).waitFor()
  await page.locator('.stats__next').scrollIntoViewIfNeeded()
  await page.getByRole('button', { name: /Coolheaded/ }).click()
  await checkAsync('next-card deltas preserve and refine a complex expression, even when reapplied', async () => {
    await page.locator('.stats__metric').first().locator('strong').getByText('2', { exact: true }).waitFor()
    assert(await page.getByRole('button', { name: 'Expression' }).getAttribute('aria-pressed') === 'true')
    assert((await page.getByLabel('Card expression').inputValue()).includes('@coolheaded'))
    await page.getByRole('button', { name: 'Apply' }).click()
    await page.locator('.stats__metric').first().locator('strong').getByText('2', { exact: true }).waitFor()
  })

  const pending = { ...server.store.leaderboardRuns[0], id: 'browser-1234:stats-pending', deckType: undefined }
  server.store.leaderboardRuns.push(pending)
  const pendingPage = await context.newPage()
  pendingPage.on('pageerror', (reason) => errors.push(String(reason)))
  await pendingPage.goto(`http://127.0.0.1:${viteAddress.port}`, { waitUntil: 'networkidle' })
  await pendingPage.getByRole('button', { name: 'Stats', exact: true }).click()
  await pendingPage.getByRole('button', { name: /Refresh 1 pending/ }).waitFor()
  await checkAsync('pending refresh uses the gold action colour', async () => {
    assertEqual(await pendingPage.getByRole('button', { name: /Refresh 1 pending/ }).evaluate((button) => getComputedStyle(button).color), 'rgb(241, 202, 133)')
  })
  pending.deckType = 'Defect Lightning Orb Focus'
  await pendingPage.getByRole('button', { name: /Refresh 1 pending/ }).click()
  await checkAsync('pending classifications can be refreshed without changing filters', async () => {
    await pendingPage.locator('.stats__metric').first().locator('strong').getByText('7', { exact: true }).waitFor()
    await pendingPage.getByRole('button', { name: /Refresh 1 pending/ }).waitFor({ state: 'hidden' })
    assert((await pendingPage.getByRole('button', { name: /Defect Lightning Orb Focus/ }).innerText()).includes('4 runs'))
  })
  pending.deckType = undefined
  await pendingPage.getByRole('button', { name: 'Defect', exact: true }).click()
  await pendingPage.getByRole('button', { name: /Refresh 1 pending/ }).waitFor()
  let failedStatsRequests = 0
  await pendingPage.route('**/api/stats?*', async (route) => {
    if (failedStatsRequests < 2) { failedStatsRequests += 1; await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"temporary outage"}' }) }
    else await route.continue()
  })
  await pendingPage.getByRole('button', { name: /Refresh 1 pending/ }).click()
  await pendingPage.getByRole('alert').waitFor()
  pending.deckType = 'Defect Lightning Orb Focus'
  await checkAsync('a transient stats outage does not stop pending auto-refresh after recovery', async () => {
    await pendingPage.getByRole('button', { name: /Defect Lightning Orb Focus/ }).getByText('4 runs').waitFor({ timeout: 25_000 })
    assertEqual(failedStatsRequests, 2)
  })
  await pendingPage.close()
  await page.getByRole('button', { name: 'Visual builder' }).click()
  await page.getByRole('button', { name: 'Clear filters' }).click()
  await checkAsync('clearing filters hides the clear action', async () => {
    assertEqual(await page.getByRole('button', { name: 'Clear filters' }).count(), 0)
  })
  const cardSearch = page.getByRole('searchbox', { name: 'Find a card for All of these' })
  await cardSearch.fill('Strike')
  const suggestion = page.getByRole('listbox', { name: 'All of these suggestions' }).getByRole('option').first()
  await suggestion.waitFor()
  await cardSearch.press('Tab')
  await checkAsync('keyboard focus remains in card suggestions and Enter chooses a result', async () => {
    assert(await suggestion.isVisible(), `Suggestion disappeared after Tab; focus: ${await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 120))}`)
    assert(await page.evaluate(() => document.activeElement?.getAttribute('role') === 'option'), `Tab focused ${await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 120))}`)
    await page.keyboard.press('Enter')
    assert(await page.getByRole('button', { name: /Remove Strike/ }).count() > 0, 'Enter did not add Strike')
    assert(await cardSearch.evaluate((element) => document.activeElement === element), 'Search focus was not restored')
  })
  server.store.leaderboardRuns[4].finalDeck = [...server.store.leaderboardRuns[4].finalDeck, card('strike_ironclad')]
  await page.getByRole('button', { name: 'Expression' }).click()
  await page.getByLabel('Card expression').fill('')
  await page.getByRole('button', { name: 'Apply' }).click()
  await page.getByRole('button', { name: 'All heroes' }).click()
  await page.getByRole('region', { name: 'Next card comparison' }).getByRole('button', { name: /Strike/ }).click()
  await checkAsync('reapplying a shared-name next-card filter keeps its specific hero card', async () => {
    await page.locator('.stats__metric').first().locator('strong').getByText('2', { exact: true }).waitFor()
    assert((await page.getByLabel('Card expression').inputValue()).includes('@strike_defect'))
    await page.getByRole('button', { name: 'Apply' }).click()
    await page.locator('.stats__metric').first().locator('strong').getByText('2', { exact: true }).waitFor()
  })
  process.env.VITE_HOSTED_SESSION = 'true'
  hostedVite = await createViteServer({ root, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } })
  await hostedVite.listen()
  const hostedAddress = hostedVite.httpServer?.address()
  if (!hostedAddress || typeof hostedAddress === 'string') throw new Error('Hosted Vite did not report a port')
  const hostedPage = await context.newPage()
  hostedPage.on('pageerror', (reason) => errors.push(String(reason)))
  await hostedPage.addInitScript(() => {
    const originalTimeout = window.setTimeout.bind(window)
    window.setTimeout = (callback, delay, ...args) => originalTimeout(callback, delay === 8_000 ? 500 : delay, ...args)
  })
  const slowDiscovery = async (route, body) => {
    await new Promise((resolve) => setTimeout(resolve, 350))
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) })
  }
  await hostedPage.route('**/session.json?*', (route) => slowDiscovery(route, { origin: roomOrigin, protocolVersion: 1 }))
  await hostedPage.route('**/api/health', (route) => slowDiscovery(route, { protocolVersion: 1 }))
  const hostedStats = JSON.stringify(statsSnapshot(server.store.leaderboardRuns))
  let hostedStatsRequests = 0
  await hostedPage.route('**/api/stats?*', async (route) => {
    hostedStatsRequests += 1
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: hostedStats })
  })
  await hostedPage.goto(`http://127.0.0.1:${hostedAddress.port}`, { waitUntil: 'domcontentloaded' })
  await hostedPage.getByRole('button', { name: 'Stats', exact: true }).click({ timeout: 60_000 })
  await checkAsync('slow hosted discovery does not consume the stats request timeout', async () => {
    await hostedPage.getByRole('button', { name: /Defect Lightning Orb Focus/ }).waitFor({ timeout: 4_000 })
    assertEqual(hostedStatsRequests, 1)
    const background = await hostedPage.locator('.stats__body').getAttribute('style')
    assert(background?.includes('assets/menu/compendium-archive.webp'), `Hosted background: ${background}`)
  })
  for (let index = 0; index < 2; index += 1) server.store.leaderboardRuns.push({ ...server.store.leaderboardRuns[0],
    id: `browser-1234:stats-burn-${index}`, finalDeck: [card('burn')] })
  await page.route('**/api/stats?*', async (route) => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify(statsSnapshot(server.store.leaderboardRuns, new URL(route.request().url()).searchParams)) }))
  await page.getByLabel('Card expression').fill('')
  await page.getByRole('button', { name: 'Apply' }).click()
  await page.getByRole('region', { name: 'Next card comparison' }).getByRole('button', { name: /Burn/ }).click()
  await checkAsync('status-card suggestions remain valid when the expression is reapplied', async () => {
    await page.locator('.stats__metric').first().locator('strong').getByText('2', { exact: true }).waitFor()
    assert((await page.getByLabel('Card expression').inputValue()).includes('@burn'))
    await page.getByRole('button', { name: 'Apply' }).click()
    await page.locator('.stats__metric').first().locator('strong').getByText('2', { exact: true }).waitFor()
  })
  server.store.leaderboardRuns[0].finalDeck = [...server.store.leaderboardRuns[0].finalDeck, card('barricade')]
  await page.getByRole('button', { name: 'Visual builder' }).click()
  await page.getByRole('button', { name: 'Clear filters' }).click()
  await page.getByRole('button', { name: 'Defect', exact: true }).click()
  await page.getByRole('searchbox', { name: 'Find a card for All of these' }).fill('Barricade')
  await page.getByRole('listbox', { name: 'All of these suggestions' }).getByRole('option').filter({ hasText: 'Barricade' }).filter({ hasText: 'Ironclad' }).first().click()
  await checkAsync('a Defect run with a cross-hero card is searchable in the visual builder', async () => {
    assert(await page.getByRole('button', { name: /Remove Barricade from All of these/ }).isVisible())
    await page.locator('.stats__metric').first().locator('strong').getByText('1', { exact: true }).waitFor()
  })
  await page.getByRole('button', { name: 'Back to main menu' }).click()
  await checkAsync('the back ribbon returns to the main menu', async () => {
    await page.getByRole('button', { name: 'Stats', exact: true }).waitFor()
    assertEqual(await page.locator('.stats').count(), 0)
  })
  check('page has no uncaught errors', () => assertEqual(errors.length, 0, errors.join('\n')))
  report('stats explorer browser')
} finally {
  await context.close()
  await page.video()?.saveAs(join(output, 'stats-explorer-demo.webm'))
  await browser.close()
  if (hostedVite) await hostedVite.close()
  delete process.env.VITE_HOSTED_SESSION
  await vite.close()
  await server.close()
  const video = join(output, 'stats-explorer-demo.webm')
  if (statSync(video).size === 0) throw new Error('Stats Explorer demo video was empty')
}
