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
import { ACT_SHAPE, generateMap, currentRoom, moveTo, isActComplete } from './map.ts'
import type { Room, RoomKind, SpireMap } from './map.ts'
import {
  POTION_DECK,
  bossRelicOfferSize,
  createRelicDecks,
  createRelicInstance,
  relicDef,
  STARTING_RELIC,
} from './relics.ts'
import { createRng, nextInt, shuffle } from './rng.ts'
import type { RngState } from './rng.ts'
import type { CardInstance, CharacterId, Enemy, Player } from './types.ts'

export type RunPhase =
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
  log: string[]
}

export type CardRewardOffer = {
  playerId: string
  /** False when this encounter printed no card reward or it has been settled. */
  cardReward: boolean
  choices: string[] | null
  upgraded: boolean
  /** Indices drawn from the rare stack by Golden Tickets. Public once revealed. */
  rareChoiceIndices?: number[]
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

export const healingCapFor = (player: Pick<Player, 'maxHp' | 'relics'>): number =>
  player.relics.some((relic) => relic.defId === 'mark_of_pain') ? 6 : player.maxHp

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

function rewardDeck(character: CharacterId, rare: boolean): string[] {
  const cards = Object.values(CARDS).flatMap((def) => {
    if (def.owner !== character) return []
    if (rare) return def.rarity === 'rare' ? [def.id] : []
    if (def.rarity === 'common') return Array(def.id === 'claw_claw_pack' ? 8 : 2).fill(def.id)
    return def.rarity === 'uncommon' ? [def.id] : []
  })
  return rare ? cards : [...cards, GOLDEN_TICKET, GOLDEN_TICKET]
}

export function createPlayer(
  rng: RngState,
  id: string,
  name: string,
  character: CharacterId,
  row: number,
  addedCards: readonly string[] = [],
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
    cardRewards: shuffle(rng, rewardDeck(character, false)),
    rareRewards: shuffle(rng, rewardDeck(character, true)),
    dead: false,
  }
}

export type PartyMember = { id: string; name: string; character: CharacterId }

export function createRun(seed: number, party: PartyMember[], ascension = 0): RunState {
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
    ),
  )
  // Solo starts with 2 extra gold and the Loaded Die (p.4, step 12).
  const solo = players.length === 1 ? players[0] : undefined
  if (solo) {
    solo.gold += 2
    solo.relics = [...solo.relics, { defId: 'loaded_die', spent: false }]
  }
  if (ascension >= 2) {
    for (const player of players) {
      player.maxHp -= 1
      player.hp -= 1
    }
  }
  if (ascension >= 9) for (const player of players) player.hp -= 1

  const relicDecks = createRelicDecks(rng)
  return {
    rng,
    seed,
    ascension,
    act: 1,
    phase: 'map',
    map: generateMap(rng, 1, ACT_SHAPE, ascension),
    enemyDecks: createEnemyDecks(rng, 1, ascension),
    players,
    combat: null,
    potionDeck: shuffle(rng, [...POTION_DECK]),
    ...relicDecks,
    pendingBossDefId: null,
    rewards: [],
    rewardDestination: null,
    log: ['The party enters the Spire.'],
  }
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
    const players = roomPlayers.map((player) => readyForCombat(rng, player))
    const first = state.act === 1 && state.map.position === null && room.id === state.map.rows[0]?.[0]
    const { enemies, summonSupply, nextBossDefId } = buildEncounter(
      rng, enemyDecks, state.act, players, room.kind, first, state.ascension,
    )
    // Start the first Player Turn immediately: entering a room with no cards in
    // hand and nothing to do is not a state the game ever sits in.
    const combat = startPlayerTurnWithChoices(createCombat(
      rng, players, enemies, room.id, state.potionDeck, state.ascension >= 4 ? 2 : 3, summonSupply,
    ))
    return { ...next, phase: 'combat', players, combat, pendingBossDefId: nextBossDefId ?? null }
  }

  if (room.kind === 'treasure') {
    return {
      ...next,
      phase: 'reward',
      rewards: roomPlayers.filter((player) => !player.dead).map((player) => ({
        playerId: player.id,
        cardReward: false,
        choices: null,
        upgraded: false,
        potion: false,
        relic: null,
        bossRelics: false,
      })),
      rewardDestination: 'map',
    }
  }

  if (room.kind === 'event') {
    return {
      ...next,
      phase: 'room',
      players: roomPlayers.map((player) => hasRelic(player, 'ssserpent_head') && !hasRelic(player, 'ectoplasm')
        ? { ...player, gold: player.gold + 2 }
        : player),
    }
  }
  return { ...next, phase: 'room' }
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
  if (!combat || (combat.phase !== 'won' && combat.phase !== 'lost')) return state

  const epitaph = combat.log.filter((line) => !/^Turn \d+ begins/.test(line)).slice(-COMBAT_EPITAPH)
  if (combat.phase === 'lost') {
    return {
      ...state,
      phase: 'defeat',
      players: combat.players,
      combat: null,
      potionDeck: combat.potionDeck,
      pendingBossDefId: null,
      rewards: [],
      rewardDestination: null,
      log: [...state.log, ...epitaph, 'The party has fallen.'],
    }
  }

  const room = currentRoom(state.map)
  const wasBoss = room?.kind === 'boss'
  const sharedReward = room?.kind === 'elite'
    ? combat.enemies.find((enemy) => enemyDef(enemy.defId, enemy.ascension).elite)
    : undefined
  const players = state.players.map((player) => {
    const after = combat.players.find((candidate) => candidate.id === player.id)
    if (!after) return player
    const source = sharedReward ?? combat.enemies.find((enemy) => enemy.row === after.row)
    const rewardGold = source?.goldReward ?? 0
    const canGainGold = !hasRelic(after, 'ectoplasm')
    const goldenIdol = hasRelic(after, 'golden_idol') ? 1 : 0
    const meatHp = hasRelic(after, 'meat_on_the_bone') && after.hp < 4 ? 4 : after.hp
    const hp = hasRelic(after, 'mark_of_pain') ? Math.min(6, meatHp) : meatHp
    return {
      ...player,
      hp,
      gold: after.gold + (canGainGold ? rewardGold + goldenIdol : 0),
      row: after.row,
      potions: after.potions,
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
    const cardReward = Boolean(source?.cardReward && player.cardRewards.length >= 3)
    const potionCount = Number(source?.potionReward === true) + Number(hasRelic(player, 'white_beast_statue'))
    const potion: false | null = potionCount > 0 ? null : false
    const relic: false | null = source?.relicReward === true ? null : false
    if (!cardReward && potion === false && relic === false) return []
    return [{
      playerId: player.id,
      cardReward,
      choices: null,
      upgraded: source?.cardReward === 'upgraded',
      potion,
      potionQueue: potionCount > 1 ? Array(potionCount - 1).fill(null) : undefined,
      relic,
      bossRelics: false as const,
    }]
  })
  return {
    ...state,
    phase: rewards.length > 0 ? 'reward' : destination,
    players,
    bossRelicDeck: wasBoss && !finalBoss ? state.bossRelicDeck.slice(bossChoices.length) : state.bossRelicDeck,
    potionDeck: combat.potionDeck,
    combat: null,
    pendingBossDefId: betweenBosses ? state.pendingBossDefId : null,
    rewards,
    rewardDestination: rewards.length > 0 ? destination : null,
    log: [...state.log, betweenBosses
      ? 'The party regroups before the second Act III boss.'
      : wasBoss && state.act >= 4
      ? 'The Spire is conquered.'
      : wasBoss ? 'The Act is won.' : 'The enemies fall.'],
  }
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
        }
      : candidate),
  }
}

export const potionLimitFor = (ascension: number): 2 | 3 => ascension >= 4 ? 2 : 3

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
  return {
    ...state,
    potionDeck: state.potionDeck.slice(1),
    rewards: state.rewards.map((candidate) => candidate === offer ? { ...candidate, potion } : candidate),
    log: [...state.log, `${state.players.find((player) => player.id === playerId)?.name ?? 'A player'} reveals a Potion reward.`],
  }
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
    const next: RunState = {
      ...state,
      potionDeck: [...state.potionDeck, ...bottom],
      rewards: state.rewards.map((candidate) => candidate === offer ? settlePotionOffer(candidate) : candidate),
      log: [...state.log, `${owner.name} skips a Potion reward${bottom.length ? '' : ' unseen'}.`],
    }
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
  const next: RunState = {
    ...state,
    players,
    potionDeck: [...state.potionDeck, ...returned],
    rewards: state.rewards.map((candidate) => candidate === offer ? settlePotionOffer(candidate) : candidate),
    log: [...state.log, `${recipient.name} gains ${offer.potion}.`],
  }
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
  if (potionId === 'entropic_brew') {
    const overflow = Math.max(0, player.potions.length - 1 + 2 - potionLimitFor(state.ascension))
    const replaceable = replacePotionId !== potionId && player.potions.includes(replacePotionId ?? '')
    if (player.relics.some((relic) => relic.defId === 'sozu') || overflow > 1 || (overflow === 1) !== replaceable) return state
  } else if (replacePotionId !== undefined) return state
  if (potionId !== 'blood_potion' && potionId !== 'entropic_brew') return state
  const deck = [...state.potionDeck]
  const gained = potionId === 'entropic_brew' ? deck.splice(0, 2) : []
  deck.push(potionId, ...(replacePotionId ? [replacePotionId] : []))
  let removed = false
  let replaced = false
  return {
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
          if (!replaced && potion === replacePotionId) { replaced = true; return false }
          return true
        }),
        ...gained,
      ],
    }),
    log: [...state.log, `${player.name} uses ${potionId}.`],
  }
}

export function revealRelicReward(state: RunState, playerId: string): RunState {
  if (state.phase !== 'reward' || hasPendingRelicAcquisition(state)) return state
  const offer = state.rewards.find((candidate) => candidate.playerId === playerId)
  const relic = state.relicDeck[0]
  if (!offer || offer.relic !== null || !relic) return state
  return {
    ...state,
    relicDeck: state.relicDeck.slice(1),
    rewards: state.rewards.map((candidate) => candidate === offer ? { ...candidate, relic } : candidate),
  }
}

const CURSE_IDS = Object.values(CARDS)
  .filter((def) => def.type === 'curse' && def.id !== 'ascenders_bane')
  .map((def) => def.id)

function nextRunUid(players: readonly Player[]): number {
  return Math.max(0, ...players.flatMap((player) => player.deck.map((card) =>
    Number(/^c(\d+)$/.exec(card.uid)?.[1] ?? 0)))) + 1
}

function hasRelic(player: Player, defId: string): boolean {
  return player.relics.some((relic) => relic.defId === defId)
}

function eggUpgrade(player: Player, defId: string, alreadyUpgraded = false): { player: Player; upgraded: boolean } {
  if (alreadyUpgraded) return { player, upgraded: true }
  const eggId = CARDS[defId]?.type === 'attack' ? 'molten_egg'
    : CARDS[defId]?.type === 'skill' ? 'toxic_egg' : null
  const egg = eggId ? player.relics.find((relic) => relic.defId === eggId && (relic.uses ?? 0) > 0) : undefined
  if (!egg) return { player, upgraded: false }
  const relics = egg.uses === 1
    ? player.relics.filter((relic) => relic !== egg)
    : player.relics.map((relic) => relic === egg ? { ...relic, uses: relic.uses! - 1 } : relic)
  return { player: { ...player, relics }, upgraded: true }
}

/**
 * One authoritative acquisition boundary for rewards, Calling Bell, and future
 * Merchant/Event callers. Immediate physical text resolves here; choice-based
 * one-shot relics remain face up with `pending` until their owner resolves it.
 */
export function acquireRelic(state: RunState, playerId: string, relicId: string): RunState {
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (!player || !relicDef(relicId)) return state
  const rng = { ...state.rng }
  let relicDeck = [...state.relicDeck]
  let uid = nextRunUid(state.players)
  const addCurse = (owner: Player): Player => {
    if (hasRelic(owner, 'omamori') || CURSE_IDS.length === 0) return owner
    const defId = CURSE_IDS[nextInt(rng, CURSE_IDS.length)]!
    return { ...owner, deck: [...owner.deck, { uid: `c${uid++}`, defId, upgraded: false }] }
  }
  const players = state.players.map((candidate) => {
    if (candidate.id !== playerId) return candidate
    let owner = candidate
    if (relicId === 'old_coin') {
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
  return {
    ...state,
    rng,
    relicDeck,
    potionDeck: tinyPotion ? state.potionDeck.slice(1) : state.potionDeck,
    players,
    rewards: tinyPotion ? state.rewards.map((offer) => offer.playerId === playerId
      ? offer.potion === false
        ? { ...offer, potion: tinyPotion }
        : { ...offer, potionQueue: [...(offer.potionQueue ?? []), tinyPotion] }
      : offer) : state.rewards,
  }
}

/** Only the owner sees cards exposed by a pending one-shot relic. */
export function pendingRelicPreview(state: RunState, playerId: string): PendingRelicPreview | null {
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
    const remove = new Set(cardUids)
    owner = { ...owner, deck: owner.deck.filter((card) => !remove.has(card.uid)) }
  } else if (id === 'pandoras_box') {
    const remove = new Set(cardUids)
    owner = { ...owner, deck: owner.deck.filter((card) => !remove.has(card.uid)) }
    for (let index = 0; index < expectedCards; index++) {
      const draw = drawTransformReward(owner)
      owner = draw.player
      if (draw.defId) {
        const egg = eggUpgrade(owner, draw.defId)
        owner = { ...egg.player, deck: [...egg.player.deck, {
          uid: `c${nextRunUid([{ ...egg.player, deck: egg.player.deck } as Player])}`,
          defId: draw.defId,
          upgraded: egg.upgraded,
        }] }
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
    const added: CardInstance[] = []
    for (const defId of gained) {
      const egg = eggUpgrade(owner, defId)
      owner = egg.player
      added.push({ uid: `c${uid++}`, defId, upgraded: egg.upgraded })
    }
    owner = {
      ...owner,
      deck: [...owner.deck, ...added],
      cardRewards: rare ? owner.cardRewards : [...commonSource, ...commonBottom],
      rareRewards: [...rareSource, ...rareBottom],
    }
  }
  return { ...state, players: state.players.map((candidate) => candidate.id === playerId ? owner : candidate) }
}

export function resolveRelicReward(state: RunState, playerId: string, gain: boolean): RunState {
  if (state.phase !== 'reward' || hasPendingRelicAcquisition(state)) return state
  const offer = state.rewards.find((candidate) => candidate.playerId === playerId)
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (!offer || offer.relic === false || !player) return state
  if (offer.relic === null && gain) return state
  const relic = typeof offer.relic === 'string' ? offer.relic : null
  const rewards = state.rewards.map((candidate) => candidate === offer ? { ...candidate, relic: false as const } : candidate)
  let next: RunState = {
    ...state,
    relicDeck: relic && !gain ? [...state.relicDeck, relic] : state.relicDeck,
    players: state.players,
    rewards,
  }
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
    const drawn = player.cardRewards.slice(0, 3)
    const common = drawn.filter((defId) => defId !== GOLDEN_TICKET)
    const rare = player.rareRewards.slice(0, drawn.length - common.length)
    const expected = [...common, ...rare]
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
  const mint = (defId: string, upgraded: boolean): CardInstance => ({ uid: `c${++nextUid}`, defId, upgraded })
  const players = state.players.map((player) => {
    const offer = state.rewards.find((candidate) => candidate.playerId === player.id)
    if (!offer?.cardReward) return player
    const choice = decisions[player.id] ?? null
    if (offer.choices === null) return player
    const shown = offer.choices
    const selected = choice === null ? null : shown[choice]!
    const rareIndices = new Set(offer.rareChoiceIndices ?? [])
    const selectedRare = choice !== null && rareIndices.has(choice)
    const drawn = player.cardRewards.slice(0, 3)
    let commonIndex = -1
    const commonBottom = drawn.filter((defId) => {
      if (defId === GOLDEN_TICKET) return true
      commonIndex += 1
      return selectedRare || commonIndex !== choice
    })
    const rareDrawn = player.rareRewards.slice(0, rareIndices.size)
    const selectedRareIndex = selectedRare && choice !== null
      ? choice - (shown.length - rareDrawn.length)
      : -1
    const rareBottom = rareDrawn.filter((_defId, index) => index !== selectedRareIndex)
    let upgraded = offer.upgraded
    let relics = player.relics
    if (selected !== null && !upgraded) {
      const eggId = CARDS[selected]?.type === 'attack' ? 'molten_egg'
        : CARDS[selected]?.type === 'skill' ? 'toxic_egg' : null
      const egg = eggId ? relics.find((relic) => relic.defId === eggId && (relic.uses ?? 0) > 0) : undefined
      if (egg) {
        upgraded = true
        relics = egg.uses === 1
          ? relics.filter((relic) => relic !== egg)
          : relics.map((relic) => relic === egg ? { ...relic, uses: relic.uses! - 1 } : relic)
      }
    }
    return {
      ...player,
      relics,
      deck: selected === null ? player.deck : [...player.deck, mint(selected, upgraded)],
      cardRewards: [...player.cardRewards.slice(drawn.length), ...commonBottom],
      rareRewards: [...player.rareRewards.slice(rareDrawn.length), ...rareBottom],
    }
  })

  return {
    ...state,
    phase: state.rewardDestination,
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

/** Leaves a non-combat room and returns the party to the map. */
export function leaveRoom(state: RunState): RunState {
  if (state.phase !== 'room') return state
  return { ...state, phase: 'map' }
}

export type CampfireChoice = 'rest' | 'smith' | 'leave'
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

  const players = state.players.map((player) => {
    const decision = choices[player.id]
    if (!decision || player.dead) return player
    if (decision.choice === 'leave') return player

    if (decision.choice === 'rest') {
      if (hasRelic(player, 'coffee_dripper')) return player
      const remove = hasRelic(player, 'peace_pipe') && decision.removeCardUid
        ? player.deck.find((card) => card.uid === decision.removeCardUid)
        : undefined
      const healed = Math.min(player.maxHp, player.hp + 3 + (hasRelic(player, 'regal_pillow') ? 3 : 0))
      return {
        ...player,
        hp: hasRelic(player, 'mark_of_pain') ? Math.min(6, healed) : healed,
        deck: remove && remove.defId !== 'ascenders_bane'
          ? player.deck.filter((card) => card.uid !== remove.uid)
          : player.deck,
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

  return { ...state, phase: 'map', players, log: [...state.log, 'The party rests at a campfire.'] }
}

/**
 * Starts the next Act: a fresh map, and every player healed to full (p.4).
 * Ascension 6 changes the heal to 4 HP rather than full.
 */
export function advanceAct(state: RunState): RunState {
  if (state.phase !== 'victory' || hasPendingRelicAcquisition(state)) return state
  if (!isActComplete(state.map)) return state
  if (state.act >= 4) return state

  const rng = { ...state.rng }
  const act = state.act + 1
  const players = state.players.map((player) => ({
    ...player,
    hp: Math.min(
      hasRelic(player, 'mark_of_pain') ? 6 : player.maxHp,
      state.ascension >= 6 ? player.hp + 4 : player.maxHp,
    ),
    // Skipped common/uncommon rewards are shuffled back between Acts; rares
    // deliberately keep their order (setup p.4).
    cardRewards: shuffle(rng, [...player.cardRewards]),
  }))

  return {
    ...state,
    rng,
    act,
    phase: 'map',
    map: generateMap(rng, act, ACT_SHAPE, state.ascension),
    enemyDecks: createEnemyDecks(rng, act, state.ascension),
    players,
    combat: null,
    pendingBossDefId: null,
    log: [...state.log, `Act ${act} begins.`],
  }
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
