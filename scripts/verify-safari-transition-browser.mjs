#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium, devices, webkit } from './lib/profile-browser.mjs'

// Reproduce the recorded Cultist handoff with a warmed but slow video request.
// Save the waiting pose, repeated attacks, frame timings, and decoder lifetimes.
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
    for (let y = 0; y < canvas.height; y++) for (let x = Math.floor(canvas.width * .65); x < canvas.width; x++) {
      const i = (y * canvas.width + x) * 4
      if (pixels[i] < 100 && pixels[i + 1] > 70 && pixels[i + 1] < 200 && pixels[i + 2] > 200) {
        top = Math.min(top, y); bottom = Math.max(bottom, y); count++
      }
    }
    return { height: bottom - top + 1, count }
  }, `data:image/png;base64,${screenshot.toString('base64')}`)
}
try {
  for (const [name, engine] of Object.entries({ webkit, chromium })) {
    const browser = await engine.launch({ headless: true })
    try {
      for (const phone of [false, true]) {
        const label = `${name}-${phone ? 'horizontal-phone' : 'desktop'}`
        const context = await browser.newContext({
          ...(phone ? devices['iPhone 13 landscape'] : { viewport: { width: 1440, height: 900 } }),
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
        let holdAttack = false, releaseAttack
        const attackGate = new Promise(resolve => { releaseAttack = resolve })
        await page.route('**/cultist-attack.mov', async route => {
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
          window.fixture = { state, video: media.useSafariCombatVideo, unmount: () => reactRoot.unmount(),
            render() { reactRoot.render((R.createElement ?? R.default.createElement)(R.StrictMode ?? R.default.StrictMode, null,
              (R.createElement ?? R.default.createElement)(CombatScreen, {
              state: structuredClone(state), act: 1, viewerId: 'p1', autoAdvance: false, onAction: () => {},
            }))) },
          }
          window.fixture.render()
          if (media.useSafariCombatVideo) await new Promise(resolve =>
            media.preloadCombatVideo(media.combatVideoPath('./assets/combat/rigged/cultist-attack.webp'), resolve))
        })
        await page.waitForFunction(() => {
          const art = document.querySelector('.enemy__art--cutout')
          return window.fixture.video ? art?.tagName === 'VIDEO' && art.readyState >= 2
            : art?.complete && art.naturalWidth > 0
        })
        await page.waitForTimeout(400)
        const idlePose = await paintedPose(page, resolve(output, `${label}-idle.png`))
        const video = await page.evaluate(() => window.fixture.video)
        holdAttack = video
        await page.evaluate(() => { window.fixture.state.phase = 'enemy'; window.fixture.render() })
        await page.locator('.enemy[data-animation="attack"]').waitFor()
        const waiting = await page.locator('.enemy__art--cutout').evaluate(art => ({
          poster: art.poster, background: getComputedStyle(art).backgroundImage,
          rect: art.getBoundingClientRect().toJSON(),
        }))
        const waitingPose = await paintedPose(page, resolve(output, `${label}-waiting.png`))
        if (video && !baseline) {
          assert(waitingPose.count > 100, 'Cultist disappeared while its attack loaded')
          assert(waitingPose.height / idlePose.height > .8 && waitingPose.height / idlePose.height < 1.2,
            `Cultist changed painted size before attacking: ${JSON.stringify({ idlePose, waitingPose })}`)
          assert.match(waiting.poster, /\/rigged\/cultist-idle\.webp$/, 'attack poster must share the idle canvas and body scale')
          assert.match(waiting.background, /cultist-idle\.webp/, 'loading video needs a painted fallback until its first frame')
        }
        releaseAttack()
        await page.locator('.enemy--acting').waitFor()
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
        await page.locator('.board').screenshot({ path: resolve(output, `${label}-returned.png`) })
        const retained = await page.evaluate(() => window.createdVideos
          .filter(video => !video.isConnected && video.hasAttribute('src')).map(video => video.src))
        await page.evaluate(() => window.fixture.unmount())
        const afterUnmount = await page.evaluate(() => window.createdVideos
          .filter(video => video.hasAttribute('src')).map(video => video.src))
        const sorted = gaps.toSorted((a, b) => a - b)
        const result = { label, waiting, idlePose, waitingPose,
          p95: sorted[Math.floor(sorted.length * .95)], max: Math.max(...gaps), retained, afterUnmount }
        results.push(result)
        writeFileSync(resolve(output, 'report.json'), JSON.stringify(results, null, 2))
        if (!baseline) {
          assert.deepEqual(retained, [], `${label}: detached media retained decoders`)
          assert.deepEqual(afterUnmount, [], `${label}: leaving combat retained decoders`)
          assert(result.p95 < 40 && result.max < 150, `${label}: attack frame stall ${JSON.stringify(result)}`)
        }
        assert.deepEqual(errors, [])
        await context.close()
        await page.video().saveAs(resolve(output, `${label}.webm`))
        console.log(`PASS ${label}: repeated attack p95=${result.p95.toFixed(1)}ms max=${result.max.toFixed(1)}ms`)
      }
    } finally { await browser.close() }
  }
} finally { await server.close() }
