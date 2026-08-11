// Relics and potions.
//
// A relic is a permanent, always-on effect; a potion is single-use. Both are
// modelled as triggers rather than as code so the campaign can hold them as
// plain data alongside everything else.
import type { Effect, TargetScope } from './cards.ts'
import type { Trigger } from './triggers.ts'

/** Relics and Powers share one trigger vocabulary; see triggers.ts. */
export type RelicTrigger = Trigger

export type RelicAbility = {
  trigger: RelicTrigger
  effects: Effect[]
  target?: TargetScope
  supportTarget?: TargetScope
  whenDrawOwner?: string
}

export type RelicDef = {
  id: string
  name: string
  /** Boss relics come with a drawback and are handed out after an Act. */
  boss?: boolean
  /** Gold cost at the Merchant; absent means it is not for sale. */
  cost?: number
  trigger?: RelicTrigger
  effects: Effect[]
  target?: TargetScope
  supportTarget?: TargetScope
  whenDrawOwner?: string
  abilities?: RelicAbility[]
  oncePerCombat?: boolean
  /** Prose for the UI. The effects above are what actually resolve. */
  text: string
}

export const RELICS: Record<string, RelicDef> = {
  burning_blood: {
    id: 'burning_blood',
    name: 'Burning Blood',
    trigger: { kind: 'endOfCombat' },
    effects: [{ kind: 'heal', amount: 1 }],
    text: 'End of combat: heal 1 HP.',
  },
  ring_of_the_snake: {
    id: 'ring_of_the_snake',
    name: 'Ring of the Snake',
    trigger: { kind: 'startOfCombat' },
    effects: [{ kind: 'draw', amount: 2 }],
    text: 'Start of combat: draw 2 cards.',
  },
  cracked_core: {
    id: 'cracked_core',
    name: 'Cracked Core',
    trigger: { kind: 'startOfCombat' },
    effects: [{ kind: 'channel', orb: 'lightning', amount: 1 }],
    text: 'Start of combat: channel 1 Lightning.',
  },
  pure_water: {
    id: 'pure_water',
    name: 'Pure Water',
    trigger: { kind: 'startOfCombat' },
    effects: [{ kind: 'gainMiracle', amount: 1 }],
    text: 'Start of combat: gain 1 Miracle.',
  },
  astrolabe: { id: 'astrolabe', name: 'Astrolabe', boss: true, effects: [], text: 'Upgrade 3 cards. Use this immediately, then discard it.' },
  black_blood: { id: 'black_blood', name: 'Black Blood', boss: true, trigger: { kind: 'endOfCombat' }, effects: [{ kind: 'heal', amount: 2 }], text: 'End of combat: heal 2 HP.' },
  calling_bell: { id: 'calling_bell', name: 'Calling Bell', boss: true, effects: [], text: 'Gain 3 relics. Gain a Curse. Use this immediately, then discard it.' },
  coffee_dripper: { id: 'coffee_dripper', name: 'Coffee Dripper', boss: true, trigger: { kind: 'startOfTurn' }, effects: [{ kind: 'gainEnergy', amount: 1 }], text: "Start of turn: gain 1 Energy. At a Campfire, you can't Rest." },
  cursed_key: { id: 'cursed_key', name: 'Cursed Key', boss: true, trigger: { kind: 'startOfTurn' }, effects: [{ kind: 'gainEnergy', amount: 1 }], text: 'Start of turn: gain 1 Energy. When obtained, gain 2 Curses.' },
  ectoplasm: { id: 'ectoplasm', name: 'Ectoplasm', boss: true, trigger: { kind: 'startOfTurn' }, effects: [{ kind: 'gainEnergy', amount: 1 }], text: "Start of turn: gain 1 Energy. You can't gain Gold." },
  empty_cage: { id: 'empty_cage', name: 'Empty Cage', boss: true, effects: [], text: 'Remove 2 cards. Use this immediately, then discard it.' },
  enchiridion: { id: 'enchiridion', name: 'Enchiridion', boss: true, effects: [], text: 'Gain a rare card reward. Look at 5 cards instead of 3. Use this immediately, then discard it.' },
  frozen_core: { id: 'frozen_core', name: 'Frozen Core', boss: true, trigger: { kind: 'endOfTurn' }, effects: [{ kind: 'block', amount: 1 }], text: 'End of turn: gain 1 Block.' },
  fusion_hammer: { id: 'fusion_hammer', name: 'Fusion Hammer', boss: true, trigger: { kind: 'startOfTurn' }, effects: [{ kind: 'gainEnergy', amount: 1 }], text: "Start of turn: gain 1 Energy. At a Campfire, you can't Smith." },
  holy_water: { id: 'holy_water', name: 'Holy Water', boss: true, effects: [], text: 'Start of combat: add 2 cubes. Remove a cube: gain 1 Energy.' },
  mark_of_pain: { id: 'mark_of_pain', name: 'Mark of Pain', boss: true, trigger: { kind: 'startOfTurn' }, effects: [{ kind: 'gainEnergy', amount: 1 }], text: 'Start of turn: gain 1 Energy. If your HP would go above 6, it becomes 6.' },
  orrery: { id: 'orrery', name: 'Orrery', boss: true, effects: [], text: 'Gain 4 card rewards. Use this immediately, then discard it.' },
  pandoras_box: { id: 'pandoras_box', name: "Pandora's Box", boss: true, effects: [], text: 'Transform 3 cards. Use this immediately, then discard it.' },
  ring_of_the_serpent: { id: 'ring_of_the_serpent', name: 'Ring of the Serpent', boss: true, trigger: { kind: 'startOfTurn' }, effects: [{ kind: 'draw', amount: 1 }], text: 'Start of turn: draw a card.' },
  snecko_eye: {
    id: 'snecko_eye', name: 'Snecko Eye', boss: true, effects: [],
    abilities: [
      { trigger: { kind: 'dieRelic', faces: [1, 2] }, effects: [{ kind: 'draw', amount: 2 }] },
      { trigger: { kind: 'dieRelic', faces: [3, 4] }, effects: [{ kind: 'gainEnergy', amount: 1 }] },
      { trigger: { kind: 'dieRelic', faces: [5, 6] }, effects: [{ kind: 'setNextCardCost', amount: 3 }] },
    ],
    text: 'On a 1 or 2: draw 2 cards. On a 3 or 4: gain 1 Energy. On a 5 or 6: gain Confusion.',
  },
  sozu: { id: 'sozu', name: 'Sozu', boss: true, trigger: { kind: 'startOfTurn' }, effects: [{ kind: 'gainEnergy', amount: 1 }], text: "Start of turn: gain 1 Energy. You can't gain potions." },
  tiny_house: { id: 'tiny_house', name: 'Tiny House', boss: true, effects: [], text: 'Gain a card reward, a potion, and 3 Gold. Upgrade a card. Use this immediately, then discard it.' },
  white_beast_statue: { id: 'white_beast_statue', name: 'White Beast Statue', boss: true, trigger: { kind: 'endOfCombat' }, effects: [], text: 'End of combat: gain a potion.' },
  wrist_blade: { id: 'wrist_blade', name: 'Wrist Blade', boss: true, effects: [], text: 'Your 0-cost Attacks deal +1 damage on each hit, including Shivs.' },
  anchor: {
    id: 'anchor',
    name: 'Anchor',
    cost: 5,
    trigger: { kind: 'startOfCombat' },
    effects: [{ kind: 'block', amount: 2 }],
    text: 'Start of combat: gain 2 Block.',
  },
  happy_flower: {
    id: 'happy_flower',
    name: 'Happy Flower',
    cost: 6,
    trigger: { kind: 'dieRelic', faces: [3, 4] },
    effects: [{ kind: 'gainEnergy', amount: 1 }],
    text: 'On a 3 or 4: gain 1 Energy.',
  },
  bag_of_preparation: {
    id: 'bag_of_preparation', name: 'Bag of Preparation', trigger: { kind: 'startOfCombat' },
    effects: [{ kind: 'draw', amount: 2 }], text: 'Start of combat: draw 2 cards.',
  },
  bird_faced_urn: {
    id: 'bird_faced_urn', name: 'Bird-Faced Urn', trigger: { kind: 'onPlayCard', cardType: 'power' },
    effects: [{ kind: 'block', amount: 1 }], text: 'When you play a Power: gain 1 Block.',
  },
  blood_vial: {
    id: 'blood_vial', name: 'Blood Vial', trigger: { kind: 'startOfCombat' },
    effects: [{ kind: 'heal', amount: 1 }], text: 'Start of combat: heal 1 HP.',
  },
  blue_candle: { id: 'blue_candle', name: 'Blue Candle', effects: [], text: 'Once per combat: Exhaust up to 2 cards in your hand.' },
  calipers: { id: 'calipers', name: 'Calipers', effects: [], text: 'Once per combat: keep your leftover Block from last turn.' },
  captains_wheel: {
    id: 'captains_wheel', name: "Captain's Wheel", trigger: { kind: 'dieRelic', faces: [3] },
    effects: [{ kind: 'block', amount: 3 }], text: 'On a 3: gain 3 Block.',
  },
  centennial_puzzle: { id: 'centennial_puzzle', name: 'Centennial Puzzle', effects: [], text: 'Once per combat: draw 3 cards if you lost HP this combat.' },
  charons_ashes: { id: 'charons_ashes', name: "Charon's Ashes", effects: [], text: 'You may Exhaust a card to deal 2 damage.' },
  dead_branch: { id: 'dead_branch', name: 'Dead Branch', effects: [], text: 'Once per combat: draw a card for each card in your Exhaust pile.' },
  dollys_mirror: { id: 'dollys_mirror', name: "Dolly's Mirror", effects: [], text: 'Trigger a die relic ability. Its owner gains the effect.' },
  duality: {
    id: 'duality', name: 'Duality', effects: [], text: 'On a 2: gain 2 Block. On a 4: deal 2 damage.',
    abilities: [
      { trigger: { kind: 'dieRelic', faces: [2] }, effects: [{ kind: 'block', amount: 2 }] },
      { trigger: { kind: 'dieRelic', faces: [4] }, effects: [{ kind: 'damage', amount: 2 }], target: 'enemy' },
    ],
  },
  du_vu_doll: {
    id: 'du_vu_doll', name: 'Du-Vu Doll', trigger: { kind: 'onDraw' }, whenDrawOwner: 'curse',
    effects: [{ kind: 'gainTemporaryStrength', amount: 1 }],
    text: 'When you draw a Curse, gain 1 Strength this turn.',
  },
  gambling_chip: { id: 'gambling_chip', name: 'Gambling Chip', effects: [], text: 'Once per room: reroll the die.' },
  golden_eye: { id: 'golden_eye', name: 'Golden Eye', effects: [], text: 'Once per combat: Scry 3.' },
  golden_idol: {
    id: 'golden_idol', name: 'Golden Idol', trigger: { kind: 'endOfCombat' },
    effects: [{ kind: 'gainGold', amount: 1 }], text: 'End of combat: gain 1 Gold.',
  },
  gremlin_horn: {
    id: 'gremlin_horn', name: 'Gremlin Horn', effects: [], text: 'On a 4: draw a card. On a 5: gain 1 Energy.',
    abilities: [
      { trigger: { kind: 'dieRelic', faces: [4] }, effects: [{ kind: 'draw', amount: 1 }] },
      { trigger: { kind: 'dieRelic', faces: [5] }, effects: [{ kind: 'gainEnergy', amount: 1 }] },
    ],
  },
  horn_cleat: {
    id: 'horn_cleat', name: 'Horn Cleat', trigger: { kind: 'dieRelic', faces: [1, 2] },
    effects: [{ kind: 'block', amount: 1 }], text: 'On a 1 or 2: gain 1 Block.',
  },
  ice_cream: { id: 'ice_cream', name: 'Ice Cream', effects: [], text: 'Start of turn: gain your leftover Energy from last turn. Maximum Energy is 6.' },
  incense_burner: {
    id: 'incense_burner', name: 'Incense Burner', trigger: { kind: 'dieRelic', faces: [6] },
    effects: [{ kind: 'setHpLossLimit', amount: 1 }], text: 'On a 6: you cannot lose more than 1 HP this round.',
  },
  ink_bottle: {
    id: 'ink_bottle', name: 'Ink Bottle', trigger: { kind: 'dieRelic', faces: [5, 6] },
    effects: [{ kind: 'draw', amount: 1 }], text: 'On a 5 or 6: draw a card.',
  },
  lantern: {
    id: 'lantern', name: 'Lantern', trigger: { kind: 'startOfCombat' },
    effects: [{ kind: 'gainEnergy', amount: 1 }], text: 'Start of combat: gain 1 Energy.',
  },
  meat_on_the_bone: {
    id: 'meat_on_the_bone', name: 'Meat on the Bone', trigger: { kind: 'endOfCombat' },
    effects: [{ kind: 'setHpAtLeast', amount: 4 }], text: 'End of combat: if below 4 HP, set HP to 4.',
  },
  mercury_hourglass: {
    id: 'mercury_hourglass', name: 'Mercury Hourglass', trigger: { kind: 'dieRelic', faces: [1, 2] },
    effects: [{ kind: 'damage', amount: 1 }], target: 'row', text: 'On a 1 or 2: deal 1 damage to any row.',
  },
  molten_egg: { id: 'molten_egg', name: 'Molten Egg', effects: [], text: 'When you add an Attack to your deck, upgrade it. Use 3 times, then discard.' },
  mummified_hand: { id: 'mummified_hand', name: 'Mummified Hand', effects: [], text: 'Once per combat: gain 2 Energy if you played a Power this turn.' },
  mutagen: {
    id: 'mutagen', name: 'Mutagenic Strength', trigger: { kind: 'startOfCombat' },
    effects: [{ kind: 'gainTemporaryStrength', amount: 1 }], text: 'Start of combat: gain 1 Strength; lose it at end of turn.',
  },
  necronomicon: {
    id: 'necronomicon', name: 'Necronomicon', trigger: { kind: 'dieRelic', faces: [1] },
    effects: [{ kind: 'queueCardCopy', cardType: 'attack' }], text: 'On a 1: your next Attack this turn is played twice.',
  },
  nilrys_codex: { id: 'nilrys_codex', name: "Nilry's Codex", effects: [], text: 'On a 4: draw a card. On a 5: trigger a die relic ability; its owner gains the effect.' },
  ninja_scroll: { id: 'ninja_scroll', name: 'Ninja Scroll', effects: [], text: 'Once per combat: gain 3 Shivs. Treat each Shiv as a separate 0 cost Attack.' },
  oddly_smooth_stone: {
    id: 'oddly_smooth_stone', name: 'Oddly Smooth Stone', trigger: { kind: 'dieRelic', faces: [4] },
    effects: [{ kind: 'block', amount: 2, toChosen: true }], supportTarget: 'anyPlayer',
    text: 'On a 4: 2 Block to any player.',
  },
  old_coin: { id: 'old_coin', name: 'Old Coin', effects: [], text: 'Gain 10 Gold, then discard this relic. At a Merchant or The Courier, discard it and draw again.' },
  omamori: { id: 'omamori', name: 'Omamori', effects: [], text: "You can't gain Curses." },
  orichalcum: {
    id: 'orichalcum', name: 'Orichalcum', trigger: { kind: 'endOfTurn' },
    effects: [{ kind: 'blockIfNone', amount: 1 }], text: 'End of turn: gain 1 Block if you have none.',
  },
  peace_pipe: { id: 'peace_pipe', name: 'Peace Pipe', effects: [], text: 'When you Rest: you may also remove a card.' },
  pen_nib: {
    id: 'pen_nib', name: 'Pen Nib', trigger: { kind: 'dieRelic', faces: [5] },
    effects: [{ kind: 'applyVulnerable', amount: 1 }], text: 'On a 5: apply 1 Vulnerable.',
  },
  pocketwatch: {
    id: 'pocketwatch', name: 'Pocketwatch', trigger: { kind: 'dieRelic', faces: [3] },
    effects: [{ kind: 'draw', amount: 3 }], text: 'On a 3: draw 3 cards.',
  },
  red_mask: {
    id: 'red_mask', name: 'Red Mask', trigger: { kind: 'dieRelic', faces: [5, 6] },
    effects: [{ kind: 'applyWeak', amount: 1 }], text: 'On a 5 or 6: apply 1 Weak.',
  },
  red_skull: { id: 'red_skull', name: 'Red Skull', trigger: { kind: 'onShuffle' }, effects: [{ kind: 'gainStrength', amount: 1 }], oncePerCombat: true, text: 'Once per combat: gain 1 Strength if you shuffled your draw pile this combat.' },
  regal_pillow: { id: 'regal_pillow', name: 'Regal Pillow', effects: [], text: 'When you Rest: heal 3 additional HP.' },
  runic_pyramid: { id: 'runic_pyramid', name: 'Runic Pyramid', effects: [], text: 'Once per combat: Retain any number of cards this turn.' },
  self_forming_clay: { id: 'self_forming_clay', name: 'Self-Forming Clay', effects: [], text: 'Once per combat: gain 3 Block if you lost HP this combat.' },
  ssserpent_head: { id: 'ssserpent_head', name: 'Ssserpent Head', effects: [], text: 'On a 6: gain 1 Gold when you enter the room.' },
  stone_calendar: {
    id: 'stone_calendar', name: 'Stone Calendar', trigger: { kind: 'dieRelic', faces: [4] },
    effects: [{ kind: 'damage', amount: 4 }], text: 'On a 4: deal 4 damage.',
  },
  strike_dummy: { id: 'strike_dummy', name: 'Strike Dummy', effects: [], text: 'When you play a starter Strike, it deals 1 additional damage.' },
  sundial: {
    id: 'sundial', name: 'Sundial', trigger: { kind: 'dieRelic', faces: [2] },
    effects: [{ kind: 'gainEnergy', amount: 2 }], text: 'On a 2: gain 2 Energy.',
  },
  the_abacus: { id: 'the_abacus', name: 'The Abacus', effects: [], text: 'Once per room: add 1 to the die result; 6 becomes 1.' },
  the_boot: {
    id: 'the_boot', name: 'The Boot', trigger: { kind: 'dieRelic', faces: [4, 5, 6] },
    effects: [{ kind: 'damage', amount: 1 }], text: 'On a 4, 5, or 6: deal 1 damage.',
  },
  the_courier: { id: 'the_courier', name: 'The Courier', effects: [], text: 'Once per combat: look at the top card of the relic or potion deck. Buy it or discard it.' },
  toolbox: { id: 'toolbox', name: 'Toolbox', effects: [], text: 'Once per room: subtract 1 from the die result; 1 becomes 6.' },
  toxic_egg: { id: 'toxic_egg', name: 'Toxic Egg', effects: [], text: 'When you add a Skill to your deck, upgrade it. Use 3 times, then discard.' },
  tungsten_rod: {
    id: 'tungsten_rod', name: 'Tungsten Rod', trigger: { kind: 'dieRelic', faces: [5] },
    effects: [{ kind: 'blockAllPlayers', amount: 1, soloAmount: 3 }],
    text: 'On a 5: 1 Block to all players; 3 Block instead in solo.',
  },
  vajra: {
    id: 'vajra', name: 'Vajra', trigger: { kind: 'dieRelic', faces: [2] },
    effects: [{ kind: 'gainTemporaryStrength', amount: 1 }], text: 'On a 2: gain 1 Strength this turn.',
  },
  war_paint: { id: 'war_paint', name: 'War Paint', effects: [], text: 'Upgrade a starter Defend and another Skill, then discard this item. Cannot be used in combat.' },
  whetstone: { id: 'whetstone', name: 'Whetstone', effects: [], text: 'Upgrade a starter Strike and another Attack, then discard this item. Cannot be used in combat.' },
  wing_boots: { id: 'wing_boots', name: 'Wing Boots', effects: [], text: 'You may ignore paths when moving to the next room. Use 3 times, then discard.' },
  akabeko: {
    id: 'akabeko',
    name: 'Akabeko',
    cost: 5,
    effects: [],
    text: 'Once per combat: gain 3 Strength for one Attack.',
  },
  bag_of_marbles: {
    id: 'bag_of_marbles',
    name: 'Bag of Marbles',
    cost: 5,
    trigger: { kind: 'startOfCombat' },
    effects: [{ kind: 'applyVulnerable', amount: 1 }],
    text: 'Start of combat: apply 1 Vulnerable to an enemy.',
  },
}

/**
 * The solo relic (p.4 step 12). Its full text also lets it re-trigger a die
 * relic ability on another relic, which needs a trigger system; only the
 * energy is modelled today.
 */
RELICS.loaded_die = {
  id: 'loaded_die',
  name: 'Loaded Die',
  trigger: { kind: 'dieRelic', faces: [6] },
  effects: [{ kind: 'gainEnergy', amount: 1 }],
  text: 'Solo only. On a 6: trigger a die relic ability.',
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
  /** A potion may target one enemy or select a numbered board row directly. */
  target?: Extract<TargetScope, 'enemy' | 'row'>
  /** Where a supportive potion may land. */
  supportTarget?: TargetScope
  special?: 'doubleAttack' | 'distilledChaos' | 'entropicBrew' | 'fairy'
    | 'changeDie' | 'hpLossLimit' | 'liquidMemories' | 'purity' | 'doubleSkill'
  text: string
}

export const POTIONS: Record<string, PotionDef> = {
  ancient_potion: {
    id: 'ancient_potion',
    name: 'Ancient Potion',
    effects: [{ kind: 'clearDebuffs' }],
    text: 'Remove all Weak and Vulnerable from your character.',
  },
  block_potion: {
    id: 'block_potion',
    name: 'Block Potion',
    effects: [{ kind: 'block', amount: 2, toChosen: true }],
    supportTarget: 'anyPlayer',
    text: '2 Block to any player.',
  },
  fire_potion: {
    id: 'fire_potion',
    name: 'Fire Potion',
    effects: [{ kind: 'damage', amount: 4 }],
    target: 'enemy',
    text: 'Deal 4 damage.',
  },
  cunning_potion: {
    id: 'cunning_potion',
    name: 'Cunning Potion',
    effects: [{ kind: 'gainShiv', amount: 3 }],
    text: 'Gain 3 Shivs. Treat each Shiv as a separate 0 cost Attack.',
  },
  energy_potion: {
    id: 'energy_potion',
    name: 'Energy Potion',
    effects: [{ kind: 'gainEnergy', amount: 2 }],
    text: 'Gain 2 Energy.',
  },
  swift_potion: {
    id: 'swift_potion',
    name: 'Swift Potion',
    effects: [{ kind: 'draw', amount: 3 }],
    text: 'Draw 3 cards.',
  },
  blood_potion: {
    id: 'blood_potion',
    name: 'Blood Potion',
    effects: [{ kind: 'heal', amount: 2 }],
    text: 'Heal 2 HP.',
  },
  weak_potion: {
    id: 'weak_potion',
    name: 'Weak Potion',
    effects: [{ kind: 'applyWeak', amount: 2 }],
    target: 'enemy',
    text: 'Apply 2 Weak.',
  },
  vulnerable_potion: {
    id: 'vulnerable_potion',
    name: 'Vulnerable Potion',
    effects: [{ kind: 'applyVulnerable', amount: 1 }],
    target: 'enemy',
    text: 'Apply 1 Vulnerable.',
  },
  flex_potion: {
    id: 'flex_potion',
    name: 'Flex Potion',
    effects: [{ kind: 'gainTemporaryStrength', amount: 1 }],
    text: 'Gain 1 Strength. Lose 1 Strength at end of turn.',
  },
  explosive_potion: {
    id: 'explosive_potion',
    name: 'Explosive Potion',
    effects: [{ kind: 'damage', amount: 2 }],
    target: 'row',
    text: 'Deal 2 damage to any row.',
  },
  snecko_oil: {
    id: 'snecko_oil',
    name: 'Snecko Oil',
    effects: [{ kind: 'draw', amount: 5 }, { kind: 'addDaze', amount: 2, pile: 'draw' }],
    text: 'Draw 5 cards. Gain 2 Daze.',
  },
}

/** The complete physical ordinary relic deck; every card appears exactly once. */
export const RELIC_DECK = [
  'akabeko', 'anchor', 'bag_of_preparation', 'bird_faced_urn', 'blood_vial', 'blue_candle',
  'calipers', 'captains_wheel', 'centennial_puzzle', 'charons_ashes', 'dead_branch', 'dollys_mirror',
  'duality', 'du_vu_doll', 'gambling_chip', 'golden_eye', 'golden_idol', 'gremlin_horn',
  'happy_flower', 'horn_cleat', 'ice_cream', 'incense_burner', 'ink_bottle', 'lantern',
  'meat_on_the_bone', 'mercury_hourglass', 'molten_egg', 'mummified_hand', 'mutagen',
  'necronomicon', 'nilrys_codex', 'ninja_scroll', 'oddly_smooth_stone', 'old_coin', 'omamori',
  'orichalcum', 'peace_pipe', 'pen_nib', 'pocketwatch', 'red_mask', 'red_skull', 'regal_pillow',
  'runic_pyramid', 'self_forming_clay', 'ssserpent_head', 'stone_calendar', 'strike_dummy',
  'sundial', 'the_abacus', 'the_boot', 'the_courier', 'toolbox', 'toxic_egg', 'tungsten_rod',
  'vajra', 'war_paint', 'whetstone', 'wing_boots',
] as const
export const BOSS_RELIC_DECK = [
  'ectoplasm', 'cursed_key', 'wrist_blade', 'holy_water', 'snecko_eye', 'pandoras_box',
  'coffee_dripper', 'fusion_hammer', 'orrery', 'sozu', 'frozen_core', 'empty_cage',
  'black_blood', 'ring_of_the_serpent', 'white_beast_statue', 'tiny_house', 'astrolabe',
  'calling_bell', 'enchiridion', 'mark_of_pain',
] as const

/** The physical shared potion deck, including repeated cards. */
export const POTION_DECK = [
  'ancient_potion', 'attack_potion', 'block_potion', 'block_potion', 'blood_potion', 'cunning_potion',
  'distilled_chaos', 'energy_potion', 'energy_potion', 'entropic_brew', 'explosive_potion', 'explosive_potion',
  'fairy_in_a_bottle', 'fire_potion', 'fire_potion', 'flex_potion', 'flex_potion', 'gamblers_brew',
  'ghost_in_a_jar', 'liquid_memories', 'purity_potion', 'skill_potion', 'snecko_oil',
  'swift_potion', 'swift_potion', 'vulnerable_potion', 'vulnerable_potion', 'weak_potion', 'weak_potion',
] as const

const SPECIAL_POTIONS: Array<[string, string, PotionDef['special'], string]> = [
  ['attack_potion', 'Attack Potion', 'doubleAttack', 'The next Attack you play this turn is played twice.'],
  ['distilled_chaos', 'Distilled Chaos', 'distilledChaos', 'Draw 3 cards. Immediately play them in any order for 0 Energy.'],
  ['entropic_brew', 'Entropic Brew', 'entropicBrew', 'Gain 2 potions.'],
  ['fairy_in_a_bottle', 'Fairy in a Bottle', 'fairy', 'When your HP becomes 0, instead set your HP to 2 and discard this item.'],
  ['gamblers_brew', "Gambler's Brew", 'changeDie', 'Change the die to any number before accepting the roll.'],
  ['ghost_in_a_jar', 'Ghost in a Jar', 'hpLossLimit', 'You cannot lose more than 1 HP this turn.'],
  ['liquid_memories', 'Liquid Memories', 'liquidMemories', 'Return a card from your discard pile to your hand. It costs 0 Energy this turn.'],
  ['purity_potion', 'Purity Potion', 'purity', 'Exhaust up to 3 cards in your hand.'],
  ['skill_potion', 'Skill Potion', 'doubleSkill', 'The next Skill you play this turn is played twice.'],
]

for (const [id, name, special, text] of SPECIAL_POTIONS) {
  POTIONS[id] = { id, name, effects: [], special, text }
}

export function potionDef(id: string): PotionDef {
  const def = POTIONS[id]
  if (!def) throw new Error(`unknown potion id: ${id}`)
  return def
}
