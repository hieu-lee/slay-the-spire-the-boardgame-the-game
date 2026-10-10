// Skins change how a hero looks, never how it plays: no rules, RNG or hashes read them.
// A skin belongs to one character; `visualId` is the key every piece of per-hero art uses.
import { CHARACTER_IDS } from './types.ts'
import type { CharacterId } from './types.ts'

export const SKINS = {
  ironclad: ['kratos'],
} as const satisfies Partial<Record<CharacterId, readonly string[]>>

export type SkinId = (typeof SKINS)[keyof typeof SKINS][number]
/** What per-hero art is keyed by: a worn skin's id, else the character id. */
export type VisualId = CharacterId | SkinId
export const SKIN_IDS: readonly SkinId[] = [...new Set(Object.values(SKINS).flat())]
/** Every art key, characters first: the order party-keyed art (campfire scenes) is named in. */
export const VISUAL_IDS: readonly VisualId[] = [...CHARACTER_IDS, ...SKIN_IDS]

export const SKIN_LABELS: Record<SkinId, string> = {
  kratos: 'Kratos',
}

/** Presentation facts of a skin. Code reads them by visual id instead of testing for a literal skin id. */
export interface SkinTraits {
  /** Paints its own energy orb at `combat/energy-orbs/<id>.webp` instead of the character's orb. */
  energyOrb: boolean
  /** Its attack animation reports each hit's damage itself, so the HP drop waits for the animation. */
  stagedAttack: boolean
}

export const SKIN_TRAITS = {
  kratos: { energyOrb: true, stagedAttack: true },
} as const satisfies Record<SkinId, SkinTraits>

/** The traits of a skin's visual id; a character's own visual id has none. */
export function skinTraits(visual: VisualId): SkinTraits | undefined {
  return Object.hasOwn(SKIN_TRAITS, visual) ? SKIN_TRAITS[visual as SkinId] : undefined
}

/** Hermit's rounds and staged skins damage enemies hit by hit while their attack plays. */
export const hasStagedAttack = (visual: VisualId): boolean => visual === 'hermit' || Boolean(skinTraits(visual)?.stagedAttack)

/** The skins a character can wear (none for most heroes). */
export function skinsOf(character: CharacterId): readonly SkinId[] {
  // Own keys only: 'toString' or 'constructor' must not resolve to an Object.prototype member.
  return Object.hasOwn(SKINS, character) ? SKINS[character as keyof typeof SKINS] : []
}

export function isSkinOf(character: CharacterId, skin: unknown): skin is SkinId {
  return typeof skin === 'string' && skinsOf(character).some((candidate) => candidate === skin)
}

export const isSkinId = (value: unknown): value is SkinId =>
  typeof value === 'string' && SKIN_IDS.some((id) => id === value)

/** The character a skin belongs to. */
export const characterOfSkin = (skin: SkinId): CharacterId =>
  CHARACTER_IDS.find((character) => isSkinOf(character, skin))!

/** Untrusted skin list (storage, a request body) to a clean one: known ids, no duplicates, catalogue order. */
export function normalizeSkins(value: unknown): SkinId[] {
  return Array.isArray(value) ? SKIN_IDS.filter((id) => value.includes(id)) : []
}

/** The skin when it is valid for the character, otherwise absent. */
export function validSkin(character: CharacterId, skin: unknown): SkinId | undefined {
  return isSkinOf(character, skin) ? skin : undefined
}

/** The art key: the skin id when a valid skin is worn, else the character id. */
export function visualId(character: CharacterId, skin?: unknown): VisualId {
  return isSkinOf(character, skin) ? skin : character
}

/** The art key of a run, combat or room player. */
export const playerVisualId = (player: { character: CharacterId; skin?: unknown }): VisualId =>
  visualId(player.character, player.skin)
