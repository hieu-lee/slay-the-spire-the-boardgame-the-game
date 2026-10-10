// The skin each of this account's heroes wears: `{ [character]: skinId }`, kept per
// signed-in account (names compare like the server's) or anonymously when signed out.
// It is only a preference: runs read it once, when they start, and keep their own copy.
// Only skins the account's wallet owns are ever read back: a stored choice for a skin
// that is not (or no longer) owned reads as the default look, and the next write drops it.
// Guarded like `campaign-storage.ts`: blocked or full storage never throws into React.
import { characterOfSkin, isSkinOf } from './game/skins.ts'
import type { SkinId } from './game/skins.ts'
import { CHARACTER_IDS } from './game/types.ts'
import type { CharacterId } from './game/types.ts'
import { normalizeUsername, onProfileChange, savedProfile } from './profile.ts'
import { savedWallet, WALLET_EVENT, WALLET_KEY } from './wallet-storage.ts'
import { ownsSkin } from './wallet.ts'

/** The anonymous choices' key; an account's is `sts-skins:<username>`. */
export const SKIN_PREFERENCE_KEY = 'sts-skins'
/** Fired on `window` after this tab changes a choice; other tabs hear the `storage` event. */
export const SKIN_PREFERENCE_EVENT = 'sts-skin-change'

export type SkinChoices = Partial<Record<CharacterId, SkinId>>

export const skinPreferenceKey = (username: string | null | undefined): string => {
  const name = username ? normalizeUsername(username) : ''
  return name ? `${SKIN_PREFERENCE_KEY}:${name}` : SKIN_PREFERENCE_KEY
}

/** Only well-formed pairs survive: anything else reads as "no skin". */
export function parseSkinChoices(value: unknown): SkinChoices {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const entries = Object.entries(value as Record<string, unknown>)
  return Object.fromEntries(entries.filter(([character, skin]) =>
    CHARACTER_IDS.some((id) => id === character) && isSkinOf(character as CharacterId, skin)))
}

/** The choices whose skin the wallet owns. */
const owned = (choices: SkinChoices): SkinChoices => {
  const wallet = savedWallet()
  return Object.fromEntries(Object.entries(choices).filter(([, skin]) => ownsSkin(wallet, skin as SkinId)))
}

const currentKey = () => skinPreferenceKey(savedProfile()?.username)
let unsaved: { key: string; choices: SkinChoices } | null = null

const storedChoices = (): SkinChoices => {
  const key = currentKey()
  if (unsaved?.key === key) return unsaved.choices
  try { return parseSkinChoices(JSON.parse(localStorage.getItem(key) ?? 'null')) } catch { return {} }
}

/** The account's choices, owned skins only. */
export const savedSkinChoices = (): SkinChoices => owned(storedChoices())

/** The skin the signed-in account wants this character to wear, if any. */
export const preferredSkin = (character: CharacterId): SkinId | undefined => savedSkinChoices()[character]

/** Chooses a skin for a character (or `undefined` for the default look). Invalid pairs and unowned skins are ignored. */
export function setPreferredSkin(character: CharacterId, skin: SkinId | undefined): void {
  if (skin !== undefined && (!isSkinOf(character, skin) || !ownsSkin(savedWallet(), skin))) return
  const key = currentKey()
  // Rewriting from the owned choices drops any stored choice for a skin that is not owned.
  const { [character]: _previous, ...others } = savedSkinChoices()
  const choices: SkinChoices = skin === undefined ? others : { ...others, [character]: skin }
  if (JSON.stringify(choices) === JSON.stringify(storedChoices())) return
  try {
    localStorage.setItem(key, JSON.stringify(choices))
    unsaved = null
  } catch {
    // Storage is unavailable; this tab keeps the choice in memory.
    unsaved = { key, choices }
  }
  window.dispatchEvent(new Event(SKIN_PREFERENCE_EVENT))
}

/** Wears a just-bought skin unless its hero already wears another one. */
export function wearBoughtSkin(skin: SkinId): void {
  const character = characterOfSkin(skin)
  if (!preferredSkin(character)) setPreferredSkin(character, skin)
}

/** Calls `listener` whenever the effective choices may have changed (a choice, another tab, an account switch). */
export function onSkinPreferenceChange(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key.startsWith(SKIN_PREFERENCE_KEY) || event.key.startsWith(WALLET_KEY)) listener()
  }
  window.addEventListener(SKIN_PREFERENCE_EVENT, listener)
  window.addEventListener(WALLET_EVENT, listener)
  window.addEventListener('storage', onStorage)
  const stopProfile = onProfileChange(listener)
  return () => {
    window.removeEventListener(SKIN_PREFERENCE_EVENT, listener)
    window.removeEventListener(WALLET_EVENT, listener)
    window.removeEventListener('storage', onStorage)
    stopProfile()
  }
}
