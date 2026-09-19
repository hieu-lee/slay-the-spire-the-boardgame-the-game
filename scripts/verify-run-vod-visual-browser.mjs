import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'vite'
import { chromium } from './lib/profile-browser.mjs'
const output = 'artifacts/run-vod'
mkdirSync(output, { recursive: true })
const server = await createServer({ logLevel: 'silent', server: { port: 0 } })
await server.listen()
const browser = await chromium.launch({ headless: true })
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
    const { rasterRunVod } = await import('/src/ui/run-vod-raster.ts')
    const host = document.createElement('div')
    host.style.cssText = 'display:block;width:32px;height:32px;line-height:0'
    const source = new Image(32, 32)
    source.src = '/assets/ui/cursor.png'
    source.style.cssText = 'display:block;width:32px;height:32px'
    host.append(source); document.body.append(host)
    try {
      await source.decode()
      const expected = document.createElement('canvas')
      expected.width = expected.height = 32
      expected.getContext('2d').drawImage(source, 0, 0)
      const actual = await rasterRunVod(host, 32, 32, 0)
      const left = new Uint32Array(expected.getContext('2d').getImageData(0, 0, 32, 32).data.buffer)
      const right = new Uint32Array(actual.getContext('2d').getImageData(0, 0, 32, 32).data.buffer)
      const mismatch = left.reduce((count, pixel, index) => count + Number(pixel !== right[index]), 0)
      expected.width = expected.height = actual.width = actual.height = 0
      return mismatch
    } finally { host.remove() }
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
    const sheet = document.createElement('style')
    sheet.textContent = '@keyframes vod-clock-test {from{opacity:.5}to{opacity:1}}'
    document.head.append(sheet)
    document.body.append(fixture)
    const events = []
    fixture.addEventListener('animationstart', () => events.push('start'))
    fixture.addEventListener('animationend', () => events.push('end'))
    const clock = createRunVodClock(document, window.__STS_DEBUG__.flushVod)
    const fired = []
    setTimeout(() => fired.push('timeout'), 25)
    const interval = setInterval(() => fired.push('interval'), 50)
    await clock.advance(150)
    clearInterval(interval)
    const first = await rasterRunVod(document.body, 1920, 1080, clock.now)
    fixture.style.backgroundColor = 'rgb(0,0,255)'
    const second = await rasterRunVod(document.body, 1920, 1080, clock.now)
    const cached = await rasterRunVod(document.body, 1920, 1080, clock.now)
    const pixel = (canvas) => [...canvas.getContext('2d').getImageData(1910, 10, 1, 1).data]
    const result = { events, fired, pixels: [pixel(first), pixel(second), pixel(cached)] }
    clock.restore()
    fixture.remove(); sheet.remove()
    await releaseRunVodRaster()
    return result
  })
  assert.deepEqual(clockAndCache.fired, ['timeout', 'interval', 'interval', 'interval'])
  assert.deepEqual(clockAndCache.events, ['start', 'end'], 'virtual CSS animations must deliver game completion events')
  assert.deepEqual(clockAndCache.pixels, [[255, 0, 0, 255], [0, 0, 255, 255], [0, 0, 255, 255]])
  const closedDialogCache = await page.evaluate(async () => {
    const { rasterRunVod, releaseRunVodRaster } = await import('/src/ui/run-vod-raster.ts')
    await releaseRunVodRaster()
    const dialog = document.createElement('dialog')
    dialog.innerHTML = '<input type="checkbox" aria-label="Hidden upgrade preview">'
    document.body.append(dialog)
    const native = XMLSerializer.prototype.serializeToString
    let serializations = 0
    XMLSerializer.prototype.serializeToString = function (...args) { serializations++; return native.apply(this, args) }
    try {
      await rasterRunVod(document.body, 1920, 1080, 0)
      const initial = serializations
      dialog.querySelector('input').name = 'hidden-preview'
      await rasterRunVod(document.body, 1920, 1080, 0)
      const cached = serializations
      dialog.showModal()
      await rasterRunVod(document.body, 1920, 1080, 0)
      return { reused: cached === initial, opened: serializations > cached }
    } finally {
      XMLSerializer.prototype.serializeToString = native
      dialog.close(); dialog.remove(); await releaseRunVodRaster()
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
      return { staticClosed, reused, allClosed: closed === 2, imagesReleased: images.length === 2 && images.every(image => !image.hasAttribute('src')) }
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
    window.ImageDecoder = class {
      constructor() { opened++; this.closed = false; this.tracks = { ready: Promise.resolve(), selectedTrack: { frameCount: 2, repetitionCount: 0 } } }
      async decode() { if (this.closed) throw new Error('Another location closed this decoder'); return { image: new VideoFrame(canvas, { timestamp: 0, duration: 100000 }) } }
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
      return opened === 4 && onlyFirstClosed && closed === 4
    } finally {
      await releaseRunVodRaster(); window.ImageDecoder = NativeDecoder
      frames.forEach(frame => frame.remove()); URL.revokeObjectURL(url)
    }
  })
  assert(isolated, 'parallel location decoders must have independent clocks and cleanup')
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
