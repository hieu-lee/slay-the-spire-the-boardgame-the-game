// Cache painted mass per mounted sprite; transparent overscan is not its body.
const bodyCenters = new WeakMap<HTMLImageElement, { src: string; x: number; y: number }>()

export function combatBodyPoint(portrait: HTMLElement): { x: number; y: number } {
  const image = portrait.querySelector<HTMLImageElement>(':scope > img')
  const rect = portrait.getBoundingClientRect()
  const fallback = { x: rect.left + rect.width / 2, y: rect.top + rect.height * .7 }
  if (!image?.complete || !image.naturalWidth || !image.naturalHeight || !image.offsetWidth || !image.offsetHeight) return fallback
  let center = bodyCenters.get(image)
  if (!center || center.src !== image.src) {
    const canvas = document.createElement('canvas')
    const scale = Math.min(1, 128 / Math.max(image.naturalWidth, image.naturalHeight))
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
    const context = canvas.getContext('2d')
    if (!context) return fallback
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
    let mass = 0, x = 0, y = 0
    for (let i = 0; i < pixels.length; i += 4) {
      const alpha = pixels[i + 3]!
      if (alpha <= 32) continue
      mass += alpha
      x += ((i / 4) % canvas.width + .5) * alpha
      y += (Math.floor(i / 4 / canvas.width) + .5) * alpha
    }
    if (!mass) return fallback
    center = { src: image.src, x: x / mass / canvas.width, y: y / mass / canvas.height }
    bodyCenters.set(image, center)
  }
  const art = image.getBoundingClientRect()
  const style = getComputedStyle(image)
  const scaleX = art.width / image.offsetWidth, scaleY = art.height / image.offsetHeight
  const left = parseFloat(style.paddingLeft) * scaleX, right = parseFloat(style.paddingRight) * scaleX
  const top = parseFloat(style.paddingTop) * scaleY, bottom = parseFloat(style.paddingBottom) * scaleY
  const width = art.width - left - right, height = art.height - top - bottom
  const fit = Math.min(width / image.naturalWidth, height / image.naturalHeight)
  return {
    x: art.left + left + (width - image.naturalWidth * fit) / 2 + center.x * image.naturalWidth * fit,
    y: art.bottom - bottom - (1 - center.y) * image.naturalHeight * fit,
  }
}
