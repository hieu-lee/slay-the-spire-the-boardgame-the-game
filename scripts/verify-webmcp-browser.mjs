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
  title: tool.title,
  description: tool.description,
  annotations: tool.annotations,
  inputSchema: tool.inputSchema,
})))
const inspectAll = async () => page.evaluate(async () => {
  const inspect = (await document.modelContext.getTools()).find((tool) => tool.name === 'inspect_game')
  const first = JSON.parse(await document.modelContext.executeTool(inspect, { offset: 0 }))
  const controls = [...first.controls]
  const unavailableControls = [...first.unavailableControls]
  for (let offset = first.nextOffset; offset !== null;) {
    const page = JSON.parse(await document.modelContext.executeTool(inspect, { offset, snapshotId: first.snapshotId }))
    controls.push(...page.controls)
    unavailableControls.push(...page.unavailableControls)
    offset = page.nextOffset
  }
  return { ...first, controls, unavailableControls }
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
    <button aria-label="Delayed advance">Delayed advance</button>
    <button aria-label="Staged advance">Staged advance</button>
    <button class="enemy enemy--targeted" aria-label="Delayed enemy target">Delayed enemy target</button>
    <button aria-label="Presented advance">Presented advance</button>
    <button aria-label="Second morph sequence">Second morph sequence</button>
    <button aria-label="Defeated enemy cleanup">Defeated enemy cleanup</button>
    <button aria-label="Cancelled delayed advance">Cancelled delayed advance</button>
    <span data-vfx-seq="99" aria-hidden="true">Unrelated teammate presentation</span>
    <span id="morph-summary" hidden data-webmcp-transient-status></span>
    <span class="visually-hidden">Draw pile, 7 cards. 3 Energy. 5 Gold.</span>
    <span id="achievement-detail" class="visually-hidden">Unique achievement challenge.</span>
    <article aria-label="Achievement" aria-describedby="achievement-detail"></article>
    <span id="hidden-owner-detail">Visible hidden-owner narrative.</span>
    <button hidden aria-describedby="hidden-owner-detail">Hidden owner</button>
    <span id="passive-owner-detail">Visible passive-owner narrative.</span>
    <span data-webmcp-passive><button aria-describedby="passive-owner-detail">Passive owner</button></span>
    <span id="upload-detail">Visible upload detail.</span>
    <label>Upload<input type="file" aria-describedby="upload-detail"></label>
    <div data-webmcp-passive>Party voice token noise<button aria-label="Join voice">Join voice</button></div>
    <span data-webmcp-passive>Voice unavailable</span>
    <button aria-label="No-op button">No-op button</button>
    <button aria-label="Finish private choice">Finish private choice</button>
    <span role="button" tabindex="0" aria-label="Choose lightning Orb 1">Orb</span>
    <label><input type="checkbox"> Keep Bash</label>
    <select aria-label="Target"><option value="cultist">Cultist</option><option value="jaw-worm">Jaw Worm</option></select>
    <select aria-label="Pass to"><option value="">Keep yours</option><option value="ally">Ally</option></select>
    <label><input type="checkbox" disabled checked> Locked choice</label>
    <label>Locked target<select disabled><option value="cultist">Cultist</option><option value="jaw-worm" selected>Jaw Worm</option></select></label>
    <input type="text" aria-label="Player name" maxlength="12" value="Ironclad">
    <input type="search" aria-label="Search cards">
    <input type="range" aria-label="Volume" min="0" max="100" step="5" value="50">
    <span id="fixture-status"></span>
  `
  document.getElementById('root').append(fixture)
  let buttonClicks = 0
  let orbClicks = 0
  fixture.querySelector('button').addEventListener('click', () => {
    buttonClicks++
    fixture.querySelector('#fixture-status').textContent = `Card actions ${buttonClicks}`
  })
  const delayedButton = fixture.querySelector('[aria-label="Delayed advance"]')
  delayedButton.addEventListener('click', () => {
    document.documentElement.dataset.webmcpPending = 'true'
    delayedButton.textContent = 'Locally pending'
    setTimeout(() => {
      delete document.documentElement.dataset.webmcpPending
      delayedButton.setAttribute('aria-label', 'Delayed next')
      delayedButton.textContent = 'Delayed next'
    }, 250)
  })
  const stagedButton = fixture.querySelector('[aria-label="Staged advance"]')
  stagedButton.addEventListener('click', () => {
    stagedButton.setAttribute('aria-label', 'Stage one')
    stagedButton.textContent = 'Stage one'
    setTimeout(() => {
      stagedButton.setAttribute('aria-label', 'Stage two')
      stagedButton.textContent = 'Stage two'
    }, 650)
  })
  const delayedTarget = fixture.querySelector('[aria-label="Delayed enemy target"]')
  delayedTarget.addEventListener('click', () => {
    delayedTarget.setAttribute('aria-label', 'Enemy target committed')
    delayedTarget.textContent = 'Enemy target committed'
    setTimeout(() => {
      delayedTarget.setAttribute('aria-label', 'Enemy target resolved')
      delayedTarget.textContent = 'Enemy target resolved'
    }, 1050)
  })
  const presentedButton = fixture.querySelector('[aria-label="Presented advance"]')
  presentedButton.addEventListener('click', () => {
    presentedButton.setAttribute('aria-label', 'Presentation started')
    const pending = document.createElement('span')
    pending.dataset.webmcpPending = 'true'
    const announcement = fixture.querySelector('#morph-summary')
    announcement.textContent = 'Strike upgraded to Strike+.'
    fixture.append(pending)
    setTimeout(() => {
      announcement.textContent += ' Defend upgraded to Defend+.'
    }, 900)
    setTimeout(() => {
      presentedButton.setAttribute('aria-label', 'Presentation settled')
      presentedButton.textContent = 'Presentation settled'
      pending.remove()
    }, 1450)
  })
  const secondMorphButton = fixture.querySelector('[aria-label="Second morph sequence"]')
  secondMorphButton.addEventListener('click', () => {
    secondMorphButton.setAttribute('aria-label', 'Second morph pending')
    const prior = fixture.querySelector('#morph-summary')
    const announcement = prior.cloneNode(false)
    delete announcement.dataset.webmcpReported
    announcement.textContent = 'Gained Lesson Learned.'
    prior.replaceWith(announcement)
    const pending = document.createElement('span')
    pending.dataset.webmcpPending = 'true'
    fixture.append(pending)
    setTimeout(() => {
      secondMorphButton.setAttribute('aria-label', 'Second morph settled')
      secondMorphButton.textContent = 'Second morph settled'
      pending.remove()
    }, 250)
  })
  const defeatedButton = fixture.querySelector('[aria-label="Defeated enemy cleanup"]')
  defeatedButton.addEventListener('click', () => {
    defeatedButton.setAttribute('aria-label', 'Defeat started')
    const falling = document.createElement('button')
    falling.className = 'enemy enemy--falling'
    falling.disabled = true
    falling.setAttribute('aria-label', 'Cultist, defeated')
    fixture.append(falling)
    setTimeout(() => {
      falling.remove()
      defeatedButton.setAttribute('aria-label', 'Defeat settled')
      defeatedButton.textContent = 'Defeat settled'
    }, 1800)
  })
  const cancelledButton = fixture.querySelector('[aria-label="Cancelled delayed advance"]')
  cancelledButton.addEventListener('click', () => setTimeout(() => {
    cancelledButton.textContent = 'Cancelled action eventually settled'
  }, 250))
  fixture.querySelector('[role="button"]').addEventListener('click', () => {
    orbClicks++
    fixture.querySelector('#fixture-status').textContent = `Orb actions ${orbClicks}`
  })
  let waiting
  fixture.querySelector('[aria-label="Finish private choice"]').addEventListener('click', () => {
    waiting = document.createElement('section')
    waiting.setAttribute('role', 'dialog')
    waiting.setAttribute('aria-modal', 'true')
    waiting.innerHTML = '<p role="status">Waiting for another player</p><button data-webmcp-passive>Join voice</button>'
    document.body.append(waiting)
  })
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
  const passiveListed = listed.controls.some((control) => control.label === 'Join voice')
  const delayedControl = listed.controls.find((control) => control.label === 'Delayed advance')
  const delayedPending = interact.execute({ controlId: delayedControl.id }, { signal: new AbortController().signal })
  await new Promise((resolve) => setTimeout(resolve, 25))
  const invokedWhilePending = await (async () => {
    try {
      await interact.execute({ controlId: listed.controls.find((control) => control.label.startsWith('Strike,')).id })
      return ''
    } catch (error) {
      return String(error)
    }
  })()
  const inspectedWhilePending = await inspect.execute({})
  const delayed = await delayedPending
  const stagedControl = delayed.controls.find((control) => control.label === 'Staged advance')
  const staged = await interact.execute({ controlId: stagedControl.id })
  const delayedTargetControl = staged.controls.find((control) => control.label === 'Delayed enemy target')
  const resolvedTarget = await interact.execute({ controlId: delayedTargetControl.id })
  const presentedControl = resolvedTarget.controls.find((control) => control.label === 'Presented advance')
  const presented = await interact.execute({ controlId: presentedControl.id })
  const secondMorphControl = presented.controls.find((control) => control.label === 'Second morph sequence')
  const secondMorph = await interact.execute({ controlId: secondMorphControl.id })
  const defeatedControl = secondMorph.controls.find((control) => control.label === 'Defeated enemy cleanup')
  const defeated = await interact.execute({ controlId: defeatedControl.id })
  const cancelledControl = defeated.controls.find((control) => control.label === 'Cancelled delayed advance')
  const cancellation = await (async () => {
    const controller = new AbortController()
    const pending = interact.execute({ controlId: cancelledControl.id }, { signal: controller.signal })
    setTimeout(() => controller.abort(), 50)
    try {
      await pending
      return ''
    } catch (error) {
      return String(error)
    }
  })()
  await new Promise((resolve) => setTimeout(resolve, 300))
  const noOpControl = (await inspect.execute({})).controls.find((control) => control.label === 'No-op button')
  const noOpStarted = performance.now()
  const noOp = await interact.execute({ controlId: noOpControl.id })
  const noOpMs = performance.now() - noOpStarted
  const waitingControl = (await inspect.execute({})).controls.find((control) => control.label === 'Finish private choice')
  const waitingStarted = performance.now()
  const waitingResult = await interact.execute({ controlId: waitingControl.id })
  const waitingMs = performance.now() - waitingStarted
  waiting.remove()
  let strike = listed.controls.find((control) => control.label.startsWith('Strike,'))
  const unavailableBash = listed.unavailableControls.find((control) => control.label.startsWith('Bash,'))
  const unavailableLockedChoice = listed.unavailableControls.find((control) => control.label === 'Locked choice')
  const unavailableLockedTarget = listed.unavailableControls.find((control) => control.label === 'Locked target')
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
  const targetWithoutValue = (await read()).controls.find((control) => control.label === 'Target')
  try {
    await document.modelContext.executeTool(interact, { controlId: targetWithoutValue.id })
    invalid.TargetOmitted = ''
  } catch (error) {
    invalid.TargetOmitted = String(error)
  }
  const optionalSelect = (await read()).controls.find((control) => control.label === 'Pass to')
  try {
    await document.modelContext.executeTool(interact, { controlId: optionalSelect.id })
    invalid.OptionalSelectOmitted = ''
  } catch (error) {
    invalid.OptionalSelectOmitted = String(error)
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
    delayed,
    staged,
    resolvedTarget,
    presented,
    secondMorph,
    defeated,
    inspectedWhilePending,
    invokedWhilePending,
    cancellation,
    noOp,
    noOpMs,
    waitingResult,
    waitingMs,
    passiveListed,
    passiveTextListed: listed.screen.text.includes('Party voice token noise') || listed.screen.text.includes('Voice unavailable'),
    duplicateTextListed: listed.screen.text.includes('Delayed advance') || listed.screen.text.includes('Reliable opening damage.'),
    wrappedLabelDuplicated: listed.screen.text.includes('Keep Bash') || listed.screen.text.includes('Locked target'),
    semanticTextListed: listed.screen.text.includes('Draw pile, 7 cards. 3 Energy. 5 Gold.'),
    nonControlDescriptionListed: listed.screen.text.includes('Unique achievement challenge.'),
    unlistedDescriptionOwnersPreserved: listed.screen.text.includes('Visible hidden-owner narrative.') &&
      listed.screen.text.includes('Visible passive-owner narrative.'),
    unsupportedInputPreserved: listed.screen.text.includes('Upload') && listed.screen.text.includes('Visible upload detail.') &&
      !listed.controls.some((control) => control.label === 'Upload'),
    richLabel: strike.label,
    context: strike.context,
    description: strike.description,
    unavailableBash,
    unavailableLockedChoice,
    unavailableLockedTarget,
    invalid,
    stale,
    checked: find('Keep Bash')?.value,
    target: find('Target')?.value,
    name: find('Player name')?.value,
    textLimits: { name: find('Player name')?.maxLength, search: find('Search cards')?.maxLength },
    volume: find('Volume')?.value,
    range: { min: find('Volume')?.min, max: find('Volume')?.max, step: find('Volume')?.step },
    options: find('Target')?.options,
    payloadChars: JSON.stringify(listed).length,
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
    button.addEventListener('click', () => { clicks++; button.textContent = `Used WebMCP page action ${index}` })
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
  const staleFirstPage = JSON.parse(await document.modelContext.executeTool(inspect, { offset: 0 }))
  const staleAction = staleFirstPage.controls.find((control) => control.label === 'WebMCP page action 1')
  const update = document.createElement('p')
  update.textContent = 'Concurrent room update'
  fixture.append(update)
  const refreshedPage = JSON.parse(await document.modelContext.executeTool(inspect, { offset: 0 }))
  const refreshedAction = refreshedPage.controls.find((control) => control.label === 'WebMCP page action 1')
  const idsRotated = staleAction.id !== refreshedAction.id
  const staleActionResult = await (async () => {
    try {
      await document.modelContext.executeTool(interact, { controlId: staleAction.id })
      return ''
    } catch (error) {
      return String(error)
    }
  })()
  const mixedPage = await (async () => {
    try {
      await document.modelContext.executeTool(inspect,
        { offset: staleFirstPage.nextOffset, snapshotId: staleFirstPage.snapshotId })
      return ''
    } catch (error) {
      return String(error)
    }
  })()
  update.remove()
  const abaFirstPage = JSON.parse(await document.modelContext.executeTool(inspect, { offset: 0 }))
  const replaced = [...fixture.querySelectorAll('button')]
    .find((button) => button.textContent === 'WebMCP page action 35')
  replaced.replaceWith(replaced.cloneNode(true))
  const abaPage = await (async () => {
    try {
      await document.modelContext.executeTool(inspect,
        { offset: abaFirstPage.nextOffset, snapshotId: abaFirstPage.snapshotId })
      return ''
    } catch (error) {
      return String(error)
    }
  })()
  const firstPage = JSON.parse(await document.modelContext.executeTool(inspect, { offset: 0 }))
  const firstAction = firstPage.controls.find((control) => control.label === 'WebMCP page action 1')
  const secondPage = JSON.parse(await document.modelContext.executeTool(inspect,
    { offset: firstPage.nextOffset, snapshotId: firstPage.snapshotId }))
  if (!firstAction || secondPage.nextOffset === undefined) throw new Error('pagination fixture did not span two pages')
  await document.modelContext.executeTool(interact, { controlId: firstAction.id })
  fixture.remove()
  return {
    clicks,
    mixedPage,
    abaPage,
    idsRotated,
    staleActionResult,
    hasNextPage: firstPage.nextOffset !== null,
    secondPageControls: secondPage.controls.length,
    secondPageScreen: secondPage.screen,
    unavailableCount: firstPage.unavailableControls.length,
    totalUnavailable: firstPage.totalUnavailableControls,
    unavailableTruncated: firstPage.unavailableControlsTruncated,
    secondPageUnavailable: secondPage.unavailableControls.length,
  }
})
const portal = await page.evaluate(async () => {
  const backgroundAnnouncement = document.createElement('span')
  backgroundAnnouncement.hidden = true
  backgroundAnnouncement.dataset.webmcpTransientStatus = ''
  backgroundAnnouncement.textContent = 'Gained a background card.'
  document.getElementById('root').append(backgroundAnnouncement)
  const hiddenSurface = document.createElement('section')
  hiddenSurface.style.display = 'none'
  hiddenSurface.innerHTML = '<span data-webmcp-transient-status>Hidden viewer card.</span><span data-webmcp-pending="true"></span>'
  document.getElementById('root').append(hiddenSurface)
  const picker = document.createElement('section')
  picker.className = 'card-picker'
  picker.setAttribute('role', 'dialog')
  picker.setAttribute('aria-modal', 'true')
  picker.setAttribute('aria-label', 'Choose a card to upgrade')
  picker.innerHTML = '<h2>Portal card picker</h2><button aria-label="Bash, 2 Energy, Attack, Deal 8 damage and apply 2 Vulnerable" title="Bash">Bash</button>'
  let clicks = 0
  picker.querySelector('button').addEventListener('click', (event) => {
    clicks++
    event.currentTarget.textContent = 'Picked portal option'
  })
  document.body.append(picker)
  const tools = await document.modelContext.getTools()
  const inspect = tools.find((tool) => tool.name === 'inspect_game')
  const interact = tools.find((tool) => tool.name === 'interact_with_game')
  const listed = JSON.parse(await document.modelContext.executeTool(inspect, { offset: 0 }))
  const action = listed.controls.find((candidate) => candidate.label.startsWith('Bash,'))
  if (!action) throw new Error('portal card picker action was not listed')
  await document.modelContext.executeTool(interact, { controlId: action.id })
  const gameMain = document.querySelector('main')
  gameMain.dataset.webmcpPending = 'true'
  const pendingModal = await inspect.execute({})
  delete gameMain.dataset.webmcpPending
  picker.remove()
  const afterModal = JSON.parse(await document.modelContext.executeTool(inspect, { offset: 0 }))
  backgroundAnnouncement.remove()
  hiddenSurface.remove()
  return {
    clicks,
    heading: listed.screen.headings.includes('Portal card picker'),
    hidesBackground: !listed.controls.some((candidate) => candidate.label === 'Single Player'),
    observation: listed.screen.observations.includes('Choose a card to upgrade'),
    backgroundDeferred: !listed.screen.announcements &&
      afterModal.screen.announcements?.includes('Gained a background card.'),
    hiddenSurfaceExcluded: !afterModal.screen.announcements?.includes('Hidden viewer card.'),
    ancestorPending: pendingModal.pending && pendingModal.controls.length === 0,
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
const guessed = await page.evaluate(async (listedId) => {
  const interact = (await document.modelContext.getTools()).find((tool) => tool.name === 'interact_with_game')
  const last = listedId.at(-1)
  const guessedId = `${listedId.slice(0, -1)}${last === '0' ? '1' : '0'}`
  try {
    await document.modelContext.executeTool(interact, { controlId: guessedId })
    return ''
  } catch (error) {
    return String(error)
  }
}, exclusions.controlId)
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
  await choose('Watcher')
  const character = JSON.parse(await document.modelContext.executeTool(inspect, { offset: 0 }))
  await choose('Embark')
  await choose('Start standard campaign')
  const started = JSON.parse(await document.modelContext.executeTool(inspect, { offset: 0 }))
  return {
    watcherSelected: character.controls.find((control) => control.label === 'Watcher')?.selected,
    describesWatcher: character.screen.text.includes('divine Stances'),
    startedHeading: started.screen.headings[0],
    startedControls: started.controls.length,
  }
})
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const playerId = run.players[0].id
  run.phase = 'room'
  run.roomState = {
    kind: 'event',
    card: {
      id: 'lab', instanceId: 'webmcp-lab-select', act: 1, minAscension: 0,
      requiresColorlessUnlock: false, name: 'Lab', scope: 'automatic', options: [{
        id: 'resolve', label: 'Take Potions',
        description: 'Each player gains a Potion. Roll once for the party; on 4–6 one player gains another Potion.',
        effects: [{ tag: 'gain-potion', target: 'each-player' }, {
          tag: 'roll-d6', results: { 6: [{ tag: 'gain-potion', target: 'one-player' }] },
        }],
      }],
    },
    decisions: {}, dieRolls: {}, pendingRolls: { [playerId]: [6] },
    pendingDecisions: { [playerId]: { optionIds: ['resolve'] } },
  }
  debug.setRun(run)
})
await page.getByLabel('Target player').waitFor()
const labInspection = await inspectAll()
const labTarget = labInspection.controls.find((control) => control.label === 'Target player')
if (!labTarget) throw new Error(`Lab target select is missing from WebMCP: ${JSON.stringify(labInspection.controls)}`)
const labInteraction = await interact(labTarget.id)
const labSelect = {
  required: labTarget.required,
  value: await page.getByLabel('Target player').inputValue(),
  confirmEnabled: await page.getByRole('button', { name: /Confirm choice/ }).isEnabled(),
  returnedConfirm: labInteraction.controls.some((control) => /Confirm choice/.test(control.label)),
  labelDuplicated: labInspection.screen.text.includes('Target player'),
  payloadChars: JSON.stringify(labInspection).length,
}
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  debug.setRun({ ...run, phase: 'map', neow: null })
})
await page.locator('.room--reachable').waitFor()
const roomLabel = await page.locator('.room--reachable').getAttribute('aria-label')
const mapInspection = await inspectAll()
const futureRoomContexts = await page.locator('.room[aria-disabled="true"]').evaluateAll((rooms) =>
  rooms.map((room) => room.getAttribute('data-webmcp-context')).filter(Boolean).sort())
const roomControl = mapInspection.controls.find((control) => control.label === roomLabel)
if (!roomControl) throw new Error(`reachable room is missing from WebMCP: ${roomLabel}`)
const mapInteraction = await interact(roomControl.id)
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'combat')
await page.waitForFunction(() => window.__STS_DEBUG__.getState()?.phase === 'player')
const automaticStartInspection = await inspectAll()
const automaticStartPhase = await page.evaluate(() => window.__STS_DEBUG__.getState()?.phase)
const automaticStartResolveControls = automaticStartInspection.controls.filter((control) =>
  /^Resolve start/.test(control.label))
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
const targetSettlement = target ? await page.evaluate(async (controlId) => {
  const interact = (await document.modelContext.getTools()).find((tool) => tool.name === 'interact_with_game')
  let settled = false
  const pending = interact.execute({ controlId }, { signal: new AbortController().signal })
    .then((result) => { settled = true; return result })
  await new Promise((resolve) => setTimeout(resolve, 800))
  const marked = Boolean(document.querySelector('.enemy[data-webmcp-pending="true"]'))
  const settledBeforeContact = settled
  return { marked, settledBeforeContact, result: await pending }
}, target.id) : null
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
const endTurnResult = await interact(endTurn.id)
const combatFlow = {
  seesTurn: /Turn \d+/.test(combatInspection.screen.text),
  seesEnergy: /\b\d+ Energy\b/.test(combatInspection.screen.text),
  seesDrawPile: /Draw pile, \d+ cards/.test(combatInspection.screen.text),
  richAttack: attack.label,
  targetLabel,
  targetSettlementMarked: targetSettlement?.marked,
  targetSettledBeforeContact: targetSettlement?.settledBeforeContact,
  targetReturnedState: Boolean(targetSettlement?.result.controls),
  changed: afterAttack.energy < beforeAttack.energy || afterAttack.enemyHp < beforeAttack.enemyHp,
  nextTurnReturned: /Turn 2/.test(endTurnResult.screen?.text ?? ''),
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
  const result = await interact.execute({ controlId: singlePlayer.id })
  return {
    tools: navigator.modelContext.listTools().map((tool) => tool.name),
    reachedModeSelect: result.controls.some((control) => control.label === 'Standard'),
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

const payloadChars = {
  metadata: JSON.stringify(tools).length,
  start: JSON.stringify(initial).length,
  fixture: controls.payloadChars,
  lab: labSelect.payloadChars,
  map: JSON.stringify(mapInspection).length,
  combat: JSON.stringify(combatInspection).length,
}

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
  assert(initial.screen.headings.length > 0, 'inspection reads the visible start screen')
  assert(initial.controls.some((control) => control.label === 'Single Player'), 'inspection lists the visible menu')
  assert(malformed.inspectNull.includes('Expected an object input') && malformed.inspectOffset.includes('offset must be') &&
    malformed.inspectExtra.includes('Unexpected input property') && malformed.interactNull.includes('Expected an object input') &&
    malformed.controlId.includes('controlId must be') && malformed.interactExtra.includes('Unexpected input property'),
  'malformed tool inputs return clear retryable errors')
  assert(controls.richLabel.includes('Deal 6 damage') && controls.context === 'Ironclad training hand' &&
    controls.description === 'Reliable opening damage.', 'card actions preserve rich accessible context')
  assert(controls.buttonClicks === 1 && controls.orbClicks === 1, 'button and role-button controls use their visible click paths')
  assert(controls.delayed.controls.some((control) => control.label === 'Delayed next'),
    'interaction waits for a delayed authoritative update before returning reusable controls')
  assert(controls.staged.controls.some((control) => control.label === 'Stage two'),
    'interaction waits for a stable final state after an immediate intermediate update')
  assert(controls.resolvedTarget.controls.some((control) => control.label === 'Enemy target resolved'),
    'target interaction waits for delayed semantic damage even before a pending marker appears')
  assert(controls.presented.controls.some((control) => control.label === 'Presentation settled'),
    'interaction waits through the longest production combat presentation delay')
  assert(controls.presented.screen.announcements?.includes('Strike upgraded to Strike+. Defend upgraded to Defend+.'),
    'interaction returns every result from a queued multi-card change')
  assert(controls.secondMorph.screen.announcements?.includes('Gained Lesson Learned.'),
    'a later morph sequence on the same persistent host returns its new result')
  assert(!controls.defeated.screen.announcements,
    'a reported multi-card result is omitted from the next unrelated interaction')
  assert(controls.defeated.controls.some((control) => control.label === 'Defeat settled'),
    'interaction waits until a defeated enemy is removed after presentation ends')
  assert(controls.inspectedWhilePending.pending && controls.inspectedWhilePending.controls.length === 0 &&
    controls.invokedWhilePending.includes('Game interaction is pending'),
  'inspection reports pending authority without minting invokable control IDs')
  assert(controls.cancellation.includes('AbortError'), 'a cancelled delayed interaction stops settling promptly')
  assert(controls.noOp.controls && controls.noOpMs < 2_000,
    'a completed no-op returns current state without waiting for the long timeout')
  assert(controls.waitingResult.screen.status.includes('Waiting for another player') && controls.waitingMs < 3_000,
    'a changed stable waiting screen settles without being misreported as pending')
  assert(!controls.passiveListed && !controls.passiveTextListed,
    'non-game utility controls and text stay out of gameplay state and settlement')
  assert(!controls.duplicateTextListed && !controls.wrappedLabelDuplicated,
    'structured control, wrapped-label, and description text is not repeated in screen text')
  assert(controls.semanticTextListed && controls.nonControlDescriptionListed && controls.unlistedDescriptionOwnersPreserved &&
    controls.unsupportedInputPreserved,
  'unique hidden and non-control described state survives unlisted description owners')
  assert(controls.unavailableBash && controls.unavailableBash.id === undefined,
    'unplayable cards remain visible for planning without becoming invokable')
  assert(controls.unavailableLockedChoice?.kind === 'checkbox' && controls.unavailableLockedChoice.value === true &&
    controls.unavailableLockedTarget?.kind === 'select' && controls.unavailableLockedTarget.value === 'jaw-worm' &&
    controls.unavailableLockedTarget.options?.some((option) => option.value === 'jaw-worm' && option.label === 'Jaw Worm'),
  `disabled form controls preserve their visible state: ${JSON.stringify({
    choice: controls.unavailableLockedChoice, target: controls.unavailableLockedTarget,
  })}`)
  assert(controls.invalid['Strike,'].includes('value must be omitted') && controls.invalid.Target.includes('enabled listed option') &&
    controls.invalid.TargetOmitted.includes('value must be a string') &&
    controls.invalid.OptionalSelectOmitted.includes('value must be a string') &&
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
  assert(pagination.idsRotated && pagination.mixedPage.includes('Game state changed during pagination') &&
    pagination.abaPage.includes('Game state changed during pagination') &&
    pagination.staleActionResult.includes('Control is no longer available'),
  'concurrent and identical-tree replacements reject mixed pages and stale page-one actions')
  assert(pagination.secondPageScreen === undefined, 'continuation pages do not repeat unchanged screen text')
  assert(pagination.unavailableCount === 30 && pagination.totalUnavailable >= 35 && pagination.unavailableTruncated &&
    pagination.unavailableCount + pagination.secondPageUnavailable === pagination.totalUnavailable,
  `unavailable controls paginate without losing planning choices: ${JSON.stringify(pagination)}`)
  assert(portal.heading && portal.hidesBackground && portal.observation && portal.clicks === 1 &&
    portal.backgroundDeferred && portal.hiddenSurfaceExcluded && portal.ancestorPending,
    `a portal card picker exposes its complete modal context without background controls: ${JSON.stringify(portal)}`)
  assert(exclusions.ariaDisabled && exclusions.inert && exclusions.hidesObservation && exclusions.hidesText,
    'aria-disabled and inert controls are not listed, and hidden content is not disclosed')
  assert(exclusions.guarded.includes('Control is no longer available'), 'an interaction lock prevents a listed token from executing')
  assert(/^[\da-f]{8}-[\da-f]{3}$/i.test(exclusions.controlId),
    'listed control IDs are short opaque snapshot tokens')
  assert(guessed.includes('Control is no longer available'), 'a guessed control ID is rejected')
  assert(invoked.controls.some((control) => control.label === 'Standard') &&
    invoked.screen.text.includes('Embark on a quest to Slay the Spire!'),
  'an interaction returns refreshed controls and visible copy not repeated by their accessible labels')
  assert(stale.includes('Control is no longer available'), 'a control ID cannot outlive its visible screen')
})

check('keeps representative WebMCP payloads compact', () => {
  assert(payloadChars.metadata < 1_200 && payloadChars.start < 900 && payloadChars.fixture < 3_700 && payloadChars.lab < 950,
    `payload budget exceeded: ${JSON.stringify(payloadChars)}`)
})

check('starts a real Watcher run through WebMCP and loads cleanly', () => {
  assert(realFlow.watcherSelected && realFlow.describesWatcher, 'inspection exposes the selected hero and its gameplay identity')
  assert(realFlow.startedHeading && realFlow.startedControls > 0, 'WebMCP reaches the first playable run screen')
  assert(labSelect.required && labSelect.value && labSelect.confirmEnabled && labSelect.returnedConfirm && !labSelect.labelDuplicated,
    `a controlId-only Lab interaction selects its sole recipient and returns the enabled action: ${JSON.stringify(labSelect)}`)
  assert(mapInspection.totalUnavailableControls > 0 &&
    JSON.stringify(mapInspection.unavailableControls.filter((control) => control.context?.startsWith('Floor '))
      .map((control) => control.context).sort()) === JSON.stringify(futureRoomContexts) &&
    futureRoomContexts.some((context) => context.includes('; exits to floor ')) &&
    mapInteraction.controls.some((control) => control.label === 'End turn'),
  'map inspection preserves every future route-planning room and map entry returns the settled combat screen')
  assertDeepEqual({ phase: automaticStartPhase, resolveControls: automaticStartResolveControls.length }, {
    phase: 'player', resolveControls: 0,
  }, 'WebMCP exposed a redundant action for deterministic start-of-combat effects')
  assert(combatFlow.seesTurn && combatFlow.seesEnergy && combatFlow.seesDrawPile,
    'combat inspection exposes turn, current Energy, and draw-pile count')
  assert(/, attack,/i.test(combatFlow.richAttack) && combatFlow.targetLabel && combatFlow.targetSettlementMarked &&
    !combatFlow.targetSettledBeforeContact && combatFlow.targetReturnedState && combatFlow.changed && combatFlow.nextTurnReturned,
  `a real Watcher Attack remains pending through contact, then returns settled controls: ${JSON.stringify(combatFlow)}`)
  assertDeepEqual(errors, [])
  assertDeepEqual(fallbackErrors, [])
})

await browser.close()
await server.close()
report(`WebMCP browser; payload chars ${Object.entries(payloadChars).map(([name, size]) => `${name}=${size}`).join(', ')}`)
