// Slayer Pack discard and orbs choices in the rendered client, desktop and horizontal phone:
// Heel Hook's draw-or-discard for the chosen player (and the wait shown to the
// others), Creative AI+'s Orb picks, Master Reality+'s optional Retain in the
// discard step, Magnetism+'s Start-of-Turn return, and Aggregate's ordered
// Evokes through the existing Orb picker; then, online, the ally's private
// answer to Heel Hook travels through the room server. Engine rules:
// verify-slayer-discard-and-orbs.mjs.
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, setTestUsername } from './lib/profile-browser.mjs'
import { createServer } from 'vite'
import { createRoomServer } from './room-server.mjs'
import { startRun } from './lib/rooms.mjs'
import { createRun } from '../src/game/run.ts'
import { createCombat, defaultStartTurnChoices, preparePlayerTurn, resolveStartPlayerTurn } from '../src/game/combat.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = resolve(root, 'artifacts/slayer-discard-and-orbs')
mkdirSync(out, { recursive: true })
const rooms = createRoomServer()
const roomOrigin = `http://127.0.0.1:${(await rooms.listen(0)).port}`
const server = await createServer({
  logLevel: 'silent',
  server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: roomOrigin }, '/ws': { target: roomOrigin, ws: true } } },
})
const browser = await chromium.launch({ headless: true })
const errors = []
const enemy = (uid, row, over = {}) => ({ uid, defId: 'jaw_worm', row, isBoss: false, hp: 40, maxHp: 40,
  block: 0, strength: 0, vulnerable: 0, weak: 0, poison: 0, goldReward: 0, cardReward: null,
  actionIndex: 0, abilityUsed: false, dead: false, ...over })
/** Waits for played-card flights to land, so nothing in motion covers a prompt when it is checked. */
async function settle(page) {
  await page.waitForFunction(() => !document.querySelector('.card-flight, .card-flight-effect'), undefined, { timeout: 20_000 })
  await page.waitForTimeout(250)
}
/**
 * A control or message is really readable: a real box (the prompt CSS shrinks a button-less
 * `.prompt` to a clipped 1x1 that Playwright still calls visible), inside the viewport, and
 * nothing painted over it at its centre or ends.
 */
async function assertReadable(locator, label, centreOnly = false) {
  await locator.waitFor()
  const box = await locator.evaluate((el, centreOnly) => {
    const r = el.getBoundingClientRect()
    // The visually-hidden prompt clips to inset(50%); decorative button shapes clip too, harmlessly.
    const clipped = getComputedStyle(el).clipPath.startsWith('inset(50%')
    const covered = (centreOnly ? [0.5] : [0.5, 0.15, 0.85]).map((fx) => document.elementFromPoint(r.left + r.width * fx, r.top + r.height / 2))
      .filter((hit) => !(hit && (hit === el || el.contains(hit))))
      .map((hit) => hit ? `${hit.tagName}.${String(hit.className)}` : 'nothing')
    return { width: r.width, height: r.height, left: r.left, top: r.top, right: r.right, bottom: r.bottom,
      viewportWidth: innerWidth, viewportHeight: innerHeight, clipped, covered }
  }, centreOnly)
  assert(box.width >= 20 && box.height >= 12 && !box.clipped, `${label} has a real, unclipped box: ${JSON.stringify(box)}`)
  assert(box.left >= 0 && box.top >= 0 && box.right <= box.viewportWidth && box.bottom <= box.viewportHeight,
    `${label} is inside the viewport: ${JSON.stringify(box)}`)
  assert.deepEqual(box.covered, [], `${label} is not covered`)
}
/** Nothing of this control overlaps an enemy, its intent or its tokens. */
async function assertClearOfEnemies(locator, label) {
  const overlaps = await locator.evaluate((el) => {
    const r = el.getBoundingClientRect()
    return [...document.querySelectorAll('.enemy, .enemy__intent')].flatMap((enemy) => {
      const e = enemy.getBoundingClientRect()
      return e.width > 0 && e.height > 0 && r.left < e.right && e.left < r.right && r.top < e.bottom && e.top < r.bottom
        ? [`${String(enemy.className)} ${JSON.stringify([e.left, e.top, e.right, e.bottom])}`] : []
    })
  })
  assert.deepEqual(overlaps, [], `${label} covers no enemy or intent`)
}
/** Every button of a docked choice is readable and clear of the enemies, as is its instruction. */
async function assertPromptReadable(region, label) {
  await assertReadable(region, label)
  await assertClearOfEnemies(region, label)
  await assertReadable(region.locator('.combat__power-hint'), `${label} instruction`)
  for (const button of await region.getByRole('button').all()) {
    await assertReadable(button, `${label} button "${await button.textContent()}"`)
  }
}
const origin = () => `http://127.0.0.1:${server.httpServer.address().port}`
const strikes = (prefix, n, defId = 'strike_ironclad') =>
  Array.from({ length: n }, (_unused, index) => ({ uid: `${prefix}${index}`, defId, upgraded: false }))
const stormBehindMagnetism = {
  relics: [], powers: [{ uid: 'st', defId: 'storm', upgraded: false }, { uid: 'mag', defId: 'slayer_magnetism', upgraded: true }],
  orbs: ['lightning', 'frost', 'dark'], discard: strikes('q', 2, 'strike_defect'), draw: strikes('r', 10, 'strike_defect'),
}
/** A Start-of-Turn Orb pick Storm already has answered is not asked again while Magnetism's choice is owed. */
async function assertStormPromptGone(page, label, owed) {
  assert.equal(await page.getByText(/choose an Orb to Evoke/).count(), 0, `${label}: no stale Orb prompt text`)
  assert.equal(await page.getByText('Choose an Orb', { exact: true }).count(), 0, `${label}: no Choose an Orb pill`)
  assert.equal(await page.getByRole('button', { name: /^Evoke \w+ Orb \d/ }).count(), 0, `${label}: Orbs are not offered`)
  assert.equal(await page.locator('.combat__power-hint', { hasText: 'Storm' }).count(), 0, `${label}: no Storm hint`)
  for (const button of await owed.getByRole('button').all()) {
    await assertReadable(button, `${label} Magnetism+ "${await button.textContent()}"`)
  }
}
try {
  await server.listen()
  for (const [name, width, height] of [['desktop', 1440, 900], ['phone-landscape', 844, 390]]) {
    const touch = name !== 'desktop'
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce', hasTouch: touch })
    page.on('pageerror', e => errors.push(String(e)))
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
    await page.goto(origin())
    await page.getByRole('button', { name: 'Single Player', exact: true }).click()
    await page.getByRole('button', { name: 'Standard', exact: true }).click()
    await page.getByRole('button', { name: 'Embark' }).click()
    await page.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
    await page.waitForFunction(() => window.__STS_DEBUG__?.getRun()?.phase === 'neow', undefined, { timeout: 90_000 })
    const viewerId = await page.evaluate(() => window.__STS_DEBUG__.getRun().players[0].id)
    const press = async (locator) => touch ? locator.tap() : locator.click()
    const combatOf = () => page.evaluate(() => window.__STS_DEBUG__.getRun().combat)
    async function load(character, setup, enemies = [enemy('e0', 0)], prepare = (combat) => combat) {
      const run = createRun(919, [
        { id: viewerId, name: 'Hero', character },
        { id: 'ally', name: 'Ally', character: 'ironclad' },
      ])
      let combat = createCombat({ seed: 919, calls: 0 }, run.players, enemies, `g2a-${name}-${Math.random()}`)
      Object.assign(combat.players[0], { hand: [], draw: [], discard: [], energy: 3 }, setup.viewer)
      Object.assign(combat.players[1], { hand: [], draw: [], discard: [] }, setup.ally ?? {})
      combat = prepare(combat)
      run.combat = combat
      run.phase = 'combat'
      run.neow = null
      await page.evaluate(() => {
        const debug = window.__STS_DEBUG__
        debug.setRun({ ...structuredClone(debug.getRun()), phase: 'map', combat: null })
      })
      await page.evaluate(run => window.__STS_DEBUG__.setRun(run), run)
      await page.waitForFunction(() => document.querySelector('.combat'))
      await page.waitForTimeout(900)
    }
    async function playCardNamed(pattern) {
      const card = page.getByRole('button', { name: pattern })
      if (touch) { await card.tap(); await card.tap() } else await card.click()
    }

    // Heel Hook: the caster chooses themselves, then answers privately.
    await load('silent', {
      viewer: { hand: [{ uid: 'hook', defId: 'slayer_heel_hook', upgraded: false }, ...strikes('s', 10, 'strike_silent')],
        draw: strikes('d', 3, 'strike_silent') },
    }, [enemy('e0', 0, { weak: 1 }), enemy('e1', 1)])
    await playCardNamed(/^Heel Hook,/)
    await page.locator('.enemy--targeted[data-enemy-id="e0"]').waitFor()
    await press(page.locator('.enemy--targeted[data-enemy-id="e0"] .enemy__hit-area'))
    await page.locator('button.seat--targetable.seat--viewer').waitFor()
    await press(page.locator('button.seat--targetable.seat--viewer'))
    const hookPrompt = page.getByRole('group', { name: 'Heel Hook choice' })
    await hookPrompt.waitFor()
    await settle(page)
    await assertPromptReadable(hookPrompt, `${name} Heel Hook choice`)
    assert.equal(await hookPrompt.getByRole('button').count(), 3, 'three thumb-sized choices whatever the hand size')
    assert.equal(await page.locator('button.combat__end-turn:not(:disabled)').count(), 0,
      'no End Turn can be pressed while the Heel Hook choice is open')
    await page.screenshot({ path: `${out}/${name}-heel-hook-choice.png` })
    // With a 10-card hand the private pick is one bounded, scrollable row in a modal.
    await press(hookPrompt.getByRole('button', { name: 'Discard a card', exact: true }))
    const picker = page.getByRole('dialog', { name: 'Heel Hook — discard a card' })
    await picker.waitFor()
    await settle(page)
    await assertReadable(picker.locator('.choice-modal__panel'), `${name} Heel Hook discard picker`)
    assert.equal(await picker.locator('.choice-modal__cards > .card').count(), 10, 'every card in hand is offered')
    const rowHeight = await picker.locator('.choice-modal__cards').evaluate((row) => row.getBoundingClientRect().height)
    const cardHeight = await picker.locator('.choice-modal__cards > .card').first().evaluate((card) => card.getBoundingClientRect().height)
    assert(rowHeight < cardHeight * 1.5, `the row does not wrap into several rows (${rowHeight} vs card ${cardHeight})`)
    await page.screenshot({ path: `${out}/${name}-heel-hook-discard-picker.png` })
    const last = picker.locator('.choice-modal__cards > .card').last()
    await last.scrollIntoViewIfNeeded()
    await assertReadable(last, `${name} the 10th card, scrolled into reach`, true)
    await page.screenshot({ path: `${out}/${name}-heel-hook-discard-picker-scrolled.png` })
    await press(last)
    await page.waitForFunction(() => !window.__STS_DEBUG__.getRun().combat.pendingPlayerChoices)
    let combat = await combatOf()
    assert.equal(combat.players[0].hand.length, 9, 'one card was discarded')
    assert.equal(combat.players[0].discard.at(-1).uid, 's9', 'the one picked from the end of the row')
    assert.equal(await page.getByRole('dialog').count(), 0, 'the picker closes')
    assert(await page.getByRole('button', { name: /^End turn/ }).isEnabled(), 'and End Turn is available again')
    assert.equal(combat.players[0].energy, 3, 'Heel Hook refunded its Energy')
    assert.equal(combat.enemies[0].hp, 38)

    // Heel Hook for an ally: the caster waits, the ally's seat answers.
    await load('silent', {
      viewer: { hand: [{ uid: 'hook', defId: 'slayer_heel_hook', upgraded: true }] },
      ally: { draw: strikes('a', 2) },
    }, [enemy('e0', 0, { weak: 1 })])
    await playCardNamed(/^Heel Hook\+,/)
    await press(page.locator('.enemy--targeted .enemy__hit-area').first())
    await page.locator('button.seat--targetable:not(.seat--viewer)').waitFor()
    await press(page.locator('button.seat--targetable:not(.seat--viewer)'))
    await settle(page)
    const waiting = page.getByRole('status').filter({ hasText: 'Waiting for Ally — Heel Hook+' })
    await assertReadable(waiting, `${name} Heel Hook waiting status`)
    await assertClearOfEnemies(waiting, `${name} Heel Hook waiting status`)
    assert.equal(await page.locator('button.combat__end-turn:not(:disabled)').count(), 0,
      "hot-seat: the caster cannot end the turn while the ally's choice is open")
    await page.screenshot({ path: `${out}/${name}-heel-hook-waiting.png` })
    await page.evaluate(() => window.__STS_DEBUG__.setViewer('ally'))
    const allyPrompt = page.getByRole('group', { name: 'Heel Hook+ choice' })
    await allyPrompt.waitFor()
    await settle(page)
    await assertPromptReadable(allyPrompt, `${name} Heel Hook+ ally choice`)
    await page.screenshot({ path: `${out}/${name}-heel-hook-ally.png` })
    await press(allyPrompt.getByRole('button', { name: 'Draw a card', exact: true }))
    await page.waitForFunction(() => !window.__STS_DEBUG__.getRun().combat.pendingPlayerChoices)
    combat = await combatOf()
    assert.equal(combat.players[1].hand.length, 1, 'the ally drew')
    assert.equal(combat.enemies[0].hp, 37, 'Heel Hook+ hits for 3')
    await page.evaluate((id) => window.__STS_DEBUG__.setViewer(id), viewerId)

    // An owed Heel Hook arriving while a native modal (Distilled Chaos pick, Golden Eye Scry) is
    // open: the modal steps aside so the choice is clickable, and returns once it is answered.
    for (const [label, pendingKey, pending, dialogName] of [
      ['Distilled Chaos', 'pendingDistilled', { playerId: viewerId, cards: strikes('dc', 2) }, 'Distilled Chaos'],
      ['Golden Eye Scry', 'pendingRelicScry', { id: 1, playerId: viewerId, relicIndex: 0, cards: strikes('ge', 2) }, /Golden Eye/],
    ]) {
      await load('silent', { viewer: { hand: strikes('h', 2, 'strike_silent'), draw: strikes('d', 3, 'strike_silent') } },
        [enemy('e0', 0)], (combat) => ({ ...combat, [pendingKey]: pending }))
      const modal = page.getByRole('dialog', { name: dialogName })
      await modal.waitFor()
      assert(await modal.evaluate((el) => el.open && el.matches(':modal')), `${name} ${label} modal is open first`)
      await page.evaluate((choice) => {
        const debug = window.__STS_DEBUG__
        const run = structuredClone(debug.getRun())
        run.combat.pendingPlayerChoices = [choice]
        run.combat.nextPlayerChoiceId = choice.id + 1
        debug.setRun(run)
      }, { id: 1, playerId: viewerId, sourceLabel: 'Heel Hook', kind: 'drawOrDiscard' })
      const owed = page.getByRole('group', { name: 'Heel Hook choice' })
      await owed.waitFor()
      await settle(page)
      await assertReadable(owed.getByRole('button', { name: 'Draw a card', exact: true }), `${name} ${label}: owed choice reachable`, true)
      assert.equal(await page.locator('dialog:modal').count(), 0, `${name} ${label}: no modal blocks the owed choice`)
      await press(owed.getByRole('button', { name: 'Draw a card', exact: true }))
      await page.waitForFunction(() => !window.__STS_DEBUG__.getRun().combat.pendingPlayerChoices)
      await page.waitForFunction(() => document.querySelector('dialog.distilled-choice:modal'))
      assert.deepEqual((await combatOf())[pendingKey].cards?.map((card) => card.uid), pending.cards.map((card) => card.uid),
        `${name} ${label}: its cards were kept`)
    }

    // Creative AI+: pick two Orbs, return the top two discards.
    await load('defect', {
      viewer: { powers: [{ uid: 'ai', defId: 'slayer_creative_ai', upgraded: true }],
        orbs: ['lightning', 'frost', 'dark'], discard: strikes('c', 3, 'strike_defect') },
    })
    await press(page.getByRole('button', { name: 'Use Creative AI+', exact: true }))
    await page.getByText(/Creative AI\+ — choose Orbs to remove/).waitFor()
    const lightning = page.getByRole('button', { name: 'Remove lightning Orb 1', exact: true })
    await press(lightning)
    await press(page.getByRole('button', { name: 'Remove dark Orb 3', exact: true }))
    assert.equal(await lightning.getAttribute('aria-pressed'), 'true', 'a picked Orb reads as pressed')
    await settle(page)
    await assertReadable(page.getByText('Tap Orbs to remove', { exact: true }), `${name} Creative AI+ instruction`)
    await assertReadable(page.getByRole('button', { name: 'Return 2 cards', exact: true }), `${name} Creative AI+ confirm`)
    await assertClearOfEnemies(page.getByText('Tap Orbs to remove', { exact: true }), `${name} Creative AI+ instruction`)
    await assertClearOfEnemies(page.getByRole('button', { name: 'Return 2 cards', exact: true }), `${name} Creative AI+ confirm`)
    for (const orb of ['lightning Orb 1', 'frost Orb 2', 'dark Orb 3']) {
      await assertReadable(page.getByRole('button', { name: `Remove ${orb}`, exact: true }), `${name} Creative AI+ ${orb}`, true)
    }
    await page.screenshot({ path: `${out}/${name}-creative-ai.png` })
    await press(page.getByRole('button', { name: 'Return 2 cards', exact: true }))
    await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.players[0].hand.length === 2)
    combat = await combatOf()
    assert.deepEqual(combat.players[0].orbs, [null, 'frost', null])
    assert.deepEqual(combat.players[0].hand.map((card) => card.uid), ['c2', 'c1'])
    assert.equal(await page.getByRole('button', { name: 'Creative AI+ used', exact: true }).count(), 1)

    // Master Reality+: return a card, then keep it in the discard step.
    await load('watcher', {
      viewer: { powers: [{ uid: 'mr', defId: 'slayer_master_reality', upgraded: true }],
        discard: [{ uid: 'back', defId: 'eruption', upgraded: false }], hand: strikes('h', 1, 'strike_watcher'),
        draw: strikes('w', 10, 'strike_watcher') },
    })
    await press(page.getByRole('button', { name: 'Use Master Reality+', exact: true }))
    await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.players[0].hand.some((card) => card.uid === 'back'))
    await press(page.getByRole('button', { name: /^End turn/ }))
    const retain = page.getByRole('button', { name: 'Retain Eruption', exact: true })
    await retain.waitFor()
    await settle(page)
    await assertReadable(retain, `${name} Master Reality+ Retain`)
    await press(retain)
    await assertReadable(page.getByRole('button', { name: '✓ Retain Eruption', exact: true }), `${name} Master Reality+ Retained`)
    await assertReadable(page.getByRole('button', { name: /^Confirm end-turn effect/ }), `${name} discard confirm`)
    await page.screenshot({ path: `${out}/${name}-master-reality-retain.png` })
    await press(page.getByRole('button', { name: /^Confirm end-turn effect/ }))
    await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.phase !== 'discard')
    combat = await combatOf()
    assert(combat.players[0].hand.some((card) => card.uid === 'back'), 'Eruption was Retained')
    assert(!combat.players[0].hand.some((card) => card.uid === 'h0'), 'the Strike was discarded')

    // Magnetism+: the paused Start of Turn asks how many cards to return.
    await load('ironclad', {
      viewer: { powers: [{ uid: 'mag', defId: 'slayer_magnetism', upgraded: true }],
        discard: [{ uid: 'low', defId: 'bash', upgraded: false }, { uid: 'top', defId: 'defend_ironclad', upgraded: false }],
        draw: strikes('m', 10) },
      ally: { draw: strikes('n', 10) },
    }, [enemy('e0', 0)], (combat) => {
      const prepared = preparePlayerTurn(combat)
      return resolveStartPlayerTurn(prepared, defaultStartTurnChoices(prepared))
    })
    const magnet = page.getByRole('group', { name: /Magnetism\+ choice$/ })
    await magnet.waitFor()
    await settle(page)
    await assertPromptReadable(magnet, `${name} Magnetism+ choice`)
    await page.screenshot({ path: `${out}/${name}-magnetism.png` })
    assert.equal(await magnet.getByRole('button').count(), 3, 'return 1, return 2, or nothing')
    assert(await magnet.locator('.combat__power-hint').evaluate((hint) => hint.scrollWidth <= hint.clientWidth + 1),
      'the cards on offer are named in full, not cut off')
    await press(magnet.getByRole('button', { name: 'Return Defend and Bash', exact: true }))
    assert.equal(await page.getByRole('button', { name: /^Resolve start/ }).count(), 0,
      'no start-of-turn confirmation competes with the open choice')
    await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.phase === 'player')
    combat = await combatOf()
    assert.deepEqual(combat.players[0].hand.slice(-2).map((card) => card.uid), ['top', 'low'])

    // Magnetism+ pauses the order after Storm's Evoke was already picked: the answered Orb prompt
    // must not come back over (or beside) the owed Take buttons.
    await load('defect', { viewer: stormBehindMagnetism }, [enemy('e0', 0), enemy('e1', 1)], (c) => preparePlayerTurn(c))
    await press(page.getByRole('button', { name: "Move Hero's Magnetism+ earlier", exact: true }))
    await page.getByText(/Storm — choose an Orb to Evoke/).waitFor()
    await press(page.getByRole('button', { name: 'Evoke lightning Orb 1', exact: true }))
    await page.getByText(/Storm — choose a target for the Evoked Orb/).waitFor()
    // The open order list covers the right-hand enemies on a phone; fold it away to aim.
    await page.locator('.start-turn-order > summary').click()
    await press(page.locator('.enemy[data-enemy-id="e1"] .enemy__hit-area'))
    await press(page.getByRole('button', { name: /^Resolve start/ }))
    const owed = page.getByRole('group', { name: /Magnetism\+ choice$/ })
    await owed.waitFor()
    await settle(page)
    combat = await combatOf()
    assert.deepEqual(combat.startTurnProgress?.choices.map((c) => [c.evokeSlots, c.evokeEnemyUids]), [[[0], ['e1']]],
      'the engine holds the answered Storm pick')
    await assertStormPromptGone(page, `${name} solo`, owed)
    await page.screenshot({ path: `${out}/${name}-magnetism-after-storm.png` })
    await press(owed.getByRole('button', { name: 'Return nothing', exact: true }))
    await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.phase === 'player')
    combat = await combatOf()
    assert.equal(combat.enemies.find((foe) => foe.uid === 'e1').hp, 38, "Storm's saved Evoke still hit the chosen enemy")
    assert.deepEqual(combat.players[0].orbs, ['lightning', 'frost', 'dark'].map((orb, slot) => slot === 0 ? 'lightning' : orb),
      'the Evoked slot was refilled by Storm')

    // Biased Cognition's Power row describes its signed modifiers for assistive technology.
    await load('defect', { viewer: { powers: [{ uid: 'bias', defId: 'slayer_biased_cognition', upgraded: false }] } })
    assert(await page.locator('[aria-label*="Orb end-of-turn effects get -1"]').count() > 0,
      'the Power row reads "-1"')
    assert.equal(await page.locator('[aria-label*="+-"]').count(), 0, 'never "+-1"')

    // Creative AI: one tap on an Orb removes it and returns the topmost card.
    await load('defect', {
      viewer: { powers: [{ uid: 'ai', defId: 'slayer_creative_ai', upgraded: false }],
        orbs: ['lightning', 'frost', null], discard: strikes('b', 2, 'strike_defect') },
    })
    await press(page.getByRole('button', { name: 'Use Creative AI', exact: true }))
    await page.getByText('Creative AI — choose an Orb to remove').waitFor()
    await settle(page)
    await assertReadable(page.getByText('Tap an Orb to remove', { exact: true }), `${name} Creative AI instruction`)
    await assertClearOfEnemies(page.getByText('Tap an Orb to remove', { exact: true }), `${name} Creative AI instruction`)
    for (const orb of ['lightning Orb 1', 'frost Orb 2']) {
      await assertReadable(page.getByRole('button', { name: `Remove ${orb}`, exact: true }), `${name} Creative AI ${orb}`, true)
    }
    await page.screenshot({ path: `${out}/${name}-creative-ai-base.png` })
    await press(page.getByRole('button', { name: 'Remove frost Orb 2', exact: true }))
    await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.players[0].hand.length === 1)
    combat = await combatOf()
    assert.deepEqual(combat.players[0].orbs, ['lightning', null, null])
    assert.deepEqual(combat.players[0].hand.map((card) => card.uid), ['b1'])

    // Aggregate: every Orb in the chosen order, each Lightning application aimed.
    await load('defect', {
      viewer: { hand: [{ uid: 'agg', defId: 'slayer_aggregate', upgraded: false }], orbs: ['lightning', 'frost', null] },
    }, [enemy('e0', 0), enemy('e1', 1)])
    await playCardNamed(/^Aggregate,/)
    await settle(page)
    await assertReadable(page.getByRole('button', { name: 'Evoke lightning Orb 1', exact: true }), `${name} Aggregate Lightning Orb`, true)
    await page.screenshot({ path: `${out}/${name}-aggregate-orbs.png` })
    await press(page.getByRole('button', { name: 'Evoke lightning Orb 1', exact: true }))
    await page.getByText('Choose an enemy for this evoke').waitFor()
    await settle(page)
    await page.screenshot({ path: `${out}/${name}-aggregate.png` })
    await press(page.locator('.enemy[data-enemy-id="e0"] .enemy__hit-area'))
    await press(page.locator('.enemy[data-enemy-id="e1"] .enemy__hit-area'))
    const frost = page.getByRole('button', { name: 'Evoke frost Orb 2', exact: true })
    if (await frost.count()) await press(frost)
    await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.players[0].hand.length === 0)
    combat = await combatOf()
    assert.deepEqual(combat.enemies.map((foe) => foe.hp), [38, 38], 'each Lightning application took its own target')
    assert.equal(combat.players[0].block, 2, 'Frost Evoked twice')
    assert.deepEqual(combat.players[0].orbs, [null, null, null])
    await page.close()
  }

  // Online: Ann (desktop) aims Heel Hook's choice at Bo (horizontal phone); only Bo is asked.
  async function enterOnline(page, name, character, code) {
    await page.goto(origin(), { waitUntil: 'networkidle' })
    await setTestUsername(page, name)
    await page.getByRole('button', { name: 'Play online' }).click()
    await page.locator('.online-character-roster').getByRole('button', { name: character }).click()
    if (code) {
      await page.getByLabel('Room code').fill(code)
      await page.getByRole('button', { name: 'Join', exact: true }).click()
    } else await page.getByRole('button', { name: 'Create room' }).click()
    await page.locator('.online-lobby').waitFor()
  }
  const annPage = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
  const boPage = await (await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true })).newPage()
  for (const page of [annPage, boPage]) {
    page.on('pageerror', e => errors.push(String(e)))
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  }
  await enterOnline(annPage, 'Ann', 'Silent')
  const code = await annPage.locator('.online-lobby h1').textContent()
  await enterOnline(boPage, 'Bo', 'Ironclad', code)
  await annPage.locator('.online-seat', { hasText: 'Bo' }).waitFor()
  const room = rooms.store.rooms.get(code)
  startRun(room, room.seats[0].token, { seed: 921 })
  const [annId, boId] = room.seats.map((seat) => seat.playerId)
  room.run.combat = createCombat({ seed: 921, calls: 0 }, room.run.players, [enemy('e0', 0, { weak: 1 })], 'g2a-online')
  for (const player of room.run.combat.players) Object.assign(player, { relics: [], powers: [], hand: [], draw: [], discard: [] })
  Object.assign(room.run.combat.players.find((player) => player.id === annId), {
    hand: [{ uid: 'online-hook', defId: 'slayer_heel_hook', upgraded: false }, ...strikes('ann', 1, 'strike_silent')],
  })
  Object.assign(room.run.combat.players.find((player) => player.id === boId), { hand: strikes('bo', 2) })
  room.run.phase = 'combat'
  room.run.neow = null
  room.version += 1
  rooms.publishRoom(code)
  await annPage.getByRole('button', { name: /^Heel Hook,/ }).click()
  await annPage.locator('.enemy--targeted .enemy__hit-area').first().click()
  await annPage.locator('button.seat--targetable:not(.seat--viewer)').click()
  const boPrompt = boPage.getByRole('group', { name: 'Heel Hook choice' })
  await boPrompt.waitFor()
  await settle(boPage)
  await assertPromptReadable(boPrompt, 'online phone Heel Hook choice')
  await boPage.screenshot({ path: `${out}/online-phone-heel-hook-ally.png` })
  assert(await boPrompt.getByRole('button', { name: 'Draw a card' }).isDisabled(), 'Bo has nothing to draw')
  assert.equal(await annPage.getByRole('group', { name: 'Heel Hook choice' }).count(), 0, "Ann is never shown Bo's choice")
  assert.equal(await annPage.getByText(/^Waiting for Bo/).count(), 0, 'and is not held up during the shared Player Turn')
  await boPrompt.getByRole('button', { name: 'Discard a card' }).tap()
  const boPicker = boPage.getByRole('dialog', { name: 'Heel Hook — discard a card' })
  await boPicker.waitFor()
  await boPicker.locator('.choice-modal__cards > .card').first().tap()
  for (let tries = 0; tries < 100 && room.run.combat.pendingPlayerChoices; tries++) await boPage.waitForTimeout(100)
  const bo = room.run.combat.players.find((player) => player.id === boId)
  assert.equal(room.run.combat.pendingPlayerChoices, undefined, "Bo's answer reached the server")
  assert.equal(bo.hand.length, 1)
  assert.equal(bo.discard.at(-1).uid, 'bo0')
  await boPrompt.waitFor({ state: 'detached' })

  // Online: Magnetism+ pauses after Storm's Evoke was picked; the saved pick comes back with the
  // snapshot, so the Orb prompt is not asked again. A solo Defect seat on each screen class.
  for (const [label, viewport, touch] of [['desktop', { width: 1440, height: 900 }, false],
    ['phone', { width: 844, height: 390 }, true]]) {
    const page = await (await browser.newContext({ viewport, hasTouch: touch })).newPage()
    page.on('pageerror', e => errors.push(String(e)))
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
    const press = (locator) => touch ? locator.tap() : locator.click()
    await enterOnline(page, `Dee${label}`, 'Defect')
    const stormCode = await page.locator('.online-lobby h1').textContent()
    const stormRoom = rooms.store.rooms.get(stormCode)
    startRun(stormRoom, stormRoom.seats[0].token, { seed: 923 })
    const players = stormRoom.run.players.map((player) => ({ ...structuredClone(player), hand: [], draw: [], ...stormBehindMagnetism }))
    const prepared = createCombat({ seed: 923, calls: 0 }, players, [enemy('e0', 0), enemy('e1', 1)], `g2a-storm-${label}`)
    stormRoom.run = { ...stormRoom.run, phase: 'combat', neow: null, combat: preparePlayerTurn(prepared) }
    for (const key of ['startTurnCombatId', 'startTurnOrder', 'startTurnEnemyTargets', 'startTurnChoices',
      'startTurnRequired', 'startTurnReady', 'startTurnStagedTriggers', 'startTurnPostRollLock', 'startTurnAutoReady']) {
      stormRoom[key] = undefined
    }
    stormRoom.version += 1
    rooms.publishRoom(stormCode)
    await press(page.getByRole('button', { name: /^Move .*Magnetism\+ earlier$/ }))
    await page.getByText(/Storm — choose an Orb to Evoke/).waitFor()
    await press(page.getByRole('button', { name: 'Evoke lightning Orb 1', exact: true }))
    await page.getByText(/Storm — choose a target for the Evoked Orb/).waitFor()
    await page.locator('.start-turn-order > summary').click()
    await press(page.locator('.enemy[data-enemy-id="e1"] .enemy__hit-area'))
    await press(page.getByRole('button', { name: /^Resolve start/ }))
    const owed = page.getByRole('group', { name: /Magnetism\+ choice$/ })
    await owed.waitFor()
    await settle(page)
    assert.deepEqual(stormRoom.run.combat.startTurnProgress?.choices.map((c) => [c.evokeSlots, c.evokeEnemyUids]),
      [[[0], ['e1']]], 'the server holds the answered Storm pick')
    await assertStormPromptGone(page, `online ${label}`, owed)
    await page.screenshot({ path: `${out}/online-${label}-magnetism-after-storm.png` })
    await press(owed.getByRole('button', { name: 'Return nothing', exact: true }))
    for (let tries = 0; tries < 100 && stormRoom.run.combat.phase !== 'player'; tries++) await page.waitForTimeout(100)
    assert.equal(stormRoom.run.combat.phase, 'player')
    assert.equal(stormRoom.run.combat.enemies.find((foe) => foe.uid === 'e1').hp, 38, "Storm's saved Evoke hit the chosen enemy")
  }

  assert.deepEqual(errors, [])
  console.log('Slayer discard and orbs browser checks passed on desktop and horizontal phone, local and online.')
} finally {
  await browser.close()
  await server.close()
  await rooms.close()
}
