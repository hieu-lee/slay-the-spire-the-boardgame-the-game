import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
import { createServer as createViteServer } from 'vite'
import { createRoomServer } from './room-server.mjs'

process.env.VITE_HOSTED_SESSION = 'true'
const root = resolve(import.meta.dirname, '..')
const temporary = mkdtempSync(join(tmpdir(), 'sts-session-handoff-'))
const storeFile = join(temporary, 'rooms.json')
let roomOrigin = ''
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
        response.setHeader('content-type', 'application/json')
        response.setHeader('cache-control', 'no-store')
        response.end(JSON.stringify({ origin: roomOrigin }))
      })
    },
  }],
})
await vite.listen()
const viteAddress = vite.httpServer?.address()
if (!viteAddress || typeof viteAddress === 'string') throw new Error('vite did not report a port')
const pagesOrigin = `http://127.0.0.1:${viteAddress.port}`

let rooms = createRoomServer({ storeFile, allowedOrigin: pagesOrigin })
let roomAddress = await rooms.listen(0)
roomOrigin = await startTunnel(`http://127.0.0.1:${roomAddress.port}`)
const browser = await chromium.launch({ headless: true })
const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const phone = await browser.newContext({ viewport: { width: 560, height: 315 } })
const host = await desktop.newPage()
const guest = await phone.newPage()

async function enter(page, name, character, code) {
  await page.goto(pagesOrigin, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Play online' }).click()
  await page.getByLabel('Your name').fill(name)
  await page.locator('.online-character-roster').getByRole('button', { name: character }).click()
  if (code) {
    await page.getByLabel('Room code').fill(code)
    await page.getByRole('button', { name: 'Join', exact: true }).click()
  } else await page.getByRole('button', { name: 'Create room' }).click()
  await page.locator('.online-lobby').waitFor()
}

try {
  await enter(host, 'Host', 'Ironclad')
  const credentials = await host.evaluate(() => JSON.parse(sessionStorage.getItem('sts-room-session')))
  await enter(guest, 'Guest', 'Silent', credentials.code)
  const guestCredentials = await guest.evaluate(() => JSON.parse(sessionStorage.getItem('sts-room-session')))
  await host.getByRole('button', { name: 'Enter the Spire' }).click()
  await Promise.all([
    host.getByRole('heading', { name: 'Neow’s Blessing' }).waitFor(),
    guest.getByRole('heading', { name: 'Neow’s Blessing' }).waitFor(),
  ])
  const liveRoom = rooms.store.rooms.get(credentials.code)
  const ownerId = liveRoom.seats[0].playerId
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
  for (const seat of liveRoom.seats) seat.connected = false
  rooms.publishRoom(liveRoom.code)
  await host.route('**/session.json*', (route) => route.abort('failed'))

  await rooms.close({ preserveRooms: true })
  await Promise.all([
    host.locator('.connection--reconnecting').waitFor(),
    guest.locator('.connection--reconnecting').waitFor(),
  ])
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 3_000))

  rooms = createRoomServer({ storeFile, allowedOrigin: pagesOrigin, handoffRestore: true })
  roomAddress = await rooms.listen(0)
  roomOrigin = await startTunnel(`http://127.0.0.1:${roomAddress.port}`)
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
  assert(owner.relics.some((relic) => relic.defId === 'war_paint' && relic.pending), 'handoff chose the owner’s private Relic cards')
  assert.equal(owner.deck.find((card) => card.uid === pendingSkill).upgraded, false)
  assert.equal(await host.evaluate(() => location.origin), pagesOrigin)
  assert.equal(await guest.evaluate(() => location.origin), pagesOrigin)
  console.log('✓ desktop and horizontal-phone players reconnect to the restored runner')
} finally {
  await browser.close()
  await Promise.all(tunnels.map((tunnel) => tunnel.close()))
  await vite.close()
  await rooms.close()
  rmSync(temporary, { recursive: true })
  delete process.env.VITE_HOSTED_SESSION
}
