import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'vite'
import { chromium, setTestUsername } from './lib/profile-browser.mjs'
import { createRoomServer } from './room-server.mjs'
import { createRun } from '../src/game/run.ts'
import { EVENT_DEFINITIONS } from '../src/game/events.ts'

// Failure cases: repeat a completed question, replay its reward submission,
// reconnect while a teammate is still choosing, and keep that teammate's reward private.
const out = new URL('../artifacts/event-repeat-browser/', import.meta.url)
mkdirSync(out, { recursive: true })
const rooms = createRoomServer()
const address = await rooms.listen(0)
const roomOrigin = `http://127.0.0.1:${address.port}`
const vite = await createServer({ logLevel: 'silent', server: { port: 0, proxy: {
  '/api': { target: roomOrigin }, '/ws': { target: roomOrigin, ws: true },
} } })
const browser = await chromium.launch({ headless: true })
try {
  await vite.listen()
  const origin = `http://localhost:${vite.httpServer.address().port}`
  const a = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const b = await browser.newPage({ viewport: { width: 844, height: 390 } })
  const errors = []
  for (const page of [a, b]) page.on('pageerror', error => errors.push(String(error)))
  for (const page of [a, b]) page.setDefaultTimeout(15_000)
  async function enter(page, name, code) {
    await page.goto(origin)
    await setTestUsername(page, name)
    await page.getByRole('button', { name: 'Play online', exact: true }).click()
    await page.locator('.online-character-roster').getByRole('button', { name: code ? 'Silent' : 'Defect', exact: true }).click()
    if (code) await page.getByLabel('Room code').fill(code)
    await page.getByRole('button', { name: code ? 'Join' : 'Create room', exact: true }).click()
    await page.locator('.online-lobby').waitFor()
    return page.evaluate(() => JSON.parse(sessionStorage.getItem('sts-room-session')))
  }
  const saved = await enter(a, 'RepeatHost')
  const teammate = await enter(b, 'RepeatGuest', saved.code)
  const room = rooms.store.rooms.get(saved.code)
  room.phase = 'run'
  room.run = createRun(4242, room.seats.map(seat => ({ id: seat.playerId, name: seat.name, character: seat.character })))
  room.run.phase = 'room'
  room.run.neow = null
  room.run.players.forEach(player => { player.hp = 5 })
  room.run.roomState = { kind: 'event', card: { ...EVENT_DEFINITIONS.knowing_skull,
    instanceId: 'repeat-browser', act: 2, minAscension: 0, requiresColorlessUnlock: false }, decisions: {}, dieRolls: {} }
  room.version++
  rooms.publishRoom(saved.code)
  await a.getByRole('button', { name: /\[Success\?\]/ }).click()
  await a.getByRole('button', { name: 'Confirm chosen questions →' }).click()
  await a.locator('.reward-screen__cards .card').first().click()
  await a.getByText('Your choice is locked. Waiting for the party…', { exact: true }).waitFor()
  const resolved = structuredClone(room.run)
  assert(await a.getByRole('button', { name: 'Confirm chosen questions →' }).isDisabled(),
    'completed Knowing Skull still offers a repeat confirmation')
  for (const decision of [{ optionIds: ['success'] }, { optionIds: ['success'], rewardIndexes: [0] }]) {
    const response = await fetch(`${roomOrigin}/api/rooms/${saved.code}/action`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-room-token': saved.token },
      body: JSON.stringify({ action: { kind: 'event', playerId: room.seats[0].playerId, decision } }),
    })
    assert(!response.ok, 'server accepted an already completed Event')
    assert.deepEqual(room.run, resolved, 'repeat submission changed supplies, HP, or reward stages')
  }
  await a.reload()
  await a.getByText('Your choice is locked. Waiting for the party…', { exact: true }).waitFor()
  // Reproduce the already-persisted, card-only phantom stage from the reported room.
  const actor = room.seats[0].playerId
  room.run.roomState.pendingDecisions[actor] = { optionIds: ['success'] }
  room.run.roomState.rewardOffers[actor] = [room.run.players[0].cardRewards.slice(0, 3)]
  room.run.roomState.guardianGemOffers[actor] = [[]]
  room.version++
  rooms.publishRoom(saved.code)
  await a.locator('.reward-screen__cards .card').first().click()
  await a.getByText('Your choice is locked. Waiting for the party…', { exact: true }).waitFor()
  assert.deepEqual(room.run, resolved, 'phantom-stage recovery changed the completed reward or supplies')
  await a.screenshot({ path: new URL('desktop-locked.png', out).pathname, fullPage: true })
  await b.getByRole('button', { name: /\[Success\?\]/ }).click()
  await b.getByRole('button', { name: 'Confirm chosen questions →' }).click()
  await b.locator('.reward-screen--card-choice').waitFor()
  assert.equal(await a.locator('.reward-screen--card-choice').count(), 0, 'teammate reward leaked to the completed player')
  await b.waitForFunction(() => {
    const picker = document.querySelector('.reward-screen--card-choice')
    return picker && [...picker.querySelectorAll('img')].every(image => image.complete) &&
      picker.getAnimations({ subtree: true }).every(animation =>
        animation.playState !== 'running' || animation.effect.getTiming().iterations === Infinity)
  })
  await b.screenshot({ path: new URL('phone-private-reward.png', out).pathname, fullPage: true })
  await b.locator('.reward-screen__cards .card').first().click()
  await a.locator('.event-stage').waitFor({ state: 'detached' })
  await b.locator('.event-stage').waitFor({ state: 'detached' })
  assert.equal(room.run.phase, 'map')
  assert(room.run.players.every(player => player.hp === 4), 'Event cost was charged more than once')
  assert.deepEqual(errors, [])
  writeFileSync(new URL('result.json', out), JSON.stringify({ passed: true,
    cases: ['completed UI locked', 'repeat question rejected', 'repeat reward rejected',
      'reconnect preserved', 'existing phantom recovered without changing run',
      'private teammate reward', 'both players resume map'],
    hp: room.run.players.map(player => player.hp), teammate: teammate.code === saved.code }, null, 2))
  console.log('PASS Event repeat/reconnect browser; artifacts/event-repeat-browser/result.json')
} finally {
  await browser.close()
  await vite.close()
  await rooms.close()
}
