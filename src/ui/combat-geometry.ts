import { combatArtReady, combatArtSize, type CombatArtElement } from './CombatAnimation.tsx'

// Cache painted mass and bounds per mounted sprite; transparent overscan is not its body.
const paintedArt = new WeakMap<CombatArtElement, {
  src: string; x: number; y: number; left: number; top: number; right: number; bottom: number
}>()

export function combatArtBounds(portrait: HTMLElement) {
  const image = portrait.querySelector<CombatArtElement>(':scope > :is(img, video)')
  const rect = portrait.getBoundingClientRect()
  const fallback = { x: rect.left + rect.width / 2, y: rect.top + rect.height * .7,
    left: rect.left, top: rect.top, width: rect.width, height: rect.height }
  if (!image || !combatArtReady(image) || !image.offsetWidth || !image.offsetHeight) return fallback
  const { width: naturalWidth, height: naturalHeight } = combatArtSize(image)
  let center = paintedArt.get(image)
  if (!center || center.src !== image.src) {
    const canvas = document.createElement('canvas')
    const scale = Math.min(1, 128 / Math.max(naturalWidth, naturalHeight))
    canvas.width = Math.max(1, Math.round(naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(naturalHeight * scale))
    const context = canvas.getContext('2d')
    if (!context) return fallback
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
    let mass = 0, x = 0, y = 0
    let left = canvas.width, top = canvas.height, right = 0, bottom = 0
    for (let i = 0; i < pixels.length; i += 4) {
      const alpha = pixels[i + 3]!
      if (alpha <= 32) continue
      const px = (i / 4) % canvas.width, py = Math.floor(i / 4 / canvas.width)
      mass += alpha
      x += (px + .5) * alpha
      y += (py + .5) * alpha
      left = Math.min(left, px); top = Math.min(top, py)
      right = Math.max(right, px + 1); bottom = Math.max(bottom, py + 1)
    }
    if (!mass) return fallback
    center = { src: image.src, x: x / mass / canvas.width, y: y / mass / canvas.height,
      left: left / canvas.width, top: top / canvas.height,
      right: right / canvas.width, bottom: bottom / canvas.height }
    paintedArt.set(image, center)
  }
  const art = image.getBoundingClientRect()
  const style = getComputedStyle(image)
  const scaleX = art.width / image.offsetWidth, scaleY = art.height / image.offsetHeight
  const left = parseFloat(style.paddingLeft) * scaleX, right = parseFloat(style.paddingRight) * scaleX
  const top = parseFloat(style.paddingTop) * scaleY, bottom = parseFloat(style.paddingBottom) * scaleY
  const width = art.width - left - right, height = art.height - top - bottom
  const fit = Math.min(width / naturalWidth, height / naturalHeight)
  return {
    left: art.left + left + (width - naturalWidth * fit) / 2 + center.left * naturalWidth * fit,
    top: art.bottom - bottom - (1 - center.top) * naturalHeight * fit,
    width: (center.right - center.left) * naturalWidth * fit,
    height: (center.bottom - center.top) * naturalHeight * fit,
    x: art.left + left + (width - naturalWidth * fit) / 2 + center.x * naturalWidth * fit,
    y: art.bottom - bottom - (1 - center.y) * naturalHeight * fit,
  }
}

export function combatBodyPoint(portrait: HTMLElement): { x: number; y: number } {
  return combatArtBounds(portrait)
}
