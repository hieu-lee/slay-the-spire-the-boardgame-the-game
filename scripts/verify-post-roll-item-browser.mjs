#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium } from './lib/profile-browser.mjs'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'artifacts/post-roll-item-browser')
mkdirSync(output, { recursive: true })
const server = await createServer({ root, logLevel: 'silent', server: { port: 0 } })
await server.listen()
const browser = await chromium.launch({ headless: true })

try {
  for (const [screen, viewport] of [
    ['desktop', { width: 1440, height: 900 }],
    ['horizontal-phone', { width: 844, height: 390 }],
  ]) {
    const context = await browser.newContext({ viewport })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(String(error)))
    await page.goto(`http://localhost:${server.httpServer.address().port}`)
    await page.evaluate(async () => {
      document.querySelector('#root').style.display = 'none'
      const host = document.createElement('div')
      host.className = 'app-shell app-shell--combat sts-scope'
      host.style.gridTemplateRows = 'minmax(0, 1fr)'
      document.body.append(host)
      const [React, ReactDom, { CombatScreen }, { createPlayer }, combat, { createRng }] = await Promise.all([
        import('/@id/react'), import('/@id/react-dom/client'), import('/src/ui/CombatScreen.tsx'),
        import('/src/game/run.ts'), import('/src/game/combat.ts'), import('/src/game/rng.ts'),
        import('/src/ui/styles.css'), import('/src/ui/chrome.css'),
      ])
      const rng = createRng(47)
      const ann = createPlayer(rng, 'p1', 'Ann', 'ironclad', 0)
      const bo = createPlayer(rng, 'p2', 'Bo', 'silent', 1)
      Object.assign(ann, {
        hand: [{ uid: 'post-roll-relic-card', defId: 'defend_ironclad', upgraded: false }],
        draw: [], powers: [], potions: ['gamblers_brew'],
        relics: [
          { defId: 'the_abacus', spent: false },
          { defId: 'charons_ashes', spent: false },
          { defId: 'blue_candle', spent: false },
          { defId: 'holy_water', spent: false, cubes: 2 },
        ],
      })
      Object.assign(bo, {
        hand: [], draw: [], relics: [], potions: [],
        powers: [{ uid: 'post-roll-fumes', defId: 'noxious_fumes', upgraded: false }],
      })
      const state = combat.createCombat(rng, [ann, bo], [
        { uid: 'left', defId: 'jaw_worm', row: 0, hp: 20, maxHp: 20, block: 0, strength: 0,
          weak: 0, vulnerable: 0, poison: 0, actionIndex: 0, abilityUsed: false, dead: false },
        { uid: 'right', defId: 'jaw_worm', row: 1, hp: 20, maxHp: 20, block: 0, strength: 0,
          weak: 0, vulnerable: 0, poison: 0, actionIndex: 0, abilityUsed: false, dead: false },
      ])
      state.phase = 'start'
      state.die = 1
      const abilities = combat.startTurnAbilities(state)
      const fumes = abilities.find((ability) => ability.playerId === 'p2')
      const createElement = React.createElement ?? React.default.createElement
      const createRoot = ReactDom.createRoot ?? ReactDom.default.createRoot
      const root = createRoot(host)
      const fixture = window.postRollFixture = { locked: false }
      fixture.render = () => root.render(createElement(CombatScreen, {
        state, act: 1, viewerId: 'p1', autoAdvance: false, onAction: async () => undefined,
        partyStartTurnPostRollLocked: fixture.locked,
        partyStartTurnAbilities: fixture.locked ? abilities : [],
        requiredStartTurnPlayerIds: fixture.locked ? ['p2'] : ['p1'],
        startTurnCoordinatorId: fixture.locked ? 'p2' : 'p1',
        startTurnChoiceId: fixture.locked ? fumes?.id : undefined,
      }))
      fixture.render()
    })
    await page.locator('.combat[data-phase="start"]').waitFor()
    const charon = page.locator('.relic-actions details').filter({ hasText: "Charon's Ashes" })
    await charon.locator('summary').click()
    await charon.locator('.card').first().click()
    assert.equal(await charon.locator('.card--selected').count(), 1,
      `${screen}: Charon's Ashes card was not staged`)
    await page.getByRole('button', { name: /^Use Gambler's Brew/ }).click()
    await page.locator('.prompt').getByRole('button', { name: '1', exact: true }).waitFor()
    await page.evaluate(() => {
      window.postRollFixture.locked = true
      window.postRollFixture.render()
    })
    await page.locator('.prompt').getByRole('button', { name: '1', exact: true }).waitFor({ state: 'detached' })
    await page.getByRole('button', { name: /^Use Holy Water/ }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Use The Abacus' }).count(), 0,
      `${screen}: declined Abacus remained clickable`)
    assert.equal(await page.getByRole('button', { name: /^Use Gambler's Brew/ }).count(), 0,
      `${screen}: declined Gambler's Brew remained clickable`)
    assert.equal(await page.getByRole('button', { name: /^Use Holy Water/ }).count(), 1,
      `${screen}: unrelated Holy Water was hidden`)
    const candle = page.locator('.relic-actions details').filter({ hasText: 'Blue Candle' })
    await candle.locator('summary').click()
    assert.equal(await candle.locator('.card--selected').count(), 0,
      `${screen}: Charon's Ashes card leaked into Blue Candle after lock`)
    assert.deepEqual(errors, [], `${screen}: browser errors`)
    await page.screenshot({ path: resolve(output, `${screen}.png`), fullPage: true })
    await context.close()
  }
  console.log('✓ post-roll item browser: 2/2 screen classes passed')
} finally {
  await browser.close()
  await server.close()
}
