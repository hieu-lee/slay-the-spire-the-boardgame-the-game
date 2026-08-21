import type { Room } from '../game/map.ts'

/** Just the parts of a map this needs, so both the local and online shapes fit. */
type LaneMap = { rows: string[][]; rooms: Record<string, Room> }

/**
 * The label for one Wing Boots destination.
 *
 * Shared by the local and online prompts because both of its rules are easy to
 * get wrong in only one of them.
 *
 * A row routinely offers two rooms of the SAME kind, whose buttons then read
 * identically, so a duplicate names where on the row it sits, counting from the
 * left the map draws it.
 *
 * The `hidden` guard is load-bearing, and it fails DIFFERENTLY on each side, so
 * it is not cosmetic on either. Locally `wingBootChoices` returns rooms straight
 * off `state.map`, which is never redacted — reading `room.kind` there would
 * leak the true kind of a room Uncertain Future is hiding. Online the map has
 * already been rewritten to `encounter`, so the same read tells the player a
 * confident lie instead. Both are fixed by asking the map the caller passes
 * whether it is still hiding the room.
 */
export function wingBootLabel(room: Room, choices: readonly Room[], map: LaneMap): string {
  const kindOf = (candidate: Room) => map.rooms[candidate.id]?.hidden ? 'unknown room' : candidate.kind
  /** Capitalised to match the labels the map's own Legend prints for these kinds. */
  const named = (kind: string) => kind.charAt(0).toUpperCase() + kind.slice(1)
  const kind = kindOf(room)
  const ambiguous = choices.filter((other) => kindOf(other) === kind).length > 1
  const lane = (map.rows[room.row]?.indexOf(room.id) ?? -1) + 1
  return `Ignore paths to ${named(kind)}${ambiguous && lane > 0 ? ` · ${lane} from the left` : ''}`
}
