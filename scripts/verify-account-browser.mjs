// Password accounts in a real browser: creating one on a first visit, logging out and back in,
// the one-time password prompt for a name-only profile, and the Profile screen's personal stats.
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { createRoomServer } from './room-server.mjs'
import { addLeaderboardRun } from './lib/leaderboard.mjs'
import { legacyCoinGrant } from './lib/coin-grants.mjs'
import { suite, check, assert, assertEqual, report } from './lib/harness.mjs'

suite('account browser')

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = join(root, 'artifacts/account-browser')
mkdirSync(output, { recursive: true })
const password = 'account browser password'
// The past-run coin grant is asked for only where a room server serves it.
process.env.VITE_COIN_GRANTS = 'true'
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
    assert(await fits(page, page.locator('.welcome__switch')), `${screen}: the log in link is clipped`)
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

    // The Shop wallet follows the account: the first account adopts the coins earned
    // before signing in, a second account on this browser starts with an empty purse.
    const walletContext = await browser.newContext({ viewport, isMobile: phone, hasTouch: phone })
    await walletContext.addInitScript(() => {
      if (sessionStorage.getItem('wallet-seeded')) return
      sessionStorage.setItem('wallet-seeded', '1')
      localStorage.setItem('sts-wallet', JSON.stringify({ version: 1, coins: 33, packs: ['slayer_silent'], addPacksToRuns: true, credited: {} }))
    })
    const walletPage = await walletContext.newPage()
    walletPage.on('pageerror', (error) => errors.push(`${screen} wallet: ${error.message}`))
    const purse = () => walletPage.locator('.start-menu__purse').getAttribute('aria-label')
    const createAccount = async (name) => {
      await walletPage.getByLabel('Username').fill(name)
      await walletPage.getByLabel('Password', { exact: true }).fill(password)
      await walletPage.getByRole('button', { name: 'Create account' }).click()
      await walletPage.locator('.start-menu__nav').waitFor()
    }
    const logOutHere = async () => {
      await walletPage.getByRole('button', { name: 'Profile', exact: true }).click()
      await walletPage.getByRole('button', { name: 'Log out' }).click()
      // After a reload the welcome screen first asks for a tap before showing the form.
      const tap = walletPage.getByRole('button', { name: 'Tap, click, or press any key to start' })
      await walletPage.getByLabel('Password', { exact: true }).or(tap).first().waitFor()
      if (await tap.isVisible()) await tap.click()
      await walletPage.getByLabel('Password', { exact: true }).waitFor()
    }
    const owner = `Purse${phone ? 'Phone' : 'Desktop'}A`
    await walletPage.goto(origin)
    await walletPage.getByRole('button', { name: 'Tap, click, or press any key to start' }).click()
    await walletPage.getByLabel('Password', { exact: true }).waitFor()
    await createAccount(owner)
    assertEqual(await purse(), 'Shop · 33 coins', `${screen}: the first account did not adopt the anonymous purse`)
    await logOutHere()
    // The second account's name already has a run recorded before the Shop: creating it pays
    // that run once, with a toast, and never the first account's coins.
    const second = `Purse${phone ? 'Phone' : 'Desktop'}B`
    const cutoff = rooms.store.coinsLaunchedAt
    addLeaderboardRun(rooms.store, { id: `past-run-${screen}`, username: second, character: 'ironclad', ascension: 5, mode: 'standard',
      startedAtAct: 1, highestBossActDefeated: 2, combatsFinished: 12, damageDealt: 50, damageTaken: 20, damageBlocked: 10, floorsCleared: 30 }, cutoff - 1000)
    const pastRuns = legacyCoinGrant(rooms.store.leaderboardRuns, second, cutoff).coins
    assert(pastRuns > 0, 'precondition: the past run pays coins')
    await createAccount(second)
    const pastRunsToast = walletPage.locator('.coin-gain__toast')
    await pastRunsToast.waitFor()
    assert(new RegExp(`\\+${pastRuns} coins[\\s\\S]*Your past runs · ${pastRuns} in your purse`).test(await pastRunsToast.innerText()),
      `${screen}: the past-runs toast reads ${await pastRunsToast.innerText()}`)
    await walletPage.waitForFunction((label) => document.querySelector('.start-menu__purse')?.getAttribute('aria-label') === label,
      `Shop · ${pastRuns} coins`)
    // Wait for the entry animations only: the delayed one is the toast's own fade-out.
    await walletPage.evaluate(() => Promise.all(document.querySelector('.coin-gain__toast').getAnimations({ subtree: true })
      .filter((animation) => animation.effect?.getTiming().delay === 0).map((animation) => animation.finished)))
    await walletPage.screenshot({ path: join(output, `${screen}-past-runs-toast.png`) })
    await walletPage.reload()
    await walletPage.locator('.start-menu__nav').waitFor()
    await walletPage.waitForFunction(() => !localStorage.getItem('sts-legacy-claim:' + JSON.parse(localStorage.getItem('sts-profile')).username.toLowerCase()))
    assertEqual(await purse(), `Shop · ${pastRuns} coins`, `${screen}: the past runs paid twice, or the second account inherited coins`)
    await logOutHere()
    await walletPage.getByRole('button', { name: 'Already have an account? Log in' }).click()
    await walletPage.getByLabel('Username').fill(owner)
    await walletPage.getByLabel('Password', { exact: true }).fill(password)
    await walletPage.getByRole('button', { name: 'Log in', exact: true }).click()
    await walletPage.locator('.start-menu__nav').waitFor()
    assertEqual(await purse(), 'Shop · 33 coins', `${screen}: logging back in lost the account's coins`)
    await walletContext.close()

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
    const reveal = legacyPage.getByRole('button', { name: 'Show password' })
    const field = legacyPage.locator('#welcome-password')
    const look = () => field.evaluate((input) => ({ type: input.type, background: getComputedStyle(input).backgroundColor, value: input.value }))
    const hidden = await look()
    const clear = await field.evaluate((input) => input.getBoundingClientRect().right - parseFloat(getComputedStyle(input).paddingRight)
      <= input.nextElementSibling.getBoundingClientRect().left + 0.5)
    await reveal.click()
    const shown = await look()
    const kept = await field.evaluate((input) => document.activeElement === input)
    const pressed = await reveal.getAttribute('aria-pressed')
    check(`${screen}: the eye shows the typed password without restyling the field`, () => {
      assertEqual(pressed, 'true')
      assert(clear, 'the typed password runs under the eye')
      assert(kept, 'tapping the eye moved focus out of the password field')
      assertEqual(shown.type, 'text')
      assertEqual(shown.value, hidden.value)
      assertEqual(shown.background, hidden.background, 'the shown password was restyled')
    })
    await reveal.click()
    assertEqual(await field.getAttribute('type'), 'password')
    assertEqual(await reveal.getAttribute('aria-pressed'), 'false')
    await settled(legacyPage)
    assert(await fits(legacyPage, save) && await fits(legacyPage, legacyPage.locator('.welcome__switch')), `${screen}: the password prompt is clipped`)
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
  // A stale or unknown profile token on a normal load: the past-run grant is still asked
  // for, answers "nothing", and no request fails or logs a console error.
  {
    const strangerContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await strangerContext.addInitScript(() => localStorage.setItem('sts-profile', JSON.stringify({
      username: 'GhostAccount', token: '00000000-0000-4000-8000-00000000dead', secured: true })))
    const strangerPage = await strangerContext.newPage()
    const consoleErrors = []
    const failed = []
    strangerPage.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
    strangerPage.on('response', (response) => { if (response.status() >= 400) failed.push(`${response.status()} ${response.url()}`) })
    const claim = strangerPage.waitForResponse((response) => response.url().endsWith('/api/profile/coins'))
    await strangerPage.goto(origin)
    const claimed = await claim
    await strangerPage.waitForTimeout(500)
    check('a load with an unknown profile token asks for its grant without a failed request or console error', () => {
      assertEqual(claimed.status(), 200)
      assertEqual(failed.join('\n'), '')
      assertEqual(consoleErrors.join('\n'), '')
    })
    await strangerContext.close()
  }
} finally {
  await browser.close()
  await vite.close()
  await rooms.close()
}
check('no browser errors', () => assertEqual(errors.join('\n'), ''))
report('account browser')
