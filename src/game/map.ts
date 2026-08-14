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

/**
 * Room weights for the randomly filled middle rows. The first row is always an
 * encounter, the row below the boss is always campfires, and the boss sits
 * alone at the top (p.4, p.9).
 */
const FILLER: { kind: RoomKind; weight: number }[] = [
  { kind: 'encounter', weight: 10 },
  { kind: 'event', weight: 6 },
  { kind: 'elite', weight: 4 },
  { kind: 'campfire', weight: 3 },
  { kind: 'merchant', weight: 2 },
  { kind: 'treasure', weight: 2 },
]

function pickKind(rng: RngState): RoomKind {
  const total = FILLER.reduce((sum, entry) => sum + entry.weight, 0)
  let roll = nextInt(rng, total)
  for (const entry of FILLER) {
    roll -= entry.weight
    if (roll < 0) return entry.kind
  }
  return 'encounter'
}

export type MapShape = {
  /** Rows between the opening encounter and the campfire row. */
  middleRows: number
  /** How wide the map can get. */
  maxWidth: number
}

export const ACT_SHAPE: MapShape = { middleRows: 6, maxWidth: 4 }

/**
 * Generates one act's map. Every room is reachable from the row below it, and
 * every room leads somewhere, so the party can never strand itself.
 */
export function generateMap(
  rng: RngState,
  act: number,
  shape: MapShape = ACT_SHAPE,
  ascension = 0,
): SpireMap {
  const rows: string[][] = []
  const rooms: Record<string, Room> = {}

  const addRow = (kinds: RoomKind[]) => {
    const row = rows.length
    const ids = kinds.map((kind, column) => {
      const id = `a${act}r${row}c${column}`
      rooms[id] = { id, kind, row, column, exits: [], visited: false }
      return id
    })
    rows.push(ids)
    return ids
  }

  // The Act IV elite is added only by Ascension 11; lower levels go straight
  // to the Heart (Ascension reference card).
  if (act === 4) {
    if (ascension < 11) {
      addRow(['boss'])
      return { act, rooms, rows, position: null }
    }
    const elite = addRow(['elite'])[0]!
    const boss = addRow(['boss'])[0]!
    rooms[elite]!.exits = [boss]
    return { act, rooms, rows, position: null }
  }

  // The bottom row is a single fixed encounter (p.9).
  addRow(['encounter'])

  for (let i = 0; i < shape.middleRows; i++) {
    const width = 2 + nextInt(rng, shape.maxWidth - 1)
    addRow(Array.from({ length: width }, () => pickKind(rng)))
  }
  const middle = rows.slice(1).flatMap((row) => row.map((id) => rooms[id]!))
  if (!middle.some((room) => room.kind === 'encounter') && middle[0]) middle[0].kind = 'encounter'

  // The row below the boss is all campfires, so the party can always rest or
  // upgrade before the fight.
  const campfireWidth = rows[rows.length - 1]?.length ?? 2
  addRow(Array.from({ length: campfireWidth }, () => 'campfire' as RoomKind))

  addRow(['boss'])

  // Connect each row to the one above. Every room gets at least one exit, and
  // every room above is reached by at least one room below.
  for (let row = 0; row < rows.length - 1; row++) {
    const here = rows[row] ?? []
    const above = rows[row + 1] ?? []
    if (above.length === 0) continue

    for (const [index, id] of here.entries()) {
      // Map each room to the proportionally nearest room above, then optionally
      // fan out by one so the path branches.
      const anchor = Math.min(
        above.length - 1,
        Math.floor((index / Math.max(1, here.length - 1 || 1)) * (above.length - 1)),
      )
      const exits = new Set<string>([above[anchor] as string])
      if (nextInt(rng, 2) === 0) {
        const neighbour = above[Math.min(above.length - 1, anchor + 1)]
        if (neighbour) exits.add(neighbour)
      }
      const room = rooms[id]
      if (room) room.exits = [...exits]
    }

    // Anything above with no route to it gets one from a random room below.
    const reached = new Set(here.flatMap((id) => rooms[id]?.exits ?? []))
    for (const target of above) {
      if (reached.has(target)) continue
      const source = shuffle(rng, [...here])[0]
      const room = source ? rooms[source] : undefined
      if (room) room.exits = [...new Set([...room.exits, target])]
    }
  }

  return { act, rooms, rows, position: null }
}

/** Replaces one non-opening Encounter with the physical Burning Elite token. */
export function addBurningElite(rng: RngState, map: SpireMap): SpireMap {
  const middleTop = map.rows.length - 2
  const encounters = Object.values(map.rooms).filter((room) => room.row > 0 && room.row < middleTop && room.kind === 'encounter')
  const picked = encounters[nextInt(rng, encounters.length)]
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
