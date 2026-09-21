import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'vite'
import { chromium } from './lib/profile-browser.mjs'
const output = 'artifacts/run-vod'
mkdirSync(output, { recursive: true })
const server = await createServer({ logLevel: 'silent', server: { port: 0 }, plugins: [{
  name: 'expose-vod-motion-test', enforce: 'pre',
  transform(code, id) {
    if (!id.endsWith('/src/ui/run-vod.ts')) return
    return code.replace('const replayClocks =', 'export const replayClocks =')
      .replace('async function captureMotion(', 'export async function captureMotion(')
  },
}] })
await server.listen()
const browser = await chromium.launch({ headless: true, args: ['--enable-blink-features=CanvasDrawElement'],
  ...(process.env.VOD_SYSTEM_CHROME ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : {}) })
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
const errors = []
page.on('pageerror', (error) => errors.push(String(error)))
try {
  await page.goto(`http://localhost:${server.httpServer.address().port}`)
  await page.getByRole('button', { name: 'Single Player', exact: true }).click()
  await page.getByRole('button', { name: 'Standard', exact: true }).click()
  await page.getByRole('button', { name: 'Embark', exact: true }).click()
  await page.getByRole('button', { name: 'Start standard campaign', exact: true }).click()
  await page.waitForFunction(() => window.__STS_DEBUG__)
  await page.evaluate(async () => {
    const { createRun, enterRoom } = await import('/src/game/run.ts')
    const initial = createRun('run-vod-visual', [{ id: 'p1', name: 'Defect', character: 'defect' }])
    const run = { ...initial, phase: 'map', neow: null }
    const room = Object.values(run.map.rooms).find((room) => room.row === 0 && room.kind === 'encounter')
    const next = enterRoom(run, room.id)
    if (!next.combat) throw new Error('Missing visual fixture combat')
    Object.assign(next.combat.players[0], {
      block: 2, weak: 1, vulnerable: 1, strength: 2,
      powers: [{ uid: 'visual-power', defId: 'defragment', upgraded: false }],
    })
    window.__STS_DEBUG__.setRun(next)
  })
  await page.locator('.seat__status-strip .power').waitFor()
  await page.waitForTimeout(1200)
  await page.screenshot({ path: `${output}/native-before.png` })
  const frame = await page.evaluate(async () => {
    const { rasterRunVod } = await import('/src/ui/run-vod-raster.ts')
    const start = performance.now()
    const canvas = await rasterRunVod(document.body, 1920, 1080)
    return { png: canvas.toDataURL(), ms: performance.now() - start }
  })
  writeFileSync(`${output}/raster-before.png`, Buffer.from(frame.png.split(',')[1], 'base64'))
  console.log(`Native raster ${Math.round(frame.ms)}ms`)
  const assetPixels = await page.evaluate(async () => {
    const { rasterRunVod, releaseRunVodRaster } = await import('/src/ui/run-vod-raster.ts')
    const frame = document.createElement('iframe')
    document.body.append(frame)
    const doc = frame.contentDocument
    const host = doc.createElement('div')
    host.style.cssText = 'display:block;width:32px;height:32px;line-height:0'
    const source = doc.createElement('img')
    source.width = source.height = 32
    source.src = '/assets/ui/cursor.png'
    source.style.cssText = 'display:block;width:32px;height:32px'
    host.append(source); doc.body.append(host)
    try {
      await source.decode()
      const expected = doc.createElement('canvas')
      expected.width = expected.height = 32
      expected.getContext('2d').drawImage(source, 0, 0)
      const actual = await rasterRunVod(host, 32, 32, 0)
      const left = new Uint32Array(expected.getContext('2d').getImageData(0, 0, 32, 32).data.buffer)
      const right = new Uint32Array(actual.getContext('2d').getImageData(0, 0, 32, 32).data.buffer)
      const mismatch = left.reduce((count, pixel, index) => count + Number(pixel !== right[index]), 0)
      expected.width = expected.height = actual.width = actual.height = 0
      return mismatch
    } finally { await releaseRunVodRaster(doc); frame.remove() }
  })
  assert.equal(assetPixels, 0, 'same-origin artwork must be embedded in a VOD raster')
  for (const [name, width, height] of [['desktop', 1920, 1080], ['phone', 844, 390]]) {
    await page.setViewportSize({ width, height })
    await page.waitForTimeout(150)
    const geometry = await page.locator('.row__seat').evaluate((seat) => ({
      bar: seat.querySelector('.bar').getBoundingClientRect().toJSON(),
      status: seat.querySelector('.seat__status-strip').getBoundingClientRect().toJSON(),
    }))
    assert(geometry.status.top >= geometry.bar.bottom + 1, `${name}: HP/status overlap ${JSON.stringify(geometry)}`)
    assert(geometry.status.bottom <= height, `${name}: statuses outside viewport`)
    await page.screenshot({ path: `${output}/gameplay-${name}.png` })
  }
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.waitForTimeout(150)
  await page.evaluate(async () => {
    window.__vodClock = (await import('/src/ui/run-vod-clock.ts')).createRunVodClock(document, window.__STS_DEBUG__.flushVod)
    document.querySelector('.hand .card').click()
    await window.__vodClock.advance(0)
    document.querySelector('[data-enemy-id] .enemy__hit-area').click()
    await window.__vodClock.advance(0)
  })
  for (const at of [0, 400, 800, 1200, 1600, 2400, 4000]) {
    const began = performance.now()
    const shot = await page.evaluate(async (at) => {
      const clock = window.__vodClock
      const prev = window.__vodTime ?? 0
      await clock.advance(at - prev)
      window.__vodTime = at
      const { rasterRunVod } = await import('/src/ui/run-vod-raster.ts')
      const canvas = await rasterRunVod(document.body, 1920, 1080, clock.now)
      return { png: canvas.toDataURL(), active: clock.active(), state: window.__STS_DEBUG__.getState().phase,
        animations: document.getAnimations().filter(a=>Number.isFinite(Number(a.effect?.getComputedTiming().endTime)))
          .map(a=>[a.animationName,a.currentTime,a.effect.getComputedTiming().endTime]),
        pending: [...document.querySelectorAll('[data-webmcp-pending="true"], .character-attack, .combat-vfx, .card-flight, .defect-evoke')].map(e=>e.className),
      }
    }, at)
    writeFileSync(`${output}/attack-${at}.png`, Buffer.from(shot.png.split(',')[1], 'base64'))
    console.log(`Attack sample ${at}ms: ${Math.round(performance.now() - began)}ms`)
    if (at === 2400) {
      const mismatch = await page.evaluate(async () => {
        const { rasterRunVod, releaseRunVodRaster } = await import('/src/ui/run-vod-raster.ts')
        const cached = await rasterRunVod(document.body, 1920, 1080, window.__vodClock.now)
        await releaseRunVodRaster(document)
        const fresh = await rasterRunVod(document.body, 1920, 1080, window.__vodClock.now)
        const left = new Uint32Array(cached.getContext('2d').getImageData(0, 0, 1920, 1080).data.buffer)
        const right = new Uint32Array(fresh.getContext('2d').getImageData(0, 0, 1920, 1080).data.buffer)
        let count = 0
        for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) count++
        cached.width = cached.height = fresh.width = fresh.height = 0
        return count
      })
      assert.equal(mismatch, 0, 'cached animated frames must match a fresh raster exactly')
    }
    if (at === 0 && process.argv.includes('--benchmark')) {
      console.log(await page.evaluate(async () => {
        const { rasterRunVod } = await import('/src/ui/run-vod-raster.ts')
        const samples = []
        for (let i = 0; i < 20; i++) {
          const started = Date.now()
          await window.__vodClock.advance(1000 / 60)
          const advanced = Date.now()
          await rasterRunVod(document.body, 1920, 1080, window.__vodClock.now)
          samples.push([advanced - started, Date.now() - advanced])
        }
        window.__vodTime = 20 * 1000 / 60
        return { averageClockMs: samples.reduce((sum, sample) => sum + sample[0], 0) / samples.length,
          averageRasterMs: samples.reduce((sum, sample) => sum + sample[1], 0) / samples.length }
      }))
    }
    if (at === 400) assert(shot.active, 'attack should still be animating at 400ms')
    if (at === 4000) assert(!shot.active, `attack did not settle: ${JSON.stringify(shot.pending)}`)
  }
  await page.evaluate(() => window.__vodClock.restore())
  const croppedAnimationPixels = await page.evaluate(async () => {
    const { rasterRunVod, runVodRasterRegion, releaseRunVodRaster } = await import('/src/ui/run-vod-raster.ts')
    const { createRunVodClock } = await import('/src/ui/run-vod-clock.ts')
    const frame = document.createElement('iframe')
    frame.style.cssText = 'position:fixed;left:-1920px;top:0;width:1920px;height:1080px;border:0'
    const loaded = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }))
    frame.srcdoc = '<style>html,body{margin:0;width:1920px;height:1080px;overflow:hidden;background:#123}@keyframes vod-crop-test{from{transform:translate(0,0);opacity:.2}to{transform:translate(600px,280px);opacity:1}}#row{display:flex;gap:100px;margin:80px}#art,#spacer,svg{width:200px;height:32px}#art{background-image:url(/assets/ui/cursor.png)}#piece{width:180px;height:140px;background:#e01;animation:vod-crop-test 1000ms linear both}#pseudo-host{position:absolute;left:100px;top:300px;width:40px;height:40px}#pseudo-host::after{content:"";position:absolute;left:900px;width:32px;height:32px;background-image:url(/assets/ui/cursor.png)}</style><div id="pseudo-host"></div><div id="row"><div id="art" data-vod-crop-background></div><img id="spacer" data-vod-crop-offscreen src="/assets/ui/cursor.png"><svg><image data-vod-crop-svg href="/assets/ui/cursor.png" width="32" height="32"/></svg><div id="piece"></div></div>'
    document.body.append(frame); await loaded
    const doc = frame.contentDocument, clock = createRunVodClock(doc, callback => callback())
    try {
      await clock.advance(0)
      const composite = await rasterRunVod(doc.body, 1920, 1080, clock.now)
      const before = runVodRasterRegion(doc.body, clock.now)
      await clock.advance(500)
      const after = runVodRasterRegion(doc.body, clock.now)
      const crop = { x: Math.min(before.x, after.x), y: Math.min(before.y, after.y),
        width: Math.max(before.x + before.width, after.x + after.width) - Math.min(before.x, after.x),
        height: Math.max(before.y + before.height, after.y + after.height) - Math.min(before.y, after.y), safe: after.safe }
      const NativeSerializer = XMLSerializer.prototype.serializeToString
      let serialized = ''
      XMLSerializer.prototype.serializeToString = function (node) {
        serialized = NativeSerializer.call(this, node)
        return serialized
      }
      const region = await rasterRunVod(doc.body, 1920, 1080, clock.now, undefined, false, crop)
      XMLSerializer.prototype.serializeToString = NativeSerializer
      composite.getContext('2d').drawImage(region, crop.x, crop.y)
      await releaseRunVodRaster(doc)
      const fresh = await rasterRunVod(doc.body, 1920, 1080, clock.now)
      const left = new Uint32Array(composite.getContext('2d').getImageData(0, 0, 1920, 1080).data.buffer)
      const right = new Uint32Array(fresh.getContext('2d').getImageData(0, 0, 1920, 1080).data.buffer)
      let mismatch = 0, minX = 1920, minY = 1080, maxX = -1, maxY = -1
      for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) {
        mismatch++; const x = index % 1920, y = Math.floor(index / 1920)
        minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y)
      }
      composite.width = composite.height = region.width = region.height = fresh.width = fresh.height = 0
      await clock.advance(600)
      const parsed = new DOMParser().parseFromString(serialized, 'application/xhtml+xml')
      const offscreen = parsed.querySelector('[data-vod-crop-offscreen]')
      const background = parsed.querySelector('[data-vod-crop-background]')
      const svg = parsed.querySelector('[data-vod-crop-svg]')
      return { mismatch, bounds: [minX, minY, maxX, maxY], safe: before.safe && after.safe,
        stripped: !offscreen?.hasAttribute('src') && !svg?.hasAttribute('href') && background?.style.backgroundImage === 'none',
        ended: runVodRasterRegion(doc.body) === null }
    } finally { clock.restore(); frame.remove(); await releaseRunVodRaster(doc) }
  })
  assert.deepEqual(croppedAnimationPixels, { mismatch: 0, bounds: [1920, 1080, -1, -1], safe: true, stripped: true, ended: true },
    'a local animation crop must match a fresh 1080p raster and ignore its completed effect')
  const croppedDialogPixels = await page.evaluate(async () => {
    const { rasterRunVod, runVodRasterRegion, releaseRunVodRaster } = await import('/src/ui/run-vod-raster.ts')
    const { createRunVodClock } = await import('/src/ui/run-vod-clock.ts')
    const frame = document.createElement('iframe')
    frame.style.cssText = 'position:fixed;left:-1920px;top:0;width:1920px;height:1080px;border:0'
    const loaded = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }))
    frame.srcdoc = '<style>html,body{margin:0;width:1920px;height:1080px;background:#fff}dialog{width:400px;height:240px;border:0;background:#fff}dialog::backdrop{background:#005}@keyframes move{to{transform:translateX(40px)}}#piece{width:40px;height:40px;margin:100px 160px;background:#f00;animation:move 1000ms linear both}</style><dialog><div id="piece"></div></dialog>'
    document.body.append(frame); await loaded
    const doc = frame.contentDocument, clock = createRunVodClock(doc, callback => callback())
    try {
      doc.querySelector('dialog').showModal()
      await clock.advance(0)
      const composite = await rasterRunVod(doc.body, 1920, 1080, clock.now)
      const before = runVodRasterRegion(doc.body, clock.now)
      await clock.advance(500)
      const after = runVodRasterRegion(doc.body, clock.now)
      const crop = { x: Math.min(before.x, after.x), y: Math.min(before.y, after.y),
        width: Math.max(before.x + before.width, after.x + after.width) - Math.min(before.x, after.x),
        height: Math.max(before.y + before.height, after.y + after.height) - Math.min(before.y, after.y), safe: after.safe }
      const region = await rasterRunVod(doc.body, 1920, 1080, clock.now, undefined, false, crop)
      composite.getContext('2d').drawImage(region, crop.x, crop.y)
      await releaseRunVodRaster(doc)
      const fresh = await rasterRunVod(doc.body, 1920, 1080, clock.now)
      const left = new Uint32Array(composite.getContext('2d').getImageData(0, 0, 1920, 1080).data.buffer)
      const right = new Uint32Array(fresh.getContext('2d').getImageData(0, 0, 1920, 1080).data.buffer)
      const mismatch = left.reduce((count, pixel, index) => count + Number(pixel !== right[index]), 0)
      composite.width = composite.height = region.width = region.height = fresh.width = fresh.height = 0
      return mismatch
    } finally { clock.restore(); frame.remove(); await releaseRunVodRaster(doc) }
  })
  assert.equal(croppedDialogPixels, 0, 'cropped animation frames must preserve generated modal backdrop styles')
  const shadowFallback = await page.evaluate(async () => {
    const { rasterRunVod, runVodRasterRegion, releaseRunVodRaster } = await import('/src/ui/run-vod-raster.ts')
    const { createRunVodClock } = await import('/src/ui/run-vod-clock.ts')
    const frame = document.createElement('iframe')
    frame.style.cssText = 'position:fixed;left:-1920px;top:0;width:1920px;height:1080px;border:0'
    const loaded = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }))
    frame.srcdoc = '<style>html,body{margin:0;width:1920px;height:1080px;overflow:hidden;background:#123}@keyframes vod-shadow-test{to{opacity:.2;transform:translateX(40px)}}#piece{position:absolute;left:800px;top:400px;width:120px;height:120px;background:#f80;filter:drop-shadow(80px 0 #000) drop-shadow(80px 0 #000);animation:vod-shadow-test 1000ms linear both}</style><div id="piece"></div>'
    document.body.append(frame); await loaded
    const doc = frame.contentDocument, clock = createRunVodClock(doc, callback => callback())
    try {
      await clock.advance(0)
      await rasterRunVod(doc.body, 1920, 1080, clock.now)
      await clock.advance(500)
      const region = runVodRasterRegion(doc.body, clock.now)
      const fallback = await rasterRunVod(doc.body, 1920, 1080, clock.now)
      await releaseRunVodRaster(doc)
      const fresh = await rasterRunVod(doc.body, 1920, 1080, clock.now)
      const left = new Uint32Array(fallback.getContext('2d').getImageData(0, 0, 1920, 1080).data.buffer)
      const right = new Uint32Array(fresh.getContext('2d').getImageData(0, 0, 1920, 1080).data.buffer)
      const mismatch = left.reduce((count, pixel, index) => count + Number(pixel !== right[index]), 0)
      fallback.width = fallback.height = fresh.width = fresh.height = 0
      doc.querySelector('#piece').style.filter = 'none'
      doc.querySelector('#piece').style.boxShadow = 'inset 0 0 9rem rgb(0 0 0 / .7)'
      await releaseRunVodRaster(doc)
      const seed = await rasterRunVod(doc.body, 1920, 1080, clock.now)
      seed.width = seed.height = 0
      return { safe: region?.safe, mismatch, insetSafe: runVodRasterRegion(doc.body, clock.now)?.safe }
    } finally { clock.restore(); frame.remove(); await releaseRunVodRaster(doc) }
  })
  assert.deepEqual(shadowFallback, { safe: false, mismatch: 0, insetSafe: true },
    'escaping paint must force a full raster without penalizing an inset shadow')
  const pseudoFallback = await page.evaluate(async () => {
    const { rasterRunVod, runVodRasterRegion, releaseRunVodRaster } = await import('/src/ui/run-vod-raster.ts')
    const { createRunVodClock } = await import('/src/ui/run-vod-clock.ts')
    const frame = document.createElement('iframe')
    frame.style.cssText = 'position:fixed;left:-1920px;top:0;width:1920px;height:1080px;border:0'
    const loaded = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }))
    frame.srcdoc = '<style>html,body{margin:0;width:1920px;height:1080px;overflow:hidden;background:#123}@keyframes vod-pseudo-test{to{opacity:.2;transform:translateX(40px)}}#piece{position:absolute;left:800px;top:400px;width:120px;height:120px;background:#f80}#piece::after{content:"";position:absolute;right:145%;top:0;width:210%;height:100%;background:#08f;animation:vod-pseudo-test 1000ms linear both}</style><div id="piece"></div>'
    document.body.append(frame); await loaded
    const doc = frame.contentDocument, clock = createRunVodClock(doc, callback => callback())
    try {
      await clock.advance(0)
      await rasterRunVod(doc.body, 1920, 1080, clock.now)
      await clock.advance(500)
      return runVodRasterRegion(doc.body, clock.now)?.safe
    } finally { clock.restore(); frame.remove(); await releaseRunVodRaster(doc) }
  })
  assert.equal(pseudoFallback, false, 'animated pseudo-elements outside their host must force an exact full raster')
  const geometryFallbacks = await page.evaluate(async () => {
    const { rasterRunVod, runVodRasterRegion, releaseRunVodRaster } = await import('/src/ui/run-vod-raster.ts')
    const { createRunVodClock } = await import('/src/ui/run-vod-clock.ts')
    const check = async (source) => {
      const frame = document.createElement('iframe')
      frame.style.cssText = 'position:fixed;left:-1920px;top:0;width:1920px;height:1080px;border:0'
      const loaded = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }))
      frame.srcdoc = source; document.body.append(frame); await loaded
      const doc = frame.contentDocument, clock = createRunVodClock(doc, callback => callback())
      try {
        await clock.advance(0)
        await rasterRunVod(doc.body, 1920, 1080, clock.now)
        await clock.advance(500)
        return runVodRasterRegion(doc.body, clock.now)?.safe
      } finally { clock.restore(); frame.remove(); await releaseRunVodRaster(doc) }
    }
    const base = 'html,body{margin:0;width:1920px;height:1080px;overflow:hidden;background:#123}'
    return {
      staticPseudo: await check(`<style>${base}@keyframes host{to{opacity:.2}}#piece{position:absolute;left:800px;top:400px;width:120px;height:120px;background:#f80;animation:host 1000ms linear both}#piece::after{content:"";position:absolute;right:145%;top:0;width:210%;height:100%;background:#08f}</style><div id="piece"></div>`),
      size: await check(`<style>${base}@keyframes size{to{width:240px}}#piece{position:absolute;left:800px;top:400px;width:120px;height:120px;background:#f80;animation:size 1000ms linear both}#piece>i{display:block;width:100%;height:20px;background:#08f}</style><div id="piece"><i></i></div>`),
      inset: await check(`<style>${base}@keyframes inset{to{left:400px}}#piece{position:absolute;left:200px;right:200px;top:400px;height:120px;background:#f80;animation:inset 1000ms linear both}</style><div id="piece"></div>`),
    }
  })
  assert.deepEqual(geometryFallbacks, { staticPseudo: false, size: false, inset: false },
    'pseudo paint and layout-changing animations must fall back when local crop geometry is not provable')
  const animatedImageCrop = await page.evaluate(async () => {
    const { rasterRunVod, runVodRasterRegion, releaseRunVodRaster } = await import('/src/ui/run-vod-raster.ts')
    const { createRunVodClock } = await import('/src/ui/run-vod-clock.ts')
    const frame = document.createElement('iframe')
    frame.style.cssText = 'position:fixed;left:-1920px;top:0;width:1920px;height:1080px;border:0'
    const loaded = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }))
    frame.srcdoc = '<style>html,body{margin:0;width:1920px;height:1080px;overflow:hidden;background:#123}@keyframes vod-image-crop-test{to{transform:translateX(40px)}}#piece{position:absolute;left:80px;top:80px;width:24px;height:24px;background:#f80;animation:vod-image-crop-test 4000ms linear both}img{position:absolute;left:400px;top:80px;width:246px;height:206px}</style><div id="piece"></div><img src="/assets/combat/enemies/animations/hexaghost-idle.webp">'
    document.body.append(frame); await loaded
    const doc = frame.contentDocument, clock = createRunVodClock(doc, callback => callback())
    try {
      await doc.querySelector('img').decode()
      await clock.advance(0)
      const composite = await rasterRunVod(doc.body, 1920, 1080, clock.now)
      const before = runVodRasterRegion(doc.body, clock.now)
      await clock.advance(1)
      const between = runVodRasterRegion(doc.body, clock.now)
      let after
      for (let index = 0; index < 120; index++) {
        await clock.advance(1_000 / 60)
        after = runVodRasterRegion(doc.body, clock.now)
        if (after && after.width > 500) break
      }
      const crop = await rasterRunVod(doc.body, 1920, 1080, clock.now, undefined, false, after)
      composite.getContext('2d').drawImage(crop, after.x, after.y)
      const cached = await rasterRunVod(doc.body, 1920, 1080, clock.now)
      await releaseRunVodRaster(doc)
      const fresh = await rasterRunVod(doc.body, 1920, 1080, clock.now)
      const left = new Uint32Array(composite.getContext('2d').getImageData(0, 0, 1920, 1080).data.buffer)
      const cachedLeft = new Uint32Array(cached.getContext('2d').getImageData(0, 0, 1920, 1080).data.buffer)
      const right = new Uint32Array(fresh.getContext('2d').getImageData(0, 0, 1920, 1080).data.buffer)
      const mismatch = left.reduce((count, pixel, index) => count + Number(pixel !== right[index]), 0)
      const cachedMismatch = cachedLeft.reduce((count, pixel, index) => count + Number(pixel !== right[index]), 0)
      composite.width = composite.height = crop.width = crop.height = cached.width = cached.height = fresh.width = fresh.height = 0
      return { safe: before?.safe ?? null, between: between?.safe ?? null, tracked: after?.width > 500, mismatch, cachedMismatch }
    } finally { clock.restore(); frame.remove(); await releaseRunVodRaster(doc) }
  })
  assert.deepEqual(animatedImageCrop, { safe: true, between: true, tracked: true, mismatch: 0, cachedMismatch: 0 },
    'a due animated image must expand a local crop without leaving the cached full frame stale')
  const loopingImage = await page.evaluate(async () => {
    const { rasterRunVod, runVodRasterRegion, releaseRunVodRaster } = await import('/src/ui/run-vod-raster.ts')
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 8
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp'))
    const url = URL.createObjectURL(blob), NativeDecoder = window.ImageDecoder
    const frame = document.createElement('iframe')
    const loaded = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }))
    frame.srcdoc = `<style>html,body{margin:0;width:32px;height:32px}</style><img src="${url}" width="8" height="8">`
    document.body.append(frame); await loaded
    let decodes = 0
    window.ImageDecoder = class {
      constructor() { this.tracks = { ready: Promise.resolve(), selectedTrack: { frameCount: 3, repetitionCount: 1 } } }
      async decode({ frameIndex }) {
        if (++decodes > 20) throw new Error('Finite animated image decoded too many frames')
        return { image: new VideoFrame(canvas, { timestamp: frameIndex * 900_000, duration: 900_000 }) }
      }
      close() {}
    }
    const doc = frame.contentDocument
    try {
      for (const at of [0, 900, 1800, 2700]) {
        const shot = await rasterRunVod(doc.body, 32, 32, at)
        shot.width = shot.height = 0
      }
      const secondCycle = Boolean(runVodRasterRegion(doc.body, 3600))
      for (const at of [3600, 4500, 5400]) {
        const shot = await rasterRunVod(doc.body, 32, 32, at)
        shot.width = shot.height = 0
      }
      return { secondCycle, stopped: runVodRasterRegion(doc.body, 6300) === null }
    } finally {
      window.ImageDecoder = NativeDecoder; frame.remove(); URL.revokeObjectURL(url); await releaseRunVodRaster(doc)
    }
  })
  assert.deepEqual(loopingImage, { secondCycle: true, stopped: true },
    'a finite looping image must schedule cycle two immediately and stop after its allowed repetition')
  const resumedImagePhase = await page.evaluate(async () => {
    const { rasterRunVod, releaseRunVodRaster, runVodImagePhases, seedRunVodImagePhases, trackRunVodImagePhases } = await import('/src/ui/run-vod-raster.ts')
    const colors = ['#f00', '#0f0', '#00f', '#ff0']
    const frames = colors.map(color => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 8
      canvas.getContext('2d').fillStyle = color; canvas.getContext('2d').fillRect(0, 0, 8, 8)
      return canvas
    })
    const blob = await new Promise(resolve => frames[0].toBlob(resolve, 'image/webp'))
    const urls = [], NativeDecoder = window.ImageDecoder
    window.ImageDecoder = class {
      constructor() { this.tracks = { ready: Promise.resolve(), selectedTrack: { frameCount: 4, repetitionCount: Infinity } } }
      async decode({ frameIndex }) { return { image: new VideoFrame(frames[frameIndex], { timestamp: frameIndex * 100_000, duration: 100_000 }) } }
      close() {}
    }
    const documents = []
    const open = async (images = true) => {
      const frame = document.createElement('iframe')
      const loaded = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }))
      const source = URL.createObjectURL(blob); urls.push(source)
      frame.srcdoc = `<style>html,body{margin:0;width:32px;height:8px;background:#000}img{position:absolute;top:0;left:0;width:8px;height:8px}img+img{left:12px}</style>${images ? `<img src="${source}" data-animation-asset="/attack.webp"><img src="${source}" data-animation-asset="/attack.webp">` : ''}`
      document.body.append(frame); await loaded; documents.push(frame)
      await Promise.all([...frame.contentDocument.images].map(image => image.decode()))
      return frame.contentDocument
    }
    const pixel = canvas => [...canvas.getContext('2d').getImageData(4, 4, 1, 1).data]
    const shot = async (doc, at) => {
      const canvas = await rasterRunVod(doc.body, 32, 8, at)
      const value = pixel(canvas); canvas.width = canvas.height = 0
      return value
    }
    try {
      const first = await open()
      await shot(first, 0)
      const expected = await shot(first, 350)
      const eventStart = runVodImagePhases(first, 150)
      const cappedEnd = runVodImagePhases(first, 350)
      const resumed = await open(); seedRunVodImagePhases(resumed, eventStart)
      const baseline = await shot(resumed, 0)
      const afterSkip = await shot(resumed, 200)
      const doubleAdvanced = await open(); seedRunVodImagePhases(doubleAdvanced, cappedEnd)
      await shot(doubleAdvanced, 0)
      const wrong = await shot(doubleAdvanced, 200)
      const inserted = await open(false)
      const insertedSource = URL.createObjectURL(blob); urls.push(insertedSource)
      const image = inserted.createElement('img'); image.src = insertedSource; image.dataset.animationAsset = '/attack.webp'
      inserted.body.append(image); await image.decode()
      trackRunVodImagePhases(inserted, 100)
      const insertedAfterSkip = await shot(inserted, 300)
      return { phases: Object.values(eventStart), baseline, expected, afterSkip, wrong, insertedAfterSkip }
    } finally {
      await Promise.all(documents.map(frame => releaseRunVodRaster(frame.contentDocument)))
      documents.forEach(frame => frame.remove()); frames.forEach(frame => { frame.width = frame.height = 0 })
      urls.forEach(url => URL.revokeObjectURL(url)); window.ImageDecoder = NativeDecoder
    }
  })
  assert.deepEqual(resumedImagePhase.phases, [150, 150], 'same-source image phases must be tracked by ordinal')
  assert.deepEqual(resumedImagePhase.baseline, [0, 255, 0, 255], 'a fresh replay document must seed its animated image phase')
  assert.deepEqual(resumedImagePhase.afterSkip, resumedImagePhase.expected, 'a capped retry must resume from the event-start image phase')
  assert.notDeepEqual(resumedImagePhase.wrong, resumedImagePhase.expected, 'a capped retry must not seed from the prior capped clip end')
  assert.deepEqual(resumedImagePhase.insertedAfterSkip, [0, 0, 255, 255], 'animated images created during skipped frames must retain their skipped age')
  const staleEffect = await page.evaluate(async () => {
    const { createRunVodClock } = await import('/src/ui/run-vod-clock.ts')
    const clock = createRunVodClock(document, window.__STS_DEBUG__.flushVod)
    const stale = document.createElement('div')
    stale.className = 'combat-vfx combat-vfx--actor combat-vfx--lightning'
    stale.style.opacity = '0'
    document.body.append(stale)
    await clock.advance(4000)
    const active = clock.active()
    stale.remove()
    clock.restore()
    return active
  })
  assert.equal(staleEffect, false, 'invisible completed lightning must not keep exporting frames')
  const clockAndCache = await page.evaluate(async () => {
    const { rasterRunVod, releaseRunVodRaster } = await import('/src/ui/run-vod-raster.ts')
    const { createRunVodClock } = await import('/src/ui/run-vod-clock.ts')
    const fixture = document.createElement('div')
    fixture.style.cssText = 'position:fixed;right:0;top:0;width:40px;height:40px;background:rgb(255,0,0);z-index:999999;animation:vod-clock-test 100ms linear both'
    const stale = document.createElement('div')
    stale.style.cssText = 'position:fixed;right:50px;top:0;width:40px;height:40px;background:rgb(0,255,0);z-index:999999'
    const sheet = document.createElement('style')
    sheet.textContent = '@keyframes vod-clock-test {from{opacity:.5}to{opacity:1}}'
    document.head.append(sheet)
    document.body.append(fixture, stale)
    const staleAnimation = stale.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 1000, fill: 'both' })
    staleAnimation.pause(); await staleAnimation.ready; staleAnimation.currentTime = 0
    const events = []
    fixture.addEventListener('animationstart', () => events.push('start'))
    fixture.addEventListener('animationend', () => events.push('end'))
    const clock = createRunVodClock(document, window.__STS_DEBUG__.flushVod)
    const fired = []
    setTimeout(() => fired.push('timeout'), 25)
    const interval = setInterval(() => fired.push('interval'), 50)
    await clock.advance(0)
    const seed = await rasterRunVod(document.body, 1920, 1080, clock.now)
    seed.width = seed.height = 0
    staleAnimation.cancel()
    const overlap = await rasterRunVod(document.body, 1920, 1080, clock.now)
    const overlapPixel = [...overlap.getContext('2d').getImageData(1860, 10, 1, 1).data]
    overlap.width = overlap.height = 0
    await clock.advance(150)
    clearInterval(interval)
    const first = await rasterRunVod(document.body, 1920, 1080, clock.now)
    fixture.style.backgroundColor = 'rgb(0,0,255)'
    const second = await rasterRunVod(document.body, 1920, 1080, clock.now)
    const cached = await rasterRunVod(document.body, 1920, 1080, clock.now)
    const pixel = (canvas) => [...canvas.getContext('2d').getImageData(1910, 10, 1, 1).data]
    const result = { events, fired, overlapPixel, pixels: [pixel(first), pixel(second), pixel(cached)] }
    clock.restore()
    fixture.remove(); stale.remove(); sheet.remove()
    await releaseRunVodRaster()
    return result
  })
  assert.deepEqual(clockAndCache.fired, ['timeout', 'interval', 'interval', 'interval'])
  assert.deepEqual(clockAndCache.events, ['start', 'end'], 'virtual CSS animations must deliver game completion events')
  assert.deepEqual(clockAndCache.overlapPixel, [0, 255, 0, 255], 'a finished animation must refresh its cached final style while another animation remains active')
  assert.deepEqual(clockAndCache.pixels, [[255, 0, 0, 255], [0, 0, 255, 255], [0, 0, 255, 255]])
  const closedDialogCache = await page.evaluate(async () => {
    const { rasterRunVod, releaseRunVodRaster } = await import('/src/ui/run-vod-raster.ts')
    const frame = document.createElement('iframe')
    document.body.append(frame)
    const doc = frame.contentDocument
    const dialog = doc.createElement('dialog')
    dialog.innerHTML = '<input type="checkbox" aria-label="Hidden upgrade preview">'
    doc.body.append(dialog)
    const native = XMLSerializer.prototype.serializeToString
    let serializations = 0
    XMLSerializer.prototype.serializeToString = function (...args) { serializations++; return native.apply(this, args) }
    try {
      await rasterRunVod(doc.body, 1920, 1080, 0)
      const initial = serializations
      dialog.querySelector('input').name = 'hidden-preview'
      await rasterRunVod(doc.body, 1920, 1080, 0)
      const cached = serializations
      dialog.showModal()
      await rasterRunVod(doc.body, 1920, 1080, 0)
      return { reused: cached === initial, opened: serializations > cached }
    } finally {
      XMLSerializer.prototype.serializeToString = native
      dialog.close(); dialog.remove(); await releaseRunVodRaster(doc); frame.remove()
    }
  })
  assert.deepEqual(closedDialogCache, { reused: true, opened: true },
    'closed-dialog form bookkeeping must keep the cached frame, while opening it must refresh the frame')
  const restyledAnimationPixels = await page.evaluate(async () => {
    const { rasterRunVod, releaseRunVodRaster } = await import('/src/ui/run-vod-raster.ts')
    const { createRunVodClock } = await import('/src/ui/run-vod-clock.ts')
    const frame = document.createElement('iframe')
    frame.style.cssText = 'position:fixed;left:-1920px;top:0;width:1920px;height:1080px;border:0'
    const loaded = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }))
    frame.srcdoc = '<!doctype html><html><head></head><body></body></html>'
    document.body.append(frame); await loaded
    const fixtureDoc = frame.contentDocument
    const style = fixtureDoc.createElement('style')
    style.textContent = '@keyframes vod-restyle-test{from{opacity:0}to{opacity:1}}'
    const host = fixtureDoc.createElement('div')
    host.style.cssText = 'position:fixed;left:0;top:0;width:96px;height:96px;z-index:999999'
    host.innerHTML = '<div class="enemy__hit-area" style="position:absolute;left:0;top:0;width:24px;height:24px;background:rgb(0,0,255)"></div><div style="position:absolute;left:32px;top:0;width:24px;height:24px;background:rgb(255,0,0);animation:vod-restyle-test 1000ms linear both"></div>'
    fixtureDoc.head.append(style); fixtureDoc.body.append(host)
    const animation = host.getAnimations({ subtree: true })[0]
    animation.pause(); await animation.ready; animation.currentTime = 0
    const clock = createRunVodClock(fixtureDoc, callback => callback())
    try {
      await clock.advance(0)
      const initial = await rasterRunVod(fixtureDoc.body, 1920, 1080, clock.now)
      initial.width = initial.height = 0
      await clock.advance(500)
      host.querySelector('.enemy__hit-area').style.left = '12px'
      const cached = await rasterRunVod(fixtureDoc.body, 1920, 1080, clock.now)
      await releaseRunVodRaster(fixtureDoc)
      const fresh = await rasterRunVod(fixtureDoc.body, 1920, 1080, clock.now)
      const left = new Uint32Array(cached.getContext('2d').getImageData(0, 0, 1920, 1080).data.buffer)
      const right = new Uint32Array(fresh.getContext('2d').getImageData(0, 0, 1920, 1080).data.buffer)
      let mismatch = 0, minX = 1920, minY = 1080, maxX = -1, maxY = -1
      for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) {
        mismatch++
        const x = index % 1920, y = Math.floor(index / 1920)
        minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y)
      }
      cached.width = cached.height = fresh.width = fresh.height = 0
      return { mismatch, bounds: [minX, minY, maxX, maxY] }
    } finally {
      clock.restore(); frame.remove(); await releaseRunVodRaster(fixtureDoc)
    }
  })
  assert.equal(restyledAnimationPixels.mismatch, 0,
    'an allowed overlay restyle must preserve concurrent CSS animation pixels')
  await page.evaluate(() => {
    const host = document.createElement('div')
    host.id = 'vod-choice-fixture'
    host.style.transform = 'translate(70px, 20px)'
    host.innerHTML = `<dialog class="choice-modal" style="width:240px;padding:20px;background:rgb(0,0,255)"><div style="height:80px;overflow:auto;display:grid;grid-template-columns:1fr"><button style="height:80px;border:0;padding:0;background:rgb(255,0,0)">First card</button><button style="height:80px;border:0;padding:0;background:rgb(0,255,0)">Chosen card</button></div></dialog>`
    document.body.append(host)
    host.querySelector('dialog').showModal()
    host.querySelector('div').scrollTop = 80
  })
  await page.screenshot({ path: `${output}/choice-native.png` })
  const choice = await page.evaluate(async () => {
    const { rasterRunVod, releaseRunVodRaster } = await import('/src/ui/run-vod-raster.ts')
    const dialog = document.querySelector('#vod-choice-fixture dialog')
    const scroller = dialog.querySelector('div')
    const rect = scroller.getBoundingClientRect()
    const sample = canvas => [...canvas.getContext('2d').getImageData(rect.left + 4, rect.top + 4, 1, 1).data]
    const first = await rasterRunVod(document.body, 1920, 1080, 0)
    const cached = await rasterRunVod(document.body, 1920, 1080, 0)
    scroller.scrollTop = 0
    const reset = await rasterRunVod(document.body, 1920, 1080, 0)
    const result = { png: first.toDataURL(), pixels: [sample(first), sample(cached), sample(reset)] }
    dialog.close(); document.querySelector('#vod-choice-fixture').remove()
    await releaseRunVodRaster()
    return result
  })
  writeFileSync(`${output}/choice-raster.png`, Buffer.from(choice.png.split(',')[1], 'base64'))
  assert.deepEqual(choice.pixels, [[0, 255, 0, 255], [0, 255, 0, 255], [255, 0, 0, 255]], 'modal geometry and scrolled card choices must survive fresh/cached rasterization')
  const unchangedFrames = await page.evaluate(async () => {
    const { captureMotion, replayClocks } = await import('/src/ui/run-vod.ts')
    const { createRunVodClock } = await import('/src/ui/run-vod-clock.ts')
    const { releaseRunVodRaster } = await import('/src/ui/run-vod-raster.ts')
    const frame = document.createElement('iframe')
    const loaded = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }))
    frame.srcdoc = '<style>html,body{margin:0;width:1920px;height:1080px;background:rgb(255,0,0)}</style><div data-webmcp-pending="true"></div>'
    document.body.append(frame); await loaded
    const doc = frame.contentDocument, clock = createRunVodClock(doc, callback => callback())
    replayClocks.set(doc, clock)
    const colors = []
    doc.defaultView.setTimeout(() => { doc.body.style.background = 'rgb(0,255,0)' }, 1)
    doc.defaultView.setTimeout(() => { doc.body.style.background = 'rgb(0,0,255)' }, 40)
    doc.defaultView.setTimeout(() => {
      doc.querySelector('[data-webmcp-pending]').remove()
    }, 100)
    try {
      await captureMotion(doc, { write() { throw new Error('stream capture must not use the snapshot store') } }, 0, () => {}, {
        async motion(canvas) { colors.push([...canvas.getContext('2d').getImageData(10, 10, 1, 1).data]) },
      })
      return colors
    } finally {
      replayClocks.delete(doc); clock.restore(); frame.remove(); await releaseRunVodRaster(doc)
    }
  })
  assert.deepEqual(unchangedFrames, [
    [255, 0, 0, 255], [0, 255, 0, 255], [0, 255, 0, 255],
    [0, 0, 255, 255], [0, 0, 255, 255], [0, 0, 255, 255],
  ], 'frame reuse must drain queued rasters and repaint a dirty DOM before repeating it')
  const scrolledFrames = await page.evaluate(async () => {
    const { captureMotion, replayClocks } = await import('/src/ui/run-vod.ts')
    const { createRunVodClock } = await import('/src/ui/run-vod-clock.ts')
    const { releaseRunVodRaster } = await import('/src/ui/run-vod-raster.ts')
    const frame = document.createElement('iframe')
    const loaded = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }))
    frame.srcdoc = '<style>html,body{margin:0;width:1920px;height:1080px;background:#000}#scroll{width:40px;height:40px;overflow:hidden}i{display:block;width:40px;height:40px;background:#f00}i+ i{background:#0f0}</style><div id="scroll"><i></i><i></i></div><div data-webmcp-pending="true"></div>'
    document.body.append(frame); await loaded
    const doc = frame.contentDocument, clock = createRunVodClock(doc, callback => callback())
    replayClocks.set(doc, clock)
    const colors = []
    doc.defaultView.setTimeout(() => { doc.querySelector('#scroll').scrollTop = 40 }, 40)
    doc.defaultView.setTimeout(() => doc.querySelector('[data-webmcp-pending]').remove(), 100)
    try {
      await captureMotion(doc, { write() { throw new Error('stream capture must not use the snapshot store') } }, 0, () => {}, {
        async motion(canvas) { colors.push([...canvas.getContext('2d').getImageData(10, 10, 1, 1).data]) },
      })
      return colors
    } finally {
      replayClocks.delete(doc); clock.restore(); frame.remove(); await releaseRunVodRaster(doc)
    }
  })
  assert(scrolledFrames.some(color => color[1] === 255) && scrolledFrames.at(-1)[1] === 255,
    'scroll-only motion must repaint before unchanged-frame reuse')
  const finishedAnimationFrames = await page.evaluate(async () => {
    const { captureMotion, replayClocks } = await import('/src/ui/run-vod.ts')
    const { createRunVodClock } = await import('/src/ui/run-vod-clock.ts')
    const { releaseRunVodRaster } = await import('/src/ui/run-vod-raster.ts')
    const frame = document.createElement('iframe')
    const loaded = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }))
    frame.srcdoc = '<style>html,body{margin:0;width:1920px;height:1080px;background:#000}@keyframes finish{0%,99%{background:#f00}100%{background:#0f0}}#piece{width:40px;height:40px;animation:finish 30ms linear both}</style><div id="piece"></div><div data-webmcp-pending="true"></div>'
    document.body.append(frame); await loaded
    const doc = frame.contentDocument, clock = createRunVodClock(doc, callback => callback())
    replayClocks.set(doc, clock)
    const colors = []
    doc.defaultView.setTimeout(() => doc.querySelector('[data-webmcp-pending]').remove(), 100)
    try {
      await captureMotion(doc, { write() { throw new Error('stream capture must not use the snapshot store') } }, 0, () => {}, {
        async motion(canvas) { colors.push([...canvas.getContext('2d').getImageData(10, 10, 1, 1).data]) },
      })
      return colors
    } finally {
      replayClocks.delete(doc); clock.restore(); frame.remove(); await releaseRunVodRaster(doc)
    }
  })
  assert.deepEqual(finishedAnimationFrames.slice(2), finishedAnimationFrames.slice(2).map(() => [0, 255, 0, 255]),
    'the final animation state must be painted once before unchanged-frame reuse')
  await page.goto(`http://localhost:${server.httpServer.address().port}/?run-vod=1`)
  await page.waitForFunction(() => window.__STS_DEBUG__)
  const replayTransitions = await page.evaluate(async () => {
    const { createRun, enterRoom } = await import('/src/game/run.ts')
    const { createRunVodClock } = await import('/src/ui/run-vod-clock.ts')
    const nativeTimeout = window.setTimeout.bind(window)
    const clock = createRunVodClock(document, window.__STS_DEBUG__.flushVod)
    const initial = createRun('vod-no-autoplay', [{ id: 'p1', name: 'Defect', character: 'defect' }])
    const map = { ...initial, phase: 'map', neow: null }
    const room = Object.values(map.map.rooms).find(room => room.row === 0 && room.kind === 'encounter')
    const run = enterRoom(map, room.id)
    // Each automatic transition is already its own logged event. Letting normal
    // gameplay timers run here rewinds/replays turns when the next log is applied.
    const phases = []
    for (const phase of ['enemy', 'roundEnd', 'won']) {
      const next = structuredClone(run)
      next.combat.phase = phase
      const previous = window.__STS_DEBUG__.getRun()
      window.__STS_DEBUG__.setRun(next)
      const deadline = Date.now() + 5000
      while (window.__STS_DEBUG__.getRun() === previous) {
        if (Date.now() > deadline) throw new Error('Replay fixture did not commit')
        await new Promise(resolve => nativeTimeout(resolve, 10))
      }
      await clock.advance(0)
      await clock.advance(5000)
      phases.push([window.__STS_DEBUG__.getRun().phase, window.__STS_DEBUG__.getRun().combat?.phase])
    }
    clock.restore()
    return phases
  })
  assert.deepEqual(replayTransitions, [['combat', 'enemy'], ['combat', 'roundEnd'], ['combat', 'won']],
    'replay must never run gameplay timers ahead of the event log or replay their card animations')
  const scrolling = await page.evaluate(async () => {
    const { queryControl } = await import('/src/ui/run-vod.ts')
    const host = document.createElement('div')
    host.style.cssText = 'position:fixed;left:0;top:0;width:300px;height:200px;overflow:hidden'
    host.innerHTML = `<div style="width:3000px;height:2000px"><button style="position:absolute;left:2400px;top:1500px">Unrelated</button><div id="vod-scroll-test" style="position:absolute;left:20px;top:20px;width:200px;height:100px;overflow:auto"><div style="height:300px"></div><button>Chosen</button></div></div>`
    document.body.append(host)
    const target = queryControl(document, { selector: '.missing-control', name: 'Chosen' })
    const scroller = document.querySelector('#vod-scroll-test')
    const box = target?.getBoundingClientRect()
    const bounds = scroller.getBoundingClientRect()
    const result = { host: [host.scrollLeft, host.scrollTop], root: [scrollX, scrollY],
      scrolled: scroller.scrollTop > 0, visible: box && box.top >= bounds.top && box.bottom <= bounds.bottom + 1 }
    host.remove()
    return result
  })
  assert.deepEqual(scrolling, { host: [0, 0], root: [0, 0], scrolled: true, visible: true },
    'resolving a control must scroll only its picker, not unrelated controls or the replay stage')
  const centeredGrid = await page.evaluate(async () => {
    const { rasterRunVod, releaseRunVodRaster } = await import('/src/ui/run-vod-raster.ts')
    const { createRunVodClock } = await import('/src/ui/run-vod-clock.ts')
    const host = document.createElement('div')
    host.style.cssText = 'position:fixed;inset:0;background:red;z-index:999999'
    // Same centered grid/full-bleed child geometry used by the map and header.
    host.innerHTML = `<style>@keyframes vod-margin-test{from{opacity:1}to{opacity:.99}}</style><div style="display:grid;grid-template-columns:minmax(0,1fr);width:1400px;margin:0 auto;animation:vod-margin-test 1000ms linear both"><div style="width:1920px;height:50px;margin-left:calc(50% - 960px);background:rgb(0,255,0)"></div></div>`
    document.body.append(host)
    const clock = createRunVodClock(document, window.__STS_DEBUG__.flushVod)
    const pixels = []
    for (const step of [0, 100]) {
      await clock.advance(step)
      const canvas = await rasterRunVod(document.body, 1920, 1080, clock.now)
      pixels.push([...canvas.getContext('2d').getImageData(1910, 20, 1, 1).data])
    }
    clock.restore(); host.remove(); await releaseRunVodRaster()
    return pixels
  })
  for (const pixel of centeredGrid) assert(pixel[1] > 250 && pixel[0] < 5,
    `fresh/cached raster lost centered auto margins and clipped the full-bleed header: ${pixel}`)
  const hiddenCompletion = await page.evaluate(async () => {
    const frame = document.createElement('iframe')
    frame.style.opacity = '0'
    const loaded = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }))
    frame.srcdoc = '<style>@keyframes hidden-test{from{opacity:1}to{opacity:0}}</style><div style="animation:hidden-test 100ms linear both">Hidden</div>'
    document.body.append(frame)
    await loaded
    const doc = frame.contentDocument
    let ends = 0
    doc.querySelector('div').addEventListener('animationend', () => ends++)
    const clock = (await import('/src/ui/run-vod-clock.ts')).createRunVodClock(doc, callback => callback())
    for (let i = 0; i < 12; i++) await clock.advance(1000 / 60)
    clock.restore(); frame.remove()
    return ends
  })
  assert.equal(hiddenCompletion, 1, 'hidden replay animations must deliver completion exactly once')
  const lifetime = await page.evaluate(async () => {
    const { rasterRunVod, pruneRunVodRaster, releaseRunVodRaster } = await import('/src/ui/run-vod-raster.ts')
    await releaseRunVodRaster()
    const host = document.createElement('div')
    host.style.cssText = 'position:fixed;left:0;top:0;width:32px;height:32px'
    document.body.append(host)
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 8
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp'))
    const urls = [URL.createObjectURL(blob), URL.createObjectURL(blob)]
    const NativeDecoder = window.ImageDecoder, NativeImage = window.Image
    let opened = 0, closed = 0
    const images = []
    window.Image = class extends NativeImage {
      get src() { return super.src }
      set src(value) { if (value.startsWith('data:image/svg+xml')) images.push(this); super.src = value }
    }
    window.ImageDecoder = class {
      constructor() { this.tracks = { ready: Promise.resolve(), selectedTrack: { frameCount: ++opened, repetitionCount: 0 } } }
      async decode() { return { image: new VideoFrame(canvas, { timestamp: 0, duration: 100000 }) } }
      close() { closed++ }
    }
    try {
      for (const url of urls) {
        const img = document.createElement('img'); img.src = url; img.width = img.height = 8; host.append(img)
      }
      await rasterRunVod(host, 32, 32, 0)
      const staticClosed = closed === 1
      await rasterRunVod(host, 32, 32, 10)
      const reused = opened === 2
      host.remove()
      await pruneRunVodRaster(document)
      await releaseRunVodRaster(document)
      return { staticClosed, reused, allClosed: closed === 2,
        imagesReleased: images.length === 0 && !document.querySelector('[data-run-vod-raster-decoder]') }
    } finally {
      window.ImageDecoder = NativeDecoder; window.Image = NativeImage
      host.remove(); urls.forEach(url => URL.revokeObjectURL(url)); await releaseRunVodRaster()
    }
  })
  assert.deepEqual(lifetime, { staticClosed: true, reused: true, allClosed: true, imagesReleased: true },
    'raster resources must be released between events, not retained for the whole run')
  const isolated = await page.evaluate(async () => {
    const { rasterRunVod, releaseRunVodRaster, pruneRunVodRaster } = await import('/src/ui/run-vod-raster.ts')
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 8
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp'))
    const url = URL.createObjectURL(blob)
    const NativeDecoder = window.ImageDecoder
    let opened = 0, closed = 0
    const decoded = []
    window.ImageDecoder = class {
      constructor() { this.id = ++opened; this.closed = false; this.tracks = { ready: Promise.resolve(), selectedTrack: { frameCount: 2, repetitionCount: 0 } } }
      async decode({ frameIndex = 0 } = {}) {
        if (this.closed) throw new Error('Another location closed this decoder')
        decoded.push([this.id, frameIndex])
        return { image: new VideoFrame(canvas, { timestamp: 0, duration: 100000 }) }
      }
      close() { if (!this.closed) closed++; this.closed = true }
    }
    const frames = []
    try {
      for (let i = 0; i < 4; i++) {
        const frame = document.createElement('iframe')
        const loaded = new Promise(resolve => frame.onload = resolve)
        frame.srcdoc = `<img src="${url}" width="8" height="8">`
        document.body.append(frame); frames.push(frame); await loaded
      }
      await Promise.all(frames.map(frame => rasterRunVod(frame.contentDocument.body, 32, 32, 0)))
      await releaseRunVodRaster(frames[0].contentDocument)
      await pruneRunVodRaster(frames[0].contentDocument)
      const onlyFirstClosed = closed === 1
      for (const frame of frames.slice(1)) {
        await rasterRunVod(frame.contentDocument.body, 32, 32, 150)
        await releaseRunVodRaster(frame.contentDocument)
      }
      return { isolated: opened === 4 && onlyFirstClosed && closed === 4,
        primed: [2, 3, 4].every(id => decoded.some(([decoder, frame]) => decoder === id && frame === 1)) }
    } finally {
      await releaseRunVodRaster(); window.ImageDecoder = NativeDecoder
      frames.forEach(frame => frame.remove()); URL.revokeObjectURL(url)
    }
  })
  assert.deepEqual(isolated, { isolated: true, primed: true },
    'parallel reset documents must prime independent animated-image clocks before resumed frames')
  const detachedActive = await page.evaluate(async () => {
    const { createRunVodClock } = await import('/src/ui/run-vod-clock.ts')
    const frame = document.createElement('iframe')
    const loaded = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }))
    frame.srcdoc = '<div>Detached animation</div>'; document.body.append(frame); await loaded
    const doc = frame.contentDocument, host = doc.querySelector('div')
    const animation = host.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 10000, fill: 'both' })
    const clock = createRunVodClock(doc, callback => callback())
    await clock.advance(0)
    host.remove()
    const active = clock.active()
    clock.restore(); animation.cancel(); frame.remove()
    return active
  })
  assert.equal(detachedActive, false, 'detached paused animations must not retain their targets or keep capture running')
  const assetSizes = await page.evaluate(async () => {
    const { rasterRunVod, releaseRunVodRaster } = await import('/src/ui/run-vod-raster.ts')
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 512
    const context = canvas.getContext('2d')
    const gradient = context.createLinearGradient(0, 0, 512, 512)
    gradient.addColorStop(0, 'red'); gradient.addColorStop(1, 'blue')
    context.fillStyle = gradient; context.fillRect(0, 0, 512, 512)
    const url = URL.createObjectURL(await new Promise(resolve => canvas.toBlob(resolve)))
    const host = document.createElement('div'), img = document.createElement('img')
    host.style.cssText = 'position:fixed;left:0;top:0;width:256px;height:256px'
    img.src = url; img.dataset.vodSized = ''; host.append(img); document.body.append(host); await img.decode()
    const NativeSerializer = window.XMLSerializer
    let serialized
    window.XMLSerializer = class extends NativeSerializer {
      serializeToString(node) { serialized = super.serializeToString(node); return serialized }
    }
    try {
      const sizes = []
      for (const size of [32, 128]) {
        img.width = img.height = size
        await rasterRunVod(host, 256, 256, 0)
        const clone = new DOMParser().parseFromString(serialized, 'application/xhtml+xml')
        const bitmap = await createImageBitmap(await (await fetch(clone.querySelector('[data-vod-sized]').getAttribute('src'))).blob())
        sizes.push(bitmap.width); bitmap.close()
      }
      return sizes
    } finally { window.XMLSerializer = NativeSerializer; host.remove(); URL.revokeObjectURL(url); await releaseRunVodRaster() }
  })
  assert.deepEqual(assetSizes, [64, 256], 'cached artwork must stay at least 2x output resolution and grow for zooms')
  assert.deepEqual(errors, [])
  console.log('PASS: desktop/phone HP spacing, native raster, attack progression and completion')
} finally { await browser.close(); await server.close() }
