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
  execute: (input: unknown, options: { signal: AbortSignal }) => unknown
}

type ModelContext = {
  registerTool: (tool: Tool, options?: { signal?: AbortSignal }) => Promise<void>
}

type VisibleAction = { id: string; label: string }
type Action = VisibleAction & { button: HTMLButtonElement }

const PAGE_SIZE = 20
let actions: Action[] = []

function visible(element: HTMLElement): boolean {
  const style = getComputedStyle(element)
  const modal = document.querySelector<HTMLElement>('dialog:modal, [role="dialog"][aria-modal="true"]')
  return element.isConnected && !element.matches(':disabled') && !element.closest('[inert], [aria-disabled="true"]') &&
    (!modal || modal.contains(element)) && style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0
}

function text(element: HTMLElement): string {
  return element.textContent?.replace(/\s+/g, ' ').trim() ?? ''
}

function label(button: HTMLButtonElement): string {
  return button.getAttribute('title')?.trim() || text(button) || button.getAttribute('aria-label')?.trim() || 'Unnamed action'
}

function visibleActions(): VisibleAction[] {
  const current = [...document.querySelectorAll<HTMLButtonElement>('#root button:not(:disabled), .card-picker button:not(:disabled)')]
    .filter(visible)
    .map((button) => ({ button, label: label(button) }))
  const unchanged = current.length === actions.length && current.every((action, index) =>
    action.button === actions[index]?.button && action.label === actions[index]?.label)
  if (!unchanged) actions = current.map((action) => ({ ...action, id: crypto.randomUUID() }))
  return actions.map(({ id, label }) => ({ id, label }))
}

function gameStatus() {
  const root = document.getElementById('root')
  if (!root) return { headings: [], status: [] }
  const roots = [root, ...document.querySelectorAll<HTMLElement>('.card-picker')]
  const read = (selector: string) => roots.flatMap((scope) => [...scope.querySelectorAll<HTMLElement>(selector)])
    .filter(visible)
    .map(text)
    .filter(Boolean)
  return { headings: read('h1, h2, [role="heading"]'), status: read('[role="status"], [role="alert"]') }
}

function context(): ModelContext | undefined {
  return (document as Document & { modelContext?: ModelContext }).modelContext
}

function objectInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected an object input.')
  return input as Record<string, unknown>
}

export function useWebMcp() {
  useEffect(() => {
    const modelContext = context()
    if (!modelContext) return
    const controller = new AbortController()
    const tools: Tool[] = [
      {
        name: 'read_game_status',
        title: 'Read game status',
        description: 'Read the current visible game headings and status messages.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        execute: (input) => {
          objectInput(input)
          return gameStatus()
        },
      },
      {
        name: 'list_visible_game_actions',
        title: 'List visible game actions',
        description: 'List enabled visible game buttons. Use an action ID from this result with perform_visible_game_action.',
        inputSchema: {
          type: 'object',
          properties: { offset: { type: 'integer', minimum: 0, description: 'Zero-based page offset.' } },
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        execute: (input) => {
          const offset = objectInput(input).offset
          if (offset !== undefined && (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0)) {
            throw new Error('offset must be a non-negative integer.')
          }
          const available = visibleActions()
          const start = offset ?? 0
          const page = available.slice(start, start + PAGE_SIZE)
          return { actions: page, nextOffset: start + page.length < available.length ? start + page.length : null }
        },
      },
      {
        name: 'perform_visible_game_action',
        title: 'Perform visible game action',
        description: 'Perform one enabled visible game button by its current action ID. Call list_visible_game_actions first.',
        inputSchema: {
          type: 'object',
          properties: { actionId: { type: 'string', minLength: 1, maxLength: 64, description: 'Action ID returned by list_visible_game_actions.' } },
          required: ['actionId'],
          additionalProperties: false,
        },
        annotations: { consequentialHint: true, untrustedContentHint: true },
        execute: (input, options) => {
          if (options.signal.aborted) throw new DOMException('Tool execution was cancelled.', 'AbortError')
          const actionId = objectInput(input).actionId
          if (typeof actionId !== 'string' || actionId.length === 0 || actionId.length > 64) {
            throw new Error('actionId must be a listed action ID.')
          }
          const actionEntry = actions.find((entry) => entry.id === actionId)
          const button = actionEntry?.button
          if (!button || button.disabled || !visible(button) || label(button) !== actionEntry.label) {
            throw new Error('Action is no longer available. Call list_visible_game_actions again.')
          }
          const action = label(button)
          button.click()
          return { actionId, action }
        },
      },
    ]
    void Promise.all(tools.map((tool) => modelContext.registerTool(tool, { signal: controller.signal }))).catch((error: unknown) => {
      if (!controller.signal.aborted) console.error('WebMCP tool registration failed.', error)
    })
    return () => controller.abort()
  }, [])
}
