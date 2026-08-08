// A run: the campaign that strings map rooms and combats together.
//
// The combat engine knows nothing about the map, and the map knows nothing
// about combat. This module owns the seam — it builds a CombatState when the
// party enters a fighting room, and folds the result back into the run.
import { STARTER_DECKS } from './cards.ts'
import { createCombat, startPlayerTurn } from './combat.ts'
import type { CombatState } from './combat.ts'
import { enemyDef, startingHp } from './enemies.ts'
import { generateMap, currentRoom, moveTo, isActComplete } from './map.ts'
import type { Room, SpireMap } from './map.ts'
import { STARTING_RELIC } from './relics.ts'
import { createRng, shuffle, nextInt } from './rng.ts'
import type { RngState } from './rng.ts'
import type { CardInstance, CharacterId, Enemy, Player } from './types.ts'

export type RunPhase =
  /** Choosing where to go next. */
  | 'map'
  | 'combat'
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
  players: Player[]
  combat: CombatState | null
  log: string[]
}

/** Max HP per character. Not printed in the rulebook — these come from the boards. */
export const MAX_HP: Record<CharacterId, number> = {
  ironclad: 10,
  silent: 9,
  defect: 9,
  watcher: 9,
}

/** Enemies available per act, in rough difficulty order. */
const ACT_ENCOUNTERS: Record<number, string[]> = {
  1: ['red_louse', 'jaw_worm', 'cultist', 'blue_slaver', 'spike_slime'],
  2: ['cultist', 'blue_slaver', 'jaw_worm'],
  3: ['jaw_worm', 'cultist', 'spike_slime'],
}

let instanceCounter = 0
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
): Player {
  const deck = STARTER_DECKS[character].map(makeInstance)
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
    vulnerable: 0,
    weak: 0,
    shivs: 0,
    miracles: 0,
    stance: 'neutral',
    orbs: [null, null, null],
    relics: [{ defId: STARTING_RELIC[character] ?? 'burning_blood', spent: false }],
    potions: [],
    cardRewards: [],
    rareRewards: [],
    dead: false,
  }
}

export type PartyMember = { id: string; name: string; character: CharacterId }

export function createRun(seed: number, party: PartyMember[], ascension = 0): RunState {
  instanceCounter = 0
  const rng = createRng(seed)
  const players = party.map((member, index) =>
    createPlayer(rng, member.id, member.name, member.character, index),
  )
  // Solo starts with 2 extra gold and the Loaded Die (p.4, step 12).
  const solo = players.length === 1 ? players[0] : undefined
  if (solo) {
    solo.gold += 2
    solo.relics = [...solo.relics, { defId: 'loaded_die', spent: false }]
  }

  return {
    rng,
    seed,
    ascension,
    act: 1,
    phase: 'map',
    map: generateMap(rng, 1),
    players,
    combat: null,
    log: ['The party enters the Spire.'],
  }
}

const ELITES = ['gremlin_nob', 'lagavulin']

function spawn(defId: string, uid: string, row: number, hp: number, isBoss: boolean): Enemy {
  return {
    uid,
    defId,
    row,
    isBoss,
    hp,
    maxHp: hp,
    block: 0,
    strength: 0,
    vulnerable: 0,
    weak: 0,
    poison: 0,
    actionIndex: 0,
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
  act: number,
  players: Player[],
  kind: 'encounter' | 'elite' | 'boss',
): Enemy[] {
  const count = players.length

  if (kind === 'boss') {
    // There is no boss deck yet. Rather than pretend, the toughest elite stands
    // in, marked as a boss so it acts last and reads as one on the board.
    const defId = ELITES[ELITES.length - 1] ?? 'lagavulin'
    const hp = startingHp(enemyDef(defId), count)
    const row = players[players.length - 1]?.row ?? 0
    return [spawn(defId, 'boss', row, hp, true)]
  }

  if (kind === 'elite') {
    const defId = ELITES[nextInt(rng, ELITES.length)] ?? 'gremlin_nob'
    const hp = startingHp(enemyDef(defId), count)
    // Elites are placed in the bottom row (p.11).
    const row = players[0]?.row ?? 0
    return [spawn(defId, 'elite', row, hp, false)]
  }

  const pool = ACT_ENCOUNTERS[act] ?? ACT_ENCOUNTERS[1] ?? []
  return players.map((player, index) => {
    const defId = pool[nextInt(rng, pool.length)] ?? 'red_louse'
    const hp = startingHp(enemyDef(defId), count)
    return spawn(defId, `e${index}`, player.row, hp, false)
  })
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
    vulnerable: 0,
    weak: 0,
    shivs: 0,
    miracles: 0,
    stance: 'neutral',
    orbs: [null, null, null],
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
  const next: RunState = { ...state, map, rng, log: [...state.log, `The party enters a ${room.kind}.`] }

  if (room.kind === 'encounter' || room.kind === 'elite' || room.kind === 'boss') {
    const players = state.players.map((player) => readyForCombat(rng, player))
    const enemies = buildEncounter(rng, state.act, players, room.kind)
    // Start the first Player Turn immediately: entering a room with no cards in
    // hand and nothing to do is not a state the game ever sits in.
    const combat = startPlayerTurn(createCombat(rng, players, enemies))
    return { ...next, phase: 'combat', players, combat }
  }

  return { ...next, phase: 'room' }
}

/**
 * Folds a finished combat back into the run: survivors keep their HP and gold,
 * and the party either climbs on or the run ends.
 */
export function resolveCombat(state: RunState): RunState {
  const combat = state.combat
  if (!combat || (combat.phase !== 'won' && combat.phase !== 'lost')) return state

  if (combat.phase === 'lost') {
    return {
      ...state,
      phase: 'defeat',
      players: combat.players,
      combat: null,
      log: [...state.log, 'The party has fallen.'],
    }
  }

  // Carry HP and gold forward; everything else resets between combats (p.13).
  const players = state.players.map((player) => {
    const after = combat.players.find((candidate) => candidate.id === player.id)
    return after ? { ...player, hp: after.hp, gold: after.gold + 1, dead: after.dead } : player
  })

  const room = currentRoom(state.map)
  const wasBoss = room?.kind === 'boss'
  return {
    ...state,
    phase: wasBoss ? 'victory' : 'map',
    players,
    combat: null,
    log: [...state.log, wasBoss ? 'The Act is won.' : 'The enemies fall.'],
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
  }))

  return {
    ...state,
    rng,
    act,
    phase: 'map',
    map: generateMap(rng, act),
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
