#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium, webkit } from './lib/profile-browser.mjs'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'artifacts/safari-combat-animation')
mkdirSync(output, { recursive: true })
const server = await createServer({ root, logLevel: 'silent', server: { port: 0 } })
await server.listen()

const loaded = element => element instanceof HTMLVideoElement
  ? element.readyState >= 2 && element.videoWidth > 0
  : element.complete && element.naturalWidth > 0
const size = element => element instanceof HTMLVideoElement
  ? [element.videoWidth, element.videoHeight]
  : [element.naturalWidth, element.naturalHeight]

try {
  for (const [engineName, engine] of Object.entries({ chromium, webkit })) {
    const browser = await engine.launch({ headless: true })
    try {
      for (const [screen, viewport] of [['desktop', { width: 1440, height: 900 }], ['horizontal-phone', { width: 844, height: 390 }]]) {
        const phone = screen === 'horizontal-phone'
        const context = await browser.newContext({ viewport, isMobile: phone, hasTouch: phone })
        const page = await context.newPage()
        let releaseAttackVideo
        let releaseAttackPoster
        let releaseIdleVideo
        let releasePlayerAttackVideo
        if (engineName === 'webkit') {
          let releaseVideo, releasePoster, releaseIdle, releasePlayerVideo
          const videoGate = new Promise(resolve => { releaseVideo = resolve })
          const posterGate = new Promise(resolve => { releasePoster = resolve })
          const idleGate = new Promise(resolve => { releaseIdle = resolve })
          const playerVideoGate = new Promise(resolve => { releasePlayerVideo = resolve })
          releaseAttackVideo = releaseVideo
          releaseAttackPoster = releasePoster
          releaseIdleVideo = releaseIdle
          releasePlayerAttackVideo = releasePlayerVideo
          await page.route('**/guardian_attack-attack.mov', async route => {
            await videoGate
            await route.continue()
          })
          await page.route('**/combat/enemies/guardian_attack.webp', async route => {
            await posterGate
            await route.continue()
          })
          await page.route('**/hero-defect-idle.mov', async route => {
            await idleGate
            await route.continue()
          })
          await page.route('**/hero-defect-attack.mov', async route => {
            await playerVideoGate
            await route.continue()
          })
        }
        const errors = []
        page.on('pageerror', error => errors.push(String(error)))
        await page.goto(`http://localhost:${server.httpServer.address().port}`)
        await page.evaluate(async () => {
          document.querySelector('#root').style.display = 'none'
          document.documentElement.dataset.mobilePerformance = String(matchMedia('(pointer: coarse)').matches)
          document.documentElement.dataset.reducedMotion = 'false'
          const node = document.createElement('div')
          node.className = 'app-shell app-shell--combat sts-scope'
          node.style.gridTemplateRows = 'minmax(0, 1fr)'
          document.body.append(node)
          const [R, D, { CombatScreen }, { createPlayer }, C, { createRng }, { actionsForEnemy }] = await Promise.all([
            import('/@id/react'), import('/@id/react-dom/client'), import('/src/ui/CombatScreen.tsx'),
            import('/src/game/run.ts'), import('/src/game/combat.ts'), import('/src/game/rng.ts'), import('/src/game/enemies.ts'),
            import('/src/ui/styles.css'), import('/src/ui/chrome.css'),
          ])
          const rng = createRng(47)
          const player = createPlayer(rng, 'p1', 'Defect', 'defect', 0)
          Object.assign(player, { hp: 99, maxHp: 99, hand: [], draw: [], discard: [], relics: [] })
          const enemy = { uid: 'enemy-0', defId: 'guardian_attack', row: 0, isBoss: true,
            hp: 999, maxHp: 999, block: 0, strength: 0, vulnerable: 0, weak: 0,
            poison: 0, actionIndex: 0, abilityUsed: false, dead: false }
          const state = C.createCombat(rng, [player], [enemy])
          state.phase = 'player'; state.presentationEvents = []
          for (let die = 1; die <= 6; die++) for (let actionIndex = 0; actionIndex < 8; actionIndex++) {
            if (actionsForEnemy({ ...enemy, actionIndex }, die).some(action => action.kind === 'attack')) {
              state.die = die; state.enemies[0].actionIndex = actionIndex; die = 7; break
            }
          }
          const reactRoot = (D.createRoot ?? D.default.createRoot)(node)
          window.fixture = { state, autoAdvance: false, actions: [], render() {
            reactRoot.render((R.createElement ?? R.default.createElement)(CombatScreen, {
              state: structuredClone(this.state), act: 1, viewerId: 'p1', autoAdvance: this.autoAdvance,
              onAction: action => { this.actions.push(action.kind) },
            }))
          } }
          window.fixture.render()
        })

        const media = '.seat__portrait > :is(img, video), .enemy__art--cutout'
        const tag = engineName === 'webkit' ? 'VIDEO' : 'IMG'
        if (engineName === 'webkit') {
          const coldIdle = page.locator('.seat__portrait > img')
          await coldIdle.waitFor()
          assert((await coldIdle.getAttribute('src')).endsWith('/hero-defect-idle.webp'),
            'cold idle MOV did not retain its animated WebP')
          const firstIdle = createHash('sha256').update(await coldIdle.screenshot()).digest('hex')
          await page.waitForTimeout(180)
          assert.notEqual(createHash('sha256').update(await coldIdle.screenshot()).digest('hex'), firstIdle,
            'cold idle WebP froze while its MOV warmed')
          releaseIdleVideo()
        }
        await page.waitForFunction(({ media, loaded, tag }) => {
          const ready = new Function('element', `return (${loaded})(element)`)
          const elements = [...document.querySelectorAll(media)]
          return elements.length === 2 && elements.every(element => element.tagName === tag && ready(element))
        }, { media, loaded: loaded.toString(), tag })
        const resting = await page.locator(media).evaluateAll(async (elements, helpers) => {
          const getSize = new Function('element', `return (${helpers.size})(element)`)
          return Promise.all(elements.map(async element => {
            const asset = element.dataset.animationAsset ?? element.src.replace(/\.mov(?=\?|$)/, '.webp')
            const source = new Image(); source.src = asset; await source.decode()
            return { tag: element.tagName, src: element.src, asset,
              size: getSize(element), sourceSize: [source.naturalWidth, source.naturalHeight] }
          }))
        }, { size: size.toString() })
        const extension = engineName === 'webkit' ? '.mov' : '.webp'
        assert(resting.every(item => item.tag === tag && item.src.endsWith(extension)), `${engineName}/${screen}: ${JSON.stringify(resting)}`)
        assert(resting.every(item => item.size.every((value, axis) =>
          value === item.sourceSize[axis] || value === item.sourceSize[axis] + item.sourceSize[axis] % 2)),
          `${engineName}/${screen}: companion changed intrinsic resolution ${JSON.stringify(resting)}`)

        for (const element of await page.locator(media).all()) {
          const alpha = await element.evaluate((art, sizeSource) => {
            const getSize = new Function('element', `return (${sizeSource})(element)`)
            const [width, height] = getSize(art)
            const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height
            const context = canvas.getContext('2d'); context.drawImage(art, 0, 0)
            const pixels = context.getImageData(0, 0, width, height).data
            return { corner: pixels[3], visible: pixels.some((value, index) => index % 4 === 3 && value > 32) }
          }, size.toString())
          assert(alpha.corner < 16 && alpha.visible, `${engineName}/${screen}: alpha was lost ${JSON.stringify(alpha)}`)
          const first = createHash('sha256').update(await element.screenshot()).digest('hex')
          await page.waitForTimeout(180)
          assert.notEqual(createHash('sha256').update(await element.screenshot()).digest('hex'), first,
            `${engineName}/${screen}: idle animation froze`)
        }

        if (engineName === 'webkit') {
          await page.evaluate(() => {
            window.fixture.state.presentationEvents.push({ seq: 1, kind: 'card', actorId: 'p1', sourceId: 'strike_defect',
              enemyIds: ['enemy-0'], playerIds: [], upgraded: false, copied: false, energy: 1 })
            window.fixture.render()
          })
          const playerAttack = page.locator('.character-attack__pose--rig > :is(img, video)')
          await playerAttack.waitFor()
          assert.equal(await playerAttack.evaluate(element => element.tagName), 'IMG',
            'cold player MOV did not use its same-resolution WebP attack fallback')
          assert((await playerAttack.getAttribute('src')).endsWith('/hero-defect-attack.webp'))
          const firstAttack = createHash('sha256').update(await playerAttack.screenshot()).digest('hex')
          await page.waitForTimeout(180)
          assert.notEqual(createHash('sha256').update(await playerAttack.screenshot()).digest('hex'), firstAttack,
            'cold player MOV fallback froze')
          await page.waitForTimeout(2_000)
          releasePlayerAttackVideo()
          await page.locator('.character-attack').waitFor({ state: 'detached' })
        }

        await page.evaluate((autoAdvance) => {
          window.fixture.autoAdvance = autoAdvance
          window.fixture.state.phase = 'enemy'
          window.fixture.render()
        }, engineName === 'webkit')
        const attack = page.locator('.enemy[data-animation="attack"] .enemy__art--cutout')
        await attack.waitFor()
        await page.waitForFunction(({ selector, loaded }) => {
          const element = document.querySelector(selector)
          return element && new Function('element', `return (${loaded})(element)`)(element)
        }, { selector: '.enemy[data-animation="attack"] .enemy__art--cutout', loaded: loaded.toString() })
        assert.equal(await attack.evaluate(element => element.tagName), 'IMG')
        assert((await attack.getAttribute('data-animation-asset')).endsWith('/guardian_attack-attack.webp'))
        if (engineName === 'webkit') {
          assert((await attack.getAttribute('src')).endsWith('/guardian_attack-attack.webp'),
            'cold enemy MOV did not use its same-resolution WebP attack fallback')
          const firstAttack = createHash('sha256').update(await attack.screenshot()).digest('hex')
          await page.waitForTimeout(180)
          assert.notEqual(createHash('sha256').update(await attack.screenshot()).digest('hex'), firstAttack,
            'cold enemy MOV fallback froze')
        }
        await page.waitForFunction(() => document.querySelector('.enemy')?.classList.contains('enemy--acting'))
        if (engineName === 'webkit') {
          await page.waitForFunction(() => window.fixture.actions.includes('resolveEnemies'))
          releaseAttackPoster()
          releaseAttackVideo()
          await page.waitForTimeout(100)
          assert.equal(await page.locator('.enemy[data-animation="attack"] video[src$="guardian_attack-attack.mov"]').count(), 0,
            'late enemy MOV replaced the active fallback after enemy-phase auto advance')
        }

        if (engineName === 'webkit') {
          assert.equal(await page.evaluate(async () => {
            const { combatVideoPath } = await import('/src/ui/CombatAnimation.tsx')
            return combatVideoPath('./assets/combat/rigged/guardian_attack-idle.webp', 'https://cdn.example/public/assets')
          }), 'https://cdn.example/public/assets/combat/rigged/guardian_attack-idle.mov',
          'hosted video origin did not preserve the generated asset path')
          assert.equal(await page.evaluate(async () => {
            const { combatVideoPath } = await import('/src/ui/CombatAnimation.tsx')
            return combatVideoPath('./assets/combat/characters/watcher-hero.webp', 'https://cdn.example/public/assets')
          }), './assets/combat/characters/watcher-hero.webp',
          'hosted video origin rewrote an asset without a MOV companion')
          await page.evaluate(() => { window.fixture.state.phase = 'player'; window.fixture.render() })
          const idle = page.locator('.enemy[data-animation="idle"] .enemy__art--cutout')
          await idle.waitFor()
          await idle.evaluate(video => { video.src = '/missing-safari-animation.mov' })
          await page.waitForFunction(() => document.querySelector('.enemy__art--cutout')?.tagName === 'IMG')
          const fallback = page.locator('.enemy__art--cutout')
          assert((await fallback.getAttribute('src')).endsWith('/guardian_attack-idle.webp'), 'video failure did not restore WebP')
          assert.equal(await fallback.evaluate(image => {
            const canvas = document.createElement('canvas')
            canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
            const context = canvas.getContext('2d'); context.drawImage(image, 0, 0)
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
            let left = canvas.width, right = 0, top = canvas.height, bottom = 0
            for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3] > 96) {
              const x = i / 4 % canvas.width, y = Math.floor(i / 4 / canvas.width)
              left = Math.min(left, x); right = Math.max(right, x + 1)
              top = Math.min(top, y); bottom = Math.max(bottom, y + 1)
            }
            const rect = image.getBoundingClientRect()
            const fit = Math.min(rect.width / canvas.width, rect.height / canvas.height)
            const x = rect.left + (rect.width - canvas.width * fit) / 2 + (left + right) / 2 * fit
            const y = rect.bottom - (canvas.height - (top + bottom) / 2) * fit
            return document.elementFromPoint(x, y)?.closest('.enemy')?.dataset.enemyId
          }), 'enemy-0', 'video fallback left stale target geometry')
        }

        await page.locator('.board').screenshot({ path: resolve(output, `${engineName}-${screen}.png`) })
        assert.deepEqual(errors, [])
        await context.close()
        console.log(`PASS ${engineName}/${screen}: Safari combat animation media, alpha, motion and fallback`)
      }
      if (engineName === 'webkit') {
        const replayContext = await browser.newContext()
        const replay = await replayContext.newPage()
        await replay.goto(`http://localhost:${server.httpServer.address().port}?run-vod=1`)
        assert.equal(await replay.evaluate(async () => (await import('/src/ui/CombatAnimation.tsx')).useSafariCombatVideo), false,
          'Safari VOD replay must keep deterministic WebP frames')
        await replayContext.close()

        const stallContext = await browser.newContext()
        const stall = await stallContext.newPage()
        let releaseStalledVideo
        const stalledVideo = new Promise(resolve => { releaseStalledVideo = resolve })
        await stall.route('**/hero-defect-attack.mov', async route => {
          await stalledVideo
          await route.continue()
        })
        await stall.goto(`http://localhost:${server.httpServer.address().port}`)
        await stall.evaluate(async () => {
          const originalTimeout = window.setTimeout
          window.setTimeout = (callback, delay, ...args) => originalTimeout(callback,
            delay === 5_000 ? 1_000 : delay === 1_500 ? 250 : delay, ...args)
          const [R, D, { CombatAnimation }] = await Promise.all([
            import('/@id/react'), import('/@id/react-dom/client'), import('/src/ui/CombatAnimation.tsx'),
          ])
          const node = document.createElement('div')
          document.body.append(node)
          ;(D.createRoot ?? D.default.createRoot)(node).render((R.createElement ?? R.default.createElement)(CombatAnimation, {
            src: './assets/combat/rigged/hero-defect-attack.webp', loop: false, 'data-timeout-test': true,
          }))
        })
        const timedOut = stall.locator('[data-timeout-test]')
        await timedOut.waitFor()
        assert.equal(await timedOut.evaluate(element => element.tagName), 'VIDEO',
          'visible MOV stall fixture did not mount a video')
        await stall.waitForFunction(() => document.querySelector('[data-timeout-test]')?.tagName === 'IMG')
        assert((await timedOut.getAttribute('src')).endsWith('/hero-defect-attack.webp'),
          'stalled visible MOV did not fall back to WebP')
        releaseStalledVideo()
        await stall.evaluate(async () => {
          const [R, D, { CombatAnimation }] = await Promise.all([
            import('/@id/react'), import('/@id/react-dom/client'), import('/src/ui/CombatAnimation.tsx'),
          ])
          const node = document.createElement('div')
          document.body.append(node)
          ;(D.createRoot ?? D.default.createRoot)(node).render((R.createElement ?? R.default.createElement)(CombatAnimation, {
            src: './assets/combat/rigged/hero-silent-idle.webp', loop: false, 'data-progress-test': true,
          }))
        })
        const playbackStall = stall.locator('[data-progress-test]')
        await playbackStall.waitFor()
        await stall.waitForFunction(() => {
          const video = document.querySelector('[data-progress-test]')
          return video?.tagName === 'VIDEO' && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
        })
        await playbackStall.evaluate(async video => {
          video.pause()
          await new Promise(resolve => setTimeout(resolve, 100))
          video.dispatchEvent(new Event('waiting', { bubbles: true }))
        })
        await stall.waitForFunction(() => document.querySelector('[data-progress-test]')?.tagName === 'IMG')
        assert((await playbackStall.getAttribute('src')).endsWith('/hero-silent-idle.webp'),
          'mid-playback MOV stall did not fall back to WebP')
        await stallContext.close()

        const posterContext = await browser.newContext()
        const poster = await posterContext.newPage()
        let releaseStalledWebp
        const stalledWebp = new Promise(resolve => { releaseStalledWebp = resolve })
        await poster.route('**/guardian_attack-attack.webp', async route => {
          await stalledWebp
          await route.continue()
        })
        await poster.goto(`http://localhost:${server.httpServer.address().port}`)
        await poster.evaluate(async () => {
          const [R, D, { CombatAnimation }] = await Promise.all([
            import('/@id/react'), import('/@id/react-dom/client'), import('/src/ui/CombatAnimation.tsx'),
          ])
          const node = document.createElement('div')
          node.style.cssText = 'width:320px;height:240px'
          document.body.append(node)
          ;(D.createRoot ?? D.default.createRoot)(node).render((R.createElement ?? R.default.createElement)(CombatAnimation, {
            src: './assets/combat/rigged/guardian_attack-attack.webp',
            posterSrc: './assets/combat/enemies/guardian_attack.webp',
            forceWebp: true,
            style: { width: '100%', height: '100%', objectFit: 'contain' },
            'data-poster-test': true,
          }))
        })
        const waitingWebp = poster.locator('[data-poster-test]')
        await waitingWebp.waitFor()
        const withPoster = createHash('sha256').update(await waitingWebp.screenshot()).digest('hex')
        await waitingWebp.evaluate(image => { image.style.backgroundImage = 'none' })
        const withoutPoster = createHash('sha256').update(await waitingWebp.screenshot()).digest('hex')
        assert.notEqual(withPoster, withoutPoster, 'cold WebP attack did not paint its ready static poster')
        releaseStalledWebp()
        await poster.waitForFunction(() => document.querySelector('[data-poster-test]')?.naturalWidth > 0)
        await posterContext.close()

        const preloadContext = await browser.newContext()
        const preload = await preloadContext.newPage()
        await preload.goto(`http://localhost:${server.httpServer.address().port}`)
        assert.deepEqual(await preload.evaluate(async () => {
          const started = []
          const videos = []
          let aborted = 0
          const originalLoad = HTMLMediaElement.prototype.load
          HTMLMediaElement.prototype.load = function () {
            if (videos.includes(this) && !this.hasAttribute('src')) {
              aborted += 1
              return
            }
            if (['one.mov', 'two.mov', 'three.mov', 'four.mov'].some(src => this.src.endsWith(src))) {
              started.push(this.src)
              videos.push(this)
              return
            }
            return originalLoad.call(this)
          }
          try {
            const { preloadCombatVideo } = await import('/src/ui/CombatAnimation.tsx')
            const ready = []
            const cancel = [
              preloadCombatVideo('one.mov', () => ready.push('one-a')),
              preloadCombatVideo('one.mov', () => ready.push('one-b')),
              preloadCombatVideo('two.mov', () => ready.push('two')),
              preloadCombatVideo('three.mov', () => ready.push('three')),
              preloadCombatVideo('four.mov', () => ready.push('four'), true),
            ]
            await new Promise(resolve => setTimeout(resolve))
            const initial = started.length
            videos[0].dispatchEvent(new Event('canplaythrough'))
            await new Promise(resolve => setTimeout(resolve))
            const afterFirst = started.at(-1).split('/').at(-1)
            cancel[2]()
            const afterCancel = started.at(-1).split('/').at(-1)
            videos[2].dispatchEvent(new Event('loadeddata'))
            videos[3].dispatchEvent(new Event('canplaythrough'))
            preloadCombatVideo('one.mov', () => ready.push('one-c'))
            const afterCached = started.length
            cancel.forEach(stop => stop())
            return { initial, afterFirst, afterCancel, afterCached, aborted, ready }
          } finally {
            HTMLMediaElement.prototype.load = originalLoad
          }
        }), { initial: 2, afterFirst: 'four.mov', afterCancel: 'three.mov', afterCached: 4, aborted: 1,
          ready: ['one-a', 'one-b', 'four', 'three', 'one-c'] },
        'Safari MOV warmup was not visible-first, bounded, deduplicated, cached, abortable, and per-subscriber ready')
        await preloadContext.close()
      }
    } finally {
      await browser.close()
    }
  }
} finally {
  await server.close()
}
