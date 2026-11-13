import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { preview } from 'vite'
import { chromium, devices } from './lib/profile-browser.mjs'
import { createRun } from '../src/game/run.ts'
import { createCombat } from '../src/game/combat/create.ts'
import { GAME_SETTINGS_KEY } from '../src/ui/game-settings.ts'

const out = 'artifacts/combat-video'
mkdirSync(out, { recursive: true })
const server = await preview({ logLevel: 'silent', preview: { host: '127.0.0.1', port: 0 } })
server.httpServer.prependListener('request', (request, response) => {
  if (!request.url?.split('?')[0].endsWith('.webm')) return
  const writeHead = response.writeHead.bind(response)
  response.writeHead = (...args) => {
    const headerIndex = typeof args[1] === 'string' ? 2 : 1
    args[headerIndex] = { ...args[headerIndex], 'Content-Type': 'audio/webm' }
    return writeHead(...args)
  }
})
const browser = await chromium.launch({ headless: true })
try {
  for (const [screen, options] of [['desktop', { viewport: { width: 1440, height: 900 } }],
    ['horizontal-phone', devices['Pixel 7 landscape']]]) {
    const context = await browser.newContext({ ...options, recordVideo: { dir: `${out}/recordings` } })
    await context.addInitScript(key => localStorage.setItem(key, JSON.stringify({ bgmVolume: 0, sfxVolume: 0 })), GAME_SETTINGS_KEY)
    const page = await context.newPage(), errors = [], webmTypes = []
    page.on('response', response => {
      if (response.url().endsWith('.webm') && response.ok()) webmTypes.push(response.headers()['content-type'])
    })
    page.on('pageerror', error => errors.push(String(error)))
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`
    await page.goto(origin)
    for (const name of ['Single Player', 'Standard', 'Embark', 'Start standard campaign'])
      await page.getByRole('button', { name, exact: true }).click()
    await page.waitForFunction(() => window.__STS_DEBUG__?.getRun()?.phase === 'neow')
    const id = await page.evaluate(() => window.__STS_DEBUG__.getRun().players[0].id)
    for (const act of [1, 4]) {
      const characters = act === 4 ? ['ironclad', 'silent', 'defect', 'watcher'] : ['ironclad', 'defect']
      const run = createRun(47, characters.map((character, index) => ({ id: index ? `p${index + 1}` : id, name: character, character })))
      run.act = act; run.phase = 'combat'; run.neow = null
      const base = { isBoss: false, block: 0, strength: 0, weak: 0, vulnerable: 0, poison: 0, actionIndex: 0, abilityUsed: false, dead: false }
      const defs = act === 4 ? ['spire_shield', 'spire_spear'] : ['acid_slime', 'small_slime']
      run.combat = createCombat(run.rng, run.players, defs.map((defId, index) => ({ ...base, uid: defId, defId, row: index ? 3 : 0, hp: 30, maxHp: 30 })), `movie-${act}`)
      run.combat.phase = 'player'
      run.combat.players.forEach((player, index) => { player.facingEnemyUid = act === 4 ? defs[index < 2 ? 0 : 1] : null })
      await page.evaluate(run => window.__STS_DEBUG__.setRun(run), run)
      const count = act === 4 ? 5 : 4
      await page.waitForFunction(count => {
        const videos = [...document.querySelectorAll('.board video')]
        return videos.length === count && videos.every(video => video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && !video.paused && !video.style.backgroundImage)
      }, count)
      const initial = await page.locator('.board video').evaluateAll(videos => videos.map(video => video.getVideoPlaybackQuality().totalVideoFrames))
      await page.mouse.move(0, 0)
      await page.screenshot({ path: `${out}/${screen}-act-${act}-a.png` })
      await page.waitForFunction(initial => [...document.querySelectorAll('.board video')].every((video, index) =>
        video.getVideoPlaybackQuality().totalVideoFrames >= initial[index] + 5), initial)
      const alpha = await page.locator('.board video').evaluateAll(videos => videos.map(video => {
        const canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight
        const context = canvas.getContext('2d'); context.drawImage(video, 0, 0)
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
        let opaque = false
        for (let index = 3; index < pixels.length; index += 4) if (pixels[index] === 255) { opaque = true; break }
        return { corner: pixels[3], opaque, loop: video.loop, muted: video.muted && globalThis[Symbol.for('sts-test-audio-muted')].get(video) === true }
      }))
      assert(alpha.every(value => value.corner === 0 && value.opaque && value.loop && value.muted), `${screen}: native video lost transparency or playback`)
      await page.waitForFunction(count => {
        const videos = [...document.querySelectorAll('.board video')]
        if (videos.length !== count) return false
        return videos.map(video => {
          if (video.currentTime < (video.loopPreviousTime ?? 0)) video.loopObserved = true
          video.loopPreviousTime = video.currentTime
          return video.loopObserved
        }).every(Boolean)
      }, count)
      assert.equal(await page.locator('.board video').count(), count, `${screen}: idle fell back after looping`)
      await page.screenshot({ path: `${out}/${screen}-act-${act}-b.png` })
      if (act === 4) {
        await page.evaluate(() => {
          const run = structuredClone(window.__STS_DEBUG__.getRun())
          run.combat.players.forEach(player => { player.block = 99 })
          run.combat.die = 2; run.combat.phase = 'enemy'
          window.__STS_DEBUG__.setRun(run)
        })
        const attack = page.locator('.enemy--acting [data-animation-layer="attack"]:not([data-inactive])').first()
        await attack.waitFor()
        assert(await attack.evaluate(node => [...node.parentElement.querySelectorAll('[data-animation-layer="idle"]')]
          .every(idle => getComputedStyle(idle).visibility === 'hidden')), `${screen}: idle leaked through an attack`)
        await page.screenshot({ path: `${out}/${screen}-act-4-attack.png` })
        await page.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.phase !== 'enemy' &&
          [...document.querySelectorAll('.enemy video[data-animation-layer="idle"]')].length === 2 &&
          [...document.querySelectorAll('.enemy video[data-animation-layer="idle"]')].every(video =>
            getComputedStyle(video).visibility === 'visible' && !video.paused && video.readyState >= 2))
      }
    }
    for (const failedPoster of [false, true]) {
      const token = failedPoster ? 'both-missing' : 'video-missing'
      const routePattern = url => url.pathname.endsWith('/hero-ironclad-idle.webm') ||
        failedPoster && url.pathname.endsWith('/rigged-posters/hero-ironclad-idle.webp')
      await context.route(routePattern, route => route.fulfill({ status: 404, body: '' }))
      await page.evaluate(() => localStorage.removeItem('sts-solo-run'))
      await page.goto(origin)
      for (const name of ['Single Player', 'Standard', 'Embark', 'Start standard campaign'])
        await page.getByRole('button', { name, exact: true }).click()
      await page.waitForFunction(() => window.__STS_DEBUG__?.getRun()?.phase === 'neow')
      const run = createRun(47, [{ id, name: 'Ironclad', character: 'ironclad' }])
      run.phase = 'combat'; run.neow = null
      run.combat = createCombat(run.rng, run.players, [{ uid: 'slime', defId: 'small_slime', row: 0,
        hp: 30, maxHp: 30, block: 0, strength: 0, weak: 0, vulnerable: 0, poison: 0, actionIndex: 0, abilityUsed: false, dead: false, isBoss: false }])
      run.combat.phase = 'player'
      await page.evaluate(run => window.__STS_DEBUG__.setRun(run), run)
      await page.waitForFunction(() => {
        const image = document.querySelector('.seat__portrait img')
        return image?.src.endsWith('/rigged/hero-ironclad-idle.webp') && image.complete && image.naturalWidth > 0
      })
      assert.equal(await page.locator('.seat__portrait video').count(), 0)
      await page.screenshot({ path: `${out}/${screen}-${token}.png` })
      await context.unroute(routePattern)
    }
    assert.deepEqual(errors, [])
    assert(webmTypes.length > 0 && webmTypes.every(type => type === 'audio/webm'), `${screen}: GitHub MIME fixture was not applied`)
    await context.close()
    console.log(`${screen}: native idle playback with GitHub audio/webm headers, transparent frames and missing-media recovery passed`)
  }
} catch (error) {
  for (const context of browser.contexts()) for (const page of context.pages()) {
    writeFileSync(`${out}/failure.json`, JSON.stringify(await page.evaluate(() => ({
      state: window.__STS_DEBUG__?.getRun()?.combat,
      media: [...document.querySelectorAll('.board :is(video, img[data-animation-layer])')].map(node => ({
        src: node.getAttribute('src'), mode: node.dataset.animationLayer, inactive: node.dataset.inactive,
        visibility: getComputedStyle(node).visibility, ready: node.readyState, paused: node.paused,
      })),
    })), null, 2))
    await page.screenshot({ path: `${out}/failure.png` })
  }
  throw error
} finally {
  await browser.close()
  await new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()))
}
