import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createServer as createViteServer } from 'vite'
import { createRoomServer } from './room-server.mjs'
import { suite, check, assert, assertEqual, assertDeepEqual, report } from './lib/harness.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(repoRoot, 'artifacts/online-browser')
mkdirSync(outDir, { recursive: true })

const rooms = createRoomServer()
const roomAddress = await rooms.listen(0)
const roomOrigin = `http://127.0.0.1:${roomAddress.port}`
const vite = await createViteServer({
  root: repoRoot,
  logLevel: 'silent',
  server: {
    port: 0,
    proxy: {
      '/api': { target: roomOrigin },
      '/ws': { target: roomOrigin, ws: true },
    },
  },
})
await vite.listen()
const viteAddress = vite.httpServer?.address()
if (!viteAddress || typeof viteAddress === 'string') throw new Error('vite did not report a port')
const origin = `http://127.0.0.1:${viteAddress.port}`

const browser = await chromium.launch({
  headless: true,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
})
const aContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['microphone'] })
const bContext = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['microphone'] })
const cContext = await browser.newContext({ viewport: { width: 1024, height: 768 }, permissions: ['microphone'] })
for (const context of [aContext, bContext]) {
  await context.addInitScript(() => {
    const sockets = []
    window.__ROOM_SOCKETS__ = sockets
    window.WebSocket = new Proxy(window.WebSocket, {
      construct(Target, args) {
        const socket = new Target(...args)
        sockets.push(socket)
        return socket
      },
    })
  })
}
const a = await aContext.newPage()
let b = await bContext.newPage()
const failures = []
for (const page of [a, b]) {
  page.on('pageerror', (error) => failures.push(String(error)))
  page.on('console', (message) => { if (message.type() === 'error') failures.push(message.text()) })
}

async function enterOnline(page, name, character, code, localSeed, doubleSubmit = false) {
  await page.goto(origin, { waitUntil: 'networkidle' })
  if (localSeed) {
    await page.getByLabel('Seed').fill(localSeed)
    await page.getByLabel('Seed').blur()
  }
  await page.getByRole('button', { name: 'Play online' }).click()
  await page.getByLabel('Your name').fill(name)
  await page.getByLabel('Character').selectOption(character)
  if (code) {
    await page.getByLabel('Room code').fill(code)
    await page.getByRole('button', { name: 'Join', exact: true }).click()
  } else if (doubleSubmit) {
    await page.getByRole('button', { name: 'Create room' }).evaluate((button) => {
      button.click()
      button.click()
    })
  } else await page.getByRole('button', { name: 'Create room' }).click()
  await page.locator('.online-lobby').waitFor()
}

async function credentials(page) {
  return page.evaluate(() => JSON.parse(sessionStorage.getItem('sts-room-session')))
}

async function snapshot(page) {
  const saved = await credentials(page)
  const response = await fetch(`${roomOrigin}/api/rooms/${saved.code}`, {
    headers: { 'x-room-token': saved.token },
  })
  const body = await response.json()
  assert(response.ok, `snapshot failed ${response.status}: ${body.error}`)
  return body
}

try {
  suite('online browser')
  const guardedEntry = await cContext.newPage()
  await guardedEntry.goto(origin, { waitUntil: 'networkidle' })
  await guardedEntry.getByRole('button', { name: 'Play online' }).click()
  await guardedEntry.getByLabel('Your name').fill('Guard')
  await guardedEntry.route('**/api/rooms', async (route) => {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
    await route.continue()
  }, { times: 1 })
  await guardedEntry.getByRole('button', { name: 'Create room' }).click()
  const backDisabledDuringEntry = await guardedEntry.getByRole('button', { name: '← Solo table' }).isDisabled()
  await guardedEntry.locator('.online-lobby').waitFor()
  const guardedCredentials = await credentials(guardedEntry)
  const spare = await fetch(`${roomOrigin}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Spare', character: 'defect' }),
  }).then((response) => response.json())
  await guardedEntry.evaluate((saved) => {
    const recoveries = JSON.parse(localStorage.getItem('sts-room-recoveries') ?? '[]')
    localStorage.setItem('sts-room-recoveries', JSON.stringify([...recoveries, saved]))
  }, { code: spare.snapshot.code, token: spare.token })
  let leaveReached
  const leaveStarted = new Promise((resolveStarted) => { leaveReached = resolveStarted })
  let releaseLeave
  const leaveReleased = new Promise((resolveReleased) => { releaseLeave = resolveReleased })
  await guardedEntry.route(`**/api/rooms/${guardedCredentials.code}/leave`, async (route) => {
    const response = await route.fetch()
    leaveReached()
    await leaveReleased
    await route.fulfill({ response })
  }, { times: 1 })
  await guardedEntry.getByRole('button', { name: '← Leave room' }).click()
  await leaveStarted
  await guardedEntry.getByRole('button', { name: `Resume ${spare.snapshot.code}` }).click()
  await guardedEntry.locator('.online-lobby').waitFor()
  releaseLeave()
  await guardedEntry.waitForTimeout(300)
  const activeAfterOldLeave = await credentials(guardedEntry)
  const lobbyAfterOldLeave = await guardedEntry.locator('.online-lobby').count()
  const recoveriesAfterOldLeave = await guardedEntry.evaluate(() => JSON.parse(localStorage.getItem('sts-room-recoveries') ?? '[]'))
  check('a delayed leave cannot clear a newly resumed room', () => {
    assertEqual(activeAfterOldLeave.code, spare.snapshot.code)
    assertEqual(lobbyAfterOldLeave, 1)
    assert(!recoveriesAfterOldLeave.some((saved) => saved.code === guardedCredentials.code), 'the departed room stayed recoverable')
  })
  await guardedEntry.evaluate(() => {
    window.__VOICE_MEDIA_CALLS__ = 0
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    navigator.mediaDevices.getUserMedia = (...args) => {
      window.__VOICE_MEDIA_CALLS__ += 1
      return getUserMedia(...args)
    }
  })
  let iceReached
  const iceStarted = new Promise((resolveStarted) => { iceReached = resolveStarted })
  let releaseIce
  const iceReleased = new Promise((resolveReleased) => { releaseIce = resolveReleased })
  await guardedEntry.route(`**/api/rooms/${spare.snapshot.code}/voice-ice`, async (route) => {
    const response = await route.fetch()
    iceReached()
    await iceReleased
    await route.fulfill({ response })
  }, { times: 1 })
  await guardedEntry.getByRole('button', { name: 'Join voice' }).click()
  await iceStarted
  await guardedEntry.getByRole('button', { name: '← Leave room' }).click()
  await guardedEntry.getByLabel('Seed').waitFor()
  releaseIce()
  await guardedEntry.waitForTimeout(200)
  const mediaCallsAfterLeaving = await guardedEntry.evaluate(() => window.__VOICE_MEDIA_CALLS__)
  check('leaving during ICE setup never opens the microphone', () => {
    assertEqual(mediaCallsAfterLeaving, 0)
  })
  await guardedEntry.close()
  check('a pending room entry cannot be abandoned behind the UI', () => {
    assert(backDisabledDuringEntry, 'solo mode stayed active while the room request was pending')
  })

  await enterOnline(a, 'Ann', 'ironclad', undefined, 'kept-local-run', true)
  const code = await a.locator('.online-lobby h1').textContent()
  assert(code, 'creator did not receive a room code')
  const healthAfterDoubleCreate = await fetch(`${roomOrigin}/api/health`).then((response) => response.json())
  await enterOnline(b, 'Bo', 'silent', code)
  await a.locator('.online-seat', { hasText: 'Bo' }).waitFor()
  const c = await cContext.newPage()
  await c.addInitScript(() => {
    const streams = []
    window.__LOCAL_VOICE_STREAMS__ = streams
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    navigator.mediaDevices.getUserMedia = async (...args) => {
      const stream = await getUserMedia(...args)
      streams.push(stream)
      return stream
    }
  })
  c.on('pageerror', (error) => failures.push(String(error)))
  c.on('console', (message) => { if (message.type() === 'error') failures.push(message.text()) })
  await enterOnline(c, 'Cy', 'defect', code)
  await a.locator('.online-seat', { hasText: 'Cy' }).waitFor()
  await a.getByRole('button', { name: 'Join voice' }).click()
  await b.getByRole('button', { name: 'Join voice' }).click()
  await c.getByRole('button', { name: 'Join voice' }).click()
  await Promise.all([a, b, c].map((page) => page.locator('.voice__status', { hasText: 'Voice 2/2' }).waitFor()))
  await Promise.all([a, b, c].map((page) => page.waitForFunction(() => [...document.querySelectorAll('audio')]
    .filter((audio) => audio.srcObject?.getAudioTracks().length).length === 2)))
  const remoteAudioCounts = await Promise.all([a, b, c].map((page) => page.evaluate(() => [...document.querySelectorAll('audio')]
    .filter((audio) => audio.srcObject?.getAudioTracks().length).length)))
  await a.getByRole('button', { name: 'Mute' }).click()
  const muted = await a.getByRole('button', { name: 'Unmute' }).getAttribute('aria-pressed')
  await a.screenshot({ path: join(outDir, '01a-live-party-voice.png'), fullPage: true })
  await c.getByRole('button', { name: 'Leave voice' }).click()
  await Promise.all([a, b].map((page) => page.locator('.voice__status', { hasText: 'Voice 1/2' }).waitFor()))
  await c.getByRole('button', { name: 'Join voice' }).click()
  await Promise.all([a, b, c].map((page) => page.locator('.voice__status', { hasText: 'Voice 2/2' }).waitFor()))
  let voiceLeaveReached
  const voiceLeaveStarted = new Promise((resolve) => { voiceLeaveReached = resolve })
  let releaseVoiceLeave
  const voiceLeaveReleased = new Promise((resolve) => { releaseVoiceLeave = resolve })
  await c.route(`**/api/rooms/${code}/leave`, async (route) => {
    voiceLeaveReached()
    await voiceLeaveReleased
    await route.continue()
  }, { times: 1 })
  await c.getByRole('button', { name: '← Leave room' }).click()
  await voiceLeaveStarted
  const stoppedBeforeLeave = await c.evaluate(() => window.__LOCAL_VOICE_STREAMS__.at(-1)
    ?.getAudioTracks().every((track) => track.readyState === 'ended'))
  await Promise.all([a, b].map((page) => page.locator('.voice__status', { hasText: 'Voice 1/2' }).waitFor()))
  check('three browsers establish, mute, and leave native voice', () => {
    assert(remoteAudioCounts.every((count) => count === 2), `remote audio counts: ${remoteAudioCounts.join(', ')}`)
    assertEqual(muted, 'true')
    assertEqual(stoppedBeforeLeave, true, 'Leave room waited for HTTP before stopping the microphone')
  })
  releaseVoiceLeave()
  await a.locator('.online-seat', { hasText: 'Cy' }).waitFor({ state: 'detached' })
  await c.close()
  await Promise.all([a, b].map((page) => page.locator('.voice__status', { hasText: 'Voice 1/1' }).waitFor()))
  for (const [dropped, observer, seatName] of [[b, a, 'Bo'], [a, b, 'Ann']]) {
    await dropped.evaluate(() => window.__ROOM_SOCKETS__.at(-1)?.close(4000, 'test reconnect'))
    await observer.locator('.online-seat', { hasText: seatName }).locator('small', { hasText: 'away' }).waitFor()
    await observer.locator('.voice__status', { hasText: 'Voice 0/1' }).waitFor()
    await Promise.all([a, b].map((page) => page.locator('.voice__status', { hasText: 'Voice 1/1' }).waitFor()))
    await Promise.all([a, b].map((page) => page.waitForFunction(() => [...document.querySelectorAll('audio')]
      .filter((audio) => audio.srcObject?.getAudioTracks().length).length === 1)))
  }
  check('active voice recovers after either signaling socket reconnects', () => {})
  await b.getByRole('button', { name: 'Leave voice' }).click()
  await a.locator('.voice__status', { hasText: 'Voice 0/1' }).waitFor()
  await a.getByRole('button', { name: 'Leave voice' }).click()
  await a.screenshot({ path: join(outDir, '01-two-player-lobby.png'), fullPage: true })

  const [aOnline, bOnline] = await Promise.all([
    a.locator('.online-seat', { hasText: 'online' }).count(),
    b.locator('.online-seat', { hasText: 'online' }).count(),
  ])
  check('two browsers converge in one lobby', () => {
    assertEqual(healthAfterDoubleCreate.rooms, 1, 'double create orphaned a room')
    assertEqual(aOnline, 2)
    assertEqual(bOnline, 2)
  })
  await a.locator('.online-lobby').getByLabel('Ascension').fill('3')
  await b.waitForFunction(() => document.querySelector('input[type="number"]')?.value === '3')
  const sharedLobby = await snapshot(a)
  check('lobby leave and ascension are authoritative for the party', () => {
    assertEqual(sharedLobby.ascension, 3)
    assertEqual(sharedLobby.seats.length, 2)
  })
  await a.setViewportSize({ width: 390, height: 844 })
  await a.screenshot({ path: join(outDir, '01b-mobile-lobby.png'), fullPage: true })
  const mobileWidth = await a.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }))
  check('the online lobby fits a phone without horizontal overflow', () => {
    assert(mobileWidth.document <= mobileWidth.viewport, `${mobileWidth.document}px document in ${mobileWidth.viewport}px viewport`)
  })
  await a.setViewportSize({ width: 1440, height: 900 })

  let mutationReached
  const mutationStarted = new Promise((resolveStarted) => { mutationReached = resolveStarted })
  let releaseMutation
  const mutationReleased = new Promise((resolveReleased) => { releaseMutation = resolveReleased })
  await b.route(`**/api/rooms/${code}/ascension`, async (route) => {
    const response = await route.fetch()
    mutationReached()
    await mutationReleased
    await route.fulfill({ response })
  }, { times: 1 })
  await b.locator('.online-lobby').getByLabel('Ascension').fill('4')
  await mutationStarted
  await b.locator('.online-lobby').getByLabel('Ascension').fill('5')
  const replacementTabPromise = bContext.waitForEvent('page')
  await b.evaluate(() => window.open(location.href, '_blank'))
  const replacementTab = await replacementTabPromise
  replacementTab.on('pageerror', (error) => failures.push(String(error)))
  replacementTab.on('console', (message) => { if (message.type() === 'error') failures.push(message.text()) })
  await replacementTab.goto(origin, { waitUntil: 'networkidle' })
  await replacementTab.locator('.online-lobby').waitFor()
  await b.locator('.online-entry').waitFor()
  await b.getByRole('button', { name: `Resume ${code}` }).click()
  await b.locator('.online-lobby').waitFor()
  await b.locator('.online-lobby').getByLabel('Ascension').fill('6')
  await a.waitForFunction(() => document.querySelector('input[type="number"]')?.value === '6')
  releaseMutation()
  await b.waitForTimeout(300)
  const resumedCredentials = await credentials(b)
  const resumedAscension = (await snapshot(b)).ascension
  const replacementStayedOut = await replacementTab.locator('.online-entry').count()
  check('a resumed generation bypasses old writes and rejects their late work', () => {
    assertEqual(resumedCredentials.code, code)
    assertEqual(resumedAscension, 6, 'old queued work changed the recovered room')
    assertEqual(replacementStayedOut, 1)
  })
  await replacementTab.close()

  let queuedAscensionRequests = 0
  let queuedAscensionStarted
  const queuedAscensionStart = new Promise((resolve) => { queuedAscensionStarted = resolve })
  let releaseQueuedAscension
  const queuedAscensionGate = new Promise((resolve) => { releaseQueuedAscension = resolve })
  await a.route(`**/api/rooms/${code}/ascension`, async (route) => {
    queuedAscensionRequests += 1
    const response = await route.fetch()
    queuedAscensionStarted()
    await queuedAscensionGate
    await route.fulfill({ response })
  })
  await a.locator('.online-lobby').getByLabel('Ascension').fill('5')
  await queuedAscensionStart
  await a.locator('.online-lobby').getByLabel('Ascension').fill('4')
  await a.evaluate(() => window.__ROOM_SOCKETS__.at(-1)?.close())
  await a.locator('.connection--reconnecting').waitFor()
  await a.locator('.connection--connected').waitFor()
  releaseQueuedAscension()
  await a.waitForTimeout(50)
  await a.unroute(`**/api/rooms/${code}/ascension`)
  const afterQueuedReconnect = await snapshot(a)
  check('a queued write cannot start after its connection drops', () => {
    assertEqual(queuedAscensionRequests, 1)
    assertEqual(afterQueuedReconnect.ascension, 5)
  })
  await a.locator('.online-lobby').getByLabel('Ascension').fill('6')
  await b.waitForFunction(() => document.querySelector('input[type="number"]')?.value === '6')

  await a.getByRole('button', { name: 'Enter the Spire' }).click()
  await Promise.all([
    a.locator('.app-shell--online .map').waitFor(),
    b.locator('.app-shell--online .map').waitFor(),
  ])
  await a.evaluate(() => window.__ROOM_SOCKETS__.at(-1)?.close())
  await a.locator('.connection--reconnecting').waitFor()
  const inertWhileReconnecting = await a.locator('.online-mutations').evaluate((table) => table.inert)
  const positionBeforeReconnectClick = (await snapshot(a)).run.map.position
  await a.locator('.app-shell--online .room--reachable').first().evaluate((room) => room.click())
  await a.waitForTimeout(50)
  const positionAfterReconnectClick = (await snapshot(a)).run.map.position
  await a.locator('.connection--connected').waitFor()
  const interactiveAfterReconnect = await a.locator('.online-mutations').evaluate((table) => !table.inert)
  check('all room writes are disabled until a reconnect refresh succeeds', () => {
    assert(inertWhileReconnecting)
    assert(interactiveAfterReconnect)
    assertEqual(positionAfterReconnectClick, positionBeforeReconnectClick)
  })
  const liveRoom = rooms.store.rooms.get(code)
  liveRoom.run.players.find((player) => player.name === 'Ann').potions = ['energy_potion', 'energy_potion', 'energy_potion']
  liveRoom.run.players.find((player) => player.name === 'Bo').potions = ['block_potion']
  await a.locator('.app-shell--online .room--reachable').click()
  await Promise.all([
    a.locator('.app-shell--online .combat').waitFor(),
    b.locator('.app-shell--online .combat').waitFor(),
  ])
  const onlineRunStatus = await a.locator('.app-shell--online .run-status').textContent()
  check('the online table keeps the chosen Ascension visible during the run', () => {
    assert(onlineRunStatus.includes('Ascension 6'), `missing Ascension status: ${onlineRunStatus}`)
  })

  const [aView, bView] = await Promise.all([snapshot(a), snapshot(b)])
  const annPotions = await a.locator('.seat', { hasText: 'Ann' }).locator('.seat__potions').textContent()
  const boPotions = await a.locator('.seat', { hasText: 'Bo' }).locator('.seat__potions').textContent()
  const foreignPotionControls = await a.locator('.combat__actions').getByRole('button', { name: /Block Potion/ }).count()
  check('each browser receives only its own hidden cards', () => {
    const aId = aView.you.playerId
    const bId = bView.you.playerId
    assert(Array.isArray(aView.run.combat.players.find((player) => player.id === aId).hand))
    assertEqual(aView.run.combat.players.find((player) => player.id === bId).hand, null)
    assert(Array.isArray(bView.run.combat.players.find((player) => player.id === bId).hand))
    assertEqual(bView.run.combat.players.find((player) => player.id === aId).hand, null)
    assertEqual(aView.run.players.find((player) => player.id === bId).deck, null)
  })
  check('every online seat shows every face-up potion without granting its controls', () => {
    assert(annPotions.includes('Energy Potion ×3'))
    assert(boPotions.includes('Block Potion'))
    assertEqual(foreignPotionControls, 0)
  })
  const annLive = liveRoom.run.combat.players.find((player) => player.name === 'Ann')
  const boLive = liveRoom.run.combat.players.find((player) => player.name === 'Bo')
  annLive.hand = [
    { uid: 'online-acrobatics', defId: 'acrobatics', upgraded: false },
    { uid: 'online-existing-defend', defId: 'defend_ironclad', upgraded: false },
  ]
  annLive.draw = [
    { uid: 'online-private-neutralize', defId: 'neutralize', upgraded: false },
    { uid: 'online-private-defend', defId: 'defend_silent', upgraded: false },
    { uid: 'online-private-strike', defId: 'strike_silent', upgraded: false },
  ]
  annLive.discard = []
  annLive.energy = 6
  annLive.miracles = 1
  boLive.miracles = 1
  boLive.energy = 2
  const previewCredentials = await credentials(b)
  const publishPreviewFixture = await fetch(`${roomOrigin}/api/rooms/${code}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-room-token': previewCredentials.token },
    body: JSON.stringify({ action: { kind: 'spendMiracle' } }),
  })
  assert(publishPreviewFixture.ok, 'could not publish the online preview fixture')
  await a.getByRole('button', { name: 'Use Miracle on next card' }).click()
  await a.getByRole('button', { name: /^Acrobatics,/ }).click()
  const onlineAcrobatics = a.getByRole('dialog', { name: 'Choose 1 to discard' })
  await onlineAcrobatics.waitFor()
  const [privatePreview, teammatePreview] = await Promise.all([snapshot(a), snapshot(b)])
  await b.getByRole('status').filter({ hasText: 'Ann is resolving a revealed card' }).waitFor()
  const teammatePaused = await b.locator('.online-mutations').evaluate((table) => table.inert)
  const ownerPaused = await a.locator('.online-mutations').evaluate((table) => table.inert)
  const lockedEndTurn = await a.getByRole('button', { name: 'End turn' }).isDisabled()
  await a.evaluate(() => window.__ROOM_SOCKETS__.at(-1)?.close(4000, 'preview reconnect'))
  await a.locator('.connection--reconnecting').waitFor()
  await a.locator('.connection--connected').waitFor()
  await a.getByRole('dialog', { name: 'Choose 1 to discard' }).waitFor()
  await a.getByRole('dialog', { name: 'Choose 1 to discard' })
    .getByRole('button', { name: /^Neutralize,/ }).click()
  let stagedRefreshAttempts = 0
  let exhaustStagedRefreshes
  const stagedRefreshesExhausted = new Promise((resolve) => { exhaustStagedRefreshes = resolve })
  const stagedFailureStart = failures.length
  await a.route(`**/api/rooms/${code}`, async (route) => {
    stagedRefreshAttempts += 1
    if (stagedRefreshAttempts === 3) exhaustStagedRefreshes()
    await route.abort('connectionreset')
  }, { times: 3 })
  await a.route(`**/api/rooms/${code}/action`, (route) => route.abort('connectionreset'), { times: 1 })
  await a.getByRole('dialog', { name: 'Choose 1 to discard' })
    .getByRole('button', { name: 'Discard selected card' }).click()
  await stagedRefreshesExhausted
  await onlineAcrobatics.waitFor()
  await onlineAcrobatics.getByRole('button', { name: /^Neutralize,/ }).click()
  for (let index = failures.length - 1; index >= stagedFailureStart; index -= 1) {
    if (failures[index].includes('ERR_CONNECTION_RESET')) failures.splice(index, 1)
  }
  await a.screenshot({ path: join(outDir, '02a-private-post-draw-choice.png'), fullPage: true })
  await a.getByRole('dialog', { name: 'Choose 1 to discard' })
    .getByRole('button', { name: 'Discard selected card' }).click()
  await a.waitForFunction(() => document.querySelector('[role="dialog"]') === null)
  const completedPreview = await snapshot(a)
  check('online post-draw choices stay private, committed, and reconnectable', () => {
    assertEqual(privatePreview.cardPreview?.kind, 'discard')
    assert(privatePreview.cardPreview?.spendMiracle, 'the private reveal lost its committed Miracle')
    assertEqual(teammatePreview.cardPreview, undefined)
    assertEqual(teammatePreview.cardChoicePlayerId, privatePreview.you.playerId)
    assert(!JSON.stringify(teammatePreview).includes('online-private-neutralize'), 'a private draw leaked')
    assert(teammatePaused, 'teammate controls stayed enabled during the revealed choice')
    assert(!ownerPaused, 'the revealing player could not resolve their own choice')
    assert(lockedEndTurn, 'the revealing seat could abandon its committed card')
    assertEqual(stagedRefreshAttempts, 3, 'the unknown staged play did not exhaust immediate reconciliation')
    assertEqual(completedPreview.cardPreview, undefined)
    const ann = completedPreview.run.combat.players.find((player) => player.id === completedPreview.you.playerId)
    assertEqual(ann.energy, 6)
    assertEqual(ann.miracles, 0)
    assertDeepEqual(ann.hand.map((card) => card.uid),
      ['online-existing-defend', 'online-private-defend', 'online-private-strike'])
  })

  const annBeforeScry = liveRoom.run.combat.players.find((player) => player.name === 'Ann')
  const boBeforeScry = liveRoom.run.combat.players.find((player) => player.name === 'Bo')
  annBeforeScry.hand = [
    { uid: 'online-third-eye', defId: 'third_eye', upgraded: true },
    ...annBeforeScry.hand,
  ]
  annBeforeScry.draw = [
    { uid: 'online-scry-defend', defId: 'defend_watcher', upgraded: false },
    { uid: 'online-scry-strike', defId: 'strike_watcher', upgraded: false },
    { uid: 'online-scry-vigilance', defId: 'vigilance', upgraded: false },
    { uid: 'online-scry-eruption', defId: 'eruption', upgraded: false },
    { uid: 'online-scry-protect', defId: 'protect', upgraded: false },
    { uid: 'online-scry-spare', defId: 'tranquility', upgraded: false },
  ]
  annBeforeScry.discard = []
  annBeforeScry.energy = 3
  annBeforeScry.block = 0
  boBeforeScry.miracles = 1
  const publishScryFixture = await fetch(`${roomOrigin}/api/rooms/${code}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-room-token': previewCredentials.token },
    body: JSON.stringify({ action: { kind: 'spendMiracle' } }),
  })
  assert(publishScryFixture.ok, 'could not publish the online Scry fixture')
  await a.getByRole('button', { name: /^Third Eye\+,/ }).click()
  const onlineScry = a.getByRole('dialog', { name: 'Scry 5' })
  await onlineScry.waitFor()
  const [privateScry, teammateScry] = await Promise.all([snapshot(a), snapshot(b)])
  const remotelyResolvedFrame = structuredClone(privateScry)
  delete remotelyResolvedFrame.cardPreview
  delete remotelyResolvedFrame.cardChoicePlayerId
  const remotelyResolvedPlayer = remotelyResolvedFrame.run.combat.players
    .find((player) => player.id === remotelyResolvedFrame.you.playerId)
  remotelyResolvedPlayer.hand = remotelyResolvedPlayer.hand.filter((card) => card.uid !== 'online-third-eye')
  await a.evaluate((frame) => {
    window.__ROOM_SOCKETS__.at(-1)?.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ type: 'snapshot', snapshot: frame }),
    }))
  }, remotelyResolvedFrame)
  await onlineScry.waitFor({ state: 'hidden' })
  await a.evaluate((frame) => {
    window.__ROOM_SOCKETS__.at(-1)?.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ type: 'snapshot', snapshot: frame }),
    }))
  }, privateScry)
  await onlineScry.waitFor()
  await onlineScry.getByRole('button', { name: /^Strike,/ }).click()
  const changedScry = liveRoom.run.combat.players.find((player) => player.name === 'Ann')
  changedScry.draw = [changedScry.draw[1], changedScry.draw[0], ...changedScry.draw.slice(2)]
  const scryOwnerCredentials = await credentials(a)
  const refreshScry = await fetch(`${roomOrigin}/api/rooms/${code}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-room-token': scryOwnerCredentials.token },
    body: JSON.stringify({ action: { kind: 'previewCard', cardUid: 'online-third-eye' } }),
  })
  assert(refreshScry.ok, 'could not refresh the changed online Scry window')
  await onlineScry.getByRole('button', { name: 'Keep all' }).waitFor()
  await onlineScry.getByRole('button', { name: /^Strike,/ }).click()
  await a.screenshot({ path: join(outDir, '02b-private-scry-choice.png'), fullPage: true })
  await onlineScry.getByRole('button', { name: 'Discard 1 and continue' }).click()
  await onlineScry.waitFor({ state: 'hidden' })
  const completedScry = await snapshot(a)
  const authoritativeScry = liveRoom.run.combat.players.find((player) => player.name === 'Ann')
  check('online Scry is private and resolves against the authoritative draw pile', () => {
    assertEqual(privateScry.cardPreview?.kind, 'scry')
    assertEqual(teammateScry.cardPreview, undefined)
    assertEqual(completedScry.cardPreview, undefined)
    assert(!JSON.stringify(teammateScry).includes('online-scry-strike'), 'a private Scry leaked')
    assertEqual(authoritativeScry.block, 3)
    assertDeepEqual(authoritativeScry.draw.map((card) => card.uid),
      ['online-scry-defend', 'online-scry-vigilance', 'online-scry-eruption', 'online-scry-protect', 'online-scry-spare'])
    assertDeepEqual(authoritativeScry.discard.map((card) => card.uid), ['online-scry-strike', 'online-third-eye'])
  })

  const annAfterPreview = liveRoom.run.combat.players.find((player) => player.name === 'Ann')
  const boAfterPreview = liveRoom.run.combat.players.find((player) => player.name === 'Bo')
  annAfterPreview.hand.push({ uid: 'online-overflow-dance', defId: 'blade_dance', upgraded: false })
  annAfterPreview.energy = 1
  annAfterPreview.shivs = 4
  boAfterPreview.shivs = 1
  boAfterPreview.miracles = 1
  Object.assign(liveRoom.run.combat.enemies[0], { hp: 1, maxHp: 1, block: 0, dead: false })
  Object.assign(liveRoom.run.combat.enemies[1], { hp: 5, maxHp: 5, block: 0, dead: false })
  const bCredentials = await credentials(b)
  const publishedFixture = await fetch(`${roomOrigin}/api/rooms/${code}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-room-token': bCredentials.token },
    body: JSON.stringify({ action: { kind: 'spendMiracle' } }),
  })
  assert(publishedFixture.ok, 'could not publish the online overflow fixture')
  await a.getByRole('button', { name: /^Blade Dance,/ }).waitFor()
  await a.getByRole('button', { name: /^Blade Dance,/ }).click()
  await a.getByRole('button', { name: /5 of 5 hit points/ }).click()
  await a.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('2/2'))
  let overflowRequests = 0
  await a.route(`**/api/rooms/${code}/action`, async (route) => {
    overflowRequests += 1
    liveRoom.run.combat.players.find((player) => player.name === 'Bo').shivs = 0
    await route.continue()
  }, { times: 1 })
  await a.getByRole('button', { name: /5 of 5 hit points/ }).evaluate((button) => {
    button.click()
    button.click()
  })
  await a.getByRole('alert').filter({ hasText: 'shared Shiv supply changed' }).waitFor()
  const expectedConflict = failures.findIndex((failure) => failure.includes('409 (Conflict)'))
  assert(expectedConflict >= 0, 'the refused card action did not surface as an HTTP conflict')
  failures.splice(expectedConflict, 1)
  await a.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('1/1'))
  const refusedOnlineOverflow = await snapshot(a)
  check('an authoritative card overflow race restores targeting with an actionable error', () => {
    const ann = refusedOnlineOverflow.run.combat.players.find((player) => player.id === refusedOnlineOverflow.you.playerId)
    assert(ann.hand.some((card) => card.uid === 'online-overflow-dance'))
    assertEqual(refusedOnlineOverflow.run.combat.enemies[1].hp, 5)
    assertEqual(overflowRequests, 1, 'double-clicking the final target queued the card twice')
  })
  await a.getByRole('button', { name: /^Blade Dance,/ }).click()
  liveRoom.run.combat.players.find((player) => player.name === 'Bo').shivs = 1

  const energyBeforeLostResponse = (await snapshot(a)).run.combat.players
    .find((player) => player.id === aView.you.playerId).energy
  const boMiracleLogsBefore = await a.locator('.combat__log li')
    .filter({ hasText: 'Bo spends a Miracle for 1 Energy' }).count()
  const aResponseLossCredentials = await credentials(a)
  let committedPotionStatus = 0
  let postCommitted = false
  let failedReconciliationGets = 0
  let exhaustReconciliationRetries
  const reconciliationRetriesExhausted = new Promise((resolve) => { exhaustReconciliationRetries = resolve })
  let interleavedSnapshotSeen = false
  let interleavedSnapshot
  let socketClosedBeforeCommit = false
  let releaseAuthoritativeRefresh
  const authoritativeRefreshGate = new Promise((resolve) => { releaseAuthoritativeRefresh = resolve })
  const roomPattern = `**/api/rooms/${code}`
  const holdRoomRefresh = async (route) => {
    if (route.request().method() !== 'GET' || !postCommitted) return route.continue()
    if (failedReconciliationGets < 3) {
      failedReconciliationGets += 1
      if (failedReconciliationGets === 3) exhaustReconciliationRetries()
      return route.abort('connectionreset')
    }
    await authoritativeRefreshGate
    return route.continue()
  }
  await a.route(roomPattern, holdRoomRefresh)
  await a.route(`**/api/rooms/${code}/action`, async (route) => {
    socketClosedBeforeCommit = await a.evaluate(() => {
      const socket = window.__ROOM_SOCKETS__.at(-1)
      socket?.close()
      return socket?.readyState === WebSocket.CLOSING || socket?.readyState === WebSocket.CLOSED
    })
    const bo = liveRoom.run.combat.players.find((player) => player.name === 'Bo')
    bo.miracles = 1
    bo.energy = Math.min(bo.energy, 5)
    const interleaved = await fetch(`${roomOrigin}/api/rooms/${code}/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-room-token': bCredentials.token },
      body: JSON.stringify({ action: { kind: 'spendMiracle' } }),
    })
    assert(interleaved.ok, 'could not publish the interleaved teammate snapshot')
    const interleavedForAnn = await fetch(`${roomOrigin}/api/rooms/${code}`, {
      headers: { 'x-room-token': aResponseLossCredentials.token },
    })
    assert(interleavedForAnn.ok, 'could not capture the interleaved teammate snapshot')
    interleavedSnapshot = await interleavedForAnn.json()
    await a.evaluate((snapshot) => {
      window.__ROOM_SOCKETS__.at(-1)?.dispatchEvent(new MessageEvent('message', {
        data: JSON.stringify({ type: 'snapshot', snapshot }),
      }))
    }, interleavedSnapshot)
    await a.locator('.combat__log li').filter({ hasText: 'Bo spends a Miracle for 1 Energy' })
      .nth(boMiracleLogsBefore).waitFor()
    interleavedSnapshotSeen = true
    const response = await route.fetch()
    committedPotionStatus = response.status()
    postCommitted = true
    await route.abort('connectionreset')
  }, { times: 1 })
  const responseLossFailureStart = failures.length
  await a.locator('.combat__actions').getByRole('button', { name: /Energy Potion ×3/ }).click()
  await a.getByRole('alert').filter({ hasText: /fetch|network/i }).waitFor()
  await a.waitForFunction(() => [...document.querySelectorAll('.combat__actions button')]
    .some((button) => button.textContent?.includes('Energy Potion ×3') && button.disabled))
  await reconciliationRetriesExhausted
  await a.waitForTimeout(0)
  await a.evaluate((snapshot) => {
    window.__ROOM_SOCKETS__.at(-1)?.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ type: 'snapshot', snapshot }),
    }))
  }, interleavedSnapshot)
  await a.waitForFunction(() => [...document.querySelectorAll('.combat__actions button')]
    .some((button) => button.textContent?.includes('Energy Potion ×3') && button.disabled))
  const lockedAfterDelayedSnapshot = await a.locator('.combat__actions')
    .getByRole('button', { name: /Energy Potion ×3/ }).isDisabled()
  const afterLostResponse = await snapshot(a)
  const annAfterLostResponse = afterLostResponse.run.combat.players.find((player) => player.id === aView.you.playerId)
  const ghostPotionPrompt = await a.locator('.prompt').count()
  check('a delayed pre-action snapshot cannot unlock an unknown committed action', () => {
    assertEqual(committedPotionStatus, 200)
    assert(interleavedSnapshotSeen, 'the response-loss probe did not deliver its pre-action teammate snapshot')
    assert(socketClosedBeforeCommit, 'the response-loss probe left its WebSocket connected')
    assertEqual(failedReconciliationGets, 3, 'the response-loss probe did not exhaust reconciliation retries')
    assert(lockedAfterDelayedSnapshot, 'a delayed pre-action snapshot unlocked the unknown potion')
    assertEqual(annAfterLostResponse.energy, energyBeforeLostResponse + 2)
    assertDeepEqual(annAfterLostResponse.potions, ['energy_potion', 'energy_potion'])
    assertEqual(ghostPotionPrompt, 0)
  })
  for (let index = failures.length - 1; index >= responseLossFailureStart; index -= 1) {
    if (failures[index].includes('ERR_CONNECTION_RESET')) failures.splice(index, 1)
  }
  await a.evaluate((snapshot) => {
    window.__ROOM_SOCKETS__.at(-1)?.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ type: 'snapshot', snapshot }),
    }))
  }, afterLostResponse)
  await a.waitForFunction(() => [...document.querySelectorAll('.combat__actions button')]
    .some((button) => button.textContent?.includes('Energy Potion ×2') && !button.disabled))
  const committedSnapshotUnlocked = await a.locator('.combat__actions')
    .getByRole('button', { name: /Energy Potion ×2/ }).isEnabled()
  check('a committed snapshot arriving after unknown unlocks from exact inventory evidence', () => {
    assert(committedSnapshotUnlocked)
  })
  releaseAuthoritativeRefresh()
  await a.waitForFunction(() => window.__ROOM_SOCKETS__.at(-1)?.readyState === WebSocket.OPEN)
  await a.unroute(roomPattern, holdRoomRefresh)

  const energyBeforePotion = annAfterLostResponse.energy
  const rateLimitFailureStart = failures.length
  await a.route(`**/api/rooms/${code}/action`, (route) => route.fulfill({
    status: 429,
    contentType: 'text/html',
    body: '<h1>Rate limited</h1>',
  }), { times: 1 })
  await a.route(roomPattern, (route) => route.fulfill({
    status: 429,
    contentType: 'text/html',
    body: '<h1>Rate limited</h1>',
  }), { times: 1 })
  await a.locator('.combat__actions').getByRole('button', { name: /Energy Potion ×2/ }).click()
  await a.getByRole('alert').filter({ hasText: 'Request failed (429)' }).waitFor()
  await a.waitForFunction(() => [...document.querySelectorAll('.combat__actions button')]
    .some((button) => button.textContent?.includes('Energy Potion ×2') && !button.disabled))
  const afterRateLimit = await snapshot(a)
  let rateLimitErrors = 0
  for (let index = failures.length - 1; index >= rateLimitFailureStart; index -= 1) {
    if (failures[index].includes('429 (Too Many Requests)')) {
      rateLimitErrors += 1
      failures.splice(index, 1)
    }
  }
  check('a definitive rate-limit refusal unlocks even when its refresh is also refused', () => {
    assert(rateLimitErrors > 0, 'the rate-limit probe did not issue its refused requests')
    const ann = afterRateLimit.run.combat.players.find((player) => player.id === aView.you.playerId)
    assertEqual(ann.energy, energyBeforePotion)
    assertDeepEqual(ann.potions, ['energy_potion', 'energy_potion'])
  })

  let boundedRefreshAttempts = 0
  const boundedRetryFailureStart = failures.length
  await a.route(roomPattern, async (route) => {
    boundedRefreshAttempts += 1
    if (boundedRefreshAttempts === 1) return route.abort('connectionreset')
    return route.continue()
  }, { times: 2 })
  await a.route(`**/api/rooms/${code}/action`, (route) => route.abort('connectionreset'), { times: 1 })
  await a.locator('.combat__actions').getByRole('button', { name: /Energy Potion ×2/ }).click()
  await a.waitForFunction(() => [...document.querySelectorAll('.combat__actions button')]
    .some((button) => button.textContent?.includes('Energy Potion ×2') && !button.disabled))
  for (let index = failures.length - 1; index >= boundedRetryFailureStart; index -= 1) {
    if (failures[index].includes('ERR_CONNECTION_RESET')) failures.splice(index, 1)
  }
  const afterBoundedRetry = await snapshot(a)
  check('a bounded refresh retry reconciles an uncommitted transport failure', () => {
    assertEqual(boundedRefreshAttempts, 2)
    const ann = afterBoundedRetry.run.combat.players.find((player) => player.id === aView.you.playerId)
    assertEqual(ann.energy, energyBeforePotion)
    assertDeepEqual(ann.potions, ['energy_potion', 'energy_potion'])
  })

  let liveCommittedPotionStatus = 0
  let failedLiveReconciliations = 0
  const liveResponseLossFailureStart = failures.length
  await a.route(roomPattern, async (route) => {
    failedLiveReconciliations += 1
    await route.abort('connectionreset')
  }, { times: 3 })
  await a.route(`**/api/rooms/${code}/action`, async (route) => {
    const response = await route.fetch()
    liveCommittedPotionStatus = response.status()
    await a.locator('.combat__actions').getByRole('button', { name: 'Energy Potion', exact: true }).waitFor()
    await route.abort('connectionreset')
  }, { times: 1 })
  await a.locator('.combat__actions').getByRole('button', { name: /Energy Potion ×2/ }).click()
  await a.getByRole('alert').filter({ hasText: /fetch|network/i }).waitFor()
  await a.waitForFunction(() => [...document.querySelectorAll('.combat__actions button')]
    .some((button) => button.textContent?.includes('Energy Potion') && !button.textContent.includes('×') && !button.disabled))
  const afterLiveResponseLoss = await snapshot(a)
  const annAfterLiveResponseLoss = afterLiveResponseLoss.run.combat.players
    .find((player) => player.id === aView.you.playerId)
  check('a live authoritative commit unlocks without waiting for another snapshot', () => {
    assertEqual(liveCommittedPotionStatus, 200)
    assertEqual(failedLiveReconciliations, 3, 'the live response-loss probe did not exhaust reconciliation retries')
    assertEqual(annAfterLiveResponseLoss.energy, energyBeforePotion + 2)
    assertDeepEqual(annAfterLiveResponseLoss.potions, ['energy_potion'])
  })
  for (let index = failures.length - 1; index >= liveResponseLossFailureStart; index -= 1) {
    if (failures[index].includes('ERR_CONNECTION_RESET')) failures.splice(index, 1)
  }

  const energyBeforePotionDoubleClick = annAfterLiveResponseLoss.energy
  await a.locator('.combat__actions').getByRole('button', { name: 'Energy Potion', exact: true }).evaluate((button) => {
    button.click()
    button.click()
  })
  await a.waitForFunction(() => ![...document.querySelectorAll('.combat__actions button')]
    .some((button) => button.textContent?.includes('Energy Potion')))
  const afterPotionDoubleClick = await snapshot(a)
  const annAfterPotion = afterPotionDoubleClick.run.combat.players.find((player) => player.id === aView.you.playerId)
  check('one rapid double-click consumes only one physical potion', () => {
    assertEqual(annAfterPotion.energy, Math.min(6, energyBeforePotionDoubleClick + 2))
    assertDeepEqual(annAfterPotion.potions, [])
  })

  const hpBefore = aView.run.combat.enemies.reduce((sum, enemy) => sum + enemy.hp, 0)
  await a.getByRole('button', { name: /^(Strike|Bash),/ }).first().click()
  if (await a.locator('.prompt').count()) await a.locator('.enemy:not([disabled])').first().click()
  await b.waitForFunction((before) => {
    const lines = [...document.querySelectorAll('.combat__log li')].map((line) => line.textContent ?? '')
    return lines.some((line) => line.includes('Strike')) || lines.length > before
  }, bView.run.combat.log.length)
  const afterPlay = await snapshot(b)
  const hpAfter = afterPlay.run.combat.enemies.reduce((sum, enemy) => sum + enemy.hp, 0)
  const shownDraw = Number(await a.locator('.pile[title="Draw pile"] .pile__count').textContent())
  const actualDraw = afterPlay.run.combat.players.find((player) => player.id === aView.you.playerId).drawCount
  check('an action in one browser updates the other browser', () => {
    assert(hpAfter < hpBefore, `enemy HP did not fall: ${hpBefore} -> ${hpAfter}`)
    assertEqual(shownDraw, actualDraw, 'the private hand used the wrong public draw-pile count')
  })
  const viewerEnemyGeometry = await a.evaluate(() => {
    const board = document.querySelector('.board')?.getBoundingClientRect()
    const bar = document.querySelector('.row--viewer .enemy .bar')?.getBoundingClientRect()
    const element = document.querySelector('.board')
    return {
      visible: Boolean(board && bar && bar.top >= board.top && bar.bottom <= board.bottom),
      board: board ? { top: board.top, bottom: board.bottom } : null,
      bar: bar ? { top: bar.top, bottom: bar.bottom } : null,
      scrollTop: element?.scrollTop ?? null,
      scrollHeight: element?.scrollHeight ?? null,
    }
  })
  check('in-turn updates keep the viewer row enemy HP bar inside the board', () => {
    assert(viewerEnemyGeometry.visible, `the viewer row moved outside the board: ${JSON.stringify(viewerEnemyGeometry)}`)
  })
  await a.screenshot({ path: join(outDir, '02-authoritative-combat.png'), fullPage: true })

  const manualScroll = await a.locator('.board').evaluate(async (board) => {
    board.focus()
    board.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    board.scrollTop = 0
    await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame))
    return board.scrollTop
  })
  await b.getByRole('button', { name: /^(Strike|Bash),/ }).first().click()
  if (await b.locator('.prompt').count()) await b.locator('.enemy:not([disabled])').first().click()
  await a.waitForFunction(() => [...document.querySelectorAll('.combat__log li')]
    .some((line) => /Bo played/.test(line.textContent ?? '')))
  await a.waitForTimeout(100)
  const afterRemoteScroll = await a.locator('.board').evaluate((board) => board.scrollTop)
  check('a teammate action preserves deliberate inspection of another row', () => {
    assertEqual(afterRemoteScroll, manualScroll)
  })

  await a.getByRole('button', { name: 'Solo table' }).click()
  await a.getByLabel('Seed').waitFor()
  const preservedSeed = await a.getByLabel('Seed').inputValue()
  await a.getByRole('button', { name: 'Play online' }).click()
  await a.locator('.app-shell--online .combat').waitFor()
  check('switching modes preserves both the solo run and online seat', () => {
    assertEqual(preservedSeed, 'kept-local-run')
  })

  await a.getByRole('button', { name: /^Blade Dance,/ }).click()
  await a.locator('.enemy:not([disabled])').first().click()
  await a.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('2/2'))
  liveRoom.run.combat.players.find((player) => player.name === 'Ann').hand
    .push({ uid: 'online-order-shame', defId: 'shame', upgraded: false })
  liveRoom.run.combat.players.find((player) => player.name === 'Ann').block = 1
  liveRoom.run.combat.players.find((player) => player.name === 'Bo').hand
    .push({ uid: 'online-order-decay', defId: 'decay', upgraded: false })
  const aCredentials = await credentials(a)
  const endTurnStatuses = []
  let publishedEndTurnOrder
  let teammateOrderButtonDisabled
  let teammateReorderControlsDisabled
  let coordinatorAbilityLabels
  let decayAbilityId
  await a.route(`**/api/rooms/${code}`, async (route) => {
    const stalePlayerTurn = await route.fetch()
    for (const token of [aCredentials.token, bCredentials.token]) {
      const response = await fetch(`${roomOrigin}/api/rooms/${code}/action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-room-token': token },
        body: JSON.stringify({ action: { kind: 'endTurn' } }),
      })
      endTurnStatuses.push(response.status)
    }
    await a.getByRole('button', { name: 'Resolve end turn' }).waitFor()
    const [coordinatorStage, boStage] = await Promise.all([snapshot(a), snapshot(b)])
    publishedEndTurnOrder = coordinatorStage.endTurnOrder
    decayAbilityId = boStage.endTurnAbilities.find((ability) => ability.label.includes('Decay')).id
    teammateOrderButtonDisabled = await b.getByRole('button', { name: 'Waiting for end-turn order' }).isDisabled()
    const teammateArrows = b.locator('.end-turn-order li button')
    teammateReorderControlsDisabled = await teammateArrows.evaluateAll((buttons) =>
      buttons.length > 0 && buttons.every((button) => button.disabled))
    await a.locator('.end-turn-order > summary').click()
    coordinatorAbilityLabels = await a.locator('.end-turn-order li span').allTextContents()
    for (let index = publishedEndTurnOrder.indexOf(decayAbilityId); index > 0; index -= 1) {
      await a.locator('.end-turn-order li').nth(index).getByRole('button', { name: /earlier/ }).click()
    }
    await a.screenshot({ path: join(outDir, '03-party-end-turn-order.png'), fullPage: true })
    await a.getByRole('button', { name: 'Resolve end turn' }).click()
    await a.waitForFunction(() => document.querySelector('.combat')?.dataset.phase === 'discard')
    await route.fulfill({ response: stalePlayerTurn })
  }, { times: 1 })
  let endTurnConflictStatus = 0
  await a.route(`**/api/rooms/${code}/action`, async (route) => {
    liveRoom.run.combat.players.find((player) => player.name === 'Bo').shivs = 0
    const response = await route.fetch()
    endTurnConflictStatus = response.status()
    await route.fulfill({ response })
  }, { times: 1 })
  await a.locator('.enemy:not([disabled])').nth(1).click()
  await Promise.all([
    a.locator('.combat[data-phase="discard"]').waitFor(),
    b.locator('.combat[data-phase="discard"]').waitFor(),
  ])
  await a.waitForFunction(() => document.querySelector('.prompt') === null)
  const expectedEndTurnConflict = failures.findIndex((failure) => failure.includes('409 (Conflict)'))
  assert(expectedEndTurnConflict >= 0, 'the post-end-turn card action did not conflict')
  failures.splice(expectedEndTurnConflict, 1)
  const afterEndTurnRace = await snapshot(a)
  const stalePhasePrompt = await a.locator('.prompt').count()
  check('a stale conflict refresh after final end-turn cannot restore Player Turn targeting', () => {
    assertDeepEqual(endTurnStatuses, [200, 200])
    assertEqual(endTurnConflictStatus, 409)
    assertEqual(afterEndTurnRace.run.combat.phase, 'discard')
    assert(afterEndTurnRace.run.combat.players
      .find((player) => player.id === afterEndTurnRace.you.playerId).hand
      .some((card) => card.uid === 'online-overflow-dance'))
    assertEqual(stalePhasePrompt, 0)
  })
  check('the coordinator can publish, reorder, and resolve party-wide end-turn abilities', () => {
    assert(publishedEndTurnOrder.includes(decayAbilityId), JSON.stringify(publishedEndTurnOrder))
    assert(publishedEndTurnOrder.every((id) => !id.includes('card:') && !id.includes('online-order')),
      `private card UIDs leaked through ${JSON.stringify(publishedEndTurnOrder)}`)
    assert(teammateOrderButtonDisabled, 'the non-coordinator end-turn button remained enabled')
    assert(teammateReorderControlsDisabled, 'the non-coordinator could change an order they cannot submit')
    assert(coordinatorAbilityLabels.filter((label) => label.startsWith('Bo — '))
      .every((label) => label.includes('Private hand ability')),
      `the coordinator saw private cards: ${JSON.stringify(coordinatorAbilityLabels)}`)
    const decay = afterEndTurnRace.run.combat.log.findIndex((line) => line.startsWith('Decay damages Bo'))
    const shame = afterEndTurnRace.run.combat.log.findIndex((line) => line.startsWith('Shame: Ann'))
    assert(decay >= 0 && shame >= 0 && decay < shame,
      `Decay log ${decay}, Shame log ${shame}: ${JSON.stringify(afterEndTurnRace.run.combat.log)}`)
  })
  const aDiscardTop = a.getByLabel('Top discard for Ann')
  if (await aDiscardTop.count()) await aDiscardTop.selectOption({ index: 0 })
  const selectedDiscardTop = await aDiscardTop.count() ? await aDiscardTop.inputValue() : ''
  await a.getByRole('button', { name: /^Confirm Ann/ }).click()
  await a.getByRole('button', { name: /^Update Ann/ }).waitFor()
  const savedDiscard = await snapshot(a)
  await a.reload({ waitUntil: 'networkidle' })
  await a.locator('.app-shell--online .combat[data-phase="discard"]').waitFor()
  const restoredDiscardTop = await aDiscardTop.count() ? await aDiscardTop.inputValue() : ''
  check('refresh restores this seat\'s private discard order', () => {
    assertEqual(savedDiscard.discardOrder?.at(-1) ?? '', selectedDiscardTop)
    assertEqual(restoredDiscardTop, selectedDiscardTop)
  })
  await b.getByRole('button', { name: /^Confirm Bo/ }).click()
  await Promise.all([
    a.locator('.combat[data-phase="enemy"]').waitFor(),
    b.locator('.combat[data-phase="enemy"]').waitFor(),
  ])
  const enemyTurn = await snapshot(a)
  const enemyTurnPotions = await a.locator('.seat', { hasText: 'Bo' }).locator('.seat__potions').textContent()
  check('each seat independently confirms the shared end of turn', () => {
    assert(enemyTurn.run.combat.players.every((player) => player.handCount === 0))
    assertEqual(enemyTurn.run.combat.phase, 'enemy')
  })
  check('face-up potion summaries remain visible outside the Player Turn', () => {
    assert(enemyTurnPotions.includes('Block Potion'))
  })
  await b.getByRole('button', { name: 'Resolve enemies' }).click()
  await a.waitForFunction(() => ['roundEnd', 'lost'].includes(document.querySelector('.app-shell--online .combat')?.dataset.phase))
  const pageScroll = await a.evaluate(() => scrollY)
  check('combat row centering never scrolls the page chrome away', () => {
    assertEqual(pageScroll, 0)
  })
  await a.screenshot({ path: join(outDir, '04-shared-enemy-turn.png'), fullPage: true })

  const reconnectCredentials = await credentials(b)
  await b.close()
  const boStatus = a.locator('.setup .pip', { hasText: 'Bo' })
  await boStatus.filter({ hasText: '○' }).waitFor()
  b = await bContext.newPage()
  b.on('pageerror', (error) => failures.push(String(error)))
  b.on('console', (message) => { if (message.type() === 'error') failures.push(message.text()) })
  await b.addInitScript((saved) => {
    sessionStorage.setItem('sts-room-session', JSON.stringify(saved))
  }, reconnectCredentials)
  let markReconnectStarted
  const reconnectStarted = new Promise((resolve) => { markReconnectStarted = resolve })
  let releaseReconnect
  const reconnectReleased = new Promise((resolve) => { releaseReconnect = resolve })
  await b.route(`**/api/rooms/${code}`, async (route) => {
    markReconnectStarted()
    await reconnectReleased
    await route.continue()
  })
  await b.goto(origin, { waitUntil: 'domcontentloaded' })
  await reconnectStarted
  let createWhileReconnecting
  try {
    await b.locator('.online-reconnecting').waitFor()
    createWhileReconnecting = await b.getByRole('button', { name: 'Create room' }).count()
  } finally {
    releaseReconnect()
  }
  await b.locator('.app-shell--online .combat').waitFor()
  await boStatus.filter({ hasText: '●' }).waitFor()
  const restored = await snapshot(b)
  check('refresh reconnects to the same live seat', () => {
    assertEqual(restored.you.name, 'Bo')
    assertEqual(restored.phase, 'run')
    assertEqual(createWhileReconnecting, 0, 'reconnect exposed a destructive fresh-room form')
  })
  await b.screenshot({ path: join(outDir, '05-reconnected-seat.png'), fullPage: true })

  const recoveryTab = await bContext.newPage()
  recoveryTab.on('pageerror', (error) => failures.push(String(error)))
  recoveryTab.on('console', (message) => { if (message.type() === 'error') failures.push(message.text()) })
  await recoveryTab.goto(origin, { waitUntil: 'networkidle' })
  await recoveryTab.screenshot({ path: join(outDir, '06-saved-expedition.png'), fullPage: true })
  await recoveryTab.getByRole('button', { name: `Resume ${code}` }).click()
  await recoveryTab.locator('.app-shell--online .combat').waitFor()
  await b.locator('.online-entry').waitFor()
  const recoveredSeat = await snapshot(recoveryTab)
  check('a fresh tab can explicitly recover a live run seat', () => {
    assertEqual(recoveredSeat.you.name, 'Bo')
    assertEqual(recoveredSeat.phase, 'run')
  })
  await recoveryTab.screenshot({ path: join(outDir, '07-durable-seat-recovery.png'), fullPage: true })
  await b.close()
  b = recoveryTab

  const abandonedCombat = liveRoom.run.combat
  const abandonedAnn = abandonedCombat.players.find((player) => player.name === 'Ann')
  const abandonedBo = abandonedCombat.players.find((player) => player.name === 'Bo')
  abandonedCombat.phase = 'player'
  abandonedAnn.dead = false
  abandonedAnn.hp = Math.max(1, abandonedAnn.hp)
  abandonedAnn.hand = [{ uid: 'abandoned-acrobatics', defId: 'acrobatics', upgraded: false }]
  abandonedAnn.draw = [0, 1, 2].map((index) => ({
    uid: `abandoned-draw-${index}`, defId: 'defend_silent', upgraded: false,
  }))
  abandonedAnn.discard = []
  abandonedAnn.energy = 2
  abandonedAnn.miracles = 1
  abandonedBo.dead = false
  abandonedBo.hp = Math.max(1, abandonedBo.hp)
  liveRoom.cardPreviews = undefined
  liveRoom.endTurnReady = undefined
  liveRoom.endTurnAbilities = undefined
  liveRoom.endTurnOrders = undefined
  const abandonedCredentials = await credentials(a)
  const publishAbandonedFixture = await fetch(`${roomOrigin}/api/rooms/${code}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-room-token': abandonedCredentials.token },
    body: JSON.stringify({ action: { kind: 'spendMiracle' } }),
  })
  assert(publishAbandonedFixture.ok, 'could not publish the disconnected reveal fixture')
  await a.getByRole('button', { name: /^Acrobatics,/ }).click()
  await b.getByRole('status').filter({ hasText: 'Ann is resolving a revealed card' }).waitFor()
  await a.close()
  const recoveryButton = b.getByRole('button', { name: 'Resolve card and end turn' })
  await recoveryButton.waitFor()
  const lockedBeforeRecovery = await b.locator('.online-mutations').evaluate((table) => table.inert)
  await b.screenshot({ path: join(outDir, '08-disconnected-reveal-recovery.png'), fullPage: true })
  await recoveryButton.click()
  await recoveryButton.waitFor({ state: 'hidden' })
  const afterAbandonedRecovery = await snapshot(b)
  check('a teammate can resolve a reveal abandoned by a disconnected player', () => {
    assert(lockedBeforeRecovery, 'ordinary game controls unlocked around an abandoned private reveal')
    assertEqual(afterAbandonedRecovery.cardChoicePlayerId, undefined)
    assertEqual(liveRoom.cardPreviews?.[abandonedAnn.id], undefined)
    assert(!liveRoom.run.combat.players.find((player) => player.id === abandonedAnn.id).hand
      .some((card) => card.uid === 'abandoned-acrobatics'))
  })

  check('the online flow has no browser errors', () => {
    assertEqual(failures.length, 0, failures.join('\n'))
  })
} finally {
  await browser.close()
  await vite.close()
  await rooms.close()
}

report('online browser')
