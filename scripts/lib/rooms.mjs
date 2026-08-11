// Room logic for co-op play: seats, reconnection, action authorisation, and
// the per-seat redaction that keeps hidden information hidden.
//
// Deliberately free of any network code so it can be tested as plain function
// calls. The socket layer on top of this is a thin shell: it owns transport,
// this owns every rule about who may see or do what.
//
// Nothing here returns the room object itself except `joinRoom`, which hands a
// seat to the player who just claimed it. `room.seats[].token` is a bearer
// credential for that seat, so it must never travel to anyone else.
//
// The board game is SIMULTANEOUS (p.12): "All players take these steps
// simultaneously." There is no turn order to enforce, so two players can act at
// the same instant. Every mutation therefore goes through `apply`, which is the
// single writer — Node's single thread does the rest.
import { randomBytes } from 'node:crypto'
import {
  CAPS,
  abandonCardCopy,
  abandonForcedCard,
  activatePower,
  activatePotion,
  advanceAct,
  cardDef,
  cardNeedsChoicePreview,
  cardNeedsEnemy,
  cardShivChoiceCount,
  beginEndPlayerTurn,
  chooseEndTurnTarget,
  defaultEndTurnOrder,
  discardOrderIsValid,
  endTurnAbilities,
  endTurnChoiceId,
  endTurnChoiceTarget,
  createRun,
  currentRoom,
  endPlayerTurn,
  enemyTurn,
  enterRoom,
  faceOf,
  leaveRoom,
  overflowShivCount,
  playCard,
  playCardCopy,
  playCost,
  previewCardChoice,
  previewCardCopyChoice,
  potionDef,
  revealCardReward,
  resolveCampfire,
  resolveCardRewards,
  resolveCombat,
  resolveEnemyTargets,
  resolveStartPlayerTurn,
  spendMiracle,
  spendShiv,
  startPlayerTurnWithChoices,
  startTurnAbilities,
  validEndTurnOrder,
} from '../../src/game/state.ts'

/** Characters a seat may pick. Two players may not take the same one (p.4). */
export const CHARACTERS = ['ironclad', 'silent', 'defect', 'watcher']

export const MAX_SEATS = 4

/**
 * Ambiguous glyphs are left out: a room code gets read aloud over voice chat,
 * where O/0 and I/1 are the same sound and the same mistake.
 */
const CODE_ALPHABET = 'ACDEFGHJKLMNPQRTUVWXY34679'

export function roomCode(random = randomBytes) {
  let code = ''
  // 256 is not a multiple of 26, so a plain modulo would make the first 22
  // letters ~11% likelier than the last 4. That bias is harmless for a room
  // code, but rejecting the short tail costs one comparison, and a biased
  // generator that claims to be uniform is the kind of thing that gets copied
  // somewhere it matters.
  const limit = 256 - (256 % CODE_ALPHABET.length)
  while (code.length < 6) {
    for (const byte of random(6)) {
      if (code.length === 6) break
      if (byte >= limit) continue
      code += CODE_ALPHABET[byte % CODE_ALPHABET.length]
    }
  }
  return code
}

function token(random = randomBytes) {
  return random(24).toString('base64url')
}

export function createStore() {
  return { rooms: new Map() }
}

export function createRoom(store, options = {}) {
  const code = options.code ?? roomCode(options.random)
  // Silently replacing a live room would drop everyone seated in it.
  if (store.rooms.has(code)) fail(`Room ${code} already exists`)
  const room = {
    code,
    phase: 'lobby',
    ascension: 0,
    seats: [],
    run: null,
    /** Bumped on every accepted mutation so clients can drop stale frames. */
    version: 0,
  }
  store.rooms.set(code, room)
  return room
}

export function findSeat(room, seatToken) {
  if (!seatToken) return undefined
  return room.seats.find((seat) => seat.token === seatToken)
}

/** A public, non-secret id for a seat, safe to show to the whole table. */
function seatPublic(seat) {
  return {
    playerId: seat.playerId,
    name: seat.name,
    character: seat.character,
    connected: seat.connected,
  }
}

class RoomError extends Error {
  constructor(message) {
    super(message)
    this.name = 'RoomError'
  }
}

const fail = (message) => {
  throw new RoomError(message)
}

/**
 * Claims a seat, or reclaims one with a previously issued token.
 *
 * This is the ONLY function that returns a seat, because it is the only one
 * whose caller is entitled to the token inside it. Everything else returns a
 * redacted snapshot: the room object carries every seat's token, and one
 * careless send of it is total seat impersonation.
 *
 * Reconnection is the token's whole purpose: a dropped player must be able to
 * come back to the SAME seat, because their deck and HP live there. Without it
 * a flaky connection is a lost run.
 */
export function joinRoom(room, { name, character, token: existing, random, connected = true } = {}) {
  const returning = findSeat(room, existing)
  if (returning) {
    const nextName = name ? String(name).slice(0, 24) : returning.name
    if (room.phase !== 'lobby' && nextName !== returning.name) fail('Names are locked once the run starts')
    const connectionChanged = returning.connected !== connected
    if (!connectionChanged && nextName === returning.name) return returning
    returning.connected = connected
    returning.name = nextName
    room.version += 1
    // They may be the last answer the table was waiting on, or the first one
    // back to a decision that stalled while nobody was connected.
    if (connectionChanged) {
      settleCampfire(room)
      settleReward(room)
      settleEndTurn(room)
      settleDiscard(room)
    }
    return returning
  }

  if (room.phase !== 'lobby') fail('This run has already started')
  if (room.seats.length >= MAX_SEATS) fail('The room is full')

  const pick = character ?? CHARACTERS.find((id) => !room.seats.some((seat) => seat.character === id))
  if (!CHARACTERS.includes(pick)) fail(`Unknown character: ${pick}`)
  if (room.seats.some((seat) => seat.character === pick)) fail(`${pick} is already taken`)

  const seat = {
    // Seat order is row order, and row order decides which enemies reach whom.
    playerId: ['p1', 'p2', 'p3', 'p4'].find((id) => !room.seats.some((other) => other.playerId === id)),
    name: String(name ?? `Player ${room.seats.length + 1}`).slice(0, 24),
    character: pick,
    token: token(random),
    connected,
  }
  room.seats.push(seat)
  room.version += 1
  return seat
}

export function chooseCharacter(room, seatToken, character) {
  const seat = findSeat(room, seatToken) ?? fail('Unknown seat')
  if (room.phase !== 'lobby') fail('Characters are locked once the run starts')
  if (!CHARACTERS.includes(character)) fail(`Unknown character: ${character}`)
  if (room.seats.some((other) => other !== seat && other.character === character)) {
    fail(`${character} is already taken`)
  }
  seat.character = character
  room.version += 1
  return snapshotFor(room, seatToken)
}

export function chooseAscension(room, seatToken, ascension) {
  findSeat(room, seatToken) ?? fail('Unknown seat')
  if (room.phase !== 'lobby') fail('Ascension is locked once the run starts')
  if (!Number.isInteger(ascension) || ascension < 0 || ascension > 13) fail('Ascension must be an integer from 0 to 13')
  if (room.ascension === ascension) return snapshotFor(room, seatToken)
  room.ascension = ascension
  room.version += 1
  return snapshotFor(room, seatToken)
}

export function removeSeat(room, seatToken) {
  const seat = findSeat(room, seatToken) ?? fail('Unknown seat')
  if (room.phase !== 'lobby') fail('A run seat must be preserved for reconnection')
  room.seats = room.seats.filter((candidate) => candidate !== seat)
  room.version += 1
}

export function markDisconnected(room, seatToken) {
  const seat = findSeat(room, seatToken)
  if (!seat) return snapshotFor(room, seatToken)
  seat.connected = false
  room.version += 1
  // The party may have been waiting on exactly this player. Dropping without
  // re-checking stranded the campfire: `leaveRoom` stays refused, and the room
  // only unstuck if someone re-sent a choice they had already made.
  settleCampfire(room)
  settleReward(room)
  settleEndTurn(room)
  settleDiscard(room)
  settleForcedCards(room)
  return snapshotFor(room, seatToken)
}

function settleForcedCards(room) {
  let combat = room.run?.combat
  for (;;) {
    let settled = false
    while (combat?.phase === 'copy' && combat.pendingCardCopy) {
      const ownerId = combat.pendingCardCopy.playerId
      const owner = room.seats.find((seat) => seat.playerId === ownerId)
      if (owner?.connected !== false) break
      const next = abandonCardCopy(combat, ownerId)
      if (next === combat) break
      room.run = { ...room.run, combat: next }
      combat = next
      settled = true
      if (room.cardPreviews?.[ownerId]) {
        room.cardPreviews = { ...room.cardPreviews }
        delete room.cardPreviews[ownerId]
      }
    }
    while ((combat?.phase === 'start' || combat?.phase === 'player') && combat.startTurnProgress?.forcedCard) {
      const ownerId = combat.startTurnProgress.forcedCard.playerId
      const owner = room.seats.find((seat) => seat.playerId === ownerId)
      if (owner?.connected !== false) break
      if (room.cardPreviews?.[ownerId]) {
        if (!resolveAbandonedPreviews(room)) break
        combat = room.run?.combat
        settled = true
        continue
      }
      const next = abandonForcedCard(combat, ownerId)
      if (next === combat) break
      room.run = { ...room.run, combat: next }
      combat = next
      settled = true
      if (room.cardPreviews?.[ownerId]) {
        room.cardPreviews = { ...room.cardPreviews }
        delete room.cardPreviews[ownerId]
      }
    }
    if (!settled) return
  }
}

/**
 * Starts the run.
 *
 * `seed` is deliberately NOT taken from the client in normal play: whoever
 * picks it knows every die roll, shuffle and encounter for the entire run,
 * which is the very thing `snapshotFor` withholds the rng state to prevent.
 * Tests and playtests pass one explicitly.
 */
export function startRun(room, seatToken, { seed, ascension = 0 } = {}) {
  findSeat(room, seatToken) ?? fail('Claim a seat before starting')
  if (room.phase !== 'lobby') fail('The run has already started')
  if (room.seats.length === 0) fail('Nobody has claimed a seat')

  const party = room.seats.map((seat) => ({
    id: seat.playerId,
    name: seat.name,
    character: seat.character,
  }))
  room.run = createRun(seed ?? Number(BigInt('0x' + randomBytes(4).toString('hex'))), party, ascension)
  room.phase = 'run'
  room.version += 1
  return snapshotFor(room, seatToken)
}

/**
 * Applies a game action on behalf of a seat.
 *
 * The engine signals an illegal action by returning the SAME state reference,
 * which is preserved here: an action that changes nothing does not bump the
 * version, so it never wakes the other clients.
 */
export function apply(room, seatToken, action) {
  const seat = findSeat(room, seatToken) ?? fail('Unknown seat')
  if (room.phase !== 'run' || !room.run) fail('The run has not started')

  const staged = room.cardPreviews?.[seat.playerId]
  const player = room.run.combat?.players.find((candidate) => candidate.id === seat.playerId)
  const forcedCard = room.run.combat?.startTurnProgress?.forcedCard
  const pendingCopy = room.run.combat?.pendingCardCopy
  const pendingCopyName = pendingCopy?.sourceNames?.[0] ?? 'Double Tap'
  const copyForSeat = pendingCopy?.playerId === seat.playerId
  const forcedForSeat = (room.run.combat?.phase === 'start' || room.run.combat?.phase === 'player') &&
    forcedCard?.playerId === seat.playerId &&
    typeof forcedCard.cardUid === 'string'
  const stagedCopyStillWaiting = staged?.copy === true && copyForSeat && pendingCopy.card.uid === staged.cardUid
  const stagedCardStillWaiting = player?.hand.some((card) => card.uid === staged?.cardUid) &&
    (room.run.combat?.phase === 'player' || (forcedForSeat && forcedCard.cardUid === staged?.cardUid))
  if (staged && !stagedCopyStillWaiting && !stagedCardStillWaiting) {
    room.cardPreviews = { ...room.cardPreviews }
    delete room.cardPreviews[seat.playerId]
  }
  const locked = room.cardPreviews?.[seat.playerId]
  if (locked && !(
    ((locked.copy === true && (action?.kind === 'previewCardCopy' || action?.kind === 'playCardCopy')) ||
      (locked.copy !== true && (action?.kind === 'previewCard' || action?.kind === 'playCard'))) &&
      action.cardUid === locked.cardUid
  )) fail('Finish the revealed card before taking another action')
  const foreignLocks = Object.keys(room.cardPreviews ?? {}).filter((playerId) => playerId !== seat.playerId)
  if (foreignLocks.length > 0 && !(
    action?.kind === 'endTurn' && foreignLocks.every((playerId) =>
      room.seats.find((candidate) => candidate.playerId === playerId)?.connected === false)
  )) {
    // ponytail: this global lock avoids alternate shared-RNG reveals; narrow it
    // to RNG-mutating actions only if simultaneous-play latency becomes a problem.
    fail('Wait for the revealed card to finish')
  }
  if (forcedCard && !(
    forcedForSeat && (action?.kind === 'playCard' || action?.kind === 'previewCard') &&
    action.cardUid === forcedCard.cardUid
  )) fail('Finish the forced card before taking another action')
  if (pendingCopy && !(copyForSeat &&
    (action?.kind === 'previewCardCopy' || action?.kind === 'playCardCopy'))) {
    fail(copyForSeat ? `Finish the ${pendingCopyName} copy` : `Wait for the ${pendingCopyName} copy`)
  }

  if (action?.kind === 'previewCardCopy') {
    if (!copyForSeat) fail(`No ${pendingCopyName} copy is waiting for you`)
    const def = faceOf(cardDef(pendingCopy.card.defId), pendingCopy.card.upgraded)
    const needsEnemy = cardNeedsEnemy(def, player, false, pendingCopy.energySpent)
    const enemyUid = needsEnemy ? action.enemyUid : null
    if (needsEnemy && (typeof enemyUid !== 'string' ||
      resolveEnemyTargets(room.run.combat, def.target ?? 'enemy', enemyUid).length === 0)) {
      fail('Choose a living enemy before revealing this copy')
    }
    if (locked && (locked.copy !== true || enemyUid !== locked.enemyUid)) {
      fail('The revealed copy target is already committed')
    }
    const preview = previewCardCopyChoice(room.run.combat, seat.playerId)
    if (!preview) fail('That copy cannot reveal a choice now')
    room.cardPreviews = {
      ...room.cardPreviews,
      [seat.playerId]: {
        cardUid: pendingCopy.card.uid, copy: true, spendMiracle: false, enemyUid, ...preview,
      },
    }
    room.version += 1
    return { changed: true, snapshot: snapshotFor(room, seatToken) }
  }

  if (action?.kind === 'previewCard') {
    if (room.endTurnAbilities) fail('The party is ordering end-of-turn abilities')
    const held = player?.hand.find((card) => card.uid === action.cardUid)
    const def = held ? faceOf(cardDef(held.defId), held.upgraded) : null
    const spendMiracle = action.spendMiracle === true
    const cost = forcedForSeat && forcedCard.cardUid === action.cardUid ? 0 : def && player ? playCost(def, player) : null
    if (spendMiracle && (!def || player.miracles < 1 || player.energy !== CAPS.energy ||
      cost === 'X' || cost === 0)) fail('That Miracle cannot pay for this card')
    if (locked && spendMiracle !== locked.spendMiracle) fail('The revealed card payment is already committed')
    const needsEnemy = def ? cardNeedsEnemy(def, player, false) : false
    const enemyUid = needsEnemy ? action.enemyUid : null
    if (needsEnemy && (typeof enemyUid !== 'string' ||
      resolveEnemyTargets(room.run.combat, def.target ?? 'enemy', enemyUid).length === 0)) {
      fail('Choose a living enemy before revealing this card')
    }
    if (locked && enemyUid !== locked.enemyUid) fail('The revealed card target is already committed')
    const preview = room.run.combat
      ? previewCardChoice(room.run.combat, seat.playerId, action.cardUid)
      : null
    if (!preview) {
      if (locked) {
        room.cardPreviews = { ...room.cardPreviews }
        delete room.cardPreviews[seat.playerId]
      }
      fail('That card cannot reveal a choice now')
    }
    room.cardPreviews = {
      ...room.cardPreviews,
      [seat.playerId]: { cardUid: action.cardUid, spendMiracle, enemyUid, ...preview },
    }
    room.version += 1
    return { changed: true, snapshot: snapshotFor(room, seatToken) }
  }

  if (action?.kind === 'playCard') {
    const held = player?.hand.find((card) => card.uid === action.cardUid)
    if (held && cardNeedsChoicePreview(faceOf(cardDef(held.defId), held.upgraded), room.run.combat, player)) {
      if (!locked || locked.cardUid !== action.cardUid) fail('Reveal this card before resolving its choice')
      if ((action.spendMiracle === true) !== locked.spendMiracle) {
        fail('The final card payment does not match its reveal')
      }
      if ((action.enemyUid ?? null) !== locked.enemyUid) fail('The final target does not match its reveal')
      const preview = previewCardChoice(room.run.combat, seat.playerId, action.cardUid)
      if (!preview || preview.kind !== locked.kind || preview.cards.length !== locked.cards.length ||
        preview.cards.some((card, index) => card.uid !== locked.cards[index].uid)) {
        fail('The revealed cards changed; reveal them again')
      }
    }
  }
  if (action?.kind === 'playCardCopy') {
    if (!copyForSeat || action.cardUid !== pendingCopy.card.uid) fail(`No matching ${pendingCopyName} copy is waiting`)
    const def = faceOf(cardDef(pendingCopy.card.defId), pendingCopy.card.upgraded)
    if (cardNeedsChoicePreview(def, room.run.combat, player)) {
      if (!locked || locked.copy !== true || locked.cardUid !== action.cardUid) {
        fail('Reveal this copy before resolving its choice')
      }
      if ((action.enemyUid ?? null) !== locked.enemyUid) fail('The final copy target does not match its reveal')
      const preview = previewCardCopyChoice(room.run.combat, seat.playerId)
      if (!preview || preview.kind !== locked.kind || preview.cards.length !== locked.cards.length ||
        preview.cards.some((card, index) => card.uid !== locked.cards[index].uid)) {
        fail('The revealed copy cards changed; reveal them again')
      }
    }
  }

  if (action?.kind === 'campfire') return campfire(room, seat, action, seatToken)
  if (action?.kind === 'cardReward') return cardReward(room, seat, action, seatToken)
  if (action?.kind === 'endTurn') return endTurn(room, seat, action, seatToken)
  if (action?.kind === 'resolveEndTurn') return resolveEndTurn(room, seat, action, seatToken)
  if (action?.kind === 'resolveStartTurn') return resolveStartTurn(room, seat, action, seatToken)
  if (action?.kind === 'discardHand') return submitDiscard(room, seat, action, seatToken)
  if (room.endTurnAbilities) fail('The party is ordering end-of-turn abilities')
  if (room.run.combat?.phase === 'start' && !(
    forcedForSeat && (action?.kind === 'playCard' || action?.kind === 'previewCard') &&
    action.cardUid === forcedCard.cardUid
  )) fail('Finish the Start-of-Turn abilities')

  const before = room.run
  const next = dispatch(before, seat, action)
  if (next === before) return { changed: false, snapshot: snapshotFor(room, seatToken) }

  room.run = next
  settleForcedCards(room)
  const current = room.run
  if ((action?.kind === 'playCard' || action?.kind === 'playCardCopy') && locked?.cardUid === action.cardUid) {
    room.cardPreviews = { ...room.cardPreviews }
    delete room.cardPreviews[seat.playerId]
  }
  if (room.cardPreviews) {
    const combat = current.combat
    room.cardPreviews = Object.fromEntries(Object.entries(room.cardPreviews).filter(([playerId, preview]) =>
      preview.copy === true
        ? combat?.phase === 'copy' && combat.pendingCardCopy?.playerId === playerId &&
          combat.pendingCardCopy.card.uid === preview.cardUid
        : (combat?.phase === 'player' || (combat?.phase === 'start' &&
          combat.startTurnProgress?.forcedCard?.playerId === playerId &&
          combat.startTurnProgress.forcedCard.cardUid === preview.cardUid)) && combat.players
          .find((candidate) => candidate.id === playerId)?.hand.some((card) => card.uid === preview.cardUid)))
  }
  // Any accepted combat action can change a hand, including an ally's. Orders
  // collected before that action are stale, so everyone confirms again.
  room.endTurnOrders = undefined
  room.endTurnReady = undefined
  room.endTurnAbilities = undefined
  room.endTurnOrder = undefined
  room.endTurnPublicIds = undefined
  // Campfire choices belong to the room they were made in. Left behind, a
  // choice from one campfire silently resolves the NEXT one for a player who
  // was never asked.
  if (current.map.position !== before.map.position || current.phase !== before.phase) {
    room.campfireChoices = undefined
    room.rewardChoices = undefined
    room.rewardConfirmed = undefined
  }
  room.version += 1
  return { changed: true, snapshot: snapshotFor(room, seatToken) }
}

function endTurn(room, seat, _action, seatToken) {
  let combat = room.run?.combat
  if (!combat) fail('No combat in progress')
  const previewOwners = Object.keys(room.cardPreviews ?? {})
  if (previewOwners.some((playerId) =>
    room.seats.find((candidate) => candidate.playerId === playerId)?.connected !== false)) {
    fail('Finish every revealed card before ending the turn')
  }
  if (previewOwners.length > 0) {
    if (!resolveAbandonedPreviews(room)) fail('The disconnected revealed card could not be resolved')
    combat = room.run?.combat
  }
  if (room.endTurnAbilities) fail('The party is already ordering end-of-turn abilities')
  if (combat.phase !== 'player') fail('The party is not taking its turn')
  const player = combat.players.find((candidate) => candidate.id === seat.playerId)
  if (!player || player.dead) fail('This seat cannot end the turn')
  room.endTurnReady = { ...room.endTurnReady, [seat.playerId]: true }
  room.version += 1
  const waiting = settleEndTurn(room)
  return { changed: true, waitingOn: waiting, snapshot: snapshotFor(room, seatToken) }
}

function settleEndTurn(room) {
  let combat = room.run?.combat
  if (!combat || combat.phase !== 'player' || !room.endTurnReady) return null
  const previewOwners = Object.keys(room.cardPreviews ?? {})
  const connected = new Set(room.seats.filter((seat) => seat.connected).map((seat) => seat.playerId))
  if (previewOwners.length > 0) {
    if (previewOwners.some((playerId) => connected.has(playerId)) || connected.size === 0 ||
      [...connected].some((playerId) => !room.endTurnReady[playerId])) return previewOwners
    if (!resolveAbandonedPreviews(room)) return previewOwners
    combat = room.run?.combat
    if (!combat || !room.endTurnReady) return null
  }
  if (room.endTurnAbilities) return null
  if (!room.seats.some((seat) => seat.connected)) return null
  const waiting = combat.players
    .filter((player) => !player.dead && connected.has(player.id) && !room.endTurnReady[player.id])
    .map((player) => player.id)
  if (waiting.length > 0) return waiting
  const abilities = endTurnAbilities(combat)
  const order = defaultEndTurnOrder(abilities)
  const needsChoice = abilities.length > 1 || abilities.some((ability) => (ability.targets?.length ?? 0) > 1)
  if (!needsChoice) {
    room.run = { ...room.run, combat: beginEndPlayerTurn(combat, order) }
    room.endTurnReady = undefined
  } else {
    room.endTurnAbilities = abilities
    room.endTurnOrder = order
    room.endTurnPublicIds = Object.fromEntries(abilities.map((ability, index) => [`a${index + 1}`, ability.id]))
  }
  room.endTurnOrders = undefined
  return null
}

function resolveAbandonedPreviews(room) {
  for (const [playerId, preview] of Object.entries(room.cardPreviews ?? {})) {
    const seat = room.seats.find((candidate) => candidate.playerId === playerId)
    if (!seat || seat.connected) continue
    try {
      apply(room, seat.token, {
        kind: 'playCard',
        cardUid: preview.cardUid,
        enemyUid: preview.enemyUid,
        discardUids: preview.kind === 'discard' ? preview.cards.map((card) => card.uid) : undefined,
        scryDiscardUids: preview.kind === 'scry' ? [] : undefined,
        topdeckUids: preview.kind === 'topdeck' ? preview.cards.slice(0, 1).map((card) => card.uid) : undefined,
        spendMiracle: preview.spendMiracle,
        preflight: true,
      })
    } catch {
      return false
    }
  }
  return true
}

function endTurnCoordinator(room) {
  const alive = new Set(room.run?.combat?.players.filter((player) => !player.dead).map((player) => player.id) ?? [])
  return room.seats.find((seat) => seat.connected && alive.has(seat.playerId))?.playerId ?? null
}

function resolveEndTurn(room, seat, action, seatToken) {
  const combat = room.run?.combat
  if (!combat || !room.endTurnAbilities || !room.endTurnPublicIds) {
    fail('The party is not ordering end-of-turn abilities')
  }
  if (seat.playerId !== endTurnCoordinator(room)) fail('Only the end-turn coordinator can resolve the order')
  const publicOrder = action.abilityOrder
  if (!Array.isArray(publicOrder) || publicOrder.some((id) => typeof id !== 'string')) {
    fail('End-turn order must contain each ability exactly once with valid targets')
  }
  const order = publicOrder.map((choice) => {
    const publicId = endTurnChoiceId(choice)
    const id = Object.hasOwn(room.endTurnPublicIds, publicId) ? room.endTurnPublicIds[publicId] : undefined
    const target = endTurnChoiceTarget(choice)
    if (choice !== (target ? chooseEndTurnTarget(publicId, target) : publicId)) return undefined
    return id && target ? chooseEndTurnTarget(id, target) : id
  })
  if (order.some((choice) => typeof choice !== 'string') || !validEndTurnOrder(room.endTurnAbilities, order)) {
    fail('End-turn order must contain each ability exactly once with valid targets')
  }
  const next = beginEndPlayerTurn(combat, order)
  if (next === combat) fail('End-turn order is stale')
  room.run = { ...room.run, combat: next }
  room.endTurnReady = undefined
  room.endTurnAbilities = undefined
  room.endTurnOrder = undefined
  room.endTurnPublicIds = undefined
  room.endTurnOrders = undefined
  room.version += 1
  return { changed: true, snapshot: snapshotFor(room, seatToken) }
}

function startTurnCoordinator(room) {
  const alive = new Set(room.run?.combat?.players.filter((player) => !player.dead).map((player) => player.id) ?? [])
  return room.seats.find((seat) => seat.connected && alive.has(seat.playerId))?.playerId ?? null
}

function resolveStartTurn(room, seat, action, seatToken) {
  const combat = room.run?.combat
  if (!combat || combat.phase !== 'start') fail('The party is not resolving Start-of-Turn abilities')
  if (seat.playerId !== startTurnCoordinator(room)) fail('Only the start-turn coordinator can resolve the order')
  const choices = action.choices
  if (!Array.isArray(choices) || choices.length > UID_LIMIT || choices.some((choice) =>
    !choice || typeof choice.id !== 'string' || !Array.isArray(choice.shivEnemyUids) ||
    (choice.enemyUid !== undefined && typeof choice.enemyUid !== 'string') ||
    choice.shivEnemyUids.length > CAPS.shivs ||
    choice.shivEnemyUids.some((uid) => uid !== null && typeof uid !== 'string') ||
    (choice.evokeSlots !== undefined && (!Array.isArray(choice.evokeSlots) ||
      choice.evokeSlots.length > UID_LIMIT)) ||
    (choice.evokeEnemyUids !== undefined && (!Array.isArray(choice.evokeEnemyUids) ||
      choice.evokeEnemyUids.length > UID_LIMIT)))) {
    fail('Start-of-Turn choices must contain every ability and valid targets')
  }
  const next = resolveStartPlayerTurn(combat, choices.map((choice) => ({
    id: choice.id,
    enemyUid: choice.enemyUid,
    shivEnemyUids: [...choice.shivEnemyUids],
    evokeSlots: slotList(choice.evokeSlots),
    evokeEnemyUids: targetList(choice.evokeEnemyUids),
  })))
  if (next === combat) fail('The Start-of-Turn order or targets are stale')
  room.run = { ...room.run, combat: next }
  settleForcedCards(room)
  room.version += 1
  return { changed: true, snapshot: snapshotFor(room, seatToken) }
}

function submitDiscard(room, seat, action, seatToken) {
  const combat = room.run?.combat
  if (!combat || combat.phase !== 'discard') fail('The party is not ordering discards')
  const player = combat.players.find((candidate) => candidate.id === seat.playerId)
  if (!player || player.dead) fail('This seat cannot discard')
  if (!Array.isArray(action.discardOrder) || action.discardOrder.length > player.hand.length ||
      action.discardOrder.some((uid) => typeof uid !== 'string')) fail('Discard order must match your hand')
  const order = [...action.discardOrder]
  if (!discardOrderIsValid(player, order)) fail('Discard order may omit only cards this player can Retain')
  room.endTurnOrders = { ...room.endTurnOrders, [seat.playerId]: order }
  room.version += 1
  const waiting = settleDiscard(room)
  return { changed: true, waitingOn: waiting, snapshot: snapshotFor(room, seatToken) }
}

function settleDiscard(room) {
  const combat = room.run?.combat
  if (!combat || combat.phase !== 'discard' || !room.endTurnOrders) return null
  if (!room.seats.some((seat) => seat.connected)) return null
  const connected = new Set(room.seats.filter((seat) => seat.connected).map((seat) => seat.playerId))
  const waiting = combat.players
    .filter((player) => !player.dead && connected.has(player.id) && !room.endTurnOrders[player.id])
    .map((player) => player.id)
  if (waiting.length > 0) return waiting
  const orders = Object.fromEntries(combat.players.map((player) => [
    player.id,
    room.endTurnOrders[player.id] ?? player.hand.map((card) => card.uid),
  ]))
  const next = endPlayerTurn(combat, orders)
  if (next === combat) fail('Discard order is no longer valid')
  room.run = { ...room.run, combat: next }
  room.endTurnOrders = undefined
  return null
}

/**
 * A campfire: everyone chooses, then the party leaves together (p.9).
 *
 * Each seat submits only its OWN choice — passing the whole record through let
 * one client Smith everybody else's cards. But the choices also have to be
 * COLLECTED rather than applied one at a time, because `resolveCampfire` moves
 * the party back to the map: applied immediately, the first seat to click
 * would heal alone and drag everyone out of the room.
 */
function campfire(room, seat, action, seatToken) {
  const run = room.run
  if (run.phase !== 'room') fail('The party is not in a room')
  // Not merely "a room": a treasure or event room has no Rest or Smith, and
  // accumulating choices there published a campfire prompt for a room that has
  // none, then threw the choices away.
  if (currentRoom(run.map)?.kind !== 'campfire') fail('This room has no campfire')

  // Validated, not merely present. `resolveCampfire` treats anything that is
  // not exactly 'rest' as a Smith, and a Smith naming no card silently does
  // nothing — so 'Rest' with a capital R quietly burned a seat's only heal.
  const choice = action.choices?.[seat.playerId]
  if (!choice || (choice.choice !== 'rest' && choice.choice !== 'smith')) {
    fail('Choose Rest or Smith')
  }
  if (choice.choice === 'smith') {
    const player = run.players.find((candidate) => candidate.id === seat.playerId)
    const target = player?.deck.find((card) => card.uid === choice.cardUid && !card.upgraded)
    if (!target) fail('Choose one of your own cards that is not already upgraded')
  }

  room.campfireChoices = { ...room.campfireChoices, [seat.playerId]: choice }
  room.version += 1

  const waiting = settleCampfire(room)
  if (waiting) {
    return { changed: true, waitingOn: waiting, snapshot: snapshotFor(room, seatToken) }
  }
  return { changed: true, snapshot: snapshotFor(room, seatToken) }
}

/**
 * Resolves the campfire once everyone still present has chosen.
 *
 * Returns the seats still to answer, or null once the party has left. Called
 * both when a choice arrives and when a player drops, because a drop can be
 * the thing that completes the table.
 */
function settleCampfire(room) {
  const run = room.run
  if (!run || run.phase !== 'room') return null
  if (currentRoom(run.map)?.kind !== 'campfire') return null
  if (!room.campfireChoices) return null
  // With nobody connected there is no table to un-hold: resolving here would
  // apply whatever partial choices happened to be in, and the players who had
  // not answered would reconnect to find their rest spent.
  if (!room.seats.some((seat) => seat.connected)) return null

  const undecided = room.seats.filter((other) => {
    const player = run.players.find((candidate) => candidate.id === other.playerId)
    if (!player || player.dead) return false
    // A dropped player must not hold the table hostage: they cannot answer, and
    // the only other way out would forfeit everyone else's rest.
    if (!other.connected) return false
    return !room.campfireChoices[other.playerId]
  })
  if (undecided.length > 0) return undecided.map((other) => other.playerId)

  const next = resolveCampfire(run, room.campfireChoices)
  room.campfireChoices = undefined
  if (next !== run) {
    room.run = next
    room.version += 1
  }
  return null
}

function cardReward(room, seat, action, seatToken) {
  const run = room.run
  if (run.phase !== 'reward') fail('The party is not choosing rewards')
  const offer = run.rewards.find((candidate) => candidate.playerId === seat.playerId)
  if (!offer) fail('This seat has no card reward')
  const choice = action.choice
  if (choice === 'reveal') {
    const next = revealCardReward(run, seat.playerId)
    if (next === run) fail('This reward is already revealed')
    room.run = next
    // Revealing changes the information every permanent choice is based on.
    room.rewardConfirmed = undefined
    room.version += 1
    return { changed: true, snapshot: snapshotFor(room, seatToken) }
  }
  if (choice === 'confirm') {
    const undecided = run.rewards.filter((candidate) => !(candidate.playerId in (room.rewardChoices ?? {})))
    if (undecided.length > 0) fail('Everyone must choose before rewards are confirmed')
    room.rewardConfirmed = { ...room.rewardConfirmed, [seat.playerId]: true }
    room.version += 1
    const waiting = settleReward(room)
    return { changed: true, waitingOn: waiting, snapshot: snapshotFor(room, seatToken) }
  }
  if (choice !== null && (
    offer.choices === null || !Number.isInteger(choice) || choice < 0 || choice >= offer.choices.length
  )) {
    fail('Choose one of your revealed cards or skip')
  }
  room.rewardChoices = { ...room.rewardChoices, [seat.playerId]: choice }
  // Any changed decision reopens the final table confirmation for everyone.
  room.rewardConfirmed = undefined
  room.version += 1
  const waiting = settleReward(room)
  return { changed: true, waitingOn: waiting, snapshot: snapshotFor(room, seatToken) }
}

function settleReward(room) {
  const run = room.run
  if (!run || run.phase !== 'reward' || !room.rewardChoices) return null
  if (!room.seats.some((seat) => seat.connected)) return null
  const waiting = run.rewards
    .filter((offer) => !(offer.playerId in room.rewardChoices))
    .map((offer) => offer.playerId)
  if (waiting.length > 0) return waiting
  const confirming = run.rewards
    .filter((offer) => !(offer.playerId in (room.rewardConfirmed ?? {})))
    .map((offer) => offer.playerId)
  if (confirming.length > 0) return confirming
  const decisions = Object.fromEntries(run.rewards.map((offer) => [
    offer.playerId,
    room.rewardChoices[offer.playerId],
  ]))
  const next = resolveCardRewards(run, decisions)
  room.rewardChoices = undefined
  room.rewardConfirmed = undefined
  if (next !== run) {
    room.run = next
    room.version += 1
  }
  return null
}

/**
 * A list of card uids from the network, or nothing.
 *
 * Elements are filtered to strings as well: the engine looks cards up by uid,
 * and anything else is not a uid.
 *
 * The length cap is a denial-of-service fix, not tidiness. `allocate` de-dupes
 * with `indexOf` inside a `filter`, which is quadratic, and the room layer
 * handles messages one at a time on a single thread. A client sending 40,000
 * junk uids blocked every room in the process for 1.3 seconds, repeatably, and
 * 100,000 for about eight. This helper only handles card-effect choices, whose
 * printed amounts fit comfortably under the cap. Variable discards and
 * end-turn discard orders can span an unbounded hand and are validated
 * separately against that hand.
 */
export const UID_LIMIT = 32
export const uidList = (value) =>
  Array.isArray(value)
    ? value.filter((item) => typeof item === 'string').slice(0, UID_LIMIT)
    : undefined

/**
 * A list of orb slot indices from the network.
 *
 * Integers only. Passed through raw, a string element was used as a property
 * key on the orbs array — `'length'` evoked a phantom orb and then truncated
 * the array, and `'__proto__'` crashed the room layer outright.
 */
const slotList = (value) =>
  Array.isArray(value)
    ? value.slice(0, UID_LIMIT).map((item) => Number.isInteger(item) && item >= 0 ? item : -1)
    : undefined

const targetList = (value) => Array.isArray(value)
  ? value.slice(0, UID_LIMIT).map((item) => item === null || typeof item === 'string' ? item : '')
  : undefined

function overflowChoices(combat, effects, action, mandatory = 0) {
  const discarded = Array.isArray(action.discardUids) ? action.discardUids.length : 0
  const gained = effects.reduce(
    (sum, effect) => sum + (effect.kind === 'gainShiv'
      ? effect.amount
      : effect.kind === 'gainShivPerDiscard' ? discarded + effect.bonus : 0),
    0,
  )
  const overflow = overflowShivCount(combat, gained)
  if (
    action.expectedShivOverflow !== undefined &&
    (!Number.isInteger(action.expectedShivOverflow) || action.expectedShivOverflow !== overflow)
  ) {
    fail('The shared Shiv supply changed; choose targets again')
  }
  const targets = action.shivEnemyUids ?? []
  if (!Array.isArray(targets) || targets.length < mandatory ||
    targets.length > mandatory + overflow || targets.some((uid) => typeof uid !== 'string')) {
    fail('Choose every overflow Shiv target or explicitly skip the rest')
  }
  if (overflow > 0) {
    if (!Number.isInteger(action.expectedShivOverflow)) {
      fail('The shared Shiv supply changed; choose targets again')
    }
    if (action.skipOverflow !== true && targets.length !== mandatory + overflow) {
      fail('Choose every overflow Shiv target or explicitly skip the rest')
    }
  } else if (targets.length !== mandatory) {
    fail('Choose every Shiv target')
  }
  if (targets.some((uid) => resolveEnemyTargets(combat, 'enemy', uid).length === 0)) {
    fail('A Shiv target is no longer alive')
  }
  return { overflow, targets }
}

function dispatch(run, seat, action) {
  switch (action?.kind) {
    case 'playCard':
    case 'playCardCopy': {
      if (!run.combat) fail('No combat in progress')
      const copied = action.kind === 'playCardCopy'
      const pendingCopyName = run.combat.pendingCardCopy?.sourceNames?.[0] ?? 'Double Tap'
      // A seat may only play cards from its OWN hand. Without this check any
      // client could spend another player's energy and empty their hand.
      const player = run.combat.players.find((candidate) => candidate.id === seat.playerId)
      const card = copied && run.combat.pendingCardCopy?.playerId === seat.playerId
        ? run.combat.pendingCardCopy.card
        : player?.hand.find((held) => held.uid === action.cardUid)
      if (!card) fail(copied ? `No ${pendingCopyName} copy is waiting for you` : 'That card is not in your hand')
      const def = faceOf(cardDef(card.defId), card.upgraded)
      const cardsOutsidePlay = player.hand.length - Number(!copied)
      const variableDiscard = def.effects.some((effect) => effect.kind === 'discardAny')
      const variableExhaust = def.effects.find((effect) => effect.kind === 'exhaustAny')
      const discardUids = variableDiscard ? action.discardUids : uidList(action.discardUids)
      if (action.discardUids !== undefined && (
        !Array.isArray(action.discardUids) ||
        (variableDiscard
          ? action.discardUids.length > cardsOutsidePlay || action.discardUids.some((uid) => typeof uid !== 'string')
          : discardUids.length !== action.discardUids.length)
      )) fail('Discard choices must be a valid list of card ids')
      const exhaustUids = uidList(action.exhaustUids) ?? []
      if (action.exhaustUids !== undefined && (
        !Array.isArray(action.exhaustUids) || exhaustUids.length !== action.exhaustUids.length ||
        (variableExhaust && action.exhaustUids.length > variableExhaust.amount)
      )) fail('Exhaust choices must be a valid list of card ids')
      if (variableExhaust && exhaustUids.length < Math.min(
        variableExhaust.minimum ?? 0,
        Math.max(0, cardsOutsidePlay),
      )) fail('Choose the minimum number of cards to Exhaust')
      const shivEffects = def.type === 'power' && def.trigger && def.resolvesOnPlay !== true ? [] : def.effects
      const mandatoryShivs = cardShivChoiceCount(def, player, action.mode)
      const { overflow, targets: shivEnemyUids } = overflowChoices(run.combat, shivEffects, {
        ...action, discardUids,
      }, mandatoryShivs)
      const enemyUids = uidList(action.enemyUids)
      const playerIds = uidList(action.playerIds)
      if (action.enemyUids !== undefined && (
        !Array.isArray(action.enemyUids) || enemyUids.length !== action.enemyUids.length
      )) fail('Enemy choices must be a list of ids')
      if (action.playerIds !== undefined && (
        !Array.isArray(action.playerIds) || playerIds.length !== action.playerIds.length
      )) fail('Player choices must be a list of ids')
      const scryDiscardUids = uidList(action.scryDiscardUids)
      if (action.scryDiscardUids !== undefined && (
        !Array.isArray(action.scryDiscardUids) || scryDiscardUids.length !== action.scryDiscardUids.length
      )) fail('Scry choices must be a list of card ids')
      const topdeckUids = uidList(action.topdeckUids)
      if (action.topdeckUids !== undefined && (
        !Array.isArray(action.topdeckUids) || topdeckUids.length !== action.topdeckUids.length
      )) fail('Topdeck choices must be a list of card ids')
      const recoverDiscardUid = action.recoverDiscardUid
      if (recoverDiscardUid !== undefined && typeof recoverDiscardUid !== 'string') {
        fail('Discard recovery must be a card id')
      }
      const recoverExhaustUid = action.recoverExhaustUid
      if (recoverExhaustUid !== undefined && typeof recoverExhaustUid !== 'string') {
        fail('Exhaust recovery must be a card id')
      }
      if (action.energySpent !== undefined && !Number.isInteger(action.energySpent)) {
        fail('X Energy must be a whole number')
      }
      const context = {
        enemyUid: action.enemyUid ?? null,
        enemyUids,
        playerId: action.playerId ?? seat.playerId,
        energySpent: action.energySpent,
        playerIds,
        switchWithPlayerId: action.switchWithPlayerId ?? null,
        mode: action.mode,
        // Coerced, not trusted: these arrive as JSON from a socket, and a
        // string where a list belongs threw a raw TypeError out of `apply`
        // instead of being refused like any other bad message.
        discardUids,
        exhaustUids,
        spendMiracle: action.spendMiracle === true,
        shivEnemyUids,
        // Both of these are real choices the rules grant (p.16, p.24). Dropping
        // them here made a Scry unable to bin anything and an orb evoke always
        // fall back to the first filled slot.
        scryDiscardUids,
        topdeckUids,
        recoverDiscardUid,
        recoverExhaustUid,
        evokeSlots: slotList(action.evokeSlots),
        evokeEnemyUids: targetList(action.evokeEnemyUids),
      }
      const combat = copied
        ? playCardCopy(run.combat, seat.playerId, context)
        : playCard(run.combat, seat.playerId, action.cardUid, context)
      if (combat === run.combat && overflow > 0 && shivEnemyUids.length > mandatoryShivs) {
        const withoutOverflowTargets = copied
          ? playCardCopy(run.combat, seat.playerId, {
            ...context, shivEnemyUids: shivEnemyUids.slice(0, mandatoryShivs),
          })
          : playCard(run.combat, seat.playerId, action.cardUid, {
            ...context, shivEnemyUids: shivEnemyUids.slice(0, mandatoryShivs),
          })
        if (withoutOverflowTargets !== run.combat) {
          fail('An earlier overflow Shiv defeated a later target; choose targets again')
        }
      }
      if (combat === run.combat && action.preflight === true) {
        fail('That card play is no longer legal; choose again')
      }
      return combat === run.combat ? run : { ...run, combat }
    }

    case 'activatePower': {
      if (!run.combat) fail('No combat in progress')
      const combat = activatePower(run.combat, seat.playerId, action.powerUid, {
        enemyUid: action.enemyUid ?? null,
        enemyRow: Number.isInteger(action.enemyRow) ? action.enemyRow : null,
      })
      if (combat === run.combat && action.preflight === true) {
        fail('That Power ability is no longer legal; choose again')
      }
      return combat === run.combat ? run : { ...run, combat }
    }

    // The turn is shared, so any seat may advance it — at the table this is
    // one player asking "everyone done?" and nobody objecting.
    case 'startTurn': {
      if (!run.combat) fail('No combat in progress')
      const combat = startPlayerTurnWithChoices(run.combat)
      return combat === run.combat ? run : { ...run, combat }
    }
    case 'resolveEnemies': {
      if (!run.combat) fail('No combat in progress')
      const combat = enemyTurn(run.combat)
      return combat === run.combat ? run : { ...run, combat }
    }

    case 'resolveCombat':
      return resolveCombat(run)
    case 'spendMiracle': {
      if (!run.combat) fail('No combat in progress')
      const combat = spendMiracle(run.combat, seat.playerId)
      return combat === run.combat ? run : { ...run, combat }
    }
    case 'spendShiv': {
      if (!run.combat) fail('No combat in progress')
      const combat = spendShiv(run.combat, seat.playerId, action.enemyUid)
      return combat === run.combat ? run : { ...run, combat }
    }
    case 'usePotion': {
      if (!run.combat) fail('No combat in progress')
      const player = run.combat.players.find((candidate) => candidate.id === seat.playerId)
      if (typeof action.potionId !== 'string' || !player?.potions.includes(action.potionId)) {
        fail('That potion is not yours')
      }
      const def = potionDef(action.potionId)
      const { overflow, targets: shivEnemyUids } = overflowChoices(run.combat, def.effects, action)
      const combat = activatePotion(
        run.combat,
        seat.playerId,
        action.potionId,
        {
          enemyUid: action.enemyUid ?? null,
          targetPlayerId: action.targetPlayerId ?? null,
          enemyRow: Number.isInteger(action.enemyRow) ? action.enemyRow : null,
          shivEnemyUids,
        },
      )
      if (
        combat === run.combat &&
        overflow > 0 &&
        shivEnemyUids.length > 0 &&
        run.combat.phase === 'player' &&
        !player.dead
      ) {
        fail('An earlier overflow Shiv defeated a later target; choose targets again')
      }
      if (combat === run.combat && action.preflight === true) {
        fail('That potion use is no longer legal; choose again')
      }
      return combat === run.combat ? run : { ...run, combat }
    }
    case 'enterRoom':
      return enterRoom(run, action.roomId)
    case 'leaveRoom':
      // A campfire's only exit is everyone having chosen (p.9). Otherwise one
      // misclick walks the party out and costs everybody their Rest.
      //
      // The phase matters as well as the room: `resolveCampfire` leaves the
      // map position pointing at the campfire it just left, and play is
      // simultaneous (p.12), so a seat acting on a slightly stale frame would
      // otherwise get a hard error for a room the party has already left.
      if (run.phase === 'room' && currentRoom(run.map)?.kind === 'campfire') {
        fail('Everyone must Rest or Smith before leaving the campfire')
      }
      return leaveRoom(run)
    case 'campfire':
      // Handled outside `dispatch`: it has to accumulate across messages, so it
      // needs the room and not just the run.
      return run
    case 'cardReward':
      return run
    case 'advanceAct':
      return advanceAct(run)
    default:
      return fail(`Unknown action: ${action?.kind}`)
  }
}

/**
 * What one seat is allowed to see.
 *
 * Three things are hidden, and each would break the game differently:
 *
 *  - `rng`, from everyone. It is the seed of every future die roll and shuffle.
 *    Leaking it turns the game into a solved puzzle, and unlike a peeked hand
 *    nobody at the table could tell it had happened.
 *  - Other players' hands. The rulebook is explicit (p.12): ask "How much
 *    damage do you have?" "rather than look at a player's hand".
 *  - Every draw pile, including the viewer's own. It is a shuffled face-down
 *    stack; its owner is no more entitled to read ahead than anyone else.
 *  - Other players' deck lists. Least privilege: no screen needs them, since
 *    each client only ever upgrades its own cards. Sending them would also
 *    make the hand redaction above much weaker, because deck minus the face-up
 *    piles narrows down what someone is holding.
 *
 * Discard and exhaust piles stay public — they are face up on the table.
 */
export function snapshotFor(room, seatToken) {
  const seat = findSeat(room, seatToken)
  const viewerId = seat?.playerId ?? null

  return {
    code: room.code,
    phase: room.phase,
    ascension: room.ascension,
    version: room.version,
    you: seat ? seatPublic(seat) : null,
    campfireChoice: viewerId !== null && room.campfireChoices?.[viewerId]
      ? { ...room.campfireChoices[viewerId] }
      : undefined,
    /** Seats that have chosen at the campfire, so the UI can show who is left. */
    campfireDecided: Object.keys(room.campfireChoices ?? {}),
    // A reconnecting seat must be able to inspect its own pending permanent
    // choice. `null` is meaningful (skip), so test ownership rather than truth.
    rewardChoice: viewerId !== null && Object.hasOwn(room.rewardChoices ?? {}, viewerId)
      ? room.rewardChoices[viewerId]
      : undefined,
    rewardDecided: Object.keys(room.rewardChoices ?? {}),
    rewardConfirmed: Object.keys(room.rewardConfirmed ?? {}),
    endTurnDecided: Object.keys(room.endTurnReady ?? room.endTurnOrders ?? {}),
    endTurnAbilities: visibleEndTurnAbilities(room, viewerId),
    endTurnOrder: room.endTurnOrder?.map((choice) => publicEndTurnChoice(room, choice)),
    endTurnCoordinatorId: room.endTurnAbilities ? endTurnCoordinator(room) : undefined,
    startTurnAbilities: room.run?.combat?.phase === 'start'
      ? startTurnAbilities(room.run.combat)
      : undefined,
    startTurnCoordinatorId: room.run?.combat?.phase === 'start' ? startTurnCoordinator(room) : undefined,
    discardOrder: viewerId !== null && room.endTurnOrders?.[viewerId]
      ? [...room.endTurnOrders[viewerId]]
      : undefined,
    cardPreview: viewerId !== null && room.cardPreviews?.[viewerId]
      ? structuredClone(room.cardPreviews[viewerId])
      : undefined,
    cardChoicePlayerId: Object.keys(room.cardPreviews ?? {})[0] ?? room.run?.combat?.pendingCardCopy?.playerId,
    seats: room.seats.map(seatPublic),
    run: room.run ? redactRun(room.run, viewerId) : null,
  }
}

function visibleEndTurnAbilities(room, viewerId) {
  if (!room.endTurnAbilities) return undefined
  const privateCounts = new Map()
  return room.endTurnAbilities.map((ability) => {
    const visible = {
      ...ability,
      id: publicEndTurnChoice(room, ability.id),
      targets: ability.targets?.map((target) => ({ ...target })),
    }
    if (ability.playerId === viewerId || !ability.id.includes('/card:')) return visible
    const number = (privateCounts.get(ability.playerId) ?? 0) + 1
    privateCounts.set(ability.playerId, number)
    const owner = room.seats.find((seat) => seat.playerId === ability.playerId)?.name ?? 'Teammate'
    return { ...visible, label: `${owner} — Private hand ability ${number}` }
  })
}

function publicEndTurnChoice(room, choice) {
  const id = endTurnChoiceId(choice)
  const publicId = Object.entries(room.endTurnPublicIds ?? {})
    .find(([, realId]) => realId === id)?.[0]
  if (!publicId) fail('End-turn ability mapping is stale')
  const target = endTurnChoiceTarget(choice)
  return target ? chooseEndTurnTarget(publicId, target) : publicId
}

function redactRun(run, viewerId) {
  return {
    ascension: run.ascension,
    act: run.act,
    phase: run.phase,
    map: run.map,
    // Public facts only: "Ann played Strike", "Turn 1 begins (die 3)".
    log: run.log,
    players: run.players.map((player) => redactPlayer(player, viewerId)),
    combat: run.combat ? redactCombat(run.combat, viewerId) : null,
    // Full Knowledge (p.8): once any reward is revealed, every player may see
    // it before final decisions. Unrevealed offers still carry choices: null.
    rewards: run.rewards,
  }
}

function redactCombat(combat, viewerId) {
  const progress = combat.startTurnProgress
  return {
    turn: combat.turn,
    die: combat.die,
    phase: combat.phase,
    powerTriggersUsedThisTurn: combat.powerTriggersUsedThisTurn ?? [],
    startTurnProgress: progress ? {
      choices: structuredClone(progress.choices),
      forcedCard: progress.forcedCard ? {
        playerId: progress.forcedCard.playerId,
        cardUid: progress.forcedCard.playerId === viewerId ? progress.forcedCard.cardUid : null,
        sourceCardId: progress.forcedCard.sourceCardId ?? 'mayhem',
        exhaustNonPower: progress.forcedCard.exhaustNonPower === true,
      } : undefined,
    } : undefined,
    pendingCardCopy: combat.pendingCardCopy ? {
      playerId: combat.pendingCardCopy.playerId,
      card: structuredClone(combat.pendingCardCopy.card),
      energySpent: combat.pendingCardCopy.energySpent,
      resumePhase: combat.pendingCardCopy.resumePhase,
      forcedExhaust: combat.pendingCardCopy.forcedExhaust,
      forcedChoices: structuredClone(combat.pendingCardCopy.forcedChoices),
      deferredHavocs: structuredClone(combat.pendingCardCopy.deferredHavocs),
      sourceNames: structuredClone(combat.pendingCardCopy.sourceNames),
    } : undefined,
    log: combat.log,
    // Enemies carry nothing secret: hit points, tokens and the cube's position
    // are all printed on the card and face up on the table.
    enemies: combat.enemies,
    players: combat.players.map((player) => redactPlayer(player, viewerId)),
  }
}

/**
 * What one seat may see of a player.
 *
 * An ALLOWLIST, deliberately. The obvious way to write this is to destructure
 * the secrets out and spread the rest — but then every field added to `Player`
 * later is published by default, and the failure is silent. Listing what goes
 * out means a new field is invisible until someone decides it is public, which
 * is the safe direction to fail in.
 */
function redactPlayer(player, viewerId) {
  const mine = player.id === viewerId
  return {
    id: player.id,
    name: player.name,
    character: player.character,
    row: player.row,
    hp: player.hp,
    maxHp: player.maxHp,
    block: player.block,
    energy: player.energy,
    gold: player.gold,
    strength: player.strength,
    strengthLossAtEndOfTurn: player.strengthLossAtEndOfTurn,
    vulnerable: player.vulnerable,
    weak: player.weak,
    drawLocked: player.drawLocked === true,
    lostHpThisCombat: player.lostHpThisCombat === true,
    hpLostThisRound: player.hpLostThisRound ?? 0,
    hpLossLimitThisRound: player.hpLossLimitThisRound,
    freeCardsThisTurn: player.freeCardsThisTurn ?? 0,
    doubledAttacksThisTurn: player.doubledAttacksThisTurn ?? 0,
    doubledCardsThisTurn: player.doubledCardsThisTurn ?? 0,
    retainCardsThisTurn: player.retainCardsThisTurn ?? 0,
    cardsPlayedThisTurn: player.cardsPlayedThisTurn ?? 0,
    attacksPlayedThisTurn: player.attacksPlayedThisTurn ?? 0,
    shivs: player.shivs,
    shivDamageBonus: player.shivDamageBonus ?? 0,
    cardBlockBonus: player.cardBlockBonus ?? 0,
    hitPoison: player.hitPoison ?? 0,
    starterStrikeDamageBonus: player.starterStrikeDamageBonus ?? 0,
    clawCubesGainedThisCombat: player.clawCubesGainedThisCombat ?? 0,
    starterDefendBlockBonus: player.starterDefendBlockBonus ?? 0,
    miracles: player.miracles,
    stance: player.stance,
    orbs: player.orbs,
    orbEvokeBonus: player.orbEvokeBonus ?? 0,
    darkOrbEvokeBonus: player.darkOrbEvokeBonus ?? 0,
    orbEndTurnBonus: player.orbEndTurnBonus ?? 0,
    lightningEndTurnBonus: player.lightningEndTurnBonus ?? 0,
    dead: player.dead,
    // Face up on the table.
    discard: player.discard,
    exhaust: player.exhaust,
    powers: player.powers,
    relics: player.relics,
    potions: player.potions,
    // Sizes are public — you can see how big a stack is — but not contents.
    handCount: player.hand.length,
    drawCount: player.draw.length,
    deckCount: player.deck.length,
    // Face-down reward stacks, secret even from their owner until drawn.
    cardRewardCount: player.cardRewards.length,
    rareRewardCount: player.rareRewards.length,
    // Yours alone. Never the draw pile: it is shuffled and face down, and its
    // owner is no more entitled to read ahead than anyone else.
    hand: mine ? player.hand : null,
    deck: mine ? player.deck : null,
  }
}
