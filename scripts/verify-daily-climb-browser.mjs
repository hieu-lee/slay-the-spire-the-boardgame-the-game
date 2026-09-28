#!/usr/bin/env node
// Drives the shared-seed Daily Climb from the menu to the daily ranking:
// fixed A10 setup, one attempt per day, no campaign marks, and the Daily
// Climb leaderboard tab on desktop and horizontal-phone screens.
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium, setTestUsername } from './lib/profile-browser.mjs'
import { createRoomServer } from './room-server.mjs'
import { addLeaderboardRun } from './lib/leaderboard.mjs'
import { assert, assertEqual, check, report, suite } from './lib/harness.mjs'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'artifacts/daily-climb-browser')
mkdirSync(output, { recursive: true })
process.env.VITE_LEADERBOARD = 'true'
const rooms = createRoomServer()
const { port } = await rooms.listen(0)
const roomOrigin = `http://127.0.0.1:${port}`
const vite = await createServer({ root, logLevel: 'silent', server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: roomOrigin } } } })
await vite.listen()
const origin = `http://127.0.0.1:${vite.httpServer.address().port}`
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', (error) => errors.push(String(error)))
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })

const today = new Date().toISOString().slice(0, 10)
const token = '00000000-0000-4000-8000-000000000001' // The profile-browser test player.
const screenshot = async (name) => {
  await page.waitForFunction(() => [...document.images].every((image) => image.complete && image.naturalWidth > 0))
  await page.screenshot({ path: resolve(output, `${name}.png`) })
}

try {
  suite('daily climb browser')
  const profile = await fetch(`${roomOrigin}/api/profile`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'DailyTester', token }) })
  assert(profile.ok, 'could not register the test profile')
  const rivalToken = crypto.randomUUID()
  await fetch(`${roomOrigin}/api/profile`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'Rival', token: rivalToken }) })
  for (const [id, profileToken, character, floorsCleared] of [['rival-a:campaign-1', rivalToken, 'silent', 14], ['rival-b:campaign-1', undefined, 'defect', 3]]) {
    const seeded = await fetch(`${roomOrigin}/api/leaderboard`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, profileToken, character, ascension: 10, mode: 'daily', dailyDate: today, startedAtAct: 1,
        highestBossActDefeated: 0, combatsFinished: 4, damageDealt: 80, damageTaken: 10, damageBlocked: 30,
        damageStatsComplete: true, floorsCleared, finalDeck: [{ defId: 'strike_silent', upgraded: false }] }) })
    assert(seeded.ok, `could not seed ${id}`)
  }
  // Same floors as Rival, but this climb beat its bosses (the longest result label) instead of dying.
  addLeaderboardRun(rooms.store, { id: 'champion-a:campaign-1', username: 'Champion', character: 'watcher', ascension: 10,
    mode: 'daily', dailyDate: today, startedAtAct: 1, highestBossActDefeated: 4, combatsFinished: 4, damageDealt: 40,
    damageTaken: 10, damageBlocked: 30, damageStatsComplete: true, floorsCleared: 14, finalDeck: [{ defId: 'strike_watcher', upgraded: false }] })
  await page.goto(origin)
  await setTestUsername(page, 'DailyTester')
  await page.reload()

  await page.getByRole('button', { name: 'Single Player', exact: true }).click()
  await page.getByRole('button', { name: 'Daily', exact: true }).click()
  await page.getByRole('heading', { name: 'Daily Climb' }).waitFor()
  const dailyCopy = await page.locator('.start-menu__run-options').innerText()
  const startingActs = await page.getByLabel('Starting Act').count()
  check('the Daily Climb screen explains the shared A10 seed and hides Quick Start', () => {
    assert(dailyCopy.includes("today's shared seed at Ascension 10"), dailyCopy)
    assertEqual(startingActs, 0)
  })
  await screenshot('daily-setup-desktop')
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.getByRole('button', { name: 'Embark' }).waitFor()
  const ascension = await page.getByLabel('Ascension', { exact: true }).innerText()
  check('character selection locks the climb to Ascension 10', () => {
    assert(ascension.includes('Ascension 10 · Daily Climb'), ascension)
  })
  const locked = await Promise.all(['Decrease Ascension', 'Increase Ascension'].map((name) => page.locator(`button[aria-label="${name}"]`).isDisabled()))
  check('the Ascension controls are disabled during a Daily Climb', () => assert(locked.every(Boolean)))
  await page.getByRole('button', { name: 'Embark' }).click()
  await page.waitForFunction(() => window.__STS_DEBUG__?.getRun()?.meta.dailyDate)
  const started = await page.evaluate(async (day) => {
    const run = window.__STS_DEBUG__.getRun()
    const { seedFromString } = await import('/src/game/rng.ts')
    return { runNumber: Number(run.campaign.runId.replace('campaign-', '')), ascension: run.ascension, dailyDate: run.meta.dailyDate, campaign: run.meta.campaign, act: run.act,
      sharedSeed: run.seed === seedFromString(`daily-climb:${day}`), journal: localStorage.getItem('sts-physical-campaign') }
  }, today)
  check('embarking skips the campaign choice and starts the shared seed', () => {
    assertEqual(started.ascension, 10)
    assertEqual(started.dailyDate, today)
    assertEqual(started.campaign, 'base')
    assertEqual(started.act, 1)
    assert(started.sharedSeed, 'the run did not use the day seed')
  })

  await page.evaluate(() => {
    const run = structuredClone(window.__STS_DEBUG__.getRun())
    run.neow = null
    run.phase = 'defeat'
    run.floorsCleared = 9
    run.combatsFinished = 3
    run.players[0].damageStats = { attack: 30, poison: 0, special: 0, taken: 5, blocked: 15 }
    window.__STS_DEBUG__.setRun(run)
  })
  await page.getByRole('button', { name: 'Record campaign result' }).click()
  await page.getByRole('heading', { name: '9 floors reached' }).waitFor()
  await page.getByText('Run recorded on the leaderboard.').waitFor()
  await screenshot('daily-result-desktop')
  const recorded = rooms.store.leaderboardRuns.find((run) => run.dailyDate === today && run.username === 'DailyTester')
  const journal = await page.evaluate(() => JSON.parse(localStorage.getItem('sts-physical-campaign')))
  const before = JSON.parse(started.journal)
  check('the finished climb is ranked and leaves the campaign journal untouched', () => {
    assert(recorded, 'the daily climb did not reach the server')
    assertEqual(recorded.floorsCleared, 9)
    assertEqual(recorded.ascension, 10)
    assertEqual(recorded.damageDealt, 30)
    assert(recorded.finalDeck.length > 0)
    assertEqual(JSON.stringify({ ...journal, nextRunNumber: 0 }), JSON.stringify({ ...before, nextRunNumber: 0 }), 'the daily baseline leaked into the journal')
    assertEqual(journal.nextRunNumber, started.runNumber, 'the next run would reuse the climb\'s run id')
  })

  await page.getByRole('button', { name: 'Prepare next run →' }).click()
  await page.getByRole('button', { name: 'Embark' }).waitFor()
  const standardAscension = await page.getByLabel('Ascension', { exact: true }).innerText()
  check('the next run returns to the standard mode and the player journal Ascension', () => {
    assert(standardAscension.includes('Ascension 0') && !standardAscension.includes('Daily'), standardAscension)
  })
  await page.getByRole('button', { name: 'Embark' }).click()
  await page.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
  await page.waitForFunction(() => window.__STS_DEBUG__?.getRun()?.meta.mode === 'standard' && !window.__STS_DEBUG__.getRun().campaign.finalized)
  const nextRunId = await page.evaluate(() => {
    const run = structuredClone(window.__STS_DEBUG__.getRun())
    run.neow = null
    run.phase = 'defeat'
    window.__STS_DEBUG__.setRun(run)
    return run.campaign.runId
  })
  await page.getByRole('button', { name: 'Record campaign result' }).click()
  await page.getByText('Run recorded on the leaderboard.').waitFor()
  const standardRecorded = rooms.store.leaderboardRuns.filter((run) => run.username === 'DailyTester' && !run.dailyDate)
  check('the run after a climb takes a fresh run id and still reaches the leaderboard', () => {
    assertEqual(nextRunId, `campaign-${started.runNumber + 1}`)
    assertEqual(standardRecorded.length, 1)
  })
  await page.getByRole('button', { name: 'Prepare next run →' }).click()
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await page.reload()
  await page.getByRole('button', { name: 'Single Player', exact: true }).click()
  await page.getByRole('button', { name: 'Daily', exact: true }).click()
  await page.getByText('You have already climbed today.').waitFor()
  const continueLocked = await page.getByRole('button', { name: 'Continue', exact: true }).isDisabled()
  check('a second Daily Climb on the same day is refused, even after a reload', () => assert(continueLocked))
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await page.getByRole('button', { name: 'Back', exact: true }).click()

  await page.getByRole('button', { name: 'Leaderboard', exact: true }).click()
  await page.getByRole('button', { name: 'Daily Climb', exact: true }).click()
  const rows = page.locator('.daily-board tbody tr')
  await rows.nth(2).waitFor()
  const ranking = await rows.evaluateAll((elements) => elements.map((element) => element.innerText.replace(/\s+/g, ' ').trim()))
  const wonCell = await rows.first().locator('.daily-board__result--won').count()
  check('the daily tab ranks registered players by floors reached with their result and stats', () => {
    assertEqual(ranking.length, 3, ranking.join('\n'))
    assert(ranking[0].startsWith('1 Champion 14 Victory · Act IV 10.0 75%'), ranking[0])
    assert(ranking[1].startsWith('2 Rival 14 Fell in Act I 20.0 75%'), ranking[1])
    assert(ranking[2].startsWith('3 DailyTester 9 Fell in Act I 10.0 75%'), ranking[2])
    assertEqual(wonCell, 1, 'the won climb is not highlighted')
  })
  await screenshot('daily-board-desktop')
  await page.getByRole('button', { name: 'Ironclad', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.daily-board tbody tr').length === 1)
  const ironcladRow = await rows.first().innerText()
  check('hero filters narrow the daily ranking but keep overall ranks', () => assert(/^3\s+DailyTester/.test(ironcladRow), ironcladRow))
  await page.getByRole('button', { name: 'All heroes' }).click()
  await rows.nth(2).waitFor()
  await page.getByRole('button', { name: "View DailyTester's Ironclad deck" }).click()
  const dialog = page.getByRole('dialog')
  await dialog.waitFor()
  const deckCards = await dialog.locator('.card').count()
  check('a ranked deck opens in the card viewer', () => assertEqual(deckCards, recorded.finalDeck.length))
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })
  const nextDisabled = await page.getByRole('button', { name: 'Next day' }).isDisabled()
  let limitedRequests = 0
  const rateLimit = (route) => { limitedRequests += 1; return route.fulfill({ status: 429, contentType: 'application/json', body: '{"error":"Too many daily ranking requests"}' }) }
  await page.route('**/api/leaderboard/daily**', rateLimit)
  await page.getByRole('button', { name: 'Previous day' }).click()
  await page.getByText('Too many requests — wait a moment').waitFor()
  await page.unroute('**/api/leaderboard/daily**', rateLimit)
  check('a rate-limited day asks the player to wait and is not retried', () => assertEqual(limitedRequests, 1))
  const missingEndpoint = (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Not found"}' })
  await page.route('**/api/leaderboard/daily**', missingEndpoint)
  await page.getByRole('button', { name: 'Try again' }).click()
  await page.getByText('The daily ranking arrives with the next archive server update').waitFor()
  await page.unroute('**/api/leaderboard/daily**', missingEndpoint)
  await page.getByRole('button', { name: 'Try again' }).click()
  await page.getByText('No climbs yet').waitFor()
  check('day navigation stops at today and shows empty past days', () => assert(nextDisabled))
  await page.getByRole('button', { name: 'Next day' }).click()
  await rows.nth(2).waitFor()

  // Both a common and a narrow horizontal phone, with the longest result label on the board.
  for (const [width, height, name] of [[844, 390, 'daily-board-horizontal-phone'], [667, 375, 'daily-board-narrow-horizontal-phone']]) {
    await page.setViewportSize({ width, height })
    await screenshot(name)
    const phoneFit = await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      tableWidth: document.querySelector('.daily-board .leaderboard__table-wrap')?.scrollWidth,
      tableViewport: document.querySelector('.daily-board .leaderboard__table-wrap')?.clientWidth,
      tabs: [...document.querySelectorAll('.leaderboard__tabs button')].map((button) => {
        const box = button.getBoundingClientRect()
        return button.scrollWidth <= button.clientWidth + 1 && box.bottom <= innerHeight
      }),
    }))
    check(`the daily ranking fits a ${width}px horizontal phone`, () => {
      assert(phoneFit.documentWidth <= width + 2, JSON.stringify(phoneFit))
      assert(phoneFit.tableWidth <= phoneFit.tableViewport + 2, JSON.stringify(phoneFit))
      assert(phoneFit.tabs.every(Boolean), JSON.stringify(phoneFit))
    })
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByRole('button', { name: 'Back to main menu' }).click()
  await page.evaluate(() => {
    // A save from before the shared-seed Daily Climb: daily mode with no day.
    const run = structuredClone(window.__STS_DEBUG__.getRun())
    localStorage.setItem('sts-solo-run', JSON.stringify({ version: 1, run, built: {
      count: 1, seed: 'legacy-daily', ascension: 0, chooseYourRelic: false, lastStand: false,
      characters: ['ironclad', 'silent', 'defect', 'watcher', 'slime_boss', 'guardian', 'hexaghost', 'hermit'],
      meta: { mode: 'daily', modifiers: [], quickStartAct: 1 },
    } }))
  })
  await page.reload()
  await page.getByRole('button', { name: 'Resume', exact: true }).click()
  await page.waitForFunction(() => window.__STS_DEBUG__?.getRun())
  await page.evaluate(() => {
    const run = structuredClone(window.__STS_DEBUG__.getRun())
    run.campaignProgress = { ...run.campaignProgress, unspentMarks: 1 }
    window.__STS_DEBUG__.setRun(run)
  })
  await page.getByRole('button', { name: /^Mark Colorless/ }).click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getRun().campaignProgress.colorless === 1)
  const legacyRebuild = await page.evaluate(() => window.__STS_DEBUG__.getRun().meta)
  check('a legacy daily save rebuilds its next run as a standard run', () => {
    assertEqual(legacyRebuild.mode, 'standard')
    assertEqual(legacyRebuild.dailyDate, undefined)
  })
  const openDailyCharacterScreen = async () => {
    await page.evaluate(() => {
      localStorage.removeItem('sts-daily-climb-attempt')
      localStorage.removeItem('sts-solo-run')
    })
    await page.reload()
    await page.getByRole('button', { name: 'Single Player', exact: true }).click()
    await page.getByRole('button', { name: 'Daily', exact: true }).click()
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await page.getByRole('button', { name: 'Embark' }).waitFor()
  }
  await openDailyCharacterScreen()
  // Another tab takes today's climb while this one waits on the character screen.
  await page.evaluate((day) => localStorage.setItem('sts-daily-climb-attempt', day), today)
  await page.getByRole('button', { name: 'Embark' }).click()
  await page.getByText('You have already climbed today.').waitFor()
  const refused = await page.evaluate(() => ({ embarkDisabled: document.querySelector('[aria-label="Embark"]')?.disabled,
    started: Boolean(window.__STS_DEBUG__.getRun().meta.dailyDate) }))
  check('Embark explains a climb already taken in another tab and starts nothing', () => {
    assert(refused.embarkDisabled && !refused.started, JSON.stringify(refused))
  })

  await openDailyCharacterScreen()
  await page.evaluate((day) => {
    localStorage.setItem('sts-daily-climb-attempt', day)
    window.dispatchEvent(new StorageEvent('storage', { key: 'sts-daily-climb-attempt', newValue: day }))
  }, today)
  await page.getByText('You have already climbed today.').waitFor()
  const lockedByOtherTab = await page.locator('[aria-label="Embark"]').isDisabled()
  check('a climb taken in another tab locks Embark straight away', () => assert(lockedByOtherTab))

  await openDailyCharacterScreen()
  await page.getByRole('button', { name: 'Embark' }).click()
  await page.waitForFunction(() => window.__STS_DEBUG__?.getRun()?.meta.dailyDate && !window.__STS_DEBUG__.getRun().campaign.finalized)
  const abandonedNumber = await page.evaluate(() => Number(window.__STS_DEBUG__.getRun().campaign.runId.replace('campaign-', '')))
  const journalBeforeResume = await page.evaluate(() => localStorage.getItem('sts-physical-campaign'))
  await page.reload()
  await page.getByRole('button', { name: 'Resume', exact: true }).click()
  await page.waitForFunction(() => window.__STS_DEBUG__?.getRun()?.meta.dailyDate)
  const resumed = await page.evaluate(() => ({ runId: window.__STS_DEBUG__.getRun().campaign.runId,
    ascension: window.__STS_DEBUG__.getRun().ascension, journal: localStorage.getItem('sts-physical-campaign') }))
  check('a climb resumed after a reload keeps its run and the journal', () => {
    assertEqual(resumed.runId, `campaign-${abandonedNumber}`)
    assertEqual(resumed.ascension, 10)
    assertEqual(resumed.journal, journalBeforeResume)
  })
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Return to main menu' }).click()
  await page.getByRole('button', { name: 'Single Player', exact: true }).click()
  await page.getByRole('button', { name: 'Standard', exact: true }).click()
  await page.getByRole('button', { name: 'Embark' }).click()
  await page.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
  await page.waitForFunction(() => window.__STS_DEBUG__?.getRun()?.meta.mode === 'standard' && !window.__STS_DEBUG__.getRun().campaign.finalized)
  const afterAbandon = await page.evaluate(async (day) => ({ runId: window.__STS_DEBUG__.getRun().campaign.runId,
    reusedDailySeed: window.__STS_DEBUG__.getRun().seed === (await import('/src/game/rng.ts')).seedFromString(`daily-climb:${day}`),
    ascension: window.__STS_DEBUG__.getRun().ascension, journal: JSON.parse(localStorage.getItem('sts-physical-campaign')) }), today)
  check('abandoning a climb keeps the journal and gives the next run a fresh id', () => {
    assertEqual(afterAbandon.runId, `campaign-${abandonedNumber + 1}`)
    assertEqual(afterAbandon.ascension, 0)
    assert(!afterAbandon.reusedDailySeed, 'the Standard run reused the public day seed')
    assertEqual(afterAbandon.journal.highestAscension, 0)
    assertEqual(afterAbandon.journal.colorless, 1, 'the legacy Colorless mark was lost')
  })
  const olderServer = await page.evaluate(async (day) => {
    const run = structuredClone(window.__STS_DEBUG__.getRun())
    run.campaign = { ...run.campaign, runId: 'campaign-skew', finalized: true, startedAtAct: 1 }
    run.meta = { ...run.meta, mode: 'daily', dailyDate: day }
    run.ascension = 10
    run.phase = 'defeat'
    const realFetch = window.fetch
    // A server from before the Daily Climb stores the run but knows nothing of its day.
    window.fetch = (input, init) => init?.method === 'POST' && String(input).includes('/api/leaderboard')
      ? Promise.resolve(new Response('{"ok":true,"added":true,"floorsClearedAccepted":true,"finalDeckAccepted":true,"profileAccepted":true}', { status: 201 }))
      : realFetch(input, init)
    const { queueFinishedSoloRun, flushLeaderboardOutbox } = await import('/src/leaderboard.ts')
    const id = queueFinishedSoloRun(run)
    await flushLeaderboardOutbox(true)
    const keptQueued = JSON.parse(localStorage.getItem('sts-leaderboard-outbox') ?? '[]').some((entry) => entry.id === id)
    window.fetch = realFetch
    const report = await flushLeaderboardOutbox(true)
    return { keptQueued, recorded: report.recorded.includes(id) }
  }, today)
  check('a climb stays queued until a server confirms it keeps the day', () => {
    assert(olderServer.keptQueued && olderServer.recorded, JSON.stringify(olderServer))
  })
  // Midnight: a controlled clock crosses 00:00 UTC while the menu is open.
  const clockContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const clockPage = await clockContext.newPage()
  clockPage.on('pageerror', (error) => errors.push(String(error)))
  await clockPage.clock.install({ time: new Date('2026-10-01T23:59:50Z') })
  await clockPage.goto(origin)
  const openClockCharacterScreen = async () => {
    await clockPage.getByRole('button', { name: 'Single Player', exact: true }).click()
    await clockPage.getByRole('button', { name: 'Daily', exact: true }).click()
    await clockPage.getByRole('button', { name: 'Continue', exact: true }).click()
    await clockPage.getByRole('button', { name: 'Embark' }).waitFor()
  }
  await openClockCharacterScreen()
  // Jump past midnight without letting the menu's midnight timer run.
  await clockPage.clock.setSystemTime(new Date('2026-10-02T00:00:05Z'))
  await clockPage.getByRole('button', { name: 'Embark' }).click()
  await clockPage.getByText('A new day has begun. Embark again to climb today\'s seed.').waitFor()
  const turnedStarted = await clockPage.evaluate(() => Boolean(window.__STS_DEBUG__.getRun().meta.dailyDate))
  await clockPage.getByRole('button', { name: 'Embark' }).click()
  await clockPage.waitForFunction(() => window.__STS_DEBUG__?.getRun()?.meta.dailyDate)
  const turnedDay = await clockPage.evaluate(() => window.__STS_DEBUG__.getRun().meta.dailyDate)
  check('an Embark after midnight explains the new day before climbing it', () => {
    assert(!turnedStarted, 'yesterday\'s menu started a climb')
    assertEqual(turnedDay, '2026-10-02')
  })
  await clockContext.close()

  const timerContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const timerPage = await timerContext.newPage()
  timerPage.on('pageerror', (error) => errors.push(String(error)))
  await timerPage.clock.install({ time: new Date('2026-10-02T23:59:58Z') })
  await timerPage.goto(origin)
  await timerPage.getByRole('button', { name: 'Single Player', exact: true }).click()
  await timerPage.getByRole('button', { name: 'Daily', exact: true }).click()
  await timerPage.getByRole('button', { name: 'Continue', exact: true }).click()
  await timerPage.getByRole('button', { name: 'Embark' }).waitFor()
  await timerPage.clock.runFor(5_000)
  await timerPage.getByRole('button', { name: 'Embark' }).click()
  await timerPage.waitForFunction(() => window.__STS_DEBUG__?.getRun()?.meta.dailyDate)
  const timerDay = await timerPage.evaluate(() => window.__STS_DEBUG__.getRun().meta.dailyDate)
  check('the menu rolls over to the new day at 00:00 UTC on its own', () => assertEqual(timerDay, '2026-10-03'))
  await timerContext.close()

  // The rate-limit and missing-endpoint checks above deliberately answer with 429 and 404.
  const unexpected = errors.filter((error) => !error.includes('status of 429') && !error.includes('status of 404'))
  check('the daily climb raised no browser errors', () => assertEqual(unexpected.length, 0, unexpected.join('\n')))
} finally {
  await browser.close()
  await vite.close()
  await rooms.close()
}

report('daily climb browser')
