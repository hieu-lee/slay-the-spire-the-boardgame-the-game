import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { chromium, setTestUsername } from './lib/profile-browser.mjs'
import { createServer } from 'vite'
import { createRun } from '../src/game/run.ts'
import { createCombat } from '../src/game/combat.ts'
import { createRoomServer } from './room-server.mjs'

const out = 'artifacts/pantograph-browser'
mkdirSync(out, { recursive: true })
const rooms = createRoomServer()
const roomAddress = await rooms.listen(0)
const server = await createServer({ logLevel: 'silent', server: { port: 0, proxy: {
  '/api': { target: `http://127.0.0.1:${roomAddress.port}` },
  '/ws': { target: `http://127.0.0.1:${roomAddress.port}`, ws: true },
} } })
const browser = await chromium.launch({ headless: true })
const errors = []
try {
  await server.listen()
  for (const [name, width, height] of [['desktop', 1440, 900], ['phone-landscape', 844, 390]]) {
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce', hasTouch: name !== 'desktop' })
    page.on('pageerror', (error) => errors.push(String(error)))
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
    await page.goto(`http://localhost:${server.httpServer.address().port}`)
    await page.getByRole('button', { name: 'Single Player', exact: true }).click()
    await page.getByRole('button', { name: 'Standard', exact: true }).click()
    await page.getByRole('button', { name: 'Embark' }).click()
    await page.getByRole('button', { name: 'Start Downfall campaign', exact: true }).click()
    await page.waitForFunction(() => window.__STS_DEBUG__?.getRun()?.phase === 'neow')
    const viewerId = await page.evaluate(() => window.__STS_DEBUG__.getRun().players[0].id)
    const run = createRun(920, [{ id: viewerId, name: 'Ironclad', character: 'ironclad' }])
    run.players[0].hp = 4
    run.players[0].maxHp = 8
    run.players[0].relics.push({ defId: 'pantograph', spent: false })
    run.combat = createCombat({ seed: 920, calls: 0 }, run.players, [{
      uid: 'boss', defId: 'slime_boss', row: 0, isBoss: true, hp: 50, maxHp: 50,
      block: 0, strength: 0, vulnerable: 0, weak: 0, poison: 0, actionIndex: 0, abilityUsed: false, dead: false,
    }], 'pantograph-header')
    run.phase = 'combat'
    run.neow = null
    await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), run)
    await page.getByRole('img', { name: 'Health 8 of 8', exact: true }).waitFor({ timeout: 5_000 })
    assert.equal(await page.getByRole('img', { name: 'Health 4 of 8', exact: true }).count(), 0)
    await page.screenshot({ path: `${out}/${name}.png` })
    await page.close()

    const online = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce', hasTouch: name !== 'desktop' })
    online.on('pageerror', (error) => errors.push(String(error)))
    online.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
    await online.goto(`http://localhost:${server.httpServer.address().port}`)
    await setTestUsername(online, `Pantograph ${name}`)
    await online.getByRole('button', { name: 'Play online', exact: true }).click()
    await online.getByRole('button', { name: 'Ironclad', exact: true }).click()
    await online.getByRole('button', { name: 'Create room', exact: true }).click()
    const code = await online.locator('.online-lobby__code h1').textContent()
    await online.getByRole('button', { name: 'Enter the Spire', exact: true }).click()
    await online.getByRole('button', { name: 'Start Downfall campaign', exact: true }).click()
    await online.locator('.neow-screen').waitFor()
    const room = rooms.store.rooms.get(code)
    const player = room.run.players[0]
    player.hp = 4
    player.maxHp = 8
    player.relics.push({ defId: 'pantograph', spent: false })
    room.run.combat = createCombat({ seed: 921, calls: 0 }, room.run.players, [{
      uid: 'boss', defId: 'slime_boss', row: 0, isBoss: true, hp: 50, maxHp: 50,
      block: 0, strength: 0, vulnerable: 0, weak: 0, poison: 0, actionIndex: 0, abilityUsed: false, dead: false,
    }], 'pantograph-online-header')
    room.run.phase = 'combat'
    room.run.neow = null
    room.version += 1
    rooms.publishRoom(code)
    await online.getByRole('img', { name: 'Health 8 of 8', exact: true }).waitFor({ timeout: 5_000 })
    assert.equal(await online.getByRole('img', { name: 'Health 4 of 8', exact: true }).count(), 0)
    await online.screenshot({ path: `${out}/${name}-online.png` })
    await online.close()
  }
  assert.deepEqual(errors, [])
  console.log('Pantograph header passed: solo and online combat HP are shown on desktop and horizontal phone.')
} finally {
  await browser.close()
  await server.close()
  await rooms.close()
}
