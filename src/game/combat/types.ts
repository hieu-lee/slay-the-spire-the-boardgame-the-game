// The shapes the combat engine passes around: the state itself, the choices a
// player still owes it, and what it hands back to the UI.
//
// Types only, plus the id helpers for the `<ability>@<target>` strings the
// end-of-turn order is expressed in — so every other module can name a shape
// without pulling in behaviour.
import type { Effect, TargetScope } from '../cards.ts'
import type { EnemyAction, SummonSupply } from '../enemies.ts'
import type { RuleSet } from '../meta.ts'
import type { RngState } from '../rng.ts'
import type { Trigger } from '../triggers.ts'
import type { CardInstance, CardType, Enemy, GuardianMode, OrbType, Player } from '../types.ts'

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
  ruleset?: RuleSet
  rng: RngState
  turn: number
  /** One shared die roll drives every die effect for the whole round (p.12). */
  die: number
  phase: CombatPhase
  players: Player[]
  enemies: Enemy[]
  /** Starting enemy slots, kept when enemies die or summons join the fight. */
  initialEnemyCount?: number
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
  /** Plunder row switches still owed; serialized so reconnect cannot lose the choice. */
  pendingPlunderSwitches?: { playerId: string; sourceUid: string }[]
  /** Chamber cards waiting to be played by their owner, preserved across reconnects. */
  pendingHermitChamberPlays?: { playerId: string; sourceCardId: string; cardUids: string[]; free: boolean }[]
  /** Dead or Alive rewards waiting for an explicit living-player recipient. */
  pendingHermitStrengthRewards?: { playerId: string; sourceUid: string }[]
  /** Slayer Pack: owner decisions that wait until their card finished (Nightmare+, Ritual Dagger+). */
  pendingSlayerChoices?: SlayerChoice[]
  /**
   * Slayer Pack: Ritual Dagger rewards earned by a kill, at most one per physical play
   * (a Double Tap/Echo copy shares the card). Applied once the card has left play.
   */
  slayerKillRewards?: { playerId: string; cardUid: string; reward: 'upgrade' | 'reveal' }[]
  /** Each Hermit must Load one card from their private opening hand (start-of-combat board ability). */
  pendingHermitSetupLoads?: { playerId: string }[]
  /**
   * Whether the Hermit board ability has drawn this combat; it never draws twice.
   * Absent in combats saved before it moved after the opening hand, which drew at creation.
   */
  hermitSetupQueued?: boolean
  pendingDieRelicChoices?: {
    id: number
    playerId: string
    relicDefId: string
    abilityIndex: number
    sourceLabel: string
    enemyUid: string | null
    targetPlayerId: string | null
  }[]
  /** Face-down physical potion deck. Never included in a client snapshot. */
  potionDeck: string[]
  potionLimit: 2 | 3
  discardedThisTurn: string[]
  stanceChangedThisTurn: string[]
  /** Trigger source ids already spent by a once-per-turn ability or privately staged start trigger. */
  powerTriggersUsedThisTurn: string[]
  /** Facing is resolved after ordinary Start-of-Turn abilities. */
  startTurnStage?: 'effects' | 'facing'
  /** Triggered abilities waiting for earlier card text or a row choice. */
  pendingTriggers: PendingTrigger[]
  nextTriggerId: number
  /** End-of-turn abilities waiting for a mandatory nested trigger. */
  endTurnProgress?: {
    order: EndTurnOrder
    interactive?: boolean
    loopSelections?: Record<string, number>
    loopRepeats?: string[]
  }
  /** Unresolved Start-of-Turn work, including Mayhem's private forced play. */
  startTurnProgress?: {
    choices: StartTurnChoice[]
    /** Private Scry abilities that must finish after Reset and before Draw. */
    beforeDraw?: {
      drewFrom: number
      sources: { playerId: string; sourceId: string }[]
      ordered: boolean
      /** Mysterious Sphere interrupts after Draw and before Roll. */
      pauseAfterDraw?: boolean
    }
    /** The Draw step paused on a trigger before the shared die was rolled. */
    rollPending?: { drewFrom: number; pauseAfterDraw?: boolean }
    /** Opening hands are visible; Mysterious Sphere's party choice is next. */
    pauseAfterDraw?: { drewFrom: number }
    /** A private start-turn discard; only its owner may choose each card. */
    discard?: {
      playerId: string
      sourceId: string
      remaining?: number
      /** Held server-side until the whole printed discard resolves atomically. */
      selectedUids?: string[]
      pendingTriggers: PendingTrigger[]
    }
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
      /** Revenge Protocol was used before unresolved Start-of-Turn abilities. */
      resumeOpenStart?: boolean
    }
  }
  /** Physical cards waiting to resolve after their virtual copy. */
  pendingCardCopy?: {
    /** Stable transaction token for exactly one pending copy resolution. */
    id: number
    playerId: string
    card: CardInstance
    energySpent: number
    resumePhase: 'start' | 'player' | 'discard'
    forcedExhaust: boolean
    forcedChoices: StartTurnChoice[] | null
    deferredHavocs: DeferredHavoc[]
    /** Parent-card triggers waiting for this nested copy to finish. */
    deferredTriggers?: PendingTrigger[]
    /** The sole play-twice effect applied to this card. */
    sourceNames: ('Double Tap' | 'Blasphemy' | 'Echo Form' | 'Burst' | 'Doppelganger' | 'Foreign Influence' | 'Haunting Echo' | 'Omniscience' | 'Overexert' | 'Replication' | 'Weave' | 'Rapid Fire')[]
    hermitRapidFireCard?: boolean
    /** Wait for a foreign Guardian card's Corrupted Shard mode before counting Rapid Fire. */
    deferRapidFire?: boolean
    /** A deferred Rapid Fire remains a copy even when it is the last queued resolution. */
    finalResolutionCopied?: boolean
    /** Doppelganger queues only a virtual card, with no physical original to clean up. */
    virtualOnly?: boolean
    /** Additional physical Weaves discarded by the same Scry, in reveal order. */
    queuedWeaves?: CardInstance[]
    /** Next-card modifiers consumed only if this queued card is allowed to play. */
    queuedCopySources?: CopySource[]
    /** Overexert waits for an unresolved Guardian mode before deciding whether to repeat. */
    repeatIfAttack?: boolean
    consumeFreeCard?: boolean
    consumeFreeAttack?: boolean
  }
  /** Distilled Chaos cards are private until their owner plays each for free. */
  pendingDistilled?: { playerId: string; cards: CardInstance[] }
  /** Golden Eye's private top-three reveal, persisted across reconnects. */
  pendingRelicScry?: { id: number; playerId: string; relicIndex: number; cards: CardInstance[] }
  /** Slayer Pack: Open card-play windows; each player's last entry is the active one. */
  pendingCardPlayWindows?: CardPlayWindow[]
  /** Slayer Pack: decisions a card handed to one player (Heel Hook, Magnetism), oldest first. */
  pendingPlayerChoices?: PendingPlayerChoice[]
  /**
   * Slayer Pack: the next `PendingPlayerChoice` or `SlayerChoice` id, one counter for both. Choices are
   * public, so they never borrow `nextTriggerId` (masked: it counts private draw reactions); absent
   * until a choice is queued.
   */
  nextPlayerChoiceId?: number
  /** Ordered public Attack/Skill plays used by Doppelganger this turn. */
  playedCardsThisTurn: PlayedCard[]
  partyAttackDiscount?: boolean
  /** Recent public actions for player-facing animation; reconnecting clients baseline the sequence. */
  presentationEvents: CombatPresentationEvent[]
  log: string[]
}

/**
 * "Play one of these for 0 Energy", "play any number of cards for 1 Energy
 * each": the cards a resolved card lets its owner play through the ordinary
 * card pipeline at an exact cost. Windows stack per player, because a card
 * played through one (Violence through Enlightenment) can open another, and
 * only the newest is live until it closes. Plain JSON, so reconnects keep it.
 */
export type CardPlayWindow = {
  /** Stable id, so a stale "finish" from an earlier window is refused. */
  id: string
  playerId: string
  sourceCardId: string
  /** The hand cards this window may still play, in the order they were offered. */
  cardUids: string[]
  /** Energy each card costs through this window; X-cost cards resolve with this X. */
  cost: number
  /** Plays left; null is "any number". */
  plays: number | null
  /** Whether the owner may finish while an offered card could still be played. */
  optional: boolean
  /** Discovery: the offered cards still in hand are discarded when the window closes. */
  discardRest?: boolean
}

/**
 * Slayer Pack: one player's owed decision. Only `playerId` may answer it, from their own hand
 * or face-up discard pile, so it is safe to publish to the table.
 *
 * Why this is not `SlayerChoice`, although both wait for a card to finish: here the answering
 * player may be someone other than the card's owner (Heel Hook's "any player"), nothing in the
 * payload is hidden, it can pause and later resume the Start-of-Turn order (Magnetism), and it is
 * dropped when combat ends. `SlayerChoice` is always its owner's, may carry a private reveal, and a
 * Ritual Dagger+ reveal survives victory. Merging them would have to reconcile those four rules.
 */
export type PendingPlayerChoice = {
  id: number
  playerId: string
  /** The card or Power that asked, for the prompt and the log. */
  sourceLabel: string
} & (
  /** Heel Hook: draw 1, discard 1 chosen card, or decline. */
  | { kind: 'drawOrDiscard' }
  /** Magnetism: return 0 to `upTo` topmost discards to hand. */
  | { kind: 'returnDiscardTop'; upTo: number }
)

/** Slayer Pack: the answer to a `PendingPlayerChoice`. Omitting every option declines it. */
export type PlayerChoiceAnswer = {
  choiceId: number
  draw?: boolean
  discardUid?: string
  count?: number
}

export type PlayedCard = {
  playerId: string
  card: CardInstance
  copied: boolean
  /** The card's resolved combat type at play time, including Guardian Mode. */
  type?: CardType
}

export type PresentationTargets = {
  seq: number
  actorId: string
  sourceId: string
  enemyIds: string[]
  /** Actual HP removed by this presentation, after Block and damage prevention. */
  enemyHpLoss?: Record<string, number>
  playerIds: string[]
  enemyRow?: number
}

export type TurnEffectPresentation =
  | 'block' | 'damage' | 'burn' | 'poison' | 'weak' | 'vulnerable' | 'draw'
  | 'discard' | 'exhaust' | 'buff' | 'strength' | 'heal' | 'countdown'
  | 'blockLoss' | 'strengthLoss'

export type CombatPresentationEvent = PresentationTargets & (
  | { kind: 'card'; upgraded: boolean; copied: boolean; energy: number; mode?: number; resolvedType?: CardType }
  | { kind: 'slime'; slimeUid: string; upgraded: boolean; animationIndex: number }
  | { kind: 'potion' }
  | { kind: 'shiv' }
  | { kind: 'orb'; orb: OrbType }
  | { kind: 'turn'; effect: TurnEffectPresentation; actorTargeted: boolean }
)

export type NewPresentationEvent = Omit<PresentationTargets, 'seq'> & (
  | { kind: 'card'; upgraded: boolean; copied: boolean; energy: number; mode?: number; resolvedType?: CardType }
  | { kind: 'slime'; slimeUid: string; upgraded: boolean; animationIndex: number }
  | { kind: 'potion' }
  | { kind: 'shiv' }
  | { kind: 'orb'; orb: OrbType }
  | { kind: 'turn'; effect: TurnEffectPresentation; actorTargeted: boolean }
)

/**
 * A Slayer Pack decision its owner makes after the card that caused it finished.
 *
 * Why this is not `PendingPlayerChoice`: only the card's owner answers; Ritual Dagger+'s
 * `revealed` rare reward is private to that owner (the room redacts it for everyone else); and a
 * Ritual Dagger+ reveal from the killing blow survives victory (`clearTerminalChoices`) so the
 * owner still decides before combat folds into the run. `PendingPlayerChoice` is public, may be
 * answered by another player, can pause the Start-of-Turn order, and is dropped at combat's end.
 */
export type SlayerChoice = {
  /**
   * Public id, allocated from the same counter as `PendingPlayerChoice` (never reused within a combat).
   * An answer names it, so a duplicate or stale one (a double-click, a replay) cannot resolve the
   * owner's next choice. A state saved before ids existed has none, and then the answer carries none.
   */
  id?: number
} & (
  /** Nightmare+'s enemy died with two or more other enemies alive: the owner picks its next one. */
  | { kind: 'reattach'; playerId: string; card: CardInstance; fromUid: string }
  /**
   * Ritual Dagger+ killed its target. `revealed` is the owner's top rare reward,
   * shown to them alone; they put it on the bottom or Replace the dagger with it.
   */
  | { kind: 'ritualDagger'; playerId: string; cardUid: string; revealed: string }
)

export type PendingTrigger = {
  id: number
  playerId: string
  sourceId: string
  /** A private choice staged before this owner confirms the Start-of-Turn quorum. */
  startTurn?: true
  /** Event-bound target, such as the enemy that received a token. */
  enemyUid?: string
  /** Slayer Pack: Event-bound card count, such as the cards an `onDiscard` took. */
  count?: number
}

export type CopySource = 'Double Tap' | 'Blasphemy' | 'Echo Form' | 'Burst' | 'Omniscience' | 'Rapid Fire'

export type DeferredHavoc = {
  card: CardInstance
  exhaust: boolean
  /** Printed clauses after a Scry that paused to play Weave. */
  remainingEffects?: Effect[]
  /** A Doppelganger Havoc is virtual and never enters a pile. */
  virtualOnly?: boolean
  /** A copied Havoc waits until its immediate child finishes. */
  copySourceNames?: CopySource[]
  copyResumePhase?: 'start' | 'player' | 'discard'
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
    | { kind: 'slime'; cardId: string }
  /** Loop selects an Orb before its copied end-turn effects are queued. */
  orbChoice?: boolean
}

export type StartTurnAbility = {
  id: string
  playerId: string
  label: string
  /** The public source shown while this targeted effect is being resolved. */
  visual?:
    | { kind: 'relic'; relicId: string }
    | { kind: 'card'; cardUid: string }
  /** A recurring single-enemy effect still needs its owner to choose. */
  targets?: { uid: string; label: string }[]
  /** A supporting relic may give its effect to any living player. */
  players?: { id: string; label: string }[]
  exhaustCards?: CardInstance[]
  /** Guardian's printed optional board action. */
  guardianModeShift?: true
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
  /** Evokes that find no living enemy while a pending Summon keeps the combat going; they need no target. */
  evokeTargetless?: number[]
  /** Orb slots once the staged Evokes and Channels apply, shown while they are still being chosen. */
  evokePlanOrbs?: (OrbType | null)[]
  /** An earlier forced-card ability parks this one; its Shiv and Evoke picks are asked after that card resolves. */
  deferredAfterForcedCard?: true
}

export type StartTurnChoice = {
  id: string
  enemyUid?: string
  targetPlayerId?: string
  exhaustUids?: string[]
  guardianModeShift?: boolean
  /** One living enemy id or explicit skip per overflow Shiv. */
  shivEnemyUids: (string | null)[]
  /** Chosen Orb slot and Lightning/Dark target for each forced Evoke, in order. */
  evokeSlots?: number[]
  evokeEnemyUids?: (string | null)[]
  /** Private Hermit/Slime trigger input, applied only when this ordered source resolves. */
  trigger?: {
    enemyRow?: number
    enemyUid?: string
    targetPlayerId?: string
    loadUids?: string[]
    chamberUids?: string[]
    hermitEnemyUids?: string[]
    slimeUids?: string[]
    slimeEnemyUids?: string[]
  }
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
  /** Mandatory cards still to discard; legacy saves are normalized to one. */
  remaining: number
  cards: CardInstance[]
}

const END_TURN_TARGET = '@'

export const endTurnChoiceId = (choice: string): string => choice.split(END_TURN_TARGET, 1)[0]!

export const endTurnChoiceTarget = (choice: string): string | undefined => choice.split(END_TURN_TARGET)[1]

export const chooseEndTurnTarget = (id: string, targetUid: string): string =>
  `${endTurnChoiceId(id)}${END_TURN_TARGET}${targetUid}`

// Slayer Pack: Companion's optional self-Exhaust is chosen together with its enemy.
const SELF_EXHAUST_TARGET = 'exhaust:'

export const selfExhaustEndTurnTarget = (targetUid: string): string => `${SELF_EXHAUST_TARGET}${targetUid}`

export const parseSelfExhaustEndTurnTarget = (target: string | undefined): { targetUid: string | undefined; exhaust: boolean } =>
  target?.startsWith(SELF_EXHAUST_TARGET)
    ? { targetUid: target.slice(SELF_EXHAUST_TARGET.length), exhaust: true }
    : { targetUid: target, exhaust: false }

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
  slimeUids?: string[]
  slimeChoiceIndex?: number
  /** One independently chosen enemy for each Command that can target an enemy. */
  slimeEnemyUids?: string[]
  slimeEnemyChoiceIndex?: number
  /** Repeat animation order within this one atomic card or trigger resolution. */
  slimeAnimationCounts?: Record<string, number>
  /** Leeching Slime Commands waiting for the current card/trigger text to finish. */
  pendingSlimeCommandUids?: string[]
  invalidSlimeChoice?: boolean
  /** Hermit's private hand/discard/Chamber choices, supplied atomically. */
  loadUids?: string[]
  chamberUids?: string[]
  hermitEnemyUids?: string[]
  hermitDieRelics?: {
    playerId: string
    relicIndex: number
    abilityIndex: number
    enemyUid?: string | null
    targetPlayerId?: string | null
    discardUids?: string[]
  }[]
  loadChoiceIndex?: number
  chamberChoiceIndex?: number
  hermitEnemyChoiceIndex?: number
  hermitDieRelicChoiceIndex?: number
  invalidHermitChoice?: boolean
  /** Energy chosen for an X-cost card. Must meet `CardDef.minimumX`. */
  energySpent?: number
  /** Guardian Vigor cubes voluntarily moved to the Spent zone with this play. */
  spendVigor?: number
  /** Optional printed "You may Mode Shift" choice on Guardian cards/Gems. */
  guardianModeShift?: boolean
  /** Bauble Burst's independently optional second Amethyst trigger. */
  secondGuardianModeShift?: boolean
  /** Corrupted Shard's first foreign Guardian card enters the chosen Mode. */
  corruptedShardMode?: GuardianMode
  /** Body Crash's chosen Block payment. */
  guardianBlockSpend?: number
  /** Defense-mode Power Beam's chosen Power from hand or discard. */
  guardianPowerCardUid?: string
  /** One enemy per independently targeted printed token. Duplicates are legal. */
  enemyUids?: string[]
  /** One chosen enemy (or row anchor) for each Soulburn spent by a card. */
  soulburnEnemyUids?: string[]
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
  recoverExhaustUids?: string[]
  /** Cards chosen from a privately revealed draw pile by Seek. */
  searchDrawUids?: string[]
  /** Spend one Miracle atomically with this card, which may take Energy above 6. */
  spendMiracle?: boolean
  /** Kratos keeps his Rage: every Unleash clause on this play is skipped. */
  holdRage?: boolean
  /** HP the card's own `loseOwnHp` clause actually took, for Hubris. */
  hpLostByCard?: number
  /** One chosen target or explicit skip per immediate Shiv, in effect order. */
  shivEnemyUids?: (string | null)[]
  /** Of the cards a Scry revealed, the ones the player bins. */
  scryDiscardUids?: string[]
  /** Secret Technique/Weapon's optional eligible card among the Scry reveal. */
  scryToHandUid?: string
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
  /** Internal cursor while independent Weak/Vulnerable tokens resolve. */
  enemyChoiceIndex?: number
  /** Internal cursor while card-spent Soulburn resolves. */
  soulburnTargetIndex?: number
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
  pendingEnemyDamage?: { enemyUid: string; amount: number; attack: boolean }[]
  pendingEnemyDeathUids?: string[]
  pendingAttackTargets?: string[]
  /** Nested reactions whose abilities wait until this card finishes. */
  pendingTriggers?: PendingTrigger[]
  /** Exhausts whose card and Power reactions wait until this card finishes its printed text. */
  pendingExhaustTriggers?: { playerId: string; card: CardInstance }[]
  /** Internal result of the immediately preceding direct draw effect. */
  drewSkill?: boolean
  /** Slayer Pack: Internal: the cards the caster's preceding draw clause drew. */
  drawnUids?: string[]
  /** Slayer Pack: Internal: a mandatory Chamber play, which no card-play window holds back. */
  outsidePlayWindow?: boolean
  /** Public source label for Orb channel animations, including triggered Powers and relics. */
  presentationSourceId?: string
  /** Actual visible mutations made by an opaque recurring effect, grouped by semantic. */
  turnEffectApplications?: {
    effect: TurnEffectPresentation
    actorTargeted?: boolean
    enemyIds?: string[]
    playerIds?: string[]
  }[]
  /** Cards taken by this card's variable discard clause. */
  discardedByCard?: number
  /** Cards taken by this card's Exhaust clause (automatic or chosen, as on Sacrifice). */
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
  /** Guardian Gem permanently socketed under the resolving physical card. */
  sourceAttachedGemId?: string
  /** Weave's bonus while it is being played after a Scry discard. */
  sourceScryDamageBonus?: number
  /** Hermit origin/copy bookkeeping survives JSON and pending-copy resolution. */
  sourceHermitDeadOn?: boolean
  sourcePlayedFromChamber?: boolean
  hermitDeadOnTriggered?: boolean
  hermitRapidFireCard?: boolean
  loadSelf?: boolean
  /** Occupied Chamber slot replaced when a played card Loads itself. */
  loadSelfReplaceUid?: string
  /** Optional Tracking Shots/Gestalt choice supplied by the caller. */
  chooseLoadSelf?: boolean
  /** A Slime Command hit ignores its owner's combat modifiers and enemy Vulnerable. */
  slimeCommand?: boolean
  /** Gem Power damage ignores and preserves Strength, Weak, Vulnerable, and Vigor. */
  guardianGemPowerDamage?: boolean
  /** Internal authorization set only by playHermitChamberCard. */
  hermitChamberPlay?: boolean
  /** Virtual play-twice copies cannot attach a physical card. */
  sourceIsCopy?: boolean
  /** The eligible card selected by a physical Doppelganger resolution. */
  doppelgangerCopy?: CardInstance
  /** Effect that queued `doppelgangerCopy`; the shared copy pipeline serves both cards. */
  queuedCopySource?: 'Doppelganger' | 'Foreign Influence' | 'Haunting Echo' | 'Omniscience' | 'Overexert' | 'Replication' | 'Weave' | 'Rapid Fire'
  /** Whether the queued copy has no physical card to clean up. */
  queuedCopyVirtualOnly?: boolean
  /** Omniscience resolves its queued physical card twice. */
  queuedCopyTwice?: boolean
  queuedCopyTwiceIfAttack?: boolean
  /** Omniscience Exhausts the queued physical card after both plays. */
  queuedCopyForcedExhaust?: boolean
  /** Every pending resolution label for a card that has not started resolving yet. */
  queuedCopySourceNames?: ('Double Tap' | 'Blasphemy' | 'Echo Form' | 'Burst' | 'Doppelganger' | 'Foreign Influence' | 'Haunting Echo' | 'Omniscience' | 'Overexert' | 'Replication' | 'Weave' | 'Rapid Fire')[]
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
  lastHitDamageBeforeBlock?: number
  /** Creative AI: the occupied Orb slots its owner removes, one per returned card. */
  orbSlots?: number[]
  /** Card count carried by the event that fired this trigger (Eviscerate's discards). */
  triggerCount?: number
  /** Companion's owner chose to also Exhaust it as part of its end-of-turn ability. */
  optionalSelfExhaust?: boolean
  /** Metamorphosis: the owner's Power in play that it attaches to and copies. */
  metamorphosisPowerUid?: string
  /** HP the immediately preceding hit took from every enemy it struck (Reaper). */
  lastHitTotalDamage?: number
  /** `enemyUid/cardUid` of every attached Slayer card when this play began; one moved here mid-play does not react. */
  slayerAttachedAtStart?: string[]
}

export type CardChoicePreview = {
  kind: 'discard' | 'scry' | 'scryToHand' | 'topdeck' | 'search' | 'load' | 'loadAny'
  cards: CardInstance[]
  /** Final RNG state of the private simulation; the room server reserves it without exposing it. */
  reservedRng?: RngState
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
  /** Transforming Brew's chosen non-Curse card in hand. */
  transformHandUid?: string
  /** Liquid Void's chosen face-up Exhaust card. */
  recoverExhaustUid?: string
  /** Destiny Draught's chosen die-relic face. */
  targetRelicPlayerId?: string
  targetRelicIndex?: number
  targetAbilityIndex?: number
}

export type CountablePlayer = Pick<Player, 'id' | 'row' | 'orbs' | 'block' | 'strength' | 'miracles' | 'stance' |
  'weak' | 'vulnerable' |
  'attacksPlayedThisTurn' | 'exhaust' | 'clawCubesGainedThisCombat' | 'heat' | 'slimes' | 'chamber' |
  'guardianMode' | 'rage' | 'hp'> & {
  hand: readonly CardInstance[] | null
  powers?: readonly CardInstance[]
}

export type EvokeChoice = { index: number; options: { slot: number; orb: OrbType }[] }

export type PowerContext = {
  enemyUid?: string | null
  enemyRow?: number | null
  playerId?: string | null
  exhaustUids?: string[]
  guardianModeShift?: boolean
  loadUids?: string[]
  chamberUids?: string[]
  hermitEnemyUids?: string[]
  scryDiscardUids?: string[]
  /** Revenge Protocol's privately selected Attack in hand. */
  cardUid?: string
  /** Slayer Pack: Creative AI's chosen occupied Orb slots. */
  orbSlots?: number[]
}

export type StartTurnSource = {
  ability: Omit<StartTurnAbility, 'overflowShivs'>
  source?: TriggerSource
  enemyUid?: string
  enemyBlock?: number
  enemyAction?: EnemyAction
  facingPlayerId?: string
  guardianModeShiftPlayerId?: string
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
  exhaustCards?: CardInstance[]
  hermitChoices?: {
    loadCards: CardInstance[]
    chamberCards: CardInstance[]
    loadAmount: number
    loadMinimum: number
    chamberAmount: number
    chamberMinimum: number
    /** The loaded card costs 0 this turn (Eternal Form). */
    loadDiscount: boolean
    /** Cards drawn once the Chamber discard is paid (Smoking Barrel). */
    chamberThenDraw: number
    /** What happens to the chosen Chamber cards; `replace` discards them to make room for a Load. */
    chamberAction: 'replace' | 'discard' | 'play' | 'discount'
  }
  /** `targets` exist only so a loaded targeted Curse has an enemy; the source itself hits nobody. */
  targetsOnlyForLoadedCurse: boolean
  slimeChoice?: { cards: { uid: string; label: string }[]; amount: number; minimum: number }
  slimeEnemyAmount: number
}

export type RelicContext = {
  enemyUid?: string | null
  targetPlayerId?: string | null
  cardUids?: string[]
  targetRelicPlayerId?: string
  targetRelicIndex?: number
  targetAbilityIndex?: number
  die?: number
  scryDiscardUids?: string[]
  shivEnemyUids?: string[]
  /** Shot Glass's held Potion returned to the physical supply. */
  discardPotionId?: string
}
