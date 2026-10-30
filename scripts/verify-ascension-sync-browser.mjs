import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { createServer } from 'vite'
import { chromium } from './lib/silent-browser.mjs'
import { createRoomServer } from './room-server.mjs'
import { createCampaignProgress } from '../src/game/campaign.ts'

process.env.VITE_COIN_GRANTS = 'true'
const rooms = createRoomServer()
const target = `http://127.0.0.1:${(await rooms.listen(0)).port}`
const password = 'ascension sync browser password'
const account = { username: 'AscensionBrowser', token: crypto.randomUUID(), secured: true }
const other = { username: 'OtherClimber', token: crypto.randomUUID(), secured: true }
for (const profile of [account, other]) {
  const response = await fetch(`${target}/api/profile`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...profile, password }) })
  assert.equal(response.status, 200)
}
const vite = await createServer({ logLevel: 'silent', optimizeDeps: { noDiscovery: true,
  include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime'] }, server: { host: '127.0.0.1', port: 0,
  proxy: { '/api': { target }, '/ws': { target, ws: true } } } })
await vite.listen()
const url = `http://127.0.0.1:${vite.httpServer.address().port}`
const browser = await chromium.launch({ headless: true })
const contexts = []
const errors = []
const storedLevel = (page) => page.evaluate(async () => (await import('/src/campaign-storage.ts')).savedCampaign().highestAscension)
const sync = (page) => page.evaluate(async () => (await import('/src/campaign-storage.ts')).syncAccountAscension())
const waitLevel = (page, level) => page.waitForFunction(async (expected) =>
  (await import('/src/campaign-storage.ts')).savedCampaign().highestAscension === expected, level)
const serverLevel = () => rooms.store.profiles.find((profile) => profile.token === account.token).highestAscension
async function device(viewport, seed) {
  const context = await browser.newContext({ viewport, isMobile: viewport.width < 1000, hasTouch: viewport.width < 1000 })
  contexts.push(context)
  if (seed) await context.addInitScript(({ profile, progress }) => {
    if (localStorage.getItem('test-seeded')) return
    localStorage.setItem('test-seeded', 'true')
    localStorage.setItem('sts-profile', JSON.stringify(profile))
    localStorage.setItem('sts-physical-campaign', JSON.stringify(progress))
  }, seed)
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  const pending = new Set()
  page.on('request', (request) => pending.add(request.url()))
  page.on('requestfinished', (request) => pending.delete(request.url()))
  page.on('requestfailed', (request) => pending.delete(request.url()))
  await page.goto(url, { waitUntil: 'commit' })
  try {
    await page.getByRole('button', { name: /Single Player|Tap, click, or press any key to start/ }).waitFor({ timeout: 60_000 })
  } catch (error) {
    console.error({ pending: [...pending], errors, state: await page.evaluate(() => ({ ready: document.readyState, text: document.body.innerText.slice(0, 1000) })) })
    throw error
  }
  return { context, page }
}
async function login(page, profile) {
  await page.getByRole('button', { name: 'Tap, click, or press any key to start' }).click()
  await page.getByRole('button', { name: 'Already have an account? Log in' }).click()
  await page.getByLabel('Username').fill(profile.username)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Log in', exact: true }).click()
  await page.getByRole('button', { name: 'Single Player', exact: true }).waitFor()
}
async function chooseLevel(page, level) {
  for (let current = 0; current < level; current++) await page.getByRole('button', { name: 'Increase Ascension' }).click()
  await page.getByText(`Ascension ${level}`, { exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Increase Ascension', includeHidden: true }).isDisabled(), true)
}
async function picker(page) {
  await page.getByRole('button', { name: 'Single Player', exact: true }).click()
  await page.getByRole('button', { name: 'Standard', exact: true }).click()
  await page.getByRole('button', { name: 'Embark', exact: true }).waitFor()
}
async function shot(page, label) {
  await page.evaluate(async () => {
    await Promise.all([...document.images].filter((image) => image.getBoundingClientRect().width > 0)
      .map((image) => image.decode().catch(() => {})))
  })
  await page.screenshot({ path: `artifacts/ascension-sync/${label}.png`, animations: 'disabled' })
}
mkdirSync('artifacts/ascension-sync', { recursive: true })
try {
  const progress = { ...createCampaignProgress(), highestAscension: 5 }
  progress.characters.ironclad = 3
  const laptop = await device({ width: 1440, height: 900 }, { profile: account, progress })
  await laptop.page.getByRole('button', { name: 'Single Player', exact: true }).waitFor()
  await sync(laptop.page)
  assert.equal(serverLevel(), 5)
  console.log('✓ legacy device uploads A5')
  assert.equal(await laptop.page.evaluate(() => localStorage.getItem('sts-physical-campaign')), null, 'legacy progress must move once')

  const created = await fetch(`${target}/api/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: account.username, character: 'ironclad', campaignProgress: createCampaignProgress() }) }).then((response) => response.json())
  const roomSeat = { code: created.snapshot.code, token: created.token }
  const lobbyContext = await browser.newContext({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true })
  contexts.push(lobbyContext)
  await lobbyContext.addInitScript(({ profile, seat }) => {
    localStorage.setItem('sts-profile', JSON.stringify(profile))
    sessionStorage.setItem('sts-room-session', JSON.stringify(seat))
  }, { profile: account, seat: roomSeat })
  const lobby = await lobbyContext.newPage()
  lobby.on('pageerror', (error) => errors.push(error.message))
  let releaseLobby
  let seenLobby
  const lobbyGate = new Promise((resolve) => { releaseLobby = resolve })
  const lobbyReached = new Promise((resolve) => { seenLobby = resolve })
  await lobby.route('**/api/profile/ascension', async (route) => {
    const response = await route.fetch()
    seenLobby()
    await lobbyGate
    await route.fulfill({ response }).catch(() => {})
  })
  try {
    await lobby.goto(url, { waitUntil: 'commit' })
    await lobby.locator('.online-lobby').waitFor({ timeout: 60_000 })
    await lobbyReached
    await lobby.waitForFunction(async ({ code, token }) => {
      const room = await fetch(`/api/rooms/${code}`, { headers: { 'x-room-token': token } }).then((response) => response.json())
      return room.you.connected
    }, roomSeat)
    assert.equal(rooms.store.rooms.get(roomSeat.code).campaignProgress.highestAscension, 0)
    releaseLobby()
    await sync(lobby)
    await waitLevel(lobby, 5)
    await lobby.getByLabel('Ascension', { exact: true }).selectOption('5')
    await lobby.waitForFunction(() => document.querySelector('select[aria-label="Ascension"]')?.value === '5')
    assert.equal(await lobby.getByLabel('Ascension', { exact: true }).inputValue(), '5', 'an already-authenticated lobby must receive the restored account unlock')
    await shot(lobby, 'horizontal-phone-lobby-synced')
    console.log('✓ a delayed account reply refreshes an already-authenticated multiplayer lobby')
  } finally { releaseLobby() }

  const phone = await device({ width: 844, height: 390 })
  await login(phone.page, account)
  await waitLevel(phone.page, 5)
  assert.equal(await phone.page.evaluate(async () => (await import('/src/campaign-storage.ts')).savedCampaign().characters.ironclad), 0,
    'sync must not copy another device\'s campaign marks')
  await picker(phone.page)
  await chooseLevel(phone.page, 5)
  console.log('✓ second device logs in and selects A5')

  // Recording a real solo result advances the journal and uploads through the normal lifecycle.
  await picker(laptop.page)
  await chooseLevel(laptop.page, 5)
  await laptop.page.getByRole('button', { name: 'Embark', exact: true }).click()
  await laptop.page.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
  await laptop.page.waitForFunction(() => window.__STS_DEBUG__?.getRun()?.ascension === 5)
  await laptop.page.evaluate(() => {
    const run = structuredClone(window.__STS_DEBUG__.getRun())
    run.phase = 'victory'
    run.act = 3
    run.neow = null
    run.campaign = { ...run.campaign, bossesDefeated: 3, highestBossActDefeated: 3 }
    window.__STS_DEBUG__.setRun(run)
  })
  await laptop.page.evaluate(() => window.dispatchEvent(new Event('sts-profile-change')))
  await laptop.page.getByRole('button', { name: 'Stop and record result', exact: true }).click()
  await waitLevel(laptop.page, 6)
  await sync(laptop.page)
  assert.equal(serverLevel(), 6)
  await phone.page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await waitLevel(phone.page, 6)
  await phone.page.getByRole('button', { name: 'Increase Ascension' }).click()
  await phone.page.getByText('Ascension 6', { exact: true }).waitFor()
  assert.equal(await phone.page.getByRole('button', { name: 'Increase Ascension', includeHidden: true }).isDisabled(), true)
  await shot(phone.page, 'horizontal-phone-synced')
  console.log('✓ solo result unlocks A6 on both devices')

  // A stale response must not erase an unlock earned offline while its request was pending.
  let release
  let seen
  const gate = new Promise((resolve) => { release = resolve })
  const reached = new Promise((resolve) => { seen = resolve })
  await phone.page.route('**/api/profile/ascension', async (route) => {
    const response = await route.fetch()
    seen()
    await gate
    await route.fulfill({ response })
  }, { times: 1 })
  const pending = sync(phone.page)
  await reached
  await phone.page.evaluate(async () => (await import('/src/campaign-storage.ts')).saveAscensionUnlock(7))
  release()
  await pending
  assert.equal(await storedLevel(phone.page), 7)
  await sync(phone.page)
  assert.equal(serverLevel(), 7)
  await phone.context.setOffline(true)
  await phone.page.evaluate(async () => (await import('/src/campaign-storage.ts')).saveAscensionUnlock(8))
  assert.equal(await storedLevel(phone.page), 8)
  await phone.context.setOffline(false)
  await phone.page.reload({ waitUntil: 'domcontentloaded' })
  await waitLevel(phone.page, 8)
  await sync(phone.page)
  assert.equal(serverLevel(), 8)
  console.log('✓ stale responses and offline reload preserve earned levels')

  // A response for the previous account must not be applied after an account switch.
  let releaseSwitch
  let seenSwitch
  const switchGate = new Promise((resolve) => { releaseSwitch = resolve })
  const switchReached = new Promise((resolve) => { seenSwitch = resolve })
  await phone.page.route('**/api/profile/ascension', async (route) => {
    const response = await route.fetch()
    seenSwitch()
    await switchGate
    await route.fulfill({ response })
  }, { times: 1 })
  const oldAccount = sync(phone.page)
  await switchReached
  await phone.page.evaluate(async ({ username, password }) => {
    await (await import('/src/profile.ts')).logIn(username, password)
  }, { username: other.username, password })
  releaseSwitch()
  await oldAccount
  await sync(phone.page)
  assert.equal(await storedLevel(phone.page), 0)
  assert.equal(rooms.store.profiles.find((profile) => profile.token === other.token).highestAscension, 0)
  console.log('✓ pending responses cannot affect a different account')
  await picker(phone.page)
  await phone.page.getByText('Ascension 0', { exact: true }).waitFor()
  assert.equal(await phone.page.getByRole('button', { name: 'Increase Ascension', includeHidden: true }).isDisabled(), true)

  // Signing back in restores this account's own journal; another open tab sees the same unlock.
  await phone.page.evaluate(async ({ username, password }) => {
    await (await import('/src/profile.ts')).logIn(username, password)
  }, { username: account.username, password })
  await waitLevel(phone.page, 8)
  await laptop.page.reload({ waitUntil: 'domcontentloaded' })
  await waitLevel(laptop.page, 8)
  await picker(laptop.page)
  await chooseLevel(laptop.page, 8)
  await shot(laptop.page, 'desktop-synced')

  const sibling = await phone.context.newPage()
  sibling.on('pageerror', (error) => errors.push(error.message))
  await sibling.goto(url, { waitUntil: 'domcontentloaded' })
  await picker(sibling)
  await chooseLevel(sibling, 8)

  // A full storage quota must keep the earned level playable and uploadable, then flush when storage recovers.
  await laptop.page.evaluate(async () => {
    const storage = await import('/src/campaign-storage.ts')
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) {
      if (key === storage.campaignKey()) throw new DOMException('quota full', 'QuotaExceededError')
      return original.call(this, key, value)
    }
    try {
      storage.saveAscensionUnlock(9)
      await storage.syncAccountAscension()
    } finally { Storage.prototype.setItem = original }
    storage.saveCampaign(storage.savedCampaign())
  })
  assert.equal(serverLevel(), 9)
  await laptop.page.reload({ waitUntil: 'domcontentloaded' })
  await waitLevel(laptop.page, 9)
  await phone.page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await waitLevel(phone.page, 9)
  await sibling.getByRole('button', { name: 'Increase Ascension' }).click()
  await sibling.getByText('Ascension 9', { exact: true }).waitFor()
  console.log('✓ quota recovery and open-tab refresh preserve A9')
  assert.equal(await sibling.getByRole('button', { name: 'Increase Ascension', includeHidden: true }).isDisabled(), true)
  // A second tab already holds a newer campaign journal when the remote Ascension arrives.
  await phone.page.evaluate(async () => {
    const storage = await import('/src/campaign-storage.ts')
    const progress = storage.savedCampaign()
    storage.saveCampaign({ ...progress, characters: { ...progress.characters, ironclad: 4 } })
  })
  await laptop.page.evaluate(async () => {
    const storage = await import('/src/campaign-storage.ts')
    storage.saveAscensionUnlock(10)
    await storage.syncAccountAscension()
  })
  await sync(phone.page)
  await sibling.getByRole('button', { name: 'Increase Ascension' }).click()
  await sibling.getByText('Ascension 10', { exact: true }).waitFor()
  assert.equal(await phone.page.evaluate(async () => (await import('/src/campaign-storage.ts')).savedCampaign().characters.ironclad), 4,
    'refreshing Ascension must not replace another tab\'s campaign marks with an old run snapshot')
  assert.deepEqual(errors, [])
  console.log('✓ two-device Ascension controls, solo recording, offline replay, stale replies, account isolation, storage quota and live tabs')
} finally {
  for (const context of contexts) await context.close()
  await browser.close()
  await vite.close()
  await rooms.close()
}
