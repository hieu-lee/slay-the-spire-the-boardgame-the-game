#!/usr/bin/env node
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium, devices, webkit } from 'playwright'
import { actionsForEnemy } from '../src/game/enemies.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(root, (process.argv.find((arg) => arg.startsWith('--out=')) ?? '--out=artifacts/animation-browser').slice(6))
const browserName = (process.argv.find((arg) => arg.startsWith('--browser=')) ?? '--browser=chromium').slice(10)
const mapOnly = process.argv.includes('--map-only')
const browserType = browserName === 'webkit' ? webkit : chromium
mkdirSync(output, { recursive: true })

const server = await createServer({ root, logLevel: 'silent', server: { port: 0 } })
await server.listen()
const address = server.httpServer?.address()
if (!address || typeof address === 'string') throw new Error('Vite did not report a port')
const browser = await browserType.launch({ headless: true })
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: browserName === 'webkit' ? 2 : 1,
})
await page.addInitScript(() => {
  window.__ANIMATION_SFX__ = []
  HTMLMediaElement.prototype.play = function play() {
    window.__ANIMATION_SFX__.push({
      path: new URL(this.src).pathname,
      cue: this.dataset.combatSfx ?? null,
      delayMs: Number(this.dataset.combatSfxDelay ?? 0),
    })
    return Promise.resolve()
  }
})
let releaseTimeEater
let phoneContext
let bossCount = 0
const timeEaterAssetGate = new Promise((resolve) => { releaseTimeEater = resolve })
await page.route('**/time_eater-attack.webp', async (route) => {
  await timeEaterAssetGate
  await route.continue()
})
page.setDefaultTimeout(30_000)
const failures = []
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(String(error)))

function check(condition, message) {
  if (!condition) failures.push(message)
}

async function screenshot(name) {
  await page.locator('.board').screenshot({ path: join(output, `${name}.png`) })
}

async function setPhase(phase) {
  await page.evaluate((next) => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.combat.phase = next
    debug.setRun(run)
  }, phase)
}

try {
  await page.goto(`http://localhost:${address.port}`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  check(await settings.getByText('Screen shake', { exact: true }).count() === 0,
    'the removed screen-shake setting is still visible')
  check(await settings.getByRole('button', { name: 'general' }).count() === 0 &&
    await settings.locator('nav').evaluate((nav) => getComputedStyle(nav).gridTemplateColumns.split(' ').length === 2),
  'settings left an empty General tab or grid column after removing screen shake')
  check(await page.evaluate(() => document.documentElement.dataset.screenShake === undefined),
    'the removed screen-shake runtime flag is still installed')
  await settings.getByRole('button', { name: /Back/ }).click()
  await page.getByRole('button', { name: 'Single Player', exact: true }).click()
  await page.getByRole('button', { name: 'Standard', exact: true }).click()
  await page.getByRole('button', { name: 'Embark' }).click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'neow')
  await page.evaluate(() => window.__STS_DEBUG__.reset(1, 'boss-gallery'))
  await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'neow')
  await page.evaluate(() => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    debug.setRun({
      ...run,
      phase: 'map',
      neow: null,
      players: run.players.map((player) => ({
        ...player,
        gold: 2,
        relics: player.relics.some((relic) => relic.defId === 'loaded_die')
          ? player.relics
          : [...player.relics, { defId: 'loaded_die', spent: false }],
      })),
    })
  })
  await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'map' && !document.querySelector('.neow-screen'))
  const mapRun = await page.evaluate(() => structuredClone(window.__STS_DEBUG__.getRun()))
  const map = page.locator('.map:not([inert])')
  const legend = map.locator('.map__legend')
  check(await legend.locator(':scope > strong').textContent() === 'Legend',
    'the parchment map legend is missing its title')
  check(await page.locator('.map .room').first().evaluate((room) => {
    const style = getComputedStyle(room)
    return style.borderStyle === 'none' && style.borderRadius === '0px'
  }), 'map locations are still rendered as circular orb buttons')
  check(await page.locator('.map .room--merchant > .icon').first().evaluate((icon) =>
    getComputedStyle(icon).clipPath.startsWith('circle')),
  'the merchant coin still shows its scanned paper square')
  await page.locator('.map .room--merchant').first().screenshot({
    path: join(output, `desktop-${browserName}-merchant-map-node.png`),
  })
  const legendBeforeScroll = await legend.boundingBox()
  const mapScroll = await map.evaluate(async (element) => {
    element.scrollTop = element.scrollHeight
    await new Promise((resolve) => requestAnimationFrame(resolve))
    return { top: element.scrollTop, max: element.scrollHeight - element.clientHeight }
  })
  const legendAfterScroll = await legend.boundingBox()
  check(mapScroll.max > 0 && mapScroll.top > 0, 'the map legend fixture did not scroll the map')
  check(Boolean(legendBeforeScroll && legendAfterScroll &&
    Math.abs(legendBeforeScroll.x - legendAfterScroll.x) <= 1 &&
    Math.abs(legendBeforeScroll.y - legendAfterScroll.y) <= 1 &&
    legendAfterScroll.x >= 0 && legendAfterScroll.y >= 0 &&
    legendAfterScroll.x + legendAfterScroll.width <= 1441 &&
    legendAfterScroll.y + legendAfterScroll.height <= 901),
  'the map legend moved or clipped when the map scrolled')
  await page.screenshot({ path: join(output, `desktop-${browserName}-scrolled-map-legend.png`) })
  const wingBootRace = await page.evaluate((initialRun) => {
    const run = structuredClone(initialRun)
    const current = Object.values(run.map.rooms).find((room) =>
      room.exits.length > 0 && (run.map.rows[room.row + 1] ?? []).some((id) => !room.exits.includes(id)))
    if (!current) throw new Error('map fixture has no Wing Boots detour')
    const wingTarget = run.map.rows[current.row + 1].find((id) => !current.exits.includes(id))
    if (!wingTarget) throw new Error('map fixture has no Wing Boots target')
    const rooms = { ...run.map.rooms, [current.id]: { ...current, visited: true } }
    run.phase = 'map'
    run.map = { ...run.map, position: current.id, rooms }
    run.players = [...run.players.map((player) => ({
      ...player,
      relics: [...player.relics.filter((relic) => relic.defId !== 'wing_boots'), { defId: 'wing_boots', uses: 3 }],
    })), { ...run.players[0], id: 'map-race-p2', name: 'Map race player', row: 1 }]
    window.__STS_DEBUG__.setRun(run)
    return { normalTarget: current.exits[0], wingTarget }
  }, mapRun)
  await page.waitForFunction(() => document.querySelector('.map-prompt') !== null)
  check(await page.locator('.map-row-switch select').count() > 0,
    'the map-race fixture did not expose the row-switch action')
  await page.locator(`[data-room="${wingBootRace.normalTarget}"]`).click()
  await page.waitForFunction(() => document.querySelector('.map-prompt, .map-row-switch') === null)
  await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase !== 'map')
  check(await page.evaluate((target) => window.__STS_DEBUG__.getRun().map.position === target, wingBootRace.normalTarget),
    'Wing Boots could replace a room already selected for the pencil-circle transition')
  await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), mapRun)
  await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'map')
  await page.setViewportSize({ width: 844, height: 390 })
  const horizontalSelectedRoom = page.locator('.room--reachable').first()
  await horizontalSelectedRoom.click()
  await page.waitForTimeout(180)
  check(await horizontalSelectedRoom.evaluate((room) => room.classList.contains('room--selected') &&
    getComputedStyle(room.querySelector('.map__ink')).animationName === 'map-ink-draw'),
  'the horizontal-phone map chooser did not draw the selected room before leaving')
  await page.screenshot({ path: join(output, `short-wide-${browserName}-selecting-map-room.png`) })
  check(await page.evaluate(() => document.documentElement.dataset.mapTransition === 'true'),
    'the horizontal-phone map chooser did not fade into the selected room')
  await page.locator('.combat').waitFor()
  await page.waitForFunction(() => document.documentElement.dataset.mapTransition === undefined)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), mapRun)
  await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'map')
  const selectedRoom = page.locator('.room--reachable').first()
  await selectedRoom.click()
  check(await selectedRoom.evaluate((room) => room.classList.contains('room--selected') &&
    Boolean(room.querySelector('.map__ink'))), 'choosing a room did not draw its pencil-circle transition')
  await page.waitForTimeout(180)
  check(await selectedRoom.locator('.map__ink').evaluate((ink) => {
    const style = getComputedStyle(ink)
    return style.animationName === 'map-ink-draw' && style.clipPath !== 'none'
  }), 'the pencil-circle transition did not visibly draw before the screen fade')
  await page.screenshot({ path: join(output, `desktop-${browserName}-selecting-map-room.png`) })
  check(await page.evaluate(() => document.documentElement.dataset.mapTransition === 'true'),
    'choosing a room did not start the map-to-room fade')
  await page.locator('.combat').waitFor()
  if (await page.getByRole('button', { name: 'Resolve start of turn' }).count()) {
    await page.getByRole('button', { name: 'Resolve start of turn' }).click()
  }
  await page.getByRole('button', { name: 'Map', exact: true }).click()
  const mapDialog = page.getByRole('dialog', { name: /Act 1 map/ })
  const mapPanel = mapDialog.locator('.map-peek__panel')
  const overlayMap = mapDialog.locator('.map')
  const overlayLegend = overlayMap.locator('.map__legend')
  await overlayLegend.waitFor()
  check(await overlayMap.locator('.room--visited .map__ink').count() > 0,
    'cleared map locations are missing their pencil-circle marks')
  await overlayMap.locator('.room--visited').first().screenshot({
    path: join(output, `desktop-${browserName}-visited-map-room.png`),
  })
  const overlayLegendBefore = await overlayLegend.boundingBox()
  await overlayMap.evaluate(async (element) => {
    element.scrollTop = element.scrollHeight
    await new Promise((resolve) => requestAnimationFrame(resolve))
  })
  await page.screenshot({ path: join(output, `desktop-${browserName}-visited-map-dialog.png`) })
  const [overlayLegendAfter, mapPanelBox] = await Promise.all([
    overlayLegend.boundingBox(), mapPanel.boundingBox(),
  ])
  check(Boolean(overlayLegendBefore && overlayLegendAfter && mapPanelBox &&
    Math.abs(overlayLegendBefore.x - overlayLegendAfter.x) <= 1 &&
    Math.abs(overlayLegendBefore.y - overlayLegendAfter.y) <= 1 &&
    overlayLegendAfter.x >= mapPanelBox.x &&
    overlayLegendAfter.x + overlayLegendAfter.width <= mapPanelBox.x + mapPanelBox.width),
  'the desktop map-dialog legend moved or clipped when the map scrolled')
  for (const viewport of [
    { width: 844, height: 390, name: 'short-wide' },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    const [responsiveLegendBox, mapHeaderBox, closeBox] = await Promise.all([
      overlayLegend.boundingBox(), mapPanel.locator(':scope > header').boundingBox(),
      mapDialog.getByRole('button', { name: 'Close' }).boundingBox(),
    ])
    const closeOwnsCentre = await page.evaluate(({ x, y }) => {
      const hit = document.elementFromPoint(x, y)
      return Boolean(hit?.closest('button')?.textContent?.includes('Close'))
    }, { x: (closeBox?.x ?? 0) + (closeBox?.width ?? 0) / 2,
      y: (closeBox?.y ?? 0) + (closeBox?.height ?? 0) / 2 })
    check(Boolean(responsiveLegendBox && mapHeaderBox && closeBox && closeOwnsCentre &&
      responsiveLegendBox.y >= mapHeaderBox.y + mapHeaderBox.height &&
      responsiveLegendBox.x >= 0 && responsiveLegendBox.x + responsiveLegendBox.width <= viewport.width + 1),
    `the ${viewport.name} map-dialog legend clips the dialog header or Close button`)
    await page.screenshot({ path: join(output, `${viewport.name}-${browserName}-scrolled-map-legend.png`) })
  }
  await mapDialog.getByRole('button', { name: 'Close' }).click()
  await page.setViewportSize({ width: 1440, height: 900 })

  await page.waitForFunction(() => document.documentElement.dataset.mapTransition === undefined)
  await page.evaluate((run) => {
    document.documentElement.dataset.reducedMotion = 'true'
    window.__MAP_REDUCED_SELECTION_STARTED_AT__ = performance.now()
    window.__STS_DEBUG__.setRun(run)
  }, mapRun)
  await page.locator('.room--reachable').first().click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase !== 'map')
  const reducedSelection = await page.evaluate(() => ({
    elapsed: performance.now() - window.__MAP_REDUCED_SELECTION_STARTED_AT__,
    transition: document.documentElement.dataset.mapTransition,
  }))
  check(reducedSelection.elapsed < 220 && reducedSelection.transition === undefined,
    `reduced-motion map selection delayed or faded ${JSON.stringify(reducedSelection)}`)
  await page.evaluate(() => { document.documentElement.dataset.reducedMotion = 'false' })

  if (!mapOnly) {
  const template = await page.evaluate(() => {
    const combat = window.__STS_DEBUG__.getRun().combat
    return { combat: structuredClone(combat), enemy: structuredClone(combat.enemies[0]) }
  })
  const fastDragFixture = await page.evaluate(() => ({
    handSize: window.__STS_DEBUG__.getState().players[0].hand.length,
    attackIndex: window.__STS_DEBUG__.getState().players[0].hand
      .findIndex((card) => card.defId.startsWith('strike')),
  }))
  check(fastDragFixture.attackIndex >= 0, 'desktop fast-drag fixture has no attack card')
  if (fastDragFixture.attackIndex >= 0) {
    const card = page.locator('.hand .card').nth(fastDragFixture.attackIndex)
    const enemy = page.locator('.enemy').first()
    await card.hover()
    const [from, to] = await Promise.all([card.boundingBox(), enemy.boundingBox()])
    if (!from || !to) throw new Error('desktop fast-drag fixture is not visible')
    const viewport = page.viewportSize()
    if (!viewport) throw new Error('desktop fast-drag fixture has no viewport')
    const startX = (Math.max(0, from.x) + Math.min(viewport.width, from.x + from.width)) / 2
    await page.mouse.move(startX, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(startX + 30, from.y + from.height / 2)
    check(await page.locator('.card-drag').count() === 0,
      'a horizontal hand movement immediately opened card targeting feedback')
    await page.mouse.move(startX + 240, from.y + from.height / 2 - 80)
    await page.locator('.card-drag').waitFor({ timeout: 500 })
    check(await page.locator('.card-target-arrow').isVisible(),
      'a shallow drag toward the enemy delayed its card and targeting feedback')
    await page.screenshot({ path: join(output, `desktop-${browserName}-shallow-card-drag.png`) })
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2)
    await page.mouse.up()
    await page.waitForFunction((size) => window.__STS_DEBUG__.getState().players[0].hand.length < size,
      fastDragFixture.handSize)
  }
  await page.evaluate((combat) => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.combat = structuredClone(combat)
    debug.setRun(run)
  }, template.combat)
  if (fastDragFixture.attackIndex >= 0) {
    const card = page.locator('.hand .card').nth(fastDragFixture.attackIndex)
    const enemy = page.locator('.enemy').first()
    await card.hover()
    const [from, to] = await Promise.all([card.boundingBox(), enemy.boundingBox()])
    if (!from || !to) throw new Error('release-only fast-drag fixture is not visible')
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(from.x + from.width / 2 - 30, from.y + from.height / 2)
    await card.dispatchEvent('pointerup', {
      pointerId: 1, pointerType: 'mouse', button: 0, bubbles: true,
      clientX: to.x + to.width / 2, clientY: to.y + to.height / 2,
    })
    await page.mouse.up()
    await page.waitForFunction((size) => window.__STS_DEBUG__.getState().players[0].hand.length < size,
      fastDragFixture.handSize)
  }
  await page.evaluate((combat) => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.combat = structuredClone(combat)
    run.combat.players[0].energy = 0
    run.combat.players[0].hand = Array.from({ length: 20 }, (_, index) => ({
      uid: `fast-scroll-${index}`,
      defId: index % 2 === 0 ? 'defend_ironclad' : 'strike_ironclad',
      upgraded: false,
    }))
    debug.setRun(run)
  }, template.combat)
  const largeHandScroller = page.locator('.hand-scroll')
  const middleCard = page.locator('.hand .card').nth(10)
  await middleCard.hover()
  const largeHandScrollBefore = await largeHandScroller.evaluate((scroller) => scroller.scrollLeft)
  const middleCardBox = await middleCard.boundingBox()
  if (!middleCardBox) throw new Error('large-hand scroll fixture is not visible')
  await page.mouse.move(middleCardBox.x + middleCardBox.width / 2, middleCardBox.y + middleCardBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(middleCardBox.x + middleCardBox.width / 2 - 200, middleCardBox.y + middleCardBox.height / 2)
  await page.mouse.up()
  check(await largeHandScroller.evaluate((scroller, before) => scroller.scrollLeft > before,
    largeHandScrollBefore),
    'a horizontal card drag did not scroll an overflowing hand')
  check(await page.locator('.hand .card').count() === 20,
    'a horizontal hand scroll accidentally played a card')
  check(await page.locator('.hand .card--unplayable').count() === 20,
    'large-hand scroll fixture did not cover unplayable cards')
  await page.evaluate(() => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.combat.players[0].energy = 20
    debug.setRun(run)
  })
  await page.waitForFunction(() => !document.querySelector('.hand .card--unplayable'))
  await largeHandScroller.evaluate((scroller) => { scroller.scrollLeft = 0 })
  await middleCard.hover()
  const jitterScrollBefore = await largeHandScroller.evaluate((scroller) => scroller.scrollLeft)
  const jitterCardBox = await middleCard.boundingBox()
  if (!jitterCardBox) throw new Error('large-hand jitter fixture is not visible')
  await page.mouse.move(jitterCardBox.x + jitterCardBox.width / 2, jitterCardBox.y + jitterCardBox.height / 2)
  await page.mouse.down()
  await middleCard.dispatchEvent('pointerup', {
    pointerId: 1, pointerType: 'mouse', button: 0, bubbles: true,
    clientX: jitterCardBox.x + jitterCardBox.width / 2 - 200,
    clientY: jitterCardBox.y + jitterCardBox.height / 2 - 11,
  })
  await page.mouse.up()
  check(await largeHandScroller.evaluate((scroller, before) => scroller.scrollLeft > before,
    jitterScrollBefore), 'upward finger jitter cancelled a horizontal hand scroll')
  check(await page.locator('.hand .card').count() === 20,
    'upward finger jitter played a player-targeting card during horizontal scrolling')
  check(await page.locator('.card-drag').count() === 0,
    'leftward finger jitter opened player-targeting feedback during horizontal scrolling')
  const enemyCard = page.locator('.hand .card').nth(11)
  await largeHandScroller.evaluate((scroller) => { scroller.scrollLeft = scroller.scrollWidth })
  await enemyCard.scrollIntoViewIfNeeded()
  const enemyScrollBefore = await largeHandScroller.evaluate((scroller) => scroller.scrollLeft)
  const enemyCardBox = await enemyCard.boundingBox()
  if (!enemyCardBox) throw new Error('enemy-targeting jitter fixture is not visible')
  await page.mouse.move(enemyCardBox.x + enemyCardBox.width / 2, enemyCardBox.y + enemyCardBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(enemyCardBox.x + enemyCardBox.width / 2 + 200,
    enemyCardBox.y + enemyCardBox.height / 2 - 11)
  await page.mouse.up()
  check(await largeHandScroller.evaluate((scroller, before) => scroller.scrollLeft < before,
    enemyScrollBefore), 'rightward finger jitter cancelled an enemy-targeting hand scroll')
  check(await page.locator('.card-drag').count() === 0,
    'rightward finger jitter opened enemy-targeting feedback during horizontal scrolling')
  await largeHandScroller.evaluate((scroller) => { scroller.scrollLeft = 0 })
  await middleCard.hover()
  const armedScrollBefore = await largeHandScroller.evaluate((scroller) => scroller.scrollLeft)
  const armedCardBox = await middleCard.boundingBox()
  if (!armedCardBox) throw new Error('armed horizontal-release fixture is not visible')
  await page.mouse.move(armedCardBox.x + armedCardBox.width / 2, armedCardBox.y + armedCardBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(armedCardBox.x + armedCardBox.width / 2, armedCardBox.y + armedCardBox.height / 2 - 20)
  await page.locator('.card-drag').waitFor()
  await page.mouse.move(armedCardBox.x + armedCardBox.width / 2 - 200,
    armedCardBox.y + armedCardBox.height / 2 - 11)
  await page.mouse.up()
  check(await largeHandScroller.evaluate((scroller, before) => scroller.scrollLeft > before,
    armedScrollBefore), 'a final horizontal release did not override an earlier card-drag frame')
  check(await page.locator('.hand .card').count() === 20,
    'a final horizontal release played a targetless card armed by an earlier pointer move')
  await largeHandScroller.evaluate((scroller) => { scroller.scrollLeft = 0 })
  await middleCard.hover()
  const returnCardBox = await middleCard.boundingBox()
  if (!returnCardBox) throw new Error('out-and-back scroll fixture is not visible')
  await page.mouse.move(returnCardBox.x + returnCardBox.width / 2, returnCardBox.y + returnCardBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(returnCardBox.x + returnCardBox.width / 2 - 200, returnCardBox.y + returnCardBox.height / 2)
  await page.mouse.move(returnCardBox.x + returnCardBox.width / 2, returnCardBox.y + returnCardBox.height / 2)
  await page.mouse.up()
  await page.waitForTimeout(0)
  check(await page.locator('.hand .card').count() === 20,
    'an out-and-back hand scroll emitted a card-playing click')

  await page.evaluate(({ base }) => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.combat = structuredClone(base)
    run.combat.combatId = `${run.combat.combatId}-stable-layout`
    run.combat.phase = 'player'
    run.combat.players[0].potions = ['weak_potion']
    debug.setRun(run)
  }, { base: template.combat })
  await page.getByRole('button', { name: 'Use Weak Potion' }).waitFor()
  const stageBounds = () => page.locator('.combat').evaluate((combat) => {
    const box = (selector) => combat.querySelector(selector).getBoundingClientRect().toJSON()
    return { board: box('.board'), seat: box('.seat') }
  })
  const potionStage = await stageBounds()
  await page.evaluate(() => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.combat.players[0].potions = []
    debug.setRun(run)
  })
  await page.waitForFunction(() => !document.querySelector('[aria-label="Use Weak Potion"]'))
  const plainStage = await stageBounds()
  await page.evaluate(() => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.combat.phase = 'won'
    debug.setRun(run)
  })
  await page.locator('.combat__result--won').waitFor()
  const victoryStage = await stageBounds()
  for (const [name, stage] of [['no potion', plainStage], ['victory', victoryStage]]) {
    check(['top', 'bottom', 'height'].every((key) =>
      Math.abs(stage.board[key] - potionStage.board[key]) <= 1 &&
      Math.abs(stage.seat[key] - potionStage.seat[key]) <= 1),
    `${name} shifted the combat stage ${JSON.stringify({ potionStage, stage })}`)
  }
  const victoryHud = await page.locator('.combat').evaluate((combat) => {
    const box = (selector) => combat.querySelector(selector).getBoundingClientRect().toJSON()
    return { bar: box('.combat__bar'), result: box('.combat__result') }
  })
  check(victoryHud.result.top >= victoryHud.bar.bottom - 1,
    `Victory banner overlaps the HUD ${JSON.stringify(victoryHud)}`)
  await page.locator('.combat').screenshot({ path: join(output, `desktop-${browserName}-stable-victory-stage.png`) })

  const bossIds = [
    'awakened_one_phase_1', 'awakened_one_phase_2', 'bronze_automaton', 'corrupt_heart',
    'deca', 'donu', 'guardian_attack', 'guardian_defensive', 'hexaghost', 'slime_boss',
    'the_champ', 'the_collector', 'time_eater',
    'downfall_witch', 'downfall_dark_core', 'downfall_wrathful',
    'downfall_orb_master', 'downfall_inferno', 'downfall_trickster',
    'downfall_demon', 'downfall_wraith', 'downfall_blasphemer', 'downfall_neow',
    'downfall_doppelganger', 'downfall_corrupted',
  ]
  bossCount = bossIds.length
  const meleeBossIds = new Set([
    'awakened_one_phase_1', 'awakened_one_phase_2', 'bronze_automaton', 'donu',
    'guardian_attack', 'guardian_defensive', 'slime_boss', 'the_champ', 'time_eater',
    'downfall_wrathful', 'downfall_trickster', 'downfall_demon', 'downfall_doppelganger',
  ])
  const projectileBossIds = new Set([
    'downfall_blasphemer', 'downfall_corrupted', 'downfall_dark_core', 'downfall_inferno',
    'downfall_neow', 'downfall_orb_master', 'downfall_witch', 'downfall_wraith',
  ])

  for (const defId of bossIds) {
    const fixture = { ...template.enemy, uid: 'animation-boss', defId, isBoss: true, hp: 999, maxHp: 999, dead: false }
    let actionIndex = 0
    while (actionIndex < 8 && !actionsForEnemy({ ...fixture, actionIndex }, template.combat.die)
      .some((action) => action.kind === 'attack' || action.kind === 'attackSequence')) actionIndex++
    check(actionIndex < 8, `${defId}: no attack action found`)
    await page.evaluate(({ base, enemy, actionIndex, projectile }) => {
      const debug = window.__STS_DEBUG__
      const run = structuredClone(debug.getRun())
      run.combat = structuredClone(base)
      run.combat.enemies = [{ ...enemy, actionIndex }]
      run.combat.phase = 'player'
      for (const player of run.combat.players) Object.assign(player, { hp: 999, maxHp: 999, dead: false })
      if (projectile) {
        run.combat.players.push({
          ...structuredClone(run.combat.players[0]), id: 'projectile-target-2', row: 1,
          name: 'Silent', character: 'silent', hp: 999, maxHp: 999, dead: false,
        })
      }
      debug.setRun(run)
    }, {
      base: template.combat, enemy: fixture, actionIndex,
      projectile: projectileBossIds.has(defId),
    })
    const card = page.locator(`.enemy--boss[data-enemy-def="${defId}"]`)
    await card.waitFor()
    await page.waitForFunction((id) =>
      document.querySelector(`.enemy--boss[data-enemy-def="${id}"]`)?.getAttribute('data-animation') === 'idle', defId)
    await screenshot(`boss-${defId}-idle`)
    if (defId === 'downfall_demon') {
      await page.locator('.board').evaluate((board) => {
        const fixture = document.createElement('span')
        fixture.className = 'seat seat--dead dead-target-fixture'
        Object.assign(fixture.style, { position: 'absolute', right: '0', top: '40%', opacity: '0' })
        const portrait = document.createElement('span')
        portrait.className = 'seat__portrait'
        portrait.append(board.querySelector('.seat__portrait > img').cloneNode())
        fixture.append(portrait)
        board.append(fixture)
      })
    }
    await setPhase('enemy')
    await page.waitForFunction((id) =>
      document.querySelector(`.enemy--boss[data-enemy-def="${id}"]`)?.getAttribute('data-animation') === 'attack', defId)
    if (defId === 'time_eater') {
      const cold = await card.locator('.enemy__art--cutout').evaluate((art) => ({
        naturalHeight: art.naturalHeight,
        dash: getComputedStyle(art.closest('.enemy')).getPropertyValue('--boss-dash-x'),
      }))
      check(cold.naturalHeight === 0 && cold.dash === '', `time_eater: cold-load fixture was not cold ${JSON.stringify(cold)}`)
      releaseTimeEater()
      await page.waitForFunction(() => {
        const art = document.querySelector('.enemy--boss[data-enemy-def="time_eater"] .enemy__art--cutout')
        if (!art) return false
        const dash = Number.parseFloat(getComputedStyle(art.closest('.enemy')).getPropertyValue('--boss-dash-x'))
        return art.naturalHeight > 0 && Number.isFinite(dash)
      })
    }
    const attackStartedAt = Date.now()
    const waitUntilAttackTime = (time) => page.waitForTimeout(Math.max(0, time - (Date.now() - attackStartedAt)))
    await waitUntilAttackTime(220)
    const windupRect = await card.locator('.enemy__art--cutout').evaluate((art) => {
      const rect = art.getBoundingClientRect()
      const canvas = document.createElement('canvas')
      canvas.width = art.naturalWidth
      canvas.height = art.naturalHeight
      const context = canvas.getContext('2d')
      context.drawImage(art, 0, 0)
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
      let lowerBodyRight = -1
      for (let y = Math.round(canvas.height * 0.72); y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
          if (pixels[(y * canvas.width + x) * 4 + 3] > 16) lowerBodyRight = Math.max(lowerBodyRight, x + 1)
        }
      }
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
        width: innerWidth, height: innerHeight, lowerBodyRight }
    })
    check(windupRect.left >= -1 && windupRect.right <= windupRect.width + 1 &&
      windupRect.top >= -1 && windupRect.bottom <= windupRect.height + 1,
    `${defId}: wind-up art leaves viewport ${JSON.stringify(windupRect)}`)
    await screenshot(`boss-${defId}-windup`)
    if (defId === 'downfall_demon') {
      const takeoffSplat = await card.locator('.boss-demon-ground-splat').evaluateAll((splats) => splats.map((splat) => ({
        className: splat.className,
        opacity: Number(getComputedStyle(splat).opacity),
        image: getComputedStyle(splat).backgroundImage,
      })))
      check(takeoffSplat.length === 2 && takeoffSplat[0].opacity > 0.2 && takeoffSplat[1].opacity < 0.05 &&
        takeoffSplat.every(({ image }) => image.includes('downfall-demon-ground-splat.webp')),
      `downfall_demon: takeoff did not separate the ground splat from the airborne body ${JSON.stringify(takeoffSplat)}`)
      await waitUntilAttackTime(430)
      const launch = await card.evaluate((enemy) => {
        const art = enemy.querySelector('.enemy__art--cutout')
        const rect = art.getBoundingClientRect()
        const style = getComputedStyle(enemy)
        const x = style.getPropertyValue('--boss-launch-x').trim()
        const y = style.getPropertyValue('--boss-launch-y').trim()
        return {
          animation: getComputedStyle(art).animationName,
          offscreen: rect.bottom < enemy.closest('.board').getBoundingClientRect().top,
          remValues: x.endsWith('rem') && y.endsWith('rem'),
          slope: Math.abs(Number.parseFloat(x) / Number.parseFloat(y)),
        }
      })
      check(launch.animation === 'boss-demon-aerial-slam, boss-demon-airborne-visibility' &&
        launch.offscreen && launch.remValues &&
        Math.abs(launch.slope - 0.291) < 0.002,
      `downfall_demon: launch did not follow its measured 16.2deg offscreen angle ${JSON.stringify(launch)}`)
      await screenshot('boss-downfall_demon-offscreen')
    }
    await waitUntilAttackTime(1005)
    await screenshot(`boss-${defId}-impact`)
    await page.evaluate(() => {
      for (const animation of document.getAnimations()) {
        const name = animation.animationName ?? ''
        if (name.startsWith('boss-') || name.startsWith('awakened-')) {
          animation.currentTime = 1005
          animation.pause()
        }
      }
    })
    if (defId === 'downfall_demon') {
      const impact = await card.evaluate((enemy) => {
        const airborne = enemy.querySelector('.enemy__art--cutout')
        const grounded = enemy.querySelector('.boss-demon-grounded')
        return {
          airborneOpacity: Number(getComputedStyle(airborne).opacity),
          groundedOpacity: Number(getComputedStyle(grounded).opacity),
          groundedLoaded: grounded.complete && grounded.naturalWidth > 0,
          targetSplatOpacity: Number(getComputedStyle(
            enemy.querySelector('.boss-demon-ground-splat--target'),
          ).opacity),
        }
      })
      check(impact.targetSplatOpacity > 0.2 && impact.airborneOpacity < 0.05 &&
        impact.groundedOpacity > 0.5 && impact.groundedLoaded,
      `downfall_demon: target landing did not use its body-only slam and separate splat ${JSON.stringify(impact)}`)
    }
    const audit = await card.evaluate((enemy) => {
      const art = enemy.querySelector('.enemy__art--cutout')
      const artStyle = getComputedStyle(art)
      const rect = art.getBoundingClientRect()
      const contactLeft = Number.parseFloat(getComputedStyle(enemy).getPropertyValue('--boss-contact-left'))
      const heroes = [...enemy.closest('.board').querySelectorAll('.seat:not(.seat--dead) .seat__portrait > img')]
      const saved = heroes.map((hero) => hero.style.animation)
      heroes.forEach((hero) => { hero.style.animation = 'none' })
      const heroRight = Math.max(...heroes.map((hero) => hero.getBoundingClientRect().right))
      heroes.forEach((hero, index) => { hero.style.animation = saved[index] ?? '' })
      const effect = getComputedStyle(enemy, '::after')
      const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
      const canvas = document.createElement('canvas')
      canvas.width = art.naturalWidth
      canvas.height = art.naturalHeight
      const context = canvas.getContext('2d')
      context.drawImage(art, 0, 0)
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
      let lowerBodyRight = -1
      for (let y = Math.round(canvas.height * 0.72); y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
          if (pixels[(y * canvas.width + x) * 4 + 3] > 16) lowerBodyRight = Math.max(lowerBodyRight, x + 1)
        }
      }
      return {
        motion: enemy.getAttribute('data-attack-motion'),
        image: art.getAttribute('src'),
        loaded: art.complete && art.naturalWidth > 0,
        animation: artStyle.animationName,
        duration: artStyle.animationDuration,
        lowerBodyRight,
        rect: {
          left: rect.left, visibleLeft: rect.left + contactLeft / art.naturalHeight * rect.height,
          right: rect.right, top: rect.top, bottom: rect.bottom,
        },
        heroRight,
        viewport: { width: innerWidth, height: innerHeight },
        effect: {
          animation: effect.animationName,
          duration: effect.animationDuration,
          image: effect.backgroundImage,
          opacity: effect.opacity,
          right: effect.right,
          bottom: effect.bottom,
          width: effect.width,
          height: effect.height,
          transform: effect.transform,
          translate: effect.translate,
        },
        targets: [...enemy.closest('.board').querySelectorAll('.seat:not(.seat--dead) .seat__portrait')]
          .map((target) => {
            const style = getComputedStyle(target, '::before')
            return { animation: style.animationName, duration: style.animationDuration, image: style.backgroundImage }
          }),
        projectiles: [...enemy.querySelectorAll('.boss-projectile')].map((projectile) => {
          const style = getComputedStyle(projectile)
          const playerId = projectile.dataset.targetPlayer
          const target = enemy.closest('.board')
            .querySelector(`.seat[data-player-id="${CSS.escape(playerId)}"] .seat__portrait`)
          const targetRect = target?.getBoundingClientRect()
          const startXValue = style.getPropertyValue('--boss-projectile-start-x').trim()
          const startYValue = style.getPropertyValue('--boss-projectile-start-y').trim()
          const deltaXValue = style.getPropertyValue('--boss-projectile-x').trim()
          const deltaYValue = style.getPropertyValue('--boss-projectile-y').trim()
          const startX = enemy.getBoundingClientRect().left + Number.parseFloat(startXValue) * rem
          const startY = enemy.getBoundingClientRect().top + Number.parseFloat(startYValue) * rem
          const image = projectile.querySelector('img')
          return {
            playerId,
            animation: style.animationName,
            duration: style.animationDuration,
            delay: style.animationDelay,
            remValues: [startXValue, startYValue, deltaXValue, deltaYValue].every((value) => value.endsWith('rem')),
            reachesTarget: Boolean(targetRect &&
              Math.abs(startX + Number.parseFloat(deltaXValue) * rem - (targetRect.left + targetRect.width / 2)) <= 1 &&
              Math.abs(startY + Number.parseFloat(deltaYValue) * rem - (targetRect.top + targetRect.height / 2)) <= 1),
            image: image?.getAttribute('src') ?? '',
            loaded: Boolean(image?.complete && image.naturalWidth > 0),
          }
        }),
      }
    })
    const expectedAttackArt = defId === 'downfall_demon'
      ? '/animations/downfall_demon-airborne.webp'
      : '-attack.webp'
    check(audit.loaded && audit.image.endsWith(expectedAttackArt), `${defId}: attack art did not load`)
    check(audit.duration === (defId === 'downfall_demon' ? '1.83s, 1.83s' : '1.83s'),
      `${defId}: body duration is ${audit.duration}`)
    check(audit.motion === (meleeBossIds.has(defId) ? 'melee' : 'ranged'),
      `${defId}: expected ${meleeBossIds.has(defId) ? 'melee' : 'ranged'} motion, got ${audit.motion}`)
    check(audit.rect.left >= -1 && audit.rect.right <= audit.viewport.width + 1 &&
      audit.rect.top >= -1 && audit.rect.bottom <= audit.viewport.height + 1,
    `${defId}: attack art leaves viewport ${JSON.stringify(audit.rect)}`)
    if (audit.motion === 'melee') {
      check(defId === 'downfall_demon'
        ? audit.animation === 'boss-demon-aerial-slam, boss-demon-airborne-visibility'
        : audit.animation === 'boss-melee-dash',
        `${defId}: missing melee motion`)
      check(Math.abs(audit.rect.visibleLeft - audit.heroRight) <= 2,
        `${defId}: visible edge ${audit.rect.visibleLeft} missed hero edge ${audit.heroRight}`)
    } else {
      check(audit.animation === 'boss-ranged-cast', `${defId}: missing ranged cast`)
    }
    if (projectileBossIds.has(defId)) {
      check(audit.projectiles.length === 2 && new Set(audit.projectiles.map(({ playerId }) => playerId)).size === 2 &&
        audit.projectiles.every((projectile) => projectile.loaded && projectile.remValues && projectile.reachesTarget &&
          projectile.animation === 'boss-projectile-flight' && projectile.duration === '0.55s' &&
          projectile.delay === '0.18s' && projectile.image.endsWith(`/projectiles/${defId}.webp`)),
      `${defId}: projectiles did not fly independently to both players ${JSON.stringify(audit.projectiles)}`)
    } else {
      check(audit.projectiles.length === 0, `${defId}: unexpected projectile ${JSON.stringify(audit.projectiles)}`)
    }
    if (defId === 'downfall_demon') {
      check(await page.locator('.dead-target-fixture').count() === 1,
        `${defId}: dead-seat melee targeting fixture is missing`)
    }
    if (defId === 'awakened_one_phase_1') {
      check(audit.targets.length > 0 && audit.targets.every((effect) =>
        effect.animation === 'awakened-claw-scratch' && effect.duration === '0.55s' &&
        effect.image.includes('awakened-claw-scratch.webp')), 'Awakened One phase 1 target scratches are missing')
    }
    if (defId === 'awakened_one_phase_2') {
      check(audit.effect.animation === 'awakened-blue-fire' && audit.effect.duration === '0.55s' &&
        audit.effect.image.includes('awakened-blue-fire.webp') && Number(audit.effect.opacity) > 0.5,
      `Awakened One phase 2 breath is missing: ${JSON.stringify(audit.effect)}`)
    }
    if (defId === 'downfall_demon') {
      await waitUntilAttackTime(1450)
      await page.evaluate(() => {
        for (const animation of document.getAnimations()) {
          if (animation.animationName?.startsWith('boss-demon-')) animation.currentTime = 1450
        }
      })
      const returnPose = await card.evaluate((enemy) => {
        const airborne = enemy.querySelector('.enemy__art--cutout')
        const grounded = enemy.querySelector('.boss-demon-grounded')
        return {
          airborneOpacity: Number(getComputedStyle(airborne).opacity),
          groundedOpacity: Number(getComputedStyle(grounded).opacity),
          offscreen: airborne.getBoundingClientRect().bottom < enemy.closest('.board').getBoundingClientRect().top,
        }
      })
      check(returnPose.airborneOpacity > 0.5 && returnPose.groundedOpacity < 0.05 && returnPose.offscreen,
        `downfall_demon: return ascent did not switch back to its airborne body ${JSON.stringify(returnPose)}`)
      await screenshot('boss-downfall_demon-return-ascent')
    }
    const recoverySample = defId === 'downfall_demon' ? 1780 : 1500
    await waitUntilAttackTime(recoverySample)
    await page.evaluate((time) => {
      for (const animation of document.getAnimations()) {
        const name = animation.animationName ?? ''
        if (name.startsWith('boss-') || name.startsWith('awakened-')) animation.currentTime = time
      }
    }, recoverySample)
    check(await card.getAttribute('data-animation') === 'attack', `${defId}: attack art unlatched during recovery`)
    const recoveryLowerBodyRight = await card.locator('.enemy__art--cutout').evaluate((art) => {
      const canvas = document.createElement('canvas')
      canvas.width = art.naturalWidth
      canvas.height = art.naturalHeight
      const context = canvas.getContext('2d')
      context.drawImage(art, 0, 0)
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
      let right = -1
      for (let y = Math.round(canvas.height * 0.72); y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
          if (pixels[(y * canvas.width + x) * 4 + 3] > 16) right = Math.max(right, x + 1)
        }
      }
      return right
    })
    if (defId === 'downfall_demon') {
      const returnLanding = await card.evaluate((enemy) => ({
        airborneOpacity: Number(getComputedStyle(enemy.querySelector('.enemy__art--cutout')).opacity),
        groundedOpacity: Number(getComputedStyle(enemy.querySelector('.boss-demon-grounded')).opacity),
        originSplatOpacity: Number(getComputedStyle(
          enemy.querySelector('.boss-demon-ground-splat--origin'),
        ).opacity),
      }))
      check(returnLanding.originSplatOpacity > 0.2 && returnLanding.airborneOpacity < 0.05 &&
        returnLanding.groundedOpacity > 0.5,
      `downfall_demon: return landing did not use its body-only slam and separate splat ${JSON.stringify(returnLanding)}`)
    }
    if (defId === 'deca') {
      const landmarks = [windupRect.lowerBodyRight, audit.lowerBodyRight, recoveryLowerBodyRight]
      check(Math.max(...landmarks) - Math.min(...landmarks) <= 4,
        `deca: ranged actor landmark moves between phases ${landmarks.join(', ')}`)
    }
    await screenshot(`boss-${defId}-recovery`)
    if (defId === 'downfall_demon') await page.locator('.dead-target-fixture').evaluate((fixture) => fixture.remove())
    if (defId === bossIds[0]) {
      const moteHints = async () => card.locator('.enemy__portrait').evaluate((portrait) => {
        const style = getComputedStyle(portrait, '::before')
        return { animation: style.animationName, willChange: style.willChange }
      })
      await page.emulateMedia({ reducedMotion: 'reduce' })
      const reduced = await moteHints()
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      const mobile = await page.evaluate(() => {
        document.documentElement.dataset.mobilePerformance = 'true'
        const portrait = document.querySelector('.enemy__portrait')
        const style = getComputedStyle(portrait, '::before')
        const result = { display: style.display, animation: style.animationName, willChange: style.willChange }
        document.documentElement.dataset.mobilePerformance = 'false'
        return result
      })
      check(reduced.animation === 'none' && reduced.willChange === 'auto' &&
        mobile.display !== 'none' && mobile.animation === 'none' && mobile.willChange === 'auto',
      `enemy motes still move between actions ${JSON.stringify({ reduced, mobile })}`)
    }
  }

  const timingBoss = { ...template.enemy, uid: 'timing-boss', defId: 'awakened_one_phase_1', isBoss: true,
    hp: 999, maxHp: 999, dead: false }
  let timingActionIndex = 0
  while (timingActionIndex < 8 && !actionsForEnemy({ ...timingBoss, actionIndex: timingActionIndex }, template.combat.die)
    .some((action) => action.kind === 'attack' || action.kind === 'attackSequence')) timingActionIndex++
  await page.evaluate(({ base, enemy, actionIndex }) => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.combat = structuredClone(base)
    run.combat.combatId = `${run.combat.combatId}-mounted-enemy-snapshot`
    run.combat.enemies = [{ ...enemy, uid: 'mounted-enemy-snapshot', actionIndex }]
    run.combat.phase = 'enemy'
    debug.setRun(run)
  }, { base: template.combat, enemy: timingBoss, actionIndex: timingActionIndex })
  const mountedSnapshotBoss = page.locator('.enemy--boss[data-enemy-id="mounted-enemy-snapshot"]')
  await mountedSnapshotBoss.waitFor()
  await page.waitForFunction(() =>
    document.querySelector('.enemy--boss[data-enemy-id="mounted-enemy-snapshot"]')?.getAttribute('data-animation') === 'idle')
  await page.waitForTimeout(100)
  check(await mountedSnapshotBoss.getAttribute('data-animation') === 'idle',
    'mounting an enemy-phase snapshot replayed the boss attack')
  await setPhase('player')
  await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.phase === 'player')
  await setPhase('enemy')
  await page.waitForFunction(() =>
    document.querySelector('.enemy--boss[data-enemy-id="mounted-enemy-snapshot"]')?.getAttribute('data-animation') === 'attack')
  await page.evaluate(({ base, enemy, actionIndex }) => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.combat = structuredClone(base)
    run.combat.combatId = `${run.combat.combatId}-boss-restore`
    run.combat.enemies = [{ ...enemy, actionIndex }]
    run.combat.phase = 'player'
    debug.setRun(run)
  }, { base: template.combat, enemy: timingBoss, actionIndex: timingActionIndex })
  await page.waitForFunction(() =>
    document.querySelector('.enemy--boss[data-enemy-def="awakened_one_phase_1"]')?.getAttribute('data-animation') === 'idle')
  await setPhase('enemy')
  await page.waitForFunction(() =>
    document.querySelector('.enemy--boss[data-enemy-def="awakened_one_phase_1"]')?.getAttribute('data-animation') === 'attack')
  await page.evaluate(() => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.combat.combatId = `${run.combat.combatId}-restored`
    debug.setRun(run)
  })
  await page.waitForFunction(() =>
    document.querySelector('.enemy--boss[data-enemy-def="awakened_one_phase_1"]')?.getAttribute('data-animation') === 'idle')
  await page.waitForTimeout(100)
  check(await page.locator('.enemy--boss[data-enemy-def="awakened_one_phase_1"]').getAttribute('data-animation') === 'idle',
    'restoring an enemy-phase snapshot replayed the boss attack')
  await page.evaluate(({ base, enemy, actionIndex }) => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.combat = structuredClone(base)
    run.combat.combatId = `${run.combat.combatId}-boss-after-heroes`
    const ironclad = run.combat.players[0]
    const silent = { ...ironclad, id: 'sequence-silent', row: ironclad.row + 1,
      character: 'silent', name: 'Silent' }
    run.combat.players = [ironclad, silent]
    run.combat.enemies = [{ ...enemy, actionIndex }]
    run.combat.phase = 'player'
    run.combat.presentationEvents = []
    debug.setRun(run)
  }, { base: template.combat, enemy: timingBoss, actionIndex: timingActionIndex })
  const sequencingBoss = page.locator('.enemy--boss[data-enemy-def="awakened_one_phase_1"]')
  await page.waitForFunction(() =>
    document.querySelector('.enemy--boss[data-enemy-def="awakened_one_phase_1"]')?.getAttribute('data-animation') === 'idle')
  await page.locator('.seat[data-player-id="sequence-silent"]').waitFor()
  await page.evaluate(() => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    const [ironclad, silent] = run.combat.players
    const target = run.combat.enemies[0]
    run.combat.presentationEvents = [
      { seq: 1_800_001, kind: 'card', actorId: ironclad.id, sourceId: 'strike_ironclad',
        enemyIds: [target.uid], playerIds: [], upgraded: false, copied: false, energy: 1 },
      { seq: 1_800_002, kind: 'card', actorId: silent.id, sourceId: 'predator',
        enemyIds: [target.uid], playerIds: [], upgraded: false, copied: false, energy: 1 },
    ]
    run.combat.phase = 'enemy'
    debug.setRun(run)
  })
  await page.locator('.character-attack--ironclad, .character-attack--silent').first().waitFor()
  await page.waitForTimeout(1_900)
  check(await sequencingBoss.getAttribute('data-animation') === 'idle' &&
    await page.locator('.character-attack').count() > 0 &&
    await page.evaluate(() => window.__STS_DEBUG__.getRun().combat.phase === 'enemy'),
  'boss attack overlapped the concurrent character attacks')
  await page.waitForFunction(() =>
    document.querySelector('.enemy--boss[data-enemy-def="awakened_one_phase_1"]')?.getAttribute('data-animation') === 'attack')
  check(await page.locator('.character-attack').count() === 0,
    'boss attack began before every character attack presentation completed')

  const watcherTimingBoss = { ...timingBoss, uid: 'watcher-timing-boss', defId: 'downfall_wrathful' }
  let watcherTimingActionIndex = 0
  while (watcherTimingActionIndex < 8 && !actionsForEnemy(
    { ...watcherTimingBoss, actionIndex: watcherTimingActionIndex }, template.combat.die,
  ).some((action) => action.kind === 'attack' || action.kind === 'attackSequence')) watcherTimingActionIndex++
  await page.evaluate(({ base, enemy, actionIndex }) => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.combat = structuredClone(base)
    run.combat.enemies = [{ ...enemy, actionIndex }]
    run.combat.phase = 'player'
    for (const player of run.combat.players) Object.assign(player, { hp: 999, maxHp: 999, block: 0, dead: false })
    debug.setRun(run)
  }, { base: template.combat, enemy: watcherTimingBoss, actionIndex: watcherTimingActionIndex })
  await page.locator('.enemy--boss[data-enemy-def="downfall_wrathful"][data-animation="idle"]').waitFor()
  const initialPartyHp = await page.evaluate(() =>
    window.__STS_DEBUG__.getRun().combat.players.reduce((sum, player) => sum + player.hp, 0))
  await page.evaluate(() => { window.__ANIMATION_SFX__ = [] })
  await setPhase('enemy')
  await page.locator('.enemy--boss[data-enemy-def="downfall_wrathful"][data-animation="attack"]').waitFor()
  await page.waitForTimeout(600)
  check(await page.evaluate(() =>
    window.__STS_DEBUG__.getRun().combat.players.reduce((sum, player) => sum + player.hp, 0)) === initialPartyHp,
  'boss damage resolved before the 730ms contact')
  await page.waitForTimeout(250)
  check(await page.evaluate(() =>
    window.__STS_DEBUG__.getRun().combat.players.reduce((sum, player) => sum + player.hp, 0)) < initialPartyHp,
  'boss damage did not resolve at the 730ms contact')
  check(await page.locator('.seat .hit-vfx').count() > 0 && await page.evaluate(() =>
    window.__ANIMATION_SFX__.some((sound) => sound.path === '/assets/sfx/player-hit.ogg')),
  'Wrathful damage, hit reaction, and hurt SFX did not coincide with the 730ms ribbon-sweep contact')

  const guardian = { ...template.enemy, uid: 'guardian-transform', defId: 'guardian_defensive', isBoss: true,
    actionIndex: 1, hp: 999, maxHp: 999, dead: false }
  await page.evaluate(({ base, enemy }) => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.combat = structuredClone(base)
    run.combat.enemies = [enemy]
    run.combat.phase = 'player'
    for (const player of run.combat.players) Object.assign(player, { hp: 999, maxHp: 999, block: 0, dead: false })
    debug.setRun(run)
  }, { base: template.combat, enemy: guardian })
  await page.locator('.enemy--boss[data-enemy-def="guardian_defensive"][data-animation="idle"]').waitFor()
  await setPhase('enemy')
  await page.locator('.enemy--boss[data-enemy-def="guardian_defensive"][data-animation="attack"]').waitFor()
  await page.waitForTimeout(800)
  const guardianTransform = await page.locator('.enemy--boss').evaluate((enemy) => ({
    defId: enemy.getAttribute('data-enemy-def'),
    animation: enemy.getAttribute('data-animation'),
    art: enemy.querySelector('.enemy__art--cutout')?.getAttribute('src'),
  }))
  check(guardianTransform.defId === 'guardian_attack' && guardianTransform.animation === 'attack' &&
    guardianTransform.art?.endsWith('/guardian_defensive-attack.webp'),
  `guardian: transform cut off the defensive attack latch ${JSON.stringify(guardianTransform)}`)

  const heroCases = [
    { character: 'ironclad', sourceId: 'strike_ironclad', duration: '1.8s', contact: 630, samples: [270, 900, 1500] },
    { character: 'defect', sourceId: 'strike_defect', duration: '1.65s', contact: 1110, samples: [270, 825, 1375] },
    { character: 'watcher', sourceId: 'strike_watcher', duration: '1.65s', contact: 1050, samples: [270, 825, 1375] },
    { character: 'silent', sourceId: 'predator', duration: '2.04s', contact: 1025, samples: [170, 1025, 2039] },
    { character: 'guardian', sourceId: 'guardian_strike', duration: '1.65s', contact: 630, samples: [270, 825, 1375] },
    { character: 'hermit', sourceId: 'hermit_strike', duration: '1.65s', contact: 630, samples: [270, 825, 1375] },
    { character: 'slime_boss', sourceId: 'slime_boss_strike', duration: '1.7s', contact: 850, samples: [270, 850, 1375] },
    { character: 'hexaghost', sourceId: 'strike_hexaghost', duration: '2s', contact: 1450,
      samples: [270, 1000, 1725, 2100] },
  ]
  for (const [heroIndex, hero] of heroCases.entries()) {
    const ids = await page.evaluate(({ base, enemy, character, sourceId, heroIndex }) => {
      const debug = window.__STS_DEBUG__
      const run = structuredClone(debug.getRun())
      run.combat = structuredClone(base)
      run.combat.phase = 'player'
      const enemyIds = character === 'watcher'
        ? ['animation-target-1', 'animation-target-2', 'animation-target-3', 'animation-target-4']
        : character === 'silent'
        ? ['animation-target-1', 'animation-target-2', 'animation-target-3']
        : ['animation-target']
      run.combat.enemies = enemyIds.map((uid, row) => ({
        ...enemy, uid, row, defId: 'cultist', isBoss: false, hp: 999, maxHp: 999, dead: false,
      }))
      const actor = run.combat.players[0]
      Object.assign(actor, {
        character, name: character, hp: 999, maxHp: 999, dead: false,
        stance: character === 'watcher' ? 'wrath' : actor.stance,
      })
      const seq = 1_000_001 + heroIndex * 10
      const attack = {
        seq, kind: 'card', actorId: actor.id, sourceId, enemyIds, playerIds: [],
        upgraded: false, copied: false, energy: 1,
      }
      run.combat.presentationEvents = character === 'silent'
        ? [attack, { ...attack, seq: seq + 1, enemyIds: [enemyIds[0]], copied: true }]
        : [attack]
      debug.setRun(run)
      return { actorId: actor.id, seq: character === 'silent' ? seq + 1 : seq, targetId: enemyIds[0] }
    }, { base: template.combat, enemy: template.enemy, heroIndex, ...hero })
    const seat = page.locator(`.seat[data-player-id="${ids.actorId}"]`)
    const currentAttack = seat.locator(`.character-attack--${hero.character}[data-attack-seq="${ids.seq}"]`)
    await currentAttack.waitFor()
    if (hero.character === 'hexaghost') {
      await seat.locator('.character-attack__pose--hexaghost-state.is-loaded').waitFor()
    }
    const body = seat.locator('.seat__portrait > img')
    check(await body.evaluate((image, duration) => getComputedStyle(image).animationDuration === duration, hero.duration),
      `${hero.character}: wrong body duration`)
    if (hero.character === 'silent') {
      const daggers = await seat.locator('.character-attack__dagger').evaluateAll((elements) =>
        elements.map((element) => {
          const style = getComputedStyle(element)
          const frames = element.getAnimations()[0]?.effect?.getKeyframes() ?? []
          return {
            animation: style.animationName,
            duration: Number.parseFloat(style.animationDuration) * 1000,
            delay: Number.parseFloat(style.animationDelay) * 1000,
            roundTrip: frames.length > 1 && frames[0].transform === frames.at(-1).transform,
          }
        }))
      check(daggers.length === 4 && daggers.every((dagger) =>
        dagger.animation === 'attack-dagger-round-trip' && dagger.duration === 1750 && dagger.roundTrip),
      `silent: daggers are not 1.75s round trips ${JSON.stringify(daggers)}`)
      const returnMs = Math.max(...daggers.map(({ delay, duration }) => delay + duration))
      const sampleSilentBody = async (time) => {
        await seat.evaluate((element, currentTime) => {
          for (const layer of [
            element.querySelector('.seat__portrait > img'),
            element.querySelector('.character-attack__pose--silent-throw'),
          ]) {
            const animation = layer.getAnimations()[0]
            if (animation) {
              animation.pause()
              animation.currentTime = currentTime
            }
          }
        }, time)
        await page.evaluate(() => new Promise(requestAnimationFrame))
        return seat.evaluate((element) => {
          const idle = element.querySelector('.seat__portrait > img')
          return {
            idle: Number(getComputedStyle(idle).opacity),
            pose: Number(getComputedStyle(element.querySelector('.character-attack__pose--silent-throw')).opacity),
          }
        })
      }
      const handoff = {
        beforeReturn: await sampleSilentBody(returnMs - 1),
        afterReturn: await sampleSilentBody(returnMs),
      }
      check(handoff.beforeReturn.pose > 0.99 && handoff.beforeReturn.idle === 0 &&
        handoff.afterReturn.pose === 0 && handoff.afterReturn.idle > 0.99,
      `silent: body did not hand off from throw pose after dagger return ${JSON.stringify(handoff)}`)
      await screenshot(`hero-silent-3-${returnMs}ms`)
    }
    if (hero.character === 'watcher') {
      const impact = currentAttack.locator('.character-attack__meteor-impact').first()
      const genericImpact = page.locator(
        `.enemy[data-enemy-id="${ids.targetId}"] .combat-vfx--attack-impact[data-vfx-seq="${ids.seq}"]`,
      )
      await genericImpact.waitFor()
      const genericTiming = await genericImpact.evaluate((element) => {
        const style = getComputedStyle(element)
        const firstFrame = element.getAnimations()[0]?.effect?.getKeyframes()[0]
        return { delay: style.animationDelay, firstOpacity: firstFrame?.opacity }
      })
      check(genericTiming.delay === '1.05s' && genericTiming.firstOpacity === '0',
        `watcher: generic impact begins before contact ${JSON.stringify(genericTiming)}`)
      const impactOpacityAt = (time) => impact.evaluate((element, currentTime) => {
        const animation = element.getAnimations()[0]
        if (animation) {
          animation.currentTime = currentTime
          animation.pause()
        }
        return Number(getComputedStyle(element).opacity)
      }, time)
      check(await impactOpacityAt(1_049) === 0, 'watcher: meteor impact is visible before ground contact')
      check(await impactOpacityAt(1050) >= 0.9, 'watcher: meteor impact is missing at ground contact')
    }
    if (hero.character === 'hexaghost') {
      const flame = currentAttack.locator('.character-attack__hexaghost-flame').first()
      const flight = await flame.evaluate((element) => {
        const style = getComputedStyle(element)
        const frames = element.getAnimations()[0]?.effect?.getKeyframes() ?? []
        return {
          duration: style.animationDuration,
          delay: style.animationDelay,
          oneWay: frames.length > 1 && frames[0].transform !== frames.at(-1).transform,
          loaded: element.querySelector('img')?.complete && element.querySelector('img')?.naturalWidth > 0,
        }
      })
      const impact = page.locator(
        `.enemy[data-enemy-id="${ids.targetId}"] .combat-vfx--attack-impact[data-vfx-seq="${ids.seq}"]`,
      )
      const impactTiming = await impact.evaluate((element) => ({
        delay: getComputedStyle(element).animationDelay,
        asset: element.dataset.vfxAsset,
      }))
      check(flight.duration === '0.9s' && flight.delay === '0.55s' && flight.oneWay && flight.loaded,
        `hexaghost: green flame is not a loaded 0.9s one-way flight ${JSON.stringify(flight)}`)
      check(impactTiming.delay === '1.45s' && impactTiming.asset === 'hexaghost-flame-impact',
        `hexaghost: impact VFX missed flame contact ${JSON.stringify(impactTiming)}`)
    }
    for (const [index, time] of hero.samples.entries()) {
      await seat.evaluate((element, currentTime) => {
        for (const animation of element.getAnimations({ subtree: true })) {
          const name = animation.animationName ?? ''
          if (animation.effect?.getTiming().iterations === 1 || name.startsWith('attack-') ||
            name.startsWith('watcher-') || name.endsWith('-pose') ||
            name === 'defect-core-charge') {
            animation.pause()
            animation.currentTime = currentTime
          }
        }
      }, time)
      await page.evaluate(() => new Promise(requestAnimationFrame))
      const visibleBodies = await seat.evaluate((element) => {
        const idle = Number(getComputedStyle(element.querySelector('.seat__portrait > img')).opacity) > 0.01 ? 1 : 0
        const poses = [...element.querySelectorAll('.character-attack__pose')]
          .filter((pose) => Number(getComputedStyle(pose).opacity) > 0.01).length
        return idle + poses
      })
      check(visibleBodies === 1, `${hero.character}: ${visibleBodies} bodies visible at ${time}ms`)
      await screenshot(`hero-${hero.character}-${index}-${time}ms`)
    }
    await currentAttack.waitFor({ state: 'detached' })
    if (hero.character === 'silent') await seat.locator('.character-attack--silent').waitFor({ state: 'detached' })
    const cue = `card:${hero.character}:${hero.sourceId}:base`
    const sounds = await page.evaluate((expected) =>
      window.__ANIMATION_SFX__.filter((sound) => sound.cue === expected), cue)
    const impactPaths = new Set(['/assets/sfx/attack.ogg', '/assets/sfx/enemy-hit.ogg',
      '/assets/sfx/block.ogg', '/assets/sfx/weak.ogg'])
    check(sounds.some((sound) => impactPaths.has(sound.path) && sound.delayMs === hero.contact),
      `${hero.character}: impact SFX missed ${hero.contact}ms contact ${JSON.stringify(sounds)}`)
    check(sounds.some((sound) => sound.delayMs < hero.contact),
      `${hero.character}: attack has no launch/accent SFX before contact ${JSON.stringify(sounds)}`)
    if (hero.character === 'watcher' && browserName === 'chromium') {
      const cdp = await page.context().newCDPSession(page)
      let compositorLayers = []
      cdp.on('LayerTree.layerTreeDidChange', ({ layers }) => { compositorLayers = layers })
      await cdp.send('LayerTree.enable')
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1440, height: 900, deviceScaleFactor: 2, mobile: false,
      })
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
      const stressSeq = await page.evaluate((seq) => {
        const debug = window.__STS_DEBUG__
        const run = structuredClone(debug.getRun())
        const actor = run.combat.players[0]
        const enemyIds = run.combat.enemies.map((enemy) => enemy.uid)
        run.combat.presentationEvents = [{
          seq, kind: 'card', actorId: actor.id, sourceId: 'strike_watcher', enemyIds,
          playerIds: [], upgraded: false, copied: false, energy: 1,
        }]
        debug.setRun(run)
        return seq
      }, ids.seq + 0.5)
      await seat.locator(`.character-attack--watcher[data-attack-seq="${stressSeq}"]`).waitFor()
      await page.evaluate(() => new Promise(requestAnimationFrame))
      const documentNode = await cdp.send('DOM.getDocument')
      const compositorProbe = {}
      for (const [name, selector] of Object.entries({
        body: `.seat[data-player-id="${ids.actorId}"] .seat__portrait > img`,
        pose: `.seat[data-player-id="${ids.actorId}"] .character-attack__pose--watcher-cast`,
        meteor: `.seat[data-player-id="${ids.actorId}"] .character-attack__meteor`,
        impact: `.seat[data-player-id="${ids.actorId}"] .character-attack__meteor-impact`,
      })) {
        const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: documentNode.root.nodeId, selector })
        const { node } = await cdp.send('DOM.describeNode', { nodeId })
        const layer = compositorLayers.find((candidate) => candidate.backendNodeId === node.backendNodeId)
        compositorProbe[name] = layer
          ? (await cdp.send('LayerTree.compositingReasons', { layerId: layer.layerId })).compositingReasons
          : []
      }
      check(Object.values(compositorProbe).every((reasons) => reasons.some((reason) => reason.includes('will-change'))),
        `watcher: active attack layers were not promoted by Chrome ${JSON.stringify(compositorProbe)}`)
      await page.evaluate(() => {
        window.__WATCHER_FRAME_PROFILE__ = new Promise((resolve) => {
          const frameGaps = []
          const longTasks = []
          let startedAt
          let previous
          const observer = new PerformanceObserver((entries) => {
            for (const entry of entries.getEntries()) longTasks.push(entry.duration)
          })
          observer.observe({ type: 'longtask' })
          const sample = (now) => {
            startedAt ??= now
            if (previous !== undefined) frameGaps.push(now - previous)
            previous = now
            if (now - startedAt < 1_650) requestAnimationFrame(sample)
            else {
              observer.disconnect()
              frameGaps.sort((a, b) => a - b)
              resolve({
                frames: frameGaps.length,
                maxGap: frameGaps.at(-1) ?? 0,
                p95Gap: frameGaps[Math.floor(frameGaps.length * 0.95)] ?? 0,
                longTasks,
              })
            }
          }
          requestAnimationFrame(sample)
        })
      })
      const frameProfile = await page.evaluate(() => window.__WATCHER_FRAME_PROFILE__)
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
      await cdp.send('Emulation.clearDeviceMetricsOverride')
      await cdp.send('LayerTree.disable')
      console.log(`Watcher frame profile: ${JSON.stringify(frameProfile)}`)
      await seat.locator(`.character-attack--watcher[data-attack-seq="${stressSeq}"]`).waitFor({ state: 'detached' })
    }
  }

  await page.evaluate(() => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    const actor = run.combat.players[0]
    const target = run.combat.enemies[0]
    const history = run.combat.presentationEvents ?? []
    const seq = history.reduce((latest, event) => Math.max(latest, event.seq), 1_030_000) + 1
    Object.assign(actor, { character: 'silent', hp: 999, maxHp: 999, dead: false })
    Object.assign(target, { hp: 999, maxHp: 999, dead: false })
    run.combat.presentationEvents = [...history, {
      seq, kind: 'card', actorId: actor.id, sourceId: 'predator', enemyIds: [target.uid],
      playerIds: [], upgraded: false, copied: false, energy: 1,
    }].slice(-12)
    window.__ANIMATION_SFX__ = []
    debug.setRun(run)
  })
  await page.waitForTimeout(1_100)
  const impactsBeforeLateToggle = await page.evaluate(() => window.__ANIMATION_SFX__.filter((sound) =>
    sound.path === '/assets/sfx/attack.ogg').length)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.waitForFunction(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
  await page.waitForTimeout(50)
  check(await page.evaluate(() => window.__ANIMATION_SFX__.filter((sound) =>
    sound.path === '/assets/sfx/attack.ogg').length) === impactsBeforeLateToggle,
  'enabling reduced motion after contact replayed the impact SFX')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.waitForFunction(() => !matchMedia('(prefers-reduced-motion: reduce)').matches)
  await page.waitForTimeout(50)

  await page.evaluate(() => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    const actor = run.combat.players[0]
    const target = run.combat.enemies[0]
    const history = run.combat.presentationEvents ?? []
    const seq = history.reduce((latest, event) => Math.max(latest, event.seq), 1_040_000) + 1
    Object.assign(actor, { character: 'silent', hp: 999, maxHp: 999, dead: false })
    Object.assign(target, { hp: 999, maxHp: 999, dead: false })
    run.combat.presentationEvents = [...history, {
      seq, kind: 'card', actorId: actor.id, sourceId: 'predator', enemyIds: [target.uid],
      playerIds: [], upgraded: false, copied: false, energy: 1,
    }].slice(-12)
    window.__ANIMATION_SFX__ = []
    debug.setRun(run)
  })
  await page.waitForFunction(() => window.__ANIMATION_SFX__.some((sound) =>
    sound.cue === 'card:silent:predator:base'))
  check(!await page.evaluate(() => window.__ANIMATION_SFX__.some((sound) =>
    sound.path === '/assets/sfx/attack.ogg' && sound.delayMs === 1_025)),
  'Silent impact SFX played before its normal-motion contact')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.waitForFunction(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
  await page.waitForTimeout(50)
  check(await page.evaluate(() => window.__ANIMATION_SFX__.some((sound) =>
    sound.path === '/assets/sfx/attack.ogg' && sound.delayMs === 0)),
  'enabling reduced motion did not move the pending impact SFX to immediate contact')
  await page.waitForTimeout(1_050)
  check(!await page.evaluate(() => window.__ANIMATION_SFX__.some((sound) =>
    sound.path === '/assets/sfx/attack.ogg' && sound.delayMs === 1_025)),
  'enabling reduced motion left the old delayed impact SFX queued')
  await page.evaluate(() => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    const actor = run.combat.players[0]
    const target = run.combat.enemies[0]
    const history = run.combat.presentationEvents ?? []
    const seq = history.reduce((latest, event) => Math.max(latest, event.seq), 1_050_000) + 1
    Object.assign(actor, { character: 'silent', hp: 999, maxHp: 999, dead: false })
    Object.assign(target, { hp: 999, maxHp: 999, dead: false })
    run.combat.presentationEvents = [...history, {
      seq, kind: 'card', actorId: actor.id, sourceId: 'predator', enemyIds: [target.uid],
      playerIds: [], upgraded: false, copied: false, energy: 1,
    }].slice(-12)
    window.__ANIMATION_SFX__ = []
    debug.setRun(run)
  })
  await page.waitForFunction(() => window.__ANIMATION_SFX__.some((sound) =>
    sound.cue === 'card:silent:predator:base'))
  await page.waitForTimeout(50)
  const reducedMotionSounds = await page.evaluate(() => window.__ANIMATION_SFX__.filter((sound) =>
    sound.cue === 'card:silent:predator:base'))
  check(reducedMotionSounds.some((sound) => sound.path === '/assets/sfx/attack.ogg' && sound.delayMs === 0),
    `reduced motion delayed Silent impact SFX ${JSON.stringify(reducedMotionSounds)}`)
  check(await page.locator('.character-attack').count() === 0, 'reduced motion still rendered a character attack')
  await page.evaluate(() => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.combat.phase = 'won'
    window.__REDUCED_WIN_START__ = performance.now()
    window.__ANIMATION_SFX__ = []
    debug.setRun(run)
  })
  await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase !== 'combat')
  const reducedOutcome = await page.evaluate(() => ({
    elapsed: performance.now() - window.__REDUCED_WIN_START__,
    victorySounds: window.__ANIMATION_SFX__.filter((sound) => sound.path === '/assets/sfx/victory.ogg').length,
  }))
  check(reducedOutcome.elapsed < 500 && reducedOutcome.victorySounds === 1,
    `OS reduced motion delayed the victory outcome ${JSON.stringify(reducedOutcome)}`)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.waitForFunction(() => !matchMedia('(prefers-reduced-motion: reduce)').matches)

  await page.evaluate(({ base, enemy }) => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.phase = 'combat'
    run.combat = structuredClone(base)
    run.combat.phase = 'player'
    run.combat.enemies = [{ ...enemy, uid: 'targetless-enemy', hp: 0, dead: true }]
    run.combat.pendingSummons = [{
      sourceUid: 'targetless-enemy', row: 0, defIds: ['acid_slime'], turn: run.combat.turn,
      direct: true, timing: 'endOfTurn',
    }]
    Object.assign(run.combat.players[0], {
      character: 'watcher', stance: 'wrath', hp: 999, maxHp: 999,
      powers: [{ uid: 'targetless-omega', defId: 'omega', upgraded: false }],
    })
    debug.setRun(run)
  }, { base: template.combat, enemy: template.enemy })
  await page.locator('.seat__portrait > img').waitFor()
  const performanceModeHints = await page.evaluate(() => {
    const read = () => [
      document.querySelector('.seat__portrait > img'),
      document.querySelector('.enemy__portrait > .enemy__art--cutout'),
      document.querySelector('.stance-aura'),
    ].filter(Boolean).map((element) => getComputedStyle(element).willChange)
    document.documentElement.dataset.mobilePerformance = 'true'
    const mobile = read()
    document.documentElement.dataset.mobilePerformance = 'false'
    return { mobile }
  })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  performanceModeHints.reduced = await page.evaluate(() => [
    document.querySelector('.seat__portrait > img'),
    document.querySelector('.enemy__portrait > .enemy__art--cutout'),
    document.querySelector('.stance-aura'),
  ].filter(Boolean).map((element) => getComputedStyle(element).willChange))
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  check(performanceModeHints.mobile[0] === 'auto' &&
    performanceModeHints.reduced.every((hint) => hint === 'auto'),
  `idle phone or desktop reduced-motion layers stayed promoted ${JSON.stringify(performanceModeHints)}`)
  await page.getByRole('button', { name: /^End turn/ }).click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.phase === 'enemy')
  check(await page.locator('.end-turn-effect').count() === 0, 'targetless Omega rendered an unresolved target source')
  check(await page.locator('.combat-error').count() === 0, 'targetless Omega was rejected by the local end-turn UI')

  await page.evaluate(({ base, enemy, actionIndex }) => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.combat = structuredClone(base)
    run.combat.enemies = [{ ...enemy, actionIndex }]
    run.combat.phase = 'player'
    debug.setRun(run)
  }, { base: template.combat, enemy: timingBoss, actionIndex: timingActionIndex })
  await page.locator('.enemy--boss[data-enemy-def="awakened_one_phase_1"][data-animation="idle"]').waitFor()
  await setPhase('enemy')
  await page.locator('.enemy--boss[data-enemy-def="awakened_one_phase_1"][data-animation="attack"]').waitFor()
  await page.evaluate(() => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.combat.combatId = `${run.combat.combatId}-restored`
    run.combat.phase = 'player'
    debug.setRun(run)
  })
  await page.waitForFunction(() =>
    document.querySelector('.enemy--boss[data-enemy-def="awakened_one_phase_1"]')?.getAttribute('data-animation') === 'idle',
  undefined, { timeout: 250 })

  await page.evaluate(() => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    const actor = run.combat.players[0]
    const target = run.combat.enemies[0]
    const history = run.combat.presentationEvents ?? []
    const seq = history.reduce((latest, event) => Math.max(latest, event.seq), 1_100_000) + 1
    run.phase = 'combat'
    run.combat.phase = 'won'
    Object.assign(target, { hp: 0, dead: true })
    Object.assign(actor, { character: 'watcher', hp: 999, maxHp: 999, dead: false })
    run.combat.presentationEvents = [...history, {
      seq, kind: 'card', actorId: actor.id, sourceId: 'strike_watcher',
      enemyIds: [target.uid], playerIds: [], upgraded: false, copied: false, energy: 1,
    }].slice(-12)
    window.__ANIMATION_SFX__ = []
    debug.setRun(run)
  })
  await page.locator('.character-attack--watcher').waitFor()
  await page.waitForTimeout(1_200)
  const preImpactOutcome = await page.evaluate(() => ({
    runPhase: window.__STS_DEBUG__.getRun().phase,
    impactOpacity: Number(getComputedStyle(document.querySelector('.character-attack__meteor-impact')).opacity),
    victorySounds: window.__ANIMATION_SFX__.filter((sound) => sound.path === '/assets/sfx/victory.ogg').length,
  }))
  check(preImpactOutcome.runPhase === 'combat' && preImpactOutcome.impactOpacity > 0,
    `victory replaced the final meteor before impact ${JSON.stringify(preImpactOutcome)}`)
  check(preImpactOutcome.victorySounds === 0, 'victory SFX played over the falling meteor')
  await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase !== 'combat', undefined, { timeout: 4_000 })
  check(await page.evaluate(() =>
    window.__ANIMATION_SFX__.some((sound) => sound.path === '/assets/sfx/victory.ogg')),
  'victory SFX did not land with the post-animation outcome')

  phoneContext = await browser.newContext({
    ...devices['iPhone 13 landscape'],
    reducedMotion: 'reduce',
  })
  await phoneContext.addInitScript(() => {
    window.__ANIMATION_SFX__ = []
    HTMLMediaElement.prototype.play = function play() {
      window.__ANIMATION_SFX__.push({
        path: new URL(this.src).pathname,
        cue: this.dataset.combatSfx ?? null,
        delayMs: Number(this.dataset.combatSfxDelay ?? 0),
      })
      return Promise.resolve()
    }
  })
  const phone = await phoneContext.newPage()
  phone.setDefaultTimeout(30_000)
  const tapPhone = async (locator) => {
    if (browserName !== 'webkit') return locator.tap()
    await locator.scrollIntoViewIfNeeded()
    const box = await locator.boundingBox()
    if (!box) throw new Error('WebKit could not locate the phone touch target')
    const viewport = await phone.evaluate(() => ({
      left: visualViewport.offsetLeft, top: visualViewport.offsetTop, scale: visualViewport.scale,
    }))
    await phone.touchscreen.tap(
      (box.x + box.width / 2 - viewport.left) * viewport.scale,
      (box.y + box.height / 2 - viewport.top) * viewport.scale,
    )
  }
  await phone.goto(`http://localhost:${address.port}`, { waitUntil: 'networkidle' })
  check(await phone.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches &&
    document.documentElement.dataset.mobilePerformance === 'true'),
  'iPhone regression fixture did not reproduce OS Reduce Motion in mobile performance mode')
  check(await phone.locator('link[rel="preload"][as="image"][href*="/combat/characters/"]').count() === 7,
  'iPhone 13 did not preload all attack pose assets')
  await phone.getByRole('button', { name: 'Single Player', exact: true }).click()
  await phone.getByRole('button', { name: 'Standard', exact: true }).click()
  await phone.getByRole('button', { name: 'Embark' }).click()
  await phone.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'neow')
  await phone.evaluate(() => window.__STS_DEBUG__.reset(1, 'boss-gallery'))
  await phone.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'neow')
  await phone.evaluate((combat) => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    debug.setRun({
      ...run,
      phase: 'combat',
      neow: null,
      combat: structuredClone(combat),
    })
  }, template.combat)
  await phone.locator('.combat').waitFor()
  const phoneFixture = template.combat
  await phone.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const phoneCombatLayout = await phone.locator('.combat').evaluate((combat) => {
    const box = (selector) => combat.querySelector(selector).getBoundingClientRect().toJSON()
    const visualBottom = visualViewport.offsetTop + visualViewport.height
    return {
      board: box('.board'),
      hand: box('.hand-area'),
      scrollHeight: document.documentElement.scrollHeight,
      visualBottom,
      rootBottom: document.querySelector('#root').getBoundingClientRect().bottom,
      clippedCards: [...combat.querySelectorAll('.hand .card')]
        .filter((card) => card.getBoundingClientRect().bottom > visualBottom + 1).length,
      dynamicViewportRule: [...document.styleSheets].some((sheet) => [...sheet.cssRules].some((rule) =>
        rule instanceof CSSStyleRule && rule.selectorText?.includes('#root') && rule.style.height === '100dvh')),
      targetTouchAction: getComputedStyle(combat.querySelector('.enemy')).touchAction,
      cardTouchAction: getComputedStyle(combat.querySelector('.hand .card')).touchAction,
    }
  })
  check(phoneCombatLayout.targetTouchAction === 'manipulation' &&
    phoneCombatLayout.cardTouchAction === 'none',
  `iPhone target taps are delayed or card dragging lost its touch policy ${JSON.stringify(phoneCombatLayout)}`)
  check(phoneCombatLayout.dynamicViewportRule &&
    phoneCombatLayout.rootBottom <= phoneCombatLayout.visualBottom + 1 &&
    phoneCombatLayout.clippedCards === 0,
  `iPhone Safari chrome clips the hand below its visual viewport ${JSON.stringify(phoneCombatLayout)}`)
  await phone.evaluate(() => {
    window.__TARGET_TAP_DELAY__ = null
    const target = document.querySelector('.enemy')
    let touchEndedAt = 0
    target.addEventListener('touchend', () => { touchEndedAt = performance.now() }, { once: true })
    target.addEventListener('click', () => {
      window.__TARGET_TAP_DELAY__ = performance.now() - touchEndedAt
    }, { once: true })
  })
  await tapPhone(phone.locator('.enemy').first())
  await phone.waitForFunction(() => window.__TARGET_TAP_DELAY__ !== null)
  const targetTapDelay = await phone.evaluate(() => window.__TARGET_TAP_DELAY__)
  check(targetTapDelay < 150, `iPhone delayed target click by ${targetTapDelay}ms after touchend`)
  await phone.evaluate(() => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.combat.phase = 'won'
    debug.setRun(run)
  })
  await phone.locator('.combat__result--won').waitFor()
  await phone.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const phoneVictoryLayout = await phone.locator('.combat').evaluate((combat) => {
    const box = (selector) => combat.querySelector(selector).getBoundingClientRect().toJSON()
    const result = combat.querySelector('.combat__result')
    return {
      board: box('.board'),
      hand: box('.hand-area'),
      scrollHeight: document.documentElement.scrollHeight,
      resultPosition: getComputedStyle(result).position,
      resultPointerEvents: getComputedStyle(result).pointerEvents,
    }
  })
  check(phoneVictoryLayout.resultPosition === 'absolute' && phoneVictoryLayout.resultPointerEvents === 'none' &&
    ['top', 'bottom', 'height'].every((key) =>
      Math.abs(phoneVictoryLayout.board[key] - phoneCombatLayout.board[key]) <= 1 &&
      Math.abs(phoneVictoryLayout.hand[key] - phoneCombatLayout.hand[key]) <= 1) &&
    Math.abs(phoneVictoryLayout.scrollHeight - phoneCombatLayout.scrollHeight) <= 1,
  `Victory banner shifted the iPhone combat layout ${JSON.stringify({ phoneCombatLayout, phoneVictoryLayout })}`)
  await phone.locator('.combat').screenshot({ path: join(output, `iphone-13-${browserName}-victory-overlay.png`) })
  await phone.evaluate((combat) => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.combat = structuredClone(combat)
    debug.setRun(run)
  }, phoneFixture)
  let phoneHexPreloadRequests = 0
  await phone.route('**/hexaghost-heat-*-attack.webp', async (route) => {
    phoneHexPreloadRequests += 1
    if (route.request().url().includes('hexaghost-heat-0-attack')) {
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    await route.continue()
  })
  const phoneHeroes = [
    { character: 'ironclad', sourceId: 'strike_ironclad', contact: 630, poses: ['ironclad-ready', 'ironclad-impact'] },
    { character: 'defect', sourceId: 'strike_defect', contact: 1110, poses: ['defect-charge', 'defect-release'] },
    { character: 'silent', sourceId: 'predator', contact: 1025, poses: ['silent-throw'] },
    { character: 'watcher', sourceId: 'strike_watcher', contact: 1050, poses: ['watcher-charge', 'watcher-cast'] },
    { character: 'guardian', sourceId: 'guardian_strike', contact: 630,
      bodyAnimation: 'attack-downfall', poses: ['downfall-ready', 'downfall-impact'] },
    { character: 'hermit', sourceId: 'hermit_strike', contact: 630,
      bodyAnimation: 'attack-downfall', poses: ['downfall-ready', 'downfall-impact'] },
    { character: 'slime_boss', sourceId: 'slime_boss_strike', contact: 850,
      bodyAnimation: 'attack-slime-boss-idle', poses: ['downfall-ready', 'downfall-impact'] },
    { character: 'hexaghost', sourceId: 'strike_hexaghost', contact: 1450,
      bodyAnimation: 'attack-downfall-hexaghost', poses: ['hexaghost-state'] },
  ]
  for (const [index, hero] of phoneHeroes.entries()) {
    await phone.evaluate(({ base, hero, index }) => {
      const debug = window.__STS_DEBUG__
      const run = structuredClone(debug.getRun())
      run.combat = structuredClone(base)
      run.combat.combatId = `${run.combat.combatId}-iphone-${hero.character}-${index}`
      run.combat.phase = 'player'
      run.combat.presentationEvents = []
      run.combat.players = [run.combat.players[0]]
      Object.assign(run.combat.players[0], { character: hero.character, hp: 999, maxHp: 999, dead: false,
        stance: hero.character === 'watcher' ? 'wrath' : run.combat.players[0].stance })
      run.combat.enemies = [{ ...run.combat.enemies[0], uid: 'iphone-target', defId: 'cultist', isBoss: false,
        hp: 999, maxHp: 999, dead: false }]
      debug.setRun(run)
    }, { base: phoneFixture, hero, index })
    await phone.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    if (hero.character === 'hexaghost') {
      check(phoneHexPreloadRequests > 0 && await phone.locator('.character-attack--hexaghost').count() === 0,
        'iPhone did not begin preloading Hexaghost attacks during idle')
    }
    await phone.evaluate(({ hero, index }) => {
      const debug = window.__STS_DEBUG__
      const run = structuredClone(debug.getRun())
      const actor = run.combat.players[0]
      const target = run.combat.enemies[0]
      target.hp -= 1
      run.combat.presentationEvents = [{
        seq: 2_000_001 + index, kind: 'card', actorId: actor.id, sourceId: hero.sourceId,
        enemyIds: [target.uid], playerIds: [], upgraded: false, copied: false, energy: 1,
      }]
      window.__ANIMATION_SFX__ = []
      debug.setRun(run)
    }, { hero, index })
    const attack = phone.locator(`.character-attack--${hero.character}`)
    await attack.waitFor()
    if (hero.character === 'hexaghost') {
      await phone.locator('.character-attack__pose--hexaghost-state.is-loaded').waitFor()
    }
    await phone.locator('.enemy .hit-vfx').waitFor()
    const iphoneAttack = await phone.evaluate(({ hero }) => {
      const seat = document.querySelector(`.seat--attack-${hero.character}`)
      const body = seat?.querySelector('.seat__portrait > img')
      const attack = seat?.querySelector(`.character-attack--${hero.character}`)
      const target = document.querySelector('.enemy__portrait')
      const hit = target?.querySelector('.hit-vfx')
      const targetVfx = target?.querySelector('.combat-vfx--attack-impact')
      const poseRoot = hero.character === 'hexaghost' ? seat : attack
      const poses = hero.poses.map((pose) => poseRoot?.querySelector(`.character-attack__pose--${pose}`))
      const targetVfxStyle = targetVfx ? getComputedStyle(targetVfx) : null
      return {
        viewport: `${innerWidth}x${innerHeight}@${devicePixelRatio}`,
        mobilePerformance: document.documentElement.dataset.mobilePerformance,
        osReducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
        gameReducedMotion: document.documentElement.dataset.reducedMotion,
        bodyAnimation: body ? getComputedStyle(body).animationName : '',
        attackVisible: Boolean(attack && getComputedStyle(attack).display !== 'none'),
        poseAssets: poses.map((pose) => ({
          display: pose ? getComputedStyle(pose).display : 'none',
          animation: pose ? getComputedStyle(pose).animationName : 'none',
          loaded: pose?.querySelector('img')?.complete && (pose.querySelector('img')?.naturalWidth ?? 0) > 0,
          fallback: pose?.classList.contains('is-fallback') ?? false,
          src: pose?.querySelector('img')?.getAttribute('src') ?? '',
        })),
        speedTrail: attack && hero.character === 'ironclad'
          ? { animation: getComputedStyle(attack, '::before').animationName,
              filter: getComputedStyle(attack, '::before').filter }
          : null,
        meteorCount: attack?.querySelectorAll('.character-attack__meteor').length ?? 0,
        projectileCount: attack?.querySelectorAll(
          '.character-attack__dagger, .character-attack__bolt, .character-attack__hexaghost-flame',
        ).length ?? 0,
        hitDelay: Number.parseFloat(hit ? getComputedStyle(hit).getPropertyValue('--hit-delay') : '0'),
        hitAnimation: hit ? getComputedStyle(hit).animationName : 'none',
        portraitAnimations: target?.getAnimations().length ?? 0,
        targetVfx: {
          display: targetVfxStyle?.display ?? 'none',
          image: targetVfxStyle?.backgroundImage ?? 'none',
          blend: targetVfxStyle?.mixBlendMode ?? 'normal',
          animation: targetVfxStyle?.animationName ?? 'none',
          beforeDisplay: targetVfx ? getComputedStyle(targetVfx, '::before').display : 'none',
          beforeAnimation: targetVfx ? getComputedStyle(targetVfx, '::before').animationName : 'none',
          afterDisplay: targetVfx ? getComputedStyle(targetVfx, '::after').display : 'none',
          afterAnimation: targetVfx ? getComputedStyle(targetVfx, '::after').animationName : 'none',
        },
      }
    }, { hero })
    check(iphoneAttack.mobilePerformance === 'true',
      `iPhone 13 did not enable its performance profile ${JSON.stringify(iphoneAttack)}`)
    check(iphoneAttack.osReducedMotion && iphoneAttack.gameReducedMotion === 'false' &&
      iphoneAttack.bodyAnimation === (hero.bodyAnimation ?? `attack-${hero.character}`) && iphoneAttack.attackVisible &&
      iphoneAttack.poseAssets.every((pose) => pose.display !== 'none' && pose.animation !== 'none' && pose.loaded) &&
      (hero.character !== 'watcher' || iphoneAttack.meteorCount === 1),
    `iPhone 13 OS Reduce Motion skipped ${hero.character} attack frames ${JSON.stringify(iphoneAttack)}`)
    check(!iphoneAttack.speedTrail || iphoneAttack.speedTrail.animation === 'attack-speed-trail' &&
      iphoneAttack.speedTrail.filter !== 'none',
    `iPhone 13 lost Ironclad's PC speed trail ${JSON.stringify(iphoneAttack)}`)
    check(['silent', 'defect', 'hexaghost'].includes(hero.character) === (iphoneAttack.projectileCount > 0),
      `iPhone 13 changed ${hero.character}'s projectile content ${JSON.stringify(iphoneAttack)}`)
    check(iphoneAttack.hitDelay > 0, `iPhone 13 damage landed before ${hero.character} contact ${JSON.stringify(iphoneAttack)}`)
    check(iphoneAttack.hitAnimation === 'impact-bloom' && iphoneAttack.targetVfx.display !== 'none' &&
      iphoneAttack.targetVfx.image !== 'none' && iphoneAttack.targetVfx.blend === 'screen' &&
      iphoneAttack.targetVfx.animation === 'combat-vfx-reveal' &&
      iphoneAttack.targetVfx.beforeDisplay !== 'none' && iphoneAttack.targetVfx.beforeAnimation === 'combat-vfx-ring' &&
      iphoneAttack.targetVfx.afterDisplay !== 'none' && iphoneAttack.targetVfx.afterAnimation === 'combat-vfx-streak',
    `iPhone 13 lost PC impact VFX layers for ${hero.character} ${JSON.stringify(iphoneAttack)}`)
    check(iphoneAttack.portraitAnimations === 0, `damage shook the iPhone target ${JSON.stringify(iphoneAttack)}`)
    await phone.waitForTimeout(hero.contact + 120)
    const phoneSounds = await phone.evaluate((cue) => window.__ANIMATION_SFX__.filter((sound) => sound.cue === cue),
      `card:${hero.character}:${hero.sourceId}:base`)
    const phoneImpactPaths = new Set(['/assets/sfx/attack.ogg', '/assets/sfx/enemy-hit.ogg',
      '/assets/sfx/block.ogg', '/assets/sfx/weak.ogg'])
    check(phoneSounds.some((sound) => phoneImpactPaths.has(sound.path) && sound.delayMs === hero.contact) &&
      phoneSounds.some((sound) => sound.delayMs < hero.contact),
    `iPhone 13 changed ${hero.character} SFX content/timing ${JSON.stringify(phoneSounds)}`)
    if (hero.character === 'watcher' || hero.character === 'hexaghost') {
      await phone.locator('.board').screenshot({ path: join(output,
        `iphone-13-${browserName}-${hero.character}-impact.png`) })
    }
    if (hero.character === 'hexaghost') {
      const firstSource = iphoneAttack.poseAssets[0]?.src
      check(Boolean(firstSource?.endsWith('/assets/combat/characters/hexaghost-heat-0.webp') &&
        iphoneAttack.poseAssets[0]?.fallback),
      `iPhone cold Hexaghost attack had no immediate fallback ${JSON.stringify(iphoneAttack.poseAssets)}`)
      await attack.waitFor({ state: 'detached' })
      await phone.waitForFunction(() => document.querySelector('.board')
        ?.getAttribute('data-hexaghost-attack-assets-ready') === '7')
      check(phoneHexPreloadRequests === 7, `iPhone made ${phoneHexPreloadRequests} Hexaghost preload requests`)
      const repeatedSeq = 2_050_001
      await phone.evaluate((seq) => {
        const debug = window.__STS_DEBUG__
        const run = structuredClone(debug.getRun())
        run.combat.presentationEvents = [{
          seq, kind: 'card', actorId: run.combat.players[0].id, sourceId: 'strike_hexaghost',
          enemyIds: [run.combat.enemies[0].uid], playerIds: [], upgraded: false, copied: false, energy: 1,
        }]
        debug.setRun(run)
      }, repeatedSeq)
      await phone.locator(`.character-attack--hexaghost[data-attack-seq="${repeatedSeq}"]`).waitFor()
      const repeatedPose = phone.locator(
        `.character-attack__pose--hexaghost-state.is-loaded[data-attack-seq="${repeatedSeq}"]`,
      )
      await repeatedPose.waitFor()
      const repeatedSource = await repeatedPose.locator('img').getAttribute('src')
      check(Boolean(repeatedSource?.startsWith('blob:')),
        `iPhone did not use the decoded Hexaghost replay asset ${JSON.stringify({ repeatedSource })}`)
      await phone.locator(`.character-attack--hexaghost[data-attack-seq="${repeatedSeq}"]`)
        .waitFor({ state: 'detached' })
      const replaySeq = repeatedSeq + 1
      await phone.evaluate((seq) => {
        const debug = window.__STS_DEBUG__
        const run = structuredClone(debug.getRun())
        run.combat.presentationEvents = [{
          seq, kind: 'card', actorId: run.combat.players[0].id, sourceId: 'strike_hexaghost',
          enemyIds: [run.combat.enemies[0].uid], playerIds: [], upgraded: false, copied: false, energy: 1,
        }]
        debug.setRun(run)
      }, replaySeq)
      const replayPose = phone.locator(
        `.character-attack__pose--hexaghost-state.is-loaded[data-attack-seq="${replaySeq}"]`,
      )
      await replayPose.waitFor()
      const replaySource = await replayPose.locator('img').getAttribute('src')
      check(Boolean(replaySource?.startsWith('blob:') && replaySource !== repeatedSource),
        `iPhone reused Hexaghost's one-shot image timeline ${JSON.stringify({ repeatedSource, replaySource })}`)
      await phone.locator(`.character-attack--hexaghost[data-attack-seq="${replaySeq}"]`)
        .waitFor({ state: 'detached' })
      const transitionSeq = replaySeq + 1
      const requestsBeforeTransition = phoneHexPreloadRequests
      await phone.evaluate((seq) => {
        const debug = window.__STS_DEBUG__
        const run = structuredClone(debug.getRun())
        run.combat.players[0].heat = 1
        run.combat.presentationEvents = [{
          seq, kind: 'card', actorId: run.combat.players[0].id, sourceId: 'thermal_transfer',
          enemyIds: [run.combat.enemies[0].uid], playerIds: [], upgraded: false, copied: false, energy: 1,
        }]
        debug.setRun(run)
      }, transitionSeq)
      const transitionPose = phone.locator(
        `.character-attack__pose--hexaghost-state.is-loaded[data-attack-seq="${transitionSeq}"]`,
      )
      await transitionPose.waitFor()
      check(requestsBeforeTransition === 7 && phoneHexPreloadRequests === 7 &&
        await transitionPose.getAttribute('data-attack-asset') ===
          '/assets/combat/characters/hexaghost-heat-1-attack.webp',
      'iPhone cold-fetched or selected the wrong Hexaghost animation during a Heat transition')
    }
  }

  await phone.evaluate(() => { document.documentElement.dataset.reducedMotion = 'true' })
  await phone.waitForTimeout(50)
  await phone.evaluate(({ base }) => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.combat = structuredClone(base)
    run.combat.combatId = `${run.combat.combatId}-iphone-game-reduced`
    run.combat.phase = 'player'
    run.combat.players = [run.combat.players[0]]
    Object.assign(run.combat.players[0], { character: 'watcher', hp: 999, maxHp: 999, dead: false })
    run.combat.enemies = [{ ...run.combat.enemies[0], uid: 'iphone-reduced-target', defId: 'cultist',
      isBoss: false, hp: 998, maxHp: 999, dead: false }]
    run.combat.presentationEvents = [{
      seq: 2_100_001, kind: 'card', actorId: run.combat.players[0].id, sourceId: 'strike_watcher',
      enemyIds: ['iphone-reduced-target'], playerIds: [], upgraded: false, copied: false, energy: 1,
    }]
    debug.setRun(run)
  }, { base: phoneFixture })
  await phone.waitForTimeout(100)
  check(await phone.locator('.character-attack').count() === 0,
    'the visible in-game Reduce motion toggle no longer suppresses phone attacks')
  await phone.evaluate(() => { document.documentElement.dataset.reducedMotion = 'false' })
  await phone.waitForTimeout(50)
  await phone.evaluate(() => { document.documentElement.dataset.mobilePerformance = 'false' })
  await phone.waitForTimeout(50)
  check(await phone.locator('.seat__portrait > img').evaluate((body) =>
    getComputedStyle(body).animationName === 'none'),
  'coarse-pointer non-phone ignored OS Reduce Motion CSS')
  await phone.evaluate(() => { document.documentElement.dataset.mobilePerformance = 'true' })
  await phone.waitForTimeout(50)

  await phone.evaluate(({ base, enemy, actionIndex }) => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.combat = structuredClone(base)
    run.combat.combatId = `${run.combat.combatId}-iphone-boss`
    run.combat.players = [run.combat.players[0]]
    Object.assign(run.combat.players[0], { hp: 999, maxHp: 999, dead: false })
    run.combat.enemies = [{ ...enemy, uid: 'iphone-boss', actionIndex, hp: 999, maxHp: 999, dead: false }]
    run.combat.phase = 'player'
    debug.setRun(run)
  }, { base: phoneFixture, enemy: timingBoss, actionIndex: timingActionIndex })
  const phoneBoss = phone.locator('.enemy--boss[data-enemy-def="awakened_one_phase_1"]')
  await phoneBoss.locator('.enemy__art--cutout').waitFor()
  await phone.evaluate(() => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.combat.phase = 'enemy'
    debug.setRun(run)
  })
  await phone.waitForFunction(() =>
    document.querySelector('.enemy--boss[data-enemy-def="awakened_one_phase_1"]')?.getAttribute('data-animation') === 'attack')
  const iphoneBossAnimation = await phoneBoss.evaluate((boss) => ({
    name: getComputedStyle(boss.querySelector('.enemy__art--cutout')).animationName,
    filter: getComputedStyle(boss.querySelector('.enemy__art--cutout')).filter,
    claw: [...document.querySelectorAll('.seat:not(.seat--dead) .seat__portrait')].map((portrait) => ({
      display: getComputedStyle(portrait, '::before').display,
      animation: getComputedStyle(portrait, '::before').animationName,
    })),
  }))
  check(iphoneBossAnimation.name !== 'none' &&
    iphoneBossAnimation.claw.length > 0 && iphoneBossAnimation.claw.every((claw) =>
      claw.display !== 'none' && claw.animation === 'awakened-claw-scratch'),
    `iPhone 13 skipped the boss attack ${JSON.stringify(iphoneBossAnimation)}`)
  }

  const phoneDemon = { ...timingBoss, uid: 'iphone-demon', defId: 'downfall_demon' }
  let phoneDemonActionIndex = 0
  while (phoneDemonActionIndex < 8 && !actionsForEnemy(
    { ...phoneDemon, actionIndex: phoneDemonActionIndex }, phoneFixture.die,
  ).some((action) => action.kind === 'attack' || action.kind === 'attackSequence')) phoneDemonActionIndex++
  await phone.evaluate(({ base, enemy, actionIndex }) => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.combat = structuredClone(base)
    run.combat.combatId = `${run.combat.combatId}-iphone-demon`
    run.combat.players = [run.combat.players[0]]
    Object.assign(run.combat.players[0], { hp: 999, maxHp: 999, dead: false })
    run.combat.enemies = [{ ...enemy, actionIndex, hp: 999, maxHp: 999, dead: false }]
    run.combat.phase = 'player'
    debug.setRun(run)
  }, { base: phoneFixture, enemy: phoneDemon, actionIndex: phoneDemonActionIndex })
  const phoneDemonCard = phone.locator('.enemy--boss[data-enemy-def="downfall_demon"]')
  await phoneDemonCard.locator('.enemy__art--cutout').waitFor()
  await phone.evaluate(() => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.combat.phase = 'enemy'
    debug.setRun(run)
  })
  await phone.waitForFunction(() =>
    document.querySelector('.enemy--boss[data-enemy-def="downfall_demon"]')?.getAttribute('data-animation') === 'attack')
  await phoneDemonCard.locator('.boss-demon-grounded').waitFor()
  const samplePhoneDemon = async (time) => {
    await phone.evaluate((sampleTime) => {
      for (const animation of document.getAnimations()) {
        if (animation.animationName?.startsWith('boss-demon-')) {
          animation.currentTime = sampleTime
          animation.pause()
        }
      }
    }, time)
    return phoneDemonCard.evaluate((enemy) => {
      const airborne = enemy.querySelector('.enemy__art--cutout')
      const grounded = enemy.querySelector('.boss-demon-grounded')
      const board = enemy.closest('.board').getBoundingClientRect()
      const airborneRect = airborne.getBoundingClientRect()
      const groundedRect = grounded.getBoundingClientRect()
      return {
        airborneOpacity: Number(getComputedStyle(airborne).opacity),
        groundedOpacity: Number(getComputedStyle(grounded).opacity),
        airborneScale: getComputedStyle(airborne).getPropertyValue('--boss-scale').trim(),
        groundedScale: getComputedStyle(grounded).getPropertyValue('--boss-scale').trim(),
        airborneOffscreen: airborneRect.bottom < board.top,
        groundedInside: groundedRect.left >= board.left - 1 && groundedRect.right <= board.right + 1 &&
          groundedRect.top >= board.top - 1 && groundedRect.bottom <= board.bottom + 1,
      }
    })
  }
  const iphoneDemonImpact = await samplePhoneDemon(1005)
  check(iphoneDemonImpact.airborneScale === '1.5' && iphoneDemonImpact.groundedScale === '1.5' &&
    iphoneDemonImpact.airborneOpacity < 0.05 && iphoneDemonImpact.groundedOpacity > 0.5 &&
    iphoneDemonImpact.groundedInside,
  `iPhone 13 Demon impact changed scale or clipped ${JSON.stringify(iphoneDemonImpact)}`)
  await phone.locator('.board').screenshot({ path: join(output, 'phone-downfall_demon-impact.png') })
  const iphoneDemonReturn = await samplePhoneDemon(1450)
  check(iphoneDemonReturn.airborneOpacity > 0.5 && iphoneDemonReturn.groundedOpacity < 0.05 &&
    iphoneDemonReturn.airborneOffscreen,
  `iPhone 13 Demon return ascent stayed on screen ${JSON.stringify(iphoneDemonReturn)}`)
  const iphoneDemonLanding = await samplePhoneDemon(1780)
  check(iphoneDemonLanding.airborneOpacity < 0.05 && iphoneDemonLanding.groundedOpacity > 0.5 &&
    iphoneDemonLanding.groundedInside,
  `iPhone 13 Demon return landing changed scale or clipped ${JSON.stringify(iphoneDemonLanding)}`)
  await phone.locator('.board').screenshot({ path: join(output, 'phone-downfall_demon-return-landing.png') })

  const phoneProjectileBoss = { ...timingBoss, uid: 'iphone-projectile-boss', defId: 'downfall_witch' }
  let phoneProjectileActionIndex = 0
  while (phoneProjectileActionIndex < 8 && !actionsForEnemy(
    { ...phoneProjectileBoss, actionIndex: phoneProjectileActionIndex }, phoneFixture.die,
  ).some((action) => action.kind === 'attack' || action.kind === 'attackSequence')) phoneProjectileActionIndex++
  await phone.evaluate(({ base, enemy, actionIndex }) => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.combat = structuredClone(base)
    run.combat.combatId = `${run.combat.combatId}-iphone-projectile-boss`
    run.combat.players = [run.combat.players[0]]
    Object.assign(run.combat.players[0], { hp: 999, maxHp: 999, dead: false })
    run.combat.enemies = [{ ...enemy, actionIndex, hp: 999, maxHp: 999, dead: false }]
    run.combat.phase = 'player'
    debug.setRun(run)
  }, { base: phoneFixture, enemy: phoneProjectileBoss, actionIndex: phoneProjectileActionIndex })
  await phone.locator('.enemy--boss[data-enemy-def="downfall_witch"][data-animation="idle"]').waitFor()
  await phone.evaluate(() => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.combat.phase = 'enemy'
    debug.setRun(run)
  })
  const phoneProjectile = phone.locator('.enemy--boss[data-enemy-def="downfall_witch"] .boss-projectile')
  await phoneProjectile.waitFor()
  await phone.waitForFunction(() => {
    const image = document.querySelector('.enemy--boss[data-enemy-def="downfall_witch"] .boss-projectile img')
    return image?.complete && image.naturalWidth > 0
  })
  await phoneProjectile.evaluate((projectile) => {
    const animation = projectile.getAnimations()[0]
    if (animation) {
      animation.currentTime = 500
      animation.pause()
    }
  })
  const iphoneProjectile = await phoneProjectile.evaluate((projectile) => {
    const style = getComputedStyle(projectile)
    const rect = projectile.getBoundingClientRect()
    const target = document.querySelector(`.seat[data-player-id="${CSS.escape(projectile.dataset.targetPlayer)}"] .seat__portrait`)
    const targetRect = target?.getBoundingClientRect()
    const bossRect = projectile.closest('.enemy').getBoundingClientRect()
    const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
    const values = ['--boss-projectile-start-x', '--boss-projectile-start-y', '--boss-projectile-x', '--boss-projectile-y']
      .map((name) => style.getPropertyValue(name).trim())
    const endX = bossRect.left + (Number.parseFloat(values[0]) + Number.parseFloat(values[2])) * rem
    const endY = bossRect.top + (Number.parseFloat(values[1]) + Number.parseFloat(values[3])) * rem
    const image = projectile.querySelector('img')
    return {
      animation: style.animationName,
      values,
      loaded: Boolean(image?.complete && image.naturalWidth > 0),
      image: image?.getAttribute('src') ?? '',
      visible: rect.left >= -1 && rect.right <= innerWidth + 1 && rect.top >= -1 && rect.bottom <= innerHeight + 1,
      reachesTarget: Boolean(targetRect && Math.abs(endX - (targetRect.left + targetRect.width / 2)) <= 1 &&
        Math.abs(endY - (targetRect.top + targetRect.height / 2)) <= 1),
    }
  })
  check(iphoneProjectile.animation === 'boss-projectile-flight' && iphoneProjectile.loaded &&
    iphoneProjectile.image.endsWith('/projectiles/downfall_witch.webp') && iphoneProjectile.visible &&
    iphoneProjectile.reachesTarget && iphoneProjectile.values.every((value) => value.endsWith('rem')),
  `iPhone 13 clipped or misplaced the Downfall boss projectile ${JSON.stringify(iphoneProjectile)}`)
  await phone.locator('.board').screenshot({ path: join(output, `iphone-13-${browserName}-downfall-projectile.png`) })

  check(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`)
} finally {
  await phoneContext?.close()
  await browser.close()
  await server.close()
}

if (failures.length) {
  console.error(failures.map((failure) => `- ${failure}`).join('\n'))
  process.exit(1)
}
console.log(mapOnly
  ? `Map browser QA passed: desktop and horizontal-phone screenshots: ${output}`
  : `Animation browser QA passed: ${bossCount} bosses × 4 states, 8 heroes × 3 phases; screenshots: ${output}`)
