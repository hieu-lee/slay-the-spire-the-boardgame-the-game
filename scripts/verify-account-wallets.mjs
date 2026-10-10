// The owning boundary is authenticated HTTP plus the durable account store.
// Covers two devices, migration, retries, simultaneous spending and reconnects.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRoomServer } from './room-server.mjs'
import { createStore, saveStore } from './lib/rooms.mjs'
import { createWallet } from '../src/wallet.ts'
import { CARD_PACK_PRICE } from '../src/game/coins.ts'

const directory = mkdtempSync(join(tmpdir(), 'sts-account-wallets-'))
const file = join(directory, 'rooms.json')
let failSaves = false
const service = createRoomServer({ storeFile: file, onSaveError: () => {}, saveStoreImpl: (store) => {
  if (failSaves) throw new Error('disk full')
  saveStore(store)
} })
const { port } = await service.listen(0)
const origin = `http://127.0.0.1:${port}`
const account = { username: 'WalletPlayer', token: crypto.randomUUID() }
const request = async (body, token = account.token) => {
  const response = await fetch(`${origin}/api/profile/wallet`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, ...body }),
  })
  return { status: response.status, body: await response.json() }
}
const migration = (wallet) => ({ id: crypto.randomUUID(), wallet })
try {
  await fetch(`${origin}/api/profile`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...account, password: 'test wallet password' }) })
  service.store.coinGrants.push({ username: 'walletplayer', coins: 9772, grantId: 'ab'.repeat(16), claimId: crypto.randomUUID(), claimedAt: Date.now() })
  const laptop = migration(createWallet())
  const first = await request({ migration: laptop })
  assert.equal(first.status, 200, 'a second device must be able to read the claimed grant')
  assert.equal(first.body.wallet.coins, 9772, 'claimed browser grant was not restored to the account')
  assert.equal((await request({})).body.wallet.coins, 9772)
  const phone = migration({ ...createWallet(), coins: 9772 - CARD_PACK_PRICE, packs: ['slayer_defect'], credited: { 'legacy:walletplayer': 1 } })
  const migrated = await request({ migration: phone })
  assert.equal(migrated.body.wallet.coins, 9772 - CARD_PACK_PRICE)
  assert.deepEqual(migrated.body.wallet.packs, ['slayer_defect'])
  assert.deepEqual((await request({ migration: phone })).body.wallet, migrated.body.wallet, 'retry duplicated migrated coins')
  const credit = { runKey: 'solo:recorded-run:123:nonce', awards: [{ act: 1, coins: 100 }], joinedAfter: 0 }
  const replies = await Promise.all([request({ credits: [credit] }), request({ credits: [credit] })])
  assert.equal(replies[0].body.wallet.coins, 9772 - CARD_PACK_PRICE + 100)
  assert.equal(replies[1].body.wallet.coins, replies[0].body.wallet.coins, 'two devices credited one run twice')
  await request({ pack: 'slayer_silent' })
  const balance = (await request({})).body.wallet.coins
  assert.equal((await request({ pack: 'slayer_silent' })).body.wallet.coins, balance, 'a lost purchase reply spent twice')
  assert.equal((await request({ migration: phone })).body.wallet.coins, balance, 'a stale import restored spent coins')
  assert.deepEqual((await request({}, crypto.randomUUID())).body, { registered: false }, 'an unauthenticated request read the wallet')
  assert.equal((await request({ credits: [{ ...credit, awards: [{ act: 1, coins: -1 }] }] })).status, 400)
  assert.equal((await request({ credits: [{ ...credit, runKey: 'legacy:walletplayer' }] })).status, 400)
  failSaves = true
  assert.equal((await request({ pack: 'slayer_ironclad' })).status, 503, 'an unsaved purchase was acknowledged')
  failSaves = false
  const retried = await request({ pack: 'slayer_ironclad' })
  assert.equal(retried.body.purchase.ok, true)
  const disk = JSON.parse(readFileSync(file, 'utf8')).profiles.find((profile) => profile.username === account.username)
  assert.deepEqual(disk.wallet, retried.body.wallet, 'the HTTP receipt preceded the durable write')
  const restored = createStore({ file }).profiles.find((profile) => profile.username === account.username)
  assert.deepEqual(restored.wallet, retried.body.wallet, 'restart lost the account wallet')

  const other = { username: 'OtherWallet', token: crypto.randomUUID() }
  await fetch(`${origin}/api/profile`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...other, password: 'test wallet password' }) })
  assert.equal((await request({}, other.token)).body.wallet.coins, 0, 'another account inherited the wallet')

  // Only one of two different packs can spend the last pack price.
  const profile = service.store.profiles.find((entry) => entry.token === other.token)
  profile.wallet.coins = CARD_PACK_PRICE
  const race = await Promise.all([request({ pack: 'slayer_defect' }, other.token), request({ pack: 'slayer_silent' }, other.token)])
  assert.equal(race.filter((reply) => reply.body.purchase.ok).length, 1)
  assert.equal((await request({}, other.token)).body.wallet.coins, 0)
  console.log('Account wallets: migration, cross-device credits, purchases, isolation, persistence and retries passed')
} finally {
  await service.close()
  rmSync(directory, { recursive: true, force: true })
}
