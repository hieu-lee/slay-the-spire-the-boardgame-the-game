// The Slayer Pack play windows card-play windows in the real combat screen: Discovery,
// Enlightenment, Deceive Reality and Forethought+, on a desktop with the
// keyboard and on a landscape phone by touch. Screenshots go to
// artifacts/slayer-play-windows/.
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from './lib/profile-browser.mjs'
import { createServer } from 'vite'
import { createRun } from '../src/game/run.ts'
import { createCombat } from '../src/game/combat.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = resolve(root, 'artifacts/slayer-play-windows')
mkdirSync(out, { recursive: true })
const server = await createServer({ logLevel: 'silent', server: { port: 0 } })
const browser = await chromium.launch({ headless: true })
const errors = []

const enemy = (uid, row) => ({ uid, defId: 'jaw_worm', row, isBoss: false, hp: 100, maxHp: 100, block: 0,
  strength: 0, vulnerable: 0, weak: 0, poison: 0, goldReward: 0, cardReward: null, actionIndex: 0,
  abilityUsed: false, dead: false })
const card = (uid, defId, upgraded = false) => ({ uid, defId, upgraded })

try {
  await server.listen()
  for (const [screen, width, height] of [['desktop', 1440, 900], ['phone-landscape', 844, 390]]) {
    const touch = screen !== 'desktop'
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce', hasTouch: touch })
    page.on('pageerror', (error) => errors.push(`${screen}: ${error}`))
    page.on('console', (message) => { if (message.type() === 'error') errors.push(`${screen}: ${message.text()}`) })
    await page.goto(`http://localhost:${server.httpServer.address().port}`)
    await page.getByRole('button', { name: 'Single Player', exact: true }).click()
    await page.getByRole('button', { name: 'Standard', exact: true }).click()
    await page.getByRole('button', { name: 'Embark' }).click()
    await page.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
    await page.waitForFunction(() => window.__STS_DEBUG__?.getRun()?.phase === 'neow')
    const viewerId = await page.evaluate(() => window.__STS_DEBUG__.getRun().players[0].id)

    const load = async (name, character, piles, solo = false) => {
      const run = createRun(77, solo ? [{ id: viewerId, name: 'Hero', character }]
        : [{ id: viewerId, name: 'Hero', character }, { id: 'ally', name: 'Ally', character: 'silent' }])
      run.combat = createCombat({ seed: 77, calls: 0 }, run.players, [enemy('e0', 0), enemy('e1', 1)], `g1-${name}-${screen}`)
      run.combat.turn = 1
      Object.assign(run.combat.players[0], { energy: 3, ...piles })
      run.phase = 'combat'
      run.neow = null
      await page.evaluate((next) => window.__STS_DEBUG__.setRun(next), run)
      await page.waitForTimeout(900)
    }
    const handCard = (name) => page.locator('.hand').getByRole('button', { name: new RegExp(`^${name}\\b`) })
    const activate = async (name) => {
      const target = handCard(name).first()
      if (touch) { await target.tap(); await target.tap() } else { await target.focus(); await target.press('Enter') }
    }
    const pressButton = async (locator) => (touch ? locator.tap() : locator.click())
    const combat = () => page.evaluate(() => window.__STS_DEBUG__.getRun().combat)
    const hero = async () => (await combat()).players[0]
    // Card flights and their effects settle before a screenshot, so the shot shows the board at rest.
    const settleMotion = async () => {
      await page.waitForFunction(() => document.querySelectorAll('.card-flight, .card-flight-effect').length === 0)
      await page.waitForTimeout(400)
    }
    // The window's instruction is a real, readable banner: sized, on screen, and not covered.
    const assertBanner = async (text) => {
      const banner = page.locator('.prompt--play-window')
      await banner.getByText(text).waitFor()
      const box = await banner.boundingBox()
      assert(box && box.width > 120 && box.height > 18, `${screen}: the window prompt is visible (${JSON.stringify(box)})`)
      assert(box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height,
        `${screen}: the window prompt is on screen`)
      const uncovered = await banner.evaluate((element) => {
        const rect = element.getBoundingClientRect()
        return [[0.5, 0.5], [0.15, 0.5], [0.85, 0.5]].every(([x, y]) => {
          const hit = document.elementFromPoint(rect.left + rect.width * x, rect.top + rect.height * y)
          return hit !== null && element.contains(hit)
        })
      })
      assert(uncovered, `${screen}: nothing covers the window prompt`)
      // Every play needs the enemies' intents in view, so the banner never sits over one.
      const intents = await page.locator('.enemy__intent, .intent').evaluateAll((elements) => elements
        .map((element) => element.getBoundingClientRect())
        .filter((rect) => rect.width > 0 && rect.height > 0)
        .map((rect) => ({ x: rect.left, y: rect.top, width: rect.width, height: rect.height })))
      assert(intents.length > 0, `${screen}: enemy intents are on the board`)
      const overlapping = intents.filter((rect) => rect.x < box.x + box.width && box.x < rect.x + rect.width &&
        rect.y < box.y + box.height && box.y < rect.y + rect.height)
      assert.deepEqual(overlapping, [], `${screen}: the window prompt ${JSON.stringify(box)} covers no enemy intent`)
      // Nor the turn label or the End turn button it shares the top row with on a phone.
      for (const selector of ['.combat__turn', '.combat__phase', '.combat__end-turn']) {
        for (const rect of await page.locator(selector).evaluateAll((elements) => elements.map((element) => {
          const bounds = element.getBoundingClientRect()
          return { x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height }
        }))) {
          assert(!(rect.width > 0 && rect.x < box.x + box.width && box.x < rect.x + rect.width &&
            rect.y < box.y + box.height && box.y < rect.y + rect.height),
          `${screen}: the window prompt ${JSON.stringify(box)} clears ${selector} ${JSON.stringify(rect)}`)
        }
      }
    }

    // Discovery: the drawn three are highlighted, the rest are dimmed, End Turn waits.
    await load('discovery', 'ironclad', {
      hand: [card('discovery', 'slayer_discovery'), card('bludgeon', 'bludgeon')],
      draw: [card('drawn-strike', 'strike_ironclad'), card('drawn-defend', 'defend_ironclad'), card('drawn-anger', 'anger')],
    })
    await activate('Discovery')
    await settleMotion()
    await assertBanner(/Discovery: play one offered card for 0 Energy/)
    assert.equal(await page.locator('.hand .card--play-window').count(), 3, `${screen}: three offered cards`)
    assert.equal(await page.locator('.hand .card--play-window.card--unplayable').count(), 0)
    assert.match(await handCard('Bludgeon').getAttribute('class'), /card--unplayable/, `${screen}: Bludgeon waits`)
    assert.equal(await page.locator('.combat__end-turn').count(), 0, `${screen}: a play that must happen hides End Turn`)
    await page.screenshot({ path: `${out}/${screen}-discovery-window.png` })
    await activate('Strike')
    await page.locator('.enemy--targeted[data-enemy-id="e0"]').first().waitFor()
    await pressButton(page.locator('.enemy--targeted[data-enemy-id="e0"]').first())
    await page.waitForFunction(() => !window.__STS_DEBUG__.getRun().combat.pendingCardPlayWindows)
    let state = await combat()
    assert.equal(state.enemies[0].hp, 99)
    assert.equal(state.players[0].energy, 2, `${screen}: Discovery 1, Strike 0`)
    assert.deepEqual(state.players[0].hand.map((held) => held.uid), ['bludgeon'])
    assert.equal(await page.locator('.hand .card--play-window').count(), 0)
    await page.locator('.combat__end-turn').waitFor()
    await settleMotion()
    await page.screenshot({ path: `${out}/${screen}-discovery-resolved.png` })

    // Violence: every Attack must be played, each at its own target; its banner says so.
    await load('violence', 'ironclad', {
      energy: 2,
      hand: [card('violence', 'slayer_violence'), card('v-strike', 'strike_ironclad'), card('v-bash', 'bash'),
        card('v-defend', 'defend_ironclad')],
    })
    await activate('Violence')
    await settleMotion()
    await assertBanner(/Violence: play every offered card for 0 Energy each/)
    assert.equal(await page.locator('.hand .card--play-window').count(), 2, `${screen}: the two Attacks are offered`)
    assert.equal(await page.locator('.combat__end-turn').count(), 0)
    await page.screenshot({ path: `${out}/${screen}-violence-window.png` })
    await activate('Bash')
    await pressButton(page.locator('.enemy--targeted[data-enemy-id="e1"]').first())
    await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.enemies[1].hp === 98)
    await activate('Strike')
    await pressButton(page.locator('.enemy--targeted[data-enemy-id="e0"]').first())
    await page.waitForFunction(() => !window.__STS_DEBUG__.getRun().combat.pendingCardPlayWindows)
    state = await combat()
    assert.deepEqual(state.enemies.map((foe) => foe.hp), [99, 98])
    assert.equal(state.players[0].energy, 0, `${screen}: Violence 2, both Attacks free`)

    // Enlightenment: costs read 1, and Done closes the optional window.
    await load('enlightenment', 'ironclad', {
      hand: [card('enlightenment', 'slayer_enlightenment'), card('bash', 'bash'), card('cleave', 'cleave')],
      draw: [card('drawn-bludgeon', 'bludgeon')],
    })
    await activate('Enlightenment')
    await settleMotion()
    await assertBanner(/Enlightenment: play any offered cards for 1 Energy each/)
    assert.equal(await page.locator('.hand .card--play-window').count(), 3)
    await page.screenshot({ path: `${out}/${screen}-enlightenment-window.png` })
    await activate('Bludgeon')
    await pressButton(page.locator('.enemy--targeted[data-enemy-id="e1"]').first())
    await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.enemies[1].hp === 93)
    assert.equal((await hero()).energy, 2, `${screen}: Bludgeon cost 1`)
    await pressButton(page.getByRole('button', { name: 'Done with Enlightenment' }))
    await page.waitForFunction(() => !window.__STS_DEBUG__.getRun().combat.pendingCardPlayWindows)
    assert.equal(await page.locator('.hand .card--play-window').count(), 0)

    // Deceive Reality: choosing a revealed card to play is required before confirming.
    await load('deceive', 'watcher', {
      hand: [card('deceive', 'slayer_deceive_reality')],
      draw: [card('top-daze', 'daze'), card('top-strike', 'strike_watcher'), card('top-defend', 'defend_watcher'),
        card('deep', 'eruption')],
    })
    await activate('Deceive Reality')
    const modal = page.getByRole('dialog', { name: /^Scry 3/ })
    await modal.waitFor()
    await modal.getByText('Choose one revealed card to play for 0 Energy, and any others to discard.').waitFor()
    assert.equal(await modal.getByRole('button', { name: 'Play for 0' }).count(), 2, `${screen}: Daze is not offered`)
    assert.equal(await modal.getByRole('button', { name: 'Choose a card to play' }).isDisabled(), true)
    await page.screenshot({ path: `${out}/${screen}-deceive-reveal.png` })
    await pressButton(modal.getByRole('button', { name: 'Play for 0' }).first())
    await pressButton(modal.getByRole('button', { name: 'Play selected card, keep the rest' }))
    await settleMotion()
    await assertBanner(/Deceive Reality: play one offered card for 0 Energy/)
    await page.screenshot({ path: `${out}/${screen}-deceive-window.png` })
    state = await combat()
    assert.deepEqual(state.pendingCardPlayWindows.map((entry) => entry.cardUids), [['top-strike']])
    await activate('Strike')
    await pressButton(page.locator('.enemy--targeted[data-enemy-id="e0"]').first())
    await page.waitForFunction(() => !window.__STS_DEBUG__.getRun().combat.pendingCardPlayWindows)
    state = await combat()
    assert.equal(state.enemies[0].hp, 99)
    assert.equal(state.players[0].energy, 1, `${screen}: Deceive Reality 2, Strike 0`)
    await settleMotion()
    await page.screenshot({ path: `${out}/${screen}-deceive-resolved.png` })

    // Forethought+: pick cards in order, then put them on the bottom.
    await load('forethought', 'ironclad', {
      energy: 1,
      hand: [card('forethought', 'slayer_forethought', true), card('bash', 'bash'), card('cleave', 'cleave'),
        card('strike', 'strike_ironclad')],
      draw: [card('drawn', 'anger')],
    })
    await activate('Forethought')
    await page.getByText(/Forethought\+ — choose any number of cards for the bottom of your draw pile/).waitFor()
    await activate('Cleave')
    await activate('Bash')
    await page.getByText(/in this order\) — 2 chosen/).waitFor()
    await page.screenshot({ path: `${out}/${screen}-forethought-choice.png` })
    await pressButton(page.getByRole('button', { name: 'Put 2 on the bottom' }))
    await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.players[0].exhaust.length === 1)
    state = await combat()
    assert.deepEqual(state.players[0].draw.map((held) => held.uid), ['cleave', 'bash'])
    assert.equal(state.players[0].energy, 4, `${screen}: 1 + Cleave 1 + Bash 2`)
    assert.deepEqual(state.players[0].hand.map((held) => held.uid).sort(), ['drawn', 'strike'])
    // Solo auto End Turn: Enlightenment at 0 Energy has nothing to offer, so its window closes at once
    // and Anger (printed 0) is still played before the turn ends on its own once nothing is left.
    await load('auto-end', 'ironclad', {
      energy: 0,
      hand: [card('auto-enlightenment', 'slayer_enlightenment'), card('auto-anger', 'anger'), card('auto-bash', 'bash')],
      draw: [card('auto-drawn', 'cleave'), ...Array.from({ length: 6 }, (_, index) => card(`auto-${index}`, 'defend_ironclad'))],
    }, true)
    await activate('Enlightenment')
    await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.players[0].exhaust.length === 1)
    assert.equal((await combat()).pendingCardPlayWindows, undefined, `${screen}: a window with nothing affordable closes`)
    await page.waitForTimeout(900)
    assert.equal((await combat()).phase, 'player', `${screen}: Anger is still playable, so the turn does not auto-end`)
    await activate('Anger')
    await pressButton(page.locator('.enemy--targeted[data-enemy-id="e0"]').first())
    await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.enemies[0].hp === 99)
    await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.turn === 2 ||
      window.__STS_DEBUG__.getRun().combat.phase !== 'player', null, { timeout: 15000 })
    await page.close()
  }
  assert.deepEqual(errors, [])
  console.log('Slayer play windows browser passed: Discovery, Violence, Enlightenment, Deceive Reality and Forethought+ windows on desktop keyboard and landscape touch.')
} finally {
  await browser.close()
  await server.close()
}
