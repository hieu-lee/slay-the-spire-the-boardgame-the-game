import { CARDS } from './cards.ts'
import { createRelicInstance, POTION_DECK, RELIC_DECK, relicDef } from './relics.ts'
import { shuffle } from './rng.ts'
import type { RngState } from './rng.ts'
import type { Player } from './types.ts'
import type { CharacterId } from './types.ts'
import { CHARACTER_UNLOCKS, createCampaignProgress } from './campaign.ts'
import type { CampaignProgress } from './campaign.ts'

/** Shared physical item stacks. Their order is hidden from every client. */
export type ItemDecks = {
  relics: string[]
  potions: string[]
  colorless: string[]
  curses: string[]
  characterCards: Partial<Record<CharacterId, string[]>>
  characterRares: Partial<Record<CharacterId, string[]>>
}

export type ItemKind = 'relic' | 'potion'

export function characterRewardDeck(character: CharacterId, rare: boolean, progress: CampaignProgress): string[] {
  const locked = new Map(CHARACTER_UNLOCKS[character].flatMap((unlock) => unlock.components.flatMap((component) =>
    component.kind === 'card' ? [[component.cardId, unlock.boxes] as const] : [],
  )))
  const cards = Object.values(CARDS).flatMap((def) => {
    if (def.owner !== character || (locked.has(def.id) && progress.characters[character] < locked.get(def.id)!)) return []
    if (rare) return def.rarity === 'rare' ? [def.id] : []
    if (def.rarity === 'common') return Array(def.id === 'claw_claw_pack' ? 8 : 2).fill(def.id)
    return def.rarity === 'uncommon' ? [def.id] : []
  })
  if (!rare && characterRewardDeck(character, true, progress).length > 0) cards.push(...Array(progress.characters[character] >= 4 ? 2 : 1).fill('golden_ticket'))
  return cards
}

export function createItemDecks(rng: RngState, colorlessUnlocked: boolean, progress = createCampaignProgress(), activeCharacters: readonly CharacterId[] = []): ItemDecks {
  const inactive = (['ironclad', 'silent', 'defect', 'watcher'] as const).filter((character) => !activeCharacters.includes(character))
  return {
    relics: shuffle(rng, [...RELIC_DECK]),
    potions: shuffle(rng, [...POTION_DECK]),
    colorless: colorlessUnlocked
      ? shuffle(rng, Object.values(CARDS).filter((card) => card.owner === 'colorless').map((card) => card.id))
      : [],
    curses: shuffle(rng, Object.values(CARDS).filter((card) => card.owner === 'curse' && card.id !== 'ascenders_bane').flatMap((card) =>
      Array(['clumsy', 'injury', 'parasite', 'regret'].includes(card.id) ? 2 : 1).fill(card.id),
    )),
    characterCards: Object.fromEntries(inactive.map((character) => [character, shuffle(rng, characterRewardDeck(character, false, progress))])),
    characterRares: Object.fromEntries(inactive.map((character) => [character, shuffle(rng, characterRewardDeck(character, true, progress))])),
  }
}

/** Draws from the top and bottoms cards that cannot appear in this context. */
export function drawItems(deck: string[], count: number, blocked: ReadonlySet<string> = new Set()): string[] {
  const drawn: string[] = []
  const available = deck.length
  let inspected = 0
  while (drawn.length < count && inspected < available) {
    const id = deck.shift()
    if (!id) break
    inspected++
    if (blocked.has(id)) deck.push(id)
    else drawn.push(id)
  }
  return drawn
}

export function bottomItems(deck: string[], ids: readonly string[]): void {
  deck.push(...ids)
}

export function nextCardUid(players: readonly Player[]): () => string {
  let next = Math.max(0, ...players.flatMap((player) => player.deck.map((card) =>
    Number(/^c(\d+)$/.exec(card.uid)?.[1] ?? 0),
  )))
  return () => `c${++next}`
}

function eggUpgrade(player: Player, defId: string, alreadyUpgraded: boolean): { player: Player; upgraded: boolean } {
  if (alreadyUpgraded) return { player, upgraded: true }
  const eggId = CARDS[defId]?.type === 'attack' ? 'molten_egg'
    : CARDS[defId]?.type === 'skill' ? 'toxic_egg' : undefined
  const egg = eggId ? player.relics.find((relic) => relic.defId === eggId) : undefined
  const uses = egg ? egg.uses ?? relicDef(egg.defId).uses ?? 0 : 0
  if (!egg || uses < 1) return { player, upgraded: false }
  return {
    player: {
      ...player,
      relics: uses === 1
        ? player.relics.filter((relic) => relic !== egg)
        : player.relics.map((relic) => relic === egg ? { ...relic, uses: uses - 1 } : relic),
    },
    upgraded: true,
  }
}

/** One boundary for every permanent card gain, including finite Egg uses. */
export function addCard(player: Player, defId: string, uid: string, upgraded = false): Player {
  const gained = eggUpgrade(player, defId, upgraded)
  return { ...gained.player, deck: [...gained.player.deck, { uid, defId, upgraded: gained.upgraded }] }
}

export function gainRelic(player: Player, relicId: string): Player {
  if (!RELIC_DECK.includes(relicId as never) || player.relics.some((relic) => relic.defId === relicId)) return player
  if (relicId === 'old_coin') return gainGold(player, 10)
  return { ...player, relics: [...player.relics, createRelicInstance(relicId)] }
}

export function gainGold(player: Player, amount: number): Player {
  return player.relics.some((relic) => relic.defId === 'ectoplasm')
    ? player
    : { ...player, gold: player.gold + amount }
}

export function healingCapFor(player: Pick<Player, 'maxHp' | 'relics'>): number {
  return player.relics.some((relic) => relic.defId === 'mark_of_pain')
    ? Math.min(player.maxHp, 6)
    : player.maxHp
}

export function potionLimit(ascension: number): number {
  return ascension >= 4 ? 2 : 3
}

export function gainPotion(player: Player, potionId: string, ascension: number): Player {
  if (!POTION_DECK.includes(potionId as never) || player.relics.some((relic) => relic.defId === 'sozu') || player.potions.length >= potionLimit(ascension)) return player
  return { ...player, potions: [...player.potions, potionId] }
}

export function removeCard(player: Player, uid: string): Player {
  const card = player.deck.find((candidate) => candidate.uid === uid)
  if (!card || card.defId === 'ascenders_bane') return player
  const maxHp = card.defId === 'parasite' ? Math.max(1, player.maxHp - 2) : player.maxHp
  return { ...player, hp: Math.min(player.hp, maxHp), maxHp, deck: player.deck.filter((candidate) => candidate.uid !== uid) }
}

export function upgradeCard(player: Player, uid: string): Player {
  const card = player.deck.find((candidate) => candidate.uid === uid)
  if (!card || card.upgraded || !CARDS[card.defId]?.upgrade) return player
  return { ...player, deck: player.deck.map((candidate) => candidate.uid === uid ? { ...candidate, upgraded: true } : candidate) }
}

export function transformCard(_rng: RngState, player: Player, uid: string, newUid: string): Player {
  const old = player.deck.find((card) => card.uid === uid)
  if (!old || CARDS[old.defId]?.owner === 'curse' || player.cardRewards.length === 0) return player
  const [drawn, ...rest] = player.cardRewards
  if (!drawn) return player
  const [rare, ...rareRest] = player.rareRewards
  const replacement = drawn === 'golden_ticket' ? rare : drawn
  if (!replacement) return drawn === 'golden_ticket'
    ? { ...player, cardRewards: [...rest, 'golden_ticket'] }
    : player
  const withoutOld = {
    ...player,
    deck: player.deck.filter((card) => card.uid !== uid),
    cardRewards: [...rest, ...(drawn === 'golden_ticket' ? ['golden_ticket'] : [])],
    rareRewards: drawn === 'golden_ticket' ? rareRest : player.rareRewards,
  }
  return addCard(withoutOld, replacement, newUid)
}

export function merchantCardCost(defId: string): number | null {
  const def = CARDS[defId]
  if (!def || def.rarity === 'starter' || def.owner === 'curse' || def.owner === 'status') return null
  return def.rarity === 'common' ? 2 : def.rarity === 'uncommon' ? 3 : 6
}

export function merchantRelicCost(relicId: string, slot: number): number | null {
  const cost = relicDef(relicId).cost
  return cost === undefined ? null : Math.max(0, cost - (slot === 0 ? 1 : 0))
}

export function merchantRemovalCost(ascension: number): number {
  return ascension >= 8 ? 4 : 3
}

export type RewardDraw = {
  choices: string[]
  cardsDrawn: string[]
  raresDrawn: string[]
}

/** Golden Tickets are physical reward-deck cards, not selectable rewards. */
export function drawCardChoices(player: Pick<Player, 'cardRewards' | 'rareRewards'>, count = 3): RewardDraw {
  const cardsDrawn = player.cardRewards.slice(0, count)
  const ticketCount = cardsDrawn.filter((id) => id === 'golden_ticket').length
  const raresDrawn = player.rareRewards.slice(0, ticketCount)
  return {
    cardsDrawn,
    raresDrawn,
    choices: [...cardsDrawn.filter((id) => id !== 'golden_ticket'), ...raresDrawn],
  }
}

export function bottomCardChoices(player: Player, draw: RewardDraw, chosenIndex: number | null | undefined): Player {
  const ordinary = draw.cardsDrawn.filter((id) => id !== 'golden_ticket')
  let ordinaryIndex = -1
  const unusedCards = draw.cardsDrawn.filter((id) => {
    if (id === 'golden_ticket') return true
    ordinaryIndex++
    return ordinaryIndex !== chosenIndex
  })
  const unusedRares = draw.raresDrawn.filter((_id, index) => ordinary.length + index !== chosenIndex)
  return {
    ...player,
    cardRewards: [...player.cardRewards.slice(draw.cardsDrawn.length), ...unusedCards],
    rareRewards: [...player.rareRewards.slice(draw.raresDrawn.length), ...unusedRares],
  }
}
