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
    const context = await browser.newContext({ viewport, isMobile: screen === 'horizontal-phone',
      hasTouch: screen === 'horizontal-phone', reducedMotion: 'no-preference' })
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
      return combat.evaluate(element => {
        const board = element.querySelector('.board')
        const boardBounds = board.getBoundingClientRect()
        return {
          scale: +getComputedStyle(element).getPropertyValue('--stage-scale'),
          slots: +getComputedStyle(element).getPropertyValue('--stage-enemy-count'),
          board: { left: boardBounds.left, right: boardBounds.right, scrollLeft: board.scrollLeft },
          actors: [...element.querySelectorAll('.row__seat, .enemy')].map(actor => ({
            id: actor.dataset.enemyId ?? actor.querySelector('.seat[data-player-id]')?.dataset.playerId,
            ...Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, actor.getBoundingClientRect()[key]])),
          })),
        }
      })
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
    const crowded = await layout(9)
    assert.equal(snapshot().initialEnemyCount, 9, `${screen}: original count missing from server snapshot`)
    assert.equal(crowded.slots, 9, `${screen}: initial encounter has nine enemy slots`)
    assert(await combat.getAttribute('data-stage-motion') !== null, `${screen}: stage motion unexpectedly disabled`)
    await page.locator('.board').evaluate(board => { board.scrollLeft = board.scrollWidth })
    await combat.evaluate(element => {
      window.reflowTransitions = []
      element.addEventListener('transitionrun', event => {
        if (event.target === element) window.reflowTransitions.push(event.propertyName)
        else if (event.target instanceof HTMLElement && event.target.dataset.enemyId === 'enemy-8') {
          window.reflowTransitions.push(`enemy-8:${event.propertyName}`)
        }
      })
    })

    for (let index = 0; index < 9; index++) {
      if (![0, 4, 8].includes(index)) Object.assign(room.run.combat.enemies[index], { hp: 0, dead: true })
    }
    publish()
    const before = await layout(3)
    assert.equal(snapshot().initialEnemyCount, 9, `${screen}: saved encounter count should remain available`)
    const recoveryTransitions = await page.evaluate(() => window.reflowTransitions)
    assert.equal(before.slots, 3, `${screen}: kills must release the empty enemy slots`)
    assert(before.scale > crowded.scale + .05, `${screen}: survivors must grow without reload`)
    assert(recoveryTransitions.includes('--stage-scale') && recoveryTransitions.includes('--stage-enemy-count'),
      `${screen}: stage did not animate its scale and formation: ${recoveryTransitions}`)
    assert(recoveryTransitions.includes('enemy-8:--stage-index'),
      `${screen}: the rightmost survivor jumped to its new slot: ${recoveryTransitions}`)
    assert.equal(before.board.scrollLeft, 0, `${screen}: the board must recenter when survivors fit`)
    assert(before.actors.every(actor => actor.x >= before.board.left - 2 &&
      actor.x + actor.width <= before.board.right + 2), `${screen}: a survivor is still offscreen`)
    assert(before.actors.some(actor => actor.id === 'enemy-8'), `${screen}: rightmost original enemy was lost`)
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
    assert.equal(recovered.slots, 3, `${screen}: dead summons must release their slots`)
    sameLayout(before, recovered)

    delete room.run.combat.initialEnemyCount
    publish()
    assert.equal(snapshot().initialEnemyCount, 9, `${screen}: old saved fights must exclude summoned enemies`)
    sameLayout(recovered, await layout(3))
    await page.reload()
    await page.locator('.connection--connected').waitFor()
    sameLayout(recovered, await layout(3))
    assert.deepEqual(errors, [], `${screen}: uncaught browser errors`)
    await context.close()
    console.log(`PASS ${screen}: online survivors reflow smoothly and retain their formation after reconnect`)
  }
} finally {
  await browser.close()
  await server.close()
  await rooms.close()
}
