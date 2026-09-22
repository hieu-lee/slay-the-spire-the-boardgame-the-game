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
    if (process.argv.includes('--webkit-only') && engineName !== 'webkit') continue
    const browser = await engine.launch({ headless: true })
    try {
      for (const [screen, viewport] of [['desktop', { width: 1440, height: 900 }],
        ['horizontal-phone', { width: 844, height: 390 }], ['small-horizontal-phone', { width: 568, height: 320 }]]) {
        const phone = screen !== 'desktop'
        const smallPhone = screen === 'small-horizontal-phone'
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
            key: f.seq, state: structuredClone(f.state), act: 3, viewerId: f.viewerId, autoAdvance: false,
            authoritativeRestoration: f.restoration, onChange: state => { f.state = state; f.render() },
          }))
          f.install = (defs, stormOrb, partySize = 1) => {
            f.viewerId = 'p1'
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
          f.size = image => image instanceof HTMLVideoElement
            ? { width: image.videoWidth, height: image.videoHeight }
            : { width: image.naturalWidth, height: image.naturalHeight }
          f.frame = async image => {
            if (!(image instanceof HTMLVideoElement)) return
            if (image.paused) await image.play()
            await Promise.race([
              new Promise(resolve => image.requestVideoFrameCallback(resolve)),
              new Promise(resolve => setTimeout(resolve, 1000)),
            ])
          }
          f.bounds = image => {
            const canvas = document.createElement('canvas')
            const size = f.size(image)
            if (!size.width || !size.height) {
              return (image.closest('.enemy__portrait')?.querySelector('.enemy__hit-area') ?? image).getBoundingClientRect()
            }
            canvas.width = size.width; canvas.height = size.height
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
          await page.waitForFunction(async () => {
            const media = [...document.querySelectorAll('.enemy__art--cutout,.seat__portrait > :is(img, video)')]
            const loaded = i => i instanceof HTMLVideoElement ? i.readyState >= 2 && i.videoWidth : i.complete && i.naturalWidth
            if (!document.querySelector('.enemy') || !media.length || !media.every(loaded)) return false
            // A disposed video will never deliver another frame. Use the
            // bounded helper, then retry against the currently mounted media.
            await Promise.all(media.filter(i => i instanceof HTMLVideoElement).map(window.fixture.frame))
            await new Promise(resolve => requestAnimationFrame(resolve))
            return media.every(i => i.isConnected && loaded(i))
          })
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
        const bodyPoint = async id => page.evaluate(async id => {
          const image = document.querySelector(`[data-enemy-id="${id}"] .enemy__art--cutout`)
          await window.fixture.frame(image)
          const b = window.fixture.bounds(image)
          return { x: b.left + b.width / 2, y: b.top + b.height * .6 }
        }, id)
        if (!smallPhone) for (const defs of [['deca', 'donu'], ['donu', 'deca'], ['taskmaster', 'red_slaver', 'blue_slaver'], ['sentry_a', 'sentry_b', 'sentry_a']]) {
          await page.evaluate(defs => window.fixture.install(defs), defs)
          await ready()
          await page.waitForTimeout(320)
          assert(await page.locator('.enemy').evaluateAll(enemies => enemies.every(e => getComputedStyle(e).pointerEvents === 'none')), 'empty button rectangles must not intercept neighbours')
          for (let i = 0; i < defs.length; i++) {
            const id = `enemy-${i}`, p = await bodyPoint(id)
            const target = await page.evaluate(({ x, y, id }) => {
              const element = document.elementFromPoint(x, y)
              return { id: element?.closest('.enemy')?.dataset.enemyId, tag: element?.className, x, y,
                hit: document.querySelector(`[data-enemy-id="${id}"] .enemy__hit-area`)?.getBoundingClientRect().toJSON() }
            }, { ...p, id })
            assert.equal(target.id, id, `${engineName}/${screen}: ${defs[i]} body targets its neighbour ${JSON.stringify(target)}`)
            for (const selector of ['.enemy__head', '.bar']) {
              const hud = page.locator(`[data-enemy-id="${id}"] ${selector}`)
              assert.equal(await hud.evaluate(e => { const r = e.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('.enemy')?.dataset.enemyId }), id)
            }
          }
          await page.locator('.board').screenshot({ path: resolve(output, `${engineName}-${screen}-${defs.join('-')}.png`) })
        }
        // Tall boss hit areas must stay behind the shared Orb choice prompt.
        if (!smallPhone) for (const boss of ['bronze_automaton', 'the_champ']) {
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
          const f = window.fixture
          f.install(['jaw_worm'], undefined, 2)
          Object.assign(f.state.players[0], {
            hand: [],
            orbs: ['lightning', 'frost', 'dark', 'lightning'],
            powers: [{ uid: 'phone-loop', defId: 'loop', upgraded: true }],
          })
          f.render()
        })
        await ready()
        if (phone) await tap(page.getByRole('button', { name: 'End turn', exact: true }))
        else await page.getByRole('button', { name: 'End turn', exact: true }).click()
        const loopCard = page.locator('.end-turn-effect--card')
        await loopCard.waitFor()
        const loopChoices = page.getByRole('group', { name: /Choose an Orb for .*Loop/ })
        if (phone) {
          await page.evaluate(() => { window.fixture.viewerId = 'p2'; window.fixture.render() })
          await page.waitForFunction(() => document.querySelector('.end-turn-effects__prompt')?.textContent.includes('Waiting for'))
          assert.equal(await page.locator('.end-turn-effects__orb-choices').count(), 0,
            `${engineName}/${screen}: non-owner can see Loop Orb choices`)
          await page.evaluate(() => { window.fixture.viewerId = 'p1'; window.fixture.render() })
          await loopChoices.waitFor()
          await loopCard.evaluate(card => Promise.all(card.getAnimations().map(animation => animation.finished)))
          const cardBox = await loopCard.boundingBox(), choicesBox = await loopChoices.boundingBox()
          const visibleBottom = await page.evaluate(() =>
            (window.visualViewport?.offsetTop ?? 0) + (window.visualViewport?.height ?? innerHeight))
          assert(cardBox && choicesBox && choicesBox.y >= cardBox.y + cardBox.height - 1 &&
            choicesBox.y + choicesBox.height <= visibleBottom,
          `${engineName}/${screen}: Loop Orb choices are not visible below the card`)
          assert.deepEqual(await loopChoices.locator('.token--orb').evaluateAll(tokens => tokens.map(token => token.className)),
            ['token--orb token--orb-lightning', 'token--orb token--orb-frost', 'token--orb token--orb-dark'])
          assert(await loopChoices.locator('button').evaluateAll(buttons => buttons.every(button => {
            const style = getComputedStyle(button)
            return style.borderWidth === '0px' && style.backgroundImage === 'none' &&
              style.backgroundColor === 'rgba(0, 0, 0, 0)' && style.boxShadow === 'none' && style.clipPath === 'none'
          })), `${engineName}/${screen}: Loop Orb assets have visible button chrome`)
          assert(await loopChoices.locator('button').evaluateAll(buttons => buttons.every(button => {
            const box = button.getBoundingClientRect(), scale = window.visualViewport?.scale ?? 1
            return Math.min(box.width, box.height) * scale >= 44
          })), `${engineName}/${screen}: Loop Orb tap targets are smaller than 44 points`)
          await page.screenshot({ path: resolve(output, `${engineName}-${screen}-loop-orb-choices.png`) })
          await tap(page.getByRole('button', { name: 'Duplicate frost Orb effect' }))
          await tap(page.getByRole('button', { name: 'Duplicate lightning Orb effect' }))
          await loopCard.waitFor({ state: 'detached' })
        } else {
          assert.equal(await page.locator('.end-turn-effects__orb-choices:visible').count(), 0,
            'desktop must keep the existing Orb drag interaction')
        }
        if (smallPhone) {
          await context.close()
          console.log(`PASS ${engineName} ${screen}: Loop Orb choices`)
          continue
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
        const bossRatios = await page.evaluate(async () => {
          const f = window.fixture, heroArt = document.querySelector('.seat__portrait > :is(img, video)')
          const bosses = [...document.querySelectorAll('.enemy__art--cutout')]
          await Promise.all([heroArt, ...bosses].map(f.frame))
          const hero = f.bounds(heroArt)
          return bosses.map(i => f.bounds(i).height / hero.height)
        })
        assert(bossRatios.every(ratio => ratio > 1.35), `bosses should remain larger than Defect: ${bossRatios}`)
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
        assert(await page.evaluate(async () => {
          const seat = document.querySelector('.seat__interactive[data-character="hermit"]')
          const image = seat.querySelector('.seat__portrait > :is(img, video)')
          await window.fixture.frame(image)
          const head = window.fixture.bounds(image).top
          const orbs = [...seat.querySelectorAll('.token--orb')]
          return orbs.length === 3 && orbs.every(orb => orb.getBoundingClientRect().bottom < head)
        }), `${engineName}/${screen}: borrowed Orbs overlap Hermit's head`)
        await page.screenshot({ path: resolve(output, `${engineName}-${screen}-hermit-orbs.png`) })

        for (const partySize of [1, 4]) for (const orb of ['lightning', 'dark']) {
          await page.evaluate(({ orb, partySize }) => window.fixture.install(['jaw_worm'], orb, partySize), { orb, partySize })
          await ready()
          await page.locator('.seat__interactive[data-character="defect"] > .orbs').waitFor()
          const orbGap = await page.evaluate(async () => {
            const seat = document.querySelector('.seat__interactive[data-character="defect"]')
            const image = seat.querySelector('.seat__portrait > :is(img, video)')
            await window.fixture.frame(image)
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
          // Resolve real Storm+ choices during attack recovery. The idle media
          // stays mounted now; verify its identity separately from the short
          // beam lifetime instead of racing two independent presentation clocks.
          const idlePortrait = await page.locator('.seat__interactive[data-character="defect"] .seat__portrait > :is(img, video)').elementHandle()
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
          const geometry = await page.waitForFunction(() => {
            const seat = document.querySelector('.seat:has(.defect-evoke)')
            if (!seat || document.querySelectorAll('.defect-evoke__beam').length !== 2) return false
            const beams = [...document.querySelectorAll('.defect-evoke')].map(e => {
              const art = e.closest('.seat__portrait').querySelector(':scope > :is(img, video)'), r = art.getBoundingClientRect()
              const size = window.fixture.size(art)
              if (!size.width || !size.height) return null
              const fit = Math.min(r.width / size.width, r.height / size.height)
              const sourceScale = size.width / 400
              const svg = e.querySelector('svg'), matrix = svg.getScreenCTM()
              const start = new DOMPoint(0, 20).matrixTransform(matrix)
              // WebKit's SVG screen matrix includes the mobile visual viewport
              // scale; DOM rectangles use layout pixels. Normalize to the latter.
              const corners = [[0, 0], [1000, 0], [0, 40], [1000, 40]].map(([x, y]) => new DOMPoint(x, y).matrixTransform(matrix))
              const xs = corners.map(p => p.x), ys = corners.map(p => p.y), box = svg.getBoundingClientRect()
              start.x = box.left + (start.x - Math.min(...xs)) * box.width / (Math.max(...xs) - Math.min(...xs))
              start.y = box.top + (start.y - Math.min(...ys)) * box.height / (Math.max(...ys) - Math.min(...ys))
              return { start: { x: start.x, y: start.y },
                mouth: { x: r.left + (r.width - size.width * fit) / 2 + 222 * sourceScale * fit,
                  y: r.bottom - (size.height - 89 * sourceScale) * fit } }
            })
            if (beams.some(beam => !beam)) return false
            document.querySelectorAll('.defect-evoke--test-clone').forEach(clone => clone.remove())
            document.querySelectorAll('.defect-evoke').forEach(effect => {
              const rect = effect.getBoundingClientRect(), clone = effect.cloneNode(true)
              clone.classList.add('defect-evoke--test-clone')
              Object.assign(clone.style, { position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`, zIndex: 999 })
              clone.querySelectorAll('.defect-evoke__beam').forEach(svg => {
                svg.style.animation = 'none'; svg.style.opacity = '1'; svg.style.scale = '1 1'
              })
              document.body.append(clone)
            })
            return { beams,
              ray: document.querySelector('.defect-evoke--test-clone .defect-evoke__ray').getBoundingClientRect().toJSON(),
              seatFilter: getComputedStyle(seat).filter }
          })
          const { beams, ray, seatFilter } = await geometry.jsonValue()
          await geometry.dispose()
          assert.equal(beams.length, 2)
          for (const beam of beams) {
            assert(beam && Math.hypot(beam.start.x - beam.mouth.x, beam.start.y - beam.mouth.y) < 1,
              `${engineName}/${screen}/party${partySize}/${orb}: rendered beam left Defect's mouth: ${JSON.stringify(beam)}`)
          }
          assert.equal(seatFilter, 'none', `${engineName}/${screen}: seat filter clips overflowing beams`)
          const shot = await page.locator('.board').screenshot({ path: resolve(output, `${engineName}-${screen}-storm-${orb}-party${partySize}.png`) })
          // Geometry can be correct while WebKit clips the painted beam at
          // an ancestor's filter. Check actual pixels halfway to the enemy.
          const painted = await page.evaluate(async ({ png, orb, ray }) => {
            const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode()
            const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height
            const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0)
            const board = document.querySelector('.board').getBoundingClientRect()
            const x = Math.round((ray.x + ray.width / 2 - board.left) * image.width / board.width)
            const y = Math.round((ray.y + ray.height / 2 - board.top) * image.height / board.height)
            const pixels = ctx.getImageData(x - 8, y - 24, 16, 48).data
            let matches = 0
            for (let i = 0; i < pixels.length; i += 4) {
              const [r, g, b] = pixels.slice(i, i + 3)
              if (orb === 'dark' ? r > 130 && b > 140 && b > g * 1.2 : r > 200 && g > 185 && b > 120) matches++
            }
            return matches
          }, { png: shot.toString('base64'), orb, ray })
          await page.locator('.defect-evoke--test-clone').evaluateAll(clones => clones.forEach(clone => clone.remove()))
          assert(painted > 10, `${engineName}/${screen}/party${partySize}/${orb}: beam is clipped before reaching the enemy`)
          await page.locator('.character-attack').waitFor({ state: 'detached' })
          assert(await idlePortrait.evaluate(art => art.isConnected), 'attack recovery remounted the idle portrait')
          await idlePortrait.dispose()
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
