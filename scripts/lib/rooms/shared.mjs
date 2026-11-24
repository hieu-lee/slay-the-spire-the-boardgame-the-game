// Shared constants, seat/token helpers, error handling, input validators, and
// low-level concurrent/pending choice state helpers for co-op rooms.

import { randomBytes } from 'node:crypto'
import {
  canGiveUpRun,
  CHARACTER_IDS,
  endTurnResolutionAbility,
  overflowShivCount,
  parseCampaignProgress,
  relicDef,
  resolveEnemyTargets,
} from '../../../src/game/state.ts'
import { chosenDieRelicAbilities } from '../../../src/game/relics.ts'
import { reachesEnemy } from '../../../src/game/combat/queries.ts'
import { cardIsCurse } from '../../../src/game/cards.ts'
import { normalizeCardPacks } from '../../../src/game/packs.ts'
import { isSkinOf } from '../../../src/game/skins.ts'
import { catchUpAwardIndex } from '../../../src/game/coins.ts'

/** Characters a seat may pick. Two players may not take the same one (p.4). */
export const CHARACTERS = [...CHARACTER_IDS]

export const MAX_SEATS = 4

export const GIVE_UP_TIMEOUT_MS = 10_000

/**
 * Ambiguous glyphs are left out: a room code gets read aloud over voice chat,
 * where O/0 and I/1 are the same sound and the same mistake.
 */
export const LEGACY_DECK_TYPES = new Set([
  'Ironclad Barricade Body Slam', 'Ironclad Strength Multi-Hit', 'Ironclad Exhaust Engine',
  'Ironclad Block Fortress', 'Ironclad Heavy Blade', 'Ironclad Wound Engine',
  'Silent Poison Catalyst', 'Silent Shiv Finisher', 'Silent Discard Engine',
  'Silent Footwork Block', 'Silent Poison Shiv Hybrid', 'Silent Draw Combo',
  'Defect Lightning Orb Focus', 'Defect Frost Orb Focus', 'Defect Mixed Orb',
  'Defect Claw Spam', 'Defect Dark Orb Burst', 'Defect Zero Cost Cycle', 'Defect Powers Engine',
  'Watcher Stance Dance', 'Watcher Wrath Burst', 'Watcher Retain Engine',
  'Watcher Scry Engine', 'Watcher Divinity Mantra', 'Watcher Calm Block',
  'Slime Boss Slime Swarm', 'Slime Boss Split Engine', 'Slime Boss Tackle Burst',
  'Guardian Mode Shift', 'Guardian Socket Gems', 'Guardian Defensive Scaling',
  'Hexaghost Ignite Engine', 'Hexaghost Ghostflame Cycle', 'Hexaghost Burn Control',
  'Hermit Chamber Combo', 'Hermit Dead On Burst', 'Hermit Curse Engine',
])

const CODE_ALPHABET = 'ACDEFGHJKLMNPQRTUVWXY34679'

export const SERVER_EPOCH = randomBytes(6).toString('hex')

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

export function token(random = randomBytes) {
  return random(24).toString('base64url')
}

/**
 * A saved room that seats a hero that no longer exists (Kratos was a character before he became
 * a skin) cannot continue: the engine has no such hero. Recovery discards it instead of failing.
 */
export function roomHasRemovedHero(room) {
  const removed = (character) => typeof character === 'string' && !CHARACTERS.includes(character)
  return room.seats.some((seat) => removed(seat?.character)) ||
    Array.isArray(room.run?.players) && room.run.players.some((player) => removed(player?.character))
}

export function normalizeLegacyPlayer(player) {
  // Presentation only: a skin the hero cannot wear is dropped, never an error.
  if (player.skin !== undefined && !isSkinOf(player.character, player.skin)) delete player.skin
  player.chamber = Array.isArray(player.chamber) ? player.chamber : []
  player.chamberSlots = Number.isSafeInteger(player.chamberSlots) ? player.chamberSlots
    : player.character === 'hermit' ? 2 : 0
  player.heat = Number.isSafeInteger(player.heat) ? player.heat : player.character === 'hexaghost' ? 1 : 0
  player.soulburn = Number.isSafeInteger(player.soulburn) ? player.soulburn : 0
  player.guardianMode = player.guardianMode === 'attack' || player.guardianMode === 'defense'
    ? player.guardianMode : player.character === 'guardian' ? 'attack' : null
  player.vigor = Number.isSafeInteger(player.vigor) ? player.vigor : 0
  player.vigorSpentThisTurn = Number.isSafeInteger(player.vigorSpentThisTurn) ? player.vigorSpentThisTurn : 0
  player.slimes = Array.isArray(player.slimes) ? player.slimes : []
  player.lootChests = Number.isSafeInteger(player.lootChests) ? player.lootChests : 0
}

/**
 * Fast deep clone for JSON-compatible plain objects, arrays, and primitives.
 * Preserves `undefined` property values like `structuredClone` while avoiding
 * V8's structured-serialization overhead on flat game/room state. Falls back to
 * `structuredClone` for non-plain objects (Date, Map, Set, typed arrays, etc.).
 */
export function fastClone(value) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    const length = value.length
    const out = new Array(length)
    for (let i = 0; i < length; i += 1) out[i] = fastClone(value[i])
    return out
  }
  if (value.constructor !== Object && Object.getPrototypeOf(value) !== null) {
    return structuredClone(value)
  }
  const keys = Object.keys(value)
  const out = {}
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i]
    if (key === '__proto__') {
      Object.defineProperty(out, key, {
        value: fastClone(value[key]),
        enumerable: true,
        configurable: true,
        writable: true,
      })
    } else {
      out[key] = fastClone(value[key])
    }
  }
  return out
}

export function assignPendingRelicIds(run) {
  if (!run) return
  let next = run.nextPendingRelicId ?? 0
  let assigned = false
  const players = run.players
  for (let i = 0; i < players.length; i += 1) {
    const relics = players[i].relics
    for (let j = 0; j < relics.length; j += 1) {
      const relic = relics[j]
      if (!relic.pending) continue
      if (!Number.isInteger(relic.pendingId)) {
        relic.pendingId = next++
        assigned = true
      } else if (relic.pendingId + 1 > next) {
        next = relic.pendingId + 1
      }
    }
  }
  if (assigned || run.nextPendingRelicId !== next) run.nextPendingRelicId = next
}

export function findSeat(room, seatToken) {
  if (!seatToken) return undefined
  return room.seats.find((seat) => seat.token === seatToken)
}

/** A public, non-secret id for a seat, safe to show to the whole table. */
export function seatPublic(seat) {
  return {
    playerId: seat.playerId,
    name: seat.name,
    character: seat.character,
    // Public to the whole table: every seat sees how the others look.
    ...(seat.skin ? { skin: seat.skin } : {}),
    connected: seat.connected,
    // Which Shop packs this player brings, so the lobby can say whose they are.
    ...(seat.cardPacks?.length ? { cardPacks: [...seat.cardPacks] } : {}),
  }
}

/**
 * The Shop packs a run started now would use: every pack at least one seated
 * player bought (and has switched on). `startRun` freezes it into the run, so a
 * late Catch Up joiner or a seat that changes its packs mid-run changes nothing.
 */
export function roomCardPacks(room) {
  return normalizeCardPacks(room.seats.flatMap((seat) => seat.cardPacks ?? []))
}

class RoomError extends Error {
  constructor(message) {
    super(message)
    this.name = 'RoomError'
  }
}

export const fail = (message) => {
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
export function campaignUnlocks(value) {
  const progress = parseCampaignProgress(value)
  return { colorless: progress.colorless, actIV: progress.actIV, highestAscension: progress.highestAscension }
}

export function includeSeatUnlocks(room) {
  const unlocks = room.seats.map((seat) => seat.campaignUnlocks).filter(Boolean)
  const base = room.campaignBaseProgress ?? room.campaignProgress
  room.campaignProgress = {
    ...base,
    colorless: Math.max(base.colorless, ...unlocks.map((value) => value.colorless)),
    actIV: Math.max(base.actIV, ...unlocks.map((value) => value.actIV)),
    highestAscension: Math.max(base.highestAscension, ...unlocks.map((value) => value.highestAscension),
      ...room.seats.map((seat) => seat.earnedAscension ?? 0)),
  }
  room.ascension = Math.min(room.ascension, room.campaignProgress.highestAscension)
  if (room.metaOptions.quickStartAct === 4 && room.campaignProgress.actIV < 5) {
    room.metaOptions = { ...room.metaOptions, quickStartAct: 1 }
  }
}

/** An absent Hermit's setup Load keeps its Curses in hand rather than aiming one blindly. */
export const absentSetupLoadCard = (player) => player?.hand.find((card) => !cardIsCurse(card.defId)) ?? player?.hand[0]

export function activeGiveUpVote(room, now = Date.now()) {
  const vote = room.giveUpVote
  return room.run && canGiveUpRun(room.run, room.run.campaignProgress) &&
    vote && vote.runId === room.run.campaign.runId && vote.deadlineAt > now
    ? { ...vote, eligiblePlayerIds: room.run.players.map((player) => player.id) }
    : undefined
}

export function restoreConcurrentCopy(room) {
  if (room.run?.phase !== 'combat' || room.run.combat?.phase !== 'player' || room.run.combat.pendingCardCopy) return
  const queued = room.concurrentCardCopies?.at(-1)
  if (!queued) return
  room.concurrentCardCopies = room.concurrentCardCopies.slice(0, -1)
  room.run = {
    ...room.run,
    combat: { ...room.run.combat, phase: 'copy', pendingCardCopy: queued },
  }
}

export function restoreConcurrentChoice(room, field, queueField) {
  const combat = room.run?.combat
  const playerWindow = combat?.phase === 'player' ||
    combat?.phase === 'copy' && combat.pendingCardCopy?.resumePhase === 'player'
  if (room.run?.phase !== 'combat' || !playerWindow || combat[field]) return
  const queued = room[queueField]?.at(-1)
  if (!queued) return
  room[queueField] = room[queueField].slice(0, -1)
  room.run = { ...room.run, combat: { ...combat, [field]: queued } }
}

export function restoreConcurrentForcedCard(room) {
  const combat = room.run?.combat
  const playerWindow = combat?.phase === 'player' ||
    combat?.phase === 'copy' && combat.pendingCardCopy?.resumePhase === 'player'
  if (room.run?.phase !== 'combat' || !playerWindow || combat.startTurnProgress?.forcedCard) return
  const queued = room.concurrentForcedCards?.at(-1)
  if (!queued) return
  room.concurrentForcedCards = room.concurrentForcedCards.slice(0, -1)
  room.run = { ...room.run, combat: {
    ...combat,
    startTurnProgress: { ...combat.startTurnProgress, forcedCard: queued },
  } }
}

export function refreshDistilled(combat, pending) {
  const player = combat?.players.find((candidate) => candidate.id === pending?.playerId)
  const cards = pending?.cards.filter((card) => player?.hand.some((held) => held.uid === card.uid)) ?? []
  return cards.length > 0 ? { ...pending, cards } : undefined
}

export function refreshRelicScry(combat, pending) {
  const player = combat?.players.find((candidate) => candidate.id === pending?.playerId)
  return player ? { ...pending, cards: player.draw.slice(0, 3) } : undefined
}

export function forcedCardStillValid(combat, pending) {
  return combat?.players.find((candidate) => candidate.id === pending?.playerId)?.hand
    .some((card) => card.uid === pending.cardUid) === true
}

export function refreshChoiceTargets(combat, choices) {
  const living = new Set(combat?.enemies.filter((enemy) => !enemy.dead).map((enemy) => enemy.uid) ?? [])
  return {
    ...choices,
    pendingDieRelicChoices: choices.pendingDieRelicChoices.map((choice) =>
      choice.enemyUid && !living.has(choice.enemyUid) ? { ...choice, enemyUid: null } : choice),
  }
}

export function deterministicDieRelicChoiceContext(combat, choice) {
  const owner = combat?.players.find((player) => player.id === choice.playerId)
  const ability = owner && chosenDieRelicAbilities(relicDef(choice.relicDefId))[choice.abilityIndex]
  if (!owner || !ability) return null
  const privateEffect = ability.effects.find((effect) =>
    effect.kind === 'discard' || effect.kind === 'exhaustFromHand')
  const required = privateEffect ? Math.min(privateEffect.amount, owner.hand.length) : 0
  if (privateEffect && (ability.optional ? required > 0 : required > 1 || required === 1 && owner.hand.length !== 1)) {
    return null
  }
  const selected = privateEffect && !ability.optional ? owner.hand.slice(0, required).map((card) => card.uid) : []
  const skipped = ability.optional && selected.length === 0
  const needsEnemy = !skipped && ability.effects.some((effect) => reachesEnemy(effect, owner))
  const living = combat.enemies.filter((enemy) => !enemy.dead)
  const enemyUid = living.some((enemy) => enemy.uid === choice.enemyUid)
    ? choice.enemyUid : living.length === 1 ? living[0].uid : null
  if (needsEnemy && !enemyUid) return null
  return {
    choiceId: choice.id,
    enemyUid,
    ...(privateEffect?.kind === 'discard' ? { discardUids: selected } : {}),
    ...(privateEffect?.kind === 'exhaustFromHand' ? { exhaustUids: selected } : {}),
  }
}

export function dieRelicChoiceNeedsInput(combat, choice) {
  return deterministicDieRelicChoiceContext(combat, choice) === null
}

export function prioritizePendingTrigger(combat, predicate) {
  const index = combat?.pendingTriggers?.findIndex(predicate) ?? -1
  if (index < 0) return undefined
  if (index === 0) return combat
  return {
    ...combat,
    pendingTriggers: [combat.pendingTriggers[index], ...combat.pendingTriggers.filter((_trigger, candidate) => candidate !== index)],
  }
}

export function prioritizePendingChoice(combat, field, predicate) {
  const index = combat?.[field]?.findIndex(predicate) ?? -1
  if (index < 0) return undefined
  if (index === 0) return combat
  return { ...combat, [field]: [combat[field][index], ...combat[field].filter((_choice, i) => i !== index)] }
}

export function restoreRoom(room, checkpoint) {
  for (const key of Object.keys(room)) if (!Object.hasOwn(checkpoint, key)) delete room[key]
  Object.assign(room, checkpoint)
}

/** Recorded runs a room keeps unclaimed shares for. */
export const MAX_RECORDED_RUNS = 8

/**
 * The boss coins of a recorded run, kept once the party leaves it so that a seat
 * that was away when it was recorded can still claim its share: where each
 * player's share starts in the awards (their Catch Up offset). Shares are keyed by
 * seat token, never by player id: a freed id goes to the next joiner, who played
 * none of it.
 */
export function recordedRunOf(room) {
  const run = room.run
  const awards = run?.campaign.bossCoins
  if (!run?.campaign.finalized || !Array.isArray(awards) || awards.length === 0) return undefined
  return {
    runId: run.campaign.runId,
    bossCoins: fastClone(awards),
    skips: Object.fromEntries(run.players.flatMap((player) => {
      const seat = room.seats.find((candidate) => candidate.playerId === player.id)
      return seat ? [[seat.token, catchUpAwardIndex(
        run.campaign.joinedAfterBosses?.[player.character] ?? 0, run.campaign.bossesDefeated, awards.length)]] : []
    })),
  }
}

/** Publishes only the next live target effect, so each owner resolves its own source immediately. */
export function publishEndTurnEffect(room) {
  const ability = endTurnResolutionAbility(room.run?.combat)
  if (!ability) return false
  room.endTurnAbilities = [ability]
  room.endTurnPublicIds = { [`v${room.version}a1`]: ability.id }
  return true
}

export function abandonedPowerContext(combat, playerId) {
  return {
    enemyUid: combat.enemies.find((enemy) => !enemy.dead)?.uid ?? null,
    playerId,
    exhaustUids: [],
    guardianModeShift: false,
    scryDiscardUids: [],
  }
}

/** Drops a published end-turn effect and any per-seat discard orders. */
export function clearEndTurnOrdering(room) {
  room.endTurnAbilities = undefined
  room.endTurnPublicIds = undefined
  room.endTurnOrders = undefined
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

export const hermitDieRelicList = (value) => Array.isArray(value)
  ? value.slice(0, UID_LIMIT).flatMap((choice) => {
    const discardUids = uidList(choice?.discardUids)
    if (!choice || typeof choice.playerId !== 'string' || !Number.isInteger(choice.relicIndex) ||
      choice.relicIndex < 0 || !Number.isInteger(choice.abilityIndex) || choice.abilityIndex < 0 ||
      choice.enemyUid !== undefined && choice.enemyUid !== null && typeof choice.enemyUid !== 'string' ||
      choice.targetPlayerId !== undefined && choice.targetPlayerId !== null && typeof choice.targetPlayerId !== 'string' ||
      choice.discardUids !== undefined && discardUids?.length !== choice.discardUids.length) return []
    return [{
      playerId: choice.playerId,
      relicIndex: choice.relicIndex,
      abilityIndex: choice.abilityIndex,
      ...(choice.enemyUid === undefined ? {} : { enemyUid: choice.enemyUid }),
      ...(choice.targetPlayerId === undefined ? {} : { targetPlayerId: choice.targetPlayerId }),
      ...(discardUids === undefined ? {} : { discardUids }),
    }]
  })
  : undefined

/**
 * A list of orb slot indices from the network.
 *
 * Integers only. Passed through raw, a string element was used as a property
 * key on the orbs array — `'length'` evoked a phantom orb and then truncated
 * the array, and `'__proto__'` crashed the room layer outright.
 */
export const slotList = (value) =>
  Array.isArray(value)
    ? value.slice(0, UID_LIMIT).map((item) => Number.isInteger(item) && item >= 0 ? item : -1)
    : undefined

export const targetList = (value) => Array.isArray(value)
  ? value.slice(0, UID_LIMIT).map((item) => item === null || typeof item === 'string' ? item : '')
  : undefined

export function overflowChoices(combat, effects, action, mandatory = 0) {
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
