import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection } from 'node:net'
import { WebSocket, WebSocketServer } from 'ws'
import { createHandoffProxy } from './handoff-proxy.mjs'

let upstreamRequests = 0
const upstream = createServer((request, response) => {
  if (request.url !== '/api/health') upstreamRequests += 1
  response.setHeader('content-type', 'application/json')
  const send = () => response.end(JSON.stringify({ ok: request.url === '/api/health', origin: request.headers.origin }))
  if (request.url === '/stalled-503') return setTimeout(send, 40)
  send()
})
const upstreamSockets = new WebSocketServer({ server: upstream })
upstreamSockets.on('connection', (socket) => socket.on('message', (message) => socket.send(message)))
upstream.listen(0, '127.0.0.1')
await once(upstream, 'listening')
const upstreamAddress = upstream.address()
const failedPrimary = createServer((request, response) => {
  response.writeHead(request.url === '/api/health' ? 200 : 503)
  response.end(request.url === '/api/health' ? '{"ok":true}' : 'unavailable')
})
failedPrimary.listen(0, '127.0.0.1')
await once(failedPrimary, 'listening')
const failedAddress = failedPrimary.address()
const optionsProxy = createHandoffProxy([
  `http://127.0.0.1:${failedAddress.port}`,
  `http://127.0.0.1:${upstreamAddress.port}`,
])
optionsProxy.listen(0, '127.0.0.1')
await once(optionsProxy, 'listening')
const optionsAddress = optionsProxy.address()
const proxy = createHandoffProxy([
  `http://127.0.0.1:${failedAddress.port}`,
  `http://127.0.0.1:${upstreamAddress.port}`,
])
proxy.listen(0, '127.0.0.1')
await once(proxy, 'listening')
const proxyAddress = proxy.address()

const interruptedSockets = new Set()
let streamingClosed = false
let interruptedRoomRequests = 0
const interruptedPrimary = createServer((request, response) => {
  if (request.url === '/api/health') return response.end('{"ok":true}')
  if (request.url === '/partial') {
    response.writeHead(200, { 'content-length': '10' })
    response.write('x')
    return setTimeout(() => response.socket.destroy(), 20)
  }
  if (request.url === '/headers-hang') {
    response.writeHead(200, { 'content-length': '10' })
    return response.flushHeaders()
  }
  if (request.url === '/stalled-503') {
    return setTimeout(() => {
      response.writeHead(503, { 'content-length': '10' })
      response.flushHeaders()
    }, 20)
  }
  if (request.url === '/stream') {
    response.writeHead(200)
    const interval = setInterval(() => response.write('x'), 10)
    request.once('close', () => {
      clearInterval(interval)
      streamingClosed = true
    })
  }
  if (request.url === '/api/room') interruptedRoomRequests += 1
})
interruptedPrimary.on('connection', (socket) => {
  interruptedSockets.add(socket)
  socket.once('close', () => interruptedSockets.delete(socket))
})
interruptedPrimary.listen(0, '127.0.0.1')
await once(interruptedPrimary, 'listening')
const interruptedAddress = interruptedPrimary.address()
const timeoutProxy = createHandoffProxy([
  `http://127.0.0.1:${interruptedAddress.port}`,
  `http://127.0.0.1:${upstreamAddress.port}`,
], { requestTimeoutMs: 50 })
timeoutProxy.listen(0, '127.0.0.1')
await once(timeoutProxy, 'listening')
const timeoutAddress = timeoutProxy.address()

const stalled5xxProxy = createHandoffProxy([
  `http://127.0.0.1:${interruptedAddress.port}`,
  `http://127.0.0.1:${upstreamAddress.port}`,
], { requestTimeoutMs: 50 })
stalled5xxProxy.listen(0, '127.0.0.1')
await once(stalled5xxProxy, 'listening')
const stalled5xxAddress = stalled5xxProxy.address()

const budgetProxy = createHandoffProxy([
  `http://127.0.0.1:${interruptedAddress.port}`,
  `http://127.0.0.1:${upstreamAddress.port}`,
])
budgetProxy.listen(0, '127.0.0.1')
await once(budgetProxy, 'listening')
const budgetAddress = budgetProxy.address()

const partialProxy = createHandoffProxy([
  `http://127.0.0.1:${interruptedAddress.port}`,
  `http://127.0.0.1:${upstreamAddress.port}`,
], { requestTimeoutMs: 50 })
partialProxy.listen(0, '127.0.0.1')
await once(partialProxy, 'listening')
const partialAddress = partialProxy.address()

const headersProxy = createHandoffProxy([
  `http://127.0.0.1:${interruptedAddress.port}`,
  `http://127.0.0.1:${upstreamAddress.port}`,
], { requestTimeoutMs: 50 })
headersProxy.listen(0, '127.0.0.1')
await once(headersProxy, 'listening')
const headersAddress = headersProxy.address()

const streamProxy = createHandoffProxy([
  `http://127.0.0.1:${interruptedAddress.port}`,
  `http://127.0.0.1:${upstreamAddress.port}`,
], { requestTimeoutMs: 50 })
streamProxy.listen(0, '127.0.0.1')
await once(streamProxy, 'listening')
const streamAddress = streamProxy.address()

const postProxy = createHandoffProxy([
  `http://127.0.0.1:${failedAddress.port}`,
  `http://127.0.0.1:${upstreamAddress.port}`,
])
postProxy.listen(0, '127.0.0.1')
await once(postProxy, 'listening')
const postAddress = postProxy.address()

const markerDirectory = mkdtempSync(join(tmpdir(), 'sts-handoff-proxy-'))
const writeMarker = join(markerDirectory, 'writes-enabled')
const gatedProxy = createHandoffProxy([`http://127.0.0.1:${upstreamAddress.port}`], { writeMarker })
gatedProxy.listen(0, '127.0.0.1')
await once(gatedProxy, 'listening')
const gatedAddress = gatedProxy.address()

const stalledSockets = new Set()
const stalledUpgrade = createServer((_request, response) => response.end('{"ok":true}'))
stalledUpgrade.on('upgrade', (_request, socket) => {
  stalledSockets.add(socket)
  socket.once('close', () => stalledSockets.delete(socket))
  socket.once('end', () => socket.destroy())
  socket.on('error', () => {})
  socket.resume()
})
stalledUpgrade.listen(0, '127.0.0.1')
await once(stalledUpgrade, 'listening')
const stalledAddress = stalledUpgrade.address()
const resetProxy = createHandoffProxy([
  `http://127.0.0.1:${stalledAddress.port}`,
  `http://127.0.0.1:${upstreamAddress.port}`,
], { webSocketTimeoutMs: 50 })
resetProxy.listen(0, '127.0.0.1')
await once(resetProxy, 'listening')
const resetAddress = resetProxy.address()

let delayedUpgrades = 0
const delayedHealth = createServer((request, response) => {
  if (request.url === '/api/health') return setTimeout(() => response.end('{"ok":true}'), 500)
  response.end()
})
delayedHealth.on('upgrade', (_request, socket) => {
  delayedUpgrades += 1
  socket.destroy()
})
delayedHealth.listen(0, '127.0.0.1')
await once(delayedHealth, 'listening')
const delayedAddress = delayedHealth.address()
const delayedProxy = createHandoffProxy([`http://127.0.0.1:${delayedAddress.port}`])
delayedProxy.listen(0, '127.0.0.1')
await once(delayedProxy, 'listening')
const delayedProxyAddress = delayedProxy.address()

try {
  let escaped = false
  const unrelated = createServer((_request, response) => {
    escaped = true
    response.end('escaped')
  })
  unrelated.listen(0, '127.0.0.1')
  await once(unrelated, 'listening')
  const unrelatedAddress = unrelated.address()
  const rejected = await new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port: proxyAddress.port,
      path: `http://127.0.0.1:${unrelatedAddress.port}/secret` }, resolve)
    request.on('error', reject)
    request.end()
  })
  rejected.resume()
  assert.equal(rejected.statusCode, 400)
  assert.equal(escaped, false)
  await new Promise((resolve) => unrelated.close(resolve))

  const response = await fetch(`http://127.0.0.1:${proxyAddress.port}/api/room`, { headers: { origin: 'https://game.test' } })
  assert.deepEqual(await response.json(), { ok: false, origin: 'https://game.test' })
  const optionsResponse = await fetch(`http://127.0.0.1:${optionsAddress.port}/api/room`, { method: 'OPTIONS' })
  assert.equal(optionsResponse.status, 200)

  const upstreamBeforeStalled5xx = upstreamRequests
  const stalled5xx = await fetch(`http://127.0.0.1:${stalled5xxAddress.port}/stalled-503`)
  assert.equal(stalled5xx.status, 200)
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(upstreamRequests, upstreamBeforeStalled5xx + 1, 'a stalled 5xx started fallback twice')
  assert.equal((await fetch(`http://127.0.0.1:${stalled5xxAddress.port}/api/room`)).status, 200)

  const timedOut = await fetch(`http://127.0.0.1:${timeoutAddress.port}/hang`)
  assert.equal((await timedOut.json()).ok, false)
  const budgetStarted = Date.now()
  const budgeted = await fetch(`http://127.0.0.1:${budgetAddress.port}/hang`)
  assert.equal((await budgeted.json()).ok, false)
  assert(Date.now() - budgetStarted < 5_000, 'proxy failover exceeded the client refresh deadline')
  await assert.rejects(fetch(`http://127.0.0.1:${partialAddress.port}/partial`).then((value) => value.text()))
  const recovered = await fetch(`http://127.0.0.1:${partialAddress.port}/api/room`)
  assert.equal((await recovered.json()).ok, false)
  await assert.rejects(fetch(`http://127.0.0.1:${headersAddress.port}/headers-hang`).then((value) => value.text()))
  const headersRecovered = await fetch(`http://127.0.0.1:${headersAddress.port}/api/room`)
  assert.equal((await headersRecovered.json()).ok, false)

  const controller = new AbortController()
  const stream = await fetch(`http://127.0.0.1:${streamAddress.port}/stream`, { signal: controller.signal })
  controller.abort()
  await assert.rejects(stream.text())
  for (let attempt = 0; attempt < 20 && !streamingClosed; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(streamingClosed, true)
  const interruptedBeforeRetry = interruptedRoomRequests
  const streamRecovered = await fetch(`http://127.0.0.1:${streamAddress.port}/api/room`)
  assert.equal((await streamRecovered.json()).ok, false)
  assert.equal(interruptedRoomRequests, interruptedBeforeRetry)

  const refusedPost = await fetch(`http://127.0.0.1:${postAddress.port}/join`, { method: 'POST', body: '{}' })
  assert.equal(refusedPost.status, 503)
  const postRecovered = await fetch(`http://127.0.0.1:${postAddress.port}/api/room`)
  assert.equal((await postRecovered.json()).ok, false)

  const gatedRead = await fetch(`http://127.0.0.1:${gatedAddress.port}/api/room`)
  assert.equal(gatedRead.status, 200)
  const gatedWrite = await fetch(`http://127.0.0.1:${gatedAddress.port}/api/room`, { method: 'POST' })
  assert.equal(gatedWrite.status, 503)
  const gatedSocket = new WebSocket(`ws://127.0.0.1:${gatedAddress.port}/ws?room=ABC123`)
  await once(gatedSocket, 'open')
  gatedSocket.send('{"type":"authenticate"}')
  assert.equal(String((await once(gatedSocket, 'message'))[0]), '{"type":"authenticate"}')
  const gatedSocketClosed = once(gatedSocket, 'close')
  gatedSocket.send('{"type":"action"}')
  assert.equal((await gatedSocketClosed)[0], 1013)
  writeFileSync(writeMarker, '')
  const enabledWrite = await fetch(`http://127.0.0.1:${gatedAddress.port}/api/room`, { method: 'POST' })
  assert.equal(enabledWrite.status, 200)

  const resetClient = createConnection({ host: '127.0.0.1', port: resetAddress.port })
  resetClient.on('error', () => {})
  await once(resetClient, 'connect')
  resetClient.write('GET /ws?room=ABC123 HTTP/1.1\r\nHost: game.test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: AQIDBAUGBwgJCgsMDQ4PEC==\r\nSec-WebSocket-Version: 13\r\n\r\n')
  for (let attempt = 0; attempt < 100 && stalledSockets.size === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(stalledSockets.size, 1)
  resetClient.destroy()
  for (let attempt = 0; attempt < 100 && stalledSockets.size; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(stalledSockets.size, 0)
  const afterReset = new WebSocket(`ws://127.0.0.1:${resetAddress.port}/ws?room=ABC123`)
  await once(afterReset, 'open')
  const afterResetClosed = once(afterReset, 'close')
  afterReset.close()
  await afterResetClosed

  const pendingUpgrades = Array.from({ length: 32 }, () => {
    const candidate = new WebSocket(`ws://127.0.0.1:${delayedProxyAddress.port}/ws?room=ABC123`)
    candidate.on('error', () => {})
    return candidate
  })
  const limitedUpgrade = new WebSocket(`ws://127.0.0.1:${delayedProxyAddress.port}/ws?room=ABC123`)
  const limitedStatus = await new Promise((resolve, reject) => {
    limitedUpgrade.once('unexpected-response', (_request, response) => {
      response.resume()
      resolve(response.statusCode)
    })
    limitedUpgrade.once('error', reject)
  })
  assert.equal(limitedStatus, 429)
  for (const candidate of pendingUpgrades) candidate.terminate()
  await new Promise((resolve) => setTimeout(resolve, 750))
  assert.equal(delayedUpgrades, 0)

  const socket = new WebSocket(`ws://127.0.0.1:${proxyAddress.port}/ws?room=ABC123`)
  await once(socket, 'open')
  socket.send('{"type":"authenticate"}')
  assert.equal(String((await once(socket, 'message'))[0]), '{"type":"authenticate"}')
  const socketClosed = once(socket, 'close')
  socket.close()
  await socketClosed

  const oversized = new WebSocket(`ws://127.0.0.1:${proxyAddress.port}/ws?room=ABC123`)
  await once(oversized, 'open')
  const oversizedClosed = once(oversized, 'close')
  oversized.send(Buffer.alloc(64 * 1024 + 1))
  assert.equal((await oversizedClosed)[0], 1009)
  const source = readFileSync(new URL('./handoff-proxy.mjs', import.meta.url), 'utf8')
  assert.match(source, /signal: AbortSignal\.timeout\(requestTimeoutMs\)/)
  assert.equal(source.match(/bufferedAmount > MAX_BUFFERED_BYTES/g)?.length, 2)
  console.log('✓ handoff proxy fails over HTTP and WebSocket traffic to the restored successor')
} finally {
  for (const socket of upstreamSockets.clients) socket.terminate()
  await new Promise((resolve) => upstreamSockets.close(resolve))
  for (const socket of [...interruptedSockets, ...stalledSockets]) socket.destroy()
  for (const server of [proxy, optionsProxy, timeoutProxy, stalled5xxProxy, budgetProxy, partialProxy, headersProxy, streamProxy, postProxy, gatedProxy, resetProxy,
    delayedProxy, upstream, failedPrimary, interruptedPrimary, stalledUpgrade, delayedHealth]) {
    server.closeAllConnections?.()
  }
  await Promise.all([
    new Promise((resolve) => proxy.close(resolve)),
    new Promise((resolve) => optionsProxy.close(resolve)),
    new Promise((resolve) => timeoutProxy.close(resolve)),
    new Promise((resolve) => stalled5xxProxy.close(resolve)),
    new Promise((resolve) => budgetProxy.close(resolve)),
    new Promise((resolve) => partialProxy.close(resolve)),
    new Promise((resolve) => headersProxy.close(resolve)),
    new Promise((resolve) => streamProxy.close(resolve)),
    new Promise((resolve) => postProxy.close(resolve)),
    new Promise((resolve) => gatedProxy.close(resolve)),
    new Promise((resolve) => resetProxy.close(resolve)),
    new Promise((resolve) => delayedProxy.close(resolve)),
    new Promise((resolve) => upstream.close(resolve)),
    new Promise((resolve) => failedPrimary.close(resolve)),
    new Promise((resolve) => interruptedPrimary.close(resolve)),
    new Promise((resolve) => stalledUpgrade.close(resolve)),
    new Promise((resolve) => delayedHealth.close(resolve)),
  ])
  rmSync(markerDirectory, { recursive: true })
}
