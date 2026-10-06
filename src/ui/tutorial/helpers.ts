import { cardDef } from '../../game/cards.ts'
import { potionDef } from '../../game/relics.ts'
import type { CardRewardOffer, RunState } from '../../game/run.ts'
import type { Spot, TutorialPlan } from './types.ts'

// Building blocks for the hero scripts: where things are on screen, what stage
// the run is at, and whether the task the coach asked for has been done.

export const spot = (css: string, text?: string): Spot => ({ css, text })
const every = (css: string): Spot => ({ css, all: true })
const quoted = (value: string) => `"${value.replaceAll('"', '\\"')}"`

export const cardName = (defId: string) => cardDef(defId).name
export const potionName = (id: string) => potionDef(id).name

/** Cards show their upgraded name ("Bash+") once upgraded, so match either. */
const titled = (scope: string, defId: string) => {
  const name = cardName(defId)
  return `${scope} [title=${quoted(name)}], ${scope} [title=${quoted(`${name}+`)}]`
}

/** Screen spots the scripts point at. */
export const at = {
  hp: spot('.pip--hp'),
  gold: spot('.run-status .pip[title="Gold"]'),
  deck: spot('.deck-peek__open'),
  relics: spot('.run-status .relic-bar'),
  potions: spot('.outside-potions'),
  neowCard: spot('.neow-face'),
  neowButton: (text: string) => spot('.neow-action button', text),
  neowOption: (text: string) => spot('.neow-options button', text),
  /** A card on any full-screen card choice: rewards, Neow, pickers. */
  offeredCard: (defId: string) => spot(`${titled('.reward-screen__cards', defId)}, ${titled('.card-picker__grid', defId)}`),
  pickerConfirm: spot('.card-picker .card-picker__confirm'),
  loot: (text: string) => spot('.reward-screen--loot .loot-choice', text),
  room: (roomId: string) => spot(`[data-room=${quoted(roomId)}]`),
  legend: spot('.map__legend'),
  boss: spot('.room--boss'),
  hand: every('.hand .card'),
  handCard: (defId: string) => spot(titled('.hand', defId)),
  shopCard: (defId: string) => spot(titled('.merchant-cards', defId)),
  enemy: (uid: string) => spot(`[data-enemy-id=${quoted(uid)}]`),
  enemies: spot('[data-enemy-id]'),
  intent: (uid: string) => spot(`[data-enemy-id=${quoted(uid)}] .enemy__intent`),
  energy: spot('.pip--energy'),
  die: spot('.combat__die'),
  piles: spot('.hand-area__stats'),
  endTurn: spot('.combat__end-turn'),
  hero: spot('.seat--viewer'),
  combatPotion: (id: string) => spot(`[aria-label^=${quoted(`Use ${potionName(id)}`)}]`),
  combatActions: spot('.combat__actions'),
  eventOption: (id: string) => spot(`[data-event-option=${quoted(id)}]`),
  event: spot('.event-panel'),
  merchantCards: spot('.merchant-cards'),
  merchantRelics: spot('.merchant-shelf--relics'),
  merchantPotions: spot('.merchant-shelf--potions'),
  merchantRemoval: spot('.merchant-removal__service'),
  merchantEnter: spot('.merchant-arrival__merchant'),
  merchantLeave: spot('.merchant-stage .room-proceed'),
  merchantProceed: spot('.merchant-arrival .room-proceed'),
  treasureOpen: spot('.treasure-open'),
  treasureRelic: spot('.treasure-offer__relic'),
  treasureTake: spot('.treasure-actions button', 'Take relic'),
  campfire: spot('.campfire__choices'),
}

// Where the run is.

export const neowProgress = (run: RunState) => run.neow?.players.p1
export const inNeow = (run: RunState) => run.phase === 'neow' && Boolean(neowProgress(run))
export const onMapAt = (roomId: string | null) => (run: RunState) => run.phase === 'map' && run.map.position === roomId
export const inRoom = (roomId: string) => (run: RunState) => run.map.position === roomId
/** A player turn in that room's fight, including aiming the extra copy of a card (Rapid Fire, Necronomicon). */
export const inFight = (roomId: string, turn?: number) => (run: RunState) =>
  run.phase === 'combat' && run.map.position === roomId && (run.combat?.phase === 'player' || run.combat?.phase === 'copy') &&
  (turn === undefined || run.combat.turn === turn)
export const beforeFirstTurn = (roomId: string) => (run: RunState) =>
  run.phase === 'combat' && run.map.position === roomId && (run.combat?.turn === 0 || run.combat?.phase === 'start')
export const inReward = (roomId: string) => (run: RunState) => run.phase === 'reward' && run.map.position === roomId
export const inRoomScreen = (roomId: string, kind: string) => (run: RunState) =>
  run.phase === 'room' && run.map.position === roomId && run.roomState?.kind === kind
export const atCampfire = (roomId: string) => (run: RunState) =>
  run.phase === 'room' && run.map.position === roomId && !run.roomState

/**
 * True while the run is still the plan's: Neow's card and every card the coach
 * asked for are in the deck, and every room entered is on the route, in order.
 * Only a player who hid the tips can leave it.
 */
export function onScript(plan: TutorialPlan, run: RunState): boolean {
  const visited = Object.values(run.map.rooms).filter((room) => room.visited).length
  if (!plan.route.slice(0, visited).every((id) => run.map.rooms[id]?.visited)) return false
  if (run.phase === 'neow') return true
  const wanted = [plan.neow.pick, ...plan.route.slice(0, visited).flatMap((id) => {
    const room = plan.rooms[id]
    // A fight's pick joins the deck only once its reward is settled.
    if (room?.kind === 'merchant') return (room.buy ?? []).filter((item) => item.section === 'card' && id !== run.map.position)
      .map((item) => item.id)
    // An event's card joins the deck once the event has resolved back to the map.
    if (room?.kind === 'event') return room.pick && (id !== run.map.position || run.phase === 'map') ? [room.pick] : []
    return room?.kind === 'fight' && room.pick && (id !== run.map.position || run.phase !== 'combat' && run.phase !== 'reward')
      ? [room.pick] : []
  })]
  const deck = run.players[0]!.deck.map((card) => card.defId)
  return wanted.every((defId) => wanted.filter((id) => id === defId).length <= deck.filter((id) => id === defId).length)
}

// Whether a task is done.

const hand = (run: RunState) => run.combat?.players[0]?.hand ?? []
export const handCount = (run: RunState, defId: string) => hand(run).filter((card) => card.defId === defId).length
/**
 * Done once the hand holds at most `left` copies of the card and any extra
 * copy it spawned (Rapid Fire, Necronomicon) has been aimed, or the fight is over.
 */
export const playedDown = (defId: string, left = 0) => (run: RunState) =>
  !run.combat || handCount(run, defId) <= left && run.combat.phase !== 'copy'
export const turnReached = (turn: number) => (run: RunState) => !run.combat || run.combat.turn >= turn
export const movedTo = (roomId: string) => (run: RunState) => run.map.rooms[roomId]?.visited === true
export const potionGone = (id: string, left = 0) => (run: RunState) =>
  (run.combat?.players[0] ?? run.players[0])!.potions.filter((held) => held === id).length <= left

const offer = (run: RunState): CardRewardOffer | undefined => run.phase === 'reward' ? run.rewards[0] : undefined
export const goldTaken = (run: RunState) => !offer(run)?.gold
export const potionTaken = (run: RunState) => typeof offer(run)?.potion !== 'string'
export const cardRevealed = (run: RunState) => !offer(run)?.cardReward || offer(run)?.choices !== null
export const cardTaken = (run: RunState) => !offer(run)?.cardReward
export const deckHas = (defId: string, count = 1) => (run: RunState) =>
  run.players[0]!.deck.filter((card) => card.defId === defId).length >= count
export const roomLeft = (run: RunState) => run.phase !== 'room'
