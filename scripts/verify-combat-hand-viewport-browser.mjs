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
    if (process.argv.includes('--webkit-only') && engineName !== 'webkit') continue
    const browser = await engine.launch()
    try {
      for (const [screen, viewport] of [['desktop', { width: 1280, height: 720 }],
        ['horizontal-phone', { width: 844, height: 390 }]]) {
        if (process.argv.includes('--phone-only') && screen !== 'horizontal-phone') continue
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
          await page.waitForTimeout(1000)
          await page.waitForFunction(() => [...document.querySelectorAll('.hand .card')].every(card =>
            card.getAnimations().every(animation => animation.playState === 'finished')))
        }
        const check = async label => {
          await ready()
          assert(await page.locator('.row--viewer').evaluate(e => getComputedStyle(e).backgroundImage === 'none'), `${label}: rectangular viewer background returned`)
          const geometry = await page.evaluate(() => {
            const rect = e => e.getBoundingClientRect().toJSON()
            const hand = document.querySelector('.hand-scroll')
            const shell = document.querySelector('.app-shell')
            const board = document.querySelector('.board')
            return { shell: rect(shell), hand: rect(hand), board: rect(board), endTurn: rect(document.querySelector('.combat__end-turn')), scrollTop: hand.scrollTop,
              orbs: [...board.querySelectorAll('.orbs')].map(rect),
              statuses: [...board.querySelectorAll('.seat__status-strip .token, .seat__status-strip .power, .seat__status-strip .power__counter, .enemy .tokens .token')].map(rect),
              clientHeight: hand.clientHeight, scrollHeight: hand.scrollHeight,
              cards: [...document.querySelectorAll('.hand .card')].map(e => ({...rect(e), revealed: e.matches(':hover, :focus, .card--selected')})),
              heroes: [...document.querySelectorAll('.row__seat .bar')].map(rect).sort((a, b) => a.left - b.left),
              names: [...document.querySelectorAll('.enemy')].map(e => ({
                portrait: rect(e.querySelector('.enemy__portrait')), name: rect(e.querySelector('.enemy__head')),
                health: rect(e.querySelector('.bar')),
              })),
              enemies: [...document.querySelectorAll('.enemy .bar')].map(rect).sort((a, b) => a.left - b.left) }
          })
          const floor = geometry.shell.bottom
          assert(geometry.cards.every(card => card.top >= geometry.hand.top - 1 &&
            (card.revealed ? card.bottom <= floor + 1 :
              (floor - card.top) / card.height > .4 && (floor - card.top) / card.height < .85)),
          `${label}: hand recess/reveal bounds ${JSON.stringify(geometry)}`)
          assert(geometry.cards.filter(card => card.revealed).every(card =>
            card.right <= geometry.endTurn.left || card.left >= geometry.endTurn.right ||
            card.bottom <= geometry.endTurn.top || card.top >= geometry.endTurn.bottom),
          `${label}: End Turn obscures a revealed card ${JSON.stringify(geometry)}`)
          assert(geometry.scrollHeight <= geometry.clientHeight + 1 && geometry.scrollTop === 0,
            `${label}: hidden vertical hand overflow ${JSON.stringify(geometry)}`)
          assert(geometry.orbs.every(orbs => orbs.top >= geometry.board.top - 1), `${label}: upper Orb controls clipped ${JSON.stringify(geometry)}`)
          assert(geometry.names.every(({ portrait, name, health }) =>
            portrait.bottom <= name.top + 1 && name.bottom <= health.top - 1), `${label}: enemy name overlaps art or HP ${JSON.stringify(geometry)}`)
          assert(geometry.heroes.every(hero => Math.abs(hero.top - geometry.enemies[0].top) < 1), `${label}: HP baselines differ ${JSON.stringify(geometry)}`)
          assert(geometry.statuses.length > 0 && geometry.statuses.every(r => r.top >= geometry.board.top - 1 && r.bottom <= geometry.board.bottom + 1), `${label}: status controls clipped ${JSON.stringify(geometry)}`)
          if (geometry.heroes.length === 2) {
            const gap = bars => bars[1].left - bars[0].right
            assert(Math.abs(gap(geometry.heroes) - gap(geometry.enemies)) < 1,
              `${label}: enemy HP spacing differs from heroes`)
          }
          if (geometry.heroes.length === 1) {
            const hero = geometry.heroes[0], front = geometry.enemies[0]
            assert(hero.left > geometry.board.left + geometry.board.width * .15,
              `${label}: sparse party remains pinned to the screen edge`)
            assert(front.left - hero.right < hero.width * 2,
              `${label}: opposing actors are farther apart than one actor width`)
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
          combat.combat.players.forEach((player, i) => { player.block = 3; player.strength = 2; player.powers = [{ uid: `status-power-${i}`, defId: 'the_bomb', upgraded: true, counter: 2 }] })
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
          await page.waitForTimeout(1000)
          await check(`party-${partySize}-focused`)
          await card.evaluate(e => e.blur())
          await toolbar.evaluate(e => e.remove())
          await page.waitForTimeout(1000)
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
        const first = page.locator('.hand .card').first()
        const bounds = await first.boundingBox()
        if (phone) {
          // WebKit's touchscreen coordinates are visual pixels, unlike DOM rectangles.
          const point = await first.evaluate((e, webkit) => {
            const r = e.getBoundingClientRect(), v = visualViewport
            return { x: (r.x + r.width / 2 - (webkit ? v.offsetLeft : 0)) * (webkit ? v.scale : 1),
              y: (r.y + r.height * .25 - (webkit ? v.offsetTop : 0)) * (webkit ? v.scale : 1) }
          }, engineName === 'webkit')
          await page.touchscreen.tap(point.x, point.y)
        }
        else await first.hover({ position: { x: bounds.width / 2, y: bounds.height * .25 } })
        await check(phone ? 'touch-selected' : 'hovered')
        assert(await first.evaluate(e => e.getBoundingClientRect().bottom <=
          document.querySelector('.app-shell').getBoundingClientRect().bottom + 1), 'active card must be fully revealed')
        await page.mouse.move(1, 1)
        await page.evaluate(() => {
          const run = structuredClone(window.__STS_DEBUG__.getRun())
          const player = run.combat.players.find(p => p.character === 'ironclad'), template = player.hand[0]
          player.hand = Array.from({ length: 20 }, (_, i) => ({ ...template, uid: `large-hand-${i}` }))
          window.__STS_DEBUG__.setRun(run)
        })
        await ready()
        assert.equal(await page.locator('.hand .card').count(), 20)
        await page.locator('.hand .card').last().focus()
        await check('large-hand-focused')
        assert(await page.locator('.hand-scroll').evaluate(e => e.scrollLeft > 0), 'last card must scroll into view horizontally')
        const scroller = page.locator('.hand-scroll')
        const handCount = await page.locator('.hand .card').count()
        for (const [startAtEnd, direction] of [[true, 1], [false, -1]]) {
          await scroller.evaluate((e, end) => { e.scrollLeft = end ? e.scrollWidth : 0 }, startAtEnd)
          await page.locator('.hand .card:focus').evaluateAll(cards => cards.forEach(card => card.blur()))
          await page.mouse.move(1, 1)
          await page.waitForTimeout(200)
          const card = startAtEnd ? page.locator('.hand .card').last() : page.locator('.hand .card').first()
          const r = await card.boundingBox()
          const before = await scroller.evaluate(e => e.scrollLeft)
          const x = r.x + r.width * (startAtEnd ? .25 : .75), y = r.y + r.height * .25
          await page.mouse.move(x, y)
          await page.mouse.down()
          await page.mouse.move(x + direction * 120, y, { steps: 12 })
          await page.mouse.up()
          const after = await scroller.evaluate(e => e.scrollLeft)
          assert(direction === 1 ? after < before - 60 : after > before + 60,
            `held-mouse hand pan failed: ${before} -> ${after}`)
          assert.equal(await page.locator('.hand .card').count(), handCount, 'horizontal panning played a card')
          assert.equal(await page.locator('.card-drag').count(), 0, 'panning left a card drag active')
        }
        assert.deepEqual(errors, [])
        await context.close()
        console.log(`${engineName}/${screen}: hand bounds, toolbar resize, focus, resume and actor spacing passed`)
      }
    } finally { await browser.close() }
  }
} finally { await server.close() }
