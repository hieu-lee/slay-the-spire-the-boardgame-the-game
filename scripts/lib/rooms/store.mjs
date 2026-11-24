// Durable room store loading, journal replay/repair, persistence, and room
// creation.

import { randomBytes } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { isRemovedHeroRun, mergeLeaderboardRuns, restoreLeaderboardRuns } from '../leaderboard.mjs'
import { restoreMail } from '../mail.mjs'
import {
  classificationRecord,
  deckHash,
  HERO_NAMES,
  INITIAL_DECK_CLASSIFICATIONS,
  INITIAL_DECK_TYPES,
  isRemovedHero,
  isRemovedHeroDeckType,
  recordDeckClassification,
  statsDecks,
  validClassifierThreadId,
  validDeckType,
  validSoloDeck,
} from '../stats.mjs'
import {
  advanceDeterministicEndTurnChoices,
  grantLegacyNeowGold,
  migrateLegacyBossRareRewards,
  migratePendingRelicRewardDraws,
  normalizeModifierIds,
  parseCampaignProgress,
  revealRewardItems,
  rulesetForCharacters,
} from '../../../src/game/state.ts'
import { refreshCombatRelic } from '../../../src/game/relics.ts'
import { normalizeCardPacks } from '../../../src/game/packs.ts'
import { isSkinOf } from '../../../src/game/skins.ts'
import { MAX_BOSS_AWARDS } from '../../../src/game/coins.ts'
import { restoreCoinGrants } from '../coin-grants.mjs'
import {
  assignPendingRelicIds,
  fail,
  LEGACY_DECK_TYPES,
  MAX_RECORDED_RUNS,
  normalizeLegacyPlayer,
  publishEndTurnEffect,
  roomCode,
  roomHasRemovedHero,
  token,
} from './shared.mjs'
import { migrateLegacyCardPreviews } from './previews.mjs'

function readJournal(store, path) {
  let buffer
  try { buffer = readFileSync(path) } catch (error) {
    if (error?.code === 'ENOENT') return ''
    throw error
  }
  const validBytes = buffer.lastIndexOf(10) + 1
  if (validBytes === buffer.length) return buffer.toString('utf8')
  let complete = false
  try { JSON.parse(buffer.subarray(validBytes).toString('utf8')); complete = true } catch {}
  store.interruptedJournals.set(path, { buffer, validBytes, complete })
  return complete ? `${buffer.toString('utf8')}\n` : buffer.subarray(0, validBytes).toString('utf8')
}

export function repairInterruptedJournals(store) {
  for (const [path, { buffer, validBytes, complete }] of store.interruptedJournals) {
    if (!readFileSync(path).equals(buffer)) throw new Error(`Journal changed during recovery: ${path}`)
    if (complete) appendFileSync(path, '\n', { mode: 0o600 })
    else {
      writeFileSync(`${path}.partial-${randomBytes(8).toString('hex')}`, buffer.subarray(validBytes), { mode: 0o600, flag: 'wx' })
      truncateSync(path, validBytes)
      console.warn(`Preserved an incomplete journal tail from ${path}`)
    }
    store.interruptedJournals.delete(path)
  }
}

function appendJournal(store, path, entries) {
  let descriptor
  try { descriptor = openSync(path, 'r') } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (descriptor !== undefined) {
    try {
      const size = fstatSync(descriptor).size
      if (size) {
        const lastByte = Buffer.alloc(1)
        if (readSync(descriptor, lastByte, 0, 1, size - 1) !== 1) throw new Error(`Journal changed during append: ${path}`)
        if (lastByte[0] !== 10) {
          readJournal(store, path)
          repairInterruptedJournals(store)
        }
      }
    } finally { closeSync(descriptor) }
  }
  appendFileSync(path, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n', { mode: 0o600 })
}

export function createStore({ file, restartRecovery = false, restartReconnectMs = 5 * 60_000 } = {}) {
  const store = { rooms: new Map(), leaderboardRuns: [], statsRuns: [], leaderboardRevision: 0, leaderboardDirty: true, leaderboardChanges: new Map(),
    statsStateDirty: true, statsChanges: new Map(), interruptedJournals: new Map(),
    deckTypes: [...INITIAL_DECK_TYPES], deckClassificationBudget: { day: -1, used: 0 },
    deckClassifierThreadId: undefined, deckClassifierRelease: undefined, profiles: [], mail: [], mailDirty: false, file, reconnectQuorums: new Map(),
    // Runs recorded before this moment are paid by a one-time coin grant (coin-grants.mjs);
    // set once, the first time a server with the Shop starts, and kept from then on.
    coinsLaunchedAt: Date.now(), coinGrants: [] }
  if (!file) return store
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    if (!Array.isArray(saved?.rooms)) throw new Error('rooms must be an array')
    const legacyRuns = restoreLeaderboardRuns(saved.leaderboardRuns)
    let archive
    try { archive = JSON.parse(readFileSync(`${file}.leaderboard.json`, 'utf8')) } catch (error) {
      if (error?.code === 'ENOENT' && saved.leaderboardArchive) throw new Error('Leaderboard archive is missing')
      if (error?.code !== 'ENOENT') throw error
    }
    if (archive !== undefined && !Array.isArray(archive)) throw new Error('Leaderboard archive must be an array')
    const archivedRuns = restoreLeaderboardRuns(archive)
    if (archive !== undefined && archivedRuns.length !== archive.filter((run) => !isRemovedHeroRun(run)).length)
      throw new Error('Leaderboard archive has invalid runs')
    const journal = readJournal(store, `${file}.leaderboard.log`)
    if (archive === undefined && existsSync(`${file}.leaderboard.log`)) throw new Error('Leaderboard archive is missing for its log')
    const archivedById = new Map(archivedRuns.map((run) => [run.id, run]))
    const journalIds = new Set()
    for (const line of journal.split('\n')) {
      if (!line) continue
      const entry = JSON.parse(line)
      if (isRemovedHeroRun(entry)) continue
      const [run] = restoreLeaderboardRuns([entry])
      if (!run) throw new Error('Leaderboard log contains an invalid run')
      archivedById.set(run.id, run)
      journalIds.add(run.id)
    }
    store.leaderboardRuns = mergeLeaderboardRuns(legacyRuns, [...archivedById.values()], {
      preferLegacyRuns: !saved.leaderboardArchive, journalIds,
    })
    store.statsRuns = store.leaderboardRuns.flatMap(statsDecks)
    store.leaderboardDirty = archive === undefined
    if (!store.leaderboardDirty && legacyRuns.length)
      for (const run of store.leaderboardRuns)
        if (JSON.stringify(run) !== JSON.stringify(archivedById.get(run.id))) store.leaderboardChanges.set(run.id, run)
    if (Array.isArray(saved.deckTypes)) store.deckTypes = [...new Set([...store.deckTypes, ...saved.deckTypes.filter(validDeckType)])]
    if (Number.isSafeInteger(saved.deckClassificationBudget?.day) && Number.isSafeInteger(saved.deckClassificationBudget?.used) && saved.deckClassificationBudget.used >= 0)
      store.deckClassificationBudget = saved.deckClassificationBudget
    if (validClassifierThreadId(saved.deckClassifierThreadId) && typeof saved.deckClassifierRelease === 'string') {
      store.deckClassifierThreadId = saved.deckClassifierThreadId
      store.deckClassifierRelease = saved.deckClassifierRelease
    }
    let statsState
    try { statsState = JSON.parse(readFileSync(`${file}.stats.json`, 'utf8')) } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    if (statsState !== undefined) {
      if (Array.isArray(statsState?.deckTypes)) statsState.deckTypes = statsState.deckTypes.filter((type) => !isRemovedHeroDeckType(type))
      if (!Array.isArray(statsState?.deckTypes) || statsState.deckTypes.some((type) => !validDeckType(type)) ||
          !Number.isSafeInteger(statsState.deckClassificationBudget?.day) ||
          !Number.isSafeInteger(statsState.deckClassificationBudget?.used) || statsState.deckClassificationBudget.used < 0 ||
          statsState.deckClassifierThreadId !== undefined && (!validClassifierThreadId(statsState.deckClassifierThreadId) ||
          typeof statsState.deckClassifierRelease !== 'string') ||
          statsState.deckClassifierRelease !== undefined && typeof statsState.deckClassifierRelease !== 'string')
        throw new Error('Stats state is invalid')
      store.deckTypes = [...new Set([...store.deckTypes, ...statsState.deckTypes])]
      if (statsState.deckClassifierRelease !== undefined) {
        store.deckClassifierThreadId = statsState.deckClassifierThreadId
        store.deckClassifierRelease = statsState.deckClassifierRelease
      }
      const currentBudget = store.deckClassificationBudget
      const backedUpBudget = statsState.deckClassificationBudget
      if (backedUpBudget.day > currentBudget.day ||
          backedUpBudget.day === currentBudget.day && backedUpBudget.used > currentBudget.used)
        store.deckClassificationBudget = backedUpBudget
      store.statsStateDirty = store.deckTypes.length !== statsState.deckTypes.length ||
        store.deckClassificationBudget.day !== backedUpBudget.day ||
        store.deckClassificationBudget.used !== backedUpBudget.used ||
        store.deckClassifierThreadId !== statsState.deckClassifierThreadId ||
        store.deckClassifierRelease !== statsState.deckClassifierRelease
    }
    const statsLog = readJournal(store, `${file}.stats.log`)
    const logged = new Map()
    const knownTypes = new Set(store.deckTypes)
    for (const line of statsLog.split('\n')) {
      if (!line) continue
      const record = JSON.parse(line)
      if (isRemovedHero(record?.hero)) continue
      if (typeof record?.id !== 'string' || !Object.hasOwn(HERO_NAMES, record.hero) || !/^[0-9a-f]{64}$/.test(record.hash) ||
          record.deckType !== undefined && !validDeckType(record.deckType) ||
          record.retry !== undefined && (!Number.isSafeInteger(record.retry?.after) || record.retry.after < 0 ||
          !/^[0-9a-f]{64}$/.test(record.retry.hash))) throw new Error('Stats log is invalid')
      logged.set(record.id, record)
    }
    for (const run of store.statsRuns) {
      const record = logged.get(run.id)
      if (record?.hero === run.character && record.hash === deckHash(run)) {
        if (!run.deckType && record.deckType) { run.deckType = record.deckType; delete run.deckClassificationRetry }
        else if (!run.deckType && record.retry &&
            (!run.deckClassificationRetry || record.retry.after >= run.deckClassificationRetry.after))
          run.deckClassificationRetry = record.retry
      }
      if (run.deckType || run.deckClassificationRetry) {
        const latest = classificationRecord(run)
        if (JSON.stringify(latest) !== JSON.stringify(record)) store.statsChanges.set(run.id, latest)
      }
      if (run.deckType && !knownTypes.has(run.deckType)) {
        knownTypes.add(run.deckType)
        store.deckTypes.push(run.deckType)
        store.statsStateDirty = true
      }
    }
    store.profiles = saved.profiles ?? []
    if (Number.isSafeInteger(saved.coinsLaunchedAt) && saved.coinsLaunchedAt > 0) store.coinsLaunchedAt = saved.coinsLaunchedAt
    store.coinGrants = restoreCoinGrants(saved.coinGrants)
    for (const room of saved.rooms) {
      if (typeof room?.code === 'string' && Array.isArray(room.seats) && room.campaignProgress && !roomHasRemovedHero(room)) {
        const connectedAtSave = new Set(room.seats
          .filter((seat) => seat.connected !== false).map((seat) => seat.playerId))
        const seatIds = new Set(room.seats.map((seat) => seat.playerId))
        const savedQuorum = saved.reconnectQuorums?.[room.code]
        const unresolvedAtSave = Array.isArray(savedQuorum?.playerIds) && savedQuorum.expiresAt > Date.now()
          ? savedQuorum.playerIds.filter((playerId) => seatIds.has(playerId)) : []
        const recoverySeats = new Set([...connectedAtSave, ...unresolvedAtSave])
        if (restartRecovery && recoverySeats.size > 0) {
          store.reconnectQuorums.set(room.code, { playerIds: recoverySeats, expiresAt: Date.now() + restartReconnectMs })
        }
        room.seats = room.seats.map((seat) => {
          const { cardPacks, skin, ...rest } = seat
          const packs = normalizeCardPacks(cardPacks)
          return { ...rest, ...(isSkinOf(seat.character, skin) ? { skin } : {}), ...(packs.length ? { cardPacks: packs } : {}), connected: false }
        })
        room.campaignProgress = parseCampaignProgress(room.campaignProgress)
        room.campaignBaseProgress = parseCampaignProgress(room.campaignBaseProgress, room.campaignProgress)
        // The Daily Climb is a solo shared-seed run; a lobby saved on Daily reopens on Standard.
        room.metaOptions = room.metaOptions && ['standard', 'custom'].includes(room.metaOptions.mode)
          ? { mode: room.metaOptions.mode, modifiers: normalizeModifierIds(room.metaOptions.modifiers), quickStartAct: [1, 2, 3, 4].includes(room.metaOptions.quickStartAct) ? room.metaOptions.quickStartAct : 1 }
          : { mode: 'standard', modifiers: [], quickStartAct: 1 }
        room.chooseYourRelic = room.chooseYourRelic === true
        room.lastStand = room.lastStand === true && room.seats.length > 1
        // Recorded runs' unclaimed shares: only well-formed ones, only for seats still here.
        const tokens = new Set(room.seats.map((seat) => seat.token))
        const recordedValid = (recorded) => recorded && typeof recorded.runId === 'string' && Array.isArray(recorded.bossCoins) &&
          recorded.bossCoins.length <= MAX_BOSS_AWARDS && recorded.bossCoins.every((award) => award && Number.isSafeInteger(award.coins) && award.coins >= 0) &&
          recorded.skips && typeof recorded.skips === 'object' && !Array.isArray(recorded.skips) &&
          Object.values(recorded.skips).every((skip) => Number.isSafeInteger(skip) && skip >= 0)
        const recordedRuns = (Array.isArray(room.recordedRuns) ? room.recordedRuns : [])
          .filter(recordedValid).slice(-MAX_RECORDED_RUNS)
          .map((recorded) => ({ ...recorded, skips: Object.fromEntries(Object.entries(recorded.skips).filter(([token]) => tokens.has(token))) }))
          .filter((recorded) => Object.keys(recorded.skips).length > 0)
        if (recordedRuns.length) room.recordedRuns = recordedRuns
        else delete room.recordedRuns
        if (room.run) {
          for (const player of room.run.players ?? []) {
            normalizeLegacyPlayer(player)
            // Older servers left spent combat relics face down between fights; an active combat keeps its own state.
            if (room.run.phase !== 'combat') player.relics = player.relics.map(refreshCombatRelic)
          }
          assignPendingRelicIds(room.run)
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
          if (room.run.meta.cardPacks !== undefined) {
            const packs = normalizeCardPacks(room.run.meta.cardPacks)
            if (packs.length) room.run.meta.cardPacks = packs
            else delete room.run.meta.cardPacks
          }
          room.run.setup ??= null
          room.run.lastStand = room.run.lastStand == null ? room.lastStand : room.run.lastStand === true
          if (room.run.combat) {
            room.run.combat.lastStand = room.run.combat.lastStand === true
            if (room.run.combat.potionLimit !== 2 && room.run.combat.potionLimit !== 3) {
              room.run.combat.potionLimit = room.run.ascension >= 4 ? 2 : 3
            }
            if (!Number.isInteger(room.run.combat.nextTriggerId)) room.run.combat.nextTriggerId = 0
            for (const copy of [room.run.combat.pendingCardCopy, ...(room.concurrentCardCopies ?? [])]) {
              if (copy && !Number.isInteger(copy.id)) copy.id = room.run.combat.nextTriggerId++
            }
            for (const scry of [room.run.combat.pendingRelicScry, ...(room.concurrentRelicScries ?? [])]) {
              if (scry && !Number.isInteger(scry.id)) scry.id = room.run.combat.nextTriggerId++
            }
            for (const preview of Object.values(room.powerPreviews ?? {})) {
              if (!Number.isInteger(preview.id)) preview.id = room.run.combat.nextTriggerId++
            }
            for (const choice of room.run.combat.pendingDieRelicChoices ?? []) {
              if (!Number.isInteger(choice.id)) choice.id = room.run.combat.nextTriggerId++
            }
            // Older saves recorded only yes votes, so restore the quorum that
            // was connected when saved rather than letting reconnect shrink it.
            if (room.run.combat.phase === 'start') {
              // Start-turn requirements are derived from the live board. Older
              // saves may contain votes for effects that are deterministic now.
              room.startTurnRequired = undefined
              room.startTurnReady = undefined
            }
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
              room.endTurnAbilities = undefined
              room.endTurnPublicIds = undefined
              room.endTurnOrders = undefined
              room.endTurnOrder = undefined
              room.run.combat = advanceDeterministicEndTurnChoices(room.run.combat)
              if (room.run.combat.endTurnProgress?.interactive) publishEndTurnEffect(room)
            }
          }
          const migratedRewards = revealRewardItems(migratePendingRelicRewardDraws(migrateLegacyBossRareRewards(room.run)))
          if (migratedRewards !== room.run) {
            room.run = migratedRewards
            room.rewardChoices = undefined
            room.rewardConfirmed = undefined
          }
          migrateLegacyCardPreviews(room)
          const runNumber = Number(/^campaign-(\d+)$/.exec(room.run.campaign?.runId ?? '')?.[1])
          const fallback = {
            ...room.campaignProgress,
            nextRunNumber: Number.isSafeInteger(runNumber)
              ? Math.max(room.campaignProgress.nextRunNumber, runNumber)
              : room.campaignProgress.nextRunNumber,
          }
          room.run.campaignProgress = parseCampaignProgress(room.run.campaignProgress, fallback)
          if (room.run.phase === 'neow' && room.run.neow?.players) {
            room.run = grantLegacyNeowGold(room.run)
            for (const progress of Object.values(room.run.neow.players)) {
              if (!progress || typeof progress !== 'object') continue
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
    const evidenced = new Set(store.statsRuns.map((run) => run.deckType).filter(Boolean))
    const retained = store.deckTypes.filter((type) => !LEGACY_DECK_TYPES.has(type) ||
      INITIAL_DECK_TYPES.includes(type) || evidenced.has(type))
    if (retained.length !== store.deckTypes.length) {
      store.deckTypes = retained
      store.statsStateDirty = true
    }
    for (const run of store.statsRuns) {
      if (run.deckType || !validSoloDeck(run)) continue
      const type = INITIAL_DECK_CLASSIFICATIONS.get(deckHash(run))
      if (!type?.startsWith(`${HERO_NAMES[run.character]} `)) continue
      run.deckType = type
      delete run.deckClassificationRetry
      recordDeckClassification(store, run)
    }
  } catch (error) {
    if (error?.code !== 'ENOENT' || existsSync(`${file}.leaderboard.json`) || existsSync(`${file}.leaderboard.log`) ||
        existsSync(`${file}.stats.json`) || existsSync(`${file}.stats.log`) || existsSync(`${file}.mail.json`)) {
      throw new Error(`Could not load room store: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  // Its own file, written only when a letter changes: the main store is
  // rewritten after every room action and must not carry the whole archive.
  try { store.mail = restoreMail(JSON.parse(readFileSync(`${file}.mail.json`, 'utf8'))) } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error(`Could not load mail: ${error instanceof Error ? error.message : String(error)}`)
  }
  return store
}

export function saveStore(store) {
  if (!store.file) return
  mkdirSync(dirname(store.file), { recursive: true })
  const temporary = `${store.file}.tmp`
  const reconnectQuorums = Object.fromEntries([...store.reconnectQuorums].map(([code, quorum]) => [code, {
    playerIds: [...quorum.playerIds], expiresAt: quorum.expiresAt,
  }]))
  const main = { version: 1, rooms: [...store.rooms.values()], deckTypes: store.deckTypes,
    deckClassificationBudget: store.deckClassificationBudget, deckClassifierThreadId: store.deckClassifierThreadId,
    deckClassifierRelease: store.deckClassifierRelease, profiles: store.profiles, reconnectQuorums,
    coinsLaunchedAt: store.coinsLaunchedAt, coinGrants: store.coinGrants }
  if (!existsSync(store.file) || store.leaderboardDirty) {
    writeFileSync(temporary, JSON.stringify({ ...main, leaderboardRuns: store.leaderboardRuns }), { mode: 0o600 })
    renameSync(temporary, store.file)
  }
  repairInterruptedJournals(store)
  const archive = `${store.file}.leaderboard.json`
  if (store.leaderboardDirty) {
    const archiveTemporary = `${archive}.tmp`
    writeFileSync(archiveTemporary, JSON.stringify(store.leaderboardRuns), { mode: 0o600 })
    renameSync(archiveTemporary, archive)
    store.leaderboardDirty = false
    store.leaderboardChanges.clear()
  } else if (store.leaderboardChanges.size) {
    appendJournal(store, `${store.file}.leaderboard.log`, [...store.leaderboardChanges.values()])
    store.leaderboardChanges.clear()
  }
  if (store.statsChanges.size) {
    appendJournal(store, `${store.file}.stats.log`, [...store.statsChanges.values()])
    store.statsChanges.clear()
  }
  if (store.statsStateDirty) {
    const statsTemporary = `${store.file}.stats.json.tmp`
    writeFileSync(statsTemporary, JSON.stringify({ deckTypes: store.deckTypes, deckClassificationBudget: store.deckClassificationBudget,
      deckClassifierThreadId: store.deckClassifierThreadId, deckClassifierRelease: store.deckClassifierRelease }), { mode: 0o600 })
    renameSync(statsTemporary, `${store.file}.stats.json`)
    store.statsStateDirty = false
  }
  writeFileSync(temporary, JSON.stringify({ ...main, leaderboardArchive: true }), { mode: 0o600 })
  renameSync(temporary, store.file)
  // Last, and marked clean only once written: a save that fails anywhere
  // before this leaves mail dirty, so a letter taken back after the failure
  // is never left behind on disk.
  if (store.mailDirty) {
    const mailTemporary = `${store.file}.mail.json.tmp`
    writeFileSync(mailTemporary, JSON.stringify(store.mail), { mode: 0o600 })
    renameSync(mailTemporary, `${store.file}.mail.json`)
    store.mailDirty = false
  }
}

export function createRoom(store, options = {}) {
  const code = options.code ?? roomCode(options.random)
  // Silently replacing a live room would drop everyone seated in it.
  if (store.rooms.has(code)) fail(`Room ${code} already exists`)
  const campaignProgress = parseCampaignProgress(options.campaignProgress)
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
    campaignBaseProgress: structuredClone(campaignProgress),
    campaignProgress,
    /** Bumped on every accepted mutation so clients can drop stale frames. */
    version: 0,
  }
  store.rooms.set(code, room)
  return room
}
