import { useEffect, useRef, useState, type CSSProperties } from 'react'

export type CombatArtElement = HTMLImageElement | HTMLVideoElement

const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent
const query = typeof location === 'undefined' ? new URLSearchParams() : new URLSearchParams(location.search)
const forceWebp = query.get('combat-webp') === '1'
const assetCdnOrigin = import.meta.env?.VITE_ASSET_CDN_ORIGIN
const iOSWebKit = /iP(?:hone|ad|od)/.test(userAgent) ||
  (/Macintosh/.test(userAgent) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1)
export const useSafariCombatVideo = !forceWebp && typeof document !== 'undefined' &&
  /AppleWebKit/.test(userAgent) && /Safari/.test(userAgent) &&
  !/(?:Chrome|Chromium|CriOS|Edg|OPR|Android)/.test(userAgent) &&
  !iOSWebKit &&
  document.createElement('video').canPlayType('video/quicktime; codecs="hvc1"') !== ''

export function combatVideoPath(src: string, origin = assetCdnOrigin): string {
  const video = src.includes('/combat/rigged/') ? src.replace(/\.webp(?=\?|$)/, '.mov') : src
  if (video === src) return src
  const asset = video.indexOf('assets/')
  return origin && asset >= 0 ? `${origin.replace(/\/$/, '')}/${video.slice(asset + 7)}` : video
}

type VideoPreload = {
  cancelled: boolean
  priority: boolean
  src: string
  ready: Set<() => void>
  stop?: () => void
}

const videoPreloadQueue: VideoPreload[] = []
const videoPreloads = new Map<string, VideoPreload>()
const readyVideoPreloads = new Set<string>()
let activeVideoPreloads = 0

function runVideoPreloads() {
  while (activeVideoPreloads < 2 && videoPreloadQueue.length) {
    const task = videoPreloadQueue.shift()!
    if (task.cancelled) continue
    activeVideoPreloads += 1
    const video = document.createElement('video')
    let settled = false
    let timeout = 0
    const settle = (ready: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      video.removeEventListener('loadeddata', loaded)
      video.removeEventListener('canplaythrough', loaded)
      video.removeEventListener('error', failed)
      task.stop = undefined
      activeVideoPreloads -= 1
      if (videoPreloads.get(task.src) === task) videoPreloads.delete(task.src)
      const listeners = ready && !task.cancelled ? [...task.ready] : []
      task.ready.clear()
      if (ready) readyVideoPreloads.add(task.src)
      listeners.forEach(listener => listener())
      runVideoPreloads()
    }
    const loaded = (event: Event) => {
      if (task.priority || event.type === 'canplaythrough') settle(true)
    }
    const failed = () => settle(false)
    const abort = () => {
      task.cancelled = true
      video.removeAttribute('src')
      video.load()
      settle(false)
    }
    task.stop = abort
    video.preload = 'auto'
    video.muted = true
    video.playsInline = true
    if (task.src.startsWith('http')) video.crossOrigin = 'anonymous'
    video.addEventListener('loadeddata', loaded)
    video.addEventListener('canplaythrough', loaded)
    video.addEventListener('error', failed)
    video.src = task.src
    video.load()
    timeout = window.setTimeout(abort, 30_000)
  }
}

/** Browser-managed, bounded warmup avoids retaining multi-megabyte MOV buffers in JS. */
export function preloadCombatVideo(src: string, ready: () => void, priority = false): () => void {
  if (readyVideoPreloads.has(src)) {
    ready()
    return () => undefined
  }
  let task = videoPreloads.get(src)
  if (!task) {
    task = { cancelled: false, priority, src, ready: new Set([ready]) }
    videoPreloads.set(src, task)
    const firstPrefetch = priority ? videoPreloadQueue.findIndex(queued => !queued.priority) : -1
    if (firstPrefetch < 0) videoPreloadQueue.push(task)
    else videoPreloadQueue.splice(firstPrefetch, 0, task)
    runVideoPreloads()
  } else {
    task.ready.add(ready)
    if (priority && !task.priority) {
      task.priority = true
      const queued = videoPreloadQueue.indexOf(task)
      if (queued >= 0) {
        videoPreloadQueue.splice(queued, 1)
        const firstPrefetch = videoPreloadQueue.findIndex(entry => !entry.priority)
        if (firstPrefetch < 0) videoPreloadQueue.push(task)
        else videoPreloadQueue.splice(firstPrefetch, 0, task)
      }
    }
  }
  return () => {
    task!.ready.delete(ready)
    if (task!.ready.size) return
    task!.cancelled = true
    if (videoPreloads.get(src) === task) videoPreloads.delete(src)
    task!.stop?.()
  }
}

export function combatArtSize(art: CombatArtElement): { width: number; height: number } {
  return art instanceof HTMLVideoElement
    ? { width: art.videoWidth, height: art.videoHeight }
    : { width: art.naturalWidth, height: art.naturalHeight }
}

export function combatArtReady(art: CombatArtElement): boolean {
  const { width, height } = combatArtSize(art)
  return width > 0 && height > 0 &&
    (art instanceof HTMLVideoElement ? art.readyState >= HTMLMediaElement.HAVE_METADATA : art.complete)
}

function afterVideoFrame(video: HTMLVideoElement, listener: () => void): () => void {
  if (video.requestVideoFrameCallback) {
    let animation = 0
    const frame = video.requestVideoFrameCallback(() => { animation = requestAnimationFrame(listener) })
    return () => { video.cancelVideoFrameCallback(frame); cancelAnimationFrame(animation) }
  }
  let inner = 0
  const outer = requestAnimationFrame(() => { inner = requestAnimationFrame(listener) })
  return () => { cancelAnimationFrame(outer); cancelAnimationFrame(inner) }
}

export function onCombatArtReady(art: CombatArtElement, listener: () => void): () => void {
  if (!(art instanceof HTMLVideoElement)) {
    art.addEventListener('load', listener)
    return () => art.removeEventListener('load', listener)
  }
  let cancelFrame: () => void = () => undefined
  let retries: number[] = []
  let scheduled = false
  const ready = () => {
    if (scheduled) return
    scheduled = true
    cancelFrame = afterVideoFrame(art, listener)
    // WebKit can expose metadata before an HEVC-alpha frame is readable by canvas.
    retries = [100, 200, 300].map(delay => window.setTimeout(listener, delay))
  }
  art.addEventListener('loadedmetadata', ready)
  art.addEventListener('loadeddata', ready)
  if (art.readyState >= HTMLMediaElement.HAVE_METADATA) ready()
  return () => {
    art.removeEventListener('loadedmetadata', ready)
    art.removeEventListener('loadeddata', ready)
    cancelFrame()
    retries.forEach(clearTimeout)
  }
}

type DataAttributes = { [key: `data-${string}`]: string | number | boolean | undefined }

type CombatAnimationProps = DataAttributes & {
  src: string
  mediaSrc?: string
  posterSrc?: string
  alt?: string
  className?: string
  style?: CSSProperties
  loading?: 'eager' | 'lazy'
  loop?: boolean
  hidden?: boolean
  forceWebp?: boolean
  onReady?: (art: CombatArtElement) => void
  onError?: (image: HTMLImageElement) => void
}

/** macOS Safari hardware-decodes HEVC-alpha; iOS keeps the pixel-identical WebP to avoid decoder corruption. */
export function CombatAnimation({
  src, mediaSrc, posterSrc, alt = '', className, style, loading, loop = true, hidden, forceWebp,
  onReady, onError, ...data
}: CombatAnimationProps) {
  const [failedVideo, setFailedVideo] = useState('')
  const [loadedVideo, setLoadedVideo] = useState('')
  const [warmedVideo, setWarmedVideo] = useState('')
  const [loadedImage, setLoadedImage] = useState('')
  const stallTimer = useRef(0)
  const videoSrc = combatVideoPath(src)
  const videoRequest = mediaSrc ?? videoSrc
  const wantsVideo = !forceWebp && useSafariCombatVideo && videoSrc !== src
  const videoFailed = failedVideo === videoRequest
  const videoLoaded = loadedVideo === videoRequest
  const videoWarmed = !loop || readyVideoPreloads.has(videoRequest) || warmedVideo === videoRequest
  const imageSrc = videoFailed ? src : mediaSrc ?? src
  const clearStallTimer = () => {
    window.clearTimeout(stallTimer.current)
    stallTimer.current = 0
  }
  const watchForStall = () => {
    clearStallTimer()
    stallTimer.current = window.setTimeout(() => setFailedVideo(videoRequest), 1_500)
  }
  useEffect(() => clearStallTimer, [videoRequest])
  useEffect(() => {
    if (!wantsVideo || !loop) return
    return preloadCombatVideo(videoRequest, () => setWarmedVideo(videoRequest), true)
  }, [loop, videoRequest, wantsVideo])
  useEffect(() => {
    if (!wantsVideo || !videoWarmed || videoFailed || videoLoaded) return
    const timeout = window.setTimeout(() => setFailedVideo(videoRequest), 5_000)
    return () => window.clearTimeout(timeout)
  }, [videoFailed, videoLoaded, videoRequest, videoWarmed, wantsVideo])
  if (wantsVideo && videoWarmed && !videoFailed) {
    return <video
      {...data}
      className={className}
      style={{ ...style, visibility: hidden ? 'hidden' : style?.visibility }}
      crossOrigin={videoSrc.startsWith('http') ? 'anonymous' : undefined}
      src={mediaSrc ?? videoSrc}
      poster={posterSrc ?? src}
      autoPlay
      muted
      loop={loop}
      playsInline
      preload="auto"
      disablePictureInPicture
      aria-hidden={alt === '' || undefined}
      onLoadedData={(event) => {
        const video = event.currentTarget
        setLoadedVideo(videoRequest)
        void video.play().then(() => {
          afterVideoFrame(video, () => onReady?.(video))
        }, () => setFailedVideo(videoRequest))
      }}
      onPlaying={clearStallTimer}
      onTimeUpdate={clearStallTimer}
      onWaiting={watchForStall}
      onStalled={watchForStall}
      onError={() => setFailedVideo(videoRequest)}
    />
  }
  const waitingPoster = posterSrc && loadedImage !== imageSrc ? {
    backgroundImage: `url(${posterSrc})`,
    backgroundPosition: 'center bottom',
    backgroundRepeat: 'no-repeat',
    backgroundSize: 'contain',
  } : undefined
  return <img
    {...data}
    className={className}
    style={{ ...style, ...waitingPoster, visibility: hidden ? 'hidden' : style?.visibility }}
    src={imageSrc}
    alt={alt}
    loading={loading}
    onLoad={(event) => { setLoadedImage(imageSrc); onReady?.(event.currentTarget) }}
    onError={(event) => onError?.(event.currentTarget)}
  />
}
