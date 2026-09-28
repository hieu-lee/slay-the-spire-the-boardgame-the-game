// Focused coverage for Byrd wingbeats and Cultist's two rigid thrown sticks.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium, webkit, devices } from './lib/profile-browser.mjs'

const root = resolve(import.meta.dirname, '..')
const crios = process.argv.includes('--crios')
const engine = process.argv.includes('--webkit') || crios ? webkit : chromium
const output = resolve(root, 'artifacts/wing-and-throw', crios ? 'crios' : engine === webkit ? 'webkit' : 'chromium')
mkdirSync(output, { recursive: true })
const server = await createServer({ root, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } })
await server.listen()
const browser = await engine.launch({ headless: true })
const errors = []
try {
  for (const [screen, viewport] of [['desktop', { width: 1440, height: 900 }], ['horizontal-phone', { width: 844, height: 390 }]]) {
    const context = await browser.newContext({ viewport, isMobile: screen === 'horizontal-phone', hasTouch: screen === 'horizontal-phone',
      ...(crios && screen === 'horizontal-phone' ? { userAgent: devices['iPhone 13 landscape'].userAgent.replace(/Version\/[\d.]+/, 'CriOS/147.0.0.0') } : {}),
      ...(process.argv.includes('--record') ? { recordVideo: { dir: output, size: viewport } } : {}) })
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(String(error)))
    page.on('response', response => {
      if (response.status() >= 400 && /\/assets\/combat\//.test(response.url())) errors.push(`${response.status()} ${response.url()}`)
    })
    // Enemies always use WebP. Keep unrelated hero HEVC decoding out of this
    // focused check: Linux WebKit can advertise HEVC without native alpha.
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?combat-webp=1`)
    await page.evaluate(async () => {
      document.querySelector('#root').style.display = 'none'
      document.documentElement.dataset.mobilePerformance = String(innerWidth < 900)
      document.documentElement.dataset.reducedMotion = 'false'
      const node = document.createElement('div')
      node.className = 'app-shell app-shell--combat sts-scope'
      node.style.gridTemplateRows = 'minmax(0, 1fr)'
      document.body.append(node)
      const [R, D, { CombatScreen }, { createPlayer }, { createCombat }, { createRng }] = await Promise.all([
        import('/@id/react'), import('/@id/react-dom/client'), import('/src/ui/CombatScreen.tsx'),
        import('/src/game/run.ts'), import('/src/game/combat.ts'), import('/src/game/rng.ts'),
        import('/src/ui/styles.css'), import('/src/ui/chrome.css'),
      ])
      const view = (D.createRoot ?? D.default.createRoot)(node)
      const f = window.fixture = { restoration: 0 }
      f.render = () => view.render((R.createElement ?? R.default.createElement)(CombatScreen, {
        state: structuredClone(f.state), act: 1, viewerId: 'p1', autoAdvance: false,
        authoritativeRestoration: f.restoration, onAction: () => {},
      }))
      f.install = (defId, multiplayer = false) => {
        if (defId === 'byrd') defId = 'byrd_encounter'
        const rng = createRng(47)
        const players = Array.from({ length: multiplayer ? 4 : 1 }, (_, i) => {
          const player = createPlayer(rng, `p${i+1}`, `Player ${i+1}`, 'defect', i)
          player.hand = []; player.draw = []; player.relics = []
          player.hp = player.maxHp = 99
          if (i === 3) { player.dead = true; player.hp = 0 }
          return player
        })
        const enemy = { uid: 'enemy-0', defId, row: 0, isBoss: false, hp: 99, maxHp: 99,
          block: 0, strength: 0, vulnerable: 0, weak: 0, poison: 0, actionIndex: 0, abilityUsed: false, dead: false }
        f.state = createCombat(rng, players, [enemy])
        f.state.players.forEach((player, i) => { player.row = i; player.facingEnemyUid = enemy.uid })
        f.state.phase = 'player'; f.state.presentationEvents = []; f.state.die = 1
        f.restoration++; f.render()
      }
    })
    await page.evaluate(() => window.fixture.install('byrd'))
    const art = page.locator('.enemy__art--cutout:not([data-inactive])')
    await page.waitForFunction(() => [...document.querySelectorAll('.enemy__art--cutout')].some(image => image.complete && image.naturalWidth))
    // CSS is static while these pixels move; this must be the baked wingbeat.
    const firstWingPose = await art.screenshot()
    await page.waitForTimeout(250)
    assert.notDeepEqual(firstWingPose, await art.screenshot(), `${screen}: wing texture is frozen`)
    const clearance = await art.evaluate(image => {
      const r = image.getBoundingClientRect()
      const fit = Math.min(r.width/image.naturalWidth, r.height/image.naturalHeight)
      const top = r.bottom-(image.naturalHeight-47)*fit
      return top-image.closest('.enemy').querySelector('.enemy__intent').getBoundingClientRect().bottom
    })
    assert(clearance > 4, `${screen}: raised wing overlaps attack intent (${clearance}px)`)
    await page.screenshot({ path: resolve(output, `${screen}-byrd-idle.png`), scale: 'css' })

    for (const multiplayer of [false, true]) {
      await page.evaluate(multiplayer => window.fixture.install('cultist', multiplayer), multiplayer)
      await page.waitForFunction(multiplayer => document.querySelector('.combat')?.dataset.partySize === (multiplayer ? '4' : '1') &&
        document.querySelector('.enemy__art--cutout')?.src.includes('cultist-idle'), multiplayer)
      // Wait for the encounter preloads, including the one-shot blob and prop.
      await page.waitForLoadState('networkidle')
      const before = await art.boundingBox()
      let previous
      for (let repeat = 0; repeat < 2; repeat++) {
        // Observe the first painted attack in-page. WebKit protocol round trips
        // can consume the entire one-shot before a remote sampling call arrives.
        const sample = await page.evaluate(async label => {
          const started = new Promise((resolve, reject) => {
            const observer = new MutationObserver(() => {
              const enemy = document.querySelector('.enemy--acting')
              if (!enemy) return
              observer.disconnect(); clearTimeout(timeout); resolve(enemy)
            })
            const timeout = setTimeout(() => { observer.disconnect(); reject(new Error(`${label}: throw did not start; phase=${document.querySelector('.combat')?.dataset.phase}; enemy=${document.querySelector('.enemy')?.outerHTML.slice(0, 800)}`)) }, 10000)
            observer.observe(document.body, { attributes: true, childList: true, subtree: true })
          })
          const f = window.fixture; f.state.phase = 'enemy'; f.render()
          const enemy = await started
          const source = enemy.querySelector('.enemy__art--cutout:not([data-inactive])').src
          const projectiles = [...enemy.querySelectorAll('.boss-projectile')]
          const { delay, duration } = projectiles[0].getAnimations()[0].effect.getTiming()
          const targets = projectiles.map(e => e.dataset.targetPlayer).sort()
          const props = projectiles.flatMap(e => [...e.children])
          await new Promise(resolve => setTimeout(resolve, 550))
          const timing = { delay, duration, ready: props.every(i => i.complete && i.naturalWidth) }
          const image = enemy.querySelector('.enemy__art--cutout:not([data-inactive])')
          const r = image?.getBoundingClientRect()
          return { source, asset: image.dataset.animationAsset, targets, count: props.length, timing, motion: enemy.dataset.attackMotion,
            animation: enemy.dataset.animation, after: r && { x: r.x, y: r.y, width: r.width, height: r.height } }
        }, `${screen}/${multiplayer ? 'party' : 'solo'}/${repeat}`)
        assert(sample.source.startsWith('blob:') && sample.source !== previous, 'throw must replay from a fresh blob')
        assert(sample.asset.endsWith(engine === webkit ? '.svg' : '.webp'), 'wrong throw playback for this browser')
        previous = sample.source
        assert.equal(sample.motion, 'ranged')
        assert.deepEqual(sample.targets, ['p1'], 'throw hit dead or unrelated-row player')
        assert.equal(sample.count, sample.targets.length * 2, 'two sticks per target')
        assert.deepEqual(sample.timing, { delay: 500, duration: 230, ready: true })
        assert.equal(sample.animation, 'attack', 'sample missed the live throw')
        assert(sample.after && Math.abs(before.width-sample.after.width)<1 && Math.abs(before.height-sample.after.height)<1, 'throw changes body scale')
        assert(Math.abs(before.x-sample.after.x)<before.width*.03, 'Cultist lunges instead of throwing from home')
        if (repeat === 0) {
          const path = resolve(output, `${screen}-cultist-${multiplayer ? 'party' : 'solo'}.png`)
          await page.screenshot({ path, scale: 'css' })
          // Native WebP frames alone cannot detect WebKit retaining its first
          // composited frame while CSS projectiles fly. Inspect the right hand;
          // airborne sticks can legitimately cross the left-hand region.
          const pixels = spawnSync('python3', ['-c', `
import json, sys
from PIL import Image
import numpy as np
im = Image.open(sys.argv[1]).convert('RGB')
r = json.loads(sys.argv[2]); fit = r['width']/800
box = tuple(round(v) for v in (r['x']+450*fit,r['y']+100*fit,r['x']+750*fit,r['y']+700*fit))
p = np.array(im.crop(box))
red = ((p[:,:,0]>170)&(p[:,:,1]<105)&(p[:,:,2]<105)).sum()
assert red<10, f'Cultist still holds red sticks during flight/recovery: {red} pixels'
`, path, JSON.stringify(sample.after)], { encoding: 'utf8' })
          assert.equal(pixels.status, 0, pixels.stderr)
        }
        if (multiplayer && repeat === 1) {
          await page.evaluate(() => { const f = window.fixture; f.restoration++; f.render() })
          await page.waitForFunction(() => document.querySelector('.enemy')?.dataset.animation === 'idle')
          assert.equal(await page.locator('.boss-projectile').count(), 0, 'reconnect leaves flying sticks')
        } else {
          await page.waitForFunction(() => document.querySelector('.enemy')?.dataset.animation === 'idle')
          assert.equal(await page.locator('.boss-projectile, .enemy-projectile-impact').count(), 0, 'throw effects outlive recovery')
        }
        await page.evaluate(() => { const f = window.fixture; f.state.phase = 'player'; f.render() })
        await page.waitForFunction(() => document.querySelector('.combat')?.dataset.phase === 'player')
      }
    }
    for (const id of ['byrd', 'cultist']) {
      await page.evaluate(id => {
        document.documentElement.dataset.reducedMotion = 'true'
        window.fixture.install(id)
      }, id)
      await page.waitForFunction(() => document.querySelector('.enemy')?.dataset.animation === 'static')
      assert.equal(await page.locator('.enemy').getAttribute('data-animation'), 'static')
      await page.evaluate(() => { const f = window.fixture; f.state.phase = 'enemy'; f.render() })
      await page.waitForTimeout(100)
      assert.equal(await page.locator('.boss-projectile').count(), 0, 'reduced motion still throws')
    }
    await context.close()
    console.log(`PASS ${screen}: wingbeat, scale, release, targets, replay, reconnect and reduced motion`)
  }
  assert.deepEqual(errors, [])
} finally {
  await browser.close()
  await server.close()
}
