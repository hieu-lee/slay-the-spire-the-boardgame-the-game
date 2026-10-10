// The owning boundary is authenticated HTTP plus the durable account store.
// Covers two devices, migration, retries, simultaneous spending and reconnects,
// for coins, packs and skins.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRoomServer } from './room-server.mjs'
import { createStore, saveStore } from './lib/rooms.mjs'
import { createWallet } from '../src/wallet.ts'
import { CARD_PACK_PRICE, SKIN_PRICE } from '../src/game/coins.ts'

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
  // Skins: bought with the account's coins like a pack, idempotent on retry, and migrated as spent earnings.
  const buyer = { username: 'SkinBuyer', token: crypto.randomUUID() }
  await fetch(`${origin}/api/profile`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...buyer, password: 'test wallet password' }) })
  const buyerProfile = service.store.profiles.find((entry) => entry.token === buyer.token)
  assert.equal((await request({ skin: 'kratos' }, buyer.token)).body.purchase.reason, 'insufficient', 'a skin sold for coins the account lacks')
  buyerProfile.wallet.coins = SKIN_PRICE + 40
  const sold = await request({ skin: 'kratos' }, buyer.token)
  assert.deepEqual(sold.body.purchase, { ok: true })
  assert.equal(sold.body.wallet.coins, 40, 'the skin did not cost exactly 2,500')
  assert.deepEqual(sold.body.wallet.skins, ['kratos'])
  const resold = await request({ skin: 'kratos' }, buyer.token)
  assert.deepEqual(resold.body.purchase, { ok: true }, 'a retried purchase after a lost reply must succeed')
  assert.equal(resold.body.wallet.coins, 40, 'a retried skin purchase spent twice')
  assert.equal((await request({ skin: 'nobody' }, buyer.token)).body.purchase.reason, 'unknown')
  assert.equal((await request({ skin: 'slayer_defect' }, buyer.token)).body.purchase.reason, 'unknown', 'a pack id sold as a skin')
  assert.equal((await request({ pack: 'kratos' }, buyer.token)).body.purchase.reason, 'unknown', 'a skin id sold as a pack')
  const restoredBuyer = createStore({ file }).profiles.find((entry) => entry.username === buyer.username)
  assert.deepEqual(restoredBuyer.wallet.skins, ['kratos'], 'restart lost the skin')
  // A stale browser wallet from before the purchase cannot hand the price back, and its own skin joins the account's.
  const staleBrowser = migration({ ...createWallet(), coins: 40 + SKIN_PRICE })
  const stale = await request({ migration: staleBrowser }, buyer.token)
  assert.equal(stale.body.wallet.coins, 40, 'a pre-purchase browser wallet restored the skin price')
  const boughtOffline = migration({ ...createWallet(), coins: 90, skins: ['kratos'] })
  const merged = await request({ migration: boughtOffline }, buyer.token)
  // Lifetime earnings merge by maximum: the browser earned 50 more than the account (90 + 2,500 against 40 + 2,500).
  assert.equal(merged.body.wallet.coins, 90, 'migrating an owned skin refunded or double-charged it')
  assert.deepEqual(merged.body.wallet.skins, ['kratos'])
  // A browser that bought the skin locally brings it to an account that never had it, as spent earnings.
  const fresh = { username: 'SkinMigrant', token: crypto.randomUUID() }
  await fetch(`${origin}/api/profile`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...fresh, password: 'test wallet password' }) })
  const carried = await request({ migration: migration({ ...createWallet(), coins: 700, skins: ['kratos'], packs: ['slayer_silent'] }) }, fresh.token)
  assert.deepEqual(carried.body.wallet.skins, ['kratos'])
  assert.deepEqual(carried.body.wallet.packs, ['slayer_silent'])
  assert.equal(carried.body.wallet.coins, 700, 'earnings = coins + spent; the migrated skin must not restore its price')
  // Two devices race for the last 2,500 coins: only one skin or pack sells.
  const racer = { username: 'SkinRacer', token: crypto.randomUUID() }
  await fetch(`${origin}/api/profile`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...racer, password: 'test wallet password' }) })
  service.store.profiles.find((entry) => entry.token === racer.token).wallet = { ...createWallet(), coins: SKIN_PRICE }
  const raced = await Promise.all([request({ skin: 'kratos' }, racer.token), request({ pack: 'slayer_defect' }, racer.token)])
  assert.equal(raced.filter((reply) => reply.body.purchase.ok).length, 1, 'one balance bought both a skin and a pack')
  const left = SKIN_PRICE - (raced[0].body.purchase.ok ? SKIN_PRICE : CARD_PACK_PRICE)
  assert.equal((await request({}, racer.token)).body.wallet.coins, left, 'the winner of the race was charged its own price')
  console.log('Account wallets: migration, cross-device credits, purchases, isolation, persistence and retries passed')
} finally {
  await service.close()
  rmSync(directory, { recursive: true, force: true })
}
