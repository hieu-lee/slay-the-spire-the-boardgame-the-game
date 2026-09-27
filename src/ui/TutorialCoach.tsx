import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CharacterId } from '../game/types.ts'
import { tutorialChapters, type TutorialMoment } from './tutorial-content.ts'
import './styles/tutorial.css'

type Rect = { top: number; left: number; width: number; height: number }

const RING_PADDING = 6
const PANEL_GAP = 14

function visibleTarget(selector: string | undefined): Rect | null {
  if (!selector) return null
  for (const element of document.querySelectorAll(selector)) {
    if (element.closest('.tutorial-coach')) continue
    const box = element.getBoundingClientRect()
    if (box.width < 2 || box.height < 2) continue
    if (box.bottom < 0 || box.right < 0 || box.top > innerHeight || box.left > innerWidth) continue
    return { top: box.top, left: box.left, width: box.width, height: box.height }
  }
  return null
}

const sameRect = (a: Rect | null, b: Rect | null) => a === b || Boolean(a && b &&
  Math.abs(a.top - b.top) < 1 && Math.abs(a.left - b.left) < 1 &&
  Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1)

/**
 * The guided tutorial's coach: a small non-modal panel that explains each part
 * of the run the first time the player reaches it, with a ring around the part
 * of the screen it is talking about. The run stays fully playable underneath.
 */
export function TutorialCoach({ character, moment, hidden, onHide }: {
  character: CharacterId
  moment: TutorialMoment
  hidden: boolean
  onHide: () => void
}) {
  const chapters = useMemo(() => tutorialChapters(character), [character])
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set())
  const [step, setStep] = useState(0)
  const chapter = hidden ? undefined : chapters.find((candidate) => !seen.has(candidate.id) && candidate.when(moment))
  const current = chapter?.steps[Math.min(step, chapter.steps.length - 1)]
  const [target, setTarget] = useState<Rect | null>(null)
  const [panelSize, setPanelSize] = useState({ width: 0, height: 0 })
  const panel = useRef<HTMLElement>(null)

  // A chapter can vanish for a moment, such as during a start-of-turn choice.
  // Keep its place and restart only when a different chapter takes over.
  const shownChapter = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!chapter || chapter.id === shownChapter.current) return
    shownChapter.current = chapter.id
    setStep(0)
  }, [chapter])

  useEffect(() => {
    if (!current) {
      setTarget(null)
      return undefined
    }
    // Combat animates, hands refan and screens scroll, so follow the target
    // rather than measuring it once.
    const measure = () => setTarget((previous) => {
      const next = visibleTarget(current.target)
      return sameRect(previous, next) ? previous : next
    })
    measure()
    const timer = window.setInterval(measure, 200)
    window.addEventListener('resize', measure)
    return () => {
      clearInterval(timer)
      window.removeEventListener('resize', measure)
    }
  }, [current])

  useLayoutEffect(() => {
    const element = panel.current
    if (!element) return
    const box = element.getBoundingClientRect()
    setPanelSize((previous) => Math.abs(previous.width - box.width) < 1 && Math.abs(previous.height - box.height) < 1
      ? previous : { width: box.width, height: box.height })
  })

  if (!chapter || !current) return null
  const last = step >= chapter.steps.length - 1
  const finishChapter = () => {
    setSeen((previous) => new Set(previous).add(chapter.id))
    setStep(0)
  }

  // Sit on the far side of the target from its centre, so the ring and the
  // text never overlap; without a target, rest near the top of the screen.
  const margin = 8
  let top = Math.max(56, innerHeight * 0.12)
  let left = (innerWidth - panelSize.width) / 2
  if (target) {
    const below = target.top + target.height / 2 < innerHeight / 2
    top = below
      ? target.top + target.height + RING_PADDING + PANEL_GAP
      : target.top - RING_PADDING - PANEL_GAP - panelSize.height
    left = target.left + target.width / 2 - panelSize.width / 2
    // A tall target (the map, the hand on a phone) can leave no room on either
    // side; then overlap its edge rather than leave the screen.
    if (top < margin || top + panelSize.height > innerHeight - margin) top = below
      ? innerHeight - panelSize.height - margin : margin
  }
  left = Math.min(Math.max(margin, left), innerWidth - panelSize.width - margin)
  top = Math.min(Math.max(margin, top), innerHeight - panelSize.height - margin)

  // Portalled to the body: the run shell scales and transforms its board on
  // some screens, which would carry fixed positioning along with it.
  return createPortal(
    <div className="tutorial-coach">
      {target ? <span className="tutorial-coach__ring" aria-hidden="true" style={{
        top: target.top - RING_PADDING,
        left: target.left - RING_PADDING,
        width: target.width + RING_PADDING * 2,
        height: target.height + RING_PADDING * 2,
      }} /> : null}
      <section ref={panel} className="tutorial-coach__panel" role="dialog" aria-modal="false"
        aria-labelledby="tutorial-coach-title" aria-describedby="tutorial-coach-body"
        data-chapter={chapter.id} style={{ top, left }}>
        <header>
          <span className="tutorial-coach__kicker">Tutorial</span>
          {chapter.steps.length > 1 ? <span className="tutorial-coach__count">{step + 1} / {chapter.steps.length}</span> : null}
        </header>
        <h2 id="tutorial-coach-title">{current.title}</h2>
        <p id="tutorial-coach-body" aria-live="polite">{current.body}</p>
        <footer>
          <button type="button" className="tutorial-coach__hide" onClick={onHide}>Hide tips</button>
          {step > 0 ? <button type="button" onClick={() => setStep(step - 1)}>Back</button> : null}
          <button type="button" className="tutorial-coach__next" onClick={() => last ? finishChapter() : setStep(step + 1)}>
            {last ? 'Got it' : 'Next'}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  )
}
