// The shapes the combat engine passes around: the state itself, the choices a
// player still owes it, and what it hands back to the UI.
//
// Types only, plus the id helpers for the `<ability>@<target>` strings the
// end-of-turn order is expressed in — so every other module can name a shape
// without pulling in behaviour.
import type { Effect, TargetScope } from '../cards.ts'
import type { EnemyAction, SummonSupply } from '../enemies.ts'
import type { RngState } from '../rng.ts'
import type { Trigger } from '../triggers.ts'
import type { CardInstance, CardType, Enemy, OrbType, Player } from '../types.ts'

export type CombatPhase =
  /** Reset, draw, and roll are done; ordered Start-of-Turn abilities remain. */
  | 'start'
  | 'player'
  | 'copy'
  | 'discard'
  | 'enemy'
  /** The Enemy Turn is done and the next Start of Turn has not been taken. */
  | 'roundEnd'
  | 'won'
  | 'lost'

export type CombatState = {
  /** Stable room-scoped identity used to reject delayed actions from an earlier fight. */
  combatId: string
  /** Optional p.23 rule; it changes deaths only while a Boss is in this fight. */
  lastStand: boolean
  rng: RngState
  turn: number
  /** One shared die roll drives every die effect for the whole round (p.12). */
  die: number
  phase: CombatPhase
  players: Player[]
  enemies: Enemy[]
  summonSupply: SummonSupply
  pendingSummons: {
    sourceUid: string
    row: number
    defIds: string[]
    turn: number
    timing?: 'startOfTurn' | 'endOfTurn'
    direct?: boolean
    isBoss?: boolean
    strength?: number
    strengthDefId?: string
    strengthPerPower?: boolean
  }[]
  /** Face-down physical potion deck. Never included in a client snapshot. */
  potionDeck: string[]
  potionLimit: 2 | 3
  discardedThisTurn: string[]
  stanceChangedThisTurn: string[]
  /** Power instance ids already spent by a printed once-per-turn ability or trigger. */
  powerTriggersUsedThisTurn: string[]
  /** Facing is resolved after ordinary Start-of-Turn abilities. */
  startTurnStage?: 'effects' | 'facing'
  /** Triggered abilities waiting for earlier card text or a row choice. */
  pendingTriggers: PendingTrigger[]
  nextTriggerId: number
  /** End-of-turn abilities waiting for a mandatory nested trigger. */
  endTurnProgress?: { order: EndTurnOrder; interactive?: boolean; rowTiebreakFor?: string }
  /** Unresolved Start-of-Turn work, including Mayhem's private forced play. */
  startTurnProgress?: {
    choices: StartTurnChoice[]
    /** Private Scry abilities that must finish after Reset and before Draw. */
    beforeDraw?: {
      drewFrom: number
      sources: { playerId: string; sourceId: string }[]
      ordered: boolean
    }
    /** The Draw step paused on a trigger before the shared die was rolled. */
    rollPending?: { drewFrom: number }
    /** Tools of the Trade drew; only its owner may choose the card to discard. */
    discard?: { playerId: string; sourceId: string; pendingTriggers: PendingTrigger[] }
    forcedCard?: {
      playerId: string
      cardUid: string | null
      sourceCardId: string
      sourceLabel?: string
      exhaustNonPower: boolean
      /** Draw reactions waiting for the forced card and its parent Havoc to finish. */
      pendingTriggers?: PendingTrigger[]
      /** Havoc cards waiting for their immediately-played child to finish. */
      deferredHavocs?: DeferredHavoc[]
    }
  }
  /** Physical cards waiting to resolve after their virtual copy. */
  pendingCardCopy?: {
    playerId: string
    card: CardInstance
    energySpent: number
    resumePhase: 'start' | 'player'
    forcedExhaust: boolean
    forcedChoices: StartTurnChoice[] | null
    deferredHavocs: DeferredHavoc[]
    /** Parent-card triggers waiting for this nested copy to finish. */
    deferredTriggers?: PendingTrigger[]
    /** The sole play-twice effect applied to this card. */
    sourceNames: ('Double Tap' | 'Blasphemy' | 'Echo Form' | 'Burst' | 'Doppelganger' | 'Foreign Influence' | 'Omniscience' | 'Weave')[]
    /** Doppelganger queues only a virtual card, with no physical original to clean up. */
    virtualOnly?: boolean
    /** Additional physical Weaves discarded by the same Scry, in reveal order. */
    queuedWeaves?: CardInstance[]
    /** Next-card modifiers consumed only if this queued card is allowed to play. */
    queuedCopySources?: CopySource[]
    consumeFreeCard?: boolean
    consumeFreeAttack?: boolean
  }
  /** Distilled Chaos cards are private until their owner plays each for free. */
  pendingDistilled?: { playerId: string; cards: CardInstance[] }
  /** Golden Eye's private top-three reveal, persisted across reconnects. */
  pendingRelicScry?: { playerId: string; relicIndex: number; cards: CardInstance[] }
  /** Ordered public Attack/Skill plays used by Doppelganger this turn. */
  playedCardsThisTurn: { playerId: string; card: CardInstance; copied: boolean }[]
  /** Recent public actions for player-facing animation; reconnecting clients baseline the sequence. */
  presentationEvents: CombatPresentationEvent[]
  log: string[]
}

export type PresentationTargets = {
  seq: number
  actorId: string
  sourceId: string
  enemyIds: string[]
  playerIds: string[]
  enemyRow?: number
}

export type CombatPresentationEvent = PresentationTargets & (
  | { kind: 'card'; upgraded: boolean; copied: boolean; energy: number; mode?: number }
  | { kind: 'potion' }
  | { kind: 'shiv' }
  | { kind: 'orb'; orb: OrbType }
)

export type NewPresentationEvent = Omit<PresentationTargets, 'seq'> & (
  | { kind: 'card'; upgraded: boolean; copied: boolean; energy: number; mode?: number }
  | { kind: 'potion' }
  | { kind: 'shiv' }
  | { kind: 'orb'; orb: OrbType }
)

export type PendingTrigger = {
  id: number
  playerId: string
  sourceId: string
  /** Event-bound target, such as the enemy that received a token. */
  enemyUid?: string
}

export type CopySource = 'Double Tap' | 'Blasphemy' | 'Echo Form' | 'Burst' | 'Omniscience'

export type DeferredHavoc = {
  card: CardInstance
  exhaust: boolean
  /** Printed clauses after a Scry that paused to play Weave. */
  remainingEffects?: Effect[]
  /** A Doppelganger Havoc is virtual and never enters a pile. */
  virtualOnly?: boolean
  /** A copied Havoc waits until its immediate child finishes. */
  copySourceNames?: CopySource[]
  copyResumePhase?: 'start' | 'player'
}

export type DiscardOrders = Readonly<Record<string, readonly string[]>>

export type EndTurnOrder = readonly string[]

export type EndTurnAbility = {
  id: string
  playerId: string | null
  label: string
  targets?: { uid: string; label: string }[]
  /** The public source shown while this targeted effect is being resolved. */
  visual?:
    | { kind: 'orb'; orb: Extract<OrbType, 'lightning' | 'frost'>; slot: number }
    | { kind: 'card'; cardUid: string }
  /** A boss was selected for a row effect while multiple rows remain; choose its row anchor next. */
  rowTiebreak?: boolean
}

export type StartTurnAbility = {
  id: string
  playerId: string
  label: string
  /** A recurring single-enemy effect still needs its owner to choose. */
  targets?: { uid: string; label: string }[]
  /** A supporting relic may give its effect to any living player. */
  players?: { id: string; label: string }[]
  /** The staged direct target was killed by an earlier ordered ability. */
  enemyTargetStale?: boolean
  /** Shivs this ability cannot take from the shared supply and may throw now. */
  overflowShivs: number
  /** A staged overflow Shiv target was killed by an earlier ordered ability. */
  staleShivIndex?: number
  shivTargets?: { uid: string; label: string }[]
  /** Next full-slot Orb choice after the choices already staged for this ability. */
  evokeChoice?: EvokeChoice
  /** Living enemies after staged Evokes, for the next Lightning/Dark target. */
  evokeTargets?: { uid: string; label: string }[]
  /** Orb type for every staged Evoke application; repeated Evokes repeat the type. */
  evokeOrbs?: OrbType[]
  /** Repeated Evokes remove one Orb but collect one target per application. */
  evokeTargetIndex?: number
}

export type StartTurnChoice = {
  id: string
  enemyUid?: string
  targetPlayerId?: string
  /** One living enemy id or explicit skip per overflow Shiv. */
  shivEnemyUids: (string | null)[]
  /** Chosen Orb slot and Lightning/Dark target for each forced Evoke, in order. */
  evokeSlots?: number[]
  evokeEnemyUids?: (string | null)[]
}

export type StartTurnScryPreview = {
  id: string
  playerId: string
  label: string
  amount: number
  cards: CardInstance[]
}

export type StartTurnScryAbility = Omit<StartTurnScryPreview, 'cards'>

export type StartTurnDiscardPreview = {
  playerId: string
  sourceId: string
  label: string
  cards: CardInstance[]
}

const END_TURN_TARGET = '@'

export const endTurnChoiceId = (choice: string): string => choice.split(END_TURN_TARGET, 1)[0]!

export const endTurnChoiceTarget = (choice: string): string | undefined => choice.split(END_TURN_TARGET)[1]

export const chooseEndTurnTarget = (id: string, targetUid: string): string =>
  `${endTurnChoiceId(id)}${END_TURN_TARGET}${targetUid}`

export const defaultEndTurnOrder = (abilities: readonly EndTurnAbility[]): EndTurnOrder =>
  abilities.map((ability) => ability.targets?.[0]
    ? chooseEndTurnTarget(ability.id, ability.targets[0].uid)
    : ability.id)

export type PresentationContext = {
  enemyUid?: string | null
  enemyUids?: readonly (string | null)[]
  shivEnemyUids?: readonly (string | null)[]
  evokeEnemyUids?: readonly (string | null)[]
  playerId?: string | null
  playerIds?: readonly string[]
  switchWithPlayerId?: string | null
  enemyRow?: number | null
}

/**
 * The choices a card needs, supplied with the play rather than collected through
 * a prompt. Keeping a card play atomic means the server validates one message
 * instead of holding half-resolved state between round trips.
 */
export type PlayContext = {
  /** Enemy chosen for offensive effects. */
  enemyUid: string | null
  /** A row chosen directly instead of through an enemy anchor. */
  enemyRow?: number | null
  /** Player chosen for supportive effects that may target an ally. */
  playerId: string | null
  /** Energy chosen for an X-cost card. Must meet `CardDef.minimumX`. */
  energySpent?: number
  /** One enemy per independently targeted printed token. Duplicates are legal. */
  enemyUids?: string[]
  /** One player per independently targeted printed Block icon. Duplicates are legal. */
  playerIds?: string[]
  /** Another living player whose row is optionally exchanged with the caster's. */
  switchWithPlayerId?: string | null
  /** Zero-based printed mode for a modal card face. */
  mode?: number
  /** Cards chosen to discard, for effects like Survivor. */
  discardUids?: string[]
  /** Cards chosen to exhaust from hand, for effects like True Grit. */
  exhaustUids?: string[]
  /** Cards chosen to return to the top of the draw pile. */
  topdeckUids?: string[]
  /** Card chosen to move from discard to the top of the draw pile. */
  recoverDiscardUid?: string
  /** Cards chosen to move from discard, in selection order. */
  recoverDiscardUids?: string[]
  recoverExhaustUid?: string
  /** Cards chosen from a privately revealed draw pile by Seek. */
  searchDrawUids?: string[]
  /** Spend one Miracle atomically with this card, which may take Energy above 6. */
  spendMiracle?: boolean
  /** One chosen target or explicit skip per immediate Shiv, in effect order. */
  shivEnemyUids?: (string | null)[]
  /** Of the cards a Scry revealed, the ones the player bins. */
  scryDiscardUids?: string[]
  /**
   * Which orb slot to evoke, when the player has a choice. The board game lets
   * you evoke ANY orb, unlike the video game's fixed front slot (p.16).
   */
  evokeSlots?: number[]
  /** One enemy per evoke; Frost uses null so choices stay aligned. */
  evokeEnemyUids?: (string | null)[]
  /**
   * Cards already given up by an earlier clause of the SAME card.
   *
   * Belt and braces, honestly: both consuming effects splice what they took out
   * of the hand immediately, so the membership test in `allocate` already stops
   * a second clause re-taking the same uid, and deleting this set changes no
   * outcome on any card or hostile input I could construct. It is kept for the
   * clause that resolves without removing from hand — a "reveal a card" cost,
   * say — where the hand check alone would let one card pay twice. Filled in
   * during resolution; callers never set it.
   */
  spentUids?: Set<string>
  /**
   * Set when a consuming clause could not be paid from the hand it faced.
   *
   * A card's cost is checked as each clause resolves, not before the card
   * starts, because an earlier clause can change what the hand holds.
   * Acrobatics reads "Draw 3 cards. Discard 1 card." and the card you discard
   * is very often one of the three you just drew. Filled in during resolution;
   * callers never set it.
   */
  shortfall?: boolean
  /** Internal cursor while multiple gain-Shiv clauses consume target choices. */
  shivTargetIndex?: number
  /** A queued overflow attack named an enemy killed by an earlier queued attack. */
  invalidShivTarget?: boolean
  /** Internal cursor while a card resolves its ordered evokes. */
  evokeIndex?: number
  /** Internal target cursor; one removed Orb can apply its Evoke effect repeatedly. */
  evokeTargetIndex?: number
  /** A queued evoke named an enemy killed by an earlier effect. */
  invalidEvokeTarget?: boolean
  /** A Scry named a card outside the cards it actually revealed. */
  invalidScryChoice?: boolean
  /** Discards whose reactions wait until this card finishes its printed text. */
  pendingDiscards?: { playerId: string; cards: CardInstance[] }[]
  /** Poison gains whose reactions wait until this card finishes its printed text. */
  pendingPoisonTriggers?: string[]
  /** Enemy token gains whose per-token reactions wait until this card finishes. */
  pendingEnemyTokenTriggers?: { playerId: string; enemyUid: string }[]
  /** Enemy reactions wait until all text on the current card has resolved. */
  pendingEnemyDamage?: { enemyUid: string; amount: number }[]
  pendingEnemyDeathUids?: string[]
  pendingAttackTargets?: string[]
  /** Nested reactions whose abilities wait until this card finishes. */
  pendingTriggers?: PendingTrigger[]
  /** Exhausts whose card and Power reactions wait until this card finishes its printed text. */
  pendingExhaustTriggers?: { playerId: string; card: CardInstance }[]
  /** Internal result of the immediately preceding direct draw effect. */
  drewSkill?: boolean
  /** Public source label for Orb channel animations, including triggered Powers and relics. */
  presentationSourceId?: string
  /** Cards taken by this card's variable discard clause. */
  discardedByCard?: number
  /** Cards taken by this card's automatic Exhaust clause. */
  exhaustedByCard?: number
  /** Cost of the card taken by the immediately preceding single-card Exhaust. */
  exhaustedCardCost?: number | 'X'
  /** A variable discard named a duplicate or a card outside the current hand. */
  invalidDiscardChoice?: boolean
  /** A variable exhaust exceeded its limit, repeated a card, or named a card outside the hand. */
  invalidExhaustChoice?: boolean
  /** A topdeck choice named a duplicate or a card outside the current hand. */
  invalidTopdeckChoice?: boolean
  /** A recovery choice was missing or named a card outside the discard pile. */
  invalidRecoverChoice?: boolean
  /** Seek named duplicates, the wrong count, or cards outside the draw pile. */
  invalidSearchChoice?: boolean
  /** Whether the card being played was kept by Retain last turn. */
  sourceRetainedLastTurn?: boolean
  /** Printed type of the card currently resolving, for Footwork. */
  sourceCardType?: CardType
  /** Definition id of the card currently resolving, for Apotheosis. */
  sourceCardId?: string
  /** Instance id of the physical card currently resolving. */
  sourceCardUid?: string
  /** Face of the physical card currently resolving. */
  sourceCardUpgraded?: boolean
  /** Weave's bonus while it is being played after a Scry discard. */
  sourceScryDamageBonus?: number
  /** Virtual play-twice copies cannot attach a physical card. */
  sourceIsCopy?: boolean
  /** The eligible card selected by a physical Doppelganger resolution. */
  doppelgangerCopy?: CardInstance
  /** Effect that queued `doppelgangerCopy`; the shared copy pipeline serves both cards. */
  queuedCopySource?: 'Doppelganger' | 'Foreign Influence' | 'Weave' | 'Omniscience'
  /** Whether the queued copy has no physical card to clean up. */
  queuedCopyVirtualOnly?: boolean
  /** Omniscience resolves its queued physical card twice. */
  queuedCopyTwice?: boolean
  /** Omniscience Exhausts the queued physical card after both plays. */
  queuedCopyForcedExhaust?: boolean
  /** Every pending resolution label for a card that has not started resolving yet. */
  queuedCopySourceNames?: ('Double Tap' | 'Blasphemy' | 'Echo Form' | 'Burst' | 'Doppelganger' | 'Foreign Influence' | 'Omniscience' | 'Weave')[]
  queuedCopySources?: CopySource[]
  consumeQueuedFreeCard?: boolean
  consumeQueuedFreeAttack?: boolean
  queuedWeaves?: CardInstance[]
  /** Cubes printed onto a Power as it enters play. */
  sourceCounter?: number
  /** This resolution attached its source card instead of discarding it. */
  sourceAttached?: boolean
  /** Power instance currently resolving its trigger, for counters and self-Exhaust. */
  sourcePowerUid?: string
  /** The source Attack was recorded early so its later Shiv attacks follow it. */
  sourceAttackCounted?: boolean
  /** HP removed by the immediately preceding hit effect. */
  lastHitDamage?: number
}

export type CardChoicePreview = {
  kind: 'discard' | 'scry' | 'topdeck' | 'search'
  cards: CardInstance[]
}

export type PotionContext = {
  enemyUid?: string | null
  targetPlayerId?: string | null
  enemyRow?: number | null
  shivEnemyUids?: string[]
  recoverDiscardUid?: string
  exhaustUids?: string[]
  /** Gambler's Brew replacement for the shared die. */
  die?: number
  /** Held Potion discarded when Entropic Brew would exceed the slot limit. */
  replacePotionId?: string
}

export type CountablePlayer = Pick<Player, 'id' | 'row' | 'orbs' | 'block' | 'strength' | 'miracles' | 'stance' |
  'attacksPlayedThisTurn' | 'exhaust' | 'clawCubesGainedThisCombat'> & {
  hand: readonly CardInstance[] | null
}

export type EvokeChoice = { index: number; options: { slot: number; orb: OrbType }[] }

export type PowerContext = { enemyUid?: string | null; enemyRow?: number | null }

export type StartTurnSource = {
  ability: Omit<StartTurnAbility, 'overflowShivs'>
  source?: TriggerSource
  enemyUid?: string
  enemyBlock?: number
  enemyAction?: EnemyAction
  facingPlayerId?: string
}

export type TriggerSource = {
  id: string
  presentationSourceId: string
  trigger: Trigger
  effects: Effect[]
  /** Named in the log, so a recurring effect is attributable. */
  name: string
  /** The card's own declared scopes, so a Power hits what it says it hits. */
  scope: TargetScope
  supportScope: TargetScope
  oncePerTurn: boolean
  powerUid?: string
}

export type PendingTriggerAbility = {
  id: number
  playerId: string
  label: string
  rows?: { row: number; label: string }[]
  targets?: { uid: string; label: string }[]
  players?: { id: string; label: string }[]
}

export type RelicContext = {
  enemyUid?: string | null
  cardUids?: string[]
  targetRelicPlayerId?: string
  targetRelicIndex?: number
  targetAbilityIndex?: number
  die?: number
  scryDiscardUids?: string[]
  shivEnemyUids?: string[]
}
