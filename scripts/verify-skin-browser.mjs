#!/usr/bin/env node
// Every registered skin (src/game/skins.ts SKINS) in the real app, on desktop and horizontal-phone screens:
// character select, the Neow scene, a campfire, combat in a solo run, and an online room
// where the teammate sees the other seat's skin (lobby seat list and the run's seat).
// The treasure hand, merchant standing and attack animation have their own focused verifiers
// (verify-treasure-animation-browser, verify-merchant-overflow-browser, verify-skin-attack-browser).
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
import { CARDS } from '../src/game/cards.ts'
import { SKIN_IDS, SKIN_LABELS, SKIN_TRAITS, characterOfSkin } from '../src/game/skins.ts'
import { CHARACTER_LABEL } from '../src/ui/run-summary-data.ts'

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
// One case per registered skin: registering a skin extends every check below. All facts come from the registry.
const CORE_HEROES = ['ironclad', 'silent', 'defect', 'watcher']
// `--skin=<id>` runs one skin's cases.
const only = process.argv.find((arg) => arg.startsWith('--skin='))?.slice('--skin='.length)
if (only && !SKIN_IDS.includes(only)) throw new Error(`--skin=${only} is not a registered skin (${SKIN_IDS.join(', ')})`)
const CASES = SKIN_IDS.filter((skin) => !only || skin === only).map((skin) => {
  const hero = characterOfSkin(skin)
  const partner = CORE_HEROES.find((character) => character !== hero)
  return { skin, hero, name: CHARACTER_LABEL[hero], label: SKIN_LABELS[skin], traits: SKIN_TRAITS[skin], partner, partnerName: CHARACTER_LABEL[partner],
    cardNames: Object.values(CARDS).filter((def) => def.owner === hero).map((def) => def.name) }
})
// The campfire's loaded seated sprites, sorted: CampfireScene seats one per living hero, each loading `sitters/<visual id>.webp`.
const seated = (expected) => [...document.querySelectorAll('.campfire__sitter')]
  .filter((sitter) => sitter.complete && sitter.naturalWidth > 0)
  .map((sitter) => new URL(sitter.currentSrc).pathname.match(/\/sitters\/([^/]+)\.webp$/)?.[1]).sort().join(',') === expected
// The halo around a skin's own energy orb matches that orb's art (a skin copying another's halo would be wrong).
const ORB_GLOW = { kratos: [220, 22, 24], monogatari_silent: [166, 248, 62], monogatari_watcher: [150, 70, 240], anime_slime_boss: [171, 239, 60] }
const SCREENS = [['desktop', { width: 1440, height: 900 }], ['horizontal-phone', { width: 844, height: 390 }]]

// A context signed in as `username`, who has (or has not) chosen a skin in Profile.
/** `skin` is the choice stored in Profile; the account's wallet owns it unless `owned` is false (a stale choice). */
async function openContext(viewport, username, skin, owned = true) {
  const context = await browser.newContext({ viewport, isMobile: viewport.width < 900, hasTouch: viewport.width < 900 })
  const hero = skin ? characterOfSkin(skin) : undefined
  await context.addInitScript(({ username, skin, hero, owned }) => {
    localStorage.setItem('sts-profile', JSON.stringify({ username, token: '00000000-0000-4000-8000-000000000001', secured: true }))
    if (skin) localStorage.setItem(`sts-skins:${username.toLowerCase()}`, JSON.stringify({ [hero]: skin }))
    // Only an owned skin can be worn: the account bought it (the Shop's Skins tab).
    const wallet = `sts-wallet:${username.toLowerCase()}`
    if (skin && owned && !localStorage.getItem(wallet)) {
      localStorage.setItem(wallet, JSON.stringify({ version: 1, coins: 0, packs: [], skins: [skin], credited: {} }))
    }
  }, { username, skin, hero, owned })
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

async function characterSelect(page, heroName = 'Ironclad') {
  await page.goto(origin, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Single Player', exact: true }).click()
  await page.getByRole('button', { name: 'Standard', exact: true }).click()
  await page.locator('.start-menu__character-roster').waitFor()
  if (heroName !== 'Ironclad') await page.locator(`.start-menu__character-roster button[aria-label="${heroName}"]`).click()
  await page.getByRole('heading', { name: heroName }).waitFor()
}
/** The character-select wallpaper once it is the hero's `art` (the previous one fades out after a switch). */
async function wallpaper(page, art) {
  const selector = '.start-menu__character-wallpaper'
  await page.waitForFunction(({ selector, art }) => [...document.querySelectorAll(selector)].some((image) => image.src.endsWith(art)), { selector, art })
  return page.locator(selector).evaluateAll(async (images, art) => {
    const image = images.find((candidate) => candidate.src.endsWith(art))
    await image.decode()
    return image.naturalWidth > 0 ? image.currentSrc : ''
  }, art)
}

try {
  for (const [screen, viewport] of SCREENS) for (const { skin, hero, name, label, traits, cardNames } of CASES) {
    const tag = `${screen}/${skin}`
    // Solo, skin chosen: character select, Neow, campfire and combat all show the skin.
    const skinned = await openContext(viewport, 'Skinner', skin)
    const page = watch(await skinned.newPage())
    await characterSelect(page, name)
    assert.match(await decoded(page, `.start-menu__character-roster button[aria-label="${name}"] img`), new RegExp(`portrait-${skin}\\.png$`),
      `${tag}: ${name}'s portrait wears the skin`)
    for (const other of CORE_HEROES.filter((character) => character !== hero)) {
      assert.match(await decoded(page, `.start-menu__character-roster button[aria-label="${CHARACTER_LABEL[other]}"] img`), new RegExp(`portrait-${other}\\.png$`),
        `${tag}: only ${name} wears the skin`)
    }
    assert.match(await wallpaper(page, `character-${skin}-wallpaper.webp`), new RegExp(`character-${skin}-wallpaper\\.webp$`), `${tag}: the wallpaper follows the skin`)
    assert.equal(await page.getByRole('heading', { name }).count(), 1, `${tag}: the hero is still named ${name}`)
    assert.equal(await page.getByRole('button', { name: label, exact: true }).count(), 0, `${tag}: ${label} is no character`)
    await page.screenshot({ path: resolve(output, `${screen}-${skin}-character-select-skinned.png`) })
    await page.getByRole('button', { name: 'Embark', exact: true }).click()
    await page.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
    await page.waitForFunction(() => window.__STS_DEBUG__?.getRun().phase === 'neow')
    assert.equal(await page.evaluate(() => window.__STS_DEBUG__.getRun().players[0].skin), skin, `${tag}: the run carries the skin`)
    assert.equal(await page.evaluate(() => window.__STS_DEBUG__.getRun().players[0].character), hero)
    assert.match(await decoded(page, '.neow-screen__hero'), new RegExp(`${skin}-hero\\.webp$`), `${tag}: the Neow scene shows the skin`)

    // Campfire: the seated hero is the skin, not the hero.
    const fixture = postNeowRun(61, [{ id: 'p1', name, character: hero, skin }])
    const campfire = structuredClone(fixture)
    const roomId = campfire.map.rows[0][0]
    Object.assign(campfire, { phase: 'room' })
    campfire.map.position = roomId
    campfire.map.rooms[roomId].kind = 'campfire'
    await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), campfire)
    await page.waitForFunction(seated, skin)
    await page.screenshot({ path: resolve(output, `${screen}-${skin}-campfire-skinned.png`) })

    // Combat: the seat is drawn as the skin, with the character underneath still the hero.
    const enemy = { uid: 'enemy-0', defId: 'jaw_worm', row: 0, isBoss: false, hp: 30, maxHp: 30, block: 0, strength: 0,
      vulnerable: 0, weak: 0, poison: 0, actionIndex: 0, abilityUsed: true, dead: false }
    const fight = { ...structuredClone(fixture), phase: 'combat' }
    fight.combat = preparePlayerTurn(createCombat(createRng(62), fight.players, [enemy], 'skin-browser'))
    await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), fight)
    await page.locator(`.seat__interactive[data-character="${skin}"]`).waitFor()
    assert.match(await decoded(page, '.seat__portrait > img'), new RegExp(`/${skin}-idle\\.webp$|/${skin}-hero\\.webp$`), `${tag}: combat idle is the skin`)
    assert.equal(await page.locator('.pip--energy[data-skin-orb] .energy-orb__skin').count(), traits.energyOrb ? 1 : 0,
      `${tag}: the energy orb is the skin's exactly when its energyOrb trait says so`)
    if (traits.energyOrb) {
      assert.match(await page.locator('.energy-orb__skin').getAttribute('src'), new RegExp(`/combat/energy-orbs/${skin}\\.webp$`), `${tag}: the orb art is the skin's`)
      assert.equal(await page.locator('.pip--energy .energy-orb__layers').count(), 0, `${tag}: the skin's orb replaces a Downfall hero's own orb layers`)
      assert.ok(ORB_GLOW[skin], `${tag}: ORB_GLOW names every skin with its own orb`)
      const filter = await page.locator('.pip--energy[data-skin-orb]').evaluate((orb) => getComputedStyle(orb).filter)
      const [halo] = [...filter.matchAll(/drop-shadow\(rgba?\((\d+), (\d+), (\d+)[^)]*\)[^)]*?\s0px 0px/g)].map((match) => match.slice(1, 4).map(Number))
      assert.deepEqual(halo, ORB_GLOW[skin], `${tag}: the orb halo is the skin's colour (${filter})`)
    }
    assert.equal(await page.locator('.hand .card').count() > 0, true, `${tag}: ${name}'s own cards are in hand`)
    const handLabel = await page.locator('.hand .card').first().getAttribute('aria-label')
    assert.ok(cardNames.some((cardName) => handLabel.includes(cardName)), `${tag}: the cards are ${name}'s (${handLabel})`)
    await page.screenshot({ path: resolve(output, `${screen}-${skin}-combat-skinned.png`) })
    await skinned.close()

    // Solo, no skin chosen: nothing of the skin shows anywhere.
    const plain = await openContext(viewport, 'Plain', undefined)
    const plainPage = watch(await plain.newPage())
    await characterSelect(plainPage, name)
    assert.match(await decoded(plainPage, `.start-menu__character-roster button[aria-label="${name}"] img`), new RegExp(`portrait-${hero}\\.png$`),
      `${tag}: the default ${name} portrait`)
    assert.match(await wallpaper(plainPage, `character-${hero}-wallpaper.webp`), new RegExp(`character-${hero}-wallpaper\\.webp$`))
    await plainPage.getByRole('button', { name: 'Embark', exact: true }).click()
    await plainPage.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
    await plainPage.waitForFunction(() => window.__STS_DEBUG__?.getRun().phase === 'neow')
    assert.equal(await plainPage.evaluate(() => 'skin' in window.__STS_DEBUG__.getRun().players[0]), false)
    const plainFight = { ...structuredClone(fixture), phase: 'combat', players: fixture.players.map(({ skin: _skin, ...rest }) => rest) }
    plainFight.combat = preparePlayerTurn(createCombat(createRng(62), plainFight.players, [enemy], 'skin-browser-plain'))
    await plainPage.evaluate((run) => window.__STS_DEBUG__.setRun(run), plainFight)
    await plainPage.locator(`.seat__interactive[data-character="${hero}"]`).waitFor()
    assert.equal(await plainPage.locator(`[data-character="${skin}"], [data-skin-orb], .energy-orb__skin`).count(), 0, `${tag}: no skin without it`)
    await plain.close()

    // A stored choice for a skin the account has not bought is ignored: Default everywhere, and in the run.
    const stale = await openContext(viewport, 'Stale', skin, false)
    const stalePage = watch(await stale.newPage())
    await characterSelect(stalePage, name)
    assert.match(await decoded(stalePage, `.start-menu__character-roster button[aria-label="${name}"] img`), new RegExp(`portrait-${hero}\\.png$`),
      `${tag}: an unowned skin is not worn in character select`)
    await stalePage.getByRole('button', { name: 'Embark', exact: true }).click()
    await stalePage.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
    await stalePage.waitForFunction(() => window.__STS_DEBUG__?.getRun().phase === 'neow')
    assert.equal(await stalePage.evaluate(() => 'skin' in window.__STS_DEBUG__.getRun().players[0]), false, `${tag}: an unowned skin never reaches a run`)
    await stale.close()
    console.log(`PASS ${tag}: solo skin in character select, Neow, campfire and combat; default look without it`)
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
  for (const [screen, viewport] of SCREENS) for (const { skin, hero, name, label, partner, partnerName } of CASES) {
    const tag = `${screen}/${skin}`
    const annContext = await openContext(viewport, 'Ann', skin)
    const boContext = await openContext(viewport, 'Bo', undefined)
    const ann = watch(await annContext.newPage())
    const bo = watch(await boContext.newPage())
    for (const [page, user] of [[ann, 'Ann'], [bo, 'Bo']]) {
      await page.goto(origin, { waitUntil: 'networkidle' })
      await setTestUsername(page, user)
    }
    await ann.getByRole('button', { name: 'Play online' }).click()
    await ann.locator('main.online-entry .online-character-roster').getByRole('button', { name }).click()
    assert.match(await decoded(ann, `main.online-entry .online-character-roster button[aria-label="${name}"] img`), new RegExp(`portrait-${skin}\\.png$`),
      `${tag}: the online roster shows the chosen skin`)
    await ann.getByRole('button', { name: 'Create room' }).click()
    await ann.locator('.online-lobby').waitFor()
    const code = await ann.locator('.online-lobby h1').textContent()
    await bo.getByRole('button', { name: 'Play online' }).click()
    await bo.locator('main.online-entry .online-character-roster').getByRole('button', { name: partnerName }).click()
    await bo.getByLabel('Room code').fill(code)
    await bo.getByRole('button', { name: 'Join', exact: true }).click()
    await bo.locator('.online-lobby').waitFor()
    for (const [who, page] of [['Ann', ann], ['Bo', bo]]) {
      const seat = page.locator('.online-seat', { hasText: 'Ann' }).locator('.online-seat__portrait img')
      await seat.waitFor()
      assert.match(await decoded(page, '.online-seat:has-text("Ann") .online-seat__portrait img'), new RegExp(`/combat/characters/${skin}\\.webp$`),
        `${tag}: ${who} sees Ann's seat as ${label}`)
      assert.match(await decoded(page, '.online-seat:has-text("Bo") .online-seat__portrait img'), new RegExp(`/combat/characters/${partner}\\.webp$`),
        `${tag}: ${who} sees Bo's seat as ${partnerName}`)
    }
    await ann.screenshot({ path: resolve(output, `${tag.replace('/', '-')}-online-lobby-ann.png`) })
    await bo.screenshot({ path: resolve(output, `${tag.replace('/', '-')}-online-lobby-bo.png`) })
    const room = rooms.store.rooms.get(code)
    assert.deepEqual(room.seats.map((seat) => [seat.character, seat.skin ?? null]), [[hero, skin], [partner, null]])

    // Changing the skin in Profile while in the lobby reaches the table; so does choosing another hero.
    await ann.evaluate(() => {
      localStorage.removeItem('sts-skins:ann')
      window.dispatchEvent(new Event('sts-skin-change'))
    })
    await bo.waitForFunction((hero) => document.querySelector('.online-seat:nth-child(1) .online-seat__portrait img')?.src.endsWith(`/combat/characters/${hero}.webp`), hero)
    await ann.evaluate(([hero, skin]) => {
      localStorage.setItem('sts-skins:ann', JSON.stringify({ [hero]: skin }))
      window.dispatchEvent(new Event('sts-skin-change'))
    }, [hero, skin])
    await bo.waitForFunction((skin) => document.querySelector('.online-seat:nth-child(1) .online-seat__portrait img')?.src.endsWith(`/combat/characters/${skin}.webp`), skin)

    // The run starts with the skin, and Bo's table shows Ann's seat in combat as the skin.
    await ann.getByRole('button', { name: 'Enter the Spire' }).click()
    await ann.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
    // A Downfall hero is dealt the Heart's Boon instead of Neow's Blessing: wait for the scene, not its title.
    await ann.locator('.neow-screen').waitFor()
    await bo.locator('.neow-screen').waitFor()
    assert.equal(room.run.players[0].skin, skin)
    assert.ok(!('skin' in room.run.players[1]))
    room.run = { ...room.run, phase: 'combat', neow: null, combat: createCombat(createRng(63), room.run.players, [{
      uid: 'online-enemy', defId: 'jaw_worm', row: 0, isBoss: false, hp: 30, maxHp: 30, block: 0, strength: 0, vulnerable: 0,
      weak: 0, poison: 0, actionIndex: 0, abilityUsed: true, dead: false }], 'skin-online') }
    room.version += 1
    rooms.publishRoom(code)
    for (const [who, page] of [['Ann', ann], ['Bo', bo]]) {
      await page.locator(`.seat__interactive[data-player-id="p1"][data-character="${skin}"]`).waitFor()
      assert.equal(await page.locator('.seat__interactive[data-player-id="p2"]').getAttribute('data-character'), partner,
        `${tag}: ${who} sees ${partnerName} as ${partnerName}`)
    }
    await bo.screenshot({ path: resolve(output, `${tag.replace('/', '-')}-online-combat-bo.png`) })

    // Reconnecting keeps the look: a fresh page for Bo still sees Ann in the skin.
    await bo.reload({ waitUntil: 'networkidle' })
    await bo.locator(`.seat__interactive[data-player-id="p1"][data-character="${skin}"]`).waitFor()

    // The online campfire seats the party's visual ids: the partner plus Ann's skin, for both seats, through a reload.
    const camp = structuredClone(room.run)
    const campRoom = camp.map.rows[0][0]
    camp.phase = 'room'; camp.combat = null; camp.map.position = campRoom; camp.map.rooms[campRoom].kind = 'campfire'
    room.run = camp
    room.version += 1
    rooms.publishRoom(code)
    const party = [partner, skin].sort().join(',')
    for (const [who, page] of [['Ann', ann], ['Bo', bo]]) {
      await page.waitForFunction(seated, party, { timeout: 15_000 }).catch(async (error) => {
        throw new Error(`${tag}: ${who}'s online campfire does not seat the skin party: ${await page.evaluate(() =>
          [...document.querySelectorAll('.campfire__sitter')].map((sitter) => new URL(sitter.currentSrc || sitter.src).pathname).join(','))} (${error.message})`)
      })
    }
    await bo.screenshot({ path: resolve(output, `${tag.replace('/', '-')}-online-campfire-bo.png`) })
    await bo.reload({ waitUntil: 'networkidle' })
    await bo.waitForFunction(seated, party, { timeout: 15_000 })
    await annContext.close()
    await boContext.close()
    console.log(`PASS ${tag}: online lobby, combat and campfire show each seat's skin to every teammate, through a reload`)
  }
  assert.deepEqual(errors, [])
} finally {
  await browser.close()
  await vite.close()
  await rooms.close?.()
}
