import { strict as assert } from 'node:assert'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { postNeowRun } from './lib/post-neow-run.mjs'
import { createRoomServer } from './room-server.mjs'
import { createRoom, joinRoom } from './lib/rooms.mjs'
import { createRun, enterRoom } from '../src/game/run.ts'
import { installScreenAudit } from './lib/browser-screen-audit.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'artifacts/viewport-audit')
mkdirSync(out, { recursive: true })
const rooms = createRoomServer({ maxUpgradesPerWindow: 100 })
const address = await rooms.listen(0)
const target = `http://127.0.0.1:${address.port}`
const server = await createServer({ root, logLevel: 'silent', server: { port: 0, proxy: {
  '/api': { target }, '/ws': { target, ws: true },
} } })
await server.listen()
const browser = await chromium.launch()
const results = []
const failures = []
const base = postNeowRun('viewport-audit', [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }])
function roomRun(kind) {
  const run = structuredClone(base)
  const id = run.map.rows[0][0]
  run.map.rooms[id].kind = kind
  return enterRoom(run, id)
}
const setup = createRun('viewport-setup', [{ id: 'p1', name: 'Ironclad', character: 'ironclad' }], 0, undefined, false, false,
  { mode: 'custom', modifiers: [], quickStartAct: 2 })
setup.phase = 'setup'
setup.neow = null
setup.setup = { ...setup.setup, rowIndex: 3, repeatIndex: 0, playerIndex: 0, die: null }
const loot = { ...structuredClone(base), phase: 'reward', rewardDestination: 'map', rewards: [{
  playerId: 'p1', gold: 3, cardReward: true, choices: null, upgraded: false, potion: false,
}] }
const journal = { ...structuredClone(base), phase: 'victory', campaign: { ...base.campaign, finalized: true },
  campaignProgress: { ...base.campaignProgress, unspentMarks: 2 } }
const extraScreens = [['quick-setup', setup, '.quick-setup'], ['loot', loot, '.reward-screen'], ['campaign-journal', journal, '.campaign-end']]
try {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 600 }, { width: 960, height: 450 }, { width: 844, height: 390 }]) {
    const context = await browser.newContext({ viewport, ...(viewport.width === 844 ? { isMobile: true, hasTouch: true } : {}) })
    const page = installScreenAudit(await context.newPage())
    page.on('pageerror', error => failures.push(String(error)))
    await page.goto(`http://localhost:${server.httpServer.address().port}`)
    async function capture(name, selector) {
      await page.locator(selector).first().waitFor()
      await page.locator(selector).first().evaluate(element => Promise.all(element.getAnimations().filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation => animation.finished.catch(() => {}))))
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      const geometry = await page.evaluate(selector => {
        const box = document.querySelector(selector).getBoundingClientRect()
        return { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth,
          scrollHeight: document.documentElement.scrollHeight, box: box.toJSON() }
      }, selector)
      const label = `${name}-${viewport.width}`
      results.push({ label, ...geometry })
      console.log(label, geometry.scrollHeight, geometry.height)
      writeFileSync(join(out, 'geometry.json'), JSON.stringify(results, null, 2))
      if (geometry.scrollHeight > geometry.height + 2 || geometry.scrollWidth > geometry.width + 2 || geometry.box.bottom > geometry.height + 2) {
        failures.push(`${label} overflows: ${JSON.stringify(geometry)}`)
      }
      for (const control of await page.locator(selector).first().locator(':scope > button, .room-proceed, .quick-setup__advance').all()) {
        if (!await control.isVisible()) continue
        await control.scrollIntoViewIfNeeded()
        assert(await control.evaluate(element => {
          const box = element.getBoundingClientRect()
          return box.top >= 0 && box.bottom <= innerHeight + 1 && box.left >= 0 && box.right <= innerWidth + 1
        }), `${label}: action is clipped`)
        assert.equal(await page.evaluate(() => scrollY), 0, `${label}: reaching an action scrolls the game viewport`)
      }
      await page.locator('img[loading="lazy"]').evaluateAll(images => images.forEach(image => { image.loading = 'eager' }))
      await page.screenshot({ path: join(out, `${label}.png`) })
    }
    async function setRun(run) {
      await page.evaluate(run => window.__STS_DEBUG__.setRun(run), run)
    }
    async function checkRunCompendium(name) {
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: 'Compendium', exact: true }).click()
      await page.getByRole('searchbox', { name: 'Search cards' }).fill('Strike')
      assert.equal(await page.locator('.app-shell--compendium-open').evaluate(element => getComputedStyle(element).display), 'none')
      await capture(name, '.compendium')
      await page.getByRole('button', { name: 'Back to run', exact: true }).click()
    }
    await capture('title', '.start-menu')
    await page.getByRole('button', { name: 'Play online', exact: true }).click()
    await capture('online-entry', '.online-entry')
    await page.getByRole('button', { name: 'Back to solo table', exact: true }).click()
    for (const [button, selector] of [['Achievements', '.compendium'], ['Compendium', '.compendium'], ['Leaderboard', '.leaderboard']]) {
      await page.getByRole('button', { name: button, exact: true }).click()
      if (button === 'Compendium') await page.getByRole('searchbox', { name: 'Search cards' }).fill('Strike')
      await capture(button.toLowerCase(), selector)
      await page.getByRole('button', { name: 'Back to main menu', exact: true }).click()
    }
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await capture('settings', '.settings-dialog')
    await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: /Back/ }).click()
    await page.getByRole('button', { name: 'Single Player', exact: true }).click()
    await capture('run-modes', '.start-menu')
    await page.getByRole('button', { name: 'Daily', exact: true }).click()
    await capture('daily-options', '.start-menu')
    await page.getByRole('button', { name: 'Back', exact: true }).click()
    await page.getByRole('button', { name: 'Custom', exact: true }).click()
    await capture('custom-options', '.start-menu')
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await capture('character-select', '.start-menu')
    await page.getByRole('button', { name: 'Embark' }).click()
    await page.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
    await page.locator('.neow-screen').waitFor()
    await checkRunCompendium('neow-compendium')
    await setRun(base)
    await capture('map', '.app-shell')
    for (const [kind, selector] of [['campfire', '.campfire'], ['merchant', '.merchant-arrival'], ['event', '.event-stage'], ['treasure', '.treasure-stage']]) {
      await setRun(roomRun(kind))
      await capture(kind, selector)
      if (kind === 'merchant') {
        await page.getByRole('button', { name: 'Enter merchant shop' }).click()
        await capture('shop', '.merchant-stage')
      }
      if (kind === 'campfire') {
        await checkRunCompendium('campfire-compendium')
        await page.getByRole('button', { name: /Smith/ }).click()
        await capture('card-picker', '.card-picker')
        await page.locator('.card-picker__back').click()
      }
    }
    for (const phase of ['betweenCombat', 'victory', 'defeat']) {
      await setRun({ ...structuredClone(base), phase, pendingBossDefId: 'slime_boss' })
      await capture(phase, '.room-screen')
      if (phase === 'victory') {
        const relic = page.locator('.run-summary__seat .potion-chip').first()
        await relic.scrollIntoViewIfNeeded()
        await relic.focus()
        await page.waitForTimeout(300) // Browser focus can scroll the summary after React commits.
        const tip = page.locator('body > .potion-tip')
        await tip.waitFor()
        assert(await tip.evaluate(element => {
          const box = element.getBoundingClientRect()
          return box.top >= 0 && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth &&
            element.parentElement === document.body
        }), 'summary relic tooltip must escape its scroller and fit the viewport')
        await page.screenshot({ path: join(out, `summary-relic-${viewport.width}.png`) })
        await page.keyboard.press('Escape')
        for (const track of await page.locator('.run-summary__damage-track').all()) {
          assert(await track.locator('i').evaluate(element => element.getBoundingClientRect().width > 100), 'damage chart track collapsed inside its tooltip anchor')
          await track.scrollIntoViewIfNeeded()
          if (viewport.width === 844) await track.tap()
          else await track.hover()
          await tip.waitFor()
          assert(await tip.evaluate(element => {
            const box = element.getBoundingClientRect()
            return box.top >= 0 && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth
          }), 'damage detail must fit the viewport after scrolling')
          await page.keyboard.press('Escape')
          await page.mouse.move(0, 0)
          await track.evaluate(element => element.blur())
          await page.waitForTimeout(180) // Let the tooltip's hover-leave grace period expire.
          await track.focus()
          await tip.waitFor()
          await page.keyboard.press('Escape')
        }
      }
    }
    for (const [name, run, selector] of extraScreens) {
      await setRun(run)
      await capture(name, selector)
    }
    const combat = roomRun('encounter')
    const enemy = combat.combat.enemies[0]
    combat.combat.enemies = [
      { ...enemy, uid: 'right', hp: 5, maxHp: 5, dead: false },
      { ...enemy, uid: 'left', defId: 'slime_boss', isBoss: true, hp: 5, maxHp: 5, dead: false },
    ]
    await setRun(combat)
    await capture('combat', '.combat')
    const survivor = page.locator('[data-enemy-id="left"]')
    const before = await survivor.boundingBox()
    const scrollBefore = await page.locator('.board').evaluate(board => ({ left: board.scrollLeft, width: board.scrollWidth, viewport: board.clientWidth }))
    await page.evaluate(() => {
      const run = structuredClone(window.__STS_DEBUG__.getRun())
      Object.assign(run.combat.enemies[0], { dead: true, hp: 0 })
      window.__STS_DEBUG__.setRun(run)
    })
    await page.locator('[data-enemy-id="right"]').waitFor({ state: 'detached' })
    const after = await survivor.boundingBox()
    assert(after.x > before.x + 1, 'the survivor should still move into the cleared slot')
    const scrollAfter = await page.locator('.board').evaluate(board => ({ left: board.scrollLeft, width: board.scrollWidth, viewport: board.clientWidth }))
    assert.equal(scrollAfter.left, scrollBefore.left)
    assert(scrollAfter.width <= scrollBefore.width + 1, `enemy death created horizontal overflow: ${JSON.stringify({ scrollBefore, scrollAfter })}`)
    await capture('combat-after-death', '.combat')
    const room = createRoom(rooms.store)
    const seat = joinRoom(room, { character: 'ironclad', name: 'Ironclad' })
    await page.evaluate(saved => sessionStorage.setItem('sts-room-session', JSON.stringify(saved)), { code: room.code, token: seat.token })
    const socketReady = page.waitForEvent('websocket', { predicate: socket => new URL(socket.url()).pathname === '/ws' })
    await page.reload()
    const socket = await socketReady
    await capture('online-lobby', '.online-lobby')
    await page.locator('.connection--connected').waitFor()
    const partySeats = [seat, ...['silent', 'defect', 'watcher'].map(character => joinRoom(room, { character, name: character }))]
    const partySummary = postNeowRun('party-summary', partySeats.map(seat => ({ id: seat.playerId, name: seat.name, character: seat.character })))
    partySummary.phase = 'victory'
    const onlineScreens = [
      ['map', base, '.map'],
      ...['campfire', 'merchant', 'event', 'treasure'].map(kind => [kind, roomRun(kind), kind === 'merchant' ? '.merchant-arrival' : `.${kind === 'campfire' ? kind : kind + '-stage'}`]),
      ...extraScreens,
      ...['betweenCombat', 'victory', 'defeat'].map(phase => [phase, { ...structuredClone(base), phase, pendingBossDefId: 'slime_boss' }, '.room-screen']),
      ['combat', combat, '.combat'],
      ['party-victory', partySummary, '.room-screen'],
    ]
    for (const [name, run, selector] of onlineScreens) {
      room.run = structuredClone(run)
      room.phase = 'run'
      room.version += 1
      const update = socket.waitForEvent('framereceived', { predicate: frame => {
        try { return JSON.parse(String(frame.payload)).snapshot?.version === room.version } catch { return false }
      } })
      rooms.publishRoom(room.code)
      await update
      await capture(`online-${name}`, selector)
      if (name === 'campfire') await checkRunCompendium('online-campfire-compendium')
      if (name === 'merchant') {
        await page.getByRole('button', { name: 'Enter merchant shop' }).click()
        await capture('online-shop', '.merchant-stage')
      }
      if (name === 'party-victory') {
        const relic = page.locator('.run-summary__seat .potion-chip').last()
        await relic.focus()
        await page.waitForTimeout(300)
        await page.locator('.run-summary').evaluate(element => { element.scrollTop = 0 })
        await page.waitForTimeout(300)
        const tip = page.locator('body > .potion-tip')
        assert(await tip.evaluate(element => {
          const box = element.getBoundingClientRect()
          return box.top >= 0 && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth
        }), 'a focused tooltip must stay in the viewport when its trigger scrolls away')
        await page.screenshot({ path: join(out, `party-summary-relic-${viewport.width}.png`) })
      }
    }
    await context.close()
  }
  writeFileSync(join(out, 'geometry.json'), JSON.stringify(results, null, 2))
  assert.deepEqual(failures, [])
  console.log(`Viewport audit passed: ${results.length} screens`)
} finally {
  await browser.close()
  await server.close()
  await rooms.close()
}
