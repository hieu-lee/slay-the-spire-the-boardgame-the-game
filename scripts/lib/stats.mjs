import { createHash } from 'node:crypto'
import { CARDS } from '../../src/game/cards.ts'

export const HERO_NAMES = {
  ironclad: 'Ironclad', silent: 'Silent', defect: 'Defect', watcher: 'Watcher',
  slime_boss: 'Slime Boss', guardian: 'Guardian', hexaghost: 'Hexaghost', hermit: 'Hermit',
}
export const SPECIFIC_ARCHETYPE_FLOOR = 15

const INITIAL_DECK_GROUPS = {
  'Ironclad Strength Scaling': [
    '92f60b0440aa36d701854608898bf5b97efa37c1ac658c31fdf1c07442c01182',
    'd1422ea6574ba723be595756609dd18bd202e1f16f7f71368e9994af669e612c',
  ],
  'Silent Poison': [
    '0ac8358f3baaba90fa7233df264c486bc2fbe9f5b46099bfaeb14165727dc06e',
    '6d8c98a01cf59ca83369217f2695eaa070b578d8975b7062f9dd9a319154befa',
    'b7df52160b7f91fc36ecd662aa65dc854bc18d94d4c7638315ba3fb6a8a12d02',
    'ad1ec28fea52f201b52860372b57ad2bbd0c9d030e550432679bf60235726cb4',
    '9852ef16a7d9968e33883428eb759365923ef7aa84266338e28e497ef5fbbfad',
    '18378ff89371054439ce20b142aeca135bf4d6a245dcb2d4fde47cb40431c851',
    'b3acb36c62d78b175d37aead61fe9f6fcc8a0ff61b5990515d06697517055dc3',
  ],
  'Silent Shiv Finisher': [
    'e09580cfee475b58446ebea4869de991f29a452653eb61879dc712dc774d4020',
  ],
  'Silent Other': [
    '95af68333f14b1b53e6f0266eb13df8d420658fa796041fb8a77015f71443d56',
    '129b9819fa2d4da84b2f6569e60146c746540e2dd4cdaccd583f171d58d7c6d6',
  ],
  'Defect Claw Spam': [
    'a9374b92fc732cc5da9fe83ee2883a1a14d9ddb96c513f1a997ef142d2708b91',
    '566e09fda766c89c07752540f713d61a28898ef3fd6676add52213e0e59184a2',
    'e776132fdd923795f484280b640b74448a7f47c4e105805ea3ac1649d5b0e643',
  ],
  'Defect Mixed Orb': [
    '9745faed931094934ec9e6c10198e76774deaf56eb3854c7d67d4164701d94f7',
    '0afa9c31ecffe1334585eed991434221fc5dc4497b7555b477b35b3b3f977e0d',
    '9daf0c78d00772c393bf682b498a022df53d8b398dbe3e6bcb86fee26786eaa1',
    'a93d8f9ea25d1bd6b4f1a02c95f7eb67d20ac17f4e8afcdbd86413a0c463762e',
    '980f5ee0d35770a2b31ffa3c9f2cb24f73b179c7b5f39355abe1f1ab6ac608a5',
    'ee9fee3e10535f861b99eccd7e1e36e5949658dd8e093226e07cb69105ba31f9',
    '6b69885a15ce2077b3c1adc737553834dc70d22b0a4c607c0b6fc701578225b1',
    'fe6964b4b2d7141b3ee14f320919b6806e8ac8b5e2d9ddf20bcd6060149ad645',
  ],
  'Watcher Stance Dance': [
    '84f1dc040a0e754635b57fc544657d3177f46fe1d55ae33d5f3120e545a575f8',
    '9f92cf0988837ab3de7ed5054796126bdcde7bc3cd079864e983586329091a42',
    '0b72e13365c94da69714351a13ea68da3c6a227b996b7ef5efda671ae169e7a5',
    '75eefd24f1003c107f0d3027fc470aa9a1f33456f764b28fb418dddbc512b064',
    'd4c75a045743fe247ebbfe4d68edc7a1e97babddef74cd077fa6385280c226e1',
    '5bf3ef8f47c61d31417153957449fa78d3143cd81e2e29b866a9d392a7e9d7cc',
    '48ef6393e30de702b8b86f9976716889f84f24b1ac3f572bde18db09fc20b84a',
    'ffd660d7ce25e325f28f5174fe8b5963d7cf24a5f11a8a0b19b83b27a8c373a5',
  ],
  'Slime Boss Tackle': [
    '1fee1f6fd5c0085cdddd766808da88be7a0d6745b37fce06ff770d716af7c903',
    '6e11e05a2fefadd304416daceae6638699c8bd920da8fed2f264887c1bcfd85c',
    '47781ceb6c5bdcff7cddbf628a718cf0838443b9bc2439c9a8163fc551c99eff',
    'a4576090c8a0ba4316d22d808bce532de6ecd91d32f5ed01550bd4cd45fa158f',
  ],
  'Hexaghost Heat and Soulburn': [
    '4a0207a375a63617f039405e6c3ff6ca2448f181c231d5572feb3e937e2938e0',
    '0b86cffa73da5956255b04702dfe3146ba87b1995bc715f3c2dcce17b5c98421',
  ],
}
export const INITIAL_DECK_TYPES = Object.keys(INITIAL_DECK_GROUPS)
export const INITIAL_DECK_CLASSIFICATIONS = new Map(Object.entries(INITIAL_DECK_GROUPS)
  .flatMap(([type, hashes]) => hashes.map((hash) => [hash, type])))

export const otherDeckType = (character) => `${HERO_NAMES[character]} Other`

export const validDeckType = (name) => typeof name === 'string' && name.length <= 70 &&
  /^(Ironclad|Silent|Defect|Watcher|Slime Boss|Guardian|Hexaghost|Hermit) [A-Za-z0-9 +/&'-]{3,60}$/.test(name)
export const validClassifierThreadId = (id) => typeof id === 'string' &&
  /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(id)

export const soloDeck = (run) => run.characters.length === 1
  ? run.winningDecks?.[0]?.finalDeck ?? run.finalDeck ?? null : null

export const deckHash = (run) => createHash('sha256').update(JSON.stringify(soloDeck(run))).digest('hex')

export function classificationRecord(run) {
  return { id: run.id, hero: run.character, hash: deckHash(run),
    ...(run.deckType ? { deckType: run.deckType } : {}),
    ...(run.deckClassificationRetry ? { retry: run.deckClassificationRetry } : {}) }
}

export function recordDeckClassification(store, run) {
  store.statsChanges?.set(run.id, classificationRecord(run))
}

const validCard = ({ defId, upgraded, attachedGemId }) => Object.hasOwn(CARDS, defId) &&
  (upgraded === false || upgraded === true && Boolean(CARDS[defId].upgrade)) && (attachedGemId === undefined ||
  CARDS[defId].guardian?.socket === true && Object.hasOwn(CARDS, attachedGemId) &&
  CARDS[attachedGemId].guardian?.printedType === 'Gem')

const deckIndexes = new WeakMap()
function indexDeck(deck) {
  let index = deckIndexes.get(deck)
  if (index) return index
  const hits = new Map()
  let valid = deck.length > 0
  for (const card of deck) {
    if (!card || !validCard(card)) { valid = false; break }
    hits.set(card.defId, (hits.get(card.defId) ?? 0) | (card.upgraded ? 2 : 1))
    if (card.attachedGemId) hits.set(card.attachedGemId, 1)
  }
  index = { valid, hits }
  deckIndexes.set(deck, index)
  return index
}

export function primeStatsDeck(run) {
  const deck = soloDeck(run)
  if (deck) indexDeck(deck)
}

export const validSoloDeck = (run) => {
  const deck = soloDeck(run)
  return Boolean(deck && indexDeck(deck).valid)
}

const bad = () => { throw Object.assign(new Error('Invalid stats query'), { status: 400 }) }

function queryOf(params) {
  const raw = params.get('q')
  if (!raw) return null
  if (raw.length > 2048) bad()
  let nodes = 0
  const validate = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || Array.isArray(node) || depth > 12 || ++nodes > 40) bad()
    if (node.op === 'card' && Object.keys(node).sort().join(',') === 'id,op,upgraded' &&
        typeof node.id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(node.id) &&
        [true, false, null].includes(node.upgraded)) return node
    if (node.op === 'not' && Object.keys(node).sort().join(',') === 'op,value') return { op: 'not', value: validate(node.value, depth + 1) }
    if (['and', 'or'].includes(node.op) && Object.keys(node).sort().join(',') === 'left,op,right') {
      return { op: node.op, left: validate(node.left, depth + 1), right: validate(node.right, depth + 1) }
    }
    bad()
  }
  try { return validate(JSON.parse(raw)) } catch { bad() }
}

function matches(hits, query) {
  if (!query) return true
  if (query.op === 'card') {
    const found = hits.get(query.id) ?? 0
    return query.upgraded === null ? found !== 0 : Boolean(found & (query.upgraded ? 2 : 1))
  }
  if (query.op === 'not') return !matches(hits, query.value)
  return query.op === 'and' ? matches(hits, query.left) && matches(hits, query.right)
    : matches(hits, query.left) || matches(hits, query.right)
}

function filtersOf(params) {
  const character = params.get('character') ?? 'all'
  const ascension = params.get('ascension') ?? 'all'
  const mode = params.get('mode') ?? 'all'
  if (character !== 'all' && !Object.hasOwn(HERO_NAMES, character) ||
      ascension !== 'all' && !/^(?:(?:[0-9]|1[0-3])|(?:[0-9]|10)\+)$/.test(ascension) ||
      mode !== 'all' && !['standard', 'daily', 'custom'].includes(mode)) bad()
  return { character, ascension, mode, query: queryOf(params) }
}

function eligibleRuns(runs, params) {
  const { character, ascension, mode, query } = filtersOf(params)
  return runs.filter((run) => {
    if (character !== 'all' && run.character !== character ||
        ascension !== 'all' && (ascension.endsWith('+')
          ? run.ascension < Number(ascension.slice(0, -1)) : run.ascension !== Number(ascension)) ||
        mode !== 'all' && run.mode !== mode) return false
    const deck = soloDeck(run)
    if (!deck) return false
    const index = indexDeck(deck)
    return index.valid && matches(index.hits, query)
  })
}

const emptyTotals = () => ({ runs: 0, floorRuns: 0, floors: 0, fights: 0, damage: 0, taken: 0, blocked: 0 })

function addTotals(totals, run) {
  totals.runs += 1
  if (run.floorsCleared != null) { totals.floorRuns += 1; totals.floors += run.floorsCleared }
  if (run.damageStatsComplete) {
    totals.fights += run.combatsFinished
    totals.damage += run.damageDealt
    totals.taken += run.damageTaken
    totals.blocked += run.damageBlocked
  }
}

function metrics(totals) {
  return { runs: totals.runs,
    averageFloors: totals.floorRuns ? totals.floors / totals.floorRuns : null,
    averageDamage: totals.fights ? totals.damage / totals.fights : null,
    averageBlock: totals.taken + totals.blocked ? totals.blocked / (totals.taken + totals.blocked) : null,
  }
}

export function statsSnapshot(runs, params = new URLSearchParams()) {
  const eligible = eligibleRuns(runs, params)
  const classified = eligible.filter((run) => run.deckType)
  const groups = new Map()
  for (const run of classified) {
    if (!groups.has(run.deckType)) groups.set(run.deckType, { character: run.character, totals: emptyTotals() })
    addTotals(groups.get(run.deckType).totals, run)
  }
  const rows = [...groups].map(([deckType, group]) => ({ deckType, character: group.character, ...metrics(group.totals) }))
    .sort((left, right) => right.runs - left.runs || (right.averageFloors ?? -1) - (left.averageFloors ?? -1) || left.deckType.localeCompare(right.deckType))

  const allTotals = emptyTotals()
  const cards = new Map()
  for (const run of eligible) {
    addTotals(allTotals, run)
    for (const id of indexDeck(soloDeck(run)).hits.keys()) {
      if (!cards.has(id)) cards.set(id, emptyTotals())
      addTotals(cards.get(id), run)
    }
  }
  const nextCards = [...cards].map(([defId, withCard]) => {
    if (withCard.runs === eligible.length || withCard.runs < 2) return null
    const withMetrics = metrics(withCard)
    const withoutMetrics = metrics(Object.fromEntries(Object.keys(allTotals).map((key) => [key, allTotals[key] - withCard[key]])))
    return { defId, ...withMetrics,
      deltaFloors: withMetrics.averageFloors === null || withoutMetrics.averageFloors === null ? null : withMetrics.averageFloors - withoutMetrics.averageFloors,
      deltaDamage: withMetrics.averageDamage === null || withoutMetrics.averageDamage === null ? null : withMetrics.averageDamage - withoutMetrics.averageDamage,
      deltaBlock: withMetrics.averageBlock === null || withoutMetrics.averageBlock === null ? null : withMetrics.averageBlock - withoutMetrics.averageBlock,
    }
  }).filter(Boolean).sort((left, right) => right.runs - left.runs || left.defId.localeCompare(right.defId)).slice(0, 24)
  return { ...metrics(allTotals), pending: eligible.length - classified.length, rows, nextCards }
}

export function randomDeck(runs, params = new URLSearchParams()) {
  const deckType = params.get('type')
  if (!validDeckType(deckType)) bad()
  const eligible = eligibleRuns(runs, params).filter((run) => run.deckType === deckType)
  if (!eligible.length) throw Object.assign(new Error('No matching deck'), { status: 404 })
  const run = eligible[Math.floor(Math.random() * eligible.length)]
  return { deckType, character: run.character, cards: soloDeck(run) }
}
