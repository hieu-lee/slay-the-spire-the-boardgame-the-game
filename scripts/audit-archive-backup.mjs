import { readFileSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { leaderboardSnapshot, restoreLeaderboardRuns } from './lib/leaderboard.mjs'

const stored = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const runs = restoreLeaderboardRuns(stored.leaderboardRuns)
assert.equal(runs.length, stored.leaderboardRuns.length, 'Backup contains invalid rows')
const config = await fetch(`https://hieu-lee.github.io/slay-the-spire-the-boardgame-the-game/session.json?audit=${Date.now()}`, { signal: AbortSignal.timeout(15000) }).then(r => {
  assert(r.ok); return r.json()
})
assert.equal(config.runId, '34346831748', 'Live source changed; re-audit before resetting')
const live = await fetch(`${config.origin}/api/leaderboard`, { signal: AbortSignal.timeout(15000) }).then(r => {
  assert(r.ok); return r.json()
})
const report = {
  backupSource: '34319525470', liveSource: config.runId, liveSha: config.sha,
  backupRuns: runs.length, liveRuns: live.totalRuns,
  missingFloorCounts: runs.filter(run => run.floorsCleared == null).length,
  aggregateMatches: JSON.stringify(leaderboardSnapshot(runs)) === JSON.stringify(live),
}
// The old server only appends rows or fills absent floor counts. A matching
// count with no absent floor counts proves this inherited backup is unchanged.
report.backupComplete = report.backupRuns === report.liveRuns && report.missingFloorCounts === 0 && report.aggregateMatches
writeFileSync(process.argv[3], JSON.stringify(report, null, 2))
console.log(JSON.stringify(report))
