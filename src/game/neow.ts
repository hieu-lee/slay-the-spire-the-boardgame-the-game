import { shuffle } from './rng.ts'
import type { RngState } from './rng.ts'
import type { RuleSet } from './meta.ts'
import type { CharacterId } from './types.ts'
import { HEARTS_BOONS } from './downfall/items.ts'

export type NeowRewardKind = 'card' | 'rare' | 'colorless' | 'potion' | 'relic'

export type NeowEffect =
  | { kind: 'upgrade'; count: 1 | 2; random?: boolean; starter?: 'strike' | 'defend' }
  | { kind: 'remove'; count: 1 | 2; starter?: 'strike' | 'defend' }
  | { kind: 'transform'; count: 1 | 2; upgrade?: boolean }
  | { kind: 'gold'; amount: number }
  | { kind: 'loseGold'; amount: number }
  | { kind: 'loseHp'; amount: number }
  | { kind: 'loseMaxHp'; amount: number }
  | { kind: 'reward'; reward: NeowRewardKind; count: 1 | 2 | 3; look?: 3 | 5; upgraded?: boolean }
  | { kind: 'randomRare'; upgraded?: boolean }
  | { kind: 'randomCards'; source: 'card' | 'colorless'; count: 1 | 2; upgraded?: boolean }
  | { kind: 'relic'; choices?: 1 | 3 }
  | { kind: 'potions'; count: 2 | 3 }
  | { kind: 'curse' }

export type NeowImmediateReward = Extract<NeowEffect,
  { kind: 'upgrade' | 'remove' | 'transform' | 'gold' | 'randomRare' | 'randomCards' }>
export type NeowQueuedEffect = NeowRewardKind | NeowEffect

export type NeowOption = { label: string; effects: readonly NeowEffect[] }
export type NeowCard = {
  id: string
  text: string
  unlocked: boolean
  source?: 'heart'
  options: readonly [NeowOption, NeowOption, NeowOption]
}

export type NeowRewardOffer = {
  kind: NeowRewardKind
  choices: string[]
  /** Exact face-up cards, kept so resolution never trusts a client-provided effect. */
  cardsDrawn: string[]
  raresDrawn: string[]
  upgraded?: boolean
  look?: 3 | 5
  prismaticDraws?: Array<{ source: CharacterId | 'colorless'; cardId: string; rareId?: string }>
  /** Face-up Guardian Gems reserved when this offer revealed a Socket card. */
  guardianGems?: string[]
}

export type NeowPlayerState = {
  cardId: string
  redGoldPending: boolean
  redRewardPending: boolean
  /** Heart's Boon gives three independent opening Card Rewards. */
  redRewardsRemaining?: number
  redReward: NeowRewardOffer | null
  blueOption: number | null
  pendingEffect: NeowImmediateReward | null
  rewardKind: NeowRewardKind | null
  rewardRequest?: { look?: 3 | 5; upgraded?: boolean; relicChoices?: 1 | 3 }
  reward: NeowRewardOffer | null
  rewardQueue: NeowQueuedEffect[]
  done: boolean
}

export type NeowState = {
  /** Remaining face-down cards. Transport redacts this field. */
  deck: string[]
  /** Separate physical Heart's Boon deck, absent in legacy/base-only saves. */
  heartDeck?: string[]
  players: Record<string, NeowPlayerState>
}

export type NeowDecision = { cardUids?: string[] }

const option = (label: string, ...effects: NeowEffect[]): NeowOption => ({ label, effects })
const upgrade = (count: 1 | 2, random = false): NeowEffect => ({ kind: 'upgrade', count, random: random || undefined })
const remove = (count: 1 | 2): NeowEffect => ({ kind: 'remove', count })
const transform = (count: 1 | 2): NeowEffect => ({ kind: 'transform', count })
const gold = (amount: 5 | 10): NeowEffect => ({ kind: 'gold', amount })
const loseGold = (): NeowEffect => ({ kind: 'loseGold', amount: 3 })
const loseHp = (amount: 2 | 3): NeowEffect => ({ kind: 'loseHp', amount })
const reward = (kind: NeowRewardKind, count: 1 | 2 = 1): NeowEffect => ({ kind: 'reward', reward: kind, count })
const randomRare = (): NeowEffect => ({ kind: 'randomRare' })
const relic = (): NeowEffect => ({ kind: 'relic' })
const potions = (): NeowEffect => ({ kind: 'potions', count: 3 })
const curse = (): NeowEffect => ({ kind: 'curse' })

const boonEffects: readonly (readonly [NeowEffect[], NeowEffect[], NeowEffect[]])[] = [
  [[{ kind: 'reward', reward: 'colorless', count: 1 }], [{ kind: 'potions', count: 2 }], [{ kind: 'upgrade', count: 1, starter: 'strike' }, { kind: 'upgrade', count: 1, starter: 'defend' }, { kind: 'loseMaxHp', amount: 1 }]],
  [[{ kind: 'reward', reward: 'card', count: 1 }], [{ kind: 'gold', amount: 8 }, { kind: 'loseMaxHp', amount: 1 }], [{ kind: 'upgrade', count: 1, starter: 'strike' }, { kind: 'upgrade', count: 1, starter: 'defend' }, { kind: 'loseGold', amount: 3 }]],
  [[{ kind: 'remove', count: 1 }], [{ kind: 'gold', amount: 8 }, { kind: 'loseMaxHp', amount: 1 }], [{ kind: 'transform', count: 1, upgrade: true }, { kind: 'loseHp', amount: 2 }]],
  [[{ kind: 'upgrade', count: 2, starter: 'strike' }, { kind: 'loseHp', amount: 1 }], [{ kind: 'potions', count: 2 }], [{ kind: 'reward', reward: 'colorless', count: 1, upgraded: true }, { kind: 'loseHp', amount: 3 }]],
  [[{ kind: 'transform', count: 1 }], [{ kind: 'randomRare' }], [{ kind: 'reward', reward: 'card', count: 1, upgraded: true }, { kind: 'loseMaxHp', amount: 2 }]],
  [[{ kind: 'reward', reward: 'card', count: 1 }], [{ kind: 'relic' }, { kind: 'loseMaxHp', amount: 1 }], [{ kind: 'remove', count: 2 }, { kind: 'loseGold', amount: 3 }]],
  [[{ kind: 'potions', count: 2 }], [{ kind: 'upgrade', count: 2, starter: 'strike' }, { kind: 'loseHp', amount: 1 }], [{ kind: 'remove', count: 2 }, { kind: 'loseMaxHp', amount: 2 }]],
  [[{ kind: 'transform', count: 1 }], [{ kind: 'upgrade', count: 2, starter: 'strike' }, { kind: 'loseHp', amount: 1 }], [{ kind: 'reward', reward: 'rare', count: 1 }, { kind: 'curse' }]],
  [[{ kind: 'upgrade', count: 1 }], [{ kind: 'transform', count: 1 }], [{ kind: 'reward', reward: 'rare', count: 1 }, { kind: 'loseMaxHp', amount: 2 }]],
  [[{ kind: 'upgrade', count: 1 }], [{ kind: 'relic' }, { kind: 'loseMaxHp', amount: 1 }], [{ kind: 'gold', amount: 11 }, { kind: 'loseMaxHp', amount: 2 }]],
  [[{ kind: 'remove', count: 2, starter: 'defend' }], [{ kind: 'upgrade', count: 1 }], [{ kind: 'transform', count: 1, upgrade: true }, { kind: 'loseMaxHp', amount: 1 }]],
  [[{ kind: 'gold', amount: 8 }, { kind: 'loseMaxHp', amount: 1 }], [{ kind: 'remove', count: 1 }], [{ kind: 'transform', count: 1, upgrade: true }, { kind: 'loseGold', amount: 3 }]],
  [[{ kind: 'upgrade', count: 1 }], [{ kind: 'randomRare' }], [{ kind: 'relic', choices: 3 }, { kind: 'curse' }]],
  [[{ kind: 'potions', count: 3 }], [{ kind: 'gold', amount: 11 }, { kind: 'loseMaxHp', amount: 2 }], [{ kind: 'reward', reward: 'card', count: 1, upgraded: true }, { kind: 'curse' }]],
  [[{ kind: 'remove', count: 1 }], [{ kind: 'randomCards', source: 'colorless', count: 2 }], [{ kind: 'relic', choices: 3 }, { kind: 'loseMaxHp', amount: 2 }]],
  [[{ kind: 'reward', reward: 'colorless', count: 1 }], [{ kind: 'gold', amount: 8 }, { kind: 'loseMaxHp', amount: 1 }], [{ kind: 'randomCards', source: 'card', count: 2 }]],
  [[{ kind: 'randomRare' }], [{ kind: 'relic' }, { kind: 'loseGold', amount: 3 }], [{ kind: 'randomCards', source: 'colorless', count: 1, upgraded: true }, { kind: 'loseHp', amount: 1 }]],
  [[{ kind: 'gold', amount: 5 }], [{ kind: 'reward', reward: 'colorless', count: 1 }], [{ kind: 'reward', reward: 'card', count: 3 }, { kind: 'loseMaxHp', amount: 1 }]],
  [[{ kind: 'potions', count: 3 }], [{ kind: 'upgrade', count: 1 }], [{ kind: 'reward', reward: 'card', count: 1, upgraded: true }, { kind: 'loseHp', amount: 3 }]],
  [[{ kind: 'potions', count: 3 }], [{ kind: 'remove', count: 2, starter: 'defend' }], [{ kind: 'reward', reward: 'card', count: 1, look: 5 }, { kind: 'loseGold', amount: 1 }, { kind: 'loseHp', amount: 1 }]],
]

export const HEARTS_BOON_CARDS: readonly NeowCard[] = HEARTS_BOONS.map((boon, index) => ({
  id: `heart_boon_${String(index).padStart(2, '0')}`,
  text: boon.speech,
  source: 'heart' as const,
  unlocked: index >= 14,
  options: boon.options.map((label, optionIndex) => ({ label, effects: boonEffects[index]![optionIndex]! })) as unknown as NeowCard['options'],
}))

/** Exact 14-card base deck plus the six cards in the Colorless unlock box. */
export const NEOW_CARDS: readonly NeowCard[] = [
  { id: 'neow_01', text: "I've brought you back ...", unlocked: false, options: [
    option('Upgrade 1 card', upgrade(1)), option('Remove 1 card', remove(1)),
    option('Gain 10 Gold, lose 2 HP', gold(10), loseHp(2)),
  ] },
  { id: 'neow_02', text: 'Another ... try ...?', unlocked: false, options: [
    option('Upgrade 1 card', upgrade(1)), option('Gain 1 random Rare card', randomRare()),
    option('Gain 10 Gold and 1 Curse', gold(10), curse()),
  ] },
  { id: 'neow_03', text: 'Choose...', unlocked: false, options: [
    option('Upgrade 1 card', upgrade(1)), option('Gain 5 Gold', gold(5)),
    option('Gain 1 Relic and 1 Curse', relic(), curse()),
  ] },
  { id: 'neow_04', text: 'Greetings...', unlocked: false, options: [
    option('Upgrade 1 card', upgrade(1)), option('Gain 3 Potions', potions()),
    option('Gain 1 Rare Card Reward and 1 Curse', reward('rare'), curse()),
  ] },
  { id: 'neow_05', text: 'Greetings...', unlocked: false, options: [
    option('Gain 3 Potions', potions()), option('Gain 1 Card Reward', reward('card')),
    option('Gain 1 Relic, lose 3 Gold', relic(), loseGold()),
  ] },
  { id: 'neow_06', text: 'Risk... Reward ...', unlocked: false, options: [
    option('Remove 1 card', remove(1)), option('Transform 1 card', transform(1)),
    option('Gain 1 Relic, lose 2 HP', relic(), loseHp(2)),
  ] },
  { id: 'neow_07', text: 'Another ... try ...?', unlocked: false, options: [
    option('Gain 5 Gold', gold(5)), option('Gain 1 random Rare card', randomRare()),
    option('Gain 1 Rare Card Reward, lose 3 Gold', reward('rare'), loseGold()),
  ] },
  { id: 'neow_08', text: 'Choose...', unlocked: false, options: [
    option('Upgrade 1 card', upgrade(1)), option('Gain 3 Potions', potions()),
    option('Upgrade 2 random cards, lose 2 HP', upgrade(2, true), loseHp(2)),
  ] },
  { id: 'neow_09', text: 'Another ... try ...?', unlocked: false, options: [
    option('Transform 1 card', transform(1)), option('Gain 5 Gold', gold(5)),
    option('Remove 2 cards, lose 3 HP', remove(2), loseHp(3)),
  ] },
  { id: 'neow_10', text: "I've brought you back ...", unlocked: false, options: [
    option('Gain 1 random Rare card', randomRare()), option('Gain 1 Card Reward', reward('card')),
    option('Remove 2 cards, lose 2 HP', remove(2), loseHp(2)),
  ] },
  { id: 'neow_11', text: 'Choose...', unlocked: false, options: [
    option('Gain 1 random Rare card', randomRare()), option('Transform 1 card', transform(1)),
    option('Upgrade 2 random cards and gain 1 Curse', upgrade(2, true), curse()),
  ] },
  { id: 'neow_12', text: 'Another ... try ...?', unlocked: false, options: [
    option('Remove 1 card', remove(1)), option('Gain 5 Gold', gold(5)),
    option('Upgrade 2 random cards, lose 3 Gold', upgrade(2, true), loseGold()),
  ] },
  { id: 'neow_13', text: 'Another ... try ...?', unlocked: false, options: [
    option('Remove 1 card', remove(1)), option('Transform 1 card', transform(1)),
    option('Transform 2 cards, lose 3 HP', transform(2), loseHp(3)),
  ] },
  { id: 'neow_14', text: 'Risk... Reward ...', unlocked: false, options: [
    option('Remove 1 card', remove(1)), option('Gain 3 Potions', potions()),
    option('Gain 5 Gold, 1 Card Reward, and 1 Curse', gold(5), reward('card'), curse()),
  ] },
  { id: 'neow_c01', text: 'Hello... Again...', unlocked: true, options: [
    option('Gain 1 Colorless Card Reward', reward('colorless')), option('Transform 1 card', transform(1)),
    option('Gain 10 Gold, lose 2 HP', gold(10), loseHp(2)),
  ] },
  { id: 'neow_c02', text: 'Choose...', unlocked: true, options: [
    option('Gain 1 Colorless Card Reward', reward('colorless')), option('Remove 1 card', remove(1)),
    option('Gain 1 Rare Card Reward, lose 2 HP', reward('rare'), loseHp(2)),
  ] },
  { id: 'neow_c03', text: "I've brought you back ...", unlocked: true, options: [
    option('Gain 1 Colorless Card Reward', reward('colorless')), option('Gain 1 random Rare card', randomRare()),
    option('Gain 1 Relic, lose 3 Gold', relic(), loseGold()),
  ] },
  { id: 'neow_c04', text: 'Hello... Again...', unlocked: true, options: [
    option('Gain 1 Colorless Card Reward', reward('colorless')), option('Upgrade 1 card', upgrade(1)),
    option('Remove 2 cards, lose 3 Gold', remove(2), loseGold()),
  ] },
  { id: 'neow_c05', text: 'Another ... try ...?', unlocked: true, options: [
    option('Gain 1 Colorless Card Reward', reward('colorless')), option('Gain 3 Potions', potions()),
    option('Transform 2 cards and gain 1 Curse', transform(2), curse()),
  ] },
  { id: 'neow_c06', text: 'Risk... Reward ...', unlocked: true, options: [
    option('Transform 1 card', transform(1)), option('Gain 5 Gold', gold(5)),
    option('Gain 2 Colorless Card Rewards and 1 Curse', reward('colorless', 2), curse()),
  ] },
] as const

export function dealNeow(rng: RngState, playerIds: readonly string[], colorlessUnlocked: boolean): {
  deck: string[]
  dealt: Record<string, string>
} {
  if (playerIds.length < 1 || playerIds.length > 4 || new Set(playerIds).size !== playerIds.length) {
    throw new Error('Neow requires 1 to 4 unique players')
  }
  const shuffled = shuffle(rng, NEOW_CARDS.filter((card) => colorlessUnlocked || !card.unlocked).map((card) => card.id))
  return {
    dealt: Object.fromEntries(playerIds.map((playerId, index) => [playerId, shuffled[index]!])),
    deck: shuffled.slice(playerIds.length),
  }
}

export function dealBlessings(
  rng: RngState,
  players: readonly { id: string }[],
  prototypesUnlocked: boolean,
  ruleset: RuleSet,
): { deck: string[]; heartDeck: string[]; dealt: Record<string, string> } {
  if (players.length < 1 || players.length > 4 || new Set(players.map(({ id }) => id)).size !== players.length) {
    throw new Error('Blessings require 1 to 4 unique players')
  }
  const deck = shuffle(rng, (ruleset === 'downfall' ? HEARTS_BOON_CARDS : NEOW_CARDS)
    .filter((card) => prototypesUnlocked || !card.unlocked).map((card) => card.id))
  return {
    dealt: Object.fromEntries(players.map((player, index) => [player.id, deck[index]!])),
    deck: ruleset === 'base' ? deck.slice(players.length) : [],
    heartDeck: ruleset === 'downfall' ? deck.slice(players.length) : [],
  }
}

export const neowCard = (id: string): NeowCard | undefined =>
  NEOW_CARDS.find((card) => card.id === id) ?? HEARTS_BOON_CARDS.find((card) => card.id === id)
