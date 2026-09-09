#!/usr/bin/env node
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createServer as createViteServer } from 'vite'
import { createCombat } from '../src/game/combat.ts'
import { createRoomServer } from './room-server.mjs'
import { assert, assertEqual, check, report, suite } from './lib/harness.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = join(root, 'artifacts/leaderboard-browser')
mkdirSync(output, { recursive: true })
process.env.VITE_LEADERBOARD = 'true'
const rooms = createRoomServer()
const roomAddress = await rooms.listen(0)
const roomOrigin = `http://127.0.0.1:${roomAddress.port}`
const vite = await createViteServer({ root, logLevel: 'silent', server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: roomOrigin } } } })
await vite.listen()
const viteAddress = vite.httpServer?.address()
if (!viteAddress || typeof viteAddress === 'string') throw new Error('Vite did not report a port')
const origin = `http://127.0.0.1:${viteAddress.port}`
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, hasTouch: true })
const page = await context.newPage()
const errors = []
page.on('pageerror', (error) => errors.push(String(error)))
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })

const sample = (overrides) => ({
  id: crypto.randomUUID(), character: 'ironclad', ascension: 3, mode: 'standard', startedAtAct: 1,
  highestBossActDefeated: 3, combatsFinished: 10, damageDealt: 100, damageTaken: 30, damageBlocked: 70,
  damageStatsComplete: true, floorsCleared: 20,
  ...overrides,
})
const waitForImages = () => page.waitForFunction(() => [...document.images].every((image) => image.complete && image.naturalWidth > 0))

try {
  suite('leaderboard browser')
  for (const run of [
    sample({}),
    sample({ highestBossActDefeated: 2, combatsFinished: 5, damageDealt: 25, damageTaken: 50, damageBlocked: 0 }),
    sample({ character: 'silent', highestBossActDefeated: 4, combatsFinished: 12, damageDealt: 240, damageTaken: 20, damageBlocked: 80, floorsCleared: 27 }),
  ]) {
    const response = await fetch(`${roomOrigin}/api/leaderboard`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(run) })
    assert(response.ok, 'could not seed leaderboard')
  }

  let legacySnapshot = true
  await page.route('**/api/leaderboard', async (route) => {
    if (route.request().method() !== 'GET' || !legacySnapshot) return route.continue()
    const response = await route.fetch()
    const snapshot = await response.json()
    for (const row of snapshot.rows) delete row.averageFloorsCleared
    return route.fulfill({ response, body: JSON.stringify(snapshot), contentType: 'application/json' })
  })

  await page.goto(origin, { waitUntil: 'networkidle' })
  await waitForImages()
  await page.screenshot({ path: join(output, 'wallpaper-desktop.png'), fullPage: true })
  assertEqual(await page.locator('#welcome-name').count(), 0)
  await page.keyboard.press('a')
  await page.getByLabel('How should we call you?').waitFor()
  await page.waitForTimeout(500)
  await page.screenshot({ path: join(output, 'welcome-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 844, height: 390 })
  await page.reload({ waitUntil: 'networkidle' })
  await page.screenshot({ path: join(output, 'wallpaper-horizontal-phone.png'), fullPage: true })
  await page.getByRole('button', { name: 'Tap, click, or press any key to start' }).tap()
  await page.getByLabel('How should we call you?').waitFor()
  await page.waitForTimeout(500)
  await page.screenshot({ path: join(output, 'welcome-horizontal-phone.png'), fullPage: true })
  const welcomeFit = await page.getByRole('button', { name: 'Confirm username' }).boundingBox()
  check('the welcome confirmation fits a horizontal phone', () => {
    assert(welcomeFit && welcomeFit.y >= 0 && welcomeFit.y + welcomeFit.height <= 390)
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByLabel('How should we call you?').fill('ArchiveTester')
  await page.getByRole('button', { name: 'Confirm username' }).click()
  await page.getByRole('button', { name: 'Single Player', exact: true }).waitFor()
  await page.reload({ waitUntil: 'networkidle' })
  check('a returning machine skips the welcome page', () => assertEqual(rooms.store.profiles.length, 1))
  await page.getByRole('button', { name: 'Leaderboard', exact: true }).click()
  await page.getByRole('heading', { name: 'All heroes' }).waitFor()
  await page.getByRole('row', { name: /Silent Ascension 3/ }).waitFor()
  const legacyRow = await page.getByRole('row', { name: /Silent Ascension 3/ }).innerText()
  check('the new client renders an old-server snapshot throughout a rolling handoff', () => {
    assert(legacyRow.includes('—'), legacyRow)
  })
  legacySnapshot = false
  await page.getByRole('button', { name: 'Back to main menu' }).click()
  await page.getByRole('button', { name: 'Leaderboard', exact: true }).click()
  await page.getByRole('row', { name: /Silent Ascension 3/ }).waitFor()
  const firstRow = await page.locator('tbody tr').first().innerText()
  const ironcladRow = await page.getByRole('row', { name: /Ironclad Ascension 3/ }).innerText()
  check('requested metrics are rendered and ranked from the live service', () => {
    assert(firstRow.includes('Silent') && firstRow.includes('100%') && firstRow.includes('27.0') && firstRow.includes('20.0') && firstRow.includes('80%') && firstRow.endsWith('1'))
    assert(ironcladRow.includes('50%') && ironcladRow.includes('1 / 2') && ironcladRow.includes('8.3') && ironcladRow.includes('47%'))
  })
  await waitForImages()
  await page.screenshot({ path: join(output, 'leaderboard-desktop.png'), fullPage: true })

  await page.getByRole('button', { name: 'Ironclad', exact: true }).click()
  const filteredRows = await page.locator('tbody tr').count()
  const filteredText = await page.locator('tbody tr').first().innerText()
  check('character filters expose only their own ascension records', () => {
    assertEqual(filteredRows, 1)
    assert(filteredText.includes('Ironclad'))
  })
  await page.getByLabel('Ascension').selectOption('2')
  const missingAscensionRows = await page.locator('tbody tr').count()
  check('character and ascension filters compose without stale rows', () => {
    assertEqual(missingAscensionRows, 0)
  })
  await page.getByText('No names are etched here yet.').waitFor()
  await page.getByLabel('Ascension').selectOption('all')

  await page.setViewportSize({ width: 844, height: 390 })
  await page.getByRole('button', { name: 'All heroes' }).click()
  await waitForImages()
  await page.screenshot({ path: join(output, 'leaderboard-horizontal-phone.png'), fullPage: true })
  const phoneFit = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: innerWidth,
    archiveHeight: document.querySelector('.leaderboard__archive')?.getBoundingClientRect().height,
    tableWidth: document.querySelector('.leaderboard__table-wrap')?.scrollWidth,
    tableViewport: document.querySelector('.leaderboard__table-wrap')?.clientWidth,
  }))
  check('the horizontal-phone composition stays inside the viewport', () => {
    assert(phoneFit.documentWidth <= phoneFit.viewportWidth + 2)
    assert(phoneFit.archiveHeight <= 390)
    assert(phoneFit.tableWidth <= phoneFit.tableViewport + 2)
  })

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByRole('button', { name: 'Back to main menu' }).click()
  await page.setViewportSize({ width: 844, height: 390 })
  const menuLeaderboard = await page.getByRole('button', { name: 'Leaderboard', exact: true }).boundingBox()
  check('the new main-menu action remains reachable on a horizontal phone', () => {
    assert(menuLeaderboard && menuLeaderboard.y >= 0 && menuLeaderboard.y + menuLeaderboard.height <= 390)
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByRole('button', { name: 'Single Player', exact: true }).click()
  await page.getByRole('button', { name: 'Standard', exact: true }).click()
  await page.getByRole('button', { name: 'Embark' }).click()
  await page.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
  await page.waitForFunction(() => Boolean(window.__STS_DEBUG__?.getRun()))
  await page.getByRole('heading', { name: 'ArchiveTester the Ironclad' }).waitFor()
  const combatRun = await page.evaluate(() => structuredClone(window.__STS_DEBUG__.getRun()))
  combatRun.neow = null
  combatRun.phase = 'combat'
  combatRun.combat = createCombat({ seed: 911, calls: 0 }, combatRun.players, [{
    uid: 'e0', defId: 'jaw_worm', row: 0, isBoss: false, hp: 40, maxHp: 40,
    block: 0, strength: 0, vulnerable: 0, weak: 0, poison: 0, goldReward: 0, cardReward: null,
    actionIndex: 0, abilityUsed: false, dead: false,
  }], 'profile-title')
  await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), combatRun)
  await page.locator('.combat').waitFor()
  await waitForImages()
  await page.screenshot({ path: join(output, 'username-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 844, height: 390 })
  await page.screenshot({ path: join(output, 'username-horizontal-phone.png'), fullPage: true })
  const titleFit = await page.locator('.player-title').boundingBox()
  check('username and character remain visible on a horizontal phone', () => {
    assert(titleFit && titleFit.width > 20 && titleFit.height > 10 && titleFit.x >= 0 && titleFit.x + titleFit.width <= 844)
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  const enrichedOutbox = await page.evaluate(async () => {
    const run = structuredClone(window.__STS_DEBUG__.getRun())
    run.phase = 'defeat'
    run.campaign.finalized = true
    run.floorsCleared = 4
    localStorage.setItem('sts-leaderboard-installation', 'browser-1234')
    localStorage.setItem('sts-leaderboard-outbox', JSON.stringify([{
      id: `browser-1234:${run.campaign.runId}:${run.seed}`, character: run.players[0].character,
      ascension: run.ascension, mode: run.meta.mode, damageStatsComplete: true, startedAtAct: 1,
      highestBossActDefeated: 0, combatsFinished: 0, damageDealt: 777, damageTaken: 0, damageBlocked: 0,
    }]))
    const { queueFinishedSoloRun } = await import('/src/leaderboard.ts')
    queueFinishedSoloRun(run)
    return JSON.parse(localStorage.getItem('sts-leaderboard-outbox') ?? '[]')
  })
  check('a queued legacy result gains its known floor count without duplicating or replacing prior stats', () => {
    assertEqual(enrichedOutbox.length, 1)
    assertEqual(enrichedOutbox[0].floorsCleared, 4)
    assertEqual(enrichedOutbox[0].damageDealt, 777)
  })
  await page.evaluate(() => {
    window.__LEADERBOARD_LEGACY__ = true
    window.__LEADERBOARD_FETCH__ = window.fetch
    window.fetch = (input, init) => {
      const submission = init?.body ? JSON.parse(String(init.body)) : null
      if (submission?.ascension === 99) return Promise.resolve(new Response('{"error":"bad row"}', { status: 400 }))
      if (window.__LEADERBOARD_LEGACY__ && submission?.floorsCleared !== undefined && init?.method === 'POST' && String(input).includes('/api/leaderboard')) {
        return Promise.resolve(new Response('{"ok":true,"added":true}', { status: 201 }))
      }
      return window.__LEADERBOARD_FETCH__(input, init)
    }
    localStorage.setItem('sts-leaderboard-outbox', JSON.stringify([{
      id: 'browser-1234:permanently-invalid', character: 'ironclad', ascension: 99, mode: 'standard',
      damageStatsComplete: true, startedAtAct: 1, highestBossActDefeated: 0, combatsFinished: 0,
      damageDealt: 0, damageTaken: 0, damageBlocked: 0,
    }]))
  })
  await page.evaluate(() => {
    const run = structuredClone(window.__STS_DEBUG__.getRun())
    run.phase = 'defeat'
    run.campaign.finalized = true
    run.ascension = 5
    run.combatsFinished = 3
    run.floorsCleared = 4
    run.players = [run.players[0]]
    run.players[0].damageStats = { attack: 12, poison: 3, special: 0, taken: 4, blocked: 6 }
    window.__STS_DEBUG__.setRun(run)
  })
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('sts-leaderboard-outbox') ?? '[]').length === 1)
  const queuedAcrossHandoff = await page.evaluate(() => JSON.parse(localStorage.getItem('sts-leaderboard-outbox') ?? '[]'))
  check('an old server acknowledgment keeps floor telemetry queued until the new server takes over', () => {
    assertEqual(queuedAcrossHandoff[0].floorsCleared, 4)
  })
  await page.evaluate(() => { window.__LEADERBOARD_LEGACY__ = false; window.dispatchEvent(new Event('online')) })
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('sts-leaderboard-outbox') ?? '[]').length === 0)
  await page.waitForTimeout(50)
  check('a bad queued row cannot block a later solo result through a rolling handoff', () => {
    assertEqual(rooms.store.leaderboardRuns.length, 4)
    const logged = rooms.store.leaderboardRuns.at(-1)
    assertEqual(logged.character, 'ironclad')
    assertEqual(logged.ascension, 5)
    assertEqual(logged.combatsFinished, 3)
    assertEqual(logged.damageDealt, 15)
    assertEqual(logged.damageBlocked, 6)
    assertEqual(logged.floorsCleared, 4)
  })
  const winningDeck = await page.evaluate(async () => {
    const run = structuredClone(window.__STS_DEBUG__.getRun())
    run.campaign.runId = 'winning-deck-check'
    run.campaign.highestBossActDefeated = 3
    run.campaign.finalized = true
    run.phase = 'defeat' // Dying in optional Act IV still preserves an Act III clear.
    run.players[0].deck[0].upgraded = true
    const { queueFinishedSoloRun, flushLeaderboardOutbox } = await import('/src/leaderboard.ts')
    queueFinishedSoloRun(run)
    await flushLeaderboardOutbox(true)
    return run.players[0].deck.map(({ defId, upgraded }) => ({ defId, upgraded }))
  })
  check('an Act III clear uploads the final deck even after an Act IV defeat', () => {
    const saved = rooms.store.leaderboardRuns.at(-1)
    assertEqual(saved.username, 'ArchiveTester')
    assertEqual(JSON.stringify(saved.finalDeck), JSON.stringify(winningDeck))
    assertEqual(rooms.store.leaderboardRuns.at(-2).finalDeck, undefined)
  })
  check('the leaderboard surface raised no browser errors', () => assertEqual(errors.length, 0, errors.join('\n')))
} finally {
  await context.close()
  await browser.close()
  await vite.close()
  await rooms.close()
}

report('leaderboard browser')
