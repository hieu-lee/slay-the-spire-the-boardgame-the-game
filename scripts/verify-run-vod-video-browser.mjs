import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createServer } from 'vite'
import { chromium } from './lib/profile-browser.mjs'

const server = await createServer({ logLevel: 'silent', server: { port: 0 } })
await server.listen()
const browser = await chromium.launch({ headless: true })
const directory = mkdtempSync(join(tmpdir(), 'vod-offline-check-'))
try {
  const page = await browser.newPage()
  await page.route('**/__video-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }))
  await page.goto(`http://localhost:${server.httpServer.address().port}/__video-test`)
  const result = await page.evaluate(async () => {
    const { createOfflineRunVod, createRunVodJoiner, runVodMemoryFile, runVodVideoCodec } = await import('/src/ui/run-vod-video.ts')
    const memory = runVodMemoryFile()
    const block = new Uint8Array(1024 * 1024 + 500).fill(7)
    memory.write({ position: 0, data: block })
    memory.write({ position: 32, data: new Uint8Array([1, 2, 3, 4]) })
    memory.write({ position: 1024 * 1024 - 2, data: new Uint8Array([5, 4, 3, 2]) })
    const rewritten = new Uint8Array(await memory.blob('video/mp4').arrayBuffer())
    if (rewritten.length !== block.length || rewritten[32] !== 1 || rewritten[35] !== 4 ||
      rewritten[1024 * 1024 - 2] !== 5 || rewritten[1024 * 1024 + 1] !== 2 || rewritten.at(-1) !== 7) {
      throw new Error('Partial seek rewrites corrupted the memory-only movie')
    }
    let bounded = false
    try { memory.write({ position: 256 * 1024 * 1024, data: new Uint8Array([1]) }) } catch { bounded = true }
    if (!bounded) throw new Error('The memory-only movie has no size limit')
    const canvas = document.createElement('canvas')
    canvas.width = 1920; canvas.height = 1080
    const ctx = canvas.getContext('2d')
    const wav = new ArrayBuffer(44 + 48_000 * 2)
    const view = new DataView(wav)
    const text = (offset, value) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)))
    text(0, 'RIFF'); view.setUint32(4, wav.byteLength - 8, true); text(8, 'WAVEfmt ')
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
    view.setUint32(24, 48_000, true); view.setUint32(28, 96_000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
    text(36, 'data'); view.setUint32(40, 96_000, true)
    for (let i = 0; i < 48_000; i++) view.setInt16(44 + i * 2, Math.sin(i / 48_000 * Math.PI * 2 * 440) * 16000, true)
    const source = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }))
    const store = { video: async () => null, videoFile: async () => null }
    const cues = [
      { source, at: .25, end: .75, volume: .5, rate: 1, loop: true },
      { source, at: 10.25, end: 10.75, volume: .5, rate: 1, loop: true },
    ]
    const encoder = await createOfflineRunVod(canvas, 120, cues, store, () => {})
    if (!encoder) throw new Error('The test browser has no offline encoder')
    const started = performance.now()
    try {
      for (let frame = 0; frame < 1440; frame++) {
        ctx.fillStyle = frame < 120 ? '#f00' : '#00f'
        ctx.fillRect(0, 0, 1920, 1080)
        await encoder.frame()
        await encoder.audio()
      }
      const blob = await encoder.finish()
      const codec = await runVodVideoCodec(blob)
      const invalidCodec = await runVodVideoCodec(new Blob())
      const encodedMs = performance.now() - started
      const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()))
      const clips = await Promise.all(['#f00', '#f00', '#00f', '#00f'].map(async color => {
        const surface = document.createElement('canvas')
        surface.width = 1920; surface.height = 1080
        const context = surface.getContext('2d')
        context.fillStyle = color; context.fillRect(0, 0, surface.width, surface.height)
        const encoder = await createOfflineRunVod(surface, 120, [], store, () => {}, true)
        try {
          for (let i = 0; i < 60; i++) await encoder.frame()
          return { video: await encoder.finish(), duration: encoder.time,
            cues: [{ source, at: 0, volume: .5, rate: 1, loop: true }] }
        } finally { await encoder.abort(); surface.width = surface.height = 0 }
      }))
      const joiner = await createRunVodJoiner(120, store, () => {})
      for (const clip of clips) await joiner.append(clip)
      const joined = await joiner.finish()
      const joinedBytes = Array.from(new Uint8Array(await joined.arrayBuffer()))
      const { Input, BlobSource, MP4, EncodedPacketSink } = await import('/node_modules/mediabunny/dist/modules/src/index.js')
      const input = new Input({ source: new BlobSource(joined), formats: [MP4] })
      try {
        const track = await input.getPrimaryVideoTrack()
        let frames = 0
        for await (const packet of new EncodedPacketSink(track).packets()) {
          if (Math.abs(packet.timestamp - frames / 120) > .0001) throw new Error(`Joined frame ${frames} has a discontinuous timestamp`)
          frames++
        }
        if (frames !== 240) throw new Error(`Joining dropped or duplicated frames: ${frames}`)
      } finally { input.dispose() }
      let cancelled = false
      const aborted = await createOfflineRunVod(canvas, 120, [], store, () => { if (cancelled) throw new Error('test cancellation') })
      await aborted.frame()
      cancelled = true
      const rejectsCancelled = await aborted.frame().then(() => false, error => error.message === 'test cancellation')
      await aborted.abort()
      let stopJoin = false
      const abortedJoiner = await createRunVodJoiner(120, store, () => { if (stopJoin) throw new Error('join cancellation') })
      await abortedJoiner.append(clips[0]); stopJoin = true
      const joinCancelled = await abortedJoiner.append(clips[1]).then(() => false, error => error.message === 'join cancellation')
      await abortedJoiner.abort()
      return { bytes, joinedBytes, extension: encoder.extension, codec, invalidCodec, encodedMs, rejectsCancelled, joinCancelled }
    } finally { await encoder.abort(); URL.revokeObjectURL(source) }
  })
  assert(result.rejectsCancelled, 'cancellation must stop encoding')
  assert(result.joinCancelled, 'cancellation must stop the packet joiner')
  assert.match(result.codec, /^avc[13]\./, 'a valid clip did not expose its AVC decoder configuration')
  assert.equal(result.invalidCodec, null, 'an invalid clip passed codec validation')
  const joinedPath = join(directory, 'joined.mp4')
  writeFileSync(joinedPath, Buffer.from(result.joinedBytes))
  for (const [time, channel] of [[.9, 0], [1.1, 2]]) {
    const pixels = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(time), '-i', joinedPath, '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
    assert.equal(pixels.status, 0, pixels.stderr.toString())
    assert(pixels.stdout[channel] > 220 && pixels.stdout[2 - channel] < 30, 'clip boundary decoded the wrong location')
  }
  const joinedAudio = spawnSync('ffmpeg', ['-v', 'error', '-i', joinedPath, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'])
  assert.equal(joinedAudio.status, 0, joinedAudio.stderr.toString())
  const boundary = new Float32Array(joinedAudio.stdout.buffer, joinedAudio.stdout.byteOffset, joinedAudio.stdout.byteLength / 4).slice(47000, 49000)
  assert(Math.max(...boundary) > .2 && Math.min(...boundary) < -.2, 'loop audio became silent at the clip boundary')
  assert(boundary.every((sample, index) => !index || Math.abs(sample - boundary[index - 1]) < .03), 'audio clicked or restarted at the clip boundary')
  const path = join(directory, `offline.${result.extension}`)
  writeFileSync(path, Buffer.from(result.bytes))
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path], { encoding: 'utf8' })
  assert.equal(probe.status, 0, probe.stderr)
  const metadata = JSON.parse(probe.stdout)
  const video = metadata.streams.find(stream => stream.codec_type === 'video')
  assert.equal(video.width, 1920); assert.equal(video.height, 1080)
  const [numerator, denominator] = video.r_frame_rate.split('/').map(Number)
  assert.equal(numerator / denominator, 120)
  assert(Math.abs(Number(metadata.format.duration) - 12) < .1, 'offline timestamps changed the movie duration')
  const decoded = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], { maxBuffer: 3_000_000 })
  assert.equal(decoded.status, 0, decoded.stderr.toString())
  const samples = new Float32Array(decoded.stdout.buffer, decoded.stdout.byteOffset, decoded.stdout.byteLength / 4)
  const rms = (start, end) => Math.sqrt(samples.slice(start * 48000, end * 48000).reduce((sum, value) => sum + value * value, 0) / ((end - start) * 48000))
  assert(rms(.35, .6) > .1, 'the scheduled cue is silent')
  assert(rms(1, 1.5) < .001, 'the stopped cue leaked into the next segment')
  assert(rms(10.35, 10.6) > .1, 'the scheduled cue is silent after the 10-second mixer boundary')
  console.log(`Offline VOD: 1080p/120fps, exact duration, timed audio, parallel clip packet joins and cancellation passed; 12s encoded in ${Math.round(result.encodedMs)}ms`)
} finally {
  await browser.close(); await server.close()
  rmSync(directory, { recursive: true, force: true })
}
