// Relics and potions.
//
// A relic is a permanent, always-on effect; a potion is single-use. Both are
// modelled as triggers rather than as code so the campaign can hold them as
// plain data alongside everything else.
import type { Effect, TargetScope } from './cards.ts'
import { shuffle, type RngState } from './rng.ts'
import type { RelicInstance } from './types.ts'
import type { Trigger } from './triggers.ts'

/** Relics and Powers share one trigger vocabulary; see triggers.ts. */
export type RelicTrigger = Trigger

export type RelicDef = {
  id: string
  name: string
  /** Which physical deck or setup area contains this relic. */
  pool: 'starting' | 'ordinary' | 'boss' | 'solo' | 'special'
  /** Gold cost at the Merchant; absent means it is not for sale. */
  cost?: number
  /** Automatic abilities that already fit the shared relic/Power dispatcher. */
  trigger?: RelicTrigger
  effects: Effect[]
  target?: TargetScope
  supportTarget?: TargetScope
  /** Additional automatic abilities printed on the same relic. */
  abilities?: { trigger: RelicTrigger; effects: Effect[]; target?: TargetScope; supportTarget?: TargetScope }[]
  /** A face-down relic is restored at the printed boundary. */
  activation?: 'oncePerCombat' | 'oncePerRoom'
  /** Finite uses printed on the component; the instance owns the remaining count. */
  uses?: number
  /** Cubes supplied by the relic at the start of combat. */
  cubes?: number
  /** Physical rule that resolves when acquired or while held, outside the trigger dispatcher. */
  rule?: string
  /** Prose for the UI. The effects above are what actually resolve. */
  text: string
}

export const RELICS: Record<string, RelicDef> = {
  burning_blood: {
    id: 'burning_blood',
    name: 'Burning Blood',
    pool: 'starting',
    trigger: { kind: 'endOfCombat' },
    effects: [{ kind: 'heal', amount: 1 }],
    text: 'End of combat: heal 1 HP.',
  },
  ring_of_the_snake: {
    id: 'ring_of_the_snake',
    name: 'Ring of the Snake',
    pool: 'starting',
    trigger: { kind: 'startOfCombat' },
    effects: [{ kind: 'draw', amount: 2 }],
    text: 'Start of combat: draw 2 cards.',
  },
  cracked_core: {
    id: 'cracked_core',
    name: 'Cracked Core',
    pool: 'starting',
    trigger: { kind: 'startOfCombat' },
    effects: [{ kind: 'channel', orb: 'lightning', amount: 1 }],
    text: 'Start of combat: channel 1 Lightning.',
  },
  pure_water: {
    id: 'pure_water',
    name: 'Pure Water',
    pool: 'starting',
    trigger: { kind: 'startOfCombat' },
    effects: [{ kind: 'gainMiracle', amount: 1 }],
    text: 'Start of combat: gain 1 Miracle.',
  },
  prismatic_shard: {
    id: 'prismatic_shard',
    name: 'Prismatic Shard',
    pool: 'special',
    effects: [],
    rule: 'Daily/Custom Run: choose normal rewards from three different reward decks; rare rewards use three different character rare decks.',
    text: 'Daily/Custom Run: use three different chosen reward decks for Card Rewards.',
  },
  anchor: {
    id: 'anchor',
    name: 'Anchor',
    pool: 'ordinary',
    cost: 6,
    trigger: { kind: 'startOfCombat' },
    effects: [{ kind: 'block', amount: 2 }],
    text: 'Start of combat: gain 2 Block.',
  },
  happy_flower: {
    id: 'happy_flower',
    name: 'Happy Flower',
    pool: 'ordinary',
    cost: 6,
    trigger: { kind: 'dieRelic', faces: [3, 4] },
    effects: [{ kind: 'gainEnergy', amount: 1 }],
    text: 'On a 3 or 4: gain 1 Energy.',
  },
  akabeko: {
    id: 'akabeko',
    name: 'Akabeko',
    pool: 'ordinary',
    cost: 6,
    effects: [],
    activation: 'oncePerCombat',
    rule: 'Gain 1 Strength for one Attack.',
    text: 'Once per combat: gain 1 Strength for one Attack.',
  },
}

const ordinary = (def: Omit<RelicDef, 'pool'>): void => { RELICS[def.id] = { ...def, pool: 'ordinary' } }
const boss = (def: Omit<RelicDef, 'pool'>): void => { RELICS[def.id] = { ...def, pool: 'boss' } }

ordinary({ id: 'bag_of_preparation', name: 'Bag of Preparation', cost: 7,
  trigger: { kind: 'startOfCombat' }, effects: [{ kind: 'draw', amount: 2 }],
  text: 'Start of combat: draw 2 cards.' })
ordinary({ id: 'bird_faced_urn', name: 'Bird-Faced Urn', cost: 9,
  trigger: { kind: 'onPlayCard', cardType: 'power' }, effects: [{ kind: 'block', amount: 1 }],
  text: 'When you play a Power: gain 1 Block.' })
ordinary({ id: 'blood_vial', name: 'Blood Vial', cost: 6,
  trigger: { kind: 'startOfCombat' }, effects: [{ kind: 'heal', amount: 1 }],
  text: 'Start of combat: heal 1 HP.' })
ordinary({ id: 'blue_candle', name: 'Blue Candle', cost: 7, effects: [], activation: 'oncePerCombat',
  rule: 'Exhaust up to 2 cards in your hand.',
  text: 'Once per combat: Exhaust up to 2 cards in your hand.' })
ordinary({ id: 'calipers', name: 'Calipers', cost: 6, effects: [], activation: 'oncePerCombat',
  rule: 'Keep your leftover Block from last turn.',
  text: 'Once per combat: keep your leftover Block from last turn.' })
ordinary({ id: 'captains_wheel', name: "Captain's Wheel", cost: 8,
  trigger: { kind: 'dieRelic', faces: [3] }, effects: [{ kind: 'block', amount: 3 }],
  text: 'On a 3: gain 3 Block.' })
ordinary({ id: 'centennial_puzzle', name: 'Centennial Puzzle', cost: 8, effects: [],
  activation: 'oncePerCombat', rule: 'Draw 3 cards if you lost HP this combat.',
  text: 'Once per combat: draw 3 cards if you lost HP this combat.' })
ordinary({ id: 'charons_ashes', name: "Charon's Ashes", cost: 7, effects: [],
  rule: 'On a 1 or 2, you may Exhaust a card to deal 2 damage.',
  text: 'On a 1 or 2: you may Exhaust a card to deal 2 damage.' })
ordinary({ id: 'dead_branch', name: 'Dead Branch', cost: 9, effects: [], activation: 'oncePerCombat',
  rule: 'Draw a card for each card in your Exhaust pile.',
  text: 'Once per combat: draw a card for each card in your Exhaust pile.' })
ordinary({ id: 'dollys_mirror', name: "Dolly's Mirror", cost: 7, effects: [],
  rule: 'On a 1, trigger a die relic ability; its owner gains the effect.',
  text: 'On a 1: trigger a die relic ability. Its owner gains the effect.' })
ordinary({ id: 'du_vu_doll', name: 'Du-Vu Doll', cost: 7,
  trigger: { kind: 'onDraw', cardType: 'curse' },
  effects: [{ kind: 'gainTemporaryStrength', amount: 1, loseGainedOnly: true }],
  text: 'When you draw a Curse: gain 1 Strength. Lose it at end of turn.' })
ordinary({ id: 'duality', name: 'Duality', cost: 8,
  trigger: { kind: 'dieRelic', faces: [2] }, effects: [{ kind: 'block', amount: 2 }],
  abilities: [{ trigger: { kind: 'dieRelic', faces: [4] }, effects: [{ kind: 'damage', amount: 2 }] }],
  text: 'On a 2: gain 2 Block. On a 4: deal 2 damage.' })
ordinary({ id: 'gambling_chip', name: 'Gambling Chip', cost: 6, effects: [], activation: 'oncePerRoom',
  rule: 'Reroll the die.', text: 'Once per room: reroll the die.' })
ordinary({ id: 'golden_eye', name: 'Golden Eye', cost: 7, effects: [], activation: 'oncePerCombat',
  rule: 'Scry 3.', text: 'Once per combat: Scry 3.' })
ordinary({ id: 'golden_idol', name: 'Golden Idol', cost: 4, effects: [],
  rule: 'At end of combat, gain 1 gold.', text: 'End of combat: gain 1 gold.' })
ordinary({ id: 'gremlin_horn', name: 'Gremlin Horn', cost: 8,
  trigger: { kind: 'dieRelic', faces: [4] }, effects: [{ kind: 'draw', amount: 1 }],
  abilities: [{ trigger: { kind: 'dieRelic', faces: [5] }, effects: [{ kind: 'gainEnergy', amount: 1 }] }],
  text: 'On a 4: draw a card. On a 5: gain 1 Energy.' })
ordinary({ id: 'horn_cleat', name: 'Horn Cleat', cost: 6,
  trigger: { kind: 'dieRelic', faces: [1, 2] }, effects: [{ kind: 'block', amount: 1 }],
  text: 'On a 1 or 2: gain 1 Block.' })
ordinary({ id: 'ice_cream', name: 'Ice Cream', cost: 7, effects: [],
  rule: 'At start of turn, regain leftover Energy from last turn; maximum Energy is 6.',
  text: 'Start of turn: regain your leftover Energy from last turn (maximum 6).' })
ordinary({ id: 'incense_burner', name: 'Incense Burner', cost: 11,
  trigger: { kind: 'dieRelic', faces: [6] }, effects: [{ kind: 'limitRoundHpLoss', amount: 1 }],
  text: 'On a 6: you cannot lose more than 1 HP this round.' })
ordinary({ id: 'ink_bottle', name: 'Ink Bottle', cost: 6,
  trigger: { kind: 'dieRelic', faces: [5, 6] }, effects: [{ kind: 'draw', amount: 1 }],
  text: 'On a 5 or 6: draw a card.' })
ordinary({ id: 'lantern', name: 'Lantern', cost: 6,
  trigger: { kind: 'startOfCombat' }, effects: [{ kind: 'gainEnergy', amount: 1 }],
  text: 'Start of combat: gain 1 Energy.' })
ordinary({ id: 'meat_on_the_bone', name: 'Meat on the Bone', cost: 8, effects: [],
  rule: 'At end of combat, if you have less than 4 HP, set your HP to 4.',
  text: 'End of combat: if you have less than 4 HP, your HP becomes 4.' })
ordinary({ id: 'mercury_hourglass', name: 'Mercury Hourglass', cost: 6,
  trigger: { kind: 'dieRelic', faces: [1, 2] }, effects: [{ kind: 'damage', amount: 1 }],
  target: 'row', abilities: [], text: 'On a 1 or 2: deal 1 damage to any row.' })
ordinary({ id: 'molten_egg', name: 'Molten Egg', cost: 8, effects: [], uses: 3,
  rule: 'Upgrade the next 3 Attacks added to your deck, then discard this relic.',
  text: 'When you add an Attack to your deck, upgrade it. Use 3 times, then discard.' })
ordinary({ id: 'mummified_hand', name: 'Mummified Hand', cost: 10, effects: [], activation: 'oncePerCombat',
  rule: 'Gain 2 Energy if you played a Power this turn.',
  text: 'Once per combat: gain 2 Energy if you played a Power this turn.' })
ordinary({ id: 'mutagen', name: 'Mutagen', cost: 6,
  trigger: { kind: 'startOfCombat' }, effects: [{ kind: 'gainTemporaryStrength', amount: 1 }],
  text: 'Start of combat: gain 1 Strength. Lose it at end of turn.' })
ordinary({ id: 'necronomicon', name: 'Necronomicon', cost: 9,
  trigger: { kind: 'dieRelic', faces: [1] }, effects: [{ kind: 'doubleNextAttack' }],
  text: 'On a 1: your first Attack this turn is played twice.' })
ordinary({ id: 'nilrys_codex', name: "Nilry's Codex", cost: 7,
  trigger: { kind: 'dieRelic', faces: [2] }, effects: [{ kind: 'draw', amount: 1 }],
  rule: 'On a 4, trigger another relic’s 2 ability; its owner gains the effect.',
  text: 'On a 2: draw a card. On a 4: trigger a 2 ability; its owner gains the effect.' })
ordinary({ id: 'ninja_scroll', name: 'Ninja Scroll', cost: 6, effects: [], activation: 'oncePerCombat',
  rule: 'Gain 2 Shivs.', text: 'Once per combat: gain 2 Shivs.' })
ordinary({ id: 'oddly_smooth_stone', name: 'Oddly Smooth Stone', cost: 7,
  trigger: { kind: 'dieRelic', faces: [4] }, effects: [{ kind: 'block', amount: 2, toChosen: true }],
  supportTarget: 'anyPlayer',
  text: 'On a 4: give 2 Block to any player.' })
ordinary({ id: 'old_coin', name: 'Old Coin', effects: [],
  rule: 'Gain 10 gold, then discard this relic. At the Merchant or Courier, discard and redraw.',
  text: 'Gain 10 gold, then discard. If revealed at the Merchant or Courier, discard and redraw.' })
ordinary({ id: 'omamori', name: 'Omamori', cost: 5, effects: [],
  rule: 'You cannot gain Curses.', text: 'You cannot gain Curses.' })
ordinary({ id: 'orichalcum', name: 'Orichalcum', cost: 5, effects: [],
  rule: 'At end of turn, gain 1 Block if you have no Block.',
  text: 'End of turn: gain 1 Block if you do not have any Block.' })
ordinary({ id: 'peace_pipe', name: 'Peace Pipe', cost: 8, effects: [],
  rule: 'When you Rest, you may also remove a card.',
  text: 'When you Rest: you may also remove a card.' })
ordinary({ id: 'pen_nib', name: 'Pen Nib', cost: 8,
  trigger: { kind: 'dieRelic', faces: [5] }, effects: [{ kind: 'applyVulnerable', amount: 1 }],
  text: 'On a 5: apply 1 Vulnerable.' })
ordinary({ id: 'pocketwatch', name: 'Pocketwatch', cost: 9,
  trigger: { kind: 'dieRelic', faces: [3] }, effects: [{ kind: 'draw', amount: 3 }],
  text: 'On a 3: draw 3 cards.' })
ordinary({ id: 'red_mask', name: 'Red Mask', cost: 7,
  trigger: { kind: 'dieRelic', faces: [5, 6] }, effects: [{ kind: 'applyWeak', amount: 1 }],
  text: 'On a 5 or 6: apply 1 Weak.' })
ordinary({ id: 'red_skull', name: 'Red Skull', cost: 9, effects: [], activation: 'oncePerCombat',
  rule: 'Gain 1 Strength if you shuffled your draw pile this combat.',
  text: 'Once per combat: gain 1 Strength if you shuffled your draw pile this combat.' })
ordinary({ id: 'regal_pillow', name: 'Regal Pillow', cost: 6, effects: [],
  rule: 'When you Rest, heal 3 additional HP.', text: 'When you Rest: heal 3 additional HP.' })
ordinary({ id: 'runic_pyramid', name: 'Runic Pyramid', cost: 6, effects: [], activation: 'oncePerCombat',
  rule: 'Retain any number of cards this turn.',
  text: 'Once per combat: Retain any number of cards this turn.' })
ordinary({ id: 'self_forming_clay', name: 'Self-Forming Clay', cost: 8, effects: [], activation: 'oncePerCombat',
  rule: 'Gain 3 Block if you lost HP this combat.',
  text: 'Once per combat: gain 3 Block if you lost HP this combat.' })
ordinary({ id: 'ssserpent_head', name: 'Ssserpent Head', cost: 6, effects: [],
  rule: 'Gain 2 Gold when you enter an Event room.',
  text: 'At an Event: gain 2 Gold when you enter the room.' })
ordinary({ id: 'stone_calendar', name: 'Stone Calendar', cost: 7,
  trigger: { kind: 'dieRelic', faces: [4] }, effects: [{ kind: 'damage', amount: 4 }],
  text: 'On a 4: deal 4 damage.' })
ordinary({ id: 'strike_dummy', name: 'Strike Dummy', cost: 8, effects: [],
  rule: 'Starter Strikes deal +1 damage.', text: 'When you play a starter Strike, it deals +1 damage.' })
ordinary({ id: 'sundial', name: 'Sundial', cost: 8,
  trigger: { kind: 'dieRelic', faces: [2] }, effects: [{ kind: 'gainEnergy', amount: 2 }],
  text: 'On a 2: gain 2 Energy.' })
ordinary({ id: 'the_abacus', name: 'The Abacus', cost: 6, effects: [], activation: 'oncePerRoom',
  rule: 'Add 1 to the die result; 6 wraps to 1.',
  text: 'Once per room: +1 to the die result (6 becomes 1).' })
ordinary({ id: 'the_boot', name: 'The Boot', cost: 5,
  trigger: { kind: 'dieRelic', faces: [4, 5, 6] }, effects: [{ kind: 'damage', amount: 1 }],
  text: 'On a 4, 5, or 6: deal 1 damage.' })
ordinary({ id: 'the_courier', name: 'The Courier', cost: 6, effects: [], activation: 'oncePerCombat',
  rule: 'Look at the top Potion or Relic. Buy it or discard it.',
  text: 'Once per combat: look at the top Potion or Relic. Buy it or discard it.' })
ordinary({ id: 'toolbox', name: 'Toolbox', cost: 7, effects: [], activation: 'oncePerRoom',
  rule: 'Subtract 1 from the die result; 1 wraps to 6.',
  text: 'Once per room: -1 to the die result (1 becomes 6).' })
ordinary({ id: 'toxic_egg', name: 'Toxic Egg', cost: 8, effects: [], uses: 3,
  rule: 'Upgrade the next 3 Skills added to your deck, then discard this relic.',
  text: 'When you add a Skill to your deck, upgrade it. Use 3 times, then discard.' })
ordinary({ id: 'tungsten_rod', name: 'Tungsten Rod', cost: 8,
  trigger: { kind: 'dieRelic', faces: [5] }, effects: [{ kind: 'block', amount: 1 }], supportTarget: 'allPlayers',
  rule: 'On a 5, give all players 1 Block, or 3 Block in solo.',
  text: 'On a 5: 1 Block to all players, 3 Block instead if solo.' })
ordinary({ id: 'vajra', name: 'Vajra', cost: 7,
  trigger: { kind: 'dieRelic', faces: [2] }, effects: [{ kind: 'gainTemporaryStrength', amount: 1 }],
  text: 'On a 2: gain 1 Strength. Lose it at end of turn.' })
ordinary({ id: 'war_paint', name: 'War Paint', cost: 8, effects: [],
  rule: 'Upgrade a starter Defend and another Skill, then discard; cannot be used in combat.',
  text: 'Upgrade a starter Defend and another Skill, then discard. Cannot be used in combat.' })
ordinary({ id: 'whetstone', name: 'Whetstone', cost: 7, effects: [],
  rule: 'Upgrade a starter Strike and another Attack, then discard; cannot be used in combat.',
  text: 'Upgrade a starter Strike and another Attack, then discard. Cannot be used in combat.' })
ordinary({ id: 'wing_boots', name: 'Wing Boots', cost: 7, effects: [], uses: 3,
  rule: 'Ignore paths when moving up to the next room; after 3 uses discard this relic.',
  text: 'Ignore paths when moving up to the next room. Use 3 times, then discard.' })

/** The 58-card physical ordinary relic deck, in component-list order. */
export const RELIC_DECK: readonly string[] = Object.freeze([
  'akabeko', 'anchor', 'bag_of_preparation', 'bird_faced_urn', 'blood_vial', 'blue_candle',
  'calipers', 'captains_wheel', 'centennial_puzzle', 'charons_ashes', 'dead_branch',
  'dollys_mirror', 'duality', 'du_vu_doll', 'gambling_chip', 'golden_eye', 'golden_idol',
  'gremlin_horn', 'happy_flower', 'horn_cleat', 'ice_cream', 'incense_burner', 'ink_bottle',
  'lantern', 'meat_on_the_bone', 'mercury_hourglass', 'molten_egg', 'mummified_hand',
  'mutagen', 'necronomicon', 'nilrys_codex', 'ninja_scroll', 'oddly_smooth_stone',
  'old_coin', 'omamori', 'orichalcum', 'peace_pipe', 'pen_nib', 'pocketwatch', 'red_mask',
  'red_skull', 'regal_pillow', 'runic_pyramid', 'self_forming_clay', 'ssserpent_head',
  'stone_calendar', 'strike_dummy', 'sundial', 'the_abacus', 'the_boot', 'the_courier',
  'toolbox', 'toxic_egg', 'tungsten_rod', 'vajra', 'war_paint', 'whetstone', 'wing_boots',
])

boss({ id: 'astrolabe', name: 'Astrolabe', effects: [],
  rule: 'Upgrade 3 cards, then discard this relic.',
  text: 'Upgrade 3 cards. Use immediately, then discard.' })
boss({ id: 'black_blood', name: 'Black Blood', trigger: { kind: 'endOfCombat' },
  effects: [{ kind: 'heal', amount: 2 }], text: 'End of combat: heal 2 HP.' })
boss({ id: 'calling_bell', name: 'Calling Bell', effects: [],
  rule: 'Gain 3 ordinary relics and a Curse, then discard this relic.',
  text: 'Gain 3 Relics and a Curse. Use immediately, then discard.' })
boss({ id: 'coffee_dripper', name: 'Coffee Dripper', trigger: { kind: 'startOfTurn' },
  effects: [{ kind: 'gainEnergy', amount: 1 }], rule: 'You cannot Rest.',
  text: 'Start of turn: gain 1 Energy. You cannot Rest.' })
boss({ id: 'cursed_key', name: 'Cursed Key', trigger: { kind: 'startOfTurn' },
  effects: [{ kind: 'gainEnergy', amount: 1 }], rule: 'When obtained, gain 2 Curses.',
  text: 'Start of turn: gain 1 Energy. When obtained, gain 2 Curses.' })
boss({ id: 'ectoplasm', name: 'Ectoplasm', trigger: { kind: 'startOfTurn' },
  effects: [{ kind: 'gainEnergy', amount: 1 }], rule: 'You cannot gain gold.',
  text: 'Start of turn: gain 1 Energy. You cannot gain gold.' })
boss({ id: 'empty_cage', name: 'Empty Cage', effects: [],
  rule: 'Remove 2 cards, then discard this relic.', text: 'Remove 2 cards. Use immediately, then discard.' })
boss({ id: 'enchiridion', name: 'Enchiridion', effects: [],
  rule: 'Gain a rare card reward, looking at 5 cards instead of 3, then discard this relic.',
  text: 'Gain a rare card reward. Look at 5 cards instead of 3. Use immediately, then discard.' })
boss({ id: 'frozen_core', name: 'Frozen Core', trigger: { kind: 'endOfTurn' },
  effects: [{ kind: 'block', amount: 1 }], text: 'End of turn: gain 1 Block.' })
boss({ id: 'fusion_hammer', name: 'Fusion Hammer', trigger: { kind: 'startOfTurn' },
  effects: [{ kind: 'gainEnergy', amount: 1 }], rule: 'You cannot Smith.',
  text: 'Start of turn: gain 1 Energy. You cannot Smith.' })
boss({ id: 'holy_water', name: 'Holy Water', trigger: { kind: 'startOfCombat' }, effects: [], cubes: 2,
  rule: 'Add 2 cubes at start of combat. Remove a cube to gain 1 Energy.',
  text: 'Start of combat: add 2 cubes. Remove a cube: gain 1 Energy.' })
boss({ id: 'mark_of_pain', name: 'Mark of Pain', trigger: { kind: 'startOfTurn' },
  effects: [{ kind: 'gainEnergy', amount: 1 }], rule: 'If your HP would go above 6, it becomes 6.',
  text: 'Start of turn: gain 1 Energy. If your HP would go above 6, it becomes 6.' })
boss({ id: 'orrery', name: 'Orrery', effects: [],
  rule: 'Gain 4 card rewards, then discard this relic.',
  text: 'Gain 4 card rewards. Use immediately, then discard.' })
boss({ id: 'pandoras_box', name: "Pandora's Box", effects: [],
  rule: 'Transform 3 cards, then discard this relic.',
  text: 'Transform 3 cards. Use immediately, then discard.' })
boss({ id: 'ring_of_serpent', name: 'Ring of Serpent', trigger: { kind: 'startOfTurn' },
  effects: [{ kind: 'draw', amount: 1 }], text: 'Start of turn: draw a card.' })
boss({ id: 'snecko_eye', name: 'Snecko Eye',
  trigger: { kind: 'dieRelic', faces: [1, 2] }, effects: [{ kind: 'draw', amount: 2 }],
  abilities: [{ trigger: { kind: 'dieRelic', faces: [3, 4] }, effects: [{ kind: 'gainEnergy', amount: 1 }] }],
  rule: 'On a 5 or 6, gain the printed Snecko effect.',
  text: 'On a 1 or 2: draw 2. On a 3 or 4: gain 1 Energy. On a 5 or 6: gain Snecko.' })
boss({ id: 'sozu', name: 'Sozu', trigger: { kind: 'startOfTurn' },
  effects: [{ kind: 'gainEnergy', amount: 1 }], rule: 'You cannot gain Potions.',
  text: 'Start of turn: gain 1 Energy. You cannot gain Potions.' })
boss({ id: 'tiny_house', name: 'Tiny House', effects: [],
  rule: 'Gain a card reward, Potion, 3 gold, and upgrade a card; then discard this relic.',
  text: 'Gain a card reward, a Potion, 3 gold, and upgrade a card. Use immediately, then discard.' })
boss({ id: 'white_beast_statue', name: 'White Beast Statue', effects: [],
  rule: 'At end of combat, gain a Potion.', text: 'End of combat: gain a Potion.' })
boss({ id: 'wrist_blade', name: 'Wrist Blade', effects: [],
  rule: 'Each hit of a 0-cost Attack, including a Shiv, deals +1 damage.',
  text: 'Your 0-cost Attacks deal +1 damage on each hit, including Shivs.' })

RELICS.loaded_die = {
  id: 'loaded_die',
  name: 'Loaded Die',
  pool: 'solo',
  trigger: { kind: 'dieRelic', faces: [6] },
  effects: [{ kind: 'gainEnergy', amount: 1 }],
  rule: 'Instead of its own Energy ability, trigger a die relic ability on another relic; its owner gains the effect.',
  text: 'Solo only. On a 6: gain 1 Energy or trigger a die relic ability on another relic.',
}

/** All automatic faces of a relic, in their printed order. */
export function relicAbilities(def: RelicDef): { trigger: RelicTrigger; effects: Effect[]; target?: TargetScope; supportTarget?: TargetScope }[] {
  return [
    ...(def.trigger ? [{ trigger: def.trigger, effects: def.effects, target: def.target, supportTarget: def.supportTarget }] : []),
    ...(def.abilities ?? []),
  ]
}

export const ORDINARY_RELIC_IDS = Object.freeze(Object.values(RELICS)
  .filter((def) => def.pool === 'ordinary').map((def) => def.id))
export const BOSS_RELIC_IDS = Object.freeze(Object.values(RELICS)
  .filter((def) => def.pool === 'boss').map((def) => def.id))

/** Setup uses two independently shuffled, server-owned decks (rulebook p.4). */
export function createRelicDecks(rng: RngState): { relicDeck: string[]; bossRelicDeck: string[] } {
  return {
    relicDeck: shuffle(rng, [...ORDINARY_RELIC_IDS]),
    bossRelicDeck: shuffle(rng, [...BOSS_RELIC_IDS]),
  }
}

export type RelicOffer = { choices: string[]; deck: string[] }

/** Reveal from the top without leaking the remaining deck to a client payload. */
export function revealRelics(deck: readonly string[], count: number): RelicOffer {
  const size = Math.max(0, Math.min(deck.length, Math.floor(count)))
  return { choices: deck.slice(0, size), deck: deck.slice(size) }
}

/** Gain chosen cards and put every skipped/unused reveal on the bottom (p.8). */
export function resolveRelicOffer(offer: RelicOffer, gained: readonly string[]): { gained: string[]; deck: string[] } | undefined {
  if (new Set(gained).size !== gained.length || gained.some((id) => !offer.choices.includes(id))) return undefined
  const chosen = new Set(gained)
  return { gained: [...gained], deck: [...offer.deck, ...offer.choices.filter((id) => !chosen.has(id))] }
}

/** Boss reward reveal is players + 1, except solo always reveals 3 (p.8). */
export function bossRelicOfferSize(playerCount: number): number {
  return playerCount === 1 ? 3 : Math.max(0, Math.floor(playerCount)) + 1
}

/** Central constructor keeps finite-use state deterministic and reconnect-safe. */
export function createRelicInstance(defId: string): RelicInstance {
  const def = relicDef(defId)
  return {
    defId,
    spent: false,
    uses: def.uses,
    cubes: def.cubes,
    pending: [
      'war_paint', 'whetstone', 'astrolabe', 'empty_cage', 'enchiridion',
      'orrery', 'pandoras_box', 'tiny_house',
    ].includes(defId) || undefined,
  }
}

export function relicDef(id: string): RelicDef {
  const def = RELICS[id]
  if (!def) throw new Error(`unknown relic id: ${id}`)
  return def
}

/** The relic every character starts a run with (p.4). */
export const STARTING_RELIC: Record<string, string> = {
  ironclad: 'burning_blood',
  silent: 'ring_of_the_snake',
  defect: 'cracked_core',
  watcher: 'pure_water',
}

export type PotionDef = {
  id: string
  name: string
  effects: Effect[]
  /** Copies in the physical 29-card potion deck. */
  quantity: 1 | 2
  /** Printed Merchant cost, when this potion has one. */
  cost?: 2 | 3 | 4
  /** A potion may target one enemy or select a numbered board row directly. */
  target?: Extract<TargetScope, 'enemy' | 'row'>
  /** Where a supportive potion may land. */
  supportTarget?: TargetScope
  text: string
}

export const POTIONS: Record<string, PotionDef> = {
  ancient_potion: {
    id: 'ancient_potion',
    name: 'Ancient Potion',
    effects: [{ kind: 'clearDebuffs' }],
    quantity: 1,
    cost: 2,
    text: 'Remove all Weak and Vulnerable from your character.',
  },
  block_potion: {
    id: 'block_potion',
    name: 'Block Potion',
    effects: [{ kind: 'block', amount: 2, toChosen: true }],
    quantity: 2,
    cost: 2,
    supportTarget: 'anyPlayer',
    text: '2 Block to any player.',
  },
  fire_potion: {
    id: 'fire_potion',
    name: 'Fire Potion',
    effects: [{ kind: 'damage', amount: 4 }],
    quantity: 2,
    cost: 2,
    target: 'enemy',
    text: 'Deal 4 damage.',
  },
  cunning_potion: {
    id: 'cunning_potion',
    name: 'Cunning Potion',
    effects: [{ kind: 'gainShiv', amount: 3 }],
    quantity: 1,
    cost: 3,
    text: 'Gain 3 Shivs. Treat each Shiv as a separate 0 cost Attack.',
  },
  energy_potion: {
    id: 'energy_potion',
    name: 'Energy Potion',
    effects: [{ kind: 'gainEnergy', amount: 2 }],
    quantity: 2,
    cost: 2,
    text: 'Gain 2 Energy.',
  },
  swift_potion: {
    id: 'swift_potion',
    name: 'Swift Potion',
    effects: [{ kind: 'draw', amount: 3 }],
    quantity: 2,
    cost: 2,
    text: 'Draw 3 cards.',
  },
  blood_potion: {
    id: 'blood_potion',
    name: 'Blood Potion',
    effects: [{ kind: 'heal', amount: 2 }],
    quantity: 1,
    cost: 3,
    text: 'Heal 2 HP.',
  },
  weak_potion: {
    id: 'weak_potion',
    name: 'Weak Potion',
    effects: [{ kind: 'applyWeak', amount: 2 }],
    quantity: 2,
    cost: 2,
    target: 'enemy',
    text: 'Apply 2 Weak.',
  },
  vulnerable_potion: {
    id: 'vulnerable_potion',
    name: 'Vulnerable Potion',
    effects: [{ kind: 'applyVulnerable', amount: 1 }],
    quantity: 2,
    cost: 2,
    target: 'enemy',
    text: 'Apply 1 Vulnerable.',
  },
  flex_potion: {
    id: 'flex_potion',
    name: 'Flex Potion',
    effects: [{ kind: 'gainTemporaryStrength', amount: 1 }],
    quantity: 2,
    cost: 2,
    text: 'Gain 1 Strength. Lose 1 Strength at end of turn.',
  },
  explosive_potion: {
    id: 'explosive_potion',
    name: 'Explosive Potion',
    effects: [{ kind: 'damage', amount: 2 }],
    quantity: 2,
    cost: 2,
    target: 'row',
    text: 'Deal 2 damage to any row.',
  },
  snecko_oil: {
    id: 'snecko_oil',
    name: 'Snecko Oil',
    effects: [{ kind: 'draw', amount: 5 }, { kind: 'addDaze', amount: 2, pile: 'draw' }],
    quantity: 1,
    cost: 3,
    text: 'Draw 5 cards. Gain 2 Daze.',
  },
  attack_potion: {
    id: 'attack_potion', name: 'Attack Potion', quantity: 1, cost: 2,
    effects: [{ kind: 'doubleNextAttack' }],
    text: 'The next Attack you play is played twice.',
  },
  distilled_chaos: {
    id: 'distilled_chaos', name: 'Distilled Chaos', quantity: 1, cost: 3,
    effects: [],
    text: 'Draw 3 cards. Play them immediately in any order for 0 Energy.',
  },
  entropic_brew: {
    id: 'entropic_brew', name: 'Entropic Brew', quantity: 1, cost: 3,
    effects: [],
    text: 'Gain 2 Potions.',
  },
  fairy_in_a_bottle: {
    id: 'fairy_in_a_bottle', name: 'Fairy in a Bottle', quantity: 1, cost: 3,
    effects: [],
    text: 'When your HP becomes 0, instead set your HP to 2 and discard this Potion.',
  },
  gamblers_brew: {
    id: 'gamblers_brew', name: "Gambler's Brew", quantity: 1, cost: 3,
    effects: [],
    text: 'Change the die to any number before accepting the roll.',
  },
  ghost_in_a_jar: {
    id: 'ghost_in_a_jar', name: 'Ghost in a Jar', quantity: 1, cost: 4,
    effects: [{ kind: 'limitRoundHpLoss', amount: 1 }],
    text: "You can't lose more than 1 HP this turn.",
  },
  liquid_memories: {
    id: 'liquid_memories', name: 'Liquid Memories', quantity: 1, cost: 3,
    effects: [{ kind: 'recoverDiscard', amount: 1, toHand: true }],
    text: 'Return a card from your discard pile to your hand. It costs 0 this turn.',
  },
  purity_potion: {
    id: 'purity_potion', name: 'Purity Potion', quantity: 1, cost: 2,
    effects: [{ kind: 'exhaustAny', amount: 3 }],
    text: 'Exhaust up to 3 cards from your hand.',
  },
  skill_potion: {
    id: 'skill_potion', name: 'Skill Potion', quantity: 1, cost: 2,
    effects: [{ kind: 'doubleNextSkill' }],
    text: 'The next Skill you play is played twice.',
  },
}

/** One entry per physical card; shuffle once, then return every used card to the bottom. */
export const POTION_DECK: string[] = [
  'ancient_potion', 'attack_potion', 'block_potion', 'block_potion', 'blood_potion',
  'cunning_potion', 'distilled_chaos', 'energy_potion', 'energy_potion', 'entropic_brew',
  'explosive_potion', 'explosive_potion', 'fairy_in_a_bottle', 'fire_potion', 'fire_potion',
  'flex_potion', 'flex_potion', 'gamblers_brew', 'ghost_in_a_jar', 'liquid_memories',
  'purity_potion', 'skill_potion', 'snecko_oil', 'swift_potion', 'swift_potion',
  'vulnerable_potion', 'vulnerable_potion', 'weak_potion', 'weak_potion',
]

export function potionDef(id: string): PotionDef {
  const def = POTIONS[id]
  if (!def) throw new Error(`unknown potion id: ${id}`)
  return def
}
