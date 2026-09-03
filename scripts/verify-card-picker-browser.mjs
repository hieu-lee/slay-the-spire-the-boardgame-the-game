import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const server = await createServer({ root, logLevel: 'silent', server: { port: 0 } })
const browser = await chromium.launch({ headless: true })

try {
  await server.listen()
  const address = server.httpServer?.address()
  if (!address || typeof address === 'string') throw new Error('Vite did not report a port')
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.setDefaultTimeout(15_000)
  await page.goto(`http://localhost:${address.port}`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'Single Player', exact: true }).click()
  await page.getByRole('button', { name: 'Standard', exact: true }).click()
  await page.getByRole('button', { name: 'Embark' }).click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'neow')
  await page.evaluate(() => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    const playerId = run.players[0].id
    run.neow.players[playerId] = {
      ...run.neow.players[playerId], redGoldPending: false, redRewardPending: false,
      pendingEffect: { kind: 'upgrade', count: 2, starter: 'strike' },
    }
    debug.setRun(run)
  })
  const neowPicker = page.locator('.card-picker')
  await neowPicker.waitFor()
  assert.equal(await neowPicker.getAttribute('aria-label'), 'Choose 2 cards to upgrade')
  assert((await neowPicker.locator('.card-picker__grid > .card').allTextContents()).every((text) => text.includes('Strike')))
  const neowConfirm = neowPicker.getByRole('button', { name: 'Confirm reward' })
  assert(await neowConfirm.isDisabled())
  await neowPicker.locator('.card-picker__grid > .card').nth(0).click()
  assert(await neowConfirm.isDisabled())
  await neowPicker.locator('.card-picker__grid > .card').nth(1).click()
  assert(!await neowConfirm.isDisabled())
  assert.equal(await neowPicker.locator('.card-picker__grid > .card').nth(2).getAttribute('tabindex'), '-1')
  await page.evaluate(() => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.players[0].relics.push({ defId: 'astrolabe', spent: false, pending: true })
    debug.setRun(run)
  })
  assert(await neowConfirm.isDisabled())
  assert(await neowPicker.getByRole('button', { name: 'Skip reward' }).isDisabled())
  assert(await neowPicker.locator('.card-picker__grid > .card').first().getAttribute('aria-disabled') === 'true')
  await page.evaluate(() => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.players[0].relics = run.players[0].relics.filter((relic) => !relic.pending)
    run.neow.players[run.players[0].id].pendingEffect = { kind: 'upgrade', count: 1 }
    debug.setRun(run)
  })
  await page.setViewportSize({ width: 568, height: 320 })
  await neowPicker.locator('.card-picker__grid > .card').first().click()
  await neowPicker.locator('.card-picker__preview').waitFor()
  const neowPhone = await neowPicker.evaluate((element) => {
    const grid = element.querySelector('.card-picker__grid')
    if (grid) grid.scrollTop = grid.scrollHeight
    const picker = element.getBoundingClientRect()
    const cards = [...element.querySelectorAll('.card-picker__preview .card')].map((card) => card.getBoundingClientRect())
    const controls = [...element.querySelectorAll('.card-picker__footer button')].map((button) => button.getBoundingClientRect())
    return {
      pickerFit: picker.left === 0 && picker.right === innerWidth && picker.bottom === innerHeight,
      previewPinned: grid?.scrollTop > 0 && cards.every((box) => box.top >= 0 && box.bottom <= innerHeight),
      cardsFit: cards.length === 2 && cards.every((box) => box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight),
      controlsFit: controls.every((box) => box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight),
    }
  })
  assert(neowPhone.pickerFit && neowPhone.previewPinned && neowPhone.cardsFit && neowPhone.controlsFit, JSON.stringify(neowPhone))
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.evaluate(() => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.phase = 'room'
    run.neow = null
    run.map.position = Object.entries(run.map.rooms).find(([, room]) => room.kind === 'campfire')?.[0]
    debug.setRun(run)
  })
  await page.locator('.campfire').waitFor()

  await page.getByRole('button', { name: /Smith/ }).click()
  const picker = page.locator('.card-picker')
  await picker.waitFor()
  assert(await picker.locator('.card-picker__grid > .card').count() > 0)
  assert(await picker.getByRole('button', { name: 'Confirm' }).isDisabled())
  await picker.locator('.card-picker__grid > .card').first().click()
  await picker.locator('.card-picker__preview').waitFor()
  assert.equal(await picker.locator('.card-picker__preview .card').count(), 2)
  assert(!await picker.getByRole('button', { name: 'Confirm' }).isDisabled())
  assert.equal(await picker.locator('.card-picker__grid > .card').first().getAttribute('aria-disabled'), 'true')
  assert.equal(await picker.locator('.card-picker__grid > .card').first().getAttribute('tabindex'), '-1')
  assert.equal(await picker.locator('.card-picker__preview .card').nth(1).getAttribute('aria-disabled'), 'true')
  assert.equal(await picker.locator('.card-picker__preview .card').nth(1).getAttribute('tabindex'), '-1')
  await page.waitForFunction(() => Boolean(document.activeElement?.closest('.card-picker__preview')))
  for (let index = 0; index < 20; index += 1) await page.keyboard.press('Tab')
  assert(await page.evaluate(() => Boolean(document.activeElement?.closest('.card-picker'))))
  await picker.getByRole('button', { name: 'Back' }).click()
  await picker.locator('.card-picker__preview').waitFor({ state: 'detached' })
  await picker.locator('.card-picker__grid > .card').first().click()
  await picker.getByRole('button', { name: 'Confirm' }).click()
  await picker.waitFor({ state: 'detached' })

  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.getByRole('button', { name: /^Current deck,/ }).click()
  const deck = page.getByRole('dialog', { name: 'Current deck' })
  await deck.waitFor()
  assert.deepEqual(await deck.locator('.card-collection__sort button').allTextContents()
    .then((labels) => labels.map((label) => label.replace(/\s*[↑↓↕]\s*$/, '').trim())),
  ['Obtained', 'Card Type', 'Cost', 'A - Z'])
  await deck.getByRole('button', { name: /A - Z/ }).click()
  const names = await deck.locator('.choice-modal__cards > .card').evaluateAll((cards) =>
    cards.map((card) => card.getAttribute('aria-label')?.split(',')[0] ?? ''))
  assert.deepEqual(names, [...names].sort((left, right) => left.localeCompare(right)))
  const deckRows = await deck.locator('.choice-modal__cards > .card').evaluateAll((cards) => Object.values(cards.reduce((rows, card) => {
    const top = Math.round(card.getBoundingClientRect().top)
    rows[top] = (rows[top] ?? 0) + 1
    return rows
  }, {})).sort((left, right) => right - left))
  assert.equal(deckRows[0], 5)
  await deck.getByLabel('Current deck upgrade preview').check()
  assert((await deck.locator('.choice-modal__cards > .card').first().getAttribute('aria-label'))?.includes('+, '))
  await deck.getByRole('button', { name: 'Close' }).click()

  await page.evaluate(() => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.players[0].relics.push({ defId: 'peace_pipe', spent: false }, { defId: 'straight_razor', spent: false })
    debug.setRun(run)
  })
  await page.getByRole('button', { name: /Rest/ }).click()
  await picker.waitFor()
  assert.equal(await picker.getAttribute('aria-label'), 'Choose a card to remove')
  const pickerRows = await picker.locator('.card-picker__grid > .card').evaluateAll((cards) => Object.values(cards.reduce((rows, card) => {
    const top = Math.round(card.getBoundingClientRect().top)
    rows[top] = (rows[top] ?? 0) + 1
    return rows
  }, {})).sort((left, right) => right - left))
  assert.equal(pickerRows[0], 5)
  assert(!await picker.getByRole('button', { name: 'Confirm' }).isDisabled())
  await picker.getByRole('button', { name: 'Confirm' }).click()
  assert.equal(await picker.getAttribute('aria-label'), 'Choose a card to transform')
  await picker.getByRole('button', { name: 'Back' }).click()
  await picker.waitFor({ state: 'detached' })
  await page.getByRole('button', { name: /Rest/ }).click()
  await picker.waitFor()
  await picker.locator('.card-picker__grid > .card').first().click()
  assert.equal(await picker.locator('.card-picker__preview .card').count(), 1)
  await picker.getByRole('button', { name: 'Confirm' }).click()
  await picker.waitFor({ state: 'attached' })
  assert.equal(await picker.getAttribute('aria-label'), 'Choose a card to transform')
  await picker.locator('.card-picker__grid > .card').first().click()
  assert.equal(await picker.locator('.card-picker__preview .card').count(), 1)
  await picker.getByRole('button', { name: 'Back' }).click()
  await picker.locator('.card-picker__preview').waitFor({ state: 'detached' })
  await picker.getByRole('button', { name: 'Back' }).click()
  await picker.waitFor({ state: 'detached' })

  await page.setViewportSize({ width: 568, height: 320 })
  await page.getByRole('button', { name: /Smith/ }).click()
  await picker.waitFor()
  await picker.locator('.card-picker__grid > .card').first().click()
  await picker.locator('.card-picker__preview').waitFor()
  const phone = await picker.evaluate((element) => {
    const pickerBox = element.getBoundingClientRect()
    const cards = [...element.querySelectorAll('.card-picker__preview .card')].map((card) => card.getBoundingClientRect())
    const controls = [...element.querySelectorAll('.card-picker__footer button')].map((button) => button.getBoundingClientRect())
    return {
      overflow: document.documentElement.scrollHeight > innerHeight || document.documentElement.scrollWidth > innerWidth,
      cardsFit: cards.length === 2 && cards.every((box) => box.left >= pickerBox.left - 1 && box.right <= pickerBox.right + 1 && box.top >= pickerBox.top - 1 && box.bottom <= pickerBox.bottom + 1),
      controlsFit: controls.every((box) => box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight),
    }
  })
  assert.equal(phone.overflow, false, JSON.stringify(phone))
  assert(phone.cardsFit && phone.controlsFit, JSON.stringify(phone))
  console.log('Card picker browser checks passed')
} finally {
  await browser.close()
  await server.close()
}
