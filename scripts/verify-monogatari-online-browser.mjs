#!/usr/bin/env node
// Failure contract: docs/monogatari-skins/noncombat-failure-modes.md (online section).
// Real two-seat room sessions verify public cosmetic state without exposing private cards.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium, setTestUsername } from './lib/profile-browser.mjs'
import { createRoomServer } from './room-server.mjs'
import { createCombat, preparePlayerTurn } from '../src/game/combat.ts'
import { createRng } from '../src/game/rng.ts'

const root = resolve(import.meta.dirname, '..')
const output = join(root, 'artifacts/monogatari-online')
mkdirSync(output, { recursive: true })
const rooms = createRoomServer()
const address = await rooms.listen(0)
const vite = await createServer({ root, logLevel: 'silent', server: { host: '127.0.0.1', port: 0, proxy: {
  '/api': { target: `http://127.0.0.1:${address.port}` },
  '/ws': { target: `http://127.0.0.1:${address.port}`, ws: true },
} } })
await vite.listen()
const origin = `http://127.0.0.1:${vite.httpServer.address().port}`
const browser = await chromium.launch({ headless: true })
const report = { command: 'node scripts/verify-monogatari-online-browser.mjs', scenarios: [], errors: [] }
const contexts = new Set()

async function context(viewport, username, character, skin) {
  const context = await browser.newContext({ viewport, isMobile: viewport.width < 900, hasTouch: viewport.width < 900,
    recordVideo: { dir: output, size: viewport } })
  contexts.add(context)
  await context.addInitScript(({ username, character, skin }) => {
    localStorage.setItem('sts-profile', JSON.stringify({ username, token: '00000000-0000-4000-8000-000000000001', secured: true }))
    if (skin) {
      localStorage.setItem(`sts-skins:${username.toLowerCase()}`, JSON.stringify({ [character]: skin }))
      localStorage.setItem(`sts-wallet:${username.toLowerCase()}`, JSON.stringify({ version: 1, coins: 0,
        packs: [], skins: [skin], credited: {} }))
    }
  }, { username, character, skin })
  const page = await context.newPage()
  page.on('pageerror', error => report.errors.push(String(error)))
  page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()) })
  return [context, page]
}

async function decode(page, selector) {
  return page.locator(selector).first().evaluate(async image => {
    await image.decode()
    if (!image.naturalWidth) throw new Error('Image did not decode')
    return image.currentSrc
  })
}

async function shot(page, name) {
  // Snapshot the settled hand, not an in-flight opening deal with overlapping card faces.
  await page.waitForFunction(() => !document.querySelector('.hand .card--drawn'))
  await page.locator('img').evaluateAll(async images => {
    await Promise.all(images.filter(image => {
      const box = image.getBoundingClientRect(), style = getComputedStyle(image)
      return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0
    }).map(image => image.decode()))
  })
  await page.screenshot({ path: join(output, `${name}.png`) })
}

async function snapshot(page) {
  return page.evaluate(async () => {
    const saved = JSON.parse(sessionStorage.getItem('sts-room-session'))
    const response = await fetch(`/api/rooms/${saved.code}`, { headers: { 'x-room-token': saved.token } })
    if (!response.ok) throw new Error(`Snapshot failed: ${response.status}`)
    return response.json()
  })
}

async function campfire(page, skin) {
  await page.locator(`.campfire__sitter[data-visual="${skin}"]`).waitFor()
  await page.locator('.campfire__sitter').evaluateAll((sitters) => Promise.all(sitters.map((image) => image.decode())))
  // Seat order depends on the room; compare the party sorted by visual id.
  return page.locator('.campfire__sitter').evaluateAll((sitters) =>
    sitters.map((image) => [image.dataset.visual, image.naturalWidth, image.naturalHeight]).sort())
}

try {
  for (const [screen, viewport] of [['desktop', { width: 1440, height: 900 }], ['horizontal-phone', { width: 844, height: 390 }]]) {
    for (const [character, label, skin] of [['ironclad', 'Ironclad', 'monogatari_ironclad'], ['defect', 'Defect', 'monogatari_defect']]) {
      const prefix = `${screen}-${skin}`
      const [ownerContext, owner] = await context(viewport, 'Ann', character, skin)
      const [viewerContext, viewer] = await context(viewport, 'Bo', 'silent')
      const entry = { screen, viewport, character, skin, assertions: [], screenshots: [], recordings: [] }
      for (const [page, username] of [[owner, 'Ann'], [viewer, 'Bo']]) {
        await page.goto(origin, { waitUntil: 'networkidle' })
        await setTestUsername(page, username)
        await page.getByRole('button', { name: 'Play online', exact: true }).click()
      }
      await owner.locator('.online-character-roster').getByRole('button', { name: label, exact: true }).click()
      assert((await decode(owner, `.online-character-roster button[aria-label="${label}"] img`)).endsWith(`portrait-${skin}.png`))
      await owner.getByRole('button', { name: 'Create room', exact: true }).click()
      await owner.locator('.online-lobby').waitFor()
      const code = (await owner.locator('.online-lobby h1').textContent()).trim()
      await viewer.locator('.online-character-roster').getByRole('button', { name: 'Silent', exact: true }).click()
      await viewer.getByLabel('Room code').fill(code)
      await viewer.getByRole('button', { name: 'Join', exact: true }).click()
      await viewer.locator('.online-lobby').waitFor()
      const room = rooms.store.rooms.get(code)
      assert.deepEqual(room.seats.map(seat => [seat.character, seat.skin ?? null]), [[character, skin], ['silent', null]])
      for (const page of [owner, viewer]) {
        assert((await decode(page, '.online-seat:has-text("Ann") .online-seat__portrait img')).endsWith(`/combat/characters/${skin}.webp`))
        assert((await decode(page, '.online-seat:has-text("Bo") .online-seat__portrait img')).endsWith('/combat/characters/silent.webp'))
      }
      await shot(viewer, `${prefix}-lobby`)
      entry.screenshots.push(`${prefix}-lobby.png`)
      entry.assertions.push('owned entry/lobby art and authoritative character+skin are correct for both seats')

      await owner.evaluate(() => {
        localStorage.removeItem('sts-skins:ann')
        window.dispatchEvent(new Event('sts-skin-change'))
      })
      await viewer.waitForFunction(character => document.querySelector('.online-seat:nth-child(1) .online-seat__portrait img')
        ?.src.endsWith(`/combat/characters/${character}.webp`), character)
      assert.equal(room.seats[0].skin, undefined)
      await owner.evaluate(({ character, skin }) => {
        localStorage.setItem('sts-skins:ann', JSON.stringify({ [character]: skin }))
        window.dispatchEvent(new Event('sts-skin-change'))
      }, { character, skin })
      await viewer.waitForFunction(skin => document.querySelector('.online-seat:nth-child(1) .online-seat__portrait img')
        ?.src.endsWith(`/combat/characters/${skin}.webp`), skin)
      assert.equal(room.seats[0].character, character)
      assert.equal(room.seats[0].skin, skin)
      entry.assertions.push('live default/skin lobby choice publishes without altering character')

      await owner.getByRole('button', { name: 'Enter the Spire', exact: true }).click()
      await owner.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
      await owner.getByRole('heading', { name: 'Neow’s Blessing' }).waitFor()
      await viewer.getByRole('heading', { name: 'Neow’s Blessing' }).waitFor()
      assert.equal(room.run.players[0].character, character)
      assert.equal(room.run.players[0].skin, skin)
      assert.equal(room.run.players[1].skin, undefined)
      room.run = { ...room.run, phase: 'combat', neow: null,
        combat: preparePlayerTurn(createCombat(createRng(63), room.run.players, [{ uid: 'anime-online-enemy',
          defId: 'jaw_worm', row: 0, isBoss: false, hp: 30, maxHp: 30, block: 0, strength: 0,
          vulnerable: 0, weak: 0, poison: 0, actionIndex: 0, abilityUsed: true, dead: false }], prefix)) }
      room.version += 1
      rooms.publishRoom(code)
      for (const page of [owner, viewer]) {
        await page.locator(`.seat__interactive[data-player-id="p1"][data-character="${skin}"]`).waitFor()
        assert.equal(await page.locator('.seat__interactive[data-player-id="p2"]').getAttribute('data-character'), 'silent')
      }
      await viewer.locator('.hand .card__art').first().waitFor()
      const viewerFaces = await viewer.locator('.hand .card__art').evaluateAll(images => images.map(image => image.currentSrc))
      assert(viewerFaces.length > 0 && viewerFaces.every(source => !source.includes('/skin-cards-sm/')), 'Silent hand must not inherit teammate card skin')
      const ownerFaces = await owner.locator('.hand .card__art').evaluateAll(images => images.map(image => image.currentSrc))
      assert(ownerFaces.some(source => source.includes(`/skin-cards-sm/${skin}/`)), 'Owner hand must show owned skin faces')
      for (const [page, myId, otherId] of [[owner, 'p1', 'p2'], [viewer, 'p2', 'p1']]) {
        const state = await snapshot(page)
        const mine = state.run.combat.players.find(player => player.id === myId)
        const other = state.run.combat.players.find(player => player.id === otherId)
        assert(mine.hand.length > 0 && mine.deck.length > 0)
        assert.equal(other.hand, null)
        assert.equal(other.draw, null)
        assert.equal(other.deck, null)
        assert(other.handCount > 0)
      }
      await shot(owner, `${prefix}-combat-owner`)
      await shot(viewer, `${prefix}-combat-viewer`)
      entry.screenshots.push(`${prefix}-combat-owner.png`, `${prefix}-combat-viewer.png`)
      entry.assertions.push('public combat skin preserves default Silent hand; both snapshots conceal teammate hand/draw/deck')
      await viewer.reload({ waitUntil: 'networkidle' })
      await viewer.locator(`.seat__interactive[data-player-id="p1"][data-character="${skin}"]`).waitFor()
      assert.equal((await snapshot(viewer)).run.combat.players[0].hand, null)
      await shot(viewer, `${prefix}-reconnect`)
      entry.screenshots.push(`${prefix}-reconnect.png`)
      entry.assertions.push('combat reconnect preserves public skin and private hand boundary')

      const camp = structuredClone(room.run), campId = camp.map.rows[0][0]
      camp.phase = 'room'; camp.combat = null; camp.map.position = campId; camp.map.rooms[campId].kind = 'campfire'
      room.run = camp
      room.version += 1
      rooms.publishRoom(code)
      for (const page of [owner, viewer]) {
        assert.deepEqual(await campfire(page, skin), [['silent', 1408, 1808], [skin, 1408, 1808]].sort())
      }
      await shot(viewer, `${prefix}-campfire`)
      entry.screenshots.push(`${prefix}-campfire.png`)
      await viewer.reload({ waitUntil: 'networkidle' })
      assert.deepEqual(await campfire(viewer, skin), [['silent', 1408, 1808], [skin, 1408, 1808]].sort())
      await shot(viewer, `${prefix}-campfire-reconnect`)
      entry.screenshots.push(`${prefix}-campfire-reconnect.png`)
      entry.assertions.push('both seats see the skin party seated at the campfire; reconnect keeps it')
      const ownerVideo = owner.video(), viewerVideo = viewer.video()
      await ownerContext.close(); contexts.delete(ownerContext)
      await viewerContext.close(); contexts.delete(viewerContext)
      for (const [video, who] of [[ownerVideo, 'owner'], [viewerVideo, 'viewer']]) {
        const name = `${prefix}-${who}.webm`
        await video.saveAs(join(output, name))
        await video.delete()
        entry.recordings.push(name)
      }
      report.scenarios.push(entry)
      console.log(`PASS ${prefix}: lobby, private hands, combat/campfire reconnect`)
    }
  }
  assert.deepEqual(report.errors, [])
} finally {
  for (const context of contexts) await context.close()
  await browser.close()
  await vite.close()
  await rooms.close()
  writeFileSync(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
}
console.log('✓ Monogatari online cosmetic/private-state E2E, 4 scenarios with 8 recordings')
