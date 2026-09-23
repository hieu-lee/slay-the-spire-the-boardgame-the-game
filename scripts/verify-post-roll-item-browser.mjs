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
    await page.addInitScript(() => {
      const tools = new Map()
      Object.defineProperty(document, 'modelContext', { value: {
        registerTool(tool) { tools.set(tool.name, tool); return Promise.resolve() },
        getTools() { return Promise.resolve([...tools.values()]) },
        executeTool(tool, input) { return Promise.resolve(tool.execute(input)).then(JSON.stringify) },
      } })
    })
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
      const fixture = window.postRollFixture = { host, locked: false, state, actions: [], refuse: false }
      fixture.render = () => root.render(createElement(CombatScreen, {
        state: fixture.state, act: 1, viewerId: 'p1', autoAdvance: false,
        onAction: async (action) => {
          fixture.actions.push(action)
          return fixture.refuse ? { status: 'refused', snapshot: { version: 0,
            run: { combat: fixture.refusedCombat ?? fixture.state } } } : undefined
        },
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
    await candle.locator('summary').click()
    await page.evaluate(() => {
      const fixture = window.postRollFixture
      const root = document.querySelector('#root')
      root.replaceChildren(fixture.host)
      root.style.display = ''
      fixture.state = { ...fixture.state, phase: 'player', die: 1, players: fixture.state.players.map((player) =>
        player.id === 'p1' ? { ...player, potions: ['mystery_potion'] } : player) }
      fixture.locked = false
      fixture.refuse = true
      fixture.render()
    })
    await page.getByRole('button', { name: 'Use Mystery Potion' }).click()
    await page.getByText('Choose an enemy for Mystery Potion').waitFor()
    const targets = page.locator('button.enemy--targeted')
    assert.equal(await targets.count(), 2, `${screen}: Mystery Potion enemies are not targetable`)
    await page.screenshot({ path: resolve(output, `${screen}-mystery-target.png`), fullPage: true })
    const webmcpTarget = async (name) => page.evaluate(async (targetName) => {
      const tools = await document.modelContext.getTools()
      const inspect = tools.find((tool) => tool.name === 'inspect_game')
      const interact = tools.find((tool) => tool.name === 'interact_with_game')
      if (!inspect || !interact) throw new Error('WebMCP tools are unavailable')
      const snapshot = JSON.parse(await document.modelContext.executeTool(inspect, {}))
      const target = snapshot.controls.find((control) => control.label.includes(targetName))
      if (!target) throw new Error(`WebMCP did not expose ${targetName}`)
      await document.modelContext.executeTool(interact, { controlId: target.id })
      return target.label
    }, name)
    assert.match(await webmcpTarget('Jaw Worm'), /Jaw Worm/, `${screen}: WebMCP target not available`)
    const action = await page.evaluate(() => window.postRollFixture.actions.at(-1))
    assert.equal(action?.kind, 'usePotion', `${screen}: Mystery Potion was not used`)
    assert(['left', 'right'].includes(action.enemyUid), `${screen}: Mystery Potion did not select an enemy`)
    await page.getByText('Choose an enemy for Mystery Potion').waitFor()
    assert.equal(await targets.count(), 2, `${screen}: refused Mystery Potion did not restore enemy targets`)
    await page.evaluate(() => {
      const fixture = window.postRollFixture
      fixture.state = { ...fixture.state, die: 3 }
      fixture.refuse = false
      fixture.render()
    })
    await page.getByText('Choose an enemy for Mystery Potion').waitFor({ state: 'detached' })
    await page.getByRole('button', { name: 'Use Mystery Potion' }).click()
    assert.equal((await page.evaluate(() => window.postRollFixture.actions.at(-1)))?.enemyUid, undefined,
      `${screen}: Mystery Potion still requested an enemy after the die changed`)
    await page.evaluate(() => {
      const fixture = window.postRollFixture
      fixture.refuse = true
      fixture.refusedCombat = { ...fixture.state, die: 1 }
    })
    await page.getByRole('button', { name: 'Use Mystery Potion' }).click()
    await page.getByText('Choose a player for Mystery Potion').waitFor()
    await page.evaluate(() => {
      const fixture = window.postRollFixture
      fixture.state = fixture.refusedCombat
      fixture.refuse = false
      fixture.refusedCombat = null
      fixture.render()
    })
    await page.getByText('Choose an enemy for Mystery Potion').waitFor()
    assert.equal(await targets.count(), 2, `${screen}: 3→1 refusal lost the staged enemy targets`)
    await page.getByRole('button', { name: 'Use Mystery Potion' }).click()
    await page.evaluate(() => {
      const fixture = window.postRollFixture
      fixture.state = { ...fixture.state, die: 1, enemies: [
        { ...fixture.state.enemies[0], uid: 'boss', defId: 'donu', isBoss: true, hp: 50, maxHp: 50 },
      ] }
      fixture.render()
    })
    await page.getByRole('button', { name: 'Use Mystery Potion' }).click()
    const boss = page.locator('button.enemy--targeted').filter({ hasText: 'Donu' })
    assert.equal(await boss.count(), 1, `${screen}: Mystery Potion boss is not targetable`)
    await page.screenshot({ path: resolve(output, `${screen}-mystery-boss.png`), fullPage: true })
    assert.match(await webmcpTarget('Donu'), /Donu/, `${screen}: WebMCP boss target not available`)
    assert.equal((await page.evaluate(() => window.postRollFixture.actions.at(-1)))?.enemyUid, 'boss',
      `${screen}: Mystery Potion did not select the boss`)
    assert.deepEqual(errors, [], `${screen}: browser errors after Mystery Potion`)
    await context.close()
  }
  console.log('✓ post-roll item browser: 2/2 screen classes passed')
} finally {
  await browser.close()
  await server.close()
}
