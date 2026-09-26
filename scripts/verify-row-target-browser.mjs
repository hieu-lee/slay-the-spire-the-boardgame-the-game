import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium } from './lib/profile-browser.mjs'

const output = resolve(import.meta.dirname, '../artifacts/row-target')
mkdirSync(output, { recursive: true })
const server = await createServer({ logLevel: 'silent', server: { port: 0 } })
await server.listen()
try {
  for (const [engineName, engine] of Object.entries({ chromium })) {
    const browser = await engine.launch({ headless: true })
    try {
      for (const [screen, viewport] of [['desktop', { width: 1440, height: 900 }],
        ['horizontal-phone', { width: 844, height: 390 }]]) {
        const phone = screen === 'horizontal-phone'
        const context = await browser.newContext({ viewport, isMobile: phone, hasTouch: phone })
        const page = await context.newPage()
        const activate = async (locator) => {
          if (!phone) return locator.click()
          const box = await locator.boundingBox()
          assert(box, `${screen}: target is offscreen`)
          await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2)
        }
        const errors = []
        page.on('pageerror', error => errors.push(String(error)))
        await page.goto(`http://localhost:${server.httpServer.address().port}`)
        await page.evaluate(async () => {
          document.querySelector('#root').style.display = 'none'
          document.documentElement.dataset.mobilePerformance = String(matchMedia('(pointer: coarse)').matches)
          const node = document.createElement('div')
          node.className = 'app-shell app-shell--combat sts-scope'
          node.style.gridTemplateRows = 'minmax(0, 1fr)'
          document.body.append(node)
          const [React, ReactDom, { CombatScreen }, { createPlayer }, { createCombat }, { createRng }] = await Promise.all([
            import('/@id/react'), import('/@id/react-dom/client'), import('/src/ui/CombatScreen.tsx'),
            import('/src/game/run.ts'), import('/src/game/combat.ts'), import('/src/game/rng.ts'),
            import('/src/ui/styles.css'), import('/src/ui/chrome.css'),
          ])
          const player = createPlayer(createRng(47), 'p1', 'Defect', 'defect', 0)
          Object.assign(player, { hp: 8, maxHp: 8, relics: [], draw: [], discard: [],
            hand: [], powers: [{ uid: 'combust', defId: 'combust', upgraded: true }] })
          const ally = createPlayer(createRng(48), 'p2', 'Ally', 'ironclad', 0)
          Object.assign(ally, { row: 1, relics: [], hand: [], draw: [], powers: [] })
          const enemy = { uid: 'dead', defId: 'jaw_worm', row: 0, isBoss: false, hp: 0, maxHp: 10,
            block: 0, strength: 0, weak: 0, vulnerable: 0, poison: 0, actionIndex: 0, abilityUsed: false, dead: true }
          const state = createCombat(createRng(49), [player, ally], [enemy,
            { ...enemy, uid: 'living', row: 1, hp: 10, dead: false },
            { ...enemy, uid: 'boss', defId: 'the_champ', row: 0, hp: 20, maxHp: 20, isBoss: true, dead: false }])
          Object.assign(state, { phase: 'player', die: 1, presentationEvents: [] })
          const fixture = window.fixture = { state }
          const root = (ReactDom.createRoot ?? ReactDom.default.createRoot)(node)
          fixture.render = () => root.render((React.createElement ?? React.default.createElement)(CombatScreen, {
            state: structuredClone(fixture.state), viewerId: 'p1', act: 2, autoAdvance: false,
            onChange: next => { fixture.state = next; fixture.render() },
          }))
          fixture.noBoss = () => {
            fixture.state = structuredClone(state)
            fixture.state.enemies = fixture.state.enemies.filter(enemy => !enemy.isBoss)
            fixture.render()
          }
          fixture.otherEmpty = () => {
            fixture.state = structuredClone(state)
            fixture.state.enemies.find(enemy => enemy.uid === 'dead').row = 1
            fixture.state.enemies.find(enemy => enemy.uid === 'living').row = 0
            fixture.render()
          }
          fixture.evoke = () => {
            fixture.state = structuredClone(state)
            Object.assign(fixture.state.players[0], {
              hand: [{ uid: 'dual-cast', defId: 'dual_cast', upgraded: false }],
              orbs: ['lightning', 'lightning', 'frost'],
              powers: [{ uid: 'electrodynamics', defId: 'electrodynamics', upgraded: true }],
            })
            fixture.render()
          }
          fixture.fourParty = () => {
            const party = [player, ally, ...[2, 3].map(row => {
              const member = createPlayer(createRng(49 + row), `p${row + 1}`, `Ally ${row}`, 'ironclad', 0)
              return Object.assign(member, { row, relics: [], hand: [], draw: [], powers: [] })
            })]
            fixture.state = createCombat(createRng(55), party, [
              { ...enemy, uid: 'living', row: 0, hp: 10, dead: false },
              ...[1, 2, 3].map(row => ({ ...enemy, uid: `dead-${row}`, row })),
              { ...enemy, uid: 'boss', defId: 'the_champ', hp: 20, maxHp: 20, isBoss: true, dead: false },
            ])
            Object.assign(fixture.state, { phase: 'player', die: 1, presentationEvents: [] })
            fixture.render()
          }
          fixture.render()
        })
        await page.getByRole('button', { name: 'Use Combust+' }).click()
        await page.locator('[data-enemy-id="living"].enemy--targeted').waitFor()
        assert.equal(await page.locator('.row__lane-target').count(), 0,
          `${screen}: a visible fallback button competes with the boss`)
        const bossGround = page.getByRole('button', { name: 'Target Row Defect with Combust+ (the boss is hit)' })
        await bossGround.waitFor()
        const hitSurfaces = await page.evaluate(() => {
          const bar = document.querySelector('[data-enemy-id="boss"] .bar')
          const ground = document.querySelector('.row__enemies--targetable')
          const barBox = bar.getBoundingClientRect()
          const groundBox = ground.getBoundingClientRect()
          return {
            boss: document.elementFromPoint(barBox.x + barBox.width / 2, barBox.bottom - 1)
              ?.closest('.enemy')?.dataset.enemyId,
            ground: document.elementFromPoint(groundBox.x + groundBox.width / 2, groundBox.bottom - 3)
              ?.closest('.row__enemies--targetable') === ground,
          }
        })
        assert.equal(hitSurfaces.boss, 'boss', `${screen}: empty ground steals boss HP-bar taps`)
        assert(hitSurfaces.ground, `${screen}: cleared-row ground is not tappable`)
        const glow = await page.locator('[data-enemy-id="boss"]').evaluate(enemy => ({
          target: getComputedStyle(enemy).filter,
          art: getComputedStyle(enemy.querySelector('.enemy__portrait')).filter,
          selected: enemy.matches('.enemy--targeted'),
        }))
        assert(glow.selected, `${screen}: boss cannot be targeted`)
        assert((phone ? glow.art : glow.target).includes('101, 232, 255'),
          `${screen}: boss selection halo is missing: ${JSON.stringify(glow)}`)
        const regularGlow = await page.locator('[data-enemy-id="living"] .enemy__portrait').evaluate(portrait =>
          getComputedStyle(portrait).filter)
        assert(!phone || regularGlow.includes('101, 232, 255'),
          `${screen}: regular enemy selection halo is missing: ${regularGlow}`)
        await page.screenshot({ path: resolve(output, `${engineName}-${screen}-choice.png`) })
        await activate(page.locator('[data-enemy-id="boss"] .enemy__hit-area'))
        await page.waitForFunction(() => window.fixture.state.enemies.find(enemy => enemy.uid === 'boss').hp === 18)
        assert.equal(await page.evaluate(() => window.fixture.state.enemies.find(enemy => enemy.uid === 'living').hp), 10,
          `${screen}: boss click also hit another row`)

        await page.evaluate(() => window.fixture.otherEmpty())
        await page.getByRole('button', { name: 'Use Combust+' }).click()
        const otherGround = page.getByRole('button', { name: 'Target Row Ironclad with Combust+ (the boss is hit)' })
        await otherGround.waitFor()
        await page.screenshot({ path: resolve(output, `${engineName}-${screen}-other-empty.png`) })
        await activate(otherGround)
        await page.waitForFunction(() => window.fixture.state.enemies.find(enemy => enemy.uid === 'boss').hp === 18)
        assert.equal(await page.evaluate(() => window.fixture.state.enemies.find(enemy => enemy.uid === 'living').hp), 10,
          `${screen}: clearing the row opposite the boss hit a living enemy`)

        await page.evaluate(() => window.fixture.noBoss())
        await page.getByRole('button', { name: 'Use Combust+' }).click()
        const ground = page.getByRole('button', { name: 'Target Row Defect with Combust+' })
        await ground.waitFor()
        assert.equal(await page.locator('.row__lane-target').count(), 0)
        assert.equal(await ground.evaluate(element => getComputedStyle(element).display), 'block')
        await page.screenshot({ path: resolve(output, `${engineName}-${screen}-empty-row.png`) })
        await activate(ground)
        await page.waitForFunction(() => !document.querySelector('.row__enemies--targetable'))
        assert.equal(await page.evaluate(() => window.fixture.state.enemies.find(enemy => enemy.uid === 'living').hp), 10)

        await page.evaluate(() => window.fixture.evoke())
        await page.getByRole('button', { name: /^Dual Cast,/ }).click()
        await page.getByRole('button', { name: /lightning slot 1/i }).click()
        await page.locator('[data-enemy-id="boss"].enemy--targeted').waitFor()
        assert.equal(await page.locator('.row__lane-target').count(), 0,
          `${screen}: lightning evoke still shows a redundant button`)
        await page.screenshot({ path: resolve(output, `${engineName}-${screen}-evoke.png`) })
        await activate(page.locator('[data-enemy-id="boss"] .enemy__hit-area'))
        await page.locator('[data-enemy-id="boss"].enemy--targeted').waitFor()
        if (phone) assert.equal(await page.locator('[data-enemy-id="boss"]').evaluate(enemy =>
          getComputedStyle(enemy).filter), 'none', `${screen}: touch hover restored the filtered card layer`)
        await activate(page.locator('[data-enemy-id="boss"] .enemy__hit-area'))
        await page.waitForFunction(() => window.fixture.state.enemies.find(enemy => enemy.uid === 'boss').hp < 20)
        assert.equal(await page.evaluate(() => window.fixture.state.enemies.find(enemy => enemy.uid === 'living').hp), 6,
          `${screen}: boss click did not resolve lightning's sole populated row`)

        await page.evaluate(() => window.fixture.evoke())
        await page.getByRole('button', { name: /^Dual Cast,/ }).click()
        await page.getByRole('button', { name: /lightning slot 1/i }).click()
        const lightningGround = page.getByRole('button', { name: 'Evoke Lightning in Row Defect (the boss is hit)' })
        await lightningGround.waitFor()
        await activate(lightningGround)
        await activate(lightningGround)
        await page.waitForFunction(() => window.fixture.state.enemies.find(enemy => enemy.uid === 'boss').hp < 20)
        assert.equal(await page.evaluate(() => window.fixture.state.enemies.find(enemy => enemy.uid === 'living').hp), 10,
          `${screen}: empty-row lightning choice should hit only the boss`)

        await page.evaluate(() => window.fixture.evoke())
        await page.getByRole('button', { name: /^Dual Cast,/ }).click()
        await page.getByRole('button', { name: /lightning slot 1/i }).click()
        await lightningGround.focus()
        await lightningGround.evaluate(element => element.dispatchEvent(new KeyboardEvent('keydown', {
          key: ' ', repeat: true, bubbles: true,
        })))
        await page.keyboard.press('Space')
        assert.equal(await page.evaluate(() => window.fixture.state.enemies.find(enemy => enemy.uid === 'boss').hp), 20,
          `${screen}: a repeated Space press resolved two Lightning choices`)
        await lightningGround.focus()
        await page.keyboard.press('Space')
        await page.waitForFunction(() => window.fixture.state.enemies.find(enemy => enemy.uid === 'boss').hp < 20)

        await page.evaluate(() => window.fixture.fourParty())
        await page.getByRole('button', { name: 'Use Combust+' }).click()
        await page.waitForTimeout(1100)
        await page.screenshot({ path: resolve(output, `${engineName}-${screen}-four-party.png`) })
        const crowdedGrounds = page.locator('.row__enemies--targetable')
        assert.equal(await crowdedGrounds.count(), 3)
        for (let index = 0; index < 3; index++) {
          const target = crowdedGrounds.nth(index)
          await target.scrollIntoViewIfNeeded()
          assert(await target.evaluate(node => {
            const rect = node.getBoundingClientRect()
            return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === node
          }), `${screen}: player HUD covers cleared row ${index + 1}`)
        }
        await activate(crowdedGrounds.last())
        await page.waitForFunction(() => window.fixture.state.enemies.find(enemy => enemy.uid === 'boss').hp === 18)
        assert.equal(await page.evaluate(() => window.fixture.state.enemies.find(enemy => enemy.uid === 'living').hp), 10)
        assert.deepEqual(errors, [])
        await context.close()
      }
    } finally {
      await browser.close()
    }
  }
} finally {
  await server.close()
}
console.log('Row targeting and highlights passed: desktop and horizontal phone.')
