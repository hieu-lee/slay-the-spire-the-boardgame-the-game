import { useLayoutEffect, useRef, useState, useId } from 'react'
import { cardFlightPath, type TrailBounds as Bounds } from './card-flight.ts'

// Reuse the rendered texture across repeated plays; only the cheap reveal mask animates.
type SmokeTexture = { ready: Promise<string>; users: number; expired: boolean; revoked: boolean }
const textures = new Map<string, SmokeTexture>()
function disposeTexture(texture: SmokeTexture) {
  if (!texture.expired || texture.users || texture.revoked) return
  texture.revoked = true
  void texture.ready.then(URL.revokeObjectURL, () => {})
}
function smokeTexture(path: string, color: string, bounds: Bounds) {
  const { x, y, width, height } = bounds
  const key = `${path}/${color}/${x}/${y}/${width}/${height}`
  const rasterWidth = Math.ceil(width / 2), rasterHeight = Math.ceil(height / 2)
  const cached = textures.get(key)
  if (cached) return cached
  const source = new Blob([`<svg xmlns="http://www.w3.org/2000/svg" width="${rasterWidth}" height="${rasterHeight}" viewBox="${x} ${y} ${width} ${height}">
      <defs><filter id="smoke" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB">
        <feTurbulence type="fractalNoise" baseFrequency="0.025 0.045" numOctaves="3" seed="4" result="noise"/>
        <feDisplacementMap in="SourceGraphic" in2="noise" scale="32" xChannelSelector="R" yChannelSelector="G" result="distorted"/>
        <feGaussianBlur in="distorted" stdDeviation="3" result="soft"/>
        <feColorMatrix in="noise" type="matrix" values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 1.6 0 0 0 -0.35" result="smokeMask"/>
        <feComposite in="soft" in2="smokeMask" operator="in"/>
      </filter></defs>
      <g filter="url(#smoke)" fill="none" stroke="${color}" stroke-linecap="round">
        <path d="${path}" stroke-width="38" stroke-opacity=".32"/>
        <path d="${path}" stroke-width="17" stroke-opacity=".8"/>
      </g></svg>`], { type: 'image/svg+xml' })
  const ready = (async () => {
    const canvas = document.createElement('canvas')
    canvas.width = rasterWidth; canvas.height = rasterHeight
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Smoke canvas unavailable')
    const sourceUrl = URL.createObjectURL(source)
    try {
      const image = new Image()
      image.src = sourceUrl
      await image.decode()
      context.drawImage(image, 0, 0)
    } finally { URL.revokeObjectURL(sourceUrl) }
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
      (result) => result ? resolve(result) : reject(new Error('Smoke encoding failed')),
    ))
    const src = URL.createObjectURL(blob)
    try {
      const decoded = new Image()
      decoded.src = src
      await decoded.decode()
      return src
    } catch (error) {
      URL.revokeObjectURL(src)
      throw error
    }
  })()
  const texture = { ready, users: 0, expired: false, revoked: false }
  textures.set(key, texture)
  if (textures.size > 12) {
    const expired = textures.keys().next().value!
    const texture = textures.get(expired)
    textures.delete(expired)
    if (texture) { texture.expired = true; disposeTexture(texture) }
  }
  void ready.catch(() => { if (textures.get(key) === texture) textures.delete(key) })
  return texture
}

function acquireSmokeTexture(path: string, color: string, bounds: Bounds) {
  const texture = smokeTexture(path, color, bounds)
  texture.users++
  return texture.ready.then((src) => {
    let released = false
    return { src, release: () => {
      if (released) return
      released = true
      texture.users--
      disposeTexture(texture)
    } }
  }, (error) => {
    texture.users--
    disposeTexture(texture)
    throw error
  })
}

export function SmokeTrail({ path, bounds }: { path: string; bounds: Bounds }) {
  const maskId = useId()
  const root = useRef<SVGSVGElement>(null)
  const [texture, setTexture] = useState<(Bounds & { src: string })>()
  const [size] = useState(() => ({ width: innerWidth, height: innerHeight }))
  useLayoutEffect(() => {
    let active = true
    let release: (() => void) | undefined
    const color = getComputedStyle(root.current!).getPropertyValue('--flight-trace').trim()
    void acquireSmokeTexture(path, color, bounds).then(
      (acquired) => {
        if (!active) { acquired.release(); return }
        release = acquired.release
        setTexture({ src: acquired.src, ...bounds })
      }, () => {},
    )
    return () => { active = false; release?.() }
  }, [path, bounds])
  return <svg ref={root} className="card-flight-trail" width="100%" height="100%" data-texture-ready={Boolean(texture)}>
    <defs><mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width={size.width} height={size.height}>
      <path className="card-flight-trail__reveal" d={path} pathLength="1" />
    </mask></defs>
    <g className="card-flight-trail__drift">
      {texture ? <image href={texture.src} x={texture.x} y={texture.y} width={texture.width} height={texture.height} mask={`url(#${maskId})`} /> : null}
    </g>
  </svg>
}

/** Prepare the three public pile routes before the player plays their first card. */
export function warmSmokeTrails(character: string) {
  let cancelled = false
  const probe = document.createElement('div')
  probe.hidden = true
  probe.className = `card-flight--${character}`
  document.body.append(probe)
  const color = getComputedStyle(probe).getPropertyValue('--flight-trace').trim()
  probe.remove()
  const destinations = ['discard', 'draw', 'exhaust'] as const
  const idleWindow = window as unknown as {
    requestIdleCallback?: (callback: () => void, options: { timeout: number }) => number
    cancelIdleCallback?: (handle: number) => void
  }
  let timer = 0
  let idle = 0
  const schedule = (callback: () => void) => {
    if (idleWindow.requestIdleCallback) idle = idleWindow.requestIdleCallback(callback, { timeout: 250 })
    else timer = window.setTimeout(callback, 0)
  }
  const prepare = () => Promise.all(destinations.map((destination) => {
    const { trailPath, trailBounds } = cardFlightPath(destination)
    return smokeTexture(trailPath, color, trailBounds).ready.catch(() => {})
  }))
  schedule(() => { if (!cancelled) void prepare() })
  return () => {
    cancelled = true
    window.clearTimeout(timer)
    idleWindow.cancelIdleCallback?.(idle)
  }
}
