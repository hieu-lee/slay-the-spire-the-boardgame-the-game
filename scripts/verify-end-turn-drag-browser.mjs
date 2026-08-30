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
  await page.evaluate(({ character, powers, orbs, enemies }) => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    const baseEnemy = run.combat.enemies[0]
    const player = run.combat.players[0]
    run.phase = 'combat'
    run.combat.phase = 'player'
    run.combat.pendingTriggers = []
    run.combat.startTurnProgress = undefined
    run.combat.pendingDistilled = undefined
    run.combat.players = [{
      ...player,
      character,
      name: character[0].toUpperCase() + character.slice(1),
      hand: [], draw: [], discard: [], exhaust: [], powers, relics: [], potions: [],
      energy: 0, block: 0, strength: 0, weak: 0, vulnerable: 0, shivs: 0, miracles: 0,
      stance: 'neutral', orbs, dead: false,
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
}

try {
  suite('end-turn drag browser')
  await page.goto(`http://localhost:${address.port}`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Single Player', exact: true }).click()
  await page.getByRole('button', { name: 'Embark' }).click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'neow')
  await page.evaluate(() => {
    const debug = window.__STS_DEBUG__
    debug.reset(1, 'end-turn-drag')
    const run = structuredClone(debug.getRun())
    debug.setRun({ ...run, phase: 'map', neow: null })
  })
  await page.locator('.room--reachable').first().click()
  await page.locator('.combat').waitFor()

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
  await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.enemies.find((enemy) => enemy.uid === 'drag-e1')?.dead)
  const secondOrb = page.locator('button.end-turn-effect--orb')
  await secondOrb.waitFor()
  await drag(secondOrb, page.locator('[data-enemy-id="drag-e2"]'))
  await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.enemies.every((enemy) => enemy.dead))
  check('Lightning Orbs drag from the top effect source and resolve one at a time', () => {
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
  await drag(loop, page.locator('[data-enemy-id="loop-row-boss"]'))
  await page.getByText('choose its row', { exact: false }).waitFor()
  await drag(page.locator('.end-turn-effect--card'), page.locator('[data-enemy-id="loop-row-two"]'))
  await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.enemies
    .find((enemy) => enemy.uid === 'loop-row-two')?.hp === 18)
  const loopBossHp = await page.evaluate(() => window.__STS_DEBUG__.getRun().combat.enemies
    .find((enemy) => enemy.uid === 'loop-row-boss')?.hp)
  check('Loop drags an Electrodynamics boss target through the required row tiebreak', () => {
    assert(loopBossHp === 18, `the selected Loop row did not include the boss: ${loopBossHp}`)
  })

  assert(pageErrors.length === 0, `browser errors: ${pageErrors.join('\n')}`)
} finally {
  await browser.close()
  await server.close()
}

report()
