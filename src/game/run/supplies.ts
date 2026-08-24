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
export function merchantItemDecks(state: Pick<RunState, 'campaignProgress'>, itemDecks: ItemDecks): ItemDecks {
  return isColorlessUnlocked(state.campaignProgress) ? itemDecks : { ...itemDecks, colorless: [] }
}
