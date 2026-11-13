import { strict as assert } from 'node:assert'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { preview } from 'vite'
import { chromium, devices, webkit } from './lib/profile-browser.mjs'
import { postNeowRun } from './lib/post-neow-run.mjs'
import { enterRoom } from '../src/game/run.ts'

const root = resolve(import.meta.dirname, '..')
const out = resolve(root, 'artifacts/combat-hand-viewport')
mkdirSync(out, { recursive: true })
// Use the shipping build: development JSX bookkeeping is not an input-performance budget.
const server = await preview({ root, logLevel: 'silent', preview: { port: 0 } })
try {
  for (const [engineName, engine] of Object.entries({ chromium, webkit })) {
    if (process.argv.includes('--webkit-only') && engineName !== 'webkit') continue
    const browser = await engine.launch()
    let hardwareCompositing = false
    if (engineName === 'chromium') {
      const system = await browser.newBrowserCDPSession()
      const { gpu } = await system.send('SystemInfo.getInfo')
      hardwareCompositing = gpu.featureStatus.gpu_compositing === 'enabled'
      console.log(`Chromium compositor: ${gpu.featureStatus.gpu_compositing}`)
      await system.detach()
    }
    try {
      for (const [screen, viewport] of [['desktop', { width: 1280, height: 720 }],
        ['horizontal-phone', { width: 844, height: 390 }]]) {
        if (process.argv.includes('--phone-only') && screen !== 'horizontal-phone') continue
        const phone = screen === 'horizontal-phone'
        // Linux WebKit software rasterization at DPR 3 can starve menu input; keep phone CSS geometry at DPR 1.
        const phoneOptions = { ...devices[engineName === 'chromium' ? 'Pixel 7 landscape' : 'iPhone 13 landscape'],
          ...(engineName === 'webkit' && process.platform === 'linux' ? { deviceScaleFactor: 1 } : {}) }
        const context = await browser.newContext(phone ? phoneOptions : { viewport })
        const page = await context.newPage()
        const errors = []
        page.on('pageerror', error => errors.push(String(error)))
        const tap = async (locator, height = .5) => {
          await locator.click({ trial: true })
          // WebKit touch events use visual pixels; DOM rectangles use layout pixels.
          const point = await locator.evaluate((element, { webkit, height }) => {
            const r = element.getBoundingClientRect(), v = visualViewport
            return { x: (r.x + r.width / 2 - (webkit ? v.offsetLeft : 0)) * (webkit ? v.scale : 1),
              y: (r.y + r.height * height - (webkit ? v.offsetTop : 0)) * (webkit ? v.scale : 1) }
          }, { webkit: engineName === 'webkit', height })
          await page.touchscreen.tap(point.x, point.y)
        }
        await page.goto(`http://localhost:${server.httpServer.address().port}`)
        for (const name of ['Single Player', 'Standard', 'Embark', 'Start standard campaign'])
          if (phone) await tap(page.getByRole('button', { name, exact: true }))
          else await page.getByRole('button', { name, exact: true }).click()
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
            const handArea = document.querySelector('.hand-area')
            const shell = document.querySelector('.app-shell')
            const board = document.querySelector('.board')
            return { shell: rect(shell), hand: rect(hand), handArea: rect(handArea), board: rect(board), endTurn: rect(document.querySelector('.combat__end-turn')), scrollTop: hand.scrollTop,
              orbs: [...board.querySelectorAll('.orbs')].map(rect),
              statuses: [...board.querySelectorAll('.seat__status-strip .token, .seat__status-strip .power, .seat__status-strip .power__counter, .enemy .tokens .token')].map(rect),
              cards: [...document.querySelectorAll('.hand .card')].map(e => ({...rect(e), revealed: e.matches(':hover, :focus, .card--selected')})),
              heroes: [...document.querySelectorAll('.row__seat .bar')].map(rect).sort((a, b) => a.left - b.left),
              names: [...document.querySelectorAll('.enemy')].map(e => ({
                portrait: rect(e.querySelector('.enemy__portrait')), name: rect(e.querySelector('.enemy__head')),
                health: rect(e.querySelector('.bar')),
              })),
              enemies: [...document.querySelectorAll('.enemy .bar')].map(rect).sort((a, b) => a.left - b.left) }
          })
          assert(geometry.cards.every(card =>
            card.top >= geometry.hand.top - 1 && card.bottom <= geometry.handArea.bottom + 1),
          `${label}: hand card leaves its reserved area ${JSON.stringify(geometry)}`)
          assert([geometry.cards[0], geometry.cards.at(-1)].filter(card => !card.revealed)
            .every(card => Math.abs(card.bottom - geometry.shell.bottom) <= 16),
          `${label}: resting outer card does not touch the screen edge ${JSON.stringify(geometry)}`)
          assert(geometry.cards.filter(card => card.revealed).every(card =>
            card.right <= geometry.endTurn.left || card.left >= geometry.endTurn.right ||
            card.bottom <= geometry.endTurn.top || card.top >= geometry.endTurn.bottom),
          `${label}: End Turn obscures a revealed card ${JSON.stringify(geometry)}`)
          assert(geometry.scrollTop === 0, `${label}: vertical hand scroll ${JSON.stringify(geometry)}`)
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
            if (front.left - hero.right > hero.width * 2 + 4) await page.screenshot({ path: resolve(out, `${engineName}-${screen}-${label}-gap-failure.png`) })
            assert(front.left - hero.right <= hero.width * 2 + 4,
              `${label}: opposing actors are farther apart than two actor widths ${JSON.stringify(geometry)}`)
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
        await page.evaluate(() => {
          const run = structuredClone(window.__STS_DEBUG__.getRun())
          const player = run.combat.players.find(p => p.character === 'ironclad')
          window.__testHand = player.hand
          player.hand = player.hand.slice(0, 1)
          window.__STS_DEBUG__.setRun(run)
        })
        await check('single-card')
        await page.evaluate(() => {
          const run = structuredClone(window.__STS_DEBUG__.getRun())
          run.combat.players.find(p => p.character === 'ironclad').hand = window.__testHand
          window.__STS_DEBUG__.setRun(run)
        })
        await ready()
        const first = page.locator('.hand .card').first()
        const bounds = await first.boundingBox()
        if (phone) await tap(first, .25)
        else await first.hover({ position: { x: bounds.width / 2, y: bounds.height * .25 } })
        await check(phone ? 'touch-selected' : 'hovered')
        assert(await first.evaluate(e => e.getBoundingClientRect().bottom <=
          document.querySelector('.app-shell').getBoundingClientRect().bottom + 1), 'active card must be fully revealed')
        if (engineName === 'chromium') await page.waitForFunction(() => {
          const media = [...document.querySelectorAll('.seat__portrait > :is(img, video), .enemy__art--cutout')]
          return media.length === 4 && media.every(video => video instanceof HTMLVideoElement &&
            video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && !video.paused && !video.style.backgroundImage)
        })
        if (!phone) {
          const card = page.locator('.hand .card[data-card-name="Strike"]').first()
          const [box, target] = await Promise.all([
            card.boundingBox(), page.locator('.enemy').last().locator('.enemy__hit-area').boundingBox(),
          ])
          assert(box && target, `${engineName}: desktop drag card or target is not visible`)
          const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
          await page.mouse.move(point.x, point.y)
          await page.mouse.down()
          await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 8 })
          const preview = page.locator('.card-drag')
          await preview.waitFor()
          const dragGeometry = await preview.evaluate(element => {
            const rect = element.getBoundingClientRect()
            const arrow = document.querySelector('.card-target-arrow__line')
            const end = arrow?.getPointAtLength(arrow.getTotalLength())
            const arrowStyle = arrow && getComputedStyle(arrow)
            const cardStyle = getComputedStyle(element)
            return { cardX: rect.x + rect.width / 2, cardWidth: rect.width, arrowX: end?.x,
              arrowStroke: arrowStyle?.stroke, arrowVisibility: arrowStyle?.visibility,
              cardFilter: cardStyle.filter, cardShadow: cardStyle.boxShadow }
          })
          assert(Math.abs(dragGeometry.cardX - point.x) < 2 && dragGeometry.cardWidth <= await card.evaluate(e => e.offsetWidth * 1.4) &&
            dragGeometry.arrowX > point.x + 90 &&
            dragGeometry.arrowStroke !== 'none' && dragGeometry.arrowVisibility === 'visible' &&
            dragGeometry.cardFilter.includes('drop-shadow') && dragGeometry.cardShadow === 'none',
            `${engineName}: desktop card followed the cursor or lost its targeting arrow ${JSON.stringify(dragGeometry)}`)
          await page.screenshot({ path: resolve(out, `${engineName}-desktop-anchored-card-drag.png`) })
          await page.mouse.up()
          await preview.waitFor({ state: 'detached' })
        }
        await page.mouse.move(1, 1)
        if (phone) {
          const card = page.locator('.hand .card[data-card-name="Strike"]').first()
          const [box, target] = await Promise.all([
            card.boundingBox(), page.locator('.enemy').last().locator('.enemy__hit-area').boundingBox(),
          ])
          assert(box && target, `${engineName}: touch drag card or target is not visible`)
          const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
          const targetPoint = { x: target.x + target.width / 2, y: target.y + target.height / 2 }
          const cdp = engineName === 'chromium' ? await context.newCDPSession(page) : null
          if (cdp) await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchStart', touchPoints: [{ ...point, id: 1, radiusX: 1, radiusY: 1 }],
          })
          else { await page.mouse.move(point.x, point.y); await page.mouse.down() }
          const moved = { x: point.x, y: point.y - 60 }
          await page.evaluate(() => {
            window.__dragFrames = []
            window.__dragLongTasks = []
            window.__dragScripts = []
            window.__dragMoveCount = 0
            window.__dragMoveListener = event => { if (event.pointerType === 'touch') window.__dragMoveCount++ }
            document.addEventListener('pointermove', window.__dragMoveListener, true)
            window.__dragScriptObserver = new PerformanceObserver(list => {
              for (const frame of list.getEntries()) for (const script of frame.scripts)
                if (script.startTime >= window.__dragStarted) window.__dragScripts.push(script.duration)
            })
            if (PerformanceObserver.supportedEntryTypes.includes('long-animation-frame')) window.__dragScriptObserver.observe({ type: 'long-animation-frame' })
            window.__dragRunning = true
            window.__dragStarted = performance.now()
            const observer = new PerformanceObserver(list => {
              window.__dragLongTasks.push(...list.getEntries().map(entry => ({
                start: entry.startTime - window.__dragStarted,
                duration: entry.duration,
              })))
            })
            try { observer.observe({ type: 'longtask' }) } catch {}
            window.__dragObserver = observer
            let previous = performance.now()
            requestAnimationFrame(function sample(now) {
              if (!window.__dragRunning) return
              window.__dragFrames.push(now - previous)
              previous = now
              requestAnimationFrame(sample)
            })
          })
          if (cdp) await cdp.send('Performance.enable')
          const metricsBefore = cdp ? await cdp.send('Performance.getMetrics') : null
          if (cdp) await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove', touchPoints: [{ ...moved, id: 1, radiusX: 1, radiusY: 1 }],
          })
          else await page.mouse.move(moved.x, moved.y, { steps: 4 })
          const preview = page.locator('.card-drag')
          await preview.waitFor()
          const art = await preview.locator('.card__art').evaluate(image => ({
            complete: image.complete, width: image.naturalWidth, loading: image.loading,
            decoding: image.decoding, visibility: getComputedStyle(image).visibility,
            readyMs: performance.now() - window.__dragStarted,
          }))
          assert.deepEqual({ ...art, readyMs: 0 }, { complete: true, width: 448, loading: 'eager', decoding: 'sync', visibility: 'visible', readyMs: 0 },
            `${engineName}: touch drag exposed fallback art ${JSON.stringify(art)}`)
          assert(await page.evaluate(() => matchMedia('(pointer: coarse)').matches &&
            document.documentElement.dataset.mobilePerformance === 'true' && innerWidth >= 1280),
          `${engineName}: phone fixture missed the real coarse-pointer desktop viewport`)
          for (let step = 1; step <= 24; step += 1) {
            const progress = step / 24
            const next = {
              x: moved.x + (targetPoint.x - moved.x) * progress,
              y: moved.y + (targetPoint.y - moved.y) * progress - Math.sin(Math.PI * progress) * 30,
            }
            if (cdp) await cdp.send('Input.dispatchTouchEvent', {
              type: 'touchMove', touchPoints: [{ ...next, id: 1, radiusX: 1, radiusY: 1 }],
            })
            else await page.mouse.move(next.x, next.y)
            await page.waitForTimeout(16)
          }
          await page.locator('.enemy--targeted').waitFor()
          const dragVisual = await preview.evaluate(element => {
            const arrow = document.querySelector('.card-target-arrow__line')
            const style = getComputedStyle(element)
            const rect = element.getBoundingClientRect()
            const end = arrow?.getPointAtLength(arrow.getTotalLength())
            const arrowStyle = arrow && getComputedStyle(arrow)
            return {
              cardX: rect.x + rect.width / 2,
              cardWidth: rect.width,
              arrowX: end?.x,
              arrowAnimation: arrowStyle?.animationName ?? null,
              arrowFilter: arrowStyle?.filter ?? null,
              arrowStroke: arrowStyle?.stroke,
              arrowVisibility: arrowStyle?.visibility,
              targetVisible: Boolean(document.querySelector('.enemy--targeted')),
              cardFilter: style.filter,
              cardShadow: style.boxShadow,
            }
          })
          assert(Math.abs(dragVisual.cardX - point.x) < 2 && dragVisual.cardWidth <= await card.evaluate(e => e.offsetWidth * 1.4) &&
            dragVisual.arrowX > point.x + 90 &&
            dragVisual.arrowStroke !== 'none' && dragVisual.arrowVisibility === 'visible' && dragVisual.targetVisible,
            `${engineName}: phone card followed the cursor or lost its targeting arrow ${JSON.stringify(dragVisual)}`)
          assert.deepEqual({ animation: dragVisual.arrowAnimation, arrow: dragVisual.arrowFilter,
            card: dragVisual.cardFilter }, { animation: 'none', arrow: 'none', card: 'none' },
          `${engineName}: phone drag retained per-frame filter work ${JSON.stringify(dragVisual)}`)
          assert.notEqual(dragVisual.cardShadow, 'none', `${engineName}: phone drag lost its card shadow`)
          const metricsAfter = cdp ? await cdp.send('Performance.getMetrics') : null
          const dragPerformance = await page.evaluate(async () => {
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
            window.__dragRunning = false
            window.__dragObserver?.disconnect()
            window.__dragScriptObserver.disconnect()
            document.removeEventListener('pointermove', window.__dragMoveListener, true)
            const frames = window.__dragFrames.slice(1).sort((a, b) => a - b)
            return {
              moves: window.__dragMoveCount, maxScript: Math.max(0, ...window.__dragScripts),
              frames: frames.length,
              p95: frames[Math.floor(frames.length * .95)] ?? 0,
              max: frames.at(-1) ?? 0,
              longTasks: window.__dragLongTasks,
            }
          })
          dragPerformance.artReadyMs = art.readyMs
          if (metricsBefore && metricsAfter) {
            const before = Object.fromEntries(metricsBefore.metrics.map(metric => [metric.name, metric.value]))
            dragPerformance.metrics = Object.fromEntries(metricsAfter.metrics
              .filter(metric => ['LayoutDuration', 'RecalcStyleDuration', 'ScriptDuration', 'TaskDuration'].includes(metric.name))
              .map(metric => [metric.name, Math.round((metric.value - before[metric.name]) * 1000 * 100) / 100]))
          }
          if (cdp) await cdp.send('Performance.disable')
          console.log(`${engineName}: phone ${cdp ? 'CDP touch' : 'mouse fallback'} drag performance ${JSON.stringify(dragPerformance)}`)
          if (cdp) {
            assert(dragPerformance.moves >= 24, 'the touch trajectory did not run')
            if (hardwareCompositing) assert(dragPerformance.p95 < 35 && dragPerformance.max < 75,
              `Chromium GPU: touch drag stalled frames ${JSON.stringify(dragPerformance)}`)
            else {
              // Software alpha compositing is pixel-bound; keep the same 35 ms input-work budget.
              const work = dragPerformance.metrics
              const perMove = (work.ScriptDuration + work.RecalcStyleDuration + work.LayoutDuration) / dragPerformance.moves
              assert(perMove < 35 && dragPerformance.maxScript < 75,
                `Chromium software: touch input work stalled ${JSON.stringify({ perMove, ...dragPerformance })}`)
            }
          }
          await page.screenshot({ path: resolve(out, `${engineName}-horizontal-phone-touch-drag.png`) })
          if (cdp) {
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] })
            await cdp.detach()
          } else await page.mouse.up()
          await preview.waitFor({ state: 'detached' })
        }
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
} finally { await new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve())) }
