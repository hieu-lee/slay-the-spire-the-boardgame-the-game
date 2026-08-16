import WebSocket from 'ws'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRoomServer } from './room-server.mjs'
import { REBUILT_END_TURN_ORDER } from '../src/game/combat.ts'
import { suite, check, assert, assertEqual, report } from './lib/harness.mjs'

suite('room server')

let turnRequest
let invalidTurnBody = false
const service = createRoomServer({
  turnKeyId: 'turn-key',
  turnApiToken: 'server-secret',
  fetchImpl: async (url, options) => {
    turnRequest = { url, options }
    if (invalidTurnBody) return new Response('not json', { status: 201 })
    return new Response(JSON.stringify({
      iceServers: [
        { urls: ['stun:stun.cloudflare.com:3478'] },
        { urls: ['turns:turn.cloudflare.com:443?transport=tcp'], username: 'short-user', credential: 'short-pass' },
      ],
    }), { status: 201, headers: { 'content-type': 'application/json' } })
  },
})
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
    const timer = setTimeout(() => {
      socket.off('message', receive)
      reject(new Error(`timed out waiting for ${type}`))
    }, 3000)
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
  const deniedIce = await request(`/api/rooms/${created.body.snapshot.code}/voice-ice`)
  const voiceIce = await request(`/api/rooms/${created.body.snapshot.code}/voice-ice`, { token: created.body.token })
  invalidTurnBody = true
  const invalidVoiceIce = await request(`/api/rooms/${created.body.snapshot.code}/voice-ice`, { token: created.body.token })
  invalidTurnBody = false
  check('voice ICE credentials are authenticated and minted server-side', () => {
    assertEqual(deniedIce.status, 401)
    assertEqual(voiceIce.status, 200)
    assertEqual(voiceIce.body.iceServers[1].username, 'short-user')
    assert(turnRequest.url.endsWith('/turn/keys/turn-key/credentials/generate-ice-servers'))
    assertEqual(turnRequest.options.headers.authorization, 'Bearer server-secret')
    assertEqual(JSON.parse(turnRequest.options.body).ttl, 21_600)
    assert(turnRequest.options.signal instanceof AbortSignal, 'TURN request has no timeout signal')
    assert(!JSON.stringify(voiceIce.body).includes('server-secret'), 'the long-term TURN secret reached the browser')
    assertEqual(invalidVoiceIce.status, 502, 'an invalid TURN response escaped the gateway error boundary')
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
    assertEqual(malformedCloseCode, 4002)
  })

  const ghostStart = await request(`/api/rooms/${code}/start`, { method: 'POST', token: a.token, body: {} })
  const [aLive, bLive, cLive, dLive] = await Promise.all([
    connect(code, a.token),
    ...joined.map((seat) => connect(code, seat.token)),
  ])
  const invalidAscension = await request(`/api/rooms/${code}/ascension`, {
    method: 'POST', token: a.token, body: { ascension: '13' },
  })
  const lockedAscension = await request(`/api/rooms/${code}/ascension`, {
    method: 'POST', token: a.token, body: { ascension: 13 },
  })
  const selectedAscension = await request(`/api/rooms/${code}/ascension`, {
    method: 'POST', token: a.token, body: { ascension: 0 },
  })
  const guestLastStand = await request(`/api/rooms/${code}/last-stand-rule`, {
    method: 'POST', token: joined[0].token, body: { enabled: true },
  })
  const invalidLastStand = await request(`/api/rooms/${code}/last-stand-rule`, {
    method: 'POST', token: a.token, body: { enabled: 'true' },
  })
  const selectedLastStand = await request(`/api/rooms/${code}/last-stand-rule`, {
    method: 'POST', token: a.token, body: { enabled: true },
  })
  const guestStart = await request(`/api/rooms/${code}/start`, {
    method: 'POST', token: joined[0].token, body: {},
  })
  const started = await request(`/api/rooms/${code}/start`, { method: 'POST', token: a.token, body: {} })
  const lockedLastStand = await request(`/api/rooms/${code}/last-stand-rule`, {
    method: 'POST', token: a.token, body: { enabled: false },
  })
  const lockedRename = await request(`/api/rooms/${code}/join`, {
    method: 'POST', token: a.token, body: { name: 'Renamed' },
  })
  check('an authenticated seat starts the authoritative run', () => {
    assertEqual(ghostStart.status, 409, 'a disconnected ghost seat must block starting')
    assertEqual(invalidAscension.status, 400, 'ascension must cross the network as a supported integer')
    assertEqual(lockedAscension.status, 409, 'a client selected a locked campaign Ascension')
    assertEqual(selectedAscension.body.ascension, 0, 'the lobby did not share its selected Ascension')
    assertEqual(guestLastStand.status, 409, 'a non-host changed The Last Stand')
    assertEqual(invalidLastStand.status, 409, 'a non-boolean Last Stand value crossed the authority boundary')
    assertEqual(selectedLastStand.status, 200)
    assertEqual(selectedLastStand.body.lastStand, true, 'the lobby did not publish The Last Stand')
    assertEqual(guestStart.status, 409, 'a connected guest started the run')
    assertEqual(started.status, 200)
    assertEqual(started.body.run.ascension, 0)
    assertEqual(started.body.run.lastStand, true, 'The Last Stand was not carried into the run')
    assertEqual(lockedLastStand.status, 409, 'The Last Stand changed after the run started')
    assertEqual(lockedRename.status, 409, 'a reconnect renamed only part of a live run')
    assertEqual(started.body.you.name, 'Ann')
    assertEqual(started.body.phase, 'run')
    assertEqual(started.body.run.players.length, 4)
    assertEqual(started.body.run.players[0].deck.length > 0, true, 'the owner receives its own deck')
    assertEqual(started.body.run.players[1].deck, null, 'another seat deck is hidden')
  })

  const remainingNeow = service.store.rooms.get(code).run.neow.deck
  check('the HTTP snapshot publishes dealt Neow faces but not its hidden deck', () => {
    assertEqual(started.body.run.phase, 'neow')
    assertEqual(Object.hasOwn(started.body.run.neow, 'deck'), false)
    assertEqual(Object.keys(started.body.run.neow.players).length, 4)
    for (const cardId of remainingNeow) assert(!JSON.stringify(started.body).includes(cardId), `hidden Neow card ${cardId} leaked`)
  })
  const forgedNeow = await request(`/api/rooms/${code}/action`, {
    method: 'POST', token: a.token,
    body: { action: { kind: 'neow', stage: 'red', playerId: joined[0].playerId, choice: null } },
  })
  check('the Neow endpoint binds decisions to the authenticated seat', () => {
    assertEqual(forgedNeow.status, 409)
  })
  for (const seat of [a, ...joined]) {
    let current = (await request(`/api/rooms/${code}`, { token: seat.token })).body
    let preview = current.run.neow.players[seat.playerId]
    if (preview.redGoldPending) {
      current = (await request(`/api/rooms/${code}/action`, {
        method: 'POST', token: seat.token,
        body: { action: { kind: 'neow', stage: 'redGold', gain: false } },
      })).body
      preview = current.run.neow.players[seat.playerId]
    }
    if (preview.redRewardPending) {
      current = (await request(`/api/rooms/${code}/action`, {
        method: 'POST', token: seat.token,
        body: { action: { kind: 'neow', stage: 'red', choice: null } },
      })).body
      preview = current.run.neow.players[seat.playerId]
    }
    if (preview.blueOption === null) {
      const optionIndex = preview.card.options.findIndex((option) => !option.effects.some((effect) => effect.kind === 'relic'))
      assert(optionIndex >= 0, 'the server Neow fixture needs a non-Relic option')
      current = (await request(`/api/rooms/${code}/action`, {
        method: 'POST', token: seat.token,
        body: { action: { kind: 'neow', stage: 'option', optionIndex } },
      })).body
    }
    while (current.run?.phase === 'neow' && current.run.neow.players[seat.playerId]?.pendingEffect) {
      current = (await request(`/api/rooms/${code}/action`, {
        method: 'POST', token: seat.token,
        body: { action: { kind: 'neow', stage: 'effect', gain: false } },
      })).body
    }
    while (current.run?.phase === 'neow' && current.run.neow.players[seat.playerId]?.rewardKind) {
      current = (await request(`/api/rooms/${code}/action`, {
        method: 'POST', token: seat.token,
        body: { action: { kind: 'neow', stage: 'reward', choice: null } },
      })).body
    }
  }
  const afterNeow = await request(`/api/rooms/${code}`, { token: a.token })
  check('interleaved authenticated Neow decisions release the shared map', () => {
    assertEqual(afterNeow.body.run.phase, 'map')
    assertEqual(afterNeow.body.run.neow, null)
  })

  const roomId = afterNeow.body.run.map.rows[0][0]
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

  // A refusal that still changed the room has to reach the rest of the party —
  // and must NOT reach the refused seat, whose snapshot frame would wipe the
  // recovery message the refusal just put on its screen.
  const liveRoom = service.store.rooms.get(code)
  // Straight to the player phase with two Orbs to order: the ordering stage is
  // what this checks, not the way in.
  Object.assign(liveRoom.run.combat, { phase: 'player' })
  liveRoom.run.combat.players.find((player) => player.id === a.playerId).orbs = ['lightning', 'lightning', null]
  for (const seat of [a, ...joined]) {
    await request(`/api/rooms/${code}/action`, {
      method: 'POST', token: seat.token, body: { action: { kind: 'endTurn' } },
    })
  }
  const staged = await request(`/api/rooms/${code}`, { token: a.token })
  const stagedOrder = staged.body.endTurnOrder
  const orbTargetUid = stagedOrder.find((choice) => choice.includes('@'))?.split('@')[1]
  assert(orbTargetUid, `no targeted ability was published: ${JSON.stringify(stagedOrder)}`)
  Object.assign(liveRoom.run.combat.enemies.find((enemy) => enemy.uid === orbTargetUid), { hp: 0, dead: true })
  const teammateRepublish = nextMessage(bLive.socket, 'snapshot')
  const actorSnapshot = nextMessage(aLive.socket, 'snapshot')
    .then(() => 'snapshot', () => 'silent')
  const staleResolve = await request(`/api/rooms/${code}/action`, {
    method: 'POST', token: a.token,
    body: { action: { kind: 'resolveEndTurn', abilityOrder: stagedOrder } },
  })
  const teammateSaw = await teammateRepublish
  const actorHeard = await actorSnapshot
  check('a refused end-turn republish reaches the party but spares the refused seat', () => {
    assertEqual(staleResolve.status, 409)
    assert(teammateSaw.snapshot.endTurnAbilities.every((ability) =>
      !(ability.targets ?? []).some((target) => target.uid === orbTargetUid)),
      'the teammate kept the dead target')
    assertEqual(actorHeard, 'silent',
      'the refused seat was sent a snapshot, which clears the error it just showed')
  })

  // The socket carries the same reconciliation, minus the skip: its error frame
  // follows the snapshot on one socket, and a socket client cannot refetch.
  const rebuiltOrder = (await request(`/api/rooms/${code}`, { token: a.token })).body.endTurnOrder
  Object.assign(liveRoom.run.combat.enemies.find((enemy) => !enemy.dead), { hp: 0, dead: true })
  const socketFrames = []
  const recordFrames = (raw) => socketFrames.push(JSON.parse(raw.toString()).type)
  aLive.socket.on('message', recordFrames)
  const socketSnapshot = nextMessage(aLive.socket, 'snapshot')
  const socketRefusal = nextMessage(aLive.socket, 'error')
  aLive.socket.send(JSON.stringify({
    type: 'action', action: { kind: 'resolveEndTurn', abilityOrder: rebuiltOrder },
  }))
  const [socketSaw, socketHeard] = await Promise.all([socketSnapshot, socketRefusal])
  aLive.socket.off('message', recordFrames)
  check('a socket refusal still hands the room back to the seat that sent it', () => {
    assert(socketSaw.snapshot.endTurnAbilities, 'the socket seat never saw the rebuilt order')
    assertEqual(socketHeard.error, REBUILT_END_TURN_ORDER)
    assertEqual(socketFrames.join(), 'snapshot,error',
      `the refusal must not be overwritten by the snapshot that follows it: ${socketFrames.join()}`)
  })

  // Release the published stage: while one is live every other action is refused.
  const resolvedStage = await request(`/api/rooms/${code}/action`, {
    method: 'POST', token: a.token,
    body: { action: { kind: 'resolveEndTurn', abilityOrder: (await request(`/api/rooms/${code}`, { token: a.token })).body.endTurnOrder } },
  })
  check('the ordering stage is released for the checks that follow', () => {
    assertEqual(resolvedStage.status, 200)
  })

  const invalidVoice = nextMessage(aLive.socket, 'error')
  aLive.socket.send(JSON.stringify({ type: 'voice', to: joined[0].playerId, signal: null }))
  const rejectedVoice = await invalidVoice
  const voice = nextMessage(bLive.socket, 'voice')
  aLive.socket.send(JSON.stringify({
    type: 'voice',
    to: joined[0].playerId,
    signal: { type: 'hello' },
  }))
  const relayed = await voice
  check('voice signaling is relayed only with the public sender id', () => {
    assertEqual(rejectedVoice.error, 'Invalid voice signal')
    assertEqual(relayed.from, a.playerId)
    assertEqual(relayed.signal.type, 'hello')
    assert(!JSON.stringify(relayed).includes(a.token), 'voice relay leaked a bearer token')
    assert(!aLive.socket.url.includes(a.token), 'the bearer token appears in the WebSocket URL')
  })

  const voiceLimited = await request('/api/rooms', {
    method: 'POST', body: { name: 'Voice A', character: 'ironclad' },
  })
  const voiceJoined = await request(`/api/rooms/${voiceLimited.body.snapshot.code}/join`, {
    method: 'POST', body: { name: 'Voice B', character: 'silent' },
  })
  const voiceSender = await connect(voiceLimited.body.snapshot.code, voiceLimited.body.token)
  const voiceReceiver = await connect(voiceLimited.body.snapshot.code, voiceJoined.body.token)
  const lastVoice = nextMessage(voiceReceiver.socket, 'voice', (message) => message.signal.sequence === 179)
  for (let sequence = 0; sequence < 180; sequence++) {
    voiceSender.socket.send(JSON.stringify({
      type: 'voice',
      to: voiceJoined.body.snapshot.you.playerId,
      signal: { sequence },
    }))
  }
  await lastVoice
  const actionCapacity = await request(`/api/rooms/${voiceLimited.body.snapshot.code}`, { token: voiceLimited.body.token })
  const voiceThrottled = new Promise((resolve) => voiceSender.socket.once('close', (closeCode) => resolve(closeCode)))
  voiceSender.socket.send(JSON.stringify({
    type: 'voice',
    to: voiceJoined.body.snapshot.you.playerId,
    signal: { sequence: 180 },
  }))
  const voiceThrottleCode = await voiceThrottled
  voiceReceiver.socket.close()
  check('voice signaling is bounded without consuming authoritative capacity', () => {
    assertEqual(actionCapacity.status, 200)
    assertEqual(voiceThrottleCode, 4008)
  })

  const malformedLive = await request('/api/rooms', {
    method: 'POST', body: { name: 'Malformed', character: 'ironclad' },
  })
  const malformedSocket = await connect(malformedLive.body.snapshot.code, malformedLive.body.token)
  const malformedAuthenticated = new Promise((resolve) => malformedSocket.socket.once('close', (closeCode) => resolve(closeCode)))
  malformedSocket.socket.send('null')
  const malformedAuthenticatedCode = await malformedAuthenticated
  check('an authenticated socket gets one parse attempt for an invalid frame', () => {
    assertEqual(malformedAuthenticatedCode, 4002)
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

  const catchUpCreated = await request('/api/rooms', {
    method: 'POST', body: { name: 'Catch Up Host', character: 'ironclad' },
  })
  const catchUpCode = catchUpCreated.body.snapshot.code
  const catchUpLeader = await connect(catchUpCode, catchUpCreated.body.token)
  const catchUpPeer = await request(`/api/rooms/${catchUpCode}/join`, {
    method: 'POST', body: { name: 'Catch Up Peer', character: 'silent' },
  })
  const catchUpPeerLive = await connect(catchUpCode, catchUpPeer.body.token)
  const catchUpStarted = await request(`/api/rooms/${catchUpCode}/start`, {
    method: 'POST', token: catchUpCreated.body.token, body: {},
  })
  const catchUpRoom = service.store.rooms.get(catchUpCode)
  catchUpRoom.run.phase = 'map'
  catchUpRoom.run.neow = null
  catchUpRoom.run.act = 2
  catchUpRoom.run.map = { ...catchUpRoom.run.map, act: 2, position: null }
  const runBeforeReservation = JSON.stringify(catchUpRoom.run)
  const catchUpReserved = await request(`/api/rooms/${catchUpCode}/join`, {
    method: 'POST', body: { name: 'Cancelled Reservation', character: 'defect' },
  })
  const overlappingPending = await request(`/api/rooms/${catchUpCode}/join`, {
    method: 'POST', body: { name: 'Overlapping Reservation', character: 'watcher' },
  })
  const blockedAtBoundary = await request(`/api/rooms/${catchUpCode}/action`, {
    method: 'POST', token: catchUpPeer.body.token,
    body: { action: { kind: 'enterRoom', roomId: catchUpRoom.run.map.rows[0][0] } },
  })
  const cancelledReservation = await request(`/api/rooms/${catchUpCode}/leave`, {
    method: 'POST', token: catchUpReserved.body.token, body: {},
  })
  const expiringReservation = await request(`/api/rooms/${catchUpCode}/join`, {
    method: 'POST', body: { name: 'Never Authenticated', character: 'defect' },
  })
  const reservation = catchUpRoom.seats.find((seat) => seat.token === expiringReservation.body.token)
  const versionBeforeSweep = catchUpRoom.version
  service.sweepRooms(reservation.reservedAt + 30_000)
  check('an unauthenticated HTTP Catch Up reservation expires without mutating the run', () => {
    assertEqual(catchUpStarted.status, 200)
    assertEqual(overlappingPending.status, 409, 'two unauthenticated Catch Up reservations were accepted')
    assertEqual(blockedAtBoundary.status, 409, 'the leader advanced the run before Catch Up authentication')
    assertEqual(cancelledReservation.status, 200, 'an abandoned Catch Up reservation could not leave')
    assertEqual(catchUpRoom.seats.some((seat) => seat.token === catchUpReserved.body.token), false)
    assertEqual(reservation.pendingCatchUp, true)
    assertEqual(JSON.stringify(catchUpRoom.run), runBeforeReservation, 'HTTP reservation began Catch Up before WebSocket authentication')
    assertEqual(catchUpRoom.seats.some((seat) => seat.token === catchUpReserved.body.token), false)
    assertEqual(catchUpRoom.version, versionBeforeSweep + 1)
  })
  const hostileReservation = await request(`/api/rooms/${catchUpCode}/join`, {
    method: 'POST', body: { name: 'Hostile Reservation', character: 'defect' },
  })
  const leaderProceeded = await request(`/api/rooms/${catchUpCode}/action`, {
    method: 'POST', token: catchUpCreated.body.token,
    body: { action: { kind: 'enterRoom', roomId: catchUpRoom.run.map.rows[0][0] } },
  })
  check('the leader can proceed past and cancel a hostile Catch Up reservation', () => {
    assertEqual(leaderProceeded.status, 200)
    assertEqual(leaderProceeded.body.run.phase, 'combat')
    assertEqual(catchUpRoom.seats.some((seat) => seat.token === hostileReservation.body.token), false)
  })
  catchUpLeader.socket.close()
  catchUpPeerLive.socket.close()

  const activeCatchUpCreated = await request('/api/rooms', {
    method: 'POST', body: { name: 'Active Catch Up Host', character: 'ironclad' },
  })
  const activeCatchUpCode = activeCatchUpCreated.body.snapshot.code
  const activeCatchUpLeader = await connect(activeCatchUpCode, activeCatchUpCreated.body.token)
  await request(`/api/rooms/${activeCatchUpCode}/start`, {
    method: 'POST', token: activeCatchUpCreated.body.token, body: {},
  })
  const activeCatchUpRoom = service.store.rooms.get(activeCatchUpCode)
  activeCatchUpRoom.run.phase = 'map'
  activeCatchUpRoom.run.neow = null
  activeCatchUpRoom.run.act = 2
  activeCatchUpRoom.run.map = { ...activeCatchUpRoom.run.map, act: 2, position: null }
  const firstNewcomer = await request(`/api/rooms/${activeCatchUpCode}/join`, {
    method: 'POST', body: { name: 'First Newcomer', character: 'silent' },
  })
  const firstNewcomerLive = await connect(activeCatchUpCode, firstNewcomer.body.token)
  const overlappingReservation = await request(`/api/rooms/${activeCatchUpCode}/join`, {
    method: 'POST', body: { name: 'Overlapping Newcomer', character: 'defect' },
  })
  const overlappingLive = await connect(activeCatchUpCode, overlappingReservation.body.token)
  check('active Catch Up admits one additional reservation without blocking Neow', () => {
    assertEqual(activeCatchUpRoom.run.phase, 'neow')
    assertEqual(overlappingReservation.status, 200)
    assertEqual(activeCatchUpRoom.run.players.some((player) => player.name === 'Overlapping Newcomer'), true)
  })
  activeCatchUpLeader.socket.close()
  firstNewcomerLive.socket.close()
  overlappingLive.socket.close()

  const failedAuthCreated = await request('/api/rooms', {
    method: 'POST', body: { name: 'Failed Auth Host', character: 'ironclad' },
  })
  const failedAuthCode = failedAuthCreated.body.snapshot.code
  const failedAuthHost = await connect(failedAuthCode, failedAuthCreated.body.token)
  await request(`/api/rooms/${failedAuthCode}/start`, {
    method: 'POST', token: failedAuthCreated.body.token, body: {},
  })
  const failedAuthRoom = service.store.rooms.get(failedAuthCode)
  failedAuthRoom.run.phase = 'map'
  failedAuthRoom.run.neow = null
  failedAuthRoom.run.act = 2
  failedAuthRoom.run.map = { ...failedAuthRoom.run.map, act: 2, position: null }
  const staleReservation = await request(`/api/rooms/${failedAuthCode}/join`, {
    method: 'POST', body: { name: 'Stale Reservation', character: 'silent' },
  })
  failedAuthRoom.run.phase = 'setup'
  const failedSocket = new WebSocket(`${wsOrigin}/ws?room=${failedAuthCode}`)
  const failedClose = new Promise((resolve) => failedSocket.once('close', resolve))
  await new Promise((resolve, reject) => {
    failedSocket.once('open', resolve)
    failedSocket.once('error', reject)
  })
  failedSocket.send(JSON.stringify({ type: 'authenticate', token: staleReservation.body.token }))
  const failedCloseCode = await failedClose
  check('failed Catch Up authentication closes before subscribing to room snapshots', () => {
    assertEqual(failedCloseCode, 4003)
  })
  failedAuthHost.socket.close()

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

let burstSaves = 0
const burstService = createRoomServer({
  storeFile: join(tmpdir(), `sts-room-burst-${process.pid}-${Date.now()}.json`),
  saveDelayMs: 10_000,
  saveStoreImpl: () => { burstSaves += 1 },
})
const burstAddress = await burstService.listen(0)
const burstOrigin = `http://127.0.0.1:${burstAddress.port}`
try {
  const created = await fetch(`${burstOrigin}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Burst', character: 'ironclad' }),
  }).then((response) => response.json())
  for (let index = 0; index < 12; index += 1) {
    const response = await fetch(`${burstOrigin}/api/rooms/${created.snapshot.code}/character`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-room-token': created.token },
      body: JSON.stringify({ character: index % 2 === 0 ? 'silent' : 'ironclad' }),
    })
    assertEqual(response.status, 200, 'burst mutation failed')
  }
  check('persistence coalesces a mutation burst off the request hot path', () => {
    assertEqual(burstSaves, 0, 'a full-store save ran synchronously during the burst')
  })
} finally {
  await burstService.close()
}
check('closing the server atomically flushes one coalesced save', () => {
  assertEqual(burstSaves, 1)
})

let retryAttempts = 0
const saveErrors = []
const retryTimes = []
const retryService = createRoomServer({
  storeFile: join(tmpdir(), `sts-room-retry-${process.pid}-${Date.now()}.json`),
  saveDelayMs: 10,
  saveStoreImpl: () => {
    retryAttempts += 1
    retryTimes.push(Date.now())
    if (retryAttempts <= 3) throw new Error('injected delayed save failure')
  },
  onSaveError: (error) => saveErrors.push(error.message),
})
const retryAddress = await retryService.listen(0)
const retryOrigin = `http://127.0.0.1:${retryAddress.port}`
try {
  const created = await fetch(`${retryOrigin}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Retry', character: 'ironclad' }),
  })
  assertEqual(created.status, 201, 'retry fixture room creation failed')
  const deadline = Date.now() + 2_000
  while (retryAttempts < 4 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
  const health = await fetch(`${retryOrigin}/api/health`)
  check('delayed save failures are observable, back off until success, and leave the server responsive', () => {
    assertEqual(saveErrors[0], 'injected delayed save failure')
    assertEqual(retryAttempts, 4, 'the failed save was not retried through success')
    assert(retryTimes[2] - retryTimes[1] >= 180, 'repeated failures did not back off exponentially')
    assert(retryTimes[3] - retryTimes[2] >= 360, 'later failures retried in a hot loop')
    assertEqual(retryService.saveError, null, 'a successful retry did not clear the save error')
    assertEqual(health.status, 200, 'the save failure stopped the server')
  })
} finally {
  await retryService.close()
}

const closeErrors = []
const failingCloseService = createRoomServer({
  storeFile: join(tmpdir(), `sts-room-close-failure-${process.pid}-${Date.now()}.json`),
  saveDelayMs: 10_000,
  saveStoreImpl: () => { throw new Error('injected close save failure') },
  onSaveError: (error) => closeErrors.push(error.message),
})
await failingCloseService.listen(0)
let closeFailure
try { await failingCloseService.close() } catch (error) { closeFailure = error }
check('closing reports a failed final flush after still closing the server', () => {
  assertEqual(closeFailure?.message, 'injected close save failure')
  assertEqual(closeErrors[0], 'injected close save failure')
  assertEqual(failingCloseService.server.listening, false)
})

const shutdownSaves = []
const shutdownService = createRoomServer({
  storeFile: join(tmpdir(), `sts-room-shutdown-${process.pid}-${Date.now()}.json`),
  saveDelayMs: 10_000,
  saveStoreImpl: (store) => shutdownSaves.push(structuredClone([...store.rooms.values()])),
})
const shutdownAddress = await shutdownService.listen(0)
const shutdownOrigin = `http://127.0.0.1:${shutdownAddress.port}`
const shutdownCreated = await fetch(`${shutdownOrigin}/api/rooms`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Shutdown', character: 'ironclad' }),
}).then((response) => response.json())
const shutdownSocket = new WebSocket(`ws://127.0.0.1:${shutdownAddress.port}/ws?room=${shutdownCreated.snapshot.code}`)
await new Promise((resolve, reject) => {
  shutdownSocket.once('open', resolve)
  shutdownSocket.once('error', reject)
})
const authenticated = nextMessage(shutdownSocket, 'snapshot')
shutdownSocket.send(JSON.stringify({ type: 'authenticate', token: shutdownCreated.token }))
await authenticated
assertEqual(shutdownService.store.rooms.get(shutdownCreated.snapshot.code).seats[0].connected, true)
const firstClose = shutdownService.close()
assertEqual(shutdownService.close(), firstClose, 'close was not idempotent while shutting down')
await firstClose
check('shutdown awaits WebSocket disconnect settlement before its final persistence flush', () => {
  const finalRoom = shutdownSaves.at(-1)?.[0]
  assertEqual(finalRoom?.seats[0].connected, false, 'the final save preceded disconnect settlement')
  assertEqual(shutdownService.server.listening, false)
})

report('room server')
