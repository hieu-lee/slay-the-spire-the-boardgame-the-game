import assert from 'node:assert/strict'
import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { leaderboardSnapshot, restoreLeaderboardRuns } from './lib/leaderboard.mjs'

export function archiveOnlyStore(stored, live) {
  const runs = restoreLeaderboardRuns(stored.leaderboardRuns)
  assert.deepEqual(runs, stored.leaderboardRuns, 'Backup contains invalid or unsupported archive records')
  const snapshot = leaderboardSnapshot(runs)
  assert.deepEqual(snapshot, live, 'The live archive differs from the backup; keep the current server')
  const unknown = runs.filter(run => run.floorsCleared == null)
  // Legacy servers only append rows or fill absent integer floor counts. With
  // one absent count, filling it cannot preserve a fractional/null average.
  assert(unknown.length === 0 || unknown.length === 1 && !Number.isInteger(
    snapshot.rows.find(row => row.character === unknown[0].character && row.ascension === unknown[0].ascension).averageFloorsCleared,
  ), 'Unknown floor counts could conceal an update; a fresh export is required')
  return { ...stored, rooms: [], reconnectQuorums: {} }
}

export async function legacyArchiveSource(config, get) {
  let lastError
  for (const origin of [...new Set([config.origin, ...(Array.isArray(config.origins) ? config.origins : [])])].filter(Boolean)) {
    let health
    try {
      health = await get(`${origin}/api/health`)
    } catch (error) {
      lastError = error
      continue
    }
    assert.equal(health.protocolVersion, 1)
    assert.notEqual(health.profiles, true, 'Profile-capable servers require a fresh export, not this legacy recovery path')
    try {
      return { origin, leaderboard: await get(`${origin}/api/leaderboard`) }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new Error('No compatible legacy archive origin')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [input, output, expectedLiveRun, backupRun] = process.argv.slice(2)
  assert(/^\d+$/.test(expectedLiveRun) && /^\d+$/.test(backupRun), 'Explicit source run IDs are required')
  const get = async url => {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000), cache: 'no-store' })
    assert(response.ok, `Archive verification failed: HTTP ${response.status}`)
    return response.json()
  }
  const config = await get(`https://hieu-lee.github.io/slay-the-spire-the-boardgame-the-game/session.json?archive-restore=${Date.now()}`)
  assert.equal(config.runId, expectedLiveRun, 'Live source changed')
  assert.equal(config.sourceRunId, backupRun, 'Backup was not inherited by the live source')
  const source = await legacyArchiveSource(config, get)
  const stored = archiveOnlyStore(JSON.parse(readFileSync(input, 'utf8')), source.leaderboard)
  if (!process.argv.includes('--check-only')) {
    mkdirSync(dirname(output), { recursive: true })
    writeFileSync(`${output}.tmp`, JSON.stringify(stored), { mode: 0o600 })
    renameSync(`${output}.tmp`, output)
  }
  console.log(`Verified ${stored.leaderboardRuns.length} archived runs; restored store contains zero rooms.`)
}
