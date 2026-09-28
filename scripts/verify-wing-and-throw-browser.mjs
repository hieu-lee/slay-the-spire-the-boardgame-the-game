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
async function createFixturePage(context) {
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
      document.body.append(node)
      const [R, D, { CombatScreen }, { createPlayer }, { createCombat }, { createRng }] = await Promise.all([
        import('/@id/react'), import('/@id/react-dom/client'), import('/src/ui/CombatScreen.tsx'),
        import('/src/game/run.ts'), import('/src/game/combat.ts'), import('/src/game/rng.ts'),
        import('/src/ui/styles.css'), import('/src/ui/chrome.css'),
      ])
      const view = (D.createRoot ?? D.default.createRoot)(node)
      const f = window.fixture = { restoration: 0, autoAdvance: false, onAction: () => {} }
      const element = R.createElement ?? R.default.createElement
      f.render = () => view.render(element(R.Fragment ?? R.default.Fragment, null,
        element('header', { className: 'app-shell__header' }, element('h1', null, 'Ironclad · Cultist throw')),
        element(CombatScreen, {
        state: structuredClone(f.state), act: 1, viewerId: 'p1', autoAdvance: f.autoAdvance,
        authoritativeRestoration: f.restoration, onAction: f.onAction,
      })))
      f.install = (defId, multiplayer = false) => {
        if (defId === 'byrd') defId = 'byrd_encounter'
        const rng = createRng(47)
        const players = Array.from({ length: multiplayer ? 4 : 1 }, (_, i) => {
          const player = createPlayer(rng, `p${i+1}`, `Player ${i+1}`, 'ironclad', i)
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
  return page
}

async function observeCultistArrival(page) {
  await page.evaluate(() => {
    const f = window.fixture
    f.flightLocked = undefined
    const observer = new MutationObserver(() => {
      const projectile = document.querySelector('.boss-projectile')
      if (!projectile) return
      observer.disconnect()
      f.throwMountedAt = performance.now()
      f.throwSource = document.querySelector('.enemy__art--cutout[data-animation-layer="attack"]')?.dataset.animationAsset
      const board = projectile.closest('.board')
      const onLaunch = event => {
        if (event.animationName !== 'cultist-stick-flight') return
        board.removeEventListener('animationstart', onLaunch)
        const paths = [...projectile.children].map(stick => stick.style.offsetPath)
        const target = document.querySelector(`.seat[data-player-id="${CSS.escape(projectile.dataset.targetPlayer)}"] .seat__portrait`)
        // A late target-image alignment must not redirect an airborne stick.
        target.style.translate = '0 80px'
        board.dispatchEvent(new Event('loadeddata'))
        f.flightLocked = paths.every((path, index) => path === projectile.children[index].style.offsetPath)
        target.style.removeProperty('translate')
      }
      board.addEventListener('animationstart', onLaunch)
      const sampleClock = () => {
        const animation = projectile.getAnimations()[0]
        const time = animation?.currentTime
        if (typeof time === 'number') {
          const { delay, duration } = animation.effect.getTiming()
          f.throwArrivalAt = performance.now() + delay + duration - time
        }
        else requestAnimationFrame(sampleClock)
      }
      sampleClock()
    })
    observer.observe(document.body, { childList: true, subtree: true })
    f.state.phase = 'enemy'
    f.enemyPhaseAt = performance.now()
    f.render()
  })
  try {
    await page.waitForFunction(() => Number.isFinite(window.fixture.enemyResolvedAt) && Number.isFinite(window.fixture.throwArrivalAt), null, { timeout: 12000 })
  } catch (error) {
    const state = await page.evaluate(() => ({
      phase: document.querySelector('.combat')?.dataset.phase,
      animation: document.querySelector('.enemy')?.dataset.animation,
      art: document.querySelector('.enemy__art--cutout[data-animation-layer="attack"]')?.src,
      cover: document.querySelector('.cultist-release-cover')?.complete,
      projectile: Boolean(document.querySelector('.boss-projectile')),
      enemyResolvedAt: window.fixture.enemyResolvedAt,
      throwMountedAt: window.fixture.throwMountedAt,
      throwArrivalAt: window.fixture.throwArrivalAt,
      enemyPhaseAt: window.fixture.enemyPhaseAt,
      resources: performance.getEntriesByType('resource').filter(entry => /cultist-(idle|attack)/.test(entry.name))
        .map(entry => ({ name: entry.name.split('/').at(-1), start: Math.round(entry.startTime), duration: Math.round(entry.duration) })),
    }))
    throw new Error(`Cultist did not finish after cold load: ${JSON.stringify(state)}`, { cause: error })
  }
  assert.equal(await page.evaluate(() => window.fixture.flightLocked), true, 'late image alignment redirected a launched stick')
  return page.evaluate(() => {
    const { enemyPhaseAt, throwMountedAt, throwArrivalAt, throwSource, enemyResolvedAt } = window.fixture
    return { enemyPhaseAt, throwMountedAt, throwArrivalAt, throwSource, enemyResolvedAt }
  })
}

function assertCultistPixels(path, rect, target, hands = 'empty') {
  const pixels = spawnSync('python3', ['-c', `
import json, sys
from PIL import Image
import numpy as np
im = Image.open(sys.argv[1]).convert('RGB')
data = json.loads(sys.argv[2]); r = data['rect']; fit = r['width']/800
scale = im.width/r['viewportWidth']
def red(box):
    p = np.array(im.crop(tuple(round(v*scale) for v in box)))
    return ((p[:,:,0]>170)&(p[:,:,1]<105)&(p[:,:,2]<105)).sum()
held = red((r['x']+450*fit,r['y']+100*fit,r['x']+750*fit,r['y']+700*fit))
if data['hands'] == 'empty':
    assert held<10, f'Cultist still holds red sticks after release: {held} pixels'
elif data['hands'] == 'held':
    assert held>30, f'Cultist did not recover its held sticks: {held} pixels'
body = np.array(im.crop(tuple(round(v*scale) for v in (
    r['x']+180*fit,r['y']+430*fit,r['x']+680*fit,r['y']+850*fit))))
blue = ((body[:,:,2]>130)&(body[:,:,2]>body[:,:,0]*1.2)&
        (body[:,:,2]>body[:,:,1]*1.1)&(body[:,:,1]>70)).sum()
assert blue>80, f'Cultist body vanished during the throw: {blue} blue pixels'
if data.get('target'):
    t = data['target']
    visible = red((t['left'],min(t['top'],r['y']),r['x']-2,max(t['bottom'],r['y']+r['height'])))
    assert visible>50, f'Thrown sticks are not visible in the flight screenshot: {visible} red pixels'
`, path, JSON.stringify({ rect, target, hands })], { encoding: 'utf8' })
  assert.equal(pixels.status, 0, pixels.stderr)
}

try {
  let naturalCaptures = 0
  for (const [screen, viewport] of process.argv.includes('--cold-only') ? [] : [['desktop', { width: 1440, height: 900 }], ['horizontal-phone', { width: 844, height: 390 }]]) {
    const context = await browser.newContext({ viewport, isMobile: screen === 'horizontal-phone', hasTouch: screen === 'horizontal-phone',
      ...(crios && screen === 'horizontal-phone' ? { userAgent: devices['iPhone 13 landscape'].userAgent.replace(/Version\/[\d.]+/, 'CriOS/147.0.0.0') } : {}),
      ...(process.argv.includes('--record') ? { recordVideo: { dir: output, size: viewport } } : {}) })
    const page = await createFixturePage(context)
    await page.evaluate(() => window.fixture.install('byrd'))
    const art = page.locator('.enemy__art--cutout:not([data-inactive])')
    await page.waitForFunction(() => [...document.querySelectorAll('.enemy__art--cutout')].some(image => image.complete && image.naturalWidth))
    // CSS is static while these pixels move; this must be the baked wingbeat.
    const firstWingPose = await art.screenshot()
    let wingMoved = false
    for (let attempt = 0; attempt < 4 && !wingMoved; attempt++) {
      await page.waitForTimeout(250)
      wingMoved = !firstWingPose.equals(await art.screenshot())
    }
    assert(wingMoved, `${screen}: wing texture is frozen`)
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
        let sample
        for (let captureAttempt = 0; captureAttempt < 3; captureAttempt++) {
          try {
            sample = await page.evaluate(async ({ label, capture, stableCapture }) => {
              const started = new Promise((resolve, reject) => {
                const observer = new MutationObserver(() => {
                  const enemy = document.querySelector('.enemy--acting')
                  if (!enemy) return
                  observer.disconnect(); clearTimeout(timeout); resolve(enemy)
                })
                const timeout = setTimeout(() => { observer.disconnect(); reject(new Error(`${label}: throw did not start; phase=${document.querySelector('.combat')?.dataset.phase}; enemy=${document.querySelector('.enemy')?.outerHTML.slice(0, 800)}`)) }, 10000)
                observer.observe(document.body, { attributes: true, childList: true, subtree: true })
              })
              const f = window.fixture
              if (stableCapture) {
                // WebKit screenshot round trips can outlast this 1830ms one-shot.
                // Keep the real card mounted until its sampled frame is saved.
                const schedule = window.setTimeout.bind(window)
                const cancel = window.clearTimeout.bind(window)
                window.setTimeout = (callback, delay, ...args) => {
                  if (delay !== 1830) return schedule(callback, delay, ...args)
                  window.setTimeout = schedule
                  const id = schedule(callback, 5000, ...args)
                  f.finishCapture = () => { cancel(id); callback(...args) }
                  return id
                }
              }
              f.state.phase = 'enemy'; f.render()
              const enemy = await started
              const source = enemy.querySelector('.enemy__art--cutout:not([data-inactive])').src
              const projectiles = [...enemy.querySelectorAll('.boss-projectile')]
              const { delay, duration } = projectiles[0].getAnimations()[0].effect.getTiming()
              const impactDelay = enemy.querySelector('.enemy-projectile-impact > img').getAnimations()[0].effect.getTiming().delay
              const targets = projectiles.map(e => e.dataset.targetPlayer).sort()
              const props = projectiles.flatMap(e => [...e.children])
              const holdFrame = () => {
                const body = enemy.querySelector('.enemy__art--cutout[data-animation-layer="attack"]')
                const cover = enemy.querySelector('.cultist-release-cover')
                for (const element of [...projectiles, ...props, body, cover].filter(Boolean)) {
                  const style = getComputedStyle(element)
                  element.style.transform = style.transform
                  element.style.offsetDistance = style.offsetDistance
                  element.style.opacity = style.opacity
                  element.style.animation = 'none'
                }
                const impact = enemy.querySelector('.enemy-projectile-impact > img')
                if (impact) { impact.style.animation = 'none'; impact.style.opacity = '0' }
              }
              let live = null
              let late = null
              if (capture) live = await new Promise((resolve, reject) => {
                const startedAt = performance.now()
                const sampleFrame = () => {
                  const time = projectiles[0].getAnimations()[0]?.currentTime
                  const opacity = Number(getComputedStyle(projectiles[0]).opacity)
                  if (typeof time === 'number' && time >= delay + 100 && time < delay + duration && opacity > .5) {
                    if (stableCapture) holdFrame()
                    else for (const element of [...projectiles, ...props, enemy.querySelector('.enemy-projectile-impact > img')]) {
                      element.getAnimations().forEach(animation => animation.pause())
                    }
                    resolve({ time, opacity, natural: true })
                  } else if (typeof time === 'number' && time >= delay + duration || performance.now() - startedAt > 5000) {
                    if (!stableCapture) {
                      reject(new Error(`${label}: missed naturally rendered flight (time=${time})`))
                      return
                    }
                    // Headless WebKit can skip every JS sample in a short flight.
                    // Stage this screenshot, but count only naturally observed
                    // frames toward the live-flight assertion below.
                    for (const element of [...projectiles, ...props, enemy.querySelector('.enemy-projectile-impact > img')]) {
                      element.getAnimations().forEach(animation => { animation.pause(); animation.currentTime = delay + 125 })
                    }
                    holdFrame()
                    resolve({ time, opacity: Number(getComputedStyle(projectiles[0]).opacity), natural: false, stagedAt: delay + 125 })
                  } else requestAnimationFrame(sampleFrame)
                }
                requestAnimationFrame(sampleFrame)
              })
              else if (stableCapture) late = await new Promise((resolve, reject) => {
                const startedAt = performance.now()
                const sampleFrame = () => {
                  const body = enemy.querySelector('.enemy__art--cutout[data-animation-layer="attack"]')
                  const cover = enemy.querySelector('.cultist-release-cover')
                  const time = body?.getAnimations().find(animation => animation.animationName === 'cultist-held-visibility')?.currentTime
                  if (typeof time === 'number' && time >= 1510 && time < 1750) {
                    const frame = { time, body: Number(getComputedStyle(body).opacity), cover: Number(getComputedStyle(cover).opacity) }
                    holdFrame()
                    resolve(frame)
                  } else if (typeof time === 'number' && time >= 1750 || performance.now() - startedAt > 5000) {
                    reject(new Error(`${label}: missed naturally rendered recovery (time=${time})`))
                  } else requestAnimationFrame(sampleFrame)
                }
                requestAnimationFrame(sampleFrame)
              })
              else await new Promise(resolve => setTimeout(resolve, 550))
              await Promise.all(props.map(prop => prop.decode()))
              const flights = projectiles.map(projectile => {
                // Seek a hidden copy so geometry assertions cannot reset live playback.
                const probe = projectile.cloneNode(true)
                for (const element of [probe, ...probe.children]) {
                  element.style.removeProperty('animation')
                  element.style.removeProperty('transform')
                  element.style.removeProperty('offset-distance')
                  element.style.removeProperty('opacity')
                }
                probe.style.visibility = 'hidden'
                enemy.append(probe)
                probe.getBoundingClientRect()
                const sticks = [...probe.children]
                const animations = [probe, ...sticks].map(element => element.getAnimations()[0])
                animations.forEach(animation => animation.pause())
                const sample = time => {
                  animations.forEach(animation => { animation.currentTime = time })
                  return sticks.map(stick => {
                    const rect = stick.getBoundingClientRect()
                    const matrix = new DOMMatrix(getComputedStyle(stick).transform)
                    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, bottom: rect.bottom,
                      angle: Math.atan2(matrix.b, matrix.a) }
                  })
                }
                sample(delay - 1)
                const beforeRelease = Number(getComputedStyle(probe).opacity)
                const from = sample(delay), atRelease = Number(getComputedStyle(probe).opacity)
                const arc = [.1, .25, .5, .75, .9].map(t => sample(delay + duration * t))
                const middle = arc[2], to = sample(delay + duration)
                const target = document.querySelector(`.seat[data-player-id="${CSS.escape(projectile.dataset.targetPlayer)}"] .seat__portrait`)
                  .getBoundingClientRect()
                const flight = { from, middle, to, arc, beforeRelease, atRelease, target: { left: target.left, right: target.right, top: target.top, bottom: target.bottom },
                  spinTiming: sticks.map(stick => stick.getAnimations()[0].effect.getTiming()) }
                probe.remove()
                return flight
              })
              const timing = { delay, duration, ready: props.every(i => i.complete && i.naturalWidth) }
              const image = enemy.querySelector('.enemy__art--cutout:not([data-inactive])')
              const r = image?.getBoundingClientRect()
              return { source, asset: image.dataset.animationAsset, targets, count: props.length, timing, flights, impactDelay, live, late,
                motion: enemy.dataset.attackMotion, animation: enemy.dataset.animation,
                after: r && { x: r.x, y: r.y, width: r.width, height: r.height, viewportWidth: innerWidth } }
            }, { label: `${screen}/${multiplayer ? 'party' : 'solo'}/${repeat}`, capture: repeat === 0,
              stableCapture: engine === webkit })
            if (repeat === 0) {
              const path = resolve(output, `${screen}-cultist-${multiplayer ? 'party' : 'solo'}.png`)
              await page.screenshot({ path, scale: 'css' })
              assertCultistPixels(path, sample.after, sample.flights[0].target)
              await page.evaluate(() => {
                const f = window.fixture
                if (f.finishCapture) {
                  f.finishCapture()
                  f.finishCapture = undefined
                } else for (const element of document.querySelectorAll('.enemy--acting .boss-projectile, .enemy--acting .boss-projectile > img, .enemy--acting .enemy-projectile-impact > img')) {
                  element.getAnimations().forEach(animation => animation.play())
                }
              })
            }
            break
          } catch (error) {
            if (!/missed naturally rendered (flight|recovery)/.test(String(error)) || captureAttempt === 2) throw error
            // A busy WebKit frame can skip the entire short flight. A fresh
            // one-shot keeps screenshot sampling separate from gameplay timing.
            await page.evaluate(() => {
              const f = window.fixture
              f.finishCapture?.()
              f.finishCapture = undefined
              f.state.phase = 'player'
              f.restoration++
              f.render()
            })
            await page.waitForFunction(() => document.querySelector('.enemy')?.dataset.animation === 'idle')
          }
        }
        assert(sample)
        assert(sample.source.startsWith('blob:') && sample.source !== previous, 'throw must replay from a fresh blob')
        assert(sample.asset.endsWith(engine === webkit ? '.svg' : '.webp'), 'wrong throw playback for this browser')
        previous = sample.source
        assert.equal(sample.motion, 'ranged')
        assert.deepEqual(sample.targets, ['p1'], 'throw hit dead or unrelated-row player')
        assert.equal(sample.count, sample.targets.length * 2, 'two sticks per target')
        const expectedDelay = 500
        assert.deepEqual(sample.timing, { delay: expectedDelay, duration: 250, ready: true })
        if (repeat === 0) {
          if (sample.live.natural) {
            assert(sample.live.time >= expectedDelay + 100 && sample.live.time < expectedDelay + 250, 'screenshot missed the released throw pose')
            naturalCaptures++
          } else {
            assert(engine === webkit && sample.live.stagedAt === expectedDelay + 125,
              'only WebKit may stage a missed screenshot')
            console.log(`STAGED ${screen}/${multiplayer ? 'party' : 'solo'}: WebKit skipped the live screenshot window`)
          }
          assert(sample.live.opacity > .5, 'sticks are invisible during live flight')
        }
        assert.equal(sample.impactDelay, expectedDelay + 250, 'impact fires before sticks arrive')
        for (const flight of sample.flights) {
          assert.equal(flight.beforeRelease, 0, 'sticks duplicate the held props before release')
          assert.equal(flight.atRelease, 1, 'sticks disappear at the hand-to-flight transition')
          assert(flight.from[1].x - flight.from[0].x > 30,
            `sticks do not leave separate hands: ${JSON.stringify(flight.from)}`)
          for (let index = 0; index < 2; index++) {
            const from = flight.from[index], middle = flight.middle[index], to = flight.to[index]
            assert.deepEqual({ delay: flight.spinTiming[index].delay, duration: flight.spinTiming[index].duration },
              { delay: expectedDelay, duration: 250 }, 'stick spin is not synchronized with flight')
            assert(from.x > flight.target.right + 30, 'stick starts away from Cultist')
            assert(to.x >= flight.target.left && to.x <= flight.target.right &&
              to.y >= flight.target.top && to.y <= flight.target.bottom, 'stick misses the player')
            assert(middle.y < Math.min(from.y, to.y) - 8, 'stick does not rise above both ends of its arc')
            for (const frame of flight.arc) {
              assert(frame[index].y <= Math.max(from.y, to.y) + 1, 'stick drops below its hand-to-target line')
              assert(frame[index].bottom < flight.target.bottom, 'rotating stick clips the floor')
            }
            assert(Math.abs(middle.angle - from.angle) > 1, 'stick does not rotate in flight')
          }
        }
        assert.equal(sample.animation, 'attack', 'sample missed the live throw')
        assert(sample.after && Math.abs(before.width-sample.after.width)<1 && Math.abs(before.height-sample.after.height)<1, 'throw changes body scale')
        assert(Math.abs(before.x-sample.after.x)<before.width*.03, 'Cultist lunges instead of throwing from home')
        if (repeat !== 0) {
          if (engine === webkit) {
            const late = sample.late
            assert(late.time < 1830 && late.body > .9 && late.cover < .1,
              `WebKit release cover did not hand back to animated recovery: ${JSON.stringify(late)}`)
            const recoveryPath = resolve(output, `${screen}-cultist-${multiplayer ? 'party' : 'solo'}-late-recovery.png`)
            await page.screenshot({ path: recoveryPath, scale: 'css' })
            assertCultistPixels(recoveryPath, sample.after, undefined, 'held')
            await page.evaluate(() => { window.fixture.finishCapture?.(); window.fixture.finishCapture = undefined })
          } else {
            // Native WebP still shows empty hands just after the 250ms flight.
            await page.waitForTimeout(200)
            const recoveryPath = resolve(output, `${screen}-cultist-${multiplayer ? 'party' : 'solo'}-recovery.png`)
            await page.screenshot({ path: recoveryPath, scale: 'css' })
            assertCultistPixels(recoveryPath, sample.after)
          }
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
    await page.evaluate(() => {
      document.documentElement.dataset.reducedMotion = 'false'
      const f = window.fixture
      f.autoAdvance = true
      f.onAction = action => { if (action.kind === 'resolveEnemies') f.enemyResolvedAt = performance.now() }
      f.install('cultist')
    })
    await page.waitForFunction(() => document.querySelector('.combat')?.dataset.phase === 'player' &&
      document.querySelector('.enemy')?.dataset.animation === 'idle')
    const { throwArrivalAt, enemyResolvedAt } = await observeCultistArrival(page)
    const arrivalError = enemyResolvedAt - throwArrivalAt
    assert(arrivalError >= -10, `${screen}: Cultist damage resolves before its sticks arrive (${arrivalError}ms)`)
    await page.evaluate(() => {
      const f = window.fixture
      f.enemyResolvedAt = undefined
      f.install('cultist')
    })
    await page.waitForFunction(() => document.querySelector('.combat')?.dataset.phase === 'player' &&
      document.querySelector('.enemy')?.dataset.animation === 'idle')
    await page.evaluate(() => {
      const f = window.fixture
      f.state.phase = 'enemy'
      f.restoration++ // Reconnecting during this phase suppresses replay.
      f.enemyPhaseAt = performance.now()
      f.render()
    })
    await page.waitForFunction(() => Number.isFinite(window.fixture.enemyResolvedAt))
    const reconnectDelay = await page.evaluate(() => window.fixture.enemyResolvedAt - window.fixture.enemyPhaseAt)
    assert(reconnectDelay >= 700 && reconnectDelay < 2000, `${screen}: reconnect stalled enemy resolution (${reconnectDelay}ms)`)
    assert.equal(await page.locator('.boss-projectile').count(), 0, 'reconnect replayed a suppressed throw')
    await page.evaluate(() => {
      const f = window.fixture
      f.enemyResolvedAt = undefined
      f.install('cultist')
    })
    await page.waitForFunction(() => document.querySelector('.combat')?.dataset.phase === 'player' &&
      document.querySelector('.enemy')?.dataset.animation === 'idle')
    await page.evaluate(() => {
      const f = window.fixture
      const reconnectOnLaunch = event => {
        if (event.animationName !== 'cultist-stick-flight') return
        document.removeEventListener('animationstart', reconnectOnLaunch, true)
        f.midflightRestoredAt = performance.now()
        f.restoration++
        f.render()
      }
      document.addEventListener('animationstart', reconnectOnLaunch, true)
      f.state.phase = 'enemy'
      f.render()
    })
    await page.waitForFunction(() => Number.isFinite(window.fixture.midflightRestoredAt) &&
      Number.isFinite(window.fixture.enemyResolvedAt), null, { timeout: 4000 })
    const midflightDelay = await page.evaluate(() => window.fixture.enemyResolvedAt - window.fixture.midflightRestoredAt)
    assert(midflightDelay >= 700 && midflightDelay < 2000,
      `${screen}: midflight reconnect stalled enemy resolution (${midflightDelay}ms)`)
    assert.equal(await page.locator('.boss-projectile').count(), 0, 'midflight reconnect replayed sticks')
    await page.evaluate(() => {
      const f = window.fixture
      f.enemyResolvedAt = undefined
      f.resolveCalls = 0
      f.onAction = action => {
        if (action.kind !== 'resolveEnemies') return
        f.resolveCalls++
        if (f.resolveCalls === 1) f.enemyResolvedAt = performance.now()
        return new Promise(resolve => setTimeout(() => {
          f.autoAdvance = false
          f.state.phase = 'roundEnd'
          f.render()
          resolve()
        }, 2500))
      }
      f.install('cultist')
    })
    await page.waitForFunction(() => document.querySelector('.combat')?.dataset.phase === 'player' &&
      document.querySelector('.enemy')?.dataset.animation === 'idle')
    await observeCultistArrival(page)
    await page.evaluate(() => { const f = window.fixture; f.restoration++; f.render() })
    await page.waitForTimeout(1250)
    assert.equal(await page.locator('.combat').getAttribute('data-phase'), 'enemy', 'delayed response settled too early')
    assert.equal(await page.evaluate(() => window.fixture.resolveCalls), 1,
      `${screen}: reconnect sent duplicate resolveEnemies while the first response was pending`)
    await page.waitForFunction(() => document.querySelector('.combat')?.dataset.phase === 'roundEnd')
    await context.close()
    console.log(`PASS ${screen}: wingbeat, 250ms rotating throws, targets, replay, reconnect and reduced motion`)
  }
  if (!process.argv.includes('--cold-only')) assert(naturalCaptures >= 1, 'no naturally rendered Cultist flight was captured')
  for (const delayedAsset of engine === webkit ? ['cover', 'prop'] : ['prop']) {
    const coverContext = await browser.newContext({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true })
    let releaseCover, coverRequested
    const coverGate = new Promise(resolve => { releaseCover = resolve })
    const coverRequest = new Promise(resolve => { coverRequested = resolve })
    await coverContext.route(delayedAsset === 'cover'
      ? /\/assets\/combat\/enemies\/animated\/cultist-released\.webp(?:\?|$)/
      : /\/assets\/combat\/enemies\/props\/cultist-sticks\.webp(?:\?|$)/, async route => {
      coverRequested()
      await coverGate
      await route.continue()
    })
    const coverPage = await createFixturePage(coverContext)
    const attackResponse = coverPage.waitForResponse(response => /\/cultist-attack\.(?:svg|webp)(?:\?|$)/.test(response.url()) && response.ok())
    await coverPage.evaluate(() => {
      const f = window.fixture
      f.autoAdvance = true
      f.onAction = action => { if (action.kind === 'resolveEnemies') f.enemyResolvedAt = performance.now() }
      f.install('cultist')
    })
    await Promise.all([attackResponse, coverRequest])
    const delayedCover = observeCultistArrival(coverPage)
    await coverPage.waitForFunction(() => document.querySelector('.combat')?.dataset.phase === 'enemy')
    await coverPage.waitForTimeout(650)
    const prematureArt = await coverPage.locator('.enemy__art--cutout[data-animation-layer="attack"]').count()
    const prematureSticks = await coverPage.locator('.boss-projectile').count()
    releaseCover()
    assert.equal(prematureArt, 0, `Cultist body animated before its ${delayedAsset} was decoded`)
    assert.equal(prematureSticks, 0, `Cultist threw before its ${delayedAsset} was decoded`)
    const arrival = await delayedCover
    assert(arrival.throwMountedAt - arrival.enemyPhaseAt > 600, 'delayed cover did not defer the shared attack clock')
    assert(arrival.enemyResolvedAt - arrival.throwArrivalAt >= -10, 'cover delay made damage beat the sticks')
    await coverContext.close()
    console.log(`PASS horizontal-phone: delayed ${delayedAsset} keeps body and projectile clocks together`)
  }
  const delayedContext = await browser.newContext({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true })
  let delayedRequests = 0
  await delayedContext.route(/\/assets\/combat\/enemies\/animated\/cultist-(?:idle|attack)\.(?:webp|svg)(?:\?|$)/, async route => {
    delayedRequests++
    await new Promise(resolve => setTimeout(resolve, 4700))
    await route.continue()
  })
  const delayedPage = await createFixturePage(delayedContext)
  await delayedPage.evaluate(() => {
    const f = window.fixture
    f.autoAdvance = true
    f.onAction = action => { if (action.kind === 'resolveEnemies') f.enemyResolvedAt = performance.now() }
    f.install('cultist')
  })
  await delayedPage.waitForFunction(() => document.querySelector('.combat')?.dataset.phase === 'player' &&
    document.querySelector('.enemy__art--cutout')?.src.includes('cultist-idle'))
  const delayed = await observeCultistArrival(delayedPage)
  assert(delayedRequests > 0, 'delayed art route did not intercept a request')
  assert(delayed.throwMountedAt - delayed.enemyPhaseAt > 4000, 'cold art did not reach the five-second boundary')
  assert(delayed.throwSource?.includes(`cultist-attack.${engine === webkit ? 'svg' : 'webp'}`),
    'cold Cultist attack played idle art while throwing')
  assert(delayed.enemyResolvedAt - delayed.throwArrivalAt >= -10, 'damage resolves before delayed sticks arrive')
  await delayedContext.close()
  console.log('PASS horizontal-phone: near-timeout art finishes its windup and 250ms flight before damage')

  const slowContext = await browser.newContext({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true })
  await slowContext.route(/\/assets\/combat\/enemies\/animated\/cultist-(?:idle|attack)\.(?:webp|svg)(?:\?|$)/, async route => {
    await new Promise(resolve => setTimeout(resolve, 7000))
    await route.continue()
  })
  const slowPage = await createFixturePage(slowContext)
  await slowPage.evaluate(() => {
    const f = window.fixture
    f.autoAdvance = true
    f.resolveCalls = 0
    f.onAction = action => {
      if (action.kind !== 'resolveEnemies') return
      f.resolveCalls++
      if (f.resolveCalls === 1) f.enemyResolvedAt = performance.now()
      return new Promise(resolve => setTimeout(() => {
        f.autoAdvance = false
        f.state.phase = 'roundEnd'
        f.render()
        resolve()
      }, 6500))
    }
    f.install('cultist')
  })
  await slowPage.waitForFunction(() => document.querySelector('.combat')?.dataset.phase === 'player' &&
    document.querySelector('.enemy__art--cutout')?.src.includes('cultist-idle'))
  await slowPage.evaluate(() => {
    const f = window.fixture
    f.lateProjectiles = 0
    new MutationObserver(() => { if (document.querySelector('.boss-projectile')) f.lateProjectiles++ })
      .observe(document.body, { childList: true, subtree: true })
    f.state.phase = 'enemy'
    f.enemyPhaseAt = performance.now()
    f.render()
  })
  await slowPage.waitForFunction(() => Number.isFinite(window.fixture.enemyResolvedAt))
  const fallbackDelay = await slowPage.evaluate(() => window.fixture.enemyResolvedAt - window.fixture.enemyPhaseAt)
  assert(fallbackDelay >= 4900 && fallbackDelay < 6500, `slow art did not use the bounded fallback (${fallbackDelay}ms)`)
  await slowPage.evaluate(() => { const f = window.fixture; f.restoration++; f.render() })
  await slowPage.waitForLoadState('networkidle')
  await slowPage.waitForTimeout(400)
  assert.equal(await slowPage.locator('.combat').getAttribute('data-phase'), 'enemy', 'server response arrived before the late-art gap')
  assert.equal(await slowPage.evaluate(() => window.fixture.lateProjectiles), 0, 'slow art threw after resolution was requested')
  assert.equal(await slowPage.locator('.boss-projectile').count(), 0, 'slow art left a projectile during server latency')
  await slowPage.waitForFunction(() => document.querySelector('.combat')?.dataset.phase === 'roundEnd')
  assert.equal(await slowPage.evaluate(() => window.fixture.resolveCalls), 1,
    'late-art reconnect sent duplicate resolveEnemies while the first response was pending')
  await slowContext.close()
  console.log('PASS horizontal-phone: timed-out art cannot throw during a delayed server response')
  assert.deepEqual(errors, [])
} finally {
  await browser.close()
  await server.close()
}
