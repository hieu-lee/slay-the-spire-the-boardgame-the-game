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
  chooseCharacter,
  createRoom,
  createStore,
  uidList,
  joinRoom,
  markDisconnected,
  roomCode,
  snapshotFor,
  startRun,
} from './lib/rooms.mjs'
import { CARDS, ROOM_LABEL, cardNeedsEnemy, enteringRoom, roomChoices } from '../src/game/state.ts'
import { suite, check, assert, assertEqual, assertDeepEqual, report } from './lib/harness.mjs'

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

/**
 * A run opens on the map, so a room fixture that wants a combat has to walk
 * into one. `enterRoom` starts the player turn itself, so the hand is already
 * dealt when this returns.
 */
function enterFirstCombat(room, seatToken) {
  const [first] = roomChoices(room.run)
  apply(room, seatToken, { kind: 'enterRoom', roomId: first.id })
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
  room.run.combat.enemies = room.run.combat.enemies.map((enemy) => ({ ...enemy, hp: 0, dead: true }))
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

check('Full Knowledge shares every revealed reward before final choices', () => {
  const { room, a, b } = twoSeatRoom()
  room.run.combat.phase = 'won'
  room.run.combat.enemies = room.run.combat.enemies.map((enemy) => ({
    ...enemy,
    hp: 0,
    dead: true,
    cardReward: 'normal',
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

check('revising a reward choice invalidates every earlier confirmation', () => {
  const { room, a, b } = twoSeatRoom()
  room.run.combat.phase = 'won'
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

check('a disconnected seat keeps its undecided permanent reward', () => {
  const { room, a, b } = twoSeatRoom()
  room.run.combat.phase = 'won'
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
  assertEqual(room.run.phase, 'reward', 'nobody connected means no choice is forfeited')
  joinRoom(room, { token: a.token })
  assertEqual(room.run.phase, 'reward', 'returning one seat cannot forfeit the other seat\'s reward')
  assertEqual(snapshotFor(room, a.token).rewardChoice, 0, 'the reconnecting seat recovers its own choice')
  joinRoom(room, { token: b.token })
  assertEqual(room.run.phase, 'reward', 'reconnecting preserves the pending choice')
  apply(room, b.token, { kind: 'cardReward', choice: null })
  apply(room, a.token, { kind: 'cardReward', choice: 'confirm' })
  apply(room, b.token, { kind: 'cardReward', choice: 'confirm' })
  assertEqual(room.run.phase, 'map', 'the party continues after the returning seat decides and confirms')
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

  const hp = enemy().hp
  const before = room.version
  const used = apply(room, a.token, { kind: 'usePotion', potionId: 'fire_potion', enemyUid: enemy().uid })
  assert(used.changed)
  assertEqual(enemy().hp, hp - 4)
  assertEqual(mine().potions.length, 0)
  assertDeepEqual(theirs().potions, ['block_potion'])
  assert(room.version > before, 'using a potion did not publish the new board')

  const block = theirs().block
  const helped = apply(room, b.token, {
    kind: 'usePotion',
    potionId: 'block_potion',
    targetPlayerId: mine().id,
  })
  assert(helped.changed)
  assertEqual(mine().block, 2, 'Block Potion can target another online seat')
  assertEqual(theirs().block, block)

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
  ]
  const staleOrder = first.hand.map((card) => card.uid)
  apply(room, a.token, { kind: 'endTurn' })
  apply(room, b.token, { kind: 'endTurn' })
  const preparedFirst = room.run.combat.players.find((player) => player.id === a.playerId)
  assertDeepEqual(preparedFirst.hand.map((card) => card.uid), ['online-strike'],
    'the authoritative end-turn step exhausts Clumsy before asking for an order')

  let error = null
  try {
    apply(room, a.token, { kind: 'discardHand', discardOrder: staleOrder })
  } catch (thrown) {
    error = thrown
  }
  assertEqual(error?.name, 'RoomError', 'a pre-Ethereal hand order must be rejected')
  apply(room, a.token, { kind: 'discardHand', discardOrder: ['online-strike'] })
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
  let error = null
  try {
    apply(room, a.token, { kind: 'discardHand', discardOrder: 'not-a-list' })
  } catch (thrown) {
    error = thrown
  }
  assert(error, 'the malformed action should be refused')
  assertEqual(error.name, 'RoomError', `got ${error?.name}: ${error?.message}`)
})

check('an unbounded hand can submit its full discard order online', () => {
  const { room, a, b } = twoSeatRoom()
  const player = room.run.combat.players.find((candidate) => candidate.id === a.playerId)
  player.hand = Array.from({ length: 33 }, (_, index) => ({
    ...player.hand[0],
    uid: `large-hand-${index}`,
  }))
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
  apply(room, a.token, { kind: 'endTurn' })
  markDisconnected(room, a.token)
  markDisconnected(room, b.token)
  joinRoom(room, { token: a.token })
  assertEqual(room.run.combat.phase, 'discard', 'the only connected seat had already readied')
})

check('reconnecting a decided seat resumes discard settlement', () => {
  const { room, a, b } = twoSeatRoom()
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

check('the rng state never reaches a client', () => {
  // Leaking this predicts every future die roll and shuffle, and no player
  // could tell from the table that it had happened.
  const { room, a } = twoSeatRoom()
  const keys = allKeys(snapshotFor(room, a.token))
  assert(!keys.includes('rng'), 'the rng state was serialised to a client')
  assert(!keys.includes('seed'), 'the run seed was serialised to a client')
})

check('pile sizes are still visible — they are public at a real table', () => {
  const { room, a } = twoSeatRoom()
  const snapshot = snapshotFor(room, a.token)
  for (const player of snapshot.run.combat.players) {
    assert(typeof player.drawCount === 'number', 'draw pile size is missing')
    assert(typeof player.handCount === 'number', 'hand size is missing')
  }
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
  // scryDiscardUids and evokeSlots are real choices the rules grant (p.24,
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
    effects: [{ kind: 'evoke', times: 1 }],
  }
  const evokeCard = { uid: 'fx-evoke', defId: 'fixture_room_evoke', upgraded: false }
  mine().hand.push(evokeCard)
  mine().orbs = ['lightning', 'frost', null]

  apply(room, a.token, {
    kind: 'playCard',
    cardUid: evokeCard.uid,
    enemyUid: room.run.combat.enemies[0].uid,
    evokeSlots: [1],
  })
  assertDeepEqual(mine().orbs, ['lightning', null, null], 'the CHOSEN slot was evoked, not the first')

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

check('a dropped player does not hold the campfire hostage', () => {
  // They cannot answer, and the only other way out forfeits everyone's Rest.
  const { room, a, b } = twoSeatRoom()
  atCampfire(room)
  for (const player of room.run.players) player.hp = 4
  markDisconnected(room, b.token)

  apply(room, a.token, { kind: 'campfire', choices: { [a.playerId]: { choice: 'rest' } } })
  assertEqual(room.run.phase, 'map', 'the party leaves once everyone present has chosen')
  assertEqual(room.run.players[0].hp, 7, 'and Ann rested')
})

check('a room with no campfire refuses campfire choices', () => {
  const { room, a } = twoSeatRoom()
  const treasure = Object.values(room.run.map.rooms).find((entry) => entry.kind === 'treasure')
  assert(treasure, 'precondition: the act should contain a treasure room')
  room.run.phase = 'room'
  room.run.map.position = treasure.id
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
    // A crafted slot falls back to the real orb, so the Lightning orb is the
    // one spent. A phantom slot used to leave it sitting there while dealing
    // the Dark orb's damage for free.
    assert(!mine().orbs.includes('lightning'), `${label} evoked something other than the real orb`)
    assert(
      mine().orbs.every((orb) => orb === null),
      `${label} left the orbs in a strange state: ${JSON.stringify(mine().orbs)}`,
    )
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

check('a player dropping while the table waits does not strand the campfire', () => {
  // The drop can be the thing that completes the table. Without re-checking,
  // leaveRoom stayed refused and the room only unstuck if someone re-sent a
  // choice they had already made — which the "waiting on Bo" UI never offers.
  const { room, a, b } = twoSeatRoom()
  atCampfire(room)
  for (const player of room.run.players) player.hp = 4

  const first = apply(room, a.token, { kind: 'campfire', choices: { [a.playerId]: { choice: 'rest' } } })
  assertDeepEqual(first.waitingOn, [b.playerId], 'precondition: the table is waiting on Bo')
  assertEqual(room.run.phase, 'room', 'and still at the campfire')

  markDisconnected(room, b.token)
  assertEqual(room.run.phase, 'map', 'Bo dropping releases the party')
  assertEqual(room.run.players[0].hp, 7, 'and Ann gets the rest she chose')
})

check('a campfire choice must actually be Rest or Smith', () => {
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

check('beating the placeholder boss opens the next Act without fake elite rewards', () => {
  // Without the victory phase the run silently dead-ends after Act 1: the boss
  // room has no exits and advanceAct only accepts a victory.
  const { room, a } = twoSeatRoom()
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
      goldReward: 0,
      cardReward: null,
    })),
  }

  apply(room, a.token, { kind: 'resolveCombat' })
  assertEqual(room.run.phase, 'victory', 'an elite stand-in must not grant invented boss rewards')

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
check('a card-effect uid list is capped above every supported printed choice', () => {
  const huge = Array.from({ length: 50_000 }, (_unused, i) => `junk-${i}`)
  assertEqual(uidList(huge).length, UID_LIMIT, 'the list should be truncated, not passed through')
  assert(UID_LIMIT >= 12, 'and the cap must still cover the largest transcribed effect choice')

  // Truncation keeps the FRONT of the list, so an honest short play is untouched.
  assertDeepEqual(uidList(['a', 'b']), ['a', 'b'], 'a real play passes through whole')
  assertEqual(uidList('not-an-array'), undefined, 'a non-array is still nothing')
  assertDeepEqual(uidList([1, 'a', null]), ['a'], 'non-strings are still dropped')
})

report('co-op rooms')
