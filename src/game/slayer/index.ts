import type { CardDef } from '../cards.ts'
import { SLAYER_COLORLESS_CARD_DEFS } from './colorless.ts'
import { SLAYER_DEFECT_CARD_DEFS } from './defect.ts'
import { SLAYER_IRONCLAD_CARD_DEFS } from './ironclad.ts'
import { SLAYER_SILENT_CARD_DEFS } from './silent.ts'
import { SLAYER_WATCHER_CARD_DEFS } from './watcher.ts'

/** Every card of The Slayer Pack, keyed by id. See docs/slayer-pack.md. */
export const SLAYER_CARD_DEFS: Readonly<Record<string, CardDef>> = {
  ...SLAYER_IRONCLAD_CARD_DEFS,
  ...SLAYER_SILENT_CARD_DEFS,
  ...SLAYER_DEFECT_CARD_DEFS,
  ...SLAYER_WATCHER_CARD_DEFS,
  ...SLAYER_COLORLESS_CARD_DEFS,
}
