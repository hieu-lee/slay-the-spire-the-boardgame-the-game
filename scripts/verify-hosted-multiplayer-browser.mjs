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

  await Promise.all([desktop.close(), phone.close()])
  console.log('✓ stable hosted session connects desktop and horizontal-phone multiplayer clients')
} finally {
  await browser?.close()
  await rooms?.close()
  await vite.close()
}
