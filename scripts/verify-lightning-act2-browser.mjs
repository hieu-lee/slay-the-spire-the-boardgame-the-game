#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium, webkit } from './lib/profile-browser.mjs'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'artifacts/lightning-act2')
mkdirSync(output, { recursive: true })
const server = await createServer({ root, logLevel: 'silent', server: { port: 0 } })
await server.listen()
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
        const context = await browser.newContext({ viewport,
          isMobile: screen === 'horizontal-phone', hasTouch: screen === 'horizontal-phone',
          recordVideo: { dir: output, size: viewport } })
        const page = await context.newPage()
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
        const install = async (count = 1, enemyCount = 2, hp = 30) => {
          await page.evaluate(({ count, enemyCount, hp }) => {
            const debug = window.__STS_DEBUG__, run = structuredClone(debug.getRun())
            const player = run.combat.players[0], enemy = run.combat.enemies[0]
            run.act = 2; run.phase = 'combat'
            Object.assign(player, { character: 'defect', name: 'Defect', hp: 9, maxHp: 9,
              relics: [], powers: [], potions: [], draw: [], discard: [], exhaust: [],
              hand: ['strike_defect', 'defend_defect', 'zap', 'dual_cast', 'ball_lightning']
                .map((defId, i) => ({ uid: `hand-${i}`, defId, upgraded: false })),
              energy: 3, block: 0, orbs: Array.from({ length: 3 }, (_, i) => i < count ? 'lightning' : null),
              orbEndTurnBonus: 0, lightningEndTurnBonus: 0, dead: false })
            Object.assign(run.combat, { combatId: `lightning-${Date.now()}`, phase: 'player',
              endTurnProgress: undefined, startTurnProgress: undefined, pendingTriggers: [],
              presentationEvents: [], players: [player], enemies: [
                { ...enemy, uid: 'bolt-boss', defId: 'bronze_automaton', isBoss: true },
                { ...enemy, uid: 'bolt-normal', defId: 'blue_slaver', isBoss: false },
              ].slice(0, enemyCount).map(e => ({ ...e, row: 0, hp, maxHp: hp,
                block: 0, strength: 0, weak: 0, vulnerable: 0, poison: 0,
                actionIndex: 0, abilityUsed: false, dead: false })) })
            Object.assign(run.players[0], { character: 'defect', name: 'Defect' })
            debug.setRun(run)
          }, { count, enemyCount, hp })
          await page.waitForFunction(() => document.querySelector('.combat')?.dataset.act === '2' &&
            [...document.querySelectorAll('.enemy__art--cutout,.seat__portrait > img')]
              .every(i => i.complete && i.naturalWidth))
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
        const fire = async (targetId, initialHp = 30) => {
          // Trigger through the real End turn -> Orb -> enemy click path.
          await page.getByRole('button', { name: 'End turn', exact: true }).click()
          await page.locator('button.end-turn-effect--orb').click()
          await page.locator(`[data-enemy-id="${targetId}"] .enemy__hit-area`).click()
          await strike.waitFor({ state: 'attached' })
          const geometry = await strike.evaluate(node => {
            const r = node.getBoundingClientRect(), portrait = node.closest('.enemy').querySelector('.enemy__portrait')
            const p = portrait.getBoundingClientRect()
            const restingFloor = node.parentElement.getBoundingClientRect().top + portrait.offsetTop + portrait.offsetHeight
            const board = node.closest('.board').getBoundingClientRect(), s = getComputedStyle(node)
            return { x: r.x + r.width / 2, footX: p.x + p.width / 2,
              left: r.left, width: r.width, height: r.height, viewportWidth: innerWidth,
              ground: r.top + .94 * r.height, footY: restingFloor, top: r.top, boardTop: board.top,
              filter: s.filter, pointerEvents: s.pointerEvents, image: s.backgroundImage,
              before: getComputedStyle(node, '::before').content }
          })
          assert(Math.abs(geometry.x - geometry.footX) < 1 && Math.abs(geometry.ground - geometry.footY) < 1,
            `bolt misses feet: ${JSON.stringify(geometry)}`)
          assert(Math.abs(geometry.top - geometry.boardTop) < 1, 'bolt does not descend from the top of the board')
          assert.equal(geometry.filter, 'none')
          assert.equal(geometry.pointerEvents, 'none')
          assert.equal(geometry.before, 'none')
          assert(geometry.image.includes('turn-lightning-strike.webp'))
          assert.equal(await page.locator('.seat [data-lightning-strike]').count(), 0)
          // Freeze this actual event at its first flash for a repeatable screenshot.
          await strike.evaluate(node => node.getAnimations().forEach(a => { a.pause(); a.currentTime = 70 }))
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
          const hp = await page.evaluate(() => window.__STS_DEBUG__.getRun().combat.enemies.map(e => e.hp))
          assert.deepEqual(hp, targetId === 'bolt-boss' ? [initialHp - 1, initialHp] : [initialHp, initialHp - 1], 'visual target differs from damage target')
        }
        await fire('bolt-boss')
        await install()
        await fire('bolt-normal')
        await install(1, 2, 1)
        await fire('bolt-normal', 1)

        // Promptly choosing a second orb must keep the recently hit target glowing.
        await install(2, 2)
        await page.getByRole('button', { name: 'End turn', exact: true }).click()
        await page.locator('button.end-turn-effect--orb').click()
        await page.locator('[data-enemy-id="bolt-normal"] .enemy__hit-area').click()
        await strike.waitFor({ state: 'attached' })
        await page.locator('button.end-turn-effect--orb').evaluate(button => button.click())
        const target = page.locator('[data-enemy-id="bolt-normal"].enemy--targeted')
        await target.waitFor({ state: 'attached' })
        const highlight = await target.evaluate(enemy => ({
          active: !!enemy.querySelector('[data-lightning-strike]'),
          filter: getComputedStyle(enemy.querySelector('.enemy__portrait')).filter,
        }))
        assert(highlight.active && highlight.filter.includes('101, 232, 255'),
          `recently hit target lost its selection glow: ${JSON.stringify(highlight)}`)
        await page.screenshot({ path: resolve(output, `${engineName}-${screen}-consecutive-target.png`) })
        await page.locator('[data-enemy-id="bolt-normal"] .enemy__hit-area').click()
        await page.waitForFunction(() => !document.querySelector('[data-lightning-strike]'))

        // Same-batch passives keep separate flashes, and repeated uses restart.
        await install(3, 1)
        await page.getByRole('button', { name: 'End turn', exact: true }).click()
        await page.waitForFunction(() => document.querySelectorAll('[data-lightning-strike]').length === 3)
        const delays = await strike.evaluateAll(nodes => nodes.map(n => getComputedStyle(n).animationDelay).sort())
        assert.deepEqual(delays, ['0.38s', '0.76s', '0s'])
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
        await page.getByRole('button', { name: 'End turn', exact: true }).click()
        await page.waitForTimeout(100)
        assert.equal(await strike.count(), 0, 'reduced motion still flashes lightning')
        assert.equal(await page.evaluate(() => window.__STS_DEBUG__.getRun().combat.enemies[0].hp), 29)
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
