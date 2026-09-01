// Extract the official Downfall board-game card faces from the audited TTS
// sheets already kept in tmp/downfall-reference. No network access is needed.
import { existsSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { cardImagePath, cardThumbPath } from '../src/game/assets.ts'
import { GUARDIAN_CARD_DEFS, GUARDIAN_PHYSICAL_CARDS } from '../src/game/downfall/guardian.ts'
import { HERMIT_CARD_DEFS, HERMIT_PHYSICAL_CARDS } from '../src/game/downfall/hermit.ts'
import { HEXAGHOST_CARDS } from '../src/game/downfall/hexaghost.ts'
import { SLIME_BOSS_CARDS } from '../src/game/downfall/slime-boss.ts'
import { DOWNFALL_COLORLESS_CARD_DEFS, DOWNFALL_COLORLESS_CARDS, itemId } from '../src/game/downfall/items.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sheets = join(root, 'tmp/downfall-reference/sheets')
const fullRoot = join(root, 'public/assets/cards')
const thumbRoot = join(root, 'public/assets/cards-sm')
const force = process.argv.includes('--force')
mkdirSync(fullRoot, { recursive: true })
mkdirSync(thumbRoot, { recursive: true })

const sheetSets = {
  slime_boss: {
    starter: ['60a205', 'c6d696'], rewards: ['d31ff8', '2da0ab'], rare: ['dc3185', 'a15719'],
  },
  hexaghost: {
    starter: ['70f029', '55c529'], rewards: ['8cf2ec', 'e0769d'], rare: ['ba6c5b', '07ecb9'],
  },
}

const jobs = []
const seen = new Set()
function add(def, baseGuid, baseIndex, upgradeGuid, upgradeIndex) {
  if (seen.has(def.id)) return
  seen.add(def.id)
  jobs.push({ def, guid: baseGuid, index: baseIndex, upgraded: false })
  if (def.upgrade && upgradeGuid && Number.isInteger(upgradeIndex)) {
    jobs.push({ def, guid: upgradeGuid, index: upgradeIndex, upgraded: true })
  }
}

for (const card of GUARDIAN_PHYSICAL_CARDS) {
  add(GUARDIAN_CARD_DEFS[card.defId], card.sheetGuid, card.sheetIndex,
    card.upgradeSheetGuid, card.upgradeSheetIndex)
}
for (const card of HERMIT_PHYSICAL_CARDS) {
  add(HERMIT_CARD_DEFS[card.defId], card.sheetGuid, card.sheetIndex,
    card.upgradeSheetGuid, card.upgradeSheetIndex)
}
for (const def of Object.values(SLIME_BOSS_CARDS)) {
  const [baseGuid, upgradeGuid] = sheetSets.slime_boss[def.deck]
  add(def, baseGuid, def.sheetIndex, upgradeGuid, def.upgradedSheetIndex)
}
for (const card of DOWNFALL_COLORLESS_CARDS.slice(0, 16)) {
  add(DOWNFALL_COLORLESS_CARD_DEFS[itemId(card.name)],
  card.baseGuid, card.index, card.upgradeGuid, card.index)
}

const hexStarter = new Map([
  ['defend_hexaghost', 0], ['kindle', 4], ['sear', 5], ['strike_hexaghost', 6],
])
const hexCommons = [
  'advancing_guard', 'burning_touch', 'firestarter', 'flare_flick', 'fleeting_flash',
  'ghost_lash', 'premonition', 'shield_of_night', 'sword_of_night', 'thermal_transfer',
  'ghost_shield', 'floatwork', 'nightmare_strike', 'heat_crush', 'fast_forward',
]
const hexUncommons = Object.values(HEXAGHOST_CARDS).filter((def) => def.rarity === 'uncommon')
const hexRares = Object.values(HEXAGHOST_CARDS).filter((def) => def.rarity === 'rare')
for (const [id, index] of hexStarter) {
  const [baseGuid, upgradeGuid] = sheetSets.hexaghost.starter
  add(HEXAGHOST_CARDS[id], baseGuid, index, upgradeGuid, index)
}
hexCommons.forEach((id, position) => {
  const [baseGuid, upgradeGuid] = sheetSets.hexaghost.rewards
  add(HEXAGHOST_CARDS[id], baseGuid, position * 2, upgradeGuid, position * 2)
})
hexUncommons.forEach((def, position) => {
  const [baseGuid, upgradeGuid] = sheetSets.hexaghost.rewards
  add(def, baseGuid, 32 + position, upgradeGuid, 32 + position)
})
hexRares.forEach((def, position) => {
  const [baseGuid, upgradeGuid] = sheetSets.hexaghost.rare
  add(def, baseGuid, position, upgradeGuid, position)
})

const expected = Object.values(GUARDIAN_CARD_DEFS).length + Object.values(HERMIT_CARD_DEFS).length +
  Object.values(SLIME_BOSS_CARDS).length + Object.values(HEXAGHOST_CARDS).length +
  Object.values(DOWNFALL_COLORLESS_CARD_DEFS).length
if (seen.size !== expected) throw new Error(`mapped ${seen.size}/${expected} Downfall card definitions`)

function outputPath(job, thumbnail) {
  const url = thumbnail ? cardThumbPath(job.def, job.upgraded) : cardImagePath(job.def, job.upgraded)
  return join(root, 'public', url.replace(/^\//, ''))
}

let written = 0
for (const job of jobs) {
  const source = job.guid === '7f7cc9'
    ? join(root, 'tmp/downfall-reference/content-sheets/colorless.jpg')
    : job.guid === '80fcb6'
      ? join(root, 'tmp/downfall-reference/content-sheets/colorless-upgrades.jpg')
      : join(sheets, `${job.guid}.img`)
  if (!existsSync(source)) throw new Error(`missing audited source sheet ${job.guid}`)
  const cellHeight = job.guid === '9f2743' ? 1016 : 1039
  const x = job.index % 10 * 744
  const y = Math.floor(job.index / 10) * cellHeight
  for (const thumbnail of [false, true]) {
    const output = outputPath(job, thumbnail)
    if (!force && existsSync(output)) continue
    const result = spawnSync('cwebp', [
      '-quiet', '-mt', '-q', '74', '-crop', String(x), String(y), '744', String(cellHeight),
      ...(thumbnail ? ['-resize', '448', '0'] : []), source, '-o', output,
    ], { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr || `could not write ${output}`)
    written++
  }
}

console.log(`Downfall card assets ready (${seen.size} cards, ${jobs.length} faces, ${written} files written).`)
