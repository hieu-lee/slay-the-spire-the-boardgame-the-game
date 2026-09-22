#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium, devices, webkit } from './lib/profile-browser.mjs'

// Reproduce the recorded Cultist handoff with repeated full-resolution WebP handoffs.
// Save painted frames across both handoffs, repeated attacks, and decoder lifetimes.
const root = resolve(import.meta.dirname, '..')
const baseline = process.argv.includes('--baseline')
const output = resolve(root, `artifacts/safari-transitions${baseline ? '-before' : ''}`)
mkdirSync(output, { recursive: true })
const server = await createServer({ root, logLevel: 'silent', server: { port: 0 } })
await server.listen()
const results = []
async function paintedPose(page, path) {
  const screenshot = await page.locator('.board').screenshot({ path, scale: 'css' })
  return page.evaluate(async source => {
    const image = new Image(); image.src = source; await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.width; canvas.height = image.height
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0)
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
    let top = canvas.height, bottom = 0, count = 0
    // The Cultist's blue feathers isolate its painted body from this brown scene.
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
      const i = (y * canvas.width + x) * 4
      if (pixels[i] < 100 && pixels[i + 1] > 70 && pixels[i + 1] < 200 && pixels[i + 2] > 200) {
        top = Math.min(top, y); bottom = Math.max(bottom, y); count++
      }
    }
    return { height: bottom - top + 1, count }
  }, `data:image/png;base64,${screenshot.toString('base64')}`)
}
try {
  for (const [name, engine] of Object.entries(process.argv.includes('--webkit-only') ? { webkit } : { webkit, chromium })) {
    const browser = await engine.launch({ headless: true })
    try {
      for (const phone of [false, true]) {
        const label = `${name}-${phone ? 'horizontal-phone' : 'desktop'}`
        const context = await browser.newContext({
          ...(phone ? { ...devices[name === 'webkit' ? 'iPhone 13 landscape' : 'Pixel 7 landscape'], viewport: { width: 844, height: 390 } } : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 }),
          recordVideo: { dir: output, size: phone ? { width: 844, height: 390 } : { width: 1440, height: 900 } },
        })
        const page = await context.newPage()
        const errors = []
        page.on('pageerror', error => errors.push(String(error)))
        await page.addInitScript(() => {
          window.createdVideos = []
          const create = document.createElement.bind(document)
          document.createElement = function (tag, options) {
            const element = create(tag, options)
            if (tag === 'video') window.createdVideos.push(element)
            return element
          }
        })
        const holdAttack = name === 'webkit'
        let releaseAttack
        const attackGate = new Promise(resolve => { releaseAttack = resolve })
        await page.route('**/cultist-attack.webp', async route => {
          if (holdAttack) await attackGate
          await route.continue()
        })
        await page.goto(`http://localhost:${server.httpServer.address().port}`)
        await page.evaluate(async () => {
          document.querySelector('#root').style.display = 'none'
          document.documentElement.dataset.mobilePerformance = String(matchMedia('(pointer: coarse)').matches)
          document.documentElement.dataset.reducedMotion = 'false'
          const node = document.createElement('div')
          node.className = 'app-shell app-shell--combat sts-scope'
          node.style.gridTemplateRows = 'minmax(0, 1fr)'
          document.body.append(node)
          const [R, D, { CombatScreen }, { createPlayer }, { createCombat }, { createRng }, { actionsForEnemy }, media] = await Promise.all([
            import('/@id/react'), import('/@id/react-dom/client'), import('/src/ui/CombatScreen.tsx'),
            import('/src/game/run.ts'), import('/src/game/combat.ts'), import('/src/game/rng.ts'),
            import('/src/game/enemies.ts'), import('/src/ui/CombatAnimation.tsx'),
            import('/src/ui/styles.css'), import('/src/ui/chrome.css'),
          ])
          const rng = createRng(47)
          const player = createPlayer(rng, 'p1', 'Ironclad', 'ironclad', 0)
          Object.assign(player, { hp: 99, maxHp: 99, hand: [], draw: [], discard: [], relics: [] })
          const enemy = { uid: 'enemy-0', defId: 'cultist', row: 0, hp: 999, maxHp: 999,
            block: 0, strength: 0, vulnerable: 0, weak: 0, poison: 0, actionIndex: 0, abilityUsed: false, dead: false }
          const state = createCombat(rng, [player], [enemy])
          state.phase = 'player'; state.presentationEvents = []
          for (let die = 1; die <= 6; die++) for (let actionIndex = 0; actionIndex < 8; actionIndex++) {
            if (actionsForEnemy({ ...enemy, actionIndex }, die).some(action => action.kind === 'attack')) {
              state.die = die; state.enemies[0].actionIndex = actionIndex; die = 7; break
            }
          }
          const reactRoot = (D.createRoot ?? D.default.createRoot)(node)
          window.fixture = { state, safari: media.useSafariCombatRendering, unmount: () => reactRoot.unmount(),
            render() { reactRoot.render((R.createElement ?? R.default.createElement)(R.StrictMode ?? R.default.StrictMode, null,
              (R.createElement ?? R.default.createElement)(CombatScreen, {
              state: structuredClone(state), act: 1, viewerId: 'p1', autoAdvance: false, onAction: () => {},
            }))) },
          }
          window.fixture.render()

        })
        await page.waitForFunction(() => {
          const art = document.querySelector('.enemy__art--cutout')
          return art instanceof HTMLVideoElement ? art.readyState >= 2 : art?.complete && art.naturalWidth > 0
        })
        await page.waitForTimeout(400)
        const idlePose = await paintedPose(page, resolve(output, `${label}-idle.png`))
        await page.evaluate(() => {
          window.idleArt = document.querySelector('.enemy__art--cutout')
          // This corner marker delimits the ready gameplay frames in the recording.
          const marker = document.createElement('div'); marker.id = 'handoff-capture'
          marker.style.cssText = 'position:fixed;top:0;left:0;width:16px;height:16px;background:#f0f;z-index:99999;pointer-events:none'
          document.body.append(marker)
        })
        const safari = await page.evaluate(() => window.fixture.safari)
        await page.evaluate(() => { window.fixture.state.phase = 'enemy'; window.fixture.render() })
        await page.locator('.enemy[data-animation="attack"]').waitFor()
        const waiting = await page.locator('.enemy__art--cutout:not([data-inactive])').evaluate(art => ({
          poster: art.poster, background: getComputedStyle(art).backgroundImage,
          rect: art.getBoundingClientRect().toJSON(),
        }))

        if (safari && !baseline) {
          assert(await page.evaluate(() => window.idleArt.isConnected), 'loading an attack removed the already painted idle media')
        }
        // Let the movie capture both handoffs without locator screenshots, which
        // temporarily reconfigure WebKit's compositing surfaces during capture.
        releaseAttack()
        const frames = await page.evaluate(() => new Promise(resolve => {
          const frames = [], start = performance.now()
          function sample(time) {
            frames.push({ elapsed: time - start, phase: document.querySelector('.enemy').dataset.animation,
              idleRetained: window.idleArt.isConnected })
            if (time - start < 2500) requestAnimationFrame(sample)
            else resolve(frames)
          }
          requestAnimationFrame(sample)
        }))
        writeFileSync(resolve(output, `${label}-frames.json`), JSON.stringify(frames, null, 2))
        assert(frames.some(frame => frame.phase === 'attack') && frames.some(frame => frame.phase === 'idle'),
          `${label}: recording missed a handoff`)
        if (!baseline) {
          if (safari) assert(frames.every(frame => frame.idleRetained), `${label}: handoff discarded the decoded idle animation`)
          if (safari) assert(await page.evaluate(() => document.querySelector('.enemy__art--cutout:not([data-inactive])') === window.idleArt),
            `${label}: return to idle restarted its media`)
        }
        await page.locator('.enemy[data-animation="idle"]').waitFor()
        const gaps = await page.evaluate(async () => {
          window.fixture.state.phase = 'player'; window.fixture.render()
          await new Promise(resolve => setTimeout(resolve, 250))
          const gaps = []; let previous
          const end = performance.now() + 2500
          window.fixture.state.phase = 'enemy'; window.fixture.render()
          await new Promise(resolve => {
            function frame(time) {
              if (previous !== undefined) gaps.push(time - previous)
              previous = time
              if (time < end) requestAnimationFrame(frame)
              else resolve()
            }
            requestAnimationFrame(frame)
          })
          return gaps
        })
        await page.locator('.enemy[data-animation="idle"]').waitFor()
        await page.evaluate(async () => {
          document.querySelector('#handoff-capture').remove()
          await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame)
        })
        await page.locator('.board').screenshot({ path: resolve(output, `${label}-returned.png`) })
        const retained = await page.evaluate(() => window.createdVideos
          .filter(video => !video.isConnected && video.hasAttribute('src')).map(video => video.src))
        await page.evaluate(() => window.fixture.unmount())
        const afterUnmount = await page.evaluate(() => window.createdVideos
          .filter(video => video.hasAttribute('src')).map(video => video.src))
        const sorted = gaps.toSorted((a, b) => a - b)
        const result = { label, waiting, idlePose,
          p95: sorted[Math.floor(sorted.length * .95)], max: Math.max(...gaps), retained, afterUnmount }
        results.push(result)
        writeFileSync(resolve(output, 'report.json'), JSON.stringify(results, null, 2))
        if (!baseline) {
          assert.deepEqual(retained, [], `${label}: detached media retained decoders`)
          assert.deepEqual(afterUnmount, [], `${label}: leaving combat retained decoders`)
          // Capture timing is diagnostic; the uncaptured full-app burst verifier owns frame budgets.
        }
        assert.deepEqual(errors, [])
        await context.close()
        const movie = resolve(output, `${label}.webm`)
        await page.video().saveAs(movie)
        // Check EVERY recorded frame (25fps), not just slower Playwright screenshots.
        const width = phone ? 422 : 720, height = phone ? 195 : 450
        const pixels = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', movie,
          '-vf', `scale=${width}:${height}`, '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'],
        { maxBuffer: 256 * 1024 * 1024 })
        const frameBytes = width * height * 3, paintedFrames = []
        for (let start = 0; start < pixels.length; start += frameBytes) {
          const corner = start + (width * 2 + 2) * 3
          if (!(pixels[corner] > 180 && pixels[corner + 1] < 80 && pixels[corner + 2] > 180)) continue
          let count = 0
          for (let i = start; i < start + frameBytes; i += 3) {
            if (pixels[i] < 100 && pixels[i + 1] > 70 && pixels[i + 1] < 200 && pixels[i + 2] > 180) count++
          }
          paintedFrames.push({ frame: start / frameBytes, count })
        }
        writeFileSync(resolve(output, `${label}-movie-frames.json`), JSON.stringify(paintedFrames, null, 2))
        assert(paintedFrames.length > 100, `${label}: movie missed the handoff capture window`)
        if (!baseline && safari) assert(paintedFrames.every(frame => frame.count > 50),
          `${label}: blank enemy in movie: ${JSON.stringify(paintedFrames.filter(frame => frame.count <= 50))}`)
        console.log(`PASS ${label}: repeated attack p95=${result.p95.toFixed(1)}ms max=${result.max.toFixed(1)}ms`)
      }
    } finally { await browser.close() }
  }
} finally { await server.close() }
