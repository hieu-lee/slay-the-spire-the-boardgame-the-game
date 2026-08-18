import { shuffle } from './rng.ts'
import type { RngState } from './rng.ts'

export type EventScope = 'player' | 'party' | 'automatic'

export type EventEffectTag =
  | 'card-reward'
  | 'combat'
  | 'discard-redraw-event'
  | 'full-heal'
  | 'gain-curse'
  | 'gain-gold'
  | 'gain-potion'
  | 'gain-relic'
  | 'heal'
  | 'lose-gold'
  | 'lose-hp'
  | 'lose-potion'
  | 'lose-relic'
  | 'merchant'
  | 'move'
  | 'nothing'
  | 'pay-gold'
  | 'rare-reward'
  | 'remove-card'
  | 'remove-curses'
  | 'roll-d6'
  | 'trade-card'
  | 'trade-relic'
  | 'transform-card'
  | 'upgrade-card'

/** Small semantic payloads shared by the event engine, room UI, and item acquisition code. */
export type EventEffect = {
  tag: EventEffectTag
  amount?: number | 'all' | 'full' | 'relic-cost'
  count?: number
  target?: 'self' | 'one-player' | 'each-player' | 'party'
  source?: 'character' | 'other-character' | 'rare' | 'colorless'
  room?: 'encounter' | 'elite' | 'merchant'
  random?: boolean
  filter?: string
  perPriorChoice?: boolean
  results?: Partial<Record<1 | 2 | 3 | 4 | 5 | 6, readonly EventEffect[]>>
}

export type EventOption = {
  id: string
  label: string
  description: string
  effects: readonly EventEffect[]
}

export type EventDefinition = {
  id: string
  name: string
  scope: EventScope
  prompt?: string
  options: readonly EventOption[]
  /** A concise physical-card constraint that is not itself an effect. */
  rule?: string
}

export type EventCard = EventDefinition & {
  instanceId: string
  act: 1 | 2 | 3
  minAscension: 0 | 3
  requiresColorlessUnlock: boolean
}

const fx = (tag: EventEffectTag, fields: Omit<EventEffect, 'tag'> = {}): EventEffect => ({ tag, ...fields })
const option = (
  id: string,
  label: string,
  description: string,
  effects: readonly EventEffect[],
): EventOption => ({ id, label, description, effects })
const roll = (results: NonNullable<EventEffect['results']>): EventEffect => fx('roll-d6', { results })

/** English text and outcomes transcribed from the official physical companion app (v2.30). */
export const EVENT_DEFINITIONS: Readonly<Record<string, EventDefinition>> = {
  ancient_temple: {
    id: 'ancient_temple', name: 'Ancient Temple', scope: 'player',
    options: [
      option('go_inside', 'Go Inside', 'Gain a Relic. Lose 1 HP. Lose 1 additional HP per player who chose this option before you.', [fx('gain-relic'), fx('lose-hp', { amount: 1, perPriorChoice: true })]),
      option('leave', 'Leave', 'Nothing happens.', [fx('nothing')]),
    ],
  },
  ancient_writing: {
    id: 'ancient_writing', name: 'Ancient Writing', scope: 'player',
    options: [
      option('elegance', 'Elegance', 'Remove a card.', [fx('remove-card')]),
      option('simplicity', 'Simplicity', 'Upgrade a starter Strike and a starter Defend.', [fx('upgrade-card', { count: 2, filter: 'one starter Strike and one starter Defend' })]),
    ],
  },
  note_for_yourself: {
    id: 'note_for_yourself', name: 'A Note for Yourself', scope: 'player',
    options: [
      option('exchange', 'Exchange', 'Give a player a card in your deck. They give you a card in their deck.', [fx('trade-card')]),
      option('take', 'Take', 'Gain a Card Reward from another character reward deck.', [fx('card-reward', { source: 'other-character' })]),
    ],
  },
  augmenter: {
    id: 'augmenter', name: 'Augmenter', scope: 'player',
    options: [
      option('drink_vial', 'Drink Vial', 'Upgrade a card. Lose 1 HP.', [fx('upgrade-card'), fx('lose-hp', { amount: 1 })]),
      option('become_test_subject', 'Become Test Subject', 'Transform 2 cards. Lose 2 HP.', [fx('transform-card', { count: 2 }), fx('lose-hp', { amount: 2 })]),
    ],
  },
  big_fish: {
    id: 'big_fish', name: 'Big Fish', scope: 'player', rule: 'Each player chooses a different option.',
    options: [
      option('banana', 'Banana', 'Heal 2 HP.', [fx('heal', { amount: 2 })]),
      option('donut', 'Donut', 'Upgrade a starter Strike.', [fx('upgrade-card', { filter: 'starter Strike' })]),
      option('box', 'Box', 'Gain a Relic. Gain a Curse.', [fx('gain-relic'), fx('gain-curse')]),
      option('restraint', 'Restraint', 'Remove a starter Strike.', [fx('remove-card', { filter: 'starter Strike' })]),
    ],
  },
  bonfire_spirits: {
    id: 'bonfire_spirits', name: 'Bonfire Spirits', scope: 'player',
    rule: 'After removing the card: Uncommon heals 3 HP; Rare heals to full HP; Curse loses 1 HP; other rarities have no additional effect.',
    options: [option('offer', 'Offer', 'Remove a card.', [
      fx('remove-card'),
      fx('heal', { amount: 3, filter: 'removed card is uncommon' }),
      fx('full-heal', { filter: 'removed card is rare' }),
      fx('lose-hp', { amount: 1, filter: 'removed card is a Curse' }),
    ])],
  },
  colosseum: {
    id: 'colosseum', name: 'Colosseum', scope: 'party', rule: 'One choice for the party.',
    options: [
      option('warm_up', 'Warm Up', 'Fight an Encounter.', [fx('combat', { room: 'encounter' })]),
      option('main_event', 'Main Event', 'Fight an Elite.', [fx('combat', { room: 'elite' })]),
    ],
  },
  cursed_tome: {
    id: 'cursed_tome', name: 'Cursed Tome', scope: 'player',
    options: [
      option('take', 'Take', 'Gain a Rare Reward and a Curse.', [fx('rare-reward'), fx('gain-curse')]),
      option('read', 'Read', 'Add a random rare card to your deck. Lose 2 HP.', [fx('card-reward', { source: 'rare', random: true }), fx('lose-hp', { amount: 2 })]),
      option('skim', 'Skim', 'Gain a Card Reward. Lose 1 HP.', [fx('card-reward'), fx('lose-hp', { amount: 1 })]),
    ],
  },
  dead_adventurer: {
    id: 'dead_adventurer', name: 'Dead Adventurer', scope: 'party', rule: 'If this is the first Event, discard it and draw again. One choice for the party.',
    options: [option('search', 'Search', 'Roll the die. 1–2: fight an Elite. 3–4: each player gains 2 Gold. 5–6: one player gains a Relic.', [
      roll({
        1: [fx('combat', { room: 'elite' })], 2: [fx('combat', { room: 'elite' })],
        3: [fx('gain-gold', { amount: 2, target: 'each-player' })], 4: [fx('gain-gold', { amount: 2, target: 'each-player' })],
        5: [fx('gain-relic', { target: 'one-player' })], 6: [fx('gain-relic', { target: 'one-player' })],
      }),
    ])],
  },
  designer: {
    id: 'designer', name: 'Designer In-Spire', scope: 'player',
    options: [
      option('adjustment', 'Adjustment', 'Pay 2 Gold. Upgrade a card.', [fx('pay-gold', { amount: 2 }), fx('upgrade-card')]),
      option('clean_up', 'Clean Up', 'Pay 3 Gold. Remove a card.', [fx('pay-gold', { amount: 3 }), fx('remove-card')]),
      option('full_service', 'Full Service', 'Pay 5 Gold. Remove a card and upgrade a card.', [fx('pay-gold', { amount: 5 }), fx('remove-card'), fx('upgrade-card')]),
      option('punch', 'Punch!', 'Lose 1 HP.', [fx('lose-hp', { amount: 1 })]),
    ],
  },
  encounter: {
    id: 'encounter', name: 'Encounter!', scope: 'party',
    options: [option('fight', 'Fight!', 'Treat this room as an Encounter.', [fx('combat', { room: 'encounter' })])],
  },
  encounter_redraw: {
    id: 'encounter_redraw', name: 'Encounter!', scope: 'automatic', rule: 'This is the Act I first-Event rider face.',
    options: [option('redraw', 'Draw Again', 'If this is the first Event, discard it and draw again.', [fx('discard-redraw-event', { filter: 'first Event of the Act' })])],
  },
  face_trader: {
    id: 'face_trader', name: 'Face Trader', scope: 'player',
    options: [
      option('take_and_give', 'Take and Give', 'Gain a Relic, then lose a Relic.', [fx('gain-relic'), fx('lose-relic')]),
      option('exchange', 'Exchange', 'Give one of your Relics to a player. Then they give a Relic to you.', [fx('trade-relic')]),
    ],
  },
  falling: {
    id: 'falling', name: 'Falling', scope: 'player',
    options: [option('land', 'Land', 'Shuffle your deck, reveal its top three cards, remove one from your deck, then reshuffle it.', [fx('remove-card', { random: true, count: 1, filter: 'choose from three revealed cards' })])],
  },
  forgotten_altar: {
    id: 'forgotten_altar', name: 'Forgotten Altar', scope: 'player', rule: 'Each player randomly selects and reveals one of their Relics before choosing.',
    options: [
      option('offer', 'Offer', 'Lose your selected Relic. Gain a Relic.', [fx('lose-relic', { random: true }), fx('gain-relic')]),
      option('sacrifice', 'Sacrifice', 'Lose 2 HP.', [fx('lose-hp', { amount: 2 })]),
      option('desecrate', 'Desecrate', 'Gain a Curse.', [fx('gain-curse')]),
    ],
  },
  golden_shrine: {
    id: 'golden_shrine', name: 'Golden Shrine', scope: 'player',
    options: [
      option('pray', 'Pray', 'Gain 2 Gold.', [fx('gain-gold', { amount: 2 })]),
      option('desecrate', 'Desecrate', 'Gain 7 Gold and a Curse.', [fx('gain-gold', { amount: 7 }), fx('gain-curse')]),
    ],
  },
  knowing_skull: {
    id: 'knowing_skull', name: 'Knowing Skull', scope: 'player', rule: 'Choose one or two options.',
    options: [
      option('pick_me_up', 'Pick Me Up?', 'Gain a Potion. Lose 1 HP.', [fx('gain-potion'), fx('lose-hp', { amount: 1 })]),
      option('riches', 'Riches?', 'Gain 3 Gold. Lose 1 HP.', [fx('gain-gold', { amount: 3 }), fx('lose-hp', { amount: 1 })]),
      option('success', 'Success?', 'Gain a Card Reward. Lose 1 HP.', [fx('card-reward'), fx('lose-hp', { amount: 1 })]),
    ],
  },
  lab: {
    id: 'lab', name: 'Lab', scope: 'automatic',
    options: [option('resolve', 'Take Potions', 'Each player gains a Potion. Roll once for the party; on 4–6 one player gains another Potion.', [
      fx('gain-potion', { target: 'each-player' }),
      roll({ 4: [fx('gain-potion', { target: 'one-player' })], 5: [fx('gain-potion', { target: 'one-player' })], 6: [fx('gain-potion', { target: 'one-player' })] }),
    ])],
  },
  living_wall: {
    id: 'living_wall', name: 'Living Wall', scope: 'player',
    options: [
      option('forget', 'Forget', 'Remove a card.', [fx('remove-card')]),
      option('change', 'Change', 'Transform a card.', [fx('transform-card')]),
      option('grow', 'Grow', 'Upgrade a card.', [fx('upgrade-card')]),
    ],
  },
  mind_bloom: {
    id: 'mind_bloom', name: 'Mind Bloom', scope: 'party', rule: 'One choice for the party. All players resolve it.',
    options: [
      option('rich', 'Rich', 'Each player gains 5 Gold.', [fx('gain-gold', { amount: 5, target: 'each-player' })]),
      option('healthy', 'Healthy', 'Each player heals to full HP and gains a Curse.', [fx('full-heal', { target: 'each-player' }), fx('gain-curse', { target: 'each-player' })]),
      option('awake', 'Awake', 'Each player upgrades 2 cards and loses 3 HP.', [fx('upgrade-card', { count: 2, target: 'each-player' }), fx('lose-hp', { amount: 3, target: 'each-player' })]),
      option('war', 'War', 'Fight a random Act I Boss. The fight rewards are a Relic and a Card Reward.', [fx('combat', { room: 'elite', filter: 'random Act I boss' }), fx('gain-relic'), fx('card-reward')]),
    ],
  },
  nloth: {
    id: 'nloth', name: "N'loth", scope: 'player',
    options: [
      option('offer_relic', 'Offer', 'Give a random Relic (shuffle them face down, draw one). Gain a Rare Reward.', [fx('lose-relic', { random: true }), fx('rare-reward')]),
      option('offer_potion', 'Offer', 'Give a Potion. Add a random rare card to your deck.', [fx('lose-potion'), fx('card-reward', { source: 'rare', random: true })]),
    ],
  },
  old_beggar: {
    id: 'old_beggar', name: 'Old Beggar', scope: 'player',
    options: [option('give', 'Give', 'Pay 2 Gold. Remove a card.', [fx('pay-gold', { amount: 2 }), fx('remove-card')])],
  },
  ominous_forge: {
    id: 'ominous_forge', name: 'Ominous Forge', scope: 'player',
    options: [
      option('rummage', 'Rummage', 'Gain a Relic. Roll the die; on 1–3 gain a Curse.', [fx('gain-relic'), roll({ 1: [fx('gain-curse')], 2: [fx('gain-curse')], 3: [fx('gain-curse')] })]),
      option('forge', 'Forge', 'Upgrade a card. Lose 2 HP.', [fx('upgrade-card'), fx('lose-hp', { amount: 2 })]),
    ],
  },
  purifier: {
    id: 'purifier', name: 'Purifier', scope: 'player',
    options: [
      option('pray', 'Pray', 'Remove a card.', [fx('remove-card')]),
      option('cleanse', 'Cleanse', 'Remove all Curses from your deck.', [fx('remove-curses', { amount: 'all' })]),
    ],
  },
  scrap_ooze: {
    id: 'scrap_ooze', name: 'Scrap Ooze', scope: 'player', rule: 'On 1–2, choose to Reach Inside again or Leave.',
    options: [option('reach_inside', 'Reach Inside', 'Roll the die. Lose 1 HP. 1–2: Reach Inside again or Leave. 3–4: gain 2 Gold. 5–6: gain a Relic.', [
      fx('lose-hp', { amount: 1 }),
      roll({ 1: [fx('nothing', { filter: 'repeat-or-leave' })], 2: [fx('nothing', { filter: 'repeat-or-leave' })], 3: [fx('gain-gold', { amount: 2 })], 4: [fx('gain-gold', { amount: 2 })], 5: [fx('gain-relic')], 6: [fx('gain-relic')] }),
    ]), option('leave', 'Leave', 'Stop reaching into the ooze.', [fx('nothing')])],
  },
  secret_portal: {
    id: 'secret_portal', name: 'Secret Portal', scope: 'party',
    options: [option('enter', 'Enter the Portal', "Immediately move up to any room, ignoring paths. You can't move backwards.", [fx('move', { target: 'party', filter: 'any higher room' })])],
  },
  sensory_stone: {
    id: 'sensory_stone', name: 'Sensory Stone', scope: 'player',
    options: [
      option('recall_one', 'Recall', 'Gain a Card Reward from the colorless rewards.', [fx('card-reward', { source: 'colorless' })]),
      option('recall_two', 'Recall', 'Gain 2 Card Rewards from the colorless rewards. Lose 2 HP.', [fx('card-reward', { source: 'colorless', count: 2 }), fx('lose-hp', { amount: 2 })]),
    ],
  },
  the_cleric: {
    id: 'the_cleric', name: 'The Cleric', scope: 'player',
    options: [
      option('heal', 'Heal', 'Pay 1 Gold. Heal 3 HP.', [fx('pay-gold', { amount: 1 }), fx('heal', { amount: 3 })]),
      option('prayer', 'Prayer', 'Pay 2 Gold. Upgrade a card.', [fx('pay-gold', { amount: 2 }), fx('upgrade-card')]),
      option('purify', 'Purify', 'Pay 3 Gold. Remove a card.', [fx('pay-gold', { amount: 3 }), fx('remove-card')]),
    ],
  },
  the_joust: {
    id: 'the_joust', name: 'The Joust', scope: 'player',
    options: [option('bet', 'Bet', 'Pay 2 Gold, a Relic, or a Potion. Roll the die; on 4–6 gain 6 Gold.', [
      fx('pay-gold', { amount: 2, filter: 'or lose one Relic or Potion' }),
      roll({ 4: [fx('gain-gold', { amount: 6 })], 5: [fx('gain-gold', { amount: 6 })], 6: [fx('gain-gold', { amount: 6 })] }),
    ])],
  },
  the_library: {
    id: 'the_library', name: 'The Library', scope: 'player',
    options: [
      option('read', 'Read', 'Gain a Card Reward. Look at 5 cards instead of 3.', [fx('card-reward', { count: 1, filter: 'reveal 5' })]),
      option('sleep', 'Sleep', 'Heal 3 HP.', [fx('heal', { amount: 3 })]),
    ],
  },
  mausoleum: {
    id: 'mausoleum', name: 'The Mausoleum', scope: 'player',
    options: [option('open_coffin', 'Open Coffin', 'Gain a Relic. Roll the die; on 1–3 gain a Curse.', [fx('gain-relic'), roll({ 1: [fx('gain-curse')], 2: [fx('gain-curse')], 3: [fx('gain-curse')] })])],
  },
  merchant: {
    id: 'merchant', name: 'The Merchant', scope: 'party',
    options: [option('shop', 'Shop', 'Treat this room as a Merchant.', [fx('merchant', { room: 'merchant' })])],
  },
  merchant_redraw: {
    id: 'merchant_redraw', name: 'The Merchant', scope: 'automatic', rule: 'This is the Act I first-Event rider face.',
    options: [option('redraw', 'Draw Again', 'If this is the first Event, discard it and draw again.', [fx('discard-redraw-event', { filter: 'first Event of the Act' })])],
  },
  moai_head: {
    id: 'moai_head', name: 'The Moai Head', scope: 'player',
    options: [
      option('offer', 'Offer', 'Lose a Relic. Gain Gold equal to its cost.', [fx('lose-relic'), fx('gain-gold', { amount: 'relic-cost' })]),
      option('jump_inside', 'Jump Inside', 'Heal to full HP. Then lose 2 HP.', [fx('full-heal'), fx('lose-hp', { amount: 2 })]),
    ],
  },
  woman_in_blue: {
    id: 'woman_in_blue', name: 'The Woman in Blue', scope: 'player',
    options: [
      option('buy_one', 'Buy 1', 'Pay 1 Gold. Gain a Potion.', [fx('pay-gold', { amount: 1 }), fx('gain-potion')]),
      option('buy_two', 'Buy 2', 'Pay 2 Gold. Gain 2 Potions.', [fx('pay-gold', { amount: 2 }), fx('gain-potion', { count: 2 })]),
      option('leave', 'Leave', 'WHAM! Lose 1 HP.', [fx('lose-hp', { amount: 1 })]),
    ],
  },
  tomb_red_mask: {
    id: 'tomb_red_mask', name: 'Tomb of Lord Red Mask', scope: 'party',
    options: [
      option('offer_gold', 'Offer Gold', 'The party loses all Gold. Each player gains a Relic.', [fx('lose-gold', { amount: 'all', target: 'party' }), fx('gain-relic', { target: 'each-player' })]),
      option('don_mask', 'Don the Mask', 'If a player has the Red Mask item, each player gains 6 Gold.', [fx('gain-gold', { amount: 6, target: 'each-player', filter: 'party has Red Mask' })]),
    ],
  },
  transmogriphier: {
    id: 'transmogriphier', name: 'Transmogriphier', scope: 'player',
    options: [
      option('pray', 'Pray', 'Transform a card.', [fx('transform-card')]),
      option('sacrifice', 'Sacrifice', 'Transform 2 cards. Gain a Curse.', [fx('transform-card', { count: 2 }), fx('gain-curse')]),
    ],
  },
  upgrade_shrine: {
    id: 'upgrade_shrine', name: 'Upgrade Shrine', scope: 'player',
    options: [
      option('pray', 'Pray', 'Upgrade a card.', [fx('upgrade-card')]),
      option('sacrifice', 'Sacrifice', 'Upgrade 2 random cards. Lose 2 HP.', [fx('upgrade-card', { count: 2, random: true }), fx('lose-hp', { amount: 2 })]),
    ],
  },
  we_meet_again: {
    id: 'we_meet_again', name: 'We Meet Again!', scope: 'player',
    options: [
      option('give_gold', 'Give Gold', 'Pay 4 Gold. Gain a Relic.', [fx('pay-gold', { amount: 4 }), fx('gain-relic')]),
      option('exchange', 'Exchange', 'Lose a Relic. Gain a Relic.', [fx('lose-relic'), fx('gain-relic')]),
      option('give_card', 'Give Card', 'Remove a rare or uncommon card. Gain a Relic.', [fx('remove-card', { filter: 'rare or uncommon' }), fx('gain-relic')]),
    ],
  },
  wheel_of_change: {
    id: 'wheel_of_change', name: 'Wheel of Change', scope: 'player', rule: 'Each player rolls separately.',
    options: [option('spin', 'Spin', 'Roll the die. 1: heal to full HP. 2: gain a Curse. 3: remove a card. 4: gain a Relic. 5: gain 4 Gold. 6: lose 2 HP.', [
      roll({ 1: [fx('full-heal')], 2: [fx('gain-curse')], 3: [fx('remove-card')], 4: [fx('gain-relic')], 5: [fx('gain-gold', { amount: 4 })], 6: [fx('lose-hp', { amount: 2 })] }),
    ])],
  },
  winding_halls: {
    id: 'winding_halls', name: 'Winding Halls', scope: 'player',
    options: [
      option('embrace_madness', 'Embrace Madness', 'Add two random Card Rewards to your deck.', [fx('card-reward', { count: 2, random: true })]),
      option('press_on', 'Press On', 'Heal 3 HP. Gain a Curse.', [fx('heal', { amount: 3 }), fx('gain-curse')]),
      option('retrace', 'Retrace Your Steps', 'Lose 2 HP.', [fx('lose-hp', { amount: 2 })]),
    ],
  },
  wing_statue: {
    id: 'wing_statue', name: 'Wing Statue', scope: 'player',
    options: [
      option('pray', 'Pray', 'Remove a card. Lose 2 HP.', [fx('remove-card'), fx('lose-hp', { amount: 2 })]),
      option('gather_gold', 'Gather Gold', 'Gain 2 Gold.', [fx('gain-gold', { amount: 2 })]),
    ],
  },
  world_of_goop: {
    id: 'world_of_goop', name: 'World of Goop', scope: 'player',
    options: [
      option('gather_gold', 'Gather Gold', 'Gain 3 Gold. Lose 2 HP.', [fx('gain-gold', { amount: 3 }), fx('lose-hp', { amount: 2 })]),
      option('reach_deeper', 'Reach Deeper', 'Gain a Relic and a Curse.', [fx('gain-relic'), fx('gain-curse')]),
      option('leave_it', 'Leave It', 'Lose 1 Gold.', [fx('lose-gold', { amount: 1 })]),
    ],
  },
}

type InstanceSpec = readonly [instanceId: string, definitionId: string, act: 1 | 2 | 3, minAscension?: 0 | 3, requiresColorlessUnlock?: boolean]

const INSTANCES: readonly InstanceSpec[] = [
  ['act1-living-wall', 'living_wall', 1],
  ['act1-ancient-temple', 'ancient_temple', 1],
  ['act1-bonfire-spirits', 'bonfire_spirits', 1],
  ['act1-library', 'the_library', 1],
  ['act1-big-fish', 'big_fish', 1],
  ['act1-wheel-of-change', 'wheel_of_change', 1],
  ['act1-transmogriphier', 'transmogriphier', 1],
  ['act1-cleric', 'the_cleric', 1],
  ['act1-lab', 'lab', 1],
  ['act1-upgrade-shrine', 'upgrade_shrine', 1],
  ['act1-wing-statue', 'wing_statue', 1],
  ['act1-ominous-forge', 'ominous_forge', 1],
  ['act1-encounter-a3-1', 'encounter', 1, 3],
  ['act1-encounter-a3-2', 'encounter_redraw', 1, 3],
  ['act1-merchant-a3', 'merchant_redraw', 1, 3],
  ['act1-dead-adventurer-a3', 'dead_adventurer', 1, 3],
  ['act1-scrap-ooze-a3', 'scrap_ooze', 1, 3],
  ['act1-world-of-goop-a3', 'world_of_goop', 1, 3],

  ['act2-knowing-skull', 'knowing_skull', 2],
  ['act2-we-meet-again', 'we_meet_again', 2],
  ['act2-wheel-of-change', 'wheel_of_change', 2],
  ['act2-designer', 'designer', 2],
  ['act2-cursed-tome', 'cursed_tome', 2],
  ['act2-colosseum', 'colosseum', 2],
  ['act2-ancient-writing', 'ancient_writing', 2],
  ['act2-note-for-yourself', 'note_for_yourself', 2],
  ['act2-joust', 'the_joust', 2],
  ['act2-woman-in-blue', 'woman_in_blue', 2],
  ['act2-nloth', 'nloth', 2],
  ['act2-augmenter', 'augmenter', 2],
  ['act2-golden-shrine', 'golden_shrine', 2],
  ['act2-old-beggar', 'old_beggar', 2],
  ['act2-encounter-a3-1', 'encounter', 2, 3],
  ['act2-encounter-a3-2', 'encounter', 2, 3],
  ['act2-merchant-a3', 'merchant', 2, 3],
  ['act2-mausoleum-a3', 'mausoleum', 2, 3],
  ['act2-forgotten-altar-a3', 'forgotten_altar', 2, 3],

  ['act3-bonfire-spirits', 'bonfire_spirits', 3],
  ['act3-wheel-of-change', 'wheel_of_change', 3],
  ['act3-purifier', 'purifier', 3],
  ['act3-falling', 'falling', 3],
  ['act3-note-for-yourself', 'note_for_yourself', 3],
  ['act3-face-trader', 'face_trader', 3],
  ['act3-tomb-red-mask', 'tomb_red_mask', 3],
  ['act3-moai-head', 'moai_head', 3],
  ['act3-mind-bloom', 'mind_bloom', 3],
  ['act3-winding-halls', 'winding_halls', 3],
  ['act3-secret-portal', 'secret_portal', 3],
  ['act3-merchant-a3', 'merchant', 3, 3],
  ['act3-encounter-a3', 'encounter', 3, 3],
  ['act3-sensory-stone', 'sensory_stone', 3, 0, true],
]

export const EVENT_CARDS: readonly EventCard[] = INSTANCES.map(
  ([instanceId, definitionId, act, minAscension = 0, requiresColorlessUnlock = false]) => {
    const definition = EVENT_DEFINITIONS[definitionId]
    if (!definition) throw new Error(`unknown Event definition: ${definitionId}`)
    return { ...definition, instanceId, act, minAscension, requiresColorlessUnlock }
  },
)

/** Whether resolving this Event can immediately begin combat, including a die result. */
export function eventCanStartCombat(card: EventDefinition): boolean {
  const effectsCanStartCombat = (effects: readonly EventEffect[]): boolean => effects.some((effect) =>
    effect.tag === 'combat' || effect.tag === 'move' || Object.values(effect.results ?? {}).some((result) =>
      result && effectsCanStartCombat(result)))
  return card.options.some((option) => effectsCanStartCombat(option.effects))
}

/** Builds the physical Event deck for one act and advances the run RNG exactly once per shuffle swap. */
export function buildEventDeck(
  rng: RngState,
  act: 1 | 2 | 3,
  ascension: number,
  colorlessUnlocked: boolean,
): EventCard[] {
  return shuffle(
    rng,
    EVENT_CARDS.filter(
      (card) => card.act === act
        && ascension >= card.minAscension
        && (!card.requiresColorlessUnlock || colorlessUnlocked),
    ),
  )
}
