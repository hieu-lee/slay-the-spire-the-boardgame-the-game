// Gameplay verifiers start as returning players. The leaderboard/profile browser
// verifier imports Playwright directly to exercise real first-visit registration.
import { chromium as chromiumEngine, webkit as webkitEngine } from 'playwright'
export { devices } from 'playwright'

async function seed(context) {
  await context.addInitScript(() => {
    if (!localStorage.getItem('sts-profile')) localStorage.setItem('sts-profile', JSON.stringify({
      username: 'TestPlayer', token: '00000000-0000-4000-8000-000000000001',
    }))
  })
}

function returningPlayer(engine) {
  return { async launch(options) {
    const browser = await engine.launch(options)
    const newContext = browser.newContext.bind(browser)
    browser.newContext = async (options) => {
      const context = await newContext(options)
      await seed(context)
      return context
    }
    const newPage = browser.newPage.bind(browser)
    browser.newPage = async (options) => {
      const page = await newPage(options)
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
      username, token: '00000000-0000-4000-8000-000000000001',
    }))
  }, username)
}
