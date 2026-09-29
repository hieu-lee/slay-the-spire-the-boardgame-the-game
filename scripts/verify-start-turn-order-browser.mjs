// The start-of-turn and before-draw Scry order panels: open without asking,
// readable (art, owner, pending choice), reorderable with full-size buttons,
// and clear of the hand and resolve button on desktop and horizontal phones
// (and of the enemies on desktop). Screenshots land in artifacts/start-turn-order/.
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { chromium } from './lib/profile-browser.mjs'
import { createServer } from 'vite'
import { createRun } from '../src/game/run.ts'
import { createCombat } from '../src/game/combat.ts'

const out = 'artifacts/start-turn-order'
mkdirSync(out, { recursive: true })
const server = await createServer({ logLevel: 'silent', server: { port: 0 } })
const browser = await chromium.launch({ headless: true })
const errors = []
const c = (uid, defId, upgraded = false) => ({ uid, defId, upgraded })
const hand = (prefix) => ['strike_silent', 'defend_silent', 'neutralize', 'survivor', 'strike_silent']
  .map((defId, index) => c(`${prefix}-hand-${index}`, defId))
try {
  await server.listen()
  for (const [name, width, height] of [
    ['desktop', 1440, 900], ['desktop-1080', 1920, 1080], ['desktop-compact', 1280, 800],
    ['desktop-laptop', 1536, 730],
    ['phone-landscape', 844, 390], ['phone-small', 667, 375],
  ]) {
    const phone = name.startsWith('phone')
    // Short screens fold the list while aiming and when nothing is owed; the enemies need the room.
    const compact = height <= 850
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce', hasTouch: phone })
    page.on('pageerror', e => errors.push(String(e)))
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
    await page.goto(`http://localhost:${server.httpServer.address().port}`)
    await page.getByRole('button', { name: 'Single Player', exact: true }).click()
    await page.getByRole('button', { name: 'Standard', exact: true }).click()
    await page.getByRole('button', { name: 'Embark' }).click()
    await page.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
    await page.waitForFunction(() => window.__STS_DEBUG__?.getRun()?.phase === 'neow')
    const viewerId = await page.evaluate(() => window.__STS_DEBUG__.getRun().players[0].id)
    let fixtureId = 0
    async function load({ phase = 'start', character = 'silent', player = {}, teammate } = {}) {
      await page.waitForFunction(() => !document.querySelector('.card-flight-effect'))
      const run = createRun(517, [{ id: viewerId, name: 'Silent', character },
        ...(teammate ? [{ id: 'mate', name: 'Mate', character: 'defect' }] : [])])
      const enemy = { uid: 'e0', defId: 'jaw_worm', row: 0, isBoss: false, hp: 30, maxHp: 30,
        block: 0, strength: 0, vulnerable: 0, weak: 0, poison: 0, goldReward: 0, cardReward: null,
        actionIndex: 0, abilityUsed: true, dead: false }
      const combatId = `start-order-${name}-${fixtureId++}`
      run.combat = createCombat({ seed: 517, calls: 0 }, run.players, [enemy, { ...enemy, uid: 'e1', row: 1 }], combatId)
      Object.assign(run.combat.players[0], {
        hand: hand('viewer'), draw: [], discard: [], exhaust: [], powers: [], relics: [], potions: [], ...player,
      })
      if (teammate) Object.assign(run.combat.players[1], {
        hand: [], draw: [], discard: [], exhaust: [], powers: [], relics: [], potions: [], ...teammate,
      })
      Object.assign(run.combat, { combatId, phase, die: 1, turn: phase === 'start' ? 2 : 1,
        startTurnStage: phase === 'start' ? 'effects' : undefined, startTurnProgress: undefined,
        endTurnProgress: undefined, pendingTriggers: [], presentationEvents: [], powerTriggersUsedThisTurn: [] })
      run.phase = 'combat'
      run.neow = null
      await page.evaluate(run => window.__STS_DEBUG__.setRun(run), run)
      await page.waitForFunction(id => window.__STS_DEBUG__.getRun().combat?.combatId === id, combatId)
      await page.locator('[data-enemy-id="e1"]').waitFor()
    }
    const panel = page.locator('.start-turn-order')
    const names = () => panel.locator('.start-turn-order__name').allTextContents()
    const settle = () => page.evaluate(() => Promise.all(document.getAnimations().map((animation) =>
      animation.effect?.getTiming().iterations === Infinity ? null : animation.finished.catch(() => null))))
    // The panel must fit the viewport (a long list scrolls inside it) and leave
    // the hand, the enemies and the resolve button uncovered.
    async function layout() {
      return panel.evaluate((element) => {
        const box = element.getBoundingClientRect()
        const overlaps = (other) => other.width > 0 && box.left < other.right && box.right > other.left &&
          box.top < other.bottom && box.bottom > other.top
        const rects = (selector) => [...document.querySelectorAll(selector)].map((node) => node.getBoundingClientRect())
        const buttons = [...element.querySelectorAll('.start-turn-order__moves button')]
        return {
          inViewport: box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight,
          fontSize: parseFloat(getComputedStyle(element.querySelector('.start-turn-order__name')).fontSize),
          smallestButton: Math.min(...buttons.map((button) => Math.min(button.offsetWidth, button.offsetHeight))),
          coversHand: rects('.hand .card').some(overlaps),
          coversEnemy: rects('[data-enemy-id] .enemy__hit-area').some(overlaps),
          coversResolve: rects('.combat__end-turn').some(overlaps),
        }
      })
    }
    function assertLayout(result, scene) {
      assert(result.inViewport, `${name} ${scene}: the order panel leaves the viewport`)
      assert(result.fontSize >= 13, `${name} ${scene}: step text is too small (${result.fontSize}px)`)
      assert(result.smallestButton >= 40, `${name} ${scene}: move buttons are small touch targets (${result.smallestButton}px)`)
      assert(!result.coversHand, `${name} ${scene}: the order panel covers the hand`)
      assert(!result.coversResolve, `${name} ${scene}: the order panel covers the resolve button`)
      if (!compact) assert(!result.coversEnemy, `${name} ${scene}: the order panel covers an enemy`)
    }

    // Solo: a relic and three Powers, one of which still needs a target.
    await load({ player: {
      relics: [{ defId: 'coffee_dripper', spent: false }],
      powers: [c('demon', 'demon_form'), c('blades', 'infinite_blades', true), c('fumes', 'noxious_fumes')],
    } })
    await panel.waitFor()
    await settle()
    const list = panel.locator('ol[aria-label="Start-of-turn order"]')
    assert.equal(await panel.getAttribute('open'), '', `${name}: the start-of-turn order must start open`)
    assert.deepEqual(await names(), ['Coffee Dripper', 'Demon Form', 'Infinite Blades+', 'Noxious Fumes'])
    assert.deepEqual(await panel.locator('.start-turn-order__index').allTextContents(), ['1', '2', '3', '4'])
    assert.equal(await panel.locator('.start-turn-order__art img').count(), 4, `${name}: a step has no relic or Power art`)
    assert.match(await panel.locator('li').first().locator('img').getAttribute('src'), /coffee_dripper/)
    assert.equal(await panel.locator('.start-turn-order__owner').count(), 0, `${name}: a solo list names its owner`)
    assert.deepEqual(await panel.locator('.start-turn-order__badge').allTextContents(), ['Choose target'])
    assert.match(await panel.locator('.start-turn-order__hint').textContent(), /top to bottom/)
    assert(await list.isVisible(), `${name}: the order list is hidden`)
    await page.screenshot({ path: `${out}/${name}-solo-target-pending.png` })
    assertLayout(await layout(), 'solo target pending')
    // Tap-to-arm, then tap the enemy: the same path a touch player takes. Once
    // Noxious Fumes is picked up, the list folds to its heading so every enemy
    // is visible and reachable.
    await page.locator('.start-turn-effects .end-turn-effect--card').click()
    assert.equal(await list.isVisible(), false, `${name}: the order list stays open while aiming`)
    assert(await panel.locator('summary').isVisible(), `${name}: the order heading is hidden while aiming`)
    await page.screenshot({ path: `${out}/${name}-solo-aiming.png` })
    await page.locator('[data-enemy-id="e1"] .enemy__head').click()
    await page.locator('.start-turn-effects').waitFor({ state: 'detached' })
    assert(await list.isVisible(), `${name}: the order list is hidden once targets are chosen`)
    assert.deepEqual(await panel.locator('.start-turn-order__badge--done').allTextContents(), ['Target set'])
    await settle()
    await page.screenshot({ path: `${out}/${name}-solo.png` })
    assertLayout(await layout(), 'solo')

    await page.getByRole('button', { name: "Move Silent's Infinite Blades+ earlier", exact: true }).click()
    await page.getByRole('button', { name: "Move Silent's Coffee Dripper later", exact: true }).click()
    assert.deepEqual(await names(), ['Infinite Blades+', 'Coffee Dripper', 'Demon Form', 'Noxious Fumes'])
    assert(await page.getByRole('button', { name: "Move Silent's Infinite Blades+ earlier", exact: true }).isDisabled())
    assert(await page.getByRole('button', { name: "Move Silent's Noxious Fumes later", exact: true }).isDisabled())
    await page.screenshot({ path: `${out}/${name}-solo-reordered.png` })
    // Reordering re-plans the turn, so Noxious Fumes asks for its target again.
    await page.locator('.start-turn-effects').waitFor()
    await page.locator('.start-turn-effects .end-turn-effect--card').click()
    await page.locator('[data-enemy-id="e1"] .enemy__head').click()
    await page.locator('.start-turn-effects').waitFor({ state: 'detached' })
    await page.locator('.start-turn-order > summary').click()
    assert.equal(await panel.locator('ol').isVisible(), false, `${name}: the summary no longer collapses the panel`)
    await page.locator('.start-turn-order > summary').click()
    await page.getByRole('button', { name: 'Resolve start of turn', exact: true }).click()
    await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.phase === 'player')
    const solo = await page.evaluate(() => window.__STS_DEBUG__.getRun().combat)
    assert.deepEqual(solo.enemies.map((enemy) => enemy.poison), [0, 1], `${name}: Noxious Fumes poisoned the wrong enemy`)
    assert.equal(await panel.count(), 0, `${name}: the order panel outlived the start of turn`)

    // Local party: each step names its owner.
    await load({
      player: { relics: [{ defId: 'coffee_dripper', spent: false }], powers: [c('demon', 'demon_form')] },
      teammate: { relics: [{ defId: 'ectoplasm', spent: false }], powers: [c('mate-fumes', 'noxious_fumes')] },
    })
    await panel.waitFor()
    await settle()
    assert.deepEqual(await panel.locator('.start-turn-order__owner').allTextContents(), ['Silent', 'Silent', 'Mate', 'Mate'])
    assertLayout(await layout(), 'party')
    await page.screenshot({ path: `${out}/${name}-party.png` })

    // Nothing owed (Gambling Chip only opens a post-roll window): a short
    // screen starts the list folded, a tall one open.
    await load({ player: {
      relics: [{ defId: 'coffee_dripper', spent: false }, { defId: 'gambling_chip', spent: false }],
      powers: [c('demon', 'demon_form'), c('blades', 'infinite_blades', true)],
    } })
    await panel.waitFor()
    assert.equal(await panel.getAttribute('open'), compact ? null : '', `${name}: wrong initial fold with nothing owed`)
    await page.screenshot({ path: `${out}/${name}-nothing-owed.png` })

    // Worthy Sacrifice picks its Exhaust straight from the glowing hand.
    await load({ character: 'hexaghost', player: {
      hand: ['strike_hexaghost', 'defend_hexaghost', 'strike_hexaghost'].map((defId, index) => c(`ws-hand-${index}`, defId)),
      powers: [c('worthy', 'worthy_sacrifice')],
    } })
    await panel.waitFor()
    // Switching character replaces the deck; let its card morph clear the board.
    await page.locator('.card-morph').waitFor({ state: 'hidden' })
    await settle()
    assert.deepEqual(await panel.locator('.start-turn-order__badge').allTextContents(), ['Choose a card to Exhaust'])
    assert.equal(await page.locator('.hand .card.card--load-choice').count(), 3, `${name}: the hand does not offer its Exhaust choice`)
    assertLayout(await layout(), 'worthy sacrifice')
    await page.screenshot({ path: `${out}/${name}-exhaust-choice.png` })
    // A pick can be changed by tapping another card.
    await page.locator('.hand .card').nth(0).click()
    assert.match(await page.locator('.hand .card').nth(0).getAttribute('class'), /card--picked/)
    assert.equal(await page.locator('.hand .card.card--load-choice').count(), 0, `${name}: a set Exhaust still reads as owed`)
    assert.equal(await page.locator('.hand .card.card--exhaust-repick').count(), 2, `${name}: the other cards stop offering a re-pick`)
    await page.locator('.hand .card').nth(1).click()
    assert.deepEqual(await panel.locator('.start-turn-order__badge--done').allTextContents(), ['Exhaust set'])
    assert.equal(await page.locator('.hand .card.card--picked').count(), 1, `${name}: the chosen card is not marked alone`)
    assert.match(await page.locator('.hand .card').nth(1).getAttribute('class'), /card--picked/)
    await page.screenshot({ path: `${out}/${name}-exhaust-picked.png` })
    await page.getByRole('button', { name: 'Resolve start of turn', exact: true }).click()
    await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.phase === 'player')
    assert.deepEqual(await page.evaluate(() => window.__STS_DEBUG__.getRun().combat.players[0].exhaust.map((card) => card.uid)),
      ['ws-hand-1'], `${name}: Worthy Sacrifice exhausted the wrong card`)

    // A hot-seat teammate's Exhaust never shows their hand on this seat, and
    // even ordered first it does not hold up this seat's own pick: the start
    // of turn just waits until that player takes their seat.
    await load({ character: 'hexaghost', player: {
      hand: [c('own-hand-0', 'strike_hexaghost'), c('own-hand-1', 'defend_hexaghost')], powers: [c('own-worthy', 'worthy_sacrifice')],
    }, teammate: {
      hand: ['strike_hexaghost', 'defend_hexaghost', 'strike_hexaghost'].map((defId, index) => c(`mate-hand-${index}`, defId)),
      powers: [c('mate-worthy', 'worthy_sacrifice')],
    } })
    await panel.waitFor()
    await page.locator('.card-morph').waitFor({ state: 'hidden' })
    await settle()
    await page.getByRole('button', { name: "Mate's Worthy Sacrifice earlier", exact: false }).click()
    assert.deepEqual(await panel.locator('.start-turn-order__owner').allTextContents(), ['Mate', 'Silent'])
    assert.equal(await page.locator('.hand .card.card--load-choice').count(), 2, `${name}: a teammate's Exhaust holds up this seat's pick`)
    await page.locator('.hand .card').nth(0).click()
    assert.deepEqual(await panel.locator('.start-turn-order__badge').allTextContents(), ['Waiting for Mate', 'Exhaust set'],
      `${name}: wrong hot-seat Exhaust badges`)
    assert.equal(await page.locator('.hand .card.card--load-choice').count(), 0, `${name}: the viewer's hand offers a teammate's Exhaust`)
    assert.equal(await page.locator('.card').count(), 2, `${name}: a teammate's card appeared on this seat`)
    assert.equal(await page.locator('.combat > .prompt').textContent(), 'Waiting for Mate to choose a card to Exhaust')
    const resolve = page.getByRole('button', { name: 'Resolve start of turn', exact: true })
    assert(await resolve.isDisabled(), `${name}: the start of turn resolves without the teammate's Exhaust`)
    await page.screenshot({ path: `${out}/${name}-exhaust-teammate.png` })
    await page.evaluate(() => window.__STS_DEBUG__.setViewer('mate'))
    assert.equal(await page.locator('.hand .card.card--load-choice').count(), 3, `${name}: the teammate's own hand does not offer their Exhaust`)
    await page.locator('.hand .card').nth(1).click()
    await resolve.click()
    await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.phase === 'player')
    assert.deepEqual(await page.evaluate(() => window.__STS_DEBUG__.getRun().combat.players.map((player) =>
      player.exhaust.map((card) => card.uid))), [['own-hand-0'], ['mate-hand-1']], `${name}: a hot-seat Exhaust took the wrong card`)
    await page.evaluate((id) => window.__STS_DEBUG__.setViewer(id), viewerId)

    // Before-draw Scries share the treatment, with their source art recovered from the id.
    await load({ phase: 'roundEnd', character: 'watcher', player: {
      hand: [], block: 5,
      draw: Array.from({ length: 6 }, (_, index) => c(`scry-draw-${index}`, index % 2 ? 'defend_watcher' : 'strike_watcher')),
      powers: [c('foresight', 'foresight'), c('foresight-plus', 'foresight', true)],
    } })
    const scry = page.locator('.start-turn-order:has(ol[aria-label="Before-draw Scry order"])')
    await scry.waitFor()
    // A card morph (the old hand leaving) veils the board for a moment; shoot the settled panel.
    await page.locator('.card-morph').waitFor({ state: 'hidden' })
    await settle()
    assert.deepEqual(await names(), ['Foresight', 'Foresight+'])
    assert.equal(await scry.locator('.start-turn-order__art img').count(), 2, `${name}: a Scry step has no Power art`)
    assert.deepEqual(await scry.locator('.start-turn-order__badge').allTextContents(), ['Scry 3', 'Scry 4'])
    await page.screenshot({ path: `${out}/${name}-scry.png` })
    await page.getByRole('button', { name: "Move Silent's Foresight+ earlier", exact: true }).click()
    assert.deepEqual(await names(), ['Foresight+', 'Foresight'])
    await page.getByRole('button', { name: 'Confirm before-draw order', exact: true }).click()
    await page.getByRole('dialog', { name: /^Foresight\+? — Scry 4$/ }).waitFor()
    await page.close()
  }
  assert.deepEqual(errors, [])
  console.log('Start-turn order browser audit passed: open, readable, reorderable and clear of the board on desktop and horizontal phones.')
} finally {
  await browser.close()
  await server.close()
}
