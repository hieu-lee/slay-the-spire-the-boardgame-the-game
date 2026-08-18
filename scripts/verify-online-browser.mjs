import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createServer as createViteServer } from 'vite'
import { createRoomServer } from './room-server.mjs'
import { REBUILT_END_TURN_ORDER, createCombat } from '../src/game/combat.ts'
import { createRng } from '../src/game/rng.ts'
import { suite, check, assert, assertEqual, assertDeepEqual, report } from './lib/harness.mjs'
import { installScreenAudit } from './lib/browser-screen-audit.mjs'

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
    host: '127.0.0.1',
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
    window.__SFX_PLAYS__ = []
    window.__SFX_DETAILS__ = []
    window.__BGM_PAUSES__ = []
    HTMLMediaElement.prototype.play = function play() {
      window.__SFX_PLAYS__.push(new URL(this.src).pathname)
      window.__SFX_DETAILS__.push({
        path: new URL(this.src).pathname,
        cue: this.dataset.combatSfx ?? null,
        rate: this.playbackRate,
        volume: this.volume,
        delayMs: Number(this.dataset.combatSfxDelay ?? 0),
      })
      return Promise.resolve()
    }
    HTMLMediaElement.prototype.pause = function pause() {
      window.__BGM_PAUSES__.push(new URL(this.src).pathname)
    }
    window.WebSocket = new Proxy(window.WebSocket, {
      construct(Target, args) {
        const socket = new Target(...args)
        const send = socket.send.bind(socket)
        socket.send = (message) => {
          let auth = false
          try { auth = JSON.parse(String(message)).type === 'authenticate' } catch {}
          if (auth && window.__HOLD_ROOM_AUTH__) {
            window.__RELEASE_ROOM_AUTH__ = () => {
              window.__HOLD_ROOM_AUTH__ = false
              window.__RELEASE_ROOM_AUTH__ = undefined
              send(message)
            }
            return
          }
          send(message)
        }
        sockets.push(socket)
        return socket
      },
    })
  })
}
const a = installScreenAudit(await aContext.newPage())
let b = installScreenAudit(await bContext.newPage())
const failures = []
for (const page of [a, b]) {
  page.on('pageerror', (error) => failures.push(String(error)))
  page.on('console', (message) => { if (message.type() === 'error') failures.push(message.text()) })
}

async function enterOnline(page, name, character, code, localSeed, doubleSubmit = false) {
  await page.goto(origin, { waitUntil: 'networkidle' })
  void localSeed
  await page.getByRole('button', { name: 'Play online' }).click()
  const entry = page.locator('main.online-entry')
  await entry.getByLabel('Your name').fill(name)
  await entry.locator('select').selectOption(character)
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

async function openLobbySettings(page) {
  const settings = page.locator('.online-lobby__settings')
  if (!(await settings.evaluate((details) => details.open))) await settings.locator(':scope > summary').click()
}

async function roomAction(page, action) {
  const saved = await credentials(page)
  const response = await fetch(`${roomOrigin}/api/rooms/${saved.code}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-room-token': saved.token },
    body: JSON.stringify({ action }),
  })
  const body = await response.json()
  assert(response.ok, `action failed ${response.status}: ${body.error}`)
  return body
}

function contrastRatio(style) {
  const luminance = (css) => (css.match(/\d+(?:\.\d+)?/g)?.slice(0, 3).map(Number) ?? [])
    .map((channel) => channel / 255)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0)
  const foreground = luminance(style.color)
  const background = luminance(style.background)
  return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)
}

function bypassRoomNeow(room) {
  room.run = { ...room.run, phase: 'map', neow: null }
  room.version += 1
  rooms.publishRoom(room.code)
}

try {
  suite('online browser')
  const guardedEntry = installScreenAudit(await cContext.newPage())
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
  await guardedEntry.getByRole('button', { name: 'Play online' }).waitFor()
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
  rooms.store.rooms.get(code).campaignProgress.highestAscension = 13
  const healthAfterDoubleCreate = await fetch(`${roomOrigin}/api/health`).then((response) => response.json())
  await enterOnline(b, 'Bo', 'silent', code)
  await a.locator('.online-seat', { hasText: 'Bo' }).waitFor()
  const c = installScreenAudit(await cContext.newPage())
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
  await Promise.all([a, b, c].map((page) => page.locator('.voice__status', { hasText: '2/2' }).waitFor()))
  await Promise.all([a, b, c].map((page) => page.waitForFunction(() => [...document.querySelectorAll('audio')]
    .filter((audio) => audio.srcObject?.getAudioTracks().length).length === 2)))
  const remoteAudioCounts = await Promise.all([a, b, c].map((page) => page.evaluate(() => [...document.querySelectorAll('audio')]
    .filter((audio) => audio.srcObject?.getAudioTracks().length).length)))
  await a.getByRole('button', { name: 'Mute' }).click()
  const muted = await a.getByRole('button', { name: 'Unmute' }).getAttribute('aria-pressed')
  await a.screenshot({ path: join(outDir, '01a-live-party-voice.png'), fullPage: true })
  await c.getByRole('button', { name: 'Leave voice' }).click()
  await Promise.all([a, b].map((page) => page.locator('.voice__status', { hasText: '1/2' }).waitFor()))
  await c.getByRole('button', { name: 'Join voice' }).click()
  await Promise.all([a, b, c].map((page) => page.locator('.voice__status', { hasText: '2/2' }).waitFor()))
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
  await Promise.all([a, b].map((page) => page.locator('.voice__status', { hasText: '1/2' }).waitFor()))
  check('three browsers establish, mute, and leave native voice', () => {
    assert(remoteAudioCounts.every((count) => count === 2), `remote audio counts: ${remoteAudioCounts.join(', ')}`)
    assertEqual(muted, 'true')
    assertEqual(stoppedBeforeLeave, true, 'Leave room waited for HTTP before stopping the microphone')
  })
  releaseVoiceLeave()
  await a.locator('.online-seat', { hasText: 'Cy' }).waitFor({ state: 'detached' })
  await c.close()
  await Promise.all([a, b].map((page) => page.locator('.voice__status', { hasText: '1/1' }).waitFor()))
  for (const [dropped, observer, seatName] of [[b, a, 'Bo'], [a, b, 'Ann']]) {
    await dropped.evaluate(() => window.__ROOM_SOCKETS__.at(-1)?.close(4000, 'test reconnect'))
    await observer.locator('.online-seat', { hasText: seatName }).locator('.online-seat__class em', { hasText: 'away' }).waitFor()
    await observer.locator('.voice__status', { hasText: '0/1' }).waitFor()
    await Promise.all([a, b].map((page) => page.locator('.voice__status', { hasText: '1/1' }).waitFor()))
    await Promise.all([a, b].map((page) => page.waitForFunction(() => [...document.querySelectorAll('audio')]
      .filter((audio) => audio.srcObject?.getAudioTracks().length).length === 1)))
  }
  check('active voice recovers after either signaling socket reconnects', () => {})
  await b.getByRole('button', { name: 'Leave voice' }).click()
  await a.locator('.voice__status', { hasText: '0/1' }).waitFor()
  await a.getByRole('button', { name: 'Leave voice' }).click()
  await a.screenshot({ path: join(outDir, '01-two-player-lobby.png'), fullPage: true })

  const [aOnline, bOnline] = await Promise.all([
    a.locator('.online-seat[aria-label*="online"]').count(),
    b.locator('.online-seat[aria-label*="online"]').count(),
  ])
  check('two browsers converge in one lobby', () => {
    assertEqual(healthAfterDoubleCreate.rooms, 1, 'double create orphaned a room')
    assertEqual(aOnline, 2)
    assertEqual(bOnline, 2)
  })

  const lobbyChrome = await a.evaluate(() => {
    const table = document.querySelector('.online-lobby__table')
    const mine = document.querySelector('.online-seat--you')
    const seats = [...document.querySelectorAll('.online-seat:not(.online-seat--empty)')]
    const box = table.getBoundingClientRect()
    return {
      // The panel wears the same chamfer + hard shadow as every other painted
      // panel, rather than the flat rounded card this screen used to be.
      chamfered: getComputedStyle(table).clipPath !== 'none',
      rounded: getComputedStyle(table).borderRadius,
      portraits: seats.filter((seat) => seat.querySelector('.online-seat__portrait img')).length,
      mineIsFirst: mine === seats[0],
      overflowsX: document.documentElement.scrollWidth > window.innerWidth + 1,
      fits: box.left >= -1 && box.right <= window.innerWidth + 1,
      startKeyed: getComputedStyle(document.querySelector('.online-lobby__start')).clipPath !== 'none',
    }
  })
  await a.setViewportSize({ width: 380, height: 820 })
  await a.waitForTimeout(250)
  const narrowLobby = await a.evaluate(() => ({
    overflowsX: document.documentElement.scrollWidth > window.innerWidth + 1,
    seats: document.querySelectorAll('.online-seat').length,
  }))
  await a.screenshot({ path: join(outDir, '01c-lobby-narrow.png'), fullPage: true })
  await a.setViewportSize({ width: 1280, height: 800 })
  await a.waitForTimeout(250)
  check('the party room is dressed like the rest of the game and fits a phone', () => {
    assert(lobbyChrome.chamfered, 'the lobby panel is not chamfered like the other painted panels')
    assertEqual(lobbyChrome.rounded, '0px', 'the pre-chrome rounded card is still there')
    assertEqual(lobbyChrome.portraits, 2, 'a taken seat did not show its character portrait')
    assert(lobbyChrome.mineIsFirst, 'the viewer\'s own seat is not the one marked')
    assert(lobbyChrome.startKeyed, 'Enter the Spire is not wearing the shared key skin')
    assert(!lobbyChrome.overflowsX && lobbyChrome.fits, 'the lobby panel overflows a desktop window')
    assertEqual(narrowLobby.seats, 4, 'the four places are not all shown on a narrow window')
    assert(!narrowLobby.overflowsX, 'the lobby scrolls sideways at 380px')
  })
  await Promise.all([openLobbySettings(a), openLobbySettings(b)])
  await a.locator('.online-lobby').getByLabel('Ascension').selectOption('3')
  await b.locator('.online-lobby').getByLabel('Ascension').waitFor()
  await b.waitForFunction(() => [...document.querySelectorAll('main.online-lobby label')].find((label) => label.textContent?.includes('Ascension'))?.querySelector('select')?.value === '3')
  const sharedLobby = await snapshot(a)
  check('lobby leave and ascension are authoritative for the party', () => {
    assertEqual(sharedLobby.ascension, 3)
    assertEqual(sharedLobby.seats.length, 2)
  })
  const hostLastStand = a.locator('.online-lobby').getByRole('checkbox', { name: 'Last Stand' })
  const guestLastStand = b.locator('.online-lobby').getByRole('checkbox', { name: 'Last Stand' })
  await hostLastStand.click()
  await a.waitForFunction(() => document.querySelector('main.online-lobby input[aria-label="Last Stand"]')?.checked === true)
  await b.waitForFunction(() => document.querySelector('main.online-lobby input[aria-label="Last Stand"]')?.checked === true)
  const guestLastStandDisabled = await guestLastStand.isDisabled()
  const guestCredentials = await credentials(b)
  const forgedLastStand = await fetch(`${roomOrigin}/api/rooms/${code}/last-stand-rule`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-room-token': guestCredentials.token },
    body: JSON.stringify({ enabled: false }),
  })
  await a.evaluate(() => window.__ROOM_SOCKETS__.at(-1)?.close(4000, 'Last Stand reconnect test'))
  await a.locator('.connection--reconnecting').waitFor()
  const hostLastStandDisabledDuringReconnect = await hostLastStand.isDisabled()
  await a.locator('.connection--connected').waitFor()
  const hostLastStandRestored = await hostLastStand.isChecked()
  check('only the connected party leader controls Last Stand and reconnect restores it', () => {
    assert(guestLastStandDisabled, 'a guest could edit the host-only Last Stand rule')
    assertEqual(forgedLastStand.status, 409, 'the server accepted a guest Last Stand mutation')
    assert(hostLastStandDisabledDuringReconnect, 'Last Stand stayed editable while reconnecting')
    assert(hostLastStandRestored, 'the selected Last Stand rule disappeared after reconnect')
  })
  await hostLastStand.click()
  await a.waitForFunction(() => document.querySelector('main.online-lobby input[aria-label="Last Stand"]')?.checked === false)
  await b.waitForFunction(() => document.querySelector('main.online-lobby input[aria-label="Last Stand"]')?.checked === false)
  await a.setViewportSize({ width: 1280, height: 800 })
  await a.screenshot({ path: join(outDir, '01b-compact-desktop-lobby.png'), fullPage: true })
  const compactWidth = await a.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }))
  check('the online lobby fits the compact desktop without horizontal overflow', () => {
    assert(compactWidth.document <= compactWidth.viewport, `${compactWidth.document}px document in ${compactWidth.viewport}px viewport`)
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
  await openLobbySettings(b)
  await b.locator('.online-lobby').getByLabel('Ascension').selectOption('4')
  await mutationStarted
  await b.locator('.online-lobby').getByLabel('Ascension').selectOption('5')
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
  await openLobbySettings(b)
  await b.locator('.online-lobby').getByLabel('Ascension').selectOption('6')
  await a.waitForFunction(() => [...document.querySelectorAll('main.online-lobby label')].find((label) => label.textContent?.includes('Ascension'))?.querySelector('select')?.value === '6')
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
  await a.locator('.online-lobby').getByLabel('Ascension').selectOption('5')
  await queuedAscensionStart
  await a.locator('.online-lobby').getByLabel('Ascension').selectOption('4')
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
  await a.locator('.online-lobby').getByLabel('Ascension').selectOption('6')
  await b.waitForFunction(() => [...document.querySelectorAll('main.online-lobby label')].find((label) => label.textContent?.includes('Ascension'))?.querySelector('select')?.value === '6')

  await a.getByRole('button', { name: 'Enter the Spire' }).click()
  await a.getByRole('heading', { name: 'Neow’s Blessing' }).waitFor()

  // Reveal a Neow reward through the real online UI. Every other Neow test in
  // this suite calls bypassRoomNeow, which is how this shipped broken: the
  // client posted `sources: []` for any seat that is not choosing prismatic
  // decks, the server takes only an absent key or exactly 3, and the 409 left
  // the Reveal key looking enabled while doing nothing — Skip unseen was the
  // only way out of Neow online.
  const neowActionFailures = []
  const recordNeowFailure = (response) => {
    if (response.url().includes('/action') && !response.ok()) neowActionFailures.push(response.status())
  }
  a.on('response', recordNeowFailure)
  const neowSeat = (await snapshot(a)).you.playerId
  const neowGold = a.getByRole('button', { name: /^Skip 3 Gold$/ })
  if (await neowGold.isVisible().catch(() => false)) {
    await neowGold.click()
    await a.waitForTimeout(150)
  }
  const neowReveal = a.getByRole('button', { name: /^Reveal / })
  await neowReveal.waitFor()
  await neowReveal.click()
  // Poll the SERVER for a revealed reward rather than waiting on a button. The
  // Neow screen always has a "Skip …" key on it, so any DOM wait loose enough
  // to match the revealed state also matches the broken one and passes either
  // way — `reward`/`redReward` turning non-null is the state only a 200 can
  // produce.
  let neowRevealed = null
  for (let attempt = 0; attempt < 20 && !neowRevealed; attempt += 1) {
    const progress = (await snapshot(a)).run.neow?.players?.[neowSeat]
    if (progress?.reward || progress?.redReward) neowRevealed = progress
    else await a.waitForTimeout(100)
  }
  a.off('response', recordNeowFailure)
  check('an online Neow reward can actually be revealed', () => {
    assertEqual(neowActionFailures.length, 0, `Neow actions were rejected: ${neowActionFailures.join(', ')}`)
    assert(Boolean(neowRevealed), 'clicking Reveal never produced a revealed Neow reward')
  })

  const openingRoom = rooms.store.rooms.get(code)
  bypassRoomNeow(openingRoom)
  await Promise.all([
    a.locator('.app-shell--online .map').waitFor(),
    b.locator('.app-shell--online .map').waitFor(),
  ])
  await a.locator('.app-shell--online .room--reachable').hover()
  await a.waitForFunction(() =>
    getComputedStyle(document.querySelector('.app-shell--online .room--reachable .room-tip')).visibility === 'visible')
  const onlineOpeningMapTip = await a.locator('.app-shell--online .map').evaluate((map) => {
    const tip = map.querySelector('.room--reachable .room-tip')
    return tip.getBoundingClientRect().bottom <= map.getBoundingClientRect().bottom + 1
  })
  check('the online opening map node tooltip has room below it', () => {
    assert(onlineOpeningMapTip, 'the online opening Encounter tooltip was clipped below the map')
  })
  const onlineBoss = createCombat(createRng(406), openingRoom.run.players, [{
    uid: 'online-boss', defId: 'hexaghost', row: 0, hp: 36, maxHp: 36, block: 0, strength: 0,
    vulnerable: 0, weak: 0, poison: 0, actionIndex: 0, abilityUsed: false, dead: false, isBoss: true,
  }], 'online-bgm', [], 3)
  openingRoom.run = { ...openingRoom.run, phase: 'combat', combat: onlineBoss }
  openingRoom.version += 1
  rooms.publishRoom(code)
  await a.waitForFunction(() => window.__SFX_PLAYS__.includes('/assets/bgm/the-guardian-emerges.mp3'))
  const reconnectBgmPlayBefore = await a.evaluate(() => window.__SFX_PLAYS__.length)
  await a.evaluate(() => window.__ROOM_SOCKETS__.at(-1)?.close())
  await a.locator('.connection--reconnecting').waitFor()
  await a.waitForFunction(() => window.__BGM_PAUSES__.includes('/assets/bgm/the-guardian-emerges.mp3'))
  await a.locator('.connection--connected').waitFor()
  await a.waitForFunction((before) => window.__SFX_PLAYS__.slice(before).includes('/assets/bgm/the-guardian-emerges.mp3'), reconnectBgmPlayBefore)
  check('online boss music pauses during reconnect and resumes from the authoritative boss state', () => assert(true))
  openingRoom.run = { ...openingRoom.run, phase: 'map', combat: null }
  openingRoom.version += 1
  rooms.publishRoom(code)
  await a.locator('.app-shell--online .map').waitFor()
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
  await a.evaluate(() => {
    window.__OPENING_HAND_FIRST_FRAME__ = null
    const observer = new MutationObserver(() => {
      const card = document.querySelector('.app-shell--online .combat .hand .card')
      if (!card) return
      window.__OPENING_HAND_FIRST_FRAME__ = card.classList.contains('card--drawn')
      observer.disconnect()
    })
    observer.observe(document.body, { childList: true, subtree: true })
  })
  await a.locator('.app-shell--online .room--reachable').click()
  await Promise.all([
    a.locator('.app-shell--online .combat').waitFor(),
    b.locator('.app-shell--online .combat').waitFor(),
    a.locator('.hand .card--drawn').first().waitFor(),
  ])
  const onlineOpeningDeal = await a.locator('.hand .card--drawn').first().evaluate((card) =>
    getComputedStyle(card).animationName)
  const onlineOpeningFirstFrame = await a.evaluate(() => window.__OPENING_HAND_FIRST_FRAME__)
  const onlineOpeningSounds = await a.evaluate(() => window.__SFX_PLAYS__)
  const onlineRunStatus = await a.locator('.app-shell--online .run-status').textContent()
  check('the online table keeps the chosen Ascension visible during the run', () => {
    assert(onlineRunStatus.includes('Ascension 6'), `missing Ascension status: ${onlineRunStatus}`)
  })
  check('a newly entered online combat deals its opening hand', () => {
    assertEqual(onlineOpeningDeal, 'card-draw')
    assertEqual(onlineOpeningFirstFrame, true, 'the hand painted once before its draw class was applied')
    assert(onlineOpeningSounds.includes('/assets/sfx/draw.ogg'), 'the opening draw was silent')
  })
  await a.waitForFunction(() => !document.querySelector('.hand .card--drawn'))

  const onlineRunBeforeCompendium = await snapshot(a)
  await a.locator('details.game-settings > summary').click()
  await a.getByRole('button', { name: 'Compendium' }).click()
  await a.locator('.compendium').waitFor()
  await a.getByLabel('View upgrades').check()
  await a.getByRole('button', { name: 'Back to fight' }).click()
  await a.locator('.app-shell--online .combat').waitFor()
  const onlineRunAfterCompendium = await snapshot(a)
  check('online fight settings can inspect upgrades without mutating the shared run', () => {
    assertEqual(onlineRunAfterCompendium.version, onlineRunBeforeCompendium.version)
    assertDeepEqual(onlineRunAfterCompendium.run.combat, onlineRunBeforeCompendium.run.combat)
  })

  const giveUpRestore = structuredClone(liveRoom.run)
  await a.evaluate(() => {
    const actualNow = Date.now
    window.__RESTORE_DATE_NOW__ = () => { Date.now = actualNow }
    Date.now = () => actualNow() + 60 * 60 * 1000
  })
  await b.locator('details.game-settings > summary').click()
  await b.getByRole('button', { name: 'Compendium' }).click()
  await b.locator('.compendium').waitFor()
  await a.locator('details.game-settings > summary').click()
  await a.getByRole('button', { name: 'Give up' }).click()
  const aGiveUp = a.getByRole('dialog', { name: 'Give up this fight?' })
  const bGiveUp = b.getByRole('dialog', { name: 'Give up this fight?' })
  await Promise.all([aGiveUp.waitFor(), bGiveUp.waitFor()])
  const compendiumInterruptedByVote = await b.locator('.compendium').count()
  liveRoom.giveUpVote.deadlineAt = Date.now() + 250
  liveRoom.version += 1
  rooms.publishRoom(code)
  await Promise.all([aGiveUp.waitFor({ state: 'hidden' }), bGiveUp.waitFor({ state: 'hidden' })])
  await a.getByRole('button', { name: 'Give up' }).click()
  await Promise.all([aGiveUp.waitFor(), bGiveUp.waitFor()])
  const giveUpDeadlineLabel = await aGiveUp.getByRole('timer').textContent()
  const giveUpBounds = await aGiveUp.evaluate((dialog) => {
    const box = dialog.getBoundingClientRect()
    return { modal: dialog.matches(':modal'), left: box.left, right: box.right, top: box.top, bottom: box.bottom,
      width: innerWidth, height: innerHeight }
  })
  await a.screenshot({ path: join(outDir, '02a-give-up-vote.png'), fullPage: true })
  await aGiveUp.getByRole('button', { name: 'Yes, give up' }).click()
  await bGiveUp.getByText('Ann: Yes').waitFor()
  await b.reload({ waitUntil: 'domcontentloaded' })
  await b.locator('.connection--connected').waitFor()
  const restoredGiveUp = b.getByRole('dialog', { name: 'Give up this fight?' })
  await restoredGiveUp.getByText('Ann: Yes').waitFor()
  await restoredGiveUp.getByRole('button', { name: 'Yes, give up' }).click()
  await Promise.all([a.getByRole('heading', { name: 'The party has fallen' }).waitFor(),
    b.getByRole('heading', { name: 'The party has fallen' }).waitFor()])
  const surrenderedOnlineRun = await snapshot(a)
  await a.evaluate(() => window.__RESTORE_DATE_NOW__())
  liveRoom.run = giveUpRestore
  liveRoom.giveUpVote = undefined
  liveRoom.version += 1
  rooms.publishRoom(code)
  await Promise.all([a.locator('.app-shell--online .combat').waitFor(), b.locator('.app-shell--online .combat').waitFor()])
  await a.locator('details.game-settings').evaluate((details) => { details.open = false })
  check('online Give up restarts after expiry and is a reconnect-safe unanimous 10-second vote', () => {
    assert(/^\d+s remaining$/.test(giveUpDeadlineLabel), `missing give-up deadline: ${giveUpDeadlineLabel}`)
    assertEqual(compendiumInterruptedByVote, 0, 'an incoming give-up vote stayed hidden behind Compendium')
    assert(giveUpBounds.modal, 'the give-up vote was not modal')
    assert(giveUpBounds.left >= 0 && giveUpBounds.right <= giveUpBounds.width &&
      giveUpBounds.top >= 0 && giveUpBounds.bottom <= giveUpBounds.height,
    `give-up panel leaves the viewport: ${JSON.stringify(giveUpBounds)}`)
    assertEqual(surrenderedOnlineRun.run.phase, 'defeat')
  })

  // Hold authentication after the reconnect GET has completed, then kill an
  // enemy before the first WebSocket snapshot. Both catch-up snapshots are
  // restoration, not live hits, even though the mounted board stays present.
  liveRoom.run.combat.enemies[0].weak = 0
  rooms.publishRoom(code)
  await a.waitForFunction(() => !document.querySelector('.enemy')?.getAttribute('aria-label')?.includes('Weak'))
  const restoredEnemy = structuredClone(liveRoom.run.combat.enemies[0])
  await a.evaluate(() => {
    window.__SFX_PLAYS__ = []
    window.__SFX_DETAILS__ = []
    window.__HOLD_ROOM_AUTH__ = true
    window.__RELEASE_ROOM_AUTH__ = undefined
    window.__ROOM_SOCKETS__.at(-1)?.close(4000, 'death animation reconnect test')
  })
  await a.locator('.connection--reconnecting').waitFor()
  await a.waitForFunction(() => typeof window.__RELEASE_ROOM_AUTH__ === 'function')
  Object.assign(liveRoom.run.combat.enemies[0], { hp: 0, dead: true, weak: 1 })
  const reconnectActor = liveRoom.run.combat.players.find((player) => player.name === 'Ann')
  await b.evaluate(() => { window.__SFX_DETAILS__ = [] })
  const historicalVfxSeq = liveRoom.run.combat.presentationEvents
    .reduce((latest, event) => Math.max(latest, event.seq), -1) + 1
  liveRoom.run.combat.presentationEvents = [...liveRoom.run.combat.presentationEvents, {
    seq: historicalVfxSeq,
    kind: 'card',
    actorId: reconnectActor.id,
    sourceId: 'strike_ironclad',
    enemyIds: [liveRoom.run.combat.enemies[0].uid],
    playerIds: [],
    upgraded: false,
    copied: false,
    energy: 1,
  }].slice(-12)
  rooms.publishRoom(code)
  await b.locator('.enemy--dead').first().waitFor()
  const peerHistoricalVfx = b.locator(`.combat-vfx[data-vfx-seq="${historicalVfxSeq}"]`)
  await peerHistoricalVfx.first().waitFor()
  await b.waitForFunction(() => window.__SFX_DETAILS__.filter((sound) =>
    sound.cue?.includes(':strike_ironclad:')).length === 2)
  const peerHistoricalSource = await peerHistoricalVfx.first().getAttribute('data-vfx-source')
  const peerHistoricalSounds = await b.evaluate(() => window.__SFX_DETAILS__.filter((sound) =>
    sound.cue?.includes(':strike_ironclad:')))
  await a.evaluate(() => window.__RELEASE_ROOM_AUTH__())
  await a.locator('.connection--connected').waitFor()
  const reconnectedCorpse = a.locator('.enemy--dead').first()
  await reconnectedCorpse.waitFor()
  const reconnectDeathMotion = await reconnectedCorpse.evaluate((enemy) => ({
    falling: enemy.classList.contains('enemy--falling'),
    animation: getComputedStyle(enemy.querySelector('.enemy__portrait')).animationName,
  }))
  const reconnectWeakSounds = await a.evaluate(() => window.__SFX_PLAYS__
    .filter((path) => path === '/assets/sfx/weak.ogg').length)
  const reconnectSounds = await a.evaluate(() => window.__SFX_PLAYS__
    .filter((path) => path.startsWith('/assets/sfx/')))
  const reconnectPersonalSounds = await a.evaluate(() => window.__SFX_DETAILS__.filter((sound) => sound.cue))
  const reconnectDrawMotion = await a.locator('.hand .card--drawn').count()
  const reconnectHistoricalVfx = await a.locator(`.combat-vfx[data-vfx-seq="${historicalVfxSeq}"]`).count()
  check('a retained online combat does not replay effects learned during reconnect', () => {
    assertEqual(reconnectDeathMotion.falling, false)
    assertEqual(reconnectDeathMotion.animation, 'none')
    assertEqual(reconnectWeakSounds, 0)
    assertDeepEqual(reconnectSounds, [])
    assertEqual(reconnectDrawMotion, 0)
    assertEqual(peerHistoricalSource, 'strike_ironclad', 'a connected peer missed the live action')
    assertEqual(peerHistoricalSounds.length, 2, 'the connected peer missed Strike personal audio')
    assert(peerHistoricalSounds[0].rate !== 1, 'the peer received generic instead of tuned audio')
    assert(peerHistoricalSounds.some((sound) => sound.delayMs >= 36), 'the peer missed the timed identity accent')
    assertDeepEqual(reconnectPersonalSounds, [], 'the reconnect replayed personal audio history')
    assertEqual(reconnectHistoricalVfx, 0, 'the reconnect replayed an action learned while offline')
  })
  Object.assign(liveRoom.run.combat.enemies[0], restoredEnemy)
  rooms.publishRoom(code)
  await Promise.all([
    a.locator('.enemy--dead').waitFor({ state: 'detached' }),
    b.locator('.enemy--dead').waitFor({ state: 'detached' }),
  ])

  // Capture a REST response, then let a newer WebSocket snapshot land before
  // releasing it. The rejected stale GET must not cancel that live hit.
  await a.locator('.combat[data-phase="player"]').waitFor()
  let releaseStaleGet
  const staleGetRelease = new Promise((resolve) => { releaseStaleGet = resolve })
  let markStaleGetCaptured
  const staleGetCaptured = new Promise((resolve) => { markStaleGetCaptured = resolve })
  const staleFailureStart = failures.length
  const roomGetPattern = `**/api/rooms/${code}`
  await a.route(roomGetPattern, async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    const response = await route.fetch()
    markStaleGetCaptured()
    await staleGetRelease
    await route.fulfill({ response })
  })
  await a.route(`**/api/rooms/${code}/action`, (route) => route.abort('connectionreset'), { times: 1 })
  await a.locator('.combat__end-turn').click()
  await staleGetCaptured
  const liveHitEnemy = liveRoom.run.combat.enemies[0]
  const liveHitHp = liveHitEnemy.hp
  liveHitEnemy.hp -= 1
  liveRoom.run.combat.players.find((player) => player.name === 'Bo').miracles = 1
  await roomAction(b, { kind: 'spendMiracle' })
  const liveHit = a.locator('.enemy--struck, .enemy--struck-alt').first()
  await liveHit.waitFor()
  releaseStaleGet()
  await a.waitForTimeout(20)
  const liveHitAfterStaleGet = await liveHit.evaluate((enemy) =>
    getComputedStyle(enemy.querySelector('.enemy__portrait')).animationName)
  await a.unroute(roomGetPattern)
  const staleGetFailures = failures.splice(staleFailureStart)
  check('a rejected stale REST snapshot does not cut short a newer socket hit', () => {
    assert(liveHitAfterStaleGet.startsWith('struck-stage'), liveHitAfterStaleGet)
    assertEqual(staleGetFailures.length, 1)
    assert(staleGetFailures[0].includes('ERR_CONNECTION_RESET'), staleGetFailures[0])
  })
  liveRoom.run.combat.enemies.find((enemy) => enemy.uid === liveHitEnemy.uid).hp = liveHitHp
  liveRoom.run.combat.players.find((player) => player.name === 'Bo').miracles = 1
  await roomAction(b, { kind: 'spendMiracle' })
  await liveHit.waitFor({ state: 'detached' })

  const [aView, bView] = await Promise.all([snapshot(a), snapshot(b)])
  const annSeat = a.locator('.seat', { hasText: 'Ann' })
  const boSeat = a.locator('.seat', { hasText: 'Bo' })
  const annPotions = await annSeat.locator('.seat__potions .potion-chip').count()
  const boPotions = await boSeat.locator('.seat__potions .potion-chip').count()
  const annSeatLabel = await annSeat.getAttribute('aria-label')
  const boSeatLabel = await boSeat.getAttribute('aria-label')
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
    assertEqual(annPotions, 3)
    assertEqual(boPotions, 1)
    assert(annSeatLabel.includes('Energy Potion ×3: Gain 2 Energy.'))
    assert(boSeatLabel.includes('Block Potion: 2 Block to any player.'))
    assertEqual(foreignPotionControls, 0)
  })
  let annLive = liveRoom.run.combat.players.find((player) => player.name === 'Ann')
  let boLive = liveRoom.run.combat.players.find((player) => player.name === 'Bo')
  const previewCredentials = await credentials(b)
  const boBeforeFinale = structuredClone({
    hand: boLive.hand,
    draw: boLive.draw,
    energy: boLive.energy,
    miracles: boLive.miracles,
  })
  Object.assign(boLive, {
    hand: [{ uid: 'online-grand-finale', defId: 'grand_finale', upgraded: false }],
    draw: [{ uid: 'online-finale-draw', defId: 'defend_silent', upgraded: false }],
    energy: 0,
    miracles: 1,
  })
  const publishLockedFinale = await fetch(`${roomOrigin}/api/rooms/${code}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-room-token': previewCredentials.token },
    body: JSON.stringify({ action: { kind: 'spendMiracle' } }),
  })
  assert(publishLockedFinale.ok, 'could not publish the locked Grand Finale fixture')
  const onlineFinale = b.getByRole('button', { name: /^Grand Finale,/ })
  await onlineFinale.waitFor()
  const finaleLockedOnline = await onlineFinale.getAttribute('aria-disabled') === 'true'
  const hiddenDrawSnapshot = await snapshot(b)
  boLive = liveRoom.run.combat.players.find((player) => player.name === 'Bo')
  Object.assign(boLive, { draw: [], miracles: 1 })
  const publishUnlockedFinale = await fetch(`${roomOrigin}/api/rooms/${code}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-room-token': previewCredentials.token },
    body: JSON.stringify({ action: { kind: 'spendMiracle' } }),
  })
  assert(publishUnlockedFinale.ok, 'could not publish the unlocked Grand Finale fixture')
  await b.waitForFunction(() => {
    const button = [...document.querySelectorAll('button')]
      .find((candidate) => candidate.getAttribute('aria-label')?.startsWith('Grand Finale,'))
    return button?.getAttribute('aria-disabled') === 'false'
  })
  const finaleUnlockedOnline = await onlineFinale.getAttribute('aria-disabled') === 'false'
  await onlineFinale.click()
  await b.locator('.prompt').filter({ hasText: 'Choose an enemy' }).waitFor()
  boLive = liveRoom.run.combat.players.find((player) => player.name === 'Bo')
  Object.assign(boLive, {
    draw: [{ uid: 'online-finale-race-draw', defId: 'strike_silent', upgraded: false }],
    miracles: 1,
  })
  const publishInvalidatedFinale = await fetch(`${roomOrigin}/api/rooms/${code}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-room-token': previewCredentials.token },
    body: JSON.stringify({ action: { kind: 'spendMiracle' } }),
  })
  assert(publishInvalidatedFinale.ok, 'could not publish the invalidated Grand Finale fixture')
  await b.waitForFunction(() => {
    const button = [...document.querySelectorAll('button')]
      .find((candidate) => candidate.getAttribute('aria-label')?.startsWith('Grand Finale,'))
    return button?.getAttribute('aria-disabled') === 'true' && !document.querySelector('.prompt')?.textContent?.includes('Choose an enemy')
  })
  const finaleClearedAfterRefill = await b.locator('.enemy--targeted').count() === 0
  check('online Grand Finale uses the public draw count without revealing the pile', () => {
    const visibleBo = hiddenDrawSnapshot.run.combat.players
      .find((player) => player.id === hiddenDrawSnapshot.you.playerId)
    assertEqual(visibleBo.drawCount, 1)
    assertEqual(visibleBo.draw, undefined)
    assert(finaleLockedOnline, 'Grand Finale was enabled while the hidden draw pile had a card')
    assert(finaleUnlockedOnline, 'Grand Finale stayed disabled after the hidden draw pile emptied')
    assert(finaleClearedAfterRefill, 'a staged Grand Finale kept its targets after the draw pile refilled')
  })

  annLive = liveRoom.run.combat.players.find((player) => player.name === 'Ann')
  boLive = liveRoom.run.combat.players.find((player) => player.name === 'Bo')
  Object.assign(annLive, {
    hand: [{ uid: 'online-whirlwind', defId: 'whirlwind', upgraded: true }],
    discard: [], draw: [], energy: 3, strength: 0, weak: 0,
  })
  Object.assign(boLive, { ...boBeforeFinale, miracles: 1, energy: 2 })
  const enemyTemplate = liveRoom.run.combat.enemies[0]
  liveRoom.run.combat.enemies = [
    { ...enemyTemplate, uid: 'online-whirlwind-anchor', defId: 'cultist', row: 0, isBoss: false,
      hp: 10, maxHp: 10, block: 0, dead: false },
    { ...enemyTemplate, uid: 'online-whirlwind-same', defId: 'green_louse', row: 0, isBoss: false,
      hp: 10, maxHp: 10, block: 0, dead: false, abilityUsed: true },
    { ...enemyTemplate, uid: 'online-whirlwind-other', defId: 'red_louse', row: 1, isBoss: false,
      hp: 10, maxHp: 10, block: 0, dead: false },
    { ...enemyTemplate, uid: 'online-whirlwind-boss', defId: 'gremlin_nob', row: 1, isBoss: true,
      hp: 10, maxHp: 10, block: 0, dead: false },
  ]
  const publishWhirlwindFixture = await fetch(`${roomOrigin}/api/rooms/${code}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-room-token': previewCredentials.token },
    body: JSON.stringify({ action: { kind: 'spendMiracle' } }),
  })
  assert(publishWhirlwindFixture.ok, 'could not publish the online Whirlwind fixture')
  await a.getByRole('button', { name: /^Whirlwind\+,/ }).click()
  await a.getByText('Choose Energy for Whirlwind+').waitFor()
  const teammateEnergyPrompts = await b.getByText('Choose Energy for Whirlwind+').count()
  await a.getByRole('button', { name: 'Spend 2' }).click()
  await a.locator('.enemy--targeted').first().waitFor()
  let submittedWhirlwindEnergy
  await a.route(`**/api/rooms/${code}/action`, async (route) => {
    submittedWhirlwindEnergy = route.request().postDataJSON()?.action?.energySpent
    const response = await route.fetch()
    await route.fulfill({ response })
  }, { times: 1 })
  await a.getByRole('button', { name: /^Cultist,/ }).click()
  for (let attempt = 0; attempt < 50 &&
    liveRoom.run.combat.players.find((player) => player.name === 'Ann').energy !== 1; attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  const onlineWhirlwind = liveRoom.run.combat
  check('online Whirlwind keeps its X choice private and authoritative', () => {
    assertEqual(teammateEnergyPrompts, 0)
    assertEqual(submittedWhirlwindEnergy, 2)
    assertEqual(onlineWhirlwind.players.find((player) => player.name === 'Ann').energy, 1)
    assertDeepEqual(onlineWhirlwind.enemies.map((enemy) => enemy.hp), [7, 7, 10, 7])
  })
  await a.screenshot({ path: join(outDir, '02-whirlwind-x-resolved.png'), fullPage: true })

  annLive = liveRoom.run.combat.players.find((player) => player.name === 'Ann')
  const annBeforeTempest = structuredClone(annLive)
  Object.assign(annLive, {
    hand: [{ uid: 'online-tempest', defId: 'tempest', upgraded: true }],
    discard: [], draw: [], exhaust: [], energy: 3, orbs: [null, null, null],
  })
  boLive = liveRoom.run.combat.players.find((player) => player.name === 'Bo')
  boLive.miracles = 1
  const publishTempestFixture = await fetch(`${roomOrigin}/api/rooms/${code}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-room-token': previewCredentials.token },
    body: JSON.stringify({ action: { kind: 'spendMiracle' } }),
  })
  assert(publishTempestFixture.ok, 'could not publish the online Tempest fixture')
  const submittedTempestEnergies = []
  const tempestActionUrl = `**/api/rooms/${code}/action`
  await a.route(tempestActionUrl, async (route) => {
    const action = route.request().postDataJSON()?.action
    if (action?.kind === 'playCard' && action.cardUid === 'online-tempest') {
      submittedTempestEnergies.push(action.energySpent)
    }
    const response = await route.fetch()
    await route.fulfill({ response })
  })
  await a.getByRole('button', { name: /^Tempest\+,/ }).click()
  await a.getByText('Choose Energy for Tempest+').waitFor()
  const teammateTempestPrompts = await b.getByText('Choose Energy for Tempest+').count()
  await a.getByRole('button', { name: 'Spend 2' }).click()
  for (let attempt = 0; attempt < 50 &&
    !liveRoom.run.combat.players.find((player) => player.name === 'Ann').exhaust
      .some((card) => card.uid === 'online-tempest'); attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  await a.unroute(tempestActionUrl)
  const onlineTempest = liveRoom.run.combat.players.find((player) => player.name === 'Ann')
  check('online Tempest waits for its private X choice and submits once', () => {
    assertEqual(teammateTempestPrompts, 0)
    assertDeepEqual(submittedTempestEnergies, [2])
    assertEqual(onlineTempest.energy, 1)
    assertEqual(onlineTempest.orbs.filter(Boolean).length, 3)
    assert(onlineTempest.exhaust.some((card) => card.uid === 'online-tempest'))
  })
  await a.screenshot({ path: join(outDir, '02b-tempest-x-resolved.png'), fullPage: true })

  annLive = liveRoom.run.combat.players.find((player) => player.name === 'Ann')
  Object.assign(annLive, annBeforeTempest)
  boLive = liveRoom.run.combat.players.find((player) => player.name === 'Bo')
  Object.assign(annLive, {
    hand: [], powers: [{ uid: 'online-combust', defId: 'combust', upgraded: true }],
  })
  Object.assign(boLive, { ...boBeforeFinale, miracles: 1, energy: 2 })
  liveRoom.run.combat.powerTriggersUsedThisTurn = []
  for (const enemy of liveRoom.run.combat.enemies) {
    Object.assign(enemy, { hp: 10, maxHp: 10, block: 0, dead: false })
  }
  const publishCombustFixture = await fetch(`${roomOrigin}/api/rooms/${code}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-room-token': previewCredentials.token },
    body: JSON.stringify({ action: { kind: 'spendMiracle' } }),
  })
  assert(publishCombustFixture.ok, 'could not publish the online Combust fixture')
  await a.getByRole('button', { name: 'Use Combust+' }).waitFor()
  const foreignCombustControls = await b.getByRole('button', { name: 'Use Combust+' }).count()
  await a.getByRole('button', { name: 'Use Combust+' }).click()
  await a.getByText('Choose a row for Combust+').waitFor()
  let failedCombustRefreshes = 0
  const combustFailureStart = failures.length
  const combustRoomPattern = `**/api/rooms/${code}`
  await a.route(combustRoomPattern, (route) => {
    if (route.request().method() === 'GET' && failedCombustRefreshes < 3) {
      failedCombustRefreshes += 1
      return route.abort('connectionreset')
    }
    return route.continue()
  })
  await a.route(`**/api/rooms/${code}/action`, (route) => route.abort('connectionreset'), { times: 1 })
  await a.getByRole('button', { name: 'Target Row Ironclad' }).click()
  await a.getByText('Choose a row for Combust+').waitFor({ state: 'hidden' })
  await a.waitForFunction(() => [...document.querySelectorAll('.combat__actions button')]
    .some((button) => button.getAttribute('aria-label') === 'Use Combust+' && button.disabled))
  const lockedUnknownCombust = await a.getByRole('button', { name: 'Use Combust+' }).isDisabled()
  await a.getByText('Choose a row for Combust+').waitFor()
  await a.unroute(combustRoomPattern)
  const expectedCombustFailures = failures.splice(combustFailureStart)
  check('an unknown uncommitted Combust stays locked, then restages after an authoritative refresh', () => {
    assertEqual(failedCombustRefreshes, 3)
    assertEqual(expectedCombustFailures.length, 4)
    assert(expectedCombustFailures.every((failure) => failure.includes('ERR_CONNECTION_RESET')))
    assert(lockedUnknownCombust)
    assertEqual(liveRoom.run.combat.powerTriggersUsedThisTurn.includes(`${annLive.id}/power:online-combust`), false)
  })
  let submittedCombust
  await a.route(`**/api/rooms/${code}/action`, async (route) => {
    submittedCombust = route.request().postDataJSON()?.action
    const response = await route.fetch()
    await route.fulfill({ response })
  }, { times: 1 })
  await a.getByRole('button', { name: 'Target Row Ironclad' }).click()
  for (let attempt = 0; attempt < 50 &&
    !liveRoom.run.combat.powerTriggersUsedThisTurn.includes(`${annLive.id}/power:online-combust`); attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  const onlineCombust = liveRoom.run.combat
  check('online Combust is private to its owner and routes its row target authoritatively', () => {
    assertEqual(foreignCombustControls, 0)
    assertEqual(submittedCombust.kind, 'activatePower')
    assertEqual(submittedCombust.powerUid, 'online-combust')
    assertEqual(submittedCombust.enemyRow, 0)
    assertDeepEqual(onlineCombust.enemies.map((enemy) => enemy.hp), [8, 8, 10, 8])
  })
  await a.screenshot({ path: join(outDir, '02a-combust-resolved.png'), fullPage: true })

  liveRoom.run.combat.powerTriggersUsedThisTurn = []
  for (const enemy of liveRoom.run.combat.enemies) Object.assign(enemy, { hp: 10, block: 0, dead: false })
  const boForCombustRestage = liveRoom.run.combat.players.find((player) => player.name === 'Bo')
  boForCombustRestage.miracles = 1
  boForCombustRestage.energy = 2
  const publishCombustRestage = await fetch(`${roomOrigin}/api/rooms/${code}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-room-token': previewCredentials.token },
    body: JSON.stringify({ action: { kind: 'spendMiracle' } }),
  })
  assert(publishCombustRestage.ok, 'could not publish the Combust same-seat fixture')
  await a.getByRole('button', { name: 'Use Combust+' }).click()
  await a.getByText('Choose a row for Combust+').waitFor()
  const annCombustCredentials = await credentials(a)
  const sameSeatCombust = await fetch(`${roomOrigin}/api/rooms/${code}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-room-token': annCombustCredentials.token },
    body: JSON.stringify({ action: {
      kind: 'activatePower', powerUid: 'online-combust', enemyRow: 0, preflight: true,
    } }),
  })
  assert(sameSeatCombust.ok, 'could not activate Combust through the same seat')
  await a.getByText('Choose a row for Combust+').waitFor({ state: 'hidden' })
  const staleCombustRows = await a.getByRole('button', { name: /^Target Row/ }).count()
  check('a same-seat authoritative activation clears stale Combust targeting', () => {
    assertEqual(staleCombustRows, 0)
  })

  annLive = liveRoom.run.combat.players.find((player) => player.name === 'Ann')
  boLive = liveRoom.run.combat.players.find((player) => player.name === 'Bo')
  Object.assign(annLive, {
    hand: [
      { uid: 'online-fire-power', defId: 'fire_breathing', upgraded: true },
      { uid: 'online-fire-trance', defId: 'battle_trance', upgraded: false },
    ],
    draw: [
      { uid: 'online-fire-daze', defId: 'daze', upgraded: false },
      { uid: 'online-fire-curse', defId: 'clumsy', upgraded: false },
      { uid: 'online-fire-strike', defId: 'strike_ironclad', upgraded: false },
    ],
    discard: [], exhaust: [],
    powers: [{ uid: 'online-fire-combust', defId: 'combust', upgraded: true }],
    energy: 3, drawLocked: false,
  })
  Object.assign(boLive, { miracles: 1, energy: 2 })
  const fireTemplate = liveRoom.run.combat.enemies[0]
  liveRoom.run.combat.phase = 'player'
  liveRoom.run.combat.pendingCardCopy = undefined
  liveRoom.run.combat.pendingTriggers = []
  liveRoom.run.combat.powerTriggersUsedThisTurn = []
  liveRoom.run.combat.enemies = [
    { ...fireTemplate, uid: 'online-fire-left', defId: 'cultist', row: 0, isBoss: false,
      hp: 10, maxHp: 10, block: 0, dead: false },
    { ...fireTemplate, uid: 'online-fire-right', defId: 'cultist', row: 1, isBoss: false,
      hp: 10, maxHp: 10, block: 0, dead: false },
  ]
  const publishFireFixture = await fetch(`${roomOrigin}/api/rooms/${code}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-room-token': previewCredentials.token },
    body: JSON.stringify({ action: { kind: 'spendMiracle' } }),
  })
  assert(publishFireFixture.ok, 'could not publish the online Fire Breathing fixture')
  await a.getByRole('button', { name: /^Fire Breathing\+,/ }).click()
  await a.getByRole('button', { name: 'Use Combust+' }).click()
  await a.getByText('Choose a row for Combust+').waitFor()
  const fireOwnerCredentials = await credentials(a)
  const competingFireDraw = await fetch(`${roomOrigin}/api/rooms/${code}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-room-token': fireOwnerCredentials.token },
    body: JSON.stringify({ action: {
      kind: 'playCard', cardUid: 'online-fire-trance', preflight: true,
    } }),
  })
  assert(competingFireDraw.ok, 'could not publish the same-seat Fire Breathing draw')
  await a.getByText("Ann's Fire Breathing+ — choose a row").waitFor()
  const staleFireTargets = await a.getByRole('button', { name: /^Target Row/ }).count()
  check('a mandatory online trigger clears stale staged targeting', () => {
    assertEqual(staleFireTargets, 0)
  })
  await b.getByText('Waiting for Ann to resolve a triggered ability…').waitFor()
  const foreignFireRows = await b.getByRole('button', { name: /^Resolve .*Fire Breathing/ }).count()
  const boCredentials = await credentials(b)
  const firstOnlineFireTriggerId = liveRoom.run.combat.pendingTriggers[0].id
  const forgedFire = await fetch(`${roomOrigin}/api/rooms/${code}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-room-token': boCredentials.token },
    body: JSON.stringify({ action: {
      kind: 'resolveTrigger', triggerId: firstOnlineFireTriggerId,
      enemyRow: 1, preflight: true,
    } }),
  })
  let submittedFire
  await a.route(`**/api/rooms/${code}/action`, async (route) => {
    submittedFire = route.request().postDataJSON()?.action
    const response = await route.fetch()
    await route.fulfill({ response })
  }, { times: 1 })
  await a.getByRole('button', { name: /Fire Breathing\+ in Row Silent$/ }).click()
  for (let attempt = 0; attempt < 50 && liveRoom.run.combat.pendingTriggers.length !== 1; attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  check('online Fire Breathing keeps row choices private to its owner and server-authoritative', () => {
    assertEqual(foreignFireRows, 0)
    assertEqual(forgedFire.status, 409)
    assertEqual(submittedFire.kind, 'resolveTrigger')
    assertEqual(submittedFire.triggerId, firstOnlineFireTriggerId)
    assertEqual(submittedFire.enemyRow, 1)
    assertDeepEqual(liveRoom.run.combat.enemies.map((enemy) => enemy.hp), [10, 7])
  })
  await a.getByRole('button', { name: /Fire Breathing\+ in Row Ironclad$/ }).click()
  await a.getByText("Ann's Fire Breathing+ — choose a row").waitFor({ state: 'hidden' })
  check('online Fire Breathing resolves every qualifying draw before play resumes', () => {
    assertEqual(liveRoom.run.combat.pendingTriggers.length, 0)
    assertDeepEqual(liveRoom.run.combat.enemies.map((enemy) => enemy.hp), [7, 7])
    assert(liveRoom.run.combat.players.find((player) => player.name === 'Ann').drawLocked)
  })
  await a.screenshot({ path: join(outDir, '02b-fire-breathing-resolved.png'), fullPage: true })

  annLive = liveRoom.run.combat.players.find((player) => player.name === 'Ann')
  boLive = liveRoom.run.combat.players.find((player) => player.name === 'Bo')
  Object.assign(annLive, {
    hand: [
      { uid: 'online-double-tap', defId: 'double_tap', upgraded: true },
      { uid: 'online-double-strike', defId: 'strike_ironclad', upgraded: false },
    ],
    draw: [], discard: [], exhaust: [], powers: [], energy: 3,
    doubledAttacksThisTurn: 0, attacksPlayedThisTurn: 0,
  })
  Object.assign(boLive, { ...boBeforeFinale, miracles: 1, energy: 2 })
  const doubleTemplate = liveRoom.run.combat.enemies[0]
  liveRoom.run.combat.phase = 'player'
  liveRoom.run.combat.pendingCardCopy = undefined
  liveRoom.run.combat.enemies = [
    { ...doubleTemplate, uid: 'online-double-first', defId: 'cultist', row: 0, isBoss: false,
      hp: 6, maxHp: 6, block: 0, vulnerable: 1, dead: false },
    { ...doubleTemplate, uid: 'online-double-second', defId: 'red_louse', row: 1, isBoss: false,
      hp: 6, maxHp: 6, block: 0, vulnerable: 0, dead: false },
  ]
  const publishDoubleTapFixture = await fetch(`${roomOrigin}/api/rooms/${code}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-room-token': previewCredentials.token },
    body: JSON.stringify({ action: { kind: 'spendMiracle' } }),
  })
  assert(publishDoubleTapFixture.ok, 'could not publish the online Double Tap fixture')
  await a.locator('.hand').getByRole('button', { name: /^Double Tap\+,/ }).click()
  await a.locator('.hand').getByRole('button', { name: /^Strike,/ }).click()
  await a.getByText('Choose an enemy for Strike copy (Double Tap)').waitFor()
  await a.getByRole('button', { name: /^Cultist,/ }).click()
  await a.getByText('Choose an enemy for original Strike after Double Tap copy').waitFor()
  await b.getByRole('status').filter({
    hasText: 'Ann is resolving the original Strike after a Double Tap copy',
  }).waitFor()
  const pendingCopyLabels = await b.evaluate(async () => {
    const { pendingCardCopyLabel } = await import('/src/ui/OnlineGame.tsx')
    const pending = (sourceNames, card, virtualOnly = false) => ({
      playerId: 'p1', card, energySpent: 0, resumePhase: 'player', forcedExhaust: false,
      forcedChoices: null, deferredHavocs: [], sourceNames, virtualOnly,
    })
    return [
      pendingCardCopyLabel(pending(
        ['Foreign Influence'], { uid: 'foreign', defId: 'bash', upgraded: false }, true,
      )),
      pendingCardCopyLabel(pending(
        ['Omniscience', 'Omniscience'], { uid: 'omni', defId: 'strike_watcher', upgraded: false },
      )),
      pendingCardCopyLabel(pending(
        ['Blasphemy', 'Blasphemy'], { uid: 'blasphemy', defId: 'strike_watcher', upgraded: false },
      )),
      pendingCardCopyLabel(pending(
        ['Weave'], { uid: 'weave', defId: 'weave', upgraded: false, scryDamageBonus: 5 },
      )),
    ]
  })
  check('online teammate copy labels identify each Watcher source and resolution stage', () => {
    assertDeepEqual(pendingCopyLabels, [
      'a Bash copy (Foreign Influence)',
      'a Strike copy (Omniscience)',
      'a Strike copy (Blasphemy)',
      'Scry-played Weave',
    ])
  })
  const teammateLockedForCopy = await b.locator('.online-mutations').evaluate((table) => table.inert)
  await a.screenshot({ path: join(outDir, '02b-double-tap-copy-target.png'), fullPage: true })
  let failedCopyRefreshes = 0
  const copyFailureStart = failures.length
  const copyRoomPattern = `**/api/rooms/${code}`
  await a.route(copyRoomPattern, (route) => {
    if (route.request().method() === 'GET' && failedCopyRefreshes < 3) {
      failedCopyRefreshes += 1
      return route.abort('connectionreset')
    }
    return route.continue()
  })
  await a.route(`**/api/rooms/${code}/action`, (route) => route.abort('connectionreset'), { times: 1 })
  await a.getByRole('button', { name: /^Red Louse,/ }).click()
  await a.getByText('Choose an enemy for original Strike after Double Tap copy').waitFor({ state: 'hidden' })
  for (let attempt = 0; attempt < 50 && failedCopyRefreshes < 3; attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  await a.waitForTimeout(0)
  const staleUnknownCopyPrompt = await a.getByText('Choose an enemy for original Strike after Double Tap copy').count()
  await a.getByText('Choose an enemy for original Strike after Double Tap copy').waitFor()
  await a.unroute(copyRoomPattern)
  const expectedCopyFailures = failures.splice(copyFailureStart)
  check('an unknown uncommitted Double Tap copy stays locked until an authoritative refresh', () => {
    assertEqual(failedCopyRefreshes, 3, 'reconciliation refresh failures')
    assertEqual(expectedCopyFailures.length, 4, 'action plus refresh request failures')
    assert(expectedCopyFailures.every((failure) => failure.includes('ERR_CONNECTION_RESET')),
      `unexpected failure: ${expectedCopyFailures.join('; ')}`)
    assertEqual(staleUnknownCopyPrompt, 0, 'copy prompt before authoritative refresh')
    assertEqual(liveRoom.run.combat.pendingCardCopy?.card.uid, 'online-double-strike', 'authoritative copy')
  })
  let submittedCopy
  await a.route(`**/api/rooms/${code}/action`, async (route) => {
    submittedCopy = route.request().postDataJSON()?.action
    const response = await route.fetch()
    await route.fulfill({ response })
  }, { times: 1 })
  await a.getByRole('button', { name: /^Red Louse,/ }).click()
  for (let attempt = 0; attempt < 50 && liveRoom.run.combat.phase !== 'player'; attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  check('online Double Tap locks teammates and submits the copy target authoritatively', () => {
    assert(teammateLockedForCopy)
    assertEqual(submittedCopy.kind, 'playCardCopy')
    assertEqual(submittedCopy.enemyUid, 'online-double-second')
    assertDeepEqual(liveRoom.run.combat.enemies.map((enemy) => enemy.hp), [4, 5])
    assertEqual(liveRoom.run.combat.players.find((player) => player.name === 'Ann').attacksPlayedThisTurn, 2)
  })
  await a.screenshot({ path: join(outDir, '02c-double-tap-resolved.png'), fullPage: true })

  annLive = liveRoom.run.combat.players.find((player) => player.name === 'Ann')
  boLive = liveRoom.run.combat.players.find((player) => player.name === 'Bo')
  Object.assign(annLive, {
    character: 'ironclad',
    hand: [{ uid: 'online-havoc-race', defId: 'havoc', upgraded: true }],
    draw: [{ uid: 'online-havoc-race-defend', defId: 'defend_ironclad', upgraded: false }],
    discard: [], exhaust: [], powers: [], energy: 0, drawLocked: false, cardPlayLocked: false,
    cardsPlayedThisTurn: 0, attacksPlayedThisTurn: 0,
  })
  Object.assign(boLive, { ...boBeforeFinale, miracles: 1, energy: 2 })
  Object.assign(liveRoom.run.combat, {
    phase: 'player', startTurnProgress: undefined, pendingCardCopy: undefined, pendingTriggers: [],
  })
  const havocRaceEnemies = structuredClone(liveRoom.run.combat.enemies)
  liveRoom.run.combat.enemies = [{ ...liveRoom.run.combat.enemies[0], uid: 'online-havoc-race-target',
    hp: 6, maxHp: 6, block: 0, weak: 0, vulnerable: 0, poison: 0, dead: false }]
  const publishHavocRace = await fetch(`${roomOrigin}/api/rooms/${code}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-room-token': previewCredentials.token },
    body: JSON.stringify({ action: { kind: 'spendMiracle' } }),
  })
  assert(publishHavocRace.ok, 'could not publish the online Havoc race fixture')
  let havocRequestStartedWhileLocked = false
  await a.route(`**/api/rooms/${code}/action`, async (route) => {
    await a.waitForFunction(() => document.querySelector('.hand [aria-label^="Havoc+,"]')
      ?.getAttribute('aria-disabled') === 'true')
    havocRequestStartedWhileLocked = true
    const response = await route.fetch()
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500))
    await route.fulfill({ response })
  }, { times: 1 })
  await a.getByRole('button', { name: /^Havoc\+, cost 0,/ }).click()
  for (let attempt = 0; attempt < 50 && !liveRoom.run.combat.players.find((player) => player.name === 'Ann')
    .exhaust.some((card) => card.uid === 'online-havoc-race-defend'); attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  check('online Havoc stages its forced card after the originating request unlocks', () => {
    const ann = liveRoom.run.combat.players.find((player) => player.name === 'Ann')
    assert(havocRequestStartedWhileLocked, 'the Havoc request started before the card action locked')
    assert(ann.exhaust.some((card) => card.uid === 'online-havoc-race-defend'),
      `forced Defend did not exhaust: ${JSON.stringify(ann)}`)
    assertEqual(liveRoom.run.combat.startTurnProgress, undefined, 'forced progress remained')
  })
  annLive = liveRoom.run.combat.players.find((player) => player.name === 'Ann')
  Object.assign(annLive, {
    hand: [{ uid: 'online-refused-forced-defend', defId: 'defend_ironclad', upgraded: false }],
    discard: [], draw: [], exhaust: [], energy: 0,
  })
  liveRoom.run.combat.startTurnProgress = { choices: [], forcedCard: {
    playerId: annLive.id, cardUid: 'online-refused-forced-defend', sourceCardId: 'havoc', exhaustNonPower: true,
  } }
  let refusedForcedAttempts = 0
  const refusedForcedFailureStart = failures.length
  const refusedForcedRoute = async (route) => {
    refusedForcedAttempts += 1
    await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'test refusal' }) })
  }
  await a.route(`**/api/rooms/${code}/action`, refusedForcedRoute)
  liveRoom.version += 1
  rooms.publishRoom(code)
  await a.waitForFunction(() => document.querySelector('.hand [aria-label^="Defend,"]'))
  await a.waitForTimeout(750)
  const refusedForcedConflict = failures.findIndex((failure, index) =>
    index >= refusedForcedFailureStart && failure.includes('409 (Conflict)'))
  await a.unroute(`**/api/rooms/${code}/action`, refusedForcedRoute)
  await a.getByRole('button', { name: /^Defend, cost 0,/ }).click()
  for (let attempt = 0; attempt < 50 && liveRoom.run.combat.startTurnProgress?.forcedCard; attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  check('a refused forced-card auto-stage attempts once and remains manually retryable', () => {
    assertEqual(refusedForcedAttempts, 1)
    assert(refusedForcedConflict >= refusedForcedFailureStart, 'the forced-card refusal did not surface as a conflict')
    assertEqual(liveRoom.run.combat.startTurnProgress?.forcedCard, undefined)
    assert(liveRoom.run.combat.players.find((player) => player.name === 'Ann').exhaust
      .some((card) => card.uid === 'online-refused-forced-defend'))
  })
  failures.splice(refusedForcedConflict, 1)

  annLive = liveRoom.run.combat.players.find((player) => player.name === 'Ann')
  Object.assign(annLive, {
    hand: [{ uid: 'online-reconnect-forced-defend', defId: 'defend_ironclad', upgraded: false }],
    discard: [], draw: [], exhaust: [], energy: 0,
  })
  liveRoom.run.combat.startTurnProgress = { choices: [], forcedCard: {
    playerId: annLive.id, cardUid: 'online-reconnect-forced-defend', sourceCardId: 'havoc', exhaustNonPower: true,
  } }
  const reconnectForcedFailureStart = failures.length
  await a.route(`**/api/rooms/${code}/action`, async (route) => {
    await a.evaluate(() => window.__ROOM_SOCKETS__.at(-1)?.close(4000, 'forced card reconnect'))
    await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'test disconnect' }) })
  }, { times: 1 })
  liveRoom.version += 1
  rooms.publishRoom(code)
  await a.locator('.connection--reconnecting').waitFor()
  await a.locator('.connection--connected').waitFor()
  for (let attempt = 0; attempt < 50 && liveRoom.run.combat.startTurnProgress?.forcedCard; attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  const reconnectForcedConflict = failures.findIndex((failure, index) =>
    index >= reconnectForcedFailureStart && failure.includes('409 (Conflict)'))
  check('a forced-card auto-stage retries after reconnect', () => {
    assert(reconnectForcedConflict >= reconnectForcedFailureStart, 'the disconnect fixture did not refuse its first attempt')
    assertEqual(liveRoom.run.combat.startTurnProgress?.forcedCard, undefined)
    assert(liveRoom.run.combat.players.find((player) => player.name === 'Ann').exhaust
      .some((card) => card.uid === 'online-reconnect-forced-defend'))
  })
  if (reconnectForcedConflict >= reconnectForcedFailureStart) failures.splice(reconnectForcedConflict, 1)
  liveRoom.run.combat.enemies = havocRaceEnemies

  annLive = liveRoom.run.combat.players.find((player) => player.name === 'Ann')
  boLive = liveRoom.run.combat.players.find((player) => player.name === 'Bo')
  Object.assign(annLive, {
    character: 'defect',
    hand: [{ uid: 'online-copy-multi-cast', defId: 'multi_cast', upgraded: false }],
    discard: [], draw: [], exhaust: [], powers: [], energy: 2, block: 0,
    orbs: ['frost', 'frost', null], doubledCardsThisTurn: 1,
  })
  Object.assign(boLive, { ...boBeforeFinale, miracles: 1, energy: 2 })
  liveRoom.run.combat.phase = 'player'
  liveRoom.run.combat.pendingCardCopy = undefined
  const publishMultiCastCopy = await fetch(`${roomOrigin}/api/rooms/${code}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-room-token': previewCredentials.token },
    body: JSON.stringify({ action: { kind: 'spendMiracle' } }),
  })
  assert(publishMultiCastCopy.ok, 'could not publish the copied Multi-Cast fixture')
  await a.getByRole('button', { name: /^Multi-Cast, cost X,/ }).click()
  await a.getByText('Choose Energy for Multi-Cast').waitFor()
  await a.getByRole('button', { name: 'Spend 2' }).click()
  await a.getByRole('button', { name: /frost slot 1/i }).click()
  await a.getByText('Choose Orb to evoke 1').waitFor()
  let multiCastCopyRefusalStatus = 0
  await a.route(`**/api/rooms/${code}/action`, async (route) => {
    const body = route.request().postDataJSON()
    body.action.evokeSlots = []
    body.action.evokeEnemyUids = []
    const response = await route.fetch({ postData: JSON.stringify(body) })
    multiCastCopyRefusalStatus = response.status()
    await route.fulfill({ response })
  }, { times: 1 })
  await a.getByRole('button', { name: /frost slot 2/i }).click()
  for (let attempt = 0; attempt < 50 && multiCastCopyRefusalStatus === 0; attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  assertEqual(multiCastCopyRefusalStatus, 409, 'the forged Multi-Cast copy did not reach refusal')
  await a.getByText('Choose Orb to evoke 1').waitFor()
  const multiCastCopyConflict = failures.findIndex((failure) => failure.includes('409 (Conflict)'))
  assert(multiCastCopyConflict >= 0, 'the refused Multi-Cast copy did not surface as an HTTP conflict')
  failures.splice(multiCastCopyConflict, 1)
  await a.getByRole('button', { name: /frost slot 2/i }).click()
  for (let attempt = 0; attempt < 50 && liveRoom.run.combat.phase !== 'player'; attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  check('a refused X-cost Multi-Cast copy restores its authoritative Orb picker', () => {
    const ann = liveRoom.run.combat.players.find((player) => player.name === 'Ann')
    assertEqual(ann.block, 4)
    assertDeepEqual(ann.orbs, [null, null, null])
    assertEqual(liveRoom.run.combat.pendingCardCopy, undefined)
  })

  annLive = liveRoom.run.combat.players.find((player) => player.name === 'Ann')
  boLive = liveRoom.run.combat.players.find((player) => player.name === 'Bo')
  Object.assign(annLive, {
    character: 'defect',
    hand: [{ uid: 'online-seek', defId: 'seek', upgraded: true }],
    draw: [
      { uid: 'online-seek-strike', defId: 'strike_defect', upgraded: false },
      { uid: 'online-seek-defend', defId: 'defend_defect', upgraded: false },
      { uid: 'online-seek-zap', defId: 'zap', upgraded: false },
    ],
    discard: [], exhaust: [], powers: [], energy: 0, doubledCardsThisTurn: 0,
  })
  Object.assign(boLive, { ...boBeforeFinale, miracles: 1, energy: 2 })
  const publishSeek = await fetch(`${roomOrigin}/api/rooms/${code}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-room-token': previewCredentials.token },
    body: JSON.stringify({ action: { kind: 'spendMiracle' } }),
  })
  assert(publishSeek.ok, 'could not publish the online Seek fixture')
  await a.getByRole('button', { name: /^Seek\+, cost 0,/ }).click()
  const seekDialog = a.getByRole('dialog', { name: 'Choose 2 from your draw pile' })
  await seekDialog.waitFor()
  const teammateSeekDialog = await b.getByRole('dialog', { name: 'Choose 2 from your draw pile' }).count()
  await seekDialog.getByRole('button', { name: /^Strike,/ }).click()
  await seekDialog.getByRole('button', { name: /^Zap,/ }).click()
  let submittedSeek
  await a.route(`**/api/rooms/${code}/action`, async (route) => {
    submittedSeek = route.request().postDataJSON()?.action
    const response = await route.fetch()
    await route.fulfill({ response })
  }, { times: 1 })
  await seekDialog.getByRole('button', { name: 'Put selected cards in hand and shuffle' }).click()
  await seekDialog.waitFor({ state: 'hidden' })
  check('online Seek keeps its draw search private and submits only chosen ids', () => {
    const ann = liveRoom.run.combat.players.find((player) => player.name === 'Ann')
    assertEqual(teammateSeekDialog, 0)
    assertDeepEqual(submittedSeek.searchDrawUids, ['online-seek-strike', 'online-seek-zap'])
    assertDeepEqual(ann.hand.map((card) => card.uid), ['online-seek-strike', 'online-seek-zap'])
    assertDeepEqual(ann.draw.map((card) => card.uid), ['online-seek-defend'])
    assert(ann.exhaust.some((card) => card.uid === 'online-seek'))
  })

  annLive = liveRoom.run.combat.players.find((player) => player.name === 'Ann')
  boLive = liveRoom.run.combat.players.find((player) => player.name === 'Bo')
  Object.assign(annLive, {
    hand: [
      { uid: 'online-copy-preview-tap', defId: 'double_tap', upgraded: true },
      { uid: 'online-copy-preview-dagger', defId: 'dagger_throw', upgraded: false },
      { uid: 'online-copy-preview-held', defId: 'bash', upgraded: false },
    ],
    draw: [
      { uid: 'online-copy-preview-first', defId: 'neutralize', upgraded: false },
      { uid: 'online-copy-preview-second', defId: 'survivor', upgraded: false },
    ],
    discard: [], exhaust: [], energy: 3, drawLocked: false,
    doubledAttacksThisTurn: 0, attacksPlayedThisTurn: 0,
  })
  Object.assign(boLive, { ...boBeforeFinale, miracles: 1, energy: 2 })
  for (const enemy of liveRoom.run.combat.enemies) {
    Object.assign(enemy, { hp: 10, maxHp: 10, block: 0, vulnerable: 0, dead: false })
  }
  const publishCopyPreviewFixture = await fetch(`${roomOrigin}/api/rooms/${code}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-room-token': previewCredentials.token },
    body: JSON.stringify({ action: { kind: 'spendMiracle' } }),
  })
  assert(publishCopyPreviewFixture.ok, 'could not publish the copied Dagger Throw fixture')
  await a.getByRole('button', { name: /^Double Tap\+,/ }).click()
  await a.getByRole('button', { name: /^Dagger Throw,/ }).click()
  await a.getByRole('button', { name: /^Cultist,/ }).click()
  const firstCopyDiscard = a.getByRole('dialog', { name: 'Choose 1 to discard' })
  await firstCopyDiscard.getByRole('button', { name: /^Neutralize,/ }).click()
  await firstCopyDiscard.getByRole('button', { name: 'Discard selected card' }).click()
  await a.getByText('Choose an enemy for original Dagger Throw after Double Tap copy').waitFor()
  await a.getByRole('button', { name: /^Red Louse,/ }).click()
  const repeatedCopyDiscard = a.getByRole('dialog', { name: 'Choose 1 to discard' })
  await repeatedCopyDiscard.getByRole('button', { name: /^Survivor,/ }).click()
  let copiedDaggerRefusalStatus = 0
  await a.route(`**/api/rooms/${code}/action`, async (route) => {
    const body = route.request().postDataJSON()
    body.action.discardUids = ['not-in-the-copy-preview']
    const response = await route.fetch({ postData: JSON.stringify(body) })
    copiedDaggerRefusalStatus = response.status()
    await route.fulfill({ response })
  }, { times: 1 })
  await repeatedCopyDiscard.getByRole('button', { name: 'Discard selected card' }).click()
  for (let attempt = 0; attempt < 50 && copiedDaggerRefusalStatus === 0; attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  assertEqual(copiedDaggerRefusalStatus, 409, 'the forged copied Dagger Throw did not reach refusal')
  await repeatedCopyDiscard.getByText(/^0\/1 selected/).waitFor()
  const recoveredCopyPreview = await snapshot(a)
  await repeatedCopyDiscard.getByRole('button', { name: /^Survivor,/ }).click()
  await repeatedCopyDiscard.getByRole('button', { name: 'Discard selected card' }).click()
  await repeatedCopyDiscard.waitFor({ state: 'hidden' })
  const copiedDaggerConflict = failures.findIndex((failure) => failure.includes('409 (Conflict)'))
  assert(copiedDaggerConflict >= 0, 'the refused copied Dagger Throw did not surface as an HTTP conflict')
  failures.splice(copiedDaggerConflict, 1)
  check('a refused copied Dagger Throw restores its private copy preview', () => {
    assertEqual(recoveredCopyPreview.cardPreview?.copy, true)
    assertDeepEqual(recoveredCopyPreview.cardPreview?.cards.map((card) => card.uid),
      ['online-copy-preview-held', 'online-copy-preview-second'])
    assertEqual(liveRoom.run.combat.phase, 'player')
    assertDeepEqual(liveRoom.run.combat.enemies.map((enemy) => enemy.hp), [8, 8])
  })

  annLive = liveRoom.run.combat.players.find((player) => player.name === 'Ann')
  boLive = liveRoom.run.combat.players.find((player) => player.name === 'Bo')
  Object.assign(annLive, {
    hand: [{ uid: 'online-headbutt', defId: 'headbutt', upgraded: true }],
    powers: [],
    discard: [
      { uid: 'online-headbutt-defend', defId: 'defend_ironclad', upgraded: false },
      { uid: 'online-headbutt-bash', defId: 'bash', upgraded: false },
    ],
    draw: [], energy: 1,
  })
  Object.assign(boLive, { ...boBeforeFinale, miracles: 1, energy: 2 })
  for (const enemy of liveRoom.run.combat.enemies) {
    Object.assign(enemy, { hp: 10, maxHp: 10, block: 0, dead: false })
  }
  const publishHeadbuttFixture = await fetch(`${roomOrigin}/api/rooms/${code}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-room-token': previewCredentials.token },
    body: JSON.stringify({ action: { kind: 'spendMiracle' } }),
  })
  assert(publishHeadbuttFixture.ok, 'could not publish the online Headbutt fixture')
  await a.getByRole('button', { name: /^Headbutt\+,/ }).click()
  const onlineHeadbutt = a.getByRole('dialog', { name: 'Choose 1 card from your discard pile' })
  await onlineHeadbutt.waitFor()
  await onlineHeadbutt.getByRole('button', { name: /^Bash,/ }).click()
  await onlineHeadbutt.getByRole('button', { name: 'Put selected card on top' }).click()
  await a.locator('.enemy--targeted').first().waitFor()
  liveRoom.run.combat.players.find((player) => player.name === 'Ann').discard = [
    { uid: 'online-headbutt-new-strike', defId: 'strike_ironclad', upgraded: false },
  ]
  liveRoom.version += 1
  let headbuttRefusalStatus = 0
  await a.route(`**/api/rooms/${code}/action`, async (route) => {
    const response = await route.fetch()
    headbuttRefusalStatus = response.status()
    await route.fulfill({ response })
  }, { times: 1 })
  await a.locator('.enemy--targeted').first().click()
  for (let attempt = 0; attempt < 50 && headbuttRefusalStatus === 0; attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  assertEqual(headbuttRefusalStatus, 409, 'the stale Headbutt did not reach the room refusal path')
  await onlineHeadbutt.waitFor()
  await onlineHeadbutt.getByText(/^0\/1 selected from discard/).waitFor()
  const staleHeadbuttChoice = await onlineHeadbutt.getByRole('button', { name: /^Bash,/ }).count()
  await onlineHeadbutt.getByRole('button', { name: /^Strike,/ }).click()
  await onlineHeadbutt.getByRole('button', { name: 'Put selected card on top' }).click()
  await a.locator('.prompt').filter({ hasText: 'Choose an enemy' }).waitFor()
  await a.locator('.enemy--targeted').first().click()
  for (let attempt = 0; attempt < 50 &&
    liveRoom.run.combat.players.find((player) => player.name === 'Ann').draw[0]?.uid !==
      'online-headbutt-new-strike'; attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  await onlineHeadbutt.waitFor({ state: 'hidden' })
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  const expectedHeadbuttConflict = failures.findIndex((failure) => failure.includes('409 (Conflict)'))
  assert(expectedHeadbuttConflict >= 0, 'the refused Headbutt did not surface as an HTTP conflict')
  failures.splice(expectedHeadbuttConflict, 1)
  check('a refused online Headbutt rebuilds its public choice from authoritative discard', () => {
    assertEqual(headbuttRefusalStatus, 409)
    assertEqual(staleHeadbuttChoice, 0)
    const ann = liveRoom.run.combat.players.find((player) => player.name === 'Ann')
    assertEqual(ann.draw[0].uid, 'online-headbutt-new-strike')
    assert(liveRoom.run.combat.enemies.some((enemy) => enemy.hp === 7),
      'the corrected Headbutt did not hit its chosen enemy')
  })

  annLive = liveRoom.run.combat.players.find((player) => player.name === 'Ann')
  boLive = liveRoom.run.combat.players.find((player) => player.name === 'Bo')
  Object.assign(annLive, {
    character: 'watcher', stance: 'wrath',
    hand: [{ uid: 'online-meditate', defId: 'meditate', upgraded: true }],
    discard: [
      { uid: 'online-meditate-old-first', defId: 'perseverance', upgraded: false },
      { uid: 'online-meditate-old-second', defId: 'windmill_strike', upgraded: false },
    ],
    draw: [], exhaust: [], powers: [], energy: 1, cardPlayLocked: false,
  })
  Object.assign(boLive, { ...boBeforeFinale, miracles: 1, energy: 2 })
  const publishMeditateFixture = await fetch(`${roomOrigin}/api/rooms/${code}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-room-token': previewCredentials.token },
    body: JSON.stringify({ action: { kind: 'spendMiracle' } }),
  })
  assert(publishMeditateFixture.ok, 'could not publish the online Meditate fixture')
  await a.getByRole('button', { name: /^Meditate\+,/ }).click()
  const onlineMeditate = a.getByRole('dialog', { name: 'Choose 2 cards from your discard pile' })
  await onlineMeditate.waitFor()
  await onlineMeditate.getByRole('button', { name: /^Perseverance,/ }).click()
  await onlineMeditate.getByRole('button', { name: /^Windmill Strike,/ }).click()
  const currentAnn = liveRoom.run.combat.players.find((player) => player.name === 'Ann')
  currentAnn.discard = [
    { uid: 'online-meditate-new-first', defId: 'defend_watcher', upgraded: false },
    { uid: 'online-meditate-new-second', defId: 'strike_watcher', upgraded: false },
    { uid: 'online-meditate-left-behind', defId: 'empty_body', upgraded: false },
  ]
  liveRoom.version += 1
  let meditateRefusalStatus = 0
  await a.route(`**/api/rooms/${code}/action`, async (route) => {
    const response = await route.fetch()
    meditateRefusalStatus = response.status()
    await route.fulfill({ response })
  }, { times: 1 })
  await onlineMeditate.getByRole('button', { name: 'Return selected cards to hand' }).click()
  for (let attempt = 0; attempt < 50 && meditateRefusalStatus === 0; attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  assertEqual(meditateRefusalStatus, 409, 'the stale Meditate did not reach the room refusal path')
  await onlineMeditate.waitFor()
  await onlineMeditate.getByText(/^0\/2 selected from discard/).waitFor()
  const staleMeditateChoice = await onlineMeditate.getByRole('button', { name: /^Perseverance,/ }).count()
  await onlineMeditate.getByRole('button', { name: /^Defend,/ }).click()
  await onlineMeditate.getByRole('button', { name: /^Strike,/ }).click()
  await onlineMeditate.getByRole('button', { name: 'Return selected cards to hand' }).click()
  await onlineMeditate.waitFor({ state: 'hidden' })
  const expectedMeditateConflict = failures.findIndex((failure) => failure.includes('409 (Conflict)'))
  assert(expectedMeditateConflict >= 0, 'the refused Meditate did not surface as an HTTP conflict')
  failures.splice(expectedMeditateConflict, 1)
  const teammateAfterMeditate = await snapshot(b)
  check('a refused Meditate+ restores both mandatory recoveries and keeps the new hand private', () => {
    assertEqual(staleMeditateChoice, 0)
    const ann = liveRoom.run.combat.players.find((player) => player.name === 'Ann')
    assertDeepEqual(ann.hand.map((card) => card.uid),
      ['online-meditate-new-first', 'online-meditate-new-second'])
    assert(ann.hand.every((card) => card.retainThisTurn === true))
    assert(ann.discard.some((card) => card.uid === 'online-meditate-left-behind'))
    const teammateJson = JSON.stringify(teammateAfterMeditate)
    assert(!teammateJson.includes('online-meditate-new-first') &&
      !teammateJson.includes('online-meditate-new-second'),
    'Meditate leaked recovered hand identities to a teammate')
  })

  annLive = liveRoom.run.combat.players.find((player) => player.name === 'Ann')
  boLive = liveRoom.run.combat.players.find((player) => player.name === 'Bo')
  Object.assign(annLive, {
    hand: [{ uid: 'online-exhume', defId: 'exhume', upgraded: true }],
    exhaust: [
      { uid: 'online-exhume-defend', defId: 'defend_ironclad', upgraded: false },
      { uid: 'online-exhume-bash', defId: 'bash', upgraded: false },
    ],
    energy: 0, cardPlayLocked: false,
  })
  boLive.miracles = 1
  const publishExhumeFixture = await fetch(`${roomOrigin}/api/rooms/${code}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-room-token': previewCredentials.token },
    body: JSON.stringify({ action: { kind: 'spendMiracle' } }),
  })
  assert(publishExhumeFixture.ok, 'could not publish the online Exhume fixture')
  let prematureExhumeActions = 0
  const countPrematureExhume = (request) => {
    if (request.method() === 'POST' && request.url().endsWith(`/api/rooms/${code}/action`)) {
      prematureExhumeActions += 1
    }
  }
  a.on('request', countPrematureExhume)
  await a.getByRole('button', { name: /^Exhume\+,/ }).click()
  const onlineExhume = a.getByRole('dialog', { name: 'Choose a card from your Exhaust pile' })
  await onlineExhume.waitFor()
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  a.off('request', countPrematureExhume)
  assertEqual(prematureExhumeActions, 0, 'opening Exhume submitted before its public choice')
  await onlineExhume.getByRole('button', { name: /^Bash,/ }).click()
  liveRoom.run.combat.players.find((player) => player.name === 'Ann').exhaust = [
    { uid: 'online-exhume-new-strike', defId: 'strike_ironclad', upgraded: false },
  ]
  liveRoom.version += 1
  let exhumeRefusalStatus = 0
  await a.route(`**/api/rooms/${code}/action`, async (route) => {
    const response = await route.fetch()
    exhumeRefusalStatus = response.status()
    await route.fulfill({ response })
  }, { times: 1 })
  await onlineExhume.getByRole('button', { name: 'Return selected card to hand' }).click()
  for (let attempt = 0; attempt < 50 && exhumeRefusalStatus === 0; attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  assertEqual(exhumeRefusalStatus, 409, 'the stale Exhume did not reach the room refusal path')
  await onlineExhume.waitFor()
  await onlineExhume.getByText(/^0\/1 selected from Exhaust/).waitFor()
  const staleExhumeChoice = await onlineExhume.getByRole('button', { name: /^Bash,/ }).count()
  await onlineExhume.getByRole('button', { name: /^Strike,/ }).click()
  await onlineExhume.getByRole('button', { name: 'Return selected card to hand' }).click()
  for (let attempt = 0; attempt < 50 &&
    liveRoom.run.combat.players.find((player) => player.name === 'Ann').hand[0]?.uid !==
      'online-exhume-new-strike'; attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  await onlineExhume.waitFor({ state: 'hidden' })
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  const expectedExhumeConflicts = failures
    .map((failure, index) => failure.includes('409 (Conflict)') ? index : -1)
    .filter((index) => index >= 0)
  assertEqual(expectedExhumeConflicts.length, 1, 'the refused Exhume surfaced an unexpected number of conflicts')
  for (const index of expectedExhumeConflicts.reverse()) failures.splice(index, 1)
  check('a refused online Exhume rebuilds its public choice from authoritative Exhaust', () => {
    assertEqual(exhumeRefusalStatus, 409)
    assertEqual(staleExhumeChoice, 0)
    const ann = liveRoom.run.combat.players.find((player) => player.name === 'Ann')
    assertEqual(ann.hand[0].uid, 'online-exhume-new-strike')
    assertDeepEqual(ann.exhaust.map((card) => card.uid), ['online-exhume'])
  })

  annLive = liveRoom.run.combat.players.find((player) => player.name === 'Ann')
  boLive = liveRoom.run.combat.players.find((player) => player.name === 'Bo')
  Object.assign(annLive, {
    hand: [{ uid: 'online-empty-exhume', defId: 'exhume', upgraded: true }],
    exhaust: [{ uid: 'online-empty-exhume-bash', defId: 'bash', upgraded: false }],
    energy: 0,
  })
  boLive.miracles = 1
  const publishEmptyExhume = await fetch(`${roomOrigin}/api/rooms/${code}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-room-token': previewCredentials.token },
    body: JSON.stringify({ action: { kind: 'spendMiracle' } }),
  })
  assert(publishEmptyExhume.ok, 'could not publish the empty-pile Exhume fixture')
  const emptyExhumeCard = a.getByRole('button', { name: /^Exhume\+,/ })
  await emptyExhumeCard.click()
  await onlineExhume.waitFor()
  await onlineExhume.getByRole('button', { name: /^Bash,/ }).click()
  liveRoom.run.combat.players.find((player) => player.name === 'Ann').exhaust = []
  liveRoom.version += 1
  let emptyExhumeRefusalStatus = 0
  await a.route(`**/api/rooms/${code}/action`, async (route) => {
    const response = await route.fetch()
    emptyExhumeRefusalStatus = response.status()
    await route.fulfill({ response })
  }, { times: 1 })
  await onlineExhume.getByRole('button', { name: 'Return selected card to hand' }).click()
  for (let attempt = 0; attempt < 50 && emptyExhumeRefusalStatus === 0; attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  assertEqual(emptyExhumeRefusalStatus, 409, 'empty-pile Exhume did not reach refusal reconciliation')
  await onlineExhume.waitFor({ state: 'hidden' })
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  const expectedEmptyExhumeConflicts = failures
    .map((failure, index) => failure.includes('409 (Conflict)') ? index : -1)
    .filter((index) => index >= 0)
  assertEqual(expectedEmptyExhumeConflicts.length, 1,
    'empty-pile Exhume surfaced an unexpected number of conflicts')
  failures.splice(expectedEmptyExhumeConflicts[0], 1)
  const stagedEmptyExhume = await emptyExhumeCard.getAttribute('class')
  check('an online Exhume refusal clears staging when its Exhaust pile becomes empty', () => {
    assertEqual(stagedEmptyExhume.includes('card--selected'), false)
    const ann = liveRoom.run.combat.players.find((player) => player.name === 'Ann')
    assertDeepEqual(ann.hand.map((card) => card.uid), ['online-empty-exhume'])
    assertDeepEqual(ann.exhaust, [])
  })
  await emptyExhumeCard.click()
  for (let attempt = 0; attempt < 50 &&
    liveRoom.run.combat.players.find((player) => player.name === 'Ann').hand.length > 0; attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  assertDeepEqual(liveRoom.run.combat.players.find((player) => player.name === 'Ann').exhaust
    .map((card) => card.uid), ['online-empty-exhume'])
  // This suite deliberately drives one seat hard enough to exercise the real
  // limiter later; let this added refusal window expire before continuing.
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 10_100))

  annLive = liveRoom.run.combat.players.find((player) => player.name === 'Ann')
  boLive = liveRoom.run.combat.players.find((player) => player.name === 'Bo')
  Object.assign(boLive, boBeforeFinale)
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

  const annBeforeDagger = liveRoom.run.combat.players.find((player) => player.name === 'Ann')
  const boBeforeDagger = liveRoom.run.combat.players.find((player) => player.name === 'Bo')
  annBeforeDagger.hand = [
    { uid: 'online-dagger', defId: 'dagger_throw', upgraded: false },
    { uid: 'online-dagger-held', defId: 'defend_silent', upgraded: false },
    { uid: 'online-dagger-strike', defId: 'strike_silent', upgraded: false },
  ]
  annBeforeDagger.draw = [{ uid: 'online-dagger-drawn', defId: 'neutralize', upgraded: false }]
  annBeforeDagger.discard = []
  annBeforeDagger.energy = 3
  boBeforeDagger.miracles = 1
  for (const enemy of liveRoom.run.combat.enemies) {
    Object.assign(enemy, { hp: 10, maxHp: 10, block: 0, dead: false })
  }
  const publishDaggerFixture = await fetch(`${roomOrigin}/api/rooms/${code}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-room-token': previewCredentials.token },
    body: JSON.stringify({ action: { kind: 'spendMiracle' } }),
  })
  assert(publishDaggerFixture.ok, 'could not publish the online Dagger Throw fixture')
  await a.getByRole('button', { name: /^Dagger Throw,/ }).click()
  await a.locator('.enemy--targeted').first().click()
  const onlineDagger = a.getByRole('dialog', { name: 'Choose 1 to discard' })
  await onlineDagger.waitFor()
  const targetedDagger = await snapshot(a)
  const daggerTargetUid = targetedDagger.cardPreview?.enemyUid
  assert(typeof daggerTargetUid === 'string', 'Dagger Throw did not commit its target before revealing cards')
  await onlineDagger.getByRole('button', { name: /^Neutralize,/ }).click()
  let daggerRefusalStatus = 0
  await a.route(`**/api/rooms/${code}/action`, async (route) => {
    const body = JSON.parse(route.request().postData())
    body.action.discardUids = ['not-in-the-revealed-hand']
    const response = await route.fetch({ postData: JSON.stringify(body) })
    daggerRefusalStatus = response.status()
    await route.fulfill({ response })
  }, { times: 1 })
  await onlineDagger.getByRole('button', { name: 'Discard selected card' }).click()
  for (let attempt = 0; attempt < 50 && daggerRefusalStatus === 0; attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  assertEqual(daggerRefusalStatus, 409, 'the forged Dagger Throw did not reach the room refusal path')
  await onlineDagger.getByText(/^0\/1 selected/).waitFor()
  await onlineDagger.getByRole('button', { name: /^Neutralize,/ }).click()
  const recoveredDagger = await snapshot(a)
  await onlineDagger.getByRole('button', { name: 'Discard selected card' }).click()
  await onlineDagger.waitFor({ state: 'hidden' })
  const completedDagger = await snapshot(a)
  const expectedDaggerConflict = failures.findIndex((failure) => failure.includes('409 (Conflict)'))
  assert(expectedDaggerConflict >= 0, 'the refused Dagger Throw did not surface as an HTTP conflict')
  failures.splice(expectedDaggerConflict, 1)
  check('a refused Dagger Throw keeps its pre-reveal target while restoring the private choice', () => {
    assertEqual(daggerRefusalStatus, 409)
    assertEqual(recoveredDagger.cardPreview?.enemyUid, daggerTargetUid)
    assertEqual(completedDagger.run.combat.enemies.find((enemy) => enemy.uid === daggerTargetUid).hp, 8)
    const ann = completedDagger.run.combat.players.find((player) => player.id === completedDagger.you.playerId)
    assertDeepEqual(ann.hand.map((card) => card.uid), ['online-dagger-held', 'online-dagger-strike'])
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

  const annBeforeDodge = liveRoom.run.combat.players.find((player) => player.name === 'Ann')
  const boBeforeDodge = liveRoom.run.combat.players.find((player) => player.name === 'Bo')
  annBeforeDodge.hand.push({ uid: 'online-dodge-refusal', defId: 'dodge_and_roll', upgraded: false })
  Object.assign(annBeforeDodge, { energy: 3, block: 0 })
  Object.assign(boBeforeDodge, { miracles: 1, energy: 0, block: 0, dead: false })
  const publishDodgeFixture = await fetch(`${roomOrigin}/api/rooms/${code}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-room-token': bCredentials.token },
    body: JSON.stringify({ action: { kind: 'spendMiracle' } }),
  })
  assert(publishDodgeFixture.ok, 'could not publish the Dodge and Roll refusal fixture')
  await a.getByRole('button', { name: /^Dodge and Roll,/ }).click()
  await a.locator('button.seat').filter({ hasText: 'Ann' }).click()
  await a.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('2/2'))
  let dodgeRefusalStatus = 0
  await a.route(`**/api/rooms/${code}/action`, async (route) => {
    const body = JSON.parse(route.request().postData())
    body.action.playerIds = [body.action.playerIds[0], 'gone']
    const response = await route.fetch({ postData: JSON.stringify(body) })
    dodgeRefusalStatus = response.status()
    await route.fulfill({ response })
  }, { times: 1 })
  await a.locator('button.seat').filter({ hasText: 'Bo' }).click()
  await a.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('1/2'))
  const expectedDodgeConflict = failures.findIndex((failure) => failure.includes('409 (Conflict)'))
  assert(expectedDodgeConflict >= 0, 'the refused Dodge and Roll did not surface as an HTTP conflict')
  failures.splice(expectedDodgeConflict, 1)
  const refusedDodge = await snapshot(a)
  check('a refused online Dodge and Roll reopens independent player targeting', () => {
    const ann = refusedDodge.run.combat.players.find((player) => player.id === refusedDodge.you.playerId)
    assertEqual(dodgeRefusalStatus, 409)
    assert(ann.hand.some((card) => card.uid === 'online-dodge-refusal'))
  })
  await a.locator('button.seat').filter({ hasText: 'Ann' }).click()
  await a.locator('button.seat').filter({ hasText: 'Bo' }).click()
  await a.waitForFunction(() => ![...document.querySelectorAll('button')]
    .some((button) => button.getAttribute('aria-label')?.startsWith('Dodge and Roll,')))
  const completedDodge = await snapshot(a)
  check('the restored Dodge and Roll choice can complete', () => {
    const ann = completedDodge.run.combat.players.find((player) => player.name === 'Ann')
    const bo = completedDodge.run.combat.players.find((player) => player.name === 'Bo')
    assertEqual(ann.block, 1)
    assertEqual(bo.block, 1)
  })
  liveRoom.run.combat.players.forEach((player) => { player.block = 0 })

  const annBeforeStorm = liveRoom.run.combat.players.find((player) => player.name === 'Ann')
  const boBeforeStorm = liveRoom.run.combat.players.find((player) => player.name === 'Bo')
  const stormRestore = {
    ann: structuredClone({
      hand: annBeforeStorm.hand, discard: annBeforeStorm.discard, energy: annBeforeStorm.energy,
      shivs: annBeforeStorm.shivs, attacksPlayedThisTurn: annBeforeStorm.attacksPlayedThisTurn,
    }),
    bo: {
      energy: boBeforeStorm.energy, miracles: boBeforeStorm.miracles, shivs: boBeforeStorm.shivs,
      attacksPlayedThisTurn: boBeforeStorm.attacksPlayedThisTurn,
    },
    enemies: liveRoom.run.combat.enemies.map((enemy) => structuredClone(enemy)),
  }
  Object.assign(annBeforeStorm, {
    hand: [
      { uid: 'online-storm-race', defId: 'storm_of_steel', upgraded: true },
      { uid: 'online-storm-strike', defId: 'strike_silent', upgraded: false },
      { uid: 'online-storm-defend', defId: 'defend_silent', upgraded: false },
    ],
    energy: 3,
    shivs: 0,
    attacksPlayedThisTurn: 0,
  })
  Object.assign(boBeforeStorm, { energy: 0, miracles: 1, shivs: 5 })
  for (const enemy of liveRoom.run.combat.enemies) {
    Object.assign(enemy, { hp: 50, maxHp: 50, block: 0, dead: false, abilityUsed: true })
  }
  const publishStormFixture = await fetch(`${roomOrigin}/api/rooms/${code}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-room-token': bCredentials.token },
    body: JSON.stringify({ action: { kind: 'spendMiracle' } }),
  })
  assert(publishStormFixture.ok, 'could not publish the Storm of Steel supply-race fixture')
  await a.getByRole('button', { name: /^Storm of Steel\+,/ }).click()
  await a.getByRole('button', { name: /^Strike,/ }).click()
  await a.getByRole('button', { name: /^Defend,/ }).click()
  await a.getByRole('button', { name: 'Discard 2' }).click()
  await a.getByText('Choose overflow Shiv target 1/3, or skip the rest').waitFor()
  for (let spent = 0; spent < 3; spent += 1) {
    await b.getByRole('button', { name: 'Use Shiv' }).click()
    await b.locator('.enemy:not([disabled])').first().click()
  }
  await a.getByRole('button', { name: 'Discard 2' }).waitFor()
  await a.getByRole('button', { name: 'Discard 2' }).click()
  await a.waitForFunction(() => ![...document.querySelectorAll('button')]
    .some((button) => button.getAttribute('aria-label')?.startsWith('Storm of Steel+,')))
  const completedStormRace = await snapshot(a)
  check('Storm of Steel stays actionable when a teammate removes every overflow target', () => {
    const ann = completedStormRace.run.combat.players.find((player) => player.name === 'Ann')
    const bo = completedStormRace.run.combat.players.find((player) => player.name === 'Bo')
    assertEqual(ann.shivs, 3)
    assertEqual(bo.shivs, 2)
  })

  const annBeforeStormRefusal = liveRoom.run.combat.players.find((player) => player.name === 'Ann')
  const boBeforeStormRefusal = liveRoom.run.combat.players.find((player) => player.name === 'Bo')
  Object.assign(annBeforeStormRefusal, {
    hand: [
      { uid: 'online-storm-refusal', defId: 'storm_of_steel', upgraded: true },
      { uid: 'online-storm-refusal-strike', defId: 'strike_silent', upgraded: false },
      { uid: 'online-storm-refusal-defend', defId: 'defend_silent', upgraded: false },
    ],
    energy: 3,
    shivs: 0,
  })
  Object.assign(boBeforeStormRefusal, { energy: 0, miracles: 1, shivs: 5 })
  const publishStormRefusal = await fetch(`${roomOrigin}/api/rooms/${code}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-room-token': bCredentials.token },
    body: JSON.stringify({ action: { kind: 'spendMiracle' } }),
  })
  assert(publishStormRefusal.ok, 'could not publish the Storm refusal fixture')
  await a.getByRole('button', { name: /^Storm of Steel\+,/ }).click()
  await a.getByRole('button', { name: /^Strike,/ }).click()
  await a.getByRole('button', { name: /^Defend,/ }).click()
  await a.getByRole('button', { name: 'Discard 2' }).click()
  await a.getByText('Choose overflow Shiv target 1/3, or skip the rest').waitFor()
  let stormRefusalStatus = 0
  await a.route(`**/api/rooms/${code}/action`, async (route) => {
    liveRoom.run.combat.players.find((player) => player.name === 'Bo').shivs = 2
    const response = await route.fetch()
    stormRefusalStatus = response.status()
    await route.fulfill({ response })
  }, { times: 1 })
  await a.locator('.enemy:not([disabled])').first().click()
  await a.locator('.enemy:not([disabled])').first().click()
  await a.locator('.enemy:not([disabled])').first().click()
  await a.getByRole('button', { name: 'Discard 2' }).waitFor()
  const expectedStormConflict = failures.findIndex((failure) => failure.includes('409 (Conflict)'))
  assert(expectedStormConflict >= 0, 'the refused Storm did not surface as an HTTP conflict')
  failures.splice(expectedStormConflict, 1)
  assertEqual(stormRefusalStatus, 409)
  await a.getByRole('button', { name: 'Discard 2' }).click()
  await a.waitForFunction(() => ![...document.querySelectorAll('button')]
    .some((button) => button.getAttribute('aria-label')?.startsWith('Storm of Steel+,')))
  const completedStormRefusal = await snapshot(a)
  check('a refused Storm reopens confirmation when authoritative overflow becomes zero', () => {
    const ann = completedStormRefusal.run.combat.players.find((player) => player.name === 'Ann')
    assertEqual(ann.shivs, 3)
    assert(!ann.hand.some((card) => card.uid === 'online-storm-refusal'))
  })
  Object.assign(liveRoom.run.combat.players.find((player) => player.name === 'Ann'), stormRestore.ann)
  Object.assign(liveRoom.run.combat.players.find((player) => player.name === 'Bo'), stormRestore.bo)
  liveRoom.run.combat.enemies = stormRestore.enemies

  const annBeforePurity = liveRoom.run.combat.players.find((player) => player.name === 'Ann')
  const boBeforePurity = liveRoom.run.combat.players.find((player) => player.name === 'Bo')
  const purityRestore = structuredClone(liveRoom.run.combat)
  Object.assign(annBeforePurity, {
    hand: [
      { uid: 'online-purity-refusal', defId: 'purity', upgraded: true },
      { uid: 'online-purity-strike', defId: 'strike_silent', upgraded: false },
      { uid: 'online-purity-defend', defId: 'defend_silent', upgraded: false },
    ],
    discard: [], exhaust: [], energy: 3, powers: [],
  })
  Object.assign(boBeforePurity, { energy: 0, miracles: 1 })
  const publishPurityFixture = await fetch(`${roomOrigin}/api/rooms/${code}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-room-token': bCredentials.token },
    body: JSON.stringify({ action: { kind: 'spendMiracle' } }),
  })
  assert(publishPurityFixture.ok, 'could not publish the Purity refusal fixture')
  await a.getByRole('button', { name: /^Purity\+,/ }).click()
  await a.getByRole('button', { name: /^Strike,/ }).click()
  await a.getByRole('button', { name: 'Exhaust 1' }).waitFor()
  const purityOwnerCredentials = await credentials(a)
  const competingPurityPlay = await fetch(`${roomOrigin}/api/rooms/${code}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-room-token': purityOwnerCredentials.token },
    body: JSON.stringify({ action: {
      kind: 'playCard', cardUid: 'online-purity-strike',
      enemyUid: liveRoom.run.combat.enemies.find((enemy) => !enemy.dead).uid,
      preflight: true,
    } }),
  })
  assert(competingPurityPlay.ok, 'the same-seat competing Strike was refused')
  await a.getByText('Exhaust up to 5 cards — 0 chosen').waitFor()
  await a.getByRole('button', { name: /^Defend,/ }).click()
  await a.getByRole('button', { name: 'Exhaust 1' }).waitFor()
  await a.getByRole('button', { name: 'Exhaust 1' }).click()
  await a.waitForFunction(() => ![...document.querySelectorAll('button')]
    .some((button) => button.getAttribute('aria-label')?.startsWith('Purity+,')))
  const completedPurityRace = await snapshot(a)
  check('a same-seat update removes stale Purity choices before confirmation', () => {
    const ann = completedPurityRace.run.combat.players.find((player) => player.name === 'Ann')
    assertDeepEqual(ann.exhaust.map((card) => card.uid), ['online-purity-defend', 'online-purity-refusal'])
    assertDeepEqual(ann.discard.map((card) => card.uid), ['online-purity-strike'])
    assertDeepEqual(ann.hand, [])
  })

  const annBeforePurityRefusal = liveRoom.run.combat.players.find((player) => player.name === 'Ann')
  const boBeforePurityRefusal = liveRoom.run.combat.players.find((player) => player.name === 'Bo')
  Object.assign(annBeforePurityRefusal, {
    hand: [
      { uid: 'online-purity-retry', defId: 'purity', upgraded: true },
      { uid: 'online-purity-retry-strike', defId: 'strike_silent', upgraded: false },
    ],
    discard: [], exhaust: [], energy: 3,
  })
  Object.assign(boBeforePurityRefusal, { energy: 0, miracles: 1 })
  const publishPurityRefusal = await fetch(`${roomOrigin}/api/rooms/${code}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-room-token': bCredentials.token },
    body: JSON.stringify({ action: { kind: 'spendMiracle' } }),
  })
  assert(publishPurityRefusal.ok, 'could not publish the Purity refusal fixture')
  await a.getByRole('button', { name: /^Purity\+,/ }).click()
  await a.getByRole('button', { name: /^Strike,/ }).click()
  let purityRefusalStatus = 0
  await a.route(`**/api/rooms/${code}/action`, async (route) => {
    const body = JSON.parse(route.request().postData())
    body.action.exhaustUids.push(body.action.exhaustUids[0])
    const response = await route.fetch({ postData: JSON.stringify(body) })
    purityRefusalStatus = response.status()
    await route.fulfill({ response })
  }, { times: 1 })
  await a.getByRole('button', { name: 'Exhaust 1' }).click()
  for (let attempt = 0; attempt < 50 && purityRefusalStatus === 0; attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  assertEqual(purityRefusalStatus, 409, 'the forged Purity did not reach the refusal path')
  await a.getByRole('button', { name: 'Exhaust 1' }).waitFor()
  await a.getByRole('button', { name: 'Exhaust 1' }).click()
  await a.waitForFunction(() => ![...document.querySelectorAll('button')]
    .some((button) => button.getAttribute('aria-label')?.startsWith('Purity+,')))
  const completedPurityRetry = await snapshot(a)
  const expectedPurityConflict = failures.findIndex((failure) => failure.includes('409 (Conflict)'))
  assert(expectedPurityConflict >= 0, 'the refused Purity did not surface as an HTTP conflict')
  failures.splice(expectedPurityConflict, 1)
  check('a refused Purity reopens its optional Exhaust confirmation', () => {
    const ann = completedPurityRetry.run.combat.players.find((player) => player.name === 'Ann')
    assertDeepEqual(ann.exhaust.map((card) => card.uid), ['online-purity-retry-strike', 'online-purity-retry'])
    assertDeepEqual(ann.hand, [])
  })
  liveRoom.run.combat = purityRestore

  const severRestore = structuredClone(liveRoom.run.combat)
  const annBeforeSever = liveRoom.run.combat.players.find((player) => player.name === 'Ann')
  const boBeforeSever = liveRoom.run.combat.players.find((player) => player.name === 'Bo')
  const severEnemy = liveRoom.run.combat.enemies.find((enemy) => !enemy.dead)
  Object.assign(annBeforeSever, {
    hand: [{ uid: 'online-sever-soul', defId: 'sever_soul', upgraded: true }],
    draw: [
      { uid: 'online-sever-drawn-strike', defId: 'strike_ironclad', upgraded: false },
      { uid: 'online-sever-drawn-defend', defId: 'defend_ironclad', upgraded: false },
    ],
    discard: [], exhaust: [], energy: 2, powers: [], strength: 0, weak: 0,
  })
  Object.assign(boBeforeSever, {
    hand: [{ uid: 'online-sever-predator', defId: 'predator', upgraded: false }],
    energy: 1,
    miracles: 1,
  })
  for (const enemy of liveRoom.run.combat.enemies) {
    Object.assign(enemy, { hp: 50, maxHp: 50, block: 0, dead: false, abilityUsed: true })
  }
  const publishSeverFixture = await fetch(`${roomOrigin}/api/rooms/${code}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-room-token': bCredentials.token },
    body: JSON.stringify({ action: { kind: 'spendMiracle' } }),
  })
  assert(publishSeverFixture.ok, 'could not publish the Sever Soul ally-draw fixture')
  await a.getByRole('button', { name: /^Sever Soul\+,/ }).click()
  await a.getByRole('button', { name: 'Exhaust none', exact: true }).click()
  await a.getByText('Choose an enemy').waitFor()
  const teammateDraw = await fetch(`${roomOrigin}/api/rooms/${code}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-room-token': bCredentials.token },
    body: JSON.stringify({ action: {
      kind: 'playCard', cardUid: 'online-sever-predator', enemyUid: severEnemy.uid,
      playerId: annBeforeSever.id, preflight: true,
    } }),
  })
  assert(teammateDraw.ok, 'Predator could not draw into the staged Sever Soul hand')
  await a.getByText('Exhaust 1-2 cards — 0 chosen').waitFor()
  const reopenedSever = a.getByRole('button', { name: 'Exhaust none', exact: true })
  assert(await reopenedSever.isDisabled(), 'the new required Exhaust could still be skipped')
  await a.getByRole('button', { name: /^Strike,/ }).click()
  await a.getByRole('button', { name: 'Exhaust 1', exact: true }).click()
  await a.getByText('Choose an enemy').waitFor()
  await a.locator('.enemy--targeted:not(:disabled)').first().click()
  await a.waitForFunction(() => ![...document.querySelectorAll('button')]
    .some((button) => button.getAttribute('aria-label')?.startsWith('Sever Soul+,')))
  const completedSeverRace = await snapshot(a)
  check('an ally draw reopens Sever Soul+ when its Exhaust minimum rises', () => {
    const ann = completedSeverRace.run.combat.players.find((player) => player.name === 'Ann')
    assertDeepEqual(ann.exhaust.map((card) => card.uid), ['online-sever-drawn-strike'])
    assertDeepEqual(ann.hand.map((card) => card.uid), ['online-sever-drawn-defend'])
    assert(ann.discard.some((card) => card.uid === 'online-sever-soul'), 'Sever Soul+ did not finish')
  })
  liveRoom.run.combat = severRestore

  const secondWindRestore = structuredClone(liveRoom.run.combat)
  const annBeforeSecondWind = liveRoom.run.combat.players.find((player) => player.name === 'Ann')
  const boBeforeSecondWind = liveRoom.run.combat.players.find((player) => player.name === 'Bo')
  Object.assign(annBeforeSecondWind, {
    hand: [
      { uid: 'online-second-wind', defId: 'second_wind', upgraded: true },
      { uid: 'online-second-wind-sentinel', defId: 'sentinel', upgraded: false },
      { uid: 'online-second-wind-strike', defId: 'strike_ironclad', upgraded: false },
    ],
    discard: [], exhaust: [], energy: 1, block: 0,
    powers: [{ uid: 'online-second-wind-fnp', defId: 'feel_no_pain', upgraded: false }],
  })
  Object.assign(boBeforeSecondWind, { energy: 0, miracles: 1 })
  const publishSecondWind = await fetch(`${roomOrigin}/api/rooms/${code}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-room-token': bCredentials.token },
    body: JSON.stringify({ action: { kind: 'spendMiracle' } }),
  })
  assert(publishSecondWind.ok, 'could not publish the Second Wind fixture')
  await a.getByRole('button', { name: /^Second Wind\+,/ }).click()
  await a.waitForFunction(() => ![...document.querySelectorAll('button')]
    .some((button) => button.getAttribute('aria-label')?.startsWith('Second Wind+,')))
  const completedSecondWind = await snapshot(a)
  check('Second Wind and Sentinel resolve through the two-client room', () => {
    const ann = completedSecondWind.run.combat.players.find((player) => player.name === 'Ann')
    assertEqual(ann.energy, 2)
    assertEqual(ann.block, 3, '2 printed Block plus Feel No Pain')
    assertDeepEqual(ann.hand.map((card) => card.uid), ['online-second-wind-strike'])
    assertDeepEqual(ann.exhaust.map((card) => card.uid), ['online-second-wind-sentinel'])
  })
  liveRoom.run.combat = secondWindRestore

  const fiendRestore = structuredClone(liveRoom.run.combat)
  const annBeforeFiend = liveRoom.run.combat.players.find((player) => player.name === 'Ann')
  const boBeforeFiend = liveRoom.run.combat.players.find((player) => player.name === 'Bo')
  Object.assign(annBeforeFiend, {
    hand: [
      { uid: 'online-fiend-fire', defId: 'fiend_fire', upgraded: true },
      { uid: 'online-fiend-fire-sentinel', defId: 'sentinel', upgraded: false },
      { uid: 'online-fiend-fire-strike', defId: 'strike_ironclad', upgraded: false },
    ],
    discard: [], exhaust: [], energy: 2, block: 0, strength: 1, weak: 0,
    powers: [{ uid: 'online-fiend-fire-fnp', defId: 'feel_no_pain', upgraded: false }],
  })
  Object.assign(boBeforeFiend, { energy: 0, miracles: 1 })
  const fiendEnemy = liveRoom.run.combat.enemies[0]
  for (const enemy of liveRoom.run.combat.enemies) {
    Object.assign(enemy, { hp: 50, maxHp: 50, block: 0, dead: enemy.uid !== fiendEnemy.uid, abilityUsed: true })
  }
  liveRoom.run.combat.log = []
  const publishFiend = await fetch(`${roomOrigin}/api/rooms/${code}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-room-token': bCredentials.token },
    body: JSON.stringify({ action: { kind: 'spendMiracle' } }),
  })
  assert(publishFiend.ok, 'could not publish the Fiend Fire fixture')
  liveRoom.run.combat.log = []
  await a.getByRole('button', { name: /^Fiend Fire\+,/ }).click()
  await a.getByText('Choose an enemy').waitFor()
  await a.locator('.enemy--targeted:not(:disabled)').click()
  await a.waitForFunction(() => ![...document.querySelectorAll('button')]
    .some((button) => button.getAttribute('aria-label')?.startsWith('Fiend Fire+,')))
  const completedFiend = await snapshot(a)
  await a.screenshot({ path: join(outDir, '02c-online-fiend-fire-resolved.png'), fullPage: true })
  check('Fiend Fire resolves its whole-hand multi-attack through the two-client room', () => {
    const ann = completedFiend.run.combat.players.find((player) => player.name === 'Ann')
    assertEqual(completedFiend.run.combat.enemies.find((enemy) => enemy.uid === fiendEnemy.uid).hp, 44)
    assertEqual(ann.energy, 2)
    assertEqual(ann.block, 3)
    assertDeepEqual(ann.hand, [])
    assertDeepEqual(ann.exhaust.map((card) => card.uid), [
      'online-fiend-fire-sentinel', 'online-fiend-fire-strike', 'online-fiend-fire',
    ])
  })
  liveRoom.run.combat = fiendRestore

  const corruptionRestore = structuredClone(liveRoom.run.combat)
  const annBeforeCorruption = liveRoom.run.combat.players.find((player) => player.name === 'Ann')
  const boBeforeCorruption = liveRoom.run.combat.players.find((player) => player.name === 'Bo')
  Object.assign(annBeforeCorruption, {
    hand: [
      { uid: 'online-corruption', defId: 'corruption', upgraded: true },
      { uid: 'online-corruption-defend', defId: 'defend_ironclad', upgraded: false },
    ],
    discard: [], exhaust: [], energy: 2, block: 0, powers: [],
  })
  Object.assign(boBeforeCorruption, {
    hand: [{ uid: 'online-corruption-ally-defend', defId: 'defend_silent', upgraded: false }],
    energy: 0, miracles: 1, discard: [], exhaust: [], powers: [],
  })
  liveRoom.run.combat.log = []
  const publishCorruption = await fetch(`${roomOrigin}/api/rooms/${code}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-room-token': bCredentials.token },
    body: JSON.stringify({ action: { kind: 'spendMiracle' } }),
  })
  assert(publishCorruption.ok, 'could not publish the Corruption fixture')
  liveRoom.run.combat.log = []
  await a.getByRole('button', { name: /^Corruption\+,/ }).click()
  await a.getByRole('button', {
    name: 'Corruption+: your Skills cost 0 and Exhaust when played',
  }).waitFor()
  await a.getByRole('button', { name: /^Defend, cost 0,/ }).waitFor()
  await b.getByRole('button', { name: /^Defend, cost 1,/ }).waitFor()
  await a.getByRole('button', { name: /^Defend, cost 0,/ }).click()
  await a.waitForFunction(() => ![...document.querySelectorAll('button')]
    .some((button) => button.getAttribute('aria-label')?.startsWith('Defend,')))
  const completedCorruption = await snapshot(a)
  await a.screenshot({ path: join(outDir, '02d-online-corruption-resolved.png'), fullPage: true })
  check('Corruption stays owner-scoped through the two-client room', () => {
    const ann = completedCorruption.run.combat.players.find((player) => player.name === 'Ann')
    assertEqual(ann.energy, 0)
    assertEqual(ann.block, 1)
    assertDeepEqual(ann.exhaust.map((card) => card.uid), ['online-corruption-defend'])
    assertDeepEqual(ann.powers.map((card) => card.uid), ['online-corruption'])
  })
  liveRoom.run.combat = corruptionRestore

  const annBeforeUnload = liveRoom.run.combat.players.find((player) => player.name === 'Ann')
  const boBeforeUnload = liveRoom.run.combat.players.find((player) => player.name === 'Bo')
  const unloadRestore = {
    ann: structuredClone({
      hand: annBeforeUnload.hand, discard: annBeforeUnload.discard, energy: annBeforeUnload.energy,
      shivs: annBeforeUnload.shivs, attacksPlayedThisTurn: annBeforeUnload.attacksPlayedThisTurn,
    }),
    bo: structuredClone({ energy: boBeforeUnload.energy, miracles: boBeforeUnload.miracles }),
    enemies: liveRoom.run.combat.enemies.map((enemy) => structuredClone(enemy)),
  }
  Object.assign(annBeforeUnload, {
    hand: [{ uid: 'online-unload-refusal', defId: 'unload', upgraded: false }],
    energy: 3,
    shivs: 2,
    attacksPlayedThisTurn: 0,
  })
  Object.assign(boBeforeUnload, { energy: 0, miracles: 1 })
  for (const enemy of liveRoom.run.combat.enemies) {
    Object.assign(enemy, { hp: 50, maxHp: 50, block: 0, dead: false, abilityUsed: true })
  }
  const publishUnloadFixture = await fetch(`${roomOrigin}/api/rooms/${code}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-room-token': bCredentials.token },
    body: JSON.stringify({ action: { kind: 'spendMiracle' } }),
  })
  assert(publishUnloadFixture.ok, 'could not publish the Unload refusal fixture')
  await a.getByRole('button', { name: /^Unload,/ }).click()
  await a.locator('.enemy:not([disabled])').nth(0).click()
  await a.getByText('Choose Shiv attack 1/2').waitFor()
  await a.locator('.enemy:not([disabled])').nth(0).click()
  let unloadRefusalStatus = 0
  await a.route(`**/api/rooms/${code}/action`, async (route) => {
    const body = JSON.parse(route.request().postData())
    body.action.shivEnemyUids[1] = 'gone'
    const response = await route.fetch({ postData: JSON.stringify(body) })
    unloadRefusalStatus = response.status()
    await route.fulfill({ response })
  }, { times: 1 })
  await a.locator('.enemy:not([disabled])').nth(1).click()
  await a.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('Choose an enemy'))
  const expectedUnloadConflict = failures.findIndex((failure) => failure.includes('409 (Conflict)'))
  assert(expectedUnloadConflict >= 0, 'the refused Unload did not surface as an HTTP conflict')
  failures.splice(expectedUnloadConflict, 1)
  check('a refused online Unload restarts every authoritative target choice', () => {
    assertEqual(unloadRefusalStatus, 409)
  })
  await a.locator('.enemy:not([disabled])').nth(0).click()
  await a.getByText('Choose Shiv attack 1/2').waitFor()
  await a.locator('.enemy:not([disabled])').nth(0).click()
  await a.locator('.enemy:not([disabled])').nth(1).click()
  await a.waitForFunction(() => ![...document.querySelectorAll('button')]
    .some((button) => button.getAttribute('aria-label')?.startsWith('Unload,')))
  const completedUnload = await snapshot(a)
  check('the restored Unload choice completes with three separate attacks', () => {
    const ann = completedUnload.run.combat.players.find((player) => player.name === 'Ann')
    assertEqual(ann.shivs, 0)
    assertEqual(ann.attacksPlayedThisTurn, 3)
    assertDeepEqual(completedUnload.run.combat.enemies
      .filter((enemy) => enemy.hp < 50).map((enemy) => enemy.hp).sort((x, y) => x - y), [46, 48])
  })
  Object.assign(liveRoom.run.combat.players.find((player) => player.name === 'Ann'), unloadRestore.ann)
  Object.assign(liveRoom.run.combat.players.find((player) => player.name === 'Bo'), unloadRestore.bo)
  liveRoom.run.combat.enemies = unloadRestore.enemies

  await a.locator('details.game-settings > summary').click()
  await a.getByRole('button', { name: 'Solo table' }).click()
  const preservedLocalPhase = await a.evaluate(() => window.__STS_DEBUG__.getRun().phase)
  await a.getByRole('button', { name: 'Play online' }).click()
  await a.locator('.app-shell--online .combat').waitFor()
  check('switching modes preserves both the solo run and online seat', () => {
    assert(preservedLocalPhase.length > 0)
  })

  const charonRestore = structuredClone(liveRoom.run.combat)
  const annBeforeCharon = liveRoom.run.combat.players.find((player) => player.name === 'Ann')
  const boBeforeCharon = liveRoom.run.combat.players.find((player) => player.name === 'Bo')
  Object.assign(liveRoom.run.combat, {
    phase: 'start', die: 1, startTurnProgress: undefined, pendingTriggers: [], pendingRelicScry: undefined,
  })
  Object.assign(annBeforeCharon, { hand: [], relics: [], potions: [], powers: [] })
  Object.assign(boBeforeCharon, {
    hand: [{ uid: 'online-charon-card', defId: 'strike_ironclad', upgraded: false }],
    relics: [{ defId: 'charons_ashes', spent: false }], potions: [], powers: [],
  })
  for (const enemy of liveRoom.run.combat.enemies) enemy.pendingDefId = undefined
  liveRoom.version += 1
  rooms.publishRoom(code)
  await Promise.all([
    a.locator('.combat[data-phase="start"]').waitFor(),
    b.locator('.combat[data-phase="start"]').waitFor(),
  ])
  await b.getByText("Charon's Ashes", { exact: true }).waitFor()
  await a.waitForTimeout(500)
  const hiddenCharonSnapshot = await snapshot(a)
  const hiddenCharonOwner = hiddenCharonSnapshot.run.combat.players.find((player) => player.name === 'Bo')
  check('the coordinator preserves a teammate Charon window without seeing their hand', () => {
    assertEqual(hiddenCharonOwner.hand, null)
    assertEqual(hiddenCharonOwner.handCount, 1)
    assertEqual(hiddenCharonSnapshot.run.combat.phase, 'start')
  })
  liveRoom.run.combat = charonRestore
  liveRoom.version += 1
  rooms.publishRoom(code)
  await Promise.all([
    a.locator('.combat[data-phase="player"]').waitFor(),
    b.locator('.combat[data-phase="player"]').waitFor(),
  ])

  const infiniteRestore = structuredClone(liveRoom.run.combat)
  const annBeforeInfinite = liveRoom.run.combat.players.find((player) => player.name === 'Ann')
  const boBeforeInfinite = liveRoom.run.combat.players.find((player) => player.name === 'Bo')
  Object.assign(liveRoom.run.combat, { phase: 'roundEnd', turn: 1, log: [] })
  Object.assign(annBeforeInfinite, {
    shivs: 3, strength: 0, attacksPlayedThisTurn: 0, hand: [], block: 6,
    powers: [
      { uid: 'online-infinite-demon', defId: 'demon_form', upgraded: false },
      { uid: 'online-infinite-blades', defId: 'infinite_blades', upgraded: true },
    ],
    draw: Array.from({ length: 5 }, (_, index) => ({
      uid: `online-infinite-ann-${index}`, defId: 'defend_silent', upgraded: false,
    })),
  })
  Object.assign(boBeforeInfinite, {
    shivs: 2, hand: [], block: 7,
    powers: [{ uid: 'online-barricade', defId: 'barricade', upgraded: true }],
    draw: Array.from({ length: 5 }, (_, index) => ({
      uid: `online-infinite-bo-${index}`, defId: 'defend_ironclad', upgraded: false,
    })),
  })
  for (const enemy of liveRoom.run.combat.enemies) {
    Object.assign(enemy, { hp: 50, maxHp: 50, block: 0, dead: false, abilityUsed: true })
  }
  const publishInfiniteFixture = await fetch(`${roomOrigin}/api/rooms/${code}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-room-token': bCredentials.token },
    body: JSON.stringify({ action: { kind: 'startTurn' } }),
  })
  assert(publishInfiniteFixture.ok, 'could not publish the Infinite Blades Start-of-Turn fixture')
  await Promise.all([
    a.locator('.combat[data-phase="start"]').waitFor(),
    b.locator('.combat[data-phase="start"]').waitFor(),
  ])
  const teammateStartButton = b.getByRole('button', { name: 'Waiting for start-turn order' })
  const teammateStartButtonDisabled = await teammateStartButton.isDisabled()
  const teammateStartPrompts = await b.locator('.prompt').count()
  const teammateStartTargets = await b.locator('.enemy--targeted').count()
  const barricadeAnnLabel = await b.getByRole('button', { name: /^Ann,/ }).getAttribute('aria-label')
  const barricadeBoLabel = await b.getByRole('button', { name: /^Bo,/ }).getAttribute('aria-label')
  check('only the connected coordinator can resolve Start-of-Turn choices', () => {
    assert(teammateStartButtonDisabled)
  })
  check('waiting teammates are not offered dead Start-of-Turn target controls', () => {
    assertEqual(teammateStartPrompts, 0)
    assertEqual(teammateStartTargets, 0)
  })
  check('Barricade preserves only its owner\'s Block through the two-client room', () => {
    assert(!/\bBlock \d+\b/.test(barricadeAnnLabel), barricadeAnnLabel)
    assert(barricadeBoLabel.includes('Block 7'), barricadeBoLabel)
  })
  await b.screenshot({ path: join(outDir, '02e-online-barricade-resolved.png'), fullPage: true })
  await b.screenshot({ path: join(outDir, '02c-waiting-start-turn.png'), fullPage: true })
  await a.reload({ waitUntil: 'networkidle' })
  await a.locator('.combat[data-phase="start"]').waitFor()
  await a.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('overflow Shiv 1/2'))
  await a.locator('.end-turn-order > summary').click()
  await a.locator('.end-turn-order button[aria-label*="Infinite Blades"][aria-label$="earlier"]').click()
  await a.locator('.end-turn-order > summary').click()
  await a.locator('.enemy:not([disabled])').first().click()
  await a.getByRole('button', { name: 'Skip this Shiv' }).click()
  await a.getByRole('button', { name: 'Resolve start of turn' }).click()
  await a.locator('.combat[data-phase="player"]').waitFor()
  const resolvedInfinite = await snapshot(a)
  check('Infinite Blades survives refresh and resolves its ordered online overflow', () => {
    const ann = resolvedInfinite.run.combat.players.find((player) => player.name === 'Ann')
    const bo = resolvedInfinite.run.combat.players.find((player) => player.name === 'Bo')
    assertEqual(ann.shivs, 3)
    assertEqual(ann.strength, 1)
    assertEqual(ann.attacksPlayedThisTurn, 1)
    assertDeepEqual(resolvedInfinite.run.combat.enemies.filter((enemy) => enemy.hp < 50).map((enemy) => enemy.hp), [49])
    assertEqual(resolvedInfinite.startTurnAbilities, undefined)
    assertDeepEqual([ann.block, bo.block], [0, 7], 'Barricade remains owner-scoped after ordered abilities')
    assertDeepEqual(bo.powers.map((card) => card.uid), ['online-barricade'])
  })
  liveRoom.run.combat = infiniteRestore
  const boAfterInfinite = liveRoom.run.combat.players.find((player) => player.name === 'Bo')
  Object.assign(boAfterInfinite, { miracles: 1, energy: 0 })
  const publishInfiniteRestore = await fetch(`${roomOrigin}/api/rooms/${code}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-room-token': bCredentials.token },
    body: JSON.stringify({ action: { kind: 'spendMiracle' } }),
  })
  assert(publishInfiniteRestore.ok, 'could not restore the post-Infinite online fixture')
  await a.locator('.combat[data-phase="player"]').waitFor()

  const noxiousRestore = structuredClone(liveRoom.run.combat)
  const annBeforeNoxious = liveRoom.run.combat.players.find((player) => player.name === 'Ann')
  const boBeforeNoxious = liveRoom.run.combat.players.find((player) => player.name === 'Bo')
  Object.assign(liveRoom.run.combat, { phase: 'roundEnd', turn: 1, log: [] })
  Object.assign(annBeforeNoxious, {
    hand: [], shivs: 5,
    powers: [{ uid: 'online-earlier-infinite', defId: 'infinite_blades', upgraded: false }],
    draw: Array.from({ length: 5 }, (_, index) => ({
      uid: `online-noxious-ann-${index}`, defId: 'defend_ironclad', upgraded: false,
    })),
  })
  Object.assign(boBeforeNoxious, {
    hand: [],
    powers: [{ uid: 'online-noxious', defId: 'noxious_fumes', upgraded: false }],
    draw: Array.from({ length: 5 }, (_, index) => ({
      uid: `online-noxious-bo-${index}`, defId: 'defend_silent', upgraded: false,
    })),
  })
  for (const enemy of liveRoom.run.combat.enemies) {
    Object.assign(enemy, { hp: 50, maxHp: 50, block: 0, poison: 0, dead: false, abilityUsed: true })
  }
  const publishNoxiousFixture = await fetch(`${roomOrigin}/api/rooms/${code}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-room-token': bCredentials.token },
    body: JSON.stringify({ action: { kind: 'startTurn' } }),
  })
  assert(publishNoxiousFixture.ok, 'could not publish the Noxious Fumes Start-of-Turn fixture')
  await Promise.all([
    a.locator('.combat[data-phase="start"]').waitFor(),
    b.locator('.combat[data-phase="start"]').waitFor(),
  ])
  await a.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('overflow Shiv 1/1'))
  await a.getByRole('button', { name: 'Skip this Shiv' }).click()
  await a.getByRole('button', { name: 'Confirm start-of-turn order' }).click()
  await b.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('Noxious Fumes — choose an enemy'))
  const teammateNoxiousPrompts = await a.locator('.prompt').count()
  const teammateNoxiousTargets = await a.locator('.enemy--targeted').count()
  check('waiting teammates cannot target Noxious Fumes', () => {
    assertEqual(teammateNoxiousPrompts, 0)
    assertEqual(teammateNoxiousTargets, 0)
  })
  await b.locator('.enemy:not([disabled])').last().click()
  await b.getByRole('button', { name: 'Confirm Noxious Fumes target' }).click()
  await a.locator('.combat[data-phase="player"]').waitFor()
  const resolvedNoxious = await snapshot(b)
  check('Silent sends Noxious Fumes chosen enemy through the online action', () => {
    const poison = resolvedNoxious.run.combat.enemies.map((enemy) => enemy.poison)
    assertEqual(poison.filter((amount) => amount === 1).length, 1)
    assertEqual(poison.reduce((sum, amount) => sum + amount, 0), 1)
    assertEqual(resolvedNoxious.startTurnAbilities, undefined)
  })
  liveRoom.run.combat = noxiousRestore
  const boAfterNoxious = liveRoom.run.combat.players.find((player) => player.name === 'Bo')
  Object.assign(boAfterNoxious, { miracles: 1, energy: 0 })
  const publishNoxiousRestore = await fetch(`${roomOrigin}/api/rooms/${code}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-room-token': bCredentials.token },
    body: JSON.stringify({ action: { kind: 'spendMiracle' } }),
  })
  assert(publishNoxiousRestore.ok, 'could not restore the post-Noxious online fixture')
  await a.locator('.combat[data-phase="player"]').waitFor()

  const orbStormRestore = structuredClone(liveRoom.run.combat)
  const annBeforeOrbStorm = liveRoom.run.combat.players.find((player) => player.name === 'Ann')
  const boBeforeOrbStorm = liveRoom.run.combat.players.find((player) => player.name === 'Bo')
  Object.assign(liveRoom.run.combat, { phase: 'roundEnd', turn: 1, log: [] })
  Object.assign(annBeforeOrbStorm, {
    character: 'defect', hand: [], block: 0,
    powers: [
      { uid: 'online-machine-learning', defId: 'machine_learning', upgraded: false },
      { uid: 'online-storm', defId: 'storm', upgraded: true },
    ],
    orbs: ['frost', 'lightning', 'dark'],
    draw: Array.from({ length: 6 }, (_, index) => ({
      uid: `online-storm-ann-${index}`, defId: 'defend_defect', upgraded: false,
    })),
  })
  Object.assign(boBeforeOrbStorm, {
    hand: [], draw: Array.from({ length: 5 }, (_, index) => ({
      uid: `online-storm-bo-${index}`, defId: 'defend_ironclad', upgraded: false,
    })),
  })
  for (const enemy of liveRoom.run.combat.enemies) {
    Object.assign(enemy, { hp: 50, maxHp: 50, block: 0, dead: false, abilityUsed: true })
  }
  const publishOrbStormFixture = await fetch(`${roomOrigin}/api/rooms/${code}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-room-token': bCredentials.token },
    body: JSON.stringify({ action: { kind: 'startTurn' } }),
  })
  assert(publishOrbStormFixture.ok, 'could not publish the Storm Start-of-Turn fixture')
  await Promise.all([
    a.locator('.combat[data-phase="start"]').waitFor(),
    b.locator('.combat[data-phase="start"]').waitFor(),
  ])
  await a.getByRole('button', { name: 'dark slot 3' }).waitFor()
  const teammateStormPrompts = await b.locator('.prompt').count()
  const teammateStormTargets = await b.locator('.enemy--targeted').count()
  check('waiting teammates cannot choose Storm Orbs or targets', () => {
    assertEqual(teammateStormPrompts, 0)
    assertEqual(teammateStormTargets, 0)
  })
  await a.reload({ waitUntil: 'networkidle' })
  await a.locator('.combat[data-phase="start"]').waitFor()
  await a.getByRole('button', { name: 'dark slot 3' }).waitFor()
  await a.screenshot({ path: join(outDir, '02f-online-storm-reconnected.png'), fullPage: true })
  await a.getByRole('button', { name: 'dark slot 3' }).click()
  await a.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('target for the Evoked Orb'))
  const orbStormTarget = liveRoom.run.combat.enemies.find((enemy) => enemy.defId === 'cultist')
  assert(orbStormTarget, 'online Storm fixture needs its Cultist target')
  await a.getByRole('button', { name: /Cultist/ }).click()
  await a.getByRole('button', { name: 'frost slot 1' }).click()
  let submittedOrbStormChoice
  await a.route(`**/api/rooms/${code}/action`, async (route) => {
    submittedOrbStormChoice = route.request().postDataJSON()?.action?.choices
      ?.find((choice) => choice.evokeSlots?.length > 0)
    const response = await route.fetch()
    await route.fulfill({ response })
  }, { times: 1 })
  await a.getByRole('button', { name: 'Resolve start of turn' }).click()
  await a.locator('.combat[data-phase="player"]').waitFor()
  const resolvedOrbStorm = await snapshot(a)
  check('Storm survives reconnect and submits sequential Orb choices authoritatively', () => {
    const ann = resolvedOrbStorm.run.combat.players.find((player) => player.name === 'Ann')
    assertDeepEqual(submittedOrbStormChoice.evokeSlots, [2, 0])
    assertDeepEqual(submittedOrbStormChoice.evokeEnemyUids, [orbStormTarget.uid, null])
    assertDeepEqual(ann.orbs, ['lightning', 'lightning', 'lightning'])
    assertEqual(ann.block, 1)
    assertEqual(resolvedOrbStorm.run.combat.enemies.find((enemy) => enemy.uid === orbStormTarget.uid).hp, 45)
    assertEqual(resolvedOrbStorm.startTurnAbilities, undefined)
  })
  await a.screenshot({ path: join(outDir, '02g-online-storm-resolved.png'), fullPage: true })
  liveRoom.run.combat = orbStormRestore
  const boAfterOrbStorm = liveRoom.run.combat.players.find((player) => player.name === 'Bo')
  Object.assign(boAfterOrbStorm, { miracles: 1, energy: 0 })
  const publishOrbStormRestore = await fetch(`${roomOrigin}/api/rooms/${code}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-room-token': bCredentials.token },
    body: JSON.stringify({ action: { kind: 'spendMiracle' } }),
  })
  assert(publishOrbStormRestore.ok, 'could not restore the post-Storm online fixture')
  await a.locator('.combat[data-phase="player"]').waitFor()

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
      .nth(boMiracleLogsBefore).waitFor({ state: 'attached' })
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
    .some((button) => button.getAttribute('aria-label') === 'Use Energy Potion ×3' && button.disabled))
  await reconciliationRetriesExhausted
  await a.waitForTimeout(0)
  await a.evaluate((snapshot) => {
    window.__ROOM_SOCKETS__.at(-1)?.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ type: 'snapshot', snapshot }),
    }))
  }, interleavedSnapshot)
  await a.waitForFunction(() => [...document.querySelectorAll('.combat__actions button')]
    .some((button) => button.getAttribute('aria-label') === 'Use Energy Potion ×3' && button.disabled))
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
    .some((button) => button.getAttribute('aria-label') === 'Use Energy Potion ×2' && !button.disabled))
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
    .some((button) => button.getAttribute('aria-label') === 'Use Energy Potion ×2' && !button.disabled))
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
    .some((button) => button.getAttribute('aria-label') === 'Use Energy Potion ×2' && !button.disabled))
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
    await a.locator('.combat__actions').getByRole('button', { name: 'Use Energy Potion', exact: true }).waitFor()
    await route.abort('connectionreset')
  }, { times: 1 })
  await a.locator('.combat__actions').getByRole('button', { name: /Energy Potion ×2/ }).click()
  await a.getByRole('alert').filter({ hasText: /fetch|network/i }).waitFor()
  await a.waitForFunction(() => [...document.querySelectorAll('.combat__actions button')]
    .some((button) => button.getAttribute('aria-label') === 'Use Energy Potion' && !button.disabled))
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
  await a.locator('.combat__actions').getByRole('button', { name: 'Use Energy Potion', exact: true }).evaluate((button) => {
    button.click()
    button.click()
  })
  await a.waitForFunction(() => ![...document.querySelectorAll('.combat__actions button')]
    .some((button) => button.getAttribute('aria-label')?.startsWith('Use Energy Potion')))
  const afterPotionDoubleClick = await snapshot(a)
  const annAfterPotion = afterPotionDoubleClick.run.combat.players.find((player) => player.id === aView.you.playerId)
  check('one rapid double-click consumes only one physical potion', () => {
    assertEqual(annAfterPotion.energy, Math.min(6, energyBeforePotionDoubleClick + 2))
    assertDeepEqual(annAfterPotion.potions, [])
  })

  liveRoom.run.combat.players.find((player) => player.name === 'Bo').hand
    .push({ uid: 'online-scroll-strike', defId: 'strike_silent', upgraded: false })
  const beforeRemoteAction = await snapshot(b)
  const beforeRemotePlayer = beforeRemoteAction.run.combat.players
    .find((player) => player.id === aView.you.playerId)
  await a.getByRole('button', { name: /^(Strike|Bash),/ }).first().click()
  if (await a.locator('.prompt').count()) await a.locator('.enemy:not([disabled])').first().click()
  const localPlayedVfx = a.locator('.enemy .combat-vfx--target[data-vfx-kind="card"]').last()
  const peerPlayedVfx = b.locator('.enemy .combat-vfx--target[data-vfx-kind="card"]').last()
  await Promise.all([localPlayedVfx.waitFor(), peerPlayedVfx.waitFor()])
  const [localPlayedSource, peerPlayedSource, peerTargetVfx] = await Promise.all([
    localPlayedVfx.getAttribute('data-vfx-source'),
    peerPlayedVfx.getAttribute('data-vfx-source'),
    b.locator('.enemy .combat-vfx--target[data-vfx-kind="card"]').count(),
  ])
  await b.waitForFunction((before) => {
    const lines = [...document.querySelectorAll('.combat__log li')].map((line) => line.textContent ?? '')
    return lines.some((line) => line.includes('Strike')) || lines.length > before
  }, beforeRemoteAction.run.combat.log.length)
  const afterPlay = await snapshot(b)
  const afterRemotePlayer = afterPlay.run.combat.players.find((player) => player.id === aView.you.playerId)
  const shownDraw = Number(await a.locator('.pile[title="Draw pile"] .pile__count').textContent())
  const actualDraw = afterPlay.run.combat.players.find((player) => player.id === aView.you.playerId).drawCount
  check('an action in one browser updates the other browser', () => {
    assertEqual(afterRemotePlayer.handCount, beforeRemotePlayer.handCount - 1,
      'the remote browser did not see the played card leave hand')
    assert(afterPlay.run.combat.log.length > beforeRemoteAction.run.combat.log.length,
      'the remote browser did not see the play log')
    assertEqual(shownDraw, actualDraw, 'the private hand used the wrong public draw-pile count')
    assertEqual(peerPlayedSource, localPlayedSource, 'peers resolved different VFX recipes for the same play')
    assert(peerPlayedSource === 'bash' || peerPlayedSource?.startsWith('strike_'),
      `unexpected source ${peerPlayedSource}`)
    assert(peerTargetVfx > 0, 'the peer did not render the authoritative enemy impact')
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
  await b.getByRole('button', { name: /^Strike,/ }).first().click()
  if (await b.locator('.prompt').count()) await b.locator('.enemy:not([disabled])').first().click()
  await a.waitForFunction(() => [...document.querySelectorAll('.combat__log li')]
    .some((line) => /Bo played/.test(line.textContent ?? '')))
  await a.waitForTimeout(100)
  const afterRemoteScroll = await a.locator('.board').evaluate((board) => board.scrollTop)
  check('a teammate action preserves deliberate inspection of another row', () => {
    assertEqual(afterRemoteScroll, manualScroll)
  })

  await a.getByRole('button', { name: /^Blade Dance,/ }).click()
  await a.locator('.enemy:not([disabled])').first().click()
  await a.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('2/2'))
  liveRoom.run.combat.players.find((player) => player.name === 'Ann').hand
    .push({ uid: 'online-order-shame', defId: 'shame', upgraded: false })
  liveRoom.run.combat.players.find((player) => player.name === 'Ann').hand
    .push({ uid: 'online-equilibrium-retain', defId: 'reinforced_body', upgraded: false })
  Object.assign(liveRoom.run.combat.players.find((player) => player.name === 'Ann'), {
    block: 1,
    retainCardsThisTurn: 1,
  })
  liveRoom.run.combat.players.find((player) => player.name === 'Bo').hand
    .push({ uid: 'online-order-decay', defId: 'decay', upgraded: false })
  const aCredentials = await credentials(a)
  const endTurnStatuses = []
  let publishedEndTurnOrder
  let teammateOrderButtonDisabled
  let teammateReorderControlsDisabled
  let coordinatorAbilityLabels
  let decayAbilityId
  const stalePlayerTurn = await snapshot(a)
  let endTurnConflictStatus = 0
  let finishEndTurnConflict
  const endTurnConflictFinished = new Promise((resolveConflict) => { finishEndTurnConflict = resolveConflict })
  await a.route(`**/api/rooms/${code}/action`, async (route) => {
    liveRoom.run.combat.players.find((player) => player.name === 'Bo').shivs = 0
    const response = await route.fetch()
    endTurnConflictStatus = response.status()
    await route.fulfill({ response })
    finishEndTurnConflict()
  }, { times: 1 })
  await a.locator('.enemy:not([disabled])').nth(1).click()
  await endTurnConflictFinished
  await a.getByRole('alert').waitFor()
  liveRoom.run.combat.players.find((player) => player.name === 'Ann').orbs = ['lightning', null, null]
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
  const teammateOrderOpen = await b.locator('.end-turn-order[open]').count()
  const teammateArrows = b.locator('.end-turn-order li button')
  teammateReorderControlsDisabled = await teammateArrows.evaluateAll((buttons) =>
    buttons.length > 0 && buttons.every((button) => button.disabled))
  // The ordering stage opens the disclosure itself: the coordinator must not
  // have to find a collapsed panel to fix a rejected order.
  await a.locator('.end-turn-order[open]').waitFor({ timeout: 5000 }).catch(() => {})
  const coordinatorOrderOpen = await a.locator('.end-turn-order[open]').count()
  coordinatorAbilityLabels = await a.locator('.end-turn-order li span').allTextContents()
  for (let index = publishedEndTurnOrder.indexOf(decayAbilityId); index > 0; index -= 1) {
    await a.locator('.end-turn-order li').nth(index).getByRole('button', { name: /earlier/ }).click()
  }
  await a.screenshot({ path: join(outDir, '03-party-end-turn-order.png'), fullPage: true })
  // The orb's chosen target dies while the party is still ordering: the
  // coordinator must be told what to fix, with the order list already open.
  const orbChoice = publishedEndTurnOrder.find((choice) => choice.includes('@'))
  assert(orbChoice, `no targeted end-turn ability was published: ${JSON.stringify(publishedEndTurnOrder)}`)
  const orbTarget = liveRoom.run.combat.enemies.find((enemy) => enemy.uid === orbChoice.split('@')[1])
  assert(orbTarget, `the published target is not an enemy: ${orbChoice}`)
  Object.assign(orbTarget, { hp: 0, dead: true })
  // A coordinator who collapsed the tray must still be pointed back into it.
  await a.locator('.end-turn-order > summary').click()
  const collapsedBeforeStale = await a.locator('.end-turn-order[open]').count()
  const failuresBeforeStale = failures.length
  await a.getByRole('button', { name: 'Resolve end turn' }).click()
  // The earlier conflict left its own banner, so wait for this refusal's copy
  // rather than for any banner; the check below still pins the exact text.
  const staleError = a.locator('.online-error', { hasText: REBUILT_END_TURN_ORDER })
  await staleError.waitFor()
  await a.locator('.end-turn-order[open]').waitFor({ timeout: 5000 }).catch(() => {})
  const staleEndTurnError = await staleError.innerText()
  const staleOrderOpen = await a.locator('.end-turn-order[open]').count()
  const staleTargets = await a.getByRole('combobox', { name: /Lightning Orb/ })
    .locator('option').evaluateAll((options) => options.map((option) => option.value))
  // The refusal is broadcast, so the teammate's own list must lose the dead
  // target too — read it from page B, which never refetches on A's rejection.
  await b.waitForFunction((uid) => {
    const options = [...document.querySelectorAll('.end-turn-order option')]
    return options.length > 0 && !options.some((option) => option.value === uid)
  }, orbTarget.uid, { timeout: 5000 }).catch(() => {})
  const teammateTargets = await b.locator('.end-turn-order option')
    .evaluateAll((options) => options.map((option) => option.value))
  await a.screenshot({ path: join(outDir, '03b-stale-end-turn-order.png'), fullPage: true })
  check('a stale online end-turn order reopens the list and offers living targets', () => {
    assertEqual(collapsedBeforeStale, 0, 'the coordinator could not collapse the order list')
    assertEqual(staleEndTurnError, REBUILT_END_TURN_ORDER)
    assertEqual(staleOrderOpen, 1, 'the rejected order left the coordinator with a collapsed list')
    assert(staleTargets.length > 0 && !staleTargets.includes(orbTarget.uid),
      `the dead target survived the republished list: ${JSON.stringify(staleTargets)}`)
    assert(teammateTargets.length > 0 && !teammateTargets.includes(orbTarget.uid),
      `the teammate kept the dead target: ${JSON.stringify(teammateTargets)}`)
  })
  const staleConflict = failures.slice(failuresBeforeStale)
    .findIndex((failure) => failure.includes('409 (Conflict)'))
  assert(staleConflict >= 0, 'the stale end-turn order was not rejected')
  failures.splice(failuresBeforeStale + staleConflict, 1)
  // The republished order is fresh, and its public ids carry the version that
  // published them, so Decay has to be found by label again before moving up.
  // Decay is Bo's own card, so only Bo's snapshot spells the label out.
  const republishedDecayId = (await snapshot(b)).endTurnAbilities
    .find((ability) => ability.label.includes('Decay'))?.id
  assert(republishedDecayId, 'Decay left the republished abilities')
  const republishedEndTurnOrder = (await snapshot(a)).endTurnOrder
  for (let index = republishedEndTurnOrder.indexOf(republishedDecayId); index > 0; index -= 1) {
    await a.locator('.end-turn-order li').nth(index).getByRole('button', { name: /earlier/ }).click()
  }
  await a.getByRole('button', { name: 'Resolve end turn' }).click()
  await Promise.all([
    a.locator('.combat[data-phase="discard"]').waitFor(),
    b.locator('.combat[data-phase="discard"]').waitFor(),
  ])
  await a.evaluate((snapshot) => {
    window.__ROOM_SOCKETS__.at(-1)?.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ type: 'snapshot', snapshot }),
    }))
  }, stalePlayerTurn)
  await a.waitForTimeout(0)
  await a.waitForFunction(() => document.querySelector('.prompt') === null)
  const expectedEndTurnConflict = failures.findIndex((failure) => failure.includes('409 (Conflict)'))
  assert(expectedEndTurnConflict >= 0, 'the post-end-turn card action did not conflict')
  failures.splice(expectedEndTurnConflict, 1)
  const afterEndTurnRace = await snapshot(a)
  const stalePhasePrompt = await a.locator('.prompt').count()
  check('a stale snapshot after final end-turn cannot restore Player Turn targeting', () => {
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
    assertEqual(coordinatorOrderOpen, 1, 'the ordering stage left the end-turn order collapsed')
    assertEqual(teammateOrderOpen, 0, 'the order list opened itself for a seat that cannot use it')
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
  const retainReinforcedBody = a.getByRole('button', { name: /Retain Reinforced Body$/ })
  await retainReinforcedBody.click()
  if (await aDiscardTop.count()) await aDiscardTop.selectOption({ index: 0 })
  const selectedDiscardTop = await aDiscardTop.count() ? await aDiscardTop.inputValue() : ''
  await a.getByRole('button', { name: /^Confirm Ann/ }).click()
  await a.getByRole('button', { name: /^Update Ann/ }).waitFor()
  const savedDiscard = await snapshot(a)
  await a.reload({ waitUntil: 'networkidle' })
  await a.locator('.app-shell--online .combat[data-phase="discard"]').waitFor()
  const restoredDiscardTop = await aDiscardTop.count() ? await aDiscardTop.inputValue() : ''
  const restoredRetain = await retainReinforcedBody.getAttribute('aria-pressed')
  check('refresh restores this seat\'s private discard and Retain choices', () => {
    assertEqual(savedDiscard.discardOrder?.at(-1) ?? '', selectedDiscardTop)
    assert(!savedDiscard.discardOrder?.includes('online-equilibrium-retain'),
      'the retained card was sent in the discard order')
    assertEqual(restoredDiscardTop, selectedDiscardTop)
    assertEqual(restoredRetain, 'true')
  })
  let automaticEnemyAttempts = 0
  const actionUrl = `**/api/rooms/${code}/action`
  const refuseFirstAutomaticEnemy = async (route) => {
    const action = route.request().postDataJSON()?.action
    if (action?.kind !== 'resolveEnemies') return route.continue()
    automaticEnemyAttempts += 1
    if (automaticEnemyAttempts === 1) {
      return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'stale automatic action' }) })
    }
    if (automaticEnemyAttempts === 2) return route.abort('failed')
    return route.continue()
  }
  await a.route(actionUrl, refuseFirstAutomaticEnemy)
  await b.getByRole('button', { name: /^Confirm Bo/ }).click()
  await Promise.all([
    a.locator('.combat[data-phase="enemy"]').waitFor(),
    b.locator('.combat[data-phase="enemy"]').waitFor(),
  ])
  const enemyTurn = await snapshot(a)
  const enemyTurnPotions = await a.locator('.seat', { hasText: 'Bo' }).locator('.seat__potions .potion-chip').count()
  check('each seat independently confirms the shared end of turn', () => {
    const ann = enemyTurn.run.combat.players.find((player) => player.id === enemyTurn.you.playerId)
    const bo = enemyTurn.run.combat.players.find((player) => player.id !== enemyTurn.you.playerId)
    assertDeepEqual(ann.hand.map((card) => card.uid), ['online-equilibrium-retain'])
    assertEqual(bo.handCount, 0)
    assertEqual(enemyTurn.run.combat.phase, 'enemy')
  })
  check('face-up potion icons remain visible outside the Player Turn', () => {
    assertEqual(enemyTurnPotions, 1)
  })
  await a.waitForFunction(() => !['enemy'].includes(document.querySelector('.app-shell--online .combat')?.dataset.phase))
  await a.unroute(actionUrl, refuseFirstAutomaticEnemy)
  const expectedAutomaticConflict = failures.findIndex((failure) => failure.includes('409 (Conflict)'))
  assert(expectedAutomaticConflict >= 0, 'the simulated automatic-action refusal did not reach the browser')
  failures.splice(expectedAutomaticConflict, 1)
  const expectedAutomaticNetworkFailure = failures.findIndex((failure) => failure.includes('net::ERR_FAILED'))
  assert(expectedAutomaticNetworkFailure >= 0, 'the simulated automatic-action network failure did not reach the browser')
  failures.splice(expectedAutomaticNetworkFailure, 1)
  check('the coordinator retries refused and same-phase reconciled automatic enemy actions', () => {
    assertEqual(automaticEnemyAttempts, 3)
  })
  const pageScroll = await a.evaluate(() => scrollY)
  check('combat row centering never scrolls the page chrome away', () => {
    assertEqual(pageScroll, 0)
  })
  await a.screenshot({ path: join(outDir, '04-shared-enemy-turn.png'), fullPage: true })

  const reconnectCredentials = await credentials(b)
  await b.close()
  const boStatus = a.locator('.setup .pip', { hasText: 'Bo' })
  await boStatus.filter({ hasText: '○' }).waitFor({ state: 'attached' })
  b = installScreenAudit(await bContext.newPage())
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
  await boStatus.filter({ hasText: '●' }).waitFor({ state: 'attached' })
  const restored = await snapshot(b)
  check('refresh reconnects to the same live seat', () => {
    assertEqual(restored.you.name, 'Bo')
    assertEqual(restored.phase, 'run')
    assertEqual(createWhileReconnecting, 0, 'reconnect exposed a destructive fresh-room form')
  })
  await b.screenshot({ path: join(outDir, '05-reconnected-seat.png'), fullPage: true })

  const recoveryTab = installScreenAudit(await bContext.newPage())
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

  // Online item surfaces use the same server-owned state and survive a compact desktop
  // reconnect. These fixtures publish through real room actions so both seats
  // receive the exact redacted snapshots used in production.
  const itemBaseline = structuredClone(liveRoom.run)
  const annRun = liveRoom.run.players.find((player) => player.name === 'Ann')
  liveRoom.run = {
    ...liveRoom.run, phase: 'reward', combat: null, rewardDestination: 'map',
    rewards: [{ playerId: annRun.id, cardReward: false, choices: null, upgraded: false,
      potion: false, relic: 'astrolabe', bossRelics: false }],
  }
  await roomAction(a, { kind: 'relicReward', choice: 'gain' })
  const ownerGame = a.locator('.app-shell--online')
  const teammateGame = b.locator('.app-shell--online')
  await ownerGame.getByRole('heading', { name: 'Resolve Astrolabe' }).waitFor()
  await teammateGame.getByRole('status').filter({ hasText: 'Waiting for Ann to resolve Astrolabe' }).waitFor()
  await Promise.all([a, b].map((page) => page.setViewportSize({ width: 1280, height: 800 })))
  const activeGames = [ownerGame, teammateGame]
  await Promise.all(activeGames.map((game) => game.locator('.map[inert]').waitFor()))
  const [ownerMapBlocked, teammateMapBlocked] = await Promise.all(activeGames.map((game) =>
    game.locator('.map').evaluate((map) => {
      const rooms = [...map.querySelectorAll('button')]
      let focusable = 0
      for (const room of rooms) {
        room.focus()
        if (document.activeElement === room) focusable++
      }
      return { inert: map.inert, focusable }
    })))
  const reachableDuringRelic = await ownerGame.locator('.room--reachable').count()
  const wingBootsDuringRelic = await ownerGame.getByRole('button', { name: /Ignore paths to/ }).count()
  await a.screenshot({ path: join(outDir, '08a-compact-desktop-pending-relic.png'), fullPage: true })
  const pendingOnCompact = (await snapshot(a)).pendingRelic?.relicId
  check('pending Relic acquisition is exposed on the compact desktop owner surface', () => {
    assertEqual(pendingOnCompact, 'astrolabe')
    assert(ownerMapBlocked.inert, 'the active owner map was not inert')
    assert(teammateMapBlocked.inert, 'the active teammate map was not inert')
    assertEqual(ownerMapBlocked.focusable, 0, 'the owner map kept focusable progression controls')
    assertEqual(teammateMapBlocked.focusable, 0, 'the teammate map kept focusable progression controls')
    assertEqual(reachableDuringRelic, 0, 'map progression stayed visually reachable behind a mandatory Relic')
    assertEqual(wingBootsDuringRelic, 0, 'Wing Boots stayed focusable behind a mandatory Relic')
  })
  await b.reload({ waitUntil: 'domcontentloaded' })
  await b.locator('.connection--connected').waitFor()
  await teammateGame.getByRole('status').filter({ hasText: 'Waiting for Ann to resolve Astrolabe' }).waitFor()
  await teammateGame.locator('.map[inert]').waitFor()
  const reconnectedMapBlocked = await teammateGame.locator('.map').evaluate((map) => {
    const rooms = [...map.querySelectorAll('button')]
    let focusable = 0
    for (const room of rooms) {
      room.focus()
      if (document.activeElement === room) focusable++
    }
    return map.inert && focusable === 0
  })
  check('a non-owner reconnect keeps mandatory Relic progression inert', () => {
    assert(reconnectedMapBlocked)
  })
  await teammateGame.locator('details.game-settings > summary').click()
  const teammateHeaderControl = teammateGame.getByRole('button', { name: 'Solo table' })
  await teammateHeaderControl.focus()
  const astrolabeChoices = ownerGame.locator('.campfire__deck button')
  for (let index = 0; index < 3; index++) await astrolabeChoices.nth(index).click()
  await ownerGame.getByRole('button', { name: 'Resolve Relic' }).click()
  await ownerGame.getByRole('heading', { name: 'Resolve Astrolabe' }).waitFor({ state: 'hidden' })
  await Promise.all(activeGames.map((game) => game.locator('.map:not([inert]) .room--reachable').first().waitFor()))
  await a.waitForFunction(() => document.activeElement?.classList.contains('room--reachable'))
  const ownerMapFocusRestored = await ownerGame.locator('.room--reachable').first()
    .evaluate((room) => document.activeElement === room)
  const teammateHeaderFocusPreserved = await teammateHeaderControl.evaluate((control) =>
    document.activeElement === control)
  const teammateMapFocusable = await teammateGame.locator('.room--reachable').first()
    .evaluate((room) => !room.closest('.map')?.inert && room.tabIndex >= 0)
  check('resolving a mandatory Relic restores map access without stealing teammate focus', () => {
    assert(ownerMapFocusRestored)
    assert(teammateMapFocusable)
    assert(teammateHeaderFocusPreserved)
  })
  await teammateGame.locator('details.game-settings > summary').click()

  Object.assign(liveRoom.run, {
    phase: 'reward', rewardDestination: 'map',
    rewards: [{ playerId: annRun.id, cardReward: false, choices: null, upgraded: false,
      potion: null, relic: false, bossRelics: false }],
  })
  await roomAction(a, { kind: 'potionReward', choice: 'reveal' })
  await a.locator('.reward-screen__potion').waitFor()
  await b.locator('.reward-screen__potion').waitFor()
  await a.locator('.reward-screen').evaluate(async (screen) => {
    await Promise.all(screen.getAnimations({ subtree: true }).map((animation) => animation.finished))
  })
  const foreignPotionGain = await b.locator('.reward-screen__potion').getByRole('button', { name: 'Gain' }).count()
  const onlinePotionCardLoaded = await a.locator('.reward-screen__potion .item-card-image')
    .evaluateAll((images) => images.length > 0 && images.every((image) => image.naturalWidth > 0))
  const compactPotionLayout = await a.locator('.outside-potions').evaluate((bar) => ({
    width: bar.clientWidth, scrollWidth: bar.scrollWidth, height: bar.getBoundingClientRect().height,
  }))
  check('revealed Potion rewards are shared without foreign controls', () => {
    assertEqual(foreignPotionGain, 0)
    assert(onlinePotionCardLoaded, 'the revealed Potion omitted its physical card artwork')
    assert(compactPotionLayout.scrollWidth <= compactPotionLayout.width,
      'the outside Potion controls overflow the compact desktop viewport')
    assert(compactPotionLayout.height < 160, 'the Potion inventory stretched into the reward stage')
  })
  await a.screenshot({ path: join(outDir, '08b-compact-desktop-potion-replacement.png'), fullPage: true })
  let skippedPotionStatus = 0
  await a.route(`**/api/rooms/${code}/action`, async (route) => {
    const response = await route.fetch()
    skippedPotionStatus = response.status()
    await route.fulfill({ response })
  }, { times: 1 })
  await a.locator('.reward-screen__potion').getByRole('button', { name: 'Skip' }).click()
  for (let attempt = 0; attempt < 50 && skippedPotionStatus === 0; attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  assertEqual(skippedPotionStatus, 200, 'the revealed Potion skip was refused')
  await a.locator('.reward-screen__potion').waitFor({ state: 'hidden' })

  const annCards = liveRoom.run.players.find((player) => player.id === annRun.id)
  annCards.cardRewards = ['golden_ticket', 'anger', 'shrug_it_off']
  annCards.rareRewards = ['bludgeon']
  Object.assign(liveRoom.run, {
    phase: 'reward', rewardDestination: 'map',
    rewards: [{ playerId: annRun.id, cardReward: true, choices: null, upgraded: false,
      potion: false, relic: false, bossRelics: false }],
  })
  await roomAction(a, { kind: 'cardReward', choice: 'reveal' })
  const ticketBadge = a.getByText('Golden Ticket · Rare')
  await ticketBadge.waitFor()
  await b.getByText('Golden Ticket · Rare').waitFor()
  await ticketBadge.scrollIntoViewIfNeeded()
  const ticketBadgeVisible = await ticketBadge.evaluate((badge) => {
    const box = badge.getBoundingClientRect()
    return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight
  })
  check('Golden Ticket presentation is public after reveal', () => {
    assert(ticketBadgeVisible, 'the compact desktop screenshot hides the Golden Ticket source badge')
  })
  await a.screenshot({ path: join(outDir, '08c-compact-desktop-golden-ticket.png'), fullPage: true })

  liveRoom.run = { ...itemBaseline, phase: 'betweenCombat', combat: null, act: 3, ascension: 13,
    pendingBossDefId: 'time_eater' }
  await roomAction(a, { kind: 'switchBetweenCombatRow', row: 1 })
  await Promise.all([
    a.getByRole('heading', { name: 'Another boss approaches' }).waitFor(),
    b.getByRole('heading', { name: 'Another boss approaches' }).waitFor(),
  ])
  const hiddenReservedBoss = (await snapshot(b)).run.pendingBossDefId
  check('A13 regroup is compact desktop, shared, and keeps the reserved boss hidden', () => {
    assertEqual(hiddenReservedBoss, null)
  })
  await a.screenshot({ path: join(outDir, '08d-compact-desktop-a13-regroup.png'), fullPage: true })
  liveRoom.run = structuredClone(itemBaseline)
  Object.assign(liveRoom.run.combat, {
    phase: 'player', startTurnProgress: undefined, pendingTriggers: [],
  })
  const restoredAnn = liveRoom.run.combat.players.find((player) => player.id === annRun.id)
  Object.assign(restoredAnn, { energy: 0, miracles: 1 })
  await roomAction(a, { kind: 'spendMiracle' })
  await a.setViewportSize({ width: 1440, height: 900 })
  await a.locator('.app-shell--online .combat').waitFor()

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

  const fourContexts = await Promise.all(Array.from({ length: 4 }, () => browser.newContext({
    viewport: { width: 1280, height: 800 }, permissions: ['microphone'],
  })))
  await Promise.all(fourContexts.map((context) => context.addInitScript(() => {
    const sockets = []
    window.__ROOM_SOCKETS__ = sockets
    window.WebSocket = new Proxy(window.WebSocket, {
      construct(Target, args) {
        const socket = new Target(...args)
        sockets.push(socket)
        return socket
      },
    })
  })))
  const fourPages = await Promise.all(fourContexts.map(async (context) => installScreenAudit(await context.newPage())))
  fourPages.forEach((page) => {
    page.on('pageerror', (error) => failures.push(String(error)))
    page.on('console', (message) => { if (message.type() === 'error') failures.push(message.text()) })
  })
  await enterOnline(fourPages[0], 'Iris', 'ironclad')
  const fourCode = await fourPages[0].locator('.online-lobby h1').textContent()
  rooms.store.rooms.get(fourCode).campaignProgress.highestAscension = 13
  for (const [index, character] of ['silent', 'defect', 'watcher'].entries()) {
    await enterOnline(fourPages[index + 1], ['Sable', 'Cobalt', 'Violet'][index], character, fourCode)
  }
  await fourPages[0].locator('.online-seat[aria-label*="online"]').nth(3).waitFor()
  for (const page of fourPages) await page.getByRole('button', { name: 'Join voice' }).click()
  await Promise.all(fourPages.map((page) => page.locator('.voice__status', { hasText: '3/3' }).waitFor()))
  await Promise.all(fourPages.map((page) => page.waitForFunction(() => [...document.querySelectorAll('audio')]
    .filter((audio) => audio.srcObject?.getAudioTracks().length).length === 3)))
  const fourVoiceTracks = await Promise.all(fourPages.map((page) => page.evaluate(() => [...document.querySelectorAll('audio')]
    .filter((audio) => audio.srcObject?.getAudioTracks().length).length)))
  await fourPages[0].screenshot({ path: join(outDir, '01b-four-player-voice-compact-desktop.png'), fullPage: true })
  await Promise.all(fourPages.map((page) => page.getByRole('button', { name: 'Leave voice' }).click()))
  await Promise.all(fourPages.map((page) => page.getByRole('button', { name: 'Join voice' }).waitFor()))
  const fourVoiceTracksAfterLeave = await Promise.all(fourPages.map((page) => page.locator('audio').count()))
  check('four browsers establish and cleanly leave the full voice mesh', () => {
    assertDeepEqual(fourVoiceTracks, [3, 3, 3, 3])
    assertDeepEqual(fourVoiceTracksAfterLeave, [0, 0, 0, 0])
  })
  await openLobbySettings(fourPages[0])
  await fourPages[0].waitForFunction(() => [...document.querySelectorAll('main.online-lobby label')]
    .find((label) => label.textContent?.includes('Ascension'))?.querySelectorAll('option').length === 14)
  await fourPages[0].locator('.online-lobby').getByLabel('Ascension').selectOption('13')
  await fourPages[0].getByRole('button', { name: 'Enter the Spire' }).click()
  await fourPages[0].getByRole('heading', { name: 'Neow’s Blessing' }).waitFor()
  const fourRoom = rooms.store.rooms.get(fourCode)
  bypassRoomNeow(fourRoom)
  await Promise.all(fourPages.map((page) => page.locator('.app-shell--online .map').waitFor()))
  const iris = fourRoom.run.players.find((player) => player.name === 'Iris')
  iris.potions = ['energy_potion', 'energy_potion', 'energy_potion']
  Object.assign(fourRoom.run, {
    phase: 'reward', combat: null, ascension: 0, rewardDestination: 'map',
    rewards: [{ playerId: iris.id, cardReward: true, choices: null, upgraded: false,
      potion: false, relic: false, bossRelics: false }],
  })
  await roomAction(fourPages[0], { kind: 'cardReward', choice: 'reveal' })
  const fourGive = fourPages[0].locator('.outside-potions').getByRole('button', { name: 'Give Energy Potion', exact: true })
  const fullPotionBarHeight = await fourPages[0].locator('.outside-potions').evaluate((bar) =>
    bar.getBoundingClientRect().height)
  await fourGive.first().click()
  const expandedDuplicateRows = await fourPages[0].locator('.outside-potions__targets').count()
  const expandedDuplicateButtons = await fourGive.evaluateAll((buttons) =>
    buttons.map((button) => button.getAttribute('aria-expanded')))
  const expandedTradeLayout = await fourPages[0].locator('.outside-potions').evaluate((bar) => ({
    width: bar.clientWidth,
    scrollWidth: bar.scrollWidth,
    viewportWidth: window.innerWidth,
    items: [...bar.querySelectorAll('.outside-potions__item, .outside-potions__targets')].map((item) => {
      const box = item.getBoundingClientRect()
      return { left: box.left, right: box.right }
    }),
    styles: [...bar.querySelectorAll('button:not(:disabled)')].map((button) => ({
      label: button.textContent?.trim(),
      color: getComputedStyle(button).color,
      background: getComputedStyle(button).backgroundColor,
    })),
  }))
  check('four-player Potion trading keeps every target inside the desktop viewport', () => {
    assertEqual(expandedDuplicateRows, 1, 'duplicate Potions opened duplicate trade target groups')
    assertDeepEqual(expandedDuplicateButtons, ['true', 'false', 'false'])
    assert(fullPotionBarHeight < 160, 'a full three-Potion inventory stretched into the stage')
    assert(expandedTradeLayout.scrollWidth <= expandedTradeLayout.width)
    assert(expandedTradeLayout.items.every((item) => item.left >= 0 && item.right <= expandedTradeLayout.viewportWidth),
      `expanded Potion trade overflowed: ${JSON.stringify(expandedTradeLayout.items)}`)
    assert(expandedTradeLayout.styles.every((style) => contrastRatio(style) >= 4.5),
      `outside Potion action contrast failed: ${JSON.stringify(expandedTradeLayout.styles)}`)
  })
  await fourGive.first().click()
  iris.potions = ['entropic_brew', 'entropic_brew', 'energy_potion']
  await roomAction(fourPages[0], { kind: 'cardReward', choice: null })
  const brewUses = fourPages[0].locator('.outside-potions').getByRole('button', { name: 'Use Entropic Brew', exact: true })
  await brewUses.first().click()
  const duplicateBrewTargets = await fourPages[0].locator('.outside-potions__targets').count()
  const expandedBrewButtons = await brewUses.evaluateAll((buttons) =>
    buttons.map((button) => button.getAttribute('aria-expanded')))
  await fourPages[0].waitForFunction(() => [...document.querySelectorAll('.outside-potions__targets .item-card-image')]
    .every((image) => image.complete && image.naturalWidth > 0))
  const brewReplacementStyles = await fourPages[0].locator('.outside-potions__targets button').evaluateAll((buttons) =>
    buttons.map((button) => ({ label: button.textContent?.trim(), color: getComputedStyle(button).color,
      background: getComputedStyle(button).backgroundColor })))
  const brewReplacementCards = await fourPages[0].locator('.outside-potions__targets .item-card-image')
    .evaluateAll((images) => images.map((image) => image.naturalWidth > 0))
  await fourPages[0].screenshot({ path: join(outDir, '09-outside-potion-replacement.png'), fullPage: true })
  check('duplicate Entropic Brews open one replacement group', () => {
    assertEqual(duplicateBrewTargets, 1)
    assertDeepEqual(expandedBrewButtons, ['true', 'false'])
    assertDeepEqual(brewReplacementCards, [true])
    assert(brewReplacementStyles.every((style) => contrastRatio(style) >= 4.5),
      `Potion replacement contrast failed: ${JSON.stringify(brewReplacementStyles)}`)
  })
  await brewUses.first().click()
  fourRoom.run.players.find((player) => player.id === iris.id).potions = ['entropic_brew']
  await roomAction(fourPages[0], { kind: 'cardReward', choice: 0 })
  await fourPages[0].waitForFunction(() =>
    document.querySelectorAll('.outside-potions [aria-label="Use Entropic Brew"]').length === 1)
  const immediateBrew = fourPages[0].locator('.outside-potions__item').first()
    .getByRole('button', { name: 'Use Entropic Brew', exact: true })
  const immediateBrewExpanded = await immediateBrew.getAttribute('aria-expanded')
  check('an immediately usable Entropic Brew is not announced as a disclosure', () => {
    assertEqual(fourRoom.run.players.find((player) => player.id === iris.id).potions.length, 1)
    assertEqual(immediateBrewExpanded, null)
  })

  const combatPlayers = fourRoom.run.players.map((player, index) => ({
    ...player, row: index,
    potions: player.id === iris.id ? ['entropic_brew', 'fire_potion', 'energy_potion'] : [],
  }))
  const enemy = (uid, defId, row, hp) => ({
    uid, defId, row, hp, maxHp: hp, block: 0, strength: 0, vulnerable: 0, weak: 0,
    poison: 0, actionIndex: 0, abilityUsed: false, dead: false, isBoss: false,
  })
  fourRoom.run = {
    ...fourRoom.run, phase: 'combat', rewards: [], rewardDestination: null,
    combat: createCombat(createRng(404), combatPlayers,
      [enemy('combat-target', 'cultist', 2, 20)], 'online-brew', ['block_potion', 'skill_potion'], 3),
  }
  fourRoom.version += 1
  rooms.publishRoom(fourCode)
  await Promise.all(fourPages.map((page) => page.locator('.combat').waitFor()))
  await fourPages[0].locator('.combat__actions').getByRole('button', { name: /Entropic Brew/ }).click()
  const brewDialog = fourPages[0].getByRole('dialog', { name: 'Entropic Brew' })
  await brewDialog.waitFor()
  const onlineBrewSnapshot = await snapshot(fourPages[0])
  const replacementStyle = await brewDialog.getByRole('button', { name: 'Replace Energy Potion' }).evaluate((button) => ({
    color: getComputedStyle(button).color,
    background: getComputedStyle(button).backgroundColor,
  }))
  await brewDialog.locator('.item-icon-image').first().waitFor()
  await fourPages[0].waitForFunction(() => [...document.querySelectorAll('[aria-labelledby="entropic-choice-title"] .item-icon-image')]
    .every((image) => image.complete && image.naturalWidth > 0))
  const combatReplacementIcons = await brewDialog.locator('.item-icon-image')
    .evaluateAll((images) => images.map((image) => image.naturalWidth > 0))
  await fourPages[0].keyboard.press('Escape')
  await brewDialog.waitFor({ state: 'hidden' })
  const afterBrewEscape = await snapshot(fourPages[0])
  await fourPages[0].locator('.combat__actions').getByRole('button', { name: /Entropic Brew/ }).click()
  await brewDialog.getByRole('button', { name: 'Cancel' }).click()
  await brewDialog.waitFor({ state: 'hidden' })
  const afterBrewCancel = await snapshot(fourPages[0])
  await fourPages[0].locator('.combat__actions').getByRole('button', { name: /Entropic Brew/ }).click()
  await brewDialog.waitFor()
  await brewDialog.evaluate((dialog) => Promise.all(dialog.getAnimations().map((animation) => animation.finished)))
  await fourPages[0].screenshot({ path: join(outDir, '09a-four-player-combat-potion-replacement.png'), fullPage: true })
  await brewDialog.getByRole('button', { name: 'Replace Energy Potion' }).click()
  await brewDialog.waitFor({ state: 'hidden' })
  const afterOnlineBrew = await snapshot(fourPages[0])
  check('online full-belt Entropic Brew exposes and resolves its replacement choice', () => {
    assertEqual(onlineBrewSnapshot.run.combat.potionLimit, 3)
    const originalPotions = onlineBrewSnapshot.run.combat.players.find((player) => player.id === iris.id).potions
    assertDeepEqual(afterBrewEscape.run.combat.players.find((player) => player.id === iris.id).potions, originalPotions)
    assertDeepEqual(afterBrewCancel.run.combat.players.find((player) => player.id === iris.id).potions, originalPotions)
    const contrast = contrastRatio(replacementStyle)
    assert(contrast >= 4.5, `Entropic Brew dialog contrast is only ${contrast.toFixed(2)}:1`)
    assertDeepEqual(combatReplacementIcons, [true, true])
    const potions = afterOnlineBrew.run.combat.players.find((player) => player.id === iris.id).potions
    assertEqual(potions.length, 3)
    assert(!potions.includes('entropic_brew'))
  })

  const facingCombat = createCombat(createRng(405), combatPlayers, [
    enemy('shield', 'spire_shield', 0, 30), enemy('spear', 'spire_spear', 3, 42),
  ], 'online-facing')
  facingCombat.enemies.find((candidate) => candidate.uid === 'shield').actionIndex = 2
  Object.assign(facingCombat, { phase: 'start', turn: 1, startTurnStage: 'facing' })
  fourRoom.run = { ...fourRoom.run, phase: 'combat', combat: facingCombat }
  fourRoom.version += 1
  rooms.publishRoom(fourCode)
  await fourPages[0].waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('choose an enemy'))
  const facingSnapshot = await snapshot(fourPages[1])
  await fourPages[0].evaluate(() => window.__ROOM_SOCKETS__?.at(-1)?.close(4000, 'Facing reconnect test'))
  await fourPages[0].locator('.connection--connected').waitFor()
  await fourPages[0].getByRole('button', { name: /^Spire Shield,/ }).click()
  await fourPages[0].waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('Sable'))
  await fourPages[0].getByRole('button', { name: /^Spire Spear,/ }).click()
  await fourPages[0].waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('Cobalt'))
  await fourPages[0].getByRole('button', { name: /^Spire Shield,/ }).click()
  await fourPages[0].waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('Violet'))
  const facingCapacity = await fourPages[0].locator('.enemy').evaluateAll((cards) => Object.fromEntries(cards.map((card) => [
    card.getAttribute('aria-label')?.split(',')[0], card.matches(':disabled'),
  ])))
  await fourPages[0].getByRole('button', { name: /^Spire Spear,/ }).click()
  await fourPages[0].screenshot({ path: join(outDir, '09c-four-player-online-facing.png'), fullPage: true })
  await fourPages[0].getByRole('button', { name: 'Resolve start of turn' }).click()
  await fourPages[0].waitForFunction(() => document.querySelector('.combat')?.dataset.phase === 'player')
  const afterFacing = await snapshot(fourPages[0])
  check('online Facing stays bounded and resolvable across coordinator reconnect', () => {
    assertEqual(facingSnapshot.run.combat.startTurnStage, 'facing')
    assertEqual(facingCapacity['Spire Shield'], true)
    assertEqual(facingCapacity['Spire Spear'], false)
    assertDeepEqual(afterFacing.run.combat.players.map((player) => player.facingEnemyUid),
      ['shield', 'spear', 'shield', 'spear'])
    assertDeepEqual(afterFacing.run.combat.players.map((player) => player.damageDealtZeroThisTurn),
      [true, false, true, false])
  })

  const cobalt = fourRoom.run.combat.players.find((player) => player.name === 'Cobalt')
  Object.assign(cobalt, {
    hand: [{ uid: 'online-facing-multi-cast', defId: 'multi_cast', upgraded: false }],
    discard: [], draw: [], exhaust: [], powers: [], energy: 2, orbs: ['lightning', null, null],
  })
  Object.assign(fourRoom.run.combat.enemies.find((candidate) => candidate.uid === 'shield'), {
    hp: 1, maxHp: 1, block: 0, dead: false,
  })
  Object.assign(fourRoom.run.combat.enemies.find((candidate) => candidate.uid === 'spear'), {
    hp: 0, block: 0, dead: true,
  })
  fourRoom.version += 1
  rooms.publishRoom(fourCode)
  await fourPages[2].evaluate(() => window.__ROOM_SOCKETS__?.at(-1)?.close(4000, 'Facing damage reconnect test'))
  await fourPages[2].locator('.connection--connected').waitFor()
  await fourPages[2].getByRole('button', { name: /^Multi-Cast, cost X,/ }).click()
  await fourPages[2].getByRole('button', { name: 'Spend 2' }).click()
  await fourPages[2].getByRole('button', { name: /lightning slot 1/i }).click()
  const zeroDamageTarget = fourPages[2].getByRole('button', { name: /^Spire Shield,/ })
  await zeroDamageTarget.click()
  await zeroDamageTarget.waitFor()
  await zeroDamageTarget.click()
  await fourPages[2].getByRole('button', { name: /^Multi-Cast, cost X,/ }).waitFor({ state: 'hidden' })
  const afterZeroDamageMultiCast = await snapshot(fourPages[2])
  check('online Facing zero-damage state survives reconnect and keeps every Multi-Cast target authoritative', () => {
    const player = afterZeroDamageMultiCast.run.combat.players.find((candidate) => candidate.id === cobalt.id)
    assertEqual(player.damageDealtZeroThisTurn, true)
    assertDeepEqual(player.orbs, [null, null, null])
    assert(player.discard.some((card) => card.uid === 'online-facing-multi-cast'))
    assertEqual(afterZeroDamageMultiCast.run.combat.enemies.find((candidate) => candidate.uid === 'shield').hp, 1)
  })

  const rewardIris = fourRoom.run.players.find((player) => player.id === iris.id)
  rewardIris.potions = ['weak_potion']
  rewardIris.cardRewards = ['golden_ticket', 'anger', 'shrug_it_off']
  rewardIris.rareRewards = ['bludgeon']
  fourRoom.run = {
    ...fourRoom.run, phase: 'reward', combat: null, rewardDestination: 'map',
    rewards: [{ playerId: rewardIris.id, cardReward: true, choices: null, upgraded: false,
      potion: null, relic: null, bossRelics: false }],
  }
  fourRoom.rewardChoices = undefined
  fourRoom.rewardConfirmed = undefined
  fourRoom.version += 1
  rooms.publishRoom(fourCode)
  await fourPages[0].getByRole('button', { name: 'Reveal Relic' }).waitFor()
  await fourPages[0].getByRole('button', { name: 'Reveal Potion' }).waitFor()
  const unrevealedRewardStyles = await fourPages[0].locator('.reward-screen__player > p > button:not(:disabled)')
    .evaluateAll((buttons) => buttons.map((button) => ({
      label: button.textContent?.trim(),
      height: button.getBoundingClientRect().height,
      color: getComputedStyle(button).color,
      background: getComputedStyle(button).backgroundColor,
    })))
  check('unrevealed Relic and Potion actions retain readable minimum desktop game styling', () => {
    assert(unrevealedRewardStyles.length >= 4)
    assert(unrevealedRewardStyles.every((style) => style.height >= 44),
      `unrevealed reward action is too small: ${JSON.stringify(unrevealedRewardStyles)}`)
    assert(unrevealedRewardStyles.every((style) => contrastRatio(style) >= 4.5),
      `unrevealed reward action contrast failed: ${JSON.stringify(unrevealedRewardStyles)}`)
  })
  fourRoom.run.rewards[0].relic = 'astrolabe'
  await roomAction(fourPages[0], { kind: 'potionReward', choice: 'reveal' })
  await roomAction(fourPages[0], { kind: 'cardReward', choice: 'reveal' })
  await fourPages[1].getByText('Golden Ticket · Rare').waitFor()
  const fourSeatCount = await fourPages[0].locator('.setup .pip').evaluateAll((pips) =>
    pips.filter((pip) => /[●○]/.test(pip.textContent ?? '')).length)
  const teammatePotionControls = await fourPages[1].locator('.reward-screen__potion button').count()
  const revealedItemImages = await fourPages[0].locator([
    '.reward-screen__relic > .item-card-image',
    '.reward-screen__relic > .item-card-fallback > .item-card-image',
    '.reward-screen__potion > .item-card-image',
    '.reward-screen__potion > .item-card-fallback > .item-card-image',
  ].join(', '))
    .evaluateAll((images) => images.map((image) => image.naturalWidth > 0))
  const heldPotionCards = await fourPages[0].locator('.reward-screen__potion button .item-card-image')
    .evaluateAll((images) => images.map((image) => image.naturalWidth > 0))
  const freshRewardChoice = (await snapshot(fourPages[0])).rewardChoice
  check('the four-player Golden Ticket fixture starts genuinely undecided', () => {
    assertEqual(freshRewardChoice, undefined)
    assertDeepEqual(revealedItemImages, [true, true])
    assertDeepEqual(heldPotionCards, [true])
  })
  const rewardActionStyles = await fourPages[0].locator('.reward-screen__relic button:not(:disabled), .reward-screen__potion button:not(:disabled)')
    .evaluateAll((buttons) => buttons.map((button) => ({
      label: button.textContent?.trim(),
      height: button.getBoundingClientRect().height,
      color: getComputedStyle(button).color,
      background: getComputedStyle(button).backgroundColor,
    })))
  check('four-player Relic and Potion reward actions retain readable game styling', () => {
    assert(rewardActionStyles.length > 0)
    assert(rewardActionStyles.every((style) => style.height >= 44),
      `reward action is too small: ${JSON.stringify(rewardActionStyles)}`)
    assert(rewardActionStyles.every((style) => contrastRatio(style) >= 4.5),
      `reward action contrast failed: ${JSON.stringify(rewardActionStyles)}`)
  })
  await fourPages[0].locator('.reward-screen__relic').scrollIntoViewIfNeeded()
  await fourPages[0].screenshot({ path: join(outDir, '09-four-player-compact-desktop-revealed-items.png'), fullPage: true })
  await fourPages[0].getByText('Golden Ticket · Rare').scrollIntoViewIfNeeded()
  await fourPages[0].screenshot({ path: join(outDir, '09-four-player-compact-desktop-items.png'), fullPage: true })
  await roomAction(fourPages[0], { kind: 'relicReward', choice: 'gain' })
  await fourPages[0].getByRole('heading', { name: 'Resolve Astrolabe' }).waitFor()
  await fourPages[1].getByRole('status').filter({ hasText: 'Waiting for Iris to resolve Astrolabe' }).waitFor()
  await fourPages[0].screenshot({ path: join(outDir, '09b-four-player-compact-desktop-pending-relic.png'), fullPage: true })
  await fourPages[0].evaluate(() => window.__ROOM_SOCKETS__?.at(-1)?.close(4000, 'item reconnect test'))
  await fourPages[1].locator('.setup .pip', { hasText: 'Iris ○' }).waitFor({ state: 'attached' })
  await fourPages[0].reload({ waitUntil: 'domcontentloaded' })
  await fourPages[0].locator('.connection--connected').waitFor()
  const pendingAfterFourReconnect = (await snapshot(fourPages[0])).pendingRelic
  check('four-player compact desktop item rewards settle deterministically across reconnect', () => {
    assertEqual(fourSeatCount, 4)
    assertEqual(teammatePotionControls, 0)
    assertEqual(pendingAfterFourReconnect, null, 'disconnect did not settle the private Relic deterministically')
  })
  fourRoom.run = { ...fourRoom.run, phase: 'betweenCombat', combat: null, act: 3, ascension: 13,
    pendingBossDefId: 'time_eater', rewards: [], rewardDestination: null,
    players: fourRoom.run.players.map((player) => ({ ...player,
      relics: player.relics.map((relic) => ({ ...relic, pending: undefined })) })) }
  await roomAction(fourPages[0], { kind: 'switchBetweenCombatRow', row: 3 })
  await Promise.all(fourPages.map((page) => page.getByRole('heading', { name: 'Another boss approaches' }).waitFor()))
  const fourBossViews = await Promise.all(fourPages.map(snapshot))
  check('four-player A13 regroup stays shared and hides the reserved boss', () => {
    assertEqual(fourRoom.run.players.find((player) => player.id === iris.id).row, 3)
    assert(fourBossViews.every((view) => view.run.pendingBossDefId === null), 'reserved boss leaked to a seat')
  })
  await fourPages[0].screenshot({ path: join(outDir, '10-four-player-compact-desktop-a13.png'), fullPage: true })
  fourRoom.run = {
    ...fourRoom.run,
    act: 1,
    phase: 'victory',
    combat: null,
    lastStand: true,
    pendingBossDefId: null,
    roomState: null,
    rewards: [],
    players: fourRoom.run.players.map((player, index) => ({
      ...player,
      hp: index === 1 ? 0 : Math.max(1, player.hp),
      dead: index === 1,
      relics: player.relics.map((relic) => ({ ...relic, pending: undefined })),
    })),
    campaign: { ...fourRoom.run.campaign, finalized: false },
  }
  fourRoom.version += 1
  rooms.publishRoom(fourCode)
  await fourPages[0].getByRole('heading', { name: 'Act 1 complete' }).waitFor()
  const lastStandNotice = await fourPages[0].getByRole('status').filter({ hasText: 'cannot continue to the next Act' }).count()
  const forbiddenNextAct = await fourPages[0].getByRole('button', { name: 'Climb to Act 2' }).count()
  const recordLastStand = await fourPages[0].getByRole('button', { name: 'Stop and record result' }).count()
  const terminalPotions = await fourPages[0].locator('.outside-potions').count()
  const compactTitle = await fourPages[0].getByRole('heading', { name: 'Slay the Spire' }).evaluate((heading) => {
    const box = heading.getBoundingClientRect()
    const range = document.createRange()
    range.selectNodeContents(heading)
    return { width: box.width, textWidth: range.getBoundingClientRect().width }
  })
  check('a Last Stand boss win explains why the party must end instead of exposing the next Act', () => {
    assertEqual(lastStandNotice, 1)
    assertEqual(forbiddenNextAct, 0)
    assertEqual(recordLastStand, 1)
    assertEqual(terminalPotions, 0)
    assert(compactTitle.width >= 100 && compactTitle.width + 1 >= compactTitle.textWidth,
      'the online header crushed the game title')
  })
  await fourPages[0].screenshot({ path: join(outDir, '11-last-stand-victory-compact-desktop.png'), fullPage: true })
  await Promise.all(fourContexts.map((context) => context.close()))

  check('the online flow has no browser errors', () => {
    assertEqual(failures.length, 0, failures.join('\n'))
  })
} finally {
  await browser.close()
  await vite.close()
  await rooms.close()
}

report('online browser')
