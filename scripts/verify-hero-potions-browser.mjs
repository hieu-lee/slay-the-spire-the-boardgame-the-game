import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium } from './lib/profile-browser.mjs'
import { postNeowRun } from './lib/post-neow-run.mjs'
import { CHARACTER_IDS } from '../src/game/types.ts'
import { enterRoom } from '../src/game/run.ts'

// Held potions and Defect's Orbs float just above the painted head, not above the
// empty margin of the art canvas, and the Orbs never sit on the potions.
const root = resolve(import.meta.dirname, '..')
const server = await createServer({ root, logLevel: 'silent', server: { port: 0 } })
await server.listen()
try {
  // Safari plays heroes as alpha video, which a canvas cannot read back, so only Chromium measures pixels.
  for (const [engineName, engine] of Object.entries({ chromium })) {
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
        // The potions must sit just above the painted head on screen right now, with the Orbs above them.
        const assertHead = async (where) => {
          const m = await page.evaluate(() => {
            const seat = document.querySelector('.seat__interactive')
            const image = seat.querySelector('.seat__portrait > :is(img, video):not([style*="display: none"])')
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
            const icons = [...seat.querySelectorAll('.seat__potions .item-icon-image')].map((icon) => icon.getBoundingClientRect())
            const orbs = [...seat.querySelectorAll('.orbs > *')].map((orb) => orb.getBoundingClientRect())
            return { headTop: box.bottom - (canvas.height - top) * fit, iconBottom: Math.max(...icons.map((icon) => icon.bottom)),
              iconTop: Math.min(...icons.map((icon) => icon.top)), orbsBottom: orbs.length ? Math.max(...orbs.map((orb) => orb.bottom)) : null,
              orbsTop: orbs.length ? Math.min(...orbs.map((orb) => orb.top)) : null, boardTop: document.querySelector('.board').getBoundingClientRect().top }
          }).catch((error) => { throw new Error(`${where}: ${error.message}`) })
          const gap = m.headTop - m.iconBottom
          // The idle loop moves the head a few pixels either way.
          assert(gap >= -8, `${where}: potions cover the head ${JSON.stringify(m)}`)
          assert(gap <= 40, `${where}: potions float ${Math.round(gap)}px above the head ${JSON.stringify(m)}`)
          if (m.orbsBottom !== null) {
            assert(m.orbsBottom <= m.iconTop + 2, `${where}: Orbs sit on the potions ${JSON.stringify(m)}`)
            assert(m.orbsTop >= m.boardTop, `${where}: Orbs clipped by the board ${JSON.stringify(m)}`)
          }
        }
        const check = async (label, setup) => {
          const where = `${engineName}/${screen}/${label}`
          const [character, orbCount, heat, guardianMode] = setup
          const run = postNeowRun(47, [{ id: 'p1', name: 'Hero', character }])
          const id = run.map.rows[0][0]
          run.map.rooms[id].kind = 'encounter'
          const combat = enterRoom(run, id)
          const player = combat.combat.players[0]
          player.potions = ['fire_potion', 'block_potion']
          if (orbCount) player.orbs = Array.from({ length: orbCount }, (_, i) => ['lightning', 'frost', 'dark'][i % 3])
          if (heat !== undefined) player.heat = heat
          if (guardianMode) player.guardianMode = guardianMode
          await page.evaluate((state) => window.__STS_DEBUG__.setRun(state), combat)
          await page.locator('.seat__interactive .seat__potions').waitFor()
          const art = page.locator('.seat__interactive .seat__portrait > :is(img, video):not([style*="display: none"])').first()
          await art.waitFor()
          await art.evaluate((image) => image.decode())
          await page.waitForTimeout(900)
          await assertHead(where)
          if (guardianMode && screen !== 'desktop-reduced-motion') {
            // The mode shift shows taller transition art for a moment.
            const shifted = structuredClone(combat)
            shifted.combat.players[0].guardianMode = guardianMode === 'attack' ? 'defense' : 'attack'
            await page.evaluate((state) => window.__STS_DEBUG__.setRun(state), shifted)
            const transition = page.locator('.seat__portrait > [data-guardian-transition]')
            await transition.waitFor()
            await transition.evaluate((image) => image.decode())
            await assertHead(`${where} mode shift`)
          }
        }
        for (const character of CHARACTER_IDS) {
          if (character === 'defect') for (const orbs of [3, 6, 10]) await check(`defect with ${orbs} Orbs`, [character, orbs])
          else if (character === 'hexaghost') for (const heat of [0, 3, 6]) await check(`hexaghost heat ${heat}`, [character, 0, heat])
          else if (character === 'guardian') for (const mode of ['attack', 'defense']) await check(`guardian ${mode}`, [character, 0, undefined, mode])
          else await check(character, [character])
        }
        assert.deepEqual(errors, [])
        await page.close()
        console.log(`${engineName}/${screen}: held potions and Orbs sit on every hero's head`)
      }
    } finally { await browser.close() }
  }
} finally { await server.close() }
