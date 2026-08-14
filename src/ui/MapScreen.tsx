import { useCallback, useEffect, useRef, useState } from 'react'
import type { Room, SpireMap } from '../game/map.ts'
import { Icon } from './Icon.tsx'
import type { IconName } from './icons.ts'

type MapScreenProps = {
  map: SpireMap
  choices: Room[]
  blocked?: boolean
  onEnter: (roomId: string) => void
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

type Line = { key: string; x1: number; y1: number; x2: number; y2: number; live: boolean }

/**
 * The Spire, boss at the top. Paths are drawn from measured element positions
 * rather than computed from the layout: the rows wrap and centre themselves, so
 * the only reliable source of a room's position is the DOM.
 */
export function MapScreen({ map, choices, blocked = false, onEnter }: MapScreenProps) {
  const frameRef = useRef<HTMLDivElement | null>(null)
  const wasBlocked = useRef(blocked)
  const [lines, setLines] = useState<Line[]>([])
  const reachable = new Set(choices.map((room) => room.id))
  const rows = [...map.rows].reverse()
  // A Set is a fresh object every render, so measuring cannot depend on it
  // without re-running forever. Key the effect on its contents instead.
  const reachableKey = [...reachable].sort().join(',')

  const measure = useCallback(() => {
    const frame = frameRef.current
    if (!frame) return
    const origin = frame.getBoundingClientRect()
    const centre = (id: string) => {
      const node = frame.querySelector<HTMLElement>(`[data-room="${CSS.escape(id)}"]`)
      if (!node) return null
      const box = node.getBoundingClientRect()
      return { x: box.left - origin.left + box.width / 2, y: box.top - origin.top + box.height / 2 }
    }

    const live = new Set(reachableKey ? reachableKey.split(',') : [])
    const next: Line[] = []
    for (const room of Object.values(map.rooms)) {
      const from = centre(room.id)
      if (!from) continue
      for (const exitId of room.exits) {
        const to = centre(exitId)
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

  return (
    <div className="map" inert={blocked || undefined} aria-disabled={blocked || undefined}>
      <p className="map__hint muted">
        {choices.length === 0
          ? 'Nowhere to go.'
          : map.position === null
            ? 'Enter the Spire.'
            : 'Choose the next room.'}
      </p>

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
              const label = room.hidden ? 'Unknown room' : ROOM_LABEL[room.kind]
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
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  // `aria-disabled` rather than `disabled`: a disabled button
                  // is not focusable, and with the captions gone the only way
                  // to learn what a room is would have been a mouse hover.
                  aria-disabled={!canGo}
                  onClick={() => canGo && onEnter(id)}
                  aria-label={[
                    label,
                    isHere ? 'the party is here' : '',
                    room.visited && !isHere ? 'already cleared' : '',
                    canGo ? 'reachable' : 'out of reach',
                  ]
                    .filter(Boolean)
                    .join(', ')}
                  aria-current={isHere ? 'location' : undefined}
                  title={label}
                >
                  {/* Icon only. The name is in the accessible label and in the
                      tooltip; printing it under every node turned the Spire
                      into a list of captioned boxes. */}
                  <Icon name={room.hidden ? 'daze' : ROOM_ICON[room.kind]} size={!room.hidden && room.kind === 'boss' ? 34 : 24} />
                </button>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}
