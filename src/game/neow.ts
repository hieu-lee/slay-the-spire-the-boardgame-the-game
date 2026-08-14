import { shuffle } from './rng.ts'
import type { RngState } from './rng.ts'

export type NeowRewardKind = 'card' | 'rare' | 'colorless' | 'potion' | 'relic'

export type NeowEffect =
  | { kind: 'upgrade'; count: 1 | 2; random?: boolean }
  | { kind: 'remove'; count: 1 | 2 }
  | { kind: 'transform'; count: 1 | 2 }
  | { kind: 'gold'; amount: 3 | 5 | 10 }
  | { kind: 'loseGold'; amount: 3 }
  | { kind: 'loseHp'; amount: 2 | 3 }
  | { kind: 'reward'; reward: NeowRewardKind; count: 1 | 2 }
  | { kind: 'randomRare' }
  | { kind: 'relic' }
  | { kind: 'potions'; count: 3 }
  | { kind: 'curse' }

export type NeowImmediateReward = Extract<NeowEffect,
  { kind: 'upgrade' | 'remove' | 'transform' | 'gold' | 'randomRare' }>
export type NeowQueuedEffect = NeowRewardKind | Exclude<NeowEffect,
  { kind: 'reward' | 'potions' | 'relic' }>

export type NeowOption = { label: string; effects: readonly NeowEffect[] }
export type NeowCard = {
  id: string
  text: string
  unlocked: boolean
  options: readonly [NeowOption, NeowOption, NeowOption]
}

export type NeowRewardOffer = {
  kind: NeowRewardKind
  choices: string[]
  /** Exact face-up cards, kept so resolution never trusts a client-provided effect. */
  cardsDrawn: string[]
  raresDrawn: string[]
  prismaticDraws?: Array<{ source: 'ironclad' | 'silent' | 'defect' | 'watcher' | 'colorless'; cardId: string; rareId?: string }>
}

export type NeowPlayerState = {
  cardId: string
  redGoldPending: boolean
  redRewardPending: boolean
  redReward: NeowRewardOffer | null
  blueOption: number | null
  pendingEffect: NeowImmediateReward | null
  rewardKind: NeowRewardKind | null
  reward: NeowRewardOffer | null
  rewardQueue: NeowQueuedEffect[]
  done: boolean
}

export type NeowState = {
  /** Remaining face-down cards. Transport redacts this field. */
  deck: string[]
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

export const neowCard = (id: string): NeowCard | undefined => NEOW_CARDS.find((card) => card.id === id)
