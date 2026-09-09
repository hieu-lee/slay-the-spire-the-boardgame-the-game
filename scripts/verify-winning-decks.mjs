import assert from 'node:assert/strict'
import { winningDecksPage, normalizeLeaderboardRun } from './lib/leaderboard.mjs'
import { createRoomServer } from './room-server.mjs'

const runs = Array.from({ length: 45 }, (_, index) => normalizeLeaderboardRun({
  id: `private-installation:run-${index}`, character: index % 2 ? 'silent' : 'ironclad', ascension: index % 14,
  username: `Player${String(index).padStart(2, '0')}`, mode: 'standard', startedAtAct: 1, highestBossActDefeated: index % 2 ? 4 : 3,
  combatsFinished: 1, damageDealt: 1, damageTaken: 1, damageBlocked: 1,
  finalDeck: Array.from({ length: index % 7 }, () => ({ defId: 'strike', upgraded: true, attachedGemId: 'ruby' })),
}, 1700000000000 + index * 1000))
const query = params => new URLSearchParams(params)
const first = winningDecksPage(runs)
assert.equal(first.rows.length, 20)
assert.equal(first.rows[0].username, 'Player44')
assert.equal(first.nextCursor, '25')
const second = winningDecksPage(runs, query({ cursor: first.nextCursor }))
const third = winningDecksPage(runs, query({ cursor: second.nextCursor }))
assert.equal(second.rows.length, 20)
assert.equal(third.rows.length, 5)
assert.equal(third.nextCursor, null)
assert.equal(new Set([...first.rows, ...second.rows, ...third.rows].map(r => r.id)).size, 45)
for (const sort of ['character', 'ascension', 'cardCount', 'username', 'recordedAt']) {
  for (const direction of ['asc', 'desc']) {
    let cursor = null, rows = []
    do {
      const page = winningDecksPage(runs, query({ sort, direction, ...(cursor === null ? {} : { cursor }) }))
      rows.push(...page.rows); cursor = page.nextCursor
    } while (cursor !== null)
    assert.equal(rows.length, 45)
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1][sort], b = rows[i][sort]
      const compared = typeof a === 'string' ? a.localeCompare(b, 'en', { sensitivity: 'base' }) : a - b
      assert(direction === 'asc' ? compared <= 0 : compared >= 0, `${sort} ${direction}`)
    }
  }
}
const sameTime = runs.map(r => ({ ...r, recordedAt: 1 }))
const tiedFirst = winningDecksPage(sameTime)
assert.equal(tiedFirst.rows[0].id, '44')
assert.equal(winningDecksPage(sameTime, query({ cursor: tiedFirst.nextCursor })).rows[0].id, '24')
const extended = [...runs, { ...runs[44], id: 'new-installation:new-run', recordedAt: 1800000000000 }]
assert.deepEqual(winningDecksPage(extended, query({ cursor: first.nextCursor })).rows, second.rows)
assert.equal(winningDecksPage(runs, query({ character: 'silent', ascension: '3' })).total, 3)
assert.equal(winningDecksPage([{ ...runs[0], finalDeck: undefined }, { ...runs[1], highestBossActDefeated: 2 }]).total, 0)
assert.equal(winningDecksPage([{ ...runs[0], username: undefined }]).rows[0].username, 'Unknown')
for (const params of [{ sort: 'id' }, { direction: 'bad' }, { ascension: '14' }, { character: 'bad' }, { cursor: '-1' }, { cursor: '1.1' }, { cursor: '99999' }]) {
  assert.throws(() => winningDecksPage(runs, query(params)), { status: 400 })
}
const server = createRoomServer()
server.store.leaderboardRuns = runs
const { port } = await server.listen(0)
try {
  const url = `http://127.0.0.1:${port}/api/leaderboard/decks`
  const response = await fetch(url)
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.deepEqual(body, first)
  assert(!JSON.stringify(body).includes('private-installation'))
  assert.deepEqual(body.rows[0].cards, runs[44].finalDeck)
  assert.equal((await fetch(`${url}?sort=profileToken`)).status, 400)
} finally { await server.close() }
console.log('Winning decks: bounded pages, global sorting, filters, stable ties/cursors, safe public fields and HTTP validation pass')
