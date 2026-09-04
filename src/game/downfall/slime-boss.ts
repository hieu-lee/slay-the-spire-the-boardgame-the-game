// Slime Boss — official Downfall public-playtest v1.47 transcription.
//
// This is deliberately board-game data, not a port of the PC mod.  The exact
// prototype wording is kept on each face so balance/audit tooling can compare
// this module with the public TTS sheets without reverse-engineering effects.
import { registerCardDefinitions, STARTER_DECKS } from '../cards.ts'
import type { Amount, CardDef, Effect, TargetScope } from '../cards.ts'
import type { CardInstance, Player, Rarity, SlimeInstance } from '../types.ts'

export const SLIME_BOSS_MAX_HP = 9
export const SLIME_BOSS_PUBLIC_VERSION = '1.47'
export const SLIME_BOSS_GOLDEN_TICKET = {
  name: 'Golden Ticket',
  deck: 'rewards',
  type: 'ticket',
  multiplicity: 2,
  sheetIndices: [53, 54],
  printedText: 'Golden Ticket can’t be added to your deck. When you reveal Golden Ticket, reveal a card from your rare deck.',
} as const

type SlimeBossCard = CardDef & {
  deck: 'starter' | 'rewards' | 'rare'
  sheetIndex: number
  upgradedSheetIndex?: number
}

const id = (name: string) => `slime_boss_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`
const hit = (amount: Amount, times?: Amount): Effect => ({ kind: 'hit', amount, ...(times ? { times } : {}) })
const block = (amount: number): Effect => ({ kind: 'block', amount })
export type SlimeBossEffect =
  | { kind: 'growSlime'; amount: number; upToDifferent?: number; commandAfter?: boolean }
  | { kind: 'commandSlime'; amount: Amount; upToDifferent?: number; all?: boolean; same?: boolean }
  | { kind: 'gainSlimeVigor'; amount: number; temporary?: boolean; commandAfter?: boolean }
  | { kind: 'discountPartyAttack' }
  | { kind: 'discountNextPowerOrSlime'; amount: number | 'free' }
  | { kind: 'tapSlime' }
  | { kind: 'rainOfGoop'; bonus: number }
  | { kind: 'blockIfRetain'; amount: number }
  | { kind: 'vulnerableIfTackle'; amount: number }
  | { kind: 'gainEnergyIfExhaustCost'; minimum: number; amount: number }
  | { kind: 'growIfExhaustCost'; minimum: number }
  | { kind: 'overexert' }
  | { kind: 'replicateSlime'; grow: boolean }
const slimeEffect = (effect: SlimeBossEffect): Effect => effect as unknown as Effect
const grow = (amount: number, options: Omit<Extract<SlimeBossEffect, { kind: 'growSlime' }>, 'kind' | 'amount'> = {}) =>
  slimeEffect({ kind: 'growSlime', amount, ...options })
const command = (amount: Amount, options: Omit<Extract<SlimeBossEffect, { kind: 'commandSlime' }>, 'kind' | 'amount'> = {}) =>
  slimeEffect({ kind: 'commandSlime', amount, ...options })
const vigor = (amount: number, options: Omit<Extract<SlimeBossEffect, { kind: 'gainSlimeVigor' }>, 'kind' | 'amount'> = {}) =>
  slimeEffect({ kind: 'gainSlimeVigor', amount, ...options })
const levels = (...rows: Effect[][]): Readonly<Record<number, readonly Effect[]>> =>
  Object.fromEntries(rows.map((effects, index) => [index + 1, effects]))

function card(
  name: string,
  deck: SlimeBossCard['deck'],
  sheetIndex: number,
  type: CardDef['type'],
  rarity: Rarity,
  multiplicity: number,
  cost: number | 'X',
  printedText: string | null,
  effects: Effect[],
  extra: Partial<SlimeBossCard> = {},
): SlimeBossCard {
  return {
    id: id(name), name, owner: 'slime_boss', deck, sheetIndex,
    upgradedSheetIndex: type === 'slime' && deck === 'starter' ? undefined : sheetIndex,
    type,
    ...(type === 'slime' ? { cardKind: 'slime' as const, resolvesOnPlay: true } : {}),
    rarity, multiplicity, cost, printedText, effects, ...extra,
  }
}

const C: SlimeBossCard[] = [
  card('Slime Slap', 'starter', 0, 'attack', 'starter', 1, 2,
    'Deal 2 damage. Grow a Slime.', [hit(2), grow(1)], {
      upgrade: { printedText: 'Deal 4 damage. Grow a Slime.', effects: [hit(4), grow(1)] },
    }),
  card('Lick', 'starter', 1, 'skill', 'starter', 1, 1, 'Command.', [command(1)], {
    upgrade: { printedText: 'Command up to 2 different Slimes.', effects: [command(1, { upToDifferent: 2 })] },
  }),
  card('Defend', 'starter', 2, 'skill', 'starter', 4, 1, 'Gain 1 Block.', [block(1)], {
    upgrade: { printedText: 'Gain 2 Block for any player.', effects: [{ kind: 'block', amount: 2, toChosen: true }], supportTarget: 'anyPlayer' },
  }),
  card('Strike', 'starter', 6, 'attack', 'starter', 4, 1, 'Deal 1 damage.', [hit(1)], {
    upgrade: { printedText: 'Deal 2 damage.', effects: [hit(2)] },
  }),
  card('Bruiser Slime', 'starter', 10, 'slime', 'starter', 1, 0,
    'End of turn: Command this Slime.', [], {
      printedCost: null, upgradedSheetIndex: undefined, slimeEndOfTurn: true, slimeLevels: levels([hit(1)], [hit(2)]),
    }),

  card('Massive Slime', 'rewards', 0, 'slime', 'uncommon', 1, 3,
    'When played, deal 4 damage and gain 2 Block.', [hit(4), block(2)], {
      slimeLevels: levels([hit(1), block(1)], [hit(2), block(1)], [hit(2), block(2)]),
      upgrade: { printedText: 'When played, deal 4 damage and gain 2 Block.', effects: [hit(4), block(2)], slimeLevels: levels([hit(2), block(1)], [hit(3), block(1)], [hit(3), block(2)]) },
    }),
  card('Leeching Slime', 'rewards', 1, 'slime', 'uncommon', 1, 0,
    'Whenever you Grow a Slime, Command this Slime.', [], {
      slimeTrigger: 'onGrow', slimeLevels: levels([hit(1)], [hit(2)], [hit(3)]),
      upgrade: { printedText: 'Whenever you Grow a Slime, Command this Slime.', slimeLevels: levels([hit(1)], [hit(3)], [hit(5)]) },
    }),
  card('Scrappy Slime', 'rewards', 2, 'slime', 'common', 2, 1,
    'When played, deal 2 damage.', [hit(2)], {
      slimeLevels: levels([hit(2)], [hit(3)], [hit(4)]),
      upgrade: { printedText: 'When played, deal 2 damage.', effects: [hit(2)], slimeLevels: levels([hit(3)], [hit(4)], [hit(5)]) },
    }),
  card('Spike Slime', 'rewards', 4, 'slime', 'uncommon', 1, 1,
    'End of turn: Command this Slime.', [], {
      slimeEndOfTurn: true, slimeTarget: 'allEnemies', slimeLevels: levels([hit(1)], [hit(1)], [hit(2)]),
      upgrade: { printedText: 'End of turn: Command this Slime.', slimeLevels: levels([hit(1)], [hit(2)], [hit(3)]) },
    }),
  card('Spreading Slime', 'rewards', 5, 'slime', 'uncommon', 1, 1,
    'Whenever you spend at least 2 Energy on a card, Command this Slime.', [], {
      slimeTrigger: 'onSpendTwoEnergy', slimeLevels: levels([hit(2)], [hit(3)], [hit(4)]),
      upgrade: { printedText: 'Whenever you spend at least 2 Energy on a card, Command this Slime.', slimeLevels: levels([hit(3)], [hit(4)], [hit(5)]) },
    }),
  card('Sticky Slime', 'rewards', 6, 'slime', 'uncommon', 1, 1,
    'Retain. When played, apply Weak to ALL enemies.', [{ kind: 'applyWeak', amount: 1 }], {
      retain: true, target: 'allEnemies', slimeLevels: levels([hit(2)], [hit(3)], [hit(3), { kind: 'applyWeak', amount: 1 }]),
      upgrade: { printedText: 'Retain. When played, apply Weak to ALL enemies.', slimeLevels: levels([hit(3)], [hit(4)], [hit(4), { kind: 'applyWeak', amount: 1 }]) },
    }),
  card('Taunting Slime', 'rewards', 7, 'slime', 'common', 2, 2,
    'When played, gain 3 Block for any player.', [{ kind: 'block', amount: 3, toChosen: true }], {
      supportTarget: 'anyPlayer', slimeLevels: levels([block(1)], [block(2)], [block(3)]),
      upgrade: { printedText: 'When played, gain 4 Block for any player.', effects: [{ kind: 'block', amount: 4, toChosen: true }] },
    }),
  card('Psychic Slime', 'rewards', 9, 'slime', 'uncommon', 1, 1,
    'When played, draw 2 cards.', [{ kind: 'draw', amount: 2 }], {
      slimeLevels: levels([{ kind: 'draw', amount: 2 }], [{ kind: 'draw', amount: 3 }], [{ kind: 'draw', amount: 4 }]),
      upgrade: { printedText: 'When played, draw 3 cards.', effects: [{ kind: 'draw', amount: 3 }] },
    }),
  card('Muscle Slime', 'rewards', 10, 'slime', 'uncommon', 1, 2,
    'Once per turn: When this Slime gains Strength, Command it.', [], {
      slimeTrigger: 'onGainVigor', slimeLevels: levels([hit(2)], [hit(4)], [hit(6)]),
      upgrade: { printedText: 'Once per turn: When this Slime gains Strength, Command it.', slimeLevels: levels([hit(1, 2)], [hit(2, 2)], [hit(3, 2)]) },
    }),

  card('Combo Tackle', 'rewards', 11, 'attack', 'uncommon', 1, 2,
    'Deal 2 damage. Command up to 2 different Slimes.', [hit(2), command(1, { upToDifferent: 2 })], {
      upgrade: { printedText: 'Deal 3 damage. Command up to 3 different Slimes.', effects: [hit(3), command(1, { upToDifferent: 3 })] },
    }),
  card('Opening Tackle', 'rewards', 12, 'attack', 'common', 2, 1, 'Deal 1 damage. Command.', [hit(1), command(1)], {
    upgrade: { printedText: 'Deal 2 damage. Command.', effects: [hit(2), command(1)] },
  }),
  card('Forward Tackle', 'rewards', 14, 'attack', 'common', 2, 2, 'Retain. Deal 3 damage. Gain 1 Block.', [hit(3), block(1)], {
    retain: true, upgrade: { printedText: 'Retain. Deal 4 damage. Gain 2 Block.', effects: [hit(4), block(2)] },
  }),
  card('Flame Tackle', 'rewards', 16, 'attack', 'common', 2, 2, 'Deal 2 damage to ALL enemies. Command.', [hit(2), command(1)], {
    target: 'allEnemies', upgrade: { printedText: 'Deal 3 damage to ALL enemies. Command.', effects: [hit(3), command(1)] },
  }),
  card('Hungry Tackle', 'rewards', 18, 'attack', 'uncommon', 1, 1,
    'Deal 2 damage. Exhaust a card in your hand. If it costs 2 or more, gain 2 Energy.', [hit(2), { kind: 'exhaustFromHand', amount: 1 }, slimeEffect({ kind: 'gainEnergyIfExhaustCost', minimum: 2, amount: 2 })], {
      upgrade: { printedText: 'Deal 3 damage. Exhaust a card in your hand. If it costs 2 or more, gain 3 Energy.', effects: [hit(3), { kind: 'exhaustFromHand', amount: 1 }, slimeEffect({ kind: 'gainEnergyIfExhaustCost', minimum: 2, amount: 3 })] },
    }),
  card('Ravenous Tackle', 'rewards', 19, 'attack', 'uncommon', 1, 3, 'Deal 5 damage. Grow a Slime twice.', [hit(5), grow(2)], {
    upgrade: { printedText: 'Deal 7 damage. Grow a Slime twice.', effects: [hit(7), grow(2)] },
  }),
  card('Relentless Tackle', 'rewards', 20, 'attack', 'uncommon', 1, 2,
    'Deal 2 damage. The next Attack played by any player this turn costs 0.', [hit(2), slimeEffect({ kind: 'discountPartyAttack' })], {
      upgrade: { printedText: 'Deal 3 damage. The next Attack played by any player this turn costs 0.', effects: [hit(3), slimeEffect({ kind: 'discountPartyAttack' })] },
    }),
  card('Spear Tackle', 'rewards', 21, 'attack', 'uncommon', 1, 2, 'Deal 2 damage twice.', [hit(2, 2)], {
    upgrade: { printedText: 'Deal 3 damage twice.', effects: [hit(3, 2)] },
  }),
  card('Growth', 'rewards', 22, 'skill', 'common', 2, 1, 'Gain 2 Block. Grow a Slime.', [block(2), grow(1)], {
    upgrade: { printedText: 'Gain 3 Block. Grow a Slime.', effects: [block(3), grow(1)] },
  }),
  card('Reformation', 'rewards', 24, 'skill', 'common', 2, 1, 'Grow a Slime. Exhaust.', [grow(1)], {
    exhaust: true, upgrade: { printedText: 'Grow a Slime.', exhaust: false },
  }),
  card('Nibble and Lick', 'rewards', 26, 'skill', 'common', 2, 2, 'Grow a Slime, then Command it.', [grow(1, { commandAfter: true })], {
    upgrade: { printedText: 'Retain. Grow a Slime, then Command it.', retain: true },
  }),
  card('Recollect', 'rewards', 28, 'skill', 'common', 2, 1, 'Retain. Draw 2 cards.', [{ kind: 'draw', amount: 2 }], {
    retain: true, upgrade: { printedText: 'Retain. Draw 3 cards.', effects: [{ kind: 'draw', amount: 3 }] },
  }),
  card('Pile On!', 'rewards', 30, 'attack', 'uncommon', 1, 1, 'Deal 1 damage for each Slime you have in play.', [hit({ base: 0, perSlime: 1 })], {
    upgrade: { printedText: 'Deal 2 damage for each Slime you have in play.', effects: [{ kind: 'hit', amount: { base: 0, perSlime: 2 } }] },
  }),
  card('Just Desserts', 'rewards', 31, 'skill', 'uncommon', 1, 0, 'Retain. The next Power or Slime you play this turn costs 1 less.', [slimeEffect({ kind: 'discountNextPowerOrSlime', amount: 1 })], {
    retain: true, upgrade: { printedText: 'Retain. The next Power or Slime you play this turn costs 0.', effects: [slimeEffect({ kind: 'discountNextPowerOrSlime', amount: 'free' })] },
  }),
  card('Repurpose', 'rewards', 32, 'skill', 'uncommon', 1, 0, 'Retain. Gain 1 Energy. Exhaust.', [{ kind: 'gainEnergy', amount: 1 }], {
    retain: true, exhaust: true, upgrade: { printedText: 'Retain. Gain 2 Energy. Exhaust.', effects: [{ kind: 'gainEnergy', amount: 2 }] },
  }),
  card('Leech Energy', 'rewards', 33, 'attack', 'common', 2, 0, 'Deal 1 damage. Gain 1 Block if you have a card with Retain in your hand.', [hit(1), slimeEffect({ kind: 'blockIfRetain', amount: 1 })], {
    upgrade: { printedText: 'Deal 2 damage. Gain 1 Block if you have a card with Retain in your hand.', effects: [hit(2), slimeEffect({ kind: 'blockIfRetain', amount: 1 })] },
  }),
  card('Goop Spray', 'rewards', 35, 'skill', 'uncommon', 1, 1, 'Apply 1 Weak. Draw 1 card.', [{ kind: 'applyWeak', amount: 1 }, { kind: 'draw', amount: 1 }], {
    upgrade: { printedText: 'Apply 1 Weak. Draw 2 cards.', effects: [{ kind: 'applyWeak', amount: 1 }, { kind: 'draw', amount: 2 }] },
  }),
  card('Recklessness', 'rewards', 36, 'power', 'uncommon', 1, 1, 'Your ‘Tackles’ deal +2 damage on each damage icon.', [], {
    persistent: true, upgrade: { printedText: 'Your ‘Tackles’ deal +3 damage on each damage icon.' },
  }),
  card('Slippery', 'rewards', 37, 'skill', 'common', 2, 2, 'Gain 2 Block. Costs 0 if you spent at least 2 Energy on another card this turn.', [block(2)], {
    costAfterSpentTwoEnergy: 0, upgrade: { printedText: 'Gain 3 Block. Costs 0 if you spent at least 2 Energy on another card this turn.', effects: [block(3)] },
  }),
  card('Protect the Boss', 'rewards', 39, 'skill', 'common', 2, 1, 'Retain. Gain 2 Block.', [block(2)], {
    retain: true, upgrade: { printedText: 'Retain. Gain 3 Block.', effects: [block(3)] },
  }),
  card('Quick Snack', 'rewards', 41, 'skill', 'uncommon', 1, 1, 'Gain X+1 Block. X is the highest level among Slimes you have in play.', [{ kind: 'block', amount: { base: 1, plusHighestSlimeLevel: true } }], {
    upgrade: { printedText: 'Gain X+2 Block. X is the highest level among Slimes you have in play.', effects: [{ kind: 'block', amount: { base: 2, plusHighestSlimeLevel: true } }] },
  }),
  card('It Looks Tasty', 'rewards', 42, 'skill', 'uncommon', 1, 1, 'Gain 1 Block. Exhaust a card in your hand. If it costs 2 or more, Grow a Slime.', [block(1), { kind: 'exhaustFromHand', amount: 1 }], {
    effects: [block(1), { kind: 'exhaustFromHand', amount: 1 }, slimeEffect({ kind: 'growIfExhaustCost', minimum: 2 })],
    upgrade: { printedText: 'Gain 2 Block. Exhaust a card in your hand. If it costs 2 or more, Grow a Slime.', effects: [block(2), { kind: 'exhaustFromHand', amount: 1 }, slimeEffect({ kind: 'growIfExhaustCost', minimum: 2 })] },
  }),
  card('Divide & Conquer', 'rewards', 43, 'skill', 'uncommon', 1, 'X', 'Command X different Slimes.', [command({ base: 0, per: 'energySpent' }, { upToDifferent: 99 })], {
    upgrade: { minimumX: 1, printedText: 'Command X+1 different Slimes. X can’t be 0.', effects: [command({ base: 1, per: 'energySpent' }, { upToDifferent: 99 })] },
  }),
  card('Digest', 'rewards', 44, 'skill', 'uncommon', 1, 3, 'Give a Slime 1 Strength. Costs 1 less for each card with Retain in your hand. Exhaust.', [vigor(1)], {
    retainCostReduction: true, exhaust: true, upgrade: { printedText: 'Give a Slime 1 Strength. Costs 1 less for each card with Retain in your hand.', exhaust: false },
  }),
  card('Living Wall', 'rewards', 45, 'skill', 'uncommon', 1, 2, 'Gain 2 Block, +1 Block per Slime you have in play.', [{ kind: 'block', amount: { base: 2, perSlime: 1 } }], {
    upgrade: { printedText: 'Gain 3 Block, +1 Block per Slime you have in play.', effects: [{ kind: 'block', amount: { base: 3, perSlime: 1 } }] },
  }),
  card('Prepare Crush', 'rewards', 46, 'power', 'uncommon', 1, 3, 'Retain. Start of turn: Deal 15 damage, then discard this card.', [{ kind: 'hit', amount: 15 }], {
    retain: true, trigger: { kind: 'startOfTurn' }, upgrade: { printedText: 'Retain. Start of turn: Deal 20 damage, then discard this card.', effects: [hit(20)] },
  }),
  card('Spit', 'rewards', 47, 'skill', 'common', 2, 1, 'Draw 1 card. Command.', [{ kind: 'draw', amount: 1 }, command(1)], {
    upgrade: { printedText: 'Draw 2 cards. Command.', effects: [{ kind: 'draw', amount: 2 }, command(1)] },
  }),
  card('Haunting Lick', 'rewards', 49, 'skill', 'uncommon', 1, 1, 'Retain. Command.', [command(1)], {
    retain: true, upgrade: { printedText: 'Retain. Command up to 2 different Slimes.', effects: [command(1, { upToDifferent: 2 })] },
  }),
  card('Glop Chop', 'rewards', 50, 'attack', 'uncommon', 1, 1, 'Deal 2 damage. Apply 1 Vulnerable if you have a ‘Tackle’ in your hand.', [hit(2), slimeEffect({ kind: 'vulnerableIfTackle', amount: 1 })], {
    upgrade: { cost: 0, printedText: 'Deal 2 damage. Apply 1 Vulnerable if you have a ‘Tackle’ in your hand.' },
  }),
  card('Smothering Tackle', 'rewards', 51, 'attack', 'uncommon', 1, 2, 'Retain. Deal 2 damage. Apply 1 Vulnerable.', [hit(2), { kind: 'applyVulnerable', amount: 1 }], {
    retain: true, upgrade: { printedText: 'Retain. Deal 4 damage. Apply 1 Vulnerable.', effects: [hit(4), { kind: 'applyVulnerable', amount: 1 }] },
  }),
  card('Dive Tackle', 'rewards', 52, 'attack', 'uncommon', 1, 1, 'Deal 4 damage. Exhaust.', [hit(4)], {
    exhaust: true, upgrade: { printedText: 'Deal 6 damage. Exhaust.', effects: [hit(6)] },
  }),
  card('Gluttony', 'rewards', 55, 'skill', 'uncommon', 1, 2, 'Give a Slime 1 Strength.', [vigor(1)], {
    upgrade: { printedText: 'Retain. Give a Slime 1 Strength.', retain: true },
  }),
  card('Tongue Lash', 'rewards', 56, 'attack', 'uncommon', 1, 1, 'Deal 1 damage. Give a Slime 1 Strength. Exhaust.', [hit(1), vigor(1)], {
    exhaust: true, upgrade: { printedText: 'Deal 3 damage. Give a Slime 1 Strength. Exhaust.', effects: [hit(3), vigor(1)] },
  }),
  card('Slime Brawl', 'rewards', 57, 'skill', 'uncommon', 1, 1, 'Give 1 Strength to a Slime, then Command it. Remove that 1 Strength at end of turn.', [vigor(1, { temporary: true, commandAfter: true })], {
    upgrade: { printedText: 'Give 2 Strength to a Slime, then Command it. Remove that 2 Strength at end of turn.', effects: [vigor(2, { temporary: true, commandAfter: true })] },
  }),
  card('Ooze Bath', 'rewards', 58, 'skill', 'uncommon', 1, 2, 'Command a single Slime X times. X is the number of cards with Retain in your hand.', [command({ base: 0, per: 'retainCardsInHand' }, { same: true })], {
    upgrade: { cost: 1, printedText: 'Command a single Slime X times. X is the number of cards with Retain in your hand.' },
  }),
  card('Goop Armor', 'rewards', 59, 'power', 'uncommon', 1, 1, 'Whenever you play a ‘Tackle,’ gain 1 Block.', [], {
    persistent: true, upgrade: { printedText: 'Whenever you play a ‘Tackle,’ gain 2 Block.' },
  }),
  card('Delegate', 'rewards', 60, 'skill', 'uncommon', 1, 2, 'Gain 3 Block. Command. Exhaust.', [block(3), command(1)], {
    exhaust: true, upgrade: { printedText: 'Gain 5 Block. Command. Exhaust.', effects: [block(5), command(1)] },
  }),

  card('Royal Slime', 'rare', 0, 'slime', 'rare', 1, 2, 'X is the number of Slimes you have in play.', [], {
    slimeLevels: levels([hit({ base: 0, perSlime: 1 })], [hit({ base: 0, perSlime: 1 }), hit(2)], [{ kind: 'hit', amount: { base: 0, perSlime: 1 }, times: 2 }]),
    upgrade: { cost: 1, printedText: 'X is the number of Slimes you have in play.' },
  }),
  card('Feeding Frenzy', 'rare', 1, 'attack', 'rare', 1, 2, 'Deal 2 damage. Grow up to 3 different Slimes.', [hit(2), grow(1, { upToDifferent: 3 })], {
    upgrade: { printedText: 'Deal 2 damage. Grow up to 5 different Slimes.', effects: [hit(2), grow(1, { upToDifferent: 5 })] },
  }),
  card('Slime Tap', 'rare', 2, 'skill', 'rare', 1, 1, 'Choose a Slime. Draw cards and gain Energy equal to its level. Exhaust.', [slimeEffect({ kind: 'tapSlime' })], {
    exhaust: true, upgrade: { cost: 0, printedText: 'Choose a Slime. Draw cards and gain Energy equal to its level. Exhaust.' },
  }),
  card('Rain of Goop', 'rare', 3, 'power', 'rare', 1, 'X', 'When played, place X Strength on this. Start of turn: Move 1 Strength from this onto you or a Slime card. If this has no Strength, Exhaust.', [slimeEffect({ kind: 'rainOfGoop', bonus: 0 })], {
    trigger: { kind: 'startOfTurn' }, resolvesOnPlay: true,
    upgrade: { printedText: 'When played, place X+1 Strength on this. Start of turn: Move 1 Strength from this onto you or a Slime card. If this has no Strength, Exhaust.', effects: [slimeEffect({ kind: 'rainOfGoop', bonus: 1 })] },
  }),
  card('Consult Playbook', 'rare', 4, 'power', 'rare', 1, 1, 'Once per turn: When you play a ‘Tackle,’ draw 1 card and gain 1 Energy.', [], {
    persistent: true, oncePerTurn: true, upgrade: { printedText: 'Once per turn: When you play a ‘Tackle,’ draw 2 cards and gain 1 Energy.' },
  }),
  card('Duplicated Form', 'rare', 5, 'power', 'rare', 1, 3, 'Once per turn: The next Attack you play this turn is played twice.', [{ kind: 'doubleNextAttack' }], {
    activeAbility: true, oncePerTurn: true, upgrade: { cost: 2, printedText: 'Once per turn: The next Attack you play this turn is played twice.' },
  }),
  card('Minion Master', 'rare', 6, 'power', 'rare', 1, 2, 'Start of turn: Command a Slime.', [command(1)], {
    trigger: { kind: 'startOfTurn' }, upgrade: { cost: 1, printedText: 'Start of turn: Command a Slime.' },
  }),
  card('Overexert', 'rare', 7, 'skill', 'rare', 1, 1, 'Draw 2 cards, then play a card in your hand for 0 Energy. If it’s an Attack, it’s played twice. Exhaust.', [{ kind: 'draw', amount: 2 }, slimeEffect({ kind: 'overexert' })], {
    exhaust: true, upgrade: { printedText: 'Draw 3 cards, then play a card in your hand for 0 Energy. If it’s an Attack, it’s played twice. Exhaust.', effects: [{ kind: 'draw', amount: 3 }, slimeEffect({ kind: 'overexert' })] },
  }),
  card('Replication', 'rare', 8, 'skill', 'rare', 1, 1, 'Search your draw pile for a Slime, then play it for 0 Energy. Shuffle your draw pile. Exhaust.', [slimeEffect({ kind: 'replicateSlime', grow: false })], {
    exhaust: true, upgrade: { printedText: 'Search your draw pile for a Slime, play it for 0 Energy, and Grow it. Shuffle your draw pile. Exhaust.', effects: [slimeEffect({ kind: 'replicateSlime', grow: true })] },
  }),
  card('Darkling Duo', 'rare', 9, 'power', 'rare', 1, 1, 'Whenever you play a card with Retain, Command your Bruiser Slime.', [], {
    persistent: true, upgrade: { cost: 0, printedText: 'Whenever you play a card with Retain, Command your Bruiser Slime.' },
  }),
  card('Shape of Puddle', 'rare', 10, 'power', 'rare', 1, 3, 'Any time: Add a cube to gain 2 Block, then Exhaust if there are 3 cubes.', [block(2), { kind: 'countdownExhaust', cubes: 3 }], {
    activeAbility: true, upgrade: { printedText: 'Any time: Add a cube to gain 2 Block, then Exhaust if there are 4 cubes.', effects: [block(2), { kind: 'countdownExhaust', cubes: 4 }] },
  }),
  card('Rally the Troops', 'rare', 11, 'skill', 'rare', 1, 2, 'Command ALL Slimes.', [command(1, { all: true })], {
    upgrade: { printedText: 'Retain. Command ALL Slimes.', retain: true },
  }),
  card('Vicious Tackle', 'rare', 12, 'attack', 'rare', 1, 4, 'Deal 8 damage. Costs 1 less for each other ‘Tackle’ in your hand.', [hit(8)], {
    tackleCostReduction: true, upgrade: { printedText: 'Deal 12 damage. Costs 1 less for each other ‘Tackle’ in your hand.', effects: [hit(12)] },
  }),
  card('Level Up', 'rare', 13, 'power', 'rare', 1, 2, 'Start of turn: Grow a Slime.', [grow(1)], {
    trigger: { kind: 'startOfTurn' }, upgrade: { cost: 1, printedText: 'Start of turn: Grow a Slime.' },
  }),
  card('Evolution Slime', 'rare', 14, 'slime', 'rare', 1, 1, null, [], {
    slimeLevels: levels([hit(2)], [hit(4)], [hit(4)], [hit(4), block(2)], [hit(6), block(2)], [hit(6), block(2), vigor(1)]),
    upgrade: { cost: 0, printedText: null },
  }),
  card('Armored Slime', 'rare', 15, 'slime', 'rare', 1, 1, 'You may only Command this Slime once per turn.', [], {
    slimeCommandLimit: 1, slimeLevels: levels([block(3)], [block(3), { kind: 'applyVulnerable', amount: 1 }], [block(5), { kind: 'applyVulnerable', amount: 1 }]),
    upgrade: { printedText: 'You may only Command this Slime once per turn.', slimeLevels: levels([block(4)], [block(4), { kind: 'applyVulnerable', amount: 1 }], [block(6), { kind: 'applyVulnerable', amount: 1 }]) },
  }),
]

export const SLIME_BOSS_CARDS: Readonly<Record<string, CardDef>> = Object.fromEntries(C.map((definition) => [definition.id, definition]))
registerCardDefinitions(SLIME_BOSS_CARDS)

const copies = (deck: SlimeBossCard['deck'], rarity?: Rarity) => C.flatMap((definition) =>
  definition.deck === deck && (rarity === undefined || definition.rarity === rarity)
    ? Array.from({ length: definition.multiplicity ?? 1 }, () => definition.id)
    : [])

/** Bruiser is setup in play, so it is intentionally absent from the ten-card draw deck. */
export const SLIME_BOSS_STARTER_DECK = copies('starter').filter((cardId) => cardId !== id('Bruiser Slime'))
export const SLIME_BOSS_REWARD_DECK = copies('rewards')
export const SLIME_BOSS_RARE_DECK = copies('rare')
STARTER_DECKS.slime_boss = [...SLIME_BOSS_STARTER_DECK]

export function makeSlimeBossStarterDeck(makeUid: (defId: string) => string): CardInstance[] {
  return SLIME_BOSS_STARTER_DECK.map((defId) => ({ uid: makeUid(defId), defId, upgraded: false }))
}

export function bruiserSlime(uid = 'slime:bruiser'): SlimeInstance {
  return { card: { uid, defId: id('Bruiser Slime'), upgraded: false }, level: 1, vigor: 0, commandsThisTurn: 0, vigorLossAtEndOfTurn: 0, vigorTriggerUsedThisTurn: false }
}

/** Marks an existing Player as Slime Boss data without widening the base-game CharacterId. */
export function setupSlimeBossPlayer(player: Player, makeUid: (defId: string) => string): Player {
  const deck = makeSlimeBossStarterDeck(makeUid)
  return { ...player, hp: SLIME_BOSS_MAX_HP, maxHp: SLIME_BOSS_MAX_HP, deck, draw: [...deck], hand: [], discard: [], exhaust: [], powers: [], slimes: [bruiserSlime()] }
}

export function slimeDef(slime: SlimeInstance): CardDef {
  const def = SLIME_BOSS_CARDS[slime.card.defId]
  if (!def || def.cardKind !== 'slime') throw new Error(`unknown Slime card ${slime.card.defId}`)
  return slime.card.upgraded && def.upgrade ? { ...def, ...def.upgrade, name: `${def.name}+` } : def
}

export function growSlime(slime: SlimeInstance, amount = 1): number {
  const max = Math.max(1, ...Object.keys(slimeDef(slime).slimeLevels ?? {}).map(Number))
  const before = slime.level
  slime.level = Math.min(max, slime.level + amount)
  return slime.level - before
}

export function gainSlimeVigor(slime: SlimeInstance, amount: number, temporary = false): number {
  const gained = Math.max(0, Math.min(8 - slime.vigor, amount))
  slime.vigor += gained
  if (temporary) slime.vigorLossAtEndOfTurn += gained
  return gained
}

export type SlimeCommand = { slime: SlimeInstance; effects: readonly Effect[]; scope: TargetScope }

export function previewSlimeCommand(slime: SlimeInstance): SlimeCommand | null {
  const def = slimeDef(slime)
  if (def.slimeCommandLimit !== undefined && slime.commandsThisTurn >= def.slimeCommandLimit) return null
  const row = def.slimeLevels?.[slime.level]
  if (!row) return null
  const effects = row.map((effect): Effect => {
    if (effect.kind !== 'hit' || slime.vigor === 0) return effect
    const amount = typeof effect.amount === 'number'
      ? effect.amount + slime.vigor
      : { ...effect.amount, base: effect.amount.base + slime.vigor }
    return { ...effect, amount }
  })
  const scope = def.id === id('Evolution Slime') && slime.level >= 3
    ? 'allEnemies'
    : (def.slimeTarget ?? 'enemy')
  return { slime, effects, scope }
}

/** Returns one serialized Command and consumes Armored Slime's once-per-turn allowance. */
export function commandSlime(slime: SlimeInstance): SlimeCommand | null {
  const command = previewSlimeCommand(slime)
  if (command) slime.commandsThisTurn += 1
  return command
}

export function clearSlimeTurn(slime: SlimeInstance): number {
  slime.commandsThisTurn = 0
  slime.vigorTriggerUsedThisTurn = false
  return 0
}

export function removeTemporarySlimeVigor(slime: SlimeInstance): number {
  const loss = Math.min(slime.vigor, slime.vigorLossAtEndOfTurn)
  slime.vigor -= loss
  slime.vigorLossAtEndOfTurn = 0
  return loss
}

export const SLIME_BOSS_CARD_COUNT = C.length
export const SLIME_BOSS_PHYSICAL_DECK_COUNT = C.reduce((sum, definition) => sum + (definition.multiplicity ?? 1), 0) + 2
