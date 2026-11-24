import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { RunState } from '../game/run.ts'
import {
  CONTROL,
  INSPECTION,
  controlRef,
  gameplayControl,
  playRunLog,
  queryRunLogControl,
  type ReplayPace,
} from './run-log/replay.ts'
import {
  MAX_RUN_LOG_BYTES,
  RUN_PHASES,
  applyRunLogEvent,
  normalizeLegacyRunLog,
  normalizeRunLogChoice,
  parseRunLog,
  runLogEventChoice,
  validateRunLog,
  type ControlRef,
  type RunLog,
  type RunLogChoice,
  type RunLogEvent,
  type RunLogPatch,
} from './run-log/validate.ts'

export {
  MAX_RUN_LOG_BYTES,
  RUN_PHASES,
  applyRunLogEvent,
  parseRunLog,
  playRunLog,
  queryRunLogControl,
  runLogEventChoice,
  validateRunLog,
  type ReplayPace,
  type RunLog,
}

// Keep the shipped storage names so runs recorded before this feature remain downloadable.
const RUN_LOG_KEY = 'sts-run-vod'
const RUN_LOG_DATABASE = 'sts-run-vod-v2'
const CANCEL_CHOICE = /^(cancel|close|back(?: to (?:choices|run))?)$/i

let memoryLog: RunLog | null = null
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

function runLogDatabase() {
  if (database) return database
  database = new Promise((resolve) => {
    const request = indexedDB.open(RUN_LOG_DATABASE, 1)
    request.addEventListener('upgradeneeded', () => {
      request.result.createObjectStore('runs', { keyPath: 'runId' })
      request.result.createObjectStore('events', { keyPath: ['runId', 'index'] })
    }, { once: true })
    request.addEventListener('success', () => {
      request.result.addEventListener('versionchange', () => request.result.close())
      resolve(request.result)
    }, { once: true })
    request.addEventListener('error', () => resolve(null), { once: true })
  })
  return database
}

const eventRange = (runId: string) => IDBKeyRange.bound([runId, 0], [runId, Number.MAX_SAFE_INTEGER])

async function persistedLog(runId: string): Promise<RunLog | null> {
  if (memoryLog?.runId === runId) return (memoryLog = normalizeLegacyRunLog(memoryLog))
  const db = await runLogDatabase()
  if (!db) return null
  try {
    const transaction = db.transaction(['runs', 'events'], 'readonly')
    const run = await requested(transaction.objectStore('runs').get(runId)) as Omit<RunLog, 'events'> | undefined
    if (!run || run.version !== 2 || run.initial?.campaign.runId !== runId) return null
    const rows = await requested(transaction.objectStore('events').getAll(eventRange(runId))) as
      { runId: string; index: number; event: RunLogEvent }[]
    memoryLog = normalizeLegacyRunLog({ ...run, events: rows.sort((a, b) => a.index - b.index).map((row) => row.event) })
    return memoryLog
  } catch { return null }
}

export const readRunLog = (runId: string) => persistence.then(() => persistedLog(runId))

async function persistStart(log: RunLog) {
  const db = await runLogDatabase()
  if (!db) return
  const transaction = db.transaction(['runs', 'events'], 'readwrite')
  transaction.objectStore('runs').put({ version: log.version, runId: log.runId, initial: log.initial })
  transaction.objectStore('events').delete(eventRange(log.runId))
  await committed(transaction)
}

async function persistEvent(runId: string, index: number, event: RunLogEvent) {
  const db = await runLogDatabase()
  if (!db) return
  const transaction = db.transaction('events', 'readwrite')
  transaction.objectStore('events').put({ runId, index, event })
  await committed(transaction)
}

export async function startRunLog(run: RunState) {
  const log: RunLog = { version: 2, runId: run.campaign.runId, initial: structuredClone(run), events: [] }
  memoryLog = log
  try { localStorage.setItem(RUN_LOG_KEY, log.runId) } catch {}
  persistence = persistence.catch(() => {}).then(() => persistStart(log))
  try { await persistence; return true } catch { return false }
}

function statePatch(before: unknown, after: unknown, path: (string | number)[] = [], result: RunLogPatch[] = []): RunLogPatch[] {
  if (Object.is(before, after)) return result
  if (after === undefined) {
    result.push({ path, remove: true })
    return result
  }
  if (before === null || after === null || typeof before !== 'object' || typeof after !== 'object' || Array.isArray(before) !== Array.isArray(after)) {
    result.push({ path, value: structuredClone(after) })
    return result
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    if (['deck', 'draw', 'hand', 'discard', 'exhaust'].includes(String(path.at(-1)))) {
      if (JSON.stringify(before) !== JSON.stringify(after)) result.push({ path, value: structuredClone(after) })
      return result
    }
    for (let index = 0; index < Math.min(before.length, after.length); index += 1) statePatch(before[index], after[index], [...path, index], result)
    for (let index = before.length; index < after.length; index += 1) result.push({ path: [...path, index], value: structuredClone(after[index]) })
    for (let index = before.length - 1; index >= after.length; index -= 1) result.push({ path: [...path, index], remove: true })
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

export function discardRunLog(runId?: string) {
  const currentRunId = memoryLog?.runId ?? (() => {
    try { return localStorage.getItem(RUN_LOG_KEY) } catch { return null }
  })()
  if (runId && currentRunId !== runId) return
  memoryLog = null
  try { localStorage.removeItem(RUN_LOG_KEY) } catch {}
  if (currentRunId) persistence = persistence.then(async () => {
    const db = await runLogDatabase()
    if (!db) return
    const transaction = db.transaction(['runs', 'events'], 'readwrite')
    transaction.objectStore('runs').delete(currentRunId)
    transaction.objectStore('events').delete(eventRange(currentRunId))
    await committed(transaction)
  })
}

export function useRunLog(run: RunState, active: boolean, viewerId: string) {
  const log = useRef<RunLog | null>(null)
  const previous = useRef<RunState | null>(null)
  const pendingChoice = useRef<RunLogChoice | null>(null)
  const queuedEvents = useRef<RunLogEvent[]>([])
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
    if (!active) { previous.current = structuredClone(run); return }
    if (logReady && log.current?.runId === run.campaign.runId && queuedEvents.current.length) {
      for (const event of queuedEvents.current.splice(0)) {
        const index = log.current.events.push(event) - 1
        persistence = persistence.then(() => persistEvent(run.campaign.runId, index, event)).catch(() => {})
      }
      setAvailable(log.current.events.length > 0)
    }
    if (run.campaign.finalized) { previous.current = structuredClone(run); return }
    const patch = statePatch(before, run)
    previous.current = structuredClone(run)
    if (!patch.length) return
    const choice = normalizeRunLogChoice(pendingChoice.current)
    const rawEvent = { patch, ...(choice ? { choice } : {}), viewerId }
    const recordedChoice = runLogEventChoice(rawEvent, before)
    const event = { patch, ...(recordedChoice ? { choice: recordedChoice } : {}), viewerId }
    pendingChoice.current = null
    if (!logReady || !log.current || log.current.runId !== run.campaign.runId) {
      queuedEvents.current.push(event)
      setAvailable(false)
      return
    }
    const index = log.current.events.push(event) - 1
    setAvailable(true)
    persistence = persistence.then(() => persistEvent(run.campaign.runId, index, event)).catch(() => {})
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
          ? { ...current, steps: [...current.steps.slice(0, -1), ref] } : { ...current, source: ref }
        return
      }
      pendingChoice.current = { source: current.source, steps: [...(current.steps ?? []), ref], ...(current.target ? { target: current.target } : {}) }
    }
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest(INSPECTION)) { pendingChoice.current = null; down = null; return }
      const rawControl = event.target instanceof Element ? event.target.closest<HTMLElement>(CONTROL) : null
      if (rawControl?.closest('.pause-menu') && rawControl.textContent?.trim() !== 'Give up') { pendingChoice.current = null; down = null; return }
      const control = gameplayControl(event.target)
      down = control ? controlRef(control) : null
      if (down?.card) pendingChoice.current = null
    }
    const onPointerUp = (event: PointerEvent) => {
      const control = gameplayControl(document.elementFromPoint(event.clientX, event.clientY)) ?? gameplayControl(event.target)
      if (!down) return
      const targetRef = control ? controlRef(control) : null
      if (CANCEL_CHOICE.test(targetRef?.name ?? '')) pendingChoice.current = null
      else if (targetRef && targetRef.selector !== down.selector) {
        const staged = pendingChoice.current
        const last = staged?.steps?.at(-1) ?? staged?.source
        pendingChoice.current = last?.selector === down.selector
          ? { source: staged!.source, ...(staged!.steps ? { steps: staged!.steps } : {}), target: targetRef }
          : { source: staged?.source ?? down, ...(staged ? { steps: [...(staged.steps ?? []), down] } : {}), target: targetRef }
      } else append(down)
      down = null
    }
    const onClick = (event: MouseEvent) => {
      if (event.detail > 0 || event.target instanceof Element && event.target.closest(INSPECTION)) return
      const control = gameplayControl(event.target)
      if (!control) return
      const ref = controlRef(control)
      if (CANCEL_CHOICE.test(ref.name ?? '')) pendingChoice.current = null
      else append(ref)
    }
    const onChange = (event: Event) => { const control = gameplayControl(event.target); if (control) append(controlRef(control)) }
    const clear = () => { down = null; pendingChoice.current = null }
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') pendingChoice.current = null }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('pointerup', onPointerUp, true)
    document.addEventListener('pointercancel', clear, true)
    document.addEventListener('click', onClick, true)
    document.addEventListener('change', onChange, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('pointerup', onPointerUp, true)
      document.removeEventListener('pointercancel', clear, true)
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
  const discard = useCallback(() => { discardRunLog(run.campaign.runId); log.current = null; setAvailable(false) }, [run.campaign.runId])
  return { available, discard, load }
}

export function downloadRunLog(log: RunLog) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(normalizeLegacyRunLog(log))], { type: 'application/json' }))
  Object.assign(document.createElement('a'), { href: url, download: `slay-the-spire-run-${log.runId}.json` }).click()
  setTimeout(() => URL.revokeObjectURL(url))
}
