// A run: the campaign that strings map rooms and combats together.
//
// The combat engine knows nothing about the map, and the map knows nothing
// about combat. This module owns the seam — it builds a CombatState when the
// party enters a fighting room, and folds the result back into the run.
import { CARDS, STARTER_DECKS } from './cards.ts'
import { createCombat, startPlayerTurnWithChoices } from './combat.ts'
import type { CombatState } from './combat.ts'
import { createSummonSupply, drawSummon, enemyDef, startingHp } from './enemies.ts'
import type { SummonSupply } from './enemies.ts'
import { ACT_SHAPE, actIVMap, addBurningElite, generateMap, currentRoom, moveTo, isActComplete } from './map.ts'
import type { Room, RoomKind, SpireMap } from './map.ts'
import {
  bossRelicOfferSize,
  createRelicDecks,
  createRelicInstance,
  relicDef,
  STARTING_RELIC,
} from './relics.ts'
import { createRng, nextInt, pickMany, shuffle } from './rng.ts'
import type { RngState } from './rng.ts'
import type { CardInstance, CharacterId, Enemy, Player } from './types.ts'
import {
  canEnterActIV,
  createCampaignProgress,
  createSpireKeys,
  finishCampaign,
  isActIVUnlocked,
  isColorlessUnlocked,
} from './campaign.ts'
import type { CampaignProgress, SpireKeys } from './campaign.ts'
import { addCard, bottomCardChoices, characterRewardDeck, createItemDecks, drawCardChoices, drawItems, gainGold, gainPotion, healingCapFor, potionLimit, removeCard, transformCard, upgradeCard } from './acquisition.ts'
import type { ItemDecks } from './acquisition.ts'
import { dealNeow, neowCard } from './neow.ts'
import type { NeowDecision, NeowImmediateReward, NeowQueuedEffect, NeowRewardKind, NeowRewardOffer, NeowState } from './neow.ts'
import { EVENT_DEFINITIONS, buildEventDeck } from './events.ts'
import type { EventCard, EventEffect } from './events.ts'
import { createEventRoom, resolveEventBeforeRoll, resolveEventDecision } from './event-room.ts'
import type { EventDecision, EventRoomState } from './event-room.ts'
import {
  buyFromMerchant,
  closeMerchant,
  createMerchant,
  createRelicReward,
  resolveCourierOffer,
  decideRelicReward,
  removeAtMerchant,
  resolveRelicReward as resolveRoomRelicReward,
} from './noncombat.ts'
import type { CourierOffer, MerchantPurchase, MerchantState, RelicRewardState, TreasureDecision } from './noncombat.ts'

export type RunPhase =
  | 'neow'
  /** Choosing where to go next. */
  | 'map'
  | 'combat'
  | 'reward'
  | 'betweenCombat'
  /** A non-combat room the party is resolving. */
  | 'room'
  | 'victory'
  | 'defeat'

export type RunState = {
  rng: RngState
  seed: number
  /** Ascension 0 is the base game; 1-13 add the modifiers in docs/rules.md. */
  ascension: number
  act: number
  phase: RunPhase
  neow: NeowState | null
  map: SpireMap
  enemyDecks: EnemyDecks
  players: Player[]
  combat: CombatState | null
  /** Face-down shared physical deck. Its order is server-only. */
  potionDeck: string[]
  relicDeck: string[]
  bossRelicDeck: string[]
  /** Ascension 13's second distinct Act III boss, fought after the first. */
  pendingBossDefId: string | null
  rewards: CardRewardOffer[]
  rewardDestination: 'map' | 'combat' | 'betweenCombat' | 'victory' | null
  itemDecks: ItemDecks
  eventDeck: EventCard[]
  eventsVisited: number
  roomState: MerchantState | RelicRewardState | EventRoomState | null
  eventCombat: { kind: 'encounter' | 'elite' | 'boss'; mindBloom: boolean; bossDefId?: string } | null
  courier: { usedBy: string[]; offer: CourierOffer | null }
  chooseYourRelic: boolean
  campaignProgress: CampaignProgress
  campaign: {
    runId: string
    bossesDefeated: number
    highestBossActDefeated: 0 | 1 | 2 | 3 | 4
    keys: SpireKeys
    finalized: boolean
  }
  log: string[]
}

/** Keep the compatibility deck fields as mirrors of the one physical item supply. */
function mirrorItemSupplies(state: RunState, itemDecks: ItemDecks): RunState {
  return {
    ...state,
    itemDecks,
    relicDeck: [...itemDecks.relics],
    potionDeck: [...itemDecks.potions],
  }
}

/** Legacy combat/reward paths still update the flat fields; mirror those changes back. */
function mirrorLegacySupplies(state: RunState): RunState {
  return {
    ...state,
    itemDecks: {
      ...state.itemDecks,
      relics: [...state.relicDeck],
      potions: [...state.potionDeck],
    },
  }
}

export type CardRewardOffer = {
  playerId: string
  /** False when this encounter printed no card reward or it has been settled. */
  cardReward: boolean
  choices: string[] | null
  upgraded: boolean
  /** Indices drawn from the rare stack by Golden Tickets. Public once revealed. */
  rareChoiceIndices?: number[]
  /** Exact physical cards exposed by this reveal. */
  cardsDrawn?: string[]
  raresDrawn?: string[]
  /** False = none/settled, null = unrevealed, string = reserved face-up card. */
  potion: false | null | string
  /** Additional independent Potion rewards, resolved in physical source order. */
  potionQueue?: Array<null | string>
  /** Ordinary relic reward: face down, face up, or settled. */
  relic?: false | null | string
  /** Shared boss choices remain public until this player picks or skips. */
  bossRelics?: false | string[]
}

export type PotionRewardDecision =
  | { kind: 'gain' }
  | { kind: 'skip' }
  | { kind: 'pass'; playerId: string }
  | { kind: 'replace'; potionId: string }

export type PendingRelicPreview = { relicId: string; rewardChoices?: string[][] }

export const hasPendingRelicAcquisition = (state: {
  players: readonly { relics: readonly { pending?: boolean }[] }[]
}): boolean =>
  state.players.some((player) => player.relics.some((relic) => relic.pending))

export { healingCapFor }

export const canUpgradeCard = (card: Pick<CardInstance, 'defId' | 'upgraded'>): boolean =>
  !card.upgraded && CARDS[card.defId]?.upgrade !== undefined

export function pendingRelicEligibleCards(player: Pick<Player, 'deck'>, relicId: string): CardInstance[] {
  const starter = relicId === 'war_paint'
    ? player.deck.find((card) => card.defId.startsWith('defend_') && !card.upgraded)
    : relicId === 'whetstone' ? player.deck.find((card) => card.defId.startsWith('strike_') && !card.upgraded) : undefined
  return player.deck.filter((card) => {
    const type = CARDS[card.defId]?.type
    if (relicId === 'war_paint') return type === 'skill' && !card.upgraded && card.uid !== starter?.uid
    if (relicId === 'whetstone') return type === 'attack' && !card.upgraded && card.uid !== starter?.uid
    if (['astrolabe', 'tiny_house'].includes(relicId)) return canUpgradeCard(card)
    if (relicId === 'empty_cage') return card.defId !== 'ascenders_bane'
    if (relicId === 'pandoras_box') return type !== 'curse'
    return true
  })
}

export const ASCENSION_RULES = [
  'Standard rules',
  'A1: harder elites',
  'A2: lose 1 maximum HP',
  'A3: harder Events',
  'A4: Potion limit 2',
  "A5: add Ascender's Bane",
  'A6: heal 4 HP between Acts',
  'A7: harder encounters',
  'A8: Merchant removal costs 4',
  'A9: start 1 HP damaged',
  'A10: harder bosses',
  'A11: harder Act IV',
  'A12: harder elites',
  'A13: fight two different Act III bosses',
] as const

function expandCommonReward(raw: readonly string[], rare: readonly string[]): {
  choices: string[]
  rawIndices: number[]
  rareIndices: Array<number | null>
  rareCount: number
} {
  const choices: string[] = []
  const rawIndices: number[] = []
  const rareIndices: Array<number | null> = []
  let rareCount = 0
  raw.forEach((defId, rawIndex) => {
    const rareIndex = defId === GOLDEN_TICKET ? rareCount++ : null
    const choice = rareIndex === null ? defId : rare[rareIndex]
    if (!choice) return
    choices.push(choice)
    rawIndices.push(rawIndex)
    rareIndices.push(rareIndex)
  })
  return { choices, rawIndices, rareIndices, rareCount }
}

function pendingRewardChoices(player: Player, relicId: string): string[][] {
  if (relicId === 'enchiridion') return [player.rareRewards.slice(0, 5)]
  const count = relicId === 'orrery' ? 4 : relicId === 'tiny_house' ? 1 : 0
  const common = [...player.cardRewards]
  const rare = [...player.rareRewards]
  return Array.from({ length: count }, () => {
    const expanded = expandCommonReward(common.splice(0, 3), rare)
    rare.splice(0, expanded.rareCount)
    return expanded.choices
  })
}

/** Two physical Tickets are shuffled into every character reward deck. */
export const GOLDEN_TICKET = 'golden_ticket'

/** Max HP per character. Not printed in the rulebook — these come from the boards. */
export const MAX_HP: Record<CharacterId, number> = {
  ironclad: 10,
  silent: 9,
  defect: 9,
  watcher: 9,
}

export type EncounterCard = {
  defId: string
  goldReward: number
  cardReward: Enemy['cardReward']
  potionReward?: boolean
  relicReward?: boolean
  summons?: string[]
  randomSummons?: { group: string; count: number; soloCount?: number }
  summonsPerPlayer?: string[]
  randomSummonsPerPlayer?: { group: string; count: number }
  minAscension?: number
  maxAscension?: number
}

export type EnemyDecks = {
  act: number
  first: EncounterCard[]
  encounter: EncounterCard[]
  elite: EncounterCard[]
}

/** Implemented main-enemy cards, including the Act-specific printed reward. */
const ACT_ENCOUNTERS: Record<number, EncounterCard[]> = {
  1: [
    { defId: 'red_louse', goldReward: 1, cardReward: 'normal', summons: ['green_louse', 'red_louse'] },
    { defId: 'jaw_worm', goldReward: 1, cardReward: 'normal', maxAscension: 6 },
    { defId: 'cultist', goldReward: 1, cardReward: 'normal', summons: ['green_louse'] },
    { defId: 'cultist', goldReward: 1, cardReward: 'normal', potionReward: true, summons: ['spike_slime'] },
    { defId: 'looter', goldReward: 0, cardReward: 'normal', potionReward: true, maxAscension: 6 },
    { defId: 'blue_slaver', goldReward: 2, cardReward: 'normal' },
    { defId: 'red_slaver', goldReward: 1, cardReward: 'normal' },
    { defId: 'small_slime', goldReward: 1, cardReward: 'normal', summons: ['acid_slime', 'spike_slime'] },
    { defId: 'large_slime', goldReward: 1, cardReward: 'normal', potionReward: true, maxAscension: 6 },
    {
      defId: 'mad_gremlin', goldReward: 2, cardReward: 'normal',
      randomSummons: { group: 'gremlin', count: 3, soloCount: 2 },
    },
    {
      defId: 'sneaky_gremlin', goldReward: 1, cardReward: 'normal', potionReward: true,
      randomSummons: { group: 'gremlin', count: 3, soloCount: 2 },
    },
    { defId: 'fungi_beast', goldReward: 1, cardReward: 'normal', potionReward: true, summons: ['fungi_beast'] },
    { defId: 'large_slime', goldReward: 1, cardReward: 'normal', potionReward: true, minAscension: 7 },
    { defId: 'jaw_worm_a7', goldReward: 1, cardReward: 'normal', summons: ['spike_slime'], minAscension: 7 },
    { defId: 'looter', goldReward: 0, cardReward: 'normal', potionReward: true, summons: ['acid_slime'], minAscension: 7 },
  ],
  2: [
    { defId: 'chosen_14', goldReward: 1, cardReward: 'normal', potionReward: true, summons: ['cultist'] },
    { defId: 'chosen_16', goldReward: 2, cardReward: 'normal', summons: ['byrd'] },
    { defId: 'looter_hard', goldReward: 0, cardReward: 'normal', potionReward: true, summons: ['mugger'] },
    { defId: 'looter_hard', goldReward: 0, cardReward: 'normal', potionReward: true, summons: ['mugger'] },
    { defId: 'cultist', goldReward: 2, cardReward: 'normal', summons: ['cultist', 'cultist'] },
    { defId: 'snake_plant', goldReward: 1, cardReward: 'normal', maxAscension: 6 },
    { defId: 'shelled_parasite', goldReward: 0, cardReward: 'normal', potionReward: true, maxAscension: 6 },
    { defId: 'snecko', goldReward: 1, cardReward: 'normal' },
    { defId: 'byrd_encounter', goldReward: 1, cardReward: 'normal', summons: ['byrd', 'byrd'] },
    { defId: 'spheric_guardian', goldReward: 1, cardReward: 'normal', maxAscension: 6 },
    { defId: 'centurion_3b', goldReward: 1, cardReward: 'normal', potionReward: true, summons: ['mystic'] },
    { defId: 'centurion_b3', goldReward: 1, cardReward: 'normal', summons: ['mystic'] },
    { defId: 'snake_plant', goldReward: 1, cardReward: 'normal', minAscension: 7 },
    { defId: 'shelled_parasite', goldReward: 0, cardReward: 'normal', potionReward: true, summons: ['fungi_beast_a7'], minAscension: 7 },
    { defId: 'spheric_guardian', goldReward: 1, cardReward: 'normal', summons: ['sentry_a'], minAscension: 7 },
  ],
  3: [
    { defId: 'writhing_mass', goldReward: 0, cardReward: 'normal', potionReward: true },
    { defId: 'maw', goldReward: 1, cardReward: null, potionReward: true, maxAscension: 6 },
    { defId: 'darkling', goldReward: 0, cardReward: 'normal', potionReward: true, summons: ['darkling', 'darkling'] },
    { defId: 'transient', goldReward: 2, cardReward: 'normal' },
    { defId: 'orb_walker_3ws', goldReward: 1, cardReward: 'normal' },
    { defId: 'orb_walker_2s', goldReward: 1, cardReward: 'normal' },
    { defId: 'jaw_worm_act3', goldReward: 2, cardReward: 'normal', summons: ['jaw_worm_act3', 'jaw_worm_act3'] },
    { defId: 'spire_growth', goldReward: 1, cardReward: 'normal', potionReward: true },
    { defId: 'repulsor', goldReward: 0, cardReward: 'normal', potionReward: true, summons: ['exploder', 'spiker'], maxAscension: 6 },
    { defId: 'exploder', goldReward: 1, cardReward: 'normal', summons: ['repulsor', 'spiker'], maxAscension: 6 },
    { defId: 'exploder', goldReward: 1, cardReward: 'normal', summons: ['repulsor', 'spiker', 'spiker'], minAscension: 7 },
    { defId: 'repulsor', goldReward: 0, cardReward: 'normal', potionReward: true, summons: ['exploder', 'spheric_guardian'], minAscension: 7 },
    { defId: 'maw', goldReward: 1, cardReward: 'normal', minAscension: 7 },
  ],
}

/** The complete four-card fixed-opening deck. */
const FIRST_ENCOUNTERS: EncounterCard[] = [
  { defId: 'cultist', goldReward: 1, cardReward: 'normal' },
  { defId: 'jaw_worm_first', goldReward: 1, cardReward: 'normal', potionReward: true },
  { defId: 'red_louse_first', goldReward: 1, cardReward: null, summons: ['green_louse'] },
  { defId: 'small_slime', goldReward: 0, cardReward: 'normal', potionReward: true, summons: ['acid_slime'] },
]

/**
 * Card instance ids, counted per RUN rather than per module.
 *
 * This counter is only used while one run is being built. Later card rewards
 * derive their next id from that run's own deck, so creating another room
 * cannot rewind an older run's ids.
 */
let instanceCounter = 0
/**
 * What each room is called out loud.
 *
 * Keyed by RoomKind so an eighth kind fails to compile rather than silently
 * falling through to its own raw id in the log. (MapScreen holds a separate,
 * shorter label for the map badge — deliberately different wording.)
 */
export const ROOM_LABEL: Record<RoomKind, string> = {
  encounter: 'encounter',
  elite: 'elite fight',
  boss: 'boss fight',
  campfire: 'campfire',
  treasure: 'treasure room',
  merchant: 'merchant',
  // Called an Event on the map badge and the room screen; one name for one
  // room, not three.
  event: 'event',
}

/**
 * "an encounter", "a boss fight" — the phrase a player actually reads.
 *
 * The article comes from the LABEL, not from the room kind: they agree today
 * only by coincidence, and an `event` renamed to "mystery room" would have
 * read "an mystery room".
 */
export function enteringRoom(kind: string): string {
  const label = ROOM_LABEL[kind as RoomKind] ?? kind
  return `${/^[aeiou]/i.test(label) ? 'an' : 'a'} ${label}`
}

/** Card instance ids only need to be unique within a run. */
function makeInstance(defId: string): CardInstance {
  instanceCounter += 1
  return { uid: `c${instanceCounter}`, defId, upgraded: false }
}

export function createPlayer(
  rng: RngState,
  id: string,
  name: string,
  character: CharacterId,
  row: number,
  addedCards: readonly string[] = [],
  campaignProgress: CampaignProgress = createCampaignProgress(),
): Player {
  const deck = [...STARTER_DECKS[character], ...addedCards].map(makeInstance)
  const maxHp = MAX_HP[character]
  return {
    id,
    name,
    character,
    row,
    hp: maxHp,
    maxHp,
    block: 0,
    energy: 3,
    gold: 0,
    deck,
    draw: shuffle(rng, [...deck]),
    hand: [],
    discard: [],
    exhaust: [],
    powers: [],
    strength: 0,
    strengthLossAtEndOfTurn: 0,
    vulnerable: 0,
    weak: 0,
    drawLocked: false,
    lostHpThisCombat: false,
    hpLostThisRound: 0,
    hpLossLimitThisRound: undefined,
    freeCardsThisTurn: 0,
    freeAttacksThisTurn: 0,
    cardPlayLocked: false,
    doubledAttacksThisTurn: 0,
    tripledAttacksThisTurn: 0,
    doubledCardsThisTurn: 0,
    doubledSkillsThisTurn: 0,
    retainCardsThisTurn: 0,
    cardsPlayedThisTurn: 0,
    attacksPlayedThisTurn: 0,
    shivs: 0,
    shivDamageBonus: 0,
    cardBlockBonus: 0,
    hitPoison: 0,
    starterStrikeDamageBonus: 0,
    clawCubesGainedThisCombat: 0,
    starterDefendBlockBonus: 0,
    miracles: 0,
    stance: 'neutral',
    wrathAttackDamageBonus: 0,
    orbs: [null, null, null],
    orbEvokeBonus: 0,
    darkOrbEvokeBonus: 0,
    orbEndTurnBonus: 0,
    lightningEndTurnBonus: 0,
    relics: [{ defId: STARTING_RELIC[character] ?? 'burning_blood', spent: false }],
    potions: [],
    cardRewards: shuffle(rng, characterRewardDeck(character, false, campaignProgress)),
    rareRewards: shuffle(rng, characterRewardDeck(character, true, campaignProgress)),
    dead: false,
  }
}

export type PartyMember = { id: string; name: string; character: CharacterId }

export function createRun(
  seed: number,
  party: PartyMember[],
  ascension = 0,
  campaignProgress: CampaignProgress = createCampaignProgress(),
  chooseYourRelic = false,
): RunState {
  if (party.length < 1 || party.length > 4) throw new Error('a run requires 1 to 4 players')
  instanceCounter = 0
  const rng = createRng(seed)
  const players = party.map((member, index) =>
    createPlayer(
      rng,
      member.id,
      member.name,
      member.character,
      index,
      ascension >= 5 ? ['ascenders_bane'] : [],
      campaignProgress,
    ),
  )
  if (ascension >= 2) {
    for (const player of players) {
      player.maxHp -= 1
      player.hp -= 1
    }
  }
  if (ascension >= 9) for (const player of players) player.hp -= 1

  const relicDecks = createRelicDecks(rng)
  const keys = createSpireKeys()
  const baseMap = generateMap(rng, 1, ACT_SHAPE, ascension)
  const map = isActIVUnlocked(campaignProgress) ? addBurningElite(rng, baseMap) : baseMap
  const colorlessUnlocked = isColorlessUnlocked(campaignProgress)
  const itemDecks = createItemDecks(rng, colorlessUnlocked, campaignProgress, party.map((member) => member.character))
  itemDecks.relics = [...relicDecks.relicDeck]
  const dealt = dealNeow(rng, players.map((player) => player.id), colorlessUnlocked)
  const neow: NeowState = {
    deck: dealt.deck,
    players: Object.fromEntries(players.map((player) => {
      return [player.id, {
        cardId: dealt.dealt[player.id]!,
        redGoldPending: true,
        redRewardPending: true,
        redReward: null,
        blueOption: null,
        pendingEffect: null,
        rewardKind: null,
        reward: null,
        rewardQueue: [],
        done: false,
      }]
    })),
  }
  const nextRunNumber = (campaignProgress.nextRunNumber ?? 0) + 1
  const nextCampaignProgress = { ...campaignProgress, nextRunNumber }
  return {
    rng,
    seed,
    ascension,
    act: 1,
    phase: 'neow',
    neow,
    map,
    enemyDecks: createEnemyDecks(rng, 1, ascension),
    players,
    combat: null,
    potionDeck: [...itemDecks.potions],
    relicDeck: [...itemDecks.relics],
    bossRelicDeck: relicDecks.bossRelicDeck,
    pendingBossDefId: null,
    rewards: [],
    rewardDestination: null,
    itemDecks,
    eventDeck: buildEventDeck(rng, 1, ascension, colorlessUnlocked),
    eventsVisited: 0,
    roomState: null,
    eventCombat: null,
    courier: { usedBy: [], offer: null },
    chooseYourRelic: chooseYourRelic && party.length > 1,
    campaignProgress: nextCampaignProgress,
    campaign: {
      runId: `campaign-${nextRunNumber}`,
      bossesDefeated: 0,
      highestBossActDefeated: 0,
      keys,
      finalized: false,
    },
    log: ['The party enters the Spire.'],
  }
}

function neowCardOffer(player: Player, kind: 'card' | 'rare'): NeowRewardOffer {
  if (kind === 'card') return { kind, ...drawCardChoices(player) }
  const cardsDrawn = player.rareRewards.slice(0, 3)
  return { kind, choices: [...cardsDrawn], cardsDrawn, raresDrawn: [] }
}

function nextNeowReward(state: RunState, playerId: string): RunState {
  let next = state
  while (true) {
    const progress = next.neow?.players[playerId]
    if (!next.neow || !progress || progress.pendingEffect || progress.rewardKind || progress.reward ||
      hasPendingRelicAcquisition(next) || progress.rewardQueue.length === 0) return next
    const [kind, ...rewardQueue] = progress.rewardQueue
    if (!kind) return next
    if (typeof kind === 'string') return {
      ...next,
      neow: {
        ...next.neow,
        players: { ...next.neow.players, [playerId]: { ...progress, rewardKind: kind, reward: null, rewardQueue } },
      },
    }
    if (['upgrade', 'remove', 'transform', 'gold', 'randomRare'].includes(kind.kind)) return {
      ...next,
      neow: {
        ...next.neow,
        players: { ...next.neow.players, [playerId]: { ...progress, pendingEffect: kind as NeowImmediateReward, rewardQueue } },
      },
    }
    const owner = next.players.find((candidate) => candidate.id === playerId)
    const curse = kind.kind === 'curse' && owner && !owner.relics.some((relic) => relic.defId === 'omamori')
      ? next.itemDecks.curses[0] : undefined
    const hp = owner && kind.kind === 'loseHp' ? Math.max(0, owner.hp - kind.amount) : undefined
    next = {
      ...next,
      players: next.players.map((candidate) => candidate.id !== playerId ? candidate
        : curse ? addCard(candidate, curse, `c${nextRunUid(next.players)}`)
          : kind.kind === 'loseGold' ? { ...candidate, gold: Math.max(0, candidate.gold - kind.amount) }
            : hp === undefined ? candidate : { ...candidate, hp, dead: hp === 0 }),
      itemDecks: curse ? { ...next.itemDecks, curses: next.itemDecks.curses.slice(1) } : next.itemDecks,
      neow: {
        ...next.neow,
        players: { ...next.neow.players, [playerId]: { ...progress, rewardQueue } },
      },
    }
    if (hp === 0) return { ...next, phase: 'defeat', neow: null }
  }
}

function finishNeowIfReady(state: RunState): RunState {
  if (!state.neow || !Object.values(state.neow.players).every((progress) => progress.done) || hasPendingRelicAcquisition(state)) return state
  const solo = state.players.length === 1
  return {
    ...state,
    phase: 'map',
    neow: null,
    players: solo ? state.players.map((player) => ({
      ...player,
      gold: player.gold + 2,
      relics: player.relics.some((relic) => relic.defId === 'loaded_die')
        ? player.relics : [...player.relics, createRelicInstance('loaded_die')],
    })) : state.players,
    log: [...state.log, 'Neow puts the Blessing deck away.'],
  }
}

function completeNeowPlayer(state: RunState, playerId: string): RunState {
  const progress = state.neow?.players[playerId]
  if (!state.neow || !progress) return state
  return finishNeowIfReady({
    ...state,
    neow: { ...state.neow, players: { ...state.neow.players, [playerId]: { ...progress, done: true } } },
  })
}

function finishNeowStep(state: RunState, playerId: string): RunState {
  const progress = state.neow?.players[playerId]
  return progress?.pendingEffect || progress?.rewardKind || progress?.rewardQueue.length || hasPendingRelicAcquisition(state)
    ? state : completeNeowPlayer(state, playerId)
}

function availableTransformRewards(player: Pick<Player, 'cardRewards' | 'rareRewards'>): number {
  return player.cardRewards.filter((id) => id !== GOLDEN_TICKET).length +
    Math.min(player.cardRewards.filter((id) => id === GOLDEN_TICKET).length, player.rareRewards.length)
}

/** Public, authoritative Neow state. The remaining face-down deck is intentionally omitted. */
export function neowPreview(state: RunState, playerId: string): {
  card: ReturnType<typeof neowCard>
  redGoldPending: boolean
  redRewardPending: boolean
  redReward: NeowRewardOffer | null
  blueOption: number | null
  pendingEffect: NeowImmediateReward | null
  rewardKind: NeowRewardKind | null
  reward: NeowRewardOffer | null
  done: boolean
} | null {
  const progress = state.phase === 'neow' ? state.neow?.players[playerId] : undefined
  if (!progress) return null
  return {
    card: neowCard(progress.cardId),
    redGoldPending: progress.redGoldPending,
    redRewardPending: progress.redRewardPending,
    redReward: structuredClone(progress.redReward),
    blueOption: progress.blueOption,
    pendingEffect: structuredClone(progress.pendingEffect),
    rewardKind: progress.rewardKind,
    reward: structuredClone(progress.reward),
    done: progress.done,
  }
}

/** Gain or skip the independent Gold part of Neow's red reward. */
export function resolveNeowGold(state: RunState, playerId: string, gain: boolean): RunState {
  const progress = state.neow?.players[playerId]
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (state.phase !== 'neow' || !state.neow || !progress?.redGoldPending || !player ||
    progress.redReward || progress.done || hasPendingRelicAcquisition(state)) return state
  return {
    ...state,
    players: gain ? state.players.map((candidate) => candidate.id === playerId ? gainGold(candidate, 3) : candidate) : state.players,
    neow: { ...state.neow, players: { ...state.neow.players, [playerId]: { ...progress, redGoldPending: false } } },
  }
}

/** Reveal the current face-down reward. Merely staging it never advances a physical deck. */
export function revealNeowReward(state: RunState, playerId: string): RunState {
  const neow = state.neow
  const progress = neow?.players[playerId]
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (state.phase !== 'neow' || !neow || !progress || !player || progress.done ||
    progress.redGoldPending || hasPendingRelicAcquisition(state) || progress.redReward || progress.reward) return state
  const kind = progress.redRewardPending ? 'card' : progress.rewardKind
  if (!kind) return state
  let itemDecks = state.itemDecks
  let potionDeck = state.potionDeck
  let relicDeck = state.relicDeck
  let offer: NeowRewardOffer
  if (kind === 'colorless') {
    const choices = state.itemDecks.colorless.slice(0, 3)
    itemDecks = { ...state.itemDecks, colorless: state.itemDecks.colorless.slice(choices.length) }
    offer = { kind, choices, cardsDrawn: [...choices], raresDrawn: [] }
  } else if (kind === 'potion') {
    const potionId = state.potionDeck[0]
    potionDeck = potionId ? state.potionDeck.slice(1) : state.potionDeck
    itemDecks = { ...state.itemDecks, potions: [...potionDeck] }
    offer = { kind, choices: potionId ? [potionId] : [], cardsDrawn: potionId ? [potionId] : [], raresDrawn: [] }
  } else if (kind === 'relic') {
    const relicId = state.relicDeck[0]
    relicDeck = relicId ? state.relicDeck.slice(1) : state.relicDeck
    itemDecks = { ...state.itemDecks, relics: [...relicDeck] }
    offer = { kind, choices: relicId ? [relicId] : [], cardsDrawn: relicId ? [relicId] : [], raresDrawn: [] }
  } else offer = neowCardOffer(player, kind)
  return {
    ...state,
    itemDecks,
    potionDeck,
    relicDeck,
    neow: {
      ...neow,
      players: { ...neow.players, [playerId]: progress.redRewardPending
        ? { ...progress, redReward: offer }
        : { ...progress, reward: offer } },
    },
  }
}

/** Resolve the red Card Reward, or the currently staged blue reward. */
export function resolveNeowReward(
  state: RunState,
  playerId: string,
  choice: number | null | PotionRewardDecision,
): RunState {
  const neow = state.neow
  const progress = neow?.players[playerId]
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (state.phase !== 'neow' || !neow || !progress || !player || progress.redGoldPending || progress.done || hasPendingRelicAcquisition(state)) return state
  const red = progress.redRewardPending
  const offer = red ? progress.redReward : progress.reward
  const kind = red ? 'card' : progress.rewardKind
  if (!kind) return state
  if (!offer) {
    if (choice !== null) return state
    let next: RunState = {
      ...state,
      neow: { ...neow, players: { ...neow.players, [playerId]: red
        ? { ...progress, redRewardPending: false }
        : { ...progress, rewardKind: null } } },
    }
    if (red) return next
    next = nextNeowReward(next, playerId)
    return finishNeowStep(next, playerId)
  }
  if (offer.kind === 'potion') {
    if (typeof choice !== 'object' || choice === null) return state
    const potionId = offer.choices[0]
    let players = state.players
    let returned: string[] = []
    if (potionId) {
      const limit = potionLimitFor(state.ascension)
      let recipient = player
      if (choice.kind === 'skip') returned = [potionId]
      else if (choice.kind === 'pass') {
        const target = state.players.find((candidate) => candidate.id === choice.playerId)
        if (!target || target.dead || target.id === playerId || !canGainPotion(target, limit)) return state
        recipient = target
      } else if (choice.kind === 'replace') {
        const held = player.potions.indexOf(choice.potionId)
        if (held < 0 || player.relics.some((relic) => relic.defId === 'sozu')) return state
        returned = [choice.potionId]
      } else if (!canGainPotion(player, limit)) return state
      if (choice.kind !== 'skip') players = state.players.map((candidate) => candidate.id !== recipient.id ? candidate : {
        ...candidate,
        potions: choice.kind === 'replace'
          ? [...candidate.potions.filter((_id, index) => index !== candidate.potions.indexOf(choice.potionId)), potionId]
          : [...candidate.potions, potionId],
      })
    }
    let next: RunState = mirrorLegacySupplies({
      ...state,
      players,
      potionDeck: [...state.potionDeck, ...returned],
      neow: { ...neow, players: { ...neow.players, [playerId]: { ...progress, rewardKind: null, reward: null } } },
    })
    next = nextNeowReward(next, playerId)
    return finishNeowStep(next, playerId)
  }
  if (choice !== null && (typeof choice === 'object' || !Number.isInteger(choice) || choice < 0 || choice >= offer.choices.length)) return state
  let owner = player
  if (offer.kind === 'card') {
    const draw = { choices: offer.choices, cardsDrawn: offer.cardsDrawn, raresDrawn: offer.raresDrawn }
    owner = bottomCardChoices(owner, draw, choice)
  } else if (offer.kind === 'rare') {
    owner = { ...owner, rareRewards: [...owner.rareRewards.slice(offer.cardsDrawn.length),
      ...offer.cardsDrawn.filter((_id, index) => index !== choice)] }
  } else if (offer.kind === 'colorless') {
    const selected = choice === null ? undefined : offer.choices[choice]
    const unused = offer.choices.filter((_id, index) => index !== choice)
    owner = selected ? addCard(owner, selected, `c${nextRunUid(state.players)}`) : owner
    const itemDecks = { ...state.itemDecks, colorless: [...state.itemDecks.colorless, ...unused] }
    state = { ...state, itemDecks }
  } else {
    const relicId = choice === null ? undefined : offer.choices[choice]
    if (choice === null) {
      state = mirrorLegacySupplies({ ...state, relicDeck: [...state.relicDeck, ...offer.cardsDrawn] })
    } else if (relicId) state = acquireRelic(state, playerId, relicId)
    owner = state.players.find((candidate) => candidate.id === playerId) ?? owner
  }
  const selected = choice === null ? undefined : offer.choices[choice]
  if (selected && (offer.kind === 'card' || offer.kind === 'rare')) owner = addCard(owner, selected, `c${nextRunUid(state.players)}`)
  let next: RunState = {
    ...state,
    players: state.players.map((candidate) => candidate.id === playerId ? owner : candidate),
    neow: {
      ...neow,
      players: { ...neow.players, [playerId]: red
        ? { ...progress, redRewardPending: false, redReward: null }
        : { ...progress, rewardKind: null, reward: null } },
    },
  }
  if (red) return next
  next = nextNeowReward(next, playerId)
  return finishNeowStep(next, playerId)
}

function neowEffectCards(player: Player, effect: NeowImmediateReward): { eligible: CardInstance[]; required: number } {
  if (!['upgrade', 'remove', 'transform'].includes(effect.kind)) return { eligible: [], required: 0 }
  const eligible = effect.kind === 'upgrade' ? player.deck.filter(canUpgradeCard)
    : effect.kind === 'remove' ? player.deck.filter((card) => card.defId !== 'ascenders_bane')
      : player.deck.filter((card) => CARDS[card.defId]?.owner !== 'curse')
  const supply = effect.kind === 'transform' ? availableTransformRewards(player) : Number.POSITIVE_INFINITY
  return { eligible, required: Math.min('count' in effect ? effect.count : 0, eligible.length, supply) }
}

/** Resolve or independently skip the current immediate positive Neow reward. */
export function resolveNeowEffect(
  state: RunState,
  playerId: string,
  gain: boolean,
  decision: NeowDecision = {},
): RunState {
  const progress = state.neow?.players[playerId]
  const player = state.players.find((candidate) => candidate.id === playerId)
  const effect = progress?.pendingEffect
  if (state.phase !== 'neow' || !state.neow || !progress || !player || !effect || progress.done || hasPendingRelicAcquisition(state)) return state
  const cardUids = decision.cardUids ?? []
  const selection = neowEffectCards(player, effect)
  if (!gain) {
    if (cardUids.length > 0) return state
  } else if (effect.kind === 'upgrade' && effect.random) {
    if (cardUids.length > 0) return state
  } else if (new Set(cardUids).size !== cardUids.length || cardUids.length !== selection.required ||
    cardUids.some((uid) => !selection.eligible.some((card) => card.uid === uid))) return state

  const rng = { ...state.rng }
  let owner = player
  let uid = nextRunUid(state.players)
  if (gain) {
    if (effect.kind === 'upgrade') {
      const chosen = effect.random ? pickMany(rng, selection.eligible, selection.required).map((card) => card.uid) : cardUids
      for (const cardUid of chosen) owner = upgradeCard(owner, cardUid)
    } else if (effect.kind === 'remove') {
      for (const cardUid of cardUids) owner = removeCard(owner, cardUid)
    } else if (effect.kind === 'transform') {
      for (const cardUid of cardUids) owner = transformCard(rng, owner, cardUid, `c${uid++}`)
    } else if (effect.kind === 'gold') owner = gainGold(owner, effect.amount)
    else {
      const [rare, ...rareRewards] = owner.rareRewards
      if (rare) owner = addCard({ ...owner, rareRewards }, rare, `c${uid++}`)
    }
  }
  let next: RunState = {
    ...state,
    rng,
    players: state.players.map((candidate) => candidate.id === playerId ? owner : candidate),
    neow: { ...state.neow, players: { ...state.neow.players, [playerId]: { ...progress, pendingEffect: null } } },
  }
  next = nextNeowReward(next, playerId)
  return finishNeowStep(next, playerId)
}

/** Choose one printed blue option; clients supply selections, never effects. */
export function chooseNeow(
  state: RunState,
  playerId: string,
  optionIndex: number,
  decision: NeowDecision = {},
): RunState {
  const progress = state.neow?.players[playerId]
  const player = state.players.find((candidate) => candidate.id === playerId)
  const card = progress ? neowCard(progress.cardId) : undefined
  const option = card?.options[optionIndex]
  if (state.phase !== 'neow' || !state.neow || !progress || !player || progress.redGoldPending || progress.redRewardPending ||
    progress.pendingEffect || progress.rewardKind || progress.blueOption !== null ||
    progress.done || hasPendingRelicAcquisition(state) || !Number.isInteger(optionIndex) || !option) return state
  const cardUids = decision.cardUids ?? []
  if (cardUids.length > 0) return state
  let next: RunState = state
  let queue: NeowQueuedEffect[] = []
  for (const effect of option.effects) {
    if (effect.kind === 'reward') queue.push(...Array(effect.count).fill(effect.reward))
    else if (effect.kind === 'potions') queue.push(...Array(effect.count).fill('potion' as const))
    else if (effect.kind === 'relic') queue.push('relic')
    else queue.push(effect)
  }
  next = {
    ...next,
    neow: { ...state.neow, players: { ...state.neow.players, [playerId]: { ...progress, blueOption: optionIndex, pendingEffect: null, rewardKind: null, rewardQueue: queue } } },
  }
  next = nextNeowReward(next, playerId)
  return finishNeowStep(next, playerId)
}

const ELITES: Record<number, EncounterCard[]> = {
  1: [
    { defId: 'gremlin_nob', goldReward: 2, cardReward: 'normal', relicReward: true },
    { defId: 'lagavulin', goldReward: 2, cardReward: 'normal', relicReward: true },
    { defId: 'sentries', goldReward: 2, cardReward: 'normal', relicReward: true },
  ],
  2: [
    { defId: 'book_of_stabbing', goldReward: 2, cardReward: 'upgraded', relicReward: true },
    { defId: 'gremlin_leader', goldReward: 2, cardReward: 'upgraded', relicReward: true, randomSummonsPerPlayer: { group: 'gremlin', count: 2 } },
    { defId: 'taskmaster', goldReward: 2, cardReward: 'upgraded', relicReward: true, summonsPerPlayer: ['blue_slaver', 'red_slaver'] },
  ],
  3: [
    { defId: 'reptomancer', goldReward: 3, cardReward: 'upgraded', relicReward: true },
    { defId: 'nemesis', goldReward: 3, cardReward: 'upgraded', relicReward: true },
    { defId: 'giant_head', goldReward: 3, cardReward: 'upgraded', relicReward: true },
  ],
  4: [
    { defId: 'spire_shield', goldReward: 0, cardReward: null },
  ],
}

const BOSSES: Record<number, string[]> = {
  1: ['guardian_attack', 'hexaghost', 'slime_boss'],
  2: ['the_collector', 'bronze_automaton', 'the_champ'],
  3: ['donu', 'awakened_one_phase_1', 'time_eater'],
  4: ['corrupt_heart'],
}

function createEnemyDecks(rng: RngState, act: number, ascension: number): EnemyDecks {
  const eligible = (cards: EncounterCard[]) => cards.filter((card) =>
    ascension >= (card.minAscension ?? 0) && ascension <= (card.maxAscension ?? Number.POSITIVE_INFINITY))
  return {
    act,
    first: act === 1 ? shuffle(rng, [...FIRST_ENCOUNTERS]) : [],
    encounter: shuffle(rng, eligible(ACT_ENCOUNTERS[act] ?? [])),
    elite: shuffle(rng, eligible(ELITES[act] ?? [])),
  }
}

/** Draws from the top and returns used cards to the bottom (rulebook p.13). */
function drawCards<T>(deck: T[], count: number): T[] {
  if (deck.length === 0) return []
  const drawn: T[] = []
  for (let index = 0; index < count; index++) {
    const card = deck.shift()
    if (!card) break
    drawn.push(card)
    deck.push(card)
  }
  return drawn
}

function spawn(
  defId: string,
  uid: string,
  row: number,
  hp: number,
  isBoss: boolean,
  goldReward: number,
  cardReward: Enemy['cardReward'],
  ascension = 0,
  potionReward = false,
  relicReward = false,
  actsLast = false,
): Enemy {
  return {
    uid,
    defId,
    row,
    isBoss,
    actsLast,
    ascension,
    hp,
    maxHp: hp,
    block: 0,
    strength: 0,
    vulnerable: 0,
    weak: 0,
    poison: 0,
    goldReward,
    cardReward,
    potionReward,
    relicReward,
    actionIndex: 0,
    phase: 0,
    abilityUsed: false,
    dead: false,
  }
}

/**
 * Builds the enemies for a room.
 *
 * An encounter draws one enemy per player row (p.10). An elite places a single
 * elite in the bottom row (p.11). A boss is a single enemy treated as being in
 * every row, and it acts last.
 */
function buildEncounter(
  rng: RngState,
  decks: EnemyDecks,
  act: number,
  players: Player[],
  kind: 'encounter' | 'elite' | 'boss',
  first = false,
  ascension = 0,
  forcedBossDefId?: string,
): { enemies: Enemy[]; summonSupply: SummonSupply; nextBossDefId?: string } {
  const count = players.length
  const summonSupply = createSummonSupply(rng)

  if (kind === 'boss') {
    const row = players[players.length - 1]?.row ?? 0
    const deck = BOSSES[act] ?? BOSSES[1]!
    const first = nextInt(rng, deck.length)
    const defId = forcedBossDefId ?? deck[first]!
    const nextBossDefId = !forcedBossDefId && act === 3 && ascension >= 13
      ? deck[(first + 1 + nextInt(rng, deck.length - 1)) % deck.length]!
      : undefined
    const enemies = [spawn(
      defId,
      'boss-0',
      row,
      startingHp(enemyDef(defId, ascension), count),
      true,
      0,
      null,
      ascension,
    )]
    const summon = (boss: Enemy, group: string, summonRow: number, uid: string, isBoss = false) => {
      const defId = drawSummon(summonSupply, group)
      if (!defId) return
      enemies.splice(enemies.indexOf(boss), 0, spawn(
        defId, uid, summonRow, startingHp(enemyDef(defId, ascension), count), isBoss, 0, null, ascension,
      ))
    }
    for (const boss of [...enemies]) {
      if (boss.defId === 'bronze_automaton') {
        for (const player of players) summon(boss, 'bronze_orb', player.row, `${boss.uid}-orb-${player.row}`)
      } else if (boss.defId === 'awakened_one_phase_1') {
        for (const player of players) for (let index = 0; index < 2; index++) {
          summon(boss, 'cultist', player.row, `${boss.uid}-cultist-${player.row}-${index}`)
        }
      } else if (boss.defId === 'donu') {
        const defId = 'deca'
        enemies.splice(enemies.indexOf(boss), 0, spawn(
          defId, `${boss.uid}-deca`, row, startingHp(enemyDef(defId, ascension), count), true, 0, null, ascension,
        ))
      }
    }
    return { enemies, summonSupply, nextBossDefId }
  }

  if (kind === 'elite') {
    const card = drawCards(decks.elite, 1)[0] ?? {
      ...ELITES[1]![0]!,
      goldReward: act === 3 ? 3 : 2,
      cardReward: act === 1 ? 'normal' as const : 'upgraded' as const,
    }
    const hp = startingHp(enemyDef(card.defId, ascension), count)
    // Elites are placed in the bottom row (p.11).
    const row = players[0]?.row ?? 0
    const elite = spawn(
      card.defId, 'elite', row, hp, false, card.goldReward, card.cardReward,
      ascension,
      card.potionReward === true,
      card.relicReward === true,
    )
    const enemies: Enemy[] = []
    if (card.defId === 'spire_shield') {
      const spear = enemyDef('spire_spear', ascension)
      enemies.push(spawn(
        spear.id,
        'elite-spear',
        3,
        startingHp(spear, count),
        false,
        0,
        null,
        ascension,
      ))
      elite.row = 0
    }
    if (card.defId === 'sentries') {
      let next = 'sentry_a'
      for (const player of players) {
        const needed = 3 - (player.row === row ? 1 : 0)
        for (let index = 0; index < needed; index++) {
          const defId = drawSummon(summonSupply, next)
          next = next === 'sentry_a' ? 'sentry_b' : 'sentry_a'
          if (!defId) continue
          enemies.push(spawn(defId, `elite-summon-${enemies.length}`, player.row,
            startingHp(enemyDef(defId), count), false, 0, null, ascension))
        }
      }
    }
    for (const player of players) {
      const requested = [
        ...(card.summonsPerPlayer ?? []),
        ...Array.from(
          { length: card.randomSummonsPerPlayer?.count ?? 0 },
          () => card.randomSummonsPerPlayer!.group,
        ),
      ]
      for (const group of requested) {
        const defId = drawSummon(summonSupply, group)
        if (!defId) continue
        enemies.push(spawn(
          defId,
          `elite-summon-${enemies.length}`,
          player.row,
          startingHp(enemyDef(defId, ascension), count),
          false,
          0,
          null,
          ascension,
          false,
          false,
          card.defId === 'taskmaster' && defId.startsWith('red_slaver'),
        ))
      }
    }
    // Summons share the Elite's row to its left (p.11), so the Elite is added
    // last and acts after them in the left-to-right Enemy Turn.
    enemies.push(elite)
    return { enemies, summonSupply }
  }

  const cards = first ? decks.first.splice(0, count) : drawCards(decks.encounter, count)
  const enemies = players.flatMap((player, index) => {
    const card = cards[index] ?? ACT_ENCOUNTERS[1]![0]!
    const hp = startingHp(enemyDef(card.defId, ascension), count)
    const main = spawn(
      card.defId,
      `e${index}`,
      player.row,
      hp,
      false,
      card.goldReward,
      card.cardReward,
      ascension,
      card.potionReward === true,
      card.relicReward === true,
    )
    const randomCount = card.randomSummons
      ? count === 1 ? card.randomSummons.soloCount ?? card.randomSummons.count : card.randomSummons.count
      : 0
    const random = Array.from(
      { length: randomCount },
      () => drawSummon(summonSupply, card.randomSummons!.group),
    )
      .filter((id): id is string => id !== null)
    const summoned = (card.summons ?? []).map((name) => drawSummon(summonSupply, name))
      .filter((id): id is string => id !== null)
    return [
      main,
      ...[...summoned, ...random].map((summonId, summonIndex) => spawn(
        summonId,
        summonIndex === 0 ? `e${index}-summon` : `e${index}-summon-${summonIndex}`,
        player.row,
        startingHp(enemyDef(summonId, ascension), count),
        false,
        0,
        null,
        ascension,
      )),
    ]
  })
  return { enemies, summonSupply }
}

/** Resets a player's piles for a fresh combat: everything back to the deck. */
function readyForCombat(rng: RngState, player: Player): Player {
  const deck = [...player.deck]
  return {
    ...player,
    block: 0,
    energy: 3,
    draw: shuffle(rng, deck),
    hand: [],
    discard: [],
    exhaust: [],
    powers: [],
    strength: 0,
    strengthLossAtEndOfTurn: 0,
    vulnerable: 0,
    weak: 0,
    drawLocked: false,
    hpLostThisRound: 0,
    hpLossLimitThisRound: undefined,
    freeCardsThisTurn: 0,
    freeAttacksThisTurn: 0,
    cardPlayLocked: false,
    doubledAttacksThisTurn: 0,
    tripledAttacksThisTurn: 0,
    doubledCardsThisTurn: 0,
    doubledSkillsThisTurn: 0,
    retainCardsThisTurn: 0,
    shivs: 0,
    miracles: 0,
    stance: 'neutral',
    orbs: [null, null, null],
    orbEvokeBonus: 0,
    darkOrbEvokeBonus: 0,
    orbEndTurnBonus: 0,
    lightningEndTurnBonus: 0,
    starterStrikeDamageBonus: 0,
    clawCubesGainedThisCombat: 0,
    starterDefendBlockBonus: 0,
    calipersArmed: false,
    damageDealtZeroThisTurn: false,
    relics: player.relics.map((relic) => relicDef(relic.defId).activation === 'oncePerCombat' ||
      ['charons_ashes', 'dollys_mirror', 'nilrys_codex', 'loaded_die'].includes(relic.defId)
      ? { ...relic, spent: false }
      : relic.defId === 'holy_water' ? { ...relic, cubes: 2 } : relic),
  }
}

/**
 * Moves the party into a room and starts whatever that room is. Returns the
 * SAME state reference when the move is illegal, matching the combat engine.
 */
export function enterRoom(state: RunState, roomId: string, wingBootsPlayerId?: string): RunState {
  if (state.phase !== 'map' || state.players.some((player) => player.relics.some((relic) => relic.pending))) return state
  let map = moveTo(state.map, roomId)
  let wingBootsUsed = false
  if (map === state.map && wingBootsPlayerId) {
    const owner = state.players.find((player) => player.id === wingBootsPlayerId && !player.dead)
    const boots = owner?.relics.find((relic) => relic.defId === 'wing_boots' && (relic.uses ?? 0) > 0)
    const current = state.map.position ? state.map.rooms[state.map.position] : undefined
    const target = state.map.rooms[roomId]
    if (boots && target && target.row === (current?.row ?? -1) + 1) {
      map = {
        ...state.map,
        position: roomId,
        rooms: { ...state.map.rooms, [roomId]: { ...target, visited: true } },
      }
      wingBootsUsed = true
    }
  }
  if (map === state.map) return state

  const room = currentRoom(map)
  if (!room) return state

  const rng = { ...state.rng }
  const enemyDecks = structuredClone(state.enemyDecks)
  const roomPlayers = state.players.map((player) => ({
    ...player,
    relics: player.relics.flatMap((relic) => {
      if (wingBootsUsed && player.id === wingBootsPlayerId && relic.defId === 'wing_boots') {
        return relic.uses === 1 ? [] : [{ ...relic, uses: relic.uses! - 1 }]
      }
      return relicDef(relic.defId).activation === 'oncePerRoom' ? [{ ...relic, spent: false }] : [relic]
    }),
  }))
  const next: RunState = {
    ...state,
    map,
    rng,
    enemyDecks,
    players: roomPlayers,
    log: [...state.log, `The party enters ${enteringRoom(room.kind)}.`],
  }

  if (room.kind === 'encounter' || room.kind === 'elite' || room.kind === 'boss') {
    let nextUid = Math.max(0, ...roomPlayers.flatMap((player) => player.deck.map((card) => Number(/^c(\d+)$/.exec(card.uid)?.[1] ?? 0))))
    const players = roomPlayers.map((player) => {
      const prepared = room.burning && !state.campaign.keys.emerald
        ? {
            ...player,
            deck: [...player.deck, { uid: `c${++nextUid}`, defId: 'burn', upgraded: false }, { uid: `c${++nextUid}`, defId: 'burn', upgraded: false }],
          }
        : player
      return readyForCombat(rng, prepared)
    })
    const first = state.act === 1 && state.map.position === null && room.id === state.map.rows[0]?.[0]
    const { enemies, summonSupply, nextBossDefId } = buildEncounter(
      rng, enemyDecks, state.act, players, room.kind, first, state.ascension,
    )
    // Start the first Player Turn immediately: entering a room with no cards in
    // hand and nothing to do is not a state the game ever sits in.
    const combat = startPlayerTurnWithChoices(createCombat(
      rng, players, enemies, room.id, state.potionDeck, state.ascension >= 4 ? 2 : 3, summonSupply,
    ))
    return {
      ...next,
      phase: 'combat',
      players,
      combat,
      pendingBossDefId: nextBossDefId ?? null,
      roomState: null,
      courier: { usedBy: [], offer: null },
    }
  }

  if (room.kind === 'merchant') {
    const itemDecks = structuredClone(state.itemDecks)
    itemDecks.potions = [...state.potionDeck]
    const roomState = createMerchant(itemDecks, roomPlayers)
    return mirrorItemSupplies({ ...next, phase: 'room', roomState }, itemDecks)
  }
  if (room.kind === 'treasure') {
    const itemDecks = structuredClone(state.itemDecks)
    return mirrorItemSupplies({ ...next, phase: 'room', roomState: createRelicReward('treasure', itemDecks, roomPlayers, state.chooseYourRelic) }, itemDecks)
  }

  if (room.kind === 'event') {
    const itemDecks = structuredClone(state.itemDecks)
    itemDecks.potions = [...state.potionDeck]
    const eventDeck = [...state.eventDeck]
    let card = eventDeck.shift()
    while (state.eventsVisited === 0 && (card?.id === 'encounter_redraw' || card?.id === 'merchant_redraw' || card?.id === 'dead_adventurer')) {
      eventDeck.push(card)
      card = eventDeck.shift()
    }
    if (!card) return { ...next, phase: 'map', eventDeck, log: [...next.log, 'The Event deck is empty.'] }
    const drawnCard = card
    eventDeck.push(drawnCard)
    if (state.eventsVisited > 0 && (card.id === 'encounter_redraw' || card.id === 'merchant_redraw')) {
      const ordinaryId = card.id === 'encounter_redraw' ? 'encounter' : 'merchant'
      const ordinary = EVENT_DEFINITIONS[ordinaryId]!
      card = { ...card, id: ordinary.id, name: ordinary.name, options: ordinary.options, scope: ordinary.scope }
    }
    const roomState = createEventRoom(card)
    if (card.id === 'forgotten_altar') roomState.revealedRelics = Object.fromEntries(state.players.filter((player) => !player.dead && player.relics.length > 0).map((player) => [player.id, player.relics[nextInt(rng, player.relics.length)]!.defId]))
    if (card.id === 'falling') {
      const revealed = roomPlayers.filter((player) => !player.dead).map((player) => [player, shuffle(rng, player.deck.filter((entry) => entry.defId !== 'ascenders_bane')).slice(0, 3)] as const)
      roomState.revealedCards = Object.fromEntries(revealed.map(([player, cards]) => [player.id, cards.map((entry) => entry.uid)]))
      roomState.revealedCardDefs = Object.fromEntries(revealed.map(([player, cards]) => [player.id, cards.map((entry) => entry.defId)]))
    }
    return mirrorItemSupplies({
      ...next,
      phase: 'room',
      eventDeck,
      eventsVisited: state.eventsVisited + 1,
      roomState,
      players: roomPlayers.map((player) => hasRelic(player, 'ssserpent_head') && !hasRelic(player, 'ectoplasm')
        ? { ...player, gold: player.gold + 2 }
        : player),
    }, itemDecks)
  }
  return { ...next, phase: 'room', roomState: null }
}

/**
 * Folds a finished combat back into the run: survivors keep their HP and gold,
 * and the party either climbs on or the run ends.
 */
/** How many combat lines to carry into the run log when a fight ends. */
const COMBAT_EPITAPH = 6

function preparePendingBossCombat(
  state: RunState,
  players: Player[],
  rng: RngState,
): { rng: RngState; players: Player[]; combat: CombatState } {
  const prepared = players.map((player) => readyForCombat(rng, player))
  const { enemies, summonSupply } = buildEncounter(
    rng,
    state.enemyDecks,
    state.act,
    prepared,
    'boss',
    false,
    state.ascension,
    state.pendingBossDefId!,
  )
  return {
    rng,
    players: prepared,
    combat: startPlayerTurnWithChoices(createCombat(
      rng, prepared, enemies, undefined, state.potionDeck, state.ascension >= 4 ? 2 : 3, summonSupply,
    )),
  }
}

export function resolveCombat(state: RunState): RunState {
  const combat = state.combat
  if (!combat || state.courier.offer || (combat.phase !== 'won' && combat.phase !== 'lost')) return state

  const epitaph = combat.log.filter((line) => !/^Turn \d+ begins/.test(line)).slice(-COMBAT_EPITAPH)
  const itemDecks = structuredClone(state.itemDecks)
  itemDecks.potions = [...combat.potionDeck]
  if (combat.phase === 'lost') {
    return {
      ...state,
      phase: 'defeat',
      players: combat.players.map((player) => ({
        ...player,
        deck: player.deck.filter((card) => CARDS[card.defId]?.owner !== 'status'),
      })),
      combat: null,
      potionDeck: combat.potionDeck,
      pendingBossDefId: null,
      itemDecks,
      eventCombat: null,
      rewards: [],
      rewardDestination: null,
      log: [...state.log, ...epitaph, 'The party has fallen.'],
    }
  }

  const room = currentRoom(state.map)
  const wasBoss = room?.kind === 'boss' && !state.eventCombat
  const wasBonusBoss = state.eventCombat?.mindBloom === true
  const wasElite = room?.kind === 'elite' || state.eventCombat?.kind === 'elite' || state.eventCombat?.mindBloom === true
  const sharedReward = wasElite || wasBoss || state.eventCombat?.kind === 'boss'
    ? combat.enemies.find((enemy) => enemyDef(enemy.defId, enemy.ascension).elite || enemy.isBoss)
    : undefined
  const players = state.players.map((player) => {
    const after = combat.players.find((candidate) => candidate.id === player.id)
    if (!after) return player
    const source = sharedReward ?? combat.enemies.find((enemy) => enemy.row === after.row)
    const rewardGold = source?.goldReward ?? 0
    const canGainGold = !hasRelic(after, 'ectoplasm')
    const goldenIdol = hasRelic(after, 'golden_idol') ? 1 : 0
    const meatHp = hasRelic(after, 'meat_on_the_bone') && after.hp < 4 ? 4 : after.hp
    const hp = Math.min(healingCapFor(after), meatHp)
    return {
      ...player,
      deck: player.deck.filter((card) => CARDS[card.defId]?.owner !== 'status'),
      hp,
      gold: after.gold + (canGainGold ? rewardGold + goldenIdol : 0),
      row: after.row,
      potions: after.potions,
      relics: after.relics,
      dead: after.dead,
    }
  })

  const betweenBosses = wasBoss && Boolean(state.pendingBossDefId)
  const finalBoss = wasBoss && state.act >= 4
  const destination = betweenBosses ? 'betweenCombat' : wasBoss ? 'victory' : 'map'
  const bossChoices = wasBoss && !betweenBosses && !finalBoss
    ? state.bossRelicDeck.slice(0, bossRelicOfferSize(players.filter((player) => !player.dead).length))
    : []
  const rewards = players.flatMap<CardRewardOffer>((player) => {
    if (player.dead) return []
    const whitePotion: false | null = hasRelic(player, 'white_beast_statue') ? null : false
    if (wasBoss && !betweenBosses && !finalBoss) return [{
      playerId: player.id,
      cardReward: false,
      choices: null,
      upgraded: false,
      potion: whitePotion,
      relic: false as const,
      bossRelics: [...bossChoices],
    }]
    if (betweenBosses || finalBoss) return whitePotion === false ? [] : [{
      playerId: player.id,
      cardReward: false,
      choices: null,
      upgraded: false,
      potion: whitePotion,
      relic: false as const,
      bossRelics: false as const,
    }]
    const source = sharedReward ?? combat.enemies.find((enemy) => enemy.row === player.row)
    const printedCardReward = wasBonusBoss ? 'normal' : source?.cardReward
    const cardReward = Boolean(printedCardReward && player.cardRewards.length > 0)
    const potionCount = Number(source?.potionReward === true) + Number(hasRelic(player, 'white_beast_statue'))
    const potion: false | null = potionCount > 0 ? null : false
    // Elite relics are resolved by the shared physical room reward below.
    const relic: false | null = source?.relicReward === true && !wasElite ? null : false
    if (!cardReward && potion === false && relic === false) return []
    return [{
      playerId: player.id,
      cardReward,
      choices: null,
      upgraded: printedCardReward === 'upgraded',
      potion,
      potionQueue: potionCount > 1 ? Array(potionCount - 1).fill(null) : undefined,
      relic,
      bossRelics: false as const,
    }]
  })
  const roomState = wasElite ? createRelicReward('elite', itemDecks, players, state.chooseYourRelic) : null
  const campaign = {
    ...state.campaign,
    bossesDefeated: state.campaign.bossesDefeated + (wasBoss || wasBonusBoss ? 1 : 0),
    highestBossActDefeated: (wasBoss ? Math.max(state.campaign.highestBossActDefeated, state.act) : state.campaign.highestBossActDefeated) as 0 | 1 | 2 | 3 | 4,
    keys: room?.burning && !state.campaign.keys.emerald
      ? { ...state.campaign.keys, emerald: true }
      : state.campaign.keys,
  }
  return mirrorItemSupplies({
    ...state,
    phase: rewards.length > 0 ? 'reward' : roomState ? 'room' : destination,
    players,
    bossRelicDeck: wasBoss && !finalBoss ? state.bossRelicDeck.slice(bossChoices.length) : state.bossRelicDeck,
    potionDeck: combat.potionDeck,
    combat: null,
    pendingBossDefId: betweenBosses ? state.pendingBossDefId : null,
    rewards,
    roomState,
    eventCombat: null,
    campaign,
    rewardDestination: rewards.length > 0 ? destination : null,
    log: [...state.log, betweenBosses
      ? 'The party regroups before the second Act III boss.'
      : wasBoss && state.act >= 4
      ? 'The Spire is conquered.'
      : wasBoss ? 'The Act is won.' : 'The enemies fall.'],
  }, itemDecks)
}

/** Swap or move one player before the reserved Ascension 13 boss. */
export function switchBetweenCombatRow(state: RunState, playerId: string, row: number): RunState {
  if (state.phase !== 'betweenCombat' || !state.pendingBossDefId ||
    !Number.isInteger(row) || row < 0 || row >= state.players.length) return state
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (!player || player.dead || player.row === row) return state
  const other = state.players.find((candidate) => candidate.row === row)
  return {
    ...state,
    players: state.players.map((candidate) =>
      candidate.id === playerId ? { ...candidate, row }
        : other && candidate.id === other.id ? { ...candidate, row: player.row }
          : candidate),
    log: [...state.log, `${player.name} moves to row ${row + 1} before the next boss.`],
  }
}

/** Start the already-reserved second A13 boss without consuming client input. */
export function startPendingBoss(state: RunState): RunState {
  if (state.phase !== 'betweenCombat' || !state.pendingBossDefId || state.combat ||
    hasPendingRelicAcquisition(state)) return state
  const next = preparePendingBossCombat(state, state.players, { ...state.rng })
  return {
    ...state,
    ...next,
    phase: 'combat',
    pendingBossDefId: null,
    rewards: [],
    rewardDestination: null,
    log: [...state.log, 'The second boss approaches.'],
  }
}
/** Reveal one player's top three; rewards may instead be skipped unseen (p.8). */
export function revealCardReward(state: RunState, playerId: string): RunState {
  if (state.phase !== 'reward' || hasPendingRelicAcquisition(state)) return state
  const offer = state.rewards.find((candidate) => candidate.playerId === playerId)
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (!offer || !offer.cardReward || offer.choices !== null || !player) return state
  const drawn = player.cardRewards.slice(0, 3)
  const common = drawn.filter((defId) => defId !== GOLDEN_TICKET)
  const rare = player.rareRewards.slice(0, drawn.length - common.length)
  return {
    ...state,
    rewards: state.rewards.map((candidate) => candidate === offer
      ? {
          ...candidate,
          choices: [...common, ...rare],
          rareChoiceIndices: rare.map((_defId, index) => common.length + index),
          cardsDrawn: drawn,
          raresDrawn: rare,
        }
      : candidate),
  }
}

export const potionLimitFor = potionLimit

function settlePotionOffer(offer: CardRewardOffer): CardRewardOffer {
  const queue = offer.potionQueue ?? []
  return {
    ...offer,
    potion: queue.length > 0 ? queue[0]! : false,
    potionQueue: queue.length > 1 ? queue.slice(1) : undefined,
  }
}

function canGainPotion(player: Player, limit: number): boolean {
  return !player.relics.some((relic) => relic.defId === 'sozu') && player.potions.length < limit
}

/** Reserve the physical top card and turn it face up for the whole party. */
export function revealPotionReward(state: RunState, playerId: string): RunState {
  if (state.phase !== 'reward' || hasPendingRelicAcquisition(state)) return state
  const offer = state.rewards.find((candidate) => candidate.playerId === playerId)
  const potion = state.potionDeck[0]
  if (!offer || offer.potion !== null || !potion) return state
  return mirrorLegacySupplies({
    ...state,
    potionDeck: state.potionDeck.slice(1),
    rewards: state.rewards.map((candidate) => candidate === offer ? { ...candidate, potion } : candidate),
    log: [...state.log, `${state.players.find((player) => player.id === playerId)?.name ?? 'A player'} reveals a Potion reward.`],
  })
}

/** Settle one potion reward immediately; card rewards remain independently choosable. */
export function resolvePotionReward(
  state: RunState,
  playerId: string,
  decision: PotionRewardDecision,
): RunState {
  if (state.phase !== 'reward' || hasPendingRelicAcquisition(state)) return state
  const offer = state.rewards.find((candidate) => candidate.playerId === playerId)
  const owner = state.players.find((player) => player.id === playerId)
  if (!offer || offer.potion === false || !owner) return state

  // Skipping before reveal draws nothing. A revealed skipped card goes bottom.
  if (decision.kind === 'skip') {
    const bottom = typeof offer.potion === 'string' ? [offer.potion] : []
    const next = mirrorLegacySupplies({
      ...state,
      potionDeck: [...state.potionDeck, ...bottom],
      rewards: state.rewards.map((candidate) => candidate === offer ? settlePotionOffer(candidate) : candidate),
      log: [...state.log, `${owner.name} skips a Potion reward${bottom.length ? '' : ' unseen'}.`],
    })
    return next.rewards.every((candidate) => !candidate.cardReward && candidate.potion === false)
      ? resolveCardRewards(next, {})
      : next
  }
  if (typeof offer.potion !== 'string') return state
  const limit = potionLimitFor(state.ascension)
  let recipient = owner
  let returned: string[] = []
  if (decision.kind === 'pass') {
    const target = state.players.find((player) => player.id === decision.playerId)
    if (!target || target.dead || target.id === owner.id || !canGainPotion(target, limit)) return state
    recipient = target
  } else if (decision.kind === 'replace') {
    const held = owner.potions.indexOf(decision.potionId)
    if (held < 0 || owner.relics.some((relic) => relic.defId === 'sozu')) return state
    returned = [decision.potionId]
  } else if (!canGainPotion(owner, limit)) {
    return state
  }

  const players = state.players.map((player) => {
    if (player.id !== recipient.id) return player
    const potions = decision.kind === 'replace'
      ? [...player.potions.filter((_potion, index) => index !== player.potions.indexOf(decision.potionId)), offer.potion as string]
      : [...player.potions, offer.potion as string]
    return { ...player, potions }
  })
  const next = mirrorLegacySupplies({
    ...state,
    players,
    potionDeck: [...state.potionDeck, ...returned],
    rewards: state.rewards.map((candidate) => candidate === offer ? settlePotionOffer(candidate) : candidate),
    log: [...state.log, `${recipient.name} gains ${offer.potion}.`],
  })
  return next.rewards.every((candidate) => !candidate.cardReward && candidate.potion === false)
    ? resolveCardRewards(next, {})
    : next
}

/** Only face-up potions may be traded, and only outside combat (rulebook p.8). */
export function tradePotion(
  state: RunState,
  fromPlayerId: string,
  toPlayerId: string,
  potionId: string,
): RunState {
  if (state.phase === 'combat' || state.phase === 'defeat' ||
    hasPendingRelicAcquisition(state) || fromPlayerId === toPlayerId) return state
  const from = state.players.find((player) => player.id === fromPlayerId)
  const to = state.players.find((player) => player.id === toPlayerId)
  if (!from || !to || from.dead || to.dead || !from.potions.includes(potionId) ||
    !canGainPotion(to, potionLimitFor(state.ascension))) return state
  let moved = false
  return {
    ...state,
    players: state.players.map((player) => {
      if (player.id === from.id) return {
        ...player,
        potions: player.potions.filter((potion) => {
          if (!moved && potion === potionId) { moved = true; return false }
          return true
        }),
      }
      return player.id === to.id ? { ...player, potions: [...player.potions, potionId] } : player
    }),
    log: [...state.log, `${from.name} gives a Potion to ${to.name}.`],
  }
}

/** The potion effects explicitly permitted outside combat by the physical FAQ. */
export function usePotionOutsideCombat(
  state: RunState,
  playerId: string,
  potionId: string,
  replacePotionId?: string,
): RunState {
  if (state.phase === 'combat' || state.phase === 'defeat' || hasPendingRelicAcquisition(state)) return state
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (!player || player.dead || !player.potions.includes(potionId)) return state
  if (potionId === 'blood_potion' && player.hp >= healingCapFor(player)) return state
  const sozuBlocksBrew = potionId === 'entropic_brew' && player.relics.some((relic) => relic.defId === 'sozu')
  if (potionId === 'entropic_brew') {
    if (!sozuBlocksBrew) {
      const overflow = Math.max(0, player.potions.length - 1 + 2 - potionLimitFor(state.ascension))
      const replaceable = replacePotionId !== potionId && player.potions.includes(replacePotionId ?? '')
      if (overflow > 1 || (overflow === 1) !== replaceable) return state
    }
  } else if (replacePotionId !== undefined) return state
  if (potionId !== 'blood_potion' && potionId !== 'entropic_brew') return state
  const deck = [...state.potionDeck]
  const gained = potionId === 'entropic_brew' && !sozuBlocksBrew ? deck.splice(0, 2) : []
  deck.push(potionId, ...(!sozuBlocksBrew && replacePotionId ? [replacePotionId] : []))
  let removed = false
  let replaced = false
  return mirrorLegacySupplies({
    ...state,
    potionDeck: deck,
    players: state.players.map((candidate) => candidate.id !== playerId ? candidate : {
      ...candidate,
      hp: potionId === 'blood_potion'
        ? Math.min(healingCapFor(candidate), candidate.hp + 2)
        : candidate.hp,
      potions: [
        ...candidate.potions.filter((potion) => {
          if (!removed && potion === potionId) { removed = true; return false }
          if (!sozuBlocksBrew && !replaced && potion === replacePotionId) { replaced = true; return false }
          return true
        }),
        ...gained,
      ],
    }),
    log: [...state.log, `${player.name} uses ${potionId}.`],
  })
}

export function revealRelicReward(state: RunState, playerId: string): RunState {
  if (state.phase !== 'reward' || hasPendingRelicAcquisition(state)) return state
  const offer = state.rewards.find((candidate) => candidate.playerId === playerId)
  const relic = state.relicDeck[0]
  if (!offer || offer.relic !== null || !relic) return state
  return mirrorLegacySupplies({
    ...state,
    relicDeck: state.relicDeck.slice(1),
    rewards: state.rewards.map((candidate) => candidate === offer ? { ...candidate, relic } : candidate),
  })
}

function nextRunUid(players: readonly Player[]): number {
  return Math.max(0, ...players.flatMap((player) => player.deck.map((card) =>
    Number(/^c(\d+)$/.exec(card.uid)?.[1] ?? 0)))) + 1
}

function hasRelic(player: Player, defId: string): boolean {
  return player.relics.some((relic) => relic.defId === defId)
}

/**
 * One authoritative acquisition boundary for rewards, Calling Bell, and future
 * Merchant/Event callers. Immediate physical text resolves here; choice-based
 * one-shot relics remain face up with `pending` until their owner resolves it.
 */
export function acquireRelic(state: RunState, playerId: string, relicId: string): RunState {
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (!player || !relicDef(relicId)) return state
  const itemDecks = { ...state.itemDecks, curses: [...state.itemDecks.curses] }
  let relicDeck = [...state.relicDeck]
  let uid = nextRunUid(state.players)
  const bottomOldCoin = () => {
    relicDeck = [...relicDeck.filter((id) => id !== 'old_coin'), 'old_coin']
  }
  const addCurse = (owner: Player): Player => {
    if (hasRelic(owner, 'omamori')) return owner
    const defId = itemDecks.curses.shift()
    if (!defId) return owner
    return { ...owner, deck: [...owner.deck, { uid: `c${uid++}`, defId, upgraded: false }] }
  }
  const players = state.players.map((candidate) => {
    if (candidate.id !== playerId) return candidate
    let owner = candidate
    if (relicId === 'old_coin') {
      bottomOldCoin()
      return hasRelic(owner, 'ectoplasm') ? owner : { ...owner, gold: owner.gold + 10 }
    }
    if (relicId === 'calling_bell') {
      const revealed = relicDeck.splice(0, 3)
      const oldCoins = revealed.filter((id) => id === 'old_coin').length
      owner = {
        ...owner,
        gold: hasRelic(owner, 'ectoplasm') ? owner.gold : owner.gold + 10 * oldCoins,
        relics: [...owner.relics, ...revealed.filter((id) => id !== 'old_coin').map(createRelicInstance)],
      }
      if (oldCoins > 0) bottomOldCoin()
      return addCurse(owner)
    }
    owner = { ...owner, relics: [...owner.relics, createRelicInstance(relicId)] }
    if (relicId === 'cursed_key') {
      owner = addCurse(owner)
      owner = addCurse(owner)
    }
    if (relicId === 'tiny_house' && !hasRelic(owner, 'ectoplasm')) owner = { ...owner, gold: owner.gold + 3 }
    return owner
  })
  const tinyPotion = relicId === 'tiny_house' && !hasRelic(player, 'sozu') ? state.potionDeck[0] : undefined
  return mirrorLegacySupplies({
    ...state,
    itemDecks,
    relicDeck,
    potionDeck: tinyPotion ? state.potionDeck.slice(1) : state.potionDeck,
    players,
    rewards: tinyPotion ? state.rewards.map((offer) => offer.playerId === playerId
      ? offer.potion === false
        ? { ...offer, potion: tinyPotion }
        : { ...offer, potionQueue: [...(offer.potionQueue ?? []), tinyPotion] }
      : offer) : state.rewards,
  })
}

/** Only the owner sees cards exposed by a pending one-shot relic. */
export function pendingRelicPreview(state: RunState, playerId: string): PendingRelicPreview | null {
  if (!Array.isArray(state.players)) return null
  const player = state.players.find((candidate) => candidate.id === playerId)
  const pending = player?.relics.find((relic) => relic.pending)
  if (!player || !pending) return null
  if (['enchiridion', 'orrery', 'tiny_house'].includes(pending.defId)) {
    return { relicId: pending.defId, rewardChoices: pendingRewardChoices(player, pending.defId) }
  }
  return { relicId: pending.defId }
}

/** Resolve immediate acquisition text atomically from owner-supplied choices. */
export function resolvePendingRelic(
  state: RunState,
  playerId: string,
  cardUids: readonly string[] = [],
  rewardIndices: readonly number[] = [],
): RunState {
  if (state.phase === 'combat') return state
  const player = state.players.find((candidate) => candidate.id === playerId)
  const pending = player?.relics.find((relic) => relic.pending)
  if (!player || !pending || new Set(cardUids).size !== cardUids.length ||
    cardUids.some((uid) => !player.deck.some((card) => card.uid === uid))) return state
  const id = pending.defId
  const printedCards = id === 'empty_cage' ? 2 : ['astrolabe', 'pandoras_box'].includes(id) ? 3
    : ['war_paint', 'whetstone', 'tiny_house'].includes(id) ? 1 : 0
  const expectedCards = Math.min(printedCards, pendingRelicEligibleCards(player, id).length)
  const expectedRewards = id === 'orrery' ? 4 : ['enchiridion', 'tiny_house'].includes(id) ? 1 : 0
  const rewardChoices = pendingRewardChoices(player, id)
  if (cardUids.length !== expectedCards || rewardIndices.length !== expectedRewards ||
    rewardIndices.some((choice, index) => !Number.isInteger(choice) || choice < -1 ||
      choice >= (rewardChoices[index]?.length ?? 0))) return state
  const chosen = cardUids.map((uid) => player.deck.find((card) => card.uid === uid)!)
  if (id === 'war_paint' && expectedCards > 0 && CARDS[chosen[0]!.defId]?.type !== 'skill') return state
  if (id === 'whetstone' && expectedCards > 0 && CARDS[chosen[0]!.defId]?.type !== 'attack') return state
  if (['war_paint', 'whetstone', 'astrolabe', 'tiny_house'].includes(id) &&
    chosen.some((card) => !canUpgradeCard(card))) return state
  if (id === 'empty_cage' && chosen.some((card) => card.defId === 'ascenders_bane')) return state
  if (id === 'pandoras_box' && chosen.some((card) => CARDS[card.defId]?.type === 'curse')) return state
  const requiredStarter = id === 'war_paint'
    ? player.deck.find((card) => card.defId.startsWith('defend_') && !card.upgraded)
    : id === 'whetstone' ? player.deck.find((card) => card.defId.startsWith('strike_') && !card.upgraded) : undefined
  if (requiredStarter && chosen.some((card) => card.uid === requiredStarter.uid)) return state

  let owner: Player = { ...player, relics: player.relics.filter((relic) => relic !== pending) }
  if (['war_paint', 'whetstone', 'astrolabe', 'tiny_house'].includes(id)) {
    const upgrade = new Set(cardUids)
    if (id === 'war_paint') {
      const starter = owner.deck.find((card) => card.defId.startsWith('defend_') && !card.upgraded)
      if (starter) upgrade.add(starter.uid)
    }
    if (id === 'whetstone') {
      const starter = owner.deck.find((card) => card.defId.startsWith('strike_') && !card.upgraded)
      if (starter) upgrade.add(starter.uid)
    }
    owner = { ...owner, deck: owner.deck.map((card) => upgrade.has(card.uid) ? { ...card, upgraded: true } : card) }
  } else if (id === 'empty_cage') {
    for (const uid of cardUids) owner = removeCard(owner, uid)
  } else if (id === 'pandoras_box') {
    const remove = new Set(cardUids)
    owner = { ...owner, deck: owner.deck.filter((card) => !remove.has(card.uid)) }
    for (let index = 0; index < expectedCards; index++) {
      const draw = drawTransformReward(owner)
      owner = draw.player
      if (draw.defId) {
        owner = addCard(owner, draw.defId, `c${nextRunUid([owner])}`)
      }
    }
  }

  if (expectedRewards > 0) {
    const rare = id === 'enchiridion'
    const gained: string[] = []
    const commonSource = [...owner.cardRewards]
    const rareSource = [...owner.rareRewards]
    const commonBottom: string[] = []
    const rareBottom: string[] = []
    for (let reward = 0; reward < expectedRewards; reward++) {
      if (rare) {
        const shown = rareSource.splice(0, 5)
        const choice = rewardIndices[reward]!
        if (choice >= 0) gained.push(shown[choice]!)
        rareBottom.push(...shown.filter((_card, index) => index !== choice))
        continue
      }
      const raw = commonSource.splice(0, 3)
      const expanded = expandCommonReward(raw, rareSource)
      const choice = rewardIndices[reward]!
      if (choice >= 0) gained.push(expanded.choices[choice]!)
      const selectedRaw = choice >= 0 ? expanded.rawIndices[choice] : -1
      raw.forEach((defId, index) => {
        if (defId === GOLDEN_TICKET) commonBottom.push(defId)
        else if (index !== selectedRaw) commonBottom.push(defId)
      })
      const selectedRare = choice >= 0 ? expanded.rareIndices[choice] : null
      const revealedRare = rareSource.splice(0, expanded.rareCount)
      rareBottom.push(...revealedRare.filter((_defId, index) => index !== selectedRare))
    }
    let uid = nextRunUid(state.players)
    for (const defId of gained) {
      owner = addCard(owner, defId, `c${uid++}`)
    }
    owner = {
      ...owner,
      cardRewards: rare ? owner.cardRewards : [...commonSource, ...commonBottom],
      rareRewards: [...rareSource, ...rareBottom],
    }
  }
  let next = { ...state, players: state.players.map((candidate) => candidate.id === playerId ? owner : candidate) }
  if (state.phase === 'neow' && state.neow?.players[playerId]?.blueOption !== null) {
    next = nextNeowReward(next, playerId)
    return finishNeowStep(next, playerId)
  }
  return next
}

export function resolveRelicReward(state: RunState, playerId: string, gain: boolean): RunState {
  if (state.phase !== 'reward' || hasPendingRelicAcquisition(state)) return state
  const offer = state.rewards.find((candidate) => candidate.playerId === playerId)
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (!offer || offer.relic === false || !player) return state
  if (offer.relic === null && gain) return state
  const relic = typeof offer.relic === 'string' ? offer.relic : null
  const rewards = state.rewards.map((candidate) => candidate === offer ? { ...candidate, relic: false as const } : candidate)
  let next = mirrorLegacySupplies({
    ...state,
    relicDeck: relic && !gain ? [...state.relicDeck, relic] : state.relicDeck,
    players: state.players,
    rewards,
  })
  if (relic && gain) next = acquireRelic(next, playerId, relic)
  return rewards.every((candidate) => !candidate.cardReward && candidate.relic === false &&
    candidate.potion === false && candidate.bossRelics === false)
    ? { ...next, phase: state.rewardDestination ?? 'map', rewards: [], rewardDestination: null }
    : next
}

export function resolveBossRelicReward(state: RunState, playerId: string, relicId: string | null): RunState {
  if (state.phase !== 'reward' || hasPendingRelicAcquisition(state)) return state
  const offer = state.rewards.find((candidate) => candidate.playerId === playerId)
  if (!offer || offer.bossRelics === false || !offer.bossRelics) return state
  if (relicId !== null && !offer.bossRelics.includes(relicId)) return state
  const remaining = relicId === null ? offer.bossRelics : offer.bossRelics.filter((id) => id !== relicId)
  const rewards = state.rewards.map((candidate) => candidate.bossRelics === false || !candidate.bossRelics
    ? candidate
    : candidate === offer ? { ...candidate, bossRelics: false as const }
      : { ...candidate, bossRelics: [...remaining] })
  const settled = rewards.every((candidate) => candidate.bossRelics === false)
  let next: RunState = {
    ...state,
    bossRelicDeck: settled ? [...state.bossRelicDeck, ...remaining] : state.bossRelicDeck,
    players: state.players,
    rewards,
  }
  if (relicId !== null) next = acquireRelic(next, playerId, relicId)
  return settled && next.rewards.every((candidate) => !candidate.cardReward && candidate.potion === false)
    ? { ...next, phase: state.rewardDestination ?? 'map', rewards: [], rewardDestination: null }
    : next
}

/** Resolve every living player's revealed choice or unseen skip together (p.8). */
export function resolveCardRewards(
  state: RunState,
  decisions: Readonly<Record<string, number | null>>,
): RunState {
  if (state.phase !== 'reward' || !state.rewardDestination || hasPendingRelicAcquisition(state)) return state
  if (state.rewards.some((offer) => offer.potion !== false || (offer.relic ?? false) !== false || (offer.bossRelics ?? false) !== false)) return state
  for (const offer of state.rewards.filter((candidate) => candidate.cardReward)) {
    const player = state.players.find((candidate) => candidate.id === offer.playerId)
    if (!player) return state
    const draw = offer.cardsDrawn && offer.raresDrawn
      ? { choices: offer.choices ?? [], cardsDrawn: offer.cardsDrawn, raresDrawn: offer.raresDrawn }
      : drawCardChoices(player)
    const expected = draw.choices
    if (offer.choices !== null && (
      offer.choices.length !== expected.length ||
      offer.choices.some((defId, index) => defId !== expected[index])
    )) return state
    if (!(offer.playerId in decisions)) return state
    const choice = decisions[offer.playerId]
    if (choice === undefined) return state
    if (choice !== null && (
      offer.choices === null || !Number.isInteger(choice) || choice < 0 || choice >= offer.choices.length
    )) return state
  }

  // Derive the next uid from THIS run. Another room may have called createRun
  // since this one started, so the setup counter is not authoritative here.
  let nextUid = Math.max(0, ...state.players.flatMap((player) =>
    player.deck.map((card) => Number(/^c(\d+)$/.exec(card.uid)?.[1] ?? 0)),
  ))
  const players = state.players.map((player) => {
    const offer = state.rewards.find((candidate) => candidate.playerId === player.id)
    if (!offer?.cardReward) return player
    const choice = decisions[player.id] ?? null
    if (offer.choices === null) return player
    const shown = offer.choices
    const selected = choice === null ? null : shown[choice]!
    const draw = offer.cardsDrawn && offer.raresDrawn
      ? { choices: shown, cardsDrawn: offer.cardsDrawn, raresDrawn: offer.raresDrawn }
      : drawCardChoices(player)
    const bottomed = bottomCardChoices(player, draw, choice)
    if (selected === null) return bottomed
    return addCard(bottomed, selected, `c${++nextUid}`, offer.upgraded)
  })

  return {
    ...state,
    phase: state.roomState ? 'room' : state.rewardDestination,
    players,
    rewards: [],
    rewardDestination: null,
    log: [...state.log, 'The party collects its rewards.'],
  }
}

/** Transform draws blindly; a Ticket returns to the bottom and grants the top rare. */
export function drawTransformReward(player: Player): { player: Player; defId: string | null } {
  const [drawn, ...rest] = player.cardRewards
  if (!drawn) return { player, defId: null }
  if (drawn !== GOLDEN_TICKET) return { player: { ...player, cardRewards: rest }, defId: drawn }
  const [rare, ...rareRest] = player.rareRewards
  return {
    player: {
      ...player,
      cardRewards: [...rest, GOLDEN_TICKET],
      rareRewards: rare ? rareRest : player.rareRewards,
    },
    defId: rare ?? null,
  }
}

export function purchaseAtMerchant(state: RunState, purchase: MerchantPurchase): RunState {
  if (state.phase !== 'room' || state.roomState?.kind !== 'merchant') return state
  const itemDecks = structuredClone(state.itemDecks)
  itemDecks.potions = [...state.potionDeck]
  const result = buyFromMerchant(state.roomState, itemDecks, state.players, state.ascension, purchase)
  return result ? mirrorItemSupplies({ ...state, roomState: result.shop, players: result.players }, itemDecks) : state
}

export function removeAtCurrentMerchant(
  state: RunState,
  playerId: string,
  cardUid: string,
  payments: Readonly<Record<string, number>>,
): RunState {
  if (state.phase !== 'room' || state.roomState?.kind !== 'merchant') return state
  const result = removeAtMerchant(state.roomState, state.players, state.ascension, playerId, cardUid, payments)
  return result ? { ...state, roomState: result.shop, players: result.players } : state
}

export function finishMerchant(state: RunState): RunState {
  if (state.phase !== 'room' || state.roomState?.kind !== 'merchant') return state
  const itemDecks = structuredClone(state.itemDecks)
  const players = closeMerchant(state.roomState, itemDecks, state.players)
  return mirrorItemSupplies({ ...state, phase: 'map', roomState: null, players, log: [...state.log, 'The party leaves the Merchant.'] }, itemDecks)
}

export function revealCourier(state: RunState, playerId: string, kind: CourierOffer['kind']): RunState {
  if (state.phase !== 'combat' || !state.combat || ['won', 'lost'].includes(state.combat.phase) || state.courier.offer || state.courier.usedBy.includes(playerId)) return state
  const player = state.combat.players.find((candidate) => candidate.id === playerId && !candidate.dead)
  if (!player?.relics.some((relic) => relic.defId === 'the_courier')) return state
  const itemDecks = structuredClone(state.itemDecks)
  if (kind === 'potion') itemDecks.potions = [...state.combat.potionDeck]
  const deck = kind === 'relic' ? itemDecks.relics : itemDecks.potions
  const blocked = kind === 'relic' ? new Set(['old_coin']) : new Set<string>()
  const id = drawItems(deck, 1, blocked)[0]
  if (!id) return state
  return mirrorItemSupplies({
    ...state,
    combat: kind === 'potion' ? { ...state.combat, potionDeck: [...itemDecks.potions] } : state.combat,
    courier: { usedBy: [...state.courier.usedBy, playerId], offer: { playerId, kind, id } },
  }, itemDecks)
}

export function decideCourier(
  state: RunState,
  playerId: string,
  decision: 'buy' | 'discard',
  payments: Readonly<Record<string, number>> = {},
  discardPotionId?: string,
): RunState {
  const offer = state.courier.offer
  if (state.phase !== 'combat' || !state.combat || ['won', 'lost'].includes(state.combat.phase) || !offer || offer.playerId !== playerId) return state
  const itemDecks = structuredClone(state.itemDecks)
  if (offer.kind === 'potion') itemDecks.potions = [...state.combat.potionDeck]
  const combatPlayers = resolveCourierOffer(offer, itemDecks, state.combat.players, state.ascension, decision === 'buy', payments, discardPotionId)
  if (!combatPlayers) return state
  const byId = new Map(combatPlayers.map((player) => [player.id, player]))
  return mirrorItemSupplies({
    ...state,
    players: state.players.map((player) => {
      const current = byId.get(player.id)
      return current ? { ...player, gold: current.gold, relics: current.relics, potions: current.potions } : player
    }),
    combat: {
      ...state.combat,
      potionDeck: offer.kind === 'potion' ? [...itemDecks.potions] : state.combat.potionDeck,
      players: combatPlayers,
    },
    courier: { ...state.courier, offer: null },
    log: [...state.log, decision === 'buy' ? `${byId.get(playerId)?.name ?? 'A player'} buys from The Courier.` : 'The Courier discards the offer.'],
  }, itemDecks)
}

export function chooseRelicReward(state: RunState, playerId: string, decision: TreasureDecision): RunState {
  if (state.phase !== 'room' || (state.roomState?.kind !== 'treasure' && state.roomState?.kind !== 'elite')) return state
  if (decision === 'sapphire' && (!isActIVUnlocked(state.campaignProgress) || state.campaign.keys.sapphire)) return state
  const reward = decideRelicReward(state.roomState, playerId, decision)
  if (!reward) return state
  if (!reward.playerIds.every((id) => reward.decisions[id] !== undefined)) return { ...state, roomState: reward }
  const itemDecks = structuredClone(state.itemDecks)
  const resolved = resolveRoomRelicReward(reward, itemDecks, state.players, state.campaign.keys.sapphire)
  if (!resolved) return state
  return mirrorItemSupplies({
    ...state,
    phase: 'map',
    roomState: null,
    players: resolved.players,
    campaign: resolved.sapphire
      ? { ...state.campaign, keys: { ...state.campaign.keys, sapphire: true } }
      : state.campaign,
    log: [...state.log, resolved.sapphire ? 'The party claims the Sapphire Key.' : 'The relics are resolved.'],
  }, itemDecks)
}

function stageEventDecision(decision: EventDecision): EventDecision {
  const staged = { ...decision }
  delete staged.rewardIndexes
  delete staged.rewardItemChoices
  delete staged.rewardItemIds
  delete staged.rewardItemKinds
  delete staged.potionRecipientId
  delete staged.potionRecipientIds
  delete staged.potionReplacementIds
  return staged
}

type CardRewardEffect = EventEffect & { tag: 'card-reward' | 'rare-reward' }

function nextEventCardOffer(
  state: RunState,
  playerId: string,
  targetPlayerId: string | undefined,
  effects: readonly CardRewardEffect[],
  indexes: readonly number[],
): { offer?: string[]; valid: boolean } {
  const players = state.players.map((player) => ({ ...player, cardRewards: [...player.cardRewards], rareRewards: [...player.rareRewards] }))
  const characterCards = structuredClone(state.itemDecks.characterCards)
  const characterRares = structuredClone(state.itemDecks.characterRares)
  let colorless = [...state.itemDecks.colorless]
  let used = 0
  for (const effect of effects) {
    const source = effect.source === 'other-character'
      ? players.find((candidate) => candidate.id === targetPlayerId && candidate.id !== playerId)
      : players.find((candidate) => candidate.id === playerId)
    let inactiveCards = effect.source === 'other-character' ? characterCards[targetPlayerId as CharacterId] : undefined
    let inactiveRares = effect.source === 'other-character' ? characterRares[targetPlayerId as CharacterId] : undefined
    if (!source && !inactiveCards) return { valid: false }
    for (let count = 0; count < (effect.count ?? 1); count++) {
      const reveal = effect.filter === 'reveal 5' ? 5 : 3
      if (effect.tag === 'card-reward' && effect.source !== 'rare' && effect.source !== 'colorless') {
        const holder = inactiveCards
          ? { ...players.find((candidate) => candidate.id === playerId)!, cardRewards: inactiveCards, rareRewards: inactiveRares ?? [] }
          : source!
        const draw = drawCardChoices(holder, reveal)
        if (draw.choices.length === 0) continue
        const choice = indexes[used]
        if (choice === undefined) return { offer: draw.choices, valid: true }
        if (choice !== -1 && !draw.choices[choice]) return { valid: false }
        used++
        const bottomed = bottomCardChoices(holder, draw, choice === -1 ? null : choice)
        if (inactiveCards) {
          inactiveCards = bottomed.cardRewards
          inactiveRares = bottomed.rareRewards
          characterCards[targetPlayerId as CharacterId] = inactiveCards
          characterRares[targetPlayerId as CharacterId] = inactiveRares
        } else Object.assign(source!, { cardRewards: bottomed.cardRewards, rareRewards: bottomed.rareRewards })
        continue
      }
      const deck = effect.source === 'colorless' ? colorless : source!.rareRewards
      const choices = deck.slice(0, reveal)
      if (choices.length === 0) continue
      const choice = indexes[used]
      if (choice === undefined) return { offer: choices, valid: true }
      if (choice !== -1 && !choices[choice]) return { valid: false }
      used++
      deck.splice(0, choices.length)
      deck.push(...(choice === -1 ? choices : choices.filter((_id, index) => index !== choice)))
      if (effect.source === 'colorless') colorless = deck
    }
  }
  return { valid: used === indexes.length }
}

export function chooseEvent(state: RunState, playerId: string, decision: EventDecision): RunState {
  const next = chooseEventInternal(state, playerId, decision, false)
  return next === state ? state : mirrorItemSupplies(next, next.itemDecks)
}

function chooseEventInternal(state: RunState, playerId: string, decision: EventDecision, acceptedTrade: boolean): RunState {
  if (state.phase !== 'room' || state.roomState?.kind !== 'event') return state
  const player = state.players.find((candidate) => candidate.id === playerId && !candidate.dead)
  if (!player || !decision || !Array.isArray(decision.optionIds)) return state
  if (!acceptedTrade && (decision.rewardItemIds !== undefined || decision.rewardItemKinds !== undefined)) return state
  if (decision.rewardItemChoices !== undefined && (!Array.isArray(decision.rewardItemChoices) || decision.rewardItemChoices.some((choice) => choice !== 'take' && choice !== 'skip'))) return state
  if (decision.rewardIndexes !== undefined && (!Array.isArray(decision.rewardIndexes) || decision.rewardIndexes.some((choice) => !Number.isInteger(choice) || choice < -1))) return state
  const optionCount = decision.optionIds.length
  if (state.roomState.card.id === 'knowing_skull'
    ? optionCount < 1 || optionCount > 2 || new Set(decision.optionIds).size !== optionCount
    : optionCount !== 1) return state
  const potionRecipients = decision.potionRecipientIds ?? (decision.potionRecipientId ? [decision.potionRecipientId] : [])
  if (potionRecipients.some((id) => id !== '' && !state.players.some((candidate) => candidate.id === id && !candidate.dead && candidate.id !== playerId && !hasRelic(candidate, 'sozu') && candidate.potions.length < potionLimit(state.ascension)))) return state
  if (Object.entries(Object.fromEntries([...new Set(potionRecipients.filter(Boolean))].map((id) => [id, potionRecipients.filter((candidate) => candidate === id).length]))).some(([id, count]) => {
    const recipient = state.players.find((candidate) => candidate.id === id)
    return (count as number) > potionLimit(state.ascension) - (recipient?.potions.length ?? potionLimit(state.ascension))
  })) return state
  if (state.roomState.card.id === 'lab' && !state.roomState.pendingRolls?.[playerId]) {
    if (decision.optionIds[0] !== 'resolve' || state.roomState.labChoices?.[playerId]) return state
    const revealed = state.roomState.itemOffers?.[playerId]
    const itemDecks = structuredClone(state.itemDecks)
    if (!revealed) {
      const potionId = drawItems(itemDecks.potions, 1)[0]
      if (!potionId) {
        const labChoices = { ...state.roomState.labChoices, [playerId]: decision }
        if (!state.players.filter((candidate) => !candidate.dead).every((candidate) => labChoices[candidate.id])) {
          return { ...state, roomState: { ...state.roomState, labChoices } }
        }
        const rng = { ...state.rng }
        const roll = 1 + nextInt(rng, 6)
        return { ...state, rng, roomState: {
          ...state.roomState,
          labChoices,
          pendingDecisions: { [playerId]: decision },
          pendingRolls: { [playerId]: [roll] },
          dieRolls: { ...state.roomState.dieRolls, [playerId]: [roll] },
        } }
      }
      return {
        ...state,
        itemDecks,
        roomState: {
          ...state.roomState,
          itemOffers: { ...state.roomState.itemOffers, [playerId]: [{ kind: 'potion', id: potionId }] },
          pendingDecisions: { ...state.roomState.pendingDecisions, [playerId]: stageEventDecision(decision) },
        },
      }
    }
    if (revealed.length !== 1 || revealed[0]?.kind !== 'potion' || decision.rewardItemChoices?.length !== 1) return state
    const pending = state.roomState.pendingDecisions?.[playerId]
    if (!pending || pending.optionIds.join(',') !== decision.optionIds.join(',')) return state
    const rng = { ...state.rng }
    const potionId = revealed[0].id
    let changed = player
    let players = state.players
    if (decision.rewardItemChoices[0] === 'skip') itemDecks.potions.push(potionId)
    else {
      const recipientId = decision.potionRecipientIds?.[0] ?? decision.potionRecipientId
      const recipientIndex = state.players.findIndex((candidate) => candidate.id === recipientId && candidate.id !== playerId && !candidate.dead && !hasRelic(candidate, 'sozu') && candidate.potions.length < potionLimit(state.ascension))
      if (recipientIndex >= 0) {
        const recipient = gainPotion(state.players[recipientIndex]!, potionId, state.ascension)
        if (recipient === state.players[recipientIndex]) itemDecks.potions.push(potionId)
        else players = state.players.map((candidate, index) => index === recipientIndex ? recipient : candidate)
      } else if (hasRelic(changed, 'sozu')) {
        itemDecks.potions.push(potionId)
      } else if (changed.potions.length >= potionLimit(state.ascension)) {
        const discardId = decision.potionReplacementIds?.[0]
        const at = discardId ? changed.potions.indexOf(discardId) : -1
        if (at >= 0) {
          changed = { ...changed, potions: changed.potions.filter((_id, index) => index !== at) }
          itemDecks.potions.push(discardId!)
        } else return state
      }
      if (recipientIndex < 0 && !hasRelic(changed, 'sozu') && changed.potions.length < potionLimit(state.ascension)) {
        const gained = gainPotion(changed, potionId, state.ascension)
        if (gained === changed) itemDecks.potions.push(potionId)
        else changed = gained
      }
    }
    players = players.map((candidate) => candidate.id === playerId ? changed : candidate)
    const labChoices = { ...state.roomState.labChoices, [playerId]: decision }
    const cleanRoom = {
      ...state.roomState,
      itemOffers: Object.fromEntries(Object.entries(state.roomState.itemOffers ?? {}).filter(([id]) => id !== playerId)),
      pendingDecisions: Object.fromEntries(Object.entries(state.roomState.pendingDecisions ?? {}).filter(([id]) => id !== playerId)),
    }
    if (!players.filter((candidate) => !candidate.dead).every((candidate) => labChoices[candidate.id])) {
      return { ...state, rng, itemDecks, players, roomState: { ...cleanRoom, labChoices } }
    }
    const roll = 1 + nextInt(rng, 6)
    return { ...state, rng, itemDecks, players, roomState: {
      ...cleanRoom,
      labChoices,
      pendingDecisions: { [playerId]: decision },
      pendingRolls: { [playerId]: [roll] },
      dieRolls: { ...state.roomState.dieRolls, [playerId]: [roll] },
    } }
  }
  const stagedDecision = state.roomState.pendingDecisions?.[playerId]
  if (stagedDecision && stagedDecision.optionIds.join(',') !== decision.optionIds.join(',') && !(state.roomState.card.id === 'scrap_ooze' && decision.optionIds[0] === 'leave')) return state
  const pendingTrade = state.roomState.pendingTrade
  if (pendingTrade) {
    if (pendingTrade.targetId !== playerId) return state
    if (decision.optionIds[0] === 'reject_trade') return {
      ...state,
      roomState: { ...state.roomState, pendingTrade: undefined },
    }
    if (decision.optionIds[0] !== 'accept_trade') return state
    const completed = pendingTrade.kind === 'card'
      ? { ...pendingTrade.decision, receiveCardUid: decision.cardUids?.[0] }
      : { ...pendingTrade.decision, receiveRelicId: decision.relicIds?.[0] }
    if (pendingTrade.kind === 'card' && !player.deck.some((card) => card.uid === completed.receiveCardUid)) return state
    if (pendingTrade.kind === 'card' && player.deck.find((card) => card.uid === completed.receiveCardUid)?.defId === 'ascenders_bane') return state
    if (pendingTrade.kind === 'relic' && !player.relics.some((relic) => relic.defId === completed.receiveRelicId)) return state
    return chooseEventInternal({ ...state, roomState: { ...state.roomState, pendingTrade: undefined } }, pendingTrade.actorId, completed, true)
  }
  if (!acceptedTrade && (decision.receiveCardUid !== undefined || decision.receiveRelicId !== undefined)) return state
  const options = decision.optionIds.map((id) => state.roomState?.kind === 'event' ? state.roomState.card.options.find((option) => option.id === id) : undefined)
  if (options.some((option) => !option)) return state
  if (!stagedDecision && options.some((option) => !eventOptionAvailable(state, player, option!))) return state
  if (state.roomState.card.id === 'big_fish') {
    const used = new Set([
      ...Object.entries(state.roomState.decisions),
      ...Object.entries(state.roomState.pendingDecisions ?? {}),
    ].filter(([id]) => id !== playerId).map(([, choice]) => choice.optionIds[0]))
    if (decision.optionIds.some((id) => used.has(id))) return state
  }
  const optionEffects = options.flatMap((option) => option!.effects)
  if (optionEffects.some((effect) => effect.source === 'other-character')) {
    const target = decision.targetPlayerId
    const active = state.players.some((candidate) => candidate.id === target && candidate.id !== playerId && !candidate.dead)
    const inactive = typeof target === 'string' && Object.hasOwn(state.itemDecks.characterCards, target) && Array.isArray(state.itemDecks.characterCards[target as CharacterId])
    if (!active && !inactive) return state
  }
  const paymentDue = optionEffects.reduce((sum, effect) => sum + (effect.tag === 'pay-gold' && typeof effect.amount === 'number' ? effect.amount : 0), 0)
  const paysWithItem = optionEffects.some((effect) => effect.tag === 'pay-gold' && effect.filter?.includes('or lose one Relic or Potion')) && ((decision.relicIds?.length ?? 0) > 0 || (decision.potionIds?.length ?? 0) > 0)
  if (!stagedDecision && paymentDue > 0 && !paysWithItem && state.players.filter((candidate) => !candidate.dead).reduce((sum, candidate) => sum + candidate.gold, 0) < paymentDue) return state
  if (!stagedDecision && state.roomState.card.id === 'we_meet_again') {
    if (decision.optionIds[0] === 'exchange' && (decision.relicIds?.length !== 1 || !player.relics.some((relic) => relic.defId === decision.relicIds?.[0]))) return state
    if (decision.optionIds[0] === 'give_card') {
      const card = decision.cardUids?.length === 1 ? player.deck.find((candidate) => candidate.uid === decision.cardUids?.[0]) : undefined
      if (!card || card.defId === 'ascenders_bane' || !['rare', 'uncommon'].includes(CARDS[card.defId]?.rarity ?? '')) return state
    }
  }
  if (!stagedDecision && state.roomState.card.id === 'nloth') {
    if (decision.optionIds[0] === 'offer_relic' && player.relics.length === 0) return state
    if (decision.optionIds[0] === 'offer_potion' && (decision.potionIds?.length !== 1 || !player.potions.includes(decision.potionIds[0]!))) return state
  }
  const otherPending = Object.entries(state.roomState.pendingDecisions ?? {}).filter(([id]) => id !== playerId)
  const stagesReward = optionEffects.some((effect) => ['card-reward', 'rare-reward', 'gain-relic', 'gain-potion'].includes(effect.tag))
  if (!stagedDecision && paymentDue > 0 && stagesReward && otherPending.length > 0) return state
  if (state.roomState.card.scope === 'party' && otherPending.length > 0) return state
  if (state.roomState.card.id === 'ancient_temple' && otherPending.length > 0) return state
  const tradeEffect = options.flatMap((option) => option!.effects).find((effect) => effect.tag === 'trade-card' || effect.tag === 'trade-relic')
  if (tradeEffect && !acceptedTrade) {
    const possible = tradeEffect.tag === 'trade-card'
      ? player.deck.some((card) => card.defId !== 'ascenders_bane') && state.players.some((candidate) => candidate.id !== playerId && !candidate.dead && candidate.deck.some((card) => card.defId !== 'ascenders_bane'))
      : player.relics.length > 0 && state.players.some((candidate) => candidate.id !== playerId && !candidate.dead && candidate.relics.length > 0)
    const target = state.players.find((candidate) => candidate.id === decision.targetPlayerId && candidate.id !== playerId && !candidate.dead)
    const offered = tradeEffect.tag === 'trade-card'
      ? decision.cardUids?.length === 1 && player.deck.find((card) => card.uid === decision.cardUids?.[0])?.defId
      : decision.relicIds?.length === 1 && player.relics.find((relic) => relic.defId === decision.relicIds?.[0])?.defId
    if (!possible) {
      // Non-Pay/Give Event effects with no valid target resolve as no-ops.
    } else if (!target || !offered || offered === 'ascenders_bane') return state
    else return {
      ...state,
      roomState: {
        ...state.roomState,
        pendingTrade: {
          kind: tradeEffect.tag === 'trade-card' ? 'card' : 'relic',
          actorId: playerId,
          targetId: target.id,
          offeredId: offered,
          decision,
        },
      },
    }
  }
  if (state.roomState.card.id === 'tomb_red_mask' && decision.optionIds.includes('don_mask') && !state.players.some((candidate) => candidate.relics.some((relic) => relic.defId === 'red_mask'))) return state
  if (state.roomState.card.id === 'falling' && !decision.cardUids?.every((uid) => state.roomState?.kind === 'event' && state.roomState.revealedCards?.[playerId]?.includes(uid))) return state
  if (state.roomState.card.id === 'mind_bloom' && (state.roomState.partyOptionIds?.[0] === 'awake' || decision.optionIds[0] === 'awake')) {
    if (state.roomState.partyOptionIds && state.roomState.partyOptionIds[0] !== decision.optionIds[0]) return state
    const available = player.deck.filter((card) => !card.upgraded && Boolean(CARDS[card.defId]?.upgrade)).slice(0, 2)
    if (state.roomState.decisions[playerId] || (decision.cardUids?.length ?? 0) !== available.length) return state
    let changed = player
    for (const uid of decision.cardUids ?? []) {
      const nextPlayer = upgradeCard(changed, uid)
      if (nextPlayer === changed) return state
      changed = nextPlayer
    }
    const hp = Math.max(0, changed.hp - 3)
    changed = { ...changed, hp, dead: hp === 0 }
    const decisions = { ...state.roomState.decisions, [playerId]: decision }
    const roomState = { ...state.roomState, partyOptionIds: ['awake'], decisions }
    const players = state.players.map((candidate) => candidate.id === playerId ? changed : candidate)
    if (changed.dead) return { ...state, phase: 'defeat', roomState: null, players, log: [...state.log, 'The party falls during Mind Bloom.'] }
    return state.players.filter((candidate) => !candidate.dead).every((candidate) => decisions[candidate.id])
      ? { ...state, phase: 'map', roomState: null, players, log: [...state.log, 'Mind Bloom is resolved.'] }
      : { ...state, roomState, players }
  }
  if (state.roomState.card.id === 'forgotten_altar' && decision.optionIds.includes('offer')) {
    const revealed = state.roomState.revealedRelics?.[playerId]
    if (!revealed) return state
    decision = { ...decision, relicIds: [revealed] }
  }
  const rewardEffects = options.flatMap((option) => option!.effects.some((effect) => effect.tag === 'combat') ? [] : option!.effects).filter((effect): effect is CardRewardEffect =>
    (effect.tag === 'card-reward' || effect.tag === 'rare-reward') && !effect.random,
  )
  const pending = state.roomState.pendingDecisions?.[playerId]
  if (rewardEffects.length > 0 && !pending && Object.keys(state.roomState.rewardOffers ?? {}).some((id) => id !== playerId)) return state
  if (state.roomState.card.id === 'face_trader' && decision.optionIds[0] === 'take_and_give' && !pending) {
    const rng = { ...state.rng }
    const itemDecks = structuredClone(state.itemDecks)
    const option = state.roomState.card.options.find((candidate) => candidate.id === 'take_and_give')!
    const staged = resolveEventDecision({ ...state.roomState, card: { ...state.roomState.card, options: [{ ...option, effects: option.effects.slice(0, 1) }] } }, rng, itemDecks, state.players, state.ascension, playerId, decision)
    if (!staged) return state
    const pending = stageEventDecision(decision)
    delete pending.relicIds
    return { ...state, rng, itemDecks, players: staged.players, roomState: { ...state.roomState, pendingDecisions: { ...state.roomState.pendingDecisions, [playerId]: pending } } }
  }
  if (state.roomState.card.id === 'nloth' && decision.optionIds[0] === 'offer_relic' && !pending) {
    const rng = { ...state.rng }
    const itemDecks = structuredClone(state.itemDecks)
    const option = state.roomState.card.options.find((candidate) => candidate.id === 'offer_relic')!
    const staged = resolveEventDecision({ ...state.roomState, card: { ...state.roomState.card, options: [{ ...option, effects: option.effects.slice(0, 1) }] } }, rng, itemDecks, state.players, state.ascension, playerId, decision)
    if (!staged) return state
    const locked = { ...state, rng, itemDecks, players: staged.players, roomState: { ...state.roomState, pendingDecisions: { ...state.roomState.pendingDecisions, [playerId]: stageEventDecision(decision) } } }
    return chooseEventInternal(locked, playerId, decision, false)
  }
  if (rewardEffects.length > 0) {
    const currentOffers = state.roomState.rewardOffers?.[playerId]
    const submitted = currentOffers ? decision.rewardIndexes : []
    if (currentOffers && (!submitted || submitted.length !== 1)) return state
    const indexes = [...(pending?.rewardIndexes ?? []), ...(submitted ?? [])]
    const preview = nextEventCardOffer(state, playerId, pending?.targetPlayerId ?? decision.targetPlayerId, rewardEffects, indexes)
    if (!preview.valid) return state
    if (preview.offer) return {
      ...state,
      roomState: {
        ...state.roomState,
        rewardOffers: { ...state.roomState.rewardOffers, [playerId]: [preview.offer] },
        pendingDecisions: { ...state.roomState.pendingDecisions, [playerId]: { ...stageEventDecision(pending ?? decision), ...(indexes.length > 0 ? { rewardIndexes: indexes } : {}) } },
      },
    }
    if (pending) decision = { ...decision, rewardIndexes: indexes }
  }
  const rollCount = options.flatMap((option) => option!.effects).filter((effect) => effect.tag === 'roll-d6').length
  if (rollCount > 0 && !state.roomState.pendingRolls?.[playerId]) {
    const preRollKinds = options.flatMap((option) => {
      const rollAt = option!.effects.findIndex((effect) => effect.tag === 'roll-d6')
      return option!.effects.slice(0, rollAt < 0 ? undefined : rollAt)
    }).flatMap((effect) => {
      const count = (effect.count ?? 1) * (effect.target === 'each-player' || effect.target === 'party' ? state.players.filter((candidate) => !candidate.dead).length : 1)
      return effect.tag === 'gain-relic' ? Array(count).fill('relic' as const) : effect.tag === 'gain-potion' ? Array(count).fill('potion' as const) : []
    })
    const itemOffer = state.roomState.itemOffers?.[playerId]
    if (preRollKinds.length > 0 && !itemOffer) {
      const itemDecks = structuredClone(state.itemDecks)
      const offers = preRollKinds.map((kind) => ({ kind, id: drawItems(kind === 'relic' ? itemDecks.relics : itemDecks.potions, 1)[0] ?? '' })).filter((offer) => offer.id)
      if (offers.length > 0) return { ...state, itemDecks, roomState: { ...state.roomState, itemOffers: { ...state.roomState.itemOffers, [playerId]: offers }, pendingDecisions: { ...state.roomState.pendingDecisions, [playerId]: stageEventDecision(pending ?? decision) } } }
    }
    if (itemOffer && (!decision.rewardItemChoices || decision.rewardItemChoices.length !== itemOffer.length)) return state
    const rollDecision = pending ? {
      ...pending,
      potionRecipientId: decision.potionRecipientId ?? pending.potionRecipientId,
      potionRecipientIds: decision.potionRecipientIds ?? pending.potionRecipientIds,
      potionReplacementIds: decision.potionReplacementIds ?? pending.potionReplacementIds,
      rewardItemChoices: decision.rewardItemChoices ?? pending.rewardItemChoices,
    } : decision
    if (itemOffer) {
      rollDecision.rewardItemIds = itemOffer.map((offer) => offer.id)
      rollDecision.rewardItemKinds = itemOffer.map((offer) => offer.kind)
    }
    const rng = { ...state.rng }
    const itemDecks = structuredClone(state.itemDecks)
    const staged = resolveEventBeforeRoll(state.roomState, rng, itemDecks, state.players, state.ascension, playerId, rollDecision)
    if (!staged) return state
    if (staged.players.some((candidate) => candidate.dead)) return { ...state, rng, itemDecks, players: staged.players, phase: 'defeat', roomState: null, log: [...state.log, `${state.roomState.card.name} defeats the party.`] }
    const rolls = Array.from({ length: rollCount }, () => 1 + nextInt(rng, 6))
    return { ...state, rng, itemDecks, players: staged.players, roomState: {
      ...state.roomState,
      itemOffers: Object.fromEntries(Object.entries(state.roomState.itemOffers ?? {}).filter(([id]) => id !== playerId)),
      pendingDecisions: { ...state.roomState.pendingDecisions, [playerId]: rollDecision },
      pendingRolls: { ...state.roomState.pendingRolls, [playerId]: rolls },
      dieRolls: { ...state.roomState.dieRolls, [playerId]: [...(state.roomState.dieRolls[playerId] ?? []), ...rolls] },
    } }
  }
  let rollIndex = 0
  const activeEffects = (effects: readonly import('./events.ts').EventEffect[]): import('./events.ts').EventEffect[] => effects.flatMap((effect) => {
    if (effect.tag !== 'roll-d6') return [effect]
    const roll = state.roomState?.kind === 'event' ? state.roomState.pendingRolls?.[playerId]?.[rollIndex++] : undefined
    return roll ? activeEffects(effect.results?.[roll as 1 | 2 | 3 | 4 | 5 | 6] ?? []) : []
  })
  const itemKinds = options.flatMap((option) => {
    const rollAt = option!.effects.findIndex((effect) => effect.tag === 'roll-d6')
    const effects = activeEffects(rollAt < 0 ? option!.effects : option!.effects.slice(rollAt))
    const combatAt = effects.findIndex((effect) => effect.tag === 'combat')
    return effects.slice(0, combatAt < 0 ? undefined : combatAt)
  }).flatMap((effect) => {
    const count = (effect.count ?? 1) * (effect.target === 'each-player' || effect.target === 'party' ? state.players.filter((candidate) => !candidate.dead).length : 1)
    return effect.tag === 'gain-relic'
      ? Array(count).fill('relic' as const)
      : effect.tag === 'gain-potion'
        ? Array(count).fill('potion' as const)
        : []
  })
  const itemOffer = state.roomState.itemOffers?.[playerId]
  let stagedItemDecks: ItemDecks | undefined
  if (itemKinds.length > 0 && !itemOffer && !(state.roomState.card.id === 'face_trader' && decision.optionIds[0] === 'take_and_give')) {
    const completeDecks = structuredClone(state.itemDecks)
    const completeOffers = itemKinds.map((kind) => ({ kind, id: drawItems(kind === 'relic' ? completeDecks.relics : completeDecks.potions, 1)[0] ?? '' }))
    if (completeOffers.every((offer) => offer.id)) return { ...state, itemDecks: completeDecks, roomState: { ...state.roomState, itemOffers: { ...state.roomState.itemOffers, [playerId]: completeOffers }, pendingDecisions: { ...state.roomState.pendingDecisions, [playerId]: stageEventDecision(pending ?? decision) } } }
    const itemDecks = structuredClone(state.itemDecks)
    const rewardItemIds: string[] = []
    const rewardItemKinds: ('relic' | 'potion')[] = []
    for (const kind of itemKinds) {
      const id = drawItems(kind === 'relic' ? itemDecks.relics : itemDecks.potions, 1)[0]
      if (id) return { ...state, itemDecks, roomState: { ...state.roomState, itemOffers: { ...state.roomState.itemOffers, [playerId]: [{ kind, id }] }, pendingDecisions: { ...state.roomState.pendingDecisions, [playerId]: { ...stageEventDecision(pending ?? decision), rewardItemIds, rewardItemKinds } } } }
      rewardItemIds.push('')
      rewardItemKinds.push(kind)
    }
  }
  if (itemOffer && (!decision.rewardItemChoices || decision.rewardItemChoices.length !== itemOffer.length)) return state
  if (itemOffer) {
    const itemDecks = structuredClone(state.itemDecks)
    const rewardItemIds = [...(pending?.rewardItemIds ?? [])]
    const rewardItemKinds = [...(pending?.rewardItemKinds ?? [])]
    const rewardItemChoices = [...(pending?.rewardItemChoices ?? [])]
    const potionRecipientIds = [...(pending?.potionRecipientIds ?? [])]
    const potionReplacementIds = [...(pending?.potionReplacementIds ?? [])]
    const submittedRecipients = decision.potionRecipientIds ?? (decision.potionRecipientId ? [decision.potionRecipientId] : [])
    let potionIndex = 0
    itemOffer.forEach((offer, index) => {
      const choice = decision.rewardItemChoices?.[index]
      rewardItemKinds.push(offer.kind)
      rewardItemChoices.push(choice!)
      if (offer.kind === 'potion') {
        potionRecipientIds.push(submittedRecipients[potionIndex] ?? '')
        potionReplacementIds.push(decision.potionReplacementIds?.[potionIndex] ?? '')
      }
      if (choice === 'skip') {
        rewardItemIds.push('')
        ;(offer.kind === 'relic' ? itemDecks.relics : itemDecks.potions).push(offer.id)
      } else {
        rewardItemIds.push(offer.id)
        if (offer.id === 'old_coin') itemDecks.relics.push(offer.id)
      }
      if (offer.kind === 'potion') potionIndex++
    })
    for (const kind of itemKinds.slice(rewardItemIds.length)) {
      const id = drawItems(kind === 'relic' ? itemDecks.relics : itemDecks.potions, 1)[0]
      if (id) return {
        ...state,
        itemDecks,
        roomState: {
          ...state.roomState,
          itemOffers: { ...state.roomState.itemOffers, [playerId]: [{ kind, id }] },
          pendingDecisions: { ...state.roomState.pendingDecisions, [playerId]: {
            ...stageEventDecision(pending ?? decision),
            rewardItemIds,
            rewardItemKinds,
            rewardItemChoices,
            potionRecipientIds,
            potionReplacementIds,
          } },
        },
      }
      rewardItemIds.push('')
      rewardItemKinds.push(kind)
    }
    stagedItemDecks = itemDecks
    decision = {
      ...decision,
      rewardItemIds,
      rewardItemKinds,
      rewardItemChoices,
      potionRecipientIds,
      potionReplacementIds,
    }
  }
  const leavesScrap = pending && state.roomState.card.id === 'scrap_ooze' && decision.optionIds[0] === 'leave'
  const finalDecision = pending && !leavesScrap ? {
    ...pending,
    cardUids: pending.cardUids?.length ? pending.cardUids : decision.cardUids,
    relicIds: pending.relicIds?.length ? pending.relicIds : decision.relicIds,
    potionIds: pending.potionIds?.length ? pending.potionIds : decision.potionIds,
    potionRecipientId: decision.potionRecipientId ?? pending.potionRecipientId,
    potionRecipientIds: decision.potionRecipientIds?.length ? decision.potionRecipientIds : pending.potionRecipientIds,
    potionReplacementIds: decision.potionReplacementIds?.length ? decision.potionReplacementIds : pending.potionReplacementIds,
    rewardItemChoices: decision.rewardItemChoices?.length ? decision.rewardItemChoices : pending.rewardItemChoices,
    rewardItemIds: decision.rewardItemIds ?? pending.rewardItemIds,
    rewardItemKinds: decision.rewardItemKinds ?? pending.rewardItemKinds,
    targetPlayerId: pending.targetPlayerId || decision.targetPlayerId,
    rewardIndexes: decision.rewardIndexes?.length ? decision.rewardIndexes : pending.rewardIndexes,
    roomId: pending.roomId ?? decision.roomId,
    payments: decision.payments ?? pending.payments,
  } : decision
  const rng = { ...state.rng }
  const itemDecks = stagedItemDecks ?? structuredClone(state.itemDecks)
  const forcedRolls = leavesScrap ? [] : state.roomState.pendingRolls?.[playerId] ?? []
  const cleanRoom = pending ? {
    ...state.roomState,
    rewardOffers: Object.fromEntries(Object.entries(state.roomState.rewardOffers ?? {}).filter(([id]) => id !== playerId)),
    itemOffers: Object.fromEntries(Object.entries(state.roomState.itemOffers ?? {}).filter(([id]) => id !== playerId)),
    pendingDecisions: Object.fromEntries(Object.entries(state.roomState.pendingDecisions ?? {}).filter(([id]) => id !== playerId)),
    pendingRolls: Object.fromEntries(Object.entries(state.roomState.pendingRolls ?? {}).filter(([id]) => id !== playerId)),
    dieRolls: forcedRolls.length > 0
      ? { ...state.roomState.dieRolls, [playerId]: (state.roomState.dieRolls[playerId] ?? []).slice(0, -forcedRolls.length) }
      : state.roomState.dieRolls,
  } : state.roomState
  if (itemOffer && !finalDecision.rewardItemIds) {
    finalDecision.rewardItemIds = itemOffer.map((offer) => offer.id)
    finalDecision.rewardItemKinds = itemOffer.map((offer) => offer.kind)
  }
  const faceTraderResume = pending && state.roomState.card.id === 'face_trader' && pending.optionIds[0] === 'take_and_give'
  const nlothResume = pending && state.roomState.card.id === 'nloth' && pending.optionIds[0] === 'offer_relic'
  const resolutionRoom = faceTraderResume || nlothResume ? {
    ...cleanRoom,
    card: { ...cleanRoom.card, options: cleanRoom.card.options.map((option) => option.id === pending.optionIds[0] ? { ...option, effects: option.effects.slice(1) } : option) },
  } : cleanRoom
  const result = resolveEventDecision(resolutionRoom, rng, itemDecks, state.players, state.ascension, playerId, finalDecision, forcedRolls, forcedRolls.length > 0)
  if (!result) return state
  if (faceTraderResume) result.event.card = state.roomState.card
  if (result.players.some((candidate) => candidate.dead)) return { ...state, rng, itemDecks, players: result.players, phase: 'defeat', roomState: null, log: [...state.log, `${result.event.card.name} defeats the party.`] }
  let next: RunState = { ...state, rng, itemDecks, players: result.players, roomState: result.event }
  if (result.merchant) return { ...next, roomState: createMerchant(itemDecks, result.players) }
  if (result.moveTo) {
    const target = state.map.rooms[result.moveTo]
    const current = currentRoom(state.map)
    if (!target || !current || target.row <= current.row) return state
    const temporaryMap = { ...state.map, rooms: { ...state.map.rooms, [current.id]: { ...current, exits: [target.id] } } }
    const portalState: RunState = { ...next, phase: 'map', roomState: null, map: temporaryMap }
    const entered = enterRoom(portalState, target.id)
    return entered === portalState ? state : {
      ...entered,
      map: { ...entered.map, rooms: { ...entered.map.rooms, [current.id]: current } },
    }
  }
  if (result.combat) {
    const room = currentRoom(state.map)
    if (!room) return state
    const players = result.players.map((player) => readyForCombat(rng, player))
    const mindBloom = result.event.card.id === 'mind_bloom' && finalDecision.optionIds.includes('war')
    // The boss-content integration consumes this seeded physical Boss id. The
    // legacy combat shell falls back only while those enemy faces are absent.
    const actOneBosses = BOSSES[1]!
    const bossDefId = mindBloom ? actOneBosses[nextInt(rng, actOneBosses.length)] : undefined
    const enemyDecks = state.enemyDecks.act === (mindBloom ? 1 : state.act)
      ? structuredClone(state.enemyDecks)
      : createEnemyDecks(rng, mindBloom ? 1 : state.act, state.ascension)
    const encounter = buildEncounter(
      rng,
      enemyDecks,
      mindBloom ? 1 : state.act,
      players,
      mindBloom ? 'boss' : result.combat,
      false,
      state.ascension,
      bossDefId,
    )
    const combat = startPlayerTurnWithChoices(createCombat(
      rng,
      players,
      encounter.enemies,
      room.id,
      state.potionDeck,
      state.ascension >= 4 ? 2 : 3,
      encounter.summonSupply,
    ))
    return { ...next, enemyDecks, phase: 'combat', players, combat, roomState: null, eventCombat: { kind: mindBloom ? 'boss' : result.combat, mindBloom, bossDefId }, courier: { usedBy: [], offer: null } }
  }
  return result.complete
    ? { ...next, phase: 'map', roomState: null, log: [...state.log, `${result.event.card.name} is resolved.`] }
    : next
}

function eventOptionAvailable(state: RunState, player: Player, option: EventCard['options'][number]): boolean {
  const partyGold = state.players.filter((candidate) => !candidate.dead).reduce((sum, candidate) => sum + candidate.gold, 0)
  return option.effects.every((effect, index) => {
    if (effect.filter === 'party has Red Mask') return state.players.some((candidate) => candidate.relics.some((relic) => relic.defId === 'red_mask'))
    if (effect.tag === 'gain-relic') return option.effects.some((candidate) => candidate.tag === 'roll-d6') || state.itemDecks.relics.length > 0 || option.effects.slice(0, index).some((candidate) => candidate.tag === 'lose-relic' && (player.relics.length > 0 || state.roomState?.kind === 'event' && Boolean(state.roomState.revealedRelics?.[player.id]))) || state.roomState?.kind === 'event' && (state.roomState.itemOffers?.[player.id]?.some((offer) => offer.kind === 'relic') === true || state.roomState.pendingDecisions?.[player.id]?.optionIds.includes(option.id) === true)
    if (effect.tag === 'gain-potion') return option.effects.some((candidate) => candidate.tag === 'roll-d6') || state.itemDecks.potions.length > 0 || state.roomState?.kind === 'event' && (state.roomState.itemOffers?.[player.id]?.some((offer) => offer.kind === 'potion') === true || state.roomState.pendingDecisions?.[player.id]?.optionIds.includes(option.id) === true)
    if (effect.tag === 'pay-gold') return partyGold >= (typeof effect.amount === 'number' ? effect.amount : 0) || Boolean(effect.filter?.includes('or lose one Relic or Potion') && (player.relics.length || player.potions.length))
    if (effect.tag === 'lose-relic') return player.relics.length > 0 || option.effects.slice(0, index).some((candidate) => candidate.tag === 'gain-relic' && state.itemDecks.relics.length > 0)
    if (effect.tag === 'lose-potion') return player.potions.length > 0
    if (effect.tag === 'remove-card' && (option.id === 'give_card' || option.effects.slice(0, index).some((candidate) => candidate.tag === 'pay-gold'))) return player.deck.some((card) => card.defId !== 'ascenders_bane' && (option.id !== 'give_card' || ['rare', 'uncommon'].includes(CARDS[card.defId]?.rarity ?? '')))
    if (effect.tag === 'upgrade-card' && !effect.random && option.effects.slice(0, index).some((candidate) => candidate.tag === 'pay-gold')) return player.deck.some((card) => !card.upgraded && Boolean(CARDS[card.defId]?.upgrade))
    if ((effect.tag === 'rare-reward' || effect.tag === 'card-reward' && effect.source === 'rare') && option.effects.slice(0, index).some((candidate) => ['pay-gold', 'lose-relic', 'lose-potion', 'remove-card'].includes(candidate.tag))) return player.rareRewards.length > 0
    return true
  })
}

export function canSkipEvent(state: RunState, playerId: string): boolean {
  if (state.phase !== 'room' || state.roomState?.kind !== 'event' || state.roomState.decisions[playerId]) return false
  const player = state.players.find((candidate) => candidate.id === playerId && !candidate.dead)
  const used = state.roomState.card.id === 'big_fish' ? new Set([
    ...Object.entries(state.roomState.decisions),
    ...Object.entries(state.roomState.pendingDecisions ?? {}),
  ].filter(([id]) => id !== playerId).map(([, choice]) => choice.optionIds[0])) : null
  return Boolean(player && !state.roomState.card.options.some((option) => !used?.has(option.id) && eventOptionAvailable(state, player, option)))
}

export function skipEvent(state: RunState, playerId: string): RunState {
  if (!canSkipEvent(state, playerId) || state.roomState?.kind !== 'event') return state
  const decisions = { ...state.roomState.decisions, [playerId]: { optionIds: ['unavailable'] } }
  const done = state.roomState.card.scope === 'party' || state.players.filter((player) => !player.dead).every((player) => decisions[player.id])
  return done
    ? { ...state, phase: 'map', roomState: null, log: [...state.log, `${state.roomState.card.name} is left unresolved.`] }
    : { ...state, roomState: { ...state.roomState, decisions } }
}

/** Leaves only a room whose printed interaction is already resolved. */
export function leaveRoom(state: RunState): RunState {
  if (state.phase !== 'room') return state
  if (state.roomState) return state
  return { ...state, phase: 'map' }
}

export type CampfireChoice = 'rest' | 'smith' | 'leave' | 'ruby'
export type CampfireDecision = { choice: CampfireChoice; cardUid?: string; removeCardUid?: string }

/**
 * A campfire: each player chooses Rest (heal 3) or Smith (upgrade a card),
 * independently (p.9). Choices arrive per player so one message carries the
 * whole room, the same way a card play carries its choices.
 *
 * Returns the SAME state reference if this is not a campfire.
 */
export function resolveCampfire(
  state: RunState,
  choices: Record<string, CampfireDecision>,
): RunState {
  if (state.phase !== 'room') return state
  if (currentRoom(state.map)?.kind !== 'campfire') return state

  const live = state.players.filter((player) => !player.dead)
  const ruby = isActIVUnlocked(state.campaignProgress) && !state.campaign.keys.ruby && live.length > 0
    && live.every((player) => choices[player.id]?.choice === 'ruby')

  const players = state.players.map((player) => {
    const decision = choices[player.id]
    if (!decision || player.dead) return player
    if (decision.choice === 'leave') return player

    if (decision.choice === 'ruby') return player
    if (decision.choice === 'rest') {
      if (hasRelic(player, 'coffee_dripper')) return player
      const removable = hasRelic(player, 'peace_pipe') && decision.removeCardUid
        ? player.deck.find((card) => card.uid === decision.removeCardUid)
        : undefined
      const rested = removable ? removeCard(player, removable.uid) : player
      const healed = Math.min(rested.maxHp, rested.hp + 3 + (hasRelic(rested, 'regal_pillow') ? 3 : 0))
      return {
        ...rested,
        hp: Math.min(healingCapFor(rested), healed),
      }
    }

    if (hasRelic(player, 'fusion_hammer')) return player

    // Smith upgrades one card in the deck. An already-upgraded card cannot be
    // upgraded again, so naming one is simply ignored.
    const target = player.deck.find(
      (card) => card.uid === decision.cardUid && canUpgradeCard(card),
    )
    if (!target) return player
    return {
      ...player,
      deck: player.deck.map((card) =>
        card.uid === target.uid ? { ...card, upgraded: true } : card,
      ),
    }
  })

  return {
    ...state,
    phase: 'map',
    players,
    campaign: ruby ? { ...state.campaign, keys: { ...state.campaign.keys, ruby: true } } : state.campaign,
    log: [...state.log, ruby ? 'The party claims the Ruby Key.' : 'The party rests at a campfire.'],
  }
}

/**
 * Starts the next Act: a fresh map, and every player healed to full (p.4).
 * Ascension 6 changes the heal to 4 HP rather than full.
 */
export function advanceAct(state: RunState): RunState {
  if (state.phase !== 'victory' || hasPendingRelicAcquisition(state) || state.campaign.finalized) return state
  if (!isActComplete(state.map)) return state
  if (state.act >= 4) return state

  const rng = { ...state.rng }
  const requestedAct = state.act + 1
  if (requestedAct > 4) return state
  if (requestedAct === 4 && !canEnterActIV(state.campaignProgress, state.campaign.keys, state.act)) return state
  const act = requestedAct
  const players = state.players.map((player) => ({
    ...player,
    hp: Math.min(healingCapFor(player), state.ascension >= 6 ? player.hp + 4 : player.maxHp),
    // Skipped common/uncommon rewards are shuffled back between Acts; rares
    // deliberately keep their order (setup p.4).
    cardRewards: shuffle(rng, [...player.cardRewards]),
  }))

  const colorlessUnlocked = isColorlessUnlocked(state.campaignProgress)
  const baseMap = generateMap(rng, act, ACT_SHAPE, state.ascension)
  const map = act === 4
    ? actIVMap(state.ascension >= 11)
    : !isActIVUnlocked(state.campaignProgress) || state.campaign.keys.emerald
      ? baseMap
      : addBurningElite(rng, baseMap)
  return {
    ...state,
    rng,
    act,
    phase: 'map',
    map,
    enemyDecks: createEnemyDecks(rng, act, state.ascension),
    players,
    combat: null,
    pendingBossDefId: null,
    eventDeck: act === 4 ? [] : buildEventDeck(rng, act as 1 | 2 | 3, state.ascension, colorlessUnlocked),
    eventsVisited: 0,
    roomState: null,
    eventCombat: null,
    log: [...state.log, `Act ${act} begins.`],
  }
}

/** Finalizes a completed/lost physical game exactly once and awards its marks. */
export function finishRun(state: RunState): RunState {
  if ((state.phase !== 'victory' && state.phase !== 'defeat') || state.campaign.finalized) return state
  const campaignProgress = finishCampaign(state.campaignProgress, {
    runId: state.campaign.runId,
    characters: state.players.map((player) => player.character),
    bossesDefeated: state.campaign.bossesDefeated,
    highestBossActDefeated: state.campaign.highestBossActDefeated,
    ascensionPlayed: state.ascension,
  })
  return { ...state, campaignProgress, campaign: { ...state.campaign, finalized: true } }
}

/** Rooms the party may move to right now, or none if it is not their choice. */
export function roomChoices(state: RunState): Room[] {
  if (state.phase !== 'map') return []
  const map = state.map
  if (map.position === null) {
    const first = map.rows[0]?.[0]
    const room = first ? map.rooms[first] : undefined
    return room ? [room] : []
  }
  const current = map.rooms[map.position]
  if (!current) return []
  return current.exits.map((id) => map.rooms[id]).filter((room): room is Room => room !== undefined)
}

/** Unconnected rooms exactly one row above that Wing Boots may reach. */
export function wingBootChoices(state: RunState, playerId: string): Room[] {
  if (state.phase !== 'map' || state.map.position === null) return []
  const player = state.players.find((candidate) => candidate.id === playerId && !candidate.dead)
  if (!player?.relics.some((relic) => relic.defId === 'wing_boots' && (relic.uses ?? 0) > 0)) return []
  const current = state.map.rooms[state.map.position]
  if (!current) return []
  const normal = new Set(current.exits)
  return (state.map.rows[current.row + 1] ?? [])
    .filter((id) => !normal.has(id))
    .map((id) => state.map.rooms[id])
    .filter((room): room is Room => room !== undefined)
}
