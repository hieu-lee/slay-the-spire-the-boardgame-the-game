import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { suite, check, assert, assertEqual, report } from './lib/harness.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = join(repoRoot, 'artifacts/tiny-house-browser')
mkdirSync(output, { recursive: true })
const server = await createServer({ root: repoRoot, logLevel: 'silent', server: { port: 0 } })
await server.listen()
const address = server.httpServer?.address()
if (!address || typeof address === 'string') throw new Error('vite did not report a port')

suite('Tiny House browser')
const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
page.on('pageerror', (error) => errors.push(String(error)))

await page.goto(`http://localhost:${address.port}`, { waitUntil: 'networkidle' })
await page.getByRole('button', { name: 'Single Player', exact: true }).click()
await page.getByRole('button', { name: 'Standard', exact: true }).click()
await page.getByRole('button', { name: 'Embark' }).click()
await page.waitForFunction(() => window.__STS_DEBUG__?.getRun().phase === 'neow')
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const player = run.players[0]
  player.potions = []
  player.relics = player.relics.map((relic) => ({ ...relic, pending: false }))
  run.phase = 'reward'
  run.neow = null
  run.roomState = null
  run.rewardDestination = 'map'
  run.rewards = [{ playerId: player.id, cardReward: false, choices: null, upgraded: false,
    potion: false, bossRelics: ['tiny_house'] }]
  debug.setRun(run)
})
await page.getByRole('button', { name: 'Tiny House', exact: true }).click()
await page.getByRole('heading', { name: 'Tiny House', exact: true }).waitFor()

const loot = await page.locator('.reward-screen--loot').evaluate((screen) => ({
  rows: [...screen.querySelectorAll('.loot-choice')].map((row) => row.textContent?.trim()),
  goldStatic: screen.querySelector('.loot-choice--static')?.textContent?.trim(),
  deckCards: screen.querySelectorAll('.campfire__deck .card, .card-picker__grid .card').length,
  overflow: screen.scrollWidth > screen.clientWidth + 1,
}))
check('Tiny House first reuses the compact Loot panel', () => {
  assertEqual(loot.rows.length, 3)
  assertEqual(loot.goldStatic, '3 Gold')
  assert(loot.rows.some((row) => row === 'Add a card to your deck.'))
  assertEqual(loot.deckCards, 0)
  assertEqual(loot.overflow, false)
})
const tinyHousePotion = page.locator('.reward-screen--loot .potion-chip > button.loot-choice')
await tinyHousePotion.hover()
const tinyHousePotionTip = page.locator('.potion-tip')
await tinyHousePotionTip.waitFor()
const tinyHousePotionText = await tinyHousePotionTip.locator('.relic-tip__text').innerText()
check('Tiny House Potion hover shows its effect details', () => {
  assert(tinyHousePotionText.trim().length > 0)
})
await page.waitForTimeout(250)
await page.screenshot({ path: join(output, 'tiny-house-loot-desktop.png'), fullPage: true })
await page.setViewportSize({ width: 844, height: 390 })
const phoneLoot = await page.locator('.reward-screen--loot').evaluate((screen) => ({
  right: screen.getBoundingClientRect().right,
  viewport: innerWidth,
  documentOverflow: document.documentElement.scrollWidth > innerWidth + 1,
}))
check('Tiny House Loot stays usable on a horizontal phone', () => {
  assert(phoneLoot.right <= phoneLoot.viewport + 1)
  assertEqual(phoneLoot.documentOverflow, false)
})
await page.screenshot({ path: join(output, 'tiny-house-loot-horizontal-phone.png'), fullPage: true })
await page.setViewportSize({ width: 1440, height: 900 })

await page.getByRole('button', { name: 'Add a card to your deck.' }).click()
const claimedCardName = await page.locator('.reward-screen--card-choice .card').first().getAttribute('title')
await page.locator('.reward-screen--card-choice .card').first().click()
await page.getByRole('heading', { name: 'Tiny House', exact: true }).waitFor()
await page.locator('button.loot-choice').click()
const picker = page.getByRole('dialog', { name: 'Choose a card to upgrade' })
await picker.waitFor()
const initialPicker = {
  cards: await picker.locator('.card-picker__grid .card').count(),
  back: await picker.getByRole('button', { name: 'Back' }).count(),
  claimedCardName: await picker.locator('.card-picker__grid .card').first().getAttribute('title'),
}
check('Tiny House then reuses the shared Upgrade picker', () => {
  assert(initialPicker.cards > 0)
  assertEqual(initialPicker.back, 0)
  assertEqual(initialPicker.claimedCardName, claimedCardName,
    'the card claimed from Tiny House was missing from its Upgrade picker')
})
await page.screenshot({ path: join(output, 'tiny-house-upgrade-desktop.png'), fullPage: true })

await page.setViewportSize({ width: 844, height: 390 })
await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
const phoneLayout = await picker.evaluate((screen) => ({
  left: screen.getBoundingClientRect().left,
  right: screen.getBoundingClientRect().right,
  viewport: innerWidth,
  documentOverflow: document.documentElement.scrollWidth > innerWidth + 1,
}))
check('Tiny House Upgrade stays usable on a horizontal phone', () => {
  assert(phoneLayout.left >= -1 && phoneLayout.right <= phoneLayout.viewport + 1)
  assertEqual(phoneLayout.documentOverflow, false)
})
await page.screenshot({ path: join(output, 'tiny-house-upgrade-horizontal-phone.png'), fullPage: true })

await picker.locator('.card-picker__grid .card').first().click()
await picker.locator('.card-picker__preview').waitFor()
const preview = {
  cards: await picker.locator('.card-picker__preview .card').count(),
  back: await picker.getByRole('button', { name: 'Back' }).count(),
}
check('the shared Upgrade preview compares before and after', () => {
  assertEqual(preview.cards, 2)
  assertEqual(preview.back, 1)
})
await picker.getByRole('button', { name: 'Confirm Tiny House' }).click()
await page.waitForFunction(() => !window.__STS_DEBUG__.getRun().players.some((player) =>
  player.relics.some((relic) => relic.pending)))
const resolved = {
  heading: await page.getByRole('heading', { name: 'Tiny House', exact: true }).count(),
  phase: await page.evaluate(() => window.__STS_DEBUG__.getRun().phase),
}
check('Tiny House resolves only after the upgrade', () => {
  assertEqual(resolved.heading, 0)
  assertEqual(resolved.phase, 'map')
})

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const player = run.players[0]
  player.deck = player.deck.map((card) => ({ ...card, upgraded: true }))
  player.potions = []
  player.relics = player.relics.filter((relic) => relic.defId !== 'tiny_house' && !relic.pending)
  run.phase = 'reward'
  run.rewardDestination = 'map'
  run.rewards = [{ playerId: player.id, cardReward: false, choices: null, upgraded: false,
    potion: false, bossRelics: ['tiny_house'] }]
  debug.setRun(run)
})
await page.getByRole('button', { name: 'Tiny House', exact: true }).click()
await page.getByRole('button', { name: 'Skip', exact: true }).click()
await page.getByText('No eligible cards.', { exact: true }).waitFor()
await page.getByRole('button', { name: 'Confirm Tiny House' }).click()
await page.waitForFunction(() => !window.__STS_DEBUG__.getRun().players.some((player) =>
  player.relics.some((relic) => relic.pending)))
const emptyResolution = {
  picker: await page.getByText('No eligible cards.', { exact: true }).count(),
  phase: await page.evaluate(() => window.__STS_DEBUG__.getRun().phase),
}
check('Skip settles Tiny House Loot and an empty Upgrade step can finish', () => {
  assertEqual(emptyResolution.picker, 0)
  assertEqual(emptyResolution.phase, 'map')
})
check('Tiny House fixtures reported no browser errors', () => assertEqual(errors.length, 0, errors.join('\n')))

await browser.close()
await server.close()
report('Tiny House browser')
