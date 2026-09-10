import { strict as assert } from 'node:assert'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from './lib/profile-browser.mjs'
import { postNeowRun } from './lib/post-neow-run.mjs'
import { enterRoom } from '../src/game/run.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'artifacts/combat-player-clipping')
mkdirSync(out, { recursive: true })
const server = await createServer({ root, logLevel: 'silent', server: { port: 0 } })
await server.listen()
const browser = await chromium.launch()

try {
  const run = postNeowRun('combat-player-clipping', [
    { id: 'p1', name: 'master69', character: 'ironclad' },
    { id: 'p2', name: 'BestDefect2002', character: 'defect' },
  ])
  const roomId = run.map.rows[0][0]
  run.map.rooms[roomId].kind = 'encounter'
  const combat = enterRoom(run, roomId)
  combat.combat.enemies = []

  for (const viewport of [{ width: 1280, height: 720 }, { width: 667, height: 375 }]) {
    const context = await browser.newContext({ viewport })
    const page = await context.newPage()
    await page.goto(`http://localhost:${server.httpServer.address().port}`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Single Player', exact: true }).click()
    await page.getByRole('button', { name: 'Standard', exact: true }).click()
    await page.getByRole('button', { name: 'Embark', exact: true }).click()
    await page.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
    await page.evaluate(value => window.__STS_DEBUG__.setRun(value), combat)
    await page.evaluate(() => window.__STS_DEBUG__.setViewer('p2'))
    await page.locator('.row--viewer .row__seat').waitFor({ timeout: 10_000 })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const bounds = await page.locator('.board').evaluate((board) => {
      const outer = board.getBoundingClientRect()
      const seats = [...board.querySelectorAll('.row__seat:has(.seat:not(.seat--empty))')]
        .map(seat => seat.getBoundingClientRect().toJSON())
      return { board: outer.toJSON(), seats }
    })
    assert(bounds.seats.every(seat => seat.left >= bounds.board.left && seat.right <= bounds.board.right),
      `${viewport.width}x${viewport.height} player seat is clipped: ${JSON.stringify(bounds)}`)
    await page.screenshot({ path: join(out, `${viewport.width}x${viewport.height}.png`) })
    await context.close()
  }
  console.log('Combat player clipping browser check passed')
} finally {
  await browser.close()
  await server.close()
}
