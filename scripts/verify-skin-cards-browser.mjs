#!/usr/bin/env node
// The Kratos skin's card faces in the real app, on desktop and horizontal-phone screens.
// A card wears the skin of the seat that owns its character (solo hand, draw pile, deck
// viewer, reward picker, online seats) or, outside a run, the viewer's saved preference
// (compendium, its full-size zoom, stats). Other heroes' cards, colorless cards, Gem-socketed
// cards and the default look stay on the default scans. Screenshots: artifacts/skin-cards/.
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium, setTestUsername } from './lib/profile-browser.mjs'
import { createRoomServer } from './room-server.mjs'
import { postNeowRun } from './lib/post-neow-run.mjs'
import { createCombat, preparePlayerTurn } from '../src/game/combat.ts'
import { createRng } from '../src/game/rng.ts'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'artifacts/skin-cards')
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

const SKIN_THUMB = /\/assets\/skin-cards-sm\/kratos\/(slayer__)?ironclad__[a-z-]+(__[a-z-]+)?\+?\.webp$/
const DEFAULT_THUMB = /\/assets\/cards-sm\/(slayer__)?ironclad__[a-z-]+(__[a-z-]+)?\+?\.webp$/

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

/** Every `<img>` under `selector`, once loaded and decoded: its URL, and whether it actually painted. */
async function sources(page, selector) {
  await page.locator(selector).first().waitFor()
  await page.waitForFunction((query) => [...document.querySelectorAll(query)].every((image) => image.complete && image.naturalWidth > 0),
    selector, { timeout: 15_000 })
  return page.locator(selector).evaluateAll((images) => Promise.all(images.map(async (image) => {
    await image.decode().catch(() => {})
    return image.currentSrc
  })))
}
async function assertAll(page, selector, pattern, message) {
  const found = await sources(page, selector)
  assert.ok(found.length > 0, `${message}: no images under ${selector}`)
  assert.deepEqual(found.filter((src) => !pattern.test(src)), [], message)
  return found
}

async function startSolo(page) {
  await page.goto(origin, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Single Player', exact: true }).click()
  await page.getByRole('button', { name: 'Standard', exact: true }).click()
  await page.locator('.start-menu__character-roster').waitFor()
  await page.getByRole('button', { name: 'Embark', exact: true }).click()
  await page.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
  await page.waitForFunction(() => window.__STS_DEBUG__?.getRun().phase === 'neow')
}

const jaw = { uid: 'enemy-0', defId: 'jaw_worm', row: 0, isBoss: false, hp: 30, maxHp: 30, block: 0, strength: 0,
  vulnerable: 0, weak: 0, poison: 0, actionIndex: 0, abilityUsed: true, dead: false }

/** An Ironclad run in combat whose deck also holds a colorless card, a Silent card and a Slayer Pack card. */
function fixture(skin) {
  const run = postNeowRun(71, [{ id: 'p1', name: 'Ironclad', character: 'ironclad', ...(skin ? { skin } : {}) }])
  run.players[0].deck.push(
    { uid: 'x-curse', defId: 'ascenders_bane', upgraded: false },
    { uid: 'x-silent', defId: 'neutralize', upgraded: false },
    { uid: 'x-pack', defId: 'slayer_reaper', upgraded: true },
  )
  return run
}
const combat = (run, label) => {
  const fight = { ...structuredClone(run), phase: 'combat' }
  fight.combat = preparePlayerTurn(createCombat(createRng(72), fight.players, [jaw], label))
  return fight
}

async function soloChecks(screen, viewport, skin) {
  const tag = skin ? 'skinned' : 'default'
  const context = await openContext(viewport, skin ? 'Skinner' : 'Plain', skin)
  const page = watch(await context.newPage())
  await startSolo(page)
  const base = fixture(skin)
  assert.equal(await page.evaluate(() => window.__STS_DEBUG__.getRun().players[0].skin ?? null), skin ?? null)

  // Hand: Ironclad's own cards.
  await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), combat(base, `skin-cards-${tag}`))
  await page.locator('.hand .card').first().waitFor()
  await assertAll(page, '.hand .card > img:not(.card__gem)', skin ? SKIN_THUMB : DEFAULT_THUMB, `${screen} ${tag}: hand faces`)
  if (!skin) assert.equal(await page.locator('img[src*="skin-cards"]').count(), 0, `${screen}: nothing of the skin without it`)
  await page.screenshot({ path: resolve(output, `${screen}-solo-hand-${tag}.png`) })

  // Powers: the hover zoom's scan and the CSS face's illustration under it wear the owner's skin.
  const powered = combat(base, `skin-cards-power-${tag}`)
  powered.combat.players[0].powers = [{ uid: 'skin-power', defId: 'inflame', upgraded: false }]
  await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), powered)
  await page.locator('.row__seat .power').first().hover()
  await page.locator('.power__zoom:not(.slime-party__zoom)').waitFor()
  await assertAll(page, '.power__zoom-image', skin ? SKIN_THUMB : DEFAULT_THUMB, `${screen} ${tag}: power zoom scan`)
  await assertAll(page, '.power__zoom .card-face__illustration',
    skin ? /\/assets\/skin-card-art\/kratos\/ironclad\/inflame\.webp$/ : /\/assets\/card-art\/ironclad\/inflame\.webp$/,
    `${screen} ${tag}: power zoom CSS face illustration`)
  await page.mouse.move(0, 0)
  await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), combat(base, `skin-cards-${tag}`))
  await page.locator('.hand .card').first().waitFor()

  // The run keeps its own skin: dropping the saved preference mid-run does not re-skin its cards.
  if (skin) {
    await page.evaluate(() => {
      localStorage.removeItem('sts-skins:skinner')
      window.dispatchEvent(new Event('sts-skin-change'))
    })
    await assertAll(page, '.hand .card > img:not(.card__gem)', SKIN_THUMB, `${screen}: the run's skin outlives the preference`)
  }

  // Draw pile viewer, and the deck viewer with the cards the skin must NOT touch.
  await page.locator('[data-pile="draw"]').click()
  const pile = '.card-collection[open] .card > img:not(.card__gem)'
  await assertAll(page, pile, skin ? SKIN_THUMB : DEFAULT_THUMB, `${screen} ${tag}: draw pile faces`)
  await page.screenshot({ path: resolve(output, `${screen}-solo-draw-pile-${tag}.png`) })
  await page.keyboard.press('Escape')
  await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), { ...structuredClone(base), phase: 'map' })
  await page.locator('.deck-peek__open').click()
  await page.locator('.card-collection[open] .card').first().waitFor()
  await page.waitForFunction(() => {
    const cards = [...document.querySelectorAll('.card-collection[open] .card')]
    return cards.length >= 13 && cards.every((card) => { const image = card.querySelector(':scope > img:not(.card__gem)'); return image?.complete && image.naturalWidth > 0 })
  }, undefined, { timeout: 20_000 })
  const deck = await page.locator('.card-collection[open] .card').evaluateAll((cards) => cards.map((card) => ({
    id: card.getAttribute('aria-label'), src: card.querySelector(':scope > img:not(.card__gem)')?.currentSrc ?? '' })))
  const by = (pattern) => deck.filter(({ id }) => pattern.test(id))
  const mine = deck.filter(({ id }) => !/Ascender|Neutralize|Reaper/.test(id))
  assert.ok(mine.length >= 10, `${screen} ${tag}: deck viewer lists the starter deck`)
  for (const [label, cards, expected] of [
    ['Ironclad starter cards', mine, skin ? SKIN_THUMB : DEFAULT_THUMB],
    ['colorless/curse card', by(/Ascender/), /\/assets\/cards-sm\/ascension__/],
    ['another hero\'s card', by(/Neutralize/), /\/assets\/cards-sm\/silent__/],
    ['Slayer Pack Ironclad card', by(/Reaper/), skin ? SKIN_THUMB : /\/assets\/cards-sm\/slayer__ironclad__/],
  ]) {
    assert.ok(cards.length > 0, `${screen} ${tag}: deck viewer has a ${label}`)
    assert.deepEqual(cards.filter(({ src }) => !expected.test(src)).map(({ src }) => src), [], `${screen} ${tag}: ${label}`)
  }
  await page.screenshot({ path: resolve(output, `${screen}-solo-deck-${tag}.png`) })
  await page.keyboard.press('Escape')

  // Reward picker.
  const loot = { ...structuredClone(base), phase: 'reward', rewardDestination: 'map', rewards: [{
    playerId: 'p1', gold: 0, cardReward: true, choices: ['anger', 'cleave', 'slayer_brutality'], upgraded: false, potion: false }] }
  await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), loot)
  await page.locator('.reward-screen').waitFor()
  const picker = page.locator('.reward-screen__cards .card')
  if (await picker.count() === 0) await page.getByRole('button', { name: /card/i }).first().click()
  await assertAll(page, '.reward-screen__cards .card > img:not(.card__gem)', skin ? SKIN_THUMB : DEFAULT_THUMB, `${screen} ${tag}: reward picker faces`)
  await page.screenshot({ path: resolve(output, `${screen}-solo-reward-${tag}.png`) })

  // Back at the menu the compendium follows the viewer's preference, and so does its full-size zoom.
  await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), { ...structuredClone(base), phase: 'map' })
  await context.close()
}

async function menuChecks(screen, viewport, skin) {
  const tag = skin ? 'skinned' : 'default'
  const context = await openContext(viewport, skin ? 'Skinner' : 'Plain', skin)
  const page = watch(await context.newPage())
  await page.goto(origin, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Compendium' }).click()
  await page.locator('.compendium__grid .compendium-card').first().waitFor()
  await page.getByLabel('Search cards').fill('Bash')
  const tile = page.locator('.compendium-card--ironclad', { hasText: 'Bash' }).first()
  await tile.waitFor()
  await assertAll(page, '.compendium-card--ironclad img', skin ? SKIN_THUMB : DEFAULT_THUMB, `${screen} ${tag}: compendium tile`)
  await page.getByLabel('Search cards').fill('Neutralize')
  await assertAll(page, '.compendium-card--silent img', /\/assets\/cards-sm\/silent__/, `${screen} ${tag}: Silent tile stays default`)
  await page.getByLabel('Search cards').fill('Reaper')
  await assertAll(page, '.compendium-card--ironclad img', skin ? SKIN_THUMB : DEFAULT_THUMB, `${screen} ${tag}: pack card tile`)
  await page.getByLabel('Search cards').fill('Bash')
  await page.screenshot({ path: resolve(output, `${screen}-compendium-grid-${tag}.png`) })
  await tile.click()
  await assertAll(page, '.compendium__detail[open] img', skin ? /\/assets\/skin-cards\/kratos\/ironclad__starter__bash\.webp$/ : /\/assets\/cards\/ironclad__starter__bash\.webp$/,
    `${screen} ${tag}: full-size zoom`)
  await page.screenshot({ path: resolve(output, `${screen}-compendium-zoom-${tag}.png`) })
  // Changing the preference re-renders the open compendium without a reload.
  if (skin) {
    await page.evaluate(() => {
      localStorage.removeItem('sts-skins:skinner')
      window.dispatchEvent(new Event('sts-skin-change'))
    })
    await page.waitForFunction(() => document.querySelector('.compendium__detail[open] img')?.currentSrc.includes('/assets/cards/ironclad__starter__bash.webp'))
  }
  await context.close()
}

/** The Shop's pack fans and the Stats card previews follow the viewer's saved choice like the compendium. */
async function shopAndStatsChecks(screen, viewport, skin) {
  const tag = skin ? 'skinned' : 'default'
  const context = await openContext(viewport, skin ? 'Skinner' : 'Plain', skin)
  const page = watch(await context.newPage())
  await page.goto(origin, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Shop', exact: true }).click()
  await page.locator('.shop-pack').first().waitFor()
  await assertAll(page, '.shop-pack[data-pack="slayer_ironclad"] .shop-fan__card', skin ? SKIN_THUMB : /\/assets\/cards-sm\/slayer__ironclad__/,
    `${screen} ${tag}: Ironclad pack fan`)
  await assertAll(page, '.shop-pack[data-pack="slayer_silent"] .shop-fan__card', /\/assets\/cards-sm\/slayer__silent__/,
    `${screen} ${tag}: Silent pack fan stays default`)
  await page.screenshot({ path: resolve(output, `${screen}-shop-fans-${tag}.png`) })
  await page.getByRole('button', { name: 'Back to main menu' }).click()

  await page.getByRole('button', { name: 'Stats', exact: true }).click()
  await page.getByRole('heading', { name: 'Deck archetypes' }).waitFor()
  const search = page.getByRole('searchbox', { name: 'Find a card for All of these' })
  await search.fill('Inflame')
  const options = page.getByRole('listbox', { name: 'All of these suggestions' }).getByRole('option')
  await options.first().waitFor()
  await assertAll(page, '.stats__suggestions img', skin ? SKIN_THUMB : DEFAULT_THUMB,
    `${screen} ${tag}: Stats suggestion previews`)
  await options.first().click()
  await search.fill('Neutralize')
  await assertAll(page, '.stats__suggestions img', /\/assets\/cards-sm\/silent__/, `${screen} ${tag}: Silent Stats preview stays default`)
  await search.fill('')
  await assertAll(page, '.stats__chip img', skin ? SKIN_THUMB : DEFAULT_THUMB, `${screen} ${tag}: Stats chip preview`)
  await page.screenshot({ path: resolve(output, `${screen}-stats-${tag}.png`) })
  await context.close()
}

async function onlineChecks(screen, viewport) {
  const annContext = await openContext(viewport, 'Ann', 'kratos')
  const boContext = await openContext(viewport, 'Bo', 'kratos') // Bo wears the skin for Ironclad too, but plays Silent.
  const ann = watch(await annContext.newPage())
  const bo = watch(await boContext.newPage())
  for (const [page, name] of [[ann, 'Ann'], [bo, 'Bo']]) {
    await page.goto(origin, { waitUntil: 'networkidle' })
    await setTestUsername(page, name)
  }
  await ann.getByRole('button', { name: 'Play online' }).click()
  await ann.locator('main.online-entry .online-character-roster').getByRole('button', { name: 'Ironclad' }).click()
  await ann.getByRole('button', { name: 'Create room' }).click()
  await ann.locator('.online-lobby').waitFor()
  const code = await ann.locator('.online-lobby h1').textContent()
  await bo.getByRole('button', { name: 'Play online' }).click()
  await bo.locator('main.online-entry .online-character-roster').getByRole('button', { name: 'Silent' }).click()
  await bo.getByLabel('Room code').fill(code)
  await bo.getByRole('button', { name: 'Join', exact: true }).click()
  await bo.locator('.online-lobby').waitFor()
  await ann.getByRole('button', { name: 'Enter the Spire' }).click()
  await ann.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
  await ann.getByRole('heading', { name: 'Neow’s Blessing' }).waitFor()
  const room = rooms.store.rooms.get(code)
  assert.deepEqual(room.run.players.map((player) => [player.character, player.skin ?? null]), [['ironclad', 'kratos'], ['silent', null]])
  room.run = { ...room.run, phase: 'combat', neow: null, combat: preparePlayerTurn(createCombat(createRng(73), room.run.players, [{ ...jaw, uid: 'online-enemy' }], 'skin-cards-online')) }
  room.version += 1
  rooms.publishRoom(code)
  for (const [page, expected, label] of [[ann, SKIN_THUMB, 'Ann (Ironclad, Kratos)'], [bo, /\/assets\/cards-sm\/silent__/, 'Bo (Silent)']]) {
    await page.locator('.hand .card').first().waitFor()
    await assertAll(page, '.hand .card > img:not(.card__gem)', expected, `${screen} online ${label}: hand faces`)
    await page.locator('[data-pile="draw"]').click()
    await assertAll(page, '.card-collection[open] .card > img:not(.card__gem)', expected, `${screen} online ${label}: draw pile faces`)
    await page.keyboard.press('Escape')
  }
  await ann.screenshot({ path: resolve(output, `${screen}-online-ann-ironclad-kratos.png`) })
  await bo.screenshot({ path: resolve(output, `${screen}-online-bo-silent.png`) })
  // The table's skin is the seat's, not this browser's saved choice.
  await ann.evaluate(() => {
    localStorage.removeItem('sts-skins:ann')
    window.dispatchEvent(new Event('sts-skin-change'))
  })
  await assertAll(ann, '.hand .card > img:not(.card__gem)', SKIN_THUMB, `${screen} online Ann: the seat's skin outlives the preference`)
  // A reload (reconnect) keeps every seat's faces: the skin lives in the published run.
  await ann.reload({ waitUntil: 'networkidle' })
  await ann.locator('.hand .card').first().waitFor()
  await assertAll(ann, '.hand .card > img:not(.card__gem)', SKIN_THUMB, `${screen} online Ann after reload: hand faces`)
  await annContext.close()
  await boContext.close()
}

try {
  for (const [screen, viewport] of SCREENS) {
    await soloChecks(screen, viewport, 'kratos')
    await soloChecks(screen, viewport, undefined)
    await menuChecks(screen, viewport, 'kratos')
    await menuChecks(screen, viewport, undefined)
    await shopAndStatsChecks(screen, viewport, 'kratos')
    await shopAndStatsChecks(screen, viewport, undefined)
    await onlineChecks(screen, viewport)
    console.log(`PASS ${screen}: skin card faces in solo hand, powers, piles, deck, reward, compendium, Shop, Stats and online seats; default look unchanged`)
  }
  assert.deepEqual(errors, [])
} finally {
  await browser.close()
  await vite.close()
  await rooms.close?.()
}
