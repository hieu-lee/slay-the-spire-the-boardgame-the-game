import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type React from 'react'
import type { Room, SpireMap } from '../game/map.ts'
import { enemyDef } from '../game/enemies.ts'
import { Icon } from './Icon.tsx'
import type { IconName } from './icons.ts'
import { POINTER_CLICK_WINDOW_MS, useHoverUnavailable } from './touch-input.ts'
import { usePrefersReducedMotion } from './combat-screen/hooks.ts'

const MAP_SELECTION_MS = 800
const MAP_TRANSITION_MS = 1_120

type MapScreenProps = {
  map: SpireMap
  choices: Room[]
  blocked?: boolean
  /**
   * This act's boss, rolled at setup and public. Named on the boss node so a
   * party mid-act can see what it is building a deck against.
   */
  bossDefId?: string | null
  canRerollBoss?: boolean
  onRerollBoss?: () => void
  /**
   * Shown for reading, not for walking — the in-combat map view. Nothing is
   * reachable, but unlike `blocked` the nodes stay hoverable and focusable,
   * which is the entire point of opening it.
   */
  readOnly?: boolean
  onEnter: (roomId: string) => void | Promise<unknown>
  onSelectionChange?: (selecting: boolean) => void
}

const ROOM_ICON: Record<Room['kind'], IconName> = {
  encounter: 'monster',
  elite: 'elite',
  boss: 'boss',
  event: 'daze',
  campfire: 'burn',
  treasure: 'relic',
  merchant: 'gold',
}

const ROOM_LABEL: Record<Room['kind'], string> = {
  encounter: 'Encounter',
  elite: 'Elite',
  boss: 'Boss',
  event: 'Event',
  campfire: 'Campfire',
  treasure: 'Treasure',
  merchant: 'Merchant',
}

/** What a room is for, in one line — the thing a bare icon cannot say. */
const ROOM_TEXT: Record<Room['kind'], string> = {
  encounter: 'One enemy card per player, one per row.',
  elite: 'A harder fight in the bottom row. Every player gains the rewards.',
  boss: 'Counts as being in every row. Every player gains the rewards.',
  event: 'An unknown card from the Act deck.',
  campfire: 'Rest to heal, or Smith to upgrade a card.',
  treasure: 'A relic.',
  merchant: 'Spend gold on cards, relics, potions, and card removal.',
}

const LEGEND_KINDS: Room['kind'][] = ['event', 'merchant', 'treasure', 'campfire', 'encounter', 'elite', 'boss']

/** What a room calls itself — named boss included, hidden rooms withheld. */
function roomName(room: Room | undefined, bossDefId?: string | null): string {
  if (!room) return 'Room'
  if (room.hidden) return 'Unknown room'
  if (room.kind === 'boss' && bossDefId) return enemyDef(bossDefId, 0).name
  return ROOM_LABEL[room.kind]
}

type Line = { key: string; x1: number; y1: number; x2: number; y2: number; live: boolean }

/**
 * A room's hand-placed wobble, in px.
 *
 * The digital game displaces every map node from its grid slot, and that
 * irregularity is most of why its Spire reads as a place instead of as an org
 * chart. Derived from the room id rather than from a random source so a room
 * does not jump when the map re-renders — and so the Playwright suite still
 * finds it where it left it.
 *
 * The id ends in the column number, so sibling ids differ only in their last
 * character or two. A plain `hash * 31` accumulator leaves that difference in
 * the LOW bits, and reading the offset out of the high bits then handed every
 * node in a row the same displacement — the map slid whole rows sideways
 * instead of scattering nodes. The avalanche step below spreads a one-character
 * difference across the whole word before any bits are sliced off.
 *
 * The range is far tighter than the client's ±27/±37, and deliberately not
 * square. Measured in the running app: ordinary nodes are 52px across (the boss
 * is 74px and alone in its row), siblings in a row sit 78px apart, but
 * vertically adjacent rows are only 60px apart — 8px of headroom. Two nodes
 * moving ±10 each would close that to 40px and overlap, which is not just ugly:
 * `.room--reachable` is clicked by the Playwright suites, and an overlapping
 * node steals the hit. So X gets the room it has (±8) and Y is held to ±3.
 * The BOUND, not a measurement: vertically adjacent nodes share a 60px row
 * pitch, so the worst case is 60 - 3 - 3 = 54px between 52px nodes, and the
 * 74px boss row is 71 - 6 = 65px against 63px. Both clear by ~2px. A given seed
 * usually measures looser than that (57px was one sample); widen either range
 * only against this arithmetic, never against a sample.
 */
function jitter(id: string): { x: number; y: number } {
  let hash = 0
  for (let index = 0; index < id.length; index += 1) hash = (Math.imul(hash, 31) + id.charCodeAt(index)) | 0
  hash ^= hash >>> 15
  hash = Math.imul(hash, 0x2c1b3c6d)
  hash ^= hash >>> 12
  hash = Math.imul(hash, 0x297a2d39)
  hash ^= hash >>> 15
  const mixed = hash >>> 0
  // Two independent slices: the same word reused for both axes would tie the
  // horizontal and vertical wobble together and lay the nodes along a diagonal.
  return { x: (mixed % 17) - 8, y: ((mixed >>> 16) % 7) - 3 }
}

/**
 * The Spire, boss at the top. Paths are drawn from measured element positions
 * rather than computed from the layout: the rows wrap and centre themselves, so
 * the only reliable source of a room's position is the DOM.
 */
export function MapScreen({
  map, choices, blocked = false, bossDefId, canRerollBoss = false, onRerollBoss, readOnly = false, onEnter,
  onSelectionChange,
}: MapScreenProps) {
  const frameRef = useRef<HTMLDivElement | null>(null)
  const wasBlocked = useRef(blocked)
  const [lines, setLines] = useState<Line[]>([])
  const reachable = new Set(choices.map((room) => room.id))
  const rows = [...map.rows].reverse()
  // A Set is a fresh object every render, so measuring cannot depend on it
  // without re-running forever. Key the effect on its contents instead.
  const reachableKey = [...reachable].sort().join(',')
  // Touch has no hover, so a tap on a reachable node used to walk the party
  // into it with the room's own panel — what it is, and whether it is an Elite
  // — never once on screen. Route planning is most of the decision-making in a
  // climb, so on a phone the first tap READS the room and only a second tap on
  // that same room enters it. The panel doubles as the confirmation step, which
  // is also why a mis-tap on the Spire no longer costs a run.
  const tapToRead = useHoverUnavailable()
  const reducedMotion = usePrefersReducedMotion()
  const [reading, setReading] = useState<string | null>(null)
  const [entering, setEntering] = useState<string | null>(null)
  const enterTimer = useRef<number | null>(null)
  const visualSelectionDone = useRef(false)
  const enterRequestPending = useRef(false)
  // The panel always hangs below its node, and the rows render bottom-up — so
  // the row a run STARTS on is the lowest on screen, and its panel opened into
  // the space under the map where there is no viewport left. Measured on a
  // phone in landscape it fell entirely below the fold once a potion belt was
  // on screen: the first tap of the run appeared to do nothing at all, which
  // teaches exactly the second blind tap this whole path exists to prevent.
  const [flip, setFlip] = useState(false)
  const pointerActivatedAt = useRef(Number.NEGATIVE_INFINITY)

  const measure = useCallback(() => {
    const frame = frameRef.current
    if (!frame) return
    const origin = frame.getBoundingClientRect()
    const centres = new Map<string, { x: number; y: number }>()
    for (const node of frame.querySelectorAll<HTMLElement>('[data-room]')) {
      const id = node.dataset.room
      if (!id) continue
      const box = node.getBoundingClientRect()
      centres.set(id, { x: box.left - origin.left + box.width / 2, y: box.top - origin.top + box.height / 2 })
    }

    const live = new Set(reachableKey ? reachableKey.split(',') : [])
    const next: Line[] = []
    for (const room of Object.values(map.rooms)) {
      const from = centres.get(room.id)
      if (!from) continue
      for (const exitId of room.exits) {
        const to = centres.get(exitId)
        if (!to) continue
        next.push({
          key: `${room.id}->${exitId}`,
          x1: from.x,
          y1: from.y,
          x2: to.x,
          y2: to.y,
          // Highlight the paths the party can actually take right now.
          live: map.position === room.id && live.has(exitId),
        })
      }
    }
    setLines(next)
  }, [map, reachableKey])

  useEffect(() => {
    measure()
    const frame = frameRef.current
    if (!frame) return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(frame)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [measure])

  useEffect(() => {
    if (wasBlocked.current && !blocked && document.activeElement === document.body) {
      frameRef.current?.querySelector<HTMLButtonElement>('.room--reachable')?.focus()
    }
    wasBlocked.current = blocked
  }, [blocked])

  // The retail boards are taller than the old generated map. Start each view
  // at the party rather than at the boss end of the parchment.
  useLayoutEffect(() => {
    if (blocked) return undefined
    const frame = frameRef.current
    if (!frame) return undefined
    const animation = requestAnimationFrame(() => {
      const port = frame.closest<HTMLElement>('.map')
      const target = frame.querySelector<HTMLElement>('.room--here')
        ?? frame.querySelector<HTMLElement>('.room--reachable')
      if (!port || !target) return
      const viewport = port.getBoundingClientRect()
      const box = target.getBoundingClientRect()
      port.scrollTop += box.top + box.height / 2 - (viewport.top + port.clientHeight / 2)
    })
    return () => cancelAnimationFrame(animation)
  }, [blocked, map.act, map.position])

  // A panel left open across a move would describe a room the party has already
  // left, and its "tap again to enter" would point at a node that is no longer
  // a choice. The two move independently — the shell blanks `choices` on its
  // own while acquiring a card — so either one clears it.
  useEffect(() => setReading(null), [map.position, reachableKey])

  const finishSelection = useCallback(() => {
    setEntering(null)
    onSelectionChange?.(false)
  }, [onSelectionChange])

  const requestEnter = useCallback((roomId: string, waitForVisual: boolean) => {
    const request = onEnter(roomId)
    if (!request || typeof request.then !== 'function') {
      if (!waitForVisual) finishSelection()
      return
    }
    enterRequestPending.current = true
    const settle = () => {
      enterRequestPending.current = false
      if (!waitForVisual || visualSelectionDone.current) finishSelection()
    }
    void request.then(settle, settle)
  }, [finishSelection, onEnter])

  // Keep an online map locked until its queued request settles. Local moves
  // unmount the map synchronously, while a refused remote move stays mounted
  // and becomes usable after both the pencil beat and that request complete.
  useEffect(() => {
    if (!entering) return undefined
    const restore = window.setTimeout(() => {
      visualSelectionDone.current = true
      if (!enterRequestPending.current) finishSelection()
    }, MAP_TRANSITION_MS)
    return () => clearTimeout(restore)
  }, [entering, finishSelection])

  useEffect(() => () => {
    if (enterTimer.current !== null) {
      clearTimeout(enterTimer.current)
      delete document.documentElement.dataset.mapTransition
    }
    onSelectionChange?.(false)
  }, [onSelectionChange])

  // Measured rather than guessed at from the row index: the map scrolls, the
  // panel's height depends on how much prose the room has, and how much room is
  // left below depends on whether a potion belt is on screen.
  useLayoutEffect(() => {
    if (!reading) {
      setFlip(false)
      return
    }
    const node = frameRef.current?.querySelector<HTMLElement>(`[data-room="${CSS.escape(reading)}"]`)
    const tip = node?.querySelector<HTMLElement>('.room-tip')
    if (!node || !tip) {
      setFlip(false)
      return
    }
    const port = node.closest('.map')?.getBoundingClientRect()
    if (!port) {
      setFlip(false)
      return
    }
    const box = node.getBoundingClientRect()
    const height = tip.offsetHeight
    const gap = 0.55 * 16
    // Measured against the SCROLLPORT, not the window: `.map` scrolls, so it is
    // `.map` that clips, and the two disagree by the height of the shell header.
    //
    // Flipping has to earn its place: only when the panel does not fit below AND
    // fully fits above. Down is otherwise the recoverable direction — the map
    // carries 7.5rem of tail padding (chrome/map-overlay.css) so a bottom-row
    // panel can at least be scrolled to, while scrollable overflow never
    // extends past the top. The second term is also what keeps the in-combat
    // peek safe: its panel header clips anything opening above the port, and a
    // flip that requires the panel to fit inside the port cannot reach there.
    setFlip(box.bottom + gap + height > port.bottom && box.top - gap - height >= port.top)
  }, [reading, reachableKey, map.position])

  // Escape closes the panel before anything else acts on it, the way the relic
  // chip and the potion anchor already do — without it the pause menu opened on
  // top of a panel that stayed put.
  useEffect(() => {
    if (!reading) return undefined
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      // Inside the in-combat peek this keypress is also the dialog's own cancel,
      // and stopping propagation does not stop a default action — one press
      // would have closed the panel and the whole peek with it.
      if (frameRef.current?.closest('dialog[open]')) event.preventDefault()
      event.stopPropagation()
      setReading(null)
    }
    document.addEventListener('keydown', dismiss, true)
    return () => document.removeEventListener('keydown', dismiss, true)
  }, [reading])

  // A tap that lands on nothing puts the panel away — but it has to be a TAP.
  // Bound to `click` rather than `pointerdown` because the map scrolls, and a
  // scroll gesture opens with a pointerdown on the parchment: dismissing there
  // closed the panel the moment a player dragged the Spire to see more of it.
  // On `document`, so a tap on the header — a relic chip, the deck — closes it
  // too, rather than leaving two explanations open at once.
  useEffect(() => {
    if (!reading) return undefined
    const dismiss = (event: Event) => {
      if (event.target instanceof Element && event.target.closest('.room')) return
      setReading(null)
    }
    document.addEventListener('click', dismiss, true)
    return () => document.removeEventListener('click', dismiss, true)
  }, [reading])

  return (
    <div className={`map${entering ? ' map--entering' : ''}`} hidden={blocked || undefined} inert={blocked || undefined} aria-disabled={blocked || undefined}>
      <p className="map__hint muted">
        {readOnly
          ? tapToRead ? 'Tap a room to read it.' : 'Hover a room to read it.'
          : choices.length === 0
            ? 'Nowhere to go.'
            : tapToRead
              ? `${map.position === null ? 'Enter the Spire' : 'Choose the next room'} — tap a room to read it, then tap it again to enter.`
              : map.position === null
                ? 'Enter the Spire.'
                : 'Choose the next room.'}
      </p>
      {canRerollBoss && onRerollBoss ? (
        <button type="button" disabled={Boolean(entering)} onClick={onRerollBoss}>
          Reroll {bossDefId ? enemyDef(bossDefId, 0).name : 'boss'}
        </button>
      ) : null}

      {/* Present at all times and only its TEXT changes: a live region inserted
          together with its content is the classic case assistive technology
          does not announce, and the read step has nothing else to announce it
          — the panels are all `aria-hidden`. Named rather than a fixed
          sentence, so reading a different KIND of room announces again: React
          writes nothing when the text does not change. `aria-live` rather than
          `role="status"`, for the reason App.tsx gives at its own region. */}
      <span className="visually-hidden" aria-live="polite" aria-atomic="true">
        {reading && reachable.has(reading)
          ? `${roomName(map.rooms[reading], bossDefId)} read. Activate again to enter.`
          : ''}
      </span>

      <div className="map__frame" ref={frameRef}>
        <svg className="map__paths" aria-hidden="true">
          {lines.map((line) => (
            <line
              key={line.key}
              className={line.live ? 'map__path map__path--live' : 'map__path'}
              x1={line.x1}
              y1={line.y1}
              x2={line.x2}
              y2={line.y2}
            />
          ))}
        </svg>

        {rows.map((row, index) => (
          <div className="map__row" key={`row-${rows.length - 1 - index}`}>
            {row.map((id) => {
              const room = map.rooms[id]
              if (!room) return null
              const isHere = map.position === id
              const canGo = reachable.has(id)
              const named = !room.hidden && room.kind === 'boss' && bossDefId
                ? enemyDef(bossDefId, 0).name
                : null
              const label = roomName(room, bossDefId)
              const text = room.hidden
                ? 'An Uncertain Future hides what this room holds until you arrive.'
                : ROOM_TEXT[room.kind]
              const status = isHere
                ? 'The party is here.'
                : room.visited ? 'Already cleared.' : canGo ? 'Reachable.' : 'Out of reach.'
              const wobble = jitter(id)
              const ink = Math.abs(wobble.x + wobble.y) % 3
              const selecting = entering === id
              return (
                <button
                  type="button"
                  key={id}
                  data-room={id}
                  className={[
                    'room',
                    `room--${room.kind}`,
                    room.hidden ? 'room--hidden' : '',
                    room.visited ? 'room--visited' : '',
                    isHere ? 'room--here' : '',
                    canGo ? 'room--reachable' : '',
                    reading === id ? 'room--reading' : '',
                    `room--ink-${ink}`,
                    selecting ? 'room--selected' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  data-tip-flip={reading === id && flip ? 'up' : undefined}
                  // `aria-disabled` rather than `disabled`: a disabled button
                  // is not focusable, and with the captions gone the only way
                  // to learn what a room is would have been a mouse hover.
                  aria-disabled={!canGo || Boolean(entering)}
                  // Hover devices keep the one-click walk they have always had;
                  // the panel is already open under the pointer by the time the
                  // click lands, so a confirmation step there would be a tax on
                  // information the player has read.
                  //
                  // A keyboard has already opened this panel through
                  // `:focus-visible`, so it must not also be charged a second
                  // Enter and told to "tap". Neither signal is reliable alone —
                  // the engines disagree about the `detail` a synthesised tap
                  // carries, and a `pointerdown` can be followed by no click at
                  // all — so both must agree before an activation counts as a
                  // key. A timestamp rather than a flag because this ref is
                  // shared by every node: a drag that scrolls the map would
                  // otherwise leave it latched for whichever room is pressed
                  // next.
                  onPointerDown={() => { pointerActivatedAt.current = Date.now() }}
                  onClick={(event) => {
                    if (entering) return
                    // Guessing wrong towards "pointer" costs one extra Enter;
                    // guessing wrong towards "keyboard" walks the party into a
                    // room they never got to read.
                    const keyboardActivated = event.detail === 0 &&
                      Date.now() - pointerActivatedAt.current > POINTER_CLICK_WINDOW_MS
                    const readFirst = tapToRead && !keyboardActivated
                    if (readFirst && reading !== id) {
                      setReading(id)
                      return
                    }
                    if (readFirst && !canGo) {
                      setReading(null)
                      return
                    }
                    if (canGo) {
                      if (reducedMotion) {
                        setReading(null)
                        visualSelectionDone.current = true
                        enterRequestPending.current = false
                        setEntering(id)
                        onSelectionChange?.(true)
                        requestEnter(id, false)
                        return
                      }
                      setReading(null)
                      visualSelectionDone.current = false
                      enterRequestPending.current = false
                      setEntering(id)
                      onSelectionChange?.(true)
                      document.documentElement.dataset.mapTransition = 'true'
                      enterTimer.current = window.setTimeout(() => {
                        enterTimer.current = null
                        requestEnter(id, true)
                      }, MAP_SELECTION_MS)
                      window.setTimeout(() => { delete document.documentElement.dataset.mapTransition }, MAP_TRANSITION_MS)
                    }
                  }}
                  aria-label={[
                    named ? `${ROOM_LABEL.boss}: ${named}` : label,
                    room.burning ? 'Burning Elite' : '',
                    text,
                    status,
                    // The panel is `aria-hidden`, so the label is the only place
                    // the two-step exists for a screen reader. A label change on
                    // an already-focused control is not reliably re-announced,
                    // which is why the live region below carries it as well.
                    reading === id && canGo ? 'Activate again to enter' : '',
                  ]
                    .filter(Boolean)
                    .join(', ')}
                  aria-current={isHere ? 'location' : undefined}
                  style={{ '--jitter-x': `${wobble.x}px`, '--jitter-y': `${wobble.y}px` } as React.CSSProperties}
                >
                  {room.visited || isHere || selecting ? <span className="map__ink" aria-hidden="true">
                    <svg viewBox="0 0 100 100" preserveAspectRatio="none" focusable="false">
                      <path pathLength="1" d="M50 4C76 2 97 23 96 49C95 76 75 97 49 96C23 94 3 75 4 48C5 22 24 5 50 4" />
                    </svg>
                  </span> : null}
                  {/* Icon only. The name is in the accessible label and in the
                      tooltip; printing it under every node turned the Spire
                      into a list of captioned boxes. */}
                  <Icon name={room.hidden ? 'daze' : ROOM_ICON[room.kind]} size={!room.hidden && room.kind === 'boss' ? 42 : 34} />
                  {/* Hidden from the screen reader on purpose: it repeats the
                      button's own `aria-label`, exactly as the relic tooltip
                      does. The native `title` it replaces could not be styled,
                      took a second to appear, and never showed the boss. */}
                  <span className="room-tip" aria-hidden="true">
                    <strong className="room-tip__name">{label}</strong>
                    {named ? <span className="room-tip__pool">{ROOM_LABEL.boss}</span> : null}
                    {room.burning ? <span className="room-tip__pool">Burning Elite</span> : null}
                    <span className="room-tip__text">{text}</span>
                    <span className="room-tip__status">{status}</span>
                    {/* The second half of the tap-to-read contract, printed
                        where the player is already looking. Only where it is
                        true: an out-of-reach room's panel would promise a walk
                        the next tap does not take, and a keyboard — which opens
                        this panel through focus and enters on one press — is
                        not being asked to tap anything. */}
                    {tapToRead && canGo && reading === id ? (
                      <span className="room-tip__confirm">Tap again to enter</span>
                    ) : null}
                  </span>
                </button>
              )
            })}
          </div>
        ))}
      </div>
      <aside className="map__legend" aria-label="Map legend">
        <strong>Legend</strong>
        <ul>
          {LEGEND_KINDS.map((kind) => <li className={`map__legend-item--${kind}`} key={kind}><Icon name={ROOM_ICON[kind]} size={19} /> {ROOM_LABEL[kind]}</li>)}
        </ul>
      </aside>
    </div>
  )
}
