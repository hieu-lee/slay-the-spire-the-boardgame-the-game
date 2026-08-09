// Card definitions are data, not code. A card's printed text is a sequence of
// icons — Bash is literally "2⚔ 💔" — so an effect list is a transcription of
// the card rather than an interpretation of it. One resolver reads them all.
import type { CardType, CharacterId, OrbType, Rarity, Stance } from './types.ts'
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

/** Something on the board a card can count. Barrage deals one hit per Orb. */
export type CountOf = 'orbs' | 'orbTypes' | 'block' | 'strength'

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
    }

/**
 * A clause that only happens when the board says so, as the Weak on Go for the
 * Eyes does: the base face prints it against the die rows 4-5-6 only.
 */
type Conditional = { when?: Condition }

export type Effect = EffectKind & Conditional

type EffectKind =
  /** A hit: modified by Strength, Weak and Vulnerable. `times` is a multi-hit. */
  | { kind: 'hit'; amount: Amount; times?: Amount }
  /** Plain damage: blockable, but NOT modified by Strength/Weak/Vulnerable. */
  | { kind: 'damage'; amount: number }
  /** Ignores Block entirely. */
  | { kind: 'loseHp'; amount: number }
  | ({ kind: 'block'; amount: Amount } & Redirectable)
  | { kind: 'applyVulnerable'; amount: number }
  | { kind: 'applyWeak'; amount: number }
  | ({ kind: 'gainStrength'; amount: number } & Redirectable)
  | { kind: 'poison'; amount: number }
  | ({ kind: 'draw'; amount: Amount } & Redirectable)
  | ({ kind: 'gainEnergy'; amount: number } & Redirectable)
  | ({ kind: 'gainShiv'; amount: number } & Redirectable)
  | ({ kind: 'gainMiracle'; amount: number } & Redirectable)
  | { kind: 'enterStance'; stance: Stance }
  | { kind: 'channel'; orb: OrbType; amount: number }
  | { kind: 'evoke'; times: number }
  | { kind: 'scry'; amount: number }
  | { kind: 'addDaze'; amount: number; pile: 'draw' | 'discard' }
  | { kind: 'recoverDiscardTopCosts'; cost: number }
  | ({ kind: 'heal'; amount: number } & Redirectable)
  /**
   * Discard cards the player chooses. The choice travels with the action rather
   * than parking the game in a prompt state, which keeps a card play a single
   * atomic message for the server to validate.
   */
  | { kind: 'discard'; amount: number }
  /** Exhaust cards the player chooses from hand, as True Grit does. */
  | { kind: 'exhaustFromHand'; amount: number }

export type CardDef = {
  id: string
  name: string
  /** `colorless`, `curse` and `status` are pools rather than characters. */
  owner: CharacterId | 'colorless' | 'curse' | 'status'
  type: CardType
  rarity: Rarity
  /** `'X'` spends any amount of energy; the effects read the amount spent. */
  cost: number | 'X'
  effects: Effect[]
  /** Where this card's offensive effects land. Defaults to a single enemy. */
  target?: TargetScope
  /** Where this card's supportive effects land. Defaults to the player. */
  supportTarget?: TargetScope
  /** The card exhausts itself when played, instead of going to the discard pile. */
  exhaust?: boolean
  /** Kept in hand during the end-of-turn discard step. */
  retain?: boolean
  /** Cannot be played at all; an effect that tries to play it is ignored (p.24). */
  unplayable?: boolean
  /**
   * For Powers: when the ongoing effect fires once the card is in play. The
   * `effects` list is what the Power DOES each time it triggers, not what
   * happens when it is played — a Power with a trigger does nothing on play.
   */
  trigger?: Trigger
  // Ethereal is deliberately absent. A declared-but-unhonoured flag is worse
  // than a missing one: a card carrying it would silently play as normal.
  /** What changes when upgraded. Merged over the base definition. */
  upgrade?: Partial<Omit<CardDef, 'id' | 'upgrade'>>
}

/** The upgraded face of a card, or the card itself when it is not upgraded. */
export function faceOf(def: CardDef, upgraded: boolean): CardDef {
  if (!upgraded || !def.upgrade) return def
  return { ...def, ...def.upgrade, name: `${def.name}+` }
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
}

/**
 * Cards read off the scans that the engine cannot yet express, and what each
 * one is waiting on. Kept as a list rather than as half-working definitions,
 * because a card that silently drops a clause is worse than a missing card: it
 * plays, it looks right, and it is wrong.
 *
 * - An evoke the player is never asked about (Charge Battery). Its clause is
 *   "Gain [frost] if you have 3 or more Orbs", and 3 IS the full board, so the
 *   channel can only ever land by evoking something first. p.16 gives that
 *   choice to the player — "evoke any orb of your choice" — and the local UI
 *   does not collect it, so the engine falls back to the first occupied slot
 *   and the first living enemy. Every other channel card can dodge this by
 *   having a slot free; this one cannot, so it would make an unasked decision
 *   on 100% of its successful plays. The engine side is ready (`evokeSlots` is
 *   plumbed through `PlayContext`); the card comes back with the picker, and
 *   `Condition` gets its `orbsAtLeast` variant back at the same time — a
 *   deferred card leaves no vocabulary behind, or the branch sits unreachable
 *   and untested until somebody trusts it.
 * - Modal faces (Iron Wave+): "2⚔ 1🛡 - or - 1⚔ 2🛡", a choice made on play.
 * - Temporary Strength (Flex): a buff that expires at end of turn.
 * - Deck manipulation (Anger): putting the played card on top of the draw pile.
 * - A choice that can only be made AFTER the same card reveals cards
 *   (Third Eye, Acrobatics). Both need a play to happen in two steps, and a
 *   play is atomic here: one validated message carries every choice, which is
 *   what lets the server check a move without holding half-resolved state
 *   between round trips. Third Eye must show the top of the draw pile before
 *   asking which of it to bin; Acrobatics reads "Draw 3 cards. Discard 1
 *   card." and, played as the last card in hand, can only be paid from the
 *   three it just drew. Shipping either means a card that looks right and
 *   misbehaves — Third Eye becomes Block-and-nothing, and Acrobatics is
 *   refused outright with no explanation. Note the local UI could technically
 *   read ahead, since it holds the whole run in memory; it must not. The draw
 *   pile is face down to everyone including its owner, which is why
 *   `rooms.mjs` redacts it, and a client that peeks would be cheating locally
 *   and broken the moment a real server enforces the same rule. Both come back
 *   with a staging step that reveals first and asks second.
 */
export const DEFERRED_CARDS = [
  'acrobatics',
  'anger',
  'charge_battery',
  'chaos',
  'flex',
  'iron_wave',
  'recursion',
  'third_eye',
] as const

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
