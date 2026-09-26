import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium } from './lib/profile-browser.mjs'
import { suite, check, assert, assertDeepEqual, report } from './lib/harness.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
process.env.VITE_LEADERBOARD = 'true'
const server = await createServer({ root: repoRoot, logLevel: 'silent', server: { port: 0 } })
await server.listen()
const address = server.httpServer?.address()
if (!address || typeof address === 'string') throw new Error('vite did not report a port')
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const leaderboardSubmissions = []
let leaderboardUnavailable = false
let transientLeaderboardFailures = 1
await page.route('**/api/leaderboard', async (route) => {
  if (route.request().method() !== 'POST') return route.continue()
  const submission = route.request().postDataJSON()
  leaderboardSubmissions.push(submission)
  if (leaderboardUnavailable || transientLeaderboardFailures-- > 0) {
    return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Unavailable"}' })
  }
  return route.fulfill({
    status: submission.profileToken ? 409 : 201,
    contentType: 'application/json',
    body: submission.profileToken ? '{"error":"Profile unavailable"}' :
      '{"ok":true,"added":true,"floorsClearedAccepted":true,"finalDeckAccepted":true,"profileAccepted":true}',
  })
})
const statsRequests = []
await page.route('**/api/stats?*', async (route) => {
  statsRequests.push(new URL(route.request().url()).searchParams)
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    runs: 15, averageFloors: 18, averageDamage: 3, averageBlock: 0.7, pending: 2,
    rows: Array.from({ length: 7 }, (_, index) => ({ deckType: `Hermit ${index}`, character: 'hermit', runs: 2,
      averageFloors: 18, averageDamage: 3, averageBlock: 0.7 })),
    nextCards: [{ defId: 'hermit_brawl', runs: 5, averageFloors: 19, averageDamage: 3, averageBlock: 0.7,
      deltaFloors: 1, deltaDamage: 0, deltaBlock: 0 }],
  }) })
})
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
await page.waitForFunction(async () => (await document.modelContext.getTools()).length === 3, null, { timeout: 20_000 })
  .catch((error) => { throw new Error(`${error}; console: ${errors.join('; ')}`) })
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
  const maxOffset = Math.max(first.totalControls ?? 0, first.totalUnavailableControls ?? 0)
  let previousOffset = 0
  for (let offset = first.nextOffset; offset !== null;) {
    if (!Number.isSafeInteger(maxOffset) || !Number.isSafeInteger(offset) || offset <= previousOffset || offset >= maxOffset) {
      throw new Error(`inspect_game pagination has invalid or non-advancing nextOffset ${offset} (max ${maxOffset})`)
    }
    previousOffset = offset
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
const statsLookup = await page.evaluate(async () => {
  const tools = await document.modelContext.getTools()
  const stats = tools.find((tool) => tool.name === 'get_stats')
  const inspect = tools.find((tool) => tool.name === 'inspect_game')
  const before = await inspect.execute({})
  const summary = await stats.execute({ character: 'hermit', ascension: 1, query: '@hermit_snapshot',
    candidates: ['hermit_brawl', 'hermit_take_cover'] })
  const full = await stats.execute({ character: 'hermit', full: true })
  const after = await inspect.execute({})
  let unknownCard = ''
  try { await stats.execute({ query: '@does_not_exist' }) } catch (error) { unknownCard = String(error) }
  return { summary, full, unchanged: JSON.stringify({ screen: before.screen, controls: before.controls }) ===
    JSON.stringify({ screen: after.screen, controls: after.controls }), unknownCard }
})
const deltaLookup = await page.evaluate(async () => {
  const tools = await document.modelContext.getTools()
  const inspect = tools.find((tool) => tool.name === 'inspect_game')
  const interact = tools.find((tool) => tool.name === 'interact_with_game')
  const marker = document.createElement('p')
  marker.textContent = 'Revision marker before'
  document.getElementById('root').append(marker)
  const before = await inspect.execute({})
  const unchanged = await inspect.execute({ since: before.revision })
  marker.textContent = 'Revision marker after'
  const delta = await inspect.execute({ since: unchanged.revision })
  const full = await inspect.execute({})
  marker.remove()
  const wrongRevision = await inspect.execute({ since: 'not-a-revision' })
  const action = document.createElement('button')
  action.textContent = 'Delta action'
  action.onclick = () => { action.textContent = 'Delta complete' }
  document.getElementById('root').append(action)
  const beforeAction = await inspect.execute({})
  const controlId = beforeAction.controls.find((control) => control.label === 'Delta action').id
  let afterAction
  let actionError = ''
  try { afterAction = await interact.execute({ controlId, since: beforeAction.revision }) }
  catch (error) { actionError = String(error) }
  const afterFailure = actionError ? await inspect.execute({}) : null
  action.remove()
  return { before, unchanged, delta, full, wrongRevision, afterAction, actionError,
    beforeAction: actionError ? beforeAction : null, afterFailure }
})
const textPagination = await page.evaluate(async () => {
  const inspect = (await document.modelContext.getTools()).find((tool) => tool.name === 'inspect_game')
  const marker = document.createElement('p')
  marker.textContent = 'x'.repeat(8_100)
  document.getElementById('root').append(marker)
  const first = await inspect.execute({})
  const second = await inspect.execute({ snapshotId: first.snapshotId, textOffset: first.screen.textNextOffset })
  marker.textContent += ' changed'
  let stale = ''
  try { await inspect.execute({ snapshotId: first.snapshotId, textOffset: first.screen.textNextOffset }) }
  catch (error) { stale = String(error) }
  marker.remove()
  return { firstLength: first.screen.text.length, secondLength: second.screen.text.length,
    firstOffset: first.screen.textNextOffset, secondOffset: second.screen.textOffset,
    stitched: (first.screen.text + second.screen.text).includes('x'.repeat(8_100)), stale }
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
    <button aria-pressed="false" aria-label="Arm potion">Arm potion</button>
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
    <span id="challenge-detail" class="visually-hidden">Unique challenge.</span>
    <article aria-label="Challenge" aria-describedby="challenge-detail"></article>
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
  const unarmedPotion = listed.controls.find((control) => control.label === 'Arm potion')?.selected
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
    unarmedPotion,
    passiveTextListed: listed.screen.text.includes('Party voice token noise') || listed.screen.text.includes('Voice unavailable'),
    duplicateTextListed: listed.screen.text.includes('Delayed advance') || listed.screen.text.includes('Reliable opening damage.'),
    wrappedLabelDuplicated: listed.screen.text.includes('Keep Bash') || listed.screen.text.includes('Locked target'),
    semanticTextListed: listed.screen.text.includes('Draw pile, 7 cards. 3 Energy. 5 Gold.'),
    nonControlDescriptionListed: listed.screen.text.includes('Unique challenge.'),
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
const chainedTarget = await page.evaluate(async () => {
  const fixture = document.createElement('section')
  fixture.innerHTML = '<button class="card" aria-label="Chained attack" aria-pressed="false">Attack</button><button class="enemy" aria-label="Training Slime, 3 HP">Slime</button><span role="status"></span>'
  document.getElementById('root').append(fixture)
  const attack = fixture.querySelector('[aria-label="Chained attack"]')
  const enemy = fixture.querySelector('.enemy')
  let attacks = 0
  let hits = 0
  attack.addEventListener('click', () => {
    attacks++
    attack.setAttribute('aria-pressed', 'true')
    attack.classList.add('card--selected')
    enemy.classList.add('enemy--targeted')
    fixture.querySelector('[role="status"]').textContent = 'Choose an enemy'
    const announcement = document.createElement('span')
    announcement.dataset.webmcpTransientStatus = ''
    announcement.textContent = 'Card selected before target'
    fixture.append(announcement)
    const persistent = document.createElement('span')
    persistent.dataset.webmcpTransientStatus = ''
    persistent.textContent = 'L'.repeat(8_001)
    fixture.append(persistent)
  })
  enemy.addEventListener('click', () => {
    hits++
    fixture.querySelector('[data-webmcp-transient-status]')?.remove()
    fixture.querySelector('[role="status"]').textContent = 'Enemy hit'
    enemy.classList.remove('enemy--targeted')
    enemy.setAttribute('aria-label', 'Training Slime, 2 HP')
  })
  const tools = await document.modelContext.getTools()
  const inspect = tools.find((tool) => tool.name === 'inspect_game')
  const interact = tools.find((tool) => tool.name === 'interact_with_game')
  const before = JSON.parse(await document.modelContext.executeTool(inspect, {}))
  const controlId = before.controls.find((control) => control.label === 'Chained attack').id
  let rejected = ''
  try {
    await document.modelContext.executeTool(interact, { controlId, targetLabel: 'Not a visible enemy' })
  } catch (error) { rejected = String(error) }
  const after = JSON.parse(await document.modelContext.executeTool(interact, {
    controlId, since: before.revision, targetLabel: 'Training Slime, 3 HP',
  }))
  const longNoticeSurvived = after.changes.screen.announcements?.some((notice) => notice.length === 8_000) &&
    !after.selectionAnnouncements?.some((notice) => notice.length === 8_000)
  after.changes.screen.announcements = after.changes.screen.announcements.map((notice) => notice.slice(0, 80))
  fixture.remove()
  const second = document.createElement('section')
  second.innerHTML = '<button class="card" aria-label="Replace target" aria-pressed="false">Replace</button><button class="enemy" aria-label="Twin Slime, 3 HP">Twin</button><button class="card" aria-label="Do not target" aria-pressed="false">No target</button><button class="card" aria-label="Picked card" aria-pressed="false">Picked</button><button aria-label="End turn">End</button><span role="status"></span>'
  document.getElementById('root').append(second)
  let replacementHits = 0
  let endClicks = 0
  second.querySelector('[aria-label="Replace target"]').addEventListener('click', () => {
    second.querySelector('[aria-label="Replace target"]').setAttribute('aria-pressed', 'true')
    second.querySelector('[aria-label="Replace target"]').classList.add('card--selected')
    const replacement = second.querySelector('.enemy').cloneNode(true)
    replacement.classList.add('enemy--targeted')
    replacement.addEventListener('click', () => { replacementHits++ })
    second.querySelector('.enemy').replaceWith(replacement)
    second.querySelector('[role="status"]').textContent = 'Choose an enemy'
  })
  second.querySelector('[aria-label="Do not target"]').addEventListener('click', () => {
    second.querySelector('[aria-label="Do not target"]').setAttribute('aria-pressed', 'true')
    second.querySelector('[aria-label="Do not target"]').classList.add('card--selected')
    second.querySelector('.enemy').classList.add('enemy--targeted')
    second.querySelector('[role="status"]').textContent = 'Choose an enemy for a Power'
    const notice = document.createElement('span')
    notice.dataset.webmcpTransientStatus = ''
    notice.textContent = 'Notice after non-targeting card'
    second.append(notice)
  })
  second.querySelector('[aria-label="Picked card"]').addEventListener('click', () => {
    second.querySelector('[aria-label="Picked card"]').setAttribute('aria-pressed', 'true')
    second.querySelector('[aria-label="Picked card"]').classList.add('card--picked')
    second.querySelector('.enemy').classList.add('enemy--targeted')
    second.querySelector('[role="status"]').textContent = 'Choose an enemy'
  })
  second.querySelector('[aria-label="End turn"]').addEventListener('click', () => { endClicks++ })
  const getId = async (name) => JSON.parse(await document.modelContext.executeTool(inspect, {}))
    .controls.find((control) => control.label === name).id
  const replaced = JSON.parse(await document.modelContext.executeTool(interact, {
    controlId: await getId('Replace target'), targetLabel: 'Twin Slime, 3 HP',
  }))
  second.querySelector('.enemy').classList.remove('enemy--targeted')
  const noTarget = JSON.parse(await document.modelContext.executeTool(interact, {
    controlId: await getId('Do not target'), targetLabel: 'Twin Slime, 3 HP',
  }))
  second.querySelector('.enemy').classList.remove('enemy--targeted')
  const picked = JSON.parse(await document.modelContext.executeTool(interact, {
    controlId: await getId('Picked card'), targetLabel: 'Twin Slime, 3 HP',
  }))
  second.querySelector('.enemy').classList.remove('enemy--targeted')
  let unrelated = ''
  try {
    await document.modelContext.executeTool(interact, {
      controlId: await getId('End turn'), targetLabel: 'Twin Slime, 3 HP',
    })
  } catch (error) { unrelated = String(error) }
  second.remove()
  const third = document.createElement('section')
  third.innerHTML = '<button class="card" aria-label="Pending attack">Pending</button><button class="enemy" aria-label="Pending Slime, 3 HP">Slime</button><span role="status"></span>'
  document.getElementById('root').append(third)
  third.querySelector('.card').addEventListener('click', () => {
    third.querySelector('.card').classList.add('card--selected')
    third.querySelector('.enemy').classList.add('enemy--targeted')
    third.querySelector('[role="status"]').textContent = 'Choose an enemy'
    const notice = document.createElement('span')
    notice.dataset.webmcpTransientStatus = ''
    notice.textContent = 'Notice before pending target'
    third.append(notice)
  })
  third.querySelector('.enemy').addEventListener('click', () => {
    third.querySelector('.enemy').classList.remove('enemy--targeted')
    third.querySelector('[data-webmcp-transient-status]').textContent = 'Notice changed during pending'
    document.documentElement.dataset.webmcpPending = 'true'
  })
  const pending = JSON.parse(await document.modelContext.executeTool(interact, {
    controlId: await getId('Pending attack'), targetLabel: 'Pending Slime, 3 HP',
  }))
  const inspectedPending = JSON.parse(await document.modelContext.executeTool(inspect, {}))
  delete document.documentElement.dataset.webmcpPending
  const inspectedSettled = JSON.parse(await document.modelContext.executeTool(inspect, {}))
  const inspectedAgain = JSON.parse(await document.modelContext.executeTool(inspect, {}))
  third.remove()
  return { rejected, attacks, hits, after, longNoticeSurvived, replaced, noTarget, picked, replacementHits, endClicks, unrelated,
    pending, inspectedPending, inspectedSettled, inspectedAgain }
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
  const clearedRoom = document.createElement('button')
  clearedRoom.className = 'room--visited'
  clearedRoom.disabled = true
  clearedRoom.textContent = 'Cleared room'
  fixture.append(clearedRoom)
  const currentRoom = document.createElement('button')
  currentRoom.className = 'room--visited room--here'
  currentRoom.disabled = true
  currentRoom.textContent = 'Current room'
  fixture.append(currentRoom)
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
    clearedRoomHidden: ![...firstPage.unavailableControls, ...secondPage.unavailableControls]
      .some((control) => control.label === 'Cleared room'),
    currentRoomVisible: [...firstPage.unavailableControls, ...secondPage.unavailableControls]
      .some((control) => control.label === 'Current room'),
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
await page.getByRole('region', { name: 'Run modes' }).waitFor()
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
  rooms.filter((room) => !room.classList.contains('room--visited') || room.classList.contains('room--here'))
    .map((room) => room.getAttribute('data-webmcp-context')).filter(Boolean).sort())
const futureRoomExamples = await page.locator('.room[aria-disabled="true"]').evaluateAll((rooms) => {
  const described = new Set()
  return rooms.filter((room) => !room.classList.contains('room--visited') || room.classList.contains('room--here'))
    .flatMap((room) => {
      const name = room.getAttribute('data-webmcp-label')?.replace(/ \(here\)$/, '')
      if (!name || described.has(name)) return []
      described.add(name)
      return [room.getAttribute('aria-label')]
    }).filter(Boolean)
})
const roomControl = mapInspection.controls.find((control) => control.label === roomLabel)
if (!roomControl) throw new Error(`reachable room is missing from WebMCP: ${roomLabel}`)
await interact(roomControl.id)
await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'combat')
await page.waitForFunction(() => window.__STS_DEBUG__.getState()?.phase === 'player')
const automaticStartInspection = await inspectAll()
const combatStatsLookup = await page.evaluate(async () => {
  const tools = await document.modelContext.getTools()
  const inspect = tools.find((tool) => tool.name === 'inspect_game')
  const stats = tools.find((tool) => tool.name === 'get_stats')
  const before = await inspect.execute({})
  const result = await stats.execute({ character: 'watcher', ascension: 0 })
  const after = await inspect.execute({})
  return { result, unchanged: JSON.stringify({ screen: before.screen, controls: before.controls }) ===
    JSON.stringify({ screen: after.screen, controls: after.controls }) }
})
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
  seesDrawPile: combatInspection.controls.some((control) => /^Draw pile, \d+ cards$/.test(control.label)),
  richAttack: attack.label,
  targetLabel,
  targetSettlementMarked: targetSettlement?.marked,
  targetSettledBeforeContact: targetSettlement?.settledBeforeContact,
  targetReturnedState: Boolean(targetSettlement?.result.controls),
  changed: afterAttack.energy < beforeAttack.energy || afterAttack.enemyHp < beforeAttack.enemyHp,
  nextTurnReturned: /Turn 2/.test(endTurnResult.screen?.text ?? ''),
}

for (const hasHeldCard of [false, true]) {
  await page.evaluate((held) => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    const player = run.combat.players[0]
    Object.assign(player, {
      character: 'hermit', hand: held ? [{ uid: 'webmcp-feint-held', defId: 'hermit_snapshot', upgraded: false }] : [],
      chamber: [{ uid: 'webmcp-feint', defId: 'hermit_feint', upgraded: false }],
      chamberSlots: 2, draw: [
        { uid: 'webmcp-feint-draw-1', defId: 'hermit_strike', upgraded: false },
        { uid: 'webmcp-feint-draw-2', defId: 'hermit_defend', upgraded: false },
      ], discard: [], energy: 3, drawLocked: false,
    })
    Object.assign(run.combat, { phase: 'player', pendingCardCopy: undefined, pendingHermitSetupLoads: [] })
    debug.setRun({ ...run, phase: 'map' })
    debug.setRun(run)
  }, hasHeldCard)
  await page.getByRole('button', { name: 'Chamber, 1 of 2 slots filled' }).waitFor()
  await page.waitForFunction(() => window.__STS_DEBUG__.getState()?.players[0]?.chamber[0]?.defId === 'hermit_feint')
  const chamber = (await inspectAll()).controls.find((control) => control.label === 'Chamber, 1 of 2 slots filled')
  await interact(chamber.id)
  const feint = (await inspectAll()).controls.find((control) => control.label.startsWith('Feint, cost 1'))
  if (!feint) throw new Error(`WebMCP did not expose chambered Feint: ${JSON.stringify((await inspectAll()).controls.map((control) => control.label))}`)
  const feintChoice = await interact(feint.id)
  const feintCards = feintChoice.controls.filter((control) => control.context === 'Choose 1 to Load')
  assertDeepEqual(feintCards.map((control) => control.label.split(',')[0]).sort(),
    hasHeldCard ? ['Defend', 'Snapshot', 'Strike'] : ['Defend', 'Strike'],
    'chambered Feint must reveal its post-draw Load choices without a pre-draw prompt')
  const picked = await interact(feintCards.find((control) => control.label.startsWith('Defend'))?.id)
  const confirmFeint = picked.controls.find((control) => control.label === 'Load 1 card')
  if (!confirmFeint) throw new Error('WebMCP did not expose Feint Load confirmation')
  await interact(confirmFeint.id)
  assert(await page.evaluate(() => window.__STS_DEBUG__.getState().players[0].chamber
    .some((card) => card.uid === 'webmcp-feint-draw-2')),
    'WebMCP Feint Load confirmation must complete the play')
}

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const player = run.combat.players[0]
  player.relics = [...player.relics.filter((relic) => relic.defId !== 'golden_eye'), {
    defId: 'golden_eye', spent: false,
  }]
  player.draw = Array.from({ length: 5 }, (_, index) => ({
    uid: `webmcp-golden-eye-${index}`, defId: 'defend_watcher', upgraded: false,
  }))
  debug.setRun(run)
})
await page.getByRole('button', { name: /^Use Golden Eye/ }).waitFor()
const activeRelicInspection = await inspectAll()
const activeRelic = activeRelicInspection.controls.find((control) => control.label.startsWith('Use Golden Eye'))
if (!activeRelic) throw new Error(`WebMCP did not expose Golden Eye: ${JSON.stringify(activeRelicInspection.controls)}`)
const activeRelicOpened = await interact(activeRelic.id)
const finishGoldenEye = activeRelicOpened.controls.find((control) => control.label === 'Discard none')
if (!finishGoldenEye) throw new Error(`WebMCP did not expose Golden Eye resolution: ${JSON.stringify(activeRelicOpened)}`)
const activeRelicResolved = await interact(finishGoldenEye.id)
const activeRelicFlow = {
  tellsAgentWhatItDoes: activeRelic.label.includes('Once per combat: Scry 3'),
  opensResolution: activeRelicOpened.screen.headings.includes('Golden Eye — Scry 3'),
  resolved: await page.evaluate(() => window.__STS_DEBUG__.getState().players[0].relics
    .find((relic) => relic.defId === 'golden_eye')?.spent === true),
  leavesPlayableState: activeRelicResolved.controls.some((control) => control.label.startsWith('End turn')),
}

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const player = run.combat.players[0]
  Object.assign(run.combat, { phase: 'roundEnd', turn: 2, log: [] })
  Object.assign(player, {
    character: 'silent', hand: [], discard: [], exhaust: [], energy: 0,
    powers: [{ uid: 'webmcp-noxious-fumes', defId: 'noxious_fumes', upgraded: false }],
    draw: Array.from({ length: 10 }, (_, index) => ({
      uid: `webmcp-noxious-draw-${index}`, defId: 'defend_silent', upgraded: false,
    })),
  })
  const enemy = run.combat.enemies.find((candidate) => !candidate.dead) ?? run.combat.enemies[0]
  run.combat.enemies = [0, 1].map((row) => ({
    ...enemy, uid: `webmcp-noxious-enemy-${row}`, row, hp: 20, maxHp: 20,
    block: 0, poison: 0, dead: false, abilityUsed: true,
  }))
  debug.setRun(run)
})
await page.locator('.combat[data-phase="start"]').waitFor()
await page.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('Noxious Fumes'))
const startTurnInspection = await inspectAll()
const startTurnTargetLabel = await page.locator('.enemy--targeted:not([disabled])').first().getAttribute('aria-label')
const startTurnTarget = startTurnInspection.controls.find((control) => control.label === startTurnTargetLabel)
if (!startTurnTarget) throw new Error(`WebMCP did not expose a start-turn target: ${JSON.stringify(startTurnInspection)}`)
const startTurnTargeted = await interact(startTurnTarget.id)
const resolveStartTurn = startTurnTargeted.controls.find((control) => control.label === 'Resolve start of turn')
if (!resolveStartTurn) throw new Error(`WebMCP did not expose start-turn resolution: ${JSON.stringify(startTurnTargeted)}`)
const startTurnResolved = await interact(resolveStartTurn.id)
const startTurnFlow = {
  announcedChoice: startTurnInspection.screen.status.some((status) => status.includes('Noxious Fumes')),
  targetWasInvokable: Boolean(startTurnTarget.id),
  resolved: await page.evaluate(() => {
    const state = window.__STS_DEBUG__.getState()
    return state.phase === 'player' && state.enemies.filter((enemy) => enemy.poison === 1).length === 1
  }),
  leavesPlayableState: startTurnResolved.controls.some((control) => control.label.startsWith('End turn')),
}

const relicResolutionBefore = await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  run.phase = 'map'
  run.combat = null
  const player = run.players[0]
  player.relics.push({ defId: 'war_paint', spent: false, pending: true })
  const upgraded = player.deck.filter((card) => card.upgraded).length
  debug.setRun(run)
  return upgraded
})
await page.getByRole('heading', { name: 'Resolve War Paint' }).waitFor()
const relicResolutionInspection = await inspectAll()
const relicCard = relicResolutionInspection.controls.find((control) => /, skill,/i.test(control.label))
if (!relicCard) throw new Error(`WebMCP did not expose a War Paint card choice: ${JSON.stringify(relicResolutionInspection)}`)
const relicCardSelected = await interact(relicCard.id)
const confirmRelic = relicCardSelected.controls.find((control) => control.label === 'Confirm War Paint')
if (!confirmRelic) throw new Error(`WebMCP did not expose War Paint confirmation: ${JSON.stringify(relicCardSelected)}`)
const relicResolutionSettled = await interact(confirmRelic.id)
const relicResolutionFlow = {
  explainsResolution: relicResolutionInspection.screen.headings.includes('Resolve War Paint') &&
    relicResolutionInspection.screen.text.includes('Upgrade a starter Defend and another Skill'),
  cardWasInvokable: Boolean(relicCard.id),
  resolved: await page.evaluate((before) => {
    const player = window.__STS_DEBUG__.getRun().players[0]
    return !player.relics.some((relic) => relic.pending) && player.deck.filter((card) => card.upgraded).length > before
  }, relicResolutionBefore),
  returnedMap: relicResolutionSettled.controls.some((control) => control.context?.startsWith('Floor ')),
}

await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  debug.setRun({ ...run, phase: 'defeat', combat: null, campaign: { ...run.campaign, finalized: false } })
})
await page.getByRole('button', { name: 'Record campaign result' }).waitFor()
const defeatInspection = await inspectAll()
const recordResult = defeatInspection.controls.find((control) => control.label === 'Record campaign result')
if (!recordResult) throw new Error(`WebMCP did not expose campaign recording: ${JSON.stringify(defeatInspection)}`)
const recorded = await interact(recordResult.id)
const leaderboardRecording = {
  attempts: leaderboardSubmissions.map((submission) => Boolean(submission.profileToken)),
  announced: recorded.screen.announcements?.includes('Run recorded on the leaderboard.'),
  queued: await page.evaluate(() => JSON.parse(localStorage.getItem('sts-leaderboard-outbox') ?? '[]').length),
}

leaderboardUnavailable = true
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  debug.setRun({
    ...run,
    seed: run.seed + 1,
    phase: 'defeat',
    campaign: { ...run.campaign, runId: `${run.campaign.runId}-retry`, finalized: false },
  })
})
await page.getByRole('button', { name: 'Record campaign result' }).waitFor()
const retryInspection = await inspectAll()
const retryResult = retryInspection.controls.find((control) => control.label === 'Record campaign result')
if (!retryResult) throw new Error(`WebMCP did not expose retry recording: ${JSON.stringify(retryInspection)}`)
const queuedResult = await interact(retryResult.id)
leaderboardUnavailable = false
await page.evaluate(() => window.dispatchEvent(new Event('online')))
await page.getByText('Run recorded on the leaderboard.').waitFor()
const retriedResult = await inspectAll()
const expectedLeaderboardErrors = errors.filter((error) => /409 \(Conflict\)|503 \(Service Unavailable\)/.test(error))
for (let index = errors.length - 1; index >= 0; index -= 1) {
  if (/409 \(Conflict\)|503 \(Service Unavailable\)/.test(errors[index])) errors.splice(index, 1)
}
const leaderboardRetry = {
  queued: queuedResult.screen.announcements?.includes('Leaderboard unavailable — run saved for automatic retry.'),
  recorded: retriedResult.screen.announcements?.includes('Run recorded on the leaderboard.'),
  attempts: leaderboardSubmissions.slice(3).map((submission) => Boolean(submission.profileToken)),
  expectedErrors: expectedLeaderboardErrors.length,
}

const multiplayerSubmissions = leaderboardSubmissions.length
await page.evaluate(() => {
  const debug = window.__STS_DEBUG__
  const run = structuredClone(debug.getRun())
  const ally = structuredClone(run.players[0])
  Object.assign(ally, { id: 'webmcp-local-ally', name: 'Local Ally', character: 'ironclad' })
  debug.setRun({
    ...run,
    seed: run.seed + 1,
    phase: 'defeat',
    players: [...run.players, ally],
    campaign: { ...run.campaign, runId: `${run.campaign.runId}-multiplayer`, finalized: false },
  })
})
await page.getByRole('button', { name: 'Record campaign result' }).waitFor()
const multiplayerInspection = await inspectAll()
const multiplayerRecord = multiplayerInspection.controls.find((control) => control.label === 'Record campaign result')
if (!multiplayerRecord) throw new Error('WebMCP did not expose local multiplayer campaign recording')
const multiplayerRecorded = await interact(multiplayerRecord.id)
const localMultiplayerRecording = {
  announced: multiplayerRecorded.screen.announcements?.some((message) => /leaderboard/i.test(message)) ?? false,
  submissions: leaderboardSubmissions.length - multiplayerSubmissions,
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
await bridge.goto(`http://localhost:${address.port}`)
await bridge.getByRole('button', { name: 'Single Player' }).waitFor()
await new Promise((resolve) => setTimeout(resolve, 10_500))
await bridge.evaluate(() => {
  const tools = new Map()
  let rejectNext = true
  Object.defineProperty(navigator, 'modelContext', {
    configurable: true,
    value: {
      registerTool(tool, options = {}) {
        if (rejectNext) {
          rejectNext = false
          return Promise.reject(new Error('Bridge is still starting.'))
        }
        tools.set(tool.name, tool)
        options.signal?.addEventListener('abort', () => {
          if (tools.get(tool.name) === tool) tools.delete(tool.name)
        }, { once: true })
        return Promise.resolve()
      },
      listTools() { return [...tools.values()] },
      callTool(name, input) { return tools.get(name)?.execute(input, {}) },
    },
  })
})
await bridge.waitForFunction(() => navigator.modelContext?.listTools().length === 3, null, { timeout: 20_000 })
const bridgeCompatibility = await bridge.evaluate(async () => {
  const before = await navigator.modelContext.callTool('inspect_game', {})
  const singlePlayer = before.controls.find((control) => control.label === 'Single Player')
  if (!singlePlayer) throw new Error('navigator-only WebMCP bridge did not expose Single Player')
  const result = await navigator.modelContext.callTool('interact_with_game', { controlId: singlePlayer.id })
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

check('registers focused, safely annotated game and stats tools', () => {
  assertDeepEqual(tools.map((tool) => tool.name), ['inspect_game', 'interact_with_game', 'get_stats'])
  assert(tools[0].annotations.readOnlyHint && tools[0].annotations.untrustedContentHint,
    'screen inspection is read-only and marked untrusted')
  assert(tools[1].annotations.untrustedContentHint && !tools[1].annotations.consequentialHint,
    'in-game interactions are marked untrusted but not as real-world consequential actions')
  assert(tools[1].inputSchema.properties.value.oneOf[0].maxLength === 1000, 'free-form tool strings are schema-bounded')
  assert(tools[2].annotations.readOnlyHint && tools[2].annotations.untrustedContentHint,
    'stats lookup is read-only and its archive is untrusted')
  assert(tools.slice(0, 2).every((tool) => /start-turn/.test(tool.description) && /relic/.test(tool.description)),
    'tool metadata tells agents that start-turn and relic controls are actionable')
  assert(/unavailableControls.*planning-only/.test(tools[0].description),
    'inspection metadata distinguishes invokable controls from planning-only unavailable controls')
  assertDeepEqual(bridgeCompatibility, {
    tools: ['inspect_game', 'interact_with_game', 'get_stats'],
    reachedModeSelect: true,
  })
})

check('reads filtered stats without changing game controls or losing full results', () => {
  assert(statsLookup.unchanged, 'stats lookup changed the current game screen or control IDs')
  assert(statsLookup.summary.runs === 15 && statsLookup.summary.rows.length === 5 && statsLookup.summary.totalRows === 7,
    'concise stats retain aggregate metrics and disclose additional rows')
  assert(statsLookup.full.rows.length === 7, 'full stats omit archetype rows')
  assertDeepEqual(statsLookup.summary.nextCards.map((card) => card.defId), ['hermit_brawl'])
  assertDeepEqual(statsLookup.summary.notInTopComparisons, ['hermit_take_cover'])
  assert(statsLookup.unknownCard.includes('Unknown card'), 'stats lookup accepted an invalid card filter')
  assert(statsRequests[0].get('character') === 'hermit' && statsRequests[0].get('ascension') === '1' &&
    statsRequests[0].get('mode') === 'standard' && JSON.parse(statsRequests[0].get('q')).id === 'hermit_snapshot',
  'stats lookup did not reuse the standard solo card filters')
  assert(combatStatsLookup.unchanged && combatStatsLookup.result.runs === 15 &&
    statsRequests.some((params) => params.get('character') === 'watcher' && params.get('ascension') === '0'),
  'mid-combat stats lookup changed the run or failed to query the archive')
})

check('offers exact opt-in deltas with a full fallback on unknown revisions', () => {
  assertDeepEqual(deltaLookup.unchanged.changes, {})
  assert(deltaLookup.unchanged.baseRevision === deltaLookup.before.revision,
    'unchanged inspection did not identify its base state')
  assert(deltaLookup.delta.changes.screen.text === deltaLookup.full.screen.text &&
    deltaLookup.delta.changes.controls?.length === deltaLookup.full.controls.length,
  'changed inspection did not preserve the full visible text and actionable controls')
  assert(deltaLookup.wrongRevision.screen && !deltaLookup.wrongRevision.baseRevision,
    'unknown base revision did not return a full safe snapshot')
  assert(deltaLookup.afterAction?.baseRevision && !deltaLookup.afterAction.changes.screen &&
    deltaLookup.afterAction.changes.controls?.some((control) => control.label === 'Delta complete'),
  'action delta lost updated invokable controls or repeated unchanged screen text')
  assert(textPagination.firstLength === 8_000 && textPagination.firstOffset === textPagination.secondOffset &&
    textPagination.secondLength > 0 && textPagination.stitched && textPagination.stale.includes('Game state changed'),
  'long visible text could not be reconstructed or stale continuation was accepted')
})

check('returns visible gameplay context and drives every gameplay control kind', () => {
  assert(chainedTarget.rejected.includes('visible unavailable enemy') && chainedTarget.attacks === 1 && chainedTarget.hits === 1 &&
    chainedTarget.after.baseRevision && chainedTarget.after.changes.unavailableControls?.some((control) =>
      control.label === 'Training Slime, 2 HP') &&
    chainedTarget.after.selectionAnnouncements?.includes('Card selected before target') &&
    chainedTarget.longNoticeSurvived &&
    chainedTarget.replaced.controls?.some((control) => control.label === 'Twin Slime, 3 HP') &&
    chainedTarget.noTarget.controls?.some((control) => control.label === 'Twin Slime, 3 HP') &&
    chainedTarget.noTarget.screen?.announcements?.includes('Notice after non-targeting card') &&
    !chainedTarget.noTarget.selectionAnnouncements &&
    chainedTarget.picked.controls?.some((control) => control.label === 'Twin Slime, 3 HP') &&
    chainedTarget.replacementHits === 0 && chainedTarget.endClicks === 0 &&
    chainedTarget.unrelated.includes('can only follow a card or Shiv') &&
    chainedTarget.pending.pending && chainedTarget.pending.selectionAnnouncements?.includes('Notice before pending target') &&
    !chainedTarget.inspectedPending.screen.announcements?.includes('Notice before pending target') &&
    chainedTarget.inspectedSettled.screen.announcements?.includes('Notice changed during pending') &&
    !chainedTarget.inspectedAgain.screen.announcements?.includes('Notice changed during pending'),
  'a chained target must be previously visible, unique, and settled after the hit without an intermediate tool call')
  assert(initial.screen.headings.length > 0, 'inspection reads the visible start screen')
  assert(initial.controls.some((control) => control.label === 'Single Player'), 'inspection lists the visible menu')
  assert(initial.controls.every((control) => control.kind !== 'button') &&
    initial.nextOffset === null && !('snapshotId' in initial) && !('textTruncated' in initial.screen),
  'ordinary inspections omit redundant button kinds and pagination/truncation metadata')
  assert(malformed.inspectNull.includes('Expected an object input') && malformed.inspectOffset.includes('offset must be') &&
    malformed.inspectExtra.includes('Unexpected input property') && malformed.interactNull.includes('Expected an object input') &&
    malformed.controlId.includes('controlId must be') && malformed.interactExtra.includes('Unexpected input property'),
  'malformed tool inputs return clear retryable errors')
  assert(controls.richLabel.includes('Deal 6 damage') && controls.context === 'Ironclad training hand' &&
    controls.description === 'Reliable opening damage.', 'card actions preserve rich accessible context')
  assert(controls.unarmedPotion === false, 'unpressed targetable actions remain distinct from ordinary buttons')
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

check('records a finished run through WebMCP after a stale profile retry', () => {
  assertDeepEqual(leaderboardRecording.attempts, [true, true, false])
  assert(leaderboardRecording.announced, 'WebMCP did not return the leaderboard acknowledgment')
  assertDeepEqual(leaderboardRecording.queued, 0)
  assert(leaderboardRetry.queued && leaderboardRetry.recorded,
    'an automatic retry did not update the WebMCP-visible submission status')
  assertDeepEqual(leaderboardRetry.attempts, [true, true, true, false])
  assert(leaderboardRetry.expectedErrors >= 5, 'the retry fixtures did not exercise their expected failures')
  assertDeepEqual(localMultiplayerRecording, { announced: false, submissions: 0 })
})

check('keeps snapshots scoped, stable, opaque, and current', () => {
  assert(pagination.hasNextPage && pagination.secondPageControls > 0 && pagination.clicks === 1,
    'a page-one control remains valid after fetching the next page')
  assert(pagination.idsRotated && pagination.mixedPage.includes('Game state changed during pagination') &&
    pagination.abaPage.includes('Game state changed during pagination') &&
    pagination.staleActionResult.includes('Control is no longer available'),
  'concurrent and identical-tree replacements reject mixed pages and stale page-one actions')
  assert(pagination.secondPageScreen === undefined, 'continuation pages do not repeat unchanged screen text')
  assert(pagination.clearedRoomHidden && pagination.currentRoomVisible && pagination.unavailableCount === 30 &&
    pagination.totalUnavailable >= 35 && pagination.unavailableTruncated &&
    pagination.unavailableCount + pagination.secondPageUnavailable === pagination.totalUnavailable,
  `unavailable controls paginate without losing future rooms or listing cleared rooms: ${JSON.stringify(pagination)}`)
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
  assert(payloadChars.metadata < 2_750 && payloadChars.start < 1_000 && payloadChars.fixture < 3_600 && payloadChars.lab < 900 &&
    payloadChars.map < 6_700 && payloadChars.combat < 2_500,
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
    mapInspection.unavailableControls.filter((control) => control.context?.startsWith('Floor '))
      .map((control) => control.label).filter((label) => label.includes('Out of reach')).length <= futureRoomExamples.length &&
    futureRoomExamples.every((label) => mapInspection.unavailableControls.some((control) => control.label === label)) &&
    futureRoomContexts.some((context) => context.includes('; exits to floor ')) &&
    automaticStartInspection.controls.some((control) => control.label === 'End turn'),
  'map inspection preserves future routes and the settled combat screen exposes End turn')
  assertDeepEqual({ phase: automaticStartPhase, resolveControls: automaticStartResolveControls.length }, {
    phase: 'player', resolveControls: 0,
  }, 'WebMCP exposed a redundant action for deterministic start-of-combat effects')
  assert(combatFlow.seesTurn && combatFlow.seesEnergy && combatFlow.seesDrawPile,
    `combat inspection exposes turn, current Energy, and draw-pile count: ${JSON.stringify(combatInspection)}`)
  assert(/, attack,/i.test(combatFlow.richAttack) && combatFlow.targetLabel && combatFlow.targetSettlementMarked &&
    !combatFlow.targetSettledBeforeContact && combatFlow.targetReturnedState && combatFlow.changed && combatFlow.nextTurnReturned,
  `a real Watcher Attack remains pending through contact, then returns settled controls: ${JSON.stringify(combatFlow)}`)
  assert(Object.values(activeRelicFlow).every(Boolean),
    `WebMCP exposes, explains, and resolves an active Relic: ${JSON.stringify(activeRelicFlow)}`)
  assert(Object.values(startTurnFlow).every(Boolean),
    `WebMCP exposes and resolves a start-of-turn choice: ${JSON.stringify(startTurnFlow)}`)
  assert(Object.values(relicResolutionFlow).every(Boolean),
    `WebMCP exposes, explains, and completes Relic resolution: ${JSON.stringify(relicResolutionFlow)}`)
  assertDeepEqual(errors, [])
  assertDeepEqual(fallbackErrors, [])
})

await browser.close()
await server.close()
report(`WebMCP browser; payload chars ${Object.entries(payloadChars).map(([name, size]) => `${name}=${size}`).join(', ')}`)
