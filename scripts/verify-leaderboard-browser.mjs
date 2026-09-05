#!/usr/bin/env node
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createServer as createViteServer } from 'vite'
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
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
const errors = []
page.on('pageerror', (error) => errors.push(String(error)))
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })

const sample = (overrides) => ({
  id: crypto.randomUUID(), character: 'ironclad', ascension: 3, mode: 'standard', startedAtAct: 1,
  highestBossActDefeated: 3, combatsFinished: 10, damageDealt: 100, damageTaken: 30, damageBlocked: 70,
  damageStatsComplete: true,
  ...overrides,
})
const waitForImages = () => page.waitForFunction(() => [...document.images].every((image) => image.complete && image.naturalWidth > 0))

try {
  suite('leaderboard browser')
  for (const run of [
    sample({}),
    sample({ highestBossActDefeated: 2, combatsFinished: 5, damageDealt: 25, damageTaken: 50, damageBlocked: 0 }),
    sample({ character: 'silent', highestBossActDefeated: 4, combatsFinished: 12, damageDealt: 240, damageTaken: 20, damageBlocked: 80 }),
  ]) {
    const response = await fetch(`${roomOrigin}/api/leaderboard`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(run) })
    assert(response.ok, 'could not seed leaderboard')
  }

  await page.goto(origin, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Leaderboard', exact: true }).click()
  await page.getByRole('heading', { name: 'All heroes' }).waitFor()
  await page.getByRole('row', { name: /Silent Ascension 3/ }).waitFor()
  const firstRow = await page.locator('tbody tr').first().innerText()
  const ironcladRow = await page.getByRole('row', { name: /Ironclad Ascension 3/ }).innerText()
  check('requested metrics are rendered and ranked from the live service', () => {
    assert(firstRow.includes('Silent') && firstRow.includes('100%') && firstRow.includes('20.0') && firstRow.includes('80%') && firstRow.endsWith('1'))
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
  }))
  check('the horizontal-phone composition stays inside the viewport', () => {
    assert(phoneFit.documentWidth <= phoneFit.viewportWidth + 2)
    assert(phoneFit.archiveHeight <= 390)
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
  await page.waitForFunction(() => Boolean(window.__STS_DEBUG__?.getRun()))
  await page.evaluate(() => {
    window.__LEADERBOARD_HOLD__ = true
    window.__LEADERBOARD_FETCH__ = window.fetch
    window.fetch = (input, init) => {
      const submission = init?.body ? JSON.parse(String(init.body)) : null
      if (submission?.ascension === 99) return Promise.resolve(new Response('{"error":"bad row"}', { status: 400 }))
      if (window.__LEADERBOARD_HOLD__ && init?.method === 'POST' && String(input).includes('/api/leaderboard')) {
        return Promise.reject(new TypeError('simulated offline handoff'))
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
    run.players = [run.players[0]]
    run.players[0].damageStats = { attack: 12, poison: 3, special: 0, taken: 4, blocked: 6 }
    window.__STS_DEBUG__.setRun(run)
  })
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('sts-leaderboard-outbox') ?? '[]').length === 1)
  await page.evaluate(() => { window.__LEADERBOARD_HOLD__ = false; window.dispatchEvent(new Event('online')) })
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('sts-leaderboard-outbox') ?? '[]').length === 0)
  await page.waitForTimeout(50)
  check('a bad queued row cannot block a later solo result through a handoff outage', () => {
    assertEqual(rooms.store.leaderboardRuns.length, 4)
    const logged = rooms.store.leaderboardRuns.at(-1)
    assertEqual(logged.character, 'ironclad')
    assertEqual(logged.ascension, 5)
    assertEqual(logged.combatsFinished, 3)
    assertEqual(logged.damageDealt, 15)
    assertEqual(logged.damageBlocked, 6)
  })
  check('the leaderboard surface raised no browser errors', () => assertEqual(errors.length, 0, errors.join('\n')))
} finally {
  await context.close()
  await browser.close()
  await vite.close()
  await rooms.close()
}

report('leaderboard browser')
