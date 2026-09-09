import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from './lib/profile-browser.mjs'
import { createServer } from 'vite'
import { createRoomServer } from './room-server.mjs'
import { createCombat } from '../src/game/combat.ts'
import { normalizeLeaderboardRun } from './lib/leaderboard.mjs'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'artifacts/winning-decks-browser')
mkdirSync(output, { recursive: true })
const rooms = createRoomServer()
rooms.store.leaderboardRuns = Array.from({ length: 45 }, (_, index) => normalizeLeaderboardRun({
  id: `archive-browser-${index}`, character: index % 2 ? 'silent' : 'ironclad', ascension: index % 14,
  username: index === 44 ? 'A very long player name' : `Player${String(index).padStart(2, '0')}`,
  mode: 'standard', startedAtAct: 1, highestBossActDefeated: 3, combatsFinished: 1, damageDealt: 1, damageTaken: 1, damageBlocked: 1,
  finalDeck: Array.from({ length: 10 + index % 7 }, (_, card) => ({ defId: card % 2 ? 'defend_ironclad' : 'strike_ironclad', upgraded: card === 0 })),
}, 1700000000000 + index * 1000))
const { port } = await rooms.listen(0)
const vite = await createServer({ root, logLevel: 'silent', server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: `http://127.0.0.1:${port}` } } } })
await vite.listen()
const origin = `http://127.0.0.1:${vite.httpServer.address().port}`
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', e => errors.push(String(e)))
const requests = []
page.on('request', request => { if (request.url().includes('/api/leaderboard/decks')) requests.push(request.url()) })
const rows = page.locator('.winning-decks tbody tr')
const screenshot = async name => {
  await page.waitForFunction(() => [...document.images].every(image => image.complete && image.naturalWidth > 0))
  await page.screenshot({ path: resolve(output, name + '.png') })
}
try {
  await page.goto(origin)
  await page.getByRole('button', { name: 'Leaderboard', exact: true }).click()
  await page.locator('tbody tr').first().waitFor()
  assert.equal(requests.length, 0, 'decks fetched before opening tab')
  await page.getByRole('button', { name: 'Winning decks', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.winning-decks tbody tr').length === 20)
  assert.equal(requests.length, 1)
  assert.match(await rows.first().innerText(), /A very long player name/)
  await screenshot('decks-desktop')
  await rows.first().locator('td').last().click()
  const dialog = page.getByRole('dialog')
  await dialog.waitFor()
  assert.equal(await dialog.locator('.card').count(), 12)
  await dialog.getByRole('button', { name: 'A - Z' }).click()
  await dialog.getByRole('checkbox').check()
  await screenshot('deck-desktop')
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })
  await page.waitForFunction(() => document.querySelector('.winning-decks__open') === document.activeElement)
  await page.getByRole('button', { name: 'Load 20 more', exact: true }).scrollIntoViewIfNeeded()
  await page.waitForFunction(() => document.querySelectorAll('.winning-decks tbody tr').length === 40)
  await page.getByRole('button', { name: 'Load 20 more', exact: true }).scrollIntoViewIfNeeded()
  await page.waitForFunction(() => document.querySelectorAll('.winning-decks tbody tr').length === 45)
  assert.equal(requests.length, 3)
  for (const [label, key] of [['Character', 'character'], ['Ascension', 'ascension'], ['Card count', 'cardCount'], ['Username', 'username'], ['Won at', 'recordedAt']]) {
    await page.getByRole('columnheader').getByRole('button', { name: label }).focus()
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => document.querySelectorAll('.winning-decks tbody tr').length === 20)
    const firstDirection = label === 'Won at' ? 'descending' : 'ascending'
    assert.equal(await page.getByRole('columnheader').filter({ hasText: label }).getAttribute('aria-sort'), firstDirection)
    assert(new URL(requests.at(-1)).searchParams.get('sort') === key)
    await page.waitForFunction(key => document.activeElement?.getAttribute('data-sort') === key, key)
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => document.querySelectorAll('.winning-decks tbody tr').length === 20)
    assert.equal(await page.getByRole('columnheader').filter({ hasText: label }).getAttribute('aria-sort'), firstDirection === 'ascending' ? 'descending' : 'ascending')
  }
  await page.getByRole('button', { name: 'Silent', exact: true }).click()
  await page.getByLabel('Ascension').selectOption('3')
  await page.waitForFunction(() => document.querySelectorAll('.winning-decks tbody tr').length === 3)
  assert((await rows.allTextContents()).every(text => text.includes('Silent')))
  await page.getByLabel('Ascension').selectOption('2')
  await page.getByText('No winning decks yet.').waitFor()
  await page.getByRole('button', { name: 'All heroes', exact: true }).click()
  await page.getByLabel('Ascension').selectOption('all')
  await page.waitForFunction(() => document.querySelectorAll('.winning-decks tbody tr').length === 20)
  await page.setViewportSize({ width: 844, height: 390 })
  await screenshot('decks-horizontal-phone')
  const fit = await page.locator('.winning-decks__scroll').evaluate(e => ({ width: e.clientWidth, scroll: e.scrollWidth, bottom: e.getBoundingClientRect().bottom, viewport: innerHeight }))
  assert(fit.scroll <= fit.width + 1, JSON.stringify(fit))
  assert(fit.bottom <= fit.viewport, JSON.stringify(fit))
  await rows.first().getByRole('button').focus()
  await page.keyboard.press('Enter')
  await dialog.waitFor()
  await screenshot('deck-horizontal-phone')
  const close = await dialog.getByRole('button', { name: 'Back', exact: true }).boundingBox()
  assert(close.y >= 0 && close.y + close.height <= 390)
  await dialog.getByRole('button', { name: 'Back', exact: true }).click()
  await page.getByRole('button', { name: 'Win rates', exact: true }).click()
  await page.locator('tbody tr').first().waitFor()
  assert.equal(await page.locator('.winning-decks').count(), 0)
  // An old runner must display a recoverable error during a rolling deployment.
  await page.route('**/api/leaderboard/decks?**', route => route.fulfill({ status: 404, body: '{}' }))
  await page.getByRole('button', { name: 'Winning decks', exact: true }).click()
  await page.getByRole('alert').waitFor()
  assert.match(await page.getByRole('alert').innerText(), /server updates/)
  await page.unroute('**/api/leaderboard/decks?**')
  await page.getByRole('button', { name: 'Try again', exact: true }).click()
  await rows.first().waitFor()
  for (const field of ['defId', 'attachedGemId']) {
    await page.getByRole('button', { name: 'Win rates', exact: true }).click()
    const original = rooms.store.leaderboardRuns[44].finalDeck[0]
    rooms.store.leaderboardRuns[44].finalDeck[0] = { ...original, [field]: 'unavailable_card' }
    await page.getByRole('button', { name: 'Winning decks', exact: true }).click()
    await rows.first().getByRole('button').click()
    await page.getByRole('alert').waitFor()
    assert.match(await page.getByRole('alert').innerText(), /cards unavailable/)
    assert.equal(await page.locator('dialog[open]').count(), 0)
    await page.getByRole('button', { name: 'Dismiss', exact: true }).click()
    rooms.store.leaderboardRuns[44].finalDeck[0] = original
  }
  await page.getByRole('button', { name: 'Back to main menu' }).click()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByRole('button', { name: 'Single Player', exact: true }).click()
  await page.getByRole('button', { name: 'Standard', exact: true }).click()
  await page.getByRole('button', { name: 'Embark' }).click()
  await page.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
  await page.waitForFunction(() => Boolean(window.__STS_DEBUG__?.getRun()))
  const run = await page.evaluate(() => structuredClone(window.__STS_DEBUG__.getRun()))
  run.neow = null
  run.phase = 'combat'
  run.combat = createCombat({ seed: 911, calls: 0 }, run.players, [{
    uid: 'e0', defId: 'jaw_worm', row: 0, isBoss: false, hp: 40, maxHp: 40,
    block: 0, strength: 0, vulnerable: 0, weak: 0, poison: 0, goldReward: 0, cardReward: null,
    actionIndex: 0, abilityUsed: false, dead: false,
  }], 'viewer-test')
  run.combat.players[0].discard = [{ uid: 'discard-view', defId: 'strike_ironclad', upgraded: true }]
  run.combat.players[0].exhaust = [{ uid: 'exhaust-view', defId: 'defend_ironclad', upgraded: false }]
  await page.evaluate(run => window.__STS_DEBUG__.setRun(run), run)
  await page.locator('.combat').waitFor()
  for (const [width, height, screen] of [[1440, 900, 'desktop'], [844, 390, 'horizontal-phone']]) {
    await page.setViewportSize({ width, height })
    for (const label of ['Current deck', 'Discard pile', 'Exhaust pile']) {
      const trigger = page.getByRole('button', { name: new RegExp(`^${label},`) })
      await trigger.click()
      const viewer = page.getByRole('dialog', { name: label, exact: true })
      const back = viewer.getByRole('button', { name: 'Back', exact: true })
      assert(await back.evaluate(e => e.classList.contains('ribbon-back')))
      assert.equal(await viewer.getByRole('button', { name: 'Close', exact: true }).count(), 0)
      const box = await back.boundingBox()
      assert(box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height)
      await screenshot(`${label.replaceAll(' ', '-').toLowerCase()}-${screen}`)
      await back.click()
      await viewer.waitFor({ state: 'hidden' })
      assert(await trigger.evaluate(e => e === document.activeElement))
    }
  }
  assert.deepEqual(errors, [])
  console.log('Winning decks browser: lazy pages, every sort direction, filters, deck viewer, keyboard focus, desktop/landscape layouts and retry pass')
} finally { await browser.close(); await vite.close(); await rooms.close() }
