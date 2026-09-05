#!/usr/bin/env node
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { assert, assertDeepEqual, assertEqual, check, report, suite } from './lib/harness.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = join(root, 'artifacts/solo-resume-browser')
mkdirSync(output, { recursive: true })
const server = await createServer({ root, logLevel: 'silent', server: { port: 0 } })
await server.listen()
const address = server.httpServer?.address()
if (!address || typeof address === 'string') throw new Error('Vite did not report a port')
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
page.on('pageerror', (error) => errors.push(String(error)))
const base = `http://localhost:${address.port}`

const waitForSavedRun = (phase) => page.waitForFunction((wanted) => {
  const saved = JSON.parse(localStorage.getItem('sts-solo-run') ?? 'null')
  return saved?.run?.phase === wanted && JSON.stringify(saved.run) === JSON.stringify(window.__STS_DEBUG__.getRun())
}, phase)

const reloadAndResume = async (selector) => {
  const before = await page.evaluate(() => JSON.stringify(window.__STS_DEBUG__.getRun()))
  await page.reload({ waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Resume', exact: true }).click()
  await page.locator(selector).waitFor()
  const after = await page.evaluate(() => JSON.stringify(window.__STS_DEBUG__.getRun()))
  assertEqual(after, before, `Resume changed the ${selector} run snapshot`)
}

try {
  suite('single-player resume')
  await page.goto(base, { waitUntil: 'networkidle' })
  const freshResumeCount = await page.getByRole('button', { name: 'Resume', exact: true }).count()
  check('a fresh profile has no Resume action', () => assertEqual(freshResumeCount, 0))

  await page.evaluate(() => localStorage.setItem('sts-solo-run', '{"version":1,"run":{"campaign":{"finalized":false}}}'))
  await page.reload({ waitUntil: 'networkidle' })
  const corruptResumeCount = await page.getByRole('button', { name: 'Resume', exact: true }).count()
  check('a corrupt checkpoint is ignored', () => assertEqual(corruptResumeCount, 0))
  await page.evaluate(() => localStorage.removeItem('sts-solo-run'))

  await page.getByRole('button', { name: 'Single Player', exact: true }).click()
  await page.getByRole('button', { name: 'Standard', exact: true }).click()
  await page.getByRole('button', { name: 'Embark' }).click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'neow')
  await page.evaluate(() => {
    const run = structuredClone(window.__STS_DEBUG__.getRun())
    window.__STS_DEBUG__.setRun({ ...run, phase: 'map', neow: null })
  })
  await page.locator('.room--reachable').first().click()
  await page.locator('.combat').waitFor()
  await page.evaluate(() => {
    const run = structuredClone(window.__STS_DEBUG__.getRun())
    run.log.push('resume-check: mid-turn')
    run.combat.players[0].energy = 1
    window.__STS_DEBUG__.setRun(run)
  })
  await waitForSavedRun('combat')
  const lastGoodCheckpoint = await page.evaluate(() => localStorage.getItem('sts-solo-run'))
  await page.evaluate(() => {
    window.__ORIGINAL_SET_ITEM__ = Storage.prototype.setItem
    Storage.prototype.setItem = function setItem(key, value) {
      if (key === 'sts-solo-run') throw new DOMException('quota', 'QuotaExceededError')
      return window.__ORIGINAL_SET_ITEM__.call(this, key, value)
    }
    const run = structuredClone(window.__STS_DEBUG__.getRun())
    run.log.push('resume-check: failed-write')
    window.__STS_DEBUG__.setRun(run)
  })
  await page.waitForTimeout(50)
  const checkpointAfterFailure = await page.evaluate(() => localStorage.getItem('sts-solo-run'))
  await page.evaluate(() => {
    Storage.prototype.setItem = window.__ORIGINAL_SET_ITEM__
    const run = structuredClone(window.__STS_DEBUG__.getRun())
    run.log.push('resume-check: recovered-write')
    window.__STS_DEBUG__.setRun(run)
  })
  await waitForSavedRun('combat')
  check('a failed write preserves the last atomic checkpoint', () =>
    assertEqual(checkpointAfterFailure, lastGoodCheckpoint))
  const combatSnapshot = await page.evaluate(() => JSON.stringify(window.__STS_DEBUG__.getRun()))
  const validCheckpoint = await page.evaluate(() => localStorage.getItem('sts-solo-run'))
  await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('sts-solo-run'))
    delete saved.run.map
    localStorage.setItem('sts-solo-run', JSON.stringify(saved))
  })
  await page.reload({ waitUntil: 'networkidle' })
  const incompleteResumeCount = await page.getByRole('button', { name: 'Resume', exact: true }).count()
  check('a shape-compatible but incomplete checkpoint is ignored', () => assertEqual(incompleteResumeCount, 0))
  await page.evaluate((checkpoint) => localStorage.setItem('sts-solo-run', checkpoint), validCheckpoint)
  await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('sts-solo-run'))
    saved.run.combat = null
    localStorage.setItem('sts-solo-run', JSON.stringify(saved))
  })
  await page.reload({ waitUntil: 'networkidle' })
  const impossibleCombatResumeCount = await page.getByRole('button', { name: 'Resume', exact: true }).count()
  check('a combat checkpoint without a combat is ignored', () => assertEqual(impossibleCombatResumeCount, 0))
  await page.evaluate((checkpoint) => localStorage.setItem('sts-solo-run', checkpoint), validCheckpoint)
  await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('sts-solo-run'))
    saved.built.meta.modifiers = 1
    localStorage.setItem('sts-solo-run', JSON.stringify(saved))
  })
  await page.reload({ waitUntil: 'networkidle' })
  const malformedMetaResumeCount = await page.getByRole('button', { name: 'Resume', exact: true }).count()
  check('a checkpoint with malformed build options is ignored', () => assertEqual(malformedMetaResumeCount, 0))
  await page.evaluate((checkpoint) => localStorage.setItem('sts-solo-run', checkpoint), validCheckpoint)
  await page.reload({ waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Resume', exact: true }).waitFor()
  const firstMenuActions = await page.locator('.start-menu__nav button').evaluateAll((buttons) =>
    buttons.slice(0, 2).map((button) => button.textContent?.trim()))
  await page.screenshot({ path: join(output, 'resume-desktop.png'), fullPage: true })
  await page.getByRole('button', { name: 'Resume', exact: true }).click()
  await page.locator('.combat').waitFor()
  const resumedCombatSnapshot = await page.evaluate(() => JSON.stringify(window.__STS_DEBUG__.getRun()))
  check('Resume sits above Single Player and restores a mid-turn combat byte-for-byte', () => {
    assertDeepEqual(firstMenuActions, ['Resume', 'Single Player'])
    assertEqual(resumedCombatSnapshot, combatSnapshot)
  })

  await page.evaluate(() => {
    const run = structuredClone(window.__STS_DEBUG__.getRun())
    run.phase = 'reward'
    run.combat = null
    run.rewardDestination = 'map'
    const choices = run.players[0].deck.slice(0, 3).map((card) => card.defId)
    run.rewards = [{
      playerId: run.players[0].id, gold: 2, cardReward: true, choices,
      upgraded: false, potion: false, relic: false, bossRelics: false,
    }]
    run.log.push('resume-check: reward-resolution')
    window.__STS_DEBUG__.setRun(run)
  })
  await waitForSavedRun('reward')
  await reloadAndResume('.reward-screen--card-choice')

  await page.evaluate(() => {
    const run = structuredClone(window.__STS_DEBUG__.getRun())
    run.phase = 'room'
    run.rewards = []
    run.rewardDestination = null
    run.roomState = { kind: 'event', card: run.eventDeck[0], decisions: {}, dieRolls: {} }
    run.log.push('resume-check: event-resolution')
    window.__STS_DEBUG__.setRun(run)
  })
  await waitForSavedRun('room')
  const eventSnapshot = await page.evaluate(() => JSON.stringify(window.__STS_DEBUG__.getRun()))
  await page.setViewportSize({ width: 844, height: 390 })
  await page.reload({ waitUntil: 'networkidle' })
  const resume = page.getByRole('button', { name: 'Resume', exact: true })
  await resume.waitFor()
  await page.screenshot({ path: join(output, 'resume-horizontal-phone.png'), fullPage: true })
  const menuFits = await page.locator('.start-menu__nav').evaluate((menu) => {
    const box = menu.getBoundingClientRect()
    return box.top >= 0 && box.bottom <= innerHeight
  })
  await resume.click()
  await page.locator('.event-stage').waitFor()
  const resumedEventSnapshot = await page.evaluate(() => JSON.stringify(window.__STS_DEBUG__.getRun()))
  check('reward and event resolutions resume byte-for-byte', () => {
    assertEqual(resumedEventSnapshot, eventSnapshot)
    assert(menuFits, 'the Resume menu overflowed the horizontal-phone viewport')
  })

  await page.evaluate(() => {
    const run = structuredClone(window.__STS_DEBUG__.getRun())
    run.phase = 'room'
    run.map.position = null
    run.setup = { kind: 'quick-start', targetAct: 2, playerIds: [run.players[0].id], rowIndex: 10, repeatIndex: 0, playerIndex: 0, die: null }
    run.roomState = { kind: 'merchant', relics: [], potions: [], colorless: [], cards: {}, removalUsed: [], purchasedCards: {}, guardianGems: {}, socketCardsBought: {} }
    run.log.push('resume-check: quick-start-merchant')
    window.__STS_DEBUG__.setRun(run)
  })
  await waitForSavedRun('room')
  await reloadAndResume('.merchant-arrival')

  const beforeMainMenu = await page.evaluate(() => JSON.stringify(window.__STS_DEBUG__.getRun()))
  await page.keyboard.press('Escape')
  const pause = page.getByRole('dialog', { name: 'Slay the Spire' })
  await pause.getByRole('button', { name: 'Return to main menu', exact: true }).click()
  await page.getByRole('button', { name: 'Resume', exact: true }).waitFor()
  const savedAtMainMenu = await page.evaluate(() => JSON.stringify(JSON.parse(localStorage.getItem('sts-solo-run')).run))
  await page.getByRole('button', { name: 'Resume', exact: true }).click()
  await page.locator('.merchant-arrival').waitFor()
  const afterMainMenu = await page.evaluate(() => JSON.stringify(window.__STS_DEBUG__.getRun()))
  check('returning to the main menu preserves the unfinished run', () => {
    assertEqual(savedAtMainMenu, beforeMainMenu)
    assertEqual(afterMainMenu, beforeMainMenu)
  })

  const oldRunId = await page.evaluate(() => window.__STS_DEBUG__.getRun().campaign.runId)
  await page.reload({ waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Single Player', exact: true }).click()
  await page.getByRole('button', { name: 'Standard', exact: true }).click()
  await page.getByRole('button', { name: 'Embark' }).click()
  await page.waitForFunction((oldId) => {
    const saved = JSON.parse(localStorage.getItem('sts-solo-run') ?? 'null')
    return saved?.run?.campaign?.runId && saved.run.campaign.runId !== oldId
  }, oldRunId)
  const replacementRunId = await page.evaluate(() => JSON.parse(localStorage.getItem('sts-solo-run')).run.campaign.runId)
  check('starting a new single-player run discards the unfinished save', () => {
    assert(replacementRunId !== oldRunId, 'the prior run survived Embark')
  })

  await page.evaluate(() => {
    const run = structuredClone(window.__STS_DEBUG__.getRun())
    run.campaign.finalized = true
    window.__STS_DEBUG__.setRun(run)
  })
  await page.waitForFunction(() => localStorage.getItem('sts-solo-run') === null)
  await page.keyboard.press('Escape')
  await pause.getByRole('button', { name: 'Return to main menu', exact: true }).click()
  const finishedReturnResumeCount = await page.getByRole('button', { name: 'Resume', exact: true }).count()
  await page.reload({ waitUntil: 'networkidle' })
  const finishedResumeCount = await page.getByRole('button', { name: 'Resume', exact: true }).count()
  check('finished runs are not resumable', () => {
    assertEqual(finishedReturnResumeCount, 0)
    assertEqual(finishedResumeCount, 0)
  })
  check('resume flow has no browser errors', () => assertDeepEqual(errors, []))
  report('single-player resume browser')
} finally {
  await browser.close()
  await server.close()
}
