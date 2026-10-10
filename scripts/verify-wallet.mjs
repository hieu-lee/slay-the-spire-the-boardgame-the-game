// The Shop wallet: buying packs, crediting boss coins exactly once per boss,
// the add-packs-to-runs switch, and what survives corrupt or blocked storage.
import { suite, check, assert, assertEqual, assertDeepEqual, report } from './lib/harness.mjs'
import { CARD_PACK_PRICE, MAX_BOSS_AWARDS, SKIN_PRICE, SKIN_PRICES, catchUpAwardIndex } from '../src/game/coins.ts'
import { SKIN_IDS } from '../src/game/skins.ts'
import { CARD_PACK_IDS } from '../src/game/packs.ts'
import {
  MAX_CREDITED_RUNS, MAX_PAID_RUNS, parsePaidRuns, MAX_RUN_KEY_LENGTH, MAX_WALLET_COINS, buyPack, buySkin, coinsShort, createWallet, creditBossCoins,
  enabledCardPacks, onlineRunKey, ownsPack, ownsSkin, parseWallet, spentCoins, setAddPacksToRuns, soloRunKey,
} from '../src/wallet.ts'

const rich = (coins = 5000, packs = []) => ({ ...createWallet(), coins, packs })
const awards = (...coins) => coins.map((value, index) => ({ act: Math.min(4, index + 1), coins: value }))

suite('wallet purchases')

check('a new wallet is empty and adds bought packs to runs by default', () => {
  assertDeepEqual(createWallet(), { version: 1, coins: 0, packs: [], skins: [], addPacksToRuns: true, credited: {} })
})

check('buying spends exactly the pack price and owns the pack', () => {
  const bought = buyPack(rich(CARD_PACK_PRICE), 'slayer_defect')
  assert(bought.ok, 'an affordable pack must sell')
  assertEqual(bought.wallet.coins, 0)
  assertDeepEqual(bought.wallet.packs, ['slayer_defect'])
  assert(ownsPack(bought.wallet, 'slayer_defect'))
})

check('one coin short is refused and leaves the wallet untouched', () => {
  const wallet = rich(CARD_PACK_PRICE - 1)
  const refused = buyPack(wallet, 'slayer_silent')
  assertEqual(refused.ok, false)
  assertEqual(refused.reason, 'insufficient')
  assertEqual(refused.wallet, wallet, 'a refusal returns the same wallet')
  assertEqual(coinsShort(wallet), 1)
  assertEqual(coinsShort(rich(CARD_PACK_PRICE * 3)), 0)
})

check('an owned pack cannot be bought twice, and an unknown id never sells', () => {
  const wallet = rich(5000, ['slayer_watcher'])
  const again = buyPack(wallet, 'slayer_watcher')
  assertEqual(again.ok, false)
  assertEqual(again.reason, 'owned')
  assertEqual(again.wallet.coins, 5000, 'no coins are taken for an owned pack')
  for (const id of ['slayer_nobody', 'ironclad', '', null, 42, ['slayer_silent']]) {
    const unknown = buyPack(wallet, id)
    assertEqual(unknown.ok, false, `${JSON.stringify(id)} must not sell`)
    assertEqual(unknown.reason, 'unknown')
  }
})

check('every pack can be bought once, and owned packs stay in catalogue order', () => {
  let wallet = rich(CARD_PACK_PRICE * CARD_PACK_IDS.length + 7)
  for (const id of [...CARD_PACK_IDS].reverse()) {
    const result = buyPack(wallet, id)
    assert(result.ok, `${id} must sell`)
    wallet = result.wallet
  }
  assertEqual(wallet.coins, 7)
  assertDeepEqual(wallet.packs, [...CARD_PACK_IDS])
})

suite('wallet skins')

check('every skin costs 2,500 coins, from the catalogue', () => {
  assertEqual(SKIN_PRICE, 2500)
  for (const id of SKIN_IDS) assertEqual(SKIN_PRICES[id], 2500, `${id} costs the skin price`)
})

check('buying a skin spends exactly its price and owns it', () => {
  const bought = buySkin(rich(SKIN_PRICE + 7, ['slayer_defect']), 'kratos')
  assert(bought.ok, 'an affordable skin must sell')
  assertEqual(bought.wallet.coins, 7)
  assertDeepEqual(bought.wallet.skins, ['kratos'])
  assertDeepEqual(bought.wallet.packs, ['slayer_defect'], 'packs are untouched')
  assert(ownsSkin(bought.wallet, 'kratos'))
  assert(!ownsSkin(createWallet(), 'kratos'))
})

check('a skin one coin short is refused, an owned or unknown one never sells', () => {
  const short = { ...createWallet(), coins: SKIN_PRICE - 1 }
  const refused = buySkin(short, 'kratos')
  assertEqual(refused.ok, false)
  assertEqual(refused.reason, 'insufficient')
  assertEqual(refused.wallet, short, 'a refusal returns the same wallet')
  assertEqual(coinsShort(short, SKIN_PRICES.kratos), 1)
  assertEqual(coinsShort(short), Math.max(0, CARD_PACK_PRICE - short.coins), 'the pack price is still the default')
  const owned = { ...createWallet(), coins: 9000, skins: ['kratos'] }
  const again = buySkin(owned, 'kratos')
  assertEqual(again.ok, false)
  assertEqual(again.reason, 'owned')
  assertEqual(again.wallet.coins, 9000, 'no coins are taken for an owned skin')
  for (const id of ['nobody', 'ironclad', 'slayer_defect', '', null, 42, ['kratos']]) {
    const unknown = buySkin(owned, id)
    assertEqual(unknown.ok, false, `${JSON.stringify(id)} must not sell`)
    assertEqual(unknown.reason, 'unknown')
  }
  assertEqual(buyPack({ ...createWallet(), coins: 9000 }, 'kratos').reason, 'unknown', 'a skin id is not a pack')
})

check('a wallet from before skins parses to none, and stored skins are validated and in catalogue order', () => {
  assertDeepEqual(parseWallet({ version: 1, coins: 12, packs: ['slayer_silent'], addPacksToRuns: true, credited: {} }).skins, [])
  assertDeepEqual(parseWallet({ version: 1, coins: 12, skins: ['kratos', 'nobody', 'kratos', 3, null] }).skins, ['kratos'])
  assertDeepEqual(parseWallet({ version: 1, coins: 12, skins: 'kratos' }).skins, [])
  assertDeepEqual(parseWallet({ version: 1, coins: 12, skins: { kratos: true } }).skins, [])
  assertEqual(parseWallet({ version: 1, coins: 12, skins: ['kratos'] }).coins, 12, 'a skin list never costs the coins')
})

check('what a wallet spent adds the packs and the skins', () => {
  assertEqual(spentCoins(createWallet()), 0)
  assertEqual(spentCoins({ ...createWallet(), packs: ['slayer_silent', 'slayer_defect'], skins: ['kratos'] }), 2 * CARD_PACK_PRICE + SKIN_PRICE)
})

suite('boss coin crediting')

check('a run pays each boss once, however often it is credited', () => {
  const first = creditBossCoins(createWallet(), 'solo:campaign-1:42', awards(11))
  assertEqual(first.coins, 11)
  assertEqual(first.wallet.coins, 11)
  const reload = creditBossCoins(first.wallet, 'solo:campaign-1:42', awards(11))
  assertEqual(reload.coins, 0)
  assertEqual(reload.wallet, first.wallet, 'nothing owed returns the same wallet, so nothing is written')
  const next = creditBossCoins(reload.wallet, 'solo:campaign-1:42', awards(11, 22))
  assertEqual(next.coins, 22, 'only the new boss pays')
  assertEqual(next.wallet.coins, 33)
  assertEqual(next.wallet.credited['solo:campaign-1:42'], 2)
})

check('an empty or missing award list pays nothing and records nothing', () => {
  for (const list of [undefined, []]) {
    const result = creditBossCoins(createWallet(), 'solo:x', list)
    assertEqual(result.coins, 0)
    assertDeepEqual(result.wallet.credited, {})
  }
})

check('different runs keep separate ledgers', () => {
  let wallet = creditBossCoins(createWallet(), onlineRunKey('ABCDEF', 'campaign-1'), awards(10, 20)).wallet
  wallet = creditBossCoins(wallet, onlineRunKey('ABCDEF', 'campaign-2'), awards(12)).wallet
  wallet = creditBossCoins(wallet, soloRunKey('campaign-1', 7, 'nonce'), awards(9)).wallet
  assertEqual(wallet.coins, 51)
  assertEqual(Object.keys(wallet.credited).length, 3)
})

check('a Catch Up joiner is paid only for bosses after they joined, and never retroactively', () => {
  const key = onlineRunKey('ROOMXX', 'campaign-4')
  // Joined after two bosses: the first snapshot they see already holds both.
  const joined = creditBossCoins(createWallet(), key, awards(10, 20), 2)
  assertEqual(joined.coins, 0)
  assertEqual(joined.wallet.credited[key], 2, 'the skipped awards still count as settled')
  const third = creditBossCoins(joined.wallet, key, awards(10, 20, 30), 2)
  assertEqual(third.coins, 30)
  // A joiner whose ledger is older than their join point is still not back-paid.
  const late = creditBossCoins(createWallet(), key, awards(10, 20, 30), 1)
  assertEqual(late.coins, 50)
})

check('a Catch Up joiner in a run restored from before the Shop is paid for every boss after joining', () => {
  const key = onlineRunKey('LEGACY', 'campaign-9')
  // Two bosses fell before awards existed; the joiner arrived after them (joinedAfterBosses 2).
  const skip = catchUpAwardIndex(2, 3, 1)
  assertEqual(skip, 0, 'the Act III award is the joiner\'s first')
  assertEqual(creditBossCoins(createWallet(), key, [{ act: 3, coins: 240 }], skip).coins, 240)
  assertEqual(creditBossCoins(createWallet(), key, [{ act: 3, coins: 240 }], 2).coins, 0,
    'precondition: the raw boss count would have underpaid')
  // An ordinary run: every boss holds an award, so the count is the index.
  assertEqual(catchUpAwardIndex(1, 2, 2), 1)
  assertEqual(creditBossCoins(createWallet(), key, awards(10, 20), catchUpAwardIndex(1, 2, 2)).coins, 20)
  assertEqual(catchUpAwardIndex(0, 4, 1), 0, 'a founding player is never skipped')
})

check('malformed awards cannot mint coins, and award lists are capped', () => {
  const bad = [{ act: 1, coins: -50 }, { act: 2, coins: 1.5 }, { act: 3, coins: 'many' }, null, { act: 4, coins: 40 }]
  const result = creditBossCoins(createWallet(), 'solo:bad', bad)
  assertEqual(result.coins, 40)
  const many = Array.from({ length: MAX_BOSS_AWARDS + 4 }, () => ({ act: 1, coins: 10 }))
  assertEqual(creditBossCoins(createWallet(), 'solo:many', many).coins, MAX_BOSS_AWARDS * 10)
  assertEqual(creditBossCoins(createWallet(), 'x'.repeat(MAX_RUN_KEY_LENGTH + 1), awards(10)).coins, 0,
    'an oversized key is refused')
  assertEqual(creditBossCoins(createWallet(), '', awards(10)).coins, 0, 'an empty key is refused')
})

check('the ledger is bounded and forgets the runs that went quiet longest ago', () => {
  let wallet = createWallet()
  for (let run = 0; run < MAX_CREDITED_RUNS + 6; run += 1) {
    wallet = creditBossCoins(wallet, `solo:campaign-${run}:1`, awards(1)).wallet
    if (run === 10) wallet = creditBossCoins(wallet, 'solo:campaign-0:1', awards(1, 1)).wallet
  }
  const keys = Object.keys(wallet.credited)
  assertEqual(keys.length, MAX_CREDITED_RUNS)
  assert(!keys.includes('solo:campaign-1:1'), 'the oldest quiet run was forgotten')
  assert(keys.includes('solo:campaign-0:1'), 'a run that paid again was refreshed, not forgotten')
  assertEqual(keys.at(-1), `solo:campaign-${MAX_CREDITED_RUNS + 5}:1`)
  assertEqual(wallet.coins, MAX_CREDITED_RUNS + 7)
})

check('crediting never lifts the balance past the wallet cap', () => {
  const nearlyFull = { ...createWallet(), coins: MAX_WALLET_COINS - 5 }
  const credited = creditBossCoins(nearlyFull, 'solo:cap', awards(40))
  assertEqual(credited.wallet.coins, MAX_WALLET_COINS)
  assertEqual(credited.wallet.credited['solo:cap'], 1, 'the capped award still counts as paid')
  assertEqual(parseWallet({ version: 1, coins: MAX_WALLET_COINS }).coins, MAX_WALLET_COINS, 'the cap itself is a valid balance')
  assertEqual(parseWallet({ version: 1, coins: MAX_WALLET_COINS + 1 }).coins, 0, 'a stored balance past the cap is corrupt')
})

check('solo keys separate attempts on a reused seed; online keys separate rooms', () => {
  assert(soloRunKey('campaign-3', 9, 'a') !== soloRunKey('campaign-3', 9, 'b'))
  assertEqual(soloRunKey('campaign-3', 9), 'solo:campaign-3:9', 'a pre-Shop save keys on its run and seed')
  assert(onlineRunKey('AAAAAA', 'campaign-1') !== onlineRunKey('BBBBBB', 'campaign-1'))
  assert(soloRunKey('r'.repeat(400), 1).length <= MAX_RUN_KEY_LENGTH)
})

suite('add-packs-to-runs switch')

check('owned packs join runs while the switch is on, and none while it is off', () => {
  const wallet = rich(0, ['slayer_ironclad', 'slayer_colorless'])
  assertDeepEqual(enabledCardPacks(wallet), ['slayer_ironclad', 'slayer_colorless'])
  const off = setAddPacksToRuns(wallet, false)
  assertDeepEqual(enabledCardPacks(off), [])
  assertDeepEqual(off.packs, wallet.packs, 'switching off keeps ownership')
  assertEqual(setAddPacksToRuns(off, false), off, 'an unchanged switch returns the same wallet')
  const bought = buyPack({ ...off, coins: CARD_PACK_PRICE }, 'slayer_silent')
  assert(bought.ok, 'buying works while the switch is off')
  assertDeepEqual(enabledCardPacks(bought.wallet), [])
  assertDeepEqual(enabledCardPacks(setAddPacksToRuns(bought.wallet, true)),
    ['slayer_ironclad', 'slayer_silent', 'slayer_colorless'])
})

suite('stored wallet validation')

check('anything unreadable becomes the empty wallet', () => {
  for (const value of [null, undefined, 3, 'wallet', [], { version: 2, coins: 99 }, { coins: 99 }]) {
    assertDeepEqual(parseWallet(value), createWallet(), JSON.stringify(value))
  }
})

check('each field is validated on its own, so one bad field costs nothing else', () => {
  const parsed = parseWallet({
    version: 1,
    coins: -4,
    packs: ['slayer_watcher', 'slayer_nobody', 'slayer_watcher', 7, 'slayer_ironclad'],
    addPacksToRuns: 'yes',
    credited: { 'solo:ok': 2, 'solo:negative': -1, 'solo:fraction': 1.5, 'solo:huge': MAX_BOSS_AWARDS + 1, '': 1,
      ['k'.repeat(MAX_RUN_KEY_LENGTH + 1)]: 1 },
  })
  assertEqual(parsed.coins, 0)
  assertDeepEqual(parsed.packs, ['slayer_ironclad', 'slayer_watcher'])
  assertEqual(parsed.addPacksToRuns, true)
  assertDeepEqual(parsed.credited, { 'solo:ok': 2 })
  assertEqual(parseWallet({ version: 1, coins: 1e12 }).coins, 0, 'an impossible balance is corrupt')
  assertEqual(parseWallet({ version: 1, coins: 1284, addPacksToRuns: false }).addPacksToRuns, false)
  assertEqual(parseWallet({ version: 1, coins: 1284 }).coins, 1284)
})

check('an oversized stored ledger keeps only its most recent runs', () => {
  const credited = Object.fromEntries(Array.from({ length: MAX_CREDITED_RUNS * 2 }, (_, run) => [`solo:${run}`, 1]))
  const parsed = parseWallet({ version: 1, coins: 0, credited })
  const keys = Object.keys(parsed.credited)
  assertEqual(keys.length, MAX_CREDITED_RUNS)
  assertEqual(keys[0], `solo:${MAX_CREDITED_RUNS}`)
})

// The storage module talks to localStorage and window; stand both in.
const store = new Map()
const storage = { failWrites: false, failReads: false, failKey: null, dropWrites: false }
const writes = []
globalThis.localStorage = {
  getItem: (key) => { if (storage.failReads) throw new Error('SecurityError'); return store.get(key) ?? null },
  setItem: (key, value) => {
    if (storage.failWrites || storage.failKey?.(key)) throw new Error('QuotaExceededError')
    writes.push(key)
    if (storage.dropWrites) return
    store.set(key, String(value))
  },
  removeItem: (key) => store.delete(key),
}
let changeEvents = 0
globalThis.window = { dispatchEvent: () => { changeEvents += 1; return true } }
const session = new Map()
globalThis.sessionStorage = { getItem: (key) => session.get(key) ?? null, setItem: (key, value) => session.set(key, String(value)), removeItem: (key) => session.delete(key) }
globalThis.Event = class { constructor(type) { this.type = type } }
const { PAID_RUNS_KEY, WALLET_KEY, browserPaidAll, claimSeatOwner, creditRunCoins, savedWallet, updateWallet, walletKey } =
  await import('../src/wallet-storage.ts')
// A second copy of the module stands in for the same tab after a reload: empty memory, same sessionStorage.
const reloaded = await import('../src/wallet-storage.ts?reload')

suite('wallet storage')

check('corrupt or unreadable storage reads as an empty wallet instead of throwing', () => {
  store.set(WALLET_KEY, '{not json')
  assertDeepEqual(savedWallet(), createWallet())
  storage.failReads = true
  assertDeepEqual(savedWallet(), createWallet())
  storage.failReads = false
})

check('crediting persists, announces the change, and a repeat writes nothing', () => {
  store.delete(WALLET_KEY)
  changeEvents = 0
  const paid = creditRunCoins('solo:campaign-1:5:n', awards(10, 20))
  assertDeepEqual(paid, { coins: 30, total: 30 })
  assertEqual(JSON.parse(store.get(WALLET_KEY)).coins, 30)
  assertEqual(changeEvents, 1)
  const again = creditRunCoins('solo:campaign-1:5:n', awards(10, 20))
  assertDeepEqual(again, { coins: 0, total: 30 })
  assertEqual(changeEvents, 1, 'an idempotent credit does not rewrite storage')
})

check('every change starts from what storage holds now, so another tab is never overwritten', () => {
  store.set(WALLET_KEY, JSON.stringify({ ...createWallet(), coins: 2000, packs: ['slayer_silent'] }))
  const after = updateWallet((wallet) => { const result = buyPack(wallet, 'slayer_defect'); return result.wallet })
  assertEqual(after.coins, 2000 - CARD_PACK_PRICE)
  assertDeepEqual(JSON.parse(store.get(WALLET_KEY)).packs, ['slayer_silent', 'slayer_defect'])
})

check('blocked storage keeps the newer wallet for this tab without throwing', () => {
  store.set(WALLET_KEY, JSON.stringify({ ...createWallet(), coins: 100 }))
  storage.failWrites = true
  const paid = creditRunCoins('online:ABCDEF:campaign-1', awards(40))
  assertDeepEqual(paid, { coins: 40, total: 140 })
  assertEqual(savedWallet().coins, 140, 'the tab keeps the unsaved wallet')
  assertEqual(creditRunCoins('online:ABCDEF:campaign-1', awards(40)).coins, 0, 'and still never pays twice')
  storage.failWrites = false
  creditRunCoins('online:ABCDEF:campaign-1', awards(40, 50))
  assertEqual(JSON.parse(store.get(WALLET_KEY)).coins, 190, 'the next successful write carries everything')
})

check('a tab that once failed to write reads storage again after a successful write', () => {
  store.set(WALLET_KEY, JSON.stringify({ ...createWallet(), coins: 500 }))
  storage.failWrites = true
  creditRunCoins('solo:recover:1:a', awards(5))
  storage.failWrites = false
  creditRunCoins('solo:recover:1:a', awards(5, 6))
  assertEqual(JSON.parse(store.get(WALLET_KEY)).coins, 511)
  // Another tab buys a pack afterwards, writing straight to storage.
  store.set(WALLET_KEY, JSON.stringify({ ...JSON.parse(store.get(WALLET_KEY)), coins: 11, packs: ['slayer_watcher'] }))
  assertEqual(savedWallet().coins, 11, 'the recovered tab still reads its stale in-memory wallet')
  creditRunCoins('solo:recover:2:b', awards(4))
  const stored = JSON.parse(store.get(WALLET_KEY))
  assertEqual(stored.coins, 15)
  assertDeepEqual(stored.packs, ['slayer_watcher'], 'the recovered tab overwrote the other tab\'s purchase')
})

suite('a wallet per account')

const signIn = (username) => store.set('sts-profile', JSON.stringify({ username, token: '00000000-0000-4000-8000-00000000000' + (username.length % 10) }))
const signOut = () => store.delete('sts-profile')
const storedAt = (key) => store.has(key) ? JSON.parse(store.get(key)) : null

check('accounts have their own keys, named like the server compares names', () => {
  assertEqual(walletKey(null), WALLET_KEY)
  assertEqual(walletKey('  Ann '), 'sts-wallet:ann')
  assertEqual(walletKey('ANN'), walletKey('ann'))
})

check('an account adopts the anonymous wallet once, by moving it, and a second account starts empty', () => {
  for (const key of [...store.keys()]) if (key.startsWith(WALLET_KEY) || key === 'sts-profile') store.delete(key)
  store.set(WALLET_KEY, JSON.stringify({ ...createWallet(), coins: 70, packs: ['slayer_defect'] }))
  signIn('Ann')
  assertEqual(savedWallet().coins, 70, 'the first account takes the coins earned before signing in')
  assertEqual(store.has(WALLET_KEY), false, 'the anonymous wallet moved rather than copied')
  assertEqual(storedAt('sts-wallet:ann').coins, 70)
  signOut()
  assertDeepEqual(savedWallet(), createWallet(), 'signed out, the anonymous wallet is empty again')
  signIn('Bo')
  assertDeepEqual(savedWallet(), createWallet(), 'a second account never inherits the first one\'s coins or packs')
  assertEqual(creditRunCoins('solo:campaign-1:9:x', awards(12)).coins, 12)
  assertEqual(storedAt('sts-wallet:bo').coins, 12)
  assertEqual(storedAt('sts-wallet:ann').coins, 70, 'crediting Bo leaves Ann alone')
  signIn('Ann')
  assertEqual(creditRunCoins('solo:campaign-1:9:x', awards(12)).coins, 0, 'a run Bo was paid for never pays Ann too')
  assertEqual(savedWallet().coins, 70)
  assertEqual(creditRunCoins('solo:campaign-4:9:w', awards(12)).coins, 12, 'Ann\'s own run pays her')
  assertEqual(savedWallet().coins, 82)
})

check('an account that already has a wallet never swallows a later anonymous one', () => {
  signOut()
  creditRunCoins('solo:campaign-2:1:y', awards(5))
  assertEqual(storedAt(WALLET_KEY).coins, 5)
  signIn('Ann')
  assertEqual(savedWallet().coins, 82)
  assertEqual(storedAt(WALLET_KEY).coins, 5, 'the anonymous coins wait for an account without a wallet')
  signIn('Cy')
  assertEqual(savedWallet().coins, 5, 'which the next new account adopts')
  assertEqual(store.has(WALLET_KEY), false)
})

check('a write that failed for one account never shows up in another account\'s wallet', () => {
  signIn('Ann')
  storage.failWrites = true
  creditRunCoins('solo:campaign-3:1:z', awards(30))
  assertEqual(savedWallet().coins, 112, 'Ann\'s tab keeps the unsaved credit')
  signIn('Bo')
  assertEqual(savedWallet().coins, 12, 'Bo sees his own stored wallet, not Ann\'s unsaved one')
  storage.failWrites = false
  signOut()
})

check('a run pays at most once per browser, whoever records it and in whichever tab', () => {
  // Tab 1 records as Ann; tab 2 still shows the same unrecorded victory and records it as Bo.
  signIn('Ann')
  const before = savedWallet().coins
  assertEqual(creditRunCoins('solo:campaign-9:1:t', awards(9)).coins, 9)
  for (const name of ['Bo', 'Cy', 'Di']) {
    signIn(name)
    const own = savedWallet().coins
    assertEqual(creditRunCoins('solo:campaign-9:1:t', awards(9)).coins, 0, `${name} claimed a run another account was paid for`)
    assertEqual(savedWallet().coins, own)
  }
  signIn('Ann')
  assertEqual(savedWallet().coins, before + 9)
  assertEqual(JSON.parse(store.get(PAID_RUNS_KEY))['solo:campaign-9:1:t'], 1)
  // A later boss of the same run (online, before finalisation never happens) still pays the next award only once.
  signIn('Bo')
  assertEqual(creditRunCoins('solo:campaign-9:1:t', awards(9, 4)).coins, 4)
  signIn('Ann')
  assertEqual(creditRunCoins('solo:campaign-9:1:t', awards(9, 4)).coins, 0)
})

check('the browser record of paid runs is validated and bounded', () => {
  assertDeepEqual(parsePaidRuns(null), {})
  assertDeepEqual(parsePaidRuns([1]), {})
  assertDeepEqual(parsePaidRuns({ ok: 2, bad: -1, frac: 1.5, huge: MAX_BOSS_AWARDS + 1, '': 1 }), { ok: 2 })
  const many = Object.fromEntries(Array.from({ length: MAX_PAID_RUNS + 10 }, (_, run) => [`solo:${run}`, 1]))
  const parsed = parsePaidRuns(many)
  assertEqual(Object.keys(parsed).length, MAX_PAID_RUNS)
  assertEqual(Object.keys(parsed)[0], 'solo:10')
  store.set(PAID_RUNS_KEY, '{broken')
  signIn('Eve')
  assertEqual(creditRunCoins('solo:campaign-10:1:e', awards(3)).coins, 3, 'a corrupt record never blocks a new run')
})

check('wallet keys fold Unicode look-alikes the way the server compares names', () => {
  assertEqual(walletKey('ＡＮＮ'), 'sts-wallet:ann')
  assertEqual(walletKey('Ａnn'), walletKey('ann'))
})

check('blocked storage still remembers, in this tab, which runs this browser paid', () => {
  signIn('Ann')
  storage.failWrites = true
  assertEqual(creditRunCoins('solo:campaign-77:1:u', awards(9)).coins, 9)
  signIn('Bo')
  assertEqual(creditRunCoins('solo:campaign-77:1:u', awards(9)).coins, 0, 'an unsaved payment was forgotten when the account changed')
  storage.failWrites = false
  creditRunCoins('solo:campaign-78:1:v', awards(2))
  const stored = JSON.parse(store.get(PAID_RUNS_KEY))
  assertEqual(stored['solo:campaign-77:1:u'], 1, 'the next successful write carries the unsaved payment')
  signOut()
})

check('the stored record of paid runs never grows past its bound', () => {
  signIn('Fay')
  for (let run = 0; run < MAX_PAID_RUNS + 5; run += 1) creditRunCoins(`solo:bulk-${run}:1:b`, awards(1))
  const stored = JSON.parse(store.get(PAID_RUNS_KEY))
  assertEqual(Object.keys(stored).length, MAX_PAID_RUNS)
  assertEqual(Object.keys(stored).at(-1), `solo:bulk-${MAX_PAID_RUNS + 4}:1:b`)
  signOut()
})

check('an online seat pays only the account that took it in this tab', () => {
  signIn('Ann')
  assertEqual(claimSeatOwner('seat-token-1'), true, 'the first account to see the seat owns it')
  signIn('Bo')
  assertEqual(claimSeatOwner('seat-token-1'), false, 'a later account does not own Ann\'s seat')
  assertEqual(claimSeatOwner('seat-token-2'), true, 'Bo owns a seat he takes himself')
  signIn('Ann')
  assertEqual(claimSeatOwner('seat-token-1'), true)
  signOut()
})

check('a seat joined later with the same player id is not foreign to the account that took it', () => {
  // joinRoom reuses ids p1..p4: Ann leaves her seat, then Bo (signed in later) joins and is p1 again.
  signIn('Ann')
  assertEqual(claimSeatOwner('ann-seat'), true)
  signIn('Bo')
  assertEqual(claimSeatOwner('bo-seat'), true, 'a new seat token starts with no owner, whatever its player id')
  assertEqual(claimSeatOwner('ann-seat'), false, 'Ann\'s old seat stays hers')
  signOut()
})

check('a seat reloaded in the same tab keeps its owner while another account is signed in', () => {
  signIn('Ann')
  assertEqual(claimSeatOwner('reload-seat'), true)
  signIn('Bo')
  // A reload empties the module's memory but not sessionStorage.
  assertEqual(reloaded.claimSeatOwner('reload-seat'), false, 'the seat was forgotten across the reload')
  signIn('Ann')
  assertEqual(reloaded.claimSeatOwner('reload-seat'), true)
  signOut()
})

check('with sessionStorage unavailable a seat still belongs to the account that took it, for the life of the tab', () => {
  const working = globalThis.sessionStorage
  const blocked = () => { throw new Error('SecurityError') }
  globalThis.sessionStorage = { getItem: blocked, setItem: blocked, removeItem: blocked }
  try {
    signIn('Ann')
    assertEqual(claimSeatOwner('blocked-seat'), true, 'the first account to see the seat owns it')
    assertEqual(claimSeatOwner('blocked-seat'), true, 'and keeps it on the next look')
    signIn('Bo')
    assertEqual(claimSeatOwner('blocked-seat'), false, 'another account is foreign to it')
    signIn('Ann')
    assertEqual(claimSeatOwner('blocked-seat'), true)
    globalThis.sessionStorage = undefined
    signIn('Bo')
    assertEqual(claimSeatOwner('missing-seat'), true, 'with no sessionStorage object at all the first account still owns it')
    signIn('Ann')
    assertEqual(claimSeatOwner('missing-seat'), false)
  } finally { globalThis.sessionStorage = working; signOut() }
})

suite('wallet storage guards')

check('browserPaidAll is true only once every award has been paid to some account', () => {
  signIn('Kit')
  const key = 'solo:paid-all:1:k'
  assertEqual(browserPaidAll(key, awards(5, 6)), false, 'nothing paid yet')
  creditRunCoins(key, awards(5))
  assertEqual(browserPaidAll(key, awards(5, 6)), false, 'one of two awards paid')
  creditRunCoins(key, awards(5, 6))
  assertEqual(browserPaidAll(key, awards(5, 6)), true)
  signIn('Lou')
  assertEqual(browserPaidAll(key, awards(5, 6)), true, 'whichever account is signed in')
  assertEqual(browserPaidAll(key, awards(5, 6, 7)), false, 'a later boss is not yet paid')
  signOut()
})

check('a credit that pays nothing never touches the browser record of paid runs', () => {
  signIn('Ned')
  const key = onlineRunKey('JOINER', 'campaign-5')
  writes.length = 0
  // A Catch Up joiner skipped both bosses: the ledger advances, but no coins were paid.
  assertEqual(creditRunCoins(key, awards(10, 20), 2).coins, 0)
  assertEqual(writes.includes(PAID_RUNS_KEY), false, 'nothing was paid, so nothing is recorded as paid')
  assertEqual(browserPaidAll(key, awards(10, 20)), false)
  creditRunCoins('solo:ned-1:1:n', awards(3))
  writes.length = 0
  assertEqual(creditRunCoins('solo:ned-1:1:n', awards(3)).coins, 0)
  assertEqual(writes.length, 0, 'a repeat credit writes nothing')
  signOut()
})

check('while the wallet cannot be saved, a later flush never writes the paid record ahead of it', () => {
  signIn('Oz')
  storage.failKey = (key) => key.startsWith('sts-wallet')
  assertEqual(creditRunCoins('solo:oz-1:1:o', awards(6)).coins, 6)
  assertEqual(store.get('sts-wallet:oz'), undefined, 'the failed wallet write stays off disk')
  updateWallet((wallet) => wallet)
  assertEqual(JSON.parse(store.get(PAID_RUNS_KEY) ?? '{}')['solo:oz-1:1:o'], undefined, 'the record reached the disk ahead of its wallet')
  storage.failKey = null
  updateWallet((wallet) => wallet)
  assertEqual(JSON.parse(store.get('sts-wallet:oz')).credited['solo:oz-1:1:o'], 1)
  assertEqual(JSON.parse(store.get(PAID_RUNS_KEY))['solo:oz-1:1:o'], 1, 'once the wallet is saved the record follows')
  signOut()
})

check('the browser record of a payment never reaches the disk ahead of its wallet, and catches up after', () => {
  signIn('Ivy')
  const paidOnDisk = () => JSON.parse(store.get(PAID_RUNS_KEY) ?? '{}')
  // The wallet write fails while the record could be written: the record must wait.
  storage.failKey = (key) => key.startsWith('sts-wallet')
  assertEqual(creditRunCoins('solo:ivy-1:1:a', awards(6)).coins, 6)
  assertEqual(paidOnDisk()['solo:ivy-1:1:a'], undefined, 'the record was saved for a wallet that was not')
  storage.failKey = null
  creditRunCoins('solo:ivy-other:1:b', awards(1))
  assertEqual(JSON.parse(store.get('sts-wallet:ivy')).credited['solo:ivy-1:1:a'], 1, 'the unsaved wallet was never written')
  assertEqual(paidOnDisk()['solo:ivy-1:1:a'], 1, 'the record never caught up with its wallet')
  // The wallet is saved but the record write fails: it is kept and written on the next change.
  storage.failKey = (key) => key === PAID_RUNS_KEY
  assertEqual(creditRunCoins('solo:ivy-2:1:c', awards(4)).coins, 4)
  assertEqual(paidOnDisk()['solo:ivy-2:1:c'], undefined)
  signIn('Jon')
  assertEqual(creditRunCoins('solo:ivy-2:1:c', awards(4)).coins, 0, 'the unsaved record was forgotten')
  storage.failKey = null
  creditRunCoins('solo:jon-1:1:d', awards(2))
  assertEqual(paidOnDisk()['solo:ivy-2:1:c'], 1)
  signOut()
})

const { purchaseSkin } = await import('../src/wallet-storage.ts')
for (const key of [...store.keys()]) store.delete(key)
signIn('Dee')
store.set('sts-wallet:dee', JSON.stringify({ ...createWallet(), coins: SKIN_PRICE + 5 }))
const firstSkinPurchase = await purchaseSkin('kratos')
const afterFirst = storedAt('sts-wallet:dee')
const retriedSkinPurchase = await purchaseSkin('kratos')
const afterRetry = storedAt('sts-wallet:dee')
signIn('Eve')
const eveSkins = savedWallet().skins
const eveSkinPurchase = await purchaseSkin('kratos')
signOut()

check('buying a skin from storage persists it, a retry cannot spend twice, and it belongs to the account', () => {
  assertEqual(firstSkinPurchase.ok, true)
  assertDeepEqual(afterFirst.skins, ['kratos'])
  assertEqual(afterFirst.coins, 5)
  assertEqual(retriedSkinPurchase.ok, false)
  assertEqual(retriedSkinPurchase.reason, 'owned')
  assertEqual(afterRetry.coins, 5, 'a second purchase takes nothing')
  assertDeepEqual(eveSkins, [], 'another account does not own it')
  assertEqual(eveSkinPurchase.reason, 'insufficient')
})

const { preferredSkin, savedSkinChoices, setPreferredSkin, wearBoughtSkin } = await import('../src/skin-preference.ts')
signIn('Fay')
store.set('sts-skins:fay', JSON.stringify({ ironclad: 'kratos' }))
const unownedRead = [preferredSkin('ironclad'), savedSkinChoices()]
setPreferredSkin('ironclad', 'kratos')
const unownedWear = store.get('sts-skins:fay')
setPreferredSkin('ironclad', undefined)
const dropped = store.get('sts-skins:fay')
wearBoughtSkin('kratos')
const unownedBought = store.get('sts-skins:fay')
store.set('sts-wallet:fay', JSON.stringify({ ...createWallet(), skins: ['kratos'] }))
const ownedRead = preferredSkin('ironclad')
wearBoughtSkin('kratos')
const worn = store.get('sts-skins:fay')
setPreferredSkin('ironclad', undefined)
signIn('Gus')
const otherAccount = preferredSkin('ironclad')
signOut()

check('only a skin the wallet owns is ever worn: an unowned choice reads as Default and the next write drops it', () => {
  assertEqual(unownedRead[0], undefined)
  assertDeepEqual(unownedRead[1], {})
  assertEqual(unownedWear, JSON.stringify({ ironclad: 'kratos' }), 'wearing an unowned skin changes nothing')
  assertEqual(dropped, '{}', 'a write drops the stale choice')
  assertEqual(unownedBought, '{}', 'an unowned skin is not worn when "bought"')
  assertEqual(ownedRead, undefined, 'owning a skin does not wear it')
  assertEqual(worn, JSON.stringify({ ironclad: 'kratos' }), 'a bought skin is worn at once')
  assertEqual(otherAccount, undefined, 'another account wears nothing')
})

report('wallet')
