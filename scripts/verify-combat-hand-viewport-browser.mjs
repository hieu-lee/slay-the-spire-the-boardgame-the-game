import { strict as assert } from 'node:assert'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium, webkit } from './lib/profile-browser.mjs'
import { postNeowRun } from './lib/post-neow-run.mjs'
import { enterRoom } from '../src/game/run.ts'

const root = resolve(import.meta.dirname, '..')
const out = resolve(root, 'artifacts/combat-hand-viewport')
mkdirSync(out, { recursive: true })
const server = await createServer({ root, logLevel: 'silent', server: { port: 0 } })
await server.listen()
try {
  for (const [engineName, engine] of Object.entries({ chromium, webkit })) {
    const browser = await engine.launch()
    try {
      for (const [screen, viewport] of [['desktop', { width: 1280, height: 720 }],
        ['horizontal-phone', { width: 844, height: 390 }]]) {
        const phone = screen === 'horizontal-phone'
        const context = await browser.newContext({ viewport, isMobile: phone, hasTouch: phone })
        const page = await context.newPage()
        const errors = []
        page.on('pageerror', error => errors.push(String(error)))
        await page.goto(`http://localhost:${server.httpServer.address().port}`)
        for (const name of ['Single Player', 'Standard', 'Embark', 'Start standard campaign'])
          await page.getByRole('button', { name, exact: true }).click()
        const ready = async () => {
          await page.locator('.hand .card').first().waitFor()
          await page.waitForFunction(() => [...document.querySelectorAll('.hand .card')].every(card =>
            card.getAnimations().every(animation => animation.playState === 'finished')))
        }
        const check = async label => {
          await ready()
          const geometry = await page.evaluate(() => {
            const rect = e => e.getBoundingClientRect().toJSON()
            const hand = document.querySelector('.hand-scroll')
            const shell = document.querySelector('.app-shell')
            const board = document.querySelector('.board')
            return { shell: rect(shell), hand: rect(hand), board: rect(board), scrollTop: hand.scrollTop,
              orbs: [...board.querySelectorAll('.orbs')].map(rect),
              clientHeight: hand.clientHeight, scrollHeight: hand.scrollHeight,
              cards: [...document.querySelectorAll('.hand .card')].map(rect),
              heroes: [...document.querySelectorAll('.row__seat .bar')].map(rect).sort((a, b) => a.left - b.left),
              names: [...document.querySelectorAll('.enemy')].map(e => ({
                portrait: rect(e.querySelector('.enemy__portrait')), name: rect(e.querySelector('.enemy__head')),
                health: rect(e.querySelector('.bar')),
              })),
              enemies: [...document.querySelectorAll('.enemy .bar')].map(rect).sort((a, b) => a.left - b.left) }
          })
          assert(geometry.cards.every(card => card.top >= geometry.hand.top - 1 &&
            card.bottom <= Math.min(geometry.hand.bottom, geometry.shell.bottom) + 1),
          `${label}: clipped hand ${JSON.stringify(geometry)}`)
          assert(geometry.scrollHeight <= geometry.clientHeight + 1 && geometry.scrollTop === 0,
            `${label}: hidden vertical hand overflow`)
          assert(geometry.orbs.every(orbs => orbs.top >= geometry.board.top - 1), `${label}: upper Orb controls clipped`)
          assert(geometry.names.every(({ portrait, name, health }) =>
            portrait.bottom <= name.top + 1 && name.bottom <= health.top - 1), `${label}: enemy name overlaps art or HP`)
          if (geometry.heroes.length === 2) {
            const gap = bars => bars[1].left - bars[0].right
            assert(Math.abs(gap(geometry.heroes) - gap(geometry.enemies)) < 1,
              `${label}: enemy HP spacing differs from heroes`)
          }
          await page.screenshot({ path: resolve(out, `${engineName}-${screen}-${label}.png`) })
        }
        for (const partySize of [1, 2]) {
          const run = postNeowRun(47, [
            { id: 'p1', name: 'Ironclad', character: 'ironclad' },
            { id: 'p2', name: 'Defect', character: 'defect' },
          ].slice(0, partySize))
          const id = run.map.rows[0][0]
          run.map.rooms[id].kind = 'encounter'
          const combat = enterRoom(run, id)
          combat.combat.enemies = ['acid_slime', 'small_slime'].map((defId, i) => ({
            ...combat.combat.enemies[0], uid: `spacing-${i}`, defId, row: 0,
            hp: 5, maxHp: 5, dead: false, isBoss: false,
          }))
          await page.evaluate(run => window.__STS_DEBUG__.setRun(run), combat)
          await check(`party-${partySize}-initial`)
          // Mobile Safari keeps vh/layout media queries at their large size
          // while browser chrome reduces the dynamic viewport. Model that
          // independently: setViewportSize alone changes both and misses it.
          const toolbar = await page.addStyleTag({ content:
            'html, body, #root { height: calc(100dvh - 100px); }' })
          await check(`party-${partySize}-toolbar`)
          const card = page.locator('.hand .card').first()
          await card.focus()
          await page.waitForTimeout(200)
          await check(`party-${partySize}-focused`)
          await card.evaluate(e => e.blur())
          await toolbar.evaluate(e => e.remove())
          await page.waitForTimeout(200)
          await check(`party-${partySize}-restored`)
          if (partySize === 1) {
            await page.waitForFunction(() => {
              const saved = JSON.parse(localStorage.getItem('sts-solo-run') ?? 'null')
              return JSON.stringify(saved?.run) === JSON.stringify(window.__STS_DEBUG__.getRun())
            })
            await page.reload({ waitUntil: 'networkidle' })
            await page.getByRole('button', { name: 'Resume', exact: true }).click()
            await check(`party-${partySize}-resume`)
          }
        }
        assert.deepEqual(errors, [])
        await context.close()
        console.log(`${engineName}/${screen}: hand bounds, toolbar resize, focus, resume and actor spacing passed`)
      }
    } finally { await browser.close() }
  }
} finally { await server.close() }
