import { useEffect } from 'react'

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
  execute: (input: unknown, options?: { signal: AbortSignal }) => unknown
}

type ModelContext = {
  registerTool: (tool: Tool, options?: { signal?: AbortSignal }) => Promise<void>
}

type ControlKind = 'button' | 'checkbox' | 'select' | 'text' | 'number'
type VisibleControl = {
  id: string
  kind: ControlKind
  label: string
  context?: string
  description?: string
  selected?: boolean
  value?: string | number | boolean
  min?: number
  max?: number
  step?: number
  maxLength?: number
  options?: { value: string; label: string }[]
}
type Control = VisibleControl & { element: HTMLElement }

const PAGE_SIZE = 30
const SCREEN_TEXT_LIMIT = 8_000
const TEXT_VALUE_LIMIT = 1_000
const CONTROL_SELECTOR = 'button, summary, input, select, [role="button"]'
let controls: Control[] = []
let controlStateSignature = ''
let pageSnapshot: { id: string; signature: string } | null = null
let pageSnapshotSequence = 0

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
    ? [...(element.labels ?? [])].map(text).filter(Boolean).join(' ')
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

function publicControl(element: HTMLElement, id = ''): VisibleControl | null {
  const kind = controlKind(element)
  if (!kind) return null
  const result: VisibleControl = { id, kind, label: label(element) }
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
    result.options = [...element.options].filter((option) => !option.disabled)
      .map((option) => ({ value: option.value, label: text(option) }))
  }
  return result
}

function snapshot(control: Control): Omit<Control, 'id' | 'element'> {
  const { id: _, element: __, ...value } = control
  return value
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
  if (!unchanged) controls = current.map((control) => ({ ...control, id: crypto.randomUUID() }))
  return controls.map(({ element: _, ...control }) => control)
}

function unavailableControls() {
  return activeScopes().flatMap((scope) => [...scope.querySelectorAll<HTMLElement>(CONTROL_SELECTOR)])
    .filter((element) => rendered(element) && !available(element) && !element.closest('[data-webmcp-passive]'))
    .flatMap((element) => {
      const control = publicControl(element)
      if (!control) return []
      const { id: _, ...result } = control
      return [result]
    })
}

function screenText(scopes: HTMLElement[]): string {
  const chunks: string[] = []
  for (const scope of scopes) {
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const parent = walker.currentNode.parentElement
      const value = walker.currentNode.textContent?.replace(/\s+/g, ' ').trim()
      if (parent && value && rendered(parent) &&
        !parent.closest('[data-webmcp-passive], [data-webmcp-transient-status]')) chunks.push(value)
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
  const observations = [...new Set(scopes.flatMap((scope) => [
    ...(scope.matches('[aria-label], [aria-labelledby]') ? [scope] : []),
    ...scope.querySelectorAll<HTMLElement>('[aria-label], [aria-labelledby]'),
  ]).filter((element) => rendered(element) && !element.closest('[data-webmcp-passive]') &&
      !element.matches(CONTROL_SELECTOR) &&
      !element.closest('button, summary, [role="button"]')).map(label).filter(Boolean))]
  const announcements = announcementTexts(announcementNodes)
  return {
    headings: [...new Set(read('h1, h2, h3, [role="heading"]'))],
    status: [...new Set(read('[role="status"], [role="alert"]'))],
    text: rawText.slice(0, SCREEN_TEXT_LIMIT),
    textTruncated: rawText.length > SCREEN_TEXT_LIMIT,
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
  const { offset, snapshotId } = objectInput(input, ['offset', 'snapshotId'])
  if (offset !== undefined && (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0)) {
    throw new Error('offset must be a non-negative integer.')
  }
  const start = offset ?? 0
  if (start === 0 && snapshotId !== undefined) throw new Error('snapshotId must be omitted when offset is 0.')
  if (start > 0 && (typeof snapshotId !== 'string' || snapshotId.length === 0 || snapshotId.length > 32)) {
    throw new Error('snapshotId from the first page is required when offset is greater than 0.')
  }
  if (interactionPending()) {
    invalidateControls()
    return {
      ...(start === 0 ? { screen: gameScreen() } : {}),
      controls: [],
      unavailableControls: [],
      totalUnavailableControls: 0,
      unavailableControlsTruncated: false,
      totalControls: 0,
      nextOffset: null,
      pending: true,
    }
  }
  let available = visibleControls()
  const unavailable = unavailableControls()
  const capturedAnnouncements = announcementElements()
  const screen = gameScreen(capturedAnnouncements)
  const stateSignature = JSON.stringify({
    screen: { ...screen, announcements: announcementTexts(announcementElements(true)) },
    controls: available.map(({ id: _, ...control }) => control),
    unavailableControls: unavailable,
  })
  if (controlStateSignature && stateSignature !== controlStateSignature) {
    controls = controls.map((control) => ({ ...control, id: crypto.randomUUID() }))
    available = controls.map(({ element: _, ...control }) => control)
  }
  const page = available.slice(start, start + PAGE_SIZE)
  const unavailablePage = unavailable.slice(start, start + PAGE_SIZE)
  const paginationSignature = JSON.stringify({ stateSignature, controlIds: available.map((control) => control.id) })
  if (start > 0 && (snapshotId !== pageSnapshot?.id || paginationSignature !== pageSnapshot?.signature)) {
    invalidateControls()
    throw new Error('Game state changed during pagination. Restart inspect_game at offset 0.')
  }
  if (start === 0) pageSnapshot = { id: String(++pageSnapshotSequence), signature: paginationSignature }
  controlStateSignature = stateSignature
  const result = {
    ...(start === 0 ? { screen } : {}),
    controls: page,
    unavailableControls: unavailablePage,
    totalUnavailableControls: unavailable.length,
    unavailableControlsTruncated: start + unavailablePage.length < unavailable.length,
    totalControls: available.length,
    snapshotId: pageSnapshot!.id,
    nextOffset: start + PAGE_SIZE < Math.max(available.length, unavailable.length) ? start + PAGE_SIZE : null,
  }
  if (acknowledge) acknowledgeAnnouncements(capturedAnnouncements)
  return result
}

function inspectGame(input: unknown) {
  return captureGame(input, true)
}

function stateSignature() {
  const screen = gameScreen()
  return JSON.stringify({
    screen: { ...screen, announcements: announcementTexts(announcementElements(true)) },
    controls: visibleControls().map(({ id: _, ...control }) => control),
    unavailableControls: unavailableControls(),
  })
}

function hasProgressControl(state: ReturnType<typeof inspectGame>) {
  return state.controls.some((control) => !/^(Current deck|Map$|Settings$|Discard pile|Exhaust pile)/.test(control.label))
}

async function waitForInteraction(before: string, signal?: AbortSignal) {
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
      if (++quietChecks >= (signature === before || hasProgressControl(state) ? 7 : 20)) {
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
    const modelContext = context()
    if (!modelContext) return
    const controller = new AbortController()
    const tools: Tool[] = [
      {
        name: 'inspect_game',
        title: 'Inspect game',
        description: 'Read only the current viewer-visible game screen and list its gameplay controls. Call this first; after a successful interaction use the refreshed state returned by interact_with_game instead. Follow nextOffset until null to see every enabled and unavailable choice, passing snapshotId on continuation pages; they omit unchanged screen text and reject mixed states. Results include route topology, rich card and enemy descriptions, control state, and opaque control IDs. While pending is true, wait and inspect again; no actions are exposed.',
        inputSchema: {
          type: 'object',
          properties: {
            offset: { type: 'integer', minimum: 0, description: 'Zero-based control page offset.' },
            snapshotId: { type: 'string', maxLength: 32, description: 'First-page snapshotId, required with nonzero offset.' },
          },
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        execute: inspectGame,
      },
      {
        name: 'interact_with_game',
        title: 'Interact with game',
        description: 'Use one control ID from the latest state to click it or set its value through the same visible UI path a human uses. Pass a boolean for a checkbox, a listed string for a select or text control, and a number for a number or range control; omit value for buttons. Changes only this game session. A settled call returns the refreshed state and new control IDs; if pending is true, wait and call inspect_game once.',
        inputSchema: {
          type: 'object',
          properties: {
            controlId: { type: 'string', minLength: 1, maxLength: 64, description: 'Opaque control ID returned by inspect_game.' },
            value: {
              oneOf: [{ type: 'string', maxLength: TEXT_VALUE_LIMIT }, { type: 'number' }, { type: 'boolean' }],
              description: 'Required for form controls; omit for buttons.',
            },
          },
          required: ['controlId'],
          additionalProperties: false,
        },
        annotations: { untrustedContentHint: true },
        execute: async (input, options) => {
          if (options?.signal.aborted) throw new DOMException('Tool execution was cancelled.', 'AbortError')
          if (interactionPending()) {
            invalidateControls()
            throw new Error('Game interaction is pending. Wait and call inspect_game again.')
          }
          const { controlId, value } = objectInput(input, ['controlId', 'value'])
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
            if (typeof value !== 'string') throw new Error(`value must be a string for a ${entry.kind}.`)
            if (element instanceof HTMLSelectElement && ![...element.options].some((option) => !option.disabled && option.value === value)) {
              throw new Error('value must match an enabled listed option.')
            }
            const limit = element instanceof HTMLInputElement && element.maxLength >= 0
              ? Math.min(element.maxLength, TEXT_VALUE_LIMIT) : TEXT_VALUE_LIMIT
            if (value.length > limit) {
              throw new Error(`value must be at most ${limit} characters.`)
            }
            setValue(element as HTMLInputElement | HTMLSelectElement, value)
          }
          invalidateControls()
          const state = await waitForInteraction(before, options?.signal)
          return state ? { action: entry.label, state }
            : { action: entry.label, pending: true, next: 'Call inspect_game after the action settles.' }
        },
      },
    ]
    void Promise.all(tools.map((tool) => modelContext.registerTool(tool, { signal: controller.signal }))).catch((error: unknown) => {
      if (!controller.signal.aborted) console.error('WebMCP tool registration failed.', error)
    })
    return () => {
      controller.abort()
      invalidateControls()
    }
  }, [])
}
