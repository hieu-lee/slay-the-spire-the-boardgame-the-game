// Gameplay verifiers start as returning players. The leaderboard/profile browser
// verifier imports Playwright directly to exercise real first-visit registration.
import { statfsSync } from 'node:fs'
import { chromium as chromiumEngine, devices, webkit as webkitEngine } from 'playwright'
export { devices } from 'playwright'

// Playwright always passes --disable-dev-shm-usage (Docker's /dev/shm is 64 MB), which
// moves Chromium's shared memory into the temp dir. When that is a crowded tmpfs, the
// multi-seat verifiers exhaust it: loads fail with ERR_INSUFFICIENT_RESOURCES (a lazy
// screen chunk never arrives, leaving a blank page) or the renderer crashes. Keep
// Chromium on /dev/shm whenever it has room for several online pages.
function roomyDevShm() {
  try {
    const { bavail, bsize } = statfsSync('/dev/shm')
    return bavail * bsize >= 1024 ** 3
  } catch { return false }
}

async function seed(context) {
  await context.addInitScript(() => {
    try {
      if (!localStorage.getItem('sts-profile')) localStorage.setItem('sts-profile', JSON.stringify({
        username: 'TestPlayer', token: '00000000-0000-4000-8000-000000000001', secured: true,
      }))
    } catch { /* Sandboxed raster frames intentionally have no storage origin. */ }
  })
}

function returningPlayer(engine) {
  const optionsFor = (options) => engine === webkitEngine && options?.isMobile
    ? { ...devices['iPhone 13 landscape'], ...options, screen: options.screen ?? options.viewport ?? devices['iPhone 13 landscape'].viewport } : options
  return { async launch(options) {
    const browser = await engine.launch(engine === chromiumEngine && options?.ignoreDefaultArgs === undefined && roomyDevShm()
      ? { ...options, ignoreDefaultArgs: ['--disable-dev-shm-usage'] } : options)
    const newContext = browser.newContext.bind(browser)
    browser.newContext = async (options) => {
      const context = await newContext(optionsFor(options))
      await seed(context)
      return context
    }
    const newPage = browser.newPage.bind(browser)
    browser.newPage = async (options) => {
      const page = await newPage(optionsFor(options))
      await seed(page.context())
      return page
    }
    return browser
  } }
}

export const chromium = returningPlayer(chromiumEngine)
export const webkit = returningPlayer(webkitEngine)

export async function setTestUsername(page, username) {
  await page.evaluate((username) => {
    localStorage.setItem('sts-profile', JSON.stringify({
      username, token: '00000000-0000-4000-8000-000000000001', secured: true,
    }))
  }, username)
}
