// Co-op rooms: seats, reconnection, action authorisation, hidden information.
//
// The hidden-information checks here scan the WHOLE serialised snapshot rather
// than asserting on the fields we happen to redact today. A leak added later
// through some new field is exactly the bug that would otherwise ship, and it
// is invisible to a test that only looks where it already knows to look.
import {
  CHARACTERS,
  MAX_SEATS,
  UID_LIMIT,
  apply,
  chooseAscension,
  chooseCharacter,
  chooseLastStandRule,
  chooseRunMeta,
  chooseRelicRule,
  createRoom,
  createStore,
  uidList,
  joinRoom,
  markDisconnected,
  removeSeat,
  roomCode,
  snapshotFor,
  startRun,
} from './lib/rooms.mjs'
import { CAPS, CARDS, GOLDEN_TICKET, REBUILT_END_TURN_ORDER, ROOM_LABEL, STALE_END_TURN_ORDER, cardNeedsEnemy, enteringRoom, lightningRowTarget, previewCardChoice, roomChoices } from '../src/game/state.ts'
import { createMerchant, createRelicReward } from '../src/game/noncombat.ts'
import { createEventRoom } from '../src/game/event-room.ts'
import { EVENT_DEFINITIONS } from '../src/game/events.ts'
import { suite, check, assert, assertEqual, assertDeepEqual, assertThrows, report } from './lib/harness.mjs'

/** Every string that appears anywhere in a structure, at any depth. */
function allStrings(value, out = []) {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const item of value) allStrings(item, out)
  else if (value && typeof value === 'object') for (const item of Object.values(value)) allStrings(item, out)
  return out
}

/** Every key name that appears anywhere in a structure, at any depth. */
function allKeys(value, out = []) {
  if (Array.isArray(value)) for (const item of value) allKeys(item, out)
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      out.push(key)
      allKeys(item, out)
    }
  }
  return out
}

function finishNeow(room) {
  while (room.run.phase === 'neow') {
    let changed = false
    for (const seat of room.seats) {
      const preview = snapshotFor(room, seat.token).run.neow?.players[seat.playerId]
      if (!preview || preview.done) continue
      if (preview.redGoldPending) {
        apply(room, seat.token, { kind: 'neow', stage: 'redGold', gain: false })
      } else if (preview.redRewardPending) {
        apply(room, seat.token, { kind: 'neow', stage: 'red', choice: null })
      } else if (preview.pendingEffect) {
        apply(room, seat.token, { kind: 'neow', stage: 'effect', gain: false })
      } else if (preview.blueOption === null) {
        apply(room, seat.token, { kind: 'neow', stage: 'option', optionIndex: 0 })
      } else if (preview.rewardKind) {
        apply(room, seat.token, {
          kind: 'neow', stage: 'reward',
          choice: null,
        })
      }
      changed = true
    }
    assert(changed, 'Neow fixture could not make progress')
  }
}

/**
 * A run opens on the map, so a room fixture that wants a combat has to walk
 * into one. Resolve any multi-ability Start-of-Turn choice so fixtures that
 * exercise the Player Turn do not depend on the party size.
 */
function enterFirstCombat(room, seatToken) {
  finishNeow(room)
  const [first] = roomChoices(room.run)
  apply(room, seatToken, { kind: 'enterRoom', roomId: first.id })
  if (room.run.combat?.phase === 'start') {
    const abilities = snapshotFor(room, seatToken).startTurnAbilities
    apply(room, seatToken, {
      kind: 'resolveStartTurn',
      choices: abilities.map((ability) => ({
        id: ability.id,
        enemyUid: ability.targets?.[0]?.uid,
        shivEnemyUids: Array(ability.overflowShivs).fill(null),
      })),
    })
  }
  return room
}

function twoSeatRoom() {
  const store = createStore()
  const room = createRoom(store, { code: 'TESTAA' })
  const a = joinRoom(room, { name: 'Ann', character: 'ironclad' })
  const b = joinRoom(room, { name: 'Bo', character: 'silent' })
  startRun(room, a.token, { seed: 2 })
  enterFirstCombat(room, a.token)
  return { store, room, a, b }
}

/**
 * Makes the end-of-turn discard prompt appear for these seats.
 *
 * The turn only stops to collect an order from a player whose deck contains a
 * card that reads the top of the discard pile — Claw is the cheapest one. Every
 * fixture below that exercises the ordering protocol has to opt in explicitly,
 * which is the point: an ordinary hand never reaches that prompt any more.
 */
function wantsDiscardOrder(room, ...playerIds) {
  for (const playerId of playerIds) {
    const player = room.run.combat.players.find((candidate) => candidate.id === playerId)
    player.draw = [...player.draw, { uid: `claw-${playerId}`, defId: 'claw', upgraded: false }]
  }
}

function threeSeatRoom() {
  const store = createStore()
  const room = createRoom(store, { code: 'TESTAB' })
  const a = joinRoom(room, { name: 'Ann', character: 'ironclad' })
  const b = joinRoom(room, { name: 'Bo', character: 'silent' })
  const c = joinRoom(room, { name: 'Cy', character: 'defect' })
  startRun(room, a.token, { seed: 2 })
  enterFirstCombat(room, a.token)
  return { store, room, a, b, c }
}

suite('room codes')

check('codes avoid glyphs that sound alike over voice', () => {
  // O/0 and I/1/L are the pairs that get misheard when read aloud.
  const code = roomCode()
  for (const glyph of ['O', '0', 'I', '1', 'S', '5', 'B', '8', 'Z', '2']) {
    assert(!code.includes(glyph), `code ${code} contains ambiguous glyph ${glyph}`)
  }
})

check('codes are not all identical', () => {
  const codes = new Set(Array.from({ length: 50 }, () => roomCode()))
  assert(codes.size > 40, `50 codes collapsed to ${codes.size} distinct values`)
})

check('Choose Your Relic is a persisted server-authoritative multiplayer lobby option', () => {
  const store = createStore()
  const room = createRoom(store, { code: 'RELICX' })
  const a = joinRoom(room, { name: 'Ann', character: 'ironclad' })
  const b = joinRoom(room, { name: 'Bo', character: 'silent' })
  chooseRelicRule(room, a.token, true)
  assertEqual(snapshotFor(room, b.token).chooseYourRelic, true)
  markDisconnected(room, b.token)
  joinRoom(room, { token: b.token })
  assertEqual(snapshotFor(room, b.token).chooseYourRelic, true)
  startRun(room, a.token, { seed: 17 })
  assertEqual(room.run.chooseYourRelic, true)
})

check('Choose Your Relic turns off when its lobby becomes solo', () => {
  const store = createStore()
  const room = createRoom(store, { code: 'RELICS' })
  const a = joinRoom(room, { name: 'Ann', character: 'ironclad' })
  const b = joinRoom(room, { name: 'Bo', character: 'silent' })
  chooseRelicRule(room, a.token, true)
  removeSeat(room, b.token)
  assertEqual(snapshotFor(room, a.token).chooseYourRelic, false)
  startRun(room, a.token, { seed: 18 })
  assertEqual(room.run.chooseYourRelic, false)
})

check('The Last Stand is host-controlled, reconnect-safe, and carried into the run', () => {
  const room = createRoom(createStore(), { code: 'STANDA' })
  const host = joinRoom(room, { name: 'Ann', character: 'ironclad' })
  const guest = joinRoom(room, { name: 'Bo', character: 'silent' })
  assertEqual(snapshotFor(room, guest.token).lastStand, false)
  let refused
  try { chooseLastStandRule(room, guest.token, true) } catch (error) { refused = error }
  assertEqual(refused?.name, 'RoomError')
  assertEqual(room.lastStand, false, 'a non-host changed the lobby rule')
  chooseLastStandRule(room, host.token, true)
  assertEqual(snapshotFor(room, guest.token).lastStand, true)
  markDisconnected(room, guest.token)
  joinRoom(room, { token: guest.token })
  assertEqual(snapshotFor(room, guest.token).lastStand, true)
  startRun(room, host.token, { seed: 19 })
  assertEqual(room.run.lastStand, true)
})

check('The Last Stand rejects solo tables and turns off when its lobby becomes solo', () => {
  const room = createRoom(createStore(), { code: 'STANDS' })
  const host = joinRoom(room, { name: 'Ann', character: 'ironclad' })
  let refused
  try { chooseLastStandRule(room, host.token, true) } catch (error) { refused = error }
  assertEqual(refused?.name, 'RoomError')
  const guest = joinRoom(room, { name: 'Bo', character: 'silent' })
  chooseLastStandRule(room, host.token, true)
  removeSeat(room, guest.token)
  assertEqual(snapshotFor(room, host.token).lastStand, false)
})

check('disconnect snapshots tolerate legacy partial run markers', () => {
  const room = createRoom(createStore(), { code: 'LEGACY' })
  const seat = joinRoom(room, { name: 'Ann', character: 'ironclad' })
  room.run = { phase: 'map' }
  assertEqual(markDisconnected(room, seat.token).run, null)
})

suite('give-up authority')

check('all eligible players must vote yes and the vote survives reconnect', () => {
  const { room, a, b } = twoSeatRoom()
  apply(room, a.token, { kind: 'giveUpVote', vote: 'start' })
  const deadlineAt = snapshotFor(room, a.token).giveUpVote.deadlineAt
  apply(room, a.token, { kind: 'giveUpVote', vote: 'yes', deadlineAt })
  assertEqual(room.run.phase, 'combat', 'one yes vote surrendered the party')
  room.run.courier.offer = { playerId: a.playerId, kind: 'potion', id: 'block_potion' }
  room.courierPledge = { playerId: a.playerId, id: 'block_potion', payments: { [a.playerId]: 1 } }
  markDisconnected(room, b.token)
  joinRoom(room, { token: b.token })
  assertEqual(snapshotFor(room, b.token).giveUpVote.votes[a.playerId], true)
  apply(room, b.token, { kind: 'giveUpVote', vote: 'yes', deadlineAt })
  assertEqual(room.run.phase, 'defeat')
  assertEqual(room.run.courier.offer, null)
  assertEqual(room.courierPledge, undefined)
  assertEqual(snapshotFor(room, a.token).giveUpVote, undefined)
})

check('an open vote freezes queued actions and disconnect settlement', () => {
  const { room, a, b } = twoSeatRoom()
  room.endTurnReady = { [a.playerId]: true }
  room.run.courier.offer = { playerId: b.playerId, kind: 'potion', id: 'block_potion' }
  apply(room, b.token, { kind: 'giveUpVote', vote: 'start' })
  const frozenRun = structuredClone(room.run)
  let blocked
  try { apply(room, a.token, { kind: 'endTurn' }) } catch (error) { blocked = error }
  assertEqual(blocked?.name, 'RoomError', 'a normal action bypassed the open vote')
  markDisconnected(room, b.token)
  assertDeepEqual(room.run, frozenRun, 'disconnect cleanup mutated the run behind the vote')
  assert(snapshotFor(room, a.token).giveUpVote, 'disconnect cleared the open vote')
})

check('a no vote and an expired deadline cannot surrender the fight', () => {
  const { room, a, b } = twoSeatRoom()
  apply(room, a.token, { kind: 'giveUpVote', vote: 'start' })
  const deadlineAt = room.giveUpVote.deadlineAt
  apply(room, a.token, { kind: 'giveUpVote', vote: 'no', deadlineAt })
  apply(room, b.token, { kind: 'giveUpVote', vote: 'yes', deadlineAt })
  assertEqual(room.run.phase, 'combat')
  room.giveUpVote.deadlineAt = Date.now() - 1
  assertEqual(snapshotFor(room, a.token).giveUpVote, undefined, 'an expired vote remained visible')
  let expired
  try { apply(room, a.token, { kind: 'giveUpVote', vote: 'yes', deadlineAt: room.giveUpVote.deadlineAt }) } catch (error) { expired = error }
  assertEqual(expired?.name, 'RoomError')
  assertEqual(room.run.phase, 'combat', 'a late yes vote surrendered the party')
})

check('a vote disappears when another action ends the run', () => {
  const { room, a } = twoSeatRoom()
  room.run = { ...room.run, phase: 'map', combat: null }
  apply(room, a.token, { kind: 'giveUpVote', vote: 'start' })
  assert(snapshotFor(room, a.token).giveUpVote)
  room.run = { ...room.run, phase: 'defeat' }
  assertEqual(snapshotFor(room, a.token).giveUpVote, undefined, 'a terminal run kept a stale give-up modal')
})

check('a run-wide vote stays active across room phase transitions', () => {
  const { room, a } = twoSeatRoom()
  const combat = room.run.combat
  room.run = { ...room.run, phase: 'map', combat: null }
  apply(room, a.token, { kind: 'giveUpVote', vote: 'start' })
  const runId = snapshotFor(room, a.token).giveUpVote.runId
  room.run = { ...room.run, phase: 'combat', combat }
  assertEqual(snapshotFor(room, a.token).giveUpVote.runId, runId, 'the map vote vanished during combat')
  room.run = { ...room.run, phase: 'reward', combat: null }
  assertEqual(snapshotFor(room, a.token).giveUpVote.runId, runId, 'the map vote did not survive into rewards')
})

check('a one-seat online fight gives up immediately without a vote wait', () => {
  const room = createRoom(createStore(), { code: 'GIVEUP' })
  const seat = joinRoom(room, { name: 'Ann', character: 'ironclad' })
  startRun(room, seat.token, { seed: 20 })
  enterFirstCombat(room, seat.token)
  room.cardPreviews = { [seat.playerId]: { cardUid: 'stale' } }
  room.endTurnReady = { [seat.playerId]: true }
  room.endTurnAbilities = [{ id: 'stale' }]
  room.endTurnOrder = ['stale']
  room.startTurnCombatId = room.run.combat.combatId
  room.startTurnOrder = ['stale']
  room.campfireChoices = { [seat.playerId]: { kind: 'rest' } }
  room.rewardChoices = { [seat.playerId]: null }
  room.rewardConfirmed = { [seat.playerId]: true }
  room.merchantPledges = { stale: { buyerId: seat.playerId, payments: {} } }
  room.eventPledge = { actorId: seat.playerId }
  apply(room, seat.token, { kind: 'giveUpVote', vote: 'start' })
  assertEqual(room.run.phase, 'defeat')
  for (const key of ['cardPreviews', 'endTurnReady', 'endTurnAbilities', 'endTurnOrder', 'startTurnCombatId', 'startTurnOrder',
    'campfireChoices', 'rewardChoices', 'rewardConfirmed', 'merchantPledges', 'eventPledge']) {
    assertEqual(room[key], undefined, `one-seat surrender retained ${key}`)
  }
})

check('all players can give up together from the map and an Act boundary', () => {
  const { room, a, b } = twoSeatRoom()
  room.run = { ...room.run, phase: 'map', combat: null }
  apply(room, a.token, { kind: 'giveUpVote', vote: 'start' })
  const { deadlineAt } = snapshotFor(room, a.token).giveUpVote
  apply(room, a.token, { kind: 'giveUpVote', vote: 'yes', deadlineAt })
  assertEqual(room.run.phase, 'map', 'one vote ended the shared run')
  apply(room, b.token, { kind: 'giveUpVote', vote: 'yes', deadlineAt })
  assertEqual(room.run.phase, 'defeat')
  assert(room.run.log.includes('The party gives up.'))

  room.run = { ...room.run, phase: 'victory', act: 1, campaign: { ...room.run.campaign, finalized: false } }
  apply(room, a.token, { kind: 'giveUpVote', vote: 'start' })
  const boundaryVote = snapshotFor(room, a.token).giveUpVote
  apply(room, a.token, { kind: 'giveUpVote', vote: 'yes', deadlineAt: boundaryVote.deadlineAt })
  apply(room, b.token, { kind: 'giveUpVote', vote: 'yes', deadlineAt: boundaryVote.deadlineAt })
  assertEqual(room.run.phase, 'defeat', 'the party could not give up between Acts')
})

check('a pending Catch Up reservation cannot vote in another party run', () => {
  const room = createRoom(createStore(), { code: 'GIVEPN' })
  const leader = joinRoom(room, { name: 'Ann', character: 'ironclad' })
  startRun(room, leader.token, { seed: 21 })
  finishNeow(room)
  room.run.act = 2
  room.run.map = { ...room.run.map, act: 2, position: null }
  const pending = joinRoom(room, { name: 'Bo', character: 'silent', connected: false })
  let refused
  try { apply(room, pending.token, { kind: 'giveUpVote', vote: 'start' }) } catch (error) { refused = error }
  assertEqual(refused?.name, 'RoomError')
  assertEqual(room.run.phase, 'map', 'a reserved Catch Up seat surrendered the active run')
  apply(room, leader.token, { kind: 'giveUpVote', vote: 'start' })
  assert(!room.seats.some((seat) => seat.pendingCatchUp), 'surrender retained a pending Catch Up reservation')
  apply(room, leader.token, { kind: 'finishRun' })
  assertEqual(room.run.campaign.finalized, true, 'a Catch Up reservation blocked surrender finalization')
})

check('pending Catch Up viewers never receive another party give-up vote', () => {
  const { room, a } = twoSeatRoom()
  room.run = { ...room.run, act: 2, phase: 'map', combat: null, map: { ...room.run.map, act: 2, position: null } }
  const pending = joinRoom(room, { name: 'Cy', character: 'defect', connected: false })
  apply(room, a.token, { kind: 'giveUpVote', vote: 'start' })
  assert(snapshotFor(room, a.token).giveUpVote, 'active players did not receive their give-up vote')
  assertEqual(snapshotFor(room, pending.token).giveUpVote, undefined,
    'an ineligible Catch Up reservation received the give-up vote')
})

check('a player completing Catch Up joins an open run-wide vote', () => {
  const { room, a } = twoSeatRoom()
  room.run = { ...room.run, act: 2, phase: 'map', combat: null, map: { ...room.run.map, act: 2, position: null } }
  apply(room, a.token, { kind: 'giveUpVote', vote: 'start' })
  const pending = joinRoom(room, { name: 'Cy', character: 'defect', connected: false })
  joinRoom(room, { token: pending.token, connected: true })
  const vote = snapshotFor(room, pending.token).giveUpVote
  assert(vote.eligiblePlayerIds.includes(pending.playerId), 'the Catch Up player was excluded from the open vote')
  apply(room, pending.token, { kind: 'giveUpVote', vote: 'yes', deadlineAt: vote.deadlineAt })
  assertEqual(snapshotFor(room, a.token).giveUpVote.votes[pending.playerId], true)
})

check('fallen Last Stand players still vote before a multiplayer fight is given up', () => {
  const { room, a, b } = twoSeatRoom()
  room.run.lastStand = true
  room.run.combat.lastStand = true
  const fallen = room.run.combat.players.find((player) => player.id === b.playerId)
  Object.assign(fallen, { hp: 0, dead: true })
  apply(room, a.token, { kind: 'giveUpVote', vote: 'start' })
  const vote = snapshotFor(room, a.token).giveUpVote
  assertDeepEqual(vote.eligiblePlayerIds, [a.playerId, b.playerId])
  apply(room, a.token, { kind: 'giveUpVote', vote: 'yes', deadlineAt: vote.deadlineAt })
  assertEqual(room.run.phase, 'combat', 'the survivor surrendered without the fallen player')
  apply(room, b.token, { kind: 'giveUpVote', vote: 'yes', deadlineAt: vote.deadlineAt })
  assertEqual(room.run.phase, 'defeat')
})

suite('Neow authority')

check('Neow deals public faces without leaking its remaining deck and blocks normal play', () => {
  const room = createRoom(createStore(), { code: 'NEOWAA' })
  const seats = CHARACTERS.map((character, index) => joinRoom(room, { name: `Player ${index + 1}`, character }))
  startRun(room, seats[0].token, { seed: 410 })
  const hidden = [...room.run.neow.deck]
  const snapshot = snapshotFor(room, seats[1].token)
  assertEqual(snapshot.run.phase, 'neow')
  assertEqual(Object.hasOwn(snapshot.run.neow, 'deck'), false, 'the face-down Neow deck was serialized')
  assertEqual(Object.keys(snapshot.run.neow.players).length, 4, 'not every dealt Neow face is public')
  for (const cardId of hidden) assert(!allStrings(snapshot).includes(cardId), `hidden Neow card ${cardId} leaked`)
  let blocked
  try { apply(room, seats[0].token, { kind: 'enterRoom', roomId: room.run.map.rows[0]?.[0] }) } catch (error) { blocked = error }
  assertEqual(blocked?.name, 'RoomError')
})

check('Neow binds every stage to the authenticated seat and rejects stale or forged choices', () => {
  const room = createRoom(createStore(), { code: 'NEOWAB' })
  const a = joinRoom(room, { name: 'Ann', character: 'ironclad' })
  const b = joinRoom(room, { name: 'Bo', character: 'silent' })
  startRun(room, a.token, { seed: 411 })
  apply(room, a.token, { kind: 'neow', stage: 'redGold', gain: false })
  const before = JSON.stringify(room.run)
  for (const action of [
    { kind: 'neow', stage: 'red', playerId: b.playerId, choice: null },
    { kind: 'neow', stage: 'option', optionIndex: 0 },
    { kind: 'neow', stage: 'red', choice: 99 },
  ]) {
    let refused
    try { apply(room, a.token, action) } catch (error) { refused = error }
    assertEqual(refused?.name, 'RoomError')
    assertEqual(JSON.stringify(room.run), before, 'a refused Neow action changed authoritative state')
  }
  apply(room, a.token, { kind: 'neow', stage: 'red', choice: null })
  const afterRed = JSON.stringify(room.run)
  for (const action of [
    { kind: 'neow', stage: 'red', choice: null },
    { kind: 'neow', stage: 'option', optionIndex: -1 },
    { kind: 'neow', stage: 'option', optionIndex: 3 },
    { kind: 'neow', stage: 'option', optionIndex: 0, cardUids: ['forged-card'] },
  ]) {
    let refused
    try { apply(room, a.token, action) } catch (error) { refused = error }
    assertEqual(refused?.name, 'RoomError')
    assertEqual(JSON.stringify(room.run), afterRed, 'a stale or forged Neow choice changed the run')
  }
})

check('Neow reveal is authenticated, public, and skip-unseen preserves exact deck order', () => {
  const room = createRoom(createStore(), { code: 'NEOWAR' })
  const a = joinRoom(room, { name: 'Ann', character: 'ironclad' })
  const b = joinRoom(room, { name: 'Bo', character: 'silent' })
  startRun(room, a.token, { seed: 412 })
  apply(room, a.token, { kind: 'neow', stage: 'redGold', gain: false })
  apply(room, b.token, { kind: 'neow', stage: 'redGold', gain: false })
  const before = [...room.run.players[0].cardRewards]
  let refused
  try { apply(room, b.token, { kind: 'neow', stage: 'reveal', playerId: a.playerId }) } catch (error) { refused = error }
  assertEqual(refused?.name, 'RoomError')
  assertDeepEqual(room.run.players[0].cardRewards, before)
  refused = undefined
  try { apply(room, a.token, { kind: 'neow', stage: 'reveal', choice: null }) } catch (error) { refused = error }
  assertEqual(refused?.name, 'RoomError')

  apply(room, a.token, { kind: 'neow', stage: 'reveal' })
  const owner = snapshotFor(room, a.token).run.neow.players[a.playerId]
  const observer = snapshotFor(room, b.token).run.neow.players[a.playerId]
  assert(owner.redReward?.choices.length > 0, 'revealed red offer was absent')
  assertDeepEqual(observer.redReward, owner.redReward, 'face-up reward was not public')
  assertDeepEqual(room.run.players[0].cardRewards, before, 'reveal advanced the deck before resolution')
  apply(room, a.token, { kind: 'neow', stage: 'red', choice: null })
  assertDeepEqual(room.run.players[0].cardRewards.slice(-owner.redReward.cardsDrawn.length), owner.redReward.cardsDrawn)

  const beforeB = [...room.run.players[1].cardRewards]
  apply(room, b.token, { kind: 'neow', stage: 'red', choice: null })
  assertDeepEqual(room.run.players[1].cardRewards, beforeB, 'unseen red skip drew or bottomed cards')
})

check('Prismatic Neow sources are unique, available, and server-authoritative', () => {
  const room = createRoom(createStore(), { code: 'NEOWPR' })
  const seat = joinRoom(room, { name: 'Ann', character: 'ironclad' })
  chooseRunMeta(room, seat.token, { mode: 'custom', modifiers: ['prismatic_shard'], quickStartAct: 1 })
  startRun(room, seat.token, { seed: 413 })
  apply(room, seat.token, { kind: 'neow', stage: 'redGold', gain: false })
  const sources = snapshotFor(room, seat.token).run.neow.players[seat.playerId].availableSources
  assert(sources.length >= 3, 'Prismatic fixture needs three authoritative reward sources')
  const before = JSON.stringify(room.run)
  for (const forged of [
    [sources[0], sources[0], sources[1]],
    [sources[0], sources[1], 'forged'],
  ]) {
    let refused
    try { apply(room, seat.token, { kind: 'neow', stage: 'reveal', sources: forged }) } catch (error) { refused = error }
    assertEqual(refused?.name, 'RoomError')
    assertEqual(JSON.stringify(room.run), before, 'a forged source selection changed Neow state')
  }
  apply(room, seat.token, { kind: 'neow', stage: 'reveal', sources: sources.slice(0, 3) })
  const offer = snapshotFor(room, seat.token).run.neow.players[seat.playerId].redReward
  assertEqual(offer.prismaticDraws.length, 3)
  assertDeepEqual(offer.prismaticDraws.map((draw) => draw.source), sources.slice(0, 3))
})

check('Neow preserves pending choices across disconnect and completes one through four seats', () => {
  for (let count = 1; count <= 4; count++) {
    const room = createRoom(createStore(), { code: `NEOW${count}X` })
    const seats = CHARACTERS.slice(0, count).map((character, index) =>
      joinRoom(room, { name: `Player ${index + 1}`, character }))
    startRun(room, seats[0].token, { seed: 420 + count })
    apply(room, seats.at(-1).token, { kind: 'neow', stage: 'redGold', gain: false })
    apply(room, seats.at(-1).token, { kind: 'neow', stage: 'red', choice: null })
    if (count === 1) room.run.players[0].relics.push({ defId: 'astrolabe', spent: false, pending: true })
    const pending = structuredClone(room.run.neow)
    markDisconnected(room, seats.at(-1).token)
    assertDeepEqual(room.run.neow, pending, 'disconnect auto-resolved a Neow choice')
    joinRoom(room, { token: seats.at(-1).token })
    if (count === 1) {
      assert(room.run.players[0].relics.some((relic) => relic.pending), 'disconnect auto-resolved a Neow Relic')
      const player = room.run.players[0]
      const eligible = player.deck.filter((card) => !card.upgraded && CARDS[card.defId]?.upgrade)
      apply(room, seats[0].token, { kind: 'resolvePendingRelic', cardUids: eligible.slice(0, 3).map((card) => card.uid), rewardIndices: [] })
    }
    assertDeepEqual(snapshotFor(room, seats.at(-1).token).run.neow.players[seats.at(-1).playerId],
      snapshotFor(room, seats[0].token).run.neow.players[seats.at(-1).playerId],
      'reconnect changed the public pending Neow state')
    finishNeow(room)
    assertEqual(room.run.phase, 'map', `${count}-player Neow did not finish`)
    assertEqual(room.run.neow, null)
  }
})

suite('seats')

check('a seat gets a distinct character by default', () => {
  const store = createStore()
  const room = createRoom(store, { code: 'AAAAAA' })
  const picked = Array.from({ length: MAX_SEATS }, () => joinRoom(room).character)
  assertEqual(new Set(picked).size, MAX_SEATS, 'auto-picked characters collided')
})

check('the same character cannot be taken twice', () => {
  const store = createStore()
  const room = createRoom(store, { code: 'AAAAAB' })
  joinRoom(room, { character: 'ironclad' })
  let threw = false
  try {
    joinRoom(room, { character: 'ironclad' })
  } catch {
    threw = true
  }
  assert(threw, 'two seats took the ironclad')
})

check('a name from the network is truncated, not stored whole', () => {
  // Player names come straight off the wire and are shown to everyone.
  const store = createStore()
  const room = createRoom(store, { code: 'AAAAAK' })
  const seat = joinRoom(room, { name: 'x'.repeat(500), character: 'ironclad' })
  assert(seat.name.length <= 24, `name should be capped, got ${seat.name.length} characters`)
  const again = joinRoom(room, { token: seat.token, name: 'y'.repeat(500) })
  assert(again.name.length <= 24, `renaming should be capped too, got ${again.name.length}`)
})

check('the box seats four, and a room code is six glyphs', () => {
  // Both were only ever compared against themselves, so either could drift
  // without a single check noticing.
  assertEqual(MAX_SEATS, 4, 'the box supports four players')
  assertEqual(roomCode().length, 6, 'a room code is six glyphs')
})

check('a fifth seat is refused', () => {
  const store = createStore()
  const room = createRoom(store, { code: 'AAAAAC' })
  for (let i = 0; i < MAX_SEATS; i++) joinRoom(room)
  let threw = false
  try {
    joinRoom(room)
  } catch {
    threw = true
  }
  assert(threw, `a ${MAX_SEATS + 1}th seat was allowed`)
})

check('rejoining with a token returns the SAME seat, not a new one', () => {
  const { room, a } = twoSeatRoom()
  markDisconnected(room, a.token)
  const again = joinRoom(room, { token: a.token })
  assertEqual(again.playerId, a.playerId, 'reconnect landed on a different seat')
  assertEqual(room.seats.length, 2, 'reconnect created an extra seat')
  assert(again.connected, 'reconnect left the seat marked disconnected')
})

check('reconnect works after the run has started', () => {
  // The whole point: a dropped player must return to the seat holding their
  // deck and HP. A lobby-only reconnect would be useless.
  const { room, a } = twoSeatRoom()
  markDisconnected(room, a.token)
  assertEqual(room.phase, 'run', 'precondition: run should be underway')
  const again = joinRoom(room, { token: a.token })
  assertEqual(again.playerId, a.playerId, 'mid-run reconnect failed')
})

check('a disconnected owner cannot strand a three-player run on a private Relic choice', () => {
  const store = createStore()
  const room = createRoom(store, { code: 'REL3AA' })
  const a = joinRoom(room, { name: 'Ann', character: 'ironclad' })
  const b = joinRoom(room, { name: 'Bo', character: 'silent' })
  joinRoom(room, { name: 'Cy', character: 'defect' })
  startRun(room, a.token, { seed: 31 })
  finishNeow(room)
  const owner = room.run.players.find((player) => player.id === a.playerId)
  const chosen = owner.deck.filter((card) => !card.upgraded).slice(0, 3)
  owner.relics.push({ defId: 'astrolabe', spent: false, pending: true })
  for (const card of chosen) {
    assert(!allStrings(snapshotFor(room, b.token)).includes(card.uid), 'a private deck choice leaked before disconnect')
  }

  markDisconnected(room, a.token)

  const settled = room.run.players.find((player) => player.id === a.playerId)
  assert(!settled.relics.some((relic) => relic.pending), 'the pending Astrolabe still blocks the map')
  assert(chosen.every((card) => settled.deck.find((held) => held.uid === card.uid)?.upgraded),
    'the server did not choose the stable first three legal cards')
  for (const card of chosen) {
    assert(!allStrings(snapshotFor(room, b.token)).includes(card.uid), 'a private disconnect choice leaked to a teammate')
  }
  joinRoom(room, { token: a.token })
  assert(chosen.every((card) => snapshotFor(room, a.token).run.players
    .find((player) => player.id === a.playerId).deck.find((held) => held.uid === card.uid)?.upgraded),
  'the settled choice did not survive reconnect')
})

check('four-player disconnect settlement keeps private Relic rewards owner-only', () => {
  const store = createStore()
  const room = createRoom(store, { code: 'REL4AA' })
  const a = joinRoom(room, { name: 'Ann', character: 'ironclad' })
  const b = joinRoom(room, { name: 'Bo', character: 'silent' })
  joinRoom(room, { name: 'Cy', character: 'defect' })
  joinRoom(room, { name: 'Dee', character: 'watcher' })
  startRun(room, a.token, { seed: 41 })
  finishNeow(room)
  const owner = room.run.players.find((player) => player.id === a.playerId)
  const selected = owner.rareRewards[0]
  owner.relics.push({ defId: 'enchiridion', spent: false, pending: true })
  assert(!allStrings(snapshotFor(room, b.token)).includes(selected), 'a private rare reward leaked before disconnect')

  markDisconnected(room, a.token)

  const settled = room.run.players.find((player) => player.id === a.playerId)
  assert(settled.deck.some((card) => card.defId === selected), 'the stable first rare reward was not gained')
  assert(!settled.relics.some((relic) => relic.pending), 'Enchiridion remained pending')
  assert(!allStrings(snapshotFor(room, b.token)).includes(selected), 'the gained private reward leaked to another seat')
  joinRoom(room, { token: a.token })
  assert(snapshotFor(room, a.token).run.players.find((player) => player.id === a.playerId).deck
    .some((card) => card.defId === selected), 'the owner lost the selected rare reward on reconnect')
})

check('Ascension 13 between-boss row choices and reserved boss survive reconnect', () => {
  const { room, a, b } = twoSeatRoom()
  room.run = {
    ...room.run,
    ascension: 13,
    act: 3,
    phase: 'betweenCombat',
    combat: null,
    pendingBossDefId: 'time_eater',
  }
  const moved = apply(room, a.token, { kind: 'switchBetweenCombatRow', row: 1 })
  assert(moved.changed, 'the owner could not choose a row')
  assertEqual(room.run.players.find((player) => player.id === a.playerId).row, 1)
  assertEqual(room.run.players.find((player) => player.id === b.playerId).row, 0,
    'occupied rows swap rather than duplicating seats')
  markDisconnected(room, a.token)
  joinRoom(room, { token: a.token })
  const restored = snapshotFor(room, a.token)
  assertEqual(restored.run.phase, 'betweenCombat')
  assertEqual(restored.run.pendingBossDefId, null, 'the reserved face-down boss leaked')
  apply(room, b.token, { kind: 'startPendingBoss' })
  assertEqual(room.run.phase, 'combat')
  assert(room.run.combat.enemies.some((enemy) => enemy.defId === 'time_eater'),
    'the server did not start the reserved distinct boss')
})

check('ordinary between-combat row choices survive reconnect', () => {
  const { room, a, b } = twoSeatRoom()
  room.run = { ...room.run, phase: 'map', combat: null }
  const moved = apply(room, a.token, { kind: 'switchBetweenCombatRow', row: 1 })
  assert(moved.changed, 'the map rejected a legal between-combat row switch')
  assertEqual(room.run.players.find((player) => player.id === b.playerId).row, 0)
  markDisconnected(room, a.token)
  joinRoom(room, { token: a.token })
  assertEqual(snapshotFor(room, a.token).run.players.find((player) => player.id === a.playerId).row, 1)
})

check('Event-room row choices survive reconnect before combat', () => {
  const { room, a, b } = twoSeatRoom()
  room.run = { ...room.run, phase: 'room', combat: null }
  const moved = apply(room, a.token, { kind: 'switchBetweenCombatRow', row: 1 })
  assert(moved.changed, 'the Event room rejected a legal between-combat row switch')
  assertEqual(room.run.players.find((player) => player.id === b.playerId).row, 0)
  markDisconnected(room, a.token)
  joinRoom(room, { token: a.token })
  assertEqual(snapshotFor(room, a.token).run.players.find((player) => player.id === a.playerId).row, 1)
})

check('another seat cannot bypass a pending Relic to start a boss or Act', () => {
  const { room, a, b } = twoSeatRoom()
  room.run.phase = 'betweenCombat'
  room.run.combat = null
  room.run.pendingBossDefId = 'time_eater'
  room.run.players.find((player) => player.id === a.playerId).relics.push({
    defId: 'orrery', spent: false, pending: true,
  })
  let blocked = null
  try { apply(room, b.token, { kind: 'startPendingBoss' }) } catch (error) { blocked = error }
  assertEqual(blocked?.name, 'RoomError')
  room.run.phase = 'victory'
  const bossId = room.run.map.rows.at(-1)[0]
  room.run.map.position = bossId
  room.run.map.rooms[bossId] = { ...room.run.map.rooms[bossId], visited: true }
  blocked = null
  try { apply(room, b.token, { kind: 'advanceAct' }) } catch (error) { blocked = error }
  assertEqual(blocked?.name, 'RoomError')
  assertEqual(room.run.act, 1)
})

check('starting a run always honors the lobby Ascension selection', () => {
  const store = createStore()
  const room = createRoom(store, { code: 'ASCEND' })
  const seat = joinRoom(room, { name: 'Ann', character: 'ironclad' })
  room.campaignProgress.highestAscension = 13
  chooseAscension(room, seat.token, 13)
  startRun(room, seat.token, { seed: 906, ascension: 0 })
  assertEqual(room.run.ascension, 13)
})

check('a stranger cannot join a started run', () => {
  const { room } = twoSeatRoom()
  let threw = false
  try {
    joinRoom(room, { name: 'Late' })
  } catch {
    threw = true
  }
  assert(threw, 'a new player walked into a run in progress')
})

check('two seats cannot swap onto the same character', () => {
  // The duplicate guard was only ever exercised through joinRoom.
  const store = createStore()
  const room = createRoom(store, { code: 'AAAAAL' })
  const a = joinRoom(room, { character: 'ironclad' })
  joinRoom(room, { character: 'silent' })
  let threw = false
  try {
    chooseCharacter(room, a.token, 'silent')
  } catch {
    threw = true
  }
  assert(threw, 'a seat took a character another seat already holds')
  assertEqual(room.seats[0].character, 'ironclad', 'and keeps its own')
  // Choosing a free character still works.
  chooseCharacter(room, a.token, 'defect')
  assertEqual(room.seats[0].character, 'defect', 'a free character can be taken')
})

check('a run cannot be started twice', () => {
  // Otherwise any seated player rerolls the whole run mid-game.
  const { room, a } = twoSeatRoom()
  const before = room.run
  let threw = false
  try {
    startRun(room, a.token, { seed: 999 })
  } catch {
    threw = true
  }
  assert(threw, 'the run was restarted from under everyone')
  assert(room.run === before, 'and the run in progress is untouched')
})

check('the version a client receives tracks the room', () => {
  const { room, a } = twoSeatRoom()
  const seen = snapshotFor(room, a.token).version
  assertEqual(seen, room.version, 'the snapshot should carry the real version')
  apply(room, a.token, { kind: 'endTurn' })
  assert(
    snapshotFor(room, a.token).version > seen,
    'and it should advance when the room does, or clients cannot drop stale frames',
  )
})

check('online seats choose only their own revealed card reward', () => {
  const { room, a, b } = twoSeatRoom()
  room.run.combat.phase = 'won'
  room.run.combat.enemies = room.run.combat.enemies.map((enemy) => ({
    ...enemy, hp: 0, dead: true, cardReward: 'normal', potionReward: false,
  }))
  apply(room, a.token, { kind: 'resolveCombat' })
  assertEqual(room.run.phase, 'reward')
  const beforeA = room.run.players.find((player) => player.id === a.playerId).deck.length
  const revealed = apply(room, a.token, { kind: 'cardReward', choice: 'reveal' })
  assertEqual(revealed.snapshot.run.rewards.find((offer) => offer.playerId === a.playerId).choices.length, 3)
  const first = apply(room, a.token, { kind: 'cardReward', choice: 0 })
  assertEqual(room.run.phase, 'reward', 'one seat cannot drag the other past its reward')
  assertDeepEqual(first.waitingOn, [b.playerId])
  assertDeepEqual(first.snapshot.rewardDecided, [a.playerId], 'only completion, not the choice, is public')
  assertEqual(first.snapshot.rewardChoice, 0, 'the deciding seat can inspect its own selected card')
  assertEqual(snapshotFor(room, b.token).rewardChoice, undefined, 'another seat cannot inspect the selection')
  const skipped = apply(room, b.token, { kind: 'cardReward', choice: null })
  assertEqual(skipped.snapshot.rewardChoice, null, 'a private skip is preserved distinctly from no decision')
  assertEqual(room.run.phase, 'reward', 'all choices remain revisable until the table confirms')
  apply(room, a.token, { kind: 'cardReward', choice: 'confirm' })
  assertEqual(room.run.phase, 'reward', 'one confirmation cannot finalize the table')
  apply(room, b.token, { kind: 'cardReward', choice: 'reveal' })
  apply(room, b.token, { kind: 'cardReward', choice: 'confirm' })
  assertEqual(room.run.phase, 'reward', 'revealing new information invalidates every earlier confirmation')
  apply(room, a.token, { kind: 'cardReward', choice: 'confirm' })
  assertEqual(room.run.phase, 'map', 'the unchanged choices settle only after everyone reconfirms')
  assertEqual(
    room.run.players.find((player) => player.id === a.playerId).deck.length,
    beforeA + 1,
    'the chosen card persists in that seat\'s deck',
  )
})

check('a reward confirmation is per seat, and toggles', () => {
  const { room, a, b } = twoSeatRoom()
  room.run.combat.phase = 'won'
  room.run.combat.enemies = room.run.combat.enemies.map((enemy) => ({
    ...enemy, hp: 0, dead: true, cardReward: 'normal', potionReward: false,
  }))
  apply(room, a.token, { kind: 'resolveCombat' })
  apply(room, a.token, { kind: 'cardReward', choice: 'reveal' })
  apply(room, b.token, { kind: 'cardReward', choice: 'reveal' })

  // Confirming before the whole table has chosen: the counter is worthless if a
  // seat that is done cannot say so until everyone else is done too.
  assertThrows(() => apply(room, a.token, { kind: 'cardReward', choice: 'confirm' }),
    'a seat with no choice of its own cannot confirm')
  apply(room, a.token, { kind: 'cardReward', choice: 0 })
  apply(room, a.token, { kind: 'cardReward', choice: 'confirm' })
  assertDeepEqual(snapshotFor(room, a.token).rewardConfirmed, [a.playerId])

  // Repeating it is a no-op, not a flip: a resend after a timeout the server had
  // already applied would otherwise leave the seat unconfirmed and the table
  // waiting on a player whose screen said they were done.
  apply(room, a.token, { kind: 'cardReward', choice: 'confirm' })
  assertDeepEqual(snapshotFor(room, a.token).rewardConfirmed, [a.playerId], 'confirming twice unconfirmed the seat')

  // Taking it back is its own action, so one button can drive both safely.
  apply(room, a.token, { kind: 'cardReward', choice: 'unconfirm' })
  assertDeepEqual(snapshotFor(room, a.token).rewardConfirmed, [])
  apply(room, a.token, { kind: 'cardReward', choice: 'unconfirm' })
  assertDeepEqual(snapshotFor(room, a.token).rewardConfirmed, [], 'unconfirming twice re-confirmed the seat')
  apply(room, a.token, { kind: 'cardReward', choice: 'confirm' })

  // The seat that reconsiders is the only one whose confirmation reopens.
  apply(room, b.token, { kind: 'cardReward', choice: 1 })
  apply(room, b.token, { kind: 'cardReward', choice: 'confirm' })
  assertEqual(room.run.phase, 'map', 'both seats confirmed, so the rewards settled')
  assertDeepEqual(snapshotFor(room, a.token).rewardConfirmed, [], 'and the ledger is cleared behind them')
})

check('one seat changing its card leaves every other confirmation standing', () => {
  const { room, a, b } = twoSeatRoom()
  room.run.combat.phase = 'won'
  room.run.combat.enemies = room.run.combat.enemies.map((enemy) => ({
    ...enemy, hp: 0, dead: true, cardReward: 'normal', potionReward: false,
  }))
  apply(room, a.token, { kind: 'resolveCombat' })
  apply(room, a.token, { kind: 'cardReward', choice: 'reveal' })
  apply(room, b.token, { kind: 'cardReward', choice: 'reveal' })
  apply(room, a.token, { kind: 'cardReward', choice: 0 })
  apply(room, a.token, { kind: 'cardReward', choice: 'confirm' })
  apply(room, b.token, { kind: 'cardReward', choice: 0 })
  // b reconsiders before confirming. a is untouched by that.
  apply(room, b.token, { kind: 'cardReward', choice: 1 })
  assertDeepEqual(snapshotFor(room, a.token).rewardConfirmed, [a.playerId],
    'a teammate\'s new card is not information any other seat\'s choice rests on')
  assertEqual(room.run.phase, 'reward', 'and the table has still not settled')
  apply(room, b.token, { kind: 'cardReward', choice: 'confirm' })
  assertEqual(room.run.phase, 'map')
})

check('Potion rewards are server-authored, reconnect-safe, and seat-owned', () => {
  const { room, a, b } = twoSeatRoom()
  room.run.combat.phase = 'won'
  room.run.combat.enemies = room.run.combat.enemies.map((enemy) => ({
    ...enemy, hp: 0, dead: true, cardReward: null, potionReward: true,
  }))
  apply(room, a.token, { kind: 'resolveCombat' })
  const hidden = snapshotFor(room, a.token)
  assertEqual(hidden.run.rewards.find((offer) => offer.playerId === a.playerId).potion, null)
  const revealed = apply(room, a.token, { kind: 'potionReward', choice: 'reveal' })
    .snapshot.run.rewards.find((offer) => offer.playerId === a.playerId).potion
  assert(typeof revealed === 'string', 'the server did not reveal the physical top Potion')
  let forged = null
  try {
    apply(room, b.token, { kind: 'potionReward', choice: 'gain' })
  } catch (error) {
    forged = error
  }
  assert(forged, 'another seat settled the owner\'s Potion offer')
  markDisconnected(room, a.token)
  joinRoom(room, { token: a.token })
  assertEqual(snapshotFor(room, a.token).run.rewards.find((offer) => offer.playerId === a.playerId).potion, false,
    'a disconnected owner kept the party waiting on a Potion')
  assertEqual(room.run.potionDeck.at(-1), revealed, 'the abandoned face-up Potion did not return to the bottom')
})

check('disconnected seats settle every reward stage without leaking queued Potions', () => {
  const { room, a, b } = twoSeatRoom()
  room.run.phase = 'reward'
  room.run.combat = null
  room.run.rewardDestination = 'map'
  room.run.rewards = [{
    playerId: b.playerId,
    cardReward: true,
    choices: null,
    upgraded: false,
    potion: null,
    potionQueue: ['fire_potion'],
    relic: null,
    bossRelics: ['coffee_dripper'],
  }]
  assertDeepEqual(snapshotFor(room, a.token).run.rewards[0].potionQueue, [null],
    'a queued Potion identity leaked before becoming the active offer')
  markDisconnected(room, b.token)
  assertEqual(room.run.phase, 'map', 'a disconnected reward owner stranded the run')
  assertEqual(room.run.rewards.length, 0)
  joinRoom(room, { token: b.token })
  assertEqual(snapshotFor(room, b.token).run.phase, 'map', 'reconnect restored settled rewards')
})

check('a disconnected Tiny House owner settles its generated Potion after the Relic choice', () => {
  const { room, a, b } = twoSeatRoom()
  room.run.phase = 'reward'
  room.run.combat = null
  room.run.rewardDestination = 'map'
  room.run.rewards = [{
    playerId: a.playerId,
    cardReward: true,
    choices: null,
    upgraded: false,
    potion: false,
    relic: 'tiny_house',
    bossRelics: false,
  }]
  apply(room, a.token, { kind: 'relicReward', choice: 'gain' })
  assert(room.run.players.find((player) => player.id === a.playerId).relics
    .some((relic) => relic.defId === 'tiny_house' && relic.pending))
  assert(typeof room.run.rewards[0].potion === 'string', 'Tiny House did not reserve its Potion')

  markDisconnected(room, a.token)
  assertEqual(room.seats.find((seat) => seat.playerId === b.playerId).connected, true)
  assertEqual(room.run.phase, 'map', 'the connected teammate stayed blocked on Tiny House')
  assertEqual(room.run.rewards.length, 0)
  assert(!room.run.players.find((player) => player.id === a.playerId).relics.some((relic) => relic.pending))
})

check('a seat disconnected before victory cannot block later reward confirmation', () => {
  const { room, a, b } = twoSeatRoom()
  markDisconnected(room, b.token)
  room.run.combat.phase = 'won'
  room.run.combat.enemies = room.run.combat.enemies.map((enemy) => ({
    ...enemy, hp: 0, dead: true, cardReward: 'normal', potionReward: false,
  }))
  apply(room, a.token, { kind: 'resolveCombat' })
  apply(room, a.token, { kind: 'cardReward', choice: null })
  apply(room, a.token, { kind: 'cardReward', choice: 'confirm' })
  assertEqual(room.run.phase, 'map', 'the connected seat remained blocked on the disconnected reward')
})

check('Full Knowledge shares every revealed reward before final choices', () => {
  const { room, a, b } = twoSeatRoom()
  room.run.combat.phase = 'won'
  room.run.combat.enemies = room.run.combat.enemies.map((enemy) => ({
    ...enemy,
    hp: 0,
    dead: true,
    cardReward: 'normal',
    potionReward: false,
  }))
  apply(room, a.token, { kind: 'resolveCombat' })
  apply(room, a.token, { kind: 'cardReward', choice: 'reveal' })

  const mine = snapshotFor(room, a.token).run.rewards
    .find((offer) => offer.playerId === a.playerId)
  const theirs = snapshotFor(room, b.token).run.rewards
    .find((offer) => offer.playerId === a.playerId)
  assertEqual(mine.choices.length, 3, 'the owner can see the cards they revealed')
  assertDeepEqual(theirs.choices, mine.choices, 'Full Knowledge shares the revealed reward with every seat')
  assertEqual(room.run.rewards.find((offer) => offer.playerId === a.playerId).choices.length, 3)
})

check('Golden Ticket reveals are server-authored, reconnect-safe, and do not leak future stacks', () => {
  const { room, a, b } = twoSeatRoom()
  room.run.combat.phase = 'won'
  room.run.combat.enemies = room.run.combat.enemies.map((enemy) => ({ ...enemy, cardReward: 'normal', potionReward: false }))
  const owner = room.run.players.find((player) => player.id === a.playerId)
  owner.cardRewards = ['shrug_it_off', GOLDEN_TICKET, 'pommel_strike', 'cleave']
  owner.rareRewards = ['feed', 'limit_break']
  apply(room, a.token, { kind: 'resolveCombat' })
  const hidden = snapshotFor(room, b.token)
  assert(!allStrings(hidden).includes('feed'), 'a future rare leaked before the Ticket reveal')

  apply(room, a.token, { kind: 'cardReward', choice: 'reveal' })
  const revealed = snapshotFor(room, b.token).run.rewards.find((offer) => offer.playerId === a.playerId)
  assertDeepEqual(revealed.choices, ['shrug_it_off', 'pommel_strike', 'feed'])
  assertDeepEqual(revealed.rareChoiceIndices, [2])
  markDisconnected(room, a.token)
  joinRoom(room, { token: a.token })
  const rejoined = snapshotFor(room, a.token)
  assertDeepEqual(rejoined.run.rewards.find((offer) => offer.playerId === a.playerId), revealed,
    'reconnect restores the exact revealed mixed-stack offer')
  assert(!allStrings(rejoined).includes('limit_break'), 'the next rare stack card leaked after reconnect')
})

check('pending Relic acquisition blocks every later reward action', () => {
  const { room, a } = twoSeatRoom()
  room.run.phase = 'reward'
  room.run.combat = null
  room.run.rewardDestination = 'map'
  room.run.rewards = [{
    playerId: a.playerId,
    cardReward: true,
    choices: null,
    upgraded: false,
    potion: false,
    relic: 'war_paint',
    bossRelics: false,
  }]
  const owner = room.run.players.find((player) => player.id === a.playerId)
  owner.deck.push({ uid: 'reward-order-skill', defId: 'shrug_it_off', upgraded: false })
  const deckBefore = owner.deck.map((card) => card.uid)

  apply(room, a.token, { kind: 'relicReward', choice: 'gain' })
  const pendingOwner = room.run.players.find((player) => player.id === a.playerId)
  assert(pendingOwner.relics.some((relic) => relic.defId === 'war_paint' && relic.pending))
  let refused = null
  try {
    apply(room, a.token, { kind: 'cardReward', choice: 'reveal' })
  } catch (error) {
    refused = error
  }
  assertEqual(refused?.name, 'RoomError', 'a card reward bypassed the pending Relic choice')
  assertEqual(room.run.rewards[0].choices, null)
  assertDeepEqual(pendingOwner.deck.map((card) => card.uid), deckBefore)

  const target = pendingOwner.deck.find((card) => CARDS[card.defId]?.type === 'skill' &&
    !card.upgraded && !card.defId.startsWith('defend_'))
  apply(room, a.token, { kind: 'resolvePendingRelic', cardUids: target ? [target.uid] : [] })
  apply(room, a.token, { kind: 'cardReward', choice: 'reveal' })
  assertEqual(room.run.rewards[0].choices.length, 3)
})

check('revising a reward choice invalidates every earlier confirmation', () => {
  const { room, a, b } = twoSeatRoom()
  room.run.combat.phase = 'won'
  room.run.combat.enemies = room.run.combat.enemies.map((enemy) => ({ ...enemy, cardReward: 'normal', potionReward: false }))
  apply(room, a.token, { kind: 'resolveCombat' })
  apply(room, a.token, { kind: 'cardReward', choice: null })
  apply(room, b.token, { kind: 'cardReward', choice: null })
  apply(room, a.token, { kind: 'cardReward', choice: 'confirm' })
  apply(room, b.token, { kind: 'cardReward', choice: 'reveal' })
  apply(room, b.token, { kind: 'cardReward', choice: 0 })
  apply(room, b.token, { kind: 'cardReward', choice: 'confirm' })
  assertEqual(room.run.phase, 'reward', 'a revised choice invalidates every earlier confirmation')
  apply(room, a.token, { kind: 'cardReward', choice: 'confirm' })
  assertEqual(room.run.phase, 'map')
})

check('online reward messages reject unrevealed choices', () => {
  const { room, a } = twoSeatRoom()
  room.run.combat.phase = 'won'
  apply(room, a.token, { kind: 'resolveCombat' })
  let error = null
  try {
    apply(room, a.token, { kind: 'cardReward', choice: 99 })
  } catch (thrown) {
    error = thrown
  }
  assert(error, 'an out-of-range reward choice was accepted')
  assertEqual(error.name, 'RoomError')
})

check('disconnected permanent rewards settle deterministically when a seat returns', () => {
  const { room, a, b } = twoSeatRoom()
  room.run.combat.phase = 'won'
  room.run.combat.enemies = room.run.combat.enemies.map((enemy) => ({ ...enemy, cardReward: 'normal', potionReward: false }))
  apply(room, a.token, { kind: 'resolveCombat' })
  apply(room, a.token, { kind: 'cardReward', choice: 'reveal' })
  apply(room, a.token, { kind: 'cardReward', choice: 0 })
  assertEqual(snapshotFor(room, a.token).rewardChoice, 0, 'the deciding seat can inspect its pick')
  assertEqual(
    snapshotFor(room, b.token).rewardChoice,
    undefined,
    'another seat cannot inspect the private choice',
  )
  markDisconnected(room, a.token)
  markDisconnected(room, b.token)
  assertEqual(room.run.phase, 'reward', 'an empty room need not advance until someone returns')
  joinRoom(room, { token: a.token })
  assertEqual(room.run.phase, 'map', 'returning one seat remained blocked on abandoned rewards')
  joinRoom(room, { token: b.token })
  assertEqual(room.run.phase, 'map', 'reconnect restored an already settled reward')
})

check('a seat cannot confirm rewards before everyone has decided', () => {
  const { room, a } = twoSeatRoom()
  room.run.combat.phase = 'won'
  apply(room, a.token, { kind: 'resolveCombat' })
  let error = null
  try {
    apply(room, a.token, { kind: 'cardReward', choice: 'confirm' })
  } catch (thrown) {
    error = thrown
  }
  assert(error, 'an early confirmation was accepted')
})

check('a seat can spend only its own Miracle during the Player Turn', () => {
  const { room, a, b } = twoSeatRoom()
  const mine = room.run.combat.players.find((player) => player.id === a.playerId)
  const theirs = room.run.combat.players.find((player) => player.id === b.playerId)
  mine.miracles = 1
  mine.energy = 2
  const theirEnergy = theirs.energy
  apply(room, a.token, { kind: 'spendMiracle' })
  const afterMine = room.run.combat.players.find((player) => player.id === a.playerId)
  const afterTheirs = room.run.combat.players.find((player) => player.id === b.playerId)
  assertEqual(afterMine.miracles, 0, 'the token is spent')
  assertEqual(afterMine.energy, 3, 'the owner gains the Energy')
  assertEqual(afterTheirs.energy, theirEnergy, 'another seat was changed')
})

check('online seats can spend capped Miracles and their own Shivs atomically', () => {
  const { room, a, b } = twoSeatRoom()
  const mine = () => room.run.combat.players.find((player) => player.id === a.playerId)
  const theirs = () => room.run.combat.players.find((player) => player.id === b.playerId)
  const enemy = () => room.run.combat.enemies[0]
  const card = { uid: 'fx-miracle-card', defId: 'strike_ironclad', upgraded: false }
  Object.assign(enemy(), { hp: 10, maxHp: 10, block: 0, dead: false, abilityUsed: true })
  mine().hand.push(card)
  mine().miracles = 1
  mine().energy = 6
  apply(room, a.token, {
    kind: 'playCard',
    cardUid: card.uid,
    enemyUid: enemy().uid,
    spendMiracle: true,
  })
  assertEqual(mine().miracles, 0, 'the capped Miracle is spent with the card')
  assertEqual(mine().energy, 6, 'a one-cost card immediately consumes the over-cap Energy')

  mine().shivs = 1
  const theirShivs = theirs().shivs
  const hp = enemy().hp
  apply(room, a.token, { kind: 'spendShiv', enemyUid: enemy().uid })
  assertEqual(mine().shivs, 0, 'the acting seat spends its Shiv')
  assertEqual(theirs().shivs, theirShivs, 'the other seat cannot be charged')
  assertEqual(enemy().hp, hp - 1, 'the Shiv attacks the chosen enemy')
})

check('an online seat can use only its own potion with a valid target', () => {
  const { room, a, b } = twoSeatRoom()
  const mine = () => room.run.combat.players.find((player) => player.id === a.playerId)
  const theirs = () => room.run.combat.players.find((player) => player.id === b.playerId)
  const enemy = () => room.run.combat.enemies[0]
  mine().potions = ['fire_potion']
  theirs().potions = ['block_potion']
  for (const target of room.run.combat.enemies) {
    Object.assign(target, { block: 0, abilityUsed: true })
  }
  Object.assign(enemy(), { hp: 10, maxHp: 10, dead: false })

  const untargeted = apply(room, a.token, { kind: 'usePotion', potionId: 'fire_potion' })
  assertEqual(untargeted.changed, false, 'a targeted potion was wasted without a target')
  assertDeepEqual(mine().potions, ['fire_potion'])
  let previewedPotion = null
  try {
    apply(room, a.token, {
      kind: 'usePotion',
      potionId: 'fire_potion',
      enemyUid: 'no-longer-alive',
      preflight: true,
    })
  } catch (error) {
    previewedPotion = error
  }
  assertEqual(previewedPotion?.name, 'RoomError', 'a previewed stale potion gets an actionable refusal')
  assertDeepEqual(mine().potions, ['fire_potion'])

  let forged = null
  try {
    apply(room, b.token, { kind: 'usePotion', potionId: 'fire_potion', enemyUid: enemy().uid })
  } catch (error) {
    forged = error
  }
  assert(forged, 'one seat used another player\'s potion')
  assertDeepEqual(room.run.combat.presentationEvents, [], 'refused potion actions published animations')

  const hp = enemy().hp
  const before = room.version
  const used = apply(room, a.token, { kind: 'usePotion', potionId: 'fire_potion', enemyUid: enemy().uid })
  assert(used.changed)
  assertEqual(enemy().hp, hp - 4)
  assertEqual(mine().potions.length, 0)
  assertDeepEqual(theirs().potions, ['block_potion'])
  assert(room.version > before, 'using a potion did not publish the new board')
  assertDeepEqual(snapshotFor(room, b.token).run.combat.presentationEvents.at(-1), {
    seq: 1,
    kind: 'potion',
    actorId: a.playerId,
    sourceId: 'fire_potion',
    enemyIds: [enemy().uid],
    playerIds: [],
  }, 'the other seat did not receive the public potion animation')
  room.run.combat.presentationEvents.at(-1).privateChoiceUid = mine().hand[0]?.uid ?? 'private-choice'
  assertEqual(snapshotFor(room, b.token).run.combat.presentationEvents.at(-1).privateChoiceUid, undefined,
    'room redaction forwarded an unapproved presentation-event field')

  mine().potions = ['energy_potion']
  const surplusTargetPotion = apply(room, a.token, {
    kind: 'usePotion', potionId: 'energy_potion', enemyUid: enemy().uid, targetPlayerId: a.playerId,
  })
  assert(surplusTargetPotion.changed)
  assertDeepEqual(snapshotFor(room, b.token).run.combat.presentationEvents.at(-1).enemyIds, [],
    'a surplus hostile Potion target published a false peer impact')

  const block = theirs().block
  const helped = apply(room, b.token, {
    kind: 'usePotion',
    potionId: 'block_potion',
    targetPlayerId: mine().id,
  })
  assert(helped.changed)
  assertEqual(mine().block, 2, 'Block Potion can target another online seat')
  assertEqual(theirs().block, block)

  const privateCard = mine().hand[0]
  assert(privateCard, 'the potion privacy fixture needs a card in hand')
  mine().potions = ['purity_potion']
  apply(room, a.token, {
    kind: 'usePotion',
    potionId: 'purity_potion',
    exhaustUids: [privateCard.uid],
  })
  const publicPurityEvent = snapshotFor(room, b.token).run.combat.presentationEvents.at(-1)
  assertEqual(publicPurityEvent.sourceId, 'purity_potion')
  assert(!allStrings(publicPurityEvent).includes(privateCard.uid),
    'a public presentation event leaked an opponent hand UID')

  mine().potions = ['cunning_potion']
  mine().shivs = 4
  theirs().shivs = 1
  const overflowTarget = room.run.combat.enemies.find((candidate) => !candidate.dead && candidate.hp >= 4)
  assert(overflowTarget, 'the online potion check needs a durable overflow target')
  const overflowHp = overflowTarget.hp
  for (const shivEnemyUids of [undefined, 'not-a-list']) {
    let malformedTargets = null
    try {
      apply(room, a.token, {
        kind: 'usePotion',
        potionId: 'cunning_potion',
        expectedShivOverflow: 3,
        ...(shivEnemyUids === undefined ? {} : { shivEnemyUids }),
      })
    } catch (error) {
      malformedTargets = error
    }
    assertEqual(malformedTargets?.name, 'RoomError', 'missing overflow targets stay inside the room boundary')
    assert(
      malformedTargets.message.includes('Choose every overflow Shiv target'),
      'missing overflow targets return the actionable room error',
    )
  }
  assertDeepEqual(mine().potions, ['cunning_potion'])
  const laterTarget = room.run.combat.enemies.find((candidate) => !candidate.dead && candidate.uid !== overflowTarget.uid)
  assert(laterTarget, 'the online sequential-target check needs two living enemies')
  overflowTarget.hp = 1
  let sequentialTarget = null
  try {
    apply(room, a.token, {
      kind: 'usePotion',
      potionId: 'cunning_potion',
      expectedShivOverflow: 3,
      shivEnemyUids: [overflowTarget.uid, overflowTarget.uid, laterTarget.uid],
    })
  } catch (error) {
    sequentialTarget = error
  }
  assertEqual(sequentialTarget?.name, 'RoomError')
  assert(
    sequentialTarget.message.includes('earlier overflow Shiv defeated a later target'),
    'a sequentially invalid target returns an actionable retry error',
  )
  assertEqual(overflowTarget.hp, 1, 'the refused target sequence stays atomic')
  assertDeepEqual(mine().potions, ['cunning_potion'])
  overflowTarget.hp = overflowHp
  let staleOverflow = null
  try {
    apply(room, a.token, {
      kind: 'usePotion',
      potionId: 'cunning_potion',
      expectedShivOverflow: 2,
      shivEnemyUids: [overflowTarget.uid, overflowTarget.uid],
    })
  } catch (error) {
    staleOverflow = error
  }
  assert(staleOverflow, 'a changed shared Shiv supply consumed Cunning Potion')
  assertDeepEqual(mine().potions, ['cunning_potion'])
  let staleTarget = null
  try {
    apply(room, a.token, {
      kind: 'usePotion',
      potionId: 'cunning_potion',
      expectedShivOverflow: 3,
      shivEnemyUids: ['dead-target', 'dead-target', 'dead-target'],
    })
  } catch (error) {
    staleTarget = error
  }
  assert(staleTarget, 'a dead overflow target consumed Cunning Potion')
  assertDeepEqual(mine().potions, ['cunning_potion'])
  const cunning = apply(room, a.token, {
    kind: 'usePotion',
    potionId: 'cunning_potion',
    expectedShivOverflow: 3,
    shivEnemyUids: [overflowTarget.uid, overflowTarget.uid, overflowTarget.uid],
  })
  assert(cunning.changed)
  const overflowAfter = room.run.combat.enemies.find((candidate) => candidate.uid === overflowTarget.uid)
  assertEqual(overflowAfter.hp, overflowHp - 3, 'online Cunning Potion keeps every overflow target')
  assertEqual(mine().potions.length, 0)

  mine().potions = ['cunning_potion']
  const skippedHp = overflowAfter.hp
  const skipped = apply(room, a.token, {
    kind: 'usePotion',
    potionId: 'cunning_potion',
    expectedShivOverflow: 3,
    skipOverflow: true,
    shivEnemyUids: [overflowAfter.uid],
  })
  assert(skipped.changed)
  const afterSkip = room.run.combat.enemies.find((candidate) => candidate.uid === overflowAfter.uid)
  assertEqual(afterSkip.hp, skippedHp - 1, 'explicit skip keeps the chosen overflow attacks')

  mine().potions = ['explosive_potion']
  const row = afterSkip.row
  const rowBefore = new Map(room.run.combat.enemies.map((candidate) => [candidate.uid, candidate.hp]))
  const malformedRow = apply(room, a.token, {
    kind: 'usePotion',
    potionId: 'explosive_potion',
    enemyRow: String(row),
  })
  assertEqual(malformedRow.changed, false, 'network row ids stay typed')
  assertDeepEqual(mine().potions, ['explosive_potion'])
  const exploded = apply(room, a.token, {
    kind: 'usePotion',
    potionId: 'explosive_potion',
    enemyRow: row,
  })
  assert(exploded.changed)
  for (const candidate of room.run.combat.enemies) {
    const beforeHp = rowBefore.get(candidate.uid)
    const hit = candidate.row === row || candidate.isBoss
    assertEqual(candidate.hp, hit ? Math.max(0, beforeHp - 2) : beforeHp)
  }
})

check('online seats ready together, then submit only their own post-trigger discard order', () => {
  const { room, a, b } = twoSeatRoom()
  const first = room.run.combat.players.find((player) => player.id === a.playerId)
  const second = room.run.combat.players.find((player) => player.id === b.playerId)
  wantsDiscardOrder(room, a.playerId, b.playerId)
  const firstOrder = first.hand.map((card) => card.uid).reverse()
  const waiting = apply(room, a.token, { kind: 'endTurn' })
  assertEqual(room.run.combat.phase, 'player', 'one ready seat cannot end the shared turn')
  assertDeepEqual(waiting.waitingOn, [b.playerId], 'the other living connected seat must answer')
  assertDeepEqual(waiting.snapshot.endTurnDecided, [a.playerId], 'only readiness, not hand order, is public')

  apply(room, b.token, { kind: 'endTurn' })
  assertEqual(room.run.combat.phase, 'discard', 'effects resolve before discard choices are collected')

  let forged = null
  try {
    apply(room, b.token, { kind: 'discardHand', discardOrder: firstOrder })
  } catch (error) {
    forged = error
  }
  assert(forged, 'a seat cannot submit another player\'s hand as its order')

  apply(room, a.token, { kind: 'discardHand', discardOrder: firstOrder })
  apply(room, b.token, { kind: 'discardHand', discardOrder: second.hand.map((card) => card.uid) })
  assertEqual(room.run.combat.phase, 'enemy', 'the turn ends once every connected seat is ready')
  assertDeepEqual(
    room.run.combat.players.find((player) => player.id === a.playerId).discard.map((card) => card.uid),
    firstOrder,
    'the authoritative room forwards the chosen order',
  )
})

check('online discard orders are validated after Ethereal leaves the hand', () => {
  const { room, a, b } = twoSeatRoom()
  const first = room.run.combat.players.find((player) => player.id === a.playerId)
  const second = room.run.combat.players.find((player) => player.id === b.playerId)
  first.hand = [
    { uid: 'online-clumsy', defId: 'clumsy', upgraded: false },
    { uid: 'online-strike', defId: 'strike_ironclad', upgraded: false },
    { uid: 'online-strike-2', defId: 'strike_ironclad', upgraded: false },
  ]
  wantsDiscardOrder(room, a.playerId, b.playerId)
  const staleOrder = first.hand.map((card) => card.uid)
  apply(room, a.token, { kind: 'endTurn' })
  apply(room, b.token, { kind: 'endTurn' })
  const preparedFirst = room.run.combat.players.find((player) => player.id === a.playerId)
  assertDeepEqual(preparedFirst.hand.map((card) => card.uid), ['online-strike', 'online-strike-2'],
    'the authoritative end-turn step exhausts Clumsy before asking for an order')

  let error = null
  try {
    apply(room, a.token, { kind: 'discardHand', discardOrder: staleOrder })
  } catch (thrown) {
    error = thrown
  }
  assertEqual(error?.name, 'RoomError', 'a pre-Ethereal hand order must be rejected')
  apply(room, a.token, { kind: 'discardHand', discardOrder: ['online-strike', 'online-strike-2'] })
  apply(room, b.token, { kind: 'discardHand', discardOrder: second.hand.map((card) => card.uid) })
  assertEqual(room.run.combat.phase, 'enemy')
})

check('online seats globally order abilities only after everyone ends the turn', () => {
  const { room, a, b } = twoSeatRoom()
  const first = room.run.combat.players.find((player) => player.id === a.playerId)
  const shame = { uid: 'room-shame', defId: 'shame', upgraded: false }
  const decay = { uid: 'room-decay', defId: 'decay', upgraded: false }
  first.hand = [shame, decay]
  first.block = 1
  first.hp = 5
  apply(room, a.token, { kind: 'endTurn' })
  assertEqual(snapshotFor(room, a.token).endTurnAbilities, undefined,
    'hand-derived abilities stay hidden while another player can still act')
  apply(room, b.token, { kind: 'endTurn' })
  assertEqual(room.run.combat.phase, 'player', 'the room pauses for a party-wide order')
  const ownerSnapshot = snapshotFor(room, a.token)
  const otherSnapshot = snapshotFor(room, b.token)
  const shameId = ownerSnapshot.endTurnAbilities.find((ability) => ability.label.includes('Shame')).id
  const decayId = ownerSnapshot.endTurnAbilities.find((ability) => ability.label.includes('Decay')).id
  const order = [decayId, shameId]
  assertDeepEqual(ownerSnapshot.endTurnOrder, [shameId, decayId])
  assertDeepEqual(otherSnapshot.endTurnOrder, ownerSnapshot.endTurnOrder,
    'every seat and reconnect sees the same stage-local ordering IDs')
  assertEqual(ownerSnapshot.endTurnCoordinatorId, a.playerId)
  assert(ownerSnapshot.endTurnAbilities.some((ability) => ability.label.includes('Shame')),
    'the owner can identify their own hand ability')
  assert(otherSnapshot.endTurnAbilities.every((ability) =>
    !ability.label.includes('Shame') && !ability.label.includes('Decay')),
    'another seat cannot identify private cards from the ordering stage')
  assert(!JSON.stringify(otherSnapshot).includes(shame.uid) && !JSON.stringify(otherSnapshot).includes(decay.uid),
    'opaque stage IDs never serialize another player\'s hidden card UID')
  let malformed = null
  try {
    apply(room, a.token, { kind: 'resolveEndTurn', abilityOrder: [order[0]] })
  } catch (error) {
    malformed = error
  }
  assertEqual(malformed?.name, 'RoomError', 'an incomplete network order is rejected')
  apply(room, a.token, { kind: 'resolveEndTurn', abilityOrder: order })
  const prepared = room.run.combat.players.find((player) => player.id === a.playerId)
  assertEqual(prepared.hp, 5, 'the authoritative room resolves Decay before Shame')
  assertEqual(prepared.block, 0)
})

check('the online coordinator can interleave a later seat\'s winning ability first', () => {
  const { room, a, b } = twoSeatRoom()
  const first = room.run.combat.players.find((player) => player.id === a.playerId)
  const second = room.run.combat.players.find((player) => player.id === b.playerId)
  first.hp = 1
  first.stance = 'wrath'
  second.orbs = ['lightning', null, null]
  const target = room.run.combat.enemies.find((enemy) => !enemy.dead)
  for (const enemy of room.run.combat.enemies) enemy.dead = enemy.uid !== target.uid
  target.hp = 1
  target.maxHp = 1
  apply(room, a.token, { kind: 'endTurn' })
  apply(room, b.token, { kind: 'endTurn' })
  const abilities = snapshotFor(room, a.token).endTurnAbilities
  const orbId = abilities.find((ability) => ability.label.includes('Lightning Orb')).id
  const wrathId = abilities.find((ability) => ability.label.includes('Wrath')).id
  let badTarget = null
  try {
    apply(room, a.token, {
      kind: 'resolveEndTurn',
      abilityOrder: [`${orbId}@not-an-enemy`, wrathId],
    })
  } catch (error) {
    badTarget = error
  }
  assertEqual(badTarget?.name, 'RoomError', 'a crafted Lightning target is rejected')
  let inheritedId = null
  try {
    apply(room, a.token, {
      kind: 'resolveEndTurn',
      abilityOrder: [`toString@${target.uid}`, wrathId],
    })
  } catch (error) {
    inheritedId = error
  }
  assertEqual(inheritedId?.name, 'RoomError', 'an inherited object key is not an opaque ability ID')
  apply(room, a.token, {
    kind: 'resolveEndTurn',
    abilityOrder: [`${orbId}@${target.uid}`, wrathId],
  })
  assertEqual(room.run.combat.phase, 'won')
  assertEqual(room.run.combat.players.find((player) => player.id === a.playerId).hp, 2,
    'Wrath is skipped, then Burning Blood heals 1 at end of combat')
})

check('one Lightning Orb still pauses online when its enemy target is a choice', () => {
  const { room, a, b } = twoSeatRoom()
  const second = room.run.combat.players.find((player) => player.id === b.playerId)
  for (const player of room.run.combat.players) player.hand = []
  second.orbs = ['lightning', null, null]
  const [firstEnemy, secondEnemy] = room.run.combat.enemies
  const secondHp = secondEnemy.hp
  apply(room, a.token, { kind: 'endTurn' })
  apply(room, b.token, { kind: 'endTurn' })
  assertEqual(room.run.combat.phase, 'player', 'the target picker must not auto-hit the first enemy')
  const orbId = snapshotFor(room, a.token).endTurnAbilities[0].id
  apply(room, a.token, {
    kind: 'resolveEndTurn',
    abilityOrder: [`${orbId}@${secondEnemy.uid}`],
  })
  assertEqual(firstEnemy.hp, room.run.combat.enemies[0].hp)
  assertEqual(room.run.combat.enemies[1].hp, secondHp - 1)
})

check('a stale end-turn order tells the coordinator how to recover', () => {
  const { room, a, b } = twoSeatRoom()
  const second = room.run.combat.players.find((player) => player.id === b.playerId)
  for (const player of room.run.combat.players) player.hand = []
  second.orbs = ['lightning', null, null]
  const [, secondEnemy] = room.run.combat.enemies
  apply(room, a.token, { kind: 'endTurn' })
  apply(room, b.token, { kind: 'endTurn' })
  const orbId = snapshotFor(room, a.token).endTurnAbilities[0].id
  // The chosen target dies after the party locked the order in.
  Object.assign(secondEnemy, { hp: 0, dead: true })
  let stale = null
  try {
    apply(room, a.token, { kind: 'resolveEndTurn', abilityOrder: [`${orbId}@${secondEnemy.uid}`] })
  } catch (error) {
    stale = error
  }
  assertEqual(stale?.message, REBUILT_END_TURN_ORDER,
    'the online rejection names the fix and where to make it')
  const republished = snapshotFor(room, a.token).endTurnAbilities
  assert(republished?.length > 0, 'the rejection dropped the ordering stage')
  assert(republished.every((ability) => !ability.targets?.some((target) => target.uid === secondEnemy.uid)),
    'the dead target survived the republished abilities')
  const freshOrb = republished[0]
  assert(freshOrb.id !== orbId, 'the republished list reused the superseded ability id')
  let superseded = null
  try {
    apply(room, a.token, { kind: 'resolveEndTurn', abilityOrder: [`${orbId}@${freshOrb.targets[0].uid}`] })
  } catch (error) {
    superseded = error
  }
  assertEqual(superseded?.message, 'End-turn order must contain each ability exactly once with valid targets',
    'an order held from before the republish still resolved')
  apply(room, a.token, {
    kind: 'resolveEndTurn',
    abilityOrder: [`${freshOrb.id}@${freshOrb.targets[0].uid}`],
  })
  assertEqual(room.run.combat.phase, 'enemy', 'the party could not recover from the stale order')
})

check('a refused plan keeps the party arrangement when the abilities are still live', () => {
  const { room, a, b } = twoSeatRoom()
  for (const player of room.run.combat.players) player.hand = []
  room.run.combat.players.find((player) => player.id === b.playerId).orbs = ['lightning', 'lightning', null]
  const [firstEnemy] = room.run.combat.enemies
  firstEnemy.hp = 1
  apply(room, a.token, { kind: 'endTurn' })
  apply(room, b.token, { kind: 'endTurn' })
  const published = snapshotFor(room, a.token)
  const versionBefore = room.version
  let refused = null
  try {
    // The first Orb kills the enemy the second one is aimed at: the plan is
    // stale, the published abilities are not.
    apply(room, a.token, {
      kind: 'resolveEndTurn',
      abilityOrder: published.endTurnAbilities.map((ability) => `${ability.id}@${firstEnemy.uid}`),
    })
  } catch (error) {
    refused = error
  }
  assertEqual(refused?.message, STALE_END_TURN_ORDER)
  assertEqual(room.version, versionBefore, 'a refusal the party can fix in place still bumped the room')
  assertDeepEqual(snapshotFor(room, a.token).endTurnAbilities, published.endTurnAbilities,
    'the party lost its arrangement to a refusal it could have fixed in place')
})

check('a stale end-turn order with nothing left to choose just resolves', () => {
  const { room, a, b } = twoSeatRoom()
  const second = room.run.combat.players.find((player) => player.id === b.playerId)
  for (const player of room.run.combat.players) player.hand = []
  second.orbs = ['lightning', null, null]
  const [firstEnemy, secondEnemy] = room.run.combat.enemies
  apply(room, a.token, { kind: 'endTurn' })
  apply(room, b.token, { kind: 'endTurn' })
  const orbId = snapshotFor(room, a.token).endTurnAbilities[0].id
  // Every target but one dies, so the republished Orb has no choice to offer.
  for (const enemy of room.run.combat.enemies) {
    if (enemy.uid !== firstEnemy.uid) Object.assign(enemy, { hp: 0, dead: true })
  }
  apply(room, a.token, { kind: 'resolveEndTurn', abilityOrder: [`${orbId}@${secondEnemy.uid}`] })
  assertEqual(room.run.combat.phase, 'enemy', 'the forced Orb did not end the turn')
})

check('Loop Orb choices are public, authoritative, and reject forged targets online', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const other = room.run.combat.players.find((player) => player.id === b.playerId)
  const loop = { uid: 'room-loop', defId: 'loop', upgraded: true }
  Object.assign(actor, { hand: [loop], energy: 1, orbs: ['lightning', 'frost', 'dark'] })
  other.hand = []
  const [firstEnemy, secondEnemy] = room.run.combat.enemies
  Object.assign(firstEnemy, { defId: 'cultist', block: 0 })
  Object.assign(secondEnemy, { defId: 'cultist', block: 0 })
  const firstHp = firstEnemy.hp
  const secondHp = secondEnemy.hp

  apply(room, a.token, { kind: 'playCard', cardUid: loop.uid, preflight: true })
  apply(room, a.token, { kind: 'endTurn' })
  apply(room, b.token, { kind: 'endTurn' })
  const mine = snapshotFor(room, a.token)
  const theirs = snapshotFor(room, b.token)
  const ability = mine.endTurnAbilities.find((entry) => entry.label.includes('Loop'))
  assertDeepEqual(theirs.endTurnAbilities.find((entry) => entry.id === ability.id), ability,
    'face-up Loop choices should be identical for every seat')
  const target = ability.targets.find((choice) => choice.uid.endsWith(secondEnemy.uid))
  const order = mine.endTurnOrder.map((choice) => choice.startsWith(`${ability.id}@`)
    ? `${ability.id}@${target.uid}`
    : choice)

  let forged = null
  try {
    apply(room, a.token, {
      kind: 'resolveEndTurn',
      abilityOrder: order.map((choice) => choice.startsWith(`${ability.id}@`)
        ? `${ability.id}@99:not-an-enemy`
        : choice),
    })
  } catch (error) {
    forged = error
  }
  assertEqual(forged?.name, 'RoomError', 'a forged Loop Orb choice was accepted')

  apply(room, a.token, { kind: 'resolveEndTurn', abilityOrder: order })
  assertEqual(room.run.combat.enemies[0].hp, firstHp - 1)
  assertEqual(room.run.combat.enemies[1].hp, secondHp - 2)
  assertEqual(room.run.combat.players.find((player) => player.id === actor.id).block, 1)
})

check('an online Lightning plan with a dynamically dead target stays editable', () => {
  const { room, a, b } = twoSeatRoom()
  for (const player of room.run.combat.players) player.hand = []
  room.run.combat.players.find((player) => player.id === b.playerId).orbs = ['lightning', 'lightning', null]
  room.run.combat.enemies[0].hp = 1
  const [firstEnemy, secondEnemy] = room.run.combat.enemies
  apply(room, a.token, { kind: 'endTurn' })
  apply(room, b.token, { kind: 'endTurn' })
  const [firstOrb, secondOrb] = snapshotFor(room, a.token).endTurnAbilities
  let rejected = null
  try {
    apply(room, a.token, {
      kind: 'resolveEndTurn',
      abilityOrder: [`${firstOrb.id}@${firstEnemy.uid}`, `${secondOrb.id}@${firstEnemy.uid}`],
    })
  } catch (error) {
    rejected = error
  }
  assertEqual(rejected?.name, 'RoomError')
  assertEqual(room.run.combat.phase, 'player', 'the choice stage remains open for a replacement target')
  assertEqual(room.run.combat.enemies[0].hp, 1, 'the rejected plan is atomic')
  apply(room, a.token, {
    kind: 'resolveEndTurn',
    abilityOrder: [`${firstOrb.id}@${firstEnemy.uid}`, `${secondOrb.id}@${secondEnemy.uid}`],
  })
  assertEqual(room.run.combat.enemies[0].hp, 0)
  assertEqual(room.run.combat.enemies[1].hp, secondEnemy.hp - 1)
})

check('a malformed online discard order is refused as a room error', () => {
  const { room, a, b } = twoSeatRoom()
  apply(room, a.token, { kind: 'endTurn' })
  apply(room, b.token, { kind: 'endTurn' })
  for (const discardOrder of [
    'not-a-list',
    Array.from({ length: room.run.combat.players[0].hand.length + 1 }, (_, index) => `oversized-${index}`),
  ]) {
    let error = null
    try {
      apply(room, a.token, { kind: 'discardHand', discardOrder })
    } catch (thrown) {
      error = thrown
    }
    assert(error, 'the malformed action should be refused')
    assertEqual(error.name, 'RoomError', `got ${error?.name}: ${error?.message}`)
  }
})

check('an unbounded hand can submit its full discard order online', () => {
  const { room, a, b } = twoSeatRoom()
  const player = room.run.combat.players.find((candidate) => candidate.id === a.playerId)
  player.hand = Array.from({ length: 33 }, (_, index) => ({
    ...player.hand[0],
    uid: `large-hand-${index}`,
  }))
  wantsDiscardOrder(room, a.playerId, b.playerId)
  apply(room, a.token, { kind: 'endTurn' })
  apply(room, b.token, { kind: 'endTurn' })
  const order = player.hand.map((card) => card.uid).reverse()
  apply(room, a.token, { kind: 'discardHand', discardOrder: order })
  const other = room.run.combat.players.find((candidate) => candidate.id === b.playerId)
  apply(room, b.token, { kind: 'discardHand', discardOrder: other.hand.map((card) => card.uid) })
  assertEqual(room.run.combat.players[0].discard.length, 33, 'all 33 cards were accepted')
})

check('disconnecting every seat never advances a partially-readied turn', () => {
  const { room, a, b } = twoSeatRoom()
  apply(room, a.token, { kind: 'endTurn' })
  markDisconnected(room, a.token)
  markDisconnected(room, b.token)
  assertEqual(room.run.combat.phase, 'player', 'nobody is connected to approve the transition')
})

check('reconnecting a ready seat resumes a turn paused with nobody connected', () => {
  const { room, a, b } = twoSeatRoom()
  wantsDiscardOrder(room, a.playerId, b.playerId)
  apply(room, a.token, { kind: 'endTurn' })
  markDisconnected(room, a.token)
  markDisconnected(room, b.token)
  joinRoom(room, { token: a.token })
  assertEqual(room.run.combat.phase, 'discard', 'the only connected seat had already readied')
})

check('reconnecting a decided seat resumes discard settlement', () => {
  const { room, a, b } = twoSeatRoom()
  wantsDiscardOrder(room, a.playerId, b.playerId)
  apply(room, a.token, { kind: 'endTurn' })
  apply(room, b.token, { kind: 'endTurn' })
  const player = room.run.combat.players.find((candidate) => candidate.id === a.playerId)
  const discardOrder = player.hand.map((card) => card.uid)
  apply(room, a.token, { kind: 'discardHand', discardOrder })
  assertDeepEqual(snapshotFor(room, a.token).discardOrder, discardOrder, 'the owner can restore its pending order')
  assertEqual(snapshotFor(room, b.token).discardOrder, undefined, 'another seat cannot inspect the order')
  markDisconnected(room, a.token)
  markDisconnected(room, b.token)
  joinRoom(room, { token: a.token })
  assertEqual(room.run.combat.phase, 'enemy', 'the only connected seat had already ordered its hand')
})

check('characters lock once the run starts', () => {
  const { room, a } = twoSeatRoom()
  let threw = false
  try {
    chooseCharacter(room, a.token, 'defect')
  } catch {
    threw = true
  }
  assert(threw, 'a character was swapped mid-run')
})

suite('hidden information')

check("no other player's hand is in the snapshot, anywhere", () => {
  const { room, a, b } = twoSeatRoom()
  const bHand = room.run.combat.players.find((player) => player.id === b.playerId).hand
  assert(bHand.length > 0, 'precondition: the other player should hold cards')

  const seen = new Set(allStrings(snapshotFor(room, a.token)))
  for (const card of bHand) {
    assert(!seen.has(card.uid), `card ${card.uid} from another player's hand leaked into the snapshot`)
  }
})

check('a viewer cannot tell another player\'s hand from their draw pile', () => {
  // The strongest form of the rule, and the one that survives new fields being
  // added later: move a card from the other player's hand to their draw pile
  // and back, keeping both sizes identical. If the viewer's snapshot changes at
  // all, something in it distinguishes the two piles — which is the leak.
  const { room, a, b } = twoSeatRoom()
  const before = JSON.stringify(snapshotFor(room, a.token))

  const other = room.run.combat.players.find((player) => player.id === b.playerId)
  // The two swapped cards must be DIFFERENT cards. A starting deck is mostly
  // Strikes, so swapping the first of each pile silently swapped a card with
  // its own twin — a no-op that no leak could ever fail.
  const handIndex = other.hand.findIndex((card) =>
    other.draw.some((drawn) => drawn.defId !== card.defId),
  )
  assert(handIndex >= 0, 'precondition: the two piles need a pair of different cards')
  const drawIndex = other.draw.findIndex((card) => card.defId !== other.hand[handIndex].defId)
  assert(drawIndex >= 0, 'precondition: the two piles need a pair of different cards')

  const swap = other.hand[handIndex]
  other.hand[handIndex] = other.draw[drawIndex]
  other.draw[drawIndex] = swap

  // A plain assert, not assertEqual: these snapshots are tens of kilobytes and
  // dumping both on failure buries the finding instead of reporting it.
  assert(
    JSON.stringify(snapshotFor(room, a.token)) === before,
    'swapping two DIFFERENT cards between another player\'s hand and draw pile ' +
      'changed what this player can see, so something in the snapshot tells them apart',
  )
})

check('the viewer does see their own hand', () => {
  const { room, a } = twoSeatRoom()
  const snapshot = snapshotFor(room, a.token)
  const me = snapshot.run.combat.players.find((player) => player.id === a.playerId)
  assert(Array.isArray(me.hand) && me.hand.length > 0, 'the viewer cannot see their own hand')
})

check('the order of the viewer\'s own draw pile is not revealed', () => {
  // Which cards are in your own draw pile is derivable and always was: deck
  // minus hand minus the two face-up piles. What must stay secret is the
  // ORDER, so the test is that reordering the pile changes nothing you can see.
  const { room, a } = twoSeatRoom()
  const mine = room.run.combat.players.find((player) => player.id === a.playerId)
  assert(mine.draw.length > 1, 'precondition: the draw pile needs at least two cards')

  const before = JSON.stringify(snapshotFor(room, a.token))
  mine.draw.reverse()
  assert(
    JSON.stringify(snapshotFor(room, a.token)) === before,
    'reversing the viewer\'s own draw pile changed their snapshot, so its order is visible',
  )
})

check('no draw pile is sent as a list', () => {
  const { room, a } = twoSeatRoom()
  for (const player of snapshotFor(room, a.token).run.combat.players) {
    assertEqual(player.draw, undefined, 'a draw pile was serialised')
    assert(typeof player.drawCount === 'number', 'the draw pile size should still be sent')
  }
})

check("another player's deck list is not sent", () => {
  // No screen needs it, and sending it would weaken the hand redaction: deck
  // minus the face-up piles narrows down what someone is holding.
  const { room, a, b } = twoSeatRoom()
  const snapshot = snapshotFor(room, a.token)
  const other = snapshot.run.combat.players.find((player) => player.id === b.playerId)
  assertEqual(other.deck, null, "another player's deck list was sent")
  assert(other.deckCount > 0, 'the deck size should still be visible')
})

check('a field added to Player later is NOT published by default', () => {
  // The redaction is an allowlist for exactly this reason. Written as "strip
  // the secrets, spread the rest", every future field ships to every client
  // and nothing fails. These three stand in for whatever gets added next.
  const { room, a, b } = twoSeatRoom()
  const other = room.run.combat.players.find((player) => player.id === b.playerId)
  other.scryPreview = [{ uid: 'secret-1', defId: 'bash' }]
  other.nextEncounter = 'gremlin_nob'
  other.intentDeck = ['attack', 'block']

  const seen = new Set(allStrings(snapshotFor(room, a.token)))
  for (const leaked of ['secret-1', 'gremlin_nob', 'intentDeck']) {
    assert(!seen.has(leaked), `an unlisted field reached the client: ${leaked}`)
  }
  const keys = allKeys(snapshotFor(room, a.token))
  for (const key of ['scryPreview', 'nextEncounter', 'intentDeck']) {
    assert(!keys.includes(key), `an unlisted field reached the client: ${key}`)
  }
})

check('a draw lock is public to the whole co-op table', () => {
  const { room, a, b } = twoSeatRoom()
  room.run.combat.players.find((player) => player.id === a.playerId).drawLocked = true
  const seen = snapshotFor(room, b.token).run.combat.players
    .find((player) => player.id === a.playerId)
  assertEqual(seen.drawLocked, true, 'a teammate could not see that further draw effects are blocked')
})

check('public Relic activation flags survive online snapshots and reconnect', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  actor.powerPlayedThisTurn = true
  actor.shuffledThisCombat = true
  actor.facingEnemyUid = room.run.combat.enemies[0].uid
  actor.damageDealtZeroThisTurn = true
  room.run.combat.potionLimit = 2
  room.run.combat.startTurnStage = 'facing'
  for (const token of [a.token, b.token]) {
    const combat = snapshotFor(room, token).run.combat
    const seen = combat.players.find((player) => player.id === a.playerId)
    assertEqual(seen.powerPlayedThisTurn, true)
    assertEqual(seen.shuffledThisCombat, true)
    assertEqual(seen.facingEnemyUid, actor.facingEnemyUid)
    assertEqual(seen.damageDealtZeroThisTurn, true)
    assertEqual(combat.potionLimit, 2)
    assertEqual(combat.startTurnStage, 'facing')
  }
  markDisconnected(room, a.token)
  const rejoined = joinRoom(room, { token: a.token })
  const restored = snapshotFor(room, rejoined.token).run.combat.players
    .find((player) => player.id === a.playerId)
  assertEqual(restored.powerPlayedThisTurn, true)
  assertEqual(restored.shuffledThisCombat, true)
  assertEqual(restored.facingEnemyUid, actor.facingEnemyUid)
  assertEqual(restored.damageDealtZeroThisTurn, true)
  assertEqual(snapshotFor(room, rejoined.token).run.combat.potionLimit, 2)
  assertEqual(snapshotFor(room, rejoined.token).run.combat.startTurnStage, 'facing')
})

check('a room validates and publishes an optional row switch atomically with its card', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const ally = room.run.combat.players.find((player) => player.id === b.playerId)
  const dash = { uid: 'room-dash', defId: 'dash', upgraded: true }
  actor.hand = [dash]
  actor.energy = 3
  const target = room.run.combat.enemies.find((enemy) => !enemy.dead)
  Object.assign(target, { hp: 10, maxHp: 10, block: 0 })
  const before = JSON.stringify(room.run)
  let malformed = null
  try {
    apply(room, a.token, {
      kind: 'playCard', cardUid: dash.uid, enemyUid: target.uid,
      switchWithPlayerId: 7, preflight: true,
    })
  } catch (error) {
    malformed = error
  }
  assertEqual(malformed?.name, 'RoomError', 'a malformed row-switch target reached the engine')
  assertEqual(JSON.stringify(room.run), before, 'a refused row switch partially resolved the card')

  const actorRow = actor.row
  const allyRow = ally.row
  const result = apply(room, a.token, {
    kind: 'playCard', cardUid: dash.uid, enemyUid: target.uid,
    switchWithPlayerId: b.playerId, preflight: true,
  })
  assertEqual(room.run.combat.players.find((player) => player.id === a.playerId).row, allyRow)
  assertEqual(room.run.combat.players.find((player) => player.id === b.playerId).row, actorRow)
  assertEqual(room.run.combat.enemies.find((enemy) => enemy.uid === target.uid).hp, 7)
  assertEqual(result.snapshot.run.combat.players.find((player) => player.id === a.playerId).row, allyRow)
})

check('Offering self-HP loss ends the co-op run atomically when its owner falls', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const offering = { uid: 'room-offering', defId: 'offering', upgraded: false }
  actor.hand = [offering]
  actor.draw = Array.from({ length: 3 }, (_, index) => ({
    uid: `room-offering-draw-${index}`, defId: 'defend_ironclad', upgraded: false,
  }))
  actor.hp = 1
  actor.energy = 0
  apply(room, a.token, { kind: 'playCard', cardUid: offering.uid, preflight: true })
  assertEqual(room.run.combat.phase, 'lost')
  const fallen = room.run.combat.players.find((player) => player.id === a.playerId)
  assertEqual(fallen.dead, true)
  assertEqual(fallen.energy, 0, 'Offering granted Energy after its owner died')
  assertEqual(fallen.hand.length, 0, 'Offering drew after its owner died')
  assertEqual(fallen.draw.length, 3, 'Offering changed the hidden draw pile after its owner died')
  assertEqual(fallen.exhaust.length, 0, 'Offering Exhausted after the run had ended')
  const seen = snapshotFor(room, b.token).run.combat
  assertEqual(seen.phase, 'lost', 'the teammate did not receive the terminal state')
  assertEqual(seen.players.find((player) => player.id === a.playerId).hp, 0)
})

check('Glacier+ publishes redirected Block and the caster\'s Frost together', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const ally = room.run.combat.players.find((player) => player.id === b.playerId)
  const glacier = { uid: 'room-glacier', defId: 'glacier', upgraded: true }
  actor.hand = [glacier]
  actor.energy = 2
  actor.orbs = [null, null, null]
  ally.block = 0
  const result = apply(room, a.token, {
    kind: 'playCard', cardUid: glacier.uid, playerId: b.playerId, preflight: true,
  })
  const currentActor = room.run.combat.players.find((player) => player.id === a.playerId)
  const currentAlly = room.run.combat.players.find((player) => player.id === b.playerId)
  assertDeepEqual(currentActor.orbs, ['frost', null, null])
  assertEqual(currentAlly.block, 3)
  const seen = result.snapshot.run.combat.players
  assertDeepEqual(seen.find((player) => player.id === a.playerId).orbs, ['frost', null, null])
  assertEqual(seen.find((player) => player.id === b.playerId).block, 3)
})

check('Good Instincts+ publishes its zero-cost ally Block without exposing hidden piles', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const ally = room.run.combat.players.find((player) => player.id === b.playerId)
  const instincts = { uid: 'room-good-instincts', defId: 'good_instincts', upgraded: true }
  actor.hand = [instincts]
  actor.energy = 0
  actor.draw = [{ uid: 'still-hidden', defId: 'strike_ironclad', upgraded: false }]
  ally.block = 0
  const result = apply(room, a.token, {
    kind: 'playCard', cardUid: instincts.uid, playerId: b.playerId, preflight: true,
  })
  const currentActor = room.run.combat.players.find((player) => player.id === a.playerId)
  const currentAlly = room.run.combat.players.find((player) => player.id === b.playerId)
  assertEqual(currentActor.energy, 0)
  assertEqual(currentAlly.block, 2)
  assertEqual(currentActor.discard.some((card) => card.uid === instincts.uid), true)
  const seen = result.snapshot.run.combat.players
  assertEqual(seen.find((player) => player.id === b.playerId).block, 2)
  assert(!allStrings(result.snapshot).includes('still-hidden'), 'the untouched draw pile leaked through the card update')
})

check('Master of Strategy draws privately while its Exhaust stays public', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const strategy = { uid: 'room-master-strategy', defId: 'master_of_strategy', upgraded: true }
  const hidden = Array.from({ length: 4 }, (_, index) => ({
    uid: `room-strategy-draw-${index}`, defId: 'strike_ironclad', upgraded: false,
  }))
  actor.hand = [strategy]
  actor.draw = hidden
  actor.energy = 0
  const result = apply(room, a.token, { kind: 'playCard', cardUid: strategy.uid, preflight: true })
  const owner = result.snapshot.run.combat.players.find((player) => player.id === a.playerId)
  assertDeepEqual(owner.hand.map((card) => card.uid), hidden.map((card) => card.uid))
  assertEqual(owner.exhaust.some((card) => card.uid === strategy.uid), true)
  const teammate = snapshotFor(room, b.token)
  assertEqual(teammate.run.combat.players.find((player) => player.id === a.playerId).handCount, 4)
  for (const card of hidden) {
    assert(!allStrings(teammate).includes(card.uid), `Master of Strategy leaked ${card.uid} to a teammate`)
  }
  assert(allStrings(teammate).includes(strategy.uid), 'the public Exhaust pile hid Master of Strategy')
})

check('Panacea+ clears every living player in the shared snapshot', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const ally = room.run.combat.players.find((player) => player.id === b.playerId)
  const panacea = { uid: 'room-panacea', defId: 'panacea', upgraded: true }
  Object.assign(actor, { hand: [panacea], energy: 0, weak: 1, vulnerable: 1 })
  Object.assign(ally, { weak: 2, vulnerable: 2 })
  const result = apply(room, a.token, { kind: 'playCard', cardUid: panacea.uid, preflight: true })
  for (const player of room.run.combat.players) {
    assertEqual(player.weak, 0)
    assertEqual(player.vulnerable, 0)
  }
  for (const player of result.snapshot.run.combat.players) {
    assertEqual(player.weak, 0)
    assertEqual(player.vulnerable, 0)
  }
  const currentActor = room.run.combat.players.find((player) => player.id === a.playerId)
  assertEqual(currentActor.exhaust.some((card) => card.uid === panacea.uid), true)
})

check('Apparition protection is authoritative and visible without exposing hands', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const apparition = { uid: 'room-apparition', defId: 'apparition', upgraded: false }
  Object.assign(actor, { hand: [apparition], hp: 10, maxHp: 10, energy: 1 })
  apply(room, a.token, { kind: 'playCard', cardUid: apparition.uid, preflight: true })
  const protectedActor = room.run.combat.players.find((player) => player.id === a.playerId)
  assertEqual(protectedActor.hpLossLimitThisRound, 1)
  assertEqual(protectedActor.exhaust.some((card) => card.uid === apparition.uid), true)
  const teammate = snapshotFor(room, b.token)
  const seen = teammate.run.combat.players.find((player) => player.id === a.playerId)
  assertEqual(seen.hpLossLimitThisRound, 1)
  assertEqual(seen.hand, null)
})

check('Dark Shackles uses server-owned enemy intents', () => {
  const { room, a } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const shackles = { uid: 'room-dark-shackles', defId: 'dark_shackles', upgraded: true }
  Object.assign(actor, { hand: [shackles], energy: 0, block: 0, row: 0 })
  room.run.combat.die = 1
  room.run.combat.enemies = [
    { ...room.run.combat.enemies[0], uid: 'room-attacker', row: 0, defId: 'cultist', dead: false },
    { ...room.run.combat.enemies[0], uid: 'room-bystander', row: 1, defId: 'cultist', dead: false },
  ]
  const result = apply(room, a.token, { kind: 'playCard', cardUid: shackles.uid, preflight: true })
  assertEqual(room.run.combat.players.find((player) => player.id === a.playerId).block, 3)
  assertEqual(result.snapshot.run.combat.players.find((player) => player.id === a.playerId).block, 3)
})

check('Madness discount survives reconnect and cannot be spent as a Miracle payment', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const madness = { uid: 'room-madness', defId: 'madness', upgraded: true }
  const greedy = { uid: 'room-madness-target', defId: 'hand_of_greed', upgraded: false }
  Object.assign(actor, { hand: [madness, greedy], energy: CAPS.energy, miracles: 1 })
  apply(room, a.token, { kind: 'playCard', cardUid: madness.uid, preflight: true })
  const teammate = snapshotFor(room, b.token)
  assertEqual(teammate.run.combat.players.find((player) => player.id === a.playerId).freeCardsThisTurn, 1)
  assert(!allStrings(teammate).includes(greedy.uid), 'Madness leaked the discounted card to a teammate')
  markDisconnected(room, a.token)
  const rejoined = joinRoom(room, { token: a.token })
  let miracleError = null
  try {
    apply(room, rejoined.token, {
      kind: 'playCard', cardUid: greedy.uid, enemyUid: room.run.combat.enemies[0].uid,
      spendMiracle: true, preflight: true,
    })
  } catch (error) {
    miracleError = error
  }
  assertEqual(miracleError?.name, 'RoomError')
  const result = apply(room, rejoined.token, {
    kind: 'playCard', cardUid: greedy.uid, enemyUid: room.run.combat.enemies[0].uid, preflight: true,
  })
  const current = room.run.combat.players.find((player) => player.id === a.playerId)
  assertEqual(current.energy, CAPS.energy)
  assertEqual(current.freeCardsThisTurn, 0)
  assertEqual(result.snapshot.run.combat.players.find((player) => player.id === a.playerId).freeCardsThisTurn, 0)
})

check('Swivel and Conclude turn locks survive reconnect without exposing the remaining hand', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const swivel = { uid: 'room-swivel', defId: 'swivel', upgraded: false }
  const conclude = { uid: 'room-conclude', defId: 'conclude', upgraded: false }
  const hidden = { uid: 'room-hidden-after-conclude', defId: 'defend_ironclad', upgraded: false }
  Object.assign(actor, { hand: [swivel, conclude, hidden], energy: 3 })
  apply(room, a.token, { kind: 'playCard', cardUid: swivel.uid, preflight: true })
  const enemy = room.run.combat.enemies.find((candidate) => !candidate.dead)
  apply(room, a.token, { kind: 'playCard', cardUid: conclude.uid, enemyUid: enemy.uid, preflight: true })
  markDisconnected(room, a.token)
  const rejoined = joinRoom(room, { token: a.token })
  const owner = snapshotFor(room, rejoined.token).run.combat.players.find((player) => player.id === a.playerId)
  assertEqual(owner.freeAttacksThisTurn, 0, 'Conclude did not consume Swivel as the next Attack')
  assertEqual(owner.cardPlayLocked, true, 'Conclude lock disappeared during reconnect')
  const teammate = snapshotFor(room, b.token)
  const seen = teammate.run.combat.players.find((player) => player.id === a.playerId)
  assertEqual(seen.cardPlayLocked, true, 'the co-op table cannot see the Conclude lock')
  assert(!allStrings(teammate).includes(hidden.uid), 'the public lock leaked a private remaining card')
})

check('Conjure Blade and Foreign Influence stay authoritative and reconnect-safe', () => {
  const { room, a, b } = twoSeatRoom()
  const watcher = room.run.combat.players.find((player) => player.id === a.playerId)
  const ally = room.run.combat.players.find((player) => player.id === b.playerId)
  const conjure = { uid: 'room-conjure', defId: 'conjure_blade', upgraded: true }
  const foreign = { uid: 'room-foreign', defId: 'foreign_influence', upgraded: false }
  const hidden = { uid: 'room-generated-hidden', defId: 'deus_ex_machina', upgraded: false }
  const allyAttack = { uid: 'room-ally-bash', defId: 'bash', upgraded: false }
  Object.assign(watcher, {
    character: 'watcher', hand: [conjure, foreign, hidden], energy: 5,
    starterStrikeDamageBonus: 0,
  })
  Object.assign(ally, { hand: [allyAttack], energy: 2 })

  apply(room, a.token, {
    kind: 'playCard', cardUid: conjure.uid, energySpent: 2, preflight: true,
  })
  markDisconnected(room, a.token)
  const rejoined = joinRoom(room, { token: a.token })
  const restored = snapshotFor(room, rejoined.token).run.combat.players
    .find((player) => player.id === a.playerId)
  assertEqual(restored.starterStrikeDamageBonus, 4)
  assertEqual(restored.powers.find((power) => power.uid === conjure.uid).counter, 4,
    'Conjure Blade cubes disappeared during reconnect')
  const publicAfterConjure = snapshotFor(room, b.token)
  assert(!allStrings(publicAfterConjure).includes(hidden.uid), 'Conjure Blade leaked the remaining private hand')

  const enemy = room.run.combat.enemies.find((candidate) => !candidate.dead)
  apply(room, b.token, {
    kind: 'playCard', cardUid: allyAttack.uid, enemyUid: enemy.uid, preflight: true,
  })
  apply(room, rejoined.token, {
    kind: 'playCard', cardUid: foreign.uid, mode: 1,
    copiedCardUid: hidden.uid, preflight: true,
  })
  const waiting = snapshotFor(room, b.token).run.combat
  assertEqual(waiting.phase, 'copy')
  assertDeepEqual(waiting.pendingCardCopy.sourceNames, ['Foreign Influence'])
  assertEqual(waiting.pendingCardCopy.card.uid, `${foreign.uid}:copy`)
  assertEqual(waiting.pendingCardCopy.card.defId, allyAttack.defId,
    'the server trusted a client-supplied hidden card instead of deriving the public last Attack')

  const disconnected = structuredClone(room)
  markDisconnected(disconnected, rejoined.token)
  assertEqual(disconnected.run.combat.phase, 'player')
  assertEqual(disconnected.run.combat.pendingCardCopy, undefined,
    'a disconnected Foreign Influence owner deadlocked the shared turn')

  apply(room, rejoined.token, {
    kind: 'playCardCopy', cardUid: waiting.pendingCardCopy.card.uid,
    enemyUid: room.run.combat.enemies.find((candidate) => !candidate.dead).uid, preflight: true,
  })
  assertEqual(room.run.combat.phase, 'player')
})

check('Meditate recovery is authoritative, reconnect-safe, and private', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const meditate = { uid: 'room-meditate', defId: 'meditate', upgraded: true }
  const first = { uid: 'room-meditate-first', defId: 'perseverance', upgraded: false }
  const second = { uid: 'room-meditate-second', defId: 'windmill_strike', upgraded: false }
  Object.assign(actor, {
    character: 'watcher', stance: 'wrath', hand: [meditate], discard: [first, second], energy: 1,
  })
  const before = JSON.stringify(room.run)

  for (const recoverDiscardUids of ['not-a-list', [first.uid, first.uid], [first.uid]]) {
    let refused = null
    try {
      apply(room, a.token, {
        kind: 'playCard', cardUid: meditate.uid, recoverDiscardUids, preflight: true,
      })
    } catch (error) { refused = error }
    assertEqual(refused?.name, 'RoomError')
    assertEqual(JSON.stringify(room.run), before, 'a refused Meditate choice mutated room authority')
  }
  let stolen = null
  try {
    apply(room, b.token, {
      kind: 'playCard', cardUid: meditate.uid,
      recoverDiscardUids: [first.uid, second.uid], preflight: true,
    })
  } catch (error) { stolen = error }
  assertEqual(stolen?.name, 'RoomError', 'another seat played Meditate')

  apply(room, a.token, {
    kind: 'playCard', cardUid: meditate.uid,
    recoverDiscardUids: [first.uid, second.uid], preflight: true,
  })
  const owner = snapshotFor(room, a.token).run.combat.players.find((player) => player.id === a.playerId)
  assertEqual(owner.stance, 'calm')
  assertEqual(owner.cardPlayLocked, true)
  assertDeepEqual(owner.hand.map((card) => card.uid), [first.uid, second.uid])
  assert(owner.hand.every((card) => card.retainThisTurn === true && !card.retainedLastTurn))

  const teammate = snapshotFor(room, b.token)
  assert(!allStrings(teammate).some((value) => value === first.uid || value === second.uid),
    'Meditate leaked recovered hand identities to a teammate')
  markDisconnected(room, a.token)
  const rejoined = joinRoom(room, { token: a.token })
  const reconnected = snapshotFor(room, rejoined.token).run.combat.players
    .find((player) => player.id === a.playerId)
  assertDeepEqual(reconnected.hand.map((card) => card.uid), [first.uid, second.uid])
  assert(reconnected.hand.every((card) => card.retainThisTurn === true),
    'reconnect lost Meditate retention state')
})

check('a disconnected Meditate+ preview deterministically settles both recoveries without leaking them', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const meditate = { uid: 'room-abandoned-meditate', defId: 'meditate', upgraded: true }
  const recovered = [
    { uid: 'room-abandoned-meditate-first', defId: 'perseverance', upgraded: false },
    { uid: 'room-abandoned-meditate-second', defId: 'windmill_strike', upgraded: false },
  ]
  const leftBehind = { uid: 'room-abandoned-meditate-third', defId: 'defend_watcher', upgraded: false }
  Object.assign(actor, {
    character: 'watcher', stance: 'wrath', hand: [meditate], discard: [...recovered, leftBehind], energy: 1,
  })
  room.cardPreviews = {
    [a.playerId]: {
      cardUid: meditate.uid,
      kind: 'recover',
      cards: [...actor.discard],
      spendMiracle: false,
      enemyUid: null,
    },
  }

  markDisconnected(room, a.token)
  apply(room, b.token, { kind: 'endTurn' })

  assertEqual(room.cardPreviews?.[a.playerId], undefined)
  const settled = room.run.combat.players.find((player) => player.id === a.playerId)
  assertDeepEqual(settled.hand.map((card) => card.uid), recovered.map((card) => card.uid))
  // Both were Retained, so nothing was left to arrange and the turn ran on —
  // which is where a Retain stops being "this turn" and becomes "last turn".
  assert(settled.hand.every((card) => card.retainedLastTurn === true))
  assert(settled.hand.every((card) => card.retainThisTurn === undefined))
  assert(settled.discard.some((card) => card.uid === leftBehind.uid))
  const teammate = snapshotFor(room, b.token)
  assert(!allStrings(teammate).some((value) => recovered.some((card) => card.uid === value)),
    'the disconnected recovery leaked hidden hand identities')

  const rejoined = joinRoom(room, { token: a.token })
  const owner = snapshotFor(room, rejoined.token).run.combat.players.find((player) => player.id === a.playerId)
  assertDeepEqual(owner.hand.map((card) => card.uid), recovered.map((card) => card.uid))
})

check('Establishment discounts survive reconnect without exposing the retained hand', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const retained = {
    uid: 'room-establishment-retained', defId: 'bludgeon', upgraded: false, retainedLastTurn: true,
  }
  const ordinary = { uid: 'room-establishment-ordinary', defId: 'defend_watcher', upgraded: false }
  Object.assign(room.run.combat, {
    phase: 'roundEnd', turn: 1, startTurnProgress: undefined, pendingTriggers: [],
  })
  Object.assign(actor, {
    character: 'watcher', hand: [retained, ordinary], draw: [], discard: [], energy: 0,
    powers: [{ uid: 'room-establishment', defId: 'establishment', upgraded: true }],
  })

  apply(room, a.token, { kind: 'startTurn' })
  const owner = snapshotFor(room, a.token).run.combat.players.find((player) => player.id === a.playerId)
  const retainedOwnerCard = owner.hand.find((card) => card.uid === retained.uid)
  assertEqual(retainedOwnerCard.costReductionThisTurn, 2)
  assertEqual(owner.hand.find((card) => card.uid === ordinary.uid).costReductionThisTurn, undefined)
  const teammate = snapshotFor(room, b.token)
  assert(!allStrings(teammate).some((value) => value === retained.uid || value === ordinary.uid),
    'Establishment leaked the retained hand to a teammate')

  markDisconnected(room, a.token)
  const rejoined = joinRoom(room, { token: a.token })
  const restored = snapshotFor(room, rejoined.token).run.combat.players.find((player) => player.id === a.playerId)
  assertEqual(restored.hand.find((card) => card.uid === retained.uid).costReductionThisTurn, 2)
  const energy = room.run.combat.players.find((player) => player.id === a.playerId).energy
  apply(room, rejoined.token, {
    kind: 'playCard', cardUid: retained.uid,
    enemyUid: room.run.combat.enemies.find((enemy) => !enemy.dead).uid, preflight: true,
  })
  assertEqual(room.run.combat.players.find((player) => player.id === a.playerId).energy, energy - 1)
})

check('Apotheosis bonuses survive reconnect while the remaining hand stays private', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const apotheosis = { uid: 'room-apotheosis', defId: 'apotheosis', upgraded: true }
  const strike = { uid: 'room-apotheosis-strike', defId: 'strike_ironclad', upgraded: false }
  const defend = { uid: 'room-apotheosis-defend', defId: 'defend_ironclad', upgraded: false }
  Object.assign(actor, { hand: [apotheosis, strike, defend], energy: 3, block: 0 })
  apply(room, a.token, { kind: 'playCard', cardUid: apotheosis.uid, preflight: true })
  markDisconnected(room, a.token)
  const rejoined = joinRoom(room, { token: a.token })
  const owner = snapshotFor(room, rejoined.token).run.combat.players.find((player) => player.id === a.playerId)
  assertEqual(owner.starterStrikeDamageBonus, 1)
  assertEqual(owner.starterDefendBlockBonus, 1)
  const teammate = snapshotFor(room, b.token)
  assert(!allStrings(teammate).includes(strike.uid) && !allStrings(teammate).includes(defend.uid),
    'Apotheosis leaked the owner\'s improved hand')
  const enemyHp = room.run.combat.enemies[0].hp
  apply(room, rejoined.token, {
    kind: 'playCard', cardUid: strike.uid, enemyUid: room.run.combat.enemies[0].uid, preflight: true,
  })
  apply(room, rejoined.token, {
    kind: 'playCard', cardUid: defend.uid, playerId: a.playerId, preflight: true,
  })
  assertEqual(room.run.combat.enemies[0].hp, enemyHp - 2)
  assertEqual(room.run.combat.players.find((player) => player.id === a.playerId).block, 2)
})

check('Panache row choice is coordinator-owned and reconnect-safe', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const other = room.run.combat.players.find((player) => player.id === b.playerId)
  actor.hand = []
  other.hand = []
  actor.powers = [{ uid: 'room-panache', defId: 'panache', upgraded: true }]
  room.run.combat.enemies.forEach((enemy, index) => Object.assign(enemy, {
    row: index, hp: 20, maxHp: 20, block: 0, dead: false,
  }))
  apply(room, a.token, { kind: 'endTurn' })
  apply(room, b.token, { kind: 'endTurn' })
  markDisconnected(room, a.token)
  const rejoined = joinRoom(room, { token: a.token })
  const snapshot = snapshotFor(room, rejoined.token)
  const ability = snapshot.endTurnAbilities.find((entry) => entry.label.includes('Panache'))
  assertEqual(ability.targets.length, room.run.combat.enemies.length)
  const target = room.run.combat.enemies[1]
  const firstHp = room.run.combat.enemies[0].hp
  apply(room, rejoined.token, {
    kind: 'resolveEndTurn', abilityOrder: [`${ability.id}@${target.uid}`],
  })
  assertEqual(room.run.combat.enemies[0].hp, firstHp)
  assertEqual(room.run.combat.enemies[1].hp, 15)
})

check('an authoritative Panache plan keeps its row after Poison kills the chosen anchor', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const other = room.run.combat.players.find((player) => player.id === b.playerId)
  actor.hand = []
  other.hand = []
  actor.powers = [{ uid: 'room-panache-anchor', defId: 'panache', upgraded: false }]
  const [anchor, survivor] = room.run.combat.enemies
  Object.assign(anchor, { row: 0, hp: 1, maxHp: 1, poison: 1, dead: false })
  Object.assign(survivor, { row: 1, hp: 20, maxHp: 20, poison: 0, dead: false })
  apply(room, a.token, { kind: 'endTurn' })
  apply(room, b.token, { kind: 'endTurn' })
  const abilities = snapshotFor(room, a.token).endTurnAbilities
  const poison = abilities.find((entry) => entry.label.includes('Poison'))
  const panache = abilities.find((entry) => entry.label.includes('Panache'))
  apply(room, a.token, {
    kind: 'resolveEndTurn', abilityOrder: [poison.id, `${panache.id}@${anchor.uid}`],
  })
  assertEqual(room.run.combat.enemies[0].dead, true)
  assertEqual(room.run.combat.enemies[1].hp, 20,
    'Panache should fizzle after its valid chosen row becomes empty')
})

check('a crafted row-card action cannot use a dead enemy as its anchor', () => {
  const { room, a } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const entrance = { uid: 'room-dead-row-target', defId: 'dramatic_entrance', upgraded: false }
  actor.hand = [entrance]
  actor.energy = 0
  const [dead, living] = room.run.combat.enemies
  Object.assign(dead, { row: 0, hp: 0, dead: true })
  Object.assign(living, { row: 0, hp: 20, maxHp: 20, dead: false })
  let rejected = null
  try {
    apply(room, a.token, {
      kind: 'playCard', cardUid: entrance.uid, enemyUid: dead.uid, preflight: true,
    })
  } catch (error) {
    rejected = error
  }
  assertEqual(rejected?.name, 'RoomError')
  assertEqual(room.run.combat.enemies[1].hp, 20)
  assertEqual(room.run.combat.players.find((player) => player.id === a.playerId).hand[0].uid, entrance.uid)
})

check('The Bomb counter is public across reconnect and its third cube Exhausts authoritatively', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const other = room.run.combat.players.find((player) => player.id === b.playerId)
  const bomb = { uid: 'room-bomb', defId: 'the_bomb', upgraded: true, counter: 2 }
  actor.hand = []
  other.hand = []
  actor.powers = [bomb]
  for (const enemy of room.run.combat.enemies) Object.assign(enemy, { hp: 20, maxHp: 20, block: 0, dead: false })
  const before = snapshotFor(room, b.token)
  const publicBomb = before.run.combat.players.find((player) => player.id === a.playerId).powers[0]
  assertEqual(publicBomb.counter, 2)
  assertEqual(before.run.combat.players.find((player) => player.id === a.playerId).hand, null)
  markDisconnected(room, a.token)
  const rejoined = joinRoom(room, { token: a.token })
  apply(room, rejoined.token, { kind: 'endTurn' })
  apply(room, b.token, { kind: 'endTurn' })
  assertDeepEqual(room.run.combat.enemies.map((enemy) => enemy.hp), Array(room.run.combat.enemies.length).fill(8))
  const current = room.run.combat.players.find((player) => player.id === a.playerId)
  assertEqual(current.powers.length, 0)
  assertEqual(current.exhaust.some((card) => card.uid === bomb.uid), true)
})

check('Sadistic Nature uses authoritative per-token gains and survives reconnect without leaking hand', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const sadistic = { uid: 'room-sadistic', defId: 'sadistic_nature', upgraded: true }
  const catalyst = { uid: 'room-sadistic-catalyst', defId: 'catalyst', upgraded: true }
  Object.assign(actor, { hand: [sadistic, catalyst], energy: 1 })
  const [untouched, target] = room.run.combat.enemies
  for (const enemy of room.run.combat.enemies) {
    Object.assign(enemy, { defId: 'cultist', hp: 30, maxHp: 30, poison: 0, block: 0, dead: false })
  }
  target.poison = 5
  apply(room, a.token, { kind: 'playCard', cardUid: sadistic.uid, preflight: true })
  const teammate = snapshotFor(room, b.token)
  assert(allStrings(teammate).includes(sadistic.uid), 'the face-up Sadistic Nature Power stayed hidden')
  assert(!allStrings(teammate).includes(catalyst.uid), 'Sadistic Nature leaked the owner\'s Catalyst')
  markDisconnected(room, a.token)
  const rejoined = joinRoom(room, { token: a.token })
  apply(room, rejoined.token, {
    kind: 'playCard', cardUid: catalyst.uid, enemyUid: target.uid, preflight: true,
  })
  assertEqual(room.run.combat.enemies[0].hp, 30)
  assertEqual(room.run.combat.enemies[1].poison, 15)
  assertEqual(room.run.combat.enemies[1].hp, 10,
    '10 added Poison cubes should trigger Sadistic Nature+ 10 times')
})

check('Reprogram+ publishes Strength and emptied Orb slots atomically', () => {
  const { room, a } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const reprogram = { uid: 'room-reprogram', defId: 'reprogram', upgraded: true }
  Object.assign(actor, { hand: [reprogram], energy: 0, strength: 0, orbs: ['lightning', 'frost', 'dark'] })
  const result = apply(room, a.token, { kind: 'playCard', cardUid: reprogram.uid, preflight: true })
  const seen = result.snapshot.run.combat.players.find((player) => player.id === a.playerId)
  assertEqual(seen.strength, 1)
  assertDeepEqual(seen.orbs, [null, null, null])
})

check('Stack+ publishes Orb-count Block only to the chosen ally', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const ally = room.run.combat.players.find((player) => player.id === b.playerId)
  const stack = { uid: 'room-stack', defId: 'stack', upgraded: true }
  Object.assign(actor, { hand: [stack], energy: 1, block: 0, orbs: ['lightning', 'frost', null] })
  ally.block = 0
  const result = apply(room, a.token, {
    kind: 'playCard', cardUid: stack.uid, playerId: b.playerId, preflight: true,
  })
  const seen = result.snapshot.run.combat.players
  assertEqual(seen.find((player) => player.id === a.playerId).block, 0)
  assertEqual(seen.find((player) => player.id === b.playerId).block, 3)
})

check('Power discounts publish a zero-Energy Streamline atomically', () => {
  const { room, a } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const target = room.run.combat.enemies.find((enemy) => !enemy.dead)
  const streamline = { uid: 'room-streamline', defId: 'streamline', upgraded: false }
  Object.assign(actor, {
    hand: [streamline], energy: 0,
    powers: [
      { uid: 'room-power-1', defId: 'capacitor', upgraded: false },
      { uid: 'room-power-2', defId: 'fusion', upgraded: false },
    ],
  })
  const before = target.hp
  const result = apply(room, a.token, {
    kind: 'playCard', cardUid: streamline.uid, enemyUid: target.uid, preflight: true,
  })
  assertEqual(result.snapshot.run.combat.enemies.find((enemy) => enemy.uid === target.uid).hp, Math.max(0, before - 3))
  assertEqual(result.snapshot.run.combat.players.find((player) => player.id === a.playerId).energy, 0)
})

check('Catalyst+ publishes multiplied Poison and Exhaust atomically', () => {
  const { room, a } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const target = room.run.combat.enemies.find((enemy) => !enemy.dead)
  const catalyst = { uid: 'room-catalyst', defId: 'catalyst', upgraded: true }
  Object.assign(actor, { hand: [catalyst], energy: 1 })
  target.poison = 3
  const result = apply(room, a.token, {
    kind: 'playCard', cardUid: catalyst.uid, enemyUid: target.uid, preflight: true,
  })
  assertEqual(result.snapshot.run.combat.enemies.find((enemy) => enemy.uid === target.uid).poison, 9)
  assertEqual(result.snapshot.run.combat.players.find((player) => player.id === a.playerId).exhaust.length, 1)
})

check('Corpse Explosion attachment survives reconnect and detonates publicly', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === b.playerId)
  const source = room.run.combat.enemies.find((enemy) => !enemy.dead)
  const corpseExplosion = { uid: 'room-corpse-explosion', defId: 'corpse_explosion', upgraded: false }
  const strike = { uid: 'room-corpse-strike', defId: 'strike_silent', upgraded: true }
  Object.assign(actor, { hand: [corpseExplosion, strike], energy: 3, discard: [] })
  room.run.combat.enemies = [
    { ...source, uid: 'room-corpse-target', row: 0, hp: 2, maxHp: 2, block: 0, dead: false },
    { ...source, uid: 'room-corpse-row', row: 0, hp: 12, maxHp: 12, block: 0, dead: false },
  ]

  apply(room, b.token, {
    kind: 'playCard', cardUid: corpseExplosion.uid, enemyUid: 'room-corpse-target', preflight: true,
  })
  const teammate = snapshotFor(room, a.token)
  assertEqual(teammate.run.combat.enemies[0].corpseExplosion.card.uid, corpseExplosion.uid)
  assert(!teammate.run.combat.players.find((player) => player.id === b.playerId).discard
    .some((card) => card.uid === corpseExplosion.uid), 'the attached card entered discard early')

  markDisconnected(room, b.token)
  const rejoined = joinRoom(room, { token: b.token })
  assertEqual(snapshotFor(room, rejoined.token).run.combat.enemies[0].corpseExplosion.damage, 6)
  apply(room, rejoined.token, {
    kind: 'playCard', cardUid: strike.uid, enemyUid: 'room-corpse-target', preflight: true,
  })
  const resolved = snapshotFor(room, a.token).run.combat
  assertDeepEqual(resolved.enemies.map((enemy) => enemy.hp), [0, 6])
  assertEqual(resolved.players.find((player) => player.id === b.playerId).discard
    .filter((card) => card.uid === corpseExplosion.uid).length, 1)
})

check('Setup+ publishes Energy only to its chosen ally and Exhausts atomically', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const ally = room.run.combat.players.find((player) => player.id === b.playerId)
  const setup = { uid: 'room-setup', defId: 'setup', upgraded: true }
  Object.assign(actor, { hand: [setup], energy: 0 })
  ally.energy = 0
  const result = apply(room, a.token, {
    kind: 'playCard', cardUid: setup.uid, playerId: b.playerId, preflight: true,
  })
  const seen = result.snapshot.run.combat.players
  assertEqual(seen.find((player) => player.id === a.playerId).energy, 0)
  assertEqual(seen.find((player) => player.id === b.playerId).energy, 2)
  assertEqual(seen.find((player) => player.id === a.playerId).exhaust.length, 1)
})

check('Calculated Gamble publishes Reflex, Tactician, and After Image atomically', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const gamble = { uid: 'room-gamble', defId: 'calculated_gamble', upgraded: false }
  Object.assign(actor, {
    hand: [
      gamble,
      { uid: 'room-reflex', defId: 'reflex', upgraded: false },
      { uid: 'room-tactician', defId: 'tactician', upgraded: false },
      { uid: 'room-gamble-kept', defId: 'slice', upgraded: false },
    ],
    draw: Array.from({ length: 10 }, (_, index) => ({
      uid: `room-gamble-private-${index}`, defId: 'deflect', upgraded: false,
    })),
    discard: [], exhaust: [], energy: 0, block: 0,
    powers: [{ uid: 'room-after-image', defId: 'after_image', upgraded: false }],
  })
  const result = apply(room, a.token, { kind: 'playCard', cardUid: gamble.uid, preflight: true })
  const seen = result.snapshot.run.combat.players.find((player) => player.id === a.playerId)
  assertEqual(seen.hand.length, 5)
  assertEqual(seen.energy, 2)
  assertEqual(seen.block, 1)
  assertEqual(seen.exhaust.length, 2)
  assert(!allStrings(snapshotFor(room, b.token)).some((value) => value.startsWith('room-gamble-private-')),
    'Calculated Gamble leaked its private draws to the teammate')
})

check('combat ledgers are public while retained-card history stays private', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === b.playerId)
  const outmaneuver = {
    uid: 'room-retained-outmaneuver', defId: 'outmaneuver', upgraded: false, retainedLastTurn: true,
  }
  Object.assign(actor, {
    hand: [outmaneuver], energy: 1, lostHpThisCombat: true,
    cardsPlayedThisTurn: 3, attacksPlayedThisTurn: 2,
  })

  const owner = snapshotFor(room, b.token).run.combat.players.find((player) => player.id === b.playerId)
  const teammate = snapshotFor(room, a.token).run.combat.players.find((player) => player.id === b.playerId)
  assertEqual(owner.hand[0].retainedLastTurn, true, 'the owner needs the flag to render the playable effect')
  assertEqual(teammate.hand, null, 'a teammate still cannot inspect the retained card')
  assert(!allStrings(snapshotFor(room, a.token)).includes(outmaneuver.uid), 'the retained card uid leaked')
  assertEqual(teammate.lostHpThisCombat, true)
  assertEqual(teammate.cardsPlayedThisTurn, 3)
  assertEqual(teammate.attacksPlayedThisTurn, 2)

  apply(room, b.token, { kind: 'playCard', cardUid: outmaneuver.uid, enemyUid: null, preflight: true })
  const discarded = snapshotFor(room, a.token).run.combat.players
    .find((player) => player.id === b.playerId).discard.at(-1)
  assertEqual(snapshotFor(room, a.token).run.combat.players
    .find((player) => player.id === b.playerId).cardsPlayedThisTurn, 4)
  assertEqual(discarded.uid, outmaneuver.uid, 'the played card becomes public in the discard pile')
  assert(!Object.hasOwn(discarded, 'retainedLastTurn'), 'public discard kept private hand history')
})

check('Silent Power modifiers resolve and publish through the room authority', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === b.playerId)
  const target = room.run.combat.enemies.find((enemy) => !enemy.dead)
  const cards = ['accuracy', 'footwork', 'envenom', 'choke'].map((defId) => ({
    uid: `room-${defId}`, defId, upgraded: true,
  }))
  Object.assign(actor, { hand: cards, energy: 6, shivs: 1, powers: [] })
  Object.assign(target, {
    defId: 'cultist', hp: 20, maxHp: 20, block: 0, weak: 1, poison: 2, abilityUsed: false, dead: false,
  })

  for (const defId of ['accuracy', 'footwork', 'envenom']) {
    apply(room, b.token, { kind: 'playCard', cardUid: `room-${defId}`, enemyUid: null, preflight: true })
  }
  apply(room, b.token, { kind: 'spendShiv', enemyUid: target.uid })
  apply(room, b.token, { kind: 'playCard', cardUid: 'room-choke', enemyUid: target.uid, preflight: true })

  const teammate = snapshotFor(room, a.token)
  const seenActor = teammate.run.combat.players.find((player) => player.id === b.playerId)
  const seenTarget = teammate.run.combat.enemies.find((enemy) => enemy.uid === target.uid)
  assertEqual(seenActor.shivDamageBonus, 1)
  assertEqual(seenActor.cardBlockBonus, 1)
  assertEqual(seenActor.hitPoison, 1)
  assertEqual(seenActor.powers.length, 3)
  assertEqual(seenTarget.hp, 10, 'Accuracy Shiv and token-scaled Choke+ deal 10 total')
  assertEqual(seenTarget.poison, 4, 'the Shiv and Choke+ hits each apply Poison')
})

check('Simmering Fury stays public across reconnect and resolves Wrath hits authoritatively', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const enemy = room.run.combat.enemies.find((target) => !target.dead)
  const fury = { uid: 'room-simmering-fury', defId: 'simmering_fury', upgraded: true }
  const crescendo = { uid: 'room-simmering-crescendo', defId: 'crescendo', upgraded: false }
  const sleeves = { uid: 'room-simmering-sleeves', defId: 'flying_sleeves', upgraded: false }
  Object.assign(actor, {
    character: 'watcher', hand: [fury, crescendo, sleeves], energy: 3, stance: 'neutral', powers: [],
  })
  Object.assign(enemy, {
    defId: 'cultist', hp: 30, maxHp: 30, block: 0, weak: 0, vulnerable: 0,
    abilityUsed: true, dead: false,
  })

  apply(room, a.token, { kind: 'playCard', cardUid: fury.uid, preflight: true })
  assertEqual(snapshotFor(room, b.token).run.combat.players
    .find((player) => player.id === a.playerId).wrathAttackDamageBonus, 2)
  markDisconnected(room, a.token)
  const rejoined = joinRoom(room, { token: a.token })
  apply(room, rejoined.token, { kind: 'playCard', cardUid: crescendo.uid, preflight: true })
  apply(room, rejoined.token, {
    kind: 'playCard', cardUid: sleeves.uid, enemyUid: enemy.uid, preflight: true,
  })
  assertEqual(room.run.combat.enemies.find((target) => target.uid === enemy.uid).hp, 22,
    'Flying Sleeves deals two four-damage hits in upgraded Simmering Fury Wrath')
})

check('Like Water resolves Calm Block through the shared end-turn authority', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const other = room.run.combat.players.find((player) => player.id === b.playerId)
  const power = { uid: 'room-like-water', defId: 'like_water', upgraded: true }
  Object.assign(actor, { hand: [], powers: [power], stance: 'calm', block: 0 })
  Object.assign(other, { hand: [], powers: [] })
  apply(room, a.token, { kind: 'endTurn' })
  apply(room, b.token, { kind: 'endTurn' })
  assertEqual(room.run.combat.players.find((player) => player.id === a.playerId).block, 2)
  assertEqual(snapshotFor(room, b.token).run.combat.players
    .find((player) => player.id === a.playerId).powers[0].defId, 'like_water')
})

check('Silent independent targets and once-per-turn Poison reactions survive room authority', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === b.playerId)
  const ally = room.run.combat.players.find((player) => player.id === a.playerId)
  const first = room.run.combat.enemies.find((enemy) => !enemy.dead)
  const second = { ...first, uid: 'room-bounce-second', row: first.row + 1, poison: 0, block: 0 }
  room.run.combat.enemies.push(second)
  const cards = [
    { uid: 'room-distraction', defId: 'distraction', upgraded: true },
    { uid: 'room-bouncing-flask', defId: 'bouncing_flask', upgraded: true },
    { uid: 'room-dodge-roll', defId: 'dodge_and_roll', upgraded: false },
    { uid: 'room-concentrate', defId: 'concentrate', upgraded: true },
    { uid: 'room-concentrate-a', defId: 'strike_silent', upgraded: false },
    { uid: 'room-concentrate-b', defId: 'defend_silent', upgraded: false },
  ]
  Object.assign(actor, { hand: cards, energy: 6, powers: [], block: 0 })
  ally.block = 0
  first.poison = 0

  apply(room, b.token, { kind: 'playCard', cardUid: 'room-distraction', preflight: true })
  apply(room, b.token, {
    kind: 'playCard', cardUid: 'room-bouncing-flask',
    enemyUids: [first.uid, second.uid, first.uid], preflight: true,
  })
  apply(room, b.token, {
    kind: 'playCard', cardUid: 'room-dodge-roll',
    playerIds: [a.playerId, b.playerId], preflight: true,
  })
  apply(room, b.token, {
    kind: 'playCard', cardUid: 'room-concentrate',
    discardUids: ['room-concentrate-a', 'room-concentrate-b'], preflight: true,
  })

  markDisconnected(room, a.token)
  joinRoom(room, { token: a.token })
  const seen = snapshotFor(room, a.token).run.combat
  const seenActor = seen.players.find((player) => player.id === b.playerId)
  const seenAlly = seen.players.find((player) => player.id === a.playerId)
  assertEqual(seenActor.block, 3, 'Distraction and one Dodge icon stack on the Silent')
  assertEqual(seenAlly.block, 1, 'the other Dodge icon reaches the chosen teammate')
  assertEqual(seenActor.energy, 5, 'Concentrate+ gains discarded count plus one')
  assertEqual(seen.enemies.find((enemy) => enemy.uid === first.uid).poison, 2)
  assertEqual(seen.enemies.find((enemy) => enemy.uid === second.uid).poison, 1)
  assert(seen.powerTriggersUsedThisTurn.includes(`${b.playerId}/power:room-distraction`),
    'reconnect lost the public once-per-turn ledger')
  assert(seenActor.exhaust.some((card) => card.uid === 'room-concentrate'), 'Concentrate did not Exhaust')
})

check('Concentrate can discard an online hand larger than the fixed choice cap', () => {
  const { room, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === b.playerId)
  const concentrate = { uid: 'room-big-concentrate', defId: 'concentrate', upgraded: false }
  const choices = Array.from({ length: UID_LIMIT + 1 }, (_unused, index) => ({
    uid: `room-big-discard-${index}`, defId: 'strike_silent', upgraded: false,
  }))
  Object.assign(actor, { hand: [concentrate, ...choices], energy: 3 })

  let oversized = null
  try {
    apply(room, b.token, {
      kind: 'playCard', cardUid: concentrate.uid,
      discardUids: [...choices.map((card) => card.uid), 'not-in-hand'], preflight: true,
    })
  } catch (error) {
    oversized = error
  }
  assertEqual(oversized?.name, 'RoomError', 'a list larger than the selectable hand is refused')

  apply(room, b.token, {
    kind: 'playCard', cardUid: concentrate.uid,
    discardUids: choices.map((card) => card.uid), preflight: true,
  })

  const resolved = room.run.combat.players.find((player) => player.id === b.playerId)
  assertEqual(resolved.hand.length, 0)
  assertEqual(resolved.discard.length, choices.length)
  assert(resolved.exhaust.some((card) => card.uid === concentrate.uid), 'Concentrate did not Exhaust')
})

check('Purity validates its optional Exhaust choices at room authority', () => {
  const { room, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === b.playerId)
  const purity = { uid: 'room-purity', defId: 'purity', upgraded: false }
  const choices = Array.from({ length: 4 }, (_unused, index) => ({
    uid: `room-purity-${index}`, defId: 'strike_ironclad', upgraded: false,
  }))
  Object.assign(actor, { hand: [purity, ...choices], energy: 3 })

  let oversized = null
  try {
    apply(room, b.token, {
      kind: 'playCard', cardUid: purity.uid,
      exhaustUids: choices.map((card) => card.uid), preflight: true,
    })
  } catch (error) {
    oversized = error
  }
  assertEqual(oversized?.name, 'RoomError', 'the base face accepted four Exhaust choices')
  assertEqual(actor.hand.length, 5, 'an invalid optional Exhaust partially resolved')

  apply(room, b.token, {
    kind: 'playCard', cardUid: purity.uid,
    exhaustUids: choices.slice(0, 2).map((card) => card.uid), preflight: true,
  })
  const resolved = room.run.combat.players.find((player) => player.id === b.playerId)
  assertDeepEqual(resolved.exhaust.map((card) => card.uid), [choices[0].uid, choices[1].uid, purity.uid])
  assertDeepEqual(resolved.hand.map((card) => card.uid), choices.slice(2).map((card) => card.uid))

  const { room: optionalRoom, b: optionalSeat } = twoSeatRoom()
  const optionalActor = optionalRoom.run.combat.players.find((player) => player.id === optionalSeat.playerId)
  const optionalPurity = { uid: 'room-purity-omitted', defId: 'purity', upgraded: false }
  const optionalSpare = { uid: 'room-purity-omitted-spare', defId: 'strike_ironclad', upgraded: false }
  Object.assign(optionalActor, { hand: [optionalPurity, optionalSpare], energy: 3 })
  apply(optionalRoom, optionalSeat.token, {
    kind: 'playCard', cardUid: optionalPurity.uid, preflight: true,
  })
  const optionalResolved = optionalRoom.run.combat.players.find((player) => player.id === optionalSeat.playerId)
  assertDeepEqual(optionalResolved.exhaust.map((card) => card.uid), [optionalPurity.uid],
    'omitting Purity choices should mean Exhaust none')
  assertDeepEqual(optionalResolved.hand.map((card) => card.uid), [optionalSpare.uid])
})

check('Sever Soul+ enforces its one-to-two Exhaust range at room authority', () => {
  const { room, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === b.playerId)
  const target = room.run.combat.enemies.find((enemy) => !enemy.dead)
  const sever = { uid: 'room-sever-soul', defId: 'sever_soul', upgraded: true }
  const choices = Array.from({ length: 2 }, (_unused, index) => ({
    uid: `room-sever-soul-${index}`, defId: 'defend_ironclad', upgraded: false,
  }))
  Object.assign(actor, { hand: [sever, ...choices], energy: 3 })
  Object.assign(target, { hp: 10, maxHp: 10, block: 0, dead: false })

  let missing = null
  try {
    apply(room, b.token, {
      kind: 'playCard', cardUid: sever.uid, enemyUid: target.uid, preflight: true,
    })
  } catch (error) {
    missing = error
  }
  assertEqual(missing?.name, 'RoomError', 'the room accepted no Exhaust choice')
  assertEqual(target.hp, 10, 'the invalid action partially damaged its target')

  apply(room, b.token, {
    kind: 'playCard', cardUid: sever.uid, enemyUid: target.uid,
    exhaustUids: choices.map((card) => card.uid), preflight: true,
  })
  const resolved = room.run.combat.players.find((player) => player.id === b.playerId)
  assertEqual(room.run.combat.enemies.find((enemy) => enemy.uid === target.uid).hp, 6)
  assertDeepEqual(resolved.exhaust.map((card) => card.uid), choices.map((card) => card.uid))
})

check('Second Wind and Sentinel resolve their Exhaust rules through room authority', () => {
  const { room, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === b.playerId)
  const wind = { uid: 'room-second-wind', defId: 'second_wind', upgraded: false }
  const sentinel = { uid: 'room-second-wind-sentinel', defId: 'sentinel', upgraded: false }
  const strike = { uid: 'room-second-wind-strike', defId: 'strike_ironclad', upgraded: false }
  Object.assign(actor, { hand: [wind, sentinel, strike], energy: 1, block: 0, exhaust: [], discard: [] })
  apply(room, b.token, { kind: 'playCard', cardUid: wind.uid, preflight: true })
  const resolved = room.run.combat.players.find((player) => player.id === b.playerId)
  assertEqual(resolved.block, 1)
  assertEqual(resolved.energy, 2)
  assertDeepEqual(resolved.hand.map((card) => card.uid), [strike.uid])
  assertDeepEqual(resolved.exhaust.map((card) => card.uid), [sentinel.uid])

  const { room: supportRoom, a: supportA, b: supportB } = twoSeatRoom()
  const supportActor = supportRoom.run.combat.players.find((player) => player.id === supportB.playerId)
  const supportAlly = supportRoom.run.combat.players.find((player) => player.id === supportA.playerId)
  const supportSentinel = { uid: 'room-sentinel-support', defId: 'sentinel', upgraded: true }
  Object.assign(supportActor, { hand: [supportSentinel], energy: 1 })
  supportAlly.block = 0
  apply(supportRoom, supportB.token, {
    kind: 'playCard', cardUid: supportSentinel.uid, playerId: supportAlly.id, preflight: true,
  })
  assertEqual(supportRoom.run.combat.players.find((player) => player.id === supportAlly.id).block, 3)
  assertEqual(supportRoom.run.combat.players.find((player) => player.id === supportActor.id).energy, 0,
    'playing Sentinel must not fire its Exhaust reaction')
})

check('Fiend Fire resolves its whole-hand multi-attack through room authority', () => {
  const { room, a } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const target = room.run.combat.enemies.find((enemy) => !enemy.dead)
  const fiend = { uid: 'room-fiend-fire', defId: 'fiend_fire', upgraded: false }
  const strike = { uid: 'room-fiend-fire-strike', defId: 'strike_ironclad', upgraded: false }
  const defend = { uid: 'room-fiend-fire-defend', defId: 'defend_ironclad', upgraded: false }
  Object.assign(actor, {
    hand: [fiend, strike, defend], energy: 2, strength: 1, weak: 0, discard: [], exhaust: [],
  })
  Object.assign(target, { hp: 20, maxHp: 20, block: 0, dead: false, abilityUsed: true })

  apply(room, a.token, {
    kind: 'playCard', cardUid: fiend.uid, enemyUid: target.uid, preflight: true,
  })
  const resolved = room.run.combat.players.find((player) => player.id === a.playerId)
  assertEqual(resolved.strength, 1, 'the fixture lost its Strength before Fiend Fire resolved')
  assertEqual(room.run.combat.enemies.find((enemy) => enemy.uid === target.uid).hp, 16)
  assertDeepEqual(resolved.hand, [])
  assertDeepEqual(resolved.exhaust.map((card) => card.uid), [strike.uid, defend.uid, fiend.uid])
  assertEqual(resolved.energy, 0)
})

check('Corruption discounts and Exhausts only its owner\'s Skills at room authority', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const defend = { uid: 'room-corruption-defend', defId: 'defend_ironclad', upgraded: false }
  Object.assign(actor, {
    hand: [defend], energy: 0, block: 0, discard: [], exhaust: [],
    powers: [{ uid: 'room-corruption', defId: 'corruption', upgraded: false }],
  })
  apply(room, a.token, { kind: 'playCard', cardUid: defend.uid, preflight: true })
  const resolved = room.run.combat.players.find((player) => player.id === a.playerId)
  assertEqual(resolved.block, 1)
  assertEqual(resolved.energy, 0)
  assertDeepEqual(resolved.exhaust.map((card) => card.uid), [defend.uid])

  const allyDefend = { uid: 'room-corruption-ally-defend', defId: 'defend_silent', upgraded: false }
  const ally = room.run.combat.players.find((player) => player.id === b.playerId)
  Object.assign(ally, { hand: [allyDefend], energy: 1, block: 0, discard: [], exhaust: [] })
  apply(room, b.token, { kind: 'playCard', cardUid: allyDefend.uid, preflight: true })
  const allyResolved = room.run.combat.players.find((player) => player.id === b.playerId)
  assertEqual(allyResolved.energy, 0)
  assertDeepEqual(allyResolved.discard.map((card) => card.uid), [allyDefend.uid])
  assertDeepEqual(allyResolved.exhaust, [])
})

check('Barricade preserves only its owner\'s Block through room-authoritative Start of Turn', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const ally = room.run.combat.players.find((player) => player.id === b.playerId)
  Object.assign(room.run.combat, { phase: 'roundEnd', turn: 1 })
  Object.assign(actor, { block: 7, powers: [{ uid: 'room-barricade', defId: 'barricade', upgraded: false }] })
  Object.assign(ally, { block: 6, powers: [] })
  apply(room, a.token, { kind: 'startTurn' })
  const started = snapshotFor(room, a.token).run.combat
  assertEqual(started.phase, 'player', 'Barricade must not create a no-op ordered ability')
  assertDeepEqual(started.players.map((player) => player.block), [7, 0])
})

check('Entrench doubles Block and removes Exhaust on upgrade through room authority', () => {
  const { room, a } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const base = { uid: 'room-entrench', defId: 'entrench', upgraded: false }
  const upgraded = { uid: 'room-entrench-plus', defId: 'entrench', upgraded: true }
  Object.assign(actor, { hand: [base, upgraded], energy: 2, block: 6, discard: [], exhaust: [] })
  apply(room, a.token, { kind: 'playCard', cardUid: base.uid, preflight: true })
  apply(room, a.token, { kind: 'playCard', cardUid: upgraded.uid, preflight: true })
  const resolved = room.run.combat.players.find((player) => player.id === a.playerId)
  assertEqual(resolved.block, 20)
  assertDeepEqual(resolved.exhaust.map((card) => card.uid), [base.uid])
  assertDeepEqual(resolved.discard.map((card) => card.uid), [upgraded.uid])
})

check('Clash enforces its hand restriction through room authority', () => {
  const { room, a } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const target = room.run.combat.enemies.find((enemy) => !enemy.dead)
  const clash = { uid: 'room-clash', defId: 'clash', upgraded: true }
  const defend = { uid: 'room-clash-defend', defId: 'defend_ironclad', upgraded: false }
  Object.assign(actor, { hand: [clash, defend], energy: 0, discard: [] })
  Object.assign(target, { hp: 10, maxHp: 10, block: 0, dead: false })
  const hp = target.hp
  let refused = false
  try {
    apply(room, a.token, { kind: 'playCard', cardUid: clash.uid, enemyUid: target.uid, preflight: true })
  } catch {
    refused = true
  }
  assert(refused, 'room authority accepted Clash while a Skill remained in hand')
  assertEqual(target.hp, hp)
  assertDeepEqual(actor.hand.map((card) => card.uid), [clash.uid, defend.uid])

  const currentActor = room.run.combat.players.find((player) => player.id === a.playerId)
  const currentTarget = room.run.combat.enemies.find((enemy) => enemy.uid === target.uid)
  currentActor.hand = [clash, { uid: 'room-clash-strike', defId: 'strike_ironclad', upgraded: false }]
  apply(room, a.token, { kind: 'playCard', cardUid: clash.uid, enemyUid: currentTarget.uid, preflight: true })
  const resolved = room.run.combat
  assertEqual(resolved.enemies.find((enemy) => enemy.uid === target.uid).hp, hp - 4)
  assertDeepEqual(resolved.players.find((player) => player.id === a.playerId).discard.map((card) => card.uid), [clash.uid])
})

check('Spot Weakness applies its upgraded die face to an ally through room authority', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const ally = room.run.combat.players.find((player) => player.id === b.playerId)
  const spot = { uid: 'room-spot-weakness', defId: 'spot_weakness', upgraded: true }
  Object.assign(room.run.combat, { die: 4 })
  Object.assign(actor, { hand: [spot], energy: 1, discard: [] })
  ally.strength = 0
  apply(room, a.token, {
    kind: 'playCard', cardUid: spot.uid, playerId: b.playerId, preflight: true,
  })
  const resolved = room.run.combat
  assertEqual(resolved.players.find((player) => player.id === b.playerId).strength, 1)
  assertDeepEqual(resolved.players.find((player) => player.id === a.playerId).discard.map((card) => card.uid), [spot.uid])
})

check('Rage counts only its owner\'s Attacks through room authority', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const ally = room.run.combat.players.find((player) => player.id === b.playerId)
  const rage = { uid: 'room-rage', defId: 'rage', upgraded: true }
  Object.assign(actor, {
    hand: [
      rage,
      { uid: 'room-rage-a', defId: 'strike_ironclad', upgraded: false },
      { uid: 'room-rage-b', defId: 'clash', upgraded: false },
      { uid: 'room-rage-skill', defId: 'defend_ironclad', upgraded: false },
    ],
    energy: 0, block: 0,
  })
  ally.hand = [{ uid: 'room-rage-ally-attack', defId: 'strike_silent', upgraded: false }]
  apply(room, a.token, { kind: 'playCard', cardUid: rage.uid, preflight: true })
  const resolved = room.run.combat.players.find((player) => player.id === a.playerId)
  assertEqual(resolved.block, 2)
  assertEqual(resolved.energy, 0)
})

check('Whirlwind keeps X Energy and row damage authoritative online', () => {
  const { room, a } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const anchor = room.run.combat.enemies.find((enemy) => !enemy.dead)
  const whirlwind = { uid: 'room-whirlwind', defId: 'whirlwind', upgraded: true }
  Object.assign(actor, { hand: [whirlwind], energy: 3, discard: [] })
  Object.assign(anchor, {
    defId: 'cultist', row: 0, hp: 10, maxHp: 10, block: 0, abilityUsed: true, dead: false,
  })
  room.run.combat.enemies.push(
    { ...anchor, uid: 'room-whirlwind-same', hp: 10 },
    { ...anchor, uid: 'room-whirlwind-other', row: 1, hp: 10 },
    { ...anchor, uid: 'room-whirlwind-boss', row: 1, isBoss: true, hp: 10 },
  )
  const before = JSON.stringify(room.run)
  for (const energySpent of [undefined, '2', -1, 4]) {
    let refused = false
    try {
      apply(room, a.token, {
        kind: 'playCard', cardUid: whirlwind.uid, enemyUid: anchor.uid,
        energySpent, preflight: true,
      })
    } catch {
      refused = true
    }
    assert(refused, `room accepted forged X Energy ${String(energySpent)}`)
    assertEqual(JSON.stringify(room.run), before, 'a refused X play partially changed the run')
  }
  apply(room, a.token, {
    kind: 'playCard', cardUid: whirlwind.uid, enemyUid: anchor.uid,
    energySpent: 2, preflight: true,
  })
  const resolved = room.run.combat
  assertDeepEqual([
    anchor.uid, 'room-whirlwind-same', 'room-whirlwind-other', 'room-whirlwind-boss',
  ].map((uid) => resolved.enemies.find((enemy) => enemy.uid === uid).hp), [7, 7, 10, 7])
  assertEqual(resolved.players.find((player) => player.id === a.playerId).energy, 1)
})

check('Blood for Blood uses the owner\'s combat-wide HP-loss discount through room authority', () => {
  const { room, a } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const target = room.run.combat.enemies.find((enemy) => !enemy.dead)
  const blood = { uid: 'room-blood-for-blood', defId: 'blood_for_blood', upgraded: true }
  Object.assign(actor, { hand: [blood], energy: 0, lostHpThisCombat: true })
  Object.assign(target, { hp: 10, maxHp: 10, block: 0, dead: false })
  apply(room, a.token, {
    kind: 'playCard', cardUid: blood.uid, enemyUid: target.uid, preflight: true,
  })
  const resolved = room.run.combat
  assertEqual(resolved.enemies.find((enemy) => enemy.uid === target.uid).hp, 6)
  assertEqual(resolved.players.find((player) => player.id === a.playerId).energy, 0)
})

check('Limit Break doubles only its owner\'s Strength through room authority', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const ally = room.run.combat.players.find((player) => player.id === b.playerId)
  const limit = { uid: 'room-limit-break', defId: 'limit_break', upgraded: true }
  Object.assign(actor, { hand: [limit], energy: 1, strength: 5, discard: [], exhaust: [] })
  ally.strength = 2
  apply(room, a.token, { kind: 'playCard', cardUid: limit.uid, preflight: true })
  const resolved = room.run.combat.players
  assertEqual(resolved.find((player) => player.id === a.playerId).strength, 8)
  assertEqual(resolved.find((player) => player.id === b.playerId).strength, 2)
  assertDeepEqual(resolved.find((player) => player.id === a.playerId).discard.map((card) => card.uid), [limit.uid])
})

check('Feed grants kill Strength through room authority', () => {
  const { room, a } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const target = room.run.combat.enemies.find((enemy) => !enemy.dead)
  const feed = { uid: 'room-feed', defId: 'feed', upgraded: true }
  room.run.combat.enemies.push({ ...target, uid: 'room-feed-spare', row: target.row + 1, hp: 10, maxHp: 10 })
  Object.assign(actor, { hand: [feed], energy: 1, strength: 7, discard: [], exhaust: [] })
  Object.assign(target, { hp: 3, maxHp: 3, block: 0, dead: false })
  apply(room, a.token, { kind: 'playCard', cardUid: feed.uid, enemyUid: target.uid, preflight: true })
  const resolved = room.run.combat.players.find((player) => player.id === a.playerId)
  assertEqual(resolved.strength, 8)
  assertDeepEqual(resolved.exhaust.map((card) => card.uid), [feed.uid])
})

check('Storm of Steel overflow resolves through room authority', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === b.playerId)
  const ally = room.run.combat.players.find((player) => player.id === a.playerId)
  const enemies = room.run.combat.enemies.slice(0, 2)
  if (enemies.length < 2) {
    enemies.push({ ...enemies[0], uid: 'room-storm-second', row: enemies[0].row + 1 })
    room.run.combat.enemies.push(enemies[1])
  }
  Object.assign(enemies[0], { hp: 5, maxHp: 5, block: 0, dead: false, abilityUsed: true })
  Object.assign(enemies[1], { hp: 5, maxHp: 5, block: 0, dead: false, abilityUsed: true })
  const fodder = [
    { uid: 'room-storm-a', defId: 'strike_silent', upgraded: false },
    { uid: 'room-storm-b', defId: 'defend_silent', upgraded: false },
  ]
  Object.assign(actor, {
    hand: [
      { uid: 'room-storm', defId: 'storm_of_steel', upgraded: true },
      ...fodder,
    ],
    energy: 6,
    shivs: 4,
  })
  ally.shivs = 1

  apply(room, b.token, {
    kind: 'playCard', cardUid: 'room-storm', discardUids: fodder.map((card) => card.uid),
    expectedShivOverflow: 3, shivEnemyUids: [enemies[0].uid, enemies[1].uid, enemies[0].uid],
    preflight: true,
  })
  assertDeepEqual(room.run.combat.enemies.slice(0, 2).map((enemy) => enemy.hp), [3, 4])
})

check('Storm of Steel can target more overflow Shivs than the fixed choice cap', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === b.playerId)
  const ally = room.run.combat.players.find((player) => player.id === a.playerId)
  const target = room.run.combat.enemies[0]
  const choices = Array.from({ length: UID_LIMIT + 1 }, (_unused, index) => ({
    uid: `room-storm-many-${index}`, defId: 'strike_silent', upgraded: false,
  }))
  Object.assign(actor, {
    hand: [{ uid: 'room-storm-many', defId: 'storm_of_steel', upgraded: false }, ...choices],
    energy: 3,
    shivs: 4,
  })
  ally.shivs = 1
  Object.assign(target, {
    defId: 'cultist', hp: 50, maxHp: 50, block: 0, dead: false, abilityUsed: true,
  })

  apply(room, b.token, {
    kind: 'playCard', cardUid: 'room-storm-many',
    discardUids: choices.map((card) => card.uid),
    expectedShivOverflow: choices.length,
    shivEnemyUids: choices.map(() => target.uid),
    preflight: true,
  })

  assertEqual(room.run.combat.enemies[0].hp, 50 - choices.length)
})

check('Unload keeps every mandatory Shiv target authoritative across reconnect snapshots', () => {
  const { room, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === b.playerId)
  const [first, second] = room.run.combat.enemies
  Object.assign(actor, {
    hand: [{ uid: 'room-unload', defId: 'unload', upgraded: false }],
    energy: 3,
    shivs: 2,
  })
  Object.assign(first, { hp: 20, maxHp: 20, block: 0, dead: false, abilityUsed: true })
  Object.assign(second, { hp: 20, maxHp: 20, block: 0, dead: false, abilityUsed: true })

  let missing = null
  try {
    apply(room, b.token, {
      kind: 'playCard', cardUid: 'room-unload', enemyUid: first.uid,
      shivEnemyUids: [first.uid], preflight: true,
    })
  } catch (error) {
    missing = error
  }
  assertEqual(missing?.name, 'RoomError', 'a client cannot omit a held Shiv attack')

  apply(room, b.token, {
    kind: 'playCard', cardUid: 'room-unload', enemyUid: first.uid,
    shivEnemyUids: [first.uid, second.uid], preflight: true,
  })
  const snapshot = snapshotFor(room, b.token)
  const mine = snapshot.run.combat.players.find((player) => player.id === b.playerId)
  assertDeepEqual(snapshot.run.combat.enemies.slice(0, 2).map((enemy) => enemy.hp), [16, 18])
  assertEqual(mine.shivs, 0)
  assertEqual(mine.attacksPlayedThisTurn, 3)
})

check('Infinite Blades pauses Start of Turn for authoritative overflow choices', () => {
  const { room, a, b } = twoSeatRoom()
  const ann = room.run.combat.players.find((player) => player.id === a.playerId)
  const bo = room.run.combat.players.find((player) => player.id === b.playerId)
  Object.assign(room.run.combat, { phase: 'roundEnd', turn: 1 })
  Object.assign(ann, { shivs: 3, draw: Array.from({ length: 5 }, (_, index) => ({
    uid: `room-infinite-ann-${index}`, defId: 'defend_ironclad', upgraded: false,
  })) })
  Object.assign(bo, {
    shivs: 2,
    powers: [{ uid: 'room-infinite', defId: 'infinite_blades', upgraded: true }],
    draw: Array.from({ length: 5 }, (_, index) => ({
      uid: `room-infinite-bo-${index}`, defId: 'defend_silent', upgraded: false,
    })),
  })
  for (const enemy of room.run.combat.enemies) {
    Object.assign(enemy, { hp: 20, maxHp: 20, block: 0, dead: false, abilityUsed: true })
  }

  apply(room, a.token, { kind: 'startTurn' })
  const pending = snapshotFor(room, b.token)
  assertEqual(pending.run.combat.phase, 'start')
  assertEqual(pending.startTurnAbilities.length, 1)
  assertEqual(pending.startTurnAbilities[0].overflowShivs, 2)
  assertEqual(pending.startTurnCoordinatorId, b.playerId,
    'the owner of the overflow Shiv choice should coordinate it')

  let unauthorized = null
  try {
    apply(room, a.token, {
      kind: 'resolveStartTurn',
      choices: [{ id: pending.startTurnAbilities[0].id, shivEnemyUids: [null, null] }],
    })
  } catch (error) {
    unauthorized = error
  }
  assertEqual(unauthorized?.name, 'RoomError', 'a non-coordinator cannot resolve everyone\'s order')

  markDisconnected(room, b.token)
  const transferred = snapshotFor(room, a.token)
  assertEqual(transferred.startTurnCoordinatorId, a.playerId, 'disconnect transfers the pending coordinator')
  const [first, second] = room.run.combat.enemies
  first.hp = 1
  let staleTarget = null
  try {
    apply(room, a.token, {
      kind: 'resolveStartTurn',
      choices: [{
        id: transferred.startTurnAbilities[0].id,
        shivEnemyUids: [first.uid, first.uid],
      }],
    })
  } catch (error) {
    staleTarget = error
  }
  assertEqual(staleTarget?.name, 'RoomError', 'a queued Shiv cannot hit an enemy killed by the prior Shiv')
  assertDeepEqual(room.run.combat.enemies.slice(0, 2).map((enemy) => enemy.hp), [1, 20],
    'a stale overflow target partially mutated the authoritative combat')
  apply(room, a.token, {
    kind: 'resolveStartTurn',
    choices: [{
      id: transferred.startTurnAbilities[0].id,
      shivEnemyUids: [first.uid, second.uid],
    }],
  })
  const resolved = snapshotFor(room, b.token)
  assertEqual(resolved.run.combat.phase, 'player')
  assertDeepEqual(resolved.run.combat.enemies.slice(0, 2).map((enemy) => enemy.hp), [0, 19])
  assertEqual(resolved.run.combat.players.find((player) => player.id === b.playerId).attacksPlayedThisTurn, 2)
  assertEqual(resolved.startTurnAbilities, undefined)
})

check('Noxious Fumes keeps its Start-of-Turn enemy target authoritative', () => {
  const { room, a, b } = twoSeatRoom()
  const ann = room.run.combat.players.find((player) => player.id === a.playerId)
  const silent = room.run.combat.players.find((player) => player.id === b.playerId)
  Object.assign(room.run.combat, { phase: 'roundEnd', turn: 1 })
  Object.assign(ann, {
    shivs: 5,
    powers: [
      { uid: 'room-earlier-infinite', defId: 'infinite_blades', upgraded: false },
      { uid: 'room-later-infinite', defId: 'infinite_blades', upgraded: false },
    ],
    draw: Array.from({ length: 5 }, (_, index) => ({
      uid: `room-earlier-${index}`, defId: 'defend_ironclad', upgraded: false,
    })),
  })
  Object.assign(silent, {
    powers: [{ uid: 'room-noxious', defId: 'noxious_fumes', upgraded: false }],
    draw: Array.from({ length: 5 }, (_, index) => ({
      uid: `room-noxious-${index}`, defId: 'defend_ironclad', upgraded: false,
    })),
  })
  room.run.combat.enemies.push({
    ...room.run.combat.enemies[0], uid: 'room-noxious-extra', row: 3,
  })
  room.run.combat.enemies.push({
    ...room.run.combat.enemies[0], uid: 'room-noxious-fallback', row: 4,
  })
  for (const enemy of room.run.combat.enemies) {
    Object.assign(enemy, { hp: 20, maxHp: 20, poison: 0, dead: false, abilityUsed: true })
  }

  apply(room, a.token, { kind: 'startTurn' })
  const pending = snapshotFor(room, a.token)
  const earlier = pending.startTurnAbilities.find((entry) => entry.id.includes('room-earlier-infinite'))
  const later = pending.startTurnAbilities.find((entry) => entry.id.includes('room-later-infinite'))
  const ability = pending.startTurnAbilities.find((entry) => entry.label.includes('Noxious Fumes'))
  assertEqual(pending.run.combat.phase, 'start')
  assertEqual(ability.targets.length, room.run.combat.enemies.length)
  assertEqual(pending.startTurnCoordinatorId, a.playerId,
    'the ordinary coordinator should commit the combined order before Silent targets Noxious Fumes')
  assertEqual(pending.startTurnOrderPending, true)
  assertEqual(pending.startTurnChoiceId, ability.id)
  const [stale, chosen, alternate, fallback] = room.run.combat.enemies
  Object.assign(stale, { hp: 0, dead: true })
  let stolenOrder = null
  try {
    apply(room, b.token, {
      kind: 'resolveStartTurn',
      choices: [
        { id: ability.id, enemyUid: chosen.uid, shivEnemyUids: [] },
        { id: earlier.id, shivEnemyUids: [null] },
        { id: later.id, shivEnemyUids: [null] },
      ],
    })
  } catch (error) {
    stolenOrder = error
  }
  assertEqual(stolenOrder?.name, 'RoomError', 'the Noxious Fumes owner commandeered the table order')
  const versionBeforeInvalidPrefix = room.version
  let invalidPrefix = null
  try {
    apply(room, a.token, {
      kind: 'resolveStartTurn',
      choices: [
        {
          id: earlier.id,
          enemyUid: chosen.uid,
          targetPlayerId: a.playerId,
          shivEnemyUids: [null, null],
          evokeSlots: [0],
          evokeEnemyUids: [null],
        },
        { id: ability.id, shivEnemyUids: [] },
        { id: later.id, shivEnemyUids: [null] },
      ],
    })
  } catch (error) {
    invalidPrefix = error
  }
  assertEqual(invalidPrefix?.name, 'RoomError', 'an illegal pre-Noxious choice was staged')
  assertEqual(room.version, versionBeforeInvalidPrefix, 'a rejected prefix changed the room version')
  assertEqual(room.startTurnCombatId, undefined)
  assertEqual(room.startTurnOrder, undefined)
  assertEqual(room.startTurnEnemyTargets, undefined)
  assertEqual(room.startTurnChoices, undefined, 'a rejected prefix partially mutated staged choices')
  apply(room, a.token, {
    kind: 'resolveStartTurn',
    choices: [
      { id: earlier.id, shivEnemyUids: [chosen.uid] },
      { id: ability.id, shivEnemyUids: [] },
      { id: later.id, shivEnemyUids: [null] },
    ],
  })
  const targetStage = snapshotFor(room, b.token)
  assertEqual(targetStage.startTurnCoordinatorId, b.playerId)
  assertEqual(targetStage.startTurnOrderLocked, true)
  assertEqual(targetStage.startTurnChoiceId, ability.id)
  assertDeepEqual(targetStage.startTurnAbilities.map((entry) => entry.id), [earlier.id, ability.id, later.id],
    'the coordinator\'s committed order was not preserved for the target owner')
  let reorderedTarget = null
  try {
    apply(room, b.token, {
      kind: 'resolveStartTurn',
      choices: [
        { id: ability.id, enemyUid: chosen.uid, shivEnemyUids: [] },
        { id: earlier.id, shivEnemyUids: [null] },
        { id: later.id, shivEnemyUids: [null] },
      ],
    })
  } catch (error) {
    reorderedTarget = error
  }
  assertEqual(reorderedTarget?.name, 'RoomError', 'the target owner changed the committed table order')
  let staleChoice = null
  try {
    apply(room, b.token, {
      kind: 'resolveStartTurn',
      choices: [
        { id: earlier.id, shivEnemyUids: [chosen.uid] },
        { id: ability.id, enemyUid: stale.uid, shivEnemyUids: [] },
        { id: later.id, shivEnemyUids: [null] },
      ],
    })
  } catch (error) {
    staleChoice = error
  }
  assertEqual(staleChoice?.name, 'RoomError', 'a dead Noxious Fumes target was accepted')
  assertEqual(chosen.poison, 0, 'a stale target partially resolved the Power')
  apply(room, b.token, {
    kind: 'resolveStartTurn',
    choices: [
      { id: earlier.id, shivEnemyUids: [chosen.uid] },
      { id: ability.id, enemyUid: chosen.uid, shivEnemyUids: [] },
      { id: later.id, shivEnemyUids: [null] },
    ],
  })
  const staged = snapshotFor(room, a.token)
  assertEqual(staged.run.combat.phase, 'start')
  assertEqual(staged.startTurnEnemyTargets[ability.id], chosen.uid,
    'the Silent target was not preserved for the combined order')
  assertEqual(staged.startTurnCoordinatorId, a.playerId,
    'the earlier Infinite Blades owner should resolve the remaining order')
  chosen.hp = 1
  const reopened = snapshotFor(room, b.token)
  assertEqual(reopened.run.combat.phase, 'start')
  assertEqual(reopened.startTurnCoordinatorId, b.playerId)
  assertEqual(reopened.startTurnChoiceId, ability.id)
  assertDeepEqual(reopened.startTurnEnemyTargets, {},
    'a Noxious target invalidated by an earlier committed choice was not reopened')
  apply(room, b.token, {
    kind: 'resolveStartTurn',
    choices: [
      { id: earlier.id, shivEnemyUids: [chosen.uid] },
      { id: ability.id, enemyUid: alternate.uid, shivEnemyUids: [] },
      { id: later.id, shivEnemyUids: [null] },
    ],
  })
  apply(room, a.token, {
    kind: 'resolveStartTurn',
    choices: [
      { id: earlier.id, shivEnemyUids: [chosen.uid] },
      { id: ability.id, enemyUid: chosen.uid, shivEnemyUids: [] },
      { id: later.id, shivEnemyUids: [null] },
    ],
  })
  assertEqual(room.run.combat.phase, 'player')
  assertEqual(room.run.combat.enemies.find((enemy) => enemy.uid === chosen.uid).poison, 0)
  assertEqual(room.run.combat.enemies.find((enemy) => enemy.uid === alternate.uid).poison, 1,
    'the coordinator replaced the Silent\'s Noxious Fumes target')
  assertEqual(room.run.combat.enemies.find((enemy) => enemy.uid === fallback.uid).poison, 0)
})

check('Noxious Fumes can target a Darkling revived earlier in the chosen order', () => {
  const { room, a, b } = twoSeatRoom()
  const ann = room.run.combat.players.find((player) => player.id === a.playerId)
  const silent = room.run.combat.players.find((player) => player.id === b.playerId)
  Object.assign(room.run.combat, { phase: 'roundEnd', turn: 1 })
  Object.assign(ann, {
    shivs: 5,
    powers: [{ uid: 'room-regrow-infinite', defId: 'infinite_blades', upgraded: false }],
    draw: Array.from({ length: 5 }, (_, index) => ({
      uid: `room-regrow-ann-${index}`, defId: 'defend_ironclad', upgraded: false,
    })),
  })
  Object.assign(silent, {
    powers: [{ uid: 'room-regrow-fumes', defId: 'noxious_fumes', upgraded: false }],
    draw: Array.from({ length: 5 }, (_, index) => ({
      uid: `room-regrow-draw-${index}`, defId: 'defend_silent', upgraded: false,
    })),
  })
  const base = room.run.combat.enemies[0]
  room.run.combat.enemies = [
    { ...base, uid: 'room-regrow-living', defId: 'darkling', row: 0, hp: 8, maxHp: 8, dead: false },
    { ...base, uid: 'room-regrow-revived', defId: 'darkling_bha', row: 1, hp: 0, maxHp: 8, dead: true },
  ]

  apply(room, a.token, { kind: 'startTurn' })
  const pending = snapshotFor(room, a.token)
  const fumes = pending.startTurnAbilities.find((ability) => ability.id.includes('room-regrow-fumes'))
  const regrow = pending.startTurnAbilities.find((ability) => ability.id === 'enemy:darkling/regrow')
  const infinite = pending.startTurnAbilities.find((ability) => ability.id.includes('room-regrow-infinite'))
  assertEqual(pending.startTurnCoordinatorId, a.playerId)
  assertEqual(pending.startTurnOrderPending, true)
  apply(room, a.token, {
    kind: 'resolveStartTurn',
    choices: [
      { id: infinite.id, shivEnemyUids: [null] },
      { id: regrow.id, shivEnemyUids: [] },
      { id: fumes.id, enemyUid: 'room-regrow-revived', shivEnemyUids: [] },
    ],
  })
  const targetStage = snapshotFor(room, b.token)
  assertEqual(targetStage.startTurnCoordinatorId, b.playerId)
  assertEqual(targetStage.startTurnChoiceId, fumes.id)
  assertDeepEqual(targetStage.startTurnEnemyTargets, {},
    'the order coordinator supplied the Silent-owned Noxious target')
  assertDeepEqual(targetStage.startTurnChoices.map((choice) => choice.id), [infinite.id, regrow.id],
    'choices before Noxious Fumes were not preserved with the committed order')
  assert(targetStage.startTurnAbilities.find((ability) => ability.id === fumes.id)
    .targets.some((target) => target.uid === 'room-regrow-revived'))
  apply(room, b.token, {
    kind: 'resolveStartTurn',
    choices: [
      { id: infinite.id, shivEnemyUids: [null] },
      { id: regrow.id, shivEnemyUids: [] },
      { id: fumes.id, enemyUid: 'room-regrow-revived', shivEnemyUids: [] },
    ],
  })
  assertEqual(room.run.combat.phase, 'player')
  assertEqual(room.run.combat.enemies.find((enemy) => enemy.uid === 'room-regrow-revived').poison, 1)
})

check('an invalid pre-Noxious Frost target leaves the staged plan untouched', () => {
  const { room, a, b } = twoSeatRoom()
  const defect = room.run.combat.players.find((player) => player.id === a.playerId)
  const silent = room.run.combat.players.find((player) => player.id === b.playerId)
  Object.assign(room.run.combat, { phase: 'roundEnd', turn: 1 })
  Object.assign(defect, {
    character: 'defect',
    powers: [{ uid: 'room-frost-storm', defId: 'storm', upgraded: false }],
    orbs: ['frost', 'lightning', 'dark'],
    draw: Array.from({ length: 5 }, (_, index) => ({
      uid: `room-frost-draw-${index}`, defId: 'defend_defect', upgraded: false,
    })),
  })
  Object.assign(silent, {
    powers: [{ uid: 'room-frost-fumes', defId: 'noxious_fumes', upgraded: false }],
    draw: Array.from({ length: 5 }, (_, index) => ({
      uid: `room-frost-silent-${index}`, defId: 'defend_silent', upgraded: false,
    })),
  })
  room.run.combat.enemies.push({ ...room.run.combat.enemies[0], uid: 'room-frost-extra', row: 3 })
  for (const enemy of room.run.combat.enemies) {
    Object.assign(enemy, { hp: 20, maxHp: 20, dead: false, abilityUsed: true })
  }

  apply(room, a.token, { kind: 'startTurn' })
  const pending = snapshotFor(room, a.token)
  const storm = pending.startTurnAbilities.find((ability) => ability.id.includes('room-frost-storm'))
  const fumes = pending.startTurnAbilities.find((ability) => ability.id.includes('room-frost-fumes'))
  const version = room.version
  let refused = null
  try {
    apply(room, a.token, {
      kind: 'resolveStartTurn',
      choices: [
        {
          id: storm.id,
          shivEnemyUids: [],
          evokeSlots: [0],
          evokeEnemyUids: [room.run.combat.enemies[0].uid],
        },
        { id: fumes.id, shivEnemyUids: [] },
      ],
    })
  } catch (error) {
    refused = error
  }
  assertEqual(refused?.name, 'RoomError', 'a Frost evoke accepted an enemy target')
  assertEqual(room.version, version, 'a rejected Frost target changed the room version')
  assertEqual(room.startTurnCombatId, undefined)
  assertEqual(room.startTurnOrder, undefined)
  assertEqual(room.startTurnEnemyTargets, undefined)
  assertEqual(room.startTurnChoices, undefined, 'a rejected Frost target partially staged a plan')
})

check('a legal start-phase die change rebuilds a staged Noxious Fumes plan', () => {
  const { room, a, b } = twoSeatRoom()
  const ann = room.run.combat.players.find((player) => player.id === a.playerId)
  const silent = room.run.combat.players.find((player) => player.id === b.playerId)
  Object.assign(room.run.combat, { phase: 'roundEnd', turn: 1 })
  Object.assign(ann, {
    shivs: 5,
    powers: [{ uid: 'room-reroll-infinite', defId: 'infinite_blades', upgraded: false }],
    relics: [
      { defId: 'the_abacus', spent: false },
      { defId: 'captains_wheel', spent: false },
    ],
    draw: Array.from({ length: 5 }, (_, index) => ({
      uid: `room-reroll-ann-${index}`, defId: 'defend_ironclad', upgraded: false,
    })),
  })
  Object.assign(silent, {
    powers: [{ uid: 'room-reroll-fumes', defId: 'noxious_fumes', upgraded: false }],
    draw: Array.from({ length: 5 }, (_, index) => ({
      uid: `room-reroll-bo-${index}`, defId: 'defend_silent', upgraded: false,
    })),
  })
  room.run.combat.enemies.push({ ...room.run.combat.enemies[0], uid: 'room-reroll-extra', row: 3 })
  const choices = (snapshot) => snapshot.startTurnAbilities.map((ability) => ({
    id: ability.id,
    enemyUid: ability.targets?.[0]?.uid,
    targetPlayerId: ability.players?.[0]?.id,
    shivEnemyUids: Array(ability.overflowShivs).fill(null),
    evokeSlots: [],
    evokeEnemyUids: [],
  }))

  apply(room, a.token, { kind: 'startTurn' })
  room.run.combat.die = 2
  const initial = snapshotFor(room, a.token)
  apply(room, a.token, { kind: 'resolveStartTurn', choices: choices(initial) })
  assertEqual(snapshotFor(room, b.token).startTurnOrderLocked, true)

  apply(room, a.token, { kind: 'activateRelic', relicIndex: 0 })
  const rebuilt = snapshotFor(room, a.token)
  assertEqual(room.run.combat.die, 3)
  assertEqual(rebuilt.startTurnOrderLocked, false, 'the stale pre-reroll order stayed locked')
  assertEqual(rebuilt.startTurnOrderPending, true)
  assert(rebuilt.startTurnAbilities.some((ability) => ability.label.includes("Captain's Wheel")),
    'the rerolled die ability was absent from the rebuilt plan')

  apply(room, a.token, { kind: 'resolveStartTurn', choices: choices(rebuilt) })
  const targetStage = snapshotFor(room, b.token)
  apply(room, b.token, { kind: 'resolveStartTurn', choices: choices(targetStage) })
  assertEqual(room.run.combat.phase, 'player', 'the rebuilt start-turn plan could not resolve')
})

check('a rejected Noxious Fumes plan commits no target or cross-combat state', () => {
  const { room, a, b } = twoSeatRoom()
  const silent = room.run.combat.players.find((player) => player.id === b.playerId)
  Object.assign(room.run.combat, { phase: 'roundEnd', turn: 1 })
  Object.assign(silent, {
    powers: [
      { uid: 'room-atomic-fumes', defId: 'noxious_fumes', upgraded: false },
      { uid: 'room-atomic-demon', defId: 'demon_form', upgraded: false },
    ],
    draw: Array.from({ length: 5 }, (_, index) => ({
      uid: `room-atomic-draw-${index}`, defId: 'defend_silent', upgraded: false,
    })),
  })
  room.run.combat.enemies.push({ ...room.run.combat.enemies[0], uid: 'room-atomic-extra', row: 3 })
  apply(room, a.token, { kind: 'startTurn' })
  const pending = snapshotFor(room, b.token)
  const fumes = pending.startTurnAbilities.find((ability) => ability.id.includes('room-atomic-fumes'))
  const demon = pending.startTurnAbilities.find((ability) => ability.id.includes('room-atomic-demon'))
  const version = room.version
  let refused = null
  try {
    apply(room, b.token, {
      kind: 'resolveStartTurn',
      choices: [
        { id: fumes.id, enemyUid: room.run.combat.enemies[1].uid, shivEnemyUids: [] },
        { id: demon.id, shivEnemyUids: [null] },
      ],
    })
  } catch (error) {
    refused = error
  }
  assertEqual(refused?.name, 'RoomError')
  assertEqual(room.version, version, 'a refused target changed the authoritative version')
  assertEqual(room.startTurnEnemyTargets, undefined, 'a refused target leaked into room state')

  room.startTurnCombatId = 'a-different-combat'
  room.startTurnOrder = pending.startTurnAbilities.map((ability) => ability.id)
  room.startTurnEnemyTargets = { [fumes.id]: room.run.combat.enemies[1].uid }
  const isolated = snapshotFor(room, b.token)
  assertEqual(isolated.startTurnChoiceId, fumes.id, 'a prior combat suppressed the Silent target choice')
  assertDeepEqual(isolated.startTurnEnemyTargets, {}, 'a prior combat target leaked into the snapshot')
  room.startTurnCombatId = room.startTurnOrder = room.startTurnEnemyTargets = undefined

  const ann = room.run.combat.players.find((player) => player.id === a.playerId)
  Object.assign(ann, {
    shivs: 5,
    powers: [{ uid: 'room-old-choice-ann', defId: 'infinite_blades', upgraded: false }],
  })
  Object.assign(silent, {
    shivs: 5,
    powers: [{ uid: 'room-old-choice-silent', defId: 'infinite_blades', upgraded: false }],
  })
  const current = snapshotFor(room, a.token)
  const expectedCoordinator = current.startTurnCoordinatorId
  const firstChoice = current.startTurnAbilities.find((ability) => ability.playerId === expectedCoordinator)
  room.startTurnCombatId = 'a-different-combat'
  room.startTurnChoices = [{
    id: firstChoice.id, shivEnemyUids: [null], evokeSlots: [], evokeEnemyUids: [],
  }]
  const choicesIsolated = snapshotFor(room, a.token)
  assertEqual(choicesIsolated.startTurnCoordinatorId, expectedCoordinator,
    'a prior combat choice changed the current coordinator')
  assertEqual(choicesIsolated.startTurnChoices, undefined, 'a prior combat choice leaked into the snapshot')
  room.startTurnCombatId = room.startTurnChoices = undefined
})

check('a stale target map cannot suppress a second Noxious Fumes choice', () => {
  const { room, a, b } = twoSeatRoom()
  const silent = room.run.combat.players.find((player) => player.id === b.playerId)
  Object.assign(room.run.combat, { phase: 'roundEnd', turn: 1 })
  Object.assign(silent, {
    powers: [
      { uid: 'room-target-map-first', defId: 'noxious_fumes', upgraded: false },
      { uid: 'room-target-map-second', defId: 'noxious_fumes', upgraded: false },
    ],
    draw: Array.from({ length: 5 }, (_, index) => ({
      uid: `room-target-map-draw-${index}`, defId: 'defend_silent', upgraded: false,
    })),
  })
  room.run.combat.enemies.push({ ...room.run.combat.enemies[0], uid: 'room-target-map-extra', row: 3 })
  for (const enemy of room.run.combat.enemies) {
    Object.assign(enemy, { hp: 20, maxHp: 20, poison: 0, dead: false, abilityUsed: true })
  }

  apply(room, a.token, { kind: 'startTurn' })
  const pending = snapshotFor(room, b.token)
  const [first, second] = pending.startTurnAbilities.filter((ability) =>
    ability.id.includes('room-target-map-'))
  room.startTurnCombatId = 'a-different-combat'
  room.startTurnEnemyTargets = { [second.id]: room.run.combat.enemies[0].uid }
  apply(room, b.token, {
    kind: 'resolveStartTurn',
    choices: [
      { id: first.id, enemyUid: room.run.combat.enemies[1].uid, shivEnemyUids: [] },
      { id: second.id, shivEnemyUids: [] },
    ],
  })
  const next = snapshotFor(room, b.token)
  assertEqual(next.run.combat.phase, 'start', 'a stale target skipped the second Noxious choice')
  assertEqual(next.startTurnChoiceId, second.id)
  assertDeepEqual(next.startTurnEnemyTargets, { [first.id]: room.run.combat.enemies[1].uid })
})

check('Storm preserves full-slot Orb and target choices across coordinator reconnect', () => {
  const { room, a, b } = twoSeatRoom()
  const ann = room.run.combat.players.find((player) => player.id === a.playerId)
  const bo = room.run.combat.players.find((player) => player.id === b.playerId)
  Object.assign(room.run.combat, { phase: 'roundEnd', turn: 1 })
  Object.assign(ann, { draw: Array.from({ length: 5 }, (_, index) => ({
    uid: `room-storm-ann-${index}`, defId: 'defend_ironclad', upgraded: false,
  })) })
  Object.assign(bo, {
    character: 'defect',
    powers: [{ uid: 'room-storm', defId: 'storm', upgraded: true }],
    orbs: ['frost', 'lightning', 'dark'],
    draw: Array.from({ length: 5 }, (_, index) => ({
      uid: `room-storm-bo-${index}`, defId: 'defend_defect', upgraded: false,
    })),
  })
  for (const enemy of room.run.combat.enemies) {
    Object.assign(enemy, { hp: 20, maxHp: 20, block: 0, dead: false, abilityUsed: true })
  }

  apply(room, a.token, { kind: 'startTurn' })
  const pending = snapshotFor(room, b.token)
  const [ability] = pending.startTurnAbilities
  assertEqual(ability.evokeChoice.options.length, 3)
  let malformed = null
  try {
    apply(room, b.token, {
      kind: 'resolveStartTurn',
      choices: [{
        id: ability.id, shivEnemyUids: [], evokeSlots: ['length'], evokeEnemyUids: [null],
      }],
    })
  } catch (error) {
    malformed = error
  }
  assertEqual(malformed?.name, 'RoomError', 'a crafted Orb slot escaped room validation')
  assertEqual(room.run.combat.phase, 'start')

  markDisconnected(room, b.token)
  const transferred = snapshotFor(room, a.token)
  assertEqual(transferred.startTurnCoordinatorId, a.playerId)
  assertEqual(transferred.startTurnAbilities[0].evokeChoice.options.length, 3)
  const target = room.run.combat.enemies[1]
  apply(room, a.token, {
    kind: 'resolveStartTurn',
    choices: [{
      id: ability.id,
      shivEnemyUids: [],
      evokeSlots: [2, 0],
      evokeEnemyUids: [target.uid, null],
    }],
  })
  assertEqual(room.run.combat.phase, 'player')
  const resolvedBo = room.run.combat.players.find((player) => player.id === b.playerId)
  const resolvedTarget = room.run.combat.enemies.find((enemy) => enemy.uid === target.uid)
  assertDeepEqual(resolvedBo.orbs, ['lightning', 'lightning', 'lightning'])
  assertEqual(resolvedBo.block, 1)
  assertEqual(resolvedTarget.hp, 16)
})

check('face-down reward stacks are counted, never listed', () => {
  const { room, a, b } = twoSeatRoom()
  for (const player of room.run.combat.players) {
    player.cardRewards = [`rw-${player.id}`]
  }
  const snapshot = snapshotFor(room, a.token)
  const seen = new Set(allStrings(snapshot))
  // Secret even from its owner: a reward deck is a face-down stack, so knowing
  // the order of your own would be reading ahead.
  assert(!seen.has('rw-p1'), "the viewer's own reward stack was listed")
  assert(!seen.has(`rw-${b.playerId}`), "another player's reward stack was listed")
  for (const player of snapshot.run.combat.players) {
    assertEqual(player.cardRewardCount, 1, 'but the size is public')
  }
})

check('Mayhem keeps its forced card private, owner-authoritative, and settles disconnects', () => {
  const { room, a, b } = twoSeatRoom()
  const ann = room.run.combat.players.find((player) => player.id === a.playerId)
  const bo = room.run.combat.players.find((player) => player.id === b.playerId)
  const opening = Array.from({ length: 5 }, (_, index) => ({
    uid: `mayhem-opening-${index}`, defId: 'defend_ironclad', upgraded: false,
  }))
  const secret = { uid: 'mayhem-private-strike', defId: 'strike_ironclad', upgraded: false }
  Object.assign(room.run.combat, { phase: 'roundEnd', turn: 1 })
  Object.assign(ann, {
    powers: [{ uid: 'room-mayhem', defId: 'mayhem', upgraded: false }],
    draw: [...opening, secret], hand: [], discard: [], energy: 0,
  })
  Object.assign(bo, {
    draw: Array.from({ length: 5 }, (_, index) => ({
      uid: `mayhem-bo-${index}`, defId: 'defend_silent', upgraded: false,
    })),
  })
  const target = room.run.combat.enemies[0]
  Object.assign(target, { hp: 10, maxHp: 10, block: 0, dead: false, abilityUsed: true })

  apply(room, a.token, { kind: 'startTurn' })
  const owner = snapshotFor(room, a.token)
  const teammate = snapshotFor(room, b.token)
  assertEqual(owner.run.combat.phase, 'start')
  assertEqual(owner.run.combat.startTurnProgress.forcedCard.cardUid, secret.uid)
  assertEqual(teammate.run.combat.startTurnProgress.forcedCard.cardUid, null)
  assert(!allStrings(teammate).includes(secret.uid), 'Mayhem leaked the drawn card to a teammate')
  assertEqual(teammate.run.combat.players.find((player) => player.id === a.playerId).hand, null)

  let stolen = null
  try {
    apply(room, b.token, { kind: 'playCard', cardUid: secret.uid, enemyUid: target.uid })
  } catch (error) {
    stolen = error
  }
  assertEqual(stolen?.name, 'RoomError', 'another seat played Mayhem\'s private card')

  const disconnectRoom = structuredClone(room)
  apply(room, a.token, {
    kind: 'playCard', cardUid: secret.uid, enemyUid: target.uid, preflight: true,
  })
  assertEqual(room.run.combat.phase, 'player')
  assertEqual(room.run.combat.players.find((player) => player.id === a.playerId).energy, 3,
    'Mayhem charged the forced card\'s printed Energy')
  assertEqual(room.run.combat.enemies.find((enemy) => enemy.uid === target.uid).hp, 9)

  markDisconnected(disconnectRoom, a.token)
  assertEqual(disconnectRoom.run.combat.phase, 'player')
  assertEqual(disconnectRoom.run.combat.startTurnProgress, undefined)
  assertEqual(disconnectRoom.run.combat.players.find((player) => player.id === a.playerId).discard.at(-1).uid, secret.uid)
  assert(allStrings(snapshotFor(disconnectRoom, b.token)).includes(secret.uid),
    'Mayhem\'s abandoned card did not become public in discard')
  joinRoom(disconnectRoom, { token: a.token })
  assertEqual(snapshotFor(disconnectRoom, a.token).run.combat.startTurnProgress, undefined,
    'reconnect restored a settled Mayhem card')
})

check('Havoc keeps its immediate draw private and blocks every other room action', () => {
  const { room, a, b } = twoSeatRoom()
  const ann = room.run.combat.players.find((player) => player.id === a.playerId)
  const havoc = { uid: 'room-havoc', defId: 'havoc', upgraded: false }
  const held = { uid: 'room-havoc-held', defId: 'defend_ironclad', upgraded: false }
  const secret = { uid: 'room-havoc-secret', defId: 'strike_ironclad', upgraded: false }
  Object.assign(room.run.combat, { phase: 'player', turn: 1 })
  Object.assign(ann, { hand: [havoc, held], draw: [secret], discard: [], exhaust: [], energy: 1 })
  const target = room.run.combat.enemies[0]
  Object.assign(target, { hp: 10, maxHp: 10, block: 0, dead: false, abilityUsed: true })

  apply(room, a.token, { kind: 'playCard', cardUid: havoc.uid, preflight: true })
  const owner = snapshotFor(room, a.token)
  const teammate = snapshotFor(room, b.token)
  assertEqual(owner.run.combat.startTurnProgress.forcedCard.cardUid, secret.uid)
  assertEqual(owner.run.combat.startTurnProgress.forcedCard.sourceCardId, 'havoc')
  assertEqual(teammate.run.combat.startTurnProgress.forcedCard.cardUid, null)
  assert(!allStrings(teammate).includes(secret.uid), 'Havoc leaked its draw to a teammate')

  for (const [token, action] of [
    [a.token, { kind: 'playCard', cardUid: held.uid, preflight: true }],
    [b.token, { kind: 'endTurn' }],
  ]) {
    let refused = null
    try { apply(room, token, action) } catch (error) { refused = error }
    assertEqual(refused?.name, 'RoomError', 'another action bypassed Havoc\'s immediate play')
  }

  const disconnectRoom = structuredClone(room)
  apply(room, a.token, {
    kind: 'playCard', cardUid: secret.uid, enemyUid: target.uid, preflight: true,
  })
  const resolved = room.run.combat.players.find((player) => player.id === a.playerId)
  assertEqual(room.run.combat.enemies[0].hp, 9)
  assertEqual(resolved.energy, 0, 'Havoc charged more than its own printed cost')
  assertEqual(resolved.exhaust.at(-1).uid, secret.uid)
  assertEqual(room.run.combat.startTurnProgress, undefined)

  markDisconnected(disconnectRoom, a.token)
  const abandoned = disconnectRoom.run.combat.players.find((player) => player.id === a.playerId)
  assertEqual(disconnectRoom.run.combat.startTurnProgress, undefined)
  assertEqual(abandoned.exhaust.at(-1).uid, secret.uid, 'disconnect discarded Havoc\'s forced card')
  assert(allStrings(snapshotFor(disconnectRoom, b.token)).includes(secret.uid),
    'the settled card did not become public in Exhaust')
})

check('Havoc resolves its child before Enraged and cannot strand online defeat', () => {
  const { room, a } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const havoc = { uid: 'room-havoc-lethal', defId: 'havoc', upgraded: true }
  const strike = { uid: 'room-havoc-lethal-strike', defId: 'strike_ironclad', upgraded: false }
  Object.assign(room.run.combat, { phase: 'player', turn: 2, startTurnProgress: undefined })
  Object.assign(actor, { hand: [havoc], draw: [strike], hp: 1, energy: 0 })
  room.run.combat.enemies = [{
    ...room.run.combat.enemies[0], defId: 'gremlin_nob', hp: 1, maxHp: 1,
    block: 0, dead: false, abilityUsed: false,
  }]

  apply(room, a.token, { kind: 'playCard', cardUid: havoc.uid, preflight: true })
  assertEqual(room.run.combat.players.find((player) => player.id === a.playerId).hp, 1,
    'Enraged fired before the immediate card online')
  apply(room, a.token, {
    kind: 'playCard', cardUid: strike.uid, enemyUid: room.run.combat.enemies[0].uid, preflight: true,
  })
  assertEqual(room.run.combat.phase, 'won')
  assertEqual(room.run.combat.startTurnProgress, undefined)
  const resolved = apply(room, a.token, { kind: 'resolveCombat' })
  assertEqual(resolved.changed, true, 'a stale forced marker blocked online combat resolution')
})

check('a disconnected Mayhem owner resolves a previewed Thinking Ahead fallback', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const opening = Array.from({ length: 5 }, (_, index) => ({
    uid: `mayhem-thinking-opening-${index}`, defId: 'defend_ironclad', upgraded: false,
  }))
  const thinking = { uid: 'mayhem-thinking', defId: 'thinking_ahead', upgraded: false }
  const hidden = Array.from({ length: 2 }, (_, index) => ({
    uid: `mayhem-thinking-hidden-${index}`, defId: 'strike_ironclad', upgraded: false,
  }))
  Object.assign(room.run.combat, { phase: 'roundEnd', turn: 1 })
  Object.assign(actor, {
    powers: [{ uid: 'mayhem-thinking-power', defId: 'mayhem', upgraded: false }],
    draw: [...opening, thinking, ...hidden], hand: [], discard: [], exhaust: [], energy: 0,
  })

  apply(room, a.token, { kind: 'startTurn' })
  const revealed = apply(room, a.token, { kind: 'previewCard', cardUid: thinking.uid }).snapshot.cardPreview
  const fallback = revealed.cards[0].uid
  for (const card of hidden) {
    assert(!allStrings(snapshotFor(room, b.token)).includes(card.uid), `${card.uid} leaked to a teammate`)
  }

  markDisconnected(room, a.token)
  const settled = room.run.combat.players.find((player) => player.id === a.playerId)
  assertEqual(room.run.combat.phase, 'player')
  assertEqual(room.run.combat.startTurnProgress, undefined)
  assertEqual(settled.draw[0].uid, fallback, 'disconnect skipped Thinking Ahead\'s deterministic topdeck')
  assertEqual(settled.exhaust.at(-1).uid, thinking.uid, 'the committed forced play was discarded instead')
  assertEqual(snapshotFor(room, a.token).cardPreview, undefined)
})

check('Mayhem settles when its owner was already disconnected before Start of Turn', () => {
  for (const ordered of [false, true]) {
    const { room, a, b } = twoSeatRoom()
    const ann = room.run.combat.players.find((player) => player.id === a.playerId)
    const bo = room.run.combat.players.find((player) => player.id === b.playerId)
    const opening = Array.from({ length: 5 }, (_, index) => ({
      uid: `offline-opening-${ordered}-${index}`, defId: 'defend_ironclad', upgraded: false,
    }))
    const secret = { uid: `offline-mayhem-${ordered}`, defId: 'strike_ironclad', upgraded: false }
    Object.assign(room.run.combat, { phase: 'roundEnd', turn: 1 })
    // Two abilities AIMED at an enemy are what still needs an order; a pair that
    // merely gains Strength commutes and is resolved for the table now. One
    // enemy on the board keeps each of them down to a single legal target, so
    // the only decision left is the sequence.
    if (ordered) {
      room.run.combat.enemies = room.run.combat.enemies.slice(0, 1)
      Object.assign(room.run.combat.enemies[0], { hp: 20, maxHp: 20, dead: false, row: ann.row })
    }
    Object.assign(ann, {
      powers: [
        { uid: `offline-power-${ordered}`, defId: 'mayhem', upgraded: false },
        ...(ordered ? [
          { uid: 'offline-fumes-a', defId: 'noxious_fumes', upgraded: false },
          { uid: 'offline-fumes-b', defId: 'noxious_fumes', upgraded: false },
        ] : []),
      ],
      draw: [...opening, secret], hand: [], discard: [], energy: 0,
    })
    Object.assign(bo, {
      draw: Array.from({ length: 5 }, (_, index) => ({
        uid: `offline-bo-${ordered}-${index}`, defId: 'defend_silent', upgraded: false,
      })),
    })
    markDisconnected(room, a.token)
    apply(room, b.token, { kind: 'startTurn' })
    if (ordered) {
      const abilities = snapshotFor(room, b.token).startTurnAbilities
      assert(abilities, 'two aimed abilities should still be published for ordering')
      apply(room, b.token, {
        kind: 'resolveStartTurn',
        choices: abilities.map((ability) => ({
          id: ability.id, enemyUid: ability.targets?.[0]?.uid, shivEnemyUids: [],
        })),
      })
    }
    assertEqual(room.run.combat.phase, 'player')
    assertEqual(room.run.combat.startTurnProgress, undefined)
    assertEqual(room.run.combat.players.find((player) => player.id === a.playerId).discard.at(-1)?.uid, secret.uid,
      `the ${ordered ? 'ordered' : 'automatic'} Start-of-Turn path stranded Mayhem`)
  }
})

check('Thinking Ahead previews and validates its topdeck choice privately', () => {
  const { room, a, b } = twoSeatRoom()
  const ann = room.run.combat.players.find((player) => player.id === a.playerId)
  const thinking = { uid: 'room-thinking', defId: 'thinking_ahead', upgraded: true }
  const held = { uid: 'thinking-held', defId: 'strike_ironclad', upgraded: false }
  const hidden = Array.from({ length: 3 }, (_, index) => ({
    uid: `thinking-private-${index}`, defId: 'defend_ironclad', upgraded: false,
  }))
  Object.assign(ann, { hand: [thinking, held], draw: hidden, discard: [], exhaust: [], energy: 0 })
  const before = JSON.stringify(room.run)
  const revealed = apply(room, a.token, { kind: 'previewCard', cardUid: thinking.uid })
  assertEqual(revealed.snapshot.cardPreview.kind, 'topdeck')
  assertDeepEqual(revealed.snapshot.cardPreview.cards.map((card) => card.uid), [held.uid, ...hidden.map((card) => card.uid)])
  assertEqual(JSON.stringify(room.run), before, 'Thinking Ahead preview advanced authoritative state')
  for (const card of hidden) {
    assert(!allStrings(snapshotFor(room, b.token)).includes(card.uid), `${card.uid} leaked to a teammate`)
  }
  const disconnectRoom = structuredClone(room)

  let malformed = null
  try {
    apply(room, a.token, {
      kind: 'playCard', cardUid: thinking.uid, topdeckUids: 'not-a-list', preflight: true,
    })
  } catch (error) {
    malformed = error
  }
  assertEqual(malformed?.name, 'RoomError')
  assertEqual(JSON.stringify(room.run), before, 'a malformed topdeck choice mutated the run')

  apply(room, a.token, {
    kind: 'playCard', cardUid: thinking.uid, topdeckUids: [hidden[2].uid], preflight: true,
  })
  const resolved = room.run.combat.players.find((player) => player.id === a.playerId)
  assertEqual(resolved.draw[0].uid, hidden[2].uid)
  assertEqual(resolved.exhaust.at(-1).uid, thinking.uid)
  assertEqual(snapshotFor(room, a.token).cardPreview, undefined)

  markDisconnected(disconnectRoom, a.token)
  apply(disconnectRoom, b.token, { kind: 'endTurn' })
  const abandoned = disconnectRoom.run.combat.players.find((player) => player.id === a.playerId)
  assertEqual(abandoned.draw[0].uid, held.uid,
    'a disconnected Thinking Ahead owner did not use the deterministic first-card fallback')
  assertEqual(abandoned.exhaust.at(-1).uid, thinking.uid)
  assertEqual(snapshotFor(disconnectRoom, a.token).cardPreview, undefined)
  joinRoom(disconnectRoom, { token: a.token })
  assertEqual(snapshotFor(disconnectRoom, a.token).cardPreview, undefined,
    'reconnect restored a settled Thinking Ahead preview')
})

check('Warcry uses the same private authoritative topdeck choice', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const warcry = { uid: 'room-warcry', defId: 'warcry', upgraded: true }
  const held = { uid: 'room-warcry-held', defId: 'strike_ironclad', upgraded: false }
  const hidden = Array.from({ length: 3 }, (_, index) => ({
    uid: `room-warcry-hidden-${index}`, defId: 'defend_ironclad', upgraded: false,
  }))
  Object.assign(actor, { hand: [warcry, held], draw: hidden, discard: [], exhaust: [], energy: 0 })
  const before = JSON.stringify(room.run)
  const revealed = apply(room, a.token, { kind: 'previewCard', cardUid: warcry.uid }).snapshot.cardPreview
  assertEqual(revealed.kind, 'topdeck')
  assertDeepEqual(revealed.cards.map((card) => card.uid), [held.uid, ...hidden.map((card) => card.uid)])
  assertEqual(JSON.stringify(room.run), before, 'Warcry preview advanced authoritative state')
  for (const card of hidden) {
    assert(!allStrings(snapshotFor(room, b.token)).includes(card.uid), `${card.uid} leaked to a teammate`)
  }

  apply(room, a.token, {
    kind: 'playCard', cardUid: warcry.uid, topdeckUids: [hidden[2].uid], preflight: true,
  })
  const resolved = room.run.combat.players.find((player) => player.id === a.playerId)
  assertEqual(resolved.draw[0].uid, hidden[2].uid)
  assertEqual(resolved.hand.length, 3)
  assertEqual(resolved.exhaust.at(-1).uid, warcry.uid)
  assertEqual(snapshotFor(room, a.token).cardPreview, undefined)
})

check('Headbutt returns one public discard card to the hidden draw top authoritatively', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const headbutt = { uid: 'room-headbutt', defId: 'headbutt', upgraded: true }
  const lower = { uid: 'room-headbutt-lower', defId: 'defend_ironclad', upgraded: false }
  const chosen = { uid: 'room-headbutt-chosen', defId: 'bash', upgraded: false }
  Object.assign(room.run.combat, { phase: 'player', turn: 1 })
  Object.assign(actor, { hand: [headbutt], discard: [lower, chosen], draw: [], energy: 1 })
  const enemy = room.run.combat.enemies[0]
  Object.assign(enemy, { hp: 10, maxHp: 10, block: 0, dead: false, abilityUsed: true })
  const before = JSON.stringify(room.run)

  for (const action of [
    { kind: 'playCard', cardUid: headbutt.uid, enemyUid: enemy.uid, preflight: true },
    { kind: 'playCard', cardUid: headbutt.uid, enemyUid: enemy.uid, recoverDiscardUid: 7, preflight: true },
    { kind: 'playCard', cardUid: headbutt.uid, enemyUid: enemy.uid, recoverDiscardUid: headbutt.uid, preflight: true },
  ]) {
    let refused = null
    try { apply(room, a.token, action) } catch (error) { refused = error }
    assertEqual(refused?.name, 'RoomError', 'a malformed Headbutt choice was accepted')
    assertEqual(JSON.stringify(room.run), before, 'a refused Headbutt mutated authority')
  }

  let stolen = null
  try {
    apply(room, b.token, {
      kind: 'playCard', cardUid: headbutt.uid, enemyUid: enemy.uid,
      recoverDiscardUid: chosen.uid, preflight: true,
    })
  } catch (error) { stolen = error }
  assertEqual(stolen?.name, 'RoomError', 'another seat played Headbutt')

  apply(room, a.token, {
    kind: 'playCard', cardUid: headbutt.uid, enemyUid: enemy.uid,
    recoverDiscardUid: chosen.uid, preflight: true,
  })
  const resolved = room.run.combat.players.find((player) => player.id === a.playerId)
  assertEqual(room.run.combat.enemies[0].hp, 7)
  assertEqual(resolved.draw[0].uid, chosen.uid)
  assertDeepEqual(resolved.discard.map((card) => card.uid), [lower.uid, headbutt.uid])
  assert(!allStrings(snapshotFor(room, b.token)).includes(chosen.uid),
    'the recovered card stayed visible after returning face-down')
})

check('Power Through gives an ally Block while its Daze stays private to the caster', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const ally = room.run.combat.players.find((player) => player.id === b.playerId)
  const powerThrough = { uid: 'room-power-through', defId: 'power_through', upgraded: true }
  Object.assign(room.run.combat, { phase: 'player', turn: 1 })
  Object.assign(actor, { hand: [powerThrough], draw: [], discard: [], energy: 1, block: 0 })
  ally.block = 0

  apply(room, a.token, {
    kind: 'playCard', cardUid: powerThrough.uid, playerId: ally.id, preflight: true,
  })
  const resolvedActor = room.run.combat.players.find((player) => player.id === actor.id)
  const resolvedAlly = room.run.combat.players.find((player) => player.id === ally.id)
  assertEqual(resolvedActor.block, 0)
  assertEqual(resolvedAlly.block, 4)
  assertEqual(resolvedActor.draw[0].defId, 'daze')
  const owner = snapshotFor(room, a.token).run.combat.players.find((player) => player.id === actor.id)
  assertEqual(owner.drawCount, 1)
  assert(!allStrings(snapshotFor(room, b.token)).includes(resolvedActor.draw[0].uid),
    'Power Through leaked the caster\'s Daze identity to a teammate')
})

check('Flame Barrier resolves current intents from its online owner\'s row', () => {
  const { room, a } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const barrier = { uid: 'room-flame-barrier', defId: 'flame_barrier', upgraded: true }
  Object.assign(room.run.combat, { phase: 'player', turn: 1, die: 1 })
  Object.assign(actor, { hand: [barrier], energy: 2, block: 0, row: 0 })
  const template = room.run.combat.enemies[0]
  room.run.combat.enemies = [
    { ...template, uid: 'room-flame-same', defId: 'cultist', row: 0, isBoss: false,
      hp: 5, maxHp: 5, block: 0, dead: false, actionIndex: 0 },
    { ...template, uid: 'room-flame-other', defId: 'cultist', row: 1, isBoss: false,
      hp: 5, maxHp: 5, block: 0, dead: false, actionIndex: 0 },
    { ...template, uid: 'room-flame-boss', defId: 'cultist', row: 1, isBoss: true,
      hp: 5, maxHp: 5, block: 0, dead: false, actionIndex: 0 },
  ]

  apply(room, a.token, { kind: 'playCard', cardUid: barrier.uid, preflight: true })
  const resolved = room.run.combat.players.find((player) => player.id === actor.id)
  assertEqual(resolved.block, 4)
  assertEqual(room.run.combat.enemies.find((enemy) => enemy.uid === 'room-flame-same').hp, 4)
  assertEqual(room.run.combat.enemies.find((enemy) => enemy.uid === 'room-flame-other').hp, 5)
  assertEqual(room.run.combat.enemies.find((enemy) => enemy.uid === 'room-flame-boss').hp, 4)
})

check('Snecko next-card cost stays public and reconnect-consistent', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  actor.nextCardCost = 0
  assertEqual(snapshotFor(room, a.token).run.combat.players.find((player) => player.id === a.playerId).nextCardCost, 0)
  assertEqual(snapshotFor(room, b.token).run.combat.players.find((player) => player.id === a.playerId).nextCardCost, 0)
  markDisconnected(room, a.token)
  const rejoined = joinRoom(room, { token: a.token })
  assertEqual(snapshotFor(room, rejoined.token).run.combat.players
    .find((player) => player.id === a.playerId).nextCardCost, 0)
})

check('Rampage+ authoritatively Exhausts first and counts the resulting public pile', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const rampage = { uid: 'room-rampage', defId: 'rampage', upgraded: true }
  const fuel = { uid: 'room-rampage-fuel', defId: 'strike_ironclad', upgraded: false }
  const old = { uid: 'room-rampage-old', defId: 'bash', upgraded: false }
  Object.assign(room.run.combat, { phase: 'player', turn: 1 })
  Object.assign(actor, { hand: [rampage, fuel], exhaust: [old], energy: 1 })
  const enemy = room.run.combat.enemies[0]
  Object.assign(enemy, { hp: 2, maxHp: 2, block: 0, dead: false, abilityUsed: true })
  const before = JSON.stringify(room.run)

  for (const action of [
    { kind: 'playCard', cardUid: rampage.uid, enemyUid: enemy.uid, preflight: true },
    { kind: 'playCard', cardUid: rampage.uid, enemyUid: enemy.uid,
      exhaustUids: ['not-in-hand'], preflight: true },
  ]) {
    let refused = null
    try { apply(room, a.token, action) } catch (error) { refused = error }
    assertEqual(refused?.name, 'RoomError', 'an unpaid Rampage+ Exhaust was accepted')
    assertEqual(JSON.stringify(room.run), before, 'a refused Rampage+ mutated room authority')
  }

  let stolen = null
  try {
    apply(room, b.token, {
      kind: 'playCard', cardUid: rampage.uid, enemyUid: enemy.uid,
      exhaustUids: [fuel.uid], preflight: true,
    })
  } catch (error) { stolen = error }
  assertEqual(stolen?.name, 'RoomError', 'another seat played Rampage+')

  apply(room, a.token, {
    kind: 'playCard', cardUid: rampage.uid, enemyUid: enemy.uid,
    exhaustUids: [fuel.uid], preflight: true,
  })
  const resolved = room.run.combat.players.find((player) => player.id === actor.id)
  assertEqual(room.run.combat.enemies[0].hp, 0)
  assertDeepEqual(resolved.exhaust.map((card) => card.uid), [old.uid, fuel.uid])
})

check('Recycle authoritatively gains Energy from its chosen Exhaust', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const recycle = { uid: 'room-recycle', defId: 'recycle', upgraded: true }
  const fuel = { uid: 'room-recycle-fuel', defId: 'reinforced_body', upgraded: false }
  Object.assign(room.run.combat, { phase: 'player', turn: 1 })
  Object.assign(actor, { hand: [recycle, fuel], discard: [], exhaust: [], energy: 2 })
  const before = JSON.stringify(room.run)

  let stolen = null
  try {
    apply(room, b.token, {
      kind: 'playCard', cardUid: recycle.uid, exhaustUids: [fuel.uid], preflight: true,
    })
  } catch (error) { stolen = error }
  assertEqual(stolen?.name, 'RoomError', 'another seat played Recycle')
  assertEqual(JSON.stringify(room.run), before, 'a refused Recycle mutated room authority')

  apply(room, a.token, {
    kind: 'playCard', cardUid: recycle.uid, exhaustUids: [fuel.uid], preflight: true,
  })
  const resolved = room.run.combat.players.find((player) => player.id === actor.id)
  assertEqual(resolved.energy, 4)
  assertDeepEqual(resolved.exhaust.map((card) => card.uid), [fuel.uid])
})

check('Equilibrium Retain choices are authoritative, private, and reconnect-safe', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const other = room.run.combat.players.find((player) => player.id === b.playerId)
  const equilibrium = { uid: 'room-equilibrium', defId: 'equilibrium', upgraded: false }
  const discarded = { uid: 'room-equilibrium-discard', defId: 'strike_ironclad', upgraded: false }
  const retained = { uid: 'room-equilibrium-retain', defId: 'defend_ironclad', upgraded: false }
  Object.assign(room.run.combat, { phase: 'player', turn: 1 })
  Object.assign(actor, { hand: [equilibrium, discarded, retained], discard: [], energy: 2, block: 0 })

  apply(room, a.token, { kind: 'playCard', cardUid: equilibrium.uid, preflight: true })
  assertEqual(snapshotFor(room, a.token).run.combat.players
    .find((player) => player.id === actor.id).retainCardsThisTurn, 1)
  assertEqual(snapshotFor(room, b.token).run.combat.players
    .find((player) => player.id === actor.id).retainCardsThisTurn, 1)
  apply(room, a.token, { kind: 'endTurn' })
  apply(room, b.token, { kind: 'endTurn' })

  let overRetained = null
  try { apply(room, a.token, { kind: 'discardHand', discardOrder: [] }) } catch (error) { overRetained = error }
  assertEqual(overRetained?.name, 'RoomError', 'base Equilibrium retained more than one card')

  const discardOrder = [discarded.uid]
  apply(room, a.token, { kind: 'discardHand', discardOrder })
  assertDeepEqual(snapshotFor(room, a.token).discardOrder, discardOrder)
  assertEqual(snapshotFor(room, b.token).discardOrder, undefined, 'another seat saw the private Retain choice')
  markDisconnected(room, a.token)
  const rejoined = joinRoom(room, { token: a.token })
  assertDeepEqual(snapshotFor(room, rejoined.token).discardOrder, discardOrder,
    'reconnect lost the omitted card that encodes Equilibrium Retain')

  apply(room, b.token, { kind: 'discardHand', discardOrder: other.hand.map((card) => card.uid) })
  const resolved = room.run.combat.players.find((player) => player.id === actor.id)
  assertDeepEqual(resolved.hand.map((card) => card.uid), [retained.uid])
  assertEqual(resolved.hand[0].retainedLastTurn, true)
  assertEqual(resolved.retainCardsThisTurn, 0)
})

check('Well-Laid Plans grants its private Retain choices only at End of Turn', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const other = room.run.combat.players.find((player) => player.id === b.playerId)
  const plans = { uid: 'room-plans', defId: 'well_laid_plans', upgraded: true }
  const regret = { uid: 'room-plans-regret', defId: 'regret', upgraded: false }
  const first = { uid: 'room-plans-strike', defId: 'strike_silent', upgraded: false }
  const second = { uid: 'room-plans-defend', defId: 'defend_silent', upgraded: false }
  const tossed = { uid: 'room-plans-tossed', defId: 'neutralize', upgraded: false }
  Object.assign(actor, { hand: [plans, regret, first, second, tossed], discard: [], energy: 1 })
  Object.assign(other, { hand: [] })

  apply(room, a.token, { kind: 'playCard', cardUid: plans.uid, preflight: true })
  assertEqual(room.run.combat.players.find((player) => player.id === a.playerId).retainCardsThisTurn, 0)
  apply(room, a.token, { kind: 'endTurn' })
  apply(room, b.token, { kind: 'endTurn' })
  assertEqual(room.run.combat.phase, 'discard')
  assertEqual(room.run.combat.players.find((player) => player.id === a.playerId).retainCardsThisTurn, 2)

  apply(room, a.token, { kind: 'discardHand', discardOrder: [tossed.uid] })
  apply(room, b.token, { kind: 'discardHand', discardOrder: [] })
  const resolved = room.run.combat.players.find((player) => player.id === a.playerId)
  assertDeepEqual(resolved.hand.map((card) => card.uid), [regret.uid, first.uid, second.uid])
  assert(!allStrings(snapshotFor(room, b.token)).some((value) =>
    [regret.uid, first.uid, second.uid].includes(value)),
    'Well-Laid Plans leaked the private retained cards to a teammate')
})

check('Buffer+ prevention cubes stay authoritative and public until it Exhausts', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const buffer = { uid: 'room-buffer', defId: 'buffer', upgraded: true }
  const rupture = { uid: 'room-buffer-rupture', defId: 'rupture', upgraded: true }
  const offering = { uid: 'room-buffer-offering', defId: 'offering', upgraded: false }
  Object.assign(actor, { hand: [buffer, rupture, offering], draw: [], energy: 2, hp: 7 })

  apply(room, a.token, { kind: 'playCard', cardUid: buffer.uid, preflight: true })
  let stolen = null
  try {
    apply(room, b.token, { kind: 'playCard', cardUid: rupture.uid, preflight: true })
  } catch (error) {
    stolen = error
  }
  assertEqual(stolen?.name, 'RoomError', 'another seat spent Buffer+ protection')

  apply(room, a.token, { kind: 'playCard', cardUid: rupture.uid, preflight: true })
  for (const token of [a.token, b.token]) {
    const seen = snapshotFor(room, token).run.combat.players.find((player) => player.id === actor.id)
    assertEqual(seen.hp, 7)
    assertEqual(seen.powers.find((power) => power.uid === buffer.uid).counter, 1)
  }

  markDisconnected(room, a.token)
  const rejoined = joinRoom(room, { token: a.token })
  const resumed = snapshotFor(room, rejoined.token).run.combat.players
    .find((player) => player.id === actor.id)
  assertEqual(resumed.powers.find((power) => power.uid === buffer.uid).counter, 1,
    'reconnect lost Buffer+\'s first prevention cube')

  apply(room, rejoined.token, { kind: 'playCard', cardUid: offering.uid, preflight: true })
  const resolved = room.run.combat.players.find((player) => player.id === actor.id)
  assertEqual(resolved.hp, 7)
  assert(!resolved.powers.some((power) => power.uid === buffer.uid))
  assert(resolved.exhaust.some((card) => card.uid === buffer.uid))
})

check('Collector Claw cubes stay authoritative and public to the party', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const claw = { uid: 'room-claw-pack', defId: 'claw_claw_pack', upgraded: true }
  Object.assign(room.run.combat, { phase: 'player', turn: 1 })
  Object.assign(actor, { hand: [claw], discard: [], energy: 0, clawCubesGainedThisCombat: 2 })
  const enemy = room.run.combat.enemies[0]
  Object.assign(enemy, { hp: 10, maxHp: 10, block: 0, dead: false })

  apply(room, a.token, {
    kind: 'playCard', cardUid: claw.uid, enemyUid: enemy.uid, preflight: true,
  })
  const resolved = room.run.combat.players.find((player) => player.id === actor.id)
  assertEqual(resolved.clawCubesGainedThisCombat, 3)
  assertEqual(room.run.combat.enemies[0].hp, 6)
  assertEqual(snapshotFor(room, a.token).run.combat.players[0].clawCubesGainedThisCombat, 3)
  assertEqual(snapshotFor(room, b.token).run.combat.players[0].clawCubesGainedThisCombat, 3)
})

check('Exhume moves one public Exhaust card into only its owner\'s private hand', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const exhume = { uid: 'room-exhume', defId: 'exhume', upgraded: true }
  const lower = { uid: 'room-exhume-lower', defId: 'defend_ironclad', upgraded: false }
  const chosen = { uid: 'room-exhume-chosen', defId: 'bash', upgraded: false }
  Object.assign(room.run.combat, { phase: 'player', turn: 1 })
  Object.assign(actor, { hand: [exhume], exhaust: [lower, chosen], energy: 0 })
  const before = JSON.stringify(room.run)

  for (const action of [
    { kind: 'playCard', cardUid: exhume.uid, preflight: true },
    { kind: 'playCard', cardUid: exhume.uid, recoverExhaustUid: 7, preflight: true },
    { kind: 'playCard', cardUid: exhume.uid, recoverExhaustUid: exhume.uid, preflight: true },
  ]) {
    let refused = null
    try { apply(room, a.token, action) } catch (error) { refused = error }
    assertEqual(refused?.name, 'RoomError', 'a malformed Exhume choice was accepted')
    assertEqual(JSON.stringify(room.run), before, 'a refused Exhume mutated room authority')
  }

  apply(room, a.token, {
    kind: 'playCard', cardUid: exhume.uid, recoverExhaustUid: lower.uid, preflight: true,
  })
  const resolved = room.run.combat.players.find((player) => player.id === actor.id)
  assertDeepEqual(resolved.hand.map((card) => card.uid), [lower.uid])
  assertDeepEqual(resolved.exhaust.map((card) => card.uid), [chosen.uid, exhume.uid])
  const owner = snapshotFor(room, a.token).run.combat.players.find((player) => player.id === actor.id)
  assertDeepEqual(owner.hand.map((card) => card.uid), [lower.uid])
  assert(!allStrings(snapshotFor(room, b.token)).includes(lower.uid),
    'Exhume left its recovered card visible to a teammate')
})

check('post-reveal card choices stay private, survive reconnects, and lock the table', () => {
  const { room, a, b } = twoSeatRoom()
  const mine = () => room.run.combat.players.find((player) => player.id === a.playerId)
  const theirs = () => room.run.combat.players.find((player) => player.id === b.playerId)
  const acrobatics = { uid: 'private-acrobatics', defId: 'acrobatics', upgraded: false }
  const hidden = [0, 1, 2].map((index) => ({
    uid: `private-draw-${index}`, defId: index === 0 ? 'neutralize' : 'defend_silent', upgraded: false,
  }))
  mine().hand = [acrobatics]
  mine().draw = hidden
  mine().discard = []
  mine().energy = 3
  const runBefore = JSON.stringify(room.run)

  let stolen = null
  try {
    apply(room, b.token, { kind: 'previewCard', cardUid: acrobatics.uid })
  } catch (error) {
    stolen = error
  }
  assertEqual(stolen?.name, 'RoomError', 'another seat previewed a private draw')

  let unpreviewed = null
  try {
    apply(room, a.token, {
      kind: 'playCard', cardUid: acrobatics.uid, enemyUid: null,
      discardUids: [hidden[0].uid], preflight: true,
    })
  } catch (error) {
    unpreviewed = error
  }
  assertEqual(unpreviewed?.name, 'RoomError', 'a hidden choice could be probed without revealing the card')
  assertEqual(JSON.stringify(room.run), runBefore, 'a refused hidden probe mutated the run')

  const revealed = apply(room, a.token, { kind: 'previewCard', cardUid: acrobatics.uid })
  assert(revealed.changed, 'committing to a private reveal should publish its lock')
  assertEqual(JSON.stringify(room.run), runBefore, 'previewing must not advance the real piles or RNG')
  assertEqual(revealed.snapshot.cardPreview.kind, 'discard')
  assertDeepEqual(revealed.snapshot.cardPreview.cards.map((card) => card.uid), hidden.map((card) => card.uid))
  assertEqual(snapshotFor(room, b.token).cardPreview, undefined, 'a teammate saw the private preview')
  for (const card of hidden) {
    assert(!allStrings(snapshotFor(room, b.token)).includes(card.uid), `${card.uid} leaked to a teammate`)
  }

  let escaped = null
  try {
    apply(room, a.token, { kind: 'endTurn' })
  } catch (error) {
    escaped = error
  }
  assertEqual(escaped?.name, 'RoomError', 'the revealing seat escaped its committed card')
  let teammateEnded = null
  try {
    apply(room, b.token, { kind: 'endTurn' })
  } catch (error) {
    teammateEnded = error
  }
  assertEqual(teammateEnded?.name, 'RoomError', 'a teammate ended the turn around a revealed card')

  const target = room.run.combat.enemies[0]
  Object.assign(target, { hp: 10, maxHp: 10, block: 0, dead: false, abilityUsed: true })
  theirs().shivs = 1
  let teammateActed = null
  try {
    apply(room, b.token, { kind: 'spendShiv', enemyUid: target.uid })
  } catch (error) {
    teammateActed = error
  }
  assertEqual(teammateActed?.name, 'RoomError', 'a teammate changed the table during a private reveal')
  assertEqual(target.hp, 10, 'the globally locked teammate action still dealt damage')
  assert(snapshotFor(room, a.token).cardPreview, 'a teammate action erased the committed preview')
  markDisconnected(room, a.token)
  joinRoom(room, { token: a.token })
  assert(snapshotFor(room, a.token).cardPreview, 'reconnecting lost the private preview')

  apply(room, a.token, {
    kind: 'playCard', cardUid: acrobatics.uid, enemyUid: null,
    discardUids: [hidden[2].uid], preflight: true,
  })
  assertEqual(snapshotFor(room, a.token).cardPreview, undefined, 'a completed play kept the seat locked')
  assertDeepEqual(mine().hand.map((card) => card.uid), hidden.slice(0, 2).map((card) => card.uid))

  const thirdEye = { uid: 'private-third-eye', defId: 'third_eye', upgraded: true }
  const scryDeck = Array.from({ length: 6 }, (_, index) => ({
    uid: `private-scry-${index}`, defId: 'defend_watcher', upgraded: false,
  }))
  mine().hand = [thirdEye]
  mine().draw = scryDeck
  mine().discard = []
  mine().energy = 3
  const scried = apply(room, a.token, { kind: 'previewCard', cardUid: thirdEye.uid })
  assertEqual(scried.snapshot.cardPreview.kind, 'scry')
  assertDeepEqual(scried.snapshot.cardPreview.cards.map((card) => card.uid),
    scryDeck.slice(0, 5).map((card) => card.uid))
  let malformedScry = null
  try {
    apply(room, a.token, {
      kind: 'playCard', cardUid: thirdEye.uid, enemyUid: null, scryDiscardUids: 'not-a-list',
    })
  } catch (error) {
    malformedScry = error
  }
  assertEqual(malformedScry?.name, 'RoomError', 'a malformed Scry list became an implicit keep-all')
  mine().draw = [scryDeck[1], scryDeck[0], ...scryDeck.slice(2)]
  let staleKeepAll = null
  try {
    apply(room, a.token, {
      kind: 'playCard', cardUid: thirdEye.uid, enemyUid: null, scryDiscardUids: [], preflight: true,
    })
  } catch (error) {
    staleKeepAll = error
  }
  assertEqual(staleKeepAll?.name, 'RoomError', 'Scry kept a changed unseen window without a fresh reveal')
  mine().draw = [...scryDeck]
  const refreshedScry = apply(room, a.token, { kind: 'previewCard', cardUid: thirdEye.uid })
  assertDeepEqual(refreshedScry.snapshot.cardPreview.cards.map((card) => card.uid),
    scryDeck.slice(0, 5).map((card) => card.uid))
  apply(room, a.token, {
    kind: 'playCard', cardUid: thirdEye.uid, enemyUid: null,
    scryDiscardUids: [scryDeck[1].uid, scryDeck[3].uid], preflight: true,
  })
  assertEqual(mine().block, 3)
  assertDeepEqual(mine().draw.map((card) => card.uid),
    scryDeck.filter((_, index) => index !== 1 && index !== 3).map((card) => card.uid))

  const luckyTarget = room.run.combat.enemies[0]
  Object.assign(luckyTarget, { hp: 10, maxHp: 10, block: 0, dead: false })
  const luckyNoScry = { uid: 'private-just-lucky-4', defId: 'just_lucky', upgraded: false }
  mine().hand = [luckyNoScry]
  mine().draw = [...scryDeck]
  mine().discard = []
  mine().energy = 3
  mine().block = 0
  room.run.combat.die = 4
  apply(room, a.token, {
    kind: 'playCard', cardUid: luckyNoScry.uid, enemyUid: luckyTarget.uid, preflight: true,
  })
  assertEqual(mine().block, 1, 'die 4 Just Lucky was incorrectly forced through a Scry reveal')

  const luckyScry = { uid: 'private-just-lucky-1', defId: 'just_lucky', upgraded: true }
  mine().hand = [luckyScry]
  mine().draw = [...scryDeck]
  mine().discard = []
  mine().energy = 3
  room.run.combat.die = 1
  let unrevealedLucky = null
  try {
    apply(room, a.token, {
      kind: 'playCard', cardUid: luckyScry.uid, enemyUid: luckyTarget.uid,
      scryDiscardUids: [], preflight: true,
    })
  } catch (error) {
    unrevealedLucky = error
  }
  assertEqual(unrevealedLucky?.name, 'RoomError', 'die 1 Just Lucky bypassed its private Scry reveal')
  const luckyPreview = apply(room, a.token, {
    kind: 'previewCard', cardUid: luckyScry.uid, enemyUid: luckyTarget.uid,
  }).snapshot.cardPreview
  assertEqual(luckyPreview.kind, 'scry')
  assertDeepEqual(luckyPreview.cards.map((card) => card.uid), scryDeck.slice(0, 2).map((card) => card.uid))
  apply(room, a.token, {
    kind: 'playCard', cardUid: luckyScry.uid, enemyUid: luckyTarget.uid,
    scryDiscardUids: [scryDeck[0].uid], preflight: true,
  })
  assertDeepEqual(mine().draw.map((card) => card.uid), scryDeck.slice(1).map((card) => card.uid))

  const dagger = { uid: 'private-dagger-throw', defId: 'dagger_throw', upgraded: false }
  const existing = { uid: 'private-dagger-existing', defId: 'defend_silent', upgraded: false }
  const daggerDraw = { uid: 'private-dagger-draw', defId: 'neutralize', upgraded: false }
  mine().hand = [dagger, existing]
  mine().draw = [daggerDraw]
  mine().discard = []
  mine().energy = 3
  const daggerTarget = room.run.combat.enemies[0]
  Object.assign(daggerTarget, { hp: 10, maxHp: 10, block: 0, dead: false })
  const otherDaggerTarget = room.run.combat.enemies.find((enemy) => enemy.uid !== daggerTarget.uid)
  assert(otherDaggerTarget, 'the Dagger Throw test needs a second enemy')
  Object.assign(otherDaggerTarget, { hp: 10, maxHp: 10, block: 0, dead: false })
  let untargetedPreview = null
  try {
    apply(room, a.token, { kind: 'previewCard', cardUid: dagger.uid })
  } catch (error) {
    untargetedPreview = error
  }
  assertEqual(untargetedPreview?.name, 'RoomError', 'Dagger Throw revealed its draw before choosing a target')
  const daggerPreview = apply(room, a.token, {
    kind: 'previewCard', cardUid: dagger.uid, enemyUid: daggerTarget.uid,
  }).snapshot.cardPreview
  assertDeepEqual(daggerPreview.cards.map((card) => card.uid), [existing.uid, daggerDraw.uid])
  assertEqual(daggerPreview.enemyUid, daggerTarget.uid)
  let retargetedPreview = null
  try {
    apply(room, a.token, {
      kind: 'previewCard', cardUid: dagger.uid, enemyUid: otherDaggerTarget.uid,
    })
  } catch (error) {
    retargetedPreview = error
  }
  assertEqual(retargetedPreview?.name, 'RoomError', 'Dagger Throw changed targets after seeing its draw')
  let retargetedPlay = null
  try {
    apply(room, a.token, {
      kind: 'playCard', cardUid: dagger.uid, enemyUid: otherDaggerTarget.uid,
      discardUids: [daggerDraw.uid], preflight: true,
    })
  } catch (error) {
    retargetedPlay = error
  }
  assertEqual(retargetedPlay?.name, 'RoomError', 'Dagger Throw resolved against a new target after its reveal')
  apply(room, a.token, {
    kind: 'playCard', cardUid: dagger.uid, enemyUid: daggerTarget.uid,
    discardUids: [daggerDraw.uid], preflight: true,
  })
  assertEqual(room.run.combat.enemies.find((enemy) => enemy.uid === daggerTarget.uid).hp, 8,
    'the room lost Dagger Throw\'s target while resolving its private discard')
  assertDeepEqual(mine().hand.map((card) => card.uid), [existing.uid])

  const racingAcrobatics = { uid: 'racing-acrobatics', defId: 'acrobatics', upgraded: false }
  const shuffled = Array.from({ length: 6 }, (_, index) => ({
    uid: `racing-draw-${index}`, defId: 'defend_silent', upgraded: false,
  }))
  mine().hand = [racingAcrobatics]
  mine().draw = []
  mine().discard = shuffled
  mine().energy = 6
  mine().miracles = 1
  const firstPreview = apply(room, a.token, {
    kind: 'previewCard', cardUid: racingAcrobatics.uid, spendMiracle: true,
  })
    .snapshot.cardPreview
  assert(firstPreview.spendMiracle, 'the committed Miracle payment was not saved with the reveal')
  const teammateDraw = { uid: 'teammate-backflip', defId: 'backflip', upgraded: false }
  theirs().hand = [teammateDraw]
  theirs().draw = []
  theirs().discard = Array.from({ length: 6 }, (_, index) => ({
    uid: `teammate-draw-${index}`, defId: 'defend_silent', upgraded: false,
  }))
  theirs().energy = 3
  const rngBefore = JSON.stringify(room.run.combat.rng)
  let raced = null
  try {
    apply(room, b.token, { kind: 'playCard', cardUid: teammateDraw.uid, enemyUid: null })
  } catch (error) {
    raced = error
  }
  assertEqual(raced?.name, 'RoomError', 'a teammate advanced shared RNG during a private reveal')
  assertEqual(JSON.stringify(room.run.combat.rng), rngBefore, 'a refused teammate play advanced shared RNG')
  const currentPreview = previewCardChoice(room.run.combat, a.playerId, racingAcrobatics.uid)
  assertDeepEqual(currentPreview.cards.map((card) => card.uid), firstPreview.cards.map((card) => card.uid),
    'the private preview changed despite the room action lock')
  let changedPayment = null
  try {
    apply(room, a.token, {
      kind: 'playCard', cardUid: racingAcrobatics.uid, enemyUid: null,
      discardUids: [firstPreview.cards[0].uid], spendMiracle: false, preflight: true,
    })
  } catch (error) {
    changedPayment = error
  }
  assertEqual(changedPayment?.name, 'RoomError', 'the player changed Miracle payment after seeing the draw')
  markDisconnected(room, a.token)
  apply(room, b.token, { kind: 'endTurn' })
  assertEqual(room.cardPreviews?.[a.playerId], undefined,
    'a disconnected private reveal permanently blocked the connected party')
  assert(!mine().hand.some((card) => card.uid === racingAcrobatics.uid),
    'the disconnected committed card was not resolved before end turn')
  assertEqual(mine().miracles, 0, 'the disconnected fallback ignored the committed Miracle payment')
  assertEqual(mine().energy, 6, 'the committed Miracle did not pay toward Acrobatics')
})

check('a disconnected reveal resolves without skipping a third connected player', () => {
  const room = createRoom(createStore(), { code: 'THREEA' })
  const a = joinRoom(room, { name: 'Ann', character: 'ironclad' })
  const b = joinRoom(room, { name: 'Bo', character: 'silent' })
  const c = joinRoom(room, { name: 'Cy', character: 'defect' })
  startRun(room, a.token, { seed: 19 })
  enterFirstCombat(room, a.token)
  const mine = () => room.run.combat.players.find((player) => player.id === a.playerId)
  mine().hand = [{ uid: 'three-acrobatics', defId: 'acrobatics', upgraded: false }]
  mine().draw = [0, 1, 2].map((index) => ({
    uid: `three-draw-${index}`, defId: 'defend_silent', upgraded: false,
  }))
  mine().discard = []
  mine().energy = 3
  apply(room, a.token, { kind: 'previewCard', cardUid: 'three-acrobatics' })
  assertEqual(snapshotFor(room, b.token).cardChoicePlayerId, a.playerId,
    'teammates were not told whose private reveal paused the table')
  markDisconnected(room, a.token)
  apply(room, b.token, { kind: 'endTurn' })
  assertEqual(room.run.combat.phase, 'player', 'the disconnected fallback skipped the third player')
  assertEqual(room.cardPreviews?.[a.playerId], undefined, 'the disconnected preview stayed locked')
  assert(!mine().hand.some((card) => card.uid === 'three-acrobatics'), 'the committed card was not resolved')
  assert(snapshotFor(room, b.token).endTurnDecided.includes(b.playerId), 'the connected end-turn vote was lost')
  assert(!snapshotFor(room, b.token).endTurnDecided.includes(c.playerId), 'the third player was marked done')
  joinRoom(room, { token: a.token })
  assertEqual(snapshotFor(room, a.token).cardPreview, undefined, 'reconnect restored an already resolved preview')
})

check('a disconnected Dagger Throw resolves against its committed target', () => {
  const { room, a, b } = twoSeatRoom()
  const player = room.run.combat.players.find((candidate) => candidate.id === a.playerId)
  const dagger = { uid: 'abandoned-dagger', defId: 'dagger_throw', upgraded: false }
  const held = { uid: 'abandoned-held', defId: 'defend_silent', upgraded: false }
  const drawn = { uid: 'abandoned-drawn', defId: 'neutralize', upgraded: false }
  Object.assign(player, { hand: [dagger, held], draw: [drawn], discard: [], energy: 3 })
  const target = room.run.combat.enemies[0]
  Object.assign(target, { hp: 10, maxHp: 10, block: 0, dead: false })
  apply(room, a.token, { kind: 'previewCard', cardUid: dagger.uid, enemyUid: target.uid })
  markDisconnected(room, a.token)
  apply(room, b.token, { kind: 'endTurn' })
  assertEqual(room.run.combat.enemies.find((enemy) => enemy.uid === target.uid).hp, 8,
    'the abandoned Dagger Throw lost its committed target')
  assertEqual(room.cardPreviews?.[a.playerId], undefined, 'the abandoned targeted preview stayed locked')
  const resolvedPlayer = room.run.combat.players.find((candidate) => candidate.id === a.playerId)
  assert(!resolvedPlayer.hand.some((card) => card.uid === dagger.uid), 'the abandoned Dagger Throw stayed in hand')
})

check('a disconnected Prepared+ pays its complete committed discard', () => {
  const { room, a, b } = twoSeatRoom()
  const player = room.run.combat.players.find((candidate) => candidate.id === a.playerId)
  const prepared = { uid: 'abandoned-prepared', defId: 'prepared', upgraded: true }
  const held = { uid: 'abandoned-prepared-held', defId: 'defend_silent', upgraded: false }
  const drawn = [0, 1].map((index) => ({
    uid: `abandoned-prepared-draw-${index}`, defId: 'strike_silent', upgraded: false,
  }))
  Object.assign(player, { hand: [prepared, held], draw: drawn, discard: [], energy: 3 })
  const preview = apply(room, a.token, { kind: 'previewCard', cardUid: prepared.uid }).snapshot.cardPreview
  assertDeepEqual(preview.cards.map((card) => card.uid), [held.uid, ...drawn.map((card) => card.uid)])
  markDisconnected(room, a.token)
  apply(room, b.token, { kind: 'endTurn' })
  const resolved = room.run.combat.players.find((candidate) => candidate.id === a.playerId)
  assertEqual(room.cardPreviews?.[a.playerId], undefined, 'the abandoned Prepared+ stayed locked')
  // Nothing left to arrange, so the turn discards the remainder rather than
  // parking on a prompt the disconnected seat could not answer anyway.
  assertDeepEqual(resolved.hand.map((card) => card.uid), [])
  assertDeepEqual(resolved.discard.map((card) => card.uid),
    [held.uid, drawn[0].uid, prepared.uid, drawn[1].uid])
})

// The act's boss is rolled in the open at setup, so the map may name it. The
// Ascension 13 SECOND Act III boss is not — it is drawn when the first falls.
check('this act\'s boss is public and the reserved one is not', () => {
  const { room, a } = twoSeatRoom()
  room.run.pendingBossDefId = 'time_eater'
  const snapshot = snapshotFor(room, a.token)
  assertEqual(snapshot.run.actBossDefId, room.run.actBossDefId, 'the map could not name the act boss')
  assert(snapshot.run.actBossDefId, 'no boss was rolled with the act map')
  assertEqual(snapshot.run.pendingBossDefId, null, 'the reserved second boss leaked')
  assert(!allStrings(snapshot).includes('time_eater'), 'the reserved second boss leaked by value')
})

check('the rng state never reaches a client', () => {
  // Leaking this predicts every future die roll and shuffle, and no player
  // could tell from the table that it had happened.
  const { room, a } = twoSeatRoom()
  const keys = allKeys(snapshotFor(room, a.token))
  assert(!keys.includes('rng'), 'the rng state was serialised to a client')
  assert(!keys.includes('seed'), 'the run seed was serialised to a client')
})

check('pile sizes are still visible — they are public at a real table', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  actor.orbEvokeBonus = 2
  actor.darkOrbEvokeBonus = 5
  actor.orbEndTurnBonus = 3
  actor.lightningEndTurnBonus = 4
  const snapshot = snapshotFor(room, a.token)
  for (const player of snapshot.run.combat.players) {
    assert(typeof player.drawCount === 'number', 'draw pile size is missing')
    assert(typeof player.handCount === 'number', 'hand size is missing')
  }
  const ownerView = snapshot.run.combat.players.find((player) => player.id === a.playerId)
  const peerView = snapshotFor(room, b.token).run.combat.players
    .find((player) => player.id === a.playerId)
  assertEqual(ownerView.orbEvokeBonus, 2, 'owner reconnect lost the face-up Orb Evoke bonus')
  assertEqual(ownerView.darkOrbEvokeBonus, 5, 'owner reconnect lost the face-up Dark Orb Evoke bonus')
  assertEqual(ownerView.orbEndTurnBonus, 3, 'owner reconnect lost the face-up Orb end-turn bonus')
  assertEqual(ownerView.lightningEndTurnBonus, 4,
    'owner reconnect lost the face-up Lightning end-turn bonus')
  assertEqual(peerView.orbEvokeBonus, 2, 'teammate could not see the face-up Orb Evoke bonus')
  assertEqual(peerView.darkOrbEvokeBonus, 5, 'teammate could not see the face-up Dark Orb Evoke bonus')
  assertEqual(peerView.orbEndTurnBonus, 3, 'teammate could not see the face-up Orb end-turn bonus')
  assertEqual(peerView.lightningEndTurnBonus, 4,
    'teammate could not see the face-up Lightning end-turn bonus')
  const other = snapshot.run.combat.players.find((player) => player.id !== a.playerId)
  assert(other.handCount > 0, "another player's hand size should be visible")
})

check('discard and exhaust piles stay public — they are face up', () => {
  const { room, a } = twoSeatRoom()
  const snapshot = snapshotFor(room, a.token)
  for (const player of snapshot.run.combat.players) {
    assert(Array.isArray(player.discard), 'discard pile was hidden')
    assert(Array.isArray(player.exhaust), 'exhaust pile was hidden')
  }
})

check('a spectator with no token sees nobody\'s hand', () => {
  const { room } = twoSeatRoom()
  const snapshot = snapshotFor(room, 'not-a-real-token')
  assertEqual(snapshot.you, null, 'an unknown token was given a seat')
  for (const player of snapshot.run.combat.players) {
    assertEqual(player.hand, null, 'a spectator could see a hand')
  }
})

suite('secrets that are not game state')

check('no function but joinRoom ever returns a seat token', () => {
  // room.seats[].token is a bearer credential. The room object carries every
  // seat's, so any mutator that hands the room back is one careless send away
  // from total seat impersonation.
  const store = createStore()
  const room = createRoom(store, { code: 'AAAAAG' })
  const a = joinRoom(room, { character: 'ironclad' })
  const b = joinRoom(room, { character: 'silent' })
  const tokens = [a.token, b.token]

  const returned = [
    chooseCharacter(room, a.token, 'defect'),
    markDisconnected(room, b.token),
    startRun(room, a.token, { seed: 5 }),
  ]
  for (const value of returned) {
    const seen = new Set(allStrings(value))
    for (const token of tokens) {
      assert(!seen.has(token), 'a mutator returned a value containing a seat token')
    }
  }

  finishNeow(room)
  const acted = apply(room, a.token, { kind: 'enterRoom', roomId: roomChoices(room.run)[0].id })
  const seen = new Set(allStrings(acted))
  for (const token of tokens) {
    assert(!seen.has(token), 'apply() returned a value containing a seat token')
  }
})

check('room codes are drawn without modulo bias', () => {
  // Deterministic, not statistical: the byte source walks 0-255 forever, so
  // this is the same computation every run and cannot flake. A plain modulo
  // over 26 symbols favours the first 22 by about 11%; rejection sampling
  // brings the spread down to the ~4% left by where the stream stops.
  //
  // Measured on this exact input: fair 1.039, biased 1.111. The gate sits
  // between them, so deleting the rejection fails immediately.
  let next = 0
  const everyByte = (count) => Buffer.from(Array.from({ length: count }, () => next++ % 256))

  const counts = new Map()
  for (let i = 0; i < 20000; i++) {
    for (const glyph of roomCode(everyByte)) counts.set(glyph, (counts.get(glyph) ?? 0) + 1)
  }

  const tallies = [...counts.values()]
  assertEqual(counts.size, 26, 'every glyph in the alphabet should be reachable')
  const ratio = Math.max(...tallies) / Math.min(...tallies)
  assert(ratio < 1.07, `glyph frequencies are skewed by ${((ratio - 1) * 100).toFixed(1)}%`)
})

check('a room code cannot silently replace a live room', () => {
  const store = createStore()
  const room = createRoom(store, { code: 'AAAAAH' })
  joinRoom(room, { character: 'ironclad' })
  let threw = false
  try {
    createRoom(store, { code: 'AAAAAH' })
  } catch {
    threw = true
  }
  assert(threw, 'a second room took the code and dropped everyone seated in the first')
  assertEqual(store.rooms.get('AAAAAH').seats.length, 1, 'the original room survives')
})

suite('action authorisation')

check("a seat cannot play a card from another seat's hand", () => {
  const { room, a, b } = twoSeatRoom()
  const victim = room.run.combat.players.find((player) => player.id === b.playerId)
  const stolen = victim.hand[0]
  const handBefore = victim.hand.length

  let threw = false
  try {
    apply(room, a.token, { kind: 'playCard', cardUid: stolen.uid })
  } catch {
    threw = true
  }
  assert(threw, "one seat played another seat's card")
  const after = room.run.combat.players.find((player) => player.id === b.playerId)
  assertEqual(after.hand.length, handBefore, "the victim's hand changed")
})

check('an unclaimed token cannot start the run', () => {
  // Every other authorisation rule here is tested; this one was not, and the
  // run is the thing that locks in the party.
  const store = createStore()
  const room = createRoom(store, { code: 'AAAAAJ' })
  joinRoom(room, { character: 'ironclad' })
  let threw = false
  try {
    startRun(room, 'forged', { seed: 3 })
  } catch {
    threw = true
  }
  assert(threw, 'a stranger started the run')
  assertEqual(room.phase, 'lobby', 'and the room is still in the lobby')
})

check('a dropped seat is actually marked disconnected', () => {
  // The reconnect tests only assert the seat comes back CONNECTED, which holds
  // whether or not it was ever marked otherwise.
  const { room, a } = twoSeatRoom()
  markDisconnected(room, a.token)
  const seat = room.seats.find((other) => other.playerId === a.playerId)
  assertEqual(seat.connected, false, 'the seat should read as disconnected')
})

check('the whole play context reaches the engine, not just the target', () => {
  // Scry and per-evoke enemy picks are real choices the rules grant (p.24,
  // p.16). Dropped in dispatch, a Scry silently bins nothing and an orb evoke
  // always falls back to the first filled slot.
  const { room, a, b } = twoSeatRoom()
  const mine = () => room.run.combat.players.find((player) => player.id === a.playerId)

  CARDS.fixture_room_scry = {
    id: 'fixture_room_scry',
    name: 'Fixture Room Scry',
    owner: 'watcher',
    type: 'skill',
    rarity: 'common',
    cost: 0,
    effects: [{ kind: 'scry', amount: 2 }],
  }
  const scryCard = { uid: 'fx-scry', defId: 'fixture_room_scry', upgraded: false }
  mine().hand.push(scryCard)
  const topTwo = mine().draw.slice(0, 2).map((card) => card.uid)
  const discardBefore = mine().discard.length

  apply(room, a.token, { kind: 'previewCard', cardUid: scryCard.uid })
  apply(room, a.token, {
    kind: 'playCard',
    cardUid: scryCard.uid,
    enemyUid: null,
    scryDiscardUids: topTwo,
  })
  assertEqual(mine().discard.length, discardBefore + 3, 'both scryed cards were binned, plus the card itself')

  CARDS.fixture_room_evoke = {
    id: 'fixture_room_evoke',
    name: 'Fixture Room Evoke',
    owner: 'defect',
    type: 'skill',
    rarity: 'common',
    cost: 0,
    effects: [{ kind: 'evoke', times: 2 }],
  }
  const evokeCard = { uid: 'fx-evoke', defId: 'fixture_room_evoke', upgraded: false }
  mine().hand.push(evokeCard)
  mine().orbs = ['lightning', 'frost', 'dark']
  const [lightningTarget, darkTarget] = room.run.combat.enemies
  Object.assign(lightningTarget, { hp: 20, maxHp: 20, block: 0, dead: false })
  Object.assign(darkTarget, { hp: 20, maxHp: 20, block: 0, dead: false })

  apply(room, a.token, {
    kind: 'playCard',
    cardUid: evokeCard.uid,
    enemyUid: null,
    evokeSlots: [2],
    evokeEnemyUids: [darkTarget.uid, lightningTarget.uid],
  })
  assertDeepEqual(mine().orbs, ['lightning', 'frost', null], 'the chosen Orb slot reached the engine')
  assertDeepEqual(
    room.run.combat.enemies.slice(0, 2).map((target) => target.hp),
    [17, 17],
    'each repeated Evoke reached its own enemy',
  )

  const recursion = { uid: 'fx-recursion', defId: 'recursion', upgraded: false }
  mine().hand.push(recursion)
  mine().orbs = ['lightning', 'frost', 'dark']
  mine().energy = 3
  const recursionTarget = room.run.combat.enemies[0]
  Object.assign(recursionTarget, { hp: 20, maxHp: 20, block: 0, dead: false })
  apply(room, a.token, {
    kind: 'playCard', cardUid: recursion.uid, enemyUid: null,
    evokeSlots: [2], evokeEnemyUids: [recursionTarget.uid],
  })
  assertDeepEqual(mine().orbs, ['lightning', 'frost', 'dark'], 'Recursion re-channelled the chosen Dark')
  assertEqual(room.run.combat.enemies[0].hp, 17, 'the room forwarded Recursion\'s exact target')

  const flex = { uid: 'fx-flex', defId: 'flex', upgraded: false }
  const anger = { uid: 'fx-anger', defId: 'anger', upgraded: false }
  mine().hand.push(flex, anger)
  mine().draw = [{ uid: 'fx-spare', defId: 'defend_ironclad', upgraded: false }]
  mine().strength = 0
  mine().strengthLossAtEndOfTurn = 0
  apply(room, a.token, { kind: 'playCard', cardUid: flex.uid, enemyUid: null })
  const angerTarget = room.run.combat.enemies[0]
  Object.assign(angerTarget, { hp: 20, maxHp: 20, block: 0, dead: false })
  apply(room, a.token, { kind: 'playCard', cardUid: anger.uid, enemyUid: angerTarget.uid })
  assert(mine().exhaust.some((card) => card.uid === flex.uid), 'Flex did not Exhaust through the room')
  assertEqual(mine().draw[0].uid, anger.uid, 'Anger did not return to draw top through the room')
  assertEqual(room.run.combat.enemies[0].hp, 18, 'Flex Strength should boost Anger')
  mine().strength = 0
  mine().strengthLossAtEndOfTurn = 0

  const ironWave = { uid: 'fx-iron-wave', defId: 'iron_wave', upgraded: true }
  mine().hand.push(ironWave)
  mine().energy = 3
  const ironWaveTarget = room.run.combat.enemies[0]
  Object.assign(ironWaveTarget, { hp: 20, maxHp: 20, block: 0, dead: false })
  const missingMode = apply(room, a.token, {
    kind: 'playCard', cardUid: ironWave.uid, enemyUid: ironWaveTarget.uid,
  })
  assertEqual(missingMode.changed, false, 'a modal play without a choice must be refused')
  const malformedMode = apply(room, a.token, {
    kind: 'playCard', cardUid: ironWave.uid, enemyUid: ironWaveTarget.uid, mode: '1',
  })
  assertEqual(malformedMode.changed, false, 'a non-numeric mode must be refused')
  apply(room, a.token, {
    kind: 'playCard', cardUid: ironWave.uid, enemyUid: ironWaveTarget.uid, mode: 1,
  })
  assertEqual(
    room.run.combat.enemies.find((enemy) => enemy.uid === ironWaveTarget.uid).hp,
    19,
    'the room forwarded Iron Wave damage mode',
  )
  assertEqual(mine().block, 2, 'the room forwarded Iron Wave Block mode')
  assertEqual(mine().energy, 2, 'the room charged Iron Wave')

  const dance = { uid: 'fx-overflow-shivs', defId: 'blade_dance', upgraded: false }
  mine().hand.push(dance)
  mine().energy = 3
  mine().shivs = 4
  room.run.combat.players.find((player) => player.id === b.playerId).shivs = 1
  const [firstEnemy, secondEnemy] = room.run.combat.enemies
  Object.assign(firstEnemy, { hp: 1, maxHp: 1, block: 0, dead: false })
  Object.assign(secondEnemy, { hp: 5, maxHp: 5, block: 0, dead: false })
  let changedSupply = null
  try {
    apply(room, a.token, {
      kind: 'playCard',
      cardUid: dance.uid,
      expectedShivOverflow: 1,
      shivEnemyUids: [firstEnemy.uid],
    })
  } catch (error) {
    changedSupply = error
  }
  assertEqual(changedSupply?.name, 'RoomError', 'a changed shared supply must restart card targeting')
  let refusedOverflow = null
  try {
    apply(room, a.token, {
      kind: 'playCard',
      cardUid: dance.uid,
      expectedShivOverflow: 2,
      shivEnemyUids: [firstEnemy.uid, firstEnemy.uid],
    })
  } catch (error) {
    refusedOverflow = error
  }
  assertEqual(refusedOverflow?.name, 'RoomError', 'a queued Shiv cannot disappear into an already-killed target')
  assert(refusedOverflow.message.includes('earlier overflow Shiv defeated a later target'))
  apply(room, a.token, {
    kind: 'playCard',
    cardUid: dance.uid,
    expectedShivOverflow: 2,
    shivEnemyUids: [firstEnemy.uid, secondEnemy.uid],
  })
  assert(room.run.combat.enemies[0].dead, 'the first chosen overflow Shiv target survives the room boundary')
  assertEqual(room.run.combat.enemies[1].hp, 4, 'the second overflow Shiv keeps its own chosen target')

  const skippedDance = { uid: 'fx-skipped-overflow-shivs', defId: 'blade_dance', upgraded: false }
  mine().hand.push(skippedDance)
  apply(room, a.token, {
    kind: 'playCard',
    cardUid: skippedDance.uid,
    expectedShivOverflow: 2,
    skipOverflow: true,
    shivEnemyUids: [secondEnemy.uid],
  })
  assertEqual(room.run.combat.enemies[1].hp, 3, 'explicit skip keeps only the chosen card overflow attacks')
})

check('Electrodynamics row evokes stay server-authoritative and reconnect-visible', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const dual = { uid: 'room-electro-dual', defId: 'dual_cast', upgraded: false }
  Object.assign(actor, {
    character: 'defect', hand: [dual], energy: 1,
    powers: [{ uid: 'room-electro-power', defId: 'electrodynamics', upgraded: false }],
    orbs: ['lightning', 'lightning', null],
  })
  const [front, back] = room.run.combat.enemies
  Object.assign(front, { row: 0, hp: 20, maxHp: 20, block: 0, dead: false })
  Object.assign(back, { row: 1, hp: 20, maxHp: 20, block: 0, dead: false })

  const forged = structuredClone(room)
  let refused = null
  try {
    apply(forged, a.token, {
      kind: 'playCard', cardUid: dual.uid, evokeSlots: [0],
      evokeEnemyUids: [front.uid, back.uid], preflight: true,
    })
  } catch (error) {
    refused = error
  }
  assertEqual(refused?.name, 'RoomError', 'the server accepted single-enemy Electrodynamics targets')

  apply(room, a.token, {
    kind: 'playCard', cardUid: dual.uid, evokeSlots: [0],
    evokeEnemyUids: [lightningRowTarget(0), lightningRowTarget(1)], preflight: true,
  })
  assertDeepEqual(room.run.combat.enemies.slice(0, 2).map((enemy) => enemy.hp), [18, 18])
  const rejoined = joinRoom(room, { token: a.token })
  const owner = snapshotFor(room, rejoined.token).run.combat.players
    .find((player) => player.id === a.playerId)
  const peer = snapshotFor(room, b.token).run.combat.players
    .find((player) => player.id === a.playerId)
  assert(owner.powers.some((power) => power.defId === 'electrodynamics'))
  assert(peer.powers.some((power) => power.defId === 'electrodynamics'))
})

check('Fission choices stay server-authoritative and its draws remain private after reconnect', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const fission = { uid: 'room-fission', defId: 'fission', upgraded: true }
  const drawn = [
    { uid: 'room-fission-draw-a', defId: 'strike_defect', upgraded: false },
    { uid: 'room-fission-draw-b', defId: 'defend_defect', upgraded: false },
    { uid: 'room-fission-draw-c', defId: 'zap', upgraded: false },
  ]
  Object.assign(actor, {
    character: 'defect', hand: [fission], draw: drawn, discard: [], exhaust: [], energy: 0,
    orbs: ['lightning', 'frost', 'dark'],
  })
  const [first, second] = room.run.combat.enemies
  Object.assign(first, { hp: 20, maxHp: 20, block: 0, dead: false })
  Object.assign(second, { hp: 20, maxHp: 20, block: 0, dead: false })

  let refused = null
  try {
    apply(room, a.token, {
      kind: 'playCard', cardUid: fission.uid, evokeSlots: [0, 1],
      evokeEnemyUids: [first.uid, null], preflight: true,
    })
  } catch (error) {
    refused = error
  }
  assertEqual(refused?.name, 'RoomError', 'the server accepted a partial Fission+ Orb plan')

  apply(room, a.token, {
    kind: 'playCard', cardUid: fission.uid, evokeSlots: [0, 1, 2],
    evokeEnemyUids: [first.uid, null, second.uid], preflight: true,
  })
  const owner = snapshotFor(room, joinRoom(room, { token: a.token }).token).run.combat.players
    .find((player) => player.id === a.playerId)
  const peer = snapshotFor(room, b.token).run.combat.players
    .find((player) => player.id === a.playerId)
  assertDeepEqual(owner.orbs, [null, null, null])
  assertEqual(owner.energy, 3)
  assertEqual(owner.hand.length, 3)
  assert(owner.exhaust.some((card) => card.uid === fission.uid))
  assertEqual(peer.hand, null)
  assertEqual(peer.handCount, 3)
  assert(!allStrings(snapshotFor(room, b.token)).some((value) => value.startsWith('room-fission-draw-')),
    'Fission leaked its draws to a teammate')
})

check('Multi-Cast keeps one Orb choice and every repeated target server-authoritative', () => {
  const { room, a } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const card = { uid: 'room-multi-cast', defId: 'multi_cast', upgraded: true }
  Object.assign(actor, {
    character: 'defect', hand: [card], energy: 2, orbs: ['dark', 'frost', 'lightning'],
  })
  const [first, second] = room.run.combat.enemies
  Object.assign(first, { defId: 'cultist', hp: 20, maxHp: 20, block: 0, dead: false })
  Object.assign(second, { defId: 'cultist', hp: 20, maxHp: 20, block: 0, dead: false })

  let refused = null
  try {
    apply(room, a.token, {
      kind: 'playCard', cardUid: card.uid, energySpent: 2, evokeSlots: [0],
      evokeEnemyUids: [first.uid, second.uid], preflight: true,
    })
  } catch (error) {
    refused = error
  }
  assertEqual(refused?.name, 'RoomError', 'the server accepted a missing Multi-Cast+ target')

  apply(room, a.token, {
    kind: 'playCard', cardUid: card.uid, energySpent: 2, evokeSlots: [0],
    evokeEnemyUids: [first.uid, second.uid, second.uid], preflight: true,
  })
  const resolved = room.run.combat.players.find((player) => player.id === a.playerId)
  assertDeepEqual(resolved.orbs, [null, 'frost', 'lightning'])
  assertEqual(resolved.energy, 0)
  assertDeepEqual(room.run.combat.enemies.slice(0, 2).map((enemy) => enemy.hp), [17, 14])
  assert(resolved.discard.some((held) => held.uid === card.uid))
})

check('an Echo Form Multi-Cast copy cannot forge its original Energy payment', () => {
  const { room, a } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const card = { uid: 'room-copy-multi-cast', defId: 'multi_cast', upgraded: true }
  Object.assign(actor, {
    character: 'defect', hand: [], energy: 0, orbs: ['dark', 'frost', 'lightning'],
  })
  const [first, second] = room.run.combat.enemies
  Object.assign(first, { defId: 'cultist', hp: 20, maxHp: 20, block: 0, dead: false })
  Object.assign(second, { defId: 'cultist', hp: 20, maxHp: 20, block: 0, dead: false })
  room.run.combat.phase = 'copy'
  room.run.combat.pendingCardCopy = {
    playerId: actor.id, card, energySpent: 2, resumePhase: 'player', forcedExhaust: false,
    forcedChoices: null, deferredHavocs: [], sourceNames: ['Echo Form'],
  }

  let refused = null
  try {
    apply(room, a.token, {
      kind: 'playCardCopy', cardUid: card.uid, energySpent: 0,
      evokeSlots: [], evokeEnemyUids: [], preflight: true,
    })
  } catch (error) {
    refused = error
  }
  assertEqual(refused?.name, 'RoomError', 'a forged zero-Energy copy skipped its Evoke choices')

  apply(room, a.token, {
    kind: 'playCardCopy', cardUid: card.uid, energySpent: 0, evokeSlots: [0],
    evokeEnemyUids: [first.uid, second.uid, second.uid], preflight: true,
  })
  const resolved = room.run.combat.players.find((player) => player.id === actor.id)
  assertDeepEqual(resolved.orbs, [null, 'frost', 'lightning'])
  assertDeepEqual(room.run.combat.enemies.slice(0, 2).map((enemy) => enemy.hp), [17, 14])
  assertEqual(room.run.combat.phase, 'player')
})

check('Seek keeps the draw pile and searched cards private and server-authoritative', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const seek = { uid: 'room-seek', defId: 'seek', upgraded: true }
  const hidden = [
    { uid: 'room-seek-a', defId: 'strike_defect', upgraded: false },
    { uid: 'room-seek-b', defId: 'defend_defect', upgraded: false },
    { uid: 'room-seek-c', defId: 'zap', upgraded: false },
  ]
  Object.assign(actor, {
    character: 'defect', hand: [seek], draw: hidden, discard: [], exhaust: [], energy: 0,
  })

  const preview = apply(room, a.token, { kind: 'previewCard', cardUid: seek.uid }).snapshot.cardPreview
  assertEqual(preview.kind, 'search')
  assertDeepEqual(preview.cards.map((card) => card.uid), hidden.map((card) => card.uid))
  for (const card of hidden) {
    assert(!allStrings(snapshotFor(room, b.token)).includes(card.uid), `${card.uid} leaked to a teammate`)
  }

  let refused = null
  try {
    apply(room, a.token, {
      kind: 'playCard', cardUid: seek.uid, searchDrawUids: [hidden[0].uid, 'forged'], preflight: true,
    })
  } catch (error) {
    refused = error
  }
  assertEqual(refused?.name, 'RoomError', 'Seek accepted a card outside its private preview')

  apply(room, a.token, {
    kind: 'playCard', cardUid: seek.uid,
    searchDrawUids: [hidden[2].uid, hidden[0].uid], preflight: true,
  })
  const owner = snapshotFor(room, a.token).run.combat.players.find((player) => player.id === actor.id)
  const peer = snapshotFor(room, b.token).run.combat.players.find((player) => player.id === actor.id)
  assertDeepEqual(owner.hand.map((card) => card.uid), [hidden[2].uid, hidden[0].uid])
  assertEqual(owner.drawCount, 1)
  assert(owner.exhaust.some((card) => card.uid === seek.uid))
  assertEqual(peer.hand, null)
  assertEqual(peer.handCount, 2)
  assert(!allStrings(snapshotFor(room, b.token)).some((value) => value.startsWith('room-seek-')),
    'the searched cards leaked after resolution')
})

check('an unknown token cannot act at all', () => {
  const { room } = twoSeatRoom()
  let threw = false
  try {
    apply(room, 'forged', { kind: 'endTurn' })
  } catch {
    threw = true
  }
  assert(threw, 'an unauthenticated client mutated the game')
})

check('a legal play is accepted and bumps the version', () => {
  const { room, a } = twoSeatRoom()
  const me = room.run.combat.players.find((player) => player.id === a.playerId)
  const strike = me.hand.find((card) => card.defId.startsWith('strike'))
  assert(strike, 'precondition: a starting hand should hold a Strike')
  const enemy = room.run.combat.enemies[0]
  const before = room.version

  const result = apply(room, a.token, { kind: 'playCard', cardUid: strike.uid, enemyUid: enemy.uid })
  assert(result.changed, 'a legal play was rejected')
  assert(room.version > before, 'an accepted action did not bump the version')
})

check('an action the engine refuses does NOT bump the version', () => {
  // The engine signals refusal by returning the same state reference. If that
  // still bumped the version, every illegal click would wake all four clients.
  //
  // Zero Energy is the cleanest refusal to provoke: the card is in hand and
  // legal in every way except that it cannot be paid for.
  const { room, a } = twoSeatRoom()
  const enemy = room.run.combat.enemies[0]
  const mine = () => room.run.combat.players.find((player) => player.id === a.playerId)

  mine().energy = 0
  assertEqual(mine().energy, 0, 'precondition: energy should be spent')

  // Every card costs at least 1, so with no Energy left any of them is refused.
  const leftover = mine().hand[0]
  assert(leftover, 'precondition: a card should remain in hand')
  const before = room.version
  const result = apply(room, a.token, { kind: 'playCard', cardUid: leftover.uid, enemyUid: enemy.uid })
  assertEqual(result.changed, false, 'a card was played with no energy')
  assertEqual(room.version, before, 'a refused action bumped the version')
})

check('an attack with no enemy chosen is refused, not silently wasted', () => {
  // Straight off the network, so the engine cannot assume the client filtered
  // it. Before this was checked the card cost its Energy, went to the discard
  // pile and dealt nothing.
  const { room, a } = twoSeatRoom()
  const mine = () => room.run.combat.players.find((player) => player.id === a.playerId)
  const strike = mine().hand.find((card) => card.defId.startsWith('strike'))
  const energyBefore = mine().energy
  const handBefore = mine().hand.length

  const result = apply(room, a.token, { kind: 'playCard', cardUid: strike.uid, enemyUid: null })
  assertEqual(result.changed, false, 'the play should have been refused')
  assertEqual(mine().energy, energyBefore, 'no Energy should have been spent')
  assertEqual(mine().hand.length, handBefore, 'the card should still be in hand')

  // A uid that names no living enemy is the case that actually happens in
  // play: the enemy died between the board rendering and the click landing.
  const stale = apply(room, a.token, { kind: 'playCard', cardUid: strike.uid, enemyUid: 'no-such-enemy' })
  assertEqual(stale.changed, false, 'an unknown enemy uid should be refused too')
  let previewedCard = null
  try {
    apply(room, a.token, {
      kind: 'playCard',
      cardUid: strike.uid,
      enemyUid: 'no-such-enemy',
      preflight: true,
    })
  } catch (error) {
    previewedCard = error
  }
  assertEqual(previewedCard?.name, 'RoomError', 'a previewed stale card gets an actionable refusal')

  const corpse = room.run.combat.enemies[0]
  corpse.dead = true
  const atCorpse = apply(room, a.token, { kind: 'playCard', cardUid: strike.uid, enemyUid: corpse.uid })
  assertEqual(atCorpse.changed, false, 'a dead enemy is not a target')
  assertEqual(mine().energy, energyBefore, 'and still no Energy was spent')
})

check('a card that hits every enemy needs no chosen target', () => {
  // The refusal above must not overreach. An all-enemies card names no single
  // enemy by design, so requiring one would make it unplayable.
  const { room, a } = twoSeatRoom()
  CARDS.fixture_cleave = {
    id: 'fixture_cleave',
    name: 'Fixture Cleave',
    owner: 'ironclad',
    type: 'attack',
    rarity: 'common',
    cost: 0,
    target: 'allEnemies',
    effects: [{ kind: 'damage', amount: 1 }],
  }
  const mine = room.run.combat.players.find((player) => player.id === a.playerId)
  const card = { uid: 'fx-cleave', defId: 'fixture_cleave', upgraded: false }
  mine.hand.push(card)
  const hpBefore = room.run.combat.enemies.map((foe) => foe.hp)

  const result = apply(room, a.token, { kind: 'playCard', cardUid: card.uid, enemyUid: null })
  assert(result.changed, 'an all-enemies card was wrongly refused for having no target')
  const hpAfter = room.run.combat.enemies.map((foe) => foe.hp)
  for (let i = 0; i < hpBefore.length; i++) {
    assertEqual(hpAfter[i], hpBefore[i] - 1, `enemy ${i} should have been hit`)
  }
})

check('every enemy-facing effect needs a target, not just the damaging ones', () => {
  // The list of effects that require an enemy had only two of its six entries
  // pinned; the other four could be deleted with the suite still green.
  const ENEMY_FACING = [
    { kind: 'hit', amount: 1 },
    { kind: 'damage', amount: 1 },
    { kind: 'loseHp', amount: 1 },
    { kind: 'applyWeak', amount: 1 },
    { kind: 'applyVulnerable', amount: 1 },
    { kind: 'poison', amount: 1 },
  ]

  for (const effect of ENEMY_FACING) {
    const { room, a } = twoSeatRoom()
    CARDS.fixture_needs_target = {
      id: 'fixture_needs_target',
      name: 'Fixture Needs Target',
      owner: 'ironclad',
      type: 'skill',
      rarity: 'common',
      cost: 0,
      effects: [effect],
    }
    const mine = () => room.run.combat.players.find((player) => player.id === a.playerId)
    const card = { uid: `fx-${effect.kind}`, defId: 'fixture_needs_target', upgraded: false }
    mine().hand.push(card)
    const energyBefore = mine().energy

    const refused = apply(room, a.token, { kind: 'playCard', cardUid: card.uid, enemyUid: null })
    assertEqual(refused.changed, false, `${effect.kind} with no target should be refused`)
    assertEqual(mine().energy, energyBefore, `${effect.kind} should have cost nothing`)

    const landed = apply(room, a.token, {
      kind: 'playCard',
      cardUid: card.uid,
      enemyUid: room.run.combat.enemies[0].uid,
    })
    assert(landed.changed, `${effect.kind} should work when pointed at an enemy`)
  }
})

check('the UI and the engine agree on which cards need a target', () => {
  // cardNeedsEnemy is exported precisely so the prompt matches the rule. If
  // they drift, the UI collects a target the engine then discards — or worse,
  // refuses a play the UI offered.
  const sweeping = {
    id: 'x',
    name: 'X',
    owner: 'ironclad',
    type: 'attack',
    rarity: 'common',
    cost: 0,
    target: 'allEnemies',
    effects: [{ kind: 'damage', amount: 1 }],
  }
  assertEqual(cardNeedsEnemy(sweeping), false, 'an all-enemies card names no single target')
  assertEqual(
    cardNeedsEnemy({ ...sweeping, target: undefined }),
    true,
    'but the same card single-target does',
  )
  assertEqual(
    cardNeedsEnemy({ ...sweeping, type: 'power', trigger: { kind: 'endOfTurn' }, target: undefined }),
    false,
    'and a Power resolves nothing on play, so it needs nothing',
  )
})

suite('the campfire')

/** Parks the party on the first campfire in the act. */
function atCampfire(room) {
  const campfire = Object.values(room.run.map.rooms).find((entry) => entry.kind === 'campfire')
  assert(campfire, 'precondition: the act should contain a campfire')
  room.run.phase = 'room'
  room.run.map.position = campfire.id
  room.run.combat = null
  return campfire
}

check('nobody leaves the campfire until everyone has chosen', () => {
  // Each player chooses independently (p.9) and the party leaves together.
  // Two ways to get this wrong, and both were: letting one seat submit
  // everybody's choices, and resolving on the first message so the first
  // clicker heals alone and drags the party out of the room.
  const { room, a, b } = twoSeatRoom()
  atCampfire(room)
  for (const player of room.run.players) player.hp = 4

  const theirCard = room.run.players
    .find((player) => player.id === b.playerId)
    .deck.find((card) => !card.upgraded)

  // Ann chooses Rest, and also tries to Smith one of Bo's cards.
  const first = apply(room, a.token, {
    kind: 'campfire',
    choices: {
      [a.playerId]: { choice: 'rest' },
      [b.playerId]: { choice: 'smith', cardUid: theirCard.uid },
    },
  })
  assertEqual(room.run.phase, 'room', 'the party has not left yet')
  assertDeepEqual(first.waitingOn, [b.playerId], 'and the table is waiting on Bo')
  assertEqual(room.run.players[0].hp, 4, 'nothing is applied until everyone has chosen')

  apply(room, b.token, { kind: 'campfire', choices: { [b.playerId]: { choice: 'rest' } } })
  assertEqual(room.run.phase, 'map', 'now the party leaves together')
  assertEqual(room.run.players[0].hp, 7, 'Ann rested')
  assertEqual(room.run.players[1].hp, 7, 'Bo rested, as HE chose')

  const bosCard = room.run.players
    .find((player) => player.id === b.playerId)
    .deck.find((card) => card.uid === theirCard.uid)
  assert(!bosCard.upgraded, "Ann's forged choice for Bo was ignored")
})

check('Coffee Dripper plus Fusion Hammer can leave without stranding the party', () => {
  const { room, a, b } = twoSeatRoom()
  atCampfire(room)
  const actor = room.run.players.find((player) => player.id === a.playerId)
  actor.relics.push({ defId: 'coffee_dripper', spent: false }, { defId: 'fusion_hammer', spent: false })
  apply(room, a.token, { kind: 'campfire', choices: { [a.playerId]: { choice: 'leave' } } })
  apply(room, b.token, { kind: 'campfire', choices: { [b.playerId]: { choice: 'rest' } } })
  assertEqual(room.run.phase, 'map')
})

check('Coffee Dripper can leave when a fully upgraded deck blocks Smithing', () => {
  const { room, a, b } = twoSeatRoom()
  atCampfire(room)
  const actor = room.run.players.find((player) => player.id === a.playerId)
  actor.relics.push({ defId: 'coffee_dripper', spent: false })
  actor.deck = actor.deck.map((card) => ({ ...card, upgraded: true }))
  actor.deck.push({ uid: 'campfire-curse', defId: 'regret', upgraded: false })
  apply(room, a.token, { kind: 'campfire', choices: { [a.playerId]: { choice: 'leave' } } })
  apply(room, b.token, { kind: 'campfire', choices: { [b.playerId]: { choice: 'rest' } } })
  assertEqual(room.run.phase, 'map')
})

check('Night Terrors rejects Rest without clearing another valid campfire choice', () => {
  const { room, a, b } = twoSeatRoom()
  atCampfire(room)
  room.run.meta = { mode: 'custom', modifierIds: ['night_terrors'] }
  const firstCard = room.run.players.find((player) => player.id === a.playerId).deck
    .find((card) => !card.upgraded)
  apply(room, a.token, {
    kind: 'campfire', choices: { [a.playerId]: { choice: 'smith', cardUid: firstCard.uid } },
  })
  const version = room.version
  let refused
  try {
    apply(room, b.token, { kind: 'campfire', choices: { [b.playerId]: { choice: 'rest' } } })
  } catch (error) { refused = error }
  assertEqual(refused?.name, 'RoomError')
  assertEqual(room.version, version, 'a rejected Rest changed the room version')
  assertDeepEqual(snapshotFor(room, b.token).campfireDecided, [a.playerId], 'the valid Smith choice was cleared')
  const secondCard = room.run.players.find((player) => player.id === b.playerId).deck
    .find((card) => !card.upgraded)
  apply(room, b.token, {
    kind: 'campfire', choices: { [b.playerId]: { choice: 'smith', cardUid: secondCard.uid } },
  })
  assertEqual(room.run.phase, 'map')
})

check('a campfire choice does not leak into the NEXT campfire', () => {
  // The choice belongs to the room it was made in. Left behind, it silently
  // resolved the next campfire for a player who was never asked.
  const { room, a, b } = twoSeatRoom()
  atCampfire(room)
  apply(room, a.token, { kind: 'campfire', choices: { [a.playerId]: { choice: 'rest' } } })
  assertDeepEqual(snapshotFor(room, a.token).campfireDecided, [a.playerId], 'Ann has chosen')

  // The party moves on without resolving.
  room.run.phase = 'map'
  room.run.map.position = null
  apply(room, a.token, { kind: 'enterRoom', roomId: roomChoices(room.run)[0].id })
  assertDeepEqual(
    snapshotFor(room, a.token).campfireDecided,
    [],
    'the stale choice should not survive leaving the room',
  )

  for (const player of room.run.players) player.hp = 4
  atCampfire(room)
  apply(room, b.token, { kind: 'campfire', choices: { [b.playerId]: { choice: 'rest' } } })
  assertEqual(room.run.phase, 'room', 'Bo alone must not resolve the new campfire')
  assertEqual(room.run.players[0].hp, 4, 'and Ann is not healed without choosing')
})

check('one seat cannot walk the party out of a campfire', () => {
  const { room, a, b } = twoSeatRoom()
  atCampfire(room)
  for (const player of room.run.players) player.hp = 4

  apply(room, a.token, { kind: 'campfire', choices: { [a.playerId]: { choice: 'rest' } } })
  let threw = false
  try {
    apply(room, b.token, { kind: 'leaveRoom' })
  } catch {
    threw = true
  }
  assert(threw, 'a seat left the campfire without everyone choosing')
  assertEqual(room.run.phase, 'room', 'the party is still at the campfire')
  assertEqual(room.run.players[0].hp, 4, 'and nobody has rested yet')
})

check('a dropped player remains pending at a simultaneous campfire', () => {
  const { room, a, b } = twoSeatRoom()
  atCampfire(room)
  for (const player of room.run.players) player.hp = 4
  markDisconnected(room, b.token)

  apply(room, a.token, { kind: 'campfire', choices: { [a.playerId]: { choice: 'rest' } } })
  assertEqual(room.run.phase, 'room', 'disconnect is never treated as a physical abstention')
  assertEqual(room.run.players[0].hp, 4, 'and no choice resolves early')
  joinRoom(room, { token: b.token })
  apply(room, b.token, { kind: 'campfire', choices: { [b.playerId]: { choice: 'rest' } } })
  assertEqual(room.run.phase, 'map')
  assertEqual(room.run.players[0].hp, 7)
})

check('a room with no campfire refuses campfire choices', () => {
  const { room, a } = twoSeatRoom()
  const nonCampfire = Object.values(room.run.map.rooms).find((entry) => entry.kind !== 'campfire')
  assert(nonCampfire, 'precondition: the act should contain a non-campfire room')
  room.run.phase = 'room'
  room.run.map.position = nonCampfire.id
  room.run.combat = null

  let threw = false
  try {
    apply(room, a.token, { kind: 'campfire', choices: { [a.playerId]: { choice: 'rest' } } })
  } catch {
    threw = true
  }
  assert(threw, 'a treasure room accepted a campfire choice')
  assertDeepEqual(snapshotFor(room, a.token).campfireDecided, [], 'and published no prompt')
})

check('a campfire message with no choice in it is refused', () => {
  // Otherwise one stray message burns the campfire for the whole table.
  const { room, a } = twoSeatRoom()
  atCampfire(room)

  let threw = false
  try {
    apply(room, a.token, { kind: 'campfire' })
  } catch {
    threw = true
  }
  assert(threw, 'an empty campfire message was accepted')
  assertEqual(room.run.phase, 'room', 'and the party is still at the campfire')
})

suite('action authorisation')

check('actions are refused before the run starts', () => {
  const store = createStore()
  const room = createRoom(store, { code: 'AAAAAD' })
  const seat = joinRoom(room, { character: 'ironclad' })
  let threw = false
  try {
    apply(room, seat.token, { kind: 'endTurn' })
  } catch {
    threw = true
  }
  assert(threw, 'an action ran against a lobby with no run')
})

check('a malformed message is refused, not crashed on', () => {
  // These arrive as JSON from a socket. A string where a list belongs threw a
  // raw TypeError straight out of apply(), which a transport would take as a
  // crash rather than as a rejected action.
  const { room, a } = twoSeatRoom()
  const mine = room.run.combat.players.find((player) => player.id === a.playerId)
  const card = mine.hand[0]
  const enemyUid = room.run.combat.enemies[0].uid

  for (const bad of ['x', 42, {}, null]) {
    let error = null
    try {
      apply(room, a.token, {
        kind: 'playCard',
        cardUid: card.uid,
        enemyUid,
        discardUids: bad,
        exhaustUids: bad,
        evokeSlots: bad,
        evokeEnemyUids: bad,
        scryDiscardUids: bad,
      })
    } catch (thrown) {
      error = thrown
    }
    assert(
      error === null || error.name === 'RoomError',
      `a malformed list threw ${error?.name}: ${error?.message}`,
    )
  }
})

check('a crafted orb slot cannot reach anything but a real orb', () => {
  // These arrive as JSON. Used as raw property keys on the orbs array,
  // 'length' evoked a phantom orb for free damage and then truncated the array
  // to zero slots for the rest of the combat, and '__proto__' threw straight
  // out of the room layer.
  CARDS.fixture_room_evoke2 = {
    id: 'fixture_room_evoke2',
    name: 'Fixture Evoke',
    owner: 'defect',
    type: 'skill',
    rarity: 'common',
    cost: 0,
    effects: [{ kind: 'evoke', times: 1 }],
  }

  for (const crafted of [['length'], ['constructor'], ['__proto__'], [-1], [99], [1.5], [null]]) {
    // A fresh room each time: an earlier iteration could kill the enemy, and
    // the play would then be refused for an unrelated reason.
    const { room, a } = twoSeatRoom()
    const mine = () => room.run.combat.players.find((player) => player.id === a.playerId)
    const card = { uid: 'fx-evoke', defId: 'fixture_room_evoke2', upgraded: false }
    mine().hand.push(card)
    mine().orbs = ['lightning', null, null]

    let error = null
    try {
      apply(room, a.token, {
        kind: 'playCard',
        cardUid: card.uid,
        enemyUid: room.run.combat.enemies[0].uid,
        evokeSlots: crafted,
      })
    } catch (thrown) {
      error = thrown
    }

    const label = String(crafted[0])
    assert(error === null || error.name === 'RoomError', `${label} threw ${error?.name}`)
    assertEqual(mine().orbs.length, 3, `${label} changed the number of orb slots`)
    assertDeepEqual(mine().orbs, ['lightning', null, null], `${label} changed an Orb on a refused play`)
    assert(mine().hand.some((held) => held.uid === card.uid), `${label} spent the refused card`)
  }
})

check('an unknown action kind is rejected rather than ignored', () => {
  const { room, a } = twoSeatRoom()
  let threw = false
  try {
    apply(room, a.token, { kind: 'giveMeGold' })
  } catch {
    threw = true
  }
  assert(threw, 'an unknown action was silently swallowed')
})

suite('what the party is told')

// The only line a player reads during a fight is "The party enters …", so both
// the name and the article matter, and neither was checked.
check('every room kind is announced with a name and the right article', () => {
  const EXPECTED = {
    encounter: 'an encounter',
    elite: 'an elite fight',
    boss: 'a boss fight',
    campfire: 'a campfire',
    treasure: 'a treasure room',
    merchant: 'a merchant',
    event: 'an event',
  }
  for (const [kind, phrase] of Object.entries(EXPECTED)) {
    assert(ROOM_LABEL[kind], `${kind} has no spoken name`)
    assertEqual(enteringRoom(kind), phrase, `${kind} should read naturally`)
  }

  // Every shipped kind happens to agree with its own label's first letter, so
  // none of the above can tell whether the article comes from the label or
  // from the kind. This pair disagrees deliberately.
  ROOM_LABEL.fixture_vowel_kind = 'merchant stall'
  ROOM_LABEL.fixture_consonant = 'observatory'
  assertEqual(enteringRoom('fixture_vowel_kind'), 'a merchant stall', 'the LABEL decides, not the kind')
  assertEqual(enteringRoom('fixture_consonant'), 'an observatory', 'and again the other way round')
  delete ROOM_LABEL.fixture_vowel_kind
  delete ROOM_LABEL.fixture_consonant

  // An unknown kind still reads as a sentence rather than "a ".
  assertEqual(enteringRoom('shop'), 'a shop', 'an unlabelled kind falls back to its own name')
})

check('entering a room says so, correctly', () => {
  const { room, a } = twoSeatRoom()
  const line = room.run.log.at(-1)
  assertEqual(
    line,
    'The party enters an encounter.',
    'the opening room is an encounter, and takes "an"',
  )
})

suite('run setup')

check('the party is seated in join order', () => {
  const { room } = twoSeatRoom()
  assertEqual(room.run.players[0].character, 'ironclad', 'first seat is not the first player')
  assertEqual(room.run.players[1].character, 'silent', 'second seat is not the second player')
})

check('the same seed gives the same run', () => {
  const build = () => {
    const room = createRoom(createStore(), { code: 'AAAAAE' })
    const seat = joinRoom(room, { character: 'ironclad' })
    joinRoom(room, { character: 'silent' })
    startRun(room, seat.token, { seed: 99 })
    enterFirstCombat(room, seat.token)
    return room.run.combat.players[0].hand.map((card) => card.defId).join(',')
  }
  assertEqual(build(), build(), 'the same seed produced different opening hands')
})

check('each character starts on its printed hit points', () => {
  // A table of literals, not MAX_HP compared against itself.
  const PRINTED = { ironclad: 10, silent: 9, defect: 9, watcher: 9 }
  for (const [character, hp] of Object.entries(PRINTED)) {
    const room = createRoom(createStore(), { code: 'AAAAAM' })
    const seat = joinRoom(room, { character })
    startRun(room, seat.token, { seed: 2 })
    assertEqual(room.run.players[0].maxHp, hp, `${character} max hit points`)
    assertEqual(room.run.players[0].hp, hp, `${character} starts at full`)
  }
})

check('every character draws its documented opening hand', () => {
  // Five cards (p.12), except the Silent: Ring of the Snake is her starting
  // relic and draws 2 more at the start of combat, so she opens on seven.
  const OPENING_HAND = { ironclad: 5, silent: 7, defect: 5, watcher: 5 }
  for (const character of CHARACTERS) {
    const room = createRoom(createStore(), { code: 'AAAAAF' })
    const seat = joinRoom(room, { character })
    startRun(room, seat.token, { seed: 7 })
    enterFirstCombat(room, seat.token)
    assertEqual(
      room.run.combat.players[0].hand.length,
      OPENING_HAND[character],
      `${character} opening hand`,
    )
  }
})

check('a player reconnects into the pending campfire choice', () => {
  const { room, a, b } = twoSeatRoom()
  atCampfire(room)
  for (const player of room.run.players) player.hp = 4

  const first = apply(room, a.token, { kind: 'campfire', choices: { [a.playerId]: { choice: 'rest' } } })
  assertDeepEqual(first.waitingOn, [b.playerId], 'precondition: the table is waiting on Bo')
  assertEqual(room.run.phase, 'room', 'and still at the campfire')

  markDisconnected(room, b.token)
  assertEqual(room.run.phase, 'room', 'Bo dropping does not invent a simultaneous choice')
  const again = joinRoom(room, { token: b.token })
  assertEqual(again.playerId, b.playerId)
  apply(room, b.token, { kind: 'campfire', choices: { [b.playerId]: { choice: 'rest' } } })
  assertEqual(room.run.phase, 'map')
  assertEqual(room.run.players[0].hp, 7)
})

check('a campfire choice must actually be Rest, Smith, or Ruby', () => {
  // resolveCampfire treats anything that is not exactly 'rest' as a Smith, and
  // a Smith naming no card does nothing — so a near-miss silently burned the
  // seat's only in-act heal.
  const { room, a } = twoSeatRoom()
  atCampfire(room)
  for (const player of room.run.players) player.hp = 4

  for (const bad of ['Rest', 'REST', 'heal', 1, true, ['rest'], null, undefined, {}]) {
    let threw = false
    try {
      apply(room, a.token, { kind: 'campfire', choices: { [a.playerId]: { choice: bad } } })
    } catch {
      threw = true
    }
    assert(threw, `"${String(bad)}" was accepted as a campfire choice`)
  }

  // A Smith must name one of your OWN cards that is not already upgraded.
  const theirs = room.run.players[1].deck[0]
  for (const cardUid of [undefined, 'not-a-card', theirs.uid]) {
    let threw = false
    try {
      apply(room, a.token, {
        kind: 'campfire',
        choices: { [a.playerId]: { choice: 'smith', cardUid } },
      })
    } catch {
      threw = true
    }
    assert(threw, `smith with cardUid ${String(cardUid)} was accepted`)
  }
  const mine = room.run.players[0]
  mine.deck.unshift({ uid: 'room-bane', defId: 'ascenders_bane', upgraded: false })
  let bane
  try { apply(room, a.token, { kind: 'campfire', choices: { [a.playerId]: { choice: 'smith', cardUid: 'room-bane' } } }) } catch (error) { bane = error }
  assertEqual(bane?.name, 'RoomError')

  assertEqual(room.run.phase, 'room', 'and none of that left the campfire')
  assertEqual(room.run.players[0].hp, 4, 'nor healed anyone')
})

check('a campfire does not resolve while nobody is connected', () => {
  const { room, a, b } = twoSeatRoom()
  atCampfire(room)
  for (const player of room.run.players) player.hp = 4

  apply(room, a.token, { kind: 'campfire', choices: { [a.playerId]: { choice: 'rest' } } })
  markDisconnected(room, a.token)
  markDisconnected(room, b.token)
  assertEqual(room.run.phase, 'room', 'an empty table has not answered')
  assertEqual(room.run.players[1].hp, 4, "and Bo's rest was not spent for him")

  // And the first player back can still finish it.
  joinRoom(room, { token: b.token })
  apply(room, b.token, { kind: 'campfire', choices: { [b.playerId]: { choice: 'rest' } } })
  assertEqual(room.run.phase, 'map', 'once everyone present has chosen, the party leaves')
  assertEqual(room.run.players[1].hp, 7, 'and Bo got the rest he chose')
})

check('a stale leaveRoom after the party has left is refused, not an error', () => {
  // resolveCampfire leaves map.position pointing at the campfire it just left,
  // and play is simultaneous (p.12), so a seat acting on a slightly stale
  // frame hits this routinely.
  const { room, a, b } = twoSeatRoom()
  atCampfire(room)
  apply(room, a.token, { kind: 'campfire', choices: { [a.playerId]: { choice: 'rest' } } })
  apply(room, b.token, { kind: 'campfire', choices: { [b.playerId]: { choice: 'rest' } } })
  assertEqual(room.run.phase, 'map', 'precondition: the party has left')

  const late = apply(room, b.token, { kind: 'leaveRoom' })
  assertEqual(late.changed, false, 'a stale leave is a no-op, like every other stale action')
})

suite('the run itself')

// These guards all hold, and none of them was pinned. Each one is the only
// thing standing between a client and a farmable exploit.

check('a room that is not reachable cannot be entered', () => {
  // Without the guard, a bogus id re-creates a combat in the room the party is
  // already standing in — farmable, and the room layer would bump its version
  // for it.
  const { room, a } = twoSeatRoom()
  const before = room.run
  const result = apply(room, a.token, { kind: 'enterRoom', roomId: 'not-a-room' })
  assertEqual(result.changed, false, 'a nonexistent room was entered')
  assert(room.run === before, 'and the run was left untouched')
})

check('a room cannot be entered while a combat is in progress', () => {
  const { room, a } = twoSeatRoom()
  const before = room.run
  const exit = Object.keys(room.run.map.rooms)[1]
  const result = apply(room, a.token, { kind: 'enterRoom', roomId: exit })
  assertEqual(result.changed, false, 'the fight in progress was discarded')
  assert(room.run === before, 'and the run was left untouched')
})

check('a combat in progress cannot be cashed in as a win', () => {
  const { room, a } = twoSeatRoom()
  const goldBefore = room.run.players[0].gold
  const result = apply(room, a.token, { kind: 'resolveCombat' })
  assertEqual(result.changed, false, 'an unfinished combat was resolved')
  assertEqual(room.run.phase, 'combat', 'the fight continues')
  assertEqual(room.run.players[0].gold, goldBefore, 'and nobody was paid for it')
})

check('beating a boss resolves the shared boss-Relic offer before the next Act', () => {
  // Without the victory phase the run silently dead-ends after Act 1: the boss
  // room has no exits and advanceAct only accepts a victory.
  const { room, a, b } = twoSeatRoom()
  const boss = Object.values(room.run.map.rooms).find((entry) => entry.kind === 'boss')
  assert(boss, 'precondition: the act should end at a boss')
  room.run.phase = 'map'
  room.run.map.position = boss.id
  room.run.map.rooms[boss.id] = { ...boss, visited: true }
  room.run.combat = {
    ...room.run.combat,
    phase: 'won',
    enemies: room.run.combat.enemies.map((foe) => ({
      ...foe,
      hp: 0,
      dead: true,
      isBoss: true,
      goldReward: 3,
      cardReward: 'normal',
      potionReward: false,
    })),
  }
  const goldBefore = room.run.players.map((player) => player.gold)

  apply(room, a.token, { kind: 'resolveCombat' })
  assertEqual(room.run.phase, 'reward')
  assertDeepEqual(room.run.players.map((player, index) => player.gold - goldBefore[index]), [3, 3])
  assert(room.run.rewards.every((reward) => reward.cardReward), 'the boss omitted its normal Card Reward')
  const choices = room.run.rewards[0].bossRelics
  assertEqual(choices.length, 3, 'two players reveal players + 1 boss Relics')
  apply(room, a.token, { kind: 'cardReward', choice: null })
  apply(room, b.token, { kind: 'cardReward', choice: null })
  apply(room, a.token, { kind: 'bossRelicReward', choice: 'skip' })
  apply(room, b.token, { kind: 'bossRelicReward', choice: 'skip' })
  assert(room.run.rewards.every((reward) => reward.potion === false && reward.relic === false && reward.bossRelics === false),
    JSON.stringify(room.run.rewards))
  apply(room, a.token, { kind: 'cardReward', choice: 'confirm' })
  apply(room, b.token, { kind: 'cardReward', choice: 'confirm' })
  assertEqual(room.run.phase, 'victory')

  apply(room, a.token, { kind: 'advanceAct' })
  assertEqual(room.run.act, 2, 'and the next Act begins')
  assertEqual(room.run.phase, 'map', 'back on a fresh map')
})

check('two unseeded runs are not the same run', () => {
  const build = () => {
    const room = createRoom(createStore(), { code: roomCode() })
    const seat = joinRoom(room, { character: 'ironclad' })
    startRun(room, seat.token)
    return room.run.map.rooms
  }
  assert(
    JSON.stringify(build()) !== JSON.stringify(build()),
    'an unseeded run must not always produce the same map',
  )
})

check('a malformed list reaches the code that actually reads it', () => {
  // The earlier version of this played a card with no discard cost, so the
  // list was never touched and the check passed with the guard removed.
  const { room, a } = twoSeatRoom()
  const mine = () => room.run.combat.players.find((player) => player.id === a.playerId)
  CARDS.fixture_needs_discard = {
    id: 'fixture_needs_discard',
    name: 'Fixture Needs Discard',
    owner: 'ironclad',
    type: 'skill',
    rarity: 'common',
    cost: 0,
    effects: [{ kind: 'discard', amount: 1 }],
  }

  for (const bad of ['x', 42, {}, true]) {
    const card = { uid: `fx-bad-${String(bad)}`, defId: 'fixture_needs_discard', upgraded: false }
    mine().hand.push(card)
    let error = null
    try {
      apply(room, a.token, { kind: 'playCard', cardUid: card.uid, enemyUid: null, discardUids: bad })
    } catch (thrown) {
      error = thrown
    }
    assert(
      error === null || error.name === 'RoomError',
      `a malformed discard list threw ${error?.name}: ${error?.message}`,
    )
  }
})

check('every mutator refuses a forged token', () => {
  // `apply` was pinned; the other exported mutators were not, so an
  // unauthenticated caller could rewrite seat 0.
  const { room, a } = twoSeatRoom()
  const held = room.seats[0].character
  const calls = [
    ['chooseCharacter', () => chooseCharacter(room, 'forged', 'defect')],
    ['markDisconnected-is-lenient', null],
    ['startRun', () => startRun(room, 'forged', { seed: 1 })],
    ['apply', () => apply(room, 'forged', { kind: 'endTurn' })],
  ]
  for (const [what, call] of calls) {
    if (!call) continue
    let threw = false
    try {
      call()
    } catch {
      threw = true
    }
    assert(threw, `${what} accepted a forged token`)
  }
  assertEqual(room.seats[0].character, held, "and seat 0's character is untouched")
})

check('a character that does not exist is refused', () => {
  // Accepted, it survived all the way to createPlayer and died there with a
  // raw TypeError.
  const store = createStore()
  const room = createRoom(store, { code: 'AAAAAN' })
  // Not null or undefined: omitting the character means "pick one for me",
  // which is how the auto-assignment works.
  for (const bogus of ['wizard', '', 'IRONCLAD', 1, 'Ironclad']) {
    let threw = false
    try {
      joinRoom(room, { character: bogus })
    } catch {
      threw = true
    }
    assert(threw, `"${String(bogus)}" was accepted as a character`)
  }
  const seat = joinRoom(room, { character: 'ironclad' })
  let threw = false
  try {
    chooseCharacter(room, seat.token, 'wizard')
  } catch {
    threw = true
  }
  assert(threw, 'chooseCharacter accepted a character that does not exist')
  // But re-picking the one you already hold is fine.
  chooseCharacter(room, seat.token, 'ironclad')
  assertEqual(room.seats[0].character, 'ironclad', 're-selecting your own character is allowed')
})

check('combat actions outside a combat are refused, not crashed on', () => {
  // The started-run-on-the-map case; only the pre-startRun case was covered.
  const { room, a } = twoSeatRoom()
  room.run.phase = 'map'
  room.run.combat = null
  for (const kind of ['playCard', 'endTurn', 'startTurn', 'resolveEnemies']) {
    let error = null
    try {
      apply(room, a.token, { kind, cardUid: 'x', enemyUid: null })
    } catch (thrown) {
      error = thrown
    }
    assert(error !== null, `${kind} should be refused with no combat`)
    assertEqual(error.name, 'RoomError', `${kind} threw ${error.name}: ${error.message}`)
  }
})

check('a seat token is long enough to be a credential', () => {
  // Room codes get a bias check; the token that actually grants seat control
  // had nothing asserting its entropy.
  const room = createRoom(createStore(), { code: 'AAAAAP' })
  const seat = joinRoom(room, { character: 'ironclad' })
  assert(seat.token.length >= 32, `a bearer token of ${seat.token.length} characters is too short`)
})

check('an ally target chosen by a client reaches the engine', () => {
  // Co-op targeting — Defend+, Vigilance, True Grit — travels in `playerId`,
  // and nothing checked that the room layer forwards it.
  const { room, a, b } = twoSeatRoom()
  const mine = () => room.run.combat.players.find((player) => player.id === a.playerId)
  const ally = () => room.run.combat.players.find((player) => player.id === b.playerId)
  const card = { uid: 'fx-ally-block', defId: 'defend_ironclad', upgraded: true }
  mine().hand.push(card)

  apply(room, a.token, { kind: 'playCard', cardUid: card.uid, enemyUid: null, playerId: b.playerId })
  assertEqual(ally().block, 2, 'the Block landed on the chosen ally')
  assertEqual(mine().block, 0, 'and not on the caster')
})

check('a stale or forged network ally target does not redirect to the caster', () => {
  const { room, a, b } = twoSeatRoom()
  const mine = () => room.run.combat.players.find((player) => player.id === a.playerId)
  const ally = () => room.run.combat.players.find((player) => player.id === b.playerId)
  const card = { uid: 'fx-stale-block', defId: 'defend_ironclad', upgraded: true }
  mine().hand.push(card)
  ally().hp = 0
  ally().dead = true

  for (const playerId of ['not-a-player', '', false, 0, b.playerId]) {
    const result = apply(room, a.token, {
      kind: 'playCard',
      cardUid: card.uid,
      enemyUid: null,
      playerId,
    })
    assertEqual(result.changed, false, `${playerId} should be refused by the room boundary`)
    assertEqual(mine().block, 0, 'the stale support effect was redirected to the caster')
    assert(mine().hand.some((held) => held.uid === card.uid), 'the refused card left hand')
  }
})

check('a Smith naming an already-upgraded card is refused', () => {
  const { room, a } = twoSeatRoom()
  atCampfire(room)
  const mine = room.run.players.find((player) => player.id === a.playerId)
  mine.deck[0] = { ...mine.deck[0], upgraded: true }

  let threw = false
  try {
    apply(room, a.token, {
      kind: 'campfire',
      choices: { [a.playerId]: { choice: 'smith', cardUid: mine.deck[0].uid } },
    })
  } catch {
    threw = true
  }
  assert(threw, 'smithing an already-upgraded card would silently burn the campfire')
})

check('reconnecting can complete a campfire the table was waiting on', () => {
  // The disconnect side of this is pinned; the reconnect side was not.
  const { room, a, b } = twoSeatRoom()
  atCampfire(room)
  for (const player of room.run.players) player.hp = 4

  markDisconnected(room, b.token)
  markDisconnected(room, a.token)
  apply(room, a.token, { kind: 'campfire', choices: { [a.playerId]: { choice: 'rest' } } })
  assertEqual(room.run.phase, 'room', 'nobody connected, so nothing resolves')
  assertDeepEqual(snapshotFor(room, a.token).campfireChoice, { choice: 'rest' }, 'the owner can restore its choice')
  assertEqual(snapshotFor(room, b.token).campfireChoice, undefined, 'another seat cannot inspect the choice')

  joinRoom(room, { token: b.token })
  apply(room, b.token, { kind: 'campfire', choices: { [b.playerId]: { choice: 'rest' } } })
  assertEqual(room.run.phase, 'map', 'the returning player completes it')
  assertDeepEqual(snapshotFor(room, a.token).campfireDecided, [], 'and the roster is cleared')
})

// A hostile client can send any shape it likes. `allocate` de-dupes uids with
// indexOf inside a filter, which is quadratic, and the room layer handles
// messages serially on one thread -- so an unbounded list is not merely rude,
// it is a denial of service against every room in the process. Measured before
// the cap: 40,000 junk uids blocked for 1.3 seconds.
check('a fixed-size card-effect uid list is capped above every supported printed choice', () => {
  const huge = Array.from({ length: 50_000 }, (_unused, i) => `junk-${i}`)
  assertEqual(uidList(huge).length, UID_LIMIT, 'the list should be truncated, not passed through')
  assert(UID_LIMIT >= 12, 'and the cap must still cover the largest transcribed effect choice')

  // Truncation keeps the FRONT of the list, so an honest short play is untouched.
  assertDeepEqual(uidList(['a', 'b']), ['a', 'b'], 'a real play passes through whole')
  assertEqual(uidList('not-an-array'), undefined, 'a non-array is still nothing')
  assertDeepEqual(uidList([1, 'a', null]), ['a'], 'non-strings are still dropped')
})

check('online seats can activate only their own once-per-turn Combust', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const power = { uid: 'room-combust', defId: 'combust', upgraded: true }
  actor.powers = [power]
  room.run.combat.powerTriggersUsedThisTurn = []
  const target = room.run.combat.enemies.find((enemy) => !enemy.dead)
  const rowHp = room.run.combat.enemies
    .filter((enemy) => enemy.isBoss || enemy.row === target.row)
    .map((enemy) => [enemy.uid, enemy.hp])

  let denied = null
  try {
    apply(room, b.token, { kind: 'activatePower', powerUid: power.uid, enemyRow: target.row, preflight: true })
  } catch (error) {
    denied = error
  }
  assertEqual(denied?.name, 'RoomError', 'another seat activated the Ironclad power')
  assertDeepEqual(room.run.combat.enemies
    .filter((enemy) => enemy.isBoss || enemy.row === target.row)
    .map((enemy) => [enemy.uid, enemy.hp]), rowHp, 'the refused action changed combat')

  apply(room, a.token, { kind: 'activatePower', powerUid: power.uid, enemyRow: target.row, preflight: true })
  const seen = snapshotFor(room, b.token).run.combat
  for (const [uid, hp] of rowHp) assertEqual(seen.enemies.find((enemy) => enemy.uid === uid).hp, hp - 2)
  assert(seen.powerTriggersUsedThisTurn.includes(`${a.playerId}/power:${power.uid}`))

  let repeated = null
  try {
    apply(room, a.token, { kind: 'activatePower', powerUid: power.uid, enemyRow: target.row, preflight: true })
  } catch (error) {
    repeated = error
  }
  assertEqual(repeated?.name, 'RoomError', 'Combust activated twice in one turn')
})

check('Battle Hymn activation and its once-per-turn lock are authoritative across reconnect', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const power = { uid: 'room-battle-hymn', defId: 'battle_hymn', upgraded: true }
  const target = room.run.combat.enemies.find((enemy) => !enemy.dead)
  Object.assign(actor, { character: 'watcher', stance: 'wrath', powers: [power] })
  Object.assign(target, { hp: 20, maxHp: 20, block: 0, vulnerable: 2 })

  markDisconnected(room, a.token)
  const rejoined = joinRoom(room, { token: a.token })
  apply(room, rejoined.token, {
    kind: 'activatePower', powerUid: power.uid, enemyUid: target.uid, preflight: true,
  })
  const teammate = snapshotFor(room, b.token).run.combat
  assertEqual(teammate.enemies.find((enemy) => enemy.uid === target.uid).hp, 16)
  assert(teammate.powerTriggersUsedThisTurn.includes(`${a.playerId}/power:${power.uid}`))
  let repeated = null
  try {
    apply(room, rejoined.token, {
      kind: 'activatePower', powerUid: power.uid, enemyUid: target.uid, preflight: true,
    })
  } catch (error) {
    repeated = error
  }
  assertEqual(repeated?.name, 'RoomError')
})

check('Mental Fortress stance triggers resolve authoritatively and remain public', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const power = { uid: 'room-mental-fortress', defId: 'mental_fortress', upgraded: true }
  const wrath = { uid: 'room-mental-wrath', defId: 'crescendo', upgraded: false }
  const calm = { uid: 'room-mental-calm', defId: 'tranquility', upgraded: false }
  Object.assign(actor, {
    character: 'watcher', stance: 'neutral', block: 0, powers: [power], hand: [wrath, calm], energy: 1,
  })
  apply(room, a.token, { kind: 'playCard', cardUid: wrath.uid, preflight: true })
  markDisconnected(room, a.token)
  const rejoined = joinRoom(room, { token: a.token })
  apply(room, rejoined.token, { kind: 'playCard', cardUid: calm.uid, preflight: true })
  const teammate = snapshotFor(room, b.token).run.combat.players.find((player) => player.id === a.playerId)
  assertEqual(teammate.stance, 'calm')
  assertEqual(teammate.block, 4)
  assertEqual(teammate.powers[0].defId, 'mental_fortress')
})

check('Rushdown draw is private, reconnect-safe, and limited to the first Wrath each turn', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const power = { uid: 'room-rushdown', defId: 'rushdown', upgraded: true }
  const firstWrath = { uid: 'room-rushdown-first', defId: 'crescendo', upgraded: false }
  const calm = { uid: 'room-rushdown-calm', defId: 'tranquility', upgraded: false }
  const secondWrath = { uid: 'room-rushdown-second', defId: 'crescendo', upgraded: false }
  const secrets = Array.from({ length: 5 }, (_, index) => ({
    uid: `room-rushdown-secret-${index}`, defId: 'strike_watcher', upgraded: false,
  }))
  Object.assign(actor, {
    character: 'watcher', stance: 'neutral', powers: [power],
    hand: [firstWrath, calm, secondWrath], draw: secrets, energy: 1,
  })
  apply(room, a.token, { kind: 'playCard', cardUid: firstWrath.uid, preflight: true })
  assertEqual(room.run.combat.players.find((player) => player.id === a.playerId).draw.length, 2)
  const teammate = snapshotFor(room, b.token)
  assertEqual(teammate.run.combat.players.find((player) => player.id === a.playerId).hand, null)
  assert(!secrets.some((card) => allStrings(teammate).includes(card.uid)), 'Rushdown leaked drawn cards')
  markDisconnected(room, a.token)
  const rejoined = joinRoom(room, { token: a.token })
  apply(room, rejoined.token, { kind: 'playCard', cardUid: calm.uid, preflight: true })
  apply(room, rejoined.token, { kind: 'playCard', cardUid: secondWrath.uid, preflight: true })
  assertEqual(room.run.combat.players.find((player) => player.id === a.playerId).draw.length, 2)
})

check('Nirvana resolves a private Scry authoritatively after reconnect', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const thirdEye = { uid: 'room-nirvana-scry', defId: 'third_eye', upgraded: false }
  const secrets = Array.from({ length: 4 }, (_, index) => ({
    uid: `room-nirvana-secret-${index}`, defId: 'defend_watcher', upgraded: false,
  }))
  Object.assign(actor, {
    character: 'watcher', hand: [thirdEye], draw: secrets, discard: [], energy: 1, block: 0,
    powers: [{ uid: 'room-nirvana', defId: 'nirvana', upgraded: true }],
  })
  markDisconnected(room, a.token)
  const rejoined = joinRoom(room, { token: a.token })
  const preview = apply(room, rejoined.token, { kind: 'previewCard', cardUid: thirdEye.uid }).snapshot.cardPreview
  assertDeepEqual(preview.cards.map((card) => card.uid), secrets.slice(0, 3).map((card) => card.uid))
  apply(room, rejoined.token, {
    kind: 'playCard', cardUid: thirdEye.uid, scryDiscardUids: [secrets[1].uid], preflight: true,
  })
  assertEqual(room.run.combat.players.find((player) => player.id === actor.id).block, 4)
  const teammate = snapshotFor(room, b.token)
  assert(allStrings(teammate).includes(secrets[1].uid), 'the face-up Scry discard stayed hidden')
  assert(![secrets[0], ...secrets.slice(2)].some((card) => allStrings(teammate).includes(card.uid)),
    'Nirvana Scry leaked cards kept in the draw pile')
})

check('Foresight orders private pre-draw choices and rejects replayed actions', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const teammate = room.run.combat.players.find((player) => player.id === b.playerId)
  const secrets = Array.from({ length: 6 }, (_, index) => ({
    uid: `room-foresight-secret-${index}`, defId: index % 2 ? 'defend_watcher' : 'strike_watcher', upgraded: false,
  }))
  Object.assign(room.run.combat, {
    phase: 'roundEnd', turn: 1, startTurnProgress: undefined, pendingTriggers: [],
  })
  Object.assign(actor, {
    character: 'watcher', hand: [], draw: secrets, discard: [], block: 0,
    powers: [
      { uid: 'room-foresight-base', defId: 'foresight', upgraded: false },
      { uid: 'room-foresight-upgraded', defId: 'foresight', upgraded: true },
    ],
  })
  Object.assign(teammate, {
    hand: [], draw: Array.from({ length: 5 }, (_, index) => ({
      uid: `room-foresight-teammate-${index}`, defId: 'strike_silent', upgraded: false,
    })), discard: [],
  })

  apply(room, b.token, { kind: 'startTurn' })
  const orderView = snapshotFor(room, a.token)
  assertEqual(orderView.startTurnScry, undefined, 'private cards appeared before the party chose an order')
  assertDeepEqual(orderView.startTurnScryAbilities.map((ability) => ability.amount), [3, 4])
  apply(room, a.token, {
    kind: 'orderStartTurnScries',
    order: [...orderView.startTurnScryAbilities].reverse().map((ability) => ability.id),
  })
  const ownerView = snapshotFor(room, a.token)
  const teammateView = snapshotFor(room, b.token)
  assertEqual(ownerView.startTurnScry.playerId, a.playerId)
  assertEqual(ownerView.startTurnScry.amount, 4)
  assertDeepEqual(ownerView.startTurnScry.cards.map((card) => card.uid), secrets.slice(0, 4).map((card) => card.uid))
  assertEqual(teammateView.startTurnScry.cards, null)
  assert(!secrets.some((card) => allStrings(teammateView).includes(card.uid)),
    'Foresight leaked its owner\'s draw pile to a teammate')
  assertEqual(room.run.combat.players.find((player) => player.id === a.playerId).hand.length, 0,
    'the shared Draw step ran before Foresight')

  let forged = null
  try {
    apply(room, b.token, {
      kind: 'resolveStartTurnScry', sourceId: ownerView.startTurnScry.id, discardUids: [secrets[0].uid],
    })
  } catch (error) {
    forged = error
  }
  assertEqual(forged?.name, 'RoomError', 'a teammate resolved another player\'s private Foresight')

  const disconnected = structuredClone(room)
  markDisconnected(disconnected, a.token)
  assertEqual(disconnected.run.combat.phase, 'player', 'a disconnected Scry owner held the table')
  assertEqual(disconnected.run.combat.startTurnProgress, undefined)
  joinRoom(disconnected, { token: a.token })
  const rejoined = snapshotFor(disconnected, a.token)
  assertEqual(rejoined.run.combat.players.find((player) => player.id === a.playerId).handCount, 5)
  assert(!secrets.some((card) => allStrings(snapshotFor(disconnected, b.token)).includes(card.uid)),
    'the automatically kept Foresight cards leaked after disconnect')

  apply(room, a.token, {
    kind: 'resolveStartTurnScry', sourceId: ownerView.startTurnScry.id, discardUids: [secrets[1].uid],
  })
  const second = snapshotFor(room, a.token).startTurnScry
  assertEqual(second.amount, 3)
  let replayed = null
  try {
    apply(room, a.token, {
      kind: 'resolveStartTurnScry', sourceId: ownerView.startTurnScry.id, discardUids: [],
    })
  } catch (error) {
    replayed = error
  }
  assertEqual(replayed?.name, 'RoomError', 'a replayed keep-all action consumed the next Foresight')
  assertEqual(snapshotFor(room, a.token).startTurnScry.id, second.id)
  apply(room, a.token, { kind: 'resolveStartTurnScry', sourceId: second.id, discardUids: [] })
  assertEqual(room.run.combat.phase, 'player')
  assertEqual(room.run.combat.players.find((player) => player.id === a.playerId).hand.length, 5)
  const publicAfter = snapshotFor(room, b.token)
  assert(allStrings(publicAfter).includes(secrets[1].uid), 'the face-up Foresight discard stayed hidden')
  assert(![secrets[0], ...secrets.slice(2)].some((card) => allStrings(publicAfter).includes(card.uid)),
    'Foresight leaked cards kept and drawn into the owner\'s hand')
})

check('Tools of the Trade keeps its start-turn hand private and survives reconnect', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === b.playerId)
  const secrets = Array.from({ length: 6 }, (_, index) => ({
    uid: `room-tools-secret-${index}`,
    defId: index === 0 ? 'tactician' : index === 5 ? 'daze' : 'strike_silent',
    upgraded: false,
  }))
  Object.assign(room.run.combat, {
    phase: 'roundEnd', turn: 1, startTurnProgress: undefined, pendingTriggers: [],
  })
  Object.assign(actor, {
    hand: [], draw: secrets, discard: [], exhaust: [], energy: 0,
    powers: [
      { uid: 'room-tools', defId: 'tools_of_the_trade', upgraded: false },
      { uid: 'room-tools-evolve', defId: 'evolve', upgraded: false },
    ],
  })

  apply(room, a.token, { kind: 'startTurn' })
  const owner = snapshotFor(room, b.token)
  const teammate = snapshotFor(room, a.token)
  assertEqual(owner.startTurnDiscard.playerId, b.playerId)
  assertEqual(owner.startTurnDiscard.cards.length, 6)
  assertEqual(teammate.startTurnDiscard.cards, null)
  assertDeepEqual(teammate.run.combat.startTurnProgress.discard.pendingTriggers, [],
    'a private draw reaction queue leaked the drawn card type')
  assertEqual(teammate.run.combat.nextTriggerId, 0,
    'the trigger allocator leaked whether the private draw matched a reaction')
  assert(!secrets.some((card) => allStrings(teammate).includes(card.uid)),
    'Tools of the Trade leaked its owner\'s hand to a teammate')

  let forged = null
  try {
    apply(room, a.token, {
      kind: 'resolveStartTurnDiscard', sourceId: owner.startTurnDiscard.sourceId,
      discardUid: secrets[0].uid,
    })
  } catch (error) {
    forged = error
  }
  assertEqual(forged?.name, 'RoomError', 'a teammate resolved another player\'s private discard')

  const disconnected = structuredClone(room)
  markDisconnected(disconnected, b.token)
  assertEqual(disconnected.run.combat.phase, 'player', 'a disconnected discard owner held the table')
  joinRoom(disconnected, { token: b.token })
  assertEqual(snapshotFor(disconnected, b.token).run.combat.players
    .find((player) => player.id === b.playerId).handCount, 5)

  apply(room, b.token, {
    kind: 'resolveStartTurnDiscard', sourceId: owner.startTurnDiscard.sourceId,
    discardUid: secrets[0].uid,
  })
  assertEqual(room.run.combat.phase, 'player')
  assertEqual(room.run.combat.players.find((player) => player.id === b.playerId).energy, 5)
  assert(!secrets.slice(1).some((card) => allStrings(snapshotFor(room, a.token)).includes(card.uid)),
    'Tools of the Trade leaked the owner\'s remaining hand after resolution')
})

check('Indignation chooses no target outside Wrath and upgrades to a row', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const enter = { uid: 'room-indignation-enter', defId: 'indignation', upgraded: true }
  const expose = { uid: 'room-indignation-row', defId: 'indignation', upgraded: true }
  const [first, second] = room.run.combat.enemies
  Object.assign(first, { row: 0, vulnerable: 0, dead: false, isBoss: false })
  Object.assign(second, { row: 1, vulnerable: 0, dead: false, isBoss: false })
  Object.assign(actor, {
    character: 'watcher', stance: 'neutral', hand: [enter, expose], energy: 2,
  })
  apply(room, a.token, { kind: 'playCard', cardUid: enter.uid, preflight: true })
  assertEqual(room.run.combat.players.find((player) => player.id === actor.id).stance, 'wrath')
  assertDeepEqual(room.run.combat.enemies.slice(0, 2).map((enemy) => enemy.vulnerable), [0, 0])
  apply(room, a.token, { kind: 'playCard', cardUid: expose.uid, enemyUid: first.uid, preflight: true })
  const publicCombat = snapshotFor(room, b.token).run.combat
  assertDeepEqual(publicCombat.enemies.slice(0, 2).map((enemy) => enemy.vulnerable), [1, 0])
})

check('Inner Peace keeps its Calm draw private across reconnect', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const card = { uid: 'room-inner-peace', defId: 'inner_peace', upgraded: true }
  const secrets = Array.from({ length: 5 }, (_, index) => ({
    uid: `room-inner-peace-secret-${index}`, defId: 'strike_watcher', upgraded: false,
  }))
  Object.assign(actor, {
    character: 'watcher', stance: 'calm', hand: [card], draw: secrets, discard: [], energy: 1,
  })
  apply(room, a.token, { kind: 'playCard', cardUid: card.uid, preflight: true })
  const teammate = snapshotFor(room, b.token)
  const hiddenActor = teammate.run.combat.players.find((player) => player.id === actor.id)
  assertEqual(hiddenActor.hand, null)
  assertEqual(hiddenActor.handCount, 4)
  assert(!secrets.some((secret) => allStrings(teammate).includes(secret.uid)), 'Inner Peace leaked drawn cards')
  markDisconnected(room, a.token)
  const rejoined = joinRoom(room, { token: a.token })
  const owner = snapshotFor(room, rejoined.token).run.combat.players.find((player) => player.id === actor.id)
  assertDeepEqual(owner.hand.map((held) => held.uid), secrets.slice(0, 4).map((held) => held.uid))
})

check('online Evolve resolves chained Status draws without revealing the new hand', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  actor.hand = [{ uid: 'room-evolve-shrug', defId: 'shrug_it_off', upgraded: false }]
  actor.draw = [
    { uid: 'room-evolve-daze-a', defId: 'daze', upgraded: false },
    { uid: 'room-evolve-daze-b', defId: 'daze', upgraded: false },
    { uid: 'room-evolve-strike', defId: 'strike_ironclad', upgraded: false },
  ]
  actor.powers = [{ uid: 'room-evolve', defId: 'evolve', upgraded: false }]
  actor.discard = []
  actor.energy = 3

  apply(room, a.token, { kind: 'playCard', cardUid: 'room-evolve-shrug', preflight: true })
  const mine = snapshotFor(room, a.token).run.combat.players.find((player) => player.id === a.playerId)
  const theirs = snapshotFor(room, b.token).run.combat.players.find((player) => player.id === a.playerId)
  assertDeepEqual(mine.hand.map((card) => card.defId), ['daze', 'daze', 'strike_ironclad'])
  assertEqual(theirs.hand, null)
  assertEqual(theirs.handCount, 3)
  assert(!allStrings(snapshotFor(room, b.token)).some((value) => value.startsWith('room-evolve-daze')),
    'Evolve leaked the owner hand through the teammate snapshot')
})

check('online Fire Breathing keeps bad draws private and its row choices owner-authoritative', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const draw = { uid: 'room-fire-trance', defId: 'battle_trance', upgraded: false }
  Object.assign(actor, {
    hand: [draw],
    draw: [
      { uid: 'room-fire-daze', defId: 'daze', upgraded: false },
      { uid: 'room-fire-curse', defId: 'clumsy', upgraded: false },
      { uid: 'room-fire-strike', defId: 'strike_ironclad', upgraded: false },
    ],
    discard: [],
    powers: [{ uid: 'room-fire-power', defId: 'fire_breathing', upgraded: false }],
    energy: 3,
  })
  const [first, second] = room.run.combat.enemies
  Object.assign(first, { defId: 'cultist', row: 0, hp: 10, maxHp: 10, block: 0, dead: false })
  Object.assign(second, { defId: 'cultist', row: 1, hp: 10, maxHp: 10, block: 0, dead: false })

  apply(room, a.token, { kind: 'playCard', cardUid: draw.uid, preflight: true })
  room.run.combat.endTurnProgress = { order: [`${a.playerId}/card:room-fire-private-card`] }
  const peer = snapshotFor(room, b.token)
  delete room.run.combat.endTurnProgress
  assertEqual(peer.run.combat.pendingTriggers.length, 2)
  assertEqual(peer.run.combat.players.find((player) => player.id === a.playerId).hand, null)
  assert(!allStrings(peer).some((value) => value.startsWith('room-fire-daze') || value.startsWith('room-fire-curse')),
    'the pending trigger disclosed which private cards caused it')
  assert(!allStrings(peer).includes('room-fire-private-card') && !allKeys(peer).includes('endTurnProgress'),
    'the paused end-turn order disclosed a private hand-card id')

  let denied = null
  try {
    apply(room, b.token, {
      kind: 'resolveTrigger', triggerId: room.run.combat.pendingTriggers[0].id, enemyRow: 1, preflight: true,
    })
  } catch (error) {
    denied = error
  }
  assertEqual(denied?.name, 'RoomError', 'a teammate chose the owner-only trigger target')
  const firstTriggerId = room.run.combat.pendingTriggers[0].id
  apply(room, a.token, { kind: 'resolveTrigger', triggerId: firstTriggerId, enemyRow: 1, preflight: true })
  assertDeepEqual(room.run.combat.enemies.slice(0, 2).map((enemy) => enemy.hp), [10, 8])
  assertEqual(room.run.combat.pendingTriggers.length, 1)

  let stale = null
  try {
    apply(room, a.token, { kind: 'resolveTrigger', triggerId: firstTriggerId, enemyRow: 0, preflight: true })
  } catch (error) {
    stale = error
  }
  assertEqual(stale?.name, 'RoomError', 'a retry consumed the next identical trigger')

  markDisconnected(room, a.token)
  assertEqual(room.run.combat.pendingTriggers.length, 0, 'a disconnected owner deadlocked the room')
  assertDeepEqual(room.run.combat.enemies.slice(0, 2).map((enemy) => enemy.hp), [8, 8],
    'disconnect fallback should resolve into the first legal row')
})

check('online Juggernaut keeps its enemy choice owner-authoritative and reconnect-safe', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const defend = { uid: 'room-juggernaut-defend', defId: 'defend_ironclad', upgraded: false }
  Object.assign(actor, {
    hand: [defend], block: 0, energy: 3,
    powers: [{ uid: 'room-juggernaut', defId: 'juggernaut', upgraded: true }],
  })
  const [first, second] = room.run.combat.enemies
  Object.assign(first, { defId: 'cultist', row: 0, hp: 10, maxHp: 10, block: 0, dead: false })
  Object.assign(second, { defId: 'cultist', row: 1, hp: 10, maxHp: 10, block: 0, dead: false })

  apply(room, a.token, {
    kind: 'playCard', cardUid: defend.uid, playerId: actor.id, preflight: true,
  })
  assertEqual(room.run.combat.pendingTriggers.length, 1)
  assertDeepEqual(room.run.combat.enemies.slice(0, 2).map((enemy) => enemy.hp), [10, 10])
  const triggerId = room.run.combat.pendingTriggers[0].id

  let denied = null
  try {
    apply(room, b.token, { kind: 'resolveTrigger', triggerId, enemyUid: second.uid, preflight: true })
  } catch (error) {
    denied = error
  }
  assertEqual(denied?.name, 'RoomError', 'a teammate chose Juggernaut\'s private action')

  const disconnected = structuredClone(room)
  markDisconnected(disconnected, a.token)
  assertEqual(disconnected.run.combat.pendingTriggers.length, 0, 'a disconnected owner deadlocked Juggernaut')
  assertDeepEqual(disconnected.run.combat.enemies.slice(0, 2).map((enemy) => enemy.hp), [8, 10],
    'disconnect fallback should choose the first living enemy')

  apply(room, a.token, { kind: 'resolveTrigger', triggerId, enemyUid: second.uid, preflight: true })
  assertDeepEqual(room.run.combat.enemies.slice(0, 2).map((enemy) => enemy.hp), [10, 8])
  assertEqual(room.run.combat.pendingTriggers.length, 0)
})

check('online A Thousand Cuts and Malaise preserve owner choices and X-cost authority', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const battleTrance = { uid: 'room-cuts-draw', defId: 'battle_trance', upgraded: false }
  Object.assign(actor, {
    character: 'silent', hand: [battleTrance],
    draw: [{ uid: 'room-cuts-strike', defId: 'strike_silent', upgraded: false }],
    discard: [
      { uid: 'room-cuts-defend', defId: 'defend_silent', upgraded: false },
      { uid: 'room-cuts-neutralize', defId: 'neutralize', upgraded: false },
    ],
    energy: 3, powers: [{ uid: 'room-cuts-power', defId: 'a_thousand_cuts', upgraded: true }],
  })
  const [first, second] = room.run.combat.enemies
  Object.assign(first, { defId: 'cultist', row: 0, hp: 12, maxHp: 12, block: 0, dead: false })
  Object.assign(second, { defId: 'cultist', row: 1, hp: 12, maxHp: 12, block: 0, dead: false })

  apply(room, a.token, { kind: 'playCard', cardUid: battleTrance.uid, preflight: true })
  const triggerId = room.run.combat.pendingTriggers[0].id
  let denied = null
  try {
    apply(room, b.token, { kind: 'resolveTrigger', triggerId, enemyRow: 1, preflight: true })
  } catch (error) {
    denied = error
  }
  assertEqual(denied?.name, 'RoomError', 'a teammate chose A Thousand Cuts\' row')
  apply(room, a.token, { kind: 'resolveTrigger', triggerId, enemyRow: 1, preflight: true })
  assertDeepEqual(room.run.combat.enemies.slice(0, 2).map((enemy) => enemy.hp), [12, 5])

  const malaise = { uid: 'room-malaise', defId: 'malaise', upgraded: true }
  const currentActor = room.run.combat.players.find((player) => player.id === a.playerId)
  Object.assign(currentActor, { hand: [malaise], energy: 3, drawLocked: false })
  apply(room, a.token, {
    kind: 'playCard', cardUid: malaise.uid, enemyUid: first.uid, energySpent: 2, preflight: true,
  })
  assertEqual(room.run.combat.players.find((player) => player.id === a.playerId).energy, 1)
  const poisoned = room.run.combat.enemies.find((enemy) => enemy.uid === first.uid)
  assertEqual(poisoned.weak, 3)
  assertEqual(poisoned.poison, 3)
})

check('end-turn Fire Breathing cannot deadlock on an already-disconnected owner', () => {
  const { room, a, b } = twoSeatRoom()
  markDisconnected(room, a.token)
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const teammate = room.run.combat.players.find((player) => player.id === b.playerId)
  Object.assign(actor, {
    hand: [{ uid: 'room-fire-end-daze', defId: 'daze', upgraded: false }],
    draw: [{ uid: 'room-fire-end-curse', defId: 'writhe', upgraded: false }],
    discard: [], exhaust: [],
    powers: [
      { uid: 'room-fire-end-embrace', defId: 'dark_embrace', upgraded: false },
      { uid: 'room-fire-end-power', defId: 'fire_breathing', upgraded: false },
    ],
  })
  Object.assign(teammate, { hand: [], powers: [], stance: 'neutral', orbs: [null, null, null] })
  const [first, second] = room.run.combat.enemies
  Object.assign(first, { defId: 'cultist', row: 0, hp: 10, maxHp: 10, block: 0, dead: false })
  Object.assign(second, { defId: 'cultist', row: 1, hp: 10, maxHp: 10, block: 0, dead: false })

  apply(room, b.token, { kind: 'endTurn' })
  assertEqual(room.run.combat.pendingTriggers.length, 0)
  assertEqual(room.run.combat.phase, 'enemy', 'nothing left to arrange, so the turn ran straight on')
  assertDeepEqual(room.run.combat.enemies.slice(0, 2).map((enemy) => enemy.hp), [8, 10])
})

check('online Burst publishes its queued Skill and keeps the copy owner-authoritative', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const burst = { uid: 'room-burst', defId: 'burst', upgraded: true }
  const defend = { uid: 'room-burst-defend', defId: 'defend_silent', upgraded: false }
  Object.assign(actor, {
    name: 'Silent', character: 'silent', hand: [burst, defend], energy: 1, block: 0,
  })
  apply(room, a.token, { kind: 'playCard', cardUid: burst.uid, preflight: true })
  const armed = snapshotFor(room, b.token).run.combat.players.find((player) => player.id === a.playerId)
  assertEqual(armed.doubledSkillsThisTurn, 1)
  apply(room, a.token, { kind: 'playCard', cardUid: defend.uid, playerId: actor.id, preflight: true })
  const waiting = snapshotFor(room, b.token).run.combat
  assertEqual(waiting.phase, 'copy')
  assertDeepEqual(waiting.pendingCardCopy.sourceNames, ['Burst'])

  let denied = null
  try {
    apply(room, b.token, { kind: 'playCardCopy', cardUid: defend.uid, playerId: actor.id, preflight: true })
  } catch (error) {
    denied = error
  }
  assertEqual(denied?.name, 'RoomError', 'another seat resolved Burst')

  const disconnected = structuredClone(room)
  markDisconnected(disconnected, a.token)
  assertEqual(disconnected.run.combat.phase, 'player')
  assertEqual(disconnected.run.combat.pendingCardCopy, undefined)
  assertEqual(disconnected.run.combat.players.find((player) => player.id === actor.id).block, 1,
    'disconnect should keep the resolved Burst copy but skip the remaining original Skill')

  apply(room, a.token, { kind: 'playCardCopy', cardUid: defend.uid, playerId: actor.id, preflight: true })
  const resolved = snapshotFor(room, b.token).run.combat
  assertEqual(resolved.players.find((player) => player.id === actor.id).block, 2)
  assertEqual(resolved.players.find((player) => player.id === actor.id).doubledSkillsThisTurn, 0)
})

check('online Doppelganger uses public co-op history and survives reconnect', () => {
  const { room, a, b } = twoSeatRoom()
  const first = room.run.combat.players.find((player) => player.id === a.playerId)
  const silent = room.run.combat.players.find((player) => player.id === b.playerId)
  const strike = { uid: 'room-doppel-strike', defId: 'strike_ironclad', upgraded: false }
  const doppelganger = { uid: 'room-doppel', defId: 'doppelganger', upgraded: false }
  Object.assign(first, { hand: [strike], energy: 1 })
  Object.assign(silent, {
    name: 'Silent', character: 'silent', hand: [doppelganger], energy: 1, strength: 1,
  })
  const target = room.run.combat.enemies.find((enemy) => !enemy.dead)
  Object.assign(target, { hp: 10, maxHp: 10, block: 0, vulnerable: 0, abilityUsed: true })

  apply(room, a.token, {
    kind: 'playCard', cardUid: strike.uid, enemyUid: target.uid, preflight: true,
  })
  assertEqual(room.run.combat.enemies.find((enemy) => enemy.uid === target.uid).hp, 9)
  apply(room, b.token, {
    kind: 'playCard', cardUid: doppelganger.uid, energySpent: 1, preflight: true,
  })
  const waiting = snapshotFor(room, a.token).run.combat
  assertEqual(waiting.phase, 'copy')
  assertEqual(waiting.pendingCardCopy.card.defId, 'strike_ironclad')
  assertEqual(waiting.pendingCardCopy.virtualOnly, true)
  assertEqual(waiting.playedCardsThisTurn.at(-1).card.defId, 'doppelganger')
  assertEqual(waiting.players.find((player) => player.id === b.playerId).exhaust.length, 0,
    'Doppelganger cleaned up before its nested copy')

  let denied = null
  try {
    apply(room, a.token, {
      kind: 'playCardCopy', cardUid: waiting.pendingCardCopy.card.uid,
      enemyUid: target.uid, preflight: true,
    })
  } catch (error) {
    denied = error
  }
  assertEqual(denied?.name, 'RoomError', 'another seat resolved Doppelganger')

  const abandoned = structuredClone(room)
  markDisconnected(abandoned, b.token)
  assertEqual(abandoned.run.combat.phase, 'player')
  assertEqual(abandoned.run.combat.pendingCardCopy, undefined)
  assertDeepEqual(
    abandoned.run.combat.players.find((player) => player.id === b.playerId).exhaust.map((card) => card.uid),
    [doppelganger.uid],
  )

  const rejoined = joinRoom(room, { token: b.token })
  const resumed = snapshotFor(room, rejoined.token).run.combat
  assertEqual(resumed.pendingCardCopy.card.defId, 'strike_ironclad')
  apply(room, rejoined.token, {
    kind: 'playCardCopy', cardUid: resumed.pendingCardCopy.card.uid,
    enemyUid: target.uid, preflight: true,
  })
  assertEqual(room.run.combat.phase, 'player')
  assertEqual(room.run.combat.enemies.find((enemy) => enemy.uid === target.uid).hp, 7)
  const resolvedSilent = room.run.combat.players.find((player) => player.id === b.playerId)
  assertEqual(resolvedSilent.discard.some((card) => card.uid.endsWith(':copy')), false)
  assertDeepEqual(resolvedSilent.exhaust.map((card) => card.uid), [doppelganger.uid])
})

check('Bullet Time hand discounts survive reconnect without leaking private card identities', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const bulletTime = { uid: 'room-bullet-time', defId: 'bullet_time', upgraded: true }
  const defend = { uid: 'room-bullet-defend', defId: 'defend_silent', upgraded: false }
  const future = { uid: 'room-bullet-future', defId: 'strike_silent', upgraded: false }
  Object.assign(actor, {
    name: 'Silent', character: 'silent', hand: [bulletTime, defend], draw: [future], energy: 2, drawLocked: false,
  })
  apply(room, a.token, { kind: 'playCard', cardUid: bulletTime.uid, preflight: true })
  const teammate = snapshotFor(room, b.token)
  const publicActor = teammate.run.combat.players.find((player) => player.id === actor.id)
  assert(publicActor.drawLocked)
  assert(!allStrings(teammate).includes(defend.uid), 'Bullet Time leaked a discounted hand card')
  const rejoined = snapshotFor(room, a.token).run.combat.players.find((player) => player.id === actor.id)
  assertEqual(rejoined.hand.find((card) => card.uid === defend.uid).freeThisTurn, true)
  apply(room, a.token, { kind: 'playCard', cardUid: defend.uid, playerId: actor.id, preflight: true })
  assertEqual(room.run.combat.players.find((player) => player.id === actor.id).energy, 0)
})

check('online Double Tap locks the room until its owner separately targets the copy', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  actor.hand = [
    { uid: 'room-double-tap', defId: 'double_tap', upgraded: true },
    { uid: 'room-double-strike', defId: 'strike_ironclad', upgraded: false },
  ]
  actor.energy = 3
  const [first, second] = room.run.combat.enemies.filter((enemy) => !enemy.dead).slice(0, 2)
  first.vulnerable = 1

  apply(room, a.token, { kind: 'playCard', cardUid: 'room-double-tap', preflight: true })
  apply(room, a.token, {
    kind: 'playCard', cardUid: 'room-double-strike', enemyUid: first.uid, preflight: true,
  })
  const waiting = snapshotFor(room, b.token).run.combat
  assertEqual(waiting.phase, 'copy')
  assertEqual(waiting.pendingCardCopy.playerId, a.playerId)
  assertEqual(waiting.pendingCardCopy.card.defId, 'strike_ironclad')
  assertEqual(waiting.enemies.find((enemy) => enemy.uid === first.uid).vulnerable, 0)

  let bypassed = null
  try {
    apply(room, b.token, { kind: 'spendShiv', enemyUid: second.uid })
  } catch (error) {
    bypassed = error
  }
  assertEqual(bypassed?.name, 'RoomError', 'another seat acted before the copy finished')

  apply(room, a.token, {
    kind: 'playCardCopy', cardUid: 'room-double-strike', enemyUid: second.uid, preflight: true,
  })
  const resolved = snapshotFor(room, b.token).run.combat
  assertEqual(resolved.phase, 'player')
  assertEqual(resolved.pendingCardCopy, undefined)
  assertEqual(resolved.players.find((player) => player.id === a.playerId).attacksPlayedThisTurn, 2)
  assertEqual(resolved.players.find((player) => player.id === a.playerId).doubledAttacksThisTurn, 0)
})

check('an Echo Form Skill copy stays authoritative, public, and reconnect-safe', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const defend = { uid: 'room-echo-defend', defId: 'defend_defect', upgraded: false }
  Object.assign(actor, {
    character: 'defect', hand: [defend], energy: 3, block: 0, doubledCardsThisTurn: 1,
  })

  apply(room, a.token, {
    kind: 'playCard', cardUid: defend.uid, playerId: actor.id, preflight: true,
  })
  const waiting = snapshotFor(room, b.token).run.combat
  assertEqual(waiting.phase, 'copy')
  assertDeepEqual(waiting.pendingCardCopy.sourceNames, ['Echo Form'])
  assertEqual(waiting.players.find((player) => player.id === actor.id).doubledCardsThisTurn, 0)

  let bypassed = null
  try {
    apply(room, b.token, { kind: 'playCardCopy', cardUid: defend.uid, playerId: actor.id, preflight: true })
  } catch (error) {
    bypassed = error
  }
  assertEqual(bypassed?.name, 'RoomError', 'another seat resolved the Echo Form copy')

  const rejoined = joinRoom(room, { token: a.token })
  assertDeepEqual(snapshotFor(room, rejoined.token).run.combat.pendingCardCopy.sourceNames, ['Echo Form'])
  apply(room, rejoined.token, {
    kind: 'playCardCopy', cardUid: defend.uid, playerId: actor.id, preflight: true,
  })
  const resolved = room.run.combat.players.find((player) => player.id === actor.id)
  assertEqual(resolved.block, 2)
  assertEqual(room.run.combat.phase, 'player')
  assertEqual(resolved.discard.filter((card) => card.uid === defend.uid).length, 1)
})

check('disconnecting during Echo Form Havoc settles its child and queued copy', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const havoc = { uid: 'room-echo-havoc', defId: 'havoc', upgraded: false }
  const secret = { uid: 'room-echo-havoc-secret', defId: 'strike_ironclad', upgraded: false }
  Object.assign(actor, {
    hand: [havoc], draw: [secret], discard: [], exhaust: [], energy: 1, doubledCardsThisTurn: 1,
  })
  apply(room, a.token, { kind: 'playCard', cardUid: havoc.uid, preflight: true })
  assertEqual(room.run.combat.startTurnProgress?.forcedCard?.cardUid, secret.uid)
  markDisconnected(room, a.token)
  const released = snapshotFor(room, b.token).run.combat
  const settled = released.players.find((player) => player.id === a.playerId)
  assertEqual(released.phase, 'player')
  assertEqual(released.startTurnProgress, undefined)
  assertEqual(released.pendingCardCopy, undefined)
  assertEqual(settled.exhaust.filter((card) => card.uid === secret.uid).length, 1)
  assertEqual(settled.discard.filter((card) => card.uid === havoc.uid).length, 1)
})

check('disconnecting the Double Tap owner releases the shared room lock', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  actor.hand = [{ uid: 'room-abandoned-copy', defId: 'strike_ironclad', upgraded: false }]
  actor.doubledAttacksThisTurn = 1
  actor.energy = 3
  const target = room.run.combat.enemies.find((enemy) => !enemy.dead)
  apply(room, a.token, {
    kind: 'playCard', cardUid: 'room-abandoned-copy', enemyUid: target.uid, preflight: true,
  })
  assertEqual(room.run.combat.phase, 'copy')
  markDisconnected(room, a.token)
  const released = snapshotFor(room, b.token).run.combat
  assertEqual(released.phase, 'player')
  assertEqual(released.pendingCardCopy, undefined)
  assert(released.log.some((line) => line.includes('original Strike was skipped after disconnecting')))
})

check('a Double Tap copy reveals its post-draw choice only to its owner', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  actor.hand = [
    { uid: 'room-copy-preview-tap', defId: 'double_tap', upgraded: true },
    { uid: 'room-copy-preview-dagger', defId: 'dagger_throw', upgraded: false },
  ]
  actor.draw = [
    { uid: 'room-copy-preview-first', defId: 'defend_ironclad', upgraded: false },
    { uid: 'room-copy-preview-secret', defId: 'strike_ironclad', upgraded: false },
  ]
  actor.energy = 3
  const [first, second] = room.run.combat.enemies.filter((enemy) => !enemy.dead).slice(0, 2)
  apply(room, a.token, { kind: 'playCard', cardUid: 'room-copy-preview-tap', preflight: true })
  apply(room, a.token, {
    kind: 'previewCard', cardUid: 'room-copy-preview-dagger', enemyUid: first.uid,
  })
  apply(room, a.token, {
    kind: 'playCard', cardUid: 'room-copy-preview-dagger', enemyUid: first.uid,
    discardUids: ['room-copy-preview-first'], preflight: true,
  })
  const previewed = apply(room, a.token, {
    kind: 'previewCardCopy', cardUid: 'room-copy-preview-dagger', enemyUid: second.uid,
  }).snapshot
  assertEqual(previewed.cardPreview.copy, true)
  assertDeepEqual(previewed.cardPreview.cards.map((card) => card.uid), ['room-copy-preview-secret'])
  assert(!allStrings(snapshotFor(room, b.token)).includes('room-copy-preview-secret'),
    'the copied card preview leaked to a teammate')
  apply(room, a.token, {
    kind: 'playCardCopy', cardUid: 'room-copy-preview-dagger', enemyUid: second.uid,
    discardUids: ['room-copy-preview-secret'], preflight: true,
  })
  assertEqual(room.run.combat.phase, 'player')
})

check('Distilled Chaos choices stay private and settle if their owner disconnects', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const cards = [1, 2, 3].map((number) => ({
    uid: `room-distilled-${number}`, defId: 'defend_ironclad', upgraded: false,
  }))
  Object.assign(actor, { hand: [], draw: cards, discard: [], potions: ['distilled_chaos'] })
  apply(room, a.token, { kind: 'usePotion', potionId: 'distilled_chaos', preflight: true })
  assertDeepEqual(snapshotFor(room, a.token).run.combat.pendingDistilled.cards.map((card) => card.uid),
    cards.map((card) => card.uid))
  for (const card of cards) {
    assert(!allStrings(snapshotFor(room, b.token)).includes(card.uid), 'a Distilled Chaos card leaked')
  }
  markDisconnected(room, a.token)
  assertEqual(room.run.combat.pendingDistilled, undefined)
  assertEqual(room.run.combat.startTurnProgress, undefined)
  assertDeepEqual(room.run.combat.players.find((player) => player.id === a.playerId).discard.map((card) => card.uid),
    cards.map((card) => card.uid))
})

check('Distilled Chaos does not deadlock when Fiend Fire exhausts the queued cards', () => {
  const { room, a } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const cards = [
    { uid: 'room-distilled-fiend', defId: 'fiend_fire', upgraded: false },
    { uid: 'room-distilled-defend', defId: 'defend_ironclad', upgraded: false },
    { uid: 'room-distilled-bash', defId: 'bash', upgraded: false },
  ]
  Object.assign(actor, { hand: [], draw: cards, discard: [], potions: ['distilled_chaos'] })
  apply(room, a.token, { kind: 'usePotion', potionId: 'distilled_chaos', preflight: true })
  apply(room, a.token, { kind: 'chooseDistilledCard', cardUid: cards[0].uid })
  apply(room, a.token, { kind: 'playCard', cardUid: cards[0].uid,
    enemyUid: room.run.combat.enemies.find((enemy) => !enemy.dead).uid, preflight: true })
  assertEqual(room.run.combat.pendingDistilled, undefined)
  assertEqual(room.run.combat.startTurnProgress, undefined)
})

check('Golden Eye Scry is owner-private, reconnect-safe, and rejects forged cards', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  actor.relics = [{ defId: 'golden_eye', spent: false }]
  const cards = [1, 2, 3, 4].map((number) => ({
    uid: `room-golden-eye-${number}`, defId: 'defend_ironclad', upgraded: false,
  }))
  actor.draw = cards
  apply(room, a.token, { kind: 'activateRelic', relicIndex: 0 })
  assertDeepEqual(snapshotFor(room, a.token).run.combat.pendingRelicScry.cards.map((card) => card.uid),
    cards.slice(0, 3).map((card) => card.uid))
  for (const card of cards.slice(0, 3)) assert(!allStrings(snapshotFor(room, b.token)).includes(card.uid),
    'Golden Eye leaked a private top-deck card')
  const disconnected = structuredClone(room)
  markDisconnected(disconnected, a.token)
  assertEqual(disconnected.run.combat.pendingRelicScry, undefined, 'a disconnected Scry owner held the table')
  assertEqual(disconnected.run.combat.players.find((player) => player.id === a.playerId).relics[0].spent, true)
  joinRoom(room, { token: a.token })
  assertDeepEqual(snapshotFor(room, a.token).run.combat.pendingRelicScry.cards.map((card) => card.uid),
    cards.slice(0, 3).map((card) => card.uid))
  let forged = false
  try {
    apply(room, a.token, { kind: 'activateRelic', relicIndex: 0, scryDiscardUids: ['forged'] })
  } catch { forged = true }
  assert(forged, 'a forged Golden Eye discard was accepted')
  apply(room, a.token, { kind: 'activateRelic', relicIndex: 0, scryDiscardUids: [cards[0].uid] })
  assertEqual(room.run.combat.pendingRelicScry, undefined)
  assertEqual(room.run.combat.players.find((player) => player.id === a.playerId).relics[0].spent, true)
})

check('disconnected one-shot Relics use only authoritative legal card choices', () => {
  for (const relicId of ['war_paint', 'whetstone', 'empty_cage', 'pandoras_box']) {
    const { room, a } = twoSeatRoom()
    room.run.phase = 'map'
    room.run.combat = null
    const actor = room.run.players.find((player) => player.id === a.playerId)
    actor.relics.push({ defId: relicId, spent: false, pending: true })
    if (relicId === 'empty_cage' || relicId === 'pandoras_box') {
      actor.deck = [{ uid: `${relicId}-bane`, defId: 'ascenders_bane', upgraded: false }, ...actor.deck]
    }
    markDisconnected(room, a.token)
    assert(!room.run.players.find((player) => player.id === a.playerId).relics.some((relic) => relic.pending),
      `${relicId} stayed pending after disconnect`)
  }

  const { room, a } = twoSeatRoom()
  room.run.phase = 'map'
  room.run.combat = null
  const actor = room.run.players.find((player) => player.id === a.playerId)
  let keptDefend = false
  actor.deck = actor.deck.map((card) => {
    if (card.defId.startsWith('defend_') && !keptDefend) { keptDefend = true; return card }
    return { ...card, upgraded: true }
  })
  actor.relics.push({ defId: 'war_paint', spent: false, pending: true })
  markDisconnected(room, a.token)
  const settled = room.run.players.find((player) => player.id === a.playerId)
  assert(!settled.relics.some((relic) => relic.pending), 'depleted War Paint stayed pending after disconnect')
  assert(settled.deck.find((card) => card.defId.startsWith('defend_')).upgraded,
    'depleted War Paint did not upgrade its remaining starter Defend')

  const exhausted = twoSeatRoom()
  exhausted.room.run.phase = 'map'
  exhausted.room.run.combat = null
  const exhaustedActor = exhausted.room.run.players.find((player) => player.id === exhausted.a.playerId)
  exhaustedActor.rareRewards = []
  exhaustedActor.relics.push({ defId: 'enchiridion', spent: false, pending: true })
  markDisconnected(exhausted.room, exhausted.a.token)
  assert(!exhausted.room.run.players.find((player) => player.id === exhausted.a.playerId).relics
    .some((relic) => relic.pending), 'exhausted Enchiridion stayed pending after disconnect')
  joinRoom(exhausted.room, { token: exhausted.a.token })
  assertEqual(snapshotFor(exhausted.room, exhausted.a.token).pendingRelic, null,
    'reconnect restored an exhausted Enchiridion choice')
})

check('online Player Turn accepts the same legal Relic activation as local combat', () => {
  const { room, a } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  room.run.combat.phase = 'player'
  actor.energy = 0
  actor.relics = [{ defId: 'holy_water', spent: false, cubes: 2 }]
  apply(room, a.token, { kind: 'activateRelic', relicIndex: 0 })
  const resolved = room.run.combat.players.find((player) => player.id === a.playerId)
  assertEqual(resolved.energy, 1)
  assertEqual(resolved.relics[0].cubes, 1)
})

check("online turns keep Gambler's Brew in the authoritative post-roll window", () => {
  const { room, a } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  room.run.combat.phase = 'roundEnd'
  actor.potions = ['gamblers_brew']
  apply(room, a.token, { kind: 'startTurn' })
  assertEqual(room.run.combat.phase, 'start')
  apply(room, a.token, { kind: 'usePotion', potionId: 'gamblers_brew', die: 6 })
  assertEqual(room.run.combat.die, 6)
  assertEqual(room.run.combat.players.find((player) => player.id === a.playerId).potions.length, 0)
  apply(room, a.token, { kind: 'resolveStartTurn', choices: [] })
  assertEqual(room.run.combat.phase, 'player')
})

check('room authority rejects a client-selected Gambling Chip face', () => {
  const { room, a } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  room.run.combat.phase = 'start'
  actor.relics = [{ defId: 'gambling_chip', spent: false }]
  let refused = false
  try { apply(room, a.token, { kind: 'activateRelic', relicIndex: 0, die: 6 }) } catch { refused = true }
  assert(refused, 'client forced the Gambling Chip reroll')
})

check('room authority rejects die Relics while private start progress is pending', () => {
  const { room, a } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  room.run.combat.phase = 'start'
  room.run.combat.startTurnProgress = { choices: [] }
  actor.relics = [{ defId: 'the_abacus', spent: false }]
  let refused = false
  try { apply(room, a.token, { kind: 'activateRelic', relicIndex: 0 }) } catch { refused = true }
  assert(refused, 'a die Relic changed the roll during private start progress')
})

check('Blasphemy is authoritative and reconnect-safe without leaking the private draw pile', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const blasphemy = { uid: 'room-blasphemy', defId: 'blasphemy', upgraded: false }
  const strike = { uid: 'room-blasphemy-strike', defId: 'strike_watcher', upgraded: false }
  const secrets = [
    { uid: 'room-blasphemy-secret-1', defId: 'defend_watcher', upgraded: false },
    { uid: 'room-blasphemy-secret-2', defId: 'vigilance', upgraded: false },
  ]
  const target = room.run.combat.enemies.find((enemy) => !enemy.dead)
  Object.assign(actor, {
    character: 'watcher', hand: [blasphemy, strike], draw: secrets, discard: [], exhaust: [],
    energy: 3, tripledAttacksThisTurn: 0, attacksPlayedThisTurn: 0,
  })
  Object.assign(target, { defId: 'cultist', hp: 20, maxHp: 20, block: 0, vulnerable: 0, dead: false })

  assert(!secrets.some((card) => allStrings(snapshotFor(room, b.token)).includes(card.uid)),
    'Blasphemy setup leaked the private draw pile')
  apply(room, a.token, { kind: 'playCard', cardUid: blasphemy.uid, preflight: true })
  const revealed = snapshotFor(room, b.token).run.combat
  assertEqual(revealed.players.find((player) => player.id === actor.id).tripledAttacksThisTurn, 1)
  assert(secrets.every((card) => allStrings(revealed).includes(card.uid)),
    'cards exhausted face-up by Blasphemy stayed hidden')

  apply(room, a.token, {
    kind: 'playCard', cardUid: strike.uid, enemyUid: target.uid, preflight: true,
  })
  assertDeepEqual(snapshotFor(room, b.token).run.combat.pendingCardCopy.sourceNames,
    ['Blasphemy', 'Blasphemy'])

  const abandoned = structuredClone(room)
  markDisconnected(abandoned, a.token)
  assertEqual(abandoned.run.combat.phase, 'player', 'disconnect did not resume the shared Player Turn')
  assertEqual(abandoned.run.combat.pendingCardCopy, undefined, 'disconnect left Blasphemy copies pending')
  assertEqual(abandoned.run.combat.enemies.find((enemy) => enemy.uid === target.uid).hp, 19,
    'disconnect resolved an unchosen Blasphemy copy')
  const rejoined = joinRoom(abandoned, { token: a.token })
  const resumed = snapshotFor(abandoned, rejoined.token)
  assertEqual(resumed.run.combat.phase, 'player')
  assertEqual(resumed.run.combat.pendingCardCopy, undefined)

  apply(room, a.token, {
    kind: 'playCardCopy', cardUid: strike.uid, enemyUid: target.uid, preflight: true,
  })
  assertEqual(room.run.combat.enemies.find((enemy) => enemy.uid === target.uid).hp, 18)
  assertDeepEqual(snapshotFor(room, a.token).run.combat.pendingCardCopy.sourceNames,
    ['Blasphemy'])
  apply(room, a.token, {
    kind: 'playCardCopy', cardUid: strike.uid, enemyUid: target.uid, preflight: true,
  })
  assertEqual(room.run.combat.enemies.find((enemy) => enemy.uid === target.uid).hp, 17)
  const resolved = snapshotFor(room, b.token).run.combat
  const publicActor = resolved.players.find((player) => player.id === actor.id)
  assertEqual(resolved.enemies.find((enemy) => enemy.uid === target.uid).hp, 17)
  assertEqual(publicActor.tripledAttacksThisTurn, 0)
  assertEqual(publicActor.attacksPlayedThisTurn, 3)
  assertEqual(publicActor.discard.filter((card) => card.uid === strike.uid).length, 1)
})

check('Omniscience search stays private and disconnect safely abandons its unresolved plays', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const omniscience = { uid: 'room-omniscience', defId: 'omniscience', upgraded: false }
  const strike = { uid: 'room-omniscience-strike', defId: 'strike_watcher', upgraded: false }
  const secretPower = { uid: 'room-omniscience-power', defId: 'deva_form', upgraded: false }
  const target = room.run.combat.enemies.find((enemy) => !enemy.dead)
  Object.assign(actor, {
    character: 'watcher', hand: [omniscience], draw: [strike, secretPower], energy: 3,
    discard: [], exhaust: [],
  })
  Object.assign(target, { defId: 'cultist', hp: 20, maxHp: 20, block: 0, dead: false })

  const preview = apply(room, a.token, {
    kind: 'previewCard', cardUid: omniscience.uid,
  }).snapshot.cardPreview
  assertDeepEqual(preview.cards.map((card) => card.uid), [strike.uid], 'Powers are not eligible')
  assert(!allStrings(snapshotFor(room, b.token)).includes(secretPower.uid), 'the private draw pile leaked')
  apply(room, a.token, {
    kind: 'playCard', cardUid: omniscience.uid, searchDrawUids: [strike.uid], preflight: true,
  })
  assertDeepEqual(room.run.combat.pendingCardCopy.sourceNames, ['Omniscience', 'Omniscience'])
  assert(allStrings(snapshotFor(room, b.token)).includes(strike.uid), 'the selected face-up card stayed hidden')

  const abandoned = structuredClone(room)
  markDisconnected(abandoned, a.token)
  assertEqual(abandoned.run.combat.phase, 'player', 'disconnect did not resume the shared Player Turn')
  assertEqual(abandoned.run.combat.pendingCardCopy, undefined, 'disconnect left Omniscience copies pending')
  assertEqual(abandoned.run.combat.enemies.find((enemy) => enemy.uid === target.uid).hp, 20,
    'disconnect resolved an unchosen Omniscience play')
  const abandonedActor = abandoned.run.combat.players.find((player) => player.id === a.playerId)
  assert(abandonedActor.exhaust.some((card) => card.uid === strike.uid))
  assert(abandonedActor.exhaust.some((card) => card.uid === omniscience.uid))
  const rejoined = joinRoom(abandoned, { token: a.token })
  const resumed = snapshotFor(abandoned, rejoined.token)
  assertEqual(resumed.run.combat.phase, 'player')
  assertEqual(resumed.run.combat.pendingCardCopy, undefined)

  apply(room, a.token, {
    kind: 'playCardCopy', cardUid: strike.uid, enemyUid: target.uid, preflight: true,
  })
  assertDeepEqual(room.run.combat.pendingCardCopy.sourceNames, ['Omniscience'])
  apply(room, a.token, {
    kind: 'playCardCopy', cardUid: strike.uid, enemyUid: target.uid, preflight: true,
  })
  assertEqual(room.run.combat.enemies.find((enemy) => enemy.uid === target.uid).hp, 18)
  assert(actor !== room.run.combat.players.find((player) => player.id === a.playerId),
    'room combat should remain immutable across actions')
  const resolvedActor = room.run.combat.players.find((player) => player.id === a.playerId)
  assert(resolvedActor.exhaust.some((card) => card.uid === strike.uid))
  assert(resolvedActor.exhaust.some((card) => card.uid === omniscience.uid))
})

check('Vault replaces only its owner hand and preserves it through reconnect', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const vault = { uid: 'room-vault', defId: 'vault', upgraded: false }
  const retained = { uid: 'room-vault-retained', defId: 'protect', upgraded: false }
  const discarded = { uid: 'room-vault-discarded', defId: 'strike_watcher', upgraded: false }
  const secrets = Array.from({ length: 6 }, (_, index) => ({
    uid: `room-vault-secret-${index}`, defId: 'defend_watcher', upgraded: false,
  }))
  Object.assign(actor, {
    character: 'watcher', hand: [vault, retained, discarded], draw: secrets,
    discard: [], exhaust: [], energy: 3,
  })

  apply(room, a.token, { kind: 'playCard', cardUid: vault.uid, preflight: true })
  const authoritative = room.run.combat.players.find((player) => player.id === a.playerId)
  assertEqual(authoritative.energy, 3)
  assertDeepEqual(authoritative.hand.map((card) => card.uid), [retained.uid, ...secrets.slice(0, 5).map((card) => card.uid)])
  assertDeepEqual(authoritative.discard.map((card) => card.uid), [discarded.uid])
  assert(authoritative.exhaust.some((card) => card.uid === vault.uid))
  const teammate = snapshotFor(room, b.token)
  assert(![retained, ...secrets].some((card) => allStrings(teammate).includes(card.uid)),
    'Vault leaked the replacement hand to a teammate')

  markDisconnected(room, a.token)
  const rejoined = joinRoom(room, { token: a.token })
  const restored = snapshotFor(room, rejoined.token).run.combat.players
    .find((player) => player.id === a.playerId)
  assertDeepEqual(restored.hand.map((card) => card.uid), authoritative.hand.map((card) => card.uid))
  assert(![retained, ...secrets].some((card) => allStrings(snapshotFor(room, b.token)).includes(card.uid)),
    'Vault leaked the replacement hand after reconnect')
})

check('a Foresight Weave interrupt stays private and cannot deadlock after disconnect', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const teammate = room.run.combat.players.find((player) => player.id === b.playerId)
  const weave = { uid: 'room-foresight-weave', defId: 'weave', upgraded: false }
  const secrets = Array.from({ length: 5 }, (_, index) => ({
    uid: `room-foresight-weave-secret-${index}`, defId: 'defend_watcher', upgraded: false,
  }))
  Object.assign(room.run.combat, {
    phase: 'roundEnd', turn: 1, startTurnProgress: undefined, pendingTriggers: [], pendingCardCopy: undefined,
  })
  Object.assign(actor, {
    character: 'watcher', hand: [], draw: [weave, ...secrets], discard: [],
    powers: [{ uid: 'room-foresight-weave-power', defId: 'foresight', upgraded: false }],
  })
  Object.assign(teammate, { hand: [], draw: [], discard: [], powers: [] })

  apply(room, b.token, { kind: 'startTurn' })
  const preview = snapshotFor(room, a.token).startTurnScry
  assertDeepEqual(preview.cards.map((card) => card.uid), [weave.uid, ...secrets.slice(0, 2).map((card) => card.uid)])
  assertEqual(snapshotFor(room, b.token).startTurnScry.cards, null)
  assert(![weave, ...secrets].some((card) => allStrings(snapshotFor(room, b.token)).includes(card.uid)),
    'Foresight leaked its private reveal before the choice')
  apply(room, a.token, {
    kind: 'resolveStartTurnScry', sourceId: preview.id, discardUids: [weave.uid],
  })
  assertEqual(room.run.combat.phase, 'copy')
  assertDeepEqual(room.run.combat.pendingCardCopy.sourceNames, ['Weave'])
  const waiting = snapshotFor(room, b.token)
  assert(allStrings(waiting).includes(weave.uid), 'Scry-played Weave did not become public')
  assert(!secrets.some((card) => allStrings(waiting).includes(card.uid)),
    'Scry-played Weave leaked cards kept in the private draw pile')

  const abandoned = structuredClone(room)
  markDisconnected(abandoned, a.token)
  assertEqual(abandoned.run.combat.phase, 'player', 'disconnect did not resume the shared Draw step')
  assertEqual(abandoned.run.combat.pendingCardCopy, undefined, 'disconnect left Weave pending')
  assertEqual(abandoned.run.combat.startTurnProgress, undefined, 'disconnect left Start-of-Turn state pending')
  const rejoined = joinRoom(abandoned, { token: a.token })
  const resumed = snapshotFor(abandoned, rejoined.token)
  const resumedActor = resumed.run.combat.players.find((player) => player.id === a.playerId)
  assertEqual(resumed.run.combat.phase, 'player')
  assertEqual(resumedActor.hand.length, 5)
  assert(resumedActor.discard.some((card) => card.uid === weave.uid))
  assert(!secrets.some((card) => allStrings(snapshotFor(abandoned, b.token)).includes(card.uid)),
    'the resumed Draw step leaked its owner hand')

  const target = room.run.combat.enemies.find((enemy) => !enemy.dead)
  apply(room, a.token, {
    kind: 'playCardCopy', cardUid: weave.uid, enemyUid: target.uid, preflight: true,
  })
  assertEqual(room.run.combat.phase, 'player')
  assertEqual(room.run.combat.startTurnProgress, undefined)
  assertEqual(room.run.combat.players.find((player) => player.id === a.playerId).hand.length, 5)
})

suite('non-combat room authority')

function atMerchantRoom() {
  const result = twoSeatRoom()
  const { room } = result
  room.run.phase = 'room'
  room.run.combat = null
  room.run.players = room.run.players.map((player) => ({ ...player, gold: 12 }))
  room.run.itemDecks.relics = ['anchor', 'happy_flower', 'akabeko', ...room.run.itemDecks.relics]
  room.run.itemDecks.potions = ['fire_potion', 'swift_potion', 'blood_potion', ...room.run.itemDecks.potions]
  room.run.roomState = createMerchant(room.run.itemDecks, room.run.players)
  return result
}

check('a Merchant token can pledge only its own public Gold', () => {
  const { room, a, b } = atMerchantRoom()
  const before = JSON.stringify(room.run)
  let forged
  try {
    apply(room, a.token, {
      kind: 'merchantPurchase',
      purchase: { buyerId: a.playerId, section: 'relic', slot: 0, payments: { [b.playerId]: 5 } },
    })
  } catch (error) { forged = error }
  assertEqual(forged?.name, 'RoomError')
  assertEqual(JSON.stringify(room.run), before)
})

check('separate contributor pledges settle one shared Merchant purchase atomically', () => {
  const { room, a, b } = atMerchantRoom()
  apply(room, a.token, {
    kind: 'merchantPurchase',
    purchase: { buyerId: a.playerId, section: 'relic', slot: 0, payments: { [a.playerId]: 2 } },
  })
  assertEqual(room.run.roomState.relics[0], 'anchor', 'an underfunded pledge did not buy early')
  apply(room, b.token, {
    kind: 'merchantPurchase',
    purchase: { buyerId: a.playerId, section: 'relic', slot: 0, payments: { [b.playerId]: 3 } },
  })
  assertEqual(room.run.roomState.relics[0], null)
  assert(room.run.players.find((player) => player.id === a.playerId).relics.some((relic) => relic.defId === 'anchor'))
  assertEqual(room.run.players.find((player) => player.id === a.playerId).gold, 10)
  assertEqual(room.run.players.find((player) => player.id === b.playerId).gold, 9)
})

check('Merchant reserves shared offers and Gold across every pending purchase', () => {
  const { room, a, b } = atMerchantRoom()
  room.run.players.find((player) => player.id === a.playerId).gold = 5
  apply(room, a.token, { kind: 'merchantPurchase', purchase: { buyerId: a.playerId, section: 'relic', slot: 0, payments: { [a.playerId]: 3 } } })
  let competing
  try { apply(room, b.token, { kind: 'merchantPurchase', purchase: { buyerId: b.playerId, section: 'relic', slot: 0, payments: { [b.playerId]: 1 } } }) } catch (error) { competing = error }
  assertEqual(competing?.name, 'RoomError')
  let overcommitted
  try { apply(room, a.token, { kind: 'merchantPurchase', purchase: { buyerId: a.playerId, section: 'relic', slot: 1, payments: { [a.playerId]: 3 } } }) } catch (error) { overcommitted = error }
  assertEqual(overcommitted?.name, 'RoomError')
  assertEqual(room.merchantPledges[`${a.playerId}/relic/1`], undefined)

  let aliased
  try { apply(room, b.token, { kind: 'merchantPurchase', purchase: { buyerId: b.playerId, section: 'relic', slot: '0', payments: { [b.playerId]: 0 } } }) } catch (error) { aliased = error }
  assertEqual(aliased?.name, 'RoomError')
  assertEqual(Object.keys(room.merchantPledges).length, 1)
})

check('Merchant buyer cancellation clears teammate funding and impossible exact settlements', () => {
  const { room, a, b } = atMerchantRoom()
  apply(room, a.token, { kind: 'merchantPurchase', purchase: { buyerId: a.playerId, section: 'relic', slot: 0, payments: { [a.playerId]: 0 } } })
  apply(room, b.token, { kind: 'merchantPurchase', purchase: { buyerId: a.playerId, section: 'relic', slot: 0, payments: { [b.playerId]: 2 } } })
  apply(room, a.token, { kind: 'merchantWithdraw', key: `${a.playerId}/relic/0` })
  assertEqual(room.merchantPledges[`${a.playerId}/relic/0`], undefined)
  markDisconnected(room, b.token)

  room.merchantPledges.safe = { buyerId: a.playerId, section: 'relic', slot: 1, payments: { [a.playerId]: 0 } }
  let inherited
  try { apply(room, a.token, { kind: 'merchantWithdraw', key: '__proto__' }) } catch (error) { inherited = error }
  assertEqual(inherited?.name, 'RoomError')
  delete room.merchantPledges.safe

  room.run.ascension = 4
  const buyer = room.run.players.find((player) => player.id === a.playerId)
  buyer.potions = ['fire_potion', 'swift_potion']
  const version = room.version
  let impossible
  try { apply(room, a.token, { kind: 'merchantPurchase', purchase: { buyerId: a.playerId, section: 'potion', slot: 0, potionRecipientId: a.playerId, payments: { [a.playerId]: 2 } } }) } catch (error) { impossible = error }
  assertEqual(impossible?.name, 'RoomError')
  assertEqual(room.version, version)
  assertEqual(room.merchantPledges?.[`${a.playerId}/potion/0`], undefined)
})

check('Merchant rejects impossible purchases before storing partial funding', () => {
  const { room, a } = atMerchantRoom()
  room.run.ascension = 4
  const buyer = room.run.players.find((player) => player.id === a.playerId)
  buyer.potions = ['fire_potion', 'swift_potion']
  const version = room.version
  let potion
  try { apply(room, a.token, { kind: 'merchantPurchase', purchase: { buyerId: a.playerId, section: 'potion', slot: 0, payments: { [a.playerId]: 1 } } }) } catch (error) { potion = error }
  assertEqual(potion?.name, 'RoomError')
  assertEqual(room.merchantPledges?.[`${a.playerId}/potion/0`], undefined)
  let removal
  try { apply(room, a.token, { kind: 'merchantRemove', playerId: a.playerId, cardUid: 'forged-card', payments: { [a.playerId]: 1 } }) } catch (error) { removal = error }
  assertEqual(removal?.name, 'RoomError')
  assertEqual(room.merchantPledges?.[`remove/${a.playerId}`], undefined)
  room.run.players = room.run.players.map((player) => ({ ...player, gold: 0, potions: [] }))
  let unaffordable
  try { apply(room, a.token, { kind: 'merchantPurchase', purchase: { buyerId: a.playerId, section: 'relic', slot: 0, payments: { [a.playerId]: 0 } } }) } catch (error) { unaffordable = error }
  assertEqual(unaffordable?.name, 'RoomError')
  assertEqual(room.merchantPledges?.[`${a.playerId}/relic/0`], undefined)
  assertEqual(room.version, version)
})

check('Merchant cannot close while an authorized purchase still needs contributions', () => {
  const { room, a, b } = atMerchantRoom()
  apply(room, a.token, { kind: 'merchantPurchase', purchase: { buyerId: a.playerId, section: 'relic', slot: 0, payments: { [a.playerId]: 1 } } })
  let closed
  try { apply(room, a.token, { kind: 'merchantFinish' }) } catch (error) { closed = error }
  assertEqual(closed?.name, 'RoomError')
  assertEqual(room.run.roomState.kind, 'merchant')
  assert(room.merchantPledges[`${a.playerId}/relic/0`])
  apply(room, a.token, { kind: 'merchantWithdraw', key: `${a.playerId}/relic/0` })
  let foreign
  try { apply(room, b.token, { kind: 'merchantFinish' }) } catch (error) { foreign = error }
  assertEqual(foreign?.name, 'RoomError')
  apply(room, a.token, { kind: 'merchantFinish' })
  assertEqual(room.run.phase, 'map')
})

check('Merchant rejects overfunding and freezes potion recipient metadata', () => {
  const { room, a, b } = atMerchantRoom()
  let overpay
  try { apply(room, a.token, { kind: 'merchantPurchase', purchase: { buyerId: a.playerId, section: 'potion', slot: 0, potionRecipientId: a.playerId, payments: { [a.playerId]: 3 } } }) } catch (error) { overpay = error }
  assertEqual(overpay?.name, 'RoomError')
  apply(room, a.token, { kind: 'merchantPurchase', purchase: { buyerId: a.playerId, section: 'potion', slot: 0, potionRecipientId: a.playerId, payments: { [a.playerId]: 1 } } })
  const before = JSON.stringify(room.run)
  let hijack
  try { apply(room, b.token, { kind: 'merchantPurchase', purchase: { buyerId: a.playerId, section: 'potion', slot: 0, potionRecipientId: b.playerId, payments: { [b.playerId]: 1 } } }) } catch (error) { hijack = error }
  assertEqual(hijack?.name, 'RoomError')
  assertEqual(JSON.stringify(room.run), before)

  let forcedGift
  try { apply(room, a.token, { kind: 'merchantPurchase', purchase: { buyerId: a.playerId, section: 'potion', slot: 1, potionRecipientId: b.playerId, payments: { [a.playerId]: 2 } } }) } catch (error) { forcedGift = error }
  assertEqual(forcedGift?.name, 'RoomError', 'the buyer forced a Potion into a teammate inventory')
})

check('shared A8 removal requires owner consent and owner withdrawal cancels it', () => {
  const { room, a, b } = atMerchantRoom()
  room.run.ascension = 8
  const uid = room.run.players.find((player) => player.id === a.playerId).deck[0].uid
  apply(room, a.token, { kind: 'merchantRemove', playerId: a.playerId, cardUid: uid, payments: { [a.playerId]: 1 } })
  apply(room, b.token, { kind: 'merchantRemove', playerId: a.playerId, payments: { [b.playerId]: 1 } })
  assertEqual(snapshotFor(room, b.token).merchantPledges[`remove/${a.playerId}`].cardUid, undefined)
  apply(room, a.token, { kind: 'merchantWithdraw', key: `remove/${a.playerId}` })
  assertEqual(room.merchantPledges[`remove/${a.playerId}`], undefined)
  let forced
  try { apply(room, b.token, { kind: 'merchantRemove', playerId: a.playerId, payments: { [b.playerId]: 4 } }) } catch (error) { forced = error }
  assertEqual(forced?.name, 'RoomError')

  apply(room, a.token, { kind: 'merchantRemove', playerId: a.playerId, cardUid: uid, payments: { [a.playerId]: 1 } })
  apply(room, b.token, { kind: 'merchantRemove', playerId: a.playerId, payments: { [b.playerId]: 3 } })
  assert(!room.run.players.find((player) => player.id === a.playerId).deck.some((card) => card.uid === uid))
})

check('Merchant offers and own pledge survive disconnect and reconnect without leaking hidden decks', () => {
  const { room, a, b } = atMerchantRoom()
  apply(room, a.token, {
    kind: 'merchantPurchase',
    purchase: { buyerId: a.playerId, section: 'relic', slot: 0, payments: { [a.playerId]: 2 } },
  })
  const before = snapshotFor(room, a.token)
  markDisconnected(room, a.token)
  joinRoom(room, { token: a.token })
  const after = snapshotFor(room, a.token)
  assertDeepEqual(after.run.roomState, before.run.roomState)
  assertDeepEqual(after.merchantPledges, before.merchantPledges)
  const strings = allStrings(snapshotFor(room, b.token))
  const visible = new Set(room.run.roomState.relics.filter(Boolean))
  for (const hidden of room.run.itemDecks.relics.filter((id) => !visible.has(id)).slice(0, 4)) {
    assert(!strings.includes(hidden), `${hidden} leaked from the relic deck`)
  }
})

check('a disconnected Merchant buyer cannot strand a funded pending Relic', () => {
  const { room, a, b } = atMerchantRoom()
  room.run.roomState.relics[0] = 'war_paint'
  room.run.players.find((player) => player.id === a.playerId).gold = 0
  const skillUid = room.run.players.find((player) => player.id === a.playerId).deck
    .find((card) => !card.upgraded && CARDS[card.defId]?.type === 'skill').uid
  apply(room, a.token, {
    kind: 'merchantPurchase',
    purchase: { buyerId: a.playerId, section: 'relic', slot: 0, payments: { [a.playerId]: 0 } },
  })
  markDisconnected(room, a.token)
  apply(room, b.token, {
    kind: 'merchantPurchase',
    purchase: { buyerId: a.playerId, section: 'relic', slot: 0, payments: { [b.playerId]: 7 } },
  })
  const owner = room.run.players.find((player) => player.id === a.playerId)
  assert(owner.deck.find((card) => card.uid === skillUid).upgraded)
  assert(!owner.relics.some((relic) => relic.pending))
  assertEqual(snapshotFor(room, b.token).pendingRelic, null)
  const reconnected = joinRoom(room, { token: a.token })
  assertEqual(snapshotFor(room, reconnected.token).pendingRelic, null)
})

check('one seat cannot choose another seat relic and disconnect never completes Sapphire', () => {
  const { room, a, b } = twoSeatRoom()
  room.run.campaignProgress = { ...room.run.campaignProgress, actIV: 5 }
  room.run.phase = 'room'
  room.run.combat = null
  room.run.roomState = createRelicReward('treasure', room.run.itemDecks, room.run.players)
  let spoofed
  try { apply(room, a.token, { kind: 'relicReward', playerId: b.playerId, decision: 'sapphire' }) } catch (error) { spoofed = error }
  assertEqual(spoofed?.name, 'RoomError')
  apply(room, a.token, { kind: 'relicReward', playerId: a.playerId, decision: 'sapphire' })
  assertEqual(snapshotFor(room, a.token).run.roomState.decisions[a.playerId], 'sapphire')
  assertEqual(snapshotFor(room, b.token).run.roomState.decisions[a.playerId], 'skip', 'another seat learned the simultaneous Sapphire choice')
  markDisconnected(room, b.token)
  assertEqual(room.run.phase, 'room')
  assertEqual(room.run.campaign.keys.sapphire, false)
  joinRoom(room, { token: b.token })
  apply(room, b.token, { kind: 'relicReward', playerId: b.playerId, decision: 'sapphire' })
  assertEqual(room.run.campaign.keys.sapphire, true)
})

check('a shared Relic reward cannot strand a disconnected recipient', () => {
  const { room, a, b } = twoSeatRoom()
  room.run.phase = 'room'
  room.run.combat = null
  room.run.itemDecks.relics = ['war_paint', 'anchor', ...room.run.itemDecks.relics]
  room.run.roomState = createRelicReward('treasure', room.run.itemDecks, room.run.players)
  const skillUid = room.run.players.find((player) => player.id === a.playerId).deck
    .find((card) => !card.upgraded && CARDS[card.defId]?.type === 'skill').uid
  apply(room, a.token, { kind: 'relicReward', decision: 'take' })
  markDisconnected(room, a.token)
  apply(room, b.token, { kind: 'relicReward', decision: 'take' })
  const recipient = room.run.players.find((player) => player.id === a.playerId)
  assert(recipient.deck.find((card) => card.uid === skillUid).upgraded)
  assert(!recipient.relics.some((relic) => relic.pending))
  assertEqual(room.run.phase, 'map')
})

check('shared relic claims are public without revealing skip or Sapphire decisions', () => {
  const { room, a, b } = twoSeatRoom()
  room.run.phase = 'room'
  room.run.combat = null
  room.run.roomState = createRelicReward('treasure', room.run.itemDecks, room.run.players, true)
  apply(room, a.token, { kind: 'relicReward', decision: 0 })
  assertEqual(snapshotFor(room, b.token).run.roomState.decisions[a.playerId], 0)
  let duplicate
  try { apply(room, b.token, { kind: 'relicReward', decision: 0 }) } catch (error) { duplicate = error }
  assertEqual(duplicate?.name, 'RoomError')
  apply(room, b.token, { kind: 'relicReward', decision: 1 })
  assertEqual(room.run.phase, 'map')
})

check('an Elite relic reward can produce the physical Sapphire Key', () => {
  const { room, a, b } = twoSeatRoom()
  room.run.campaignProgress = { ...room.run.campaignProgress, actIV: 5 }
  room.run.phase = 'room'
  room.run.combat = null
  room.run.roomState = createRelicReward('elite', room.run.itemDecks, room.run.players)
  apply(room, a.token, { kind: 'relicReward', decision: 'sapphire' })
  apply(room, b.token, { kind: 'relicReward', decision: 'sapphire' })
  assertEqual(room.run.campaign.keys.sapphire, true)
})

check('malformed Event choices are rejected without crashing or mutating the room', () => {
  const { room, a } = twoSeatRoom()
  room.run.phase = 'room'
  room.run.combat = null
  room.run.roomState = createEventRoom({ ...EVENT_DEFINITIONS.living_wall, instanceId: 'test-wall', act: 1, minAscension: 0, requiresColorlessUnlock: false })
  const before = JSON.stringify(room.run)
  for (const decision of [null, {}, { optionIds: 'forget' }, { optionIds: ['forget'], cardUids: [7] }, { optionIds: ['forget'], rewardIndexes: [-1] }, { optionIds: ['forget'], rewardSources: 'ironclad' }]) {
    let refused
    try { apply(room, a.token, { kind: 'event', decision }) } catch (error) { refused = error }
    assertEqual(refused?.name, 'RoomError')
    assertEqual(JSON.stringify(room.run), before)
  }
  let nullPayments
  try { apply(room, a.token, { kind: 'event', decision: { optionIds: ['forget'], payments: null } }) } catch (error) { nullPayments = error }
  assertEqual(nullPayments?.name, 'RoomError')
  assertEqual(JSON.stringify(room.run), before)
})

check('a staged Event die survives reconnect and hides private selections', () => {
  const { room, a, b } = twoSeatRoom()
  room.run.phase = 'room'
  room.run.combat = null
  room.run.roomState = createEventRoom({ ...EVENT_DEFINITIONS.wheel_of_change, instanceId: 'test-wheel', act: 1, minAscension: 0, requiresColorlessUnlock: false })
  apply(room, a.token, { kind: 'event', decision: { optionIds: ['spin'] } })
  const roll = room.run.roomState.pendingRolls[a.playerId][0]
  markDisconnected(room, a.token)
  joinRoom(room, { token: a.token })
  assertEqual(snapshotFor(room, a.token).run.roomState.pendingRolls[a.playerId][0], roll)
  assertEqual(snapshotFor(room, b.token).run.roomState.pendingRolls[a.playerId], undefined)
})

check('Event exchanges require the target owner and restore their private prompt on reconnect', () => {
  const { room, a, b } = twoSeatRoom()
  room.run.phase = 'room'
  room.run.combat = null
  room.run.roomState = createEventRoom({ ...EVENT_DEFINITIONS.note_for_yourself, instanceId: 'test-note', act: 2, minAscension: 0, requiresColorlessUnlock: false })
  const offered = room.run.players.find((player) => player.id === a.playerId).deck[0]
  const returned = room.run.players.find((player) => player.id === b.playerId).deck[0]
  apply(room, a.token, { kind: 'event', decision: { optionIds: ['exchange'], targetPlayerId: b.playerId, cardUids: [offered.uid] } })
  const targetView = snapshotFor(room, b.token)
  assertEqual(targetView.run.roomState.pendingTrade.offeredId, offered.defId)
  assert(!allStrings(snapshotFor(room, a.token)).includes(returned.uid), 'the target deck leaked while an exchange waited')
  let forged
  try { apply(room, a.token, { kind: 'event', decision: { optionIds: ['accept_trade'], cardUids: [returned.uid] } }) } catch (error) { forged = error }
  assertEqual(forged?.name, 'RoomError')
  markDisconnected(room, b.token)
  joinRoom(room, { token: b.token })
  assertEqual(snapshotFor(room, b.token).run.roomState.pendingTrade.targetId, b.playerId)
  apply(room, b.token, { kind: 'event', decision: { optionIds: ['accept_trade'], cardUids: [returned.uid] } })
  assert(room.run.players.find((player) => player.id === a.playerId).deck.some((card) => card.uid === returned.uid))
  assert(room.run.players.find((player) => player.id === b.playerId).deck.some((card) => card.uid === offered.uid))
})

check('uninvolved seats see a privacy-safe pending Event exchange marker', () => {
  const store = createStore()
  const room = createRoom(store, { code: 'TRADEX' })
  const a = joinRoom(room, { name: 'Ann', character: 'ironclad' })
  const b = joinRoom(room, { name: 'Bo', character: 'silent' })
  const c = joinRoom(room, { name: 'Cy', character: 'defect' })
  startRun(room, a.token, { seed: 552 })
  room.run.phase = 'room'
  room.run.roomState = createEventRoom({ ...EVENT_DEFINITIONS.note_for_yourself, instanceId: 'test-note-public-wait', act: 2, minAscension: 0, requiresColorlessUnlock: false })
  const offered = room.run.players.find((player) => player.id === a.playerId).deck[0]
  apply(room, a.token, { kind: 'event', decision: { optionIds: ['exchange'], targetPlayerId: b.playerId, cardUids: [offered.uid] } })
  const marker = snapshotFor(room, c.token).run.roomState.pendingTrade
  assertEqual(marker.targetId, b.playerId)
  assertEqual(marker.offeredId, '')
  assert(!allStrings(marker).includes(offered.defId), 'the offered private card leaked to an uninvolved seat')
  markDisconnected(room, c.token)
  joinRoom(room, { token: c.token })
  assertEqual(snapshotFor(room, c.token).run.roomState.pendingTrade.targetId, b.playerId)
})

check('paid Events preserve chooser selections while each token pledges only its own Gold', () => {
  const { room, a, b } = twoSeatRoom()
  room.run.phase = 'room'
  room.run.combat = null
  room.run.roomState = createEventRoom({ ...EVENT_DEFINITIONS.old_beggar, instanceId: 'test-beggar', act: 2, minAscension: 0, requiresColorlessUnlock: false })
  room.run.players = room.run.players.map((player) => ({ ...player, gold: player.id === b.playerId ? 2 : 0 }))
  const uid = room.run.players.find((player) => player.id === a.playerId).deck[0].uid
  apply(room, a.token, { kind: 'event', playerId: a.playerId, decision: { optionIds: ['give'], cardUids: [uid], payments: { [a.playerId]: 0 } } })
  assert(room.run.players.find((player) => player.id === a.playerId).deck.some((card) => card.uid === uid))
  assert(!allStrings(snapshotFor(room, b.token).eventPledge).includes(uid), 'the chooser card selection leaked to a contributor')
  let forged
  try { apply(room, b.token, { kind: 'event', playerId: a.playerId, decision: { optionIds: ['give'], payments: { [a.playerId]: 2 } } }) } catch (error) { forged = error }
  assertEqual(forged?.name, 'RoomError')
  apply(room, b.token, { kind: 'event', playerId: a.playerId, decision: { optionIds: ['give'], payments: { [b.playerId]: 2 } } })
  assertEqual(room.run.phase, 'room')
  assert(room.run.roomState.decisions[a.playerId])
  assert(!room.run.players.find((player) => player.id === a.playerId).deck.some((card) => card.uid === uid))
  assertEqual(room.run.players.find((player) => player.id === b.playerId).gold, 0)
})

check('Event contributors cannot switch the chooser from Gold to an item', () => {
  const { room, a, b } = twoSeatRoom()
  room.run.phase = 'room'
  room.run.combat = null
  room.run.roomState = createEventRoom({ ...EVENT_DEFINITIONS.the_joust, instanceId: 'test-joust-method', act: 2, minAscension: 0, requiresColorlessUnlock: false })
  room.run.players = room.run.players.map((player) => ({ ...player, gold: player.id === b.playerId ? 2 : 0 }))
  const relicId = room.run.players.find((player) => player.id === a.playerId).relics[0].defId
  apply(room, a.token, { kind: 'event', playerId: a.playerId, decision: { optionIds: ['bet'], payments: { [a.playerId]: 0 } } })
  const before = structuredClone(room)
  let forged
  try { apply(room, b.token, { kind: 'event', playerId: a.playerId, decision: { optionIds: ['bet'], relicIds: [relicId], payments: { [b.playerId]: 2 } } }) } catch (error) { forged = error }
  assertEqual(forged?.name, 'RoomError')
  assertDeepEqual(room, before)
})

check('settled Joust payments survive the staged die and reconnect', () => {
  for (const payment of ['gold', 'potion']) {
    const { room, a } = twoSeatRoom()
    room.run.phase = 'room'
    room.run.combat = null
    room.run.roomState = createEventRoom({ ...EVENT_DEFINITIONS.the_joust, instanceId: `test-joust-${payment}`, act: 2, minAscension: 0, requiresColorlessUnlock: false })
    room.run.players = room.run.players.map((player) => player.id === a.playerId
      ? { ...player, gold: payment === 'gold' ? 2 : 0, relics: [], potions: payment === 'potion' ? ['swift_potion'] : [] }
      : player)
    const decision = payment === 'gold'
      ? { optionIds: ['bet'], payments: { [a.playerId]: 2 } }
      : { optionIds: ['bet'], potionIds: ['swift_potion'] }
    apply(room, a.token, { kind: 'event', decision })
    assertEqual(room.run.players.find((player) => player.id === a.playerId).gold, 0)
    assertEqual(room.run.players.find((player) => player.id === a.playerId).potions.length, 0)
    assertEqual(room.run.roomState.pendingRolls[a.playerId].length, 1)
    markDisconnected(room, a.token)
    joinRoom(room, { token: a.token })
    apply(room, a.token, { kind: 'event', decision: { optionIds: ['bet'] } })
    assert(room.run.roomState.decisions[a.playerId])
    assertEqual(room.run.roomState.pendingRolls?.[a.playerId], undefined)
  }
})

check('only the Event chooser can cancel an underfunded pledge after reconnect', () => {
  const { room, a, b } = twoSeatRoom()
  room.run.phase = 'room'
  room.run.combat = null
  room.run.roomState = createEventRoom({ ...EVENT_DEFINITIONS.old_beggar, instanceId: 'test-beggar-cancel', act: 2, minAscension: 0, requiresColorlessUnlock: false })
  room.run.players = room.run.players.map((player) => ({ ...player, gold: player.id === b.playerId ? 2 : 0 }))
  const uid = room.run.players.find((player) => player.id === a.playerId).deck[0].uid
  apply(room, a.token, { kind: 'event', decision: { optionIds: ['give'], cardUids: [uid], payments: { [a.playerId]: 0 } } })
  markDisconnected(room, a.token)
  joinRoom(room, { token: a.token })
  assert(snapshotFor(room, a.token).eventPledge)
  let foreign
  try { apply(room, b.token, { kind: 'eventCancel' }) } catch (error) { foreign = error }
  assertEqual(foreign?.name, 'RoomError')
  apply(room, a.token, { kind: 'eventCancel' })
  assertEqual(room.eventPledge, undefined)
  assertEqual(room.run.phase, 'room')
  assert(!room.run.roomState.decisions[a.playerId])
})

check('invalid exact Event funding leaves no ghost pledge or mutation', () => {
  const { room, a } = twoSeatRoom()
  room.run.phase = 'room'
  room.run.combat = null
  room.run.roomState = createEventRoom({ ...EVENT_DEFINITIONS.old_beggar, instanceId: 'test-beggar-invalid', act: 2, minAscension: 0, requiresColorlessUnlock: false })
  const before = structuredClone(room)
  let rejected
  try { apply(room, a.token, { kind: 'event', decision: { optionIds: ['give'], cardUids: ['forged-card'], payments: { [a.playerId]: 2 } } }) } catch (error) { rejected = error }
  assertEqual(rejected?.name, 'RoomError')
  assertEqual(room.eventPledge, undefined)
  assertDeepEqual(room, before)
})

check('invalid partial Event funding leaves no reconnect-persistent pledge', () => {
  const { room, a } = twoSeatRoom()
  room.run.phase = 'room'
  room.run.combat = null
  room.run.roomState = createEventRoom({ ...EVENT_DEFINITIONS.old_beggar, instanceId: 'test-beggar-invalid-partial', act: 2, minAscension: 0, requiresColorlessUnlock: false })
  room.run.players = room.run.players.map((player) => ({ ...player, gold: 0 }))
  const version = room.version
  let rejected
  try { apply(room, a.token, { kind: 'event', decision: { optionIds: ['give'], cardUids: ['forged-card'], payments: { [a.playerId]: 0 } } }) } catch (error) { rejected = error }
  assertEqual(rejected?.name, 'RoomError')
  assertEqual(room.eventPledge, undefined)
  const uid = room.run.players.find((player) => player.id === a.playerId).deck[0].uid
  let unaffordable
  try { apply(room, a.token, { kind: 'event', decision: { optionIds: ['give'], cardUids: [uid], payments: { [a.playerId]: 0 } } }) } catch (error) { unaffordable = error }
  assertEqual(unaffordable?.name, 'RoomError')
  assertEqual(room.eventPledge, undefined)
  assertEqual(room.version, version)
  markDisconnected(room, a.token)
  joinRoom(room, { token: a.token })
  assertEqual(snapshotFor(room, a.token).eventPledge, undefined)
})

check('paid Event items reveal publicly, survive reconnect, and charge once on resolution', () => {
  const { room, a, b } = twoSeatRoom()
  room.run.phase = 'room'
  room.run.combat = null
  room.run.roomState = createEventRoom({ ...EVENT_DEFINITIONS.woman_in_blue, instanceId: 'test-blue-reveal', act: 2, minAscension: 0, requiresColorlessUnlock: false })
  room.run.players = room.run.players.map((player) => player.id === a.playerId ? { ...player, gold: 3 } : player)
  const beforeGold = room.run.players.find((player) => player.id === a.playerId).gold
  apply(room, a.token, { kind: 'event', decision: { optionIds: ['buy_one'], payments: { [a.playerId]: 1 } } })
  const offer = snapshotFor(room, b.token).run.roomState.itemOffers[a.playerId][0]
  assertEqual(offer.kind, 'potion')
  assertEqual(room.run.players.find((player) => player.id === a.playerId).gold, beforeGold, 'revealing does not charge early')
  markDisconnected(room, a.token)
  joinRoom(room, { token: a.token })
  assertEqual(snapshotFor(room, a.token).run.roomState.itemOffers[a.playerId][0].id, offer.id)
  let forged
  try { apply(room, a.token, { kind: 'event', decision: { optionIds: ['buy_one'], rewardItemChoices: ['take'], rewardItemIds: ['fairy_in_a_bottle'], payments: { [a.playerId]: 1 } } }) } catch (error) { forged = error }
  assertEqual(forged?.name, 'RoomError')
  apply(room, a.token, { kind: 'event', decision: { optionIds: ['buy_one'], rewardItemChoices: ['skip'], payments: { [a.playerId]: 1 } } })
  assertEqual(room.run.players.find((player) => player.id === a.playerId).gold, beforeGold - 1)
})

check('shared Gold contributions survive a staged paid Event reward', () => {
  const { room, a, b } = twoSeatRoom()
  room.run.phase = 'room'
  room.run.combat = null
  room.run.roomState = createEventRoom({ ...EVENT_DEFINITIONS.woman_in_blue, instanceId: 'test-blue-shared', act: 2, minAscension: 0, requiresColorlessUnlock: false })
  room.run.players = room.run.players.map((player) => ({ ...player, gold: player.id === b.playerId ? 1 : 0 }))
  apply(room, a.token, { kind: 'event', decision: { optionIds: ['buy_one'], payments: { [a.playerId]: 0 } } })
  apply(room, a.token, { kind: 'event', decision: { optionIds: ['buy_one'], rewardItemChoices: ['skip'], payments: { [a.playerId]: 0 } } })
  assert(room.eventPledge)
  apply(room, b.token, { kind: 'event', playerId: a.playerId, decision: { optionIds: ['buy_one'], payments: { [b.playerId]: 1 } } })
  assertEqual(room.eventPledge, undefined)
  assertEqual(room.run.players.find((player) => player.id === b.playerId).gold, 0)
  assert(room.run.roomState.decisions[a.playerId])
})

check('paid reward Events serialize staging before shared Gold can be spent', () => {
  const { room, a, b } = twoSeatRoom()
  room.run.phase = 'room'
  room.run.combat = null
  room.run.roomState = createEventRoom({ ...EVENT_DEFINITIONS.woman_in_blue, instanceId: 'test-blue-concurrent', act: 2, minAscension: 0, requiresColorlessUnlock: false })
  room.run.players = room.run.players.map((player) => ({ ...player, gold: player.id === a.playerId ? 1 : 0 }))
  apply(room, a.token, { kind: 'event', decision: { optionIds: ['buy_one'] } })
  let concurrent
  try { apply(room, b.token, { kind: 'event', decision: { optionIds: ['buy_one'] } }) } catch (error) { concurrent = error }
  assertEqual(concurrent?.name, 'RoomError')
  assertEqual(room.run.roomState.pendingDecisions[b.playerId], undefined)
  apply(room, a.token, { kind: 'event', decision: { optionIds: ['buy_one'], rewardItemChoices: ['skip'], payments: { [a.playerId]: 1 } } })
  apply(room, b.token, { kind: 'event', decision: { optionIds: ['leave'] } })
  assertEqual(room.run.phase, 'map')
})

check('Falling face-up identities are public without exposing decks and survive reconnect', () => {
  const { room, a, b } = twoSeatRoom()
  room.run.phase = 'room'
  room.run.combat = null
  room.run.roomState = createEventRoom({ ...EVENT_DEFINITIONS.falling, instanceId: 'test-falling-public', act: 3, minAscension: 0, requiresColorlessUnlock: false })
  const reveals = Object.fromEntries(room.run.players.map((player) => [player.id, player.deck.slice(0, 3)]))
  room.run.roomState.revealedCards = Object.fromEntries(Object.entries(reveals).map(([id, cards]) => [id, cards.map((card) => card.uid)]))
  room.run.roomState.revealedCardDefs = Object.fromEntries(Object.entries(reveals).map(([id, cards]) => [id, cards.map((card) => card.defId)]))
  const view = snapshotFor(room, b.token)
  assertDeepEqual(view.run.roomState.revealedCardDefs[a.playerId], reveals[a.playerId].map((card) => card.defId))
  assertEqual(view.run.players.find((player) => player.id === a.playerId).deck, null)
  markDisconnected(room, b.token)
  joinRoom(room, { token: b.token })
  assertDeepEqual(snapshotFor(room, b.token).run.roomState.revealedCardDefs[a.playerId], reveals[a.playerId].map((card) => card.defId))
})

check('online Event snapshots publish authoritative Prismatic reward sources', () => {
  const { room, a } = twoSeatRoom()
  room.run.phase = 'room'
  room.run.combat = null
  room.run.roomState = createEventRoom({ ...EVENT_DEFINITIONS.cursed_tome, instanceId: 'test-prismatic-sources', act: 2, minAscension: 0, requiresColorlessUnlock: false })
  room.run.roomState.availableRewardSources = {
    card: ['silent', 'defect', 'watcher', 'colorless'],
    rare: ['ironclad', 'defect', 'watcher'],
  }
  assertDeepEqual(snapshotFor(room, a.token).run.roomState.availableRewardSources, room.run.roomState.availableRewardSources)
})

check('shared Event reward previews serialize across seats and reconnect', () => {
  const { room, a, b } = twoSeatRoom()
  room.run.phase = 'room'
  room.run.combat = null
  room.run.roomState = createEventRoom({ ...EVENT_DEFINITIONS.sensory_stone, instanceId: 'test-stone-serialized', act: 3, minAscension: 0, requiresColorlessUnlock: true })
  room.run.itemDecks.colorless = ['apotheosis', 'bandage_up', 'blind', 'dark_shackles', 'deep_breath', 'discovery']
  apply(room, a.token, { kind: 'event', decision: { optionIds: ['recall_one'] } })
  const offer = snapshotFor(room, b.token).run.roomState.rewardOffers[a.playerId][0]
  let raced
  try { apply(room, b.token, { kind: 'event', decision: { optionIds: ['recall_one'] } }) } catch (error) { raced = error }
  assertEqual(raced?.name, 'RoomError')
  markDisconnected(room, a.token)
  joinRoom(room, { token: a.token })
  assertDeepEqual(snapshotFor(room, a.token).run.roomState.rewardOffers[a.playerId][0], offer)
  apply(room, a.token, { kind: 'event', decision: { optionIds: ['recall_one'], rewardIndexes: [-1] } })
  apply(room, b.token, { kind: 'event', decision: { optionIds: ['recall_one'] } })
  assert(JSON.stringify(room.run.roomState.rewardOffers[b.playerId][0]) !== JSON.stringify(offer))
})

check('party Event item staging has one authoritative owner', () => {
  const { room, a, b } = twoSeatRoom()
  room.run.phase = 'room'
  room.run.combat = null
  room.run.roomState = createEventRoom({ ...EVENT_DEFINITIONS.tomb_red_mask, instanceId: 'test-tomb-serialized', act: 3, minAscension: 0, requiresColorlessUnlock: false })
  const before = room.run.itemDecks.relics.length
  apply(room, a.token, { kind: 'event', decision: { optionIds: ['offer_gold'] } })
  let raced
  try { apply(room, b.token, { kind: 'event', decision: { optionIds: ['offer_gold'] } }) } catch (error) { raced = error }
  assertEqual(raced?.name, 'RoomError')
  assertEqual(room.run.itemDecks.relics.length, before - 2)
  assertEqual(Object.keys(room.run.roomState.itemOffers).length, 1)
})

check('Face Trader staged Relic choice survives reconnect without accepting a forged Relic', () => {
  const { room, a } = twoSeatRoom()
  room.run.phase = 'room'
  room.run.combat = null
  room.run.roomState = createEventRoom({ ...EVENT_DEFINITIONS.face_trader, instanceId: 'test-face-trader', act: 3, minAscension: 0, requiresColorlessUnlock: false })
  room.run.players = room.run.players.map((player) => player.id === a.playerId ? { ...player, relics: [] } : player)
  room.run.itemDecks.relics = ['anchor', ...room.run.itemDecks.relics.filter((id) => id !== 'anchor')]
  apply(room, a.token, { kind: 'event', decision: { optionIds: ['take_and_give'] } })
  markDisconnected(room, a.token)
  joinRoom(room, { token: a.token })
  assert(snapshotFor(room, a.token).run.roomState.pendingDecisions[a.playerId])
  let forged
  try { apply(room, a.token, { kind: 'event', decision: { optionIds: ['take_and_give'], relicIds: ['happy_flower'] } }) } catch (error) { forged = error }
  assertEqual(forged?.name, 'RoomError')
  apply(room, a.token, { kind: 'event', decision: { optionIds: ['take_and_give'], relicIds: ['anchor'] } })
  assert(!room.run.players.find((player) => player.id === a.playerId).relics.some((relic) => relic.defId === 'anchor'))
})

check('an Event cannot strand a pending Relic on a disconnected recipient', () => {
  const { room, a, b } = twoSeatRoom()
  room.run.phase = 'room'
  room.run.combat = null
  room.run.roomState = createEventRoom({ ...EVENT_DEFINITIONS.tomb_red_mask, instanceId: 'test-tomb-disconnected-relic', act: 3, minAscension: 0, requiresColorlessUnlock: false })
  room.run.itemDecks.relics = ['happy_flower', 'war_paint', ...room.run.itemDecks.relics]
  const skillUid = room.run.players.find((player) => player.id === b.playerId).deck
    .find((card) => !card.upgraded && CARDS[card.defId]?.type === 'skill').uid
  markDisconnected(room, b.token)
  apply(room, a.token, { kind: 'event', decision: { optionIds: ['offer_gold'] } })
  apply(room, a.token, { kind: 'event', decision: { optionIds: ['offer_gold'], rewardItemChoices: ['take', 'take'] } })
  const recipient = room.run.players.find((player) => player.id === b.playerId)
  assert(recipient.deck.find((card) => card.uid === skillUid).upgraded)
  assert(!recipient.relics.some((relic) => relic.pending))
  assertEqual(room.run.phase, 'map')
})

check('campaign finish, shared allocation, and next run stay server-authoritative', () => {
  const { room, a, b } = twoSeatRoom()
  room.campaignProgress = { ...room.campaignProgress, characters: { ...room.campaignProgress.characters, ironclad: 8, silent: 8 } }
  room.run = { ...room.run, phase: 'defeat', campaignProgress: room.campaignProgress }
  apply(room, b.token, { kind: 'finishRun' })
  assertEqual(room.campaignProgress.unspentMarks, 2)
  const once = JSON.stringify(room.campaignProgress)
  let replay
  try { apply(room, a.token, { kind: 'finishRun' }) } catch (error) { replay = error }
  assertEqual(replay?.name, 'RoomError')
  assertEqual(JSON.stringify(room.campaignProgress), once)
  let foreign
  try { apply(room, b.token, { kind: 'allocateCampaign', colorless: 1, actIV: 0, expectedUnspentMarks: 2, expectedRunId: room.run.campaign.runId }) } catch (error) { foreign = error }
  assertEqual(foreign?.name, 'RoomError')
  const allocation = { kind: 'allocateCampaign', colorless: 1, actIV: 0, expectedUnspentMarks: 2, expectedRunId: room.run.campaign.runId }
  const beforeNoop = structuredClone(room)
  let noop
  try { apply(room, a.token, { ...allocation, colorless: 0 }) } catch (error) { noop = error }
  assertEqual(noop?.name, 'RoomError')
  assertDeepEqual(room, beforeNoop)
  apply(room, a.token, allocation)
  const afterAllocation = structuredClone(room)
  let duplicate
  try { apply(room, a.token, allocation) } catch (error) { duplicate = error }
  assertEqual(duplicate?.name, 'RoomError')
  assertDeepEqual(room, afterAllocation)
  const beforeStaleRun = structuredClone(room)
  let staleRun
  try { apply(room, a.token, { ...allocation, expectedUnspentMarks: 1, expectedRunId: 'campaign-previous' }) } catch (error) { staleRun = error }
  assertEqual(staleRun?.name, 'RoomError')
  assertDeepEqual(room, beforeStaleRun)
  apply(room, a.token, { kind: 'allocateCampaign', colorless: 0, actIV: 1, expectedUnspentMarks: 1, expectedRunId: room.run.campaign.runId })
  assertEqual(room.campaignProgress.unspentMarks, 0)
  apply(room, a.token, { kind: 'returnToLobby' })
  assertEqual(room.phase, 'lobby')
  assertEqual(room.run, null)
})

check('campaign marks cannot be claimed while a mandatory Relic choice is pending', () => {
  const { room, a } = twoSeatRoom()
  room.run = {
    ...room.run,
    phase: 'victory',
    players: room.run.players.map((player) => player.id === a.playerId
      ? { ...player, relics: [...player.relics, { defId: 'war_paint', spent: false, pending: true }] }
      : player),
  }
  const before = structuredClone(room)
  let refused
  try { apply(room, a.token, { kind: 'finishRun' }) } catch (error) { refused = error }
  assertEqual(refused?.name, 'RoomError')
  assertDeepEqual(room, before)
})

check('a stale advance action cannot continue a finalized campaign', () => {
  const { room, a } = twoSeatRoom()
  room.run = { ...room.run, phase: 'victory', map: { ...room.run.map, position: room.run.map.rows.at(-1)[0], rooms: Object.fromEntries(Object.entries(room.run.map.rooms).map(([id, value]) => [id, { ...value, visited: true }])) }, campaign: { ...room.run.campaign, bossesDefeated: 1, highestBossActDefeated: 1 } }
  apply(room, a.token, { kind: 'finishRun' })
  const before = JSON.stringify(room.run)
  const stale = apply(room, a.token, { kind: 'advanceAct' })
  assertEqual(stale.changed, false)
  assertEqual(JSON.stringify(room.run), before)
  markDisconnected(room, a.token)
  joinRoom(room, { token: a.token })
  assert(snapshotFor(room, a.token).run.campaign.finalized)
})

check('The Courier reveal and shared purchase are authoritative and reconnect-safe', () => {
  const { room, a, b } = twoSeatRoom()
  room.run.itemDecks.relics = ['anchor', ...room.run.itemDecks.relics.filter((id) => id !== 'anchor')]
  room.run.combat.players = room.run.combat.players.map((player) => ({
    ...player,
    gold: player.id === a.playerId ? 0 : 6,
    relics: player.id === a.playerId ? [...player.relics, { defId: 'the_courier', spent: false }] : player.relics,
  }))
  apply(room, a.token, { kind: 'courierReveal', itemKind: 'relic' })
  assertEqual(snapshotFor(room, b.token).run.courier.offer.id, 'anchor')
  assertEqual(snapshotFor(room, b.token).run.itemDecks, undefined)
  let bypass
  try { apply(room, a.token, { kind: 'endTurn' }) } catch (error) { bypass = error }
  assertEqual(bypass?.name, 'RoomError')
  let hijack
  try { apply(room, b.token, { kind: 'courierResolve', playerId: a.playerId, decision: 'buy', payments: { [b.playerId]: 4 } }) } catch (error) { hijack = error }
  assertEqual(hijack?.name, 'RoomError')
  apply(room, a.token, { kind: 'courierResolve', playerId: a.playerId, decision: 'buy', payments: { [a.playerId]: 0 } })
  markDisconnected(room, a.token)
  joinRoom(room, { token: a.token })
  assertEqual(snapshotFor(room, a.token).courierPledge.payments[a.playerId], 0)
  const fallen = room.run.combat.players.find((player) => player.id === b.playerId)
  fallen.dead = true
  let fallenPayment
  try { apply(room, b.token, { kind: 'courierResolve', playerId: a.playerId, decision: 'buy', payments: { [b.playerId]: 6 } }) } catch (error) { fallenPayment = error }
  assertEqual(fallenPayment?.name, 'RoomError')
  assertEqual(fallen.gold, 6)
  fallen.dead = false
  apply(room, b.token, { kind: 'courierResolve', playerId: a.playerId, decision: 'buy', payments: { [b.playerId]: 6 } })
  assert(room.run.combat.players.find((player) => player.id === a.playerId).relics.some((relic) => relic.defId === 'anchor'))
  assertEqual(room.run.courier.offer, null)
  let twice
  try { apply(room, a.token, { kind: 'courierReveal', itemKind: 'potion' }) } catch (error) { twice = error }
  assertEqual(twice?.name, 'RoomError')
})

check('an unpledged Courier offer auto-discards when its owner disconnects', () => {
  const { room, a, b } = twoSeatRoom()
  room.run.itemDecks.relics = ['anchor', ...room.run.itemDecks.relics.filter((id) => id !== 'anchor')]
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  actor.relics = [...actor.relics, { defId: 'the_courier', spent: false }]
  apply(room, a.token, { kind: 'courierReveal', itemKind: 'relic' })
  const revealed = room.run.courier.offer.id

  markDisconnected(room, a.token)
  assertEqual(room.run.courier.offer, null)
  assertEqual(room.run.itemDecks.relics.at(-1), revealed)
  assertEqual(apply(room, b.token, { kind: 'endTurn' }).changed, true)

  joinRoom(room, { token: a.token })
  assertEqual(snapshotFor(room, a.token).run.courier.offer, null)
})

check('an impossible Courier pledge auto-discards when its owner disconnects', () => {
  const { room, a, b } = twoSeatRoom()
  room.run.itemDecks.relics = ['anchor', ...room.run.itemDecks.relics.filter((id) => id !== 'anchor')]
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  actor.gold = 6
  actor.relics = [...actor.relics, { defId: 'the_courier', spent: false }]
  room.run.combat.players.find((player) => player.id === b.playerId).gold = 0
  apply(room, a.token, { kind: 'courierReveal', itemKind: 'relic' })
  apply(room, a.token, { kind: 'courierResolve', decision: 'buy', payments: { [a.playerId]: 0 } })
  markDisconnected(room, a.token)
  assertEqual(room.courierPledge, undefined)
  assertEqual(room.run.courier.offer, null)
  assertEqual(apply(room, b.token, { kind: 'endTurn' }).changed, true)
})

check('sequential disconnects cancel every newly impossible owner pledge', () => {
  const merchant = threeSeatRoom()
  merchant.room.run.phase = 'room'
  merchant.room.run.combat = null
  merchant.room.run.players = merchant.room.run.players.map((player) => ({
    ...player,
    gold: player.id === merchant.c.playerId ? 5 : 0,
  }))
  merchant.room.run.itemDecks.relics = ['anchor', ...merchant.room.run.itemDecks.relics.filter((id) => id !== 'anchor')]
  merchant.room.run.roomState = createMerchant(merchant.room.run.itemDecks, merchant.room.run.players)
  apply(merchant.room, merchant.b.token, { kind: 'merchantPurchase', purchase: {
    buyerId: merchant.b.playerId, section: 'relic', slot: 0, payments: { [merchant.b.playerId]: 0 },
  } })
  markDisconnected(merchant.room, merchant.b.token)
  assert(merchant.room.merchantPledges)
  markDisconnected(merchant.room, merchant.c.token)
  assertEqual(Object.keys(merchant.room.merchantPledges).length, 0)
  apply(merchant.room, merchant.a.token, { kind: 'merchantFinish' })
  assertEqual(merchant.room.run.phase, 'map')

  const courier = threeSeatRoom()
  courier.room.run.itemDecks.relics = ['anchor', ...courier.room.run.itemDecks.relics.filter((id) => id !== 'anchor')]
  courier.room.run.combat.players = courier.room.run.combat.players.map((player) => ({
    ...player,
    gold: player.id === courier.c.playerId ? 6 : 0,
    relics: player.id === courier.b.playerId
      ? [...player.relics, { defId: 'the_courier', spent: false }]
      : player.relics,
  }))
  apply(courier.room, courier.b.token, { kind: 'courierReveal', itemKind: 'relic' })
  apply(courier.room, courier.b.token, { kind: 'courierResolve', decision: 'buy', payments: { [courier.b.playerId]: 0 } })
  markDisconnected(courier.room, courier.b.token)
  assert(courier.room.courierPledge)
  markDisconnected(courier.room, courier.c.token)
  assertEqual(courier.room.courierPledge, undefined)
  assertEqual(courier.room.run.courier.offer, null)

  const event = threeSeatRoom()
  event.room.run.phase = 'room'
  event.room.run.combat = null
  event.room.run.players = event.room.run.players.map((player) => ({
    ...player,
    gold: player.id === event.c.playerId ? 2 : 0,
  }))
  event.room.run.roomState = createEventRoom({ ...EVENT_DEFINITIONS.old_beggar, instanceId: 'test-beggar-sequential-disconnect', act: 2, minAscension: 0, requiresColorlessUnlock: false })
  const uid = event.room.run.players.find((player) => player.id === event.b.playerId).deck[0].uid
  apply(event.room, event.b.token, { kind: 'event', decision: {
    optionIds: ['give'], cardUids: [uid], payments: { [event.b.playerId]: 0 },
  } })
  markDisconnected(event.room, event.b.token)
  assert(event.room.eventPledge)
  markDisconnected(event.room, event.c.token)
  assertEqual(event.room.eventPledge, undefined)
})

check('Courier one-shot Relics wait through combat and reconnect without deadlocking authority', () => {
  const { room, a } = twoSeatRoom()
  room.run.itemDecks.relics = ['war_paint', ...room.run.itemDecks.relics.filter((id) => id !== 'war_paint')]
  let actor = room.run.combat.players.find((player) => player.id === a.playerId)
  actor.gold = 8
  actor.energy = 1
  actor.hand = [{ uid: 'courier-pending-defend', defId: 'defend_ironclad', upgraded: false }]
  actor.relics = [...actor.relics, { defId: 'the_courier', spent: false }]
  apply(room, a.token, { kind: 'courierReveal', itemKind: 'relic' })
  apply(room, a.token, { kind: 'courierResolve', decision: 'buy', payments: { [a.playerId]: 8 } })
  assert(room.run.players.find((player) => player.id === a.playerId).relics
    .some((relic) => relic.defId === 'war_paint' && relic.pending))

  markDisconnected(room, a.token)
  joinRoom(room, { token: a.token })
  assertEqual(snapshotFor(room, a.token).pendingRelic?.relicId, 'war_paint')
  apply(room, a.token, { kind: 'playCard', cardUid: 'courier-pending-defend', preflight: true })
  assert(room.run.combat.players.find((player) => player.id === a.playerId).discard
    .some((card) => card.uid === 'courier-pending-defend'), 'pending Courier Relic blocked combat play')

  room.run.combat.phase = 'won'
  apply(room, a.token, { kind: 'resolveCombat' })
  const owner = room.run.players.find((player) => player.id === a.playerId)
  const starter = owner.deck.find((card) => card.defId.startsWith('defend_') && !card.upgraded)
  const skill = owner.deck.find((card) => card.uid !== starter?.uid && !card.upgraded && CARDS[card.defId]?.type === 'skill')
  apply(room, a.token, { kind: 'resolvePendingRelic', cardUids: skill ? [skill.uid] : [] })
  assert(!room.run.players.find((player) => player.id === a.playerId).relics.some((relic) => relic.pending))
})

check('a disconnected Courier Relic owner settles after combat without blocking the party', () => {
  const { room, a, b } = twoSeatRoom()
  room.run.itemDecks.relics = ['war_paint', ...room.run.itemDecks.relics.filter((id) => id !== 'war_paint')]
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  actor.gold = 8
  actor.relics = [...actor.relics, { defId: 'the_courier', spent: false }]
  apply(room, a.token, { kind: 'courierReveal', itemKind: 'relic' })
  apply(room, a.token, { kind: 'courierResolve', decision: 'buy', payments: { [a.playerId]: 8 } })
  markDisconnected(room, a.token)

  room.run.combat.phase = 'won'
  apply(room, b.token, { kind: 'resolveCombat' })
  assert(!room.run.players.find((player) => player.id === a.playerId).relics.some((relic) => relic.pending))
  const offer = room.run.phase === 'reward'
    ? room.run.rewards.find((reward) => reward.playerId === b.playerId)
    : undefined
  const followup = !offer ? null
    : offer.cardReward ? { kind: 'cardReward', choice: 'reveal' }
      : offer.potion !== false ? { kind: 'potionReward', choice: 'reveal' }
        : offer.relic !== false ? { kind: 'relicReward', choice: 'reveal' }
          : null
  if (followup) assertEqual(apply(room, b.token, followup).changed, true)
  else assert(room.run.phase !== 'combat', 'the connected seat remained blocked in combat')

  joinRoom(room, { token: a.token })
  const reconnected = snapshotFor(room, a.token)
  assertEqual(reconnected.pendingRelic, null)
  assertEqual(reconnected.pendingRelicStatus, null)
})

check('a rejected exact Courier buy leaves no poisoned pledge', () => {
  const { room, a } = twoSeatRoom()
  room.run.combat.potionDeck = ['fire_potion', ...room.run.combat.potionDeck.filter((id) => id !== 'fire_potion')]
  room.run.ascension = 4
  room.run.combat.players = room.run.combat.players.map((player) => player.id === a.playerId ? {
    ...player, gold: 2, potions: ['swift_potion', 'block_potion'], relics: [...player.relics, { defId: 'the_courier', spent: false }],
  } : player)
  apply(room, a.token, { kind: 'courierReveal', itemKind: 'potion' })
  let rejected
  try { apply(room, a.token, { kind: 'courierResolve', decision: 'buy', payments: { [a.playerId]: 2 } }) } catch (error) { rejected = error }
  assertEqual(rejected?.name, 'RoomError')
  assertEqual(room.courierPledge, undefined)
  apply(room, a.token, { kind: 'courierResolve', decision: 'buy', discardPotionId: 'swift_potion', payments: { [a.playerId]: 2 } })
  const owner = room.run.combat.players.find((player) => player.id === a.playerId)
  assert(owner.potions.includes('fire_potion'))
  assert(!owner.potions.includes('swift_potion'))
})

check('a rejected partial Courier buy leaves no poisoned pledge', () => {
  const { room, a } = twoSeatRoom()
  room.run.combat.potionDeck = ['fire_potion', ...room.run.combat.potionDeck.filter((id) => id !== 'fire_potion')]
  room.run.ascension = 4
  room.run.combat.players = room.run.combat.players.map((player) => player.id === a.playerId ? {
    ...player, gold: 1, potions: ['swift_potion', 'block_potion'], relics: [...player.relics, { defId: 'the_courier', spent: false }],
  } : player)
  apply(room, a.token, { kind: 'courierReveal', itemKind: 'potion' })
  const version = room.version
  let rejected
  try { apply(room, a.token, { kind: 'courierResolve', decision: 'buy', payments: { [a.playerId]: 1 } }) } catch (error) { rejected = error }
  assertEqual(rejected?.name, 'RoomError')
  assertEqual(room.courierPledge, undefined)
  assertEqual(room.version, version)
})

check('an unaffordable Courier offer cannot create a pledge', () => {
  const { room, a } = twoSeatRoom()
  room.run.itemDecks.relics = ['anchor', ...room.run.itemDecks.relics.filter((id) => id !== 'anchor')]
  room.run.combat.players = room.run.combat.players.map((player) => ({
    ...player, gold: 0, relics: player.id === a.playerId ? [...player.relics, { defId: 'the_courier', spent: false }] : player.relics,
  }))
  apply(room, a.token, { kind: 'courierReveal', itemKind: 'relic' })
  const version = room.version
  let rejected
  try { apply(room, a.token, { kind: 'courierResolve', decision: 'buy', payments: { [a.playerId]: 0 } }) } catch (error) { rejected = error }
  assertEqual(rejected?.name, 'RoomError')
  assertEqual(room.courierPledge, undefined)
  assertEqual(room.version, version)
})

check('paid staged Events reject impossible funding and locked-selector forgery', () => {
  const { room, a, b } = twoSeatRoom()
  room.run.phase = 'room'
  room.run.combat = null
  room.run.players = room.run.players.map((player) => ({ ...player, gold: 0 }))
  room.run.roomState = createEventRoom({ ...EVENT_DEFINITIONS.woman_in_blue, instanceId: 'test-zero-blue', act: 2, minAscension: 0, requiresColorlessUnlock: false })
  const before = structuredClone(room.run)
  let unaffordable
  try { apply(room, a.token, { kind: 'event', decision: { optionIds: ['buy_one'], payments: { [a.playerId]: 0 } } }) } catch (error) { unaffordable = error }
  assertEqual(unaffordable?.name, 'RoomError')
  assertDeepEqual(room.run, before)
  markDisconnected(room, a.token)
  joinRoom(room, { token: a.token })
  assertEqual(snapshotFor(room, a.token).run.roomState.itemOffers[a.playerId], undefined)

  room.run.roomState = createEventRoom({ ...EVENT_DEFINITIONS.note_for_yourself, instanceId: 'test-lock-note', act: 2, minAscension: 0, requiresColorlessUnlock: false })
  room.run.players.push({ ...room.run.players[1], id: 'p3', name: 'Cy', row: 2, cardRewards: ['ball_lightning', 'cold_snap', 'charge_battery'] })
  room.run.players.find((player) => player.id === b.playerId).cardRewards = ['backflip', 'acrobatics', 'dagger_throw']
  apply(room, a.token, { kind: 'event', decision: { optionIds: ['take'], targetPlayerId: b.playerId } })
  apply(room, a.token, { kind: 'event', decision: { optionIds: ['take'], targetPlayerId: 'p3', rewardIndexes: [0] } })
  assert(room.run.players.find((player) => player.id === a.playerId).deck.some((card) => card.defId === 'backflip'))
  assert(!room.run.players.find((player) => player.id === a.playerId).deck.some((card) => card.defId === 'ball_lightning'))
})

check('Event contributors cannot switch options or forge a target receipt', () => {
  const { room, a, b } = twoSeatRoom()
  room.run.phase = 'room'
  room.run.combat = null
  room.run.players = room.run.players.map((player) => ({ ...player, gold: 3 }))
  room.run.roomState = createEventRoom({ ...EVENT_DEFINITIONS.designer, instanceId: 'test-locked-designer', act: 2, minAscension: 0, requiresColorlessUnlock: false })
  const uid = room.run.players.find((player) => player.id === a.playerId).deck[0].uid
  apply(room, a.token, { kind: 'event', decision: { optionIds: ['adjustment'], cardUids: [uid], payments: { [a.playerId]: 0 } } })
  let switched
  try { apply(room, b.token, { kind: 'event', playerId: a.playerId, decision: { optionIds: ['punch'] } }) } catch (error) { switched = error }
  assertEqual(switched?.name, 'RoomError')
  assertEqual(room.eventPledge.optionId, 'adjustment')

  room.eventPledge = undefined
  room.run.roomState = createEventRoom({ ...EVENT_DEFINITIONS.note_for_yourself, instanceId: 'test-forged-trade', act: 2, minAscension: 0, requiresColorlessUnlock: false })
  const offered = room.run.players.find((player) => player.id === a.playerId).deck[0].uid
  const receive = room.run.players.find((player) => player.id === b.playerId).deck[0].uid
  let forged
  try { apply(room, a.token, { kind: 'event', decision: { optionIds: ['exchange'], targetPlayerId: b.playerId, cardUids: [offered], receiveCardUid: receive } }) } catch (error) { forged = error }
  assertEqual(forged?.name, 'RoomError')
  assertEqual(room.run.roomState.pendingTrade, undefined)
})

check('Event reveal choices are server-authored and reconnect before selection', () => {
  const { room, a } = twoSeatRoom()
  room.run.phase = 'room'
  room.run.combat = null
  room.run.roomState = createEventRoom({ ...EVENT_DEFINITIONS.the_library, instanceId: 'test-server-library', act: 1, minAscension: 0, requiresColorlessUnlock: false })
  apply(room, a.token, { kind: 'event', decision: { optionIds: ['read'], rewardIndexes: [4] } })
  const offer = room.run.roomState.rewardOffers[a.playerId][0]
  assertEqual(snapshotFor(room, a.token).run.roomState.pendingDecisions[a.playerId].rewardIndexes, undefined)
  markDisconnected(room, a.token)
  joinRoom(room, { token: a.token })
  assertDeepEqual(snapshotFor(room, a.token).run.roomState.rewardOffers[a.playerId][0], offer)
  apply(room, a.token, { kind: 'event', decision: { optionIds: ['read'], rewardIndexes: [0] } })
  assert(room.run.players.find((player) => player.id === a.playerId).deck.some((card) => card.defId === offer[0]))
})

check('a revealed Event reward cannot swap its locked payment item', () => {
  const { room, a } = twoSeatRoom()
  room.run.phase = 'room'
  room.run.combat = null
  const owner = room.run.players.find((player) => player.id === a.playerId)
  owner.relics = [{ defId: 'anchor', spent: false }, { defId: 'happy_flower', spent: false }]
  room.run.roomState = createEventRoom({ ...EVENT_DEFINITIONS.we_meet_again, instanceId: 'test-lock-relic', act: 2, minAscension: 0, requiresColorlessUnlock: false })
  apply(room, a.token, { kind: 'event', decision: { optionIds: ['exchange'], relicIds: ['anchor'] } })
  apply(room, a.token, { kind: 'event', decision: { optionIds: ['exchange'], relicIds: ['happy_flower'], rewardItemChoices: ['take'] } })
  const resolved = room.run.players.find((player) => player.id === a.playerId)
  assert(resolved.relics.some((relic) => relic.defId === 'happy_flower'))
  assert(!resolved.relics.some((relic) => relic.defId === 'anchor'))
})

check('only the blocked Event seat can use the no-legal-choice escape after reconnect', () => {
  const { room, a, b } = twoSeatRoom()
  room.run.phase = 'room'
  room.run.combat = null
  room.run.players = room.run.players.map((player) => ({ ...player, gold: 0, relics: [], potions: [] }))
  room.run.roomState = createEventRoom({ ...EVENT_DEFINITIONS.old_beggar, instanceId: 'test-skip-beggar', act: 2, minAscension: 0, requiresColorlessUnlock: false })
  assertEqual(snapshotFor(room, a.token).eventCanSkip, true)
  let forged
  try { apply(room, b.token, { kind: 'eventSkip', playerId: a.playerId }) } catch (error) { forged = error }
  assertEqual(forged?.name, 'RoomError')
  markDisconnected(room, a.token)
  joinRoom(room, { token: a.token })
  apply(room, a.token, { kind: 'eventSkip' })
  assertEqual(room.run.roomState.decisions[a.playerId].optionIds[0], 'unavailable')
  apply(room, b.token, { kind: 'eventSkip' })
  assertEqual(room.run.phase, 'map')
})

check('four-player Big Fish rejects used staged choices and reconnects the final no-choice seat', () => {
  const store = createStore()
  const room = createRoom(store, { code: 'BIGFSH' })
  const seats = [
    joinRoom(room, { name: 'Ann', character: 'ironclad' }),
    joinRoom(room, { name: 'Bo', character: 'silent' }),
    joinRoom(room, { name: 'Cy', character: 'defect' }),
    joinRoom(room, { name: 'Di', character: 'watcher' }),
  ]
  startRun(room, seats[0].token, { seed: 8128 })
  room.run.phase = 'room'
  room.run.roomState = createEventRoom({ ...EVENT_DEFINITIONS.big_fish, instanceId: 'test-four-fish', act: 1, minAscension: 0, requiresColorlessUnlock: false })
  apply(room, seats[0].token, { kind: 'event', decision: { optionIds: ['box'] } })
  markDisconnected(room, seats[0].token)
  joinRoom(room, { token: seats[0].token })
  apply(room, seats[0].token, { kind: 'event', decision: { optionIds: ['box'], rewardItemChoices: ['skip'] } })
  let duplicate
  try { apply(room, seats[1].token, { kind: 'event', decision: { optionIds: ['box'] } }) } catch (error) { duplicate = error }
  assertEqual(duplicate?.name, 'RoomError')
  apply(room, seats[1].token, { kind: 'event', decision: { optionIds: ['banana'] } })
  const third = room.run.players.find((player) => player.id === seats[2].playerId)
  const strike = third.deck.find((entry) => CARDS[entry.defId]?.rarity === 'starter' && CARDS[entry.defId]?.name === 'Strike')
  apply(room, seats[2].token, { kind: 'event', decision: { optionIds: ['donut'], cardUids: [strike.uid] } })
  const fourth = room.run.players.find((player) => player.id === seats[3].playerId)
  fourth.deck = fourth.deck.filter((entry) => !(CARDS[entry.defId]?.rarity === 'starter' && CARDS[entry.defId]?.name === 'Strike'))
  assertEqual(snapshotFor(room, seats[3].token).eventCanSkip, false)
  markDisconnected(room, seats[3].token)
  joinRoom(room, { token: seats[3].token })
  apply(room, seats[3].token, { kind: 'event', decision: { optionIds: ['restraint'] } })
  assertEqual(room.run.phase, 'map')
})

check('only the leader configures official run modes and Quick Start reconnects without hidden decks', () => {
  const store = createStore()
  const room = createRoom(store, { code: 'METARU' })
  const leader = joinRoom(room, { name: 'Ann', character: 'ironclad' })
  const guest = joinRoom(room, { name: 'Bo', character: 'silent' })
  let denied
  try { chooseRunMeta(room, guest.token, { mode: 'custom', modifiers: ['cursed'], quickStartAct: 2 }) } catch (error) { denied = error }
  assertEqual(denied?.name, 'RoomError')
  denied = undefined
  try { startRun(room, guest.token, { seed: 913 }) } catch (error) { denied = error }
  assertEqual(denied?.name, 'RoomError')
  assertEqual(room.phase, 'lobby', 'a guest started the run')
  chooseRunMeta(room, leader.token, { mode: 'custom', modifiers: ['cursed', 'bogus'], quickStartAct: 2 })
  startRun(room, leader.token, { seed: 913 })
  assertDeepEqual(room.run.meta.modifierIds, ['cursed'])
  finishNeow(room)
  assertEqual(room.run.phase, 'setup')
  const snapshot = snapshotFor(room, guest.token)
  assertEqual(snapshot.run.setup.targetAct, 2)
  assert(!JSON.stringify(snapshot).includes('itemDecks'))
  assert(!JSON.stringify(snapshot).includes('bossRelicDeck'))
  markDisconnected(room, leader.token)
  joinRoom(room, { token: leader.token })
  apply(room, leader.token, { kind: 'setupStep' })
  assertEqual(room.run.players[0].gold, 6)
})

check('new seats Catch Up only at an untouched Act boundary and survive reconnect', () => {
  const store = createStore()
  const room = createRoom(store, { code: 'CATCHU' })
  const leader = joinRoom(room, { name: 'Ann', character: 'ironclad' })
  startRun(room, leader.token, { seed: 914 })
  finishNeow(room)
  room.run.act = 2
  room.run.map = { ...room.run.map, act: 2, position: null }
  const newcomer = joinRoom(room, { name: 'Bo', character: 'silent' })
  assertEqual(room.run.phase, 'neow')
  assertDeepEqual(room.run.setup.playerIds, [newcomer.playerId])
  const hidden = JSON.stringify(snapshotFor(room, leader.token))
  assert(!hidden.includes('rareRewards'))
  const overlapping = joinRoom(room, { name: 'Cy', character: 'defect', connected: false })
  assertEqual(overlapping.pendingCatchUp, true)
  joinRoom(room, { token: overlapping.token, connected: true })
  assertDeepEqual(room.run.setup.playerIds, [newcomer.playerId, overlapping.playerId])
  markDisconnected(room, newcomer.token)
  joinRoom(room, { token: newcomer.token })
  assert(snapshotFor(room, newcomer.token).run.neow.players[newcomer.playerId])
  room.run.phase = 'map'
  room.run.neow = null
  room.run.setup = null
  room.run.map.position = room.run.map.rows[0][0]
  let late
  try { joinRoom(room, { name: 'Cy', character: 'defect' }) } catch (error) { late = error }
  assertEqual(late?.name, 'RoomError')
})

check('a pending Catch Up reservation freezes the Act boundary until authentication', () => {
  const room = createRoom(createStore(), { code: 'CATCHR' })
  const leader = joinRoom(room, { name: 'Ann', character: 'ironclad' })
  const guest = joinRoom(room, { name: 'Bo', character: 'silent' })
  startRun(room, leader.token, { seed: 919 })
  finishNeow(room)
  room.run.act = 2
  room.run.map = { ...room.run.map, act: 2, position: null }
  const newcomer = joinRoom(room, { name: 'Cy', character: 'defect', connected: false })
  let overlappingReservation
  try { joinRoom(room, { name: 'Di', character: 'watcher', connected: false }) } catch (error) { overlappingReservation = error }
  assertEqual(overlappingReservation?.name, 'RoomError')
  const before = JSON.stringify(room.run)
  let refused
  try {
    apply(room, guest.token, { kind: 'enterRoom', roomId: room.run.map.rows[0][0] })
  } catch (error) {
    refused = error
  }
  assertEqual(refused?.name, 'RoomError')
  assertEqual(JSON.stringify(room.run), before, 'the leader invalidated the Catch Up reservation')
  joinRoom(room, { token: newcomer.token, connected: true })
  assertEqual(room.run.phase, 'neow')
  assertDeepEqual(room.run.setup.playerIds, [newcomer.playerId])
})

check('the leader can cancel a hostile Catch Up reservation by proceeding', () => {
  const room = createRoom(createStore(), { code: 'CATCHH' })
  const leader = joinRoom(room, { name: 'Ann', character: 'ironclad' })
  startRun(room, leader.token, { seed: 921 })
  finishNeow(room)
  room.run.act = 2
  room.run.map = { ...room.run.map, act: 2, position: null }
  const newcomer = joinRoom(room, { name: 'Bo', character: 'silent', connected: false })
  const before = JSON.stringify(room.run)
  const unchanged = apply(room, leader.token, { kind: 'enterRoom', roomId: 'not-a-room' })
  assertEqual(unchanged.changed, false)
  assertEqual(JSON.stringify(room.run), before)
  assert(room.seats.some((seat) => seat.token === newcomer.token), 'an invalid action cancelled the reservation')
  apply(room, leader.token, { kind: 'enterRoom', roomId: room.run.map.rows[0][0] })
  assertEqual(room.run.phase, 'combat')
  assertEqual(room.seats.some((seat) => seat.token === newcomer.token), false)
})

check('finishing active Catch Up cancels a newcomer who has not authenticated', () => {
  const room = createRoom(createStore(), { code: 'CATCHF' })
  const leader = joinRoom(room, { name: 'Ann', character: 'ironclad' })
  startRun(room, leader.token, { seed: 922 })
  finishNeow(room)
  room.run.act = 2
  room.run.map = { ...room.run.map, act: 2, position: null }
  const newcomer = joinRoom(room, { name: 'Bo', character: 'silent' })
  const pending = joinRoom(room, { name: 'Cy', character: 'defect', connected: false })
  finishNeow(room)
  assertEqual(room.run.phase, 'setup')
  assertEqual(room.seats.some((seat) => seat.token === pending.token), false)
  assertEqual(apply(room, newcomer.token, { kind: 'setupStep' }).changed, true)
})

check('resolving a final Catch Up Relic also clears an unauthenticated reservation', () => {
  const room = createRoom(createStore(), { code: 'CATCHP' })
  const leader = joinRoom(room, { name: 'Ann', character: 'ironclad' })
  startRun(room, leader.token, { seed: 923 })
  finishNeow(room)
  room.run.act = 2
  room.run.map = { ...room.run.map, act: 2, position: null }
  const newcomer = joinRoom(room, { name: 'Bo', character: 'silent' })
  const pending = joinRoom(room, { name: 'Cy', character: 'defect', connected: false })
  const player = room.run.players.find((candidate) => candidate.id === newcomer.playerId)
  player.relics.push({ defId: 'war_paint', pending: true })
  const progress = room.run.neow.players[newcomer.playerId]
  room.run.neow.players[newcomer.playerId] = {
    ...progress, redGoldPending: false, redRewardPending: false, redReward: null,
    blueOption: 0, pendingEffect: null, rewardKind: null, reward: null, rewardQueue: [], done: false,
  }
  const skill = player.deck.find((card) => card.defId === 'survivor')
  apply(room, newcomer.token, { kind: 'resolvePendingRelic', cardUids: [skill.uid], rewardIndices: [] })
  assertEqual(room.run.phase, 'setup')
  assertEqual(room.seats.some((seat) => seat.token === pending.token), false)
})

check('Catch Up rejects reservations while a Relic acquisition is pending', () => {
  const room = createRoom(createStore(), { code: 'CATCHA' })
  const leader = joinRoom(room, { name: 'Ann', character: 'ironclad' })
  startRun(room, leader.token, { seed: 924 })
  finishNeow(room)
  room.run.act = 2
  room.run.map = { ...room.run.map, act: 2, position: null }
  room.run.players[0].relics.push({ defId: 'war_paint', pending: true })
  let refused
  try { joinRoom(room, { name: 'Bo', character: 'silent', connected: false }) } catch (error) { refused = error }
  assertEqual(refused?.name, 'RoomError')
  assertEqual(room.seats.length, 1)
})

check('an unauthenticated Catch Up reservation can leave without removing a run player', () => {
  const room = createRoom(createStore(), { code: 'CATCHL' })
  const leader = joinRoom(room, { name: 'Ann', character: 'ironclad' })
  startRun(room, leader.token, { seed: 920 })
  finishNeow(room)
  room.run.act = 2
  room.run.map = { ...room.run.map, act: 2, position: null }
  const before = JSON.stringify(room.run)
  const newcomer = joinRoom(room, { name: 'Bo', character: 'silent', connected: false })
  removeSeat(room, newcomer.token)
  assertEqual(room.seats.some((seat) => seat.token === newcomer.token), false)
  assertEqual(JSON.stringify(room.run), before, 'cancelling a reservation changed the run')
  apply(room, leader.token, { kind: 'enterRoom', roomId: room.run.map.rows[0][0] })
  assertEqual(room.run.phase, 'combat')
})

check('only the newcomer funds, buys, and closes the Catch Up Merchant', () => {
  const room = createRoom(createStore(), { code: 'CATCHM' })
  const leader = joinRoom(room, { name: 'Ann', character: 'ironclad' })
  startRun(room, leader.token, { seed: 915 })
  finishNeow(room)
  room.run.act = 2
  room.run.map = { ...room.run.map, act: 2, position: null }
  const newcomer = joinRoom(room, { name: 'Bo', character: 'silent' })
  room.run.phase = 'room'
  room.run.neow = null
  room.run.setup = {
    kind: 'catch-up', targetAct: 2, playerIds: [newcomer.playerId],
    rowIndex: 10, repeatIndex: 0, playerIndex: 0, die: null,
  }
  room.run.players = room.run.players.map((player) => ({
    ...player, gold: player.id === newcomer.playerId ? 5 : 20,
  }))
  room.run.itemDecks.relics = ['anchor', ...room.run.itemDecks.relics.filter((id) => id !== 'anchor')]
  room.run.roomState = createMerchant(
    room.run.itemDecks,
    room.run.players.filter((player) => player.id === newcomer.playerId),
  )
  const before = JSON.stringify(room.run)
  for (const [token, purchase] of [
    [leader.token, { buyerId: newcomer.playerId, section: 'relic', slot: 0, payments: { [leader.playerId]: 5 } }],
    [newcomer.token, { buyerId: leader.playerId, section: 'relic', slot: 0, payments: { [newcomer.playerId]: 5 } }],
  ]) {
    let refused
    try { apply(room, token, { kind: 'merchantPurchase', purchase }) } catch (error) { refused = error }
    assertEqual(refused?.name, 'RoomError')
    assertEqual(JSON.stringify(room.run), before, 'a non-Catch-Up purchase changed the run')
  }
  let leaderFinish
  try { apply(room, leader.token, { kind: 'merchantFinish' }) } catch (error) { leaderFinish = error }
  assertEqual(leaderFinish?.name, 'RoomError')
  apply(room, newcomer.token, {
    kind: 'merchantPurchase',
    purchase: { buyerId: newcomer.playerId, section: 'relic', slot: 0, payments: { [newcomer.playerId]: 5 } },
  })
  assertEqual(room.run.players.find((player) => player.id === leader.playerId).gold, 20)
  assert(room.run.players.find((player) => player.id === newcomer.playerId).relics
    .some((relic) => relic.defId === 'anchor'))
  apply(room, newcomer.token, { kind: 'merchantFinish' })
  assertEqual(room.run.phase, 'map')
  assertEqual(room.run.setup, null)
})

report('co-op rooms')
