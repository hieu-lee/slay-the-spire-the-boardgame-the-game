// The Spire map: a branching path of rooms the party climbs together.
//
// The party moves as ONE group along a single track (p.9), so this is a
// directed graph of rooms with a single boot position rather than a token per
// player. Rooms are laid out in rows; you may move to any room the current one
// connects to on the row above.
import { nextInt, shuffle } from './rng.ts'
import type { RngState } from './rng.ts'

export type RoomKind =
  | 'encounter'
  | 'elite'
  | 'event'
  | 'campfire'
  | 'treasure'
  | 'merchant'
  | 'boss'

export type MapTokenBack = 'dark' | 'light'

export type Room = {
  id: string
  kind: RoomKind
  /** 0 is the bottom row, where the party starts. */
  row: number
  /** Position within the row, left to right. */
  column: number
  /** Room ids on the row above that this one connects to. */
  exits: string[]
  visited: boolean
  /** The physical Burning Elite token replacing a dark-backed Encounter. */
  burning?: boolean
  /** Back shown by the printed token socket; absent for rooms printed on the board. */
  tokenBack?: MapTokenBack
  /** Presentation-only marker used by Uncertain Future; authoritative maps never set it. */
  hidden?: boolean
}

export type SpireMap = {
  act: number
  rooms: Record<string, Room>
  /** Ids in row order, so the UI can lay the map out without re-deriving it. */
  rows: string[][]
  /** Where the boot meeple stands. `null` before the party enters the first room. */
  position: string | null
}

type MapSlot = RoomKind | MapTokenBack
type RoomSpec = readonly [slot: MapSlot, exits: readonly number[]]
type ActMapSpec = readonly (readonly RoomSpec[])[]

const DARK_TOKENS: readonly RoomKind[] = [
  'encounter', 'encounter', 'encounter', 'elite', 'elite', 'elite', 'event', 'event',
]
const LIGHT_TOKENS: readonly RoomKind[] = [
  'campfire', 'campfire', 'campfire', 'merchant', 'merchant', 'treasure', 'treasure',
]

// The retail boards, transcribed bottom-to-top. Only token faces are random;
// the printed rooms and paths never change.
const ACT_I_MAPS: readonly ActMapSpec[] = [
  [
    [['encounter', [0, 1, 2]]],
    [['event', [0]], ['event', [1]], ['event', [2]]],
    [['encounter', [0, 1]], ['encounter', [1, 2]], ['event', [3]]],
    [['merchant', [0]], ['light', [1]], ['event', [2]], ['encounter', [3]]],
    [['dark', [0]], ['encounter', [0, 1]], ['light', [1, 2]], ['light', [2, 3]]],
    [['event', [0]], ['dark', [0, 1]], ['encounter', [1, 2]], ['dark', [2, 3]]],
    [['treasure', [0, 1]], ['treasure', [1]], ['treasure', [2]], ['treasure', [2]]],
    [['encounter', [0, 1]], ['dark', [1, 2]], ['dark', [2, 3]]],
    [['light', [0]], ['event', [1]], ['light', [2, 3]], ['light', [3]]],
    [['encounter', [0]], ['light', [1, 2]], ['event', [2]], ['dark', [3]]],
    [['event', [0]], ['dark', [1]], ['dark', [2]], ['event', [3]]],
    [['campfire', [0]], ['campfire', [0]], ['campfire', [0]], ['campfire', [0]]],
    [['boss', []]],
  ],
  [
    [['encounter', [0, 1, 2]]],
    [['event', [0]], ['event', [1]], ['event', [2]]],
    [['event', [0]], ['encounter', [1, 2]], ['encounter', [2, 3]]],
    [['encounter', [0, 1]], ['light', [1, 2]], ['event', [2]], ['event', [3]]],
    [['dark', [0]], ['encounter', [0, 1]], ['dark', [1]], ['light', [2]]],
    [['light', [0, 1]], ['light', [1, 2]], ['dark', [2]]],
    [['treasure', [0]], ['treasure', [1, 2]], ['treasure', [2, 3]]],
    [['encounter', [0]], ['event', [0, 1]], ['dark', [1]], ['encounter', [2]]],
    [['dark', [0, 1]], ['light', [1, 2]], ['dark', [3]]],
    [['light', [0]], ['encounter', [1]], ['event', [2]], ['light', [2, 3]]],
    [['dark', [0]], ['merchant', [1]], ['dark', [2]], ['event', [3]]],
    [['campfire', [0]], ['campfire', [0]], ['campfire', [0]], ['campfire', [0]]],
    [['boss', []]],
  ],
]

const ACT_MAPS: Record<2 | 3, ActMapSpec> = {
  2: [
    [['encounter', [0, 1, 2]]],
    [['encounter', [0]], ['event', [1]], ['event', [2]]],
    [['merchant', [0, 1]], ['light', [1, 2]], ['encounter', [2, 3]]],
    [['dark', [0]], ['dark', [0, 1]], ['encounter', [1, 2]], ['light', [2, 3]]],
    [['light', [0, 1]], ['light', [1]], ['dark', [2]], ['dark', [2, 3]]],
    [['dark', [0]], ['dark', [1, 2]], ['light', [2, 3]], ['light', [3]]],
    [['event', [0]], ['light', [0, 1]], ['event', [2, 3]], ['event', [3]]],
    [['dark', [0]], ['encounter', [1]], ['event', [2]], ['elite', [3]]],
    [['campfire', [0]], ['campfire', [0]], ['campfire', [0]], ['campfire', [0]]],
    [['boss', []]],
  ],
  3: [
    [['encounter', [0, 1, 2]]],
    [['event', [0]], ['event', [1, 2]], ['encounter', [3]]],
    [['light', [0]], ['light', [0, 1]], ['dark', [2]], ['event', [3]]],
    [['dark', [0, 1]], ['event', [0, 1]], ['light', [2]], ['light', [2, 3]]],
    [['encounter', [0, 1]], ['light', [1, 2]], ['dark', [2, 3]], ['dark', [3, 4]]],
    [['light', [0]], ['dark', [1]], ['encounter', [1, 2]], ['light', [2, 3]], ['event', [3]]],
    [['dark', [0]], ['merchant', [1]], ['dark', [2]], ['dark', [3]]],
    [['campfire', [0]], ['campfire', [0]], ['campfire', [0]], ['campfire', [0]]],
    [['boss', []]],
  ],
}

/** Builds the printed retail map and deals its finite physical token supply. */
export function generateMap(rng: RngState, act: number, ascension = 0): SpireMap {
  if (act === 4) return actIVMap(ascension >= 11)
  if (act !== 1 && act !== 2 && act !== 3) throw new Error(`unsupported map act: ${act}`)

  const dark = shuffle(rng, [...DARK_TOKENS])
  const light = shuffle(rng, [...LIGHT_TOKENS])
  const spec = act === 1 ? ACT_I_MAPS[nextInt(rng, ACT_I_MAPS.length)]! : ACT_MAPS[act]
  const rows = spec.map((row, rowIndex) => row.map((_room, column) => `a${act}r${rowIndex}c${column}`))
  const rooms: Record<string, Room> = {}

  for (const [row, specs] of spec.entries()) {
    for (const [column, [slot, exitColumns]] of specs.entries()) {
      const tokenBack = slot === 'dark' || slot === 'light' ? slot : undefined
      const kind = tokenBack ? (tokenBack === 'dark' ? dark.pop() : light.pop()) : slot
      if (!kind || kind === 'dark' || kind === 'light') throw new Error(`not enough ${tokenBack} map tokens for Act ${act}`)
      const id = rows[row]![column]!
      rooms[id] = {
        id,
        kind,
        row,
        column,
        exits: exitColumns.map((exit) => rows[row + 1]?.[exit]).filter((exit): exit is string => Boolean(exit)),
        visited: false,
        ...(tokenBack ? { tokenBack } : {}),
      }
    }
  }

  return { act, rooms, rows, position: null }
}

/** Replaces one dark-backed Encounter with the physical Burning Elite token. */
export function addBurningElite(rng: RngState, map: SpireMap): SpireMap {
  const encounters = Object.values(map.rooms).filter((room) => room.tokenBack === 'dark' && room.kind === 'encounter')
  // Pick among the three physical Encounter tokens. Act II leaves one dark
  // token unused, so the replaced token can legitimately miss the board.
  const picked = encounters[nextInt(rng, 3)]
  if (!picked) return map
  return {
    ...map,
    rooms: {
      ...map.rooms,
      [picked.id]: { ...picked, kind: 'elite', burning: true },
    },
  }
}

/** The map printed on the Act IV Boss card. Ascension 11 inserts its Elite. */
export function actIVMap(harder: boolean): SpireMap {
  const kinds: RoomKind[] = ['campfire', 'merchant', ...(harder ? ['elite' as const] : []), 'boss']
  const rooms: Record<string, Room> = {}
  const rows = kinds.map((kind, row) => {
    const id = `a4r${row}c0`
    rooms[id] = { id, kind, row, column: 0, exits: [], visited: false }
    return [id]
  })
  for (let row = 0; row < rows.length - 1; row++) rooms[rows[row]![0]!]!.exits = [rows[row + 1]![0]!]
  return { act: 4, rooms, rows, position: null }
}

/** Rooms the party may move to right now. */
export function availableMoves(map: SpireMap): Room[] {
  if (map.position === null) {
    const first = map.rows[0]?.[0]
    const room = first ? map.rooms[first] : undefined
    return room ? [room] : []
  }
  const current = map.rooms[map.position]
  if (!current) return []
  return current.exits.map((id) => map.rooms[id]).filter((room): room is Room => room !== undefined)
}

/**
 * Moves the party. Returns the SAME map reference when the move is illegal,
 * matching how the combat engine signals an illegal action.
 */
export function moveTo(map: SpireMap, roomId: string): SpireMap {
  if (!availableMoves(map).some((room) => room.id === roomId)) return map
  const room = map.rooms[roomId]
  if (!room) return map
  return {
    ...map,
    position: roomId,
    rooms: { ...map.rooms, [roomId]: { ...room, visited: true } },
  }
}

export function currentRoom(map: SpireMap): Room | null {
  return map.position === null ? null : (map.rooms[map.position] ?? null)
}

export function isActComplete(map: SpireMap): boolean {
  const room = currentRoom(map)
  return room?.kind === 'boss' && room.visited
}
