// Core vocabulary of the engine. Everything here is plain data: the whole state
// has to survive JSON.stringify for broadcasts, saves, and replays.

export const BASE_CHARACTER_IDS = ['ironclad', 'silent', 'defect', 'watcher'] as const
export const DOWNFALL_CHARACTER_IDS = ['slime_boss', 'guardian', 'hexaghost', 'hermit'] as const
export const CHARACTER_IDS = [...BASE_CHARACTER_IDS, ...DOWNFALL_CHARACTER_IDS] as const

export type BaseCharacterId = (typeof BASE_CHARACTER_IDS)[number]
export type DownfallCharacterId = (typeof DOWNFALL_CHARACTER_IDS)[number]
export type CharacterId = (typeof CHARACTER_IDS)[number]
export type GuardianMode = 'attack' | 'defense'
export type SlimeType = 'bruiser' | 'leeching' | 'greed' | 'poison' | 'shield' | 'slime_spikes' | 'scrap_ooze' | 'evolution'
export type CardType = 'attack' | 'skill' | 'power' | 'curse' | 'status'
export type Rarity = 'starter' | 'common' | 'uncommon' | 'rare' | 'curse' | 'special'
export type OrbType = 'lightning' | 'frost' | 'dark'
export type Stance = 'neutral' | 'calm' | 'wrath'

/** Cumulative combat totals retained for the finished-run damage chart. */
export type DamageStats = {
  attack: number
  poison: number
  special: number
  taken: number
  blocked: number
}

/**
 * Every limit the board game imposes. These are not balance knobs — running out
 * of a token is a real rule ("the effect is ignored", rulebook p.18), so the
 * engine clamps rather than tracking an overflow.
 */
export const CAPS = {
  energy: 6,
  block: 20,
  strength: 8,
  vulnerable: 3,
  weak: 3,
  /** Shared across every enemy in the combat, not per enemy. */
  poison: 30,
  shivs: 5,
  miracles: 5,
  heat: 6,
  soulburn: 6,
  potions: 3,
  /** The physical Daze deck is shared by the party. */
  daze: 10,
  /** The 36 double-sided Burn/Slimed cards share one supply. */
  status: 36,
} as const

/** Card definitions are static; instances are what live in a deck. */
export type CardInstance = {
  uid: string
  defId: string
  upgraded: boolean
  /** Dark Embrace drew this during Ethereal cleanup; keep it through this discard step. */
  endTurnProtected?: boolean
  /** This exact card was kept by Retain at the end of the previous Player Turn. */
  retainedLastTurn?: boolean
  /** Meditate guarantees this card is kept during the upcoming discard step. */
  retainThisTurn?: boolean
  /** Stasis Engine selected this exact retained card to cost 0 next turn. */
  stasisRetained?: boolean
  /** Cubes accumulated on a Power such as The Bomb. */
  counter?: number
  /** Bullet Time reduced this specific card's cost to 0 for the current turn. */
  freeThisTurn?: boolean
  /** Establishment reduces this retained card's cost for the current turn. */
  costReductionThisTurn?: number
  /** Weave was discarded by Scry and is being forced with its printed bonus. */
  scryDamageBonus?: number
  /** Guardian: a transparent Gem permanently socketed under this physical card. */
  attachedGemId?: string
  /** Replication+ grows the Slime immediately after its forced free play. */
  growOnPlay?: boolean
  /** Hermit: this play originated in the private Chamber. */
  hermitDeadOn?: boolean
}

/** A Slime card in play. Plain fields survive JSON saves and reconnects. */
export type SlimeInstance = {
  card: CardInstance
  level: number
  vigor: number
  commandsThisTurn: number
  vigorLossAtEndOfTurn: number
  vigorTriggerUsedThisTurn?: boolean
}

export type RelicInstance = {
  defId: string
  /** "Once per combat" and "once per room" relics flip face down when spent. */
  spent: boolean
  /** Remaining printed uses for Wing Boots and the upgrade Eggs. */
  uses?: number
  /** Holy Water's once-per-combat Energy cubes. */
  cubes?: number
  /** Immediate out-of-combat text still waiting for its owner's card choices. */
  pending?: boolean
  /** Gems reserved beside each face-up reward group from this one-shot Relic. */
  guardianGemGroups?: string[][]
}

export type Player = {
  id: string
  name: string
  character: CharacterId
  row: number

  hp: number
  maxHp: number
  block: number
  energy: number
  /** A player effect sets the next card's cost before other player modifiers. */
  nextCardCost?: number | null
  /** Snecko's enemy Confusion overrides all player cost effects. */
  enemyNextCardCost?: number | null
  /** The only token kept through the end-of-combat reset (p.13). */
  gold: number

  /** Piles hold instances; the master deck is what persists between combats. */
  deck: CardInstance[]
  draw: CardInstance[]
  hand: CardInstance[]
  discard: CardInstance[]
  exhaust: CardInstance[]
  powers: CardInstance[]

  strength: number
  /** Strength Flex Potion requires this player to lose at end of turn. */
  strengthLossAtEndOfTurn: number
  /** Pizzaz Potion's actual Strength gain, removed after the next Attack resolves. */
  nextAttackStrength?: number
  /** Enemies can Weaken and make players Vulnerable, same caps as enemies. */
  vulnerable: number
  weak: number
  /** Battle Trance, Pray and Bullet Time prevent further draws until the next Player Turn. */
  drawLocked: boolean
  /** Public combat ledgers used by Masterful Stab and Finisher. */
  lostHpThisCombat: boolean
  /** Red Skull remembers whether the draw pile shuffled this combat. */
  shuffledThisCombat?: boolean
  /** HP already lost this round, including damage and direct HP loss. */
  hpLostThisRound?: number
  /** Apparition caps the total HP this player can lose during this round. */
  hpLossLimitThisRound?: number
  /** Madness makes this many subsequently played cards cost 0 this turn. */
  freeCardsThisTurn?: number
  /** Swivel makes this many subsequently played Attacks cost 0 this turn. */
  freeAttacksThisTurn?: number
  /** Guardian one-shot discounts. */
  freeGemCardsThisTurn?: number
  freePowersThisTurn?: number
  nextPowerOrSlimeDiscount?: number | 'free'
  /** Vantage grants one Rapid Fire to the next Attack this turn. */
  nextAttackRapidFire?: number
  energySpentThisTurn?: number
  /** Conclude prevents any further card play until the next Player Turn. */
  cardPlayLocked?: boolean
  /** Double Tap makes this many subsequent Attack cards play twice this turn. */
  doubledAttacksThisTurn?: number
  /** Akabeko adds one Strength for exactly the next Attack, then removes it. */
  akabekoAttacks?: number
  /** Blasphemy makes this many subsequent Attack cards play three times this turn. */
  tripledAttacksThisTurn?: number
  /** Echo Form makes this many subsequent Attack or Skill cards play twice this turn. */
  doubledCardsThisTurn?: number
  /** Burst makes this many subsequent Skill cards play twice this turn. */
  doubledSkillsThisTurn?: number
  /** Equilibrium lets this many otherwise-discarded cards stay in hand this turn. */
  retainCardsThisTurn?: number
  /** FTL checks this public per-turn card-play ledger. Copies count; Shivs do not. */
  cardsPlayedThisTurn?: number
  /** Mummified Hand checks whether any Power was played this turn. */
  powerPlayedThisTurn?: boolean
  /** Act IV's Shield/Spear choice; public and serialized for reconnects. */
  facingEnemyUid?: string | null
  damageDealtZeroThisTurn?: boolean
  /** Calipers preserves Block through exactly the next Reset after activation. */
  calipersArmed?: boolean
  attacksPlayedThisTurn: number
  /** Silent. */
  shivs: number
  /** Ongoing Silent Power modifiers, reset between combats. */
  shivDamageBonus: number
  cardBlockBonus: number
  hitPoison: number
  /** Apotheosis bonuses for the four printed starter Strike/Defend cards. */
  starterStrikeDamageBonus?: number
  /** Collector's Edition Claw cubes gained during this combat. */
  clawCubesGainedThisCombat?: number
  starterDefendBlockBonus?: number
  /** Watcher. */
  miracles: number
  /** Holy Water's two once-per-combat Energy cubes. */
  holyWaterCubes?: number
  stance: Stance
  /** Added to each Attack hit while in Wrath, reset between combats. */
  wrathAttackDamageBonus: number
  /** Defect. `null` marks an empty slot; slot order carries no meaning. */
  orbs: (OrbType | null)[]
  /** Added to each Orb's printed Evoke effect for this combat. */
  orbEvokeBonus?: number
  /** Amplify adds only to Dark Orb Evoke damage. */
  darkOrbEvokeBonus?: number
  /** Added to each Orb's printed end-of-turn effect for this combat. */
  orbEndTurnBonus?: number
  /** Static Discharge adds only to Lightning end-of-turn effects. */
  lightningEndTurnBonus?: number

  /** Optional so runs saved before the damage chart remain loadable. */
  damageStats?: DamageStats
  /** Downfall: cards kept outside the hand. Hidden from other clients. */
  chamber: CardInstance[]
  chamberSlots: number
  /** Downfall: Hexaghost heat and spendable Soulburn tracks. */
  heat: number
  soulburn: number
  /** Hexaghost turn ledgers and one-shot card modifiers. */
  soulburnUsedThisTurn?: boolean
  nextSoulburnDamageBonus?: number
  exhaustNextCardAfterUid?: string
  /** Downfall: Guardian mode and Vigor cubes, including cubes spent this turn. */
  guardianMode: GuardianMode | null
  vigor: number
  vigorSpentThisTurn: number
  /** Giga Beam's black cube prevents Mode Shift for the rest of this combat. */
  guardianModeLocked?: boolean
  /** Downfall: Slime Powers active outside the ordinary Power row. */
  slimes: SlimeInstance[]

  relics: RelicInstance[]
  /** Potion ids held. Limited to CAPS.potions (2 at Ascension 4). */
  potions: string[]
  /** Per-character reward decks, drawn from by card rewards and transforms. */
  cardRewards: string[]
  rareRewards: string[]
  /** Downfall Loot Chests plundered during Neow's fight. */
  lootChests?: number

  dead: boolean
}

export type Enemy = {
  uid: string
  defId: string
  row: number
  /** Bosses are treated as being in every row and are hit by every AoE. */
  isBoss: boolean
  /** Encounter-card override, such as Red Slavers summoned by Taskmaster. */
  actsLast?: boolean
  /** Printed alternate rows selected when this enemy card entered play. */
  ascension?: number
  /** A mode change printed for the start of the next Player Turn. */
  pendingDefId?: string

  hp: number
  maxHp: number
  block: number

  strength: number
  vulnerable: number
  weak: number
  poison: number
  /** Poison is shared on the board, but the chart credits each applied token. */
  poisonSources?: Record<string, number>

  /** Face-up Corpse Explosion card attached until this enemy dies. */
  corpseExplosion?: { card: CardInstance; playerId: string; damage: number }
  /** Physical Hermit Dead or Alive cards remain attached until this enemy dies. */
  hermitBounties?: { card: CardInstance; playerId: string }[]

  /** Reward printed by the encounter card that spawned this enemy. */
  goldReward: number
  cardReward: 'normal' | 'upgraded' | null
  potionReward?: boolean
  relicReward?: boolean

  /** Position on a cube-action track. */
  actionIndex: number

  /** Boss form/phase. Ordinary enemies stay at zero. */
  phase?: number

  /** Grey cube slots already resolved and skipped on later loops. */
  spentOnceSlots?: number[]

  /** Whether this enemy's once-per-combat special ability has fired. */
  abilityUsed: boolean

  /** Cubes on printed enemy ability tracks. */
  abilityCubes?: number

  dead: boolean
}
