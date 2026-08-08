// Enemy definitions and their action patterns, transcribed from the enemy card
// scans in the rulebook rather than from the video game, which differs.
//
// An enemy card shows one of three behaviours (p.13): a single action repeated
// every turn, a row of actions indexed by the shared die, or a cube that walks
// down a track and loops back to the topmost RED slot — grey slots are one-time
// and are skipped on the loop.

export type EnemyAction =
  /** Damage to the player in this enemy's row, or to all players if `aoe`. */
  | { kind: 'attack'; amount: number; times?: number; aoe?: boolean }
  /** Block and Strength always go on the enemy itself, never on a player (p.14). */
  | { kind: 'block'; amount: number }
  | { kind: 'gainStrength'; amount: number }
  | { kind: 'applyWeak'; amount: number; aoe?: boolean }
  | { kind: 'applyVulnerable'; amount: number; aoe?: boolean }
  /** Puts a Daze card on top of the target's draw pile (p.24). */
  | { kind: 'daze'; amount: number; aoe?: boolean }
  /** Does nothing — Lagavulin asleep, the Gremlin Nob's first turn. */
  | { kind: 'idle' }

export type CubeSlot = {
  actions: EnemyAction[]
  /** Grey slots fire once and are skipped when the cube loops (p.13). */
  once?: boolean
}

export type EnemyPattern =
  | { kind: 'single'; actions: EnemyAction[] }
  /** Indexed 1-6 by the shared die result for the round. */
  | { kind: 'die'; byRoll: Record<number, EnemyAction[]> }
  | { kind: 'cube'; slots: CubeSlot[] }

export type EnemyDef = {
  id: string
  name: string
  /** Starting HP for 1, 2, 3 and 4 players respectively. */
  hpByPlayers: [number, number, number, number]
  pattern: EnemyPattern
  isBoss?: boolean
  elite?: boolean
  /** Bosses act last, as do enemies whose card says "acts last" (p.13). */
  actsLast?: boolean
  /**
   * The yellow special ability printed on the card. Recorded as prose because
   * triggered abilities are not implemented yet — see the note in state.ts.
   * Anything listed here does NOT currently resolve.
   */
  unimplementedAbility?: string
  /** Enemies pulled from the Summons deck when this one enters play. */
  summons?: string[]
}

/** Die patterns pair the faces, so this keeps the tables readable. */
const byPairs = (
  low: EnemyAction[],
  mid: EnemyAction[],
  high: EnemyAction[],
): Record<number, EnemyAction[]> => ({ 1: low, 2: low, 3: mid, 4: mid, 5: high, 6: high })

export const ENEMIES: Record<string, EnemyDef> = {
  cultist: {
    id: 'cultist',
    name: 'Cultist',
    hpByPlayers: [9, 9, 9, 9],
    pattern: {
      kind: 'single',
      actions: [
        { kind: 'attack', amount: 1 },
        { kind: 'gainStrength', amount: 1 },
      ],
    },
    summons: ['green_louse'],
  },

  jaw_worm: {
    id: 'jaw_worm',
    name: 'Jaw Worm',
    hpByPlayers: [10, 10, 10, 10],
    pattern: {
      kind: 'die',
      byRoll: byPairs(
        [{ kind: 'attack', amount: 3 }, { kind: 'block', amount: 1 }],
        [{ kind: 'attack', amount: 4 }],
        [{ kind: 'block', amount: 2 }, { kind: 'gainStrength', amount: 1 }],
      ),
    },
  },

  green_louse: {
    id: 'green_louse',
    name: 'Green Louse',
    hpByPlayers: [3, 3, 3, 3],
    pattern: {
      kind: 'die',
      byRoll: byPairs(
        [{ kind: 'attack', amount: 1 }],
        [{ kind: 'applyWeak', amount: 1 }],
        [{ kind: 'attack', amount: 2 }],
      ),
    },
    unimplementedAbility: 'Curl Up: the first time the Louse takes damage, it gains 2 Block.',
  },

  red_louse: {
    id: 'red_louse',
    name: 'Red Louse',
    hpByPlayers: [4, 4, 4, 4],
    pattern: {
      kind: 'die',
      byRoll: byPairs(
        [{ kind: 'gainStrength', amount: 1 }],
        [{ kind: 'attack', amount: 2 }],
        [{ kind: 'attack', amount: 2 }],
      ),
    },
    unimplementedAbility: 'Curl Up: the first time the Louse takes damage, it gains 2 Block.',
    summons: ['green_louse', 'red_louse'],
  },

  spike_slime: {
    id: 'spike_slime',
    name: 'Spike Slime',
    hpByPlayers: [5, 5, 5, 5],
    // "Acts last" is printed beside its first action.
    actsLast: true,
    pattern: {
      kind: 'die',
      byRoll: byPairs(
        [{ kind: 'attack', amount: 1 }, { kind: 'applyVulnerable', amount: 1 }],
        [{ kind: 'attack', amount: 1 }, { kind: 'daze', amount: 1 }],
        [{ kind: 'attack', amount: 2 }],
      ),
    },
  },

  fungi_beast: {
    id: 'fungi_beast',
    name: 'Fungi Beast',
    hpByPlayers: [6, 6, 6, 6],
    pattern: {
      kind: 'die',
      byRoll: byPairs(
        [{ kind: 'attack', amount: 2 }],
        [{ kind: 'attack', amount: 1, aoe: true }, { kind: 'gainStrength', amount: 1 }],
        [{ kind: 'gainStrength', amount: 2 }],
      ),
    },
    unimplementedAbility: 'Spore Cloud: on death, apply Vulnerable.',
    summons: ['fungi_beast'],
  },

  blue_slaver: {
    id: 'blue_slaver',
    name: 'Blue Slaver',
    hpByPlayers: [7, 7, 7, 7],
    pattern: {
      kind: 'cube',
      slots: [
        { actions: [{ kind: 'attack', amount: 1 }] },
        { actions: [{ kind: 'attack', amount: 1 }, { kind: 'applyWeak', amount: 1 }] },
      ],
    },
  },

  gremlin_nob: {
    id: 'gremlin_nob',
    name: 'Gremlin Nob',
    elite: true,
    // Elites scale with the party via the HP board (p.11).
    hpByPlayers: [14, 28, 42, 56],
    pattern: {
      kind: 'cube',
      slots: [
        { actions: [{ kind: 'idle' }], once: true },
        { actions: [{ kind: 'attack', amount: 3, aoe: true }] },
      ],
    },
    unimplementedAbility: 'Enraged: after you play a Skill, you take 1 damage. Starts on turn 2.',
  },

  lagavulin: {
    id: 'lagavulin',
    name: 'Lagavulin',
    elite: true,
    hpByPlayers: [22, 44, 66, 88],
    pattern: {
      kind: 'cube',
      slots: [
        // "Zzz... zzz..." — it sleeps through the first turn.
        { actions: [{ kind: 'idle' }], once: true },
        { actions: [{ kind: 'attack', amount: 4, aoe: true }] },
        { actions: [{ kind: 'attack', amount: 4, aoe: true }] },
        { actions: [{ kind: 'applyWeak', amount: 2, aoe: true }] },
      ],
    },
  },
}

export function enemyDef(id: string): EnemyDef {
  const def = ENEMIES[id]
  if (!def) throw new Error(`unknown enemy id: ${id}`)
  return def
}

/** Starting HP scales with the party size via the HP board (p.11). */
export function startingHp(def: EnemyDef, playerCount: number): number {
  const index = Math.max(1, Math.min(4, playerCount)) - 1
  return def.hpByPlayers[index] ?? def.hpByPlayers[0]
}

/**
 * The actions an enemy takes this turn, given the round's die roll and its cube
 * position. Returns an empty list for a slot that does not exist.
 */
export function actionsFor(def: EnemyDef, die: number, actionIndex: number): EnemyAction[] {
  const pattern = def.pattern
  if (pattern.kind === 'single') return pattern.actions
  if (pattern.kind === 'die') return pattern.byRoll[die] ?? []
  const slot = pattern.slots[actionIndex]
  return slot ? slot.actions : []
}

/**
 * Where the cube sits next turn. On reaching the bottom it returns to the
 * topmost slot that is NOT a one-time grey slot (p.13).
 */
export function advanceCube(def: EnemyDef, actionIndex: number): number {
  if (def.pattern.kind !== 'cube') return actionIndex
  const slots = def.pattern.slots
  const next = actionIndex + 1
  if (next < slots.length) return next
  const firstRepeating = slots.findIndex((slot) => !slot.once)
  return firstRepeating === -1 ? 0 : firstRepeating
}
