import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { createServer as createViteServer } from 'vite'
import { createRoomServer } from './room-server.mjs'

process.env.VITE_HOSTED_SESSION = 'true'
const root = resolve(import.meta.dirname, '..')
let roomOrigin = ''
const vite = await createViteServer({
  root,
  logLevel: 'silent',
  server: { host: '127.0.0.1', port: 0 },
  plugins: [{
    name: 'stable-session-fixture',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith('/session.json')) return next()
        response.setHeader('content-type', 'application/json')
        response.setHeader('cache-control', 'no-store')
        response.end(JSON.stringify({ origin: roomOrigin, protocolVersion: 1, alwaysOn: true }))
      })
    },
  }],
})

let rooms
let browser
try {
  await vite.listen()
  const viteAddress = vite.httpServer?.address()
  if (!viteAddress || typeof viteAddress === 'string') throw new Error('Vite did not report a port')
  const pagesOrigin = `http://127.0.0.1:${viteAddress.port}`
  rooms = createRoomServer({ allowedOrigin: pagesOrigin })
  const roomAddress = await rooms.listen(0)
  roomOrigin = `http://127.0.0.1:${roomAddress.port}`

  browser = await chromium.launch({ headless: true })
  const profile = async (viewport, username, token) => {
    const context = await browser.newContext({ viewport })
    await context.addInitScript(({ username, token }) => localStorage.setItem('sts-profile', JSON.stringify({ username, token })), { username, token })
    return context
  }
  const desktop = await profile({ width: 1440, height: 900 }, 'HostedHost', '00000000-0000-4000-8000-000000000011')
  const phone = await profile({ width: 640, height: 360 }, 'HostedGuest', '00000000-0000-4000-8000-000000000012')
  const host = await desktop.newPage()
  const guest = await phone.newPage()
  const guestSockets = []
  const roomWebSocketOrigin = roomOrigin.replace(/^http/, 'ws')
  guest.on('websocket', (socket) => {
    if (socket.url().startsWith(`${roomWebSocketOrigin}/ws?room=`)) guestSockets.push(socket)
  })

  for (const page of [host, guest]) {
    await page.goto(pagesOrigin)
    const welcome = page.getByRole('button', { name: 'Tap, click, or press any key to start' })
    if (await welcome.count()) await welcome.click()
    await page.getByRole('button', { name: 'Play online' }).click()
  }
  await host.getByRole('button', { name: 'Create room' }).click()
  const code = await host.locator('.online-lobby__code h1').innerText()
  assert.match(code, /^[A-Z0-9]{6}$/)

  await guest.getByRole('button', { name: 'Silent' }).click()
  await guest.getByLabel('Room code').fill(code)
  await guest.getByRole('button', { name: 'Join', exact: true }).click()
  await host.getByLabel('HostedGuest, Silent, online').waitFor()
  await guest.getByLabel('HostedHost, Ironclad, online').waitFor()
  await guest.getByLabel('HostedGuest, Silent, you, online').waitFor()

  let failedReads = 0
  let failedTwice
  const twoFailures = new Promise((resolve) => { failedTwice = resolve })
  const roomSnapshotUrl = `${roomOrigin}/api/rooms/${code}`
  const recoveredRead = guest.waitForResponse((response) =>
    response.url() === roomSnapshotUrl && response.status() === 200, { timeout: 45_000 })
  await guest.route(roomSnapshotUrl, (route) => {
    if (failedReads < 2) {
      failedReads += 1
      if (failedReads === 2) failedTwice()
      return route.abort()
    }
    return route.continue()
  })
  await Promise.race([twoFailures, guest.waitForTimeout(35_000).then(() => { throw new Error('No liveness probes arrived') })])
  await recoveredRead
  assert.equal(failedReads, 2, 'HTTP liveness was not retried after two failures')
  assert.equal(guestSockets.length, 1, 'failed HTTP liveness reads replaced a working WebSocket')
  assert.equal(rooms.store.rooms.get(code).seats[1].connected, true, 'failed HTTP liveness reads disconnected the guest')
  await guest.getByLabel('HostedGuest, Silent, you, online').waitFor()

  await guest.unroute(roomSnapshotUrl)
  let releaseHeldRead
  const heldRead = new Promise((resolve) => { releaseHeldRead = resolve })
  let announceHeldRead
  const waitingRead = new Promise((resolve) => { announceHeldRead = resolve })
  let announceRetry
  const retriedRead = new Promise((resolve) => { announceRetry = resolve })
  let heldOnce = false
  let retryReads = 0
  await guest.route(roomSnapshotUrl, async (route) => {
    if (!heldOnce) {
      heldOnce = true
      announceHeldRead()
      await heldRead
      return route.abort()
    }
    retryReads += 1
    if (retryReads === 1) announceRetry()
    return route.continue()
  })
  await Promise.race([waitingRead, guest.waitForTimeout(15_000).then(() => { throw new Error('No delayed probe arrived') })])
  const snapshotFrame = guestSockets[0].waitForEvent('framereceived', {
    predicate: ({ payload }) => JSON.parse(String(payload)).type === 'snapshot', timeout: 10_000,
  })
  rooms.publishRoom(code)
  await snapshotFrame
  releaseHeldRead()
  await Promise.race([retriedRead, guest.waitForTimeout(20_000).then(() => { throw new Error('No retry after the delayed probe') })])
  await guest.waitForTimeout(500)
  assert.equal(retryReads, 1, 'a delayed HTTP failure and a WebSocket snapshot scheduled duplicate probes')

  const replacement = guest.waitForEvent('websocket', {
    predicate: (socket) => socket.url().startsWith(`${roomWebSocketOrigin}/ws?room=`), timeout: 10_000,
  })
  rooms.dropConnection(code, rooms.store.rooms.get(code).seats[1].token)
  const newSocket = await replacement
  await newSocket.waitForEvent('framereceived', {
    predicate: ({ payload }) => JSON.parse(String(payload)).type === 'snapshot', timeout: 10_000,
  })
  await guest.getByLabel('HostedGuest, Silent, you, online').waitFor()
  assert.equal(rooms.store.rooms.get(code).seats[1].connected, true, 'the replacement socket did not restore the guest')
  assert.equal(guestSockets.length, 2, 'an actual WebSocket drop did not reconnect the guest')

  await Promise.all([desktop.close(), phone.close()])
  console.log('✓ hosted clients keep a live socket through failed HTTP probes and reconnect after a real drop')
} finally {
  await browser?.close()
  await rooms?.close()
  await vite.close()
}
