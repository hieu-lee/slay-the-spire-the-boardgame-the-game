import { primeStatsDeck, soloDeck, validDeckType } from './stats.mjs'

const CHARACTERS = new Set(['ironclad', 'silent', 'defect', 'watcher', 'slime_boss', 'guardian', 'hexaghost', 'hermit'])
const CHARACTER_ORDER = [...CHARACTERS]
const MODES = new Set(['standard', 'daily', 'custom'])
const compareNames = new Intl.Collator('en', { sensitivity: 'base' }).compare
export const MAX_LEADERBOARD_RUNS = 20_000

const bad = (message) => { throw Object.assign(new Error(message), { status: 400 }) }
const integer = (value, name, minimum, maximum) => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) bad(`${name} is invalid`)
  return value
}

function finalDeck(value) {
  if (!Array.isArray(value) || value.length > 1000) bad('Final deck is invalid')
  return value.map((card) => {
    if (!card || typeof card.defId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(card.defId) ||
        typeof card.upgraded !== 'boolean' || card.attachedGemId !== undefined &&
        (typeof card.attachedGemId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(card.attachedGemId))) bad('Final deck card is invalid')
    return { defId: card.defId, upgraded: card.upgraded,
      ...(card.attachedGemId === undefined ? {} : { attachedGemId: card.attachedGemId }) }
  })
}

function personalDecks(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) bad('Winning decks are invalid')
  const heroes = new Set()
  return value.map((deck) => {
    if (!deck || typeof deck.username !== 'string' || deck.username.length > 24 ||
        !CHARACTERS.has(deck.character) || heroes.has(deck.character)) bad('Winning deck owner is invalid')
    heroes.add(deck.character)
    return { username: deck.username, character: deck.character, finalDeck: finalDeck(deck.finalDeck) }
  })
}

function characters(value) {
  const party = value.characters ?? [value.character]
  if (!Array.isArray(party) || party.length < 1 || party.length > 4 ||
      new Set(party).size !== party.length || party.some((character) => !CHARACTERS.has(character))) bad('Heroes are invalid')
  return [...party].sort((left, right) => CHARACTER_ORDER.indexOf(left) - CHARACTER_ORDER.indexOf(right))
}

export function normalizeLeaderboardRun(value, recordedAt = Date.now()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) bad('Leaderboard run must be an object')
  if (typeof value.id !== 'string' || !/^[a-zA-Z0-9:_-]{8,160}$/.test(value.id)) bad('Run id is invalid')
  if (!MODES.has(value.mode)) bad('Run mode is invalid')
  const party = characters(value)
  const run = {
    id: value.id,
    ...(typeof value.username === 'string' && value.username.length <= 24 ? { username: value.username } : {}),
    ...(value.finalDeck !== undefined ? { finalDeck: finalDeck(value.finalDeck) } : {}),
    ...(value.winningDecks !== undefined ? { winningDecks: personalDecks(value.winningDecks) } : {}),
    character: party[0],
    characters: party,
    ascension: integer(value.ascension, 'Ascension', 0, 13),
    mode: value.mode,
    damageStatsComplete: value.damageStatsComplete === true,
    startedAtAct: integer(value.startedAtAct, 'Starting act', 1, 4),
    highestBossActDefeated: integer(value.highestBossActDefeated, 'Highest boss act', 0, 4),
    combatsFinished: integer(value.combatsFinished, 'Combat count', 0, 1000),
    damageDealt: integer(value.damageDealt, 'Damage dealt', 0, 1_000_000_000),
    damageTaken: integer(value.damageTaken, 'Damage taken', 0, 1_000_000_000),
    damageBlocked: integer(value.damageBlocked, 'Damage blocked', 0, 1_000_000_000),
    floorsCleared: value.floorsCleared == null
      ? null : integer(value.floorsCleared, 'Floor count', 0, 1000),
    recordedAt: integer(recordedAt, 'Recorded time', 0, Number.MAX_SAFE_INTEGER),
  }
  primeStatsDeck(run)
  return run
}

export function restoreLeaderboardRuns(values) {
  if (!Array.isArray(values)) return []
  const restored = []
  for (const value of values) {
    try {
      const run = normalizeLeaderboardRun(value, value?.recordedAt)
      if (validDeckType(value?.deckType)) run.deckType = value.deckType
      if (Number.isSafeInteger(value?.deckClassificationRetry?.after) && value.deckClassificationRetry.after >= 0 &&
          /^[0-9a-f]{64}$/.test(value.deckClassificationRetry.hash))
        run.deckClassificationRetry = { after: value.deckClassificationRetry.after, hash: value.deckClassificationRetry.hash }
      if (run.recordedAt === 1790025582194 && run.characters.join(',') === 'defect,watcher' &&
          run.finalDeck?.length === 36 && run.finalDeck[22]?.defId === 'strike_watcher') {
        run.winningDecks = [
          { username: 'BestDefect2002', character: 'defect', finalDeck: run.finalDeck.slice(0, 22) },
          { username: 'phuotthu', character: 'watcher', finalDeck: run.finalDeck.slice(22) },
        ]
        delete run.finalDeck
      }
      restored.push(run)
    } catch { /* Ignore a damaged historical row, not the whole room store. */ }
  }
  return restored
}

export function addLeaderboardRun(store, value, recordedAt = Date.now()) {
  const run = normalizeLeaderboardRun(value, recordedAt)
  const existing = store.leaderboardRuns.findIndex((entry) => entry.id === run.id)
  if (existing >= 0) {
    const previous = store.leaderboardRuns[existing]
    if (run.winningDecks) {
      const updated = { ...run, recordedAt: previous.recordedAt }
      if (updated.character === previous.character && JSON.stringify(soloDeck(updated)) === JSON.stringify(soloDeck(previous))) {
        if (previous.deckType) updated.deckType = previous.deckType
        if (previous.deckClassificationRetry) updated.deckClassificationRetry = previous.deckClassificationRetry
      }
      if (Object.keys(updated).every((key) => JSON.stringify(updated[key]) === JSON.stringify(previous[key])) &&
          Object.keys(previous).every((key) => Object.hasOwn(updated, key))) return false
      store.leaderboardRuns[existing] = updated
      return true
    }
    if (previous.winningDecks) return false
    const updates = {
      ...(previous.floorsCleared == null && run.floorsCleared != null ? { floorsCleared: run.floorsCleared } : {}),
      ...(previous.finalDeck === undefined && run.finalDeck !== undefined ? { finalDeck: run.finalDeck } : {}),
      ...(previous.username === undefined && run.username !== undefined ? { username: run.username } : {}),
    }
    if (Object.keys(updates).length) {
      const updated = { ...previous, ...updates }
      if (JSON.stringify(soloDeck(updated)) !== JSON.stringify(soloDeck(previous))) {
        delete updated.deckType
        delete updated.deckClassificationRetry
      }
      store.leaderboardRuns[existing] = updated
      return true
    }
    return false
  }
  if (store.leaderboardRuns.length >= MAX_LEADERBOARD_RUNS) {
    throw Object.assign(new Error('Leaderboard capacity reached'), { status: 503 })
  }
  store.leaderboardRuns.push(run)
  return true
}

export function leaderboardSnapshot(runs) {
  const groups = new Map()
  for (const run of runs) {
    const key = `${run.characters.join(',')}:${run.ascension}`
    const row = groups.get(key) ?? {
      character: run.character,
      characters: run.characters,
      ascension: run.ascension,
      runs: 0,
      act3Runs: 0,
      act3Wins: 0,
      act4Wins: 0,
      combatsFinished: 0,
      damageDealt: 0,
      damageTaken: 0,
      damageBlocked: 0,
      floorRuns: 0,
      floorsCleared: 0,
    }
    row.runs += 1
    if (run.startedAtAct <= 3) {
      row.act3Runs += 1
      if (run.highestBossActDefeated >= 3) row.act3Wins += 1
    }
    if (run.highestBossActDefeated >= 4) row.act4Wins += 1
    if (run.damageStatsComplete) {
      row.combatsFinished += run.combatsFinished
      row.damageDealt += run.damageDealt
      row.damageTaken += run.damageTaken
      row.damageBlocked += run.damageBlocked
    }
    if (run.floorsCleared != null) {
      row.floorRuns += 1
      row.floorsCleared += run.floorsCleared
    }
    groups.set(key, row)
  }
  const rows = [...groups.values()].map((row) => ({
    character: row.character,
    characters: row.characters,
    ascension: row.ascension,
    runs: row.runs,
    act3Runs: row.act3Runs,
    act3Wins: row.act3Wins,
    act3WinRate: row.act3Runs ? row.act3Wins / row.act3Runs : null,
    averageDamagePerFight: row.combatsFinished ? row.damageDealt / row.combatsFinished : null,
    averageDamageBlocked: row.damageTaken + row.damageBlocked
      ? row.damageBlocked / (row.damageTaken + row.damageBlocked) : null,
    averageFloorsCleared: row.floorRuns ? row.floorsCleared / row.floorRuns : null,
    act4Wins: row.act4Wins,
  })).sort((left, right) =>
    (right.act3WinRate ?? -1) - (left.act3WinRate ?? -1) ||
    right.act4Wins - left.act4Wins ||
    (right.averageDamagePerFight ?? -1) - (left.averageDamagePerFight ?? -1) ||
    right.runs - left.runs || left.characters.join(',').localeCompare(right.characters.join(',')) || left.ascension - right.ascension)
  return { totalRuns: runs.length, rows }
}

/** Public archive pages expose no installation IDs, profile tokens, or active runs. */
export function winningDecksPage(runs, params = new URLSearchParams()) {
  const sort = params.get('sort') ?? 'recordedAt'
  const direction = params.get('direction') ?? 'desc'
  const requestedCharacters = params.getAll('character')
  const selectedCharacters = requestedCharacters.length === 0 || requestedCharacters.length === 1 && requestedCharacters[0] === 'all'
    ? [] : requestedCharacters
  const ascension = params.get('ascension') ?? 'all'
  const cursor = params.get('cursor')
  if (!['character', 'ascension', 'cardCount', 'username', 'recordedAt'].includes(sort) ||
      !['asc', 'desc'].includes(direction) || new Set(selectedCharacters).size !== selectedCharacters.length ||
      selectedCharacters.some((character) => !CHARACTERS.has(character)) ||
      ascension !== 'all' && !/^(?:[0-9]|1[0-3])$/.test(ascension) ||
      cursor !== null && !/^(?:0|[1-9][0-9]{0,5})(?::[0-3])?$/.test(cursor)) bad('Invalid winning deck query')
  const value = entry => sort === 'cardCount' ? entry.finalDeck.length
    : sort === 'character' ? entry.characters.join(',')
    : sort === 'username' ? entry.username : entry.run[sort]
  // The archive is capped at 20,000 runs; sort metadata before copying one page.
  const eligible = runs.flatMap((run, index) => Array.isArray(run.winningDecks)
    ? run.winningDecks.map((deck, deckIndex) => ({ run, index: `${index}:${deckIndex}`,
      order: index * 4 + deckIndex, username: deck.username, characters: [deck.character], finalDeck: deck.finalDeck }))
    : Array.isArray(run.finalDeck) ? [{ run, index: String(index), username: run.username ?? 'Unknown',
      order: index * 4, characters: run.characters, finalDeck: run.finalDeck }] : [])
    .filter(({ run, characters }) => run.highestBossActDefeated >= 3 &&
      (selectedCharacters.length === 0 || selectedCharacters.some((character) => characters.includes(character))) &&
      (ascension === 'all' || run.ascension === Number(ascension)))
    .sort((a, b) => {
      const left = value(a), right = value(b)
      const compared = typeof left === 'string' ? compareNames(left, right) : left - right
      return compared * (direction === 'asc' ? 1 : -1) || b.run.recordedAt - a.run.recordedAt || b.order - a.order
    })
  const previous = cursor === null ? -1 : eligible.findIndex(entry => entry.index === cursor)
  if (cursor !== null && previous < 0) bad('Winning deck cursor is no longer available')
  const page = eligible.slice(previous + 1, previous + 21)
  return {
    total: eligible.length,
    rows: page.map(({ run, index, username, characters, finalDeck }) => ({
      id: index, character: characters[0], characters, ascension: run.ascension,
      cardCount: finalDeck.length, username,
      recordedAt: run.recordedAt, cards: finalDeck,
    })),
    nextCursor: previous + 1 + page.length < eligible.length ? String(page.at(-1).index) : null,
  }
}

export function roomLeaderboardRun(room) {
  const run = room.run
  const totals = run.players.reduce((sum, player) => ({
    damageDealt: sum.damageDealt + Math.max(0, Math.floor((player.damageStats?.attack ?? 0) +
      (player.damageStats?.poison ?? 0) + (player.damageStats?.special ?? 0))),
    damageTaken: sum.damageTaken + Math.max(0, Math.floor(player.damageStats?.taken ?? 0)),
    damageBlocked: sum.damageBlocked + Math.max(0, Math.floor(player.damageStats?.blocked ?? 0)),
  }), { damageDealt: 0, damageTaken: 0, damageBlocked: 0 })
  return {
    id: `room:${room.code}:${run.campaign.runId}:${run.seed}`,
    characters: run.players.map((player) => player.character),
    winningDecks: run.players.map((player) => ({
      username: player.name,
      character: player.character,
      finalDeck: player.deck.map(({ defId, upgraded, attachedGemId }) =>
        ({ defId, upgraded, ...(attachedGemId ? { attachedGemId } : {}) })),
    })),
    ascension: run.ascension,
    mode: run.meta.mode,
    damageStatsComplete: run.combatsFinished !== undefined,
    startedAtAct: run.campaign.startedAtAct,
    highestBossActDefeated: run.campaign.highestBossActDefeated,
    combatsFinished: Math.max(0, Math.floor(run.combatsFinished ?? 0)),
    ...totals,
    ...(run.floorsCleared === undefined ? {} : { floorsCleared: Math.max(0, Math.floor(run.floorsCleared)) }),
  }
}
