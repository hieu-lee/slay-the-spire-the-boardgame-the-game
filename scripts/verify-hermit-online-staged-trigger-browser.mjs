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

try {
  const hermitPage = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
  const peerPage = await (await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true })).newPage()
  for (const page of [hermitPage, peerPage]) {
    page.on('pageerror', error => errors.push(String(error)))
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  }
  await enterOnline(hermitPage, 'Ann', 'Ironclad')
  const code = await hermitPage.locator('.online-lobby h1').textContent()
  assert(code)
  await enterOnline(peerPage, 'Bo', 'Silent', code)
  await hermitPage.locator('.online-seat', { hasText: 'Bo' }).waitFor()

  const room = rooms.store.rooms.get(code)
  assert(room)
  const hermitToken = (await credentials(hermitPage)).token
  const hermitId = room.seats.find(seat => seat.token === hermitToken)?.playerId
  assert(hermitId)
  startRun(room, room.seats[0].token, { seed: 915, campaign: 'downfall' })
  const run = room.run
  const enemy = { uid: 'staged-enemy', defId: 'jaw_worm', row: 0, isBoss: false, hp: 40, maxHp: 40,
    block: 0, strength: 0, vulnerable: 0, weak: 0, poison: 0, goldReward: 0, cardReward: null,
    actionIndex: 0, abilityUsed: false, dead: false }
  run.combat = createCombat(createRng(915), run.players, [enemy], 'hermit-online-staged-trigger')
  run.combat.pendingHermitSetupLoads = []
  for (const player of run.combat.players) Object.assign(player, { relics: [], powers: [], hand: [], draw: [], discard: [] })
  Object.assign(run.combat.players.find(player => player.id === hermitId), {
    character: 'hermit', chamberSlots: 2,
    chamber: [{ uid: 'staged-strike', defId: 'hermit_strike', upgraded: false },
      { uid: 'staged-defend', defId: 'hermit_defend', upgraded: false }],
    powers: [{ uid: 'staged-called-shot', defId: 'hermit_called_shot', upgraded: false }],
  })
  run.combat.phase = 'roundEnd'
  run.combat = startPlayerTurnWithChoices(run.combat)
  assert.equal(run.combat.phase, 'start')
  run.phase = 'combat'
  run.neow = null
  Object.assign(room, {
    startTurnCombatId: undefined, startTurnOrder: undefined, startTurnEnemyTargets: undefined,
    startTurnChoices: undefined, startTurnRequired: undefined, startTurnReady: undefined,
    startTurnStagedTriggers: undefined,
  })
  room.version += 1
  rooms.publishRoom(code)

  const dialog = hermitPage.getByRole('dialog', { name: "Ann's Called Shot" })
  await dialog.waitFor()
  await dialog.getByText('Choose 1 Chamber card to cost 0 this turn').waitFor()
  assert.equal(await peerPage.getByRole('dialog', { name: "Ann's Called Shot" }).count(), 0)
  await dialog.locator('.card[title="Strike"]').click()
  await dialog.getByRole('button', { name: 'Discount Strike' }).click()
  const edit = hermitPage.getByRole('button', { name: "Edit Ann's Called Shot" })
  await edit.waitFor()
  assert(room.startTurnStagedTriggers?.some(trigger => trigger.playerId === hermitId),
    'Called Shot was not staged for the Start of Turn confirmation')
  await edit.click()
  await dialog.waitFor()
  const strike = dialog.locator('.card[title="Strike"]')
  assert.equal(await strike.getAttribute('aria-pressed'), 'true', 'editing a staged trigger lost its saved pick')
  room.version += 1
  rooms.publishRoom(code)
  await hermitPage.waitForFunction(async (version) => {
    const saved = JSON.parse(sessionStorage.getItem('sts-room-session'))
    const response = await fetch(`/api/rooms/${saved.code}`, { headers: { 'x-room-token': saved.token } })
    return (await response.json()).version >= version
  }, room.version)
  await hermitPage.waitForTimeout(300)
  assert(await dialog.isVisible(), 'a room publish closed the staged-trigger edit dialog')
  assert.equal(await strike.getAttribute('aria-pressed'), 'true', 'a room publish reset the staged-trigger pick')
  await dialog.locator('.card[title="Defend"]').click()
  await dialog.getByRole('button', { name: 'Discount Defend' }).click()
  await edit.waitFor()
  const saved = room.startTurnChoices?.find(choice => choice.id === `${hermitId}/power:staged-called-shot`)
  assert.deepEqual(saved?.trigger?.chamberUids, ['staged-defend'], 'the edited staged pick was not saved')
  assert.deepEqual(errors, [])
  console.log('Online Hermit staged trigger passed: private dialog, staged edit keeps its pick across a room publish, and re-saves.')
} finally {
  await browser.close()
  await vite.close()
  await rooms.close()
}
