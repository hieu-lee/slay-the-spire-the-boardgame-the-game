#!/usr/bin/env node
// Focused check of the replay playback bar: pause, speed, rewind and the video-style scrubber.
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = join(root, 'artifacts/replay-controls')
mkdirSync(output, { recursive: true })
const server = await createServer({ root, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } })
await server.listen()
const address = server.httpServer?.address()
if (!address || typeof address === 'string') throw new Error('Vite did not report a port')
const origin = `http://127.0.0.1:${address.port}`
const browser = await chromium.launch({ headless: true })
const MOVES = 60
const profile = { username: 'Replay Tester', token: '00000000-0000-4000-8000-000000000001', secured: true }

// Record a real run log: one Neow click, then a climb of MOVES - 1 state changes across three acts.
const recorder = await browser.newContext({ viewport: { width: 1600, height: 900 } })
await recorder.addInitScript((saved) => localStorage.setItem('sts-profile', JSON.stringify(saved)), profile)
const recording = await recorder.newPage()
await recording.goto(origin, { waitUntil: 'networkidle' })
for (const label of ['Single Player', 'Standard', 'Embark', 'Start standard campaign']) {
  await recording.getByRole('button', { name: label, exact: true }).click()
}
await recording.waitForFunction(() => window.__STS_DEBUG__?.getRun().phase === 'neow')
await recording.getByRole('button', { name: 'Gain 3 Gold', exact: true }).click()
await recording.waitForFunction(() => window.__STS_DEBUG__.getRun().players[0].gold === 3)
for (let floor = 1; floor < MOVES; floor += 1) {
  await recording.evaluate((value) => {
    const run = structuredClone(window.__STS_DEBUG__.getRun())
    run.floorsCleared = value
    run.act = 1 + Math.floor((value - 1) / 20)
    run.players[0].gold = 3 + value
    window.__STS_DEBUG__.setRun(run)
  }, floor)
  await recording.waitForFunction((value) => window.__STS_DEBUG__.getRun().floorsCleared === value, floor)
}
await recording.evaluate(() => {
  const run = structuredClone(window.__STS_DEBUG__.getRun())
  run.phase = 'defeat'; run.neow = null; run.combat = null
  window.__STS_DEBUG__.setRun(run)
})
await recording.waitForTimeout(400)
const logText = JSON.stringify(await recording.evaluate(async () =>
  (await import('/src/ui/run-log.ts')).readRunLog(window.__STS_DEBUG__.getRun().campaign.runId)))
await recorder.close()
const events = JSON.parse(logText).events.length
assert(events >= MOVES, `Recorded log has only ${events} moves`)

// Jumping to a move must give exactly the state that playing up to it gives, whatever order the jumps come in.
const checking = await browser.newPage()
await checking.goto(origin, { waitUntil: 'networkidle' })
const consistency = await checking.evaluate(async (text) => {
  const { applyRunLogEvent, runLogEventChoice } = await import('/src/ui/run-log.ts')
  const { ReplayTimeline } = await import('/src/ui/run-replay.ts')
  const log = JSON.parse(text)
  const timeline = new ReplayTimeline(log)
  const sequential = [structuredClone(log.initial)]
  for (const event of log.events) sequential.push(applyRunLogEvent(sequential.at(-1), { ...event, choice: runLogEventChoice(event, sequential.at(-1)) }))
  const order = [...sequential.keys()].sort((a, b) => ((a * 7919) % 101) - ((b * 7919) % 101))
  return order.filter((position) => JSON.stringify(timeline.stateAt(position)) !== JSON.stringify(sequential[position]))
}, logText)
await checking.close()
assert.deepEqual(consistency, [], 'The replay timeline rebuilt the wrong state for some moves')

// A second log with a real card play, so pausing and jumping are also checked across the cursor and click path.
const clickRecorder = await browser.newContext({ viewport: { width: 1600, height: 900 } })
await clickRecorder.addInitScript((saved) => localStorage.setItem('sts-profile', JSON.stringify(saved)), profile)
const clicking = await clickRecorder.newPage()
await clicking.goto(origin, { waitUntil: 'networkidle' })
for (const label of ['Single Player', 'Standard', 'Embark', 'Start standard campaign']) {
  await clicking.getByRole('button', { name: label, exact: true }).click()
}
await clicking.waitForFunction(() => window.__STS_DEBUG__?.getRun().phase === 'neow')
await clicking.getByRole('button', { name: 'Gain 3 Gold', exact: true }).click()
await clicking.waitForFunction(() => window.__STS_DEBUG__.getRun().players[0].gold === 3)
await clicking.evaluate(async () => {
  const { createCombat } = await import('/src/game/combat.ts')
  const run = structuredClone(window.__STS_DEBUG__.getRun())
  const enemy = { uid: 'replay-worm', defId: 'jaw_worm', row: 0, isBoss: false, actsLast: false,
    hp: 40, maxHp: 40, block: 0, strength: 0, vulnerable: 0, weak: 0, poison: 0,
    goldReward: 0, cardReward: null, actionIndex: 0, abilityUsed: false, dead: false }
  run.combat = createCombat({ seed: 43, calls: 0 }, run.players, [enemy], 'replay-controls-click')
  Object.assign(run.combat.players[0], { hand: [{ uid: 'replay-strike', defId: 'strike_ironclad', upgraded: false }], energy: 3 })
  run.phase = 'combat'; run.neow = null
  window.__STS_DEBUG__.setRun(run)
})
await clicking.getByRole('button', { name: /^Strike,/ }).click()
await clicking.locator('[data-enemy-id="replay-worm"]').click()
await clicking.waitForFunction(() => window.__STS_DEBUG__.getRun().combat.enemies[0].hp === 39)
await clicking.evaluate(() => {
  const run = structuredClone(window.__STS_DEBUG__.getRun())
  run.phase = 'defeat'; run.neow = null; run.combat = null
  window.__STS_DEBUG__.setRun(run)
})
await clicking.waitForTimeout(400)
const clickLogText = JSON.stringify(await clicking.evaluate(async () =>
  (await import('/src/ui/run-log.ts')).readRunLog(window.__STS_DEBUG__.getRun().campaign.runId)))
await clickRecorder.close()

const open = async (viewport, hasTouch = false, text = logText) => {
  const context = await browser.newContext({ viewport, hasTouch })
  await context.addInitScript((saved) => localStorage.setItem('sts-profile', JSON.stringify(saved)), profile)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  await page.goto(origin, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Replay', exact: true }).click()
  await page.locator('.run-replay-import').evaluate((screen, text) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File([text], 'run.json', { type: 'application/json' }))
    screen.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
  }, text)
  await page.locator('.replay-bar').waitFor()
  const bar = {
    scrub: page.getByRole('slider', { name: 'Replay position' }),
    position: async () => Number(await page.getByRole('slider', { name: 'Replay position' }).getAttribute('aria-valuenow')),
    floors: () => page.evaluate(() => window.__STS_DEBUG__.getRun().floorsCleared ?? 0),
    speed: async (label) => {
      await page.getByRole('button', { name: /^Playback speed/ }).click()
      await page.getByRole('menuitemradio', { name: label, exact: true }).click()
    },
    at: async (fraction) => {
      const slider = page.getByRole('slider', { name: 'Replay position' })
      await slider.waitFor()
      const box = await slider.boundingBox()
      assert(box, 'The replay scrubber has no box on screen')
      return { x: box.x + box.width * Math.min(fraction, 0.995), y: box.y + box.height / 2 }
    },
  }
  return { context, page, errors, bar }
}

// The floor reached after `position` moves, worked out by applying the log one move at a time.
const expectedFloor = (page, position) => page.evaluate(async ({ text, position }) => {
  const { applyRunLogEvent, runLogEventChoice } = await import('/src/ui/run-log.ts')
  const log = JSON.parse(text)
  let state = log.initial
  for (const event of log.events.slice(0, position)) state = applyRunLogEvent(state, { ...event, choice: runLogEventChoice(event, state) })
  return state.floorsCleared ?? 0
}, { text: logText, position })

// What the scrubber calls a move: the act and floor after `position` moves.
const expectedWhere = (page, position) => page.evaluate(async ({ text, position }) => {
  const { applyRunLogEvent, runLogEventChoice } = await import('/src/ui/run-log.ts')
  const log = JSON.parse(text)
  let state = log.initial
  for (const event of log.events.slice(0, position)) state = applyRunLogEvent(state, { ...event, choice: runLogEventChoice(event, state) })
  const floor = state.floorsCleared ?? 0
  return floor > 0 ? `Act ${state.act} · Floor ${floor}` : `Act ${state.act}`
}, { text: logText, position })

const until = async (check, message, timeout = 5_000) => {
  const deadline = Date.now() + timeout
  while (!(await check())) {
    assert(Date.now() < deadline, message)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

const secondsPerMove = async ({ page, bar }, label) => {
  await bar.speed(label)
  await page.mouse.click(...Object.values(await bar.at(0.3)))
  const start = await bar.position()
  const began = Date.now()
  await page.waitForFunction((target) => Number(document.querySelector('[role="slider"]').getAttribute('aria-valuenow')) >= target, start + 5)
  return (Date.now() - began) / 5
}

let desktop, phone
try {
  desktop = await open({ width: 1600, height: 900 })
  const { page, bar } = desktop
  assert.equal(await bar.scrub.getAttribute('aria-valuemax'), String(events), 'The scrubber does not span the whole log')

  // Playback advances; pausing freezes it; resuming continues. The pointer stays on the bar so it stays up.
  await page.mouse.move(...Object.values(await bar.at(0.5)))
  await page.waitForFunction(() => Number(document.querySelector('[role="slider"]').getAttribute('aria-valuenow')) >= 3)
  // A page animation stands in for the game's own effects: pause freezes it, speed scales it.
  await page.evaluate(() => { window.__probe = document.body.animate([{ opacity: 1 }, { opacity: 0.99 }], { duration: 600_000, iterations: Infinity }) })
  const probeRate = () => page.evaluate(() => window.__probe.playbackRate)
  await page.getByRole('button', { name: 'Pause', exact: true }).click()
  await until(async () => (await probeRate()) === 0, 'Pausing did not freeze the page animations')
  const probeTime = () => page.evaluate(() => Number(window.__probe.currentTime))
  const frozenAt = await probeTime()
  await page.waitForTimeout(600)
  assert(await probeTime() - frozenAt < 40, 'A paused page animation kept running')
  // What starts during the pause plays its entrance for a moment, then freezes too.
  await page.evaluate(() => { window.__late = document.body.animate([{ opacity: 1 }, { opacity: 0.99 }], { duration: 600_000, iterations: Infinity }) })
  await page.waitForTimeout(2_200)
  const lateAt = await page.evaluate(() => Number(window.__late.currentTime))
  await page.waitForTimeout(500)
  assert(await page.evaluate(() => Number(window.__late.currentTime)) - lateAt < 40, 'An animation started while paused never froze')
  const frozen = await bar.position()
  const frozenFloor = await bar.floors()
  await page.waitForTimeout(700)
  assert.equal(await bar.position(), frozen, 'Replay kept advancing while paused')
  assert.equal(await bar.floors(), frozenFloor, 'Replay changed the run while paused')
  await page.getByRole('button', { name: 'Resume', exact: true }).click()
  await page.waitForFunction((value) => Number(document.querySelector('[role="slider"]').getAttribute('aria-valuenow')) > value, frozen)
  await until(async () => (await probeRate()) === 1, 'Resuming did not restore the page animations')

  // Rewind steps back ten moves and playback carries on from there.
  await page.getByRole('button', { name: 'Pause', exact: true }).click()
  await until(async () => (await probeRate()) === 0, 'A second pause did not freeze the page animations again')
  await page.getByRole('button', { name: 'Fast-forward 10 moves', exact: true }).click()
  const ahead = await bar.position()
  await page.getByRole('button', { name: 'Rewind 10 moves', exact: true }).click()
  assert.equal(await bar.position(), ahead - 10, 'Rewind did not go back ten moves')
  assert.equal(await bar.floors(), await expectedFloor(page, ahead - 10), 'Rewind left the run at the wrong state')
  await page.getByRole('button', { name: 'Resume', exact: true }).click()

  // The scrubber seeks to any point, in both directions, and shows the act and floor there.
  await page.mouse.move(...Object.values(await bar.at(0.5)))
  await page.locator('.replay-bar__tip').waitFor()
  const tip = await page.locator('.replay-bar__tip').innerText()
  const [, tipMove] = /Move (\d+)/.exec(tip) ?? []
  const where = await expectedWhere(page, Number(tipMove))
  assert(tip.includes(where), `The scrubber tip "${tip.replace(/\s+/g, ' ')}" does not say ${where}`)
  await page.screenshot({ path: join(output, 'desktop-hover.png') })
  await page.getByRole('button', { name: 'Pause', exact: true }).click()
  await page.mouse.move(...Object.values(await bar.at(0.5)))
  await page.mouse.down()
  await page.mouse.up()
  const middle = await bar.position()
  assert(Math.abs(middle - events / 2) <= 1 + events * 0.01, `Clicking halfway landed on move ${middle} of ${events}`)
  assert.equal(await bar.floors(), await expectedFloor(page, middle), 'The run does not match the move the scrubber landed on')
  const start = await bar.at(0)
  await page.mouse.move(start.x + 2, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x + 200, start.y, { steps: 4 })
  assert.notEqual(await bar.position(), middle, 'The scrubber did not follow the drag')
  assert.equal(await bar.floors(), await expectedFloor(page, middle), 'Dragging seeked before the pointer was released')
  await page.mouse.move((await bar.at(1)).x + 40, start.y, { steps: 4 })
  await page.mouse.up()
  assert.equal(await bar.position(), events, 'Dragging past the end did not land on the last move')
  await page.getByRole('button', { name: 'Replay from the start', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Replay from the start', exact: true }).click()
  await page.getByRole('button', { name: 'Pause', exact: true }).click()
  assert.equal(await bar.floors(), await expectedFloor(page, await bar.position()), 'Replaying from the start did not rewind the run')
  assert(await bar.position() < 15, 'Replaying from the start did not go back to the start')

  // Space, K, J and L drive the bar like a video player (with no control holding the focus).
  await page.evaluate(() => document.activeElement?.blur())
  await page.mouse.move(800, 300)
  const before = await bar.position()
  await page.keyboard.press('Space')
  await page.waitForFunction((value) => Number(document.querySelector('[role="slider"]').getAttribute('aria-valuenow')) > value, before)
  await page.keyboard.press('k')
  const held = await bar.position()
  await page.waitForTimeout(400)
  assert.equal(await bar.position(), held, 'K did not pause the replay')
  await page.keyboard.press('l')
  await until(async () => (await bar.position()) === held + 10, 'L did not fast-forward ten moves')
  await page.keyboard.press('j')
  await until(async () => (await bar.position()) === held, 'J did not rewind ten moves')
  await bar.scrub.focus()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  // The arrow keys preview at once and jump once they settle.
  await until(async () => (await bar.floors()) === (await expectedFloor(page, held + 2)), 'ArrowRight did not jump two moves ahead')
  assert.equal(await bar.position(), held + 2)
  await page.keyboard.press('Home')
  await until(async () => (await bar.position()) === 0 && (await bar.floors()) === 0, 'Home did not jump to the start')
  await page.getByRole('button', { name: 'Resume', exact: true }).click()

  // Speeds change how fast moves play, and the menu offers exactly the promised set.
  await page.getByRole('button', { name: /^Playback speed/ }).click()
  assert.deepEqual(await page.getByRole('menuitemradio').allInnerTexts(), ['0.25×', '0.5×', '1×', '1.25×', '1.5×', '2×'])
  await page.waitForTimeout(350)
  await page.screenshot({ path: join(output, 'desktop-speed-menu.png') })
  await page.keyboard.press('Escape')
  assert.equal(await page.getByRole('menu').count(), 0, 'Escape did not close the speed menu')
  assert.equal(await page.locator('.pause-menu[open]').count(), 0, 'Escape in the speed menu opened the game menu')
  const slow = await secondsPerMove(desktop, '0.25×')
  const fast = await secondsPerMove(desktop, '2×')
  await until(async () => (await probeRate()) === 2, 'Playing at 2× did not speed up the page animations')
  assert(slow > fast * 2, `0.25× (${slow}ms/move) is not clearly slower than 2× (${fast}ms/move)`)
  // Slow and early in the log, so the replay cannot finish while the controls are left idle.
  await page.mouse.click(...Object.values(await bar.at(0.1)))
  await bar.speed('0.25×')

  // The controls tuck away while playing and return with the pointer (a keyboard-focused control keeps them up).
  await page.evaluate(() => document.activeElement?.blur())
  await page.mouse.move(5, 5)
  await page.waitForFunction(() => !document.querySelector('.replay-bar')?.hasAttribute('data-awake'), null, { timeout: 8000 })
  await page.mouse.move(400, 400)
  await page.waitForFunction(() => document.querySelector('.replay-bar')?.hasAttribute('data-awake'))

  // At the end the bar offers a replay and the way back to the menu.
  await bar.speed('2×')
  await page.getByRole('button', { name: 'Replay from the start', exact: true }).waitFor({ timeout: 60_000 })
  await page.getByText('Replay finished', { exact: true }).waitFor()
  await page.waitForTimeout(600)
  await page.screenshot({ path: join(output, 'desktop-finished.png') })
  await page.getByRole('button', { name: 'Leave replay', exact: true }).click()
  await page.getByRole('button', { name: 'Replay', exact: true }).waitFor()
  assert.deepEqual(desktop.errors, [])
  await desktop.context.close()

  // Pausing holds a card play mid-click, jumping abandons it cleanly, and leaving leaves no cursor behind.
  const clicks = await open({ width: 1600, height: 900 }, false, clickLogText)
  const { page: clickPage, bar: clickBar } = clicks
  // Keep the pointer on the bar so it stays up however long the opening moves take.
  await clickPage.mouse.move(...Object.values(await clickBar.at(0.5)))
  // Pause the moment the card appears, from inside the page, so the click that plays it cannot win the race.
  await clickPage.waitForFunction(() => {
    const strike = [...document.querySelectorAll('.hand button')].some((button) => /^Strike,/.test(button.getAttribute('aria-label') ?? button.textContent ?? ''))
    if (!strike) return false
    document.querySelector('.replay-bar [data-action="toggle"]').click()
    return true
  }, null, { polling: 'raf' })
  await clickPage.locator('.replay-bar [data-action="toggle"][aria-label="Resume"]').waitFor()
  const heldMove = await clickBar.position()
  await clickPage.waitForTimeout(1500)
  assert.equal(await clickBar.position(), heldMove, 'A paused card play kept advancing')
  assert.equal(await clickPage.evaluate(() => window.__STS_DEBUG__.getRun().combat?.enemies[0].hp), 40, 'A paused card play still landed')
  // A jump made while paused lands on a screen that finishes drawing its entrance before it freezes.
  await clickPage.locator('.replay-bar').hover()
  await clickPage.keyboard.press('j')
  await until(async () => (await clickBar.position()) === 0, 'J did not jump back to the start')
  await clickPage.waitForTimeout(2_200)
  assert.equal(await clickPage.evaluate(() => document.getAnimations().filter((animation) =>
    animation.playbackRate === 0 && Number.isFinite(Number(animation.effect?.getComputedTiming().iterations)) &&
    (animation.effect?.getComputedTiming().progress ?? 1) < 1).length), 0, 'A paused jump froze the new screen halfway through its entrance')
  // The game's own menu still opens and animates in while the replay is paused.
  await clickPage.keyboard.press('Escape')
  await clickPage.locator('.pause-menu[open]').waitFor()
  // A looping animation inside the menu stands in for its entrance: it must keep real time while the replay is paused.
  await clickPage.locator('.pause-menu').evaluate((menu) => { window.__menuProbe = menu.animate([{ opacity: 1 }, { opacity: 0.99 }], { duration: 600_000, iterations: Infinity }) })
  await clickPage.waitForTimeout(300)
  assert.equal(await clickPage.evaluate(() => window.__menuProbe.playbackRate), 1, 'The pause menu was frozen along with the paused replay')
  // A game dialog never strands the replay: K still pauses and resumes from inside it.
  await clickPage.keyboard.press('k')
  await clickPage.locator('.replay-bar [data-action="toggle"][aria-label="Pause"]').waitFor()
  await clickPage.keyboard.press('k')
  await clickPage.locator('.replay-bar [data-action="toggle"][aria-label="Resume"]').waitFor()
  // A jump made with the game menu open takes the menu down with the screen, and it opens again afterwards.
  await clickPage.keyboard.press('l')
  await until(async () => (await clickPage.locator('.pause-menu[open]').count()) === 0, 'A jump left the game menu stranded')
  await clickPage.keyboard.press('Escape')
  await clickPage.locator('.pause-menu[open]').waitFor()
  await clickPage.locator('.pause-menu').getByRole('button', { name: 'Resume', exact: true }).click()
  await clickPage.locator('.replay-bar [data-action="toggle"][aria-label="Replay from the start"]').click()
  await clickPage.locator('.replay-bar [data-action="toggle"][aria-label="Pause"]').click()
  await clickPage.keyboard.press('Escape')
  await clickPage.locator('.pause-menu[open]').waitFor()
  // The Compendium covers the bar; coming back finds the replay as it was left, still paused.
  const parked = await clickBar.position()
  await clickPage.locator('.pause-menu').getByRole('button', { name: 'Compendium', exact: true }).click()
  await clickPage.locator('.compendium').waitFor()
  assert.equal(await clickPage.locator('.replay-bar').count(), 0, 'The replay bar drew over the Compendium')
  await clickPage.getByRole('button', { name: 'Back to run', exact: true }).click()
  await clickPage.locator('.replay-bar').waitFor()
  await clickPage.locator('.replay-bar [data-action="toggle"][aria-label="Resume"]').waitFor()
  assert.equal(await clickBar.position(), parked, 'Visiting the Compendium moved the replay')
  // Jumping to the end with the keyboard leaves the focus on the scrubber, not on the finished notice.
  await clickPage.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await clickBar.scrub.focus()
  await clickPage.keyboard.press('End')
  await clickPage.getByRole('button', { name: 'Replay from the start', exact: true }).waitFor()
  assert.equal(await clickPage.evaluate(() => document.activeElement?.getAttribute('role')), 'slider', 'Jumping to the end moved the focus off the scrubber')
  await clickPage.getByRole('button', { name: 'Replay from the start', exact: true }).click()
  await clickPage.getByRole('button', { name: 'Pause', exact: true }).click()
  await clickPage.mouse.click(...Object.values(await clickBar.at(1)))
  await clickPage.getByRole('button', { name: 'Replay from the start', exact: true }).waitFor()
  assert.equal(await clickPage.evaluate(() => window.__STS_DEBUG__.getRun().phase), 'defeat', 'Jumping to the end did not show the final state')
  await clickPage.getByRole('button', { name: 'Replay from the start', exact: true }).click()
  await clickPage.getByRole('button', { name: 'Pause', exact: true }).waitFor()
  await clickPage.mouse.click(...Object.values(await clickBar.at(0.5)))
  await clickPage.getByRole('button', { name: 'Leave replay', exact: true }).click()
  await clickPage.getByRole('button', { name: 'Replay', exact: true }).waitFor()
  assert.equal(await clickPage.locator('.run-replay__cursor').count(), 0, 'Leaving after a jump left the replay cursor behind')
  assert.deepEqual(clicks.errors, [])
  await clicks.context.close()

  // The same controls fit a horizontal phone.
  phone = await open({ width: 844, height: 390 }, true)
  // Keep the pointer on the bar so it cannot tuck away before it is measured and used.
  await phone.page.mouse.move(...Object.values(await phone.bar.at(0.5)))
  const fit = await phone.page.evaluate(() => {
    const { left, right, top, bottom } = document.querySelector('.replay-bar').getBoundingClientRect()
    return { left, right, top, bottom, width: innerWidth, height: innerHeight }
  })
  assert(fit.left >= 0 && fit.right <= fit.width && fit.top >= 0 && fit.bottom <= fit.height, `Bar spills off the phone: ${JSON.stringify(fit)}`)
  await phone.page.getByRole('button', { name: 'Pause', exact: true }).click()
  await phone.page.mouse.click(...Object.values(await phone.bar.at(0.75)))
  const seeked = await phone.bar.position()
  assert(Math.abs(seeked - events * 0.75) <= 1 + events * 0.02, `Phone seek landed on ${seeked}`)
  // A jump made while paused leaves the new screen fully drawn, not frozen in its entrance.
  await phone.page.waitForTimeout(2_000)
  assert.deepEqual(await phone.page.evaluate(() => document.getAnimations().filter((animation) =>
    animation.playbackRate === 0 && Number.isFinite(Number(animation.effect?.getComputedTiming().iterations)) &&
    (animation.effect?.getComputedTiming().progress ?? 1) < 1).length), 0, 'A paused jump froze entrance animations halfway')
  await phone.page.getByRole('button', { name: /^Playback speed/ }).click()
  await phone.page.waitForTimeout(350)
  await phone.page.screenshot({ path: join(output, 'phone-speed-menu.png') })
  const menuFit = await phone.page.locator('.replay-bar__menu').boundingBox()
  assert(menuFit.y >= 0 && menuFit.x >= 0 && menuFit.x + menuFit.width <= 844, `Speed menu spills off the phone: ${JSON.stringify(menuFit)}`)
  assert.deepEqual(phone.errors, [])
  await phone.context.close()
} finally {
  await browser.close()
  await server.close()
}
console.log('✓ replay controls: pause, resume, rewind, click and drag scrubbing, keyboard, six speeds, idle hide, desktop and phone fit')
