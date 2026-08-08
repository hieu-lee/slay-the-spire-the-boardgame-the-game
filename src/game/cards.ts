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

export type Effect =
  /** A hit: modified by Strength, Weak and Vulnerable. `times` is a multi-hit. */
  | { kind: 'hit'; amount: number; times?: number }
  /** Plain damage: blockable, but NOT modified by Strength/Weak/Vulnerable. */
  | { kind: 'damage'; amount: number }
  /** Ignores Block entirely. */
  | { kind: 'loseHp'; amount: number }
  | ({ kind: 'block'; amount: number } & Redirectable)
  | { kind: 'applyVulnerable'; amount: number }
  | { kind: 'applyWeak'; amount: number }
  | ({ kind: 'gainStrength'; amount: number } & Redirectable)
  | { kind: 'poison'; amount: number }
  | ({ kind: 'draw'; amount: number } & Redirectable)
  | ({ kind: 'gainEnergy'; amount: number } & Redirectable)
  | ({ kind: 'gainShiv'; amount: number } & Redirectable)
  | ({ kind: 'gainMiracle'; amount: number } & Redirectable)
  | { kind: 'enterStance'; stance: Stance }
  | { kind: 'channel'; orb: OrbType; amount: number }
  | { kind: 'evoke'; times: number }
  | { kind: 'scry'; amount: number }
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
  /** Cannot be played at all; an effect that tries to play it is ignored (p.24). */
  unplayable?: boolean
  /**
   * For Powers: when the ongoing effect fires once the card is in play. The
   * `effects` list is what the Power DOES each time it triggers, not what
   * happens when it is played — a Power with a trigger does nothing on play.
   */
  trigger?: Trigger
  // Ethereal and Retain are deliberately absent. No card here has them yet, and
  // a declared-but-unhonoured flag is worse than a missing one: a card carrying
  // it would silently play as though it were normal.
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
}

/**
 * Cards read off the scans that the engine cannot yet express, and what each
 * one is waiting on. Kept as a list rather than as half-working definitions,
 * because a card that silently drops a clause is worse than a missing card: it
 * plays, it looks right, and it is wrong.
 *
 * - Retain (Crescendo, Tranquility, Protect): a card kept through the discard
 *   step. `CardDef` deliberately has no flag for it yet.
 * - Die-conditional effects (Go for the Eyes, base face): the effect depends
 *   on a roll, which currently only enemies make. Its upgraded face prints no
 *   dice and would be expressible on its own; a card ships only when BOTH
 *   faces do, so that upgrading can never reveal a clause the engine drops.
 * - Conditional bonuses (Slice, Deflect, Bane, Steam Barrier): a bonus gated
 *   on a pile, a token count or a debuff. Mostly "+1 if ...", but Bane prints
 *   +2, so the amount is per-card and not a fixed step.
 * - Counting effects (Barrage, Charge Battery): something computed from board
 *   state — Barrage's damage scales per Orb, and Charge Battery gains an extra
 *   Frost orb only once you already hold three.
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
  'bane',
  'barrage',
  'charge_battery',
  'crescendo',
  'deflect',
  'flex',
  'go_for_the_eyes',
  'iron_wave',
  'protect',
  'slice',
  'steam_barrier',
  'third_eye',
  'tranquility',
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
