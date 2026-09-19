import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { RunState } from '../game/run.ts'

const RUN_VOD_KEY = 'sts-run-vod'
const RUN_VOD_DATABASE = 'sts-run-vod-v2'
const CONTROL = 'button, input, select, textarea, summary, [role="button"]'
const READ_ONLY = '.map-peek, .map-peek__open, .card-collection, .compendium, .deck-peek__open, .game-settings, .settings-dialog, [data-pile], .room:not(.room--reachable)'
export const RUN_VOD_WIDTH = 1920
export const RUN_VOD_HEIGHT = 1080
export const RUN_VOD_FPS = 120
export const RUN_VOD_CURSOR_MS = 150
export const RUN_VOD_REPEAT_CLICK_MS = 250
export const RUN_VOD_REPLAY = new URLSearchParams(location.search).get('run-vod') === '1'

type Point = { x: number; y: number }
type ControlRef = { selector: string; name?: string; value?: string; checked?: boolean; drag?: true; target?: true }
type RunVodChoice = { source: ControlRef; steps?: ControlRef[]; target?: ControlRef }
type RunVodPatch = { path: (string | number)[]; value?: unknown; remove?: true }
export type RunVodEvent = { patch: RunVodPatch[]; choice?: RunVodChoice; viewerId?: string }
export type RunVodLog = { version: 2; runId: string; initial: RunState; events: RunVodEvent[] }
const CANCEL_CHOICE = /^(cancel|close|back(?: to (?:choices|run))?)$/i

export type RunVodBridge = {
  getRun: () => RunState
  setRun: (next: RunState) => void
  setViewer: (id: string) => void
  startVodAudio: () => MediaStream
  setVodAudioMuted: (muted: boolean) => void
  stopVodAudio: () => void
  playVodUiSound: () => void
  getSettings: () => { bgmVolume: number; sfxVolume: number }
}

function point(element: Element, clientX = 0, clientY = 0): Point {
  const box = element.getBoundingClientRect()
  const view = element.ownerDocument.defaultView ?? window
  return {
    x: Math.max(0, Math.min(1, (clientX || box.left + box.width / 2) / view.innerWidth)),
    y: Math.max(0, Math.min(1, (clientY || box.top + box.height / 2) / view.innerHeight)),
  }
}

function selector(element: Element): string {
  for (const attribute of ['data-enemy-id', 'data-player-id', 'data-room', 'data-event-option', 'data-orb-slot']) {
    const value = element.getAttribute(attribute)
    if (value !== null) return `[${attribute}="${CSS.escape(value)}"]`
  }
  const parts: string[] = []
  for (let current: Element | null = element; current && current !== document.documentElement; current = current.parentElement) {
    if (current.id) {
      parts.unshift(`#${CSS.escape(current.id)}`)
      break
    }
    const parent = current.parentElement
    const siblings = parent ? [...parent.children].filter((candidate) => candidate.tagName === current!.tagName) : []
    const position = siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : ''
    parts.unshift(`${current.tagName.toLowerCase()}${position}`)
    if (current.matches('.app-shell, dialog')) break
  }
  return parts.join(' > ')
}

function controlRef(element: HTMLElement): ControlRef {
  const name = element.getAttribute('aria-label')?.trim() || element.textContent?.trim()
  const input = element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
  return {
    selector: selector(element), ...(name ? { name } : {}),
    ...('value' in input ? { value: input.value } : {}),
    ...(input instanceof HTMLInputElement && ['checkbox', 'radio'].includes(input.type) ? { checked: input.checked } : {}),
    ...(element.matches('.hand .card, [data-orb-slot], .end-turn-effect--orb') ? { drag: true as const } : {}),
    ...(element.closest('[data-enemy-id], [data-player-id]') ? { target: true as const } : {}),
  }
}

let memoryLog: RunVodLog | null = null
let persistence = Promise.resolve()
let database: Promise<IDBDatabase | null> | null = null

const requested = <T,>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  request.addEventListener('success', () => resolve(request.result), { once: true })
  request.addEventListener('error', () => reject(request.error), { once: true })
})

const committed = (transaction: IDBTransaction) => new Promise<void>((resolve, reject) => {
  transaction.addEventListener('complete', () => resolve(), { once: true })
  transaction.addEventListener('error', () => reject(transaction.error), { once: true })
  transaction.addEventListener('abort', () => reject(transaction.error), { once: true })
})

function runVodDatabase() {
  if (database) return database
  database = new Promise((resolve) => {
    const request = indexedDB.open(RUN_VOD_DATABASE, 1)
    request.addEventListener('upgradeneeded', () => {
      request.result.createObjectStore('runs', { keyPath: 'runId' })
      request.result.createObjectStore('events', { keyPath: ['runId', 'index'] })
    }, { once: true })
    request.addEventListener('success', () => resolve(request.result), { once: true })
    request.addEventListener('error', () => resolve(null), { once: true })
  })
  return database
}

const eventRange = (runId: string) => IDBKeyRange.bound([runId, 0], [runId, Number.MAX_SAFE_INTEGER])

async function persistedLog(runId: string): Promise<RunVodLog | null> {
  if (memoryLog?.runId === runId) return memoryLog
  const db = await runVodDatabase()
  if (!db) return null
  try {
    const transaction = db.transaction(['runs', 'events'], 'readonly')
    const run = await requested(transaction.objectStore('runs').get(runId)) as Omit<RunVodLog, 'events'> | undefined
    if (!run || run.version !== 2 || run.initial?.campaign.runId !== runId) return null
    const rows = await requested(transaction.objectStore('events').getAll(eventRange(runId))) as
      { runId: string; index: number; event: RunVodEvent }[]
    memoryLog = { ...run, events: rows.sort((a, b) => a.index - b.index).map((row) => row.event) }
    return memoryLog
  } catch {
    return null
  }
}

export const readRunVod = (runId: string) => persistence.then(() => persistedLog(runId))

async function persistStart(log: RunVodLog) {
  const db = await runVodDatabase()
  if (!db) return
  const transaction = db.transaction(['runs', 'events'], 'readwrite')
  transaction.objectStore('runs').put({ version: log.version, runId: log.runId, initial: log.initial })
  transaction.objectStore('events').delete(eventRange(log.runId))
  await committed(transaction)
}

async function persistEvent(runId: string, index: number, event: RunVodEvent) {
  const db = await runVodDatabase()
  if (!db) return
  const transaction = db.transaction('events', 'readwrite')
  transaction.objectStore('events').put({ runId, index, event })
  await committed(transaction)
}

export async function startRunVod(run: RunState) {
  const log: RunVodLog = {
    version: 2, runId: run.campaign.runId, initial: structuredClone(run), events: [],
  }
  memoryLog = log
  try { localStorage.setItem(RUN_VOD_KEY, log.runId) } catch {}
  persistence = persistence.catch(() => {}).then(() => persistStart(log))
  try { await persistence; return true } catch { return false }
}

function statePatch(before: unknown, after: unknown, path: (string | number)[] = [], result: RunVodPatch[] = []): RunVodPatch[] {
  if (Object.is(before, after)) return result
  if (before === null || after === null || typeof before !== 'object' || typeof after !== 'object' || Array.isArray(before) !== Array.isArray(after)) {
    result.push({ path, value: structuredClone(after) })
    return result
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    if (['deck', 'draw', 'hand', 'discard', 'exhaust'].includes(String(path.at(-1)))) {
      if (JSON.stringify(before) === JSON.stringify(after)) return result
      result.push({ path, value: structuredClone(after) })
      return result
    }
    for (let index = 0; index < Math.min(before.length, after.length); index += 1) {
      statePatch(before[index], after[index], [...path, index], result)
    }
    for (let index = before.length; index < after.length; index += 1) {
      result.push({ path: [...path, index], value: structuredClone(after[index]) })
    }
    for (let index = before.length - 1; index >= after.length; index -= 1) {
      result.push({ path: [...path, index], remove: true })
    }
    return result
  }
  const left = before as Record<string, unknown>
  const right = after as Record<string, unknown>
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    if (!(key in right)) result.push({ path: [...path, key], remove: true })
    else statePatch(left[key], right[key], [...path, key], result)
  }
  return result
}

export function applyRunVodEvent(run: RunState, event: RunVodEvent): RunState {
  const next = structuredClone(run) as unknown
  for (const change of event.patch) {
    if (change.path.length === 0) return structuredClone(change.value) as RunState
    let owner = next as Record<string | number, unknown>
    for (const [index, part] of change.path.slice(0, -1).entries()) {
      if (!owner[part] || typeof owner[part] !== 'object') {
        owner[part] = typeof change.path[index + 1] === 'number' ? [] : {}
      }
      owner = owner[part] as Record<string | number, unknown>
    }
    const key = change.path.at(-1)!
    if (change.remove) {
      if (Array.isArray(owner)) owner.splice(Number(key), 1)
      else delete owner[key]
    } else owner[key] = structuredClone(change.value)
  }
  return next as RunState
}

export function discardRunVod(runId?: string) {
  const currentRunId = memoryLog?.runId ?? (() => {
    try { return localStorage.getItem(RUN_VOD_KEY) } catch { return null }
  })()
  if (!runId || currentRunId === runId) {
    memoryLog = null
    try { localStorage.removeItem(RUN_VOD_KEY) } catch { /* Storage is unavailable. */ }
    if (currentRunId) persistence = persistence.then(async () => {
      const db = await runVodDatabase()
      if (!db) return
      const transaction = db.transaction(['runs', 'events'], 'readwrite')
      transaction.objectStore('runs').delete(currentRunId)
      transaction.objectStore('events').delete(eventRange(currentRunId))
      await committed(transaction)
    })
  }
}

function gameplayControl(target: EventTarget | null): HTMLElement | null {
  const element = target instanceof Element ? target.closest<HTMLElement>(CONTROL) : null
  if (!element || element.closest('[data-run-vod-control], .settings-dialog')) return null
  if (element.closest(READ_ONLY)) return null
  if (element.closest('.pause-menu') && element.textContent?.trim() !== 'Give up') return null
  return element
}

export function useRunVod(run: RunState, active: boolean, viewerId: string, expected: RunState = run) {
  const log = useRef<RunVodLog | null>(null)
  const previous = useRef<RunState | null>(null)
  const pendingChoice = useRef<RunVodChoice | null>(null)
  const queuedEvents = useRef<RunVodEvent[]>([])
  const hydrationRun = useRef<string | null>(null)
  const hydrationGeneration = useRef(0)
  const [available, setAvailable] = useState(false)
  const [logReady, setLogReady] = useState(false)

  useLayoutEffect(() => {
    if (!active) return
    const runId = run.campaign.runId
    if (hydrationRun.current === runId) return
    hydrationRun.current = runId
    const generation = ++hydrationGeneration.current
    previous.current = structuredClone(run)
    pendingChoice.current = null
    queuedEvents.current = []
    setLogReady(false)
    void persistedLog(runId).then((current) => {
      if (hydrationGeneration.current !== generation || hydrationRun.current !== runId) return
      log.current = current?.runId === runId ? current : null
      const restored = log.current?.events.reduce(applyRunVodEvent, structuredClone(log.current.initial))
      setAvailable(Boolean(restored && stableRunJson(restored) === stableRunJson(expected)))
      setLogReady(true)
    })
  }, [active, run.campaign.runId])

  useLayoutEffect(() => {
    if (expected === run) return
    const restored = log.current?.events.reduce(applyRunVodEvent, structuredClone(log.current.initial))
    setAvailable(Boolean(active && restored && stableRunJson(restored) === stableRunJson(expected)))
  }, [active, expected, run])

  useLayoutEffect(() => {
    const before = previous.current ?? structuredClone(run)
    if (before.campaign.runId !== run.campaign.runId) {
      previous.current = structuredClone(run)
      pendingChoice.current = null
      return
    }
    if (!active) {
      previous.current = structuredClone(run)
      return
    }
    if (logReady && log.current?.runId === run.campaign.runId && queuedEvents.current.length > 0) {
      for (const event of queuedEvents.current.splice(0)) {
        const index = log.current.events.push(event) - 1
        persistence = persistence.then(() => persistEvent(run.campaign.runId, index, event))
          .catch(() => setAvailable(false))
      }
      const restored = log.current.events.reduce(applyRunVodEvent, structuredClone(log.current.initial))
      setAvailable(stableRunJson(restored) === stableRunJson(expected))
    }
    if (run.campaign.finalized) {
      previous.current = structuredClone(run)
      return
    }
    const patch = statePatch(before, run)
    previous.current = structuredClone(run)
    if (patch.length === 0) return
    const staged = pendingChoice.current
    const lastStep = staged?.steps?.at(-1)
    const choice = staged?.source.drag && !staged.target && lastStep?.target
      ? { ...staged, steps: staged.steps?.slice(0, -1), target: lastStep }
      : staged
    const event = { patch, ...(choice ? { choice } : {}), viewerId }
    pendingChoice.current = null
    if (!logReady || !log.current || log.current.runId !== run.campaign.runId) {
      queuedEvents.current.push(event)
      setAvailable(false)
      return
    }
    const index = log.current.events.push(event) - 1
    setAvailable(expected === run || stableRunJson(run) === stableRunJson(expected))
    persistence = persistence.then(() => persistEvent(run.campaign.runId, index, event))
      .catch(() => setAvailable(false))
  }, [active, expected, logReady, run, viewerId])

  useLayoutEffect(() => {
    if (!active || run.campaign.finalized) return
    let down: ControlRef | null = null
    const append = (ref: ControlRef) => {
      const current = pendingChoice.current
      if (!current) return void (pendingChoice.current = { source: ref })
      const last = current.steps?.at(-1) ?? current.source
      if (last.selector === ref.selector) {
        pendingChoice.current = current.steps?.length
          ? { ...current, steps: [...current.steps.slice(0, -1), ref] }
          : { ...current, source: ref }
        return
      }
      pendingChoice.current = {
        source: current.source, steps: [...(current.steps ?? []), ref], ...(current.target ? { target: current.target } : {}),
      }
    }
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest(READ_ONLY)) {
        pendingChoice.current = null
        down = null
        return
      }
      const rawControl = event.target instanceof Element ? event.target.closest<HTMLElement>(CONTROL) : null
      if (rawControl?.closest('.pause-menu') && rawControl.textContent?.trim() !== 'Give up') {
        pendingChoice.current = null
        down = null
        return
      }
      const control = gameplayControl(event.target)
      down = control ? controlRef(control) : null
    }
    const onPointerUp = (event: PointerEvent) => {
      const control = gameplayControl(document.elementFromPoint(event.clientX, event.clientY)) ?? gameplayControl(event.target)
      if (!down) return
      const targetRef = control ? controlRef(control) : null
      if (CANCEL_CHOICE.test(targetRef?.name ?? '')) {
        pendingChoice.current = null
        down = null
        return
      }
      const staged = pendingChoice.current
      const last = staged?.steps?.at(-1) ?? staged?.source
      if (targetRef && targetRef.selector !== down.selector) {
        pendingChoice.current = last?.selector === down.selector
          ? { source: staged!.source, ...(staged!.steps ? { steps: staged!.steps } : {}), target: targetRef }
          : { source: staged?.source ?? down, ...(staged ? { steps: [...(staged.steps ?? []), down] } : {}), target: targetRef }
      } else append(down)
      down = null
    }
    const onPointerCancel = () => {
      down = null
      pendingChoice.current = null
    }
    const onClick = (event: MouseEvent) => {
      if (event.detail > 0) return
      if (event.target instanceof Element && event.target.closest(READ_ONLY)) {
        pendingChoice.current = null
        return
      }
      const control = gameplayControl(event.target)
      if (!control) return
      const ref = controlRef(control)
      if (CANCEL_CHOICE.test(ref.name ?? '')) pendingChoice.current = null
      else append(ref)
    }
    const onChange = (event: Event) => {
      const control = gameplayControl(event.target)
      if (control) append(controlRef(control))
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        pendingChoice.current = null
      }
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('pointerup', onPointerUp, true)
    document.addEventListener('pointercancel', onPointerCancel, true)
    document.addEventListener('click', onClick, true)
    document.addEventListener('change', onChange, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('pointerup', onPointerUp, true)
      document.removeEventListener('pointercancel', onPointerCancel, true)
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('change', onChange, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [active, run.campaign.finalized, run.campaign.runId])

  const load = useCallback(async () => {
    try { await persistence } catch { return null }
    const current = log.current ?? await persistedLog(run.campaign.runId)
    return current?.runId === run.campaign.runId ? current : null
  }, [run.campaign.runId])
  const discard = useCallback(() => {
    discardRunVod(run.campaign.runId)
    log.current = null
    setAvailable(false)
  }, [run.campaign.runId])
  return { available, discard, load }
}

export const stableRunJson = (run: RunState) => JSON.stringify(run, (_key, value) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
    : value)

function firstDifference(left: unknown, right: unknown, path = 'run'): string {
  if (Object.is(left, right)) return ''
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return `${path}: ${JSON.stringify(left)} != ${JSON.stringify(right)}`
  const a = left as Record<string, unknown>
  const b = right as Record<string, unknown>
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const difference = firstDifference(a[key], b[key], `${path}.${key}`)
    if (difference) return difference
  }
  return `${path}: values differ`
}

function queryControl(doc: Document, ref: ControlRef): HTMLElement | null {
  const visible = (element: HTMLElement | null) => {
    if (!element) return null
    const view = element.ownerDocument.defaultView
    let box = element.getBoundingClientRect()
    if (box.width <= 0 || box.height <= 0 || view?.getComputedStyle(element).visibility === 'hidden') return null
    if (box.left < 0 || box.top < 0 || box.right > (view?.innerWidth ?? 0) || box.bottom > (view?.innerHeight ?? 0)) {
      element.scrollIntoView({ block: 'center', inline: 'center' })
      box = element.getBoundingClientRect()
    }
    return box.right > 0 && box.bottom > 0 && box.left < (view?.innerWidth ?? 0) && box.top < (view?.innerHeight ?? 0)
      ? element : null
  }
  try {
    const exact = visible(doc.querySelector<HTMLElement>(ref.selector))
    if (exact) return exact
  } catch { /* Fall through to the semantic name. */ }
  if (!ref.name) return null
  return [...doc.querySelectorAll<HTMLElement>(CONTROL)].find((element) =>
    visible(element) && (element.getAttribute('aria-label')?.trim() === ref.name || element.textContent?.trim() === ref.name)) ?? null
}

type VodActionGeometry = {
  frame?: string
  background?: string
  sprite?: string
  source: { x: number; y: number; width: number; height: number }
  from: Point
  to: Point
  drag: boolean
}

type VodGeometry = {
  actions: VodActionGeometry[]
  motion: { key: string; at: number }[]
}

type SnapshotStore = {
  write: (key: string | number, canvas: HTMLCanvasElement) => Promise<void>
  read: (key: string | number) => Promise<ImageBitmap>
  video: (extension: string) => Promise<FileSystemWritableFileStream | null>
  videoFile: (extension: string) => Promise<File | null>
  cleanup: () => Promise<void>
}

async function snapshotStore(runId: string): Promise<SnapshotStore> {
  const memory: Record<string, Blob> = {}
  const name = `run-vod-${runId.replace(/[^a-z0-9-]/gi, '')}-${Date.now()}`
  let root: FileSystemDirectoryHandle | null = null
  let openVideo: FileSystemWritableFileStream | null = null
  try {
    const storage = await navigator.storage.getDirectory()
    const entries = (storage as FileSystemDirectoryHandle & { keys(): AsyncIterableIterator<string> }).keys()
    for await (const entry of entries) {
      const timestamp = Number(entry.match(/^run-vod-.*-(\d+)$/)?.[1])
      if (timestamp && Date.now() - timestamp > 60 * 60 * 1_000) {
        try { await storage.removeEntry(entry, { recursive: true }) } catch {}
      }
    }
    root = await storage.getDirectoryHandle(name, { create: true })
  } catch { /* A short replay can still use the in-memory fallback. */ }
  const blob = (canvas: HTMLCanvasElement) => new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((value) => value ? resolve(value) : reject(new Error('Could not rasterize a Run VOD frame.')), 'image/webp', .94))
  return {
    async write(key, canvas) {
      const value = await blob(canvas)
      if (!root) return void (memory[String(key)] = value)
      const writable = await (await root.getFileHandle(`${key}.webp`, { create: true })).createWritable()
      await writable.write(value)
      await writable.close()
    },
    async read(key) {
      const value = root
        ? await (await root.getFileHandle(`${key}.webp`)).getFile()
        : memory[String(key)]
      if (!value) throw new Error(`Run VOD frame ${key} is missing.`)
      return createImageBitmap(value)
    },
    async video(extension) {
      openVideo = root ? await (await root.getFileHandle(`vod.${extension}`, { create: true })).createWritable() : null
      return openVideo
    },
    async videoFile(extension) {
      return root ? (await root.getFileHandle(`vod.${extension}`)).getFile() : null
    },
    async cleanup() {
      if (openVideo) {
        try { await openVideo.abort() } catch {}
        openVideo = null
      }
      if (!root) return
      try { await (await navigator.storage.getDirectory()).removeEntry(name, { recursive: true }) } catch {}
    },
  }
}

function replayFrame() {
  const workbench = document.createElement('section')
  workbench.className = 'run-vod-workbench'
  workbench.dataset.runVodControl = ''
  const status = document.createElement('p')
  status.className = 'run-vod-workbench__status'
  status.setAttribute('role', 'status')
  status.textContent = 'Preparing the canonical 1920×1080 replay…'
  const iframe = document.createElement('iframe')
  iframe.className = 'run-vod-workbench__frame'
  iframe.title = 'Run VOD replay'
  iframe.width = String(RUN_VOD_WIDTH)
  iframe.height = String(RUN_VOD_HEIGHT)
  const url = new URL(location.href)
  url.searchParams.set('run-vod', '1')
  url.hash = ''
  iframe.src = url.href
  workbench.append(iframe, status)
  document.body.append(workbench)
  const scale = Math.min(innerWidth / RUN_VOD_WIDTH, innerHeight / RUN_VOD_HEIGHT)
  iframe.style.transform = `translate(-50%, -50%) scale(${scale})`
  return { workbench, iframe, status }
}

async function bridgeFor(iframe: HTMLIFrameElement): Promise<RunVodBridge> {
  const deadline = performance.now() + 20_000
  while (performance.now() < deadline) {
    const bridge = (iframe.contentWindow as Window & { __STS_DEBUG__?: RunVodBridge } | null)?.__STS_DEBUG__
    if (bridge) return bridge
    await new Promise((resolve) => window.setTimeout(resolve, 50))
  }
  throw new Error('The canonical Run VOD renderer did not finish loading.')
}

async function waitForControl(ref: ControlRef, doc: Document) {
  const deadline = performance.now() + 15_000
  let source = queryControl(doc, ref)
  if (!source && ref.name === 'Give up') {
    doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  }
  while (!source && performance.now() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, 50))
    source = queryControl(doc, ref)
  }
  return source
}

async function settle(doc: Document, minimum = 180, maximum = 3_000) {
  const started = performance.now()
  do {
    await new Promise((resolve) => window.setTimeout(resolve, 50))
    const animating = doc.getAnimations().some((animation) => {
      const timing = animation.effect?.getComputedTiming()
      return animation.playState === 'running' && Number.isFinite(Number(timing?.iterations)) && Number(timing?.endTime ?? 0) <= maximum
    })
    if (performance.now() - started >= minimum && !animating) return
  } while (performance.now() - started < maximum)
}

function presentationAnimating(doc: Document, maximum = 3_000) {
  return doc.getAnimations().some((animation) => {
    const timing = animation.effect?.getComputedTiming()
    return animation.playState === 'running' && Number.isFinite(Number(timing?.iterations)) && Number(timing?.endTime ?? 0) <= maximum
  })
}

async function mediaReady(doc: Document) {
  await doc.fonts.ready
  await Promise.all([...doc.images].map((image) => image.complete ? image.decode().catch(() => {}) : new Promise<void>((resolve) => {
    image.addEventListener('load', () => resolve(), { once: true })
    image.addEventListener('error', () => resolve(), { once: true })
  })))
}

async function raster(doc: Document) {
  const { default: html2canvas } = await import('html2canvas')
  await mediaReady(doc)
  return html2canvas(doc.body, {
    backgroundColor: '#080b12', logging: false, useCORS: true, scale: 1,
    width: RUN_VOD_WIDTH, height: RUN_VOD_HEIGHT, windowWidth: RUN_VOD_WIDTH, windowHeight: RUN_VOD_HEIGHT,
  })
}

async function rasterElement(element: HTMLElement) {
  const { default: html2canvas } = await import('html2canvas')
  return html2canvas(element, { backgroundColor: null, logging: false, useCORS: true, scale: 1 })
}

async function captureMotion(doc: Document, store: SnapshotStore, eventIndex: number) {
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  const quietWindow = doc.querySelector('.card-morph') ? 1_500 : 300
  const maximum = doc.querySelector('.card-morph') ? 15_000 : 12_000
  const discoveryStarted = performance.now()
  while (!presentationAnimating(doc, maximum) && performance.now() - discoveryStarted < quietWindow) {
    await new Promise((resolve) => window.setTimeout(resolve, 16))
  }
  if (!presentationAnimating(doc, maximum)) {
    await settle(doc, 80, 3_000)
    return []
  }
  const started = performance.now()
  let lastActive = started
  const frames: { key: string; at: number }[] = []
  while (performance.now() - lastActive < quietWindow) {
    if (presentationAnimating(doc, maximum)) lastActive = performance.now()
    const key = `motion-${eventIndex}-${frames.length}`
    await store.write(key, await raster(doc))
    frames.push({ key, at: Math.max(16, performance.now() - started) })
    await new Promise((resolve) => window.setTimeout(resolve, 16))
  }
  await settle(doc, 80, maximum)
  return frames
}

function actionGeometry(source: HTMLElement, target: HTMLElement | null, frame?: string): VodActionGeometry {
  const box = source.getBoundingClientRect()
  const from = point(source)
  const drag = Boolean(target) || source.matches('.hand .card, [data-orb-slot], .end-turn-effect--orb')
  return {
    ...(frame ? { frame } : {}),
    source: { x: box.left, y: box.top, width: box.width, height: box.height },
    from,
    to: target ? point(target) : drag ? { x: from.x, y: Math.max(.08, from.y - .28) } : from,
    drag,
  }
}

export async function activateControl(element: HTMLElement, ref: ControlRef) {
  if (element.matches('input[type="checkbox"], input[type="radio"]') && ref.checked !== undefined) {
    if ((element as HTMLInputElement).checked !== ref.checked) element.click()
  } else if (element.matches('select, textarea') && ref.value !== undefined) {
    ;(element as HTMLSelectElement | HTMLTextAreaElement).value = ref.value
    element.dispatchEvent(new Event('change', { bubbles: true }))
  } else element.click()
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
}

async function prepareGeometry(event: RunVodEvent, doc: Document, store: SnapshotStore, eventIndex: number): Promise<VodGeometry> {
  if (!event.choice) {
    await store.write(eventIndex, await raster(doc))
    return { actions: [], motion: [] }
  }
  const actions: VodActionGeometry[] = []
  const missedRoomId = !queryControl(doc, event.choice.source) && doc.querySelector('.map')
    ? event.patch.find((change) => change.path.length === 2 && change.path[0] === 'map' &&
      change.path[1] === 'position' && typeof change.value === 'string')?.value as string | undefined
    : undefined
  const refs = [
    ...(missedRoomId ? [{ selector: `[data-room="${CSS.escape(missedRoomId)}"]` }] : []),
    event.choice.source,
    ...(event.choice.steps ?? []),
  ]
  const choiceIndex = missedRoomId ? 1 : 0
  for (let index = 0; index < refs.length; index += 1) {
    const ref = refs[index]!
    const source = await waitForControl(ref, doc)
    if (!source) throw new Error(`Replay stopped at event ${eventIndex + 1}; chosen control ${ref.name ?? ref.selector} did not appear.`)
    const frame = index === 0 ? undefined : `choice-${eventIndex}-${index}`
    const target = index === choiceIndex && event.choice.target && !event.choice.steps?.length
      ? await waitForControl(event.choice.target, doc) : null
    if (index === choiceIndex && event.choice.target && !event.choice.steps?.length && !target) {
      throw new Error(`Replay stopped at event ${eventIndex + 1}; its chosen target did not appear.`)
    }
    await store.write(frame ?? eventIndex, await raster(doc))
    const action = actionGeometry(source, target, frame)
    if (action.drag) {
      action.sprite = `sprite-${eventIndex}-${index}`
      action.background = `background-${eventIndex}-${index}`
      await store.write(action.sprite, await rasterElement(source))
      const visibility = source.style.visibility
      source.style.visibility = 'hidden'
      try { await store.write(action.background, await raster(doc)) }
      finally { source.style.visibility = visibility }
    }
    actions.push(action)
    await activateControl(source, ref)
    if (target && event.choice.target) await activateControl(target, event.choice.target)
  }
  if (event.choice.target && event.choice.steps?.length) {
    const target = await waitForControl(event.choice.target, doc)
    if (!target) throw new Error(`Replay stopped at event ${eventIndex + 1}; its chosen target did not appear.`)
    const frame = `target-${eventIndex}`
    await store.write(frame, await raster(doc))
    actions.push(actionGeometry(target, null, frame))
    await activateControl(target, event.choice.target)
  }
  await mediaReady(doc)
  return { actions, motion: [] }
}

const ease = (value: number) => value < .5 ? 2 * value * value : 1 - (-2 * value + 2) ** 2 / 2
const mix = (from: number, to: number, amount: number) => from + (to - from) * amount

async function animate(duration: number, draw: (progress: number) => void) {
  const start = performance.now()
  await new Promise<void>((resolve) => {
    const frame = () => {
      const now = performance.now()
      const progress = Math.min(1, (now - start) / duration)
      draw(progress)
      if (progress < 1) window.setTimeout(frame, 1_000 / RUN_VOD_FPS)
      else resolve()
    }
    frame()
  })
}

function cursor(ctx: CanvasRenderingContext2D, point: Point, pulse = 0) {
  const x = point.x * RUN_VOD_WIDTH
  const y = point.y * RUN_VOD_HEIGHT
  ctx.save()
  ctx.translate(x, y)
  ctx.shadowColor = '#000c'
  ctx.shadowBlur = 8
  ctx.fillStyle = '#fff'
  ctx.strokeStyle = '#121722'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(0, 0)
  ctx.lineTo(0, 27)
  ctx.lineTo(7, 20)
  ctx.lineTo(13, 32)
  ctx.lineTo(18, 29)
  ctx.lineTo(12, 18)
  ctx.lineTo(23, 18)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()
  if (pulse > 0) {
    ctx.globalAlpha = 1 - pulse
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 4
    ctx.beginPath()
    ctx.arc(0, 0, 8 + pulse * 24, 0, Math.PI * 2)
    ctx.stroke()
  }
  ctx.restore()
}

function paint(ctx: CanvasRenderingContext2D, frame: CanvasImageSource, point: Point, pulse = 0) {
  ctx.clearRect(0, 0, RUN_VOD_WIDTH, RUN_VOD_HEIGHT)
  ctx.drawImage(frame, 0, 0, RUN_VOD_WIDTH, RUN_VOD_HEIGHT)
  cursor(ctx, point, pulse)
}

async function recorderFor(canvas: HTMLCanvasElement, audio: MediaStream, store: SnapshotStore) {
  if (typeof MediaRecorder === 'undefined' || !canvas.captureStream) throw new Error('This browser cannot encode a Run VOD.')
  const mimeType = [
    'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm',
    'video/mp4;codecs=h264,aac', 'video/mp4',
  ].find((type) => MediaRecorder.isTypeSupported(type))
  if (!mimeType) throw new Error('This browser has no supported video encoder.')
  const extension = mimeType.startsWith('video/mp4') ? 'mp4' : 'webm'
  const video = canvas.captureStream(RUN_VOD_FPS)
  const videoTrack = video.getVideoTracks()[0]
  if (!videoTrack) throw new Error('The browser could not create the Run VOD video track.')
  videoTrack.contentHint = 'detail'
  const stream = new MediaStream([videoTrack, ...audio.getAudioTracks()])
  if (stream.getAudioTracks().length === 0) throw new Error('The Run VOD audio mix could not be created.')
  const writable = await store.video(extension)
  const chunks: Blob[] = []
  let writes = Promise.resolve()
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 16_000_000, audioBitsPerSecond: 256_000 })
  recorder.addEventListener('dataavailable', (event) => {
    if (event.data.size === 0) return
    if (writable) writes = writes.then(() => writable.write(event.data))
    else chunks.push(event.data)
  })
  recorder.start(1_000)
  return {
    extension,
    async finish() {
      recorder.requestData()
      await new Promise((resolve) => window.setTimeout(resolve, 100))
      await new Promise<void>((resolve) => {
        recorder.addEventListener('stop', () => resolve(), { once: true })
        recorder.stop()
      })
      stream.getTracks().forEach((track) => track.stop())
      await writes
      await writable?.close()
      const file = await store.videoFile(extension)
      const result: Blob = file ?? new Blob(chunks, { type: mimeType })
      if (result.size === 0) throw new Error('The browser did not produce a Run VOD.')
      return result
    },
    async abort() {
      if (recorder.state !== 'inactive') await new Promise<void>((resolve) => {
        recorder.addEventListener('stop', () => resolve(), { once: true })
        recorder.stop()
      })
      stream.getTracks().forEach((track) => track.stop())
      try { await writes } catch {}
      try { await writable?.abort() } catch {}
    },
  }
}

export async function extractRunVod(log: RunVodLog, expected: RunState) {
  const ui = replayFrame()
  const store = await snapshotStore(log.runId)
  let recording: Awaited<ReturnType<typeof recorderFor>> | null = null
  let bridge: RunVodBridge | null = null
  try {
    bridge = await bridgeFor(ui.iframe)
    const audioSettings = bridge.getSettings()
    if (audioSettings.bgmVolume !== 100 || audioSettings.sfxVolume !== 100) {
      throw new Error('The canonical Run VOD renderer did not enable maximum music and sound effects.')
    }
    const liveBridge = () => (ui.iframe.contentWindow as Window & { __STS_DEBUG__?: RunVodBridge } | null)?.__STS_DEBUG__ ?? bridge!
    const doc = ui.iframe.contentDocument
    if (!doc) throw new Error('The canonical Run VOD renderer is unavailable.')
    doc.documentElement.dataset.runVodPrepass = 'true'
    bridge.setVodAudioMuted(true)
    bridge.setRun(structuredClone(log.initial))
    const geometries: VodGeometry[] = []
    let replayState = structuredClone(log.initial)
    for (let index = 0; index < log.events.length; index += 1) {
      ui.status.textContent = `Preparing Run VOD · event ${index + 1} of ${log.events.length}`
      const event = log.events[index]!
      bridge.setViewer(event.viewerId ?? log.initial.players[0]!.id)
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      const shape = await prepareGeometry(event, doc, store, index)
      geometries.push(shape)
      replayState = applyRunVodEvent(replayState, event)
      bridge.setRun(structuredClone(replayState))
      shape.motion = await captureMotion(doc, store, index)
    }
    const deadline = performance.now() + 15_000
    while (stableRunJson(liveBridge().getRun()) !== stableRunJson(expected) && performance.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 50))
    }
    if (stableRunJson(liveBridge().getRun()) !== stableRunJson(expected)) {
      throw new Error(`Replay did not reproduce the finished run exactly (${firstDifference(liveBridge().getRun(), expected)}), so no misleading VOD was saved.`)
    }
    await store.write(log.events.length, await raster(doc))

    doc.documentElement.dataset.runVodPrepass = 'false'
    bridge.setViewer(log.initial.players[0]!.id)
    bridge.setRun(structuredClone(log.initial))
    await settle(doc, 100, 1_000)
    const audio = bridge.startVodAudio()
    bridge.setVodAudioMuted(false)
    const canvas = document.createElement('canvas')
    canvas.className = 'run-vod-workbench__canvas'
    canvas.width = RUN_VOD_WIDTH
    canvas.height = RUN_VOD_HEIGHT
    ui.workbench.insertBefore(canvas, ui.status)
    ui.iframe.style.opacity = '0'
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('The Run VOD canvas could not be created.')
    let current = await store.read(0)
    let position: Point = { x: .5, y: .5 }
    paint(ctx, current, position)
    recording = await recorderFor(canvas, audio, store)
    ui.status.textContent = `Recording native 1080p at ${RUN_VOD_FPS} fps…`
    await animate(800, () => paint(ctx, current, position))
    replayState = structuredClone(log.initial)
    let pulse = false
    for (let index = 0; index < log.events.length; index += 1) {
      const event = log.events[index]!
      bridge.setViewer(event.viewerId ?? log.initial.players[0]!.id)
      const shape = geometries[index]!
      const next = await store.read(index + 1)
      for (const action of shape.actions) {
        if (action.frame) {
          const frame = await store.read(action.frame)
          current.close()
          current = frame
          paint(ctx, current, position)
        }
        const trailingPulse = pulse
        pulse = false
        const origin = position
        const movementMs = Math.hypot(origin.x - action.from.x, origin.y - action.from.y) < .001
          ? RUN_VOD_REPEAT_CLICK_MS
          : RUN_VOD_CURSOR_MS
        await animate(movementMs, (progress) => {
          const amount = ease(progress)
          position = { x: mix(origin.x, action.from.x, amount), y: mix(origin.y, action.from.y, amount) }
          paint(ctx, current, position, trailingPulse ? progress : 0)
        })
        pulse = true
        bridge.playVodUiSound()
        paint(ctx, current, position, .01)
        if (action.drag) {
          const start = action.source
          const background = action.background ? await store.read(action.background) : current
          const sprite = action.sprite ? await store.read(action.sprite) : current
          await animate(RUN_VOD_CURSOR_MS, (progress) => {
            const amount = ease(progress)
            position = { x: mix(action.from.x, action.to.x, amount), y: mix(action.from.y, action.to.y, amount) }
            paint(ctx, background, position, progress)
            const x = position.x * RUN_VOD_WIDTH - start.width / 2
            const y = position.y * RUN_VOD_HEIGHT - start.height / 2
            ctx.save()
            ctx.globalAlpha = .97
            ctx.shadowColor = '#000c'
            ctx.shadowBlur = 18
            ctx.drawImage(sprite, x, y, start.width, start.height)
            ctx.restore()
            cursor(ctx, position)
          })
          if (background !== current) background.close()
          if (sprite !== current) sprite.close()
        }
      }
      replayState = applyRunVodEvent(replayState, event)
      bridge.setRun(structuredClone(replayState))
      let motionAt = 0
      for (const frame of shape.motion) {
        const motion = await store.read(frame.key)
        await animate(Math.max(16, frame.at - motionAt), (progress) => {
          ctx.clearRect(0, 0, RUN_VOD_WIDTH, RUN_VOD_HEIGHT)
          ctx.globalAlpha = 1
          ctx.drawImage(current, 0, 0, RUN_VOD_WIDTH, RUN_VOD_HEIGHT)
          ctx.globalAlpha = progress
          ctx.drawImage(motion, 0, 0, RUN_VOD_WIDTH, RUN_VOD_HEIGHT)
          ctx.globalAlpha = 1
          cursor(ctx, position)
        })
        current.close()
        current = motion
        motionAt = frame.at
      }
      if (shape.motion.length > 0) await animate(RUN_VOD_CURSOR_MS, (progress) => {
        ctx.clearRect(0, 0, RUN_VOD_WIDTH, RUN_VOD_HEIGHT)
        ctx.globalAlpha = 1
        ctx.drawImage(current, 0, 0, RUN_VOD_WIDTH, RUN_VOD_HEIGHT)
        ctx.globalAlpha = progress
        ctx.drawImage(next, 0, 0, RUN_VOD_WIDTH, RUN_VOD_HEIGHT)
        ctx.globalAlpha = 1
        cursor(ctx, position)
      })
      if (shape.actions.length === 0 && shape.motion.length === 0) await animate(RUN_VOD_CURSOR_MS, (progress) => {
          ctx.globalAlpha = 1
          ctx.drawImage(current, 0, 0, RUN_VOD_WIDTH, RUN_VOD_HEIGHT)
          ctx.globalAlpha = progress
          ctx.drawImage(next, 0, 0, RUN_VOD_WIDTH, RUN_VOD_HEIGHT)
          ctx.globalAlpha = 1
          cursor(ctx, position, pulse ? progress : 0)
        })
      current.close()
      current = next
      paint(ctx, current, position)
    }
    await animate(1_500, () => paint(ctx, current, position))
    current.close()
    if (stableRunJson(liveBridge().getRun()) !== stableRunJson(expected)) {
      throw new Error('The recorded replay diverged from the finished run, so no misleading VOD was saved.')
    }
    const extension = recording.extension
    const video = await recording.finish()
    recording = null
    bridge.setVodAudioMuted(true)
    bridge.stopVodAudio()
    const filename = `slay-the-spire-run-${expected.campaign.runId}.${extension}`
    const url = URL.createObjectURL(video)
    Object.assign(document.createElement('a'), { href: url, download: filename }).click()
    window.setTimeout(() => {
      URL.revokeObjectURL(url)
      void store.cleanup()
    }, 60_000)
    return { video, filename }
  } catch (error) {
    await recording?.abort()
    bridge?.setVodAudioMuted(true)
    bridge?.stopVodAudio()
    await store.cleanup()
    throw error
  } finally {
    ui.workbench.remove()
  }
}
