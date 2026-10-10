import { ALL_CHARACTER_IDS, DLC_CHARACTER_IDS, PLAYTEST_CHARACTER_IDS } from '../game/types.ts'
import type { CardType, CharacterId } from '../game/types.ts'
import { CARDS } from '../game/cards.ts'
import { POTIONS } from '../game/relics.ts'
import { cardVfxRecipe, potionVfxRecipe, type VfxFamily, type VfxRecipe } from './combat-vfx.ts'

export const ANIMATION_SOUND_VOLUMES = {
  'kratos-chain': .19, 'kratos-light': .16, 'kratos-slam': .32,
  gunshot: .24, 'bullet-impact': .10, 'meteor-fall': .22, 'meteor-impact': .28,
  'sword-swing': .18, 'sword-clash': .20, 'lightning-burst': .22, 'dark-beam': .24,
  'frost-bloom': .20, 'flame-burst': .22, 'slime-splat': .20, 'poison-hiss': .16,
} as const
export type AnimationSound = keyof typeof ANIMATION_SOUND_VOLUMES

export type CombatSound =
  | AnimationSound
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
  'guard-bloom': [
    { sound: 'magic', rate: 0.9, volume: 0.1 },
    { sound: 'block', volume: 0.28 },
  ],
  'hexaghost-flame-impact': FAMILY_LAYERS.projectile,
}

const CHARACTER_RATE: Readonly<Record<CharacterId, number>> = {
  ironclad: 0.94,
  silent: 1.08,
  defect: 1.14,
  watcher: 1.02,
  slime_boss: 0.88,
  guardian: 0.92,
  hexaghost: 1.16,
  hermit: 0.98,
  kratos: 0.9,
}

const POTION_IDS = Object.keys(POTIONS).sort()
// Preserve the original heroes' accents when a DLC moves out of playtesting.
// Additional cards occupy their own grid after every character's original pool.
const EXTRA_OWNERS = new Set<string>([...DLC_CHARACTER_IDS, ...PLAYTEST_CHARACTER_IDS])
const ORIGINAL_CARD_IDS = Object.values(CARDS).filter((def) => !EXTRA_OWNERS.has(def.owner) && !def.pack).map((def) => def.id).sort()
const ORIGINAL_CARDS = new Set(ORIGINAL_CARD_IDS)
const EXTRA_CARD_IDS = Object.keys(CARDS).filter((id) => !ORIGINAL_CARDS.has(id) && !CARDS[id]!.pack).sort()
// Shop pack cards (The Slayer Pack) get a block of their own after every
// character's extra grid, so adding them retunes no existing card.
const PACK_CARD_IDS = Object.keys(CARDS).filter((id) => CARDS[id]!.pack).sort()
const CHARACTERS: readonly CharacterId[] = ALL_CHARACTER_IDS
const IDENTITY_SOUNDS: readonly CombatSound[] = [
  'ui', 'card', 'draw', 'attack', 'magic', 'enemy', 'block', 'heal', 'weak',
]
const IDENTITY_PERIOD = IDENTITY_SOUNDS.length * 8
// Whole timing bands keep differently pitched actors' extra accents distinct.
const EXTRA_OFFSET = Math.ceil(CHARACTERS.length * ORIGINAL_CARD_IDS.length / IDENTITY_PERIOD) * IDENTITY_PERIOD
const EXTRA_STRIDE = Math.ceil(EXTRA_CARD_IDS.length / IDENTITY_PERIOD) * IDENTITY_PERIOD
const PACK_OFFSET = EXTRA_OFFSET + CHARACTERS.length * EXTRA_STRIDE
const PACK_STRIDE = Math.ceil(PACK_CARD_IDS.length / IDENTITY_PERIOD) * IDENTITY_PERIOD

function identityLayer(slot: number): LayerTemplate {
  return {
    sound: IDENTITY_SOUNDS[slot % IDENTITY_SOUNDS.length]!,
    rate: 0.74 + Math.floor(slot / IDENTITY_SOUNDS.length) % 8 * 0.06,
    volume: 0.08,
    delayMs: 36 + Math.floor(slot / IDENTITY_PERIOD) * 14,
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
  resolvedType?: CardType,
): CombatSfxRecipe {
  const baseId = cardId.endsWith('+') ? cardId.slice(0, -1) : cardId
  const visual = cardVfxRecipe(character, baseId, mode, upgraded, resolvedType)
  const characterIndex = CHARACTERS.indexOf(character)
  const originalIndex = ORIGINAL_CARD_IDS.indexOf(baseId)
  const packIndex = PACK_CARD_IDS.indexOf(baseId)
  const slot = originalIndex >= 0 ? characterIndex * ORIGINAL_CARD_IDS.length + originalIndex
    : packIndex >= 0 ? PACK_OFFSET + characterIndex * PACK_STRIDE + packIndex
      : EXTRA_OFFSET + characterIndex * EXTRA_STRIDE + EXTRA_CARD_IDS.indexOf(baseId)
  return tunedRecipe(
    `card:${character}:${baseId}:${mode ?? 'base'}`,
    [...layersForCard(visual).map(layer => ({ ...layer,
      // Animation cues supply the weapon/element detail; keep the original bed quieter.
      volume: layer.volume * (visual.actorMotion === 'none' ? 1 : .55),
    })), identityLayer(slot)],
    CHARACTER_RATE[character],
  )
}

export function shivSfxRecipe(): CombatSfxRecipe {
  return tunedRecipe('shiv:silent', FAMILY_LAYERS.shiv, CHARACTER_RATE.silent)
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

/** A single cue at a visible animation beat, mixed below the main combat audio. */
export function animationSfxRecipe(sound: AnimationSound, voices = 1): CombatSfxRecipe {
  return { cue: `animation:${sound}`, layers: [{ sound, rate: .99,
    volume: ANIMATION_SOUND_VOLUMES[sound] / Math.sqrt(Math.max(1, voices)), delayMs: 0 }] }
}
