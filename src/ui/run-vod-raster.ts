// Let the browser paint CSS (masks, conic gradients, filters and blend modes).
// A canvas reimplementation of CSS cannot faithfully reproduce the game.
const resources = new Map<string, Promise<string>>()
const sizedImages = new Map<string, Map<number, Promise<string>>>()

async function staticImage(image: HTMLImageElement, src: string) {
  const original = resource(src, image.baseURI)
  if (!image.naturalWidth || !image.naturalHeight || new URL(src, image.baseURI).origin !== location.origin) return original
  const box = image.getBoundingClientRect()
  // Keep at least two source pixels per canonical output pixel, including
  // transforms. Huge rulebook icons need not be decoded at print resolution
  // inside every SVG frame. Power-of-two sizes bound the cache during zooms.
  const needed = Math.max(Math.max(image.clientWidth, box.width) * 2 / image.naturalWidth,
    Math.max(image.clientHeight, box.height) * 2 / image.naturalHeight)
  const scale = Math.min(1, 2 ** Math.ceil(Math.log2(Math.max(needed, 1 / 1024))))
  if (scale === 1) return original
  let sizes = sizedImages.get(src)
  if (!sizes) { sizes = new Map(); sizedImages.set(src, sizes) }
  let value = sizes.get(scale)
  if (!value) {
    value = original.then(url => {
      const canvas = image.ownerDocument.createElement('canvas')
      canvas.width = Math.ceil(image.naturalWidth * scale)
      canvas.height = Math.ceil(image.naturalHeight * scale)
      const context = canvas.getContext('2d')!
      context.imageSmoothingQuality = 'high'
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      const resized = canvas.toDataURL()
      canvas.width = canvas.height = 0
      return resized.length < url.length ? resized : url
    })
    sizes.set(scale, value)
  }
  return value
}
type DecodedImage = { image: VideoFrame }
type FrameDecoder = {
  tracks: { ready: Promise<void>; selectedTrack: { frameCount: number; repetitionCount: number } }
  decode(options: { frameIndex: number }): Promise<DecodedImage>
  close(): void
}
type ImageDecoderConstructor = new (options: { data: ArrayBuffer; type: string }) => FrameDecoder
const documentDecoders = new Map<Document, Map<string, Promise<FrameDecoder | null>>>()
type RasterDecoder = {
  frame: HTMLIFrameElement
  ready: Promise<void>
  next: number
  pending: Map<number, { resolve: (bitmap: ImageBitmap) => void; reject: (error: Error) => void }>
  message: (event: MessageEvent) => void
}
const rasterDecoders = new Map<Document, RasterDecoder>()
let rasterDecoderUrl = ''
export const setRunVodRasterDecoderUrl = (url = '') => { rasterDecoderUrl = url }
const imageStarts = new WeakMap<HTMLImageElement, { src: string; at: number }>()
const animatedImageSources = new WeakMap<HTMLImageElement, { src: string; nextAt: number }>()
const seededImagePhases = new WeakMap<Document, Record<string, number>>()
const decodedFrames = new WeakMap<FrameDecoder, { index: number; start: number; end: number; url: string }>()
const imageDurations = new WeakMap<FrameDecoder, number>()

const imagePhaseIdentity = (image: HTMLImageElement, src: string) =>
  image.dataset.animationAsset || image.closest<HTMLElement>('[data-attack-asset]')?.dataset.attackAsset || src

const imagePhaseKey = (image: HTMLImageElement, src: string) => {
  const identity = imagePhaseIdentity(image, src)
  let ordinal = 0
  for (const candidate of image.ownerDocument.images) {
    if (candidate === image) break
    const candidateSrc = candidate.currentSrc || candidate.src
    if (imagePhaseIdentity(candidate, candidateSrc) === identity) ordinal++
  }
  return `${identity}\n${ordinal}`
}

export function seedRunVodImagePhases(doc: Document, phases?: Record<string, number>) {
  if (phases) seededImagePhases.set(doc, phases)
  else seededImagePhases.delete(doc)
}

function runVodImageStart(image: HTMLImageElement, src: string, now: number) {
  let start = imageStarts.get(image)
  if (!start || start.src !== src) {
    start = { src, at: now - (seededImagePhases.get(image.ownerDocument)?.[imagePhaseKey(image, src)] ?? 0) }
    imageStarts.set(image, start)
  }
  return start
}

export function trackRunVodImagePhases(doc: Document, now: number) {
  for (const image of doc.images) {
    const src = image.currentSrc || image.src
    if (src) runVodImageStart(image, src, now)
  }
}

export function runVodImagePhases(doc: Document, now: number) {
  const phases: Record<string, number> = {}
  for (const image of doc.images) {
    const src = image.currentSrc || image.src
    const start = imageStarts.get(image)
    if (start?.src === src) phases[imagePhaseKey(image, src)] = Math.max(0, now - start.at)
  }
  return phases
}
type StyledClone = { source: Element; clone: HTMLElement | SVGElement; pseudo?: '::before' | '::after'; paintOverflow: number }
type RasterCache = {
  content: HTMLElement
  nodes: StyledClone[]
  images: { source: HTMLImageElement; clone: HTMLElement | SVGElement }[]
  observer: MutationObserver
  viewport: string
  scroll: string
  dirty: boolean
  animations: Set<KeyframeEffect>
  restyle: Set<Element>
  serialized: string
  baseCss: string
  styles: string[]
  layoutStyles: string[]
  mutations: (records: MutationRecord[]) => void
}
const snapshots = new Map<Document, RasterCache>()
const paintOnly = /^(offset|easing|composite|computedOffset|transform|translate|rotate|scale|opacity|filter|clipPath|boxShadow|textShadow|backgroundColor|backgroundPositionX|backgroundPositionY|border(?:Top|Right|Bottom|Left)?Color|strokeDashoffset|offsetDistance)$/
const artworkProperties = ['background-image', 'border-image-source', 'mask-image', '-webkit-mask-image', 'list-style-image']
const RASTER_REGION_PADDING = 96

function rasterDecoder(doc: Document) {
  let decoder = rasterDecoders.get(doc)
  if (decoder) return decoder
  const frame = doc.createElement('iframe')
  frame.hidden = true
  frame.dataset.runVodRasterDecoder = ''
  frame.sandbox.add('allow-scripts')
  const source = `<script>
    parent.postMessage({ runVodRasterReady: true }, '*')
    addEventListener('message', async ({ data }) => {
      if (!data?.runVodRaster) return
      try {
        const url = 'data:image/svg+xml;charset=utf-8,' + encodeURI(data.svg).replaceAll('#', '%23')
        const image = new Image(); image.src = url
        await image.decode()
        const canvas = new OffscreenCanvas(data.width, data.height)
        canvas.getContext('2d', { alpha: !data.opaque }).drawImage(image, 0, 0)
        image.removeAttribute('src')
        const bitmap = canvas.transferToImageBitmap()
        parent.postMessage({ runVodRaster: data.runVodRaster, bitmap }, '*', [bitmap])
      } catch (error) {
        parent.postMessage({ runVodRaster: data.runVodRaster, error: String(error?.stack || error?.message || error) }, '*')
      }
    })
  <\/script>`
  if (rasterDecoderUrl) frame.src = rasterDecoderUrl
  else frame.srcdoc = source
  let opened!: () => void
  const ready = new Promise<void>((resolve, reject) => {
    const timeout = doc.defaultView!.setTimeout(() => reject(new Error('The isolated VOD raster decoder did not start.')), 10_000)
    opened = () => { doc.defaultView!.clearTimeout(timeout); resolve() }
  })
  const pending: RasterDecoder['pending'] = new Map()
  const message = (event: MessageEvent) => {
    if (event.source !== frame.contentWindow) return
    if (event.data?.runVodRasterReady) { opened(); return }
    const request = pending.get(Number(event.data?.runVodRaster))
    if (!request) return
    pending.delete(Number(event.data.runVodRaster))
    if (event.data.bitmap) request.resolve(event.data.bitmap)
    else request.reject(new Error(event.data.error || 'The isolated VOD raster decoder failed.'))
  }
  doc.defaultView!.addEventListener('message', message)
  doc.body.append(frame)
  decoder = { frame, ready, next: 0, pending, message }
  rasterDecoders.set(doc, decoder)
  return decoder
}

async function decodeRaster(doc: Document, svg: string, width: number, height: number, opaque: boolean) {
  const decoder = rasterDecoder(doc)
  await decoder.ready
  const id = ++decoder.next
  const result = new Promise<ImageBitmap>((resolve, reject) => decoder.pending.set(id, { resolve, reject }))
  decoder.frame.contentWindow!.postMessage({ runVodRaster: id, svg, width, height, opaque }, '*')
  return result
}

export type RunVodRasterRegion = { x: number; y: number; width: number; height: number; safe: boolean }

type NativeRasterCanvas = HTMLCanvasElement & {
  requestPaint?: () => void
}
type NativeRasterContext = CanvasRenderingContext2D & {
  drawElementImage?: (element: Element, x: number, y: number) => void
}
export const hasNativeRunVodRaster = (view = window) =>
  typeof (view.HTMLCanvasElement.prototype as NativeRasterCanvas).requestPaint === 'function' &&
  typeof (view.CanvasRenderingContext2D.prototype as NativeRasterContext).drawElementImage === 'function'
const nativeRasters = new Map<Document, { canvas: NativeRasterCanvas; root: HTMLElement; frame: HTMLElement | null;
  opacity: string; cover: HTMLElement | null; context: NativeRasterContext; observer: MutationObserver; dirty: boolean;
  content: HTMLElement | null; sources: Element[]; copies: Element[]; animationStyle: HTMLStyleElement | null;
  overrides: { target: HTMLElement | SVGElement; property: string; value: string; priority: string }[] }>()
const nativeRasterQueues = new WeakMap<Document, { tail: Promise<void> }>()

function releaseNativeRaster(doc: Document) {
  const native = nativeRasters.get(doc)
  if (!native) return
  if (native.frame) native.frame.style.opacity = native.opacity
  native.cover?.remove()
  native.observer.disconnect()
  native.canvas.remove()
  nativeRasters.delete(doc)
}

async function nativeRaster(doc: Document, width: number, height: number, at: number | undefined,
  readback: boolean, crop?: RunVodRasterRegion) {
  const queue = nativeRasterQueues.get(doc) ?? { tail: Promise.resolve() }
  const previous = queue.tail
  let release!: () => void
  queue.tail = new Promise(resolve => { release = resolve })
  nativeRasterQueues.set(doc, queue)
  await previous
  try { return await nativeRasterNow(doc, width, height, at, readback, crop) }
  finally { release() }
}

async function nativeRasterNow(doc: Document, width: number, height: number, at: number | undefined,
  readback: boolean, crop?: RunVodRasterRegion) {
  let raster = nativeRasters.get(doc)
  if (!raster) {
    const canvas = doc.createElement('canvas') as NativeRasterCanvas
    const context = canvas.getContext('2d', { alpha: false }) as NativeRasterContext | null
    const root = doc.getElementById('root')
    if (!(root instanceof doc.defaultView!.HTMLElement) || typeof canvas.requestPaint !== 'function' ||
      !context || typeof context.drawElementImage !== 'function') return null
    snapshots.get(doc)?.observer.disconnect()
    snapshots.delete(doc)
    canvas.width = width; canvas.height = height
    canvas.setAttribute('layoutsubtree', '')
    canvas.setAttribute('content', 'drawable')
    canvas.style.cssText = `display:block;width:${width}px;height:${height}px;background:${doc.defaultView!.getComputedStyle(doc.body).background}`
    const frame = doc.defaultView!.frameElement as HTMLElement | null
    const opacity = frame?.style.opacity ?? ''
    if (frame) frame.style.opacity = '1'
    const cover = frame?.ownerDocument.createElement('div') ?? null
    cover?.setAttribute('aria-hidden', 'true')
    if (cover) cover.style.cssText = 'position:absolute;inset:0;z-index:1;background:#05070c'
    if (frame && cover) frame.after(cover)
    canvas.dataset.runVodNativeRaster = ''
    doc.getElementById('root')!.after(canvas)
    raster = { canvas, root, frame, opacity, cover, context, observer: null!, dirty: true, content: null,
      sources: [], copies: [], animationStyle: null, overrides: [] }
    raster.observer = new MutationObserver(() => { raster!.dirty = true })
    raster.observer.observe(root, { childList: true, subtree: true, attributes: true, characterData: true })
    nativeRasters.set(doc, raster)
  }
  if (raster.observer.takeRecords().length) raster.dirty = true
  if (raster.dirty) {
    const copiedRoot = raster.root.cloneNode(true) as HTMLElement
    const content = doc.createElement('div')
    content.style.cssText = `position:fixed;inset:0;width:${width}px;height:${height}px;overflow:hidden`
    content.className = 'run-vod-native'
    content.setAttribute('drawable', '')
    content.append(copiedRoot)
    const style = doc.createElement('style')
    content.prepend(style)
    raster.canvas.replaceChildren(content)
    raster.content = content
    raster.sources = [raster.root, ...raster.root.querySelectorAll('*')]
    raster.copies = [copiedRoot, ...copiedRoot.querySelectorAll('*')]
    raster.animationStyle = style
    raster.overrides = []
    raster.dirty = false
  }
  if (!raster.content!.isConnected) raster.canvas.replaceChildren(raster.content!)
  for (const override of raster.overrides) {
    override.target.style.setProperty(override.property, override.value, override.priority)
  }
  raster.overrides = []
  const indices = new Map(raster.sources.map((source, index) => [source, index]))
  const animationCss: string[] = []
  for (const animation of doc.getAnimations()) {
    const effect = animation.effect
    if (!(effect instanceof doc.defaultView!.KeyframeEffect) || !(effect.target instanceof doc.defaultView!.Element)) continue
    const index = indices.get(effect.target)
    const target = index === undefined ? undefined : raster.copies[index] as HTMLElement | SVGElement | undefined
    if (!target) continue
    const pseudo = effect.pseudoElement ?? ''
    const style = doc.defaultView!.getComputedStyle(effect.target, pseudo)
    const properties = [...new Set(effect.getKeyframes().flatMap(frame => Object.keys(frame)))]
      .filter(property => !/^(offset|easing|composite|computedOffset)$/.test(property))
    const declarations = properties.map((property) => {
        const css = property.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)
        return `${css}:${style.getPropertyValue(css)}!important`
      }).join(';')
    if (pseudo) {
      target.setAttribute('data-run-vod-native', String(index))
      animationCss.push(`[data-run-vod-native="${index}"]${pseudo}{${declarations}}`)
    } else for (const property of properties) {
      const css = property.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)
      raster.overrides.push({ target, property: css, value: target.style.getPropertyValue(css), priority: target.style.getPropertyPriority(css) })
      target.style.setProperty(css, style.getPropertyValue(css), 'important')
    }
  }
  raster.animationStyle!.textContent = `.run-vod-native,.run-vod-native *, .run-vod-native::before,.run-vod-native::after,.run-vod-native *::before,.run-vod-native *::after{animation:none!important;transition:none!important}${animationCss.join('')}`
  const images: Promise<unknown>[] = []
  for (const [index, source] of raster.sources.entries()) {
    const copied = raster.copies[index]
    if (source instanceof doc.defaultView!.HTMLElement && copied instanceof doc.defaultView!.HTMLElement) {
      copied.scrollLeft = source.scrollLeft; copied.scrollTop = source.scrollTop
    }
    if (source instanceof doc.defaultView!.HTMLCanvasElement && copied instanceof doc.defaultView!.HTMLCanvasElement) {
      copied.getContext('2d')?.drawImage(source, 0, 0)
    }
    if (at !== undefined && source instanceof doc.defaultView!.HTMLImageElement && copied instanceof doc.defaultView!.HTMLImageElement) {
      const src = source.currentSrc || source.src
      if (/\.webp(?:\?|$)/.test(src) || src.startsWith('blob:')) {
        images.push(imageAt(source, src, at).then(value => { copied.src = value }))
      }
    }
  }
  await Promise.all(images)
  await new Promise<void>((resolve) => {
    const done = () => { doc.defaultView!.clearTimeout(timeout); raster!.canvas.removeEventListener('paint', done); resolve() }
    const timeout = doc.defaultView!.setTimeout(done, 100)
    raster!.canvas.addEventListener('paint', done, { once: true })
    raster!.canvas.requestPaint!()
  })
  raster.context.clearRect(0, 0, width, height)
  raster.context.drawElementImage!(raster.content!, 0, 0)
  const output = doc.createElement('canvas')
  output.width = crop?.width ?? width
  output.height = crop?.height ?? height
  output.getContext('2d', { willReadFrequently: readback })!.drawImage(raster.canvas,
    crop?.x ?? 0, crop?.y ?? 0, output.width, output.height, 0, 0, output.width, output.height)
  raster.content!.remove()
  return output
}

export function mergeRunVodRasterRegions(values: RunVodRasterRegion[], limit = 8) {
  const regions = values.map(region => ({ ...region }))
  const join = (i: number, j: number) => {
    const a = regions[i]!, b = regions[j]!
    regions[i] = {
      x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
      width: Math.max(a.x + a.width, b.x + b.width) - Math.min(a.x, b.x),
      height: Math.max(a.y + a.height, b.y + b.height) - Math.min(a.y, b.y),
      safe: a.safe && b.safe,
    }
    regions.splice(j, 1)
  }
  for (let i = 0; i < regions.length; i++) for (let j = regions.length - 1; j > i; j--) {
    const a = regions[i]!, b = regions[j]!
    if (a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height) join(i, j)
  }
  while (regions.length > limit) {
    let bestI = 0, bestJ = 1, bestWaste = Infinity
    for (let i = 0; i < regions.length; i++) for (let j = i + 1; j < regions.length; j++) {
      const a = regions[i]!, b = regions[j]!
      const width = Math.max(a.x + a.width, b.x + b.width) - Math.min(a.x, b.x)
      const height = Math.max(a.y + a.height, b.y + b.height) - Math.min(a.y, b.y)
      const waste = width * height - a.width * a.height - b.width * b.height
      if (waste < bestWaste) { bestI = i; bestJ = j; bestWaste = waste }
    }
    join(bestI, bestJ)
  }
  return regions
}

const scrollState = (element: HTMLElement) => [element, ...element.querySelectorAll('*')]
  .map((node, index) => node.scrollTop || node.scrollLeft ? `${index}:${node.scrollLeft}:${node.scrollTop}` : '').filter(Boolean).join(';')

function activeRasterTargets(doc: Document) {
  const view = doc.defaultView!
  return doc.getAnimations().flatMap((animation) => {
    const effect = animation.effect
    if (!(effect instanceof view.KeyframeEffect) || !(effect.target instanceof view.Element)) return []
    const currentTime = Number(animation.currentTime ?? 0)
    const delay = Math.max(0, Number(effect.getTiming().delay))
    if (currentTime > 0 && currentTime < delay) return []
    const endTime = Number(effect.getComputedTiming().endTime)
    // The replay clock pauses completed CSS animations so their last style
    // remains visible. They no longer change a frame.
    if (Number.isFinite(endTime) && currentTime >= endTime) return []
    return [{ effect, target: effect.target as HTMLElement | SVGElement }]
  })
}

function paintOverflow(style: CSSStyleDeclaration) {
  const shadows = (value: string) => Math.max(0, ...value.replace(/rgba?\([^)]*\)/g, '').split(',').map((shadow) => {
    if (/\binset\b/.test(shadow)) return 0
    const lengths = [...shadow.matchAll(/-?\d*\.?\d+px/g)].map(match => Number.parseFloat(match[0]))
    return Math.max(Math.abs(lengths[0] ?? 0), Math.abs(lengths[1] ?? 0)) + 1.5 * (lengths[2] ?? 0) + Math.abs(lengths[3] ?? 0)
  }))
  const filter = style.filter.replace(/rgba?\([^)]*\)/g, '')
  const blur = [...filter.matchAll(/blur\((-?\d*\.?\d+)px\)/g)].reduce((sum, match) => sum + 1.5 * Math.abs(Number(match[1])), 0)
  const drops = [...filter.matchAll(/drop-shadow\(([^)]*)\)/g)].reduce((sum, match) => sum + shadows(match[1]!), 0)
  return Math.max(shadows(style.boxShadow), shadows(style.textShadow), blur + drops)
}

function paintOnlyAnimationProperty(property: string, target?: Element) {
  if (paintOnly.test(property)) return true
  if (property !== 'width' || !target?.matches('.bar__fill')) return false
  const view = target.ownerDocument.defaultView!
  return view.getComputedStyle(target).position === 'absolute' &&
    view.getComputedStyle(target.parentElement!).overflow === 'hidden'
}

function animationEscapes(target: Element, root: HTMLElement, view: Window) {
  const nodes = new Set<Element>([target, ...target.querySelectorAll('*')])
  for (let node = target.parentElement; node && root.contains(node); node = node.parentElement) nodes.add(node)
  return [...nodes].some((node) => ['', '::before', '::after'].some((pseudo) => {
    const style = view.getComputedStyle(node, pseudo)
    return paintOverflow(style) > RASTER_REGION_PADDING
  }))
}

// A full-frame cache remains the authority. This only offers a crop when every
// running effect repaints in place; callers fall back on any layout mutation.
export function runVodRasterRegions(element: HTMLElement, at?: number): RunVodRasterRegion[] | null {
  const doc = element.ownerDocument
  const view = doc.defaultView!
  const cached = snapshots.get(doc)
  cached?.mutations(cached.observer.takeRecords())
  const regions: RunVodRasterRegion[] = []
  const included = new Set<Element>()
  const include = (source: Element) => {
    if (included.has(source)) return
    included.add(source)
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity
    for (const node of [source, ...source.querySelectorAll('*')]) {
      const box = node.getBoundingClientRect()
      if (!box.width || !box.height) continue
      left = Math.min(left, box.left - RASTER_REGION_PADDING)
      top = Math.min(top, box.top - RASTER_REGION_PADDING)
      right = Math.max(right, box.right + RASTER_REGION_PADDING)
      bottom = Math.max(bottom, box.bottom + RASTER_REGION_PADDING)
    }
    left = Math.max(0, Math.floor(left)); top = Math.max(0, Math.floor(top))
    right = Math.min(view.innerWidth, Math.ceil(right)); bottom = Math.min(view.innerHeight, Math.ceil(bottom))
    if (right > left && bottom > top) regions.push({ x: left, y: top, width: right - left, height: bottom - top, safe: true })
  }
  let safe = Boolean(cached && !cached.dirty && cached.restyle.size === 0 && cached.scroll === scrollState(element))
  for (const image of doc.images) {
    const animated = animatedImageSources.get(image)
    if (animated?.src === (image.currentSrc || image.src) && (at === undefined || animated.nextAt <= at)) include(image)
  }
  for (const { effect, target } of activeRasterTargets(doc)) {
    // Combat VFX pseudo layers are contained by the same bounded overlay as
    // their host; the 96px crop padding exceeds their largest keyframe scale.
    if (effect.pseudoElement && !target.matches('.combat-vfx')) safe = false
    if (!target.matches('.combat-vfx') && ['::before', '::after'].some(pseudo => {
      const content = view.getComputedStyle(target, pseudo).content
      return content !== 'none' && content !== 'normal'
    })) safe = false
    if ([...effect.getKeyframes()].some((frame) => Object.keys(frame).some((key) =>
      !paintOnlyAnimationProperty(key, target)))) safe = false
    if (animationEscapes(target, element, view)) safe = false
    include(target)
  }
  if (!regions.length) return safe ? null : [{ x: 0, y: 0, width: view.innerWidth, height: view.innerHeight, safe }]
  return mergeRunVodRasterRegions(regions).map(region => ({ ...region, safe }))
}

export function runVodRasterRegion(element: HTMLElement, at?: number): RunVodRasterRegion | null {
  const regions = runVodRasterRegions(element, at)
  if (!regions?.length) return null
  const x = Math.min(...regions.map(region => region.x)), y = Math.min(...regions.map(region => region.y))
  return {
    x, y,
    width: Math.max(...regions.map(region => region.x + region.width)) - x,
    height: Math.max(...regions.map(region => region.y + region.height)) - y,
    safe: regions.every(region => region.safe),
  }
}

function croppedContent(cache: RasterCache, element: HTMLElement, crop: RunVodRasterRegion) {
  const keep = new Set<Element>()
  for (const { source, paintOverflow } of cache.nodes) {
    const box = source.getBoundingClientRect()
    if (box.right + paintOverflow <= crop.x || box.bottom + paintOverflow <= crop.y ||
      box.left - paintOverflow >= crop.x + crop.width || box.top - paintOverflow >= crop.y + crop.height) continue
    for (let node: Element | null = source; node && element.contains(node); node = node.parentElement) keep.add(node)
  }
  const content = cache.content.cloneNode(true) as HTMLElement
  const fullStyles = new Set<number>()
  const layoutStyles = new Set<number>()
  for (const clone of content.querySelectorAll<HTMLElement | SVGElement>('[data-run-vod-style]:not([data-run-vod-node])')) {
    fullStyles.add(Number(clone.getAttribute('data-run-vod-style')))
  }
  for (const clone of [content, ...content.querySelectorAll<HTMLElement | SVGElement>('[data-run-vod-node]')]) {
    const node = cache.nodes[Number(clone.getAttribute('data-run-vod-node'))]
    if (!node) continue
    const style = Number(clone.getAttribute('data-run-vod-style'))
    if (node.pseudo || keep.has(node.source)) { fullStyles.add(style); continue }
    layoutStyles.add(style)
    clone.removeAttribute('data-run-vod-style')
    clone.setAttribute('data-run-vod-layout-style', String(style))
    // Retain layout but omit embedded artwork that cannot reach this crop.
    for (const property of artworkProperties) {
      clone.style.setProperty(property, 'none', 'important')
    }
    if (clone.tagName === 'IMG' || clone.tagName === 'image') {
      clone.removeAttribute('src')
      clone.removeAttribute('href')
    }
  }
  const rules = (indices: Set<number>, styles: string[], attribute: string) => [...indices].map(index =>
    `.run-vod-snapshot[${attribute}="${index}"],.run-vod-snapshot [${attribute}="${index}"]{${styles[index]}}`).join('\n')
  content.querySelector('style')!.textContent = `${cache.baseCss}\n${rules(fullStyles, cache.styles, 'data-run-vod-style')}\n${rules(layoutStyles, cache.layoutStyles, 'data-run-vod-layout-style')}`
  return content
}

async function imageAt(image: HTMLImageElement, src: string, now: number) {
  const Decoder = (window as unknown as { ImageDecoder?: ImageDecoderConstructor }).ImageDecoder
  if (!(/\.webp(?:\?|$)/.test(src) || src.startsWith('blob:'))) return staticImage(image, src)
  let decoders = documentDecoders.get(image.ownerDocument)
  if (!decoders) { decoders = new Map(); documentDecoders.set(image.ownerDocument, decoders) }
  let decoder = decoders.get(src)
  if (!decoder) {
    decoder = fetch(src).then(async (response) => {
      const blob = await response.blob()
      if (blob.type !== 'image/webp') return null
      if (!Decoder) {
        const header = new Uint8Array(await blob.slice(12, 21).arrayBuffer())
        if (String.fromCharCode(...header.slice(0, 4)) === 'VP8X' && (header[8]! & 2)) {
          throw new Error('Animated VOD export requires ImageDecoder support. Please use a current Chrome or Edge browser.')
        }
        return null
      }
      const result = new Decoder({ data: await blob.arrayBuffer(), type: blob.type })
      await result.tracks.ready
      if (result.tracks.selectedTrack.frameCount <= 1) { result.close(); return null }
      return result
    })
    decoders.set(src, decoder)
  }
  const decoded = await decoder
  if (!decoded || decoded.tracks.selectedTrack.frameCount <= 1) return staticImage(image, src)
  const start = runVodImageStart(image, src, now)
  const elapsedSinceStart = Math.max(0, now - start.at) * 1_000
  const repetitions = decoded.tracks.selectedTrack.repetitionCount
  let elapsed = elapsedSinceStart
  const duration = imageDurations.get(decoded)
  const finished = Boolean(duration && Number.isFinite(repetitions) && elapsedSinceStart >= duration * (repetitions + 1))
  if (duration && repetitions > 0 && !finished) elapsed %= duration
  let last = decodedFrames.get(decoded)
  const track = (frame: NonNullable<typeof last>) => {
    const total = imageDurations.get(decoded)
    if (total && Number.isFinite(repetitions) && elapsedSinceStart >= total * (repetitions + 1)) {
      animatedImageSources.delete(image)
      return
    }
    const cycles = total && repetitions > 0 ? Math.floor(elapsedSinceStart / total) : 0
    animatedImageSources.set(image, { src, nextAt: start!.at + (cycles * (total ?? 0) + frame.end) / 1_000 })
  }
  if (last && elapsed < last.end && elapsed >= last.start) { track(last); return last.url }
  let index = last && elapsed >= last.end ? last.index + 1 : 0
  let end = index > 0 ? last!.end : 0
  while (index < decoded.tracks.selectedTrack.frameCount) {
    const { image: frame } = await decoded.decode({ frameIndex: index })
    const began = end
    end += frame.duration ?? 33_333
    if (index === decoded.tracks.selectedTrack.frameCount - 1) {
      imageDurations.set(decoded, end)
      if (!duration && repetitions > 0 && elapsedSinceStart < end * (repetitions + 1) && elapsedSinceStart >= end) {
        frame.close()
        return imageAt(image, src, now)
      }
    }
    if (end > elapsed || index === decoded.tracks.selectedTrack.frameCount - 1) {
      const canvas = document.createElement('canvas')
      canvas.width = frame.displayWidth
      canvas.height = frame.displayHeight
      canvas.getContext('2d')!.drawImage(frame, 0, 0)
      frame.close()
      last = { index, start: began, end, url: canvas.toDataURL() }
      canvas.width = canvas.height = 0
      decodedFrames.set(decoded, last)
      track(last)
      return last.url
    }
    frame.close()
    index++
  }
  track(last!)
  return last!.url
}

// Call only after the event's raster jobs have drained. Native decoders can
// retain every decoded animation frame even after its DOM image disappears.
export async function pruneRunVodRaster(doc: Document) {
  const active = new Set([...doc.images].map(image => image.currentSrc || image.src))
  const decoders = documentDecoders.get(doc)
  for (const [src, decoder] of decoders ?? []) if (!active.has(src)) {
    ;(await decoder)?.close()
    decoders?.delete(src)
  }
  const allActive = new Set([...snapshots.keys()].flatMap(document => [...document.images].map(image => image.currentSrc || image.src)))
  for (const src of resources.keys()) if (src.startsWith('blob:') && !allActive.has(src)) {
    resources.delete(src); sizedImages.delete(src)
  }
}

export async function releaseRunVodRaster(doc?: Document) {
  for (const document of doc ? [doc] : new Set([...snapshots.keys(), ...documentDecoders.keys(), ...rasterDecoders.keys(), ...nativeRasters.keys()])) {
    releaseNativeRaster(document)
    snapshots.get(document)?.observer.disconnect()
    snapshots.delete(document)
    for (const decoder of documentDecoders.get(document)?.values() ?? []) {
      try { (await decoder)?.close() } catch { /* Preserve the original artwork error. */ }
    }
    documentDecoders.delete(document)
    const raster = rasterDecoders.get(document)
    if (raster) {
      document.defaultView?.removeEventListener('message', raster.message)
      raster.pending.forEach(({ reject }) => reject(new Error('The VOD raster decoder was released.')))
      raster.frame.remove()
      rasterDecoders.delete(document)
    }
  }
  if (!snapshots.size) { resources.clear(); sizedImages.clear() }
}
const dataUrl = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(String(reader.result))
  reader.onerror = () => reject(reader.error)
  reader.readAsDataURL(blob)
})

function resource(url: string, base: string) {
  if (url.startsWith('data:') || url.startsWith('#')) return Promise.resolve(url)
  const absolute = new URL(url, base).href
  const reference = new URL(absolute)
  if (reference.hash && absolute.slice(0, -reference.hash.length) === new URL(base).href.split('#')[0]) {
    return Promise.resolve(reference.hash)
  }
  let value = resources.get(absolute)
  if (!value) {
    value = fetch(absolute).then((response) => {
      if (!response.ok) throw new Error(`Could not load VOD artwork: ${absolute}`)
      return response.blob()
    }).then(dataUrl)
    resources.set(absolute, value)
  }
  return value
}

async function inlineUrls(value: string, base: string) {
  const matches = [...value.matchAll(/url\(["']?([^"')]+)["']?\)/g)]
  const values = await Promise.all(matches.map((match) => resource(match[1]!, base)))
  for (let index = 0; index < matches.length; index++) {
    value = value.replace(matches[index]![0], `url("${values[index]}")`)
  }
  return value
}

const fonts = new WeakMap<Document, Promise<string>>()
const initialStyles = new WeakMap<Document, Map<string, string>>()
function initialStyle(doc: Document) {
  let values = initialStyles.get(doc)
  if (!values) {
    const probe = doc.createElement('span')
    probe.style.cssText = 'all:initial!important;display:none!important;'
    doc.body.append(probe)
    const style = doc.defaultView!.getComputedStyle(probe)
    values = new Map([...style].map((property) => [property, style.getPropertyValue(property)]))
    values.delete('display')
    probe.remove()
    initialStyles.set(doc, values)
  }
  return values
}
function fontCss(doc: Document) {
  let value = fonts.get(doc)
  if (!value) {
    const rules: Promise<string>[] = []
    const visit = (list: CSSRuleList, base: string) => {
      for (const rule of list) {
        if (rule.type === 5) rules.push(inlineUrls(rule.cssText, base))
        if ('cssRules' in rule) visit((rule as CSSGroupingRule).cssRules, base)
      }
    }
    for (const sheet of doc.styleSheets) {
      try { visit(sheet.cssRules, sheet.href ?? doc.baseURI) } catch { /* Ignore extension styles. */ }
    }
    value = Promise.all(rules).then((rules) => rules.join('\n'))
    fonts.set(doc, value)
  }
  return value
}

export async function rasterRunVod(element: HTMLElement, width: number, height: number, at?: number, prepared?: () => void, readback = false,
  crop?: RunVodRasterRegion) {
  const doc = element.ownerDocument
  const view = doc.defaultView!
  const root = doc.getElementById('root')
  const native = element === doc.body && !doc.querySelector('dialog[open]') && [...doc.body.children].every(child =>
    child === root || child.matches('script,style,link,[hidden],[data-run-vod-native-raster],[data-run-vod-raster-decoder]')) &&
    hasNativeRunVodRaster(view)
  if (native) {
    const canvas = await nativeRaster(doc, width, height, at, readback, crop)
    if (canvas) { prepared?.(); return canvas }
  } else releaseNativeRaster(doc)
  rasterDecoder(doc)
  await doc.fonts.ready
  const defaults = initialStyle(doc)
  const viewport = `${view.innerWidth}:${view.innerHeight}`
  const scroll = scrollState(element)
  const animations = doc.getAnimations().map((animation) => animation.effect).filter((effect): effect is KeyframeEffect =>
    effect instanceof view.KeyframeEffect)
  const animationProperties = new Map<Element, Map<string, Set<string>>>()
  for (const effect of animations) {
    if (!(effect.target instanceof view.Element)) continue
    const pseudo = effect.pseudoElement ?? ''
    let byPseudo = animationProperties.get(effect.target)
    if (!byPseudo) { byPseudo = new Map(); animationProperties.set(effect.target, byPseudo) }
    let properties = byPseudo.get(pseudo)
    if (!properties) { properties = new Set(); byPseudo.set(pseudo, properties) }
    for (const frame of effect.getKeyframes()) for (const property of Object.keys(frame)) {
      if (paintOnlyAnimationProperty(property, effect.target) && !/^(offset|easing|composite|computedOffset)$/.test(property)) properties.add(property)
    }
  }
  let cached = element === doc.body && at !== undefined ? snapshots.get(doc) : undefined
  cached?.mutations(cached.observer.takeRecords())
  if (cached && (cached.dirty || cached.viewport !== viewport || cached.scroll !== scroll ||
    [...cached.animations].some((effect) => !animations.includes(effect)) ||
    animations.some((effect) => effect.target instanceof view.Element && effect.getKeyframes().some((frame) =>
      Object.keys(frame).some((key) => !paintOnlyAnimationProperty(key, effect.target as Element)))))) {
    cached.observer.disconnect()
    snapshots.delete(doc)
    cached = undefined
  }
  if (cached) for (const effect of animations) cached.animations.add(effect)
  const nodes: StyledClone[] = []
  const images: RasterCache['images'] = []
  const pending: Promise<unknown>[] = []
  const modals: { source: Element; clone: HTMLElement | SVGElement }[] = []
  const styleClasses = new Map<string, number>()
  const layoutStyle = (css: string) => {
    const value = doc.createElement('span').style
    value.cssText = css
    for (const property of artworkProperties) value.removeProperty(property)
    return value.cssText
  }
  const copyStyle = (style: CSSStyleDeclaration, clone: HTMLElement | SVGElement, source?: Element) => {
    const declarations: string[] = []
    for (const property of style) {
      if (property.startsWith('--') || property.startsWith('animation') || property.startsWith('transition') || property === 'cursor') continue
      const value = style.getPropertyValue(property)
      if (defaults.get(property) === value) continue
      declarations.push(`${property}:${value};`)
      if (value.includes('url(')) pending.push(inlineUrls(value, doc.baseURI).then((result) => clone.style.setProperty(property, result)))
    }
    const css = `${declarations.join('')}animation:none!important;transition:none!important;`
    if (cached) clone.style.cssText = css
    else {
      let index = styleClasses.get(css)
      if (index === undefined) { index = styleClasses.size; styleClasses.set(css, index) }
      clone.setAttribute('data-run-vod-style', String(index))
    }
    // Chromium resolves a grid container's auto margins to 0px in CSSOM,
    // even while they center it. Preserve the computed keyword when available.
    const computed = (source as Element & { computedStyleMap?: () => Map<string, { toString(): string }> } | undefined)?.computedStyleMap?.()
    for (const side of ['top', 'right', 'bottom', 'left']) {
      if (computed?.get(`margin-${side}`)?.toString() === 'auto') clone.style.setProperty(`margin-${side}`, 'auto')
    }
    if (clone.tagName === 'BUTTON') clone.style.appearance = 'none'
  }
  const pseudo = (source: Element, kind: '::before' | '::after') => {
    const style = view.getComputedStyle(source, kind)
    if (style.content === 'none' || style.content === 'normal' || style.display === 'none') return null
    const clone = doc.createElement('span')
    nodes.push({ source, clone, pseudo: kind, paintOverflow: paintOverflow(style) })
    copyStyle(style, clone)
    clone.style.content = 'normal'
    const text = style.content.match(/^"(?:[^"\\]|\\.)*"/)?.[0]
    if (text) {
      try { clone.textContent = JSON.parse(text) } catch { clone.textContent = text.slice(1, -1) }
    }
    return clone
  }
  const cloneNode = (source: Node): Node | null => {
    if (source.nodeType === Node.TEXT_NODE) return source.cloneNode()
    if (!(source instanceof view.Element) || source.matches('script, style, link, iframe')) return null
    const style = view.getComputedStyle(source)
    if (style.display === 'none') return null
    const clone = source.cloneNode(false) as HTMLElement | SVGElement
    if (source instanceof view.HTMLElement) {
      clone.removeAttribute('class')
      clone.removeAttribute('id')
    }
    nodes.push({ source, clone, paintOverflow: paintOverflow(style) })
    copyStyle(style, clone, source)
    if (source instanceof view.SVGElement && source.tagName === 'image') {
      const href = source.getAttribute('href')
      if (href) pending.push(resource(href, doc.baseURI).then((value) => clone.setAttribute('href', value)))
    }
    for (const attribute of [...clone.attributes]) if (attribute.name.startsWith('on')) clone.removeAttribute(attribute.name)
    if (source instanceof view.HTMLImageElement) {
      images.push({ source, clone })
      clone.removeAttribute('srcset')
      clone.removeAttribute('loading')
      const src = source.currentSrc || source.src
      if (src) pending.push((at === undefined ? resource(src, doc.baseURI) : imageAt(source, src, at))
        .then((value) => clone.setAttribute('src', value)))
    }
    if (source instanceof view.HTMLCanvasElement) {
      const image = doc.createElement('img')
      copyStyle(style, image, source)
      image.src = source.toDataURL()
      return image
    }
    const before = pseudo(source, '::before')
    if (before) clone.append(before)
    for (const child of source.childNodes) {
      const copied = cloneNode(child)
      if (copied) clone.append(copied)
    }
    const after = pseudo(source, '::after')
    if (after) clone.append(after)
    // Scroll positions are browser state, not serialized DOM attributes.
    // Move each layout child without changing the original grid/flex layout.
    if (source.scrollLeft || source.scrollTop) {
      clone.style.overflow = 'hidden'
      for (const child of clone.children) {
        const styled = child as HTMLElement | SVGElement
        const transform = styled.style.transform
        styled.style.transform = `translate(${-source.scrollLeft}px, ${-source.scrollTop}px) ${transform === 'none' ? '' : transform}`
      }
    }
    if (source.matches(':modal')) modals.push({ source, clone })
    return clone
  }
  const content = cached?.content ?? cloneNode(element) as HTMLElement
  const animationMarker = '/*run-vod-animation*/'
  if (!cached && element === doc.body && at !== undefined) {
    nodes.forEach((node, index) => node.clone.setAttribute('data-run-vod-node', String(index)))
  }
  for (const { source, clone } of modals) {
    const backdrop = doc.createElement('div')
    copyStyle(view.getComputedStyle(source, '::backdrop'), backdrop)
    Object.assign(backdrop.style, { position: 'fixed', inset: '0', zIndex: '2147483646' })
    const box = source.getBoundingClientRect()
    Object.assign(clone.style, { position: 'fixed', inset: 'auto', left: `${box.left}px`, top: `${box.top}px`,
      width: `${box.width}px`, height: `${box.height}px`, boxSizing: 'border-box', margin: '0',
      transform: 'none', translate: 'none', zIndex: '2147483647' })
    content.append(backdrop, clone)
  }
  let animationCss = ''
  let serializedDirty = false
  if (cached) {
    const restyled = cached.restyle
    for (const [index, node] of cached.nodes.entries()) {
      const properties = animationProperties.get(node.source)?.get(node.pseudo ?? '')
      const restyle = [...restyled].some(source => source === node.source || source.contains(node.source))
      if (!properties && !restyle) continue
      const style = view.getComputedStyle(node.source, node.pseudo)
      if (restyle) {
        copyStyle(style, node.clone, node.pseudo ? undefined : node.source)
        serializedDirty = true
      }
      if (properties) {
        const declarations = [...properties].map((property) => {
          const cssProperty = property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
          return `${cssProperty}:${style.getPropertyValue(cssProperty)}!important;`
        })
        animationCss += `[data-run-vod-node="${index}"]{${declarations.join('')}}`
      }
      if (node.pseudo) node.clone.style.content = 'normal'
      else if (node.source.scrollLeft || node.source.scrollTop) node.clone.style.overflow = 'hidden'
      const parent = node.pseudo ? node.source : node.source.parentElement
      if (parent && (parent.scrollLeft || parent.scrollTop) && !node.source.matches(':modal')) {
        const transform = node.clone.style.transform
        node.clone.style.transform = `translate(${-parent.scrollLeft}px, ${-parent.scrollTop}px) ${transform === 'none' ? '' : transform}`
      }
    }
    cached.restyle.clear()
    for (const { source, clone } of cached.images) {
      const src = source.currentSrc || source.src
      if (src) pending.push(imageAt(source, src, at!).then((value) => {
        if (clone.getAttribute('src') !== value) {
          clone.setAttribute('src', value)
          serializedDirty = true
        }
      }))
    }
  }
  if (element !== doc.body) {
    Object.assign(content.style, { position: 'absolute', left: '0', top: '0', margin: '0', transform: 'none',
      translate: 'none', rotate: 'none', scale: 'none', width: `${width}px`, height: `${height}px` })
  }
  content.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml')
  content.classList.add('run-vod-snapshot')
  let baseCss = cached?.baseCss ?? ''
  if (!cached) {
    const style = doc.createElement('style')
    const animation = doc.createElement('style')
    animation.dataset.runVodAnimation = ''
    animation.textContent = animationMarker
    // A per-node `all` shorthand expands into hundreds of declarations when
    // resource URLs are assigned. One scoped rule avoids megabytes per frame.
    const rules = [...styleClasses].map(([css, index]) =>
      `.run-vod-snapshot[data-run-vod-style="${index}"],.run-vod-snapshot [data-run-vod-style="${index}"]{${css}}`).join('\n')
    baseCss = `.run-vod-snapshot,.run-vod-snapshot :not(style){all:initial}\n${await fontCss(doc)}`
    style.textContent = `${baseCss}\n${rules}`
    content.prepend(style, animation)
  }
  await Promise.all(pending)
  let snapshot: RasterCache | undefined
  if (!cached && element === doc.body && at !== undefined) {
    snapshots.get(doc)?.observer.disconnect()
    const mutations = (records: MutationRecord[]) => {
      for (const record of records) {
        const source = record.target
        if (source instanceof view.Element && source.matches('[data-run-vod-native-raster]')) continue
        if (record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].every(node =>
          node instanceof view.Element && node.matches('[data-run-vod-native-raster]'))) continue
        if (source instanceof view.Element) {
          const closedDialog = source.closest('dialog:not([open])')
          // The card-collection controls remain mounted in closed dialogs.
          // Their React bookkeeping cannot affect a frame until the dialog opens.
          if (closedDialog && !(source === closedDialog && record.attributeName === 'open')) continue
          // The cloned image omits this loading hint; it is not painted and
          // must not rebuild an otherwise unchanged scene.
          if (source instanceof view.HTMLImageElement && record.attributeName === 'loading') continue
        }
        if (record.type === 'attributes' && source instanceof view.Element) {
          if (record.oldValue === source.getAttribute(record.attributeName!)) continue
          // These absolute overlays move without affecting sibling layout.
          // Re-style their subtree instead of rebuilding the entire scene.
          if (record.attributeName === 'style' && source.matches('.enemy__hit-area, .combat-vfx--target') &&
            view.getComputedStyle(source).position === 'absolute') {
            const before = doc.createElement('span').style
            before.cssText = record.oldValue ?? ''
            const after = (source as HTMLElement).style
            const changed = new Set([...before, ...after].filter(property => before.getPropertyValue(property) !== after.getPropertyValue(property)))
            if ([...changed].every(property => /^(left|top|width|height|--vfx-center-[xy]|--lightning-(center-x|ground-y|height))$/.test(property))) {
              snapshot!.restyle.add(source)
              continue
            }
          }
        }
        snapshot!.dirty = true
      }
    }
    const observer = new MutationObserver(mutations)
    const styles = [...styleClasses.keys()]
    snapshot = { content, nodes, images, observer, viewport, scroll, dirty: false, animations: new Set(animations),
      restyle: new Set(), serialized: '', baseCss, styles, layoutStyles: styles.map(layoutStyle), mutations }
    observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeOldValue: true, characterData: true })
    snapshots.set(doc, snapshot)
  }
  const region = crop && element === doc.body ? crop : undefined
  const serializable = region && (cached ?? snapshot) ? croppedContent((cached ?? snapshot)!, element, region) : content
  const template = !region && cached?.serialized && !serializedDirty
    ? cached.serialized
    : new XMLSerializer().serializeToString(serializable)
  if (snapshot && !region) snapshot.serialized = template
  else if (cached && serializedDirty) cached.serialized = region ? '' : template
  const serialized = template.replace(animationMarker, animationCss)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${region?.width ?? width}" height="${region?.height ?? height}"><foreignObject x="${region ? -region.x : 0}" y="${region ? -region.y : 0}" width="${width}" height="${height}">${serialized}</foreignObject></svg>`
  prepared?.()
  const image = await decodeRaster(doc, svg, region?.width ?? width, region?.height ?? height, element === doc.body)
  try {
    const canvas = doc.createElement('canvas')
    canvas.width = region?.width ?? width
    canvas.height = region?.height ?? height
    canvas.getContext('2d', { willReadFrequently: readback })!.drawImage(image, 0, 0)
    return canvas
  } finally { image.close() }
}
