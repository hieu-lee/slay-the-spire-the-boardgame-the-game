import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createServer as createViteServer } from 'vite'
import { createRoomServer } from './room-server.mjs'
import { suite, check, assert, assertEqual, report } from './lib/harness.mjs'

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

const browser = await chromium.launch({ headless: true })
const aContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const bContext = await browser.newContext({ viewport: { width: 1280, height: 800 } })
const cContext = await browser.newContext({ viewport: { width: 1024, height: 768 } })
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
  return response.json()
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
  await guardedEntry.getByRole('button', { name: '← Leave room' }).click()
  await guardedEntry.getByLabel('Seed').waitFor()
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
  c.on('pageerror', (error) => failures.push(String(error)))
  c.on('console', (message) => { if (message.type() === 'error') failures.push(message.text()) })
  await enterOnline(c, 'Cy', 'defect', code)
  await a.locator('.online-seat', { hasText: 'Cy' }).waitFor()
  await c.getByRole('button', { name: '← Leave room' }).click()
  await a.locator('.online-seat', { hasText: 'Cy' }).waitFor({ state: 'detached' })
  await c.close()
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
  await a.getByLabel('Ascension').fill('3')
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
  await b.getByLabel('Ascension').fill('4')
  await mutationStarted
  await b.getByLabel('Ascension').fill('5')
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
  await b.getByLabel('Ascension').fill('6')
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

  await a.getByRole('button', { name: 'Enter the Spire' }).click()
  await Promise.all([
    a.locator('.app-shell--online .map').waitFor(),
    b.locator('.app-shell--online .map').waitFor(),
  ])
  await a.locator('.app-shell--online .room--reachable').click()
  await Promise.all([
    a.locator('.app-shell--online .combat').waitFor(),
    b.locator('.app-shell--online .combat').waitFor(),
  ])

  const [aView, bView] = await Promise.all([snapshot(a), snapshot(b)])
  check('each browser receives only its own hidden cards', () => {
    const aId = aView.you.playerId
    const bId = bView.you.playerId
    assert(Array.isArray(aView.run.combat.players.find((player) => player.id === aId).hand))
    assertEqual(aView.run.combat.players.find((player) => player.id === bId).hand, null)
    assert(Array.isArray(bView.run.combat.players.find((player) => player.id === bId).hand))
    assertEqual(bView.run.combat.players.find((player) => player.id === aId).hand, null)
    assertEqual(aView.run.players.find((player) => player.id === bId).deck, null)
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
  await a.screenshot({ path: join(outDir, '02-authoritative-combat.png'), fullPage: true })

  await a.getByRole('button', { name: 'Solo table' }).click()
  await a.getByLabel('Seed').waitFor()
  const preservedSeed = await a.getByLabel('Seed').inputValue()
  await a.getByRole('button', { name: 'Play online' }).click()
  await a.locator('.app-shell--online .combat').waitFor()
  check('switching modes preserves both the solo run and online seat', () => {
    assertEqual(preservedSeed, 'kept-local-run')
  })

  await a.getByRole('button', { name: 'End turn' }).click()
  await b.getByRole('button', { name: 'End turn' }).click()
  await Promise.all([
    a.locator('.combat[data-phase="discard"]').waitFor(),
    b.locator('.combat[data-phase="discard"]').waitFor(),
  ])
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
  check('each seat independently confirms the shared end of turn', () => {
    assert(enemyTurn.run.combat.players.every((player) => player.handCount === 0))
    assertEqual(enemyTurn.run.combat.phase, 'enemy')
  })
  await b.getByRole('button', { name: 'Resolve enemies' }).click()
  await a.waitForFunction(() => ['roundEnd', 'lost'].includes(document.querySelector('.app-shell--online .combat')?.dataset.phase))
  const pageScroll = await a.evaluate(() => scrollY)
  check('combat row centering never scrolls the page chrome away', () => {
    assertEqual(pageScroll, 0)
  })
  await a.screenshot({ path: join(outDir, '03-shared-enemy-turn.png'), fullPage: true })

  await b.goto('about:blank')
  const boStatus = a.locator('.setup .pip', { hasText: 'Bo' })
  await boStatus.filter({ hasText: '○' }).waitFor()
  await b.route(`**/api/rooms/${code}`, async (route) => {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
    await route.continue()
  }, { times: 1 })
  const reconnecting = b.goto(origin, { waitUntil: 'networkidle' })
  await b.locator('.online-reconnecting').waitFor()
  const createWhileReconnecting = await b.getByRole('button', { name: 'Create room' }).count()
  await reconnecting
  await b.locator('.app-shell--online .combat').waitFor()
  await boStatus.filter({ hasText: '●' }).waitFor()
  const restored = await snapshot(b)
  check('refresh reconnects to the same live seat', () => {
    assertEqual(restored.you.name, 'Bo')
    assertEqual(restored.phase, 'run')
    assertEqual(createWhileReconnecting, 0, 'reconnect exposed a destructive fresh-room form')
  })
  await b.screenshot({ path: join(outDir, '04-reconnected-seat.png'), fullPage: true })

  const recoveryTab = await bContext.newPage()
  recoveryTab.on('pageerror', (error) => failures.push(String(error)))
  recoveryTab.on('console', (message) => { if (message.type() === 'error') failures.push(message.text()) })
  await recoveryTab.goto(origin, { waitUntil: 'networkidle' })
  await recoveryTab.screenshot({ path: join(outDir, '05-saved-expedition.png'), fullPage: true })
  await recoveryTab.getByRole('button', { name: `Resume ${code}` }).click()
  await recoveryTab.locator('.app-shell--online .combat').waitFor()
  await b.locator('.online-entry').waitFor()
  const recoveredSeat = await snapshot(recoveryTab)
  check('a fresh tab can explicitly recover a live run seat', () => {
    assertEqual(recoveredSeat.you.name, 'Bo')
    assertEqual(recoveredSeat.phase, 'run')
  })
  await recoveryTab.screenshot({ path: join(outDir, '06-durable-seat-recovery.png'), fullPage: true })
  await b.close()
  b = recoveryTab

  check('the online flow has no browser errors', () => {
    assertEqual(failures.length, 0, failures.join('\n'))
  })
} finally {
  await browser.close()
  await vite.close()
  await rooms.close()
}

report('online browser')
