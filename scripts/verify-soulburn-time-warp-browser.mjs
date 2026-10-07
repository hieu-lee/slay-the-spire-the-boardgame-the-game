import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'vite'
import { chromium, setTestUsername } from './lib/profile-browser.mjs'
import { createRoomServer } from './room-server.mjs'
import { createRun } from '../src/game/run.ts'
import { createCombat } from '../src/game/combat.ts'
import { createRng } from '../src/game/rng.ts'

// Failure cases: capped cards also hide/refuse non-card tokens; tokens increment
// the card count; reconnect loses tokens; invalid/off-turn spending works.
for (const resource of ['shivs', 'soulburn']) {
  const shiv = resource === 'shivs'
  const label = shiv ? 'Shiv' : 'Soulburn'
  const actionKind = shiv ? 'spendShiv' : 'spendSoulburn'
  const damage = shiv ? 8 : 4 // Shiv bonus + Strength; Weak and Vulnerable cancel.
  const out = new URL(`../artifacts/${shiv ? 'shiv' : 'soulburn'}-time-warp-browser/`, import.meta.url)
  mkdirSync(out, { recursive: true })
  const rooms = createRoomServer()
  const address = await rooms.listen(0)
  const roomOrigin = `http://127.0.0.1:${address.port}`
  const vite = await createServer({ logLevel: 'silent', server: { host: '127.0.0.1', port: 0,
    watch: { ignored: ['**/artifacts/**'] }, proxy: {
    '/api': { target: roomOrigin }, '/ws': { target: roomOrigin, ws: true },
  } } })
  const browser = await chromium.launch({ headless: true })
  try {
    await vite.listen()
    const origin = `http://127.0.0.1:${vite.httpServer.address().port}`
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    const guest = await browser.newPage({ viewport: { width: 844, height: 390 } })
    const errors = []
    for (const tab of [page, guest]) {
      tab.setDefaultTimeout(30_000)
      tab.on('pageerror', error => errors.push(String(error)))
    }
    async function enter(tab, name, code) {
      await tab.goto(origin, { waitUntil: 'domcontentloaded' })
      await setTestUsername(tab, name)
      await tab.getByRole('button', { name: 'Play online', exact: true }).click()
      await tab.locator('.online-character-roster').getByRole('button', { name: code ? 'Silent' : 'Defect', exact: true }).click()
      if (code) await tab.getByLabel('Room code').fill(code)
      await tab.getByRole('button', { name: code ? 'Join' : 'Create room', exact: true }).click()
      await tab.locator('.online-lobby').waitFor()
      return tab.evaluate(() => JSON.parse(sessionStorage.getItem('sts-room-session')))
    }
    const saved = await enter(page, 'WarpHex')
    await enter(guest, 'WarpGuest', saved.code)
    const room = rooms.store.rooms.get(saved.code)
    room.seats[0].character = shiv ? 'silent' : 'hexaghost'
    room.phase = 'run'
    room.run = createRun(4242, room.seats.map(seat => ({ id: seat.playerId, name: seat.name, character: seat.character })))
    room.run.phase = 'combat'
    room.run.act = 3
    room.run.neow = null
    room.run.combat = createCombat(createRng(47), room.run.players, [{
      uid: 'time', defId: 'time_eater', row: 0, isBoss: true, hp: 100, maxHp: 120,
      block: 0, strength: 0, vulnerable: 3, weak: 0, poison: 0, goldReward: 0,
      cardReward: null, actionIndex: 2, abilityUsed: true, dead: false,
    }])
    const actor = room.run.combat.players[0]
    Object.assign(actor, { hand: [{ uid: 'blocked-defend', defId: shiv ? 'defend_silent' : 'defend_hexaghost', upgraded: false }],
      heat: 4, [resource]: 2, shivDamageBonus: 1, cardsPlayedThisTurn: 3, strength: 6, weak: 2 })
    room.run.combat.phase = 'player'
    room.run.combat.turn = 6
    room.endTurnReady = { [actor.id]: true, [room.seats[1].playerId]: false }
    room.version++
    rooms.publishRoom(saved.code)
    const token = () => page.getByRole('button', { name: shiv ? 'Use Shiv' : /^Spend Soulburn,/ })
    await token().waitFor()
    assert(await page.locator('.hand .card').first().isDisabled(), 'Time Warp no longer caps ordinary cards')
    async function refuse(action) {
      const before = structuredClone(room.run)
      const response = await fetch(`${roomOrigin}/api/rooms/${saved.code}/action`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-room-token': saved.token },
        body: JSON.stringify({ action }),
      })
      assert(!response.ok, `illegal action accepted: ${JSON.stringify(action)}`)
      assert.deepEqual(room.run, before, 'refused action changed the run')
    }
    await refuse({ kind: 'playCard', cardUid: 'blocked-defend', preflight: true })
    await refuse({ kind: actionKind, enemyUid: 'missing-target' })
    await page.screenshot({ path: new URL('desktop-token-at-cap.png', out).pathname, fullPage: true })
    await token().click()
    await page.getByRole('button', { name: /^Time Eater,/ }).locator('.enemy__hit-area').click()
    await page.locator(shiv ? '[aria-label="Use Shiv"][aria-pressed="false"]'
      : '[aria-label="Spend Soulburn, 1 available"]').waitFor()
    await guest.getByRole('button', { name: new RegExp(`^Time Eater, ${100 - damage} of`) }).waitFor()
    assert.equal(room.run.combat.players[0][resource], 1)
    assert.equal(room.run.combat.enemies[0].hp, 100 - damage, `${label} damage/modifiers changed`)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await token().waitFor()
    await page.setViewportSize({ width: 844, height: 390 })
    await page.screenshot({ path: new URL('phone-token-after-reconnect.png', out).pathname, fullPage: true })
    await token().click()
    await page.getByRole('button', { name: /^Time Eater,/ }).locator('.enemy__hit-area').click()
    await token().waitFor({ state: 'detached' })
    assert.equal(room.run.combat.enemies[0].hp, 100 - 2 * damage)
    assert.equal(room.run.combat.players[0].cardsPlayedThisTurn, 3)
    assert.equal(room.run.combat.players[0].attacksPlayedThisTurn, shiv ? 2 : 0)
    assert.equal(room.run.combat.players[0].energy, 3)
    assert.equal(room.run.combat.turn, 6)
    await refuse({ kind: actionKind, enemyUid: 'time' })
    for (const blocked of [{ phase: 'enemy' }, { cardPlayLocked: true }, { dead: true }]) {
      room.run.combat.players[0][resource] = 1
      if (blocked.phase) room.run.combat.phase = blocked.phase
      else Object.assign(room.run.combat.players[0], blocked)
      await refuse({ kind: actionKind, enemyUid: 'time' })
      room.run.combat.phase = 'player'
      Object.assign(room.run.combat.players[0], { cardPlayLocked: false, dead: false })
    }
    assert.deepEqual(errors, [])
    writeFileSync(new URL('result.json', out), JSON.stringify({ passed: true,
      cardsPlayed: 3, resource, tokenDamage: 2 * damage, turn: 6,
      cases: ['ordinary cards capped', 'invalid target refused', `two ${label}s after cap`,
        'reconnect and horizontal phone', 'card counter unchanged; Shivs count as Attacks',
        'empty, off-turn, locked and dead spending refused', 'already-ready owner can spend'] }, null, 2))
    console.log(`PASS ${label}/Time Warp browser; ${new URL('result.json', out).pathname}`)
  } finally {
    await browser.close()
    await vite.close()
    await rooms.close()
  }
}
