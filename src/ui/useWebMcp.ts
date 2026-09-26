import { useEffect } from 'react'
import { CARDS } from '../game/cards.ts'
import { parseStatsExpression, validateStatsQuery } from '../stats-query.ts'
import { loadStats, type StatsFilters } from '../stats.ts'

type Tool = {
  name: string
  title: string
  description: string
  inputSchema: object
  annotations: {
    readOnlyHint?: boolean
    untrustedContentHint?: boolean
    consequentialHint?: boolean
  }
  execute: (input: unknown, options?: { signal?: AbortSignal }) => unknown
}

type ModelContext = {
  registerTool: (tool: Tool, options?: { signal?: AbortSignal }) => Promise<void>
}

type ControlKind = 'button' | 'checkbox' | 'select' | 'text' | 'number'
type VisibleControl = {
  id: string
  kind?: ControlKind
  label: string
  context?: string
  description?: string
  selected?: boolean
  value?: string | number | boolean
  min?: number
  max?: number
  step?: number
  maxLength?: number
  required?: boolean
  options?: { value: string; label: string }[]
}
type Control = VisibleControl & { kind: ControlKind; element: HTMLElement }

const PAGE_SIZE = 30
const SCREEN_TEXT_LIMIT = 8_000
const TEXT_VALUE_LIMIT = 1_000
const STATS_CHOICES = Object.values(CARDS).flatMap((card) => [
  { id: card.id, label: card.name, upgraded: false },
  ...(card.upgrade ? [{ id: card.id, label: `${card.name}+`, upgraded: true }] : []),
])
const STATS_HEROES = ['all', 'ironclad', 'silent', 'defect', 'watcher', 'slime_boss', 'guardian', 'hexaghost', 'hermit'] as const
const STATS_MODES = ['all', 'standard', 'daily', 'custom', 'multiplayer'] as const
const CONTROL_SELECTOR = 'button, summary, input, select, [role="button"]'
const STRUCTURED_TEXT_SELECTOR = 'h1, h2, h3, [role="heading"], [role="status"], [role="alert"]'
let controls: Control[] = []
let controlStateSignature = ''
let pageSnapshot: { id: string; signature: string } | null = null
let pageSnapshotSequence = 0
let published: { revision: string; state: ReturnType<typeof captureGame> } | null = null
let publicationSequence = 0

function identify(current: Control[]): Control[] {
  return current.map((control) => ({ ...control, id: crypto.randomUUID().slice(0, 12) }))
}

function invalidateControls() {
  controls = []
  controlStateSignature = ''
  pageSnapshot = null
}

function interactionPending() {
  const selector = '[data-webmcp-pending="true"], .enemy--falling'
  return Boolean(document.documentElement.dataset.mapTransition ||
    document.documentElement.dataset.webmcpPending === 'true' ||
    [...document.querySelectorAll<HTMLElement>(selector)].some((element) =>
      element.getClientRects().length > 0 && element.parentElement && rendered(element.parentElement)))
}

function activeScopes(): HTMLElement[] {
  const modal = document.querySelector<HTMLElement>('dialog:modal, [role="dialog"][aria-modal="true"]')
  if (modal) return [modal]
  const root = document.getElementById('root')
  return root ? [root] : []
}

function rendered(element: HTMLElement): boolean {
  const style = getComputedStyle(element)
  const closedDetails = element.closest('details:not([open])')
  if (closedDetails && element !== closedDetails.querySelector(':scope > summary')) return false
  return element.isConnected && !element.closest('[inert], [aria-hidden="true"]') &&
    style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0
}

function available(element: HTMLElement): boolean {
  const meaningfulTarget = element.matches('.enemy') ? element.matches('.enemy--targeted')
    : element.matches('.seat') ? element.matches('.seat--targetable, .seat--targeted') : true
  return meaningfulTarget && rendered(element) && !element.matches(':disabled') && !element.closest('[aria-disabled="true"]')
}

function text(element: Element): string {
  return element.textContent?.replace(/\s+/g, ' ').trim() ?? ''
}

function referencedText(element: HTMLElement, attribute: 'aria-labelledby' | 'aria-describedby'): string {
  return (element.getAttribute(attribute) ?? '').split(/\s+/).map((id) => document.getElementById(id)).filter((node) => node)
    .map((node) => text(node!)).filter(Boolean).join(' ')
}

function label(element: HTMLElement): string {
  const labelled = referencedText(element, 'aria-labelledby')
  const labels = element instanceof HTMLInputElement || element instanceof HTMLSelectElement
    ? [...(element.labels ?? [])].map((label) => {
      const copy = label.cloneNode(true) as HTMLLabelElement
      copy.querySelectorAll(CONTROL_SELECTOR).forEach((control) => control.remove())
      return text(copy)
    }).filter(Boolean).join(' ')
    : ''
  return labelled || element.getAttribute('aria-label')?.trim() || labels || text(element) ||
    element.getAttribute('title')?.trim() || (element instanceof HTMLInputElement ? element.placeholder.trim() : '') || 'Unnamed control'
}

function contextLabel(element: HTMLElement): string | undefined {
  const direct = element.dataset.webmcpContext?.trim()
  if (direct) return direct
  const group = element.parentElement?.closest<HTMLElement>(
    'fieldset, [role="group"][aria-label], [role="group"][aria-labelledby], [aria-label], [aria-labelledby]',
  )
  if (!group) return undefined
  const value = group instanceof HTMLFieldSetElement ? text(group.querySelector('legend') ?? group) : label(group)
  return value && value !== label(element) ? value : undefined
}

function controlKind(element: HTMLElement): ControlKind | null {
  if (element instanceof HTMLSelectElement) return 'select'
  if (!(element instanceof HTMLInputElement)) return 'button'
  if (element.type === 'checkbox') return 'checkbox'
  if (element.type === 'text' || element.type === 'search') return 'text'
  if (element.type === 'number' || element.type === 'range') return 'number'
  return null
}

function publicControl(element: HTMLElement, id = ''): Omit<Control, 'element'> | null {
  const kind = controlKind(element)
  if (!kind) return null
  const result: Omit<Control, 'element'> = { id, kind, label: label(element) }
  const context = contextLabel(element)
  const description = referencedText(element, 'aria-describedby')
  if (context) result.context = context
  if (description) result.description = description
  if (element.hasAttribute('aria-pressed')) result.selected = element.getAttribute('aria-pressed') === 'true'
  if (element instanceof HTMLInputElement) result.value = kind === 'checkbox' ? element.checked
    : kind === 'number' ? Number(element.value) : element.value
  if (element instanceof HTMLInputElement && kind === 'number') {
    for (const attribute of ['min', 'max', 'step'] as const) {
      const value = element.getAttribute(attribute)
      if (value !== null && value !== 'any' && Number.isFinite(Number(value))) result[attribute] = Number(value)
    }
  }
  if (element instanceof HTMLInputElement && kind === 'text') {
    result.maxLength = element.maxLength >= 0 ? Math.min(element.maxLength, TEXT_VALUE_LIMIT) : TEXT_VALUE_LIMIT
  }
  if (element instanceof HTMLSelectElement) {
    result.value = element.value
    if (element.required) result.required = true
    result.options = [...element.options].filter((option) => !option.disabled)
      .map((option) => ({ value: option.value, label: text(option) }))
  }
  return result
}

function snapshot(control: Control): Omit<Control, 'id' | 'element'> {
  const { id: _, element: __, ...value } = control
  return value
}

function listedControls(): VisibleControl[] {
  return controls.map(({ element: _, kind, ...control }) => kind === 'button' ? control : { ...control, kind })
}

function visibleControls(): VisibleControl[] {
  const current = activeScopes().flatMap((scope) => [...scope.querySelectorAll<HTMLElement>(
    CONTROL_SELECTOR,
  )]).filter((element) => available(element) && !element.closest('[data-webmcp-passive]')).flatMap((element) => {
    const control = publicControl(element)
    return control ? [{ ...control, element }] : []
  })
  const unchanged = current.length === controls.length && current.every((control, index) => {
    const previous = controls[index]
    return previous?.element === control.element && JSON.stringify(snapshot(previous)) === JSON.stringify(snapshot(control))
  })
  if (!unchanged) controls = identify(current)
  return listedControls()
}

function unavailableControls() {
  const describedRooms = new Set<string>()
  return activeScopes().flatMap((scope) => [...scope.querySelectorAll<HTMLElement>(CONTROL_SELECTOR)])
    .filter((element) => rendered(element) && !available(element) &&
      !element.closest('[data-webmcp-passive]') && !element.matches('.room--visited:not(.room--here)'))
    .flatMap((element) => {
      const control = publicControl(element)
      if (!control) return []
      if (control.kind !== 'button') {
        const { id: _, ...result } = control
        return [result]
      }
      const roomName = element.dataset.webmcpLabel
      const roomType = roomName?.replace(/ \(here\)$/, '')
      const alreadyDescribed = roomType && describedRooms.has(roomType)
      if (roomType) describedRooms.add(roomType)
      return [{
        label: alreadyDescribed ? roomName : control.label,
        ...(control.context ? { context: control.context } : {}),
        ...(control.description ? { description: control.description } : {}),
        ...(control.selected !== undefined ? { selected: control.selected } : {}),
      }]
    })
}

function screenText(scopes: HTMLElement[]): string {
  const chunks: string[] = []
  const describedNodes = scopes.flatMap((scope) => [...scope.querySelectorAll<HTMLElement>('[aria-describedby]')])
    .filter((element) => element.matches(CONTROL_SELECTOR) && controlKind(element) && rendered(element) &&
      !element.closest('[data-webmcp-passive]'))
    .flatMap((element) => (element.getAttribute('aria-describedby') ?? '').split(/\s+/))
    .map((id) => document.getElementById(id)).filter((element): element is HTMLElement => Boolean(element))
  for (const scope of scopes) {
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const parent = walker.currentNode.parentElement
      const value = walker.currentNode.textContent?.replace(/\s+/g, ' ').trim()
      const ownerLabel = parent?.closest('label')
      const candidate = parent?.closest<HTMLElement>(CONTROL_SELECTOR) ?? ownerLabel?.control
      const control = candidate && controlKind(candidate) ? candidate : null
      const duplicatesControl = control && (control instanceof HTMLSelectElement ||
        `${label(control)} ${referencedText(control, 'aria-describedby')}`.includes(value ?? ''))
      if (parent && value && rendered(parent) &&
        !parent.closest('[data-webmcp-passive], [data-webmcp-transient-status]') &&
        !parent.closest(STRUCTURED_TEXT_SELECTOR) &&
        !duplicatesControl &&
        !describedNodes.some((element) => element.contains(parent))) chunks.push(value)
    }
  }
  return chunks.join(' ').replace(/\s+/g, ' ').trim()
}

function announcementElements(includeReported = false) {
  return activeScopes().flatMap((scope) => [...scope.querySelectorAll<HTMLElement>(
    '[data-webmcp-transient-status]',
  )]).filter((element) => element.parentElement && rendered(element.parentElement) && text(element) &&
    (includeReported || element.dataset.webmcpReported !== 'true'))
}

function announcementTexts(elements = announcementElements()) {
  return elements.map(text).map((value) => value.slice(0, SCREEN_TEXT_LIMIT))
}

function acknowledgeAnnouncements(elements: HTMLElement[]) {
  for (const element of elements) element.dataset.webmcpReported = 'true'
}

function gameScreen(announcementNodes = announcementElements()) {
  const scopes = activeScopes()
  const read = (selector: string) => scopes.flatMap((scope) => [...scope.querySelectorAll<HTMLElement>(selector)])
    .filter((element) => rendered(element) && !element.closest('[data-webmcp-passive]')).map(text).filter(Boolean)
  const rawText = screenText(scopes)
  const headings = [...new Set(scopes.flatMap((scope) => [...scope.querySelectorAll<HTMLElement>('h1, h2, h3, [role="heading"]')])
    .filter((element) => rendered(element) && !element.closest('[data-webmcp-passive]'))
    .map((element) => text(element) || element.querySelector('img[alt]')?.getAttribute('alt') || '')
    .filter(Boolean))]
  const status = [...new Set(read('[role="status"], [role="alert"]'))]
  const structuredText = new Set([...headings, ...status])
  const observations = [...new Set(scopes.flatMap((scope) => [
    ...(scope.matches('[aria-label], [aria-labelledby]') ? [scope] : []),
    ...scope.querySelectorAll<HTMLElement>('[aria-label], [aria-labelledby]'),
  ]).filter((element) => rendered(element) && !element.closest('[data-webmcp-passive]') &&
      !element.matches(CONTROL_SELECTOR) &&
      !element.closest('button, summary, [role="button"]')).map(label).filter((value) => value && !structuredText.has(value)))]
  const announcements = announcementTexts(announcementNodes)
  return {
    headings,
    status,
    text: rawText.slice(0, SCREEN_TEXT_LIMIT),
    ...(rawText.length > SCREEN_TEXT_LIMIT ? { textTruncated: true } : {}),
    observations,
    ...(announcements.length > 0 ? { announcements } : {}),
  }
}

function context(): ModelContext | undefined {
  return (document as Document & { modelContext?: ModelContext }).modelContext ??
    (navigator as Navigator & { modelContext?: ModelContext }).modelContext
}

function objectInput(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected an object input.')
  const value = input as Record<string, unknown>
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key))
  if (unexpected) throw new Error(`Unexpected input property: ${unexpected}.`)
  return value
}

function captureGame(input: unknown, acknowledge: boolean) {
  const { offset, textOffset, snapshotId, since } = objectInput(input, ['offset', 'textOffset', 'snapshotId', 'since'])
  if (since !== undefined && (typeof since !== 'string' || !since || since.length > 32)) {
    throw new Error('since must be a revision from the last game response.')
  }
  if (offset !== undefined && (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0)) {
    throw new Error('offset must be a non-negative integer.')
  }
  if (textOffset !== undefined && (typeof textOffset !== 'number' || !Number.isInteger(textOffset) || textOffset < 0)) {
    throw new Error('textOffset must be a non-negative integer.')
  }
  const start = offset ?? 0
  const textStart = textOffset ?? 0
  if (start > 0 && textStart > 0) throw new Error('Page controls or text separately.')
  if (start === 0 && textStart === 0 && snapshotId !== undefined) throw new Error('snapshotId must be omitted on the first page.')
  if ((start > 0 || textStart > 0) && (typeof snapshotId !== 'string' || !snapshotId || snapshotId.length > 32)) {
    throw new Error('snapshotId from the first page is required for later pages.')
  }
  if (interactionPending()) {
    invalidateControls()
    return {
      ...(start === 0 ? { screen: gameScreen() } : {}),
      controls: [],
      unavailableControls: [],
      nextOffset: null,
      pending: true,
    }
  }
  let available = visibleControls()
  const unavailable = unavailableControls()
  const capturedAnnouncements = announcementElements()
  const screen = gameScreen(capturedAnnouncements)
  const textTail = screen.textTruncated ? screenText(activeScopes()).slice(SCREEN_TEXT_LIMIT) : ''
  const fullText = screen.text + textTail
  if (textStart > 0 && textStart >= fullText.length) throw new Error('textOffset is beyond visible screen text.')
  const stateSignature = JSON.stringify({
    screen: { ...screen, announcements: announcementTexts(announcementElements(true)), textTail },
    controls: available.map(({ id: _, ...control }) => control),
    unavailableControls: unavailable,
  })
  if (controlStateSignature && stateSignature !== controlStateSignature) {
    controls = identify(controls)
    available = listedControls()
  }
  const page = textStart ? [] : available.slice(start, start + PAGE_SIZE)
  const unavailablePage = textStart ? [] : unavailable.slice(start, start + PAGE_SIZE)
  const paginationSignature = JSON.stringify({ stateSignature, controlIds: available.map((control) => control.id) })
  if ((start > 0 || textStart > 0) && (snapshotId !== pageSnapshot?.id || paginationSignature !== pageSnapshot?.signature)) {
    invalidateControls()
    throw new Error('Game state changed during pagination. Restart inspect_game at offset 0.')
  }
  if (start === 0 && textStart === 0) pageSnapshot = { id: String(++pageSnapshotSequence), signature: paginationSignature }
  controlStateSignature = stateSignature
  const nextOffset = !textStart && start + PAGE_SIZE < Math.max(available.length, unavailable.length) ? start + PAGE_SIZE : null
  const textNextOffset = textStart + SCREEN_TEXT_LIMIT < fullText.length ? textStart + SCREEN_TEXT_LIMIT : null
  const result = {
    ...(start === 0 ? { screen: textStart ? { ...screen, text: fullText.slice(textStart, textStart + SCREEN_TEXT_LIMIT),
      textOffset: textStart, textTruncated: textNextOffset !== null, ...(textNextOffset !== null ? { textNextOffset } : {}) } :
      { ...screen, ...(textNextOffset !== null ? { textNextOffset } : {}) } } : {}),
    controls: page,
    unavailableControls: unavailablePage,
    ...(nextOffset !== null || textNextOffset !== null ? {
      totalUnavailableControls: unavailable.length,
      totalControls: available.length,
      snapshotId: pageSnapshot!.id,
    } : {}),
    ...(!textStart && start + unavailablePage.length < unavailable.length ? { unavailableControlsTruncated: true } : {}),
    nextOffset,
  }
  if (acknowledge) acknowledgeAnnouncements(capturedAnnouncements)
  return result
}

function publishGame(state: ReturnType<typeof captureGame>, since?: string) {
  if ('pending' in state || state.nextOffset !== null || !state.screen || state.screen.textTruncated ||
    'textOffset' in state.screen) {
    published = null
    return state
  }
  const revision = String(++publicationSequence)
  const previous = published
  published = { revision, state }
  if (since && previous?.revision === since) {
    const screen = Object.fromEntries(Object.entries(state.screen).filter(([key, value]) =>
      JSON.stringify(value) !== JSON.stringify((previous.state.screen as Record<string, unknown> | undefined)?.[key])))
    const removedScreen = Object.keys(previous.state.screen ?? {}).filter((key) => !Object.hasOwn(state.screen!, key))
    const changes = Object.fromEntries(Object.entries(state).filter(([key, value]) => key !== 'screen' &&
      JSON.stringify(value) !== JSON.stringify((previous.state as Record<string, unknown>)[key])))
    const removed = Object.keys(previous.state).filter((key) => !Object.hasOwn(state, key))
    return { baseRevision: since, revision, changes: { ...changes, ...(Object.keys(screen).length ? { screen } : {}) },
      ...(removed.length ? { removed } : {}), ...(removedScreen.length ? { removedScreen } : {}) }
  }
  return { ...state, revision }
}

function inspectGame(input: unknown) {
  const { since } = objectInput(input, ['offset', 'textOffset', 'snapshotId', 'since'])
  return publishGame(captureGame(input, true), since as string | undefined)
}

async function getStats(input: unknown, signal?: AbortSignal) {
  const { character = 'all', ascension = 'all', mode = 'standard', query = '', candidates, full = false } =
    objectInput(input, ['character', 'ascension', 'mode', 'query', 'candidates', 'full'])
  if (!STATS_HEROES.some((hero) => hero === character)) throw new Error('Choose a listed character.')
  if (!(ascension === 'all' || typeof ascension === 'number' && Number.isInteger(ascension) && ascension >= 0 && ascension <= 13 ||
    typeof ascension === 'string' && /^(?:[0-9]|10)\+$/.test(ascension))) throw new Error('Choose Ascension 0–13, 0+–10+, or all.')
  if (!STATS_MODES.some((availableMode) => availableMode === mode)) throw new Error('Choose a listed run mode.')
  if (typeof query !== 'string' || query.length > TEXT_VALUE_LIMIT) throw new Error('Card query must be at most 1000 characters.')
  if (candidates !== undefined && (!Array.isArray(candidates) || candidates.length > 24 ||
    candidates.some((id) => typeof id !== 'string' || !Object.hasOwn(CARDS, id)))) {
    throw new Error('Candidates must be at most 24 known card IDs.')
  }
  const selectedCandidates = candidates as string[] | undefined
  if (typeof full !== 'boolean') throw new Error('full must be a boolean.')
  const parsed = parseStatsExpression(query, STATS_CHOICES)
  validateStatsQuery(parsed)
  const filters: StatsFilters = {
    character: character as StatsFilters['character'], ascension: ascension as StatsFilters['ascension'],
    mode: mode as StatsFilters['mode'], query: parsed,
  }
  const result = await loadStats(filters, signal ?? new AbortController().signal)
  const nextCards = selectedCandidates?.length ? result.nextCards.filter((card) => selectedCandidates.includes(card.defId)) : result.nextCards
  return { filters: { character, ascension, mode, query },
    runs: result.runs, averageFloors: result.averageFloors, averageDamage: result.averageDamage,
    averageBlock: result.averageBlock, pending: result.pending,
    rows: full ? result.rows : result.rows.slice(0, 5), totalRows: result.rows.length,
    nextCards: full ? nextCards : nextCards.slice(0, 12), totalNextCards: nextCards.length,
    ...(selectedCandidates?.length ? { notInTopComparisons: selectedCandidates.filter((id) => !nextCards.some((card) => card.defId === id)) } : {}),
  }
}

function stateSignature() {
  const screen = gameScreen()
  return JSON.stringify({
    screen: { ...screen, announcements: announcementTexts(announcementElements(true)),
      textTail: screen.textTruncated ? screenText(activeScopes()).slice(SCREEN_TEXT_LIMIT) : '' },
    controls: visibleControls().map(({ id: _, ...control }) => control),
    unavailableControls: unavailableControls(),
  })
}

function hasProgressControl(state: ReturnType<typeof captureGame>) {
  return state.controls.some((control) => !/^(Current deck|Map$|Settings$|Discard pile|Exhaust pile)/.test(control.label))
}

async function waitForInteraction(before: string, signal?: AbortSignal, shortQuietChecks = 7) {
  const deadline = Date.now() + 10_000
  let lastSignature = before
  let quietChecks = 0
  do {
    if (signal?.aborted) throw new DOMException('Tool execution was cancelled.', 'AbortError')
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
    if (signal?.aborted) throw new DOMException('Tool execution was cancelled.', 'AbortError')
    if (interactionPending()) {
      quietChecks = 0
      continue
    }
    const state = captureGame({}, false)
    const signature = controlStateSignature
    if (signature === lastSignature) {
      if (++quietChecks >= (signature === before || hasProgressControl(state) ? shortQuietChecks : 20)) {
        return captureGame({}, true)
      }
      continue
    }
    lastSignature = signature
    quietChecks = 0
  } while (Date.now() < deadline)
  return null
}

function setValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
}

export function useWebMcp() {
  useEffect(() => {
    const tools: Tool[] = [
      {
        name: 'inspect_game',
        title: 'Inspect game',
        description: 'Read start-turn and relic choices. unavailableControls (future rooms) are planning-only. Pass since for changes; continue nextOffset/textNextOffset if set.',
        inputSchema: {
          type: 'object',
          properties: {
            offset: { type: 'integer', minimum: 0, description: 'Control-page offset.' },
            textOffset: { type: 'integer', minimum: 0, description: 'Visible-text offset from textNextOffset.' },
            snapshotId: { type: 'string', maxLength: 32, description: 'First-page ID for later pages.' },
            since: { type: 'string', maxLength: 32, description: 'Revision from prior state for lossless changes.' },
          },
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        execute: inspectGame,
      },
      {
        name: 'interact_with_game',
        title: 'Interact with game',
        description: 'Use a listed controlId for start-turn, relic, or other choices. Returns settled state. Pass since for lossless changes; inspect if pending or timed out.',
        inputSchema: {
          type: 'object',
          properties: {
            controlId: { type: 'string', minLength: 1, maxLength: 64, description: 'ID from the latest state.' },
            since: { type: 'string', maxLength: 32, description: 'Revision from prior state for lossless changes.' },
            value: {
              oneOf: [{ type: 'string', maxLength: TEXT_VALUE_LIMIT }, { type: 'number' }, { type: 'boolean' }],
              description: 'Control value when needed.',
            },
          },
          required: ['controlId'],
          additionalProperties: false,
        },
        annotations: { untrustedContentHint: true },
        execute: async (input, options) => {
          if (options?.signal?.aborted) throw new DOMException('Tool execution was cancelled.', 'AbortError')
          if (interactionPending()) {
            invalidateControls()
            throw new Error('Game interaction is pending. Wait and call inspect_game again.')
          }
          const { controlId, value, since } = objectInput(input, ['controlId', 'value', 'since'])
          if (since !== undefined && (typeof since !== 'string' || !since || since.length > 32)) {
            throw new Error('since must be a revision from the last game response.')
          }
          if (typeof controlId !== 'string' || controlId.length === 0 || controlId.length > 64) {
            throw new Error('controlId must be a listed control ID.')
          }
          visibleControls()
          const entry = controls.find((control) => control.id === controlId)
          const element = entry?.element
          const current = element ? publicControl(element, controlId) : null
          if (!entry || !element || !available(element) || !current || JSON.stringify(snapshot(entry)) !== JSON.stringify(snapshot({ ...current, element }))) {
            throw new Error('Control is no longer available. Call inspect_game again.')
          }
          const before = stateSignature()
          if (before !== controlStateSignature) {
            invalidateControls()
            throw new Error('Game state changed. Call inspect_game again.')
          }
          if (entry.kind === 'button') {
            if (value !== undefined) throw new Error('value must be omitted for a button.')
            element.click()
          } else if (entry.kind === 'checkbox') {
            if (typeof value !== 'boolean') throw new Error('value must be a boolean for a checkbox.')
            const checkbox = element as HTMLInputElement
            if (checkbox.checked !== value) checkbox.click()
          } else if (entry.kind === 'number') {
            if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('value must be a finite number for a number control.')
            const input = element as HTMLInputElement
            if ((input.min && value < Number(input.min)) || (input.max && value > Number(input.max))) {
              throw new Error('value must be within the listed control range.')
            }
            const step = input.step && input.step !== 'any' ? Number(input.step) : 1
            const base = input.min ? Number(input.min) : 0
            if (Number.isFinite(step) && step > 0 && Math.abs((value - base) / step - Math.round((value - base) / step)) > 1e-9) {
              throw new Error('value must match the listed control step.')
            }
            setValue(input, String(value))
          } else {
            let nextValue = value
            if (element instanceof HTMLSelectElement && nextValue === undefined && element.required && element.value === '') {
              const alternatives = [...element.options].filter((option) => !option.disabled && option.value)
              if (alternatives.length === 1) nextValue = alternatives[0]!.value
            }
            if (typeof nextValue !== 'string') throw new Error(`value must be a string for a ${entry.kind}.`)
            if (element instanceof HTMLSelectElement && ![...element.options].some((option) => !option.disabled && option.value === nextValue)) {
              throw new Error('value must match an enabled listed option.')
            }
            const limit = element instanceof HTMLInputElement && element.maxLength >= 0
              ? Math.min(element.maxLength, TEXT_VALUE_LIMIT) : TEXT_VALUE_LIMIT
            if (nextValue.length > limit) {
              throw new Error(`value must be at most ${limit} characters.`)
            }
            setValue(element as HTMLInputElement | HTMLSelectElement, nextValue)
          }
          invalidateControls()
          const target = element.matches('.enemy, .seat, .row__enemies--targetable')
          const state = await waitForInteraction(before, options?.signal, target ? 18 : 7)
          return state ? publishGame(state, since as string | undefined) : { pending: true }
        },
      },
      {
        name: 'get_stats',
        title: 'Get deck statistics',
        description: 'Read solo deck outcomes during a run without leaving combat. Filter by hero, Ascension, and card expression; compare candidate card IDs. Set full=true for all rows.',
        inputSchema: {
          type: 'object',
          properties: {
            character: { type: 'string', enum: [...STATS_HEROES], description: 'Hero, or all. Defaults to all.' },
            ascension: { oneOf: [{ type: 'integer', minimum: 0, maximum: 13 }, { type: 'string', pattern: '^(?:all|(?:[0-9]|10)\\+)$' }], description: 'Exact Ascension, threshold 0+–10+, or all.' },
            mode: { type: 'string', enum: [...STATS_MODES], description: 'Defaults to standard solo runs.' },
            query: { type: 'string', maxLength: TEXT_VALUE_LIMIT, description: 'Card expression, e.g. @hermit_snapshot and not @hermit_strike. Use defining deck cards.' },
            candidates: { type: 'array', maxItems: 24, items: { type: 'string' }, description: 'Show listed comparisons for reward card IDs; missing cards may be outside the archive top 24.' },
            full: { type: 'boolean', description: 'Include all archetype rows and requested comparisons.' },
          },
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        execute: (input, options) => getStats(input, options?.signal),
      },
    ]
    let stopped = false
    let retry: number | undefined
    let registration: AbortController | undefined
    let reportedRegistrationError = false
    const register = async () => {
      const modelContext = context()
      if (!modelContext) {
        retry = window.setTimeout(register, 1_000)
        return
      }
      const attempt = new AbortController()
      registration = attempt
      try {
        await Promise.all(tools.map((tool) => modelContext.registerTool(tool, { signal: attempt.signal })))
      } catch (error) {
        attempt.abort()
        if (!stopped) {
          if (!reportedRegistrationError) console.error('WebMCP tool registration failed.', error)
          reportedRegistrationError = true
          retry = window.setTimeout(register, 1_000)
        }
      }
    }
    void register()
    return () => {
      stopped = true
      if (retry !== undefined) window.clearTimeout(retry)
      registration?.abort()
      invalidateControls()
    }
  }, [])
}
