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
const imageStarts = new WeakMap<HTMLImageElement, { src: string; at: number }>()
const decodedFrames = new WeakMap<FrameDecoder, { index: number; start: number; end: number; url: string }>()
const imageDurations = new WeakMap<FrameDecoder, number>()
type StyledClone = { source: Element; clone: HTMLElement | SVGElement; pseudo?: '::before' | '::after' }
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
  mutations: (records: MutationRecord[]) => void
}
const snapshots = new Map<Document, RasterCache>()

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
  let start = imageStarts.get(image)
  if (!start || start.src !== src) {
    start = { src, at: now }
    imageStarts.set(image, start)
  }
  let elapsed = Math.max(0, now - start.at) * 1_000
  const duration = imageDurations.get(decoded)
  if (duration && decoded.tracks.selectedTrack.repetitionCount > 0) elapsed %= duration
  let last = decodedFrames.get(decoded)
  if (last && elapsed < last.end && elapsed >= last.start) return last.url
  let index = last && elapsed >= last.end ? last.index + 1 : 0
  let end = index > 0 ? last!.end : 0
  while (index < decoded.tracks.selectedTrack.frameCount) {
    const { image: frame } = await decoded.decode({ frameIndex: index })
    const began = end
    end += frame.duration ?? 33_333
    if (index === decoded.tracks.selectedTrack.frameCount - 1) imageDurations.set(decoded, end)
    if (end > elapsed || index === decoded.tracks.selectedTrack.frameCount - 1) {
      const canvas = document.createElement('canvas')
      canvas.width = frame.displayWidth
      canvas.height = frame.displayHeight
      canvas.getContext('2d')!.drawImage(frame, 0, 0)
      frame.close()
      last = { index, start: began, end, url: canvas.toDataURL() }
      canvas.width = canvas.height = 0
      decodedFrames.set(decoded, last)
      return last.url
    }
    frame.close()
    index++
  }
  return last!.url
}

// Call only after the event's raster jobs have drained. Native decoders can
// retain every decoded animation frame even after its DOM image disappears.
export async function pruneRunVodRaster(doc: Document) {
  const active = new Set([...doc.images].map(image => image.currentSrc || image.src))
  const decoders = documentDecoders.get(doc)
  if (!decoders) return
  for (const [src, decoder] of decoders) if (!active.has(src)) {
    ;(await decoder)?.close()
    decoders.delete(src)
  }
  const allActive = new Set([...snapshots.keys()].flatMap(document => [...document.images].map(image => image.currentSrc || image.src)))
  for (const src of resources.keys()) if (src.startsWith('blob:') && !allActive.has(src)) {
    resources.delete(src); sizedImages.delete(src)
  }
}

export async function releaseRunVodRaster(doc?: Document) {
  for (const document of doc ? [doc] : new Set([...snapshots.keys(), ...documentDecoders.keys()])) {
    snapshots.get(document)?.observer.disconnect()
    snapshots.delete(document)
    for (const decoder of documentDecoders.get(document)?.values() ?? []) {
      try { (await decoder)?.close() } catch { /* Preserve the original artwork error. */ }
    }
    documentDecoders.delete(document)
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

export async function rasterRunVod(element: HTMLElement, width: number, height: number, at?: number, prepared?: () => void, readback = false) {
  const doc = element.ownerDocument
  const view = doc.defaultView!
  await doc.fonts.ready
  const defaults = initialStyle(doc)
  const viewport = `${view.innerWidth}:${view.innerHeight}`
  const scroll = [element, ...element.querySelectorAll('*')]
    .map((node, index) => node.scrollTop || node.scrollLeft ? `${index}:${node.scrollLeft}:${node.scrollTop}` : '').filter(Boolean).join(';')
  const animations = doc.getAnimations().map((animation) => animation.effect).filter((effect): effect is KeyframeEffect =>
    effect instanceof view.KeyframeEffect)
  // These properties change painting, not sibling layout. Layout animations
  // still take a fresh snapshot so reflow remains faithful to the live page.
  const paintOnly = /^(offset|easing|composite|computedOffset|transform|translate|rotate|scale|opacity|filter|clipPath|boxShadow|textShadow|backgroundColor|backgroundPositionX|backgroundPositionY|strokeDashoffset|offsetDistance)$/
  const animationProperties = new Map<Element, Map<string, Set<string>>>()
  for (const effect of animations) {
    if (!(effect.target instanceof view.Element)) continue
    const pseudo = effect.pseudoElement ?? ''
    let byPseudo = animationProperties.get(effect.target)
    if (!byPseudo) { byPseudo = new Map(); animationProperties.set(effect.target, byPseudo) }
    let properties = byPseudo.get(pseudo)
    if (!properties) { properties = new Set(); byPseudo.set(pseudo, properties) }
    for (const frame of effect.getKeyframes()) for (const property of Object.keys(frame)) {
      if (paintOnly.test(property) && !/^(offset|easing|composite|computedOffset)$/.test(property)) properties.add(property)
    }
  }
  let cached = element === doc.body && at !== undefined ? snapshots.get(doc) : undefined
  cached?.mutations(cached.observer.takeRecords())
  if (cached && (cached.dirty || cached.viewport !== viewport || cached.scroll !== scroll ||
    [...cached.animations].some((effect) => !animations.includes(effect)) ||
    animations.some((effect) => effect.getKeyframes().some((frame) => Object.keys(frame).some((key) => !paintOnly.test(key)))))) {
    cached.observer.disconnect()
    snapshots.delete(doc)
    cached = undefined
  }
  if (cached) for (const effect of animations) cached.animations.add(effect)
  const nodes: StyledClone[] = []
  const images: RasterCache['images'] = []
  const pending: Promise<unknown>[] = []
  const modals: { source: Element; clone: HTMLElement | SVGElement }[] = []
  const copyStyle = (style: CSSStyleDeclaration, clone: HTMLElement | SVGElement, source?: Element) => {
    const declarations: string[] = []
    for (const property of style) {
      if (property.startsWith('--') || property.startsWith('animation') || property.startsWith('transition') || property === 'cursor') continue
      const value = style.getPropertyValue(property)
      if (defaults.get(property) === value) continue
      declarations.push(`${property}:${value};`)
      if (value.includes('url(')) pending.push(inlineUrls(value, doc.baseURI).then((result) => clone.style.setProperty(property, result)))
    }
    clone.style.cssText = `${declarations.join('')}animation:none!important;transition:none!important;`
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
    nodes.push({ source, clone, pseudo: kind })
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
    nodes.push({ source, clone })
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
  if (!cached) {
    const style = doc.createElement('style')
    const animation = doc.createElement('style')
    animation.textContent = animationMarker
    // A per-node `all` shorthand expands into hundreds of declarations when
    // resource URLs are assigned. One scoped rule avoids megabytes per frame.
    style.textContent = `.run-vod-snapshot,.run-vod-snapshot :not(style){all:initial}\n${await fontCss(doc)}`
    content.prepend(style, animation)
  }
  await Promise.all(pending)
  let snapshot: RasterCache | undefined
  if (!cached && element === doc.body && at !== undefined) {
    snapshots.get(doc)?.observer.disconnect()
    const mutations = (records: MutationRecord[]) => {
      for (const record of records) {
        const source = record.target
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
    snapshot = { content, nodes, images, observer, viewport, scroll, dirty: false, animations: new Set(animations),
      restyle: new Set(), serialized: '', mutations }
    observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeOldValue: true, characterData: true })
    snapshots.set(doc, snapshot)
  }
  const template = cached?.serialized && !serializedDirty
    ? cached.serialized
    : new XMLSerializer().serializeToString(content)
  if (snapshot) snapshot.serialized = template
  else if (cached && serializedDirty) cached.serialized = template
  const serialized = template.replace(animationMarker, animationCss)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject width="100%" height="100%">${serialized}</foreignObject></svg>`
  const image = new Image()
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  prepared?.()
  try {
    await image.decode()
    const canvas = doc.createElement('canvas')
    canvas.width = width
    canvas.height = height
    canvas.getContext('2d', { willReadFrequently: readback })!.drawImage(image, 0, 0)
    return canvas
  } finally { image.removeAttribute('src') }
}
