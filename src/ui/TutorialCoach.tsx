import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { RunState } from '../game/run.ts'
import type { Spot, TutorialChapter } from './tutorial/types.ts'
import './styles/tutorial.css'

type Rect = { top: number; left: number; width: number; height: number }

const RING_PADDING = 6
const PANEL_GAP = 14
const MARGIN = 8
const TICK_MS = 150

function visible(element: Element): Rect | null {
  const box = element.getBoundingClientRect()
  if (box.width < 2 || box.height < 2) return null
  if (box.bottom < 0 || box.right < 0 || box.top > innerHeight || box.left > innerWidth) return null
  return { top: box.top, left: box.left, width: box.width, height: box.height }
}

/** Whether the element is clipped by the viewport or by a scrolling box around it. */
function clipped(element: Element): boolean {
  const box = element.getBoundingClientRect()
  if (box.top < 0 || box.left < 0 || box.bottom > innerHeight || box.right > innerWidth) return true
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent)
    if (!/(auto|scroll|hidden)/.test(style.overflowY + style.overflowX)) continue
    const frame = parent.getBoundingClientRect()
    if (box.top < frame.top - 1 || box.bottom > frame.bottom + 1 || box.left < frame.left - 1 || box.right > frame.right + 1) return true
  }
  return false
}

function matches({ css, text }: Spot): Element[] {
  return [...document.querySelectorAll(css)].filter((element) =>
    !element.closest('.tutorial-coach') && (!text || element.textContent?.includes(text)))
}

/**
 * The first on-screen match for each spot; an off-screen match is scrolled to
 * once. An enemy's intent brings its enemy along as context, and a card its
 * hand, so the panel does not cover what it is describing.
 */
function locate(spots: readonly Spot[], scrolled: Set<string>): { rects: Rect[]; context: Rect[]; elements: Element[] } {
  const rects: Rect[] = []
  const context: Rect[] = []
  const elements: Element[] = []
  for (const spot of spots) {
    const found = matches(spot)
    const shown = found.filter((candidate) => visible(candidate))
    if (spot.all && shown.length) {
      const boxes = shown.map((candidate) => visible(candidate)!)
      const top = Math.min(...boxes.map((box) => box.top))
      const left = Math.min(...boxes.map((box) => box.left))
      rects.push({ top, left,
        width: Math.max(...boxes.map((box) => box.left + box.width)) - left,
        height: Math.max(...boxes.map((box) => box.top + box.height)) - top })
      elements.push(...shown)
      continue
    }
    const element = shown[0]
    // A card below the fold of a scrolling picker is technically on screen;
    // bring it fully into view once so the ring and the tap land on it.
    const key = spot.css + spot.text
    if (element && !scrolled.has(key) && clipped(element)) {
      scrolled.add(key)
      element.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
    if (element) {
      rects.push(visible(element)!)
      elements.push(element)
      const owner = element.parentElement?.closest('[data-enemy-id], .hand')
      const around = owner && visible(owner)
      if (around) context.push(around)
    } else if (found[0] && !scrolled.has(spot.css + spot.text)) {
      scrolled.add(spot.css + spot.text)
      found[0].scrollIntoView({ block: 'center', inline: 'center' })
    }
  }
  return { rects, context, elements }
}

const sameRects = (a: readonly Rect[], b: readonly Rect[]) => a.length === b.length && a.every((rect, index) => {
  const other = b[index]!
  return Math.abs(rect.top - other.top) < 1 && Math.abs(rect.left - other.left) < 1 &&
    Math.abs(rect.width - other.width) < 1 && Math.abs(rect.height - other.height) < 1
})

const pad = (rect: Rect): Rect => ({ top: rect.top - RING_PADDING, left: rect.left - RING_PADDING,
  width: rect.width + RING_PADDING * 2, height: rect.height + RING_PADDING * 2 })

const overlap = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left)) *
  Math.max(0, Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top))

/** Places the panel where it covers as little of the ringed spots, then their context, as possible. */
function placePanel(rects: readonly Rect[], context: readonly Rect[], width: number, height: number): { top: number; left: number } {
  const clampLeft = (left: number) => Math.min(Math.max(MARGIN, left), innerWidth - width - MARGIN)
  const clampTop = (top: number) => Math.min(Math.max(MARGIN, top), innerHeight - height - MARGIN)
  const centre = clampLeft((innerWidth - width) / 2)
  if (rects.length === 0) return { top: clampTop(Math.max(56, innerHeight * 0.12)), left: centre }
  const top = Math.min(...rects.map((rect) => rect.top)) - RING_PADDING
  const bottom = Math.max(...rects.map((rect) => rect.top + rect.height)) + RING_PADDING
  const left = Math.min(...rects.map((rect) => rect.left))
  const right = Math.max(...rects.map((rect) => rect.left + rect.width))
  const middle = clampLeft((left + right) / 2 - width / 2)
  const candidates = [
    { top: bottom + PANEL_GAP, left: middle },
    { top: top - PANEL_GAP - height, left: middle },
    { top: MARGIN, left: centre },
    { top: innerHeight - height - MARGIN, left: centre },
    { top: MARGIN, left: MARGIN },
    { top: MARGIN, left: innerWidth - width - MARGIN },
    { top: innerHeight - height - MARGIN, left: MARGIN },
    { top: innerHeight - height - MARGIN, left: innerWidth - width - MARGIN },
  ].map((candidate) => ({ top: clampTop(candidate.top), left: clampLeft(candidate.left) }))
  const padded = rects.map(pad)
  const covered = (candidate: { top: number; left: number }) => {
    const box = { ...candidate, width, height }
    return padded.reduce((sum, rect) => sum + overlap(rect, box) * 10, 0) +
      context.reduce((sum, rect) => sum + overlap(rect, box), 0)
  }
  return candidates.reduce((best, candidate) => covered(candidate) < covered(best) ? candidate : best)
}

/**
 * Overlapping holes would cancel out under the even-odd rule (a Mode button
 * inside the prompt bar), so any that touch are merged into their bounding box.
 */
function mergeHoles(holes: readonly Rect[]): Rect[] {
  const merged = holes.map(pad)
  for (let changed = true; changed;) {
    changed = false
    for (let i = 0; i < merged.length && !changed; i += 1) {
      for (let j = i + 1; j < merged.length && !changed; j += 1) {
        const a = merged[i]!
        const b = merged[j]!
        if (overlap(a, b) === 0) continue
        const top = Math.min(a.top, b.top)
        const left = Math.min(a.left, b.left)
        merged[i] = { top, left, width: Math.max(a.left + a.width, b.left + b.width) - left,
          height: Math.max(a.top + a.height, b.top + b.height) - top }
        merged.splice(j, 1)
        changed = true
      }
    }
  }
  return merged
}

/** A clip path covering the screen except the holes, so only the holes take input. */
function shieldPath(holes: readonly Rect[]): string {
  const outer = `M0 0H${innerWidth}V${innerHeight}H0Z`
  return `path(evenodd, "${outer}${mergeHoles(holes).map((hole) => {
    const top = Math.round(hole.top)
    const left = Math.round(hole.left)
    const width = Math.round(hole.width)
    const height = Math.round(hole.height)
    return `M${left} ${top}h${width}v${height}h${-width}Z`
  }).join('')}")`
}

const modalOpen = () => {
  try {
    return Boolean(document.querySelector('dialog:modal'))
  } catch {
    return Boolean(document.querySelector('dialog[open]'))
  }
}

/**
 * The guided tutorial's coach. It walks the player through the hero's scripted
 * run a chapter at a time. While it speaks, the run underneath is shielded;
 * when it asks for something, only the ringed controls take input, and it moves
 * on by itself once the run shows the task is done. Hiding tips drops the
 * shield and leaves the run fully playable.
 */
export function TutorialCoach({ chapters, run, hidden, onHide }: {
  chapters: readonly TutorialChapter[]
  run: RunState
  hidden: boolean
  onHide: () => void
}) {
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set())
  const [progress, setProgress] = useState<Readonly<Record<string, number>>>({})
  const [rects, setRects] = useState<Rect[]>([])
  const [context, setContext] = useState<Rect[]>([])
  const [prompts, setPrompts] = useState<Rect[]>([])
  const [measuredKey, setMeasuredKey] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [panelSize, setPanelSize] = useState({ width: 0, height: 0 })
  const panel = useRef<HTMLElement>(null)
  const holeElements = useRef<Element[]>([])
  const scrolled = useRef(new Set<string>())
  const runRef = useRef(run)
  runRef.current = run

  const chapter = chapters.find((candidate) => !seen.has(candidate.id) && candidate.when(run))
  const stepIndex = chapter ? Math.min(progress[chapter.id] ?? 0, chapter.steps.length - 1) : 0
  const step = chapter?.steps[stepIndex]
  const task = Boolean(step?.done)

  // A task finishes by changing the run, which can also end its chapter's
  // moment, so the last step shown is remembered and finished even when a
  // different chapter has taken over.
  const shown = useRef<{ id: string; step: number } | null>(null)
  if (chapter) shown.current = { id: chapter.id, step: stepIndex }
  const advance = (id: string, from: number) => {
    const owner = chapters.find((candidate) => candidate.id === id)
    if (!owner) return
    if (from + 1 >= owner.steps.length) setSeen((previous) => previous.has(id) ? previous : new Set(previous).add(id))
    setProgress((previous) => (previous[id] ?? 0) !== from ? previous : { ...previous, [id]: from + 1 })
  }
  const finishTask = () => {
    const last = shown.current
    const owner = last && chapters.find((candidate) => candidate.id === last.id)
    const lastStep = owner?.steps[last!.step]
    if (last && lastStep?.done?.(runRef.current)) advance(last.id, last.step)
  }
  useEffect(finishTask)

  useEffect(() => {
    scrolled.current.clear()
    if (!step || hidden) {
      setMeasuredKey('')
      setRects([])
      setContext([])
      setPrompts([])
      holeElements.current = []
      return undefined
    }
    // Combat animates, hands refan and screens scroll, so follow the spots
    // rather than measuring them once. Some tasks (opening the shop) change
    // only the screen, so they are rechecked here too.
    const measure = () => {
      finishTask()
      setDialogOpen(modalOpen())
      const found = locate(step.focus ?? [], scrolled.current)
      // A move can ask a follow-up question in the prompt bar (which Mode,
      // which Slime, Load it or not). A task always lets that bar answer, so
      // an unplanned question can never trap the player behind the shield.
      const bar = step.done ? [...document.querySelectorAll('.prompt')].filter((element) => visible(element)) : []
      holeElements.current = [...found.elements, ...bar]
      const barRects = bar.map((element) => visible(element)!)
      setPrompts((previous) => sameRects(previous, barRects) ? previous : barRects)
      setRects((previous) => sameRects(previous, found.rects) ? previous : found.rects)
      setContext((previous) => sameRects(previous, found.context) ? previous : found.context)
      setMeasuredKey(`${chapter!.id}#${stepIndex}`)
    }
    measure()
    const timer = window.setInterval(measure, TICK_MS)
    window.addEventListener('resize', measure)
    return () => {
      clearInterval(timer)
      window.removeEventListener('resize', measure)
    }
  }, [step, hidden])

  useLayoutEffect(() => {
    const element = panel.current
    if (!element) return
    const box = element.getBoundingClientRect()
    setPanelSize((previous) => Math.abs(previous.width - box.width) < 1 && Math.abs(previous.height - box.height) < 1
      ? previous : { width: box.width, height: box.height })
  })

  const showing = Boolean(chapter && step && !hidden && !dialogOpen)
  const measured = measuredKey === `${chapter?.id}#${stepIndex}`
  const activeRects = measured ? rects : []
  // A task whose controls cannot be found must not trap the player.
  const shielded = showing && (!task || !measured || activeRects.length > 0)
  useEffect(() => {
    if (!shielded) return undefined
    const block = (event: KeyboardEvent) => {
      const target = event.target instanceof Node ? event.target : null
      if (event.key === 'Escape' || target && panel.current?.contains(target)) return
      if (task && target && holeElements.current.some((element) => element.contains(target))) return
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener('keydown', block, true)
    return () => window.removeEventListener('keydown', block, true)
  }, [shielded, task])

  if (!showing || !chapter || !step) return null
  const last = stepIndex >= chapter.steps.length - 1
  const canGoBack = stepIndex > 0 && !chapter.steps[stepIndex - 1]!.done
  const { top, left } = placePanel(activeRects, measured ? context : [], panelSize.width, panelSize.height)

  // Portalled to the body: the run shell scales and transforms its board on
  // some screens, which would carry fixed positioning along with it.
  return createPortal(
    <div className="tutorial-coach" data-measured={measured ? measuredKey : undefined}>
      {activeRects.length ? <div className="tutorial-coach__dim" aria-hidden="true" style={{ clipPath: shieldPath(activeRects) }} /> : null}
      {shielded ? <div className="tutorial-coach__shield" aria-hidden="true"
        style={{ clipPath: shieldPath(task && measured ? [...activeRects, ...prompts] : []) }} /> : null}
      {activeRects.map((rect, index) => <span key={index} className="tutorial-coach__ring" aria-hidden="true" style={{
        top: rect.top - RING_PADDING,
        left: rect.left - RING_PADDING,
        width: rect.width + RING_PADDING * 2,
        height: rect.height + RING_PADDING * 2,
      }} />)}
      <section ref={panel} className={`tutorial-coach__panel${task ? ' tutorial-coach__panel--task' : ''}`}
        role="dialog" aria-modal="false" aria-labelledby="tutorial-coach-title" aria-describedby="tutorial-coach-body"
        data-chapter={chapter.id} data-step={stepIndex} style={{ top, left }}>
        <header>
          <span className="tutorial-coach__kicker">{task ? 'Your move' : 'Tutorial'}</span>
          {chapter.steps.length > 1 ? <span className="tutorial-coach__count">{stepIndex + 1} / {chapter.steps.length}</span> : null}
        </header>
        <h2 id="tutorial-coach-title">{step.title}</h2>
        <p id="tutorial-coach-body" aria-live="polite">{step.body}</p>
        <footer>
          <button type="button" className="tutorial-coach__hide" onClick={onHide}>Hide tips</button>
          {canGoBack ? <button type="button" onClick={() => setProgress((previous) => ({ ...previous, [chapter.id]: stepIndex - 1 }))}>Back</button> : null}
          {!task ? <button type="button" className="tutorial-coach__next" onClick={() => advance(chapter.id, stepIndex)}>
            {last ? 'Got it' : 'Next'}
          </button> : null}
        </footer>
      </section>
    </div>,
    document.body,
  )
}
