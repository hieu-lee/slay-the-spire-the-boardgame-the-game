import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { leaderboardSnapshot } from './lib/leaderboard.mjs'
const directory = mkdtempSync(join(tmpdir(), 'archive-audit-'))
try {
  process.argv[2] = join(directory, 'rooms.json')
  process.argv[3] = join(directory, 'report.json')
  const cases = [[[3, 4], true], [[3, 4, null], true], [[3, 3, null], false], [[3, 4, null, null], false], [[null], true]]
  for (const [index, [floors, expected]] of cases.entries()) {
    const runs = floors.map((floorsCleared, i) => ({ id: `test-run-${i}`, character: 'defect', ascension: 0,
      mode: 'standard', startedAtAct: 1, highestBossActDefeated: 0, combatsFinished: 1,
      damageDealt: 0, damageTaken: 0, damageBlocked: 0, floorsCleared, recordedAt: 1 }))
    writeFileSync(process.argv[2], JSON.stringify({ leaderboardRuns: runs }))
    globalThis.fetch = async url => ({ ok: true, json: async () => String(url).includes('session.json')
      ? { runId: '34346831748', sha: 'e1259f375031cc4663e4296fe20705675a39cc3d', origin: 'https://example.invalid' }
      : leaderboardSnapshot(runs) })
    await import(`./audit-archive-backup.mjs?fixture=${index}`)
    assert.equal(JSON.parse(readFileSync(process.argv[3], 'utf8')).backupComplete, expected)
  }
  console.log('Archive floor-enrichment proof: 5 cases passed')
} finally { rmSync(directory, { recursive: true, force: true }) }
