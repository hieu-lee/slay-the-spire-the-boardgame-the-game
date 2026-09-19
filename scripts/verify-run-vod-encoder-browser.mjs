import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { chromium } from './lib/profile-browser.mjs'

const server = await createServer({ logLevel: 'silent', server: { port: 0 } })
await server.listen()
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage()
  await page.route('**/__encoder-test', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }))
  await page.goto(`http://localhost:${server.httpServer.address().port}/__encoder-test`)
  const result = await page.evaluate(async () => {
    const { createRunVodEncoder } = await import('/src/ui/run-vod-encoder.ts')
    const canvas = document.createElement('canvas')
    canvas.width = 1920; canvas.height = 1080
    const context = canvas.getContext('2d', { willReadFrequently: true })
    const gradient = context.createLinearGradient(0, 0, 1920, 1080)
    gradient.addColorStop(0, '#281025'); gradient.addColorStop(1, '#aaf8')
    context.fillStyle = gradient; context.fillRect(0, 0, 1920, 1080)
    for (let i = 0; i < 100; i++) {
      context.fillStyle = `hsl(${i * 17} 80% 50%)`
      context.fillRect((i * 137) % 1920, (i * 83) % 1080, 120, 60)
    }
    const source = context.getImageData(0, 0, 1920, 1080).data
    const checkPixels = async (blob) => {
      const bitmap = await createImageBitmap(blob)
      const output = document.createElement('canvas')
      output.width = bitmap.width; output.height = bitmap.height
      const target = output.getContext('2d')
      target.drawImage(bitmap, 0, 0); bitmap.close()
      const pixels = target.getImageData(0, 0, 1920, 1080).data
      return pixels.every((value, index) => value === source[index])
    }
    const encoder = createRunVodEncoder()
    try {
      const first = encoder.encode(canvas), second = encoder.encode(canvas)
      const bounded = await encoder.encode(canvas).then(() => false, () => true)
      const blobs = await Promise.all([first, second])
      const lossless = (await Promise.all(blobs.map(checkPixels))).every(Boolean)
      let started = performance.now()
      for (let i = 0; i < 3; i++) await Promise.all([encoder.encode(canvas), encoder.encode(canvas)])
      const parallelMs = performance.now() - started
      started = performance.now()
      for (let i = 0; i < 6; i++) await (await fetch(canvas.toDataURL('image/png'))).blob()
      const serialMs = performance.now() - started
      const pending = [encoder.encode(canvas), encoder.encode(canvas)]
      encoder.close()
      const cancelled = (await Promise.allSettled(pending)).every((entry) => entry.status === 'rejected')
      const closed = await encoder.encode(canvas).then(() => false, () => true)
      const WorkerClass = window.Worker
      let fallbackLossless, workerFailure
      try {
        let terminated = 0
        window.Worker = class {
          constructor() { setTimeout(() => this.onerror?.({ preventDefault() {}, message: 'test encoder failure' }), 0) }
          postMessage(bitmap) { bitmap.close() }
          terminate() { terminated++ }
        }
        const broken = createRunVodEncoder()
        const failures = await Promise.allSettled([broken.encode(canvas), broken.encode(canvas)])
        workerFailure = failures.every((entry) => entry.status === 'rejected') && terminated >= 2
        broken.close()
        window.Worker = undefined
        const fallback = createRunVodEncoder()
        try { fallbackLossless = await checkPixels(await fallback.encode(canvas)) }
        finally { fallback.close() }
      } finally { window.Worker = WorkerClass }
      const { runVodFrameDelta } = await import('/src/ui/run-vod.ts')
      const rebuilt = document.createElement('canvas')
      rebuilt.width = canvas.width; rebuilt.height = canvas.height
      const rebuiltContext = rebuilt.getContext('2d')
      rebuiltContext.drawImage(canvas, 0, 0)
      context.fillStyle = '#fff'
      context.fillRect(0, 0, 8, 8)
      context.fillRect(127, 127, 8, 8)
      context.clearRect(1911, 1071, 9, 9)
      const after = context.getImageData(0, 0, 1920, 1080).data
      const pixels = new Uint32Array(after.buffer)
      const delta = runVodFrameDelta(canvas, pixels, new Uint32Array(source.buffer))
      for (const tile of delta.tiles) {
        rebuiltContext.clearRect(tile.x, tile.y, tile.width, tile.height)
        rebuiltContext.drawImage(delta.canvas, tile.sx, tile.sy, tile.width, tile.height,
          tile.x, tile.y, tile.width, tile.height)
      }
      const restored = rebuiltContext.getImageData(0, 0, 1920, 1080).data
      const tileLossless = after.every((value, index) => value === restored[index])
      const tileBounded = delta.canvas.width * delta.canvas.height < canvas.width * canvas.height / 10
      const unchanged = runVodFrameDelta(canvas, pixels, pixels) === null
      return { bounded, lossless, cancelled, closed, fallbackLossless, workerFailure, parallelMs, serialMs,
        tileLossless, tileBounded, unchanged }
    } finally { encoder.close() }
  })
  for (const key of ['bounded', 'lossless', 'cancelled', 'closed', 'fallbackLossless', 'workerFailure', 'tileLossless', 'tileBounded', 'unchanged']) assert.equal(result[key], true, key)
  console.log(`VOD PNG encoder: bounded, lossless, cancellation, fallback passed; six 1080p frames: workers ${result.parallelMs.toFixed(0)}ms / serial ${result.serialMs.toFixed(0)}ms`)
} finally {
  await browser.close()
  await server.close()
}
