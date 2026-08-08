// Card definitions are data, not code. A card's printed text is a sequence of
// icons — Bash is literally "2⚔ 💔" — so an effect list is a transcription of
// the card rather than an interpretation of it. One resolver reads them all.
import type { CardType, CharacterId, OrbType, Rarity, Stance } from './types.ts'

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

export type Effect =
  /** A hit: modified by Strength, Weak and Vulnerable. `times` is a multi-hit. */
  | { kind: 'hit'; amount: number; times?: number }
  /** Plain damage: blockable, but NOT modified by Strength/Weak/Vulnerable. */
  | { kind: 'damage'; amount: number }
  /** Ignores Block entirely. */
  | { kind: 'loseHp'; amount: number }
  | { kind: 'block'; amount: number }
  | { kind: 'applyVulnerable'; amount: number }
  | { kind: 'applyWeak'; amount: number }
  | { kind: 'gainStrength'; amount: number }
  | { kind: 'poison'; amount: number }
  | { kind: 'draw'; amount: number }
  | { kind: 'gainEnergy'; amount: number }
  | { kind: 'gainShiv'; amount: number }
  | { kind: 'gainMiracle'; amount: number }
  | { kind: 'enterStance'; stance: Stance }
  | { kind: 'channel'; orb: OrbType; amount: number }
  | { kind: 'evoke'; times: number }
  | { kind: 'scry'; amount: number }
  | { kind: 'heal'; amount: number }
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
    upgrade: { effects: [{ kind: 'block', amount: 2 }], supportTarget: 'anyPlayer' },
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
    supportTarget: 'anyPlayer',
    effects: [
      { kind: 'block', amount: 2 },
      { kind: 'enterStance', stance: 'calm' },
    ],
    upgrade: {
      effects: [
        { kind: 'block', amount: 3 },
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
    upgrade: { effects: [{ kind: 'block', amount: 2 }], supportTarget: 'anyPlayer' },
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
    supportTarget: 'anyPlayer',
    effects: [
      { kind: 'block', amount: 1 },
      { kind: 'exhaustFromHand', amount: 1 },
    ],
    upgrade: {
      effects: [
        { kind: 'block', amount: 2 },
        { kind: 'exhaustFromHand', amount: 1 },
      ],
    },
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
}

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
