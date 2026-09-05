import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { suite, check, assert, assertDeepEqual, report } from './lib/harness.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const server = await createServer({ root: repoRoot, logLevel: 'silent', server: { port: 0 } })
await server.listen()
const address = server.httpServer?.address()
if (!address || typeof address === 'string') throw new Error('vite did not report a port')
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
page.on('pageerror', (error) => errors.push(String(error)))

await page.addInitScript(() => {
  const tools = new Map()
  const modelContext = {
    registerTool(tool, options = {}) {
      tools.set(tool.name, tool)
      options.signal?.addEventListener('abort', () => {
        if (tools.get(tool.name) === tool) tools.delete(tool.name)
      }, { once: true })
      return Promise.resolve()
    },
    getTools() {
      return Promise.resolve([...tools.values()])
    },
    async executeTool(tool, input = {}) {
      const registered = tools.get(tool.name)
      if (!registered) throw new Error(`Unknown tool: ${tool.name}`)
      return JSON.stringify(await registered.execute(input, { signal: new AbortController().signal }))
    },
  }
  Object.defineProperty(document, 'modelContext', { configurable: true, value: modelContext })
})

await page.goto(`http://localhost:${address.port}`)
await page.waitForFunction(async () => (await document.modelContext.getTools()).length === 3)
const tools = await page.evaluate(async () => (await document.modelContext.getTools()).map((tool) => ({
  name: tool.name,
  annotations: tool.annotations,
})))
const result = await page.evaluate(async () => {
  const tools = await document.modelContext.getTools()
  const tool = (name) => tools.find((candidate) => candidate.name === name)
  const status = JSON.parse(await document.modelContext.executeTool(tool('read_game_status')))
  const actions = JSON.parse(await document.modelContext.executeTool(tool('list_visible_game_actions'), { offset: 0 }))
  return { status, actions }
})
const malformed = await page.evaluate(async () => {
  const tools = await document.modelContext.getTools()
  const run = async (name, input) => {
    const tool = tools.find((candidate) => candidate.name === name)
    try {
      await document.modelContext.executeTool(tool, input)
      return ''
    } catch (error) {
      return String(error)
    }
  }
  return {
    statusNull: await run('read_game_status', null),
    listNull: await run('list_visible_game_actions', null),
    listOffset: await run('list_visible_game_actions', { offset: -1 }),
    actionNull: await run('perform_visible_game_action', null),
    actionId: await run('perform_visible_game_action', { actionId: '' }),
  }
})
const pagination = await page.evaluate(async () => {
  const fixture = document.createElement('div')
  fixture.setAttribute('aria-label', 'WebMCP pagination fixture')
  let clicks = 0
  for (let index = 1; index <= 25; index++) {
    const button = document.createElement('button')
    button.textContent = `WebMCP page action ${index}`
    button.addEventListener('click', () => { clicks++ })
    fixture.append(button)
  }
  document.getElementById('root').append(fixture)
  const tools = await document.modelContext.getTools()
  const listTool = tools.find((tool) => tool.name === 'list_visible_game_actions')
  const actionTool = tools.find((tool) => tool.name === 'perform_visible_game_action')
  const firstPage = JSON.parse(await document.modelContext.executeTool(listTool, { offset: 0 }))
  const firstAction = firstPage.actions.find((action) => action.label === 'WebMCP page action 1')
  const secondPage = JSON.parse(await document.modelContext.executeTool(listTool, { offset: firstPage.nextOffset }))
  if (!firstAction || secondPage.nextOffset === undefined) throw new Error('pagination fixture did not span two pages')
  await document.modelContext.executeTool(actionTool, { actionId: firstAction.id })
  fixture.remove()
  return { clicks, hasNextPage: firstPage.nextOffset !== null, secondPageActions: secondPage.actions.length }
})
const portal = await page.evaluate(async () => {
  const picker = document.createElement('section')
  picker.className = 'card-picker'
  picker.setAttribute('role', 'dialog')
  picker.setAttribute('aria-modal', 'true')
  picker.innerHTML = '<h2>Portal card picker</h2><button>Portal card action</button>'
  let clicks = 0
  picker.querySelector('button').addEventListener('click', () => { clicks++ })
  document.body.append(picker)
  const tools = await document.modelContext.getTools()
  const statusTool = tools.find((tool) => tool.name === 'read_game_status')
  const listTool = tools.find((tool) => tool.name === 'list_visible_game_actions')
  const actionTool = tools.find((tool) => tool.name === 'perform_visible_game_action')
  const status = JSON.parse(await document.modelContext.executeTool(statusTool, {}))
  const listed = JSON.parse(await document.modelContext.executeTool(listTool, { offset: 0 }))
  const action = listed.actions.find((candidate) => candidate.label === 'Portal card action')
  if (!action) throw new Error('portal card picker action was not listed')
  await document.modelContext.executeTool(actionTool, { actionId: action.id })
  picker.remove()
  return { clicks, heading: status.headings.includes('Portal card picker') }
})
const singlePlayer = result.actions.actions.find((action) => action.label === 'Single Player')
if (!singlePlayer) throw new Error('the visible action list does not include Single Player')
const exclusions = await page.evaluate(async () => {
  const tools = await document.modelContext.getTools()
  const listTool = tools.find((tool) => tool.name === 'list_visible_game_actions')
  const actionTool = tools.find((tool) => tool.name === 'perform_visible_game_action')
  const listLabels = async () => {
    const result = JSON.parse(await document.modelContext.executeTool(listTool, { offset: 0 }))
    return result.actions.map((action) => action.label)
  }
  const single = document.querySelector('button[aria-label="Single Player"]')
  const menu = single.parentElement
  single.setAttribute('aria-disabled', 'true')
  const ariaDisabled = !(await listLabels()).includes('Single Player')
  single.removeAttribute('aria-disabled')
  menu.setAttribute('inert', '')
  const inert = !(await listLabels()).includes('Single Player')
  menu.removeAttribute('inert')
  const dialog = document.createElement('dialog')
  document.getElementById('root').append(dialog)
  dialog.showModal()
  const modal = !(await listLabels()).includes('Single Player')
  dialog.close()
  dialog.remove()
  const fresh = JSON.parse(await document.modelContext.executeTool(listTool, { offset: 0 }))
  const action = fresh.actions.find((candidate) => candidate.label === 'Single Player')
  if (!action) throw new Error('Single Player did not return after removing the interaction locks')
  menu.setAttribute('inert', '')
  let guarded = ''
  try {
    await document.modelContext.executeTool(actionTool, { actionId: action.id })
  } catch (error) {
    guarded = String(error)
  }
  menu.removeAttribute('inert')
  return { ariaDisabled, inert, modal, guarded, actionId: action.id }
})
const guessed = await page.evaluate(async () => {
  const tools = await document.modelContext.getTools()
  const actionTool = tools.find((tool) => tool.name === 'perform_visible_game_action')
  try {
    await document.modelContext.executeTool(actionTool, { actionId: 'action-1-1' })
    return ''
  } catch (error) {
    return String(error)
  }
})
const invoked = await page.evaluate(async (actionId) => {
  const tools = await document.modelContext.getTools()
  const actionTool = tools.find((tool) => tool.name === 'perform_visible_game_action')
  return JSON.parse(await document.modelContext.executeTool(actionTool, { actionId }))
}, exclusions.actionId)
await page.getByRole('heading', { name: 'Choose your run' }).waitFor()
const stale = await page.evaluate(async (actionId) => {
  const tools = await document.modelContext.getTools()
  const actionTool = tools.find((tool) => tool.name === 'perform_visible_game_action')
  try {
    await document.modelContext.executeTool(actionTool, { actionId })
    return ''
  } catch (error) {
    return String(error)
  }
}, exclusions.actionId)
const fallback = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const fallbackErrors = []
fallback.on('console', (message) => { if (message.type() === 'error') fallbackErrors.push(message.text()) })
fallback.on('pageerror', (error) => fallbackErrors.push(String(error)))
await fallback.goto(`http://localhost:${address.port}`)
await fallback.getByRole('button', { name: 'Single Player' }).waitFor()
await fallback.close()

suite('WebMCP browser contract')

check('registers concise, safely annotated game tools', () => {
  assertDeepEqual(tools.map((tool) => tool.name), [
    'read_game_status',
    'list_visible_game_actions',
    'perform_visible_game_action',
  ])
  assert(tools[0].annotations.readOnlyHint && tools[0].annotations.untrustedContentHint,
    'status output is read-only and marked untrusted')
  assert(tools[1].annotations.readOnlyHint && tools[1].annotations.untrustedContentHint,
    'action labels are read-only and marked untrusted')
  assert(tools[2].annotations.consequentialHint && tools[2].annotations.untrustedContentHint,
    'gameplay actions require consequential-action handling')
})

check('lists the visible screen and invokes only a freshly listed action', () => {
  assert(result.status.headings.length > 0, 'status reads the visible start screen')
  assert(malformed.statusNull.includes('Expected an object input') && malformed.listNull.includes('Expected an object input') && malformed.listOffset.includes('offset must be') &&
    malformed.actionNull.includes('Expected an object input') && malformed.actionId.includes('actionId must be'),
  'malformed tool inputs return clear retryable errors')
  assert(pagination.hasNextPage && pagination.secondPageActions > 0 && pagination.clicks === 1,
    'a page-one action remains valid after fetching the next page')
  assert(portal.heading && portal.clicks === 1, 'portal card-picker status and actions remain available')
  assert(exclusions.ariaDisabled && exclusions.inert && exclusions.modal,
    'aria-disabled, inert, and modal-occluded controls are not listed')
  assert(exclusions.guarded.includes('Action is no longer available'), 'an interaction lock prevents a stale token from executing')
  assert(/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(exclusions.actionId), 'listed action IDs are opaque tokens')
  assert(guessed.includes('Action is no longer available'), 'a guessed action ID is rejected')
  assertDeepEqual(invoked, { actionId: exclusions.actionId, action: 'Single Player' })
  assert(stale.includes('Action is no longer available'), 'an action ID cannot outlive its visible control')
})

check('loads without browser errors', () => assertDeepEqual(errors, []))
check('does nothing when WebMCP is unavailable', () => assertDeepEqual(fallbackErrors, []))

await browser.close()
await server.close()
report('WebMCP browser')
