#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'artifacts/slime-animation-browser')
mkdirSync(output, { recursive: true })
const server = await createServer({ root, logLevel: 'silent', server: { port: 0 } })
await server.listen()
const browser = await chromium.launch({ headless: true })
const errors = []
try {
  for (const [name, viewport, reducedMotion = 'no-preference'] of [['desktop', { width: 1440, height: 900 }],
    ['horizontal-phone', { width: 844, height: 390 }],
    ['horizontal-phone-os-reduced', { width: 844, height: 390 }, 'reduce']]) {
    const page = await browser.newPage({ viewport, reducedMotion })
    page.on('pageerror', (error) => errors.push(String(error)))
    await page.goto(`http://localhost:${server.httpServer.address().port}`)
    await page.evaluate(() => {
      document.querySelector('#root').style.display = 'none'
      document.documentElement.dataset.mobilePerformance = String(innerWidth < 900)
      document.documentElement.dataset.reducedMotion = 'false'
      const container = document.createElement('div')
      container.id = 'test'
      container.className = 'app-shell app-shell--combat sts-scope'
      document.body.append(container)
    })
    await page.evaluate(async () => {
      const [React, ReactDomClient, { CombatScreen }, { createPlayer },
        { createCombat }, { createRng }, { bruiserSlime }] = await Promise.all([
        import('/@id/react'), import('/@id/react-dom/client'), import('/src/ui/CombatScreen.tsx'),
        import('/src/game/run.ts'), import('/src/game/combat.ts'), import('/src/game/rng.ts'),
        import('/src/game/downfall/slime-boss.ts'),
        import('/src/ui/styles.css'), import('/src/ui/chrome.css'),
      ])
      const createElement = React.createElement ?? React.default.createElement
      const createRoot = ReactDomClient.createRoot ?? ReactDomClient.default.createRoot
      const rng = createRng(47)
      const player = createPlayer(rng, 'p1', 'Slime Boss', 'slime_boss', 0)
      player.slimes = [bruiserSlime('x'), bruiserSlime('y')]
      player.hand = []; player.draw = []; player.relics = []
      const state = createCombat(rng, [player], [{
        uid: 'boss', defId: 'guardian_attack', row: 0, isBoss: true,
        hp: 100, maxHp: 100, block: 0, strength: 0, vulnerable: 0, weak: 0,
        poison: 0, actionIndex: 0, abilityUsed: false, dead: false,
      }])
      state.phase = 'player'; state.presentationEvents = []
      const reactRoot = createRoot(document.querySelector('#test'))
      window.fixture = { state, restoration: 0, connected: true, actions: [], events: [] }
      const f = window.fixture
      f.render = () => reactRoot.render(createElement(CombatScreen, {
        state: structuredClone(f.state), act: 1, viewerId: 'p1', autoAdvance: true,
        authoritativeRestoration: f.restoration, authoritativeConnected: f.connected,
        onAction: (action) => { f.actions.push(action) },
      }))
      f.command = (seq, slimeUid = 'x', animationIndex = 0) => ({
        kind: 'slime', seq, actorId: 'p1', sourceId: 'slime_boss_bruiser_slime',
        slimeUid, upgraded: false, animationIndex, enemyIds: ['boss'], playerIds: [],
      })
      for (const type of ['animationstart', 'animationend']) document.addEventListener(type, (event) => {
        if (event.animationName === 'slime-party-command') f.events.push({
          type, seq: Number(event.target.querySelector('[data-command-seq]')?.dataset.commandSeq),
          transform: getComputedStyle(event.target).transform,
        })
      }, true)
      f.render()
    })
    const x = page.locator('[data-slime-uid="x"]')
    await x.waitFor()
    await page.evaluate(() => {
      const f = window.fixture
      f.state.phase = 'enemy'
      f.state.presentationEvents = [f.command(1), f.command(2, 'x', 1)]
      f.render()
    })
    await page.locator('[data-command-seq="1"]').waitFor()
    // Pause the actual CSS animation longer than its nominal duration. The
    // queue and enemy barrier must follow completion, not elapsed wall time.
    await x.evaluate((node) => {
      const animation = node.getAnimations().find((item) => item.animationName === 'slime-party-command')
      animation.pause(); animation.currentTime = 600
    })
    const path = await x.getAttribute('style')
    await page.evaluate(() => {
      const f = window.fixture
      f.state.presentationEvents.push(f.command(3, 'y'))
      f.render()
    })
    await page.locator('[data-command-seq="3"]').waitFor()
    assert.equal(await x.getAttribute('style'), path, 'another slime must not change an in-flight path')
    await page.waitForTimeout(2000)
    assert.equal(await page.locator('[data-command-seq="1"]').count(), 1, 'first command must finish before second starts')
    assert.equal(await page.locator('[data-command-seq="2"]').count(), 0, 'second command must remain queued')
    assert.equal(await page.locator('.enemy[data-animation="attack"]').count(), 0, 'boss must wait for queued slimes')
    assert.equal(await page.evaluate(() => window.fixture.actions.length), 0, 'enemy resolution must wait too')
    await page.screenshot({ path: resolve(output, `${name}-slime-contact.png`) })
    await x.evaluate((node) => node.getAnimations().find((item) => item.animationName === 'slime-party-command').finish())
    await page.locator('[data-command-seq="2"]').waitFor()
    assert.equal(await page.locator('.enemy[data-animation="attack"]').count(), 0, 'boss must wait for second return')
    await page.waitForFunction(() => !document.querySelector('.slime-party__actor--commanding'))
    await page.locator('.enemy[data-animation="attack"]').waitFor()
    await page.screenshot({ path: resolve(output, `${name}-boss-after-slimes.png`) })
    const events = await page.evaluate(() => window.fixture.events)
    assert(events.findIndex((event) => event.seq === 1 && event.type === 'animationend') <
      events.findIndex((event) => event.seq === 2 && event.type === 'animationstart'), 'second starts only after first returns')
    assert.equal(events.find((event) => event.seq === 2 && event.type === 'animationend')?.transform,
      'matrix(1, 0, 0, 1, 0, 0)', 'slime must return to its home position')
    await page.waitForFunction(() => window.fixture.actions.some((action) => action.kind === 'resolveEnemies'))

    // Reconnect establishes a baseline and drops both active and queued history.
    await page.evaluate(() => {
      const f = window.fixture
      f.state.phase = 'player'; f.state.presentationEvents.push(f.command(4), f.command(5))
      f.render()
    })
    await page.locator('[data-command-seq="4"]').waitFor()
    await page.evaluate(() => { window.fixture.restoration++; window.fixture.render() })
    await page.waitForFunction(() => !document.querySelector('.slime-party__actor--commanding'))
    await page.waitForTimeout(1800)
    assert.equal(await page.locator('[data-command-seq="5"]').count(), 0, 'restored queue must not replay')

    await page.evaluate(() => {
      const f = window.fixture
      f.state.presentationEvents.push(f.command(6), f.command(7))
      f.render()
    })
    await page.locator('[data-command-seq="6"]').waitFor()
    await page.evaluate(() => { document.documentElement.dataset.reducedMotion = 'true' })
    await page.waitForFunction(() => !document.querySelector('.slime-party__actor--commanding'))
    await page.evaluate(() => {
      const f = window.fixture
      f.state.phase = 'enemy'; f.actions = []; f.render()
    })
    await page.waitForFunction(() => window.fixture.actions.some((action) => action.kind === 'resolveEnemies'))
    // Removing an actor cannot strand its queue; a killed boss cannot retaliate.
    await page.evaluate(() => {
      const f = window.fixture
      document.documentElement.dataset.reducedMotion = 'false'
      f.state.phase = 'player'; f.render()
    })
    await page.waitForTimeout(100)
    await page.evaluate(() => {
      const f = window.fixture
      f.state.presentationEvents.push(f.command(8), f.command(9))
      f.render()
    })
    await page.locator('[data-command-seq="8"]').waitFor()
    await page.evaluate(() => {
      const f = window.fixture
      f.state.players[0].slimes = []
      f.state.enemies[0].hp = 0; f.state.enemies[0].dead = true
      f.state.phase = 'enemy'; f.actions = []; f.render()
    })
    await page.waitForFunction(() => window.fixture.actions.some((action) => action.kind === 'resolveEnemies'))
    assert.equal(await page.locator('.enemy[data-animation="attack"]').count(), 0, 'dead boss cannot attack')
    await page.close()
    console.log(`${name}: command completion, stable paths, enemy barrier, reconnect and reduced motion passed`)
  }
  assert.deepEqual(errors, [], 'browser runtime errors')
} finally {
  await browser.close()
  await server.close()
}
