#!/usr/bin/env node
// The Kratos skin of Ironclad in the real app, on desktop and horizontal-phone screens:
// character select, the Neow scene, a campfire, combat in a solo run, and an online room
// where the teammate sees the other seat's skin (lobby seat list and the run's seat).
// The treasure hand, merchant standing and attack animation have their own focused verifiers
// (verify-treasure-animation-browser, verify-merchant-overflow-browser, verify-kratos-animation-browser).
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium, setTestUsername } from './lib/profile-browser.mjs'
import { createRoomServer } from './room-server.mjs'
import { postNeowRun } from './lib/post-neow-run.mjs'
import { createCombat, preparePlayerTurn } from '../src/game/combat.ts'
import { createRng } from '../src/game/rng.ts'
import { createRun } from '../src/game/run.ts'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'artifacts/skin-browser')
mkdirSync(output, { recursive: true })
const rooms = createRoomServer()
const roomAddress = await rooms.listen(0)
const vite = await createServer({ root, logLevel: 'silent', server: { host: '127.0.0.1', port: 0, proxy: {
  '/api': { target: `http://127.0.0.1:${roomAddress.port}` },
  '/ws': { target: `http://127.0.0.1:${roomAddress.port}`, ws: true },
} } })
await vite.listen()
const origin = `http://127.0.0.1:${vite.httpServer.address().port}`
const browser = await chromium.launch({ headless: true })
const errors = []
const SCREENS = [['desktop', { width: 1440, height: 900 }], ['horizontal-phone', { width: 844, height: 390 }]]

// A context signed in as `username`, who has (or has not) chosen the Kratos skin in Profile.
/** `skin` is the choice stored in Profile; the account's wallet owns it unless `owned` is false (a stale choice). */
async function openContext(viewport, username, skin, owned = true) {
  const context = await browser.newContext({ viewport, isMobile: viewport.width < 900, hasTouch: viewport.width < 900 })
  await context.addInitScript(({ username, skin, owned }) => {
    localStorage.setItem('sts-profile', JSON.stringify({ username, token: '00000000-0000-4000-8000-000000000001', secured: true }))
    if (skin) localStorage.setItem(`sts-skins:${username.toLowerCase()}`, JSON.stringify({ ironclad: skin }))
    // Only an owned skin can be worn: the account bought it (the Shop's Skins tab).
    const wallet = `sts-wallet:${username.toLowerCase()}`
    if (skin && owned && !localStorage.getItem(wallet)) {
      localStorage.setItem(wallet, JSON.stringify({ version: 1, coins: 0, packs: [], skins: [skin], addPacksToRuns: true, credited: {} }))
    }
  }, { username, skin, owned })
  return context
}
const watch = (page) => {
  page.on('pageerror', (error) => errors.push(String(error)))
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  return page
}
const decoded = (page, selector) => page.locator(selector).first().evaluate(async (image) => {
  await image.decode()
  return image.naturalWidth > 0 ? image.currentSrc : ''
})

async function characterSelect(page) {
  await page.goto(origin, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Single Player', exact: true }).click()
  await page.getByRole('button', { name: 'Standard', exact: true }).click()
  await page.locator('.start-menu__character-roster').waitFor()
}

try {
  for (const [screen, viewport] of SCREENS) {
    // Solo, skin chosen: character select, Neow, campfire and combat all show Kratos.
    const skinned = await openContext(viewport, 'Skinner', 'kratos')
    const page = watch(await skinned.newPage())
    await characterSelect(page)
    assert.match(await decoded(page, '.start-menu__character-roster button[aria-label="Ironclad"] img'), /portrait-kratos\.png$/,
      `${screen}: Ironclad's portrait wears the skin`)
    assert.match(await decoded(page, '.start-menu__character-roster button[aria-label="Silent"] img'), /portrait-silent\.png$/,
      `${screen}: only Ironclad has a skin`)
    assert.match(await decoded(page, '.start-menu__character-wallpaper'), /character-kratos-wallpaper\.webp$/, `${screen}: the wallpaper follows the skin`)
    assert.equal(await page.getByRole('heading', { name: 'Ironclad' }).count(), 1, `${screen}: the hero is still named Ironclad`)
    assert.equal(await page.getByRole('button', { name: 'Kratos' }).count(), 0, `${screen}: Kratos is no character`)
    await page.screenshot({ path: resolve(output, `${screen}-character-select-skinned.png`) })
    await page.getByRole('button', { name: 'Embark', exact: true }).click()
    await page.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
    await page.waitForFunction(() => window.__STS_DEBUG__?.getRun().phase === 'neow')
    assert.equal(await page.evaluate(() => window.__STS_DEBUG__.getRun().players[0].skin), 'kratos', `${screen}: the run carries the skin`)
    assert.equal(await page.evaluate(() => window.__STS_DEBUG__.getRun().players[0].character), 'ironclad')
    assert.match(await decoded(page, '.neow-screen__hero'), /kratos-hero\.webp$/, `${screen}: the Neow scene shows the skin`)

    // Campfire: the scene is the skin's, not Ironclad's.
    const fixture = postNeowRun(61, [{ id: 'p1', name: 'Ironclad', character: 'ironclad', skin: 'kratos' }])
    const campfire = structuredClone(fixture)
    const roomId = campfire.map.rows[0][0]
    Object.assign(campfire, { phase: 'room' })
    campfire.map.position = roomId
    campfire.map.rooms[roomId].kind = 'campfire'
    await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), campfire)
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.campfire') ?? document.body).backgroundImage.includes('kratos_firecamp.webp'))
    await page.screenshot({ path: resolve(output, `${screen}-campfire-skinned.png`) })

    // Combat: the seat is drawn as Kratos, with the character underneath still Ironclad.
    const enemy = { uid: 'enemy-0', defId: 'jaw_worm', row: 0, isBoss: false, hp: 30, maxHp: 30, block: 0, strength: 0,
      vulnerable: 0, weak: 0, poison: 0, actionIndex: 0, abilityUsed: true, dead: false }
    const fight = { ...structuredClone(fixture), phase: 'combat' }
    fight.combat = preparePlayerTurn(createCombat(createRng(62), fight.players, [enemy], 'skin-browser'))
    await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), fight)
    await page.locator('.seat__interactive[data-character="kratos"]').waitFor()
    assert.match(await decoded(page, '.seat__portrait > img'), /\/kratos-idle\.webp$|\/kratos-hero\.webp$/, `${screen}: combat idle is Kratos`)
    assert.equal(await page.locator('.pip--energy[data-skin-orb] .energy-orb__skin').count(), 1, `${screen}: the energy orb is the skin's`)
    assert.match(await page.locator('.energy-orb__skin').getAttribute('src'), /\/combat\/energy-orbs\/kratos\.webp$/, `${screen}: the orb art is Kratos's`)
    assert.equal(await page.locator('.hand .card').count() > 0, true, `${screen}: Ironclad's own cards are in hand`)
    assert.match(await page.locator('.hand .card').first().getAttribute('aria-label'), /Strike|Defend|Bash/, `${screen}: the cards are Ironclad's`)
    await page.screenshot({ path: resolve(output, `${screen}-combat-skinned.png`) })
    await skinned.close()

    // Solo, no skin chosen: nothing of Kratos shows anywhere.
    const plain = await openContext(viewport, 'Plain', undefined)
    const plainPage = watch(await plain.newPage())
    await characterSelect(plainPage)
    assert.match(await decoded(plainPage, '.start-menu__character-roster button[aria-label="Ironclad"] img'), /portrait-ironclad\.png$/,
      `${screen}: the default Ironclad portrait`)
    assert.match(await decoded(plainPage, '.start-menu__character-wallpaper'), /character-ironclad-wallpaper\.webp$/)
    await plainPage.getByRole('button', { name: 'Embark', exact: true }).click()
    await plainPage.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
    await plainPage.waitForFunction(() => window.__STS_DEBUG__?.getRun().phase === 'neow')
    assert.equal(await plainPage.evaluate(() => 'skin' in window.__STS_DEBUG__.getRun().players[0]), false)
    const plainFight = { ...structuredClone(fixture), phase: 'combat', players: fixture.players.map(({ skin: _skin, ...rest }) => rest) }
    plainFight.combat = preparePlayerTurn(createCombat(createRng(62), plainFight.players, [enemy], 'skin-browser-plain'))
    await plainPage.evaluate((run) => window.__STS_DEBUG__.setRun(run), plainFight)
    await plainPage.locator('.seat__interactive[data-character="ironclad"]').waitFor()
    assert.equal(await plainPage.locator('[data-character="kratos"], [data-skin-orb], .energy-orb__skin').count(), 0, `${screen}: no Kratos without the skin`)
    await plain.close()

    // A stored choice for a skin the account has not bought is ignored: Default everywhere, and in the run.
    const stale = await openContext(viewport, 'Stale', 'kratos', false)
    const stalePage = watch(await stale.newPage())
    await characterSelect(stalePage)
    assert.match(await decoded(stalePage, '.start-menu__character-roster button[aria-label="Ironclad"] img'), /portrait-ironclad\.png$/,
      `${screen}: an unowned skin is not worn in character select`)
    await stalePage.getByRole('button', { name: 'Embark', exact: true }).click()
    await stalePage.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
    await stalePage.waitForFunction(() => window.__STS_DEBUG__?.getRun().phase === 'neow')
    assert.equal(await stalePage.evaluate(() => 'skin' in window.__STS_DEBUG__.getRun().players[0]), false, `${screen}: an unowned skin never reaches a run`)
    await stale.close()
    console.log(`PASS ${screen}: solo skin in character select, Neow, campfire and combat; default look without it`)
  }

  // A solo run saved while Kratos was a character is discarded cleanly: no crash, no Resume.
  {
    const save = (character) => {
      const run = postNeowRun(64, [{ id: 'p1', name: 'Old', character: 'ironclad' }])
      run.phase = 'neow'; run.neow = createRun(64, [{ id: 'p1', name: 'Old', character: 'ironclad' }]).neow
      run.players[0].character = character
      return JSON.stringify({ version: 1, run, built: { count: 1, seed: 'old', ascension: 0, chooseYourRelic: false, lastStand: false,
        characters: [character], meta: {} } })
    }
    for (const [character, resumable] of [['ironclad', true], ['kratos', false]]) {
      const context = await openContext(SCREENS[0][1], 'Saver', undefined)
      await context.addInitScript((saved) => localStorage.setItem('sts-solo-run', saved), save(character))
      const page = watch(await context.newPage())
      await page.goto(origin, { waitUntil: 'networkidle' })
      await page.getByRole('button', { name: 'Single Player', exact: true }).waitFor()
      assert.equal(await page.getByRole('button', { name: 'Resume', exact: true }).count(), resumable ? 1 : 0,
        `a saved ${character} run ${resumable ? 'resumes' : 'is discarded'}`)
      await context.close()
    }
    console.log('PASS: a saved Kratos-character run is not offered for resume')
  }

  // Online: Ann wears the skin, Bo does not; each sees the other's seat as it is.
  for (const [screen, viewport] of SCREENS) {
    const annContext = await openContext(viewport, 'Ann', 'kratos')
    const boContext = await openContext(viewport, 'Bo', undefined)
    const ann = watch(await annContext.newPage())
    const bo = watch(await boContext.newPage())
    for (const [page, name] of [[ann, 'Ann'], [bo, 'Bo']]) {
      await page.goto(origin, { waitUntil: 'networkidle' })
      await setTestUsername(page, name)
    }
    await ann.getByRole('button', { name: 'Play online' }).click()
    await ann.locator('main.online-entry .online-character-roster').getByRole('button', { name: 'Ironclad' }).click()
    assert.match(await decoded(ann, 'main.online-entry .online-character-roster button[aria-label="Ironclad"] img'), /portrait-kratos\.png$/,
      `${screen}: the online roster shows the chosen skin`)
    await ann.getByRole('button', { name: 'Create room' }).click()
    await ann.locator('.online-lobby').waitFor()
    const code = await ann.locator('.online-lobby h1').textContent()
    await bo.getByRole('button', { name: 'Play online' }).click()
    await bo.locator('main.online-entry .online-character-roster').getByRole('button', { name: 'Silent' }).click()
    await bo.getByLabel('Room code').fill(code)
    await bo.getByRole('button', { name: 'Join', exact: true }).click()
    await bo.locator('.online-lobby').waitFor()
    for (const [label, page] of [['Ann', ann], ['Bo', bo]]) {
      const seat = page.locator('.online-seat', { hasText: 'Ann' }).locator('.online-seat__portrait img')
      await seat.waitFor()
      assert.match(await decoded(page, '.online-seat:has-text("Ann") .online-seat__portrait img'), /\/combat\/characters\/kratos\.webp$/,
        `${screen}: ${label} sees Ann's seat as Kratos`)
      assert.match(await decoded(page, '.online-seat:has-text("Bo") .online-seat__portrait img'), /\/combat\/characters\/silent\.webp$/,
        `${screen}: ${label} sees Bo's seat as Silent`)
    }
    await ann.screenshot({ path: resolve(output, `${screen}-online-lobby-ann.png`) })
    await bo.screenshot({ path: resolve(output, `${screen}-online-lobby-bo.png`) })
    const room = rooms.store.rooms.get(code)
    assert.deepEqual(room.seats.map((seat) => [seat.character, seat.skin ?? null]), [['ironclad', 'kratos'], ['silent', null]])

    // Changing the skin in Profile while in the lobby reaches the table; so does choosing another hero.
    await ann.evaluate(() => {
      localStorage.removeItem('sts-skins:ann')
      window.dispatchEvent(new Event('sts-skin-change'))
    })
    await bo.waitForFunction(() => document.querySelector('.online-seat:nth-child(1) .online-seat__portrait img')?.src.endsWith('/combat/characters/ironclad.webp'))
    await ann.evaluate(() => {
      localStorage.setItem('sts-skins:ann', JSON.stringify({ ironclad: 'kratos' }))
      window.dispatchEvent(new Event('sts-skin-change'))
    })
    await bo.waitForFunction(() => document.querySelector('.online-seat:nth-child(1) .online-seat__portrait img')?.src.endsWith('/combat/characters/kratos.webp'))

    // The run starts with the skin, and Bo's table shows Ann's seat in combat as Kratos.
    await ann.getByRole('button', { name: 'Enter the Spire' }).click()
    await ann.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
    await ann.getByRole('heading', { name: 'Neow’s Blessing' }).waitFor()
    await bo.getByRole('heading', { name: 'Neow’s Blessing' }).waitFor()
    assert.equal(room.run.players[0].skin, 'kratos')
    assert.ok(!('skin' in room.run.players[1]))
    room.run = { ...room.run, phase: 'combat', neow: null, combat: createCombat(createRng(63), room.run.players, [{
      uid: 'online-enemy', defId: 'jaw_worm', row: 0, isBoss: false, hp: 30, maxHp: 30, block: 0, strength: 0, vulnerable: 0,
      weak: 0, poison: 0, actionIndex: 0, abilityUsed: true, dead: false }], 'skin-online') }
    room.version += 1
    rooms.publishRoom(code)
    for (const [label, page] of [['Ann', ann], ['Bo', bo]]) {
      await page.locator('.seat__interactive[data-player-id="p1"][data-character="kratos"]').waitFor()
      assert.equal(await page.locator('.seat__interactive[data-player-id="p2"]').getAttribute('data-character'), 'silent',
        `${screen}: ${label} sees Silent as Silent`)
    }
    await bo.screenshot({ path: resolve(output, `${screen}-online-combat-bo.png`) })

    // Reconnecting keeps the look: a fresh page for Bo still sees Ann as Kratos.
    await bo.reload({ waitUntil: 'networkidle' })
    await bo.locator('.seat__interactive[data-player-id="p1"][data-character="kratos"]').waitFor()

    // The online campfire is lit by the party's visual ids: Silent plus Ann's Kratos, for both seats, through a reload.
    const camp = structuredClone(room.run)
    const campRoom = camp.map.rows[0][0]
    camp.phase = 'room'; camp.combat = null; camp.map.position = campRoom; camp.map.rooms[campRoom].kind = 'campfire'
    room.run = camp
    room.version += 1
    rooms.publishRoom(code)
    const litBySkin = () => /\/noncombat\/campfire\/silent_kratos_firecamp\.webp/.test(getComputedStyle(document.querySelector('.campfire') ?? document.body).backgroundImage)
    for (const [label, page] of [['Ann', ann], ['Bo', bo]]) {
      await page.waitForFunction(litBySkin, undefined, { timeout: 15_000 }).catch(async (error) => {
        throw new Error(`${screen}: ${label}'s online campfire is not the skin party's scene: ${await page.evaluate(() =>
          getComputedStyle(document.querySelector('.campfire') ?? document.body).backgroundImage)} (${error.message})`)
      })
    }
    await bo.screenshot({ path: resolve(output, `${screen}-online-campfire-bo.png`) })
    await bo.reload({ waitUntil: 'networkidle' })
    await bo.waitForFunction(litBySkin, undefined, { timeout: 15_000 })
    await annContext.close()
    await boContext.close()
    console.log(`PASS ${screen}: online lobby, combat and campfire show each seat's skin to every teammate, through a reload`)
  }
  assert.deepEqual(errors, [])
} finally {
  await browser.close()
  await vite.close()
  await rooms.close?.()
}
