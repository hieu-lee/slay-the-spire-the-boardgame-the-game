#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createServer } from 'vite'
import { chromium } from './lib/profile-browser.mjs'
import { createRoomServer } from './room-server.mjs'
import { assert, assertDeepEqual, assertEqual, check, report, suite } from './lib/harness.mjs'
// Real video encoding is an explicit delivery check, not a per-edit gate.
const verifyExports = process.argv.includes('--export')
if (verifyExports) process.env.VITE_HOSTED_SESSION = 'true'

function browserRss() {
  const rows = spawnSync('ps', ['-axo', 'pid=,ppid=,rss=,command='], { encoding: 'utf8' }).stdout.trim().split('\n').map(line => {
    const [pid, ppid, rss, ...command] = line.trim().split(/\s+/)
    return [Number(pid), Number(ppid), Number(rss), command.join(' ')]
  })
  const descendants = new Set([process.pid])
  for (let changed = true; changed;) {
    changed = false
    for (const [pid, ppid] of rows) if (descendants.has(ppid) && !descendants.has(pid)) { descendants.add(pid); changed = true }
  }
  return rows.filter(([pid, , , command]) => descendants.has(pid) && /chrome|chromium|headless_shell/i.test(command))
    .map(([pid, , rss]) => [pid, rss])
}

let roomOrigin = ''
const server = await createServer({ root: process.cwd(), logLevel: 'silent', server: { port: 0 }, plugins: verifyExports ? [{
  name: 'run-vod-reset-service',
  configureServer(vite) {
    vite.middlewares.use('/session.json', (_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ origin: roomOrigin, protocolVersion: 1 }))
    })
  },
}] : [] })
await server.listen()
const address = server.httpServer?.address()
if (!address || typeof address === 'string') throw new Error('Vite did not report a port')
const roomService = verifyExports ? createRoomServer({ allowedOrigin: `http://localhost:${address.port}` }) : null
if (roomService) {
  const roomAddress = await roomService.listen(0, '::')
  roomOrigin = `http://[::1]:${roomAddress.port}`
  const profile = await fetch(`${roomOrigin}/api/profile`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'TestPlayer', token: '00000000-0000-4000-8000-000000000001' }),
  })
  if (!profile.ok) throw new Error(`Could not seed the hosted VOD profile (${profile.status}).`)
}

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, hasTouch: true, acceptDownloads: true })
let memoryTimer
let frameWorkers = 0
const errors = []
let page
const attach = (next) => {
  page = next
  next.on('worker', worker => { if (worker.url().includes('run-vod-encode.worker')) frameWorkers++ })
  next.on('console', (message) => {
    if (message.type() === 'error' && message.text() !== 'Failed to load resource: net::ERR_FILE_NOT_FOUND') {
      errors.push(`${message.text()} (${message.location().url})`)
    }
  })
  next.on('pageerror', (error) => errors.push(String(error)))
  next.on('requestfailed', (request) => {
    if (request.failure()?.errorText !== 'net::ERR_ABORTED' &&
      !(request.url().startsWith('blob:') && request.failure()?.errorText === 'net::ERR_FILE_NOT_FOUND')) {
      errors.push(`${request.url()}: ${request.failure()?.errorText ?? 'request failed'}`)
    }
  })
}
attach(await context.newPage())
context.on('page', attach)
const waitForDownload = (timeout) => new Promise((resolve, reject) => {
  const receive = (download) => { cleanup(); resolve(download) }
  const added = (next) => next.on('download', receive)
  const timer = setTimeout(() => { cleanup(); reject(new Error(`Download timed out after ${timeout}ms`)) }, timeout)
  const cleanup = () => {
    clearTimeout(timer); context.off('page', added)
    for (const current of context.pages()) current.off('download', receive)
  }
  context.on('page', added)
  for (const current of context.pages()) current.on('download', receive)
})
const usePageWithButton = async (name) => {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    for (const current of [...context.pages()].reverse()) {
      try {
        if (await current.getByRole('button', { name, exact: true }).count()) { page = current; return }
      } catch {}
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`The VOD export did not return to the ${name} page.`)
}
const releaseJoinedCleanup = (target = page) => target.evaluate(async () => {
  const root = await navigator.storage.getDirectory()
  const entries = []
  for await (const entry of root.keys()) if (/-joined-/.test(entry)) entries.push(entry)
  const saved = JSON.parse(localStorage.getItem('sts-run-vod-cleanup') ?? '[]')
  const deferred = Array.isArray(saved) ? saved.filter(entry => entry && typeof entry === 'object') : []
  const delays = deferred.filter(entry => entries.includes(entry.name)).map(entry => entry.after - Date.now())
  for (const entry of entries) await root.removeEntry(entry, { recursive: true })
  const remaining = deferred.filter(entry => !entries.includes(entry.name))
  if (remaining.length) localStorage.setItem('sts-run-vod-cleanup', JSON.stringify(remaining))
  else localStorage.removeItem('sts-run-vod-cleanup')
  return { entries, delays }
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
const persistedVod = (runId) => page.evaluate(async (runId) => {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('sts-run-vod-v2')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const request = (value) => new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result)
    value.onerror = () => reject(value.error)
  })
  try {
    const transaction = db.transaction(['runs', 'events'], 'readonly')
    return {
      log: localStorage.getItem('sts-run-vod'),
      run: await request(transaction.objectStore('runs').get(runId)),
      events: await request(transaction.objectStore('events').getAll(IDBKeyRange.bound([runId, 0], [runId, Number.MAX_SAFE_INTEGER]))),
    }
  } finally { db.close() }
}, runId)

try {
  suite('run VOD browser')
  await page.addInitScript(() => {
    if (navigator.mediaDevices) navigator.mediaDevices.getDisplayMedia = () => { throw new Error('screen capture must not be used') }
    const delayedReads = new WeakSet()
    const pendingReads = []
    window.__releaseVodReads = () => {
      sessionStorage.removeItem('delay-run-vod-read')
      pendingReads.splice(0).forEach((complete) => complete())
    }
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
        const complete = () => {
          if (typeof listener === 'function') listener.call(this, event)
          else listener.handleEvent(event)
        }
        if (sessionStorage.getItem('delay-run-vod-read') === '1') pendingReads.push(complete)
        else complete()
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
  const checkpoints = await page.evaluate(async initial => {
    const { runVodLocations, applyRunVodEvent, stableRunJson } = await import('/src/ui/run-vod.ts')
    const phases = ['combat', 'combat', 'reward', 'map', 'room', 'map', 'room', 'victory']
    const events = phases.map(phase => ({ patch: [{ path: ['phase'], value: phase }] }))
    const log = { version: 2, runId: 'checkpoint-test', initial, events }
    const expected = events.reduce(applyRunVodEvent, initial)
    const locations = runVodLocations(log, expected)
    const statesMatch = locations.every((segment, index) =>
      stableRunJson(segment.log.events.reduce(applyRunVodEvent, segment.log.initial)) === stableRunJson(segment.expected) &&
      (index === 0 || stableRunJson(segment.log.initial) === stableRunJson(locations[index - 1].expected)))
    return { lengths: locations.map(segment => segment.log.events.length), statesMatch,
      eventsMatch: stableRunJson(locations.flatMap(segment => segment.log.events)) === stableRunJson(events),
      untouched: initial.phase === 'map' }
  }, canonicalMapRun)
  check('location checkpoints preserve all decisions and exact states without splitting combat and rewards', () => {
    assertDeepEqual(checkpoints.lengths, [4, 2, 2])
    assert(checkpoints.statesMatch && checkpoints.eventsMatch && checkpoints.untouched, JSON.stringify(checkpoints))
  })
  const motionBoundary = await page.evaluate(async () => {
    const { runVodAudioCueTime, runVodExportMotionFrames, runVodMotionSliceSkipped } = await import('/src/ui/run-vod.ts')
    const active = { skip: 0, remaining: 1, capped: false }
    const boundary = { skip: 0, remaining: 0, capped: false }
    const resuming = { skip: 1, remaining: 0, capped: false }
    const cue = (begin, at, until, loop = false) => {
      const value = runVodAudioCueTime(begin, { at, loop }, until)
      return value === undefined ? 'future' : value === null ? 'past' : Math.round(value * 1e6) / 1e6
    }
    return {
      active: runVodMotionSliceSkipped(active),
      sliceFrames: runVodExportMotionFrames({ patch: [] }),
      boundary: runVodMotionSliceSkipped(boundary), boundaryCapped: boundary.capped,
      resuming: runVodMotionSliceSkipped(resuming), resumingCapped: resuming.capped,
      firstSliceCue: cue(0, 5.5 / 60, 4 / 60), resumedCue: cue(-4 / 60, 5.5 / 60, 2 / 60),
      pastCue: cue(-4 / 60, 2 / 60, 2 / 60), continuingLoop: cue(-4 / 60, 2 / 60, 2 / 60, true),
      endBoundary: cue(0, 4 / 60, 4 / 60), nextBoundary: cue(-4 / 60, 4 / 60, 1 / 60),
    }
  })
  check('motion slices stop at exact frame boundaries and carry delayed audio into the resumed slice', () =>
    assertDeepEqual(motionBoundary, { active: false, sliceFrames: 12, boundary: true, boundaryCapped: true, resuming: true, resumingCapped: false,
      firstSliceCue: 'future', resumedCue: .025, pastCue: 'past', continuingLoop: 0,
      endBoundary: 'future', nextBoundary: 0 }))
  const renderTimeout = await page.evaluate(async () => {
    const { runVodRenderDeadline } = await import('/src/ui/run-vod.ts')
    try { await runVodRenderDeadline(new Promise(() => {}), 1) }
    catch (error) { return error instanceof Error ? error.message : String(error) }
  })
  check('a hung render slice fails fast so the checkpoint worker can resume it', () =>
    assertEqual(renderTimeout, 'VOD render slice timed out.'))
  const resolvedTurn = await page.evaluate(async initial => {
    const { runVodEventChoice } = await import('/src/ui/run-vod.ts')
    initial.combat = { combatId: 'turn-choice', presentationEvents: [] }
    const result = runVodEventChoice({ choice: {
      source: { selector: '.hand button', card: true, drag: true, name: 'FTL, cost 0, attack' },
      steps: [{ selector: '.start-turn', name: 'Resolve start of turn' }],
      target: { selector: '[data-enemy-id="boss-0"]', name: 'The Guardian, 16 of 40 hit points', target: true },
    }, patch: [{ path: ['combat', 'presentationEvents'], value: [{ seq: 1, kind: 'turn', sourceId: 'mercury_hourglass' }] }] }, initial)
    return { source: result.source.name, steps: result.steps, target: result.target ?? null }
  }, canonicalMapRun)
  check('turn resolution drops an abandoned card drag and its stale pre-damage target', () =>
    assertDeepEqual(resolvedTurn, { source: 'Resolve start of turn', steps: [], target: null }))
  const canonicalPage = await browser.newPage({ viewport: { width: 1920, height: 1080 }, hasTouch: true })
  await canonicalPage.goto(`http://localhost:${address.port}/?run-vod=1`, { waitUntil: 'networkidle' })
  await canonicalPage.waitForFunction(() => window.__STS_DEBUG__)
  await canonicalPage.evaluate((run) => window.__STS_DEBUG__.setRun(run), canonicalMapRun)
  const legacyPhoneRoom = await canonicalPage.evaluate(async () => {
    const room = document.querySelector('.room--reachable')
    const ref = { selector: `[data-room="${room.dataset.room}"]`, name: `${room.getAttribute('aria-label')}, Activate again to enter` }
    return (await import('/src/ui/run-vod.ts')).queryControl(document, ref) === room
  })
  await canonicalPage.locator('.room--reachable').first().click()
  await canonicalPage.locator('.combat').waitFor({ timeout: 5_000 })
  const canonicalReplay = await canonicalPage.evaluate(async () => {
    const enemy = document.querySelector('[data-enemy-id]')
    const queryControl = (await import('/src/ui/run-vod.ts')).queryControl
    const probe = document.createElement('div')
    probe.style.cssText = 'position:fixed;inset:0;z-index:100'
    probe.innerHTML = '<div data-player-id="vod-player"><button data-player-id="vod-player" aria-label="current player"></button></div><span role="button" data-orb-slot="99" aria-label="current orb" style="display:inline-block;width:10px;height:10px"></span>'
    document.body.append(probe)
    const player = probe.querySelector('button')
    return {
      viewport: [innerWidth, innerHeight],
      staleTarget: queryControl(document, {
        selector: `[data-enemy-id="${CSS.escape(enemy.dataset.enemyId)}"]`, name: 'stale combat label', target: true,
      }) === enemy,
      stalePlayer: queryControl(document, {
        selector: '[data-player-id="vod-player"]', name: 'stale player label', target: true,
      }) === player,
      staleOrbRejected: queryControl(document, {
        selector: '[data-orb-slot="99"]', name: 'stale orb label', target: true,
      }) === null,
    }
  })
  await canonicalPage.close()
  check('touch-capable replay uses one desktop map action and resolves old phone-only hint labels', () => {
    assertDeepEqual(canonicalReplay.viewport, [1920, 1080])
    assert(legacyPhoneRoom, 'the phone inspection hint prevented canonical desktop room lookup')
    assert(canonicalReplay.staleTarget, 'a stable enemy id was rejected because its combat label changed')
    assert(canonicalReplay.stalePlayer, 'a stable player id resolved to its non-clickable wrapper')
    assert(canonicalReplay.staleOrbRejected, 'a positional Orb slot ignored its semantic label')
  })
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
  await page.evaluate(() => window.__releaseVodReads())
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
  const roomRecovery = await page.evaluate(async () => {
    const { soleReachableRoom } = await import('/src/ui/run-vod.ts')
    const fixture = document.createElement('div')
    fixture.innerHTML = '<button class="room--reachable"></button>'
    const uniqueAccepted = Boolean(soleReachableRoom(fixture))
    fixture.innerHTML += '<button class="room--reachable"></button>'
    return {
      uniqueAccepted,
      ambiguousRejected: soleReachableRoom(fixture) === null,
    }
  })
  if (verifyExports) {
    const compatibilityDownload = waitForDownload(60_000)
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
    const [compatibility, compatibilityFile] = await Promise.all([compatibilityResult, compatibilityDownload]).catch(async (error) => {
      console.error(await page.evaluate(() => {
        const doc = document.querySelector('iframe')?.contentDocument
        return { status: document.querySelector('.run-vod-workbench__status')?.textContent,
          animations: doc?.getAnimations().map(a => [a.animationName, a.currentTime, a.effect.getComputedTiming().endTime]),
          pending: [...(doc?.querySelectorAll('[data-webmcp-pending="true"], .character-attack, .card-flight, .defect-evoke') ?? [])].map(e => e.className) }
      }))
      throw error
    })
    const compatibilityPath = await compatibilityFile.path()
    const compatibilityAudio = compatibilityPath && spawnSync('ffmpeg', [
      '-hide_banner', '-i', compatibilityPath, '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-',
    ], { encoding: 'utf8' })
    const compatibilityMaxVolume = Number(compatibilityAudio?.stderr.match(/max_volume:\s*(-?[\d.]+) dB/)?.[1])
    await compatibilityFile.delete()
    await page.getByRole('button', { name: 'Close video', exact: true }).click()
    await releaseJoinedCleanup()
    check('legacy merged room and card events synthesize the missing room entry before replaying the card', () => {
      assert(roomRecovery.uniqueAccepted, 'a unique legacy room could not be recovered')
      assert(roomRecovery.ambiguousRejected, 'an ambiguous room branch would be guessed')
      assert(/slay-the-spire-run-.+\.(webm|mp4)$/.test(compatibility.filename), compatibility.filename)
      assert(compatibility.size > 0, 'the compatibility replay produced an empty video')
      assert(compatibilityAudio?.status === 0 && Number.isFinite(compatibilityMaxVolume) && compatibilityMaxVolume > -60,
        `the recovered replay audio is silent (${compatibilityAudio?.stderr ?? 'ffmpeg failed'})`)
    })
  }
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
    assert(!cardChoice?.steps?.some((step) => step.card), 'the abandoned card selection leaked into the played card')
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

  await page.evaluate(async () => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.campaign.runId += '-start-target'
    const state = run.combat
    state.combatId += '-start-target'
    state.phase = 'start'
    state.startTurnProgress = undefined
    state.endTurnProgress = undefined
    state.pendingTriggers = []
    state.players[0].character = 'silent'
    state.players[0].orbs = []
    state.players[0].powers = [{ uid: 'vod-fumes', defId: 'noxious_fumes', upgraded: false }]
    await (await import('/src/ui/run-vod.ts')).startRunVod(run)
    debug.setRun(run)
  })
  await page.locator('.combat[data-phase="start"]').waitFor()
  await page.locator('[data-enemy-id="vod-lightning-b"] .enemy__hit-area').click({ force: true })
  await page.getByRole('button', { name: 'Resolve start of turn', exact: true }).click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getState().phase === 'player')
  const startChoice = await page.evaluate(async () => {
    const vod = await import('/src/ui/run-vod.ts')
    const log = await vod.readRunVod(window.__STS_DEBUG__.getRun().campaign.runId)
    const event = log.events.find(event => event.choice?.steps?.some(ref => ref.name === 'Resolve start of turn'))
    if (!event) return null
    const choice = vod.runVodEventChoice(event, log.initial)
    const abandoned = vod.runVodEventChoice({ ...event, choice: {
      source: { selector: '.hand button', card: true, name: 'FTL, cost 0' },
      steps: [choice.source, ...choice.steps],
    } }, log.initial)
    return { choice, abandoned, poison: window.__STS_DEBUG__.getState().enemies.map(enemy => enemy.poison) }
  })
  check('turn confirmation preserves an explicitly chosen start-turn target, including after an abandoned card', () => {
    assert(startChoice, 'Resolve discarded the preceding target selection')
    assert(startChoice.choice.source.selector.includes('vod-lightning-b'), JSON.stringify(startChoice))
    assertDeepEqual(startChoice.abandoned, startChoice.choice)
    assertDeepEqual(startChoice.poison, [0, 1])
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
    const terminal = structuredClone(window.__STS_DEBUG__.getRun())
    const reordered = structuredClone(terminal)
    reordered.players[0].deck.reverse()
    const terminalResidue = structuredClone(terminal)
    terminalResidue.players[0].draw = [structuredClone(terminal.players[0].deck[0])]
    terminalResidue.players[0].calipersArmed = false
    const active = structuredClone(terminal)
    active.phase = 'map'
    const activeReordered = structuredClone(active)
    activeReordered.players[0].deck.reverse()
    const activeResidue = structuredClone(active)
    activeResidue.players[0].draw = [structuredClone(active.players[0].deck[0])]
    activeResidue.players[0].calipersArmed = false
    const forcedProbe = document.createElement('div')
    Object.assign(forcedProbe.style, { position: 'fixed', inset: '0 auto auto 0' })
    forcedProbe.innerHTML = '<button>Resolve Defect — Lightning Orb 1</button>'
    document.body.append(forcedProbe)
    const soleForcedResolution = vod.soleForcedResolution(document)?.textContent
    forcedProbe.append(Object.assign(document.createElement('button'), { textContent: 'Resolve another choice' }))
    const ambiguousForcedResolution = vod.soleForcedResolution(document)
    forcedProbe.remove()
    const semanticRun = structuredClone(terminal)
    const bashIndex = semanticRun.players[0].deck.findIndex((card) => card.defId === 'bash')
    const wrongIndex = bashIndex === 0 ? 1 : 0
    const relocated = vod.applyRunVodEvent(semanticRun, {
      choice: { source: { selector: '#grow' }, steps: [{ selector: '#bash', name: 'Bash, cost 2' }] },
      patch: [{ path: ['players', 0, 'deck', wrongIndex, 'upgraded'], value: true }],
    })
    const legacyRun = structuredClone(terminal)
    legacyRun.players[0].deck = [
      { uid: 'a', defId: 'bash', upgraded: false },
      { uid: 'b', defId: 'strike_ironclad', upgraded: false },
      { uid: 'c', defId: 'strike_ironclad', upgraded: false },
      { uid: 'd', defId: 'defend_ironclad', upgraded: false },
    ]
    const multiple = vod.applyRunVodEvent(legacyRun, {
      choice: { source: { selector: '#simplicity' }, steps: [
        { selector: '#strike', name: 'Strike, cost 1' }, { selector: '#defend', name: 'Defend, cost 1' },
      ] },
      patch: [1, 3].map(index => ({ path: ['players', 0, 'deck', index, 'upgraded'], value: true })),
    })
    const removed = vod.applyRunVodEvent(legacyRun, {
      choice: { source: { selector: '#remove' }, steps: [{ selector: '#strike', name: 'Strike, cost 1' }] },
      patch: [
        { path: ['players', 0, 'deck', 1, 'uid'], value: 'c' },
        { path: ['players', 0, 'deck', 2], value: legacyRun.players[0].deck[3] },
        { path: ['players', 0, 'deck', 3], remove: true },
      ],
    })
    const duplicateUpgrade = vod.applyRunVodEvent(legacyRun, {
      choice: { source: { selector: '#upgrade' }, steps: [{ selector: '#strike', name: 'Strike, cost 1' }] },
      patch: [{ path: ['players', 0, 'deck', 2, 'upgraded'], value: true }],
    })
    const target = { selector: '[data-enemy-id="e0"]', name: 'Cultist, 5 HP', target: true }
    const orbChoice = vod.normalizeRunVodChoice({
      source: { selector: '#dual-cast', drag: true },
      steps: [{ selector: '#lightning' }, target],
      target: { ...target, name: 'Cultist, 6 HP' },
    })
    const hand = name => ({ selector: 'main > div > div > footer > div > div > button', name: `${name}, cost 1`, drag: true })
    const beforeChoice = { ...terminal, combat: { combatId: 'choice', presentationEvents: [{ seq: 24 }] } }
    const actualCard = { seq: 25, kind: 'card', sourceId: 'ftl', actorId: terminal.players[0].id, copied: false }
    const choiceEvent = {
      choice: { source: hand('Dual Cast+'), steps: [hand('FTL')], target },
      patch: [{ path: ['combat', 'presentationEvents'], value: [actualCard] }],
    }
    const recoveredChoice = vod.runVodEventChoice(choiceEvent, beforeChoice)
    const campfire = structuredClone(terminal)
    const campfireRoomId = campfire.map.position ?? Object.keys(campfire.map.rooms)[0]
    campfire.phase = 'room'
    campfire.roomState = null
    campfire.map.position = campfireRoomId
    campfire.map.rooms[campfireRoomId] = { ...campfire.map.rooms[campfireRoomId], kind: 'campfire' }
    const upgradeEvent = {
      choice: { source: { selector: '#recursion', name: 'Recursion, cost 1, skill' }, steps: [{ selector: '#confirm', name: 'Confirm' }] },
      patch: [{ path: ['players', 0, 'deck'], value: terminal.players[0].deck.map((card, index) =>
        index === 0 ? { ...card, upgraded: true } : card) }],
    }
    const recoveredSmith = vod.runVodEventChoice(upgradeEvent, campfire)
    const relicReward = structuredClone(terminal)
    relicReward.phase = 'reward'
    relicReward.players[0].relics.push({ defId: 'forbidden_fruit', spent: false, pending: true,
      pendingRewardIndices: { 0: 1 } })
    const recoveredRelicReward = vod.runVodEventChoice({ viewerId: relicReward.players[0].id,
      choice: { source: { selector: '#double-tap', name: 'Double Tap, cost 1, skill' } }, patch: [] }, relicReward)
    const retainedEnchiridion = ['enchiridion', 'downfall_enchiridion'].map(defId => {
      const state = structuredClone(terminal)
      state.phase = 'reward'
      state.players[0].relics.push({ defId, spent: false, pending: true })
      return vod.runVodEventChoice({ viewerId: state.players[0].id,
        choice: { source: { selector: '#double-tap', name: 'Double Tap, cost 1, skill' } }, patch: [] }, state)
    })
    const neowRelicReward = structuredClone(terminal)
    neowRelicReward.phase = 'neow'
    neowRelicReward.players[0].relics.push({ defId: 'tiny_house', spent: false, pending: true })
    const recoveredNeowRelicReward = vod.runVodEventChoice({ viewerId: neowRelicReward.players[0].id,
      choice: { source: { selector: '#double-tap', name: 'Double Tap, cost 1, skill' } }, patch: [] }, neowRelicReward)
    const outOfOrderRelicReward = structuredClone(terminal)
    outOfOrderRelicReward.phase = 'reward'
    const relicIndex = outOfOrderRelicReward.players[0].relics.length
    outOfOrderRelicReward.players[0].relics.push({ defId: 'orrery', spent: false, pending: true,
      pendingRewardIndices: { 1: 1 } })
    const recoveredOutOfOrderReward = vod.runVodEventChoice({ viewerId: outOfOrderRelicReward.players[0].id,
      choice: { source: { selector: '#double-tap', name: 'Double Tap, cost 1, skill' } },
      patch: [{ path: ['players', 0, 'relics', relicIndex, 'pendingRewardIndices', 3], value: 1 }] }, outOfOrderRelicReward)
    const retainedSetupUpgrade = vod.runVodEventChoice(upgradeEvent, { ...campfire, phase: 'setup' })
    const restChoice = { source: { selector: '#rest', name: 'Rest' },
      steps: [{ selector: '#card', name: 'Recursion, cost 1, skill' }, { selector: '#confirm', name: 'Confirm' }] }
    const retainedRemoval = vod.runVodEventChoice({ choice: restChoice,
      patch: [{ path: ['players', 0, 'deck'], value: terminal.players[0].deck.slice(1) }] }, campfire)
    const retainedTransform = vod.runVodEventChoice({ choice: restChoice,
      patch: [{ path: ['players', 0, 'deck'], value: terminal.players[0].deck.map((card, index) =>
        index === 0 ? { ...card, uid: 'transformed', defId: 'claw' } : card) }] }, campfire)
    const orbEvent = { ...choiceEvent, choice: { source: hand('FTL'), steps: [{ selector: '#orb' }], target } }
    const syntheticEvent = { ...choiceEvent, choice: { source: { selector: '#relic' }, steps: [hand('FTL')] } }
    return {
      width: vod.RUN_VOD_WIDTH, height: vod.RUN_VOD_HEIGHT, fps: vod.RUN_VOD_FPS,
      cursorMs: vod.RUN_VOD_CURSOR_MS, repeatClickMs: vod.RUN_VOD_REPEAT_CLICK_MS,
      actionHoldMs: vod.RUN_VOD_ACTION_HOLD_MS,
      actionWaits: [vod.runVodActionWait(0, false), vod.runVodActionWait(1_200, false), vod.runVodActionWait(0, true)],
      cursorAsset: vod.RUN_VOD_CURSOR_ASSET, cursorClickAsset: vod.RUN_VOD_CURSOR_CLICK_ASSET,
      terminalOrderIgnored: vod.replayRunJson(terminal) === vod.replayRunJson(reordered),
      activeOrderPreserved: vod.replayRunJson(active) !== vod.replayRunJson(activeReordered),
      terminalResidueIgnored: vod.replayRunJson(terminal) === vod.replayRunJson(terminalResidue),
      activeResiduePreserved: vod.replayRunJson(active) !== vod.replayRunJson(activeResidue),
      soleForcedResolution, ambiguousForcedResolution: ambiguousForcedResolution === null,
      semanticDeckChoice: bashIndex >= 0 && relocated.players[0].deck[bashIndex].upgraded &&
        (wrongIndex === bashIndex || !relocated.players[0].deck[wrongIndex].upgraded),
      legacyMultiple: multiple.players[0].deck.filter(card => card.upgraded).map(card => card.uid),
      legacyRemoved: removed.players[0].deck.map(card => card.uid),
      legacyDuplicate: duplicateUpgrade.players[0].deck.filter(card => card.upgraded).map(card => card.uid),
      orbTarget: orbChoice.target.name, orbSteps: orbChoice.steps.map(step => step.selector),
      recoveredCard: recoveredChoice.source.name, recoveredSteps: recoveredChoice.steps.length,
      recoveredSmith: [recoveredSmith.source.name, ...recoveredSmith.steps.map(step => step.name)],
      recoveredRelicReward: [recoveredRelicReward.source.selector, recoveredRelicReward.source.name,
        ...recoveredRelicReward.steps.map(step => step.name)],
      retainedEnchiridion: retainedEnchiridion.map(choice => choice.source.name),
      recoveredNeowRelicReward: recoveredNeowRelicReward.source.name,
      recoveredOutOfOrderReward: recoveredOutOfOrderReward.source.selector,
      retainedSetupUpgrade: retainedSetupUpgrade.source.name,
      retainedRest: [retainedRemoval.source.name, retainedTransform.source.name],
      retainedOrb: vod.runVodEventChoice(orbEvent, beforeChoice).steps[0].selector,
      retainedSynthetic: vod.runVodEventChoice(syntheticEvent, beforeChoice).source.selector,
    }
  })
  check('terminal choices stay horizontal and the canonical renderer is native 1080p/120 fps', () => {
    assert(rows.every((tops) => tops.length === 3 && new Set(tops).size === 1), `terminal actions wrapped: ${JSON.stringify(rows)}`)
    assertDeepEqual(timing, {
      width: 1920, height: 1080, fps: 120, cursorMs: 150, repeatClickMs: 250, actionHoldMs: 1000,
      actionWaits: [1000, 0, 250],
      cursorAsset: '/assets/ui/cursor.png', cursorClickAsset: '/assets/ui/cursor-click.png',
      terminalOrderIgnored: true, activeOrderPreserved: true,
      terminalResidueIgnored: true, activeResiduePreserved: true,
      soleForcedResolution: 'Resolve Defect — Lightning Orb 1', ambiguousForcedResolution: true,
      semanticDeckChoice: true,
      legacyMultiple: ['b', 'd'], legacyRemoved: ['a', 'c', 'd'], legacyDuplicate: ['c'],
      orbTarget: 'Cultist, 5 HP', orbSteps: ['#lightning'],
      recoveredCard: 'FTL, cost 1', recoveredSteps: 0,
      recoveredSmith: ['Smith upgrade', 'Recursion, cost 1, skill', 'Confirm'],
      recoveredRelicReward: ['.reward-screen__player > .loot-choice:nth-of-type(1)',
        'Add a card to your deck.', 'Double Tap, cost 1, skill'],
      retainedEnchiridion: ['Double Tap, cost 1, skill', 'Double Tap, cost 1, skill'],
      recoveredNeowRelicReward: 'Add a card to your deck.',
      recoveredOutOfOrderReward: '.reward-screen__player > .loot-choice:nth-of-type(3)',
      retainedSetupUpgrade: 'Recursion, cost 1, skill',
      retainedRest: ['Rest', 'Rest'],
      retainedOrb: '#orb', retainedSynthetic: '#relic',
    })
  })

  await page.waitForTimeout(150)
  await page.evaluate((run) => {
    const exportRun = structuredClone(run)
    exportRun.act = 4
    window.__STS_DEBUG__.setRun(exportRun)
  }, terminal)
  await page.waitForFunction(() => window.__STS_DEBUG__.getRun().act === 4)
  if (verifyExports) {
    const exportedEventCount = await eventCount()
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory()
      await root.getDirectoryHandle('run-vod-stale-1', { create: true })
      await root.getDirectoryHandle('sts-run-vod-export-abandoned', { create: true })
      await root.getDirectoryHandle('sts-run-vod-export-active', { create: true })
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('sts-run-vod-export-v1')
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
      })
      const transaction = db.transaction('exports', 'readwrite')
      transaction.objectStore('exports').put({ runId: 'abandoned' })
      transaction.objectStore('exports').put({ runId: 'active', updatedAt: Date.now() })
      await new Promise((resolve, reject) => {
        transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error)
      })
      db.close()
    })
    await page.getByRole('button', { name: 'Extract run VOD', exact: true }).waitFor()
    const cancelledRunId = await page.evaluate(() => window.__STS_DEBUG__.getRun().campaign.runId)
    await page.evaluate(() => {
      const native = Storage.prototype.setItem
      window.__restoreVodStorage = () => { Storage.prototype.setItem = native; delete window.__restoreVodStorage }
      Storage.prototype.setItem = function (key, value) {
        if (key === 'sts-solo-run') throw new DOMException('Full', 'QuotaExceededError')
        return native.call(this, key, value)
      }
    })
    await page.getByRole('button', { name: 'Extract run VOD', exact: true }).click()
    await page.waitForFunction(() => document.body.textContent.includes('could not preserve your run before VOD export'))
    const refusedUnsafeExport = await page.evaluate(runId => ({
      runId: window.__STS_DEBUG__.getRun().campaign.runId,
      exporting: new URL(location.href).searchParams.has('run-vod-export'),
      restore: (window.__restoreVodStorage(), true),
    }), cancelledRunId)
    check('export refuses to navigate when the resumable run checkpoint cannot be saved', () => {
      assertDeepEqual(refusedUnsafeExport, { runId: cancelledRunId, exporting: false, restore: true })
    })
    await page.getByRole('button', { name: 'Extract run VOD', exact: true }).click()
    await usePageWithButton('Cancel VOD export')
    await page.getByRole('button', { name: 'Cancel VOD export', exact: true }).click()
    await usePageWithButton('Extract run VOD')
    await page.waitForFunction(async () => {
      for await (const entry of (await navigator.storage.getDirectory()).keys()) {
        if (entry === 'sts-run-vod-export-abandoned') return false
      }
      return true
    })
    const cancelledStorage = await page.evaluate(async runId => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('sts-run-vod-export-v1')
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
      })
      const transaction = db.transaction('exports', 'readonly')
      const get = key => new Promise((resolve, reject) => {
        const request = transaction.objectStore('exports').get(key)
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
      })
      const [record, abandoned, active] = await Promise.all([get(runId), get('abandoned'), get('active')])
      db.close()
      const entries = []
      for await (const entry of (await navigator.storage.getDirectory()).keys()) entries.push(entry)
      return { record, directory: entries.includes(`sts-run-vod-export-${runId}`), abandoned,
        abandonedDirectory: entries.includes('sts-run-vod-export-abandoned'), active: active?.runId,
        activeDirectory: entries.includes('sts-run-vod-export-active') }
    }, cancelledRunId)
    check('cancelling export returns to the run and removes its checkpoint and clips', () =>
      assertDeepEqual(cancelledStorage, { record: undefined, directory: false, abandoned: undefined,
        abandonedDirectory: false, active: 'active', activeDirectory: true }))
    await page.evaluate(async () => {
      const request = indexedDB.open('sts-run-vod-export-v1')
      const db = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
      })
      const transaction = db.transaction('exports', 'readwrite')
      transaction.objectStore('exports').delete('active')
      await new Promise((resolve, reject) => {
        transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error)
      })
      db.close()
      await (await navigator.storage.getDirectory()).removeEntry('sts-run-vod-export-active', { recursive: true })
    })
    for (const stale of context.pages()) if (stale !== page) await stale.close()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.evaluate(() => {
      const workbench = document.createElement('div')
      workbench.id = 'run-vod-preview-fixture'
      workbench.className = 'run-vod-workbench'
      const status = document.createElement('div')
      status.className = 'run-vod-workbench__status'
      const label = document.createElement('span')
      label.textContent = 'Rendering events 4–4 of location 2 · 9 / 50'
      const progress = document.createElement('progress')
      progress.max = 1; progress.value = .18; progress.setAttribute('aria-label', 'Run VOD export progress')
      status.append(label, progress)
      const cancel = document.createElement('button')
      cancel.className = 'run-vod-workbench__cancel'; cancel.textContent = 'Cancel VOD export'
      const frame = document.createElement('iframe')
      frame.className = 'run-vod-workbench__frame'; frame.tabIndex = -1
      workbench.append(status, cancel, frame)
      document.body.append(workbench)
    })
    for (const viewport of [{ width: 1440, height: 900 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport)
      const preview = await page.locator('#run-vod-preview-fixture').evaluate(frame => ({
        box: document.querySelector('.run-vod-workbench__status')?.getBoundingClientRect().toJSON(),
        cancel: document.querySelector('.run-vod-workbench__cancel')?.getBoundingClientRect().toJSON(),
        pointer: getComputedStyle(frame.querySelector('.run-vod-workbench__frame')).pointerEvents,
        opacity: getComputedStyle(frame.querySelector('.run-vod-workbench__frame')).opacity,
      }))
      assert(Math.abs(preview.box.x + preview.box.width / 2 - viewport.width / 2) < 1, 'export status is not centered')
      assert(preview.cancel.top >= 0 && preview.cancel.top < 24 && viewport.width - preview.cancel.right < 24,
        'export cancel action is outside the viewport')
      assertDeepEqual({ pointer: preview.pointer, opacity: preview.opacity }, { pointer: 'none', opacity: '0' })
      const screenshot = await page.screenshot({ path: `artifacts/run-vod/export-preview-${viewport.width}.png` })
      assert(screenshot.length > viewport.width * viewport.height / 100, 'export preview screenshot is blank')
    }
    await page.locator('#run-vod-preview-fixture').evaluate(element => element.remove())
    await page.setViewportSize({ width: 1440, height: 900 })
    const baselineBrowserRss = new Map(browserRss())
    const sampleBrowserRss = () => browserRss().reduce((total, [pid, rss]) =>
      total + Math.max(0, rss - (baselineBrowserRss.get(pid) ?? 0)), 0)
    let peakBrowserRssKb = sampleBrowserRss()
    memoryTimer = setInterval(() => { peakBrowserRssKb = Math.max(peakBrowserRssKb, sampleBrowserRss()) }, 50)
    const exportStarted = Date.now()
    const downloadPromise = waitForDownload(180_000)
    await page.getByRole('button', { name: 'Extract run VOD', exact: true }).click()
    const replayFrame = page.locator('.run-vod-workbench__frame')
    await replayFrame.waitFor({ state: 'attached', timeout: 5_000 }).catch(() => {})
    await page.waitForFunction(() => document.querySelector('.run-vod-workbench__status progress')?.getAttribute('aria-label') === 'Run VOD export progress')
    const preview = await replayFrame.evaluate(frame => ({
      pointer: getComputedStyle(frame).pointerEvents, focus: frame.tabIndex, opacity: getComputedStyle(frame).opacity,
    }))
    assertDeepEqual(preview, { pointer: 'none', focus: -1, opacity: '0' })
    const cancelVisible = await page.getByRole('button', { name: 'Cancel VOD export', exact: true }).evaluate(button => {
      const bounds = button.getBoundingClientRect()
      return document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2) === button
    })
    assert(cancelVisible, 'the renderer host covered the export progress and cancel controls')
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
    const download = await downloadPromise.catch(async () => {
      throw new Error(`${await page.locator('body').innerText()}\n${errors.join('\n')}`)
    })
    clearInterval(memoryTimer); memoryTimer = undefined
    peakBrowserRssKb = Math.max(peakBrowserRssKb, sampleBrowserRss())
    console.log(`VOD export benchmark: ${exportedEventCount} events in ${((Date.now() - exportStarted) / 1000).toFixed(3)}s; peak growth ${Math.round(peakBrowserRssKb / 1024)} MB`)
    await page.getByRole('dialog', { name: 'Your completed Run VOD', exact: true }).waitFor()
    await page.waitForFunction(() => document.querySelector('.run-vod-player video')?.readyState >= 1)
    assertDeepEqual(await page.locator('.run-vod-player video').evaluate(video => [video.videoWidth, video.videoHeight]), [1920, 1080])
    await page.getByRole('button', { name: 'Close video', exact: true }).click()
    await usePageWithButton('Extract run VOD again')
    for (const stale of context.pages()) if (stale !== page) await stale.close()
    const downloadPath = await download.path()
    const afterExtract = await page.evaluate(async () => {
      const runId = window.__STS_DEBUG__.getRun().campaign.runId
      return {
        finalized: window.__STS_DEBUG__.getRun().campaign.finalized,
        buttons: [...document.querySelectorAll('.room-screen__actions button')].map((button) => button.textContent),
      }
    })
    const retainedVod = await persistedVod(await page.evaluate(() => window.__STS_DEBUG__.getRun().campaign.runId))
    afterExtract.log = retainedVod.log
    afterExtract.persisted = { version: retainedVod.run?.version, runId: retainedVod.run?.runId, events: retainedVod.events.length }
    const probe = downloadPath && spawnSync('ffprobe', [
      '-v', 'error', '-count_frames', '-show_entries',
      'stream=index,codec_type,width,height,avg_frame_rate,r_frame_rate,nb_read_frames,duration:packet=stream_index,pts_time:format=duration', '-of', 'json', downloadPath,
    ], { encoding: 'utf8' })
    const audioProbe = downloadPath && spawnSync('ffmpeg', [
      '-hide_banner', '-i', downloadPath, '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-',
    ], { encoding: 'utf8' })
    const tailAudioProbe = downloadPath && spawnSync('ffmpeg', [
      '-hide_banner', '-sseof', '-1', '-i', downloadPath, '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-',
    ], { encoding: 'utf8' })
    const maxVolume = Number(audioProbe?.stderr.match(/max_volume:\s*(-?[\d.]+) dB/)?.[1])
    const tailMaxVolume = Number(tailAudioProbe?.stderr.match(/max_volume:\s*(-?[\d.]+) dB/)?.[1])
    const joinedGrace = await releaseJoinedCleanup()
    const vodStorage = await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory()
      const entries = []
      let frameBytes = 0
      for await (const entry of root.keys()) if (entry.startsWith('run-vod-')) {
        entries.push(entry)
        const directory = await root.getDirectoryHandle(entry)
        try { frameBytes += (await (await directory.getFileHandle('frames.bin')).getFile()).size } catch {}
      }
      return { entries, frameBytes,
        joined: entries.filter(entry => /-joined-/.test(entry)) }
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
      assert(peakBrowserRssKb < 1.5 * 1024 * 1024, `VOD export browser growth exceeded 1.5 GB (${peakBrowserRssKb} KiB)`)
      assertDeepEqual(frameViewport, [1920, 1080])
      assert(replayControlsHidden, 'VOD-management controls are visible inside the replay')
      assertDeepEqual(replayDeviceMediaRules, [], 'host motion/hover CSS remained active in the canonical replay')
      assert(/\.(webm|mp4)$/.test(download.suggestedFilename()), 'the extraction did not download a video')
      assert(video?.width === 1920 && video.height === 1080, 'video is not native 1920x1080')
      assert(Math.abs(measuredRate - 120) < .1, `video frame rate metadata ${JSON.stringify(video)}; measured ${measuredRate}`)
      assert(measuredDuration >= 2, `the replay did not contain the recorded interactions (${measuredDuration}s)`)
      assert(streams.some((stream) => stream.codec_type === 'audio'), 'video has no max-volume audio mix')
      assert(audioProbe?.status === 0 && Number.isFinite(maxVolume) && maxVolume > -60,
        `the VOD audio track is silent (${audioProbe?.stderr ?? 'ffmpeg failed'})`)
      assert(tailAudioProbe?.status === 0 && Number.isFinite(tailMaxVolume) && tailMaxVolume > -60,
        `resumed clips lost their continuing audio (${tailAudioProbe?.stderr ?? 'ffmpeg failed'})`)
      assert(!vodStorage.entries.includes('run-vod-stale-1'), 'stale temporary VOD storage was not purged')
      assertDeepEqual(vodStorage.joined, [], 'joined VOD storage survived return navigation')
      assert(joinedGrace.entries.length === 1 && joinedGrace.delays.every(delay => delay > 45_000 && delay <= 60_000),
        `joined VOD download did not retain its 60-second cleanup grace (${JSON.stringify(joinedGrace)})`)
      assertEqual(vodStorage.frameBytes, 0, 'native export still wrote temporary frames to disk')
      assertEqual(frameWorkers, 0, 'native export still created temporary PNG workers')
      assertEqual(afterExtract.finalized, false, 'extracting implicitly recorded the campaign result')
      assert(afterExtract.buttons.includes('Stop and record result'), 'the independent result action disappeared')
      assert(afterExtract.buttons.includes('Prepare next run →'), 'extract-only did not expose the independent next-run action')
      assert(!afterExtract.buttons.some((label) => label?.startsWith('Climb to Act')), 'an extracted interim run could still climb without a VOD log')
      assert(afterExtract.buttons.includes('Extract run VOD again'), 'the retained log cannot be extracted again')
      assert(afterExtract.log, 'the completed run log was not retained')
      assertDeepEqual(afterExtract.persisted, { version: 2, runId: afterExtract.log, events: exportedEventCount },
        'the completed run log was not retained in IndexedDB')
    })
    const repeatDownload = waitForDownload(90_000)
    await page.getByRole('button', { name: 'Extract run VOD again', exact: true }).click()
    await repeatDownload
    await page.getByRole('dialog', { name: 'Your completed Run VOD', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Close video', exact: true }).click()
    await usePageWithButton('Extract run VOD again')
    await releaseJoinedCleanup()
    for (const stale of context.pages()) if (stale !== page) await stale.close()
  }

  const terminalRunId = await page.evaluate(() => window.__STS_DEBUG__.getRun().campaign.runId)
  await page.getByRole('button', { name: 'Stop and record result', exact: true }).click()
  await page.getByRole('button', { name: 'Prepare next run →', exact: true }).waitFor()
  const finalButtons = await page.locator('.campaign-end button').allTextContents()
  check('recording independently changes the result action to Prepare next run', () => {
    assert(!finalButtons.includes('Record campaign result'))
    assert(finalButtons.includes(verifyExports ? 'Extract run VOD again' : 'Extract run VOD'))
    assert(finalButtons.includes('Prepare next run →'))
  })
  await page.getByRole('button', { name: 'Prepare next run →', exact: true }).click()
  await page.waitForFunction(async (runId) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('sts-run-vod-v2')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const request = (value) => new Promise((resolve, reject) => {
      value.onsuccess = () => resolve(value.result)
      value.onerror = () => reject(value.error)
    })
    try {
      const transaction = db.transaction(['runs', 'events'], 'readonly')
      const run = await request(transaction.objectStore('runs').get(runId))
      const events = await request(transaction.objectStore('events').getAll(IDBKeyRange.bound([runId, 0], [runId, Number.MAX_SAFE_INTEGER])))
      return localStorage.getItem('sts-run-vod') === null && localStorage.getItem('sts-solo-run') === null && !run && events.length === 0
    } finally { db.close() }
  }, terminalRunId)
  const discardedVod = await persistedVod(terminalRunId)
  check('Prepare next run clears the retained terminal replay from localStorage and IndexedDB', () => {
    assertEqual(discardedVod.log, null)
    assertEqual(discardedVod.run, undefined)
    assertDeepEqual(discardedVod.events, [])
  })
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await page.getByRole('button', { name: 'Single Player', exact: true }).click()
  await page.getByRole('button', { name: 'Standard', exact: true }).click()
  await page.getByRole('button', { name: 'Embark', exact: true }).click()
  await page.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
  await page.waitForFunction(() => window.__STS_DEBUG__?.getRun()?.phase === 'neow')
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.evaluate(async initial => {
    const { createMerchant } = await import('/src/game/noncombat.ts')
    initial.campaign.runId += '-merchant-navigation'
    initial.phase = 'room'
    initial.players[0].gold = 99
    initial.roomState = createMerchant(initial.itemDecks, initial.players)
    await (await import('/src/ui/run-vod.ts')).startRunVod(initial)
    window.__STS_DEBUG__.setRun(initial)
  }, canonicalMapRun)
  const merchantEntryRecovery = await page.evaluate(async () => {
    const { runVodMerchantEntry } = await import('/src/ui/run-vod.ts')
    return {
      entry: runVodMerchantEntry(document, { selector: 'missing', name: 'War Paint' })?.getAttribute('aria-label'),
      alreadyEntry: runVodMerchantEntry(document, { selector: 'missing', name: 'Enter merchant shop' }) === null,
    }
  })
  await page.getByRole('button', { name: 'Enter merchant shop', exact: true }).click()
  await page.locator('.merchant-card button').first().click()
  await page.waitForFunction(async () => (await (await import('/src/ui/run-vod.ts')).readRunVod(window.__STS_DEBUG__.getRun().campaign.runId))?.events.length > 0)
  const merchantRecovery = await page.evaluate(async () => {
    const { runVodMerchantExit } = await import('/src/ui/run-vod.ts')
    return {
      exit: runVodMerchantExit(document, { name: 'Proceed · 0/1 ready', selector: 'main > section > button' })?.textContent.trim(),
      unrelated: runVodMerchantExit(document, { name: 'Buy card', selector: 'main > section > button' }) === null,
    }
  })
  await page.getByRole('button', { name: '← Leave shop', exact: true }).click()
  await page.getByRole('button', { name: 'Proceed · 0/1 ready', exact: true }).click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'map')
  const merchantLog = await readLog()
  const exitChoice = merchantLog.events.at(-1).choice
  check('same-selector merchant controls preserve Leave shop then Proceed; legacy logs recover only that prerequisite', () => {
    assertEqual(exitChoice.source.name, '← Leave shop')
    assertEqual(exitChoice.steps.at(-1).name, 'Proceed · 0/1 ready')
    assertEqual(exitChoice.source.selector, exitChoice.steps.at(-1).selector)
    assertDeepEqual(merchantEntryRecovery, { entry: 'Enter merchant shop', alreadyEntry: true })
    assertDeepEqual(merchantRecovery, { exit: '← Leave shop', unrelated: true })
  })
  if (verifyExports) {
    const legacy = structuredClone(merchantLog)
    legacy.events.at(-1).choice = { source: exitChoice.steps.at(-1) }
    const merchantDownload = waitForDownload(60_000)
    await page.evaluate(async log => (await import('/src/ui/run-vod.ts')).extractRunVod(log, window.__STS_DEBUG__.getRun()).then(() => true), legacy)
    await (await merchantDownload).delete()
    await page.getByRole('button', { name: 'Close video', exact: true }).click()
    await releaseJoinedCleanup()
    check('legacy merchant exports reconstruct the missing exit before proceeding', () => assert(true))
  }
  check('run VOD flow has no browser errors', () => assertDeepEqual(errors, []))
  report(verifyExports ? 'run VOD browser + video export' : 'run VOD browser (quick; add --export for video encoding)')
} finally {
  clearInterval(memoryTimer)
  await browser.close()
  await roomService?.close()
  await server.close()
}
