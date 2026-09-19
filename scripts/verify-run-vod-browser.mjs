#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createServer } from 'vite'
import { chromium } from './lib/profile-browser.mjs'
import { assert, assertDeepEqual, assertEqual, check, report, suite } from './lib/harness.mjs'

const server = await createServer({ root: process.cwd(), logLevel: 'silent', server: { port: 0 } })
await server.listen()
const address = server.httpServer?.address()
if (!address || typeof address === 'string') throw new Error('Vite did not report a port')

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, hasTouch: true, acceptDownloads: true })
const errors = []
page.on('console', (message) => {
  if (message.type() === 'error' && message.text() !== 'Failed to load resource: net::ERR_FILE_NOT_FOUND') errors.push(message.text())
})
page.on('pageerror', (error) => errors.push(String(error)))
page.on('requestfailed', (request) => {
  if (request.failure()?.errorText !== 'net::ERR_ABORTED' &&
    !(request.url().startsWith('blob:') && request.failure()?.errorText === 'net::ERR_FILE_NOT_FOUND')) {
    errors.push(`${request.url()}: ${request.failure()?.errorText ?? 'request failed'}`)
  }
})

const readLog = () => page.evaluate(async () =>
  (await import('/src/ui/run-vod.ts')).readRunVod(window.__STS_DEBUG__.getRun().campaign.runId))
const eventCount = async () => (await readLog())?.events.length ?? 0
const reconstructsCurrentRun = () => page.evaluate(async () => {
  const { applyRunVodEvent, readRunVod, stableRunJson } = await import('/src/ui/run-vod.ts')
  const log = await readRunVod(window.__STS_DEBUG__.getRun().campaign.runId)
  let run = structuredClone(log.initial)
  for (let index = 0; index < log.events.length; index += 1) {
    try { run = applyRunVodEvent(run, log.events[index]) }
    catch (error) { return { ok: false, index, patch: log.events[index].patch, error: String(error) } }
  }
  return { ok: stableRunJson(run) === stableRunJson(window.__STS_DEBUG__.getRun()) }
})

try {
  suite('run VOD browser')
  await page.addInitScript(() => {
    if (navigator.mediaDevices) navigator.mediaDevices.getDisplayMedia = () => { throw new Error('screen capture must not be used') }
    const delayedReads = new WeakSet()
    const getAll = IDBObjectStore.prototype.getAll
    IDBObjectStore.prototype.getAll = function (...args) {
      const request = getAll.apply(this, args)
      if (this.name === 'events' && sessionStorage.getItem('delay-run-vod-read') === '1') delayedReads.add(request)
      return request
    }
    const addEventListener = IDBRequest.prototype.addEventListener
    IDBRequest.prototype.addEventListener = function (type, listener, options) {
      if (type !== 'success' || !delayedReads.has(this) || !listener) {
        return addEventListener.call(this, type, listener, options)
      }
      return addEventListener.call(this, type, function (event) {
        window.setTimeout(() => {
          if (typeof listener === 'function') listener.call(this, event)
          else listener.handleEvent(event)
        }, 5_000)
      }, options)
    }
  })
  await page.goto(`http://localhost:${address.port}`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Single Player', exact: true }).click()
  await page.getByRole('button', { name: 'Standard', exact: true }).click()
  await page.getByRole('button', { name: 'Embark', exact: true }).click()
  await page.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
  await page.waitForFunction(() => window.__STS_DEBUG__?.getRun()?.phase === 'neow')
  await page.evaluate(() => window.__STS_DEBUG__.reset(1, 'run-vod-first-room'))
  await page.waitForFunction(async () => {
    const run = window.__STS_DEBUG__?.getRun()
    const log = run && await (await import('/src/ui/run-vod.ts')).readRunVod(run.campaign.runId)
    return log?.events.length === 0 && log.initial.phase === 'neow'
  })

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const controlledCheckbox = page.locator('.settings-dialog input[type="checkbox"]').first()
  const initialChecked = await controlledCheckbox.isChecked()
  await page.evaluate(async (checked) => {
    const checkbox = document.querySelector('.settings-dialog input[type="checkbox"]')
    if (!(checkbox instanceof HTMLElement)) throw new Error('controlled checkbox fixture is missing')
    await (await import('/src/ui/run-vod.ts')).activateControl(checkbox, { selector: '', checked })
  }, !initialChecked)
  const replayChecked = await controlledCheckbox.isChecked()
  await page.evaluate(async (checked) => {
    const checkbox = document.querySelector('.settings-dialog input[type="checkbox"]')
    if (!(checkbox instanceof HTMLElement)) throw new Error('controlled checkbox fixture is missing')
    await (await import('/src/ui/run-vod.ts')).activateControl(checkbox, { selector: '', checked })
  }, initialChecked)
  check('replay activates React-controlled checkboxes with native click semantics', () =>
    assertEqual(replayChecked, !initialChecked))
  await page.locator('.settings-dialog').getByRole('button', { name: 'Back', exact: true }).click()

  await page.getByRole('button', { name: 'Gain 3 Gold', exact: true }).click()
  await page.getByRole('button', { name: /Reveal Card Reward/ }).click()
  await page.waitForFunction(async () => ((await import('/src/ui/run-vod.ts')).readRunVod(
    window.__STS_DEBUG__.getRun().campaign.runId).then((log) => log?.events.length ?? 0)) >= 2)
  const recorded = await readLog()
  check('the persistent log contains semantic state transitions, not pointer telemetry', () => {
    assertEqual(recorded.version, 2)
    assertEqual(recorded.initial.phase, 'neow')
    assert(recorded.events.every((event) => Array.isArray(event.patch) && event.patch.length > 0), 'a VOD event has no state patch')
    assert(recorded.events.some((event) => event.choice?.source?.name?.includes('Gain 3 Gold')), 'the chosen Neow outcome is not named')
    assert(!JSON.stringify(recorded).includes('clientX'), 'pointer coordinates leaked into the persistent log')
    assert(!JSON.stringify(recorded).includes('pointerType'), 'pointer metadata leaked into the persistent log')
    assert(!recorded.events.some((event) => event.patch.some((change) =>
      change.path.at(-1) === 'log' && Array.isArray(change.value))), 'an append-only run log was copied wholesale')
  })
  const neowReconstructs = await reconstructsCurrentRun()
  check('semantic state patches perfectly recreate the current run', () => assert(neowReconstructs.ok, JSON.stringify(neowReconstructs)))

  const persistedRunId = await page.evaluate(() => window.__STS_DEBUG__.getRun().campaign.runId)
  await page.reload({ waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Resume', exact: true }).click()
  await page.waitForFunction((runId) => window.__STS_DEBUG__?.getRun().campaign.runId === runId, persistedRunId)
  await page.waitForFunction(async (runId) => (await (await import('/src/ui/run-vod.ts')).readRunVod(runId))?.events.length >= 2,
    persistedRunId)
  const persistedReconstruction = await reconstructsCurrentRun()
  check('append-only VOD events survive a reload without rewriting the full log', () =>
    assert(persistedReconstruction.ok, JSON.stringify(persistedReconstruction)))

  await page.getByRole('button', { name: 'Skip', exact: true }).click()
  await page.locator('.neow-options').waitFor()
  await page.getByRole('button', { name: /Gain 1 random Rare card/ }).click()
  await page.getByRole('button', { name: 'Gain reward', exact: true }).click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'map')
  const canonicalMapRun = await page.evaluate(() => structuredClone(window.__STS_DEBUG__.getRun()))
  const canonicalPage = await browser.newPage({ viewport: { width: 1920, height: 1080 }, hasTouch: true })
  await canonicalPage.goto(`http://localhost:${address.port}/?run-vod=1`, { waitUntil: 'networkidle' })
  await canonicalPage.waitForFunction(() => window.__STS_DEBUG__)
  await canonicalPage.evaluate((run) => window.__STS_DEBUG__.setRun(run), canonicalMapRun)
  await canonicalPage.locator('.room--reachable').first().click()
  await canonicalPage.locator('.combat').waitFor({ timeout: 5_000 })
  const canonicalViewport = await canonicalPage.evaluate(() => [innerWidth, innerHeight])
  await canonicalPage.close()
  check('touch-capable replay still uses the canonical desktop one-click map interaction', () =>
    assertDeepEqual(canonicalViewport, [1920, 1080]))
  await eventCount()
  await page.evaluate(() => sessionStorage.setItem('delay-run-vod-read', '1'))
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.reload({ waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Resume', exact: true }).click()
  await page.waitForFunction(() => window.__STS_DEBUG__?.getRun().phase === 'map')
  await page.setViewportSize({ width: 844, height: 390 })
  const reachableRoom = page.locator('.room--reachable').first()
  await reachableRoom.click()
  await reachableRoom.waitFor({ state: 'visible' })
  await page.waitForFunction(() => document.querySelector('.room--reachable.room--reading'))
  await reachableRoom.click()
  await page.locator('.combat').waitFor()
  await page.setViewportSize({ width: 1440, height: 900 })
  const startTurn = page.getByRole('button', { name: /Resolve start/ }).first()
  if (await startTurn.count()) await startTurn.click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getState()?.phase === 'player')
  const defend = await page.evaluate(() => window.__STS_DEBUG__.getState().players[0].hand
    .findIndex((card) => card.defId.startsWith('defend')))
  assert(defend >= 0, 'the first combat has no Defend for the hydration-race regression')
  const handBeforeDefend = await page.evaluate(() => window.__STS_DEBUG__.getState().players[0].hand.length)
  await page.locator('.hand .card').nth(defend).click()
  await page.waitForFunction((before) => window.__STS_DEBUG__.getState().players[0].hand.length < before, handBeforeDefend)
  const continuedRun = await page.evaluate(() => structuredClone(window.__STS_DEBUG__.getRun()))
  await page.keyboard.press('Escape')
  await page.getByRole('dialog', { name: 'Slay the Spire' })
    .getByRole('button', { name: 'Return to main menu', exact: true }).click()
  await page.getByRole('button', { name: 'Resume', exact: true }).click()
  await page.locator('.combat').waitFor()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Give up', exact: true }).click()
  await page.getByRole('button', { name: 'Yes, give up', exact: true }).click()
  await page.getByRole('heading', { name: 'The party has fallen', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Record campaign result', exact: true }).click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getRun().campaign.finalized)
  await page.waitForTimeout(5_500)
  await page.evaluate(() => sessionStorage.removeItem('delay-run-vod-read'))
  let resumedEvents = []
  for (let attempt = 0; attempt < 20; attempt += 1) {
    resumedEvents = (await readLog()).events
    if (resumedEvents.some((event) => event.choice?.source?.name?.includes('Defend'))) break
    await page.waitForTimeout(250)
  }
  const roomEvent = resumedEvents.findIndex((event) => event.choice?.source.selector.startsWith('[data-room='))
  const defendEvent = resumedEvents.findIndex((event) => event.choice?.source?.name?.includes('Defend'))
  const mapChoice = resumedEvents[roomEvent]?.choice
  const extractEnabledAfterRecord = await page.getByRole('button', { name: 'Extract run VOD', exact: true }).isEnabled()
  const recordedReconstruction = await page.evaluate(async () => {
    const { applyRunVodEvent, readRunVod, stableRunJson } = await import('/src/ui/run-vod.ts')
    const saved = JSON.parse(localStorage.getItem('sts-solo-run'))
    const log = await readRunVod(saved.run.campaign.runId)
    let restored = structuredClone(log.initial)
    for (const event of log.events) {
      restored = applyRunVodEvent(restored, event)
    }
    const difference = (left, right, path = 'run') => {
      if (Object.is(left, right)) return ''
      if (!left || !right || typeof left !== 'object' || typeof right !== 'object') {
        return `${path}: ${JSON.stringify(left)} != ${JSON.stringify(right)}`
      }
      for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
        const found = difference(left[key], right[key], `${path}.${key}`)
        if (found) return found
      }
      return ''
    }
    return {
      matches: stableRunJson(restored) === stableRunJson(saved.terminalRun),
      difference: difference(restored, saved.terminalRun),
    }
  })
  check('a fast resumed room entry survives main-menu resume and finalization without merging the first card play', () => {
    const selectors = [mapChoice?.source, ...(mapChoice?.steps ?? [])].map((ref) => ref?.selector)
    assertEqual(selectors.length, 1, JSON.stringify(mapChoice))
    assert(roomEvent >= 0 && defendEvent > roomEvent, JSON.stringify(resumedEvents))
    assert(recordedReconstruction.matches, recordedReconstruction.difference)
    assert(extractEnabledAfterRecord, `recording before hydration disabled VOD extraction: ${JSON.stringify(recordedReconstruction)}`)
  })
  const roomId = mapChoice?.source.selector.match(/\[data-room="([^"]+)"\]/)?.[1]
  assert(roomId && defendEvent >= 0, 'the compatibility replay fixture is incomplete')
  const visitedOnlyCompatibility = await page.evaluate(async ({ run, roomId }) => {
    const { replayableRunMatches, soleReachableRoom } = await import('/src/ui/run-vod.ts')
    const expected = structuredClone(run)
    expected.map.rooms[roomId].visited = true
    const extraVisit = structuredClone(expected)
    extraVisit.map.rooms[roomId].visited = false
    const fixture = document.createElement('div')
    fixture.innerHTML = '<button class="room--reachable"></button>'
    const uniqueAccepted = Boolean(soleReachableRoom(fixture))
    fixture.innerHTML += '<button class="room--reachable"></button>'
    return {
      missingAccepted: replayableRunMatches(run, expected),
      extraRejected: !replayableRunMatches(expected, extraVisit),
      uniqueAccepted,
      ambiguousRejected: soleReachableRoom(fixture) === null,
    }
  }, { run: canonicalMapRun, roomId })
  const compatibilityDownload = page.waitForEvent('download')
  const compatibilityResult = page.evaluate(async ({ initial, terminal, event }) => {
    const { extractRunVod } = await import('/src/ui/run-vod.ts')
    const result = await extractRunVod({
      version: 2,
      runId: `${initial.campaign.runId}-merged-room-card`,
      initial,
      events: [{
        ...event,
        patch: [{ path: [], value: terminal }],
      }],
    }, terminal)
    return { filename: result.filename, size: result.video.size }
  }, { initial: canonicalMapRun, terminal: continuedRun, event: resumedEvents[defendEvent] })
  const compatibility = await compatibilityResult
  const compatibilityFile = await compatibilityDownload
  await compatibilityFile.delete()
  check('legacy merged room and card events synthesize the missing room entry before replaying the card', () => {
    assert(visitedOnlyCompatibility.missingAccepted, 'a legacy missing visited flag disabled an otherwise exact VOD')
    assert(visitedOnlyCompatibility.extraRejected, 'an unexpected extra visited room was accepted')
    assert(visitedOnlyCompatibility.uniqueAccepted, 'a unique legacy room could not be recovered')
    assert(visitedOnlyCompatibility.ambiguousRejected, 'an ambiguous room branch would be guessed')
    assert(/slay-the-spire-run-.+\.(webm|mp4)$/.test(compatibility.filename), compatibility.filename)
    assert(compatibility.size > 0, 'the compatibility replay produced an empty video')
  })
  await page.evaluate(() => window.__STS_DEBUG__.reset(1, 'run-vod-continued'))
  await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'neow')
  await page.evaluate(async (run) => {
    run.campaign.runId += '-continued'
    await (await import('/src/ui/run-vod.ts')).startRunVod(run)
    window.__STS_DEBUG__.setRun(run)
  }, continuedRun)
  await page.waitForFunction(async () => {
    const run = window.__STS_DEBUG__.getRun()
    return run.campaign.runId.endsWith('-continued') &&
      (await (await import('/src/ui/run-vod.ts')).readRunVod(run.campaign.runId))?.events.length === 0
  })
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.waitForTimeout(300)
  const combatTemplate = await page.evaluate(() => structuredClone(window.__STS_DEBUG__.getRun().combat))

  const beforeInspections = await eventCount()
  await page.getByRole('button', { name: 'Map', exact: true }).click()
  await page.locator('.map-peek').waitFor()
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Compendium', exact: true }).click()
  await page.getByRole('button', { name: 'Back to run', exact: true }).click()
  await page.locator('[data-pile="draw"]').click()
  await page.getByRole('dialog').getByRole('button', { name: 'Back', exact: true }).click()
  const deck = page.locator('.deck-peek__open')
  if (await deck.count()) {
    await deck.click()
    await page.getByRole('dialog').getByRole('button', { name: 'Back', exact: true }).click()
  }
  await page.waitForTimeout(250)
  const afterInspections = await eventCount()
  const inspectionEvents = (await readLog()).events.slice(beforeInspections)
  check('map, deck, draw, discard, and exhaust inspection does not create a VOD event', () =>
    assertEqual(afterInspections, beforeInspections, JSON.stringify(inspectionEvents)))

  const inspectedCard = await page.evaluate(() => window.__STS_DEBUG__.getState().players[0].hand
    .findIndex((card) => card.defId.startsWith('strike')))
  assert(inspectedCard >= 0, 'inspection cancellation fixture has no targeted card')
  await page.locator('.hand .card').nth(inspectedCard).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.locator('.settings-dialog').getByRole('button', { name: 'Back', exact: true }).click()
  await page.getByRole('button', { name: 'Map', exact: true }).click()
  await page.locator('.map-peek').waitFor()
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  const beforeEndTurn = await eventCount()
  await page.getByRole('button', { name: 'End turn', exact: true }).click()
  await page.waitForFunction(async (before) => (await (await import('/src/ui/run-vod.ts')).readRunVod(
    window.__STS_DEBUG__.getRun().campaign.runId)).events.length > before, beforeEndTurn)
  const inspectedChoices = (await readLog()).events.slice(beforeEndTurn).flatMap((event) => event.choice ?? [])
  check('Settings and excluded inspections clear a staged choice before the next outcome', () => {
    assert(inspectedChoices.some((choice) => choice.source.name === 'End turn'), 'the outcome action was not recorded')
    assert(!inspectedChoices.some((choice) => choice.source.name?.includes('Strike')), 'the inspected card leaked into the next outcome')
    assert(!inspectedChoices.some((choice) => choice.source.name === 'Back to run'), 'Compendium leaked into the next outcome')
  })

  const cardCombat = await page.evaluate(async (combat) => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    const state = structuredClone(combat)
    state.players[0].hand = [{ uid: 'vod-targeted-strike', defId: 'strike_ironclad', upgraded: false }]
    state.players[0].energy = Math.max(1, state.players[0].energy)
    run.campaign.runId += '-card'
    run.combat = state
    await (await import('/src/ui/run-vod.ts')).startRunVod(run)
    debug.setRun(run)
    return state
  }, combatTemplate)
  await page.waitForFunction(() => window.__STS_DEBUG__.getRun().campaign.runId.endsWith('-card'))
  await page.waitForFunction(() => document.querySelectorAll('.hand .card').length > 0)
  const cardIndex = await page.evaluate(() => {
    const hand = window.__STS_DEBUG__.getState().players[0].hand
    return [...document.querySelectorAll('.hand .card')].findIndex((element, index) => {
      const box = element.getBoundingClientRect()
      return hand[index]?.defId.startsWith('strike') && box.left >= 0 && box.right <= innerWidth
    })
  })
  assert(cardIndex >= 0, 'card VOD fixture has no visible targetless card')
  const card = page.locator('.hand .card').nth(cardIndex)
  await page.waitForTimeout(150)
  const cardBox = await card.boundingBox()
  if (!cardBox) throw new Error('card VOD fixture is not visible')
  const beforeCancelled = await eventCount()
  await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(cardBox.x + cardBox.width / 2 + 20, cardBox.y + cardBox.height / 2)
  await page.mouse.up()
  await page.waitForTimeout(250)
  const afterCancelled = await eventCount()
  const cancelledEvents = (await readLog()).events
  check('a cancelled drag creates no outcome event', () => assertEqual(afterCancelled, beforeCancelled, JSON.stringify(cancelledEvents)))

  await page.evaluate(() => {
    const cancel = Object.assign(document.createElement('button'), { textContent: 'Cancel' })
    document.body.append(cancel)
    cancel.click()
    cancel.remove()
  })
  await card.click()
  await page.locator('[data-enemy-id] .enemy__hit-area').first().click({ force: true })
  await page.waitForFunction((before) => window.__STS_DEBUG__.getState().players[0].hand.length < before,
    cardCombat.players[0].hand.length)
  await page.waitForFunction(async (before) => (await (await import('/src/ui/run-vod.ts')).readRunVod(
    window.__STS_DEBUG__.getRun().campaign.runId)).events.length > before, beforeCancelled)
  const cardChoice = (await readLog()).events.at(-1).choice
  const cardReconstructs = await reconstructsCurrentRun()
  check('a played card records its semantic choice and resulting state only', () => {
    assert(cardChoice?.source?.name, 'the played card has no semantic source')
    assert(cardChoice?.target?.target, 'the clicked card target was not canonicalized for synthetic dragging')
    assert(!cardChoice?.steps?.some((step) => step.target), 'the target still depends on the player input gesture')
    assert(!JSON.stringify(cardChoice).toLowerCase().includes('cancel'), 'a cancelled interaction leaked into the played card')
    assert(cardReconstructs.ok, JSON.stringify(cardReconstructs))
  })

  const orbFixture = await page.evaluate(async (combat) => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    const state = structuredClone(combat)
    Object.assign(state.players[0], {
      character: 'defect', hand: [], draw: [], discard: [], exhaust: [], powers: [], relics: [], potions: [],
      orbs: ['lightning', null, null], energy: 0, block: 0, strength: 0, weak: 0, vulnerable: 0,
      orbEndTurnBonus: 0, lightningEndTurnBonus: 0, orbEvokeBonus: 0, darkOrbEvokeBonus: 0,
    })
    const base = state.enemies[0]
    state.combatId = 'run-vod-lightning-target'
    state.phase = 'player'
    state.pendingTriggers = []
    state.startTurnProgress = undefined
    state.endTurnProgress = undefined
    state.presentationEvents = []
    state.enemies = ['vod-lightning-a', 'vod-lightning-b'].map((uid, row) => ({
      ...base, uid, row, hp: 20, maxHp: 20, block: 0, poison: 0, dead: false, abilityUsed: true, isBoss: false,
    }))
    debug.setRun({ ...run, phase: 'combat', combat: state })
    return state.combatId
  }, combatTemplate)
  await page.waitForFunction((combatId) => window.__STS_DEBUG__.getState()?.combatId === combatId, orbFixture)
  await page.getByRole('button', { name: 'End turn', exact: true }).click()
  const lightningSource = page.locator('button.end-turn-effect--orb')
  const lightningTarget = page.locator('[data-enemy-id="vod-lightning-a"] .enemy__hit-area')
  await lightningSource.waitFor()
  const sourceBox = await lightningSource.boundingBox()
  const targetBox = await lightningTarget.boundingBox()
  if (!sourceBox || !targetBox) throw new Error('Lightning source or target is not visible')
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 4 })
  await page.mouse.up()
  await page.waitForFunction(() => window.__STS_DEBUG__.getState().enemies[0].hp === 19)
  await page.waitForFunction(async () => (await (await import('/src/ui/run-vod.ts')).readRunVod(
    window.__STS_DEBUG__.getRun().campaign.runId)).events.some((event) =>
      event.choice?.source?.name?.toLowerCase().includes('lightning') && event.choice.target))
  const lightningLog = await readLog()
  const lightning = await page.evaluate((events) => ({
    choice: events.findLast((event) => event.choice?.source?.name?.toLowerCase().includes('lightning')).choice,
    targetUid: document.querySelector(events.findLast((event) =>
      event.choice?.source?.name?.toLowerCase().includes('lightning')).choice?.target?.selector)
      ?.closest('[data-enemy-id]')?.getAttribute('data-enemy-id'),
    hp: window.__STS_DEBUG__.getState().enemies.map((enemy) => [enemy.uid, enemy.hp]),
  }), lightningLog.events)
  const lightningReconstructs = await reconstructsCurrentRun()
  check('Lightning records the chosen Orb and exact enemy for synthetic dragging', () => {
    assert(lightning.choice?.source?.name?.toLowerCase().includes('lightning'), 'the Lightning Orb source is missing')
    assertEqual(lightning.targetUid, 'vod-lightning-a', `the chosen enemy target is missing (${JSON.stringify(lightning.choice)})`)
    assertDeepEqual(lightning.hp, [['vod-lightning-a', 19], ['vod-lightning-b', 20]])
    assert(lightningReconstructs.ok, JSON.stringify(lightningReconstructs))
  })

  await page.keyboard.press('Escape')
  await page.waitForTimeout(100)
  if (!await page.getByRole('button', { name: 'Give up', exact: true }).count()) await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Give up', exact: true }).click()
  await page.getByRole('button', { name: 'Yes, give up', exact: true }).click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'defeat')

  const terminal = await page.evaluate(() => {
    const run = structuredClone(window.__STS_DEBUG__.getRun())
    Object.assign(run, { phase: 'victory', neow: null, combat: null, roomState: null, eventCombat: null, rewards: [], rewardDestination: null })
    run.campaign = { ...run.campaign, finalized: false }
    run.campaignProgress = { ...run.campaignProgress, unspentMarks: 0 }
    return run
  })
  await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), terminal)
  await page.getByRole('heading', { name: 'Act 1 complete', exact: true }).waitFor()
  const rows = []
  for (const viewport of [{ width: 1440, height: 900 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport)
    rows.push(await page.locator('.room-screen__actions button').evaluateAll((buttons) =>
      buttons.map((button) => Math.round(button.getBoundingClientRect().top))))
  }
  const timing = await page.evaluate(async () => {
    const vod = await import('/src/ui/run-vod.ts')
    return {
      width: vod.RUN_VOD_WIDTH, height: vod.RUN_VOD_HEIGHT, fps: vod.RUN_VOD_FPS,
      cursorMs: vod.RUN_VOD_CURSOR_MS, repeatClickMs: vod.RUN_VOD_REPEAT_CLICK_MS,
    }
  })
  check('terminal choices stay horizontal and the canonical renderer is native 1080p/120 fps', () => {
    assert(rows.every((tops) => tops.length === 3 && new Set(tops).size === 1), `terminal actions wrapped: ${JSON.stringify(rows)}`)
    assertDeepEqual(timing, { width: 1920, height: 1080, fps: 120, cursorMs: 150, repeatClickMs: 250 })
  })

  await page.waitForTimeout(150)
  await page.evaluate((run) => {
    const exportRun = structuredClone(run)
    exportRun.act = 4
    window.__STS_DEBUG__.setRun(exportRun)
  }, terminal)
  await page.waitForFunction(() => window.__STS_DEBUG__.getRun().act === 4)
  const exportedEventCount = await eventCount()
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory()
    await root.getDirectoryHandle('run-vod-stale-1', { create: true })
  })
  await page.getByRole('button', { name: 'Extract run VOD', exact: true }).waitFor()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.waitForTimeout(500)
  let download = null
  page.once('download', (value) => { download = value })
  await page.getByRole('button', { name: 'Extract run VOD', exact: true }).click()
  const replayFrame = page.locator('.run-vod-workbench__frame')
  await replayFrame.waitFor({ state: 'attached', timeout: 5_000 }).catch(() => {})
  const extractDisabled = await page.getByRole('button', { name: 'Extract run VOD', exact: true }).isDisabled()
  const frame = page.frames().find((candidate) => new URL(candidate.url()).searchParams.get('run-vod') === '1')
  const frameViewport = frame ? await frame.evaluate(() => [innerWidth, innerHeight]) : null
  const replayControlsHidden = frame ? await frame.evaluate(() => [...document.querySelectorAll('[data-run-vod-control]')]
    .every((control) => getComputedStyle(control).display === 'none')) : false
  const replayDeviceMediaRules = frame ? await frame.evaluate(() => {
    const media = []
    const visit = (rules) => {
      for (const rule of rules) {
        if (rule instanceof CSSMediaRule) media.push(rule.media.mediaText)
        if ('cssRules' in rule) visit(rule.cssRules)
      }
    }
    for (const sheet of document.styleSheets) {
      try { visit(sheet.cssRules) } catch { /* Same-origin bundle; ignore injected sheets. */ }
    }
    return media.filter((query) => query.includes('prefers-reduced-motion') || query.includes('(hover:'))
  }) : null
  await replayFrame.waitFor({ state: 'detached', timeout: 30_000 })
  await page.waitForTimeout(500)
  if (!download) throw new Error(`${await page.locator('body').innerText()}\n${errors.join('\n')}`)
  const downloadPath = await download.path()
  const afterExtract = await page.evaluate(async () => ({
    finalized: window.__STS_DEBUG__.getRun().campaign.finalized,
    buttons: [...document.querySelectorAll('.room-screen__actions button')].map((button) => button.textContent),
    log: localStorage.getItem('sts-run-vod'),
    persisted: await (await import('/src/ui/run-vod.ts')).readRunVod(window.__STS_DEBUG__.getRun().campaign.runId),
  }))
  const probe = downloadPath && spawnSync('ffprobe', [
    '-v', 'error', '-count_frames', '-show_entries',
    'stream=index,codec_type,width,height,avg_frame_rate,r_frame_rate,nb_read_frames,duration:packet=stream_index,pts_time:format=duration', '-of', 'json', downloadPath,
  ], { encoding: 'utf8' })
  const audioProbe = downloadPath && spawnSync('ffmpeg', [
    '-hide_banner', '-i', downloadPath, '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-',
  ], { encoding: 'utf8' })
  const maxVolume = Number(audioProbe?.stderr.match(/max_volume:\s*(-?[\d.]+) dB/)?.[1])
  const vodStorage = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory()
    const entries = []
    for await (const entry of root.keys()) if (entry.startsWith('run-vod-')) entries.push(entry)
    return entries
  })
  const metadata = probe?.status === 0 ? JSON.parse(probe.stdout) : { streams: [], format: {} }
  const streams = metadata.streams ?? []
  check('extraction renders device-independent video with audio and does not record the result', () => {
    const video = streams.find((stream) => stream.codec_type === 'video')
    const timestamps = (metadata.packets ?? []).filter((packet) => packet.stream_index === video?.index)
      .map((packet) => Number(packet.pts_time)).filter(Number.isFinite)
    const measuredDuration = timestamps.length > 1 ? timestamps.at(-1) - timestamps[0] : Number(metadata.format?.duration)
    const measuredRate = timestamps.length > 1 ? (timestamps.length - 1) / measuredDuration
      : Number(video?.nb_read_frames ?? 0) / Number(video?.duration ?? metadata.format?.duration)
    assert(exportedEventCount >= 3, `the extraction fixture had only ${exportedEventCount} semantic events`)
    assertDeepEqual(frameViewport, [1920, 1080])
    assert(replayControlsHidden, 'VOD-management controls are visible inside the replay')
    assertDeepEqual(replayDeviceMediaRules, [], 'host motion/hover CSS remained active in the canonical replay')
    assert(/\.(webm|mp4)$/.test(download.suggestedFilename()), 'the extraction did not download a video')
    assert(video?.width === 1920 && video.height === 1080, 'video is not native 1920x1080')
    assert(measuredRate >= 59.9, `video frame rate metadata ${JSON.stringify(video)}; measured ${measuredRate}`)
    assert(measuredDuration >= 2, `the replay did not contain the recorded interactions (${measuredDuration}s)`)
    assert(streams.some((stream) => stream.codec_type === 'audio'), 'video has no max-volume audio mix')
    assert(audioProbe?.status === 0 && Number.isFinite(maxVolume) && maxVolume > -60,
      `the VOD audio track is silent (${audioProbe?.stderr ?? 'ffmpeg failed'})`)
    assert(extractDisabled, 'the Extract action remained enabled during export')
    assert(!vodStorage.includes('run-vod-stale-1'), 'stale temporary VOD storage was not purged')
    assertEqual(afterExtract.finalized, false, 'extracting implicitly recorded the campaign result')
    assert(afterExtract.buttons.includes('Stop and record result'), 'the independent result action disappeared')
    assert(afterExtract.buttons.includes('Prepare next run →'), 'extract-only did not expose the independent next-run action')
    assert(!afterExtract.buttons.some((label) => label?.startsWith('Climb to Act')), 'an extracted interim run could still climb without a VOD log')
    assert(!afterExtract.buttons.includes('Extract run VOD'), 'the completed extraction action remained')
    assertEqual(afterExtract.log, null, 'the consumed event log was not discarded')
    assertEqual(afterExtract.persisted, null, 'the consumed IndexedDB event log was not committed as discarded')
  })

  await page.getByRole('button', { name: 'Stop and record result', exact: true }).click()
  await page.getByRole('button', { name: 'Prepare next run →', exact: true }).waitFor()
  const finalButtons = await page.locator('.campaign-end button').allTextContents()
  check('recording independently changes the result action to Prepare next run', () => {
    assert(!finalButtons.includes('Record campaign result'))
    assert(!finalButtons.includes('Extract run VOD'))
    assert(finalButtons.includes('Prepare next run →'))
  })
  check('run VOD flow has no browser errors', () => assertDeepEqual(errors, []))
  report('run VOD browser')
} finally {
  await browser.close()
  await server.close()
}
