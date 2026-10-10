// Keeping the item supplies in step.
//
// Cards, relics and potions come out of shared decks. The run carries them
// twice — once as `itemDecks`, once as the older flat `relicDeck`/`potionDeck`
// fields that saved runs and the room server still read — so every change to
// one has to be mirrored onto the other or a physical item gets handed out
// twice.
import type { RunState } from './types.ts'
import type { ItemDecks } from '../acquisition.ts'
import { isColorlessUnlocked } from '../campaign.ts'
import { potionDef } from '../relics.ts'
import { cardPackOf } from '../packs.ts'
import type { MerchantItemDecks } from '../noncombat.ts'

/** Keep the compatibility deck fields as mirrors of the one physical item supply. */
export function mirrorItemSupplies(state: RunState, itemDecks: ItemDecks): RunState {
  return {
    ...state,
    itemDecks,
    relicDeck: [...itemDecks.relics],
    potionDeck: [...itemDecks.potions],
  }
}

/** Legacy combat/reward paths still update the flat fields; mirror those changes back. */
export function mirrorLegacySupplies(state: RunState): RunState {
  return {
    ...state,
    itemDecks: {
      ...state.itemDecks,
      relics: [...state.relicDeck],
      potions: [...state.potionDeck],
    },
  }
}

/** Daily modifiers may use Colorless rewards without unlocking the Merchant pile. */
export function merchantItemDecks(state: Pick<RunState, 'campaignProgress'>, itemDecks: ItemDecks): MerchantItemDecks {
  const merchantPriced = { ...itemDecks, potions: itemDecks.potions.filter((id) => potionDef(id).cost !== undefined) }
  if (isColorlessUnlocked(state.campaignProgress)) return merchantPriced
  // Slayer Pack: a bought Colorless pack stocks the Merchant without the unlock,
  // while the locked base cards a modifier put in the pile stay out of the shop.
  const base = itemDecks.colorless.filter((id) => cardPackOf(id) === undefined)
  if (base.length === itemDecks.colorless.length) return { ...merchantPriced, colorless: [] }
  return base.length > 0 ? { ...merchantPriced, colorlessBlocked: new Set(base) } : merchantPriced
}

/**
 * Whether Colorless cards exist for this run's Neow cards and Events: the
 * campaign unlock, or a bought Colorless pack (Slayer Pack) the run started with.
 */
export const colorlessCardsAvailable = (state: Pick<RunState, 'campaignProgress' | 'meta'>): boolean =>
  isColorlessUnlocked(state.campaignProgress) || (state.meta.cardPacks ?? []).includes('slayer_colorless')
