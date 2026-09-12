import assert from 'node:assert/strict'
import { archiveOnlyStore, legacyArchiveSource } from './restore-archive-backup.mjs'
import { leaderboardSnapshot, normalizeLeaderboardRun } from './lib/leaderboard.mjs'
const rows = floors => floors.map((floorsCleared, index) => normalizeLeaderboardRun({ id: `test-run-${index}`,
  character: 'ironclad', ascension: 1, mode: 'standard', startedAtAct: 1, highestBossActDefeated: 0,
  combatsFinished: 1, damageDealt: 1, damageTaken: 1, damageBlocked: 1, floorsCleared }, 1))
for (const floors of [[3, 4], [3, 4, null], [null]]) {
  const leaderboardRuns = rows(floors)
  const original = { version: 1, rooms: [{ code: 'PRIVATE' }], reconnectQuorums: { PRIVATE: {} }, leaderboardRuns }
  const restored = archiveOnlyStore(original, leaderboardSnapshot(leaderboardRuns))
  assert.deepEqual(restored.rooms, [])
  assert.deepEqual(restored.reconnectQuorums, {})
  assert.deepEqual(restored.leaderboardRuns, leaderboardRuns)
  assert.equal(original.rooms.length, 1)
  assert.throws(() => archiveOnlyStore(original, leaderboardSnapshot([...leaderboardRuns, ...rows([10])])) )
}
for (const floors of [[3, 3, null], [3, 4, null, null]]) {
  const leaderboardRuns = rows(floors)
  assert.throws(() => archiveOnlyStore({ leaderboardRuns }, leaderboardSnapshot(leaderboardRuns)))
}
assert.throws(() => archiveOnlyStore({ leaderboardRuns: [{}] }, { totalRuns: 0, rows: [] }))
assert.deepEqual(await legacyArchiveSource({
  origin: 'https://dead.test', origins: ['https://dead.test', 'https://live.test'],
}, async (url) => {
  if (url.startsWith('https://dead.test') && url.endsWith('/api/leaderboard')) throw new Error('offline')
  return url.endsWith('/api/health') ? { protocolVersion: 1, profiles: false } : { totalRuns: 0, rows: [] }
}), { origin: 'https://live.test', leaderboard: { totalRuns: 0, rows: [] } })
await assert.rejects(legacyArchiveSource({
  origin: 'https://current.test', origins: ['https://current.test', 'https://stale.test'],
}, async (url) => url.endsWith('/api/health')
  ? { protocolVersion: 1, profiles: url.startsWith('https://current.test') }
  : { totalRuns: 0, rows: [] }), /fresh export/)
console.log('Archive restoration preserves records, removes only rooms, and refuses ambiguous/stale backups')
