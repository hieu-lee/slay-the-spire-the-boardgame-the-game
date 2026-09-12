import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { chromium as rawChromium } from 'playwright'
import { chromium, setTestUsername } from './lib/profile-browser.mjs'
import { createServer as createViteServer } from 'vite'
import { createRoomServer } from './room-server.mjs'
import { createRoom, createStore, joinRoom, saveStore } from './lib/rooms.mjs'

process.env.VITE_HOSTED_SESSION = 'true'
const root = resolve(import.meta.dirname, '..')
const temporary = mkdtempSync(join(tmpdir(), 'sts-session-handoff-'))
const storeFile = join(temporary, 'rooms.json')
let roomOrigin = ''
let roomOrigins = []
let stallSessionConfig = false
const tunnels = []

async function startTunnel(target) {
  const tunnel = await createViteServer({
    configFile: false,
    logLevel: 'silent',
    server: {
      host: '127.0.0.1',
      port: 0,
      cors: false,
      proxy: {
        '/api': { target },
        '/ws': { target, ws: true },
      },
    },
  })
  await tunnel.listen()
  tunnels.push(tunnel)
  const address = tunnel.httpServer?.address()
  if (!address || typeof address === 'string') throw new Error('tunnel proxy did not report a port')
  return `http://127.0.0.1:${address.port}`
}

const vite = await createViteServer({
  root,
  logLevel: 'silent',
  server: { host: '127.0.0.1', port: 0 },
  plugins: [{
    name: 'session-handoff-fixture',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith('/session.json')) return next()
        if (stallSessionConfig) return request.once('close', () => response.destroy())
        response.setHeader('content-type', 'application/json')
        response.setHeader('cache-control', 'no-store')
        response.end(JSON.stringify({ origin: roomOrigin, origins: roomOrigins, protocolVersion: 1 }))
      })
    },
  }],
})
await vite.listen()
const viteAddress = vite.httpServer?.address()
if (!viteAddress || typeof viteAddress === 'string') throw new Error('vite did not report a port')
const pagesOrigin = `http://127.0.0.1:${viteAddress.port}`
let partialUpgrades = 0
let partialTarget
const partialWebSockets = new WebSocketServer({ noServer: true })
const partialTunnel = createServer((request, response) => {
  if (!partialTarget) {
    response.writeHead(503)
    return response.end()
  }
  const upstream = httpRequest(new URL(request.url ?? '/', partialTarget), {
    method: request.method, headers: request.headers,
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
    upstreamResponse.pipe(response)
  })
  request.pipe(upstream)
})
partialTunnel.on('upgrade', (request, socket, head) => {
  partialWebSockets.handleUpgrade(request, socket, head, () => { partialUpgrades += 1 })
})
await new Promise((resolveListen) => partialTunnel.listen(0, '127.0.0.1', resolveListen))
const partialAddress = partialTunnel.address()
const partialOrigin = `http://127.0.0.1:${partialAddress.port}`

let rooms = createRoomServer({ storeFile, allowedOrigin: pagesOrigin })
let roomAddress = await rooms.listen(0)
const roomTarget = `http://127.0.0.1:${roomAddress.port}`
roomOrigin = await startTunnel(roomTarget)
const healthyRoomOrigin = roomOrigin
const secondaryRoomOrigin = await startTunnel(roomTarget)
const tertiaryRoomOrigin = await startTunnel(roomTarget)
let unreliablePath = '/api/profile'
let unreliableMethod = 'POST'
let unreliableMode = 'stall'
let unreliableRequests = 0
let unreliableEntryRequestIds = false
const unreliableServer = createServer((request, response) => {
  response.setHeader('access-control-allow-origin', pagesOrigin)
  response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
  response.setHeader('access-control-allow-headers', 'content-type')
  if (request.method === 'OPTIONS') {
    response.writeHead(204)
    return response.end()
  }
  if (request.url === '/api/health') {
    response.setHeader('content-type', 'application/json')
    return response.end(JSON.stringify({ protocolVersion: 1, entryRequestIds: unreliableEntryRequestIds }))
  }
  if (request.method === unreliableMethod && request.url?.startsWith(unreliablePath)) {
    unreliableRequests += 1
    roomOrigin = healthyRoomOrigin
    roomOrigins = [healthyRoomOrigin]
    if (unreliableMode === 'malformed') {
      response.setHeader('content-type', 'application/json')
      return response.end('{')
    }
    return request.once('close', () => response.destroy())
  }
  response.writeHead(404)
  response.end()
})
await new Promise((resolveListen) => unreliableServer.listen(0, '127.0.0.1', resolveListen))
const unreliableAddress = unreliableServer.address()
const unreliableOrigin = `http://127.0.0.1:${unreliableAddress.port}`
const browser = await chromium.launch({ headless: true })
const profileBrowser = await rawChromium.launch({ headless: true })
const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const phone = await browser.newContext({ viewport: { width: 560, height: 315 } })
const host = await desktop.newPage()
const guest = await phone.newPage()
const hostWebSockets = []
host.on('websocket', (webSocket) => hostWebSockets.push(webSocket.url()))

async function enter(page, name, character, code) {
  await page.goto(pagesOrigin, { waitUntil: 'networkidle' })
  await setTestUsername(page, name)
  await page.getByRole('button', { name: 'Play online' }).click()
  await page.locator('.online-character-roster').getByRole('button', { name: character }).click()
  if (code) {
    await page.getByLabel('Room code').fill(code)
    await page.getByRole('button', { name: 'Join', exact: true }).click()
  } else await page.getByRole('button', { name: 'Create room' }).click()
  await page.locator('.online-lobby').waitFor()
}

try {
  const useUnreliableOrigin = (path, method = 'GET', mode = 'stall', entryRequestIds = false) => {
    unreliablePath = path
    unreliableMethod = method
    unreliableMode = mode
    unreliableRequests = 0
    unreliableEntryRequestIds = entryRequestIds
    roomOrigin = unreliableOrigin
    roomOrigins = [unreliableOrigin]
  }
  useUnreliableOrigin('/api/profile', 'POST')
  const profilePage = await profileBrowser.newPage({ viewport: { width: 1440, height: 900 } })
  await profilePage.goto(pagesOrigin, { waitUntil: 'networkidle' })
  await profilePage.getByRole('button', { name: /Tap, click, or press any key/ }).click()
  await profilePage.getByLabel('How should we call you?').fill('Failover User')
  await profilePage.getByRole('button', { name: 'Confirm username' }).click()
  await profilePage.getByRole('button', { name: 'Play online' }).waitFor({ timeout: 15_000 })
  assert.equal(unreliableRequests, 1, 'profile registration did not exercise the stalled primary')

  useUnreliableOrigin('/api/profile', 'POST', 'malformed')
  const malformedProfilePage = await profileBrowser.newPage({ viewport: { width: 1440, height: 900 } })
  await malformedProfilePage.goto(pagesOrigin, { waitUntil: 'networkidle' })
  await malformedProfilePage.getByRole('button', { name: /Tap, click, or press any key/ }).click()
  await malformedProfilePage.getByLabel('How should we call you?').fill('Malformed Failover')
  await malformedProfilePage.getByRole('button', { name: 'Confirm username' }).click()
  await malformedProfilePage.getByRole('button', { name: 'Play online' }).waitFor()
  assert.equal(unreliableRequests, 1, 'profile registration did not reject a malformed primary response')

  useUnreliableOrigin('/api/leaderboard', 'POST')
  const queuedAfterFailover = await profilePage.evaluate(async () => {
    localStorage.setItem('sts-leaderboard-outbox', JSON.stringify([{
      id: 'failover-browser', character: 'ironclad', ascension: 0, mode: 'standard',
      damageStatsComplete: true, startedAtAct: 1, highestBossActDefeated: 0,
      combatsFinished: 0, damageDealt: 0, damageTaken: 0, damageBlocked: 0,
    }]))
    const { resetRoomEndpoint } = await import('/src/multiplayer/room-endpoint.ts')
    resetRoomEndpoint()
    const { flushLeaderboardOutbox } = await import('/src/leaderboard.ts')
    await flushLeaderboardOutbox(true)
    return JSON.parse(localStorage.getItem('sts-leaderboard-outbox') ?? '[]').length
  })
  assert.equal(queuedAfterFailover, 0, 'leaderboard submission did not fail over from a stalled primary')
  assert.equal(unreliableRequests, 1)

  useUnreliableOrigin('/api/leaderboard', 'GET')
  const leaderboard = await profilePage.evaluate(async () => {
    const { resetRoomEndpoint } = await import('/src/multiplayer/room-endpoint.ts')
    resetRoomEndpoint()
    return (await import('/src/leaderboard.ts')).loadLeaderboard()
  })
  assert.equal(typeof leaderboard.totalRuns, 'number')
  assert.equal(unreliableRequests, 1, 'leaderboard read did not fail over from a stalled primary')

  useUnreliableOrigin('/api/leaderboard/decks', 'GET')
  const decks = await profilePage.evaluate(async () => {
    const { resetRoomEndpoint } = await import('/src/multiplayer/room-endpoint.ts')
    resetRoomEndpoint()
    return (await import('/src/leaderboard.ts')).loadWinningDecks(new URLSearchParams(), new AbortController().signal)
  })
  assert.equal(typeof decks.total, 'number')
  assert.equal(unreliableRequests, 1, 'winning-deck read did not fail over from a stalled primary')

  stallSessionConfig = true
  const configTimeout = await profilePage.evaluate(async () => {
    const { resetRoomEndpoint, roomUrl } = await import('/src/multiplayer/room-endpoint.ts')
    resetRoomEndpoint()
    const started = Date.now()
    try {
      await roomUrl('/api/health')
      return -1
    } catch {
      return Date.now() - started
    }
  })
  stallSessionConfig = false
  assert(configTimeout >= 4_500 && configTimeout < 6_000, `session config timed out after ${configTimeout}ms`)

  useUnreliableOrigin('/api/rooms', 'POST', 'malformed')
  await host.goto(pagesOrigin, { waitUntil: 'networkidle' })
  await setTestUsername(host, 'Legacy Host')
  await host.getByRole('button', { name: 'Play online' }).click()
  await host.locator('.online-character-roster').getByRole('button', { name: 'Ironclad' }).click()
  await host.getByRole('button', { name: 'Create room' }).click()
  await host.getByRole('alert').waitFor()
  assert.equal(unreliableRequests, 1, 'a legacy server without request IDs retried room creation')

  let splitInitialConnection = true
  await host.route(`${healthyRoomOrigin}/api/rooms/*`, async (route) => {
    if (splitInitialConnection && route.request().method() === 'GET') {
      splitInitialConnection = false
      roomOrigin = secondaryRoomOrigin
      roomOrigins = [secondaryRoomOrigin]
      await host.evaluate(async () => (await import('/src/multiplayer/room-endpoint.ts')).resetRoomEndpoint())
    }
    await route.continue()
  })
  useUnreliableOrigin('/api/rooms', 'POST', 'stall', true)
  await host.addInitScript(() => {
    const addEventListener = WebSocket.prototype.addEventListener
    window.__roomAddEventListener = addEventListener
    WebSocket.prototype.addEventListener = function (type, listener, options) {
      if (type !== 'close') return addEventListener.call(this, type, listener, options)
      return addEventListener.call(this, type, function (event) {
        if (window.__holdNextRoomClose) {
          window.__holdNextRoomClose = false
          window.__heldRoomClose = () => listener.call(this, event)
          return
        }
        return listener.call(this, event)
      }, options)
    }
  })
  await enter(host, 'Host', 'Ironclad')
  await host.unroute(`${healthyRoomOrigin}/api/rooms/*`)
  assert.equal(unreliableRequests, 1, 'room creation did not fail over from a stalled primary')
  assert(hostWebSockets.at(-1).startsWith(secondaryRoomOrigin.replace('http', 'ws')),
    'the connect-time endpoint fixture did not move the WebSocket from the initial REST origin')
  const credentials = await host.evaluate(() => JSON.parse(sessionStorage.getItem('sts-room-session')))
  useUnreliableOrigin(`/api/rooms/${credentials.code}/join`, 'POST', 'stall', true)
  await enter(guest, 'Guest', 'Silent', credentials.code)
  assert.equal(unreliableRequests, 1, 'room join did not fail over from a stalled primary')
  const guestCredentials = await guest.evaluate(() => JSON.parse(sessionStorage.getItem('sts-room-session')))
  const liveBeforeProbe = rooms.store.rooms.get(credentials.code)
  liveBeforeProbe.seats[0].name = 'Liveness Host'
  liveBeforeProbe.version += 1
  const socketsBeforeProbe = hostWebSockets.length
  await host.getByText('Liveness Host', { exact: true }).waitFor({ timeout: 15_000 })
  assert.equal(hostWebSockets.length, socketsBeforeProbe, 'HTTP liveness catch-up unnecessarily reconnected the socket')
  roomOrigin = secondaryRoomOrigin
  roomOrigins = [secondaryRoomOrigin, tertiaryRoomOrigin]
  await host.route(`${tertiaryRoomOrigin}/api/health`, async (route) => {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
    await route.continue()
  })
  liveBeforeProbe.seats[0].connected = false
  await host.locator('.connection--reconnecting').waitFor({ timeout: 15_000 })
  await host.locator('.connection--connected').waitFor({ timeout: 15_000 })
  assert.equal(hostWebSockets.length, socketsBeforeProbe + 1, 'a server-disconnected seat kept a silent WebSocket')
  await host.unroute(`${tertiaryRoomOrigin}/api/health`)
  assert(hostWebSockets.at(-1).startsWith(tertiaryRoomOrigin.replace('http', 'ws')),
    'a connect-time endpoint race quarantined the initial REST origin instead of the actual WebSocket origin')
  roomOrigin = tertiaryRoomOrigin
  roomOrigins = [tertiaryRoomOrigin, healthyRoomOrigin]
  await host.evaluate(() => {
    const close = WebSocket.prototype.close
    window.__roomClose = close
    WebSocket.prototype.close = function (code, reason) {
      if (code === 4000) return
      close.call(this, code, reason)
    }
    window.__holdNextRoomClose = true
  })
  await host.route(`${tertiaryRoomOrigin}/api/rooms/${credentials.code}`, async (route) => {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 6_000))
    await route.abort('timedout')
  })
  await host.locator('.connection--reconnecting').waitFor({ timeout: 20_000 })
  await host.locator('.connection--connected').waitFor({ timeout: 20_000 })
  await host.evaluate(() => {
    WebSocket.prototype.close = window.__roomClose
    WebSocket.prototype.addEventListener = window.__roomAddEventListener
    delete window.__roomClose
    delete window.__roomAddEventListener
  })
  assert(await host.evaluate(() => typeof window.__heldRoomClose === 'function'),
    'the stale WebSocket close was not held for the action race')
  assert(hostWebSockets.at(-1).startsWith(healthyRoomOrigin.replace('http', 'ws')),
    'an established blackholed WebSocket did not fail over independently of close')
  await host.unroute(`${tertiaryRoomOrigin}/api/rooms/${credentials.code}`)
  await host.getByRole('button', { name: 'Enter the Spire' }).click()
  await host.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
  await Promise.all([
    host.getByRole('heading', { name: 'Neow’s Blessing' }).waitFor(),
    guest.getByRole('heading', { name: 'Neow’s Blessing' }).waitFor(),
  ])
  const liveRoom = rooms.store.rooms.get(credentials.code)
  const ownerId = liveRoom.seats[0].playerId
  Object.assign(liveRoom.run, { phase: 'map', neow: null })
  liveRoom.version += 1
  rooms.publishRoom(liveRoom.code)
  await host.locator('.map:not([inert]) .room--reachable').first().waitFor()
  const mapBeforeLegacyAction = structuredClone(liveRoom.run.map)
  roomOrigin = secondaryRoomOrigin
  roomOrigins = [secondaryRoomOrigin]
  await host.route(`${secondaryRoomOrigin}/api/health`, async (route) => {
    const response = await route.fetch()
    const { webSocketActionAcks: _ignored, ...legacyHealth } = await response.json()
    await route.fulfill({ response, body: JSON.stringify(legacyHealth), contentType: 'application/json' })
  })
  const socketsBeforeLegacy = hostWebSockets.length
  rooms.dropConnection(credentials.code, credentials.token)
  await host.locator('.connection--reconnecting').waitFor()
  await host.locator('.connection--connected').waitFor()
  assert(hostWebSockets.length > socketsBeforeLegacy, 'the legacy-capability fixture did not replace its socket')
  await host.unroute(`${secondaryRoomOrigin}/api/health`)
  const endpointNowSupportsAcks = await host.evaluate(async () => {
    const endpoint = await import('/src/multiplayer/room-endpoint.ts')
    endpoint.resetRoomEndpoint()
    await endpoint.roomUrl('/api/health')
    return endpoint.supportsWebSocketActionAcks()
  })
  assert(endpointNowSupportsAcks, 'the rolling endpoint fixture did not discover action acknowledgements')
  let legacyHttpActions = 0
  await host.route('**/api/rooms/*/action', async (route) => {
    legacyHttpActions += 1
    await route.continue()
  })
  await host.locator('.map:not([inert]) .room--reachable').first().click()
  await host.locator('.combat').waitFor()
  assert.equal(legacyHttpActions, 1, 'an old socket inherited a newer endpoint\'s acknowledgement capability')
  await host.unroute('**/api/rooms/*/action')
  Object.assign(liveRoom.run, { phase: 'map', combat: null, roomState: null, map: mapBeforeLegacyAction })
  liveRoom.version += 1
  rooms.publishRoom(liveRoom.code)
  await host.locator('.map:not([inert]) .room--reachable').first().waitFor()
  const socketsBeforeAcknowledged = hostWebSockets.length
  rooms.dropConnection(credentials.code, credentials.token)
  await host.locator('.connection--reconnecting').waitFor()
  await host.locator('.connection--connected').waitFor()
  assert(hostWebSockets.length > socketsBeforeAcknowledged, 'the acknowledged socket fixture did not reconnect')
  const socketsBeforeMissingAck = hostWebSockets.length
  await host.evaluate(() => {
    const send = WebSocket.prototype.send
    window.__roomSend = send
    WebSocket.prototype.send = function (data) {
      if (JSON.parse(String(data)).type === 'action') return
      return send.call(this, data)
    }
  })
  await host.locator('.map:not([inert]) .room--reachable').first().click()
  await host.locator('.connection--reconnecting').waitFor({ timeout: 12_000 })
  await host.evaluate(() => {
    WebSocket.prototype.send = window.__roomSend
    delete window.__roomSend
  })
  await host.locator('.connection--connected').waitFor()
  assert(hostWebSockets.length > socketsBeforeMissingAck, 'a missing action acknowledgement kept the bad socket active')
  await host.waitForFunction(() => !document.querySelector('main')?.hasAttribute('data-webmcp-pending'))
  const refusalSnapshot = await fetch(`${roomTarget}/api/rooms/${credentials.code}`, {
    headers: { 'x-room-token': credentials.token },
  }).then((response) => response.json())
  let refusalRefreshes = 0
  await host.route(`**/api/rooms/${credentials.code}`, async (route) => {
    refusalRefreshes += 1
    await route.continue()
  })
  await host.evaluate((snapshot) => {
    const send = WebSocket.prototype.send
    window.__roomSend = send
    WebSocket.prototype.send = function (data) {
      const message = JSON.parse(String(data))
      if (message.type !== 'action') return send.call(this, data)
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
        type: 'error', requestId: message.requestId, status: 409, error: 'Injected action refusal', snapshot,
      }) })))
    }
  }, refusalSnapshot)
  await host.locator('.map:not([inert]) .room--reachable').first().click()
  await host.getByRole('alert').filter({ hasText: 'Injected action refusal' }).waitFor()
  await host.waitForFunction(() => !document.querySelector('main')?.hasAttribute('data-webmcp-pending'))
  await host.locator('.map:not(.map--entering)').waitFor()
  assert.equal(refusalRefreshes, 0, 'a correlated refusal performed a redundant HTTP refresh')
  await host.evaluate(() => {
    WebSocket.prototype.send = window.__roomSend
    delete window.__roomSend
  })
  await host.unroute(`**/api/rooms/${credentials.code}`)
  let delayedHttpActions = 0
  let staleCloseRefreshes = 0
  await host.route('**/api/rooms/*/action', async (route) => {
    delayedHttpActions += 1
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000))
    await route.continue()
  })
  await host.route(`**/api/rooms/${credentials.code}`, async (route) => {
    staleCloseRefreshes += 1
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000))
    await route.continue()
  })
  await host.evaluate(() => {
    const send = WebSocket.prototype.send
    window.__roomSend = send
    WebSocket.prototype.send = function (data) {
      const message = JSON.parse(String(data))
      if (message.type === 'action' && window.__heldRoomClose) {
        const release = window.__heldRoomClose
        delete window.__heldRoomClose
        release()
      }
      return send.call(this, data)
    }
  })
  const actionStartedAt = Date.now()
  await host.locator('.map:not([inert]) .room--reachable').first().click()
  await host.locator('.combat').waitFor({ timeout: 1_500 })
  await host.waitForFunction(() => !document.querySelector('main')?.hasAttribute('data-webmcp-pending'))
  assert.equal(delayedHttpActions, 0, 'hosted gameplay still used the delayed HTTP action endpoint')
  assert.equal(staleCloseRefreshes, 0, 'a stale socket close rejected the replacement socket action')
  assert(Date.now() - actionStartedAt < 1_500, 'the persistent WebSocket did not bypass injected HTTP latency')
  await host.evaluate(() => {
    WebSocket.prototype.send = window.__roomSend
    delete window.__roomSend
  })
  await host.unroute(`**/api/rooms/${credentials.code}`)
  await host.unroute('**/api/rooms/*/action')
  liveRoom.run = {
    ...liveRoom.run,
    phase: 'map',
    neow: null,
    players: liveRoom.run.players.map((player) => player.id === ownerId
      ? { ...player, relics: [...player.relics, { defId: 'war_paint', spent: false, pending: true }] }
      : player),
  }
  const pendingSkill = liveRoom.run.players.find((player) => player.id === ownerId).deck
    .find((card) => card.defId.startsWith('defend_')).uid
  liveRoom.version += 1
  for (const seat of liveRoom.seats) seat.connected = seat.playerId === ownerId
  const otherRoom = createRoom(rooms.store)
  joinRoom(otherRoom, { name: 'Other room', character: 'defect' })
  rooms.publishRoom(liveRoom.code)
  await host.route('**/session.json*', (route) => route.abort('failed'))

  await rooms.close({ preserveRooms: true })
  await Promise.all([
    host.locator('.connection--reconnecting').waitFor(),
    guest.locator('.connection--reconnecting').waitFor(),
  ])
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 3_000))

  rooms = createRoomServer({ storeFile, allowedOrigin: pagesOrigin, handoffRestore: true, handoffReconnectMs: 3_600_000 })
  const reconnectQuorum = rooms.store.reconnectQuorums.get(credentials.code)
  assert(reconnectQuorum.expiresAt > Date.now() + 3_500_000, 'the hosted handoff reconnect grace was not applied')
  saveStore(rooms.store)
  const consecutiveRestore = createStore({ file: storeFile, handoffRestore: true, handoffReconnectMs: 3_600_000 })
  assert.deepEqual([...consecutiveRestore.reconnectQuorums.get(credentials.code).playerIds], [ownerId],
    'a consecutive handoff forgot a player who was still reconnecting')
  roomAddress = await rooms.listen(0)
  const restoredOrigin = await startTunnel(`http://127.0.0.1:${roomAddress.port}`)
  partialTarget = `http://127.0.0.1:${roomAddress.port}`
  roomOrigin = partialOrigin
  roomOrigins = [partialOrigin]
  for (let attempt = 0; attempt < 50 && partialUpgrades === 0; attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  assert(partialUpgrades > 0, 'the HTTP-healthy tunnel did not win the first WebSocket attempt')
  roomOrigin = restoredOrigin
  roomOrigins = [partialOrigin, restoredOrigin]
  await guest.locator('.connection--connected').waitFor()

  let restored = rooms.store.rooms.get(credentials.code)
  let owner = restored.run.players.find((player) => player.id === ownerId)
  assert(owner.relics.some((relic) => relic.defId === 'war_paint' && relic.pending), 'the first peer resolved the owner’s private Relic')
  assert.equal(owner.deck.find((card) => card.uid === pendingSkill).upgraded, false)
  assert.deepEqual(restored.seats.map((seat) => seat.connected), [false, true])
  assert.deepEqual([...rooms.store.reconnectQuorums.get(credentials.code).playerIds], [ownerId])
  const blockedAction = await guest.evaluate(async (saved) => {
    const { origin } = await fetch(`session.json?test=${Date.now()}`).then((response) => response.json())
    const response = await fetch(`${origin}/api/rooms/${saved.code}/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-room-token': saved.token },
      body: JSON.stringify({ action: { kind: 'endTurn' } }),
    })
    return { status: response.status, body: await response.json() }
  }, guestCredentials)
  assert.deepEqual(blockedAction, { status: 409, body: { error: 'Waiting for every player to reconnect' } })
  rooms.dropConnection(credentials.code, guestCredentials.token)
  await guest.locator('.connection--reconnecting').waitFor()
  restored = rooms.store.rooms.get(credentials.code)
  owner = restored.run.players.find((player) => player.id === ownerId)
  assert(owner.relics.some((relic) => relic.defId === 'war_paint' && relic.pending), 'a redropped peer resolved the owner’s private Relic')
  assert.deepEqual([...rooms.store.reconnectQuorums.get(credentials.code).playerIds].sort(), ['p1', 'p2'])
  await guest.locator('.connection--connected').waitFor()

  await host.unroute('**/session.json*')
  await host.locator('.connection--connected').waitFor()

  restored = rooms.store.rooms.get(credentials.code)
  owner = restored.run.players.find((player) => player.id === ownerId)
  assert(restored?.run, 'the in-progress run was not restored')
  assert.deepEqual(restored.seats.map((seat) => seat.connected), [true, true])
  assert.equal(rooms.store.reconnectQuorums.has(credentials.code), false)
  const pendingHandoffSockets = Array.from({ length: 5 }, (_, index) => new WebSocket(
    `ws://127.0.0.1:${roomAddress.port}/ws?room=${index < 4 ? credentials.code : otherRoom.code}`,
  ))
  await Promise.all(pendingHandoffSockets.map((socket) => new Promise((resolveOpen, rejectOpen) => {
    socket.once('open', resolveOpen)
    socket.once('error', rejectOpen)
  })))
  const refusedHandoff = new WebSocket(`ws://127.0.0.1:${roomAddress.port}/ws?room=${credentials.code}`)
  const refusedHandoffStatus = await new Promise((resolveResponse, rejectResponse) => {
    refusedHandoff.once('unexpected-response', (_request, response) => {
      response.resume()
      resolveResponse(response.statusCode)
    })
    refusedHandoff.once('error', rejectResponse)
  })
  assert.equal(refusedHandoffStatus, 429, 'a restored room accepted a fifth pending socket after reconnect quorum cleared')
  await Promise.all(pendingHandoffSockets.map((socket) => new Promise((resolveClose) => {
    socket.once('close', resolveClose)
    socket.close()
  })))
  assert(owner.relics.some((relic) => relic.defId === 'war_paint' && relic.pending), 'handoff chose the owner’s private Relic cards')
  assert.equal(owner.deck.find((card) => card.uid === pendingSkill).upgraded, false)
  assert.equal(await host.evaluate(() => location.origin), pagesOrigin)
  assert.equal(await guest.evaluate(() => location.origin), pagesOrigin)
  console.log('✓ desktop and horizontal-phone players fail over and reconnect to the restored runner')
} finally {
  await browser.close()
  await profileBrowser.close()
  await new Promise((resolveClose) => unreliableServer.close(resolveClose))
  await Promise.all(tunnels.map((tunnel) => tunnel.close()))
  for (const socket of partialWebSockets.clients) socket.terminate()
  await new Promise((resolveClose) => partialWebSockets.close(resolveClose))
  await new Promise((resolveClose) => partialTunnel.close(resolveClose))
  await vite.close()
  await rooms.close()
  rmSync(temporary, { recursive: true })
  delete process.env.VITE_HOSTED_SESSION
}
