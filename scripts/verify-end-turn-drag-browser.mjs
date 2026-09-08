#!/usr/bin/env node
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { assert, check, report, suite } from './lib/harness.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(root, 'artifacts/end-turn-drag-browser')
mkdirSync(output, { recursive: true })
const server = await createServer({ root, logLevel: 'silent', server: { port: 0 } })
await server.listen()
const address = server.httpServer?.address()
if (!address || typeof address === 'string') throw new Error('Vite did not report a port')
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(String(error)))

async function drag(source, target) {
  const from = await source.boundingBox()
  const to = await target.boundingBox()
  assert(from && to, 'the drag source and target must be visible')
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 })
  await page.mouse.up()
}

async function fixture({ character, powers = [], orbs = [null, null, null], enemies }) {
  // Debug fixtures replace one combat in place; let the prior local
  // auto-advance timer settle before installing another same-phase state.
  await page.waitForTimeout(300)
  await page.evaluate(({ character, powers, orbs, enemies }) => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    const baseEnemy = run.combat.enemies[0]
    const player = run.combat.players[0]
    run.phase = 'combat'
    run.combat.phase = 'player'
    run.combat.pendingTriggers = []
    run.combat.startTurnProgress = undefined
    run.combat.endTurnProgress = undefined
    run.combat.pendingDistilled = undefined
    run.combat.players = [{
      ...player,
      character,
      name: character[0].toUpperCase() + character.slice(1),
      hand: [], draw: [], discard: [], exhaust: [], powers, relics: [], potions: [],
      energy: 0, block: 0, strength: 0, weak: 0, vulnerable: 0, shivs: 0, miracles: 0,
      stance: 'neutral', orbs, dead: false, damageDealtZeroThisTurn: false,
    }]
    run.combat.enemies = enemies.map((enemy, index) => ({
      ...baseEnemy,
      uid: enemy.uid,
      row: enemy.row ?? index,
      isBoss: enemy.isBoss ?? false,
      hp: enemy.hp,
      maxHp: enemy.hp,
      block: 0,
      poison: 0,
      dead: false,
    }))
    debug.setRun(run)
  }, { character, powers, orbs, enemies })
  await page.locator(`[data-enemy-id="${enemies.at(-1).uid}"]`).waitFor()
}

async function startTurnRelicFixture() {
  await page.evaluate(() => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    const player = run.combat.players[0]
    const ally = structuredClone(player)
    Object.assign(player, {
      id: player.id, name: 'Silent', character: 'silent', row: 0, block: 0,
      hand: [], draw: [], discard: [], exhaust: [], powers: [], potions: [], orbs: [null, null, null],
      relics: [{ defId: 'oddly_smooth_stone', spent: false }], dead: false,
    })
    Object.assign(ally, {
      id: 'relic-ally', name: 'Defect', character: 'defect', row: 1, block: 0,
      hand: [], draw: [], discard: [], exhaust: [], powers: [], potions: [], orbs: [null, null, null],
      relics: [], dead: false,
    })
    Object.assign(run.combat, {
      combatId: `${run.combat.combatId}:start-relic`,
      phase: 'start', startTurnStage: 'effects', die: 4, players: [player, ally],
      startTurnProgress: undefined, endTurnProgress: undefined, pendingTriggers: [], presentationEvents: [],
    })
    debug.setRun(run)
  })
}

try {
  suite('end-turn drag browser')
  await page.goto(`http://localhost:${address.port}`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Single Player', exact: true }).click()
  await page.getByRole('button', { name: 'Standard', exact: true }).click()
  await page.getByRole('button', { name: 'Embark' }).click()
  await page.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'neow')
  await page.evaluate(() => {
    const debug = window.__STS_DEBUG__
    debug.reset(1, 'end-turn-drag')
    const run = structuredClone(debug.getRun())
    debug.setRun({ ...run, phase: 'map', neow: null })
  })
  await page.locator('.room--reachable').first().click()
  await page.locator('.combat').waitFor()

  await page.evaluate(() => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    const player = run.combat.players[0]
    const haunted = { uid: 'local-mayhem-haunted', defId: 'haunted_hand', upgraded: false }
    Object.assign(player, {
      character: 'hexaghost', heat: 2, hand: [haunted], draw: [], discard: [], exhaust: [], powers: [],
    })
    Object.assign(run.combat, {
      phase: 'start', startTurnProgress: { choices: [], forcedCard: {
        playerId: player.id, cardUid: haunted.uid, sourceCardId: 'mayhem', exhaustNonPower: false,
      } },
    })
    debug.setRun(run)
  })
  await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.startTurnProgress?.forcedCard === undefined)
  const localMayhem = await page.evaluate(() => {
    const combat = window.__STS_DEBUG__.getRun().combat
    return { phase: combat.phase, exhausted: combat.players[0].exhaust.some((card) =>
      card.uid === 'local-mayhem-haunted') }
  })
  check('local deterministic Mayhem cards auto-play without a click', () => {
    assert(localMayhem.phase === 'player' && localMayhem.exhausted,
      `local Mayhem did not finish automatically: ${JSON.stringify(localMayhem)}`)
  })

  await fixture({
    character: 'defect',
    orbs: ['lightning', 'lightning', null],
    enemies: [{ uid: 'drag-e1', hp: 1 }, { uid: 'drag-e2', hp: 1, row: 1 }],
  })
  await page.getByRole('button', { name: 'End turn', exact: true }).click()
  const firstOrb = page.locator('button.end-turn-effect--orb')
  await firstOrb.waitFor()
  await page.waitForTimeout(320)
  const firstPrompt = await page.locator('.end-turn-effects__prompt').innerText()
  const firstPosition = await firstOrb.evaluate((source) => {
    const rect = source.getBoundingClientRect()
    return { top: rect.top, animation: getComputedStyle(source).animationName }
  })
  await page.screenshot({ path: join(output, 'defect-lightning-drag.png'), fullPage: true })
  await drag(firstOrb, page.locator('[data-enemy-id="drag-e1"]'))
  await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.enemies.every((enemy) => enemy.dead))
  check('Lightning Orbs drag only while multiple targets remain', () => {
    assert(firstPrompt.includes('Drag'), `missing drag instruction: ${firstPrompt}`)
    assert(firstPosition.top < 180, `the Orb source was not at the top of the battle: ${firstPosition.top}`)
    assert(firstPosition.animation.includes('end-turn-effect-arrive'), `the Orb did not arrive with its effect animation: ${firstPosition.animation}`)
  })

  await fixture({
    character: 'watcher',
    powers: [{ uid: 'drag-omega', defId: 'omega', upgraded: false }],
    enemies: [
      { uid: 'omega-e1', hp: 20 },
      { uid: 'omega-e2', hp: 20, row: 1 },
      { uid: 'omega-boss', hp: 20, row: 0, isBoss: true },
    ],
  })
  await page.getByRole('button', { name: 'End turn', exact: true }).click()
  const omega = page.locator('.end-turn-effect--card')
  await omega.waitFor()
  await page.waitForTimeout(320)
  const omegaArt = await omega.locator('.card__art').getAttribute('src')
  await page.screenshot({ path: join(output, 'watcher-omega-drag.png'), fullPage: true })
  await drag(omega, page.locator('[data-enemy-id="omega-boss"]'))
  await page.getByText('choose its row', { exact: false }).waitFor()
  const rowPrompt = await page.locator('.end-turn-effects__prompt').innerText()
  const rowOmega = page.locator('.end-turn-effect--card')
  await drag(rowOmega, page.locator('[data-enemy-id="omega-boss"]'))
  await page.waitForTimeout(80)
  assert(await page.locator('.end-turn-effects__prompt').isVisible(), 'the row tiebreak accepted a second boss drop')
  await drag(rowOmega, page.locator('[data-enemy-id="omega-e2"]'))
  await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.enemies
    .find((enemy) => enemy.uid === 'omega-e2')?.hp === 15)
  const bossHp = await page.evaluate(() => window.__STS_DEBUG__.getRun().combat.enemies
    .find((enemy) => enemy.uid === 'omega-boss')?.hp)
  check('Omega uses its Power card as the draggable end-turn source', () => {
    assert(String(omegaArt).includes('omega'), `Omega did not render its card asset: ${omegaArt}`)
    assert(rowPrompt.includes('choose its row'), `the boss did not request a row tiebreak: ${rowPrompt}`)
    assert(bossHp === 15, `the chosen row did not include the boss: ${bossHp}`)
  })

  await fixture({
    character: 'ironclad',
    powers: [{ uid: 'drag-panache', defId: 'panache', upgraded: true }],
    enemies: [{ uid: 'panache-e1', hp: 20 }, { uid: 'panache-e2', hp: 20, row: 1 }],
  })
  await page.getByRole('button', { name: 'End turn', exact: true }).click()
  const panache = page.locator('.end-turn-effect--card')
  await panache.waitFor()
  await panache.click()
  await page.locator('.enemy--targeted').first().waitFor()
  await page.locator('[data-enemy-id="panache-e2"]').click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.enemies
    .find((enemy) => enemy.uid === 'panache-e2')?.hp === 15)
  check('another end-turn Power uses the same card-to-row targeting flow', () => assert(true))

  await fixture({
    character: 'defect',
    powers: [{ uid: 'click-loop', defId: 'loop', upgraded: true }],
    orbs: ['lightning', null, null],
    enemies: [{ uid: 'click-loop-enemy', hp: 20 }],
  })
  await page.getByRole('button', { name: 'End turn', exact: true }).click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat?.enemies
    .find((enemy) => enemy.uid === 'click-loop-enemy')?.hp === 17)
  check('a sole Loop Orb and enemy resolve without redundant click, keyboard, or drag actions', () => assert(true))

  await fixture({
    character: 'defect',
    powers: [
      { uid: 'drag-electrodynamics', defId: 'electrodynamics', upgraded: true },
      { uid: 'drag-loop', defId: 'loop', upgraded: true },
    ],
    orbs: ['lightning', 'frost', null],
    enemies: [
      { uid: 'loop-row-one', hp: 20 },
      { uid: 'loop-row-two', hp: 20, row: 1 },
      { uid: 'loop-row-boss', hp: 20, row: 0, isBoss: true },
    ],
  })
  await page.getByRole('button', { name: 'End turn', exact: true }).click()
  const loop = page.locator('.end-turn-effect--card')
  await loop.waitFor()
  const loopOrb = page.getByRole('button', { name: 'Choose lightning Orb 1' })
  await loopOrb.waitFor()
  await page.screenshot({ path: join(output, 'defect-loop-select-orb.png'), fullPage: true })
  const loopOrbBox = await loopOrb.boundingBox()
  const loopCardBox = await loop.boundingBox()
  const orbRowBox = await page.locator('.seat--viewer + .orbs').boundingBox()
  const defectPortraitBox = await page.locator('.seat--viewer .seat__portrait').boundingBox()
  assert(loopOrbBox && loopCardBox && orbRowBox && defectPortraitBox, 'the Loop card, target Orb, and Defect portrait must be visible')
  assert(defectPortraitBox.width > 80 && defectPortraitBox.height > 80,
    'the Defect portrait collapsed after adding the independent Orb target')
  assert(loopOrbBox.x >= defectPortraitBox.x - defectPortraitBox.width * 0.3 &&
    loopOrbBox.x + loopOrbBox.width <= defectPortraitBox.x + defectPortraitBox.width * 1.3,
  'the selected Orb detached from the Defect portrait')
  const orbGap = defectPortraitBox.y - (loopOrbBox.y + loopOrbBox.height)
  assert(orbGap >= -1 && orbGap <= 160, `the selected Orb detached vertically from the Defect: ${orbGap}px`)
  assert(Math.abs(orbRowBox.y + orbRowBox.height - defectPortraitBox.y) <= 1,
    'the Orb row no longer rests directly above the Defect portrait')
  await page.setViewportSize({ width: 1440, height: 700 })
  const compactOrbRowBox = await page.locator('.seat--viewer + .orbs').boundingBox()
  const compactPortraitBox = await page.locator('.seat--viewer .seat__portrait').boundingBox()
  assert(compactOrbRowBox && compactPortraitBox &&
    Math.abs(compactOrbRowBox.y + compactOrbRowBox.height - compactPortraitBox.y) <= 1,
  'the Orb row no longer rests directly above the compact Defect portrait')
  await page.setViewportSize({ width: 1440, height: 900 })
  assert(loopCardBox.y < loopOrbBox.y, 'the Loop card was not above the Orb drag source')
  await drag(loopOrb, loop)
  await drag(loopOrb, loop)
  const copiedLightning = page.locator('button.end-turn-effect--orb')
  await copiedLightning.waitFor()
  await drag(copiedLightning, page.locator('[data-enemy-id="loop-row-boss"]'))
  await page.getByText('choose its row', { exact: false }).waitFor()
  await drag(copiedLightning, page.locator('[data-enemy-id="loop-row-two"]'))
  await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.enemies
    .find((enemy) => enemy.uid === 'loop-row-two')?.hp === 19)
  const loopBossHp = await page.evaluate(() => window.__STS_DEBUG__.getRun().combat.enemies
    .find((enemy) => enemy.uid === 'loop-row-boss')?.hp)
  check('Loop selects Orbs by dragging them up to its card, then copied Electrodynamics Lightning uses the required row tiebreak', () => {
    assert(loopBossHp === 19, `the selected copied Lightning row did not include the boss: ${loopBossHp}`)
  })

  await page.setViewportSize({ width: 1440, height: 900 })
  await startTurnRelicFixture()
  const relic = page.locator('button.end-turn-effect--relic')
  await relic.waitFor()
  await relic.evaluate(async (source) => Promise.all(source.getAnimations().map((animation) => animation.finished)))
  const relicPosition = await relic.evaluate((source) => {
    const rect = source.getBoundingClientRect()
    return { top: rect.top, src: source.querySelector('img')?.getAttribute('src') }
  })
  await page.screenshot({ path: join(output, 'start-turn-oddly-smooth-stone-target-desktop.png'), fullPage: true })
  const staleVfxCount = await page.locator('.combat-vfx').count()
  await drag(relic, page.locator('.seat[data-player-id="relic-ally"]'))
  await page.getByRole('button', { name: 'Resolve start of turn', exact: true }).click()
  const desktopImpact = page.locator(
    '.seat[data-player-id="relic-ally"] .combat-vfx[data-vfx-kind="turn"][data-vfx-source="oddly_smooth_stone"]',
  )
  await desktopImpact.waitFor()
  const desktopImpactAsset = await desktopImpact.getAttribute('data-vfx-asset')
  await page.screenshot({ path: join(output, 'start-turn-oddly-smooth-stone-impact-desktop.png'), fullPage: true })
  const desktopBlocks = await page.evaluate(() => window.__STS_DEBUG__.getRun().combat.players
    .map((player) => player.block))
  check('Oddly Smooth Stone drags from its top-center relic asset to a player', () => {
    assert(staleVfxCount === 0, 'the start-turn prompt leaked a prior scenario VFX')
    assert(relicPosition.top < 180, `the relic source was not at the top of the battle: ${relicPosition.top}`)
    assert(String(relicPosition.src).includes('oddly_smooth_stone'), `wrong relic asset: ${relicPosition.src}`)
    assert(desktopImpactAsset === 'turn-block-impact', `wrong Oddly Smooth Stone impact: ${desktopImpactAsset}`)
    assert(desktopBlocks[0] === 0 && desktopBlocks[1] === 2,
      `the dragged relic targeted the wrong player: ${desktopBlocks}`)
  })

  await page.setViewportSize({ width: 844, height: 390 })
  await startTurnRelicFixture()
  const phoneRelic = page.locator('button.end-turn-effect--relic')
  await phoneRelic.waitFor()
  await phoneRelic.evaluate(async (source) => Promise.all(source.getAnimations().map((animation) => animation.finished)))
  const phoneOrderOverlap = await page.evaluate(() => {
    const order = document.querySelector('.start-turn-order > summary')?.getBoundingClientRect()
    const resolve = document.querySelector('.combat__end-turn')?.getBoundingClientRect()
    const prompt = document.querySelector('.prompt')?.getBoundingClientRect()
    const overlaps = (left, right) => left && right && left.left < right.right && left.right > right.left &&
      left.top < right.bottom && left.bottom > right.top
    return Boolean(overlaps(order, resolve) || overlaps(order, prompt))
  })
  await page.screenshot({ path: join(output, 'start-turn-oddly-smooth-stone-target-horizontal-phone.png'), fullPage: true })
  await phoneRelic.click()
  await page.locator('.seat[data-player-id="relic-ally"]').press('Enter')
  await page.getByRole('button', { name: 'Resolve start of turn', exact: true }).click()
  const phoneImpact = page.locator(
    '.seat[data-player-id="relic-ally"] .combat-vfx[data-vfx-kind="turn"][data-vfx-asset="turn-block-impact"]',
  )
  await phoneImpact.waitFor()
  const phoneAllyBlock = await page.evaluate(() => window.__STS_DEBUG__.getRun().combat.players[1].block)
  check('horizontal-phone start-turn relic targeting keeps click and keyboard fallback', () => {
    assert(!phoneOrderOverlap, 'the horizontal-phone action prompt or resolve button covers the order summary')
    assert(phoneAllyBlock === 2, `horizontal-phone relic target did not resolve: ${phoneAllyBlock}`)
  })

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.evaluate(() => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    const player = run.combat.players[0]
    Object.assign(player, {
      hand: [
        { uid: 'retain-a', defId: 'bash', upgraded: false },
        { uid: 'retain-b', defId: 'defend_ironclad', upgraded: false },
        { uid: 'retain-c', defId: 'deflect', upgraded: false },
      ],
      draw: [], discard: [], exhaust: [], powers: [], chamber: [], retainCardsThisTurn: 1,
    })
    Object.assign(run.combat, { phase: 'discard', players: [player], pendingTriggers: [] })
    debug.setRun(run)
  })
  await page.getByRole('button', { name: /Confirm end-turn effect/ }).waitFor()
  const retainOnlyTop = await page.getByLabel(/Top discard/).count()
  await page.evaluate(() => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.combat.players[0].draw = [{ uid: 'future-claw', defId: 'claw', upgraded: false }]
    debug.setRun(run)
  })
  await page.getByLabel('Top discard for Silent').waitFor()
  check('Retain-only players see discard order only when a top-discard card can read it', () => {
    assert(retainOnlyTop === 0, `Retain alone exposed an irrelevant Top discard selector: ${retainOnlyTop}`)
  })

  await page.evaluate(() => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    const first = run.combat.players[0]
    const second = { ...structuredClone(first), id: 'beat-ally', name: 'Beat ally', row: 1 }
    Object.assign(first, { id: first.id, name: 'Beat actor', row: 0, hp: 10, maxHp: 10, block: 0, dead: false })
    Object.assign(second, { hp: 10, maxHp: 10, block: 0, dead: false })
    const heart = { ...run.combat.enemies[0], uid: 'beat-heart', defId: 'corrupt_heart', isBoss: true,
      hp: 100, maxHp: 100, block: 0, dead: false, abilityCubes: 1 }
    Object.assign(run.combat, {
      combatId: `${run.combat.combatId}:beat-vfx`, phase: 'player', players: [first, second], enemies: [heart],
      startTurnProgress: undefined, endTurnProgress: undefined, pendingTriggers: [], presentationEvents: [],
    })
    debug.setRun(run)
  })
  await page.getByRole('button', { name: 'End turn', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll(
    '.seat .combat-vfx[data-vfx-kind="turn"][data-vfx-asset="turn-damage-impact"]',
  ).length === 2)
  check('Beat of Death renders its turn-damage impact on every damaged player', () => assert(true))

  assert(pageErrors.length === 0, `browser errors: ${pageErrors.join('\n')}`)
} finally {
  await browser.close()
  await server.close()
}

report()
