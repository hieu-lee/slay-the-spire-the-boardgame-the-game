// The shapes the combat screen works in: what it is handed, what it is waiting
// on, and what it is in the middle of animating.
import type {
  CombatPresentationEvent,
  CombatState,
  EndTurnAbility,
  PendingTriggerAbility,
  StartTurnAbility,
  StartTurnChoice,
  StartTurnScryAbility,
  StartTurnScryPreview,
  PlayContext,
} from '../../game/combat.ts'
import type { CardInstance, GuardianMode, OrbType } from '../../game/types.ts'
import type { ActionOutcome } from '../../multiplayer/useRoomSession.ts'
import type { cardMotionDestination } from '../board-signals.ts'
import type { VfxRecipe } from '../combat-vfx.ts'

export type CombatScreenProps = {
  state: CombatState
  act: number
  /** The seat this client controls. Everyone sees the same board. */
  viewerId: string
  onChange?: (next: CombatState) => void
  onAction?: (action: Record<string, unknown>) => void | Promise<ActionOutcome | void>
  autoAdvance?: boolean
  courierAvailable?: boolean
  mutationsEnabled?: boolean
  drawCount?: number
  decidedPlayerIds?: string[]
  savedDiscardOrder?: string[]
  /** Private cards revealed by a staged online play, visible only to this seat. */
  cardPreview?: {
    cardUid: string
    copy?: boolean
    chamber?: boolean
    kind: 'discard' | 'scry' | 'scryToHand' | 'topdeck' | 'search' | 'load' | 'loadAny'
    cards: CardInstance[]
    spendMiracle: boolean
    enemyUid: string | null
    energySpent?: number
    slimeUids?: string[]
    slimeEnemyUids?: string[]
  }
  powerPreview?: { powerUid: string; kind: 'scry'; cards: CardInstance[] }
  /** Owner-private authoritative trigger choices supplied by an online room. */
  authoritativePendingTrigger?: PendingTriggerAbility | null
  partyEndTurnAbilities?: EndTurnAbility[]
  partyStartTurnAbilities?: StartTurnAbility[]
  partyStartTurnScryAbilities?: StartTurnScryAbility[]
  startTurnCoordinatorId?: string | null
  startTurnChoiceId?: string
  savedStartTurnEnemyTargets?: Record<string, string>
  savedStartTurnChoices?: StartTurnChoice[]
  partyStartTurnOrderPending?: boolean
  partyStartTurnOrderLocked?: boolean
  partyStartTurnScry?: Omit<StartTurnScryPreview, 'cards'> & { cards: CardInstance[] | null }
  partyStartTurnDiscard?: { playerId: string; sourceId: string; label: string; cards: CardInstance[] | null }
  /** Room snapshot version; omitted for the local table. */
  authoritativeVersion?: number
  /** Successful REST refresh count; omitted for the local table. */
  authoritativeRefresh?: number
  /** Accepted newer REST snapshot count; omitted for the local table. */
  authoritativeRestoration?: number
  /** Whether online snapshots are live rather than reconnect catch-up. */
  authoritativeConnected?: boolean
  /** Deal the already-populated opening hand when this combat starts live. */
  animateOpeningHand?: boolean
}

export type UnknownPotionAction = { refreshAttempt: number; potionId: string; countBefore: number }

export type UnknownPowerAction = { refreshAttempt: number; powerUid: string }

export type UnknownCardAction = { refreshAttempt: number; cardUid: string; copy: boolean; copiesBefore?: number }

export type MotionKey = 'energy' | 'draw' | 'discard' | 'exhaust'

export type CardFlight = {
  beat: number
  card: CardInstance
  destination: ReturnType<typeof cardMotionDestination>
}

export type CardDrag = {
  card: CardInstance
  pointerId: number
  startX: number
  startY: number
  x: number
  y: number
  targetUid: string | null
  targetPlayerId: string | null
  needsEnemy: boolean
  needsPlayer: boolean
  hitsRow: boolean
}

export type CardDragStart = Omit<CardDrag, 'targetUid' | 'targetPlayerId'> & {
  element: HTMLButtonElement
  scrollElement: HTMLDivElement | null
  scrollLeft: number
  scrolling: boolean
  canDrag: boolean
  moved: boolean
}

export type EndTurnEffectDrag = {
  ability: EndTurnAbility
  sourceOrb?: OrbType
  sourceTargetUid?: string
  pointerId: number
  startX: number
  startY: number
  x: number
  y: number
  targetUid: string | null
  element: HTMLElement
}

export type MotionSnapshot = {
  hand: readonly CardInstance[]
  energy: number
  draw: number
  discard: number
  exhaust: number
}

export type ActiveCombatVfx = { event: CombatPresentationEvent; recipe: VfxRecipe }

export type CharacterAttackMotion = {
  active: ActiveCombatVfx
  targetId: string
  x: number
  y: number
  targets: { id: string; x: number; y: number; startX: number; startY: number }[]
}

export type PendingStartChoice =
  | { kind: 'enemy'; ability: StartTurnAbility }
  | { kind: 'player'; ability: StartTurnAbility }
  | { kind: 'exhaust'; ability: StartTurnAbility }
  | { kind: 'guardianModeShift'; ability: StartTurnAbility }
  | { kind: 'shiv'; ability: StartTurnAbility; index: number }
  | { kind: 'evokeTarget'; ability: StartTurnAbility; index: number }
  | { kind: 'evoke'; ability: StartTurnAbility }

/** What a card still needs before it can be played. */
export type Pending = {
  card: CardInstance
  /** False for a physical original resolving after its virtual copy. */
  cardInHand: boolean
  /** The physical source is in the private Chamber, rather than the hand or copy queue. */
  chamberPlay: boolean
  /** Energy chosen for an X-cost card; null until the player decides. */
  energySpent: number | null
  /** Effective X after a fixed-cost override; never sent as a player choice. */
  effectEnergy: number | null
  /** Energy actually charged for spend-based triggers; copies always charge 0. */
  energyCharged: number | null
  needsEnemy: boolean
  /**
   * The card can land its support on someone other than the caster, as Defend+,
   * True Grit and Vigilance all can. Auto-committing these to the caster would
   * quietly remove the co-op play the card exists for.
   */
  needsAlly: boolean
  /** The card may exchange the caster's row with another living player. */
  needsSwitch: boolean
  /** Gained Shivs exceeding the shared five-cube supply may attack now. */
  overflowShivs: number
  /** Held Shivs this card must spend as independently targeted attacks. */
  spentShivs: number
  enemyChoices: number
  playerChoices: number
  enemyUids: string[]
  playerIds: string[]
  shivEnemyUids: string[]
  evokeSlots: number[]
  evokeEnemyUids: (string | null | undefined)[]
  mode: number | null
  corruptedShardMode: GuardianMode | null
  enemyUid: string | null
  playerId: string | null
  switchPlayerId: string | null
  switchChoiceDone: boolean
  /**
   * The card carries the area-of-effect burst, so the chosen enemy is only an
   * anchor: everything in its row is hit, and so is the boss. Without saying
   * so, Cleave and a Strike look like the same interaction — pick one enemy —
   * and the player never learns why they would hold Cleave for a crowd.
   */
  hitsRow: boolean
  /** Cards that must be picked, as Survivor, Acrobatics and Third Eye require. */
  choice: {
    kind: 'discard' | 'discardAny' | 'exhaust' | 'exhaustAny' | 'scry' | 'scryToHand' | 'topdeck' | 'recover' | 'recoverExhaust' | 'search' | 'load' | 'loadAny'
    amount: number
    minimum?: number
  } | null
  /** Private post-draw/Scry cards; null means choose from the visible hand. */
  choiceCards: CardInstance[] | null
  choiceConfirmed: boolean
  picked: string[]
  slimeChoice: { amount: number; minimum: number } | null
  slimeUids: string[]
  slimeChoiceConfirmed: boolean
  slimeEnemyUids: string[]
  chamberChoice: {
    kind: 'play' | 'discard' | 'discount' | 'replace'
    amount: number
    minimum: number
    eligibleUids: string[]
    /** Existing choices precede any full-slot replacements in chamberUids. */
    baseAmount?: number
    openAfterBase?: number
    loadSelf?: boolean
  } | null
  chamberUids: string[]
  chamberChoiceConfirmed: boolean
  hermitEnemyUids: string[]
  hermitDieRelicChoice: { amount: number; minimum: number } | null
  hermitDieRelics: NonNullable<PlayContext['hermitDieRelics']>
  hermitDieRelicChoiceConfirmed: boolean
  soulburnChoices: number
  soulburnEnemyUids: string[]
  chooseLoadSelf: boolean | null
  spendVigor: number | null
  guardianModeShift: boolean | null
  secondGuardianModeShift: boolean | null
  guardianBlockSpend: number | null
  guardianPowerCardUid: string | null
  scryToHandUid?: string
}
