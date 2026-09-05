const CHARACTERS = new Set(['ironclad', 'silent', 'defect', 'watcher', 'slime_boss', 'guardian', 'hexaghost', 'hermit'])
const MODES = new Set(['standard', 'daily', 'custom'])
export const MAX_LEADERBOARD_RUNS = 20_000

const bad = (message) => { throw Object.assign(new Error(message), { status: 400 }) }
const integer = (value, name, minimum, maximum) => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) bad(`${name} is invalid`)
  return value
}

export function normalizeLeaderboardRun(value, recordedAt = Date.now()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) bad('Leaderboard run must be an object')
  if (typeof value.id !== 'string' || !/^[a-zA-Z0-9:_-]{8,160}$/.test(value.id)) bad('Run id is invalid')
  if (!CHARACTERS.has(value.character)) bad('Character is invalid')
  if (!MODES.has(value.mode)) bad('Run mode is invalid')
  return {
    id: value.id,
    character: value.character,
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
}

export function restoreLeaderboardRuns(values) {
  if (!Array.isArray(values)) return []
  const restored = []
  for (const value of values) {
    try { restored.push(normalizeLeaderboardRun(value, value?.recordedAt)) } catch { /* Ignore a damaged historical row, not the whole room store. */ }
  }
  return restored
}

export function addLeaderboardRun(store, value, recordedAt = Date.now()) {
  const run = normalizeLeaderboardRun(value, recordedAt)
  const existing = store.leaderboardRuns.findIndex((entry) => entry.id === run.id)
  if (existing >= 0) {
    if (store.leaderboardRuns[existing].floorsCleared == null && run.floorsCleared != null) {
      store.leaderboardRuns[existing] = { ...store.leaderboardRuns[existing], floorsCleared: run.floorsCleared }
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
    const key = `${run.character}:${run.ascension}`
    const row = groups.get(key) ?? {
      character: run.character,
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
    right.runs - left.runs || left.character.localeCompare(right.character) || left.ascension - right.ascension)
  return { totalRuns: runs.length, rows }
}
