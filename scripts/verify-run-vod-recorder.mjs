import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

// Exercise the actual helper without launching a game or allocating video data.
const source = readFileSync('src/ui/run-vod.ts', 'utf8')
const helper = source.slice(source.indexOf('async function recorderFor('), source.indexOf('type VodClip ='))
const compiled = ts.transpile(helper, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext })

// The legacy recorder fallback has a bounded memory store. Native export
// bypasses temporary frames entirely (asserted by the export browser check).
const storageHelper = source.slice(source.indexOf('export async function snapshotStore('), source.indexOf('function replayFrame('))
const storageCompiled = ts.transpile(storageHelper.replace('export ', ''), { target: ts.ScriptTarget.ES2022 })
let encoders = 0
const createStore = vm.runInNewContext(`${storageCompiled};snapshotStore`, {
  navigator: { storage: { async getDirectory() { throw new Error('memory-only fixture') } } },
  createRunVodEncoder: () => { encoders++; return { encode: async () => ({ size: 512 * 1024 }), close() {} } },
  createImageBitmap: async value => value,
})
const store = await createStore('800-actions')
assert.equal(encoders, 0, 'streaming video must not start unused PNG workers')
for (let index = 0; index < 512; index++) {
  await store.write(index, {})
  assert.equal((await store.read(index)).size, 512 * 1024)
}
await assert.rejects(store.write(512, {}), /temporary disk storage/)
await store.cleanup()

const resumeStart = source.indexOf('doc.documentElement.dataset.runVodResume = String')
const resumeEnd = source.indexOf("doc.documentElement.dataset.runVodResume = 'false'", resumeStart)
const firstCanvas = source.indexOf("const canvas = document.createElement('canvas')", resumeStart)
assert(resumeStart >= 0 && resumeEnd > resumeStart && resumeEnd < firstCanvas,
  'resumed playback must stop suppressing opening-hand animations immediately after initial hydration')

// Exercise the real location coordinator without browser startup or pixels.
const coordinator = source.slice(source.indexOf('export async function extractRunVod('), source.indexOf('export async function renderRunVodLocation('))
  .replace('export ', '').replace("await import('./run-vod-video.ts')", 'joinModule')
const coordinateJs = ts.transpile(coordinator, { target: ts.ScriptTarget.ES2022 })
for (const mode of ['complete', 'cancel', 'startup-cancel', 'fallback-cancel', 'finish-cancel', 'failure', 'late-failure']) {
  const completesClips = mode === 'complete' || mode === 'finish-cancel'
  const gates = new Map(), started = [], joined = [], cleaned = [], buttons = []
  let active = 0, peak = 0, presented = false, removed = false, aborted = false, storeCleaned = false
  const tick = () => new Promise(resolve => setImmediate(resolve))
  const run = vm.runInNewContext(`${coordinateJs};extractRunVod`, {
    RUN_VOD_FPS: 120,
    runVodLocations: () => Array.from({ length: 9 }, (_, index) => ({ log: { index, events: [{}] }, expected: {} })),
    replayFrame: () => ({ iframe: { remove() {} }, workbench: { append() {}, addEventListener() {} }, update() {}, remove() { removed = true } }),
    document: { createElement: () => { const button = {}; buttons.push(button); return button } },
    snapshotStore: async () => ({ cleanup: async () => {
      const first = !storeCleaned; storeCleaned = true
      if (first && mode === 'fallback-cancel') await new Promise(resolve => gates.set('cleanup', resolve))
    } }),
    joinModule: { createRunVodJoiner: async () => {
      if (mode === 'startup-cancel') await new Promise(resolve => gates.set('join', resolve))
      if (mode === 'fallback-cancel') return null
      return {
        async append(clip) { joined.push(clip.index) },
        async finish() {
          if (mode === 'finish-cancel') await new Promise(resolve => gates.set('finish', resolve))
          return {}
        },
        async abort() { aborted = true },
      }
    } },
    presentRunVod: () => { presented = true },
    renderRunVod: async (log, expected, job) => {
      active++; peak = Math.max(peak, active); started.push(log.index)
      try {
        await new Promise(resolve => gates.set(log.index, resolve))
        if ((mode === 'failure' && log.index === 1) || (mode === 'late-failure' && log.index === 7)) throw new Error('broken location')
        job.checkCancelled(); job.progress(1)
        return { index: log.index, cleanup: async () => { cleaned.push(log.index) } }
      } finally { active-- }
    },
  })
  const result = run({ runId: 'queue', events: Array(9).fill({}) }, { campaign: { runId: 'queue' } })
  const outcome = result.then(() => '', error => error.message)
  await tick()
  if (mode === 'startup-cancel' || mode === 'fallback-cancel') {
    assert.deepEqual(started, [])
    buttons[0].onclick(); gates.get(mode === 'startup-cancel' ? 'join' : 'cleanup')()
    assert((await outcome).includes('cancelled'))
    assert(removed && (aborted || mode === 'fallback-cancel') && storeCleaned && !presented && active === 0)
    continue
  }
  assert.deepEqual(started, [0, 1, 2, 3])
  if (mode === 'cancel') buttons[0].onclick()
  gates.get(1)(); await tick()
  if (completesClips || mode === 'late-failure') {
    assert.deepEqual(started, [0, 1, 2, 3, 4], 'a completed later clip must immediately free its renderer slot')
    for (let index = 2; index < 8; index++) { gates.get(index)(); await tick() }
    assert.deepEqual(started, [0, 1, 2, 3, 4, 5, 6, 7], 'the encoded lookahead queue must stay bounded to eight clips')
  } else {
    assert.deepEqual(started, [0, 1, 2, 3], 'cancellation or failure must not launch more locations')
    gates.get(2)(); gates.get(3)()
  }
  gates.get(0)(); await tick()
  if (completesClips) { assert.deepEqual(started, [0, 1, 2, 3, 4, 5, 6, 7, 8]); gates.get(8)() }
  if (mode === 'finish-cancel') { await tick(); buttons[0].onclick(); gates.get('finish')() }
  const error = await outcome
  assert.equal(peak, 4); assert.equal(active, 0); assert(removed)
  if (mode === 'complete') {
    assert.equal(error, ''); assert(presented); assert.deepEqual(joined, [0, 1, 2, 3, 4, 5, 6, 7, 8]); assert.deepEqual(cleaned, joined)
  } else {
    assert(error.includes(mode.includes('cancel') ? 'cancelled' : 'broken location'), error)
    assert(!presented && aborted && storeCleaned)
    if (mode === 'late-failure') assert.deepEqual(cleaned.sort(), [1, 2, 3, 4, 5, 6], 'failed exports must clean already encoded out-of-order clips')
  }
}
const emit = (target, type, detail = {}) => target.dispatchEvent(Object.assign(new Event(type), detail))

async function fixture({ disk = false, writeError = false, startError = false } = {}) {
  let recorder, aborted = false, closed = false
  const tracks = [{ kind: 'video', stopped: false, stop() { this.stopped = true } },
    { kind: 'audio', stopped: false, stop() { this.stopped = true } }]
  class Stream {
    constructor(tracks) { this.tracks = tracks }
    getTracks() { return this.tracks }
    getVideoTracks() { return this.tracks.filter((track) => track.kind === 'video') }
    getAudioTracks() { return this.tracks.filter((track) => track.kind === 'audio') }
  }
  class Recorder extends EventTarget {
    static isTypeSupported() { return true }
    state = 'inactive'
    constructor() { super(); recorder = this }
    start() { if (startError) throw new Error('startup failed'); this.state = 'recording' }
    stop() {
      this.state = 'inactive'
      queueMicrotask(() => { emit(this, 'dataavailable', { data: new Blob(['video']) }); emit(this, 'stop') })
    }
  }
  const writable = {
    async write() { if (writeError) throw new Error('disk full') },
    async close() { closed = true },
    async abort() { aborted = true },
  }
  const create = vm.runInNewContext(`${compiled};recorderFor`, {
    MediaRecorder: Recorder, MediaStream: Stream, RUN_VOD_FPS: 120, Blob, Error,
    window: { setTimeout, clearTimeout },
  })
  const promise = create({ captureStream: () => new Stream([tracks[0]]) }, new Stream([tracks[1]]), {
    async video() { return disk ? writable : null },
    async videoFile() { return disk ? new Blob(['disk video']) : null },
  })
  return { promise, tracks, get recorder() { return recorder }, get aborted() { return aborted }, get closed() { return closed } }
}

const normal = await fixture({ disk: true })
assert((await (await normal.promise).finish()).size > 0)
assert(normal.closed && normal.tracks.every((track) => track.stopped))

const failed = await fixture({ disk: true })
const failedSession = await failed.promise
failed.recorder.state = 'inactive' // Some native failures deliver no subsequent stop.
emit(failed.recorder, 'error', { error: new Error('native encoder failed') })
await assert.rejects(failedSession.finish(), /native encoder failed/)
await failedSession.abort()
assert(failed.aborted && failed.tracks.every((track) => track.stopped))

const inactive = await fixture()
const inactiveSession = await inactive.promise
inactive.recorder.state = 'inactive'
await assert.rejects(inactiveSession.finish(), /stopped unexpectedly/)
await inactiveSession.abort()

const full = await fixture({ disk: true, writeError: true })
const fullSession = await full.promise
emit(full.recorder, 'dataavailable', { data: new Blob(['frame']) })
await assert.rejects(fullSession.finish(), /disk full/)
assert(full.aborted && full.tracks.every((track) => track.stopped))

const memory = await fixture()
const memorySession = await memory.promise
emit(memory.recorder, 'dataavailable', { data: { size: 257 * 1024 * 1024 } })
await assert.rejects(memorySession.finish(), /memory limit/)
assert(memory.tracks.every((track) => track.stopped))

const startup = await fixture({ disk: true, startError: true })
await assert.rejects(startup.promise, /startup failed/)
assert(startup.aborted && startup.tracks.every((track) => track.stopped))
console.log('VOD recorder: normal finish, native error, inactive stop, disk failure, memory bound, startup cleanup passed')
