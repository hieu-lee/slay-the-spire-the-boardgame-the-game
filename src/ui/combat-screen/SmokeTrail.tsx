import { useLayoutEffect, useRef, useState, useId } from 'react'
import { cardFlightPath, type TrailBounds as Bounds } from './card-flight.ts'

// Reuse the rendered texture across repeated plays; only the cheap reveal mask animates.
const textures = new Map<string, Promise<string>>()
function smokeTexture(path: string, color: string, bounds: Bounds) {
  const { x, y, width, height } = bounds
  const key = `${path}/${color}/${x}/${y}/${width}/${height}`
  const rasterWidth = Math.ceil(width / 2), rasterHeight = Math.ceil(height / 2)
  const cached = textures.get(key)
  if (cached) return cached
  const ready = new Promise<string>((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = rasterWidth; canvas.height = rasterHeight
        const context = canvas.getContext('2d')
        if (!context) throw new Error('Smoke canvas unavailable')
        context.drawImage(image, 0, 0)
        canvas.toBlob((blob) => {
          if (!blob) { reject(new Error('Smoke encoding failed')); return }
          const reader = new FileReader()
          reader.onload = () => resolve(reader.result as string)
          reader.onerror = () => reject(reader.error)
          reader.readAsDataURL(blob)
        })
      } catch (error) { reject(error) }
    }
    image.onerror = () => reject(new Error('Smoke texture unavailable'))
    image.src = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${rasterWidth}" height="${rasterHeight}" viewBox="${x} ${y} ${width} ${height}">
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
      </g></svg>`)}`
  })
  textures.set(key, ready)
  if (textures.size > 12) textures.delete(textures.keys().next().value!)
  void ready.catch(() => { if (textures.get(key) === ready) textures.delete(key) })
  return ready
}

export function SmokeTrail({ path, bounds }: { path: string; bounds: Bounds }) {
  const maskId = useId()
  const root = useRef<SVGSVGElement>(null)
  const [texture, setTexture] = useState<(Bounds & { src: string })>()
  const [size] = useState(() => ({ width: innerWidth, height: innerHeight }))
  useLayoutEffect(() => {
    let active = true
    const color = getComputedStyle(root.current!).getPropertyValue('--flight-trace').trim()
    void smokeTexture(path, color, bounds).then(
      (src) => { if (active) setTexture({ src, ...bounds }) }, () => {},
    )
    return () => { active = false }
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
  const prepare = async () => {
    for (const destination of ['discard', 'draw', 'exhaust'] as const) {
      if (cancelled) return
      const { trailPath, trailBounds } = cardFlightPath(destination)
      await smokeTexture(trailPath, color, trailBounds).catch(() => {})
    }
  }
  const timer = window.setTimeout(() => { void prepare() }, 0)
  return () => { cancelled = true; window.clearTimeout(timer) }
}
