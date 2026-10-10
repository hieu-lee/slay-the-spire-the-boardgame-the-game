import assert from 'node:assert/strict'
import { mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createServer } from 'vite'
import { chromium, webkit } from './lib/profile-browser.mjs'
import { installKratosFixture, paintedKratosBounds } from './lib/kratos-animation-fixture.mjs'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'artifacts/kratos-art/browser')
mkdirSync(output, { recursive: true })
const server = await createServer({ root, logLevel: 'silent', server: { port: 0 } })
await server.listen()
const origin = `http://localhost:${server.httpServer.address().port}`
const idle = '.seat__portrait > img'
// Every timed check follows the registered clock rather than restating its milliseconds.
const registration = JSON.parse(readFileSync(resolve(root, 'scripts/animation/sources/kratos/combo-v3/registration.json'), 'utf8'))
const keyEnds = [...registration.keys.slice(1).map(([time]) => time), registration.durationMs]
const beats = registration.keys.map(([time, pose], index) => [pose === 'idle' ? 'ready' : pose, (time + keyEnds[index]) / 2])
const beat = pose => beats.find(([name]) => name === pose)[1]
const idleReturn = registration.keys.at(-1)[0]
// Every registered drawing plus the light and impact VFX.
const assetsReady = new Set(registration.keys.map(([, pose]) => pose)).size + 2
// Every registered attack drawing, from the first cast to the blades flying home.
const strikeBeats = beats.slice(beats.findIndex(([pose]) => pose === 'left-cast'),
  beats.findIndex(([pose]) => pose === 'retract') + 1)
const errors = []
try {
  for (const [engine, type] of [['chromium', chromium], ['webkit', webkit]]
    .filter(([engine]) => !process.argv.some(arg => arg.startsWith('--engine=')) || process.argv.includes(`--engine=${engine}`))) {
    const browser = await type.launch({ headless: true })
    try {
      for (const [screen, viewport] of [['desktop', { width: 1440, height: 900 }],
        ['horizontal-phone', { width: 844, height: 390 }]]
        .filter(([screen]) => !process.argv.some(arg => arg.startsWith('--screen=')) || process.argv.includes(`--screen=${screen}`))) {
        const context = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: screen !== 'desktop',
          hasTouch: screen !== 'desktop',
          ...(process.argv.includes('--record') ? { recordVideo: { dir: output, size: viewport } } : {}) })
        let releaseColdArtwork
        try {
          const page = await context.newPage()
          page.on('pageerror', e => errors.push(String(e)))
          const soundRequests = new Set()
          page.on('request', request => { if (/\/sfx\/kratos-/.test(request.url())) soundRequests.add(new URL(request.url()).pathname.split('/').at(-1)) })
          await page.addInitScript(() => {
            window.kratosSounds = []
            const play = HTMLMediaElement.prototype.play
            HTMLMediaElement.prototype.play = function (...args) {
              if (this instanceof HTMLAudioElement) {
                window.kratosSounds.push({ path: new URL(this.src).pathname.split('/').at(-1), at: performance.now() })
                return Promise.resolve()
              }
              return play.apply(this, args)
            }
          })
          page.on('response', r => { if (r.status() >= 400 && /\/assets\/combat\//.test(r.url())) errors.push(`${r.status()} ${r.url()}`) })
          const coldArtwork = new Promise(resolve => { releaseColdArtwork = resolve })
          await page.route('**/kratos-slam.webp', async route => {
            await coldArtwork
            await route.continue()
          })
          await page.goto(origin)
          await page.evaluate(installKratosFixture)
          await page.waitForFunction(() => {
            const image = document.querySelector('.seat__portrait > img')
            return image?.complete && image.naturalWidth > 0
          })
          await page.evaluate(() => document.fonts.ready)
          await page.waitForFunction(() => [...document.querySelectorAll('.enemy__portrait img')].every(image => image.complete))
          await page.locator('.board').screenshot({ path: resolve(output, `${engine}-${screen}-cold-rest.png`) })
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
          // A truly cold play must still travel and hit on one shared clock.
          // Delaying beyond the event lifetime reproduces the reviewed regression.
          const cold = await page.evaluate(() => new Promise((resolve, reject) => {
            const onImpact = event => {
              if (event.detail.index !== 0) return
              clearTimeout(timeout)
              document.removeEventListener('kratos-impact', onImpact)
              const attack = document.querySelector('.character-attack--kratos')
              if (!attack) { reject(new Error('cold impact lost its attacking character')); return }
              const transform = getComputedStyle(attack).transform
              const time = attack.getAnimations()[0]?.currentTime
              const target = document.querySelector(`[data-kratos-impact-seq="${event.detail.seq}"]`)
              resolve({
                time, targetTime: target?.getAnimations()[0]?.currentTime,
                start: attack.getAnimations()[0]?.startTime, targetStart: target?.getAnimations()[0]?.startTime,
                x: new DOMMatrix(transform).e, fallback: Boolean(attack.querySelector('.is-fallback')),
                goal: getComputedStyle(attack).getPropertyValue('--attack-x'),
              })
            }
            const timeout = setTimeout(() => {
              document.removeEventListener('kratos-impact', onImpact)
              reject(new Error('cold combo never produced its first impact'))
            }, 15000)
            document.addEventListener('kratos-impact', onImpact)
            window.kratosFixture.attack()
          })).catch(error => { throw new Error(`${engine}/${screen}: ${error.message}`, { cause: error }) })
          assert(cold.fallback && cold.x > 10, `${engine}/${screen}: cold cutout never travels ${JSON.stringify(cold)}`)
          // WebKit clamps a finished impact's currentTime at delay + duration.
          // startTime is the shared clock even when a busy renderer reports it late.
          assert(Number.isFinite(cold.start) && Number.isFinite(cold.targetStart) &&
            Math.abs(cold.start - cold.targetStart) < 2, `cold attacker and target clocks separated: ${JSON.stringify(cold)}`)
          // Artwork landing mid-play must not swap in the drawings or re-aim the travel.
          releaseColdArtwork()
          await page.waitForFunction(ready => Number(document.querySelector('.board')?.dataset.characterAttackAssetsReady) === ready, assetsReady).catch(async error => {
            throw new Error(`${engine}/${screen}: warmup ${JSON.stringify(await page.locator('.board').evaluate(node => node.dataset))} ${JSON.stringify(errors)}`, { cause: error })
          })
          const warmed = await page.evaluate(() => {
            const attack = document.querySelector('.character-attack--kratos')
            return attack && { fallback: Boolean(attack.querySelector('.is-fallback')),
              goal: getComputedStyle(attack).getPropertyValue('--attack-x') }
          })
          assert.deepEqual(warmed, { fallback: true, goal: cold.goal }, `${engine}/${screen}: late artwork changed the cold play`)
          await page.waitForFunction(() => !document.querySelector('.character-attack'))
          await page.unroute('**/kratos-slam.webp')
          const rest = await page.evaluate(paintedKratosBounds, idle)
          assert(rest.width > 45 && rest.height > 70, `${engine}/${screen}: missing or tiny Kratos`)
          assert.deepEqual(await page.locator(idle).evaluate(image => [
            getComputedStyle(image).filter, getComputedStyle(image.closest('.seat')).filter,
          ]), ['none', 'none'], `${engine}/${screen}: filters pixelate overscanned idle in WebKit`)
          await page.locator('.board').screenshot({ path: resolve(output, `${engine}-${screen}-idle.png`) })
          for (const card of ['strike_ironclad', 'cleave', 'twin_strike']) {
            const label = `${engine}/${screen}/${card}`
            // Capture live beats in one page call; browser round trips can outlast
            // a whole pose on a busy phone renderer.
            const played = await page.evaluate(({ card, idleReturn }) => new Promise((resolve, reject) => {
              const impacts = []
              const numbers = []
              const frameStats = { maxBodies: 0, maxTravel: 0 }
              const damage = new Map()
              window.kratosSounds = []
              const onImpact = event => {
                const enemy = event.target.closest('.enemy')
                queueMicrotask(() => impacts.push({ seq: event.detail.seq, index: event.detail.index,
                  target: enemy.dataset.enemyId,
                  hp: Number(enemy.querySelector('.bar__label').textContent.split('/')[0]),
                  dead: enemy.classList.contains('enemy--dead') }))
              }
              document.addEventListener('kratos-impact', onImpact)
              const observer = new MutationObserver(records => {
                for (const record of records) for (const node of record.addedNodes) {
                  if (node instanceof HTMLElement && node.matches('.hermit-damage-number')) numbers.push({
                    target: record.target.closest('.enemy').dataset.enemyId, damage: Number(node.dataset.damage) })
                }
              })
              observer.observe(document.querySelector('.board'), { childList: true, subtree: true })
              const before = new Map(window.kratosFixture.state.enemies.map(enemy => [enemy.uid, enemy.hp]))
              const seq = window.kratosFixture.attack(card)
              const event = window.kratosFixture.state.presentationEvents.at(-1)
              event.enemyIds.forEach(id => damage.set(id, event.enemyHpLoss[id] ?? 0))
              const started = performance.now()
              let last
              const finish = (error, result) => {
                document.removeEventListener('kratos-impact', onImpact); observer.disconnect()
                error ? reject(error) : resolve(result)
              }
              const sample = () => {
                const attack = document.querySelector(`.character-attack--kratos[data-attack-seq="${seq}"]`)
                const time = attack?.getAnimations()[0]?.currentTime
                if (typeof time === 'number') {
                  const portrait = attack.closest('.seat__portrait')
                  const visible = [...attack.querySelectorAll('.character-attack__pose > img')]
                    .filter(image => Number(getComputedStyle(image.parentElement).opacity) > .5)
                  const image = visible[0]
                  last = { time, src: image?.src, bodies: visible.length }
                  frameStats.maxBodies = Math.max(frameStats.maxBodies, visible.length)
                  frameStats.maxTravel = Math.max(frameStats.maxTravel, new DOMMatrix(getComputedStyle(attack).transform).e)
                  if (time >= idleReturn + 20 && visible.length === 1 && image?.src.endsWith('/kratos-ready.webp')) {
                    const returned = new DOMMatrix(getComputedStyle(attack).transform).e
                    if (Math.abs(returned) < .5) return finish(null, { frameStats, impacts,
                      numbers, returned, damage: Object.fromEntries(damage), before: Object.fromEntries(before),
                      sounds: window.kratosSounds, age: performance.now() - started })
                  }
                }
                if (performance.now() - started > 6000) finish(new Error(`combo/return never painted ${JSON.stringify(last)}`))
                else setTimeout(sample, 16)
              }
              sample()
            }), { card, idleReturn }).catch(error => { throw new Error(`${label}: ${error.message}`, { cause: error }) })
            assert.equal(played.frameStats.maxBodies, 1, `${label}: missing or duplicated attacker`)
            assert(played.frameStats.maxTravel > 10, `${label}: Kratos never reaches target`)
            assert.equal(Object.keys(played.damage).length, card === 'cleave' ? 2 : 1, 'wrong authoritative targets')
            for (const [target, total] of Object.entries(played.damage)) {
              const hits = played.impacts.filter(impact => impact.target === target)
              assert.deepEqual(hits.map(hit => hit.index), [0, 1, 2], `${label}: missing/repeated/out-of-order impacts`)
              for (const [index, fraction] of [.1, .2, 1].entries()) {
                assert(Math.abs(hits[index].hp - (played.before[target] - total * fraction)) < 1e-8,
                  `${label}: wrong visible HP at beat ${index + 1}: ${JSON.stringify(hits)}`)
              }
              const numbers = played.numbers.filter(number => number.target === target)
              assert.equal(numbers.length, total > 0 ? 3 : 0, `${label}: damage numbers duplicated`)
              numbers.forEach((number, index) => assert(Math.abs(number.damage - total * [.1, .1, .8][index]) < 1e-8,
                `${label}: wrong weighted number ${JSON.stringify(number)}`))
            }
            if (engine === 'chromium') assert.deepEqual(played.sounds.filter(sound =>
              ['kratos-light.mp3', 'kratos-slam.mp3'].includes(sound.path)).map(sound => sound.path),
              ['kratos-light.mp3', 'kratos-light.mp3', 'kratos-slam.mp3'], 'impact SFX missing, repeated or out of order')
            await page.waitForFunction(() => !document.querySelector('.character-attack'))
            await page.locator('.board').screenshot({ path: resolve(output, `${engine}-${screen}-${card}-returned.png`) })
          }
          // Snapshot the registered contact drawing after live playback checks.
          // Freezing every visual clock makes the exported frame reviewable.
          await page.evaluate(() => window.kratosFixture.reset())
          await page.clock.install({ time: new Date('2026-10-05T00:00:00Z') })
          await page.clock.pauseAt(new Date('2026-10-05T00:00:10Z'))
          const frozenSeq = await page.evaluate(() => window.kratosFixture.attack())
          await page.locator('.character-attack__pose--kratos-right-extended img').waitFor({ state: 'attached' })
          const frozenAt = beat('right-extended')
          await page.evaluate(async ({ seq, frozenAt }) => {
            await Promise.all([...document.querySelectorAll('.character-attack__pose img')].map(image => image.decode()))
            const animations = [...document.querySelectorAll(`.character-attack, [data-kratos-impact-seq="${seq}"]`)]
              .flatMap(node => node.getAnimations({ subtree: true }))
            animations.forEach(animation => animation.pause())
            await Promise.all(animations.map(animation => animation.ready))
            animations.forEach(animation => { animation.currentTime = frozenAt })
          }, { seq: frozenSeq, frozenAt })
          const poseChecks = await page.evaluate(({ beats, frozenAt }) => {
            const attack = document.querySelector('.character-attack--kratos')
            const animations = attack.getAnimations({ subtree: true })
            const checks = beats.map(([pose, time]) => {
                animations.forEach(animation => { animation.currentTime = time })
                const visible = [...attack.querySelectorAll('.character-attack__pose img')]
                  .filter(image => Number(getComputedStyle(image.parentElement).opacity) > .5)
                return { pose, time, count: visible.length, src: visible[0]?.src,
                  decoded: visible[0]?.complete && visible[0].naturalWidth === 1152 }
              })
            animations.forEach(animation => { animation.currentTime = frozenAt })
            return checks
          }, { beats, frozenAt })
          for (const drawing of poseChecks) assert(drawing.count === 1 && drawing.decoded &&
            drawing.src.endsWith(`/kratos-${drawing.pose}.webp`),
            `${engine}/${screen}: timed pose missing or duplicated ${JSON.stringify(drawing)}`)
          // While he is out Kratos stands still: one travel, a planted rear sole, and one
          // blade-tip line for both light hits and the slam, landing inside the target.
          const stance = await page.evaluate(({ strikeBeats, frozenAt }) => {
            const attack = document.querySelector('.character-attack--kratos')
            const animations = attack.getAnimations({ subtree: true })
            const target = document.querySelector('.enemy[data-enemy-id="enemy-0"] .enemy__portrait').getBoundingClientRect()
            const measure = ([pose, time]) => {
              animations.forEach(animation => { animation.currentTime = time })
              const image = [...attack.querySelectorAll('.character-attack__pose img')]
                .find(node => Number(getComputedStyle(node.parentElement).opacity) > .5)
              const canvas = document.createElement('canvas')
              canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
              const context = canvas.getContext('2d')
              context.drawImage(image, 0, 0)
              const data = context.getImageData(0, 0, canvas.width, canvas.height).data
              const solid = (x, y) => data[(y * canvas.width + x) * 4 + 3] > 64
              let right = 0, rightY = 0, bottom = 0, paintTop = canvas.height
              for (let y = 0; y < canvas.height; y += 2) for (let x = 0; x < canvas.width; x += 2) {
                if (!solid(x, y)) continue
                if (x > right) { right = x; rightY = y }
                paintTop = Math.min(paintTop, y)
                bottom = Math.max(bottom, y)
              }
              // The planted rear sole is the leftmost run of solid columns in the ground band.
              let footStart = -1, footEnd = -1
              for (let x = 0; x < canvas.width && (footEnd < 0 || x - footEnd <= 6); x++) {
                let touches = false
                for (let y = bottom - 22; y <= bottom && !touches; y++) touches = solid(x, y)
                if (touches) { if (footStart < 0) footStart = x; footEnd = x }
              }
              const rect = image.getBoundingClientRect()
              const fit = Math.min(rect.width / canvas.width, rect.height / canvas.height)
              const left = rect.left + (rect.width - canvas.width * fit) / 2
              const top = rect.bottom - canvas.height * fit
              return { pose, travel: new DOMMatrix(getComputedStyle(attack).transform).e,
                tip: left + right * fit, tipY: top + rightY * fit, foot: left + (footStart + footEnd) / 2 * fit,
                top: top + paintTop * fit, pixel: fit }
            }
            const poses = strikeBeats.map(measure)
            animations.forEach(animation => { animation.currentTime = frozenAt })
            return { poses, target: [target.left, target.right, target.top, target.bottom],
              boardTop: document.querySelector('.board').getBoundingClientRect().top }
          }, { strikeBeats, frozenAt })
          const strike = stance.poses
          const label = `${engine}/${screen}`
          assert(strike.every(pose => Math.abs(pose.travel - strike[0].travel) < .5),
            `${label}: Kratos moves between his hits ${JSON.stringify(strike)}`)
          const contact = strike.filter(pose => registration.contactPoses.includes(pose.pose))
          const tips = contact.map(pose => pose.tip)
          assert(Math.max(...tips) - Math.min(...tips) < 8 * strike[0].pixel,
            `${label}: light hits and slam reach different distances ${JSON.stringify(contact)}`)
          const [targetLeft, targetRight, targetTop, targetBottom] = stance.target
          assert(contact.every(pose => pose.tip > targetLeft && pose.tip < targetRight &&
            pose.tipY > targetTop && pose.tipY < targetBottom),
            `${label}: blades miss the target ${JSON.stringify({ contact, target: stance.target })}`)
          // Integer CSS shifts leave a few canvas pixels of noise.
          const feet = strike.map(pose => pose.foot)
          assert(Math.max(...feet) - Math.min(...feet) < 8 * strike[0].pixel,
            `${label}: rear foot slides while Kratos is out ${JSON.stringify(strike)}`)
          // The board clips its overflow, so raised blades must stay below its top edge.
          assert(strike.every(pose => pose.top >= stance.boardTop),
            `${label}: the board clips Kratos's raised blades ${JSON.stringify({ boardTop: stance.boardTop, strike })}`)
          const shotPath = resolve(output, `${engine}-${screen}-second-light-frame.png`)
          const geometry = await page.evaluate(() => ({
            board: document.querySelector('.board').getBoundingClientRect().toJSON(),
            image: document.querySelector('.character-attack__pose--kratos-right-extended img').getBoundingClientRect().toJSON(),
          }))
          await page.locator('.board').screenshot({ path: shotPath })
          // Sample the generated ash-white skin mask in the composited screenshot.
          // DOM opacity/geometry alone missed WebKit's ancestor-filter clipping.
          const painted = spawnSync('python3', ['-c', `
import json, sys
from PIL import Image
geometry = json.load(sys.stdin)
shot = Image.open(sys.argv[1]).convert('RGB')
source = Image.open(sys.argv[2]).convert('RGBA')
b, r = geometry['board'], geometry['image']
fit = min(r['width'] / source.width, r['height'] / source.height)
left = r['x'] - b['x'] + (r['width'] - source.width * fit) / 2
top = r['y'] - b['y'] + r['height'] - source.height * fit
scale = shot.width / b['width']
points = set()
for y in range(0, source.height, 3):
    for x in range(0, source.width, 3):
        red, green, blue, alpha = source.getpixel((x,y))
        if alpha < 220 or min(red,green,blue) < 170 or max(red,green,blue) - min(red,green,blue) > 40: continue
        point = (round((left + x * fit) * scale), round((top + y * fit) * scale))
        if 0 <= point[0] < shot.width and 0 <= point[1] < shot.height: points.add(point)
matched = sum(min(shot.getpixel(point)) > 140 and max(shot.getpixel(point)) - min(shot.getpixel(point)) < 55 for point in points)
assert len(points) > 50 and matched / len(points) > .25, (matched, len(points), 'Kratos did not paint at contact')
print(f'visible skin: {matched}/{len(points)}')
`, shotPath, resolve(root, 'public/assets/combat/characters/animated/kratos-right-extended.webp')], {
            input: JSON.stringify(geometry), encoding: 'utf8',
          })
          assert.equal(painted.status, 0, `${engine}/${screen}: ${painted.stderr || painted.stdout}`)

          await page.clock.resume()
          if (engine === 'webkit') assert(['kratos-chain.mp3', 'kratos-light.mp3', 'kratos-slam.mp3']
            .every(file => soundRequests.has(file)), 'WebKit did not decode all three original Kratos sounds')
          await page.evaluate(() => window.kratosFixture.reset())
          const settled = await page.evaluate(paintedKratosBounds, idle)
          assert(Math.abs(settled.height - rest.height) < 2, 'attack changed resting stature')
          // In-game reduced motion must retain exactly the same physical cutout.
          await page.evaluate(() => {
            document.documentElement.dataset.reducedMotion = 'true'
            window.kratosFixture.reset()
          })
          await page.waitForFunction(() => document.querySelector('.seat__portrait > img')?.src.endsWith('/kratos-hero.webp'))
          await page.locator(idle).evaluate(image => image.decode())
          const reduced = await page.evaluate(paintedKratosBounds, idle)
          assert(Math.abs(reduced.height - rest.height) < 2, 'reduced motion changes Kratos size')
          assert(Math.abs(reduced.width - rest.width) < 2, 'reduced motion crops Kratos blades')
          assert(Math.abs(reduced.ground - rest.ground) < 2, 'reduced motion shifts planted feet')
          await page.evaluate(() => window.kratosFixture.attack())
          assert.equal(await page.locator('.character-attack').count(), 0, 'reduced motion plays attack')
          assert.equal(await page.locator('.kratos-hit').count(), 0, 'reduced motion retains hit effects')
          // Cards and item-granted Shivs both keep separate weighted debts.
          // The second lethal combo must not erase the first or kill its target early.
          for (const source of ['strike_ironclad', 'shiv']) {
            await page.evaluate(() => {
              document.documentElement.dataset.reducedMotion = 'false'
              const f = window.kratosFixture; f.reset()
              f.state.enemies.splice(1); f.state.enemies[0].hp = 2; f.render()
            })
            await page.waitForFunction(ready => Number(document.querySelector('.board')?.dataset.characterAttackAssetsReady) === ready, assetsReady)
            const queued = await page.evaluate(source => new Promise((resolve, reject) => {
              const f = window.kratosFixture
              const samples = []
              const onImpact = event => {
                const enemy = event.target.closest('.enemy')
                queueMicrotask(() => {
                  samples.push({ seq: event.detail.seq, index: event.detail.index,
                    hp: Number(enemy.querySelector('.bar__label').textContent.split('/')[0]),
                    dead: enemy.classList.contains('enemy--dead') })
                  if (samples.length === 6) {
                    clearTimeout(timeout); document.removeEventListener('kratos-impact', onImpact); resolve(samples)
                  }
                })
              }
              const timeout = setTimeout(() => {
                document.removeEventListener('kratos-impact', onImpact)
                reject(new Error(`queued combo lost impacts: ${JSON.stringify(samples)}`))
              }, 8000)
              document.addEventListener('kratos-impact', onImpact)
              f.attack(source); f.attack(source)
            }), source)
            assert.deepEqual(queued.map(hit => hit.index), [0, 1, 2, 0, 1, 2], `${source}: queued combos overlap or lose beats`)
            queued.forEach((hit, index) => {
              assert(Math.abs(hit.hp - [1.9, 1.8, 1, .9, .8, 0][index]) < 1e-8, 'queued weighted debt restores old HP')
              assert.equal(hit.dead, index === 5, 'lethal combo falls before its slam')
            })
            await page.waitForFunction(() => !document.querySelector('.character-attack'))
          }
          // Restoration clears an in-flight play and never replays it on reconnect.
          await page.evaluate(() => {
            document.documentElement.dataset.reducedMotion = 'false'
            window.kratosFixture.reset()
          })
          await page.waitForFunction(ready => Number(document.querySelector('.board')?.dataset.characterAttackAssetsReady) === ready, assetsReady)
          await page.evaluate(() => window.kratosFixture.attack())
          await page.locator('.character-attack--kratos').waitFor()
          await page.evaluate(() => {
            const f = window.kratosFixture; f.connected = false; f.render()
            f.restoration++; f.connected = true; f.render()
          })
          await page.waitForFunction(() => !document.querySelector('.character-attack'))
          await page.locator('.board').screenshot({ path: resolve(output, `${engine}-${screen}-restored.png`) })
          // Bosses paint outside the rows; the slamming Kratos must still draw over the boss he hits.
          await page.evaluate(() => {
            const f = window.kratosFixture; f.reset()
            f.state.enemies.splice(1)
            Object.assign(f.state.enemies[0], { defId: 'time_eater', isBoss: true, hp: 60, maxHp: 60 })
            f.render()
          })
          await page.waitForFunction(ready => Number(document.querySelector('.board')?.dataset.characterAttackAssetsReady) === ready, assetsReady)
          const bossLayer = await page.evaluate(() => new Promise((resolve, reject) => {
            const style = document.createElement('style')
            style.textContent = '.character-attack, .character-attack * { pointer-events: auto !important; }'
            const onImpact = event => {
              if (event.detail.index !== 2) return
              clearTimeout(timeout); document.removeEventListener('kratos-impact', onImpact)
              document.head.append(style)
              const portrait = document.querySelector('.board__bosses .enemy__portrait').getBoundingClientRect()
              const hit = document.elementFromPoint(portrait.left + portrait.width / 2, portrait.top + portrait.height / 2)
              style.remove()
              resolve(hit?.closest('.character-attack--kratos') ? 'kratos' : hit?.closest('.enemy') ? 'boss' : String(hit?.className))
            }
            const timeout = setTimeout(() => {
              document.removeEventListener('kratos-impact', onImpact)
              reject(new Error('boss slam never landed'))
            }, 8000)
            document.addEventListener('kratos-impact', onImpact)
            window.kratosFixture.attack()
          }))
          assert.equal(bossLayer, 'kratos', `${engine}/${screen}: Kratos slams behind the boss`)
          await page.waitForFunction(() => !document.querySelector('.character-attack'))
          console.log(`PASS ${engine}/${screen}: Kratos weighted three-hit combo, poses, planted stance, shared blade contact, art inside the board, boss layering, SFX, targets, scale, cold loading, reduced motion and restoration`)
        } finally { releaseColdArtwork?.(); await context.close() }
      }
    } finally { await browser.close() }
  }
  assert.deepEqual(errors, [], 'browser errors or missing combat artwork')
} finally { await server.close() }
