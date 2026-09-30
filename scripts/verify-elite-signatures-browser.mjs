import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createServer } from 'vite'
import { chromium, webkit } from './lib/profile-browser.mjs'

const output = resolve('artifacts/elite-signatures')
mkdirSync(output, { recursive: true })
const server = await createServer({ logLevel: 'silent', server: { port: 0 } })
await server.listen()
const browser = await (process.argv.includes('--webkit') ? webkit : chromium).launch({ headless: true })
const errors = []
try {
  for (const [screen, viewport] of [['desktop', { width: 1440, height: 900 }], ['horizontal-phone', { width: 844, height: 390 }]]) {
    const context = await browser.newContext({ viewport, isMobile: screen === 'horizontal-phone', hasTouch: screen === 'horizontal-phone',
      recordVideo: { dir: output, size: viewport } })
    const page = await context.newPage()
    await page.addInitScript(identity => localStorage.setItem('sts-profile', JSON.stringify(identity)),
      { username: `EliteAudit${randomUUID().slice(0, 8)}`, token: randomUUID() })
    await page.addInitScript(() => {
      const decodeImage = HTMLImageElement.prototype.decode
      HTMLImageElement.prototype.decode = function () {
        const decoded = decodeImage.call(this)
        if (window.holdColdDecode && (this.src.endsWith('/lagavulin-idle.webp') || this.dataset.animationLayer === 'attack')) {
          const name = this.dataset.animationLayer === 'attack' ? 'releaseColdAttack' : 'releaseColdIdle'
          return decoded.then(() => new Promise(resolve => { window[name] = resolve }))
        }
        if (window.holdGuardianDecode && this.src.endsWith('/guardian_defensive-idle.webp')) {
          return decoded.then(() => new Promise(resolve => { window.releaseGuardianDecode = resolve }))
        }
        return this.src.endsWith('/lagavulin-idle.webp')
          ? decoded.then(() => new Promise(resolve => setTimeout(resolve, 900))) : decoded
      }
      window.signatureLayerFaults = []
      window.signatureCharges = []
      window.signatureChargeSampled = false
      const sampleLayers = () => {
        const enemy = document.querySelector('.enemy')
        if (enemy) {
          const bodies = [...enemy.querySelectorAll('.enemy__portrait > .enemy__art--cutout')].filter(image => {
            const style = getComputedStyle(image)
            return style.visibility !== 'hidden' && Number(style.opacity) > 0
          })
          if (bodies.length !== 1 || !bodies[0]?.complete || !bodies[0]?.naturalWidth ||
            getComputedStyle(bodies[0]).backgroundImage !== 'none') {
            window.signatureLayerFaults.push({ actor: enemy.dataset.enemyDef, mode: enemy.dataset.animation,
              layers: bodies.length, decoded: Boolean(bodies[0]?.naturalWidth), source: bodies[0]?.dataset.animationAsset,
              poster: bodies[0] && getComputedStyle(bodies[0]).backgroundImage })
          }
          const charge = enemy.querySelector('.reptomancer-charge')
          const body = bodies[0]
          const animations = charge && body?.naturalWidth
            ? [body, charge.parentElement, charge].flatMap(element => element.getAnimations()).filter(animation => typeof animation.animationName === 'string') : []
          if (!window.signatureChargeSampled && animations.length === 3 && animations.every(animation => animation.currentTime !== null && animation.startTime !== null)) {
            const clocks = animations.map(animation => animation.currentTime)
            const states = animations.map(animation => animation.playState)
            animations.forEach(animation => { animation.pause(); animation.currentTime = 730 })
            const orb = charge.getBoundingClientRect(), rect = body.getBoundingClientRect()
            const fit = Math.min(rect.width / body.naturalWidth, rect.height / body.naturalHeight)
            window.signatureCharges.push({ opacity: Number(getComputedStyle(charge).opacity),
              x: (orb.x + orb.width / 2 - rect.left - (rect.width - body.naturalWidth * fit) / 2) / fit,
              y: (orb.y + orb.height / 2 - rect.bottom + body.naturalHeight * fit) / fit })
            animations.forEach((animation, index) => {
              animation.currentTime = clocks[index]
              if (states[index] === 'running') animation.play()
            })
            window.signatureChargeSampled = true
          }
        }
        requestAnimationFrame(sampleLayers)
      }
      requestAnimationFrame(sampleLayers)
      window.signatureBeats = []
      window.signatureSlashClocks = []
      window.signatureModes = []
      window.signatureAttacks = []
      document.addEventListener('load', event => {
        if (event.target.dataset?.animationLayer === 'transition' && event.target.src?.startsWith('blob:')) {
          window.signatureModes.push({ source: event.target.dataset.animationAsset, url: event.target.src })
        }
        if (event.target.dataset?.animationLayer === 'attack' && event.target.naturalWidth > 0) {
          window.signatureAttacks.push({ source: event.target.dataset.animationAsset, url: event.target.src })
        }
      }, true)
      new MutationObserver(() => {
        const image = document.querySelector('.enemy.enemy--acting img[data-animation-layer="attack"]')
        if (!image) return
        const style = getComputedStyle(image)
        if (!window.signatureBeats.some(beat => beat.url === image.src && beat.name === style.animationName)) {
          window.signatureBeats.push({ name: style.animationName, url: image.src,
            duration: parseFloat(style.animationDuration) * 1000, delay: parseFloat(style.animationDelay) * 1000 })
        }
        window.signatureSlashClocks = [...image.closest('.enemy').querySelectorAll('.gremlin-delayed-slash')].map(target => {
          const effect = getComputedStyle(target)
          return { target: target.dataset.targetPlayer, name: effect.animationName, delay: parseFloat(effect.animationDelay) * 1000 }
        })
      }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] })
    })
    page.on('pageerror', error => errors.push(String(error)))
    page.on('response', response => {
      if (response.status() >= 400 && response.url().includes('/assets/combat/')) errors.push(`${response.status()} ${response.url()}`)
    })
    await page.goto(`http://localhost:${server.httpServer.address().port}/?combat-webp=1`)
    await page.evaluate(async () => {
      document.querySelector('#root').style.display = 'none'
      document.documentElement.dataset.mobilePerformance = String(innerWidth < 900)
      document.documentElement.dataset.reducedMotion = 'false'
      const node = document.createElement('div')
      node.className = 'app-shell app-shell--combat sts-scope'
      node.style.gridTemplateRows = 'minmax(0, 1fr)'
      document.body.append(node)
      const [React, ReactDOM, { CombatScreen }, { createPlayer }, { createCombat }, { createRng }, { actionsForEnemy }, { enemyTurn }] = await Promise.all([
        import('/@id/react'), import('/@id/react-dom/client'), import('/src/ui/CombatScreen.tsx'), import('/src/game/run.ts'),
        import('/src/game/combat.ts'), import('/src/game/rng.ts'), import('/src/game/enemies.ts'), import('/src/game/combat.ts'),
        import('/src/ui/styles.css'), import('/src/ui/chrome.css'),
      ])
      const root = (ReactDOM.createRoot ?? ReactDOM.default.createRoot)(node)
      const fixture = window.eliteFixture = { restoration: 0, autoAdvance: false }
      fixture.render = () => root.render((React.createElement ?? React.default.createElement)(CombatScreen, {
        state: structuredClone(fixture.state), act: 1, viewerId: 'p1', autoAdvance: fixture.autoAdvance,
        authoritativeRestoration: fixture.restoration, authoritativeConnected: fixture.connected,
        onChange: next => { fixture.state = next; fixture.changedAt = performance.now(); fixture.render() },
      }))
      fixture.install = (defId, ascension = 0, sleep = false) => {
        const rng = createRng(47)
        const players = ['p1', 'p2'].map((id, index) => {
          const player = createPlayer(rng, id, 'ironclad', 'ironclad', index)
          player.hp = player.maxHp = 99
          player.hand = []; player.draw = []; player.relics = []
          return player
        })
        const enemy = { uid: 'elite-review', defId, row: 0, isBoss: defId.startsWith('guardian'), ascension,
          hp: 999, maxHp: 999, block: 0, strength: 0, vulnerable: 0, weak: 0, poison: 0, actionIndex: 0, abilityUsed: false, dead: false }
        fixture.state = createCombat(rng, players, [enemy])
        fixture.state.phase = 'player'; fixture.state.presentationEvents = []
        fixture.state.players.forEach(player => { player.facingEnemyUid = enemy.uid })
        if (!sleep) {
          let found = false
          for (let die = 1; die <= 6 && !found; die++) for (let index = 0; index < 6 && !found; index++) {
            if (actionsForEnemy({ ...enemy, actionIndex: index }, die).some(action => action.kind === 'attack' || action.kind === 'attackSequence')) {
              fixture.state.die = die; fixture.state.enemies[0].actionIndex = index; found = true
            }
          }
        }
        fixture.autoAdvance = false; fixture.connected = true; fixture.restoration++; fixture.render()
      }
      fixture.attack = autoAdvance => { fixture.autoAdvance = autoAdvance; fixture.state.phase = 'enemy'; fixture.render() }
      fixture.finishSleepingTurn = () => { fixture.state = enemyTurn({ ...fixture.state, phase: 'enemy' }); fixture.render() }
      fixture.install('lagavulin', 0, true)
    })
    const enemy = page.locator('.enemy[data-enemy-id="elite-review"]')
    await page.waitForFunction(() => document.querySelector('.enemy[data-sleeping] img[data-animation-layer="idle"]')?.complete)
    assert.equal(await enemy.getAttribute('data-sleeping'), 'true', `${screen}: A0 sleep`)
    assert.equal(await enemy.locator('.enemy-sleep-zzz span').count(), 3)
    await enemy.screenshot({ path: resolve(output, `${screen}-lagavulin-sleep.png`) })
    await page.route('**/combat/enemies/animated/lagavulin-idle.webp', async route => {
      await new Promise(resolve => setTimeout(resolve, 1800))
      await route.continue()
    })
    await page.evaluate(() => { window.signatureLayerFaults = [] })
    await page.evaluate(() => window.eliteFixture.finishSleepingTurn())
    await page.waitForFunction(() => document.querySelector('.enemy')?.dataset.animation === 'transition')
    await page.waitForFunction(() => window.signatureModes.some(mode => mode.source.includes('lagavulin-wake')))
    await page.waitForFunction(() => document.querySelector('.enemy')?.dataset.animation === 'idle')
    assert.deepEqual(await page.evaluate(() => window.signatureLayerFaults), [], `${screen}: wake must never lose its decoded body`)
    await page.unroute('**/combat/enemies/animated/lagavulin-idle.webp')
    assert.equal(await enemy.locator('.enemy-sleep-zzz').count(), 0)
    await page.evaluate(() => {
      window.holdColdDecode = true
      window.releaseColdIdle = null; window.releaseColdAttack = null
      window.eliteFixture.install('lagavulin', 0, true)
    })
    await page.waitForFunction(() => document.querySelector('.enemy')?.dataset.sleeping === 'true')
    await page.evaluate(() => { window.signatureLayerFaults = []; window.eliteFixture.finishSleepingTurn() })
    await page.waitForFunction(() => typeof window.releaseColdIdle === 'function')
    await page.evaluate(() => window.eliteFixture.attack(false))
    await page.waitForFunction(() => typeof window.releaseColdAttack === 'function')
    await page.waitForTimeout(200)
    assert.deepEqual(await page.evaluate(() => window.signatureLayerFaults), [], `${screen}: cold attack must preserve the outgoing decoded body`)
    await page.evaluate(() => window.releaseColdAttack())
    await page.waitForFunction(() => document.querySelector('.enemy')?.dataset.animation === 'attack')
    await page.waitForFunction(() => document.querySelector('.enemy')?.dataset.animation !== 'attack')
    assert.deepEqual(await page.evaluate(() => window.signatureLayerFaults), [], `${screen}: cold attack return must preserve a decoded body`)
    await page.evaluate(() => { window.holdColdDecode = false; window.releaseColdIdle() })
    await page.waitForFunction(() => document.querySelector('.enemy')?.dataset.animation === 'idle')
    await page.evaluate(() => window.eliteFixture.install('lagavulin', 1, true))
    await page.waitForFunction(() => document.querySelector('.enemy')?.dataset.animation === 'idle')
    assert.equal(await enemy.getAttribute('data-sleeping'), null, `${screen}: A1 must not sleep`)

    for (const actor of ['lagavulin', 'gremlin_leader', 'reptomancer', 'guardian_attack', 'guardian_defensive']) {
      await page.evaluate(actor => window.eliteFixture.install(actor), actor)
      await page.waitForFunction(actor => document.querySelector('.enemy')?.dataset.enemyDef === actor &&
        document.querySelector('.enemy')?.dataset.animation === 'idle', actor)
      await page.waitForFunction(() => {
        const image = document.querySelector('.enemy img[data-animation-layer="idle"]')
        return image?.complete && image.naturalWidth > 0
      })
      await page.waitForTimeout(200)
      await page.screenshot({ path: resolve(output, `${screen}-${actor}-idle.png`), clip: await page.locator('.board').boundingBox() })
      let previousUrl
      for (let repeat = 0; repeat < 2; repeat++) {
        await page.evaluate(() => {
          window.signatureBeats = []; window.signatureSlashClocks = []; window.signatureAttacks = []
          window.signatureLayerFaults = []
          window.signatureCharges = []
          window.signatureChargeSampled = false
          window.eliteFixture.attack(false)
        })
        await page.waitForFunction(() => window.signatureAttacks.length > 0).catch(async error => {
          const state = await page.evaluate(() => ({ phase: window.eliteFixture.state.phase,
            enemy: document.querySelector('.enemy')?.dataset.animation,
            images: [...document.querySelectorAll('.enemy [data-animation-layer]')].map(image => ({ src: image.src,
              layer: image.dataset.animationLayer, complete: image.complete, width: image.naturalWidth, fallback: image.dataset.fallback,
              inactive: image.dataset.inactive, style: image.getAttribute('style') })) }))
          throw new Error(`${screen} ${actor} repeat${repeat}: ${JSON.stringify(state)}`, { cause: error })
        })
        const attack = await page.evaluate(() => window.signatureAttacks.at(-1))
        const source = attack.url
        if (repeat > 0) assert.notEqual(source, previousUrl, `${actor}: one-shot did not restart`)
        previousUrl = source
        assert(attack.source.includes(`/enemies/animated/${actor}-attack`), `${actor}: old generic art`)
        if (actor === 'gremlin_leader') {
          await page.waitForFunction(() => window.signatureBeats.some(beat => beat.name === 'gremlin-iaijutsu'))
        }
        if (actor.startsWith('guardian_')) {
          await page.waitForFunction(() => window.signatureBeats.length > 0)
          const movement = actor === 'guardian_attack' ? 'guardian-boss-punch' : 'guardian-boss-roll'
          assert((await page.evaluate(() => window.signatureBeats)).some(beat => beat.name === movement), `${actor}: generic movement overrode its signature`)
        }
        await page.waitForFunction(() => document.querySelector('.enemy')?.dataset.animation === 'idle')
        if (actor === 'reptomancer') {
          const charges = await page.evaluate(() => window.signatureCharges)
          const visible = charges.filter(charge => charge.opacity > .5)
          assert(visible.length > 0, `${screen}: charge never became visible: ${JSON.stringify(charges)}`)
          assert(visible.every(charge => Math.abs(charge.x - 170) < 2 && Math.abs(charge.y - 742) < 2),
            `${screen}: orb must be between casting hands: ${JSON.stringify(visible)}`)
        }
        assert.deepEqual(await page.evaluate(() => window.signatureLayerFaults), [], `${screen}: ${actor} must have one decoded body without an idle poster`)
        if (actor === 'gremlin_leader') {
          const beats = await page.evaluate(() => window.signatureBeats)
          const body = beats.find(beat => beat.name === 'gremlin-iaijutsu')
          const impacts = await page.evaluate(() => window.signatureSlashClocks)
          assert(body, 'missing samurai dash')
          assert.deepEqual(impacts.map(beat => beat.target).sort(), ['p1', 'p2'], 'AoE must reach both living targets')
          assert.equal(body.duration, 1830, 'dash must share the sprite clock')
          assert.equal(body.delay, 0, 'dash must start with the sprite')
          assert(impacts.every(beat => beat.name === 'gremlin-slash-impact' && beat.delay === 730),
            `slash impact must follow the 330ms dash and 400ms hold: ${JSON.stringify(beats)}`)
        }
        await page.evaluate(() => { window.eliteFixture.state.phase = 'player'; window.eliteFixture.render() })
        await page.locator('.combat__phase--player').waitFor()
      }
    }

    await page.evaluate(() => window.eliteFixture.install('guardian_attack'))
    await page.waitForFunction(() => document.querySelector('.enemy')?.dataset.enemyDef === 'guardian_attack' &&
      document.querySelector('.enemy')?.dataset.animation === 'idle')
    const modeUrls = new Map()
    for (const [mode, animation] of [['guardian_defensive', 'guardian-close'], ['guardian_attack', 'guardian-open'],
      ['guardian_defensive', 'guardian-close'], ['guardian_attack', 'guardian-open']]) {
      await page.evaluate(mode => {
        window.signatureModes = []
        window.eliteFixture.state.enemies[0].defId = mode; window.eliteFixture.render()
      }, mode)
      await page.waitForFunction(animation => window.signatureModes.some(mode => mode.source.includes(animation)), animation)
      const url = await page.evaluate(() => window.signatureModes.at(-1).url)
      assert.notEqual(url, modeUrls.get(mode), `${mode}: transition did not restart`)
      modeUrls.set(mode, url)
      await page.waitForFunction(() => document.querySelector('.enemy')?.dataset.animation === 'idle')
    }
    await page.evaluate(() => {
      window.signatureLayerFaults = []
      window.holdGuardianDecode = true
      window.releaseGuardianDecode = null
      window.eliteFixture.state.enemies[0].defId = 'guardian_defensive'; window.eliteFixture.render()
    })
    await page.waitForFunction(() => document.querySelector('.enemy')?.dataset.animation === 'transition')
    await page.waitForFunction(() => typeof window.releaseGuardianDecode === 'function')
    await page.evaluate(() => {
      window.eliteFixture.state.enemies[0].defId = 'guardian_attack'; window.eliteFixture.render()
    })
    await page.waitForFunction(() => document.querySelector('.enemy')?.dataset.enemyDef === 'guardian_attack' &&
      document.querySelector('.enemy')?.dataset.animation === 'idle')
    assert.deepEqual(await page.evaluate(() => window.signatureLayerFaults), [], `${screen}: reversed mode must retain a decoded body and finish`)
    await page.evaluate(() => { window.holdGuardianDecode = false; window.releaseGuardianDecode() })
    await page.evaluate(() => window.eliteFixture.install('gremlin_leader'))
    await page.waitForTimeout(250)
    await page.evaluate(() => window.eliteFixture.attack(true))
    await page.waitForTimeout(500)
    assert.deepEqual(await page.evaluate(() => window.eliteFixture.state.players.map(player => player.hp)), [99, 99], 'damage preceded delayed contact')
    await page.waitForFunction(() => window.eliteFixture.state.players.every(player => player.hp < 99))
    await page.evaluate(() => { window.eliteFixture.connected = false; window.eliteFixture.restoration++; window.eliteFixture.render() })
    await page.waitForFunction(() => !document.querySelector('.enemy')?.classList.contains('enemy--acting'))
    assert.equal(await enemy.locator('.gremlin-delayed-slash').count(), 0, 'disconnect must clear pending impacts')
    await page.evaluate(() => window.eliteFixture.install('gremlin_leader'))
    await page.waitForFunction(() => document.querySelector('.enemy')?.dataset.animation === 'idle')
    await page.evaluate(() => {
      window.eliteFixture.restoration++
      window.eliteFixture.restoredAt = performance.now()
      window.eliteFixture.attack(true)
    })
    await page.waitForFunction(() => window.eliteFixture.state.players.every(player => player.hp < 99))
    const restorationDelay = await page.evaluate(() => window.eliteFixture.changedAt - window.eliteFixture.restoredAt)
    assert(restorationDelay < 2000, `restored enemy phase stalled ${restorationDelay}ms`)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.evaluate(() => {
      document.documentElement.dataset.reducedMotion = 'true'
      window.eliteFixture.install('lagavulin', 0, true)
    })
    await page.waitForFunction(() => document.querySelector('.enemy')?.dataset.sleeping === 'true' &&
      document.querySelector('.enemy')?.dataset.animation === 'static')
    await page.waitForFunction(() => {
      const image = document.querySelector('.enemy .enemy__art--cutout')
      return image?.complete && image.naturalWidth > 0
    })
    await page.evaluate(() => {
      const image = document.createElement('img')
      image.id = 'native-sleep-probe'
      image.src = document.querySelector('.enemy .enemy__art--cutout').src
      image.style = 'position:fixed;left:0;top:0;width:300px;height:280px;object-fit:contain;background:#263442;animation:none;transition:none;z-index:2147483647'
      document.body.append(image)
    })
    const sleepProbe = page.locator('#native-sleep-probe')
    await page.waitForFunction(() => document.querySelector('#native-sleep-probe').complete)
    const initialPixels = await sleepProbe.screenshot({ animations: 'allow', path: resolve(output, `${screen}-reduced-sleep-first.png`) })
    await page.waitForTimeout(350)
    assert((await sleepProbe.screenshot({ animations: 'allow', path: resolve(output, `${screen}-reduced-sleep-second.png`) })).equals(initialPixels), 'reduced-motion sleep must not animate')
    await sleepProbe.evaluate(image => image.remove())
    assert.equal(await enemy.locator('.enemy-sleep-zzz').count(), 1)
    await page.evaluate(() => {
      window.eliteFixture.state.enemies[0].hp = 0
      window.eliteFixture.state.enemies[0].dead = true
      window.eliteFixture.render()
    })
    await page.waitForFunction(() => !document.querySelector('.enemy-sleep-zzz'))
    assert.equal(await enemy.locator('.enemy-sleep-zzz').count(), 0, 'dead Lagavulin must not snore')
    await context.close()
  }
  assert.deepEqual(errors, [])
  console.log('PASS elite signatures: A0/A1 sleep and wake, Guardian modes, distinct attacks, AoE delay, repeat, restoration, reduced motion, desktop and horizontal phone')
} finally {
  await browser.close()
  await server.close()
}
