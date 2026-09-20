import WebSocket from 'ws'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRoomServer } from './room-server.mjs'
import { suite, check, assert, assertEqual, report } from './lib/harness.mjs'
import { createCampaignProgress, defaultStartTurnChoices } from '../src/game/state.ts'

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

const capacityHealth = await request('/api/health')
check('health publishes the intended fifty-connection capacity', () => {
  assertEqual(capacityHealth.status, 200)
  assertEqual(capacityHealth.body.connectionCapacity, 50)
  assertEqual(capacityHealth.body.connections, 0)
})

async function connect(code, token, campaignProgress) {
  const socket = new WebSocket(`${wsOrigin}/ws?room=${code}`)
  const first = nextMessage(socket, 'snapshot')
  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  socket.send(JSON.stringify({ type: 'authenticate', token, campaignProgress }))
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

  const sharedSource = '198.51.100.250'
  const profileStatuses = []
  for (let index = 0; index < 10; index += 1) {
    const response = await fetch(`${origin}/api/profile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': sharedSource },
      body: JSON.stringify({ token: crypto.randomUUID(), username: `Friend ${index}` }),
    })
    profileStatuses.push(response.status)
  }
  const sharedRooms = []
  for (let index = 0; index < 3; index += 1) {
    const response = await fetch(`${origin}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': sharedSource },
      body: JSON.stringify({ name: `Shared host ${index}`, character: 'ironclad' }),
    })
    sharedRooms.push({ status: response.status, ...(await response.json()) })
  }
  check('ten friends behind one NAT can claim profiles and create three rooms in one onboarding burst', () => {
    assert(profileStatuses.every((status) => status === 200), `profile statuses: ${profileStatuses.join(',')}`)
    assert(sharedRooms.every((room) => room.status === 201),
      `room statuses: ${sharedRooms.map((room) => room.status).join(',')}`)
  })
  for (const room of sharedRooms) {
    await request(`/api/rooms/${room.snapshot.code}/leave`, {
      method: 'POST', token: room.token, body: {},
    })
  }

  const leavable = await request('/api/rooms', {
    method: 'POST', body: { name: 'Keeping', character: 'ironclad' },
  })
  const leavableCode = leavable.body.snapshot.code
  const unlocks = { ...createCampaignProgress(), colorless: 3, actIV: 5, highestAscension: 9 }
  const legacySocket = await connect(leavableCode, leavable.body.token, unlocks)
  check('WebSocket authentication adds local unlocks to restored lobby seats', () => {
    assertEqual(legacySocket.snapshot.campaignProgress.highestAscension, 9)
    assertEqual(legacySocket.snapshot.campaignProgress.colorless, 3)
    assertEqual(legacySocket.snapshot.campaignProgress.actIV, 5)
  })
  legacySocket.socket.close()
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

  const createRequestId = crypto.randomUUID()
  const created = await request('/api/rooms', {
    method: 'POST',
    body: { name: 'Ann', character: 'ironclad', random: {}, requestId: createRequestId },
  })
  const repeatedCreate = await request('/api/rooms', {
    method: 'POST', body: { name: 'Ann', character: 'ironclad', requestId: createRequestId },
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
    const requestId = crypto.randomUUID()
    const result = await request(`/api/rooms/${code}/join`, {
      method: 'POST', body: { name, character, requestId, ...(index === 0 ? { random: {} } : {}) },
    })
    if (index === 0) {
      const repeatedJoin = await request(`/api/rooms/${code}/join`, {
        method: 'POST', body: { name, character, requestId },
      })
      assertEqual(repeatedJoin.body.token, result.body.token)
      assertEqual(repeatedJoin.body.snapshot.seats.length, result.body.snapshot.seats.length)
    }
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
    assertEqual(repeatedCreate.body.token, created.body.token)
    assertEqual(repeatedCreate.body.snapshot.code, created.body.snapshot.code)
    assertEqual(created.body.snapshot.you.connected, false, 'HTTP alone must not make a seat live')
    assertEqual(joined.length, 3)
    assertEqual(fifth.status, 409)
    assertEqual(scalarBody.status, 400, 'JSON scalars must not become server errors')
    assertEqual(anonymous.status, 401, 'a room code alone must not expose the table')
    assert(!JSON.stringify(created.body.snapshot).includes(a.token), 'the bearer token leaked into a snapshot')
  })

  // Four friends can each have an old and a replacement socket in flight
  // without one household consuming the global pending-authentication pool.
  const pending = Array.from({ length: 8 }, () => new WebSocket(`${wsOrigin}/ws?room=${code}`))
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
  const actionRequestId = crypto.randomUUID()
  const aUpdate = nextMessage(aLive.socket, 'snapshot', (message) =>
    message.requestId === actionRequestId && inCombat(message))
  const bUpdate = nextMessage(bLive.socket, 'snapshot', inCombat)
  aLive.socket.send(JSON.stringify({ type: 'action', requestId: actionRequestId, action: { kind: 'enterRoom', roomId } }))
  const [seenA, seenB] = await Promise.all([aUpdate, bUpdate])

  check('acknowledged WebSocket actions converge while keeping hands private', () => {
    assertEqual(seenA.requestId, actionRequestId)
    assert(aLive.socket.extensions.includes('permessage-deflate'), 'large snapshots did not negotiate WebSocket compression')
    assertEqual(seenA.snapshot.run.phase, 'combat')
    assertEqual(seenB.snapshot.run.phase, 'combat')
    const aViewOfB = seenA.snapshot.run.combat.players.find((player) => player.id === joined[0].playerId)
    const bViewOfB = seenB.snapshot.run.combat.players.find((player) => player.id === joined[0].playerId)
    assertEqual(aViewOfB.hand, null, 'Ann cannot read Bo\'s hand')
    assert(Array.isArray(bViewOfB.hand), 'Bo receives Bo\'s own hand')
  })

  const refusedRequestId = crypto.randomUUID()
  const refusedAction = nextMessage(aLive.socket, 'error', (message) => message.requestId === refusedRequestId)
  aLive.socket.send(JSON.stringify({
    type: 'action', requestId: refusedRequestId, action: { kind: 'playCard', cardUid: 'missing-card' },
  }))
  const refusedMessage = await refusedAction
  check('refused WebSocket actions return a correlated authoritative snapshot', () => {
    assertEqual(refusedMessage.requestId, refusedRequestId)
    assertEqual(refusedMessage.status, 409)
    assertEqual(refusedMessage.snapshot.code, code)
    assertEqual(refusedMessage.snapshot.you.playerId, a.playerId)
  })

  const dieRoom = service.store.rooms.get(code)
  Object.assign(dieRoom.run.combat, {
    phase: 'start', die: 3, startTurnProgress: undefined, startTurnStage: undefined,
    pendingTriggers: [], pendingDieRelicChoices: [],
  })
  for (const player of dieRoom.run.combat.players) {
    Object.assign(player, { powers: [], potions: [], relics: [] })
  }
  dieRoom.run.combat.players.find((player) => player.id === a.playerId)
    .relics = [{ defId: 'the_abacus', spent: false }]
  dieRoom.run.combat.players.find((player) => player.id === joined[0].playerId)
    .relics = [{ defId: 'stone_calendar', spent: false }]
  dieRoom.run.combat.enemies.push({
    ...dieRoom.run.combat.enemies[0], uid: 'server-die-change-second-target', row: 1,
  })
  for (const key of [
    'startTurnCombatId', 'startTurnOrder', 'startTurnEnemyTargets', 'startTurnChoices',
    'startTurnRequired', 'startTurnReady', 'startTurnStagedTriggers',
  ]) dieRoom[key] = undefined
  service.publishRoom(code)

  const dieRequestId = crypto.randomUUID()
  const actorDieUpdate = nextMessage(aLive.socket, 'snapshot', (message) =>
    message.requestId === dieRequestId && message.snapshot.run?.combat?.die === 4)
  const peerDieUpdate = nextMessage(bLive.socket, 'snapshot', (message) =>
    message.snapshot.run?.combat?.die === 4)
  aLive.socket.send(JSON.stringify({
    type: 'action', requestId: dieRequestId, action: { kind: 'activateRelic', relicIndex: 0 },
  }))
  const [actorAfterDie, peerAfterDie] = await Promise.all([actorDieUpdate, peerDieUpdate])
  check('a die-changing Relic keeps both sockets synchronized into downstream choices', () => {
    assertEqual(actorAfterDie.snapshot.run.combat.phase, 'start')
    assertEqual(peerAfterDie.snapshot.run.combat.phase, 'start')
    assertEqual(actorAfterDie.snapshot.startTurnPostRollLocked, true,
      'spending the final die modifier did not close its window')
    assertEqual(peerAfterDie.snapshot.startTurnPostRollLocked, true,
      'the peer did not receive the closed modifier window')
    assert(actorAfterDie.snapshot.startTurnRequired.includes(joined[0].playerId),
      'the newly activated Stone Calendar owner was omitted')
    assertEqual(aLive.socket.readyState, WebSocket.OPEN)
    assertEqual(bLive.socket.readyState, WebSocket.OPEN)
  })

  const voteStarted = await request(`/api/rooms/${code}/action`, {
    method: 'POST', token: a.token,
    body: { action: { kind: 'giveUpVote', vote: 'start' } },
  })
  const voteDeadline = voteStarted.body.giveUpVote.deadlineAt
  const firstYes = await request(`/api/rooms/${code}/action`, {
    method: 'POST', token: a.token,
    body: { action: { kind: 'giveUpVote', vote: 'yes', deadlineAt: voteDeadline } },
  })
  service.store.rooms.get(code).giveUpVote.deadlineAt = Date.now() - 1
  const lateYes = await request(`/api/rooms/${code}/action`, {
    method: 'POST', token: joined[0].token,
    body: { action: { kind: 'giveUpVote', vote: 'yes', deadlineAt: voteDeadline } },
  })
  check('give-up votes are authenticated, public, and refused after the server deadline', () => {
    assertEqual(voteStarted.status, 200)
    assert(voteStarted.body.giveUpVote.remainingMs > 9_000 && voteStarted.body.giveUpVote.remainingMs <= 10_000)
    assertEqual(firstYes.body.giveUpVote.votes[a.playerId], true)
    assertEqual(lateYes.status, 409)
    assertEqual(service.store.rooms.get(code).run.phase, 'combat')
  })

  // End-turn effects are resolved one at a time by their owner; the server is
  // the authority that keeps a teammate from aiming another seat's source.
  const liveRoom = service.store.rooms.get(code)
  Object.assign(liveRoom.run.combat, { phase: 'player' })
  for (const player of liveRoom.run.combat.players) player.hand = []
  liveRoom.run.combat.players.find((player) => player.id === a.playerId).orbs = ['lightning', 'lightning', null]
  for (const seat of [a, ...joined]) {
    await request(`/api/rooms/${code}/action`, {
      method: 'POST', token: seat.token, body: { action: { kind: 'endTurn' } },
    })
  }
  const staged = await request(`/api/rooms/${code}`, { token: a.token })
  const first = staged.body.endTurnAbilities?.[0]
  assert(first, `no end-turn effect was published: ${JSON.stringify(staged.body.endTurnAbilities)}`)
  const targetUid = first.targets[0]?.uid
  assert(targetUid, 'the Lightning Orb did not expose a living target')
  const foreign = await request(`/api/rooms/${code}/action`, {
    method: 'POST', token: joined[0].token,
    body: { action: { kind: 'resolveEndTurnEffect', abilityId: first.id, targetUid } },
  })
  const firstResolve = await request(`/api/rooms/${code}/action`, {
    method: 'POST', token: a.token,
    body: { action: { kind: 'resolveEndTurnEffect', abilityId: first.id, targetUid } },
  })
  const second = (await request(`/api/rooms/${code}`, { token: a.token })).body.endTurnAbilities?.[0]
  const secondResolve = await request(`/api/rooms/${code}/action`, {
    method: 'POST', token: a.token,
    body: { action: { kind: 'resolveEndTurnEffect', abilityId: second.id, targetUid: second.targets[0].uid } },
  })
  check('the room server permits only the effect owner and publishes each Orb immediately', () => {
    assertEqual(foreign.status, 409)
    assertEqual(firstResolve.status, 200)
    assertEqual(secondResolve.status, 200)
  })

  // Noxious Fumes has a private target choice. The shared order coordinator
  // may stage the turn, but only the Power's owner may commit that target.
  const ann = liveRoom.run.combat.players.find((player) => player.id === a.playerId)
  const bo = liveRoom.run.combat.players.find((player) => player.id === joined[0].playerId)
  Object.assign(liveRoom, {
    endTurnAbilities: undefined,
    endTurnPublicIds: undefined,
    endTurnOrders: undefined,
    endTurnOrder: undefined,
    endTurnReady: undefined,
    startTurnCombatId: undefined,
    startTurnOrder: undefined,
    startTurnEnemyTargets: undefined,
    startTurnChoices: undefined,
    startTurnRequired: undefined,
    startTurnReady: undefined,
    startTurnStagedTriggers: undefined,
    startTurnPostRollLock: undefined,
  })
  Object.assign(liveRoom.run.combat, {
    phase: 'roundEnd', turn: 1, log: [], endTurnProgress: undefined,
  })
  for (const player of liveRoom.run.combat.players) {
    Object.assign(player, { hand: [], relics: [], powers: [], shivs: 0 })
  }
  Object.assign(ann, {
    shivs: 5,
    powers: [{ uid: 'server-infinite', defId: 'infinite_blades', upgraded: false }],
    draw: Array.from({ length: 5 }, (_, index) => ({
      uid: `server-ann-draw-${index}`, defId: 'defend_ironclad', upgraded: false,
    })),
  })
  Object.assign(bo, {
    powers: [{ uid: 'server-noxious', defId: 'noxious_fumes', upgraded: false }],
    draw: Array.from({ length: 5 }, (_, index) => ({
      uid: `server-bo-private-${index}`, defId: 'defend_silent', upgraded: false,
    })),
  })
  const enemyTemplate = liveRoom.run.combat.enemies[0]
  liveRoom.run.combat.enemies = [
    { ...enemyTemplate, uid: 'server-noxious-left', defId: 'cultist', row: bo.row,
      hp: 50, maxHp: 50, block: 0, poison: 0, dead: false, abilityUsed: true, isBoss: false },
    { ...enemyTemplate, uid: 'server-noxious-right', defId: 'red_louse', row: bo.row,
      hp: 40, maxHp: 50, block: 0, poison: 0, dead: false, abilityUsed: true, isBoss: false },
  ]
  const startedTurn = await request(`/api/rooms/${code}/action`, {
    method: 'POST', token: a.token, body: { action: { kind: 'startTurn' } },
  })
  assertEqual(startedTurn.status, 200, `could not stage Noxious Fumes: ${JSON.stringify(startedTurn.body)}`)
  const blankChoices = defaultStartTurnChoices(liveRoom.run.combat).map((choice) => ({
    ...choice, shivEnemyUids: choice.shivEnemyUids.map(() => null),
  }))
  const stagedFumes = await request(`/api/rooms/${code}/action`, {
    method: 'POST', token: a.token,
    body: { action: { kind: 'resolveStartTurn', choices: blankChoices } },
  })
  assert(Array.isArray(liveRoom.startTurnOrder), `shared start-turn order was not committed: ${JSON.stringify({
    status: stagedFumes.status,
    body: stagedFumes.body,
    choices: liveRoom.startTurnChoices,
  })}`)
  const fumesId = `${joined[0].playerId}/power:server-noxious`
  const forgedChoices = blankChoices.map((choice) => choice.id === fumesId
    ? { ...choice, enemyUid: 'server-noxious-left' }
    : choice)
  const forgedFumes = await request(`/api/rooms/${code}/action`, {
    method: 'POST', token: a.token,
    body: { action: { kind: 'resolveStartTurn', choices: forgedChoices } },
  })
  const ownerViewBefore = await request(`/api/rooms/${code}`, { token: joined[0].token })
  const ownerChoices = blankChoices.map((choice) => choice.id === fumesId
    ? { ...choice, enemyUid: 'server-noxious-right' }
    : choice)
  const resolvedFumes = await request(`/api/rooms/${code}/action`, {
    method: 'POST', token: joined[0].token,
    body: { action: { kind: 'resolveStartTurn', choices: ownerChoices } },
  })
  const hostView = await request(`/api/rooms/${code}`, { token: a.token })
  check('only the Noxious Fumes owner can commit its private enemy target', () => {
    assertEqual(stagedFumes.status, 200, JSON.stringify(stagedFumes.body))
    assertEqual(stagedFumes.body.startTurnChoiceId, fumesId)
    assertEqual(stagedFumes.body.startTurnCoordinatorId, joined[0].playerId)
    assertEqual(forgedFumes.status, 200)
    assertEqual(forgedFumes.body.run.combat.phase, 'start',
      'the shared order coordinator resolved another seat\'s Noxious target')
    assertEqual(forgedFumes.body.startTurnChoiceId, fumesId)
    assertEqual(forgedFumes.body.startTurnCoordinatorId, joined[0].playerId)
    assertEqual(forgedFumes.body.run.combat.enemies.reduce((sum, enemy) => sum + enemy.poison, 0), 0,
      'the forged Noxious target changed authoritative enemy state')
    assertEqual(ownerViewBefore.body.startTurnChoiceId, fumesId)
    assertEqual(ownerViewBefore.body.startTurnAbilities.find((ability) => ability.id === fumesId)?.targets.length, 2)
    assertEqual(resolvedFumes.status, 200, JSON.stringify(resolvedFumes.body))
    assertEqual(resolvedFumes.body.run.combat.phase, 'player')
    assertEqual(resolvedFumes.body.run.combat.enemies.find((enemy) => enemy.uid === 'server-noxious-left').poison, 0)
    assertEqual(resolvedFumes.body.run.combat.enemies.find((enemy) => enemy.uid === 'server-noxious-right').poison, 1)
    const hostViewOfBo = hostView.body.run.combat.players.find((player) => player.id === joined[0].playerId)
    assertEqual(hostViewOfBo.hand, null, 'the owner-scoped choice exposed the Silent hand')
    assert(!JSON.stringify(hostView.body).includes('server-bo-private-'), 'a private Silent draw UID leaked to the host')
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
  const lastVoice = nextMessage(voiceReceiver.socket, 'voice', (message) => message.signal.sequence === 599)
  for (let sequence = 0; sequence < 600; sequence++) {
    voiceSender.socket.send(JSON.stringify({
      type: 'voice',
      to: voiceJoined.body.snapshot.you.playerId,
      signal: { sequence },
    }))
  }
  await lastVoice
  const actionCapacity = await request(`/api/rooms/${voiceLimited.body.snapshot.code}`, { token: voiceLimited.body.token })
  const voiceThrottled = nextMessage(voiceSender.socket, 'error', (message) => message.status === 429)
  voiceSender.socket.send(JSON.stringify({
    type: 'voice',
    to: voiceJoined.body.snapshot.you.playerId,
    signal: { sequence: 600 },
  }))
  const voiceThrottleError = await voiceThrottled
  voiceReceiver.socket.close()
  check('a large four-player voice negotiation is bounded without disconnecting or consuming action capacity', () => {
    assertEqual(actionCapacity.status, 200)
    assertEqual(voiceThrottleError.status, 429)
    assertEqual(voiceSender.socket.readyState, WebSocket.OPEN)
  })
  voiceSender.socket.close()

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
  const limitedLive = await connect(limitedCode, limited.body.token)
  for (let i = 0; i < 300; i++) {
    const requestId = crypto.randomUUID()
    const response = nextMessage(limitedLive.socket, 'error', (message) => message.requestId === requestId)
    limitedLive.socket.send(JSON.stringify({ type: 'action', requestId, action: null }))
    const refused = await response
    assertEqual(refused.status, 409, 'a normal action entered the soft rate-limit band early')
  }
  const limitedRequestId = crypto.randomUUID()
  const limitedResponse = nextMessage(limitedLive.socket, 'error', (message) => message.requestId === limitedRequestId)
  limitedLive.socket.send(JSON.stringify({ type: 'action', requestId: limitedRequestId, action: null }))
  const limitedMessage = await limitedResponse
  check('a 30-action-per-second burst reports a soft limit without disconnecting', () => {
    assertEqual(limitedMessage.status, 429)
    assertEqual(limitedLive.socket.readyState, WebSocket.OPEN)
  })
  const postLimitVoice = nextMessage(limitedLive.socket, 'error')
  limitedLive.socket.send(JSON.stringify({ type: 'voice', to: 'missing', signal: { ready: true } }))
  await postLimitVoice
  const repeatedRequestId = crypto.randomUUID()
  const repeatedRateResponse = nextMessage(limitedLive.socket, 'error', (message) => message.requestId === repeatedRequestId)
  limitedLive.socket.send(JSON.stringify({ type: 'action', requestId: repeatedRequestId, action: null }))
  const repeatedRateError = await repeatedRateResponse
  check('voice traffic cannot reset the bounded over-limit response or disconnect the game', () => {
    assertEqual(repeatedRateError.status, 429)
    assertEqual(limitedLive.socket.readyState, WebSocket.OPEN)
  })
  for (let i = 0; i < 2; i++) {
    await request(`/api/rooms/${limitedCode}/action`, {
      method: 'POST', token: limited.body.token, body: { action: null },
    })
  }
  const malformedThrottled = await fetch(`${origin}/api/rooms/${limitedCode}/action`, {
    method: 'POST',
    headers: { 'x-room-token': limited.body.token, 'content-type': 'application/json' },
    body: '{',
  })
  const readable = await request(`/api/rooms/${limitedCode}`, { token: limited.body.token })
  const reconnected = await connect(limitedCode, limited.body.token)
  check('an action burst cannot starve room reads or reconnection', () => {
    assertEqual(malformedThrottled.status, 429, 'a throttled body was parsed before admission')
    assertEqual(readable.status, 200)
    assertEqual(reconnected.snapshot.you.playerId, limited.body.snapshot.you.playerId)
    assertEqual(reconnected.socket.readyState, WebSocket.OPEN)
  })
  reconnected.socket.close()

  aReturned.socket.close()
  bReturned.socket.close()
  cLive.socket.close()
  dLive.socket.close()
} finally {
  await service.close()
}

const capacityService = createRoomServer()
const capacityAddress = await capacityService.listen(0)
const capacityOrigin = `http://127.0.0.1:${capacityAddress.port}`
const capacitySockets = []
const capacityPlayers = []
const capacityRooms = []
const characters = ['ironclad', 'silent', 'defect', 'watcher']
for (let roomIndex = 0; roomIndex < 13; roomIndex += 1) {
  const source = `198.51.100.${roomIndex + 1}`
  const seats = roomIndex < 12 ? 4 : 2
  const created = await fetch(`${capacityOrigin}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': source },
    body: JSON.stringify({ name: `Capacity ${roomIndex}-0`, character: characters[0] }),
  }).then((response) => response.json())
  capacityRooms.push(created)
  const tokens = [created.token]
  for (let seatIndex = 1; seatIndex < seats; seatIndex += 1) {
    const joined = await fetch(`${capacityOrigin}/api/rooms/${created.snapshot.code}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': source },
      body: JSON.stringify({ name: `Capacity ${roomIndex}-${seatIndex}`, character: characters[seatIndex] }),
    }).then((response) => response.json())
    tokens.push(joined.token)
  }
  for (const token of tokens) {
    const socket = new WebSocket(
      `ws://127.0.0.1:${capacityAddress.port}/ws?room=${created.snapshot.code}`,
      { headers: { 'cf-connecting-ip': source } },
    )
    const authenticated = nextMessage(socket, 'snapshot')
    await new Promise((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    socket.send(JSON.stringify({ type: 'authenticate', token }))
    const authenticatedSnapshot = (await authenticated).snapshot
    capacitySockets.push(socket)
    capacityPlayers.push({ socket, token, snapshot: authenticatedSnapshot, code: created.snapshot.code })
  }
}
for (const player of capacityPlayers.slice(0, 10)) {
  const peer = capacityPlayers.find((candidate) =>
    candidate.code === player.code && candidate.token !== player.token)
  const lastSignal = nextMessage(peer.socket, 'voice', (message) =>
    message.from === player.snapshot.you.playerId && message.signal.sequence === 39)
  for (let sequence = 0; sequence < 40; sequence += 1) {
    player.socket.send(JSON.stringify({
      type: 'voice', to: peer.snapshot.you.playerId, signal: { sequence },
    }))
  }
  await lastSignal
  for (let actionIndex = 0; actionIndex < 30; actionIndex += 1) {
    const requestId = crypto.randomUUID()
    const refused = nextMessage(player.socket, 'error', (message) => message.requestId === requestId)
    player.socket.send(JSON.stringify({ type: 'action', requestId, action: null }))
    assertEqual((await refused).status, 409)
  }
}
check('ten daily players absorb repeated action and voice bursts without disconnecting', () => {
  assert(capacityPlayers.slice(0, 10).every((player) => player.socket.readyState === WebSocket.OPEN))
})
const fullHealth = await fetch(`${capacityOrigin}/api/health`).then((response) => response.json())
const replacedAtCapacity = new Promise((resolve) =>
  capacitySockets[0].once('close', (code) => resolve(code)))
const replacementAtCapacity = new WebSocket(
  `ws://127.0.0.1:${capacityAddress.port}/ws?room=${capacityRooms[0].snapshot.code}`,
  { headers: { 'cf-connecting-ip': '198.51.100.1' } },
)
const replacementSnapshot = nextMessage(replacementAtCapacity, 'snapshot')
await new Promise((resolve, reject) => {
  replacementAtCapacity.once('open', resolve)
  replacementAtCapacity.once('error', reject)
})
replacementAtCapacity.send(JSON.stringify({ type: 'authenticate', token: capacityRooms[0].token }))
await replacementSnapshot
const replacedAtCapacityCode = await replacedAtCapacity
capacitySockets[0] = replacementAtCapacity
capacityPlayers[0].socket = replacementAtCapacity
const extraSeat = await fetch(
  `${capacityOrigin}/api/rooms/${capacityRooms.at(-1).snapshot.code}/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.13' },
    body: JSON.stringify({ name: 'Capacity extra', character: 'defect' }),
  },
).then((response) => response.json())
const overCapacity = new WebSocket(
  `ws://127.0.0.1:${capacityAddress.port}/ws?room=${capacityRooms.at(-1).snapshot.code}`,
  { headers: { 'cf-connecting-ip': '203.0.113.1' } },
)
const overCapacityClosed = new Promise((resolve) =>
  overCapacity.once('close', (code) => resolve(code)))
await new Promise((resolve, reject) => {
  overCapacity.once('open', resolve)
  overCapacity.once('error', reject)
})
overCapacity.send(JSON.stringify({ type: 'authenticate', token: extraSeat.token }))
const overCapacityCode = await overCapacityClosed
const healthAfterCapacityRefusal = await fetch(`${capacityOrigin}/api/health`).then((response) => response.json())
check('fifty players stay connected, including a replacement, while a new fifty-first seat is refused cleanly', () => {
  assertEqual(capacitySockets.length, 50)
  assertEqual(fullHealth.connections, 50)
  assertEqual(replacedAtCapacityCode, 4001)
  assertEqual(healthAfterCapacityRefusal.connections, 50)
  assert(capacitySockets.every((socket) => socket.readyState === WebSocket.OPEN),
    'a player disconnected during the fifty-client load check')
  assertEqual(overCapacityCode, 4009)
})
for (const socket of capacitySockets) socket.close()
await capacityService.close()

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

const entryService = createRoomServer()
const entryAddress = await entryService.listen(0)
const entryOrigin = `http://127.0.0.1:${entryAddress.port}`
const entry = (path, body) => fetch(`${entryOrigin}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
try {
  for (let index = 0; index < 9; index += 1) {
    assertEqual((await entry('/api/rooms', { name: `Fill ${index}`, character: 'ironclad' })).status, 201)
  }
  const createRequestId = crypto.randomUUID()
  const boundaryCreate = await entry('/api/rooms', { name: 'Boundary', character: 'ironclad', requestId: createRequestId })
  const boundaryBody = await boundaryCreate.json()
  const repeatedCreate = await entry('/api/rooms', { name: 'Boundary', character: 'ironclad', requestId: createRequestId })
  for (let index = 1; index < 30; index += 1) {
    assertEqual((await entry('/api/rooms', { name: 'Boundary', character: 'ironclad', requestId: createRequestId })).status, 200)
  }
  const throttledReplay = await entry('/api/rooms', { name: 'Boundary', character: 'ironclad', requestId: createRequestId })

  const code = boundaryBody.snapshot.code
  for (let index = 0; index < 29; index += 1) {
    await entry(`/api/rooms/${code}/join`, { name: 'Invalid', character: 'invalid' })
  }
  const joinRequestId = crypto.randomUUID()
  const boundaryJoin = await entry(`/api/rooms/${code}/join`, { name: 'Joining', character: 'silent', requestId: joinRequestId })
  const repeatedJoin = await entry(`/api/rooms/${code}/join`, { name: 'Joining', character: 'silent', requestId: joinRequestId })

  let requestSeen
  const seen = new Promise((resolve) => { requestSeen = resolve })
  const onRequest = (request) => {
    if (request.url === `/api/rooms/${code}/join`) {
      entryService.server.off('request', onRequest)
      requestSeen()
    }
  }
  entryService.server.on('request', onRequest)
  const expiredResponse = new Promise((resolve, reject) => {
    const request = httpRequest(`${entryOrigin}/api/rooms/${code}/join`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
    }, (response) => {
      response.resume()
      response.once('end', () => resolve(response.statusCode))
    })
    request.once('error', reject)
    request.write('{"name":"Joining",')
    void seen.then(() => {
      entryService.store.rooms.delete(code)
      request.end(`"character":"silent","requestId":"${joinRequestId}"}`)
    })
  })
  const expiredStatus = await expiredResponse

  check('entry retries survive the rate boundary without enabling unlimited replay or stale-room recovery', () => {
    assertEqual(repeatedCreate.status, 200)
    assertEqual(throttledReplay.status, 429)
    assertEqual(boundaryJoin.status, 200)
    assertEqual(repeatedJoin.status, 200)
    assertEqual(expiredStatus, 404)
  })
} finally {
  await entryService.close()
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
const failedCloseMarker = join(tmpdir(), `sts-room-close-failure-${process.pid}-${Date.now()}.ok`)
try { await failingCloseService.close({ markerFile: failedCloseMarker }) } catch (error) { closeFailure = error }
check('closing reports a failed final flush after still closing the server', () => {
  assertEqual(closeFailure?.message, 'injected close save failure')
  assertEqual(closeErrors[0], 'injected close save failure')
  assertEqual(failingCloseService.server.listening, false)
  assertEqual(existsSync(failedCloseMarker), false, 'a failed flush published a success marker')
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

const restartDirectory = mkdtempSync(join(tmpdir(), 'sts-room-restart-'))
const restartStore = join(restartDirectory, 'rooms.json')
const restartMarker = join(restartDirectory, 'flushed.ok')
const restartService = createRoomServer({
  storeFile: restartStore,
  saveDelayMs: 10_000,
})
const restartAddress = await restartService.listen(0)
const restartOrigin = `http://127.0.0.1:${restartAddress.port}`
const restartCreated = await fetch(`${restartOrigin}/api/rooms`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Restart', character: 'ironclad' }),
}).then((response) => response.json())
const restartJoined = await fetch(`${restartOrigin}/api/rooms/${restartCreated.snapshot.code}/join`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Restart Guest', character: 'silent' }),
}).then((response) => response.json())
async function reconnectTo(port, code, token) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${code}`)
  const authenticated = nextMessage(socket, 'snapshot')
  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  socket.send(JSON.stringify({ type: 'authenticate', token }))
  return { socket, snapshot: (await authenticated).snapshot }
}
await reconnectTo(restartAddress.port, restartCreated.snapshot.code, restartCreated.token)
await reconnectTo(restartAddress.port, restartCreated.snapshot.code, restartJoined.token)
const restartStarted = await fetch(`${restartOrigin}/api/rooms/${restartCreated.snapshot.code}/start`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-room-token': restartCreated.token },
  body: '{}',
})
assertEqual(restartStarted.status, 200)
const restartRoom = restartService.store.rooms.get(restartCreated.snapshot.code)
const hiddenNeowDeck = structuredClone(restartRoom.run.neow.deck)
const exactRestartRoom = JSON.stringify(restartService.store.rooms.get(restartCreated.snapshot.code))
await restartService.close({ preserveRooms: true, markerFile: restartMarker })
check('a coordinated restart flushes the exact room without disconnect settlement', () => {
  const persisted = JSON.parse(readFileSync(restartStore, 'utf8')).rooms[0]
  assertEqual(JSON.stringify(persisted), exactRestartRoom)
  assert(existsSync(restartMarker), 'a successful restart omitted its flush marker')
})

const recoveredService = createRoomServer({
  storeFile: restartStore, restartRecovery: true, restartReconnectMs: 10 * 60_000,
})
const recoveredAddress = await recoveredService.listen(0)
const recoveredOrigin = `http://127.0.0.1:${recoveredAddress.port}`
const recoveredRoom = recoveredService.store.rooms.get(restartCreated.snapshot.code)
const unknownJoin = await fetch(`${recoveredOrigin}/api/rooms/${restartCreated.snapshot.code}/join`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Intruder', character: 'defect' }),
})
const blockedBeforeReconnect = await fetch(`${recoveredOrigin}/api/rooms/${restartCreated.snapshot.code}/action`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-room-token': restartCreated.token },
  body: JSON.stringify({ action: { kind: 'give-up-vote', vote: true } }),
})
const recoveredHost = await reconnectTo(
  recoveredAddress.port, restartCreated.snapshot.code, restartCreated.token,
)
const blockedAfterOneReconnect = await fetch(`${recoveredOrigin}/api/rooms/${restartCreated.snapshot.code}/action`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-room-token': restartCreated.token },
  body: JSON.stringify({ action: { kind: 'give-up-vote', vote: true } }),
})
const recoveredGuest = await reconnectTo(
  recoveredAddress.port, restartCreated.snapshot.code, restartJoined.token,
)
check('a persisted two-seat run blocks changes until the reconnect quorum restores without leaking hidden state', () => {
  assertEqual(unknownJoin.status, 409)
  assertEqual(blockedBeforeReconnect.status, 409)
  assertEqual(blockedAfterOneReconnect.status, 409)
  assertEqual(recoveredService.store.reconnectQuorums.has(restartCreated.snapshot.code), false)
  assert(recoveredRoom.seats.every((seat) => seat.connected), 'the recovered seats did not reconnect')
  assertEqual(JSON.stringify(recoveredRoom.run.neow.deck), JSON.stringify(hiddenNeowDeck))
  assertEqual(Object.hasOwn(recoveredHost.snapshot.run.neow, 'deck'), false)
  assertEqual(Object.hasOwn(recoveredGuest.snapshot.run.neow, 'deck'), false)
  assertEqual(recoveredHost.snapshot.run.players[1].deck, null)
  assertEqual(recoveredGuest.snapshot.run.players[0].deck, null)
})
await recoveredService.close({ preserveRooms: true })

const consecutiveService = createRoomServer({
  storeFile: restartStore, restartRecovery: true, restartReconnectMs: 10 * 60_000,
})
await consecutiveService.listen(0)
check('a consecutive restart retains both the reconnect quorum and hidden run state', () => {
  const consecutiveRoom = consecutiveService.store.rooms.get(restartCreated.snapshot.code)
  assertEqual(consecutiveService.store.reconnectQuorums.get(restartCreated.snapshot.code)?.playerIds.size, 2)
  assertEqual(JSON.stringify(consecutiveRoom.run.neow.deck), JSON.stringify(hiddenNeowDeck))
})
await consecutiveService.close({ preserveRooms: true })
rmSync(restartDirectory, { recursive: true, force: true })

const restoredService = createRoomServer()
const restoredAddress = await restoredService.listen(0)
const restoredOrigin = `http://127.0.0.1:${restoredAddress.port}`
const restoredCreated = await fetch(`${restoredOrigin}/api/rooms`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Restored', character: 'ironclad' }),
}).then((response) => response.json())
for (let index = 0; index < 1024; index += 1) {
  const invalid = new WebSocket(`ws://127.0.0.1:${restoredAddress.port}/ws?room=MISSING${index}`)
  const status = await new Promise((resolve, reject) => {
    invalid.once('unexpected-response', (_request, response) => {
      response.resume()
      resolve(response.statusCode)
    })
    invalid.once('error', reject)
  })
  assertEqual(status, index < 120 ? 401 : 429)
}
const restoredSocket = new WebSocket(`ws://127.0.0.1:${restoredAddress.port}/ws?room=${restoredCreated.snapshot.code}`)
await new Promise((resolve, reject) => {
  restoredSocket.once('open', resolve)
  restoredSocket.once('error', reject)
})
await new Promise((resolve) => {
  restoredSocket.once('close', resolve)
  restoredSocket.close()
})
await restoredService.close()
check('invalid room upgrades cannot exhaust room rate keys', () => {
  assertEqual(restoredSocket.readyState, WebSocket.CLOSED)
})

const pagesOrigin = 'https://hieu-lee.github.io'
const corsService = createRoomServer({ allowedOrigin: pagesOrigin })
const corsAddress = await corsService.listen(0)
const corsOrigin = `http://127.0.0.1:${corsAddress.port}`
try {
  const allowed = await fetch(`${corsOrigin}/api/rooms`, {
    method: 'OPTIONS',
    headers: { origin: pagesOrigin, 'access-control-request-headers': 'x-room-token' },
  })
  const refused = await fetch(`${corsOrigin}/api/rooms`, {
    method: 'OPTIONS', headers: { origin: 'https://example.com' },
  })
  const refusedPost = await fetch(`${corsOrigin}/api/rooms`, {
    method: 'POST',
    headers: { origin: 'https://example.com', 'content-type': 'text/plain' },
    body: JSON.stringify({ name: 'Cross-site', character: 'ironclad' }),
  })
  const resetTarget = `${pagesOrigin}/slay-the-spire-the-boardgam/?run-vod-export=run-1`
  const reset = await fetch(`${corsOrigin}/run-vod-reset?return=${encodeURIComponent(resetTarget)}`)
  const resetBody = await reset.text()
  const raster = await fetch(`${corsOrigin}/run-vod-raster`)
  const rasterBody = await raster.text()
  const refusedReset = await fetch(`${corsOrigin}/run-vod-reset?return=${encodeURIComponent('https://example.com/')}`)
  const refusedSocketStatus = await new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${corsAddress.port}/ws?room=ABCDEF`, { origin: 'https://example.com' })
    socket.once('unexpected-response', (_request, response) => resolve(response.statusCode))
    socket.once('open', () => reject(new Error('cross-site WebSocket opened')))
    socket.once('error', () => {})
  })
  check('only the stable Pages origin may call the room API cross-origin', () => {
    assertEqual(allowed.status, 204)
    assertEqual(allowed.headers.get('access-control-allow-origin'), pagesOrigin)
    assert(allowed.headers.get('access-control-allow-headers').includes('x-room-token'))
    assertEqual(refused.status, 403)
    assertEqual(refused.headers.get('access-control-allow-origin'), null)
    assertEqual(refusedPost.status, 403)
    assertEqual(reset.status, 200)
    assertEqual(reset.headers.get('cross-origin-opener-policy'), 'same-origin')
    assert(resetBody.includes(JSON.stringify(resetTarget)))
    assertEqual(raster.status, 200)
    assert(rasterBody.includes('transferToImageBitmap'))
    assertEqual(refusedReset.status, 403)
    assertEqual(refusedSocketStatus, 401)
    assertEqual(corsService.store.rooms.size, 0)
  })
} finally {
  await corsService.close()
}

report('room server')
