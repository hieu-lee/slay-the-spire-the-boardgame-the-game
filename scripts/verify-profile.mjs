import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRoomServer } from './room-server.mjs'
import { createStore } from './lib/rooms.mjs'
import { normalizeLeaderboardRun, addLeaderboardRun, personalStats } from './lib/leaderboard.mjs'

const pagesWorkflow = readFileSync(new URL('../.github/workflows/pages-deploy.yml', import.meta.url), 'utf8')
const serverWorkflow = readFileSync(new URL('../.github/workflows/server-deploy.yml', import.meta.url), 'utf8')
assert.match(pagesWorkflow, /\.protocolVersion == 1 and \.profiles == true and \.passwordAccounts == true and \.webSocketActionAcks == true and \.releaseSha == \$sha/)
assert.match(pagesWorkflow, /VITE_HOSTED_SESSION=true/)
assert.match(serverWorkflow, /infra\/deploy-local-server\.sh/)

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
  assert.equal(health.passwordAccounts, true)
  assert.equal(health.entryRequestIds, true)
  assert.equal(health.webSocketActionAcks, true)
  assert.equal(health.releaseSha, null)
  const token = crypto.randomUUID()
  const password = 'correct horse battery'
  const results = await Promise.all([post('profile', { token, username: 'North', password }), post('profile', { token: crypto.randomUUID(), username: 'NORTH', password })])
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409])
  const profile = server.store.profiles[0]
  assert.match(profile.passwordHash, /^[0-9a-f]{32}:[0-9a-f]{128}$/)
  assert.equal(JSON.stringify(profile).includes(password), false)
  // A lost response is retried with the same token and password; a different password is refused.
  assert.equal((await post('profile', { token: profile.token, username: profile.username, password })).status, 200)
  assert.equal((await post('profile', { token: profile.token, username: profile.username, password: 'another password' })).status, 409)
  assert.equal(server.store.profiles.length, 1)
  assert.deepEqual(createStore({ file, restartRecovery: true }).profiles, [profile])
  assert.equal((await post('profile', { token: crypto.randomUUID(), username: '<script>', password })).status, 400)
  assert.equal((await post('profile', { token: crypto.randomUUID(), username: 'Shorty', password: 'short' })).status, 400)
  assert.equal((await post('profile', { token: crypto.randomUUID(), username: 'NoPassword' })).status, 400)
  // A profile from before passwords existed gets its first password from its own token.
  const oldProfile = { token: crypto.randomUUID(), username: 'Legacy' }
  server.store.profiles.push(oldProfile)
  assert.equal((await post('login', { username: 'legacy', password })).status, 403)
  assert.equal((await post('profile', { ...oldProfile, password })).status, 200)
  assert.equal((await post('profile', { ...oldProfile, password: 'hijack attempt!' })).status, 409)
  // Logging in returns the token under any capitalisation and never accepts a wrong password.
  const login = await post('login', { username: ' nORTh ', password })
  assert.equal(login.status, 200)
  assert.deepEqual(await login.json(), { username: profile.username, token: profile.token })
  assert.equal((await post('login', { username: 'North', password: 'wrong password' })).status, 401)
  assert.equal((await post('login', { username: 'Nobody', password })).status, 401)
  assert.equal((await post('login', { username: 'North' })).status, 401)
  // Per-name lockout, exercised from many sources so the per-source limit never answers first.
  const from = (source, body) => fetch(`http://127.0.0.1:${port}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': source }, body: JSON.stringify(body),
  })
  const wrong = { username: 'North', password: 'wrong password' }
  // A burst of guesses is counted before the slow hash: North already has two misses, so only six of twenty are even tried.
  const burst = (await Promise.all(Array.from({ length: 20 }, (_, index) => from(`198.51.100.${index}`, wrong)))).map((r) => r.status)
  assert.deepEqual([burst.filter((status) => status === 401).length, burst.filter((status) => status === 429).length], [6, 14])
  assert.equal((await from('198.51.100.100', { username: 'North', password })).status, 429)
  assert.equal((await from('198.51.100.100', { username: 'Legacy', password })).status, 200)
  // A login that is refused for a reason other than a wrong password gives its attempt back:
  // after eight refusals of that kind, seven wrong guesses still leave room for the right one.
  const refused = { token: crypto.randomUUID(), username: 'Refused' }
  server.store.profiles.push(refused)
  for (let index = 0; index < 8; index += 1) assert.equal((await from(`198.51.103.${index}`, { username: 'Refused', password })).status, 403)
  for (let index = 0; index < 7; index += 1) await from(`198.51.104.${index}`, { username: 'Refused', password: 'wrong password' })
  assert.equal((await from('198.51.104.100', { username: 'Refused', password })).status, 403)
  // A correct login clears the count for that name.
  for (let index = 0; index < 7; index += 1) await from(`198.51.101.${index}`, { username: 'Legacy', password: 'wrong password' })
  assert.equal((await from('198.51.101.100', { username: 'Legacy', password })).status, 200)
  assert.equal((await from('198.51.101.101', { username: 'Legacy', password: 'wrong password' })).status, 401)
  for (let index = 0; index < 7; index += 1) await from(`198.51.102.${index}`, { username: 'Legacy', password: 'wrong password' })
  assert.equal((await from('198.51.102.100', { username: 'Legacy', password })).status, 429)
  // A claim cannot reach another name's account through its token.
  assert.equal((await post('profile', { token: profile.token, username: 'Somebody Else', password })).status, 409)
  // Personal stats follow the token, and an unknown token learns nothing.
  assert.equal((await post('profile/stats', { token: crypto.randomUUID() })).status, 409)
  assert.deepEqual(await (await post('profile/stats', { token: profile.token })).json(),
    { runs: 0, act3Wins: 0, act4Wins: 0, bestFloors: 0, bestAscensionWon: null, dailyClimbs: 0, firstRunAt: null, heroes: [] })
  const run = { id: 'test-run-123', character: 'ironclad', ascension: 0, mode: 'standard', startedAtAct: 1,
    highestBossActDefeated: 3, combatsFinished: 10, damageDealt: 30, damageTaken: 10, damageBlocked: 10,
    finalDeck: [{ defId: 'strike', upgraded: true }, { defId: 'strike', upgraded: false, attachedGemId: 'ruby' }] }
  assert.equal((await post('leaderboard', { ...run, profileToken: profile.token, username: 'forged' })).status, 201)
  assert.equal(server.store.leaderboardRuns[0].username, profile.username)
  assert.deepEqual(server.store.leaderboardRuns[0].finalDeck, run.finalDeck)
  assert.equal('profileToken' in server.store.leaderboardRuns[0], false)
  const stats = await (await post('profile/stats', { token: profile.token })).json()
  assert.deepEqual({ ...stats, firstRunAt: typeof stats.firstRunAt }, { runs: 1, act3Wins: 1, act4Wins: 0, bestFloors: 0, bestAscensionWon: 0,
    dailyClimbs: 0, firstRunAt: 'number', heroes: [{ character: 'ironclad', runs: 1, wins: 1 }] })
  assert.deepEqual(normalizeLeaderboardRun({ ...run, highestBossActDefeated: 2 }).finalDeck, run.finalDeck)
  assert.deepEqual(normalizeLeaderboardRun({ ...run, highestBossActDefeated: 4 }).finalDeck, run.finalDeck)
  assert.throws(() => normalizeLeaderboardRun({ ...run, finalDeck: [{ defId: 'bad', upgraded: 1 }] }))
  const store = { leaderboardRuns: [] }
  const { finalDeck, ...legacy } = run
  addLeaderboardRun(store, legacy)
  assert.equal(addLeaderboardRun(store, run), true)
  assert.deepEqual(store.leaderboardRuns[0].finalDeck, finalDeck)
  assert.equal(addLeaderboardRun(store, run), false)
  // Personal stats count solo, party (by winning-deck owner) and daily runs, and ignore other players.
  const base = { id: 'x', mode: 'standard', ascension: 0, startedAtAct: 1, combatsFinished: 1, damageDealt: 0, damageTaken: 0, damageBlocked: 0, floorsCleared: null }
  const record = [
    { ...base, id: 'solo-win', username: 'Ann', character: 'silent', highestBossActDefeated: 4, ascension: 5, floorsCleared: 52, recordedAt: 1000 },
    { ...base, id: 'solo-loss', username: 'ann', character: 'silent', highestBossActDefeated: 1, floorsCleared: 9, recordedAt: 3000 },
    { ...base, id: 'daily', username: 'Ann', character: 'defect', highestBossActDefeated: 3, ascension: 10, dailyDate: '2026-10-01', floorsCleared: 40, recordedAt: 2000 },
    { ...base, id: 'party', characters: ['defect', 'watcher'], character: 'defect', highestBossActDefeated: 3, ascension: 2, recordedAt: 4000,
      winningDecks: [{ username: 'Ann', character: 'watcher', finalDeck: [] }, { username: 'Bo', character: 'defect', finalDeck: [] }] },
    { ...base, id: 'other', username: 'Bo', character: 'ironclad', highestBossActDefeated: 3, recordedAt: 5000 },
  ]
  const stored = record.map((run) => ({ ...run, characters: run.characters ?? [run.character] }))
  assert.deepEqual(personalStats(stored, 'ANN'), { runs: 4, act3Wins: 3, act4Wins: 1, bestFloors: 52, bestAscensionWon: 10, dailyClimbs: 1, firstRunAt: 1000,
    heroes: [{ character: 'silent', runs: 2, wins: 1 }, { character: 'defect', runs: 1, wins: 1 }, { character: 'watcher', runs: 1, wins: 1 }] })
  await server.close()
  assert.deepEqual(createStore({ file }).leaderboardRuns[0].finalDeck, finalDeck)
  console.log('✓ unique retry-safe password accounts, legacy upgrade, rate-limited login, personal stats, durable restart recovery, trusted run names, winning decks and legacy enrichment')
} finally {
  await server.close()
  rmSync(directory, { recursive: true, force: true })
}
