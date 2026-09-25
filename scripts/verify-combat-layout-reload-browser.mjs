import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium } from './lib/profile-browser.mjs'
import { createRoom, joinRoom, snapshotFor, startRun } from './lib/rooms.mjs'
import { createRoomServer } from './room-server.mjs'
import { createCombat } from '../src/game/combat.ts'
import { createRng } from '../src/game/rng.ts'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'artifacts/combat-layout-reload')
mkdirSync(output, { recursive: true })
const rooms = createRoomServer({ classifierEnabled: false })
const room = createRoom(rooms.store, { code: 'LAYOUT' })
const host = joinRoom(room, { name: 'Ann', character: 'ironclad' })
for (const [name, character] of [['Bo', 'silent'], ['Cy', 'defect'], ['Dee', 'watcher']]) {
  joinRoom(room, { name, character })
}
startRun(room, host.token, { seed: 47 })
room.run.phase = 'combat'
room.run.combat = createCombat(createRng(47), room.run.players, Array.from({ length: 9 }, (_, index) => ({
  uid: `enemy-${index}`, defId: 'sentry_a', row: index % 4, isBoss: false,
  hp: 50, maxHp: 50, block: 0, strength: 0, weak: 0, vulnerable: 0, poison: 0,
  goldReward: 0, cardReward: null, actionIndex: 0, phase: 0, abilityUsed: false, dead: false,
})))
const originalCombat = structuredClone(room.run.combat)
const snapshot = () => JSON.parse(JSON.stringify(snapshotFor(room, host.token).run.combat))
const publish = () => { room.version++; rooms.publishRoom(room.code) }

const roomAddress = await rooms.listen(0)
const server = await createServer({ root, logLevel: 'silent', server: {
  host: '127.0.0.1', port: 0,
  proxy: {
    '/api': { target: `http://127.0.0.1:${roomAddress.port}` },
    '/ws': { target: `http://127.0.0.1:${roomAddress.port}`, ws: true },
  },
} })
await server.listen()
const browser = await chromium.launch({ headless: true })
try {
  for (const [screen, viewport] of [['desktop', { width: 1440, height: 900 }],
    ['horizontal-phone', { width: 844, height: 390 }]]) {
    room.run.combat = structuredClone(originalCombat)
    publish()
    const context = await browser.newContext({ viewport, isMobile: screen === 'horizontal-phone', hasTouch: screen === 'horizontal-phone' })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.stack ?? String(error)))
    const url = `http://127.0.0.1:${server.httpServer.address().port}`
    await page.goto(url)
    await page.evaluate(({ code, token }) => {
      sessionStorage.setItem('sts-room-session', JSON.stringify({ code, token }))
    }, { code: room.code, token: host.token })
    await page.reload()
    const combat = page.locator('.app-shell--online .combat')
    await combat.waitFor()
    await page.locator('.connection--connected').waitFor()

    const layout = async (count) => {
      await page.waitForFunction(expected => document.querySelectorAll('.app-shell--online .enemy').length === expected, count)
      await page.waitForTimeout(1000)
      return combat.evaluate(element => ({
        scale: +getComputedStyle(element).getPropertyValue('--stage-scale'),
        slots: +getComputedStyle(element).getPropertyValue('--stage-enemy-count'),
        actors: [...element.querySelectorAll('.row__seat, .enemy')].map(actor => ({
          id: actor.dataset.enemyId ?? actor.querySelector('.seat[data-player-id]')?.dataset.playerId,
          ...Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, actor.getBoundingClientRect()[key]])),
        })),
      }))
    }
    const sameLayout = (before, after) => {
      assert.equal(after.slots, before.slots, `${screen}: reload changed enemy slots`)
      assert(Math.abs(after.scale - before.scale) < .001, `${screen}: reload changed stage scale`)
      assert.deepEqual(after.actors.map(actor => actor.id), before.actors.map(actor => actor.id))
      after.actors.forEach((actor, index) => {
        for (const key of ['x', 'y', 'width', 'height']) {
          assert(Math.abs(actor[key] - before.actors[index][key]) < 2,
            `${screen}: reload moved ${actor.id} (${key})`)
        }
      })
    }
    assert.equal(snapshot().initialEnemyCount, 9, `${screen}: original count missing from server snapshot`)
    assert.equal((await layout(9)).slots, 9, `${screen}: initial encounter has nine enemy slots`)

    for (let index = 3; index < 9; index++) {
      Object.assign(room.run.combat.enemies[index], { hp: 0, dead: true })
    }
    publish()
    const before = await layout(3)
    assert.equal(before.slots, 9, `${screen}: kills must retain the original slots`)
    assert(before.actors.every(actor => actor.id), `${screen}: actors must be identified across reload`)
    await page.screenshot({ path: resolve(output, `${screen}-before.png`) })

    await page.reload()
    await page.locator('.connection--connected').waitFor()
    sameLayout(before, await layout(3))
    await page.screenshot({ path: resolve(output, `${screen}-after.png`) })

    room.run.combat.enemies.push(...Array.from({ length: 7 }, (_, index) => ({
      ...room.run.combat.enemies[0], uid: `enemy-0-summon-1-0-${index}`, dead: false, hp: 50,
    })))
    publish()
    assert.equal((await layout(10)).slots, 10, `${screen}: live summons must grow the stage`)
    room.run.combat.enemies.slice(-7).forEach(enemy => Object.assign(enemy, { hp: 0, dead: true }))
    publish()
    const recovered = await layout(3)
    assert.equal(recovered.slots, 9, `${screen}: dead summons must not expand the baseline`)

    delete room.run.combat.initialEnemyCount
    publish()
    assert.equal(snapshot().initialEnemyCount, 9, `${screen}: old saved fights must exclude summoned enemies`)
    sameLayout(recovered, await layout(3))
    await page.reload()
    await page.locator('.connection--connected').waitFor()
    sameLayout(recovered, await layout(3))
    assert.deepEqual(errors, [], `${screen}: uncaught browser errors`)
    await context.close()
    console.log(`PASS ${screen}: online reconnect preserves formation after deaths and summons`)
  }
} finally {
  await browser.close()
  await server.close()
  await rooms.close()
}
