#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium, webkit } from './lib/profile-browser.mjs'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'artifacts/combat-target-geometry')
mkdirSync(output, { recursive: true })
const server = await createServer({ root, logLevel: 'silent', server: { port: 0 } })
await server.listen()
const errors = []
try {
  for (const [engineName, engine] of Object.entries({ chromium, webkit })) {
    const browser = await engine.launch({ headless: true })
    try {
      for (const [screen, viewport] of [['desktop', { width: 1440, height: 900 }], ['horizontal-phone', { width: 844, height: 390 }]]) {
        const phone = screen === 'horizontal-phone'
        const context = await browser.newContext({ viewport, isMobile: phone, hasTouch: phone,
          recordVideo: { dir: output, size: viewport } })
        const page = await context.newPage()
        page.on('pageerror', e => errors.push(String(e)))
        await page.goto(`http://localhost:${server.httpServer.address().port}`)
        await page.evaluate(async () => {
          document.querySelector('#root').style.display = 'none'
          document.documentElement.dataset.mobilePerformance = String(matchMedia('(pointer: coarse)').matches)
          document.documentElement.dataset.reducedMotion = 'false'
          const node = document.createElement('div')
          node.className = 'app-shell app-shell--combat sts-scope'
          node.style.gridTemplateRows = 'minmax(0, 1fr)'
          document.body.append(node)
          const [R, D, { CombatScreen }, { createPlayer }, C, { createRng }] = await Promise.all([
            import('/@id/react'), import('/@id/react-dom/client'), import('/src/ui/CombatScreen.tsx'),
            import('/src/game/run.ts'), import('/src/game/combat.ts'), import('/src/game/rng.ts'),
            import('/src/ui/styles.css'), import('/src/ui/chrome.css'),
          ])
          const reactRoot = (D.createRoot ?? D.default.createRoot)(node)
          const f = window.fixture = { restoration: 0, seq: 0 }
          f.render = () => reactRoot.render((R.createElement ?? R.default.createElement)(CombatScreen, {
            key: f.seq, state: structuredClone(f.state), act: 3, viewerId: 'p1', autoAdvance: false,
            authoritativeRestoration: f.restoration, onChange: state => { f.state = state; f.render() },
          }))
          f.install = (defs, stormOrb, partySize = 1) => {
            const rng = createRng(47), player = createPlayer(rng, 'p1', 'Defect', 'defect', 0)
            Object.assign(player, { hp: 8, maxHp: 8, relics: [], draw: [], discard: [],
              hand: [{ uid: 'strike', defId: 'strike_defect', upgraded: false }],
              orbs: stormOrb === 'dark' ? ['dark', 'dark', 'frost'] : ['lightning', 'frost', 'frost'],
              powers: stormOrb ? [{ uid: 'storm', defId: 'storm', upgraded: true }] : [] })
            const party = [player, ...Array.from({ length: partySize - 1 }, (_, i) => {
              const ally = createPlayer(rng, `p${i + 2}`, `Ally ${i + 1}`, 'ironclad', 0)
              Object.assign(ally, { row: i + 1, relics: [], hand: [], draw: [], powers: [] })
              return ally
            })]
            f.state = C.createCombat(rng, party, defs.map((defId, i) => ({ uid: `enemy-${i}`, defId, row: 0,
              isBoss: ['donu', 'deca', 'bronze_automaton', 'the_champ'].includes(defId), hp: 50, maxHp: 50, block: 0, strength: 0,
              weak: 0, vulnerable: 0, poison: 0, actionIndex: 0, abilityUsed: false, dead: false })))
            f.state.die = 1; f.state.phase = 'player'; f.state.presentationEvents = []
            if (stormOrb) { f.state.phase = 'roundEnd'; f.state.turn = 1; f.state = C.preparePlayerTurn(f.state) }
            f.seq += 100; f.state.combatId = String(f.seq); f.restoration++; f.render()
          }
          // Independent full-resolution alpha bounds, used to click visible bodies,
          // not the DOM hit areas that this test is meant to verify.
          f.bounds = image => {
            const canvas = document.createElement('canvas')
            canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
            const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0)
            const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data
            let left = canvas.width, right = 0, top = canvas.height, bottom = 0
            for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3] > 96) {
              const x = i / 4 % canvas.width, y = Math.floor(i / 4 / canvas.width)
              left = Math.min(left, x); right = Math.max(right, x + 1)
              top = Math.min(top, y); bottom = Math.max(bottom, y + 1)
            }
            const r = image.getBoundingClientRect()
            const fit = Math.min(r.width / canvas.width, r.height / canvas.height)
            return { left: r.left + (r.width - canvas.width * fit) / 2 + left * fit,
              top: r.bottom - (canvas.height - top) * fit, width: (right - left) * fit, height: (bottom - top) * fit }
          }
        })
        const ready = async () => {
          await page.waitForTimeout(100)
          await page.waitForFunction(() => document.querySelector('.enemy') &&
            [...document.querySelectorAll('.enemy__art--cutout,.seat__portrait > img')].every(i => i.complete && i.naturalWidth))
          await page.waitForTimeout(120)
          await page.waitForFunction(() => !document.querySelector('.combat').getAnimations().some(a => a.playState === 'running'))
        }
        // WebKit touch coordinates include the app's visual viewport scale.
        const tap = async locator => {
          const point = await locator.evaluate((element, webkit) => {
            const r = element.getBoundingClientRect(), v = window.visualViewport
            return { x: (r.x + r.width / 2 - (webkit ? v.offsetLeft : 0)) * (webkit ? v.scale : 1),
              y: (r.y + r.height / 2 - (webkit ? v.offsetTop : 0)) * (webkit ? v.scale : 1) }
          }, engineName === 'webkit')
          await page.touchscreen.tap(point.x, point.y)
        }
        const bodyPoint = async id => page.evaluate(id => {
          const b = window.fixture.bounds(document.querySelector(`[data-enemy-id="${id}"] .enemy__art--cutout`))
          return { x: b.left + b.width / 2, y: b.top + b.height * .6 }
        }, id)
        for (const defs of [['deca', 'donu'], ['donu', 'deca'], ['taskmaster', 'red_slaver', 'blue_slaver'], ['sentry_a', 'sentry_b', 'sentry_a']]) {
          await page.evaluate(defs => window.fixture.install(defs), defs)
          await ready()
          assert(await page.locator('.enemy').evaluateAll(enemies => enemies.every(e => getComputedStyle(e).pointerEvents === 'none')), 'empty button rectangles must not intercept neighbours')
          for (let i = 0; i < defs.length; i++) {
            const id = `enemy-${i}`, p = await bodyPoint(id)
            assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('.enemy')?.dataset.enemyId, p), id,
              `${engineName}/${screen}: ${defs[i]} body targets its neighbour`)
            for (const selector of ['.enemy__head', '.bar']) {
              const hud = page.locator(`[data-enemy-id="${id}"] ${selector}`)
              assert.equal(await hud.evaluate(e => { const r = e.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('.enemy')?.dataset.enemyId }), id)
            }
          }
          await page.locator('.board').screenshot({ path: resolve(output, `${engineName}-${screen}-${defs.join('-')}.png`) })
        }
        // Tall boss hit areas must stay behind the shared Orb choice prompt.
        for (const boss of ['bronze_automaton', 'the_champ']) {
          await page.evaluate(boss => window.fixture.install([boss], 'dark'), boss)
          await ready()
          const choice = page.getByRole('button', { name: 'frost slot 3', exact: true })
          await choice.waitFor()
          assert(await page.locator('.prompt__orb').evaluateAll(buttons => buttons.every(button => {
            const r = button.getBoundingClientRect()
            return button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
          })), `${engineName}/${screen}/${boss}: boss intercepts Orb choice`)
          await page.screenshot({ path: resolve(output, `${engineName}-${screen}-${boss}-orb-choice.png`) })
          if (phone) await tap(choice); else await choice.click()
          await choice.waitFor({ state: 'detached' })
        }
        await page.evaluate(() => {
          window.fixture.install(['bronze_automaton'])
          window.fixture.state.players[0].hand = [{ uid: 'dual', defId: 'dual_cast', upgraded: false }]
          window.fixture.render()
        })
        await ready()
        const dual = page.locator('.hand .card').first()
        if (phone) { await tap(dual); await tap(dual) } else await dual.click()
        await page.locator('.prompt__orb').first().waitFor()
        assert(await page.locator('.prompt__orb').evaluateAll(buttons => buttons.every(button => {
          const r = button.getBoundingClientRect()
          return button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
        })), `${engineName}/${screen}: boss intercepts Dual Cast Orb choice`)
        await page.screenshot({ path: resolve(output, `${engineName}-${screen}-dual-cast-orb-choice.png`) })
        // Stress the same stacking boundary when a tall boss's transparent
        // hit region overhangs the choice panel, independent of asset poses.
        await page.locator('.prompt').evaluate(prompt => {
          const hit = document.querySelector('.enemy__hit-area').getBoundingClientRect()
          const combat = document.querySelector('.combat').getBoundingClientRect()
          const button = prompt.querySelectorAll('.prompt__orb')[1].getBoundingClientRect()
          const panel = prompt.getBoundingClientRect()
          prompt.style.left = `${hit.x + hit.width / 2 - combat.x - (button.x + button.width / 2 - panel.x)}px`
          prompt.style.top = `${hit.y + hit.height / 2 - combat.y - (button.y + button.height / 2 - panel.y)}px`
          prompt.style.transform = 'none'
        })
        assert(await page.locator('.prompt__orb').evaluateAll(buttons => buttons.every(button => {
          const r = button.getBoundingClientRect()
          return button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
        })), `${engineName}/${screen}: boss overhang intercepts the shared prompt`)
        const frost = page.getByRole('button', { name: 'frost slot 2', exact: true })
        if (phone) await tap(frost); else await frost.click()
        await page.waitForFunction(() => window.fixture.state.players[0].block > 0)
        // Boss size remains visibly larger than the hero, with hit areas following
        // changes in the artwork's height when a desktop window is resized.
        await page.evaluate(() => window.fixture.install(['deca', 'donu']))
        await ready()
        assert(await page.evaluate(() => {
          const f = window.fixture, hero = f.bounds(document.querySelector('.seat__portrait > img'))
          return [...document.querySelectorAll('.enemy__art--cutout')].every(i => f.bounds(i).height > hero.height * 1.35)
        }), 'bosses should remain larger than Defect')
        if (!phone) {
          await page.setViewportSize({ width: 844, height: 390 })
          await ready()
          const p = await bodyPoint('enemy-1')
          assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('.enemy')?.dataset.enemyId, p), 'enemy-1')
          await page.setViewportSize(viewport)
          await ready()
        }
        // A real Strike must damage the visible enemy for both clicks and drags.
        for (const [target, drag] of [['enemy-1', false], ['enemy-0', true]]) {
          await page.evaluate(() => window.fixture.install(['deca', 'donu']))
          await ready()
          const p = await bodyPoint(target), card = page.locator('.hand .card').first()
          if (drag) {
            const r = await card.boundingBox()
            await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2)
            await page.mouse.down(); await page.mouse.move(p.x, p.y, { steps: 12 }); await page.mouse.up()
          } else { await card.click(); await page.mouse.click(p.x, p.y) }
          await page.waitForFunction(target => window.fixture.state.enemies.find(e => e.uid === target).hp < 50, target)
          assert.equal(await page.evaluate(target => window.fixture.state.enemies.find(e => e.uid !== target).hp, target), 50)
        }
        // Moving rules into hover help must keep both ordinary and elite
        // portraits targetable without an inline rule label consuming clicks.
        for (const defId of ['green_louse', 'gremlin_nob']) {
          await page.evaluate(defId => window.fixture.install([defId, 'jaw_worm']), defId)
          await ready()
          await page.locator('.hand .card').first().click()
          await page.locator('[data-enemy-id="enemy-0"] .enemy__head').click()
          await page.waitForFunction(() => window.fixture.state.enemies[0].hp < 50)
          assert.equal(await page.evaluate(() => window.fixture.state.enemies[1].hp), 50)
        }
        // The native enemy button remains keyboard operable.
        await page.evaluate(() => window.fixture.install(['deca', 'donu']))
        await ready()
        await page.locator('.hand .card').first().click()
        await page.locator('[data-enemy-id="enemy-1"]').focus()
        await page.keyboard.press('Enter')
        await page.waitForFunction(() => window.fixture.state.enemies[1].hp < 50)
        // Preserve a usable hit target with static (reduced-motion) art too.
        await page.evaluate(() => { document.documentElement.dataset.reducedMotion = 'true'; window.fixture.install(['deca', 'donu']) })
        await ready()
        const staticPoint = await bodyPoint('enemy-1')
        await page.locator('.hand .card').first().click(); await page.mouse.click(staticPoint.x, staticPoint.y)
        await page.waitForFunction(() => window.fixture.state.enemies[1].hp < 50)
        await page.evaluate(() => { document.documentElement.dataset.reducedMotion = 'false' })

        // Prismatic Shard can give other heroes Orbs; Defect's short-body
        // anchor must not pull those controls into a taller character's head.
        await page.evaluate(() => {
          window.fixture.install(['jaw_worm'])
          window.fixture.state.players[0].character = 'hermit'
          window.fixture.render()
        })
        await ready()
        assert(await page.evaluate(() => {
          const seat = document.querySelector('.seat__interactive[data-character="hermit"]')
          const head = window.fixture.bounds(seat.querySelector('.seat__portrait > img')).top
          const orbs = [...seat.querySelectorAll('.token--orb')]
          return orbs.length === 3 && orbs.every(orb => orb.getBoundingClientRect().bottom < head)
        }), `${engineName}/${screen}: borrowed Orbs overlap Hermit's head`)
        await page.screenshot({ path: resolve(output, `${engineName}-${screen}-hermit-orbs.png`) })

        for (const partySize of [1, 4]) for (const orb of ['lightning', 'dark']) {
          await page.evaluate(({ orb, partySize }) => window.fixture.install(['jaw_worm'], orb, partySize), { orb, partySize })
          await ready()
          await page.locator('.seat__interactive[data-character="defect"] > .orbs').waitFor()
          const orbGap = await page.evaluate(() => {
            const seat = document.querySelector('.seat__interactive:has(> .orbs)')
            const image = seat.querySelector('.seat__portrait > img')
            const paintedTop = window.fixture.bounds(image).top
            const lowestOrb = Math.max(...[...seat.querySelectorAll('.token--orb')].map(el => el.getBoundingClientRect().bottom))
            return (paintedTop - lowestOrb) / parseFloat(getComputedStyle(document.documentElement).fontSize)
          })
          assert(orbGap >= 0 && orbGap < 4, `${engineName}/${screen}/party${partySize}: Orbs too far from Defect: ${orbGap}rem`)
          await page.screenshot({ path: resolve(output, `${engineName}-${screen}-orbs-${partySize}.png`) })
          for (let i = 0; i < 2; i++) {
            await page.getByRole('button', { name: `${orb} slot ${orb === 'dark' ? i + 1 : 1}`, exact: true }).click()
            await page.locator('.enemy__head').click()
          }
          // Commit the last local target choice before injecting another render.
          await page.waitForFunction(() => document.querySelector('.combat__end-turn')?.disabled === false)
          // A preceding attack expires 2310ms after arrival. Resolve the real
          // Storm+ choices while it recovers, so idle remounts during the beam.
          await page.evaluate(() => {
            const f = window.fixture
            f.state.presentationEvents.push({ seq: f.seq, kind: 'card', actorId: 'p1', sourceId: 'strike_defect',
              enemyIds: ['enemy-0'], playerIds: [], upgraded: false, copied: false, energy: 1 })
            f.render()
          })
          await page.locator('.character-attack').waitFor({ state: 'attached' })
          await page.waitForTimeout(2000)
          const resolveStart = page.getByRole('button', { name: 'Resolve start of turn', exact: true })
          assert((await resolveStart.evaluate(e => getComputedStyle(e).clipPath)).includes('16px'))
          assert((await resolveStart.evaluate(e => getComputedStyle(e).transition)).includes('0.24s'))
          await page.screenshot({ path: resolve(output, `${engineName}-${screen}-${orb}-${partySize}-resolve.png`) })
          await resolveStart.click()
          await page.waitForFunction(() => document.querySelectorAll('.defect-evoke__beam').length === 2)
          const events = await page.evaluate(() => window.fixture.state.presentationEvents.filter(e => e.sourceId === 'orb-evoke').map(e => e.orb))
          assert.deepEqual(events, [orb, orb])
          let sampledAfterRemount = false
          for (let sample = 0; sample < 8; sample++) {
            const beams = await page.evaluate(() => [...document.querySelectorAll('.defect-evoke')].map(e => {
              const art = e.closest('.seat__portrait').querySelector(':scope > img'), r = art.getBoundingClientRect()
              const fit = Math.min(r.width / art.naturalWidth, r.height / art.naturalHeight)
              const svg = e.querySelector('svg'), matrix = svg.getScreenCTM()
              const start = new DOMPoint(0, 20).matrixTransform(matrix)
              // WebKit's SVG screen matrix includes the mobile visual viewport
              // scale; DOM rectangles use layout pixels. Normalize to the latter.
              const corners = [[0, 0], [1000, 0], [0, 40], [1000, 40]].map(([x, y]) => new DOMPoint(x, y).matrixTransform(matrix))
              const xs = corners.map(p => p.x), ys = corners.map(p => p.y), box = svg.getBoundingClientRect()
              start.x = box.left + (start.x - Math.min(...xs)) * box.width / (Math.max(...xs) - Math.min(...xs))
              start.y = box.top + (start.y - Math.min(...ys)) * box.height / (Math.max(...ys) - Math.min(...ys))
              return { start: { x: start.x, y: start.y },
                mouth: { x: r.left + (r.width - art.naturalWidth * fit) / 2 + 222 * fit, y: r.bottom - (art.naturalHeight - 89) * fit },
                recovered: !document.querySelector('.character-attack') }
            }))
            assert.equal(beams.length, 2)
            for (const beam of beams) {
              assert(Math.hypot(beam.start.x - beam.mouth.x, beam.start.y - beam.mouth.y) < 1,
                `${engineName}/${screen}/party${partySize}/${orb}: rendered beam left Defect's mouth: ${JSON.stringify(beam)}`)
              sampledAfterRemount ||= beam.recovered
            }
            if (sample === 5) {
              await page.evaluate(() => document.querySelectorAll('.defect-evoke__beam').forEach(svg =>
                svg.getAnimations().forEach(a => { a.pause(); a.currentTime = 300 })))
              const shot = await page.locator('.board').screenshot({ path: resolve(output, `${engineName}-${screen}-storm-${orb}-party${partySize}.png`) })
              // Geometry can be correct while WebKit clips the painted beam at
              // an ancestor's filter. Check actual pixels halfway to the enemy.
              const painted = await page.evaluate(async ({ png, orb }) => {
                const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode()
                const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height
                const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0)
                const board = document.querySelector('.board').getBoundingClientRect()
                const ray = document.querySelector('.defect-evoke__ray').getBoundingClientRect()
                const x = Math.round((ray.left + ray.width / 2 - board.left) * image.width / board.width)
                const y = Math.round((ray.top + ray.height / 2 - board.top) * image.height / board.height)
                const pixels = ctx.getImageData(x - 8, y - 24, 16, 48).data
                let matches = 0
                for (let i = 0; i < pixels.length; i += 4) {
                  const [r, g, b] = pixels.slice(i, i + 3)
                  if (orb === 'dark' ? r > 130 && b > 140 && b > g * 1.2 : r > 200 && g > 185 && b > 120) matches++
                }
                return matches
              }, { png: shot.toString('base64'), orb })
              assert(painted > 10, `${engineName}/${screen}/party${partySize}/${orb}: beam is clipped before reaching the enemy`)
            }
            await page.waitForTimeout(70)
          }
          assert(sampledAfterRemount, 'test must sample a beam after the idle image remounts')
          await page.evaluate(() => { window.fixture.restoration++; window.fixture.render() })
          await page.waitForFunction(() => !document.querySelector('.defect-evoke'))
        }
        await context.close()
        await page.video().saveAs(resolve(output, `${engineName}-${screen}.webm`))
        console.log(`PASS ${engineName} ${screen}: painted targets, click/drag damage, static art, repeated Lightning/Dark and restoration`)
      }
    } finally { await browser.close() }
  }
  assert.deepEqual(errors, [])
} finally { await server.close() }
