// Online Start-of-Turn recovery: a seat that returns after the server readied it
// with fallback picks gets its prompt back, and a seat left with only a disabled
// button can re-sync without a hard refresh. Desktop and horizontal phone.
import assert from 'node:assert/strict'
import { createServer as createViteServer } from 'vite'
import { chromium, setTestUsername } from './lib/profile-browser.mjs'
import { createRoomServer } from './room-server.mjs'
import { apply, startRun } from './lib/rooms.mjs'
import { createCombat } from '../src/game/combat/create.ts'
import { enemyDef, startingHp } from '../src/game/enemies.ts'

const rooms = createRoomServer()
const roomAddress = await rooms.listen(0)
const roomOrigin = `http://127.0.0.1:${roomAddress.port}`
const vite = await createViteServer({
  logLevel: 'silent',
  server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: roomOrigin }, '/ws': { target: roomOrigin, ws: true } } },
})
await vite.listen()
const origin = `http://127.0.0.1:${vite.httpServer.address().port}`
const browser = await chromium.launch({ headless: true })
const errors = []

async function enterOnline(page, name, character, code) {
  await page.goto(origin, { waitUntil: 'networkidle' })
  await setTestUsername(page, name)
  await page.getByRole('button', { name: 'Play online' }).click()
  await page.locator('.online-character-roster').getByRole('button', { name: character }).click()
  if (code) {
    await page.getByLabel('Room code').fill(code)
    await page.getByRole('button', { name: 'Join', exact: true }).click()
  } else await page.getByRole('button', { name: 'Create room' }).click()
  await page.locator('.online-lobby').waitFor()
}
const credentials = (page) => page.evaluate(() => JSON.parse(sessionStorage.getItem('sts-room-session')))
async function snapshot(code, token) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${roomOrigin}/api/rooms/${code}`, { headers: { 'x-room-token': token } })
      assert(response.ok)
      return await response.json()
    } catch (error) {
      if (attempt >= 3 || error instanceof assert.AssertionError) throw error
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
}
const resolveButton = (page) => page.getByRole('button', { name: /^Resolve start (turn|of turn)/ })

try {
  const desktopContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const phoneContext = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true })
  const desktop = await desktopContext.newPage()
  let phone = await phoneContext.newPage()
  for (const page of [desktop, phone]) {
    page.on('pageerror', (error) => errors.push(String(error)))
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  }
  await enterOnline(desktop, 'Ann', 'Ironclad')
  const code = await desktop.locator('.online-lobby h1').textContent()
  await enterOnline(phone, 'Bo', 'Silent', code)
  await desktop.locator('.online-seat', { hasText: 'Bo' }).waitFor()
  const room = rooms.store.rooms.get(code)
  const desktopToken = (await credentials(desktop)).token
  const phoneSession = await credentials(phone)

  startRun(room, room.seats[0].token, { seed: 7 })
  const players = room.run.players.map((player) => {
    const copy = structuredClone(player)
    copy.powers = []
    copy.relics = copy.relics.filter((relic) => relic.defId.endsWith('starting_relic'))
    copy.relics.push({ defId: 'stone_calendar', spent: false })
    copy.hand = []
    return copy
  })
  const enemies = [0, 1, 2].map((row) => {
    const hp = startingHp(enemyDef('cultist'), 2)
    return { uid: `e${row}`, defId: 'cultist', row, isBoss: false, hp, maxHp: hp, block: 0, strength: 0,
      vulnerable: 0, weak: 0, poison: 0, goldReward: 0, cardReward: null, actionIndex: 0, abilityUsed: false,
      dead: false, phase: 0 }
  })
  const combat = createCombat(room.run.rng, players, enemies, 'resync-fixture')
  combat.turn = 1
  combat.phase = 'roundEnd'
  room.run = { ...room.run, phase: 'combat', neow: null, combat }
  apply(room, room.seats[0].token, { kind: 'startTurn' })
  Object.assign(room.run.combat, { phase: 'start', die: 4, startTurnProgress: undefined, startTurnStage: 'effects',
    pendingTriggers: [], pendingDieRelicChoices: [], powerTriggersUsedThisTurn: [] })
  for (const key of ['startTurnCombatId', 'startTurnOrder', 'startTurnEnemyTargets', 'startTurnChoices',
    'startTurnRequired', 'startTurnReady', 'startTurnStagedTriggers', 'startTurnPostRollLock', 'startTurnAutoReady']) {
    room[key] = undefined
  }
  room.version += 1
  rooms.publishRoom(code)
  await resolveButton(desktop).waitFor()
  await resolveButton(phone).waitFor()

  // Bo's tab closes: the server readies Bo with fallback picks so Ann is not blocked.
  await phone.close()
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await snapshot(code, desktopToken)).startTurnDecided?.includes('p2')) break
    await desktop.waitForTimeout(50)
  }
  assert((await snapshot(code, desktopToken)).startTurnDecided?.includes('p2'), 'the absent seat was not readied')

  // Bo returns: the decision comes back with its button instead of an empty screen.
  phone = await phoneContext.newPage()
  phone.on('pageerror', (error) => errors.push(String(error)))
  phone.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  await phone.goto(origin)
  await phone.evaluate((session) => sessionStorage.setItem('sts-room-session', JSON.stringify(session)), phoneSession)
  await phone.goto(origin, { waitUntil: 'networkidle' })
  await resolveButton(phone).waitFor()
  assert(!(await snapshot(code, phoneSession.token)).startTurnDecided?.includes('p2'),
    'the returning seat stayed decided on the server')

  // A seat stuck behind a disabled button can re-sync without reloading the page.
  // Pushed frames make this seat the Noxious Fumes owner while another seat is the
  // coordinator, leaving a disabled button and no prompt (a live-client desync).
  await phone.addInitScript(() => {
    const descriptor = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data')
    Object.defineProperty(MessageEvent.prototype, 'data', { get() {
      const value = descriptor.get.call(this)
      if (!window.__desyncStartTurn || !(this.target instanceof WebSocket) || typeof value !== 'string') return value
      try {
        const frame = JSON.parse(value)
        const abilities = frame.snapshot?.startTurnAbilities
        if (frame.type !== 'snapshot' || !abilities) return value
        const own = abilities.find((ability) => ability.playerId === frame.snapshot.you.playerId)
        const foreign = abilities.find((ability) => ability.playerId !== frame.snapshot.you.playerId)
        frame.snapshot.startTurnChoiceId = own?.id
        frame.snapshot.startTurnCoordinatorId = foreign?.playerId
        return JSON.stringify(frame)
      } catch { return value }
    } })
  })
  let desynced = false
  await phone.route(`**/api/rooms/${code}`, async (route) => {
    const response = await route.fetch()
    if (!desynced || route.request().method() !== 'GET') return route.fulfill({ response })
    const body = await response.json()
    const own = body.startTurnAbilities?.find((ability) => ability.playerId === body.you.playerId)
    const foreign = body.startTurnAbilities?.find((ability) => ability.playerId !== body.you.playerId)
    return route.fulfill({ response, json: { ...body, startTurnChoiceId: own?.id, startTurnCoordinatorId: foreign?.playerId } })
  })
  await phone.reload({ waitUntil: 'networkidle' })
  await resolveButton(phone).waitFor()
  desynced = true
  await phone.evaluate(() => { window.__desyncStartTurn = true })
  room.version += 1
  rooms.publishRoom(code)
  await phone.waitForFunction(() => [...document.querySelectorAll('.combat__end-turn')].some((button) => button.disabled))
  assert.equal(await phone.getByRole('button', { name: /Re-sync start of turn/ }).count(), 0,
    'the re-sync control appeared before the pause elapsed')
  const resync = phone.getByRole('button', { name: /Re-sync start of turn/ })
  await resync.waitFor({ timeout: 25_000 })
  const box = await resync.boundingBox()
  assert(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 844 && box.y + box.height <= 390,
    'the re-sync control leaves the phone viewport')
  for (const selector of ['.combat__end-turn', '.start-turn-order', '.hand .card']) {
    for (const other of await phone.locator(selector).all()) {
      const rect = await other.boundingBox()
      if (!rect || rect.width === 0) continue
      assert(box.x + box.width <= rect.x || rect.x + rect.width <= box.x ||
        box.y + box.height <= rect.y || rect.y + rect.height <= box.y,
      `the re-sync control covers ${selector} on a horizontal phone`)
    }
  }
  desynced = false
  await phone.evaluate(() => { window.__desyncStartTurn = false })
  await resync.click()
  await resolveButton(phone).waitFor()
  assert.equal(await phone.getByRole('button', { name: /Re-sync start of turn/ }).count(), 0)

  assert.deepEqual(errors.filter((error) => !error.includes('ERR_CONNECTION_RESET')), [])
  console.log('Start-of-turn re-sync passed: returning seats get their prompt back and a stuck seat can re-sync.')
} finally {
  await browser.close()
  await vite.close()
  await rooms.close()
}
