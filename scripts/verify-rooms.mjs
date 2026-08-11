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
import { CAPS, CARDS, ROOM_LABEL, cardNeedsEnemy, enteringRoom, lightningRowTarget, previewCardChoice, roomChoices } from '../src/game/state.ts'
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
 * into one. Resolve any multi-ability Start-of-Turn choice so fixtures that
 * exercise the Player Turn do not depend on the party size.
 */
function enterFirstCombat(room, seatToken) {
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
  room.run.combat.enemies = room.run.combat.enemies.map((enemy) => ({
    ...enemy, hp: 0, dead: true, cardReward: 'normal',
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
  room.run.combat.enemies = room.run.combat.enemies.map((enemy) => ({ ...enemy, cardReward: 'normal' }))
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
  room.run.combat.enemies = room.run.combat.enemies.map((enemy) => ({ ...enemy, cardReward: 'normal' }))
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

check('Loop Orb choices are public, authoritative, and reject forged targets online', () => {
  const { room, a, b } = twoSeatRoom()
  const actor = room.run.combat.players.find((player) => player.id === a.playerId)
  const other = room.run.combat.players.find((player) => player.id === b.playerId)
  const loop = { uid: 'room-loop', defId: 'loop', upgraded: true }
  Object.assign(actor, { hand: [loop], energy: 1, orbs: ['lightning', 'frost', 'dark'] })
  other.hand = []
  const [firstEnemy, secondEnemy] = room.run.combat.enemies
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

check('a draw lock is public to the whole co-op table', () => {
  const { room, a, b } = twoSeatRoom()
  room.run.combat.players.find((player) => player.id === a.playerId).drawLocked = true
  const seen = snapshotFor(room, b.token).run.combat.players
    .find((player) => player.id === a.playerId)
  assertEqual(seen.drawLocked, true, 'a teammate could not see that further draw effects are blocked')
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
  Object.assign(anchor, { row: 0, hp: 10, maxHp: 10, block: 0, dead: false })
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
  assertEqual(pending.startTurnCoordinatorId, a.playerId)

  let unauthorized = null
  try {
    apply(room, b.token, {
      kind: 'resolveStartTurn',
      choices: [{ id: pending.startTurnAbilities[0].id, shivEnemyUids: [null, null] }],
    })
  } catch (error) {
    unauthorized = error
  }
  assertEqual(unauthorized?.name, 'RoomError', 'a non-coordinator cannot resolve everyone\'s order')

  markDisconnected(room, a.token)
  const transferred = snapshotFor(room, b.token)
  assertEqual(transferred.startTurnCoordinatorId, b.playerId, 'disconnect transfers the pending coordinator')
  const [first, second] = room.run.combat.enemies
  first.hp = 1
  let staleTarget = null
  try {
    apply(room, b.token, {
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
  apply(room, b.token, {
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
  const { room, a } = twoSeatRoom()
  const ann = room.run.combat.players.find((player) => player.id === a.playerId)
  Object.assign(room.run.combat, { phase: 'roundEnd', turn: 1 })
  Object.assign(ann, {
    powers: [{ uid: 'room-noxious', defId: 'noxious_fumes', upgraded: false }],
    draw: Array.from({ length: 5 }, (_, index) => ({
      uid: `room-noxious-${index}`, defId: 'defend_ironclad', upgraded: false,
    })),
  })
  for (const enemy of room.run.combat.enemies) {
    Object.assign(enemy, { hp: 20, maxHp: 20, poison: 0, dead: false, abilityUsed: true })
  }

  apply(room, a.token, { kind: 'startTurn' })
  const pending = snapshotFor(room, a.token)
  const [ability] = pending.startTurnAbilities
  assertEqual(pending.run.combat.phase, 'start')
  assertEqual(ability.targets.length, room.run.combat.enemies.length)
  const [stale, chosen] = room.run.combat.enemies
  Object.assign(stale, { hp: 0, dead: true })
  let staleChoice = null
  try {
    apply(room, a.token, {
      kind: 'resolveStartTurn',
      choices: [{ id: ability.id, enemyUid: stale.uid, shivEnemyUids: [] }],
    })
  } catch (error) {
    staleChoice = error
  }
  assertEqual(staleChoice?.name, 'RoomError', 'a dead Noxious Fumes target was accepted')
  assertEqual(chosen.poison, 0, 'a stale target partially resolved the Power')
  apply(room, a.token, {
    kind: 'resolveStartTurn',
    choices: [{ id: ability.id, enemyUid: chosen.uid, shivEnemyUids: [] }],
  })
  assertEqual(room.run.combat.phase, 'player')
  assertEqual(room.run.combat.enemies.find((enemy) => enemy.uid === chosen.uid).poison, 1)
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
    apply(room, a.token, {
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

  markDisconnected(room, a.token)
  const transferred = snapshotFor(room, b.token)
  assertEqual(transferred.startTurnCoordinatorId, b.playerId)
  assertEqual(transferred.startTurnAbilities[0].evokeChoice.options.length, 3)
  const target = room.run.combat.enemies[1]
  apply(room, b.token, {
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
    Object.assign(ann, {
      powers: [
        { uid: `offline-power-${ordered}`, defId: 'mayhem', upgraded: false },
        ...(ordered ? [{ uid: 'offline-demon-form', defId: 'demon_form', upgraded: false }] : []),
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
      apply(room, b.token, {
        kind: 'resolveStartTurn',
        choices: abilities.map((ability) => ({ id: ability.id, shivEnemyUids: [] })),
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
  assertDeepEqual(resolved.hand.map((card) => card.uid), [drawn[1].uid])
  assertDeepEqual(resolved.discard.map((card) => card.uid), [held.uid, drawn[0].uid, prepared.uid])
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
  Object.assign(first, { hp: 20, maxHp: 20, block: 0, dead: false })
  Object.assign(second, { hp: 20, maxHp: 20, block: 0, dead: false })

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
  Object.assign(first, { hp: 20, maxHp: 20, block: 0, dead: false })
  Object.assign(second, { hp: 20, maxHp: 20, block: 0, dead: false })
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
  assert(released.log.some((line) => line.includes('Double Tap copy was skipped after disconnecting')))
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

report('co-op rooms')
