import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRoomServer } from './room-server.mjs'
import { createStore } from './lib/rooms.mjs'
import { normalizeLeaderboardRun, addLeaderboardRun } from './lib/leaderboard.mjs'

const workflow = readFileSync(new URL('../.github/workflows/multiplayer-session.yml', import.meta.url), 'utf8')
const gates = [...workflow.matchAll(/'([^'\n]*\.protocolVersion == \$version[^'\n]*)'/g)].map((match) => match[1])
assert.equal(gates.filter((gate) => gate.includes('.profiles == true')).length, 2)
for (const gate of gates) {
  for (const [health, expected] of [
    [{ protocolVersion: 1 }, gate.includes('!= true')],
    [{ protocolVersion: 1, profiles: true }, !gate.includes('!= true')],
    [{ protocolVersion: 2, profiles: true }, false],
  ]) {
    assert.equal(spawnSync('jq', ['-e', '--argjson', 'version', '1', gate], { input: JSON.stringify(health) }).status === 0, expected)
  }
}

const directory = mkdtempSync(join(tmpdir(), 'sts-profile-'))
const file = join(directory, 'rooms.json')
const server = createRoomServer({ storeFile: file })
const { port } = await server.listen(0)
const post = (path, body) => fetch(`http://127.0.0.1:${port}/api/${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
try {
  const health = await fetch(`http://127.0.0.1:${port}/api/health`).then((response) => response.json())
  assert.equal(health.profiles, true)
  assert.equal(health.entryRequestIds, true)
  assert.equal(health.webSocketActionAcks, true)
  const token = crypto.randomUUID()
  const results = await Promise.all([post('profile', { token, username: 'North' }), post('profile', { token: crypto.randomUUID(), username: 'NORTH' })])
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409])
  const profile = server.store.profiles[0]
  assert.equal((await post('profile', profile)).status, 200)
  assert.equal(server.store.profiles.length, 1)
  assert.deepEqual(createStore({ file, handoffRestore: true }).profiles, [profile])
  assert.equal((await post('profile', { token: crypto.randomUUID(), username: '<script>' })).status, 400)
  const run = { id: 'test-run-123', character: 'ironclad', ascension: 0, mode: 'standard', startedAtAct: 1,
    highestBossActDefeated: 3, combatsFinished: 10, damageDealt: 30, damageTaken: 10, damageBlocked: 10,
    finalDeck: [{ defId: 'strike', upgraded: true }, { defId: 'strike', upgraded: false, attachedGemId: 'ruby' }] }
  assert.equal((await post('leaderboard', { ...run, profileToken: profile.token, username: 'forged' })).status, 201)
  assert.equal(server.store.leaderboardRuns[0].username, profile.username)
  assert.deepEqual(server.store.leaderboardRuns[0].finalDeck, run.finalDeck)
  assert.equal('profileToken' in server.store.leaderboardRuns[0], false)
  assert.equal(normalizeLeaderboardRun({ ...run, highestBossActDefeated: 2 }).finalDeck, undefined)
  assert.deepEqual(normalizeLeaderboardRun({ ...run, highestBossActDefeated: 4 }).finalDeck, run.finalDeck)
  assert.throws(() => normalizeLeaderboardRun({ ...run, finalDeck: [{ defId: 'bad', upgraded: 1 }] }))
  const store = { leaderboardRuns: [] }
  const { finalDeck, ...legacy } = run
  addLeaderboardRun(store, legacy)
  assert.equal(addLeaderboardRun(store, run), true)
  assert.deepEqual(store.leaderboardRuns[0].finalDeck, finalDeck)
  assert.equal(addLeaderboardRun(store, run), false)
  await server.close()
  assert.deepEqual(createStore({ file }).leaderboardRuns[0].finalDeck, finalDeck)
  console.log('✓ unique retry-safe profiles, durable handoff, trusted run names, winning decks and legacy enrichment')
} finally {
  await server.close()
  rmSync(directory, { recursive: true, force: true })
}
