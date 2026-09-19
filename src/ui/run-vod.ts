import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { assetPath } from '../game/assets.ts'
import { cardDef } from '../game/cards.ts'
import type { RunState } from '../game/run.ts'
import { rasterRunVod, pruneRunVodRaster, releaseRunVodRaster } from './run-vod-raster.ts'
import { createRunVodClock, type RunVodClock } from './run-vod-clock.ts'
import { createRunVodEncoder } from './run-vod-encoder.ts'
import type { RunVodAudioCue } from './sfx.ts'

const RUN_VOD_KEY = 'sts-run-vod'
const RUN_VOD_DATABASE = 'sts-run-vod-v2'
const CONTROL = 'button, input, select, textarea, summary, [role="button"]'
const READ_ONLY = '.map-peek, .map-peek__open, .card-collection, .compendium, .deck-peek__open, .game-settings, .settings-dialog, [data-pile], .room:not(.room--reachable)'
export const RUN_VOD_WIDTH = 1920
export const RUN_VOD_HEIGHT = 1080
export const RUN_VOD_FPS = 120
export const RUN_VOD_CURSOR_MS = 150
export const RUN_VOD_REPEAT_CLICK_MS = 250
export const RUN_VOD_ACTION_HOLD_MS = 1_000
export const RUN_VOD_CURSOR_ASSET = assetPath('ui/cursor.png')
export const RUN_VOD_CURSOR_CLICK_ASSET = assetPath('ui/cursor-click.png')
export const RUN_VOD_REPLAY = new URLSearchParams(location.search).get('run-vod') === '1'
export const runVodActionWait = (elapsedMs: number, samePlace: boolean) =>
  Math.max(0, (samePlace ? RUN_VOD_REPEAT_CLICK_MS : RUN_VOD_ACTION_HOLD_MS) - elapsedMs)

type Point = { x: number; y: number }
type ControlRef = { selector: string; name?: string; value?: string; checked?: boolean; drag?: true; card?: true; target?: true }
type RunVodChoice = { source: ControlRef; steps?: ControlRef[]; target?: ControlRef }
type RunVodPatch = { path: (string | number)[]; value?: unknown; remove?: true }
export type RunVodEvent = { patch: RunVodPatch[]; choice?: RunVodChoice; viewerId?: string }
export type RunVodLog = { version: 2; runId: string; initial: RunState; events: RunVodEvent[] }
const CANCEL_CHOICE = /^(cancel|close|back(?: to (?:choices|run))?)$/i
const TURN_CONTROL = /^(End turn|Resolve (?:start|end)(?: of turn| turn \d+))$/
const semanticDeckMutation = (event: RunVodEvent) => Boolean(event.choice?.steps?.length && event.patch.some((change) =>
  change.path[0] === 'players' && change.path[2] === 'deck'))

export function normalizeRunVodChoice(choice: RunVodChoice | null | undefined) {
  const last = choice?.steps?.at(-1)
  return choice?.source.drag && last?.target
    ? { ...choice, steps: choice.steps?.slice(0, -1), target: last }
    : choice
}

export function runVodEventChoice(event: RunVodEvent, before: RunState): RunVodChoice | undefined {
  let choice = event.choice
  const handCard = (ref: ControlRef) => Boolean(ref.card || ref.drag && / > footer > .* > button/.test(ref.selector) && /, cost /.test(ref.name ?? ''))
  if (choice?.steps?.length && handCard(choice.source) && before.combat) {
    const after = applyRunVodEvent(before, event)
    const lastSeq = before.combat.presentationEvents?.at(-1)?.seq ?? 0
    const played = after.combat?.combatId === before.combat.combatId
      ? after.combat.presentationEvents?.filter((entry) => entry.seq > lastSeq && entry.kind === 'card' && !entry.copied &&
        entry.actorId === (event.viewerId ?? before.players[0]?.id)) ?? [] : []
    if (!played.length) {
      // An unplayable/staged card before resolving a turn is not a card play.
      // Its old drag target must not be replayed after start-turn damage.
      if (choice.steps.some(ref => TURN_CONTROL.test(ref.name ?? ''))) {
        const first = choice.steps.findIndex(ref => !handCard(ref))
        return { source: choice.steps[first]!, steps: choice.steps.slice(first + 1) }
      }
    }
    if (played.length === 1) {
      const name = cardDef(played[0]!.sourceId).name
      const matches = (ref: ControlRef) => handCard(ref) &&
        [name + ', cost ', name + '+, cost '].some((prefix) => ref.name?.startsWith(prefix))
      const candidates = choice.steps.map((ref, index) => matches(ref) ? index : -1).filter((index) => index >= 0)
      if (!matches(choice.source) && candidates.length === 1 && choice.steps.slice(0, candidates[0]).every(handCard)) {
        const index = candidates[0]!
        choice = { ...choice, source: choice.steps[index]!, steps: choice.steps.slice(index + 1) }
      }
    }
  }
  return normalizeRunVodChoice(choice) ?? undefined
}

export type RunVodBridge = {
  getRun: () => RunState
  setRun: (next: RunState) => void
  flushVod: (callback: () => void) => void
  setViewer: (id: string) => void
  startVodAudio: () => MediaStream
  captureVodAudio: () => RunVodAudioCue[]
  setVodAudioSegment: (segment: string) => void
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

function controlName(element: HTMLElement) {
  const name = element.getAttribute('aria-label')?.trim() || element.textContent?.trim()
  // Phone map inspection is not an outcome decision. Its second-tap hint
  // must not turn one room selection into two replay actions.
  return element.hasAttribute('data-room') ? name?.replace(/, Activate again to enter$/, '') : name
}

function controlRef(element: HTMLElement): ControlRef {
  const name = controlName(element)
  const input = element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
  return {
    selector: selector(element), ...(name ? { name } : {}),
    ...('value' in input ? { value: input.value } : {}),
    ...(input instanceof HTMLInputElement && ['checkbox', 'radio'].includes(input.type) ? { checked: input.checked } : {}),
    ...(element.matches('.hand .card, [data-orb-slot], .end-turn-effect--orb') ? { drag: true as const } : {}),
    ...(element.matches('.hand .card') ? { card: true as const } : {}),
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
  const deckChanges = event.patch.filter((change) => change.path[0] === 'players' && change.path[2] === 'deck')
  for (const change of event.patch) {
    let path = change.path
    if (semanticDeckMutation(event) && deckChanges.length === 1 && path.length === 5 &&
      path[4] === 'upgraded' && change.value === true && path[0] === 'players' && path[2] === 'deck' &&
      typeof path[1] === 'number' && typeof path[3] === 'number') {
      const deck = run.players[path[1]]?.deck ?? []
      const target = [...(event.choice?.steps ?? [])].reverse().find((step) => deck.some((card) =>
        step.name?.startsWith(cardDef(card.defId).name)))
      const matches = target ? deck.flatMap((card, index) => target.name?.startsWith(cardDef(card.defId).name) ? [index] : []) : []
      if (!matches.includes(path[3]) && matches.length === 1) path = [...path.slice(0, 3), matches[0]!, ...path.slice(4)]
      else if (!matches.includes(path[3]) && matches.length > 1) throw new Error('The legacy VOD card choice is ambiguous.')
    }
    if (path.length === 0) return structuredClone(change.value) as RunState
    let owner = next as Record<string | number, unknown>
    for (const [index, part] of path.slice(0, -1).entries()) {
      if (!owner[part] || typeof owner[part] !== 'object') {
        owner[part] = typeof path[index + 1] === 'number' ? [] : {}
      }
      owner = owner[part] as Record<string | number, unknown>
    }
    const key = path.at(-1)!
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

export function useRunVod(run: RunState, active: boolean, viewerId: string) {
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
      setAvailable(Boolean(log.current?.events.length))
      setLogReady(true)
    })
  }, [active, run.campaign.runId])

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
      setAvailable(log.current.events.length > 0)
    }
    if (run.campaign.finalized) {
      previous.current = structuredClone(run)
      return
    }
    const patch = statePatch(before, run)
    previous.current = structuredClone(run)
    if (patch.length === 0) return
    const choice = normalizeRunVodChoice(pendingChoice.current)
    const event = { patch, ...(choice ? { choice } : {}), viewerId }
    pendingChoice.current = null
    if (!logReady || !log.current || log.current.runId !== run.campaign.runId) {
      queuedEvents.current.push(event)
      setAvailable(false)
      return
    }
    const index = log.current.events.push(event) - 1
    setAvailable(true)
    persistence = persistence.then(() => persistEvent(run.campaign.runId, index, event))
      .catch(() => setAvailable(false))
  }, [active, logReady, run, viewerId])

  useLayoutEffect(() => {
    if (!active || run.campaign.finalized) return
    let down: ControlRef | null = null
    const append = (ref: ControlRef) => {
      const current = pendingChoice.current
      if (!current || ref.card) return void (pendingChoice.current = { source: ref })
      const last = current.steps?.at(-1) ?? current.source
      if (last.selector === ref.selector && last.name === ref.name) {
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
      if (down?.card) pendingChoice.current = null
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

export const stableRunJson = (run: unknown) => JSON.stringify(run, (_key, value) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
    : value)

function omitFalseDefaults(value: unknown): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) return void value.forEach(omitFalseDefaults)
  for (const [key, entry] of Object.entries(value)) {
    if (entry === false) delete (value as Record<string, unknown>)[key]
    else omitFalseDefaults(entry)
  }
}

export function replayComparableRun(run: RunState) {
  if (run.phase !== 'defeat' && run.phase !== 'victory') return run
  const comparable = structuredClone(run)
  for (const player of comparable.players) {
    const deck = player.deck.map((card) => ({ ...card }))
    deck.sort((left, right) => stableRunJson({ ...left, uid: '' }).localeCompare(stableRunJson({ ...right, uid: '' })))
    deck.forEach((card, index) => { card.uid = `terminal-${index}` })
    player.deck = deck
    for (const pileName of ['draw', 'hand', 'discard', 'exhaust'] as const) player[pileName] = []
  }
  for (const deck of Object.values(comparable.enemyDecks)) {
    if (Array.isArray(deck)) deck.sort((left, right) => stableRunJson(left).localeCompare(stableRunJson(right)))
  }
  omitFalseDefaults(comparable)
  return comparable
}

export const replayRunJson = (run: RunState) => stableRunJson(replayComparableRun(run))

function firstDifference(left: unknown, right: unknown, path = 'run'): string {
  if (Object.is(left, right)) return ''
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return `${path}: ${JSON.stringify(left)} != ${JSON.stringify(right)}`
  const a = left as Record<string, unknown>
  const b = right as Record<string, unknown>
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const difference = firstDifference(a[key], b[key], `${path}.${key}`)
    if (difference) return difference
  }
  return ''
}

export function queryControl(doc: Document, ref: ControlRef): HTMLElement | null {
  const name = ref.selector.startsWith('[data-room=') ? ref.name?.replace(/, Activate again to enter$/, '') : ref.name
  const nameMatches = (element: HTMLElement) => !name || controlName(element) === name || controlName(element)?.startsWith(`${name} `)
  const visible = (element: HTMLElement | null) => {
    if (!element || !nameMatches(element)) return null
    const view = element.ownerDocument.defaultView
    let box = element.getBoundingClientRect()
    if (box.width <= 0 || box.height <= 0 || view?.getComputedStyle(element).visibility === 'hidden') return null
    // scrollIntoView also scrolls the iframe's host and overflow:hidden roots.
    // Only move actual picker/board scrollers, never the canonical stage.
    for (let parent = element.parentElement; parent && parent !== doc.body; parent = parent.parentElement) {
      const style = view!.getComputedStyle(parent)
      const bounds = parent.getBoundingClientRect()
      if (/^(auto|scroll)$/.test(style.overflowY)) {
        parent.scrollTop += box.top < bounds.top ? box.top - bounds.top : Math.max(0, box.bottom - bounds.bottom)
      }
      if (/^(auto|scroll)$/.test(style.overflowX)) {
        parent.scrollLeft += box.left < bounds.left ? box.left - bounds.left : Math.max(0, box.right - bounds.right)
      }
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
    nameMatches(element) && visible(element)) ?? null
}

export function soleReachableRoom(root: ParentNode) {
  const rooms = root.querySelectorAll<HTMLElement>('.room--reachable')
  return rooms.length === 1 ? rooms[0]! : null
}

export function soleForcedResolution(doc: Document) {
  const controls = [...doc.querySelectorAll<HTMLElement>(CONTROL)].filter((element) =>
    /^Resolve\b/.test(element.getAttribute('aria-label')?.trim() || element.textContent?.trim() || '') &&
    !(element as HTMLButtonElement).disabled && element.getClientRects().length > 0 &&
    doc.defaultView?.getComputedStyle(element).visibility !== 'hidden')
  return controls.length === 1 ? controls[0]! : null
}

export function runVodMerchantExit(doc: Document, ref: ControlRef) {
  if (!/^Proceed · \d+\/\d+ ready$/.test(ref.name ?? '')) return null
  return queryControl(doc, { selector: '.merchant-shop-stage > .room-proceed', name: '← Leave shop' })
}

type VodActionGeometry = {
  audioSegment?: string
  frame?: string
  background?: string
  sprite?: string
  source: { x: number; y: number; width: number; height: number }
  from: Point
  to: Point
  drag: boolean
  motion?: MotionFrame[]
}

type VodGeometry = {
  actions: VodActionGeometry[]
  motion: MotionFrame[]
  recoveredRoom?: true
  recoveredChoice?: true
  recoveryBase?: RunState
}

type FrameTile = { x: number; y: number; width: number; height: number; sx: number; sy: number }
type MotionFrame = { key: string; at: number; tiles?: FrameTile[] }
type VodStream = {
  action: (action: VodActionGeometry, frame: HTMLCanvasElement, sprite?: HTMLCanvasElement, background?: HTMLCanvasElement) => Promise<void>
  segment: (name: string) => void
  motion: (frame: HTMLCanvasElement, milliseconds: number) => Promise<void>
  still: (frame: HTMLCanvasElement, milliseconds: number) => Promise<void>
}

// Distant effects must not duplicate the unchanged battlefield between them.
// Pack only changed 128px tiles into one lossless PNG per movie frame.
export function runVodFrameDelta(canvas: HTMLCanvasElement, pixels: Uint32Array, previous: Uint32Array) {
  const size = 128
  const tiles: FrameTile[] = []
  const columns = Math.ceil(canvas.width / size)
  for (let y = 0; y < canvas.height; y += size) for (let x = 0; x < canvas.width; x += size) {
    const endX = Math.min(x + size, canvas.width), endY = Math.min(y + size, canvas.height)
    let left = endX, top = endY, right = -1, bottom = -1
    for (let row = y; row < endY; row++) {
      const offset = row * canvas.width
      let first = x, last = endX - 1
      while (first < endX && pixels[offset + first] === previous[offset + first]) first++
      if (first === endX) continue
      while (last > first && pixels[offset + last] === previous[offset + last]) last--
      left = Math.min(left, first); right = Math.max(right, last)
      top = Math.min(top, row); bottom = row
    }
    if (right >= left) tiles.push({ x: left, y: top, width: right - left + 1, height: bottom - top + 1,
      sx: tiles.length % columns * size, sy: Math.floor(tiles.length / columns) * size })
  }
  if (!tiles.length) return null
  const packed = canvas.ownerDocument.createElement('canvas')
  packed.width = Math.min(columns, tiles.length) * size
  packed.height = Math.ceil(tiles.length / columns) * size
  const context = packed.getContext('2d')!
  for (const tile of tiles) context.drawImage(canvas, tile.x, tile.y, tile.width, tile.height,
    tile.sx, tile.sy, tile.width, tile.height)
  return { canvas: packed, tiles }
}

type SnapshotStore = {
  write: (key: string | number, canvas: HTMLCanvasElement) => Promise<void>
  read: (key: string | number) => Promise<ImageBitmap>
  video: (extension: string) => Promise<FileSystemWritableFileStream | null>
  videoFile: (extension: string) => Promise<File | null>
  cleanup: () => Promise<void>
}

export async function snapshotStore(runId: string): Promise<SnapshotStore> {
  const memory: Record<string, Blob> = {}
  let encoder: ReturnType<typeof createRunVodEncoder> | undefined
  let writes = Promise.resolve()
  const name = `run-vod-${runId.replace(/[^a-z0-9-]/gi, '')}-${Date.now()}`
  let root: FileSystemDirectoryHandle | null = null
  let openVideo: FileSystemWritableFileStream | null = null
  let frames: FileSystemFileHandle | null = null
  let writer: FileSystemWritableFileStream | null = null
  let frameFile: File | null = null
  let offset = 0
  const ranges = new Map<string | number, { offset: number; size: number }>()
  try {
    // This protects long exports from eviction when the browser grants it;
    // available quota still belongs to the browser, not to the game.
    void navigator.storage.persist?.().catch(() => {})
    const storage = await navigator.storage.getDirectory()
    const entries = (storage as FileSystemDirectoryHandle & { keys(): AsyncIterableIterator<string> }).keys()
    for await (const entry of entries) {
      const timestamp = Number(entry.match(/^run-vod-.*-(\d+)$/)?.[1])
      if (timestamp && Date.now() - timestamp > 60 * 60 * 1_000) {
        try { await storage.removeEntry(entry, { recursive: true }) } catch {}
      }
    }
    root = await storage.getDirectoryHandle(name, { create: true })
    frames = await root.getFileHandle('frames.bin', { create: true })
    writer = await frames.createWritable()
  } catch { root = null /* A short replay can still use the in-memory fallback. */ }
  return {
    write(key, canvas) {
      const encoded = (encoder ??= createRunVodEncoder()).encode(canvas)
      void encoded.catch(() => {}) // Observed by the ordered write below.
      writes = writes.then(async () => {
        const value = await encoded
        if (!root) {
          if (offset + value.size > 256 * 1024 * 1024) throw new Error('This VOD needs temporary disk storage. Enable browser storage and try again.')
          memory[String(key)] = value
        } else {
          if (!writer) throw new Error('Cannot add VOD frames after encoding starts.')
          await writer.write(value)
          ranges.set(key, { offset, size: value.size })
        }
        offset += value.size
      })
      return writes
    },
    async read(key) {
      await writes
      if (writer) {
        await writer.close()
        writer = null
        frameFile = await frames!.getFile()
      }
      const range = ranges.get(key)
      const value = root && range ? frameFile?.slice(range.offset, range.offset + range.size) : memory[String(key)]
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
      encoder?.close()
      try { await writes } catch {}
      if (writer) {
        try { await writer.abort() } catch {}
        writer = null
      }
      if (openVideo) {
        try { await openVideo.abort() } catch {}
        openVideo = null
      }
      if (!root) return
      try { await (await navigator.storage.getDirectory()).removeEntry(name, { recursive: true }) } catch {}
    },
  }
}

function replayFrame(parent?: HTMLDialogElement) {
  const workbench = parent ?? document.createElement('dialog')
  workbench.className = 'run-vod-workbench'
  workbench.dataset.runVodControl = ''
  const status = document.createElement('div')
  status.className = 'run-vod-workbench__status'
  const label = document.createElement('span')
  label.textContent = 'Preparing Run VOD…'
  const progress = document.createElement('progress')
  progress.max = 1
  progress.value = 0
  progress.setAttribute('aria-label', 'Run VOD export progress')
  status.append(label, progress)
  const iframe = document.createElement('iframe')
  iframe.className = 'run-vod-workbench__frame'
  iframe.title = 'Run VOD replay'
  iframe.width = String(RUN_VOD_WIDTH)
  iframe.height = String(RUN_VOD_HEIGHT)
  iframe.tabIndex = -1
  iframe.setAttribute('aria-hidden', 'true')
  const url = new URL(location.href)
  url.searchParams.set('run-vod', '1')
  url.hash = ''
  iframe.src = url.href
  workbench.append(iframe)
  if (!parent) {
    workbench.append(status)
    document.body.append(workbench)
    workbench.showModal()
  }
  return { workbench, iframe, status,
    update(text: string, value: number) {
      label.textContent = text
      progress.value = Math.max(progress.value, Math.min(1, value))
      progress.setAttribute('aria-valuetext', text)
    },
    remove() { if (parent) iframe.remove(); else workbench.remove() },
  }
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
    await replayWait(doc, 50)
    source = queryControl(doc, ref)
  }
  return source
}

const replayClocks = new WeakMap<Document, RunVodClock>()
const replayWait = (doc: Document, milliseconds: number) => replayClocks.get(doc)?.advance(milliseconds)
  ?? new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds))

async function settle(doc: Document, minimum = 180, maximum = 3_000) {
  const started = performance.now()
  do {
    await replayWait(doc, 50)
    const animating = doc.getAnimations().some((animation) => {
      const timing = animation.effect?.getComputedTiming()
      return animation.playState === 'running' && Number.isFinite(Number(timing?.iterations)) && Number(timing?.endTime ?? 0) <= maximum
    })
    if (performance.now() - started >= minimum && !animating) return
  } while (performance.now() - started < maximum)
}

async function mediaReady(doc: Document) {
  await doc.fonts.ready
  await Promise.all([...doc.images].map((image) => {
    // Draw animations begin outside the viewport. Waiting for lazy artwork
    // before advancing the animation would otherwise deadlock the exporter.
    if (image.loading !== 'eager') image.loading = 'eager'
    return image.decode().catch(() => {})
  }))
}

async function raster(doc: Document, prepared?: () => void) {
  await mediaReady(doc)
  return rasterRunVod(doc.body, RUN_VOD_WIDTH, RUN_VOD_HEIGHT, replayClocks.get(doc)?.now, prepared)
}

async function rasterElement(element: HTMLElement) {
  const box = element.getBoundingClientRect()
  return rasterRunVod(element, Math.ceil(box.width), Math.ceil(box.height), replayClocks.get(element.ownerDocument)?.now)
}

async function captureMotion(doc: Document, store: SnapshotStore, eventIndex: number, progress: (milliseconds: number, stage?: string) => void,
  stream?: VodStream) {
  const clock = replayClocks.get(doc)
  if (clock) {
    const frames: MotionFrame[] = []
    const pending: Promise<void>[] = []
    const save = (key: string, canvas: HTMLCanvasElement) => {
      const write = store.write(key, canvas).finally(() => { canvas.width = canvas.height = 0 })
      void write.catch(() => {}) // Awaited with bounded backpressure below.
      pending.push(write)
    }
    let previous: Uint32Array | undefined
    const start = clock.now
    await clock.advance(0)
    if (!clock.active()) return frames
    const shots: { key: string; at: number; canvas: Promise<HTMLCanvasElement> }[] = []
    const consume = async (shot: typeof shots[number]) => {
      const { key, at } = shot
      const canvas = await shot.canvas
      if (stream) {
        try { await stream.motion(canvas, 1_000 / 60) }
        finally { canvas.width = canvas.height = 0 }
        return
      }
      const context = canvas.getContext('2d', { willReadFrequently: true })!
      const pixels = new Uint32Array(context.getImageData(0, 0, canvas.width, canvas.height).data.buffer)
      progress(clock.now - start, 'saving')
      if (!previous) {
        save(key, canvas)
        frames.push({ key, at })
      } else {
        const patch = runVodFrameDelta(canvas, pixels, previous)
        if (patch) {
          save(key, patch.canvas)
          frames.push({ key, at, tiles: patch.tiles })
        }
        canvas.width = canvas.height = 0
      }
      previous = pixels
      if (pending.length >= 2) await pending.shift()
    }
    for (let index = 0; index < 60 * 15; index++) {
      progress(clock.now - start, 'rendering')
      let prepared!: () => void
      const ready = new Promise<void>((resolve) => { prepared = resolve })
      const canvas = raster(doc, prepared)
      // Once the SVG is self-contained, its decode/paint can overlap the
      // next virtual frame's DOM work. Two jobs cap memory and preserve order.
      await Promise.race([ready, canvas.then(() => {})])
      void canvas.catch(() => {}) // Consumed below, including failures.
      shots.push({ key: `motion-${eventIndex}-${index}`, at: clock.now - start, canvas })
      progress(clock.now - start, 'advancing')
      await clock.advance(1_000 / 60)
      if (shots.length >= 2) await consume(shots.shift()!)
      if (!clock.active()) break
      if (index === 60 * 15 - 1) throw new Error('A replay animation did not finish.')
    }
    for (const shot of shots) await consume(shot)
    await Promise.all(pending)
    // A duplicate final reference preserves the duration of unchanged frames.
    if (frames.length) frames.push({ ...frames.at(-1)!, at: clock.now - start })
    return frames
  }
  throw new Error('The replay animation clock is unavailable.')
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
  const clock = replayClocks.get(element.ownerDocument)
  if (clock) await clock.advance(0)
  else await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
}

async function prepareGeometry(event: RunVodEvent, doc: Document, store: SnapshotStore, eventIndex: number,
  progress: (milliseconds: number, stage?: string) => void, stream?: VodStream): Promise<VodGeometry> {
  event = { ...event, choice: normalizeRunVodChoice(event.choice) ?? undefined }
  if (!event.choice) {
    if (!stream) await store.write(eventIndex, await raster(doc))
    return { actions: [], motion: [] }
  }
  const actions: VodActionGeometry[] = []
  const missedRoom = !queryControl(doc, event.choice.source) && doc.querySelector('.map')
    ? (() => {
        const roomId = event.patch.find((change) => change.path.length === 2 && change.path[0] === 'map' &&
          change.path[1] === 'position' && typeof change.value === 'string')?.value as string | undefined
        return roomId ? doc.querySelector<HTMLElement>(`[data-room="${CSS.escape(roomId)}"]`)
          : soleReachableRoom(doc)
      })()
    : null
  const forcedResolution = !missedRoom && !queryControl(doc, event.choice.source)
    ? soleForcedResolution(doc) : null
  // Legacy logs collapsed Leave shop and Proceed because both controls used
  // the same DOM selector. Restore that UI-only step without changing state.
  const merchantExit = !queryControl(doc, event.choice.source) ? runVodMerchantExit(doc, event.choice.source) : null
  const refs = [
    ...(missedRoom ? [{ ref: controlRef(missedRoom), element: missedRoom }] : []),
    ...(forcedResolution ? [{ ref: controlRef(forcedResolution), element: forcedResolution }] : []),
    ...(merchantExit ? [{ ref: controlRef(merchantExit), element: merchantExit }] : []),
    { ref: event.choice.source },
    ...(event.choice.steps ?? []).map((ref) => ({ ref })),
  ]
  const choiceIndex = Number(Boolean(missedRoom)) + Number(Boolean(forcedResolution)) + Number(Boolean(merchantExit))
  let recoveryBase: RunState | undefined
  for (let index = 0; index < refs.length; index += 1) {
    const { ref, element } = refs[index]!
    if (index === choiceIndex && (missedRoom || forcedResolution)) {
      recoveryBase = structuredClone((doc.defaultView as Window & { __STS_DEBUG__?: RunVodBridge }).__STS_DEBUG__?.getRun())
    }
    const source = element ?? await waitForControl(ref, doc)
    if (!source) throw new Error(`Replay stopped at event ${eventIndex + 1}; chosen control ${ref.name ?? ref.selector} did not appear.`)
    const frame = index === 0 ? undefined : `choice-${eventIndex}-${index}`
    const target = index === choiceIndex && event.choice.target && !event.choice.steps?.length
      ? await waitForControl(event.choice.target, doc) : null
    if (index === choiceIndex && event.choice.target && !event.choice.steps?.length && !target) {
      throw new Error(`Replay stopped at event ${eventIndex + 1}; its chosen target did not appear.`)
    }
    const scene = await raster(doc)
    if (!stream) await store.write(frame ?? eventIndex, scene)
    const action = actionGeometry(source, target, frame)
    let sprite: HTMLCanvasElement | undefined, background: HTMLCanvasElement | undefined
    if (action.drag) {
      action.sprite = `sprite-${eventIndex}-${index}`
      action.background = `background-${eventIndex}-${index}`
      sprite = await rasterElement(source)
      if (!stream) await store.write(action.sprite, sprite)
      const visibility = source.style.visibility
      source.style.visibility = 'hidden'
      try {
        background = await raster(doc)
        if (!stream) await store.write(action.background, background)
      }
      finally { source.style.visibility = visibility }
    }
    if (stream) await stream.action(action, scene, sprite, background)
    actions.push(action)
    action.audioSegment = `action-${eventIndex}-${index}`
    ;(doc.defaultView as Window & { __STS_DEBUG__?: RunVodBridge }).__STS_DEBUG__!.setVodAudioSegment(action.audioSegment)
    stream?.segment(action.audioSegment)
    const recordedDeckCommit = semanticDeckMutation(event) && index === refs.length - 1 && /^Confirm\b/.test(ref.name ?? '')
    if (!recordedDeckCommit) await activateControl(source, ref)
    if (target && event.choice.target) await activateControl(target, event.choice.target)
    action.motion = await captureMotion(doc, store, eventIndex * 100 + index + 100_000, progress, stream)
  }
  if (event.choice.target && event.choice.steps?.length) {
    const target = await waitForControl(event.choice.target, doc)
    if (!target) throw new Error(`Replay stopped at event ${eventIndex + 1}; its chosen target did not appear.`)
    const frame = `target-${eventIndex}`
    const scene = await raster(doc)
    if (!stream) await store.write(frame, scene)
    const action = actionGeometry(target, null, frame)
    actions.push(action)
    if (stream) await stream.action(action, scene)
    action.audioSegment = `target-${eventIndex}`
    ;(doc.defaultView as Window & { __STS_DEBUG__?: RunVodBridge }).__STS_DEBUG__!.setVodAudioSegment(action.audioSegment)
    stream?.segment(action.audioSegment)
    await activateControl(target, event.choice.target)
    action.motion = await captureMotion(doc, store, eventIndex * 100 + 99 + 100_000, progress, stream)
  }
  await mediaReady(doc)
  return { actions, motion: [], ...(missedRoom ? { recoveredRoom: true } : {}),
    ...(forcedResolution ? { recoveredChoice: true } : {}), ...(recoveryBase ? { recoveryBase } : {}) }
}

const ease = (value: number) => value < .5 ? 2 * value * value : 1 - (-2 * value + 2) ** 2 / 2
const mix = (from: number, to: number, amount: number) => from + (to - from) * amount

async function animateRealtime(duration: number, draw: (progress: number) => void) {
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

let cursorImages: [HTMLImageElement, HTMLImageElement] | null = null

async function loadCursorImages() {
  if (cursorImages) return cursorImages
  const images = await Promise.all([RUN_VOD_CURSOR_ASSET, RUN_VOD_CURSOR_CLICK_ASSET].map(async (src) => {
    const image = new Image()
    image.src = src
    await image.decode()
    return image
  })) as [HTMLImageElement, HTMLImageElement]
  cursorImages = images
  return images
}

function cursor(ctx: CanvasRenderingContext2D, point: Point, pulse = 0) {
  const x = point.x * RUN_VOD_WIDTH
  const y = point.y * RUN_VOD_HEIGHT
  const image = cursorImages?.[pulse > 0 && pulse < .25 ? 1 : 0]
  if (!image) return
  ctx.save()
  ctx.drawImage(image, x - 7, y - 6, 32, 32)
  if (pulse > 0) {
    ctx.globalAlpha = 1 - pulse
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 4
    ctx.beginPath()
    ctx.arc(x, y, 8 + pulse * 24, 0, Math.PI * 2)
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
  const stopTracks = () => stream.getTracks().forEach((track) => track.stop())
  if (stream.getAudioTracks().length === 0) {
    stopTracks()
    throw new Error('The Run VOD audio mix could not be created.')
  }
  let writable: FileSystemWritableFileStream | null = null
  let recorder: MediaRecorder
  try {
    writable = await store.video(extension)
    recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 16_000_000, audioBitsPerSecond: 256_000 })
  } catch (error) {
    stopTracks()
    try { await writable?.abort() } catch {}
    throw error
  }
  const chunks: Blob[] = []
  let fallbackBytes = 0
  let writtenBytes = 0
  let writes = Promise.resolve()
  let failure: Error | undefined
  let ended = false
  let signalStopped!: () => void
  const stopped = new Promise<void>((resolve) => { signalStopped = resolve })
  const fail = (error: unknown) => {
    failure ??= error instanceof Error ? error : new Error(String(error))
    stopTracks()
    try { if (recorder.state !== 'inactive') recorder.stop() } catch {}
    signalStopped()
  }
  recorder.addEventListener('error', (event) => fail((event as Event & { error?: Error }).error ?? new Error('The Run VOD video encoder failed.')))
  recorder.addEventListener('stop', () => { ended = true; signalStopped() })
  recorder.addEventListener('dataavailable', (event) => {
    if (failure || event.data.size === 0) return
    if (fallbackBytes !== Infinity) {
      fallbackBytes += event.data.size
      if (fallbackBytes <= 256 * 1024 * 1024) chunks.push(event.data)
      else {
        chunks.length = 0; fallbackBytes = Infinity
        if (!writable) { fail(new Error('This VOD exceeds the browser memory limit. Enable browser storage and try again; your run is preserved.')); return }
      }
    }
    if (writable) writes = writes.then(async () => {
      if (failure) return
      await writable!.write({ type: 'write', position: writtenBytes, data: event.data })
      writtenBytes += event.data.size
    }).catch(fail)
  })
  const stop = async () => {
    try {
      if (recorder.state !== 'inactive') recorder.stop()
      else if (!ended && !failure) fail(new Error('The Run VOD video encoder stopped unexpectedly.'))
    } catch (error) { fail(error) }
    const timer = window.setTimeout(() => fail(new Error('The Run VOD video encoder did not finish.')), 10_000)
    try { await stopped } finally { window.clearTimeout(timer); stopTracks() }
  }
  try { recorder.start(1_000) }
  catch (error) {
    fail(error)
    try { await writable?.abort() } catch {}
    throw error
  }
  return {
    extension,
    async finish() {
      await stop()
      await writes
      if (failure) {
        try { await writable?.abort() } catch {}
        throw failure
      }
      await writable?.close()
      const file = await store.videoFile(extension)
      const result: Blob = file?.size ? file : new Blob(chunks, { type: mimeType })
      if (result.size === 0) throw new Error('The browser did not produce a Run VOD.')
      return result
    },
    async abort() {
      await stop()
      await writes
      try { await writable?.abort() } catch {}
    },
  }
}

type VodClip = { video: Blob; filename: string; duration: number; cues: RunVodAudioCue[]; cleanup: () => Promise<void> }
type VodJob = {
  parent: HTMLDialogElement
  checkCancelled: () => void
  progress: (value: number) => void
  first: boolean
  last: boolean
}

// Checkpoints are complete logged states. Keep combat, rewards and their map
// transition together; never bootstrap a renderer in a half-resolved combat.
export function runVodLocations(log: RunVodLog, expected: RunState) {
  const segments: { log: RunVodLog; expected: RunState }[] = []
  let state = structuredClone(log.initial)
  let initial = state
  let start = 0
  for (let index = 0; index < log.events.length; index++) {
    const before = state
    state = applyRunVodEvent(state, log.events[index]!)
    if (state.phase === 'map' && before.phase !== 'map' && index + 1 < log.events.length) {
      segments.push({ log: { ...log, initial, events: log.events.slice(start, index + 1) }, expected: state })
      initial = state
      start = index + 1
    }
  }
  segments.push({ log: { ...log, initial, events: log.events.slice(start) }, expected })
  return segments
}

export async function extractRunVod(log: RunVodLog, expected: RunState) {
  const locations = runVodLocations(log, expected)
  if (locations.length === 1) return renderRunVod(log, expected)
  const ui = replayFrame()
  ui.iframe.remove()
  let cancelled = false
  const cancel = document.createElement('button')
  cancel.className = 'run-vod-workbench__cancel'
  cancel.textContent = 'Cancel VOD export'
  cancel.onclick = () => { cancelled = true; cancel.disabled = true; cancel.textContent = 'Cancelling…' }
  ui.workbench.addEventListener('cancel', event => { event.preventDefault(); cancel.click() })
  ui.workbench.append(cancel)
  const checkCancelled = () => { if (cancelled) throw new Error('VOD export cancelled. Your run is still available to export.') }
  let store: SnapshotStore
  try { store = await snapshotStore(`${log.runId}-joined`) }
  catch (error) { ui.remove(); throw error }
  const pending = new Map<number, Promise<VodClip>>()
  let failure: unknown
  let joiner: Awaited<ReturnType<typeof import('./run-vod-video.ts').createRunVodJoiner>> = null
  try {
    const { createRunVodJoiner } = await import('./run-vod-video.ts')
    joiner = await createRunVodJoiner(RUN_VOD_FPS, store, checkCancelled)
    checkCancelled()
    if (!joiner) {
      await store.cleanup()
      checkCancelled()
      ui.remove()
      return await renderRunVod(log, expected)
    }
    const progress = locations.map(() => 0)
    let nextStart = 0
    let nextJoin = 0
    let active = 0
    const fill = () => {
      // Keep four actual renderers busy even when later short rooms finish
      // first. At most eight clips (active or encoded) may await ordered join.
      while (!cancelled && active < 4 && nextStart < Math.min(locations.length, nextJoin + 8)) start(nextStart++)
    }
    const start = (index: number) => {
      active++
      const location = locations[index]!
      const promise = renderRunVod(location.log, location.expected, {
        parent: ui.workbench, checkCancelled, first: index === 0, last: index === locations.length - 1,
        progress(value) {
          progress[index] = value
          const done = progress.reduce((sum, value, position) => sum + value * locations[position]!.log.events.length, 0)
          const rendering = [...pending.keys()].filter(index => progress[index]! < 1).length
          ui.update(`Rendering ${rendering} ${rendering === 1 ? 'location' : 'locations in parallel'} · ${Math.floor(done)} / ${log.events.length} events`, .94 * done / log.events.length)
        },
      })
      // A later job can fail while the earlier one is still encoding. Observe
      // it immediately and stop both; the ordered drain below owns cleanup.
      void promise.then(() => { active--; fill() }, error => { active--; failure ??= error; cancelled = true })
      pending.set(index, promise)
    }
    fill()
    for (let index = 0; index < locations.length; index++) {
      const clip = await pending.get(index)!
      pending.delete(index)
      try { await joiner.append(clip) } finally { await clip.cleanup() }
      nextJoin = index + 1
      fill()
    }
    checkCancelled()
    ui.update('Finishing audio and video…', .96)
    const video = await joiner.finish()
    checkCancelled()
    joiner = null
    const filename = `slay-the-spire-run-${expected.campaign.runId}.mp4`
    presentRunVod(video, filename, store)
    return { video, filename }
  } catch (error) {
    cancelled = true
    await Promise.all([...pending.values()].map(async promise => { try { await (await promise).cleanup() } catch {} }))
    await joiner?.abort()
    await store.cleanup()
    throw failure ?? error
  } finally { ui.remove() }
}

async function renderRunVod(log: RunVodLog, expected: RunState, job?: VodJob): Promise<VodClip> {
  const ui = replayFrame(job?.parent)
  if (job) ui.update = (_text, value) => job.progress(value)
  let cancelled = false
  const cancel = document.createElement('button')
  cancel.className = 'run-vod-workbench__cancel'
  cancel.textContent = 'Cancel VOD export'
  cancel.onclick = () => { cancelled = true; cancel.disabled = true; cancel.textContent = 'Cancelling…' }
  if (!job) {
    ui.workbench.addEventListener('cancel', (event) => { event.preventDefault(); cancel.click() })
    ui.workbench.append(cancel)
  }
  const checkCancelled = () => {
    job?.checkCancelled()
    if (cancelled) throw new Error('VOD export cancelled. Your run is still available to export.')
  }
  let store: SnapshotStore
  try { store = await snapshotStore(`${log.runId}-${crypto.randomUUID()}`) }
  catch (error) { ui.remove(); throw error }
  let recording: Awaited<ReturnType<typeof recorderFor>> | null = null
  let bridge: RunVodBridge | null = null
  let clock: RunVodClock | null = null
  let replayDoc: Document | null = null
  let outputCanvas: HTMLCanvasElement | null = null
  let releaseFrame = () => {}
  try {
    bridge = await bridgeFor(ui.iframe)
    const audioSettings = bridge.getSettings()
    if (audioSettings.bgmVolume !== 100 || audioSettings.sfxVolume !== 100) {
      throw new Error('The canonical Run VOD renderer did not enable maximum music and sound effects.')
    }
    const liveBridge = () => (ui.iframe.contentWindow as Window & { __STS_DEBUG__?: RunVodBridge } | null)?.__STS_DEBUG__ ?? bridge!
    const setReplayRun = async (run: RunState) => {
      const previous = liveBridge().getRun()
      if (stableRunJson(previous) === stableRunJson(run)) return
      liveBridge().setRun(structuredClone(run))
      const deadline = performance.now() + 15_000
      // Lazy room screens can suspend even a synchronous React update. Wait
      // for its actual commit before sampling animations or reading state.
      while (liveBridge().getRun() === previous) {
        checkCancelled()
        if (performance.now() > deadline) throw new Error('The replay screen did not finish loading.')
        await new Promise((resolve) => window.setTimeout(resolve, 10))
      }
    }
    const doc = ui.iframe.contentDocument
    replayDoc = doc
    if (!doc) throw new Error('The canonical Run VOD renderer is unavailable.')
    doc.documentElement.dataset.runVodPrepass = 'true'
    bridge.setVodAudioMuted(true)
    clock = createRunVodClock(doc, bridge.flushVod)
    replayClocks.set(doc, clock)
    const capturedAudio = bridge.captureVodAudio()
    await setReplayRun(log.initial)
    await clock.advance(0)
    const canvas = document.createElement('canvas')
    outputCanvas = canvas
    canvas.className = 'run-vod-workbench__canvas'
    canvas.width = RUN_VOD_WIDTH
    canvas.height = RUN_VOD_HEIGHT
    ui.workbench.append(canvas)
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('The Run VOD canvas could not be created.')
    await loadCursorImages()
    let current = await createImageBitmap(await raster(doc))
    releaseFrame = () => current.close()
    let position: Point = { x: .5, y: .5 }
    paint(ctx, current, position)
    const cues: RunVodAudioCue[] = []
    const { createOfflineRunVod } = await import('./run-vod-video.ts')
    const offline = await createOfflineRunVod(canvas, RUN_VOD_FPS, cues, store, checkCancelled, Boolean(job))
    if (job && (!offline || offline.extension !== 'mp4')) throw new Error('The parallel VOD encoder became unavailable. Your run is preserved.')
    if (offline) recording = offline
    const geometries: VodGeometry[] = []
    let stream: VodStream | undefined
    const replayPatches = new Map<number, RunVodPatch[]>()
    let preparedState = structuredClone(log.initial)
    const prepare = async (index: number) => {
      checkCancelled()
      const previousState = preparedState
      ui.update(`Rendering · ${index + 1} / ${log.events.length}`, (offline ? .99 : .8) * index / log.events.length)
      const logged = log.events[index]!
      const event = { ...logged, choice: runVodEventChoice(logged, preparedState) }
      bridge!.setViewer(event.viewerId ?? log.initial.players[0]!.id)
      await clock!.advance(0)
      const progress = () => {
        checkCancelled()
        ui.update(`Rendering · ${index + 1} / ${log.events.length}`, (offline ? .99 : .8) * index / log.events.length)
      }
      const shape = await prepareGeometry(event, doc, store, index, progress, stream)
      const patched = applyRunVodEvent(preparedState, event)
      const incompleteCombat = patched.phase === 'combat' && !patched.combat
      if (shape.recoveredRoom || shape.recoveryBase || incompleteCombat) {
        let observed = structuredClone(liveBridge().getRun())
        const recoveredCombatRoom = shape.recoveredRoom && event.patch.some((change) => change.path[0] === 'combat')
        if (recoveredCombatRoom) observed.players = structuredClone(patched.players)
        else {
          observed = shape.recoveryBase ? applyRunVodEvent(shape.recoveryBase, event) : applyRunVodEvent(observed, {
            patch: event.patch.filter((change) => !['phase', 'combat', 'map'].includes(String(change.path[0]))),
          })
        }
        observed.players.forEach((player, playerIndex) => {
          player.deck = structuredClone(patched.players[playerIndex]?.deck ?? player.deck)
          const piles = ['draw', 'hand', 'discard', 'exhaust'] as const
          if (piles.reduce((count, pile) => count + player[pile].length, 0) === player.deck.length) {
            const remaining = structuredClone(player.deck)
            for (const pile of piles) player[pile] = player[pile].map((card) => {
              let index = remaining.findIndex((candidate) => candidate.uid === card.uid)
              if (index < 0) index = remaining.findIndex((candidate) => candidate.defId === card.defId && candidate.upgraded === card.upgraded)
              return index < 0 ? card : remaining.splice(index, 1)[0]!
            })
          }
        })
        preparedState = observed
      } else preparedState = patched
      bridge!.setVodAudioSegment(`state-${index}`)
      stream?.segment(`state-${index}`)
      await setReplayRun(preparedState)
      shape.motion = await captureMotion(doc, store, index, progress, stream)
      await clock!.advance(0)
      preparedState = structuredClone(liveBridge().getRun())
      replayPatches.set(index, statePatch(previousState, preparedState))
      const finalFrame = await raster(doc)
      if (stream) await stream.still(finalFrame, shape.actions.length === 0 ? RUN_VOD_CURSOR_MS : 0)
      else await store.write(index + 1, finalFrame)
      await pruneRunVodRaster(doc)
      return shape
    }
    const finishPreparation = () => {
      if (replayRunJson(preparedState) !== replayRunJson(expected)) {
        throw new Error(`Replay did not reproduce the finished run exactly (${firstDifference(
          replayComparableRun(preparedState), replayComparableRun(expected),
        )}), so no misleading VOD was saved.`)
      }
      bridge!.stopVodAudio()
      clock!.restore()
      replayClocks.delete(doc)
      clock = null
      doc.documentElement.dataset.runVodPrepass = 'false'
    }
    if (!offline) {
      for (let index = 0; index < log.events.length; index++) geometries.push(await prepare(index))
      finishPreparation()
      bridge.stopVodAudio()
      const audio = bridge.startVodAudio()
      bridge.setVodAudioMuted(false)
      recording = await recorderFor(canvas, audio, store)
      await setReplayRun(log.initial)
      await settle(doc, 100, 1_000)
    }
    if (!recording) throw new Error('The Run VOD encoder did not start.')
    const audioCopies = new Map<RunVodAudioCue, RunVodAudioCue>()
    const audioStarts = new Map<string, number>()
    const syncAudio = () => {
      if (!offline) return
      for (const cue of capturedAudio.splice(0)) {
        const begin = audioStarts.get(cue.segment ?? 'initial')
        if (begin !== undefined) {
          const copy = { ...cue, at: begin + cue.at, end: undefined }
          audioCopies.set(cue, copy)
          cues.push(copy)
        } else capturedAudio.push(cue)
      }
      for (const [cue, copy] of audioCopies) {
        const end = cue.endSegment ? audioStarts.get(cue.endSegment) : undefined
        if (end !== undefined) {
          copy.end = end + cue.end!
          audioCopies.delete(cue)
        }
        else if (!cues.includes(copy)) audioCopies.delete(cue)
      }
    }
    const startAudioSegment = (segment: string) => {
      if (offline) audioStarts.set(segment, offline.time)
      syncAudio()
    }
    startAudioSegment('initial')
    const animate = async (duration: number, draw: (progress: number) => void) => {
      if (!offline) return animateRealtime(duration, draw)
      syncAudio()
      const count = Math.max(1, Math.round(duration * RUN_VOD_FPS / 1000))
      for (let index = 0; index < count; index++) {
        checkCancelled()
        draw((index + 1) / count)
        await offline.frame()
        await offline.audio()
      }
    }
    if (!offline) ui.update(`Encoding · 1080p / ${RUN_VOD_FPS} fps`, .8)
    if (!job || job.first) await animate(800, () => paint(ctx, current, position))
    let replayState = structuredClone(log.initial)
    let pulse = false
    let elapsedSinceAction = job && !job.first ? RUN_VOD_ACTION_HOLD_MS : Number.POSITIVE_INFINITY
    let lastClick: Point | null = null
    const playAction = async (action: VodActionGeometry, sprite: CanvasImageSource = current, background: CanvasImageSource = current) => {
      const samePlace = Boolean(lastClick && !action.drag && Math.hypot(
        lastClick.x - action.from.x, lastClick.y - action.from.y,
      ) < .001)
      const waitMs = runVodActionWait(elapsedSinceAction, samePlace)
      if (waitMs > 0) await animate(waitMs, progress => paint(ctx, current, position, pulse ? progress : 0))
      pulse = false
      const origin = position
      if (!samePlace) await animate(RUN_VOD_CURSOR_MS, progress => {
        const amount = ease(progress)
        position = { x: mix(origin.x, action.from.x, amount), y: mix(origin.y, action.from.y, amount) }
        paint(ctx, current, position)
      })
      pulse = true
      if (!offline) bridge!.playVodUiSound()
      paint(ctx, current, position, .01)
      if (action.drag) await animate(RUN_VOD_CURSOR_MS, progress => {
        const amount = ease(progress)
        position = { x: mix(action.from.x, action.to.x, amount), y: mix(action.from.y, action.to.y, amount) }
        paint(ctx, background, position, progress)
        ctx.save(); ctx.globalAlpha = .97; ctx.shadowColor = '#000c'; ctx.shadowBlur = 18
        ctx.drawImage(sprite, position.x * RUN_VOD_WIDTH - action.source.width / 2,
          position.y * RUN_VOD_HEIGHT - action.source.height / 2, action.source.width, action.source.height)
        ctx.restore(); cursor(ctx, position)
      })
      elapsedSinceAction = 0
      lastClick = action.drag ? null : action.from
    }
    if (offline) stream = {
      segment: startAudioSegment,
      async still(frame, milliseconds) {
        try {
          current.close()
          current = await createImageBitmap(frame)
          paint(ctx, current, position)
          if (milliseconds > 0) await animate(milliseconds, () => paint(ctx, current, position))
          elapsedSinceAction += milliseconds
        } finally { frame.width = frame.height = 0 }
      },
      async motion(frame, milliseconds) {
        await animate(milliseconds, () => paint(ctx, frame, position))
        elapsedSinceAction += milliseconds
      },
      async action(action, frame, sprite, background) {
        try {
          current.close()
          current = await createImageBitmap(frame)
          await playAction(action, sprite, background)
        } finally {
          for (const surface of [frame, sprite, background]) if (surface) surface.width = surface.height = 0
        }
      },
    }
    const playMotion = async (frames: MotionFrame[]) => {
      if (!frames.length) return 0
      const composite = document.createElement('canvas')
      composite.width = RUN_VOD_WIDTH
      composite.height = RUN_VOD_HEIGHT
      const surface = composite.getContext('2d')!
      surface.drawImage(current, 0, 0)
      let pending = store.read(frames[0]!.key)
      const started = performance.now()
      for (const [index, frame] of frames.entries()) {
        checkCancelled()
        const bitmap = await pending
        if (index + 1 < frames.length) pending = store.read(frames[index + 1]!.key)
        if (frame.tiles) for (const tile of frame.tiles) {
          surface.clearRect(tile.x, tile.y, tile.width, tile.height)
          surface.drawImage(bitmap, tile.sx, tile.sy, tile.width, tile.height, tile.x, tile.y, tile.width, tile.height)
        } else {
          surface.clearRect(0, 0, bitmap.width, bitmap.height)
          surface.drawImage(bitmap, 0, 0)
        }
        bitmap.close()
        const deadline = frames[index + 1]?.at ?? frame.at + 1_000 / 60
        const now = performance.now()
        await animate(Math.max(1, started + deadline - now), () => paint(ctx, composite, position))
      }
      current.close()
      current = await createImageBitmap(composite)
      composite.width = composite.height = 0
      return performance.now() - started
    }
    for (let index = 0; index < log.events.length; index += 1) {
      checkCancelled()
      if (stream) {
        await prepare(index)
        replayState = applyRunVodEvent(replayState, { patch: replayPatches.get(index)! })
        continue
      }
      const shape = geometries[index]!
      ui.update(`Encoding · ${index + 1} / ${log.events.length}`, .8 + .19 * index / log.events.length)
      const event = log.events[index]!
      bridge.setViewer(event.viewerId ?? log.initial.players[0]!.id)
      current.close()
      current = await store.read(index)
      const next = await store.read(index + 1)
      for (const [actionIndex, action] of shape.actions.entries()) {
        if (action.frame) {
          const frame = await store.read(action.frame)
          current.close()
          current = frame
          paint(ctx, current, position)
        }
        const background = action.background ? await store.read(action.background) : current
        const sprite = action.sprite ? await store.read(action.sprite) : current
        try { await playAction(action, sprite, background) }
        finally {
          if (background !== current) background.close()
          if (sprite !== current) sprite.close()
        }
        if (actionIndex === shape.actions.length - 1) {
          const nextState = replayPatches.has(index)
            ? applyRunVodEvent(replayState, { patch: replayPatches.get(index)! })
            : applyRunVodEvent(replayState, event)
          await setReplayRun(nextState)
        }
        elapsedSinceAction += await playMotion(action.motion ?? [])
      }
      replayState = replayPatches.has(index)
        ? applyRunVodEvent(replayState, { patch: replayPatches.get(index)! })
        : applyRunVodEvent(replayState, event)
      await setReplayRun(replayState)
      elapsedSinceAction += await playMotion(shape.motion)
      if (shape.motion.length > 0) await animate(RUN_VOD_CURSOR_MS, (progress) => {
        ctx.clearRect(0, 0, RUN_VOD_WIDTH, RUN_VOD_HEIGHT)
        ctx.globalAlpha = 1
        ctx.drawImage(current, 0, 0, RUN_VOD_WIDTH, RUN_VOD_HEIGHT)
        ctx.globalAlpha = progress
        ctx.drawImage(next, 0, 0, RUN_VOD_WIDTH, RUN_VOD_HEIGHT)
        ctx.globalAlpha = 1
        cursor(ctx, position)
      })
      if (shape.motion.length > 0) elapsedSinceAction += RUN_VOD_CURSOR_MS
      if (shape.actions.length === 0 && shape.motion.length === 0) await animate(RUN_VOD_CURSOR_MS, (progress) => {
          ctx.globalAlpha = 1
          ctx.drawImage(current, 0, 0, RUN_VOD_WIDTH, RUN_VOD_HEIGHT)
          ctx.globalAlpha = progress
          ctx.drawImage(next, 0, 0, RUN_VOD_WIDTH, RUN_VOD_HEIGHT)
          ctx.globalAlpha = 1
          cursor(ctx, position, pulse ? progress : 0)
        })
      if (shape.actions.length === 0 && shape.motion.length === 0) elapsedSinceAction += RUN_VOD_CURSOR_MS
      current.close()
      current = next
      paint(ctx, current, position)
    }
    if (offline) finishPreparation()
    if (!offline) await setReplayRun(replayState)
    if (!job || job.last) await animate(1_500, () => paint(ctx, current, position))
    else {
      await animate(runVodActionWait(elapsedSinceAction, false), () => paint(ctx, current, position))
      const origin = position
      await animate(RUN_VOD_CURSOR_MS, progress => {
        position = { x: mix(origin.x, .5, ease(progress)), y: mix(origin.y, .5, ease(progress)) }
        paint(ctx, current, position)
      })
    }
    current.close()
    if (replayRunJson(replayState) !== replayRunJson(expected)) {
      throw new Error(`The recorded replay diverged from the finished run (${firstDifference(
        replayComparableRun(replayState), replayComparableRun(expected),
      )}), so no misleading VOD was saved.`)
    }
    const extension = recording.extension
    const duration = offline?.time ?? 0
    syncAudio()
    checkCancelled()
    const video = await recording.finish()
    checkCancelled()
    recording = null
    bridge.setVodAudioMuted(true)
    bridge.stopVodAudio()
    const filename = `slay-the-spire-run-${expected.campaign.runId}.${extension}`
    job?.progress(1)
    if (!job) presentRunVod(video, filename, store)
    return { video, filename, duration, cues, cleanup: () => store.cleanup() }
  } catch (error) {
    await recording?.abort()
    bridge?.setVodAudioMuted(true)
    bridge?.stopVodAudio()
    await store.cleanup()
    if (error instanceof Error && error.name === 'QuotaExceededError') {
      throw new Error('The browser ran out of space for this VOD. Free storage or use a browser with more available space; your recorded run is preserved.')
    }
    throw error
  } finally {
    clock?.restore()
    releaseFrame()
    if (outputCanvas) { outputCanvas.width = outputCanvas.height = 0; outputCanvas.remove() }
    if (replayDoc) { replayClocks.delete(replayDoc); await releaseRunVodRaster(replayDoc) }
    ui.remove()
  }
}

function presentRunVod(video: Blob, filename: string, store: SnapshotStore) {
    const url = URL.createObjectURL(video)
    Object.assign(document.createElement('a'), { href: url, download: filename }).click()
    const player = document.createElement('dialog')
    player.className = 'run-vod-player'
    player.setAttribute('aria-label', 'Your completed Run VOD')
    player.dataset.runVodControl = ''
    const movie = document.createElement('video')
    movie.src = url
    movie.controls = true
    movie.preload = 'metadata'
    const close = document.createElement('button')
    close.className = 'run-vod-workbench__cancel'
    close.textContent = 'Close video'
    close.onclick = () => player.close()
    player.addEventListener('keydown', event => event.stopPropagation())
    player.addEventListener('close', () => {
      movie.pause()
      movie.removeAttribute('src')
      movie.load()
      URL.revokeObjectURL(url)
      player.remove()
      // Allow an already-started browser download to finish reading the file.
      window.setTimeout(() => { void store.cleanup() }, 60_000)
    }, { once: true })
    player.append(movie, close)
    document.body.append(player)
    player.showModal()
}
