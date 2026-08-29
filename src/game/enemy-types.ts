// Shared enemy vocabulary. Keeping this type-only module below both registries
// prevents the base registry and the Downfall catalog from importing each other.
export type EnemyAction =
  /** Damage to the player in this enemy's row, or to all players if `aoe`. */
  | { kind: 'attack'; amount: number; times?: number; aoe?: boolean; facing?: boolean;
      bonusIfNoLivingAlly?: { defIds: string[]; amount: number } }
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
  | { kind: 'addAbilityCube'; amount: number; perPlayer?: boolean }
  | { kind: 'transform'; defId: string }
  | { kind: 'guardianModeShift'; amount: number }
  | { kind: 'removeInvincible' }
  | { kind: 'shuffleStatus'; card: 'burn' | 'slimed'; amount: number }
  /** This printed action is sorted after ordinary enemies for this round. */
  | { kind: 'actsLast' }
  /** Summons resolve at the start of the next round. */
  | { kind: 'summon'; defIds: string[] }
  | { kind: 'summonUntil'; defId: string; perPlayer: number }
  | { kind: 'shuffleCurse'; amount: number; aoe?: boolean }
  | { kind: 'reviveMatching'; defIds: string[]; onePerRow?: boolean }
  | { kind: 'doubleNamedHp'; defId: string }
  | { kind: 'healMatching'; defIds: string[]; amount: number }
  | { kind: 'gainSelfVulnerable'; amount: number }
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
  | { kind: 'rebirth'; hpPerPlayer: number; defId?: string; clearWeakVulnerable?: boolean; strength?: number; strengthPerPower?: boolean; timing?: 'startOfTurn' | 'endOfTurn' }
  | { kind: 'sharpHide'; damage: number }
  | { kind: 'curiosity' }
  | { kind: 'timeWarp'; limits: number[] }
  | { kind: 'invincible'; hpPerPlayer: number }
  | { kind: 'beatOfDeath'; damagePerCube: number; startingCubes: number; maxCubes: number }
  | { kind: 'void' }
  | { kind: 'facing'; effect: 'shield' | 'spear' }
  | { kind: 'startCombatStatus'; card: 'burn' | 'slimed'; amount: number }
  | { kind: 'slimedHandHpLoss'; amount: number }
  | { kind: 'buffSummons'; defIdPrefix: string; block: number; strength: number }
  | { kind: 'blockFromUnblockedDamage' }
  | { kind: 'startRoundSelfVulnerable'; amount: number }
  | { kind: 'buffer'; initialPerPlayer: number; max: number }
  | { kind: 'fireBreathing'; burnDamage: number }
  | { kind: 'burnOnAttackWhileSlot'; slot: number; amount: number }
  | { kind: 'protectedBy'; defIdPrefix: string }
  | { kind: 'retainPlayerVulnerable' }
  | { kind: 'immuneToWeak' }
  | { kind: 'retainPlayerWeak' }
  | { kind: 'deathTokenCleanup'; token: 'weak' | 'vulnerable'; amount: number }
  | { kind: 'secondWind'; defId: string; transferStrength: boolean }
  | { kind: 'reviveOnePerRow'; defIdPrefix: string }
  | { kind: 'blasphemy'; defId: string }
  | { kind: 'protectedUntilAllDead'; defIds: string[] }
  | { kind: 'focusFromAllyStrength'; defId: string }
  | { kind: 'grantAllyBuffer'; defId: string; amount: number }
  | { kind: 'corruptSkills' }
  | { kind: 'berserkHpLossPerPlayer'; amount: number }
  | { kind: 'plunder'; burns: number; chests: number }

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

export type SummonSupply = Record<string, string[]>
