// Which skin a card face wears. A card uses the skin of the seat that owns its character
// in the run on screen (every seat's skin is public); screens outside a run use the
// viewer's saved preference. Presentation only: `cardImagePath` and friends fall back to
// the default look for any card the skin has no art for.
import { createContext, useContext, useMemo, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { CardDef } from '../game/cards.ts'
import { validSkin } from '../game/skins.ts'
import type { SkinId } from '../game/skins.ts'
import type { CharacterId } from '../game/types.ts'
import { onSkinPreferenceChange, parseSkinChoices, savedSkinChoices } from '../skin-preference.ts'
import type { SkinChoices } from '../skin-preference.ts'

const SkinContext = createContext<SkinChoices>({})

/** The viewer's saved choices; re-renders when they change (a choice, another tab, an account switch). */
export function usePreferredSkins(): SkinChoices {
  // A string snapshot: `savedSkinChoices` builds a new object on every read.
  const saved = useSyncExternalStore(onSkinPreferenceChange, () => JSON.stringify(savedSkinChoices()))
  return useMemo(() => parseSkinChoices(JSON.parse(saved)), [saved])
}

type SkinSeat = { character: CharacterId; skin?: unknown }

/**
 * Provides the skins card faces wear: the run's seats when `seats` is given (solo run,
 * online snapshot, replay), otherwise the viewer's preference.
 */
export function SkinProvider({ seats, children }: { seats?: readonly SkinSeat[]; children: ReactNode }) {
  const preferred = usePreferredSkins()
  // Run players are a new array on every action: key on the skins themselves so the
  // context (and every card under it) only changes when a seat's skin does.
  const key = seats?.map((seat) => `${seat.character}:${validSkin(seat.character, seat.skin) ?? ''}`).join('|')
  const choices = useMemo<SkinChoices>(() => {
    if (!seats) return preferred
    const result: SkinChoices = {}
    for (const seat of seats) {
      const skin = validSkin(seat.character, seat.skin)
      if (skin && !result[seat.character]) result[seat.character] = skin
    }
    return result
    // `key` stands in for `seats`: it changes only when a seat's skin does.
  }, [key, preferred])
  return <SkinContext.Provider value={choices}>{children}</SkinContext.Provider>
}

/** The skins in effect, for code that resolves card art for several cards or inside handlers. */
export const useCardSkins = (): SkinChoices => useContext(SkinContext)

/** The skin the owner of `def` wears under `choices`, if any. */
export const cardSkin = (choices: SkinChoices, def: Pick<CardDef, 'owner'>): SkinId | undefined =>
  choices[def.owner as CharacterId]

/** The skin this card's owner wears, if any. */
export const useCardSkin = (def: Pick<CardDef, 'owner'>): SkinId | undefined => cardSkin(useCardSkins(), def)
