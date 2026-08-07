// Enemy definitions and their action patterns.
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
  /** Does nothing — Lagavulin's sleep, the Guardian between modes. */
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
  /** Bosses act last, as do enemies whose card says "acts last" (p.13). */
  actsLast?: boolean
}

export const ENEMIES: Record<string, EnemyDef> = {
  cultist: {
    id: 'cultist',
    name: 'Cultist',
    hpByPlayers: [6, 6, 6, 6],
    // Ritual: buffs itself once, then attacks with the strength it built.
    pattern: {
      kind: 'cube',
      slots: [{ actions: [{ kind: 'gainStrength', amount: 1 }], once: true }, { actions: [{ kind: 'attack', amount: 1 }] }],
    },
  },
  jaw_worm: {
    id: 'jaw_worm',
    name: 'Jaw Worm',
    hpByPlayers: [8, 8, 8, 8],
    pattern: {
      kind: 'die',
      byRoll: {
        1: [{ kind: 'attack', amount: 2 }],
        2: [{ kind: 'attack', amount: 2 }],
        3: [{ kind: 'attack', amount: 1 }, { kind: 'block', amount: 1 }],
        4: [{ kind: 'attack', amount: 1 }, { kind: 'block', amount: 1 }],
        5: [{ kind: 'gainStrength', amount: 1 }, { kind: 'block', amount: 1 }],
        6: [{ kind: 'gainStrength', amount: 1 }, { kind: 'block', amount: 1 }],
      },
    },
  },
  red_louse: {
    id: 'red_louse',
    name: 'Red Louse',
    hpByPlayers: [4, 4, 4, 4],
    pattern: { kind: 'single', actions: [{ kind: 'attack', amount: 1 }] },
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
 * position. Returns an empty list for an idle slot.
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
