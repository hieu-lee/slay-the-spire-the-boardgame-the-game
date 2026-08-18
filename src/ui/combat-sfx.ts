import type { CharacterId } from '../game/types.ts'
import { CARDS } from '../game/cards.ts'
import { POTIONS } from '../game/relics.ts'
import { cardVfxRecipe, potionVfxRecipe, type VfxFamily, type VfxRecipe } from './combat-vfx.ts'

export type CombatSound =
  | 'ui' | 'card' | 'draw' | 'attack' | 'magic' | 'enemy' | 'block' | 'heal' | 'weak'

export type CombatSfxLayer = Readonly<{
  sound: CombatSound
  rate: number
  volume: number
  delayMs: number
}>

export type CombatSfxRecipe = Readonly<{
  cue: string
  layers: readonly CombatSfxLayer[]
}>

type LayerTemplate = Readonly<{
  sound: CombatSound
  rate?: number
  volume: number
  delayMs?: number
}>

const FAMILY_LAYERS: Readonly<Record<VfxFamily, readonly LayerTemplate[]>> = {
  slash: [{ sound: 'attack', volume: 0.28 }],
  blunt: [{ sound: 'attack', rate: 0.82, volume: 0.23 }, { sound: 'block', rate: 0.72, volume: 0.13 }],
  projectile: [{ sound: 'magic', volume: 0.22 }, { sound: 'enemy', rate: 1.12, volume: 0.12 }],
  poison: [{ sound: 'weak', rate: 0.86, volume: 0.22 }, { sound: 'magic', rate: 0.78, volume: 0.11 }],
  shiv: [{ sound: 'card', rate: 1.2, volume: 0.12 }, { sound: 'attack', rate: 1.12, volume: 0.24 }],
  lightning: [{ sound: 'magic', rate: 1.12, volume: 0.22 }, { sound: 'enemy', rate: 1.18, volume: 0.11 }],
  frost: [{ sound: 'magic', rate: 1.16, volume: 0.18 }, { sound: 'block', rate: 1.08, volume: 0.13 }],
  dark: [{ sound: 'magic', rate: 0.74, volume: 0.22 }, { sound: 'weak', rate: 0.8, volume: 0.1 }],
  block: [{ sound: 'block', volume: 0.28 }],
  buff: [{ sound: 'magic', rate: 1.08, volume: 0.24 }],
  debuff: [{ sound: 'weak', volume: 0.25 }],
  draw: [{ sound: 'draw', rate: 1.08, volume: 0.23 }],
  discard: [{ sound: 'card', rate: 0.9, volume: 0.22 }],
  exhaust: [{ sound: 'card', rate: 0.74, volume: 0.16 }, { sound: 'magic', rate: 0.82, volume: 0.12 }],
  stance: [{ sound: 'magic', rate: 1.08, volume: 0.2 }, { sound: 'heal', rate: 0.92, volume: 0.1 }],
  mantra: [{ sound: 'magic', rate: 1.28, volume: 0.2 }, { sound: 'heal', rate: 1.18, volume: 0.12 }],
  orb: [{ sound: 'magic', rate: 1.14, volume: 0.24 }],
  utility: [{ sound: 'card', volume: 0.22 }],
}

const ASSET_LAYERS: Readonly<Record<string, readonly LayerTemplate[]>> = {
  'ironclad-strike': [{ sound: 'attack', rate: 0.94, volume: 0.29 }],
  'ironclad-bash': FAMILY_LAYERS.blunt,
  'lightning-channel': FAMILY_LAYERS.lightning,
  'watcher-pray': FAMILY_LAYERS.mantra,
  'silent-poison': FAMILY_LAYERS.poison,
  'silent-shiv': FAMILY_LAYERS.shiv,
  'guard-bloom': FAMILY_LAYERS.block,
}

const CHARACTER_RATE: Readonly<Record<CharacterId, number>> = {
  ironclad: 0.94,
  silent: 1.08,
  defect: 1.14,
  watcher: 1.02,
}

const POTION_IDS = Object.keys(POTIONS).sort()
const CARD_IDS = Object.keys(CARDS).sort()
const CHARACTERS: readonly CharacterId[] = ['ironclad', 'silent', 'defect', 'watcher']
const IDENTITY_SOUNDS: readonly CombatSound[] = [
  'ui', 'card', 'draw', 'attack', 'magic', 'enemy', 'block', 'heal', 'weak',
]

function identityLayer(slot: number): LayerTemplate {
  return {
    sound: IDENTITY_SOUNDS[slot % IDENTITY_SOUNDS.length]!,
    rate: 0.74 + Math.floor(slot / IDENTITY_SOUNDS.length) % 8 * 0.06,
    volume: 0.08,
    delayMs: 36 + Math.floor(slot / (IDENTITY_SOUNDS.length * 8)) * 14,
  }
}

function tunedRecipe(
  cue: string,
  layers: readonly LayerTemplate[],
  baseRate: number,
): CombatSfxRecipe {
  return {
    cue,
    layers: layers.map((layer) => ({
      sound: layer.sound,
      rate: Math.round(
        Math.max(0.65, Math.min(1.45, baseRate * (layer.rate ?? 1))) * 1_000,
      ) / 1_000,
      volume: layer.volume,
      delayMs: layer.delayMs ?? 0,
    })),
  }
}

function layersForCard(recipe: VfxRecipe): readonly LayerTemplate[] {
  if (recipe.tone === 'calm-white') {
    return [{ sound: 'magic', rate: 1.18, volume: 0.17 }, { sound: 'heal', rate: 0.86, volume: 0.11 }]
  }
  if (recipe.tone === 'wrath-red') {
    return [{ sound: 'attack', rate: 1.18, volume: 0.22 }, { sound: 'magic', rate: 0.86, volume: 0.12 }]
  }
  return ASSET_LAYERS[recipe.asset] ?? FAMILY_LAYERS[recipe.family]
}

export function cardSfxRecipe(
  character: CharacterId,
  cardId: string,
  mode?: number,
  upgraded = cardId.endsWith('+'),
): CombatSfxRecipe {
  const baseId = cardId.endsWith('+') ? cardId.slice(0, -1) : cardId
  const visual = cardVfxRecipe(character, baseId, mode, upgraded)
  const slot = CHARACTERS.indexOf(character) * CARD_IDS.length + CARD_IDS.indexOf(baseId)
  return tunedRecipe(
    `card:${character}:${baseId}:${mode ?? 'base'}`,
    [...layersForCard(visual), identityLayer(slot)],
    CHARACTER_RATE[character],
  )
}

export function potionSfxRecipe(potionId: string): CombatSfxRecipe {
  const visual = potionVfxRecipe(potionId)
  const semantic = FAMILY_LAYERS[visual.family][0] ?? FAMILY_LAYERS.utility[0]!
  const slot = POTION_IDS.indexOf(potionId)
  const rate = 0.9 + slot * 0.008
  return tunedRecipe(
    `potion:${potionId}`,
    [semantic, identityLayer(slot)],
    rate,
  )
}
