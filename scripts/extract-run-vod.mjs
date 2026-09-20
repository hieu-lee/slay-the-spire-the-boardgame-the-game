import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { createServer } from 'vite'
import { chromium } from './lib/profile-browser.mjs'

const run = promisify(execFile)
const source = process.argv[2] && resolve(process.argv[2])
if (!source) throw new Error('Usage: node scripts/extract-run-vod.mjs <vod-debug.json> [output.mp4]')
const payload = JSON.parse(await fs.readFile(source, 'utf8'))
const log = payload.log
const expected = payload.solo?.terminalRun
if (!log?.events || !expected?.campaign?.runId) throw new Error('The debug log does not contain a finished solo run.')
const output = resolve(process.argv[3] ?? join(dirname(source), `slay-the-spire-run-${expected.campaign.runId}.mp4`))
await fs.mkdir(dirname(output), { recursive: true })
const directory = await fs.mkdtemp(join(tmpdir(), 'sts-vod-'))
const server = await createServer({ logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } })
await server.listen()
const base = `http://127.0.0.1:${server.httpServer.address().port}/`

async function page() {
  const browser = await chromium.launch({ headless: true })
  try {
    const value = await browser.newPage({ viewport: { width: 1920, height: 1080 }, hasTouch: true, acceptDownloads: true })
    await value.goto(base, { waitUntil: 'networkidle' })
    return { browser, page: value }
  } catch (error) { await browser.close(); throw error }
}

try {
  const probe = await page()
  let lengths
  try {
    lengths = await probe.page.evaluate(async ({ log, expected }) =>
      (await import('/src/ui/run-vod.ts')).runVodLocations(log, expected).map(location => location.log.events.length),
    { log, expected })
  } finally { await probe.browser.close() }
  const chunks = lengths.flatMap((length, location) => Array.from({ length }, (_, index) => ({
    location, from: index, to: index + 1,
  })))
  const metadata = []
  let playback
  for (const [eventIndex, chunk] of chunks.entries()) {
    let motionSkip = 0
    do {
      const key = String(metadata.length).padStart(4, '0')
      const worker = await page()
      try {
      const download = worker.page.waitForEvent('download', { timeout: 1_800_000 })
      const result = await worker.page.evaluate(async ({ log, expected, chunk, first, last, continuation, playback, key, motionSkip }) => {
        const vod = await import('/src/ui/run-vod.ts')
        const location = vod.runVodLocations(log, expected)[chunk.location]
        let initial = structuredClone(location.log.initial)
        for (const event of location.log.events.slice(0, chunk.from)) initial = vod.applyRunVodEvent(initial, event)
        const events = location.log.events.slice(chunk.from, chunk.to)
        const motionFrames = vod.runVodExportMotionFrames(events[0])
        let slicedExpected = structuredClone(initial)
        for (const event of events) slicedExpected = vod.applyRunVodEvent(slicedExpected, event)
        const clip = await vod.renderRunVodLocation({ ...location.log, initial, events }, slicedExpected, first, last,
          { resume: !first || motionSkip > 0, continuation, playback,
          motionSkip, motionLimit: motionFrames })
        const url = URL.createObjectURL(clip.video)
        Object.assign(document.createElement('a'), { href: url, download: `${key}.mp4` }).click()
        window.__runVodCleanup = async () => { URL.revokeObjectURL(url); await clip.cleanup() }
        return { key, duration: clip.duration, cues: clip.cues, playback: clip.playback,
          motionCapped: clip.motionCapped, motionFrames }
      }, { log, expected, chunk, first: metadata.length === 0, last: eventIndex === chunks.length - 1,
        continuation: chunk.to < lengths[chunk.location], playback: metadata.length > 0 || motionSkip > 0 ? playback : undefined,
        key, motionSkip })
      await (await download).saveAs(join(directory, `${key}.mp4`))
      await worker.page.evaluate(() => window.__runVodCleanup())
      metadata.push(result)
      playback = result.playback
      motionSkip = result.motionCapped ? motionSkip + result.motionFrames : 0
      console.log(`Rendered event ${eventIndex + 1}/${chunks.length}${result.motionCapped ? ' · continuing motion' : ''}`)
      } finally { await worker.browser.close() }
    } while (motionSkip > 0)
  }

  const cues = []
  let duration = 0
  let tailLoops = []
  for (const clip of metadata) {
    const end = duration + clip.duration
    const continuing = []
    for (const cue of clip.cues) {
      const mapped = { ...cue, at: duration + cue.at,
        end: cue.end === undefined ? (cue.loop ? end : undefined) : duration + cue.end }
      const previous = cue.loop && cue.at < 1 / 120 ? tailLoops.find(old =>
        old.source === cue.source && old.rate === cue.rate && old.volume === cue.volume) : undefined
      if (previous) previous.end = mapped.end
      else cues.push(mapped)
      if (cue.loop && cue.end === undefined) continuing.push(previous ?? mapped)
    }
    tailLoops = continuing
    duration = end
  }

  const clock = join(directory, 'audio-clock.mp4')
  await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=16x16:r=1',
    '-t', String(duration), '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '1', '-pix_fmt', 'yuv420p', clock])
  const audio = join(directory, 'audio.mp4')
  const mixer = await page()
  await mixer.page.route('**/__vod-audio-clock', async route => route.fulfill({ contentType: 'video/mp4', body: await fs.readFile(clock) }))
  try {
    const download = mixer.page.waitForEvent('download', { timeout: 600_000 })
    await mixer.page.evaluate(async ({ cues, duration }) => {
      const { createRunVodJoiner } = await import('/src/ui/run-vod-video.ts')
      const { snapshotStore } = await import('/src/ui/run-vod.ts')
      const store = await snapshotStore('isolated-audio')
      const joiner = await createRunVodJoiner(120, store, () => {})
      if (!joiner) throw new Error('AAC encoding is unavailable.')
      await joiner.append({ video: await fetch('/__vod-audio-clock').then(response => response.blob()), duration, cues })
      const mixed = await joiner.finish()
      const url = URL.createObjectURL(mixed)
      Object.assign(document.createElement('a'), { href: url, download: 'audio.mp4' }).click()
      window.__runVodCleanup = async () => { URL.revokeObjectURL(url); await store.cleanup() }
    }, { cues, duration })
    await (await download).saveAs(audio)
    await mixer.page.evaluate(() => window.__runVodCleanup())
  } finally { await mixer.browser.close() }

  const list = join(directory, 'clips.txt')
  await fs.writeFile(list, metadata.map(clip => `file '${join(directory, `${clip.key}.mp4`)}'`).join('\n'))
  await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list,
    '-i', audio, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-shortest', output])
  console.log(`Saved ${basename(output)}`)
} finally {
  await server.close()
  await fs.rm(directory, { recursive: true, force: true })
}
