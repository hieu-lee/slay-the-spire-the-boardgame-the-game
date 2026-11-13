// A restricted account in a real browser: it cannot log out or open another account, and every solo
// run it starts is lost on the spot with the Spire's notice.
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from './lib/silent-browser.mjs'
import { createRoomServer } from './room-server.mjs'
import { suite, check, assert, assertEqual, report } from './lib/harness.mjs'

suite('restricted account browser')

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// The account server is asked about the account's standing only where one serves it.
process.env.VITE_COIN_GRANTS = 'true'
const output = join(root, 'artifacts/restricted-browser')
mkdirSync(output, { recursive: true })
const password = 'restricted browser password'
const NOTICE = 'Spire rejects room-temperature IQ'
const rooms = createRoomServer({ restrictedUsernames: ['Restricted Climber'] })
const roomAddress = await rooms.listen(0)
const vite = await createServer({ root, logLevel: 'silent', server: {
  host: '127.0.0.1', port: 0, proxy: { '/api': { target: `http://127.0.0.1:${roomAddress.port}` } },
} })
await vite.listen()
const address = vite.httpServer?.address()
if (!address || typeof address === 'string') throw new Error('vite did not report a port')
const origin = `http://127.0.0.1:${address.port}`
const browser = await chromium.launch({ ignoreDefaultArgs: ['--disable-dev-shm-usage'] })
const errors = []

const newPage = async (viewport, phone) => {
  const context = await browser.newContext({ viewport, isMobile: phone, hasTouch: phone })
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error' && !/status of 403/.test(message.text())) errors.push(message.text())
  })
  await page.goto(origin)
  await page.getByRole('button', { name: 'Tap, click, or press any key to start' }).click()
  return { context, page }
}
const submit = async (page, button, name) => {
  await page.getByLabel('Username').fill(name)
  await page.getByLabel('Password', { exact: true }).fill(password)
  const answered = page.waitForResponse((response) => /\/api\/(profile|login)$/.test(response.url()))
  await page.getByRole('button', { name: button }).click()
  return (await answered).status()
}
const lostRun = async (page, screen) => {
  await page.getByRole('button', { name: 'Profile', exact: true }).click()
  await page.getByRole('heading', { name: 'Profile', exact: true }).waitFor()
  const logOuts = await page.getByRole('button', { name: 'Log out' }).count()
  await page.getByRole('button', { name: 'Back to main menu' }).click()
  await page.getByRole('button', { name: 'Single Player', exact: true }).click()
  await page.getByRole('button', { name: 'Standard', exact: true }).click()
  await page.getByRole('button', { name: 'Embark' }).click()
  await page.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
  await page.getByRole('heading', { name: NOTICE }).waitFor()
  const records = await page.getByRole('button', { name: 'Record campaign result' }).count()
  const back = page.getByRole('button', { name: 'Return to main menu' })
  const fits = await back.evaluate((element) => {
    const box = element.getBoundingClientRect()
    return box.top >= 0 && box.left >= 0 && box.bottom <= innerHeight && box.right <= innerWidth
  })
  await page.screenshot({ path: join(output, `${screen}-lost-run.png`) })
  await back.click()
  await page.locator('.start-menu__nav').waitFor()
  const signedInAs = await page.evaluate(() => JSON.parse(localStorage.getItem('sts-profile') ?? 'null')?.username)
  check(`${screen}: the account has no log out, loses its solo run at once with the notice, and stays signed in`, () => {
    assertEqual(logOuts, 0)
    assertEqual(records, 0)
    assert(fits, `${screen}: the return button is clipped`)
    assertEqual(signedInAs, 'Restricted Climber')
  })
}

try {
  // Desktop signs up (the server does not know the account is restricted until it checks in), then a reload does.
  const desktop = await newPage({ width: 1440, height: 900 }, false)
  await submit(desktop.page, 'Create account', 'Restricted Climber')
  await desktop.page.locator('.start-menu__nav').waitFor()
  await desktop.page.reload()
  await desktop.page.locator('.start-menu__nav').waitFor()
  await desktop.page.waitForFunction(() => localStorage.getItem('sts-restricted') === '1')
  await lostRun(desktop.page, 'desktop')
  await desktop.context.close()

  // A phone logging in learns it from the login reply, and the browser's network is now known.
  const phone = await newPage({ width: 844, height: 390 }, true)
  await phone.page.getByRole('button', { name: /Already have an account/ }).click()
  const loggedIn = await submit(phone.page, 'Log in', 'Restricted Climber')
  await phone.page.locator('.start-menu__nav').waitFor()
  check('landscape-phone: a restricted account can still log in', () => assertEqual(loggedIn, 200))
  await lostRun(phone.page, 'landscape-phone')
  await phone.context.close()

  const fresh = await newPage({ width: 1440, height: 900 }, false)
  const refused = await submit(fresh.page, 'Create account', 'Second Account')
  await fresh.page.getByText(NOTICE).waitFor()
  check('a new account is refused from the restricted account\'s network', () => assertEqual(refused, 403))
  await fresh.context.close()
  check('no browser errors', () => assertEqual(errors.join('\n'), ''))
} finally {
  await browser.close()
  await vite.close()
  await rooms.close()
}
report('restricted account browser')
