// Scrap Ooze on a 1–2: the player must see a clear "reach again or leave"
// choice with both keys on screen, and Reach again must roll the die at once.
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from './lib/profile-browser.mjs'
import { suite, check, assert, assertEqual, assertDeepEqual, report } from './lib/harness.mjs'

suite('scrap ooze browser')

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = join(root, 'artifacts/scrap-ooze-browser')
mkdirSync(output, { recursive: true })
const vite = await createServer({ root, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } })
await vite.listen()
const address = vite.httpServer?.address()
if (!address || typeof address === 'string') throw new Error('vite did not report a port')
const browser = await chromium.launch()
const errors = []

try {
  for (const [screen, viewport] of [['desktop', { width: 1440, height: 900 }], ['landscape-phone', { width: 844, height: 390 }]]) {
    const page = await browser.newPage({ viewport })
    page.on('pageerror', (error) => errors.push(`${screen}: ${error.message}`))
    await page.goto(`http://127.0.0.1:${address.port}`, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'Single Player', exact: true }).click()
    await page.getByRole('button', { name: 'Standard', exact: true }).click()
    await page.getByRole('button', { name: 'Embark' }).click()
    await page.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
    await page.waitForFunction(() => window.__STS_DEBUG__?.getRun().phase === 'neow')
    const replay = (values) => page.evaluate((next) => {
      const run = structuredClone(window.__STS_DEBUG__.getRun())
      run.rng = { ...run.rng, replayValues: next }
      window.__STS_DEBUG__.setRun(run)
    }, values)
    await page.evaluate(async () => {
      const { EVENT_CARDS } = await import('/src/game/events.ts')
      const run = structuredClone(window.__STS_DEBUG__.getRun())
      run.phase = 'room'
      run.neow = null
      run.map.position = run.map.rows[0][0]
      run.roomState = { kind: 'event', card: EVENT_CARDS.find((card) => card.id === 'scrap_ooze'), decisions: {}, dieRolls: {} }
      window.__STS_DEBUG__.setRun(run)
    })
    await replay([0.01])
    await page.getByRole('button', { name: /Reach Inside/ }).click()
    const again = page.getByRole('button', { name: 'Reach again', exact: true })
    await again.waitFor()
    await page.locator('.event-die[data-landed]').waitFor()
    const retry = await page.evaluate(() => {
      const keys = [...document.querySelectorAll('.event-options--retry button')]
      return {
        labels: keys.map((key) => key.textContent.trim()),
        status: document.querySelector('.event-retry')?.textContent,
        onScreen: keys.every((key) => {
          const box = key.getBoundingClientRect()
          const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
          return box.top >= 0 && box.bottom <= innerHeight && Boolean(hit && key.contains(hit))
        }),
        centered: keys.every((key) => {
          const box = key.getBoundingClientRect()
          const label = key.querySelector('strong').getBoundingClientRect()
          return Math.abs(label.left + label.width / 2 - (box.left + box.width / 2)) <= 3
        }),
      }
    })
    await page.screenshot({ path: join(output, `${screen}-retry.png`) })
    await replay([0.4])
    await again.click()
    await page.waitForFunction(() => (window.__STS_DEBUG__.getRun().roomState?.dieRolls?.p1?.length ?? 0) === 2)
    const rolled = await page.evaluate(() => window.__STS_DEBUG__.getRun().roomState.dieRolls.p1)
    check(`${screen}: a missed reach offers both keys on screen and Reach again rolls at once`, () => {
      assertDeepEqual(retry.labels, ['Reach again', 'Leave'])
      assert(retry.status?.includes('Reach in again'), 'the retry state did not say what happened')
      assert(retry.onScreen, 'a retry key was off screen or covered')
      assert(retry.centered, 'a retry key label was not centered on its key')
      assertDeepEqual(rolled, [1, 3], 'Reach again did not roll the die in the same click')
    })
    await page.close()
  }
  check('the Scrap Ooze flow raised no page errors', () => assertEqual(errors.join('\n'), ''))
} finally {
  await browser.close()
  await vite.close()
}
report('scrap ooze browser')
