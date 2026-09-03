import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const server = await createServer({ root, logLevel: 'silent', server: { port: 0 } })
await server.listen()
const address = server.httpServer?.address()
if (!address || typeof address === 'string') throw new Error('vite did not report a port')
const browser = await chromium.launch()

try {
  const context = await browser.newContext()
  await context.addInitScript(() => localStorage.setItem('sts-physical-campaign', JSON.stringify({
    version: 1,
    characters: { ironclad: 0, silent: 0, defect: 0, watcher: 0 },
    colorless: 0,
    actIV: 0,
    unspentMarks: 2,
    highestAscension: 0,
    nextRunNumber: 0,
    finishedRunIds: [],
  })))
  const page = await context.newPage()
  await page.goto(`http://localhost:${address.port}`, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => window.__STS_DEBUG__)
  const sharedContent = await page.evaluate(() => {
    const run = window.__STS_DEBUG__.getRun()
    const { colorless, actIV, unspentMarks } = run.campaignProgress
    return { colorless, actIV, unspentMarks, colorlessCards: run.itemDecks.colorless.length }
  })
  assert.deepEqual(sharedContent, { colorless: 3, actIV: 5, unspentMarks: 0, colorlessCards: 22 })

  await page.getByRole('button', { name: 'Single Player' }).click()
  await page.getByRole('button', { name: 'Custom' }).click()
  assert.equal(await page.getByLabel('Starting Act').locator('option[value="4"]').isDisabled(), false)
  console.log('single-player Colorless and Act IV unlocks verified')
} finally {
  await browser.close()
  await server.close()
}
