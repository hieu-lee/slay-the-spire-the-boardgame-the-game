// Client lifecycle coverage: isolated devices, visible balances, a real purchase,
// offline credit replay, refresh races, and account changes while HTTP is pending.
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { createRoomServer } from './room-server.mjs'
import { CARD_PACK_PRICE } from '../src/game/coins.ts'

process.env.VITE_COIN_GRANTS = 'true'
const rooms = createRoomServer()
const { port } = await rooms.listen(0)
const target = `http://127.0.0.1:${port}`
const account = { username: 'WalletSyncTest', token: crypto.randomUUID(), secured: true }
await fetch(`${target}/api/profile`, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ ...account, password: 'wallet sync test password' }) })
rooms.store.coinGrants.push({ username: 'walletsynctest', coins: 9772, grantId: 'cd'.repeat(16), claimId: crypto.randomUUID(), claimedAt: Date.now() })
const vite = await createServer({ logLevel: 'silent', server: { host: '127.0.0.1', port: 0,
  proxy: { '/api': { target }, '/ws': { target, ws: true } } } })
await vite.listen()
const url = `http://127.0.0.1:${vite.httpServer.address().port}`
const browser = await chromium.launch({ headless: true })
const errors = []
mkdirSync('artifacts/wallet-sync', { recursive: true })
async function device(viewport, phone) {
  const context = await browser.newContext({ viewport, isMobile: phone, hasTouch: phone })
  await context.addInitScript((profile) => {
    if (!localStorage.getItem('sts-profile')) localStorage.setItem('sts-profile', JSON.stringify(profile))
  }, account)
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(url)
  await page.waitForFunction(() => document.querySelector('.start-menu__purse')?.getAttribute('aria-label') === 'Shop · 9772 coins')
  return { context, page }
}
const wallet = (page) => page.evaluate(async () => (await import('/src/wallet-storage.ts')).savedWallet())
const sync = (page) => page.evaluate(async () => { await (await import('/src/wallet-storage.ts')).syncAccountWallet() })
async function shot(page, name) {
  await page.evaluate(async () => {
    await Promise.all([...document.images].filter((image) => image.getBoundingClientRect().width > 0)
      .map((image) => image.decode().catch(() => {})))
    await Promise.all(document.getAnimations().filter((animation) => animation.effect.getTiming().iterations !== Infinity)
      .map((animation) => animation.finished.catch(() => {})))
  })
  await page.screenshot({ path: `artifacts/wallet-sync/${name}.png` })
}
try {
  const laptop = await device({ width: 1440, height: 900 }, false)
  const phone = await device({ width: 844, height: 390 }, true)
  assert.equal((await wallet(laptop.page)).coins, (await wallet(phone.page)).coins)
  await shot(laptop.page, 'desktop-menu')
  await shot(phone.page, 'horizontal-phone-menu')
  await phone.page.locator('.start-menu__purse').click()
  await phone.page.getByRole('button', { name: `Buy Defect Slayer Pack, ${CARD_PACK_PRICE.toLocaleString('en-US')} coins`, exact: true }).click()
  await phone.page.locator('.shop-confirm .shop-button--buy').click()
  await phone.page.getByRole('dialog', { name: 'Defect Slayer Pack unlocked' }).waitFor()
  assert.equal((await wallet(phone.page)).coins, 9772 - CARD_PACK_PRICE)
  await shot(phone.page, 'horizontal-phone-purchase')
  await sync(laptop.page)
  assert.deepEqual((await wallet(laptop.page)).packs, ['slayer_defect'])
  await laptop.page.reload()
  await laptop.page.waitForFunction(() => document.querySelector('.start-menu__purse')?.getAttribute('aria-label') === 'Shop · 8812 coins')

  // An offline recorded run stays queued on disk and is sent after a reload.
  await laptop.context.setOffline(true)
  await laptop.page.evaluate(async () => {
    const { creditRunCoins } = await import('/src/wallet-storage.ts')
    creditRunCoins('solo:offline-run:123:nonce', [{ act: 1, coins: 100 }])
    creditRunCoins('solo:offline-run:123:nonce', [{ act: 1, coins: 100 }, { act: 2, coins: 150 }])
  })
  assert.equal((await wallet(laptop.page)).coins, 9062)
  await laptop.context.setOffline(false)
  await laptop.page.reload()
  await laptop.page.waitForFunction(() => JSON.parse(localStorage.getItem('sts-wallet:walletsynctest:sync'))?.credits.length === 0)
  await sync(phone.page)
  assert.equal((await wallet(phone.page)).coins, 9062)

  // Pause a real response after the server read it; the later local credit must
  // survive that stale response and reach the server on the following refresh.
  let release
  let seen
  const reached = new Promise((resolve) => { seen = resolve })
  const gate = new Promise((resolve) => { release = resolve })
  await laptop.page.route('**/api/profile/wallet', async (route) => {
    const response = await route.fetch()
    seen()
    await gate
    await route.fulfill({ response })
  }, { times: 1 })
  const pending = sync(laptop.page)
  await reached
  await laptop.page.evaluate(async () => {
    (await import('/src/wallet-storage.ts')).creditRunCoins('solo:during-refresh:456:nonce', [{ act: 2, coins: 200 }])
  })
  release()
  await pending
  assert.equal((await wallet(laptop.page)).coins, 9262, 'the stale reply erased an in-flight payment')
  await sync(laptop.page)
  await sync(phone.page)
  assert.equal((await wallet(phone.page)).coins, 9262)

  // An account switch must not write the previous account's reply into the new wallet.
  let releaseSwitch
  let seenSwitch
  const switched = new Promise((resolve) => { seenSwitch = resolve })
  const switchGate = new Promise((resolve) => { releaseSwitch = resolve })
  await laptop.page.route('**/api/profile/wallet', async (route) => {
    const response = await route.fetch()
    seenSwitch()
    await switchGate
    await route.fulfill({ response })
  }, { times: 1 })
  const oldAccount = sync(laptop.page).catch(() => {})
  await switched
  await laptop.page.evaluate(() => {
    localStorage.setItem('sts-profile', JSON.stringify({ username: 'DifferentAccount', token: crypto.randomUUID(), secured: true }))
    window.dispatchEvent(new Event('sts-profile-change'))
  })
  releaseSwitch()
  await oldAccount
  assert.equal((await wallet(laptop.page)).coins, 0)
  assert.deepEqual((await wallet(laptop.page)).packs, [])
  assert.deepEqual(errors, [])
  console.log('Wallet sync browser: desktop/phone balances, purchase, reload, offline replay, response races and account isolation passed')
} finally {
  await browser.close()
  await vite.close()
  await rooms.close()
}
