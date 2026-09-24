import assert from 'node:assert/strict'
import { chromium, setTestUsername } from './lib/profile-browser.mjs'
import { createServer as createViteServer } from 'vite'
import { createRoomServer } from './room-server.mjs'
import { apply, startRun } from './lib/rooms.mjs'
import { createCombat } from '../src/game/combat.ts'
import { createRng } from '../src/game/rng.ts'

process.env.VITE_HOSTED_SESSION = 'true'
let roomOrigin = ''
const vite = await createViteServer({
  logLevel: 'silent',
  server: { host: '127.0.0.1', port: 0 },
  plugins: [{
    name: 'room-session-fixture',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith('/session.json')) return next()
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ origin: roomOrigin, protocolVersion: 1, alwaysOn: true }))
      })
    },
  }],
})
let rooms
let browser
try {
  await vite.listen()
  const viteAddress = vite.httpServer.address()
  assert(viteAddress && typeof viteAddress !== 'string')
  const pagesOrigin = `http://127.0.0.1:${viteAddress.port}`
  rooms = createRoomServer({ allowedOrigin: pagesOrigin })
  const address = await rooms.listen(0)
  roomOrigin = `http://127.0.0.1:${address.port}`
  browser = await chromium.launch({ headless: true })
  const desktop = process.env.VERIFY_DESKTOP === 'true'
  for (const unknown of [false, true]) {
    const context = await browser.newContext({
      viewport: desktop ? { width: 1440, height: 900 } : { width: 844, height: 390 },
      hasTouch: !desktop,
    })
    await context.addInitScript(() => {
      window.__ROOM_SOCKETS__ = []
      window.WebSocket = new Proxy(window.WebSocket, {
        construct(Target, args) {
          const socket = new Target(...args)
          socket.addEventListener('message', (event) => {
            const message = JSON.parse(String(event.data))
            if (window.__DROP_HERMIT_ACK__ && message.type === 'snapshot' && message.requestId) {
              window.__DROPPED_HERMIT_ACK__ = true
              window.__DROP_HERMIT_ACK__ = false
              event.stopImmediatePropagation()
              socket.close(4000, 'Simulated lost action acknowledgement')
              return
            }
            if (window.__SUPPRESS_ROOM_UPDATES__ && message.type === 'snapshot') {
              event.stopImmediatePropagation()
            } else if (message.type === 'snapshot') {
              window.__LAST_SEEN_ROOM_VERSION__ = message.snapshot.version
            }
          })
          const send = socket.send.bind(socket)
          socket.send = (raw) => {
            const message = JSON.parse(String(raw))
            if (message.type === 'action' && message.action?.kind === 'playHermitChamberCard') {
              window.__SENT_HERMIT_ACTION__ = message.action
            }
            send(raw)
          }
          window.__ROOM_SOCKETS__.push(socket)
          return socket
        },
      })
    })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(String(error)))
    await page.goto(pagesOrigin)
    await setTestUsername(page, 'Hermit')
    await page.getByRole('button', { name: 'Play online' }).click()
    await page.locator('.online-character-roster').getByRole('button', { name: 'Hermit' }).click()
    await page.getByRole('button', { name: 'Create room' }).click()
    const code = await page.locator('.online-lobby h1').textContent()
    assert(code)
    const room = rooms.store.rooms.get(code)
    assert(room)
    startRun(room, room.seats[0].token, { seed: 914, campaign: 'downfall' })
    const run = room.run
    const enemy = { uid: 'load-reconnect-enemy', defId: 'jaw_worm', row: 0, isBoss: false,
      hp: 40, maxHp: 40, block: 0, strength: 0, vulnerable: 0, weak: 0, poison: 0,
      goldReward: 0, cardReward: null, actionIndex: 0, abilityUsed: false, dead: false }
    run.combat = createCombat(createRng(914), run.players, [enemy], 'hermit-load-reconnect')
    const hermit = run.combat.players[0]
    run.combat.pendingHermitSetupLoads = []
    hermit.energy = 2
    hermit.hand = [{ uid: 'load-reconnect-defend', defId: 'hermit_defend', upgraded: false }]
    hermit.draw = [{ uid: 'load-reconnect-pistol', defId: 'hermit_pistol_whip', upgraded: false }]
    hermit.chamber = [{ uid: 'load-reconnect-quickdraw', defId: 'hermit_quickdraw', upgraded: false }]
    run.phase = 'combat'
    run.neow = null
    room.version += 1
    rooms.publishRoom(code)
    await page.locator('.app-shell--online .combat').waitFor()
    apply(room, room.seats[0].token, {
      kind: 'previewHermitChamberCard', cardUid: 'load-reconnect-quickdraw', enemyUid: enemy.uid,
      energySpent: 0,
    })
    rooms.publishRoom(code)
    const dialog = page.getByRole('dialog', { name: /Choose 1 to Load/ })
    await dialog.waitFor()
    await dialog.getByRole('button', { name: /^Pistol Whip,/ }).click()
    await page.evaluate(() => window.__ROOM_SOCKETS__.at(-1).close(4000, 'Simulated preview disconnect'))
    await page.waitForFunction(() => window.__ROOM_SOCKETS__.length > 1 &&
      window.__ROOM_SOCKETS__.at(-1).readyState === WebSocket.OPEN)
    await page.locator('.connection--connected').waitFor()
    assert.equal(await dialog.getByRole('button', { name: /^Pistol Whip,/ }).getAttribute('aria-pressed'), 'true')
    let failedRefreshes = 0
    let allowRefresh = false
    if (unknown) {
      await page.route(`${roomOrigin}/api/rooms/${code}`, (route) => {
        if (route.request().method() === 'GET' && !allowRefresh) {
          failedRefreshes += 1
          return route.abort('connectionreset')
        }
        return route.continue()
      })
      await page.evaluate(() => { window.__SUPPRESS_ROOM_UPDATES__ = true })
    }
    await page.evaluate(() => { window.__DROP_HERMIT_ACK__ = true })
    await dialog.getByRole('button', { name: 'Load 1 card', exact: true }).click()
    await page.waitForFunction(() => window.__DROPPED_HERMIT_ACK__ === true, null, { timeout: 15_000 })
    assert.equal(await page.evaluate(() => window.__SENT_HERMIT_ACTION__?.energySpent), undefined,
      'non-X Chamber play must omit the X cost')
    if (unknown) {
      for (let attempt = 0; attempt < 50 && failedRefreshes < 3; attempt += 1) {
        await page.waitForTimeout(100)
      }
      assert(failedRefreshes >= 3, 'uncertain action did not exhaust immediate refreshes')
      await page.waitForTimeout(1_000)
      assert(await page.evaluate((version) => window.__LAST_SEEN_ROOM_VERSION__ < version, room.version),
        'the client saw the committed state before its unknown outcome')
      assert(await page.locator('.online-mutations').evaluate((element) => element.inert),
        'the client allowed another card before the unknown action was reconciled')
      allowRefresh = true
      await page.evaluate(() => { window.__SUPPRESS_ROOM_UPDATES__ = false })
      rooms.publishRoom(code)
    }
    await page.locator('.connection--connected').waitFor()
    await dialog.waitFor({ state: 'hidden' })
    assert.equal(room.run.combat.players[0].chamber[0].defId, 'hermit_pistol_whip')
    assert.equal(room.cardPreviews?.[hermit.id], undefined)
    const defend = page.locator('.hand .card[title="Defend"]')
    await defend.waitFor()
    await page.waitForFunction(() => document.querySelector('.hand .card[title="Defend"]')
      ?.getAttribute('aria-disabled') === 'false')
    await defend.click()
    await page.waitForFunction(() => document.querySelector('.hand .card[title="Defend"]') === null)
    assert(room.run.combat.players[0].block > 0, 'the next card was still locked after Load')
    assert.deepEqual(errors, [])
    console.log(`✓ hosted Hermit Load clears its modal after ${unknown ? 'unknown delivery' : 'a lost acknowledgement'}`)
    await context.close()
  }
} finally {
  await browser?.close()
  await vite.close()
  await rooms?.close()
}
