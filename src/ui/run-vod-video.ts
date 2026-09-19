import { AudioBufferSource, CanvasSource, Output, StreamTarget, Mp4OutputFormat, WebMOutputFormat,
  canEncodeAudio, canEncodeVideo, Input, BlobSource, MP4, EncodedPacketSink, EncodedVideoPacketSource } from 'mediabunny'
import type { RunVodAudioCue } from './sfx.ts'

const AUDIO_CHUNK_SECONDS = 10

export function runVodMemoryFile() {
  const size = 1024 * 1024
  const blocks = new Map<number, Uint8Array<ArrayBuffer>>()
  let length = 0
  return {
    write({ position, data }: { position: number; data: Uint8Array<ArrayBuffer> }) {
      const end = position + data.length
      if (end > 256 * size) throw new Error('This VOD exceeds the browser memory limit. Enable browser storage and try again; your run is preserved.')
      length = Math.max(length, end)
      for (let offset = 0; offset < data.length;) {
        const index = Math.floor((position + offset) / size)
        const within = (position + offset) % size
        const count = Math.min(size - within, data.length - offset)
        let block = blocks.get(index)
        if (!block) { block = new Uint8Array(size); blocks.set(index, block) }
        block.set(data.subarray(offset, offset + count), within)
        offset += count
      }
    },
    blob(type: string) {
      return new Blob(Array.from({ length: Math.ceil(length / size) }, (_, index) =>
        (blocks.get(index) ?? new Uint8Array(size)).subarray(0, Math.min(size, length - index * size))), { type })
    },
  }
}

// WebCodecs timestamps describe movie time, never wall time. Native encoders
// run off the UI thread; the muxer streams to disk with bounded backpressure.
export async function createOfflineRunVod(canvas: HTMLCanvasElement, fps: number, cues: RunVodAudioCue[],
  store: { video: (extension: string) => Promise<FileSystemWritableFileStream | null>; videoFile: (extension: string) => Promise<File | null> },
  checkCancelled: () => void, videoOnly = false) {
  const options = { width: canvas.width, height: canvas.height, bitrate: 16_000_000 }
  const mp4 = await canEncodeVideo('avc', options) && await canEncodeAudio('aac', { sampleRate: 48_000, numberOfChannels: 2 })
  if (!mp4 && !(await canEncodeVideo('vp8', options) && await canEncodeAudio('opus', { sampleRate: 48_000, numberOfChannels: 2 }))) return null
  const extension = mp4 ? 'mp4' : 'webm'
  const writable = await store.video(extension)
  const memory = runVodMemoryFile()
  const target = new StreamTarget(new WritableStream({
    async write(chunk) {
      checkCancelled()
      if (writable) await writable.write(chunk)
      else memory.write(chunk)
    },
  }), { chunked: true, chunkSize: 1024 * 1024 })
  const output = new Output({ format: mp4 ? new Mp4OutputFormat({ fastStart: false }) : new WebMOutputFormat(), target })
  const video = new CanvasSource(canvas, { codec: mp4 ? 'avc' : 'vp8', bitrate: 16_000_000, latencyMode: 'realtime' })
  const audio = new AudioBufferSource({ codec: mp4 ? 'aac' : 'opus', bitrate: 256_000 })
  output.addVideoTrack(video, { frameRate: fps })
  if (!videoOnly) output.addAudioTrack(audio)
  let frames = 0
  const mix = runVodAudioMixer(audio, cues, checkCancelled)
  let mixedUntil = 0
  try { await output.start() }
  catch (error) { await output.cancel(); await writable?.abort(); throw error }
  return {
    extension,
    get time() { return frames / fps },
    async frame() {
      checkCancelled()
      await video.add(frames / fps, 1 / fps)
      frames++
    },
    async audio() {
      if (!videoOnly && frames / fps - mixedUntil >= AUDIO_CHUNK_SECONDS) {
        mixedUntil = frames / fps
        await mix(mixedUntil)
      }
    },
    async finish() {
      if (!videoOnly) await mix(frames / fps)
      await output.finalize()
      await writable?.close()
      const file = await store.videoFile(extension)
      if (file) return file
      return memory.blob(mp4 ? 'video/mp4' : 'video/webm')
    },
    async abort() {
      try { await output.cancel() } finally { try { await writable?.abort() } catch {} }
    },
  }
}

function runVodAudioMixer(audio: AudioBufferSource, cues: RunVodAudioCue[], checkCancelled: () => void) {
  let audioSamples = 0
  const decoded = new Map<string, AudioBuffer>()
  const mix = async (endSample: number) => {
    if (endSample <= audioSamples) return
    checkCancelled()
    const begin = audioSamples / 48_000
    const end = endSample / 48_000
    const context = new OfflineAudioContext(2, endSample - audioSamples, 48_000)
    const playing = cues.filter((cue) => cue.at < end && (cue.end ?? Infinity) > begin)
    for (const cue of playing) {
      let buffer = decoded.get(cue.source)
      if (!buffer) {
        const response = await fetch(cue.source)
        if (!response.ok) throw new Error(`Run VOD audio could not load (${response.status}).`)
        buffer = await context.decodeAudioData(await response.arrayBuffer())
        decoded.set(cue.source, buffer)
      }
      const start = Math.max(begin, cue.at)
      const offset = (start - cue.at) * cue.rate
      if (!cue.loop && offset >= buffer.duration) continue
      const source = context.createBufferSource()
      const gain = context.createGain()
      source.buffer = buffer
      source.loop = cue.loop
      source.playbackRate.value = cue.rate
      gain.gain.value = cue.volume
      source.connect(gain).connect(context.destination)
      source.start(start - begin, cue.loop ? offset % buffer.duration : offset)
      source.stop(Math.max(0, Math.min(end, cue.end ?? end) - begin))
    }
    await audio.add(await context.startRendering())
    audioSamples = endSample
    // Retain only currently sounding assets, not every act's decoded music.
    const active = new Set(playing.filter((cue) => (cue.end ?? Infinity) > end &&
      (cue.loop || cue.at + decoded.get(cue.source)!.duration / cue.rate > end)).map((cue) => cue.source))
    for (const key of decoded.keys()) if (!active.has(key)) decoded.delete(key)
    for (let index = cues.length - 1; index >= 0; index--) {
      const cue = cues[index]!
      if ((cue.end ?? Infinity) <= end || (!cue.loop && !active.has(cue.source) && cue.at < end)) cues.splice(index, 1)
    }
  }
  return async (seconds: number) => {
    const end = Math.round(seconds * 48_000)
    while (audioSamples < end) await mix(Math.min(end, audioSamples + AUDIO_CHUNK_SECONDS * 48_000))
  }
}

// Location clips keep their encoded video packets. Only one audio mix/encode
// runs on the combined timeline, avoiding codec padding and music restarts.
export async function createRunVodJoiner(fps: number,
  store: { video: (extension: string) => Promise<FileSystemWritableFileStream | null>; videoFile: (extension: string) => Promise<File | null> },
  checkCancelled: () => void) {
  if (!(await canEncodeVideo('avc', { width: 1920, height: 1080, bitrate: 16_000_000 })) ||
      !(await canEncodeAudio('aac', { sampleRate: 48_000, numberOfChannels: 2 }))) return null
  const writable = await store.video('mp4')
  const memory = runVodMemoryFile()
  const target = new StreamTarget(new WritableStream({ async write(chunk) {
    checkCancelled()
    if (writable) await writable.write(chunk)
    else memory.write(chunk)
  } }), { chunked: true, chunkSize: 1024 * 1024 })
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target })
  const video = new EncodedVideoPacketSource('avc')
  const audio = new AudioBufferSource({ codec: 'aac', bitrate: 256_000 })
  output.addVideoTrack(video, { frameRate: fps }); output.addAudioTrack(audio)
  const cues: RunVodAudioCue[] = []
  let duration = 0
  let tailLoops: RunVodAudioCue[] = []
  try { await output.start() }
  catch (error) { await output.cancel(); await writable?.abort(); throw error }
  return {
    async append(clip: { video: Blob; duration: number; cues: RunVodAudioCue[] }) {
      checkCancelled()
      const end = duration + clip.duration
      const continuing: RunVodAudioCue[] = []
      for (const cue of clip.cues) {
        const mapped = { ...cue, at: duration + cue.at,
          end: cue.end === undefined ? (cue.loop ? end : undefined) : duration + cue.end }
        const previous = cue.loop && cue.at < 1 / fps ? tailLoops.find(old =>
          old.source === cue.source && old.rate === cue.rate && old.volume === cue.volume) : undefined
        if (previous) previous.end = mapped.end
        else cues.push(mapped)
        if (cue.loop && cue.end === undefined) continuing.push(previous ?? mapped)
      }
      tailLoops = continuing
      const input = new Input({ source: new BlobSource(clip.video), formats: [MP4] })
      try {
        const track = await input.getPrimaryVideoTrack()
        if (!track || await track.getCodec() !== 'avc') throw new Error('A VOD location produced an incompatible video track.')
        const config = await track.getDecoderConfig()
        if (!config) throw new Error('A VOD location is missing its video decoder configuration.')
        let first = true
        for await (const packet of new EncodedPacketSink(track).packets()) {
          checkCancelled()
          if (first && (packet.type !== 'key' || Math.abs(packet.timestamp) > 1 / fps)) {
            throw new Error('A VOD location must start with an independently decodable frame at time zero.')
          }
          await video.add(packet.clone({ timestamp: duration + packet.timestamp }), first ? { decoderConfig: config } : undefined)
          first = false
        }
        if (first) throw new Error('A VOD location produced no video frames.')
      } finally { input.dispose() }
      duration = end
    },
    async finish() {
      await runVodAudioMixer(audio, cues, checkCancelled)(duration)
      await output.finalize()
      await writable?.close()
      return await store.videoFile('mp4') ?? memory.blob('video/mp4')
    },
    async abort() {
      try { await output.cancel() } finally { try { await writable?.abort() } catch {} }
    },
  }
}
