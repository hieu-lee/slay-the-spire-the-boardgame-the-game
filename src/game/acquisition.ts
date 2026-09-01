import { CARDS, cardIsCurse } from './cards.ts'
import { createRelicInstance, POTION_DECK, POTIONS, RELIC_DECK, RELICS, relicDef } from './relics.ts'
import { shuffle } from './rng.ts'
import type { RngState } from './rng.ts'
import type { Player } from './types.ts'
import { BASE_CHARACTER_IDS, CHARACTER_IDS, DOWNFALL_CHARACTER_IDS } from './types.ts'
import type { CharacterId } from './types.ts'
import { CHARACTER_UNLOCKS, createCampaignProgress } from './campaign.ts'
import type { CampaignProgress } from './campaign.ts'
import type { RuleSet } from './meta.ts'
import { GUARDIAN_CARDS_BY_ID, GUARDIAN_PHYSICAL_DECKS, resolveGuardianCardType } from './downfall/guardian.ts'
import { HERMIT_PHYSICAL_DECKS, fatalDesireGold } from './downfall/hermit.ts'
import { SLIME_BOSS_RARE_DECK, SLIME_BOSS_REWARD_DECK } from './downfall/slime-boss.ts'
import {
  cardNeedsCorruptedShard,
  DOWNFALL_COLORLESS_CARD_DEFS,
  DOWNFALL_COLORLESS_DECK,
  DOWNFALL_POTION_DECK,
  DOWNFALL_RELIC_DECK,
} from './downfall/items.ts'

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
  if (character === 'slime_boss') {
    return rare ? [...SLIME_BOSS_RARE_DECK] : [...SLIME_BOSS_REWARD_DECK, 'golden_ticket', 'golden_ticket']
  }
  if (character === 'guardian') {
    if (rare) return [...GUARDIAN_PHYSICAL_DECKS.rares]
    return GUARDIAN_PHYSICAL_DECKS.rewards.map((id) =>
      id === 'guardian_golden_ticket' ? 'golden_ticket' : id)
  }
  if (character === 'hermit') {
    if (rare) return [...HERMIT_PHYSICAL_DECKS.rares]
    return HERMIT_PHYSICAL_DECKS.rewards.map((id) =>
      id === 'hermit_golden_ticket' ? 'golden_ticket' : id)
  }
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

export function createItemDecks(rng: RngState, colorlessUnlocked: boolean, progress = createCampaignProgress(), activeCharacters: readonly CharacterId[] = [], ruleset?: RuleSet): ItemDecks {
  const downfall = ruleset === 'downfall' || activeCharacters.some((character) =>
    DOWNFALL_CHARACTER_IDS.some((id) => id === character))
  const inactive = (downfall ? CHARACTER_IDS : BASE_CHARACTER_IDS)
    .filter((character) => !activeCharacters.includes(character))
  return {
    relics: shuffle(rng, [...(downfall ? DOWNFALL_RELIC_DECK : RELIC_DECK)]),
    potions: shuffle(rng, [...(downfall ? DOWNFALL_POTION_DECK : POTION_DECK)]),
    colorless: colorlessUnlocked
      ? shuffle(rng, downfall ? [...DOWNFALL_COLORLESS_DECK]
        : Object.values(CARDS).filter((card) => card.owner === 'colorless' && !(card.id in DOWNFALL_COLORLESS_CARD_DEFS)).map((card) => card.id))
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

/** Printed card type for upgrades and other rules that resolve outside combat. */
export function acquisitionCardType(defId: string) {
  const def = CARDS[defId]
  const guardian = GUARDIAN_CARDS_BY_ID[defId]
  return guardian ? resolveGuardianCardType(guardian.type) : def?.type
}

function eggUpgrade(player: Player, defId: string, alreadyUpgraded: boolean): { player: Player; upgraded: boolean } {
  if (alreadyUpgraded) return { player, upgraded: true }
  const type = acquisitionCardType(defId)
  const eggId = type === 'attack' ? 'molten_egg' : type === 'skill' ? 'toxic_egg' : undefined
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
  const needsShard = CARDS[defId] && cardNeedsCorruptedShard(player.character, CARDS[defId]) &&
    !gained.player.relics.some((relic) => relic.defId === 'corrupted_shard')
  const next = {
    ...gained.player,
    deck: [...gained.player.deck, { uid, defId, upgraded: gained.upgraded }],
    relics: needsShard ? [...gained.player.relics, createRelicInstance('corrupted_shard')] : gained.player.relics,
  }
  const gold = defId === 'hermit_fatal_desire' ? fatalDesireGold('add', gained.upgraded) : 0
  return gold > 0 ? gainGold(next, gold) : next
}

export function gainRelic(player: Player, relicId: string, potionDeck?: string[], ascension = 0): Player {
  if (!RELICS[relicId] || player.relics.some((relic) => relic.defId === relicId)) return player
  if (relicId === 'old_coin') return gainGold(player, 10)
  let owner = { ...player, relics: [...player.relics, createRelicInstance(relicId)] }
  if (relicId === 'potion_belt' && potionDeck && !owner.relics.some((relic) => relic.defId === 'sozu')) {
    for (let count = 0; count < 2 && potionDeck.length > 0; count++) {
      const gained = gainPotion(owner, potionDeck[0]!, ascension)
      if (gained === owner) break
      potionDeck.shift()
      owner = gained
    }
  }
  return owner
}

export function gainGold(player: Player, amount: number): Player {
  return player.relics.some((relic) => relic.defId === 'ectoplasm')
    ? player
    : { ...player, gold: player.gold + amount }
}

export function healingCapFor(player: Pick<Player, 'maxHp' | 'relics'>, ruleset?: RuleSet): number {
  return ruleset !== 'downfall' && player.relics.some((relic) => relic.defId === 'mark_of_pain')
    ? Math.min(player.maxHp, 6)
    : player.maxHp
}

export function potionLimit(ascension: number, player?: Pick<Player, 'relics'>): number {
  return (ascension >= 4 ? 2 : 3) + (player?.relics.some((relic) => relic.defId === 'potion_belt') ? 2 : 0)
}

export function gainPotion(player: Player, potionId: string, ascension: number): Player {
  if (!POTIONS[potionId] || player.relics.some((relic) => relic.defId === 'sozu') || player.potions.length >= potionLimit(ascension, player)) return player
  return { ...player, potions: [...player.potions, potionId] }
}

export function removeCard(player: Player, uid: string): Player {
  const card = player.deck.find((candidate) => candidate.uid === uid)
  if (!card || card.defId === 'ascenders_bane') return player
  const maxHp = card.defId === 'parasite' ? Math.max(1, player.maxHp - 2) : player.maxHp
  const next = { ...player, hp: Math.min(player.hp, maxHp), maxHp,
    deck: player.deck.filter((candidate) => candidate.uid !== uid) }
  const gold = card.defId === 'hermit_fatal_desire' ? fatalDesireGold('remove', card.upgraded) : 0
  return gold > 0 ? gainGold(next, gold) : next
}

export function upgradeCard(player: Player, uid: string): Player {
  const card = player.deck.find((candidate) => candidate.uid === uid)
  if (!card || card.upgraded || !CARDS[card.defId]?.upgrade) return player
  return { ...player, deck: player.deck.map((candidate) => candidate.uid === uid ? { ...candidate, upgraded: true } : candidate) }
}

export function transformCard(_rng: RngState, player: Player, uid: string, newUid: string): Player {
  const old = player.deck.find((card) => card.uid === uid)
  if (!old || cardIsCurse(old.defId) || player.cardRewards.length === 0) return player
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
  if (def.type === 'curse') return 3
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
export function drawCardChoices(player: Pick<Player, 'cardRewards' | 'rareRewards'>, count = 3, replaceDuplicates = false): RewardDraw {
  const cardsDrawn: string[] = []
  const seen = new Set<string>()
  let cursor = 0
  let needed = count
  while (cursor < player.cardRewards.length && cardsDrawn.length < needed) {
    const id = player.cardRewards[cursor++]!
    cardsDrawn.push(id)
    if (replaceDuplicates && id !== 'golden_ticket' && seen.has(id)) needed++
    else seen.add(id)
  }
  const ticketCount = cardsDrawn.filter((id) => id === 'golden_ticket').length
  const raresDrawn = player.rareRewards.slice(0, ticketCount)
  return {
    cardsDrawn,
    raresDrawn,
    choices: [
      ...(replaceDuplicates
        ? new Set(cardsDrawn.filter((id) => id !== 'golden_ticket'))
        : cardsDrawn.filter((id) => id !== 'golden_ticket')),
      ...raresDrawn,
    ],
  }
}

export function bottomCardChoices(player: Player, draw: RewardDraw, chosenIndex: number | null | undefined): Player {
  const ordinaryChoiceCount = draw.choices.length - draw.raresDrawn.length
  const chosenOrdinary = chosenIndex !== null && chosenIndex !== undefined && chosenIndex < ordinaryChoiceCount
    ? draw.choices[chosenIndex] : undefined
  let chosenRemoved = false
  const unusedCards = draw.cardsDrawn.filter((id) => {
    if (id === 'golden_ticket') return true
    if (!chosenRemoved && id === chosenOrdinary) {
      chosenRemoved = true
      return false
    }
    return true
  })
  const unusedRares = draw.raresDrawn.filter((_id, index) => ordinaryChoiceCount + index !== chosenIndex)
  return {
    ...player,
    cardRewards: [...player.cardRewards.slice(draw.cardsDrawn.length), ...unusedCards],
    rareRewards: [...player.rareRewards.slice(draw.raresDrawn.length), ...unusedRares],
  }
}
