#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium, webkit } from './lib/profile-browser.mjs'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'artifacts/enemy-layout')
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
        page.on('pageerror', e => { errors.push(String(e)); console.log('PAGE ERROR', String(e)) })
        await page.goto(`http://localhost:${server.httpServer.address().port}`)
        await page.evaluate(async () => {
          document.querySelector('#root').style.display = 'none'
          document.documentElement.dataset.mobilePerformance = String(matchMedia('(pointer: coarse)').matches)
          document.documentElement.dataset.reducedMotion = 'false'
          const node = document.createElement('div')
          node.className = 'app-shell app-shell--combat sts-scope'
          // This isolated fixture omits App's header: use one full-height row.
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
            state: structuredClone(f.state), act: 3, viewerId: 'p1', autoAdvance: false,
            authoritativeRestoration: f.restoration, onChange: state => { f.state = state; f.render() },
          }))
          f.install = (defs, partySize = 1) => {
            const rng = createRng(47), player = createPlayer(rng, 'p1', 'Ironclad', 'ironclad', 0)
            Object.assign(player, { hp: 8, maxHp: 8, relics: [], draw: [], discard: [],
              hand: [{ uid: 'strike', defId: 'strike_ironclad', upgraded: false }], powers: [] })
            const party = [player, ...Array.from({ length: partySize - 1 }, (_, i) => {
              const ally = createPlayer(rng, `p${i + 2}`, `Ally ${i + 1}`, 'ironclad', 0)
              Object.assign(ally, { row: i + 1, relics: [], hand: [], draw: [], powers: [] })
              return ally
            })]
            f.state = C.createCombat(rng, party, defs.map((defId, i) => ({ uid: `enemy-${i}`, defId, row: Math.floor(i / 3) % partySize,
              isBoss: ['donu', 'deca', 'slime_boss', 'the_collector'].includes(defId), hp: 50, maxHp: 50, block: 0, strength: 0,
              weak: 0, vulnerable: 0, poison: 0, actionIndex: 0, abilityUsed: false, dead: false })))
            f.state.die = 1; f.state.phase = 'player'; f.state.presentationEvents = []
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
          await page.locator('.enemy__art--cutout,.seat__portrait > img').evaluateAll(images => images.forEach(i => { i.loading = 'eager' }))
          await page.waitForFunction(() => document.querySelector('.enemy') &&
            [...document.querySelectorAll('.enemy__art--cutout,.seat__portrait > img')].every(i => i.complete && i.naturalWidth), null, { timeout: 10000 }).catch(async e => { console.log(await page.evaluate(() => document.body.innerText.slice(-2000))); await page.screenshot({ path: resolve(output, 'failure.png') }); throw e })
          await page.waitForTimeout(250)
          await page.waitForFunction(() => !document.querySelector('.combat').getAnimations().some(a => a.playState === 'running'))
        }
        await page.evaluate(() => window.fixture.install(['cultist', 'jaw_worm']))
        await ready()
        const ratios = await page.evaluate(() => {
          const b = window.fixture.bounds, hero = b(document.querySelector('.seat__portrait > img'))
          return [...document.querySelectorAll('.enemy__art--cutout')].map(i => b(i).height / hero.height)
        })
        assert(ratios[0] > 1.1 && ratios[0] < 1.35, `Cultist total silhouette vs hero: ${ratios[0]}`)
        assert(ratios[1] > .50 && ratios[1] < .65, `Jaw Worm vs hero: ${ratios[1]}`)
        await page.screenshot({ path: resolve(output, `${engineName}-${screen}-reference-proportions.png`) })
        console.log(`${engineName}/${screen}: Cultist ${ratios[0].toFixed(2)}, Jaw Worm ${ratios[1].toFixed(2)} of hero height`)
        const endTurn = page.locator('.combat__end-turn')
        assert((await endTurn.evaluate(e => getComputedStyle(e).clipPath)).includes('16px'))
        await page.keyboard.press('Tab'); await endTurn.focus()
        assert(await endTurn.evaluate(e => e.matches(':focus-visible') && getComputedStyle(e).outlineStyle !== 'none'))
        // Every plain combat control keeps the same fixed 45-degree chamfer.
        await page.evaluate(() => {
          const host = document.createElement('div'); host.id = 'stone-state-probe'; host.className = 'sts-scope'
          const surface = document.createElement('div'); surface.className = 'combat'; host.append(surface)
          for (const kind of ['idle', 'bare', 'empty', 'chosen', 'disabled', 'cancel']) {
            const button = document.createElement('button'); button.textContent = kind
            if (kind === 'empty') button.className = ''
            if (kind === 'chosen') button.className = 'is-chosen'
            if (kind === 'disabled') button.disabled = true
            if (kind === 'cancel') button.className = 'prompt__cancel'
            else if (kind !== 'idle') button.setAttribute('aria-pressed', 'true')
            surface.append(button)
          }
          document.body.append(host)
        })
        for (const button of await page.locator('#stone-state-probe button').all())
          assert((await button.evaluate(e => getComputedStyle(e).clipPath)).includes('16px'))
        if (engineName === 'chromium') {
          await page.emulateMedia({ forcedColors: 'active' })
          const idle = page.locator('#stone-state-probe button').first()
          await idle.hover()
          const forcedHover = await idle.evaluate(e => ({ backgroundImage: getComputedStyle(e).backgroundImage, filter: getComputedStyle(e).filter }))
          assert(forcedHover.backgroundImage === 'none' && forcedHover.filter === 'none',
            `forced colors must keep a hovered unselected button system-coloured: ${JSON.stringify(forcedHover)}`)
          const selected = page.locator('#stone-state-probe button').nth(1)
          await selected.focus()
          assert(await selected.evaluate(e => getComputedStyle(e).outlineStyle === 'double' &&
            getComputedStyle(e).outlineWidth === '5px' && getComputedStyle(e).backgroundImage === 'none'),
          'forced colors must distinguish selected keyboard focus and remove the bitmap')
          await selected.hover()
          assert(await selected.evaluate(e => getComputedStyle(e).outlineStyle === 'double' && getComputedStyle(e).filter === 'none'),
            'forced colors must retain keyboard focus and reset hover filtering')
          await page.emulateMedia({ forcedColors: 'none' })
        }
        await page.locator('#stone-state-probe').evaluate(e => e.remove())
        // Reference creatures keep their resting calibration across animation
        // and static/reduced-motion art, independently of transparent overscan.
        const idle = await page.evaluate(() => [...document.querySelectorAll('.enemy__art--cutout')].map(window.fixture.bounds))
        await page.evaluate(() => { document.documentElement.dataset.reducedMotion = 'true' })
        await ready()
        const still = await page.evaluate(() => [...document.querySelectorAll('.enemy__art--cutout')].map(window.fixture.bounds))
        still.forEach((b, i) => assert(Math.abs(b.height / idle[i].height - 1) < .06, 'static art changes body scale'))
        await page.evaluate(() => { document.documentElement.dataset.reducedMotion = 'false' })
        await ready()
        await page.locator('[data-enemy-art="cultist"] .enemy__art--cutout').evaluate(image => { image.src = '/missing-cultist.webp' })
        await page.waitForFunction(() => {
          const image = document.querySelector('[data-enemy-art="cultist"] .enemy__art--cutout')
          return image.dataset.fallback === 'true' && image.complete && image.naturalWidth > 0
        })
        const fallback = await page.locator('[data-enemy-art="cultist"] .enemy__art--cutout').evaluate(image => window.fixture.bounds(image))
        assert(Math.abs(fallback.height / idle[0].height - 1) < .06, 'failed idle asset changes fallback body scale')
        // An evoke can start while survivors move at an unchanged actor scale.
        // Its cached beam endpoints require the same stage hold as a dash.
        for (const orb of ['lightning', 'dark']) {
          await page.evaluate(() => {
            const f = window.fixture
            f.install(['jaw_worm', 'jaw_worm', 'jaw_worm'], 4)
            f.state.players[0].character = 'defect'; f.render()
          })
          await ready()
          await page.evaluate(() => {
            const f = window.fixture; f.state.enemies[0].hp = 0; f.state.enemies[0].dead = true; f.render()
          })
          await page.waitForFunction(() => document.querySelectorAll('.enemy').length === 2)
          await page.waitForTimeout(120)
          await page.evaluate(orb => {
            const f = window.fixture
            f.state.presentationEvents.push({ seq: ++f.seq, kind: 'orb', actorId: 'p1', sourceId: 'orb-evoke', orb,
              enemyIds: ['enemy-2'], playerIds: [], upgraded: false, copied: false, energy: 0 })
            f.render()
          }, orb)
          await page.locator('.defect-evoke').waitFor({ state: 'attached' })
          const held = await page.locator('[data-enemy-id="enemy-2"]').evaluate(async e => {
            const before = e.getBoundingClientRect().left
            await new Promise(r => setTimeout(r, 300))
            return Math.abs(e.getBoundingClientRect().left - before)
          })
          assert(held < .5, `${orb}: the stage moved the target away from the evoke beam`)
          await page.locator('.defect-evoke').waitFor({ state: 'detached' })
          await ready()
        }
        // Real four-player population limits: 3 split slimes per player,
        // 12 physical Sentry cards, and Collector's 2 Torch Heads per player.
        for (const [label, boss, defs] of [
          ['slime-split', 'slime_boss', Array.from({ length: 4 }, () => ['large_slime', 'acid_slime', 'spike_slime']).flat()],
          ['sentries', null, Array.from({ length: 12 }, (_, i) => i < 7 ? 'sentry_a' : 'sentry_b')],
          ['collector', 'the_collector', ['the_collector', ...Array(8).fill('torch_head')]],
        ]) {
          // Grow an existing boss fight and smoothly fit the whole party.
          await page.evaluate(({ boss, defs }) => window.fixture.install(boss ? [boss] : defs, 4), { boss, defs })
          await ready()
          const scaleBefore = await page.locator('.combat').evaluate(e => +getComputedStyle(e).getPropertyValue('--stage-scale'))
          if (boss) await page.evaluate(defs => {
            const f = window.fixture, template = f.state.enemies[0]
            f.state.enemies = defs.map((defId, i) => ({ ...template, uid: `enemy-${i}`, defId,
              row: Math.max(0, Math.floor((i - Number(defs[0] === 'the_collector')) / (defs[0] === 'the_collector' ? 2 : 3))),
              isBoss: defId === 'the_collector', actionIndex: defId === 'the_collector' ? 1 : 0 }))
            f.render()
          }, defs)
          if (boss) {
            const samples = await page.locator('.combat').evaluate(async e => {
              const samples = []
              for (let i = 0; i < 12; i++) {
                samples.push(+getComputedStyle(e).getPropertyValue('--stage-scale'))
                await new Promise(r => setTimeout(r, 90))
              }
              return samples
            })
            assert(samples.at(-1) < scaleBefore - .1, 'crowd should shrink both sides')
            assert(new Set(samples.map(s => s.toFixed(3))).size > 3, 'crowd scale must interpolate smoothly')
          }
          await ready()
          assert(await page.locator('.enemy__head').evaluateAll(heads => heads.every(head =>
            getComputedStyle(head).backgroundImage === 'none' && getComputedStyle(head).backgroundColor === 'rgba(0, 0, 0, 0)')),
          'enemy names must not have dark background boxes')
          const crowdState = await page.evaluate(() => structuredClone(window.fixture.state))
          const crowdPitch = await page.locator('.combat').evaluate(e => +getComputedStyle(e).getPropertyValue('--stage-enemy-pitch'))
          assert(crowdPitch < 14, 'crowds should reclaim the space between enemies')
          const geometry = await page.evaluate(() => {
            const b = window.fixture.bounds
            const enemies = [...document.querySelectorAll('.enemy')].map(e => ({
              uid: e.dataset.enemyId, body: b(e.querySelector('.enemy__art--cutout')),
              name: e.querySelector('.enemy__name').getBoundingClientRect().toJSON(),
              health: e.querySelector('.bar').getBoundingClientRect().toJSON(),
              hud: ['.enemy__intent', '.enemy__ability', '.bar'].map(s => e.querySelector(s)?.getBoundingClientRect().toJSON()).filter(Boolean),
            })).sort((a, b) => a.body.left - b.body.left)
            return enemies
          })
          const heroFront = await page.locator('.seat__portrait > img').evaluateAll(images =>
            Math.max(...images.map(image => { const b = window.fixture.bounds(image); return b.left + b.width })))
          assert(geometry[0].body.left > heroFront + 2, `${label}: the front enemy overlaps the party`)
          for (const enemy of geometry) assert(enemy.name.bottom <= enemy.health.top - 1,
            `${label}: health bar covers the enemy name: ${JSON.stringify(enemy)}`)
          for (let i = 1; i < geometry.length; i++) {
            const previous = geometry[i - 1], current = geometry[i]
            assert(previous.body.left + previous.body.width + 2 < current.body.left,
              `${label}: adjacent painted bodies overlap ${previous.uid}/${current.uid}`)
            for (const a of previous.hud) for (const b of current.hud)
              assert(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top,
                `${label}: neighbouring HUD controls overlap`)
          }
          // Scroll every enemy into view and hit its visible body, rather than
          // trusting a potentially misplaced button box. Also covers the ends.
          for (const enemy of geometry) {
            const element = page.locator(`[data-enemy-id="${enemy.uid}"]`)
            await element.locator('.bar').scrollIntoViewIfNeeded()
            await page.waitForTimeout(80)
            const result = await element.evaluate(e => {
              const b = window.fixture.bounds(e.querySelector('.enemy__art--cutout'))
              const x = b.left + b.width / 2, y = b.top + b.height * .6
              return { uid: document.elementFromPoint(x, y)?.closest('.enemy')?.dataset.enemyId, top: b.top,
                boardTop: document.querySelector('.board').getBoundingClientRect().top }
            })
            assert.equal(result.uid, enemy.uid, `${engineName}/${screen}/${label}: body target inaccessible`)
            assert(result.top >= result.boardTop - 2, `${label}: artwork clipped above stage`)
          }
          await page.screenshot({ path: resolve(output, `${engineName}-${screen}-${label}.png`) })
          // A reconnect reuses the state and must retain the same geometry.
          const before = await page.locator('.enemy__art--cutout').evaluateAll(images => images.map(window.fixture.bounds))
          await page.evaluate(() => { window.fixture.restoration++; window.fixture.render() })
          await ready()
          const after = await page.locator('.enemy__art--cutout').evaluateAll(images => images.map(window.fixture.bounds))
          after.forEach((b, i) => assert(Math.abs(b.height - before[i].height) < 2, 'restoration resizes enemies'))
          // Defeating groups returns both sides to their wanted sizes, through
          // intermediate scales rather than jumping as actors leave the row.
          for (const survivors of [6, 3]) {
            const beforeScale = await page.locator('.combat').evaluate(e => +getComputedStyle(e).getPropertyValue('--stage-scale'))
            const beforePitch = await page.locator('.combat').evaluate(e => +getComputedStyle(e).getPropertyValue('--stage-enemy-pitch'))
            await page.evaluate(survivors => {
              const f = window.fixture
              f.state.enemies.forEach((enemy, i) => { if (i >= survivors) { enemy.hp = 0; enemy.dead = true } })
              f.render()
            }, survivors)
            await page.waitForFunction(survivors => document.querySelectorAll('.enemy').length === survivors, survivors)
            if (label === 'slime-split' && survivors === 6) {
              await page.waitForTimeout(120)
              await page.evaluate(() => {
                const f = window.fixture
                f.state.presentationEvents.push({ seq: ++f.seq, kind: 'card', actorId: 'p1', sourceId: 'strike_ironclad',
                  enemyIds: ['enemy-0'], playerIds: [], upgraded: false, copied: false, energy: 1 })
                f.render()
              })
              await page.locator('.character-attack').waitFor()
              const held = await page.locator('.combat').evaluate(async e => {
                const before = +getComputedStyle(e).getPropertyValue('--stage-scale')
                await new Promise(r => setTimeout(r, 300))
                return Math.abs(+getComputedStyle(e).getPropertyValue('--stage-scale') - before)
              })
              assert(held < .002, 'a new attack must hold the moving stage while its offsets are in use')
              await page.locator('.character-attack').waitFor({ state: 'detached' })
            }
            const recovery = await page.locator('.combat').evaluate(async e => {
              const result = []
              for (let i = 0; i < 12; i++) {
                result.push(+getComputedStyle(e).getPropertyValue('--stage-scale'))
                await new Promise(r => setTimeout(r, 90))
              }
              return result
            })
            assert(recovery.at(-1) > beforeScale + .05, 'deaths must gradually restore scale')
            // An attack can interrupt near the end of the ease, leaving only a short tail.
            assert(new Set(recovery.map(s => s.toFixed(4))).size > (label === 'slime-split' && survivors === 6 ? 1 : 3),
              `${engineName}/${screen}/${label}/${survivors}: scale recovery jumped: ${recovery}`)
            assert(recovery.every((s, i) => i === 0 || s >= recovery[i - 1] - .001), 'scale recovery oscillates')
            await ready()
            assert(await page.locator('.combat').evaluate((e, beforePitch) =>
              +getComputedStyle(e).getPropertyValue('--stage-enemy-pitch') > beforePitch, beforePitch), 'survivors should gradually space out')
          }
          await page.screenshot({ path: resolve(output, `${engineName}-${screen}-${label}-recovered.png`) })
          // Reconnecting during an enemy phase must fit the snapshot immediately,
          // even though ordinary attacks hold off a camera change until recovery.
          await page.evaluate(state => {
            const f = window.fixture; f.state = state; f.state.phase = 'enemy'; f.restoration++; f.render()
          }, crowdState)
          await ready()
          assert(await page.locator('.combat').evaluate(e => +getComputedStyle(e).getPropertyValue('--stage-scale') < .66),
            'enemy-phase reconnect left the crowd at the previous uncrowded scale')
          const restoredBodies = await page.locator('.enemy').evaluateAll(enemies => enemies.map(e => ({
            uid: e.dataset.enemyId, body: window.fixture.bounds(e.querySelector('.enemy__art--cutout')),
          })))
          const expectedOrigin = geometry.find(e => e.uid === 'enemy-0').body.left
          const restoredOrigin = restoredBodies.find(e => e.uid === 'enemy-0').body.left
          for (const enemy of restoredBodies) {
            const expected = geometry.find(e => e.uid === enemy.uid).body
            assert(Math.abs(enemy.body.left - restoredOrigin - (expected.left - expectedOrigin)) < 2,
              `${label}: enemy-phase restoration changed ${enemy.uid}'s formation index`)
          }
          console.log(`${engineName}/${screen}: four-player ${label} spacing and targeting passed`)
        }
        assert.deepEqual(errors, [])
        await context.close()
      }
    } finally { await browser.close() }
  }
} finally { await server.close() }
