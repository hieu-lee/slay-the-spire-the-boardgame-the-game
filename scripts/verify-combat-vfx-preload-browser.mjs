import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { createRoomServer } from './room-server.mjs'

const expectedVfx = [
  'hit-burst', 'death-ash', 'death-ring',
  ...['awakened-blue-fire', 'awakened-claw-scratch', 'watcher-calm-aura', 'watcher-wrath-aura',
    'guard-bloom', 'hexaghost-flame-impact', 'hexaghost-flame', 'dark-channel', 'defect-face-orb',
    'frost-channel', 'ironclad-bash', 'ironclad-strike', 'lightning-channel', 'turn-lightning-strike',
    'magic-burst', 'potion-burst', 'silent-knife', 'silent-poison', 'silent-shiv', 'watcher-pray',
    'watcher-meteor-impact', 'watcher-meteor'].map((name) => `actions/${name}`),
].map((name) => `/assets/combat/vfx/${name}.webp`).sort()

function observeWarmup(page) {
  const responses = new Map()
  page.on('response', (response) => {
    const pathname = new URL(response.url()).pathname
    if (pathname.startsWith('/assets/combat/vfx/')) {
      responses.set(pathname, { status: response.status(), type: response.headers()['content-type'] })
    }
  })
  return async () => {
    await page.waitForFunction((paths) => paths.every((path) =>
      performance.getEntriesByName(new URL(path, location.href).href).some((entry) => entry.responseEnd > 0)), expectedVfx)
    assert.deepEqual([...responses.keys()].sort(), expectedVfx, 'incorrect combat VFX URLs')
    for (const [path, response] of responses) {
      assert.equal(response.status, 200, `${path} failed to load`)
      assert(response.type?.startsWith('image/webp'), `${path} is not a WebP image`)
    }
  }
}

const room = createRoomServer()
const roomAddress = await room.listen(0)
const target = `http://127.0.0.1:${roomAddress.port}`
const server = await createServer({ logLevel: 'silent', server: { host: '127.0.0.1', port: 0,
  proxy: { '/api': { target }, '/ws': { target, ws: true } },
} })
await server.listen()
const address = server.httpServer?.address()
if (!address || typeof address === 'string') throw new Error('vite did not report a port')
const origin = `http://127.0.0.1:${address.port}`
const browser = await chromium.launch()

try {
  const newcomer = await browser.newPage()
  const verifyNewcomerWarmup = observeWarmup(newcomer)
  await newcomer.goto(origin, { waitUntil: 'networkidle' })
  await newcomer.locator('.welcome').waitFor()
  assert.equal(await newcomer.evaluate(() => performance.getEntriesByType('resource')
    .filter((entry) => entry.name.includes('/combat/vfx/')).length), 0,
  'onboarding fetches combat VFX before the player starts a game')
  await newcomer.locator('.welcome__start').click()
  await newcomer.locator('#welcome-name').fill('New Perf Player')
  await newcomer.getByRole('button', { name: 'Confirm username' }).click()
  await newcomer.locator('.start-menu__nav').waitFor()
  await verifyNewcomerWarmup()
  await newcomer.getByRole('button', { name: 'Single Player' }).click()
  await newcomer.getByRole('button', { name: 'Standard' }).click()
  await newcomer.getByRole('button', { name: 'Embark' }).click()
  await newcomer.getByRole('button', { name: 'Start standard campaign' }).click()
  await newcomer.locator('.app-shell').waitFor()
  await newcomer.close()

  for (const storedProfile of ['{}', 'null', '{invalid json']) {
    const invalidContext = await browser.newContext()
    await invalidContext.addInitScript((value) => localStorage.setItem('sts-profile', value), storedProfile)
    const invalidPage = await invalidContext.newPage()
    await invalidPage.goto(origin, { waitUntil: 'networkidle' })
    await invalidPage.locator('.welcome').waitFor()
    assert.equal(await invalidPage.evaluate(() => performance.getEntriesByType('resource')
      .filter((entry) => entry.name.includes('/combat/vfx/')).length), 0,
    `invalid profile ${storedProfile} fetched combat VFX on onboarding`)
    await invalidContext.close()
  }

  const context = await browser.newContext()
  await context.addInitScript(() => localStorage.setItem('sts-profile', JSON.stringify({
    username: 'PerfCheck', token: '00000000-0000-4000-8000-000000000001',
  })))
  const page = await context.newPage()
  const verifyReturningWarmup = observeWarmup(page)
  await page.goto(origin, { waitUntil: 'networkidle' })
  await page.locator('.start-menu__nav').waitFor()
  await verifyReturningWarmup()
  assert.equal(await page.locator('link[data-combat-vfx]').count(), expectedVfx.length,
    'returning players must warm effects before resuming or reconnecting')
  const initiators = await page.evaluate((paths) => paths.map((path) =>
    performance.getEntriesByName(new URL(path, location.href).href)[0]?.initiatorType), expectedVfx)
  assert(initiators.every((initiator) => initiator === 'link'),
    'returning players must begin warming effects before game JavaScript runs')
  await page.close()

  const online = await context.newPage()
  const verifyOnlineWarmup = observeWarmup(online)
  await online.goto(origin, { waitUntil: 'networkidle' })
  await verifyOnlineWarmup()
  await online.getByRole('button', { name: 'Play online' }).click()
  await online.locator('.online-entry').waitFor()
  console.log('newcomers warm on signup; returning players warm before solo resume or online reconnect')
  await context.close()
} finally {
  await browser.close()
  await server.close()
  await room.close()
}
