import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { REPLAY_JUMP, REPLAY_SPEEDS, type ReplaySession } from './run-replay.ts'
import './styles/replay-bar.css'

const IDLE_MS = 3_000
const KEY_COMMIT_MS = 250
const GLYPH = { width: 20, height: 20, viewBox: '0 0 20 20', 'aria-hidden': true, focusable: false } as const

const Play = () => <svg {...GLYPH}><path d="M6 3.6v12.8a.6.6 0 0 0 .92.5l10-6.4a.6.6 0 0 0 0-1l-10-6.4A.6.6 0 0 0 6 3.6Z" fill="currentColor" /></svg>
const Pause = () => <svg {...GLYPH}><rect x="4.5" y="3.5" width="3.8" height="13" rx="1" fill="currentColor" /><rect x="11.7" y="3.5" width="3.8" height="13" rx="1" fill="currentColor" /></svg>
const Restart = () => <svg {...GLYPH}><path d="M4.2 10a5.8 5.8 0 1 0 1.9-4.3M4 3.2v3.5h3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
const Rewind = () => <svg {...GLYPH}><path d="M10.4 4.6 4.2 10l6.2 5.4V4.6ZM17 4.6 10.8 10l6.2 5.4V4.6Z" fill="currentColor" strokeLinejoin="round" stroke="currentColor" strokeWidth="1" /></svg>
const Forward = () => <svg {...GLYPH}><path d="m9.6 4.6 6.2 5.4-6.2 5.4V4.6ZM3 4.6 9.2 10 3 15.4V4.6Z" fill="currentColor" strokeLinejoin="round" stroke="currentColor" strokeWidth="1" /></svg>
const Close = () => <svg {...GLYPH}><path d="m5 5 10 10M15 5 5 15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>

const speedLabel = (speed: number) => `${speed}×`

function IconButton({ label, onClick, children, ...rest }: { label: string; onClick: () => void; children: ReactNode; disabled?: boolean; 'data-action'?: string }) {
  return <button type="button" className="replay-bar__button" aria-label={label} title={label} onClick={onClick} {...rest}>{children}</button>
}

export function ReplayBar({ session, onSeek, onExit }: {
  session: ReplaySession
  /** Jump to this many moves into the run and keep playing from there. */
  onSeek: (position: number) => void
  onExit: () => void
}) {
  const { position, total, speed, paused, finished, indexed } = useSyncExternalStore(session.subscribe, session.getSnapshot)
  const bar = useRef<HTMLElement>(null)
  const scrub = useRef<HTMLDivElement>(null)
  const speedButton = useRef<HTMLButtonElement>(null)
  const commit = useRef<number | undefined>(undefined)
  const drag = useRef<number | null>(null)
  const touched = useRef(false)
  // Seeking is a fresh closure on every App render; the shortcuts below should not re-register for it.
  const seek = useRef(onSeek)
  seek.current = onSeek
  // Where the pointer or keyboard is about to seek to; the replay itself only moves on release.
  const [preview, setPreview] = useState<number | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [awake, setAwake] = useState(true)
  // Bumped by a shortcut, which the idle listeners never see, so the bar returns for another few seconds.
  const [nudge, setNudge] = useState(0)
  const shown = preview ?? position
  const where = (at: number) => {
    if (at >= indexed) return null
    const act = session.timeline.acts[at]!
    const floor = session.timeline.floors[at]!
    return floor > 0 ? `Act ${act} · Floor ${floor}` : `Act ${act}`
  }

  // Landing where the replay already is would only restart the move in progress.
  const seekTo = useCallback((to: number) => {
    if (to !== session.position || session.finished) seek.current(to)
  }, [session])
  const toggle = useCallback(() => {
    if (finished) { session.update({ paused: false }); seek.current(0) } else session.update({ paused: !session.paused })
  }, [finished, session])
  const jump = useCallback((delta: number) => {
    const to = Math.min(Math.max(session.position + delta, 0), session.timeline.total)
    if (to !== session.position) seekTo(to)
  }, [seekTo, session])

  // Like a video player, the controls step aside while the replay plays and return when the pointer or keys move.
  const stayAwake = paused || dragging || menuOpen || preview !== null || finished
  useEffect(() => {
    setAwake(true)
    if (stayAwake) return
    let timer = window.setTimeout(() => setAwake(false), IDLE_MS)
    const wake = () => {
      setAwake(true)
      clearTimeout(timer)
      timer = window.setTimeout(() => setAwake(false), IDLE_MS)
    }
    // A tap leaves :hover stuck on the bar, so only a mouse pointer over it keeps it up.
    const hold = () => bar.current?.matches(touched.current ? ':has(:focus-visible)' : ':hover, :has(:focus-visible)')
    const events = ['pointermove', 'pointerdown', 'keydown', 'touchstart'] as const
    for (const type of events) window.addEventListener(type, wake, true)
    const watch = window.setInterval(() => { if (hold()) wake() }, 500)
    return () => {
      clearTimeout(timer)
      clearInterval(watch)
      for (const type of events) window.removeEventListener(type, wake, true)
    }
  }, [stayAwake, nudge])

  useEffect(() => () => clearTimeout(commit.current), [])

  // Which kind of pointer was used last, even while the bar is being held up.
  useEffect(() => {
    const touch = (event: Event) => { touched.current = event.type === 'touchstart' || (event as PointerEvent).pointerType === 'touch' }
    const types = ['pointermove', 'pointerdown', 'touchstart']
    for (const type of types) window.addEventListener(type, touch, true)
    return () => { for (const type of types) window.removeEventListener(type, touch, true) }
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null
      if (event.repeat || event.altKey || event.ctrlKey || event.metaKey || target?.closest('input, textarea, select, .compendium, [role="menu"]')) return
      const key = event.key.toLowerCase()
      // A focused control keeps its own Space (the replay guard already blocks gameplay controls).
      if ((key === ' ' || key === 'k') && !(key === ' ' && target?.closest('button, summary, [role="button"]'))) toggle()
      else if (key === 'j' || key === 'l') {
        // A jump still pending from the scrubber's arrow keys is now stale.
        clearTimeout(commit.current)
        setPreview(null)
        jump(key === 'j' ? -REPLAY_JUMP : REPLAY_JUMP)
      } else return
      event.preventDefault()
      event.stopImmediatePropagation()
      setNudge((count) => count + 1)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [jump, toggle])

  const positionAt = (event: { clientX: number }) => {
    const box = scrub.current!.getBoundingClientRect()
    return Math.round(Math.min(Math.max((event.clientX - box.left) / box.width || 0, 0), 1) * total)
  }
  const onPointerDown = (event: ReactPointerEvent) => {
    if (event.button !== 0 || drag.current !== null) return
    drag.current = event.pointerId
    event.currentTarget.setPointerCapture(event.pointerId)
    scrub.current!.focus({ preventScroll: true })
    clearTimeout(commit.current)
    setDragging(true)
    setPreview(positionAt(event))
  }
  const onPointerMove = (event: ReactPointerEvent) => {
    const at = positionAt(event)
    setHover(at)
    if (drag.current === event.pointerId) setPreview(at)
  }
  const finish = (event: ReactPointerEvent, apply: boolean) => {
    if (drag.current !== event.pointerId) return
    drag.current = null
    clearTimeout(commit.current)
    setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (apply) seekTo(positionAt(event))
    setPreview(null)
  }
  const onScrubKey = (event: ReactKeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    const step = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -REPLAY_JUMP, PageUp: REPLAY_JUMP }[event.key]
    const to = step !== undefined ? Math.min(Math.max(shown + step, 0), total)
      : event.key === 'Home' ? 0 : event.key === 'End' ? total : null
    if (to === null) return
    event.preventDefault()
    setPreview(to)
    clearTimeout(commit.current)
    commit.current = window.setTimeout(() => { setPreview(null); seekTo(to) }, KEY_COMMIT_MS)
  }

  const pick = (next: number) => {
    session.update({ speed: next })
    setMenuOpen(false)
    speedButton.current?.focus()
  }
  useEffect(() => {
    if (!menuOpen) return
    bar.current?.querySelector<HTMLElement>('.replay-bar__menu [aria-checked="true"]')?.focus()
    const close = (event: Event) => {
      if (event.target instanceof Node && !bar.current?.querySelector('.replay-bar__speed')?.contains(event.target)) setMenuOpen(false)
    }
    window.addEventListener('pointerdown', close, true)
    return () => window.removeEventListener('pointerdown', close, true)
  }, [menuOpen])
  const onMenuKey = (event: ReactKeyboardEvent) => {
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
    const current = items.indexOf(document.activeElement as HTMLElement)
    const next = event.key === 'ArrowUp' ? current - 1 : event.key === 'ArrowDown' ? current + 1
      : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : null
    if (next === null) return
    event.preventDefault()
    items[(next + items.length) % items.length]?.focus()
  }

  const acts = useMemo(() => {
    const marks: number[] = []
    for (let at = 1; at < indexed; at += 1) if (session.timeline.acts[at] !== session.timeline.acts[at - 1]) marks.push(at)
    return marks
  }, [indexed, session])
  const percent = (at: number) => total > 0 ? `${(at / total) * 100}%` : '0%'
  const tip = dragging ? shown : hover
  const description = (at: number) => `Move ${at} of ${total}${where(at) ? `, ${where(at)}` : ''}`

  return <>
    <div className="replay-line" aria-hidden="true" data-run-log-control data-visible={!awake || undefined}>
      <span style={{ width: percent(position) }} />
    </div>
    <section ref={bar} className="replay-bar" aria-label="Replay controls" data-run-log-control data-awake={awake || undefined}
      data-paused={paused || undefined} data-finished={finished || undefined}>
      <div ref={scrub} className="replay-bar__scrub" role="slider" tabIndex={0} aria-label="Replay position"
        aria-valuemin={0} aria-valuemax={total} aria-valuenow={shown} aria-valuetext={description(shown)}
        data-dragging={dragging || undefined}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={(event) => finish(event, true)}
        onPointerCancel={(event) => finish(event, false)} onPointerLeave={() => setHover(null)} onKeyDown={onScrubKey}>
        <span className="replay-bar__track">
          <span className="replay-bar__played" style={{ width: percent(shown) }} />
          {acts.map((at) => <span key={at} className="replay-bar__act" style={{ left: percent(at) }} />)}
        </span>
        <span className="replay-bar__thumb" style={{ left: percent(shown) }} />
        {tip !== null ? <span className="replay-bar__tip" style={{ '--tip': percent(tip) } as CSSProperties} aria-hidden="true">
          <b>Move {tip}</b>{where(tip) ? <i>{where(tip)}</i> : null}
        </span> : null}
      </div>
      <div className="replay-bar__row">
        <IconButton label={`Rewind ${REPLAY_JUMP} moves`} onClick={() => jump(-REPLAY_JUMP)} disabled={position === 0}><Rewind /></IconButton>
        <IconButton label={finished ? 'Replay from the start' : paused ? 'Resume' : 'Pause'} onClick={toggle} data-action="toggle">
          {finished ? <Restart /> : paused ? <Play /> : <Pause />}
        </IconButton>
        <IconButton label={`Fast-forward ${REPLAY_JUMP} moves`} onClick={() => jump(REPLAY_JUMP)} disabled={position === total}><Forward /></IconButton>
        <span className="replay-bar__time" aria-hidden="true"><b>{shown}</b><span>/ {total}</span></span>
        <span className="replay-bar__where" aria-hidden="true">{where(shown)}</span>
        <div className="replay-bar__speed" onKeyDown={(event) => {
          if (event.key !== 'Escape' || !menuOpen) return
          event.preventDefault()
          event.stopPropagation()
          setMenuOpen(false)
          speedButton.current?.focus()
        }}>
          <button ref={speedButton} type="button" className="replay-bar__button replay-bar__button--speed" aria-haspopup="menu"
            aria-expanded={menuOpen} aria-label={`Playback speed ${speedLabel(speed)}`} title="Playback speed" onClick={() => setMenuOpen((open) => !open)}>
            {speedLabel(speed)}
          </button>
          {menuOpen ? <div className="replay-bar__menu" role="menu" aria-label="Playback speed" onKeyDown={onMenuKey}
            onBlur={(event) => { if (event.relatedTarget && !event.currentTarget.parentElement?.contains(event.relatedTarget as Node)) setMenuOpen(false) }}>
            {REPLAY_SPEEDS.map((option) => <button key={option} type="button" role="menuitemradio" aria-checked={option === speed}
              onClick={() => pick(option)}>{speedLabel(option)}</button>)}
          </div> : null}
        </div>
        <IconButton label="Leave replay" onClick={onExit}><Close /></IconButton>
      </div>
    </section>
  </>
}
