import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
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
          page.on('response', r => { if (r.status() >= 400 && /\/assets\/combat\//.test(r.url())) errors.push(`${r.status()} ${r.url()}`) })
          const coldArtwork = new Promise(resolve => { releaseColdArtwork = resolve })
          await page.route('**/kratos-contact.webp', async route => {
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
            const seq = window.kratosFixture.attack()
            const started = performance.now()
            let last
            const sample = () => {
              const attack = document.querySelector('.character-attack--kratos')
              const transform = attack ? getComputedStyle(attack).transform : ''
              const time = attack?.getAnimations()[0]?.currentTime
              const target = document.querySelector(`.combat-vfx--target[data-vfx-seq="${seq}"]`)
              last = { time, transform, exists: Boolean(attack), age: performance.now() - started }
              if (typeof time === 'number' && time >= 650 && time <= 1100) resolve({
                time, targetTime: target?.getAnimations()[0]?.currentTime,
                x: new DOMMatrix(transform).e, fallback: Boolean(attack.querySelector('.is-fallback')),
                goal: getComputedStyle(attack).getPropertyValue('--attack-x'),
              })
              else if (performance.now() - started > 6000) reject(new Error(`cold beat never painted ${JSON.stringify(last)}`))
              else setTimeout(sample, 20)
            }
            sample()
          })).catch(error => { throw new Error(`${engine}/${screen}: ${error.message}`, { cause: error }) })
          assert(cold.fallback && cold.x > 10, `${engine}/${screen}: cold cutout never travels ${JSON.stringify(cold)}`)
          assert(Math.abs(cold.time - cold.targetTime) < 150, 'cold attacker and target clocks separated')
          await page.waitForFunction(() => !document.querySelector('.character-attack'))
          releaseColdArtwork()
          await page.waitForFunction(() => Number(document.querySelector('.board')?.dataset.characterAttackAssetsReady) === 6).catch(async error => {
            throw new Error(`${engine}/${screen}: warmup ${JSON.stringify(await page.locator('.board').evaluate(node => node.dataset))} ${JSON.stringify(errors)}`, { cause: error })
          })
          await page.unroute('**/kratos-contact.webp')
          const rest = await page.evaluate(paintedKratosBounds, idle)
          assert(rest.width > 45 && rest.height > 70, `${engine}/${screen}: missing or tiny Kratos`)
          assert.deepEqual(await page.locator(idle).evaluate(image => [
            getComputedStyle(image).filter, getComputedStyle(image.closest('.seat')).filter,
          ]), ['none', 'none'], `${engine}/${screen}: filters pixelate overscanned idle in WebKit`)
          await page.locator('.board').screenshot({ path: resolve(output, `${engine}-${screen}-idle.png`) })
          for (const card of ['strike_kratos', 'kratos_blades_of_chaos']) {
            const label = `${engine}/${screen}/${card}`
            // Capture live beats in one page call; browser round trips can outlast
            // a whole pose on a busy phone renderer.
            const played = await page.evaluate(card => new Promise((resolve, reject) => {
              const seq = window.kratosFixture.attack(card)
              const started = performance.now()
              let contact, followthrough
              const sample = () => {
                const attack = document.querySelector('.character-attack--kratos')
                const transform = attack ? getComputedStyle(attack).transform : ''
                const time = attack?.getAnimations()[0]?.currentTime
                if (typeof time === 'number') {
                  const portrait = attack.closest('.seat__portrait')
                  const images = [...attack.querySelectorAll('.character-attack__pose > img')]
                  const visible = images.filter(image => Number(getComputedStyle(image.parentElement).opacity) > .5)
                  const image = visible[0]
                  const snapshot = { travel: new DOMMatrix(transform).e,
                    scale: getComputedStyle(portrait).getPropertyValue('--character-art-scale'),
                    idleOpacity: getComputedStyle(portrait.querySelector(':scope > img')).opacity,
                    src: image?.src, bodies: visible.length, time,
                    decoded: image?.complete && image.naturalWidth === 800,
                    targets: document.querySelectorAll(`.combat-vfx--target[data-vfx-seq="${seq}"]`).length }
                  // Style reads describe the last painted compositor frame;
                  // sample held poses away from the 630/1060ms boundaries.
                  if (!contact && time >= 750 && time <= 1000 && image?.src.endsWith('/kratos-contact.webp')) contact = snapshot
                  if (!followthrough && time >= 1170 && time <= 1380 && image?.src.endsWith('/kratos-followthrough.webp')) followthrough = snapshot
                }
                if (contact && followthrough && typeof time === 'number' && time >= 1530) {
                  const visible = [...attack.querySelectorAll('.character-attack__pose > img')]
                    .filter(image => Number(getComputedStyle(image.parentElement).opacity) > .5)
                  const returned = new DOMMatrix(getComputedStyle(attack).transform).e
                  if (visible.length === 1 && visible[0].src.endsWith('/kratos-ready.webp') && Math.abs(returned) < .5) {
                    resolve({ contact, followthrough, returned, returnSrc: visible[0].src })
                    return
                  }
                }
                if (performance.now() - started > 6000) reject(new Error(`contact/return never painted contact=${Boolean(contact)} finish=${Boolean(followthrough)} time=${time}`))
                else setTimeout(sample, 20)
              }
              sample()
            }), card).catch(error => { throw new Error(`${label}: ${error.message}`, { cause: error }) })
            const { contact, followthrough, returned, returnSrc } = played
            assert(contact.decoded, `${label}: painted pose missing or undecoded`)
            assert(followthrough.decoded && followthrough.bodies === 1, `${label}: followthrough missing or duplicated`)
            assert.equal(contact.bodies, 1, 'duplicate attacker bodies')
            assert.equal(contact.targets, card === 'strike_kratos' ? 1 : 2,
              'impact targets must come from the actual engine play')
            assert(contact.travel > 10, `${label}: Kratos never reaches the target`)
            assert.equal(contact.idleOpacity, '0', 'idle body paints underneath the attack')
            assert.equal(Number(contact.scale), 2, 'weapon overscan lost its fixed scale')
            assert(Math.abs(returned) < .5, 'Kratos did not return to his seat')
            assert(returnSrc.endsWith('/kratos-ready.webp'), 'return retains a fighting pose')
            await page.waitForFunction(() => !document.querySelector('.character-attack'))
            await page.locator('.board').screenshot({ path: resolve(output, `${engine}-${screen}-${card}-returned.png`) })
          }
          // Snapshot the registered contact drawing after live playback checks.
          // Freezing every visual clock makes the exported frame reviewable.
          await page.clock.install({ time: new Date('2026-10-05T00:00:00Z') })
          await page.clock.pauseAt(new Date('2026-10-05T00:00:10Z'))
          await page.evaluate(async () => {
            const seq = window.kratosFixture.attack()
            await Promise.all([...document.querySelectorAll('.character-attack__pose img')].map(image => image.decode()))
            const animations = [...document.querySelectorAll(`.character-attack, .combat-vfx[data-vfx-seq="${seq}"]`)]
              .flatMap(node => node.getAnimations({ subtree: true }))
            animations.forEach(animation => animation.pause())
            await Promise.all(animations.map(animation => animation.ready))
            animations.forEach(animation => { animation.currentTime = 750 })
          })
          const shotPath = resolve(output, `${engine}-${screen}-contact-frame.png`)
          const geometry = await page.evaluate(() => ({
            board: document.querySelector('.board').getBoundingClientRect().toJSON(),
            image: document.querySelector('.character-attack__pose--kratos-contact img').getBoundingClientRect().toJSON(),
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
`, shotPath, resolve(root, 'public/assets/combat/characters/animated/kratos-contact.webp')], {
            input: JSON.stringify(geometry), encoding: 'utf8',
          })
          assert.equal(painted.status, 0, `${engine}/${screen}: ${painted.stderr || painted.stdout}`)

          await page.clock.resume()
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
          assert(Math.abs(reduced.ground - rest.ground) < 2, 'reduced motion shifts planted feet')
          await page.evaluate(() => window.kratosFixture.attack())
          assert.equal(await page.locator('.character-attack').count(), 0, 'reduced motion plays attack')
          // Restoration clears an in-flight play and never replays it on reconnect.
          await page.evaluate(() => {
            document.documentElement.dataset.reducedMotion = 'false'
            window.kratosFixture.reset()
          })
          await page.waitForFunction(() => Number(document.querySelector('.board')?.dataset.characterAttackAssetsReady) === 6)
          await page.evaluate(() => window.kratosFixture.attack())
          await page.locator('.character-attack--kratos').waitFor()
          await page.evaluate(() => {
            const f = window.kratosFixture; f.connected = false; f.render()
            f.restoration++; f.connected = true; f.render()
          })
          await page.waitForFunction(() => !document.querySelector('.character-attack'))
          await page.locator('.board').screenshot({ path: resolve(output, `${engine}-${screen}-restored.png`) })
          console.log(`PASS ${engine}/${screen}: Kratos scale, contact, targets, cold loading, repeated poses, reduced motion and restoration`)
        } finally { releaseColdArtwork?.(); await context.close() }
      }
    } finally { await browser.close() }
  }
  assert.deepEqual(errors, [], 'browser errors or missing combat artwork')
} finally { await server.close() }
