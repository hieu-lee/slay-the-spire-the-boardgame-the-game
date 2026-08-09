import WebSocket from 'ws'
import { createRoomServer } from './room-server.mjs'
import { suite, check, assert, assertEqual, report } from './lib/harness.mjs'

suite('room server')

const service = createRoomServer()
const address = await service.listen(0)
const origin = `http://127.0.0.1:${address.port}`
const wsOrigin = `ws://127.0.0.1:${address.port}`

async function request(path, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(token ? { 'x-room-token': token } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: response.status, body: await response.json() }
}

function nextMessage(socket, type, accept = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), 3000)
    function receive(raw) {
      const message = JSON.parse(raw.toString())
      if (message.type !== type || !accept(message)) return
      clearTimeout(timer)
      socket.off('message', receive)
      resolve(message)
    }
    socket.on('message', receive)
  })
}

async function connect(code, token) {
  const socket = new WebSocket(`${wsOrigin}/ws?room=${code}`)
  const first = nextMessage(socket, 'snapshot')
  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  socket.send(JSON.stringify({ type: 'authenticate', token }))
  return { socket, snapshot: (await first).snapshot }
}

try {
  const invalid = await request('/api/rooms', {
    method: 'POST',
    body: { name: 'Bad', character: 'not-a-character' },
  })
  check('a rejected creator leaves no unreachable room behind', () => {
    assertEqual(invalid.status, 409)
    assertEqual(service.store.rooms.size, 0)
  })

  const leavable = await request('/api/rooms', {
    method: 'POST', body: { name: 'Keeping', character: 'ironclad' },
  })
  const leavableCode = leavable.body.snapshot.code
  const departing = await request(`/api/rooms/${leavableCode}/join`, {
    method: 'POST', body: { name: 'Leaving', character: 'silent' },
  })
  const left = await request(`/api/rooms/${leavableCode}/leave`, {
    method: 'POST', token: departing.body.token, body: {},
  })
  const replacement = await request(`/api/rooms/${leavableCode}/join`, {
    method: 'POST', body: { name: 'Replacement', character: 'silent' },
  })
  check('leaving a lobby frees the seat and its stable player id', () => {
    assertEqual(left.status, 200)
    assertEqual(replacement.body.snapshot.seats.length, 2)
    assertEqual(replacement.body.snapshot.you.playerId, 'p2')
  })

  const created = await request('/api/rooms', {
    method: 'POST',
    body: { name: 'Ann', character: 'ironclad', random: {} },
  })
  const code = created.body.snapshot.code
  const a = { token: created.body.token, playerId: created.body.snapshot.you.playerId }
  const joined = []
  for (const [index, [name, character]] of [['Bo', 'silent'], ['Cy', 'defect'], ['Di', 'watcher']].entries()) {
    const result = await request(`/api/rooms/${code}/join`, {
      method: 'POST', body: { name, character, ...(index === 0 ? { random: {} } : {}) },
    })
    joined.push({ token: result.body.token, playerId: result.body.snapshot.you.playerId })
  }
  const fifth = await request(`/api/rooms/${code}/join`, {
    method: 'POST', body: { name: 'Eve', character: 'watcher' },
  })
  const scalarBody = await fetch(`${origin}/api/rooms/${code}/join`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: 'null',
  })
  const anonymous = await request(`/api/rooms/${code}`)

  check('HTTP creates a private four-seat room and refuses a fifth', () => {
    assertEqual(created.status, 201)
    assertEqual(created.body.snapshot.you.connected, false, 'HTTP alone must not make a seat live')
    assertEqual(joined.length, 3)
    assertEqual(fifth.status, 409)
    assertEqual(scalarBody.status, 400, 'JSON scalars must not become server errors')
    assertEqual(anonymous.status, 401, 'a room code alone must not expose the table')
    assert(!JSON.stringify(created.body.snapshot).includes(a.token), 'the bearer token leaked into a snapshot')
  })

  const pending = Array.from({ length: 4 }, () => new WebSocket(`${wsOrigin}/ws?room=${code}`))
  await Promise.all(pending.map((socket) => new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })))
  const refused = new WebSocket(`${wsOrigin}/ws?room=${code}`)
  const refusedStatus = await new Promise((resolve, reject) => {
    refused.once('unexpected-response', (_request, response) => {
      response.resume()
      resolve(response.statusCode)
    })
    refused.once('error', reject)
  })
  await Promise.all(pending.map((socket) => new Promise((resolve) => {
    socket.once('close', resolve)
    socket.close()
  })))
  check('one source cannot occupy the global pending-authentication pool', () => {
    assertEqual(refusedStatus, 429)
  })

  const malformed = new WebSocket(`${wsOrigin}/ws?room=${code}`)
  const malformedClosed = new Promise((resolve) => malformed.once('close', (closeCode) => resolve(closeCode)))
  await new Promise((resolve, reject) => {
    malformed.once('open', resolve)
    malformed.once('error', reject)
  })
  malformed.send('{')
  const malformedCloseCode = await malformedClosed
  check('an unauthenticated socket gets one parse attempt', () => {
    assertEqual(malformedCloseCode, 4003)
  })

  const ghostStart = await request(`/api/rooms/${code}/start`, { method: 'POST', token: a.token, body: {} })
  const [aLive, bLive, cLive, dLive] = await Promise.all([
    connect(code, a.token),
    ...joined.map((seat) => connect(code, seat.token)),
  ])
  const invalidAscension = await request(`/api/rooms/${code}/ascension`, {
    method: 'POST', token: a.token, body: { ascension: '13' },
  })
  const selectedAscension = await request(`/api/rooms/${code}/ascension`, {
    method: 'POST', token: a.token, body: { ascension: 13 },
  })
  const started = await request(`/api/rooms/${code}/start`, { method: 'POST', token: a.token, body: {} })
  const lockedRename = await request(`/api/rooms/${code}/join`, {
    method: 'POST', token: a.token, body: { name: 'Renamed' },
  })
  check('an authenticated seat starts the authoritative run', () => {
    assertEqual(ghostStart.status, 409, 'a disconnected ghost seat must block starting')
    assertEqual(invalidAscension.status, 400, 'ascension must cross the network as a supported integer')
    assertEqual(selectedAscension.body.ascension, 13, 'the lobby did not share its selected ascension')
    assertEqual(started.status, 200)
    assertEqual(started.body.run.ascension, 13)
    assertEqual(lockedRename.status, 409, 'a reconnect renamed only part of a live run')
    assertEqual(started.body.you.name, 'Ann')
    assertEqual(started.body.phase, 'run')
    assertEqual(started.body.run.players.length, 4)
    assertEqual(started.body.run.players[0].deck.length > 0, true, 'the owner receives its own deck')
    assertEqual(started.body.run.players[1].deck, null, 'another seat deck is hidden')
  })

  const roomId = started.body.run.map.rows[0][0]
  const inCombat = (message) => message.snapshot.run?.phase === 'combat'
  const aUpdate = nextMessage(aLive.socket, 'snapshot', inCombat)
  const bUpdate = nextMessage(bLive.socket, 'snapshot', inCombat)
  aLive.socket.send(JSON.stringify({ type: 'action', action: { kind: 'enterRoom', roomId } }))
  const [seenA, seenB] = await Promise.all([aUpdate, bUpdate])

  check('WebSocket actions converge while keeping hands private', () => {
    assertEqual(seenA.snapshot.run.phase, 'combat')
    assertEqual(seenB.snapshot.run.phase, 'combat')
    const aViewOfB = seenA.snapshot.run.combat.players.find((player) => player.id === joined[0].playerId)
    const bViewOfB = seenB.snapshot.run.combat.players.find((player) => player.id === joined[0].playerId)
    assertEqual(aViewOfB.hand, null, 'Ann cannot read Bo\'s hand')
    assert(Array.isArray(bViewOfB.hand), 'Bo receives Bo\'s own hand')
  })

  const voice = nextMessage(bLive.socket, 'voice')
  aLive.socket.send(JSON.stringify({
    type: 'voice',
    to: joined[0].playerId,
    signal: { type: 'hello' },
  }))
  const relayed = await voice
  check('voice signaling is relayed only with the public sender id', () => {
    assertEqual(relayed.from, a.playerId)
    assertEqual(relayed.signal.type, 'hello')
    assert(!JSON.stringify(relayed).includes(a.token), 'voice relay leaked a bearer token')
    assert(!aLive.socket.url.includes(a.token), 'the bearer token appears in the WebSocket URL')
  })

  const replaced = new Promise((resolve) => aLive.socket.once('close', (code) => resolve(code)))
  const aReturned = await connect(code, a.token)
  const replacedCode = await replaced
  check('one seat owns only one live WebSocket', () => {
    assertEqual(replacedCode, 4001)
    assertEqual(aReturned.snapshot.you.playerId, a.playerId)
  })

  const disconnected = nextMessage(aReturned.socket, 'snapshot', (message) =>
    message.snapshot.seats.find((seat) => seat.playerId === joined[0].playerId)?.connected === false)
  bLive.socket.close()
  const afterClose = await disconnected
  const boAfterClose = afterClose.snapshot.seats.find((seat) => seat.playerId === joined[0].playerId)
  const reclaimed = await request(`/api/rooms/${code}/join`, {
    method: 'POST', token: joined[0].token, body: {},
  })
  const bReturned = await connect(code, joined[0].token)
  check('closing and reconnecting preserves the same seat', () => {
    assertEqual(boAfterClose.connected, false)
    assertEqual(reclaimed.body.snapshot.you.connected, false, 'HTTP reclaim must wait for a live socket')
    assertEqual(reclaimed.body.snapshot.version, afterClose.snapshot.version, 'a no-op reclaim bumped the room')
    assertEqual(bReturned.snapshot.you.playerId, joined[0].playerId)
    assertEqual(bReturned.snapshot.you.connected, true)
  })

  const limited = await request('/api/rooms', {
    method: 'POST', body: { name: 'Rate', character: 'ironclad' },
  })
  const limitedCode = limited.body.snapshot.code
  for (let i = 0; i < 60; i++) {
    await request(`/api/rooms/${limitedCode}/action`, {
      method: 'POST', token: limited.body.token, body: { action: null },
    })
  }
  const malformedThrottled = await fetch(`${origin}/api/rooms/${limitedCode}/action`, {
    method: 'POST',
    headers: { 'x-room-token': limited.body.token, 'content-type': 'application/json' },
    body: '{',
  })
  const throttled = await request(`/api/rooms/${limitedCode}`, { token: limited.body.token })
  const reconnect = new WebSocket(`${wsOrigin}/ws?room=${limitedCode}`)
  const reconnectClosed = new Promise((resolve) => reconnect.once('close', (closeCode) => resolve(closeCode)))
  await new Promise((resolve, reject) => {
    reconnect.once('open', resolve)
    reconnect.once('error', reject)
  })
  reconnect.send(JSON.stringify({ type: 'authenticate', token: limited.body.token }))
  const reconnectCode = await reconnectClosed
  check('one seat rate limit spans HTTP reads, malformed bodies, and reconnects', () => {
    assertEqual(malformedThrottled.status, 429, 'a throttled body was parsed before admission')
    assertEqual(throttled.status, 429)
    assertEqual(reconnectCode, 4008, 'reconnect reset the seat rate limit')
  })

  aReturned.socket.close()
  bReturned.socket.close()
  cLive.socket.close()
  dLive.socket.close()
} finally {
  await service.close()
}

report('room server')
