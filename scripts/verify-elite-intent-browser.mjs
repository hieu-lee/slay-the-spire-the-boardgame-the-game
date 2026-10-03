import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium, webkit } from './lib/profile-browser.mjs'
import { postNeowRun } from './lib/post-neow-run.mjs'
import { ENEMIES } from '../src/game/enemies.ts'
import { enterRoom } from '../src/game/run.ts'

const root = resolve(import.meta.dirname, '..')
// Every Elite and Boss telegraph sits just above the painted head, not above the
// transparent animation canvas, so it reads as that enemy's own next move.
const defs = Object.values(ENEMIES).filter((def) => def.isBoss || def.elite)
const server = await createServer({ root, logLevel: 'silent', server: { port: 0 } })
await server.listen()
try {
  for (const [engineName, engine] of Object.entries({ chromium, webkit })) {
    if (process.argv.includes('--webkit-only') && engineName !== 'webkit') continue
    const browser = await engine.launch()
    try {
      for (const [screen, viewport, reducedMotion] of [['desktop', { width: 1440, height: 900 }, 'no-preference'],
        ['horizontal-phone', { width: 844, height: 390 }, 'no-preference'], ['desktop-reduced-motion', { width: 1440, height: 900 }, 'reduce']]) {
        const phone = screen === 'horizontal-phone'
        const page = await (await browser.newContext({ viewport, reducedMotion, isMobile: phone, hasTouch: phone })).newPage()
        const errors = []
        page.on('pageerror', (error) => errors.push(String(error)))
        await page.goto(`http://localhost:${server.httpServer.address().port}`)
        for (const name of ['Single Player', 'Standard', 'Embark', 'Start standard campaign'])
          await page.getByRole('button', { name, exact: true }).click()
        const run = postNeowRun(47, [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
        const id = run.map.rows[0][0]
        run.map.rooms[id].kind = 'encounter'
        const combat = enterRoom(run, id)
        // The intent must sit just above the painted head of the art on screen now, and inside the board.
        const check = async (def, label, settleMs) => {
          const art = page.locator(`[data-enemy-def="${def.id}"] .enemy__art--cutout:not([data-inactive])`)
          await art.waitFor()
          await art.evaluate((image) => image.decode())
          await page.waitForTimeout(settleMs)
          const bands = await art.evaluate((image) => {
            const canvas = document.createElement('canvas')
            canvas.width = image.naturalWidth
            canvas.height = image.naturalHeight
            const context = canvas.getContext('2d')
            context.drawImage(image, 0, 0)
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
            let top = canvas.height
            for (let y = 0; y < canvas.height && top === canvas.height; y++)
              for (let x = 0; x < canvas.width; x++) if (pixels[(y * canvas.width + x) * 4 + 3] > 96) { top = y; break }
            const box = image.getBoundingClientRect()
            const fit = Math.min(box.width / canvas.width, box.height / canvas.height)
            const intent = document.querySelector('.enemy__intent').getBoundingClientRect()
            return { paintedTop: box.bottom - (canvas.height - top) * fit, intentTop: intent.top, intentBottom: intent.bottom,
              boardTop: document.querySelector('.board').getBoundingClientRect().top }
          })
          const gap = bands.paintedTop - bands.intentBottom
          const where = `${engineName}/${screen}/${def.id}/${label}`
          // The idle loop moves the head a few pixels either way.
          assert(gap >= -6, `${where}: intent covers the head ${JSON.stringify(bands)}`)
          assert(gap <= 40, `${where}: intent floats ${Math.round(gap)}px above the head ${JSON.stringify(bands)}`)
          assert(bands.intentTop >= bands.boardTop, `${where}: intent clipped by the board ${JSON.stringify(bands)}`)
        }
        for (const def of defs) {
          const next = structuredClone(combat)
          next.combat.enemies = [{ ...next.combat.enemies[0], uid: `intent-${def.id}`, defId: def.id, row: 0, hp: 50, maxHp: 50,
            block: 0, dead: false, isBoss: Boolean(def.isBoss) }]
          await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), next)
          await check(def, 'first action', 400)
          // Later actions can print several effects, and Lagavulin wakes; each is checked on screen.
          for (let actionIndex = 1; actionIndex < 6; actionIndex++) {
            const later = structuredClone(next)
            later.combat.enemies[0].actionIndex = actionIndex
            await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), later)
            const woke = def.id === 'lagavulin' && await page.locator('.enemy[data-sleeping]').count() === 0
            await check(def, `action ${actionIndex}`, woke ? 2000 : 100)
          }
        }
        assert.deepEqual(errors, [])
        await page.close()
        console.log(`${engineName}/${screen}: ${defs.length} Elite and Boss intents sit on their heads`)
      }
    } finally { await browser.close() }
  }
} finally { await server.close() }
