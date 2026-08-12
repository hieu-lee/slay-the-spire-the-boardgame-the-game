// Enemy definitions and their action patterns, transcribed from the enemy card
// scans in the rulebook rather than from the video game, which differs.
//
// An enemy card shows one of three behaviours (p.13): a single action repeated
// every turn, a row of actions indexed by the shared die, or a cube that walks
// down a track and loops back to the topmost RED slot — grey slots are one-time
// and are skipped on the loop.
import { shuffle } from './rng.ts'
import type { RngState } from './rng.ts'
import type { Enemy } from './types.ts'

export type EnemyAction =
  /** Damage to the player in this enemy's row, or to all players if `aoe`. */
  | { kind: 'attack'; amount: number; times?: number; aoe?: boolean; facing?: boolean }
  /** Different printed hits that still spend modifiers once as one action. */
  | { kind: 'attackSequence'; hits: { amount: number; aoe?: boolean }[] }
  /** Block and Strength always go on the enemy itself, never on a player (p.14). */
  | { kind: 'block'; amount: number; perPlayer?: boolean }
  | { kind: 'gainStrength'; amount: number }
  | { kind: 'blockAllEnemies'; amount: number }
  | { kind: 'strengthenAllEnemies'; amount: number }
  | { kind: 'healAllEnemies'; amount: number }
  | { kind: 'healSelf'; amount: number }
  | { kind: 'blockNamed'; defId: string; amount: number }
  | { kind: 'clearSelfDebuffs' }
  | { kind: 'reviveAll'; group: 'gremlin' | 'darkling' }
  | { kind: 'applyWeak'; amount: number; aoe?: boolean }
  | { kind: 'applyVulnerable'; amount: number; aoe?: boolean }
  /** Puts a Daze card on top of the target's draw pile (p.24). */
  | { kind: 'daze'; amount: number; aoe?: boolean }
  /** Status cards go on top of discard, unlike Daze (p.24). */
  | { kind: 'status'; card: 'burn' | 'slimed'; amount: number; aoe?: boolean }
  | { kind: 'loseGold'; amount: number }
  | { kind: 'leave' }
  | { kind: 'die' }
  | { kind: 'addAbilityCube'; amount: number }
  | { kind: 'transform'; defId: string }
  | { kind: 'guardianModeShift'; amount: number }
  | { kind: 'removeInvincible' }
  | { kind: 'shuffleStatus'; card: 'burn' | 'slimed'; amount: number }
  /** This printed action is sorted after ordinary enemies for this round. */
  | { kind: 'actsLast' }
  /** Summons resolve at the start of the next round. */
  | { kind: 'summon'; defIds: string[] }
  | { kind: 'summonUntil'; defId: string; perPlayer: number }
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
  /** A one-time first turn followed by a permanent die table. */
  | { kind: 'firstThenDie'; first: EnemyAction[]; byRoll: Record<number, EnemyAction[]> }

export type EnemyAbility =
  | { kind: 'curlUp'; block: number }
  | { kind: 'sporeCloud'; vulnerable: number }
  | { kind: 'enraged'; damage: number; fromTurn: number }
  | { kind: 'angry'; strength: number }
  | { kind: 'flying'; maxDamagePerHit: number }
  | { kind: 'painfulStabs'; daze: number }
  | { kind: 'furyOnAllyDeath'; allyDefId: string; strength: number; actions: EnemyAction[] }
  | { kind: 'confusion'; byRoll: Record<number, number> }
  | { kind: 'barricade'; startingBlock: number }
  | { kind: 'shift' }
  | { kind: 'reactiveReroll' }
  | { kind: 'regrow' }
  | { kind: 'thorns'; damagePerCube: number; startingCubes: number; maxCubes: number }
  | { kind: 'immuneOnSlots'; slots: number[] }
  | { kind: 'slow'; damagePerHit: number }
  | { kind: 'rally'; summonDefId: string }
  | { kind: 'splitOnDeath'; defIds: string[]; largeSlimeStrength?: number }
  | { kind: 'rebirth'; hpPerPlayer: number; defId?: string; clearWeakVulnerable?: boolean; strength?: number; strengthPerPower?: boolean; timing?: 'endOfTurn' }
  | { kind: 'sharpHide'; damage: number }
  | { kind: 'curiosity' }
  | { kind: 'timeWarp'; limits: number[] }
  | { kind: 'invincible'; hpPerPlayer: number }
  | { kind: 'beatOfDeath'; damagePerCube: number; startingCubes: number; maxCubes: number }
  | { kind: 'void' }
  | { kind: 'facing'; effect: 'shield' | 'spear' }

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
  startingBlock?: number
  retainsBlock?: boolean
  /** The yellow special ability printed on the card (p.13). */
  ability?: EnemyAbility
  abilities?: EnemyAbility[]
  /** Reuse a generated portrait across printed forms. */
  artId?: string
  /** Generated act-specific boss backdrop. */
  bossAct?: 1 | 2 | 3 | 4
  /** Highest matching threshold replaces only the listed printed values. */
  ascension?: EnemyAscension[]
}

export type EnemyAscension = {
  min: number
  hpByPlayers?: [number, number, number, number]
  pattern?: EnemyPattern
  actsLast?: boolean
  startingBlock?: number
  retainsBlock?: boolean
  ability?: EnemyAbility
  abilities?: EnemyAbility[]
}

/** Die patterns pair the faces, so this keeps the tables readable. */
const byPairs = (
  low: EnemyAction[],
  mid: EnemyAction[],
  high: EnemyAction[],
): Record<number, EnemyAction[]> => ({ 1: low, 2: low, 3: mid, 4: mid, 5: high, 6: high })

const perPlayer = (hp: number): [number, number, number, number] => [hp, hp * 2, hp * 3, hp * 4]

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
    id: 'acid_slime_daw', name: 'Acid Slime', artId: 'acid_slime', hpByPlayers: [5, 5, 5, 5],
    pattern: { kind: 'die', byRoll: byPairs(
      [{ kind: 'attack', amount: 2 }, { kind: 'daze', amount: 1 }],
      [{ kind: 'attack', amount: 2 }],
      [{ kind: 'applyWeak', amount: 1 }],
    ) },
  },

  acid_slime_wda: {
    id: 'acid_slime_wda', name: 'Acid Slime', artId: 'acid_slime', hpByPlayers: [5, 5, 5, 5],
    pattern: { kind: 'die', byRoll: byPairs(
      [{ kind: 'applyWeak', amount: 1 }],
      [{ kind: 'attack', amount: 2 }, { kind: 'daze', amount: 1 }],
      [{ kind: 'attack', amount: 2 }],
    ) },
  },

  acid_slime_wad: {
    id: 'acid_slime_wad', name: 'Acid Slime', artId: 'acid_slime', hpByPlayers: [5, 5, 5, 5],
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
    artId: 'jaw_worm',
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
    artId: 'jaw_worm',
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

  chosen_14: {
    id: 'chosen_14', name: 'Chosen', hpByPlayers: [14, 14, 14, 14],
    pattern: { kind: 'cube', slots: [
      { actions: [{ kind: 'attack', amount: 1, aoe: true }, { kind: 'daze', amount: 1, aoe: true }], once: true },
      { actions: [{ kind: 'attack', amount: 3 }, { kind: 'daze', amount: 2 }] },
      { actions: [{ kind: 'attack', amount: 5 }, { kind: 'gainStrength', amount: 1 }] },
    ] },
  },

  chosen_16: {
    id: 'chosen_16', name: 'Chosen', hpByPlayers: [16, 16, 16, 16],
    pattern: { kind: 'cube', slots: [
      { actions: [{ kind: 'attack', amount: 1, aoe: true }, { kind: 'daze', amount: 1, aoe: true }], once: true },
      { actions: [{ kind: 'attack', amount: 3 }, { kind: 'daze', amount: 2 }] },
      { actions: [{ kind: 'attack', amount: 5 }, { kind: 'gainStrength', amount: 1 }] },
    ] },
  },

  mugger: {
    id: 'mugger', name: 'Mugger', hpByPlayers: [12, 12, 12, 12],
    pattern: { kind: 'cube', slots: [
      { actions: [{ kind: 'attack', amount: 2 }, { kind: 'block', amount: 1 }], once: true },
      { actions: [{ kind: 'attack', amount: 2 }], once: true },
      { actions: [{ kind: 'attack', amount: 4 }, { kind: 'block', amount: 2 }], once: true },
      { actions: [{ kind: 'loseGold', amount: 2 }, { kind: 'leave' }], once: true },
    ] },
  },

  looter_hard: {
    id: 'looter_hard', name: 'Looter', hpByPlayers: [10, 10, 10, 10],
    pattern: { kind: 'cube', slots: [
      { actions: [{ kind: 'attack', amount: 2 }], once: true },
      { actions: [{ kind: 'attack', amount: 3 }, { kind: 'block', amount: 1 }], once: true },
      { actions: [{ kind: 'loseGold', amount: 2 }, { kind: 'leave' }], once: true },
    ] },
  },

  centurion_b3: {
    id: 'centurion_b3', name: 'Centurion', hpByPlayers: [15, 15, 15, 15],
    pattern: { kind: 'die', byRoll: {
      1: [{ kind: 'blockNamed', defId: 'mystic', amount: 3 }],
      2: [{ kind: 'blockNamed', defId: 'mystic', amount: 3 }],
      3: [{ kind: 'blockNamed', defId: 'mystic', amount: 3 }],
      4: [{ kind: 'attack', amount: 3 }], 5: [{ kind: 'attack', amount: 3 }], 6: [{ kind: 'attack', amount: 3 }],
    } },
    ability: { kind: 'furyOnAllyDeath', allyDefId: 'mystic', strength: 1, actions: [{ kind: 'attack', amount: 3 }] },
  },

  centurion_3b: {
    id: 'centurion_3b', name: 'Centurion', hpByPlayers: [15, 15, 15, 15],
    pattern: { kind: 'die', byRoll: {
      1: [{ kind: 'attack', amount: 3 }], 2: [{ kind: 'attack', amount: 3 }], 3: [{ kind: 'attack', amount: 3 }],
      4: [{ kind: 'blockNamed', defId: 'mystic', amount: 3 }],
      5: [{ kind: 'blockNamed', defId: 'mystic', amount: 3 }],
      6: [{ kind: 'blockNamed', defId: 'mystic', amount: 3 }],
    } },
    ability: { kind: 'furyOnAllyDeath', allyDefId: 'mystic', strength: 1, actions: [{ kind: 'attack', amount: 3 }] },
  },

  mystic: {
    id: 'mystic', name: 'Mystic', hpByPlayers: [12, 12, 12, 12], actsLast: true,
    pattern: { kind: 'die', byRoll: byPairs(
      [{ kind: 'healAllEnemies', amount: 3 }],
      [{ kind: 'attack', amount: 2 }, { kind: 'applyWeak', amount: 1 }],
      [{ kind: 'strengthenAllEnemies', amount: 1 }],
    ) },
  },

  mystic_2sh: {
    id: 'mystic_2sh', name: 'Mystic', hpByPlayers: [12, 12, 12, 12], actsLast: true,
    pattern: { kind: 'die', byRoll: byPairs(
      [{ kind: 'attack', amount: 2 }, { kind: 'applyWeak', amount: 1 }],
      [{ kind: 'strengthenAllEnemies', amount: 1 }],
      [{ kind: 'healAllEnemies', amount: 3 }],
    ) },
  },

  byrd_encounter: {
    id: 'byrd_encounter', name: 'Byrd', hpByPlayers: [5, 5, 5, 5],
    pattern: { kind: 'die', byRoll: byPairs(
      [{ kind: 'attack', amount: 1, times: 2 }],
      [{ kind: 'gainStrength', amount: 1 }],
      [{ kind: 'attack', amount: 3 }],
    ) },
    ability: { kind: 'flying', maxDamagePerHit: 1 },
  },

  byrd_s13: {
    id: 'byrd_s13', name: 'Byrd', hpByPlayers: [4, 4, 4, 4],
    pattern: { kind: 'die', byRoll: byPairs(
      [{ kind: 'gainStrength', amount: 1 }],
      [{ kind: 'attack', amount: 1, times: 2 }],
      [{ kind: 'attack', amount: 3 }],
    ) },
    ability: { kind: 'flying', maxDamagePerHit: 1 },
  },

  byrd_s31: {
    id: 'byrd_s31', name: 'Byrd', hpByPlayers: [4, 4, 4, 4],
    pattern: { kind: 'die', byRoll: byPairs(
      [{ kind: 'gainStrength', amount: 1 }],
      [{ kind: 'attack', amount: 3 }],
      [{ kind: 'attack', amount: 1, times: 2 }],
    ) },
    ability: { kind: 'flying', maxDamagePerHit: 1 },
  },

  byrd_31s: {
    id: 'byrd_31s', name: 'Byrd', hpByPlayers: [4, 4, 4, 4],
    pattern: { kind: 'die', byRoll: byPairs(
      [{ kind: 'attack', amount: 3 }],
      [{ kind: 'attack', amount: 1, times: 2 }],
      [{ kind: 'gainStrength', amount: 1 }],
    ) },
    ability: { kind: 'flying', maxDamagePerHit: 1 },
  },

  snake_plant: {
    id: 'snake_plant', name: 'Snake Plant', hpByPlayers: [17, 17, 17, 17],
    pattern: { kind: 'die', byRoll: byPairs(
      [{ kind: 'attackSequence', hits: [{ amount: 3 }, { amount: 2 }] }],
      [{ kind: 'attackSequence', hits: [{ amount: 3 }, { amount: 2 }] }],
      [{ kind: 'applyWeak', amount: 2 }],
    ) },
    ascension: [{ min: 7, pattern: { kind: 'die', byRoll: byPairs(
      [{ kind: 'attackSequence', hits: [{ amount: 3 }, { amount: 2, aoe: true }] }],
      [{ kind: 'attackSequence', hits: [{ amount: 3 }, { amount: 2, aoe: true }] }],
      [{ kind: 'applyWeak', amount: 2 }],
    ) } }],
  },

  shelled_parasite: {
    id: 'shelled_parasite', name: 'Shelled Parasite', hpByPlayers: [18, 18, 18, 18],
    pattern: { kind: 'cube', slots: [
      { actions: [{ kind: 'attack', amount: 4 }, { kind: 'block', amount: 2 }], once: true },
      { actions: [{ kind: 'attack', amount: 3 }, { kind: 'applyVulnerable', amount: 1 }, { kind: 'block', amount: 2 }] },
      { actions: [{ kind: 'attack', amount: 2, aoe: true }, { kind: 'block', amount: 2 }] },
    ] },
    ascension: [{ min: 7, hpByPlayers: [16, 16, 16, 16] }],
  },

  fungi_beast_a7: {
    id: 'fungi_beast_a7', name: 'Fungi Beast', hpByPlayers: [6, 6, 6, 6],
    pattern: { kind: 'die', byRoll: byPairs(
      [{ kind: 'gainStrength', amount: 1 }],
      [{ kind: 'attack', amount: 2 }],
      [{ kind: 'attack', amount: 1 }, { kind: 'gainStrength', amount: 1 }],
    ) },
    ability: { kind: 'sporeCloud', vulnerable: 1 },
  },

  snecko: {
    id: 'snecko', name: 'Snecko', hpByPlayers: [23, 23, 23, 23],
    pattern: { kind: 'die', byRoll: byPairs(
      [{ kind: 'attack', amount: 3 }],
      [{ kind: 'attack', amount: 5 }],
      [{ kind: 'attack', amount: 2 }],
    ) },
    ability: { kind: 'confusion', byRoll: { 1: 2, 2: 2, 3: 1, 4: 1, 5: 3, 6: 3 } },
  },

  spheric_guardian: {
    id: 'spheric_guardian', name: 'Spheric Guardian', hpByPlayers: [5, 5, 5, 5],
    startingBlock: 10, retainsBlock: true,
    ability: { kind: 'barricade', startingBlock: 10 },
    pattern: { kind: 'cube', slots: [
      { actions: [{ kind: 'attack', amount: 2 }, { kind: 'block', amount: 5 }] },
      { actions: [{ kind: 'attack', amount: 5 }] },
    ] },
  },

  blue_slaver_wd3: {
    id: 'blue_slaver_wd3', name: 'Blue Slaver', hpByPlayers: [10, 10, 10, 10],
    pattern: { kind: 'die', byRoll: byPairs(
      [{ kind: 'attack', amount: 2 }, { kind: 'applyWeak', amount: 1 }],
      [{ kind: 'attack', amount: 2 }, { kind: 'daze', amount: 1 }],
      [{ kind: 'attack', amount: 3 }],
    ) },
  },

  blue_slaver_w3d: {
    id: 'blue_slaver_w3d', name: 'Blue Slaver', hpByPlayers: [10, 10, 10, 10],
    pattern: { kind: 'die', byRoll: byPairs(
      [{ kind: 'attack', amount: 2 }, { kind: 'applyWeak', amount: 1 }],
      [{ kind: 'attack', amount: 3 }],
      [{ kind: 'attack', amount: 2 }, { kind: 'daze', amount: 1 }],
    ) },
  },

  blue_slaver_dw3: {
    id: 'blue_slaver_dw3', name: 'Blue Slaver', hpByPlayers: [10, 10, 10, 10],
    pattern: { kind: 'die', byRoll: byPairs(
      [{ kind: 'attack', amount: 2 }, { kind: 'daze', amount: 1 }],
      [{ kind: 'attack', amount: 2 }, { kind: 'applyWeak', amount: 1 }],
      [{ kind: 'attack', amount: 3 }],
    ) },
  },

  blue_slaver_3wd: {
    id: 'blue_slaver_3wd', name: 'Blue Slaver', hpByPlayers: [10, 10, 10, 10],
    pattern: { kind: 'die', byRoll: byPairs(
      [{ kind: 'attack', amount: 3 }],
      [{ kind: 'attack', amount: 2 }, { kind: 'applyWeak', amount: 1 }],
      [{ kind: 'attack', amount: 2 }, { kind: 'daze', amount: 1 }],
    ) },
  },

  red_slaver_3vd: {
    id: 'red_slaver_3vd', name: 'Red Slaver', hpByPlayers: [10, 10, 10, 10],
    pattern: { kind: 'die', byRoll: byPairs(
      [{ kind: 'attack', amount: 3 }],
      [{ kind: 'attack', amount: 2 }, { kind: 'applyVulnerable', amount: 1 }, { kind: 'actsLast' }],
      [{ kind: 'attack', amount: 2 }, { kind: 'daze', amount: 1 }],
    ) },
  },

  red_slaver_3dv: {
    id: 'red_slaver_3dv', name: 'Red Slaver', hpByPlayers: [10, 10, 10, 10],
    pattern: { kind: 'die', byRoll: byPairs(
      [{ kind: 'attack', amount: 3 }],
      [{ kind: 'attack', amount: 2 }, { kind: 'daze', amount: 1 }],
      [{ kind: 'attack', amount: 2 }, { kind: 'applyVulnerable', amount: 1 }, { kind: 'actsLast' }],
    ) },
  },

  red_slaver_v3d: {
    id: 'red_slaver_v3d', name: 'Red Slaver', hpByPlayers: [10, 10, 10, 10],
    pattern: { kind: 'die', byRoll: byPairs(
      [{ kind: 'attack', amount: 2 }, { kind: 'applyVulnerable', amount: 1 }, { kind: 'actsLast' }],
      [{ kind: 'attack', amount: 3 }],
      [{ kind: 'attack', amount: 2 }, { kind: 'daze', amount: 1 }],
    ) },
  },

  red_slaver_dv3: {
    id: 'red_slaver_dv3', name: 'Red Slaver', hpByPlayers: [10, 10, 10, 10],
    pattern: { kind: 'die', byRoll: byPairs(
      [{ kind: 'attack', amount: 2 }, { kind: 'daze', amount: 1 }],
      [{ kind: 'attack', amount: 2 }, { kind: 'applyVulnerable', amount: 1 }, { kind: 'actsLast' }],
      [{ kind: 'attack', amount: 3 }],
    ) },
  },

  book_of_stabbing: {
    id: 'book_of_stabbing', name: 'Book of Stabbing', elite: true,
    hpByPlayers: [30, 60, 90, 120],
    pattern: { kind: 'cube', slots: [
      { actions: [{ kind: 'attack', amount: 1, times: 2, aoe: true }, { kind: 'gainStrength', amount: 1 }] },
      { actions: [{ kind: 'attack', amount: 3 }, { kind: 'gainStrength', amount: 1 }] },
    ] },
    ability: { kind: 'painfulStabs', daze: 1 },
    ascension: [
      { min: 1, hpByPlayers: [35, 70, 105, 140], pattern: { kind: 'cube', slots: [
        { actions: [{ kind: 'attack', amount: 3 }, { kind: 'gainStrength', amount: 1 }] },
        { actions: [{ kind: 'attack', amount: 1, times: 2, aoe: true }, { kind: 'gainStrength', amount: 1 }] },
      ] } },
      { min: 12, hpByPlayers: [36, 74, 118, 162], pattern: { kind: 'cube', slots: [
        { actions: [{ kind: 'attack', amount: 4 }, { kind: 'gainStrength', amount: 1 }] },
        { actions: [{ kind: 'attack', amount: 1, times: 2, aoe: true }, { kind: 'gainStrength', amount: 1 }] },
      ] } },
    ],
  },

  gremlin_leader: {
    id: 'gremlin_leader', name: 'Gremlin Leader', elite: true,
    hpByPlayers: [30, 60, 90, 120],
    pattern: { kind: 'cube', slots: [
      { actions: [{ kind: 'attack', amount: 2, aoe: true }, { kind: 'blockAllEnemies', amount: 1 }, { kind: 'strengthenAllEnemies', amount: 1 }] },
      { actions: [{ kind: 'attack', amount: 5, aoe: true }] },
      { actions: [{ kind: 'reviveAll', group: 'gremlin' }] },
    ] },
    ascension: [
      { min: 1, hpByPlayers: [35, 70, 105, 140], pattern: { kind: 'cube', slots: [
        { actions: [{ kind: 'attack', amount: 3, aoe: true }, { kind: 'blockAllEnemies', amount: 1 }, { kind: 'strengthenAllEnemies', amount: 1 }] },
        { actions: [{ kind: 'attack', amount: 5, aoe: true }] },
        { actions: [{ kind: 'reviveAll', group: 'gremlin' }] },
      ] } },
      { min: 12, hpByPlayers: [40, 82, 130, 172], pattern: { kind: 'cube', slots: [
        { actions: [{ kind: 'attack', amount: 3, aoe: true }, { kind: 'blockAllEnemies', amount: 1 }, { kind: 'strengthenAllEnemies', amount: 1 }] },
        { actions: [{ kind: 'attack', amount: 5, aoe: true }] },
        { actions: [{ kind: 'reviveAll', group: 'gremlin' }, { kind: 'strengthenAllEnemies', amount: 1 }] },
      ] } },
    ],
  },

  taskmaster: {
    id: 'taskmaster', name: 'Taskmaster', elite: true,
    hpByPlayers: [13, 28, 42, 56],
    pattern: { kind: 'single', actions: [{ kind: 'attack', amount: 1, aoe: true }, { kind: 'gainStrength', amount: 1 }] },
    ascension: [
      { min: 1, hpByPlayers: [15, 32, 48, 64], pattern: { kind: 'cube', slots: [
        { actions: [{ kind: 'attack', amount: 1, aoe: true }], once: true },
        { actions: [{ kind: 'attack', amount: 2, aoe: true }, { kind: 'daze', amount: 2, aoe: true }, { kind: 'gainStrength', amount: 1 }] },
      ] } },
      { min: 12, hpByPlayers: [16, 34, 56, 82], pattern: { kind: 'single', actions: [
        { kind: 'attack', amount: 1, aoe: true }, { kind: 'daze', amount: 1, aoe: true }, { kind: 'gainStrength', amount: 1 },
      ] } },
    ],
  },

  // Act III encounters and their finite Summons deck variants.
  jaw_worm_act3: {
    id: 'jaw_worm_act3', name: 'Jaw Worm', hpByPlayers: [10, 10, 10, 10],
    pattern: { kind: 'die', byRoll: byPairs(
      [{ kind: 'block', amount: 3 }, { kind: 'gainStrength', amount: 1 }],
      [{ kind: 'attack', amount: 3 }, { kind: 'block', amount: 1 }],
      [{ kind: 'attack', amount: 4 }],
    ) },
  },

  jaw_worm_summon: {
    id: 'jaw_worm_summon', name: 'Jaw Worm', hpByPlayers: [10, 10, 10, 10],
    pattern: { kind: 'die', byRoll: byPairs(
      [{ kind: 'attack', amount: 4 }],
      [{ kind: 'block', amount: 3 }, { kind: 'gainStrength', amount: 1 }],
      [{ kind: 'attack', amount: 3 }, { kind: 'block', amount: 1 }],
    ) },
  },

  spire_growth: {
    id: 'spire_growth', name: 'Spire Growth', hpByPlayers: [17, 17, 17, 17],
    pattern: { kind: 'firstThenDie', first: [{ kind: 'idle' }], byRoll: {
      1: [{ kind: 'attackSequence', hits: [{ amount: 2 }, { amount: 3, aoe: true }] }],
      2: [{ kind: 'attackSequence', hits: [{ amount: 2 }, { amount: 3, aoe: true }] }],
      3: [{ kind: 'attackSequence', hits: [{ amount: 2 }, { amount: 3, aoe: true }] }],
      4: [{ kind: 'attackSequence', hits: [{ amount: 4 }, { amount: 2, aoe: true }] }],
      5: [{ kind: 'attackSequence', hits: [{ amount: 4 }, { amount: 2, aoe: true }] }],
      6: [{ kind: 'attackSequence', hits: [{ amount: 4 }, { amount: 2, aoe: true }] }],
    } },
  },

  repulsor: {
    id: 'repulsor', name: 'Repulsor', hpByPlayers: [7, 7, 7, 7],
    pattern: { kind: 'die', byRoll: {
      1: [{ kind: 'attack', amount: 1 }, { kind: 'daze', amount: 2 }],
      2: [{ kind: 'attack', amount: 1 }, { kind: 'daze', amount: 2 }],
      3: [{ kind: 'attack', amount: 1 }, { kind: 'daze', amount: 2 }],
      4: [{ kind: 'attack', amount: 3 }], 5: [{ kind: 'attack', amount: 3 }], 6: [{ kind: 'attack', amount: 3 }],
    } },
    ascension: [{ min: 7, pattern: { kind: 'die', byRoll: {
      1: [{ kind: 'attack', amount: 1 }, { kind: 'daze', amount: 2 }],
      2: [{ kind: 'attack', amount: 1 }, { kind: 'daze', amount: 2 }],
      3: [{ kind: 'attack', amount: 1 }, { kind: 'daze', amount: 2 }],
      4: [{ kind: 'attack', amount: 3 }], 5: [{ kind: 'attack', amount: 3 }], 6: [{ kind: 'attack', amount: 3 }],
    } } }],
  },

  repulsor_summon: {
    id: 'repulsor_summon', name: 'Repulsor', hpByPlayers: [7, 7, 7, 7],
    pattern: { kind: 'die', byRoll: {
      1: [{ kind: 'attack', amount: 3 }], 2: [{ kind: 'attack', amount: 3 }], 3: [{ kind: 'attack', amount: 3 }],
      4: [{ kind: 'attack', amount: 1 }, { kind: 'daze', amount: 2 }],
      5: [{ kind: 'attack', amount: 1 }, { kind: 'daze', amount: 2 }],
      6: [{ kind: 'attack', amount: 1 }, { kind: 'daze', amount: 2 }],
    } },
  },

  exploder: {
    id: 'exploder', name: 'Exploder', hpByPlayers: [8, 8, 8, 8],
    pattern: { kind: 'cube', slots: [
      { actions: [{ kind: 'attack', amount: 3 }], once: true },
      { actions: [{ kind: 'idle' }], once: true },
      { actions: [{ kind: 'attack', amount: 10, aoe: true }, { kind: 'die' }], once: true },
    ] },
  },

  exploder_summon: {
    id: 'exploder_summon', name: 'Exploder', hpByPlayers: [8, 8, 8, 8],
    pattern: { kind: 'cube', slots: [
      { actions: [{ kind: 'attack', amount: 3 }], once: true },
      { actions: [{ kind: 'idle' }], once: true },
      { actions: [{ kind: 'attack', amount: 10, aoe: true }, { kind: 'die' }], once: true },
    ] },
  },

  orb_walker_3ws: {
    id: 'orb_walker_3ws', name: 'Orb Walker', hpByPlayers: [22, 22, 22, 22],
    pattern: { kind: 'die', byRoll: {
      1: [{ kind: 'attack', amount: 3 }, { kind: 'daze', amount: 1 }, { kind: 'gainStrength', amount: 1 }],
      2: [{ kind: 'attack', amount: 3 }, { kind: 'daze', amount: 1 }, { kind: 'gainStrength', amount: 1 }],
      3: [{ kind: 'attack', amount: 3 }, { kind: 'daze', amount: 1 }, { kind: 'gainStrength', amount: 1 }],
      4: [{ kind: 'attack', amount: 2 }, { kind: 'gainStrength', amount: 2 }],
      5: [{ kind: 'attack', amount: 2 }, { kind: 'gainStrength', amount: 2 }],
      6: [{ kind: 'attack', amount: 2 }, { kind: 'gainStrength', amount: 2 }],
    } },
  },

  orb_walker_2s: {
    id: 'orb_walker_2s', name: 'Orb Walker', hpByPlayers: [22, 22, 22, 22],
    pattern: { kind: 'die', byRoll: {
      1: [{ kind: 'attack', amount: 2 }, { kind: 'gainStrength', amount: 2 }],
      2: [{ kind: 'attack', amount: 2 }, { kind: 'gainStrength', amount: 2 }],
      3: [{ kind: 'attack', amount: 2 }, { kind: 'gainStrength', amount: 2 }],
      4: [{ kind: 'attack', amount: 3 }, { kind: 'daze', amount: 1 }, { kind: 'gainStrength', amount: 1 }],
      5: [{ kind: 'attack', amount: 3 }, { kind: 'daze', amount: 1 }, { kind: 'gainStrength', amount: 1 }],
      6: [{ kind: 'attack', amount: 3 }, { kind: 'daze', amount: 1 }, { kind: 'gainStrength', amount: 1 }],
    } },
  },

  transient: {
    id: 'transient', name: 'Transient', hpByPlayers: [99, 99, 99, 99],
    pattern: { kind: 'cube', slots: [
      { actions: [{ kind: 'attack', amount: 6 }], once: true },
      { actions: [{ kind: 'attack', amount: 9 }], once: true },
      { actions: [{ kind: 'attack', amount: 12 }], once: true },
      { actions: [{ kind: 'attack', amount: 15 }, { kind: 'die' }], once: true },
    ] },
    ability: { kind: 'shift' },
  },

  maw: {
    id: 'maw', name: 'The Maw', hpByPlayers: [28, 28, 28, 28],
    pattern: { kind: 'cube', slots: [
      { actions: [{ kind: 'applyVulnerable', amount: 1, aoe: true }, { kind: 'actsLast' }], once: true },
      { actions: [{ kind: 'attack', amount: 2, times: 2 }] },
      { actions: [{ kind: 'gainStrength', amount: 2 }] },
      { actions: [{ kind: 'attack', amount: 6 }] },
    ] },
    ascension: [{ min: 7, pattern: { kind: 'cube', slots: [
      { actions: [{ kind: 'attack', amount: 2, aoe: true }, { kind: 'applyVulnerable', amount: 1, aoe: true }, { kind: 'actsLast' }], once: true },
      { actions: [{ kind: 'attack', amount: 2, times: 2 }] },
      { actions: [{ kind: 'gainStrength', amount: 2 }] },
      { actions: [{ kind: 'attack', amount: 8 }] },
    ] } }],
  },

  writhing_mass: {
    id: 'writhing_mass', name: 'Writhing Mass', hpByPlayers: [17, 17, 17, 17],
    pattern: { kind: 'die', byRoll: {
      1: [{ kind: 'applyVulnerable', amount: 1, aoe: true }, { kind: 'actsLast' }],
      2: [{ kind: 'daze', amount: 2, aoe: true }],
      3: [{ kind: 'attack', amount: 3, times: 2 }],
      4: [{ kind: 'attack', amount: 5 }, { kind: 'block', amount: 5 }],
      5: [{ kind: 'attack', amount: 7 }],
      6: [{ kind: 'attack', amount: 4 }, { kind: 'applyWeak', amount: 1 }],
    } },
    ability: { kind: 'reactiveReroll' },
  },

  darkling: {
    id: 'darkling', name: 'Darkling', hpByPlayers: [8, 8, 8, 8],
    pattern: { kind: 'die', byRoll: byPairs(
      [{ kind: 'attack', amount: 2, times: 2 }],
      [{ kind: 'block', amount: 3 }, { kind: 'gainStrength', amount: 1 }],
      [{ kind: 'attack', amount: 3 }, { kind: 'healSelf', amount: 2 }],
    ) },
    ability: { kind: 'regrow' },
  },

  darkling_bha: {
    id: 'darkling_bha', name: 'Darkling', hpByPlayers: [8, 8, 8, 8],
    pattern: { kind: 'die', byRoll: byPairs(
      [{ kind: 'block', amount: 3 }, { kind: 'gainStrength', amount: 1 }],
      [{ kind: 'attack', amount: 3 }, { kind: 'healSelf', amount: 2 }],
      [{ kind: 'attack', amount: 2, times: 2 }],
    ) },
    ability: { kind: 'regrow' },
  },

  darkling_hab: {
    id: 'darkling_hab', name: 'Darkling', hpByPlayers: [8, 8, 8, 8],
    pattern: { kind: 'die', byRoll: byPairs(
      [{ kind: 'attack', amount: 3 }, { kind: 'healSelf', amount: 2 }],
      [{ kind: 'attack', amount: 2, times: 2 }],
      [{ kind: 'block', amount: 3 }, { kind: 'gainStrength', amount: 1 }],
    ) },
    ability: { kind: 'regrow' },
  },

  spiker_add: {
    id: 'spiker_add', name: 'Spiker', hpByPlayers: [10, 10, 10, 10],
    pattern: { kind: 'die', byRoll: {
      1: [{ kind: 'addAbilityCube', amount: 1 }], 2: [{ kind: 'addAbilityCube', amount: 1 }], 3: [{ kind: 'addAbilityCube', amount: 1 }],
      4: [{ kind: 'attack', amount: 2 }], 5: [{ kind: 'attack', amount: 2 }], 6: [{ kind: 'attack', amount: 2 }],
    } },
    ability: { kind: 'thorns', damagePerCube: 1, startingCubes: 1, maxCubes: 5 },
  },

  spiker_attack: {
    id: 'spiker_attack', name: 'Spiker', hpByPlayers: [10, 10, 10, 10],
    pattern: { kind: 'die', byRoll: {
      1: [{ kind: 'attack', amount: 2 }], 2: [{ kind: 'attack', amount: 2 }], 3: [{ kind: 'attack', amount: 2 }],
      4: [{ kind: 'addAbilityCube', amount: 1 }], 5: [{ kind: 'addAbilityCube', amount: 1 }], 6: [{ kind: 'addAbilityCube', amount: 1 }],
    } },
    ability: { kind: 'thorns', damagePerCube: 1, startingCubes: 1, maxCubes: 5 },
  },

  dagger: {
    id: 'dagger', name: 'Dagger', hpByPlayers: [5, 5, 5, 5],
    pattern: { kind: 'cube', slots: [
      { actions: [{ kind: 'attack', amount: 2 }], once: true },
      { actions: [{ kind: 'attack', amount: 5 }, { kind: 'die' }], once: true },
    ] },
  },

  giant_head: {
    id: 'giant_head', name: 'Giant Head', elite: true,
    hpByPlayers: [80, 160, 240, 320],
    pattern: { kind: 'cube', slots: [
      { actions: [{ kind: 'idle' }], once: true },
      { actions: [{ kind: 'idle' }], once: true },
      { actions: [{ kind: 'idle' }], once: true },
      { actions: [{ kind: 'attack', amount: 7, aoe: true }, { kind: 'gainStrength', amount: 1 }] },
    ] },
    ability: { kind: 'slow', damagePerHit: 1 },
    ascension: [
      { min: 1, hpByPlayers: [85, 170, 255, 340], pattern: { kind: 'cube', slots: [
        { actions: [{ kind: 'idle' }], once: true },
        { actions: [{ kind: 'attack', amount: 5, aoe: true }], once: true },
        { actions: [{ kind: 'idle' }], once: true },
        { actions: [{ kind: 'attack', amount: 8, aoe: true }, { kind: 'gainStrength', amount: 1 }] },
      ] } },
      { min: 12, hpByPlayers: [90, 185, 280, 380], pattern: { kind: 'cube', slots: [
        { actions: [{ kind: 'idle' }], once: true },
        { actions: [{ kind: 'attack', amount: 6, aoe: true }], once: true },
        { actions: [{ kind: 'idle' }], once: true },
        { actions: [{ kind: 'attack', amount: 9, aoe: true }, { kind: 'gainStrength', amount: 1 }] },
      ] } },
    ],
  },

  nemesis: {
    id: 'nemesis', name: 'Nemesis', elite: true,
    hpByPlayers: [30, 60, 90, 120],
    pattern: { kind: 'cube', slots: [
      { actions: [{ kind: 'status', card: 'burn', amount: 4, aoe: true }], once: true },
      { actions: [{ kind: 'attack', amount: 4, aoe: true }], once: true },
      { actions: [{ kind: 'attack', amount: 2, times: 2, aoe: true }, { kind: 'status', card: 'burn', amount: 1, aoe: true }] },
      { actions: [{ kind: 'attack', amount: 7, aoe: true }] },
    ] },
    ability: { kind: 'immuneOnSlots', slots: [1, 3] },
    ascension: [
      { min: 1, hpByPlayers: [35, 70, 105, 140], pattern: { kind: 'cube', slots: [
        { actions: [{ kind: 'status', card: 'burn', amount: 5, aoe: true }], once: true },
        { actions: [{ kind: 'attack', amount: 5, aoe: true }], once: true },
        { actions: [{ kind: 'attack', amount: 2, times: 2, aoe: true }, { kind: 'status', card: 'burn', amount: 1, aoe: true }] },
        { actions: [{ kind: 'attack', amount: 8, aoe: true }] },
      ] } },
      { min: 12, hpByPlayers: [36, 74, 116, 162], pattern: { kind: 'cube', slots: [
        { actions: [{ kind: 'status', card: 'burn', amount: 5, aoe: true }], once: true },
        { actions: [{ kind: 'attack', amount: 6, aoe: true }], once: true },
        { actions: [{ kind: 'attack', amount: 2, times: 3, aoe: true }, { kind: 'status', card: 'burn', amount: 2, aoe: true }] },
        { actions: [{ kind: 'attack', amount: 8, aoe: true }] },
      ] } },
    ],
  },

  reptomancer: {
    id: 'reptomancer', name: 'Reptomancer', elite: true,
    hpByPlayers: [35, 70, 105, 140],
    pattern: { kind: 'cube', slots: [
      { actions: [{ kind: 'summonUntil', defId: 'dagger', perPlayer: 2 }] },
      { actions: [{ kind: 'attack', amount: 3, times: 2, aoe: true }] },
      { actions: [{ kind: 'attack', amount: 7, aoe: true }] },
    ] },
    ability: { kind: 'rally', summonDefId: 'dagger' },
    ascension: [
      { min: 1, hpByPlayers: [40, 80, 120, 160], pattern: { kind: 'cube', slots: [
        { actions: [{ kind: 'summonUntil', defId: 'dagger', perPlayer: 2 }] },
        { actions: [{ kind: 'attack', amount: 7, aoe: true }, { kind: 'daze', amount: 1, aoe: true }] },
        { actions: [{ kind: 'attack', amount: 4, times: 2, aoe: true }, { kind: 'gainStrength', amount: 1 }] },
      ] } },
      { min: 12, hpByPlayers: [42, 90, 140, 194], pattern: { kind: 'cube', slots: [
        { actions: [{ kind: 'summonUntil', defId: 'dagger', perPlayer: 2 }] },
        { actions: [{ kind: 'attack', amount: 7, aoe: true }, { kind: 'daze', amount: 2, aoe: true }] },
        { actions: [{ kind: 'attack', amount: 4, times: 2, aoe: true }, { kind: 'gainStrength', amount: 1 }] },
      ] } },
    ],
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

  slime_boss: {
    id: 'slime_boss', name: 'Slime Boss', isBoss: true, bossAct: 1,
    hpByPlayers: perPlayer(22),
    pattern: { kind: 'cube', slots: [
      { actions: [{ kind: 'status', card: 'slimed', amount: 3, aoe: true }] },
      { actions: [{ kind: 'attack', amount: 3 }, { kind: 'status', card: 'slimed', amount: 2, aoe: true }] },
      { actions: [{ kind: 'attack', amount: 6 }] },
    ] },
    ability: { kind: 'splitOnDeath', defIds: ['large_slime', 'acid_slime', 'spike_slime'] },
    ascension: [{ min: 10, hpByPlayers: [23, 46, 68, 92], pattern: { kind: 'cube', slots: [
      { actions: [{ kind: 'status', card: 'slimed', amount: 4, aoe: true }] },
      { actions: [{ kind: 'attack', amount: 3 }, { kind: 'status', card: 'slimed', amount: 2, aoe: true }] },
      { actions: [{ kind: 'attack', amount: 6 }] },
    ] }, ability: { kind: 'splitOnDeath', defIds: ['large_slime', 'acid_slime', 'spike_slime'], largeSlimeStrength: 1 } }],
  },

  guardian_attack: {
    id: 'guardian_attack', name: 'The Guardian', isBoss: true, bossAct: 1,
    hpByPlayers: perPlayer(40), retainsBlock: true,
    pattern: { kind: 'cube', slots: [
      { actions: [{ kind: 'attack', amount: 2 }, { kind: 'block', amount: 5, perPlayer: true }] },
      { actions: [{ kind: 'guardianModeShift', amount: 6 }] },
    ] },
    ascension: [{ min: 10, pattern: { kind: 'cube', slots: [
      { actions: [{ kind: 'attack', amount: 2 }, { kind: 'block', amount: 6, perPlayer: true }] },
      { actions: [{ kind: 'guardianModeShift', amount: 7 }] },
    ] } }],
  },

  guardian_defensive: {
    id: 'guardian_defensive', name: 'The Guardian', isBoss: true, bossAct: 1,
    hpByPlayers: perPlayer(40), artId: 'guardian_defensive',
    pattern: { kind: 'cube', slots: [
      { actions: [{ kind: 'attack', amount: 2 }] },
      { actions: [{ kind: 'attack', amount: 4 }, { kind: 'gainStrength', amount: 1 }, { kind: 'transform', defId: 'guardian_attack' }] },
    ] },
    ability: { kind: 'sharpHide', damage: 1 },
    ascension: [{ min: 10, pattern: { kind: 'cube', slots: [
      { actions: [{ kind: 'attack', amount: 3 }] },
      { actions: [{ kind: 'attack', amount: 4 }, { kind: 'gainStrength', amount: 1 }, { kind: 'transform', defId: 'guardian_attack' }] },
    ] } }],
  },

  hexaghost: {
    id: 'hexaghost', name: 'Hexaghost', isBoss: true, bossAct: 1,
    hpByPlayers: [36, 75, 112, 150],
    pattern: { kind: 'cube', slots: [
      { actions: [{ kind: 'attack', amount: 1 }, { kind: 'status', card: 'burn', amount: 1, aoe: true }] },
      { actions: [{ kind: 'attack', amount: 2, times: 2 }, { kind: 'status', card: 'burn', amount: 1, aoe: true }] },
      { actions: [{ kind: 'status', card: 'burn', amount: 2, aoe: true }] },
      { actions: [{ kind: 'attack', amount: 3 }, { kind: 'block', amount: 5 }] },
      { actions: [{ kind: 'attack', amount: 2 }, { kind: 'status', card: 'burn', amount: 1, aoe: true }] },
      { actions: [{ kind: 'attack', amount: 3, times: 2 }, { kind: 'status', card: 'burn', amount: 2, aoe: true }, { kind: 'gainStrength', amount: 1 }] },
    ] },
    ascension: [{ min: 10, hpByPlayers: [38, 80, 120, 160], pattern: { kind: 'cube', slots: [
      { actions: [{ kind: 'attack', amount: 1 }, { kind: 'status', card: 'burn', amount: 2, aoe: true }] },
      { actions: [{ kind: 'attack', amount: 2, times: 2 }, { kind: 'status', card: 'burn', amount: 1, aoe: true }] },
      { actions: [{ kind: 'status', card: 'burn', amount: 2, aoe: true }] },
      { actions: [{ kind: 'attack', amount: 4 }, { kind: 'block', amount: 5 }] },
      { actions: [{ kind: 'attack', amount: 3 }, { kind: 'status', card: 'burn', amount: 1, aoe: true }] },
      { actions: [{ kind: 'attack', amount: 3, times: 2 }, { kind: 'status', card: 'burn', amount: 2, aoe: true }, { kind: 'gainStrength', amount: 1 }] },
    ] } }],
  },

  the_collector: {
    id: 'the_collector', name: 'The Collector', isBoss: true, bossAct: 2,
    hpByPlayers: perPlayer(57),
    pattern: { kind: 'cube', slots: [
      { actions: [{ kind: 'summonUntil', defId: 'torch_head', perPlayer: 2 }] },
      { actions: [{ kind: 'attack', amount: 3 }, { kind: 'strengthenAllEnemies', amount: 1 }] },
      { actions: [{ kind: 'attack', amount: 5 }] },
      { once: true, actions: [{ kind: 'applyWeak', amount: 2, aoe: true }, { kind: 'status', card: 'slimed', amount: 2, aoe: true }, { kind: 'status', card: 'burn', amount: 2, aoe: true }] },
    ] },
    ascension: [{ min: 10, hpByPlayers: perPlayer(60), pattern: { kind: 'cube', slots: [
      { actions: [{ kind: 'summonUntil', defId: 'torch_head', perPlayer: 2 }] },
      { actions: [{ kind: 'attack', amount: 3 }, { kind: 'strengthenAllEnemies', amount: 1 }] },
      { actions: [{ kind: 'attack', amount: 6 }] },
      { once: true, actions: [{ kind: 'applyWeak', amount: 2, aoe: true }, { kind: 'status', card: 'slimed', amount: 2, aoe: true }, { kind: 'status', card: 'burn', amount: 3, aoe: true }] },
    ] } }],
  },

  torch_head: {
    id: 'torch_head', name: 'Torch Head', hpByPlayers: [9, 9, 9, 9],
    pattern: { kind: 'single', actions: [{ kind: 'attack', amount: 1 }] },
  },

  the_champ: {
    id: 'the_champ', name: 'The Champ', isBoss: true, bossAct: 2,
    hpByPlayers: perPlayer(40),
    pattern: { kind: 'cube', slots: [
      { actions: [{ kind: 'attack', amount: 4 }] },
      { actions: [{ kind: 'applyWeak', amount: 1, aoe: true }, { kind: 'gainStrength', amount: 1 }] },
      { actions: [{ kind: 'attack', amount: 5 }, { kind: 'block', amount: 3 }] },
    ] },
    ability: { kind: 'rebirth', hpPerPlayer: 40, defId: 'the_champ_fury' },
    ascension: [{
      min: 10,
      hpByPlayers: perPlayer(45),
      pattern: { kind: 'cube', slots: [
        { actions: [{ kind: 'attack', amount: 4 }] },
        { actions: [{ kind: 'applyWeak', amount: 1, aoe: true }, { kind: 'gainStrength', amount: 1 }] },
        { actions: [{ kind: 'attack', amount: 6 }, { kind: 'block', amount: 3 }] },
      ] },
      ability: { kind: 'rebirth', hpPerPlayer: 45, defId: 'the_champ_fury' },
    }],
  },

  the_champ_fury: {
    id: 'the_champ_fury', name: 'The Champ — Fury', isBoss: true, bossAct: 2, artId: 'the_champ',
    hpByPlayers: perPlayer(40),
    pattern: { kind: 'cube', slots: [
      { once: true, actions: [{ kind: 'clearSelfDebuffs' }] },
      { actions: [{ kind: 'attack', amount: 4, times: 2 }] },
      { actions: [{ kind: 'gainStrength', amount: 1 }] },
    ] },
    ascension: [{ min: 10, hpByPlayers: perPlayer(45), pattern: { kind: 'cube', slots: [
      { once: true, actions: [{ kind: 'clearSelfDebuffs' }] },
      { actions: [{ kind: 'attack', amount: 4, times: 2 }] },
      { actions: [{ kind: 'gainStrength', amount: 2 }] },
    ] } }],
  },

  bronze_automaton: {
    id: 'bronze_automaton', name: 'Bronze Automaton', isBoss: true, bossAct: 2,
    hpByPlayers: perPlayer(55),
    pattern: { kind: 'cube', slots: [
      { actions: [{ kind: 'gainStrength', amount: 1 }] },
      { actions: [{ kind: 'attack', amount: 1, times: 2 }] },
      { actions: [{ kind: 'gainStrength', amount: 1 }, { kind: 'clearSelfDebuffs' }] },
      { actions: [{ kind: 'attack', amount: 7 }] },
    ] },
    ascension: [{ min: 10, hpByPlayers: perPlayer(60), pattern: { kind: 'cube', slots: [
      { actions: [{ kind: 'gainStrength', amount: 1 }, { kind: 'clearSelfDebuffs' }] },
      { actions: [{ kind: 'attack', amount: 1, times: 2 }] },
      { actions: [{ kind: 'gainStrength', amount: 1 }, { kind: 'clearSelfDebuffs' }] },
      { actions: [{ kind: 'attack', amount: 9 }] },
    ] } }],
  },

  bronze_orb: {
    id: 'bronze_orb', name: 'Bronze Orb', hpByPlayers: [19, 19, 19, 19],
    pattern: { kind: 'die', byRoll: byPairs(
      [{ kind: 'attack', amount: 3 }],
      [{ kind: 'attack', amount: 2 }, { kind: 'applyWeak', amount: 1 }],
      [{ kind: 'blockNamed', defId: 'bronze_automaton', amount: 3 }],
    ) },
  },

  bronze_orb_db3: {
    id: 'bronze_orb_db3', name: 'Bronze Orb', artId: 'bronze_orb', hpByPlayers: [19, 19, 19, 19],
    pattern: { kind: 'die', byRoll: byPairs(
      [{ kind: 'attack', amount: 2 }, { kind: 'applyWeak', amount: 1 }],
      [{ kind: 'blockNamed', defId: 'bronze_automaton', amount: 3 }],
      [{ kind: 'attack', amount: 3 }],
    ) },
  },

  bronze_orb_3bd: {
    id: 'bronze_orb_3bd', name: 'Bronze Orb', artId: 'bronze_orb', hpByPlayers: [19, 19, 19, 19],
    pattern: { kind: 'die', byRoll: byPairs(
      [{ kind: 'attack', amount: 3 }],
      [{ kind: 'blockNamed', defId: 'bronze_automaton', amount: 3 }],
      [{ kind: 'attack', amount: 2 }, { kind: 'applyWeak', amount: 1 }],
    ) },
  },

  bronze_orb_b3d: {
    id: 'bronze_orb_b3d', name: 'Bronze Orb', artId: 'bronze_orb', hpByPlayers: [19, 19, 19, 19],
    pattern: { kind: 'die', byRoll: byPairs(
      [{ kind: 'blockNamed', defId: 'bronze_automaton', amount: 3 }],
      [{ kind: 'attack', amount: 3 }],
      [{ kind: 'attack', amount: 2 }, { kind: 'applyWeak', amount: 1 }],
    ) },
  },

  awakened_one_phase_1: {
    id: 'awakened_one_phase_1', name: 'Awakened One', isBoss: true, bossAct: 3,
    hpByPlayers: perPlayer(50),
    pattern: { kind: 'cube', slots: [
      { actions: [{ kind: 'attack', amount: 3 }] },
      { actions: [{ kind: 'attack', amount: 5 }] },
      { actions: [{ kind: 'attack', amount: 2, times: 2 }] },
    ] },
    abilities: [
      { kind: 'curiosity' },
      { kind: 'rebirth', hpPerPlayer: 50, defId: 'awakened_one_phase_2', strengthPerPower: true, timing: 'endOfTurn' },
    ],
    ascension: [{ min: 10, pattern: { kind: 'cube', slots: [
      { actions: [{ kind: 'attack', amount: 3 }] },
      { actions: [{ kind: 'attack', amount: 6 }] },
      { actions: [{ kind: 'attack', amount: 2, times: 2 }] },
    ] } }],
  },

  awakened_one_phase_2: {
    id: 'awakened_one_phase_2', name: 'Awakened One — Reborn', isBoss: true, bossAct: 3,
    hpByPlayers: perPlayer(50),
    pattern: { kind: 'cube', slots: [
      { actions: [{ kind: 'attack', amount: 7 }] },
      { actions: [{ kind: 'attack', amount: 4 }, { kind: 'status', card: 'slimed', amount: 2, aoe: true }] },
      { actions: [{ kind: 'attack', amount: 3, times: 2 }, { kind: 'gainStrength', amount: 1 }] },
    ] },
    ability: { kind: 'void' },
    ascension: [{ min: 10, pattern: { kind: 'cube', slots: [
      { actions: [{ kind: 'attack', amount: 6 }] },
      { actions: [{ kind: 'attack', amount: 4 }, { kind: 'status', card: 'slimed', amount: 2, aoe: true }] },
      { actions: [{ kind: 'attack', amount: 3, times: 2 }, { kind: 'gainStrength', amount: 1 }] },
    ] } }],
  },

  time_eater: {
    id: 'time_eater', name: 'Time Eater', isBoss: true, bossAct: 3,
    hpByPlayers: perPlayer(60),
    pattern: { kind: 'cube', slots: [
      { actions: [{ kind: 'attack', amount: 2, times: 2 }] },
      { actions: [{ kind: 'status', card: 'slimed', amount: 3, aoe: true }] },
      { actions: [{ kind: 'attack', amount: 6 }, { kind: 'gainStrength', amount: 1 }] },
    ] },
    abilities: [{ kind: 'timeWarp', limits: [5, 4, 3] }, { kind: 'rebirth', hpPerPlayer: 30, clearWeakVulnerable: true, strength: 1 }],
    ascension: [{ min: 10, hpByPlayers: perPlayer(64), pattern: { kind: 'cube', slots: [
      { actions: [{ kind: 'attack', amount: 3, times: 2 }] },
      { actions: [{ kind: 'status', card: 'slimed', amount: 3, aoe: true }] },
      { actions: [{ kind: 'attack', amount: 6 }, { kind: 'daze', amount: 1, aoe: true }, { kind: 'gainStrength', amount: 1 }] },
    ] }, abilities: [{ kind: 'timeWarp', limits: [5, 4, 3] }, { kind: 'rebirth', hpPerPlayer: 32, clearWeakVulnerable: true, strength: 1 }] }],
  },

  donu: {
    id: 'donu', name: 'Donu', isBoss: true, bossAct: 3,
    hpByPlayers: perPlayer(50),
    pattern: { kind: 'cube', slots: [
      { actions: [{ kind: 'strengthenAllEnemies', amount: 1 }] },
      { actions: [{ kind: 'attack', amount: 3, times: 3 }] },
    ] },
    ascension: [{ min: 10, hpByPlayers: perPlayer(55) }],
  },

  deca: {
    id: 'deca', name: 'Deca', isBoss: true, bossAct: 3,
    hpByPlayers: perPlayer(50),
    pattern: { kind: 'cube', slots: [
      { actions: [{ kind: 'attack', amount: 3, times: 3 }] },
      { actions: [{ kind: 'daze', amount: 1, aoe: true }, { kind: 'status', card: 'slimed', amount: 1, aoe: true }] },
    ] },
    ascension: [{ min: 10, hpByPlayers: perPlayer(55), pattern: { kind: 'cube', slots: [
      { actions: [{ kind: 'attack', amount: 3, times: 3 }] },
      { actions: [{ kind: 'daze', amount: 1, aoe: true }, { kind: 'status', card: 'slimed', amount: 2, aoe: true }] },
    ] } }],
  },

  spire_shield: {
    id: 'spire_shield', name: 'Spire Shield', elite: true, bossAct: 4,
    hpByPlayers: perPlayer(30),
    pattern: { kind: 'cube', slots: [
      { actions: [{ kind: 'block', amount: 20 }] },
      { actions: [{ kind: 'attack', amount: 8, facing: true }] },
      { actions: [{ kind: 'strengthenAllEnemies', amount: 2 }] },
    ] },
    ability: { kind: 'facing', effect: 'shield' },
  },

  spire_spear: {
    id: 'spire_spear', name: 'Spire Spear', elite: true, bossAct: 4,
    hpByPlayers: perPlayer(42),
    pattern: { kind: 'cube', slots: [
      { actions: [{ kind: 'attack', amount: 2, times: 2, facing: true }] },
      { actions: [{ kind: 'daze', amount: 2, aoe: true }] },
      { actions: [{ kind: 'attack', amount: 9, facing: true }] },
    ] },
    ability: { kind: 'facing', effect: 'spear' },
  },

  corrupt_heart: {
    id: 'corrupt_heart', name: 'Corrupt Heart', isBoss: true, bossAct: 4,
    hpByPlayers: perPlayer(100),
    pattern: { kind: 'cube', slots: [
      { once: true, actions: [{ kind: 'applyWeak', amount: 1, aoe: true }, { kind: 'applyVulnerable', amount: 1, aoe: true }, { kind: 'shuffleStatus', card: 'slimed', amount: 5 }] },
      { actions: [{ kind: 'attack', amount: 5 }] },
      { actions: [{ kind: 'attack', amount: 2, times: 3 }] },
      { actions: [{ kind: 'gainStrength', amount: 2 }, { kind: 'addAbilityCube', amount: 1 }, { kind: 'removeInvincible' }] },
    ] },
    abilities: [
      { kind: 'invincible', hpPerPlayer: 50 },
      { kind: 'beatOfDeath', damagePerCube: 1, startingCubes: 1, maxCubes: 3 },
    ],
    ascension: [{ min: 11, hpByPlayers: perPlayer(120), pattern: { kind: 'cube', slots: [
      { once: true, actions: [{ kind: 'applyWeak', amount: 1, aoe: true }, { kind: 'applyVulnerable', amount: 1, aoe: true }, { kind: 'shuffleStatus', card: 'burn', amount: 5 }] },
      { actions: [{ kind: 'attack', amount: 5 }] },
      { actions: [{ kind: 'attack', amount: 2, times: 3 }] },
      { actions: [{ kind: 'gainStrength', amount: 2 }, { kind: 'addAbilityCube', amount: 2 }, { kind: 'removeInvincible' }] },
    ] }, abilities: [
      { kind: 'invincible', hpPerPlayer: 60 },
      { kind: 'beatOfDeath', damagePerCube: 1, startingCubes: 1, maxCubes: 5 },
    ] }],
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
  fungi_beast_a7: ['fungi_beast_a7'],
  cultist: Array(8).fill('cultist'),
  torch_head: Array(8).fill('torch_head'),
  bronze_orb: ['bronze_orb', 'bronze_orb_db3', 'bronze_orb_3bd', 'bronze_orb_b3d'],
  byrd: ['byrd_s13', 'byrd_s31', 'byrd_31s'],
  mystic: ['mystic', 'mystic_2sh'],
  mugger: Array(2).fill('mugger'),
  blue_slaver: ['blue_slaver_wd3', 'blue_slaver_w3d', 'blue_slaver_dw3', 'blue_slaver_3wd'],
  red_slaver: ['red_slaver_dv3', 'red_slaver_3dv', 'red_slaver_3vd', 'red_slaver_v3d'],
  gremlin: [
    'gremlin_wizard', 'sneaky_gremlin', 'fat_gremlin', 'mad_gremlin',
    'gremlin_wizard', 'sneaky_gremlin', 'fat_gremlin', 'mad_gremlin',
  ],
  sentry_a: Array(7).fill('sentry_a'),
  sentry_b: Array(5).fill('sentry_b'),
  jaw_worm_act3: Array(2).fill('jaw_worm_summon'),
  repulsor: ['repulsor_summon'],
  exploder: ['exploder_summon'],
  spiker: ['spiker_add', 'spiker_attack'],
  darkling: ['darkling_bha', 'darkling_hab'],
  dagger: Array(8).fill('dagger'),
  spheric_guardian: ['spheric_guardian'],
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
    case 'flying': return compact
      ? `Flying · max ${ability.maxDamagePerHit} per Hit`
      : `Flying: takes at most ${ability.maxDamagePerHit} damage from each Hit`
    case 'painfulStabs': return compact
      ? `Painful Stabs · unblocked attack: +${ability.daze} Daze`
      : `Painful Stabs: after an attack deals unblocked damage, gain ${ability.daze} Daze`
    case 'furyOnAllyDeath': return compact
      ? `Fury · ${ability.allyDefId} defeated: +${ability.strength} Strength`
      : `Fury: when its ally is defeated, gain ${ability.strength} Strength and only attack`
    case 'confusion': return compact
      ? 'Confusion · first card uses intent cost'
      : 'Confusion: the first card played this turn costs the value shown by this enemy'
    case 'barricade': return compact
      ? `Barricade · starts with ${ability.startingBlock} Block; keeps Block`
      : `Barricade: starts with ${ability.startingBlock} Block and does not lose Block at the start of the Enemy Turn`
    case 'shift': return compact
      ? 'Shift · lost HP becomes row Block'
      : 'Shift: when this enemy loses HP, the player in its row gains that much Block'
    case 'reactiveReroll': return compact
      ? 'Reactive · Attack damage rerolls enemy intents'
      : 'Reactive: after an Attack damages this enemy, reroll the die without triggering relics'
    case 'regrow': return compact
      ? 'Regrow · round start: dead Darklings return at 4 HP'
      : 'Regrow: at the start of the round, return every dead Darkling with 4 HP'
    case 'thorns': return compact
      ? `Thorns · Attack: ${ability.damagePerCube} damage per cube`
      : `Thorns: after an Attack against this enemy, take ${ability.damagePerCube} damage per cube`
    case 'immuneOnSlots': return compact
      ? 'HP immunity · marked actions'
      : 'Cannot lose HP while the cube is on a marked action'
    case 'slow': return compact
      ? `Slow · +${ability.damagePerHit} damage from each Hit`
      : `Slow: this enemy takes ${ability.damagePerHit} extra damage from every Hit`
    case 'rally': return compact
      ? 'Rally · no Daggers: skip the bottom action'
      : 'Rally: if no Daggers remain, skip the bottom action when moving the cube'
    case 'splitOnDeath': return compact
      ? `Split · defeat: summon slimes${ability.largeSlimeStrength ? ` · Large Slimes +${ability.largeSlimeStrength} Strength` : ''}`
      : `Split: when defeated, summon slimes for every player next turn${ability.largeSlimeStrength ? `; Large Slimes gain ${ability.largeSlimeStrength} Strength` : ''}`
    case 'rebirth': return compact ? 'Second form · once per combat' : 'When first defeated, return in a second form'
    case 'sharpHide': return compact ? `Sharp Hide · Attack: ${ability.damage} damage` : `Sharp Hide: after a player attacks this enemy, deal ${ability.damage} damage to that player`
    case 'curiosity': return compact ? 'Curiosity · attacks +1 per Power' : 'Curiosity: attacks deal 1 extra damage for each Power the target has in play'
    case 'timeWarp': return compact ? `Time Warp · card limit ${ability.limits.join('/')}` : 'Time Warp: each player cannot play more cards than the current clock value'
    case 'invincible': return compact ? `Invincible · floor ${ability.hpPerPlayer}/player` : `Invincible: cannot fall below ${ability.hpPerPlayer} HP per player while active`
    case 'beatOfDeath': return compact ? 'Beat of Death · end-turn damage' : 'Beat of Death: at end of turn, damage every player once per ability cube'
    case 'void': return compact ? 'Void · draw Slimed: pay 1 Energy to Exhaust it' : 'Void: when a player draws a Slimed, if able they immediately spend 1 Energy to Exhaust it'
    case 'facing': return compact
      ? `Facing · choose ${ability.effect}`
      : `Facing: after start-of-turn effects, players in this enemy's two rows resolve its facing effect`
  }
}

export function enemyAbilities(def: EnemyDef): EnemyAbility[] {
  return [...(def.ability ? [def.ability] : []), ...(def.abilities ?? [])]
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
  if (pattern.kind === 'firstThenDie') return actionIndex === 0 ? pattern.first : pattern.byRoll[die] ?? []
  const slot = pattern.slots[actionIndex]
  return slot ? slot.actions : []
}

/** The action currently telegraphed after once-per-combat mode changes. */
export function actionsForEnemy(enemy: Enemy, die: number): EnemyAction[] {
  const def = enemyDef(enemy.defId, enemy.ascension)
  const fury = enemyAbilities(def).find((candidate) => candidate.kind === 'furyOnAllyDeath')
  return enemy.abilityUsed && fury?.kind === 'furyOnAllyDeath'
    ? fury.actions
    : actionsFor(def, die, enemy.actionIndex)
}

/**
 * Where the cube sits next turn. On reaching the bottom it returns to the
 * topmost slot that is NOT a one-time grey slot (p.13).
 */
export function advanceCube(def: EnemyDef, actionIndex: number): number {
  if (def.pattern.kind === 'firstThenDie') return 1
  if (def.pattern.kind !== 'cube') return actionIndex
  const slots = def.pattern.slots
  const next = actionIndex + 1
  if (next < slots.length) return next
  const firstRepeating = slots.findIndex((slot) => !slot.once)
  return firstRepeating === -1 ? 0 : firstRepeating
}
