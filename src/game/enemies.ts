// Enemy definitions and their action patterns, transcribed from the enemy card
// scans in the rulebook rather than from the video game, which differs.
//
// An enemy card shows one of three behaviours (p.13): a single action repeated
// every turn, a row of actions indexed by the shared die, or a cube that walks
// down a track and loops back to the topmost RED slot — grey slots are one-time
// and are skipped on the loop.
import { shuffle } from './rng.ts'
import type { RngState } from './rng.ts'

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
  /** Status cards go on top of discard, unlike Daze (p.24). */
  | { kind: 'status'; card: 'burn' | 'slimed'; amount: number; aoe?: boolean }
  | { kind: 'loseGold'; amount: number }
  | { kind: 'leave' }
  /** This printed action is sorted after ordinary enemies for this round. */
  | { kind: 'actsLast' }
  /** Summons resolve at the start of the next round. */
  | { kind: 'summon'; defIds: string[] }
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

export type EnemyAbility =
  | { kind: 'curlUp'; block: number }
  | { kind: 'sporeCloud'; vulnerable: number }
  | { kind: 'enraged'; damage: number; fromTurn: number }
  | { kind: 'angry'; strength: number }

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
  /** The yellow special ability printed on the card (p.13). */
  ability?: EnemyAbility
  /** Highest matching threshold replaces only the listed printed values. */
  ascension?: EnemyAscension[]
}

export type EnemyAscension = {
  min: number
  hpByPlayers?: [number, number, number, number]
  pattern?: EnemyPattern
  actsLast?: boolean
  ability?: EnemyAbility
}

/** Die patterns pair the faces, so this keeps the tables readable. */
const byPairs = (
  low: EnemyAction[],
  mid: EnemyAction[],
  high: EnemyAction[],
): Record<number, EnemyAction[]> => ({ 1: low, 2: low, 3: mid, 4: mid, 5: high, 6: high })

export const ENEMIES: Record<string, EnemyDef> = {
  small_slime: {
    id: 'small_slime',
    name: 'Small Slime',
    hpByPlayers: [3, 3, 3, 3],
    pattern: { kind: 'single', actions: [{ kind: 'attack', amount: 1 }] },
  },

  acid_slime: {
    id: 'acid_slime',
    name: 'Acid Slime',
    hpByPlayers: [5, 5, 5, 5],
    pattern: {
      kind: 'die',
      byRoll: byPairs(
        [{ kind: 'attack', amount: 2 }],
        [{ kind: 'applyWeak', amount: 1 }],
        [{ kind: 'attack', amount: 2 }, { kind: 'daze', amount: 1 }],
      ),
    },
  },

  acid_slime_daw: {
    id: 'acid_slime_daw', name: 'Acid Slime', hpByPlayers: [5, 5, 5, 5],
    pattern: { kind: 'die', byRoll: byPairs(
      [{ kind: 'attack', amount: 2 }, { kind: 'daze', amount: 1 }],
      [{ kind: 'attack', amount: 2 }],
      [{ kind: 'applyWeak', amount: 1 }],
    ) },
  },

  acid_slime_wda: {
    id: 'acid_slime_wda', name: 'Acid Slime', hpByPlayers: [5, 5, 5, 5],
    pattern: { kind: 'die', byRoll: byPairs(
      [{ kind: 'applyWeak', amount: 1 }],
      [{ kind: 'attack', amount: 2 }, { kind: 'daze', amount: 1 }],
      [{ kind: 'attack', amount: 2 }],
    ) },
  },

  acid_slime_wad: {
    id: 'acid_slime_wad', name: 'Acid Slime', hpByPlayers: [5, 5, 5, 5],
    pattern: { kind: 'die', byRoll: byPairs(
      [{ kind: 'applyWeak', amount: 1 }],
      [{ kind: 'attack', amount: 2 }],
      [{ kind: 'attack', amount: 2 }, { kind: 'daze', amount: 1 }],
    ) },
  },

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
        [{ kind: 'attack', amount: 2 }, { kind: 'gainStrength', amount: 1 }],
      ),
    },
  },

  jaw_worm_first: {
    id: 'jaw_worm_first',
    name: 'Jaw Worm',
    hpByPlayers: [7, 7, 7, 7],
    pattern: {
      kind: 'die',
      byRoll: byPairs(
        [{ kind: 'block', amount: 2 }, { kind: 'gainStrength', amount: 1 }],
        [{ kind: 'attack', amount: 2 }, { kind: 'block', amount: 1 }],
        [{ kind: 'attack', amount: 3 }],
      ),
    },
  },

  jaw_worm_a7: {
    id: 'jaw_worm_a7',
    name: 'Jaw Worm',
    hpByPlayers: [7, 7, 7, 7],
    pattern: {
      kind: 'die',
      byRoll: byPairs(
        [{ kind: 'attack', amount: 2 }, { kind: 'block', amount: 1 }],
        [{ kind: 'block', amount: 2 }, { kind: 'gainStrength', amount: 1 }],
        [{ kind: 'attack', amount: 3 }],
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
    ability: { kind: 'curlUp', block: 2 },
  },

  green_louse_21w: {
    id: 'green_louse_21w', name: 'Green Louse', hpByPlayers: [3, 3, 3, 3],
    pattern: { kind: 'die', byRoll: byPairs(
      [{ kind: 'attack', amount: 2 }],
      [{ kind: 'attack', amount: 1 }],
      [{ kind: 'applyWeak', amount: 1 }],
    ) },
    ability: { kind: 'curlUp', block: 2 },
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
    ability: { kind: 'curlUp', block: 2 },
  },

  red_louse_first: {
    id: 'red_louse_first',
    name: 'Red Louse',
    hpByPlayers: [4, 4, 4, 4],
    pattern: { kind: 'die', byRoll: byPairs(
      [{ kind: 'gainStrength', amount: 1 }],
      [{ kind: 'attack', amount: 2 }],
      [{ kind: 'attack', amount: 1 }],
    ) },
    ability: { kind: 'curlUp', block: 2 },
  },

  red_louse_summon: {
    id: 'red_louse_summon', name: 'Red Louse', hpByPlayers: [3, 3, 3, 3],
    pattern: { kind: 'die', byRoll: byPairs(
      [{ kind: 'attack', amount: 2 }],
      [{ kind: 'attack', amount: 1 }],
      [{ kind: 'gainStrength', amount: 1 }],
    ) },
    ability: { kind: 'curlUp', block: 2 },
  },

  spike_slime: {
    id: 'spike_slime',
    name: 'Spike Slime',
    hpByPlayers: [5, 5, 5, 5],
    pattern: {
      kind: 'die',
      byRoll: byPairs(
        [{ kind: 'attack', amount: 1 }, { kind: 'applyVulnerable', amount: 1 }, { kind: 'actsLast' }],
        [{ kind: 'attack', amount: 1 }, { kind: 'daze', amount: 1 }],
        [{ kind: 'attack', amount: 2 }],
      ),
    },
  },

  spike_slime_dv2: {
    id: 'spike_slime_dv2', name: 'Spike Slime', hpByPlayers: [5, 5, 5, 5],
    pattern: { kind: 'die', byRoll: byPairs(
      [{ kind: 'attack', amount: 1 }, { kind: 'daze', amount: 1 }],
      [{ kind: 'attack', amount: 1 }, { kind: 'applyVulnerable', amount: 1 }, { kind: 'actsLast' }],
      [{ kind: 'attack', amount: 2 }],
    ) },
  },

  spike_slime_v2d: {
    id: 'spike_slime_v2d', name: 'Spike Slime', hpByPlayers: [5, 5, 5, 5],
    pattern: { kind: 'die', byRoll: byPairs(
      [{ kind: 'attack', amount: 1 }, { kind: 'applyVulnerable', amount: 1 }, { kind: 'actsLast' }],
      [{ kind: 'attack', amount: 2 }],
      [{ kind: 'attack', amount: 1 }, { kind: 'daze', amount: 1 }],
    ) },
  },

  spike_slime_2dv: {
    id: 'spike_slime_2dv', name: 'Spike Slime', hpByPlayers: [5, 5, 5, 5],
    pattern: { kind: 'die', byRoll: byPairs(
      [{ kind: 'attack', amount: 2 }],
      [{ kind: 'attack', amount: 1 }, { kind: 'daze', amount: 1 }],
      [{ kind: 'attack', amount: 1 }, { kind: 'applyVulnerable', amount: 1 }, { kind: 'actsLast' }],
    ) },
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
    ability: { kind: 'sporeCloud', vulnerable: 1 },
  },

  blue_slaver: {
    id: 'blue_slaver',
    name: 'Blue Slaver',
    hpByPlayers: [10, 10, 10, 10],
    pattern: {
      kind: 'die',
      byRoll: byPairs(
        [{ kind: 'attack', amount: 2 }, { kind: 'applyWeak', amount: 1 }],
        [{ kind: 'attack', amount: 3 }],
        [{ kind: 'attack', amount: 2 }, { kind: 'daze', amount: 1 }],
      ),
    },
  },

  red_slaver: {
    id: 'red_slaver',
    name: 'Red Slaver',
    hpByPlayers: [10, 10, 10, 10],
    pattern: {
      kind: 'die',
      byRoll: byPairs(
        [{ kind: 'attack', amount: 2 }, { kind: 'daze', amount: 1 }],
        [{ kind: 'attack', amount: 2 }, { kind: 'applyVulnerable', amount: 1 }, { kind: 'actsLast' }],
        [{ kind: 'attack', amount: 3 }],
      ),
    },
  },

  looter: {
    id: 'looter',
    name: 'Looter',
    hpByPlayers: [9, 9, 9, 9],
    pattern: {
      kind: 'cube',
      slots: [
        { actions: [{ kind: 'attack', amount: 2 }] },
        { actions: [{ kind: 'attack', amount: 3 }, { kind: 'block', amount: 1 }] },
        { actions: [{ kind: 'loseGold', amount: 2 }, { kind: 'leave' }] },
      ],
    },
    ascension: [{ min: 7, hpByPlayers: [7, 7, 7, 7] }],
  },

  large_slime: {
    id: 'large_slime',
    name: 'Large Slime',
    hpByPlayers: [8, 8, 8, 8],
    pattern: {
      kind: 'cube',
      slots: [
        { actions: [{ kind: 'attack', amount: 1, aoe: true }] },
        { actions: [{ kind: 'attack', amount: 4 }, { kind: 'daze', amount: 1 }] },
        { actions: [{ kind: 'summon', defIds: ['acid_slime'] }] },
      ],
    },
    ascension: [{
      min: 7,
      hpByPlayers: [9, 9, 9, 9],
      pattern: {
        kind: 'cube',
        slots: [
          { actions: [{ kind: 'attack', amount: 2, aoe: true }] },
          { actions: [{ kind: 'attack', amount: 4 }, { kind: 'daze', amount: 2 }] },
          { actions: [{ kind: 'summon', defIds: ['acid_slime'] }] },
        ],
      },
    }],
  },

  large_slime_summon_w4s: {
    id: 'large_slime_summon_w4s', name: 'Large Slime', hpByPlayers: [10, 10, 10, 10],
    pattern: { kind: 'die', byRoll: byPairs(
      [{ kind: 'attack', amount: 1 }, { kind: 'applyWeak', amount: 2 }],
      [{ kind: 'attack', amount: 4 }],
      [{ kind: 'attack', amount: 3 }, { kind: 'status', card: 'slimed', amount: 2 }],
    ) },
  },

  large_slime_summon_4sw: {
    id: 'large_slime_summon_4sw', name: 'Large Slime', hpByPlayers: [10, 10, 10, 10],
    pattern: { kind: 'die', byRoll: byPairs(
      [{ kind: 'attack', amount: 4 }],
      [{ kind: 'attack', amount: 3 }, { kind: 'status', card: 'slimed', amount: 2 }],
      [{ kind: 'attack', amount: 1 }, { kind: 'applyWeak', amount: 2 }],
    ) },
  },

  large_slime_summon_sw4: {
    id: 'large_slime_summon_sw4', name: 'Large Slime', hpByPlayers: [10, 10, 10, 10],
    pattern: { kind: 'die', byRoll: byPairs(
      [{ kind: 'attack', amount: 3 }, { kind: 'status', card: 'slimed', amount: 2 }],
      [{ kind: 'attack', amount: 1 }, { kind: 'applyWeak', amount: 2 }],
      [{ kind: 'attack', amount: 4 }],
    ) },
  },

  mad_gremlin: {
    id: 'mad_gremlin',
    name: 'Mad Gremlin',
    hpByPlayers: [4, 4, 4, 4],
    pattern: { kind: 'single', actions: [{ kind: 'attack', amount: 1 }] },
    ability: { kind: 'angry', strength: 1 },
  },

  sneaky_gremlin: {
    id: 'sneaky_gremlin',
    name: 'Sneaky Gremlin',
    hpByPlayers: [2, 2, 2, 2],
    pattern: { kind: 'single', actions: [{ kind: 'attack', amount: 2 }] },
  },

  gremlin_wizard: {
    id: 'gremlin_wizard',
    name: 'Gremlin Wizard',
    hpByPlayers: [4, 4, 4, 4],
    pattern: {
      kind: 'cube',
      slots: [
        { actions: [{ kind: 'idle' }], once: true },
        { actions: [{ kind: 'attack', amount: 3, aoe: true }] },
      ],
    },
  },

  fat_gremlin: {
    id: 'fat_gremlin',
    name: 'Fat Gremlin',
    hpByPlayers: [3, 3, 3, 3],
    pattern: { kind: 'single', actions: [{ kind: 'attack', amount: 1, aoe: true }] },
  },

  sentry_a: {
    id: 'sentry_a',
    name: 'Sentry A',
    hpByPlayers: [7, 7, 7, 7],
    pattern: { kind: 'die', byRoll: {
      1: [{ kind: 'daze', amount: 1 }], 2: [{ kind: 'daze', amount: 1 }], 3: [{ kind: 'daze', amount: 1 }],
      4: [{ kind: 'attack', amount: 3 }], 5: [{ kind: 'attack', amount: 3 }], 6: [{ kind: 'attack', amount: 3 }],
    } },
  },

  sentry_b: {
    id: 'sentry_b',
    name: 'Sentry B',
    hpByPlayers: [8, 8, 8, 8],
    pattern: { kind: 'die', byRoll: {
      1: [{ kind: 'attack', amount: 3 }], 2: [{ kind: 'attack', amount: 3 }], 3: [{ kind: 'attack', amount: 3 }],
      4: [{ kind: 'daze', amount: 1 }], 5: [{ kind: 'daze', amount: 1 }], 6: [{ kind: 'daze', amount: 1 }],
    } },
  },

  sentries: {
    id: 'sentries',
    name: 'Sentries',
    elite: true,
    hpByPlayers: [7, 7, 7, 7],
    pattern: {
      kind: 'die',
      byRoll: {
        1: [{ kind: 'attack', amount: 2 }],
        2: [{ kind: 'attack', amount: 2 }],
        3: [{ kind: 'attack', amount: 2 }],
        4: [{ kind: 'daze', amount: 1 }],
        5: [{ kind: 'daze', amount: 1 }],
        6: [{ kind: 'daze', amount: 1 }],
      },
    },
    ascension: [
      {
        min: 1,
        hpByPlayers: [8, 8, 8, 8],
        pattern: {
          kind: 'cube',
          slots: [
            { actions: [{ kind: 'daze', amount: 1 }], once: true },
            { actions: [{ kind: 'attack', amount: 2 }] },
            { actions: [{ kind: 'daze', amount: 2 }] },
          ],
        },
      },
      {
        min: 12,
        hpByPlayers: [9, 9, 9, 9],
        pattern: {
          kind: 'cube',
          slots: [
            { actions: [{ kind: 'daze', amount: 1, aoe: true }], once: true },
            { actions: [{ kind: 'attack', amount: 2 }] },
            { actions: [{ kind: 'daze', amount: 2 }] },
          ],
        },
      },
    ],
  },

  gremlin_nob: {
    id: 'gremlin_nob',
    name: 'Gremlin Nob',
    elite: true,
    // Elites scale with the party via the HP board (p.11).
    hpByPlayers: [15, 30, 45, 60],
    pattern: {
      kind: 'cube',
      slots: [
        { actions: [{ kind: 'idle' }], once: true },
        { actions: [{ kind: 'attack', amount: 3, aoe: true }] },
      ],
    },
    ability: { kind: 'enraged', damage: 1, fromTurn: 2 },
    ascension: [
      {
        min: 1,
        hpByPlayers: [17, 35, 53, 70],
        pattern: {
          kind: 'cube',
          slots: [
            { actions: [{ kind: 'idle' }], once: true },
            { actions: [{ kind: 'attack', amount: 3, aoe: true }, { kind: 'gainStrength', amount: 1 }] },
          ],
        },
      },
      {
        min: 12,
        hpByPlayers: [19, 39, 61, 85],
        pattern: {
          kind: 'cube',
          slots: [
            { actions: [{ kind: 'attack', amount: 1, aoe: true }], once: true },
            { actions: [{ kind: 'attack', amount: 3, aoe: true }, { kind: 'gainStrength', amount: 1 }] },
          ],
        },
      },
    ],
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
        { actions: [{ kind: 'applyWeak', amount: 2, aoe: true }, { kind: 'gainStrength', amount: 1 }] },
      ],
    },
    ascension: [
      {
        min: 1,
        pattern: {
          kind: 'cube',
          slots: [
            { actions: [{ kind: 'applyWeak', amount: 2, aoe: true }] },
            { actions: [{ kind: 'attack', amount: 4, aoe: true }, { kind: 'gainStrength', amount: 1 }] },
            { actions: [{ kind: 'attack', amount: 4, aoe: true }] },
          ],
        },
      },
      {
        min: 12,
        hpByPlayers: [24, 49, 76, 105],
        pattern: {
          kind: 'cube',
          slots: [
            { actions: [{ kind: 'applyWeak', amount: 2, aoe: true }] },
            { actions: [{ kind: 'attack', amount: 4, aoe: true }, { kind: 'gainStrength', amount: 1 }] },
            { actions: [{ kind: 'attack', amount: 4, aoe: true }] },
          ],
        },
      },
    ],
  },
}

export type SummonSupply = Record<string, string[]>

/** The physical Summons deck, grouped by the name a card asks us to search for. */
const SUMMON_CARDS: SummonSupply = {
  acid_slime: ['acid_slime', 'acid_slime_daw', 'acid_slime_wda', 'acid_slime_wad'],
  green_louse: ['green_louse', 'green_louse_21w'],
  red_louse: ['red_louse_summon'],
  spike_slime: ['spike_slime', 'spike_slime_dv2', 'spike_slime_v2d', 'spike_slime_2dv'],
  large_slime: ['large_slime_summon_w4s', 'large_slime_summon_w4s', 'large_slime_summon_4sw', 'large_slime_summon_sw4'],
  fungi_beast: ['fungi_beast'],
  gremlin: [
    'gremlin_wizard', 'sneaky_gremlin', 'fat_gremlin', 'mad_gremlin',
    'gremlin_wizard', 'sneaky_gremlin', 'fat_gremlin', 'mad_gremlin',
  ],
  sentry_a: Array(6).fill('sentry_a'),
  sentry_b: Array(5).fill('sentry_b'),
}

export function createSummonSupply(rng: RngState): SummonSupply {
  return Object.fromEntries(Object.entries(SUMMON_CARDS).map(([name, cards]) => [name, shuffle(rng, [...cards])]))
}

/** Removes one random matching physical card; absent cards cannot be summoned. */
export function drawSummon(supply: SummonSupply, name: string): string | null {
  return supply[name]?.shift() ?? null
}

export function abilityText(ability: EnemyAbility, compact = false): string {
  switch (ability.kind) {
    case 'curlUp': return compact
      ? `Curl Up · first damage: +${ability.block} Block`
      : `Curl Up: after the first damage, gain ${ability.block} Block`
    case 'sporeCloud': return compact
      ? `Spore Cloud · defeat: row +${ability.vulnerable} Vulnerable`
      : `Spore Cloud: on defeat, apply ${ability.vulnerable} Vulnerable to this row`
    case 'enraged': return compact
      ? `Enraged · turn ${ability.fromTurn}+: Skills hurt ${ability.damage}`
      : `Enraged: from turn ${ability.fromTurn}, a Skill deals ${ability.damage} damage to its player`
    case 'angry': return compact
      ? `Angry · hit: +${ability.strength} Strength`
      : `Angry: after taking damage from an Attack, gain ${ability.strength} Strength`
  }
}

export function enemyDef(id: string, ascension = 0): EnemyDef {
  const def = ENEMIES[id]
  if (!def) throw new Error(`unknown enemy id: ${id}`)
  const variant = def.ascension
    ?.filter((candidate) => ascension >= candidate.min)
    .sort((a, b) => b.min - a.min)[0]
  return variant ? { ...def, ...variant, id: def.id, name: def.name } : def
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
