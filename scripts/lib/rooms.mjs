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
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  CAPS,
  CHARACTER_IDS,
  abandonHermitChamberPlay,
  abandonHermitSetupLoad,
  abandonGuardianSocket,
  abandonCardCopy,
  abandonForcedCard,
  activatePower,
  activatePotion,
  activateRelic,
  advanceAct,
  advanceQuickSetup,
  canUpgradeCard,
  canRerollDownfallSelfBoss,
  chooseEvent,
  chooseNeow,
  chooseRelicReward,
  cardDef,
  cardNeedsChoicePreview,
  cardNeedsEnemy,
  cardShivChoiceCount,
  canSkipEvent,
  unavailableEventOptionIds,
  beginEndTurnResolution,
  beginCatchUp,
  chooseEndTurnTarget,
  chooseDistilledCard,
  defaultPendingDieRelicChoice,
  discardOrderIsValid,
  endTurnResolutionAbility,
  createRun,
  courierCost,
  currentRoom,
  endPlayerTurn,
  enemyTurn,
  enterRoom,
  finishRun,
  finishMerchant,
  giveUpRun,
  canGiveUpRun,
  faceOf,
  hasPendingRelicAcquisition,
  leaveRoom,
  purchaseAtMerchant,
  decideCourier,
  revealCourier,
  merchantPurchaseCost,
  merchantRemovalCost,
  mandatoryChoicePending,
  migrateLegacyBossRareRewards,
  revealRewardItems,
  neowPreview,
  removeAtCurrentMerchant,
  overflowShivCount,
  pendingRelicPreview,
  pendingRelicEligibleCards,
  orderStartTurnScries,
  pendingTriggerAbility,
  pendingTriggerSlimeEnemyChoiceCount,
  playCard,
  playCardCopy,
  playHermitChamberCard,
  playCost,
  previewCardChoice,
  previewCardCopyChoice,
  previewHermitChamberCardChoice,
  previewPowerChoice,
  potionDef,
  revealCardReward,
  resolveGoldReward,
  resolveRelicReward,
  resolveNeowEffect,
  resolveNeowGold,
  resolveNeowReward,
  revealNeowReward,
  resolveBossRelicReward,
  resolvePotionReward,
  resolveTransformReward,
  resolveCampfire,
  resolveCardRewards,
  resolveCombat,
  resolveEnemyTargets,
  resolvePendingTrigger,
  resolveEndTurnAbility,
  resolvePendingDieRelicChoice,
  resolvePendingRelic,
  resolvePlunderRowSwitch,
  resolveHermitSetupLoad,
  resolveHermitStrengthReward,
  resolveGuardianSocket,
  resolveStartPlayerTurn,
  resolveStartTurnDiscard,
  resolveStartTurnScry,
  slimeCommandEnemyChoiceCount,
  rerollDownfallSelfBoss,
  rulesetForCharacters,
  spendMiracle,
  spendShiv,
  spendSoulburn,
  tradePotion,
  usePotionOutsideCombat,
  switchBetweenCombatRow,
  skipEvent,
  startPlayerTurnWithChoices,
  startPendingBoss,
  startTurnAbilities,
  startTurnDiscardPreview,
  startTurnScryAbilities,
  startTurnScryPreview,
  visibleMap,
  createCampaignProgress,
  parseCampaignProgress,
  allocateSharedMarks,
  normalizeModifierIds,
} from '../../src/game/state.ts'

/** Characters a seat may pick. Two players may not take the same one (p.4). */
export const CHARACTERS = [...CHARACTER_IDS]

export const MAX_SEATS = 4
export const GIVE_UP_TIMEOUT_MS = 10_000

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

function normalizeLegacyPlayer(player) {
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

export function createStore({ file } = {}) {
  const store = { rooms: new Map(), file }
  if (!file) return store
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    if (!Array.isArray(saved?.rooms)) throw new Error('rooms must be an array')
    for (const room of saved.rooms) {
      if (typeof room?.code === 'string' && Array.isArray(room.seats) && room.campaignProgress) {
        const connectedAtSave = new Set(room.seats
          .filter((seat) => seat.connected !== false).map((seat) => seat.playerId))
        room.seats = room.seats.map((seat) => ({ ...seat, connected: false }))
        room.campaignProgress = parseCampaignProgress(room.campaignProgress)
        room.metaOptions = room.metaOptions && ['standard', 'daily', 'custom'].includes(room.metaOptions.mode)
          ? { mode: room.metaOptions.mode, modifiers: normalizeModifierIds(room.metaOptions.modifiers), quickStartAct: [1, 2, 3, 4].includes(room.metaOptions.quickStartAct) ? room.metaOptions.quickStartAct : 1 }
          : { mode: 'standard', modifiers: [], quickStartAct: 1 }
        room.chooseYourRelic = room.chooseYourRelic === true
        room.lastStand = room.lastStand === true && room.seats.length > 1
        if (room.run) {
          for (const player of room.run.players ?? []) normalizeLegacyPlayer(player)
          for (const player of room.run.combat?.players ?? []) normalizeLegacyPlayer(player)
          for (const player of room.run.roomState?.preparedCombat?.players ?? []) normalizeLegacyPlayer(player)
          room.run.guardianGemDeck = Array.isArray(room.run.guardianGemDeck) ? room.run.guardianGemDeck : []
          room.run.pendingGuardianSockets = Array.isArray(room.run.pendingGuardianSockets)
            ? room.run.pendingGuardianSockets : []
          if (room.run.roomState?.kind === 'merchant') {
            room.run.roomState.guardianGems = room.run.roomState.guardianGems ?? {}
            room.run.roomState.socketCardsBought = room.run.roomState.socketCardsBought ?? {}
          }
          const storedRuleset = room.run.meta?.ruleset
          room.run.meta = room.run.meta && Array.isArray(room.run.meta.modifierIds)
            ? room.run.meta : { mode: 'standard', modifierIds: [] }
          room.run.meta = {
            ...room.run.meta,
            ruleset: storedRuleset === 'base' || storedRuleset === 'downfall'
              ? storedRuleset
              : rulesetForCharacters(Array.isArray(room.run.players)
                ? room.run.players.map((player) => player.character) : []),
          }
          room.run.setup ??= null
          room.run.lastStand = room.run.lastStand == null ? room.lastStand : room.run.lastStand === true
          if (room.run.combat) {
            room.run.combat.lastStand = room.run.combat.lastStand === true
            if (room.run.combat.potionLimit !== 2 && room.run.combat.potionLimit !== 3) {
              room.run.combat.potionLimit = room.run.ascension >= 4 ? 2 : 3
            }
            // Older saves recorded only yes votes, so restore the quorum that
            // was connected when saved rather than letting reconnect shrink it.
            if (room.run.combat.phase === 'player' && room.endTurnReady &&
              Object.values(room.endTurnReady).every((ready) => ready === true)) {
              room.endTurnReady = Object.fromEntries(room.run.combat.players
                .filter((player) => !player.dead && connectedAtSave.has(player.id))
                .map((player) => [player.id, room.endTurnReady[player.id] === true]))
            }
            if (room.run.combat.phase === 'player' && room.endTurnAbilities &&
              !room.run.combat.endTurnProgress?.interactive) {
              room.endTurnAbilities = undefined
              room.endTurnPublicIds = undefined
              room.endTurnOrders = undefined
              room.endTurnOrder = undefined
              room.endTurnReady = undefined
            } else if (room.run.combat.endTurnProgress?.interactive) {
              // Target ids are derived from the live board. Re-publish them
              // after loading so older saved Loop prompts cannot retain their
              // former Orb-and-enemy target encoding.
              if (/@\d+:/.test(room.run.combat.endTurnProgress.order[0] ?? '')) {
                delete room.run.combat.endTurnProgress.rowTiebreakFor
              }
              room.endTurnAbilities = undefined
              room.endTurnPublicIds = undefined
              room.endTurnOrders = undefined
              room.endTurnOrder = undefined
              publishEndTurnEffect(room)
            }
          }
          const migratedRewards = revealRewardItems(migrateLegacyBossRareRewards(room.run))
          if (migratedRewards !== room.run) {
            room.run = migratedRewards
            room.rewardChoices = undefined
            room.rewardConfirmed = undefined
          }
          const runNumber = Number(/^campaign-(\d+)$/.exec(room.run.campaign?.runId ?? '')?.[1])
          const fallback = {
            ...room.campaignProgress,
            nextRunNumber: Number.isSafeInteger(runNumber)
              ? Math.max(room.campaignProgress.nextRunNumber, runNumber)
              : room.campaignProgress.nextRunNumber,
          }
          room.run.campaignProgress = parseCampaignProgress(room.run.campaignProgress, fallback)
          if (room.run.phase === 'neow' && room.run.neow?.players) {
            for (const progress of Object.values(room.run.neow.players)) {
              if (!progress || typeof progress !== 'object') continue
              if (typeof progress.redGoldPending !== 'boolean') progress.redGoldPending = false
              if (typeof progress.redRewardPending !== 'boolean') progress.redRewardPending = Boolean(progress.redReward)
              if (!Object.hasOwn(progress, 'pendingEffect')) progress.pendingEffect = null
              if (!Object.hasOwn(progress, 'rewardKind')) progress.rewardKind = progress.reward?.kind ?? null
              if (Array.isArray(progress.rewardQueue) && progress.rewardQueue.includes('curse')) {
                progress.rewardQueue = progress.rewardQueue.map((entry) => entry === 'curse' ? { kind: 'curse' } : entry)
              }
            }
          }
        }
        store.rooms.set(room.code, room)
      }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error(`Could not load room store: ${error instanceof Error ? error.message : String(error)}`)
  }
  return store
}

export function saveStore(store) {
  if (!store.file) return
  mkdirSync(dirname(store.file), { recursive: true })
  const temporary = `${store.file}.tmp`
  writeFileSync(temporary, JSON.stringify({ version: 1, rooms: [...store.rooms.values()] }), { mode: 0o600 })
  renameSync(temporary, store.file)
}

export function createRoom(store, options = {}) {
  const code = options.code ?? roomCode(options.random)
  // Silently replacing a live room would drop everyone seated in it.
  if (store.rooms.has(code)) fail(`Room ${code} already exists`)
  const room = {
    code,
    lastActivityAt: Date.now(),
    phase: 'lobby',
    ascension: 0,
    chooseYourRelic: false,
    lastStand: false,
    metaOptions: { mode: 'standard', modifiers: [], quickStartAct: 1 },
    seats: [],
    run: null,
    campaignProgress: options.campaignProgress ?? createCampaignProgress(),
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
    if (returning.pendingCatchUp && connected) {
      const next = beginCatchUp(room.run, [{ id: returning.playerId, name: nextName, character: returning.character }])
      if (next === room.run) fail('That player cannot Catch Up now')
      room.run = next
      delete returning.pendingCatchUp
      delete returning.reservedAt
    }
    returning.connected = connected
    returning.name = nextName
    room.version += 1
    // They may be the last answer the table was waiting on, or the first one
    // back to a decision that stalled while nobody was connected.
    if (connectionChanged && !activeGiveUpVote(room)) {
      settleMerchantReady(room)
      settleCampfire(room)
      if (room.run?.phase !== 'neow') settlePendingRelics(room)
      settleReward(room)
      settleEndTurn(room)
      settleDiscard(room)
    }
    return returning
  }

  const catchingUp = room.phase === 'run' && room.run?.act >= 2 &&
    (room.run.phase === 'map' && room.run.map.position === null ||
      room.run.phase === 'neow' && room.run.setup?.kind === 'catch-up')
  if (room.phase !== 'lobby' && !catchingUp) fail('New players may join only at the start of an Act')
  if (catchingUp && hasPendingRelicAcquisition(room.run)) fail('Finish the pending Relic acquisition first')
  if (catchingUp && room.seats.some((seat) => seat.pendingCatchUp)) fail('Another player is already joining to Catch Up')
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
    ...(catchingUp && !connected ? { pendingCatchUp: true, reservedAt: Date.now() } : {}),
  }
  room.seats.push(seat)
  if (catchingUp && connected) {
    const next = beginCatchUp(room.run, [{ id: seat.playerId, name: seat.name, character: seat.character }])
    if (next === room.run) {
      room.seats.pop()
      fail('That player cannot Catch Up now')
    }
    room.run = next
  }
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
  if (!Number.isInteger(ascension) || ascension < 0 || ascension > room.campaignProgress.highestAscension) {
    fail(`Ascension must be an unlocked integer from 0 to ${room.campaignProgress.highestAscension}`)
  }
  if (room.ascension === ascension) return snapshotFor(room, seatToken)
  room.ascension = ascension
  room.version += 1
  return snapshotFor(room, seatToken)
}

export function chooseRelicRule(room, seatToken, enabled) {
  findSeat(room, seatToken) ?? fail('Unknown seat')
  if (room.phase !== 'lobby') fail('Choose Your Relic is locked once the run starts')
  if (typeof enabled !== 'boolean') fail('Choose Your Relic must be on or off')
  if (enabled && room.seats.length < 2) fail('Choose Your Relic is multiplayer only')
  if (room.chooseYourRelic === enabled) return snapshotFor(room, seatToken)
  room.chooseYourRelic = enabled
  room.version += 1
  return snapshotFor(room, seatToken)
}

export function chooseLastStandRule(room, seatToken, enabled) {
  const seat = findSeat(room, seatToken) ?? fail('Unknown seat')
  if (room.phase !== 'lobby') fail('The Last Stand is locked once the run starts')
  if (seat !== room.seats[0]) fail('Only the party leader may change The Last Stand')
  if (typeof enabled !== 'boolean') fail('The Last Stand must be on or off')
  if (enabled && room.seats.length < 2) fail('The Last Stand is multiplayer only')
  if (room.lastStand === enabled) return snapshotFor(room, seatToken)
  room.lastStand = enabled
  room.version += 1
  return snapshotFor(room, seatToken)
}

export function chooseRunMeta(room, seatToken, options) {
  const seat = findSeat(room, seatToken) ?? fail('Unknown seat')
  if (room.phase !== 'lobby') fail('Run mode is locked once the run starts')
  if (seat !== room.seats[0]) fail('Only the party leader may change the run mode')
  const mode = options?.mode
  const quickStartAct = options?.quickStartAct
  if (!['standard', 'daily', 'custom'].includes(mode) || ![1, 2, 3, 4].includes(quickStartAct)) fail('Choose a valid run mode and starting Act')
  if (quickStartAct === 4 && room.campaignProgress.actIV < 5) fail('Act IV Quick Start is not unlocked')
  room.metaOptions = { mode, modifiers: mode === 'custom' ? normalizeModifierIds(options.modifiers) : [], quickStartAct }
  room.version += 1
  return snapshotFor(room, seatToken)
}

export function removeSeat(room, seatToken) {
  const seat = findSeat(room, seatToken) ?? fail('Unknown seat')
  if (room.phase !== 'lobby' && !seat.pendingCatchUp) fail('A run seat must be preserved for reconnection')
  room.seats = room.seats.filter((candidate) => candidate !== seat)
  if (room.seats.length < 2) {
    room.chooseYourRelic = false
    room.lastStand = false
  }
  room.version += 1
}

export function markDisconnected(room, seatToken) {
  const seat = findSeat(room, seatToken)
  if (!seat) return snapshotFor(room, seatToken)
  seat.connected = false
  room.version += 1
  const voting = activeGiveUpVote(room)
  cancelImpossibleDisconnectedPledges(room, Boolean(voting))
  if (voting) return snapshotFor(room, seatToken)
  settleMerchantReady(room)
  // The party may have been waiting on exactly this player. Dropping without
  // re-checking stranded the campfire: `leaveRoom` stays refused, and the room
  // only unstuck if someone re-sent a choice they had already made.
  settleCampfire(room)
  // Neow is pre-game setup, not a shared combat/reward wait. Its private
  // Relic choices must survive a disconnect exactly like its card choices.
  if (room.run?.phase !== 'neow') settlePendingRelics(room)
  settleDisconnectedRewards(room)
  settleReward(room)
  settleEndTurn(room)
  settleDiscard(room)
  settleForcedCards(room)
  return snapshotFor(room, seatToken)
}

/** Skip every disconnected seat's public reward stages deterministically. */
function settleDisconnectedRewards(room) {
  for (const seat of room.seats.filter((candidate) => candidate.connected === false)) {
    for (;;) {
      const run = room.run
      const offer = run?.phase === 'reward'
        ? run.rewards.find((candidate) => candidate.playerId === seat.playerId)
        : undefined
      if (!run || !offer) break
      const next = offer.gold
        ? resolveGoldReward(run, seat.playerId)
        : offer.transformReward
        ? resolveTransformReward(run, seat.playerId, null)
        : offer.potion !== false
        ? resolvePotionReward(run, seat.playerId, { kind: 'skip' })
        : (offer.relic ?? false) !== false
          ? resolveRelicReward(run, seat.playerId, false)
          : (offer.bossRelics ?? false) !== false
            ? resolveBossRelicReward(run, seat.playerId, null)
            : run
      if (next === run) break
      room.run = next
      room.version += 1
    }
    const offer = room.run?.phase === 'reward'
      ? room.run.rewards.find((candidate) => candidate.playerId === seat.playerId)
      : undefined
    if (offer?.cardReward) {
      room.rewardChoices = { ...room.rewardChoices, [seat.playerId]: null }
      room.rewardConfirmed = { ...room.rewardConfirmed, [seat.playerId]: true }
    }
  }
}

/** Resolve disconnected owners' private acquisition choices with stable defaults. */
function settlePendingRelics(room) {
  if (!Array.isArray(room.run?.players)) return
  for (const seat of room.seats) {
    if (seat.connected !== false) continue
    for (;;) {
      const pending = room.run && pendingRelicPreview(room.run, seat.playerId)
      const player = room.run?.players.find((candidate) => candidate.id === seat.playerId)
      if (!pending || !player) break
      const count = {
        war_paint: 1,
        whetstone: 1,
        astrolabe: 3,
        empty_cage: 2,
        pandoras_box: 3,
        tiny_house: 1,
      }[pending.relicId] ?? 0
      const eligible = pendingRelicEligibleCards(player, pending.relicId)
      const resolvedCount = Math.min(count, eligible.length)
      const next = resolvePendingRelic(
        room.run,
        seat.playerId,
        eligible.slice(0, resolvedCount).map((card) => card.uid),
        (pending.rewardChoices ?? []).map((choices) => choices.length > 0 ? 0 : -1),
      )
      if (next === room.run) break
      room.run = next
    }
  }
}

function settleForcedCards(room, consumedPreviewPlayerId = null) {
  while (room.run?.pendingGuardianSockets?.length > 0) {
    const pending = room.run.pendingGuardianSockets[0]
    const owner = room.seats.find((seat) => seat.playerId === pending.playerId)
    if (owner?.connected !== false) break
    const next = abandonGuardianSocket(room.run, pending.playerId)
    if (next === room.run) break
    room.run = next
  }
  let prepared = room.run?.roomState?.kind === 'event' ? room.run.roomState.preparedCombat : undefined
  while (prepared?.pendingHermitSetupLoads?.length > 0) {
    const pending = prepared.pendingHermitSetupLoads[0]
    const owner = room.seats.find((seat) => seat.playerId === pending.playerId)
    if (owner?.connected !== false) break
    const player = prepared.players.find((candidate) => candidate.id === pending.playerId)
    const next = player?.hand[0]
      ? resolveHermitSetupLoad(prepared, pending.playerId, player.hand[0].uid,
        prepared.enemies.find((enemy) => !enemy.dead)?.uid ?? null, true)
      : prepared
    const resolved = next === prepared ? abandonHermitSetupLoad(prepared, pending.playerId, true) : next
    if (resolved === prepared) break
    room.run = { ...room.run, roomState: { ...room.run.roomState, preparedCombat: resolved } }
    prepared = resolved
  }
  for (let preview = prepared ? startTurnScryPreview(prepared) : undefined; preview;) {
    const owner = room.seats.find((seat) => seat.playerId === preview.playerId)
    if (owner?.connected !== false) break
    const next = resolveStartTurnScry(prepared, preview.playerId, preview.id, [])
    if (next === prepared) break
    room.run = { ...room.run, roomState: { ...room.run.roomState, preparedCombat: next } }
    prepared = next
    preview = startTurnScryPreview(prepared)
  }
  let combat = room.run?.combat
  settleDisconnectedStartTurnChoices(room)
  for (const [playerId, preview] of Object.entries(room.powerPreviews ?? {})) {
    const owner = room.seats.find((seat) => seat.playerId === playerId)
    if (owner?.connected !== false || !combat) continue
    const next = activatePower(combat, playerId, preview.powerUid, { scryDiscardUids: [] })
    if (next !== combat) {
      combat = next
      room.run = { ...room.run, combat: next }
    }
    room.powerPreviews = { ...room.powerPreviews }
    delete room.powerPreviews[playerId]
  }
  for (;;) {
    let settled = false
    while (combat?.pendingPlunderSwitches?.length > 0) {
      const pending = combat.pendingPlunderSwitches[0]
      const owner = room.seats.find((seat) => seat.playerId === pending.playerId)
      if (owner?.connected !== false) break
      const next = resolvePlunderRowSwitch(combat, pending.playerId, null)
      if (next === combat) break
      room.run = { ...room.run, combat: next }
      combat = next
      settled = true
    }
    while (combat?.pendingDieRelicChoices?.length > 0) {
      const pending = combat.pendingDieRelicChoices[0]
      const owner = room.seats.find((seat) => seat.playerId === pending.playerId)
      if (owner?.connected !== false) break
      const next = defaultPendingDieRelicChoice(combat, pending.playerId)
      if (next === combat) break
      room.run = { ...room.run, combat: next }
      combat = next
      settled = true
    }
    while (combat?.pendingTriggers?.length > 0 && !combat.pendingDieRelicChoices?.length) {
      const pending = pendingTriggerAbility(combat)
      const owner = room.seats.find((seat) => seat.playerId === pending?.playerId)
      if (!pending || owner?.connected !== false) break
      const slimeUids = pending.slimeChoice?.minimum === 0 ? []
        : pending.slimeChoice?.cards.slice(0, pending.slimeChoice.amount).map((card) => card.uid) ?? []
      const slimeEnemyAmount = pendingTriggerSlimeEnemyChoiceCount(combat, pending.id, slimeUids)
      const fallbackEnemyUid = combat.enemies.find((enemy) => !enemy.dead)?.uid
      const next = resolvePendingTrigger(
        combat, pending.playerId, pending.id, pending.rows?.[0]?.row, pending.targets?.[0]?.uid,
        pending.players?.[0]?.id,
        pending.hermitChoices ? {
          loadUids: pending.hermitChoices.loadCards.slice(0, 1).map((card) => card.uid),
          chamberUids: pending.hermitChoices.chamberCards.slice(0, 1).map((card) => card.uid),
          hermitEnemyUids: pending.targets?.[0] ? [pending.targets[0].uid] : [],
        } : pending.slimeChoice ? {
          slimeUids,
          slimeEnemyUids: fallbackEnemyUid ? Array(slimeEnemyAmount).fill(fallbackEnemyUid) : [],
        } : slimeEnemyAmount > 0 ? {
          slimeEnemyUids: fallbackEnemyUid ? Array(slimeEnemyAmount).fill(fallbackEnemyUid) : [],
        } : undefined,
      )
      if (next === combat) break
      room.run = { ...room.run, combat: next }
      combat = next
      settled = true
    }
    while (combat?.pendingHermitSetupLoads?.length > 0) {
      const pending = combat.pendingHermitSetupLoads[0]
      const owner = room.seats.find((seat) => seat.playerId === pending.playerId)
      if (owner?.connected !== false) break
      const player = combat.players.find((candidate) => candidate.id === pending.playerId)
      const next = player?.hand[0]
        ? resolveHermitSetupLoad(combat, pending.playerId, player.hand[0].uid,
          combat.enemies.find((enemy) => !enemy.dead)?.uid ?? null)
        : combat
      const resolved = next === combat ? abandonHermitSetupLoad(combat, pending.playerId) : next
      if (resolved === combat) break
      room.run = { ...room.run, combat: resolved }
      combat = resolved
      settled = true
    }
    while (combat?.pendingHermitChamberPlays?.length > 0) {
      const pending = combat.pendingHermitChamberPlays[0]
      const owner = room.seats.find((seat) => seat.playerId === pending.playerId)
      if (owner?.connected !== false) break
      const preview = room.cardPreviews?.[pending.playerId]
      if (pending.playerId !== consumedPreviewPlayerId &&
        preview?.chamber === true && preview.cardUid === pending.cardUids[0]) {
        if (!resolveAbandonedPreviews(room)) break
        combat = room.run?.combat
        settled = true
        continue
      }
      const next = playHermitChamberCard(combat, pending.playerId, pending.cardUids[0], {
        enemyUid: combat.enemies.find((enemy) => !enemy.dead)?.uid ?? null,
        playerId: pending.playerId,
      })
      const resolved = next === combat ? abandonHermitChamberPlay(combat, pending.playerId) : next
      if (resolved === combat) break
      room.run = { ...room.run, combat: resolved }
      combat = resolved
      settled = true
    }
    while (combat?.pendingHermitStrengthRewards?.length > 0) {
      const pending = combat.pendingHermitStrengthRewards[0]
      const owner = room.seats.find((seat) => seat.playerId === pending.playerId)
      if (owner?.connected !== false) break
      const target = combat.players.find((player) => !player.dead)
      if (!target) break
      const next = resolveHermitStrengthReward(combat, pending.playerId, target.id)
      if (next === combat) break
      room.run = { ...room.run, combat: next }
      combat = next
      settled = true
    }
    while (combat?.phase === 'start') {
      const discard = startTurnDiscardPreview(combat)
      const owner = room.seats.find((seat) => seat.playerId === discard?.playerId)
      if (!discard || owner?.connected !== false) break
      const next = resolveStartTurnDiscard(combat, discard.playerId, discard.sourceId, discard.cards[0]?.uid)
      if (next === combat) break
      room.run = { ...room.run, combat: next }
      combat = next
      settled = true
    }
    while (combat?.phase === 'start') {
      const preview = startTurnScryPreview(combat)
      const owner = room.seats.find((seat) => seat.playerId === preview?.playerId)
      if (!preview || owner?.connected !== false) break
      const next = resolveStartTurnScry(combat, preview.playerId, preview.id, [])
      if (next === combat) break
      room.run = { ...room.run, combat: next }
      combat = next
      settled = true
    }
    while (combat?.phase === 'copy' && combat.pendingCardCopy) {
      const ownerId = combat.pendingCardCopy.playerId
      const owner = room.seats.find((seat) => seat.playerId === ownerId)
      if (owner?.connected !== false) break
      const preview = room.cardPreviews?.[ownerId]
      if (ownerId !== consumedPreviewPlayerId &&
        preview?.copy === true && preview.cardUid === combat.pendingCardCopy.card.uid) {
        if (!resolveAbandonedPreviews(room)) break
        combat = room.run?.combat
        settled = true
        continue
      }
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
    while (combat?.phase === 'player' && combat.pendingDistilled && !combat.startTurnProgress?.forcedCard) {
      const ownerId = combat.pendingDistilled.playerId
      const owner = room.seats.find((seat) => seat.playerId === ownerId)
      if (owner?.connected !== false) break
      const next = chooseDistilledCard(combat, ownerId, combat.pendingDistilled.cards[0]?.uid)
      if (next === combat) break
      room.run = { ...room.run, combat: next }
      combat = next
      settled = true
    }
    while (combat?.pendingRelicScry) {
      const pending = combat.pendingRelicScry
      const owner = room.seats.find((seat) => seat.playerId === pending.playerId)
      if (owner?.connected !== false) break
      const next = activateRelic(combat, pending.playerId, pending.relicIndex, { scryDiscardUids: [] })
      if (next === combat) break
      room.run = { ...room.run, combat: next }
      combat = next
      settled = true
    }
    while ((combat?.phase === 'start' || combat?.phase === 'player' || combat?.phase === 'discard') &&
      combat.startTurnProgress?.forcedCard) {
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

function settleDisconnectedStartTurnChoices(room) {
  const combat = room.run?.combat
  if (combat?.phase !== 'start') return
  const stored = new Map((savedStartTurnChoices(room) ?? []).map((choice) => [choice.id, choice]))
  const hasMissing = () => plannedStartTurnAbilities(room).some((ability) =>
    (ability.exhaustCards?.length ?? 0) > 0 && !stored.has(ability.id) &&
    room.seats.find((seat) => seat.playerId === ability.playerId)?.connected === false)
  if (!hasMissing()) return
  room.startTurnCombatId = combat.combatId
  room.startTurnOrder ??= startTurnAbilities(combat).map((ability) => ability.id)
  while (true) {
    const ability = plannedStartTurnAbilities(room).find((candidate) =>
      (candidate.exhaustCards?.length ?? 0) > 0 && !stored.has(candidate.id) &&
      room.seats.find((seat) => seat.playerId === candidate.playerId)?.connected === false)
    if (!ability) break
    stored.set(ability.id, {
      id: ability.id,
      enemyUid: ability.targets?.[0]?.uid,
      targetPlayerId: ability.players?.[0]?.id,
      exhaustUids: [ability.exhaustCards[0].uid],
      shivEnemyUids: Array(ability.overflowShivs).fill(null),
      evokeSlots: [],
      evokeEnemyUids: [],
    })
    room.startTurnChoices = [...stored.values()]
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
export function startRun(room, seatToken, { seed } = {}) {
  const seat = findSeat(room, seatToken) ?? fail('Claim a seat before starting')
  if (seat !== room.seats[0]) fail('Only the party leader may start the run')
  if (room.phase !== 'lobby') fail('The run has already started')
  if (room.seats.length === 0) fail('Nobody has claimed a seat')

  const party = room.seats.map((seat) => ({
    id: seat.playerId,
    name: seat.name,
    character: seat.character,
  }))
  if (!Number.isInteger(room.ascension) || room.ascension < 0 || room.ascension > room.campaignProgress.highestAscension) {
    fail('That Ascension is not unlocked')
  }
  room.run = createRun(seed ?? Number(BigInt('0x' + randomBytes(4).toString('hex'))), party, room.ascension, room.campaignProgress, room.chooseYourRelic && party.length > 1, room.lastStand && party.length > 1, room.metaOptions)
  room.phase = 'run'
  room.version += 1
  return snapshotFor(room, seatToken)
}

function neowRewardChoice(action) {
  const choice = action.choice
  if (choice === null || Number.isInteger(choice)) return choice
  if (!choice || typeof choice !== 'object' || Array.isArray(choice)) fail('Choose a valid Neow reward')
  if (choice.kind === 'gain' || choice.kind === 'skip') {
    if (Object.keys(choice).some((key) => key !== 'kind')) fail('Choose a valid Neow reward')
    return { kind: choice.kind }
  }
  if (choice.kind === 'pass' && typeof choice.playerId === 'string' &&
    Object.keys(choice).every((key) => key === 'kind' || key === 'playerId')) {
    return { kind: 'pass', playerId: choice.playerId }
  }
  if (choice.kind === 'replace' && typeof choice.potionId === 'string' &&
    Object.keys(choice).every((key) => key === 'kind' || key === 'potionId')) {
    return { kind: 'replace', potionId: choice.potionId }
  }
  fail('Choose a valid Neow reward')
}

function activeGiveUpVote(room, now = Date.now()) {
  const vote = room.giveUpVote
  return room.run && canGiveUpRun(room.run, room.run.campaignProgress) &&
    vote && vote.runId === room.run.campaign.runId && vote.deadlineAt > now
    ? { ...vote, eligiblePlayerIds: room.run.players.map((player) => player.id) }
    : undefined
}

function finishGiveUp(room) {
  room.run = giveUpRun(room.run)
  room.giveUpVote = undefined
  room.courierPledge = undefined
  room.cardPreviews = undefined
  room.powerPreviews = undefined
  room.endTurnReady = undefined
  room.campfireChoices = undefined
  room.rewardChoices = undefined
  room.rewardConfirmed = undefined
  room.merchantPledges = undefined
  room.merchantReady = undefined
  room.eventPledge = undefined
  room.seats = room.seats.filter((seat) => !seat.pendingCatchUp)
  clearEndTurnOrdering(room)
  clearStartTurnPlan(room)
}

function applyGiveUpVote(room, seat, action, seatToken) {
  const run = room.run
  if (!run || !canGiveUpRun(run, run.campaignProgress)) {
    fail('There is no active run to give up')
  }
  const eligiblePlayerIds = run.players.map((player) => player.id)
  if (!eligiblePlayerIds.includes(seat.playerId)) fail('Only active run players can vote to give up')
  const current = activeGiveUpVote(room)
  if (action.vote === 'start') {
    if (Object.keys(action).some((key) => key !== 'kind' && key !== 'vote')) fail('Invalid give-up vote')
    if (current) return { changed: false, snapshot: snapshotFor(room, seatToken) }
    if (eligiblePlayerIds.length === 1) {
      finishGiveUp(room)
    } else {
      room.giveUpVote = {
        runId: run.campaign.runId,
        deadlineAt: Date.now() + GIVE_UP_TIMEOUT_MS,
        eligiblePlayerIds,
        votes: {},
      }
    }
  } else {
    if ((action.vote !== 'yes' && action.vote !== 'no') ||
      Object.keys(action).some((key) => !['kind', 'vote', 'deadlineAt'].includes(key)) ||
      !Number.isSafeInteger(action.deadlineAt) || current?.deadlineAt !== action.deadlineAt) {
      fail('That give-up vote has expired')
    }
    const votes = { ...current.votes, [seat.playerId]: action.vote === 'yes' }
    if (eligiblePlayerIds.every((playerId) => votes[playerId] === true)) {
      finishGiveUp(room)
    } else room.giveUpVote = { ...current, eligiblePlayerIds, votes }
  }
  room.version += 1
  return { changed: true, snapshot: snapshotFor(room, seatToken) }
}

/** One authenticated action covers Neow's red reward, blue option, and queued rewards. */
function neowAction(room, seat, action, seatToken) {
  if (action.playerId !== undefined) fail('Neow choices are bound to your seat')
  const preview = neowPreview(room.run, seat.playerId)
  if (!preview || preview.done) fail('This seat has no pending Neow choice')
  let next
  if (action.stage === 'redGold') {
    if (Object.keys(action).some((key) => !['kind', 'stage', 'gain'].includes(key)) || typeof action.gain !== 'boolean') fail('Choose a valid Neow Gold reward')
    if (!preview.redGoldPending) fail('The red Neow Gold is no longer pending')
    next = resolveNeowGold(room.run, seat.playerId, action.gain)
  } else if (action.stage === 'reveal') {
    const sources = action.sources
    if (Object.keys(action).some((key) => !['kind', 'stage', 'sources'].includes(key)) || sources !== undefined && (
      !Array.isArray(sources) || sources.length !== 3 || new Set(sources).size !== sources.length ||
      sources.some((source) => typeof source !== 'string' || !preview.availableSources.includes(source))
    )) fail('Choose a valid Neow reveal')
    if (!preview.redRewardPending && !preview.rewardKind) fail('No Neow reward is waiting to be revealed')
    next = revealNeowReward(room.run, seat.playerId, sources)
  } else if (action.stage === 'red') {
    if (!preview.redRewardPending) fail('The red Neow reward is no longer pending')
    next = resolveNeowReward(room.run, seat.playerId, neowRewardChoice(action))
  } else if (action.stage === 'option') {
    if (preview.redGoldPending || preview.redRewardPending || preview.blueOption !== null || preview.pendingEffect || preview.rewardKind) fail('The blue Neow option is not pending')
    if (!Number.isInteger(action.optionIndex) || action.cardUids !== undefined &&
      (!Array.isArray(action.cardUids) || action.cardUids.some((uid) => typeof uid !== 'string'))) {
      fail('Choose a valid Neow option')
    }
    next = chooseNeow(room.run, seat.playerId, action.optionIndex, { cardUids: action.cardUids ?? [] })
  } else if (action.stage === 'effect') {
    if (!preview.pendingEffect || typeof action.gain !== 'boolean' || action.cardUids !== undefined &&
      (!Array.isArray(action.cardUids) || action.cardUids.some((uid) => typeof uid !== 'string')) ||
      Object.keys(action).some((key) => !['kind', 'stage', 'gain', 'cardUids'].includes(key))) fail('Choose a valid Neow immediate reward')
    next = resolveNeowEffect(room.run, seat.playerId, action.gain, { cardUids: action.cardUids ?? [] })
  } else if (action.stage === 'reward') {
    if (!preview.rewardKind) fail('No blue Neow reward is pending')
    next = resolveNeowReward(room.run, seat.playerId, neowRewardChoice(action))
  } else fail('Choose the current Neow stage')
  if (next === room.run) fail('That Neow choice is not legal')
  if (next.phase !== 'neow') room.seats = room.seats.filter((candidate) => !candidate.pendingCatchUp)
  room.run = next
  room.version += 1
  return { changed: true, snapshot: snapshotFor(room, seatToken) }
}

function previewSlimeChoices(combat, action, def, player, effectEnergy, charged, playedCard) {
  const slimeUids = uidList(action.slimeUids) ?? []
  const slimeEnemyUids = uidList(action.slimeEnemyUids) ?? []
  if (action.slimeUids !== undefined && (!Array.isArray(action.slimeUids) ||
    slimeUids.length !== action.slimeUids.length) ||
    action.slimeEnemyUids !== undefined && (!Array.isArray(action.slimeEnemyUids) ||
      slimeEnemyUids.length !== action.slimeEnemyUids.length)) {
    fail('Slime preview choices must be lists of ids')
  }
  const count = def && player
    ? slimeCommandEnemyChoiceCount(def, combat, player, slimeUids, effectEnergy, charged,
      playedCard)
    : 0
  if (slimeEnemyUids.length !== count || slimeEnemyUids.some((uid) =>
    !combat.enemies.some((enemy) => enemy.uid === uid && !enemy.dead))) {
    fail('Choose every Slime Command target before revealing this card')
  }
  return { slimeUids, slimeEnemyUids }
}

/**
 * Applies a game action on behalf of a seat.
 *
 * The engine signals an illegal action by returning the SAME state reference,
 * which is preserved here: an action that changes nothing does not bump the
 * version, so it never wakes the other clients.
 */
export function apply(room, seatToken, action, consumedPreviewPlayerId = null) {
  const seat = findSeat(room, seatToken) ?? fail('Unknown seat')
  if (room.phase !== 'run' || !room.run) fail('The run has not started')
  if (action?.kind === 'giveUpVote') return applyGiveUpVote(room, seat, action, seatToken)
  if (activeGiveUpVote(room)) fail('Resolve the give-up vote first')
  const pendingCatchUp = room.seats.filter((candidate) => candidate.pendingCatchUp)
  const cancelsPendingCatchUp = pendingCatchUp.length > 0 && seat === room.seats[0] && action?.kind === 'enterRoom'
  if (pendingCatchUp.length > 0 && room.run.phase !== 'neow') {
    if (!cancelsPendingCatchUp) {
      fail('Wait for the new player to connect and Catch Up')
    }
  }
  const preparedCombat = room.run.roomState?.kind === 'event' ? room.run.roomState.preparedCombat : undefined
  const preparedSetup = preparedCombat?.pendingHermitSetupLoads?.[0]
  if (preparedSetup) {
    if (action?.kind !== 'resolveHermitSetupLoad') {
      fail(preparedSetup.playerId === seat.playerId
        ? 'Finish the Hermit setup choice' : 'Wait for the Hermit setup owner')
    }
    if (preparedSetup.playerId !== seat.playerId || typeof action.cardUid !== 'string') {
      fail('That Hermit setup choice is not yours')
    }
    const next = resolveHermitSetupLoad(preparedCombat, seat.playerId, action.cardUid,
      typeof action.enemyUid === 'string' ? action.enemyUid : null, true)
    if (next === preparedCombat) fail('That Hermit setup Load is no longer legal')
    room.run = { ...room.run, roomState: { ...room.run.roomState, preparedCombat: next } }
    settleForcedCards(room)
    room.version += 1
    return { changed: true, snapshot: snapshotFor(room, seatToken) }
  }
  const preparedScryAbilities = preparedCombat ? startTurnScryAbilities(preparedCombat) : []
  const preparedScry = preparedCombat ? startTurnScryPreview(preparedCombat) : undefined
  if (preparedScryAbilities.length > 0) {
    const coordinator = room.seats.find((candidate) => candidate.connected !== false &&
      preparedCombat.players.some((player) => player.id === candidate.playerId && !player.dead))?.playerId
    if (action?.kind !== 'orderStartTurnScries') {
      fail(seat.playerId === coordinator ? 'Order the prepared pre-draw Scries' : 'Wait for the Scry coordinator')
    }
    if (seat.playerId !== coordinator || !Array.isArray(action.order) || action.order.length > UID_LIMIT ||
      action.order.some((id) => typeof id !== 'string')) fail('That prepared Scry order is not legal')
    const next = orderStartTurnScries(preparedCombat, action.order)
    if (next === preparedCombat) fail('The prepared Scry order is stale')
    room.run = { ...room.run, roomState: { ...room.run.roomState, preparedCombat: next } }
    settleForcedCards(room)
    room.version += 1
    return { changed: true, snapshot: snapshotFor(room, seatToken) }
  }
  if (preparedScry) {
    if (action?.kind !== 'resolveStartTurnScry') {
      fail(preparedScry.playerId === seat.playerId ? 'Finish the prepared pre-draw Scry' : 'Wait for the Scry owner')
    }
    if (preparedScry.playerId !== seat.playerId || action.sourceId !== preparedScry.id ||
      !Array.isArray(action.discardUids) || action.discardUids.length > preparedScry.amount ||
      action.discardUids.some((uid) => typeof uid !== 'string')) fail('That prepared Scry choice is not legal')
    const next = resolveStartTurnScry(preparedCombat, seat.playerId, action.sourceId, action.discardUids)
    if (next === preparedCombat) fail('The prepared Scry choice is stale')
    room.run = { ...room.run, roomState: { ...room.run.roomState, preparedCombat: next } }
    settleForcedCards(room)
    room.version += 1
    return { changed: true, snapshot: snapshotFor(room, seatToken) }
  }
  if (preparedCombat?.startTurnProgress && !preparedCombat.startTurnProgress.pauseAfterDraw) {
    fail('Finish the prepared opening-hand step')
  }
  if (room.run.phase === 'neow') {
    if (action?.kind === 'neow') return neowAction(room, seat, action, seatToken)
    if (action?.kind !== 'resolvePendingRelic' && action?.kind !== 'resolveGuardianSocket') {
      fail('Finish Neow before entering the Spire')
    }
  }
  // War Paint and Whetstone bought from The Courier are kept face up because
  // their text forbids resolving them in combat. Combat must continue until
  // the acquisition becomes legal outside combat.
  if (room.run.phase !== 'combat' && hasPendingRelicAcquisition(room.run) &&
    action?.kind !== 'resolvePendingRelic' && action?.kind !== 'resolveGuardianSocket') {
    fail('Finish the pending Relic acquisition first')
  }
  const pendingGuardianSocket = room.run.pendingGuardianSockets?.[0]
  if (pendingGuardianSocket) {
    if (action?.kind !== 'resolveGuardianSocket') {
      fail(pendingGuardianSocket.playerId === seat.playerId
        ? 'Finish choosing a Guardian gem' : 'Wait for the Guardian gem choice')
    }
    if (pendingGuardianSocket.playerId !== seat.playerId || typeof action.gemId !== 'string') {
      fail('That Guardian gem choice is not yours')
    }
    const next = resolveGuardianSocket(room.run, seat.playerId, action.gemId)
    if (next === room.run) fail('That Guardian gem choice is no longer legal')
    room.run = next
    settleForcedCards(room)
    room.version += 1
    return { changed: true, snapshot: snapshotFor(room, seatToken) }
  }
  const staged = room.cardPreviews?.[seat.playerId]
  const stagedPower = room.powerPreviews?.[seat.playerId]
  const player = room.run.combat?.players.find((candidate) => candidate.id === seat.playerId)
  const forcedCard = room.run.combat?.startTurnProgress?.forcedCard
  const pendingCopy = room.run.combat?.pendingCardCopy
  const pendingDistilled = room.run.combat?.pendingDistilled
  const copyForSeat = pendingCopy?.playerId === seat.playerId
  const forcedForSeat = (room.run.combat?.phase === 'start' || room.run.combat?.phase === 'player' ||
    room.run.combat?.phase === 'discard') &&
    forcedCard?.playerId === seat.playerId &&
    typeof forcedCard.cardUid === 'string'
  const stagedCopyStillWaiting = staged?.copy === true && copyForSeat && pendingCopy.card.uid === staged.cardUid
  const stagedChamberStillWaiting = staged?.chamber === true &&
    player?.chamber.some((card) => card.uid === staged.cardUid) && room.run.combat?.phase === 'player'
  const stagedCardStillWaiting = player?.hand.some((card) => card.uid === staged?.cardUid) &&
    (room.run.combat?.phase === 'player' || (forcedForSeat && forcedCard.cardUid === staged?.cardUid))
  if (staged && !stagedCopyStillWaiting && !stagedChamberStillWaiting && !stagedCardStillWaiting) {
    room.cardPreviews = { ...room.cardPreviews }
    delete room.cardPreviews[seat.playerId]
  }
  const locked = room.cardPreviews?.[seat.playerId]
  if (stagedPower && !((action?.kind === 'previewPowerChoice' || action?.kind === 'activatePower') &&
    action.powerUid === stagedPower.powerUid)) fail('Finish the revealed Power before taking another action')
  if (locked && !(
    ((locked.copy === true && (action?.kind === 'previewCardCopy' || action?.kind === 'playCardCopy')) ||
      (locked.chamber === true && (action?.kind === 'previewHermitChamberCard' || action?.kind === 'playHermitChamberCard')) ||
      (locked.copy !== true && locked.chamber !== true && (action?.kind === 'previewCard' || action?.kind === 'playCard'))) &&
      action.cardUid === locked.cardUid
  )) fail('Finish the revealed card before taking another action')
  const foreignLocks = [...Object.keys(room.cardPreviews ?? {}), ...Object.keys(room.powerPreviews ?? {})]
    .filter((playerId) => playerId !== seat.playerId)
  if (foreignLocks.length > 0 && !(
    action?.kind === 'endTurn' && foreignLocks.every((playerId) =>
      room.seats.find((candidate) => candidate.playerId === playerId)?.connected === false)
  )) {
    // ponytail: this global lock avoids alternate shared-RNG reveals; narrow it
    // to RNG-mutating actions only if simultaneous-play latency becomes a problem.
    fail('Wait for the revealed card to finish')
  }
  const pendingTrigger = room.run.combat?.pendingDieRelicChoices?.length
    ? undefined : room.run.combat?.pendingTriggers?.[0]
  if (pendingTrigger) {
    if (action?.kind !== 'resolveTrigger') fail('Finish the triggered ability first')
    if (pendingTrigger.playerId !== seat.playerId) fail('Wait for the triggered ability owner')
    if (!Number.isInteger(action.triggerId)) fail('Triggered ability id must be a whole number')
    if (action.enemyRow !== undefined && !Number.isInteger(action.enemyRow)) {
      fail('Triggered ability row must be a whole number')
    }
    if (action.enemyUid !== undefined && typeof action.enemyUid !== 'string') {
      fail('Triggered ability enemy must be a valid id')
    }
    if (action.targetPlayerId !== undefined && typeof action.targetPlayerId !== 'string') {
      fail('Triggered ability player must be a valid id')
    }
    const slimeUids = uidList(action.slimeUids)
    const slimeEnemyUids = uidList(action.slimeEnemyUids)
    if (action.slimeUids !== undefined && (!Array.isArray(action.slimeUids) ||
      slimeUids.length !== action.slimeUids.length)) fail('Triggered Slime choices must be a list of ids')
    if (action.slimeEnemyUids !== undefined && (!Array.isArray(action.slimeEnemyUids) ||
      slimeEnemyUids.length !== action.slimeEnemyUids.length)) fail('Triggered Slime targets must be a list of ids')
    const combat = room.run.combat
    const next = resolvePendingTrigger(
      combat,
      seat.playerId,
      action.triggerId,
      action.enemyRow,
      action.enemyUid,
      action.targetPlayerId,
      action.hermitChoices === undefined && action.slimeUids === undefined && action.slimeEnemyUids === undefined
        ? undefined : {
        ...(action.hermitChoices === undefined ? {} : {
          loadUids: uidList(action.hermitChoices?.loadUids) ?? [],
          chamberUids: uidList(action.hermitChoices?.chamberUids) ?? [],
          hermitEnemyUids: uidList(action.hermitChoices?.hermitEnemyUids) ?? [],
        }),
        ...(action.slimeUids === undefined ? {} : { slimeUids }),
        ...(action.slimeEnemyUids === undefined ? {} : { slimeEnemyUids }),
      },
    )
    if (next === combat) fail('That triggered ability target is no longer legal')
    room.run = { ...room.run, combat: next }
    settleForcedCards(room)
    clearEndTurnOrdering(room)
    room.version += 1
    publishEndTurnEffect(room)
    return { changed: true, snapshot: snapshotFor(room, seatToken) }
  }
  if (mandatoryChoicePending(room.run.combat)) {
    const combat = room.run.combat
    const pending = combat.pendingDieRelicChoices?.[0]
      ? { choice: combat.pendingDieRelicChoices[0], kinds: ['resolveDieRelicChoice'], label: 'die Relic' }
      : combat.pendingPlunderSwitches?.[0]
      ? { choice: combat.pendingPlunderSwitches[0], kinds: ['resolvePlunderRowSwitch'], label: 'Plunder row' }
      : combat.pendingHermitSetupLoads?.[0]
        ? { choice: combat.pendingHermitSetupLoads[0], kinds: ['resolveHermitSetupLoad'], label: 'Hermit setup' }
        : combat.pendingHermitChamberPlays?.[0]
          ? { choice: combat.pendingHermitChamberPlays[0],
            kinds: ['previewHermitChamberCard', 'playHermitChamberCard'], label: 'Hermit Chamber' }
          : { choice: combat.pendingHermitStrengthRewards[0],
            kinds: ['resolveHermitStrengthReward'], label: 'Hermit reward' }
    if (pending.choice.playerId !== seat.playerId || !pending.kinds.includes(action?.kind)) {
      fail(pending.choice.playerId === seat.playerId
        ? `Finish the ${pending.label} choice` : `Wait for the ${pending.label} choice`)
    }
  }
  if (forcedCard && !(
    forcedForSeat && (action?.kind === 'playCard' || action?.kind === 'previewCard') &&
    action.cardUid === forcedCard.cardUid
  )) fail('Finish the forced card before taking another action')
  if (pendingCopy && !(copyForSeat &&
    (action?.kind === 'previewCardCopy' || action?.kind === 'playCardCopy'))) {
    fail(copyForSeat ? 'Finish resolving the original card' : 'Wait for the original card')
  }
  if (pendingDistilled && !room.run.combat?.startTurnProgress?.forcedCard &&
    !(room.run.combat?.pendingTriggers?.length) && !room.run.combat?.pendingCardCopy &&
    action?.kind !== 'chooseDistilledCard') {
    fail(pendingDistilled.playerId === seat.playerId ? 'Choose the next Distilled Chaos card' : 'Wait for Distilled Chaos')
  }
  const pendingRelicScry = room.run.combat?.pendingRelicScry
  if (pendingRelicScry && action?.kind !== 'activateRelic') {
    fail(pendingRelicScry.playerId === seat.playerId ? 'Finish Golden Eye Scry' : 'Wait for Golden Eye')
  }

  if (action?.kind === 'previewPowerChoice') {
    if (typeof action.powerUid !== 'string') fail('Power preview needs a Power id')
    const preview = previewPowerChoice(room.run.combat, seat.playerId, action.powerUid)
    if (!preview || preview.kind !== 'scry') fail('That Power cannot reveal a choice now')
    room.powerPreviews = { ...room.powerPreviews,
      [seat.playerId]: { powerUid: action.powerUid, ...preview } }
    room.version += 1
    return { changed: true, snapshot: snapshotFor(room, seatToken) }
  }

  if (action?.kind === 'previewHermitChamberCard') {
    if (room.endTurnAbilities) fail('The party is ordering end-of-turn abilities')
    const held = player?.chamber.find((card) => card.uid === action.cardUid)
    const def = held ? faceOf(cardDef(held.defId), held.upgraded) : null
    const required = room.run.combat?.pendingHermitChamberPlays?.[0]
    const free = required?.playerId === seat.playerId && required.cardUids[0] === held?.uid && required.free
    const stagedCard = held ? { ...held, hermitDeadOn: true, ...(free ? { freeThisTurn: true } : {}) } : null
    const stagedPlayer = player && stagedCard ? {
      ...player,
      chamber: player.chamber.filter((card) => card.uid !== stagedCard.uid),
      hand: [...player.hand, stagedCard],
    } : player
    const cost = def && stagedPlayer && stagedCard ? playCost(def, stagedPlayer, stagedCard) : null
    let effectEnergy = 0
    let charged = typeof cost === 'number' ? cost : 0
    if (cost === 'X') {
      if (!Number.isInteger(action.energySpent) || action.energySpent < (def.minimumX ?? 0) ||
        action.energySpent > stagedPlayer.energy) fail('Choose a valid Chamber X cost before revealing this card')
      effectEnergy = action.energySpent
      charged = action.energySpent
    } else if (action.energySpent !== undefined && action.energySpent !== 0) {
      fail('This Chamber card has no X cost')
    } else if (def?.cost === 'X') effectEnergy = charged
    const needsEnemy = def && stagedPlayer ? cardNeedsEnemy(def, stagedPlayer, false, undefined, false,
      stagedCard?.attachedGemId, stagedCard?.uid, typeof cost === 'number' ? cost : undefined) : false
    const enemyUid = needsEnemy ? action.enemyUid : null
    if (needsEnemy && (typeof enemyUid !== 'string' ||
      resolveEnemyTargets(room.run.combat, def.target ?? 'enemy', enemyUid).length === 0)) {
      fail('Choose a living enemy before revealing this Chamber card')
    }
    const { slimeUids, slimeEnemyUids } = previewSlimeChoices(
      room.run.combat, action, def, stagedPlayer, effectEnergy, charged, stagedCard,
    )
    const lockedEnergy = cost === 'X' ? effectEnergy : undefined
    if (locked && (locked.chamber !== true || enemyUid !== locked.enemyUid ||
      lockedEnergy !== locked.energySpent ||
      slimeUids.join('\0') !== (locked.slimeUids ?? []).join('\0') ||
      slimeEnemyUids.join('\0') !== (locked.slimeEnemyUids ?? []).join('\0'))) {
      fail('The revealed Chamber target is already committed')
    }
    const preview = room.run.combat
      ? previewHermitChamberCardChoice(room.run.combat, seat.playerId, action.cardUid)
      : null
    if (!preview) fail('That Chamber card cannot reveal a choice now')
    room.cardPreviews = {
      ...room.cardPreviews,
      [seat.playerId]: {
        cardUid: action.cardUid, chamber: true, spendMiracle: false, enemyUid,
        energySpent: lockedEnergy, slimeUids, slimeEnemyUids, ...preview,
      },
    }
    room.version += 1
    return { changed: true, snapshot: snapshotFor(room, seatToken) }
  }

  if (action?.kind === 'previewCardCopy') {
    if (!copyForSeat) fail('No original card is waiting for you')
    const def = faceOf(cardDef(pendingCopy.card.defId), pendingCopy.card.upgraded)
    const needsEnemy = cardNeedsEnemy(def, player, false, pendingCopy.energySpent)
    const enemyUid = needsEnemy ? action.enemyUid : null
    if (needsEnemy && (typeof enemyUid !== 'string' ||
      resolveEnemyTargets(room.run.combat, def.target ?? 'enemy', enemyUid).length === 0)) {
      fail('Choose a living enemy before revealing the original card')
    }
    const { slimeUids, slimeEnemyUids } = previewSlimeChoices(
      room.run.combat, action, def, player, pendingCopy.energySpent, 0, pendingCopy.card,
    )
    if (locked && (locked.copy !== true || enemyUid !== locked.enemyUid ||
      slimeUids.join('\0') !== (locked.slimeUids ?? []).join('\0') ||
      slimeEnemyUids.join('\0') !== (locked.slimeEnemyUids ?? []).join('\0'))) {
      fail('The revealed original target is already committed')
    }
    const preview = previewCardCopyChoice(room.run.combat, seat.playerId)
    if (!preview) fail('That original card cannot reveal a choice now')
    room.cardPreviews = {
      ...room.cardPreviews,
      [seat.playerId]: {
        cardUid: pendingCopy.card.uid, copy: true, spendMiracle: false, enemyUid,
        slimeUids, slimeEnemyUids, ...preview,
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
    const cost = forcedForSeat && forcedCard.cardUid === action.cardUid ? 0 : def && player ? playCost(def, player, held) : null
    if (spendMiracle && (!def || player.miracles < 1 || player.energy !== CAPS.energy ||
      cost === 'X' || cost === 0)) fail('That Miracle cannot pay for this card')
    if (locked && spendMiracle !== locked.spendMiracle) fail('The revealed card payment is already committed')
    const needsEnemy = def ? cardNeedsEnemy(def, player, false, undefined, false, held?.attachedGemId, held?.uid,
      typeof cost === 'number' ? cost : undefined) : false
    const enemyUid = needsEnemy ? action.enemyUid : null
    if (needsEnemy && (typeof enemyUid !== 'string' ||
      resolveEnemyTargets(room.run.combat, def.target ?? 'enemy', enemyUid).length === 0)) {
      fail('Choose a living enemy before revealing this card')
    }
    if (locked && enemyUid !== locked.enemyUid) fail('The revealed card target is already committed')
    const effectEnergy = def?.cost === 'X' && Number.isInteger(action.energySpent) ? action.energySpent : 0
    const charged = typeof cost === 'number' ? cost : effectEnergy
    const { slimeUids, slimeEnemyUids } = previewSlimeChoices(
      room.run.combat, action, def, player, effectEnergy, charged, held,
    )
    if (locked && (slimeUids.join('\0') !== (locked.slimeUids ?? []).join('\0') ||
      slimeEnemyUids.join('\0') !== (locked.slimeEnemyUids ?? []).join('\0'))) {
      fail('The revealed Slime choices are already committed')
    }
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
      [seat.playerId]: { cardUid: action.cardUid, spendMiracle, enemyUid, slimeUids, slimeEnemyUids, ...preview },
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
      if ((uidList(action.slimeUids) ?? []).join('\0') !== (locked.slimeUids ?? []).join('\0') ||
        (uidList(action.slimeEnemyUids) ?? []).join('\0') !== (locked.slimeEnemyUids ?? []).join('\0')) {
        fail('The final Slime choices do not match their reveal')
      }
      const preview = previewCardChoice(room.run.combat, seat.playerId, action.cardUid)
      if (!preview || preview.kind !== locked.kind || preview.cards.length !== locked.cards.length ||
        preview.cards.some((card, index) => card.uid !== locked.cards[index].uid)) {
        fail('The revealed cards changed; reveal them again')
      }
    }
  }
  if (action?.kind === 'playCardCopy') {
    if (!copyForSeat || action.cardUid !== pendingCopy.card.uid) fail('No matching original card is waiting')
    const def = faceOf(cardDef(pendingCopy.card.defId), pendingCopy.card.upgraded)
    if (cardNeedsChoicePreview(def, room.run.combat, player)) {
      if (!locked || locked.copy !== true || locked.cardUid !== action.cardUid) {
        fail('Reveal this original card before resolving its choice')
      }
      if ((action.enemyUid ?? null) !== locked.enemyUid) fail('The final original target does not match its reveal')
      if ((uidList(action.slimeUids) ?? []).join('\0') !== (locked.slimeUids ?? []).join('\0') ||
        (uidList(action.slimeEnemyUids) ?? []).join('\0') !== (locked.slimeEnemyUids ?? []).join('\0')) {
        fail('The final original Slime choices do not match their reveal')
      }
      const preview = previewCardCopyChoice(room.run.combat, seat.playerId)
      if (!preview || preview.kind !== locked.kind || preview.cards.length !== locked.cards.length ||
        preview.cards.some((card, index) => card.uid !== locked.cards[index].uid)) {
        fail('The revealed original cards changed; reveal them again')
      }
    }
  }
  if (action?.kind === 'playHermitChamberCard') {
    const held = player?.chamber.find((card) => card.uid === action.cardUid)
    const def = held ? faceOf(cardDef(held.defId), held.upgraded) : null
    if (def && cardNeedsChoicePreview(def, room.run.combat, player)) {
      if (!locked || locked.chamber !== true || locked.cardUid !== action.cardUid) {
        fail('Reveal this Chamber card before resolving its choice')
      }
      if ((action.enemyUid ?? null) !== locked.enemyUid) fail('The final Chamber target does not match its reveal')
      if ((action.energySpent ?? undefined) !== locked.energySpent ||
        (uidList(action.slimeUids) ?? []).join('\0') !== (locked.slimeUids ?? []).join('\0') ||
        (uidList(action.slimeEnemyUids) ?? []).join('\0') !== (locked.slimeEnemyUids ?? []).join('\0')) {
        fail('The final Chamber choices do not match their reveal')
      }
      const preview = previewHermitChamberCardChoice(room.run.combat, seat.playerId, action.cardUid)
      if (!preview || preview.kind !== locked.kind || preview.cards.length !== locked.cards.length ||
        preview.cards.some((card, index) => card.uid !== locked.cards[index].uid)) {
        fail('The revealed Chamber cards changed; reveal them again')
      }
    }
  }
  if (action?.kind === 'activatePower') {
    const held = player?.powers.find((power) => power.uid === action.powerUid)
    if (held?.defId === 'guardian_gem_finder') {
      if (!stagedPower || stagedPower.powerUid !== action.powerUid) fail('Reveal Gem Finder before resolving its Scry')
      const preview = previewPowerChoice(room.run.combat, seat.playerId, action.powerUid)
      if (!preview || preview.cards.length !== stagedPower.cards.length ||
        preview.cards.some((card, index) => card.uid !== stagedPower.cards[index].uid)) {
        fail('Gem Finder cards changed; reveal them again')
      }
    }
  }

  if (action?.kind === 'campfire') return campfire(room, seat, action, seatToken)
  if (action?.kind === 'setupStep') return quickSetupStep(room, seat, action, seatToken)
  if (action?.kind === 'finishRun') return finishCampaignRun(room, seatToken)
  if (action?.kind === 'allocateCampaign') return allocateCampaign(room, seat, action, seatToken)
  if (action?.kind === 'returnToLobby') return returnToLobby(room, seat, seatToken)
  if (action?.kind === 'merchantPurchase') return merchantPurchase(room, seat, action, seatToken)
  if (action?.kind === 'merchantRemove') return merchantRemove(room, seat, action, seatToken)
  if (action?.kind === 'merchantWithdraw') return merchantWithdraw(room, seat, action, seatToken)
  if (action?.kind === 'merchantResume') return merchantResume(room, seat, seatToken)
  if (action?.kind === 'merchantFinish') return merchantFinish(room, seat, seatToken)
  if (action?.kind === 'courierReveal') return courierReveal(room, seat, action, seatToken)
  if (action?.kind === 'courierResolve') return courierResolve(room, seat, action, seatToken)
  if (room.run?.courier?.offer) fail('Resolve The Courier offer before continuing combat')
  if (action?.kind === 'relicReward') return relicReward(room, seat, action, seatToken)
  if (action?.kind === 'eventCancel') return cancelEventPledge(room, seat, seatToken)
  if (action?.kind === 'eventSkip') return eventSkip(room, seat, action, seatToken)
  if (action?.kind === 'event') return eventChoice(room, seat, action, seatToken)
  if (action?.kind === 'cardReward') return cardReward(room, seat, action, seatToken)
  if (action?.kind === 'transformReward') return transformReward(room, seat, action, seatToken)
  if (action?.kind === 'endTurn') return endTurn(room, seat, action, seatToken)
  if (action?.kind === 'resolveEndTurnEffect') return resolveEndTurnEffect(room, seat, action, seatToken)
  if (action?.kind === 'orderStartTurnScries') return orderBeforeDrawScries(room, seat, action, seatToken)
  if (action?.kind === 'resolveStartTurnScry') return resolveBeforeDrawScry(room, seat, action, seatToken)
  if (action?.kind === 'resolveStartTurnDiscard') return resolvePrivateStartTurnDiscard(room, seat, action, seatToken)
  if (action?.kind === 'resolveStartTurn') return resolveStartTurn(room, seat, action, seatToken)
  if (action?.kind === 'discardHand') return submitDiscard(room, seat, action, seatToken)
  if (room.endTurnAbilities) fail('The party is ordering end-of-turn abilities')
  if (room.run.combat?.phase === 'start' && !(
    action?.kind === 'activateRelic' ||
    action?.kind === 'usePotion' ||
    action?.kind === 'activatePower' ||
    action?.kind === 'previewPowerChoice' ||
    forcedForSeat && (action?.kind === 'playCard' || action?.kind === 'previewCard') &&
    action.cardUid === forcedCard.cardUid
  )) fail('Finish the Start-of-Turn abilities')

  const before = room.run
  const next = dispatch(before, seat, action)
  if (next === before) return { changed: false, snapshot: snapshotFor(room, seatToken) }

  if (before.phase === 'neow' && next.phase !== 'neow') {
    room.seats = room.seats.filter((candidate) => !candidate.pendingCatchUp)
  }
  if (cancelsPendingCatchUp) room.seats = room.seats.filter((candidate) => !candidate.pendingCatchUp)
  room.run = next
  if (before.combat?.phase === 'start') clearStartTurnPlan(room)
  settleForcedCards(room, consumedPreviewPlayerId)
  if (before.phase === 'combat' && room.run.phase !== 'combat') settlePendingRelics(room)
  const current = room.run
  if ((action?.kind === 'playCard' || action?.kind === 'playCardCopy' || action?.kind === 'playHermitChamberCard') &&
    locked?.cardUid === action.cardUid) {
    room.cardPreviews = { ...room.cardPreviews }
    delete room.cardPreviews[seat.playerId]
  }
  if (action?.kind === 'activatePower' && stagedPower?.powerUid === action.powerUid) {
    room.powerPreviews = { ...room.powerPreviews }
    delete room.powerPreviews[seat.playerId]
  }
  if (room.cardPreviews) {
    const combat = current.combat
    room.cardPreviews = Object.fromEntries(Object.entries(room.cardPreviews).filter(([playerId, preview]) =>
      preview.copy === true
        ? combat?.phase === 'copy' && combat.pendingCardCopy?.playerId === playerId &&
          combat.pendingCardCopy.card.uid === preview.cardUid
        : preview.chamber === true
          ? combat?.phase === 'player' && combat.players.find((player) => player.id === playerId)?.chamber
            .some((card) => card.uid === preview.cardUid)
        : (combat?.phase === 'player' || ((combat?.phase === 'start' || combat?.phase === 'discard') &&
          combat.startTurnProgress?.forcedCard?.playerId === playerId &&
          combat.startTurnProgress.forcedCard.cardUid === preview.cardUid)) && combat.players
          .find((candidate) => candidate.id === playerId)?.hand.some((card) => card.uid === preview.cardUid)))
  }
  // Any accepted combat action can change a hand, including an ally's. Orders
  // collected before that action are stale, so everyone confirms again.
  clearEndTurnOrdering(room)
  room.endTurnReady = undefined
  // Campfire choices belong to the room they were made in. Left behind, a
  // choice from one campfire silently resolves the NEXT one for a player who
  // was never asked.
  if (current.map.position !== before.map.position || current.phase !== before.phase) {
    room.campfireChoices = undefined
    room.rewardChoices = undefined
    room.rewardConfirmed = undefined
    room.merchantPledges = undefined
    room.merchantReady = undefined
    room.eventPledge = undefined
  }
  settleDisconnectedRewards(room)
  settleReward(room)
  room.version += 1
  return { changed: true, snapshot: snapshotFor(room, seatToken) }
}

function purchaseKey(purchase) {
  return `${purchase?.buyerId ?? ''}/${purchase?.section ?? ''}/${purchase?.slot ?? ''}`
}

function pledgedGold(room, playerId, exceptKey) {
  return Object.entries(room.merchantPledges ?? {}).reduce((sum, [key, pledge]) =>
    key === exceptKey ? sum : sum + (pledge.payments?.[playerId] ?? 0), 0)
}

function merchantPlayers(run) {
  return run.setup?.kind === 'catch-up'
    ? run.players.filter((player) => run.setup.playerIds.includes(player.id))
    : run.players
}

function resetMerchantReady(room, playerId) {
  if (!room.merchantReady?.includes(playerId)) return false
  room.merchantReady = room.merchantReady.filter((id) => id !== playerId)
  if (room.merchantReady.length === 0) room.merchantReady = undefined
  return true
}

function cancelImpossibleDisconnectedPledges(room, merchantOnly = false) {
  const connected = new Set(room.seats.filter((seat) => seat.connected !== false).map((seat) => seat.playerId))
  const available = (players, payments, reserved = () => 0) =>
    Object.entries(payments ?? {}).reduce((sum, [id, amount]) => connected.has(id) ? sum : sum + amount, 0) +
    players.filter((player) => connected.has(player.id) && !player.dead).reduce((sum, player) => sum + Math.max(0, player.gold - reserved(player.id)), 0)

  const offer = room.run?.courier?.offer
  if (!merchantOnly && offer && !connected.has(offer.playerId)) {
    const cost = courierCost(offer)
    if (!room.courierPledge || cost === null || available(room.run.combat?.players ?? [], room.courierPledge.payments) < cost) {
      const next = decideCourier(room.run, offer.playerId, 'discard')
      if (next !== room.run) room.run = next
      room.courierPledge = undefined
    }
  }

  for (const [key, pledge] of Object.entries(room.merchantPledges ?? {})) {
    if (connected.has(pledge.buyerId)) continue
    const cost = pledge.kind === 'removal'
      ? merchantRemovalCost(room.run.ascension)
      : merchantPurchaseCost(room.run.roomState, pledge)
    if (cost === null || available(merchantPlayers(room.run), pledge.payments, (id) => pledgedGold(room, id, key)) < cost) {
      delete room.merchantPledges[key]
    }
  }

  if (merchantOnly) return

  const event = room.eventPledge
  if (event && !connected.has(event.actorId) && available(room.run.players, event.payments) < event.cost) {
    room.eventPledge = undefined
  }
}

/** Each token pledges only its own gold; the purchase settles atomically at exact cost. */
function merchantPurchase(room, seat, action, seatToken) {
  const run = room.run
  if (run.phase !== 'room' || run.roomState?.kind !== 'merchant') fail('The party is not at a Merchant')
  const purchase = action.purchase
  const eligible = merchantPlayers(run)
  if (!eligible.some((player) => player.id === seat.playerId)) fail('Only Catch Up players visit this Merchant')
  if (!purchase || typeof purchase.buyerId !== 'string' || !eligible.some((player) => player.id === purchase.buyerId) ||
    !['relic', 'potion', 'card', 'colorless'].includes(purchase.section) || !Number.isInteger(purchase.slot) || purchase.slot < 0) {
    fail('Choose a valid Merchant offer and seated buyer')
  }
  const amount = purchase.payments?.[seat.playerId]
  if (!Number.isInteger(amount) || amount < 0 || Object.keys(purchase.payments ?? {}).some((id) => id !== seat.playerId)) {
    fail('You may pledge only your own Gold')
  }
  const payer = eligible.find((player) => player.id === seat.playerId)
  const key = purchaseKey(purchase)
  if (!payer || amount + pledgedGold(room, seat.playerId, key) > payer.gold) fail('You do not have that much unpledged Gold')
  const existing = room.merchantPledges?.[key]
  if (!existing && ['relic', 'potion', 'colorless'].includes(purchase.section) && Object.entries(room.merchantPledges ?? {}).some(([otherKey, pledge]) =>
    otherKey !== key && pledge.section === purchase.section && pledge.slot === purchase.slot)) {
    fail('Another buyer is already funding that shared item')
  }
  if (!existing && purchase.buyerId !== seat.playerId) fail('The buyer must authorize the purchase')
  if (purchase.section === 'potion' && purchase.potionRecipientId && purchase.potionRecipientId !== purchase.buyerId) {
    fail('The potion recipient must authorize the purchase as its buyer')
  }
  if (!existing && purchase.discardPotionId && (purchase.potionRecipientId ?? purchase.buyerId) !== seat.playerId) {
    fail('The potion owner must authorize replacing a Potion')
  }
  if (existing && (existing.buyerId !== purchase.buyerId || existing.section !== purchase.section || existing.slot !== purchase.slot)) {
    fail('That purchase changed while it was being funded')
  }
  if (existing && (existing.potionRecipientId !== purchase.potionRecipientId || existing.discardPotionId !== purchase.discardPotionId)) {
    fail('That purchase recipient changed while it was being funded')
  }
  const payments = { ...(existing?.payments ?? {}), [seat.playerId]: amount }
  const total = Object.values(payments).reduce((sum, value) => sum + value, 0)
  const available = merchantPurchaseCost(run.roomState, purchase)
  if (available === null) fail('That item is no longer for sale')
  if (total > available) fail(`That purchase needs only ${available} Gold`)
  if (!existing && eligible.reduce((sum, player) => sum + player.gold - pledgedGold(room, player.id, key), 0) < available) fail('The party cannot afford that purchase')
  const pledge = { buyerId: purchase.buyerId, section: purchase.section, slot: purchase.slot, potionRecipientId: purchase.potionRecipientId, discardPotionId: purchase.discardPotionId, payments }
  if (!existing) {
    const probe = structuredClone(run)
    probe.players.find((player) => player.id === purchase.buyerId).gold = available
    if (purchaseAtMerchant(probe, { ...pledge, payments: { [purchase.buyerId]: available } }) === probe) fail('That purchase cannot be completed')
  }
  if (total < available) room.merchantPledges = { ...room.merchantPledges, [key]: pledge }
  else {
    const next = purchaseAtMerchant(run, pledge)
    if (next === run) fail('That purchase cannot be completed')
    room.run = next
    room.merchantPledges = { ...room.merchantPledges }
    delete room.merchantPledges[key]
    settlePendingRelics(room)
  }
  resetMerchantReady(room, seat.playerId)
  room.version += 1
  return { changed: true, snapshot: snapshotFor(room, seatToken) }
}

function merchantRemove(room, seat, action, seatToken) {
  const run = room.run
  if (run.phase !== 'room' || run.roomState?.kind !== 'merchant') fail('The party is not at a Merchant')
  const eligible = merchantPlayers(run)
  if (!eligible.some((player) => player.id === seat.playerId)) fail('Only Catch Up players visit this Merchant')
  const targetId = action.playerId
  if (!eligible.some((player) => player.id === targetId)) fail('Choose a Catch Up player')
  const amount = action.payments?.[seat.playerId]
  if (!Number.isInteger(amount) || amount < 0 || Object.keys(action.payments ?? {}).some((id) => id !== seat.playerId)) {
    fail('You may pledge only your own Gold')
  }
  const payer = eligible.find((player) => player.id === seat.playerId)
  const key = `remove/${targetId}`
  if (!payer || amount + pledgedGold(room, seat.playerId, key) > payer.gold) fail('You do not have that much unpledged Gold')
  const existing = room.merchantPledges?.[key]
  if (!existing && (seat.playerId !== targetId || typeof action.cardUid !== 'string')) {
    fail('The card owner must choose the card before teammates contribute')
  }
  if (existing?.cardUid && action.cardUid && existing.cardUid !== action.cardUid) fail('That removal is already being funded')
  const payments = { ...(existing?.payments ?? {}), [seat.playerId]: amount }
  const cost = merchantRemovalCost(run.ascension)
  if (Object.values(payments).reduce((sum, value) => sum + value, 0) > cost) fail(`Card removal needs only ${cost} Gold`)
  if (!existing && eligible.reduce((sum, player) => sum + player.gold - pledgedGold(room, player.id, key), 0) < cost) fail('The party cannot afford card removal')
  const pledge = { kind: 'removal', buyerId: targetId, cardUid: existing?.cardUid ?? action.cardUid, payments }
  if (!existing) {
    const probe = structuredClone(run)
    probe.players.find((player) => player.id === targetId).gold = cost
    if (removeAtCurrentMerchant(probe, targetId, pledge.cardUid, { [targetId]: cost }) === probe) fail('That card cannot be removed')
  }
  if (Object.values(payments).reduce((sum, value) => sum + value, 0) < cost) room.merchantPledges = { ...room.merchantPledges, [key]: pledge }
  else {
    const next = removeAtCurrentMerchant(run, targetId, pledge.cardUid, payments)
    if (next === run) fail('That card cannot be removed')
    room.run = next
    room.merchantPledges = { ...room.merchantPledges }
    delete room.merchantPledges[key]
  }
  resetMerchantReady(room, seat.playerId)
  room.version += 1
  return { changed: true, snapshot: snapshotFor(room, seatToken) }
}

function merchantWithdraw(room, seat, action, seatToken) {
  const pending = typeof action.key === 'string' && Object.hasOwn(room.merchantPledges ?? {}, action.key) ? room.merchantPledges[action.key] : undefined
  if (!pending || !(seat.playerId in pending.payments)) fail('You have no pledge on that purchase')
  const payments = { ...pending.payments }
  delete payments[seat.playerId]
  room.merchantPledges = { ...room.merchantPledges }
  if (Object.keys(payments).length === 0 || pending.buyerId === seat.playerId) delete room.merchantPledges[action.key]
  else room.merchantPledges[action.key] = { ...pending, payments }
  resetMerchantReady(room, seat.playerId)
  room.version += 1
  return { changed: true, snapshot: snapshotFor(room, seatToken) }
}

function merchantResume(room, seat, seatToken) {
  const run = room.run
  if (run?.phase !== 'room' || run.roomState?.kind !== 'merchant') fail('The party is not at a Merchant')
  if (!merchantPlayers(run).some((player) => player.id === seat.playerId)) fail('Only active players visit this Merchant')
  const changed = resetMerchantReady(room, seat.playerId)
  if (changed) room.version += 1
  return { changed, snapshot: snapshotFor(room, seatToken) }
}

function merchantFinish(room, seat, seatToken) {
  const run = room.run
  if (run?.phase !== 'room' || run.roomState?.kind !== 'merchant') fail('The party is not at a Merchant')
  const connected = new Set(room.seats.filter((candidate) => candidate.connected !== false).map((candidate) => candidate.playerId))
  const visitors = merchantPlayers(run).map((player) => player.id)
  const eligible = visitors.filter((id) => connected.has(id))
  if (!eligible.includes(seat.playerId)) fail(run.setup?.kind === 'catch-up' ? 'Only Catch Up players visit this Merchant' : 'Only active players visit this Merchant')
  if (Object.keys(room.merchantPledges ?? {}).length > 0) fail('Resolve or cancel pending Merchant contributions first')
  room.merchantReady = [...new Set([...(room.merchantReady ?? []), seat.playerId])].filter((id) => visitors.includes(id))
  settleMerchantReady(room)
  room.version += 1
  return { changed: true, snapshot: snapshotFor(room, seatToken) }
}

function settleMerchantReady(room) {
  const run = room.run
  if (run?.phase !== 'room' || run.roomState?.kind !== 'merchant' || Object.keys(room.merchantPledges ?? {}).length > 0) return false
  const connected = new Set(room.seats.filter((seat) => seat.connected !== false).map((seat) => seat.playerId))
  const eligible = merchantPlayers(run).map((player) => player.id).filter((id) => connected.has(id))
  if (eligible.length === 0 || !eligible.every((id) => room.merchantReady?.includes(id))) return false
  const next = finishMerchant(run)
  if (next === run) return false
  room.run = next
  room.merchantPledges = undefined
  room.merchantReady = undefined
  return true
}

function courierReveal(room, seat, action, seatToken) {
  if (action.kind !== 'courierReveal' || (action.itemKind !== 'relic' && action.itemKind !== 'potion')) fail('Choose a Courier deck')
  const next = revealCourier(room.run, seat.playerId, action.itemKind)
  if (next === room.run) fail('The Courier cannot reveal that deck now')
  room.run = next
  room.courierPledge = undefined
  room.version += 1
  return { changed: true, snapshot: snapshotFor(room, seatToken) }
}

function courierResolve(room, seat, action, seatToken) {
  const offer = room.run?.courier?.offer
  if (!offer) fail('The Courier has no offer')
  if (action.playerId !== undefined && action.playerId !== offer.playerId) fail('That Courier offer belongs to another player')
  if (action.decision === 'discard') {
    if (seat.playerId !== offer.playerId) fail('Only the Courier owner may discard the offer')
    const next = decideCourier(room.run, offer.playerId, 'discard')
    if (next === room.run) fail('That Courier decision is not legal')
    room.run = next
    room.courierPledge = undefined
    room.version += 1
    return { changed: true, snapshot: snapshotFor(room, seatToken) }
  }
  if (action.decision !== 'buy') fail('Choose whether to buy or discard')
  const amount = action.payments?.[seat.playerId]
  if (!Number.isInteger(amount) || amount < 0 || Object.keys(action.payments ?? {}).some((id) => id !== seat.playerId)) fail('You may pledge only your own Gold')
  const payer = room.run.combat?.players.find((player) => player.id === seat.playerId)
  if (!payer || payer.dead || amount > payer.gold) fail('A fallen player cannot fund The Courier')
  const cost = courierCost(offer)
  if (cost === null) fail('That Courier card cannot be bought')
  const pending = room.courierPledge
  if (!pending && seat.playerId !== offer.playerId) fail('The Courier owner must authorize the purchase')
  if (pending && (pending.playerId !== offer.playerId || pending.id !== offer.id || pending.discardPotionId !== action.discardPotionId)) fail('That Courier purchase changed')
  if (!pending && action.discardPotionId && seat.playerId !== offer.playerId) fail('The Potion owner must authorize replacement')
  const payments = { ...(pending?.payments ?? {}), [seat.playerId]: amount }
  const total = Object.values(payments).reduce((sum, paid) => sum + paid, 0)
  if (total > cost) fail(`That Courier offer needs only ${cost} Gold`)
  if (!pending && room.run.combat.players.filter((player) => !player.dead).reduce((sum, player) => sum + player.gold, 0) < cost) fail('The party cannot afford that Courier offer')
  const pledge = { playerId: offer.playerId, id: offer.id, discardPotionId: action.discardPotionId, payments }
  if (!pending) {
    const probe = structuredClone(room.run)
    probe.combat.players.find((player) => player.id === offer.playerId).gold = cost
    if (decideCourier(probe, offer.playerId, 'buy', { [offer.playerId]: cost }, action.discardPotionId) === probe) fail('That Courier purchase is not legal')
  }
  if (total === cost) {
    const next = decideCourier(room.run, offer.playerId, 'buy', payments, action.discardPotionId)
    if (next === room.run) fail('That Courier purchase is not legal')
    room.run = next
    room.courierPledge = undefined
  } else room.courierPledge = pledge
  room.version += 1
  return { changed: true, snapshot: snapshotFor(room, seatToken) }
}

function relicReward(room, seat, action, seatToken) {
  if (room.run?.phase === 'reward' && action.choice !== undefined) {
    if (!['gain', 'skip'].includes(action.choice)) fail('Choose gain or skip for the Relic reward')
    const next = resolveRelicReward(room.run, seat.playerId, action.choice === 'gain')
    if (next === room.run) fail('That Relic reward choice is not legal')
    room.run = next
    settleDisconnectedRewards(room)
    const waiting = settleReward(room)
    room.version += 1
    return { changed: true, waitingOn: waiting, snapshot: snapshotFor(room, seatToken) }
  }
  if (action.playerId !== undefined && action.playerId !== seat.playerId) fail('Choose only your own relic')
  const next = chooseRelicReward(room.run, seat.playerId, action.decision)
  if (next === room.run) fail('That relic choice is not legal')
  room.run = next
  settlePendingRelics(room)
  room.version += 1
  return { changed: true, snapshot: snapshotFor(room, seatToken) }
}

function eventChoice(room, seat, action, seatToken) {
  const actorId = action.playerId ?? seat.playerId
  if (actorId !== seat.playerId && room.eventPledge?.actorId !== actorId) fail('Choose only your own Event option')
  let decision = action.decision
  const stringArray = (value) => value === undefined || (Array.isArray(value) && value.every((entry) => typeof entry === 'string'))
  if (!decision || typeof decision !== 'object' || !Array.isArray(decision.optionIds) || !decision.optionIds.every((id) => typeof id === 'string') ||
    !stringArray(decision.cardUids) || !stringArray(decision.relicIds) || !stringArray(decision.potionIds) || !stringArray(decision.potionRecipientIds) || !stringArray(decision.rewardSources) || !stringArray(decision.guardianGemIds) ||
    (decision.potionReplacementIds !== undefined && (!Array.isArray(decision.potionReplacementIds) || !decision.potionReplacementIds.every((id) => id === null || typeof id === 'string'))) ||
    (decision.rewardItemChoices !== undefined && (!Array.isArray(decision.rewardItemChoices) || !decision.rewardItemChoices.every((choice) => choice === 'take' || choice === 'skip'))) ||
    decision.rewardItemIds !== undefined || decision.rewardItemKinds !== undefined ||
    (decision.rewardIndexes !== undefined && (!Array.isArray(decision.rewardIndexes) || !decision.rewardIndexes.every((index) => Number.isInteger(index) && index >= -1))) ||
    (decision.payments !== undefined && (!decision.payments || typeof decision.payments !== 'object' || Array.isArray(decision.payments) || Object.entries(decision.payments).some(([id, amount]) => typeof id !== 'string' || !Number.isInteger(amount) || amount < 0))) ||
    decision.receiveCardUid !== undefined || decision.receiveRelicId !== undefined ||
    ['targetPlayerId', 'potionRecipientId', 'roomId'].some((field) => decision[field] !== undefined && typeof decision[field] !== 'string')) {
    fail('That Event choice is malformed')
  }
  if (room.eventPledge && (room.eventPledge.actorId !== actorId || room.eventPledge.optionId !== decision.optionIds.join(','))) {
    fail('That Event payment changed')
  }
  const options = room.run.roomState?.kind === 'event'
    ? decision.optionIds.map((id) => room.run.roomState.card.options.find((candidate) => candidate.id === id))
    : []
  const paymentEffects = options.flatMap((option) => option?.effects.filter((effect) => effect.tag === 'pay-gold') ?? [])
  const paysWithItem = paymentEffects.length === 1 && paymentEffects[0]?.filter?.includes('or lose one Relic or Potion') && ((decision.relicIds?.length ?? 0) > 0 || (decision.potionIds?.length ?? 0) > 0)
  if (paysWithItem && seat.playerId !== actorId) fail('Only the Event chooser can offer an item')
  if (room.eventPledge && paysWithItem) fail('That Event payment method is already Gold')
  const cost = paymentEffects.reduce((sum, payment) => sum + (typeof payment.amount === 'number' ? payment.amount : 0), 0)
  const rewardStages = options.some((option) => option?.effects.some((effect) => ['card-reward', 'rare-reward', 'gain-relic', 'gain-potion'].includes(effect.tag)))
  const enginePending = room.run.roomState?.kind === 'event' && room.run.roomState.pendingDecisions?.[actorId]
  const rollPaymentSettled = cost > 0 && enginePending && (room.run.roomState.pendingRolls?.[actorId]?.length ?? 0) > 0
  if (rollPaymentSettled) {
    if (enginePending.optionIds.join(',') !== decision.optionIds.join(',')) fail('That Event choice changed after its die roll')
    decision = { ...enginePending }
  }
  else if (cost > 0 && rewardStages && !enginePending) decision = { ...decision, payments: undefined }
  else if (cost > 0 && !paysWithItem) {
    const amount = decision.payments?.[seat.playerId]
    if (!Number.isInteger(amount) || Object.keys(decision.payments ?? {}).some((id) => id !== seat.playerId)) fail('You may pledge only your own Gold')
    const payer = room.run.players.find((player) => player.id === seat.playerId)
    if (!payer || amount > payer.gold) fail('You do not have that much Gold')
    const pending = room.eventPledge
    if (!pending && actorId !== seat.playerId) fail('The Event chooser must authorize payment')
    const optionId = decision.optionIds.join(',')
    if (pending && (pending.actorId !== actorId || pending.optionId !== optionId)) fail('That Event payment changed')
    const payments = { ...(pending?.payments ?? {}), [seat.playerId]: amount }
    const total = Object.values(payments).reduce((sum, paid) => sum + paid, 0)
    if (total > cost) fail(`That Event needs only ${cost} Gold`)
    if (!pending && room.run.players.reduce((sum, player) => sum + player.gold, 0) < cost) fail('The party cannot afford that Event choice')
    const pledge = { actorId, optionId, cost, decision: pending?.decision ?? { ...decision, payments: undefined }, payments }
    if (total < cost) {
      if (!pending) {
        const probe = structuredClone(room.run)
        probe.players.find((player) => player.id === actorId).gold = Math.max(probe.players.find((player) => player.id === actorId).gold, cost)
        if (chooseEvent(probe, actorId, { ...pledge.decision, payments: { [actorId]: cost } }) === probe) fail('That Event choice is not legal')
      }
      room.eventPledge = pledge
      room.version += 1
      return { changed: true, snapshot: snapshotFor(room, seatToken) }
    }
    decision = { ...pledge.decision, payments }
  }
  const next = chooseEvent(room.run, actorId, decision)
  if (next === room.run) fail('That Event choice is not legal')
  room.run = next
  settlePendingRelics(room)
  room.eventPledge = undefined
  room.version += 1
  return { changed: true, snapshot: snapshotFor(room, seatToken) }
}

function cancelEventPledge(room, seat, seatToken) {
  if (!room.eventPledge || room.eventPledge.actorId !== seat.playerId) fail('Only the Event chooser can cancel this payment')
  room.eventPledge = undefined
  room.version += 1
  return { changed: true, snapshot: snapshotFor(room, seatToken) }
}

function eventSkip(room, seat, action, seatToken) {
  if (action.playerId !== undefined && action.playerId !== seat.playerId) fail('Skip only your own unavailable Event choice')
  if (!canSkipEvent(room.run, seat.playerId)) fail('A printed Event choice is available')
  room.run = skipEvent(room.run, seat.playerId)
  room.version += 1
  return { changed: true, snapshot: snapshotFor(room, seatToken) }
}

function finishCampaignRun(room, seatToken) {
  const next = finishRun(room.run)
  if (next === room.run) fail('This campaign run is not ready to finish')
  room.run = next
  room.campaignProgress = next.campaignProgress
  room.version += 1
  return { changed: true, snapshot: snapshotFor(room, seatToken) }
}

function allocateCampaign(room, seat, action, seatToken) {
  if (!room.run?.campaign.finalized) fail('Finish the campaign run before assigning marks')
  if (room.seats[0]?.playerId !== seat.playerId) fail('The journal keeper assigns shared campaign marks')
  if (action.expectedRunId !== room.run.campaign.runId || !Number.isInteger(action.expectedUnspentMarks) || action.expectedUnspentMarks !== room.campaignProgress.unspentMarks) fail('That campaign allocation is stale')
  if (action.colorless === 0 && action.actIV === 0) fail('Assign at least one campaign mark')
  try {
    room.campaignProgress = allocateSharedMarks(room.campaignProgress, action.colorless, action.actIV)
  } catch (error) {
    fail(error instanceof Error ? error.message : 'That campaign allocation is not legal')
  }
  room.run = { ...room.run, campaignProgress: room.campaignProgress }
  room.version += 1
  return { changed: true, snapshot: snapshotFor(room, seatToken) }
}

function returnToLobby(room, seat, seatToken) {
  if (!room.run?.campaign.finalized || room.campaignProgress.unspentMarks > 0) fail('Finish assigning campaign marks first')
  if (room.seats[0]?.playerId !== seat.playerId) fail('The journal keeper begins the next run')
  room.phase = 'lobby'
  room.run = null
  room.ascension = Math.min(room.ascension, room.campaignProgress.highestAscension)
  room.version += 1
  return { changed: true, snapshot: snapshotFor(room, seatToken) }
}

function endTurn(room, seat, _action, seatToken) {
  let combat = room.run?.combat
  if (!combat) fail('No combat in progress')
  const previewOwners = [...new Set([
    ...Object.keys(room.cardPreviews ?? {}), ...Object.keys(room.powerPreviews ?? {}),
  ])]
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
  room.endTurnReady ??= Object.fromEntries(combat.players
    .filter((candidate) => !candidate.dead && room.seats
      .find((other) => other.playerId === candidate.id)?.connected)
    .map((candidate) => [candidate.id, false]))
  room.endTurnReady = { ...room.endTurnReady, [seat.playerId]: true }
  room.version += 1
  const waiting = settleEndTurn(room)
  return { changed: true, waitingOn: waiting, snapshot: snapshotFor(room, seatToken) }
}

function settleEndTurn(room) {
  let combat = room.run?.combat
  if (!combat || combat.phase !== 'player' || !room.endTurnReady) return null
  const previewOwners = [...new Set([
    ...Object.keys(room.cardPreviews ?? {}), ...Object.keys(room.powerPreviews ?? {}),
  ])]
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
    .filter((player) => !player.dead && (room.endTurnReady[player.id] === false ||
      connected.has(player.id) && !room.endTurnReady[player.id]))
    .map((player) => player.id)
  if (waiting.length > 0) return waiting
  room.run = { ...room.run, combat: beginEndTurnResolution(combat) }
  settleForcedCards(room)
  room.endTurnReady = undefined
  publishEndTurnEffect(room)
  room.endTurnOrders = undefined
  return null
}

/** Publishes only the next live target effect, so each owner resolves its own source immediately. */
function publishEndTurnEffect(room) {
  const ability = endTurnResolutionAbility(room.run?.combat)
  if (!ability) return false
  room.endTurnAbilities = [ability]
  room.endTurnPublicIds = { [`v${room.version}a1`]: ability.id }
  return true
}

function resolveAbandonedPreviews(room) {
  let combat = room.run?.combat
  for (const [playerId, preview] of Object.entries(room.powerPreviews ?? {})) {
    const seat = room.seats.find((candidate) => candidate.playerId === playerId)
    if (!seat || seat.connected || !combat) continue
    const next = activatePower(combat, playerId, preview.powerUid, { scryDiscardUids: [] })
    if (next === combat) return false
    combat = next
    room.run = { ...room.run, combat }
    room.powerPreviews = { ...room.powerPreviews }
    delete room.powerPreviews[playerId]
  }
  for (const [playerId, preview] of Object.entries(room.cardPreviews ?? {})) {
    const seat = room.seats.find((candidate) => candidate.playerId === playerId)
    if (!seat || seat.connected) continue
    const player = room.run?.combat?.players.find((candidate) => candidate.id === playerId)
    const held = preview.copy === true ? room.run?.combat?.pendingCardCopy?.card
      : preview.chamber === true ? player?.chamber.find((card) => card.uid === preview.cardUid)
      : player?.hand.find((card) => card.uid === preview.cardUid)
    const effects = held ? faceOf(cardDef(held.defId), held.upgraded).effects : []
    const searchEffect = effects.find((effect) =>
      effect.kind === 'searchDraw' || effect.kind === 'searchDrawAndPlayTwice' ||
      effect.kind === 'overexert' || effect.kind === 'replicateSlime')
    const recoverEffect = effects.find((effect) => effect.kind === 'recoverDiscard')
    const loadEffect = effects.find((effect) => effect.kind === 'load')
    const searchAmount = searchEffect?.kind === 'searchDraw' ? searchEffect.amount
      : searchEffect ? 1 : 0
    const loadUids = preview.kind === 'load'
      ? preview.cards.slice(0, Math.min(Number(loadEffect?.amount ?? 0), preview.cards.length)).map((card) => card.uid)
      : []
    const chamber = [...(player?.chamber ?? [])]
    const chamberUids = []
    for (const uid of loadUids) {
      if (player && chamber.length >= player.chamberSlots) {
        const replaced = chamber.shift()
        if (replaced) chamberUids.push(replaced.uid)
      }
      const loaded = preview.cards.find((card) => card.uid === uid)
      if (loaded) chamber.push(loaded)
    }
    const fallbackEnemyUid = room.run?.combat?.enemies.find((enemy) => !enemy.dead)?.uid
    const targetedCurses = new Set(['hermit_grudge', 'hermit_malice', 'hermit_horror'])
    const hermitEnemyUids = fallbackEnemyUid ? loadUids
      .filter((uid) => targetedCurses.has(preview.cards.find((card) => card.uid === uid)?.defId))
      .map(() => fallbackEnemyUid) : []
    try {
      apply(room, seat.token, {
        kind: preview.copy === true ? 'playCardCopy'
          : preview.chamber === true ? 'playHermitChamberCard' : 'playCard',
        cardUid: preview.cardUid,
        enemyUid: preview.enemyUid,
        energySpent: preview.energySpent,
        slimeUids: preview.slimeUids,
        slimeEnemyUids: preview.slimeEnemyUids,
        discardUids: preview.kind === 'discard' ? preview.cards.map((card) => card.uid) : undefined,
        scryDiscardUids: preview.kind === 'scry' || preview.kind === 'scryToHand' ? [] : undefined,
        scryToHandUid: undefined,
        topdeckUids: preview.kind === 'topdeck' ? preview.cards.slice(0, 1).map((card) => card.uid) : undefined,
        searchDrawUids: preview.kind === 'search'
          ? preview.cards.slice(0, searchAmount).map((card) => card.uid)
          : undefined,
        recoverDiscardUids: recoverEffect
          ? player.discard.slice(0, recoverEffect.amount).map((card) => card.uid)
          : undefined,
        loadUids: preview.kind === 'load' ? loadUids : preview.kind === 'loadAny' ? [] : undefined,
        chamberUids,
        hermitEnemyUids,
        spendMiracle: preview.spendMiracle,
        preflight: true,
      }, playerId)
    } catch {
      return false
    }
  }
  return true
}

/** Drops a published end-turn effect and any per-seat discard orders. */
function clearEndTurnOrdering(room) {
  room.endTurnAbilities = undefined
  room.endTurnPublicIds = undefined
  room.endTurnOrders = undefined
}

function resolveEndTurnEffect(room, seat, action, seatToken) {
  const combat = room.run?.combat
  if (!combat || !room.endTurnAbilities || !room.endTurnPublicIds) {
    fail('There is no end-turn effect waiting for a target')
  }
  const ability = room.endTurnAbilities[0]
  if (!ability || ability.playerId !== seat.playerId) fail('Only the effect owner can choose its target')
  if (typeof action.abilityId !== 'string' || typeof action.targetUid !== 'string' ||
    room.endTurnPublicIds[action.abilityId] !== ability.id ||
    !ability.targets?.some((target) => target.uid === action.targetUid)) {
    fail('That end-turn effect target is no longer legal')
  }
  const next = resolveEndTurnAbility(combat, chooseEndTurnTarget(ability.id, action.targetUid))
  if (next === combat) fail('That end-turn effect target is no longer legal')
  room.run = { ...room.run, combat: next }
  settleForcedCards(room)
  room.endTurnReady = undefined
  clearEndTurnOrdering(room)
  room.version += 1
  publishEndTurnEffect(room)
  return { changed: true, snapshot: snapshotFor(room, seatToken) }
}

function savedStartTurnChoices(room) {
  const combatId = room.run?.combat?.combatId
  return room.startTurnCombatId === combatId ? room.startTurnChoices : undefined
}

function plannedStartTurnAbilities(room) {
  const combat = room.run?.combat
  if (!combat) return []
  const order = room.startTurnCombatId === combat.combatId ? room.startTurnOrder : undefined
  if (!Array.isArray(order)) return startTurnAbilities(combat)
  const targets = room.startTurnEnemyTargets ?? {}
  const stored = new Map((savedStartTurnChoices(room) ?? []).map((choice) => [choice.id, choice]))
  return startTurnAbilities(combat, order, order.map((id) => ({
    id, shivEnemyUids: [], evokeSlots: [], evokeEnemyUids: [],
    ...stored.get(id), enemyUid: targets[id] ?? stored.get(id)?.enemyUid,
  })))
}

function clearStartTurnPlan(room) {
  room.startTurnCombatId = undefined
  room.startTurnOrder = undefined
  room.startTurnEnemyTargets = undefined
  room.startTurnChoices = undefined
}

function savedStartTurnEnemyTargets(room) {
  const abilities = plannedStartTurnAbilities(room)
  const combatId = room.run?.combat?.combatId
  const storedTargets = room.startTurnCombatId === combatId ? room.startTurnEnemyTargets : undefined
  return Object.fromEntries(abilities.flatMap((ability) => {
    const target = storedTargets?.[ability.id]
    return typeof target === 'string' && ability.targets?.some((candidate) => candidate.uid === target)
      ? [[ability.id, target]] : []
  }))
}

function noxiousFumesIds(combat) {
  return new Set(combat?.players.flatMap((player) => player.powers
    .filter((power) => power.defId === 'noxious_fumes')
    .map((power) => `${player.id}/power:${power.uid}`)) ?? [])
}

function pendingNoxiousFumes(room) {
  const combat = room.run?.combat
  const saved = savedStartTurnEnemyTargets(room)
  const ids = noxiousFumesIds(combat)
  const abilities = plannedStartTurnAbilities(room)
  const pending = abilities.find((ability) =>
    ids.has(ability.id) && (ability.targets?.length ?? 0) > 1 && !saved[ability.id])
  if (pending || !combat || (room.startTurnCombatId === combat.combatId && Array.isArray(room.startTurnOrder)) ||
    !abilities.some((ability) => ability.id === 'enemy:darkling/regrow')) return pending
  // Regrow can turn the one forced target in the default plan into a real
  // Noxious choice after the coordinator moves it earlier.
  return abilities.find((ability) => ids.has(ability.id) && (ability.targets?.length ?? 0) > 0)
}

function startTurnAbilityNeedsChoice(ability, saved, stored = new Set()) {
  return !saved[ability.id] && !stored.has(ability.id) && (ability.overflowShivs > 0 || ability.evokeChoice ||
    ability.guardianModeShift ||
    (ability.exhaustCards?.length ?? 0) > 0 || (ability.targets?.length ?? 0) > 1 ||
    (ability.players?.length ?? 0) > 1)
}

function startTurnChoicePending(ability, choice) {
  return Boolean(ability.targets && (!choice?.enemyUid || ability.enemyTargetStale)) ||
    Boolean(ability.guardianModeShift && typeof choice?.guardianModeShift !== 'boolean') ||
    Boolean(ability.players && !ability.players.some((player) => player.id === choice?.targetPlayerId)) ||
    Boolean(ability.exhaustCards && (choice?.exhaustUids?.length !== 1 ||
      !ability.exhaustCards.some((card) => card.uid === choice.exhaustUids[0]))) ||
    ability.staleShivIndex !== undefined || ability.evokeTargetIndex !== undefined || Boolean(ability.evokeChoice)
}

function validStartTurnChoice(ability, choice) {
  return !startTurnChoicePending(ability, choice) &&
    (ability.targets
      ? ability.targets.some((target) => target.uid === choice.enemyUid)
      : choice.enemyUid === undefined) &&
    (ability.players
      ? ability.players.some((player) => player.id === choice.targetPlayerId)
      : choice.targetPlayerId === undefined) &&
    (ability.guardianModeShift
      ? typeof choice.guardianModeShift === 'boolean'
      : choice.guardianModeShift === undefined) &&
    choice.shivEnemyUids.length === ability.overflowShivs &&
    (choice.evokeSlots?.length ?? 0) === (ability.evokeOrbs?.length ?? 0) &&
    (choice.evokeEnemyUids?.length ?? 0) === (ability.evokeOrbs?.length ?? 0) &&
    (ability.evokeOrbs ?? []).every((orb, index) => orb === 'frost'
      ? choice.evokeEnemyUids?.[index] === null
      : typeof choice.evokeEnemyUids?.[index] === 'string')
}

function mergedStartTurnChoices(room, choices, storedChoices = savedStartTurnChoices(room) ?? []) {
  const stored = new Map(storedChoices.map((choice) => [choice.id, choice]))
  const targets = savedStartTurnEnemyTargets(room)
  return choices.map((choice) => ({
    ...choice,
    ...stored.get(choice.id),
    enemyUid: targets[choice.id] ?? stored.get(choice.id)?.enemyUid ?? choice.enemyUid,
  }))
}

function choicesBeforeNoxious(combat, order, choices, fumesId) {
  const abilities = startTurnAbilities(combat, order, choices)
  const index = abilities.findIndex((ability) => ability.id === fumesId)
  if (abilities.length !== order.length || index < 0 || abilities
    .slice(0, index).some((ability, abilityIndex) => !validStartTurnChoice(ability, choices[abilityIndex]))) {
    fail('Resolve every Start-of-Turn choice before Noxious Fumes')
  }
  return choices.slice(0, index)
}

function connectedStartTurnPlayer(room, playerId) {
  const combat = room.run?.combat
  const alive = new Set(combat?.players.filter((player) => !player.dead).map((player) => player.id) ?? [])
  return room.seats.find((seat) => seat.connected && seat.playerId === playerId)?.playerId ??
    room.seats.find((seat) => seat.connected && alive.has(seat.playerId))?.playerId ?? null
}

function startTurnOrderCoordinator(room) {
  const combat = room.run?.combat
  const abilities = plannedStartTurnAbilities(room)
  const saved = savedStartTurnEnemyTargets(room)
  const fumes = pendingNoxiousFumes(room)
  const fumesIds = noxiousFumesIds(combat)
  const owner = abilities.find((ability) => !fumesIds.has(ability.id) &&
    startTurnAbilityNeedsChoice(ability, saved))?.playerId ?? fumes?.playerId
  return connectedStartTurnPlayer(room, owner)
}

function startTurnOrderPending(room) {
  const combat = room.run?.combat
  const fumes = pendingNoxiousFumes(room)
  if (!combat || !fumes || (room.startTurnCombatId === combat.combatId && Array.isArray(room.startTurnOrder))) {
    return false
  }
  return startTurnOrderCoordinator(room) !== connectedStartTurnPlayer(room, fumes.playerId)
}

function startTurnCoordinator(room) {
  if (startTurnOrderPending(room)) return startTurnOrderCoordinator(room)
  const abilities = plannedStartTurnAbilities(room)
  const saved = savedStartTurnEnemyTargets(room)
  const stored = new Set((savedStartTurnChoices(room) ?? []).map((choice) => choice.id))
  const owner = pendingNoxiousFumes(room)?.playerId ??
    abilities.find((ability) => startTurnAbilityNeedsChoice(ability, saved, stored))?.playerId
  return connectedStartTurnPlayer(room, owner)
}

function resolveStartTurn(room, seat, action, seatToken) {
  const combat = room.run?.combat
  if (!combat || combat.phase !== 'start') fail('The party is not resolving Start-of-Turn abilities')
  if (seat.playerId !== startTurnCoordinator(room)) fail('Only the start-turn coordinator can resolve the order')
  const choices = action.choices
  if (!Array.isArray(choices) || choices.length > UID_LIMIT || choices.some((choice) =>
    !choice || typeof choice.id !== 'string' || !Array.isArray(choice.shivEnemyUids) ||
    (choice.enemyUid !== undefined && typeof choice.enemyUid !== 'string') ||
    (choice.targetPlayerId !== undefined && typeof choice.targetPlayerId !== 'string') ||
    (choice.guardianModeShift !== undefined && typeof choice.guardianModeShift !== 'boolean') ||
    (choice.exhaustUids !== undefined && (!Array.isArray(choice.exhaustUids) ||
      choice.exhaustUids.length > UID_LIMIT || choice.exhaustUids.some((uid) => typeof uid !== 'string'))) ||
    choice.shivEnemyUids.length > CAPS.shivs ||
    choice.shivEnemyUids.some((uid) => uid !== null && typeof uid !== 'string') ||
    (choice.evokeSlots !== undefined && (!Array.isArray(choice.evokeSlots) ||
      choice.evokeSlots.length > UID_LIMIT)) ||
    (choice.evokeEnemyUids !== undefined && (!Array.isArray(choice.evokeEnemyUids) ||
      choice.evokeEnemyUids.length > UID_LIMIT)))) {
    fail('Start-of-Turn choices must contain every ability and valid targets')
  }
  const normalized = choices.map((choice) => ({
    id: choice.id,
    enemyUid: choice.enemyUid,
    targetPlayerId: choice.targetPlayerId,
    exhaustUids: uidList(choice.exhaustUids),
    guardianModeShift: choice.guardianModeShift,
    shivEnemyUids: [...choice.shivEnemyUids],
    evokeSlots: slotList(choice.evokeSlots),
    evokeEnemyUids: targetList(choice.evokeEnemyUids),
  }))
  const previousPlan = {
    combatId: room.startTurnCombatId,
    order: room.startTurnOrder,
    targets: room.startTurnEnemyTargets,
    choices: room.startTurnChoices,
  }
  const existingOrder = room.startTurnCombatId === combat.combatId ? room.startTurnOrder : undefined
  if (existingOrder && normalized.some((choice, index) => choice.id !== existingOrder[index])) {
    fail('The Start-of-Turn order is already committed')
  }
  if (startTurnOrderPending(room)) {
    const order = normalized.map((choice) => choice.id)
    const fumes = pendingNoxiousFumes(room)
    if (!fumes || startTurnAbilities(combat, order).length !== startTurnAbilities(combat).length) {
      fail('Start-of-Turn choices must contain every ability and valid targets')
    }
    const stagedChoices = choicesBeforeNoxious(combat, order, normalized, fumes.id)
    room.startTurnCombatId = combat.combatId
    room.startTurnOrder = order
    room.startTurnEnemyTargets = undefined
    room.startTurnChoices = stagedChoices
    room.version += 1
    return { changed: true, snapshot: snapshotFor(room, seatToken) }
  }
  const pendingFumes = pendingNoxiousFumes(room)
  if (pendingFumes) {
    const order = normalized.map((choice) => choice.id)
    const prefixChoices = existingOrder
      ? savedStartTurnChoices(room) ?? []
      : choicesBeforeNoxious(combat, order, normalized, pendingFumes.id)
    const ownerChoices = normalized.map((choice) => choice.id === pendingFumes.id ? choice : ({
      id: choice.id, shivEnemyUids: [], evokeSlots: [], evokeEnemyUids: [],
    }))
    const stagedChoices = mergedStartTurnChoices(room, ownerChoices, prefixChoices)
    const plannedFumes = startTurnAbilities(combat, order, stagedChoices)
      .find((ability) => ability.id === pendingFumes.id)
    const target = normalized.find((choice) => choice.id === pendingFumes.id)?.enemyUid
    if (!plannedFumes?.targets?.some((candidate) => candidate.uid === target)) {
      fail('Choose a living enemy for Noxious Fumes')
    }
    const savedTargets = savedStartTurnEnemyTargets(room)
    room.startTurnCombatId = combat.combatId
    room.startTurnOrder = order
    room.startTurnChoices = prefixChoices
    room.startTurnEnemyTargets = { ...savedTargets, [pendingFumes.id]: target }
    const staged = mergedStartTurnChoices(room, ownerChoices)
    const stagedById = new Map(staged.map((choice) => [choice.id, choice]))
    const remainingChoice = plannedStartTurnAbilities(room).some((ability) =>
      startTurnChoicePending(ability, stagedById.get(ability.id)))
    if (pendingNoxiousFumes(room) || remainingChoice) {
      room.version += 1
      return { changed: true, snapshot: snapshotFor(room, seatToken) }
    }
  }
  const saved = savedStartTurnEnemyTargets(room)
  const resolvedChoices = mergedStartTurnChoices(room, normalized).map((choice) => saved[choice.id]
    ? { ...choice, enemyUid: saved[choice.id] }
    : choice)
  const next = resolveStartPlayerTurn(combat, resolvedChoices)
  if (next === combat) {
    const fumesIds = noxiousFumesIds(combat)
    const staleFumes = new Set(startTurnAbilities(combat, resolvedChoices.map((choice) => choice.id), resolvedChoices)
      .filter((ability) => fumesIds.has(ability.id) && saved[ability.id] && ability.enemyTargetStale)
      .map((ability) => ability.id))
    if (staleFumes.size > 0) {
      room.startTurnCombatId = combat.combatId
      room.startTurnOrder = resolvedChoices.map((choice) => choice.id)
      room.startTurnEnemyTargets = Object.fromEntries(Object.entries(room.startTurnEnemyTargets ?? {})
        .filter(([id]) => !staleFumes.has(id)))
      room.version += 1
      return { changed: true, snapshot: snapshotFor(room, seatToken) }
    }
    room.startTurnCombatId = previousPlan.combatId
    room.startTurnOrder = previousPlan.order
    room.startTurnEnemyTargets = previousPlan.targets
    room.startTurnChoices = previousPlan.choices
    fail('The Start-of-Turn order or targets are stale')
  }
  room.run = { ...room.run, combat: next }
  clearStartTurnPlan(room)
  settleForcedCards(room)
  room.version += 1
  return { changed: true, snapshot: snapshotFor(room, seatToken) }
}

function resolveBeforeDrawScry(room, seat, action, seatToken) {
  const combat = room.run?.combat
  const preview = combat && startTurnScryPreview(combat)
  if (!combat || !preview) fail('The party is not resolving a pre-draw Scry')
  if (preview.playerId !== seat.playerId) fail('Only the Scry owner may see or resolve these cards')
  if (action.sourceId !== preview.id || !Array.isArray(action.discardUids) ||
    action.discardUids.length > preview.amount ||
    action.discardUids.some((uid) => typeof uid !== 'string')) {
    fail('Scry discards must name revealed cards')
  }
  const next = resolveStartTurnScry(combat, seat.playerId, action.sourceId, action.discardUids)
  if (next === combat) fail('The Scry choice is stale')
  room.run = { ...room.run, combat: next }
  settleForcedCards(room)
  room.version += 1
  return { changed: true, snapshot: snapshotFor(room, seatToken) }
}

function resolvePrivateStartTurnDiscard(room, seat, action, seatToken) {
  const combat = room.run?.combat
  const preview = combat && startTurnDiscardPreview(combat)
  if (!combat || !preview) fail('The party is not resolving a start-turn discard')
  if (preview.playerId !== seat.playerId) fail('Only the discard owner may see or resolve these cards')
  if (action.sourceId !== preview.sourceId || typeof action.discardUid !== 'string') {
    fail('The discard must name one card in hand')
  }
  const next = resolveStartTurnDiscard(combat, seat.playerId, action.sourceId, action.discardUid)
  if (next === combat) fail('The discard choice is stale')
  room.run = { ...room.run, combat: next }
  settleForcedCards(room)
  room.version += 1
  return { changed: true, snapshot: snapshotFor(room, seatToken) }
}

function orderBeforeDrawScries(room, seat, action, seatToken) {
  const combat = room.run?.combat
  if (!combat || combat.phase !== 'start') fail('The party is not ordering pre-draw Scries')
  if (seat.playerId !== startTurnCoordinator(room)) fail('Only the start-turn coordinator can resolve the order')
  if (!Array.isArray(action.order) || action.order.length > UID_LIMIT ||
    action.order.some((id) => typeof id !== 'string')) fail('Scry order must name every ability once')
  const next = orderStartTurnScries(combat, action.order)
  if (next === combat) fail('The pre-draw Scry order is stale')
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
  if (!choice || !['rest', 'smith', 'leave', 'ruby'].includes(choice.choice)) {
    fail('Choose Rest, Smith, Leave, or the Ruby Key')
  }
  if (choice.choice === 'ruby' && (run.campaignProgress.actIV < 5 || run.campaign.keys.ruby)) {
    fail('The Ruby Key is not available')
  }
  const player = run.players.find((candidate) => candidate.id === seat.playerId)
  if (choice.choice === 'rest' && player?.relics.some((relic) => relic.defId === 'coffee_dripper')) {
    fail('Coffee Dripper prevents Resting')
  }
  if (choice.choice === 'rest' && run.meta?.modifierIds?.includes('night_terrors')) fail('Night Terrors prevents Resting')
  if (choice.choice === 'smith' && player?.relics.some((relic) => relic.defId === 'fusion_hammer')) {
    fail('Fusion Hammer prevents Smithing')
  }
  const restBlocked = player?.relics.some((relic) => relic.defId === 'coffee_dripper') || run.meta?.modifierIds?.includes('night_terrors')
  const smithBlocked = player?.relics.some((relic) => relic.defId === 'fusion_hammer') ||
    !player?.deck.some(canUpgradeCard)
  if (choice.choice === 'leave' && !(restBlocked && smithBlocked)) fail('Leave only when Rest and Smith are blocked')
  if (choice.removeCardUid !== undefined && (
    choice.choice !== 'rest' || !player?.relics.some((relic) => relic.defId === 'peace_pipe') ||
    !player.deck.some((card) => card.uid === choice.removeCardUid && card.defId !== 'ascenders_bane')
  )) fail('Peace Pipe can remove one of your cards only while Resting')
  if (choice.transformCardUid !== undefined && (
    choice.choice !== 'rest' || !player?.relics.some((relic) => relic.defId === 'straight_razor') ||
    choice.transformCardUid === choice.removeCardUid ||
    !player.deck.some((card) => card.uid === choice.transformCardUid && card.defId !== 'ascenders_bane') ||
    player.cardRewards.length === 0
  )) fail('Straight Razor can Transform one eligible card only while Resting')
  if (choice.choice === 'smith') {
    const target = player?.deck.find((card) => card.uid === choice.cardUid && canUpgradeCard(card))
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
    // Ruby and ordinary Campfire choices are simultaneous physical decisions.
    // A disconnected seat reconnects to its pending choice; it is never an
    // implicit skip or abstention.
    return !room.campfireChoices[other.playerId]
  })
  if (undecided.length > 0) return undecided.map((other) => other.playerId)

  const next = resolveCampfire(run, room.campfireChoices)
  if (next !== run) {
    room.campfireChoices = undefined
    room.run = next
    room.version += 1
  }
  return null
}

function cardReward(room, seat, action, seatToken) {
  const run = room.run
  if (run.phase !== 'reward') fail('The party is not choosing rewards')
  const offer = run.rewards.find((candidate) => candidate.playerId === seat.playerId && candidate.cardReward)
  if (!offer) fail('This seat has no card reward')
  const choice = action.choice
  if (choice === 'reveal') {
    const sources = Array.isArray(action.sources) && action.sources.length <= 3
      ? action.sources.filter((source) => typeof source === 'string') : []
    const next = revealCardReward(run, seat.playerId, sources)
    if (next === run) fail('This reward is already revealed')
    room.run = next
    // Revealing changes the information every permanent choice is based on.
    room.rewardConfirmed = undefined
    settleDisconnectedRewards(room)
    room.version += 1
    return { changed: true, snapshot: snapshotFor(room, seatToken) }
  }
  if (choice === 'confirm' || choice === 'unconfirm') {
    if (run.rewards.some((candidate) => candidate.gold || candidate.transformReward || candidate.potion !== false || (candidate.relic ?? false) !== false || (candidate.bossRelics ?? false) !== false)) {
      fail('Settle every item reward first')
    }
    // Only YOUR own pick gates YOUR own confirmation. Waiting for the whole
    // table first made the counter useless: nobody could tick over until the
    // last player had chosen, so the confirm read as a second, pointless round.
    if (!(seat.playerId in (room.rewardChoices ?? {}))) fail('Choose a reward before confirming it')
    // The DESIRED state, not a flip. One button drives both, but a flip is not
    // idempotent: a double-click, or a resend after a timeout the server had
    // already applied, would land a player back on "unconfirmed" while their
    // screen said otherwise and the table waited on them.
    room.rewardConfirmed = { ...room.rewardConfirmed }
    if (choice === 'unconfirm') delete room.rewardConfirmed[seat.playerId]
    else room.rewardConfirmed[seat.playerId] = true
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
  // Changing your mind reopens YOUR confirmation and nobody else's. Wiping the
  // table's was the whole reason one player reconsidering made everyone re-click:
  // a teammate's card is not information any other player's choice rests on.
  // (Revealing more cards IS such information, and still clears every seat.)
  if (room.rewardConfirmed?.[seat.playerId]) {
    room.rewardConfirmed = { ...room.rewardConfirmed }
    delete room.rewardConfirmed[seat.playerId]
  }
  settleDisconnectedRewards(room)
  room.version += 1
  const waiting = settleReward(room)
  return { changed: true, waitingOn: waiting, snapshot: snapshotFor(room, seatToken) }
}

function transformReward(room, seat, action, seatToken) {
  const run = room.run
  if (run.phase !== 'reward') fail('The party is not choosing rewards')
  if (!run.rewards.some((offer) => offer.playerId === seat.playerId && offer.transformReward)) {
    fail('This seat has no Transform reward')
  }
  if (action.cardUid !== null && typeof action.cardUid !== 'string') fail('Choose one card to Transform or skip')
  const next = resolveTransformReward(run, seat.playerId, action.cardUid)
  if (next === run) fail('That card cannot be Transformed')
  room.run = next
  settlePendingRelics(room)
  settleDisconnectedRewards(room)
  const waiting = settleReward(room)
  room.version += 1
  return { changed: true, waitingOn: waiting, snapshot: snapshotFor(room, seatToken) }
}

function quickSetupStep(room, seat, action, seatToken) {
  const setup = room.run?.setup
  if (room.run?.phase !== 'setup' || !setup) fail('The party is not resolving Quick Start')
  const activePlayerId = setup.playerIds[setup.playerIndex] ?? setup.playerIds[0]
  if (seat.playerId !== activePlayerId) fail('Only the active setup player may resolve this step')
  const cardUids = Array.isArray(action.cardUids) && action.cardUids.length <= 1
    ? action.cardUids.filter((uid) => typeof uid === 'string') : []
  const next = advanceQuickSetup(room.run, cardUids)
  if (next === room.run) fail('That Quick Start choice is not legal')
  room.run = next
  room.version += 1
  return { changed: true, snapshot: snapshotFor(room, seatToken) }
}

function settleReward(room) {
  const run = room.run
  if (!run || run.phase !== 'reward' || !room.rewardChoices) return null
  if (!room.seats.some((seat) => seat.connected)) return null
  const waiting = run.rewards.filter((offer) => offer.cardReward)
    .filter((offer) => !(offer.playerId in room.rewardChoices))
    .map((offer) => offer.playerId)
  if (waiting.length > 0) return waiting
  const confirming = run.rewards.filter((offer) => offer.cardReward)
    .filter((offer) => !(offer.playerId in (room.rewardConfirmed ?? {})))
    .map((offer) => offer.playerId)
  if (confirming.length > 0) return confirming
  const decisions = Object.fromEntries(run.rewards.filter((offer) => offer.cardReward).map((offer) => [
    offer.playerId,
    room.rewardChoices[offer.playerId],
  ]))
  const next = resolveCardRewards(run, decisions)
  if (next !== run) {
    room.rewardChoices = undefined
    room.rewardConfirmed = undefined
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

const hermitDieRelicList = (value) => Array.isArray(value)
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
      // A seat may only play cards from its OWN hand. Without this check any
      // client could spend another player's energy and empty their hand.
      const player = run.combat.players.find((candidate) => candidate.id === seat.playerId)
      const card = copied && run.combat.pendingCardCopy?.playerId === seat.playerId
        ? run.combat.pendingCardCopy.card
        : player?.hand.find((held) => held.uid === action.cardUid)
      if (!card) fail(copied ? 'No original card is waiting for you' : 'That card is not in your hand')
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
      const searchDrawUids = uidList(action.searchDrawUids)
      if (action.searchDrawUids !== undefined && (
        !Array.isArray(action.searchDrawUids) || searchDrawUids.length !== action.searchDrawUids.length
      )) fail('Draw-pile choices must be a list of card ids')
      const recoverDiscardUid = action.recoverDiscardUid
      if (recoverDiscardUid !== undefined && typeof recoverDiscardUid !== 'string') {
        fail('Discard recovery must be a card id')
      }
      const recoverDiscardUids = uidList(action.recoverDiscardUids)
      if (action.recoverDiscardUids !== undefined && (
        !Array.isArray(action.recoverDiscardUids) || recoverDiscardUids.length !== action.recoverDiscardUids.length
      )) fail('Discard recovery must be a list of card ids')
      if (recoverDiscardUid !== undefined && action.recoverDiscardUids !== undefined) {
        fail('Discard recovery must use one choice format')
      }
      const recoverExhaustUid = action.recoverExhaustUid
      if (recoverExhaustUid !== undefined && typeof recoverExhaustUid !== 'string') {
        fail('Exhaust recovery must be a card id')
      }
      const recoverExhaustUids = uidList(action.recoverExhaustUids)
      if (action.recoverExhaustUids !== undefined && (
        !Array.isArray(action.recoverExhaustUids) || recoverExhaustUids.length !== action.recoverExhaustUids.length
      )) fail('Exhaust recovery must be a list of card ids')
      if (recoverExhaustUid !== undefined && action.recoverExhaustUids !== undefined) {
        fail('Exhaust recovery must use one choice format')
      }
      if (action.energySpent !== undefined && !Number.isInteger(action.energySpent)) {
        fail('X Energy must be a whole number')
      }
      if (action.corruptedShardMode !== undefined && action.corruptedShardMode !== 'attack' && action.corruptedShardMode !== 'defense') {
        fail('Corrupted Shard Mode must be attack or defense')
      }
      const loadUids = uidList(action.loadUids)
      const chamberUids = uidList(action.chamberUids)
      const hermitEnemyUids = uidList(action.hermitEnemyUids)
      const slimeUids = uidList(action.slimeUids)
      const slimeEnemyUids = uidList(action.slimeEnemyUids)
      const soulburnEnemyUids = uidList(action.soulburnEnemyUids)
      const hermitDieRelics = hermitDieRelicList(action.hermitDieRelics)
      if (action.hermitDieRelics !== undefined && hermitDieRelics?.length !== action.hermitDieRelics.length) {
        fail('Cheat choices must identify valid die-relic abilities')
      }
      for (const [label, original, sanitized] of [
        ['Load', action.loadUids, loadUids],
        ['Chamber', action.chamberUids, chamberUids],
        ['Hermit enemy', action.hermitEnemyUids, hermitEnemyUids],
        ['Slime', action.slimeUids, slimeUids],
        ['Slime enemy', action.slimeEnemyUids, slimeEnemyUids],
        ['Soulburn enemy', action.soulburnEnemyUids, soulburnEnemyUids],
      ]) if (original !== undefined && (!Array.isArray(original) || sanitized.length !== original.length)) {
        fail(`${label} choices must be a list of ids`)
      }
      for (const [label, value] of [
        ['Vigor spend', action.spendVigor],
        ['Guardian Block spend', action.guardianBlockSpend],
      ]) if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
        fail(`${label} must be a non-negative whole number`)
      }
      if (action.guardianModeShift !== undefined && typeof action.guardianModeShift !== 'boolean') {
        fail('Guardian Mode shift must be true or false')
      }
      if (action.guardianPowerCardUid !== undefined && typeof action.guardianPowerCardUid !== 'string') {
        fail('Power Beam must identify a Power card')
      }
      const context = {
        enemyUid: action.enemyUid ?? null,
        enemyUids,
        playerId: action.playerId ?? seat.playerId,
        energySpent: action.energySpent,
        playerIds,
        switchWithPlayerId: action.switchWithPlayerId ?? null,
        mode: action.mode,
        corruptedShardMode: action.corruptedShardMode,
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
        scryToHandUid: typeof action.scryToHandUid === 'string' ? action.scryToHandUid : undefined,
        topdeckUids,
        searchDrawUids,
        recoverDiscardUid,
        recoverDiscardUids,
        recoverExhaustUid,
        recoverExhaustUids,
        loadUids,
        chamberUids,
        hermitEnemyUids,
        slimeUids,
        slimeEnemyUids,
        soulburnEnemyUids,
        hermitDieRelics,
        chooseLoadSelf: action.chooseLoadSelf === true,
        spendVigor: action.spendVigor,
        guardianModeShift: action.guardianModeShift === true,
        secondGuardianModeShift: action.secondGuardianModeShift === true,
        guardianBlockSpend: action.guardianBlockSpend,
        guardianPowerCardUid: action.guardianPowerCardUid,
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

    case 'playHermitChamberCard': {
      if (!run.combat || typeof action.cardUid !== 'string') fail('No matching Chamber card in combat')
      const player = run.combat.players.find((candidate) => candidate.id === seat.playerId)
      const card = player?.chamber.find((held) => held.uid === action.cardUid)
      if (!player || !card) fail('That Chamber card is not yours')
      const def = faceOf(cardDef(card.defId), card.upgraded)
      const variableDiscard = def.effects.some((effect) => effect.kind === 'discardAny')
      const variableExhaust = def.effects.find((effect) => effect.kind === 'exhaustAny')
      const discardUids = variableDiscard ? action.discardUids : uidList(action.discardUids)
      const exhaustUids = uidList(action.exhaustUids) ?? []
      if (action.discardUids !== undefined && (!Array.isArray(action.discardUids) ||
        (variableDiscard ? action.discardUids.length > player.hand.length : discardUids.length !== action.discardUids.length))) {
        fail('Discard choices must be a valid list of card ids')
      }
      if (action.exhaustUids !== undefined && (!Array.isArray(action.exhaustUids) ||
        exhaustUids.length !== action.exhaustUids.length ||
        (variableExhaust && action.exhaustUids.length > player.hand.length))) {
        fail('Exhaust choices must be a valid list of card ids')
      }
      if (variableExhaust && exhaustUids.length < Math.min(variableExhaust.minimum ?? 0, player.hand.length)) {
        fail('Choose the minimum number of cards to Exhaust')
      }
      const lists = Object.fromEntries([
        'enemyUids', 'playerIds', 'scryDiscardUids', 'topdeckUids', 'searchDrawUids',
        'recoverDiscardUids', 'recoverExhaustUids', 'loadUids', 'chamberUids', 'hermitEnemyUids', 'slimeUids',
        'slimeEnemyUids',
        'soulburnEnemyUids',
      ].map((key) => [key, uidList(action[key])]))
      for (const key of Object.keys(lists)) if (action[key] !== undefined &&
        (!Array.isArray(action[key]) || lists[key]?.length !== action[key].length)) {
        fail(`${key} must be a list of ids`)
      }
      if (action.recoverDiscardUid !== undefined && typeof action.recoverDiscardUid !== 'string') {
        fail('Discard recovery must be a card id')
      }
      if (action.recoverExhaustUid !== undefined && typeof action.recoverExhaustUid !== 'string') {
        fail('Exhaust recovery must be a card id')
      }
      if (action.recoverExhaustUid !== undefined && action.recoverExhaustUids !== undefined) {
        fail('Exhaust recovery must use one choice format')
      }
      if (action.recoverDiscardUid !== undefined && action.recoverDiscardUids !== undefined) {
        fail('Discard recovery must use one choice format')
      }
      if (action.energySpent !== undefined && !Number.isInteger(action.energySpent)) fail('X Energy must be a whole number')
      if (action.corruptedShardMode !== undefined && action.corruptedShardMode !== 'attack' &&
        action.corruptedShardMode !== 'defense') fail('Corrupted Shard Mode must be attack or defense')
      if (action.guardianPowerCardUid !== undefined && typeof action.guardianPowerCardUid !== 'string') {
        fail('Power Beam must identify a Power card')
      }
      for (const [label, value] of [
        ['Vigor spend', action.spendVigor], ['Guardian Block spend', action.guardianBlockSpend],
      ]) if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
        fail(`${label} must be a non-negative whole number`)
      }
      const hermitDieRelics = hermitDieRelicList(action.hermitDieRelics)
      if (action.hermitDieRelics !== undefined && hermitDieRelics?.length !== action.hermitDieRelics.length) {
        fail('Cheat choices must identify valid die-relic abilities')
      }
      const mandatoryShivs = cardShivChoiceCount(def, player, action.mode)
      const { targets: shivEnemyUids } = overflowChoices(run.combat, def.effects, {
        ...action, discardUids,
      }, mandatoryShivs)
      const combat = playHermitChamberCard(run.combat, seat.playerId, action.cardUid, {
        enemyUid: typeof action.enemyUid === 'string' ? action.enemyUid : null,
        enemyUids: lists.enemyUids,
        playerId: typeof action.playerId === 'string' ? action.playerId : seat.playerId,
        playerIds: lists.playerIds,
        energySpent: Number.isInteger(action.energySpent) ? action.energySpent : undefined,
        mode: Number.isInteger(action.mode) ? action.mode : undefined,
        switchWithPlayerId: typeof action.switchWithPlayerId === 'string' ? action.switchWithPlayerId : null,
        corruptedShardMode: action.corruptedShardMode,
        discardUids,
        exhaustUids,
        spendMiracle: action.spendMiracle === true,
        shivEnemyUids,
        scryDiscardUids: lists.scryDiscardUids,
        scryToHandUid: typeof action.scryToHandUid === 'string' ? action.scryToHandUid : undefined,
        topdeckUids: lists.topdeckUids,
        searchDrawUids: lists.searchDrawUids,
        recoverDiscardUid: action.recoverDiscardUid,
        recoverDiscardUids: lists.recoverDiscardUids,
        recoverExhaustUid: action.recoverExhaustUid,
        recoverExhaustUids: lists.recoverExhaustUids,
        loadUids: lists.loadUids,
        chamberUids: lists.chamberUids,
        hermitEnemyUids: lists.hermitEnemyUids,
        slimeUids: lists.slimeUids,
        slimeEnemyUids: lists.slimeEnemyUids,
        soulburnEnemyUids: lists.soulburnEnemyUids,
        hermitDieRelics,
        chooseLoadSelf: action.chooseLoadSelf === true,
        spendVigor: action.spendVigor,
        guardianModeShift: action.guardianModeShift === true,
        secondGuardianModeShift: action.secondGuardianModeShift === true,
        guardianBlockSpend: action.guardianBlockSpend,
        guardianPowerCardUid: action.guardianPowerCardUid,
        evokeSlots: slotList(action.evokeSlots),
        evokeEnemyUids: targetList(action.evokeEnemyUids),
      })
      if (combat === run.combat && action.preflight === true) fail('That Chamber play is no longer legal')
      return combat === run.combat ? run : { ...run, combat }
    }

    case 'resolveHermitSetupLoad': {
      if (!run.combat || typeof action.cardUid !== 'string') fail('No Hermit setup Load is pending')
      const combat = resolveHermitSetupLoad(run.combat, seat.playerId, action.cardUid,
        typeof action.enemyUid === 'string' ? action.enemyUid : null)
      if (combat === run.combat) fail('That Hermit setup Load is no longer legal')
      return { ...run, combat }
    }

    case 'resolveDieRelicChoice': {
      if (!run.combat) fail('No die Relic choice is pending')
      const discardUids = uidList(action.discardUids)
      const exhaustUids = uidList(action.exhaustUids)
      for (const [label, original, sanitized] of [
        ['Discard', action.discardUids, discardUids], ['Exhaust', action.exhaustUids, exhaustUids],
      ]) if (original !== undefined && (!Array.isArray(original) || sanitized.length !== original.length)) {
        fail(`${label} choices must be a list of card ids`)
      }
      const combat = resolvePendingDieRelicChoice(run.combat, seat.playerId, { discardUids, exhaustUids })
      if (combat === run.combat) fail('That die Relic choice is no longer legal')
      return { ...run, combat }
    }

    case 'resolveHermitStrengthReward': {
      if (!run.combat || typeof action.playerId !== 'string') fail('No Hermit Strength reward is pending')
      const combat = resolveHermitStrengthReward(run.combat, seat.playerId, action.playerId)
      if (combat === run.combat) fail('That Hermit Strength reward is no longer legal')
      return { ...run, combat }
    }

    case 'activatePower': {
      if (!run.combat) fail('No combat in progress')
      const loadUids = uidList(action.loadUids)
      const chamberUids = uidList(action.chamberUids)
      const hermitEnemyUids = uidList(action.hermitEnemyUids)
      const scryDiscardUids = uidList(action.scryDiscardUids)
      const exhaustUids = uidList(action.exhaustUids)
      for (const [label, original, sanitized] of [
        ['Load', action.loadUids, loadUids],
        ['Chamber', action.chamberUids, chamberUids],
        ['Hermit enemy', action.hermitEnemyUids, hermitEnemyUids],
        ['Scry', action.scryDiscardUids, scryDiscardUids],
        ['Exhaust', action.exhaustUids, exhaustUids],
      ]) if (original !== undefined && (!Array.isArray(original) || sanitized.length !== original.length)) {
        fail(`${label} choices must be a list of ids`)
      }
      const combat = activatePower(run.combat, seat.playerId, action.powerUid, {
        enemyUid: action.enemyUid ?? null,
        enemyRow: Number.isInteger(action.enemyRow) ? action.enemyRow : null,
        playerId: typeof action.playerId === 'string' ? action.playerId : null,
        exhaustUids,
        guardianModeShift: action.guardianModeShift === true,
        loadUids,
        chamberUids,
        hermitEnemyUids,
        scryDiscardUids,
        cardUid: typeof action.cardUid === 'string' ? action.cardUid : undefined,
      })
      if (combat === run.combat && action.preflight === true) {
        fail('That Power ability is no longer legal; choose again')
      }
      return combat === run.combat ? run : { ...run, combat }
    }
    case 'activateRelic': {
      if (!run.combat || !Number.isInteger(action.relicIndex)) fail('No matching Relic in combat')
      const player = run.combat.players.find((candidate) => candidate.id === seat.playerId)
      if (!player?.relics[action.relicIndex]) fail('That Relic is not yours')
      const combat = activateRelic(run.combat, seat.playerId, action.relicIndex, {
        enemyUid: action.enemyUid ?? null,
        targetPlayerId: typeof action.targetPlayerId === 'string' ? action.targetPlayerId : null,
        cardUids: Array.isArray(action.cardUids) ? action.cardUids : [],
        targetRelicPlayerId: action.targetRelicPlayerId,
        targetRelicIndex: action.targetRelicIndex,
        targetAbilityIndex: action.targetAbilityIndex,
        die: action.die,
        scryDiscardUids: Array.isArray(action.scryDiscardUids)
          ? action.scryDiscardUids.filter((uid) => typeof uid === 'string')
          : undefined,
        shivEnemyUids: Array.isArray(action.shivEnemyUids)
          ? action.shivEnemyUids.filter((uid) => typeof uid === 'string')
          : undefined,
        discardPotionId: typeof action.discardPotionId === 'string' ? action.discardPotionId : undefined,
      })
      if (combat === run.combat) fail('That Relic activation is not legal')
      return { ...run, combat }
    }
    case 'resolvePendingRelic': {
      const next = resolvePendingRelic(run, seat.playerId,
        Array.isArray(action.cardUids) ? action.cardUids : [],
        Array.isArray(action.rewardIndices) ? action.rewardIndices : [])
      if (next === run) fail('That Relic choice is not legal')
      return next
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
    case 'chooseDistilledCard': {
      if (!run.combat) fail('No combat in progress')
      const combat = chooseDistilledCard(run.combat, seat.playerId, action.cardUid)
      if (combat === run.combat) fail('That Distilled Chaos choice is not legal')
      return { ...run, combat }
    }
    case 'spendShiv': {
      if (!run.combat) fail('No combat in progress')
      const combat = spendShiv(run.combat, seat.playerId, action.enemyUid)
      return combat === run.combat ? run : { ...run, combat }
    }
    case 'spendSoulburn': {
      if (!run.combat || typeof action.enemyUid !== 'string' ||
        (action.extraCrispyPowerUid !== undefined && typeof action.extraCrispyPowerUid !== 'string')) {
        fail('Soulburn needs a valid enemy and optional Extra Crispy Power')
      }
      const combat = spendSoulburn(run.combat, seat.playerId, action.enemyUid, action.extraCrispyPowerUid)
      return combat === run.combat ? run : { ...run, combat }
    }
    case 'resolvePlunderRowSwitch': {
      if (!run.combat || action.row !== null && !Number.isInteger(action.row)) {
        fail('Plunder row must be a row number or null')
      }
      const combat = resolvePlunderRowSwitch(run.combat, seat.playerId, action.row)
      if (combat === run.combat) fail('That Plunder row choice is no longer legal')
      return { ...run, combat }
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
          recoverDiscardUid: typeof action.recoverDiscardUid === 'string' ? action.recoverDiscardUid : undefined,
          exhaustUids: Array.isArray(action.exhaustUids)
            ? action.exhaustUids.filter((uid) => typeof uid === 'string')
            : undefined,
          die: Number.isInteger(action.die) ? action.die : undefined,
          replacePotionId: typeof action.replacePotionId === 'string' ? action.replacePotionId : undefined,
          transformHandUid: typeof action.transformHandUid === 'string' ? action.transformHandUid : undefined,
          recoverExhaustUid: typeof action.recoverExhaustUid === 'string' ? action.recoverExhaustUid : undefined,
          targetRelicPlayerId: typeof action.targetRelicPlayerId === 'string' ? action.targetRelicPlayerId : undefined,
          targetRelicIndex: Number.isInteger(action.targetRelicIndex) ? action.targetRelicIndex : undefined,
          targetAbilityIndex: Number.isInteger(action.targetAbilityIndex) ? action.targetAbilityIndex : undefined,
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
      return enterRoom(run, action.roomId, action.useWingBoots === true ? seat.playerId : undefined)
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
    case 'goldReward':
      return resolveGoldReward(run, seat.playerId)
    case 'potionReward': {
      if (run.phase !== 'reward') fail('The party is not choosing rewards')
      const offer = run.rewards.find((candidate) => candidate.playerId === seat.playerId)
      if (!offer || offer.potion === false) fail('This seat has no Potion reward')
      const decision = action.choice === 'skip' ? { kind: 'skip' }
        : action.choice === 'skipAll' ? { kind: 'skipAll' }
        : action.choice === 'gain' ? { kind: 'gain' }
          : action.choice === 'pass' ? { kind: 'pass', playerId: action.playerId }
            : action.choice === 'replace' ? { kind: 'replace', potionId: action.potionId }
              : null
      if (!decision) fail('Choose a legal Potion reward action')
      const next = resolvePotionReward(run, seat.playerId, decision)
      if (next === run) fail('That Potion reward choice is no longer legal')
      return next
    }
    case 'relicReward': {
      if (!['gain', 'skip'].includes(action.choice)) fail('Choose gain or skip for the Relic reward')
      const next = resolveRelicReward(run, seat.playerId, action.choice === 'gain')
      if (next === run) fail('That Relic reward choice is not legal')
      return next
    }
    case 'bossRelicReward': {
      if (action.choice !== 'gain' && action.choice !== 'skip') {
        fail('Choose gain or skip for the boss Relic reward')
      }
      if (action.choice === 'gain' && typeof action.relicId !== 'string') {
        fail('Choose a revealed boss Relic to gain')
      }
      if (action.choice === 'skip' && action.relicId !== undefined) {
        fail('A boss Relic skip cannot name a Relic')
      }
      const next = resolveBossRelicReward(run, seat.playerId,
        action.choice === 'gain' ? action.relicId : null)
      if (next === run) fail('That boss Relic choice is not legal')
      return next
    }
    case 'tradePotion': {
      const next = tradePotion(run, seat.playerId, action.playerId, action.potionId)
      if (next === run) fail('That Potion trade is not legal')
      return next
    }
    case 'usePotionOutsideCombat': {
      const next = usePotionOutsideCombat(run, seat.playerId, action.potionId,
        typeof action.replacePotionId === 'string' ? action.replacePotionId : undefined)
      if (next === run) fail('That Potion cannot be used now')
      return next
    }
    case 'advanceAct':
      return advanceAct(run)
    case 'switchBetweenCombatRow':
      return switchBetweenCombatRow(run, seat.playerId, action.row)
    case 'startPendingBoss':
      return startPendingBoss(run)
    case 'rerollDownfallSelfBoss': {
      const next = rerollDownfallSelfBoss(run)
      if (next === run) fail('That self-boss cannot be rerolled')
      return next
    }
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
  const run = Array.isArray(room.run?.players) ? room.run : null
  const pendingOwner = run?.players.find((player) => player.relics.some((relic) => relic.pending))
  const pendingRelic = pendingOwner?.relics.find((relic) => relic.pending)
  const giveUpVote = activeGiveUpVote(room)
  const privateStartAbilities = run?.combat?.phase === 'start' ? plannedStartTurnAbilities(room) : undefined
  const startAbilityOwners = new Map(privateStartAbilities?.map((ability) => [ability.id, ability.playerId]) ?? [])
  const visibleStartAbilities = privateStartAbilities?.map((ability) => ({
    ...structuredClone(ability),
    exhaustCards: ability.playerId === viewerId ? structuredClone(ability.exhaustCards) : undefined,
  }))
  const visibleStartChoices = run?.combat?.phase === 'start' && room.startTurnCombatId === run.combat.combatId
    ? (room.startTurnChoices ?? []).map((choice) => ({
      ...structuredClone(choice),
      exhaustUids: startAbilityOwners.get(choice.id) === viewerId ? structuredClone(choice.exhaustUids) : undefined,
    }))
    : undefined

  return {
    code: room.code,
    phase: room.phase,
    ascension: room.ascension,
    chooseYourRelic: room.chooseYourRelic === true,
    lastStand: room.lastStand === true,
    metaOptions: structuredClone(room.metaOptions ?? { mode: 'standard', modifiers: [], quickStartAct: 1 }),
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
    endTurnDecided: Object.entries(room.endTurnReady ?? room.endTurnOrders ?? {})
      .filter(([, decision]) => decision !== false).map(([playerId]) => playerId),
    endTurnAbilities: visibleEndTurnAbilities(room, viewerId),
    startTurnAbilities: visibleStartAbilities,
    startTurnChoiceId: run?.combat?.phase === 'start' ? pendingNoxiousFumes(room)?.id : undefined,
    startTurnEnemyTargets: run?.combat?.phase === 'start' ? savedStartTurnEnemyTargets(room) : undefined,
    startTurnChoices: visibleStartChoices,
    startTurnOrderPending: run?.combat?.phase === 'start' ? startTurnOrderPending(room) : undefined,
    startTurnOrderLocked: run?.combat?.phase === 'start' &&
      room.startTurnCombatId === run.combat.combatId && Array.isArray(room.startTurnOrder),
    startTurnScryAbilities: run?.combat?.phase === 'start'
      ? startTurnScryAbilities(run.combat)
      : undefined,
    startTurnCoordinatorId: run?.combat?.phase === 'start' ? startTurnCoordinator(room) : undefined,
    startTurnScry: run?.combat ? (() => {
      const preview = startTurnScryPreview(run.combat)
      return preview ? {
        ...preview,
        cards: preview.playerId === viewerId ? structuredClone(preview.cards) : null,
      } : undefined
    })() : undefined,
    startTurnDiscard: run?.combat ? (() => {
      const preview = startTurnDiscardPreview(run.combat)
      return preview ? {
        ...preview,
        cards: preview.playerId === viewerId ? structuredClone(preview.cards) : null,
      } : undefined
    })() : undefined,
    discardOrder: viewerId !== null && room.endTurnOrders?.[viewerId]
      ? [...room.endTurnOrders[viewerId]]
      : undefined,
    cardPreview: viewerId !== null && room.cardPreviews?.[viewerId]
      ? structuredClone(room.cardPreviews[viewerId])
      : undefined,
    powerPreview: viewerId !== null && room.powerPreviews?.[viewerId]
      ? structuredClone(room.powerPreviews[viewerId])
      : undefined,
    cardChoicePlayerId: Object.keys(room.cardPreviews ?? {})[0] ??
      Object.keys(room.powerPreviews ?? {})[0] ?? run?.combat?.pendingCardCopy?.playerId,
    merchantPledges: Object.fromEntries(Object.entries(room.merchantPledges ?? {}).map(([key, pledge]) => [key, {
      ...structuredClone(pledge),
      cardUid: pledge.kind === 'removal' && pledge.buyerId !== viewerId ? undefined : pledge.cardUid,
    }])),
    merchantReady: [...(room.merchantReady ?? [])],
    courierPledge: room.courierPledge ? structuredClone(room.courierPledge) : undefined,
    eventPledge: room.eventPledge ? {
      actorId: room.eventPledge.actorId,
      optionId: room.eventPledge.optionId,
      cost: room.eventPledge.cost,
      payments: structuredClone(room.eventPledge.payments),
      decision: room.eventPledge.actorId === viewerId
        ? structuredClone(room.eventPledge.decision)
        : { optionIds: [room.eventPledge.optionId] },
    } : undefined,
    eventCanSkip: viewerId !== null && run ? canSkipEvent(run, viewerId) : false,
    unavailableEventOptionIds: viewerId !== null && run ? unavailableEventOptionIds(run, viewerId) : [],
    giveUpVote: giveUpVote && viewerId && giveUpVote.eligiblePlayerIds.includes(viewerId) ? {
      ...structuredClone(giveUpVote),
      remainingMs: Math.max(0, giveUpVote.deadlineAt - Date.now()),
    } : undefined,
    campaignProgress: {
      version: room.campaignProgress.version,
      characters: structuredClone(room.campaignProgress.characters),
      colorless: room.campaignProgress.colorless,
      actIV: room.campaignProgress.actIV,
      unspentMarks: room.campaignProgress.unspentMarks,
      highestAscension: room.campaignProgress.highestAscension,
      nextRunNumber: room.campaignProgress.nextRunNumber ?? 0,
      finishedRunIds: [...(room.campaignProgress.finishedRunIds ?? [])],
    },
    seats: room.seats.map(seatPublic),
    pendingRelic: viewerId && run ? pendingRelicPreview(run, viewerId) : null,
    pendingRelicStatus: pendingOwner && pendingRelic ? {
      playerId: pendingOwner.id, playerName: pendingOwner.name, relicId: pendingRelic.defId,
    } : null,
    run: run ? redactRun(run, viewerId, room) : null,
  }
}

function visibleEndTurnAbilities(room, viewerId) {
  if (!room.endTurnAbilities) return undefined
  const privateCounts = new Map()
  return room.endTurnAbilities.map((ability) => {
    const visible = {
      ...ability,
      id: publicEndTurnId(room, ability.id),
      targets: ability.targets?.map((target) => ({ ...target })),
    }
    const privateTargets = ability.label.includes('Stasis Engine') && ability.targets?.length
    if (ability.playerId === viewerId || !ability.id.includes('/card:') && !privateTargets) return visible
    const number = (privateCounts.get(ability.playerId) ?? 0) + 1
    privateCounts.set(ability.playerId, number)
    const owner = room.seats.find((seat) => seat.playerId === ability.playerId)?.name ?? 'Teammate'
    return {
      ...visible,
      label: `${owner} — Private hand ability ${number}`,
      targets: privateTargets ? visible.targets?.map((target, index) => ({
        uid: target.uid === 'skip' ? target.uid : `private-card-${index + 1}`,
        label: target.uid === 'skip' ? target.label : `Private card ${index + 1}`,
      })) : visible.targets,
    }
  })
}

function publicEndTurnId(room, id) {
  const publicId = Object.entries(room.endTurnPublicIds ?? {})
    .find(([, realId]) => realId === id)?.[0]
  if (!publicId) fail('End-turn ability mapping is stale')
  return publicId
}

function redactRun(run, viewerId, room) {
  const preparedCombat = run.roomState?.kind === 'event' ? run.roomState.preparedCombat : undefined
  const preparedScry = preparedCombat ? startTurnScryPreview(preparedCombat) : undefined
  const roomState = run.roomState?.kind === 'event'
    ? {
        kind: 'event',
        card: structuredClone(run.roomState.card),
        decisions: Object.fromEntries(Object.entries(run.roomState.decisions).map(([playerId, decision]) => [
          playerId,
          playerId === viewerId ? structuredClone(decision) : { optionIds: [...decision.optionIds] },
        ])),
        dieRolls: structuredClone(run.roomState.dieRolls),
        rewardOffers: structuredClone(run.roomState.rewardOffers ?? {}),
        guardianGemOffers: structuredClone(run.roomState.guardianGemOffers ?? {}),
        itemOffers: structuredClone(run.roomState.itemOffers ?? {}),
        pendingDecisions: viewerId && run.roomState.pendingDecisions?.[viewerId]
          ? { [viewerId]: structuredClone(run.roomState.pendingDecisions[viewerId]) }
          : {},
        pendingRolls: viewerId && run.roomState.pendingRolls?.[viewerId]
          ? { [viewerId]: structuredClone(run.roomState.pendingRolls[viewerId]) }
          : {},
        revealedCards: structuredClone(run.roomState.revealedCards ?? {}),
        revealedCardDefs: structuredClone(run.roomState.revealedCardDefs ?? {}),
        revealedRelics: structuredClone(run.roomState.revealedRelics ?? {}),
        availableRewardSources: structuredClone(run.roomState.availableRewardSources),
        partyOptionIds: structuredClone(run.roomState.partyOptionIds),
        preparedStartTurnScryAbilities: preparedCombat ? startTurnScryAbilities(preparedCombat) : undefined,
        preparedStartTurnScry: preparedScry ? {
          ...preparedScry,
          cards: preparedScry.playerId === viewerId ? structuredClone(preparedScry.cards) : null,
        } : undefined,
        preparedStartTurnCoordinatorId: preparedCombat
          ? room.seats.find((seat) => seat.connected !== false && preparedCombat.players
              .some((player) => player.id === seat.playerId && !player.dead))?.playerId ?? null
          : undefined,
        preparedCombat: run.roomState.preparedCombat
          ? { players: run.roomState.preparedCombat.players.map((player) => ({
              id: player.id,
              hand: player.id === viewerId ? structuredClone(player.hand) : null,
            })),
            enemies: run.roomState.preparedCombat.enemies.map((enemy) => ({
              uid: enemy.uid,
              defId: enemy.defId,
              row: enemy.row,
              isBoss: enemy.isBoss,
              ascension: enemy.ascension,
              hp: enemy.hp,
              maxHp: enemy.maxHp,
              dead: enemy.dead,
            })),
            ...(run.roomState.preparedCombat.pendingHermitSetupLoads?.length ? {
              pendingHermitSetupLoads: structuredClone(run.roomState.preparedCombat.pendingHermitSetupLoads),
            } : {}),
          }
          : undefined,
        pendingTrade: run.roomState.pendingTrade
          ? viewerId === run.roomState.pendingTrade.actorId || viewerId === run.roomState.pendingTrade.targetId
            ? {
              ...structuredClone(run.roomState.pendingTrade),
              decision: viewerId === run.roomState.pendingTrade.actorId
                ? structuredClone(run.roomState.pendingTrade.decision)
                : { optionIds: [...run.roomState.pendingTrade.decision.optionIds], targetPlayerId: run.roomState.pendingTrade.targetId },
            }
            : {
                actorId: run.roomState.pendingTrade.actorId,
                targetId: run.roomState.pendingTrade.targetId,
                kind: run.roomState.pendingTrade.kind,
                offeredId: '',
                decision: { optionIds: [], targetPlayerId: run.roomState.pendingTrade.targetId },
              }
          : undefined,
        labChoices: Object.fromEntries(Object.keys(run.roomState.labChoices ?? {}).map((playerId) => [playerId, playerId === viewerId ? structuredClone(run.roomState.labChoices[playerId]) : { optionIds: ['resolve'] }])),
      }
    : run.roomState?.kind === 'treasure' || run.roomState?.kind === 'elite'
      ? {
          ...structuredClone(run.roomState),
          decisions: Object.fromEntries(Object.entries(run.roomState.decisions).map(([playerId, decision]) => [
            playerId,
            playerId === viewerId || typeof decision === 'number' ? decision : 'skip',
          ])),
        }
      : run.roomState ? structuredClone(run.roomState) : null
  return {
    ascension: run.ascension,
    chooseYourRelic: run.chooseYourRelic,
    lastStand: run.lastStand,
    meta: structuredClone(run.meta ?? { mode: 'standard', modifierIds: [] }),
    setup: run.setup ? structuredClone(run.setup) : null,
    act: run.act,
    phase: run.phase,
    // The dealt faces and face-up rewards are public. The remaining shuffled
    // Blessing deck and queued future rewards stay on the authoritative table.
    neow: run.neow ? {
      players: Object.fromEntries(Object.keys(run.neow.players).map((playerId) => [
        playerId,
        neowPreview(run, playerId, viewerId),
      ])),
    } : null,
    pendingBossDefId: null,
    pendingGuardianSockets: (run.pendingGuardianSockets ?? []).slice(0, 1).map((pending) =>
      pending.playerId === viewerId ? structuredClone(pending) : { playerId: pending.playerId }),
    // Public, unlike `pendingBossDefId`: setup rolls this act's boss in the open
    // before anybody moves, and the map names it so decks can be built for it.
    // The Ascension 13 SECOND Act III boss above stays hidden — that one is not
    // rolled at the table, it is drawn when the first boss falls.
    actBossDefId: run.actBossDefId ?? null,
    canRerollDownfallSelfBoss: canRerollDownfallSelfBoss(run),
    map: visibleMap(run),
    // Public facts only: "Ann played Strike", "Turn 1 begins (die 3)".
    log: run.log,
    players: run.players.map((player) => redactPlayer(player, viewerId)),
    combat: run.combat ? redactCombat(run.combat, viewerId) : null,
    // Card rewards belong to their owner: teammates know a reward exists but
    // never receive the offered cards or the server-side draw bookkeeping.
    rewards: run.rewards.map((offer) => {
      if (offer.playerId === viewerId) return { ...offer, potionQueue: offer.potionQueue?.map(() => null) }
      const {
        choices, cardSource, prismatic, upgraded, rareChoiceIndices, cardsDrawn, raresDrawn,
        drawsReserved, prismaticSources, prismaticDraws, availableSources, guardianGems, potionQueue,
        ...publicOffer
      } = offer
      return { ...publicOffer, choices: null, potionQueue: potionQueue?.map(() => null) }
    }),
    roomState,
    courier: structuredClone(run.courier),
    campaign: {
      runId: run.campaign.runId,
      bossesDefeated: run.campaign.bossesDefeated,
      highestBossActDefeated: run.campaign.highestBossActDefeated,
      keys: structuredClone(run.campaign.keys),
      finalized: run.campaign.finalized,
    },
  }
}

function redactCombat(combat, viewerId) {
  const progress = combat.startTurnProgress
  const triggerPreview = combat.pendingDieRelicChoices?.length ? undefined : pendingTriggerAbility(combat)
  return {
    combatId: combat.combatId,
    turn: combat.turn,
    die: combat.die,
    phase: combat.phase,
    lastStand: combat.lastStand === true,
    potionLimit: combat.potionLimit,
    startTurnStage: combat.startTurnStage,
    powerTriggersUsedThisTurn: combat.powerTriggersUsedThisTurn ?? [],
    pendingTriggers: structuredClone(combat.pendingTriggers ?? []),
    pendingTriggerAbility: triggerPreview?.playerId === viewerId ? structuredClone(triggerPreview) : null,
    // Trigger ids are server allocators, not client state. Masking them also
    // prevents private draw reactions from becoming a count side channel.
    nextTriggerId: 0,
    startTurnProgress: progress ? {
      choices: structuredClone(progress.choices),
      beforeDraw: progress.beforeDraw ? structuredClone(progress.beforeDraw) : undefined,
      rollPending: progress.rollPending ? structuredClone(progress.rollPending) : undefined,
      discard: progress.discard ? {
        playerId: progress.discard.playerId,
        sourceId: progress.discard.sourceId,
        // Draw reactions can reveal the privately drawn card's type. The
        // authoritative queue stays server-side until the owner discards.
        pendingTriggers: [],
      } : undefined,
      forcedCard: progress.forcedCard ? {
        playerId: progress.forcedCard.playerId,
        cardUid: progress.forcedCard.playerId === viewerId ? progress.forcedCard.cardUid : null,
        sourceCardId: progress.forcedCard.sourceCardId ?? 'mayhem',
        sourceLabel: progress.forcedCard.sourceLabel,
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
      deferredTriggers: structuredClone(combat.pendingCardCopy.deferredTriggers ?? []),
      sourceNames: structuredClone(combat.pendingCardCopy.sourceNames),
      virtualOnly: combat.pendingCardCopy.virtualOnly === true,
      queuedWeaves: combat.pendingCardCopy.playerId === viewerId
        ? structuredClone(combat.pendingCardCopy.queuedWeaves ?? [])
        : [],
    } : undefined,
    pendingDistilled: combat.pendingDistilled ? {
      playerId: combat.pendingDistilled.playerId,
      cards: combat.pendingDistilled.playerId === viewerId
        ? structuredClone(combat.pendingDistilled.cards)
        : null,
    } : undefined,
    pendingHermitSetupLoads: structuredClone(combat.pendingHermitSetupLoads ?? []),
    pendingDieRelicChoices: structuredClone(combat.pendingDieRelicChoices ?? []),
    pendingHermitChamberPlays: (combat.pendingHermitChamberPlays ?? []).map((pending) => ({
      playerId: pending.playerId,
      sourceCardId: pending.sourceCardId,
      free: pending.free,
      cardUids: pending.playerId === viewerId ? structuredClone(pending.cardUids) : [],
      cardCount: pending.cardUids.length,
    })),
    pendingHermitStrengthRewards: structuredClone(combat.pendingHermitStrengthRewards ?? []),
    pendingPlunderSwitches: structuredClone(combat.pendingPlunderSwitches ?? []),
    pendingRelicScry: combat.pendingRelicScry ? {
      playerId: combat.pendingRelicScry.playerId,
      relicIndex: combat.pendingRelicScry.relicIndex,
      cards: combat.pendingRelicScry.playerId === viewerId
        ? structuredClone(combat.pendingRelicScry.cards)
        : null,
    } : undefined,
    playedCardsThisTurn: structuredClone(combat.playedCardsThisTurn ?? []),
    presentationEvents: (combat.presentationEvents ?? []).map((event) => ({
      seq: event.seq,
      kind: event.kind,
      actorId: event.actorId,
      sourceId: event.sourceId,
      enemyIds: [...event.enemyIds],
      playerIds: [...event.playerIds],
      ...(event.enemyRow === undefined ? {} : { enemyRow: event.enemyRow }),
      ...(event.kind === 'card' ? {
        upgraded: event.upgraded,
        copied: event.copied,
        energy: event.energy,
        ...(event.mode === undefined ? {} : { mode: event.mode }),
        ...(event.resolvedType === undefined ? {} : { resolvedType: event.resolvedType }),
      } : {}),
      ...(event.kind === 'slime' ? {
        slimeUid: event.slimeUid,
        upgraded: event.upgraded,
        animationIndex: event.animationIndex,
      } : {}),
      ...(event.kind === 'orb' ? { orb: event.orb } : {}),
    })),
    // Pending summons are public telegraphed enemy-card effects; the shuffled
    // Summons deck itself remains server-only.
    pendingSummons: structuredClone(combat.pendingSummons ?? []),
    log: combat.log,
    // Enemies carry nothing secret: hit points, tokens and the cube's position
    // are all printed on the card and face up on the table.
    enemies: combat.enemies.map(({ poisonSources, ...enemy }) => enemy),
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
    nextCardCost: player.nextCardCost ?? null,
    enemyNextCardCost: player.enemyNextCardCost ?? null,
    freeAttacksThisTurn: player.freeAttacksThisTurn ?? 0,
    cardPlayLocked: player.cardPlayLocked === true,
    doubledAttacksThisTurn: player.doubledAttacksThisTurn ?? 0,
    tripledAttacksThisTurn: player.tripledAttacksThisTurn ?? 0,
    doubledCardsThisTurn: player.doubledCardsThisTurn ?? 0,
    doubledSkillsThisTurn: player.doubledSkillsThisTurn ?? 0,
    retainCardsThisTurn: player.retainCardsThisTurn ?? 0,
    cardsPlayedThisTurn: player.cardsPlayedThisTurn ?? 0,
    attacksPlayedThisTurn: player.attacksPlayedThisTurn ?? 0,
    powerPlayedThisTurn: player.powerPlayedThisTurn === true,
    shuffledThisCombat: player.shuffledThisCombat === true,
    facingEnemyUid: player.facingEnemyUid ?? null,
    damageDealtZeroThisTurn: player.damageDealtZeroThisTurn === true,
    shivs: player.shivs,
    shivDamageBonus: player.shivDamageBonus ?? 0,
    cardBlockBonus: player.cardBlockBonus ?? 0,
    hitPoison: player.hitPoison ?? 0,
    starterStrikeDamageBonus: player.starterStrikeDamageBonus ?? 0,
    clawCubesGainedThisCombat: player.clawCubesGainedThisCombat ?? 0,
    starterDefendBlockBonus: player.starterDefendBlockBonus ?? 0,
    miracles: player.miracles,
    stance: player.stance,
    wrathAttackDamageBonus: player.wrathAttackDamageBonus ?? 0,
    orbs: player.orbs,
    orbEvokeBonus: player.orbEvokeBonus ?? 0,
    darkOrbEvokeBonus: player.darkOrbEvokeBonus ?? 0,
    orbEndTurnBonus: player.orbEndTurnBonus ?? 0,
    lightningEndTurnBonus: player.lightningEndTurnBonus ?? 0,
    damageStats: structuredClone(player.damageStats),
    freeGemCardsThisTurn: player.freeGemCardsThisTurn ?? 0,
    freePowersThisTurn: player.freePowersThisTurn ?? 0,
    nextPowerOrSlimeDiscount: player.nextPowerOrSlimeDiscount,
    nextAttackRapidFire: player.nextAttackRapidFire ?? 0,
    energySpentThisTurn: player.energySpentThisTurn ?? 0,
    heat: player.heat ?? 0,
    soulburn: player.soulburn ?? 0,
    soulburnUsedThisTurn: player.soulburnUsedThisTurn === true,
    nextSoulburnDamageBonus: player.nextSoulburnDamageBonus ?? 0,
    exhaustNextCardAfterUid: player.exhaustNextCardAfterUid,
    guardianMode: player.guardianMode ?? null,
    vigor: player.vigor ?? 0,
    vigorSpentThisTurn: player.vigorSpentThisTurn ?? 0,
    guardianModeLocked: player.guardianModeLocked === true,
    slimes: structuredClone(player.slimes ?? []),
    lootChests: player.lootChests ?? 0,
    dead: player.dead,
    // Face up on the table.
    discard: player.discard,
    exhaust: player.exhaust,
    powers: player.powers,
    relics: mine ? player.relics : player.relics.map(({ guardianGemGroups: _private, ...relic }) => relic),
    potions: player.potions,
    chamberSlots: player.chamberSlots ?? 0,
    chamberCount: player.chamber?.length ?? 0,
    // Sizes are public — you can see how big a stack is — but not contents.
    handCount: player.hand.length,
    drawCount: player.draw.length,
    deckCount: player.deck.length,
    tradableDeckCount: player.deck.filter((card) => card.defId !== 'ascenders_bane').length,
    // Face-down reward stacks, secret even from their owner until drawn.
    cardRewardCount: player.cardRewards.length,
    rareRewardCount: player.rareRewards.length,
    // Yours alone. Never the draw pile: it is shuffled and face down, and its
    // owner is no more entitled to read ahead than anyone else.
    hand: mine ? player.hand : null,
    chamber: mine ? player.chamber ?? [] : null,
    deck: mine ? player.deck : null,
  }
}
