// Whether the signed-in account's bought card packs join its new runs. A preference like
// the worn skins (`skin-preference.ts`): per account (or anonymous when signed out) and per
// browser, read once when a run starts. Owning a pack never changes; only a pack that is
// both owned and switched on is dealt. On by default, so storing only an explicit "off".
// Guarded like `campaign-storage.ts`: blocked or full storage never throws into React.
import { normalizeCardPacks } from './game/packs.ts'
import type { CardPackId } from './game/packs.ts'
import { normalizeUsername, onProfileChange, savedProfile } from './profile.ts'
import { savedWallet, WALLET_EVENT, WALLET_KEY } from './wallet-storage.ts'

/** The anonymous choice's key; an account's is `sts-use-packs:<username>`. */
export const PACK_PREFERENCE_KEY = 'sts-use-packs'
/** Fired on `window` after this tab changes the choice; other tabs hear the `storage` event. */
export const PACK_PREFERENCE_EVENT = 'sts-use-packs-change'

export const packPreferenceKey = (username: string | null | undefined): string => {
  const name = username ? normalizeUsername(username) : ''
  return name ? `${PACK_PREFERENCE_KEY}:${name}` : PACK_PREFERENCE_KEY
}

const currentKey = () => packPreferenceKey(savedProfile()?.username)
// Choices storage refused, per key, so one account's fallback survives another account's change.
const unsaved = new Map<string, boolean>()

/** Whether bought packs join new runs; true unless this account switched them off. */
export function playWithPacks(): boolean {
  const key = currentKey()
  const kept = unsaved.get(key)
  if (kept !== undefined) return kept
  try { return JSON.parse(localStorage.getItem(key) ?? 'null') !== false } catch { return true }
}

export function setPlayWithPacks(enabled: boolean): void {
  if (enabled === playWithPacks()) return
  const key = currentKey()
  try {
    if (enabled) localStorage.removeItem(key)
    else localStorage.setItem(key, 'false')
    unsaved.delete(key)
  } catch {
    // Storage is unavailable; this tab keeps the choice in memory.
    unsaved.set(key, enabled)
  }
  window.dispatchEvent(new Event(PACK_PREFERENCE_EVENT))
}

/** The packs a new run should shuffle in: everything owned, unless the account switched them off. */
export const selectedCardPacks = (): CardPackId[] =>
  playWithPacks() ? normalizeCardPacks(savedWallet().packs) : []

/** Calls `listener` whenever the choice or the owned packs may have changed (a choice, another tab, an account switch). */
export function onPackPreferenceChange(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key.startsWith(PACK_PREFERENCE_KEY) || event.key.startsWith(WALLET_KEY)) listener()
  }
  window.addEventListener(PACK_PREFERENCE_EVENT, listener)
  window.addEventListener(WALLET_EVENT, listener)
  window.addEventListener('storage', onStorage)
  const stopProfile = onProfileChange(listener)
  return () => {
    window.removeEventListener(PACK_PREFERENCE_EVENT, listener)
    window.removeEventListener(WALLET_EVENT, listener)
    window.removeEventListener('storage', onStorage)
    stopProfile()
  }
}
