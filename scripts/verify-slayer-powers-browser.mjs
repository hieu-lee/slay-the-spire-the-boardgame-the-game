#!/usr/bin/env node
// The Slayer Pack powers choices in the real combat screen: Metamorphosis picks the
// Power it attaches to (its X is shown and charged), Infernal Blade can only be
// used with a Status or Curse in hand, and Companion's end-of-turn "You may also
// Exhaust this" is a toggle beside its drag-to-enemy source. Desktop mouse and
// keyboard plus horizontal-phone touch, the two supported screen classes.
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from './lib/profile-browser.mjs'
import { assert, check, report, suite } from './lib/harness.mjs'
import { createRun } from '../src/game/run.ts'
import { createCombat } from '../src/game/combat.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(root, 'artifacts/slayer-powers-browser')
mkdirSync(output, { recursive: true })
const server = await createServer({ root, logLevel: 'silent', server: { port: 0 } })
await server.listen()
const address = server.httpServer?.address()
if (!address || typeof address === 'string') throw new Error('Vite did not report a port')
const browser = await chromium.launch({ headless: true })
const pageErrors = []

/** Replaces the live combat with a fixture built on the real template. */
async function fixture(page, combatTemplate, id, { hand = [], powers = [], energy = 3, enemies = 2, draw = [] }) {
  await page.evaluate(({ id, hand, powers, energy, enemies, draw, combatTemplate }) => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.combat = structuredClone(combatTemplate)
    const baseEnemy = run.combat.enemies[0]
    const player = run.combat.players[0]
    run.phase = 'combat'
    Object.assign(run.combat, {
      combatId: `slayer-powers:${id}`, phase: 'player', pendingTriggers: [], startTurnProgress: undefined,
      endTurnProgress: undefined, powerTriggersUsedThisTurn: [], presentationEvents: [],
    })
    // A spare affordable Defend keeps solo auto-end-turn from racing the next fixture.
    run.combat.players = [{
      ...player, character: 'ironclad', name: 'Ironclad', powers, energy: energy + 1,
      hand: [...hand, { uid: `g2b-spare-${id}`, defId: 'defend_ironclad', upgraded: false }],
      draw, discard: [], exhaust: [], relics: [], potions: [], hp: 50, maxHp: 50, block: 0,
      strength: 0, weak: 0, vulnerable: 0, shivs: 0, miracles: 0, stance: 'neutral', dead: false,
    }]
    run.combat.enemies = Array.from({ length: enemies }, (_, index) => ({
      ...baseEnemy, uid: `g2b-e${index + 1}`, row: index, isBoss: false, hp: 30, maxHp: 30,
      block: 0, poison: 0, weak: 0, vulnerable: 0, strength: 0, abilityUsed: true, dead: false,
    }))
    debug.setRun(run)
  }, { id, hand, powers, energy, enemies, draw, combatTemplate })
  await page.waitForFunction((combatId) => window.__STS_DEBUG__.getRun().combat?.combatId === combatId,
    `slayer-powers:${id}`)
  await page.locator('[data-enemy-id="g2b-e1"]').waitFor()
  await page.waitForTimeout(400)
}

const combat = (page) => page.evaluate(() => window.__STS_DEBUG__.getRun().combat)

try {
  for (const [name, width, height, touch] of [['desktop', 1440, 900, false], ['phone-landscape', 844, 390, true]]) {
    suite(`slayer powers browser — ${name}`)
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce', hasTouch: touch })
    page.on('pageerror', (error) => pageErrors.push(String(error)))
    const press = (locator) => touch ? locator.tap() : locator.click()
    await page.goto(`http://localhost:${address.port}`, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'Single Player', exact: true }).click()
    await page.getByRole('button', { name: 'Standard', exact: true }).click()
    await page.getByRole('button', { name: 'Embark' }).click()
    await page.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
    await page.waitForFunction(() => window.__STS_DEBUG__?.getRun()?.phase === 'neow')
    const viewerId = await page.evaluate(() => window.__STS_DEBUG__.getRun().players[0].id)
    const run = createRun(917, [{ id: viewerId, name: 'Ironclad', character: 'ironclad' }])
    run.combat = createCombat({ seed: 917, calls: 0 }, run.players, [0, 1].map((row) => ({
      uid: `seed-e${row}`, defId: 'jaw_worm', row, isBoss: false, hp: 30, maxHp: 30, block: 0, strength: 0,
      vulnerable: 0, weak: 0, poison: 0, goldReward: 0, cardReward: null, actionIndex: 0, abilityUsed: false, dead: false,
    })), 'slayer-powers:template')
    run.phase = 'combat'
    run.neow = null
    await page.evaluate((run) => window.__STS_DEBUG__.setRun(run), run)
    await page.locator('.combat').waitFor()
    const template = run.combat

    for (const upgraded of [false, true]) {
      const x = upgraded ? 1 : 2
      await fixture(page, template, `meta-${upgraded}`, {
        hand: [{ uid: 'g2b-meta', defId: 'slayer_metamorphosis', upgraded }],
        powers: [{ uid: 'g2b-caltrops', defId: 'slayer_caltrops', upgraded: false }],
      })
      const card = page.getByRole('button', { name: /^Metamorphosis/ }).first()
      if (touch) { await card.tap(); await card.tap() } else await card.press('Enter')
      await page.getByText(/choose one of your Powers to attach to and copy/).waitFor()
      const attach = page.getByRole('button', { name: `Attach to Caltrops, spend ${x} Energy` })
      await attach.waitFor()
      await page.screenshot({ path: join(output, `${name}-metamorphosis${upgraded ? '-plus' : ''}-choice.png`) })
      await press(attach)
      await page.waitForFunction(() => !window.__STS_DEBUG__.getRun().combat.players[0].hand.some((card) => card.uid === 'g2b-meta'))
      const after = await combat(page)
      check(`Metamorphosis${upgraded ? '+' : ''} attaches to the chosen Power for X=${x}`, () => {
        const copy = after.players[0].powers.find((power) => power.uid === 'g2b-meta')
        assert(copy?.defId === 'slayer_caltrops' && copy.metamorphosis?.sourceUid === 'g2b-caltrops',
          `the copy is not attached: ${JSON.stringify(after.players[0].powers)}`)
        assert(after.players[0].energy === 4 - x, `X was not charged: ${after.players[0].energy}`)
      })
    }

    await fixture(page, template, 'blade-blocked', {
      hand: [{ uid: 'g2b-strike', defId: 'strike_ironclad', upgraded: false }],
      powers: [{ uid: 'g2b-blade', defId: 'slayer_infernal_blade', upgraded: false }],
    })
    const blockedButton = page.getByRole('button', { name: 'Use Infernal Blade' })
    await blockedButton.waitFor()
    const disabled = await blockedButton.isDisabled()
    await fixture(page, template, 'blade-ready', {
      hand: [{ uid: 'g2b-daze', defId: 'daze', upgraded: false }],
      powers: [{ uid: 'g2b-blade', defId: 'slayer_infernal_blade', upgraded: false }],
    })
    const ready = page.getByRole('button', { name: 'Use Infernal Blade' })
    const enabled = await ready.isEnabled()
    await press(ready)
    await page.locator('.enemy--targeted[data-enemy-id="g2b-e2"]').waitFor()
    await page.screenshot({ path: join(output, `${name}-infernal-blade-target.png`) })
    await press(page.locator('[data-enemy-id="g2b-e2"]'))
    await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.enemies[1].weak === 1)
    const usedLabel = await page.getByRole('button', { name: 'Infernal Blade used' }).count()
    check('Infernal Blade is usable only with a Status or Curse in hand, once per turn', () => {
      assert(disabled, 'the Power was usable with only a Strike in hand')
      assert(enabled, 'a Daze in hand did not enable it')
      assert(usedLabel === 1, 'the button did not record its once-per-turn use')
    })

    await fixture(page, template, 'companion', {
      hand: [], powers: [{ uid: 'g2b-dragon', defId: 'slayer_companion', upgraded: true }], energy: 0,
    })
    await press(page.getByRole('button', { name: 'End turn', exact: true }))
    const toggle = page.getByRole('button', { name: 'Also Exhaust for Block' })
    await toggle.waitFor()
    await press(toggle)
    await page.getByRole('button', { name: 'Also Exhaust: on' }).waitFor()
    await page.screenshot({ path: join(output, `${name}-companion-exhaust-toggle.png`) })
    await press(page.locator('.end-turn-effect--card'))
    await press(page.locator('[data-enemy-id="g2b-e1"]'))
    await page.waitForFunction(() => {
      const state = window.__STS_DEBUG__.getRun().combat
      return state.players[0].exhaust.some((card) => card.uid === 'g2b-dragon')
    })
    const companion = await combat(page)
    check('Companion deals 4 to the chosen enemy and can also Exhaust for 3 Block', () => {
      const target = companion.enemies.find((enemy) => enemy.uid === 'g2b-e1')
      assert(target.hp === 26, `the dragon did not deal 4: ${target.hp}`)
      assert(companion.players[0].powers.length === 0, 'Companion stayed in play')
      // Read off the log: a solo turn may already have moved on to the Enemy Turn.
      assert(companion.log.some((line) => /Companion\+: Ironclad gains 3 Block/.test(line)),
        `the Exhaust did not grant 3 Block: ${companion.log.slice(-8).join(' | ')}`)
    })

    // Havoc plays the top card for free (X = 0): Metamorphosis+ may attach only to a 0-X Power.
    await fixture(page, template, 'forced-meta', {
      hand: [{ uid: 'g2b-havoc', defId: 'havoc', upgraded: true }],
      draw: [{ uid: 'g2b-forced-meta', defId: 'slayer_metamorphosis', upgraded: true }],
      powers: [{ uid: 'g2b-brutality', defId: 'slayer_brutality', upgraded: false },
        { uid: 'g2b-caltrops2', defId: 'slayer_caltrops', upgraded: false }],
    })
    const havoc = page.getByRole('button', { name: /^Havoc/ }).first()
    if (touch) { await havoc.tap(); await havoc.tap() } else await havoc.press('Enter')
    await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.startTurnProgress?.forcedCard?.cardUid === 'g2b-forced-meta')
    const prompt = page.getByText(/choose one of your Powers to attach to and copy/)
    if (!await prompt.isVisible().catch(() => false)) {
      const forced = page.getByRole('button', { name: /^Metamorphosis/ }).first()
      if (touch) { await forced.tap(); await forced.tap() } else await forced.press('Enter')
    }
    await prompt.waitFor()
    const offered = await page.getByRole('button', { name: /^Attach to / }).allTextContents()
    await page.screenshot({ path: join(output, `${name}-forced-metamorphosis.png`) })
    await press(page.getByRole('button', { name: 'Attach to Brutality' }))
    await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.players[0].powers
      .some((power) => power.uid === 'g2b-forced-meta'))
    const forcedResult = await combat(page)
    check('a Havoc-forced Metamorphosis+ asks for a 0-X Power and attaches for free', () => {
      assert(offered.length === 1 && offered[0].includes('Brutality'), `offered: ${offered.join(', ')}`)
      assert(forcedResult.players[0].powers.find((power) => power.uid === 'g2b-forced-meta')?.defId === 'slayer_brutality',
        'the copy is not attached to Brutality')
    })
    await page.close()
  }
  check('no page errors', () => assert(pageErrors.length === 0, pageErrors.join('\n')))
} finally {
  await browser.close()
  await server.close()
}
report('slayer powers browser')
