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
await page.waitForFunction(async () => (await document.modelContext.getTools()).length === 2)
const tools = await page.evaluate(async () => (await document.modelContext.getTools()).map((tool) => ({
  name: tool.name,
  annotations: tool.annotations,
  inputSchema: tool.inputSchema,
})))
const inspectAll = async () => page.evaluate(async () => {
  const inspect = (await document.modelContext.getTools()).find((tool) => tool.name === 'inspect_game')
  const first = JSON.parse(await document.modelContext.executeTool(inspect, { offset: 0 }))
  const controls = [...first.controls]
  for (let offset = first.nextOffset; offset !== null;) {
    const page = JSON.parse(await document.modelContext.executeTool(inspect, { offset }))
    controls.push(...page.controls)
    offset = page.nextOffset
  }
  return { ...first, controls }
})
const interact = async (controlId, value) => page.evaluate(async ({ controlId, value }) => {
  const tool = (await document.modelContext.getTools()).find((candidate) => candidate.name === 'interact_with_game')
  return JSON.parse(await document.modelContext.executeTool(tool,
    value === undefined ? { controlId } : { controlId, value }))
}, { controlId, value })
const initial = await page.evaluate(async () => {
  const inspect = (await document.modelContext.getTools()).find((tool) => tool.name === 'inspect_game')
  return JSON.parse(await document.modelContext.executeTool(inspect, { offset: 0 }))
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
    inspectNull: await run('inspect_game', null),
    inspectOffset: await run('inspect_game', { offset: -1 }),
    inspectExtra: await run('inspect_game', { surprise: true }),
    interactNull: await run('interact_with_game', null),
    controlId: await run('interact_with_game', { controlId: '' }),
    interactExtra: await run('interact_with_game', { controlId: 'nope', surprise: true }),
  }
})
const controls = await page.evaluate(async () => {
  const fixture = document.createElement('section')
  fixture.setAttribute('aria-label', 'Ironclad training hand')
  fixture.innerHTML = `
    <span id="strike-description">Reliable opening damage.</span>
    <button title="Strike" aria-label="Strike, 1 Energy, Attack, Deal 6 damage" aria-describedby="strike-description">Strike</button>
    <button aria-disabled="true" aria-label="Bash, 2 Energy, Attack, Deal 8 damage and apply 2 Vulnerable">Bash</button>
    <span role="button" tabindex="0" aria-label="Choose lightning Orb 1">Orb</span>
    <label><input type="checkbox"> Keep Bash</label>
    <select aria-label="Target"><option value="cultist">Cultist</option><option value="jaw-worm">Jaw Worm</option></select>
    <input type="text" aria-label="Player name" maxlength="12" value="Ironclad">
    <input type="search" aria-label="Search cards">
    <input type="range" aria-label="Volume" min="0" max="100" step="5" value="50">
  `
  document.getElementById('root').append(fixture)
  let buttonClicks = 0
  let orbClicks = 0
  fixture.querySelector('button').addEventListener('click', () => { buttonClicks++ })
  fixture.querySelector('[role="button"]').addEventListener('click', () => { orbClicks++ })
  const tools = await document.modelContext.getTools()
  const inspect = tools.find((tool) => tool.name === 'inspect_game')
  const interact = tools.find((tool) => tool.name === 'interact_with_game')
  const read = async () => JSON.parse(await document.modelContext.executeTool(inspect, { offset: 0 }))
  const use = async (label, value) => {
    const listed = await read()
    const control = listed.controls.find((candidate) => candidate.label === label)
    if (!control) throw new Error(`missing fixture control: ${label}`)
    const input = value === undefined ? { controlId: control.id } : { controlId: control.id, value }
    await document.modelContext.executeTool(interact, input)
    return control
  }
  const listed = await read()
  let strike = listed.controls.find((control) => control.label.startsWith('Strike,'))
  const unavailableBash = listed.unavailableControls.find((control) => control.label.startsWith('Bash,'))
  if (!strike) throw new Error('rich card action was not listed')
  const invalid = {}
  for (const [name, value] of [['Strike,', true], ['Target', 'missing'], ['Player name', 'name-that-is-too-long'],
    ['Search cards', 'x'.repeat(1001)], ['Volume', 73]]) {
    const control = (await read()).controls.find((candidate) => candidate.label.startsWith(name))
    try {
      await document.modelContext.executeTool(interact, { controlId: control.id, value })
      invalid[name] = ''
    } catch (error) {
      invalid[name] = String(error)
    }
  }
  strike = (await read()).controls.find((control) => control.label.startsWith('Strike,'))
  await document.modelContext.executeTool(interact, { controlId: strike.id })
  await use('Choose lightning Orb 1')
  const checkbox = await use('Keep Bash', true)
  const stale = await (async () => {
    try {
      await document.modelContext.executeTool(interact, { controlId: checkbox.id, value: false })
      return ''
    } catch (error) {
      return String(error)
    }
  })()
  await use('Target', 'jaw-worm')
  await use('Player name', 'Agentclad')
  await use('Volume', 75)
  const final = await read()
  const find = (name) => final.controls.find((control) => control.label === name)
  fixture.remove()
  return {
    buttonClicks,
    orbClicks,
    richLabel: strike.label,
    context: strike.context,
    description: strike.description,
    unavailableBash,
    invalid,
    stale,
    checked: find('Keep Bash')?.value,
    target: find('Target')?.value,
    name: find('Player name')?.value,
    textLimits: { name: find('Player name')?.maxLength, search: find('Search cards')?.maxLength },
    volume: find('Volume')?.value,
    range: { min: find('Volume')?.min, max: find('Volume')?.max, step: find('Volume')?.step },
    options: find('Target')?.options,
  }
})
const disclosure = await page.evaluate(async () => {
  const fixture = document.createElement('details')
  fixture.innerHTML = '<summary>Run settings</summary><select aria-label="Ascension"><option value="0">0</option><option value="1">1</option></select>'
  document.getElementById('root').append(fixture)
  const tools = await document.modelContext.getTools()
  const inspect = tools.find((tool) => tool.name === 'inspect_game')
  const interact = tools.find((tool) => tool.name === 'interact_with_game')
  const closed = JSON.parse(await document.modelContext.executeTool(inspect, { offset: 0 }))
  const summary = closed.controls.find((control) => control.label === 'Run settings')
  if (!summary) throw new Error('closed disclosure summary was not listed')
  await document.modelContext.executeTool(interact, { controlId: summary.id })
  const open = JSON.parse(await document.modelContext.executeTool(inspect, { offset: 0 }))
  fixture.remove()
  return {
    opened: fixture.open,
    hiddenWhenClosed: !closed.controls.some((control) => control.label === 'Ascension'),
    revealedWhenOpen: open.controls.some((control) => control.label === 'Ascension'),
  }
})
const pagination = await page.evaluate(async () => {
  const fixture = document.createElement('div')
  fixture.setAttribute('aria-label', 'WebMCP pagination fixture')
  let clicks = 0
  for (let index = 1; index <= 35; index++) {
    const button = document.createElement('button')
    button.textContent = `WebMCP page action ${index}`
    button.addEventListener('click', () => { clicks++ })
    fixture.append(button)
  }
  for (let index = 1; index <= 35; index++) {
    const button = document.createElement('button')
    button.textContent = `Unavailable action ${index}`
    button.disabled = true
    fixture.append(button)
  }
  document.getElementById('root').append(fixture)
  const tools = await document.modelContext.getTools()
  const inspect = tools.find((tool) => tool.name === 'inspect_game')
  const interact = tools.find((tool) => tool.name === 'interact_with_game')
  const firstPage = JSON.parse(await document.modelContext.executeTool(inspect, { offset: 0 }))
  const firstAction = firstPage.controls.find((control) => control.label === 'WebMCP page action 1')
  const secondPage = JSON.parse(await document.modelContext.executeTool(inspect, { offset: firstPage.nextOffset }))
  if (!firstAction || secondPage.nextOffset === undefined) throw new Error('pagination fixture did not span two pages')
  await document.modelContext.executeTool(interact, { controlId: firstAction.id })
  fixture.remove()
  return {
    clicks,
    hasNextPage: firstPage.nextOffset !== null,
    secondPageControls: secondPage.controls.length,
    unavailableCount: firstPage.unavailableControls.length,
    totalUnavailable: firstPage.totalUnavailableControls,
    unavailableTruncated: firstPage.unavailableControlsTruncated,
    secondPageUnavailable: secondPage.unavailableControls.length,
  }
})
const portal = await page.evaluate(async () => {
  const picker = document.createElement('section')
  picker.className = 'card-picker'
  picker.setAttribute('role', 'dialog')
  picker.setAttribute('aria-modal', 'true')
  picker.setAttribute('aria-label', 'Choose a card to upgrade')
  picker.innerHTML = '<h2>Portal card picker</h2><button aria-label="Bash, 2 Energy, Attack, Deal 8 damage and apply 2 Vulnerable" title="Bash">Bash</button>'
  let clicks = 0
  picker.querySelector('button').addEventListener('click', () => { clicks++ })
  document.body.append(picker)
  const tools = await document.modelContext.getTools()
  const inspect = tools.find((tool) => tool.name === 'inspect_game')
  const interact = tools.find((tool) => tool.name === 'interact_with_game')
  const listed = JSON.parse(await document.modelContext.executeTool(inspect, { offset: 0 }))
  const action = listed.controls.find((candidate) => candidate.label.startsWith('Bash,'))
  if (!action) throw new Error('portal card picker action was not listed')
  await document.modelContext.executeTool(interact, { controlId: action.id })
  picker.remove()
  return {
    clicks,
    heading: listed.screen.headings.includes('Portal card picker'),
    hidesBackground: !listed.controls.some((candidate) => candidate.label === 'Single Player'),
    observation: listed.screen.observations.includes('Choose a card to upgrade'),
  }
})
const exclusions = await page.evaluate(async () => {
  const tools = await document.modelContext.getTools()
  const inspect = tools.find((tool) => tool.name === 'inspect_game')
  const interact = tools.find((tool) => tool.name === 'interact_with_game')
  const labels = async () => JSON.parse(await document.modelContext.executeTool(inspect, { offset: 0 }))
    .controls.map((control) => control.label)
  const single = document.querySelector('button[aria-label="Single Player"]')
  const menu = single.parentElement
  single.setAttribute('aria-disabled', 'true')
  const ariaDisabled = !(await labels()).includes('Single Player')
  single.removeAttribute('aria-disabled')
  menu.setAttribute('inert', '')
  const inert = !(await labels()).includes('Single Player')
  menu.removeAttribute('inert')
  const fresh = JSON.parse(await document.modelContext.executeTool(inspect, { offset: 0 }))
  const control = fresh.controls.find((candidate) => candidate.label === 'Single Player')
  menu.setAttribute('inert', '')
  let guarded = ''
  try {
    await document.modelContext.executeTool(interact, { controlId: control.id })
  } catch (error) {
    guarded = String(error)
  }
  menu.removeAttribute('inert')
  const relisted = JSON.parse(await document.modelContext.executeTool(inspect, { offset: 0 }))
  const current = relisted.controls.find((candidate) => candidate.label === 'Single Player')
  const hidden = document.createElement('div')
  hidden.setAttribute('aria-hidden', 'true')
  hidden.setAttribute('aria-label', 'Secret hidden observation')
  hidden.textContent = 'Secret hidden dialog text'
  menu.append(hidden)
  const inspected = JSON.parse(await document.modelContext.executeTool(inspect, { offset: 0 }))
  hidden.remove()
  return {
    ariaDisabled,
    inert,
    guarded,
    controlId: current.id,
    hidesObservation: !inspected.screen.observations.includes('Secret hidden observation'),
    hidesText: !inspected.screen.text.includes('Secret hidden dialog text'),
  }
})
const guessed = await page.evaluate(async () => {
  const interact = (await document.modelContext.getTools()).find((tool) => tool.name === 'interact_with_game')
  try {
    await document.modelContext.executeTool(interact, { controlId: 'control-1-1' })
    return ''
  } catch (error) {
    return String(error)
  }
})
const invoked = await page.evaluate(async (controlId) => {
  const interact = (await document.modelContext.getTools()).find((tool) => tool.name === 'interact_with_game')
  return JSON.parse(await document.modelContext.executeTool(interact, { controlId }))
}, exclusions.controlId)
await page.getByRole('heading', { name: 'Choose your run' }).waitFor()
const realFlow = await page.evaluate(async () => {
  const tools = await document.modelContext.getTools()
  const inspect = tools.find((tool) => tool.name === 'inspect_game')
  const interact = tools.find((tool) => tool.name === 'interact_with_game')
  const choose = async (label) => {
    const listed = JSON.parse(await document.modelContext.executeTool(inspect, { offset: 0 }))
    const control = listed.controls.find((candidate) => candidate.label === label)
    if (!control) throw new Error(`missing game control: ${label}`)
    await document.modelContext.executeTool(interact, { controlId: control.id })
  }
  await choose('Standard')
  const character = JSON.parse(await document.modelContext.executeTool(inspect, { offset: 0 }))
  await choose('Embark')
  const started = JSON.parse(await document.modelContext.executeTool(inspect, { offset: 0 }))
  return {
    ironcladSelected: character.controls.find((control) => control.label === 'Ironclad')?.selected,
    describesIronclad: character.screen.text.includes('builds Strength'),
    startedHeading: started.screen.headings[0],
    startedControls: started.controls.length,
  }
})
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  debug.setRun({ ...run, phase: 'map', neow: null })
})
await page.locator('.room--reachable').waitFor()
const roomLabel = await page.locator('.room--reachable').getAttribute('aria-label')
const mapInspection = await inspectAll()
const roomControl = mapInspection.controls.find((control) => control.label === roomLabel)
if (!roomControl) throw new Error(`reachable room is missing from WebMCP: ${roomLabel}`)
await interact(roomControl.id)
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'combat')
if (await page.evaluate(() => window.__STS_DEBUG__.getState()?.phase === 'start')) {
  const startInspection = await inspectAll()
  const start = startInspection.controls.find((control) => control.label === 'Resolve start of turn')
  if (start) {
    await interact(start.id)
    await page.waitForFunction(() => window.__STS_DEBUG__.getState()?.phase === 'player')
  }
}
const beforeAttack = await page.evaluate(() => {
  const state = window.__STS_DEBUG__.getState()
  return { energy: state.players[0].energy, enemyHp: state.enemies.reduce((total, enemy) => total + enemy.hp, 0) }
})
const combatInspection = await inspectAll()
const attack = combatInspection.controls.find((control) => /, attack,/i.test(control.label))
if (!attack) throw new Error(`WebMCP did not expose a playable real Ironclad Attack: ${JSON.stringify({
  phase: await page.evaluate(() => window.__STS_DEBUG__.getState()?.phase),
  controls: combatInspection.controls.map((control) => control.label),
  unavailable: combatInspection.unavailableControls.map((control) => control.label),
})}`)
await interact(attack.id)
await page.waitForFunction(() => document.querySelector('.enemy--targeted') || (() => {
  const state = window.__STS_DEBUG__.getState()
  return state.players[0].energy < 3
})())
const targetInspection = await inspectAll()
const targetLabel = await page.locator('.enemy--targeted').first().getAttribute('aria-label').catch(() => null)
const target = targetInspection.controls.find((control) => control.label === targetLabel)
if (target) await interact(target.id)
await page.waitForFunction(({ energy, enemyHp }) => {
  const state = window.__STS_DEBUG__.getState()
  return state.players[0].energy < energy || state.enemies.reduce((total, enemy) => total + enemy.hp, 0) < enemyHp
}, beforeAttack)
const afterAttack = await page.evaluate(() => {
  const state = window.__STS_DEBUG__.getState()
  return { energy: state.players[0].energy, enemyHp: state.enemies.reduce((total, enemy) => total + enemy.hp, 0) }
})
const afterAttackInspection = await inspectAll()
const endTurn = afterAttackInspection.controls.find((control) => control.label.startsWith('End turn'))
if (!endTurn) throw new Error('WebMCP did not expose End turn after a real attack')
await interact(endTurn.id)
const combatFlow = {
  seesTurn: /Turn \d+/.test(combatInspection.screen.text),
  seesEnergy: /Energy/.test(JSON.stringify(combatInspection)),
  richAttack: attack.label,
  targetLabel,
  changed: afterAttack.energy < beforeAttack.energy || afterAttack.enemyHp < beforeAttack.enemyHp,
}
const stale = await page.evaluate(async (controlId) => {
  const interact = (await document.modelContext.getTools()).find((tool) => tool.name === 'interact_with_game')
  try {
    await document.modelContext.executeTool(interact, { controlId })
    return ''
  } catch (error) {
    return String(error)
  }
}, exclusions.controlId)
const bridge = await browser.newPage({ viewport: { width: 844, height: 390 } })
await bridge.addInitScript(() => {
  const tools = new Map()
  Object.defineProperty(navigator, 'modelContext', {
    configurable: true,
    value: {
      registerTool(tool) { tools.set(tool.name, tool); return Promise.resolve() },
      listTools() { return [...tools.values()] },
      callTool(name, input) { return tools.get(name)?.execute(input) },
    },
  })
})
await bridge.goto(`http://localhost:${address.port}`)
await bridge.waitForFunction(() => navigator.modelContext?.listTools().length === 2)
const bridgeCompatibility = await bridge.evaluate(async () => {
  const inspect = navigator.modelContext.listTools().find((tool) => tool.name === 'inspect_game')
  const interact = navigator.modelContext.listTools().find((tool) => tool.name === 'interact_with_game')
  const before = await inspect.execute({})
  const singlePlayer = before.controls.find((control) => control.label === 'Single Player')
  if (!singlePlayer) throw new Error('navigator-only WebMCP bridge did not expose Single Player')
  await interact.execute({ controlId: singlePlayer.id })
  return {
    tools: navigator.modelContext.listTools().map((tool) => tool.name),
    reachedModeSelect: (await inspect.execute({})).controls.some((control) => control.label === 'Standard'),
  }
})
await bridge.close()
const fallback = await browser.newPage({ viewport: { width: 844, height: 390 } })
const fallbackErrors = []
fallback.on('console', (message) => { if (message.type() === 'error') fallbackErrors.push(message.text()) })
fallback.on('pageerror', (error) => fallbackErrors.push(String(error)))
await fallback.goto(`http://localhost:${address.port}`)
await fallback.getByRole('button', { name: 'Single Player' }).waitFor()
await fallback.close()

suite('WebMCP browser contract')

check('registers two low-friction, safely annotated game tools', () => {
  assertDeepEqual(tools.map((tool) => tool.name), ['inspect_game', 'interact_with_game'])
  assert(tools[0].annotations.readOnlyHint && tools[0].annotations.untrustedContentHint,
    'screen inspection is read-only and marked untrusted')
  assert(tools[1].annotations.untrustedContentHint && !tools[1].annotations.consequentialHint,
    'in-game interactions are marked untrusted but not as real-world consequential actions')
  assert(tools[1].inputSchema.properties.value.oneOf[0].maxLength === 1000, 'free-form tool strings are schema-bounded')
  assertDeepEqual(bridgeCompatibility, {
    tools: ['inspect_game', 'interact_with_game'],
    reachedModeSelect: true,
  })
})

check('returns visible gameplay context and drives every gameplay control kind', () => {
  assert(initial.screen.headings.length > 0 && initial.screen.text.includes('THE BOARD GAME'), 'inspection reads the visible start screen')
  assert(initial.controls.some((control) => control.label === 'Single Player'), 'inspection lists the visible menu')
  assert(malformed.inspectNull.includes('Expected an object input') && malformed.inspectOffset.includes('offset must be') &&
    malformed.inspectExtra.includes('Unexpected input property') && malformed.interactNull.includes('Expected an object input') &&
    malformed.controlId.includes('controlId must be') && malformed.interactExtra.includes('Unexpected input property'),
  'malformed tool inputs return clear retryable errors')
  assert(controls.richLabel.includes('Deal 6 damage') && controls.context === 'Ironclad training hand' &&
    controls.description === 'Reliable opening damage.', 'card actions preserve rich accessible context')
  assert(controls.buttonClicks === 1 && controls.orbClicks === 1, 'button and role-button controls use their visible click paths')
  assert(controls.unavailableBash && controls.unavailableBash.id === undefined,
    'unplayable cards remain visible for planning without becoming invokable')
  assert(controls.invalid['Strike,'].includes('value must be omitted') && controls.invalid.Target.includes('enabled listed option') &&
    controls.invalid['Player name'].includes('at most 12') && controls.invalid['Search cards'].includes('at most 1000') &&
    controls.invalid.Volume.includes('control step'),
  `control-specific runtime validation rejects unsafe or impossible values: ${JSON.stringify(controls.invalid)}`)
  assert(controls.checked === true && controls.target === 'jaw-worm' && controls.name === 'Agentclad' && controls.volume === 75,
    `checkbox, select, text, and number controls update through their visible event paths: ${JSON.stringify(controls)}`)
  assertDeepEqual(controls.range, { min: 0, max: 100, step: 5 })
  assertDeepEqual(controls.textLimits, { name: 12, search: 1000 })
  assertDeepEqual(controls.options, [{ value: 'cultist', label: 'Cultist' }, { value: 'jaw-worm', label: 'Jaw Worm' }])
  assert(controls.stale.includes('Control is no longer available'), 'changed form state invalidates its old control snapshot')
  assert(disclosure.opened && disclosure.hiddenWhenClosed && disclosure.revealedWhenOpen,
    `native details disclosures are inspectable and operable: ${JSON.stringify(disclosure)}`)
})

check('keeps snapshots scoped, stable, opaque, and current', () => {
  assert(pagination.hasNextPage && pagination.secondPageControls > 0 && pagination.clicks === 1,
    'a page-one control remains valid after fetching the next page')
  assert(pagination.unavailableCount === 30 && pagination.totalUnavailable >= 35 && pagination.unavailableTruncated &&
    pagination.secondPageUnavailable === 0, `unavailable controls are explicitly capped and not repeated: ${JSON.stringify(pagination)}`)
  assert(portal.heading && portal.hidesBackground && portal.observation && portal.clicks === 1,
    `a portal card picker exposes its complete modal context without background controls: ${JSON.stringify(portal)}`)
  assert(exclusions.ariaDisabled && exclusions.inert && exclusions.hidesObservation && exclusions.hidesText,
    'aria-disabled and inert controls are not listed, and hidden content is not disclosed')
  assert(exclusions.guarded.includes('Control is no longer available'), 'an interaction lock prevents a listed token from executing')
  assert(/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(exclusions.controlId), 'listed control IDs are opaque tokens')
  assert(guessed.includes('Control is no longer available'), 'a guessed control ID is rejected')
  assertDeepEqual(invoked, { controlId: exclusions.controlId, control: 'Single Player', next: 'Call inspect_game again.' })
  assert(stale.includes('Control is no longer available'), 'a control ID cannot outlive its visible screen')
})

check('starts a real Ironclad run through WebMCP and loads cleanly', () => {
  assert(realFlow.ironcladSelected && realFlow.describesIronclad, 'inspection exposes the selected hero and its gameplay identity')
  assert(realFlow.startedHeading && realFlow.startedControls > 0, 'WebMCP reaches the first playable run screen')
  assert(combatFlow.seesTurn && combatFlow.seesEnergy, 'combat inspection exposes turn and Energy')
  assert(/, attack,/i.test(combatFlow.richAttack) && combatFlow.targetLabel && combatFlow.changed,
    `a real Ironclad Attack is described, targeted, and resolved: ${JSON.stringify(combatFlow)}`)
  assertDeepEqual(errors, [])
  assertDeepEqual(fallbackErrors, [])
})

await browser.close()
await server.close()
report('WebMCP browser')
