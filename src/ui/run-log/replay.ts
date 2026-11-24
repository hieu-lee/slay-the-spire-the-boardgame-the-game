import { assetPath } from '../../game/assets.ts'
import type { RunState } from '../../game/run.ts'
import {
  applyRunLogEvent,
  runLogEventChoice,
  semanticDeckMutation,
  type ControlRef,
  type Point,
  type RunLog,
} from './validate.ts'

export const CONTROL = 'button, input, select, textarea, summary, [role="button"]'
export const INSPECTION = '.map-peek, .map-peek__open, .card-collection, .compendium, .deck-peek__open, .game-settings, .settings-dialog, [data-pile], .pause-menu, .room:not(.room--reachable)'
const OPEN_INSPECTION = '.settings-dialog[open], .map-peek[open], .card-collection[open], .compendium, .replay-bar__menu'
const REPLAY_CURSOR_MS = 150
const REPLAY_STEP_CURSOR_MS = 100
const REPLAY_SETTLE_MS = 15_000
const REPLAY_CONTROL_WAIT_MS = 5_000
const REPLAY_STEP_MS = 250
const REPLAY_ENTRANCE_MS = 1_500
const REPLAY_ACTION_HOLD_MS = 1_000
const REPLAY_TICK_MS = 40
const QUICK_STEP = (ref: ControlRef) => Boolean(ref.target) || /\bOrb \d+$|^(?:Resolve|Move)\b/.test(ref.name ?? '')

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

export function controlName(element: HTMLElement) {
  const name = element.getAttribute('aria-label')?.trim() || element.textContent?.trim()
  return element.hasAttribute('data-room') ? name?.replace(/, Activate again to enter$/, '') : name
}

export function controlRef(element: HTMLElement): ControlRef {
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

export function replayableControl(element: HTMLElement) {
  return element.matches(CONTROL) && !element.closest('[data-run-log-control], .settings-dialog, ' + INSPECTION)
}

export function gameplayControl(target: EventTarget | null): HTMLElement | null {
  const element = target instanceof Element ? target.closest<HTMLElement>(CONTROL) : null
  return element && replayableControl(element) ? element : null
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
    if (matches.some((element) => element.matches(CONTROL) && !replayableControl(element) && visible(element, false))) return null
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

/** Live playback controls, read on every tick so speed and pause changes apply mid-action. */
export type ReplayPace = { speed: number; paused: boolean }
type Pace = { signal: AbortSignal; live: ReplayPace; clock: number }

function sleep(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const timer = window.setTimeout(done, milliseconds)
    function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
    signal.addEventListener('abort', done, { once: true })
  })
}

// Replay time runs at the chosen speed and stands still while paused; `clock` counts the replay time spent waiting.
async function delay(milliseconds: number, pace: Pace) {
  let left = milliseconds
  do {
    const started = performance.now()
    await sleep(Math.min(Math.max(left, 0) / pace.live.speed, REPLAY_TICK_MS), pace.signal)
    if (!pace.live.paused) {
      const elapsed = (performance.now() - started) * pace.live.speed
      pace.clock += elapsed
      left -= elapsed
    }
  } while (left > 0 && !pace.signal.aborted)
  while (pace.live.paused && !pace.signal.aborted) await sleep(REPLAY_TICK_MS, pace.signal)
}

function skippedClick(ref: ControlRef) {
  console.warn(`Replay skipped a click: ${ref.name ?? ref.selector} did not appear.`)
}

const paused = (doc: Document) => doc.querySelector('.pause-menu[open], .settings-dialog[open], .map-peek[open], .card-collection[open], .compendium')

async function waitForControl(doc: Document, ref: ControlRef, pace: Pace) {
  let waited = 0
  let control = queryRunLogControl(doc, ref)
  while (!control && !pace.signal.aborted && waited < REPLAY_CONTROL_WAIT_MS) {
    await delay(50, pace)
    // Time spent paused or inspecting does not count against a control that is still to appear.
    // Fast replays still wait at least 5s of real time, since the game's own timers do not speed up;
    // slow replays wait longer, since the animations that reveal the control slow down with them.
    if (!paused(doc) && !pace.live.paused) waited += 50 / Math.max(1, pace.live.speed)
    control = queryRunLogControl(doc, ref)
  }
  return control
}

async function waitForPause(doc: Document, pace: Pace) {
  while (!pace.signal.aborted && (paused(doc) || pace.live.paused)) {
    const started = performance.now()
    await sleep(REPLAY_TICK_MS, pace.signal)
    // Time spent inspecting the game still counts as time since the last action; time paused does not.
    if (!pace.live.paused) pace.clock += (performance.now() - started) * pace.live.speed
  }
}

// Keyframed effects tell the story and are worth waiting for; CSS transitions only ease
// layout and hover states, and a dying enemy's row would otherwise hold the replay for seconds.
const pacingAnimation = (animation: Animation) => animation.playState === 'running' &&
  !(animation instanceof CSSTransition) && Number.isFinite(Number(animation.effect?.getComputedTiming().iterations))

async function settle(doc: Document, pace: Pace) {
  // Effects play at the replay speed, so a slowed replay is given proportionally longer to see them out.
  let until = performance.now() + REPLAY_SETTLE_MS / Math.min(1, pace.live.speed)
  do {
    const started = performance.now()
    const clock = pace.clock
    await delay(50, pace)
    // Time spent paused does not count against the wait for effects to finish.
    until += Math.max(0, performance.now() - started - (pace.clock - clock) / pace.live.speed)
    const active = doc.getAnimations().some(pacingAnimation)
    if (!active && !doc.querySelector('[data-webmcp-pending="true"], .character-attack, .card-flight')) return
  } while (!pace.signal.aborted && performance.now() < until)
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
    if (element?.closest(INSPECTION + ', [data-run-log-control]')) return
    if (event instanceof KeyboardEvent && !['Enter', ' '].includes(event.key)) return
    if (!element?.closest(CONTROL) && event.type !== 'submit') return
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  for (const type of ['pointerdown', 'click', 'change', 'submit', 'keydown']) doc.addEventListener(type, block, true)
  return () => { for (const type of ['pointerdown', 'click', 'change', 'submit', 'keydown']) doc.removeEventListener(type, block, true) }
}

// The replay's own controls keep real time so they stay responsive while the scene is slowed or frozen.
// Dialogs the viewer opens while paused would otherwise freeze at the start of their entrance.
const isReplayChrome = (animation: Animation) => {
  const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null
  return Boolean(target?.closest('.replay-bar, .replay-line, .run-replay__banner, dialog[open], .compendium'))
}

// The animation rate that keeps the page's own effects in step with the replay clock.
const paceRate = (live: ReplayPace) => live.paused ? 0 : live.speed

async function moveCursor(cursor: HTMLElement, to: Point, pressed: boolean, reducedMotion: boolean, pace: Pace, duration = REPLAY_CURSOR_MS) {
  cursor.toggleAttribute('data-pressed', pressed)
  const position = { left: `${to.x * 100}%`, top: `${to.y * 100}%` }
  const animation = cursor.animate(position, {
    duration: reducedMotion ? 0 : duration, easing: 'ease-in-out', fill: 'forwards',
  })
  animation.updatePlaybackRate(paceRate(pace.live))
  // The losing timer must not count toward the replay clock, so it runs on a clock of its own.
  await Promise.race([animation.finished.catch(() => {}), delay(duration, { ...pace, clock: 0 })])
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
  /** Live speed and pause controls; without them the replay plays at normal speed and cannot be paused. */
  pace?: ReplayPace
  /** Resume from this many events already applied, with the run state they produce. */
  start?: { position: number; state: RunState }
  /** Called with the number of events applied whenever playback reaches an event boundary. */
  onPosition?: (position: number) => void
}) {
  const doc = options.document ?? document
  const pace: Pace = { signal: options.signal, live: options.pace ?? { speed: 1, paused: false }, clock: 0 }
  const cursor = doc.createElement('div')
  cursor.className = 'run-replay__cursor'
  cursor.dataset.runLogControl = ''
  cursor.setAttribute('aria-hidden', 'true')
  cursor.style.backgroundImage = `url("${assetPath('ui/cursor.png')}")`
  doc.body.append(cursor)
  const removeGuard = installReplayGuard(doc, options.pause)
  // Keyframed effects, transitions and the cursor all follow the replay clock: scaled by speed, frozen while paused.
  let retimed = false
  const restore = () => {
    retimed = false
    for (const animation of doc.getAnimations()) if (animation.playbackRate !== 1) animation.updatePlaybackRate(1)
  }
  // What a screen starts while the replay is paused (a jump lands on a new one) plays its entrance before it
  // freezes, so nothing is left half drawn. Whatever was already playing when the pause began freezes at once,
  // and hover transitions are the viewer's own and keep real time.
  let predating = new WeakSet<Animation>()
  let firstSeen = new WeakMap<Animation, number>()
  // A run that starts paused (after a jump) has nothing that predates its pause: its whole screen is new.
  let wasPaused = pace.live.paused
  const retime = () => {
    const now = performance.now()
    const isPaused = pace.live.paused
    if (isPaused && !wasPaused) for (const animation of doc.getAnimations()) predating.add(animation)
    if (!isPaused && wasPaused) { predating = new WeakSet(); firstSeen = new WeakMap() }
    wasPaused = isPaused
    // The game removes its own effects on real-time timers, so a slowed replay leaves them at normal speed
    // instead of cutting them short; only the cursor and the replay's own pauses stretch.
    const rate = isPaused ? 0 : Math.max(1, pace.live.speed)
    const cursorRate = paceRate(pace.live)
    if (rate === 1 && cursorRate === 1) return retimed ? restore() : undefined
    retimed = true
    for (const animation of doc.getAnimations()) {
      if (animation.effect instanceof KeyframeEffect && animation.effect.target === cursor) {
        if (animation.playbackRate !== cursorRate) animation.updatePlaybackRate(cursorRate)
        continue
      }
      if (animation instanceof CSSTransition || isReplayChrome(animation)) continue
      if (isPaused && !predating.has(animation) && !firstSeen.has(animation)) firstSeen.set(animation, now)
      const entering = isPaused && !predating.has(animation) && now - firstSeen.get(animation)! < REPLAY_ENTRANCE_MS
      const target = entering ? 1 : rate
      if (animation.playbackRate !== target) animation.updatePlaybackRate(target)
    }
  }
  const retimer = window.setInterval(retime, 30)
  const stopRetiming = () => {
    clearInterval(retimer)
    if (retimed) restore()
  }
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    stopRetiming()
    removeGuard()
    cursor.remove()
  }
  options.signal.addEventListener('abort', cleanup, { once: true })
  const first = options.start?.position ?? 0
  let state = structuredClone(options.start?.state ?? log.initial)
  let lastClick: Point | null = null
  let lastAction = -Infinity
  options.setRun(state)
  options.setViewer(log.events[Math.min(first, log.events.length - 1)]?.viewerId ?? state.players[0]!.id)
  options.onPosition?.(first)
  try {
    if (first < log.events.length) await delay(100, pace)
    for (const [position, logged] of log.events.entries()) {
      if (position < first) continue
      if (options.signal.aborted) break
      await waitForPause(doc, pace)
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
        // In a fight, the Orb, target and turn-resolution steps after a recorded choice's first click are one
        // start-of-turn decision and run together; card picks, and every step out of combat, stay readable.
        const quickStep = (index: number) => Boolean(state.combat) && index > choiceIndex && QUICK_STEP(refs[index]!.ref)
        for (const [index, item] of refs.entries()) {
          if (options.signal.aborted) break
          const source = item.element ?? await waitForControl(doc, item.ref, pace)
          if (options.signal.aborted) break
          // The patch, not the click, is the record: a stale or unmatched click is skipped, never fatal.
          if (!source) {
            skippedClick(item.ref)
            break
          }
          const from = point(source)
          const samePlace = Boolean(lastClick && Math.hypot(lastClick.x - from.x, lastClick.y - from.y) < .001)
          const followUp = quickStep(index)
          const hold = samePlace ? REPLAY_STEP_MS : followUp ? 0 : REPLAY_ACTION_HOLD_MS
          await delay(Math.max(0, hold - (pace.clock - lastAction)), pace)
          if (options.signal.aborted) break
          await moveCursor(cursor, from, true, options.reducedMotion, pace, followUp ? REPLAY_STEP_CURSOR_MS : REPLAY_CURSOR_MS)
          if (options.signal.aborted) break
          const recordedDeckCommit = semanticDeckMutation(event) && index === refs.length - 1 && /^Confirm\b/.test(item.ref.name ?? '')
          const last = index === refs.length - 1
          // An Orb dropped onto Loop resolves when clicked; reach its card before that click removes it.
          const drop = last && choice.target && source.matches('[data-orb-slot]')
            ? queryRunLogControl(doc, choice.target) : null
          const orbDrop = drop?.matches('.end-turn-effect--card') ? drop : null
          if (orbDrop) await moveCursor(cursor, point(orbDrop), true, options.reducedMotion, pace)
          await waitForPause(doc, pace)
          if (options.signal.aborted) break
          if (!recordedDeckCommit) await activateControl(source, item.ref)
          if (options.signal.aborted) break
          // Some targets, such as a Defect's Orbs, only become choosable once their card is picked up.
          const target = last && choice.target && !orbDrop ? await waitForControl(doc, choice.target, pace) : null
          if (options.signal.aborted) break
          if (last && choice.target && !orbDrop && !target) skippedClick(choice.target)
          if (target && choice.target) {
            await moveCursor(cursor, point(target), true, options.reducedMotion, pace)
            if (options.signal.aborted) break
            await waitForPause(doc, pace)
            if (options.signal.aborted) break
            await activateControl(target, choice.target)
            if (options.signal.aborted) break
          }
          cursor.removeAttribute('data-pressed')
          lastClick = target || orbDrop ? null : from
          lastAction = pace.clock
          // A quick step plays on into the next one; everything else waits for its effects.
          if (last || !quickStep(index + 1)) await settle(doc, pace)
        }
      }
      if (options.signal.aborted) break
      state = applyRunLogEvent(state, event)
      options.setRun(state)
      options.onPosition?.(position + 1)
      await settle(doc, pace)
    }
    // Jumping straight to the end has no last move to linger on.
    if (!options.signal.aborted && first < log.events.length) await delay(1_500, pace)
    // The final screen stays guarded, but nothing is being clicked any more.
    cursor.remove()
    stopRetiming()
  } catch (error) {
    cursor.remove()
    stopRetiming()
    throw error
  } finally {
    if (options.signal.aborted) cleanup()
  }
  return () => {
    options.signal.removeEventListener('abort', cleanup)
    cleanup()
  }
}
