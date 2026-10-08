// Password accounts in a real browser: creating one on a first visit, logging out and back in,
// the one-time password prompt for a name-only profile, and the Profile screen's personal stats.
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { createRoomServer } from './room-server.mjs'
import { suite, check, assert, assertEqual, report } from './lib/harness.mjs'

suite('account browser')

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = join(root, 'artifacts/account-browser')
mkdirSync(output, { recursive: true })
const password = 'account browser password'
const rooms = createRoomServer()
const roomAddress = await rooms.listen(0)
const vite = await createServer({ root, logLevel: 'silent', server: {
  host: '127.0.0.1', port: 0, proxy: { '/api': { target: `http://127.0.0.1:${roomAddress.port}` } },
} })
await vite.listen()
const address = vite.httpServer?.address()
if (!address || typeof address === 'string') throw new Error('vite did not report a port')
const origin = `http://127.0.0.1:${address.port}`
// Keep Chromium's shared memory off a crowded /tmp tmpfs, as the shared profile-browser helper does.
const browser = await chromium.launch({ ignoreDefaultArgs: ['--disable-dev-shm-usage'] })
const errors = []
const saved = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('sts-profile') ?? 'null'))
const settled = (page) => page.locator('.welcome__panel').evaluate((panel) => Promise.all(panel.getAnimations().map((animation) => animation.finished)))
const fits = (page, locator) => locator.evaluate((element) => {
  const box = element.getBoundingClientRect()
  return box.top >= 0 && box.left >= 0 && box.bottom <= innerHeight && box.right <= innerWidth
})

try {
  for (const [screen, viewport, phone] of [
    ['desktop', { width: 1440, height: 900 }, false],
    ['landscape-phone', { width: 844, height: 390 }, true],
  ]) {
    const username = `Account${phone ? 'Phone' : 'Desktop'}`
    const context = await browser.newContext({ viewport, isMobile: phone, hasTouch: phone })
    const page = await context.newPage()
    page.on('pageerror', (error) => errors.push(`${screen}: ${error.message}`))
    page.on('console', (message) => { // The wrong password is answered with a 401 on purpose; the browser logs every such response.
      if (message.type() === 'error' && !/status of (401|409)/.test(message.text())) errors.push(`${screen}: ${message.text()}`) })
    const start = async () => {
      await page.getByRole('button', { name: 'Tap, click, or press any key to start' }).click()
      await page.getByLabel('Password', { exact: true }).waitFor()
    }

    await page.goto(origin)
    await start()
    const create = page.getByRole('button', { name: 'Create account' })
    await settled(page)
    await page.getByLabel('Username').fill(username)
    await page.getByLabel('Password', { exact: true }).fill('short')
    assert(await create.isDisabled(), 'a short password was accepted')
    await page.getByLabel('Password', { exact: true }).fill(password)
    assert(await create.isEnabled(), 'a valid name and password was refused')
    assert(await fits(page, create), `${screen}: the create account button is clipped`)
    assert(await fits(page, page.locator('.welcome__links')), `${screen}: the log in link is clipped`)
    await page.screenshot({ path: join(output, `${screen}-create.png`) })
    await create.click()
    await page.locator('.start-menu__nav').waitFor()
    const created = await saved(page)
    check(`${screen}: a new account is saved with a password on the server`, () => {
      assertEqual(created.username, username)
      assertEqual(created.secured, true)
      const stored = rooms.store.profiles.find((profile) => profile.token === created.token)
      assert(stored?.passwordHash, 'server profile has no password hash')
    })

    await page.getByRole('button', { name: 'Profile', exact: true }).click()
    await page.getByRole('heading', { name: 'Profile', exact: true }).waitFor()
    await page.getByText('No runs recorded yet').waitFor()
    await page.screenshot({ path: join(output, `${screen}-profile-empty.png`) })
    const run = { id: `account-run-${screen}`, character: 'silent', ascension: 3, mode: 'standard', startedAtAct: 1,
      highestBossActDefeated: 3, combatsFinished: 10, damageDealt: 30, damageTaken: 10, damageBlocked: 10, floorsCleared: 40,
      profileToken: created.token }
    const recorded = await fetch(`http://127.0.0.1:${roomAddress.port}/api/leaderboard`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(run) })
    assertEqual(recorded.status, 201)
    await page.getByRole('button', { name: 'Back to main menu' }).click()
    await page.getByRole('button', { name: 'Profile', exact: true }).click()
    await page.locator('.profile__metrics').waitFor()
    assertEqual(await page.locator('.profile__metric').filter({ hasText: 'Runs' }).locator('strong').textContent(), '1')
    assertEqual(await page.locator('.profile__metric').filter({ hasText: 'Best floors' }).locator('strong').textContent(), '40')
    assertEqual(await page.locator('.profile__metric').filter({ hasText: 'Highest win' }).locator('strong').textContent(), 'Ascension 3')
    assertEqual(await page.locator('.profile__heroes li').count(), 1)
    assert(await page.locator('.profile__heroes li').first().textContent().then((text) => text.includes('Silent')), 'hero row missing')
    assertEqual(await page.locator('.profile__name').textContent(), username)
    assert(await fits(page, page.locator('.profile__logout')), `${screen}: the log out button is clipped`)
    await page.screenshot({ path: join(output, `${screen}-profile.png`) })

    await page.getByRole('button', { name: 'Log out' }).click()
    await page.getByLabel('Password', { exact: true }).waitFor()
    assertEqual(await saved(page), null)
    assertEqual(await page.evaluate(() => localStorage.getItem('sts-profile-token')), null)
    assertEqual(await page.getByLabel('Username').inputValue(), '')
    await page.getByRole('button', { name: 'Already have an account? Log in' }).click()
    await page.getByLabel('Username').fill(username.toLowerCase())
    await page.getByLabel('Password', { exact: true }).fill('the wrong password')
    await page.getByRole('button', { name: 'Log in', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: 'Wrong username or password.' }).waitFor()
    assertEqual(await saved(page), null)
    await page.getByLabel('Password', { exact: true }).fill(password)
    await settled(page)
    assert(await fits(page, page.getByRole('button', { name: 'Log in', exact: true })), `${screen}: the log in button is clipped`)
    await page.screenshot({ path: join(output, `${screen}-login.png`) })
    await page.getByRole('button', { name: 'Log in', exact: true }).click()
    await page.locator('.start-menu__nav').waitFor()
    const loggedIn = await saved(page)
    check(`${screen}: logging in restores the account and its token`, () => {
      assertEqual(loggedIn.token, created.token)
      assertEqual(loggedIn.username, username)
      assertEqual(loggedIn.secured, true)
    })
    await context.close()

    // A profile from before passwords existed: still on this browser and on the server, no password.
    const legacy = { username: `Legacy${phone ? 'Phone' : 'Desktop'}`, token: phone ? '00000000-0000-4000-8000-0000000000a2' : '00000000-0000-4000-8000-0000000000a1' }
    rooms.store.profiles.push({ ...legacy })
    const legacyContext = await browser.newContext({ viewport, isMobile: phone, hasTouch: phone })
    await legacyContext.addInitScript((profile) => { if (!localStorage.getItem('sts-profile')) localStorage.setItem('sts-profile', JSON.stringify(profile)) }, legacy)
    const legacyPage = await legacyContext.newPage()
    legacyPage.on('pageerror', (error) => errors.push(`${screen} legacy: ${error.message}`))
    await legacyPage.goto(origin)
    await legacyPage.getByRole('button', { name: 'Tap, click, or press any key to start' }).click()
    await legacyPage.getByRole('heading', { name: 'Create a password' }).waitFor()
    assertEqual(await legacyPage.getByLabel('Username').count(), 0)
    const save = legacyPage.getByRole('button', { name: 'Save password' })
    await legacyPage.getByLabel('Password', { exact: true }).fill('short')
    assert(await save.isDisabled(), 'a short password was accepted for a legacy profile')
    await legacyPage.getByLabel('Password', { exact: true }).fill(password)
    await settled(legacyPage)
    assert(await fits(legacyPage, save) && await fits(legacyPage, legacyPage.locator('.welcome__links')), `${screen}: the password prompt is clipped`)
    await legacyPage.screenshot({ path: join(output, `${screen}-legacy-password.png`) })
    await save.click()
    await legacyPage.locator('.start-menu__nav').waitFor()
    assertEqual((await saved(legacyPage)).token, legacy.token)
    assertEqual((await saved(legacyPage)).secured, true)
    assert(rooms.store.profiles.find((profile) => profile.token === legacy.token)?.passwordHash, 'legacy profile did not get a password')
    await legacyPage.reload()
    await legacyPage.locator('.start-menu__nav').waitFor()
    await legacyContext.close()

    // A name-only profile that gives way to a brand new account must not claim the old name.
    const stranger = { username: `Stranger${phone ? 'Phone' : 'Desktop'}`, token: phone ? '00000000-0000-4000-8000-0000000000b2' : '00000000-0000-4000-8000-0000000000b1' }
    rooms.store.profiles.push({ ...stranger })
    const switchContext = await browser.newContext({ viewport, isMobile: phone, hasTouch: phone })
    await switchContext.addInitScript((profile) => {
      if (localStorage.getItem('sts-profile')) return
      localStorage.setItem('sts-profile', JSON.stringify(profile))
      localStorage.setItem('sts-profile-token', profile.token)
      localStorage.setItem('sts-solo-run', '{}')
    }, stranger)
    const switchPage = await switchContext.newPage()
    await switchPage.goto(origin)
    await switchPage.getByRole('button', { name: 'Tap, click, or press any key to start' }).click()
    await switchPage.getByRole('button', { name: 'Use a different account' }).click()
    await switchPage.getByRole('button', { name: 'New here? Create an account' }).click()
    await switchPage.getByLabel('Username').fill(`Fresh${phone ? 'Phone' : 'Desktop'}`)
    await switchPage.getByLabel('Password', { exact: true }).fill(password)
    await switchPage.getByRole('button', { name: 'Create account' }).click()
    await switchPage.locator('.start-menu__nav').waitFor()
    const fresh = await saved(switchPage)
    check(`${screen}: replacing a name-only profile creates the new account and leaves the old one alone`, () => {
      assertEqual(fresh.username, `Fresh${phone ? 'Phone' : 'Desktop'}`)
      assert(fresh.token !== stranger.token, 'the new account reused the old claim token')
      assertEqual(rooms.store.profiles.find((profile) => profile.token === stranger.token)?.passwordHash, undefined)
    })
    assertEqual(await switchPage.evaluate(() => localStorage.getItem('sts-solo-run')), null)
    await switchPage.evaluate(() => localStorage.setItem('sts-solo-run', '{}'))
    await switchPage.getByRole('button', { name: 'Profile', exact: true }).click()
    await switchPage.getByText('Logging out discards your saved run or room seat.').waitFor()
    await switchPage.getByRole('button', { name: 'Log out' }).click()
    await switchPage.getByLabel('Password', { exact: true }).waitFor()
    assertEqual(await switchPage.evaluate(() => localStorage.getItem('sts-solo-run')), null)
    await switchContext.close()

    // A registration whose response was lost keeps its claim token, but only for the same name.
    const lost = { username: `Lost${phone ? 'Phone' : 'Desktop'}`, token: phone ? '00000000-0000-4000-8000-0000000000c2' : '00000000-0000-4000-8000-0000000000c1' }
    assert((await fetch(`${origin}/api/profile`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...lost, password }) })).ok, 'could not seed the lost registration')
    const lostContext = await browser.newContext({ viewport, isMobile: phone, hasTouch: phone })
    await lostContext.addInitScript((claim) => {
      if (localStorage.getItem('sts-profile-token')) return
      localStorage.setItem('sts-profile-token', claim.token)
      localStorage.setItem('sts-profile-claim-name', claim.username.toLowerCase())
    }, lost)
    const lostPage = await lostContext.newPage()
    await lostPage.goto(origin)
    await lostPage.getByRole('button', { name: 'Tap, click, or press any key to start' }).click()
    await lostPage.getByLabel('Username').fill(`Other${phone ? 'Phone' : 'Desktop'}`)
    await lostPage.getByLabel('Password', { exact: true }).fill(password)
    await lostPage.getByRole('button', { name: 'Create account' }).click()
    await lostPage.locator('.start-menu__nav').waitFor()
    assert((await saved(lostPage)).token !== lost.token, 'the other name reused the lost claim token')
    await lostContext.close()

    // A profile this server has never heard of gets a message and a retry, not a blank screen.
    const unknownContext = await browser.newContext({ viewport, isMobile: phone, hasTouch: phone })
    await unknownContext.addInitScript(() => {
      if (!localStorage.getItem('sts-profile')) localStorage.setItem('sts-profile', JSON.stringify({
        username: 'Unregistered', token: '00000000-0000-4000-8000-0000000000d1', secured: true }))
    })
    const unknownPage = await unknownContext.newPage()
    await unknownPage.goto(origin)
    await unknownPage.getByRole('button', { name: 'Profile', exact: true }).click()
    await unknownPage.getByRole('alert').filter({ hasText: 'not registered on this server' }).waitFor()
    await unknownPage.getByRole('button', { name: 'Try again' }).click()
    await unknownPage.getByRole('alert').filter({ hasText: 'not registered on this server' }).waitFor()
    await unknownContext.close()
  }
} finally {
  await browser.close()
  await vite.close()
  await rooms.close()
}
check('no browser errors', () => assertEqual(errors.join('\n'), ''))
report('account browser')
