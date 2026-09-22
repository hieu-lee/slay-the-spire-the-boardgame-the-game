import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { assetPath } from '../game/assets.ts'
import { CARDS, cardDef } from '../game/cards.ts'
import { ENEMIES, isSummonGroup } from '../game/enemies.ts'
import { currentRoom } from '../game/map.ts'
import { DAILY_MODIFIERS } from '../game/meta.ts'
import { neowCard } from '../game/neow.ts'
import { POTIONS, RELICS } from '../game/relics.ts'
import type { RunState } from '../game/run.ts'
import { CAPS, CHARACTER_IDS } from '../game/types.ts'

// Keep the shipped storage names so runs recorded before this feature remain downloadable.
const RUN_LOG_KEY = 'sts-run-vod'
const RUN_LOG_DATABASE = 'sts-run-vod-v2'
const CONTROL = 'button, input, select, textarea, summary, [role="button"]'
const INSPECTION = '.map-peek, .map-peek__open, .card-collection, .compendium, .deck-peek__open, .game-settings, .settings-dialog, [data-pile], .pause-menu, .room:not(.room--reachable)'
const OPEN_INSPECTION = '.settings-dialog[open], .map-peek[open], .card-collection[open], .compendium'
const FORBIDDEN_PATH = new Set(['__proto__', 'prototype', 'constructor'])
const RUN_PHASES = new Set(['neow', 'map', 'combat', 'reward', 'betweenCombat', 'room', 'setup', 'victory', 'defeat'])
const ROOM_KINDS = new Set(['encounter', 'elite', 'event', 'campfire', 'treasure', 'merchant', 'boss'])
const TERMINAL_PHASES = new Set(['victory', 'defeat'])
const REPLAY_CURSOR_MS = 150
const REPLAY_REPEAT_CLICK_MS = 250
const REPLAY_ACTION_HOLD_MS = 1_000
const MAX_RUN_LOG_EVENTS = 10_000
const MAX_RUN_LOG_PATCHES = 100_000
const MAX_EVENT_PATCHES = 2_000
const MAX_CONTROL_REFS = 40_000
const MAX_CONTROL_TEXT = 2 * 1024 * 1024
const MAX_VALIDATION_WORK = 64 * 1024 * 1024
export const MAX_RUN_LOG_BYTES = 16 * 1024 * 1024
const MAX_STATE_COLLECTION = 512
const RECORDED_SELECTOR = /^(?:\.campfire__choices button|\.reward-screen__player > \.loot-choice:nth-of-type\([1-4]\)|\[data-(?:enemy-id|player-id|room|event-option|orb-slot)="(?:[A-Za-z0-9_-]|\\(?:[0-9A-Fa-f]{1,6} ?|.))+"\]|(?:#[A-Za-z_][A-Za-z0-9_-]*|[a-z][a-z0-9-]*)(?::nth-of-type\([1-9]\d{0,3}\))?)(?: > (?:#[A-Za-z_][A-Za-z0-9_-]*|[a-z][a-z0-9-]*)(?::nth-of-type\([1-9]\d{0,3}\))?)*$/

type Point = { x: number; y: number }
type ControlRef = { selector: string; name?: string; value?: string; checked?: boolean; drag?: true; card?: true; target?: true }
type RunLogChoice = { source: ControlRef; steps?: ControlRef[]; target?: ControlRef }
type RunLogPatch = { path: (string | number)[]; value?: unknown; remove?: true }
export type RunLogEvent = { patch: RunLogPatch[]; choice?: RunLogChoice; viewerId?: string }
export type RunLog = { version: 2; runId: string; initial: RunState; events: RunLogEvent[] }

function normalizeLegacyRunLog(log: RunLog): RunLog {
  let changed = false
  const events = log.events.map((event) => {
    let eventChanged = false
    const patch = event.patch.map((entry) => {
      if (entry.remove || entry.value !== undefined) return entry
      changed = eventChanged = true
      const { value: _value, ...rest } = entry
      return { ...rest, remove: true as const }
    })
    return eventChanged ? { ...event, patch } : event
  })
  return changed ? { ...log, events } : log
}

const CANCEL_CHOICE = /^(cancel|close|back(?: to (?:choices|run))?)$/i
const TURN_CONTROL = /^(End turn|Resolve (?:start|end)(?: of turn| turn \d+))$/
const semanticDeckMutation = (event: RunLogEvent) => Boolean(event.choice?.steps?.length && event.patch.some((change) =>
  change.path[0] === 'players' && change.path[2] === 'deck'))

function point(element: Element): Point {
  const box = element.getBoundingClientRect()
  const view = element.ownerDocument.defaultView ?? window
  return { x: (box.left + box.width / 2) / view.innerWidth, y: (box.top + box.height / 2) / view.innerHeight }
}

function selector(element: Element): string {
  for (const attribute of ['data-enemy-id', 'data-player-id', 'data-room', 'data-event-option', 'data-orb-slot']) {
    const value = element.getAttribute(attribute)
    if (value !== null) return `[${attribute}="${CSS.escape(value)}"]`
  }
  const parts: string[] = []
  for (let current: Element | null = element; current && current !== document.documentElement; current = current.parentElement) {
    if (current.id) { parts.unshift(`#${CSS.escape(current.id)}`); break }
    const siblings = current.parentElement
      ? [...current.parentElement.children].filter((candidate) => candidate.tagName === current!.tagName) : []
    parts.unshift(`${current.tagName.toLowerCase()}${siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : ''}`)
    if (current.matches('.app-shell, dialog')) break
  }
  return parts.join(' > ')
}

function controlName(element: HTMLElement) {
  const name = element.getAttribute('aria-label')?.trim() || element.textContent?.trim()
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

const semanticDeckUpgrade = (event: RunLogEvent, before: RunState) => {
  if (!semanticDeckMutation(event)) return false
  const after = applyRunLogEvent(before, event)
  let upgrades = 0
  return before.players.length === after.players.length && before.players.every((player, playerIndex) => {
    const next = after.players[playerIndex]!
    return player.deck.length === next.deck.length && player.deck.every((card, cardIndex) => {
      const changed = next.deck[cardIndex]!
      if (JSON.stringify(card) === JSON.stringify(changed)) return true
      if (!card.upgraded && changed.upgraded && JSON.stringify({ ...card, upgraded: true }) === JSON.stringify(changed)) {
        upgrades += 1
        return true
      }
      return false
    })
  }) && upgrades === 1
}

function normalizeRunLogChoice(choice: RunLogChoice | null | undefined) {
  const last = choice?.steps?.at(-1)
  return choice?.source.drag && last?.target
    ? { ...choice, steps: choice.steps?.slice(0, -1), target: last }
    : choice
}

export function runLogEventChoice(event: RunLogEvent, before: RunState): RunLogChoice | undefined {
  let choice = event.choice
  if (choice && choice.source.name !== 'Smith upgrade' && choice.steps?.at(-1)?.name === 'Confirm' &&
    before.phase === 'room' && !before.roomState && currentRoom(before.map)?.kind === 'campfire' && semanticDeckUpgrade(event, before)) {
    choice = { source: { selector: '.campfire__choices button', name: 'Smith upgrade' }, steps: [choice.source, ...choice.steps] }
  }
  const pendingRelic = before.players.find((player) => player.id === (event.viewerId ?? before.players[0]?.id))
    ?.relics.find((relic) => relic.pending)
  const pendingRewardCount = pendingRelic?.defId === 'forbidden_fruit' ? 2
    : pendingRelic?.defId === 'orrery' ? 4 : pendingRelic?.defId === 'tiny_house' ? 1 : 0
  if (choice && choice.source.name !== 'Add a card to your deck.' && /, cost /.test(choice.source.name ?? '') &&
    Object.keys(pendingRelic?.pendingRewardIndices ?? {}).length < pendingRewardCount) {
    const chosen = pendingRelic?.pendingRewardIndices ?? {}
    const outstanding = Array.from({ length: pendingRewardCount }, (_, index) => index).filter(index => !(index in chosen))
    const afterPending = applyRunLogEvent(before, event).players.find((player) => player.id === (event.viewerId ?? before.players[0]?.id))
      ?.relics.find((relic) => relic.pending)
    const reward = outstanding.find(index => index in (afterPending?.pendingRewardIndices ?? {})) ?? outstanding[0]!
    const ordinal = outstanding.indexOf(reward) + 1
    choice = { source: { selector: `.reward-screen__player > .loot-choice:nth-of-type(${ordinal})`, name: 'Add a card to your deck.' },
      steps: [choice.source, ...(choice.steps ?? [])] }
  }
  const handCard = (ref: ControlRef) => Boolean(ref.card || ref.drag && / > footer > .* > button/.test(ref.selector) && /, cost /.test(ref.name ?? ''))
  if (choice?.steps?.length && handCard(choice.source) && before.combat) {
    const after = applyRunLogEvent(before, event)
    const lastSeq = before.combat.presentationEvents?.at(-1)?.seq ?? 0
    const played = after.combat?.combatId === before.combat.combatId
      ? after.combat.presentationEvents?.filter((entry) => entry.seq > lastSeq && entry.kind === 'card' && !entry.copied &&
        entry.actorId === (event.viewerId ?? before.players[0]?.id)) ?? [] : []
    if (!played.length && choice.steps.some(ref => TURN_CONTROL.test(ref.name ?? ''))) {
      const first = choice.steps.findIndex(ref => !handCard(ref))
      return { source: choice.steps[first]!, steps: choice.steps.slice(first + 1) }
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
  return normalizeRunLogChoice(choice) ?? undefined
}

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

export function applyRunLogEvent(run: RunState, event: RunLogEvent): RunState {
  const next = structuredClone(run) as unknown
  const deckChanges = event.patch.filter((change) => change.path[0] === 'players' && change.path[2] === 'deck')
  for (const change of event.patch) {
    let path = change.path
    if (path.some((part) => typeof part === 'string' && FORBIDDEN_PATH.has(part))) throw new Error('Unsafe run log path.')
    if (semanticDeckMutation(event) && deckChanges.length === 1 && path.length === 5 &&
      path[4] === 'upgraded' && change.value === true && path[0] === 'players' && path[2] === 'deck' &&
      typeof path[1] === 'number' && typeof path[3] === 'number') {
      const deck = run.players[path[1]]?.deck ?? []
      const target = [...(event.choice?.steps ?? [])].reverse().find((step) => deck.some((card) =>
        step.name?.startsWith(cardDef(card.defId).name)))
      const matches = target ? deck.flatMap((card, index) => target.name?.startsWith(cardDef(card.defId).name) ? [index] : []) : []
      if (!matches.includes(path[3]) && matches.length === 1) path = [...path.slice(0, 3), matches[0]!, ...path.slice(4)]
      else if (!matches.includes(path[3]) && matches.length > 1) throw new Error('The legacy run log card choice is ambiguous.')
    }
    if (path.length === 0) return structuredClone(change.value) as RunState
    let owner = next as Record<string | number, unknown>
    for (const part of path.slice(0, -1)) {
      if (Array.isArray(owner) && (typeof part !== 'number' || part >= owner.length)) throw new Error('Invalid run log array path.')
      if (!owner[part] || typeof owner[part] !== 'object') throw new Error('Invalid run log path.')
      owner = owner[part] as Record<string | number, unknown>
    }
    const key = path.at(-1)!
    if (change.remove) {
      if (Array.isArray(owner)) {
        if (typeof key !== 'number' || key >= owner.length) throw new Error('Invalid run log array removal.')
        owner.splice(key, 1)
      } else delete owner[key]
    } else {
      if (Array.isArray(owner) && (typeof key !== 'number' || key > owner.length)) throw new Error('Invalid run log array insertion.')
      owner[key] = structuredClone(change.value)
    }
  }
  return next as RunState
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

function replayableControl(element: HTMLElement) {
  return element.matches(CONTROL) && !element.closest('[data-run-log-control], .settings-dialog, ' + INSPECTION)
}

function gameplayControl(target: EventTarget | null): HTMLElement | null {
  const element = target instanceof Element ? target.closest<HTMLElement>(CONTROL) : null
  return element && replayableControl(element) ? element : null
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

function validRef(value: unknown, selectors: Set<string>): value is ControlRef {
  if (!value || typeof value !== 'object') return false
  const ref = value as Record<string, unknown>
  if (typeof ref.selector !== 'string' || !RECORDED_SELECTOR.test(ref.selector) || ref.selector.length > 4_096) return false
  try { if (!selectors.has(ref.selector)) document.createDocumentFragment().querySelector(ref.selector) } catch { return false }
  selectors.add(ref.selector)
  return (
    (ref.name === undefined || typeof ref.name === 'string' && ref.name.length <= 4_096) &&
    (ref.value === undefined || typeof ref.value === 'string' && ref.value.length <= 4_096) &&
    (ref.checked === undefined || typeof ref.checked === 'boolean') &&
    (ref.drag === undefined || ref.drag === true) && (ref.card === undefined || ref.card === true) &&
    (ref.target === undefined || ref.target === true))
}

function validStateCollections(root: unknown) {
  const pending = [root]
  const seen = new Set<object>()
  let nodes = 0
  while (pending.length) {
    const value = pending.pop()
    if (typeof value === 'string' && value.length > 4_096) return false
    if (!value || typeof value !== 'object') continue
    if (seen.has(value)) continue
    seen.add(value)
    const children = Object.values(value)
    if (children.length > MAX_STATE_COLLECTION || (nodes += children.length) > 50_000) return false
    pending.push(...children)
  }
  return true
}

function validRunState(value: unknown, runId: string): value is RunState {
  if (!value || typeof value !== 'object' || !validStateCollections(value)) return false
  const state = value as Partial<RunState>
  const knownId = (id: unknown, definitions: Record<string, unknown>) => typeof id === 'string' && Object.hasOwn(definitions, id)
  const known = (ids: unknown, definitions: Record<string, unknown>) => Array.isArray(ids) && ids.length <= 512 &&
    ids.every((id) => knownId(id, definitions))
  const rng = (value: unknown) => Boolean(value && typeof value === 'object' &&
    Number.isInteger((value as { seed?: unknown }).seed) && (value as { seed: number }).seed >= 0 &&
    (value as { seed: number }).seed <= 0xffff_ffff && Number.isInteger((value as { calls?: unknown }).calls) &&
    (value as { calls: number }).calls >= 0 && ((value as { replayValues?: unknown }).replayValues === undefined ||
      Array.isArray((value as { replayValues?: unknown }).replayValues) &&
      (value as { replayValues: unknown[] }).replayValues.length <= 100_000 &&
      (value as { replayValues: unknown[] }).replayValues.every((entry) =>
        typeof entry === 'number' && Number.isFinite(entry) && entry >= 0 && entry < 1)))
  const knownRewardCards = (ids: unknown) => Array.isArray(ids) && ids.length <= 512 &&
    ids.every((id) => id === 'golden_ticket' || knownId(id, CARDS))
  const stringList = (value: unknown) => Array.isArray(value) && value.length <= 512 &&
    value.every((entry) => typeof entry === 'string')
  const rewardSources = (ids: unknown) => Array.isArray(ids) && ids.length <= CHARACTER_IDS.length + 1 &&
    ids.every((id) => id === 'colorless' || CHARACTER_IDS.includes(id))
  const rewardDraw = (value: unknown, soldSlots = false) => Boolean(value && typeof value === 'object' &&
    (soldSlots ? Array.isArray((value as { choices?: unknown }).choices) && (value as { choices: unknown[] }).choices.length <= 3 &&
      (value as { choices: unknown[] }).choices.every((id) => id === '' || id === 'golden_ticket' || knownId(id, CARDS))
      : knownRewardCards((value as { choices?: unknown }).choices)) &&
    knownRewardCards((value as { cardsDrawn?: unknown }).cardsDrawn) &&
    (value as { cardsDrawn: unknown[] }).cardsDrawn.length <= 32 &&
    knownRewardCards((value as { raresDrawn?: unknown }).raresDrawn) &&
    (value as { raresDrawn: unknown[] }).raresDrawn.length <= 32)
  const relic = (value: unknown) => {
    if (!value || typeof value !== 'object') return false
    const current = value as RunState['players'][number]['relics'][number]
    return knownId(current.defId, RELICS) && typeof current.spent === 'boolean' &&
      (current.uses === undefined || Number.isInteger(current.uses) && current.uses >= 0) &&
      (current.cubes === undefined || Number.isInteger(current.cubes) && current.cubes >= 0) &&
      (current.pending === undefined || typeof current.pending === 'boolean') &&
      (current.pendingId === undefined || Number.isInteger(current.pendingId) && current.pendingId >= 0) &&
      (current.guardianGemGroups === undefined || Array.isArray(current.guardianGemGroups) &&
        current.guardianGemGroups.every((group) => known(group, CARDS))) &&
      (current.pendingRewardDraws === undefined || Boolean(current.pendingRewardDraws &&
        knownRewardCards(current.pendingRewardDraws.cards) && knownRewardCards(current.pendingRewardDraws.rares))) &&
      (current.pendingRewardIndices === undefined || Boolean(current.pendingRewardIndices &&
        Object.entries(current.pendingRewardIndices).every(([index, choice]) =>
          Number.isInteger(Number(index)) && Number(index) >= 0 && Number.isInteger(choice))))
  }
  const cards = (ids: unknown) => Array.isArray(ids) && ids.length <= 512 && ids.every((card) => card && typeof card === 'object' &&
    typeof (card as { uid?: unknown }).uid === 'string' && typeof (card as { defId?: unknown }).defId === 'string' &&
    Object.hasOwn(CARDS, (card as { defId: string }).defId) && typeof (card as { upgraded?: unknown }).upgraded === 'boolean' &&
    ['endTurnProtected', 'retainedLastTurn', 'retainThisTurn', 'stasisRetained', 'freeThisTurn', 'growOnPlay', 'hermitDeadOn']
      .every((field) => (card as Record<string, unknown>)[field] === undefined || typeof (card as Record<string, unknown>)[field] === 'boolean') &&
    ['counter', 'costReductionThisTurn', 'scryDamageBonus'].every((field) =>
      (card as Record<string, unknown>)[field] === undefined || Number.isFinite((card as Record<string, unknown>)[field])) &&
    ((card as { attachedGemId?: unknown }).attachedGemId === undefined ||
      typeof (card as { attachedGemId?: unknown }).attachedGemId === 'string' &&
      Object.hasOwn(CARDS, (card as { attachedGemId: string }).attachedGemId)))
  const players = (value: unknown) => Array.isArray(value) && value.length === 1 && value.every((player) => {
    if (!player || typeof player !== 'object') return false
    const current = player as RunState['players'][number]
    const numeric = ['row', 'hp', 'maxHp', 'block', 'energy', 'gold', 'strength', 'strengthLossAtEndOfTurn',
      'vulnerable', 'weak', 'attacksPlayedThisTurn', 'shivs', 'shivDamageBonus', 'cardBlockBonus', 'hitPoison',
      'miracles', 'wrathAttackDamageBonus', 'chamberSlots', 'heat', 'soulburn', 'vigor', 'vigorSpentThisTurn'] as const
    const optionalNumeric = ['nextCardCost', 'enemyNextCardCost', 'nextAttackStrength', 'hpLostThisRound', 'hpLossLimitThisRound',
      'freeCardsThisTurn', 'freeAttacksThisTurn', 'freeGemCardsThisTurn', 'freePowersThisTurn', 'nextAttackRapidFire',
      'energySpentThisTurn', 'doubledAttacksThisTurn', 'akabekoAttacks', 'tripledAttacksThisTurn', 'doubledCardsThisTurn',
      'doubledSkillsThisTurn', 'retainCardsThisTurn', 'cardsPlayedThisTurn', 'starterStrikeDamageBonus',
      'clawCubesGainedThisCombat', 'starterDefendBlockBonus', 'holyWaterCubes', 'orbEvokeBonus', 'darkOrbEvokeBonus',
      'orbEndTurnBonus', 'lightningEndTurnBonus', 'nextSoulburnDamageBonus', 'lootChests']
    const optionalBoolean = ['shuffledThisCombat', 'cardPlayLocked', 'powerPlayedThisTurn', 'damageDealtZeroThisTurn',
      'calipersArmed', 'soulburnUsedThisTurn', 'guardianModeLocked']
    return typeof current.id === 'string' && typeof current.name === 'string' && CHARACTER_IDS.includes(current.character) &&
      numeric.every((field) => Number.isFinite(current[field])) && typeof current.drawLocked === 'boolean' &&
      current.hp >= 0 && current.hp <= current.maxHp && current.maxHp >= 1 && current.maxHp <= 1_000 &&
      current.block >= 0 && current.block <= CAPS.block && current.energy >= 0 && current.energy <= CAPS.energy &&
      current.strength >= 0 && current.strength <= CAPS.strength && current.vulnerable >= 0 && current.vulnerable <= CAPS.vulnerable &&
      current.weak >= 0 && current.weak <= CAPS.weak && current.shivs >= 0 && current.shivs <= CAPS.shivs &&
      current.attacksPlayedThisTurn >= 0 && current.attacksPlayedThisTurn <= 512 &&
      current.miracles >= 0 && current.miracles <= CAPS.miracles && current.heat >= 0 && current.heat <= CAPS.heat &&
      current.soulburn >= 0 && current.soulburn <= CAPS.soulburn && current.vigor >= 0 && current.vigor <= 4 &&
      current.vigorSpentThisTurn >= 0 && current.vigorSpentThisTurn <= 4 &&
      optionalNumeric.every((field) => current[field as keyof typeof current] === undefined || current[field as keyof typeof current] === null ||
        Number.isFinite(current[field as keyof typeof current])) &&
      (current.nextAttackRapidFire === undefined || current.nextAttackRapidFire === null ||
        Number.isInteger(current.nextAttackRapidFire) && current.nextAttackRapidFire >= 0 && current.nextAttackRapidFire <= 32) &&
      optionalBoolean.every((field) => current[field as keyof typeof current] === undefined || typeof current[field as keyof typeof current] === 'boolean') &&
      typeof current.lostHpThisCombat === 'boolean' && typeof current.dead === 'boolean' &&
      ['neutral', 'calm', 'wrath'].includes(current.stance) && Array.isArray(current.orbs) && current.orbs.length <= 32 &&
      current.orbs.every((orb) => orb === null || ['lightning', 'frost', 'dark'].includes(orb)) &&
      (current.guardianMode === null || current.guardianMode === 'attack' || current.guardianMode === 'defense') &&
      (current.facingEnemyUid === undefined || current.facingEnemyUid === null || typeof current.facingEnemyUid === 'string') &&
      (current.nextPowerOrSlimeDiscount === undefined || current.nextPowerOrSlimeDiscount === 'free' || Number.isFinite(current.nextPowerOrSlimeDiscount)) &&
      (current.exhaustNextCardAfterUid === undefined || typeof current.exhaustNextCardAfterUid === 'string') &&
      (current.damageStats === undefined || current.damageStats && ['attack', 'poison', 'special', 'taken', 'blocked']
        .every((field) => Number.isFinite(current.damageStats![field as keyof typeof current.damageStats]))) &&
      [current.deck, current.draw, current.hand, current.discard, current.exhaust, current.powers, current.chamber].every(cards) &&
      Array.isArray(current.relics) && current.relics.length <= 256 && current.relics.every(relic) &&
      Array.isArray(current.potions) && current.potions.length <= 32 && known(current.potions, POTIONS) &&
      knownRewardCards(current.cardRewards) && knownRewardCards(current.rareRewards) &&
      Array.isArray(current.slimes) && current.slimes.length <= 32 && current.slimes.every((slime) => slime && cards([slime.card]) &&
        ['level', 'vigor', 'commandsThisTurn', 'vigorLossAtEndOfTurn'].every((field) =>
          Number.isFinite(slime[field as keyof typeof slime])) &&
        slime.level >= 1 && slime.level <= 6 && slime.vigor >= 0 && slime.vigor <= 8 &&
        slime.commandsThisTurn >= 0 && slime.commandsThisTurn <= 64 &&
        slime.vigorLossAtEndOfTurn >= 0 && slime.vigorLossAtEndOfTurn <= 8 &&
        (slime.vigorTriggerUsedThisTurn === undefined || typeof slime.vigorTriggerUsedThisTurn === 'boolean'))
  })
  const enemies = (value: unknown) => Array.isArray(value) && value.length <= 64 && value.every((enemy) => {
    if (!enemy || typeof enemy !== 'object') return false
    const current = enemy as RunState['combat'] extends infer Combat | null
      ? Combat extends { enemies: (infer Enemy)[] } ? Enemy : never : never
    return typeof current.uid === 'string' && knownId(current.defId, ENEMIES) &&
      ['row', 'hp', 'maxHp', 'block', 'strength', 'vulnerable', 'weak', 'poison', 'goldReward', 'actionIndex']
        .every((field) => Number.isFinite(current[field as keyof typeof current])) &&
      typeof current.isBoss === 'boolean' && typeof current.abilityUsed === 'boolean' && typeof current.dead === 'boolean' &&
      (current.cardReward === null || current.cardReward === 'normal' || current.cardReward === 'upgraded') &&
      (current.pendingDefId === undefined || knownId(current.pendingDefId, ENEMIES)) &&
      (current.actsLast === undefined || typeof current.actsLast === 'boolean') &&
      (current.ascension === undefined || Number.isFinite(current.ascension)) &&
      (current.poisonSources === undefined || Boolean(current.poisonSources &&
        Object.values(current.poisonSources).every(Number.isFinite))) &&
      (current.corpseExplosion === undefined || Boolean(current.corpseExplosion && cards([current.corpseExplosion.card]) &&
        typeof current.corpseExplosion.playerId === 'string' && Number.isFinite(current.corpseExplosion.damage))) &&
      (current.hermitBounties === undefined || Array.isArray(current.hermitBounties) && current.hermitBounties.every((bounty) =>
        bounty && cards([bounty.card]) && typeof bounty.playerId === 'string')) &&
      (current.potionReward === undefined || typeof current.potionReward === 'boolean') &&
      (current.relicReward === undefined || typeof current.relicReward === 'boolean') &&
      (current.phase === undefined || Number.isFinite(current.phase)) &&
      (current.spentOnceSlots === undefined || Array.isArray(current.spentOnceSlots) && current.spentOnceSlots.every(Number.isInteger)) &&
      (current.abilityCubes === undefined || Number.isFinite(current.abilityCubes))
  })
  const encounterDeck = (value: unknown) => Array.isArray(value) && value.length <= 256 && value.every((entry) => entry && typeof entry === 'object' &&
    typeof (entry as { defId?: unknown }).defId === 'string' && Object.hasOwn(ENEMIES, (entry as { defId: string }).defId) &&
    Number.isFinite((entry as { goldReward?: unknown }).goldReward) &&
    ((entry as { cardReward?: unknown }).cardReward === null || ['normal', 'upgraded'].includes((entry as { cardReward: string }).cardReward)) &&
    ((entry as { potionReward?: unknown }).potionReward === undefined || typeof (entry as { potionReward?: unknown }).potionReward === 'boolean') &&
    ((entry as { relicReward?: unknown }).relicReward === undefined || typeof (entry as { relicReward?: unknown }).relicReward === 'boolean') &&
    ((entry as { summons?: unknown }).summons === undefined || Array.isArray((entry as { summons: unknown }).summons) &&
      (entry as { summons: unknown[] }).summons.length <= 32 &&
      (entry as { summons: unknown[] }).summons.every((group) => typeof group === 'string' && isSummonGroup(group))) &&
    ((entry as { summonsPerPlayer?: unknown }).summonsPerPlayer === undefined ||
      Array.isArray((entry as { summonsPerPlayer: unknown }).summonsPerPlayer) &&
      (entry as { summonsPerPlayer: unknown[] }).summonsPerPlayer.length <= 32 &&
      (entry as { summonsPerPlayer: unknown[] }).summonsPerPlayer.every((group) => typeof group === 'string' && isSummonGroup(group))) &&
    ['randomSummons', 'randomSummonsPerPlayer'].every((field) => {
      const random = (entry as Record<string, unknown>)[field]
      return random === undefined || Boolean(random && typeof random === 'object' &&
        typeof (random as { group?: unknown }).group === 'string' && isSummonGroup((random as { group: string }).group) &&
        Number.isInteger((random as { count?: unknown }).count) && (random as { count: number }).count >= 0 &&
        (random as { count: number }).count <= 32 && ((random as { soloCount?: unknown }).soloCount === undefined ||
          Number.isInteger((random as { soloCount?: unknown }).soloCount) && (random as { soloCount: number }).soloCount >= 0 &&
          (random as { soloCount: number }).soloCount <= 32))
    }) &&
    ((entry as { minAscension?: unknown }).minAscension === undefined || Number.isFinite((entry as { minAscension?: unknown }).minAscension)) &&
    ((entry as { maxAscension?: unknown }).maxAscension === undefined || Number.isFinite((entry as { maxAscension?: unknown }).maxAscension)))
  const prismaticDraws = (draws: unknown) => Array.isArray(draws) && draws.length <= 64 && draws.every((draw) => draw && typeof draw === 'object' &&
    rewardSources([(draw as { source?: unknown }).source]) && knownId((draw as { cardId?: unknown }).cardId, CARDS) &&
    ((draw as { rareId?: unknown }).rareId === undefined || knownId((draw as { rareId?: unknown }).rareId, CARDS)))
  const rewardsValid = Array.isArray(state.rewards) && state.rewards.length <= 64 && state.rewards.every((reward) => reward && typeof reward === 'object' &&
    typeof reward.playerId === 'string' && state.players?.some((player) => player.id === reward.playerId) &&
    (reward.gold === undefined || reward.gold === false || Number.isFinite(reward.gold) && reward.gold >= 0) &&
    typeof reward.cardReward === 'boolean' && (reward.choices === null || knownRewardCards(reward.choices)) &&
    typeof reward.upgraded === 'boolean' && (reward.rareChoiceIndices === undefined || Array.isArray(reward.rareChoiceIndices) &&
      reward.rareChoiceIndices.every((index) => Number.isInteger(index) && index >= 0)) &&
    (reward.cardsDrawn === undefined || knownRewardCards(reward.cardsDrawn)) &&
    (reward.raresDrawn === undefined || knownRewardCards(reward.raresDrawn)) &&
    (reward.drawsReserved === undefined || typeof reward.drawsReserved === 'boolean') &&
    (reward.cardSource === undefined || reward.cardSource === 'ordinary' || reward.cardSource === 'rare') &&
    (reward.prismatic === undefined || typeof reward.prismatic === 'boolean') &&
    (reward.availableSources === undefined || rewardSources(reward.availableSources)) &&
    (reward.prismaticSources === undefined || rewardSources(reward.prismaticSources)) &&
    (reward.prismaticDraws === undefined || prismaticDraws(reward.prismaticDraws)) &&
    (reward.transformReward === undefined || typeof reward.transformReward === 'boolean') &&
    (reward.potion === false || reward.potion === null || knownId(reward.potion, POTIONS)) &&
    (reward.potionQueue === undefined || Array.isArray(reward.potionQueue) &&
      reward.potionQueue.every((id) => id === null || knownId(id, POTIONS))) &&
    (reward.relic === false || reward.relic === null || knownId(reward.relic, RELICS)) &&
    (reward.bossRelics === false || known(reward.bossRelics, RELICS)) &&
    (reward.guardianGems === undefined || known(reward.guardianGems, CARDS)))
  const mapRooms = state.map?.rooms
  const mapValid = Boolean(mapRooms && typeof mapRooms === 'object' && !Array.isArray(mapRooms) &&
    Object.keys(mapRooms).length <= 512 && Array.isArray(state.map?.rows) && state.map.rows.length <= 32 &&
    state.map.rows.every((row) => Array.isArray(row) && row.length <= 16 &&
      row.every((id) => typeof id === 'string' && Object.hasOwn(mapRooms, id))) &&
    Object.entries(mapRooms).every(([id, room]) => room && typeof room === 'object' && room.id === id &&
      ROOM_KINDS.has(room.kind) && Number.isInteger(room.row) && Number.isInteger(room.column) &&
      typeof room.visited === 'boolean' && Array.isArray(room.exits) && room.exits.length <= 16 &&
      room.exits.every((exit) => typeof exit === 'string' && Object.hasOwn(mapRooms, exit))) &&
    (state.map?.position === null || typeof state.map?.position === 'string' && Object.hasOwn(mapRooms, state.map.position)))
  const eventTags = new Set(['card-reward', 'combat', 'discard-redraw-event', 'full-heal', 'gain-curse', 'gain-gold',
    'gain-potion', 'gain-relic', 'heal', 'apply-vulnerable', 'lose-gold', 'lose-hp', 'lose-max-hp', 'lose-potion',
    'lose-relic', 'merchant', 'move', 'mode-shift', 'nothing', 'pay-gold', 'rare-reward', 'remove-card',
    'remove-curses', 'roll-d6', 'trade-card', 'trade-relic', 'transform-card', 'upgrade-card'])
  const eventEffect = (effect: unknown, depth = 0): boolean => {
    if (!effect || typeof effect !== 'object' || depth > 2) return false
    const current = effect as Record<string, unknown>
    if (!eventTags.has(current.tag as string) || current.amount !== undefined &&
      !(Number.isFinite(current.amount) || ['all', 'full', 'relic-cost'].includes(current.amount as string)) ||
      current.count !== undefined && (!Number.isInteger(current.count) || (current.count as number) < 0 || (current.count as number) > 32) ||
      current.target !== undefined && !['self', 'one-player', 'each-player', 'party'].includes(current.target as string) ||
      current.source !== undefined && !['character', 'other-character', 'rare', 'colorless'].includes(current.source as string) ||
      current.room !== undefined && !['encounter', 'elite', 'merchant'].includes(current.room as string) ||
      current.random !== undefined && typeof current.random !== 'boolean' ||
      current.filter !== undefined && typeof current.filter !== 'string' ||
      current.perPriorChoice !== undefined && typeof current.perPriorChoice !== 'boolean' ||
      current.combatStart !== undefined && typeof current.combatStart !== 'boolean' ||
      current.combatReward !== undefined && current.combatReward !== 'relic-each-player') return false
    return current.results === undefined || Boolean(current.results && typeof current.results === 'object' &&
      Object.entries(current.results).every(([face, effects]) => /^[1-6]$/.test(face) && Array.isArray(effects) && effects.length <= 32 &&
        effects.every((nested) => eventEffect(nested, depth + 1))))
  }
  const eventCard = (card: unknown) => Boolean(card && typeof card === 'object' &&
    typeof (card as { id?: unknown }).id === 'string' && typeof (card as { instanceId?: unknown }).instanceId === 'string' &&
    typeof (card as { name?: unknown }).name === 'string' && Array.isArray((card as { options?: unknown }).options) &&
    (card as { options: unknown[] }).options.length <= 32 &&
    (card as { options: unknown[] }).options.every((option) => option && typeof option === 'object' &&
      typeof (option as { id?: unknown }).id === 'string' && typeof (option as { label?: unknown }).label === 'string' &&
      typeof (option as { description?: unknown }).description === 'string' && Array.isArray((option as { effects?: unknown }).effects) &&
      (option as { effects: unknown[] }).effects.length <= 32 &&
      (option as { effects: unknown[] }).effects.every((effect) => eventEffect(effect))))
  const neowRewardKinds = new Set(['card', 'rare', 'colorless', 'potion', 'relic'])
  const neowOffer = (offer: unknown) => {
    if (!offer || typeof offer !== 'object') return false
    const current = offer as Record<string, unknown>
    const choices = current.kind === 'potion' ? known(current.choices, POTIONS)
      : current.kind === 'relic' ? known(current.choices, RELICS) : knownRewardCards(current.choices)
    const draws = current.kind === 'potion' ? (ids: unknown) => known(ids, POTIONS)
      : current.kind === 'relic' ? (ids: unknown) => known(ids, RELICS) : knownRewardCards
    return neowRewardKinds.has(current.kind as string) && choices && draws(current.cardsDrawn) &&
      draws(current.raresDrawn) && (current.upgraded === undefined || typeof current.upgraded === 'boolean') &&
      (current.look === undefined || current.look === 3 || current.look === 5) &&
      (current.prismaticDraws === undefined || prismaticDraws(current.prismaticDraws)) &&
      (current.guardianGems === undefined || known(current.guardianGems, CARDS))
  }
  const neowEffect = (effect: unknown) => {
    if (!effect || typeof effect !== 'object') return false
    const current = effect as Record<string, unknown>
    if (!['upgrade', 'remove', 'transform', 'gold', 'loseGold', 'loseHp', 'loseMaxHp', 'reward', 'randomRare',
      'randomCards', 'relic', 'potions', 'curse'].includes(current.kind as string)) return false
    if (['upgrade', 'remove', 'transform'].includes(current.kind as string))
      return (current.count === 1 || current.count === 2) &&
        (current.random === undefined || typeof current.random === 'boolean') &&
        (current.starter === undefined || current.starter === 'strike' || current.starter === 'defend') &&
        (current.upgrade === undefined || typeof current.upgrade === 'boolean')
    if (['gold', 'loseGold', 'loseHp', 'loseMaxHp'].includes(current.kind as string)) return Number.isFinite(current.amount)
    if (current.kind === 'reward') return neowRewardKinds.has(current.reward as string) && [1, 2, 3].includes(current.count as number) &&
      (current.look === undefined || current.look === 3 || current.look === 5) &&
      (current.upgraded === undefined || typeof current.upgraded === 'boolean')
    if (current.kind === 'randomCards') return (current.source === 'card' || current.source === 'colorless') &&
      (current.count === 1 || current.count === 2) && (current.upgraded === undefined || typeof current.upgraded === 'boolean')
    if (current.kind === 'relic') return current.choices === undefined || current.choices === 1 || current.choices === 3
    if (current.kind === 'potions') return [1, 2, 3].includes(current.count as number)
    return current.kind === 'curse' || current.kind === 'randomRare' &&
      (current.upgraded === undefined || typeof current.upgraded === 'boolean')
  }
  const neowValid = Boolean(state.neow && Array.isArray(state.neow.deck) && state.neow.deck.every((id) =>
    typeof id === 'string' && Boolean(neowCard(id))) && (state.neow.heartDeck === undefined ||
      Array.isArray(state.neow.heartDeck) && state.neow.heartDeck.every((id) => typeof id === 'string' && Boolean(neowCard(id)))) &&
    state.neow.players && typeof state.neow.players === 'object' &&
    Object.entries(state.neow.players).every(([playerId, progress]) => state.players?.some((player) => player.id === playerId) &&
      progress && typeof progress.cardId === 'string' && Boolean(neowCard(progress.cardId)) &&
      typeof progress.redGoldPending === 'boolean' && typeof progress.redRewardPending === 'boolean' &&
      (progress.redRewardsRemaining === undefined || Number.isInteger(progress.redRewardsRemaining) && progress.redRewardsRemaining >= 0) &&
      (progress.redReward === null || neowOffer(progress.redReward)) &&
      (progress.blueOption === null || Number.isInteger(progress.blueOption) && progress.blueOption >= 0) &&
      (progress.pendingEffect === null || neowEffect(progress.pendingEffect)) &&
      (progress.transformExcludedUids === undefined || Array.isArray(progress.transformExcludedUids) &&
        progress.transformExcludedUids.every((id) => typeof id === 'string')) &&
      (progress.transformRemaining === undefined || Number.isInteger(progress.transformRemaining) && progress.transformRemaining >= 0) &&
      (progress.rewardKind === null || neowRewardKinds.has(progress.rewardKind)) &&
      (progress.rewardRequest === undefined || Boolean(progress.rewardRequest &&
        (progress.rewardRequest.look === undefined || progress.rewardRequest.look === 3 || progress.rewardRequest.look === 5) &&
        (progress.rewardRequest.upgraded === undefined || typeof progress.rewardRequest.upgraded === 'boolean') &&
        (progress.rewardRequest.relicChoices === undefined || progress.rewardRequest.relicChoices === 1 || progress.rewardRequest.relicChoices === 3))) &&
      (progress.reward === null || neowOffer(progress.reward)) && Array.isArray(progress.rewardQueue) &&
      progress.rewardQueue.every((queued) => typeof queued === 'string' ? neowRewardKinds.has(queued) : neowEffect(queued)) &&
      typeof progress.done === 'boolean'))
  const eventDecision = (value: unknown) => {
    if (!value || typeof value !== 'object') return false
    const decision = value as Record<string, unknown>
    return stringList(decision.optionIds) &&
      ['cardUids', 'relicIds', 'potionIds', 'potionRecipientIds', 'guardianGemIds', 'rewardItemIds']
        .every((field) => decision[field] === undefined || stringList(decision[field])) &&
      ['potionRecipientId', 'targetPlayerId', 'receiveCardUid', 'receiveRelicId', 'roomId']
        .every((field) => decision[field] === undefined || typeof decision[field] === 'string') &&
      (decision.rewardIndexes === undefined || Array.isArray(decision.rewardIndexes) && decision.rewardIndexes.every(Number.isInteger)) &&
      (decision.rewardSources === undefined || rewardSources(decision.rewardSources)) &&
      (decision.payments === undefined || Boolean(decision.payments && typeof decision.payments === 'object' &&
        Object.values(decision.payments).every(Number.isFinite))) &&
      (decision.rewardItemChoices === undefined || Array.isArray(decision.rewardItemChoices) &&
        decision.rewardItemChoices.every((choice) => choice === 'take' || choice === 'skip')) &&
      (decision.rewardItemKinds === undefined || Array.isArray(decision.rewardItemKinds) &&
        decision.rewardItemKinds.every((kind) => kind === 'relic' || kind === 'potion')) &&
      (decision.potionReplacementIds === undefined || Array.isArray(decision.potionReplacementIds) &&
        decision.potionReplacementIds.every((id) => id === null || knownId(id, POTIONS)))
  }
  const recordOf = (value: unknown, predicate: (entry: unknown) => boolean) => Boolean(value && typeof value === 'object' &&
    !Array.isArray(value) && Object.keys(value).length <= 64 && Object.values(value).every(predicate))
  const room = state.roomState
  const roomValid = (() => {
    if (room === null) return true
    if (!room) return false
    if (room.kind === 'merchant') return Array.isArray(room.relics) && room.relics.length <= 3 &&
      Array.isArray(room.potions) && room.potions.length <= 3 && Array.isArray(room.colorless) && room.colorless.length <= 3 &&
      known(room.relics.filter(Boolean), RELICS) && known(room.potions.filter(Boolean), POTIONS) &&
      known(room.colorless.filter(Boolean), CARDS) && room.cards && typeof room.cards === 'object' &&
      Object.values(room.cards).every((draw) => rewardDraw(draw, true)) && Array.isArray(room.removalUsed) &&
      room.removalUsed.every((id) => typeof id === 'string') && room.purchasedCards && typeof room.purchasedCards === 'object' &&
      Object.values(room.purchasedCards).every((ids) => known(ids, CARDS)) &&
      room.guardianGems && typeof room.guardianGems === 'object' && Object.values(room.guardianGems).every((ids) => known(ids, CARDS)) &&
      room.socketCardsBought && typeof room.socketCardsBought === 'object' &&
      Object.values(room.socketCardsBought).every((count) => Number.isInteger(count) && count >= 0)
    if (room.kind === 'treasure' || room.kind === 'elite') return room.offers && typeof room.offers === 'object' &&
      !Array.isArray(room.offers) && Object.keys(room.offers).length <= (state.players?.length ?? 0) &&
      Array.isArray(room.playerIds) && room.playerIds.length > 0 && room.playerIds.length <= (state.players?.length ?? 0) &&
      new Set(room.playerIds).size === room.playerIds.length &&
      room.playerIds.every((id) => typeof id === 'string' && state.players?.some((player) => player.id === id)) &&
      room.decisions && typeof room.decisions === 'object' && !Array.isArray(room.decisions) &&
      Object.entries(room.decisions).every(([playerId, decision]) => room.playerIds.includes(playerId) &&
        (decision === 'take' || decision === 'skip' || decision === 'sapphire' ||
          Number.isInteger(decision) && decision >= 0 && decision < (room.sharedOffers?.length ?? 0))) &&
      (room.sharedOffers === undefined || Array.isArray(room.sharedOffers) && room.sharedOffers.length <= 32) &&
      known([...Object.values(room.offers), ...(room.sharedOffers ?? [])].filter(Boolean), RELICS)
    if (room.kind === 'event') return Boolean(eventCard(room.card) && recordOf(room.decisions, eventDecision) &&
      recordOf(room.dieRolls, (rolls) => Array.isArray(rolls) && rolls.every(Number.isFinite)) &&
      (room.rewardOffers === undefined || recordOf(room.rewardOffers, (groups) => Array.isArray(groups) && groups.length <= 32 &&
        groups.every(knownRewardCards))) &&
      (room.guardianGemOffers === undefined || recordOf(room.guardianGemOffers, (groups) => Array.isArray(groups) && groups.length <= 32 &&
        groups.every((group) => known(group, CARDS)))) &&
      (room.pendingGuardianGemGroups === undefined || recordOf(room.pendingGuardianGemGroups, (groups) => Array.isArray(groups) && groups.length <= 32 &&
        groups.every((group) => known(group, CARDS)))) &&
      (room.pendingGuardianGemIds === undefined || recordOf(room.pendingGuardianGemIds, (ids) => known(ids, CARDS))) &&
      (room.rewardDraws === undefined || recordOf(room.rewardDraws, prismaticDraws)) &&
      (room.availableRewardSources === undefined || Boolean(room.availableRewardSources &&
        rewardSources(room.availableRewardSources.card) && rewardSources(room.availableRewardSources.rare))) &&
      (room.itemOffers === undefined || recordOf(room.itemOffers, (offers) => Array.isArray(offers) && offers.length <= 32 && offers.every((offer) =>
        offer && (offer.kind === 'relic' && knownId(offer.id, RELICS) || offer.kind === 'potion' && knownId(offer.id, POTIONS))))) &&
      (room.pendingDecisions === undefined || recordOf(room.pendingDecisions, eventDecision)) &&
      (room.pendingRolls === undefined || recordOf(room.pendingRolls, (rolls) => Array.isArray(rolls) && rolls.every(Number.isFinite))) &&
      (room.revealedCards === undefined || recordOf(room.revealedCards, stringList)) &&
      (room.revealedCardDefs === undefined || recordOf(room.revealedCardDefs, (ids) => known(ids, CARDS))) &&
      (room.revealedRelics === undefined || recordOf(room.revealedRelics, (id) => knownId(id, RELICS))) &&
      (room.partyOptionIds === undefined || stringList(room.partyOptionIds)) &&
      (room.preparedStartTurnScryAbilities === undefined || Array.isArray(room.preparedStartTurnScryAbilities) &&
        room.preparedStartTurnScryAbilities.length <= 32 &&
        room.preparedStartTurnScryAbilities.every((ability) => ability && typeof ability.id === 'string' &&
          typeof ability.playerId === 'string' && typeof ability.label === 'string' && Number.isFinite(ability.amount))) &&
      (room.preparedStartTurnScry === undefined || Boolean(room.preparedStartTurnScry &&
        typeof room.preparedStartTurnScry.id === 'string' && typeof room.preparedStartTurnScry.playerId === 'string' &&
        typeof room.preparedStartTurnScry.label === 'string' && Number.isFinite(room.preparedStartTurnScry.amount) &&
        (room.preparedStartTurnScry.cards === null || cards(room.preparedStartTurnScry.cards)))) &&
      (room.preparedStartTurnCoordinatorId === undefined || room.preparedStartTurnCoordinatorId === null ||
        typeof room.preparedStartTurnCoordinatorId === 'string') &&
      (room.pendingTrade === undefined || Boolean(room.pendingTrade && ['card', 'relic'].includes(room.pendingTrade.kind) &&
        typeof room.pendingTrade.actorId === 'string' && typeof room.pendingTrade.targetId === 'string' &&
        typeof room.pendingTrade.offeredId === 'string' && eventDecision(room.pendingTrade.decision))) &&
      (room.labChoices === undefined || recordOf(room.labChoices, eventDecision)))
    return false
  })()
  const courierValid = Boolean(state.courier && typeof state.courier === 'object' && Array.isArray(state.courier.usedBy) &&
    state.courier.usedBy.every((id) => typeof id === 'string') && (state.courier.offer === null ||
      state.courier.offer && typeof state.courier.offer.playerId === 'string' &&
      (state.courier.offer.kind === 'relic' && knownId(state.courier.offer.id, RELICS) ||
        state.courier.offer.kind === 'potion' && knownId(state.courier.offer.id, POTIONS))))
  const presentationEvent = (event: RunState['combat'] extends infer Combat | null
    ? Combat extends { presentationEvents: (infer Entry)[] } ? Entry : never : never) => {
    if (!event || !Number.isFinite(event.seq) || typeof event.actorId !== 'string' || typeof event.sourceId !== 'string' ||
      !Array.isArray(event.enemyIds) || event.enemyIds.length > 64 || !event.enemyIds.every((id) => typeof id === 'string') ||
      !Array.isArray(event.playerIds) || event.playerIds.length > 1 || !event.playerIds.every((id) => typeof id === 'string') ||
      event.enemyRow !== undefined && !Number.isFinite(event.enemyRow) ||
      event.enemyHpLoss !== undefined && (!event.enemyHpLoss || typeof event.enemyHpLoss !== 'object' ||
        Array.isArray(event.enemyHpLoss) || Object.keys(event.enemyHpLoss).length > 64 ||
        !Object.values(event.enemyHpLoss).every(Number.isFinite))) return false
    if (event.kind === 'card') return knownId(event.sourceId, CARDS) && typeof event.upgraded === 'boolean' &&
      typeof event.copied === 'boolean' && Number.isFinite(event.energy) &&
      (event.mode === undefined || Number.isFinite(event.mode)) &&
      (event.resolvedType === undefined || ['attack', 'skill', 'power', 'slime', 'curse', 'status'].includes(event.resolvedType))
    if (event.kind === 'slime') return knownId(event.sourceId, CARDS) && typeof event.slimeUid === 'string' &&
      typeof event.upgraded === 'boolean' && Number.isFinite(event.animationIndex)
    if (event.kind === 'potion') return knownId(event.sourceId, POTIONS)
    if (event.kind === 'shiv') return event.sourceId === 'shiv'
    if (event.kind === 'orb') return ['lightning', 'frost', 'dark'].includes(event.orb)
    return event.kind === 'turn' && ['block', 'damage', 'burn', 'poison', 'weak', 'vulnerable', 'draw', 'discard',
      'exhaust', 'buff', 'strength', 'heal', 'countdown', 'blockLoss', 'strengthLoss'].includes(event.effect) &&
      typeof event.actorTargeted === 'boolean'
  }
  const nullableStringList = (value: unknown) => Array.isArray(value) && value.length <= MAX_STATE_COLLECTION &&
    value.every((entry) => entry === null || typeof entry === 'string')
  const pendingTrigger = (value: unknown) => Boolean(value && typeof value === 'object' &&
    Number.isFinite((value as { id?: unknown }).id) && typeof (value as { playerId?: unknown }).playerId === 'string' &&
    typeof (value as { sourceId?: unknown }).sourceId === 'string' &&
    ((value as { startTurn?: unknown }).startTurn === undefined || (value as { startTurn?: unknown }).startTurn === true) &&
    ((value as { enemyUid?: unknown }).enemyUid === undefined || typeof (value as { enemyUid?: unknown }).enemyUid === 'string'))
  const startTurnChoice = (value: unknown) => {
    if (!value || typeof value !== 'object') return false
    const choice = value as Record<string, unknown>
    const trigger = choice.trigger as Record<string, unknown> | undefined
    return typeof choice.id === 'string' && nullableStringList(choice.shivEnemyUids) &&
      ['exhaustUids', 'loadUids', 'chamberUids', 'hermitEnemyUids', 'slimeUids', 'slimeEnemyUids']
        .every((field) => choice[field] === undefined || stringList(choice[field])) &&
      (choice.evokeSlots === undefined || Array.isArray(choice.evokeSlots) &&
        choice.evokeSlots.every((slot) => Number.isInteger(slot) && slot >= 0 && slot < 32)) &&
      (choice.evokeEnemyUids === undefined || nullableStringList(choice.evokeEnemyUids)) &&
      (choice.enemyUid === undefined || typeof choice.enemyUid === 'string') &&
      (choice.targetPlayerId === undefined || typeof choice.targetPlayerId === 'string') &&
      (choice.guardianModeShift === undefined || typeof choice.guardianModeShift === 'boolean') &&
      (trigger === undefined || Boolean(trigger && (trigger.enemyRow === undefined || Number.isFinite(trigger.enemyRow)) &&
        (trigger.enemyUid === undefined || typeof trigger.enemyUid === 'string') &&
        (trigger.targetPlayerId === undefined || typeof trigger.targetPlayerId === 'string') &&
        ['loadUids', 'chamberUids', 'hermitEnemyUids', 'slimeUids', 'slimeEnemyUids']
          .every((field) => trigger[field] === undefined || stringList(trigger[field]))))
  }
  const safeDeferredValue = (value: unknown, depth = 0): boolean => {
    if (value === null || typeof value === 'boolean') return true
    if (typeof value === 'number') return Number.isFinite(value) && Math.abs(value) <= 64
    if (typeof value === 'string') return value.length <= 256
    if (!value || typeof value !== 'object' || depth >= 8) return false
    const entries = Object.entries(value)
    return entries.length <= 64 && entries.every(([key, nested]) =>
      !FORBIDDEN_PATH.has(key) && safeDeferredValue(nested, depth + 1))
  }
  const deferredHavoc = (value: unknown) => Boolean(value && typeof value === 'object' &&
    cards([(value as { card?: unknown }).card]) && typeof (value as { exhaust?: unknown }).exhaust === 'boolean' &&
    ((value as { remainingEffects?: unknown }).remainingEffects === undefined ||
      Array.isArray((value as { remainingEffects?: unknown }).remainingEffects) &&
      (value as { remainingEffects: unknown[] }).remainingEffects.length <= 64 &&
      (value as { remainingEffects: unknown[] }).remainingEffects.every(safeDeferredValue)) &&
    ((value as { copySourceNames?: unknown }).copySourceNames === undefined ||
      Array.isArray((value as { copySourceNames?: unknown }).copySourceNames) &&
      (value as { copySourceNames: unknown[] }).copySourceNames.length <= 64 &&
      (value as { copySourceNames: unknown[] }).copySourceNames.every((name) =>
        ['Double Tap', 'Blasphemy', 'Echo Form', 'Burst', 'Omniscience', 'Rapid Fire'].includes(name as string))) &&
    ((value as { virtualOnly?: unknown }).virtualOnly === undefined || typeof (value as { virtualOnly?: unknown }).virtualOnly === 'boolean') &&
    ((value as { copyResumePhase?: unknown }).copyResumePhase === undefined ||
      ['start', 'player', 'discard'].includes((value as { copyResumePhase: string }).copyResumePhase)))
  const combatStateValid = (combat: RunState['combat'] | undefined) => {
    if (!combat || typeof combat.combatId !== 'string' || typeof combat.lastStand !== 'boolean' ||
      combat.ruleset !== undefined && combat.ruleset !== 'base' && combat.ruleset !== 'downfall' ||
      !rng(combat.rng) || !Number.isFinite(combat.turn) ||
      !Number.isFinite(combat.die) || !['start', 'player', 'copy', 'discard', 'enemy', 'roundEnd', 'won', 'lost'].includes(combat.phase) ||
      !players(combat.players) || !enemies(combat.enemies) || !combat.summonSupply || typeof combat.summonSupply !== 'object' ||
      !Object.values(combat.summonSupply).every((ids) => known(ids, ENEMIES)) || !Array.isArray(combat.pendingSummons) ||
      !combat.pendingSummons.every((pending) => pending && typeof pending.sourceUid === 'string' && Number.isFinite(pending.row) &&
        Number.isFinite(pending.turn) && known(pending.defIds, ENEMIES)) || !known(combat.potionDeck, POTIONS) ||
      combat.potionLimit !== 2 && combat.potionLimit !== 3 || !stringList(combat.discardedThisTurn) ||
      !stringList(combat.stanceChangedThisTurn) || !stringList(combat.powerTriggersUsedThisTurn) ||
      !Array.isArray(combat.pendingTriggers) || !combat.pendingTriggers.every(pendingTrigger) || !Number.isFinite(combat.nextTriggerId) ||
      !Array.isArray(combat.presentationEvents) || combat.presentationEvents.length > 24 ||
      !combat.presentationEvents.every(presentationEvent) || !stringList(combat.log)) return false
    if (combat.pendingPlunderSwitches !== undefined && (!Array.isArray(combat.pendingPlunderSwitches) ||
      !combat.pendingPlunderSwitches.every((entry) => entry && typeof entry.playerId === 'string' && typeof entry.sourceUid === 'string')) ||
      combat.pendingHermitChamberPlays !== undefined && (!Array.isArray(combat.pendingHermitChamberPlays) ||
        !combat.pendingHermitChamberPlays.every((entry) => entry && typeof entry.playerId === 'string' &&
          typeof entry.sourceCardId === 'string' && stringList(entry.cardUids) && typeof entry.free === 'boolean')) ||
      combat.pendingHermitStrengthRewards !== undefined && (!Array.isArray(combat.pendingHermitStrengthRewards) ||
        !combat.pendingHermitStrengthRewards.every((entry) => entry && typeof entry.playerId === 'string' && typeof entry.sourceUid === 'string')) ||
      combat.pendingHermitSetupLoads !== undefined && (!Array.isArray(combat.pendingHermitSetupLoads) ||
        !combat.pendingHermitSetupLoads.every((entry) => entry && typeof entry.playerId === 'string')) ||
      combat.pendingDieRelicChoices !== undefined && (!Array.isArray(combat.pendingDieRelicChoices) ||
        !combat.pendingDieRelicChoices.every((entry) => entry && Number.isFinite(entry.id) && typeof entry.playerId === 'string' &&
          typeof entry.relicDefId === 'string' && Number.isFinite(entry.abilityIndex) && typeof entry.sourceLabel === 'string' &&
          (entry.enemyUid === null || typeof entry.enemyUid === 'string') &&
          (entry.targetPlayerId === null || typeof entry.targetPlayerId === 'string'))) ||
      combat.startTurnStage !== undefined && combat.startTurnStage !== 'effects' && combat.startTurnStage !== 'facing' ||
      combat.partyAttackDiscount !== undefined && typeof combat.partyAttackDiscount !== 'boolean') return false
    const end = combat.endTurnProgress
    if (end !== undefined && (!end || !stringList(end.order) || end.interactive !== undefined && typeof end.interactive !== 'boolean' ||
      end.loopSelections !== undefined && (!end.loopSelections || typeof end.loopSelections !== 'object' ||
        !Object.values(end.loopSelections).every(Number.isFinite)) || end.loopRepeats !== undefined && !stringList(end.loopRepeats))) return false
    const start = combat.startTurnProgress
    if (start !== undefined && (!start || !Array.isArray(start.choices) || !start.choices.every(startTurnChoice) ||
      start.beforeDraw !== undefined && (!start.beforeDraw || !Number.isFinite(start.beforeDraw.drewFrom) ||
        !Array.isArray(start.beforeDraw.sources) || !start.beforeDraw.sources.every((source) => source &&
          typeof source.playerId === 'string' && typeof source.sourceId === 'string') || typeof start.beforeDraw.ordered !== 'boolean' ||
        start.beforeDraw.pauseAfterDraw !== undefined && typeof start.beforeDraw.pauseAfterDraw !== 'boolean') ||
      start.rollPending !== undefined && (!start.rollPending || !Number.isFinite(start.rollPending.drewFrom) ||
        start.rollPending.pauseAfterDraw !== undefined && typeof start.rollPending.pauseAfterDraw !== 'boolean') ||
      start.pauseAfterDraw !== undefined && (!start.pauseAfterDraw || !Number.isFinite(start.pauseAfterDraw.drewFrom)) ||
      start.discard !== undefined && (!start.discard || typeof start.discard.playerId !== 'string' ||
        typeof start.discard.sourceId !== 'string' || start.discard.remaining !== undefined && !Number.isFinite(start.discard.remaining) ||
        start.discard.selectedUids !== undefined && !stringList(start.discard.selectedUids) ||
        !Array.isArray(start.discard.pendingTriggers) || !start.discard.pendingTriggers.every(pendingTrigger)) ||
      start.forcedCard !== undefined && (!start.forcedCard || typeof start.forcedCard.playerId !== 'string' ||
        !(start.forcedCard.cardUid === null || typeof start.forcedCard.cardUid === 'string') ||
        typeof start.forcedCard.sourceCardId !== 'string' || typeof start.forcedCard.exhaustNonPower !== 'boolean' ||
        start.forcedCard.pendingTriggers !== undefined && (!Array.isArray(start.forcedCard.pendingTriggers) ||
          !start.forcedCard.pendingTriggers.every(pendingTrigger)) ||
        start.forcedCard.deferredHavocs !== undefined && (!Array.isArray(start.forcedCard.deferredHavocs) ||
          !start.forcedCard.deferredHavocs.every(deferredHavoc))))) return false
    const copy = combat.pendingCardCopy
    const copySources = ['Double Tap', 'Blasphemy', 'Echo Form', 'Burst', 'Doppelganger', 'Foreign Influence',
      'Haunting Echo', 'Omniscience', 'Overexert', 'Replication', 'Weave', 'Rapid Fire']
    if (combat.phase === 'copy' && !copy || copy !== undefined && (!copy || !Number.isFinite(copy.id) ||
      typeof copy.playerId !== 'string' || !cards([copy.card]) || !Number.isFinite(copy.energySpent) ||
      !['start', 'player', 'discard'].includes(copy.resumePhase) || typeof copy.forcedExhaust !== 'boolean' ||
      !(copy.forcedChoices === null || Array.isArray(copy.forcedChoices) && copy.forcedChoices.length <= 64 && copy.forcedChoices.every(startTurnChoice)) ||
      copy.energySpent < 0 || copy.energySpent > CAPS.energy ||
      !Array.isArray(copy.deferredHavocs) || copy.deferredHavocs.length > 64 || !copy.deferredHavocs.every(deferredHavoc) ||
      !Array.isArray(copy.sourceNames) || copy.sourceNames.length > 64 ||
      !copy.sourceNames.every((source) => copySources.includes(source)) ||
      copy.deferredTriggers !== undefined && (!Array.isArray(copy.deferredTriggers) || copy.deferredTriggers.length > 64 ||
        !copy.deferredTriggers.every(pendingTrigger)) ||
      copy.queuedWeaves !== undefined && !cards(copy.queuedWeaves) || copy.queuedCopySources !== undefined &&
        (!Array.isArray(copy.queuedCopySources) || copy.queuedCopySources.length > 64 ||
          !copy.queuedCopySources.every((source) => copySources.includes(source))) ||
      ['hermitRapidFireCard', 'deferRapidFire', 'finalResolutionCopied', 'virtualOnly', 'repeatIfAttack', 'consumeFreeCard', 'consumeFreeAttack']
        .some((field) => copy[field as keyof typeof copy] !== undefined && typeof copy[field as keyof typeof copy] !== 'boolean'))) return false
    if (combat.pendingDistilled !== undefined && (!combat.pendingDistilled || typeof combat.pendingDistilled.playerId !== 'string' ||
      !cards(combat.pendingDistilled.cards)) || combat.pendingRelicScry !== undefined && (!combat.pendingRelicScry ||
      !Number.isFinite(combat.pendingRelicScry.id) || typeof combat.pendingRelicScry.playerId !== 'string' ||
      !Number.isFinite(combat.pendingRelicScry.relicIndex) || !cards(combat.pendingRelicScry.cards)) ||
      !Array.isArray(combat.playedCardsThisTurn) || !combat.playedCardsThisTurn.every((played) => played &&
        typeof played.playerId === 'string' && cards([played.card]) && typeof played.copied === 'boolean' &&
        (played.type === undefined || ['attack', 'skill', 'power', 'slime', 'curse', 'status'].includes(played.type)))) return false
    return true
  }
  const combatValid = combatStateValid(state.combat)
  const combatShapeValid = state.combat === null || combatValid
  const preparedCombatValid = room?.kind !== 'event' || room.preparedCombat === undefined || combatStateValid(room.preparedCombat)
  const setup = state.setup
  const setupValid = setup === null || Boolean(setup && ['quick-start', 'catch-up'].includes(setup.kind) &&
    [2, 3, 4].includes(setup.targetAct) && Array.isArray(setup.playerIds) && setup.playerIds.length > 0 &&
    setup.playerIds.length <= (state.players?.length ?? 0) && new Set(setup.playerIds).size === setup.playerIds.length &&
    setup.playerIds.every((id) => typeof id === 'string' && state.players?.some((player) => player.id === id)) &&
    [setup.rowIndex, setup.repeatIndex, setup.playerIndex].every((index) => Number.isInteger(index) && index >= 0) &&
    (setup.die === null || Boolean(setup.die && [1, 2, 3, 4, 5, 6].includes(setup.die.value) &&
      Number.isInteger(setup.die.effectIndex) && setup.die.effectIndex >= 0)))
  const pendingSocketsValid = Array.isArray(state.pendingGuardianSockets) && state.pendingGuardianSockets.every((pending) => {
    if (!pending || typeof pending !== 'object' || !['draft', 'merchant', 'gain'].includes(pending.source) ||
      typeof pending.playerId !== 'string' || typeof pending.cardUid !== 'string' || !known(pending.gemIds, CARDS)) return false
    return Boolean(state.players?.find((player) => player.id === pending.playerId)?.deck.some((card) => card.uid === pending.cardUid))
  })
  const phaseValid = state.phase === 'combat' ? combatValid
    : state.phase === 'neow' ? neowValid
      : state.phase === 'setup' ? Boolean(state.setup)
        : state.phase === 'betweenCombat' ? knownId(state.pendingBossDefId, ENEMIES)
          : state.phase === 'room' ? Boolean(state.map?.position && state.map.rooms?.[state.map.position] ||
            state.setup && state.roomState?.kind === 'merchant') : true
  const progress = state.campaignProgress
  const progressValid = Boolean(progress && progress.version === 1 && progress.characters && typeof progress.characters === 'object' &&
    CHARACTER_IDS.every((id) => Number.isInteger(progress.characters[id])) &&
    ['colorless', 'actIV', 'unspentMarks', 'highestAscension', 'nextRunNumber'].every((field) =>
      Number.isInteger(progress[field as keyof typeof progress])) && Array.isArray(progress.finishedRunIds) &&
    progress.finishedRunIds.every((id) => typeof id === 'string'))
  const campaign = state.campaign
  const campaignValid = Boolean(campaign && campaign.runId === runId && [1, 2, 3, 4].includes(campaign.startedAtAct) &&
    Number.isInteger(campaign.bossesDefeated) && [0, 1, 2, 3, 4].includes(campaign.highestBossActDefeated) &&
    campaign.joinedAfterBosses && typeof campaign.joinedAfterBosses === 'object' && campaign.keys &&
    typeof campaign.keys.ruby === 'boolean' && typeof campaign.keys.emerald === 'boolean' &&
    typeof campaign.keys.sapphire === 'boolean' && typeof campaign.finalized === 'boolean')
  const metaValid = Boolean(state.meta && ['standard', 'daily', 'custom'].includes(state.meta.mode) &&
    Array.isArray(state.meta.modifierIds) && state.meta.modifierIds.length <= DAILY_MODIFIERS.length &&
    new Set(state.meta.modifierIds).size === state.meta.modifierIds.length && state.meta.modifierIds.every((id) =>
      DAILY_MODIFIERS.some((modifier) => modifier.id === id)) &&
    (state.meta.ruleset === undefined || state.meta.ruleset === 'base' || state.meta.ruleset === 'downfall') &&
    (state.meta.campaign === undefined || state.meta.campaign === 'base' || state.meta.campaign === 'downfall'))
  const eventCombatValid = state.eventCombat === null || Boolean(state.eventCombat &&
    ['encounter', 'elite', 'boss'].includes(state.eventCombat.kind) && typeof state.eventCombat.mindBloom === 'boolean' &&
    (state.eventCombat.bossDefId === undefined || knownId(state.eventCombat.bossDefId, ENEMIES)) &&
    (state.eventCombat.relicReward === undefined || typeof state.eventCombat.relicReward === 'boolean'))
  return campaignValid && typeof state.phase === 'string' && RUN_PHASES.has(state.phase) &&
    typeof state.seed === 'number' && Number.isFinite(state.seed) && rng(state.rng) && combatShapeValid &&
    players(state.players) && setupValid && phaseValid &&
    progressValid && Number.isFinite(state.ascension) && Number.isFinite(state.act) && Number.isFinite(state.eventsVisited) &&
    typeof state.chooseYourRelic === 'boolean' && typeof state.lastStand === 'boolean' &&
    mapValid && preparedCombatValid &&
    Boolean(state.enemyDecks && typeof state.enemyDecks === 'object' && Number.isInteger(state.enemyDecks.act) &&
      state.enemyDecks.act >= 1 && state.enemyDecks.act <= 4) && encounterDeck(state.enemyDecks?.first) &&
    encounterDeck(state.enemyDecks?.encounter) && encounterDeck(state.enemyDecks?.elite) &&
    (state.actBossDefId === null || knownId(state.actBossDefId, ENEMIES)) &&
    (state.pendingBossDefId === null || knownId(state.pendingBossDefId, ENEMIES)) &&
    Array.isArray(state.potionDeck) &&
    known(state.potionDeck, POTIONS) && known(state.relicDeck, RELICS) && known(state.bossRelicDeck, RELICS) &&
    known(state.guardianGemDeck, CARDS) &&
    pendingSocketsValid && rewardsValid && state.rewardDestination !== undefined &&
    ['map', 'combat', 'betweenCombat', 'setup', 'victory', null].includes(state.rewardDestination) &&
    eventCombatValid && (state.nextPendingRelicId === undefined || Number.isInteger(state.nextPendingRelicId) && state.nextPendingRelicId >= 0) &&
    (state.combatsFinished === undefined || Number.isInteger(state.combatsFinished) && state.combatsFinished >= 0) &&
    (state.floorsCleared === undefined || Number.isInteger(state.floorsCleared) && state.floorsCleared >= 0) &&
    (state.selfBossRerolled === undefined || typeof state.selfBossRerolled === 'boolean') && roomValid &&
    Boolean(state.itemDecks && typeof state.itemDecks === 'object') && known(state.itemDecks?.relics, RELICS) &&
    known(state.itemDecks?.potions, POTIONS) && knownRewardCards(state.itemDecks?.colorless) &&
    known(state.itemDecks?.curses, CARDS) && Object.values(state.itemDecks?.characterCards ?? {}).every(knownRewardCards) &&
    Object.values(state.itemDecks?.characterRares ?? {}).every(knownRewardCards) && Array.isArray(state.eventDeck) && state.eventDeck.length <= 256 &&
    state.eventDeck.every(eventCard) && courierValid && metaValid && stringList(state.log)
}

export function validateRunLog(value: unknown): RunLog | null {
  if (!value || typeof value !== 'object') return null
  const rawLog = value as Record<string, unknown>
  if (rawLog.version !== 2 || typeof rawLog.runId !== 'string' || !rawLog.runId || rawLog.runId.length > 256 ||
    !Array.isArray(rawLog.events) || !rawLog.events.length || rawLog.events.length > MAX_RUN_LOG_EVENTS) return null
  try {
    const normalized = normalizeLegacyRunLog(value as RunLog)
    const log = normalized
    const initial = log.initial
    if (!validRunState(initial, log.runId)) return null
    let patches = 0
    let controlRefs = 0
    let controlText = 0
    const selectors = new Set<string>()
    const events: RunLogEvent[] = []
    for (const raw of log.events) {
      if (!raw || typeof raw !== 'object') return null
      const event = raw as RunLogEvent
      if (!Array.isArray(event.patch) || !event.patch.length || event.patch.length > MAX_EVENT_PATCHES ||
        (patches += event.patch.length) > MAX_RUN_LOG_PATCHES ||
        event.viewerId !== undefined && !initial.players.some((player) => player.id === event.viewerId)) return null
      if (!event.patch.every((change) => change && Array.isArray(change.path) && change.path.length <= 64 &&
        change.path.every((part) => typeof part === 'number' && Number.isSafeInteger(part) && part >= 0 ||
          typeof part === 'string' && part.length <= 256 && !FORBIDDEN_PATH.has(part)) &&
        (change.remove === true && !Object.hasOwn(change, 'value') || change.remove === undefined && Object.hasOwn(change, 'value')))) return null
      if (event.choice) {
        if (!event.choice || typeof event.choice !== 'object' || event.choice.steps !== undefined &&
          (!Array.isArray(event.choice.steps) || event.choice.steps.length > 256)) return null
        const refs = [event.choice.source, ...(event.choice.steps ?? []), ...(event.choice.target ? [event.choice.target] : [])]
        controlRefs += refs.length
        for (const ref of refs) {
          if (!validRef(ref, selectors)) return null
          controlText += ref.selector.length + (ref.name?.length ?? 0) + (ref.value?.length ?? 0)
        }
        if (controlRefs > MAX_CONTROL_REFS || controlText > MAX_CONTROL_TEXT) return null
      }
      events.push(event)
    }
    let state = structuredClone(initial) as RunState
    let validationWork = JSON.stringify(state).length
    for (const event of events) {
      if (event.viewerId !== undefined && !state.players.some((player) => player.id === event.viewerId)) return null
      state = applyRunLogEvent(state, event)
      validationWork += JSON.stringify(state).length
      if (validationWork > MAX_VALIDATION_WORK) return null
      if (!validRunState(state, log.runId)) return null
    }
    return TERMINAL_PHASES.has(state.phase) && state.campaign?.runId === log.runId ? normalized : null
  } catch { return null }
}

export function parseRunLog(text: string) {
  if (text.length > MAX_RUN_LOG_BYTES) return null
  try { return validateRunLog(JSON.parse(text)) } catch { return null }
}

export function downloadRunLog(log: RunLog) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(normalizeLegacyRunLog(log))], { type: 'application/json' }))
  Object.assign(document.createElement('a'), { href: url, download: `slay-the-spire-run-${log.runId}.json` }).click()
  setTimeout(() => URL.revokeObjectURL(url))
}

export function queryRunLogControl(doc: Document, ref: ControlRef): HTMLElement | null {
  const name = ref.selector.startsWith('[data-room=') ? ref.name?.replace(/, Activate again to enter$/, '') : ref.name
  const nameMatches = (element: HTMLElement) => !name || controlName(element) === name || controlName(element)?.startsWith(`${name} `)
  const visible = (element: HTMLElement | null, requireName = true) => {
    if (!element || requireName && !nameMatches(element)) return null
    const view = element.ownerDocument.defaultView
    let box = element.getBoundingClientRect()
    if (box.width <= 0 || box.height <= 0 || view?.getComputedStyle(element).visibility === 'hidden') return null
    for (let parent = element.parentElement; parent && parent !== doc.body; parent = parent.parentElement) {
      const style = view!.getComputedStyle(parent)
      const bounds = parent.getBoundingClientRect()
      if (/^(auto|scroll)$/.test(style.overflowY)) parent.scrollTop += box.top < bounds.top ? box.top - bounds.top : Math.max(0, box.bottom - bounds.bottom)
      if (/^(auto|scroll)$/.test(style.overflowX)) parent.scrollLeft += box.left < bounds.left ? box.left - bounds.left : Math.max(0, box.right - bounds.right)
      box = element.getBoundingClientRect()
    }
    return box.right > 0 && box.bottom > 0 && box.left < (view?.innerWidth ?? 0) && box.top < (view?.innerHeight ?? 0) ? element : null
  }
  try {
    const matches = [...doc.querySelectorAll<HTMLElement>(ref.selector)]
    const exact = matches.find((element) => replayableControl(element) &&
      visible(element, !/^\[data-(?:enemy-id|player-id|room|event-option)=/.test(ref.selector)))
    if (exact) return exact
    if (matches.some((element) => element.matches(CONTROL) && !replayableControl(element))) return null
  } catch {}
  if (!ref.name) return null
  return [...doc.querySelectorAll<HTMLElement>(CONTROL)].find((element) => replayableControl(element) && nameMatches(element) && visible(element)) ?? null
}

function soleReachableRoom(root: ParentNode) {
  const rooms = root.querySelectorAll<HTMLElement>('.room--reachable')
  return rooms.length === 1 ? rooms[0]! : null
}

function soleForcedResolution(doc: Document) {
  const controls = [...doc.querySelectorAll<HTMLElement>(CONTROL)].filter((element) =>
    /^Resolve\b/.test(controlName(element) ?? '') && !(element as HTMLButtonElement).disabled &&
    element.getClientRects().length > 0 && doc.defaultView?.getComputedStyle(element).visibility !== 'hidden')
  return controls.length === 1 ? controls[0]! : null
}

function merchantExit(doc: Document, ref: ControlRef) {
  return /^Proceed · \d+\/\d+ ready$/.test(ref.name ?? '')
    ? queryRunLogControl(doc, { selector: '.merchant-shop-stage > .room-proceed', name: '← Leave shop' }) : null
}

function merchantEntry(doc: Document, ref: ControlRef) {
  return ref.name === 'Enter merchant shop' ? null
    : queryRunLogControl(doc, { selector: '.merchant-arrival__merchant', name: 'Enter merchant shop' })
}

async function activateControl(element: HTMLElement, ref: ControlRef) {
  if (element.matches('input[type="checkbox"], input[type="radio"]') && ref.checked !== undefined) {
    if ((element as HTMLInputElement).checked !== ref.checked) element.click()
  } else if (element.matches('select, textarea') && ref.value !== undefined) {
    ;(element as HTMLSelectElement | HTMLTextAreaElement).value = ref.value
    element.dispatchEvent(new Event('change', { bubbles: true }))
  } else element.click()
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
}

function delay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const timer = window.setTimeout(done, milliseconds)
    function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
    signal.addEventListener('abort', done, { once: true })
  })
}

async function waitForControl(doc: Document, ref: ControlRef, signal: AbortSignal) {
  const until = performance.now() + 15_000
  let control = queryRunLogControl(doc, ref)
  while (!control && !signal.aborted && performance.now() < until) {
    await delay(50, signal)
    control = queryRunLogControl(doc, ref)
  }
  return control
}

async function waitForPause(doc: Document, signal: AbortSignal) {
  while (!signal.aborted && doc.querySelector('.pause-menu[open], .settings-dialog[open], .map-peek[open], .card-collection[open], .compendium'))
    await delay(50, signal)
}

async function settle(doc: Document, signal: AbortSignal) {
  const until = performance.now() + 15_000
  do {
    await delay(50, signal)
    const active = doc.getAnimations().some((animation) => animation.playState === 'running' &&
      Number.isFinite(Number(animation.effect?.getComputedTiming().iterations)))
    if (!active && !doc.querySelector('[data-webmcp-pending="true"], .character-attack, .card-flight')) return
  } while (!signal.aborted && performance.now() < until)
}

function installReplayGuard(doc: Document, pause?: () => void) {
  const block = (event: Event) => {
    if (!event.isTrusted) return
    if (event instanceof KeyboardEvent && event.key === 'Escape') {
      if (doc.querySelector(OPEN_INSPECTION)) return
      if (doc.querySelector('.pause-menu[open]') || !pause) return
      event.preventDefault()
      event.stopImmediatePropagation()
      pause()
      return
    }
    const element = event.target instanceof Element ? event.target : null
    if (element?.closest(INSPECTION)) return
    if (event instanceof KeyboardEvent && !['Enter', ' '].includes(event.key)) return
    if (!element?.closest(CONTROL) && event.type !== 'submit') return
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  for (const type of ['pointerdown', 'click', 'change', 'submit', 'keydown']) doc.addEventListener(type, block, true)
  return () => { for (const type of ['pointerdown', 'click', 'change', 'submit', 'keydown']) doc.removeEventListener(type, block, true) }
}

async function moveCursor(cursor: HTMLElement, to: Point, pressed: boolean, reducedMotion: boolean, signal: AbortSignal) {
  cursor.toggleAttribute('data-pressed', pressed)
  const position = { left: `${to.x * 100}%`, top: `${to.y * 100}%` }
  const animation = cursor.animate(position, {
    duration: reducedMotion ? 0 : REPLAY_CURSOR_MS, easing: 'ease-in-out', fill: 'forwards',
  })
  await Promise.race([animation.finished.catch(() => {}), delay(REPLAY_CURSOR_MS, signal)])
  Object.assign(cursor.style, position)
  animation.cancel()
}

export async function playRunLog(log: RunLog, options: {
  setRun: (run: RunState) => void
  setViewer: (id: string) => void
  reducedMotion: boolean
  signal: AbortSignal
  document?: Document
  pause?: () => void
}) {
  const doc = options.document ?? document
  const cursor = doc.createElement('div')
  cursor.className = 'run-replay__cursor'
  cursor.dataset.runLogControl = ''
  cursor.setAttribute('aria-hidden', 'true')
  cursor.style.backgroundImage = `url("${assetPath('ui/cursor.png')}")`
  doc.body.append(cursor)
  const removeGuard = installReplayGuard(doc, options.pause)
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    removeGuard()
    cursor.remove()
  }
  options.signal.addEventListener('abort', cleanup, { once: true })
  let state = structuredClone(log.initial)
  let lastClick: Point | null = null
  let lastAction = -Infinity
  options.setRun(state)
  options.setViewer(state.players[0]!.id)
  try {
    await delay(100, options.signal)
    for (const [eventIndex, logged] of log.events.entries()) {
      if (options.signal.aborted) break
      await waitForPause(doc, options.signal)
      if (options.signal.aborted) break
      const event = { ...logged, choice: runLogEventChoice(logged, state) }
      options.setViewer(event.viewerId ?? state.players[0]!.id)
      const choice = event.choice
      if (choice) {
        const missedRoom = !queryRunLogControl(doc, choice.source) && doc.querySelector('.map')
          ? (() => {
              const roomId = event.patch.find((change) => change.path.length === 2 && change.path[0] === 'map' &&
                change.path[1] === 'position' && typeof change.value === 'string')?.value as string | undefined
              return roomId ? doc.querySelector<HTMLElement>(`[data-room="${CSS.escape(roomId)}"]`) : soleReachableRoom(doc)
            })() : null
        const forced = !missedRoom && !queryRunLogControl(doc, choice.source) ? soleForcedResolution(doc) : null
        const entry = !missedRoom && !forced && !queryRunLogControl(doc, choice.source) ? merchantEntry(doc, choice.source) : null
        const exit = !entry && !queryRunLogControl(doc, choice.source) ? merchantExit(doc, choice.source) : null
        const refs = [
          ...(missedRoom ? [{ ref: controlRef(missedRoom), element: missedRoom }] : []),
          ...(forced ? [{ ref: controlRef(forced), element: forced }] : []),
          ...(entry ? [{ ref: controlRef(entry), element: entry }] : []),
          ...(exit ? [{ ref: controlRef(exit), element: exit }] : []),
          { ref: choice.source }, ...(choice.steps ?? []).map((ref) => ({ ref })),
        ]
        const choiceIndex = Number(Boolean(missedRoom)) + Number(Boolean(forced)) + Number(Boolean(entry)) + Number(Boolean(exit))
        for (const [index, item] of refs.entries()) {
          if (options.signal.aborted) break
          const source = item.element ?? await waitForControl(doc, item.ref, options.signal)
          if (options.signal.aborted) break
          if (!source) throw new Error(`Replay stopped at event ${eventIndex + 1}; ${item.ref.name ?? item.ref.selector} did not appear.`)
          const target = index === choiceIndex && choice.target && !choice.steps?.length
            ? await waitForControl(doc, choice.target, options.signal) : null
          if (options.signal.aborted) break
          const from = point(source)
          const samePlace = Boolean(lastClick && Math.hypot(lastClick.x - from.x, lastClick.y - from.y) < .001)
          await delay(Math.max(0, (samePlace ? REPLAY_REPEAT_CLICK_MS : REPLAY_ACTION_HOLD_MS) - (performance.now() - lastAction)), options.signal)
          if (options.signal.aborted) break
          await moveCursor(cursor, from, true, options.reducedMotion, options.signal)
          if (options.signal.aborted) break
          const recordedDeckCommit = semanticDeckMutation(event) && index === refs.length - 1 && /^Confirm\b/.test(item.ref.name ?? '')
          await waitForPause(doc, options.signal)
          if (options.signal.aborted) break
          if (!recordedDeckCommit) await activateControl(source, item.ref)
          if (options.signal.aborted) break
          if (target && choice.target) {
            await moveCursor(cursor, point(target), true, options.reducedMotion, options.signal)
            if (options.signal.aborted) break
            await waitForPause(doc, options.signal)
            if (options.signal.aborted) break
            await activateControl(target, choice.target)
            if (options.signal.aborted) break
          }
          cursor.removeAttribute('data-pressed')
          lastClick = target ? null : from
          lastAction = performance.now()
          await settle(doc, options.signal)
        }
        if (options.signal.aborted) break
        if (choice.target && choice.steps?.length && !options.signal.aborted) {
          const target = await waitForControl(doc, choice.target, options.signal)
          if (options.signal.aborted) break
          if (!target) throw new Error(`Replay stopped at event ${eventIndex + 1}; its target did not appear.`)
          await moveCursor(cursor, point(target), true, options.reducedMotion, options.signal)
          if (options.signal.aborted) break
          await waitForPause(doc, options.signal)
          if (options.signal.aborted) break
          await activateControl(target, choice.target)
          if (options.signal.aborted) break
          cursor.removeAttribute('data-pressed')
          lastClick = null
          lastAction = performance.now()
          await settle(doc, options.signal)
        }
      }
      if (options.signal.aborted) break
      state = applyRunLogEvent(state, event)
      options.setRun(state)
      await settle(doc, options.signal)
    }
    if (!options.signal.aborted) await delay(1_500, options.signal)
  } catch (error) {
    cursor.remove()
    throw error
  } finally {
    if (options.signal.aborted) cleanup()
  }
  return () => {
    options.signal.removeEventListener('abort', cleanup)
    cleanup()
  }
}
