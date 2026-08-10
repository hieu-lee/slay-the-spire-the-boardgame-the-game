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
import { generateMap, currentRoom, moveTo, isActComplete } from './map.ts'
import type { Room, RoomKind, SpireMap } from './map.ts'
import { STARTING_RELIC } from './relics.ts'
import { createRng, shuffle } from './rng.ts'
import type { RngState } from './rng.ts'
import type { CardInstance, CharacterId, Enemy, Player } from './types.ts'

export type RunPhase =
  /** Choosing where to go next. */
  | 'map'
  | 'combat'
  | 'reward'
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
  rewards: CardRewardOffer[]
  rewardDestination: 'map' | 'victory' | null
  log: string[]
}

export type CardRewardOffer = {
  playerId: string
  choices: string[] | null
  upgraded: boolean
}

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
  summons?: string[]
  randomSummons?: { group: string; count: number; soloCount?: number }
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
    { defId: 'cultist', goldReward: 1, cardReward: 'normal', summons: ['spike_slime'] },
    { defId: 'looter', goldReward: 0, cardReward: 'normal', maxAscension: 6 },
    { defId: 'blue_slaver', goldReward: 2, cardReward: 'normal' },
    { defId: 'red_slaver', goldReward: 1, cardReward: 'normal' },
    { defId: 'small_slime', goldReward: 1, cardReward: 'normal', summons: ['acid_slime', 'spike_slime'] },
    { defId: 'large_slime', goldReward: 1, cardReward: 'normal', maxAscension: 6 },
    {
      defId: 'mad_gremlin', goldReward: 2, cardReward: 'normal',
      randomSummons: { group: 'gremlin', count: 3, soloCount: 2 },
    },
    {
      defId: 'sneaky_gremlin', goldReward: 1, cardReward: 'normal',
      randomSummons: { group: 'gremlin', count: 3, soloCount: 2 },
    },
    { defId: 'fungi_beast', goldReward: 1, cardReward: 'normal', summons: ['fungi_beast'] },
    { defId: 'large_slime', goldReward: 1, cardReward: 'normal', minAscension: 7 },
    { defId: 'jaw_worm_a7', goldReward: 1, cardReward: 'normal', summons: ['spike_slime'], minAscension: 7 },
    { defId: 'looter', goldReward: 0, cardReward: 'normal', summons: ['acid_slime'], minAscension: 7 },
  ],
  2: [{ defId: 'cultist', goldReward: 2, cardReward: 'normal', summons: ['cultist', 'cultist'] }],
  3: [{ defId: 'jaw_worm', goldReward: 2, cardReward: 'normal', summons: ['jaw_worm', 'jaw_worm'] }],
}

/** The complete four-card fixed-opening deck. */
const FIRST_ENCOUNTERS: EncounterCard[] = [
  { defId: 'cultist', goldReward: 1, cardReward: 'normal' },
  { defId: 'jaw_worm_first', goldReward: 1, cardReward: 'normal' },
  { defId: 'red_louse_first', goldReward: 1, cardReward: null, summons: ['green_louse'] },
  { defId: 'small_slime', goldReward: 0, cardReward: 'normal', summons: ['acid_slime'] },
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
  return Object.values(CARDS).flatMap((def) => {
    if (def.owner !== character) return []
    if (rare) return def.rarity === 'rare' ? [def.id] : []
    if (def.rarity === 'common') return [def.id, def.id]
    return def.rarity === 'uncommon' ? [def.id] : []
  })
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
    attacksPlayedThisTurn: 0,
    shivs: 0,
    shivDamageBonus: 0,
    cardBlockBonus: 0,
    hitPoison: 0,
    miracles: 0,
    stance: 'neutral',
    orbs: [null, null, null],
    orbEvokeBonus: 0,
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

  return {
    rng,
    seed,
    ascension,
    act: 1,
    phase: 'map',
    map: generateMap(rng, 1),
    enemyDecks: createEnemyDecks(rng, 1, ascension),
    players,
    combat: null,
    rewards: [],
    rewardDestination: null,
    log: ['The party enters the Spire.'],
  }
}

const ELITES: Record<number, EncounterCard[]> = {
  1: [
    { defId: 'gremlin_nob', goldReward: 2, cardReward: 'normal' },
    { defId: 'lagavulin', goldReward: 2, cardReward: 'normal' },
    { defId: 'sentries', goldReward: 2, cardReward: 'normal' },
  ],
  2: [],
  3: [],
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
): Enemy {
  return {
    uid,
    defId,
    row,
    isBoss,
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
    actionIndex: 0,
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
): { enemies: Enemy[]; summonSupply: SummonSupply } {
  const count = players.length
  const summonSupply = createSummonSupply(rng)

  if (kind === 'boss') {
    // There is no boss deck yet. Rather than pretend, the toughest elite stands
    // in, marked as a boss so it acts last and reads as one on the board.
    const defId = 'lagavulin'
    const hp = startingHp(enemyDef(defId, ascension), count)
    const row = players[players.length - 1]?.row ?? 0
    return { enemies: [spawn(defId, 'boss', row, hp, true, 0, null, ascension)], summonSupply }
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
    const enemies = [spawn(
      card.defId, 'elite', row, hp, false, card.goldReward, card.cardReward,
      ascension,
    )]
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
    shivs: 0,
    miracles: 0,
    stance: 'neutral',
    orbs: [null, null, null],
    orbEvokeBonus: 0,
  }
}

/**
 * Moves the party into a room and starts whatever that room is. Returns the
 * SAME state reference when the move is illegal, matching the combat engine.
 */
export function enterRoom(state: RunState, roomId: string): RunState {
  if (state.phase !== 'map') return state
  const map = moveTo(state.map, roomId)
  if (map === state.map) return state

  const room = currentRoom(map)
  if (!room) return state

  const rng = { ...state.rng }
  const next: RunState = {
    ...state,
    map,
    rng,
    enemyDecks: state.enemyDecks?.act === state.act
      ? structuredClone(state.enemyDecks)
      : createEnemyDecks(rng, state.act, state.ascension),
    log: [...state.log, `The party enters ${enteringRoom(room.kind)}.`],
  }

  if (room.kind === 'encounter' || room.kind === 'elite' || room.kind === 'boss') {
    const players = state.players.map((player) => readyForCombat(rng, player))
    const first = state.act === 1 && state.map.position === null && room.id === state.map.rows[0]?.[0]
    const { enemies, summonSupply } = buildEncounter(
      rng, next.enemyDecks, state.act, players, room.kind, first, state.ascension,
    )
    // Start the first Player Turn immediately: entering a room with no cards in
    // hand and nothing to do is not a state the game ever sits in.
    const combat = startPlayerTurnWithChoices(createCombat(rng, players, enemies, summonSupply))
    return { ...next, phase: 'combat', players, combat }
  }

  return { ...next, phase: 'room' }
}

/**
 * Folds a finished combat back into the run: survivors keep their HP and gold,
 * and the party either climbs on or the run ends.
 */
/** How many combat lines to carry into the run log when a fight ends. */
const COMBAT_EPITAPH = 6

export function resolveCombat(state: RunState): RunState {
  const combat = state.combat
  if (!combat || (combat.phase !== 'won' && combat.phase !== 'lost')) return state

  // The combat log dies with the combat, so the last of it comes along. A
  // defeat that cannot say what killed you is the one moment a player most
  // wants to read the round back.
  // Turn dividers mean nothing outside a combat, and the run log only shows a
  // handful of lines — an unfiltered tail evicted everything about the run.
  const epitaph = combat.log.filter((line) => !/^Turn \d+ begins/.test(line)).slice(-COMBAT_EPITAPH)

  if (combat.phase === 'lost') {
    return {
      ...state,
      phase: 'defeat',
      players: combat.players,
      combat: null,
      rewards: [],
      rewardDestination: null,
      log: [...state.log, ...epitaph, 'The party has fallen.'],
    }
  }

  const room = currentRoom(state.map)
  const wasBoss = room?.kind === 'boss'
  const sharedReward = room?.kind === 'elite' || wasBoss ? combat.enemies[0] : undefined

  // Carry HP forward and read each printed enemy reward. Encounter rewards come
  // from the enemy in your row; Elite and Boss rewards are shared (p.13).
  const players = state.players.map((player) => {
    const after = combat.players.find((candidate) => candidate.id === player.id)
    if (!after) return player
    const source = sharedReward ?? combat.enemies.find((enemy) => enemy.row === after.row)
    const gold = source?.goldReward ?? 0
    return {
      ...player,
      hp: after.hp,
      gold: after.gold + gold,
      row: after.row,
      potions: after.potions,
      dead: after.dead,
    }
  })

  const rewards = players.flatMap((player) => {
    if (player.dead) return []
    const source = sharedReward ?? combat.enemies.find((enemy) => enemy.row === player.row)
    if (!source?.cardReward || player.cardRewards.length < 3) return []
    return [{ playerId: player.id, choices: null, upgraded: source.cardReward === 'upgraded' }]
  })
  const destination = wasBoss ? 'victory' : 'map'
  return {
    ...state,
    phase: rewards.length > 0 ? 'reward' : destination,
    players,
    combat: null,
    rewards,
    rewardDestination: rewards.length > 0 ? destination : null,
    // A win explains itself; only a defeat needs the round read back.
    log: [...state.log, wasBoss ? 'The Act is won.' : 'The enemies fall.'],
  }
}

/** Reveal one player's top three; rewards may instead be skipped unseen (p.8). */
export function revealCardReward(state: RunState, playerId: string): RunState {
  if (state.phase !== 'reward') return state
  const offer = state.rewards.find((candidate) => candidate.playerId === playerId)
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (!offer || offer.choices !== null || !player) return state
  return {
    ...state,
    rewards: state.rewards.map((candidate) => candidate === offer
      ? { ...candidate, choices: player.cardRewards.slice(0, 3) }
      : candidate),
  }
}

/** Resolve every living player's revealed choice or unseen skip together (p.8). */
export function resolveCardRewards(
  state: RunState,
  decisions: Readonly<Record<string, number | null>>,
): RunState {
  if (state.phase !== 'reward' || !state.rewardDestination) return state
  for (const offer of state.rewards) {
    const player = state.players.find((candidate) => candidate.id === offer.playerId)
    const shown = offer.choices ?? player?.cardRewards.slice(0, 3)
    if (!player || !shown || !shown.every((defId, index) => player.cardRewards[index] === defId)) return state
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
    if (!offer) return player
    const choice = decisions[player.id] ?? null
    if (offer.choices === null) return player
    const shown = offer.choices
    const selected = choice === null ? null : shown[choice]!
    const unchosen = shown.filter((_defId, index) => index !== choice)
    return {
      ...player,
      deck: selected === null ? player.deck : [...player.deck, mint(selected, offer.upgraded)],
      cardRewards: [...player.cardRewards.slice(shown.length), ...unchosen],
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

/** Leaves a non-combat room and returns the party to the map. */
export function leaveRoom(state: RunState): RunState {
  if (state.phase !== 'room') return state
  return { ...state, phase: 'map' }
}

export type CampfireChoice = 'rest' | 'smith'

/**
 * A campfire: each player chooses Rest (heal 3) or Smith (upgrade a card),
 * independently (p.9). Choices arrive per player so one message carries the
 * whole room, the same way a card play carries its choices.
 *
 * Returns the SAME state reference if this is not a campfire.
 */
export function resolveCampfire(
  state: RunState,
  choices: Record<string, { choice: CampfireChoice; cardUid?: string }>,
): RunState {
  if (state.phase !== 'room') return state
  if (currentRoom(state.map)?.kind !== 'campfire') return state

  const players = state.players.map((player) => {
    const decision = choices[player.id]
    if (!decision || player.dead) return player

    if (decision.choice === 'rest') {
      return { ...player, hp: Math.min(player.maxHp, player.hp + 3) }
    }

    // Smith upgrades one card in the deck. An already-upgraded card cannot be
    // upgraded again, so naming one is simply ignored.
    const target = player.deck.find(
      (card) => card.uid === decision.cardUid && !card.upgraded,
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
  if (state.phase !== 'victory') return state
  if (!isActComplete(state.map)) return state

  const rng = { ...state.rng }
  const act = state.act + 1
  const players = state.players.map((player) => ({
    ...player,
    hp: state.ascension >= 6 ? Math.min(player.maxHp, player.hp + 4) : player.maxHp,
    // Skipped common/uncommon rewards are shuffled back between Acts; rares
    // deliberately keep their order (setup p.4).
    cardRewards: shuffle(rng, [...player.cardRewards]),
  }))

  return {
    ...state,
    rng,
    act,
    phase: 'map',
    map: generateMap(rng, act),
    enemyDecks: createEnemyDecks(rng, act, state.ascension),
    players,
    combat: null,
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
