// Card definitions are data, not code. A card's printed text is a sequence of
// icons — Bash is literally "2⚔ 💔" — so an effect list is a transcription of
// the card rather than an interpretation of it. One resolver reads them all.
import type { CardInstance, CardType, CharacterId, OrbType, Rarity, Stance } from './types.ts'
import type { Trigger } from './triggers.ts'

/** Who an effect lands on. Resolved against a chosen target when the card is played. */
export type TargetScope =
  /** One enemy, chosen by the player. Players may target any enemy in any row. */
  | 'enemy'
  /** The area-of-effect symbol: every enemy in one row, and always the boss. */
  | 'row'
  | 'allEnemies'
  | 'self'
  /** Co-op targeting, as on Defend+ ("2 Block to any player"). */
  | 'anyPlayer'
  | 'allPlayers'

/**
 * Whether a supportive effect goes to the player the caster chose, or to the
 * caster themselves.
 *
 * This lives on the EFFECT, not the card, because the printed text attaches
 * "to any player" to one clause. Vigilance reads "2 Block to any player. Enter
 * Calm." — the Block is redirected, the stance is the Watcher's own. A
 * card-level flag cannot express that, and reading it as card-wide put allies
 * into stances they can never legally be in.
 */
type Redirectable = { toChosen?: boolean }

/**
 * What a conditional clause reads off the board.
 *
 * Each one is a printed sentence, not a general expression language. The cards
 * ask a small, closed set of questions and a new card adds a case here; an
 * expression tree would let a transcription say things no card says, which is
 * the kind of freedom that turns a typo into a rule.
 */
export type Condition =
  /** Slice, Deflect: "if you have a [shiv]". */
  | { kind: 'hasShiv' }
  /**
   * Bane: "+2 damage if the enemy has [poison]".
   *
   * Read against the enemy being struck, so an area-of-effect card carrying
   * this would pay the bonus on the poisoned enemies in the row and not on the
   * rest. Nothing printed does both yet, but the alternative — reading it once
   * for the whole card — is wrong the day one does.
   */
  | { kind: 'targetPoisoned' }
  /**
   * Steam Barrier: "if the topmost card of your discard pile costs 0".
   *
   * An UNPLAYABLE card does not satisfy this at any number: it has no cost at
   * all (p.24) and its scan prints no energy gem. `CARDS.daze` stores 0 only
   * because the field is required.
   */
  | { kind: 'discardTopCosts'; cost: number }
  /** Go for the Eyes: this round's shared die shows one of these faces. */
  | { kind: 'dieShows'; faces: number[] }
  /** Halt: the Watcher is currently in the named stance. */
  | { kind: 'inStance'; stance: Stance }
  | { kind: 'discardedThisTurn' }
  | { kind: 'stanceChangedThisTurn' }
  | { kind: 'targetFullHp' }
  | { kind: 'firstTurnOfCombat' }
  /** FTL: this card is the first actual card played this turn. Shivs are Attacks, not cards. */
  | { kind: 'firstCardPlayedThisTurn' }
  | { kind: 'hasNoAttacksInHand' }
  | { kind: 'allCardsInHandAreAttacks' }
  | { kind: 'goldAtLeast'; amount: number }
  /** Charge Battery: the player has at least this many occupied Orb slots. */
  | { kind: 'orbsAtLeast'; amount: number }
  /** Grand Finale: the face-down draw pile is empty. */
  | { kind: 'drawPileEmpty' }
  /** Panache checks this when its ordered end-of-turn ability resolves. */
  | { kind: 'handEmpty' }
  /** Escape Plan: the immediately preceding draw effect drew a Skill. */
  | { kind: 'drewSkill' }
  /** Outmaneuver: this exact card was kept by Retain last turn. */
  | { kind: 'retainedLastTurn' }

/** Something on the board a card can count. Barrage deals one hit per Orb. */
export type CountOf =
  | 'orbs'
  | 'frostOrbs'
  | 'orbTypes'
  | 'block'
  | 'strength'
  | 'cardsInHand'
  | 'cardsInExhaust'
  | 'energySpent'
  | 'strikesInHand'
  | 'skillsInHand'
  | 'attacksInHand'
  | 'attacksPlayedThisTurn'
  | 'attackingEnemies'

/**
 * A number the board works out as the card resolves, rather than one printed
 * flat on the face.
 *
 * Deliberately NOT interchangeable with a conditional clause (`when` below).
 * Slice's "+1 damage if you have a shiv" has to fold into a single hit, because
 * two hits are checked against Block separately and one hit for 2 gets through
 * a Block of 1 where two hits for 1 do not. A bonus is part of an amount; a
 * whole clause that may not happen is a `when`.
 */
export type Amount =
  | number
  | {
      /** The number printed before any bonus. */
      base: number
      /**
       * The bonus and the question that switches it on, as one object because
       * neither half means anything alone. Written as two optional fields, a
       * transcription that supplied only `plus` typechecked and then quietly
       * dealt the base number — the exact silent-underperformance this
       * vocabulary exists to prevent. Slice prints +1 and Bane +2, so the size
       * is per card and not a fixed step.
       */
      bonus?: { plus: number; when: Condition }
      /** Adds one per unit of this count, on top of `base`. */
      per?: CountOf
      /** Multiplies the counted units; Heavy Blade changes each Strength token. */
      scale?: number
      /** Choke adds the target's Weak and Poison tokens to one hit. */
      targetTokens?: readonly ('weak' | 'poison')[]
    }

/**
 * A clause that only happens when the board says so, as the Weak on Go for the
 * Eyes does: the base face prints it against the die rows 4-5-6 only.
 */
type Conditional = { when?: Condition }

export type Effect = EffectKind & Conditional
export type CardMode = { label: string; effects: Effect[] }

/** Printed effects that fire only while this card is in hand at end of turn. */
export type HandEndOfTurnEffect =
  | { kind: 'damage'; amount: number }
  | { kind: 'loseHp'; amount: number; handSizeAtMost?: number }
  | { kind: 'gainWeak'; amount: number }
  | { kind: 'loseBlock'; amount: number }

type EffectKind =
  /** A hit: modified by Strength, Weak and Vulnerable. `times` is a multi-hit. */
  | { kind: 'hit'; amount: Amount; times?: Amount }
  /** Plain damage: blockable, but NOT modified by Strength/Weak/Vulnerable. */
  | { kind: 'damage'; amount: number }
  /** Flame Barrier: direct damage per printed Attack icon in each enemy's current intent. */
  | { kind: 'damagePerAttackIntent'; amount: number }
  /** Ignores Block entirely. */
  | { kind: 'loseHp'; amount: number }
  /** The caster loses HP, ignoring Block, as a printed card effect. */
  | { kind: 'loseOwnHp'; amount: number }
  | ({ kind: 'block'; amount: Amount } & Redirectable)
  /** Separate printed Block icons, each independently assigned to any living player. */
  | { kind: 'blockChoices'; amount: number; targets: number }
  | { kind: 'applyVulnerable'; amount: number }
  | { kind: 'applyWeak'; amount: number }
  | ({ kind: 'gainStrength'; amount: number } & Redirectable)
  | { kind: 'doubleStrength' }
  /** Strength that is removed during this Player Turn's end-of-turn step. */
  | { kind: 'gainTemporaryStrength'; amount: number; loseGainedOnly?: boolean }
  | { kind: 'poison'; amount: number }
  /** Separate Poison cubes, each independently assigned to a living enemy. */
  | { kind: 'poisonChoices'; amount: number; targets: number }
  | { kind: 'multiplyPoison'; factor: number }
  | ({ kind: 'draw'; amount: Amount } & Redirectable)
  | { kind: 'drawToHandSize'; size: number }
  | { kind: 'cycleHand' }
  /** Prevent this player from drawing again until the next Player Turn. */
  | { kind: 'preventDraw' }
  /** The next card played this turn costs 0 Energy. */
  | { kind: 'discountNextCard' }
  /** The next Attack played this turn resolves as two separately targeted cards. */
  | { kind: 'doubleNextAttack' }
  /** Total HP lost this round cannot exceed this amount. */
  | { kind: 'limitRoundHpLoss'; amount: number }
  /** Permanently improve this combat's starter Strikes and Defends. */
  | { kind: 'upgradeStarterCards'; amount: number }
  /** Put a cube on this Power; at the threshold, damage all enemies and Exhaust it. */
  | { kind: 'countdownDamage'; cubes: number; damage: number }
  /** Optionally exchange the caster's row with another living player. */
  | { kind: 'switchRows' }
  | ({ kind: 'gainEnergy'; amount: number } & Redirectable)
  /** Gain one Energy per card this card's preceding variable discard took, plus a flat bonus. */
  | { kind: 'gainEnergyPerDiscard'; bonus: number }
  | ({ kind: 'gainShiv'; amount: number } & Redirectable)
  /** Gain one Shiv per card this card's variable discard took, plus a flat bonus. */
  | { kind: 'gainShivPerDiscard'; bonus: number }
  /** Spend every held Shiv now; each one is still its own attack. */
  | { kind: 'useAllShivs'; bonus: number }
  | ({ kind: 'gainMiracle'; amount: number } & Redirectable)
  | { kind: 'enterStance'; stance: Stance }
  | { kind: 'channel'; orb: OrbType; amount: Amount }
  | { kind: 'evoke'; times: number }
  | { kind: 'channelDieOrb' }
  | { kind: 'recurseOrb' }
  | { kind: 'removeAllOrbs' }
  | { kind: 'gainOrbSlots'; amount: number }
  | { kind: 'gainOrbEvokeBonus'; amount: number }
  | { kind: 'gainOrbEndTurnBonus'; amount: number }
  | { kind: 'gainShivDamageBonus'; amount: number }
  | { kind: 'gainCardBlockBonus'; amount: number }
  | { kind: 'gainHitPoison'; amount: number }
  | { kind: 'doubleEnergy'; max: number }
  | { kind: 'clearTargetBlock' }
  | { kind: 'gainEnergyIfTargetDead'; amount: number }
  | { kind: 'gainStrengthIfTargetDead'; amount: number }
  | { kind: 'scry'; amount: number }
  /** Put chosen cards from hand on top of the draw pile, in chosen order. */
  | { kind: 'topdeck'; amount: number }
  /** Put one chosen card from the face-up discard pile on the draw top or into hand. */
  | { kind: 'recoverDiscard'; amount: 1; toHand?: boolean }
  /** Put one chosen card from the face-up Exhaust pile into hand. */
  | { kind: 'recoverExhaust'; amount: 1 }
  /** Draw a card and immediately play it for 0 Energy. */
  | { kind: 'drawAndPlayFree'; exhaustNonPower?: boolean }
  | { kind: 'addDaze'; amount: number; pile: 'draw' | 'discard' }
  | { kind: 'recoverDiscardTopCosts'; cost: number }
  | ({ kind: 'heal'; amount: number } & Redirectable)
  /** Remove every Weak and Vulnerable token from the player. */
  | ({ kind: 'clearDebuffs' } & Redirectable)
  /**
   * Discard cards the player chooses. The choice travels with the action rather
   * than parking the game in a prompt state, which keeps a card play a single
   * atomic message for the server to validate.
   */
  | { kind: 'discard'; amount: number }
  /** Discard any number of chosen cards, including zero. */
  | { kind: 'discardAny' }
  /** Exhaust cards the player chooses from hand, as True Grit does. */
  | { kind: 'exhaustFromHand'; amount: number }
  /** Exhaust a chosen range of cards; absent `minimum` means zero is allowed. */
  | { kind: 'exhaustAny'; amount: number; minimum?: number }
  /** Exhaust every remaining card in hand, optionally keeping one printed type. */
  | { kind: 'exhaustHand'; except?: CardType }
  /** Gain Block for each card taken by this card's preceding automatic Exhaust. */
  | { kind: 'gainBlockPerExhaust'; amount: number }
  /** Deal one separate hit per card taken by this card's preceding automatic Exhaust. */
  | { kind: 'hitPerExhaust'; amount: number }

export type CardDef = {
  id: string
  name: string
  /** `colorless`, `curse` and `status` are pools rather than characters. */
  owner: CharacterId | 'colorless' | 'curse' | 'status'
  type: CardType
  rarity: Rarity
  /** `'X'` spends any amount of energy; the effects read the amount spent. */
  cost: number | 'X'
  /** Reduce this card's Energy cost for each Power its owner has in play. */
  powerCostReduction?: number
  /** Replace the printed cost after this player has lost HP in this combat. */
  costAfterHpLoss?: number
  effects: Effect[]
  /** A condition that must hold before the card may be played at all. */
  playCondition?: Condition
  /** Mutually exclusive printed effect lines chosen when this card is played. */
  modes?: CardMode[]
  /** Where this card's offensive effects land. Defaults to a single enemy. */
  target?: TargetScope
  /** Where this card's supportive effects land. Defaults to the player. */
  supportTarget?: TargetScope
  /** The card exhausts itself when played, instead of going to the discard pile. */
  exhaust?: boolean
  /** The played card returns to the top of its owner's draw pile instead of discard. */
  toDrawTop?: boolean
  /** Kept in hand during the end-of-turn discard step. */
  retain?: boolean
  /** Cannot be played at all; an effect that tries to play it is ignored (p.24). */
  unplayable?: boolean
  /** Exhaust this card if it was in hand when the end-of-turn step began (p.24). */
  ethereal?: boolean
  /** Effects printed as "End of turn: If this card is in your hand...". */
  handEndOfTurn?: HandEndOfTurnEffect[]
  /** Effects printed as "If this card is discarded by a card's effect...". */
  discardReaction?: { effects: Effect[]; exhaust?: boolean }
  /** Effects printed as "If this card is Exhausted...". */
  exhaustReaction?: { effects: Effect[] }
  /**
   * For Powers: when the ongoing effect fires once the card is in play. The
   * `effects` list is what the Power DOES each time it triggers, not what
   * happens when it is played — a Power with a trigger does nothing on play.
   */
  trigger?: Trigger
  /** This Power may resolve at most once between Start of Turn resets. */
  oncePerTurn?: boolean
  /** This Power is activated by its owner during the Player Turn. */
  activeAbility?: boolean
  /** A Power whose printed effects happen once when played, as Inflame does. */
  resolvesOnPlay?: boolean
  /** While this Power is in play, its owner's Skills cost 0 and Exhaust when played. */
  corruptSkills?: boolean
  /** While this Power is in play, its owner keeps leftover Block at Start of Turn. */
  retainBlock?: boolean
  /** What changes when upgraded. Merged over the base definition. */
  upgrade?: Partial<Omit<CardDef, 'id' | 'upgrade'>>
}

/** The upgraded face of a card, or the card itself when it is not upgraded. */
export function faceOf(def: CardDef, upgraded: boolean): CardDef {
  if (!upgraded || !def.upgrade) return def
  return { ...def, ...def.upgrade, name: `${def.name}+` }
}

export function cardCost(
  def: CardDef,
  powers: readonly CardInstance[],
  lostHpThisCombat = false,
): number | 'X' {
  if (def.type === 'skill' && powers.some((held) => cardDef(held.defId).corruptSkills)) return 0
  if (def.cost === 'X') return 'X'
  const cost = lostHpThisCombat ? (def.costAfterHpLoss ?? def.cost) : def.cost
  return Math.max(0, cost - (def.powerCostReduction ?? 0) * powers.length)
}

const card = (def: CardDef): CardDef => def

/** Every character's Strike is 1 damage and every Defend is 1 Block, for 1 energy. */
function starterStrike(owner: CharacterId): CardDef {
  return {
    id: `strike_${owner}`,
    name: 'Strike',
    owner,
    type: 'attack',
    rarity: 'starter',
    cost: 1,
    effects: [{ kind: 'hit', amount: 1 }],
    upgrade: { effects: [{ kind: 'hit', amount: 2 }] },
  }
}

function starterDefend(owner: CharacterId): CardDef {
  return {
    id: `defend_${owner}`,
    name: 'Defend',
    owner,
    type: 'skill',
    rarity: 'starter',
    cost: 1,
    effects: [{ kind: 'block', amount: 1 }],
    // Defend+ reads "2 Block to any player" — co-op targeting is on the card.
    upgrade: {
      effects: [{ kind: 'block', amount: 2, toChosen: true }],
      supportTarget: 'anyPlayer',
    },
  }
}

/**
 * All four starter decks, transcribed from the card scans rather than from the
 * video game, which differs. Ironclad 5 Strike / 4 Defend / Bash. Silent 5/5 /
 * Neutralize / Survivor. Defect 4/4 / Zap / Dual Cast. Watcher 4/4 / Eruption /
 * Vigilance.
 */
export const CARDS: Record<string, CardDef> = {
  strike_silent: starterStrike('silent'),
  defend_silent: starterDefend('silent'),
  strike_defect: starterStrike('defect'),
  defend_defect: starterDefend('defect'),
  strike_watcher: starterStrike('watcher'),
  defend_watcher: starterDefend('watcher'),

  neutralize: card({
    id: 'neutralize',
    name: 'Neutralize',
    owner: 'silent',
    type: 'attack',
    rarity: 'starter',
    cost: 0,
    effects: [
      { kind: 'hit', amount: 1 },
      { kind: 'applyWeak', amount: 1 },
    ],
    upgrade: {
      effects: [
        { kind: 'hit', amount: 2 },
        { kind: 'applyWeak', amount: 1 },
      ],
    },
  }),
  survivor: card({
    id: 'survivor',
    name: 'Survivor',
    owner: 'silent',
    type: 'skill',
    rarity: 'starter',
    cost: 1,
    effects: [
      { kind: 'block', amount: 2 },
      { kind: 'discard', amount: 1 },
    ],
    upgrade: {
      effects: [
        { kind: 'block', amount: 3 },
        { kind: 'discard', amount: 1 },
      ],
    },
  }),

  zap: card({
    id: 'zap',
    name: 'Zap',
    owner: 'defect',
    type: 'skill',
    rarity: 'starter',
    cost: 1,
    effects: [{ kind: 'channel', orb: 'lightning', amount: 1 }],
    // Zap+ is the same effect for 0 energy.
    upgrade: { cost: 0 },
  }),
  dual_cast: card({
    id: 'dual_cast',
    name: 'Dual Cast',
    owner: 'defect',
    type: 'skill',
    rarity: 'starter',
    cost: 1,
    effects: [{ kind: 'evoke', times: 2 }],
    upgrade: { cost: 0 },
  }),

  eruption: card({
    id: 'eruption',
    name: 'Eruption',
    owner: 'watcher',
    type: 'attack',
    rarity: 'starter',
    cost: 2,
    effects: [
      { kind: 'hit', amount: 2 },
      { kind: 'enterStance', stance: 'wrath' },
    ],
    upgrade: { cost: 1 },
  }),
  vigilance: card({
    id: 'vigilance',
    name: 'Vigilance',
    owner: 'watcher',
    type: 'skill',
    rarity: 'starter',
    cost: 2,
    // "2 Block to any player. Enter Calm." — the Block is redirected; the
    // stance is the Watcher's own, which is why the flag is per effect.
    supportTarget: 'anyPlayer',
    effects: [
      { kind: 'block', amount: 2, toChosen: true },
      { kind: 'enterStance', stance: 'calm' },
    ],
    upgrade: {
      effects: [
        { kind: 'block', amount: 3, toChosen: true },
        { kind: 'enterStance', stance: 'calm' },
      ],
    },
  }),

  strike_ironclad: card({
    id: 'strike_ironclad',
    name: 'Strike',
    owner: 'ironclad',
    type: 'attack',
    rarity: 'starter',
    cost: 1,
    effects: [{ kind: 'hit', amount: 1 }],
    upgrade: { effects: [{ kind: 'hit', amount: 2 }] },
  }),
  defend_ironclad: card({
    id: 'defend_ironclad',
    name: 'Defend',
    owner: 'ironclad',
    type: 'skill',
    rarity: 'starter',
    cost: 1,
    effects: [{ kind: 'block', amount: 1 }],
    // Defend+ reads "2 Block to any player" — co-op targeting is printed on the card.
    upgrade: {
      effects: [{ kind: 'block', amount: 2, toChosen: true }],
      supportTarget: 'anyPlayer',
    },
  }),
  // Two separate hits, not one hit of 2 — each is modified on its own, and the
  // pair still spends only a single Vulnerable token.
  twin_strike: card({
    id: 'twin_strike',
    name: 'Twin Strike',
    owner: 'ironclad',
    type: 'attack',
    rarity: 'common',
    cost: 1,
    effects: [{ kind: 'hit', amount: 1, times: 2 }],
    upgrade: { effects: [{ kind: 'hit', amount: 2, times: 2 }] },
  }),
  true_grit: card({
    id: 'true_grit',
    name: 'True Grit',
    owner: 'ironclad',
    type: 'skill',
    rarity: 'common',
    cost: 1,
    // "1 Block to any player. Exhaust a card." — only the Block is redirected;
    // the card you exhaust comes from your own hand.
    supportTarget: 'anyPlayer',
    effects: [
      { kind: 'block', amount: 1, toChosen: true },
      { kind: 'exhaustFromHand', amount: 1 },
    ],
    upgrade: {
      effects: [
        { kind: 'block', amount: 2, toChosen: true },
        { kind: 'exhaustFromHand', amount: 1 },
      ],
    },
  }),
  burning_pact: card({
    id: 'burning_pact', name: 'Burning Pact', owner: 'ironclad', type: 'skill', rarity: 'uncommon', cost: 1,
    effects: [{ kind: 'exhaustFromHand', amount: 1 }, { kind: 'draw', amount: 2 }],
    upgrade: { effects: [{ kind: 'exhaustFromHand', amount: 1 }, { kind: 'draw', amount: 3 }] },
  }),
  sever_soul: card({
    id: 'sever_soul', name: 'Sever Soul', owner: 'ironclad', type: 'attack', rarity: 'uncommon', cost: 2,
    effects: [{ kind: 'hit', amount: 3 }, { kind: 'exhaustFromHand', amount: 1 }],
    upgrade: {
      effects: [{ kind: 'hit', amount: 4 }, { kind: 'exhaustAny', amount: 2, minimum: 1 }],
    },
  }),
  second_wind: card({
    id: 'second_wind', name: 'Second Wind', owner: 'ironclad', type: 'skill', rarity: 'uncommon', cost: 1,
    effects: [{ kind: 'exhaustHand', except: 'attack' }, { kind: 'gainBlockPerExhaust', amount: 1 }],
    upgrade: {
      effects: [{ kind: 'exhaustHand', except: 'attack' }, { kind: 'gainBlockPerExhaust', amount: 2 }],
    },
  }),
  entrench: card({
    id: 'entrench', name: 'Entrench', owner: 'ironclad', type: 'skill', rarity: 'uncommon', cost: 1,
    effects: [{ kind: 'block', amount: { base: 0, per: 'block' } }],
    exhaust: true,
    upgrade: { exhaust: false },
  }),
  sentinel: card({
    id: 'sentinel', name: 'Sentinel', owner: 'ironclad', type: 'skill', rarity: 'uncommon', cost: 1,
    supportTarget: 'anyPlayer',
    effects: [{ kind: 'block', amount: 2, toChosen: true }],
    exhaustReaction: { effects: [{ kind: 'gainEnergy', amount: 2 }] },
    upgrade: { effects: [{ kind: 'block', amount: 3, toChosen: true }] },
  }),
  fiend_fire: card({
    id: 'fiend_fire', name: 'Fiend Fire', owner: 'ironclad', type: 'attack', rarity: 'rare', cost: 2,
    effects: [{ kind: 'exhaustHand' }, { kind: 'hitPerExhaust', amount: 1 }],
    exhaust: true,
    upgrade: { effects: [{ kind: 'exhaustHand' }, { kind: 'hitPerExhaust', amount: 2 }] },
  }),
  limit_break: card({
    id: 'limit_break', name: 'Limit Break', owner: 'ironclad', type: 'skill', rarity: 'rare', cost: 1,
    effects: [{ kind: 'doubleStrength' }],
    exhaust: true,
    upgrade: { exhaust: false },
  }),
  double_tap: card({
    id: 'double_tap', name: 'Double Tap', owner: 'ironclad', type: 'skill', rarity: 'rare', cost: 1,
    effects: [{ kind: 'doubleNextAttack' }],
    upgrade: { cost: 0 },
  }),
  feed: card({
    id: 'feed', name: 'Feed', owner: 'ironclad', type: 'attack', rarity: 'rare', cost: 1,
    effects: [{ kind: 'hit', amount: 3 }, { kind: 'gainStrengthIfTargetDead', amount: 1 }],
    exhaust: true,
    upgrade: { effects: [{ kind: 'hit', amount: 3 }, { kind: 'gainStrengthIfTargetDead', amount: 2 }] },
  }),
  corruption: card({
    id: 'corruption', name: 'Corruption', owner: 'ironclad', type: 'power', rarity: 'rare', cost: 3,
    effects: [],
    corruptSkills: true,
    upgrade: { cost: 2 },
  }),
  barricade: card({
    id: 'barricade', name: 'Barricade', owner: 'ironclad', type: 'power', rarity: 'rare', cost: 2,
    effects: [],
    retainBlock: true,
    upgrade: { cost: 1 },
  }),
  // Powers: the `effects` fire on the TRIGGER, not when the card is played.
  // Transcribed from the scans; note that Metallicize+ and Feel No Pain+ change
  // only their cost, and Demon Form's bare Strength icon means 1.
  metallicize: card({
    id: 'metallicize',
    name: 'Metallicize',
    owner: 'ironclad',
    type: 'power',
    rarity: 'uncommon',
    cost: 1,
    trigger: { kind: 'endOfTurn' },
    effects: [{ kind: 'block', amount: 1 }],
    upgrade: { cost: 0 },
  }),
  demon_form: card({
    id: 'demon_form',
    name: 'Demon Form',
    owner: 'ironclad',
    type: 'power',
    rarity: 'rare',
    cost: 3,
    trigger: { kind: 'startOfTurn' },
    effects: [{ kind: 'gainStrength', amount: 1 }],
    upgrade: { cost: 2 },
  }),
  feel_no_pain: card({
    id: 'feel_no_pain',
    name: 'Feel No Pain',
    owner: 'ironclad',
    type: 'power',
    rarity: 'uncommon',
    cost: 1,
    trigger: { kind: 'onExhaust' },
    effects: [{ kind: 'block', amount: 1 }],
    upgrade: { cost: 0 },
  }),
  dark_embrace: card({
    id: 'dark_embrace',
    name: 'Dark Embrace',
    owner: 'ironclad',
    type: 'power',
    rarity: 'uncommon',
    cost: 2,
    trigger: { kind: 'onExhaust' },
    effects: [{ kind: 'draw', amount: 1 }],
    upgrade: { cost: 1 },
  }),
  combust: card({
    id: 'combust', name: 'Combust', owner: 'ironclad', type: 'power', rarity: 'uncommon', cost: 1,
    target: 'row', activeAbility: true, oncePerTurn: true,
    effects: [{ kind: 'damage', amount: 1 }],
    upgrade: { effects: [{ kind: 'damage', amount: 2 }] },
  }),
  evolve: card({
    id: 'evolve', name: 'Evolve', owner: 'ironclad', type: 'power', rarity: 'uncommon', cost: 1,
    trigger: { kind: 'onDraw', cardType: 'status' },
    effects: [{ kind: 'draw', amount: 1 }],
    upgrade: { cost: 0 },
  }),
  inflame: card({
    id: 'inflame', name: 'Inflame', owner: 'ironclad', type: 'power', rarity: 'uncommon', cost: 2,
    resolvesOnPlay: true,
    effects: [{ kind: 'gainStrength', amount: 1 }],
    upgrade: { cost: 1 },
  }),
  carnage: card({
    id: 'carnage', name: 'Carnage', owner: 'ironclad', type: 'attack', rarity: 'uncommon', cost: 2,
    ethereal: true,
    effects: [{ kind: 'hit', amount: 4 }],
    upgrade: { effects: [{ kind: 'hit', amount: 6 }] },
  }),
  ghostly_armor: card({
    id: 'ghostly_armor', name: 'Ghostly Armor', owner: 'ironclad', type: 'skill', rarity: 'uncommon', cost: 1,
    ethereal: true,
    supportTarget: 'anyPlayer',
    effects: [{ kind: 'block', amount: 2, toChosen: true }],
    upgrade: { effects: [{ kind: 'block', amount: 3, toChosen: true }] },
  }),
  battle_trance: card({
    id: 'battle_trance', name: 'Battle Trance', owner: 'ironclad', type: 'skill', rarity: 'uncommon', cost: 0,
    effects: [{ kind: 'draw', amount: 3 }, { kind: 'preventDraw' }],
    upgrade: { effects: [{ kind: 'draw', amount: 4 }, { kind: 'preventDraw' }] },
  }),
  rupture: card({
    id: 'rupture', name: 'Rupture', owner: 'ironclad', type: 'skill', rarity: 'uncommon', cost: 1,
    effects: [{ kind: 'gainStrength', amount: 1 }, { kind: 'loseOwnHp', amount: 1 }],
    upgrade: { cost: 0 },
  }),
  whirlwind: card({
    id: 'whirlwind', name: 'Whirlwind', owner: 'ironclad', type: 'attack', rarity: 'uncommon', cost: 'X',
    target: 'row',
    effects: [{ kind: 'hit', amount: 1, times: { base: 0, per: 'energySpent' } }],
    upgrade: { effects: [{ kind: 'hit', amount: 1, times: { base: 1, per: 'energySpent' } }] },
  }),

  bash: card({
    id: 'bash',
    name: 'Bash',
    owner: 'ironclad',
    type: 'attack',
    rarity: 'starter',
    cost: 2,
    effects: [
      { kind: 'hit', amount: 2 },
      { kind: 'applyVulnerable', amount: 1 },
    ],
    upgrade: {
      effects: [
        { kind: 'hit', amount: 4 },
        { kind: 'applyVulnerable', amount: 1 },
      ],
    },
  }),

  // ---------------------------------------------------------------------------
  // Normal-tier cards, transcribed face by face from the scans.
  //
  // Two printing conventions, both confirmed against upgraded faces rather than
  // assumed. A bare symbol means one: Deadly Poison prints a single poison skull
  // with no numeral, and Poisoned Stab+ prints two skulls where the base card
  // prints one. And a numeral multiplies the symbol it precedes, so Dagger
  // Spray's "1⚔ 1⚔" is two separate one-damage hits, not a single hit for two —
  // which matters, because each is checked against Block on its own.
  //
  // Only cards whose BOTH faces fit the current effect vocabulary are here. The
  // rest are listed as deferred at the foot of this file, with what each needs.
  // ---------------------------------------------------------------------------

  cleave: card({
    id: 'cleave',
    name: 'Cleave',
    owner: 'ironclad',
    type: 'attack',
    rarity: 'common',
    cost: 1,
    // The red burst is the area-of-effect symbol: one row, and always a boss.
    target: 'row',
    effects: [{ kind: 'hit', amount: 2 }],
    upgrade: { effects: [{ kind: 'hit', amount: 3 }] },
  }),
  clothesline: card({
    id: 'clothesline',
    name: 'Clothesline',
    owner: 'ironclad',
    type: 'attack',
    rarity: 'common',
    cost: 2,
    effects: [
      { kind: 'hit', amount: 3 },
      { kind: 'applyWeak', amount: 1 },
    ],
    upgrade: {
      effects: [
        { kind: 'hit', amount: 4 },
        { kind: 'applyWeak', amount: 1 },
      ],
    },
  }),
  pommel_strike: card({
    id: 'pommel_strike',
    name: 'Pommel Strike',
    owner: 'ironclad',
    type: 'attack',
    rarity: 'common',
    cost: 1,
    effects: [
      { kind: 'hit', amount: 2 },
      { kind: 'draw', amount: 1 },
    ],
    upgrade: {
      effects: [
        { kind: 'hit', amount: 2 },
        { kind: 'draw', amount: 2 },
      ],
    },
  }),
  shrug_it_off: card({
    id: 'shrug_it_off',
    name: 'Shrug It Off',
    owner: 'ironclad',
    type: 'skill',
    rarity: 'common',
    cost: 1,
    effects: [
      { kind: 'block', amount: 2 },
      { kind: 'draw', amount: 1 },
    ],
    upgrade: {
      effects: [
        { kind: 'block', amount: 3 },
        { kind: 'draw', amount: 1 },
      ],
    },
  }),
  anger: card({
    id: 'anger', name: 'Anger', owner: 'ironclad', type: 'attack', rarity: 'common', cost: 0,
    toDrawTop: true,
    effects: [{ kind: 'hit', amount: 1 }],
    upgrade: { effects: [{ kind: 'hit', amount: 2 }] },
  }),
  flex: card({
    id: 'flex', name: 'Flex', owner: 'ironclad', type: 'skill', rarity: 'common', cost: 0,
    exhaust: true,
    effects: [{ kind: 'gainTemporaryStrength', amount: 1 }],
    upgrade: {
      exhaust: false,
      effects: [{ kind: 'gainTemporaryStrength', amount: 1, loseGainedOnly: true }],
    },
  }),
  warcry: card({
    id: 'warcry', name: 'Warcry', owner: 'ironclad', type: 'skill', rarity: 'common', cost: 0,
    effects: [{ kind: 'draw', amount: 2 }, { kind: 'topdeck', amount: 1 }],
    exhaust: true,
    upgrade: { effects: [{ kind: 'draw', amount: 3 }, { kind: 'topdeck', amount: 1 }] },
  }),
  havoc: card({
    id: 'havoc', name: 'Havoc', owner: 'ironclad', type: 'skill', rarity: 'common', cost: 1,
    effects: [{ kind: 'drawAndPlayFree', exhaustNonPower: true }],
    upgrade: { cost: 0 },
  }),
  perfected_strike: card({
    id: 'perfected_strike', name: 'Perfected Strike', owner: 'ironclad', type: 'attack', rarity: 'uncommon', cost: 2,
    effects: [{ kind: 'hit', amount: { base: 3, per: 'strikesInHand' } }],
    upgrade: { effects: [{ kind: 'hit', amount: { base: 3, per: 'strikesInHand', scale: 2 } }] },
  }),
  headbutt: card({
    id: 'headbutt', name: 'Headbutt', owner: 'ironclad', type: 'attack', rarity: 'uncommon', cost: 1,
    effects: [{ kind: 'hit', amount: 2 }, { kind: 'recoverDiscard', amount: 1 }],
    upgrade: { effects: [{ kind: 'hit', amount: 3 }, { kind: 'recoverDiscard', amount: 1 }] },
  }),
  power_through: card({
    id: 'power_through', name: 'Power Through', owner: 'ironclad', type: 'skill', rarity: 'uncommon', cost: 1,
    supportTarget: 'anyPlayer',
    effects: [{ kind: 'block', amount: 3, toChosen: true }, { kind: 'addDaze', amount: 1, pile: 'draw' }],
    upgrade: {
      effects: [{ kind: 'block', amount: 4, toChosen: true }, { kind: 'addDaze', amount: 1, pile: 'draw' }],
    },
  }),
  flame_barrier: card({
    id: 'flame_barrier', name: 'Flame Barrier', owner: 'ironclad', type: 'skill', rarity: 'uncommon', cost: 2,
    effects: [{ kind: 'block', amount: 3 }, { kind: 'damagePerAttackIntent', amount: 1 }],
    upgrade: { effects: [{ kind: 'block', amount: 4 }, { kind: 'damagePerAttackIntent', amount: 1 }] },
  }),
  rampage: card({
    id: 'rampage', name: 'Rampage', owner: 'ironclad', type: 'attack', rarity: 'uncommon', cost: 1,
    effects: [{ kind: 'hit', amount: { base: 0, per: 'cardsInExhaust' } }],
    upgrade: {
      effects: [
        { kind: 'exhaustFromHand', amount: 1 },
        { kind: 'hit', amount: { base: 0, per: 'cardsInExhaust' } },
      ],
    },
  }),
  exhume: card({
    id: 'exhume', name: 'Exhume', owner: 'ironclad', type: 'skill', rarity: 'rare', cost: 1,
    effects: [{ kind: 'recoverExhaust', amount: 1 }],
    exhaust: true,
    upgrade: { cost: 0 },
  }),
  iron_wave: card({
    id: 'iron_wave', name: 'Iron Wave', owner: 'ironclad', type: 'attack', rarity: 'common', cost: 1,
    effects: [{ kind: 'hit', amount: 1 }, { kind: 'block', amount: 1 }],
    upgrade: {
      modes: [
        { label: '2 damage and 1 Block', effects: [{ kind: 'hit', amount: 2 }, { kind: 'block', amount: 1 }] },
        { label: '1 damage and 2 Block', effects: [{ kind: 'hit', amount: 1 }, { kind: 'block', amount: 2 }] },
      ],
    },
  }),
  disarm: card({
    id: 'disarm', name: 'Disarm', owner: 'ironclad', type: 'skill', rarity: 'uncommon', cost: 1,
    exhaust: true,
    effects: [{ kind: 'applyWeak', amount: 2 }],
    upgrade: { effects: [{ kind: 'applyWeak', amount: 3 }] },
  }),
  shockwave: card({
    id: 'shockwave', name: 'Shockwave', owner: 'ironclad', type: 'skill', rarity: 'uncommon', cost: 2,
    target: 'row',
    exhaust: true,
    effects: [{ kind: 'applyVulnerable', amount: 1 }, { kind: 'applyWeak', amount: 1 }],
    upgrade: { effects: [{ kind: 'applyVulnerable', amount: 1 }, { kind: 'applyWeak', amount: 2 }] },
  }),
  bludgeon: card({
    id: 'bludgeon', name: 'Bludgeon', owner: 'ironclad', type: 'attack', rarity: 'rare', cost: 3,
    effects: [{ kind: 'hit', amount: 7 }],
    upgrade: { effects: [{ kind: 'hit', amount: 10 }] },
  }),
  impervious: card({
    id: 'impervious', name: 'Impervious', owner: 'ironclad', type: 'skill', rarity: 'rare', cost: 2,
    exhaust: true,
    effects: [{ kind: 'block', amount: 6 }],
    upgrade: { effects: [{ kind: 'block', amount: 8 }] },
  }),
  uppercut: card({
    id: 'uppercut', name: 'Uppercut', owner: 'ironclad', type: 'attack', rarity: 'rare', cost: 2,
    effects: [
      { kind: 'hit', amount: 3 },
      { kind: 'applyVulnerable', amount: 1 },
      { kind: 'applyWeak', amount: 1 },
    ],
    upgrade: {
      effects: [
        { kind: 'hit', amount: 3 },
        { kind: 'applyVulnerable', amount: 2 },
        { kind: 'applyWeak', amount: 1 },
      ],
    },
  }),
  offering: card({
    id: 'offering', name: 'Offering', owner: 'ironclad', type: 'skill', rarity: 'rare', cost: 0,
    exhaust: true,
    effects: [{ kind: 'loseOwnHp', amount: 1 }, { kind: 'gainEnergy', amount: 2 }, { kind: 'draw', amount: 3 }],
    upgrade: {
      effects: [{ kind: 'loseOwnHp', amount: 1 }, { kind: 'gainEnergy', amount: 2 }, { kind: 'draw', amount: 5 }],
    },
  }),
  immolate: card({
    id: 'immolate', name: 'Immolate', owner: 'ironclad', type: 'attack', rarity: 'rare', cost: 2,
    target: 'allEnemies',
    effects: [{ kind: 'hit', amount: 5 }, { kind: 'addDaze', amount: 2, pile: 'draw' }],
    upgrade: { effects: [{ kind: 'hit', amount: 7 }, { kind: 'addDaze', amount: 2, pile: 'draw' }] },
  }),

  dagger_throw: card({
    id: 'dagger_throw', name: 'Dagger Throw', owner: 'silent', type: 'attack', rarity: 'common', cost: 1,
    effects: [{ kind: 'hit', amount: 2 }, { kind: 'draw', amount: 1 }, { kind: 'discard', amount: 1 }],
    upgrade: {
      effects: [{ kind: 'hit', amount: 3 }, { kind: 'draw', amount: 1 }, { kind: 'discard', amount: 1 }],
    },
  }),
  prepared: card({
    id: 'prepared', name: 'Prepared', owner: 'silent', type: 'skill', rarity: 'common', cost: 0,
    effects: [{ kind: 'draw', amount: 1 }, { kind: 'discard', amount: 1 }],
    upgrade: { effects: [{ kind: 'draw', amount: 2 }, { kind: 'discard', amount: 2 }] },
  }),
  riddle_with_holes: card({
    id: 'riddle_with_holes', name: 'Riddle with Holes', owner: 'silent', type: 'skill', rarity: 'uncommon', cost: 2,
    effects: [{ kind: 'gainShiv', amount: 4 }],
    upgrade: { effects: [{ kind: 'gainShiv', amount: 5 }] },
  }),
  dash: card({
    id: 'dash', name: 'Dash', owner: 'silent', type: 'attack', rarity: 'uncommon', cost: 2,
    effects: [{ kind: 'hit', amount: 2 }, { kind: 'block', amount: 2 }, { kind: 'switchRows' }],
    upgrade: {
      effects: [{ kind: 'hit', amount: 3 }, { kind: 'block', amount: 3 }, { kind: 'switchRows' }],
    },
  }),
  die_die_die: card({
    id: 'die_die_die', name: 'Die Die Die', owner: 'silent', type: 'attack', rarity: 'rare', cost: 1,
    target: 'allEnemies',
    exhaust: true,
    effects: [{ kind: 'hit', amount: 3 }],
    upgrade: { effects: [{ kind: 'hit', amount: 4 }] },
  }),
  piercing_wail: card({
    id: 'piercing_wail', name: 'Piercing Wail', owner: 'silent', type: 'skill', rarity: 'uncommon', cost: 1,
    target: 'allEnemies',
    exhaust: true,
    effects: [{ kind: 'block', amount: 1 }, { kind: 'applyWeak', amount: 1 }],
    upgrade: { effects: [{ kind: 'block', amount: 3 }, { kind: 'applyWeak', amount: 1 }] },
  }),
  crippling_cloud: card({
    id: 'crippling_cloud', name: 'Crippling Cloud', owner: 'silent', type: 'skill', rarity: 'uncommon', cost: 2,
    target: 'allEnemies',
    exhaust: true,
    effects: [{ kind: 'poison', amount: 1 }, { kind: 'applyWeak', amount: 1 }],
    upgrade: { effects: [{ kind: 'poison', amount: 2 }, { kind: 'applyWeak', amount: 1 }] },
  }),
  deadly_poison: card({
    id: 'deadly_poison',
    name: 'Deadly Poison',
    owner: 'silent',
    type: 'skill',
    rarity: 'common',
    cost: 1,
    effects: [{ kind: 'poison', amount: 1 }],
    // The upgraded face prints the same single skull and costs nothing.
    upgrade: { cost: 0 },
  }),
  poisoned_stab: card({
    id: 'poisoned_stab',
    name: 'Poisoned Stab',
    owner: 'silent',
    type: 'attack',
    rarity: 'common',
    cost: 1,
    exhaust: true,
    effects: [
      { kind: 'hit', amount: 1 },
      { kind: 'poison', amount: 1 },
    ],
    upgrade: {
      effects: [
        { kind: 'hit', amount: 1 },
        { kind: 'poison', amount: 2 },
      ],
    },
  }),
  dagger_spray: card({
    id: 'dagger_spray',
    name: 'Dagger Spray',
    owner: 'silent',
    type: 'attack',
    rarity: 'common',
    cost: 1,
    target: 'row',
    effects: [{ kind: 'hit', amount: 1, times: 2 }],
    upgrade: { effects: [{ kind: 'hit', amount: 1, times: 3 }] },
  }),
  backflip: card({
    id: 'backflip',
    name: 'Backflip',
    owner: 'silent',
    type: 'skill',
    rarity: 'common',
    cost: 1,
    effects: [
      { kind: 'block', amount: 1 },
      { kind: 'draw', amount: 2 },
    ],
    upgrade: {
      effects: [
        { kind: 'block', amount: 2 },
        { kind: 'draw', amount: 2 },
      ],
    },
  }),
  acrobatics: card({
    id: 'acrobatics', name: 'Acrobatics', owner: 'silent', type: 'skill', rarity: 'common', cost: 1,
    effects: [{ kind: 'draw', amount: 3 }, { kind: 'discard', amount: 1 }],
    upgrade: { effects: [{ kind: 'draw', amount: 4 }, { kind: 'discard', amount: 1 }] },
  }),
  skewer: card({
    id: 'skewer', name: 'Skewer', owner: 'silent', type: 'attack', rarity: 'uncommon', cost: 'X',
    effects: [{ kind: 'hit', amount: 1, times: { base: 1, per: 'energySpent' } }],
    upgrade: { effects: [{ kind: 'hit', amount: 2, times: { base: 0, per: 'energySpent' } }] },
  }),

  ball_lightning: card({
    id: 'ball_lightning',
    name: 'Ball Lightning',
    owner: 'defect',
    type: 'attack',
    rarity: 'common',
    cost: 1,
    effects: [
      { kind: 'hit', amount: 1 },
      { kind: 'channel', orb: 'lightning', amount: 1 },
    ],
    upgrade: {
      effects: [
        { kind: 'hit', amount: 2 },
        { kind: 'channel', orb: 'lightning', amount: 1 },
      ],
    },
  }),
  cold_snap: card({
    id: 'cold_snap',
    name: 'Cold Snap',
    owner: 'defect',
    type: 'attack',
    rarity: 'common',
    cost: 2,
    effects: [
      { kind: 'hit', amount: 2 },
      { kind: 'channel', orb: 'frost', amount: 1 },
    ],
    upgrade: {
      effects: [
        { kind: 'hit', amount: 3 },
        { kind: 'channel', orb: 'frost', amount: 1 },
      ],
    },
  }),
  coolheaded: card({
    id: 'coolheaded',
    name: 'Coolheaded',
    owner: 'defect',
    type: 'skill',
    rarity: 'common',
    cost: 1,
    effects: [{ kind: 'channel', orb: 'frost', amount: 1 }],
    upgrade: {
      effects: [
        { kind: 'channel', orb: 'frost', amount: 1 },
        { kind: 'draw', amount: 1 },
      ],
    },
  }),
  charge_battery: card({
    id: 'charge_battery',
    name: 'Charge Battery',
    owner: 'defect',
    type: 'skill',
    rarity: 'common',
    cost: 1,
    effects: [
      { kind: 'block', amount: 2 },
      { kind: 'channel', orb: 'frost', amount: 1, when: { kind: 'orbsAtLeast', amount: 3 } },
    ],
    upgrade: {
      effects: [
        { kind: 'block', amount: 3 },
        { kind: 'channel', orb: 'frost', amount: 1, when: { kind: 'orbsAtLeast', amount: 3 } },
      ],
    },
  }),
  chaos: card({
    id: 'chaos', name: 'Chaos', owner: 'defect', type: 'skill', rarity: 'common', cost: 1,
    effects: [{ kind: 'channelDieOrb' }],
    upgrade: { cost: 0 },
  }),
  recursion: card({
    id: 'recursion', name: 'Recursion', owner: 'defect', type: 'skill', rarity: 'common', cost: 1,
    effects: [{ kind: 'recurseOrb' }],
    upgrade: { cost: 0 },
  }),

  consecrate: card({
    id: 'consecrate',
    name: 'Consecrate',
    owner: 'watcher',
    type: 'attack',
    rarity: 'common',
    cost: 0,
    target: 'row',
    effects: [{ kind: 'hit', amount: 1 }],
    upgrade: { effects: [{ kind: 'hit', amount: 2 }] },
  }),
  empty_body: card({
    id: 'empty_body',
    name: 'Empty Body',
    owner: 'watcher',
    type: 'skill',
    rarity: 'common',
    cost: 1,
    effects: [
      { kind: 'block', amount: 2 },
      { kind: 'enterStance', stance: 'neutral' },
    ],
    upgrade: {
      effects: [
        { kind: 'block', amount: 3 },
        { kind: 'enterStance', stance: 'neutral' },
      ],
    },
  }),
  empty_fist: card({
    id: 'empty_fist',
    name: 'Empty Fist',
    owner: 'watcher',
    type: 'attack',
    rarity: 'common',
    cost: 1,
    effects: [
      { kind: 'hit', amount: 2 },
      { kind: 'enterStance', stance: 'neutral' },
    ],
    upgrade: {
      effects: [
        { kind: 'hit', amount: 3 },
        { kind: 'enterStance', stance: 'neutral' },
      ],
    },
  }),
  collect: card({
    id: 'collect',
    name: 'Collect',
    owner: 'watcher',
    type: 'skill',
    rarity: 'common',
    cost: 1,
    exhaust: true,
    effects: [{ kind: 'gainMiracle', amount: 2 }],
    upgrade: { effects: [{ kind: 'gainMiracle', amount: 3 }] },
  }),
  halt: card({
    id: 'halt',
    name: 'Halt',
    owner: 'watcher',
    type: 'skill',
    rarity: 'common',
    cost: 0,
    effects: [
      { kind: 'block', amount: 1 },
      { kind: 'block', amount: 1, when: { kind: 'inStance', stance: 'wrath' } },
    ],
    upgrade: {
      effects: [
        { kind: 'block', amount: 1 },
        { kind: 'block', amount: 2, when: { kind: 'inStance', stance: 'wrath' } },
      ],
    },
  }),

  body_slam: card({
    id: 'body_slam',
    name: 'Body Slam',
    owner: 'ironclad',
    type: 'attack',
    rarity: 'common',
    cost: 1,
    effects: [{ kind: 'hit', amount: { base: 0, per: 'block' } }],
    upgrade: { cost: 0 },
  }),
  clash: card({
    id: 'clash',
    name: 'Clash',
    owner: 'ironclad',
    type: 'attack',
    rarity: 'uncommon',
    cost: 0,
    playCondition: { kind: 'allCardsInHandAreAttacks' },
    effects: [{ kind: 'hit', amount: 3 }],
    upgrade: { effects: [{ kind: 'hit', amount: 4 }] },
  }),
  spot_weakness: card({
    id: 'spot_weakness',
    name: 'Spot Weakness',
    owner: 'ironclad',
    type: 'skill',
    rarity: 'uncommon',
    cost: 1,
    supportTarget: 'anyPlayer',
    effects: [{ kind: 'gainStrength', amount: 1, toChosen: true, when: { kind: 'dieShows', faces: [1, 2, 3] } }],
    upgrade: {
      effects: [{ kind: 'gainStrength', amount: 1, toChosen: true, when: { kind: 'dieShows', faces: [1, 2, 3, 4] } }],
    },
  }),
  rage: card({
    id: 'rage',
    name: 'Rage',
    owner: 'ironclad',
    type: 'skill',
    rarity: 'uncommon',
    cost: 1,
    effects: [{ kind: 'block', amount: { base: 0, per: 'attacksInHand' } }],
    upgrade: { cost: 0 },
  }),
  blood_for_blood: card({
    id: 'blood_for_blood',
    name: 'Blood for Blood',
    owner: 'ironclad',
    type: 'attack',
    rarity: 'uncommon',
    cost: 3,
    costAfterHpLoss: 1,
    effects: [{ kind: 'hit', amount: 4 }],
    upgrade: { costAfterHpLoss: 0 },
  }),
  heavy_blade: card({
    id: 'heavy_blade',
    name: 'Heavy Blade',
    owner: 'ironclad',
    type: 'attack',
    rarity: 'common',
    cost: 2,
    // Normal hit arithmetic already adds Strength once; these extra two/four
    // make each token worth the printed +3/+5 total.
    effects: [{ kind: 'hit', amount: { base: 3, per: 'strength', scale: 2 } }],
    upgrade: { effects: [{ kind: 'hit', amount: { base: 3, per: 'strength', scale: 4 } }] },
  }),
  seeing_red: card({
    id: 'seeing_red',
    name: 'Seeing Red',
    owner: 'ironclad',
    type: 'skill',
    rarity: 'common',
    cost: 1,
    exhaust: true,
    effects: [{ kind: 'gainEnergy', amount: 2 }],
    upgrade: { cost: 0 },
  }),
  wild_strike: card({
    id: 'wild_strike',
    name: 'Wild Strike',
    owner: 'ironclad',
    type: 'attack',
    rarity: 'common',
    cost: 1,
    effects: [{ kind: 'hit', amount: 3 }, { kind: 'addDaze', amount: 1, pile: 'draw' }],
    upgrade: { effects: [{ kind: 'hit', amount: 4 }, { kind: 'addDaze', amount: 1, pile: 'draw' }] },
  }),

  blade_dance: card({
    id: 'blade_dance',
    name: 'Blade Dance',
    owner: 'silent',
    type: 'skill',
    rarity: 'common',
    cost: 1,
    effects: [{ kind: 'gainShiv', amount: 2 }],
    upgrade: { effects: [{ kind: 'gainShiv', amount: 3 }] },
  }),
  cloak_and_dagger: card({
    id: 'cloak_and_dagger',
    name: 'Cloak and Dagger',
    owner: 'silent',
    type: 'skill',
    rarity: 'common',
    cost: 1,
    effects: [{ kind: 'gainShiv', amount: 1 }, { kind: 'block', amount: 1 }],
    upgrade: { effects: [{ kind: 'gainShiv', amount: 2 }, { kind: 'block', amount: 1 }] },
  }),
  sneaky_strike: card({
    id: 'sneaky_strike',
    name: 'Sneaky Strike',
    owner: 'silent',
    type: 'attack',
    rarity: 'common',
    cost: 2,
    effects: [
      { kind: 'hit', amount: 3 },
      { kind: 'gainEnergy', amount: 2, when: { kind: 'discardedThisTurn' } },
    ],
    upgrade: {
      effects: [
        { kind: 'hit', amount: 4 },
        { kind: 'gainEnergy', amount: 2, when: { kind: 'discardedThisTurn' } },
      ],
    },
  }),
  terror: card({
    id: 'terror',
    name: 'Terror',
    owner: 'silent',
    type: 'skill',
    rarity: 'uncommon',
    cost: 1,
    exhaust: true,
    effects: [{ kind: 'applyVulnerable', amount: 1 }],
    upgrade: { exhaust: false },
  }),
  backstab: card({
    id: 'backstab',
    name: 'Backstab',
    owner: 'silent',
    type: 'attack',
    rarity: 'uncommon',
    cost: 0,
    exhaust: true,
    effects: [{ kind: 'hit', amount: { base: 2, bonus: { plus: 2, when: { kind: 'targetFullHp' } } } }],
    upgrade: {
      effects: [{ kind: 'hit', amount: { base: 4, bonus: { plus: 2, when: { kind: 'targetFullHp' } } } }],
    },
  }),
  predator: card({
    id: 'predator',
    name: 'Predator',
    owner: 'silent',
    type: 'attack',
    rarity: 'uncommon',
    cost: 2,
    supportTarget: 'anyPlayer',
    effects: [{ kind: 'hit', amount: 3 }, { kind: 'draw', amount: 2, toChosen: true }],
    upgrade: { effects: [{ kind: 'hit', amount: 4 }, { kind: 'draw', amount: 2, toChosen: true }] },
  }),
  leg_sweep: card({
    id: 'leg_sweep',
    name: 'Leg Sweep',
    owner: 'silent',
    type: 'skill',
    rarity: 'uncommon',
    cost: 2,
    effects: [{ kind: 'applyWeak', amount: 1 }, { kind: 'block', amount: 3 }],
    upgrade: { effects: [{ kind: 'applyWeak', amount: 1 }, { kind: 'block', amount: 4 }] },
  }),

  sweeping_beam: card({
    id: 'sweeping_beam',
    name: 'Sweeping Beam',
    owner: 'defect',
    type: 'attack',
    rarity: 'common',
    cost: 1,
    target: 'allEnemies',
    effects: [{ kind: 'hit', amount: 1 }, { kind: 'draw', amount: 1 }],
    upgrade: { effects: [{ kind: 'hit', amount: 2 }, { kind: 'draw', amount: 1 }] },
  }),
  compile_driver: card({
    id: 'compile_driver',
    name: 'Compile Driver',
    owner: 'defect',
    type: 'attack',
    rarity: 'common',
    cost: 1,
    effects: [{ kind: 'hit', amount: 1 }, { kind: 'draw', amount: { base: 0, per: 'orbTypes' } }],
    upgrade: { effects: [{ kind: 'hit', amount: 2 }, { kind: 'draw', amount: { base: 0, per: 'orbTypes' } }] },
  }),
  scrape: card({
    id: 'scrape',
    name: 'Scrape',
    owner: 'defect',
    type: 'attack',
    rarity: 'common',
    cost: 1,
    effects: [{ kind: 'hit', amount: 2 }, { kind: 'recoverDiscardTopCosts', cost: 0 }],
    upgrade: { effects: [{ kind: 'hit', amount: 3 }, { kind: 'recoverDiscardTopCosts', cost: 0 }] },
  }),
  turbo: card({
    id: 'turbo',
    name: 'TURBO',
    owner: 'defect',
    type: 'skill',
    rarity: 'common',
    cost: 0,
    exhaust: true,
    effects: [{ kind: 'gainEnergy', amount: 2 }, { kind: 'addDaze', amount: 1, pile: 'discard' }],
    upgrade: { effects: [{ kind: 'gainEnergy', amount: 3 }, { kind: 'addDaze', amount: 1, pile: 'discard' }] },
  }),
  skim: card({
    id: 'skim',
    name: 'Skim',
    owner: 'defect',
    type: 'skill',
    rarity: 'common',
    cost: 1,
    effects: [{ kind: 'draw', amount: 3 }],
    upgrade: { effects: [{ kind: 'draw', amount: 4 }] },
  }),
  claw: card({
    id: 'claw',
    name: 'Claw',
    owner: 'defect',
    type: 'attack',
    rarity: 'common',
    cost: 0,
    effects: [{ kind: 'hit', amount: { base: 1, bonus: { plus: 1, when: { kind: 'discardTopCosts', cost: 0 } } } }],
    upgrade: {
      effects: [{ kind: 'hit', amount: { base: 1, bonus: { plus: 3, when: { kind: 'discardTopCosts', cost: 0 } } } }],
    },
  }),

  crescendo: card({
    id: 'crescendo',
    name: 'Crescendo',
    owner: 'watcher',
    type: 'skill',
    rarity: 'common',
    cost: 0,
    retain: true,
    exhaust: true,
    effects: [{ kind: 'enterStance', stance: 'wrath' }],
    upgrade: { effects: [{ kind: 'enterStance', stance: 'wrath' }, { kind: 'draw', amount: 1 }] },
  }),
  flurry_of_blows: card({
    id: 'flurry_of_blows',
    name: 'Flurry of Blows',
    owner: 'watcher',
    type: 'attack',
    rarity: 'common',
    cost: 0,
    effects: [{
      kind: 'hit',
      amount: 1,
      times: { base: 1, bonus: { plus: 1, when: { kind: 'stanceChangedThisTurn' } } },
    }],
    upgrade: {
      effects: [{
        kind: 'hit',
        amount: 1,
        times: { base: 1, bonus: { plus: 2, when: { kind: 'stanceChangedThisTurn' } } },
      }],
    },
  }),
  flying_sleeves: card({
    id: 'flying_sleeves',
    name: 'Flying Sleeves',
    owner: 'watcher',
    type: 'attack',
    rarity: 'common',
    cost: 1,
    retain: true,
    effects: [{ kind: 'hit', amount: 1, times: 2 }],
    upgrade: { effects: [{ kind: 'hit', amount: 1, times: 3 }] },
  }),
  protect: card({
    id: 'protect',
    name: 'Protect',
    owner: 'watcher',
    type: 'skill',
    rarity: 'common',
    cost: 2,
    retain: true,
    supportTarget: 'anyPlayer',
    effects: [{ kind: 'block', amount: 3, toChosen: true }],
    upgrade: { effects: [{ kind: 'block', amount: 4, toChosen: true }] },
  }),
  prostrate: card({
    id: 'prostrate', name: 'Prostrate', owner: 'watcher', type: 'skill', rarity: 'uncommon', cost: 1,
    effects: [{ kind: 'block', amount: 1 }, { kind: 'gainMiracle', amount: 1 }],
    upgrade: { effects: [{ kind: 'block', amount: 2 }, { kind: 'gainMiracle', amount: 1 }] },
  }),
  pray: card({
    id: 'pray', name: 'Pray', owner: 'watcher', type: 'skill', rarity: 'uncommon', cost: 1,
    effects: [{ kind: 'gainMiracle', amount: 1 }, { kind: 'draw', amount: 2 }, { kind: 'preventDraw' }],
    upgrade: {
      effects: [{ kind: 'gainMiracle', amount: 2 }, { kind: 'draw', amount: 2 }, { kind: 'preventDraw' }],
    },
  }),
  third_eye: card({
    id: 'third_eye', name: 'Third Eye', owner: 'watcher', type: 'skill', rarity: 'common', cost: 1,
    effects: [{ kind: 'block', amount: 2 }, { kind: 'scry', amount: 3 }],
    upgrade: { effects: [{ kind: 'block', amount: 3 }, { kind: 'scry', amount: 5 }] },
  }),
  cut_through_fate: card({
    id: 'cut_through_fate', name: 'Cut Through Fate', owner: 'watcher', type: 'attack', rarity: 'common', cost: 1,
    effects: [{ kind: 'hit', amount: 1 }, { kind: 'scry', amount: 2 }, { kind: 'draw', amount: 1 }],
    upgrade: {
      effects: [{ kind: 'hit', amount: 2 }, { kind: 'scry', amount: 3 }, { kind: 'draw', amount: 1 }],
    },
  }),
  just_lucky: card({
    id: 'just_lucky', name: 'Just Lucky', owner: 'watcher', type: 'attack', rarity: 'common', cost: 0,
    effects: [
      { kind: 'hit', amount: 1 },
      { kind: 'scry', amount: 1, when: { kind: 'dieShows', faces: [1, 2, 3] } },
      { kind: 'block', amount: 1, when: { kind: 'dieShows', faces: [4, 5, 6] } },
    ],
    upgrade: {
      effects: [
        { kind: 'hit', amount: 2 },
        { kind: 'scry', amount: 2, when: { kind: 'dieShows', faces: [1, 2, 3] } },
        { kind: 'block', amount: 1, when: { kind: 'dieShows', faces: [4, 5, 6] } },
      ],
    },
  }),
  tranquility: card({
    id: 'tranquility',
    name: 'Tranquility',
    owner: 'watcher',
    type: 'skill',
    rarity: 'common',
    cost: 1,
    retain: true,
    exhaust: true,
    effects: [{ kind: 'enterStance', stance: 'calm' }],
    upgrade: { cost: 0 },
  }),
  empty_mind: card({
    id: 'empty_mind',
    name: 'Empty Mind',
    owner: 'watcher',
    type: 'skill',
    rarity: 'uncommon',
    cost: 1,
    effects: [{ kind: 'draw', amount: 2 }, { kind: 'enterStance', stance: 'neutral' }],
    upgrade: { effects: [{ kind: 'draw', amount: 3 }, { kind: 'enterStance', stance: 'neutral' }] },
  }),
  crush_joints: card({
    id: 'crush_joints',
    name: 'Crush Joints',
    owner: 'watcher',
    type: 'attack',
    rarity: 'uncommon',
    cost: 1,
    effects: [
      { kind: 'hit', amount: 1 },
      { kind: 'applyVulnerable', amount: 1, when: { kind: 'inStance', stance: 'wrath' } },
    ],
    upgrade: {
      effects: [
        { kind: 'hit', amount: 2 },
        { kind: 'applyVulnerable', amount: 1, when: { kind: 'inStance', stance: 'wrath' } },
      ],
    },
  }),
  fear_no_evil: card({
    id: 'fear_no_evil',
    name: 'Fear No Evil',
    owner: 'watcher',
    type: 'attack',
    rarity: 'uncommon',
    cost: 1,
    effects: [
      { kind: 'hit', amount: 2 },
      { kind: 'enterStance', stance: 'calm', when: { kind: 'inStance', stance: 'wrath' } },
    ],
    upgrade: {
      effects: [
        { kind: 'hit', amount: 3 },
        { kind: 'enterStance', stance: 'calm', when: { kind: 'inStance', stance: 'wrath' } },
      ],
    },
  }),

  // ---------------------------------------------------------------------------
  // Cards whose printed number is not a number: a bonus the board has to check,
  // or a count it has to take.
  //
  // Note which of the two each card uses, because they are not interchangeable.
  // Slice prints "1 damage, +1 damage if you have a shiv" as ONE attack, so the
  // bonus lives inside the amount; splitting it into two hits would let a Block
  // of 1 stop what a single hit for 2 gets through. Go for the Eyes' Weak is a
  // whole clause instead, and carries `when` on the effect.
  // ---------------------------------------------------------------------------

  slice: card({
    id: 'slice',
    name: 'Slice',
    owner: 'silent',
    type: 'attack',
    rarity: 'common',
    cost: 0,
    effects: [{ kind: 'hit', amount: { base: 1, bonus: { plus: 1, when: { kind: 'hasShiv' } } } }],
    // Only the printed number moves; the bonus clause is the same on both faces.
    upgrade: { effects: [{ kind: 'hit', amount: { base: 2, bonus: { plus: 1, when: { kind: 'hasShiv' } } } }] },
  }),
  deflect: card({
    id: 'deflect',
    name: 'Deflect',
    owner: 'silent',
    type: 'skill',
    rarity: 'common',
    cost: 0,
    effects: [{ kind: 'block', amount: { base: 1, bonus: { plus: 1, when: { kind: 'hasShiv' } } } }],
    upgrade: {
      effects: [{ kind: 'block', amount: { base: 2, bonus: { plus: 1, when: { kind: 'hasShiv' } } } }],
    },
  }),
  dodge_and_roll: card({
    id: 'dodge_and_roll', name: 'Dodge and Roll', owner: 'silent', type: 'skill', rarity: 'common', cost: 1,
    effects: [{ kind: 'blockChoices', amount: 1, targets: 2 }],
    upgrade: { effects: [{ kind: 'blockChoices', amount: 1, targets: 3 }] },
  }),
  bane: card({
    id: 'bane',
    name: 'Bane',
    owner: 'silent',
    type: 'attack',
    // Blue banner on the scan, and one copy in the box, not two.
    rarity: 'uncommon',
    cost: 1,
    // The one card whose bonus reads the ENEMY rather than the player's board.
    effects: [{ kind: 'hit', amount: { base: 2, bonus: { plus: 2, when: { kind: 'targetPoisoned' } } } }],
    upgrade: {
      effects: [{ kind: 'hit', amount: { base: 3, bonus: { plus: 2, when: { kind: 'targetPoisoned' } } } }],
    },
  }),

  steam_barrier: card({
    id: 'steam_barrier',
    name: 'Steam Barrier',
    owner: 'defect',
    type: 'skill',
    rarity: 'common',
    cost: 0,
    effects: [
      { kind: 'block', amount: { base: 1, bonus: { plus: 1, when: { kind: 'discardTopCosts', cost: 0 } } } },
    ],
    upgrade: {
      effects: [
        { kind: 'block', amount: { base: 2, bonus: { plus: 1, when: { kind: 'discardTopCosts', cost: 0 } } } },
      ],
    },
  }),
  barrage: card({
    id: 'barrage',
    name: 'Barrage',
    owner: 'defect',
    type: 'attack',
    rarity: 'common',
    cost: 1,
    // "Deal 1 damage for each Orb you have" — the ORB COUNT is the number of
    // swings, not the size of one. Each is checked against Block separately,
    // which is why holding four orbs is not the same as one hit for four.
    effects: [{ kind: 'hit', amount: 1, times: { base: 0, per: 'orbs' } }],
    // The upgraded face prints "for each Orb you have +1", so it swings once
    // even with no orbs charged.
    upgrade: { effects: [{ kind: 'hit', amount: 1, times: { base: 1, per: 'orbs' } }] },
  }),
  go_for_the_eyes: card({
    id: 'go_for_the_eyes',
    name: 'Go for the Eyes',
    owner: 'defect',
    type: 'attack',
    rarity: 'common',
    cost: 0,
    effects: [
      { kind: 'hit', amount: 1 },
      // The base face prints two die rows: 1-2-3 is the hit alone, 4-5-6 adds
      // the Weak. One shared roll per round decides it for every player (p.12).
      { kind: 'applyWeak', amount: 1, when: { kind: 'dieShows', faces: [4, 5, 6] } },
    ],
    // The upgraded face prints no dice at all: the Weak always lands.
    upgrade: {
      effects: [
        { kind: 'hit', amount: 1 },
        { kind: 'applyWeak', amount: 1 },
      ],
    },
  }),
  beam_cell: card({
    id: 'beam_cell', name: 'Beam Cell', owner: 'defect', type: 'attack', rarity: 'uncommon', cost: 1,
    effects: [
      { kind: 'hit', amount: 1 },
      { kind: 'applyVulnerable', amount: 1, when: { kind: 'dieShows', faces: [1, 2, 3] } },
    ],
    upgrade: {
      effects: [{ kind: 'hit', amount: 1 }, { kind: 'applyVulnerable', amount: 1 }],
    },
  }),
  ftl: card({
    id: 'ftl', name: 'FTL', owner: 'defect', type: 'attack', rarity: 'uncommon', cost: 0,
    effects: [
      { kind: 'hit', amount: 1 },
      { kind: 'draw', amount: 1, when: { kind: 'firstCardPlayedThisTurn' } },
    ],
    upgrade: {
      effects: [
        { kind: 'hit', amount: 2 },
        { kind: 'draw', amount: 1, when: { kind: 'firstCardPlayedThisTurn' } },
      ],
    },
  }),
  force_field: card({
    id: 'force_field', name: 'Force Field', owner: 'defect', type: 'skill', rarity: 'uncommon', cost: 3,
    powerCostReduction: 1,
    effects: [{ kind: 'block', amount: 3 }],
    upgrade: { effects: [{ kind: 'block', amount: 4 }] },
  }),
  tempest: card({
    id: 'tempest', name: 'Tempest', owner: 'defect', type: 'skill', rarity: 'uncommon', cost: 'X',
    exhaust: true,
    effects: [{ kind: 'channel', orb: 'lightning', amount: { base: 0, per: 'energySpent' } }],
    upgrade: {
      effects: [{ kind: 'channel', orb: 'lightning', amount: { base: 1, per: 'energySpent' } }],
    },
  }),
  blizzard: card({
    id: 'blizzard', name: 'Blizzard', owner: 'defect', type: 'attack', rarity: 'uncommon', cost: 1,
    effects: [{ kind: 'hit', amount: 2, times: { base: 0, per: 'frostOrbs' } }],
    upgrade: { effects: [{ kind: 'hit', amount: 3, times: { base: 0, per: 'frostOrbs' } }] },
  }),
  hologram: card({
    id: 'hologram', name: 'Hologram', owner: 'defect', type: 'skill', rarity: 'uncommon', cost: 1,
    exhaust: true,
    effects: [{ kind: 'block', amount: 1 }, { kind: 'recoverDiscard', amount: 1, toHand: true }],
    upgrade: { exhaust: false },
  }),
  doom_and_gloom: card({
    id: 'doom_and_gloom', name: 'Doom and Gloom', owner: 'defect', type: 'attack', rarity: 'uncommon', cost: 2,
    target: 'row',
    effects: [{ kind: 'hit', amount: 2 }, { kind: 'channel', orb: 'dark', amount: 1 }],
    upgrade: { effects: [{ kind: 'hit', amount: 3 }, { kind: 'channel', orb: 'dark', amount: 1 }] },
  }),
  overclock: card({
    id: 'overclock', name: 'Overclock', owner: 'defect', type: 'skill', rarity: 'uncommon', cost: 0,
    effects: [{ kind: 'draw', amount: 2 }, { kind: 'addDaze', amount: 1, pile: 'discard' }],
    upgrade: { effects: [{ kind: 'draw', amount: 3 }, { kind: 'addDaze', amount: 1, pile: 'discard' }] },
  }),
  darkness: card({
    id: 'darkness', name: 'Darkness', owner: 'defect', type: 'skill', rarity: 'uncommon', cost: 1,
    effects: [{ kind: 'channel', orb: 'dark', amount: 1 }],
    upgrade: { cost: 0 },
  }),
  storm: card({
    id: 'storm', name: 'Storm', owner: 'defect', type: 'power', rarity: 'uncommon', cost: 1,
    trigger: { kind: 'startOfTurn' },
    effects: [{ kind: 'channel', orb: 'lightning', amount: 1 }],
    upgrade: { effects: [{ kind: 'channel', orb: 'lightning', amount: 2 }] },
  }),
  machine_learning: card({
    id: 'machine_learning', name: 'Machine Learning', owner: 'defect', type: 'power', rarity: 'uncommon', cost: 1,
    trigger: { kind: 'startOfTurn' },
    effects: [{ kind: 'draw', amount: 1 }],
    upgrade: { cost: 0 },
  }),
  leap: card({
    id: 'leap', name: 'Leap', owner: 'defect', type: 'skill', rarity: 'common', cost: 1,
    supportTarget: 'anyPlayer',
    effects: [{ kind: 'block', amount: 2, toChosen: true }, { kind: 'switchRows' }],
    upgrade: { effects: [{ kind: 'block', amount: 3, toChosen: true }, { kind: 'switchRows' }] },
  }),
  glacier: card({
    id: 'glacier', name: 'Glacier', owner: 'defect', type: 'skill', rarity: 'uncommon', cost: 2,
    effects: [{ kind: 'block', amount: 2 }, { kind: 'channel', orb: 'frost', amount: 1 }],
    upgrade: {
      supportTarget: 'anyPlayer',
      effects: [{ kind: 'block', amount: 3, toChosen: true }, { kind: 'channel', orb: 'frost', amount: 1 }],
    },
  }),
  rainbow: card({
    id: 'rainbow', name: 'Rainbow', owner: 'defect', type: 'skill', rarity: 'rare', cost: 2,
    exhaust: true,
    effects: [
      { kind: 'channel', orb: 'lightning', amount: 1 },
      { kind: 'channel', orb: 'frost', amount: 1 },
      { kind: 'channel', orb: 'dark', amount: 1 },
    ],
    upgrade: { exhaust: false },
  }),

  finesse: card({
    id: 'finesse', name: 'Finesse', owner: 'colorless', type: 'skill', rarity: 'uncommon', cost: 0,
    exhaust: true,
    effects: [{ kind: 'block', amount: 1 }, { kind: 'draw', amount: 1 }],
    upgrade: { exhaust: false },
  }),
  flash_of_steel: card({
    id: 'flash_of_steel', name: 'Flash of Steel', owner: 'colorless', type: 'attack', rarity: 'uncommon', cost: 0,
    exhaust: true,
    effects: [{ kind: 'hit', amount: 1 }, { kind: 'draw', amount: 1 }],
    upgrade: { exhaust: false },
  }),
  good_instincts: card({
    id: 'good_instincts', name: 'Good Instincts', owner: 'colorless', type: 'skill', rarity: 'uncommon', cost: 0,
    supportTarget: 'anyPlayer',
    effects: [{ kind: 'block', amount: 1, toChosen: true }],
    upgrade: { effects: [{ kind: 'block', amount: 2, toChosen: true }] },
  }),
  swift_strike: card({
    id: 'swift_strike', name: 'Swift Strike', owner: 'colorless', type: 'attack', rarity: 'uncommon', cost: 0,
    effects: [{ kind: 'hit', amount: 1 }, { kind: 'switchRows' }],
    upgrade: { effects: [{ kind: 'hit', amount: 2 }, { kind: 'switchRows' }] },
  }),
  blind: card({
    id: 'blind', name: 'Blind', owner: 'colorless', type: 'skill', rarity: 'uncommon', cost: 0,
    exhaust: true,
    effects: [{ kind: 'applyWeak', amount: 1 }],
    upgrade: { effects: [{ kind: 'applyWeak', amount: 2 }] },
  }),
  dramatic_entrance: card({
    id: 'dramatic_entrance', name: 'Dramatic Entrance', owner: 'colorless', type: 'attack', rarity: 'uncommon', cost: 0,
    target: 'row',
    exhaust: true,
    effects: [{
      kind: 'hit',
      amount: { base: 2, bonus: { plus: 1, when: { kind: 'firstTurnOfCombat' } } },
    }],
    upgrade: { effects: [{
      kind: 'hit',
      amount: { base: 2, bonus: { plus: 3, when: { kind: 'firstTurnOfCombat' } } },
    }] },
  }),
  master_of_strategy: card({
    id: 'master_of_strategy', name: 'Master of Strategy', owner: 'colorless', type: 'skill', rarity: 'rare', cost: 0,
    exhaust: true,
    effects: [{ kind: 'draw', amount: 3 }],
    upgrade: { effects: [{ kind: 'draw', amount: 4 }] },
  }),
  trip: card({
    id: 'trip', name: 'Trip', owner: 'colorless', type: 'skill', rarity: 'uncommon', cost: 2,
    exhaust: true,
    effects: [{ kind: 'applyVulnerable', amount: 2 }],
    upgrade: { effects: [{ kind: 'applyVulnerable', amount: 3 }] },
  }),
  impatience: card({
    id: 'impatience', name: 'Impatience', owner: 'colorless', type: 'skill', rarity: 'uncommon', cost: 0,
    effects: [{ kind: 'draw', amount: 2, when: { kind: 'hasNoAttacksInHand' } }],
    upgrade: { effects: [{ kind: 'draw', amount: 3, when: { kind: 'hasNoAttacksInHand' } }] },
  }),
  mind_blast: card({
    id: 'mind_blast', name: 'Mind Blast', owner: 'colorless', type: 'attack', rarity: 'uncommon', cost: 2,
    effects: [{ kind: 'hit', amount: { base: 0, per: 'cardsInHand' } }],
    upgrade: { effects: [{ kind: 'hit', amount: { base: 1, per: 'cardsInHand' } }] },
  }),
  hand_of_greed: card({
    id: 'hand_of_greed', name: 'Hand of Greed', owner: 'colorless', type: 'attack', rarity: 'rare', cost: 2,
    effects: [{ kind: 'hit', amount: { base: 4, bonus: { plus: 3, when: { kind: 'goldAtLeast', amount: 10 } } } }],
    upgrade: {
      effects: [{ kind: 'hit', amount: { base: 4, bonus: { plus: 5, when: { kind: 'goldAtLeast', amount: 10 } } } }],
    },
  }),
  panacea: card({
    id: 'panacea', name: 'Panacea', owner: 'colorless', type: 'skill', rarity: 'uncommon', cost: 0,
    supportTarget: 'anyPlayer',
    retain: true,
    exhaust: true,
    effects: [{ kind: 'clearDebuffs', toChosen: true }],
    upgrade: { supportTarget: 'allPlayers' },
  }),
  purity: card({
    id: 'purity', name: 'Purity', owner: 'colorless', type: 'skill', rarity: 'uncommon', cost: 0,
    exhaust: true,
    effects: [{ kind: 'exhaustAny', amount: 3 }],
    upgrade: { effects: [{ kind: 'exhaustAny', amount: 5 }] },
  }),
  apparition: card({
    id: 'apparition', name: 'Apparition', owner: 'colorless', type: 'skill', rarity: 'uncommon', cost: 1,
    ethereal: true,
    exhaust: true,
    effects: [{ kind: 'limitRoundHpLoss', amount: 1 }],
    upgrade: { ethereal: false },
  }),
  dark_shackles: card({
    id: 'dark_shackles', name: 'Dark Shackles', owner: 'colorless', type: 'skill', rarity: 'uncommon', cost: 0,
    exhaust: true,
    effects: [{ kind: 'block', amount: { base: 0, per: 'attackingEnemies', scale: 2 } }],
    upgrade: { effects: [{ kind: 'block', amount: { base: 0, per: 'attackingEnemies', scale: 3 } }] },
  }),
  madness: card({
    id: 'madness', name: 'Madness', owner: 'colorless', type: 'skill', rarity: 'uncommon', cost: 0,
    exhaust: true,
    effects: [{ kind: 'discountNextCard' }],
    upgrade: { retain: true },
  }),
  panache: card({
    id: 'panache', name: 'Panache', owner: 'colorless', type: 'power', rarity: 'uncommon', cost: 0,
    trigger: { kind: 'endOfTurn' },
    target: 'row',
    effects: [{ kind: 'damage', amount: 3, when: { kind: 'handEmpty' } }],
    upgrade: { effects: [{ kind: 'damage', amount: 5, when: { kind: 'handEmpty' } }] },
  }),
  apotheosis: card({
    id: 'apotheosis', name: 'Apotheosis', owner: 'colorless', type: 'power', rarity: 'rare', cost: 2,
    resolvesOnPlay: true,
    effects: [{ kind: 'upgradeStarterCards', amount: 1 }],
    upgrade: { cost: 1 },
  }),
  the_bomb: card({
    id: 'the_bomb', name: 'The Bomb', owner: 'colorless', type: 'power', rarity: 'rare', cost: 2,
    trigger: { kind: 'endOfTurn' },
    target: 'allEnemies',
    effects: [{ kind: 'countdownDamage', cubes: 3, damage: 10 }],
    upgrade: { effects: [{ kind: 'countdownDamage', cubes: 3, damage: 12 }] },
  }),
  sadistic_nature: card({
    id: 'sadistic_nature', name: 'Sadistic Nature', owner: 'colorless', type: 'power', rarity: 'uncommon', cost: 0,
    trigger: { kind: 'onPutEnemyToken' },
    target: 'enemy',
    effects: [{ kind: 'damage', amount: 1 }],
    upgrade: { effects: [{ kind: 'damage', amount: 2 }] },
  }),
  thinking_ahead: card({
    id: 'thinking_ahead', name: 'Thinking Ahead', owner: 'colorless', type: 'skill', rarity: 'uncommon', cost: 0,
    exhaust: true,
    effects: [{ kind: 'draw', amount: 2 }, { kind: 'topdeck', amount: 1 }],
    upgrade: { effects: [{ kind: 'draw', amount: 3 }, { kind: 'topdeck', amount: 1 }] },
  }),
  mayhem: card({
    id: 'mayhem', name: 'Mayhem', owner: 'colorless', type: 'power', rarity: 'rare', cost: 2,
    trigger: { kind: 'startOfTurn' },
    effects: [{ kind: 'drawAndPlayFree' }],
    upgrade: { cost: 1 },
  }),
  reprogram: card({
    id: 'reprogram', name: 'Reprogram', owner: 'defect', type: 'skill', rarity: 'uncommon', cost: 1,
    effects: [{ kind: 'gainStrength', amount: 1 }, { kind: 'removeAllOrbs' }],
    upgrade: { cost: 0 },
  }),
  melter: card({
    id: 'melter', name: 'Melter', owner: 'defect', type: 'attack', rarity: 'uncommon', cost: 1,
    effects: [{ kind: 'clearTargetBlock' }, { kind: 'hit', amount: 2 }],
    upgrade: { effects: [{ kind: 'clearTargetBlock' }, { kind: 'hit', amount: 3 }] },
  }),
  hyperbeam: card({
    id: 'hyperbeam', name: 'Hyperbeam', owner: 'defect', type: 'attack', rarity: 'rare', cost: 2,
    target: 'row',
    effects: [{ kind: 'hit', amount: 5 }, { kind: 'removeAllOrbs' }],
    upgrade: { effects: [{ kind: 'hit', amount: 7 }, { kind: 'removeAllOrbs' }] },
  }),
  sunder: card({
    id: 'sunder', name: 'Sunder', owner: 'defect', type: 'attack', rarity: 'uncommon', cost: 3,
    effects: [{ kind: 'hit', amount: 5 }, { kind: 'gainEnergyIfTargetDead', amount: 3 }],
    upgrade: { effects: [{ kind: 'hit', amount: 7 }, { kind: 'gainEnergyIfTargetDead', amount: 3 }] },
  }),
  fusion: card({
    id: 'fusion', name: 'Fusion', owner: 'defect', type: 'power', rarity: 'uncommon', cost: 2,
    trigger: { kind: 'startOfTurn' },
    effects: [{ kind: 'gainEnergy', amount: 1 }],
    upgrade: { cost: 1 },
  }),
  heatsinks: card({
    id: 'heatsinks', name: 'Heatsinks', owner: 'defect', type: 'power', rarity: 'uncommon', cost: 1,
    trigger: { kind: 'onPlayCard', cardType: 'power' },
    effects: [{ kind: 'draw', amount: 2 }],
    upgrade: { effects: [{ kind: 'draw', amount: 3 }] },
  }),
  stack: card({
    id: 'stack', name: 'Stack', owner: 'defect', type: 'skill', rarity: 'uncommon', cost: 1,
    supportTarget: 'anyPlayer',
    effects: [{ kind: 'block', amount: { base: 0, per: 'orbs' }, toChosen: true }],
    upgrade: { effects: [{ kind: 'block', amount: { base: 1, per: 'orbs' }, toChosen: true }] },
  }),
  capacitor: card({
    id: 'capacitor', name: 'Capacitor', owner: 'defect', type: 'power', rarity: 'uncommon', cost: 1,
    resolvesOnPlay: true,
    effects: [{ kind: 'gainOrbSlots', amount: 2 }],
    upgrade: { effects: [{ kind: 'gainOrbSlots', amount: 3 }] },
  }),
  consume: card({
    id: 'consume', name: 'Consume', owner: 'defect', type: 'power', rarity: 'uncommon', cost: 2,
    resolvesOnPlay: true,
    effects: [{ kind: 'gainOrbEvokeBonus', amount: 1 }],
    upgrade: { cost: 1 },
  }),
  defragment: card({
    id: 'defragment', name: 'Defragment', owner: 'defect', type: 'power', rarity: 'rare', cost: 3,
    ethereal: true,
    resolvesOnPlay: true,
    effects: [{ kind: 'gainOrbEndTurnBonus', amount: 1 }],
    upgrade: { ethereal: false },
  }),
  double_energy: card({
    id: 'double_energy', name: 'Double Energy', owner: 'defect', type: 'skill', rarity: 'uncommon', cost: 1,
    exhaust: true,
    effects: [{ kind: 'doubleEnergy', max: 6 }],
    upgrade: { cost: 0 },
  }),
  streamline: card({
    id: 'streamline', name: 'Streamline', owner: 'defect', type: 'attack', rarity: 'uncommon', cost: 2,
    powerCostReduction: 1,
    effects: [{ kind: 'hit', amount: 3 }],
    upgrade: { effects: [{ kind: 'hit', amount: 4 }] },
  }),
  meteor_strike: card({
    id: 'meteor_strike', name: 'Meteor Strike', owner: 'defect', type: 'attack', rarity: 'rare', cost: 5,
    powerCostReduction: 1,
    effects: [{ kind: 'hit', amount: 10 }],
    upgrade: { effects: [{ kind: 'hit', amount: 12 }] },
  }),
  catalyst: card({
    id: 'catalyst', name: 'Catalyst', owner: 'silent', type: 'skill', rarity: 'uncommon', cost: 1,
    exhaust: true,
    effects: [{ kind: 'multiplyPoison', factor: 2 }],
    upgrade: { effects: [{ kind: 'multiplyPoison', factor: 3 }] },
  }),
  flechettes: card({
    id: 'flechettes', name: 'Flechettes', owner: 'silent', type: 'attack', rarity: 'uncommon', cost: 1,
    effects: [{ kind: 'hit', amount: { base: 0, per: 'skillsInHand' } }],
    upgrade: { effects: [{ kind: 'hit', amount: { base: 1, per: 'skillsInHand' } }] },
  }),
  adrenaline: card({
    id: 'adrenaline', name: 'Adrenaline', owner: 'silent', type: 'skill', rarity: 'rare', cost: 0,
    exhaust: true,
    effects: [{ kind: 'gainEnergy', amount: 1 }, { kind: 'draw', amount: 2 }],
    upgrade: { effects: [{ kind: 'gainEnergy', amount: 2 }, { kind: 'draw', amount: 2 }] },
  }),
  grand_finale: card({
    id: 'grand_finale', name: 'Grand Finale', owner: 'silent', type: 'attack', rarity: 'rare', cost: 0,
    target: 'row',
    playCondition: { kind: 'drawPileEmpty' },
    effects: [{ kind: 'hit', amount: 10 }],
    upgrade: { effects: [{ kind: 'hit', amount: 12 }] },
  }),
  blur: card({
    id: 'blur', name: 'Blur', owner: 'silent', type: 'skill', rarity: 'uncommon', cost: 1,
    effects: [{ kind: 'block', amount: {
      base: 2, bonus: { plus: 1, when: { kind: 'discardedThisTurn' } },
    } }],
    upgrade: { effects: [{ kind: 'block', amount: {
      base: 3, bonus: { plus: 1, when: { kind: 'discardedThisTurn' } },
    } }] },
  }),
  setup: card({
    id: 'setup', name: 'Setup', owner: 'silent', type: 'skill', rarity: 'uncommon', cost: 0,
    supportTarget: 'anyPlayer',
    exhaust: true,
    effects: [{ kind: 'gainEnergy', amount: 1, toChosen: true }],
    upgrade: { effects: [{ kind: 'gainEnergy', amount: 2, toChosen: true }] },
  }),
  all_out_attack: card({
    id: 'all_out_attack', name: 'All-Out Attack', owner: 'silent', type: 'attack', rarity: 'uncommon', cost: 1,
    target: 'allEnemies',
    effects: [{ kind: 'hit', amount: 2 }, { kind: 'discard', amount: 1 }],
    upgrade: { effects: [{ kind: 'hit', amount: 3 }, { kind: 'discard', amount: 1 }] },
  }),
  expertise: card({
    id: 'expertise', name: 'Expertise', owner: 'silent', type: 'skill', rarity: 'uncommon', cost: 1,
    effects: [{ kind: 'drawToHandSize', size: 6 }],
    upgrade: { effects: [{ kind: 'drawToHandSize', size: 7 }] },
  }),
  calculated_gamble: card({
    id: 'calculated_gamble', name: 'Calculated Gamble', owner: 'silent', type: 'skill', rarity: 'uncommon', cost: 0,
    exhaust: true,
    effects: [{ kind: 'cycleHand' }],
    upgrade: { exhaust: false },
  }),
  reflex: card({
    id: 'reflex', name: 'Reflex', owner: 'silent', type: 'skill', rarity: 'uncommon', cost: 0,
    unplayable: true,
    effects: [],
    discardReaction: { effects: [{ kind: 'draw', amount: 2 }] },
    upgrade: { discardReaction: { effects: [{ kind: 'draw', amount: 3 }] } },
  }),
  tactician: card({
    id: 'tactician', name: 'Tactician', owner: 'silent', type: 'skill', rarity: 'uncommon', cost: 0,
    unplayable: true,
    effects: [],
    discardReaction: { effects: [{ kind: 'gainEnergy', amount: 2 }], exhaust: true },
    upgrade: { discardReaction: { effects: [{ kind: 'gainEnergy', amount: 3 }], exhaust: true } },
  }),
  after_image: card({
    id: 'after_image', name: 'After Image', owner: 'silent', type: 'power', rarity: 'rare', cost: 1,
    trigger: { kind: 'onDiscard' },
    effects: [{ kind: 'block', amount: 1 }],
    upgrade: { cost: 0 },
  }),
  escape_plan: card({
    id: 'escape_plan', name: 'Escape Plan', owner: 'silent', type: 'skill', rarity: 'uncommon', cost: 0,
    effects: [{ kind: 'draw', amount: 1 }, { kind: 'block', amount: 1, when: { kind: 'drewSkill' } }],
    upgrade: { effects: [{ kind: 'block', amount: 1 }, { kind: 'draw', amount: 1 }] },
  }),
  finisher: card({
    id: 'finisher', name: 'Finisher', owner: 'silent', type: 'attack', rarity: 'uncommon', cost: 1,
    effects: [{ kind: 'hit', amount: 1, times: { base: 0, per: 'attacksPlayedThisTurn' } }],
    upgrade: { effects: [{ kind: 'hit', amount: 2, times: { base: 0, per: 'attacksPlayedThisTurn' } }] },
  }),
  masterful_stab: card({
    id: 'masterful_stab', name: 'Masterful Stab', owner: 'silent', type: 'attack', rarity: 'uncommon', cost: 0,
    costAfterHpLoss: 2,
    effects: [{ kind: 'hit', amount: 2 }],
    upgrade: { costAfterHpLoss: 1, effects: [{ kind: 'hit', amount: 3 }] },
  }),
  outmaneuver: card({
    id: 'outmaneuver', name: 'Outmaneuver', owner: 'silent', type: 'skill', rarity: 'uncommon', cost: 0,
    retain: true,
    effects: [{ kind: 'gainEnergy', amount: 2, when: { kind: 'retainedLastTurn' } }],
    upgrade: { effects: [{ kind: 'gainEnergy', amount: 3, when: { kind: 'retainedLastTurn' } }] },
  }),
  accuracy: card({
    id: 'accuracy', name: 'Accuracy', owner: 'silent', type: 'power', rarity: 'uncommon', cost: 1,
    resolvesOnPlay: true,
    effects: [{ kind: 'gainShivDamageBonus', amount: 1 }],
    upgrade: { cost: 0 },
  }),
  choke: card({
    id: 'choke', name: 'Choke', owner: 'silent', type: 'attack', rarity: 'uncommon', cost: 2,
    effects: [{ kind: 'hit', amount: { base: 3, targetTokens: ['weak', 'poison'] } }],
    upgrade: { effects: [{ kind: 'hit', amount: { base: 4, targetTokens: ['weak', 'poison'] } }] },
  }),
  footwork: card({
    id: 'footwork', name: 'Footwork', owner: 'silent', type: 'power', rarity: 'uncommon', cost: 2,
    resolvesOnPlay: true,
    effects: [{ kind: 'gainCardBlockBonus', amount: 1 }],
    upgrade: { retain: true },
  }),
  infinite_blades: card({
    id: 'infinite_blades', name: 'Infinite Blades', owner: 'silent', type: 'power', rarity: 'uncommon', cost: 1,
    trigger: { kind: 'startOfTurn' },
    effects: [{ kind: 'gainShiv', amount: 1 }],
    upgrade: { effects: [{ kind: 'gainShiv', amount: 2 }] },
  }),
  noxious_fumes: card({
    id: 'noxious_fumes', name: 'Noxious Fumes', owner: 'silent', type: 'power', rarity: 'uncommon', cost: 1,
    trigger: { kind: 'startOfTurn' },
    target: 'enemy',
    effects: [{ kind: 'poison', amount: 1 }],
    upgrade: { target: 'allEnemies' },
  }),
  envenom: card({
    id: 'envenom', name: 'Envenom', owner: 'silent', type: 'power', rarity: 'rare', cost: 3,
    resolvesOnPlay: true,
    effects: [{ kind: 'gainHitPoison', amount: 1 }],
    upgrade: { cost: 2 },
  }),
  bouncing_flask: card({
    id: 'bouncing_flask', name: 'Bouncing Flask', owner: 'silent', type: 'skill', rarity: 'uncommon', cost: 2,
    effects: [{ kind: 'poisonChoices', amount: 1, targets: 2 }],
    upgrade: { effects: [{ kind: 'poisonChoices', amount: 1, targets: 3 }] },
  }),
  concentrate: card({
    id: 'concentrate', name: 'Concentrate', owner: 'silent', type: 'skill', rarity: 'uncommon', cost: 0,
    exhaust: true,
    effects: [{ kind: 'discardAny' }, { kind: 'gainEnergyPerDiscard', bonus: 0 }],
    upgrade: { effects: [{ kind: 'discardAny' }, { kind: 'gainEnergyPerDiscard', bonus: 1 }] },
  }),
  distraction: card({
    id: 'distraction', name: 'Distraction', owner: 'silent', type: 'power', rarity: 'uncommon', cost: 2,
    trigger: { kind: 'onApplyPoison' },
    oncePerTurn: true,
    effects: [{ kind: 'block', amount: 2 }],
    upgrade: { cost: 1 },
  }),
  storm_of_steel: card({
    id: 'storm_of_steel', name: 'Storm of Steel', owner: 'silent', type: 'skill', rarity: 'rare', cost: 1,
    effects: [{ kind: 'discardAny' }, { kind: 'gainShivPerDiscard', bonus: 0 }],
    upgrade: { effects: [{ kind: 'discardAny' }, { kind: 'gainShivPerDiscard', bonus: 1 }] },
  }),
  unload: card({
    id: 'unload', name: 'Unload', owner: 'silent', type: 'attack', rarity: 'rare', cost: 1,
    effects: [{ kind: 'hit', amount: 2 }, { kind: 'useAllShivs', bonus: 1 }],
    upgrade: { effects: [{ kind: 'hit', amount: 2 }, { kind: 'useAllShivs', bonus: 2 }] },
  }),
}

/** Scan-read cards whose complete printed effect is not live yet. */
export const DEFERRED_CARDS = [] as const

/** The nine base Curses plus the Ascension 5 setup Curse. */
Object.assign(CARDS, {
  clumsy: card({
    id: 'clumsy', name: 'Clumsy', owner: 'curse', type: 'curse', rarity: 'common',
    cost: 0, effects: [], unplayable: true, ethereal: true,
  }),
  decay: card({
    id: 'decay', name: 'Decay', owner: 'curse', type: 'curse', rarity: 'common',
    cost: 0, effects: [], unplayable: true,
    handEndOfTurn: [{ kind: 'damage', amount: 1 }],
  }),
  doubt: card({
    id: 'doubt', name: 'Doubt', owner: 'curse', type: 'curse', rarity: 'common',
    cost: 0, effects: [], unplayable: true,
    handEndOfTurn: [{ kind: 'gainWeak', amount: 1 }],
  }),
  injury: card({
    id: 'injury', name: 'Injury', owner: 'curse', type: 'curse', rarity: 'common',
    cost: 0, effects: [], unplayable: true,
  }),
  pain: card({
    id: 'pain', name: 'Pain', owner: 'curse', type: 'curse', rarity: 'common',
    cost: 0, effects: [], unplayable: true,
    handEndOfTurn: [{ kind: 'loseHp', amount: 1, handSizeAtMost: 2 }],
  }),
  parasite: card({
    id: 'parasite', name: 'Parasite', owner: 'curse', type: 'curse', rarity: 'common',
    cost: 0, effects: [], unplayable: true,
  }),
  regret: card({
    id: 'regret', name: 'Regret', owner: 'curse', type: 'curse', rarity: 'common',
    cost: 0, effects: [], unplayable: true, retain: true,
  }),
  shame: card({
    id: 'shame', name: 'Shame', owner: 'curse', type: 'curse', rarity: 'common',
    cost: 0, effects: [], unplayable: true,
    handEndOfTurn: [{ kind: 'loseBlock', amount: 1 }],
  }),
  writhe: card({
    id: 'writhe', name: 'Writhe', owner: 'curse', type: 'curse', rarity: 'common',
    cost: 1, effects: [], exhaust: true,
  }),
  ascenders_bane: card({
    id: 'ascenders_bane', name: "Ascender's Bane", owner: 'curse', type: 'curse', rarity: 'common',
    cost: 0, effects: [], unplayable: true, ethereal: true,
  }),
})

/**
 * Daze and the Status cards enemies inflict. They live in their own shared
 * decks and leave your deck at the end of every combat (p.24).
 */
CARDS.daze = {
  id: 'daze',
  name: 'Daze',
  owner: 'status',
  type: 'status',
  rarity: 'special',
  cost: 0,
  unplayable: true,
  ethereal: true,
  effects: [],
}

export function cardDef(id: string): CardDef {
  const def = CARDS[id]
  if (!def) throw new Error(`unknown card id: ${id}`)
  return def
}

const repeat = (id: string, times: number): string[] => Array.from({ length: times }, () => id)

/** Starter deck contents by character, as card ids with repeats (p.5-6). */
export const STARTER_DECKS: Record<CharacterId, string[]> = {
  ironclad: [...repeat('strike_ironclad', 5), ...repeat('defend_ironclad', 4), 'bash'],
  silent: [...repeat('strike_silent', 5), ...repeat('defend_silent', 5), 'neutralize', 'survivor'],
  defect: [...repeat('strike_defect', 4), ...repeat('defend_defect', 4), 'zap', 'dual_cast'],
  watcher: [...repeat('strike_watcher', 4), ...repeat('defend_watcher', 4), 'eruption', 'vigilance'],
}
