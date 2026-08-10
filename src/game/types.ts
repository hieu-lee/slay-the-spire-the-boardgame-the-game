// Core vocabulary of the engine. Everything here is plain data: the whole state
// has to survive JSON.stringify for broadcasts, saves, and replays.

export type CharacterId = 'ironclad' | 'silent' | 'defect' | 'watcher'
export type CardType = 'attack' | 'skill' | 'power' | 'curse' | 'status'
export type Rarity = 'starter' | 'common' | 'uncommon' | 'rare' | 'special'
export type OrbType = 'lightning' | 'frost' | 'dark'
export type Stance = 'neutral' | 'calm' | 'wrath'

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
  potions: 3,
  /** The physical Daze deck is shared by the party. */
  daze: 10,
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
}

export type RelicInstance = {
  defId: string
  /** "Once per combat" and "once per room" relics flip face down when spent. */
  spent: boolean
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
  /** Enemies can Weaken and make players Vulnerable, same caps as enemies. */
  vulnerable: number
  weak: number
  /** Battle Trance and Pray prevent further draws until the next Player Turn. */
  drawLocked: boolean
  /** Public combat ledgers used by Masterful Stab and Finisher. */
  lostHpThisCombat: boolean
  /** HP already lost this round, including damage and direct HP loss. */
  hpLostThisRound?: number
  /** Apparition caps the total HP this player can lose during this round. */
  hpLossLimitThisRound?: number
  /** Madness makes this many subsequently played cards cost 0 this turn. */
  freeCardsThisTurn?: number
  attacksPlayedThisTurn: number
  /** Silent. */
  shivs: number
  /** Ongoing Silent Power modifiers, reset between combats. */
  shivDamageBonus: number
  cardBlockBonus: number
  hitPoison: number
  /** Watcher. */
  miracles: number
  stance: Stance
  /** Defect. `null` marks an empty slot; slot order carries no meaning. */
  orbs: (OrbType | null)[]
  /** Added to each Orb's printed Evoke effect for this combat. */
  orbEvokeBonus?: number

  relics: RelicInstance[]
  /** Potion ids held. Limited to CAPS.potions (2 at Ascension 4). */
  potions: string[]
  /** Per-character reward decks, drawn from by card rewards and transforms. */
  cardRewards: string[]
  rareRewards: string[]

  dead: boolean
}

export type Enemy = {
  uid: string
  defId: string
  row: number
  /** Bosses are treated as being in every row and are hit by every AoE. */
  isBoss: boolean

  hp: number
  maxHp: number
  block: number

  strength: number
  vulnerable: number
  weak: number
  poison: number

  /** Reward printed by the encounter card that spawned this enemy. */
  goldReward: number
  cardReward: 'normal' | 'upgraded' | null

  /** Position on a cube-action track. */
  actionIndex: number

  /** Whether this enemy's once-per-combat special ability has fired. */
  abilityUsed: boolean

  dead: boolean
}
