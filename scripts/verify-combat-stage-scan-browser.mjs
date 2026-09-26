import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium } from './lib/profile-browser.mjs'

const root = resolve(import.meta.dirname, '..')
const server = await createServer({ root, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } })
await server.listen()
const browser = await chromium.launch({ headless: true })
try {
  for (const [screen, viewport] of [['desktop', { width: 1440, height: 900 }],
    ['horizontal-phone', { width: 844, height: 390 }]]) {
    const context = await browser.newContext({ viewport })
    try {
      const page = await context.newPage()
      const errors = []
      page.on('pageerror', (error) => errors.push(String(error)))
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`)
      const result = await page.evaluate(async () => {
        document.querySelector('#root').style.display = 'none'
        const node = document.createElement('div')
        node.className = 'app-shell app-shell--combat sts-scope'
        node.style.gridTemplateRows = 'minmax(0, 1fr)'
        document.body.append(node)
        const [React, ReactDom, { CombatScreen }, { createPlayer }, { createCombat }, { createRng }] = await Promise.all([
          import('/@id/react'), import('/@id/react-dom/client'), import('/src/ui/CombatScreen.tsx'),
          import('/src/game/run.ts'), import('/src/game/combat.ts'), import('/src/game/rng.ts'),
          import('/src/ui/styles.css'), import('/src/ui/chrome.css'),
        ])
        const rng = createRng(47)
        const players = Array.from({ length: 4 }, (_, index) => createPlayer(rng, `p${index}`, `Player ${index}`, 'ironclad', index))
        const enemy = (index) => ({ uid: `enemy-${index}`, defId: 'sentry_a', row: index % 4, isBoss: false,
          hp: 50, maxHp: 50, block: 0, strength: 0, weak: 0, vulnerable: 0, poison: 0,
          goldReward: 0, cardReward: null, actionIndex: 0, phase: 0, abilityUsed: false, dead: false })
        let state = createCombat(rng, players, Array.from({ length: 9 }, (_, index) => enemy(index)))
        state.phase = 'player'
        const reactRoot = (ReactDom.createRoot ?? ReactDom.default.createRoot)(node)
        const render = () => reactRoot.render((React.createElement ?? React.default.createElement)(CombatScreen, {
          state, act: 1, viewerId: 'p0', autoAdvance: false,
        }))
        const frame = () => new Promise(requestAnimationFrame)
        render()
        await frame()
        await frame()
        const original = Element.prototype.getAnimations
        let scans = 0
        let elapsed = 0
        Element.prototype.getAnimations = function (options) {
          const start = performance.now()
          const animations = original.call(this, options)
          if (this.classList.contains('combat') && options?.subtree) {
            scans++
            elapsed += performance.now() - start
          }
          return animations
        }
        for (let index = 0; index < 20; index++) {
          state = { ...state, enemies: state.enemies.map((foe, enemyIndex) => enemyIndex === 0
            ? { ...foe, hp: foe.hp - 1 } : foe) }
          render()
          await frame()
        }
        const hpScans = scans
        const hpScanMs = elapsed
        state = { ...state, enemies: state.enemies.map((foe, index) => index === 0 ? { ...foe, row: 1 } : foe) }
        render()
        await frame()
        const rowScans = scans - hpScans
        state = { ...state, enemies: state.enemies.map((foe, index) => index === 0 ? { ...foe, isBoss: true } : foe) }
        render()
        await frame()
        const bossScans = scans - hpScans - rowScans
        state = { ...state, enemies: state.enemies.map((foe, index) => index === 0
          ? { ...foe, defId: 'cultist' } : foe) }
        render()
        await frame()
        const identityScans = scans - hpScans - rowScans - bossScans
        state = { ...state, enemies: [...state.enemies, enemy(9)] }
        render()
        await frame()
        await frame()
        const formationScans = scans - hpScans - rowScans - bossScans - identityScans
        const count = +node.querySelector('.combat').style.getPropertyValue('--stage-enemy-count')
        state = { ...state, phase: 'enemy' }
        render()
        await frame()
        const phaseScans = scans - hpScans - rowScans - bossScans - identityScans - formationScans
        const transitions = node.querySelector('.combat').getAnimations({ subtree: true })
          .filter((animation) => animation instanceof CSSTransition && animation.transitionProperty.startsWith('--stage-'))
        const paused = transitions.length > 0 && transitions.every((animation) => animation.playState === 'paused')
        state = { ...state, phase: 'player' }
        render()
        await frame()
        const resumed = transitions.every((animation) => animation.playState === 'running')
        Element.prototype.getAnimations = original
        reactRoot.unmount()
        node.remove()
        return { hpScans, hpScanMs: +hpScanMs.toFixed(2), rowScans, bossScans, identityScans, formationScans,
          phaseScans, paused, resumed, count }
      })
      console.log(`${screen}: ${JSON.stringify(result)}`)
      assert.equal(result.count, 10, `${screen}: formation did not update`)
      assert.equal(result.hpScans, 0, `${screen}: HP-only updates scanned all combat animations`)
      assert(result.rowScans > 0 && result.bossScans > 0 && result.identityScans > 0,
        `${screen}: changing an enemy's row, boss status, or identity must check stage transitions`)
      assert(result.formationScans > 0, `${screen}: changing the formation must still check stage transitions`)
      assert(result.phaseScans > 0 && result.paused && result.resumed,
        `${screen}: stage transitions must pause for enemy phase and resume afterward`)
      assert.deepEqual(errors, [], `${screen}: browser errors`)
    } finally { await context.close() }
  }
} finally { await browser.close(); await server.close() }
