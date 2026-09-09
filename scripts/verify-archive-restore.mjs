import assert from 'node:assert/strict'
import { archiveOnlyStore } from './restore-archive-backup.mjs'
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
console.log('Archive restoration preserves records, removes only rooms, and refuses ambiguous/stale backups')
