import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium, webkit } from './lib/profile-browser.mjs'
import { postNeowRun } from './lib/post-neow-run.mjs'
import { chooseRelicReward } from '../src/game/run.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const output = `${root}artifacts/treasure-animation`
mkdirSync(output, { recursive: true })
const server = await createServer({ root, logLevel: 'silent', server: { port: 0 } })
await server.listen()
const errors = []
const seats = ['ironclad', 'silent', 'defect', 'watcher'].map((character, index) => ({ id: `p${index + 1}`, name: ['A · Ironclad', 'B · Silent', 'C · Defect', 'D · Watcher'][index], character }))
function fixture(shared = true, roster = seats) {
  const run = postNeowRun('treasure-animation', roster)
  run.phase = 'room'
  run.roomState = { kind: 'treasure', playerIds: seats.map((p) => p.id), decisions: {},
    offers: shared ? {} : { p1: 'anchor', p2: 'bag_of_preparation', p3: 'lantern', p4: 'vajra' },
    ...(shared ? { sharedOffers: ['anchor', 'bag_of_preparation', 'lantern', 'vajra'] } : {}),
  }
  return run
}
try {
  for (const [engineName, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await engine.launch()
    try {
      for (const [name, viewport] of [['desktop', { width: 1440, height: 900 }], ['horizontal-phone', { width: 844, height: 390 }]]) {
        if (process.argv.includes('--touch-only') && name !== 'horizontal-phone') continue
        const context = await browser.newContext({ viewport, hasTouch: name === 'horizontal-phone', ...(engineName === 'chromium' && name === 'desktop' ? { recordVideo: { dir: output, size: viewport } } : {}) })
        const page = await context.newPage()
        page.on('pageerror', (error) => errors.push(String(error)))
        await page.goto(`http://localhost:${server.httpServer.address().port}`, { waitUntil: 'networkidle' })
        await page.getByRole('button', { name: 'Single Player', exact: true }).click()
        await page.getByRole('button', { name: 'Standard', exact: true }).click()
        await page.getByRole('button', { name: 'Embark', exact: true }).click()
        await page.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
        await page.waitForFunction(() => window.__STS_DEBUG__?.getRun().phase === 'neow')
        await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), fixture())
        await page.locator('.treasure-chest').waitFor()
        await page.getByRole('button', { name: 'Open treasure chest', exact: true }).click()
        await page.waitForTimeout(1700)
        await page.mouse.move(5,5)
        if (name === 'horizontal-phone') await page.locator('[data-treasure-slot="0"]').tap()
        else await page.locator('[data-treasure-slot="0"]').hover()
        await page.locator('.potion-tip:visible').waitFor()
        assert.match(await page.locator('.potion-tip:visible').innerText(), /Anchor/)
        if (name === 'horizontal-phone') {
          assert.deepEqual(await page.evaluate(() => window.__STS_DEBUG__.getRun().roomState.decisions), {}, 'First tap must only show details')
          assert.match(await page.locator('.potion-tip:visible').innerText(), /Tap again to take this relic/i)
          assert.equal(await page.locator('.treasure-claim:not(.treasure-preview)').count(), 0)
        }
        await page.screenshot({ path: `${output}/${engineName}-${name}-hover.png` })
        if (name === 'horizontal-phone') await page.locator('[data-treasure-slot="0"]').tap()
        else await page.locator('[data-treasure-slot="0"]').click()
        await page.locator('.treasure-claim--0').waitFor({ state: 'attached' })
        assert.equal(await page.locator('[data-treasure-slot="0"]').getAttribute('data-taken'), 'true')
        assert.equal(await page.locator('[data-treasure-slot="0"]').evaluate((element) => element.tagName), 'SPAN')
        await page.locator('.potion-tip:visible').waitFor({ state: 'detached' })
        await page.waitForTimeout(550)
        await page.screenshot({ path: `${output}/${engineName}-${name}-hand.png` })
        await page.locator('.treasure-claim:not(.treasure-preview)').waitFor({ state: 'detached' })
        // Remote decisions use authoritative snapshots while the viewer stays on A.
        for (let seat = 1; seat < 4; seat++) {
          const current = await page.evaluate(() => window.__STS_DEBUG__.getRun())
          const next = chooseRelicReward(current, `p${seat + 1}`, seat)
          await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), next)
          await page.locator(`.treasure-claim--${seat}`).waitFor({ state: 'attached' })
          assert.match(await page.locator(`.treasure-claim--${seat} img.treasure-claim__hand--reach`).getAttribute('src'), new RegExp(seats[seat].character))
          if (seat === 3) assert.equal(await page.evaluate(() => window.__STS_DEBUG__.getRun().phase), 'map')
          await page.locator('.treasure-claim:not(.treasure-preview)').waitFor({ state: 'detached' })
        }
        assert.equal(await page.locator('.treasure-claim:not(.treasure-preview)').count(), 0)
        // Another player taking the hovered relic must dismiss the local preview.
        if (name === 'desktop') {
          const fresh = fixture()
          await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), fresh)
          await page.getByRole('button', { name: 'Open treasure chest', exact: true }).click()
          await page.locator('[data-treasure-slot="0"]').hover()
          await page.locator('.treasure-preview').waitFor({ state: 'attached' })
          await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), chooseRelicReward(fresh, 'p2', 0))
          await page.locator('.treasure-preview').waitFor({ state: 'detached' })
          await page.locator('.potion-tip:visible').waitFor({ state: 'detached' })
          await page.locator('.treasure-claim:not(.treasure-preview)').waitFor({ state: 'detached' })
          await page.evaluate(() => { const run = window.__STS_DEBUG__.getRun(); window.__STS_DEBUG__.setRun({ ...run, phase: 'map', roomState: null }) })
          await page.locator('.treasure-chest').waitFor({ state: 'detached' })
        }
        // Assigned rewards expose the party but never let A claim B's relic.
        await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), fixture(false))
        await page.getByRole('button', { name: 'Open treasure chest', exact: true }).click()
        await page.waitForTimeout(1500)
        assert.equal(await page.locator('[data-treasure-slot="p2"]').getAttribute('aria-disabled'), 'true')
        await page.locator('[data-treasure-slot="p2"]').dispatchEvent('click')
        assert.deepEqual(await page.evaluate(() => window.__STS_DEBUG__.getRun().roomState.decisions), {})
        await page.evaluate(() => { document.documentElement.dataset.reducedMotion = 'true' })
        await page.getByRole('button', { name: 'Take relic', exact: true }).click()
        assert.equal(await page.locator('.treasure-claim:not(.treasure-preview)').count(), 0)
        const run = await page.evaluate(() => window.__STS_DEBUG__.getRun())
        assert.equal(run.roomState.decisions.p1, 'take')
        // Reapplying a snapshot must not repeat the pickup.
        await page.evaluate((run) => { delete document.documentElement.dataset.reducedMotion; window.__STS_DEBUG__.setRun(run) }, run)
        assert.equal(await page.locator('.treasure-claim:not(.treasure-preview)').count(), 0)
        assert(await page.locator('.treasure-actions').isVisible())
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
        assert.equal(overflow, false, 'Treasure must not widen the viewport')
        if (engineName === 'chromium' && name === 'desktop') {
          // One coalesced server snapshot can finish all four decisions at once.
          const roster = ['slime_boss', 'guardian', 'hexaghost', 'hermit'].map((character, index) => ({ id: `p${index + 1}`, name: character, character }))
          let downfall = fixture(true, roster)
          downfall.roomState.sharedOffers[3] = 'old_coin'
          await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), downfall)
          // Same mounted room: it is already open after the duplicate-snapshot check.
          await page.locator('[data-treasure-slot="0"]').waitFor()
          for (let index = 0; index < 4; index++) downfall = chooseRelicReward(downfall, `p${index + 1}`, index)
          await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), downfall)
          await page.waitForFunction(() => document.querySelectorAll('.treasure-claim:not(.treasure-preview)').length === 4)
          for (const character of roster.map((seat) => seat.character)) {
            const art = page.locator(`.treasure-claim__hand--grip[src*="${character}"]`)
            await art.evaluate((image) => image.decode())
          }
          await page.waitForFunction(() => !document.querySelector('.treasure-claim:not(.treasure-preview)'))
        }
        if (page.video()) console.log(`Video: ${await page.video().path()}`)
        await context.close()
        console.log(`✓ ${engineName} ${name}: chest, hover, four confirmed claims, final transition, assigned ownership, reduced motion, duplicate snapshot`)
      }
    } finally { await browser.close() }
  }
  assert.deepEqual(errors, [])
} finally { await server.close() }
