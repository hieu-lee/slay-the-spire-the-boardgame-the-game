import type { RunState } from '../game/run.ts'
import { applyRunLogEvent, runLogEventChoice, type ReplayPace, type RunLog } from './run-log.ts'

export const REPLAY_SPEEDS = [0.25, 0.5, 1, 1.25, 1.5, 2] as const
/** Moves skipped by the rewind and fast-forward buttons. */
export const REPLAY_JUMP = 10
const MAX_CHECKPOINTS = 48
const INDEX_SLICE_MS = 6
const INDEX_GAP_MS = 12

/**
 * The run state after every prefix of a run log, so a replay can jump to any move.
 * Position `n` is the state once `n` moves have been applied: 0 is the start, `total` the end.
 * States are kept at regular checkpoints and rebuilt from the nearest one; a background pass
 * indexes the whole log so the act and floor of every position are known.
 */
export class ReplayTimeline {
  readonly total: number
  /** The act and floor cleared at each position; meaningful up to `indexed`. */
  readonly acts: Uint8Array
  readonly floors: Uint16Array
  private readonly interval: number
  private readonly checkpoints = new Map<number, RunState>()
  private state: RunState
  private frontier = 0
  private timer: number | undefined
  private failed = false
  private readonly log: RunLog
  private readonly onIndexed?: () => void

  constructor(log: RunLog, onIndexed?: () => void) {
    this.log = log
    this.onIndexed = onIndexed
    this.total = log.events.length
    this.interval = Math.max(4, Math.ceil(this.total / MAX_CHECKPOINTS))
    this.acts = new Uint8Array(this.total + 1)
    this.floors = new Uint16Array(this.total + 1)
    this.state = structuredClone(log.initial)
    this.checkpoints.set(0, this.state)
    this.label(0)
  }

  /** How many positions have a known act and floor. */
  get indexed() { return this.frontier + 1 }

  private label(position: number) {
    this.acts[position] = this.state.act
    this.floors[position] = this.state.floorsCleared ?? 0
  }

  private advance() {
    this.state = this.next(this.state, this.frontier)
    this.frontier += 1
    if (this.frontier % this.interval === 0) this.checkpoints.set(this.frontier, this.state)
    this.label(this.frontier)
  }

  private next(state: RunState, position: number) {
    const event = this.log.events[position]!
    return applyRunLogEvent(state, { ...event, choice: runLogEventChoice(event, state) })
  }

  /** Indexes the rest of the log in short slices, so the page stays responsive. */
  index() {
    if (this.timer !== undefined || this.failed || this.frontier >= this.total) return
    const slice = () => {
      this.timer = undefined
      const until = performance.now() + INDEX_SLICE_MS
      try {
        while (this.frontier < this.total && performance.now() < until) this.advance()
      } catch {
        // Playback reports the broken event when it reaches it.
        this.failed = true
      }
      this.onIndexed?.()
      if (this.frontier < this.total && !this.failed) this.timer = window.setTimeout(slice, INDEX_GAP_MS)
    }
    this.timer = window.setTimeout(slice)
  }

  stopIndexing() {
    clearTimeout(this.timer)
    this.timer = undefined
  }

  /** A fresh copy of the run once `position` moves have been applied. Jumping past the indexed part rebuilds it on the spot. */
  stateAt(position: number): RunState {
    const target = Math.min(Math.max(Math.trunc(position), 0), this.total)
    while (!this.failed && this.frontier < target) {
      try { this.advance() } catch (error) { this.failed = true; throw error }
    }
    let base = Math.floor(target / this.interval) * this.interval
    while (base > 0 && !this.checkpoints.has(base)) base -= this.interval
    let state = structuredClone(this.checkpoints.get(base)!)
    for (let position = base; position < target; position += 1) state = this.next(state, position)
    return state
  }
}

export type ReplaySnapshot = {
  position: number
  total: number
  speed: number
  paused: boolean
  finished: boolean
  /** Positions whose act and floor are known. */
  indexed: number
}

/** Playback state of one replay, shared between the player loop and the control bar. */
export class ReplaySession implements ReplayPace {
  speed = 1
  paused = false
  position = 0
  finished = false
  readonly timeline: ReplayTimeline
  private readonly listeners = new Set<() => void>()
  private snapshot: ReplaySnapshot

  constructor(log: RunLog) {
    this.timeline = new ReplayTimeline(log, () => this.publish())
    this.snapshot = this.read()
  }

  private read(): ReplaySnapshot {
    return { position: this.position, total: this.timeline.total, speed: this.speed, paused: this.paused,
      finished: this.finished, indexed: this.timeline.indexed }
  }

  private publish() {
    const next = this.read()
    const same = (Object.keys(next) as (keyof ReplaySnapshot)[]).every((key) => next[key] === this.snapshot[key])
    if (same) return
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot = () => this.snapshot

  update(changes: Partial<Pick<ReplaySession, 'speed' | 'paused' | 'position' | 'finished'>>) {
    Object.assign(this, changes)
    this.publish()
  }
}
