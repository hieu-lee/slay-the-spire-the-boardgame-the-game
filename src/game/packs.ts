// Card packs: optional card sets a player buys in the Shop and, for now, always
// shuffles into their own runs. A pack is data only — which cards it holds and
// who they belong to. The cards themselves live in `src/game/slayer/`.
//
// This module imports nothing from `cards.ts`, so card definitions can name their
// pack without a cycle.
import type { BaseCharacterId } from './types.ts'

export const CARD_PACK_IDS = [
  'slayer_ironclad',
  'slayer_silent',
  'slayer_defect',
  'slayer_watcher',
  'slayer_colorless',
] as const

export type CardPackId = (typeof CARD_PACK_IDS)[number]

export type CardPackDef = {
  id: CardPackId
  name: string
  /** Whose reward decks the cards join; `colorless` cards join the Colorless supply. */
  owner: BaseCharacterId | 'colorless'
  tagline: string
  /** Card ids in print order. */
  cardIds: readonly string[]
}

export const CARD_PACKS: Readonly<Record<CardPackId, CardPackDef>> = {
  slayer_ironclad: {
    id: 'slayer_ironclad',
    name: 'Ironclad Slayer Pack',
    owner: 'ironclad',
    tagline: 'Seven brutal new cards for the Ironclad, from Brutality to Searing Blow.',
    cardIds: ['slayer_armaments', 'slayer_brutality', 'slayer_dropkick', 'slayer_dual_wield',
      'slayer_infernal_blade', 'slayer_reaper', 'slayer_searing_blow'],
  },
  slayer_silent: {
    id: 'slayer_silent',
    name: 'Silent Slayer Pack',
    owner: 'silent',
    tagline: 'Seven venomous new cards for the Silent, from Caltrops to Phantasmal Killer.',
    cardIds: ['slayer_caltrops', 'slayer_endless_agony', 'slayer_eviscerate', 'slayer_glass_knife',
      'slayer_heel_hook', 'slayer_nightmare', 'slayer_phantasmal_killer'],
  },
  slayer_defect: {
    id: 'slayer_defect',
    name: 'Defect Slayer Pack',
    owner: 'defect',
    tagline: 'Seven new circuits for the Defect, from Aggregate to Reboot.',
    cardIds: ['slayer_aggregate', 'slayer_auto_shields', 'slayer_biased_cognition', 'slayer_creative_ai',
      'slayer_hello_world', 'slayer_reboot', 'slayer_rebound'],
  },
  slayer_watcher: {
    id: 'slayer_watcher',
    name: 'Watcher Slayer Pack',
    owner: 'watcher',
    tagline: 'Seven new disciplines for the Watcher, from Bowling Bash to Wheel Kick.',
    cardIds: ['slayer_bowling_bash', 'slayer_deceive_reality', 'slayer_fasting', 'slayer_master_reality',
      'slayer_pressure_points', 'slayer_wave_of_the_hand', 'slayer_wheel_kick'],
  },
  slayer_colorless: {
    id: 'slayer_colorless',
    name: 'Colorless Slayer Pack',
    owner: 'colorless',
    tagline: 'Seventeen new Colorless cards any hero can find, from Bandage Up to Violence.',
    cardIds: ['slayer_bandage_up', 'slayer_bite', 'slayer_chrysalis', 'slayer_companion', 'slayer_deep_breath',
      'slayer_discovery', 'slayer_enlightenment', 'slayer_forethought', 'slayer_jack_of_all_trades',
      'slayer_magnetism', 'slayer_metamorphosis', 'slayer_panic_button', 'slayer_ritual_dagger',
      'slayer_secret_technique', 'slayer_smite', 'slayer_transmutation', 'slayer_violence'],
  },
}

const PACK_OF_CARD: ReadonlyMap<string, CardPackId> = new Map(
  CARD_PACK_IDS.flatMap((id) => CARD_PACKS[id].cardIds.map((cardId) => [cardId, id] as const)),
)

export const isCardPackId = (value: unknown): value is CardPackId =>
  typeof value === 'string' && (CARD_PACK_IDS as readonly string[]).includes(value)

/** The pack a card id belongs to, or undefined for every card from the base game and expansions. */
export const cardPackOf = (cardId: string): CardPackId | undefined => PACK_OF_CARD.get(cardId)

/**
 * Untrusted pack list (a save, a request body, a seat's join message) to a clean
 * one: known ids only, no duplicates, always in catalogue order so two clients
 * with the same packs agree byte for byte.
 */
export function normalizeCardPacks(value: unknown): CardPackId[] {
  if (!Array.isArray(value)) return []
  return CARD_PACK_IDS.filter((id) => value.includes(id))
}
