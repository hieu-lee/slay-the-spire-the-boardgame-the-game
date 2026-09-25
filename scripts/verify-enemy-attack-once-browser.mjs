#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium, webkit } from './lib/profile-browser.mjs'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'artifacts/enemy-attack-once')
mkdirSync(output, { recursive: true })
const server = await createServer({ root, logLevel: 'silent', server: { port: 0 } })
await server.listen()
const browser = await (process.argv.includes('--webkit') ? webkit : chromium).launch({ headless: true })
const errors = []
try {
  for (const [screen, viewport] of [['desktop', { width: 1440, height: 900 }],
    ['horizontal-phone', { width: 844, height: 390 }]]) {
    const context = await browser.newContext({ viewport, isMobile: screen === 'horizontal-phone', hasTouch: screen === 'horizontal-phone' })
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(String(error)))
    await page.goto(`http://localhost:${server.httpServer.address().port}?combat-webp=1`)
    await page.evaluate(async () => {
      document.querySelector('#root').style.display='none'
      document.documentElement.dataset.mobilePerformance=String(matchMedia('(pointer: coarse)').matches || innerWidth<900)
      document.documentElement.dataset.reducedMotion='false'
      const node=document.createElement('div');node.className='app-shell app-shell--combat sts-scope';document.body.append(node)
      node.style.gridTemplateRows='minmax(0, 1fr)'
      const [R,D,{CombatScreen},{createPlayer},{createCombat},{createRng},{actionsForEnemy},] = await Promise.all([
        import('/@id/react'),import('/@id/react-dom/client'),import('/src/ui/CombatScreen.tsx'),
        import('/src/game/run.ts'),import('/src/game/combat.ts'),import('/src/game/rng.ts'),import('/src/game/enemies.ts'),
        import('/src/ui/styles.css'),import('/src/ui/chrome.css'),
      ])
      const reactRoot=(D.createRoot??D.default.createRoot)(node)
      const f=window.fixture={restoration:0}
      f.render=()=>reactRoot.render((R.createElement??R.default.createElement)(CombatScreen,{
        state:structuredClone(f.state),act:1,viewerId:'p1',autoAdvance:false,
        authoritativeRestoration:f.restoration,onAction:()=>{},
      }))
      f.install=(defId,isBoss)=>{
        const rng=createRng(47);const player=createPlayer(rng,'p1','Defect','defect',0)
        player.hp=player.maxHp=999;player.hand=[];player.draw=[];player.relics=[]
        const enemy={uid:'enemy-0',defId,row:0,isBoss,hp:999,maxHp:999,block:0,strength:0,vulnerable:0,weak:0,poison:0,actionIndex:0,abilityUsed:false,dead:false}
        f.state=createCombat(rng,[player],[enemy])
        f.state.players[0].facingEnemyUid='enemy-0'
        f.state.phase='player';f.state.presentationEvents=[]
        f.attacks=false
        for(let die=1;die<=6&&!f.attacks;die++)for(let actionIndex=0;actionIndex<8&&!f.attacks;actionIndex++){
          const actions=actionsForEnemy({...enemy,actionIndex},die)
          if(actions.some(a=>a.kind==='attack'||a.kind==='attackSequence')){
            f.state.die=die;f.state.enemies.forEach(e=>e.actionIndex=actionIndex);f.attacks=true
          }
        }
        f.restoration++;f.render()
      }
      window.attackStarts = []
      document.addEventListener('animationstart', event => {
        if (event.target.matches('.enemy__art--cutout:not([data-inactive])')) {
          window.attackStarts.push({ id: event.target.closest('.enemy').dataset.enemyDef, name: event.animationName, time: performance.now(), src: event.target.src })
        }
      })
    })
    // Boss, elite and normal melee paths, plus a ranged control. Repeat both reported enemies.
    for (const [id, isBoss] of [['guardian_defensive', true], ['lagavulin', false],
      ['gremlin_nob', false], ['jaw_worm', false], ['sentry_a', false]]) {
      await page.evaluate(([id, isBoss]) => window.fixture.install(id, isBoss), [id, isBoss])
      await page.locator(`[data-enemy-def="${id}"][data-animation="idle"]`).waitFor()
      await page.waitForLoadState('networkidle')
      for (let turn = 0; turn < (['guardian_defensive', 'lagavulin'].includes(id) ? 2 : 1); turn++) {
        await page.evaluate(() => { window.attackStarts = []; const f = window.fixture; f.state.phase = 'enemy'; f.render() })
        const art = page.locator('.enemy--acting .enemy__art--cutout:not([data-inactive])')
        await art.waitFor()
        // A late intent/status image load remeasures melee contact while moving.
        // Keep the Animation object and clock: a visually identical replacement is a restart.
        const result = await art.evaluate(image => {
          const animation = image.getAnimations()[0]
          animation.pause()
          animation.currentTime = 900
          const before = image.getBoundingClientRect()
          const icon = document.createElement('img')
          image.closest('.enemy').append(icon)
          for (let i = 0; i < 3; i++) {
            icon.dispatchEvent(new Event('load'))
            image.getBoundingClientRect()
          }
          icon.remove()
          const after = image.getBoundingClientRect()
          return { same: image.getAnimations()[0] === animation, time: animation.currentTime,
            shift: Math.abs(before.x - after.x) + Math.abs(before.y - after.y),
            dash: image.closest('.enemy').style.getPropertyValue('--boss-dash-x') }
        })
        assert(result.same, `${screen}/${id}: late image load replaced the attack animation`)
        assert(Math.abs(result.time - 900) < 1, `${screen}/${id}: late image load rewound the attack`)
        assert(result.shift < 1, `${screen}/${id}: contact measurement moved the attacker`)
        if (id !== 'sentry_a') assert(parseFloat(result.dash) < 0, `${screen}/${id}: missing melee travel`)
        await art.evaluate(image => image.getAnimations().forEach(animation => animation.play()))
        // Resolve the real engine turn while the original attack is recovering.
        await page.evaluate(async () => {
          const { enemyTurn } = await import('/src/game/combat.ts')
          const f = window.fixture; f.state = enemyTurn(f.state); f.render()
        })
        if (turn === 0 && ['guardian_defensive', 'lagavulin'].includes(id)) {
          await page.screenshot({ path: resolve(output, `${screen}-${id}.png`) })
        }
        await page.waitForFunction(() => document.querySelector('.enemy')?.dataset.animation === 'idle')
        assert.equal((await page.evaluate(() => window.attackStarts)).length, 1,
          `${screen}/${id}/turn ${turn}: expected one attack start per turn: ${JSON.stringify(await page.evaluate(() => window.attackStarts))}`)
        await page.evaluate(() => { const f = window.fixture; f.state.phase = 'player'; f.render() })
        await page.waitForTimeout(50)
      }
    }
    console.log(`PASS ${screen}: late loads preserve attack identity, clock and contact; real turn resolution and repeat turns`)
    await context.close()
  }
  assert.deepEqual(errors, [])
} finally {
  await browser.close()
  await server.close()
}
