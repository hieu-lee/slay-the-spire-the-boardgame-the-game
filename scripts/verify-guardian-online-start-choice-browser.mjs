import assert from 'node:assert/strict'
import { createServer as createViteServer } from 'vite'
import { chromium, setTestUsername } from './lib/profile-browser.mjs'
import { createRoomServer } from './room-server.mjs'
import { startRun } from './lib/rooms.mjs'
import { createCombat, startPlayerTurnWithChoices } from '../src/game/combat.ts'
import { createRng } from '../src/game/rng.ts'

const rooms = createRoomServer()
const roomAddress = await rooms.listen(0)
const roomOrigin = `http://127.0.0.1:${roomAddress.port}`
const vite = await createViteServer({
  logLevel: 'silent',
  server: {
    host: '127.0.0.1', port: 0,
    proxy: { '/api': { target: roomOrigin }, '/ws': { target: roomOrigin, ws: true } },
  },
})
await vite.listen()
const viteAddress = vite.httpServer.address()
assert(viteAddress && typeof viteAddress !== 'string')
const origin = `http://127.0.0.1:${viteAddress.port}`
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

async function credentials(page) {
  return page.evaluate(() => JSON.parse(sessionStorage.getItem('sts-room-session')))
}

async function snapshot(page) {
  const saved = await credentials(page)
  const response = await fetch(`${roomOrigin}/api/rooms/${saved.code}`, {
    headers: { 'x-room-token': saved.token },
  })
  assert(response.ok)
  return response.json()
}

try {
  const desktopContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const phoneContext = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true })
  const desktop = await desktopContext.newPage()
  const phone = await phoneContext.newPage()
  for (const page of [desktop, phone]) {
    page.on('pageerror', error => errors.push(String(error)))
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  }
  await enterOnline(desktop, 'Ann', 'Guardian')
  const code = await desktop.locator('.online-lobby h1').textContent()
  assert(code)
  await enterOnline(phone, 'Bo', 'Ironclad', code)
  await desktop.locator('.online-seat', { hasText: 'Bo' }).waitFor()

  const room = rooms.store.rooms.get(code)
  assert(room)
  const desktopToken = (await credentials(desktop)).token
  const phoneToken = (await credentials(phone)).token
  const desktopPlayerId = room.seats.find(seat => seat.token === desktopToken)?.playerId
  const phonePlayerId = room.seats.find(seat => seat.token === phoneToken)?.playerId
  assert(desktopPlayerId && phonePlayerId)
  startRun(room, room.seats[0].token, { seed: 914, campaign: 'downfall' })
  const run = room.run
  for (const player of run.players) {
    player.character = 'guardian'
    player.guardianMode ??= 'attack'
  }
  const enemy = { uid: 'guardian-form-enemy', defId: 'jaw_worm', row: 0, isBoss: false, hp: 40, maxHp: 40,
    block: 0, strength: 0, vulnerable: 0, weak: 0, poison: 0, goldReward: 0, cardReward: null,
    actionIndex: 0, abilityUsed: false, dead: false }
  run.combat = createCombat(createRng(914), run.players, [enemy], 'guardian-online-form-choice')
  run.combat.phase = 'roundEnd'
  run.combat = startPlayerTurnWithChoices(run.combat)
  assert.equal(run.combat.phase, 'start')
  run.phase = 'combat'
  run.neow = null
  Object.assign(room, {
    startTurnCombatId: undefined,
    startTurnOrder: undefined,
    startTurnEnemyTargets: undefined,
    startTurnChoices: undefined,
    startTurnRequired: undefined,
    startTurnReady: undefined,
    startTurnStagedTriggers: undefined,
  })
  // Publish the already-started fixture atomically. Exposing roundEnd lets the
  // clients race to advance it and can skip the coordinator-first form prompt.
  room.version += 1
  rooms.publishRoom(code)
  const form = page => page.getByRole('group', { name: 'Choose Guardian form for this turn' })
  await form(desktop).waitFor()
  const actionPattern = '**/api/rooms/**/action'
  const roomPattern = `**/api/rooms/${code}`
  let failedRefreshes = 0
  await desktop.route(roomPattern, route => {
    if (route.request().method() === 'GET' && failedRefreshes < 3) {
      failedRefreshes += 1
      return route.abort('connectionreset')
    }
    return route.continue()
  })
  await desktop.route(actionPattern, route => route.abort('connectionreset'), { times: 1 })
  await desktop.getByRole('button', { name: 'Choose Defense Mode' }).evaluate(button => button.click())
  for (let attempt = 0; attempt < 50 && failedRefreshes < 3; attempt += 1) await desktop.waitForTimeout(100)
  assert.equal(failedRefreshes, 3, 'the unknown form choice did not exhaust reconciliation refreshes')
  await desktop.unroute(roomPattern)
  await form(desktop).waitFor()
  assert.deepEqual(await form(desktop).getByRole('button').evaluateAll(buttons =>
    buttons.map(button => button.disabled)), [false, false])
  assert(!((await snapshot(desktop)).startTurnDecided.includes(desktopPlayerId)),
    'the aborted form choice unexpectedly committed')

  let releaseStartTurn
  const startTurnReleased = new Promise(resolve => { releaseStartTurn = resolve })
  let interceptedStartTurn
  const startTurnIntercepted = new Promise(resolve => { interceptedStartTurn = resolve })
  await desktop.route(actionPattern, async route => {
    const body = route.request().postDataJSON()
    if (body?.action?.kind !== 'resolveStartTurn') return route.continue()
    interceptedStartTurn()
    await startTurnReleased
    await route.continue()
  })
  await desktop.getByRole('button', { name: 'Choose Defense Mode' }).evaluate(button => button.click())
  let timeout
  try {
    await Promise.race([
      startTurnIntercepted,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('resolveStartTurn request was not intercepted')), 30_000) }),
    ])
    assert.deepEqual(await form(desktop).getByRole('button').evaluateAll(buttons =>
      buttons.map(button => button.disabled)), [true, true])
    assert.equal(await desktop.getByRole('button', { name: /^Resolve start turn/ }).count(), 0)
  } finally {
    clearTimeout(timeout)
    releaseStartTurn()
  }
  let staged
  for (let attempt = 0; attempt < 40; attempt += 1) {
    staged = await snapshot(desktop)
    if (staged.startTurnDecided?.includes(desktopPlayerId)) break
    await desktop.waitForTimeout(50)
  }
  assert.equal(staged.run.combat.phase, 'start')
  assert(staged.startTurnDecided?.includes(desktopPlayerId), 'the Guardian form choice did not commit')
  assert(!staged.startTurnDecided?.includes(phonePlayerId),
    'the other Guardian form choice was incorrectly resolved')
  await form(phone).waitFor()
  assert.equal(await desktop.getByRole('button', { name: /^Resolve start turn/ }).count(), 0)
  for (let index = errors.length - 1; index >= 0; index -= 1) {
    if (errors[index].includes('ERR_CONNECTION_RESET')) errors.splice(index, 1)
  }
  assert.deepEqual(errors, [])
  console.log('Online Guardian form choice passed: pending assets lock and another owner\'s form choice does not block submission.')
} finally {
  await browser.close()
  await vite.close()
  await rooms.close()
}
