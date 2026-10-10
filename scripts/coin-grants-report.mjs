#!/usr/bin/env node
// Dry run of the past-run coin grants: what each account would receive (or has
// received) for the runs it recorded before the Shop. Reads the room store and
// writes nothing; prints names and amounts only, never tokens.
//
//   node --experimental-strip-types scripts/coin-grants-report.mjs --store .rooms/rooms.json [--cutoff 2026-10-10T00:00:00Z]
//
// Without --cutoff the store's own `coinsLaunchedAt` is used, or "now" for a store
// that has never been opened by a server with the Shop (what its first start will set).
// Stored grants print their frozen amount; accounts that have not asked yet print what
// the server would compute now.
import { statSync } from 'node:fs'
import { grantNameKey, legacyCoinGrant } from './lib/coin-grants.mjs'
import { createStore } from './lib/rooms.mjs'

const args = process.argv.slice(2)
const option = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined }
const file = option('--store')
if (!file) {
  console.error('Usage: coin-grants-report.mjs --store <rooms.json> [--cutoff <ISO date or ms>]')
  process.exit(2)
}
// The server's own loader, so the runs are exactly the server's: the main file, the leaderboard
// archive and its append-only journal. Loading writes nothing; only saveStore does, and it is
// never called here.
const before = statSync(file).mtimeMs
const saved = createStore({ file })
const runs = saved.leaderboardRuns
const given = option('--cutoff')
const cutoff = given ? (Number.isFinite(Number(given)) ? Number(given) : Date.parse(given)) : saved.coinsLaunchedAt
if (!Number.isFinite(cutoff)) {
  console.error(`Unreadable --cutoff ${given}`)
  process.exit(2)
}
const stored = new Map(saved.coinGrants.map((grant) => [grant.username, grant]))
const rows = (saved.profiles ?? []).filter((profile) => typeof profile?.username === 'string').map((profile) => {
  const grant = stored.get(grantNameKey(profile.username))
  const computed = legacyCoinGrant(runs, profile.username, cutoff)
  return { username: profile.username, runs: computed.runs, coins: grant?.coins ?? computed.coins,
    status: grant ? grant.claimedAt !== null ? 'claimed' : grant.claimId ? 'reserved' : 'stored' : 'not yet asked' }
}).sort((left, right) => right.coins - left.coins || left.username.localeCompare(right.username))
console.log(`Cutoff ${new Date(cutoff).toISOString()} · ${rows.length} accounts · ${rows.filter((row) => row.coins > 0).length} with coins`)
for (const row of rows) console.log(`${row.username.padEnd(24)} ${String(row.runs).padStart(4)} runs ${String(row.coins).padStart(7)} coins  ${row.status}`)
console.log(`Total ${rows.reduce((sum, row) => sum + row.coins, 0)} coins · still to pay ${rows.filter((row) => row.status !== 'claimed').reduce((sum, row) => sum + row.coins, 0)}`)
if (statSync(file).mtimeMs !== before) throw new Error('the report changed the store')
