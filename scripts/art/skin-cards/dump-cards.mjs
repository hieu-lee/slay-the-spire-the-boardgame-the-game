// Regenerates cards.json (the Ironclad catalogue the skin art pipeline reads):
//   node --experimental-strip-types scripts/art/skin-cards/dump-cards.mjs
import { writeFileSync } from 'node:fs'
import { CARDS } from '../../../src/game/cards.ts'

const cards = Object.values(CARDS)
  .filter((card) => card.owner === 'ironclad')
  .map((card) => ({ id: card.id, name: card.name, type: card.type, rarity: card.rarity, cost: card.cost,
    ...(card.pack ? { pack: card.pack } : {}), text: card.printedText ?? null }))
writeFileSync(new URL('./cards.json', import.meta.url), `${JSON.stringify(cards, null, 1)}\n`)
console.log(`${cards.length} Ironclad cards`)
