import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { chromium } from './lib/profile-browser.mjs'
import { createServer } from 'vite'
import { createRun } from '../src/game/run.ts'
import { createCombat, preparePlayerTurnThroughDraw, startPlayerTurnWithChoices } from '../src/game/combat.ts'
import { createEventRoom } from '../src/game/event-room.ts'
import { EVENT_DEFINITIONS } from '../src/game/events.ts'

// The Hermit board's Start of Combat ability draws 1 after the 5-card opening
// hand, then Loads 1 of those 6 before the shared die is rolled.
const out = 'artifacts/hermit-setup'
mkdirSync(out, { recursive: true })
const server = await createServer({ logLevel: 'silent', server: { port: 0 } })
const browser = await chromium.launch({ headless: true })
const errors = []
const enemy = (uid, row) => ({ uid, defId: 'jaw_worm', row, isBoss: false, hp: 40, maxHp: 40,
  block: 0, strength: 0, vulnerable: 0, weak: 0, poison: 0, goldReward: 0, cardReward: null,
  actionIndex: 0, abilityUsed: false, dead: false })
try {
  await server.listen()
  for (const [name, width, height] of [['desktop', 1440, 900], ['phone-landscape', 844, 390]]) {
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce', hasTouch: name !== 'desktop' })
    page.on('pageerror', (error) => errors.push(`${name}: ${error}`))
    page.on('console', (message) => { if (message.type() === 'error') errors.push(`${name}: ${message.text()}`) })
    await page.goto(`http://localhost:${server.httpServer.address().port}`)
    await page.getByRole('button', { name: 'Single Player', exact: true }).click()
    await page.getByRole('button', { name: 'Standard', exact: true }).click()
    await page.getByRole('button', { name: 'Embark' }).click()
    await page.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
    await page.waitForFunction(() => window.__STS_DEBUG__?.getRun()?.phase === 'neow')
    const viewerId = await page.evaluate(() => window.__STS_DEBUG__.getRun().players[0].id)

    // The deal animates cards out from the pile; wait until every card rests in the fan.
    async function settledHand(count) {
      await page.waitForFunction((expected) => document.querySelectorAll('.hand .card').length === expected, count)
      await page.evaluate(() => Promise.all(document.getAnimations().map((animation) =>
        animation.effect?.getTiming().iterations === Infinity ? null : animation.finished.catch(() => null))))
    }

    async function open(draw, enemies) {
      const run = createRun(908, [{ id: viewerId, name: 'Hermit', character: 'hermit' }])
      run.players[0].draw = draw.map((defId, index) => ({ uid: `setup-${index}`, defId, upgraded: false }))
      run.combat = startPlayerTurnWithChoices(createCombat({ seed: 908, calls: 0 }, run.players, enemies, 'setup'))
      run.phase = 'combat'
      run.neow = null
      await page.evaluate((next) => window.__STS_DEBUG__.setRun(next), run)
      await page.locator('[aria-label="Hermit start-of-combat Load"]').waitFor({ state: 'attached' })
      await settledHand(run.combat.players[0].hand.length)
    }

    await open(['hermit_strike', 'hermit_defend', 'hermit_snapshot', 'hermit_strike', 'hermit_defend',
      'hermit_covet', 'hermit_strike'], [enemy('e0', 0)])
    const setup = await page.evaluate(() => {
      const combat = window.__STS_DEBUG__.getRun().combat
      const cards = [...document.querySelectorAll('.hand .card')]
      return {
        phase: combat.phase,
        hand: combat.players[0].hand.length,
        rendered: cards.length,
        playable: cards.filter((card) => card.getAttribute('aria-disabled') === 'false').length,
        orderPanel: Boolean(document.querySelector('.start-turn-order')),
        resolveButton: [...document.querySelectorAll('button')].some((button) => /start (of )?turn/i.test(button.textContent ?? '')),
        cardsContained: cards.every((card) => {
          const box = card.getBoundingClientRect()
          return box.top >= 0 && box.bottom <= innerHeight + 1 && box.left >= 0 && box.right <= innerWidth + 1
        }),
      }
    })
    assert.deepEqual(setup, { phase: 'start', hand: 6, rendered: 6, playable: 6, orderPanel: false,
      resolveButton: false, cardsContained: true }, `${name}: the Hermit setup Load must offer all six opening cards`)
    await page.screenshot({ path: `${out}/${name}-six-card-load.png` })
    // Snapshot came from the 5-card opening hand, not the board ability's draw.
    await page.getByRole('button', { name: /^Snapshot,/ }).click()
    await page.waitForFunction(() => {
      const combat = window.__STS_DEBUG__.getRun().combat
      return combat.pendingHermitSetupLoads.length === 0 && combat.phase === 'player'
    })
    const opened = await page.evaluate(() => {
      const combat = window.__STS_DEBUG__.getRun().combat
      return { chamber: combat.players[0].chamber.map((card) => card.defId), hand: combat.players[0].hand.length,
        rolled: combat.log.some((line) => /^Turn 1 begins \(die [1-6]\)$/.test(line)) }
    })
    assert.deepEqual(opened, { chamber: ['hermit_snapshot'], hand: 5, rolled: true },
      `${name}: loading an opening-hand card must finish the Start of Turn`)
    await page.screenshot({ path: `${out}/${name}-after-load.png` })

    // A targeted Curse in the six cards still asks which row it hits.
    await open(['hermit_strike', 'hermit_defend', 'hermit_strike', 'hermit_defend', 'hermit_strike', 'hermit_grudge'],
      [enemy('e0', 0), enemy('e1', 1)])
    const targets = page.getByRole('region', { name: 'Hermit start-of-combat Load target' })
    await targets.waitFor()
    assert.equal(await targets.getByRole('button').count(), 2, `${name}: Grudge must offer both enemies`)
    await page.screenshot({ path: `${out}/${name}-curse-target.png` })
    await targets.getByRole('button').first().click()
    await page.waitForFunction(() => {
      const combat = window.__STS_DEBUG__.getRun().combat
      return combat.phase === 'player' && combat.players[0].chamber[0]?.defId === 'hermit_grudge'
    })
    assert.deepEqual(await page.evaluate(() => window.__STS_DEBUG__.getRun().combat.enemies.map((foe) => foe.hp < foe.maxHp)),
      [true, false], `${name}: Grudge did not hit the chosen enemy`)

    // A teammate waits: no start-of-turn order or resolve control while the Hermit Loads.
    const party = createRun(908, [{ id: viewerId, name: 'Ironclad', character: 'ironclad' },
      { id: 'hermit-mate', name: 'Mate', character: 'hermit' }])
    party.combat = startPlayerTurnWithChoices(createCombat({ seed: 908, calls: 0 }, party.players,
      [enemy('e0', 0), enemy('e1', 1)], 'setup-party'))
    party.phase = 'combat'
    party.neow = null
    await page.evaluate((next) => window.__STS_DEBUG__.setRun(next), party)
    await page.getByRole('status').filter({ hasText: 'Waiting for Mate to Load a card' }).waitFor({ state: 'attached' })
    const watcher = await page.evaluate(() => ({
      orderPanel: Boolean(document.querySelector('.start-turn-order')),
      resolveButton: [...document.querySelectorAll('button')].some((button) => /start (of )?turn/i.test(button.textContent ?? '')),
      pending: window.__STS_DEBUG__.getRun().combat.pendingHermitSetupLoads.map((choice) => choice.playerId),
    }))
    assert.deepEqual(watcher, { orderPanel: false, resolveButton: false, pending: ['hermit-mate'] },
      `${name}: a teammate must wait on the Hermit setup Load without start-of-turn controls`)

    // Mysterious Sphere prepares its fight inside the event: the same six-card Load, one button per card.
    const sphere = createRun(908, [{ id: viewerId, name: 'Hermit', character: 'hermit' }])
    sphere.players[0].draw = ['hermit_strike', 'hermit_defend', 'hermit_snapshot', 'hermit_strike', 'hermit_defend',
      'hermit_covet', 'hermit_strike'].map((defId, index) => ({ uid: `sphere-${index}`, defId, upgraded: false }))
    sphere.phase = 'room'
    sphere.neow = null
    sphere.roomState = createEventRoom({ ...EVENT_DEFINITIONS.living_wall, instanceId: 'setup-sphere', act: 3,
      minAscension: 0, requiresColorlessUnlock: false })
    sphere.roomState.preparedCombat = preparePlayerTurnThroughDraw(
      createCombat({ seed: 908, calls: 0 }, sphere.players, [enemy('e0', 0)], 'setup-sphere'))
    await page.evaluate((next) => window.__STS_DEBUG__.setRun(next), sphere)
    const picker = page.getByRole('group', { name: 'Load 1 card' })
    await picker.waitFor()
    assert.equal(await picker.getByRole('button', { name: /^Load / }).count(), 6, `${name}: the Sphere setup must offer all six cards`)
    await picker.getByRole('button', { name: 'Load Covet' }).scrollIntoViewIfNeeded()
    const readable = await picker.locator('.card').first().evaluate((card) => card.getBoundingClientRect().width)
    assert(readable >= 90, `${name}: the Sphere setup cards are too small to read (${readable}px)`)
    await page.screenshot({ path: `${out}/${name}-sphere-load.png` })
    await picker.getByRole('button', { name: 'Load Snapshot' }).click()
    await page.waitForFunction(() => window.__STS_DEBUG__.getRun().roomState?.preparedCombat?.pendingHermitSetupLoads.length === 0)
    const loadedSphere = await page.evaluate(() => window.__STS_DEBUG__.getRun().roomState.preparedCombat.players[0].chamber[0]?.defId)
    assert.equal(loadedSphere, 'hermit_snapshot', `${name}: the Sphere setup Loaded the wrong card`)

    // A targeted Curse in the Sphere hand gets one button per enemy row.
    const curseSphere = structuredClone(sphere)
    curseSphere.players[0].draw = ['hermit_strike', 'hermit_defend', 'hermit_strike', 'hermit_defend', 'hermit_strike',
      'hermit_grudge'].map((defId, index) => ({ uid: `sphere-curse-${index}`, defId, upgraded: false }))
    curseSphere.roomState.preparedCombat = preparePlayerTurnThroughDraw(createCombat({ seed: 908, calls: 0 },
      curseSphere.players, [enemy('e0', 0), enemy('e1', 1)], 'setup-sphere-curse'))
    await page.evaluate((next) => window.__STS_DEBUG__.setRun(next), curseSphere)
    const cursePicker = page.getByRole('group', { name: 'Load 1 card' })
    await cursePicker.getByRole('button', { name: 'Load Grudge at Jaw Worm (row 2)' }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: `${out}/${name}-sphere-curse-target.png` })
    await cursePicker.getByRole('button', { name: 'Load Grudge at Jaw Worm (row 2)' }).click()
    await page.waitForFunction(() => {
      const prepared = window.__STS_DEBUG__.getRun().roomState?.preparedCombat
      return prepared?.pendingHermitSetupLoads.length === 0 && prepared.startTurnProgress?.pauseAfterDraw &&
        prepared.players[0].chamber[0]?.defId === 'hermit_grudge'
    })
    assert.deepEqual(await page.evaluate(() => window.__STS_DEBUG__.getRun().roomState.preparedCombat.enemies
      .map((foe) => foe.hp < foe.maxHp)), [false, true], `${name}: the Sphere Grudge did not hit row 2`)
    await page.close()
  }
  assert.deepEqual(errors, [])
  console.log('Hermit setup browser check passed: the Start of Combat Load chooses from the whole opening hand.')
} finally {
  await browser.close()
  await server.close()
}
