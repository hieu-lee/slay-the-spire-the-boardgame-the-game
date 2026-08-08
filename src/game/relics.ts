// Relics and potions.
//
// A relic is a permanent, always-on effect; a potion is single-use. Both are
// modelled as triggers rather than as code so the campaign can hold them as
// plain data alongside everything else.
import type { Effect } from './cards.ts'

/**
 * When a relic fires. `dieRelic` triggers on a matching roll during Start of
 * Turn, which is why the die is rolled before start-of-turn abilities (p.12).
 */
export type RelicTrigger =
  | { kind: 'startOfCombat' }
  | { kind: 'startOfTurn' }
  | { kind: 'endOfTurn' }
  | { kind: 'endOfCombat' }
  | { kind: 'dieRelic'; faces: number[] }

export type RelicDef = {
  id: string
  name: string
  /** Boss relics come with a drawback and are handed out after an Act. */
  boss?: boolean
  /** Gold cost at the Merchant; absent means it is not for sale. */
  cost?: number
  trigger: RelicTrigger
  effects: Effect[]
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
  akabeko: {
    id: 'akabeko',
    name: 'Akabeko',
    cost: 5,
    trigger: { kind: 'startOfCombat' },
    effects: [{ kind: 'gainStrength', amount: 1 }],
    text: 'Start of combat: gain 1 Strength.',
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
  /** Potions that need an enemy chosen, rather than landing on the drinker. */
  targetsEnemy?: boolean
  text: string
}

export const POTIONS: Record<string, PotionDef> = {
  block_potion: {
    id: 'block_potion',
    name: 'Block Potion',
    effects: [{ kind: 'block', amount: 3 }],
    text: 'Gain 3 Block.',
  },
  fire_potion: {
    id: 'fire_potion',
    name: 'Fire Potion',
    effects: [{ kind: 'hit', amount: 3 }],
    targetsEnemy: true,
    text: 'Deal 3 damage.',
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
    effects: [{ kind: 'applyWeak', amount: 1 }],
    targetsEnemy: true,
    text: 'Apply 1 Weak.',
  },
  vulnerable_potion: {
    id: 'vulnerable_potion',
    name: 'Vulnerable Potion',
    effects: [{ kind: 'applyVulnerable', amount: 1 }],
    targetsEnemy: true,
    text: 'Apply 1 Vulnerable.',
  },
  flex_potion: {
    id: 'flex_potion',
    name: 'Flex Potion',
    effects: [{ kind: 'gainStrength', amount: 2 }],
    text: 'Gain 2 Strength.',
  },
}

export function potionDef(id: string): PotionDef {
  const def = POTIONS[id]
  if (!def) throw new Error(`unknown potion id: ${id}`)
  return def
}
