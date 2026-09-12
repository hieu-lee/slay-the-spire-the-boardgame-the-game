#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer, preview } from 'vite'
import { chromium, devices, webkit } from './lib/profile-browser.mjs'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'artifacts/lightning-act2')
mkdirSync(output, { recursive: true })
const production = process.argv.includes('--production')
const server = production
  ? await preview({ root, logLevel: 'silent', preview: { port: 0 } })
  : await createServer({ root, logLevel: 'silent', server: { port: 0 } })
if (!production) await server.listen()
const errors = []
const measurements = []
try {
  for (const [engineName, engine] of Object.entries({ chromium, webkit })) {
    if (process.argv.includes('--webkit-only') && engineName !== 'webkit') continue
    const browser = await engine.launch({ headless: true })
    try {
      for (const [screen, viewport] of [
        ['desktop', { width: 1440, height: 900 }],
        ['horizontal-phone', { width: 844, height: 390 }],
      ]) {
        if (process.argv.includes('--phone-only') && screen !== 'horizontal-phone') continue
        const phone = screen === 'horizontal-phone'
        const context = await browser.newContext({
          ...(phone ? devices['iPhone 13 landscape'] : { viewport }),
          recordVideo: { dir: output, size: viewport },
        })
        const page = await context.newPage()
        const activate = async (locator) => {
          if (!phone) return locator.click()
          const point = await locator.evaluate((element, webkit) => {
            const rect = element.getBoundingClientRect(), viewport = visualViewport
            return {
              x: (rect.x + rect.width / 2 - (webkit ? viewport.offsetLeft : 0)) * (webkit ? viewport.scale : 1),
              y: (rect.y + rect.height / 2 - (webkit ? viewport.offsetTop : 0)) * (webkit ? viewport.scale : 1),
            }
          }, engineName === 'webkit')
          return page.touchscreen.tap(point.x, point.y)
        }
        page.on('pageerror', error => { errors.push(String(error)); console.error(error) })
        await page.goto(`http://localhost:${server.httpServer.address().port}`)
        await page.getByRole('button', { name: 'Single Player', exact: true }).click()
        await page.getByRole('button', { name: 'Standard', exact: true }).click()
        await page.getByRole('button', { name: 'Embark' }).click()
        await page.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
        await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'neow')
        await page.evaluate(() => {
          const debug = window.__STS_DEBUG__
          debug.reset(1, 'lightning-city')
          debug.setRun({ ...debug.getRun(), phase: 'map', neow: null })
        })
        await page.locator('.room--reachable').first().click()
        if (screen === 'horizontal-phone') await page.locator('.room--reachable').first().click()
        await page.locator('.combat').waitFor()
        const install = async (count = 1, enemyCount = 2, hp = 30, ordinary = false) => {
          await page.evaluate(({ count, enemyCount, hp, ordinary }) => {
            const debug = window.__STS_DEBUG__, run = structuredClone(debug.getRun())
            const player = run.combat.players[0], enemy = run.combat.enemies[0]
            run.act = ordinary ? 1 : 2; run.phase = 'combat'
            Object.assign(player, { character: 'defect', name: 'Defect', hp: 9, maxHp: 9,
              relics: [], powers: [], potions: [], draw: [], discard: [], exhaust: [],
              hand: ['strike_defect', 'defend_defect', 'zap', 'dual_cast', 'ball_lightning']
                .map((defId, i) => ({ uid: `hand-${i}`, defId, upgraded: false })),
              energy: 3, block: 0, orbs: Array.from({ length: 3 }, (_, i) => i < count ? 'lightning' : null),
              orbEndTurnBonus: 0, lightningEndTurnBonus: 0, dead: false })
            Object.assign(run.combat, { combatId: `lightning-${Date.now()}`, phase: 'player',
              endTurnProgress: undefined, startTurnProgress: undefined, pendingTriggers: [],
              presentationEvents: [], players: [player], enemies: (ordinary
                ? ['red_louse', 'green_louse', 'red_louse'].map((defId, i) => ({
                  ...enemy, uid: `bolt-louse-${i}`, defId, isBoss: false,
                }))
                : [
                  { ...enemy, uid: 'bolt-boss', defId: 'bronze_automaton', isBoss: true },
                  { ...enemy, uid: 'bolt-normal', defId: 'blue_slaver', isBoss: false },
                ].slice(0, enemyCount)).map(e => ({ ...e, row: 0, hp, maxHp: hp,
                block: 0, strength: 0, weak: 0, vulnerable: 0, poison: 0,
                actionIndex: 0, abilityUsed: false, dead: false })) })
            Object.assign(run.players[0], { character: 'defect', name: 'Defect' })
            debug.setRun(run)
          }, { count, enemyCount, hp, ordinary })
          await page.waitForFunction(act => document.querySelector('.combat')?.dataset.act === String(act) &&
            [...document.querySelectorAll('.enemy__art--cutout,.seat__portrait > img')]
              .every(i => i.complete && i.naturalWidth), ordinary ? 1 : 2)
          await page.waitForTimeout(1000)
        }
        await install()
        await page.mouse.move(20, 20)
        await page.screenshot({ path: resolve(output, `${engineName}-${screen}-city.png`) })
        const floor = await page.evaluate(() => {
          const combat = document.querySelector('.combat'), r = combat.getBoundingClientRect()
          const style = getComputedStyle(combat)
          // The reconstructed image's far floor edge is y=.60; account for cover crop.
          const scale = Math.max(r.width / 2048, r.height / 1024)
          const alignment = parseFloat(style.backgroundPositionY.split(',').at(-1)) / 100
          const edge = r.top + (r.height - 1024 * scale) * alignment + .60 * 1024 * scale
          return { edge, feet: [...document.querySelectorAll('.seat__portrait,.enemy__portrait')]
            .map(p => p.getBoundingClientRect().bottom), background: style.backgroundImage }
        })
        measurements.push({ engineName, screen, floor })
        assert(floor.background.includes('boss-act-2.webp'))
        assert(floor.feet.every(y => y > floor.edge + 8), `${engineName}/${screen}: actors above the floor: ${JSON.stringify(floor)}`)

        const strike = page.locator('[data-lightning-strike]')
        const fire = async (targetId, initialHp = 30, liveFirstUse = false, drag = false) => {
          // Trigger through the real End turn -> Orb -> enemy click path.
          await activate(page.getByRole('button', { name: 'End turn', exact: true }))
          const orb = page.locator('button.end-turn-effect--orb')
          const targetHitArea = page.locator(`[data-enemy-id="${targetId}"] .enemy__hit-area`)
          if (drag) {
            const [from, to] = await Promise.all([orb.boundingBox(), targetHitArea.boundingBox()])
            assert(from && to, 'lightning drag endpoints are not visible')
            await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
            await page.mouse.down()
            await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 })
            await page.mouse.up()
          } else {
            await activate(orb)
            await activate(targetHitArea)
          }
          await strike.waitFor({ state: 'attached' })
          const geometry = await strike.evaluate(node => {
            const combat = node.closest('.combat'), combatRect = combat.getBoundingClientRect()
            const portrait = combat.querySelector(`.enemy[data-enemy-id="${CSS.escape(node.dataset.vfxTarget)}"] .enemy__portrait`)
            const r = node.getBoundingClientRect()
            const enemy = portrait.closest('.enemy').getBoundingClientRect()
            const board = combat.querySelector('.board').getBoundingClientRect(), s = getComputedStyle(node)
            return { x: r.x + r.width / 2, footX: enemy.left + portrait.offsetLeft + portrait.offsetWidth / 2,
              left: r.left, width: r.width, height: r.height, viewportWidth: innerWidth,
              ground: r.top + .94 * r.height,
              footY: enemy.top + portrait.offsetTop + portrait.offsetHeight,
              top: r.top,
              combatTop: combatRect.top, boardTop: board.top,
              filter: s.filter, pointerEvents: s.pointerEvents, image: s.backgroundImage,
              before: getComputedStyle(node, '::before').content }
          })
          assert(Math.abs(geometry.x - geometry.footX) < 1 && Math.abs(geometry.ground - geometry.footY) < 1,
            `bolt misses feet: ${JSON.stringify(geometry)}`)
          assert(Math.abs(geometry.top - geometry.combatTop) < 1 && geometry.boardTop - geometry.top > 20,
            'bolt does not descend from the combat ceiling through the relic strip')
          assert.equal(geometry.filter, 'none')
          assert.equal(geometry.pointerEvents, 'none')
          assert.equal(geometry.before, 'none')
          assert(geometry.image.includes('turn-lightning-strike.webp'))
          assert(!geometry.image.includes('/assets/assets/'),
            `${engineName}/${screen}: VFX URL resolved relative to the CSS bundle`)
          assert.equal(await page.locator('.seat [data-lightning-strike]').count(), 0)
          if (liveFirstUse) {
            await page.waitForTimeout(40)
            const liveTime = await strike.evaluate(node => node.getAnimations()
              .find(animation => animation.effect?.getTiming().duration === 100)?.currentTime ?? -1)
            assert(liveTime > 0 && liveTime <= 100,
              `${engineName}/${screen}: first strike was not running at capture (${liveTime}ms)`)
            const liveScreenshot = resolve(output, `${engineName}-${screen}-${targetId}-first-use-live.png`)
            await page.screenshot({ path: liveScreenshot })
            const livePixels = spawnSync('python3', ['-c', `
from PIL import Image
import json, sys
image = Image.open(sys.argv[1]).convert('RGB')
g = json.loads(sys.argv[2]); scale = image.width / g['viewportWidth']
box = [g['left'], g['top'], g['left'] + g['width'], g['top'] + g['height'] * .94]
band = image.crop(tuple(round(v * scale) for v in box))
assert sum(r > 220 and b > 200 and g > 210 for r, g, b in band.getdata()) >= 20, 'live first-use bolt is blank'
`, liveScreenshot, JSON.stringify(geometry)], { encoding: 'utf8' })
            assert.equal(livePixels.status, 0, livePixels.stderr)
            await page.waitForFunction(() => !document.querySelector('[data-lightning-strike]'))
            const hp = await page.evaluate(() => window.__STS_DEBUG__.getRun().combat.enemies.map(e => ({ uid: e.uid, hp: e.hp })))
            assert(hp.every(enemy => enemy.hp === initialHp - Number(enemy.uid === targetId)),
              `visual target differs from damage target ${JSON.stringify(hp)}`)
            return
          }
          const travel = await strike.evaluate(node => {
            const animations = node.getAnimations()
            animations.forEach(animation => animation.pause())
            animations.forEach(animation => { animation.currentTime = 50 })
            const halfway = getComputedStyle(node).clipPath
            animations.forEach(animation => { animation.currentTime = 100 })
            const arrived = getComputedStyle(node).clipPath
            animations.forEach(animation => { animation.currentTime = 170 })
            return { halfway, arrived,
              durations: animations.map(animation => animation.effect?.getTiming().duration).sort() }
          })
          assert.deepEqual(travel.durations, [100, 360])
          assert(travel.halfway.includes('50%') && travel.arrived.includes('0%'),
            `bolt did not travel ceiling-to-ground in 100ms ${JSON.stringify(travel)}`)
          if (targetId === 'bolt-normal' && initialHp === 30) {
            const scrolled = await strike.evaluate(async node => {
              const combat = node.closest('.combat'), board = combat.querySelector('.board')
              const portrait = combat.querySelector(`.enemy[data-enemy-id="${CSS.escape(node.dataset.vfxTarget)}"] .enemy__portrait`)
              const previousOverflow = board.style.overflow
              // Add overflow without changing the target's size, so ResizeObserver
              // cannot mask a missing scroll listener on the combat-level effect.
              const spacer = document.createElement('div')
              spacer.style.cssText = `width:${board.scrollWidth + 160}px;height:1px;flex-shrink:0`
              board.append(spacer)
              board.style.overflow = 'auto hidden'
              board.scrollLeft = 80
              await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
              const enemy = portrait.closest('.enemy').getBoundingClientRect(), bolt = node.getBoundingClientRect()
              const result = { scroll: board.scrollLeft,
                error: Math.abs(bolt.x + bolt.width / 2 - (enemy.left + portrait.offsetLeft + portrait.offsetWidth / 2)) }
              board.scrollLeft = 0
              spacer.remove()
              board.style.overflow = previousOverflow
              await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
              return result
            })
            assert(scrolled.scroll > 30 && scrolled.error < 1,
              `bolt lost its target during board scroll ${JSON.stringify(scrolled)}`)
          }
          if (!phone && targetId === 'bolt-normal' && initialHp === 30) {
            await page.setViewportSize({ width: viewport.width - 8, height: viewport.height - 8 })
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
            const resized = await strike.evaluate(node => {
              const combat = node.closest('.combat')
              const portrait = combat.querySelector(`.enemy[data-enemy-id="${CSS.escape(node.dataset.vfxTarget)}"] .enemy__portrait`)
              const enemy = portrait.closest('.enemy').getBoundingClientRect()
              const bolt = node.getBoundingClientRect()
              return {
                x: Math.abs(bolt.x + bolt.width / 2 - (enemy.left + portrait.offsetLeft + portrait.offsetWidth / 2)),
                y: Math.abs(bolt.top + bolt.height * .94 - (enemy.top + portrait.offsetTop + portrait.offsetHeight)),
              }
            })
            await page.setViewportSize(viewport)
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
            assert(resized.x < 1 && resized.y < 1,
              `bolt lost its target during combat resize ${JSON.stringify(resized)}`)
          }
          // Freeze the completed travel during its first flash for a repeatable screenshot.
          const screenshot = resolve(output, `${engineName}-${screen}-${targetId}${initialHp === 1 ? '-lethal' : ''}-lightning.png`)
          await page.screenshot({ path: screenshot })
          // Bounding boxes cannot detect WebKit's ancestor-filter clipping.
          // Require real white bolt pixels in the band above the enemy's box.
          const pixels = spawnSync('python3', ['-c', `
from PIL import Image
import json, sys
image = Image.open(sys.argv[1]).convert('RGB')
g = json.loads(sys.argv[2]); scale = image.width / g['viewportWidth']
box = [g['left'], g['top'] + g['height'] * .04,
       g['left'] + g['width'], g['top'] + g['height'] * .12]
band = image.crop(tuple(round(v * scale) for v in box))
assert sum(r > 220 and b > 200 and g > 210 for r, g, b in band.getdata()) >= 4, 'upper bolt is clipped'
`, screenshot, JSON.stringify(geometry)], { encoding: 'utf8' })
          assert.equal(pixels.status, 0, pixels.stderr)
          await page.waitForFunction(() => !document.querySelector('[data-lightning-strike]'))
          const hp = await page.evaluate(() => window.__STS_DEBUG__.getRun().combat.enemies.map(e => ({ uid: e.uid, hp: e.hp })))
          assert(hp.every(enemy => enemy.hp === initialHp - Number(enemy.uid === targetId)),
            `visual target differs from damage target ${JSON.stringify(hp)}`)
        }
        await fire('bolt-boss', 30, engineName === 'chromium')
        await install()
        await fire('bolt-normal')
        await install(1, 2, 1)
        await fire('bolt-normal', 1)
        if (!phone) {
          await install(1, 3, 30, true)
          await fire('bolt-louse-2', 30, false, true)
        }

        // Promptly choosing a second orb must keep the recently hit target glowing.
        await install(2, 2)
        await activate(page.getByRole('button', { name: 'End turn', exact: true }))
        await activate(page.locator('button.end-turn-effect--orb'))
        await activate(page.locator('[data-enemy-id="bolt-normal"] .enemy__hit-area'))
        await strike.waitFor({ state: 'attached' })
        await page.locator('button.end-turn-effect--orb').evaluate(button => button.click())
        const target = page.locator('[data-enemy-id="bolt-normal"].enemy--targeted')
        await target.waitFor({ state: 'attached' })
        const highlight = await target.evaluate(enemy => ({
          filter: getComputedStyle(enemy).filter,
        }))
        assert(highlight.filter.includes('101, 232, 255'),
          `recently hit target lost its selection glow: ${JSON.stringify(highlight)}`)
        await page.screenshot({ path: resolve(output, `${engineName}-${screen}-consecutive-target.png`) })
        await activate(page.locator('[data-enemy-id="bolt-normal"] .enemy__hit-area'))
        await page.waitForFunction(() => !document.querySelector('[data-lightning-strike]'))

        // Same-batch passives keep separate flashes, and repeated uses restart.
        await install(3, 1)
        await activate(page.getByRole('button', { name: 'End turn', exact: true }))
        await page.waitForFunction(() => document.querySelectorAll('[data-lightning-strike]').length === 3)
        const delays = await strike.evaluateAll(nodes => nodes.map(n => getComputedStyle(n).animationDelay).sort())
        assert.deepEqual(delays, ['0.38s, 0.48s', '0.76s, 0.86s', '0s, 0.1s'])
        await page.waitForFunction(() => !document.querySelector('[data-lightning-strike]'))

        // A restored snapshot containing old events must never replay them.
        await page.evaluate(() => {
          const debug = window.__STS_DEBUG__, run = structuredClone(debug.getRun())
          run.combat.combatId += '-restored'; debug.setRun(run)
        })
        await page.waitForTimeout(150)
        assert.equal(await strike.count(), 0)
        await page.evaluate(() => { document.documentElement.dataset.reducedMotion = 'true' })
        await install(1, 1)
        await activate(page.getByRole('button', { name: 'End turn', exact: true }))
        await page.waitForTimeout(100)
        assert.equal(await strike.count(), 0, 'reduced motion still flashes lightning')
        assert.equal(await page.evaluate(() => window.__STS_DEBUG__.getRun().combat.enemies[0].hp), 29)
        if (production) {
          await page.evaluate(() => {
            const debug = window.__STS_DEBUG__, run = structuredClone(debug.getRun())
            run.phase = 'reward'; run.combat = null; run.rewardDestination = 'map'
            run.rewards = [{ playerId: run.players[0].id, gold: 3, cardReward: true,
              choices: null, upgraded: false, potion: false }]
            debug.setRun(run)
          })
          const rewardBackground = await page.locator('.reward-screen').evaluate(element =>
            getComputedStyle(element).backgroundImage)
          assert(rewardBackground.includes('/assets/backgrounds/boss-act-2.webp') &&
            !rewardBackground.includes('/assets/assets/'),
          `${engineName}/${screen}: reward backdrop URL is invalid ${rewardBackground}`)
          await page.evaluate(() => {
            const debug = window.__STS_DEBUG__, run = structuredClone(debug.getRun())
            run.phase = 'room'; run.rewards = []
            run.roomState = { kind: 'event', decisions: {}, dieRolls: {}, card: {
              id: 'big_fish', instanceId: 'production-url-big-fish', act: 1,
              minAscension: 0, requiresColorlessUnlock: false, name: 'Big Fish',
              scope: 'player', rule: 'Choose one.', options: [{ id: 'banana', label: 'Banana',
                description: 'Heal 2 HP.', effects: [{ tag: 'heal', amount: 2 }] }],
            } }
            debug.setRun(run)
          })
          const eventBackground = await page.locator('.event-stage').evaluate(element =>
            getComputedStyle(element).backgroundImage)
          assert(eventBackground.includes('/assets/noncombat/events/big_fish.webp') &&
            !eventBackground.includes('/assets/assets/'),
          `${engineName}/${screen}: event art URL is invalid ${eventBackground}`)
        }
        console.log(`${engineName}/${screen}: floor, real targeted strike, repeated/batched orbs, restored state and reduced motion passed`)
        await context.close()
      }
    } finally { await browser.close() }
  }
  assert.deepEqual(errors, [], 'browser errors')
  assert(statSync(resolve(root, 'public/assets/combat/vfx/actions/turn-lightning-strike.webp')).size < 48 * 1024)
  assert(statSync(resolve(root, 'public/assets/backgrounds/boss-act-2.webp')).size < 220 * 1024)
} finally {
  writeFileSync(resolve(output, 'measurements.json'), JSON.stringify(measurements, null, 2))
  await server.close()
}
