// The client half of the past-runs coin claim (src/legacy-coins.ts), against a fake
// fetch and a fake localStorage: the five rules that keep a grant from being lost,
// paid twice, or paid to the wrong account. scripts/verify-coin-grants.mjs runs the
// same client against the real server; this one pins each rule on its own.
import { suite, check, assert, assertEqual, assertDeepEqual, report } from './lib/harness.mjs'

const checkAsync = async (label, assertion) => {
  try { await assertion(); check(label, () => {}) }
  catch (error) { check(label, () => { throw error }) }
}

const store = new Map()
const faults = { failKey: null, dropWrites: false }
globalThis.localStorage = {
  getItem: (key) => store.get(key) ?? null,
  setItem: (key, value) => {
    if (faults.failKey?.(key)) throw new Error('QuotaExceededError')
    if (!faults.dropWrites) store.set(key, String(value))
  },
  removeItem: (key) => store.delete(key),
}
globalThis.window = { dispatchEvent: () => true, addEventListener: () => {}, removeEventListener: () => {} }
globalThis.sessionStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
globalThis.Event = class { constructor(type) { this.type = type } }

// The fake server: `onClaim` and `onConfirm` decide each answer; every request is logged.
const calls = []
let onClaim = async () => ({ coins: 0 })
let onConfirm = async () => ({ claimed: true })
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body)
  const path = String(url)
  const handler = path.endsWith('/confirm') ? onConfirm : onClaim
  const entry = { path, body, claimStoredAtRequest: [...store.keys()].filter((key) => key.startsWith('sts-legacy-claim:')) }
  calls.push(entry)
  const reply = await handler(body, entry)
  return { status: 200, ok: true, json: async () => reply }
}

const GRANT_ID = 'a'.repeat(32)
const profileOf = (username, suffix) => ({ username, token: `00000000-0000-4000-8000-0000000000${suffix}`, secured: true })
const signIn = (profile) => store.set('sts-profile', JSON.stringify(profile))
const reset = () => {
  store.clear()
  calls.length = 0
  faults.failKey = null
  faults.dropWrites = false
  onClaim = async () => ({ coins: 0 })
  onConfirm = async () => ({ claimed: true })
}
const walletOf = (name) => JSON.parse(store.get(`sts-wallet:${name}`) ?? 'null')
const claimCalls = () => calls.filter((call) => !call.path.endsWith('/confirm'))
const confirmCalls = () => calls.filter((call) => call.path.endsWith('/confirm'))

const { settleLegacyCoins } = await import('../src/legacy-coins.ts')

suite('legacy coin claim (client)')

await checkAsync('a grant is paid into the wallet, then confirmed with the same claim id, then the claim id is dropped', async () => {
  reset()
  signIn(profileOf('Ann', '01'))
  onClaim = async () => ({ coins: 40, grantId: GRANT_ID })
  assertDeepEqual(await settleLegacyCoins(), { coins: 40, total: 40 })
  assertEqual(walletOf('ann').coins, 40)
  assertEqual(confirmCalls().length, 1)
  assertEqual(confirmCalls()[0].body.claimId, claimCalls()[0].body.claimId)
  assertEqual(confirmCalls()[0].body.grantId, GRANT_ID)
  assertEqual(store.has('sts-legacy-claim:ann'), false, 'a spent grant keeps no claim id')
})

await checkAsync('nothing owed: no payment, no confirmation, no leftover claim id', async () => {
  reset()
  signIn(profileOf('Ann', '01'))
  assertDeepEqual(await settleLegacyCoins(), { coins: 0, total: 0 })
  assertEqual(confirmCalls().length, 0)
  assertEqual(walletOf('ann'), null)
  assertEqual(store.has('sts-legacy-claim:ann'), false)
})

await checkAsync('a browser that cannot keep coins never asks, whether storage throws or silently drops writes', async () => {
  for (const fault of ['throws', 'drops']) {
    reset()
    signIn(profileOf('Ann', '01'))
    onClaim = async () => ({ coins: 40, grantId: GRANT_ID })
    const original = globalThis.localStorage.setItem
    globalThis.localStorage.setItem = fault === 'throws' ? () => { throw new Error('QuotaExceededError') } : () => {}
    try { assertDeepEqual(await settleLegacyCoins(), { coins: 0, total: 0 }) }
    finally { globalThis.localStorage.setItem = original }
    assertEqual(calls.length, 0, `the grant was claimed by a browser whose storage ${fault}`)
  }
})

await checkAsync('the claim id is stored before asking, and a lost response is retried with the same id', async () => {
  reset()
  signIn(profileOf('Ann', '01'))
  let lose = true
  onClaim = async () => { if (lose) throw new TypeError('connection lost'); return { coins: 25, grantId: GRANT_ID } }
  assertDeepEqual(await settleLegacyCoins(), { coins: 0, total: 0 })
  const lost = claimCalls()
  assert(lost.length > 0)
  assert(lost[0].claimStoredAtRequest.includes('sts-legacy-claim:ann'), 'the claim id was not stored when the request went out')
  const claimId = store.get('sts-legacy-claim:ann')
  assertEqual(lost[0].body.claimId, claimId)
  lose = false
  calls.length = 0
  assertDeepEqual(await settleLegacyCoins(), { coins: 25, total: 25 })
  assertEqual(claimCalls()[0].body.claimId, claimId, 'the retry asked with a new claim id')
})

await checkAsync('the grant is confirmed only once the coins are readable from storage', async () => {
  reset()
  signIn(profileOf('Ann', '01'))
  onClaim = async () => ({ coins: 30, grantId: GRANT_ID })
  faults.failKey = (key) => key.startsWith('sts-wallet')
  assertEqual((await settleLegacyCoins()).coins, 30, 'the unsaved payment is still reported to this tab')
  assertEqual(confirmCalls().length, 0, 'a payment that never reached the disk was confirmed')
  assert(store.has('sts-legacy-claim:ann'), 'the reservation was dropped with the coins unsaved')
  faults.failKey = null
  assertEqual((await settleLegacyCoins()).coins, 0, 'the retry paid again')
  assertEqual(walletOf('ann').coins, 30, 'the next visit saves the wallet')
  assertEqual(confirmCalls().length, 1)
  assertEqual(store.has('sts-legacy-claim:ann'), false)
})

await checkAsync('a confirmation the server refuses or never answers keeps the claim id for the next visit', async () => {
  for (const answer of ['refused', 'lost']) {
    reset()
    signIn(profileOf('Ann', '01'))
    onClaim = async () => ({ coins: 30, grantId: GRANT_ID })
    onConfirm = async () => { if (answer === 'lost') throw new TypeError('connection lost'); return { claimed: false } }
    assertEqual((await settleLegacyCoins()).coins, 30)
    assert(store.has('sts-legacy-claim:ann'), `the claim id was dropped though the confirmation was ${answer}`)
    onConfirm = async () => ({ claimed: true })
    assertEqual((await settleLegacyCoins()).coins, 0, 'the next visit paid again')
    assertEqual(walletOf('ann').coins, 30)
    assertEqual(store.has('sts-legacy-claim:ann'), false)
  }
})

await checkAsync('an account that signed in while the request was out is never paid, nor the one that asked', async () => {
  reset()
  signIn(profileOf('Ann', '01'))
  onClaim = async () => { signIn(profileOf('Bo', '02')); return { coins: 30, grantId: GRANT_ID } }
  assertDeepEqual(await settleLegacyCoins(), { coins: 0, total: 0 })
  assertEqual(walletOf('ann'), null)
  assertEqual(walletOf('bo'), null)
  assertEqual(confirmCalls().length, 0)
  assert(store.has('sts-legacy-claim:ann'), 'Ann\'s reservation must wait for her next visit')
})

await checkAsync('each account has its own claim id and ledger: a second account on this browser is paid after the first', async () => {
  reset()
  signIn(profileOf('Ann', '01'))
  onClaim = async () => ({ coins: 40, grantId: GRANT_ID })
  assertEqual((await settleLegacyCoins()).coins, 40)
  signIn(profileOf('Bo', '02'))
  onClaim = async () => ({ coins: 25, grantId: 'b'.repeat(32) })
  assertDeepEqual(await settleLegacyCoins(), { coins: 25, total: 25 }, 'Bo\'s grant was blocked by Ann\'s payment')
  assertEqual(walletOf('ann').coins, 40)
  assertEqual(walletOf('bo').coins, 25)
  // A reservation Ann still holds is hers alone: Bo asks with an id of his own.
  reset()
  signIn(profileOf('Ann', '01'))
  onClaim = async () => ({ coins: 40, grantId: GRANT_ID })
  onConfirm = async () => ({ claimed: false })
  await settleLegacyCoins()
  const annsId = store.get('sts-legacy-claim:ann')
  assert(annsId, 'Ann keeps her unconfirmed claim id')
  signIn(profileOf('Bo', '02'))
  calls.length = 0
  await settleLegacyCoins()
  assert(claimCalls()[0].body.claimId !== annsId, 'Bo asked with Ann\'s claim id')
  assertEqual(store.get('sts-legacy-claim:ann'), annsId, 'Bo\'s visit left Ann\'s reservation alone')
})

await checkAsync('calls made while a claim is under way share one request and one result', async () => {
  reset()
  signIn(profileOf('Ann', '01'))
  let release
  onClaim = () => new Promise((resolve) => { release = () => resolve({ coins: 40, grantId: GRANT_ID }) })
  const first = settleLegacyCoins()
  const second = settleLegacyCoins()
  assertEqual(first, second, 'a second caller is handed the first caller\'s promise')
  await new Promise((resolve) => setTimeout(resolve, 0))
  release()
  assertDeepEqual(await first, { coins: 40, total: 40 })
  assertEqual(claimCalls().length, 1, 'two callers made two requests')
  assertEqual(walletOf('ann').coins, 40, 'the grant was paid once')
  onClaim = async () => ({ coins: 0 })
  await settleLegacyCoins()
  assertEqual(claimCalls().length, 2, 'a call after the first finished asks again')
})

await checkAsync('every claim gets a claim id of its own', async () => {
  reset()
  signIn(profileOf('Ann', '01'))
  const ids = new Set()
  for (let visit = 0; visit < 3; visit++) {
    await settleLegacyCoins()
    ids.add(claimCalls().at(-1).body.claimId)
  }
  assertEqual(ids.size, 3, 'a spent claim id was reused by a later claim')
  assert([...ids].every((id) => typeof id === 'string' && id.length >= 8), 'claim ids look like ids')
})

report('legacy coins')
