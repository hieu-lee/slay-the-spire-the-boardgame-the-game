// Coins for runs recorded before the Shop: the deterministic computation, the
// stored and frozen grant, and the compatibility claim/confirm HTTP protocol.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { suite, check, assert, assertEqual, assertDeepEqual, report } from './lib/harness.mjs'
import { addLeaderboardRun } from './lib/leaderboard.mjs'
import { bossesOf, claimCoinGrant, confirmCoinGrant, grantFor, legacyCoinGrant, restoreCoinGrants } from './lib/coin-grants.mjs'
import { createStore, saveStore } from './lib/rooms.mjs'
import { createRoomServer } from './room-server.mjs'
import { bossCoinRange, rollBossCoins } from '../src/game/coins.ts'
import { seedFromString } from '../src/game/rng.ts'

const checkAsync = async (label, assertion) => {
  try { await assertion(); check(label, () => {}) }
  catch (error) { check(label, () => { throw error }) }
}

const CUTOFF = 1_800_000_000_000
const run = (id, overrides = {}) => ({
  id: `legacy-run-${id}`, username: 'Ann', character: 'ironclad', ascension: 0, mode: 'standard', startedAtAct: 1,
  highestBossActDefeated: 0, combatsFinished: 5, damageDealt: 10, damageTaken: 5, damageBlocked: 5, floorsCleared: 10,
  ...overrides,
})
const storeWith = (runs, cutoff = CUTOFF) => {
  const store = createStore()
  store.coinsLaunchedAt = cutoff
  for (const [value, at] of runs) addLeaderboardRun(store, value, at)
  return store
}

suite('past-run coin grants')

check('bosses beaten: every Act from the start to the highest boss, twice for A13 Act III', () => {
  assertDeepEqual(bossesOf({ startedAtAct: 1, highestBossActDefeated: 0, ascension: 0 }), [])
  assertDeepEqual(bossesOf({ startedAtAct: 1, highestBossActDefeated: 3, ascension: 12 }), [1, 2, 3])
  assertDeepEqual(bossesOf({ startedAtAct: 1, highestBossActDefeated: 3, ascension: 13 }), [1, 2, 3, 3])
  assertDeepEqual(bossesOf({ startedAtAct: 1, highestBossActDefeated: 4, ascension: 13 }), [1, 2, 3, 3, 4])
  assertDeepEqual(bossesOf({ startedAtAct: 2, highestBossActDefeated: 3, ascension: 0 }), [2, 3], 'a Quick Start pays from its first Act')
  assertDeepEqual(bossesOf({ startedAtAct: 3, highestBossActDefeated: 2, ascension: 0 }), [])
})

check('a grant sums the rolls of each counted run within the Ascension ranges', () => {
  const store = storeWith([
    [run(1, { highestBossActDefeated: 3, ascension: 10 }), CUTOFF - 10],
    [run(2, { highestBossActDefeated: 1, ascension: 0, mode: 'custom' }), CUTOFF - 9],
  ])
  const grant = legacyCoinGrant(store.leaderboardRuns, 'Ann', CUTOFF)
  assertEqual(grant.runs, 2)
  const seed = (id) => seedFromString(`legacy-coins:ann:legacy-run-${id}`)
  const expected = rollBossCoins(seed(1), 0, 1, 10) + rollBossCoins(seed(1), 1, 2, 10) + rollBossCoins(seed(1), 2, 3, 10) +
    rollBossCoins(seed(2), 0, 1, 0)
  assertEqual(grant.coins, expected)
  const low = [1, 2, 3].reduce((sum, act) => sum + bossCoinRange(act, 10).min, 0) + bossCoinRange(1, 0).min
  const high = [1, 2, 3].reduce((sum, act) => sum + bossCoinRange(act, 10).max, 0) + bossCoinRange(1, 0).max
  assert(grant.coins >= low && grant.coins <= high, `${grant.coins} outside ${low}-${high}`)
})

check('Daily Climbs, runs after the cutoff, other players and runs without bosses pay nothing', () => {
  const store = storeWith([
    [run(3, { mode: 'daily', dailyDate: '2027-01-14', ascension: 10, highestBossActDefeated: 3, floorsCleared: 40 }), Date.parse('2027-01-14T12:00:00Z')],
    [run(4, { highestBossActDefeated: 3 }), CUTOFF + 1],
    [run(5, { username: 'Bo', highestBossActDefeated: 3 }), CUTOFF - 1],
    [run(6, { highestBossActDefeated: 0 }), CUTOFF - 1],
  ], Date.parse('2027-02-01T00:00:00Z'))
  store.coinsLaunchedAt = CUTOFF
  assertEqual(legacyCoinGrant(store.leaderboardRuns, 'Ann', CUTOFF).coins, 0)
  assertEqual(legacyCoinGrant(store.leaderboardRuns, 'Nobody', CUTOFF).runs, 0)
  assert(legacyCoinGrant(store.leaderboardRuns, 'Bo', CUTOFF).coins > 0)
})

check('an old run marked daily from before the dated Daily Climb pays like the standard run it was', () => {
  const store = storeWith([[run(12, { username: 'Old', mode: 'daily', highestBossActDefeated: 1, ascension: 2 }), CUTOFF - 1]])
  const grant = legacyCoinGrant(store.leaderboardRuns, 'Old', CUTOFF)
  assertEqual(grant.runs, 1)
  assertEqual(grant.coins, rollBossCoins(seedFromString('legacy-coins:old:legacy-run-12'), 0, 1, 2))
})

check('every named seat of a co-op run is paid, and names match whatever their case', () => {
  const store = storeWith([[{ ...run(7, { highestBossActDefeated: 2, characters: ['ironclad', 'silent'] }), username: undefined,
    winningDecks: [
      { username: 'Ann', character: 'ironclad', finalDeck: [] },
      { username: 'Bo', character: 'silent', finalDeck: [] },
    ] }, CUTOFF - 1]])
  assert(legacyCoinGrant(store.leaderboardRuns, 'ann', CUTOFF).coins > 0)
  assert(legacyCoinGrant(store.leaderboardRuns, 'BO', CUTOFF).coins > 0)
  assertEqual(legacyCoinGrant(store.leaderboardRuns, 'ＡＮＮ', CUTOFF).coins, legacyCoinGrant(store.leaderboardRuns, 'Ann', CUTOFF).coins)
})

check('the computation is deterministic, and a stored grant is frozen against later edits', () => {
  const runs = [[run(8, { highestBossActDefeated: 3, ascension: 13 }), CUTOFF - 5]]
  assertEqual(legacyCoinGrant(storeWith(runs).leaderboardRuns, 'Ann', CUTOFF).coins,
    legacyCoinGrant(storeWith(runs).leaderboardRuns, 'Ann', CUTOFF).coins)
  const store = storeWith(runs)
  const grant = grantFor(store, 'Ann')
  const coins = grant.coins
  store.leaderboardRuns.length = 0
  assertEqual(grantFor(store, 'ann').coins, coins, 'a removed run changed a stored grant')
})

check('the two-phase claim: reserve, repeat, refuse a second claimant, confirm, then nothing', () => {
  const store = storeWith([[run(9, { highestBossActDefeated: 2 }), CUTOFF - 1]])
  const first = crypto.randomUUID()
  const second = crypto.randomUUID()
  const claimed = claimCoinGrant(store, 'Ann', first)
  assert(claimed.coins > 0 && claimed.grantId)
  assertDeepEqual(claimCoinGrant(store, 'Ann', first), claimed, 'a retry after a lost answer gets the same grant')
  assertDeepEqual(claimCoinGrant(store, 'Ann', second), { coins: 0 }, 'a second browser claimed a reserved grant')
  assertDeepEqual(confirmCoinGrant(store, 'Ann', second, claimed.grantId), { claimed: false })
  assertDeepEqual(confirmCoinGrant(store, 'Ann', first, '0'.repeat(32)), { claimed: false }, 'a wrong grant id confirmed the grant')
  assertDeepEqual(confirmCoinGrant(store, 'Ann', first, claimed.grantId), { claimed: true })
  assertDeepEqual(confirmCoinGrant(store, 'Ann', first, claimed.grantId), { claimed: true }, 'a repeat confirmation is harmless')
  assertDeepEqual(claimCoinGrant(store, 'Ann', first), { coins: 0 }, 'a spent grant paid again')
  assertDeepEqual(claimCoinGrant(store, 'Zed', first), { coins: 0 }, 'an account without runs has no grant')
})

check('only a run recorded strictly before the cutoff counts', () => {
  const store = storeWith([
    [run(40, { highestBossActDefeated: 1 }), CUTOFF - 1],
    [run(41, { highestBossActDefeated: 1 }), CUTOFF],
    [run(42, { highestBossActDefeated: 1 }), CUTOFF + 1],
  ])
  const grant = legacyCoinGrant(store.leaderboardRuns, 'Ann', CUTOFF)
  assertEqual(grant.runs, 1, 'a run recorded at the cutoff moment is paid in game, so it must not be paid again here')
  assertEqual(grant.coins, rollBossCoins(seedFromString('legacy-coins:ann:legacy-run-40'), 0, 1, 0))
})

check('a repeated confirmation never moves when the grant was claimed', () => {
  const store = storeWith([[run(43, { highestBossActDefeated: 2 }), CUTOFF - 1]])
  const claimId = crypto.randomUUID()
  const { grantId } = claimCoinGrant(store, 'Ann', claimId)
  assertDeepEqual(confirmCoinGrant(store, 'Ann', claimId, grantId, 1_000), { claimed: true })
  assertDeepEqual(confirmCoinGrant(store, 'Ann', claimId, grantId, 2_000), { claimed: true })
  assertEqual(store.coinGrants[0].claimedAt, 1_000, 'a later confirmation rewrote claimedAt')
})

check('stored grants are validated field by field: ceiling, sign, name length, ids and claim time', () => {
  const good = { username: 'ann', grantId: 'ab'.repeat(16), coins: 5, claimId: null, claimedAt: null }
  const ids = { claimId: crypto.randomUUID() }
  const kept = (override) => restoreCoinGrants([{ ...good, ...override }]).length === 1
  assert(kept({}), 'precondition: the base grant is valid')
  assert(kept({ ...ids, claimedAt: 1_700_000_000_000 }), 'a reserved, claimed grant is valid')
  assert(kept({ coins: 0 }) && kept({ coins: 100_000_000 }), 'the bounds themselves are valid')
  assert(!kept({ coins: 100_000_001 }), 'a coin amount past the ceiling was restored')
  assert(!kept({ coins: -1 }), 'negative coins were restored')
  assert(!kept({ coins: 1.5 }) && !kept({ coins: '5' }) && !kept({ coins: Number.MAX_SAFE_INTEGER + 1 }), 'non-integer coins were restored')
  assert(kept({ username: 'a'.repeat(64) }) && !kept({ username: 'a'.repeat(65) }), 'the name length bound is 64')
  assert(!kept({ username: 7 }), 'a non-string name was restored')
  assert(!kept({ grantId: 'ab'.repeat(15) }) && !kept({ grantId: 'AB'.repeat(16) }) && !kept({ grantId: undefined }), 'a malformed grant id was restored')
  assert(!kept({ claimId: 'not-an-id' }) && !kept({ claimId: undefined }), 'a malformed claim id was restored')
  assert(kept({ claimedAt: 0 }) && kept({ claimedAt: -5 }), 'any integer claim time is valid')
  assert(!kept({ claimedAt: '1700000000000' }) && !kept({ claimedAt: 1.5 }) && !kept({ claimedAt: undefined }) && !kept({ claimedAt: NaN }),
    'a malformed claim time was restored')
  assertDeepEqual(restoreCoinGrants('grants'), [])
  assertDeepEqual(restoreCoinGrants(null), [])
})

check('grants and the cutoff survive a restart; malformed stored grants are dropped', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sts-coin-grants-'))
  const file = join(directory, 'rooms.json')
  try {
    const store = createStore({ file })
    const cutoff = store.coinsLaunchedAt
    addLeaderboardRun(store, run(10, { highestBossActDefeated: 1 }), cutoff - 100)
    const claimed = claimCoinGrant(store, 'Ann', crypto.randomUUID())
    saveStore(store)
    const restored = createStore({ file })
    assertEqual(restored.coinsLaunchedAt, cutoff, 'the cutoff moved on restart')
    assertDeepEqual(restored.coinGrants, store.coinGrants)
    assertEqual(grantFor(restored, 'Ann').grantId, claimed.grantId)
    // The owner's dry run reads the same store and prints names and amounts, never tokens.
    restored.profiles.push({ username: 'Ann', token: '00000000-0000-4000-8000-00000000abcd' }, { username: 'Quiet', token: '00000000-0000-4000-8000-00000000abce' },
      { username: 'Jay', token: '00000000-0000-4000-8000-00000000abcf' })
    saveStore(restored)
    // A run saved after the archive goes to the append-only journal; the report must read it too.
    addLeaderboardRun(restored, run(11, { username: 'Jay', highestBossActDefeated: 2, ascension: 3 }), cutoff - 50)
    saveStore(restored)
    assert(existsSync(`${file}.leaderboard.log`), 'precondition: the run was journaled, not archived')
    const jay = legacyCoinGrant(restored.leaderboardRuns, 'Jay', cutoff).coins
    const files = () => readdirSync(directory).map((name) => `${name}:${statSync(join(directory, name)).mtimeMs}`).sort().join('|')
    const untouched = files()
    const report = spawnSync(process.execPath, ['--experimental-strip-types', new URL('./coin-grants-report.mjs', import.meta.url).pathname, '--store', file], { encoding: 'utf8' })
    assertEqual(report.status, 0, report.stderr)
    assert(new RegExp(`Ann\\s+1 runs\\s+${claimed.coins} coins\\s+reserved`).test(report.stdout), report.stdout)
    assert(/Quiet\s+0 runs\s+0 coins\s+not yet asked/.test(report.stdout), report.stdout)
    assert(new RegExp(`Jay\\s+1 runs\\s+${jay} coins\\s+not yet asked`).test(report.stdout), `the journaled run is missing: ${report.stdout}`)
    assert(new RegExp(`Total ${claimed.coins + jay} coins · still to pay ${claimed.coins + jay}`).test(report.stdout), report.stdout)
    assertEqual(files(), untouched, 'the report wrote to the store')
    assert(!report.stdout.includes('00000000-0000-4000'), 'the report printed a token')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
  assertDeepEqual(restoreCoinGrants([{ username: 'ann', grantId: 'x', coins: 5, claimId: null, claimedAt: null }, null, 'bad']), [])
})

// Over HTTP, and the client paying its wallet once.
const service = createRoomServer()
const address = await service.listen(0)
const origin = `http://127.0.0.1:${address.port}`
const post = async (path, body) => {
  const response = await fetch(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json() }
}
const PASSWORD = 'coin grant password'
const ann = { username: 'Ann', token: crypto.randomUUID() }
const bo = { username: 'Bo', token: crypto.randomUUID() }

try {
  await post('/api/profile', { ...ann, password: PASSWORD })
  await post('/api/profile', { ...bo, password: PASSWORD })
  service.store.coinsLaunchedAt = CUTOFF
  addLeaderboardRun(service.store, run(20, { highestBossActDefeated: 3, ascension: 5 }), CUTOFF - 1)
  const expected = legacyCoinGrant(service.store.leaderboardRuns, 'Ann', CUTOFF).coins

  await checkAsync('the endpoints authenticate, reserve, refuse a racing claimant and spend once', async () => {
    assertDeepEqual((await post('/api/profile/coins', { token: crypto.randomUUID(), claimId: crypto.randomUUID() })).body, { coins: 0 })
    assertEqual((await post('/api/profile/coins', { token: ann.token, claimId: 'not-an-id' })).status, 400)
    const claimA = crypto.randomUUID()
    const claimB = crypto.randomUUID()
    const [one, two] = await Promise.all([
      post('/api/profile/coins', { token: ann.token, claimId: claimA }),
      post('/api/profile/coins', { token: ann.token, claimId: claimB }),
    ])
    const winners = [one, two].filter((reply) => reply.body.coins > 0)
    assertEqual(winners.length, 1, 'two concurrent claims were both paid')
    assertEqual(winners[0].body.coins, expected)
    const winner = winners[0] === one ? claimA : claimB
    assertEqual((await post('/api/profile/coins/confirm', { token: bo.token, claimId: winner, grantId: winners[0].body.grantId })).body.claimed, false,
      'another account confirmed Ann\'s grant')
    assertEqual((await post('/api/profile/coins/confirm', { token: ann.token, claimId: winner, grantId: winners[0].body.grantId })).body.claimed, true)
    assertDeepEqual((await post('/api/profile/coins', { token: ann.token, claimId: winner })).body, { coins: 0 })
  })

} finally {
  await service.close()
}

// The reservation (and a frozen empty grant) is on disk before the client acts on it;
// a server that cannot save answers 503 and pays nothing.
{
  const directory = mkdtempSync(join(tmpdir(), 'sts-coin-grant-saves-'))
  const file = join(directory, 'rooms.json')
  let failSaves = false
  const durable = createRoomServer({ storeFile: file, saveDelayMs: 5, onSaveError: () => {},
    saveStoreImpl: (target) => { if (failSaves) throw new Error('disk full'); saveStore(target) } })
  const { port } = await durable.listen(0)
  const call = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() }
  }
  const eve = { username: 'Eve', token: crypto.randomUUID() }
  const fay = { username: 'Fay', token: crypto.randomUUID() }
  try {
    await call('/api/profile', { ...eve, password: PASSWORD })
    await call('/api/profile', { ...fay, password: PASSWORD })
    durable.store.coinsLaunchedAt = CUTOFF
    addLeaderboardRun(durable.store, run(30, { username: 'Eve', highestBossActDefeated: 2 }), CUTOFF - 1)
    // A grant that already exists (here computed by an earlier visit) is reserved by a later
    // claim, which must itself be saved before the answer.
    addLeaderboardRun(durable.store, run(31, { username: 'Gil', highestBossActDefeated: 1 }), CUTOFF - 1)
    const gil = { username: 'Gil', token: crypto.randomUUID() }
    await call('/api/profile', { ...gil, password: PASSWORD })
    grantFor(durable.store, 'Gil')
    // Fay (no past runs) asks in between: she gets nothing, and her request saves Gil's new grant,
    // so Gil's reservation below is a change of its own that must be saved.
    const fayReply = await call('/api/profile/coins', { token: fay.token, claimId: crypto.randomUUID() })
    const gilClaim = crypto.randomUUID()
    await call('/api/profile/coins', { token: gil.token, claimId: gilClaim })
    const gilOnDisk = (JSON.parse(readFileSync(file, 'utf8')).coinGrants ?? []).find((grant) => grant.username === 'gil')
    const claimId = crypto.randomUUID()
    failSaves = true
    const refused = await call('/api/profile/coins', { token: eve.token, claimId })
    failSaves = false
    const reserved = await call('/api/profile/coins', { token: eve.token, claimId })
    const onDisk = () => JSON.parse(readFileSync(file, 'utf8')).coinGrants ?? []
    const eveOnDisk = onDisk().find((grant) => grant.username === 'eve')
    // An account without past runs, asking for the first time: its empty grant is frozen on disk.
    const hal = { username: 'Hal', token: crypto.randomUUID() }
    await call('/api/profile', { ...hal, password: PASSWORD })
    await call('/api/profile/coins', { token: hal.token, claimId: crypto.randomUUID() })
    const halOnDisk = onDisk().find((grant) => grant.username === 'hal')
    // Eve's wallet is paid; her confirmation is saved before the answer, too.
    await call('/api/profile/coins/confirm', { token: eve.token, claimId, grantId: reserved.body.grantId })
    const eveConfirmedOnDisk = onDisk().find((grant) => grant.username === 'eve')
    const restarted = createStore({ file })
    check('a reservation, a confirmation and an empty grant are saved before the answer, and a failed save pays nothing', () => {
      assertEqual(refused.status, 503, 'an unsaved reservation was answered')
      assertEqual(refused.body.coins, undefined)
      assert(reserved.body.coins > 0)
      assertEqual(eveOnDisk?.claimId, claimId, 'the reservation was not on disk when the client was answered')
      assertDeepEqual(fayReply.body, { coins: 0 })
      assertEqual(halOnDisk?.coins, 0, 'an empty grant was not frozen on disk')
      assert(eveConfirmedOnDisk?.claimedAt !== null, 'a confirmation was answered before it was saved')
      assertEqual(gilOnDisk?.claimId, gilClaim, 'a later reservation of an existing grant was not on disk')
      assertEqual(restarted.coinGrants.find((grant) => grant.username === 'eve').claimId, claimId)
      assert(restarted.coinGrants.find((grant) => grant.username === 'eve').claimedAt !== null, 'a restart shows the grant reserved, not claimed')
    })
  } finally {
    await durable.close()
    rmSync(directory, { recursive: true, force: true })
  }
}

report('coin grants')
